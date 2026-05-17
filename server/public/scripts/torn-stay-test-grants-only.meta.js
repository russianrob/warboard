// ==UserScript==
// @name         Stay Loading Test (grants only)
// @namespace    tornwar.com
// @version      0.1.0
// @description  Third diagnostic stub — has factionops's @grant block but NO @require and NO @connect wildcard. If this purple pill loads but the orange one (grants+require) didn't, the killer is @require or @connect *. If this also doesn't load, the killer is one of the @grants.
// @author       RussianRob
// @match        https://www.torn.com/factions.php*
// @match        https://www.torn.com/war.php*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @connect      tornwar.com
// @run-at       document-idle
// @downloadURL  https://tornwar.com/scripts/torn-stay-test-grants-only.user.js
// @updateURL    https://tornwar.com/scripts/torn-stay-test-grants-only.meta.js
// ==/UserScript==
