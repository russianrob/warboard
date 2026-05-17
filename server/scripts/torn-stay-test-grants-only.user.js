// ==UserScript==
// @name         Stay Loading Test (grants only)
// @namespace    tornwar.com
// @version      0.1.0
// @description  Third diagnostic stub — has factionops's @grant block but NO @require and NO @connect wildcard. If this purple pill loads but the orange one (grants+require) didn't, the killer is @require or @connect *. If this also doesn't load, the killer is one of the @grants.
// @author       RussianRob
// @match        https://www.torn.com/factions.php*
// @match        https://www.torn.com/war.php*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @connect      tornwar.com
// @run-at       document-idle
// @downloadURL  https://tornwar.com/scripts/torn-stay-test-grants-only.user.js
// @updateURL    https://tornwar.com/scripts/torn-stay-test-grants-only.meta.js
// ==/UserScript==

(function () {
    'use strict';

    try {
        console.log('[STAY-TEST-GRANTS-ONLY] script entered IIFE');
    } catch (_) {}

    var mount = function () {
        try {
            if (document.getElementById('wb-stay-test-grants-only-pill')) return;
            var p = document.createElement('div');
            p.id = 'wb-stay-test-grants-only-pill';
            p.textContent = 'STAY TEST (grants only) v0.1.0 loaded';
            p.style.cssText = 'position:fixed;top:168px;left:8px;z-index:2147483647;background:#a855f7;color:#fff;font:bold 12px/1.2 -apple-system,system-ui,sans-serif;padding:6px 10px;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,0.4);pointer-events:none;';
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
