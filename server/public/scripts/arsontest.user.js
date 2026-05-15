// ==UserScript==
// @name         Arson Auto-Extract (test)
// @namespace    tornwar.com
// @version      0.4.0
// @description  Auto-extract per-action profit/nerve on the crimes page — no hardcoded scenario list. Reads payout + item requirements straight from the live DOM so it works on any scenario Torn adds (Restaurant, Aircraft Hangar, etc.) without manual maintenance. Experimental fork of 'Arson bang for buck'.
// @author       RussianRob
// @match        https://www.torn.com/page.php?sid=crimes*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=torn.com
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @connect      api.torn.com
// @downloadURL  https://tornwar.com/scripts/arsontest.user.js
// @updateURL    https://tornwar.com/scripts/arsontest.meta.js
// ==/UserScript==
//
// =============================================================================
// DESIGN
// =============================================================================
// Upstream 'Arson bang for buck' has a hardcoded ~196-scenario lookup table —
// breaks on any scenario Torn adds (Restaurant, Aircraft Hangar were missing).
// This experiment skips the table entirely and extracts everything from the
// live DOM:
//
//   1. Walk every action-option container on the page
//      ([class*="crimeOptionSection___"], hash-agnostic à la FactionOps)
//   2. For each, regex the container's textContent for:
//        - Payout: 'Payout:\s*\$?(\d[\d.,]*)\s*([KMB]?)'
//        - Items:  '(\d+)\s+(Gasoline|Lighter|Hydrogen Tank|...)' patterns
//        - Nerve:  'Nerve:\s*(\d+)' (some scenarios show nerve cost too)
//   3. Look up each item's market_price in our cached itemValues
//   4. profit_per_nerve = (payout - sum(item_price * qty)) / nerve
//   5. Inject a small colored badge on the action option
//
// MutationObserver re-scans on DOM changes so newly-rendered options get
// decorated. Failures log to console and skip the option (no crash).
// =============================================================================

