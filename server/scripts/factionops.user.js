// ==UserScript==
// @name         FactionOps - Faction War Coordinator
// @namespace    https://tornwar.com
// @version      3.6.3
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
// @connect      tornwar.com
// @connect      localhost
// @connect      *
// @run-at       document-idle
// ==/UserScript==

// =============================================================================
// CHANGELOG
// =============================================================================
// v3.6.3  - Fix: chain timer no longer pauses when leaving/re-entering FactionOps overlay
// v3.6.2  - Chain timer syncs instantly from Torn's DOM (no more delay from server polling)
// v3.6.1  - Chain poll interval 10s (was 30s), drift threshold 5s for tighter sync
// v3.6.0  - Fix: chain timer smooth countdown (no more jitter from server polls) — smooth client countdown, no server reset loop
// v3.5.8  - Chain updates instantly via intercepted Torn data (no more 30s delay)
// v3.5.7  - Fix: replace DELETE HTTP methods with POST for PDA compatibility
//           (fixes "network error" when removing faction API key)
// v3.5.6  - Revert mini profile popup (not compatible with PDA)
// v3.5.5  - Custom mini profile popup via Torn internal API
// v3.5.4  - Fix: persist player API keys to disk across server restarts
//           - Mini profile popup improvements
// v3.5.3  - Fix: mini profile popup on target name links
// v3.5.2  - Version bump for update detection
// v3.5.1  - Fix: row flicker on DOM reorder (use insertBefore in-place)
// v3.5.0  - Overlay hides entire Torn page content, takes over full page
//           - Version shown in download button text
//           - Weekly Tuesday membership check (purge non-faction members)
//           - Server auth locked to faction 42055
// v3.0.58 - Fix: high priority only floats to top when target is OK status
// v3.0.57 - High priority targets sort above all others
// v3.0.56 - Grant War Leader access to priority tagging + heatmap reset
// v3.0.55 - Remove BSP sort option and dead code
// v3.0.54 - UI: move activate button below Torn nav bar, rounded corners
// v3.0.50 - Fix: hide floating heatmap FAB on faction/war pages
// v3.0.49 - Chain count + timer in overlay header
// v3.0.48 - Move heatmap button into overlay header next to settings gear
// v3.0.46 - Theme toggle applies to entire UI (CSS variables refactor)
// v3.0.44 - Fix: activate button on all faction pages, not just war context
// v3.0.38 - Compliance refactor: server-side war polling, faction API key
//           setup, remove interceptor forwarding
// v3.0.37 - Show BSP stats inline next to player name/ID
// v3.0.35 - Next Up queue inside overlay header
//           - Activate FactionOps button on war page (no auto-start)
// v3.0.34 - Settings gear button in overlay header
// v3.0.33 - Toast on call conflict
// v3.0.32 - Optimistic call/uncall with rollback on failure
// v3.0.31 - Show "Mine" on your calls, caller name for others
// v3.0.29 - Clickable target names (links to Torn profile)
// v3.0.25 - Hide BSP column on mobile
// v3.0.21 - Mobile responsive grid improvements (v3.0.1 - v3.0.21)
// v3.0.0  - Full dark overlay replaces Torn war page
// v2.0.5  - Add Attack button to war page rows
// v2.0.3  - PDA compatibility: PDA_httpGet/PDA_httpPost bridge
// v2.0.0  - Replace Socket.IO with HTTP polling
// v1.2.0  - Bundle Socket.IO client inline (zero external deps for PDA)
// v1.1.0  - Torn PDA auto-detection and API key support
// v1.0.1  - Auto-update URLs, HTTPS release
// v1.0.0  - Initial release
// =============================================================================

(function () {
    'use strict';

    // =========================================================================
    // SECTION 1: CONFIGURATION
    // =========================================================================

    // --- Torn PDA Detection ---
    const IS_PDA = typeof window.flutter_inappwebview !== 'undefined';
    const PDA_API_KEY = '###PDA-APIKEY###';

    const CONFIG = {
        VERSION: '3.6.3',
        SERVER_URL: GM_getValue('factionops_server', 'https://tornwar.com'),
        API_KEY: GM_getValue('factionops_apikey', '') || (IS_PDA ? PDA_API_KEY : ''),
        THEME: GM_getValue('factionops_theme', 'dark'),
        AUTO_SORT: GM_getValue('factionops_autosort', true),
        CHAIN_ALERT: GM_getValue('factionops_chain_alert', true),
        CHAIN_ALERT_THRESHOLD: GM_getValue('factionops_chain_alert_threshold', 30),
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
            CHAIN_ALERT: 'factionops_chain_alert',
            CHAIN_ALERT_THRESHOLD: 'factionops_chain_alert_threshold',
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
     * Uses PDA_httpGet/PDA_httpPost on Torn PDA, GM_xmlhttpRequest elsewhere.
     * PDA bridge functions support headers: PDA_httpGet(url, headers), PDA_httpPost(url, headers, body)
     */
    function httpRequest(opts) {
        if (IS_PDA) {
            const method = (opts.method || 'GET').toUpperCase();
            if (method === 'GET' && typeof PDA_httpGet === 'function') {
                PDA_httpGet(opts.url, opts.headers || {})
                    .then(r => {
                        const resp = typeof r === 'string'
                            ? { status: 200, responseText: r, statusText: 'OK' }
                            : r;
                        opts.onload && opts.onload(resp);
                    })
                    .catch(e => opts.onerror && opts.onerror(e));
            } else if (method === 'POST' && typeof PDA_httpPost === 'function') {
                PDA_httpPost(opts.url, opts.headers || {}, opts.data || '')
                    .then(r => {
                        const resp = typeof r === 'string'
                            ? { status: 200, responseText: r, statusText: 'OK' }
                            : r;
                        opts.onload && opts.onload(resp);
                    })
                    .catch(e => opts.onerror && opts.onerror(e));
            } else {
                // Fallback: try fetch on PDA if bridge functions unavailable
                fetch(opts.url, {
                    method,
                    headers: opts.headers || {},
                    body: method !== 'GET' ? opts.data : undefined,
                }).then(async (r) => {
                    const text = await r.text();
                    opts.onload && opts.onload({ status: r.status, responseText: text, statusText: r.statusText });
                }).catch(e => opts.onerror && opts.onerror(e));
            }
            return;
        }
        GM_xmlhttpRequest(opts);
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
    --wb-text-muted: #a0a0b8;
    --wb-accent: #0f3460;
    --wb-accent-15: rgba(15,52,96,0.15);
    --wb-accent-20: rgba(15,52,96,0.2);
    --wb-accent-30: rgba(15,52,96,0.3);
    --wb-call-green: #00b894;
    --wb-call-red: #e17055;
    --wb-hospital-red: #d63031;
    --wb-travel-blue: #0984e3;
    --wb-jail-gray: #636e72;
    --wb-online-green: #00b894;
    --wb-idle-yellow: #fdcb6e;
    --wb-offline-gray: #636e72;
    --wb-bonus-warning: #ff7675;
    --wb-border: #2d3436;
    --wb-shadow: rgba(0,0,0,0.5);
    --wb-inset-glow: rgba(255,255,255,0.04);
    --wb-inset-border: rgba(255,255,255,0.03);
}

html.wb-theme-light {
    --wb-bg: #f5f5f5;
    --wb-bg-secondary: #ffffff;
    --wb-text: #2d3436;
    --wb-text-muted: #636e72;
    --wb-accent: #d6eaf8;
    --wb-accent-15: rgba(52,152,219,0.08);
    --wb-accent-20: rgba(52,152,219,0.1);
    --wb-accent-30: rgba(52,152,219,0.15);
    --wb-border: #dfe6e9;
    --wb-shadow: rgba(0,0,0,0.12);
    --wb-inset-glow: rgba(0,0,0,0.02);
    --wb-inset-border: rgba(0,0,0,0.05);
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

/* ----- Next Up queue (in chain bar) ----- */
.wb-next-up {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--wb-text);
    opacity: 0.85;
}
.wb-next-up-label {
    font-weight: 600;
    color: var(--wb-idle-yellow);
    white-space: nowrap;
}
.wb-next-up-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: rgba(255,255,255,0.06);
    border-radius: 3px;
    padding: 2px 6px;
    white-space: nowrap;
}
.wb-next-up-item .wb-next-timer {
    font-family: monospace;
    color: var(--wb-hospital-red);
    font-weight: 600;
}
.wb-next-up-item.wb-next-imminent {
    background: rgba(214,48,49,0.2);
    animation: wb-pulse 1s ease-in-out infinite;
}
.wb-next-up-item.wb-next-imminent .wb-next-timer {
    color: var(--wb-bonus-warning);
}
.wb-next-up-call {
    font-size: 9px;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 3px;
    border: 1px solid var(--wb-call-green);
    background: transparent;
    color: var(--wb-call-green);
    cursor: pointer;
    line-height: 1.2;
    margin-left: 2px;
}
.wb-next-up-call:hover {
    background: var(--wb-call-green);
    color: #fff;
}

/* ----- FactionOps cell container — right-aligned in each row ----- */
.wb-cell-container {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    gap: 6px;
    align-items: center;
    z-index: 5;
    flex-shrink: 0;
}

/* Ensure rows have room for our right-aligned cells */
.wb-sortable-row {
    position: relative !important;
    padding-right: 300px !important;
    transition: transform 0.3s ease, opacity 0.3s ease;
}

/* ----- Call / Status elements in member rows ----- */
.wb-cell {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 0;
    font-family: Arial, sans-serif;
    font-size: 11px;
    vertical-align: middle;
}
/* Attack button */
.wb-attack-btn {
    padding: 2px 10px;
    border-radius: 12px;
    border: 1px solid var(--wb-call-red);
    font-size: 11px;
    cursor: pointer;
    transition: background 0.15s, color 0.15s, transform 0.1s;
    font-family: Arial, sans-serif;
    white-space: nowrap;
    background: rgba(225,112,85,0.15);
    color: var(--wb-call-red);
    text-decoration: none;
    display: inline-flex;
    align-items: center;
}
.wb-attack-btn:hover {
    background: var(--wb-call-red);
    color: #fff;
    transform: scale(1.05);
}

.wb-call-btn {
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

/* Priority tag badges */
.wb-priority-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 8px;
    border-radius: 10px;
    font-size: 9px;
    font-weight: bold;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    white-space: nowrap;
    font-family: Arial, sans-serif;
    cursor: default;
}
.wb-priority-high {
    background: rgba(214,48,49,0.2);
    color: var(--wb-hospital-red);
    border: 1px solid rgba(214,48,49,0.4);
}
.wb-priority-medium {
    background: rgba(253,203,110,0.15);
    color: var(--wb-idle-yellow);
    border: 1px solid rgba(253,203,110,0.3);
}
.wb-priority-low {
    background: rgba(9,132,227,0.15);
    color: var(--wb-travel-blue);
    border: 1px solid rgba(9,132,227,0.3);
}
/* Priority selector (leader only) */
.wb-priority-select {
    padding: 1px 4px;
    border-radius: 10px;
    border: 1px solid var(--wb-border);
    background: var(--wb-bg-secondary);
    color: var(--wb-text);
    font-size: 9px;
    font-family: Arial, sans-serif;
    cursor: pointer;
    outline: none;
    appearance: none;
    -webkit-appearance: none;
    text-align: center;
    min-width: 52px;
}
.wb-priority-select:focus {
    border-color: var(--wb-call-green);
}
.wb-priority-select option {
    background: var(--wb-bg);
    color: var(--wb-text);
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


/* (transition rule merged into .wb-sortable-row above) */



/* ----- Group attack / viewers indicator ----- */
.wb-viewers-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    background: rgba(108,92,231,0.2);
    border: 1px solid rgba(108,92,231,0.4);
    border-radius: 4px;
    padding: 1px 5px;
    font-size: 10px;
    font-weight: 600;
    color: #a29bfe;
    white-space: nowrap;
    animation: wb-pulse 1.5s ease-in-out infinite;
}
.wb-viewers-badge.wb-viewers-multi {
    background: rgba(214,48,49,0.2);
    border-color: rgba(214,48,49,0.5);
    color: #ff7675;
}

/* ----- BSP / FFS stat display ----- */
.wb-bsp-cell {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 0;
    min-width: 48px;
    font-family: monospace;
}
.wb-bsp-value {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    white-space: nowrap;
    line-height: 1.2;
}
.wb-bsp-value.wb-bsp-tier-s {
    color: var(--wb-call-red);
}
.wb-bsp-value.wb-bsp-tier-a {
    color: var(--wb-idle-yellow);
}
.wb-bsp-value.wb-bsp-tier-b {
    color: var(--wb-call-green);
}
.wb-bsp-value.wb-bsp-tier-c {
    color: var(--wb-text-muted);
}
.wb-bsp-value.wb-bsp-tier-unknown {
    color: var(--wb-jail-gray);
    font-weight: 400;
}
.wb-bsp-source {
    font-size: 7px;
    font-weight: 400;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    opacity: 0.45;
    line-height: 1;
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

/* ══════════════════════════════════════════════════════════════════════════
   FactionOps Full Overlay (fo- prefix)
   ══════════════════════════════════════════════════════════════════════════ */

/* ── War Board Container ── */
.fo-overlay {
    width: 100%;
    max-width: 1000px;
    background: var(--wb-bg);
    border: 1px solid var(--wb-border);
    border-radius: 10px;
    box-shadow:
        0 4px 24px rgba(0, 0, 0, 0.5),
        0 0 0 1px rgba(255, 255, 255, 0.03),
        inset 0 1px 0 rgba(255, 255, 255, 0.04);
    overflow: hidden;
    height: fit-content;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 13px;
    line-height: 1.5;
    color: var(--wb-text);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    margin: 10px auto;
    box-sizing: border-box;
}
.fo-overlay *, .fo-overlay *::before, .fo-overlay *::after { box-sizing: border-box; }

/* ── Header Bar ── */
.fo-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    background: var(--wb-bg-secondary);
    border-bottom: 1px solid var(--wb-border);
    gap: 12px;
}

.fo-header-left {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
}

.fo-logo-mark {
    display: flex;
    align-items: center;
    gap: 6px;
}

.fo-logo-icon { width: 20px; height: 20px; }

.fo-logo-text {
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--wb-text);
    white-space: nowrap;
}

.fo-status-dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    background: #00b894;
    box-shadow: 0 0 6px rgba(0,184,148,0.6);
    animation: fo-pulse-glow 2s ease-in-out infinite;
    flex-shrink: 0;
}
.fo-status-dot.disconnected {
    background: #e17055;
    box-shadow: 0 0 6px rgba(225,112,85,0.6);
}

@keyframes fo-pulse-glow {
    0%, 100% { box-shadow: 0 0 6px rgba(0,184,148,0.4); }
    50% { box-shadow: 0 0 10px rgba(0,184,148,0.8); }
}

.fo-header-center {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--wb-text-muted);
    white-space: nowrap;
}

