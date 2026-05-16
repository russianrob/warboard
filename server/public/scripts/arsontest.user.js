// ==UserScript==
// @name         Arson Recipe Sandbox (test)
// @namespace    tornwar.com
// @version      0.8.16
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
// 0.8.16 — User: 'on some locations i cant click to get scenario because
//          theres no rdcipe like church snd waste facility'. arson-bang-
//          for-buck only creates a tooltip for scenarios in its hardcoded
//          `scenarios` table. Church/Waste Facility scenarios aren't in
//          it, so no .custom-tooltip ever appears, and v0.8.15's header
//          prepender has nothing to attach to.
//          Fallback: 150ms after the card click, if no .custom-tooltip
//          is visible, show our own popup with the scenario name. Skip
//          button taps (Ignite/Collect/etc) using the same exclusion
//          list arson-bang-for-buck uses.
// 0.8.15 — User: 'same shows receipe tooltip on image click'. v0.8.14's
//          capture-phase img-target delegate still wasn't firing — likely
//          because the user's tap target isn't an <img> element (Torn
//          frequently uses background-image CSS on divs, so closest('img')
//          returns null).
//          New approach: stop fighting arson-bang-for-buck. Piggyback on
//          its tooltip instead.
//            (1) Capture-phase click listener records which crime card
//                was last clicked (_lastClickedCard).
//            (2) MutationObserver watches every .custom-tooltip element
//                (arson-bang-for-buck's tooltip class). When one switches
//                to display:flex, prepend a green 'Location · Scenario'
//                header line at the top, taking the scenario name from
//                the tracked card.
//          Result: ONE tooltip with BOTH the scenario name AND the
//          recipe details. No duplicate popups, no click-handler war.
// 0.8.14 — User: 'clicking on image brings up receipe tootip not scenario
//          tooltip'. v0.8.12 attached click handler per <img> and called
//          e.stopPropagation(). Two failures:
//            (1) arson-bang-for-buck's section-level handler still fired
//                (maybe the click target wasn't the img — could be an
//                overlay/wrapper inside the card).
//            (2) My popup included the recipe one-liner under the
//                scenario name, which looked like a duplicate of the
//                existing recipe tooltip from arson-bang-for-buck.
//          Fix:
//            (a) Single document-level click listener with capture:true.
//                Runs BEFORE every bubble-phase handler in the page.
//                stopImmediatePropagation prevents the event from
//                reaching arson-bang-for-buck's section handler.
//            (b) Popup now shows ONLY the scenario (action) name. Recipe
//                details belong to arson-bang-for-buck's tooltip.
//          setImageTitles() still runs per-tick to keep title='Action'
//          and cursor:pointer for desktop UX.
// 0.8.13 — User: 'for recipe tool doesnt show stoke option'. Added stoke
//          (boost) items to the recipe schema. In Torn arson, after a
//          crime is ignited a second player can 'stoke' it with extra
//          items to boost the payout — that's a separate ingredient
//          list from the ignite list.
//          Schema now: { items, stoke?, payout, nerve?, location? }
//          Editor: new optional 'stoke items' input next to 'ignite items'.
//          List render + tooltip popup: shows ' / stoke: 2 gasoline'
//          after the ignite items.
//          Server (routes.js): POST accepts body.stoke (same shape as
//          items), preserves existing stoke when an update omits it.
// 0.8.12 — User: 'maybe add a tooltip for the image on the left? because
//          scenario isnt working'. v0.8.11's inline text rewrite also
//          didn't show — every inline approach has failed because an
//          ancestor of scenario___ collapses to zero height.
//          New UX: tap the location card's <img> to pop a tooltip with
//          'Location · Action Name' (and recipe info if the action is
//          in RECIPES). Floating div positioned via getBoundingClientRect,
//          flips above if it'd overflow the viewport, dismisses on next
//          tap outside.
//          stopPropagation on the image click so we don't fight arson-
//          bang-for-buck's section-level click handler (which fires on
//          the rest of the card for its ingredient tooltip).
//          Also sets img.title for desktop browser-native hover tooltip.
// 0.8.11 — v0.8.10 dump showed scenario___ has display:block visibility:
//          visible opacity:1 fontSize:11px text present — but offsetH=0.
//          Means an ANCESTOR (titleAndScenario___ or higher) collapses
//          to zero height regardless of child styles. CSS rules on the
//          scenario element can't fix that.
//          New approach: rewrite the LOCATION div's text content. The
//          location div is visible to the user ('Forgery Workshop'),
//          so appending ' · Shielded from the Truth' to it makes the
//          action visible WITHOUT fighting hidden ancestors.
//          Idempotent — won't re-apply if location text already has ' · '.
// 0.8.10 — Debug dump from v0.8.9 revealed offsetHeight=0 on scenario
//          elements DESPITE display:block visibility:visible opacity:1
//          inline. That means PDA's CSS is hiding inner CONTENT
//          (font-size:0 on descendants, or display:none on the inner
//          <b> tag where the text-walker found the recipe text).
//          Inline style on the container can't fix descendants. Solution:
//          inject a global <style> rule targeting [class*="scenario___"]
//          AND `[class*="scenario___"] *` so descendants are also
//          force-shown. CSS rule lives in <head> — survives React
//          reconciliation. Debug also enhanced to dump innerHTML and
//          firstChild computed style so next round we can see what's
//          inside.
// 0.8.9 — Added Debug button to the editor (next to Save/Refresh). When
//         tapped it dumps to a green-on-black textarea:
//           - count of every candidate selector
//           - first 3 titleAndScenario wrappers' outerHTML
//           - first 3 scenario elements' text/class/computed style/parent
//           - text-walker scan for the first 5 RECIPES keys (where they
//             actually live in the DOM, what tag, what class)
//         User on PDA can screenshot this and share so I can see what
//         PDA's actual DOM looks like — we're working blind otherwise.
// 0.8.8 — v0.8.7 still didn't render visibly ('i still dont see it').
//         Triple-redundant approach so something has to land:
//           (a) force-unhide the existing scenario___ element with
//               inline !important (inline beats stylesheet rules per CSS
//               spec; safe to set display/visibility/opacity — doesn't
//               change positioning context like the v0.6 'position:
//               relative' regression did)
//           (b) inject a plain div INSIDE the wrapper
//           (c) ALSO insert a plain div AS NEXT SIBLING of the wrapper
//               — escapes any wrapper-level overflow/max-height/clip-path
//         FORCE_VISIBLE style string covers display, visibility, opacity,
//         height, overflow, clip, clip-path, transform, position, width,
//         font-size, color — defeats every common CSS hide pattern.
// 0.8.7 — User: 'like in the desktop view'. They just want the action
//         name visible under the location, same as desktop. v0.8.6 was
//         overcomplicating with formatRecipeLine (location · items ·
//         payout · nerve). Simpler: pull text from the hidden
//         scenario___ child and render it in a plain visible div. No
//         RECIPES lookup needed — works on every card regardless of
//         whether the recipe is in our DB.
// 0.8.6 — User: 'i only see location but i dont see scenario'. The action
//         element IS in the DOM (confirmed in the PDA dump user pasted)
//         but Torn's PDA CSS HIDES anything with the scenario___ class.
//         v0.8.5 cloned that hidden element — the clone inherited the
//         hiding rule and was invisible too. Fix: build a fresh <div>
//         with NO scenario___ class and explicit !important styling so
//         PDA CSS can't override it.
// 0.8.5 — User showed full PDA DOM:
//           <div class="titleAndScenario___...">
//             <div>Forgery Workshop</div>                  ← location (NO class)
//             <div class="scenario___...">Shielded...</div> ← action
//           </div>
//         The LOCATION child has NO class — only the action carries
//         scenario___. Previous versions queried [class*="scenario___"]
//         and only saw 1 element per wrapper, then bailed out thinking
//         "PDA hides the second one". Both are present, but unclassed.
//         Fix: skip the wrapper-counting heuristic entirely. Target the
//         scenario___ element directly (it IS the action), look up
//         RECIPES[text], inject sibling label with recipe details after it.
//         Auto-capture (desktop) now iterates direct children of the
//         wrapper instead of querySelectorAll('[class*="scenario___"]')
//         so it can see the unclassed location child too.
// 0.8.4 — PDA scenario is the ACTION not the location. User showed actual PDA DOM:
//         <div class="scenario___DtvAZ">Shielded from the Truth</div>
//         — that's an ACTION name (recipe key), not a location. v0.8.2
//         assumed the visible PDA scenario was the location and tried to
//         filter recipes by .location matching, which returned zero
//         matches and skipped every card.
//         Now: look up RECIPES[visibleText.toLowerCase()] directly; if
//         hit, render location · items · payout next to it. Falls back
//         to old location-based lookup if the text isn't a recipe key.
//         Also made auto-capture (desktop) order-agnostic — identifies
//         action vs location by which one matches a RECIPES key.
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

    const VERSION = '0.8.16';
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
                    <input id="arsontest-ed-items" placeholder="ignite items: gasoline:3 lighter:1" style="background:#0f1a14;color:#eee;border:1px solid #444;border-radius:4px;padding:5px;font-size:11px;">
                    <input id="arsontest-ed-stoke" placeholder="stoke items (optional): gasoline:2" style="background:#0f1a14;color:#eee;border:1px solid #444;border-radius:4px;padding:5px;font-size:11px;">
                    <div style="display:flex;gap:6px;">
                        <input id="arsontest-ed-payout" type="number" placeholder="payout (e.g. 280000)" style="background:#0f1a14;color:#eee;border:1px solid #444;border-radius:4px;padding:5px;font-size:11px;flex:1;">
                        <input id="arsontest-ed-nerve" type="number" placeholder="nerve (optional)" style="background:#0f1a14;color:#eee;border:1px solid #444;border-radius:4px;padding:5px;font-size:11px;flex:1;">
                    </div>
                    <div style="display:flex;gap:6px;">
                        <button id="arsontest-ed-save" style="background:#2d6a4f;color:#fff;border:0;border-radius:4px;padding:6px 12px;font-size:11px;font-weight:600;cursor:pointer;flex:1;">Save</button>
                        <button id="arsontest-ed-refresh" style="background:#374151;color:#fff;border:0;border-radius:4px;padding:6px 12px;font-size:11px;cursor:pointer;">Refresh</button>
                        <button id="arsontest-ed-debug" style="background:#7c2d12;color:#fff;border:0;border-radius:4px;padding:6px 12px;font-size:11px;cursor:pointer;">🔍 Debug</button>
                    </div>
                    <span id="arsontest-ed-status" style="color:#9ca3af;font-size:10px;min-height:14px;"></span>
                    <textarea id="arsontest-ed-debug-out" style="display:none;background:#000;color:#0f0;border:1px solid #444;border-radius:4px;padding:6px;font-size:10px;font-family:monospace;width:100%;height:200px;white-space:pre;overflow:auto;"></textarea>
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
                overlay.querySelector('#arsontest-ed-stoke').value = r.stoke
                    ? Object.entries(r.stoke).map(([n, q]) => n + ':' + q).join(' ')
                    : '';
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
        overlay.querySelector('#arsontest-ed-debug').addEventListener('click', () => {
            const ta = overlay.querySelector('#arsontest-ed-debug-out');
            ta.style.display = 'block';
            const lines = [];
            lines.push('=== arsontest v' + VERSION + ' DOM dump ===');
            lines.push('UA: ' + navigator.userAgent.slice(0, 100));
            lines.push('');
            // Try several selectors
            const probes = [
                '[class*="titleAndScenario___"]',
                '[class*="scenario___"]',
                '[class*="crimeOptionSection___"]',
                '[class*="title___"]',
                '[class*="sections___"]',
                '[class*="crimeOption"]',
                '[class*="ArsonScenario"]',
            ];
            for (const sel of probes) {
                const n = document.querySelectorAll(sel).length;
                lines.push(sel + ' → ' + n + ' match' + (n === 1 ? '' : 'es'));
            }
            lines.push('');
            // Dump first 3 titleAndScenario wrappers (if any)
            const wraps = document.querySelectorAll('[class*="titleAndScenario___"]');
            lines.push('--- titleAndScenario wrappers (first 3) ---');
            for (let i = 0; i < Math.min(3, wraps.length); i++) {
                lines.push('[' + i + '] ' + wraps[i].outerHTML.slice(0, 400));
                lines.push('');
            }
            // Dump first 3 scenario elements (if any) — include inner
            // structure so we can see what's wrapped inside the
            // scenario___ container.
            const scens = document.querySelectorAll('[class*="scenario___"]');
            lines.push('--- scenario elements (first 3) ---');
            for (let i = 0; i < Math.min(3, scens.length); i++) {
                const el = scens[i];
                const cs = window.getComputedStyle(el);
                lines.push('[' + i + '] text="' + el.textContent.trim() + '"');
                lines.push('    class=' + el.className);
                lines.push('    display=' + cs.display + ' vis=' + cs.visibility + ' op=' + cs.opacity + ' h=' + cs.height + ' offsetH=' + el.offsetHeight + ' fontSize=' + cs.fontSize);
                lines.push('    innerHTML=' + el.innerHTML.slice(0, 200));
                // Inspect first descendant element if any
                const firstChild = el.firstElementChild;
                if (firstChild) {
                    const ccs = window.getComputedStyle(firstChild);
                    lines.push('    firstChild=<' + firstChild.tagName + ' class="' + (firstChild.className || '') + '"> display=' + ccs.display + ' vis=' + ccs.visibility + ' fontSize=' + ccs.fontSize + ' offsetH=' + firstChild.offsetHeight);
                } else {
                    lines.push('    (no child element; textNode only)');
                }
                lines.push('');
            }
            // Find any element that contains a known recipe key in its text
            lines.push('--- text-search for recipe keys ---');
            const keys = Object.keys(RECIPES).slice(0, 5);
            for (const k of keys) {
                const matches = [];
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
                    acceptNode: n => n.nodeValue.toLowerCase().includes(k.toLowerCase())
                        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
                });
                let count = 0;
                while (walker.nextNode() && count < 2) { count++; matches.push(walker.currentNode.parentElement?.tagName + '.' + (walker.currentNode.parentElement?.className || '?')); }
                lines.push('"' + k + '" → ' + count + ' match(es) ' + matches.join(', '));
            }
            ta.value = lines.join('\n');
            ta.select();
        });
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
            const stokeStr = overlay.querySelector('#arsontest-ed-stoke').value.trim();
            const payout = Number(overlay.querySelector('#arsontest-ed-payout').value);
            const nerve = Number(overlay.querySelector('#arsontest-ed-nerve').value);
            if (!key) { status('Need a name', '#ef4444'); return; }
            if (!Number.isFinite(payout) || payout <= 0) { status('Need a payout > 0', '#ef4444'); return; }
            const items = parseItemsString(itemsStr);
            if (Object.keys(items).length === 0) { status('Need at least 1 item (e.g. gasoline:3)', '#ef4444'); return; }
            const recipe = { items, payout };
            if (Number.isFinite(nerve) && nerve > 0) recipe.nerve = nerve;
            if (location) recipe.location = location;
            const stoke = parseItemsString(stokeStr);
            if (Object.keys(stoke).length > 0) recipe.stoke = stoke;
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

    // === Inject recipe details next to PDA scenario names ====================
    // v0.8.4: Corrected — PDA renders the ACTION name in the single
    // visible scenario___ child (not the location). Example user-confirmed
    // markup: <div class="scenario___DtvAZ">Shielded from the Truth</div>
    // — "Shielded from the Truth" is an action name (recipe key), not a
    // location. So look up RECIPES[text.toLowerCase()] directly and append
    // the recipe's location + items + payout.
    //
    // Fallback: if the visible text doesn't match an action key, try the
    // old "treat as location" lookup so this still works for any scenario
    // child that happens to be a location.
    //
    // Hard rules to avoid the v0.6 'broke the tooltip' regression:
    //   - Only APPEND new children (never modify existing element style or
    //     position)
    //   - Mark each wrapper with data-arsontest-injected so the
    //     MutationObserver doesn't double-add
    //   - Skip wrappers that already have 2+ scenario children (desktop
    //     view where Torn renders both)
    function formatItems(items) {
        return Object.entries(items).map(([n, q]) => q + ' ' + n).join(', ');
    }
    function formatRecipeLine(recipe) {
        const itemsStr = formatItems(recipe.items);
        const stokeStr = recipe.stoke
            ? ' / stoke: ' + formatItems(recipe.stoke)
            : '';
        const payoutStr = recipe.payout >= 1000
            ? '$' + Math.round(recipe.payout / 1000) + 'K'
            : '$' + recipe.payout;
        const nerveStr = recipe.nerve ? (' · ' + recipe.nerve + 'N') : '';
        const locStr = recipe.location ? recipe.location + ' · ' : '';
        return locStr + itemsStr + stokeStr + ' · ' + payoutStr + nerveStr;
    }
    // Reusable item-string parser ("gasoline:3 lighter:1" or "3 gasoline, 1 lighter")
    function parseItemsString(str) {
        const out = {};
        const tokens = String(str || '').split(/[,\s]+/).filter(Boolean);
        for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i];
            if (t.includes(':')) {
                const [n, q] = t.split(':');
                const qty = Number(q);
                if (n && Number.isFinite(qty) && qty > 0) out[n.toLowerCase()] = qty;
            } else if (/^\d+$/.test(t) && tokens[i+1]) {
                const qty = Number(t);
                const n = tokens[++i];
                if (n && qty > 0) out[n.toLowerCase()] = qty;
            }
        }
        return out;
    }
    // v0.8.10: Inject a global stylesheet rule that force-shows
    // scenario___ AND its descendants. The v0.8.9 debug dump revealed
    // offsetHeight=0 even with display:block visibility:visible inline
    // — meaning PDA's CSS is hiding the INNER content (font-size:0 on
    // children, or display:none on descendants). Inline styles only
    // hit the container element; a stylesheet rule can target
    // `scenario___ *` to unhide descendants too. CSS rule also survives
    // React re-renders, unlike DOM-mutation injects which get
    // reconciled away.
    function injectGlobalScenarioCss() {
        if (document.getElementById('arsontest-scenario-show-css')) return;
        const s = document.createElement('style');
        s.id = 'arsontest-scenario-show-css';
        s.textContent = `
            [class*="titleAndScenario___"] > *,
            [class*="scenario___"],
            [class*="scenario___"] * {
                display: revert !important;
                visibility: visible !important;
                opacity: 1 !important;
                height: auto !important;
                min-height: 0 !important;
                max-height: none !important;
                overflow: visible !important;
                clip: auto !important;
                clip-path: none !important;
                transform: none !important;
                font-size: revert !important;
                line-height: revert !important;
                color: inherit !important;
                width: auto !important;
                max-width: none !important;
            }
            [class*="scenario___"] {
                display: block !important;
                font-size: 11px !important;
                line-height: 1.3 !important;
                color: #999 !important;
                margin-top: 1px !important;
            }
        `;
        (document.head || document.documentElement).appendChild(s);
    }

    // v0.8.11: Forget trying to unhide the scenario___ element. The
    // v0.8.10 dump showed it has display:block visibility:visible
    // opacity:1 fontSize:11px text-content present — yet offsetHeight=0.
    // That means an ANCESTOR (the titleAndScenario___ wrapper or higher)
    // is collapsed to zero height regardless of the child's own styles.
    //
    // The LOCATION div (the unclassed one — "Forgery Workshop") IS
    // visible to the user. So append the action name to the location
    // div's text. No fighting with hidden ancestors.
    function rewriteLocationText() {
        const wrappers = document.querySelectorAll('[class*="titleAndScenario___"]');
        let rewritten = 0;
        for (const w of wrappers) {
            try {
                const children = Array.from(w.children);
                // The location is the child WITHOUT scenario___ class.
                const locationDiv = children.find(c =>
                    !c.className || !String(c.className).includes('scenario___'));
                const actionDiv = children.find(c =>
                    c.className && String(c.className).includes('scenario___'));
                if (!locationDiv || !actionDiv) continue;
                const loc = locationDiv.textContent.trim();
                const action = actionDiv.textContent.trim();
                if (!loc || !action) continue;
                // Don't re-apply if our marker is already present.
                if (locationDiv.textContent.includes(' · ')) continue;
                locationDiv.textContent = loc + ' · ' + action;
                rewritten++;
            } catch (e) { /* skip */ }
        }
        if (rewritten > 0) LOG('rewrote', rewritten, 'location label(s) with action name');
    }

    // v0.8.12: Tap-on-image tooltip. Inline text approaches all failed
    // because PDA collapses something up the ancestor chain. Instead,
    // attach a tap handler to the location-card's <img> (visible on the
    // left of every card) that pops up a floating tooltip with the
    // action name + recipe details (if known). stopPropagation so we
    // don't fight arson-bang-for-buck's section-level click handler.
    function showActionPopup(text, anchor) {
        document.querySelectorAll('.arsontest-action-popup').forEach(el => el.remove());
        const tt = document.createElement('div');
        tt.className = 'arsontest-action-popup';
        tt.textContent = text;
        Object.assign(tt.style, {
            position: 'fixed', background: '#0f1a14', color: '#74c69d',
            border: '1px solid #2d6a4f', borderRadius: '6px',
            padding: '6px 10px', fontSize: '12px', fontWeight: '600',
            lineHeight: '1.3', zIndex: '99999',
            boxShadow: '0 4px 14px rgba(0,0,0,0.6)',
            maxWidth: '75vw', whiteSpace: 'normal',
        });
        document.body.appendChild(tt);
        const r = anchor.getBoundingClientRect();
        const ttR = tt.getBoundingClientRect();
        // Position below the anchor, but flip up if it'd run off-screen.
        let top = r.bottom + 4;
        if (top + ttR.height > window.innerHeight - 8) top = r.top - ttR.height - 4;
        let left = r.left;
        if (left + ttR.width > window.innerWidth - 8) left = window.innerWidth - ttR.width - 8;
        if (left < 8) left = 8;
        tt.style.top = top + 'px';
        tt.style.left = left + 'px';
        // Dismiss on next tap outside.
        setTimeout(() => {
            const dismiss = (ev) => {
                if (!tt.contains(ev.target)) {
                    tt.remove();
                    document.removeEventListener('click', dismiss, true);
                    document.removeEventListener('touchstart', dismiss, true);
                }
            };
            document.addEventListener('click', dismiss, true);
            document.addEventListener('touchstart', dismiss, true);
        }, 50);
    }

    // v0.8.15: Piggyback on arson-bang-for-buck's tooltip instead of
    // trying to fight it. arson-bang-for-buck creates a div with class
    // 'custom-tooltip', appends it to document.body, and toggles
    // tooltip.style.display = 'flex' when shown. We:
    //   (1) Track the most-recently-clicked crime card via a capture-
    //       phase click listener.
    //   (2) Watch every .custom-tooltip element. When it switches to
    //       display:flex, prepend a green 'Scenario: X' header line
    //       (taking X from the tracked card's scenario___ child).
    // User gets ONE tooltip with both the scenario name AND the
    // recipe details — no duplicate popups, no fighting over click
    // handlers.
    let _lastClickedCard = null;
    function installCardClickTracker() {
        document.addEventListener('click', (e) => {
            try {
                // Ignore taps on interactive elements (commit/collect buttons,
                // inputs, links). Match arson-bang-for-buck's exclusion list.
                if (e.target.closest && e.target.closest('button, a, input, select, textarea, [role="button"]')) return;
                const card = e.target.closest && e.target.closest('[class*="sections___"]');
                if (!card) return;
                _lastClickedCard = card;
                // Fallback: 150ms after the click, if no .custom-tooltip
                // became visible (i.e. arson-bang-for-buck doesn't have
                // this scenario in its table — e.g. Church, Waste
                // Facility), show our own popup with just the scenario
                // name. Skip if our own popup is already up.
                setTimeout(() => {
                    const visible = document.querySelector('.custom-tooltip[style*="display: flex"]');
                    if (visible) return; // arson-bang-for-buck handled it
                    if (document.querySelector('.arsontest-action-popup')) return;
                    const wrapper = card.querySelector('[class*="titleAndScenario___"]');
                    if (!wrapper) return;
                    const actionDiv = wrapper.querySelector('[class*="scenario___"]');
                    const action = actionDiv ? actionDiv.textContent.trim() : '';
                    if (!action) return;
                    const locDiv = Array.from(wrapper.children).find(c =>
                        !c.className || !String(c.className).includes('scenario___'));
                    const loc = locDiv ? locDiv.textContent.trim().replace(/ ·.*$/, '') : '';
                    const text = loc ? loc + ' · ' + action : action;
                    // Anchor popup to the card so it positions naturally
                    showActionPopup(text, card);
                }, 150);
            } catch (_) {}
        }, true); // capture so we see the click before arson-bang-for-buck
    }

    function prependScenarioHeader(tooltipEl) {
        if (!_lastClickedCard) return;
        if (tooltipEl.querySelector('.arsontest-scenario-header')) return;
        const wrapper = _lastClickedCard.querySelector('[class*="titleAndScenario___"]');
        if (!wrapper) return;
        const actionDiv = wrapper.querySelector('[class*="scenario___"]');
        const action = actionDiv ? actionDiv.textContent.trim() : '';
        if (!action) return;
        const locDiv = Array.from(wrapper.children).find(c =>
            !c.className || !String(c.className).includes('scenario___'));
        const loc = locDiv ? locDiv.textContent.trim().replace(/ ·.*$/, '') : '';
        const header = document.createElement('div');
        header.className = 'arsontest-scenario-header';
        header.textContent = loc ? loc + ' · ' + action : action;
        header.style.cssText = [
            'color:#74c69d !important',
            'font-weight:700 !important',
            'font-size:13px !important',
            'border-bottom:1px solid #444 !important',
            'margin:-2px -4px 6px -4px !important',
            'padding:2px 4px 4px 4px !important',
        ].join(';');
        tooltipEl.insertBefore(header, tooltipEl.firstChild);
    }

    function watchTooltip(tt) {
        if (tt.dataset.arsontestWatched) return;
        tt.dataset.arsontestWatched = '1';
        // Initial check (in case it's already display:flex)
        if (tt.style.display === 'flex') prependScenarioHeader(tt);
        const obs = new MutationObserver(() => {
            if (tt.style.display === 'flex') prependScenarioHeader(tt);
        });
        obs.observe(tt, { attributes: true, attributeFilter: ['style'] });
    }

    function installTooltipPiggyback() {
        // Catch existing tooltips
        document.querySelectorAll('.custom-tooltip').forEach(watchTooltip);
        // Catch new tooltips added to body by arson-bang-for-buck
        const bodyObs = new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;
                    if (node.classList && node.classList.contains('custom-tooltip')) {
                        watchTooltip(node);
                    }
                    // Also catch tooltips nested inside added subtrees
                    if (node.querySelectorAll) {
                        node.querySelectorAll('.custom-tooltip').forEach(watchTooltip);
                    }
                }
            }
        });
        if (document.body) bodyObs.observe(document.body, { childList: true, subtree: false });
        else setTimeout(installTooltipPiggyback, 500);
        LOG('tooltip piggyback installed — will prepend scenario name to .custom-tooltip');
    }

    // Hover-tooltip on desktop via img.title — quick and free, no delegation
    // needed. Runs from MutationObserver tick. Sets cursor to pointer too
    // so the user knows the image is interactive on touch devices.
    function setImageTitles() {
        document.querySelectorAll('[class*="titleAndScenario___"]:not([data-arsontest-titled])').forEach(w => {
            try {
                const actionDiv = w.querySelector('[class*="scenario___"]');
                if (!actionDiv) return;
                const action = actionDiv.textContent.trim();
                if (!action) return;
                const card = w.closest('[class*="sections___"]');
                if (!card) return;
                const img = card.querySelector('img');
                if (!img) return;
                img.title = action;
                img.style.cursor = 'pointer';
                w.dataset.arsontestTitled = '1';
            } catch (_) {}
        });
    }

    function injectPdaActionNames() {
        // v0.8.8: v0.8.7 still didn't render visibly. Three redundant
        // approaches so at least one survives whatever PDA CSS is doing:
        //   (a) Force-unhide the existing scenario___ element with
        //       inline !important — inline beats any stylesheet rule.
        //       Setting display/visibility/opacity does NOT change
        //       positioning context (the v0.6 regression was caused by
        //       el.style.position='relative'); these are safe.
        //   (b) Inject a fresh sibling div INSIDE the wrapper.
        //   (c) ALSO insert a div AFTER the wrapper (as next sibling
        //       of the wrapper itself) — escapes any parent overflow,
        //       max-height, or clip-path the wrapper might apply.
        const FORCE_VISIBLE = [
            'display:block !important',
            'visibility:visible !important',
            'opacity:1 !important',
            'height:auto !important',
            'min-height:0 !important',
            'max-height:none !important',
            'overflow:visible !important',
            'clip:auto !important',
            'clip-path:none !important',
            'transform:none !important',
            'position:static !important',
            'width:auto !important',
            'max-width:none !important',
            'font-size:11px !important',
            'line-height:1.3 !important',
            'color:#999 !important',
            'white-space:normal !important',
            'margin:1px 0 !important',
            'padding:0 !important',
        ].join(';');

        const wrappers = document.querySelectorAll('[class*="titleAndScenario___"]:not([data-arsontest-injected])');
        let injected = 0;
        for (const w of wrappers) {
            try {
                const actionEl = w.querySelector('[class*="scenario___"]:not([data-arsontest-injected-action])');
                if (!actionEl) continue;
                const actionText = actionEl.textContent.trim();
                if (!actionText) continue;

                // (a) Force the original scenario element visible.
                actionEl.style.cssText += ';' + FORCE_VISIBLE;

                // (b) Inject inside the wrapper.
                const inside = document.createElement('div');
                inside.setAttribute('data-arsontest-injected-action', '1');
                inside.textContent = actionText;
                inside.style.cssText = FORCE_VISIBLE;
                w.appendChild(inside);

                // (c) Inject as next sibling of the wrapper (escapes any
                // parent overflow/clip the wrapper itself might apply).
                const outside = document.createElement('div');
                outside.setAttribute('data-arsontest-injected-action-outside', '1');
                outside.textContent = actionText;
                outside.style.cssText = FORCE_VISIBLE;
                if (w.parentElement) {
                    w.insertAdjacentElement('afterend', outside);
                }

                w.dataset.arsontestInjected = '1';
                injected++;
            } catch (e) { /* skip malformed cards silently */ }
        }
        if (injected > 0) LOG('injected', injected, 'action name(s) into crime cards (3 paths)');
    }

    // === Auto-capture location ↔ action from desktop DOM =====================
    // v0.8.3: User has 117/123 recipes with no `location` field set. Manual
    // backfill is fragile because arson-bang-for-buck's source has no
    // location data — only `action → variants`. Solution: on desktop the
    // titleAndScenario___ wrapper renders BOTH children. v0.8.4 confirms
    // ordering by checking each: whichever matches a RECIPE key is the
    // action; the other is the location.
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
                // v0.8.5: The location child has NO class — only the action
                // has scenario___. So iterate ALL direct children of the
                // wrapper, not just scenario___-classed ones. Identify
                // action by RECIPES key match.
                const childTexts = Array.from(w.children)
                    .filter(c => !c.hasAttribute('data-arsontest-injected-action'))
                    .map(c => c.textContent.trim())
                    .filter(Boolean);
                if (childTexts.length < 2) continue;
                let action = null, location = null;
                for (const t of childTexts) {
                    if (RECIPES[t.toLowerCase()]) { action = t; }
                    else if (!location) { location = t; }
                }
                if (!action || !location) continue;
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
            autoCaptureLocations();   // desktop: learn location↔action
            setImageTitles();         // desktop hover + cursor cue
            rewriteLocationText();    // fallback: write action into visible location div
            injectPdaActionNames();   // belt-and-braces inject
        }, 400);
    }
    function watchForCards() {
        if (!document.body) { setTimeout(watchForCards, 500); return; }
        const obs = new MutationObserver(() => scheduleInject());
        obs.observe(document.body, { childList: true, subtree: true });
    }

    // === Init ===
    LOG('starting v' + VERSION);
    injectGlobalScenarioCss();
    installCardClickTracker();      // v0.8.15: record which card was last clicked
    installTooltipPiggyback();      // v0.8.15: prepend scenario name to arson-bang-for-buck tooltip
    setImageTitles();               // desktop hover + cursor pointer
    rewriteLocationText();          // fallback
    injectPdaActionNames();         // belt-and-braces
    watchForCards();
    fetchRecipes().then(() => autoCaptureLocations());
    setTimeout(injectGearButton, 500);
})();
