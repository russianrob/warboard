// ==UserScript==
// @name         FactionOps - Faction War Coordinator
// @namespace    https://tornwar.com
// @version      1.2.0
// @description  Real-time faction war coordination tool for Torn.com
// @author       FactionOps
// @license      MIT
// @downloadURL  https://tornwar.com/download/factionops.user.js
// @updateURL    https://tornwar.com/download/factionops.user.js
// @match        https://www.torn.com/factions.php?step=your*
// @match        https://www.torn.com/factions.php?step=profile*
// @match        https://www.torn.com/loader.php?sid=attack&user*
// @match        https://www.torn.com/war.php*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @connect      tornwar.com
// @connect      localhost
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // =========================================================================
    // SECTION 1: CONFIGURATION
    // =========================================================================

    // --- Torn PDA Detection ---
    const IS_PDA = typeof window.flutter_inappwebview !== 'undefined';
    const PDA_API_KEY = '###PDA-APIKEY###';

    const CONFIG = {
        SERVER_URL: GM_getValue('factionops_server', 'https://tornwar.com'),
        API_KEY: GM_getValue('factionops_apikey', '') || (IS_PDA ? PDA_API_KEY : ''),
        THEME: GM_getValue('factionops_theme', 'dark'),
        AUTO_SORT: GM_getValue('factionops_autosort', true),
        CALL_TIMEOUT: 5 * 60 * 1000,       // 5 minute call expiry
        REFRESH_INTERVAL: 30 * 1000,        // 30 second status refresh
        IS_PDA: IS_PDA,
    };

    // Auto-save PDA key on first detection
    if (IS_PDA && !GM_getValue('factionops_apikey', '')) {
        GM_setValue('factionops_apikey', PDA_API_KEY);
    }

    /** Persist a config key and update the live CONFIG object. */
    function setConfig(key, value) {
        CONFIG[key] = value;
        const gmKeys = {
            SERVER_URL: 'factionops_server',
            API_KEY: 'factionops_apikey',
            THEME: 'factionops_theme',
            AUTO_SORT: 'factionops_autosort',
        };
        if (gmKeys[key]) {
            GM_setValue(gmKeys[key], value);
        }
    }

    // =========================================================================
    // SECTION 1B: PDA-COMPATIBLE HTTP WRAPPER
    // =========================================================================

    /**
     * Cross-platform HTTP request wrapper.
     * Uses PDA_httpGet on Torn PDA, GM_xmlhttpRequest elsewhere.
     */
    function httpRequest(opts) {
        if (IS_PDA && typeof PDA_httpGet === 'function' && opts.method === 'GET') {
            // PDA bridge for GET requests
            PDA_httpGet(opts.url)
                .then(r => opts.onload && opts.onload(typeof r === 'string' ? { status: 200, responseText: r } : r))
                .catch(e => opts.onerror && opts.onerror(e));
        } else {
            GM_xmlhttpRequest(opts);
        }
    }

    // =========================================================================
    // SECTION 2: LOGGING UTILITIES
    // =========================================================================

    const LOG_PREFIX = '[FactionOps]';

    function log(...args) {
        console.log(LOG_PREFIX, ...args);
    }

    function warn(...args) {
        console.warn(LOG_PREFIX, ...args);
    }

    function error(...args) {
        console.error(LOG_PREFIX, ...args);
    }

    // =========================================================================
    // SECTION 3: CSS INJECTION
    // =========================================================================

    function injectStyles() {
        const css = `
/* =====================================================================
   FactionOps CSS — all selectors prefixed with wb- to avoid Torn conflicts
   ===================================================================== */

/* Theme variables — dark by default, light via .wb-theme-light on <html> */
:root {
    --wb-bg: #1a1a2e;
    --wb-bg-secondary: #16213e;
    --wb-text: #e0e0e0;
    --wb-accent: #0f3460;
    --wb-call-green: #00b894;
    --wb-call-red: #e17055;
    --wb-rally-orange: #fdcb6e;
    --wb-hospital-red: #d63031;
    --wb-travel-blue: #0984e3;
    --wb-jail-gray: #636e72;
    --wb-online-green: #00b894;
    --wb-idle-yellow: #fdcb6e;
    --wb-offline-gray: #636e72;
    --wb-bonus-warning: #ff7675;
    --wb-border: #2d3436;
}

html.wb-theme-light {
    --wb-bg: #f5f5f5;
    --wb-bg-secondary: #ffffff;
    --wb-text: #2d3436;
    --wb-accent: #74b9ff;
    --wb-border: #dfe6e9;
}

/* ----- Settings gear icon (bottom-right FAB) ----- */
.wb-settings-gear {
    position: fixed;
    bottom: 20px;
    right: 20px;
    width: 42px;
    height: 42px;
    border-radius: 50%;
    background: var(--wb-accent);
    color: var(--wb-text);
    border: 2px solid var(--wb-border);
    cursor: pointer;
    z-index: 999999;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.4);
    transition: transform 0.2s ease, background 0.2s ease;
    font-family: Arial, sans-serif;
}
.wb-settings-gear:hover {
    transform: scale(1.1);
    background: var(--wb-call-green);
}

/* ----- Settings modal overlay ----- */
.wb-settings-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.6);
    z-index: 1000000;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: Arial, sans-serif;
}
.wb-settings-modal {
    background: var(--wb-bg);
    border: 1px solid var(--wb-border);
    border-radius: 8px;
    width: 420px;
    max-width: 95vw;
    max-height: 90vh;
    overflow-y: auto;
    padding: 24px;
    color: var(--wb-text);
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
}
.wb-settings-modal h2 {
    margin: 0 0 18px;
    font-size: 18px;
    color: var(--wb-call-green);
    display: flex;
    align-items: center;
    gap: 8px;
}
.wb-settings-modal label {
    display: block;
    font-size: 12px;
    color: var(--wb-text);
    margin-bottom: 4px;
    opacity: 0.8;
}
.wb-settings-modal input[type="text"],
.wb-settings-modal input[type="password"] {
    width: 100%;
    padding: 8px 10px;
    border-radius: 4px;
    border: 1px solid var(--wb-border);
    background: var(--wb-bg-secondary);
    color: var(--wb-text);
    font-size: 13px;
    margin-bottom: 14px;
    box-sizing: border-box;
    font-family: monospace;
}
.wb-settings-modal input:focus {
    outline: none;
    border-color: var(--wb-call-green);
}
.wb-settings-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;
}
.wb-settings-row span {
    font-size: 13px;
}

/* Toggle switch */
.wb-toggle {
    position: relative;
    width: 44px;
    height: 24px;
    cursor: pointer;
}
.wb-toggle input {
    opacity: 0;
    width: 0;
    height: 0;
}
.wb-toggle-slider {
    position: absolute;
    inset: 0;
    background: var(--wb-border);
    border-radius: 24px;
    transition: background 0.2s;
}
.wb-toggle-slider::before {
    content: '';
    position: absolute;
    width: 18px;
    height: 18px;
    left: 3px;
    bottom: 3px;
    background: var(--wb-text);
    border-radius: 50%;
    transition: transform 0.2s;
}
.wb-toggle input:checked + .wb-toggle-slider {
    background: var(--wb-call-green);
}
.wb-toggle input:checked + .wb-toggle-slider::before {
    transform: translateX(20px);
}

/* Buttons in settings */
.wb-btn {
    padding: 6px 14px;
    border-radius: 4px;
    border: 1px solid var(--wb-border);
    background: var(--wb-accent);
    color: var(--wb-text);
    font-size: 12px;
    cursor: pointer;
    transition: background 0.15s;
    font-family: Arial, sans-serif;
}
.wb-btn:hover {
    background: var(--wb-call-green);
    color: #fff;
}
.wb-btn-danger {
    background: var(--wb-call-red);
}
.wb-btn-danger:hover {
    background: #c0392b;
}
.wb-btn-sm {
    padding: 3px 8px;
    font-size: 11px;
}
.wb-settings-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 18px;
}

/* Connection status indicator */
.wb-connection-status {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    margin-bottom: 14px;
    padding: 6px 10px;
    border-radius: 4px;
    background: var(--wb-bg-secondary);
}
.wb-status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
    flex-shrink: 0;
}
.wb-status-dot.connected    { background: var(--wb-call-green); }
.wb-status-dot.disconnected { background: var(--wb-call-red); }
.wb-status-dot.connecting   { background: var(--wb-idle-yellow); animation: wb-pulse 1s ease-in-out infinite; }

/* ----- Chain monitor bar (fixed at top) ----- */
.wb-chain-bar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 999998;
    padding: 8px 16px;
    background: linear-gradient(135deg, var(--wb-bg) 0%, var(--wb-accent) 100%);
    color: var(--wb-text);
    font-family: Arial, sans-serif;
    font-size: 13px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    border-bottom: 2px solid var(--wb-border);
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    transition: background 0.3s;
}
.wb-chain-bar.wb-chain-safe {
    border-bottom-color: var(--wb-call-green);
}
.wb-chain-bar.wb-chain-approaching {
    border-bottom-color: var(--wb-idle-yellow);
    background: linear-gradient(135deg, #2d2a0e 0%, #3b3a0c 100%);
}
.wb-chain-bar.wb-chain-imminent {
    border-bottom-color: var(--wb-bonus-warning);
    background: linear-gradient(135deg, #2e0f0f 0%, #4a1010 100%);
    animation: wb-chain-pulse 0.6s ease-in-out infinite alternate;
}
.wb-chain-section {
    display: flex;
    align-items: center;
    gap: 8px;
}
.wb-chain-count {
    font-weight: bold;
    font-size: 16px;
}
.wb-chain-timeout {
    font-family: monospace;
    font-size: 14px;
}
.wb-chain-bonus {
    padding: 2px 8px;
    border-radius: 3px;
    background: var(--wb-bonus-warning);
    color: #000;
    font-weight: bold;
    font-size: 11px;
    text-transform: uppercase;
}
.wb-chain-bar .wb-chain-minimize {
    cursor: pointer;
    font-size: 16px;
    opacity: 0.7;
    transition: opacity 0.15s;
}
.wb-chain-bar .wb-chain-minimize:hover {
    opacity: 1;
}

/* ----- Call / Rally / Status elements in member rows ----- */
.wb-cell {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 0;
    font-family: Arial, sans-serif;
    font-size: 11px;
    vertical-align: middle;
}
.wb-call-btn,
.wb-rally-btn {
    padding: 2px 10px;
    border-radius: 12px;
    border: 1px solid var(--wb-border);
    font-size: 11px;
    cursor: pointer;
    transition: background 0.15s, color 0.15s, transform 0.1s;
    font-family: Arial, sans-serif;
    white-space: nowrap;
}
.wb-call-btn {
    background: var(--wb-accent);
    color: var(--wb-text);
}
.wb-call-btn:hover {
    background: var(--wb-call-green);
    color: #fff;
    transform: scale(1.05);
}
.wb-call-btn.wb-called-self {
    background: var(--wb-call-green);
    color: #fff;
    font-weight: bold;
}
.wb-call-btn.wb-called-other {
    background: var(--wb-bg-secondary);
    color: var(--wb-call-green);
    border-color: var(--wb-call-green);
    cursor: default;
}
.wb-uncall-btn {
    padding: 2px 8px;
    border-radius: 12px;
    border: 1px solid var(--wb-call-red);
    background: transparent;
    color: var(--wb-call-red);
    font-size: 10px;
    cursor: pointer;
    margin-left: 4px;
    transition: background 0.15s;
    font-family: Arial, sans-serif;
}
.wb-uncall-btn:hover {
    background: var(--wb-call-red);
    color: #fff;
}

/* Rally button */
.wb-rally-btn {
    background: transparent;
    border-color: var(--wb-rally-orange);
    color: var(--wb-rally-orange);
}
.wb-rally-btn:hover {
    background: var(--wb-rally-orange);
    color: #000;
}
.wb-rally-btn.wb-rally-active {
    background: var(--wb-rally-orange);
    color: #000;
    font-weight: bold;
    animation: wb-pulse 1.5s ease-in-out infinite;
}

/* Status badges */
.wb-status-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 8px;
    border-radius: 10px;
    font-size: 10px;
    font-weight: bold;
    white-space: nowrap;
    font-family: Arial, sans-serif;
}
.wb-status-ok       { background: rgba(0,184,148,0.15); color: var(--wb-call-green); }
.wb-status-hospital { background: rgba(214,48,49,0.15); color: var(--wb-hospital-red); }
.wb-status-travel   { background: rgba(9,132,227,0.15); color: var(--wb-travel-blue); }
.wb-status-jail     { background: rgba(99,110,114,0.15); color: var(--wb-jail-gray); }

/* Online activity dot */
.wb-activity-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    margin-right: 3px;
    flex-shrink: 0;
}
.wb-activity-online  { background: var(--wb-online-green); }
.wb-activity-idle    { background: var(--wb-idle-yellow); }
.wb-activity-offline { background: var(--wb-offline-gray); }

/* Row highlights */
.wb-row-called {
    background: rgba(0,184,148,0.06) !important;
}
.wb-row-rally {
    outline: 2px solid var(--wb-rally-orange);
    outline-offset: -2px;
    background: rgba(253,203,110,0.08) !important;
}

/* Smooth re-ordering transitions */
.wb-sortable-row {
    transition: transform 0.3s ease, opacity 0.3s ease;
}

/* ----- Attack page overlay ----- */
.wb-attack-overlay {
    position: fixed;
    top: 60px;
    right: 16px;
    z-index: 999997;
    background: var(--wb-bg);
    border: 1px solid var(--wb-border);
    border-radius: 8px;
    padding: 12px 16px;
    color: var(--wb-text);
    font-family: Arial, sans-serif;
    font-size: 12px;
    min-width: 200px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
}
.wb-attack-overlay h4 {
    margin: 0 0 8px;
    font-size: 13px;
    color: var(--wb-call-green);
}
.wb-attack-overlay .wb-attack-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
}

/* ----- Animations ----- */
@keyframes wb-pulse {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.5; }
}
@keyframes wb-chain-pulse {
    from { box-shadow: 0 0 8px rgba(255,118,117,0.3); }
    to   { box-shadow: 0 0 20px rgba(255,118,117,0.7); }
}

/* Ensure Torn content doesn't sit under our chain bar */
body.wb-chain-active {
    padding-top: 42px !important;
}
`;
        GM_addStyle(css);
        log('Styles injected');
    }

    // =========================================================================
    // SECTION 4: STATE MANAGEMENT
    // =========================================================================

    /** Centralised reactive state for the entire extension. */
    const state = {
        connected: false,
        connecting: false,
        socket: null,
        jwtToken: GM_getValue('factionops_jwt', ''),
        myPlayerId: null,
        myPlayerName: null,

        // Map of targetId -> { calledBy: { id, name }, calledAt: timestamp }
        calls: {},

        // Map of targetId -> { participants: [{ id, name }], startedBy: { id, name } }
        rallies: {},

        // Map of targetId -> { status, until, description, activity }
        statuses: {},

        // Chain data
        chain: {
            current: 0,
            max: 0,
            timeout: 0,
            cooldown: 0,
        },

        // UI references
        ui: {
            chainBar: null,
            settingsOpen: false,
        },
    };

    // Bonus hit milestones used by the chain monitor
    const BONUS_MILESTONES = [
        10, 25, 50, 100, 250, 500, 1000, 2500,
        5000, 10000, 25000, 50000, 100000,
    ];

    /** Return the next bonus milestone at or after `count`, or null. */
    function nextBonusMilestone(count) {
        for (const m of BONUS_MILESTONES) {
            if (m >= count) return m;
        }
        return null;
    }

    // =========================================================================
    // SECTION 5: UTILITY HELPERS
    // =========================================================================

    /** Format seconds into "Xm Ys" or "Xh Ym". */
    function formatTimer(seconds) {
        if (seconds <= 0) return '0s';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (h > 0) return `${h}h ${m}m`;
        if (m > 0) return `${m}m ${s < 10 ? '0' : ''}${s}s`;
        return `${s}s`;
    }

    /** Debounce helper — returns a debounced wrapper. */
    function debounce(fn, ms) {
        let timer;
        return function (...args) {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), ms);
        };
    }

    /** Extract a Torn player ID from a URL or href string. */
    function extractPlayerId(url) {
        if (!url) return null;
        const m = url.match(/(?:user2ID=|XID=|user=|userId=|ID=)(\d+)/i)
            || url.match(/profiles\.php\?XID=(\d+)/)
            || url.match(/loader\.php\?sid=attack&user2ID=(\d+)/);
        return m ? m[1] : null;
    }

    /** Extract target ID from the current attack page URL. */
    function getAttackTargetId() {
        const m = window.location.href.match(/user2ID=(\d+)/);
        return m ? m[1] : null;
    }

    /** Safely parse JSON, returning null on failure. */
    function safeParse(text) {
        try { return JSON.parse(text); } catch { return null; }
    }

    // =========================================================================
    // SECTION 6: SOCKET.IO LOADER
    // =========================================================================

    // ── Bundled Socket.IO client (avoids CSP/PDA loading issues) ──────────
    const SOCKET_IO_BUNDLE = "/*!\n * Socket.IO v4.8.3\n * (c) 2014-2025 Guillermo Rauch\n * Released under the MIT License.\n */\n!function(t,n){\"object\"==typeof exports&&\"undefined\"!=typeof module?module.exports=n():\"function\"==typeof define&&define.amd?define(n):(t=\"undefined\"!=typeof globalThis?globalThis:t||self).io=n()}(this,(function(){\"use strict\";function t(t,n){(null==n||n>t.length)&&(n=t.length);for(var i=0,r=Array(n);i<n;i++)r[i]=t[i];return r}function n(t,n){for(var i=0;i<n.length;i++){var r=n[i];r.enumerable=r.enumerable||!1,r.configurable=!0,\"value\"in r&&(r.writable=!0),Object.defineProperty(t,f(r.key),r)}}function i(t,i,r){return i&&n(t.prototype,i),r&&n(t,r),Object.defineProperty(t,\"prototype\",{writable:!1}),t}function r(n,i){var r=\"undefined\"!=typeof Symbol&&n[Symbol.iterator]||n[\"@@iterator\"];if(!r){if(Array.isArray(n)||(r=function(n,i){if(n){if(\"string\"==typeof n)return t(n,i);var r={}.toString.call(n).slice(8,-1);return\"Object\"===r&&n.constructor&&(r=n.constructor.name),\"Map\"===r||\"Set\"===r?Array.from(n):\"Arguments\"===r||/^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(r)?t(n,i):void 0}}(n))||i&&n&&\"number\"==typeof n.length){r&&(n=r);var e=0,o=function(){};return{s:o,n:function(){return e>=n.length?{done:!0}:{done:!1,value:n[e++]}},e:function(t){throw t},f:o}}throw new TypeError(\"Invalid attempt to iterate non-iterable instance.\\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.\")}var s,u=!0,h=!1;return{s:function(){r=r.call(n)},n:function(){var t=r.next();return u=t.done,t},e:function(t){h=!0,s=t},f:function(){try{u||null==r.return||r.return()}finally{if(h)throw s}}}}function e(){return e=Object.assign?Object.assign.bind():function(t){for(var n=1;n<arguments.length;n++){var i=arguments[n];for(var r in i)({}).hasOwnProperty.call(i,r)&&(t[r]=i[r])}return t},e.apply(null,arguments)}function o(t){return o=Object.setPrototypeOf?Object.getPrototypeOf.bind():function(t){return t.__proto__||Object.getPrototypeOf(t)},o(t)}function s(t,n){t.prototype=Object.create(n.prototype),t.prototype.constructor=t,h(t,n)}function u(){try{var t=!Boolean.prototype.valueOf.call(Reflect.construct(Boolean,[],(function(){})))}catch(t){}return(u=function(){return!!t})()}function h(t,n){return h=Object.setPrototypeOf?Object.setPrototypeOf.bind():function(t,n){return t.__proto__=n,t},h(t,n)}function f(t){var n=function(t,n){if(\"object\"!=typeof t||!t)return t;var i=t[Symbol.toPrimitive];if(void 0!==i){var r=i.call(t,n||\"default\");if(\"object\"!=typeof r)return r;throw new TypeError(\"@@toPrimitive must return a primitive value.\")}return(\"string\"===n?String:Number)(t)}(t,\"string\");return\"symbol\"==typeof n?n:n+\"\"}function c(t){return c=\"function\"==typeof Symbol&&\"symbol\"==typeof Symbol.iterator?function(t){return typeof t}:function(t){return t&&\"function\"==typeof Symbol&&t.constructor===Symbol&&t!==Symbol.prototype?\"symbol\":typeof t},c(t)}function a(t){var n=\"function\"==typeof Map?new Map:void 0;return a=function(t){if(null===t||!function(t){try{return-1!==Function.toString.call(t).indexOf(\"[native code]\")}catch(n){return\"function\"==typeof t}}(t))return t;if(\"function\"!=typeof t)throw new TypeError(\"Super expression must either be null or a function\");if(void 0!==n){if(n.has(t))return n.get(t);n.set(t,i)}function i(){return function(t,n,i){if(u())return Reflect.construct.apply(null,arguments);var r=[null];r.push.apply(r,n);var e=new(t.bind.apply(t,r));return i&&h(e,i.prototype),e}(t,arguments,o(this).constructor)}return i.prototype=Object.create(t.prototype,{constructor:{value:i,enumerable:!1,writable:!0,configurable:!0}}),h(i,t)},a(t)}var v=Object.create(null);v.open=\"0\",v.close=\"1\",v.ping=\"2\",v.pong=\"3\",v.message=\"4\",v.upgrade=\"5\",v.noop=\"6\";var l=Object.create(null);Object.keys(v).forEach((function(t){l[v[t]]=t}));var p,d={type:\"error\",data:\"parser error\"},y=\"function\"==typeof Blob||\"undefined\"!=typeof Blob&&\"[object BlobConstructor]\"===Object.prototype.toString.call(Blob),b=\"function\"==typeof ArrayBuffer,w=function(t){return\"function\"==typeof ArrayBuffer.isView?ArrayBuffer.isView(t):t&&t.buffer instanceof ArrayBuffer},g=function(t,n,i){var r=t.type,e=t.data;return y&&e instanceof Blob?n?i(e):m(e,i):b&&(e instanceof ArrayBuffer||w(e))?n?i(e):m(new Blob([e]),i):i(v[r]+(e||\"\"))},m=function(t,n){var i=new FileReader;return i.onload=function(){var t=i.result.split(\",\")[1];n(\"b\"+(t||\"\"))},i.readAsDataURL(t)};function k(t){return t instanceof Uint8Array?t:t instanceof ArrayBuffer?new Uint8Array(t):new Uint8Array(t.buffer,t.byteOffset,t.byteLength)}for(var A=\"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/\",j=\"undefined\"==typeof Uint8Array?[]:new Uint8Array(256),E=0;E<64;E++)j[A.charCodeAt(E)]=E;var O,B=\"function\"==typeof ArrayBuffer,S=function(t,n){if(\"string\"!=typeof t)return{type:\"message\",data:C(t,n)};var i=t.charAt(0);return\"b\"===i?{type:\"message\",data:N(t.substring(1),n)}:l[i]?t.length>1?{type:l[i],data:t.substring(1)}:{type:l[i]}:d},N=function(t,n){if(B){var i=function(t){var n,i,r,e,o,s=.75*t.length,u=t.length,h=0;\"=\"===t[t.length-1]&&(s--,\"=\"===t[t.length-2]&&s--);var f=new ArrayBuffer(s),c=new Uint8Array(f);for(n=0;n<u;n+=4)i=j[t.charCodeAt(n)],r=j[t.charCodeAt(n+1)],e=j[t.charCodeAt(n+2)],o=j[t.charCodeAt(n+3)],c[h++]=i<<2|r>>4,c[h++]=(15&r)<<4|e>>2,c[h++]=(3&e)<<6|63&o;return f}(t);return C(i,n)}return{base64:!0,data:t}},C=function(t,n){return\"blob\"===n?t instanceof Blob?t:new Blob([t]):t instanceof ArrayBuffer?t:t.buffer},T=String.fromCharCode(30);function U(){return new TransformStream({transform:function(t,n){!function(t,n){y&&t.data instanceof Blob?t.data.arrayBuffer().then(k).then(n):b&&(t.data instanceof ArrayBuffer||w(t.data))?n(k(t.data)):g(t,!1,(function(t){p||(p=new TextEncoder),n(p.encode(t))}))}(t,(function(i){var r,e=i.length;if(e<126)r=new Uint8Array(1),new DataView(r.buffer).setUint8(0,e);else if(e<65536){r=new Uint8Array(3);var o=new DataView(r.buffer);o.setUint8(0,126),o.setUint16(1,e)}else{r=new Uint8Array(9);var s=new DataView(r.buffer);s.setUint8(0,127),s.setBigUint64(1,BigInt(e))}t.data&&\"string\"!=typeof t.data&&(r[0]|=128),n.enqueue(r),n.enqueue(i)}))}})}function M(t){return t.reduce((function(t,n){return t+n.length}),0)}function x(t,n){if(t[0].length===n)return t.shift();for(var i=new Uint8Array(n),r=0,e=0;e<n;e++)i[e]=t[0][r++],r===t[0].length&&(t.shift(),r=0);return t.length&&r<t[0].length&&(t[0]=t[0].slice(r)),i}function I(t){if(t)return function(t){for(var n in I.prototype)t[n]=I.prototype[n];return t}(t)}I.prototype.on=I.prototype.addEventListener=function(t,n){return this.t=this.t||{},(this.t[\"$\"+t]=this.t[\"$\"+t]||[]).push(n),this},I.prototype.once=function(t,n){function i(){this.off(t,i),n.apply(this,arguments)}return i.fn=n,this.on(t,i),this},I.prototype.off=I.prototype.removeListener=I.prototype.removeAllListeners=I.prototype.removeEventListener=function(t,n){if(this.t=this.t||{},0==arguments.length)return this.t={},this;var i,r=this.t[\"$\"+t];if(!r)return this;if(1==arguments.length)return delete this.t[\"$\"+t],this;for(var e=0;e<r.length;e++)if((i=r[e])===n||i.fn===n){r.splice(e,1);break}return 0===r.length&&delete this.t[\"$\"+t],this},I.prototype.emit=function(t){this.t=this.t||{};for(var n=new Array(arguments.length-1),i=this.t[\"$\"+t],r=1;r<arguments.length;r++)n[r-1]=arguments[r];if(i){r=0;for(var e=(i=i.slice(0)).length;r<e;++r)i[r].apply(this,n)}return this},I.prototype.emitReserved=I.prototype.emit,I.prototype.listeners=function(t){return this.t=this.t||{},this.t[\"$\"+t]||[]},I.prototype.hasListeners=function(t){return!!this.listeners(t).length};var R=\"function\"==typeof Promise&&\"function\"==typeof Promise.resolve?function(t){return Promise.resolve().then(t)}:function(t,n){return n(t,0)},L=\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:Function(\"return this\")();function _(t){for(var n=arguments.length,i=new Array(n>1?n-1:0),r=1;r<n;r++)i[r-1]=arguments[r];return i.reduce((function(n,i){return t.hasOwnProperty(i)&&(n[i]=t[i]),n}),{})}var D=L.setTimeout,P=L.clearTimeout;function $(t,n){n.useNativeTimers?(t.setTimeoutFn=D.bind(L),t.clearTimeoutFn=P.bind(L)):(t.setTimeoutFn=L.setTimeout.bind(L),t.clearTimeoutFn=L.clearTimeout.bind(L))}function F(){return Date.now().toString(36).substring(3)+Math.random().toString(36).substring(2,5)}var V=function(t){function n(n,i,r){var e;return(e=t.call(this,n)||this).description=i,e.context=r,e.type=\"TransportError\",e}return s(n,t),n}(a(Error)),q=function(t){function n(n){var i;return(i=t.call(this)||this).writable=!1,$(i,n),i.opts=n,i.query=n.query,i.socket=n.socket,i.supportsBinary=!n.forceBase64,i}s(n,t);var i=n.prototype;return i.onError=function(n,i,r){return t.prototype.emitReserved.call(this,\"error\",new V(n,i,r)),this},i.open=function(){return this.readyState=\"opening\",this.doOpen(),this},i.close=function(){return\"opening\"!==this.readyState&&\"open\"!==this.readyState||(this.doClose(),this.onClose()),this},i.send=function(t){\"open\"===this.readyState&&this.write(t)},i.onOpen=function(){this.readyState=\"open\",this.writable=!0,t.prototype.emitReserved.call(this,\"open\")},i.onData=function(t){var n=S(t,this.socket.binaryType);this.onPacket(n)},i.onPacket=function(n){t.prototype.emitReserved.call(this,\"packet\",n)},i.onClose=function(n){this.readyState=\"closed\",t.prototype.emitReserved.call(this,\"close\",n)},i.pause=function(t){},i.createUri=function(t){var n=arguments.length>1&&void 0!==arguments[1]?arguments[1]:{};return t+\"://\"+this.i()+this.o()+this.opts.path+this.u(n)},i.i=function(){var t=this.opts.hostname;return-1===t.indexOf(\":\")?t:\"[\"+t+\"]\"},i.o=function(){return this.opts.port&&(this.opts.secure&&443!==Number(this.opts.port)||!this.opts.secure&&80!==Number(this.opts.port))?\":\"+this.opts.port:\"\"},i.u=function(t){var n=function(t){var n=\"\";for(var i in t)t.hasOwnProperty(i)&&(n.length&&(n+=\"&\"),n+=encodeURIComponent(i)+\"=\"+encodeURIComponent(t[i]));return n}(t);return n.length?\"?\"+n:\"\"},n}(I),X=function(t){function n(){var n;return(n=t.apply(this,arguments)||this).h=!1,n}s(n,t);var r=n.prototype;return r.doOpen=function(){this.v()},r.pause=function(t){var n=this;this.readyState=\"pausing\";var i=function(){n.readyState=\"paused\",t()};if(this.h||!this.writable){var r=0;this.h&&(r++,this.once(\"pollComplete\",(function(){--r||i()}))),this.writable||(r++,this.once(\"drain\",(function(){--r||i()})))}else i()},r.v=function(){this.h=!0,this.doPoll(),this.emitReserved(\"poll\")},r.onData=function(t){var n=this;(function(t,n){for(var i=t.split(T),r=[],e=0;e<i.length;e++){var o=S(i[e],n);if(r.push(o),\"error\"===o.type)break}return r})(t,this.socket.binaryType).forEach((function(t){if(\"opening\"===n.readyState&&\"open\"===t.type&&n.onOpen(),\"close\"===t.type)return n.onClose({description:\"transport closed by the server\"}),!1;n.onPacket(t)})),\"closed\"!==this.readyState&&(this.h=!1,this.emitReserved(\"pollComplete\"),\"open\"===this.readyState&&this.v())},r.doClose=function(){var t=this,n=function(){t.write([{type:\"close\"}])};\"open\"===this.readyState?n():this.once(\"open\",n)},r.write=function(t){var n=this;this.writable=!1,function(t,n){var i=t.length,r=new Array(i),e=0;t.forEach((function(t,o){g(t,!1,(function(t){r[o]=t,++e===i&&n(r.join(T))}))}))}(t,(function(t){n.doWrite(t,(function(){n.writable=!0,n.emitReserved(\"drain\")}))}))},r.uri=function(){var t=this.opts.secure?\"https\":\"http\",n=this.query||{};return!1!==this.opts.timestampRequests&&(n[this.opts.timestampParam]=F()),this.supportsBinary||n.sid||(n.b64=1),this.createUri(t,n)},i(n,[{key:\"name\",get:function(){return\"polling\"}}])}(q),H=!1;try{H=\"undefined\"!=typeof XMLHttpRequest&&\"withCredentials\"in new XMLHttpRequest}catch(t){}var z=H;function J(){}var K=function(t){function n(n){var i;if(i=t.call(this,n)||this,\"undefined\"!=typeof location){var r=\"https:\"===location.protocol,e=location.port;e||(e=r?\"443\":\"80\"),i.xd=\"undefined\"!=typeof location&&n.hostname!==location.hostname||e!==n.port}return i}s(n,t);var i=n.prototype;return i.doWrite=function(t,n){var i=this,r=this.request({method:\"POST\",data:t});r.on(\"success\",n),r.on(\"error\",(function(t,n){i.onError(\"xhr post error\",t,n)}))},i.doPoll=function(){var t=this,n=this.request();n.on(\"data\",this.onData.bind(this)),n.on(\"error\",(function(n,i){t.onError(\"xhr poll error\",n,i)})),this.pollXhr=n},n}(X),Y=function(t){function n(n,i,r){var e;return(e=t.call(this)||this).createRequest=n,$(e,r),e.l=r,e.p=r.method||\"GET\",e.m=i,e.k=void 0!==r.data?r.data:null,e.A(),e}s(n,t);var i=n.prototype;return i.A=function(){var t,i=this,r=_(this.l,\"agent\",\"pfx\",\"key\",\"passphrase\",\"cert\",\"ca\",\"ciphers\",\"rejectUnauthorized\",\"autoUnref\");r.xdomain=!!this.l.xd;var e=this.j=this.createRequest(r);try{e.open(this.p,this.m,!0);try{if(this.l.extraHeaders)for(var o in e.setDisableHeaderCheck&&e.setDisableHeaderCheck(!0),this.l.extraHeaders)this.l.extraHeaders.hasOwnProperty(o)&&e.setRequestHeader(o,this.l.extraHeaders[o])}catch(t){}if(\"POST\"===this.p)try{e.setRequestHeader(\"Content-type\",\"text/plain;charset=UTF-8\")}catch(t){}try{e.setRequestHeader(\"Accept\",\"*/*\")}catch(t){}null===(t=this.l.cookieJar)||void 0===t||t.addCookies(e),\"withCredentials\"in e&&(e.withCredentials=this.l.withCredentials),this.l.requestTimeout&&(e.timeout=this.l.requestTimeout),e.onreadystatechange=function(){var t;3===e.readyState&&(null===(t=i.l.cookieJar)||void 0===t||t.parseCookies(e.getResponseHeader(\"set-cookie\"))),4===e.readyState&&(200===e.status||1223===e.status?i.O():i.setTimeoutFn((function(){i.B(\"number\"==typeof e.status?e.status:0)}),0))},e.send(this.k)}catch(t){return void this.setTimeoutFn((function(){i.B(t)}),0)}\"undefined\"!=typeof document&&(this.S=n.requestsCount++,n.requests[this.S]=this)},i.B=function(t){this.emitReserved(\"error\",t,this.j),this.N(!0)},i.N=function(t){if(void 0!==this.j&&null!==this.j){if(this.j.onreadystatechange=J,t)try{this.j.abort()}catch(t){}\"undefined\"!=typeof document&&delete n.requests[this.S],this.j=null}},i.O=function(){var t=this.j.responseText;null!==t&&(this.emitReserved(\"data\",t),this.emitReserved(\"success\"),this.N())},i.abort=function(){this.N()},n}(I);if(Y.requestsCount=0,Y.requests={},\"undefined\"!=typeof document)if(\"function\"==typeof attachEvent)attachEvent(\"onunload\",G);else if(\"function\"==typeof addEventListener){addEventListener(\"onpagehide\"in L?\"pagehide\":\"unload\",G,!1)}function G(){for(var t in Y.requests)Y.requests.hasOwnProperty(t)&&Y.requests[t].abort()}var Q,W=(Q=tt({xdomain:!1}))&&null!==Q.responseType,Z=function(t){function n(n){var i;i=t.call(this,n)||this;var r=n&&n.forceBase64;return i.supportsBinary=W&&!r,i}return s(n,t),n.prototype.request=function(){var t=arguments.length>0&&void 0!==arguments[0]?arguments[0]:{};return e(t,{xd:this.xd},this.opts),new Y(tt,this.uri(),t)},n}(K);function tt(t){var n=t.xdomain;try{if(\"undefined\"!=typeof XMLHttpRequest&&(!n||z))return new XMLHttpRequest}catch(t){}if(!n)try{return new(L[[\"Active\"].concat(\"Object\").join(\"X\")])(\"Microsoft.XMLHTTP\")}catch(t){}}var nt=\"undefined\"!=typeof navigator&&\"string\"==typeof navigator.product&&\"reactnative\"===navigator.product.toLowerCase(),it=function(t){function n(){return t.apply(this,arguments)||this}s(n,t);var r=n.prototype;return r.doOpen=function(){var t=this.uri(),n=this.opts.protocols,i=nt?{}:_(this.opts,\"agent\",\"perMessageDeflate\",\"pfx\",\"key\",\"passphrase\",\"cert\",\"ca\",\"ciphers\",\"rejectUnauthorized\",\"localAddress\",\"protocolVersion\",\"origin\",\"maxPayload\",\"family\",\"checkServerIdentity\");this.opts.extraHeaders&&(i.headers=this.opts.extraHeaders);try{this.ws=this.createSocket(t,n,i)}catch(t){return this.emitReserved(\"error\",t)}this.ws.binaryType=this.socket.binaryType,this.addEventListeners()},r.addEventListeners=function(){var t=this;this.ws.onopen=function(){t.opts.autoUnref&&t.ws.C.unref(),t.onOpen()},this.ws.onclose=function(n){return t.onClose({description:\"websocket connection closed\",context:n})},this.ws.onmessage=function(n){return t.onData(n.data)},this.ws.onerror=function(n){return t.onError(\"websocket error\",n)}},r.write=function(t){var n=this;this.writable=!1;for(var i=function(){var i=t[r],e=r===t.length-1;g(i,n.supportsBinary,(function(t){try{n.doWrite(i,t)}catch(t){}e&&R((function(){n.writable=!0,n.emitReserved(\"drain\")}),n.setTimeoutFn)}))},r=0;r<t.length;r++)i()},r.doClose=function(){void 0!==this.ws&&(this.ws.onerror=function(){},this.ws.close(),this.ws=null)},r.uri=function(){var t=this.opts.secure?\"wss\":\"ws\",n=this.query||{};return this.opts.timestampRequests&&(n[this.opts.timestampParam]=F()),this.supportsBinary||(n.b64=1),this.createUri(t,n)},i(n,[{key:\"name\",get:function(){return\"websocket\"}}])}(q),rt=L.WebSocket||L.MozWebSocket,et=function(t){function n(){return t.apply(this,arguments)||this}s(n,t);var i=n.prototype;return i.createSocket=function(t,n,i){return nt?new rt(t,n,i):n?new rt(t,n):new rt(t)},i.doWrite=function(t,n){this.ws.send(n)},n}(it),ot=function(t){function n(){return t.apply(this,arguments)||this}s(n,t);var r=n.prototype;return r.doOpen=function(){var t=this;try{this.T=new WebTransport(this.createUri(\"https\"),this.opts.transportOptions[this.name])}catch(t){return this.emitReserved(\"error\",t)}this.T.closed.then((function(){t.onClose()})).catch((function(n){t.onError(\"webtransport error\",n)})),this.T.ready.then((function(){t.T.createBidirectionalStream().then((function(n){var i=function(t,n){O||(O=new TextDecoder);var i=[],r=0,e=-1,o=!1;return new TransformStream({transform:function(s,u){for(i.push(s);;){if(0===r){if(M(i)<1)break;var h=x(i,1);o=!(128&~h[0]),e=127&h[0],r=e<126?3:126===e?1:2}else if(1===r){if(M(i)<2)break;var f=x(i,2);e=new DataView(f.buffer,f.byteOffset,f.length).getUint16(0),r=3}else if(2===r){if(M(i)<8)break;var c=x(i,8),a=new DataView(c.buffer,c.byteOffset,c.length),v=a.getUint32(0);if(v>Math.pow(2,21)-1){u.enqueue(d);break}e=v*Math.pow(2,32)+a.getUint32(4),r=3}else{if(M(i)<e)break;var l=x(i,e);u.enqueue(S(o?l:O.decode(l),n)),r=0}if(0===e||e>t){u.enqueue(d);break}}}})}(Number.MAX_SAFE_INTEGER,t.socket.binaryType),r=n.readable.pipeThrough(i).getReader(),e=U();e.readable.pipeTo(n.writable),t.U=e.writable.getWriter();!function n(){r.read().then((function(i){var r=i.done,e=i.value;r||(t.onPacket(e),n())})).catch((function(t){}))}();var o={type:\"open\"};t.query.sid&&(o.data='{\"sid\":\"'.concat(t.query.sid,'\"}')),t.U.write(o).then((function(){return t.onOpen()}))}))}))},r.write=function(t){var n=this;this.writable=!1;for(var i=function(){var i=t[r],e=r===t.length-1;n.U.write(i).then((function(){e&&R((function(){n.writable=!0,n.emitReserved(\"drain\")}),n.setTimeoutFn)}))},r=0;r<t.length;r++)i()},r.doClose=function(){var t;null===(t=this.T)||void 0===t||t.close()},i(n,[{key:\"name\",get:function(){return\"webtransport\"}}])}(q),st={websocket:et,webtransport:ot,polling:Z},ut=/^(?:(?![^:@\\/?#]+:[^:@\\/]*@)(http|https|ws|wss):\\/\\/)?((?:(([^:@\\/?#]*)(?::([^:@\\/?#]*))?)?@)?((?:[a-f0-9]{0,4}:){2,7}[a-f0-9]{0,4}|[^:\\/?#]*)(?::(\\d*))?)(((\\/(?:[^?#](?![^?#\\/]*\\.[^?#\\/.]+(?:[?#]|$)))*\\/?)?([^?#\\/]*))(?:\\?([^#]*))?(?:#(.*))?)/,ht=[\"source\",\"protocol\",\"authority\",\"userInfo\",\"user\",\"password\",\"host\",\"port\",\"relative\",\"path\",\"directory\",\"file\",\"query\",\"anchor\"];function ft(t){if(t.length>8e3)throw\"URI too long\";var n=t,i=t.indexOf(\"[\"),r=t.indexOf(\"]\");-1!=i&&-1!=r&&(t=t.substring(0,i)+t.substring(i,r).replace(/:/g,\";\")+t.substring(r,t.length));for(var e,o,s=ut.exec(t||\"\"),u={},h=14;h--;)u[ht[h]]=s[h]||\"\";return-1!=i&&-1!=r&&(u.source=n,u.host=u.host.substring(1,u.host.length-1).replace(/;/g,\":\"),u.authority=u.authority.replace(\"[\",\"\").replace(\"]\",\"\").replace(/;/g,\":\"),u.ipv6uri=!0),u.pathNames=function(t,n){var i=/\\/{2,9}/g,r=n.replace(i,\"/\").split(\"/\");\"/\"!=n.slice(0,1)&&0!==n.length||r.splice(0,1);\"/\"==n.slice(-1)&&r.splice(r.length-1,1);return r}(0,u.path),u.queryKey=(e=u.query,o={},e.replace(/(?:^|&)([^&=]*)=?([^&]*)/g,(function(t,n,i){n&&(o[n]=i)})),o),u}var ct=\"function\"==typeof addEventListener&&\"function\"==typeof removeEventListener,at=[];ct&&addEventListener(\"offline\",(function(){at.forEach((function(t){return t()}))}),!1);var vt=function(t){function n(n,i){var r;if((r=t.call(this)||this).binaryType=\"arraybuffer\",r.writeBuffer=[],r.M=0,r.I=-1,r.R=-1,r.L=-1,r._=1/0,n&&\"object\"===c(n)&&(i=n,n=null),n){var o=ft(n);i.hostname=o.host,i.secure=\"https\"===o.protocol||\"wss\"===o.protocol,i.port=o.port,o.query&&(i.query=o.query)}else i.host&&(i.hostname=ft(i.host).host);return $(r,i),r.secure=null!=i.secure?i.secure:\"undefined\"!=typeof location&&\"https:\"===location.protocol,i.hostname&&!i.port&&(i.port=r.secure?\"443\":\"80\"),r.hostname=i.hostname||(\"undefined\"!=typeof location?location.hostname:\"localhost\"),r.port=i.port||(\"undefined\"!=typeof location&&location.port?location.port:r.secure?\"443\":\"80\"),r.transports=[],r.D={},i.transports.forEach((function(t){var n=t.prototype.name;r.transports.push(n),r.D[n]=t})),r.opts=e({path:\"/engine.io\",agent:!1,withCredentials:!1,upgrade:!0,timestampParam:\"t\",rememberUpgrade:!1,addTrailingSlash:!0,rejectUnauthorized:!0,perMessageDeflate:{threshold:1024},transportOptions:{},closeOnBeforeunload:!1},i),r.opts.path=r.opts.path.replace(/\\/$/,\"\")+(r.opts.addTrailingSlash?\"/\":\"\"),\"string\"==typeof r.opts.query&&(r.opts.query=function(t){for(var n={},i=t.split(\"&\"),r=0,e=i.length;r<e;r++){var o=i[r].split(\"=\");n[decodeURIComponent(o[0])]=decodeURIComponent(o[1])}return n}(r.opts.query)),ct&&(r.opts.closeOnBeforeunload&&(r.P=function(){r.transport&&(r.transport.removeAllListeners(),r.transport.close())},addEventListener(\"beforeunload\",r.P,!1)),\"localhost\"!==r.hostname&&(r.$=function(){r.F(\"transport close\",{description:\"network connection lost\"})},at.push(r.$))),r.opts.withCredentials&&(r.V=void 0),r.q(),r}s(n,t);var i=n.prototype;return i.createTransport=function(t){var n=e({},this.opts.query);n.EIO=4,n.transport=t,this.id&&(n.sid=this.id);var i=e({},this.opts,{query:n,socket:this,hostname:this.hostname,secure:this.secure,port:this.port},this.opts.transportOptions[t]);return new this.D[t](i)},i.q=function(){var t=this;if(0!==this.transports.length){var i=this.opts.rememberUpgrade&&n.priorWebsocketSuccess&&-1!==this.transports.indexOf(\"websocket\")?\"websocket\":this.transports[0];this.readyState=\"opening\";var r=this.createTransport(i);r.open(),this.setTransport(r)}else this.setTimeoutFn((function(){t.emitReserved(\"error\",\"No transports available\")}),0)},i.setTransport=function(t){var n=this;this.transport&&this.transport.removeAllListeners(),this.transport=t,t.on(\"drain\",this.X.bind(this)).on(\"packet\",this.H.bind(this)).on(\"error\",this.B.bind(this)).on(\"close\",(function(t){return n.F(\"transport close\",t)}))},i.onOpen=function(){this.readyState=\"open\",n.priorWebsocketSuccess=\"websocket\"===this.transport.name,this.emitReserved(\"open\"),this.flush()},i.H=function(t){if(\"opening\"===this.readyState||\"open\"===this.readyState||\"closing\"===this.readyState)switch(this.emitReserved(\"packet\",t),this.emitReserved(\"heartbeat\"),t.type){case\"open\":this.onHandshake(JSON.parse(t.data));break;case\"ping\":this.J(\"pong\"),this.emitReserved(\"ping\"),this.emitReserved(\"pong\"),this.K();break;case\"error\":var n=new Error(\"server error\");n.code=t.data,this.B(n);break;case\"message\":this.emitReserved(\"data\",t.data),this.emitReserved(\"message\",t.data)}},i.onHandshake=function(t){this.emitReserved(\"handshake\",t),this.id=t.sid,this.transport.query.sid=t.sid,this.I=t.pingInterval,this.R=t.pingTimeout,this.L=t.maxPayload,this.onOpen(),\"closed\"!==this.readyState&&this.K()},i.K=function(){var t=this;this.clearTimeoutFn(this.Y);var n=this.I+this.R;this._=Date.now()+n,this.Y=this.setTimeoutFn((function(){t.F(\"ping timeout\")}),n),this.opts.autoUnref&&this.Y.unref()},i.X=function(){this.writeBuffer.splice(0,this.M),this.M=0,0===this.writeBuffer.length?this.emitReserved(\"drain\"):this.flush()},i.flush=function(){if(\"closed\"!==this.readyState&&this.transport.writable&&!this.upgrading&&this.writeBuffer.length){var t=this.G();this.transport.send(t),this.M=t.length,this.emitReserved(\"flush\")}},i.G=function(){if(!(this.L&&\"polling\"===this.transport.name&&this.writeBuffer.length>1))return this.writeBuffer;for(var t,n=1,i=0;i<this.writeBuffer.length;i++){var r=this.writeBuffer[i].data;if(r&&(n+=\"string\"==typeof(t=r)?function(t){for(var n=0,i=0,r=0,e=t.length;r<e;r++)(n=t.charCodeAt(r))<128?i+=1:n<2048?i+=2:n<55296||n>=57344?i+=3:(r++,i+=4);return i}(t):Math.ceil(1.33*(t.byteLength||t.size))),i>0&&n>this.L)return this.writeBuffer.slice(0,i);n+=2}return this.writeBuffer},i.W=function(){var t=this;if(!this._)return!0;var n=Date.now()>this._;return n&&(this._=0,R((function(){t.F(\"ping timeout\")}),this.setTimeoutFn)),n},i.write=function(t,n,i){return this.J(\"message\",t,n,i),this},i.send=function(t,n,i){return this.J(\"message\",t,n,i),this},i.J=function(t,n,i,r){if(\"function\"==typeof n&&(r=n,n=void 0),\"function\"==typeof i&&(r=i,i=null),\"closing\"!==this.readyState&&\"closed\"!==this.readyState){(i=i||{}).compress=!1!==i.compress;var e={type:t,data:n,options:i};this.emitReserved(\"packetCreate\",e),this.writeBuffer.push(e),r&&this.once(\"flush\",r),this.flush()}},i.close=function(){var t=this,n=function(){t.F(\"forced close\"),t.transport.close()},i=function i(){t.off(\"upgrade\",i),t.off(\"upgradeError\",i),n()},r=function(){t.once(\"upgrade\",i),t.once(\"upgradeError\",i)};return\"opening\"!==this.readyState&&\"open\"!==this.readyState||(this.readyState=\"closing\",this.writeBuffer.length?this.once(\"drain\",(function(){t.upgrading?r():n()})):this.upgrading?r():n()),this},i.B=function(t){if(n.priorWebsocketSuccess=!1,this.opts.tryAllTransports&&this.transports.length>1&&\"opening\"===this.readyState)return this.transports.shift(),this.q();this.emitReserved(\"error\",t),this.F(\"transport error\",t)},i.F=function(t,n){if(\"opening\"===this.readyState||\"open\"===this.readyState||\"closing\"===this.readyState){if(this.clearTimeoutFn(this.Y),this.transport.removeAllListeners(\"close\"),this.transport.close(),this.transport.removeAllListeners(),ct&&(this.P&&removeEventListener(\"beforeunload\",this.P,!1),this.$)){var i=at.indexOf(this.$);-1!==i&&at.splice(i,1)}this.readyState=\"closed\",this.id=null,this.emitReserved(\"close\",t,n),this.writeBuffer=[],this.M=0}},n}(I);vt.protocol=4;var lt=function(t){function n(){var n;return(n=t.apply(this,arguments)||this).Z=[],n}s(n,t);var i=n.prototype;return i.onOpen=function(){if(t.prototype.onOpen.call(this),\"open\"===this.readyState&&this.opts.upgrade)for(var n=0;n<this.Z.length;n++)this.tt(this.Z[n])},i.tt=function(t){var n=this,i=this.createTransport(t),r=!1;vt.priorWebsocketSuccess=!1;var e=function(){r||(i.send([{type:\"ping\",data:\"probe\"}]),i.once(\"packet\",(function(t){if(!r)if(\"pong\"===t.type&&\"probe\"===t.data){if(n.upgrading=!0,n.emitReserved(\"upgrading\",i),!i)return;vt.priorWebsocketSuccess=\"websocket\"===i.name,n.transport.pause((function(){r||\"closed\"!==n.readyState&&(c(),n.setTransport(i),i.send([{type:\"upgrade\"}]),n.emitReserved(\"upgrade\",i),i=null,n.upgrading=!1,n.flush())}))}else{var e=new Error(\"probe error\");e.transport=i.name,n.emitReserved(\"upgradeError\",e)}})))};function o(){r||(r=!0,c(),i.close(),i=null)}var s=function(t){var r=new Error(\"probe error: \"+t);r.transport=i.name,o(),n.emitReserved(\"upgradeError\",r)};function u(){s(\"transport closed\")}function h(){s(\"socket closed\")}function f(t){i&&t.name!==i.name&&o()}var c=function(){i.removeListener(\"open\",e),i.removeListener(\"error\",s),i.removeListener(\"close\",u),n.off(\"close\",h),n.off(\"upgrading\",f)};i.once(\"open\",e),i.once(\"error\",s),i.once(\"close\",u),this.once(\"close\",h),this.once(\"upgrading\",f),-1!==this.Z.indexOf(\"webtransport\")&&\"webtransport\"!==t?this.setTimeoutFn((function(){r||i.open()}),200):i.open()},i.onHandshake=function(n){this.Z=this.nt(n.upgrades),t.prototype.onHandshake.call(this,n)},i.nt=function(t){for(var n=[],i=0;i<t.length;i++)~this.transports.indexOf(t[i])&&n.push(t[i]);return n},n}(vt),pt=function(t){function n(n){var i=arguments.length>1&&void 0!==arguments[1]?arguments[1]:{},r=\"object\"===c(n)?n:i;return(!r.transports||r.transports&&\"string\"==typeof r.transports[0])&&(r.transports=(r.transports||[\"polling\",\"websocket\",\"webtransport\"]).map((function(t){return st[t]})).filter((function(t){return!!t}))),t.call(this,n,r)||this}return s(n,t),n}(lt);pt.protocol;var dt=\"function\"==typeof ArrayBuffer,yt=function(t){return\"function\"==typeof ArrayBuffer.isView?ArrayBuffer.isView(t):t.buffer instanceof ArrayBuffer},bt=Object.prototype.toString,wt=\"function\"==typeof Blob||\"undefined\"!=typeof Blob&&\"[object BlobConstructor]\"===bt.call(Blob),gt=\"function\"==typeof File||\"undefined\"!=typeof File&&\"[object FileConstructor]\"===bt.call(File);function mt(t){return dt&&(t instanceof ArrayBuffer||yt(t))||wt&&t instanceof Blob||gt&&t instanceof File}function kt(t,n){if(!t||\"object\"!==c(t))return!1;if(Array.isArray(t)){for(var i=0,r=t.length;i<r;i++)if(kt(t[i]))return!0;return!1}if(mt(t))return!0;if(t.toJSON&&\"function\"==typeof t.toJSON&&1===arguments.length)return kt(t.toJSON(),!0);for(var e in t)if(Object.prototype.hasOwnProperty.call(t,e)&&kt(t[e]))return!0;return!1}function At(t){var n=[],i=t.data,r=t;return r.data=jt(i,n),r.attachments=n.length,{packet:r,buffers:n}}function jt(t,n){if(!t)return t;if(mt(t)){var i={_placeholder:!0,num:n.length};return n.push(t),i}if(Array.isArray(t)){for(var r=new Array(t.length),e=0;e<t.length;e++)r[e]=jt(t[e],n);return r}if(\"object\"===c(t)&&!(t instanceof Date)){var o={};for(var s in t)Object.prototype.hasOwnProperty.call(t,s)&&(o[s]=jt(t[s],n));return o}return t}function Et(t,n){return t.data=Ot(t.data,n),delete t.attachments,t}function Ot(t,n){if(!t)return t;if(t&&!0===t._placeholder){if(\"number\"==typeof t.num&&t.num>=0&&t.num<n.length)return n[t.num];throw new Error(\"illegal attachments\")}if(Array.isArray(t))for(var i=0;i<t.length;i++)t[i]=Ot(t[i],n);else if(\"object\"===c(t))for(var r in t)Object.prototype.hasOwnProperty.call(t,r)&&(t[r]=Ot(t[r],n));return t}var Bt,St=[\"connect\",\"connect_error\",\"disconnect\",\"disconnecting\",\"newListener\",\"removeListener\"];!function(t){t[t.CONNECT=0]=\"CONNECT\",t[t.DISCONNECT=1]=\"DISCONNECT\",t[t.EVENT=2]=\"EVENT\",t[t.ACK=3]=\"ACK\",t[t.CONNECT_ERROR=4]=\"CONNECT_ERROR\",t[t.BINARY_EVENT=5]=\"BINARY_EVENT\",t[t.BINARY_ACK=6]=\"BINARY_ACK\"}(Bt||(Bt={}));var Nt=function(){function t(t){this.replacer=t}var n=t.prototype;return n.encode=function(t){return t.type!==Bt.EVENT&&t.type!==Bt.ACK||!kt(t)?[this.encodeAsString(t)]:this.encodeAsBinary({type:t.type===Bt.EVENT?Bt.BINARY_EVENT:Bt.BINARY_ACK,nsp:t.nsp,data:t.data,id:t.id})},n.encodeAsString=function(t){var n=\"\"+t.type;return t.type!==Bt.BINARY_EVENT&&t.type!==Bt.BINARY_ACK||(n+=t.attachments+\"-\"),t.nsp&&\"/\"!==t.nsp&&(n+=t.nsp+\",\"),null!=t.id&&(n+=t.id),null!=t.data&&(n+=JSON.stringify(t.data,this.replacer)),n},n.encodeAsBinary=function(t){var n=At(t),i=this.encodeAsString(n.packet),r=n.buffers;return r.unshift(i),r},t}(),Ct=function(t){function n(n){var i;return(i=t.call(this)||this).reviver=n,i}s(n,t);var i=n.prototype;return i.add=function(n){var i;if(\"string\"==typeof n){if(this.reconstructor)throw new Error(\"got plaintext data when reconstructing a packet\");var r=(i=this.decodeString(n)).type===Bt.BINARY_EVENT;r||i.type===Bt.BINARY_ACK?(i.type=r?Bt.EVENT:Bt.ACK,this.reconstructor=new Tt(i),0===i.attachments&&t.prototype.emitReserved.call(this,\"decoded\",i)):t.prototype.emitReserved.call(this,\"decoded\",i)}else{if(!mt(n)&&!n.base64)throw new Error(\"Unknown type: \"+n);if(!this.reconstructor)throw new Error(\"got binary data when not reconstructing a packet\");(i=this.reconstructor.takeBinaryData(n))&&(this.reconstructor=null,t.prototype.emitReserved.call(this,\"decoded\",i))}},i.decodeString=function(t){var i=0,r={type:Number(t.charAt(0))};if(void 0===Bt[r.type])throw new Error(\"unknown packet type \"+r.type);if(r.type===Bt.BINARY_EVENT||r.type===Bt.BINARY_ACK){for(var e=i+1;\"-\"!==t.charAt(++i)&&i!=t.length;);var o=t.substring(e,i);if(o!=Number(o)||\"-\"!==t.charAt(i))throw new Error(\"Illegal attachments\");r.attachments=Number(o)}if(\"/\"===t.charAt(i+1)){for(var s=i+1;++i;){if(\",\"===t.charAt(i))break;if(i===t.length)break}r.nsp=t.substring(s,i)}else r.nsp=\"/\";var u=t.charAt(i+1);if(\"\"!==u&&Number(u)==u){for(var h=i+1;++i;){var f=t.charAt(i);if(null==f||Number(f)!=f){--i;break}if(i===t.length)break}r.id=Number(t.substring(h,i+1))}if(t.charAt(++i)){var c=this.tryParse(t.substr(i));if(!n.isPayloadValid(r.type,c))throw new Error(\"invalid payload\");r.data=c}return r},i.tryParse=function(t){try{return JSON.parse(t,this.reviver)}catch(t){return!1}},n.isPayloadValid=function(t,n){switch(t){case Bt.CONNECT:return Mt(n);case Bt.DISCONNECT:return void 0===n;case Bt.CONNECT_ERROR:return\"string\"==typeof n||Mt(n);case Bt.EVENT:case Bt.BINARY_EVENT:return Array.isArray(n)&&(\"number\"==typeof n[0]||\"string\"==typeof n[0]&&-1===St.indexOf(n[0]));case Bt.ACK:case Bt.BINARY_ACK:return Array.isArray(n)}},i.destroy=function(){this.reconstructor&&(this.reconstructor.finishedReconstruction(),this.reconstructor=null)},n}(I),Tt=function(){function t(t){this.packet=t,this.buffers=[],this.reconPack=t}var n=t.prototype;return n.takeBinaryData=function(t){if(this.buffers.push(t),this.buffers.length===this.reconPack.attachments){var n=Et(this.reconPack,this.buffers);return this.finishedReconstruction(),n}return null},n.finishedReconstruction=function(){this.reconPack=null,this.buffers=[]},t}();var Ut=Number.isInteger||function(t){return\"number\"==typeof t&&isFinite(t)&&Math.floor(t)===t};function Mt(t){return\"[object Object]\"===Object.prototype.toString.call(t)}var xt=Object.freeze({__proto__:null,protocol:5,get PacketType(){return Bt},Encoder:Nt,Decoder:Ct,isPacketValid:function(t){return\"string\"==typeof t.nsp&&(void 0===(n=t.id)||Ut(n))&&function(t,n){switch(t){case Bt.CONNECT:return void 0===n||Mt(n);case Bt.DISCONNECT:return void 0===n;case Bt.EVENT:return Array.isArray(n)&&(\"number\"==typeof n[0]||\"string\"==typeof n[0]&&-1===St.indexOf(n[0]));case Bt.ACK:return Array.isArray(n);case Bt.CONNECT_ERROR:return\"string\"==typeof n||Mt(n);default:return!1}}(t.type,t.data);var n}});function It(t,n,i){return t.on(n,i),function(){t.off(n,i)}}var Rt=Object.freeze({connect:1,connect_error:1,disconnect:1,disconnecting:1,newListener:1,removeListener:1}),Lt=function(t){function n(n,i,r){var o;return(o=t.call(this)||this).connected=!1,o.recovered=!1,o.receiveBuffer=[],o.sendBuffer=[],o.it=[],o.rt=0,o.ids=0,o.acks={},o.flags={},o.io=n,o.nsp=i,r&&r.auth&&(o.auth=r.auth),o.l=e({},r),o.io.et&&o.open(),o}s(n,t);var o=n.prototype;return o.subEvents=function(){if(!this.subs){var t=this.io;this.subs=[It(t,\"open\",this.onopen.bind(this)),It(t,\"packet\",this.onpacket.bind(this)),It(t,\"error\",this.onerror.bind(this)),It(t,\"close\",this.onclose.bind(this))]}},o.connect=function(){return this.connected||(this.subEvents(),this.io.ot||this.io.open(),\"open\"===this.io.st&&this.onopen()),this},o.open=function(){return this.connect()},o.send=function(){for(var t=arguments.length,n=new Array(t),i=0;i<t;i++)n[i]=arguments[i];return n.unshift(\"message\"),this.emit.apply(this,n),this},o.emit=function(t){var n,i,r;if(Rt.hasOwnProperty(t))throw new Error('\"'+t.toString()+'\" is a reserved event name');for(var e=arguments.length,o=new Array(e>1?e-1:0),s=1;s<e;s++)o[s-1]=arguments[s];if(o.unshift(t),this.l.retries&&!this.flags.fromQueue&&!this.flags.volatile)return this.ut(o),this;var u={type:Bt.EVENT,data:o,options:{}};if(u.options.compress=!1!==this.flags.compress,\"function\"==typeof o[o.length-1]){var h=this.ids++,f=o.pop();this.ht(h,f),u.id=h}var c=null===(i=null===(n=this.io.engine)||void 0===n?void 0:n.transport)||void 0===i?void 0:i.writable,a=this.connected&&!(null===(r=this.io.engine)||void 0===r?void 0:r.W());return this.flags.volatile&&!c||(a?(this.notifyOutgoingListeners(u),this.packet(u)):this.sendBuffer.push(u)),this.flags={},this},o.ht=function(t,n){var i,r=this,e=null!==(i=this.flags.timeout)&&void 0!==i?i:this.l.ackTimeout;if(void 0!==e){var o=this.io.setTimeoutFn((function(){delete r.acks[t];for(var i=0;i<r.sendBuffer.length;i++)r.sendBuffer[i].id===t&&r.sendBuffer.splice(i,1);n.call(r,new Error(\"operation has timed out\"))}),e),s=function(){r.io.clearTimeoutFn(o);for(var t=arguments.length,i=new Array(t),e=0;e<t;e++)i[e]=arguments[e];n.apply(r,i)};s.withError=!0,this.acks[t]=s}else this.acks[t]=n},o.emitWithAck=function(t){for(var n=this,i=arguments.length,r=new Array(i>1?i-1:0),e=1;e<i;e++)r[e-1]=arguments[e];return new Promise((function(i,e){var o=function(t,n){return t?e(t):i(n)};o.withError=!0,r.push(o),n.emit.apply(n,[t].concat(r))}))},o.ut=function(t){var n,i=this;\"function\"==typeof t[t.length-1]&&(n=t.pop());var r={id:this.rt++,tryCount:0,pending:!1,args:t,flags:e({fromQueue:!0},this.flags)};t.push((function(t){if(i.it[0],null!==t)r.tryCount>i.l.retries&&(i.it.shift(),n&&n(t));else if(i.it.shift(),n){for(var e=arguments.length,o=new Array(e>1?e-1:0),s=1;s<e;s++)o[s-1]=arguments[s];n.apply(void 0,[null].concat(o))}return r.pending=!1,i.ft()})),this.it.push(r),this.ft()},o.ft=function(){var t=arguments.length>0&&void 0!==arguments[0]&&arguments[0];if(this.connected&&0!==this.it.length){var n=this.it[0];n.pending&&!t||(n.pending=!0,n.tryCount++,this.flags=n.flags,this.emit.apply(this,n.args))}},o.packet=function(t){t.nsp=this.nsp,this.io.ct(t)},o.onopen=function(){var t=this;\"function\"==typeof this.auth?this.auth((function(n){t.vt(n)})):this.vt(this.auth)},o.vt=function(t){this.packet({type:Bt.CONNECT,data:this.lt?e({pid:this.lt,offset:this.dt},t):t})},o.onerror=function(t){this.connected||this.emitReserved(\"connect_error\",t)},o.onclose=function(t,n){this.connected=!1,delete this.id,this.emitReserved(\"disconnect\",t,n),this.yt()},o.yt=function(){var t=this;Object.keys(this.acks).forEach((function(n){if(!t.sendBuffer.some((function(t){return String(t.id)===n}))){var i=t.acks[n];delete t.acks[n],i.withError&&i.call(t,new Error(\"socket has been disconnected\"))}}))},o.onpacket=function(t){if(t.nsp===this.nsp)switch(t.type){case Bt.CONNECT:t.data&&t.data.sid?this.onconnect(t.data.sid,t.data.pid):this.emitReserved(\"connect_error\",new Error(\"It seems you are trying to reach a Socket.IO server in v2.x with a v3.x client, but they are not compatible (more information here: https://socket.io/docs/v3/migrating-from-2-x-to-3-0/)\"));break;case Bt.EVENT:case Bt.BINARY_EVENT:this.onevent(t);break;case Bt.ACK:case Bt.BINARY_ACK:this.onack(t);break;case Bt.DISCONNECT:this.ondisconnect();break;case Bt.CONNECT_ERROR:this.destroy();var n=new Error(t.data.message);n.data=t.data.data,this.emitReserved(\"connect_error\",n)}},o.onevent=function(t){var n=t.data||[];null!=t.id&&n.push(this.ack(t.id)),this.connected?this.emitEvent(n):this.receiveBuffer.push(Object.freeze(n))},o.emitEvent=function(n){if(this.bt&&this.bt.length){var i,e=r(this.bt.slice());try{for(e.s();!(i=e.n()).done;){i.value.apply(this,n)}}catch(t){e.e(t)}finally{e.f()}}t.prototype.emit.apply(this,n),this.lt&&n.length&&\"string\"==typeof n[n.length-1]&&(this.dt=n[n.length-1])},o.ack=function(t){var n=this,i=!1;return function(){if(!i){i=!0;for(var r=arguments.length,e=new Array(r),o=0;o<r;o++)e[o]=arguments[o];n.packet({type:Bt.ACK,id:t,data:e})}}},o.onack=function(t){var n=this.acks[t.id];\"function\"==typeof n&&(delete this.acks[t.id],n.withError&&t.data.unshift(null),n.apply(this,t.data))},o.onconnect=function(t,n){this.id=t,this.recovered=n&&this.lt===n,this.lt=n,this.connected=!0,this.emitBuffered(),this.ft(!0),this.emitReserved(\"connect\")},o.emitBuffered=function(){var t=this;this.receiveBuffer.forEach((function(n){return t.emitEvent(n)})),this.receiveBuffer=[],this.sendBuffer.forEach((function(n){t.notifyOutgoingListeners(n),t.packet(n)})),this.sendBuffer=[]},o.ondisconnect=function(){this.destroy(),this.onclose(\"io server disconnect\")},o.destroy=function(){this.subs&&(this.subs.forEach((function(t){return t()})),this.subs=void 0),this.io.wt(this)},o.disconnect=function(){return this.connected&&this.packet({type:Bt.DISCONNECT}),this.destroy(),this.connected&&this.onclose(\"io client disconnect\"),this},o.close=function(){return this.disconnect()},o.compress=function(t){return this.flags.compress=t,this},o.timeout=function(t){return this.flags.timeout=t,this},o.onAny=function(t){return this.bt=this.bt||[],this.bt.push(t),this},o.prependAny=function(t){return this.bt=this.bt||[],this.bt.unshift(t),this},o.offAny=function(t){if(!this.bt)return this;if(t){for(var n=this.bt,i=0;i<n.length;i++)if(t===n[i])return n.splice(i,1),this}else this.bt=[];return this},o.listenersAny=function(){return this.bt||[]},o.onAnyOutgoing=function(t){return this.gt=this.gt||[],this.gt.push(t),this},o.prependAnyOutgoing=function(t){return this.gt=this.gt||[],this.gt.unshift(t),this},o.offAnyOutgoing=function(t){if(!this.gt)return this;if(t){for(var n=this.gt,i=0;i<n.length;i++)if(t===n[i])return n.splice(i,1),this}else this.gt=[];return this},o.listenersAnyOutgoing=function(){return this.gt||[]},o.notifyOutgoingListeners=function(t){if(this.gt&&this.gt.length){var n,i=r(this.gt.slice());try{for(i.s();!(n=i.n()).done;){n.value.apply(this,t.data)}}catch(t){i.e(t)}finally{i.f()}}},i(n,[{key:\"disconnected\",get:function(){return!this.connected}},{key:\"active\",get:function(){return!!this.subs}},{key:\"volatile\",get:function(){return this.flags.volatile=!0,this}}])}(I);function _t(t){t=t||{},this.ms=t.min||100,this.max=t.max||1e4,this.factor=t.factor||2,this.jitter=t.jitter>0&&t.jitter<=1?t.jitter:0,this.attempts=0}_t.prototype.duration=function(){var t=this.ms*Math.pow(this.factor,this.attempts++);if(this.jitter){var n=Math.random(),i=Math.floor(n*this.jitter*t);t=1&Math.floor(10*n)?t+i:t-i}return 0|Math.min(t,this.max)},_t.prototype.reset=function(){this.attempts=0},_t.prototype.setMin=function(t){this.ms=t},_t.prototype.setMax=function(t){this.max=t},_t.prototype.setJitter=function(t){this.jitter=t};var Dt=function(t){function n(n,i){var r,e;(r=t.call(this)||this).nsps={},r.subs=[],n&&\"object\"===c(n)&&(i=n,n=void 0),(i=i||{}).path=i.path||\"/socket.io\",r.opts=i,$(r,i),r.reconnection(!1!==i.reconnection),r.reconnectionAttempts(i.reconnectionAttempts||1/0),r.reconnectionDelay(i.reconnectionDelay||1e3),r.reconnectionDelayMax(i.reconnectionDelayMax||5e3),r.randomizationFactor(null!==(e=i.randomizationFactor)&&void 0!==e?e:.5),r.backoff=new _t({min:r.reconnectionDelay(),max:r.reconnectionDelayMax(),jitter:r.randomizationFactor()}),r.timeout(null==i.timeout?2e4:i.timeout),r.st=\"closed\",r.uri=n;var o=i.parser||xt;return r.encoder=new o.Encoder,r.decoder=new o.Decoder,r.et=!1!==i.autoConnect,r.et&&r.open(),r}s(n,t);var i=n.prototype;return i.reconnection=function(t){return arguments.length?(this.kt=!!t,t||(this.skipReconnect=!0),this):this.kt},i.reconnectionAttempts=function(t){return void 0===t?this.At:(this.At=t,this)},i.reconnectionDelay=function(t){var n;return void 0===t?this.jt:(this.jt=t,null===(n=this.backoff)||void 0===n||n.setMin(t),this)},i.randomizationFactor=function(t){var n;return void 0===t?this.Et:(this.Et=t,null===(n=this.backoff)||void 0===n||n.setJitter(t),this)},i.reconnectionDelayMax=function(t){var n;return void 0===t?this.Ot:(this.Ot=t,null===(n=this.backoff)||void 0===n||n.setMax(t),this)},i.timeout=function(t){return arguments.length?(this.Bt=t,this):this.Bt},i.maybeReconnectOnOpen=function(){!this.ot&&this.kt&&0===this.backoff.attempts&&this.reconnect()},i.open=function(t){var n=this;if(~this.st.indexOf(\"open\"))return this;this.engine=new pt(this.uri,this.opts);var i=this.engine,r=this;this.st=\"opening\",this.skipReconnect=!1;var e=It(i,\"open\",(function(){r.onopen(),t&&t()})),o=function(i){n.cleanup(),n.st=\"closed\",n.emitReserved(\"error\",i),t?t(i):n.maybeReconnectOnOpen()},s=It(i,\"error\",o);if(!1!==this.Bt){var u=this.Bt,h=this.setTimeoutFn((function(){e(),o(new Error(\"timeout\")),i.close()}),u);this.opts.autoUnref&&h.unref(),this.subs.push((function(){n.clearTimeoutFn(h)}))}return this.subs.push(e),this.subs.push(s),this},i.connect=function(t){return this.open(t)},i.onopen=function(){this.cleanup(),this.st=\"open\",this.emitReserved(\"open\");var t=this.engine;this.subs.push(It(t,\"ping\",this.onping.bind(this)),It(t,\"data\",this.ondata.bind(this)),It(t,\"error\",this.onerror.bind(this)),It(t,\"close\",this.onclose.bind(this)),It(this.decoder,\"decoded\",this.ondecoded.bind(this)))},i.onping=function(){this.emitReserved(\"ping\")},i.ondata=function(t){try{this.decoder.add(t)}catch(t){this.onclose(\"parse error\",t)}},i.ondecoded=function(t){var n=this;R((function(){n.emitReserved(\"packet\",t)}),this.setTimeoutFn)},i.onerror=function(t){this.emitReserved(\"error\",t)},i.socket=function(t,n){var i=this.nsps[t];return i?this.et&&!i.active&&i.connect():(i=new Lt(this,t,n),this.nsps[t]=i),i},i.wt=function(t){for(var n=0,i=Object.keys(this.nsps);n<i.length;n++){var r=i[n];if(this.nsps[r].active)return}this.St()},i.ct=function(t){for(var n=this.encoder.encode(t),i=0;i<n.length;i++)this.engine.write(n[i],t.options)},i.cleanup=function(){this.subs.forEach((function(t){return t()})),this.subs.length=0,this.decoder.destroy()},i.St=function(){this.skipReconnect=!0,this.ot=!1,this.onclose(\"forced close\")},i.disconnect=function(){return this.St()},i.onclose=function(t,n){var i;this.cleanup(),null===(i=this.engine)||void 0===i||i.close(),this.backoff.reset(),this.st=\"closed\",this.emitReserved(\"close\",t,n),this.kt&&!this.skipReconnect&&this.reconnect()},i.reconnect=function(){var t=this;if(this.ot||this.skipReconnect)return this;var n=this;if(this.backoff.attempts>=this.At)this.backoff.reset(),this.emitReserved(\"reconnect_failed\"),this.ot=!1;else{var i=this.backoff.duration();this.ot=!0;var r=this.setTimeoutFn((function(){n.skipReconnect||(t.emitReserved(\"reconnect_attempt\",n.backoff.attempts),n.skipReconnect||n.open((function(i){i?(n.ot=!1,n.reconnect(),t.emitReserved(\"reconnect_error\",i)):n.onreconnect()})))}),i);this.opts.autoUnref&&r.unref(),this.subs.push((function(){t.clearTimeoutFn(r)}))}},i.onreconnect=function(){var t=this.backoff.attempts;this.ot=!1,this.backoff.reset(),this.emitReserved(\"reconnect\",t)},n}(I),Pt={};function $t(t,n){\"object\"===c(t)&&(n=t,t=void 0);var i,r=function(t){var n=arguments.length>1&&void 0!==arguments[1]?arguments[1]:\"\",i=arguments.length>2?arguments[2]:void 0,r=t;i=i||\"undefined\"!=typeof location&&location,null==t&&(t=i.protocol+\"//\"+i.host),\"string\"==typeof t&&(\"/\"===t.charAt(0)&&(t=\"/\"===t.charAt(1)?i.protocol+t:i.host+t),/^(https?|wss?):\\/\\//.test(t)||(t=void 0!==i?i.protocol+\"//\"+t:\"https://\"+t),r=ft(t)),r.port||(/^(http|ws)$/.test(r.protocol)?r.port=\"80\":/^(http|ws)s$/.test(r.protocol)&&(r.port=\"443\")),r.path=r.path||\"/\";var e=-1!==r.host.indexOf(\":\")?\"[\"+r.host+\"]\":r.host;return r.id=r.protocol+\"://\"+e+\":\"+r.port+n,r.href=r.protocol+\"://\"+e+(i&&i.port===r.port?\"\":\":\"+r.port),r}(t,(n=n||{}).path||\"/socket.io\"),e=r.source,o=r.id,s=r.path,u=Pt[o]&&s in Pt[o].nsps;return n.forceNew||n[\"force new connection\"]||!1===n.multiplex||u?i=new Dt(e,n):(Pt[o]||(Pt[o]=new Dt(e,n)),i=Pt[o]),r.query&&!n.query&&(n.query=r.queryKey),i.socket(r.path,n)}return e($t,{Manager:Dt,Socket:Lt,io:$t,connect:$t}),$t}));\n//# sourceMappingURL=socket.io.min.js.map\n";


    /**
     * Load Socket.IO client library by injecting a <script> tag pointing to
     * the CDN.  Returns a promise that resolves once `window.io` is available.
     */
    async function loadSocketIO() {
        if (typeof window.io === 'function') {
            log('Socket.IO already loaded');
            return;
        }

        log('Loading Socket.IO (bundled)...');

        // Socket.IO is bundled inline below — inject it via blob URL
        const sioCode = SOCKET_IO_BUNDLE;
        const blob = new Blob([sioCode], { type: 'application/javascript' });
        const blobUrl = URL.createObjectURL(blob);

        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = blobUrl;
            s.onload = () => {
                URL.revokeObjectURL(blobUrl);
                if (typeof window.io === 'function') {
                    log('Socket.IO loaded successfully (bundled)');
                    resolve();
                } else {
                    reject(new Error('Socket.IO bundle loaded but window.io not found'));
                }
            };
            s.onerror = () => {
                URL.revokeObjectURL(blobUrl);
                reject(new Error('Failed to inject bundled Socket.IO'));
            };
            document.head.appendChild(s);
        });
    }

    // =========================================================================
    // SECTION 7: AUTH MANAGER
    // =========================================================================

    /**
     * Authenticate with the FactionOps server.
     * Sends the Torn API key to POST /api/auth, receives a JWT.
     */
    function authenticate() {
        return new Promise(async (resolve, reject) => {
            if (!CONFIG.API_KEY) {
                return reject(new Error('No API key configured'));
            }
            log('Authenticating with server...');

            if (IS_PDA) {
                // PDA: use fetch for POST requests (GM_xmlhttpRequest not available)
                try {
                    const resp = await fetch(`${CONFIG.SERVER_URL}/api/auth`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ apiKey: CONFIG.API_KEY }),
                    });
                    const body = await resp.json();
                    if (resp.ok && body && body.token) {
                        state.jwtToken = body.token;
                        GM_setValue('factionops_jwt', body.token);
                        if (body.player) {
                            state.myPlayerId = String(body.player.id);
                            state.myPlayerName = body.player.name;
                        }
                        log('Authenticated as', state.myPlayerName || 'unknown');
                        resolve(body);
                    } else {
                        reject(new Error((body && body.error) || `HTTP ${resp.status}`));
                    }
                } catch (e) {
                    reject(new Error('Network error — is the server running?'));
                }
                return;
            }

            GM_xmlhttpRequest({
                method: 'POST',
                url: `${CONFIG.SERVER_URL}/api/auth`,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ apiKey: CONFIG.API_KEY }),
                onload(res) {
                    const body = safeParse(res.responseText);
                    if (res.status === 200 && body && body.token) {
                        state.jwtToken = body.token;
                        GM_setValue('factionops_jwt', body.token);
                        if (body.player) {
                            state.myPlayerId = String(body.player.id);
                            state.myPlayerName = body.player.name;
                        }
                        log('Authenticated as', state.myPlayerName || 'unknown');
                        resolve(body);
                    } else {
                        const msg = (body && body.error) || `HTTP ${res.status}`;
                        reject(new Error(msg));
                    }
                },
                onerror() {
                    reject(new Error('Network error — is the server running?'));
                },
            });
        });
    }

    /**
     * Verify current API key against the server.
     * Returns { valid: true, player: {...} } or throws.
     */
    function verifyApiKey() {
        return new Promise(async (resolve, reject) => {
            if (!CONFIG.API_KEY) {
                return reject(new Error('No API key'));
            }

            if (IS_PDA) {
                try {
                    const resp = await fetch(`${CONFIG.SERVER_URL}/api/auth/verify`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${state.jwtToken}`,
                        },
                        body: JSON.stringify({ apiKey: CONFIG.API_KEY }),
                    });
                    const body = await resp.json();
                    if (resp.ok && body && body.valid) {
                        resolve(body);
                    } else {
                        reject(new Error((body && body.error) || 'Verification failed'));
                    }
                } catch (e) {
                    reject(new Error('Network error'));
                }
                return;
            }

            GM_xmlhttpRequest({
                method: 'POST',
                url: `${CONFIG.SERVER_URL}/api/auth/verify`,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${state.jwtToken}`,
                },
                data: JSON.stringify({ apiKey: CONFIG.API_KEY }),
                onload(res) {
                    const body = safeParse(res.responseText);
                    if (res.status === 200 && body && body.valid) {
                        resolve(body);
                    } else {
                        reject(new Error((body && body.error) || 'Verification failed'));
                    }
                },
                onerror() {
                    reject(new Error('Network error'));
                },
            });
        });
    }

    // =========================================================================
    // SECTION 8: SOCKET.IO CLIENT
    // =========================================================================

    let reconnectAttempts = 0;
    const MAX_RECONNECT_DELAY = 30000;

    /** Initialise (or re-initialise) the Socket.IO connection. */
    function connectSocket() {
        if (state.socket) {
            state.socket.disconnect();
            state.socket = null;
        }

        if (!state.jwtToken) {
            warn('No JWT token — cannot connect socket');
            state.connected = false;
            state.connecting = false;
            updateConnectionUI();
            return;
        }

        state.connecting = true;
        updateConnectionUI();

        const socket = window.io(CONFIG.SERVER_URL, {
            auth: { token: state.jwtToken },
            transports: ['websocket', 'polling'],
            reconnection: false, // we handle reconnection ourselves
        });

        state.socket = socket;

        socket.on('connect', () => {
            log('Socket connected:', socket.id);
            state.connected = true;
            state.connecting = false;
            reconnectAttempts = 0;
            updateConnectionUI();
        });

        socket.on('disconnect', (reason) => {
            log('Socket disconnected:', reason);
            state.connected = false;
            state.connecting = false;
            updateConnectionUI();
            scheduleReconnect();
        });

        socket.on('connect_error', (err) => {
            warn('Socket connection error:', err.message);
            state.connected = false;
            state.connecting = false;
            updateConnectionUI();

            // If auth error, try to re-authenticate
            if (err.message && err.message.includes('auth')) {
                log('Auth error — re-authenticating...');
                authenticate()
                    .then(() => connectSocket())
                    .catch((e) => {
                        error('Re-auth failed:', e.message);
                        scheduleReconnect();
                    });
            } else {
                scheduleReconnect();
            }
        });

        // ---- Server events ----

        socket.on('target_called', (data) => {
            // data: { targetId, calledBy: { id, name }, calledAt }
            log('Target called:', data.targetId, 'by', data.calledBy.name);
            state.calls[data.targetId] = {
                calledBy: data.calledBy,
                calledAt: data.calledAt || Date.now(),
            };
            updateTargetRow(data.targetId);
        });

        socket.on('target_uncalled', (data) => {
            // data: { targetId }
            log('Target uncalled:', data.targetId);
            delete state.calls[data.targetId];
            updateTargetRow(data.targetId);
        });

        socket.on('rally_started', (data) => {
            // data: { targetId, startedBy, participants }
            log('Rally started on', data.targetId);
            state.rallies[data.targetId] = {
                startedBy: data.startedBy,
                participants: data.participants || [data.startedBy],
            };
            updateTargetRow(data.targetId);
        });

        socket.on('rally_updated', (data) => {
            // data: { targetId, participants }
            if (state.rallies[data.targetId]) {
                state.rallies[data.targetId].participants = data.participants;
            } else {
                state.rallies[data.targetId] = { startedBy: null, participants: data.participants };
            }
            updateTargetRow(data.targetId);
        });

        socket.on('rally_ended', (data) => {
            log('Rally ended on', data.targetId);
            delete state.rallies[data.targetId];
            updateTargetRow(data.targetId);
        });

        socket.on('status_update', (data) => {
            // data: { targetId, status, until, description, activity }
            state.statuses[data.targetId] = {
                status: data.status,
                until: data.until,
                description: data.description || '',
                activity: data.activity || 'offline',
            };
            updateTargetRow(data.targetId);
            if (CONFIG.AUTO_SORT) debouncedSort();
        });

        socket.on('chain_update', (data) => {
            // data: { current, max, timeout, cooldown }
            state.chain = { ...state.chain, ...data };
            updateChainBar();
        });

        socket.on('bulk_state', (data) => {
            // Initial state dump after connecting
            // data: { calls, rallies, statuses, chain }
            log('Received bulk state');
            if (data.calls) state.calls = data.calls;
            if (data.rallies) state.rallies = data.rallies;
            if (data.statuses) state.statuses = data.statuses;
            if (data.chain) state.chain = { ...state.chain, ...data.chain };
            refreshAllRows();
            updateChainBar();
        });

        socket.on('error', (data) => {
            warn('Server error:', data.message || data);
        });
    }

    /** Schedule a reconnect with exponential backoff. */
    function scheduleReconnect() {
        reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
        log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})...`);
        setTimeout(() => {
            if (!state.connected && !state.connecting) {
                connectSocket();
            }
        }, delay);
    }

    // ---- Emit helpers ----

    function emitCallTarget(targetId) {
        if (!state.socket || !state.connected) return;
        state.socket.emit('call_target', { targetId: String(targetId) });
    }

    function emitUncallTarget(targetId) {
        if (!state.socket || !state.connected) return;
        state.socket.emit('uncall_target', { targetId: String(targetId) });
    }

    function emitStartRally(targetId) {
        if (!state.socket || !state.connected) return;
        state.socket.emit('start_rally', { targetId: String(targetId) });
    }

    function emitJoinRally(targetId) {
        if (!state.socket || !state.connected) return;
        state.socket.emit('join_rally', { targetId: String(targetId) });
    }

    function emitLeaveRally(targetId) {
        if (!state.socket || !state.connected) return;
        state.socket.emit('leave_rally', { targetId: String(targetId) });
    }

    // =========================================================================
    // SECTION 9: SETTINGS PANEL
    // =========================================================================

    /** Create and inject the floating gear icon. */
    function createSettingsGear() {
        const gear = document.createElement('div');
        gear.className = 'wb-settings-gear';
        gear.textContent = '\u2699'; // gear unicode
        gear.title = 'FactionOps Settings';
        gear.addEventListener('click', toggleSettings);
        document.body.appendChild(gear);
    }

    /** Toggle the settings modal open/closed. */
    function toggleSettings() {
        if (state.ui.settingsOpen) {
            closeSettings();
        } else {
            openSettings();
        }
    }

    function openSettings() {
        if (state.ui.settingsOpen) return;
        state.ui.settingsOpen = true;

        const overlay = document.createElement('div');
        overlay.className = 'wb-settings-overlay';
        overlay.id = 'wb-settings-overlay';
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeSettings();
        });

        const modal = document.createElement('div');
        modal.className = 'wb-settings-modal';

        // Determine connection state string
        let connText = 'Disconnected';
        let connClass = 'disconnected';
        if (state.connected) { connText = 'Connected'; connClass = 'connected'; }
        else if (state.connecting) { connText = 'Connecting...'; connClass = 'connecting'; }

        modal.innerHTML = `
            <h2>\u2699 FactionOps Settings</h2>

            <div class="wb-connection-status">
                <span class="wb-status-dot ${connClass}" id="wb-settings-conn-dot"></span>
                <span id="wb-settings-conn-text">${connText}</span>
            </div>

            <label for="wb-input-server">Server URL</label>
            <input type="text" id="wb-input-server" value="${escapeHtml(CONFIG.SERVER_URL)}" placeholder="http://localhost:3000">

            <label for="wb-input-apikey">Torn API Key</label>
            <div style="display:flex;gap:6px;margin-bottom:14px;">
                <input type="password" id="wb-input-apikey" value="${escapeHtml(CONFIG.API_KEY)}" placeholder="Your Torn API key" style="margin-bottom:0;flex:1;" ${CONFIG.IS_PDA && CONFIG.API_KEY === PDA_API_KEY ? 'disabled' : ''}>
                <button class="wb-btn wb-btn-sm" id="wb-btn-verify">Verify</button>
            </div>
            ${CONFIG.IS_PDA ? '<div style="font-size:11px;color:#87ceeb;margin-bottom:8px;">\u2705 Torn PDA detected — using PDA-managed API key.</div>' : ''}
            <div id="wb-verify-result" style="font-size:11px;margin-bottom:10px;min-height:14px;"></div>

            <div class="wb-settings-row">
                <span>Theme</span>
                <label class="wb-toggle">
                    <input type="checkbox" id="wb-toggle-theme" ${CONFIG.THEME === 'light' ? 'checked' : ''}>
                    <span class="wb-toggle-slider"></span>
                </label>
                <span style="font-size:11px;opacity:0.6;">${CONFIG.THEME === 'light' ? 'Light' : 'Dark'}</span>
            </div>

            <div class="wb-settings-row">
                <span>Auto-Sort Targets</span>
                <label class="wb-toggle">
                    <input type="checkbox" id="wb-toggle-autosort" ${CONFIG.AUTO_SORT ? 'checked' : ''}>
                    <span class="wb-toggle-slider"></span>
                </label>
            </div>

            <div class="wb-settings-actions">
                <button class="wb-btn wb-btn-danger" id="wb-btn-disconnect">Disconnect</button>
                <button class="wb-btn" id="wb-btn-save">Save &amp; Connect</button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // ---- Event listeners inside modal ----

        document.getElementById('wb-btn-verify').addEventListener('click', async () => {
            const resultEl = document.getElementById('wb-verify-result');
            const apiKey = document.getElementById('wb-input-apikey').value.trim();
            if (!apiKey) {
                resultEl.textContent = 'Please enter an API key.';
                resultEl.style.color = 'var(--wb-call-red)';
                return;
            }
            resultEl.textContent = 'Verifying...';
            resultEl.style.color = 'var(--wb-idle-yellow)';
            try {
                setConfig('API_KEY', apiKey);
                setConfig('SERVER_URL', document.getElementById('wb-input-server').value.trim() || 'http://localhost:3000');
                await authenticate();
                resultEl.textContent = `Verified! Player: ${state.myPlayerName || state.myPlayerId}`;
                resultEl.style.color = 'var(--wb-call-green)';
            } catch (e) {
                resultEl.textContent = `Error: ${e.message}`;
                resultEl.style.color = 'var(--wb-call-red)';
            }
        });

        document.getElementById('wb-toggle-theme').addEventListener('change', (e) => {
            const theme = e.target.checked ? 'light' : 'dark';
            setConfig('THEME', theme);
            applyTheme();
            // Update label
            e.target.closest('.wb-settings-row').querySelector('span:last-child').textContent = theme === 'light' ? 'Light' : 'Dark';
        });

        document.getElementById('wb-toggle-autosort').addEventListener('change', (e) => {
            setConfig('AUTO_SORT', e.target.checked);
            if (e.target.checked) debouncedSort();
        });

        document.getElementById('wb-btn-disconnect').addEventListener('click', () => {
            if (state.socket) {
                state.socket.disconnect();
                state.socket = null;
            }
            state.connected = false;
            state.connecting = false;
            updateConnectionUI();
            closeSettings();
        });

        document.getElementById('wb-btn-save').addEventListener('click', async () => {
            const serverUrl = document.getElementById('wb-input-server').value.trim() || 'http://localhost:3000';
            const apiKey = document.getElementById('wb-input-apikey').value.trim();

            setConfig('SERVER_URL', serverUrl);
            setConfig('API_KEY', apiKey);

            if (apiKey) {
                try {
                    await authenticate();
                    connectSocket();
                } catch (e) {
                    warn('Auth failed on save:', e.message);
                    // Still try socket in case JWT is cached
                    connectSocket();
                }
            }
            closeSettings();
        });
    }

    function closeSettings() {
        state.ui.settingsOpen = false;
        const overlay = document.getElementById('wb-settings-overlay');
        if (overlay) overlay.remove();
    }

    /** Escape HTML for safe insertion into innerHTML. */
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    /** Update connection indicators wherever they appear. */
    function updateConnectionUI() {
        // Settings modal indicator
        const dot = document.getElementById('wb-settings-conn-dot');
        const text = document.getElementById('wb-settings-conn-text');
        if (dot && text) {
            dot.className = 'wb-status-dot ' +
                (state.connected ? 'connected' : state.connecting ? 'connecting' : 'disconnected');
            text.textContent = state.connected ? 'Connected' : state.connecting ? 'Connecting...' : 'Disconnected';
        }

        // Gear icon color hint
        const gear = document.querySelector('.wb-settings-gear');
        if (gear) {
            gear.style.borderColor = state.connected
                ? 'var(--wb-call-green)'
                : state.connecting
                    ? 'var(--wb-idle-yellow)'
                    : 'var(--wb-call-red)';
        }
    }

    /** Apply theme class to html element. */
    function applyTheme() {
        document.documentElement.classList.toggle('wb-theme-light', CONFIG.THEME === 'light');
    }

    // =========================================================================
    // SECTION 10: CHAIN MONITOR BAR
    // =========================================================================

    /** Create or update the chain monitor bar fixed to the top of the page. */
    function createChainBar() {
        if (state.ui.chainBar) return; // already exists

        const bar = document.createElement('div');
        bar.className = 'wb-chain-bar wb-chain-safe';
        bar.id = 'wb-chain-bar';

        bar.innerHTML = `
            <div class="wb-chain-section">
                <span>Chain:</span>
                <span class="wb-chain-count" id="wb-chain-count">0/0</span>
                <span id="wb-chain-bonus-badge" class="wb-chain-bonus" style="display:none;"></span>
            </div>
            <div class="wb-chain-section">
                <span>Timeout:</span>
                <span class="wb-chain-timeout" id="wb-chain-timeout">--:--</span>
            </div>
            <div class="wb-chain-section">
                <span class="wb-chain-minimize" id="wb-chain-minimize" title="Minimize">\u2715</span>
            </div>
        `;

        document.body.appendChild(bar);
        document.body.classList.add('wb-chain-active');

        state.ui.chainBar = bar;

        document.getElementById('wb-chain-minimize').addEventListener('click', () => {
            bar.style.display = 'none';
            document.body.classList.remove('wb-chain-active');
        });

        updateChainBar();
    }

    /** Update chain bar contents and styling. */
    function updateChainBar() {
        const bar = state.ui.chainBar;
        if (!bar || bar.style.display === 'none') return;

        const countEl = document.getElementById('wb-chain-count');
        const timeoutEl = document.getElementById('wb-chain-timeout');
        const bonusBadge = document.getElementById('wb-chain-bonus-badge');

        if (countEl) {
            countEl.textContent = `${state.chain.current}/${state.chain.max || '??'}`;
        }

        if (timeoutEl) {
            if (state.chain.timeout > 0) {
                timeoutEl.textContent = formatTimer(state.chain.timeout);
            } else if (state.chain.cooldown > 0) {
                timeoutEl.textContent = `CD: ${formatTimer(state.chain.cooldown)}`;
            } else {
                timeoutEl.textContent = '--:--';
            }
        }

        // Bonus milestone logic
        const next = nextBonusMilestone(state.chain.current + 1);
        const hitsToBonus = next ? next - state.chain.current : null;

        if (bonusBadge) {
            if (hitsToBonus !== null && hitsToBonus <= 10) {
                bonusBadge.style.display = 'inline';
                if (hitsToBonus <= 0) {
                    bonusBadge.textContent = `BONUS ${next}!`;
                } else {
                    bonusBadge.textContent = `BONUS in ${hitsToBonus}`;
                }
            } else {
                bonusBadge.style.display = 'none';
            }
        }

        // Bar colour class
        bar.classList.remove('wb-chain-safe', 'wb-chain-approaching', 'wb-chain-imminent');
        if (hitsToBonus !== null && hitsToBonus <= 3) {
            bar.classList.add('wb-chain-imminent');
        } else if (hitsToBonus !== null && hitsToBonus <= 10) {
            bar.classList.add('wb-chain-approaching');
        } else {
            bar.classList.add('wb-chain-safe');
        }
    }

    // Client-side countdown for chain timeout/cooldown
    let chainTimerRAF = null;
    let chainTimerLast = 0;

    function startChainTimer() {
        if (chainTimerRAF) return; // already running
        chainTimerLast = performance.now();

        function tick(now) {
            const dt = (now - chainTimerLast) / 1000;
            chainTimerLast = now;

            if (state.chain.timeout > 0) {
                state.chain.timeout = Math.max(0, state.chain.timeout - dt);
            }
            if (state.chain.cooldown > 0) {
                state.chain.cooldown = Math.max(0, state.chain.cooldown - dt);
            }

            updateChainBar();
            chainTimerRAF = requestAnimationFrame(tick);
        }

        chainTimerRAF = requestAnimationFrame(tick);
    }

    // =========================================================================
    // SECTION 11: STATUS COUNTDOWN TIMERS
    // =========================================================================

    // We keep a set of active timers that decrement `until` fields in
    // state.statuses. A single rAF loop handles all of them.
    let statusTimerRAF = null;
    let statusTimerLast = 0;

    function startStatusTimers() {
        if (statusTimerRAF) return;
        statusTimerLast = performance.now();

        function tick(now) {
            const dt = (now - statusTimerLast) / 1000;
            statusTimerLast = now;
            let anyActive = false;

            for (const targetId of Object.keys(state.statuses)) {
                const s = state.statuses[targetId];
                if (s.until && s.until > 0) {
                    s.until = Math.max(0, s.until - dt);
                    anyActive = true;
                    // Update just the timer text in the DOM for efficiency
                    const timerEl = document.getElementById(`wb-timer-${targetId}`);
                    if (timerEl) {
                        timerEl.textContent = formatTimer(s.until);
                    }
                }
            }

            statusTimerRAF = requestAnimationFrame(tick);
        }

        statusTimerRAF = requestAnimationFrame(tick);
    }

    // =========================================================================
    // SECTION 12: DOM MANIPULATION — WAR PAGE ENHANCEMENT
    // =========================================================================

    // Track which rows we've already enhanced to avoid double-injection.
    const enhancedRows = new WeakSet();

    /**
     * Multiple possible selectors for member rows across different Torn pages.
     * Torn frequently changes its HTML, so we try several patterns.
     */
    const MEMBER_LIST_SELECTORS = [
        '.members-list .table-body > li',
        '.faction-war .members-list li',
        '.ranked-war-list li',
        '.enemy-faction .member-list li',
        '.f-war-list .table-body > li',
        '.war-list li.table-row',
        '.faction-war-list .table-body li',
        '#faction-war-list li',
        '.war-main .members-cont li',
    ];

    const MEMBER_CONTAINER_SELECTORS = [
        '.members-list',
        '.faction-war',
        '.ranked-war-list',
        '.enemy-faction .member-list',
        '.f-war-list',
        '.war-list',
        '.faction-war-list',
        '#faction-war-list',
        '.war-main .members-cont',
        '#war-root',
        '#factions-page-wrap',
        '#mainContainer',
    ];

    /** Try to find member rows using multiple selectors. */
    function findMemberRows() {
        for (const sel of MEMBER_LIST_SELECTORS) {
            const rows = document.querySelectorAll(sel);
            if (rows.length > 0) {
                log(`Found ${rows.length} member rows with selector: ${sel}`);
                return rows;
            }
        }
        return [];
    }

    /** Find the container element to observe for mutations. */
    function findMemberContainer() {
        for (const sel of MEMBER_CONTAINER_SELECTORS) {
            const el = document.querySelector(sel);
            if (el) return el;
        }
        return document.getElementById('mainContainer') || document.body;
    }

    /**
     * Try to extract a player ID from a member row element.
     * We look for links, data attributes, and other common patterns.
     */
    function getPlayerIdFromRow(row) {
        // Check data attributes
        if (row.dataset.id) return row.dataset.id;
        if (row.dataset.user) return row.dataset.user;

        // Check href links within the row
        const links = row.querySelectorAll('a[href]');
        for (const link of links) {
            const id = extractPlayerId(link.href);
            if (id) return id;
        }

        // Check for attack link specifically
        const attackLink = row.querySelector('a[href*="loader.php?sid=attack"]');
        if (attackLink) return extractPlayerId(attackLink.href);

        // Check for profile link
        const profileLink = row.querySelector('a[href*="profiles.php"]');
        if (profileLink) return extractPlayerId(profileLink.href);

        return null;
    }

    /** Get the player name from a row. */
    function getPlayerNameFromRow(row) {
        // Try common selectors for player names
        const nameSelectors = [
            '.user.name',
            '.member-name',
            '.honorWrap a',
            'a[href*="profiles.php"]',
            '.name-wrap a',
            '.userName',
        ];

        for (const sel of nameSelectors) {
            const el = row.querySelector(sel);
            if (el && el.textContent.trim()) {
                return el.textContent.trim();
            }
        }
        return 'Unknown';
    }

    /**
     * Enhance a single member row with FactionOps columns.
     * Injects Call, Status, and Rally cells into the row.
     */
    function enhanceRow(row) {
        if (enhancedRows.has(row)) return;

        const targetId = getPlayerIdFromRow(row);
        if (!targetId) {
            // Might be a header row or empty — skip silently
            return;
        }

        enhancedRows.add(row);
        row.classList.add('wb-sortable-row');
        row.dataset.wbTargetId = targetId;

        // Create a container for our injected cells
        const wbContainer = document.createElement('div');
        wbContainer.className = 'wb-cell-container';
        wbContainer.id = `wb-cells-${targetId}`;
        wbContainer.style.cssText = 'display:inline-flex;gap:6px;align-items:center;margin-left:8px;flex-shrink:0;';

        // --- Call cell ---
        const callCell = document.createElement('span');
        callCell.className = 'wb-cell';
        callCell.id = `wb-call-${targetId}`;
        renderCallCell(callCell, targetId);

        // --- Status cell ---
        const statusCell = document.createElement('span');
        statusCell.className = 'wb-cell';
        statusCell.id = `wb-status-${targetId}`;
        renderStatusCell(statusCell, targetId);

        // --- Rally cell ---
        const rallyCell = document.createElement('span');
        rallyCell.className = 'wb-cell';
        rallyCell.id = `wb-rally-${targetId}`;
        renderRallyCell(rallyCell, targetId);

        wbContainer.appendChild(statusCell);
        wbContainer.appendChild(callCell);
        wbContainer.appendChild(rallyCell);

        // Insert into the row — try to append to the last visible cell or to
        // the row itself. Torn rows sometimes use flex, sometimes table cells.
        const lastCell = row.querySelector('li:last-child, td:last-child, .last-cell, .status');
        if (lastCell && lastCell !== row) {
            lastCell.style.display = 'inline-flex';
            lastCell.style.alignItems = 'center';
            lastCell.style.gap = '4px';
            lastCell.appendChild(wbContainer);
        } else {
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.appendChild(wbContainer);
        }

        // Apply initial row highlights
        applyRowHighlights(row, targetId);
    }

    // ---- Cell renderers ----

    function renderCallCell(container, targetId) {
        container.innerHTML = '';
        const callData = state.calls[targetId];

        if (!callData) {
            // Not called — show Call button
            const btn = document.createElement('button');
            btn.className = 'wb-call-btn';
            btn.textContent = 'Call';
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                emitCallTarget(targetId);
            });
            container.appendChild(btn);
        } else if (callData.calledBy && String(callData.calledBy.id) === state.myPlayerId) {
            // Called by us
            const btn = document.createElement('span');
            btn.className = 'wb-call-btn wb-called-self';
            btn.textContent = 'CALLED';
            container.appendChild(btn);

            const uncallBtn = document.createElement('button');
            uncallBtn.className = 'wb-uncall-btn';
            uncallBtn.textContent = '\u2715';
            uncallBtn.title = 'Uncall';
            uncallBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                emitUncallTarget(targetId);
            });
            container.appendChild(uncallBtn);
        } else {
            // Called by someone else
            const badge = document.createElement('span');
            badge.className = 'wb-call-btn wb-called-other';
            badge.textContent = callData.calledBy ? callData.calledBy.name : 'Called';
            badge.title = `Called by ${callData.calledBy ? callData.calledBy.name : 'unknown'}`;
            container.appendChild(badge);
        }
    }

    function renderStatusCell(container, targetId) {
        container.innerHTML = '';
        const statusData = state.statuses[targetId];

        if (!statusData) {
            // No status data yet — show placeholder
            const badge = document.createElement('span');
            badge.className = 'wb-status-badge wb-status-ok';
            badge.innerHTML = '<span class="wb-activity-dot wb-activity-offline"></span> --';
            container.appendChild(badge);
            return;
        }

        const badge = document.createElement('span');
        let activityClass = 'wb-activity-offline';
        if (statusData.activity === 'online') activityClass = 'wb-activity-online';
        else if (statusData.activity === 'idle') activityClass = 'wb-activity-idle';

        const dot = `<span class="wb-activity-dot ${activityClass}"></span>`;
        const timerSpan = statusData.until && statusData.until > 0
            ? `<span id="wb-timer-${targetId}">${formatTimer(statusData.until)}</span>`
            : '';

        switch (statusData.status) {
            case 'okay':
            case 'ok':
                badge.className = 'wb-status-badge wb-status-ok';
                badge.innerHTML = `${dot} OK`;
                break;
            case 'hospital':
                badge.className = 'wb-status-badge wb-status-hospital';
                badge.innerHTML = `${dot} Hosp: ${timerSpan}`;
                break;
            case 'traveling':
            case 'travel':
                badge.className = 'wb-status-badge wb-status-travel';
                badge.innerHTML = `${dot} Travel: ${statusData.description || ''} ${timerSpan}`;
                break;
            case 'jail':
                badge.className = 'wb-status-badge wb-status-jail';
                badge.innerHTML = `${dot} Jail: ${timerSpan}`;
                break;
            default:
                badge.className = 'wb-status-badge wb-status-ok';
                badge.innerHTML = `${dot} ${statusData.status || '??'}`;
        }

        container.appendChild(badge);
    }

    function renderRallyCell(container, targetId) {
        container.innerHTML = '';
        const rallyData = state.rallies[targetId];

        if (!rallyData) {
            // No rally — show Rally button
            const btn = document.createElement('button');
            btn.className = 'wb-rally-btn';
            btn.textContent = 'Rally';
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                emitStartRally(targetId);
            });
            container.appendChild(btn);
        } else {
            const count = rallyData.participants ? rallyData.participants.length : 0;
            const amInRally = rallyData.participants &&
                rallyData.participants.some((p) => String(p.id) === state.myPlayerId);

            const btn = document.createElement('button');
            btn.className = 'wb-rally-btn' + (amInRally ? ' wb-rally-active' : '');
            btn.innerHTML = `Rally (${count}) \uD83C\uDFAF`;
            btn.title = amInRally ? 'Click to leave rally' : 'Click to join rally';
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                if (amInRally) {
                    emitLeaveRally(targetId);
                } else {
                    emitJoinRally(targetId);
                }
            });
            container.appendChild(btn);
        }
    }

    /** Apply/remove row highlight classes based on call/rally state. */
    function applyRowHighlights(row, targetId) {
        const isCalled = !!state.calls[targetId];
        const hasRally = !!state.rallies[targetId];

        row.classList.toggle('wb-row-called', isCalled);
        row.classList.toggle('wb-row-rally', hasRally);
    }

    /** Re-render all FactionOps cells for a specific target. */
    function updateTargetRow(targetId) {
        const callEl = document.getElementById(`wb-call-${targetId}`);
        if (callEl) renderCallCell(callEl, targetId);

        const statusEl = document.getElementById(`wb-status-${targetId}`);
        if (statusEl) renderStatusCell(statusEl, targetId);

        const rallyEl = document.getElementById(`wb-rally-${targetId}`);
        if (rallyEl) renderRallyCell(rallyEl, targetId);

        // Update row highlight
        const row = document.querySelector(`[data-wb-target-id="${targetId}"]`);
        if (row) applyRowHighlights(row, targetId);
    }

    /** Re-render all enhanced rows (after bulk state update). */
    function refreshAllRows() {
        const rows = document.querySelectorAll('[data-wb-target-id]');
        rows.forEach((row) => {
            const targetId = row.dataset.wbTargetId;
            updateTargetRow(targetId);
        });
        if (CONFIG.AUTO_SORT) debouncedSort();
    }

    /**
     * Scan the page for member rows and enhance any new ones.
     * Called on initial load and whenever the DOM mutates.
     */
    function scanAndEnhanceRows() {
        const rows = findMemberRows();
        let count = 0;
        rows.forEach((row) => {
            if (!enhancedRows.has(row)) {
                enhanceRow(row);
                count++;
            }
        });
        if (count > 0) {
            log(`Enhanced ${count} new member rows`);
            if (CONFIG.AUTO_SORT) debouncedSort();
        }
    }

    // =========================================================================
    // SECTION 13: AUTO-SORT
    // =========================================================================

    /**
     * Sort priority for a target. Lower number = higher in the list.
     *   1: OK + uncalled
     *   2: OK + called
     *   3: Traveling
     *   4: Jail
     *   5: Hospital (ordered by longest timer at bottom)
     */
    function sortPriority(targetId) {
        const s = state.statuses[targetId];
        const status = s ? (s.status || 'ok') : 'ok';
        const isCalled = !!state.calls[targetId];

        switch (status) {
            case 'okay':
            case 'ok':
                return isCalled ? 2 : 1;
            case 'traveling':
            case 'travel':
                return 3;
            case 'jail':
                return 4;
            case 'hospital':
                return 5;
            default:
                return 6;
        }
    }

    /** Secondary sort: remaining timer (ascending). */
    function sortTimerValue(targetId) {
        const s = state.statuses[targetId];
        return s && s.until ? s.until : 0;
    }

    /**
     * Re-order the DOM rows based on sort priorities.
     * Uses CSS transitions for smooth re-ordering by manipulating `order`
     * on a flex container, or by physically moving DOM nodes.
     */
    function sortMemberList() {
        const rows = Array.from(document.querySelectorAll('[data-wb-target-id]'));
        if (rows.length === 0) return;

        // Determine the parent container
        const parent = rows[0].parentElement;
        if (!parent) return;

        // Build sort array
        const sorted = rows.map((row) => ({
            row,
            targetId: row.dataset.wbTargetId,
            priority: sortPriority(row.dataset.wbTargetId),
            timer: sortTimerValue(row.dataset.wbTargetId),
        }));

        sorted.sort((a, b) => {
            if (a.priority !== b.priority) return a.priority - b.priority;
            // Within same priority, sort by timer ascending (shortest first,
            // except hospital where longest goes to bottom)
            if (a.priority === 5) return b.timer - a.timer; // hospital: longest last
            return a.timer - b.timer;
        });

        // Use CSS order property if parent is flex/grid, otherwise re-append nodes
        const computedDisplay = window.getComputedStyle(parent).display;
        const isFlex = computedDisplay === 'flex' || computedDisplay === 'inline-flex'
            || computedDisplay === 'grid' || computedDisplay === 'inline-grid';

        if (isFlex) {
            sorted.forEach((item, index) => {
                item.row.style.order = String(index);
            });
        } else {
            // Physically re-order DOM nodes. We create a fragment and re-append.
            // This triggers the CSS transition on .wb-sortable-row.
            const fragment = document.createDocumentFragment();
            sorted.forEach((item) => fragment.appendChild(item.row));
            parent.appendChild(fragment);
        }
    }

    const debouncedSort = debounce(sortMemberList, 300);

    // =========================================================================
    // SECTION 14: ATTACK PAGE ENHANCEMENT
    // =========================================================================

    /**
     * When on the attack page (loader.php?sid=attack), show a small overlay
     * with call/rally info for the current target.
     */
    function createAttackOverlay() {
        const targetId = getAttackTargetId();
        if (!targetId) return;

        log('Attack page detected — target:', targetId);

        const overlay = document.createElement('div');
        overlay.className = 'wb-attack-overlay';
        overlay.id = 'wb-attack-overlay';

        overlay.innerHTML = `
            <h4>FactionOps</h4>
            <div class="wb-attack-row">
                <span>Target:</span>
                <span id="wb-atk-target">#${escapeHtml(targetId)}</span>
            </div>
            <div class="wb-attack-row">
                <span>Call:</span>
                <span id="wb-atk-call">--</span>
            </div>
            <div class="wb-attack-row">
                <span>Rally:</span>
                <span id="wb-atk-rally">None</span>
            </div>
            <div style="margin-top:8px;">
                <button class="wb-btn wb-btn-sm" id="wb-atk-uncall">Quick Uncall</button>
            </div>
        `;

        document.body.appendChild(overlay);

        document.getElementById('wb-atk-uncall').addEventListener('click', () => {
            emitUncallTarget(targetId);
        });

        updateAttackOverlay(targetId);
    }

    /** Update attack overlay with current state for the given target. */
    function updateAttackOverlay(targetId) {
        const callEl = document.getElementById('wb-atk-call');
        const rallyEl = document.getElementById('wb-atk-rally');
        if (!callEl || !rallyEl) return;

        const callData = state.calls[targetId];
        if (callData && callData.calledBy) {
            callEl.textContent = `Called by ${callData.calledBy.name}`;
            callEl.style.color = 'var(--wb-call-green)';
        } else {
            callEl.textContent = 'Uncalled';
            callEl.style.color = 'var(--wb-text)';
        }

        const rallyData = state.rallies[targetId];
        if (rallyData && rallyData.participants) {
            rallyEl.textContent = `${rallyData.participants.length} members`;
            rallyEl.style.color = 'var(--wb-rally-orange)';
        } else {
            rallyEl.textContent = 'None';
            rallyEl.style.color = 'var(--wb-text)';
        }
    }

    // =========================================================================
    // SECTION 15: FETCH / XHR INTERCEPTION
    // =========================================================================

    /**
     * Intercept window.fetch to passively capture Torn's own API responses.
     * This lets us extract status data, attack results, and chain info without
     * making our own API calls (saving rate-limit budget).
     */
    function installFetchInterceptor() {
        const originalFetch = window.fetch;
        window.fetch = async function (...args) {
            const response = await originalFetch.apply(this, args);
            try {
                const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
                if (typeof url === 'string' && url.includes('api.torn.com')) {
                    const clone = response.clone();
                    clone.json().then((data) => {
                        handleInterceptedData(url, data);
                    }).catch(() => { /* ignore parse failures */ });
                }
            } catch (e) {
                // Interception must never break the page
            }
            return response;
        };
        log('Fetch interceptor installed');
    }

    /**
     * Intercept XMLHttpRequest for older Torn code paths that still use XHR.
     */
    function installXHRInterceptor() {
        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            this._wbUrl = url;
            return originalOpen.call(this, method, url, ...rest);
        };

        XMLHttpRequest.prototype.send = function (...args) {
            if (this._wbUrl && typeof this._wbUrl === 'string' && this._wbUrl.includes('api.torn.com')) {
                this.addEventListener('load', function () {
                    try {
                        const data = JSON.parse(this.responseText);
                        handleInterceptedData(this._wbUrl, data);
                    } catch (e) {
                        // Ignore
                    }
                });
            }
            return originalSend.apply(this, args);
        };
        log('XHR interceptor installed');
    }

    /**
     * Process intercepted Torn API data.
     * We look for faction member data, chain status, and attack results.
     */
    function handleInterceptedData(url, data) {
        if (!data || data.error) return;

        // Faction member data (may contain member statuses)
        if (data.members) {
            for (const [memberId, member] of Object.entries(data.members)) {
                const statusInfo = parseInterceptedMemberStatus(member);
                if (statusInfo && state.socket && state.connected) {
                    state.socket.emit('report_status', {
                        targetId: String(memberId),
                        ...statusInfo,
                    });
                }
                // Also update local state immediately
                state.statuses[String(memberId)] = statusInfo;
                updateTargetRow(String(memberId));
            }
        }

        // Chain data
        if (data.chain) {
            const chain = data.chain;
            state.chain.current = chain.current || 0;
            state.chain.max = chain.max || 0;
            state.chain.timeout = chain.timeout || 0;
            state.chain.cooldown = chain.cooldown || 0;
            updateChainBar();

            // Forward to server
            if (state.socket && state.connected) {
                state.socket.emit('report_chain', state.chain);
            }
        }

        // Attack result
        if (data.result) {
            log('Attack result intercepted:', data.result);
            if (data.result.hospitalized || data.result.mugged || data.result.attacked) {
                // Target was hospitalized — could auto-uncall
                const targetId = getAttackTargetId();
                if (targetId) {
                    log('Target hospitalized — consider uncalling');
                }
            }
        }
    }

    /**
     * Parse a Torn member object into our status format.
     */
    function parseInterceptedMemberStatus(member) {
        if (!member) return null;

        let status = 'ok';
        let until = 0;
        let description = '';
        let activity = 'offline';

        // Status
        if (member.status) {
            const s = member.status;
            const state_str = (s.state || '').toLowerCase();
            if (state_str === 'hospital') {
                status = 'hospital';
                until = s.until ? Math.max(0, s.until - Math.floor(Date.now() / 1000)) : 0;
            } else if (state_str === 'jail') {
                status = 'jail';
                until = s.until ? Math.max(0, s.until - Math.floor(Date.now() / 1000)) : 0;
            } else if (state_str === 'traveling' || state_str === 'abroad') {
                status = 'traveling';
                description = s.description || '';
                until = s.until ? Math.max(0, s.until - Math.floor(Date.now() / 1000)) : 0;
            } else {
                status = 'ok';
            }
        }

        // Activity (online/idle/offline)
        if (member.last_action) {
            const la = member.last_action;
            if (la.status) {
                activity = la.status.toLowerCase();
            }
        }

        return { status, until, description, activity };
    }

    // =========================================================================
    // SECTION 16: MUTATION OBSERVER
    // =========================================================================

    let observer = null;

    /**
     * Set up MutationObserver to watch for Torn dynamically loading faction
     * member lists. Torn uses AJAX to load content, so we can't just run once
     * on page load — we need to continuously watch.
     */
    function setupMutationObserver() {
        if (observer) {
            observer.disconnect();
        }

        const container = findMemberContainer();
        log('Setting up MutationObserver on:', container.tagName, container.id || container.className);

        const debouncedScan = debounce(scanAndEnhanceRows, 200);

        observer = new MutationObserver((mutations) => {
            let shouldScan = false;
            for (const mutation of mutations) {
                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                    shouldScan = true;
                    break;
                }
            }
            if (shouldScan) {
                debouncedScan();
            }
        });

        observer.observe(container, {
            childList: true,
            subtree: true,
        });

        // Initial scan
        scanAndEnhanceRows();
    }

    // =========================================================================
    // SECTION 17: PERIODIC REFRESH
    // =========================================================================

    /**
     * Periodically request fresh status data from the server.
     * Acts as a fallback to keep data fresh if WebSocket events are missed.
     */
    function startPeriodicRefresh() {
        setInterval(() => {
            if (state.socket && state.connected) {
                state.socket.emit('request_bulk_state');
                log('Requested bulk state refresh');
            }
        }, CONFIG.REFRESH_INTERVAL);
    }

    /**
     * Periodically prune expired calls (calls older than CALL_TIMEOUT).
     */
    function startCallPruner() {
        setInterval(() => {
            const now = Date.now();
            let pruned = 0;
            for (const [targetId, callData] of Object.entries(state.calls)) {
                if (callData.calledAt && (now - callData.calledAt) > CONFIG.CALL_TIMEOUT) {
                    delete state.calls[targetId];
                    updateTargetRow(targetId);
                    pruned++;
                }
            }
            if (pruned > 0) {
                log(`Pruned ${pruned} expired calls`);
            }
        }, 30000); // check every 30s
    }

    // =========================================================================
    // SECTION 18: PAGE DETECTION & ROUTER
    // =========================================================================

    /**
     * Determine which Torn page we're on and initialise the appropriate
     * enhancements.
     */
    function detectPageAndInit() {
        const url = window.location.href;

        if (url.includes('loader.php?sid=attack')) {
            log('Page: Attack');
            initAttackPage();
        } else if (url.includes('factions.php') || url.includes('war.php')) {
            log('Page: Faction / War');
            initWarPage();
        } else {
            log('Page: Unknown — running in passive mode');
        }
    }

    /** Initialise war/faction page enhancements. */
    function initWarPage() {
        createChainBar();
        startChainTimer();
        setupMutationObserver();
        startStatusTimers();
        startPeriodicRefresh();
        startCallPruner();
    }

    /** Initialise attack page enhancements. */
    function initAttackPage() {
        createAttackOverlay();
        startStatusTimers();

        // Listen for target-specific updates to refresh the overlay
        const targetId = getAttackTargetId();
        if (targetId) {
            // Poll local state for overlay updates
            setInterval(() => updateAttackOverlay(targetId), 2000);
        }
    }

    // =========================================================================
    // SECTION 19: CALL EXPIRY VISUAL FEEDBACK
    // =========================================================================

    /**
     * Provides visual feedback showing how close a call is to expiring.
     * Fades the call badge as it ages.
     */
    function updateCallAges() {
        const now = Date.now();
        for (const [targetId, callData] of Object.entries(state.calls)) {
            if (!callData.calledAt) continue;
            const age = now - callData.calledAt;
            const ratio = Math.min(age / CONFIG.CALL_TIMEOUT, 1);

            const el = document.getElementById(`wb-call-${targetId}`);
            if (el) {
                // Fade opacity as call ages
                const opacity = 1 - (ratio * 0.5); // fade from 1.0 to 0.5
                el.style.opacity = String(opacity);
            }
        }
        requestAnimationFrame(updateCallAges);
    }

    // =========================================================================
    // SECTION 20: TAB COORDINATION
    // =========================================================================

    /**
     * Use BroadcastChannel to coordinate between multiple Torn tabs running
     * FactionOps. This prevents duplicate socket connections and keeps state in
     * sync across tabs.
     */
    let broadcastChannel = null;

    function setupTabCoordination() {
        try {
            broadcastChannel = new BroadcastChannel('factionops_sync');
            broadcastChannel.onmessage = (event) => {
                const msg = event.data;
                if (!msg || !msg.type) return;

                switch (msg.type) {
                    case 'state_update':
                        // Another tab pushed a state change
                        if (msg.calls) state.calls = { ...state.calls, ...msg.calls };
                        if (msg.rallies) state.rallies = { ...state.rallies, ...msg.rallies };
                        if (msg.statuses) state.statuses = { ...state.statuses, ...msg.statuses };
                        if (msg.chain) state.chain = { ...state.chain, ...msg.chain };
                        refreshAllRows();
                        updateChainBar();
                        break;
                    case 'call_update':
                        if (msg.targetId) updateTargetRow(msg.targetId);
                        break;
                }
            };
            log('Tab coordination via BroadcastChannel active');
        } catch (e) {
            warn('BroadcastChannel not available — tab sync disabled');
        }
    }

    /** Broadcast a state change to other tabs. */
    function broadcastStateChange(data) {
        if (broadcastChannel) {
            try {
                broadcastChannel.postMessage(data);
            } catch (e) {
                // Ignore — might fail if channel is closed
            }
        }
    }

    // =========================================================================
    // SECTION 21: KEYBOARD SHORTCUTS
    // =========================================================================

    function setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Alt+W: toggle settings
            if (e.altKey && e.key === 'w') {
                e.preventDefault();
                toggleSettings();
            }
            // Alt+S: toggle auto-sort
            if (e.altKey && e.key === 's') {
                e.preventDefault();
                setConfig('AUTO_SORT', !CONFIG.AUTO_SORT);
                if (CONFIG.AUTO_SORT) debouncedSort();
                log('Auto-sort:', CONFIG.AUTO_SORT ? 'ON' : 'OFF');
            }
            // Escape: close settings
            if (e.key === 'Escape' && state.ui.settingsOpen) {
                closeSettings();
            }
        });
    }

    // =========================================================================
    // SECTION 22: NOTIFICATION HELPERS
    // =========================================================================

    /**
     * Show a brief toast notification at the top of the page.
     * Used for events like "Rally started on [target]".
     */
    function showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.style.cssText = `
            position: fixed;
            top: ${state.ui.chainBar ? '52px' : '10px'};
            left: 50%;
            transform: translateX(-50%);
            z-index: 1000001;
            padding: 8px 18px;
            border-radius: 6px;
            font-family: Arial, sans-serif;
            font-size: 13px;
            color: #fff;
            opacity: 0;
            transition: opacity 0.3s;
            pointer-events: none;
        `;

        switch (type) {
            case 'success':
                toast.style.background = 'var(--wb-call-green)';
                break;
            case 'warning':
                toast.style.background = 'var(--wb-rally-orange)';
                toast.style.color = '#000';
                break;
            case 'error':
                toast.style.background = 'var(--wb-call-red)';
                break;
            default:
                toast.style.background = 'var(--wb-accent)';
        }

        toast.textContent = message;
        document.body.appendChild(toast);

        // Animate in
        requestAnimationFrame(() => {
            toast.style.opacity = '1';
        });

        // Remove after 3 seconds
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // =========================================================================
    // SECTION 23: SOCKET EVENT NOTIFICATION WIRING
    // =========================================================================

    /**
     * Wire up socket events to toast notifications so the user knows about
     * important coordination events.
     */
    function wireSocketNotifications() {
        if (!state.socket) return;

        state.socket.on('target_called', (data) => {
            if (String(data.calledBy.id) !== state.myPlayerId) {
                showToast(`${data.calledBy.name} called target #${data.targetId}`, 'info');
            }
            broadcastStateChange({ type: 'call_update', targetId: data.targetId });
        });

        state.socket.on('rally_started', (data) => {
            showToast(`Rally started on #${data.targetId}!`, 'warning');
            broadcastStateChange({ type: 'state_update', rallies: state.rallies });
        });

        state.socket.on('rally_updated', (data) => {
            const count = data.participants ? data.participants.length : 0;
            showToast(`Rally #${data.targetId}: ${count} members`, 'warning');
        });

        state.socket.on('chain_update', (data) => {
            const next = nextBonusMilestone(data.current + 1);
            const hitsToBonus = next ? next - data.current : null;
            if (hitsToBonus !== null && hitsToBonus <= 3 && hitsToBonus > 0) {
                showToast(`BONUS HIT in ${hitsToBonus}! Target: ${next}`, 'error');
            }
        });
    }

    // =========================================================================
    // SECTION 24: MAIN INITIALISATION
    // =========================================================================

    async function main() {
        log('Initialising FactionOps v1.1.0');
        if (IS_PDA) log('Torn PDA detected — using PDA-managed API key');

        // 1. Inject CSS
        injectStyles();

        // 2. Apply theme
        applyTheme();

        // 3. Create settings gear (always available, even before connection)
        createSettingsGear();

        // 4. Set up keyboard shortcuts
        setupKeyboardShortcuts();

        // 5. Set up tab coordination
        setupTabCoordination();

        // 6. Install fetch/XHR interceptors for passive data collection
        installFetchInterceptor();
        installXHRInterceptor();

        // 7. Load Socket.IO
        try {
            await loadSocketIO();
        } catch (e) {
            error('Failed to load Socket.IO:', e.message);
            showToast('Failed to load Socket.IO — real-time features disabled', 'error');
            // Continue without socket — settings panel and interceptors still work
            detectPageAndInit();
            return;
        }

        // 8. Authenticate and connect
        if (CONFIG.API_KEY) {
            try {
                await authenticate();
                connectSocket();

                // Wait briefly for connection, then wire notifications
                setTimeout(() => {
                    wireSocketNotifications();
                }, 1000);
            } catch (e) {
                warn('Initial auth failed:', e.message);
                // Try connecting with cached JWT
                if (state.jwtToken) {
                    connectSocket();
                    setTimeout(() => wireSocketNotifications(), 1000);
                } else {
                    showToast('Not configured — click the gear icon to set up', 'warning');
                }
            }
        } else {
            log('No API key configured — open settings to get started');
            showToast('FactionOps: Click the gear icon to configure', 'info');
        }

        // 9. Detect page type and initialise appropriate enhancements
        detectPageAndInit();

        // 10. Start call age visual feedback loop
        requestAnimationFrame(updateCallAges);

        log('FactionOps initialised');
    }

    // =========================================================================
    // SECTION 25: HANDLE TORN NAVIGATION
    // =========================================================================

    /**
     * Torn uses hash-based navigation and AJAX page loads. We need to detect
     * when the user navigates to a different section and re-initialise.
     */
    let lastUrl = window.location.href;

    function watchNavigation() {
        // Check for URL changes periodically (hashchange + popstate don't
        // catch all of Torn's navigation patterns)
        setInterval(() => {
            if (window.location.href !== lastUrl) {
                log('Navigation detected:', lastUrl, '->', window.location.href);
                lastUrl = window.location.href;
                onNavigate();
            }
        }, 1000);

        window.addEventListener('hashchange', () => {
            log('Hash change detected');
            onNavigate();
        });

        window.addEventListener('popstate', () => {
            log('Popstate detected');
            onNavigate();
        });
    }

    function onNavigate() {
        // Disconnect old observer
        if (observer) {
            observer.disconnect();
            observer = null;
        }

        // Remove old UI elements that are page-specific
        const chainBar = document.getElementById('wb-chain-bar');
        if (chainBar) chainBar.remove();
        state.ui.chainBar = null;
        document.body.classList.remove('wb-chain-active');

        const attackOverlay = document.getElementById('wb-attack-overlay');
        if (attackOverlay) attackOverlay.remove();

        // Cancel status timer RAF
        if (statusTimerRAF) {
            cancelAnimationFrame(statusTimerRAF);
            statusTimerRAF = null;
        }
        if (chainTimerRAF) {
            cancelAnimationFrame(chainTimerRAF);
            chainTimerRAF = null;
        }

        // Re-detect page and init
        setTimeout(() => detectPageAndInit(), 500);
    }

    // =========================================================================
    // SECTION 26: STARTUP
    // =========================================================================

    // Wait for DOM to be ready (we're @run-at document-idle, but double-check)
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            main();
            watchNavigation();
        });
    } else {
        main();
        watchNavigation();
    }

})();
