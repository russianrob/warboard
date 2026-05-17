// ==UserScript==
// @name         Torn Fast Slots (tornwar fork)
// @namespace    tornwar.com
// @version      0.3-wb7
// @description  Fast slots — works on first spin, all bet buttons stay clickable, no infinite-spin bug when you can't afford a bet.
// @author       Ramin Quluzade, Silmaril [2665762] (fork by RussianRob)
// @match        https://www.torn.com/loader.php?sid=slots
// @match        https://www.torn.com/page.php?sid=slots
// @icon         https://www.google.com/s2/favicons?sz=64&domain=torn.com
// @license      MIT
// @run-at       document-idle
// @downloadURL  https://tornwar.com/scripts/torn-fast-slots.user.js
// @updateURL    https://tornwar.com/scripts/torn-fast-slots.meta.js
// ==/UserScript==
//
// =============================================================================
// CHANGELOG (tornwar fork)
// =============================================================================
// 0.3-wb7 — Three deliberate changes over upstream v0.3:
//
//   (1) FIRST SPIN IS FAST. Upstream only intercepts the 'play' request,
//       so the first spin after a refresh runs at the default 1000ms
//       animation speed (the initial 'userinfo' response sets it before
//       any play happens). Now intercepts userinfo too — when slots.js
//       initializes the barrels with the userinfo data, they're already
//       at speed=0. First spin then takes ~AJAX-RTT like every other.
//
//   (2) ALL BET BUTTONS STAY CLICKABLE. Upstream slots.js tints out
//       bet buttons you can't afford via `checkButtons()` adding a
//       `disabled` class. The click handler then refuses to fire on
//       disabled buttons. MutationObserver strips the `disabled` class
//       the moment it's added, so every bet button stays clickable
//       regardless of your money / token balance.
//
//   (3) NO INFINITE-SPIN BUG. Upstream deletes `data.error` from the
//       response — when the server rejects a bet you can't afford,
//       slots.js then thinks the play succeeded but gameRes.images is
//       missing. stopReels() leaves each barrel's `stopAt` undefined,
//       the frame-check `div.undefined` never matches, and barrels
//       spin FOREVER. Fix: keep the error field intact. slots.js shows
//       the real error and stops the spin normally.
// =============================================================================

(function() {
    'use strict';

    const originalAjax = $.ajax;

    $.ajax = function (options) {
        // wb7 (1)+(3): intercept BOTH userinfo (for first-spin speed) and
        // play (for subsequent spins). DO NOT delete error fields —
        // upstream did this to suppress error UI but it causes the
        // infinite-spin bug when the server actually rejects a play.
        if (options.data != null && options.data.sid == 'slotsData' &&
            (options.data.step == 'play' || options.data.step == 'userinfo')) {
            const originalSuccess = options.success;
            options.success = function (data, textStatus, jqXHR) {
                if (data && typeof data === 'object') {
                    // Only force fast-spin if the response is a real
                    // success (has barrelsAnimationSpeed to mutate).
                    // Don't delete data.error — slots.js needs to see
                    // it to display the message and stop cleanly.
                    data.barrelsAnimationSpeed = 0;
                }
                if (originalSuccess) {
                    originalSuccess(data, textStatus, jqXHR);
                }
            };
        }

        return originalAjax(options);
    }

    function enableBetButtons() {
        document.querySelectorAll(".slots-btn-list .betbtn").forEach(btn => {
            btn.classList.remove("disabled");
        });
    }

    function disableBetButtons() {
        document.querySelectorAll(".slots-btn-list .betbtn").forEach(btn => {
            btn.classList.add("disabled");
        });
    }

    function watchBarrelsSpinAndStop(delay = 60) {
        const barrels = document.querySelectorAll("#barrel0, #barrel1, #barrel2");
        let timers = new Map();
        let stopped = new Map();

        barrels.forEach(barrel => stopped.set(barrel, true));

        barrels.forEach(barrel => {
            const observer = new MutationObserver(() => {
                disableBetButtons();
                stopped.set(barrel, false);
                clearTimeout(timers.get(barrel));
                timers.set(barrel, setTimeout(() => {
                    stopped.set(barrel, true);
                    if ([...stopped.values()].every(Boolean)) {
                        enableBetButtons();
                    }
                }, delay));
            });

            observer.observe(barrel, {
                attributes: true,
                attributeFilter: ["style"]
            });
        });
    }

    // wb7 (2): keep all bet buttons clickable. slots.js's checkButtons()
    // adds the `disabled` class to bet amounts you can't afford. The
    // click handler refuses to fire on disabled buttons (line 118 of
    // slots.js). Strip the class whenever it's added — slots.js still
    // gets to manage the spin-time disable (via the watcher above),
    // we only override the money-based one.
    //
    // Spin-time disable still works: the watcher above adds `disabled`
    // to every betbtn on barrel motion, and the MutationObserver only
    // strips it on .slots-btn-list > li (not betbtn directly), so the
    // spin-state disable is preserved.
    function installBetButtonUntinter() {
        const listObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.type !== 'attributes') continue;
                if (m.attributeName !== 'class') continue;
                const el = m.target;
                // Only the LI elements (data-bet bet rows) — leave the
                // betbtn child disabling alone for the spin-state UI.
                if (!el.matches || !el.matches('.slots-btn-list > li[data-bet]')) continue;
                if (el.classList.contains('disabled')) {
                    el.classList.remove('disabled');
                }
            }
        });
        // Start watching once the bet list exists. The slots page lazy-
        // renders the panel via Handlebars after userinfo lands.
        const o = setInterval(() => {
            const list = document.querySelector('.slots-btn-list');
            if (!list) return;
            clearInterval(o);
            listObserver.observe(list, {
                attributes: true,
                attributeFilter: ['class'],
                subtree: true,
            });
            // Initial sweep — strip any disabled class already present
            list.querySelectorAll('li[data-bet].disabled').forEach(li => li.classList.remove('disabled'));
        }, 100);
    }

    var o = setInterval(() => {
        if($('#barrels').length == 1){
            clearInterval(o)
            watchBarrelsSpinAndStop();
        }
    }, 100);

    installBetButtonUntinter();
})();
