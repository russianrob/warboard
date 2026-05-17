// ==UserScript==
// @name         Torn Fast Slots (tornwar fork)
// @namespace    tornwar.com
// @version      0.3-wb4
// @description  Makes slots stop instantly. Fork of Silmaril [2665762]'s v0.3 with jQuery-ready gate, error-resilience for the 'keeps spinning' bug, and bounce-animation kill so the barrel lands instantly instead of running the 400ms easeOutBounce settle.
// @author       Ramin Quluzade, Silmaril [2665762] (fork by RussianRob)
// @match        https://www.torn.com/loader.php?sid=slots
// @match        https://www.torn.com/page.php?sid=slots
// @license      MIT
// @run-at       document-idle
// @downloadURL  https://tornwar.com/scripts/torn-fast-slots.user.js
// @updateURL    https://tornwar.com/scripts/torn-fast-slots.meta.js
// ==/UserScript==
//
// =============================================================================
// CHANGELOG (tornwar fork)
// =============================================================================
// 0.3-wb1 — Three fixes over upstream v0.3:
//
//   (1) jQuery-ready gate. Upstream grabs `$.ajax` at script load via
//       `const originalAjax = $.ajax;`. If jQuery isn't loaded yet at
//       document-idle (race on slow connections / heavy pages), this
//       throws and the wrap never installs. v0.3-wb1 polls for $.ajax
//       availability up to 5 seconds before wrapping.
//
//   (2) 'Keeps spinning forever' bug. The play-response handler in
//       slots.js has an early-return on `gameRes.error`:
//
//           if (gameRes.error) { showError(); return; }
//           ...
//           stopReels();   // ← never called when error path taken
//
//       If our wrap throws mid-mutation, originalSuccess is never
//       called, gameRes never updates, stopReels never fires, and
//       the barrels animate indefinitely. Wrapping the mutation in
//       try/catch + always calling originalSuccess prevents this.
//
//   (3) 400ms easeOutBounce barrel landing. Even when our wrap sets
//       barrelsAnimationSpeed=0 and the spin stops the moment the AJAX
//       returns, the slots.js then runs a 400ms easeOutBounce animation
//       to settle the barrel into its final position (line 308 of
//       slots.js). Monkey-patches $.fn.animate to detect this specific
//       call (easing === 'easeOutBounce') and drops the duration to 0.
//       Net visible spin time drops from ~700ms to ~AJAX RTT (~100-300ms).
//
//   Watch-and-stop delay also reduced from 60ms to 0ms — the bet
//   buttons re-enable immediately once all barrels have settled.
// =============================================================================

(function() {
    'use strict';

    function installWrap() {
        if (typeof window.$ === 'undefined' || typeof window.$.ajax !== 'function') return false;
        if (window.$.ajax.__catFastSlotsWrapped) return true; // already wrapped

        const $ = window.$;
        const originalAjax = $.ajax;

        const wrapped = function (options) {
            try {
                if (options && options.data != null
                    && options.data.sid === 'slotsData'
                    && options.data.step === 'play') {
                    const originalSuccess = options.success;
                    options.success = function (data, textStatus, jqXHR) {
                        try {
                            // 0.3-wb4: matches upstream — always mutate.
                            // Earlier wb2/wb3 attempts to gate on
                            // response shape ended up rejecting some
                            // valid plays (response field naming varies
                            // by win/loss/bonus state we can't reliably
                            // pre-detect), leaving them at the default
                            // 1000ms animation speed. User reported this
                            // as 'a lot slower than upstream'. Reverting
                            // to upstream's behavior: always force
                            // animation speed to 0 + delete error fields.
                            if (data && typeof data === 'object') {
                                if (data.error) delete data.error;
                                if (data.errorMsg) delete data.errorMsg;
                                data.barrelsAnimationSpeed = 0;
                            }
                        } catch (_) { /* never break the success chain */ }
                        // Always call originalSuccess — if we throw without
                        // it, stopReels never fires and barrels spin forever.
                        if (originalSuccess) {
                            try { originalSuccess(data, textStatus, jqXHR); }
                            catch (e) { console.warn('[fast-slots] original success threw:', e); }
                        }
                    };
                }
            } catch (_) { /* fall through to original */ }
            return originalAjax(options);
        };
        wrapped.__catFastSlotsWrapped = true;
        $.ajax = wrapped;

        // Bounce-kill: barrel landing uses easeOutBounce. Catch any
        // .animate() call with that easing and instant-snap it.
        try {
            const origAnimate = $.fn.animate;
            $.fn.animate = function (props, duration, easing, complete) {
                // Normalize args — jQuery accepts (props, options) too
                if (typeof duration === 'object' && duration !== null) {
                    if (duration.easing === 'easeOutBounce') duration.duration = 0;
                } else if (easing === 'easeOutBounce') {
                    duration = 0;
                }
                return origAnimate.call(this, props, duration, easing, complete);
            };
        } catch (e) { console.warn('[fast-slots] animate patch failed:', e); }

        return true;
    }

    // Poll for jQuery up to 5 seconds. The page sometimes loads jQuery
    // after our document-idle fires (rare but happens).
    let attempts = 0;
    const ready = setInterval(() => {
        attempts++;
        if (installWrap() || attempts > 50) clearInterval(ready);
    }, 100);

    function enableBetButtons() {
        document.querySelectorAll('.slots-btn-list .betbtn').forEach(btn => {
            btn.classList.remove('disabled');
        });
    }
    function disableBetButtons() {
        document.querySelectorAll('.slots-btn-list .betbtn').forEach(btn => {
            btn.classList.add('disabled');
        });
    }

    // Watch barrel style mutations. 0ms debounce — re-enable bet
    // buttons the instant all barrels stop changing.
    function watchBarrelsSpinAndStop(delay = 0) {
        const barrels = document.querySelectorAll('#barrel0, #barrel1, #barrel2');
        const timers = new Map();
        const stopped = new Map();
        barrels.forEach(barrel => stopped.set(barrel, true));
        barrels.forEach(barrel => {
            const obs = new MutationObserver(() => {
                disableBetButtons();
                stopped.set(barrel, false);
                clearTimeout(timers.get(barrel));
                timers.set(barrel, setTimeout(() => {
                    stopped.set(barrel, true);
                    if ([...stopped.values()].every(Boolean)) enableBetButtons();
                }, delay));
            });
            obs.observe(barrel, { attributes: true, attributeFilter: ['style'] });
        });
    }

    const o = setInterval(() => {
        if (document.getElementById('barrels')) {
            clearInterval(o);
            watchBarrelsSpinAndStop();
        }
    }, 100);
})();
