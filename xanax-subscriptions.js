/**
 * Xanax-based player trial subscriptions.
 *
 * Polls the owner's Torn events every 5 minutes looking for
 * incoming Xanax (item ID 206) sends.
 *
 *   2  Xanax  → +7 days
 *   20 Xanax  → +30 days
 *
 * Time stacks — sending again before expiry extends from the current expiry.
 * Non-faction players with an active subscription can use OC Spawn Assistance.
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
const XANAX_SMALL_QTY  = 2;    // minimum Xanax for short trial
const XANAX_LARGE_QTY  = 20;   // Xanax for full month
const DAYS_SMALL       = 7;
const DAYS_LARGE       = 30;
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const DATA_DIR  = process.env.DATA_DIR || join(__dirname, 'data');
const SUBS_FILE = join(DATA_DIR, 'xanax-subscriptions.json');

// ── State ────────────────────────────────────────────────────────────────

// players:   { playerId: { name, expiresAt, lastQty, lastPayment } }
// processed: [ eventId, ... ]  — IDs already handled
let state = { players: {}, processed: [] };

let pollTimer = null;

// ── Persistence ──────────────────────────────────────────────────────────

function loadState() {
    try {
        if (existsSync(SUBS_FILE)) {
            const raw = readFileSync(SUBS_FILE, 'utf-8');
            const loaded = JSON.parse(raw);
            state.players   = loaded.players   || {};
            state.processed = loaded.processed || [];
            const count = Object.keys(state.players).length;
            console.log(`[xanax-subs] Loaded ${count} player subscription(s), ${state.processed.length} processed event(s)`);
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

// ── Torn API ─────────────────────────────────────────────────────────────

async function fetchEvents() {
    const url  = `https://api.torn.com/user/?selections=events&key=${OWNER_API_KEY}`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`Torn API HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`Torn API error: ${data.error.error}`);
    return data.events || {};
}

// ── Event parsing ─────────────────────────────────────────────────────────
//
// Torn event HTML looks like:
// "<a href='profiles.php?XID=12345'>PlayerName</a> sent you 5 Xanax."
// "<a href='profiles.php?XID=12345'>PlayerName</a> sent you 20 x Xanax."

function parseXanaxSend(eventText) {
    // Extract sender player ID from profile link
    const idMatch = eventText.match(/XID=(\d+)/i);
    if (!idMatch) return null;
    const senderId = idMatch[1];

    // Extract sender name from link text
    const nameMatch = eventText.match(/>([^<]+)<\/a>\s+sent you/i);
    const senderName = nameMatch ? nameMatch[1].trim() : `Player ${senderId}`;

    // Detect Xanax and quantity  — covers "5 Xanax" and "5 x Xanax"
    const xanaxMatch = eventText.match(/sent you (\d+)\s*(?:x\s*)?Xanax/i);
    if (!xanaxMatch) return null;

    const qty = parseInt(xanaxMatch[1], 10);
    return { senderId, senderName, qty };
}

// ── Poll ──────────────────────────────────────────────────────────────────

async function pollXanax() {
    if (!OWNER_API_KEY) {
        console.warn('[xanax-subs] OWNER_API_KEY not set, skipping poll');
        return;
    }

    try {
        const events = await fetchEvents();
        let changed = false;

        for (const [eventId, entry] of Object.entries(events)) {
            if (state.processed.includes(eventId)) continue;
            state.processed.push(eventId);

            const parsed = parseXanaxSend(entry.event || '');
            if (!parsed) continue;

            const { senderId, senderName, qty } = parsed;

            let days = 0;
            if (qty >= XANAX_LARGE_QTY)     days = DAYS_LARGE;
            else if (qty >= XANAX_SMALL_QTY) days = DAYS_SMALL;
            else continue; // Not enough Xanax

            const now      = Date.now();
            const existing = state.players[senderId];

            // Stack on top of any remaining time
            const base      = (existing && new Date(existing.expiresAt).getTime() > now)
                                ? new Date(existing.expiresAt).getTime()
                                : now;
            const expiresAt = new Date(base + days * 86400_000).toISOString();

            state.players[senderId] = {
                name:        senderName,
                expiresAt,
                lastQty:     qty,
                lastPayment: new Date(now).toISOString(),
            };

            console.log(`[xanax-subs] ${senderName} [${senderId}] sent ${qty} Xanax → +${days} days, access until ${expiresAt}`);
            changed = true;
        }

        // Keep processed list from growing unbounded
        if (state.processed.length > 5000) {
            state.processed = state.processed.slice(-5000);
        }

        if (changed) saveState();

    } catch (e) {
        console.error('[xanax-subs] Poll error:', e.message);
    }
}

// ── Public API ────────────────────────────────────────────────────────────

/** Returns true if the player has an active Xanax subscription. */
export function hasXanaxSubscription(playerId) {
    const sub = state.players[String(playerId)];
    if (!sub) return false;
    return new Date(sub.expiresAt).getTime() > Date.now();
}

/** Returns subscription details or null. */
export function getXanaxSubscription(playerId) {
    return state.players[String(playerId)] || null;
}

export function startXanaxSubscriptions() {
    loadState();
    pollXanax(); // immediate first poll
    pollTimer = setInterval(pollXanax, POLL_INTERVAL_MS);
    console.log('[xanax-subs] Started — polling every 5 minutes for Xanax payments');
}

export function stopXanaxSubscriptions() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
