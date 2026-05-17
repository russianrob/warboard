// ==UserScript==
// @name         Stay Loading Test (no unsafeWindow)
// @namespace    tornwar.com
// @version      0.1.0
// @description  Fourth diagnostic stub — same as grants-only but without unsafeWindow. If this yellow pill loads, unsafeWindow alone is the Stay killer. If it doesn't, the killer is GM_xmlhttpRequest / GM_setValue / GM_getValue / GM_addStyle / GM_setClipboard.
// @author       RussianRob
// @match        https://www.torn.com/factions.php*
// @match        https://www.torn.com/war.php*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @connect      tornwar.com
// @run-at       document-idle
// @downloadURL  https://tornwar.com/scripts/torn-stay-test-no-unsafe.user.js
// @updateURL    https://tornwar.com/scripts/torn-stay-test-no-unsafe.meta.js
// ==/UserScript==
