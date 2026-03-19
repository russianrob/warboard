// ==UserScript==
// @name         Torn – Hide PDA Smart Banner
// @namespace    https://tornwar.com
// @version      1.0.0
// @description  Removes the "Open in Torn PDA" Smart App Banner from Safari on iOS.
// @author       RussianRob
// @match        https://www.torn.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://tornwar.com/scripts/torn-hide-pda-banner.user.js
// @updateURL    https://tornwar.com/scripts/torn-hide-pda-banner.meta.js
// ==/UserScript==

(function () {
    'use strict';
    const meta = document.querySelector('meta[name="apple-itunes-app"]');
    if (meta) meta.remove();

    // Catch late-injected banners (PDA sometimes adds the tag after load)
    const observer = new MutationObserver(() => {
        const m = document.querySelector('meta[name="apple-itunes-app"]');
        if (m) { m.remove(); observer.disconnect(); }
    });
    observer.observe(document.head || document.documentElement, { childList: true, subtree: true });

    // Stop watching after 10 seconds to avoid unnecessary overhead
    setTimeout(() => observer.disconnect(), 10000);
})();
