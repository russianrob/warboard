// OC event detection + push broadcast.
//
// Two event types today:
//   - oc_ready_to_spawn — mirrors the OC Spawn Assistance Admin tab's
//     "spawn these level-N OCs" recommendation. Computes per-level
//     availability (members free now + members completing an OC inside
//     the forecast window) and compares against open Recruiting slots.
//     Fires when a level transitions from "0 OCs recommended" to
//     "≥1 OC should be spawned."
//   - oc_completed — crime finishes (Successful/Failure). Detected by
//     watching the completedCrimes list for new crimeIds we've never
//     seen before (per faction).
//
// Audience for both: faction admins (members whose factionPosition is in
// store.getAdminRoles(factionId)).
//
// Storage is in-memory only — a restart means we miss transitions that
// happen during the restart window. First-ever observation per faction
// is observe-only (no fires) to avoid cold-start spam.

import * as push from './push-notifications.js';
import * as store from './store.js';

// factionId → Map<level, numOcsRecommended>
// Also carries a __seeded sentinel on the Map so the first observation
// only populates the baseline without firing a backlog of alerts.
const _snapshot = new Map();
// factionId → Set<crimeId> already-notified completions
const _completedSeen = new Map();

function _facMap(factionId) {
  const k = String(factionId);
  if (!_snapshot.has(k)) _snapshot.set(k, new Map());
  return _snapshot.get(k);
}

function _facSeen(factionId) {
  const k = String(factionId);
  if (!_completedSeen.has(k)) _completedSeen.set(k, new Set());
  return _completedSeen.get(k);
}

function _filledCount(slots) {
  if (!Array.isArray(slots)) return 0;
  let n = 0;
  for (const s of slots) if (s && (s.user_id != null || s.user != null)) n++;
  return n;
}

function _resolveAdmins(factionId, members) {
  const fid = String(factionId);
  const adminRoles = (store.getAdminRoles(fid) || []).map(r => String(r).toLowerCase());
  const ids = [];
  for (const m of (members || [])) {
    const pos = String(m?.factionPosition || m?.position || '').toLowerCase();
    if (pos && adminRoles.includes(pos)) ids.push(String(m.id));
  }
  return { adminIds: ids, adminRoles };
}

// ── Spawn-recommendation detection ─────────────────────────────────────
// Mirrors the OC Spawn Assistance Admin tab's "Recommended OCs to
// spawn" computation. For each difficulty level we count eligible
// members (free now + completing an OC within forecast_hours) and
// compare against open Recruiting slots. When a level has at least
// one full OC's worth of deficit, it's a "spawn recommendation."
const DEFAULT_SLOTS_PER_OC = 4;

// Recompute each member's `joinable` using the faction's MINCPR and
// CPR_BOOST settings. getOcSpawnData's cprCache is built with a server-
// wide default MINCPR=60/BOOST=15; /api/oc/spawn-key's response re-runs
// this same loop with the faction's oc_mincpr / oc_cpr_boost before the
// userscript sees it, so the Admin tab's joinable differs from the raw
// cache for factions whose mincpr isn't 60. Mirror that recalc here
// so the notifier agrees with the Admin tab.
function _applyFactionCprThreshold(cprCache, mincpr, boost) {
  if (!cprCache) return {};
  const out = {};
  for (const [uid, d] of Object.entries(cprCache)) {
    const lc = {};
    for (const e of (d?.entries || [])) {
      if (!lc[e.diff]) lc[e.diff] = { sum: 0, count: 0 };
      lc[e.diff].sum += e.rate;
      lc[e.diff].count += 1;
    }
    let effTop = d?.highestLevel || 0;
    for (let lvl = effTop; lvl >= 1; lvl--) {
      const lv = lc[lvl];
      if (!lv) continue;
      if ((lv.sum / lv.count) >= mincpr) { effTop = lvl; break; }
    }
    const cpr = Number(d?.cpr || 0);
    const joinable = cpr >= mincpr + boost ? Math.min(effTop + 1, 10) : effTop;
    out[uid] = { ...d, effectiveTop: effTop, joinable };
  }
  return out;
}

