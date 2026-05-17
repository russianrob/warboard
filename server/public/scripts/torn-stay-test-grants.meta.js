// ==UserScript==
// @name         Stay Loading Test (grants + require)
// @namespace    tornwar.com
// @version      0.1.0
// @description  Diagnostic stub mirroring factionops's @grant block + @require to isolate whether Stay rejection is caused by metadata directives vs script size. If this loads (orange pill) but factionops/oc-spawn don't, the cause is size. If this doesn't load either, the cause is a @grant or @require Stay no longer supports.
// @author       RussianRob
// @match        https://www.torn.com/factions.php*
// @match        https://www.torn.com/war.php*
// @require      https://tornwar.com/socket.io/socket.io.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @connect      tornwar.com
// @connect      localhost
// @connect      *
// @run-at       document-idle
// @downloadURL  https://tornwar.com/scripts/torn-stay-test-grants.user.js
// @updateURL    https://tornwar.com/scripts/torn-stay-test-grants.meta.js
// ==/UserScript==
