/**
 * Personal stat monitor for RussianRob (player 137558).
 *
 * Polls the Torn API every 60s for energy, nerve, and drug cooldown,
 * firing push notifications when thresholds are hit. Only fires once
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
  isSubscribed,
} from "./push-notifications.js";

const PLAYER_ID = "137558";
const POLL_INTERVAL_MS = 60_000; // 60 seconds

let pollTimeout = null;

// Track previous state so we only fire once per threshold crossing
let prev = {
  energyFull: false,
  nerveFull: false,
  drugReady: true, // start as true so we don't alert on first poll if already 0
};

/**
 * Start the personal monitor polling loop.
 */
export function startPersonalMonitor() {
  if (pollTimeout) return; // already running
  console.log(`[personal] Starting personal monitor for player ${PLAYER_ID}`);
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
    // Only poll if this player has push subscriptions
    if (!isSubscribed(PLAYER_ID)) {
      scheduleNext();
      return;
    }

    // Get the player's stored API key
    const apiKey = store.getApiKeyForPlayer(PLAYER_ID);
    if (!apiKey) {
      scheduleNext();
      return;
    }

    const bars = await fetchUserBars(apiKey);

    // ── Energy Full ──
    const energyFull = bars.energy.current >= bars.energy.maximum && bars.energy.maximum > 0;
    if (energyFull && !prev.energyFull) {
      console.log(`[personal] Energy full: ${bars.energy.current}/${bars.energy.maximum}`);
      notifyFullEnergy(PLAYER_ID, bars.energy.current, bars.energy.maximum).catch(() => {});
    }
    prev.energyFull = energyFull;

    // ── Nerve Full ──
    const nerveFull = bars.nerve.current >= bars.nerve.maximum && bars.nerve.maximum > 0;
    if (nerveFull && !prev.nerveFull) {
      console.log(`[personal] Nerve full: ${bars.nerve.current}/${bars.nerve.maximum}`);
      notifyFullNerve(PLAYER_ID, bars.nerve.current, bars.nerve.maximum).catch(() => {});
    }
    prev.nerveFull = nerveFull;

    // ── Drug Cooldown Done ──
    const drugReady = bars.cooldowns.drug === 0;
    if (drugReady && !prev.drugReady) {
      console.log("[personal] Drug cooldown expired");
      notifyDrugCooldown(PLAYER_ID).catch(() => {});
    }
    prev.drugReady = drugReady;

  } catch (err) {
    console.error(`[personal] Poll error: ${err.message}`);
  }

  scheduleNext();
}

function scheduleNext() {
  pollTimeout = setTimeout(poll, POLL_INTERVAL_MS);
}
