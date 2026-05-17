// ==UserScript==
// @name         Stay Loading Test (page injection)
// @namespace    tornwar.com
// @version      0.1.0
// @description  Proves the <script>-tag injection + postMessage round-trip works on Torn. If the magenta pill says PAGE-CONTEXT-OK, the injection approach is viable for refactoring factionops + oc-spawn to drop @grant unsafeWindow. If it says BLOCKED, Torn's CSP rejects inline scripts and option 2 doesn't work.
// @author       RussianRob
// @match        https://www.torn.com/factions.php*
// @match        https://www.torn.com/war.php*
// @grant        none
// @run-at       document-end
// @downloadURL  https://tornwar.com/scripts/torn-stay-test-inject.user.js
// @updateURL    https://tornwar.com/scripts/torn-stay-test-inject.meta.js
// ==/UserScript==
