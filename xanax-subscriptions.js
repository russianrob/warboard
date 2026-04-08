/**
 * Xanax-based faction trial subscription system.
 *
 * Polls the owner's Torn events every 5 minutes for incoming Xanax sends.
 * Access is granted at the FACTION level — all members of the paying faction get in.
 *
 *   2  Xanax  → 7-day trial  (one-time per faction — cannot be used again)
 *   20 Xanax  → +30 days     (stackable, repeatable)
 *
 * Persists to data/xanax-subscriptions.json.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ── Config ───────────────────────────────────────────────────────────────

const OWNER_API_KEY    = process.env.OWNER_API_KEY || '';
const XANAX_TRIAL_QTY  = 2;    // 2 Xanax → 7-day trial (once per faction)
const XANAX_FULL_QTY   = 20;   // 20 Xanax → +30 days
const DAYS_TRIAL       = 7;
const DAYS_FULL        = 30;
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const DATA_DIR  = process.env.DATA_DIR || join(__dirname, 'data');
const SUBS_FILE = join(DATA_DIR, 'xanax-subscriptions.json');

// ── State ─────────────────────────────────────────────────────────────────
//
// factions: { factionId: { name, expiresAt, lastPayment } }
// trialsUsed: [ factionId, ... ]   — factions that already used their trial
// processed:  [ eventId, ... ]     — Torn event IDs already handled

let state = { factions: {}, trialsUsed: [], processed: [] };

let pollTimer = null;

// ── Persistence ───────────────────────────────────────────────────────────

function loadState() {
    try {
        if (existsSync(SUBS_FILE)) {
            const raw    = readFileSync(SUBS_FILE, 'utf-8');
            const loaded = JSON.parse(raw);
            state.factions    = loaded.factions    || {};
            state.trialsUsed  = loaded.trialsUsed  || [];
            state.processed   = loaded.processed   || [];
            console.log(
                `[xanax-subs] Loaded ${Object.keys(state.factions).length} faction subscription(s),` +
                ` ${state.trialsUsed.length} trial(s) used`
            );
        }
    } catch (e) {
        console.error('[xanax-subs] Failed to load state:', e.message);
    }
}

function saveState() {
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
        writeFileSync(SUBS_FILE, JSON.stringify(state, null, 2), 'utf-8');
    } catch (e) {
        console.error('[xanax-subs] Failed to save state:', e.message);
    }
}

// ── Torn API ──────────────────────────────────────────────────────────────

async function fetchEvents() {
    const url  = `https://api.torn.com/user/?selections=events&key=${OWNER_API_KEY}`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`Torn API HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`Torn API error: ${data.error.error}`);
    return data.events || {};
}

async function fetchPlayerFaction(playerId) {
    const url  = `https://api.torn.com/user/${playerId}?selections=basic&key=${OWNER_API_KEY}`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`Torn API HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`Torn API error: ${data.error.error}`);
    return {
        factionId:   String(data.faction?.faction_id  || 0),
        factionName: data.faction?.faction_name || 'Unknown',
        playerName:  data.name || `Player ${playerId}`,
    };
}

// ── Event parsing ─────────────────────────────────────────────────────────
//
// Torn event HTML format:
// "<a href='profiles.php?XID=12345'>PlayerName</a> sent you 2 x Xanax."

function parseXanaxSend(eventText) {
    const idMatch    = eventText.match(/XID=(\d+)/i);
    if (!idMatch) return null;
    const senderId   = idMatch[1];

    const xanaxMatch = eventText.match(/sent you (\d+)\s*(?:x\s*)?Xanax/i);
    if (!xanaxMatch) return null;

    const qty = parseInt(xanaxMatch[1], 10);
    return { senderId, qty };
}

// ── Poll ──────────────────────────────────────────────────────────────────

async function pollXanax() {
    if (!OWNER_API_KEY) {
        console.warn('[xanax-subs] OWNER_API_KEY not set, skipping poll');
        return;
    }

    try {
        const events = await fetchEvents();
        let changed  = false;

        for (const [eventId, entry] of Object.entries(events)) {
            if (state.processed.includes(eventId)) continue;
            state.processed.push(eventId);

            const parsed = parseXanaxSend(entry.event || '');
            if (!parsed) continue;

            const { senderId, qty } = parsed;

            // Determine tier
            let days = 0, isTrial = false;
            if (qty >= XANAX_FULL_QTY) {
                days = DAYS_FULL;
            } else if (qty >= XANAX_TRIAL_QTY) {
                days = DAYS_TRIAL;
                isTrial = true;
            } else {
                continue; // Not enough Xanax
            }

            // Look up sender's faction
            let factionId, factionName, playerName;
            try {
                ({ factionId, factionName, playerName } = await fetchPlayerFaction(senderId));
            } catch (e) {
                console.warn(`[xanax-subs] Could not look up player ${senderId}:`, e.message);
                continue;
            }

            if (!factionId || factionId === '0') {
                console.log(`[xanax-subs] ${playerName} [${senderId}] has no faction — skipping`);
                continue;
            }

            // Trials are one-time per faction
            if (isTrial && state.trialsUsed.includes(factionId)) {
                console.log(`[xanax-subs] ${playerName} tried to use trial for faction ${factionId} (${factionName}) — already used`);
                continue;
            }

            if (isTrial) state.trialsUsed.push(factionId);

            const now      = Date.now();
            const existing = state.factions[factionId];
            const base     = (existing && new Date(existing.expiresAt).getTime() > now)
                                ? new Date(existing.expiresAt).getTime()
                                : now;
            const expiresAt = new Date(base + days * 86400_000).toISOString();

            state.factions[factionId] = {
                name:        factionName,
                expiresAt,
                lastPayment: new Date(now).toISOString(),
                lastQty:     qty,
                lastPaidBy:  playerName,
            };

            const tier = isTrial ? '7-day trial' : '+30 days';
            console.log(
                `[xanax-subs] ${playerName} [${senderId}] (${factionName} [${factionId}])` +
                ` sent ${qty} Xanax → ${tier}, access until ${expiresAt}`
            );
            changed = true;

            // Small delay between API calls to avoid rate-limiting
            await new Promise(r => setTimeout(r, 1000));
        }

        if (state.processed.length > 5000) {
            state.processed = state.processed.slice(-5000);
        }

        if (changed) saveState();

    } catch (e) {
        console.error('[xanax-subs] Poll error:', e.message);
    }
}

// ── Public API ────────────────────────────────────────────────────────────

/** Returns true if the faction has an active Xanax subscription. */