function _buildSpawnRecommendations(factionId, availableCrimes, members, cprCache) {
  if (!Array.isArray(availableCrimes) || !Array.isArray(members)) return [];
  const settings = store.getFactionSettings(factionId) || {};
  const forecastHours = Number(settings.oc_forecast_hours ?? 6);
  const activeDays = Number(settings.oc_active_days ?? 7);
  const mincpr = Number(settings.oc_mincpr ?? 60);
  const boost = Number(settings.oc_cpr_boost ?? 15);
  const nowSec = Math.floor(Date.now() / 1000);
  const forecastCutoff = nowSec + forecastHours * 3600;
  const activeCutoff = nowSec - activeDays * 86400;
  // Recompute joinable per-member using faction thresholds.
  const tunedCpr = _applyFactionCprThreshold(cprCache, mincpr, boost);

  // Map each placed member → their current OC's ready_at timestamp.
  const memberOcMap = new Map();
  for (const c of availableCrimes) {
    if (!c || c.status === 'Expired' || !Array.isArray(c.slots)) continue;
    for (const s of c.slots) {
      const uid = s?.user_id ?? s?.user?.id;
      if (uid != null) memberOcMap.set(String(uid), Number(c.ready_at || 0));
    }
  }

  // Filter members: active, tenure, and forecast-window OC gating.
  const eligible = [];
  for (const m of members) {
    const uid = String(m?.id ?? '');
    if (!uid) continue;
    const lastAction = Number(m?.last_action?.timestamp ?? 0);
    if (lastAction < activeCutoff) continue;
    const daysInFaction = Number(m?.days_in_faction ?? 999);
    if (daysInFaction < 3) continue;
    const rec = tunedCpr?.[uid];
    const joinable = Number(rec?.joinable ?? 0);
    if (joinable <= 0) continue;
    const readyAt = memberOcMap.get(uid);
    const inOC = readyAt !== undefined;
    // Skip members in an OC that finishes beyond the forecast window —
    // they're not available to join anything we'd spawn now.
    if (inOC && readyAt > 0 && readyAt > forecastCutoff) continue;
    eligible.push({ uid, joinable, inOC });
  }

  // Count current Recruiting capacity per level.
  const slotMap = {};
  for (const c of availableCrimes) {
    if (!c || c.status !== 'Recruiting') continue;
    const d = Number(c.difficulty || 0);
    if (!slotMap[d]) slotMap[d] = { totalSlots: 0, openSlots: 0, crimes: 0 };
    const slots = Array.isArray(c.slots) ? c.slots : [];
    let open = 0;
    for (const s of slots) if (!s?.user_id && !s?.user?.id) open++;
    slotMap[d].totalSlots += slots.length;
    slotMap[d].openSlots  += open;
    slotMap[d].crimes     += 1;
  }

  const recs = [];
  for (let lvl = 10; lvl >= 1; lvl--) {
    const forLvl = eligible.filter(e => e.joinable === lvl);
    if (forLvl.length === 0) continue;
    const freeNow  = forLvl.filter(e => !e.inOC).length;
    const soonFree = forLvl.length - freeNow;
    const info = slotMap[lvl] || { totalSlots: 0, openSlots: 0, crimes: 0 };
    const slotsPerOc = info.crimes > 0 ? info.totalSlots / info.crimes : DEFAULT_SLOTS_PER_OC;
    let numOcsToSpawn = 0;
    if (info.totalSlots === 0) {
      numOcsToSpawn = 1; // no OCs at this level but members waiting — open one
    } else {
      const deficit = forLvl.length - info.openSlots;
      if (deficit > 0) numOcsToSpawn = Math.floor(deficit / slotsPerOc);
    }
    if (numOcsToSpawn > 0) recs.push({ level: lvl, numOcsToSpawn, freeNow, soonFree });
  }
  return recs;
}

