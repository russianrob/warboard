/**
 * Chain monitoring service.
 *
 * Server-side fallback: polls Torn API for chain data when no client is
 * reporting chain info (i.e. nobody has FactionOps open). Fires push
 * notifications for chain-break alerts and bonus-imminent hits.
 *
 * Only polls when:
 * - A war is active
 * - No client has reported chain data in the last CLIENT_STALE_MS
 */

import * as store from "./store.js";
import { fetchFactionChain, fetchRankedWar } from "./torn-api.js";
import * as push from "./push-notifications.js";

const POLL_INTERVAL_MS = 15_000; // 15 seconds
const MAX_BACKOFF_MS = 120_000;   // max 2 minutes between retries on failure
const CLIENT_STALE_MS = 15_000;   // if no client report in 15s, server takes over
const CHAIN_ALERT_THRESHOLD = 60; // seconds — fire alert when chain timer <= this
const CHAIN_ALERT_COOLDOWN_MS = 30_000; // max one alert push per 30s per war
const WAR_SCORE_CHECK_INTERVAL = 60_000; // check war score every 60s

/** Bonus hit thresholds in Torn chain mechanics. */
const BONUS_HITS = [
  10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000,
];

/** Active polling timeout IDs per warId so we can clean them up. */
const timeouts = new Map();
/** Current backoff delay per warId (resets on success). */
const backoffs = new Map();
/** Last time a client reported chain data per warId. */
const lastClientReport = new Map();
/** Last time we sent a chain alert push per warId. */
const lastAlertSent = new Map();
/** Last time we checked war score per warId. */
const lastScoreCheck = new Map();
/** Track if we already notified war target reached per warId. */
const warTargetNotified = new Map();

/**
 * Record that a client just reported chain data (called from /api/status route).
 * This prevents server-side polling from duplicating the client's work.
 */
export function recordClientChainReport(warId) {
  lastClientReport.set(warId, Date.now());
}

/**
 * Check if a client has recently reported chain data.
 */
function isClientReporting(warId) {
  const last = lastClientReport.get(warId) || 0;
  return (Date.now() - last) < CLIENT_STALE_MS;
}

/**
 * Start chain monitoring for a war room.
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

    // Skip if a client is actively reporting chain data
    if (isClientReporting(warId)) {
      scheduleNext(POLL_INTERVAL_MS);
      return;
    }

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

      const prevChain = { ...war.chainData };
      war.chainData = chain;
      store.saveState();

      // Reset backoff on success
      backoffs.set(warId, POLL_INTERVAL_MS);

      // ── Chain-break push alert ──
      if (chain.timeout > 0 && chain.timeout <= CHAIN_ALERT_THRESHOLD && chain.current > 0) {
        const lastAlert = lastAlertSent.get(warId) || 0;
        if (Date.now() - lastAlert > CHAIN_ALERT_COOLDOWN_MS) {
          lastAlertSent.set(warId, Date.now());
          const warPlayers = store.getOnlinePlayersForWar(warId);
          push.notifyChainAlert(warPlayers, warId, chain.current, chain.timeout, Math.round(chain.timeout));
          console.log(`[chain] Push alert: chain ${chain.current}, ${Math.round(chain.timeout)}s remaining (server poll)`);
        }
      }

      // ── Bonus-imminent push alert ──
      if (chain.current > 0) {
        const nextBonus = BONUS_HITS.find((b) => b > chain.current);
        if (nextBonus && nextBonus - chain.current <= 2 && (prevChain.current || 0) < chain.current) {
          const warPlayers = store.getOnlinePlayersForWar(warId);
          push.notifyBonusImminent(warPlayers, warId, chain.current, nextBonus);
        }
      }

      // ── War score check (for custom war target notifications) ──
      const lastCheck = lastScoreCheck.get(warId) || 0;
      if (war.warTarget && war.warTarget.value && !war.warTarget.notifiedAt && !warTargetNotified.get(warId) && Date.now() - lastCheck > WAR_SCORE_CHECK_INTERVAL) {
        lastScoreCheck.set(warId, Date.now());
        try {
          const rw = await fetchRankedWar(war.factionId, apiKey);
          if (rw && rw.myScore >= war.warTarget.value) {
            warTargetNotified.set(warId, true);
            war.warTarget.notifiedAt = Date.now();
            store.saveState();
            const warPlayers = store.getOnlinePlayersForWar(warId);
            push.notifyWarTargetReached(warPlayers, warId, war.warTarget.value, rw.myScore);
            console.log(`[chain] War target ${war.warTarget.value} reached! Score: ${rw.myScore} (server poll)`);
          }
        } catch (scoreErr) {
          // Non-fatal — score check is secondary
          console.error(`[chain] War score check failed: ${scoreErr.message}`);
        }
      }

      scheduleNext(POLL_INTERVAL_MS);
    } catch (err) {
      // Exponential backoff on failure
      const current = backoffs.get(warId) || POLL_INTERVAL_MS;
      const next = Math.min(current * 2, MAX_BACKOFF_MS);
      backoffs.set(warId, next);
      console.error(`[chain] Poll failed for war ${warId}: ${err.message} (retry in ${Math.round(next / 1000)}s)`);
      scheduleNext(next);
    }
  };

  backoffs.set(warId, POLL_INTERVAL_MS);
  poll();
  console.log(`[chain] Started monitoring for war ${warId} (server fallback, polls every ${POLL_INTERVAL_MS / 1000}s when no client active)`);
}

/**
 * Stop chain monitoring for a war room.
 */
export function stopChainMonitor(warId) {
  const tid = timeouts.get(warId);
  if (tid) {
    clearTimeout(tid);
    timeouts.delete(warId);
  }
  backoffs.delete(warId);
  lastClientReport.delete(warId);
  lastAlertSent.delete(warId);
  lastScoreCheck.delete(warId);
  warTargetNotified.delete(warId);
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
  lastClientReport.clear();
  lastAlertSent.clear();
  lastScoreCheck.clear();
  warTargetNotified.clear();
}
