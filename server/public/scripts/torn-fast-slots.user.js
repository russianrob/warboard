// ==UserScript==
// @name         Torn Fast Slots (tornwar fork)
// @namespace    tornwar.com
// @version      0.3-wb8
// @description  Fast slots — works on first spin, error responses don't infinite-loop. Torn's natural 'blur out unaffordable bets' behavior is preserved so you can't accidentally click a bet you can't pay for.
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
// 0.3-wb8 — Two narrow changes over upstream v0.3:
//
//   (1) FIRST SPIN IS FAST. Upstream only wraps the 'play' AJAX. First
//       spin uses the speed from the 'userinfo' response (default
//       1000ms). Now wraps userinfo too — barrels initialize with
//       loopTime=0 baked in, so first spin takes ~AJAX RTT like every
//       subsequent spin.
//
//   (2) NO INFINITE-SPIN BUG. Removed upstream's
//           if (data.error) delete data.error;
//           if (data.errorMsg) delete data.errorMsg;
//       lines. Those were added to suppress error UI but caused
//       infinite spin: when the server rejects a play (rate limit,
//       session expired, server hiccup), slots.js needs to see the
//       error field to display the message and stop the spin via its
//       error path. Keeping the field intact lets it work normally.
//
//   Bet-button tinting is LEFT ALONE: Torn's slots.js itself disables
//   bet buttons you can't afford (checkButtons() at line 257 of
//   slots.js). The earlier wb7 added a MutationObserver that stripped
//   the disabled class — that turned out to enable the infinite-loop
//   path because users could click unaffordable bets the server then
//   rejects. Removed in wb8 — the natural blur stays.
// =============================================================================

(function() {
    'use strict';

    const originalAjax = $.ajax;

    $.ajax = function (options) {
        // wb8 (1)+(2): intercept BOTH userinfo (for first-spin speed)
        // and play (for subsequent spins). DO NOT delete error fields —
        // upstream did this to suppress error UI but it broke the
        // server-rejection path and caused infinite spinning.
        if (options.data != null && options.data.sid == 'slotsData' &&
            (options.data.step == 'play' || options.data.step == 'userinfo')) {
            const originalSuccess = options.success;
            options.success = function (data, textStatus, jqXHR) {
                if (data && typeof data === 'object') {
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

    var o = setInterval(() => {
        if($('#barrels').length == 1){
            clearInterval(o)
            watchBarrelsSpinAndStop();
        }
    }, 100);
})();
