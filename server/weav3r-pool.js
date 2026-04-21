/**
 * Weav3r verify-key pool.
 *
 * Instead of burning OWNER_API_KEY's 100/min budget on seller-bazaar
 * verification, pool opted-in users' keys and rotate through them via
 * least-recently-used. Verify queries are `user/<id>?selections=bazaar`
 * — a fully public Torn selection, so pooling these keys leaks no
 * scoped data (any key of any tier can read any player's public bazaar).
 *
 * Opt-in is default-on when a user saves their key in the Weav3r Bazaar
 * Deals userscript settings; explicit opt-out via the same UI removes
 * their key from the pool.
 *
 * Per-key rate tracking: each key capped at 60 calls/min locally. A key
 * returning 429 three times in a row is auto-removed (likely revoked or
 * tier-downgraded).
 */

import fs from "node:fs";
import path from "node:path";

const DATA_DIR  = process.env.DATA_DIR || "./data";
const POOL_FILE = path.join(DATA_DIR, "weav3r-pool.json");

// Per-key call-rate tracking (in-memory only; resets on restart).
const MAX_CALLS_PER_MIN = 60;
const MAX_FAIL_COUNT    = 3;

/** playerId → { apiKey, optedAt, lastUsedAt, failCount } */
const pool = new Map();

/** playerId → array of timestamps (ms) of recent calls, pruned to last 60s */
const callTimes = new Map();

function loadPool() {
  try {
    const raw = fs.readFileSync(POOL_FILE, "utf8");
    const obj = JSON.parse(raw);
    for (const [pid, rec] of Object.entries(obj || {})) {
      if (rec && typeof rec.apiKey === "string" && rec.apiKey.length > 8) {
        pool.set(String(pid), {
          apiKey:     rec.apiKey,
          optedAt:    Number(rec.optedAt) || Date.now(),
          lastUsedAt: Number(rec.lastUsedAt) || 0,
          failCount:  0, // reset per boot
        });
      }
    }
  } catch (_) { /* missing/empty is fine */ }
}

function savePool() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const out = {};
    for (const [pid, rec] of pool) {
      out[pid] = {
        apiKey:     rec.apiKey,
        optedAt:    rec.optedAt,
        lastUsedAt: rec.lastUsedAt,
      };
    }
    fs.writeFileSync(POOL_FILE, JSON.stringify(out, null, 2), "utf8");
  } catch (e) {
    console.warn("[weav3r-pool] save failed:", e.message);
  }
}

loadPool();

/** Add or update a key. Silently overwrites an existing entry for the same pid. */
export function addKey(playerId, apiKey) {
  if (!playerId || !apiKey) return;
  pool.set(String(playerId), {
    apiKey:     String(apiKey),
    optedAt:    Date.now(),
    lastUsedAt: 0,
    failCount:  0,
  });
  savePool();
}

export function removeKey(playerId) {
  if (pool.delete(String(playerId))) {
    callTimes.delete(String(playerId));
    savePool();
  }
}

export function hasKey(playerId) {
  return pool.has(String(playerId));
}

export function size() {
  return pool.size;
}

/** Prune call-time buffer for a player to only the last 60 seconds. */
function pruneTimes(pid) {
  const now = Date.now();
  const arr = callTimes.get(pid);
  if (!arr) return [];
  const cutoff = now - 60_000;
  let i = 0;
  while (i < arr.length && arr[i] < cutoff) i++;
  if (i > 0) arr.splice(0, i);
  return arr;
}

/**
 * Pick the least-recently-used healthy key that's under its per-key budget.
 * Returns { playerId, apiKey } or null if the pool is empty / all saturated.
 */
export function pickKey() {
  if (pool.size === 0) return null;
  // Sort by lastUsedAt ascending so oldest-used is tried first.
  const ordered = [...pool.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  for (const [pid, rec] of ordered) {
    if (rec.failCount >= MAX_FAIL_COUNT) continue; // should already be gone
    const arr = pruneTimes(pid);
    if (arr.length >= MAX_CALLS_PER_MIN) continue;
    return { playerId: pid, apiKey: rec.apiKey };
  }
  return null;
}

/** Record a successful (or at least non-failure) call against a pool key. */
export function markUsed(playerId) {
  const pid = String(playerId);
  const rec = pool.get(pid);
  if (!rec) return;
  rec.lastUsedAt = Date.now();
  rec.failCount  = 0;
  const arr = callTimes.get(pid) || [];
  arr.push(Date.now());
  callTimes.set(pid, arr);
  // Don't savePool on every call — too much disk churn. State is fine
  // until next explicit change.
}

/**
 * Record a failure. On MAX_FAIL_COUNT consecutive failures the key is
 * auto-removed (likely revoked/expired). Rate-limit (code 5) doesn't
 * count as a failure — that's Torn throttling us, not a dead key.
 */
export function markFailure(playerId, isRateLimit = false) {
  const pid = String(playerId);
  const rec = pool.get(pid);
  if (!rec) return;
  if (isRateLimit) return;
  rec.failCount = (rec.failCount || 0) + 1;
  if (rec.failCount >= MAX_FAIL_COUNT) {
    console.warn(`[weav3r-pool] dropping key for ${pid} after ${rec.failCount} failures`);
    removeKey(pid);
  }
}

/** Summary for admin/debug endpoints. */
export function getSummary() {
  const now = Date.now();
  const entries = [...pool.entries()].map(([pid, rec]) => ({
    playerId: pid,
    optedAt:  rec.optedAt,
    lastUsedAt: rec.lastUsedAt,
    failCount:  rec.failCount,
    callsLast60s: pruneTimes(pid).length,
    secondsSinceUse: rec.lastUsedAt ? Math.round((now - rec.lastUsedAt) / 1000) : null,
  }));
  return {
    size: pool.size,
    entries,
  };
}
