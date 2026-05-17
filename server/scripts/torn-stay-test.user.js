// ==UserScript==
// @name         Stay Loading Test
// @namespace    tornwar.com
// @version      0.1.0
// @description  Tiny diagnostic stub — flashes a green pill on Torn pages to confirm Stay/Safari is injecting our scripts. If you see this but NOT the FactionOps/OC Spawn pills, the issue is script size, not Stay setup.
// @author       RussianRob
// @match        https://www.torn.com/factions.php*
// @match        https://www.torn.com/war.php*
// @grant        none
// @run-at       document-end
// @downloadURL  https://tornwar.com/scripts/torn-stay-test.user.js
// @updateURL    https://tornwar.com/scripts/torn-stay-test.meta.js
// ==/UserScript==

(function () {
    'use strict';

    try {
        console.log('[STAY-TEST] script entered IIFE');
    } catch (_) {}

    var mount = function () {
        try {
            if (document.getElementById('wb-stay-test-pill')) return;
            var p = document.createElement('div');
            p.id = 'wb-stay-test-pill';
            p.textContent = 'STAY TEST v0.1.0 loaded';
            p.style.cssText = 'position:fixed;top:88px;left:8px;z-index:2147483647;background:#10b981;color:#fff;font:bold 12px/1.2 -apple-system,system-ui,sans-serif;padding:6px 10px;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,0.4);pointer-events:none;';
            (document.body || document.documentElement).appendChild(p);
            setTimeout(function () { try { p.remove(); } catch (_) {} }, 10000);
        } catch (_) {}
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount, { once: true });
    } else {
        mount();
    }
})();
