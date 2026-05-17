// ==UserScript==
// @name         Stay Loading Test (page injection)
// @namespace    tornwar.com
// @version      0.1.0
// @description  Proves the <script>-tag injection + postMessage round-trip works on Torn. If the magenta pill says PAGE-CONTEXT-OK, the injection approach is viable for refactoring factionops + oc-spawn to drop @grant unsafeWindow. If it says BLOCKED, Torn's CSP rejects inline scripts and option 2 doesn't work.
// @author       RussianRob
// @match        https://www.torn.com/factions.php*
// @match        https://www.torn.com/war.php*
// @grant        none
// @run-at       document-end
// @downloadURL  https://tornwar.com/scripts/torn-stay-test-inject.user.js
// @updateURL    https://tornwar.com/scripts/torn-stay-test-inject.meta.js
// ==/UserScript==

(function () {
    'use strict';

    var pageScriptRan = false;

    // Listen for the page-context script to message back
    window.addEventListener('message', function (ev) {
        try {
            if (ev.source !== window) return;
            if (!ev.data || ev.data.__wbProbe !== 'wb_stay_inject_test') return;
            pageScriptRan = true;
        } catch (_) {}
    });

    // Inject a tiny page-context script that posts a message back
    try {
        var s = document.createElement('script');
        s.textContent = '(function(){try{window.postMessage({__wbProbe:"wb_stay_inject_test",ok:true,location:String(typeof location!=="undefined")},"*");}catch(e){}})();';
        (document.head || document.documentElement).appendChild(s);
        s.remove();
    } catch (e) {
        try { console.error('[STAY-TEST-INJECT] injection threw:', e && e.message); } catch (_) {}
    }

    function mount() {
        try {
            if (document.getElementById('wb-stay-test-inject-pill')) return;
            // Wait up to 500ms for the postMessage round trip
            setTimeout(function () {
                var p = document.createElement('div');
                p.id = 'wb-stay-test-inject-pill';
                p.textContent = pageScriptRan
                    ? 'STAY TEST INJECT: PAGE-CONTEXT-OK'
                    : 'STAY TEST INJECT: BLOCKED (no roundtrip)';
                p.style.cssText = 'position:fixed;top:248px;left:8px;z-index:2147483647;background:'
                    + (pageScriptRan ? '#d946ef' : '#dc2626')
                    + ';color:#fff;font:bold 12px/1.2 -apple-system,system-ui,sans-serif;padding:6px 10px;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,0.4);pointer-events:none;';
                (document.body || document.documentElement).appendChild(p);
                setTimeout(function () { try { p.remove(); } catch (_) {} }, 15000);
            }, 500);
        } catch (_) {}
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount, { once: true });
    } else {
        mount();
    }
})();