async function _checkReadyToSpawn(factionId, availableCrimes, members, cprCache) {
  if (!Array.isArray(availableCrimes) || !Array.isArray(members)) return;
  const fid = String(factionId);
  const map = _facMap(fid);
  const recs = _buildSpawnRecommendations(fid, availableCrimes, members, cprCache);

  // First-ever observation for this faction: seed the snapshot without
  // firing so cold boots don't spam the admin with the current backlog.
  if (!map.__seeded) {
    map.__seeded = true;
    for (const r of recs) map.set(r.level, r.numOcsToSpawn);
    return;
  }

  const { adminIds, adminRoles } = _resolveAdmins(fid, members);
  const transitions = [];
  const presentLevels = new Set(recs.map(r => r.level));
  for (const r of recs) {
    const prevCount = map.get(r.level) || 0;
    if (prevCount === 0 && r.numOcsToSpawn > 0) transitions.push(r);
    map.set(r.level, r.numOcsToSpawn);
  }
  // Reset dropped levels to 0 so the next fresh spike can fire again.
  for (const lvl of Array.from(map.keys())) {
    if (typeof lvl !== 'number') continue;
    if (!presentLevels.has(lvl) && map.get(lvl) !== 0) map.set(lvl, 0);
  }

  if (transitions.length === 0) return;
  if (adminIds.length === 0) {
    console.log(`[oc-ready] faction ${fid}: ${transitions.length} recommendation(s) but no admins in roles [${adminRoles.join(',')}] — skipping push`);
    return;
  }

  for (const t of transitions) {
    const total = t.freeNow + t.soonFree;
    const s = t.numOcsToSpawn === 1 ? '' : 's';
    const soonBit = t.soonFree > 0 ? ` (${t.freeNow} free now, ${t.soonFree} completing within forecast)` : ` (${t.freeNow} free now)`;
    const payload = {
      title: `Spawn ${t.numOcsToSpawn} level-${t.level} OC${s}`,
      body: `${total} member${total === 1 ? '' : 's'} ready to join${soonBit}`,
      tag: `oc-ready-lvl-${t.level}`,
      data: {
        type: 'oc_ready_to_spawn',
        factionId: fid,
        level: t.level,
        count: t.numOcsToSpawn,
        url: 'https://www.torn.com/factions.php?step=your#/tab=crimes',
      },
    };
    try {
      await push.sendToPlayers(adminIds, payload, 'oc_ready_to_spawn');
      console.log(`[oc-ready] faction ${fid}: recommend ${t.numOcsToSpawn}×lvl-${t.level} OC(s) (${t.freeNow} free, ${t.soonFree} soon) → ${adminIds.length} admin(s)`);
    } catch (e) {
      console.warn(`[oc-ready] faction ${fid} push failed for lvl ${t.level}:`, e.message);
    }
  }
}

