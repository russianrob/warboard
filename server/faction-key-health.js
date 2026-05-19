/**
 * Faction API key health monitor.
 *
 * Background loop probes every faction's stored API key against Torn's
 * /user?selections=basic endpoint. When a key returns code 2
 * ("Incorrect key"), it's been regenerated/revoked by its owner and is
 * silently failing every scout report + heatmap call that uses it.
 *
 * Notification gate: pushes a warning ONLY to the configured admin
 * playerId (env WB_KEY_HEALTH_ADMIN_PLAYER_ID), defaulting to 137558
 * (RussianRob, Dead Fragment owner). We don't broadcast to the whole
 * faction because most members can't update the faction key anyway —
 * surfacing it to admins keeps the noise off everyone else.
 *
 * De-duped: a given faction's "broken" state only notifies once per
 * 24h. When the key starts working again, the alert state resets so
 * a future break re-notifies.
 */

import { decrypt } from "./key-encryption.js";
import * as store from "./store.js";
import * as push from "./push-notifications.js";

const ADMIN_PLAYER_ID = String(
  process.env.WB_KEY_HEALTH_ADMIN_PLAYER_ID || "137558"
);
const POLL_INTERVAL_MS = Number(process.env.WB_KEY_HEALTH_POLL_MS) || 30 * 60 * 1000; // 30 min
const RENOTIFY_INTERVAL_MS = 24 * 3600 * 1000; // 24h
const lastNotifyAt = new Map(); // factionId → epoch ms

let _timer = null;
let _running = false;

async function probeKey(factionId) {
  const enc = store.getFactionApiKey(String(factionId));
  if (!enc) return { factionId, healthy: null, reason: "no-key-stored" };
  let plaintext;
  try { plaintext = decrypt(enc); }
  catch (e) { return { factionId, healthy: false, reason: `decrypt-failed: ${e.message}` }; }
  try {
    const url = `https://api.torn.com/user?selections=basic&key=${encodeURIComponent(plaintext)}&comment=wb-keyhealth`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    if (j.error) return { factionId, healthy: false, reason: j.error.error, code: j.error.code };
    return { factionId, healthy: true, playerId: j.player_id };
  } catch (e) {
    return { factionId, healthy: null, reason: `fetch-failed: ${e.message}` };
  }
}

async function notifyBroken(factionId, reason) {
  const last = lastNotifyAt.get(String(factionId)) || 0;
  if (Date.now() - last < RENOTIFY_INTERVAL_MS) return;
  lastNotifyAt.set(String(factionId), Date.now());
  try {
    await push.sendToPlayer(ADMIN_PLAYER_ID, {
      title: "Warboard: Faction API key broken",
      body: `Faction ${factionId} key: ${reason}. Update it in faction settings.`,
      data: { type: "faction-key-health", factionId: String(factionId), reason },
    });
    console.log(`[key-health] notified admin ${ADMIN_PLAYER_ID} about faction ${factionId} (reason: ${reason})`);
  } catch (e) {
    console.warn(`[key-health] push to ${ADMIN_PLAYER_ID} failed: ${e.message}`);
  }
}

async function tick() {
  if (_running) return;
  _running = true;
  try {
    // Iterate every faction that has a stored key.
    const factionIds = store.listFactionApiKeyIds ? store.listFactionApiKeyIds() : [];
    if (factionIds.length === 0) return;
    for (const fid of factionIds) {
      const result = await probeKey(fid);
      if (result.healthy === false) {
        console.warn(`[key-health] faction ${fid} key BROKEN (${result.reason}, code ${result.code ?? "?"})`);
        await notifyBroken(fid, `${result.reason}${result.code != null ? ` (code ${result.code})` : ""}`);
      } else if (result.healthy === true) {
        // Reset de-dup so a future break re-notifies.
        if (lastNotifyAt.has(String(fid))) {
          lastNotifyAt.delete(String(fid));
          console.log(`[key-health] faction ${fid} key recovered`);
        }
      }
    }
  } finally {
    _running = false;
  }
}

export function start() {
  if (_timer) return;
  console.log(`[key-health] starting (interval=${POLL_INTERVAL_MS / 1000}s, admin=${ADMIN_PLAYER_ID})`);
  // First probe after 60s so server boot finishes loading first.
  _timer = setTimeout(function loop() {
    tick().catch(e => console.error("[key-health] tick error:", e.message));
    _timer = setTimeout(loop, POLL_INTERVAL_MS);
  }, 60_000);
}

export function stop() {
  if (_timer) clearTimeout(_timer);
  _timer = null;
}
