// ==UserScript==
// @name         Stay Loading Test (grants + require)
// @namespace    tornwar.com
// @version      0.1.0
// @description  Diagnostic stub mirroring factionops's @grant block + @require to isolate whether Stay rejection is caused by metadata directives vs script size. If this loads (orange pill) but factionops/oc-spawn don't, the cause is size. If this doesn't load either, the cause is a @grant or @require Stay no longer supports.
// @author       RussianRob
// @match        https://www.torn.com/factions.php*
// @match        https://www.torn.com/war.php*
// @require      https://tornwar.com/socket.io/socket.io.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @connect      tornwar.com
// @connect      localhost
// @connect      *
// @run-at       document-idle
// @downloadURL  https://tornwar.com/scripts/torn-stay-test-grants.user.js
// @updateURL    https://tornwar.com/scripts/torn-stay-test-grants.meta.js
// ==/UserScript==

(function () {
    'use strict';

    try {
        console.log('[STAY-TEST-GRANTS] script entered IIFE; io typeof =', typeof io);
    } catch (_) {}

    var mount = function () {
        try {
            if (document.getElementById('wb-stay-test-grants-pill')) return;
            var p = document.createElement('div');
            p.id = 'wb-stay-test-grants-pill';
            p.textContent = 'STAY TEST (grants+require) v0.1.0 loaded';
            p.style.cssText = 'position:fixed;top:128px;left:8px;z-index:2147483647;background:#f97316;color:#fff;font:bold 12px/1.2 -apple-system,system-ui,sans-serif;padding:6px 10px;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,0.4);pointer-events:none;';
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
