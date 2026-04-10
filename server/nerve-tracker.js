/**
 * Nerve Tracker — server-side NNB monitoring.
 *
 * Polls the Torn API every 30 minutes for nerve bar data.
 * Detects NNB (Natural Nerve Bar) increases by tracking nerve.maximum
 * minus the configured faction offset. Stores full history so the
 * CE/Nerve userscript can display real trends without needing an API
 * key in the browser.
 *
 * Data file: data/nerve-history.json
 * Endpoints (registered in routes.js):
 *   GET  /api/nerve-tracker         — current state + history
 *   POST /api/nerve-tracker/config  — update apiKey / factionOffset
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = join(__dirname, "data");
const DATA_FILE = join(DATA_DIR, "nerve-history.json");

const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// ── State ──────────────────────────────────────────────────────────────────

/** @type {NerveState} */
let state = {
    apiKey:        process.env.NERVE_TRACKER_KEY || process.env.OWNER_API_KEY || null,
    factionOffset: 7,           // nerve from faction perks — subtract to get base NNB
    nerveMax:      null,        // last known raw nerve max
    baseNNB:       null,        // nerveMax - factionOffset
    lastUpdated:   null,        // Unix timestamp of last successful poll
    // history: one entry per poll — compact ring buffer (max 2016 = 6 weeks of 30-min polls)
    history: [],
    // nnbChanges: logged every time base NNB changes by any amount
    nnbChanges: [],
    totalCrimes:   null,        // personalstats.criminaloffenses at last poll
    crimeChain:    0,           // current chain calculated from crime logs
    bustStats:     null,        // bust CE stats from cat=29 logs
    crimeHistoryStats: null,   // historical CE stats per crime type
    lastNNBIncreaseAt: 1768866000, // Unix timestamp of last confirmed NNB +5 (Jan 19 2026)
};

let pollTimer = null;

// ── Persistence ───────────────────────────────────────────────────────────

function load() {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    if (!existsSync(DATA_FILE)) return;
    try {
        const raw = JSON.parse(readFileSync(DATA_FILE, "utf8"));
        // Merge saved values, keeping env-provided apiKey as override
        state = {
            ...raw,
            apiKey: process.env.NERVE_TRACKER_KEY || raw.apiKey || process.env.OWNER_API_KEY || null,
        };
        console.log("[NerveTracker] Loaded history —",
            state.history.length, "poll entries,",
            state.nnbChanges.length, "NNB change events.",
            `Base NNB: ${state.baseNNB ?? "unknown"}`
        );
    } catch (e) {
        console.error("[NerveTracker] Failed to load data file:", e.message);
    }
}

function save() {
    try {
        writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), "utf8");
    } catch (e) {
        console.error("[NerveTracker] Failed to save:", e.message);
    }
}

// ── Torn API call ──────────────────────────────────────────────────────────

async function fetchNerveData(apiKey) {
    const url = `https://api.torn.com/user/?selections=bars,personalstats&key=${encodeURIComponent(apiKey)}`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`Torn API: ${data.error.error} (code ${data.error.code})`);
    return {
        nerveMax:    data.nerve?.maximum ?? null,
        totalCrimes: data.personalstats?.criminaloffenses ?? null,
    };
}




// ── Crime type from action keyword ──────────────────────────────────────────
function crimeTypeFromAction(action) {
    const a = (action || '').toLowerCase();
    if (a.includes('passport') || a.includes('forgery') || a.includes('forging'))  return 'Forgery';
    if (a.includes('graffiti') || a.includes('spray') || a.includes('tag'))        return 'Graffiti';
    if (a.includes('bury') || a.includes('sink') || a.includes('general waste') ||
        a.includes('building debris') || a.includes('old furniture') ||
        a.includes('dead body') || a.includes('body parts') ||
        a.includes('firearm') || a.includes('murder weapon') ||
        a.includes('dispose') || a.includes('vehicle'))                            return 'Disposal';
    if (a.includes('crack') || a.includes('password') ||
        a.includes('safe') || a.includes('lock'))                                  return 'Cracking';
    if (a.includes('shoplift') || a.includes('jacket') || a.includes('shop'))      return 'Shoplifting';
    if (a.includes('arson') || a.includes('torch') ||
        a.includes('fire') || a.includes('warehouse'))                             return 'Arson';
    if (a.includes('scam') || a.includes('fraud'))                                 return 'Scamming';
    if (a.includes('pickpocket') || a.includes('pocket') || a.includes('wallet'))  return 'Pickpocketing';
    if (a.includes('hustle') || a.includes('hustling'))                            return 'Hustling';
    if (a.includes('bootleg'))                                                     return 'Bootlegging';
    if (a.includes('search') || a.includes('look for cash'))                       return 'Search for Cash';
    if (a.includes('burglar') || a.includes('burglary') || a.includes('break in')) return 'Burglary';
    if (a.includes('card') || a.includes('skim'))                                  return 'Card Skimming';
    if (a.includes('murder') || a.includes('kill') || a.includes('assassin'))      return 'Murder';
    if (a.includes('vandal') || a.includes('vandalism'))                           return 'Vandalism';
    return null;
}

