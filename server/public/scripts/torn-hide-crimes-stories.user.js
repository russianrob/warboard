// ==UserScript==
// @name         Torn: Hide Crimes 2.0 Stories (tornwar fork)
// @namespace    tornwar.com
// @version      1.2-wb1
// @description  Hides the narrative stories from the crime initiation interface. Fork of ReconDalek's v1.2 with hash-agnostic selectors so it survives Torn frontend rebundles.
// @author       ReconDalek [2741093] (fork by RussianRob)
// @match        https://www.torn.com/loader.php?sid=crimes*
// @match        https://www.torn.com/page.php?sid=crimes*
// @grant        none
// @license      MIT
// @downloadURL  https://tornwar.com/scripts/torn-hide-crimes-stories.user.js
// @updateURL    https://tornwar.com/scripts/torn-hide-crimes-stories.meta.js
// ==/UserScript==
//
// =============================================================================
// CHANGELOG (tornwar fork)
// =============================================================================
// 1.2-wb1 — Replaced literal `.story___GmRvQ` (which broke the next time
//           Torn rebundled and regenerated CSS-module hashes) with a
//           hash-agnostic check: any class starting with `story___`.
//           Same survive-future-rebundles pattern as the arson-bang-for-buck
//           fork. Keeps working indefinitely without manual hash patches.
// =============================================================================

(function () {
    'use strict';

    // Function to immediately remove story elements
    function removeStory(node) {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        // Hash-agnostic match: catches story___GmRvQ, story___ABCDE, or
        // whatever Torn regenerates next bundle.
        const hasStoryClass = node.className
            && typeof node.className === 'string'
            && node.className.split(' ').some(c => c.startsWith('story___'));
        if (hasStoryClass) { node.remove(); return; }
        // Also check descendants in case the added node contains stories.
        node.querySelectorAll && node.querySelectorAll('[class*="story___"]')
            .forEach(el => el.remove());
    }

    // Initial removal in case some already exist.
    removeStory(document);

    // Use MutationObserver to intercept new nodes before they render.
    const observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                removeStory(node);
            }
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
    });
})();
