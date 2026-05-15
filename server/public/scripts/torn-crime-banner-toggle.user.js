// ==UserScript==
// @name         Torn Crime Banner Toggle (tornwar fork)
// @namespace    tornwar.com
// @version      1.1-wb1
// @description  Removes the animated banner from the crime page and auto-expands the stats panel. Fork of Omanpx's v1.1 with hash-agnostic selectors so it survives Torn frontend rebundles.
// @author       Omanpx [1906686] + Claude Sonnet 4.5 (fork by RussianRob)
// @match        https://www.torn.com/page.php?sid=crimes*
// @grant        none
// @downloadURL  https://tornwar.com/scripts/torn-crime-banner-toggle.user.js
// @updateURL    https://tornwar.com/scripts/torn-crime-banner-toggle.meta.js
// ==/UserScript==
//
// =============================================================================
// CHANGELOG (tornwar fork)
// =============================================================================
// 1.1-wb1 — Replaced the two hash-suffixed React class selectors with
//           hash-agnostic [class*="X___"] matchers so the script keeps
//           working across Torn bundle rebuilds:
//             .toggleStatsPanelButton___dOfzi → [class*="toggleStatsPanelButton___"]
//             .bannerWrapper___b7tPK         → [class*="bannerWrapper___"]
//           Same pattern as arson-bang-for-buck and torn-hide-crimes-stories
//           forks. Survives Torn CSS-module hash regenerations indefinitely.
// =============================================================================

(function () {
    'use strict';

    function setAriaExpanded() {
        // Auto-expand the stats panel if collapsed.
        const button = document.querySelector('[class*="toggleStatsPanelButton___"]');
        if (button) {
            if (button.getAttribute('aria-expanded') !== 'true') {
                button.click();
                console.log('[crime-banner-toggle] expanded stats panel');
            }
        }

        // Remove the animated banner wrapper.
        const banner = document.querySelector('[class*="bannerWrapper___"]');
        if (banner) {
            banner.remove();
            console.log('[crime-banner-toggle] removed banner');
            return true;
        }
        return false;
    }

    // Run immediately
    setAriaExpanded();

    // Watch for dynamic content changes
    const observer = new MutationObserver(function (mutations) {
        for (const mutation of mutations) {
            if (mutation.addedNodes.length > 0) {
                setAriaExpanded();
            }
        }
    });
    observer.observe(document.body, {
        childList: true,
        subtree: true,
    });

    // Also try repeatedly for the first few seconds (catches lazy-rendered DOM)
    let attempts = 0;
    const interval = setInterval(() => {
        if (setAriaExpanded() || attempts > 20) {
            clearInterval(interval);
        }
        attempts++;
    }, 200);
})();
