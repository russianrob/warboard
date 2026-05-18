/**
 * Background poll loop for Status Live Activity subscribers.
 *
 * Every POLL_INTERVAL_MS (default 5 min), iterates every registered
 * (playerId, token, apiKey) row and:
 *   1. Hits Torn's /user?selections=bars,cooldowns with that apiKey
 *   2. Builds the StatusActivityAttributes.ContentState payload
 *   3. Pushes it to that device's push token via apns.sendLiveActivity
 *
 * Failures handled gracefully:
 *   - Torn API errors (invalid key, rate-limit) → skip this row, retry
 *     next tick. Persistent failures don't kick the user out — they
 *     just see stale data until the next successful poll.
 *   - APNs BadDeviceToken / Unregistered → token is reaped via
 *     status-la-tokens.remove(). User has to re-subscribe.
 *
 * Boot: only starts when the master encryption key is configured
 * (loadable via key-encryption), so a misconfigured dev server doesn't
 * crash-loop on apiKey decryption.
 */

import * as tokens from "./status-la-tokens.js";
import * as apns from "./apns.js";

const POLL_INTERVAL_MS = Number(process.env.STATUS_LA_POLL_MS) || 5 * 60 * 1000; // 5 min
const POLL_JITTER_MS = 30 * 1000; // spread initial start so all users don't poll the same instant
let _timer = null;
let _started = false;

async function fetchBars(apiKey) {
  const url = `https://api.torn.com/user?selections=bars,cooldowns&key=${encodeURIComponent(apiKey)}&comment=wb-status-la`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { error: `http ${res.status}` };
    const json = await res.json();
    if (json.error) return { error: json.error.error || "torn-error" };
    return { data: json };
  } catch (e) {
    return { error: e.message || "fetch-failed" };
  }
}

function buildContentState(json) {
  // Match StatusActivityAttributes.ContentState shape exactly — Apple
  // delivers the JSON straight into the ActivityKit decoder, so the
  // keys + types have to line up with the Codable struct.
  const nowMs = Date.now();
  const energy = json.energy || {};
  const nerve = json.nerve || {};
  const cd = json.cooldowns || {};
  const drugSec = Number(cd.drug) || 0;
  const boosterSec = Number(cd.booster) || 0;
  return {
    energyCurrent: Number(energy.current) || 0,
    energyMax: Number(energy.maximum) || 0,
    nerveCurrent: Number(nerve.current) || 0,
    nerveMax: Number(nerve.maximum) || 0,
    drugDeadlineMs: drugSec > 0 ? nowMs + drugSec * 1000 : 0,
    boosterDeadlineMs: boosterSec > 0 ? nowMs + boosterSec * 1000 : 0,
    writtenAtMs: nowMs,
  };
}

async function tick() {
  const rows = tokens.listAllDecrypted();
  if (rows.length === 0) return;
  for (const row of rows) {
    const { data, error } = await fetchBars(row.apiKey);
    if (error) {
      // Don't reap on Torn-side errors — could be transient.
      continue;
    }
    const state = buildContentState(data);
    const result = await apns.sendLiveActivity(row.token, state, { event: "update" });
    if (!result.ok) {
      const reason = result.reason || result.apnsStatus || "";
      // Reap definitively-bad tokens. Apple's APNs returns 410 +
      // "BadDeviceToken" / "Unregistered" for tokens that no longer
      // map to an active activity (user dismissed, app uninstalled,
      // 12h LA expiry). Anything else (5xx, timeouts) we leave for
      // the next tick.
      if (reason === "BadDeviceToken" || reason === "Unregistered"
          || result.apnsStatus === 410) {
        tokens.remove({ token: row.token });
        console.log(`[status-la] reaped dead token for player ${row.playerId} (${reason})`);
      }
    }
  }
}

export function start() {
  if (_started) return;
  _started = true;
  console.log(`[status-la] poller starting (interval=${POLL_INTERVAL_MS / 1000}s)`);
  // Stagger the first run by a small jitter so server-boot stampedes
  // don't all hit Torn at once if many users are subscribed.
  const initialDelay = Math.floor(Math.random() * POLL_JITTER_MS);
  _timer = setTimeout(function loop() {
    tick().catch(e => console.error("[status-la] tick error:", e.message));
    _timer = setTimeout(loop, POLL_INTERVAL_MS);
  }, initialDelay);
}

export function stop() {
  if (_timer) clearTimeout(_timer);
  _timer = null;
  _started = false;
}
