#!/usr/bin/env node
/**
 * One-shot migration to backfill the `ignite` field on every server
 * recipe whose upstream BFB equivalent had an "Ignite: <tool>" line
 * that the original 2026-05-16 migration dropped.
 *
 * Safe by design:
 *   - Only ADDS the ignite field where the server recipe doesn't
 *     have one. Never overwrites manual edits.
 *   - Doesn't touch items / payout / stoke / dampen / nerve / location.
 *     Item-name typos like "tank" vs "hydrogen tank" stay manual —
 *     reported at the end so the admin can fix in the editor.
 *   - Writes the result back to data/arson-recipes.json with version
 *     bumped + updatedAt refreshed. BFB's wb2 cache (5 min) will see
 *     the new data on next page load.
 *
 * Run: node /opt/warboard/bin/migrate-arson-ignite.js
 */

const fs = require('node:fs');
const path = require('node:path');

const BFB_PATH = path.join(__dirname, '..', 'server', 'scripts', 'arson-bang-for-buck.user.js');
const RECIPES_PATH = path.join(__dirname, '..', 'server', 'data', 'arson-recipes.json');

function extractScenariosBlock(src) {
    // Find `const scenarios = {` and walk the braces to the matching close.
    const start = src.indexOf('const scenarios = {');
    if (start < 0) throw new Error('scenarios const not found in BFB');
    const openBrace = src.indexOf('{', start);
    let depth = 0;
    for (let i = openBrace; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) {
                // Object literal text from { to } inclusive
                return src.slice(openBrace, i + 1);
            }
        }
    }
    throw new Error('unmatched braces walking scenarios object');
}

function loadUpstreamScenarios() {
    const src = fs.readFileSync(BFB_PATH, 'utf8');
    const objText = extractScenariosBlock(src);
    // Wrap in parens so JS treats it as an expression, not a block.
    // It's hand-written JS (unquoted keys, trailing commas, etc.) but
    // node's eval handles all of that.
    // eslint-disable-next-line no-eval
    return eval('(' + objText + ')');
}

/** Parse upstream line array for an Ignite tool. Tolerates the loose
 *  formats upstream uses ("Ignite: Lighter ", "Ignite: lighter or flamethrower"). */
function extractIgniteFromVariant(lines) {
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

/** Walks all variants of an upstream scenario and returns the first
 *  ignite value it finds. Most multi-variant scenarios use the same
 *  ignite tool across variants. */
function extractIgnite(entry) {
    if (!Array.isArray(entry)) return null;
    if (entry.length > 0 && Array.isArray(entry[0])) {
        for (const variant of entry) {
            const ig = extractIgniteFromVariant(variant);
            if (ig) return ig;
        }
        return null;
    }
    return extractIgniteFromVariant(entry);
}

/** Build a lowercase-keyed map of recipe name → upstream ignite tool. */
function buildUpstreamIgniteMap() {
    const scenarios = loadUpstreamScenarios();
    const out = {};
    for (const [name, entry] of Object.entries(scenarios)) {
        const ig = extractIgnite(entry);
        if (ig) out[name.toLowerCase()] = ig;
    }
    return out;
}

function main() {
    const igniteMap = buildUpstreamIgniteMap();
    console.log(`[migrate] upstream BFB has ignite info for ${Object.keys(igniteMap).length} recipes`);

    const recipesRaw = fs.readFileSync(RECIPES_PATH, 'utf8');
    const data = JSON.parse(recipesRaw);
    if (!data || !data.recipes) throw new Error('recipes file malformed');

    let patched = 0;
    let alreadySet = 0;
    let noUpstream = 0;
    const itemTypoReports = [];

    for (const [key, recipe] of Object.entries(data.recipes)) {
        const upstreamIgnite = igniteMap[key];
        if (recipe.ignite && recipe.ignite.trim()) {
            alreadySet++;
        } else if (upstreamIgnite) {
            recipe.ignite = upstreamIgnite;
            patched++;
            console.log(`  + ${key}: ignite=${upstreamIgnite}`);
        } else {
            noUpstream++;
        }
        // Single-word item heuristic for truncated names — reported
        // only, not auto-fixed.
        const items = recipe.items || {};
        for (const name of Object.keys(items)) {
            if (/^(tank|gas|oil)$/i.test(name)) {
                itemTypoReports.push({ key, item: name });
            }
        }
    }

    data.version = (data.version || 1) + 1;
    data.updatedAt = Date.now();

    // Write back atomically: write to a tmp file in the same dir,
    // then rename. Avoids torn writes if the process is killed mid-write.
    const tmp = RECIPES_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, RECIPES_PATH);

    console.log('');
    console.log(`[migrate] done — version bumped to ${data.version}`);
    console.log(`  patched (added ignite):  ${patched}`);
    console.log(`  already had ignite:      ${alreadySet}`);
    console.log(`  no upstream ignite info: ${noUpstream}`);
    if (itemTypoReports.length > 0) {
        console.log('');
        console.log('[migrate] suspected truncated item names (manual fix in editor):');
        for (const r of itemTypoReports) {
            console.log(`  ${r.key}: items contain "${r.item}"`);
        }
    }
}

main();
