// OC ready-to-spawn detection + push broadcast.
//
// Compares each /api/oc/spawn-key snapshot against the previous one per
// faction. When a crime transitions from "not ready" (Recruiting / missing
// slots) to "fully filled + Planning", we fire an oc_ready_to_spawn push
// to every admin (members whose factionPosition is in store.getAdminRoles).
//
// Storage is in-memory only — a restart means we miss the one transition
// that happens during the restart window, which is fine for a
// nice-to-have alert. Idempotency on multi-admin refreshes is handled by
// the snapshot update: once one admin's refresh observes the transition
// and updates the snapshot, the next admin's refresh sees the new state
// and doesn't re-fire. Notification tag `oc-ready-<crimeId>` also
// collapses accidental duplicates at the OS notification level.

import * as push from './push-notifications.js';
import * as store from './store.js';

// factionId → Map<crimeId, { status, filledCount, maxSlots }>
const _snapshot = new Map();

function _facMap(factionId) {
  const k = String(factionId);
  if (!_snapshot.has(k)) _snapshot.set(k, new Map());
  return _snapshot.get(k);
}

function _filledCount(slots) {
  if (!Array.isArray(slots)) return 0;
  let n = 0;
  for (const s of slots) if (s && (s.user_id != null || s.user != null)) n++;
  return n;
}

export async function checkAndNotify(factionId, availableCrimes, members) {
  if (!Array.isArray(availableCrimes) || availableCrimes.length === 0) return;
  const fid = String(factionId);
  const map = _facMap(fid);

  const adminRoles = (store.getAdminRoles(fid) || []).map(r => String(r).toLowerCase());
  const adminIds = [];
  for (const m of (members || [])) {
    const pos = String(m?.factionPosition || m?.position || '').toLowerCase();
    if (pos && adminRoles.includes(pos)) adminIds.push(String(m.id));
  }

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

    // Fire only when we have a previous snapshot AND it wasn't already
    // ready. The first-ever snapshot for a crime (cold start, new OC) is
    // observe-only — prevents restart spam when multiple crimes are
    // already in Planning.
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

  // GC: drop snapshots for crimes that disappeared (completed / deleted).
  const presentIds = new Set(availableCrimes.map(c => String(c?.id)));
  for (const cid of Array.from(map.keys())) if (!presentIds.has(cid)) map.delete(cid);

  if (transitions.length === 0) return;
  if (adminIds.length === 0) {
    console.log(`[oc-ready] faction ${fid}: ${transitions.length} transition(s) but no admins in roles [${adminRoles.join(',')}] — skipping push`);
    return;
  }

  for (const t of transitions) {
    const title = `OC ready: ${t.name}`;
    const body = `Difficulty ${t.difficulty} · all ${t.slots} slots filled — tap to spawn.`;
    const payload = {
      title,
      body,
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
      console.log(`[oc-ready] faction ${fid}: fired "${title}" (crime ${t.crimeId}) to ${adminIds.length} admin(s)`);
    } catch (e) {
      console.warn(`[oc-ready] faction ${fid} push failed for crime ${t.crimeId}:`, e.message);
    }
  }
}

// Fire-and-forget wrapper — the /api/oc/spawn-key hot path shouldn't
// wait on push dispatch.
export function checkAndNotifyAsync(factionId, availableCrimes, members) {
  Promise.resolve()
    .then(() => checkAndNotify(factionId, availableCrimes, members))
    .catch(e => console.warn('[oc-ready] async error:', e.message));
}

// ─────────────────────────────────────────────────────────────────────
// Background poller — independent of admin Refresh clicks.
//
// Runs every POLL_INTERVAL_MS for every faction that has at least one
// Torn API key cached in the pool (populated by admin OC Spawn
// refreshes). Uses the freshest key for each faction. Cost: ≤1 Torn
// API call per faction per minute (well under the 100/min per-key
// limit). Factions with an empty key pool are skipped — the refresh-
// piggyback path still catches transitions when an admin refreshes.
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
  console.log(`[oc-ready][poller] started — ${POLL_INTERVAL_MS / 1000}s interval`);
  // Fire once at startup so a cold boot doesn't wait a full interval
  // before establishing the first snapshot.
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
      await checkAndNotify(fid, data.availableCrimes, data.members);
    } catch (e) {
      console.warn(`[oc-ready][poller] faction ${fid}:`, e.message);
    }
  }
}
