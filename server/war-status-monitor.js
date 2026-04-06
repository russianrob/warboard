/**
 * War status monitoring service.
 *
 * Periodically polls the Torn API for enemy faction member statuses and
 * broadcasts updates to the appropriate war room via socket.io.
 */

import * as store from "./store.js";
import { fetchFactionMembers } from "./torn-api.js";
import { recordSample } from "./activity-heatmap.js";

const POLL_INTERVAL_MS = 15_000; // 15 seconds
const MAX_BACKOFF_MS = 120_000;   // max 2 minutes between retries on failure

/** Active polling timeout IDs per warId. */
const timeouts = new Map();
/** Current backoff delay per warId (resets on success). */
const backoffs = new Map();

const MAX_ACTIVITY_LOG = 5760; // 24 hours at 15s intervals

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
    if (!war || !war.enemyFactionId || war.warEnded) {
      if (war?.warEnded) {
        console.log(`[war-status] War ${warId} ended. Stopping status monitor.`);
        stopWarStatusMonitor(warId);
        return;
      }
      scheduleNext(POLL_INTERVAL_MS);
      return;
    }

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

      // ── Enemy counts (used by surge detection, activity log, and strategy) ──
      const onlineNow = Object.values(freshStatuses).filter(
        (m) => m.status?.state === "Okay" && m.activity === "online",
      ).length;
      const totalEnemies = Object.keys(freshStatuses).length;

      io.to(`war_${warId}`).emit("status_update", freshStatuses);

      // ── Enemy Activity Logging ──
      try {
        if (!war.enemyActivityLog) war.enemyActivityLog = [];
        war.enemyActivityLog.push({
          timestamp: Date.now(),
          online: onlineNow,
          idle: Object.values(freshStatuses).filter(
            (m) => m.activity === "idle",
          ).length,
          total: totalEnemies,
        });
        // Cap at ~24 hours of data
        while (war.enemyActivityLog.length > MAX_ACTIVITY_LOG) {
          war.enemyActivityLog.shift();
        }
      } catch (_) { /* non-critical */ }

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
        recordSample(war.factionId, ourOnline + ourIdle, ourTotal);
        // Store on war for poll response
        war.ourFactionOnline = { online: ourOnline, idle: ourIdle, total: ourTotal };
      } catch (_) {
        // Non-critical — skip silently
      }

      store.saveState();
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
  for (const [, id] of intervals) clearInterval(id);
  intervals.clear();
}
