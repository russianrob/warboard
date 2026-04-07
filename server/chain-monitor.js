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

const POLL_INTERVAL_MS = 10_000; // 10 seconds
const MAX_BACKOFF_MS = 120_000;   // max 2 minutes between retries on failure
// Client chain forwarding removed — server always polls directly.
const CHAIN_ALERT_THRESHOLD = 60; // seconds — fire warning when chain timer <= this
const CHAIN_PANIC_THRESHOLD = 30; // seconds — fire panic when chain timer <= this
const CHAIN_MIN_HITS = 10;        // only alert when chain >= 10 (real chain)
const CHAIN_ALERT_COOLDOWN_MS = 30_000; // max one alert push per 30s per war
const CHAIN_PANIC_COOLDOWN_MS = 20_000; // max one panic push per 20s per war
const WAR_SCORE_CHECK_INTERVAL = 60_000; // check war score every 60s

/** Bonus hit thresholds in Torn chain mechanics. */
const BONUS_HITS = [
  10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000,
];

/** Active polling timeout IDs per warId so we can clean them up. */
const timeouts = new Map();
/** Current backoff delay per warId (resets on success). */
const backoffs = new Map();

/** Last time we sent a chain alert push per warId. */
const lastAlertSent = new Map();
/** Last time we sent a chain panic push per warId. */
const lastPanicSent = new Map();
/** Last time we checked war score per warId. */
const lastScoreCheck = new Map();
/** Track if we already notified war target reached per warId. */
const warTargetNotified = new Map();

