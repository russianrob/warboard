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

        // Detect NNB change
        if (prevNNB !== null && baseNNB !== prevNNB) {
            const crimesSinceLast = (totalCrimes != null && state.totalCrimes != null)
                ? totalCrimes - state.totalCrimes
                : null;

            const change = {
                timestamp:       now,
                date:            new Date(now * 1000).toISOString(),
                from:            prevNNB,
                to:              baseNNB,
                diff:            baseNNB - prevNNB,
                nerveMaxBefore:  nerveMax - (baseNNB - prevNNB),
                nerveMaxAfter:   nerveMax,
                crimesSinceLast,
                totalCrimesAtChange: totalCrimes,
            };

            state.nnbChanges.push(change);

            const tag = change.diff === 5  ? "🎉 NNB +5 (CE threshold!)" :
                        change.diff === -5 ? "⚠️ NNB -5 (CE lost!)"      :
                        `NNB changed ${change.diff > 0 ? "+" : ""}${change.diff} (faction perk?)`;

            console.log(`[NerveTracker] ${tag} ${prevNNB} → ${baseNNB}` +
                (crimesSinceLast != null ? ` after ${crimesSinceLast} crimes` : ""));
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
        // All NNB change events (compact — full history)
        nnbChanges: state.nnbChanges,
    };
}

/** Update config from the API endpoint. Called from routes.js. */
export function updateConfig({ apiKey, factionOffset }) {
    if (apiKey        != null) state.apiKey        = apiKey;
    if (factionOffset != null) state.factionOffset = Number(factionOffset);
    // Recalculate baseNNB with new offset
    if (state.nerveMax != null) state.baseNNB = state.nerveMax - state.factionOffset;
    save();
    console.log(`[NerveTracker] Config updated — factionOffset=${state.factionOffset}`);
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
