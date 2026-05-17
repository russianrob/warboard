// ==UserScript==
// @name         Torn Fast Slots (tornwar fork)
// @namespace    tornwar.com
// @version      0.3-wb11
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
        // wb11: re-add userinfo intercept for fast first spin.
        // wb9's hypothesis (userinfo wrap broke the affordability
        // disable) turned out to be wrong — the real culprit was the
        // upstream watch helpers (removed in wb10). Now safe to wrap
        // both: 'play' for every subsequent spin, 'userinfo' so the
        // initial Barrel constructors get loopTime=0 baked in and the
        // FIRST spin is fast too.
        // STILL: don't delete data.error — server rejections must reach
        // slots.js's error path so it stops the spin (no infinite-spin
        // bug from upstream).
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

    // wb10: removed upstream's watchBarrelsSpinAndStop +
    // enableBetButtons/disableBetButtons. They were a defensive layer
    // to prevent mid-spin clicks, but:
    //   1. Torn's own slots.js already prevents concurrent spins via
    //      its `inRoll` flag check in placeBet().
    //   2. enableBetButtons() unconditionally stripped the `disabled`
    //      class from EVERY bet button ~60ms after each animation tick.
    //      That nuked the `disabled` class that Torn's checkButtons()
    //      legitimately put on unaffordable bets — which is why bets
    //      you can't afford weren't blurred out.
    // Without these helpers, Torn's native checkButtons() at the end of
    // each spin (in displayResults) is the sole source of truth for
    // which bet buttons are disabled. Affordability tinting restored.
})();
