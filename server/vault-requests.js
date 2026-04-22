/**
 * Faction vault-request board.
 *
 * Users submit a request for $X from their faction vault; everyone in the
 * faction sees the pending list. A background poller watches faction
 * `fundsnews` for matching money-send events and auto-removes the
 * request when the transfer fires. Push notifications on each new request,
 * with the requester choosing "online only" or "online + offline" audience.
 *
 * Per-faction JSON at data/vault-requests-<factionId>.json — persisted on
 * every mutation so state survives restarts.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join as pathJoin } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import * as push from './push-notifications.js';
import { fetchFactionBasic } from './torn-api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = process.env.DATA_DIR || pathJoin(__dirname, 'data');

// How often to poll faction fundsnews for money-send events.
// 20s — fast enough that auto-removal feels live; well within Torn's
// rate limits (3 calls/min, plenty of owner-key headroom).
const FULFILL_POLL_MS = 20_000;
// How many news events to look at per poll (Torn returns last ~100).
// Per-faction state ─────────────────────────────────────────────────────────
// factionId -> { requests: [], newsSeen: Set<newsId>, lastPoll: ts }
const state = new Map();

function file(factionId) {
    try { mkdirSync(DATA_DIR, { recursive: true }); } catch {}
    return pathJoin(DATA_DIR, `vault-requests-${factionId}.json`);
}

function load(factionId) {
    if (state.has(factionId)) return state.get(factionId);
    const f = { requests: [], newsSeen: new Set(), lastPoll: 0 };
    try {
        if (existsSync(file(factionId))) {
            const raw = JSON.parse(readFileSync(file(factionId), 'utf-8'));
            f.requests = Array.isArray(raw.requests) ? raw.requests : [];
            f.newsSeen = new Set(Array.isArray(raw.newsSeen) ? raw.newsSeen : []);
            f.lastPoll = raw.lastPoll || 0;
        }
    } catch (e) {
        console.warn(`[vault-requests] load ${factionId}:`, e.message);
    }
    state.set(factionId, f);
    return f;
}

function persist(factionId) {
    const f = state.get(factionId);
    if (!f) return;
    try {
        writeFileSync(file(factionId), JSON.stringify({
            requests: f.requests,
            newsSeen: Array.from(f.newsSeen).slice(-500),    // bounded history
            lastPoll: f.lastPoll,
        }, null, 2));
    } catch (e) {
        console.error(`[vault-requests] persist ${factionId}:`, e.message);
    }
}

function uuid() {
    return randomBytes(8).toString('hex');
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Returns an array of pending requests for the faction (newest first).
 *  Triggers a non-blocking fundsnews sweep if we haven't polled recently,
 *  so stale fulfilled requests get cleaned up before being shown. */
