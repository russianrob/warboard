/**
 * Webhook Bus — fires HTTP POSTs to faction-configured URLs on warboard events.
 *
 * Like Stripe's webhooks: faction leader registers a URL + event list, warboard
 * delivers signed JSON payloads when those events occur. Receivers verify via
 * HMAC-SHA256 using the per-webhook secret.
 *
 * Event types (extend freely):
 *   - vault-request.created        — new vault request posted
 *   - vault-request.fulfilled      — request auto-cleared (money sent)
 *   - vault-request.canceled       — request deleted by requester/admin
 *   - chain.milestone              — chain hits a round number (10, 25, 50, 100, …)
 *   - chain.break-warning          — chain timer < 60s
 *   - war.started / war.ended      — ranked war state change
 *   - oc.available                 — new OC slot opens
 *   - oc.assembled                 — OC slot filled
 *   - oc.completed                 — OC executed
 *   - faction.member-joined / left
 *
 * Payload shape:
 *   {
 *     id: "evt_1745...",
 *     type: "vault-request.created",
 *     factionId: "42055",
 *     occurredAt: 1745...,
 *     data: { ... }
 *   }
 *
 * Delivery semantics:
 *   - At-least-once; receivers should dedupe by event id
 *   - 3 retries with exponential backoff (2s, 8s, 32s)
 *   - Marks endpoint as failing after 10 consecutive failures; auto-disables
 *     until the faction re-enables via the management endpoint
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR    = process.env.DATA_DIR || "./data";
const HOOKS_FILE  = path.join(DATA_DIR, "webhooks.json");
const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_FAILS_BEFORE_DISABLE = 10;
const BACKOFF_SCHEDULE_MS = [2_000, 8_000, 32_000];

/** @type {Map<string, Array<Webhook>>} factionId → webhooks */
const hooks = new Map();

/** @typedef {{
 *   id: string,
 *   factionId: string,
 *   url: string,
 *   secret: string,
 *   events: string[],    // subscribed event types, "*" = all
 *   createdAt: number,
 *   lastFireAt: number,
 *   failCount: number,
 *   disabled: boolean,
 *   description?: string,
 * }} Webhook */

function load() {
  try {
    if (!fs.existsSync(HOOKS_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(HOOKS_FILE, "utf8"));
    for (const [fid, list] of Object.entries(raw || {})) {
      hooks.set(String(fid), Array.isArray(list) ? list : []);
    }
    console.log(`[webhook-bus] loaded ${hooks.size} faction(s) with webhooks`);
  } catch (e) {
    console.warn("[webhook-bus] load failed:", e.message);
  }
}
function save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const out = Object.fromEntries(hooks);
    fs.writeFileSync(HOOKS_FILE, JSON.stringify(out, null, 2), "utf8");
  } catch (e) {
    console.warn("[webhook-bus] save failed:", e.message);
  }
}
load();

function newId(prefix = "wh") {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function sign(body, secret) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

function matchesEvent(webhook, type) {
  if (!webhook.events || webhook.events.length === 0) return false;
  if (webhook.events.includes("*")) return true;
  if (webhook.events.includes(type)) return true;
  // Match "vault-request.*" style wildcards
  for (const pattern of webhook.events) {
    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -2);
      if (type.startsWith(prefix + ".")) return true;
    }
  }
  return false;
}

async function deliver(webhook, event, attempt = 0) {
  const body = JSON.stringify(event);
  const signature = sign(body, webhook.secret);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    const res = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Warboard-Signature": signature,
        "X-Warboard-Event": event.type,
        "X-Warboard-Event-Id": event.id,
        "User-Agent": "Warboard/1.0 (+https://tornwar.com)",
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.status >= 200 && res.status < 300) {
      webhook.lastFireAt = Date.now();
      webhook.failCount = 0;
      save();
      return true;
    }
    throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    if (attempt < BACKOFF_SCHEDULE_MS.length) {
      const wait = BACKOFF_SCHEDULE_MS[attempt];
      setTimeout(() => deliver(webhook, event, attempt + 1), wait);
      return false;
    }
    // Exhausted retries
    webhook.failCount = (webhook.failCount || 0) + 1;
    console.warn(`[webhook-bus] delivery failed (${e.message}) to ${webhook.url} — failCount=${webhook.failCount}`);
    if (webhook.failCount >= MAX_FAILS_BEFORE_DISABLE) {
      webhook.disabled = true;
      console.warn(`[webhook-bus] auto-disabled ${webhook.id} for faction ${webhook.factionId} after ${webhook.failCount} consecutive failures`);
    }
    save();
    return false;
  }
}

/**
 * Fire an event to all matching webhooks for a faction. Non-blocking —
 * delivery happens in the background.
 */
export function emit(factionId, type, data) {
  const fid = String(factionId);
  const list = hooks.get(fid) || [];
  const matching = list.filter(h => !h.disabled && matchesEvent(h, type));
  if (matching.length === 0) return 0;
  const event = {
    id: newId("evt"),
    type,
    factionId: fid,
    occurredAt: Date.now(),
    data: data || {},
  };
  for (const h of matching) {
    deliver(h, event).catch(() => {});
  }
  return matching.length;
}

/** Emit to ALL factions that have subscribed (e.g. global events). */
export function emitGlobal(type, data) {
  let delivered = 0;
  for (const [fid, list] of hooks) {
    for (const h of list) {
      if (!h.disabled && matchesEvent(h, type)) {
        deliver(h, {
          id: newId("evt"), type, factionId: fid,
          occurredAt: Date.now(), data: data || {},
        }).catch(() => {});
        delivered++;
      }
    }
  }
  return delivered;
}

// ── CRUD ──────────────────────────────────────────────────────────────────
export function list(factionId) {
  return (hooks.get(String(factionId)) || []).map(h => ({
    ...h,
    secret: "****" + h.secret.slice(-4), // never expose full secret on read
  }));
}

export function create(factionId, { url, events, description } = {}) {
  const fid = String(factionId);
  if (!url || !/^https:\/\//i.test(url)) throw new Error("https:// URL required");
  if (!Array.isArray(events) || events.length === 0) throw new Error("events array required");
  const wh = {
    id: newId("wh"),
    factionId: fid,
    url,
    secret: crypto.randomBytes(24).toString("hex"),
    events,
    createdAt: Date.now(),
    lastFireAt: 0,
    failCount: 0,
    disabled: false,
    description: description || "",
  };
  if (!hooks.has(fid)) hooks.set(fid, []);
  hooks.get(fid).push(wh);
  save();
  // Return the FULL secret ONCE on creation — caller must save it.
  return wh;
}

export function remove(factionId, id) {
  const fid = String(factionId);
  const list = hooks.get(fid) || [];
  const idx = list.findIndex(h => h.id === id);
  if (idx === -1) return false;
  list.splice(idx, 1);
  save();
  return true;
}

export function reenable(factionId, id) {
  const fid = String(factionId);
  const list = hooks.get(fid) || [];
  const h = list.find(h => h.id === id);
  if (!h) return false;
  h.disabled = false;
  h.failCount = 0;
  save();
  return true;
}

/** Send a test event so the user can verify their receiver. */
export function sendTest(factionId, id) {
  const list = hooks.get(String(factionId)) || [];
  const h = list.find(h => h.id === id);
  if (!h) return false;
  const event = {
    id: newId("evt_test"),
    type: "test.ping",
    factionId: String(factionId),
    occurredAt: Date.now(),
    data: { message: "This is a test event from warboard — if you received it, your webhook is configured correctly." },
  };
  deliver(h, event).catch(() => {});
  return true;
}
