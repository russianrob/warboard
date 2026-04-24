// OC event detection + push broadcast.
//
// Two event types today:
//   - oc_ready_to_spawn — crime transitions to Planning with all slots
//     filled (fresh snapshot ≠ previous snapshot). Detected from the
//     availableCrimes list.
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

// factionId → Map<crimeId, { status, filledCount, maxSlots }>
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

// ── Ready-to-spawn detection ───────────────────────────────────────────
async function _checkReadyToSpawn(factionId, availableCrimes, members) {
  if (!Array.isArray(availableCrimes) || availableCrimes.length === 0) return;
  const fid = String(factionId);
  const map = _facMap(fid);
  const { adminIds, adminRoles } = _resolveAdmins(fid, members);

  const transitions = [];
  for (const crime of availableCrimes) {
    if (!crime || crime.id == null) continue;
    const cid = String(crime.id);
    const status = String(crime.status || '');
    const filled = _filledCount(crime.slots);
    const maxSlots = Number(crime.maximum_members || (Array.isArray(crime.slots) ? crime.slots.length : 0));
    const prev = map.get(cid);
    const isReady = status === 'Planning' && maxSlots > 0 && filled >= maxSlots;
    const hadPrev = prev !== undefined;
    const wasReady = hadPrev && prev.status === 'Planning' && prev.filledCount >= prev.maxSlots;

    if (isReady && hadPrev && !wasReady) {
      transitions.push({
        crimeId: cid,
        name: String(crime.name || 'OC'),
        difficulty: Number(crime.difficulty || 0),
        slots: maxSlots,
      });
    }
    map.set(cid, { status, filledCount: filled, maxSlots });
  }

  // GC crimes that dropped out of availableCrimes (completed / deleted).
  const presentIds = new Set(availableCrimes.map(c => String(c?.id)));
  for (const cid of Array.from(map.keys())) if (!presentIds.has(cid)) map.delete(cid);

  if (transitions.length === 0) return;
  if (adminIds.length === 0) {
    console.log(`[oc-ready] faction ${fid}: ${transitions.length} transition(s) but no admins in roles [${adminRoles.join(',')}] — skipping push`);
    return;
  }

  for (const t of transitions) {
    const payload = {
      title: `OC ready: ${t.name}`,
      body: `Difficulty ${t.difficulty} · all ${t.slots} slots filled — tap to spawn.`,
      tag: `oc-ready-${t.crimeId}`,
      data: {
        type: 'oc_ready_to_spawn',
        crimeId: t.crimeId,
        factionId: fid,
        url: `https://www.torn.com/factions.php?step=your#/tab=crimes`,
      },
    };
    try {
      await push.sendToPlayers(adminIds, payload, 'oc_ready_to_spawn');
      console.log(`[oc-ready] faction ${fid}: fired "${payload.title}" (crime ${t.crimeId}) to ${adminIds.length} admin(s)`);
    } catch (e) {
      console.warn(`[oc-ready] faction ${fid} push failed for crime ${t.crimeId}:`, e.message);
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
export async function checkAndNotify(factionId, availableCrimes, members, completedCrimes) {
  await _checkReadyToSpawn(factionId, availableCrimes, members);
  if (completedCrimes) await _checkCompletions(factionId, completedCrimes, members);
}

export function checkAndNotifyAsync(factionId, availableCrimes, members, completedCrimes) {
  Promise.resolve()
    .then(() => checkAndNotify(factionId, availableCrimes, members, completedCrimes))
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
      await checkAndNotify(fid, data.availableCrimes, data.members, data.completedCrimes);
    } catch (e) {
      console.warn(`[oc-notif][poller] faction ${fid}:`, e.message);
    }
  }
}
