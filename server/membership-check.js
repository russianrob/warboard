/**
 * Weekly faction membership verification.
 *
 * Every Tuesday at 00:05 UTC, re-verifies all stored API keys against the
 * Torn API. Any player no longer in the allowed faction has their key purged,
 * effectively revoking their access on next auth.
 */

import * as store from "./store.js";
import { verifyTornApiKey } from "./auth.js";

const ALLOWED_FACTION_ID = "42055";

/** Run the membership check immediately. */
export async function runMembershipCheck() {
  const keys = store.getAllApiKeys();
  if (keys.length === 0) {
    console.log("[membership] No stored API keys to verify");
    return;
  }

  console.log(`[membership] Verifying ${keys.length} stored API key(s)...`);
  let removed = 0;

  for (const [playerId, apiKey] of keys) {
    try {
      const info = await verifyTornApiKey(apiKey);
      if (info.factionId !== ALLOWED_FACTION_ID) {
        store.removeApiKey(playerId);
        removed++;
        console.log(
          `[membership] Removed ${info.playerName} (${playerId}) — now in faction ${info.factionId || "none"}`
        );
      }
    } catch (err) {
      // Key is invalid/revoked — remove it
      store.removeApiKey(playerId);
      removed++;
      console.log(
        `[membership] Removed key for player ${playerId} — verification failed: ${err.message}`
      );
    }

    // Small delay between checks to avoid rate-limiting
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(
    `[membership] Check complete: ${removed} removed, ${keys.length - removed} active`
  );
}

/**
 * Schedule the weekly Tuesday check.
 * Runs every minute and fires when it's Tuesday 00:05 UTC.
 */
let scheduledTimer = null;

export function startMembershipSchedule() {
  // Check once per minute if it's time
  scheduledTimer = setInterval(() => {
    const now = new Date();
    if (
      now.getUTCDay() === 2 &&       // Tuesday
      now.getUTCHours() === 0 &&      // midnight UTC
      now.getUTCMinutes() === 5       // :05
    ) {
      console.log("[membership] Tuesday check triggered");
      runMembershipCheck();
    }
  }, 60_000);

  console.log("[membership] Weekly Tuesday check scheduled (00:05 UTC)");
}

export function stopMembershipSchedule() {
  if (scheduledTimer) {
    clearInterval(scheduledTimer);
    scheduledTimer = null;
  }
}