.fo-header-center strong { color: var(--wb-text); font-weight: 600; }

.fo-war-badge {
    font-size: 10px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.06em;
    padding: 2px 6px; border-radius: 4px;
    background: rgba(225,112,85,0.15);
    color: #e17055;
    border: 1px solid rgba(225,112,85,0.25);
}

.fo-header-right {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
}

.fo-online-badge {
    display: flex; align-items: center; gap: 5px;
    font-size: 11px; font-weight: 500;
    color: #00b894;
    background: rgba(0,184,148,0.1);
    border: 1px solid rgba(0,184,148,0.2);
    padding: 3px 8px; border-radius: 20px;
}

.fo-online-badge .fo-dot {
    width: 6px; height: 6px;
    border-radius: 50%; background: #00b894;
}

/* ── Chain info in header ── */
.fo-chain-info {
    display: flex; align-items: center; gap: 8px;
    font-size: 11px; font-weight: 500;
    padding: 3px 10px; border-radius: 20px;
    background: rgba(0,184,148,0.1);
    border: 1px solid rgba(0,184,148,0.2);
    color: var(--wb-text);
}
.fo-chain-info .fo-chain-label { opacity: 0.6; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; }
.fo-chain-info .fo-chain-count { color: #00b894; font-weight: 700; }
.fo-chain-info .fo-chain-timeout { color: #fdcb6e; font-weight: 600; }
.fo-chain-info .fo-chain-timeout.danger { color: var(--wb-hospital-red); }
.fo-chain-info .fo-chain-bonus { color: var(--wb-bonus-warning); font-weight: 700; font-size: 10px; }

/* ── Settings button in header ── */
.fo-settings-btn {
    width: 28px; height: 28px; border-radius: 50%;
    background: rgba(99,110,114,0.2);
    border: 1px solid rgba(99,110,114,0.3);
    color: #b0b0c0; font-size: 15px;
    cursor: pointer; display: flex;
    align-items: center; justify-content: center;
    transition: all 0.15s ease; padding: 0; line-height: 1;
}
.fo-settings-btn:hover {
    background: rgba(99,110,114,0.35);
    color: var(--wb-text);
}

/* ── Next Up bar (inside overlay) ── */
.fo-next-up-bar {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 12px;
    background: var(--wb-accent-15);
    border-bottom: 1px solid rgba(45,52,54,0.4);
    font-size: 11px; min-height: 0;
    overflow-x: auto; overflow-y: hidden;
    white-space: nowrap;
}
.fo-next-up-bar:empty { display: none; }
.fo-next-up-label {
    font-weight: 600; color: #fdcb6e;
    white-space: nowrap; font-size: 10px;
    text-transform: uppercase; letter-spacing: 0.05em;
}
.fo-next-up-item {
    display: inline-flex; align-items: center; gap: 4px;
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(45,52,54,0.5);
    border-radius: 14px; padding: 2px 8px;
    white-space: nowrap; font-size: 11px; color: #b0b0c0;
}
.fo-next-up-item a { text-decoration: none; color: var(--wb-text); font-weight: 500; }
.fo-next-up-timer {
    font-family: 'JetBrains Mono', monospace;
    color: #e17055; font-weight: 600; font-size: 10px;
}
.fo-next-up-item.imminent {
    background: rgba(214,48,49,0.15);
    border-color: rgba(214,48,49,0.3);
}
.fo-next-up-item.imminent .fo-next-up-timer {
    color: #fdcb6e;
}
.fo-next-up-call {
    font-size: 8px; font-weight: 700;
    padding: 1px 5px; border-radius: 10px;
    border: 1px solid rgba(0,184,148,0.35);
    background: transparent; color: #00b894;
    cursor: pointer; line-height: 1.2;
}
.fo-next-up-call:hover {
    background: rgba(0,184,148,0.15);
}

/* ── Activate FactionOps button (fixed top banner, avoids Torn layout issues) ── */
#fo-activate-btn {
    position: fixed !important;
    top: 38px !important; left: 50% !important;
    transform: translateX(-50%) !important;
    z-index: 999998 !important;
    display: flex !important; align-items: center !important; justify-content: center !important; gap: 8px !important;
    width: auto !important; min-width: 320px !important; max-width: 500px !important;
    height: 38px !important;
    margin: 0 !important; padding: 0 16px !important;
    font-family: 'JetBrains Mono', monospace !important;
    font-size: 13px !important; font-weight: 700 !important;
    text-transform: uppercase !important; letter-spacing: 0.1em !important;
    border: 1.5px solid rgba(225,112,85,0.5) !important;
    border-radius: 8px !important;
    background: rgba(225,112,85,0.12) !important; color: #e17055 !important;
    backdrop-filter: blur(8px) !important; -webkit-backdrop-filter: blur(8px) !important;
    cursor: pointer !important; transition: all 0.2s ease !important;
    white-space: nowrap !important;
    box-sizing: border-box !important;
}
#fo-activate-btn:hover {
    background: rgba(225,112,85,0.3) !important;
    border-color: rgba(225,112,85,0.8) !important;
    box-shadow: 0 4px 16px rgba(225,112,85,0.25) !important;
}
#fo-activate-btn .fo-activate-icon {
    font-size: 14px; line-height: 1;
}

/* ── Column labels ── */
.fo-col-headers {
    display: grid;
    grid-template-columns: 58px 1fr 52px 82px 130px 44px 180px 72px;
    gap: 0; padding: 7px 16px;
    background: var(--wb-accent-20);
    border-bottom: 1px solid var(--wb-border);
    font-size: 10px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.08em;
    color: #636e72; user-select: none;
}

.fo-col-header { padding: 0 4px; white-space: nowrap; }
.fo-col-header.center { text-align: center; }
.fo-col-header.right { text-align: right; }

/* ── Target Rows ── */
.fo-target-list { list-style: none; margin: 0; padding: 0; }

.fo-row {
    display: grid;
    grid-template-columns: 58px 1fr 52px 82px 130px 44px 180px 72px;
    gap: 0; align-items: center;
    padding: 8px 16px;
    border-bottom: 1px solid rgba(45,52,54,0.5);
    transition: background 0.15s ease;
    position: relative;
}

.fo-row::before {
    content: '';
    position: absolute; left: 0; top: 0; bottom: 0;
    width: 3px; border-radius: 0 2px 2px 0;
    transition: background 0.2s ease;
}

.fo-row:hover { background: var(--wb-accent-20); }
.fo-row:last-child { border-bottom: none; }

.fo-row.is-hospital,
.fo-row.is-jail,
.fo-row.is-travel { opacity: 0.5; }

.fo-row.is-hospital:hover,
.fo-row.is-jail:hover,
.fo-row.is-travel:hover { opacity: 0.7; }

