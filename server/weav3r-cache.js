/**
 * Weav3r dollar-bazaar deals — server-side cache + SSE broadcast.
 *
 * One background poller hits weav3r.dev every ~30s for all warboard users.
 * Connected userscripts subscribe via SSE and get the current snapshot
 * immediately on connect + live pushes when the cache updates.
 *
 * Cuts client-side load time from 15-20s (per user) to <100ms (cache hit)
 * and reduces total hits on weav3r.dev by 1 per user per refresh.
 */
import { EventEmitter } from 'node:events';

// Interval between weav3r fetches. Configurable via env so we can tune
// without redeploying if weav3r starts rate-limiting or if we want fresher
// data. Default 15s — quarter-minute latency for new $1 listings without
// hammering their API.
const POLL_INTERVAL_MS = Number(process.env.WEAV3R_POLL_MS) || 15_000;
const STALE_MS         = POLL_INTERVAL_MS * 3;   // 3 missed polls = stale
const PAGES            = 4;
const PAGE_SIZE        = 50;

// Freshness filter: drop listings whose `lastUpdated` is older than this
// many milliseconds. Weav3r rotates through sellers, so old entries are
// very likely items already sold or pulled. Default 60 min — tunable via env.
const MAX_ITEM_AGE_MS  = Number(process.env.WEAV3R_MAX_AGE_MS) || 60 * 60 * 1000;

// Server-side verification: query each unique seller's bazaar via OWNER_API_KEY,
// mark each weav3r listing as verified/gone, cache in the served snapshot so
// clients don't have to verify themselves. Rate-limited to 60 calls/min to
// stay under Torn's 100/min budget with headroom for spawn-assistance etc.
//
// Disabled by default: verify burns ~60% of OWNER_API_KEY's 100/min budget
// and the user-facing feed is fine without it (items just show verified:null
// and let the client decide whether to display them). Flip WEAV3R_VERIFY=1
// in the environment to re-enable.
const OWNER_API_KEY         = process.env.OWNER_API_KEY || '';
const VERIFY_ENABLED        = process.env.WEAV3R_VERIFY === '1';
const VERIFY_RATE_PER_MIN   = 60;
const VERIFY_INTERVAL_MS    = 60_000 / VERIFY_RATE_PER_MIN;
const VERIFY_CACHE_TTL_MS   = 5 * 60 * 1000;
// Fall back to per-seller verification. torn/<id>?selections=bazaar needs
// an API Access upgrade we don't have, so item-level isn't possible. Per-
// seller catches sold/removed items but can't distinguish target trades.
let verifyQueue = [];          // sellerId strings pending verification
let verifyTimer = null;
let verifyPausedUntil = 0;     // ms epoch. While now < this, no verify calls fire.
let verifyCache = new Map();   // sellerId -> { ts, bazaar: [{ID, price, quantity}] }

const UA = 'warboard/1.0 (+https://tornwar.com)';
const bus = new EventEmitter();
bus.setMaxListeners(0);               // unbounded SSE subscribers

let cache = {
    items:    [],
    ts:       0,       // ms epoch of last successful fetch
    error:    null,    // error string if last fetch failed
};

let timer = null;
let inFlight = false;

// Exponential backoff on HTTP 429 / 5xx. Start at configured poll interval,
// double on each rate-limit or server error (up to 5 min cap), reset to base
// after a successful fetch. Automatic protection against weav3r complaining.
const MAX_BACKOFF_MS = 5 * 60 * 1000;    // 5 minutes max between polls under backoff
let currentBackoffMs = POLL_INTERVAL_MS; // starts at base, grows on errors

