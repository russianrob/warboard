/**
 * APNs HTTP/2 client for Live Activity push notifications.
 *
 * Why custom: Live Activity push has very specific header requirements
 * (`apns-push-type: liveactivity`, `apns-topic: <bundle>.push-type.liveactivity`,
 * timestamp + event in the payload), and the apns2 npm package's Live
 * Activity helper has historically lagged Apple's spec. Rolling our own
 * keeps the path narrow — one connection, one send function, no extra
 * dependency.
 *
 * Reuses one HTTP/2 session against api.push.apple.com (or sandbox) and
 * one cached JWT (rotated every ~50 minutes — Apple invalidates >1h-old
 * tokens). Both are lazily initialized on first send so the module load
 * stays free even when APNs isn't configured.
 *
 * Required env vars (all-or-nothing — set all five or the module no-ops):
 *   APNS_KEY_PATH       absolute path to the .p8 file from Apple Dev portal
 *   APNS_KEY_ID         10-char key ID printed next to the key in the portal
 *   APNS_TEAM_ID        10-char Apple developer team ID
 *   APNS_BUNDLE_ID      bundle identifier of the iOS app (NOT the live-
 *                       activity suffix — we append .push-type.liveactivity
 *                       ourselves for the apns-topic header)
 *   APNS_HOST           "production" | "sandbox" (default: production)
 */

import http2 from "node:http2";
import { readFileSync } from "node:fs";
import jwt from "jsonwebtoken";

const KEY_PATH   = process.env.APNS_KEY_PATH || "";
const KEY_ID     = process.env.APNS_KEY_ID   || "";
const TEAM_ID    = process.env.APNS_TEAM_ID  || "";
const BUNDLE_ID  = process.env.APNS_BUNDLE_ID || "";
const HOST_KIND  = (process.env.APNS_HOST || "production").toLowerCase();

const HOST = HOST_KIND === "sandbox"
  ? "api.sandbox.push.apple.com"
  : "api.push.apple.com";

/** True if all required APNs env vars are present and the .p8 file is readable. */
let _enabled = null;
function isConfigured() {
  if (_enabled !== null) return _enabled;
  if (!KEY_PATH || !KEY_ID || !TEAM_ID || !BUNDLE_ID) {
    _enabled = false;
    return false;
  }
  try {
    readFileSync(KEY_PATH, "utf8");
    _enabled = true;
    console.log(`[apns] configured for ${HOST} (bundle ${BUNDLE_ID})`);
  } catch (err) {
    console.warn(`[apns] APNS_KEY_PATH ${KEY_PATH} is not readable: ${err.message}`);
    _enabled = false;
  }
  return _enabled;
}

// ── JWT cache ───────────────────────────────────────────────────────────
// Apple wants the same provider JWT reused across requests within an
// hour and rejects tokens older than 1h with status 403 reason
// ExpiredProviderToken. Refresh ~10min before that to give margin.

let _cachedToken = null;
let _cachedTokenAt = 0;
const TOKEN_TTL_MS = 50 * 60 * 1000;

function getProviderJwt() {
  const now = Date.now();
  if (_cachedToken && (now - _cachedTokenAt) < TOKEN_TTL_MS) {
    return _cachedToken;
  }
  const privateKey = readFileSync(KEY_PATH, "utf8");
  _cachedToken = jwt.sign(
    { iss: TEAM_ID, iat: Math.floor(now / 1000) },
    privateKey,
    { algorithm: "ES256", header: { alg: "ES256", kid: KEY_ID } },
  );
  _cachedTokenAt = now;
  return _cachedToken;
}

// ── HTTP/2 session reuse ────────────────────────────────────────────────
// One long-lived session keeps the latency per push low (no TLS
// handshake per call). On any error we tear down + lazy-recreate on
// next send.

let _client = null;
function getClient() {
  if (_client && !_client.closed && !_client.destroyed) return _client;
  _client = http2.connect(`https://${HOST}`);
  _client.on("error", (err) => {
    console.warn(`[apns] HTTP/2 session error: ${err.message}`);
    try { _client.close(); } catch {}
    _client = null;
  });
  _client.on("close", () => { _client = null; });
  return _client;
}

/**
 * Send a Live Activity update to a single device token.
 *
 * @param {string} deviceToken hex-encoded push token from the activity
 * @param {object} contentState ContentState dict — keys must match the
 *   ChainActivityAttributes.ContentState field names
 * @param {object} [opts]
 * @param {"update"|"end"} [opts.event] default "update"
 * @param {number} [opts.staleDateUnix] unix-seconds when iOS should mark
 *   the activity stale (for "update")
 * @param {number} [opts.dismissalDateUnix] unix-seconds when the system
 *   should auto-dismiss after end (for "end")
 * @param {number} [opts.priority] 1 | 5 | 10 — APNs delivery priority
 * @returns {Promise<{ok: boolean, status?: number, reason?: string}>}
 */
