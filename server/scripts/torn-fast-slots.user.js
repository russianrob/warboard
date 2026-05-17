// ==UserScript==
// @name         Torn Fast Slots (tornwar mirror)
// @namespace    tornwar.com
// @version      0.3-wb6
// @description  Makes slots stop instantly. Works for every spin except first.
// @author       Ramin Quluzade, Silmaril [2665762] (mirrored by RussianRob)
// @match        https://www.torn.com/loader.php?sid=slots
// @match        https://www.torn.com/page.php?sid=slots
// @icon         https://www.google.com/s2/favicons?sz=64&domain=torn.com
// @license      MIT
// @run-at       document-idle
// @downloadURL  https://tornwar.com/scripts/torn-fast-slots.user.js
// @updateURL    https://tornwar.com/scripts/torn-fast-slots.meta.js
// ==/UserScript==
//
// Verbatim 1:1 mirror of SOLiNARY/torn-scripts fast-slots.user.js from
// https://github.com/SOLiNARY/torn-scripts/blob/main/casino/fast-slots/fast-slots.user.js
// Only the @namespace, @author credit suffix, and @downloadURL/@updateURL
// are different from upstream. No code changes.

(function() {
    'use strict';

    const originalAjax = $.ajax;

    $.ajax = function (options) {
        if (options.data != null && options.data.sid == 'slotsData' && options.data.step == 'play') {
            const originalSuccess = options.success;
            options.success = function (data, textStatus, jqXHR) {
                if (data.error) delete data.error;
                if (data.errorMsg) delete data.errorMsg;
                data.barrelsAnimationSpeed = 0;
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
