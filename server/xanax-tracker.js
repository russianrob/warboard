/**
 * Per-war xanax accountability tracker.
 *
 * Polls the faction armoury news during an active war, parses entries
 * matching "<player> took N x Xanax from the armoury", and accumulates
 * a per-(warId, playerId) count of xanax pulled during the war window.
 *
 * Combined with the per-member attack counts already produced by the
 * post-war report, lets a leader see who took war drugs without
 * delivering the expected attacks (1 xanax = ~250 energy = 10 war
 * attacks at 25 e each, so the rule of thumb the user picked is
 * `expected_attacks = xanax_taken * 10`).
 *
 * Polling cadence: every 5 minutes per active war. Uses pool keys via
 * store.getPollingKey so the load spreads across faction members.
 *
 * Persistence: writes to war.xanaxStats = {
 *   lastPolledAt: unix_seconds,
 *   taken:        { [playerId]: count },
 *   names:        { [playerId]: lastSeenPlayerName },
 *   entryCount:   total armory entries observed,
 * }
 * via store.saveState(). Survives pm2 reloads.
 */

import * as store from "./store.js";
import { fetchFactionArmouryNews } from "./torn-api.js";

const POLL_INTERVAL_MS = 5 * 60 * 1000;     // 5 min
const MAX_BACKOFF_MS   = 30 * 60 * 1000;    // 30 min cap on retry backoff

/** Per-warId timeout handles so we can cancel cleanly. */
const timers   = new Map();
/** Per-warId pool-key cursor (round-robin across faction keys). */
const cursors  = new Map();
/** Per-warId backoff in ms after consecutive failures. */
const backoffs = new Map();

/**
 * Match every "took N x Xanax from the armoury" event in a faction
 * news string. Tolerates pluralisation, missing "x", and
 * case-insensitive Xanax. Returns array of { playerId, playerName, qty }.
 *
 * Torn news format examples (HTML):
 *   <a href = "https://www.torn.com/profiles.php?XID=12345">Foo</a> took 2 x Xanax from their faction armoury
 *   <a href = "https://www.torn.com/profiles.php?XID=12345">Foo</a> took 1 of Xanax from their faction armoury
 */
const TOOK_XANAX_RE = /<a[^>]*XID=(\d+)[^>]*>([^<]+)<\/a>\s+took\s+(\d+)\s+(?:x|of)\s+Xanax/i;
function parseXanaxEntry(news) {
  if (!news || typeof news !== "string") return null;
  const m = news.match(TOOK_XANAX_RE);
  if (!m) return null;
  return {
    playerId: m[1],
    playerName: m[2].trim(),
    qty: Number(m[3]) || 0,
  };
}

/**
 * Begin polling armoury news for this war. Idempotent — calling twice
 * is a no-op once the timer is registered. Stops automatically when
 * the war's warEnded flag flips true.
 */
export function startXanaxTracker(warId) {
  if (!warId || timers.has(warId)) return;

  const tick = async () => {
    const war = store.getWar(warId);
    if (!war || !war.factionId || war.warEnded) {
      // If war ended, do one final flush before stopping so the late
      // entries (people taking xanax in the last 5 minutes) still land
      // in the post-war report. Then unregister.
      if (war?.warEnded) {
        await pollOnce(warId).catch(() => {});
        stopXanaxTracker(warId);
        return;
      }
      // No war record yet — try again in a minute.
      timers.set(warId, setTimeout(tick, 60_000));
      return;
    }

    let nextDelay = POLL_INTERVAL_MS;
    try {
      await pollOnce(warId);
      backoffs.delete(warId);
    } catch (err) {
      const cur = backoffs.get(warId) || POLL_INTERVAL_MS;
      const next = Math.min(cur * 2, MAX_BACKOFF_MS);
      backoffs.set(warId, next);
      nextDelay = next;
      console.warn(`[xanax-tracker] war ${warId}: poll failed (${err.message}); retry in ${Math.round(next/1000)}s`);
    }
    timers.set(warId, setTimeout(tick, nextDelay));
  };

  // Kick off immediately so the first window of news is captured
  // without waiting 5 min — useful when a war is detected mid-flight
  // (start-of-tracker = several minutes after war start).
  timers.set(warId, setTimeout(tick, 1_000));
  console.log(`[xanax-tracker] Started for war ${warId} (poll every ${POLL_INTERVAL_MS/1000}s)`);
}

/** Cancel polling for this warId. Idempotent. */
export function stopXanaxTracker(warId) {
  const t = timers.get(warId);
  if (t) clearTimeout(t);
  timers.delete(warId);
  cursors.delete(warId);
  backoffs.delete(warId);
  console.log(`[xanax-tracker] Stopped for war ${warId}`);
}

/** Stop every active tracker (graceful shutdown). */
export function stopAll() {
  for (const [warId, t] of timers) {
    clearTimeout(t);
    console.log(`[xanax-tracker] Stopped for war ${warId}`);
  }
  timers.clear();
  cursors.clear();
  backoffs.clear();
}

/**
 * Read the current accumulated stats for a war. Empty object if the
 * war has no record or no tracker has run yet. Safe to call from the
 * post-war report endpoint regardless of whether the tracker is alive.
 */
export function getStats(warId) {
  const war = store.getWar(warId);
  if (!war || !war.xanaxStats) {
    return { lastPolledAt: 0, taken: {}, names: {}, entryCount: 0 };
  }
  return {
    lastPolledAt: war.xanaxStats.lastPolledAt || 0,
    taken:        war.xanaxStats.taken        || {},
    names:        war.xanaxStats.names        || {},
    entryCount:   war.xanaxStats.entryCount   || 0,
  };
}

/**
 * One round of polling. Fetches armoury news from `lastPolledAt`
 * onward (or from war.warStart if first run), parses xanax events,
 * and merges into war.xanaxStats. Throws on API failures so the
 * caller's backoff logic kicks in.
 */
async function pollOnce(warId) {
  const war = store.getWar(warId);
  if (!war || !war.factionId) throw new Error("no war or factionId");

  const cursor = (cursors.get(warId) || 0) + 1;
  cursors.set(warId, cursor);
  const apiKey = store.getPollingKey(war.factionId, "xanax-tracker", cursor);
  if (!apiKey) throw new Error("no pool key available");

  const stats = war.xanaxStats || { lastPolledAt: 0, taken: {}, names: {}, entryCount: 0 };
  const fromTs = stats.lastPolledAt || war.warStart || (Math.floor(Date.now()/1000) - 3600);

  const entries = await fetchFactionArmouryNews(war.factionId, apiKey, fromTs);
  let newCount = 0;
  let highestTs = stats.lastPolledAt;
  for (const e of entries) {
    if (e.timestamp <= stats.lastPolledAt) continue;
    if (e.timestamp > highestTs) highestTs = e.timestamp;
    stats.entryCount++;
    const parsed = parseXanaxEntry(e.news);
    if (!parsed) continue;
    stats.taken[parsed.playerId] = (stats.taken[parsed.playerId] || 0) + parsed.qty;
    stats.names[parsed.playerId] = parsed.playerName;
    newCount += parsed.qty;
  }
  stats.lastPolledAt = highestTs || Math.floor(Date.now()/1000);
  war.xanaxStats = stats;
  store.saveState();

  if (newCount > 0) {
    console.log(`[xanax-tracker] war ${warId}: +${newCount} xanax across ${entries.length} new entry(s)`);
  }
}

// Exported for unit-style testing of the regex from elsewhere if ever
// useful. Not used by production code paths.
export const _internal = { parseXanaxEntry, TOOK_XANAX_RE };
