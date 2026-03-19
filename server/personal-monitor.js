/**
 * Personal stat monitor for all subscribed faction members.
 *
 * Polls the Torn API every 5 minutes for each player who has push
 * subscriptions, checking energy, nerve, and drug cooldown.
 * Fires push notifications when thresholds are hit. Only fires once
 * per "full" event — resets when the stat drops below max again.
 *
 * @author RussianRob
 */

import { fetchUserBars } from "./torn-api.js";
import * as store from "./store.js";
import {
  notifyFullEnergy,
  notifyFullNerve,
  notifyDrugCooldown,
  getSubscribedPlayerIds,
} from "./push-notifications.js";

const POLL_INTERVAL_MS = 300_000; // 5 minutes (matches energy/nerve tick rate)

let pollTimeout = null;

/**
 * Per-player state tracking so we only fire once per threshold crossing.
 * Map of playerId → { energyFull: bool, nerveFull: bool, drugReady: bool }
 */
const playerState = new Map();

function getState(playerId) {
  if (!playerState.has(playerId)) {
    // Initialize with "already full" so first poll doesn't spam
    playerState.set(playerId, {
      energyFull: false,
      nerveFull: false,
      drugReady: true, // assume ready so we don't alert on startup
    });
  }
  return playerState.get(playerId);
}

/**
 * Start the personal monitor polling loop.
 */
export function startPersonalMonitor() {
  if (pollTimeout) return; // already running
  console.log("[personal] Starting personal monitor for all subscribed players");
  poll();
}

/**
 * Stop the personal monitor.
 */
export function stopPersonalMonitor() {
  if (pollTimeout) {
    clearTimeout(pollTimeout);
    pollTimeout = null;
  }
  console.log("[personal] Stopped personal monitor");
}

async function poll() {
  try {
    const playerIds = getSubscribedPlayerIds();

    // Poll each subscribed player sequentially to avoid API burst
    for (const playerId of playerIds) {
      try {
        await pollPlayer(playerId);
      } catch (err) {
        // Log but continue to next player
        console.error(`[personal] Error polling player ${playerId}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[personal] Poll cycle error: ${err.message}`);
  }

  scheduleNext();
}

async function pollPlayer(playerId) {
  // Need an API key for this player
  const apiKey = store.getApiKeyForPlayer(playerId);
  if (!apiKey) return;

  const bars = await fetchUserBars(apiKey);
  const state = getState(playerId);

  // ── Energy Full ──
  const energyFull = bars.energy.current >= bars.energy.maximum && bars.energy.maximum > 0;
  if (energyFull && !state.energyFull) {
    console.log(`[personal] Player ${playerId} energy full: ${bars.energy.current}/${bars.energy.maximum}`);
    notifyFullEnergy(playerId, bars.energy.current, bars.energy.maximum).catch(() => {});
  }
  state.energyFull = energyFull;

  // ── Nerve Full ──
  const nerveFull = bars.nerve.current >= bars.nerve.maximum && bars.nerve.maximum > 0;
  if (nerveFull && !state.nerveFull) {
    console.log(`[personal] Player ${playerId} nerve full: ${bars.nerve.current}/${bars.nerve.maximum}`);
    notifyFullNerve(playerId, bars.nerve.current, bars.nerve.maximum).catch(() => {});
  }
  state.nerveFull = nerveFull;

  // ── Drug Cooldown Done ──
  const drugReady = bars.cooldowns.drug === 0;
  if (drugReady && !state.drugReady) {
    console.log(`[personal] Player ${playerId} drug cooldown expired`);
    notifyDrugCooldown(playerId).catch(() => {});
  }
  state.drugReady = drugReady;
}

function scheduleNext() {
  pollTimeout = setTimeout(poll, POLL_INTERVAL_MS);
}
