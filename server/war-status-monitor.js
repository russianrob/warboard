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

/** Active polling interval IDs per warId. */
const intervals = new Map();

/**
 * Start war status monitoring for a war room.
 * @param {import("socket.io").Server} io
 * @param {string} warId
 */
export function startWarStatusMonitor(io, warId) {
  if (intervals.has(warId)) return; // already monitoring

  const poll = async () => {
    const war = store.getWar(warId);
    if (!war || !war.enemyFactionId) return;

    // Prefer faction-dedicated key, fall back to any player key
    const apiKey =
      store.getFactionApiKey(war.factionId) ||
      store.getApiKeyForFaction(war.factionId);
    if (!apiKey) return; // no key available, skip silently

    try {
      const freshStatuses = await fetchFactionMembers(war.enemyFactionId, apiKey);
      war.enemyStatuses = freshStatuses;
      store.saveState();

      io.to(`war_${warId}`).emit("status_update", freshStatuses);

      // Record our faction's online count for the activity heatmap
      try {
        const ourMembers = await fetchFactionMembers(war.factionId, apiKey);
        const onlineCount = Object.values(ourMembers).filter(
          (m) => m.online === "Online" || m.online === "Idle",
        ).length;
        recordSample(war.factionId, onlineCount);
      } catch (_) {
        // Non-critical — skip silently
      }
    } catch (err) {
      console.error(`[war-status] Poll failed for war ${warId}:`, err.message);
    }
  };

  // Run immediately, then on interval
  poll();
  intervals.set(warId, setInterval(poll, POLL_INTERVAL_MS));
  console.log(`[war-status] Started monitoring for war ${warId}`);
}

/**
 * Stop war status monitoring for a war room.
 * @param {string} warId
 */
export function stopWarStatusMonitor(warId) {
  const id = intervals.get(warId);
  if (id) {
    clearInterval(id);
    intervals.delete(warId);
    console.log(`[war-status] Stopped monitoring for war ${warId}`);
  }
}

/**
 * Stop all war status monitors (for graceful shutdown).
 */
export function stopAll() {
  for (const [warId, id] of intervals) {
    clearInterval(id);
    console.log(`[war-status] Stopped monitoring for war ${warId}`);
  }
  intervals.clear();
}
