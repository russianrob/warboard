// ==UserScript==
// @name         FactionOps - Faction War Coordinator
// @namespace    https://tornwar.com
// @version      3.12.8
// @description  Real-time faction war coordination tool for Torn.com
// @author       RussianRob
// @license      MIT
// @downloadURL  https://tornwar.com/scripts/factionops.user.js
// @updateURL    https://tornwar.com/scripts/factionops.meta.js
// @match        https://www.torn.com/factions.php?step=your*
// @match        https://www.torn.com/factions.php?step=profile*
// @match        https://www.torn.com/loader.php?sid=attack&user*
// @match        https://www.torn.com/war.php*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        unsafeWindow
// @connect      tornwar.com
// @connect      localhost
// @connect      *
// @require      https://tornwar.com/socket.io.min.js
// @run-at       document-idle
// ==/UserScript==