// ── Historical crime stats from log ─────────────────────────────────────────
// Fetches up to `pages` pages of cat=136 crime log and aggregates per crime type.
async function getCrimeHistoryStats(apiKey, sinceTs) {
    const fetchPage = async (to) => {
        const p = new URLSearchParams({ selections: 'log', cat: '136', key: apiKey });
        if (to) p.set('to', String(to));
        const res  = await fetch(`https://api.torn.com/user/?${p}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error.error);
        return data.log ? Object.values(data.log) : [];
    };

    const stats = {};  // { typeName: { name, attempts, successes, failures, criticals, totalNerveSpent } }
    let toTs = null;

    for (let i = 0; i < 200; i++) {  // hard cap 200 pages (~20k crimes)
        const batch = await fetchPage(toTs);
        if (!batch.length) break;

        // Stop once all entries in this page are older than sinceTs
        const newest = batch.reduce((max, e) => Math.max(max, e.timestamp), 0);
        const oldest = batch.reduce((min, e) => Math.min(min, e.timestamp), Infinity);
        if (sinceTs && oldest < sinceTs) {
            // Process only entries within range, then stop
            const inRange = batch.filter(e => e.timestamp >= sinceTs);
            if (!inRange.length) break;
        }

        for (const e of batch) {
            if (sinceTs && e.timestamp < sinceTs) continue;  // skip older entries
            const d      = e.data || {};
            const action = d.crime_action;
            const nerve  = d.nerve;
            const title  = (e.title || '').toLowerCase();

            if (!action || nerve == null) continue;
            if (title.includes('use items')) continue;  // skip material-use events

            const typeName = crimeTypeFromAction(action);
            if (!typeName) continue;

            if (!stats[typeName]) stats[typeName] = {
                name: typeName, attempts: 0, successes: 0,
                failures: 0, criticals: 0, totalNerveSpent: 0,
            };
            const s = stats[typeName];
            s.attempts++;
            s.totalNerveSpent += nerve;
            if (title.includes('critical fail'))    s.criticals++;
            else if (title.includes('fail'))         s.failures++;
            else if (title.includes('success'))      s.successes++;
        }

        const sorted = batch.sort((a, b) => a.timestamp - b.timestamp);
        const oldestInBatch = sorted[0].timestamp;
        if (sinceTs && oldestInBatch < sinceTs) break;  // gone past the cutoff
        toTs = oldestInBatch - 1;
        await new Promise(r => setTimeout(r, 350));
    }

    // Add CE score to each entry
    for (const s of Object.values(stats)) {
        s.sr      = s.attempts > 0 ? s.successes / s.attempts : 0;
        s.avgNerve = s.attempts > 0 ? s.totalNerveSpent / s.attempts : 0;
        s.ceScore  = s.sr * s.avgNerve;
    }

    return stats;
}

// ── Bust stats ──────────────────────────────────────────────────────────────
// Busts appear in cat=29 (Nerve) log with logtype 5360 (success) / 5362 (failure)
async function getBustStats(apiKey) {
    const fetchPage = async (to) => {
        const p = new URLSearchParams({ selections: 'log', cat: '29', key: apiKey });
        if (to) p.set('to', String(to));
        const res  = await fetch(`https://api.torn.com/user/?${p}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error.error);
        if (!data.log) return [];
        return Object.values(data.log)
            .filter(e => e.log === 5360 || e.log === 5362);
    };

    // Fetch last 5 pages (~500 busts) — enough for a reliable sample
    let all = [];
    let toTs = null;
    for (let i = 0; i < 5; i++) {
        const batch = await fetchPage(toTs);
        if (!batch.length) break;
        all = [...all, ...batch];
        toTs = batch.reduce((min, e) => Math.min(min, e.timestamp), Infinity) - 1;
        await new Promise(r => setTimeout(r, 350));
    }

    if (!all.length) return null;

    let successes = 0, failures = 0, totalNerve = 0;
    for (const e of all) {
        const nerve = e.data?.nerve_used ?? e.data?.nerve ?? 5;
        totalNerve += nerve;
        if (e.log === 5360) successes++;
        else failures++;
    }
    const attempts = successes + failures;
    const sr       = successes / attempts;
    const avgNerve = totalNerve / attempts;
    return {
        typeID:          'busting',
        name:            'Busting',
        attempts,
        successes,
        failures,
        criticals:       0,
        totalNerveSpent: totalNerve,
        sr,
        avgNerve,
        ceScore:         sr * avgNerve,
    };
}

// ── Chain calculation ──────────────────────────────────────────────────────
async function calculateChain(apiKey) {
    const fetchPage = async (to) => {
        const p = new URLSearchParams({ selections: 'log', cat: '136', key: apiKey });
        if (to) p.set('to', String(to));
        const res  = await fetch(`https://api.torn.com/user/?${p}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error.error);
        if (!data.log) return [];
        return Object.values(data.log)
            .filter(e => /crime (success|fail|critical fail)/i.test(e.title));
    };

    let collected = [];
    let toTs = null;
    for (let i = 0; i < 20; i++) {
        const batch = await fetchPage(toTs);
        if (!batch.length) break;
        collected = [...batch, ...collected];
        if (collected.some(e => /crime critical fail/i.test(e.title))) break;
        toTs = batch.reduce((min, e) => Math.min(min, e.timestamp), Infinity) - 1;
        await new Promise(r => setTimeout(r, 350));
    }
    collected.sort((a, b) => a.timestamp - b.timestamp);
    let chain = 0;
    for (const e of collected) {
        if      (/crime success/i.test(e.title))       chain++;
        else if (/crime critical fail/i.test(e.title)) chain = 0;
        else                                            chain /= 2;
    }
    return Math.round(chain * 100) / 100;
}

// ── Poll ───────────────────────────────────────────────────────────────────

async function poll() {
    if (!state.apiKey) {
        console.log("[NerveTracker] No API key configured — skipping poll.");
        return;
    }

    try {
        const { nerveMax, totalCrimes } = await fetchNerveData(state.apiKey);
        const now     = Math.floor(Date.now() / 1000);
        const baseNNB = nerveMax - state.factionOffset;
        const prevNNB = state.baseNNB;

        // Detect nerve max change and determine if it's NNB (CE) or faction perk
        const rawDiff = nerveMax - (state.nerveMax ?? nerveMax);
        if (rawDiff !== 0 && state.nerveMax !== null) {
            if (rawDiff % 5 === 0) {
                // Multiple of 5 — likely a real NNB change from CE
                const crimesSinceLast = (totalCrimes != null && state.totalCrimes != null)
                    ? totalCrimes - state.totalCrimes : null;

                const nnbDiff = rawDiff > 0 ? 5 : -5;
                const change = {
                    timestamp:       now,
                    date:            new Date(now * 1000).toISOString(),
                    from:            prevNNB,
                    to:              prevNNB + nnbDiff,
                    diff:            nnbDiff,
                    nerveMaxBefore:  state.nerveMax,
                    nerveMaxAfter:   nerveMax,
                    crimesSinceLast,
                    totalCrimesAtChange: totalCrimes,
                };
                state.nnbChanges.push(change);

                const tag = nnbDiff === 5
                    ? "🎉 NNB +5 (CE threshold!)"
                    : "⚠️ NNB -5 (CE lost!)";
                console.log(`[NerveTracker] ${tag} ${prevNNB} → ${prevNNB + nnbDiff} after ${crimesSinceLast ?? '?'} crimes`);
            } else {
                // Not a multiple of 5 — faction perk changed, auto-adjust offset
                const oldOffset = state.factionOffset;
                state.factionOffset += rawDiff;
                console.log(`[NerveTracker] Faction perk change detected: nerve max ${state.nerveMax} → ${nerveMax} (+${rawDiff}). Faction offset auto-adjusted: ${oldOffset} → ${state.factionOffset}. Base NNB unchanged at ${prevNNB}.`);
            }
        }

        // Update state
        state.nerveMax    = nerveMax;
        state.baseNNB     = baseNNB;
        state.lastUpdated = now;
        if (totalCrimes != null) state.totalCrimes = totalCrimes;

        // Recalculate chain from logs every poll cycle
        try {
            state.crimeChain = await calculateChain(state.apiKey);
            console.log(`[NerveTracker] Chain: ${state.crimeChain}`);
        } catch (chainErr) {
            console.warn("[NerveTracker] Chain calc failed:", chainErr.message);
        }

        // Recalculate historical crime stats (only when not yet loaded, expensive call)
        if (!state.crimeHistoryStats) {
            try {
                console.log('[NerveTracker] Loading crime history stats (30 pages)...');
                state.crimeHistoryStats = await getCrimeHistoryStats(state.apiKey, state.lastNNBIncreaseAt);
                const types = Object.keys(state.crimeHistoryStats).join(', ');
                console.log(`[NerveTracker] Crime history loaded: ${types}`);
            } catch (histErr) {
                console.warn("[NerveTracker] Crime history failed:", histErr.message);
            }
        }

        // Recalculate bust stats
        try {
            state.bustStats = await getBustStats(state.apiKey);
            if (state.bustStats) {
                const { successes, attempts, ceScore } = state.bustStats;
                console.log(`[NerveTracker] Busts: ${successes}/${attempts} (CE score ${ceScore.toFixed(2)})`);
            }
        } catch (bustErr) {
            console.warn("[NerveTracker] Bust stats failed:", bustErr.message);
        }

        // Append to rolling history (keep last 2016 entries = ~6 weeks)
        state.history.push({ ts: now, nerveMax, baseNNB, crimes: totalCrimes });
        if (state.history.length > 2016) state.history.splice(0, state.history.length - 2016);

        save();
        console.log(`[NerveTracker] Polled — nerveMax=${nerveMax} baseNNB=${baseNNB} crimes=${totalCrimes}`);

    } catch (e) {
        console.error("[NerveTracker] Poll failed:", e.message);
    }
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Called from routes.js to get current state for the API endpoint. */
export function getData() {
    return {
        baseNNB:       state.baseNNB,
        nerveMax:      state.nerveMax,
        factionOffset: state.factionOffset,
        lastUpdated:   state.lastUpdated,
        totalCrimes:   state.totalCrimes,
        nextNNB:       state.baseNNB != null ? Math.floor(state.baseNNB / 5) * 5 + 5 : null,
        // Last 48 hours of history (96 entries at 30-min intervals)
        recentHistory: state.history.slice(-96),
        crimeChain:    state.crimeChain,
        bustStats:          state.bustStats,
        crimeHistoryStats:  state.crimeHistoryStats,
        lastNNBIncreaseAt:  state.lastNNBIncreaseAt,
        // All NNB change events (compact — full history)
        nnbChanges: state.nnbChanges,
    };
}

/** Update config from the API endpoint. Called from routes.js. */
export function updateConfig({ apiKey, factionOffset, lastNNBIncreaseAt }) {
    if (apiKey             != null) state.apiKey             = apiKey;
    if (factionOffset      != null) state.factionOffset      = Number(factionOffset);
    if (lastNNBIncreaseAt  != null) {
        state.lastNNBIncreaseAt  = Number(lastNNBIncreaseAt);
        state.crimeHistoryStats  = null; // force recalculation with new cutoff
    }
    if (state.nerveMax != null) state.baseNNB = state.nerveMax - state.factionOffset;
    save();
    console.log(`[NerveTracker] Config updated — factionOffset=${state.factionOffset} lastNNBIncreaseAt=${new Date(state.lastNNBIncreaseAt*1000).toISOString()}`);
}

/** Start the polling loop. Called from server.js on startup. */
export function startNerveTracker() {
    load();
    // Poll immediately, then every 30 minutes
    poll();
    pollTimer = setInterval(poll, POLL_INTERVAL_MS);
    console.log("[NerveTracker] Started — polling every 30 minutes.");
}

/** Clean shutdown. */
export function stopNerveTracker() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