// ── Instant grant (called from routes when buyer's events confirm a send) ──

export function grantFactionAccess(factionId, factionName, qty, paidBy) {
    factionId = String(factionId);
    let days = 0, isTrial = false;
    if (qty >= XANAX_FULL_QTY)        { days = DAYS_FULL; }
    else if (qty >= XANAX_TRIAL_QTY)  { days = DAYS_TRIAL; isTrial = true; }
    else return false;

    if (isTrial && state.trialsUsed.includes(factionId)) {
        console.log(`[xanax-subs] Trial already used for faction ${factionId} — ignoring`);
        return false;
    }
    if (isTrial) state.trialsUsed.push(factionId);

    const now      = Date.now();
    const existing = state.factions[factionId];
    const base     = (existing && new Date(existing.expiresAt).getTime() > now)
                        ? new Date(existing.expiresAt).getTime() : now;
    const expiresAt = new Date(base + days * 86400_000).toISOString();

    state.factions[factionId] = {
        name: factionName, expiresAt,
        lastPayment: new Date(now).toISOString(),
        lastQty: qty, lastPaidBy: paidBy,
    };
    saveState();
    const tier = isTrial ? '7-day trial' : '+30 days';
    console.log(`[xanax-subs] Instant grant: ${paidBy} (${factionName} [${factionId}]) ${qty} Xanax → ${tier}, until ${expiresAt}`);
    return true;
}

export function hasXanaxSubscription(factionId) {
    const sub = state.factions[String(factionId)];
    if (!sub) return false;
    return new Date(sub.expiresAt).getTime() > Date.now();
}

/** Returns whether a faction has already used their one-time trial. */
export function trialAlreadyUsed(factionId) {
    return state.trialsUsed.includes(String(factionId));
}

/** Returns subscription details or null. */
export function getXanaxSubscription(factionId) {
    return state.factions[String(factionId)] || null;
}

export function startXanaxSubscriptions() {
    loadState();
    pollXanax();
    pollTimer = setInterval(pollXanax, POLL_INTERVAL_MS);
    console.log('[xanax-subs] Started — polling every 5 minutes for Xanax payments');
}

export function stopXanaxSubscriptions() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
