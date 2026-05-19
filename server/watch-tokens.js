/**
 * Persistence + lookup for Apple Watch APNs push tokens.
 *
 * Parallel to status-la-tokens.js but for the WatchOS app's own
 * device token (which the iPhone's LA token can't be reused for —
 * APNs treats watch + phone as separate destinations).
 *
 * Storage key: playerId (one watch per player). Each row carries the
 * watch's APNs hex token + the user's encrypted Torn API key (so the
 * existing 5-min status-la-poller can fetch bars/cooldowns for the
 * watch push without the iPhone app being foregrounded).
 *
 * The status LA poller pushes to BOTH the LA token (lock-screen
 * Live Activity) AND the watch token (background push → complication
 * timeline reload) in a single iteration when both are subscribed.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { encrypt, decrypt } from "./key-encryption.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, "data", "watch-tokens.json");
const MAX_AGE_MS = 30 * 24 * 3600 * 1000; // 30 days — watch tokens are long-lived

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
      console.log(`[watch-tokens] loaded ${kept} rows (${expired} expired)`);
    }
  } catch (e) {
    console.warn("[watch-tokens] load error:", e.message);
  }
}

function persist() {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(Array.from(rows.values()), null, 2));
  } catch (e) {
    console.warn("[watch-tokens] persist error:", e.message);
  }
}

export function upsert({ playerId, playerName, token, apiKey }) {
  load();
  const pid = String(playerId);
  const existing = rows.get(pid) || {};
  rows.set(pid, {
    playerId: pid,
    playerName: playerName || existing.playerName || "",
    token: String(token),
    apiKeyEnc: encrypt(String(apiKey)),
    addedAt: existing.addedAt || Date.now(),
    updatedAt: Date.now(),
  });
  persist();
}

export function remove({ playerId, token } = {}) {
  load();
  if (playerId) { rows.delete(String(playerId)); persist(); return; }
  if (token) {
    for (const [pid, r] of rows.entries()) {
      if (r.token === token) { rows.delete(pid); break; }
    }
    persist();
  }
}

export function listAllDecrypted() {
  load();
  const out = [];
  for (const r of rows.values()) {
    try {
      out.push({ ...r, apiKey: decrypt(r.apiKeyEnc) });
    } catch (e) {
      console.warn(`[watch-tokens] decrypt failed for ${r.playerId}: ${e.message}`);
    }
  }
  return out;
}

/** Get the watch token for a single player, decrypted. Null if absent. */
export function getForPlayer(playerId) {
  load();
  const r = rows.get(String(playerId));
  if (!r) return null;
  try { return { ...r, apiKey: decrypt(r.apiKeyEnc) }; }
  catch (e) { console.warn(`[watch-tokens] decrypt failed for ${r.playerId}: ${e.message}`); return null; }
}

export function size() { load(); return rows.size; }
