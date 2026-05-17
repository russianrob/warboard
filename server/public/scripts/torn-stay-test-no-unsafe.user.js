// ==UserScript==
// @name         Stay Loading Test (no unsafeWindow)
// @namespace    tornwar.com
// @version      0.1.0
// @description  Fourth diagnostic stub — same as grants-only but without unsafeWindow. If this yellow pill loads, unsafeWindow alone is the Stay killer. If it doesn't, the killer is GM_xmlhttpRequest / GM_setValue / GM_getValue / GM_addStyle / GM_setClipboard.
// @author       RussianRob
// @match        https://www.torn.com/factions.php*
// @match        https://www.torn.com/war.php*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @connect      tornwar.com
// @run-at       document-idle
// @downloadURL  https://tornwar.com/scripts/torn-stay-test-no-unsafe.user.js
// @updateURL    https://tornwar.com/scripts/torn-stay-test-no-unsafe.meta.js
// ==/UserScript==

(function () {
    'use strict';

    try {
        console.log('[STAY-TEST-NO-UNSAFE] script entered IIFE');
    } catch (_) {}

    var mount = function () {
        try {
            if (document.getElementById('wb-stay-test-no-unsafe-pill')) return;
            var p = document.createElement('div');
            p.id = 'wb-stay-test-no-unsafe-pill';
            p.textContent = 'STAY TEST (no unsafeWindow) v0.1.0 loaded';
            p.style.cssText = 'position:fixed;top:208px;left:8px;z-index:2147483647;background:#eab308;color:#000;font:bold 12px/1.2 -apple-system,system-ui,sans-serif;padding:6px 10px;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,0.4);pointer-events:none;';
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
