// ==UserScript==
// @name         Torn: Hide Crimes 2.0 Stories (tornwar fork)
// @namespace    tornwar.com
// @version      1.2-wb2
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
// 1.2-wb2 — Fix the known 'empty space remains' issue. Inject CSS rule
//           that collapses story___, storyHeader___, storyWrap___,
//           storyContainer___ to display:none + zero height/margin/padding
//           so fixed-height parents collapse too. JS observer also walks
//           up one level to hide the wrapper if it's now empty after
//           removing the story. CSS wins instantly; JS cleans up edge
//           cases. Same hash-agnostic pattern as wb1.
// 1.2-wb1 — Replaced literal `.story___GmRvQ` (which broke the next time
//           Torn rebundled and regenerated CSS-module hashes) with a
//           hash-agnostic check: any class starting with `story___`.
//           Same survive-future-rebundles pattern as the arson-bang-for-buck
//           fork. Keeps working indefinitely without manual hash patches.
// =============================================================================

(function () {
    'use strict';

    // wb2: Inject CSS first so story elements collapse to zero size even
    // before the JS observer fires. The literal node.remove() in the
    // upstream left a gap when the parent had fixed height / padding —
    // upstream author's known issue. CSS rule with !important wins
    // against any inline styling Torn might set.
    const css = `
        [class*="story___"],
        [class*="storyHeader___"],
        [class*="storyWrap___"],
        [class*="storyContainer___"] {
            display: none !important;
            height: 0 !important;
            min-height: 0 !important;
            margin: 0 !important;
            padding: 0 !important;
            border: 0 !important;
        }
    `;
    const styleEl = document.createElement('style');
    styleEl.id = 'tornwar-hide-stories-css';
    styleEl.textContent = css;
    (document.head || document.documentElement).appendChild(styleEl);

    // JS belt-and-braces: also REMOVE story nodes (in case CSS isn't
    // enough) and walk up one level to collapse a wrapper whose only
    // child was the story (catches anonymous flex/grid wrappers that
    // would otherwise still reserve space).
    function removeStory(node) {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const hasStoryClass = node.className
            && typeof node.className === 'string'
            && node.className.split(' ').some(c => c.startsWith('story___'));
        if (hasStoryClass) {
            const parent = node.parentElement;
            node.remove();
            // If the parent now has no element children, collapse it too —
            // it was likely a wrapper that only existed to hold the story.
            if (parent && parent !== document.body && parent.children.length === 0) {
                parent.style.cssText += 'display:none !important;height:0 !important;margin:0 !important;padding:0 !important;';
            }
            return;
        }
        node.querySelectorAll && node.querySelectorAll('[class*="story___"]')
            .forEach(el => removeStory(el));
    }

    // Initial removal in case some already exist.
    removeStory(document);

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
