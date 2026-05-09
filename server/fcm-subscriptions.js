/**
 * FCM device-token persistence + send shim.
 *
 * Subscriptions are keyed by (playerId, token) so a player switching
 * devices accumulates entries (one per device); upsert dedup by token.
 * Send path will use firebase-admin once data/firebase-service-account.json
 * lands on disk.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join as pathJoin } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const DATA_DIR   = process.env.DATA_DIR || pathJoin(__dirname, 'data');
const FILE       = pathJoin(DATA_DIR, 'fcm-subscriptions.json');
const SVC_KEY    = pathJoin(DATA_DIR, 'firebase-service-account.json');

let state = { subs: [] };
try { mkdirSync(DATA_DIR, { recursive: true }); } catch {}
try {
    if (existsSync(FILE)) state = JSON.parse(readFileSync(FILE, 'utf-8'));
} catch (e) {
    console.warn('[fcm-subs] load failed:', e.message);
}

function persist() {
    try { writeFileSync(FILE, JSON.stringify(state, null, 2)); }
    catch (e) { console.error('[fcm-subs] persist failed:', e.message); }
}

export function upsertSubscription(entry) {
    const idx = state.subs.findIndex(s => s.token === entry.token);
    const merged = { ...entry, updatedAt: Date.now() };
    if (idx >= 0) state.subs[idx] = merged;
    else state.subs.push(merged);
    persist();
}

export function removeToken(token) {
    const before = state.subs.length;
    state.subs = state.subs.filter(s => s.token !== token);
    if (state.subs.length !== before) persist();
}

export function listForPlayer(playerId) {
    return state.subs.filter(s => String(s.playerId) === String(playerId));
}

export function listForFaction(factionId) {
    return state.subs.filter(s => String(s.factionId) === String(factionId));
}

export function listAll() {
    return state.subs.slice();
}

// ── Send shim ──────────────────────────────────────────────────────────
//
// Until the service-account JSON is uploaded, every send is a no-op
// that just logs. Once the file appears, swap the implementation to
// import('firebase-admin') and call admin.messaging().sendEach(...).
let _adminReady = false;
let _admin = null;

async function ensureAdmin() {
    if (_adminReady) return _admin;
    if (!existsSync(SVC_KEY)) return null;
    try {
        const adminMod = await import('firebase-admin');
        const admin = adminMod.default || adminMod;
        const svc = JSON.parse(readFileSync(SVC_KEY, 'utf-8'));
        if (!admin.apps.length) {
            admin.initializeApp({ credential: admin.credential.cert(svc) });
        }
        _admin = admin;
        _adminReady = true;
        console.log('[fcm-subs] firebase-admin initialised');
        return admin;
    } catch (e) {
        console.warn('[fcm-subs] firebase-admin init failed:', e.message);
        return null;
    }
}

/**
 * Send a notification to a list of player IDs. Each player can have
 * multiple device subscriptions — fan out to all. Tokens that come
 * back as UNREGISTERED / INVALID get removed from storage.
 *
 * Splits by platform: ios → apns.js (HTTP/2 + .p8 JWT), android →
 * firebase-admin (FCM v1). Both paths reap dead tokens.
 *
 * payload = { title, body, data?: { type, url, ... } }
 */
export async function sendToPlayers(playerIds, payload) {
    const targets = [];
    for (const pid of playerIds) {
        for (const s of listForPlayer(pid)) targets.push(s);
    }
    if (targets.length === 0) return { sent: 0, failed: 0, removed: 0 };

    const iosTargets     = targets.filter(t => String(t.platform) === 'ios');
    const androidTargets = targets.filter(t => String(t.platform) !== 'ios');

    const [iosResult, androidResult] = await Promise.all([
        _sendIosTargets(iosTargets, payload),
        _sendAndroidTargets(androidTargets, payload),
    ]);

    const totalSent    = iosResult.sent    + androidResult.sent;
    const totalFailed  = iosResult.failed  + androidResult.failed;
    const totalRemoved = iosResult.removed + androidResult.removed;

    return {
        sent: totalSent, failed: totalFailed, removed: totalRemoved,
        ios: iosResult, android: androidResult,
    };
}

/**
 * Send to iOS device tokens via APNs HTTP/2 + .p8 JWT. Reaps tokens
 * Apple rejects as BadDeviceToken / Unregistered.
 */
async function _sendIosTargets(targets, payload) {
    if (targets.length === 0) return { sent: 0, failed: 0, removed: 0 };
    let apns;
    try {
        apns = await import('./apns.js');
    } catch (e) {
        console.warn('[fcm-subs] apns module load failed:', e.message);
        return { sent: 0, failed: targets.length, removed: 0 };
    }

    let sent = 0, failed = 0, removed = 0;
    await Promise.all(targets.map(async t => {
        const result = await apns.sendAlert(t.token, payload);
        if (result.ok) { sent++; return; }
        failed++;
        if (result.reason === 'BadDeviceToken' || result.reason === 'Unregistered') {
            removeToken(t.token);
            removed++;
        } else if (result.reason !== 'not-configured') {
            console.warn(`[fcm-subs/ios] send failed for player ${t.playerId}: ${result.reason}`);
        }
    }));
    if (sent + failed > 0) {
        console.log(`[fcm-subs/ios] sent → ${sent}/${targets.length} ok, ${failed} fail, ${removed} reaped`);
    }
    return { sent, failed, removed };
}

/**
 * Send to Android device tokens via firebase-admin (existing path).
 */
async function _sendAndroidTargets(targets, payload) {
    if (targets.length === 0) return { sent: 0, failed: 0, removed: 0 };
    const admin = await ensureAdmin();
    if (!admin) {
        console.log(`[fcm-subs/android] would-send to ${targets.length} device(s): "${payload.title}" — ${payload.body}`);
        return { sent: 0, failed: 0, removed: 0, dryRun: true };
    }

    const messages = targets.map(t => ({
        token: t.token,
        notification: { title: payload.title, body: payload.body },
        data: Object.fromEntries(
            Object.entries(payload.data || {}).map(([k, v]) => [k, String(v)])
        ),
        android: { priority: 'high' },
    }));

    const resp = await admin.messaging().sendEach(messages);
    let removed = 0;
    resp.responses.forEach((r, i) => {
        if (r.success) return;
        const code = r.error?.code || '';
        if (/registration-token-not-registered|invalid-registration-token/.test(code)) {
            removeToken(targets[i].token);
            removed++;
        }
    });
    console.log(`[fcm-subs/android] sent → ${resp.successCount}/${messages.length} ok, ${resp.failureCount} fail, ${removed} reaped`);
    return { sent: resp.successCount, failed: resp.failureCount, removed };
}
