#!/usr/bin/env node
// Simulated xanax-subscription test. Runs in isolation with its own DATA_DIR
// (/tmp/xanax-test) so the live pm2 state is NOT touched. Mocks the global
// fetch() that fetchEvents / fetchPlayerFaction use, then exercises the real
// subscription logic and verifies the state file that gets written.

import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_DIR = join(tmpdir(), 'xanax-test');
rmSync(TEST_DIR, { recursive: true, force: true });
mkdirSync(TEST_DIR, { recursive: true });

process.env.DATA_DIR      = TEST_DIR;
process.env.OWNER_API_KEY = 'TESTKEY';          // any non-empty string; fetch is mocked

// ── Mock the Torn API ─────────────────────────────────────────────────────
// Event text format the production parser expects:
//   "<a href='profiles.php?XID=12345'>Bob</a> sent you 2 x Xanax."
const FAKE_SENDER_ID   = '7777777';
const FAKE_FACTION_ID  = '88888888';
const FAKE_FACTION     = 'Test Faction';
const FAKE_PLAYER_NAME = 'TestSender';

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
    if (url.includes('selections=events')) {
        return {
            ok: true,
            status: 200,
            async json() {
                return {
                    events: {
                        'evt-trial-42': {
                            timestamp: Math.floor(Date.now()/1000),
                            event: `<a href='profiles.php?XID=${FAKE_SENDER_ID}'>${FAKE_PLAYER_NAME}</a> sent you 2 x Xanax.`,
                        },
                        'evt-full-43': {
                            timestamp: Math.floor(Date.now()/1000),
                            event: `<a href='profiles.php?XID=${FAKE_SENDER_ID}'>${FAKE_PLAYER_NAME}</a> sent you 20 x Xanax.`,
                        },
                    },
                };
            },
        };
    }
    if (url.match(/api\.torn\.com\/user\/\d+\?/)) {
        return {
            ok: true,
            status: 200,
            async json() {
                return {
                    name: FAKE_PLAYER_NAME,
                    faction: {
                        faction_id:   Number(FAKE_FACTION_ID),
                        faction_name: FAKE_FACTION,
                    },
                };
            },
        };
    }
    return { ok: false, status: 404, async json() { return { error: { error: 'unexpected url ' + url } }; } };
};

// ── Load the real module ──────────────────────────────────────────────────
const mod = await import('../xanax-subscriptions.js');

// The module exports hasXanaxSubscription + a start fn. The poll runner is
// internal — easiest path is to import it directly:
const { hasXanaxSubscription, startXanaxSubscriptions, stopXanaxSubscriptions, grantFactionAccess } = mod;

console.log('\n── Step 1: before any grant ──');
console.log(`  hasXanaxSubscription(${FAKE_FACTION_ID}) →`, hasXanaxSubscription(FAKE_FACTION_ID));

console.log('\n── Step 2: simulate "sent you 2 Xanax" via grantFactionAccess ──');
const granted1 = grantFactionAccess(FAKE_FACTION_ID, FAKE_FACTION, 2, FAKE_PLAYER_NAME);
console.log(`  granted? ${granted1}`);
console.log(`  hasXanaxSubscription() now →`, hasXanaxSubscription(FAKE_FACTION_ID));

console.log('\n── Step 3: state file contents ──');
const statePath = join(TEST_DIR, 'xanax-subscriptions.json');
if (existsSync(statePath)) {
    console.log(readFileSync(statePath, 'utf-8'));
} else {
    console.log('  (state file not written)');
}

console.log('\n── Step 4: simulate second payment — 20 Xanax — stacks +30 days ──');
const granted2 = grantFactionAccess(FAKE_FACTION_ID, FAKE_FACTION, 20, FAKE_PLAYER_NAME);
console.log(`  granted? ${granted2}`);

console.log('\n── Step 5: final state file ──');
console.log(readFileSync(statePath, 'utf-8'));

console.log('\n── Step 6: trial re-use prevention ──');
const granted3 = grantFactionAccess(FAKE_FACTION_ID, FAKE_FACTION, 2, FAKE_PLAYER_NAME);
console.log(`  tried 2 Xanax again → granted? ${granted3}  (expected: false, trial is one-time)`);

globalThis.fetch = originalFetch;
console.log('\n✓ Test complete. Live pm2 state untouched.\n');
