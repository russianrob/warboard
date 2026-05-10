// Enemy-online-surge monitor. Watches the server's existing enemy
// status data (already populated by clients via /api/status) and fires
// a push notification when a meaningful number of enemies come online
// inside a short window — the "they're rallying" signal during war.
//
// Zero new Torn API cost — all data is recycled from what factionops /
// iOS / Android already send. Runs as a setInterval per active war.

import * as store from "./store.js";
import * as push from "./push-notifications.js";

const SAMPLE_INTERVAL_MS = 30_000; // sample every 30s
const HISTORY_RETENTION_MS = 15 * 60_000; // keep last 15 min of samples

/** @type {Map<string, NodeJS.Timeout>} per-warId monitor timer */
const _timers = new Map();
/** @type {Map<string, Array<{ts: number, online: number}>>} per-warId sample history */
const _history = new Map();
/** @type {Map<string, number>} per-warId last-fired epoch ms */
const _lastFired = new Map();
/** @type {Map<string, any>} per-warId Socket.IO instance for in-overlay toast emit */
const _ios = new Map();

function _countOnline(war) {
  const statuses = war?.enemyStatuses || {};
  let n = 0;
  for (const id in statuses) {
    const s = statuses[id];
    if (!s) continue;
    // Activity field is one of "online" / "idle" / "offline". We treat
    // online + idle as "actively at the keyboard." If you only want
    // strict-online, change to s.activity === "online".
    if (s.activity === "online" || s.activity === "idle") n++;
  }
  return n;
}

function _trimHistory(history, nowMs) {
  const cutoff = nowMs - HISTORY_RETENTION_MS;
  while (history.length > 0 && history[0].ts < cutoff) history.shift();
}

/**
 * Poll one war for enemy-online surges. Only fires the push if all
 * three conditions hold: (1) faction has surge enabled in settings,
 * (2) the war is active (not ended), (3) the count delta within the
 * configured window meets the threshold AND we're past the cooldown.
 */
function _poll(warId) {
  const war = store.getWar(warId);
  if (!war) { _stopOne(warId); return; }
  if (war.warEnded) { _stopOne(warId); return; }

  const cfg = store.getEnemySurgeConfig(war.factionId);
  if (!cfg.enabled) return; // recorded sample skipped — re-enable starts fresh

  const nowMs = Date.now();
  const online = _countOnline(war);

  let history = _history.get(warId);
  if (!history) { history = []; _history.set(warId, history); }
  history.push({ ts: nowMs, online });
  _trimHistory(history, nowMs);

  // Need at least one historical sample inside the window to compare
  const windowStart = nowMs - cfg.windowSec * 1000;
  const baseline = [...history].reverse().find(s => s.ts <= windowStart);
  if (!baseline) return; // not enough history yet

  const delta = online - baseline.online;
  if (delta < cfg.jumpThreshold) return;

  // Cooldown gate
  const lastFired = _lastFired.get(warId) || 0;
  if (nowMs - lastFired < cfg.cooldownSec * 1000) return;

  _lastFired.set(warId, nowMs);
  console.log(`[enemy-surge] war=${warId} surge detected: +${delta} enemies in ${cfg.windowSec}s (now ${online}, was ${baseline.online})`);

  // 1. Push notification (opt-in via the enemy_surge pref)
  const warPlayers = store.getOnlinePlayersForWar(warId);
  push.notifyEnemySurge(warPlayers, warId, online, delta, cfg.windowSec)
    .catch(e => console.warn(`[enemy-surge] push failed: ${e.message}`));

  // 2. In-overlay toast — fan out via Socket.IO + SSE so anyone with
  // factionops open in the war room sees a toast immediately, no
  // notification permission required.
  const io = _ios.get(warId);
  const toastPayload = {
    online,
    delta,
    windowSec: cfg.windowSec,
    ts: nowMs,
  };
  if (io) {
    try { io.to(`war_${warId}`).emit('enemy_surge', toastPayload); }
    catch (e) { console.warn(`[enemy-surge] socket emit failed: ${e.message}`); }
  }
  // SSE — dynamic import avoids a circular dep at module load time.
  import('./routes.js').then(r => {
    try { r.broadcastSSE(warId, { type: 'enemy_surge', ...toastPayload }); }
    catch (_) { /* SSE bus might not be ready; non-fatal */ }
  }).catch(() => {});
}

export function startEnemySurgeMonitor(io, warId) {
  // Back-compat: callers that pass only warId (the original signature)
  // still work, just without Socket.IO toast fan-out.
  if (typeof warId === 'undefined' && typeof io === 'string') {
    warId = io; io = null;
  }
  if (_timers.has(warId)) {
    if (io) _ios.set(warId, io); // refresh io ref on repeat starts
    return;
  }
  if (io) _ios.set(warId, io);
  // Prime history so the first sample isn't immediately compared to nothing
  _poll(warId);
  const tid = setInterval(() => _poll(warId), SAMPLE_INTERVAL_MS);
  _timers.set(warId, tid);
  console.log(`[enemy-surge] monitor started for war ${warId}`);
}

function _stopOne(warId) {
  const tid = _timers.get(warId);
  if (tid) { clearInterval(tid); _timers.delete(warId); }
  _history.delete(warId);
  _lastFired.delete(warId);
  _ios.delete(warId);
}

export function stopEnemySurgeMonitor(warId) {
  if (!_timers.has(warId)) return;
  _stopOne(warId);
  console.log(`[enemy-surge] monitor stopped for war ${warId}`);
}

/** Test helper — returns the last N samples for a war so the admin UI
 *  can show a sparkline if we ever want one. */
export function getRecentSamples(warId) {
  return [...(_history.get(warId) || [])];
}
