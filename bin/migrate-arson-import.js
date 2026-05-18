#!/usr/bin/env node
/**
 * One-shot import of upstream BFB recipes that the 2026-05-16
 * migration missed. Audit found 108 such recipes — decimal payouts
 * (31.5K, 4.2K) and others apparently fell through the original
 * parser's holes. This script re-imports them with a more robust
 * parser, lands them in server/data/arson-recipes.json, and leaves
 * every existing recipe untouched (never overwrites user edits).
 *
 * Per-recipe extraction:
 *   - payout: handles "Payout: 31.5K", "Payout:1.2K", "Payout: $190K"
 *   - items (Place line): "Place: 2 Gasoline, 1 Kerosene" or
 *                         "Place: 1 Hydrogen Tank" — comma-split first
 *                         so multi-word names survive, then qty-prefix
 *                         pattern fallback for legacy "2 Gas 1 Lit" lines
 *   - stoke / dampen: same parser as items
 *   - flamethrower: bool from "Flamethrower: Yes/No"
 *   - ignite: string from "Ignite: <tool>" when present
 *
 * Variant picking: for multi-variant scenarios, picks the variant with
 * the highest payout-per-action ratio (proxy for profit/nerve when
 * material cost data isn't available at script time).
 *
 * After running: PM2 reload warboard to refresh the in-memory recipe
 * cache so /api/arson/recipes returns the new data on next fetch.
 *
 * Run: node /opt/warboard/bin/migrate-arson-import.js
 */

const fs = require('node:fs');
const path = require('node:path');

const BFB_PATH = path.join(__dirname, '..', 'server', 'scripts', 'arson-bang-for-buck.user.js');
const RECIPES_PATH = path.join(__dirname, '..', 'server', 'data', 'arson-recipes.json');

function extractScenariosBlock(src) {
    const start = src.indexOf('const scenarios = {');
    if (start < 0) throw new Error('scenarios const not found in BFB');
    const openBrace = src.indexOf('{', start);
    let depth = 0;
    for (let i = openBrace; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(openBrace, i + 1);
        }
    }
    throw new Error('unmatched braces walking scenarios object');
}

function loadUpstreamScenarios() {
    const src = fs.readFileSync(BFB_PATH, 'utf8');
    const objText = extractScenariosBlock(src);
    // eslint-disable-next-line no-eval
    return eval('(' + objText + ')');
}

/** Parse "Payout: 31.5K" / "Payout:1.2K" / "Payout: $190K" into integer. */
function parsePayout(line) {
    if (!line) return 0;
    const m = String(line).match(/Payout\s*:\s*\$?\s*([\d.]+)\s*([kKmMbB]?)/);
    if (!m) return 0;
    const num = parseFloat(m[1]);
    if (!Number.isFinite(num)) return 0;
    const s = (m[2] || '').toLowerCase();
    const mult = s === 'b' ? 1e9 : s === 'm' ? 1e6 : s === 'k' ? 1e3 : 1;
    return Math.round(num * mult);
}

/** Strip the "Place:" / "Stoke:" / "Dampen:" label and any
 *  "?...?" optional markup, leaving just the items body. */
function stripLabelAndOptionals(line) {
    if (!line) return '';
    const body = String(line).replace(/^[A-Za-z/]+:\s*/, '').trim();
    return body.replace(/\?[^?]+\?/g, '').trim();
}

/** Parse "2 Gasoline, 1 Hydrogen Tank" → {gasoline: 2, "hydrogen tank": 1}.
 *  Comma-split first so multi-word names survive; falls back to
 *  greedy "qty name+ qty name+ ..." regex for legacy unpunctuated lines. */
function parseItemsFromLine(line) {
    const out = {};
    const cleaned = stripLabelAndOptionals(line);
    if (!cleaned) return out;

    // Strategy 1: comma-separated segments
    const segments = cleaned.split(',').map(s => s.trim()).filter(Boolean);
    if (segments.length > 1 || (segments.length === 1 && segments[0].match(/^\d+\s+/))) {
        for (const seg of segments) {
            const m = seg.match(/^(\d+)\s+(.+)$/);
            if (m) {
                const qty = parseInt(m[1], 10);
                const name = m[2].trim().toLowerCase();
                if (name && qty > 0) out[name] = qty;
            }
        }
        if (Object.keys(out).length > 0) return out;
    }

    // Strategy 2: greedy multi-item regex for "2 Gasoline 1 Lighter"
    // Matches each "qty word(s)" run until next number prefix
    const re = /(\d+)\s+([A-Za-z]+(?:\s+[A-Za-z]+)*?)(?=\s+\d+\s+[A-Za-z]|\s*$)/g;
    let m;
    while ((m = re.exec(cleaned)) !== null) {
        const qty = parseInt(m[1], 10);
        const name = m[2].trim().toLowerCase();
        if (name && qty > 0) out[name] = qty;
    }
    return out;
}