.fo-row.is-called::before { background: #00b894; }
.fo-row.is-called { background: rgba(0,184,148,0.04); }
.fo-row.is-high-priority::before { background: #e17055; }
.fo-row.is-called.is-high-priority::before {
    background: linear-gradient(180deg, #e17055 50%, #00b894 50%);
}

/* ── Cell styles ── */
.fo-cell { padding: 0 4px; display: flex; align-items: center; min-width: 0; overflow: hidden; }
.fo-cell.center { justify-content: center; }

.fo-priority-badge {
    font-size: 9px; font-weight: 700;
    letter-spacing: 0.06em; text-transform: uppercase;
    padding: 2px 7px; border-radius: 4px;
    white-space: nowrap; line-height: 1.4;
}

.fo-priority-badge.high {
    background: rgba(225,112,85,0.15); color: #e17055;
    border: 1px solid rgba(225,112,85,0.3);
}
.fo-priority-badge.med {
    background: rgba(253,203,110,0.12); color: #fdcb6e;
    border: 1px solid rgba(253,203,110,0.25);
}
.fo-priority-badge.low {
    background: rgba(9,132,227,0.12); color: #0984e3;
    border: 1px solid rgba(9,132,227,0.25);
}

.fo-priority-select {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.04em;
    background: var(--wb-accent-30); color: var(--wb-text-muted);
    border: 1px solid rgba(45,52,54,0.8); border-radius: 4px;
    padding: 2px 4px; cursor: pointer; outline: none;
    -webkit-appearance: none; appearance: none;
    width: 50px; text-align: center;
}
.fo-priority-select:hover { border-color: rgba(99,110,114,0.6); }
.fo-priority-select option { background: var(--wb-bg-secondary); color: var(--wb-text); }

/* Player Name */
.fo-player-name { display: flex; flex-direction: column; gap: 0; min-width: 0; }

.fo-player-name .fo-name-row {
    display: flex; align-items: center; gap: 6px;
}

.fo-player-name .fo-name {
    font-weight: 600; font-size: 12.5px; color: var(--wb-text);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}


.fo-player-name .fo-pid { font-size: 10px; color: #636e72; font-weight: 400; }
.fo-sub-row { display: flex; align-items: center; gap: 5px; }
.fo-bsp-inline {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px; font-weight: 600;
    padding: 1px 4px; border-radius: 8px;
    background: rgba(255,255,255,0.06);
    line-height: 1;
}
.fo-bsp-inline.tier-s { color: #e17055; }
.fo-bsp-inline.tier-a { color: #fdcb6e; }
.fo-bsp-inline.tier-b { color: #00b894; }
.fo-bsp-inline.tier-c { color: var(--wb-text-muted); }
.fo-bsp-inline.tier-unknown { color: #4a4a5a; }

/* ── Group Attack Eye Badge ── */
.fo-eye-badge {
    display: inline-flex; align-items: center; gap: 3px;
    font-size: 9px; font-weight: 600;
    color: #fdcb6e;
    background: rgba(253,203,110,0.12);
    border: 1px solid rgba(253,203,110,0.25);
    border-radius: 3px; padding: 1px 5px;
    white-space: nowrap; cursor: default; line-height: 1.3;
}

.fo-eye-badge .fo-eye-icon { font-size: 10px; line-height: 1; }

/* Level */
.fo-level {
    font-size: 11px; font-weight: 500; color: var(--wb-text-muted);
    text-align: center; white-space: nowrap;
}

/* BSP Stats */
.fo-bsp-stat {
    font-size: 11px; font-weight: 600; text-align: center;
    white-space: nowrap; letter-spacing: 0.02em;
}
.fo-bsp-stat.tier-s { color: #e17055; text-shadow: 0 0 8px rgba(225,112,85,0.3); }
.fo-bsp-stat.tier-a { color: #fdcb6e; }
.fo-bsp-stat.tier-b { color: #00b894; }
.fo-bsp-stat.tier-c { color: var(--wb-text-muted); }
.fo-bsp-stat.tier-unknown { color: #4a4a5a; font-weight: 400; font-style: italic; }

.fo-bsp-source {
    font-size: 8px; font-weight: 400;
    letter-spacing: 0.04em; text-transform: uppercase;
    opacity: 0.5; display: block; margin-top: 1px;
}

/* Status Pill */
.fo-status-pill {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 11px; font-weight: 500;
    padding: 3px 8px; border-radius: 20px;
    white-space: nowrap; line-height: 1;
}
.fo-status-pill .fo-s-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }

.fo-status-pill.ok { background: rgba(0,184,148,0.1); color: #00b894; border: 1px solid rgba(0,184,148,0.2); }
.fo-status-pill.ok .fo-s-dot { background: #00b894; }
.fo-status-pill.hosp { background: rgba(225,112,85,0.1); color: #e17055; border: 1px solid rgba(225,112,85,0.2); }
.fo-status-pill.hosp .fo-s-dot { background: #e17055; }
.fo-status-pill.travel { background: rgba(9,132,227,0.1); color: #0984e3; border: 1px solid rgba(9,132,227,0.2); }
.fo-status-pill.travel .fo-s-dot { background: #0984e3; }
.fo-status-pill.jail { background: rgba(99,110,114,0.15); color: #b2bec3; border: 1px solid rgba(99,110,114,0.25); }
.fo-status-pill.jail .fo-s-dot { background: #636e72; }

/* Online indicator */
.fo-online-dot { width: 8px; height: 8px; border-radius: 50%; margin: 0 auto; }
.fo-online-dot.on { background: #00b894; box-shadow: 0 0 5px rgba(0,184,148,0.4); }
.fo-online-dot.idle { background: #fdcb6e; box-shadow: 0 0 5px rgba(253,203,110,0.3); }
.fo-online-dot.off { background: #636e72; }

/* Call column */
.fo-call-cell { display: flex; align-items: center; gap: 4px; padding: 0 4px; min-width: 0; overflow: hidden; }

.fo-call-btn {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.04em;
    padding: 4px 10px; border-radius: 20px;
    border: 1px solid rgba(0,184,148,0.35);
    background: rgba(0,184,148,0.08); color: #00b894;
    cursor: pointer; transition: all 0.15s ease;
    white-space: nowrap; line-height: 1;
}
.fo-call-btn:hover {
    background: rgba(0,184,148,0.18);
    border-color: rgba(0,184,148,0.5);
    box-shadow: 0 0 8px rgba(0,184,148,0.15);
}

.fo-called-tag {
    display: flex; align-items: center; gap: 4px;
    font-size: 10px; font-weight: 500;
    padding: 3px 8px; border-radius: 20px;
    background: rgba(0,184,148,0.12);
    border: 1px solid rgba(0,184,148,0.25);
    color: #00b894; white-space: nowrap; line-height: 1;
    min-width: 0; overflow: hidden; flex-shrink: 1;
}
.fo-called-tag .fo-caller-name { max-width: 90px; overflow: hidden; text-overflow: ellipsis; }

.fo-uncall-btn {
    display: flex; align-items: center; justify-content: center;
    width: 16px; height: 16px; border-radius: 50%;
    border: 1px solid rgba(225,112,85,0.3);
    background: rgba(225,112,85,0.1); color: #e17055;
    font-size: 10px; cursor: pointer;
    transition: all 0.15s ease; flex-shrink: 0; line-height: 1;
}
.fo-uncall-btn:hover {
    background: rgba(225,112,85,0.25);
    border-color: rgba(225,112,85,0.5);
}

/* Attack button */
.fo-attack-btn {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.05em;
    padding: 4px 10px; border-radius: 20px;
    border: 1px solid rgba(225,112,85,0.4);
    background: transparent; color: #e17055;
    cursor: pointer; transition: all 0.15s ease;
    text-decoration: none;
    display: inline-flex; align-items: center; gap: 4px;
    line-height: 1; white-space: nowrap;
}
.fo-attack-btn:hover {
    background: rgba(225,112,85,0.15);
    border-color: rgba(225,112,85,0.6);
    box-shadow: 0 0 10px rgba(225,112,85,0.15);
    color: #e17055;
}
.fo-attack-btn .fo-arrow { font-size: 11px; line-height: 1; }

/* ── Footer ── */
.fo-footer {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 16px;
    background: var(--wb-accent-15);
    border-top: 1px solid var(--wb-border);
    font-size: 10px; color: #636e72;
}
.fo-footer-stats { display: flex; gap: 16px; }
.fo-footer-stat { display: flex; align-items: center; gap: 4px; }
.fo-footer-stat .fo-val { color: var(--wb-text-muted); font-weight: 600; }
.fo-footer-version { font-size: 9px; color: #4a4a5a; letter-spacing: 0.04em; }

/* ── Scrollbar inside overlay ── */
.fo-overlay ::-webkit-scrollbar { width: 6px; }
.fo-overlay ::-webkit-scrollbar-track { background: transparent; }
.fo-overlay ::-webkit-scrollbar-thumb { background: var(--wb-border); border-radius: 3px; }
.fo-overlay ::-webkit-scrollbar-thumb:hover { background: #636e72; }

/* ── Responsive ── */
@media (max-width: 700px) {
    .fo-overlay { border-radius: 6px; margin: 4px 0; }
    .fo-header { flex-wrap: wrap; gap: 6px; padding: 8px 12px; }
    .fo-col-headers, .fo-row {
        /* Prior | Target | (Lvl hidden) | (BSP hidden) | Status | On | Call | Action */
        grid-template-columns: 36px 1fr 0px 0px 62px 26px 66px 58px;
        padding: 7px 8px;
        column-gap: 6px;
        font-size: 11px;
    }
    /* Hide level and BSP columns on mobile (keep in grid flow) */
    .fo-col-headers > :nth-child(3),
    .fo-row > :nth-child(3),
    .fo-col-headers > :nth-child(4),
    .fo-row > :nth-child(4) { visibility: hidden; overflow: hidden; padding: 0 !important; margin: 0; min-width: 0; max-width: 0; font-size: 0; }
    .fo-footer { padding: 6px 12px; flex-wrap: wrap; gap: 4px; }
    .fo-footer-stats { gap: 10px; flex-wrap: wrap; }
    .fo-attack-btn { padding: 3px 8px; font-size: 9px; }
    .fo-call-btn { padding: 3px 8px; font-size: 9px; }
    .fo-called-tag { padding: 2px 6px; font-size: 9px; }
    .fo-called-tag .fo-caller-name { max-width: 34px; }
    .fo-call-cell { overflow: hidden; max-width: 100%; }
    .fo-status-pill { padding: 2px 6px; font-size: 10px; }
    .fo-player-name .fo-name { font-size: 11.5px; }
    .fo-player-name .fo-pid { font-size: 9px; }
    .fo-bsp-stat { font-size: 10px; }
    .fo-priority-badge { font-size: 8px; padding: 2px 6px; }
    .fo-priority-select { width: 38px; font-size: 8px; }
    /* Center status pill and online dot */
    .fo-row > :nth-child(5) { justify-content: center; }
    .fo-online-dot { margin: 0 auto; }
    .fo-col-headers > :nth-child(5) { text-align: center; }
    .fo-col-headers > :nth-child(6) { text-align: center; }
}

/* ----- Heatmap toggle button (fixed bottom-right, next to settings gear) ----- */
.wb-heatmap-btn {
    position: fixed;
    bottom: 20px;
    right: 70px;
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
.wb-heatmap-btn:hover {
    transform: scale(1.1);
    background: var(--wb-call-green);
}

/* ----- Heatmap floating panel ----- */
.wb-heatmap-panel {
    position: fixed;
    top: 100px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--wb-bg);
    border: 1px solid var(--wb-border);
    border-radius: 8px;
    z-index: 1000000;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    color: var(--wb-text);
    font-family: monospace;
    min-width: 420px;
    max-width: 95vw;
}
.wb-heatmap-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    cursor: grab;
    border-bottom: 1px solid var(--wb-border);
    font-size: 14px;
    font-weight: bold;
    color: var(--wb-call-green);
    user-select: none;
}
.wb-heatmap-close {
    background: none;
    border: none;
    color: var(--wb-text);
    font-size: 20px;
    cursor: pointer;
    opacity: 0.6;
    padding: 0 4px;
}
.wb-heatmap-close:hover { opacity: 1; }

.wb-heatmap-grid {
    display: grid;
    grid-template-columns: 36px repeat(24, 16px);
    gap: 2px;
    padding: 10px 14px;
    justify-content: center;
}
.wb-heatmap-label {
    font-size: 9px;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0.6;
}
.wb-heatmap-day {
    justify-content: flex-end;
    padding-right: 4px;
}
.wb-heatmap-cell {
    width: 16px;
    height: 16px;
    border-radius: 2px;
    cursor: default;
}
.wb-heatmap-footer {
    padding: 8px 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-top: 1px solid var(--wb-border);
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
        jwtToken: GM_getValue('factionops_jwt', ''),
        myPlayerId: null,
        myPlayerName: null,
        myFactionId: null,
        myFactionName: null,
        myFactionPosition: null,
        enemyFactionId: null,
        onlinePlayers: [],

        // Map of targetId -> { calledBy: { id, name }, calledAt: timestamp }
        calls: {},

        // Map of targetId -> { level, setBy: { id, name }, timestamp }
        priorities: {},

        // Map of targetId -> { status, until, description, activity }
        statuses: {},

        // Map of targetId -> [ { id, name } ] — faction members viewing that attack page
        viewers: {},

        // Chain data
        chain: {
            current: 0,
            max: 0,
            timeout: 0,
            cooldown: 0,
        },

        // Chain alert fired flag (resets when timeout goes back above threshold)
        chainAlertFired: false,

        // Whether a faction API key has been saved on the server
        factionKeyStored: false,

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

    // ── BSP / FFS stat helpers ──────────────────────────────────────────────

    /**
     * Read BSP prediction from localStorage (sync).
     * Key: tdup.battleStatsPredictor.cache.prediction.<userId>
     * Returns the parsed object (has .TBS) or null.
     */
    function fetchBspPrediction(userId) {
        try {
            const raw = localStorage.getItem(
                'tdup.battleStatsPredictor.cache.prediction.' + userId
            );
            if (!raw) return null;
            const pred = JSON.parse(raw);
            return pred || null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Read FF Scouter estimate from IndexedDB (async).
     * DB "ffscouter-cache", store "cache", key = parseInt(userId).
     * Resolves { total, human } or null.
     */
    function getFfScouterEstimate(userId) {
        return new Promise((resolve) => {
            try {
                const req = window.indexedDB.open('ffscouter-cache', 1);
                req.onerror = () => resolve(null);
                req.onsuccess = () => {
                    try {
                        const db = req.result;
                        const tx = db.transaction('cache', 'readonly');
                        const store = tx.objectStore('cache');
                        const get = store.get(parseInt(userId, 10));
                        get.onerror = () => resolve(null);
                        get.onsuccess = () => {
                            const r = get.result;
                            if (!r || r.no_data || typeof r.bs_estimate === 'undefined') {
                                resolve(null);
                            } else {
                                resolve({
                                    total: r.bs_estimate,
                                    human: r.bs_estimate_human || null,
                                });
                            }
                        };
                    } catch (_) {
                        resolve(null);
                    }
                };
            } catch (_) {
                resolve(null);
            }
        });
    }

    /**
     * Format a raw battle-stats number into a compact human string.
     * e.g. 3_200_000_000 → "3.20B", 750_000_000 → "750M".
     */
    function formatBspNumber(n) {
        if (n == null || isNaN(n)) return '\u2014';
        if (n >= 1e12)  return (n / 1e12).toFixed(2)  + 'T';
        if (n >= 1e9)   return (n / 1e9).toFixed(2)   + 'B';
        if (n >= 1e6)   return (n / 1e6).toFixed(1)    + 'M';
        if (n >= 1e3)   return (n / 1e3).toFixed(0)    + 'K';
        return String(Math.round(n));
    }

    /**
     * Classify a raw stat number into a tier for colour coding.
     * S (red, 3 B+), A (yellow, 1-3 B), B (green, 500 M-1 B), C (gray, <500 M).
     */
    function bspTier(n) {
        if (n == null || isNaN(n)) return 'unknown';
        if (n >= 3e9)   return 's';
        if (n >= 1e9)   return 'a';
        if (n >= 5e8)   return 'b';
        return 'c';
    }

    /**
     * Estimated one-way travel times in minutes (standard / airstrip).
     * Used as a rough fallback when the API doesn't provide an exact timer.
     * Returns midpoint between standard and airstrip as a reasonable guess.
     */
    const TRAVEL_ESTIMATES = {
        'mexico':              17, // 20 std / 14 air
        'canada':              32, // 37 / 26
        'cayman islands':      49, // 57 / 40
        'cayman':              49,
        'hawaii':              103, // 121 / 85
        'united kingdom':      130, // 152 / 107
        'uk':                  130,
        'argentina':           161, // 189 / 133
        'switzerland':         144, // 169 / 118
        'japan':               173, // 203 / 142
        'china':               186, // 219 / 153
        'united arab emirates':220, // 259 / 181
        'uae':                 220,
        'south africa':        264, // 311 / 217
    };

    /**
     * Estimate when a traveling opponent will be back in Torn and attackable.
     * - "Returning to Torn from X" → one-way flight time (they're on their way back)
     * - "Traveling to X" → two-way minimum (outbound + return, not counting time abroad)
     * - "In X" / abroad → one-way return flight at minimum
     * Returns a string like "~2h 10m" or null if unknown destination.
     */
    function estimateTravelReturn(description) {
        if (!description) return null;
        const desc = description.toLowerCase();
        let dest = null;
        let mins = 0;
        for (const [d, m] of Object.entries(TRAVEL_ESTIMATES)) {
            if (desc.includes(d)) { dest = d; mins = m; break; }
        }
        if (!dest) return null;

        let estimate;
        if (desc.includes('returning')) {
            // Already heading back — one-way flight time
            estimate = mins;
        } else if (desc.includes('traveling to')) {
            // Still outbound — outbound remainder unknown + full return
            // Show at minimum the return flight
            estimate = mins;
            return formatEstimate(estimate) + '+';
        } else {
            // "In X" — abroad, needs to fly back
            estimate = mins;
            return formatEstimate(estimate) + '+';
        }
        return formatEstimate(estimate);
    }



    function formatEstimate(mins) {
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return h > 0 ? `~${h}h ${m}m` : `~${m}m`;
    }

    // =========================================================================
    // SECTION 6: HTTP POLLING CLIENT
    // =========================================================================

    // ── Polling-based server communication (replaces Socket.IO) ──────────

    const POLL_INTERVAL_MS = IS_PDA ? 2000 : 1000;

    let pollTimer = null;
    let pollErrorCount = 0;
    const MAX_POLL_BACKOFF = 30000;

    /** Derive a stable warId from factionId (convention: "war_<factionId>"). */
    function deriveWarId() {
        return state.myFactionId ? `war_${state.myFactionId}` : null;
    }

    /**
     * POST a JSON action to the server.
     * On PDA uses fetch(); elsewhere uses GM_xmlhttpRequest.
     */
    function postAction(endpoint, body) {
        return new Promise((resolve, reject) => {
            if (!state.jwtToken) return reject(new Error('Not authenticated'));
            const url = `${CONFIG.SERVER_URL}${endpoint}`;
            const json = JSON.stringify(body);

            httpRequest({
                method: 'POST',
                url,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${state.jwtToken}`,
                },
                data: json,
                onload(res) {
                    const data = safeParse(res.responseText);
                    if (res.status >= 200 && res.status < 300) resolve(data);
                    else reject(new Error((data && data.error) || `HTTP ${res.status}`));
                },
                onerror() { reject(new Error('Network error')); },
            });
        });
    }

    /** POST-based remove action with auth header (PDA compatible — no DELETE method). */
    function removeAction(endpoint) {
        return new Promise((resolve, reject) => {
            if (!state.jwtToken) return reject(new Error('Not authenticated'));
            const url = `${CONFIG.SERVER_URL}${endpoint}`;

            httpRequest({
                method: 'POST',
                url,
                headers: {
                    'Authorization': `Bearer ${state.jwtToken}`,
                    'Content-Type': 'application/json',
                },
                data: '{}',
                onload(res) {
                    const data = safeParse(res.responseText);
                    if (res.status >= 200 && res.status < 300) resolve(data);
                    else reject(new Error((data && data.error) || `HTTP ${res.status}`));
                },
                onerror() { reject(new Error('Network error')); },
            });
        });
    }

    /**
     * GET with auth header.
     * Uses httpRequest wrapper which routes through PDA_httpGet (with headers)
     * on Torn PDA, or GM_xmlhttpRequest on desktop.
     */
    function getAction(endpoint) {
        if (!state.jwtToken) return Promise.reject(new Error('Not authenticated'));

        const url = `${CONFIG.SERVER_URL}${endpoint}`;
        return new Promise((resolve, reject) => {
            httpRequest({
                method: 'GET',
                url,
                headers: { 'Authorization': `Bearer ${state.jwtToken}` },
                onload(res) {
                    const data = safeParse(res.responseText);
                    if (res.status >= 200 && res.status < 300) resolve(data);
                    else reject(new Error((data && data.error) || `HTTP ${res.status}`));
                },
                onerror() { reject(new Error('Network error')); },
            });
        });
    }

    /**
     * Single poll cycle: fetch server state, diff against local, fire notifications.
     */
    async function pollOnce() {
        const warId = deriveWarId();
        if (!warId || !state.jwtToken) {
            if (IS_PDA) log('pollOnce skip — warId:', warId, 'jwt:', !!state.jwtToken, 'factionId:', state.myFactionId);
            return;
        }

        try {
            const qs = `warId=${encodeURIComponent(warId)}` +
                (state.enemyFactionId ? `&enemyFactionId=${encodeURIComponent(state.enemyFactionId)}` : '');
            const data = await getAction(`/api/poll?${qs}`);

            if (!state.connected) {
                state.connected = true;
                state.connecting = false;
                pollErrorCount = 0;
                updateConnectionUI();
                log('Polling connected');
            }

            // ── Diff & notify: calls ──
            if (data.calls) {
                const oldCalls = state.calls;
                // New calls
                for (const [tid, callData] of Object.entries(data.calls)) {
                    if (!oldCalls[tid]) {
                        // Notification for new call by someone else
                        if (String(callData.calledBy.id) !== state.myPlayerId) {
                            showToast(`${callData.calledBy.name} called target #${tid}`, 'info');
                        }
                        broadcastStateChange({ type: 'call_update', targetId: tid });
                    }
                }
                // Removed calls
                for (const tid of Object.keys(oldCalls)) {
                    if (!data.calls[tid]) {
                        broadcastStateChange({ type: 'call_update', targetId: tid });
                    }
                }
                state.calls = data.calls;
            }

            // ── Priorities ──
            if (data.priorities) {
                state.priorities = data.priorities;
            }

            // ── Statuses ──
            if (data.enemyStatuses) {
                state.statuses = data.enemyStatuses;
            }

            // ── Chain ──
            if (data.chainData) {
                const oldCurrent = state.chain.current;
                const chainChanged = data.chainData.current !== oldCurrent;
                // Always update hit count and max
                state.chain.current = data.chainData.current ?? state.chain.current;
                state.chain.max = data.chainData.max ?? state.chain.max;
                // Timeout: only accept server value when chain count changes,
                // local timer has expired, or server value differs by >5s
                // (corrects drift without causing visible jitter)
                const serverTimeout = data.chainData.timeout ?? 0;
                const localTimeout = state.chain.timeout;
                const drift = Math.abs(serverTimeout - localTimeout);
                if (chainChanged || localTimeout <= 0 || drift > 5) {
                    state.chain.timeout = serverTimeout;
                    chainTimeoutSetAt = Date.now();
                    chainTimeoutSetVal = serverTimeout;
                }
                // Cooldown always from server (not locally counted)
                state.chain.cooldown = data.chainData.cooldown ?? 0;
                chainCooldownSetAt = Date.now();
                chainCooldownSetVal = data.chainData.cooldown ?? 0;
                updateChainBar();

                // Bonus hit notification
                if (data.chainData.current && chainChanged) {
                    const next = nextBonusMilestone(data.chainData.current + 1);
                    const hitsToBonus = next ? next - data.chainData.current : null;
                    if (hitsToBonus !== null && hitsToBonus <= 3 && hitsToBonus > 0) {
                        showToast(`BONUS HIT in ${hitsToBonus}! Target: ${next}`, 'error');
                    }
                }
            }

            // ── Online players ──
            if (data.onlinePlayers) {
                state.onlinePlayers = data.onlinePlayers;

            }

            // ── Viewers (who is on which attack page) ──
            if (data.viewers) {
                state.viewers = data.viewers;
            }

            // Store enemyFactionId from server if we didn't have it
            if (data.enemyFactionId && !state.enemyFactionId) {
                state.enemyFactionId = data.enemyFactionId;
            }

            // Faction key status from server
            if (data.factionKeyStored !== undefined) {
                state.factionKeyStored = !!data.factionKeyStored;
            }

            // Refresh UI rows
            refreshAllRows();

        } catch (err) {
            pollErrorCount++;
            if (state.connected) {
                state.connected = false;
                updateConnectionUI();
                warn('Poll failed:', err.message);
            }

            // Re-authenticate on 401
            if (err.message && err.message.includes('401')) {
                try {
                    await authenticate();
                    pollErrorCount = 0;
                } catch (authErr) {
                    warn('Re-auth failed:', authErr.message);
                }
            }
        }
    }

    /** Start the polling loop. */
    function startPolling() {
        if (pollTimer) return; // already running
        if (!state.jwtToken) {
            warn('No JWT token — cannot start polling');
            state.connected = false;
            state.connecting = false;
            updateConnectionUI();
            return;
        }

        state.connecting = true;
        updateConnectionUI();
        log('Starting poll loop (' + POLL_INTERVAL_MS + 'ms interval)');

        // Immediate first poll
        pollOnce();

        pollTimer = setInterval(() => {
            const backoff = pollErrorCount > 0
                ? Math.min(POLL_INTERVAL_MS * Math.pow(2, pollErrorCount), MAX_POLL_BACKOFF)
                : POLL_INTERVAL_MS;

            // Skip this tick if in backoff (simple jitter)
            if (pollErrorCount > 0 && Math.random() > (POLL_INTERVAL_MS / backoff)) return;

            pollOnce();
        }, POLL_INTERVAL_MS);
    }

    /** Stop the polling loop. */
    function stopPolling() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
        state.connected = false;
        state.connecting = false;
        pollErrorCount = 0;
        updateConnectionUI();
        log('Polling stopped');
    }

    // =========================================================================
    // SECTION 7: AUTH MANAGER
    // =========================================================================

    /**
     * Authenticate with the FactionOps server.
     * Sends the Torn API key to POST /api/auth, receives a JWT.
     */
    function authenticate() {
        return new Promise((resolve, reject) => {
            if (!CONFIG.API_KEY) {
                return reject(new Error('No API key configured'));
            }
            log('Authenticating with server...', IS_PDA ? '(PDA mode)' : '(desktop)');
            if (IS_PDA) log('API key starts with:', CONFIG.API_KEY.substring(0, 4));

            httpRequest({
                method: 'POST',
                url: `${CONFIG.SERVER_URL}/api/auth`,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ apiKey: CONFIG.API_KEY }),
                onload(res) {
                    log('Auth response status:', res.status);
                    const body = safeParse(res.responseText);
                    if (res.status >= 200 && res.status < 300 && body && body.token) {
                        state.jwtToken = body.token;
                        GM_setValue('factionops_jwt', body.token);
                        if (body.player) {
                            state.myPlayerId = String(body.player.playerId || body.player.id);
                            state.myPlayerName = body.player.playerName || body.player.name;
                            state.myFactionId = String(body.player.factionId || '0');
                            state.myFactionName = body.player.factionName || '';
                            state.myFactionPosition = (body.player.factionPosition || '').toLowerCase();
                        }
                        log('Authenticated as', state.myPlayerName || 'unknown',
                            '— factionId:', state.myFactionId);
                        resolve(body);
                    } else {
                        const msg = (body && body.error) || `HTTP ${res.status}`;
                        warn('Auth failed:', msg);
                        reject(new Error(msg));
                    }
                },
                onerror(e) {
                    warn('Auth network error:', e);
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
    // SECTION 8: ACTION HELPERS (HTTP POST)
    // =========================================================================

    function emitCallTarget(targetId) {
        if (!state.connected) return;
        const warId = deriveWarId();
        if (!warId) return;
        // Optimistic update
        const tid = String(targetId);
        state.calls[tid] = {
            calledBy: { id: state.myPlayerId, name: state.myPlayerName || 'You' },
            calledAt: Date.now(),
        };
        updateTargetRow(tid);
        postAction('/api/call', { warId, targetId: tid })
            .catch(e => {
                warn('Call failed:', e.message);
                delete state.calls[tid];
                updateTargetRow(tid);
                showToast(e.message || 'Call failed', 'error');
            });
    }

    function emitUncallTarget(targetId) {
        if (!state.connected) return;
        const warId = deriveWarId();
        if (!warId) return;
        // Optimistic update
        const tid = String(targetId);
        const prev = state.calls[tid];
        delete state.calls[tid];
        updateTargetRow(tid);
        postAction('/api/call', { warId, targetId: tid, action: 'uncall' })
            .catch(e => {
                warn('Uncall failed:', e.message);
                if (prev) state.calls[tid] = prev;
                updateTargetRow(tid);
            });
    }

    /** Set or clear a priority tag on a target (leader/co-leader only). */
    function emitSetPriority(targetId, priority) {
        if (!state.connected) return;
        const warId = deriveWarId();
        if (!warId) return;
        postAction('/api/priority', { warId, targetId: String(targetId), priority })
            .then(() => {
                // Optimistic update
                if (priority === null) {
                    delete state.priorities[targetId];
                } else {
                    state.priorities[targetId] = {
                        level: priority,
                        setBy: { id: state.myPlayerId, name: state.myPlayerName },
                        timestamp: Date.now(),
                    };
                }
                updateTargetRow(String(targetId));
                broadcastStateChange({ type: 'state_update', priorities: state.priorities });
            })
            .catch(e => {
                warn('Set priority failed:', e.message);
                showToast(e.message || 'Failed to set priority', 'error');
            });
    }

    /** Check if current user is a faction leader, co-leader, or war leader. */
    function isLeader() {
        const pos = state.myFactionPosition || '';
        return pos === 'leader' || pos === 'co-leader' || pos === 'war leader';
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
                <div style="display:flex;align-items:center;gap:8px;">
                    <span style="font-size:11px;opacity:0.6;">Dark</span>
                    <label class="wb-toggle">
                        <input type="checkbox" id="wb-toggle-theme" ${CONFIG.THEME === 'light' ? 'checked' : ''}>
                        <span class="wb-toggle-slider"></span>
                    </label>
                    <span style="font-size:11px;opacity:0.6;">Light</span>
                </div>
            </div>

            <div class="wb-settings-row">
                <span>Auto-Sort Targets</span>
                <label class="wb-toggle">
                    <input type="checkbox" id="wb-toggle-autosort" ${CONFIG.AUTO_SORT ? 'checked' : ''}>
                    <span class="wb-toggle-slider"></span>
                </label>
            </div>

            <div class="wb-settings-row">
                <span>Chain Break Alert</span>
                <label class="wb-toggle">
                    <input type="checkbox" id="wb-toggle-chain-alert" ${CONFIG.CHAIN_ALERT ? 'checked' : ''}>
                    <span class="wb-toggle-slider"></span>
                </label>
            </div>
            <div id="wb-chain-alert-threshold-row" style="display:${CONFIG.CHAIN_ALERT ? 'flex' : 'none'};align-items:center;gap:8px;margin-bottom:14px;">
                <span style="font-size:12px;opacity:0.8;">Alert when chain timer below</span>
                <input type="text" id="wb-input-chain-threshold" value="${CONFIG.CHAIN_ALERT_THRESHOLD}" style="width:50px;margin-bottom:0;text-align:center;">
                <span style="font-size:12px;opacity:0.8;">seconds</span>
            </div>

            <hr style="border:none;border-top:1px solid rgba(255,255,255,0.1);margin:14px 0;">

            <label>Faction API Key</label>
            <div style="font-size:11px;opacity:0.7;margin-bottom:8px;">
                Provide a Limited API key for server-side war status updates. This lets the server poll Torn directly instead of relying on page data.
            </div>
            <div style="font-size:11px;margin-bottom:8px;">
                <a href="https://www.torn.com/preferences.php#tab=api" target="_blank" rel="noopener" style="color:#87ceeb;text-decoration:underline;">Create a Limited key on Torn</a>
            </div>
            <div id="wb-faction-key-status" style="font-size:11px;margin-bottom:8px;min-height:14px;"></div>
            <div id="wb-faction-key-input-row" style="display:flex;gap:6px;margin-bottom:14px;">
                <input type="text" id="wb-input-faction-key" placeholder="Paste faction API key" style="margin-bottom:0;flex:1;">
                <button class="wb-btn wb-btn-sm" id="wb-btn-save-faction-key">Save Key</button>
            </div>
            <div id="wb-faction-key-saved-row" style="display:none;align-items:center;gap:8px;margin-bottom:14px;">
                <span style="color:var(--wb-call-green);font-size:12px;">Key saved \u2713</span>
                <button class="wb-btn wb-btn-sm wb-btn-danger" id="wb-btn-remove-faction-key">Remove</button>
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
        });

        document.getElementById('wb-toggle-autosort').addEventListener('change', (e) => {
            setConfig('AUTO_SORT', e.target.checked);
            if (e.target.checked) debouncedSort();
        });

        document.getElementById('wb-toggle-chain-alert').addEventListener('change', (e) => {
            setConfig('CHAIN_ALERT', e.target.checked);
            const thresholdRow = document.getElementById('wb-chain-alert-threshold-row');
            if (thresholdRow) thresholdRow.style.display = e.target.checked ? 'flex' : 'none';
        });

        document.getElementById('wb-input-chain-threshold').addEventListener('change', (e) => {
            const val = parseInt(e.target.value, 10);
            if (val > 0 && val <= 300) {
                setConfig('CHAIN_ALERT_THRESHOLD', val);
            } else {
                e.target.value = CONFIG.CHAIN_ALERT_THRESHOLD;
            }
        });

        // Faction API key — check if one already exists
        (async () => {
            if (state.factionKeyStored) {
                showFactionKeySaved();
            }
        })();

        document.getElementById('wb-btn-save-faction-key').addEventListener('click', async () => {
            const statusEl = document.getElementById('wb-faction-key-status');
            const keyVal = document.getElementById('wb-input-faction-key').value.trim();
            if (!keyVal) {
                statusEl.textContent = 'Please paste an API key.';
                statusEl.style.color = 'var(--wb-call-red)';
                return;
            }
            statusEl.textContent = 'Saving...';
            statusEl.style.color = 'var(--wb-idle-yellow)';
            try {
                const resp = await postAction('/api/faction-key', { apiKey: keyVal });
                if (resp && resp.ok) {
                    statusEl.textContent = '';
                    state.factionKeyStored = true;
                    showFactionKeySaved();
                } else {
                    statusEl.textContent = (resp && resp.error) || 'Failed to save key';
                    statusEl.style.color = 'var(--wb-call-red)';
                }
            } catch (e) {
                statusEl.textContent = 'Error: ' + e.message;
                statusEl.style.color = 'var(--wb-call-red)';
            }
        });

        document.getElementById('wb-btn-remove-faction-key').addEventListener('click', async () => {
            const statusEl = document.getElementById('wb-faction-key-status');
            statusEl.textContent = 'Removing...';
            statusEl.style.color = 'var(--wb-idle-yellow)';
            try {
                const resp = await removeAction('/api/faction-key/remove');
                if (resp && resp.ok) {
                    statusEl.textContent = '';
                    state.factionKeyStored = false;
                    showFactionKeyInput();
                } else {
                    statusEl.textContent = (resp && resp.error) || 'Failed to remove key';
                    statusEl.style.color = 'var(--wb-call-red)';
                }
            } catch (e) {
                statusEl.textContent = 'Error: ' + e.message;
                statusEl.style.color = 'var(--wb-call-red)';
            }
        });

        function showFactionKeySaved() {
            const inputRow = document.getElementById('wb-faction-key-input-row');
            const savedRow = document.getElementById('wb-faction-key-saved-row');
            if (inputRow) inputRow.style.display = 'none';
            if (savedRow) savedRow.style.display = 'flex';
        }

        function showFactionKeyInput() {
            const inputRow = document.getElementById('wb-faction-key-input-row');
            const savedRow = document.getElementById('wb-faction-key-saved-row');
            if (inputRow) inputRow.style.display = 'flex';
            if (savedRow) savedRow.style.display = 'none';
        }

        document.getElementById('wb-btn-disconnect').addEventListener('click', () => {
            stopPolling();
            closeSettings();
        });

        document.getElementById('wb-btn-save').addEventListener('click', async () => {
            const serverUrl = document.getElementById('wb-input-server').value.trim() || 'http://localhost:3000';
            const apiKey = document.getElementById('wb-input-apikey').value.trim();

            setConfig('SERVER_URL', serverUrl);
            setConfig('API_KEY', apiKey);

            stopPolling();
            if (apiKey) {
                try {
                    await authenticate();
                    startPolling();
                } catch (e) {
                    warn('Auth failed on save:', e.message);
                    if (state.jwtToken) startPolling();
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
            text.textContent = state.connected ? 'Syncing' : state.connecting ? 'Connecting...' : 'Offline';
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
            <div class="wb-next-up" id="wb-next-up"></div>
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



    /**
     * Forward intercepted chain data to the server so all faction members
     * see the update instantly (instead of waiting for the 30s poll).
     */
    let _lastForwardedChain = 0;
    function forwardChainToServer(chain) {
        const warId = deriveWarId();
        if (!warId || !state.jwtToken) return;
        // Throttle: don't send more than once every 3 seconds
        const now = Date.now();
        if (now - _lastForwardedChain < 3000) return;
        _lastForwardedChain = now;
        postAction('/api/update', {
            warId,
            chainData: {
                current: chain.current || 0,
                max: chain.max || 0,
                timeout: chain.timeout || 0,
                cooldown: chain.cooldown || 0,
            },
        }).catch(() => { /* silent — server poll is the fallback */ });
    }

    /** Update chain bar contents and styling. */
    function updateChainBar() {
        // Compute chain display values
        const countText = `${state.chain.current || 0}/${state.chain.max || '??'}`;
        let timeoutText = '--:--';
        if (state.chain.timeout > 0) {
            timeoutText = formatTimer(state.chain.timeout);
        } else if (state.chain.cooldown > 0) {
            timeoutText = `CD: ${formatTimer(state.chain.cooldown)}`;
        }
        const next = nextBonusMilestone(state.chain.current + 1);
        const hitsToBonus = next ? next - state.chain.current : null;
        let bonusText = '';
        let showBonus = false;
        if (hitsToBonus !== null && hitsToBonus <= 10) {
            showBonus = true;
            bonusText = hitsToBonus <= 0 ? `BONUS ${next}!` : `BONUS in ${hitsToBonus}`;
        }
        const isDanger = state.chain.timeout > 0 && state.chain.timeout <= 30;

        // Update floating chain bar (if visible)
        const bar = state.ui.chainBar;
        if (bar && bar.style.display !== 'none') {
            const countEl = document.getElementById('wb-chain-count');
            const timeoutEl = document.getElementById('wb-chain-timeout');
            const bonusBadge = document.getElementById('wb-chain-bonus-badge');
            if (countEl) countEl.textContent = countText;
            if (timeoutEl) timeoutEl.textContent = timeoutText;
            if (bonusBadge) {
                bonusBadge.style.display = showBonus ? 'inline' : 'none';
                if (showBonus) bonusBadge.textContent = bonusText;
            }
            bar.classList.remove('wb-chain-safe', 'wb-chain-approaching', 'wb-chain-imminent');
            if (hitsToBonus !== null && hitsToBonus <= 3) {
                bar.classList.add('wb-chain-imminent');
            } else if (hitsToBonus !== null && hitsToBonus <= 10) {
                bar.classList.add('wb-chain-approaching');
            } else {
                bar.classList.add('wb-chain-safe');
            }
        }

        // Update overlay header chain info (if visible)
        const foCount = document.getElementById('fo-chain-count');
        const foTimeout = document.getElementById('fo-chain-timeout');
        const foBonus = document.getElementById('fo-chain-bonus');
        if (foCount) foCount.textContent = countText;
        if (foTimeout) {
            foTimeout.textContent = timeoutText;
            foTimeout.classList.toggle('danger', isDanger);
        }
        if (foBonus) {
            foBonus.style.display = showBonus ? 'inline' : 'none';
            if (showBonus) foBonus.textContent = bonusText;
        }
    }

    // ---- Chain break sound alert via Web Audio API ----
    function playChainAlert() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const beep = (startTime) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.frequency.value = 800;
                osc.type = 'square';
                gain.gain.value = 0.3;
                osc.start(startTime);
                osc.stop(startTime + 0.1);
            };
            const now = ctx.currentTime;
            beep(now);
            beep(now + 0.2);
            beep(now + 0.4);
        } catch (e) {
            warn('Chain alert audio failed:', e);
        }
    }

    // Client-side countdown for chain timeout/cooldown
    let chainTimerRAF = null;
    // Wall-clock anchors — immune to rAF pausing when tab/overlay is hidden
    let chainTimeoutSetAt = 0;   // Date.now() when timeout was last set
    let chainTimeoutSetVal = 0;  // timeout value (seconds) at that moment
    let chainCooldownSetAt = 0;
    let chainCooldownSetVal = 0;

    function startChainTimer() {
        if (chainTimerRAF) return; // already running

        function tick() {
            // Use wall-clock time so the countdown stays accurate even when
            // requestAnimationFrame is paused (tab hidden / overlay closed).
            if (chainTimeoutSetAt > 0 && chainTimeoutSetVal > 0) {
                const elapsed = (Date.now() - chainTimeoutSetAt) / 1000;
                state.chain.timeout = Math.max(0, chainTimeoutSetVal - elapsed);
            }
            // Chain break sound alert
            if (CONFIG.CHAIN_ALERT && state.chain.timeout > 0 && state.chain.timeout <= CONFIG.CHAIN_ALERT_THRESHOLD && !state.chainAlertFired) {
                playChainAlert();
                state.chainAlertFired = true;
            }
            if (state.chain.timeout > CONFIG.CHAIN_ALERT_THRESHOLD) {
                state.chainAlertFired = false;
            }
            if (chainCooldownSetAt > 0 && chainCooldownSetVal > 0) {
                const elapsed = (Date.now() - chainCooldownSetAt) / 1000;
                state.chain.cooldown = Math.max(0, chainCooldownSetVal - elapsed);
            }

            updateChainBar();
            chainTimerRAF = requestAnimationFrame(tick);
        }

        chainTimerRAF = requestAnimationFrame(tick);
    }

    // Re-sync chain timer immediately when the tab becomes visible again,
    // so the user never sees a stale value after switching back.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            // Wall-clock tick already computes the correct remaining time,
            // but force a UI refresh right now so it appears instant.
            updateChainBar();
        }
    });

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
        let nextUpAccum = 0; // throttle next-up DOM writes to ~1s

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
                    // Also update overlay timer element
                    const foTimerEl = document.getElementById(`fo-timer-${targetId}`);
                    if (foTimerEl) {
                        foTimerEl.textContent = formatTimer(s.until);
                    }
                }
            }

            // Update the Next Up queue roughly once per second
            nextUpAccum += dt;
            if (nextUpAccum >= 1) {
                nextUpAccum = 0;
                updateNextUp();
            }

            statusTimerRAF = requestAnimationFrame(tick);
        }

        statusTimerRAF = requestAnimationFrame(tick);
    }

    /**
     * Update the "Next Up" queue in the chain bar.
     * Shows the top 3 hospital targets closest to being released.
     * Excludes called targets (they're already claimed).
     */
    function updateNextUp() {
        // Update both chain-bar version and overlay version
        const wbContainer = document.getElementById('wb-next-up');
        const foContainer = document.getElementById('fo-next-up');
        if (wbContainer) updateNextUpContainer(wbContainer, 'wb');
        if (foContainer) updateNextUpContainer(foContainer, 'fo');
    }

    function updateNextUpContainer(container, prefix) {
        // Collect hospital targets that aren't called and still have a timer
        const hospitalTargets = [];
        for (const [targetId, s] of Object.entries(state.statuses)) {
            if (s.status === 'hospital' && s.until > 0 && !state.calls[targetId]) {
                hospitalTargets.push({ targetId, until: s.until, name: s.name || `#${targetId}` });
            }
        }

        // Sort by shortest timer first, take top 3
        hospitalTargets.sort((a, b) => a.until - b.until);
        const top3 = hospitalTargets.slice(0, 3);

        if (top3.length === 0) {
            container.innerHTML = '';
            return;
        }

        // Check if the same targets are already rendered — only update timers
        const currentIds = Array.from(container.querySelectorAll('[data-nu-id]')).map(el => el.dataset.nuId);
        const newIds = top3.map(t => t.targetId);
        const sameSet = currentIds.length === newIds.length && currentIds.every((id, i) => id === newIds[i]);

        if (sameSet) {
            for (const t of top3) {
                const item = container.querySelector(`[data-nu-id="${t.targetId}"]`);
                if (!item) continue;
                const timerSpan = item.querySelector(`.${prefix}-next-timer, .fo-next-up-timer, .wb-next-timer`);
                if (timerSpan) timerSpan.textContent = formatTimer(t.until);
                const imminent = t.until <= 120;
                if (prefix === 'fo') {
                    item.classList.toggle('imminent', imminent);
                } else {
                    item.classList.toggle('wb-next-imminent', imminent);
                }
            }
            return;
        }

        // Full rebuild
        container.innerHTML = '';

        const label = document.createElement('span');
        label.className = prefix === 'fo' ? 'fo-next-up-label' : 'wb-next-up-label';
        label.textContent = 'Next Up:';
        container.appendChild(label);

        for (const t of top3) {
            // Try to get the name from the overlay row or status data
            const foRow = document.querySelector(`[data-fo-id="${t.targetId}"]`);
            const wbRow = document.querySelector(`[data-wb-target-id="${t.targetId}"]`);
            let name = t.name;
            if (foRow) {
                const n = foRow.querySelector('.fo-name');
                if (n) name = n.textContent;
            } else if (wbRow) {
                name = getPlayerNameFromRow(wbRow) || name;
            }
            const imminent = t.until <= 120;

            const item = document.createElement('span');
            if (prefix === 'fo') {
                item.className = 'fo-next-up-item' + (imminent ? ' imminent' : '');
            } else {
                item.className = imminent ? 'wb-next-up-item wb-next-imminent' : 'wb-next-up-item';
            }
            item.dataset.nuId = t.targetId;

            const nameLink = document.createElement('a');
            nameLink.className = 'user name';
            nameLink.href = `https://www.torn.com/profiles.php?XID=${t.targetId}`;
            nameLink.dataset.placeholder = `${name} [${t.targetId}]`;
            nameLink.style.cssText = 'text-decoration:none;color:inherit;';
            nameLink.title = name;
            nameLink.textContent = name;
            item.appendChild(nameLink);

            const timerSpan = document.createElement('span');
            timerSpan.className = prefix === 'fo' ? 'fo-next-up-timer' : 'wb-next-timer';
            timerSpan.textContent = formatTimer(t.until);
            item.appendChild(timerSpan);

            const callBtn = document.createElement('button');
            callBtn.className = prefix === 'fo' ? 'fo-next-up-call' : 'wb-next-up-call';
            callBtn.textContent = 'Call';
            callBtn.title = `Call ${name}`;
            callBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                emitCallTarget(t.targetId);
            });
            item.appendChild(callBtn);

            container.appendChild(item);
        }
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
     * Injects Attack, Call, and Status cells into the row.
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

        // Create a container for our injected cells (absolutely positioned right)
        const wbContainer = document.createElement('div');
        wbContainer.className = 'wb-cell-container';
        wbContainer.id = `wb-cells-${targetId}`;

        // --- Status cell ---
        const statusCell = document.createElement('span');
        statusCell.className = 'wb-cell';
        statusCell.id = `wb-status-${targetId}`;
        renderStatusCell(statusCell, targetId);

        // --- Attack button ---
        const attackCell = document.createElement('span');
        attackCell.className = 'wb-cell';
        const attackLink = document.createElement('a');
        attackLink.className = 'wb-attack-btn';
        attackLink.textContent = 'Attack';
        attackLink.href = `https://www.torn.com/loader.php?sid=attack&user2ID=${targetId}`;
        attackLink.target = '_blank';
        attackLink.rel = 'noopener';
        attackLink.addEventListener('click', (e) => e.stopPropagation());
        attackCell.appendChild(attackLink);

        // --- Call cell ---
        const callCell = document.createElement('span');
        callCell.className = 'wb-cell';
        callCell.id = `wb-call-${targetId}`;
        renderCallCell(callCell, targetId);

        // --- Priority cell ---
        const priorityCell = document.createElement('span');
        priorityCell.className = 'wb-cell';
        priorityCell.id = `wb-priority-${targetId}`;
        renderPriorityCell(priorityCell, targetId);

        // --- BSP / FFS estimated stats cell ---
        const bspCell = document.createElement('span');
        bspCell.className = 'wb-cell';
        bspCell.id = `wb-bsp-${targetId}`;
        renderBspCell(bspCell, targetId);

        // --- Viewers (group attack) badge ---
        const viewersCell = document.createElement('span');
        viewersCell.className = 'wb-cell';
        viewersCell.id = `wb-viewers-${targetId}`;
        renderViewersBadge(viewersCell, targetId);

        wbContainer.appendChild(priorityCell);
        wbContainer.appendChild(viewersCell);
        wbContainer.appendChild(bspCell);
        wbContainer.appendChild(statusCell);
        wbContainer.appendChild(attackCell);
        wbContainer.appendChild(callCell);

        // Always append to the row directly — CSS handles positioning
        row.appendChild(wbContainer);

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
            case 'travel': {
                badge.className = 'wb-status-badge wb-status-travel';
                const travelTimer = timerSpan || '';
                const estimate = !travelTimer ? estimateTravelReturn(statusData.description) : null;
                const timeStr = travelTimer || (estimate ? `<span style="opacity:0.6">${estimate}</span>` : '');
                badge.innerHTML = `${dot} Travel: ${statusData.description || ''} ${timeStr}`;
                break;
            }
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

    /**
     * Render the priority cell for a target.
     * Leaders/co-leaders see a dropdown; others see a read-only badge (or nothing).
     */
    function renderPriorityCell(container, targetId) {
        container.innerHTML = '';
        const prioData = state.priorities[targetId];
        const level = prioData ? prioData.level : null;

        if (isLeader()) {
            // Show a dropdown selector for leaders
            const select = document.createElement('select');
            select.className = 'wb-priority-select';
            select.title = 'Set target priority';

            const options = [
                { value: '', label: '\u2014' },
                { value: 'high', label: '\u{1F534} High' },
                { value: 'medium', label: '\u{1F7E1} Med' },
                { value: 'low', label: '\u{1F535} Low' },
            ];
            for (const opt of options) {
                const el = document.createElement('option');
                el.value = opt.value;
                el.textContent = opt.label;
                if (opt.value === (level || '')) el.selected = true;
                select.appendChild(el);
            }

            select.addEventListener('change', (e) => {
                e.stopPropagation();
                const val = select.value || null;
                emitSetPriority(targetId, val);
            });
            select.addEventListener('click', (e) => e.stopPropagation());

            container.appendChild(select);
        } else if (level) {
            // Non-leaders see a read-only badge
            const badge = document.createElement('span');
            badge.className = `wb-priority-badge wb-priority-${level}`;
            const labels = { high: '\u{1F534} HIGH', medium: '\u{1F7E1} MED', low: '\u{1F535} LOW' };
            badge.textContent = labels[level] || level.toUpperCase();
            badge.title = prioData.setBy ? `Set by ${prioData.setBy.name}` : '';
            container.appendChild(badge);
        }
        // If no priority and not a leader, cell stays empty (takes no space)
    }

    /**
     * Render the BSP/FFS estimated-stats cell for a target.
     * Tries BSP prediction (sync localStorage) first, then FFS (async IndexedDB).
     * Shows the formatted number + a tiny "bsp" / "ffs" source label underneath.
     */
    function renderBspCell(container, targetId) {
        container.innerHTML = '';

        const wrapper = document.createElement('span');
        wrapper.className = 'wb-bsp-cell';

        // 1. Try BSP prediction (synchronous)
        const pred = fetchBspPrediction(targetId);
        if (pred && pred.TBS != null) {
            const num = Number(pred.TBS);
            const tier = bspTier(num);

            const val = document.createElement('span');
            val.className = `wb-bsp-value wb-bsp-tier-${tier}`;
            val.textContent = formatBspNumber(num);
            val.title = num.toLocaleString() + ' (BSP prediction)';
            wrapper.appendChild(val);

            const src = document.createElement('span');
            src.className = 'wb-bsp-source';
            src.textContent = 'bsp';
            wrapper.appendChild(src);

            container.appendChild(wrapper);
            return;
        }

        // 2. FFS fallback (async) — show dash while loading
        const val = document.createElement('span');
        val.className = 'wb-bsp-value wb-bsp-tier-unknown';
        val.textContent = '\u2014';
        wrapper.appendChild(val);
        container.appendChild(wrapper);

        getFfScouterEstimate(targetId).then((ffs) => {
            if (!ffs) return;                       // leave dash
            const num = Number(ffs.total);
            if (isNaN(num)) return;

            const tier = bspTier(num);
            val.className = `wb-bsp-value wb-bsp-tier-${tier}`;
            val.textContent = ffs.human || formatBspNumber(num);
            val.title = num.toLocaleString() + ' (FF Scouter)';

            const src = document.createElement('span');
            src.className = 'wb-bsp-source';
            src.textContent = 'ffs';
            wrapper.appendChild(src);
        });
    }

    /**
     * Render a small badge showing how many faction members are viewing
     * this target's attack page. Shows nothing if 0 viewers.
     */
    function renderViewersBadge(container, targetId) {
        container.innerHTML = '';
        const viewers = state.viewers[targetId];
        if (!viewers || viewers.length === 0) return;

        const badge = document.createElement('span');
        badge.className = 'wb-viewers-badge' + (viewers.length >= 2 ? ' wb-viewers-multi' : '');
        const names = viewers.map(v => v.name).join(', ');
        badge.textContent = `\uD83D\uDC41 ${viewers.length}`;
        badge.title = `Attacking: ${names}`;
        container.appendChild(badge);
    }

    /** Apply/remove row highlight classes based on call state. */
    function applyRowHighlights(row, targetId) {
        const isCalled = !!state.calls[targetId];
        row.classList.toggle('wb-row-called', isCalled);
    }

    /** Re-render all FactionOps cells for a specific target. */
    function updateTargetRow(targetId) {
        // Update overlay row if overlay is active
        const foRow = document.querySelector(`[data-fo-id="${targetId}"]`);
        if (foRow) {
            updateOverlayRow(foRow, targetId);
        }

        // Also update old-style enhanced row cells
        const callEl = document.getElementById(`wb-call-${targetId}`);
        if (callEl) renderCallCell(callEl, targetId);

        const statusEl = document.getElementById(`wb-status-${targetId}`);
        if (statusEl) renderStatusCell(statusEl, targetId);

        const prioEl = document.getElementById(`wb-priority-${targetId}`);
        if (prioEl) renderPriorityCell(prioEl, targetId);

        const bspEl = document.getElementById(`wb-bsp-${targetId}`);
        if (bspEl) renderBspCell(bspEl, targetId);

        const viewersEl = document.getElementById(`wb-viewers-${targetId}`);
        if (viewersEl) renderViewersBadge(viewersEl, targetId);

        // Update row highlight
        const row = document.querySelector(`[data-wb-target-id="${targetId}"]`);
        if (row) applyRowHighlights(row, targetId);
    }

    /** Re-render all enhanced rows (after bulk state update). */
    function refreshAllRows() {
        // If the overlay is active, re-render it
        if (document.getElementById('fo-overlay')) {
            renderOverlay();
        }

        // Also update any old-style enhanced rows (e.g. non-war pages)
        const rows = document.querySelectorAll('[data-wb-target-id]');
        rows.forEach((row) => {
            const targetId = row.dataset.wbTargetId;
            updateTargetRow(targetId);
        });
        if (CONFIG.AUTO_SORT) debouncedSort();
        updateNextUp();
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
    // SECTION 12B: FULL OVERLAY — WAR PAGE REPLACEMENT
    // =========================================================================

    /** Show an "Activate FactionOps" button on any faction/war page. */
    function showActivateButton() {
        if (document.getElementById('fo-activate-btn')) return;

        const btn = document.createElement('button');
        btn.id = 'fo-activate-btn';
        btn.innerHTML = '<span class="fo-activate-icon">&#x2694;</span> Activate FactionOps';
        btn.addEventListener('click', () => {
            btn.remove();
            initWarOverlay();
        });

        // Fixed-position banner — append to body to avoid Torn layout interference
        document.body.appendChild(btn);
    }

    function initWarOverlay() {
        // Timers — no chain bar in overlay mode
        startChainTimer();
        startStatusTimers();
        startCallPruner();
        // Refresh chain display immediately so overlay shows current value
        updateChainBar();

        // Hide Torn's main content area so the overlay takes over the full page
        const mainContent = document.getElementById('mainContainer')
            || document.querySelector('.content-wrapper');
        if (mainContent) {
            mainContent.dataset.foHidden = 'true';
            mainContent.style.display = 'none';
        }

        // Create the overlay if it doesn't already exist
        if (document.getElementById('fo-overlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'fo-overlay';
        overlay.className = 'fo-overlay';

        // ── Header ──
        overlay.innerHTML = `
            <div class="fo-header">
                <div class="fo-header-left">
                    <div class="fo-logo-mark">
                        <svg class="fo-logo-icon" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="FactionOps">
                            <rect x="1" y="1" width="18" height="18" rx="3" stroke="#e17055" stroke-width="1.5" fill="none"/>
                            <path d="M6 6h8M6 10h5M6 14h8" stroke="#e0e0e0" stroke-width="1.5" stroke-linecap="round"/>
                            <circle cx="15" cy="14" r="2" fill="#00b894"/>
                        </svg>
                        <span class="fo-logo-text">FactionOps</span>
                    </div>
                    <div class="fo-status-dot${state.connected ? '' : ' disconnected'}" id="fo-conn-dot" title="${state.connected ? 'Connected' : 'Disconnected'}"></div>
                </div>
                <div class="fo-header-center">
                    <span class="fo-war-badge" id="fo-war-type">War</span>
                    <span>vs</span>
                    <strong id="fo-enemy-name">${escapeHtml(state.enemyFactionName || state.enemyFactionId || 'Enemy Faction')}</strong>
                </div>
                <div class="fo-header-right">
                    <div class="fo-chain-info">
                        <span class="fo-chain-label">Chain</span>
                        <span class="fo-chain-count" id="fo-chain-count">${state.chain.current || 0}/${state.chain.max || '??'}</span>
                        <span class="fo-chain-timeout" id="fo-chain-timeout">${state.chain.timeout > 0 ? formatTimer(state.chain.timeout) : '--:--'}</span>
                        <span class="fo-chain-bonus" id="fo-chain-bonus" style="display:none;"></span>
                    </div>
                    <div class="fo-online-badge"><span class="fo-dot"></span><span id="fo-online-count">${state.onlinePlayers.length} online</span></div>
                    <button class="fo-settings-btn" id="fo-heatmap-header-btn" title="Activity Heatmap">&#x1F4CA;</button>
                    <button class="fo-settings-btn" id="fo-settings-btn" title="Settings">&#x2699;</button>
                </div>
            </div>
            <div class="fo-next-up-bar" id="fo-next-up"></div>
            <div class="fo-col-headers">
                <div class="fo-col-header">Prior.</div>
                <div class="fo-col-header">Target</div>
                <div class="fo-col-header center">Lvl</div>
                <div class="fo-col-header center">BSP</div>
                <div class="fo-col-header">Status</div>
                <div class="fo-col-header center">On</div>
                <div class="fo-col-header">Call</div>
                <div class="fo-col-header right">Action</div>
            </div>
            <ul class="fo-target-list" id="fo-target-list"></ul>
            <div class="fo-footer">
                <div class="fo-footer-stats">
                    <span class="fo-footer-stat">Targets: <span class="fo-val" id="fo-stat-targets">0</span></span>
                    <span class="fo-footer-stat">Available: <span class="fo-val" id="fo-stat-available">0</span></span>
                    <span class="fo-footer-stat">Called: <span class="fo-val" id="fo-stat-called">0</span></span>
                    <span class="fo-footer-stat">Hosp: <span class="fo-val" id="fo-stat-hosp">0</span></span>
                </div>
                <span class="fo-footer-version">v${CONFIG.VERSION || '3.0.0'}</span>
            </div>
        `;

        // Insert after the hidden main content, taking over the page
        const hiddenMain = document.querySelector('[data-fo-hidden="true"]');
        if (hiddenMain && hiddenMain.parentNode) {
            hiddenMain.parentNode.insertBefore(overlay, hiddenMain.nextSibling);
        } else {
            document.body.appendChild(overlay);
        }

        renderOverlay();

        // Wire up heatmap button in overlay header
        const heatmapHeaderBtn = document.getElementById('fo-heatmap-header-btn');
        if (heatmapHeaderBtn) {
            heatmapHeaderBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleHeatmapPanel();
            });
        }

        // Wire up settings button in overlay header
        const settingsBtn = document.getElementById('fo-settings-btn');
        if (settingsBtn) {
            settingsBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleSettings();
            });
        }

        // Hide the floating gear and heatmap FABs when overlay is active
        const fab = document.querySelector('.wb-settings-gear');
        if (fab) fab.style.display = 'none';
        const heatmapFab = document.getElementById('wb-heatmap-toggle');
        if (heatmapFab) heatmapFab.style.display = 'none';

        log('War overlay initialised');
    }

    /** Simple HTML escape. */
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    /**
     * Full render/re-render of all overlay rows from state.statuses.
     * Uses DOM diffing: updates existing rows in-place, adds new ones,
     * removes stale ones.
     */
    function renderOverlay() {
        const list = document.getElementById('fo-target-list');
        if (!list) return;

        const targetIds = Object.keys(state.statuses);

        // Build a set of current targets for stale-removal
        const currentSet = new Set(targetIds);

        // Remove stale rows
        const existingRows = list.querySelectorAll('[data-fo-id]');
        existingRows.forEach((row) => {
            if (!currentSet.has(row.dataset.foId)) {
                row.remove();
            }
        });

        // Sort targets
        const sorted = targetIds.map((tid) => ({
            targetId: tid,
            priority: sortPriority(tid),
            timer: sortTimerValue(tid),
        }));

        sorted.sort((a, b) => {
            if (a.priority !== b.priority) return a.priority - b.priority;
            return a.timer - b.timer;
        });

        // Build/update rows in sorted order — reorder without detaching
        let prevNode = null;
        for (const item of sorted) {
            let row = list.querySelector(`[data-fo-id="${item.targetId}"]`);
            if (row) {
                // Update in-place
                updateOverlayRow(row, item.targetId);
            } else {
                // Create new row
                row = renderOverlayRow(item.targetId);
            }
            // Only move the node if it's not already in the right position
            const expectedNext = prevNode ? prevNode.nextSibling : list.firstChild;
            if (row !== expectedNext) {
                list.insertBefore(row, expectedNext);
            }
            prevNode = row;
        }

        // Update footer stats
        updateOverlayFooter();

        // Update header connection dot
        const dot = document.getElementById('fo-conn-dot');
        if (dot) {
            dot.classList.toggle('disconnected', !state.connected);
            dot.title = state.connected ? 'Connected' : 'Disconnected';
        }

        // Update online count
        const onlineEl = document.getElementById('fo-online-count');
        if (onlineEl) onlineEl.textContent = `${state.onlinePlayers.length} online`;

        // Update enemy name
        const enemyEl = document.getElementById('fo-enemy-name');
        if (enemyEl && state.enemyFactionName) {
            enemyEl.textContent = state.enemyFactionName;
        }
    }

    /**
     * Build a single overlay row <li> for a target.
     */
    function renderOverlayRow(targetId) {
        const li = document.createElement('li');
        li.className = 'fo-row';
        li.dataset.foId = targetId;

        const s = state.statuses[targetId] || {};
        const prio = state.priorities[targetId];
        const callData = state.calls[targetId];
        const viewers = state.viewers[targetId];

        // Row status classes
        applyOverlayRowClasses(li, targetId);

        // 1. Priority cell
        const prioCell = document.createElement('div');
        prioCell.className = 'fo-cell';
        prioCell.id = `fo-priority-${targetId}`;
        renderOverlayPriorityCell(prioCell, targetId);
        li.appendChild(prioCell);

        // 2. Target cell (name + id + eye badge)
        const targetCell = document.createElement('div');
        targetCell.className = 'fo-cell';
        const playerName = document.createElement('div');
        playerName.className = 'fo-player-name';

        const nameRow = document.createElement('div');
        nameRow.className = 'fo-name-row';

        const nameSpan = document.createElement('a');
        nameSpan.className = 'fo-name user name';
        nameSpan.href = `https://www.torn.com/profiles.php?XID=${targetId}`;
        nameSpan.dataset.placeholder = `${s.name || 'Unknown'} [${targetId}]`;
        nameSpan.style.textDecoration = 'none';
        nameSpan.style.color = 'inherit';
        nameSpan.textContent = s.name || 'Unknown';
        nameRow.appendChild(nameSpan);

        // Eye badge for viewers
        if (viewers && viewers.length > 0) {
            const eye = document.createElement('span');
            eye.className = 'fo-eye-badge';
            eye.title = viewers.map((v) => v.name).join(', ') + ' viewing';
            eye.innerHTML = `<span class="fo-eye-icon">\uD83D\uDC41</span>${viewers.length}`;
            nameRow.appendChild(eye);
        }

        playerName.appendChild(nameRow);

        // Sub-row: ID + inline BSP badge
        const subRow = document.createElement('div');
        subRow.className = 'fo-sub-row';

        const pid = document.createElement('span');
        pid.className = 'fo-pid';
        pid.textContent = `[${targetId}]`;
        subRow.appendChild(pid);

        // Inline BSP badge
        const bspBadge = document.createElement('span');
        bspBadge.className = 'fo-bsp-inline';
        bspBadge.id = `fo-bsp-inline-${targetId}`;
        renderInlineBsp(bspBadge, targetId);
        subRow.appendChild(bspBadge);

        playerName.appendChild(subRow);

        targetCell.appendChild(playerName);
        li.appendChild(targetCell);

        // 3. Level cell
        const lvlCell = document.createElement('div');
        lvlCell.className = 'fo-cell center';
        const lvlSpan = document.createElement('span');
        lvlSpan.className = 'fo-level';
        lvlSpan.textContent = s.level != null ? String(s.level) : '\u2014';
        lvlCell.appendChild(lvlSpan);
        li.appendChild(lvlCell);

        // 4. BSP cell
        const bspCell = document.createElement('div');
        bspCell.className = 'fo-cell center';
        bspCell.id = `fo-bsp-${targetId}`;
        renderOverlayBspCell(bspCell, targetId);
        li.appendChild(bspCell);

        // 5. Status cell
        const statusCell = document.createElement('div');
        statusCell.className = 'fo-cell';
        statusCell.id = `fo-status-${targetId}`;
        renderOverlayStatusCell(statusCell, targetId);
        li.appendChild(statusCell);

        // 6. Online cell
        const onlineCell = document.createElement('div');
        onlineCell.className = 'fo-cell center';
        onlineCell.id = `fo-online-${targetId}`;
        const onlineDot = document.createElement('span');
        const activity = (s.activity || 'offline').toLowerCase();
        const onlineClass = activity === 'online' ? 'on' : (activity === 'idle' ? 'idle' : 'off');
        onlineDot.className = `fo-online-dot ${onlineClass}`;
        onlineDot.title = activity.charAt(0).toUpperCase() + activity.slice(1);
        onlineCell.appendChild(onlineDot);
        li.appendChild(onlineCell);

        // 7. Call cell
        const callCell = document.createElement('div');
        callCell.className = 'fo-call-cell';
        callCell.id = `fo-call-${targetId}`;
        renderOverlayCallCell(callCell, targetId);
        li.appendChild(callCell);

        // 8. Action cell
        const actionCell = document.createElement('div');
        actionCell.className = 'fo-cell';
        actionCell.style.justifyContent = 'flex-end';
        const atkLink = document.createElement('a');
        atkLink.className = 'fo-attack-btn';
        atkLink.href = `https://www.torn.com/loader.php?sid=attack&user2ID=${targetId}`;
        atkLink.target = '_blank';
        atkLink.rel = 'noopener';
        atkLink.innerHTML = 'Atk<span class="fo-arrow">\u203A</span>';
        atkLink.addEventListener('click', (e) => e.stopPropagation());
        actionCell.appendChild(atkLink);
        li.appendChild(actionCell);

        return li;
    }

    /** Apply status/call/priority classes to an overlay row. */
    function applyOverlayRowClasses(row, targetId) {
        const s = state.statuses[targetId] || {};
        const status = (s.status || 'ok').toLowerCase();
        const isCalled = !!state.calls[targetId];
        const prio = state.priorities[targetId];
        const isHigh = prio && prio.level === 'high';

        row.classList.toggle('is-hospital', status === 'hospital');
        row.classList.toggle('is-jail', status === 'jail');
        row.classList.toggle('is-travel', status === 'traveling' || status === 'travel');
        row.classList.toggle('is-called', isCalled);
        row.classList.toggle('is-high-priority', isHigh);
    }

    /** Render the priority cell for overlay rows. */
    function renderOverlayPriorityCell(cell, targetId) {
        cell.innerHTML = '';
        const prio = state.priorities[targetId];
        const level = prio ? prio.level : null;

        if (isLeader()) {
            // Leaders get a dropdown
            const sel = document.createElement('select');
            sel.className = 'fo-priority-select';
            sel.title = 'Set priority';
            ['high', 'med', 'low', ''].forEach((val) => {
                const opt = document.createElement('option');
                opt.value = val;
                opt.textContent = val ? val.toUpperCase() : '\u2014';
                if (val === (level || '')) opt.selected = true;
                sel.appendChild(opt);
            });
            sel.addEventListener('change', () => {
                emitSetPriority(targetId, sel.value || null);
            });
            cell.appendChild(sel);
        } else if (level) {
            const badge = document.createElement('span');
            badge.className = `fo-priority-badge ${level}`;
            badge.textContent = level.charAt(0).toUpperCase() + level.slice(1);
            cell.appendChild(badge);
        }
    }

    /** Render the status pill for overlay rows. */
    function renderOverlayStatusCell(cell, targetId) {
        cell.innerHTML = '';
        const s = state.statuses[targetId] || {};
        const status = (s.status || 'ok').toLowerCase();

        let pillClass = 'ok';
        let label = 'OK';

        if (status === 'hospital') {
            pillClass = 'hosp';
            label = 'Hosp';
        } else if (status === 'jail') {
            pillClass = 'jail';
            label = 'Jail';
        } else if (status === 'traveling' || status === 'travel') {
            pillClass = 'travel';
            label = 'Travel';
        }

        const pill = document.createElement('span');
        pill.className = `fo-status-pill ${pillClass}`;
        pill.innerHTML = `<span class="fo-s-dot"></span>${label}`;

        // Timer
        if (s.until && s.until > 0) {
            const timer = document.createElement('span');
            timer.id = `fo-timer-${targetId}`;
            timer.style.marginLeft = '4px';
            timer.textContent = formatTimer(s.until);
            pill.appendChild(timer);
        }

        cell.appendChild(pill);
    }

    /** Render the BSP cell for overlay rows. */
    /** Render compact inline BSP badge (next to player name). */
    function renderInlineBsp(el, targetId) {
        el.textContent = '';
        el.className = 'fo-bsp-inline';

        // 1. BSP prediction (sync)
        const pred = fetchBspPrediction(targetId);
        if (pred && pred.TBS != null) {
            const num = Number(pred.TBS);
            const tier = bspTier(num);
            el.className = `fo-bsp-inline tier-${tier}`;
            el.textContent = formatBspNumber(num);
            el.title = `~${num.toLocaleString()} total stats (BSP)`;
            return;
        }

        // 2. FFS fallback (async)
        el.className = 'fo-bsp-inline tier-unknown';
        getFfScouterEstimate(targetId).then((ffs) => {
            if (!ffs) return;
            const num = Number(ffs.total);
            if (isNaN(num)) return;
            const tier = bspTier(num);
            el.className = `fo-bsp-inline tier-${tier}`;
            el.textContent = ffs.human || formatBspNumber(num);
            el.title = `~${num.toLocaleString()} total stats (FFS)`;
        });
    }

    function renderOverlayBspCell(cell, targetId) {
        cell.innerHTML = '';

        // 1. Try BSP prediction (synchronous)
        const pred = fetchBspPrediction(targetId);
        if (pred && pred.TBS != null) {
            const num = Number(pred.TBS);
            const tier = bspTier(num);
            const span = document.createElement('span');
            span.className = `fo-bsp-stat tier-${tier}`;
            span.title = `~${num.toLocaleString()} total stats (BSP)`;
            span.innerHTML = `${formatBspNumber(num)}<span class="fo-bsp-source">bsp</span>`;
            cell.appendChild(span);
            return;
        }

        // 2. FFS fallback (async) — show dash while loading
        const span = document.createElement('span');
        span.className = 'fo-bsp-stat tier-unknown';
        span.textContent = '\u2014';
        cell.appendChild(span);

        getFfScouterEstimate(targetId).then((ffs) => {
            if (!ffs) return;
            const num = Number(ffs.total);
            if (isNaN(num)) return;
            const tier = bspTier(num);
            span.className = `fo-bsp-stat tier-${tier}`;
            span.title = `~${num.toLocaleString()} total stats (FFS)`;
            span.innerHTML = `${ffs.human || formatBspNumber(num)}<span class="fo-bsp-source">ffs</span>`;
        });
    }

    /** Render the call cell for overlay rows. */
    function renderOverlayCallCell(cell, targetId) {
        cell.innerHTML = '';
        const callData = state.calls[targetId];

        if (callData) {
            const tag = document.createElement('span');
            tag.className = 'fo-called-tag';
            const callerName = document.createElement('span');
            callerName.className = 'fo-caller-name';
            const isMine = callData.calledBy && String(callData.calledBy.id) === state.myPlayerId;
            callerName.textContent = isMine ? 'Mine' : (callData.calledBy ? callData.calledBy.name : 'Someone');
            tag.appendChild(callerName);
            cell.appendChild(tag);

            const uncallBtn = document.createElement('button');
            uncallBtn.className = 'fo-uncall-btn';
            uncallBtn.title = 'Uncall';
            uncallBtn.textContent = '\u2715';
            uncallBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                emitUncallTarget(targetId);
            });
            cell.appendChild(uncallBtn);
        } else {
            const btn = document.createElement('button');
            btn.className = 'fo-call-btn';
            btn.textContent = 'Call';
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                emitCallTarget(targetId);
            });
            cell.appendChild(btn);
        }
    }

    /** Update an existing overlay row in-place. */
    function updateOverlayRow(row, targetId) {
        if (!row) return;

        applyOverlayRowClasses(row, targetId);

        const s = state.statuses[targetId] || {};

        // Update name
        const nameEl = row.querySelector('.fo-name');
        if (nameEl && s.name) {
            nameEl.textContent = s.name;
            nameEl.dataset.placeholder = `${s.name} [${targetId}]`;
        }

        // Update level
        const lvlEl = row.querySelector('.fo-level');
        if (lvlEl) lvlEl.textContent = s.level != null ? String(s.level) : '\u2014';

        // Update online dot
        const onlineCell = document.getElementById(`fo-online-${targetId}`);
        if (onlineCell) {
            const dot = onlineCell.querySelector('.fo-online-dot');
            if (dot) {
                const activity = (s.activity || 'offline').toLowerCase();
                const cls = activity === 'online' ? 'on' : (activity === 'idle' ? 'idle' : 'off');
                dot.className = `fo-online-dot ${cls}`;
                dot.title = activity.charAt(0).toUpperCase() + activity.slice(1);
            }
        }

        // Update viewers badge
        const targetCell = row.children[1]; // second cell is target
        if (targetCell) {
            const existingEye = targetCell.querySelector('.fo-eye-badge');
            const viewers = state.viewers[targetId];
            if (viewers && viewers.length > 0) {
                if (existingEye) {
                    existingEye.innerHTML = `<span class="fo-eye-icon">\uD83D\uDC41</span>${viewers.length}`;
                    existingEye.title = viewers.map((v) => v.name).join(', ') + ' viewing';
                } else {
                    const nameRow = targetCell.querySelector('.fo-name-row');
                    if (nameRow) {
                        const eye = document.createElement('span');
                        eye.className = 'fo-eye-badge';
                        eye.title = viewers.map((v) => v.name).join(', ') + ' viewing';
                        eye.innerHTML = `<span class="fo-eye-icon">\uD83D\uDC41</span>${viewers.length}`;
                        nameRow.appendChild(eye);
                    }
                }
            } else if (existingEye) {
                existingEye.remove();
            }
        }

        // Re-render volatile cells
        const prioCell = document.getElementById(`fo-priority-${targetId}`);
        if (prioCell) renderOverlayPriorityCell(prioCell, targetId);

        const statusCell = document.getElementById(`fo-status-${targetId}`);
        if (statusCell) renderOverlayStatusCell(statusCell, targetId);

        const callCell = document.getElementById(`fo-call-${targetId}`);
        if (callCell) renderOverlayCallCell(callCell, targetId);

        const bspCell = document.getElementById(`fo-bsp-${targetId}`);
        if (bspCell) renderOverlayBspCell(bspCell, targetId);

        const bspInline = document.getElementById(`fo-bsp-inline-${targetId}`);
        if (bspInline) renderInlineBsp(bspInline, targetId);
    }

    /** Update footer stats. */
    function updateOverlayFooter() {
        const ids = Object.keys(state.statuses);
        const total = ids.length;
        let available = 0, called = 0, hosp = 0;

        for (const tid of ids) {
            const s = state.statuses[tid] || {};
            const status = (s.status || 'ok').toLowerCase();
            if (status === 'ok' || status === 'okay') available++;
            if (status === 'hospital') hosp++;
            if (state.calls[tid]) called++;
        }

        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = String(val);
        };
        set('fo-stat-targets', total);
        set('fo-stat-available', available);
        set('fo-stat-called', called);
        set('fo-stat-hosp', hosp);
    }

    // =========================================================================
    // SECTION 13: AUTO-SORT
    // =========================================================================

    /**
     * Sort priority for a target. Lower number = higher in the list.
     *   0: High priority (uncalled)
     *   1: OK / idle / offline (uncalled)
     *   2: Hospital
     *   3: Traveling
     *   4: Jail
     *   5: Called (sinks to bottom)
     */
    function sortPriority(targetId) {
        const s = state.statuses[targetId];
        const status = s ? (s.status || 'ok') : 'ok';
        const isCalled = !!state.calls[targetId];
        const prio = state.priorities[targetId];
        const isHighPriority = prio && prio.level === 'high';

        // Called targets sink to bottom
        if (isCalled) return 5;

        // High priority + OK status floats above everything
        if (isHighPriority && (status === 'ok' || status === 'okay')) return 0;

        switch (status) {
            case 'okay':
            case 'ok':
                return 1;
            case 'hospital':
                return 2;
            case 'traveling':
            case 'travel':
                return 3;
            case 'jail':
                return 4;
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
        // If the overlay is active, re-render it (renderOverlay handles sorting)
        if (document.getElementById('fo-overlay')) {
            renderOverlay();
            return;
        }
        const rows = Array.from(document.querySelectorAll('[data-wb-target-id]'));
        if (rows.length === 0) return;

        // Determine the parent container
        const parent = rows[0].parentElement;
        if (!parent) return;

        // Build sort array
        const sorted = rows.map((row) => {
            const tid = row.dataset.wbTargetId;
            return {
                row,
                targetId: tid,
                priority: sortPriority(tid),
                timer: sortTimerValue(tid),
            };
        });

        sorted.sort((a, b) => {
            if (a.priority !== b.priority) return a.priority - b.priority;
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
            // Physically re-order DOM nodes in-place (no detach/reattach flicker).
            let prev = null;
            for (const item of sorted) {
                const expected = prev ? prev.nextSibling : parent.firstChild;
                if (item.row !== expected) {
                    parent.insertBefore(item.row, expected);
                }
                prev = item.row;
            }
        }
    }

    const debouncedSort = debounce(sortMemberList, 300);

    // =========================================================================
    // SECTION 14: ATTACK PAGE ENHANCEMENT
    // =========================================================================

    /**
     * When on the attack page (loader.php?sid=attack), show a small overlay
     * with call info for the current target.
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
                <span>Also here:</span>
                <span id="wb-atk-viewers" style="color:#a29bfe;">--</span>
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
        if (!callEl) return;

        const callData = state.calls[targetId];
        if (callData && callData.calledBy) {
            callEl.textContent = `Called by ${callData.calledBy.name}`;
            callEl.style.color = 'var(--wb-call-green)';
        } else {
            callEl.textContent = 'Uncalled';
            callEl.style.color = 'var(--wb-text)';
        }

        // Update viewers (others on this same attack page)
        const viewersEl = document.getElementById('wb-atk-viewers');
        if (viewersEl) {
            const viewers = (state.viewers[targetId] || []).filter(
                v => String(v.id) !== state.myPlayerId
            );
            if (viewers.length > 0) {
                viewersEl.textContent = viewers.map(v => v.name).join(', ');
                viewersEl.style.color = viewers.length >= 2 ? '#ff7675' : '#a29bfe';
            } else {
                viewersEl.textContent = 'None';
                viewersEl.style.color = 'var(--wb-text)';
            }
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
                if (typeof url === 'string' && (url.includes('api.torn.com') || url.includes('torn.com'))) {
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
            const statusBatch = {};
            for (const [memberId, member] of Object.entries(data.members)) {
                const statusInfo = parseInterceptedMemberStatus(member);
                if (statusInfo) {
                    statusBatch[String(memberId)] = statusInfo;
                }
                // Also update local state immediately, preserving existing name/level if not in this payload
                const existing = state.statuses[String(memberId)] || {};
                state.statuses[String(memberId)] = {
                    ...existing,
                    ...statusInfo,
                    name: statusInfo.name || existing.name || null,
                    level: statusInfo.level != null ? statusInfo.level : (existing.level != null ? existing.level : null),
                };
                updateTargetRow(String(memberId));
            }

            // Refresh the Next Up queue after status changes
            updateNextUp();
        }

        // Chain data
        if (data.chain) {
            const chain = data.chain;
            state.chain.current = chain.current || 0;
            state.chain.max = chain.max || 0;
            state.chain.timeout = chain.timeout || 0;
            chainTimeoutSetAt = Date.now();
            chainTimeoutSetVal = state.chain.timeout;
            state.chain.cooldown = chain.cooldown || 0;
            chainCooldownSetAt = Date.now();
            chainCooldownSetVal = state.chain.cooldown;
            updateChainBar();
            // Forward chain data to server so all faction members see it instantly
            forwardChainToServer(state.chain);
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
        const name = member.name || null;
        const level = member.level != null ? Number(member.level) : null;

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

        return { status, until, description, activity, name, level };
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

    // Periodic refresh is handled by the polling loop (Section 6).

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
     * Detect if the current page is a war page vs a regular faction page.
     * Torn war pages have specific URL hashes or DOM elements that distinguish
     * them from the member list, info tab, etc.
     */
    function isWarContext() {
        const hash = window.location.hash.toLowerCase();
        const url = window.location.href.toLowerCase();

        // war.php is always a war page
        if (url.includes('war.php')) return true;

        // Hash-based war indicators on factions.php
        if (hash.includes('war') || hash.includes('ranked')) return true;

        // DOM-based detection: look for war-specific elements
        const warDomIndicators = [
            '.faction-war',
            '.ranked-war-list',
            '.f-war-list',
            '#faction-war-list',
            '#war-root',
            '.war-main',
            '.war-list',
            '[class*="warList"]',
            '[class*="rankedWar"]',
            '[class*="raidWar"]',
            '.enemy-faction',
        ];
        for (const sel of warDomIndicators) {
            if (document.querySelector(sel)) return true;
        }

        return false;
    }

    function detectPageAndInit() {
        const url = window.location.href;

        if (url.includes('loader.php?sid=attack')) {
            log('Page: Attack');
            initAttackPage();
        } else if (url.includes('factions.php') || url.includes('war.php')) {
            log('Page: Faction/War — showing activate button');
            showActivateButton();
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
        startCallPruner();
    }

    /** Initialise attack page enhancements. */
    function initAttackPage() {
        createAttackOverlay();
        startStatusTimers();

        // Report viewing target to server + refresh overlay
        const targetId = getAttackTargetId();
        if (targetId) {
            // Tell server we're on this attack page
            reportViewing(targetId);
            // Poll local state for overlay updates
            setInterval(() => updateAttackOverlay(targetId), 2000);
        }
    }

    /** Report to the server which target we're currently viewing. */
    function reportViewing(targetId) {
        if (!state.connected) return;
        postAction('/api/viewing', { targetId }).catch(() => {});
    }

    /** Clear viewing status when leaving the attack page. */
    function clearViewing() {
        if (!state.connected) return;
        postAction('/api/viewing', { targetId: null }).catch(() => {});
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
                        if (msg.priorities) state.priorities = { ...state.priorities, ...msg.priorities };
                        if (msg.statuses) state.statuses = { ...state.statuses, ...msg.statuses };
                        if (msg.chain) {
                            state.chain = { ...state.chain, ...msg.chain };
                            if (msg.chain.timeout != null) {
                                chainTimeoutSetAt = Date.now();
                                chainTimeoutSetVal = state.chain.timeout;
                            }
                            if (msg.chain.cooldown != null) {
                                chainCooldownSetAt = Date.now();
                                chainCooldownSetVal = state.chain.cooldown;
                            }
                        }
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
     * Used for events like "Target called" or "Chain approaching bonus".
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
                toast.style.background = 'var(--wb-idle-yellow)';
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

    // Notifications are now driven by the polling diff logic in pollOnce() (Section 6).

    // =========================================================================
    // SECTION 23: MEMBER ACTIVITY HEATMAP
    // =========================================================================

    const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    /** Fetch heatmap data from the server. Returns the heatmap object or {}. */
    async function fetchHeatmapData() {
        try {
            const url = `${CONFIG.SERVER_URL}/api/heatmap`;
            const res = await new Promise((resolve, reject) => {
                httpRequest({
                    method: 'GET',
                    url,
                    headers: { 'Authorization': `Bearer ${state.jwtToken}` },
                    onload(r) {
                        const d = safeParse(r.responseText);
                        if (r.status >= 200 && r.status < 300) resolve(d);
                        else reject(new Error((d && d.error) || `HTTP ${r.status}`));
                    },
                    onerror() { reject(new Error('Network error')); },
                });
            });
            return (res && res.heatmap) || {};
        } catch (e) {
            warn('Failed to fetch heatmap:', e.message);
            return {};
        }
    }

    /** Ask the server to reset heatmap data. */
    async function resetServerHeatmap() {
        try {
            await removeAction('/api/heatmap/remove');
        } catch (e) {
            warn('Failed to reset heatmap:', e.message);
            showToast('Failed to reset heatmap: ' + e.message, 'error');
        }
    }

    /**
     * Convert server UTC heatmap data to the user's local timezone.
     * Shifts day/hour buckets by the local UTC offset.
     */
    function utcHeatmapToLocal(utcData) {
        const localData = {};
        const offsetHours = -(new Date().getTimezoneOffset() / 60); // e.g. EDT = -4 → offset = -4

        for (let d = 0; d < 7; d++) {
            for (let h = 0; h < 24; h++) {
                const bucket = (utcData[d] && utcData[d][h]) || null;
                if (!bucket || bucket.samples === 0) continue;

                let localH = h + offsetHours;
                let localD = d;
                if (localH >= 24) { localH -= 24; localD = (localD + 1) % 7; }
                if (localH < 0) { localH += 24; localD = (localD + 6) % 7; }

                if (!localData[localD]) localData[localD] = {};
                if (!localData[localD][localH]) localData[localD][localH] = { total: 0, samples: 0 };
                localData[localD][localH].total += bucket.total;
                localData[localD][localH].samples += bucket.samples;
            }
        }
        return localData;
    }

    function createHeatmapButton() {
        if (document.getElementById('wb-heatmap-toggle')) return;
        const btn = document.createElement('button');
        btn.id = 'wb-heatmap-toggle';
        btn.className = 'wb-heatmap-btn';
        btn.textContent = '\uD83D\uDCCA';
        btn.title = 'Member Activity Heatmap';
        btn.style.display = 'block';
        btn.addEventListener('click', toggleHeatmapPanel);
        document.body.appendChild(btn);
    }

    function toggleHeatmapPanel() {
        const existing = document.getElementById('wb-heatmap-panel');
        if (existing) {
            existing.remove();
            return;
        }
        renderHeatmapPanel();
    }

    async function renderHeatmapPanel() {
        const existing = document.getElementById('wb-heatmap-panel');
        if (existing) existing.remove();

        const utcData = await fetchHeatmapData();
        const data = utcHeatmapToLocal(utcData);

        // Find max average for color scaling
        let maxAvg = 0;
        let totalSamples = 0;
        for (let d = 0; d < 7; d++) {
            for (let h = 0; h < 24; h++) {
                const bucket = (data[d] && data[d][h]) || { total: 0, samples: 0 };
                totalSamples += bucket.samples;
                if (bucket.samples > 0) {
                    const avg = bucket.total / bucket.samples;
                    if (avg > maxAvg) maxAvg = avg;
                }
            }
        }

        const panel = document.createElement('div');
        panel.id = 'wb-heatmap-panel';
        panel.className = 'wb-heatmap-panel';

        // Restore saved position
        const savedPos = GM_getValue('factionops_heatmap_pos', null);
        if (savedPos) {
            try {
                const pos = typeof savedPos === 'string' ? JSON.parse(savedPos) : savedPos;
                panel.style.left = pos.left + 'px';
                panel.style.top = pos.top + 'px';
            } catch (e) { /* ignore */ }
        }

        // Header
        const header = document.createElement('div');
        header.className = 'wb-heatmap-header';
        header.innerHTML = '<span>Member Activity Heatmap</span>';
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '\u00D7';
        closeBtn.className = 'wb-heatmap-close';
        closeBtn.addEventListener('click', () => panel.remove());
        header.appendChild(closeBtn);
        panel.appendChild(header);

        // Make panel draggable by header
        let isDragging = false, dragOffsetX = 0, dragOffsetY = 0;
        header.addEventListener('mousedown', (e) => {
            if (e.target === closeBtn) return;
            isDragging = true;
            dragOffsetX = e.clientX - panel.offsetLeft;
            dragOffsetY = e.clientY - panel.offsetTop;
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            panel.style.left = (e.clientX - dragOffsetX) + 'px';
            panel.style.top = (e.clientY - dragOffsetY) + 'px';
        });
        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                GM_setValue('factionops_heatmap_pos', JSON.stringify({
                    left: panel.offsetLeft,
                    top: panel.offsetTop,
                }));
            }
        });

        if (totalSamples === 0) {
            const msg = document.createElement('div');
            msg.style.cssText = 'padding:16px;font-size:12px;opacity:0.7;text-align:center;';
            msg.textContent = 'No activity data yet. The server collects data automatically when a faction API key is set.';
            panel.appendChild(msg);
            document.body.appendChild(panel);
            return;
        }

        // Grid container
        const grid = document.createElement('div');
        grid.className = 'wb-heatmap-grid';

        // Corner spacer
        const spacer = document.createElement('div');
        spacer.className = 'wb-heatmap-label';
        grid.appendChild(spacer);

        // Hour labels (every 3rd hour)
        for (let h = 0; h < 24; h++) {
            const lbl = document.createElement('div');
            lbl.className = 'wb-heatmap-label wb-heatmap-hour';
            lbl.textContent = h % 3 === 0 ? h : '';
            grid.appendChild(lbl);
        }

        // Rows
        for (let d = 0; d < 7; d++) {
            // Day label
            const dayLbl = document.createElement('div');
            dayLbl.className = 'wb-heatmap-label wb-heatmap-day';
            dayLbl.textContent = DAY_LABELS[d];
            grid.appendChild(dayLbl);

            for (let h = 0; h < 24; h++) {
                const cell = document.createElement('div');
                cell.className = 'wb-heatmap-cell';
                const bucket = (data[d] && data[d][h]) || { total: 0, samples: 0 };
                const avg = bucket.samples > 0 ? bucket.total / bucket.samples : 0;
                const intensity = maxAvg > 0 ? avg / maxAvg : 0;
                cell.style.backgroundColor = `rgba(0, 184, 148, ${(intensity * 0.9 + 0.1).toFixed(2)})`;
                if (bucket.samples === 0) cell.style.backgroundColor = 'rgba(255,255,255,0.05)';
                cell.title = `${DAY_LABELS[d]} ${String(h).padStart(2, '0')}:00 \u2014 Avg ${avg.toFixed(1)} members online (${bucket.samples} samples)`;
                grid.appendChild(cell);
            }
        }
        panel.appendChild(grid);

        // Footer
        const footer = document.createElement('div');
        footer.className = 'wb-heatmap-footer';
        footer.innerHTML = `<span style="font-size:11px;opacity:0.6;">Based on ${totalSamples} total samples</span>`;
        const resetBtn = document.createElement('button');
        resetBtn.className = 'wb-btn wb-btn-sm wb-btn-danger';
        resetBtn.textContent = 'Reset Data';
        resetBtn.addEventListener('click', async () => {
            await resetServerHeatmap();
            panel.remove();
            renderHeatmapPanel();
        });
        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'wb-btn wb-btn-sm';
        refreshBtn.textContent = 'Refresh';
        refreshBtn.addEventListener('click', () => {
            panel.remove();
            renderHeatmapPanel();
        });
        footer.appendChild(refreshBtn);
        footer.appendChild(resetBtn);
        panel.appendChild(footer);

        document.body.appendChild(panel);
    }

    // =========================================================================
    // SECTION 24: MAIN INITIALISATION
    // =========================================================================

    async function main() {
        log('Initialising FactionOps v2.1.0');
        if (IS_PDA) log('Torn PDA detected — using PDA-managed API key');

        // 1. Inject CSS
        injectStyles();

        // 2. Apply theme
        applyTheme();

        // 3. Create settings gear (skip on faction/war pages — overlay has its own button)
        const url = window.location.href;
        if (!url.includes('factions.php') && !url.includes('war.php')) {
            createSettingsGear();
        }

        // 3b. Create heatmap toggle button (skip on faction/war pages — overlay header has its own)
        if (!url.includes('factions.php') && !url.includes('war.php')) {
            createHeatmapButton();
        }

        // 4. Set up keyboard shortcuts
        setupKeyboardShortcuts();

        // 5. Set up tab coordination
        setupTabCoordination();

        // 6. Install fetch/XHR interceptors for passive data collection
        installFetchInterceptor();
        installXHRInterceptor();

        // 7. Authenticate and start polling
        if (CONFIG.API_KEY) {
            try {
                await authenticate();
                startPolling();
            } catch (e) {
                warn('Initial auth failed:', e.message);
                if (state.jwtToken) {
                    startPolling();
                } else {
                    showToast('Not configured — click the gear icon to set up', 'warning');
                }
            }
        } else {
            log('No API key configured — open settings to get started');
            showToast('FactionOps: Click the gear icon to configure', 'info');
        }

        // 8. Detect page type and initialise appropriate enhancements
        detectPageAndInit();

        // 9. Start call age visual feedback loop
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
        if (attackOverlay) {
            attackOverlay.remove();
            clearViewing(); // Tell server we left the attack page
        }

        // Remove FactionOps activate button and war overlay, restore hidden Torn elements
        const foBtn = document.getElementById('fo-activate-btn');
        if (foBtn) foBtn.remove();
        const foOverlay = document.getElementById('fo-overlay');
        if (foOverlay) foOverlay.remove();

        const hiddenEl = document.querySelector('[data-fo-hidden="true"]');
        if (hiddenEl) {
            hiddenEl.style.display = '';
            delete hiddenEl.dataset.foHidden;
        }

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
