// ==UserScript==
// @name         Torn Fast Slots (tornwar fork)
// @namespace    tornwar.com
// @version      0.3-wb12
// @description  Fast slots — works on first spin (desktop AND PDA), error responses don't infinite-loop. Torn's natural 'blur out unaffordable bets' behavior is preserved so you can't accidentally click a bet you can't pay for.
// @author       Ramin Quluzade, Silmaril [2665762] (fork by RussianRob)
// @match        https://www.torn.com/loader.php?sid=slots
// @match        https://www.torn.com/page.php?sid=slots
// @icon         https://www.google.com/s2/favicons?sz=64&domain=torn.com
// @license      MIT
// @grant        unsafeWindow
// @run-at       document-start
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

    // wb12: PDA fix — first spin wasn't fast on Torn PDA because:
    //   (a) PDA runs userscripts in an isolated WebView world, so the
    //       sandbox's `$` is NOT the page's jQuery. Patching `$.ajax`
    //       from the sandbox left slots.js's calls unintercepted, and
    //       the userinfo response came back with the default 1000ms
    //       barrelsAnimationSpeed baked into the initial Barrels.
    //   (b) @run-at document-idle ran AFTER slots.js had already fired
    //       userinfo, so even on desktop the first-spin patch was racy.
    // Fix: use unsafeWindow to grab the PAGE's jQuery, @run-at
    // document-start so we're alive before slots.js loads, and poll
    // until $.ajax appears (jQuery might load after us). Patch is
    // idempotent.
    const win = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);

    function applyPatch($) {
        if (!$ || !$.ajax || $.__fastSlotsWb12Patched) return false;
        const originalAjax = $.ajax;

        $.ajax = function (options) {
            // Wrap BOTH 'play' (every subsequent spin) and 'userinfo'
            // (sets initial barrelsAnimationSpeed → fast first spin).
            // Don't delete data.error: slots.js needs error fields to
            // stop the spin on server rejection (no infinite-spin bug).
            if (options && options.data != null && options.data.sid == 'slotsData' &&
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
        };
        $.__fastSlotsWb12Patched = true;
        return true;
    }

    // Try now (jQuery may already be loaded); otherwise poll fast.
    if (!applyPatch(win.$)) {
        const iv = setInterval(() => {
            if (applyPatch(win.$)) clearInterval(iv);
        }, 5);
        // Safety: stop polling after 15s regardless. If jQuery hasn't
        // shown up by then we're on the wrong page or Torn changed
        // the slots loader; nothing useful to do.
        setTimeout(() => clearInterval(iv), 15000);
    }

    // No upstream watchBarrelsSpinAndStop helpers (removed in wb10).
    // Reason: upstream's enableBetButtons() stripped the `disabled`
    // class from EVERY bet button ~60ms after each animation tick,
    // nuking the disable Torn's checkButtons() legitimately put on
    // unaffordable bets. Torn's `inRoll` flag already blocks
    // concurrent spins, so the defensive layer was net-negative.
})();
