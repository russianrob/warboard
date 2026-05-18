/**
 * Persistence + lookup for the Status Live Activity push tokens.
 *
 * Parallel to live-activity-tokens.js (chain LA), but keyed by
 * playerId (Status LA is per-player, not per-war). Each row also
 * stores the user's encrypted Torn API key so the background poller
 * can fetch fresh bars + cooldowns to push without needing the iOS
 * app to be running.
 *
 * Privacy: API keys are encrypted at rest via key-encryption.js
 * (server-side master key). Decrypted only at poll time, in memory.
 * Removed entirely on unsubscribe or when the push token goes bad.
 *
 * Removal happens via three paths:
 *   1. Client explicitly unsubscribes when the user taps Stop Live
 *      Activity (or scenePhase backgrounds long enough that ActivityKit
 *      ends the activity).
 *   2. APNs rejects the push with BadDeviceToken / Unregistered →
 *      poller reaps the token on the next send result.
 *   3. Server boot — stale rows older than 24 h are pruned (the LA
 *      itself would have ended after 12 h anyway).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { encrypt, decrypt } from "./key-encryption.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, "data", "status-la-tokens.json");
const MAX_AGE_MS = 24 * 3600 * 1000; // 24h — well past Apple's 12h LA cap

/** Map keyed by playerId → { playerId, playerName, token, apiKeyEnc, addedAt, updatedAt } */
const rows = new Map();
let _loaded = false;

function load() {
  if (_loaded) return;
  _loaded = true;
  try {
    if (!existsSync(FILE)) return;
    const raw = JSON.parse(readFileSync(FILE, "utf-8"));
    if (Array.isArray(raw)) {
      const now = Date.now();
      let kept = 0, expired = 0;
      for (const r of raw) {
        if (!r || !r.playerId || !r.token || !r.apiKeyEnc) continue;
        if (r.addedAt && now - r.addedAt > MAX_AGE_MS) { expired++; continue; }
        rows.set(String(r.playerId), r);
        kept++;
      }
      console.log(`[status-la] Loaded ${kept} Status LA token(s), pruned ${expired} expired`);
    }
  } catch (err) {
    console.error("[status-la] Failed to load tokens:", err.message);
  }
}

function persist() {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(Array.from(rows.values()), null, 2));
  } catch (err) {
    console.error("[status-la] Failed to persist tokens:", err.message);
  }
}

/** Register or refresh a (playerId, token, apiKey) tuple. */
export function upsert({ playerId, playerName, token, apiKey }) {
  load();
  if (!playerId || !token || !apiKey) return false;
  const apiKeyEnc = encrypt(String(apiKey));
  const existing = rows.get(String(playerId));
  rows.set(String(playerId), {
    playerId: String(playerId),
    playerName: String(playerName || existing?.playerName || ""),
    token: String(token),
    apiKeyEnc,
    addedAt: existing?.addedAt || Date.now(),
    updatedAt: Date.now(),
  });
  persist();
  return true;
}

/** Remove a registration. Returns true if a row was removed. */
export function remove({ playerId, token } = {}) {
  load();
  if (playerId && rows.has(String(playerId))) {
    rows.delete(String(playerId));
    persist();
    return true;
  }
  if (token) {
    for (const [pid, r] of rows.entries()) {
      if (r.token === token) {
        rows.delete(pid);
        persist();
        return true;
      }
    }
  }
  return false;
}

/** Snapshot of all rows with decrypted apiKey, for the poller. */
export function listAllDecrypted() {
  load();
  const out = [];
  for (const r of rows.values()) {
    try {
      out.push({
        playerId: r.playerId,
        playerName: r.playerName || "",
        token: r.token,
        apiKey: decrypt(r.apiKeyEnc),
      });
    } catch (e) {
      console.warn(`[status-la] failed to decrypt apiKey for player ${r.playerId}:`, e.message);
    }
  }
  return out;
}

/** Count for diagnostics. */
export function size() { load(); return rows.size; }
