// ==UserScript==
// @name         Arson Recipe Sandbox (test)
// @namespace    tornwar.com
// @version      0.8.3
// @description  Lightweight recipe-editor UI for arson scenarios. Floating ⚙ button on the crimes page opens a panel to add / edit / delete server-hosted recipes (tornwar.com). NO DOM modification of crime options — leaves the upstream 'arson-bang-for-buck' tooltip / hover behavior completely untouched.
// @author       RussianRob
// @match        https://www.torn.com/page.php?sid=crimes*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=torn.com
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @downloadURL  https://tornwar.com/scripts/arsontest.user.js
// @updateURL    https://tornwar.com/scripts/arsontest.meta.js
// ==/UserScript==
//
// =============================================================================
// CHANGELOG
// =============================================================================
// 0.8.3 — Auto-capture location ↔ action pairs from desktop DOM. Only 5/123
//         recipes had a `location` field set, and backfilling manually is
//         fragile because arson-bang-for-buck's source contains no
//         location data. On desktop the titleAndScenario___ wrapper
//         renders both scenario___ children (location + action). Capture
//         those pairs and POST updated recipes to the server. One desktop
//         crime-page visit backfills every action that's on screen.
//         Safe-by-default: only POSTs when the captured location differs
//         from the existing entry, and only for actions that already
//         exist in RECIPES — never invents new recipe keys.
// 0.8.2 — Inject action names next to PDA location names (v0.8.1's
//         CSS-only override didn't work because Torn omits the element
//         on PDA rather than CSS-hiding it). Clones the existing
//         scenario element so styling inherits.
// 0.8.0 — Added `location` field to recipe schema + editor sorts list
//         by location then action. Backfilled 6 known locations.
// 0.7.0 — Stripped to a pure recipe editor. v0.6 was still scanning the
//         page DOM and adding profit/nerve badges to each crime option,
//         and to anchor the badge it set el.style.position = 'relative'
//         on the option container — which broke the upstream
//         arson-bang-for-buck tooltip positioning. User: 'when you
//         created the recipe tool in arsontest it disabled the tooltip
//         hover/click so i cant see any when i click on the arson
//         crime'. Removed all DOM-touching code (parseActionOption,
//         decorate, scan, MutationObserver, API key prompt, item-price
//         fetch). The script now ONLY: (a) injects a floating ⚙ button
//         and (b) reads/writes recipes via the tornwar.com server. The
//         crime options are untouched, so the upstream tooltips work.
// 0.6.0 — Server-cached recipes + editor UI (had unintended DOM side
//         effect — fixed in 0.7).
// 0.5.x — Hand-curated recipe table sandbox.
// 0.4.x — Auto-extract experiments (DOM scrape, unsafeWindow probe).
//         All confirmed dead ends — Torn doesn't expose per-action
//         data anywhere client-accessible.
// =============================================================================