// ── Completed detection ────────────────────────────────────────────────
async function _checkCompletions(factionId, completedCrimes, members) {
  if (!Array.isArray(completedCrimes) || completedCrimes.length === 0) return;
  const fid = String(factionId);
  const seen = _facSeen(fid);

  // First-ever observation: seed the set without firing. Prevents a
  // restart from spamming the last 90 days of completions.
  if (seen.size === 0) {
    for (const c of completedCrimes) if (c?.id != null) seen.add(String(c.id));
    return;
  }

  const { adminIds, adminRoles } = _resolveAdmins(fid, members);
  const fresh = [];
  for (const c of completedCrimes) {
    if (!c || c.id == null) continue;
    const cid = String(c.id);
    if (seen.has(cid)) continue;
    seen.add(cid);
    fresh.push(c);
  }

  if (fresh.length === 0) return;
  if (adminIds.length === 0) {
    console.log(`[oc-completed] faction ${fid}: ${fresh.length} new completion(s) but no admins in roles [${adminRoles.join(',')}] — skipping push`);
    return;
  }

  for (const c of fresh) {
    const cid = String(c.id);
    const name = String(c.name || 'OC');
    const status = String(c.status || '');
    const isSuccess = /success/i.test(status);
    const isFail = /fail/i.test(status);
    const outcome = isSuccess ? '✓ Success' : isFail ? '✗ Failed' : status || 'Finished';
    const money = Number(c?.rewards?.money || 0);
    const respect = Number(c?.rewards?.respect || 0);
    const bits = [outcome];
    if (money > 0) bits.push('$' + money.toLocaleString('en-US'));
    if (respect > 0) bits.push(respect.toLocaleString('en-US') + ' respect');
    const payload = {
      title: `OC completed: ${name}`,
      body: bits.join(' · '),
      tag: `oc-completed-${cid}`,
      data: {
        type: 'oc_completed',
        crimeId: cid,
        factionId: fid,
        url: 'https://www.torn.com/factions.php?step=your#/tab=crimes',
      },
    };
    try {
      await push.sendToPlayers(adminIds, payload, 'oc_completed');
      console.log(`[oc-completed] faction ${fid}: fired "${name}" (${status || 'no status'}) to ${adminIds.length} admin(s)`);
    } catch (e) {
      console.warn(`[oc-completed] faction ${fid} push failed for ${cid}:`, e.message);
    }
  }

  // Cap memory — 300 seen IDs per faction is plenty given a 90-day
  // lookback window with sparse completions.
  if (seen.size > 300) {
    const arr = Array.from(seen);
    _completedSeen.set(fid, new Set(arr.slice(-300)));
  }
}

// ── Public API ─────────────────────────────────────────────────────────
export async function checkAndNotify(factionId, availableCrimes, members, completedCrimes, cprCache) {
  await _checkReadyToSpawn(factionId, availableCrimes, members, cprCache);
  if (completedCrimes) await _checkCompletions(factionId, completedCrimes, members);
}

export function checkAndNotifyAsync(factionId, availableCrimes, members, completedCrimes, cprCache) {
  Promise.resolve()
    .then(() => checkAndNotify(factionId, availableCrimes, members, completedCrimes, cprCache))
    .catch(e => console.warn('[oc-notif] async error:', e.message));
}

// ─────────────────────────────────────────────────────────────────────
// Background poller — independent of admin Refresh clicks. Runs every
// POLL_INTERVAL_MS per faction with a known polling key (Torn key pool
// or oc_ffs_key fallback). Cost: 1-2 Torn API calls per faction per
// minute, well under Torn's 100/min per-key cap.
// ─────────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 60_000;
let _pollTimer = null;
let _listFactions = null;
let _getFreshKey = null;
let _fetchOcData = null;

export function startPoller({ listFactions, getFreshKey, fetchOcData }) {
  if (_pollTimer) return;
  _listFactions = listFactions;
  _getFreshKey = getFreshKey;
  _fetchOcData = fetchOcData;
  _pollTimer = setInterval(runPoll, POLL_INTERVAL_MS);
  console.log(`[oc-notif][poller] started — ${POLL_INTERVAL_MS / 1000}s interval`);
  runPoll();
}

export function stopPoller() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

async function runPoll() {
  if (!_listFactions || !_getFreshKey || !_fetchOcData) return;
  let factionIds = [];
  try { factionIds = _listFactions() || []; } catch (_) { return; }
  for (const fid of factionIds) {
    const key = _getFreshKey(fid);
    if (!key) continue;
    try {
      const data = await _fetchOcData(fid, key);
      await checkAndNotify(fid, data.availableCrimes, data.members, data.completedCrimes, data.cprCache);
    } catch (e) {
      console.warn(`[oc-notif][poller] faction ${fid}:`, e.message);
    }
  }
}
