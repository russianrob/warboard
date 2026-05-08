/**
 * Persistence + lookup for iOS Live Activity push tokens.
 *
 * Each row records which (warId × playerId × deviceToken) is currently
 * active so the chain monitor knows who to push when chain state
 * changes. Distinct from /api/apns/subscribe (which stores long-lived
 * device push tokens for regular notifications) — Live Activity tokens
 * are ephemeral and tied to a specific warId.
 *
 * One device may carry one active token per warId; a fresh registration
 * on the same (warId, playerId) replaces any prior token for that pair
 * (Apple invalidates the old one once the activity is restarted).
 *
 * Removal happens via three paths:
 *   1. Client explicitly unsubscribes when its activity ends
 *   2. APNs rejects the push with BadDeviceToken / Unregistered → server
 *      reaps the token from the next send result
 *   3. War ends → chain monitor flushes all tokens for that warId
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, "data", "live-activity-tokens.json");

/** Map keyed by `${warId}|${playerId}` → { warId, playerId, token, addedAt } */
const tokens = new Map();

function load() {
  try {
    if (!existsSync(FILE)) return;
    const raw = JSON.parse(readFileSync(FILE, "utf-8"));
    if (Array.isArray(raw)) {
      for (const r of raw) {
        if (r && r.warId && r.playerId && r.token) {
          tokens.set(`${r.warId}|${r.playerId}`, r);
        }
      }
      console.log(`[live-activity] Loaded ${tokens.size} chain Live Activity token(s)`);
    }
  } catch (err) {
    console.error("[live-activity] Failed to load tokens:", err.message);
  }
}

function persist() {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(Array.from(tokens.values()), null, 2));
  } catch (err) {
    console.error("[live-activity] Failed to persist tokens:", err.message);
  }
}

load();

/** Register or update a token. Returns the row that was stored. */
export function upsert({ warId, playerId, token }) {
  if (!warId || !playerId || !token) return null;
  const row = {
    warId: String(warId),
    playerId: String(playerId),
    token: String(token),
    addedAt: Date.now(),
  };
  tokens.set(`${row.warId}|${row.playerId}`, row);
  persist();
  return row;
}

/** Drop the token for a (warId, playerId) pair. Idempotent. */
export function remove({ warId, playerId }) {
  if (!warId || !playerId) return false;
  const key = `${warId}|${playerId}`;
  if (!tokens.has(key)) return false;
  tokens.delete(key);
  persist();
  return true;
}

/** Drop a token by its hex value (used after APNs rejects it). */
export function removeByToken(token) {
  if (!token) return 0;
  let dropped = 0;
  for (const [key, row] of tokens) {
    if (row.token === token) {
      tokens.delete(key);
      dropped++;
    }
  }
  if (dropped > 0) persist();
  return dropped;
}

/** All tokens registered against the given warId. */
export function listForWar(warId) {
  if (!warId) return [];
  const wid = String(warId);
  const out = [];
  for (const row of tokens.values()) {
    if (row.warId === wid) out.push(row);
  }
  return out;
}

/** Drop every token for a warId. Called when the war ends. */
export function clearWar(warId) {
  if (!warId) return 0;
  const wid = String(warId);
  let dropped = 0;
  for (const [key, row] of tokens) {
    if (row.warId === wid) {
      tokens.delete(key);
      dropped++;
    }
  }
  if (dropped > 0) persist();
  return dropped;
}

/** For diagnostics — total token count across all wars. */
export function size() {
  return tokens.size;
}