(function () {
    'use strict';

    const VERSION = '0.8.3';
    const SERVER = 'https://tornwar.com';
    const LOG = (...a) => console.log('[arsontest v' + VERSION + ']', ...a);
    const WARN = (...a) => console.warn('[arsontest]', ...a);

    // === Recipes — server-cached, editable via UI ============================
    let RECIPES = {}; // lazy-populated from server fetch on first editor open

    const RECIPE_TTL_MS = 10 * 60 * 1000;
    function loadCachedRecipes() {
        try {
            const raw = localStorage.getItem('arsontest_recipes_cache');
            if (!raw) return null;
            const obj = JSON.parse(raw);
            if (Date.now() - (obj.cachedAt || 0) < RECIPE_TTL_MS) return obj;
        } catch (_) {}
        return null;
    }
    async function fetchRecipes(forceFresh = false) {
        if (!forceFresh) {
            const cached = loadCachedRecipes();
            if (cached?.data?.recipes) {
                RECIPES = cached.data.recipes;
                return;
            }
        }
        try {
            const data = await new Promise((resolve, reject) => {
                if (typeof GM_xmlhttpRequest === 'function') {
                    GM_xmlhttpRequest({
                        method: 'GET', url: SERVER + '/api/arson/recipes',
                        onload: r => { try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(e); } },
                        onerror: reject, timeout: 8000,
                    });
                } else {
                    fetch(SERVER + '/api/arson/recipes').then(r => r.json()).then(resolve).catch(reject);
                }
            });
            if (data?.recipes) {
                RECIPES = data.recipes;
                try { localStorage.setItem('arsontest_recipes_cache', JSON.stringify({ data, cachedAt: Date.now() })); } catch (_) {}
                LOG('recipes fetched from server:', Object.keys(RECIPES).length);
            }
        } catch (e) { WARN('recipe fetch failed:', e?.message || e); }
    }
    async function postRecipe(key, recipe) {
        const body = JSON.stringify(Object.assign({ key }, recipe));
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest === 'function') {
                GM_xmlhttpRequest({
                    method: 'POST', url: SERVER + '/api/arson/recipes',
                    headers: { 'Content-Type': 'application/json' }, data: body,
                    onload: r => {
                        try {
                            const d = JSON.parse(r.responseText);
                            r.status >= 200 && r.status < 300 ? resolve(d) : reject(new Error(d.error || ('HTTP ' + r.status)));
                        } catch (e) { reject(e); }
                    },
                    onerror: () => reject(new Error('network')), timeout: 8000,
                });
            } else {
                fetch(SERVER + '/api/arson/recipes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
                    .then(r => r.json().then(d => r.ok ? resolve(d) : reject(new Error(d.error || 'HTTP ' + r.status))))
                    .catch(reject);
            }
        });
    }
    async function deleteRecipe(key) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest === 'function') {
                GM_xmlhttpRequest({
                    method: 'DELETE', url: SERVER + '/api/arson/recipes/' + encodeURIComponent(key),
                    onload: r => r.status >= 200 && r.status < 300 ? resolve() : reject(new Error('HTTP ' + r.status)),
                    onerror: () => reject(new Error('network')), timeout: 8000,
                });
            } else {
                fetch(SERVER + '/api/arson/recipes/' + encodeURIComponent(key), { method: 'DELETE' })
                    .then(r => r.ok ? resolve() : reject(new Error('HTTP ' + r.status)))
                    .catch(reject);
            }
        });
    }

    // === Recipe Editor UI ===
    async function openRecipeEditor() {
        if (document.getElementById('arsontest-editor')) return;
        await fetchRecipes(); // ensure we have latest before showing

        const overlay = document.createElement('div');
        overlay.id = 'arsontest-editor';
        Object.assign(overlay.style, {
            position: 'fixed', inset: '0', zIndex: '99998', background: 'rgba(0,0,0,0.7)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
        });
        overlay.innerHTML = `
            <div style="background:#1a1a1a;border:1px solid #444;border-radius:8px;padding:14px;color:#eee;font-family:sans-serif;font-size:12px;width:92vw;max-width:520px;max-height:88vh;display:flex;flex-direction:column;gap:10px;">
                <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #333;padding-bottom:6px;">
                    <span style="font-weight:600;color:#74c69d;font-size:13px;">Arson Recipes</span>
                    <button id="arsontest-ed-close" style="background:none;border:0;color:#eee;font-size:18px;cursor:pointer;">✕</button>
                </div>
                <div id="arsontest-ed-list" style="overflow-y:auto;display:flex;flex-direction:column;gap:4px;max-height:40vh;font-family:monospace;font-size:11px;"></div>
                <div style="border-top:1px solid #333;padding-top:8px;display:flex;flex-direction:column;gap:6px;">
                    <span style="font-weight:600;color:#a78bfa;">Add / update</span>
                    <input id="arsontest-ed-key" placeholder="action name (e.g. spirit level)" style="background:#0f1a14;color:#eee;border:1px solid #444;border-radius:4px;padding:5px;font-size:11px;">
                    <input id="arsontest-ed-loc" placeholder="location (e.g. Apartment, Lakehouse)" style="background:#0f1a14;color:#eee;border:1px solid #444;border-radius:4px;padding:5px;font-size:11px;">
                    <input id="arsontest-ed-items" placeholder="items: gasoline:3 lighter:1" style="background:#0f1a14;color:#eee;border:1px solid #444;border-radius:4px;padding:5px;font-size:11px;">
                    <div style="display:flex;gap:6px;">
                        <input id="arsontest-ed-payout" type="number" placeholder="payout (e.g. 280000)" style="background:#0f1a14;color:#eee;border:1px solid #444;border-radius:4px;padding:5px;font-size:11px;flex:1;">
                        <input id="arsontest-ed-nerve" type="number" placeholder="nerve (optional)" style="background:#0f1a14;color:#eee;border:1px solid #444;border-radius:4px;padding:5px;font-size:11px;flex:1;">
                    </div>
                    <div style="display:flex;gap:6px;">
                        <button id="arsontest-ed-save" style="background:#2d6a4f;color:#fff;border:0;border-radius:4px;padding:6px 12px;font-size:11px;font-weight:600;cursor:pointer;flex:1;">Save</button>
                        <button id="arsontest-ed-refresh" style="background:#374151;color:#fff;border:0;border-radius:4px;padding:6px 12px;font-size:11px;cursor:pointer;">Refresh</button>
                    </div>
                    <span id="arsontest-ed-status" style="color:#9ca3af;font-size:10px;min-height:14px;"></span>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        const status = (msg, color) => {
            const s = overlay.querySelector('#arsontest-ed-status');
            s.textContent = msg; s.style.color = color || '#9ca3af';
        };
        const renderList = () => {
            const list = overlay.querySelector('#arsontest-ed-list');
            // Sort by location first (entries without location sink), then action.
            const entries = Object.entries(RECIPES).sort((a, b) => {
                const la = (a[1].location || '￿~~~').toLowerCase();
                const lb = (b[1].location || '￿~~~').toLowerCase();
                if (la !== lb) return la < lb ? -1 : 1;
                return a[0] < b[0] ? -1 : 1;
            });
            if (!entries.length) { list.innerHTML = '<div style="color:#6b7280;">No recipes yet.</div>'; return; }
            list.innerHTML = entries.map(([k, r]) => {
                const itemsStr = Object.entries(r.items).map(([n, q]) => q + ' ' + n).join(', ');
                const nerveStr = r.nerve ? (' · ' + r.nerve + 'N') : '';
                const locStr = r.location
                    ? `<span style="color:#f4a261;font-weight:700;">${r.location}</span> · `
                    : `<span style="color:#6b7280;font-style:italic;">(no location)</span> · `;
                return `<div style="display:flex;justify-content:space-between;gap:6px;padding:3px 0;border-bottom:1px solid #2a2a2a;">
                    <span style="color:#d1d5db;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${r.location ? r.location + ' / ' : ''}${k}\n${itemsStr}\n$${r.payout.toLocaleString()}${nerveStr}">
                        ${locStr}<b>${k}</b> · <span style="color:#9ca3af;">${itemsStr}</span> · <span style="color:#74c69d;">$${(r.payout/1000).toFixed(0)}K</span>${nerveStr}
                    </span>
                    <button class="arsontest-ed-edit" data-k="${k}" style="background:transparent;border:1px solid #444;color:#a78bfa;border-radius:3px;padding:1px 6px;font-size:10px;cursor:pointer;">edit</button>
                    <button class="arsontest-ed-del" data-k="${k}" style="background:transparent;border:1px solid #4a1a1a;color:#ef4444;border-radius:3px;padding:1px 6px;font-size:10px;cursor:pointer;">del</button>
                </div>`;
            }).join('');
            list.querySelectorAll('.arsontest-ed-edit').forEach(b => b.addEventListener('click', () => {
                const k = b.dataset.k; const r = RECIPES[k];
                overlay.querySelector('#arsontest-ed-key').value = k;
                overlay.querySelector('#arsontest-ed-loc').value = r.location || '';
                overlay.querySelector('#arsontest-ed-items').value = Object.entries(r.items).map(([n, q]) => n + ':' + q).join(' ');
                overlay.querySelector('#arsontest-ed-payout').value = r.payout;
                overlay.querySelector('#arsontest-ed-nerve').value = r.nerve || '';
                status('Editing ' + k);
            }));
            list.querySelectorAll('.arsontest-ed-del').forEach(b => b.addEventListener('click', async () => {
                const k = b.dataset.k;
                if (!confirm('Delete recipe "' + k + '"?')) return;
                try {
                    await deleteRecipe(k);
                    delete RECIPES[k];
                    try { localStorage.removeItem('arsontest_recipes_cache'); } catch (_) {}
                    status('Deleted ' + k, '#74c69d');
                    renderList();
                } catch (e) { status('Delete failed: ' + e.message, '#ef4444'); }
            }));
        };
        renderList();
        overlay.querySelector('#arsontest-ed-close').addEventListener('click', () => overlay.remove());
        overlay.querySelector('#arsontest-ed-refresh').addEventListener('click', async () => {
            status('Fetching…');
            try { localStorage.removeItem('arsontest_recipes_cache'); } catch (_) {}
            await fetchRecipes(true);
            renderList();
            status('Refreshed (' + Object.keys(RECIPES).length + ' recipes)', '#74c69d');
        });
        overlay.querySelector('#arsontest-ed-save').addEventListener('click', async () => {
            const key = overlay.querySelector('#arsontest-ed-key').value.trim().toLowerCase();
            const location = overlay.querySelector('#arsontest-ed-loc').value.trim();
            const itemsStr = overlay.querySelector('#arsontest-ed-items').value.trim();
            const payout = Number(overlay.querySelector('#arsontest-ed-payout').value);
            const nerve = Number(overlay.querySelector('#arsontest-ed-nerve').value);
            if (!key) { status('Need a name', '#ef4444'); return; }
            if (!Number.isFinite(payout) || payout <= 0) { status('Need a payout > 0', '#ef4444'); return; }
            // Parse items: "gasoline:3 lighter:1" or "3 gasoline, 1 lighter"
            const items = {};
            const tokens = itemsStr.split(/[,\s]+/).filter(Boolean);
            for (let i = 0; i < tokens.length; i++) {
                const t = tokens[i];
                if (t.includes(':')) {
                    const [n, q] = t.split(':');
                    const qty = Number(q);
                    if (n && Number.isFinite(qty) && qty > 0) items[n.toLowerCase()] = qty;
                } else if (/^\d+$/.test(t) && tokens[i+1]) {
                    const qty = Number(t);
                    const n = tokens[++i];
                    if (n && qty > 0) items[n.toLowerCase()] = qty;
                }
            }
            if (Object.keys(items).length === 0) { status('Need at least 1 item (e.g. gasoline:3)', '#ef4444'); return; }
            const recipe = { items, payout };
            if (Number.isFinite(nerve) && nerve > 0) recipe.nerve = nerve;
            if (location) recipe.location = location;
            try {
                await postRecipe(key, recipe);
                RECIPES[key] = recipe;
                try { localStorage.removeItem('arsontest_recipes_cache'); } catch (_) {}
                status('Saved ' + key, '#74c69d');
                renderList();
            } catch (e) { status('Save failed: ' + e.message, '#ef4444'); }
        });
    }

    function injectGearButton() {
        if (document.getElementById('arsontest-gear')) return;
        if (!document.body) { setTimeout(injectGearButton, 500); return; }
        const btn = document.createElement('button');
        btn.id = 'arsontest-gear';
        btn.title = 'Edit arson recipes';
        btn.textContent = '⚙';
        Object.assign(btn.style, {
            position: 'fixed', bottom: '20px', right: '20px', zIndex: '99997',
            width: '40px', height: '40px', borderRadius: '50%',
            background: '#2d6a4f', color: '#fff', border: '0',
            fontSize: '20px', cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
        });
        btn.addEventListener('click', openRecipeEditor);
        document.body.appendChild(btn);
    }

    // === Inject action names next to PDA location names ======================
    // v0.8.2: v0.8.1's CSS-only override didn't help — Torn doesn't just
    // hide the action-name element on PDA, it omits it from the DOM
    // entirely (only the LOCATION scenario___ child renders).
    //
    // This injection finds each titleAndScenario___ wrapper, reads the
    // location name from the single scenario___ child, looks up matching
    // recipes from arsontest RECIPES, and appends a CLONE of the existing
    // scenario element with the action names as text. Cloning inherits
    // all Torn classes/CSS so the injected label looks native.
    //
    // Hard rules to avoid the v0.6 'broke the tooltip' regression:
    //   - Only APPEND new children (never modify existing element style or
    //     position)
    //   - Mark each wrapper with data-arsontest-injected so the
    //     MutationObserver doesn't double-add
    //   - Skip wrappers that already have 2+ scenario children (desktop
    //     view where Torn renders both)
    function injectPdaActionNames() {
        if (!RECIPES || Object.keys(RECIPES).length === 0) return;
        const wrappers = document.querySelectorAll('[class*="titleAndScenario___"]:not([data-arsontest-injected])');
        let injected = 0;
        for (const w of wrappers) {
            try {
                const scenarios = w.querySelectorAll('[class*="scenario___"]');
                // Desktop already shows both — skip
                if (scenarios.length >= 2) { w.dataset.arsontestInjected = '1'; continue; }
                if (scenarios.length === 0) continue;
                const locationName = scenarios[0].textContent.trim();
                if (!locationName) continue;
                const matches = Object.entries(RECIPES).filter(([_, r]) =>
                    r.location && r.location.toLowerCase() === locationName.toLowerCase());
                if (matches.length === 0) continue;
                // Clone the location element (preserves Torn's class set + CSS)
                const clone = scenarios[0].cloneNode(false);
                const actionNames = matches.map(([k]) => k).join(' / ');
                clone.textContent = actionNames;
                clone.setAttribute('data-arsontest-injected-action', '1');
                clone.style.cssText += 'opacity:0.8;';
                w.appendChild(clone);
                w.dataset.arsontestInjected = '1';
                injected++;
            } catch (e) { /* skip malformed cards silently */ }
        }
        if (injected > 0) LOG('injected', injected, 'action name(s) into location cards');
    }

    // === Auto-capture location ↔ action from desktop DOM =====================
    // v0.8.3: User has 117/123 recipes with no `location` field set. Manual
    // backfill is fragile because arson-bang-for-buck's source has no
    // location data — only `action → variants`. Solution: on desktop the
    // titleAndScenario___ wrapper renders BOTH children
    // (scenarios[0] = location, scenarios[1] = action). Capture these
    // pairs once and POST any new mappings back to the server. One
    // desktop crime-page visit backfills every action that's currently
    // visible on the screen.
    //
    // Safe to run on every page: only POSTs when the captured location
    // differs from (or is missing on) the existing RECIPES entry, and
    // only for actions that ALREADY exist in RECIPES (we never invent a
    // new recipe key — that's the editor's job).
    const _capturedThisSession = new Set();
    async function autoCaptureLocations() {
        if (!RECIPES || Object.keys(RECIPES).length === 0) return;
        const wrappers = document.querySelectorAll('[class*="titleAndScenario___"]');
        for (const w of wrappers) {
            try {
                const scenarios = w.querySelectorAll('[class*="scenario___"]');
                // Need both children — desktop only. Skip our own injected
                // clone (marked with data-arsontest-injected-action).
                if (scenarios.length < 2) continue;
                if (scenarios[1].hasAttribute('data-arsontest-injected-action')) continue;
                const location = scenarios[0].textContent.trim();
                const action = scenarios[1].textContent.trim();
                if (!location || !action) continue;
                const key = action.toLowerCase();
                if (_capturedThisSession.has(key)) continue;
                const existing = RECIPES[key];
                if (!existing) continue; // never invent recipes
                if (existing.location &&
                    existing.location.toLowerCase() === location.toLowerCase()) {
                    _capturedThisSession.add(key);
                    continue; // already correct
                }
                // POST updated recipe with location field
                const updated = Object.assign({}, existing, { location });
                _capturedThisSession.add(key);
                postRecipe(key, updated).then(() => {
                    RECIPES[key] = updated;
                    try { localStorage.removeItem('arsontest_recipes_cache'); } catch (_) {}
                    LOG('auto-captured location:', action, '→', location);
                }).catch(e => WARN('auto-capture POST failed for', action, e.message));
            } catch (e) { /* skip malformed cards */ }
        }
    }

    // Re-run on DOM mutations (Torn lazy-renders cards). Debounced so we
    // don't churn during heavy renders.
    let _injectTimer = null;
    function scheduleInject() {
        if (_injectTimer) return;
        _injectTimer = setTimeout(() => {
            _injectTimer = null;
            autoCaptureLocations(); // desktop: learn
            injectPdaActionNames(); // PDA: show
        }, 400);
    }
    function watchForCards() {
        if (!document.body) { setTimeout(watchForCards, 500); return; }
        const obs = new MutationObserver(() => scheduleInject());
        obs.observe(document.body, { childList: true, subtree: true });
    }

    // === Init ===
    LOG('starting v' + VERSION);
    // Fetch recipes first so capture/injection have data to match against.
    fetchRecipes().then(() => {
        autoCaptureLocations();
        injectPdaActionNames();
        watchForCards();
    });
    setTimeout(injectGearButton, 500);
})();