export async function sendLiveActivity(deviceToken, contentState, opts = {}) {
  if (!isConfigured()) return { ok: false, reason: "not-configured" };
  if (!deviceToken || typeof deviceToken !== "string") {
    return { ok: false, reason: "missing-token" };
  }

  const event = opts.event || "update";
  const payload = {
    aps: {
      timestamp: Math.floor(Date.now() / 1000),
      event,
      "content-state": contentState,
    },
  };
  if (opts.staleDateUnix && event === "update") {
    payload.aps["stale-date"] = opts.staleDateUnix;
  }
  if (opts.dismissalDateUnix && event === "end") {
    payload.aps["dismissal-date"] = opts.dismissalDateUnix;
  }

  return new Promise((resolve) => {
    let session;
    try {
      session = getClient();
    } catch (err) {
      return resolve({ ok: false, reason: `session-failed: ${err.message}` });
    }

    // apns-expiration: when set to 0, Apple treats the push as "deliver
    // right now or discard." That's a problem for backgrounded /
    // locked-screen devices that aren't immediately ready to render —
    // the push silently drops on the floor. Setting a TTL of 5 minutes
    // means Apple retries delivery for that long if the device isn't
    // ready, which lines up with how often chain state meaningfully
    // changes (chain timer is 5min, hits land more frequently than
    // that). For "end" events with a near-term dismissal-date, no TTL
    // is needed since the dismissal handles cleanup.
    const expiresAt = opts.event === "end"
      ? 0
      : Math.floor(Date.now() / 1000) + 300;
    const headers = {
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      "apns-topic": `${BUNDLE_ID}.push-type.liveactivity`,
      "apns-push-type": "liveactivity",
      "apns-priority": String(opts.priority ?? 10),
      "apns-expiration": String(expiresAt),
      "authorization": `bearer ${getProviderJwt()}`,
      "content-type": "application/json",
    };

    let req;
    try {
      req = session.request(headers);
    } catch (err) {
      return resolve({ ok: false, reason: `request-failed: ${err.message}` });
    }
    let respStatus = 0;
    let respBody = "";
    req.on("response", (h) => { respStatus = Number(h[":status"]) || 0; });
    req.on("data", (chunk) => { respBody += chunk.toString("utf8"); });
    req.on("end", () => {
      if (respStatus === 200) {
        return resolve({ ok: true, status: 200 });
      }
      // Parse APNs error body — { reason: "BadDeviceToken" } etc.
      let reason = `status-${respStatus}`;
      try {
        const j = JSON.parse(respBody);
        if (j.reason) reason = j.reason;
      } catch {}
      // Refresh JWT on token-expired so the next send works.
      if (reason === "ExpiredProviderToken") {
        _cachedToken = null;
      }
      resolve({ ok: false, status: respStatus, reason });
    });
    req.on("error", (err) => {
      resolve({ ok: false, reason: `req-error: ${err.message}` });
    });

    req.setEncoding("utf8");
    req.end(JSON.stringify(payload));
  });
}

/**
 * Send a regular alert/banner push to a device token.
 *
 * Distinct from sendLiveActivity in two ways:
 * - apns-topic is just the bundle ID (no ".push-type.liveactivity")
 * - apns-push-type is "alert" (default banner/sound notification)
 *
 * @param {string} deviceToken hex-encoded device push token (the one
 *   posted by /api/apns/subscribe at app launch, NOT the per-activity
 *   token used by sendLiveActivity)
 * @param {object} payload
 * @param {string} payload.title alert title shown on lock screen
 * @param {string} payload.body alert body
 * @param {object} [payload.data] optional structured data payload
 * @param {string} [payload.sound] sound name, default "default"
 * @param {string} [payload.threadId] APNs thread-id for grouping
 * @param {object} [opts]
 * @param {number} [opts.priority] 1 | 5 | 10 (default 10)
 * @param {number} [opts.ttlSec] retry window in seconds (default 300)
 * @returns {Promise<{ok: boolean, status?: number, reason?: string}>}
 */
export async function sendAlert(deviceToken, payload, opts = {}) {
  if (!isConfigured()) return { ok: false, reason: "not-configured" };
  if (!deviceToken || typeof deviceToken !== "string") {
    return { ok: false, reason: "missing-token" };
  }

  const aps = {
    alert: {
      title: payload.title || "",
      body: payload.body || "",
    },
    sound: payload.sound || "default",
  };
  if (payload.threadId) aps["thread-id"] = String(payload.threadId);
  const body = { aps };
  // Tuck arbitrary data into a sibling key so iOS receives it via
  // userInfo without polluting `aps`.
  if (payload.data && typeof payload.data === "object") {
    Object.assign(body, payload.data);
  }

  return new Promise((resolve) => {
    let session;
    try {
      session = getClient();
    } catch (err) {
      return resolve({ ok: false, reason: `session-failed: ${err.message}` });
    }

    const expiresAt = Math.floor(Date.now() / 1000) + (opts.ttlSec ?? 300);
    const headers = {
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      "apns-topic": BUNDLE_ID,
      "apns-push-type": "alert",
      "apns-priority": String(opts.priority ?? 10),
      "apns-expiration": String(expiresAt),
      "authorization": `bearer ${getProviderJwt()}`,
      "content-type": "application/json",
    };

    let req;
    try {
      req = session.request(headers);
    } catch (err) {
      return resolve({ ok: false, reason: `request-failed: ${err.message}` });
    }
    let respStatus = 0;
    let respBody = "";
    req.on("response", (h) => { respStatus = Number(h[":status"]) || 0; });
    req.on("data", (chunk) => { respBody += chunk.toString("utf8"); });
    req.on("end", () => {
      if (respStatus === 200) return resolve({ ok: true, status: 200 });
      let reason = `status-${respStatus}`;
      try {
        const j = JSON.parse(respBody);
        if (j.reason) reason = j.reason;
      } catch {}
      if (reason === "ExpiredProviderToken") _cachedToken = null;
      resolve({ ok: false, status: respStatus, reason });
    });
    req.on("error", (err) => {
      resolve({ ok: false, reason: `req-error: ${err.message}` });
    });

    req.setEncoding("utf8");
    req.end(JSON.stringify(body));
  });
}

/**
 * Tear down the cached HTTP/2 session. Call from server shutdown.
 */
export function close() {
  if (_client && !_client.destroyed) {
    try { _client.close(); } catch {}
  }
  _client = null;
}