// recordClientChainReport removed — server always polls directly.

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

    const apiKey = store.getFactionApiKey(war.factionId) || store.getApiKeyForFaction(war.factionId);
    if (!apiKey) { scheduleNext(POLL_INTERVAL_MS); return; }

    try {
      const chain = await fetchFactionChain(war.factionId, apiKey);

      // Note: removed cache age compensation — it was over-correcting and
      // causing false chain alerts (e.g. 128s timeout reported as 58s).
      // Torn's chain.timeout is already the value at time of API response.

      const prevChain = { ...war.chainData };
      war.chainData = chain;
      store.saveState();

      // Reset backoff on success
      backoffs.set(warId, POLL_INTERVAL_MS);

      // ── Chain-break push alerts ──
      if (chain.timeout > 0 && chain.current >= CHAIN_MIN_HITS) {
        // Panic alert at 30s
        if (chain.timeout <= CHAIN_PANIC_THRESHOLD) {
          const lastPanic = lastPanicSent.get(warId) || 0;
          if (Date.now() - lastPanic > CHAIN_PANIC_COOLDOWN_MS) {
            lastPanicSent.set(warId, Date.now());
            const warPlayers = store.getOnlinePlayersForWar(warId);
            push.notifyChainPanic(warPlayers, warId, chain.current, Math.round(chain.timeout));
            console.log(`[chain] PANIC alert: chain ${chain.current}, ${Math.round(chain.timeout)}s remaining (server poll)`);
          }
        // Warning alert at 60s
        } else if (chain.timeout <= CHAIN_ALERT_THRESHOLD) {
          const lastAlert = lastAlertSent.get(warId) || 0;
          if (Date.now() - lastAlert > CHAIN_ALERT_COOLDOWN_MS) {
            lastAlertSent.set(warId, Date.now());
            const warPlayers = store.getOnlinePlayersForWar(warId);
            push.notifyChainAlert(warPlayers, warId, chain.current, chain.timeout, Math.round(chain.timeout));
            console.log(`[chain] Warning alert: chain ${chain.current}, ${Math.round(chain.timeout)}s remaining (server poll)`);
          }
        }
      }

      // ── Bonus-imminent push alert ──
      if (chain.current >= CHAIN_MIN_HITS) {
        const nextBonus = BONUS_HITS.find((b) => b > chain.current);
        if (nextBonus && nextBonus - chain.current <= 2 && (prevChain.current || 0) < chain.current) {
          const warPlayers = store.getOnlinePlayersForWar(warId);
          push.notifyBonusImminent(warPlayers, warId, chain.current, nextBonus);
        }
      }

      // ── War score check (every 60s) ──
      const lastCheck = lastScoreCheck.get(warId) || 0;
      if (Date.now() - lastCheck > WAR_SCORE_CHECK_INTERVAL) {
        lastScoreCheck.set(warId, Date.now());
        try {
          const rw = await fetchRankedWar(war.factionId, apiKey);
          if (!rw && war.warScores && !war.warEnded) {
            // War was active (had scores) but now returns null — war ended
            war.warEnded = true;
            war.warEndedAt = Date.now();
            // Determine winner from last known scores
            const myScore = war.warScores.myScore || 0;
            const enemyScore = war.warScores.enemyScore || 0;
            war.warResult = myScore > enemyScore ? 'victory' : myScore < enemyScore ? 'defeat' : 'draw';
            store.saveState();
            console.log(`[chain] War ended: ${war.factionId} vs ${war.enemyFactionId} — ${war.warResult.toUpperCase()} (${myScore} vs ${enemyScore})`);
            // Broadcast war-ended event to all clients
            if (io) {
              io.to(`war_${warId}`).emit('war_ended', {
                warId,
                result: war.warResult,
                myScore,
                enemyScore,
                endedAt: war.warEndedAt,
              });
            }
          }
          if (rw) {
            // Store scores on war object so clients can display them
            war.warScores = { myScore: rw.myScore, enemyScore: rw.enemyScore };

            // If war was marked as ended but we now see it active (or a new war started), clear end flags
            if (war.warEnded) {
              delete war.warEnded;
              delete war.warEndedAt;
              delete war.warResult;
              console.log(`[chain] War back active or new war detected for faction ${war.factionId}`);
              store.saveState();
            }

            // If the enemy changed, wipe old data safely through store
            if (rw.enemyFactionId && String(war.enemyFactionId) !== String(rw.enemyFactionId)) {
              console.log(`[chain] Enemy faction changed from ${war.enemyFactionId} to ${rw.enemyFactionId}`);
              store.getOrCreateWar(warId, war.factionId, rw.enemyFactionId);
            }

            // Calculate server-side war ETA
            const warStart = rw.warStart || war.warStart || 0;
            if (warStart) war.warStart = warStart;
            
            // Server-side calculation. Wait, if hoursRemaining is < 0 it was setting etaTimestamp to the past, making the client say WON.
            // Let's protect against gap <= 0
            if (warStart && rw.warTarget && rw.myScore != null) {
              const nowSec = Math.floor(Date.now() / 1000);
              const totalElapsedHours = (nowSec - warStart) / 3600;

              let hoursRemainingFloat = 0;
              
              if (totalElapsedHours > 24) {
                const dropHours = Math.floor(totalElapsedHours - 24);
                const originalTarget = rw.warTarget / (1 - (dropHours * 0.01));
                const DROP_PER_HOUR = originalTarget * 0.01;
                const lead = Math.max(rw.myScore, rw.enemyScore);
                const gap = rw.warTarget - lead;
                hoursRemainingFloat = gap / DROP_PER_HOUR;
              } else {
                // Pre-24h phase: Calculate time until decay starts (24h mark) + time to decay the gap
                const DROP_PER_HOUR = rw.warTarget * 0.01;
                const lead = Math.max(rw.myScore, rw.enemyScore);
                const gap = rw.warTarget - lead;
                const timeUntilDecayStarts = 24 - totalElapsedHours;
                hoursRemainingFloat = timeUntilDecayStarts + (gap / DROP_PER_HOUR);
              }

              war.warEta = {
                etaTimestamp: hoursRemainingFloat > 0 ? Math.floor(Date.now() + (hoursRemainingFloat * 3600000)) : 0,
                hoursRemaining: Math.max(0, hoursRemainingFloat),
                currentTarget: rw.warTarget,
                calculatedAt: Date.now(),
              };
            }

            store.saveState();

            // Check if custom war target reached
            if (war.warTarget && war.warTarget.value && !war.warTarget.notifiedAt && !warTargetNotified.get(warId)) {
              if (rw.myScore >= war.warTarget.value) {
                warTargetNotified.set(warId, true);
                war.warTarget.notifiedAt = Date.now();
                store.saveState();
                const warPlayers = store.getOnlinePlayersForWar(warId);
                push.notifyWarTargetReached(warPlayers, warId, war.warTarget.value, rw.myScore);
                console.log(`[chain] War target ${war.warTarget.value} reached! Score: ${rw.myScore} (server poll)`);
              }
            }
          }
        } catch (scoreErr) {
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
  lastAlertSent.clear();
  lastScoreCheck.clear();
  warTargetNotified.clear();
}
