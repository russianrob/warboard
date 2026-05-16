// One-time backfill: scan arson-bang-for-buck source for hardcoded
// scenarios, POST any that arsontest doesn't already have to the
// warboard recipe API.
//
// Multi-variant scenarios (no-flamethrower vs with-flamethrower) are
// imported as TWO separate entries unless that name already exists.
// The non-flamethrower variant gets the base name; the flamethrower
// variant gets ' (flame)' suffix so both are searchable from the
// editor.

import { readFileSync } from 'node:fs';

const SRC = '/opt/warboard/server/scripts/arson-bang-for-buck.user.js';
const API = 'http://127.0.0.1:3000/api/arson/recipes';

const text = readFileSync(SRC, 'utf8');

// Extract the `scenarios = { ... };` block (line ~134 to a closing `};`
// before `function addTooltips`).
const startIdx = text.indexOf('const scenarios = {');
const endIdx = text.indexOf('function addTooltips', startIdx);
if (startIdx < 0 || endIdx < 0) {
    console.error('Could not locate scenarios block');
    process.exit(1);
}
const block = text.slice(startIdx, endIdx);

// Find every "Name": [ ... ] entry. Match the top-level value (array)
// by counting brackets so we handle nested variant arrays correctly.
function* iterEntries(src) {
    let i = src.indexOf('{');
    if (i < 0) return;
    i++;
    while (i < src.length) {
        // Skip whitespace and trailing commas
        while (i < src.length && /[\s,]/.test(src[i])) i++;
        if (src[i] === '}') return;
        if (src[i] !== '"') { i++; continue; }
        // Read key
        const keyStart = i + 1;
        i++;
        while (i < src.length && src[i] !== '"') i++;
        const key = src.slice(keyStart, i);
        i++; // closing quote
        // Skip whitespace and colon
        while (i < src.length && /[\s:]/.test(src[i])) i++;
        if (src[i] !== '[') break;
        // Read balanced [...]
        let depth = 0;
        const valStart = i;
        while (i < src.length) {
            const c = src[i];
            if (c === '[') depth++;
            else if (c === ']') {
                depth--;
                if (depth === 0) { i++; break; }
            } else if (c === '"') {
                i++;
                while (i < src.length && src[i] !== '"') {
                    if (src[i] === '\\') i++;
                    i++;
                }
            }
            i++;
        }
        const val = src.slice(valStart, i);
        try {
            const parsed = JSON.parse(val);
            yield [key, parsed];
        } catch (e) { /* skip malformed */ }
    }
}

function parseVariant(lines) {
    const out = {};
    for (const raw of lines) {
        const s = String(raw || '').trim();
        const colonIdx = s.indexOf(':');
        if (colonIdx < 0) continue;
        const field = s.slice(0, colonIdx).trim();
        const rest = s.slice(colonIdx + 1).trim();
        if (!rest) continue;
        if (field === 'Payout') {
            const m = rest.match(/(\d+(?:\.\d+)?)\s*([KMk])?/);
            if (!m) continue;
            const n = parseFloat(m[1]);
            const unit = (m[2] || '').toLowerCase();
            out.payout = Math.round(n * (unit === 'm' ? 1_000_000 : unit === 'k' ? 1_000 : 1));
        } else if (field === 'Flamethrower') {
            const lo = rest.toLowerCase();
            if (/yes/.test(lo)) out.flamethrower = true;
            else if (/no/.test(lo)) out.flamethrower = false;
        } else if (field === 'Place' || field === 'Stoke' || field === 'Dampen') {
            const items = {};
            // Format examples: "3 Gasoline", "1 Gasoline, 2 Lighter",
            // "?1 Flamethrower?"  — strip question marks (optional markers).
            const cleaned = rest.replace(/[?]/g, '').trim();
            for (const part of cleaned.split(/,/)) {
                const m = part.trim().match(/^(\d+)\s+(.+)$/);
                if (!m) continue;
                const qty = Number(m[1]);
                const name = m[2].toLowerCase().trim();
                if (qty > 0 && name) items[name] = qty;
            }
            if (Object.keys(items).length === 0) continue;
            if (field === 'Place') out.items = items;
            else if (field === 'Stoke') out.stoke = items;
            else if (field === 'Dampen') out.dampen = items;
        }
    }
    return out;
}

async function existing() {
    const r = await fetch(API);
    const d = await r.json();
    return new Set(Object.keys(d.recipes).map(k => k.toLowerCase()));
}

async function post(key, recipe) {
    const r = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({ key }, recipe)),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
}

const have = await existing();
console.log('arsontest currently has', have.size, 'recipes');

let imported = 0;
let skipped = 0;
let failed = 0;

for (const [name, value] of iterEntries(block)) {
    // value: either array of strings (single variant) or array of arrays (multi)
    const isMulti = Array.isArray(value[0]);
    const variants = isMulti ? value : [value];
    // Take non-flamethrower variant as primary if multi
    let primary = variants[0];
    let flameVariant = null;
    if (isMulti && variants.length > 1) {
        const noFlame = variants.find(v =>
            v.some(line => /Flamethrower:\s*No/i.test(line)));
        const withFlame = variants.find(v =>
            v.some(line => /Flamethrower:\s*Yes/i.test(line)));
        if (noFlame) primary = noFlame;
        if (withFlame && withFlame !== primary) flameVariant = withFlame;
    }

    const recipe = parseVariant(primary);
    if (!recipe.payout || !recipe.items) {
        // No usable data; skip silently
        continue;
    }

    const key = name.toLowerCase();
    if (have.has(key)) { skipped++; continue; }
    try {
        await post(key, recipe);
        imported++;
        console.log('  +', name);
    } catch (e) {
        failed++;
        console.warn('  ! failed:', name, e.message);
    }

    // Also import the flamethrower variant as " (flame)" if both exist
    if (flameVariant) {
        const fr = parseVariant(flameVariant);
        if (fr.payout && fr.items) {
            const fkey = (name + ' (flame)').toLowerCase();
            if (!have.has(fkey)) {
                try {
                    await post(fkey, fr);
                    imported++;
                    console.log('  +', name + ' (flame)');
                } catch (e) {
                    failed++;
                }
            }
        }
    }
}

console.log('done — imported:', imported, ' skipped (already present):', skipped, ' failed:', failed);
