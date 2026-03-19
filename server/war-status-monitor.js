/**
 * War status monitoring service.
 *
 * Periodically polls the Torn API for enemy faction member statuses and
 * broadcasts updates to the appropriate war room via socket.io.
 */

import * as store from "./store.js";
import { fetchFactionMembers } from "./torn-api.js";
import { recordSample } from "./activity-heatmap.js";
import { notifyEnemySurge } from "./push-notifications.js";

const POLL_INTERVAL_MS = 15_000; // 15 seconds
const MAX_BACKOFF_MS = 120_000;   // max 2 minutes between retries on failure

/** Active polling timeout IDs per warId. */
const timeouts = new Map();
/** Current backoff delay per warId (resets on success). */
const backoffs = new Map();
/** Previous enemy online count per warId — for surge detection. */
const prevEnemyOnline = new Map();

const SURGE_THRESHOLD = 3; // fire alert when ≥ 3 new enemies come online between polls

// Legacy compat
const intervals = new Map();

/**
 * Start war status monitoring for a war room.
 * @param {import("socket.io").Server} io
 * @param {string} warId
 */
export function startWarStatusMonitor(io, warId) {
  if (timeouts.has(warId)) return; // already monitoring

  const scheduleNext = (delay) => {
    const tid = setTimeout(poll, delay);
    timeouts.set(warId, tid);
  };

  const poll = async () => {
    const war = store.getWar(warId);
    if (!war || !war.enemyFactionId) { scheduleNext(POLL_INTERVAL_MS); return; }

    // Prefer faction-dedicated key, fall back to any player key
    const apiKey =
      store.getFactionApiKey(war.factionId) ||
      store.getApiKeyForFaction(war.factionId);
    if (!apiKey) { scheduleNext(POLL_INTERVAL_MS); return; }

    try {
      const freshStatuses = await fetchFactionMembers(war.enemyFactionId, apiKey);
      war.enemyStatuses = freshStatuses;
      store.saveState();

      // Success — reset backoff
      backoffs.set(warId, POLL_INTERVAL_MS);

      // ── Enemy Online Surge Detection ──
      try {
        const onlineNow = Object.values(freshStatuses).filter(
          (m) => m.status?.state === "Okay" && m.activity === "online",
        ).length;
        const totalEnemies = Object.keys(freshStatuses).length;
        const prevCount = prevEnemyOnline.get(warId) ?? onlineNow; // first poll = no alert
        const delta = onlineNow - prevCount;
        prevEnemyOnline.set(warId, onlineNow);

        if (delta >= SURGE_THRESHOLD) {
          console.log(`[war-status] Enemy surge detected for war ${warId}: +${delta} (${onlineNow} online)`);
          const warPlayers = store.getOnlinePlayersForWar(warId);
          notifyEnemySurge(warPlayers, warId, delta, onlineNow).catch(() => {});
        }
      } catch (_) { /* non-critical */ }

      io.to(`war_${warId}`).emit("status_update", freshStatuses);

      // Record our faction's online count for the activity heatmap + header display
      try {
        const ourMembers = await fetchFactionMembers(war.factionId, apiKey);
        const ourOnline = Object.values(ourMembers).filter(
          (m) => m.activity === "online",
        ).length;
        const ourIdle = Object.values(ourMembers).filter(
          (m) => m.activity === "idle",
        ).length;
        const ourTotal = Object.keys(ourMembers).length;
        recordSample(war.factionId, ourOnline + ourIdle);
        // Store on war for poll response
        war.ourFactionOnline = { online: ourOnline, idle: ourIdle, total: ourTotal };
      } catch (_) {
        // Non-critical — skip silently
      }

      scheduleNext(POLL_INTERVAL_MS);
    } catch (err) {
      // Exponential backoff on failure
      const current = backoffs.get(warId) || POLL_INTERVAL_MS;
      const next = Math.min(current * 2, MAX_BACKOFF_MS);
      backoffs.set(warId, next);
      console.error(`[war-status] Poll failed for war ${warId}: ${err.message} (retry in ${Math.round(next/1000)}s)`);
      scheduleNext(next);
    }
  };

  // Run immediately, schedule via setTimeout chain (not setInterval)
  backoffs.set(warId, POLL_INTERVAL_MS);
  poll();
  console.log(`[war-status] Started monitoring for war ${warId}`);
}

/**
 * Stop war status monitoring for a war room.
 * @param {string} warId
 */
export function stopWarStatusMonitor(warId) {
  const tid = timeouts.get(warId);
  if (tid) {
    clearTimeout(tid);
    timeouts.delete(warId);
  }
  backoffs.delete(warId);
  prevEnemyOnline.delete(warId);
  const id = intervals.get(warId);
  if (id) clearInterval(id);
  intervals.delete(warId);
  console.log(`[war-status] Stopped monitoring for war ${warId}`);
}

/**
 * Stop all war status monitors (for graceful shutdown).
 */
export function stopAll() {
  for (const [warId, tid] of timeouts) {
    clearTimeout(tid);
    console.log(`[war-status] Stopped monitoring for war ${warId}`);
  }
  timeouts.clear();
  backoffs.clear();
  prevEnemyOnline.clear();
  for (const [, id] of intervals) clearInterval(id);
  intervals.clear();
}
