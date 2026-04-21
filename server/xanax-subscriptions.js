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
        // Always log the resolved path + whether the file exists so any future
        // "why isn't my manual grant working?" is answered in 1 log line.
        const exists = existsSync(SUBS_FILE);
        console.log(`[xanax-subs] State file: ${SUBS_FILE} (exists=${exists})`);
        if (exists) {
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

// Self-test on boot. If Torn changes the event HTML format and the parser
// silently stops matching, historically this bug was invisible for months.
// These fixtures are the known valid shapes; any regression triggers CRITICAL.
function parserSelfTest() {
    const fixtures = [
        { text: "<a href='profiles.php?XID=12345'>Bob</a> sent you 2 x Xanax.",              expectXid: '12345', expectQty: 2 },
        { text: "You were sent 2x Xanax from <a href='profiles.php?XID=2194491'>Ikouze</a>.", expectXid: '2194491', expectQty: 2 },
        { text: "<a href='profiles.php?XID=999'>Alice</a> sent you 20 x Xanax.",              expectXid: '999', expectQty: 20 },
    ];
    let failed = 0;
    for (const f of fixtures) {
        const p = parseXanaxSend(f.text);
        if (!p || p.senderId !== f.expectXid || p.qty !== f.expectQty) {
            console.error(`[xanax-subs] CRITICAL parser self-test FAIL — fixture did not parse: ${f.text}`);
            failed++;
        }
    }
    if (failed > 0) {
        console.error(`[xanax-subs] CRITICAL ${failed}/${fixtures.length} parser fixtures FAILED — payments may be silently dropped. Check Torn's event HTML format and update parseXanaxSend.`);
    } else {
        console.log(`[xanax-subs] Parser self-test OK (${fixtures.length}/${fixtures.length} fixtures)`);
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
    try { (await import('./key-usage-log.js')).logCall(OWNER_API_KEY, 'user?selections=events', 'xanax-subs:poll'); } catch (_) {}
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`Torn API HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`Torn API error: ${data.error.error}`);
    return data.events || {};
}

async function fetchPlayerFaction(playerId) {
    // Use selections=profile — `basic` does not return faction data for other
    // users, which caused legitimate senders (long-standing faction members)
    // to be reported as factionless and have their payment skipped.
    const url  = `https://api.torn.com/user/${playerId}?selections=profile&key=${OWNER_API_KEY}`;
    try { (await import('./key-usage-log.js')).logCall(OWNER_API_KEY, `user/${playerId}?selections=profile`, 'xanax-subs:lookup'); } catch (_) {}
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`Torn API HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`Torn API error: ${data.error.error}`);
    return {
        factionId:       String(data.faction?.faction_id  || 0),
        factionName:     data.faction?.faction_name || 'Unknown',
        // Faction position (Leader/Co-Leader/Banker/etc.). Stored on the
        // subscription so admins can see who paid + what role they hold.
        factionPosition: data.faction?.position || '',
        playerName:      data.name || `Player ${playerId}`,
    };
}

// ── Event parsing ─────────────────────────────────────────────────────────
//
// Torn event HTML can take either of two forms depending on send type:
//   "<a href='profiles.php?XID=12345'>PlayerName</a> sent you 2 x Xanax."
//   "You were sent 2x Xanax from <a href='profiles.php?XID=12345'>PlayerName</a>."
// The old regex only matched the first form, silently dropping the second
// (which is the form Torn actually uses for item-give sends). Fix matches both.

function parseXanaxSend(eventText) {
    const idMatch    = eventText.match(/XID=(\d+)/i);
    if (!idMatch) return null;
    const senderId   = idMatch[1];

    const xanaxMatch = eventText.match(/(?:sent you|you were sent)\s+(\d+)\s*(?:x\s*)?Xanax/i);
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
            if (!parsed) {
                // If we see an event that *looks* like a Xanax send but our
                // regex didn't match it, something's drifted — Torn likely
                // changed the event HTML format again. Loud warning so the
                // next failure doesn't go silent for months like the last one.
                if (/xanax/i.test(entry.event || '')) {
                    console.warn(`[xanax-subs] WARN Xanax-looking event NOT parsed — update regex. Raw text: ${entry.event}`);
                }
                continue;
            }

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
                var factionPosition;
                ({ factionId, factionName, factionPosition, playerName } = await fetchPlayerFaction(senderId));
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
                name:                factionName,
                expiresAt,
                lastPayment:         new Date(now).toISOString(),
                lastQty:             qty,
                lastPaidBy:          playerName,
                lastPaidById:        String(senderId),
                lastPaidByPosition:  factionPosition || '',   // role inside faction at time of payment
            };

            const tier = isTrial ? '7-day trial' : '+30 days';
            const posLabel = factionPosition ? ` (${factionPosition})` : '';
            console.log(
                `[xanax-subs] ${playerName} [${senderId}]${posLabel} (${factionName} [${factionId}])` +
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

export function grantFactionAccess(factionId, factionName, qty, paidBy, opts = {}) {
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
        name:                factionName,
        expiresAt,
        lastPayment:         new Date(now).toISOString(),
        lastQty:             qty,
        lastPaidBy:          paidBy,
        lastPaidById:        opts.paidById ? String(opts.paidById) : '',
        lastPaidByPosition:  opts.paidByPosition || '',
    };
    saveState();
    const tier = isTrial ? '7-day trial' : '+30 days';
    const posLabel = opts.paidByPosition ? ` (${opts.paidByPosition})` : '';
    console.log(`[xanax-subs] Instant grant: ${paidBy}${posLabel} (${factionName} [${factionId}]) ${qty} Xanax → ${tier}, until ${expiresAt}`);
    return true;
}

/** Returns faction IDs with an active (non-expired) Xanax subscription. */
export function getActiveSubscribedFactionIds() {
    const now = Date.now();
    return Object.entries(state.factions)
        .filter(([, f]) => f.expiresAt && new Date(f.expiresAt).getTime() > now)
        .map(([id]) => String(id));
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
    parserSelfTest();
    loadState();
    pollXanax();
    pollTimer = setInterval(pollXanax, POLL_INTERVAL_MS);
    console.log('[xanax-subs] Started — polling every 5 minutes for Xanax payments');
}

export function stopXanaxSubscriptions() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