function parseFlamethrower(line) {
    if (!line) return false;
    return /:\s*yes/i.test(line);
}

/** Pull ignite tool from a variant's lines. Tolerates "Ignite: Lighter "
 *  and similar loose formats. */
function parseIgnite(lines) {
    if (!Array.isArray(lines)) return null;
    for (const line of lines) {
        if (typeof line !== 'string') continue;
        const m = line.match(/^Ignite\s*:\s*(.+?)\s*$/i);
        if (m) {
            const val = m[1].toLowerCase().trim();
            if (val) return val;
        }
    }
    return null;
}

function variantToRecipe(variant) {
    if (!Array.isArray(variant)) return null;
    const find = (re) => variant.find(l => typeof l === 'string' && re.test(l));
    const payoutLine = find(/^Payout\s*:/i);
    const placeLine = find(/^Place\s*:/i);
    const stokeLine = find(/^Stoke\s*:/i);
    const dampenLine = find(/^Dampen\s*:/i);
    const flameLine = find(/^Flamethrower\s*:/i);

    const payout = parsePayout(payoutLine);
    if (payout <= 0) return null;

    const items = parseItemsFromLine(placeLine);
    if (Object.keys(items).length === 0) return null;

    const r = { items, payout };
    const stoke = parseItemsFromLine(stokeLine);
    if (Object.keys(stoke).length > 0) r.stoke = stoke;
    const dampen = parseItemsFromLine(dampenLine);
    if (Object.keys(dampen).length > 0) r.dampen = dampen;
    if (parseFlamethrower(flameLine)) r.flamethrower = true;
    const ignite = parseIgnite(variant);
    if (ignite) r.ignite = ignite;
    return r;
}

/** Pick the variant with the highest payout-per-action ratio (rough
 *  proxy for profit/nerve when we can't see material costs). */
function pickBestVariant(entry) {
    if (!Array.isArray(entry)) return null;
    const variants = Array.isArray(entry[0]) ? entry : [entry];
    let best = null;
    let bestScore = -Infinity;
    for (const v of variants) {
        const r = variantToRecipe(v);
        if (!r) continue;
        const itemQty = Object.values(r.items).reduce((s, q) => s + q, 0)
                       + Object.values(r.stoke || {}).reduce((s, q) => s + q, 0)
                       + Object.values(r.dampen || {}).reduce((s, q) => s + q, 0)
                       + (r.flamethrower ? 1 : 0)
                       + (r.ignite ? 1 : 0);
        const score = itemQty > 0 ? r.payout / itemQty : r.payout;
        if (score > bestScore) {
            bestScore = score;
            best = r;
        }
    }
    return best;
}

function main() {
    const scenarios = loadUpstreamScenarios();
    console.log(`[import] upstream BFB has ${Object.keys(scenarios).length} scenarios`);

    const data = JSON.parse(fs.readFileSync(RECIPES_PATH, 'utf8'));
    if (!data || !data.recipes) throw new Error('recipes file malformed');
    const serverKeys = new Set(Object.keys(data.recipes));

    let added = 0;
    let skippedAlreadyExists = 0;
    let skippedNoData = 0;

    for (const [name, entry] of Object.entries(scenarios)) {
        const key = name.toLowerCase().trim();
        if (serverKeys.has(key)) { skippedAlreadyExists++; continue; }
        const recipe = pickBestVariant(entry);
        if (!recipe) { skippedNoData++; continue; }
        data.recipes[key] = recipe;
        const flame = recipe.flamethrower ? ' flame=Y' : '';
        const ignite = recipe.ignite ? ` ignite=${recipe.ignite}` : '';
        console.log(`  + ${key}: $${recipe.payout} ${JSON.stringify(recipe.items)}${flame}${ignite}`);
        added++;
    }

    data.version = (data.version || 1) + 1;
    data.updatedAt = Date.now();

    const tmp = RECIPES_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, RECIPES_PATH);

    console.log('');
    console.log(`[import] done — version bumped to ${data.version}`);
    console.log(`  added (new recipes):           ${added}`);
    console.log(`  skipped (already on server):   ${skippedAlreadyExists}`);
    console.log(`  skipped (no parseable data):   ${skippedNoData}`);
    console.log('');
    console.log('Next: pm2 reload warboard  # so in-memory cache picks up new file');
}

main();
