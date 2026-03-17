/**
 * Chain monitoring service.
 *
 * Periodically polls the Torn API for enemy faction chain data and broadcasts
 * updates (including bonus-hit alerts) to the appropriate war room.
 */

import * as store from "./store.js";
import { fetchFactionChain } from "./torn-api.js";

const POLL_INTERVAL_MS = 30_000; // 30 seconds

/** Bonus hit thresholds in Torn chain mechanics. */
const BONUS_HITS = [
  10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000,
];

/** Active polling interval IDs per warId so we can clean them up. */
const intervals = new Map();

/**
 * Start chain monitoring for a war room.
 * @param {import("socket.io").Server|null} io  Socket.IO server (optional, may be null for HTTP-only)
 * @param {string} warId
 */
export function startChainMonitor(io, warId) {
  if (intervals.has(warId)) return; // already monitoring

  const poll = async () => {
    const war = store.getWar(warId);
    if (!war || !war.factionId) return;

    const apiKey = store.getFactionApiKey(war.factionId) || store.getApiKeyForFaction(war.factionId);
    if (!apiKey) return; // no key available, skip silently

    try {
      const chain = await fetchFactionChain(war.factionId, apiKey);

      war.chainData = chain;
      store.saveState();

      // Determine next bonus hit
      const nextBonus = BONUS_HITS.find((b) => b > chain.current) ?? null;

      // Broadcast via Socket.IO if available (HTTP polling clients get it from /api/poll)
      if (io) {
        const payload = {
          factionId: war.factionId,
          current: chain.current,
          max: chain.max,
          timeout: chain.timeout,
          cooldown: chain.cooldown,
          bonusHits: BONUS_HITS,
          nextBonus,
        };

        io.to(`war_${warId}`).emit("chain_update", payload);

        if (nextBonus && chain.current >= nextBonus - 3 && chain.current < nextBonus) {
          io.to(`war_${warId}`).emit("chain_bonus_alert", {
            current: chain.current,
            nextBonus,
            hitsAway: nextBonus - chain.current,
          });
        }

        if (chain.current > 0 && chain.timeout > 0 && chain.timeout < 60) {
          io.to(`war_${warId}`).emit("chain_timeout_warning", {
            current: chain.current,
            timeout: chain.timeout,
          });
        }
      }
    } catch (err) {
      console.error(`[chain] Poll failed for war ${warId}:`, err.message);
    }
  };

  // Run immediately, then on interval
  poll();
  intervals.set(warId, setInterval(poll, POLL_INTERVAL_MS));
  console.log(`[chain] Started monitoring for war ${warId}`);
}

/**
 * Stop chain monitoring for a war room.
 * @param {string} warId
 */
export function stopChainMonitor(warId) {
  const id = intervals.get(warId);
  if (id) {
    clearInterval(id);
    intervals.delete(warId);
    console.log(`[chain] Stopped monitoring for war ${warId}`);
  }
}

/**
 * Stop all chain monitors (for graceful shutdown).
 */
export function stopAll() {
  for (const [warId, id] of intervals) {
    clearInterval(id);
    console.log(`[chain] Stopped monitoring for war ${warId}`);
  }
  intervals.clear();
}