(function () {
    'use strict';

    const VERSION = '0.4.0';
    const LOG = (...a) => console.log('[arsontest v' + VERSION + ']', ...a);
    const WARN = (...a) => console.warn('[arsontest]', ...a);

    // === API Key (separate from upstream so installs don't conflict) ===
    function getApiKey() {
        try { return GM_getValue('arsontest_apiKey', '') || localStorage.getItem('tornApiKey') || ''; }
        catch (_) { return localStorage.getItem('tornApiKey') || ''; }
    }
    function saveApiKey(k) {
        try { GM_setValue('arsontest_apiKey', k); } catch (_) {}
        try { localStorage.setItem('arsontest_apiKey', k); } catch (_) {}
    }

    function askForApiKeyInline() {
        if (document.getElementById('arsontest-keyprompt')) return;
        const c = document.createElement('div');
        c.id = 'arsontest-keyprompt';
        Object.assign(c.style, {
            position: 'fixed', top: '20px', right: '20px', zIndex: '99999',
            background: '#1a1a1a', border: '1px solid #444', borderRadius: '8px',
            padding: '12px', color: '#eee', fontFamily: 'sans-serif', fontSize: '12px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)', maxWidth: '300px',
        });
        c.innerHTML = `
            <div style="font-weight:600;margin-bottom:6px;color:#74c69d;">Arson Auto-Extract — API key</div>
            <div style="margin-bottom:8px;font-size:11px;color:#9ca3af;">Needs a Limited API key to fetch item prices.</div>
            <input id="arsontest-key-in" type="text" placeholder="Paste API key…" style="width:100%;padding:4px;background:#0f1a14;color:#eee;border:1px solid #444;border-radius:4px;margin-bottom:6px;font-size:11px;">
            <button id="arsontest-key-save" style="background:#2d6a4f;color:#fff;border:0;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px;">Save</button>
            <button id="arsontest-key-cancel" style="background:transparent;color:#9ca3af;border:0;padding:4px 8px;cursor:pointer;font-size:11px;">Cancel</button>
        `;
        document.body.appendChild(c);
        c.querySelector('#arsontest-key-save').addEventListener('click', () => {
            const v = c.querySelector('#arsontest-key-in').value.trim();
            if (v) { saveApiKey(v); refreshItemPrices(); }
            c.remove();
        });
        c.querySelector('#arsontest-key-cancel').addEventListener('click', () => c.remove());
    }

    // === Item Prices ===
    let itemValues = {};
    try { itemValues = JSON.parse(localStorage.getItem('arsontest_itemValues') || '{}'); } catch (_) {}
    let itemValuesLastFetch = 0;
    const ITEM_TTL_MS = 6 * 60 * 60 * 1000; // 6h

    function saveItemValues() {
        try { localStorage.setItem('arsontest_itemValues', JSON.stringify(itemValues)); } catch (_) {}
    }

    async function refreshItemPrices(force = false) {
        if (!force && (Date.now() - itemValuesLastFetch) < ITEM_TTL_MS) return;
        const key = getApiKey();
        if (!key) return;
        try {
            const url = 'https://api.torn.com/v2/torn/items?cat=All&sort=ASC&key=' + encodeURIComponent(key);
            const res = await fetch(url);
            const data = await res.json();
            if (data.error) { WARN('Torn API error:', data.error); return; }
            for (const it of (data.items || [])) {
                if (it && it.name && it.value && Number.isFinite(it.value.market_price)) {
                    itemValues[it.name.toLowerCase()] = it.value.market_price;
                }
            }
            saveItemValues();
            itemValuesLastFetch = Date.now();
            LOG('item prices refreshed —', Object.keys(itemValues).length, 'items cached');
            scheduleScan(); // recompute now that we have prices
        } catch (e) { WARN('item price fetch failed', e); }
    }

    // === DOM Extract ===
    // Pull payout, nerve, and items from a single action-option container.
    function parseActionOption(el) {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) return null;

        // Payout: 'Payout: $123,456' / 'Payout: 210K' / 'Payout:1.2M'
        const payMatch = text.match(/Payout:\s*\$?([\d.,]+)\s*([KMB]?)/i);
        if (!payMatch) return null;
        let payout = parseFloat(payMatch[1].replace(/,/g, ''));
        const suffix = (payMatch[2] || '').toUpperCase();
        if (suffix === 'K') payout *= 1_000;
        else if (suffix === 'M') payout *= 1_000_000;
        else if (suffix === 'B') payout *= 1_000_000_000;
        if (!Number.isFinite(payout) || payout <= 0) return null;

        // Nerve: optional, default 0 means we'll use a heuristic
        let nerve = 0;
        const nerveMatch = text.match(/Nerve:\s*(\d+)/i);
        if (nerveMatch) nerve = parseInt(nerveMatch[1], 10);

        // Items: regex any 'N ItemName' that matches a known itemValues key.
        // We do a TWO-PASS lookup so multi-word items (Hydrogen Tank,
        // Molotov Cocktail) win over their single-word prefix matches.
        const items = [];
        const itemNames = Object.keys(itemValues).sort((a, b) => b.length - a.length);
        for (const lowerName of itemNames) {
            // Match '<digits> <itemName>' case-insensitively at word boundaries
            const pattern = new RegExp('\\b(\\d+)\\s+' + lowerName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&'), 'gi');
            let m;
            while ((m = pattern.exec(text.toLowerCase())) !== null) {
                items.push({ name: lowerName, qty: parseInt(m[1], 10) });
                // Blank out matched text so the same digits don't double-count
                // when a shorter item name is a substring of a longer one.
                const start = m.index, end = pattern.lastIndex;
                text.toLowerCase = (() => text.slice(0, start) + ' '.repeat(end - start) + text.slice(end));
            }
        }

        // Heuristic nerve cost from upstream: 10 + 5 * itemCount
        if (!nerve) nerve = 10 + items.reduce((s, i) => s + i.qty, 0) * 5;

        const itemCost = items.reduce((s, i) => s + (itemValues[i.name] || 0) * i.qty, 0);
        const profit = payout - itemCost;
        const profitPerNerve = nerve > 0 ? profit / nerve : 0;

        return { payout, nerve, items, itemCost, profit, profitPerNerve };
    }

    // === Inject Badge ===
    function fmtMoney(n) {
        if (Math.abs(n) >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
        if (Math.abs(n) >= 1_000) return '$' + (n / 1_000).toFixed(1) + 'K';
        return '$' + Math.round(n);
    }

    function decorate(el, info) {
        let badge = el.querySelector(':scope > .arsontest-badge');
        if (!badge) {
            badge = document.createElement('div');
            badge.className = 'arsontest-badge';
            Object.assign(badge.style, {
                position: 'absolute', top: '2px', right: '4px', zIndex: '5',
                pointerEvents: 'none', fontSize: '10px', fontFamily: 'monospace',
                padding: '1px 5px', borderRadius: '3px', fontWeight: '600',
            });
            // Make sure parent is positioned so absolute child anchors here
            const cs = window.getComputedStyle(el);
            if (cs.position === 'static') el.style.position = 'relative';
            el.appendChild(badge);
        }
        const ppn = info.profitPerNerve;
        const color = ppn <= 0 ? '#ef4444' : ppn < 5_000 ? '#f4a261' : ppn < 15_000 ? '#74c69d' : '#a78bfa';
        badge.style.background = 'rgba(0,0,0,0.6)';
        badge.style.color = color;
        badge.textContent = fmtMoney(ppn) + '/n';
        badge.title =
            'Payout: ' + fmtMoney(info.payout) + '\n' +
            'Items: ' + (info.items.length
                ? info.items.map(i => i.qty + 'x ' + i.name + ' (' + fmtMoney(itemValues[i.name] || 0) + ')').join(', ')
                : 'none priced') + '\n' +
            'Cost: ' + fmtMoney(info.itemCost) + '\n' +
            'Nerve: ' + info.nerve + '\n' +
            'Profit/Nerve: ' + fmtMoney(info.profitPerNerve);
    }

    // === Scan ===
    let _scanScheduled = false;
    function scheduleScan() {
        if (_scanScheduled) return;
        _scanScheduled = true;
        setTimeout(() => { _scanScheduled = false; scan(); }, 300);
    }

    function scan() {
        // v0.3: crimeOptionSection___ is just the title strip (text was
        // 'ShackSmoke Out' — scenario name + action name only). The
        // payout + item requirements live in the parent wrapper. Try
        // the wrapper first; fall back to the section.
        let options = document.querySelectorAll('[class*="crimeOptionWrapper___"]');
        if (!options.length) options = document.querySelectorAll('[class*="crimeOptionSection___"]');
        if (!options.length) return;
        let decorated = 0, skipped = 0;
        for (const el of options) {
            try {
                const info = parseActionOption(el);
                if (info) { decorate(el, info); decorated++; }
                else skipped++;
            } catch (e) { WARN('parse failed for option', e); skipped++; }
        }
        LOG('scan: decorated=' + decorated + ' skipped=' + skipped);

        // v0.3 diagnostic: when nothing decorated, dump the first option
        // PLUS its parent chain so we can find where payout + items live.
        if (decorated === 0 && skipped > 0 && !window.__arsontest_dumped) {
            window.__arsontest_dumped = true;
            const first = options[0];
            const text = (first.textContent || '').replace(/\s+/g, ' ').trim();
            console.group('[arsontest] DIAGNOSTIC — first option failed to parse');
            console.log('selector used:', options[0]?.className || '(none)');
            console.log('text (first 500 chars):', text.slice(0, 500));
            console.log('payout regex match:', text.match(/Payout:\s*\$?([\d.,]+)\s*([KMB]?)/i));
            console.log('nerve regex match:', text.match(/Nerve:\s*(\d+)/i));
            // Walk PARENTS — text content gets richer the higher we go.
            console.group('parent chain (each row: classes · textContent length · text preview):');
            let p = first.parentElement;
            for (let i = 0; i < 6 && p; i++) {
                const ptxt = (p.textContent || '').replace(/\s+/g, ' ').trim();
                const cls = (p.className && typeof p.className === 'string')
                    ? p.className.split(' ').filter(c => c.includes('___')).join(', ')
                    : '';
                console.log(`L${i+1}:`, cls || '(no hashed class)', '·', ptxt.length, 'chars ·', ptxt.slice(0, 120));
                p = p.parentElement;
            }
            console.groupEnd();
            console.log('outerHTML (first 1500):', first.outerHTML.slice(0, 1500));
            console.log('item count cached:', Object.keys(itemValues).length);
            console.groupEnd();
        }
    }

    // === v0.4 probe: dump unsafeWindow.torn keys looking for crime data ===
    function probeTornState() {
        if (window.__arsontest_probed) return;
        window.__arsontest_probed = true;
        const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
        if (!W?.torn) {
            LOG('PROBE: window.torn not exposed (data may only flow via XHR/AJAX)');
            return;
        }
        console.group('[arsontest] PROBE — unsafeWindow.torn keys');
        try {
            console.log('top-level keys:', Object.keys(W.torn));
            // Walk a few levels deep looking for anything crime-shaped.
            const interesting = ['crimes', 'crime', 'arson', 'currentCrime', 'scenarios', 'options'];
            const walk = (obj, path, depth) => {
                if (depth > 3 || !obj || typeof obj !== 'object') return;
                for (const k of Object.keys(obj)) {
                    if (interesting.some(w => k.toLowerCase().includes(w))) {
                        const v = obj[k];
                        const preview = typeof v === 'object'
                            ? `{${Object.keys(v || {}).slice(0, 8).join(', ')}}`
                            : String(v).slice(0, 60);
                        console.log(`${path}.${k}:`, preview);
                    }
                    if (depth < 3 && typeof obj[k] === 'object') walk(obj[k], path + '.' + k, depth + 1);
                }
            };
            walk(W.torn, 'torn', 0);
        } catch (e) { WARN('probe failed', e); }
        console.groupEnd();
    }

    // === Init ===
    LOG('starting v' + VERSION);
    if (!getApiKey()) {
        // Wait for body before injecting prompt
        const t = setInterval(() => {
            if (document.body) { clearInterval(t); askForApiKeyInline(); }
        }, 200);
    } else {
        refreshItemPrices();
    }

    // Re-scan on DOM mutations (Torn lazy-renders crime cards)
    const observer = new MutationObserver(() => scheduleScan());
    const startObserver = () => {
        if (document.body) observer.observe(document.body, { childList: true, subtree: true });
        else setTimeout(startObserver, 200);
    };
    startObserver();
    scheduleScan();
    setTimeout(probeTornState, 2000); // wait for React state to populate

    // Public debug handle
    window.__arsontest = {
        version: VERSION,
        scan, refreshItemPrices,
        itemValues, getApiKey,
        rescrapeOption: (el) => parseActionOption(el),
    };
})();