export function listRequests(factionId) {
    const f = load(String(factionId));
    // If anyone's looking at the list, kick a poll if we haven't checked
    // in the last 5s — gives near-real-time auto-removal whenever an admin
    // is actively viewing.
    if (f.requests.length > 0 && (Date.now() - f.lastPoll) > 5_000) {
        if (getKey && getFactionIds) {
            Promise.resolve().then(() => runPoll()).catch(() => {});
        }
    }
    return f.requests.slice().sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Create a new vault request. Caller must have already validated the player
 * and resolved their factionId. The caller also supplies a maxAmount that
 * caps the request (typically the requester's personal vault balance).
 */
export function createRequest(factionId, {
    requesterId, requesterName,
    amount, target = 'both',       // 'online' | 'both'
    maxAmount = Infinity,
}) {
    factionId = String(factionId);
    amount = Math.max(1, Math.floor(Number(amount) || 0));
    if (amount > maxAmount) amount = maxAmount;
    const f = load(factionId);
    const req = {
        id: uuid(),
        factionId,
        requesterId: String(requesterId),
        requesterName: String(requesterName || requesterId),
        amount,
        target: target === 'online' ? 'online' : 'both',
        createdAt: Date.now(),
    };
    f.requests.push(req);
    persist(factionId);
    return req;
}

/**
 * Remove a request. Allowed if remover is the requester or `isAdmin`.
 * Returns the removed request or null if not found/unauthorized.
 */
export function removeRequest(factionId, requestId, removerId, isAdmin = false) {
    factionId = String(factionId);
    const f = load(factionId);
    const idx = f.requests.findIndex(r => r.id === requestId);
    if (idx < 0) return null;
    const r = f.requests[idx];
    if (!isAdmin && String(r.requesterId) !== String(removerId)) return null;
    f.requests.splice(idx, 1);
    persist(factionId);
    return r;
}

/**
 * Send push notifications for a newly-created request. Notifications
 * always go to every faction member (like the shout/call system). The
 * `target` field on the request is the REQUESTER's delivery preference,
 * not a notification filter — it tells fulfillers whether it's OK to
 * send the money while the requester is offline.
 */
export async function notifyNewRequest(req, allFactionMemberIds) {
    const audience = allFactionMemberIds.filter(id => String(id) !== String(req.requesterId));
    if (audience.length === 0) return;
    const amount = req.amount.toLocaleString('en-US');
    const pref = req.target === 'online'
        ? 'only when online'
        : 'OK even if offline';
    await push.sendToPlayers(audience, {
        title: `${req.requesterName} requested $${amount}`,
        body:  `${pref}. Tap to open the faction vault.`,
        data:  {
            type: 'vault_request',
            requestId: req.id,
            factionId: req.factionId,
            url: 'https://www.torn.com/factions.php?step=your&type=1#/tab=armoury&start=0&sub=donations',
        },
    }, 'vault_request');
}

// ── Auto-fulfillment poller ─────────────────────────────────────────────────
// Watches faction fundsnews for money-send events. When the requester
// receives money matching (or exceeding) their pending amount, we clear
// that request. Heuristic: parse the news text for "was given $X by Y" or
// "gave $X to Y" patterns and match against outstanding requests.

// Torn fundsnews HTML shape (approximate):
//   <a href = https://www.torn.com/profiles.php?XID=137558>RussianRob</a>
//     was given $446,941 by
//   <a href = https://www.torn.com/profiles.php?XID=137558>RussianRob</a>
// Amount regex: tolerant of optional cents / leading $. Recipient regex:
// finds the FIRST XID in the text before the "was given" phrase.
const MONEY_GIVEN_RE = /was given\s+\$([\d,]+)/i;
// Match XID with optional whitespace around = (Torn uses `XID = 137558`).
const ANY_XID_RE     = /XID\s*=\s*(\d+)/ig;

/**
 * Public hook: run a fundsnews poll for a faction using a provided key.
 * Called opportunistically by the vault-requests list endpoint with the
 * caller's own key. Throttled to ≤1 poll per 5s per faction to avoid
 * hammering Torn when many members open the panel at once.
 *
 * Safe for any subscribed faction — each call uses only that caller's key
 * against their own faction (same scope their key already has).
 */
export async function pollFactionWithKey(factionId, apiKey) {
    if (!apiKey) return;
    const f = load(String(factionId));
    if (f.requests.length === 0) return;     // nothing to fulfill
    if ((Date.now() - f.lastPoll) < 5_000) return;   // throttle
    try {
        await pollOneFaction(factionId, apiKey);
    } catch (e) {
        console.warn(`[vault-requests] piggy-back poll ${factionId}:`, e.message);
    }
}

async function pollOneFaction(factionId, apiKey) {
    const url = `https://api.torn.com/faction/${factionId}?selections=fundsnews&key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.error || 'API error');

    const f = load(String(factionId));
    const news = data.fundsnews || {};
    let fulfilledAny = false;

    for (const [newsId, entry] of Object.entries(news)) {
        if (f.newsSeen.has(newsId)) continue;
        f.newsSeen.add(newsId);
        const text = entry.news || '';
        const amtMatch = text.match(MONEY_GIVEN_RE);
        if (!amtMatch) continue;
        // Pull the first XID from the text — that's the recipient
        // (the sender XID comes AFTER "was given $X by").
        ANY_XID_RE.lastIndex = 0;
        const firstXid = ANY_XID_RE.exec(text);
        if (!firstXid) continue;
        const amount = parseInt(amtMatch[1].replace(/,/g, ''), 10);
        const recipientId = firstXid[1];
        const before = f.requests.length;
        const fulfilled = [];
        f.requests = f.requests.filter(r => {
            if (String(r.requesterId) !== String(recipientId)) return true;
            if (r.amount > amount) return true;  // received less than asked — keep pending
            fulfilled.push(r);
            return false;
        });
        if (f.requests.length < before) {
            fulfilledAny = true;
            console.log(`[vault-requests] fulfilled ${before - f.requests.length} request(s) for ${recipientId} on $${amount}`);
            // Fire vault-request.fulfilled webhook per cleared request.
            try {
                const { emit } = await import('./webhook-bus.js');
                for (const r of fulfilled) {
                    emit(factionId, 'vault-request.fulfilled', {
                        requestId: r.id,
                        requesterId: r.requesterId,
                        requesterName: r.requesterName,
                        requestedAmount: r.amount,
                        receivedAmount: amount,
                    });
                }
            } catch (_) {}
        }
    }

    f.lastPoll = Date.now();
    persist(String(factionId));
    return fulfilledAny;
}

/**
 * Start a periodic poller for the given faction. Caller supplies a way to
 * fetch the owner key for that faction (used to hit the fundsnews API).
 * For now, only the owner faction is polled since that's where we hold a key.
 */
let pollTimer = null;
let getKey = null;
let getFactionIds = null;

export function startPoller({ getApiKeyForFaction, listActiveFactions }) {
    getKey = getApiKeyForFaction;
    getFactionIds = listActiveFactions;
    if (pollTimer) return;
    pollTimer = setInterval(runPoll, FULFILL_POLL_MS);
    runPoll();
}

async function runPoll() {
    if (!getKey || !getFactionIds) return;
    const factionIds = getFactionIds();
    for (const fid of factionIds) {
        const f = load(String(fid));
        if (f.requests.length === 0) continue;
        try {
            const apiKey = await getKey(fid);
            if (!apiKey) continue;
            await pollOneFaction(fid, apiKey);
        } catch (e) {
            console.warn(`[vault-requests] poll ${fid}:`, e.message);
        }
    }
}

export function stopPoller() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ── Vault balance fetch for the cap ─────────────────────────────────────────
// Returns the requester's personal faction vault balance in dollars.
// Uses `faction?selections=donations` which returns per-member balance.
export async function fetchVaultBalance(factionId, memberId, apiKey) {
    const url = `https://api.torn.com/faction/${factionId}?selections=donations&key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.error || 'API error');
    const donations = data.donations || {};
    const entry = donations[String(memberId)];
    if (!entry) return 0;
    return Number(entry.money_balance ?? entry.money ?? 0);
}