async function fetchPage(page) {
    const url = `https://weav3r.dev/api/dollar-bazaars/items?page=${page}&limit=${PAGE_SIZE}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return (await res.json()).items || [];
}

async function refresh() {
    if (inFlight) return;
    inFlight = true;
    try {
        const all = [];
        for (let p = 1; p <= PAGES; p++) {
            const items = await fetchPage(p);
            if (!items.length) break;
            all.push(...items);
            if (items.length < PAGE_SIZE) break;
        }

        // Drop stale listings. Weav3r rotates through sellers on a slow
        // schedule, so an entry with a `lastUpdated` 4 hours ago is very
        // likely a ghost — the seller has sold or pulled the item since.
        // Keeps only items crawled within MAX_ITEM_AGE_MS.
        const cutoff = Date.now() - MAX_ITEM_AGE_MS;
        const fresh = all.filter(item => {
            if (!item.lastUpdated) return true;          // keep if unknown
            const ts = Date.parse(item.lastUpdated);
            if (!isFinite(ts)) return true;
            return ts >= cutoff;
        });
        const droppedStale = all.length - fresh.length;

        fresh.sort((a, b) => (b.marketPrice || 0) - (a.marketPrice || 0));

        for (const item of fresh) {
            const vr = verifyCache.get(String(item.playerId));
            if (!vr || (Date.now() - vr.ts) > VERIFY_CACHE_TTL_MS) {
                item.verified = null;
            } else {
                item.verified = vr.bazaar.some(b =>
                    String(b.ID ?? b.id) === String(item.itemId) && Number(b.price) === 1
                );
            }
        }
        cache = { items: fresh, ts: Date.now(), error: null, droppedStale };
        enqueueSellers(fresh);
        bus.emit('deals', cache);
        // On success, reset backoff to base.
        const ageSummary = droppedStale > 0
            ? `${fresh.length} fresh, ${droppedStale} stale dropped`
            : `${fresh.length} deal(s)`;
        if (currentBackoffMs !== POLL_INTERVAL_MS) {
            console.log(`[weav3r-cache] refreshed ${ageSummary}; backoff reset ${currentBackoffMs}ms → ${POLL_INTERVAL_MS}ms`);
            currentBackoffMs = POLL_INTERVAL_MS;
        } else {
            console.log(`[weav3r-cache] refreshed ${ageSummary}`);
        }
    } catch (e) {
        cache = { ...cache, error: e.message };
        bus.emit('deals', cache);
        const isRateLimit = e.status === 429;
        const isServerErr = e.status >= 500 && e.status < 600;
        if (isRateLimit || isServerErr) {
            currentBackoffMs = Math.min(currentBackoffMs * 2, MAX_BACKOFF_MS);
            console.warn(`[weav3r-cache] ${e.message} — backoff → ${currentBackoffMs}ms`);
        } else {
            console.warn(`[weav3r-cache] refresh failed: ${e.message}`);
        }
    } finally {
        inFlight = false;
        // Schedule next poll using current backoff (base when healthy, grown
        // while rate-limited). Lets us change cadence dynamically without
        // needing clearInterval/setInterval juggling.
        if (timer !== null) {   // not stopped
            timer = setTimeout(refresh, currentBackoffMs);
        }
    }
}

function enqueueSellers(items) {
    if (!VERIFY_ENABLED) return;
    if (!OWNER_API_KEY) return;
    const now = Date.now();
    const seen = new Set(verifyQueue);
    for (const item of items) {
        const sid = String(item.playerId);
        const cached = verifyCache.get(sid);
        if (cached && (now - cached.ts) < VERIFY_CACHE_TTL_MS) continue;
        if (seen.has(sid)) continue;
        seen.add(sid);
        verifyQueue.push(sid);
    }
    scheduleVerify();
}

function scheduleVerify() {
    if (verifyTimer || verifyQueue.length === 0) return;
    // Respect the rate-limit pause. enqueueSellers() fires on every
    // weav3r refresh (~15s), which previously clobbered the 60s pause
    // because the bare setTimeout didn't populate verifyTimer.
    const wait = Math.max(VERIFY_INTERVAL_MS, verifyPausedUntil - Date.now());
    verifyTimer = setTimeout(runVerify, wait);
}

async function runVerify() {
    verifyTimer = null;
    if (verifyQueue.length === 0) return;
    const sid = verifyQueue.shift();
    try {
        const url = `https://api.torn.com/user/${sid}?selections=bazaar&key=${encodeURIComponent(OWNER_API_KEY)}`;
        const res = await fetch(url, { headers: { 'User-Agent': UA } });
        const data = await res.json();
        if (data.error) {
            if (data.error.code === 5) {
                // Only log when entering a new pause window, not on every
                // 429 that arrives while already paused — keeps the log
                // readable instead of 400+ identical lines per hour.
                const now = Date.now();
                if (now >= verifyPausedUntil) {
                    console.warn(`[weav3r-cache] verify rate-limited, pausing 60s`);
                }
                verifyPausedUntil = now + 60_000;
                verifyQueue.unshift(sid);
                scheduleVerify();
                return;
            }
            verifyCache.set(sid, { ts: Date.now(), bazaar: [] });
        } else {
            const bazaar = Array.isArray(data.bazaar)
                ? data.bazaar
                : (data.bazaar ? Object.values(data.bazaar) : []);
            verifyCache.set(sid, { ts: Date.now(), bazaar });
        }

        const vr = verifyCache.get(sid);
        let changed = false;
        for (const item of cache.items) {
            if (String(item.playerId) !== sid) continue;
            const newVerified = vr.bazaar.some(
                b => String(b.ID ?? b.id) === String(item.itemId) && Number(b.price) === 1
            );
            if (item.verified !== newVerified) {
                item.verified = newVerified;
                changed = true;
            }
        }
        if (changed) bus.emit('deals', cache);
    } catch (e) {
        verifyCache.set(sid, { ts: Date.now(), bazaar: [] });
    }
    scheduleVerify();
}

export function startWeav3rCache() {
    if (timer) return;
    timer = -1;   // sentinel: "running but not yet scheduled"
    refresh();
}

export function stopWeav3rCache() {
    if (timer && timer !== -1) clearTimeout(timer);
    timer = null;
    if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = null; }
    verifyQueue = [];
}

export function getWeav3rSnapshot() {
    return {
        items: cache.items,
        ts:    cache.ts,
        error: cache.error,
        stale: cache.ts === 0 || (Date.now() - cache.ts) > STALE_MS,
    };
}

export function subscribeToWeav3r(listener) {
    bus.on('deals', listener);
    return () => bus.off('deals', listener);
}
