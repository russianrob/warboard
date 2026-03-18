/**
 * Chain monitoring service.
 *
 * Periodically polls the Torn API for enemy faction chain data and broadcasts
 * updates (including bonus-hit alerts) to the appropriate war room.
 */

import * as store from "./store.js";
import { fetchFactionChain } from "./torn-api.js";

const POLL_INTERVAL_MS = 10_000; // 10 seconds
const MAX_BACKOFF_MS = 120_000;   // max 2 minutes between retries on failure

/** Bonus hit thresholds in Torn chain mechanics. */
const BONUS_HITS = [
  10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000,
];

/** Active polling timeout IDs per warId so we can clean them up. */
const timeouts = new Map();
/** Current backoff delay per warId (resets on success). */
const backoffs = new Map();

// Legacy — keep for stopAll compat
const intervals = new Map();

/**
 * Start chain monitoring for a war room.
 * @param {import("socket.io").Server|null} io  Socket.IO server (optional, may be null for HTTP-only)
 * @param {string} warId
 */
export function startChainMonitor(io, warId) {
  if (timeouts.has(warId)) return; // already monitoring

  const scheduleNext = (delay) => {
    const tid = setTimeout(poll, delay);
    timeouts.set(warId, tid);
  };

  const poll = async () => {
    const war = store.getWar(warId);
    if (!war || !war.factionId) { scheduleNext(POLL_INTERVAL_MS); return; }

    const apiKey = store.getFactionApiKey(war.factionId) || store.getApiKeyForFaction(war.factionId);
    if (!apiKey) { scheduleNext(POLL_INTERVAL_MS); return; }

    try {
      const chain = await fetchFactionChain(war.factionId, apiKey);

      // Compensate for API cache age
      if (chain.timestamp && chain.timeout > 0) {
          const cacheAge = Math.floor(Date.now() / 1000) - chain.timestamp;
          if (cacheAge > 0 && cacheAge < 300) {
              chain.timeout = Math.max(0, chain.timeout - cacheAge);
          }
      }
      war.chainData = chain;
      store.saveState();

      // Success — reset backoff
      backoffs.set(warId, POLL_INTERVAL_MS);

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

      scheduleNext(POLL_INTERVAL_MS);
    } catch (err) {
      // Exponential backoff on failure — double the delay, cap at MAX_BACKOFF_MS
      const current = backoffs.get(warId) || POLL_INTERVAL_MS;
      const next = Math.min(current * 2, MAX_BACKOFF_MS);
      backoffs.set(warId, next);
      console.error(`[chain] Poll failed for war ${warId}: ${err.message} (retry in ${Math.round(next/1000)}s)`);
      scheduleNext(next);
    }
  };

  // Run immediately, schedule via setTimeout chain (not setInterval)
  backoffs.set(warId, POLL_INTERVAL_MS);
  poll();
  console.log(`[chain] Started monitoring for war ${warId}`);
}

/**
 * Stop chain monitoring for a war room.
 * @param {string} warId
 */
export function stopChainMonitor(warId) {
  const tid = timeouts.get(warId);
  if (tid) {
    clearTimeout(tid);
    timeouts.delete(warId);
  }
  backoffs.delete(warId);
  // Legacy cleanup
  const id = intervals.get(warId);
  if (id) clearInterval(id);
  intervals.delete(warId);
  console.log(`[chain] Stopped monitoring for war ${warId}`);
}

/**
 * Stop all chain monitors (for graceful shutdown).
 */
export function stopAll() {
  for (const [warId, tid] of timeouts) {
    clearTimeout(tid);
    console.log(`[chain] Stopped monitoring for war ${warId}`);
  }
  timeouts.clear();
  backoffs.clear();
  // Legacy cleanup
  for (const [, id] of intervals) clearInterval(id);
  intervals.clear();
}
