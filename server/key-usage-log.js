/**
 * Key-usage tracker: per-call log for debugging "what is my API key doing?"
 *
 * In-memory ring buffer. Every server-side Torn API call gets logged with
 * the last 4 chars of the key it used (for identification without exposing
 * the secret), the endpoint path, the module that initiated it, and the
 * timestamp. Buffer auto-prunes entries older than 15 minutes so it can't
 * grow unbounded.
 *
 * Retrieval endpoint filters + summarises per caller — e.g.
 *   Last 10 min: 34 calls
 *     xanax-subs   · 2
 *     war-monitor  · 28
 *     oc-spawn-key · 4
 *
 * Intentionally server-side only. Client-side userscript calls go
 * directly from the user's browser to api.torn.com without touching
 * warboard, so we can't see those here; users who want full visibility
 * can filter devtools console on their own machine.
 */

const MAX_AGE_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 5000;

/** @type {Array<{ ts: number, keySuffix: string, endpoint: string, source: string, status?: number }>} */
const buffer = [];

function pruneOldEntries() {
  const cutoff = Date.now() - MAX_AGE_MS;
  while (buffer.length && buffer[0].ts < cutoff) buffer.shift();
  while (buffer.length > MAX_ENTRIES) buffer.shift();
}

/**
 * Called by any module making a Torn API call.
 * @param {string} apiKey     — the full key string (will be masked to last 4)
 * @param {string} endpoint   — URL or short path, will be sanitised
 * @param {string} source     — module/feature name (e.g. "war-monitor")
 * @param {number} [status]   — optional HTTP/API status after the call
 */
export function logCall(apiKey, endpoint, source, status) {
  if (!apiKey) return;
  const keySuffix = String(apiKey).slice(-4);
  // Strip query string except for selection hints to keep logs scannable.
  let path = String(endpoint || "");
  try {
    const u = new URL(path);
    const sel = u.searchParams.get("selections") || u.searchParams.get("cat") || "";
    path = u.pathname + (sel ? ` [${sel}]` : "");
  } catch (_) { /* not a full URL, leave as-is */ }
  buffer.push({ ts: Date.now(), keySuffix, endpoint: path, source, status });
  pruneOldEntries();
}

/**
 * Return entries from the last `windowMin` minutes, optionally filtered
 * by key suffix. Used by the debug UI / endpoint.
 */
export function getRecent(windowMin = 10, keySuffix = null) {
  pruneOldEntries();
  const cutoff = Date.now() - windowMin * 60_000;
  const matches = buffer.filter(e => {
    if (e.ts < cutoff) return false;
    if (keySuffix && e.keySuffix !== keySuffix) return false;
    return true;
  });

  // Aggregate per-source counts for a quick summary.
  const bySource = {};
  for (const e of matches) {
    bySource[e.source] = (bySource[e.source] || 0) + 1;
  }

  return {
    windowMin,
    keySuffix,
    total: matches.length,
    callsPerMin: matches.length / windowMin,
    bySource,
    entries: matches,
  };
}

/** Reset — useful when starting a fresh debug session. */
export function clear() {
  buffer.length = 0;
}
