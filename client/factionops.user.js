// ==UserScript==
// @name         FactionOps - Faction War Coordinator
// @namespace    https://tornwar.com
// @version      1.1.1
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

    /**
     * Load Socket.IO client library by injecting a <script> tag pointing to
     * the CDN.  Returns a promise that resolves once `window.io` is available.
     */
    function loadSocketIO() {
        return new Promise((resolve, reject) => {
            if (typeof window.io === 'function') {
                log('Socket.IO already loaded');
                return resolve();
            }

            log('Loading Socket.IO from CDN...');

            if (IS_PDA) {
                // PDA: Load via direct <script> tag — PDA's webview allows this
                const script = document.createElement('script');
                script.src = 'https://cdn.socket.io/4.7.5/socket.io.min.js';
                script.onload = () => {
                    if (typeof window.io === 'function') {
                        log('Socket.IO loaded successfully (PDA)');
                        resolve();
                    } else {
                        reject(new Error('Socket.IO loaded but window.io not found'));
                    }
                };
                script.onerror = () => reject(new Error('Failed to load Socket.IO via script tag'));
                document.head.appendChild(script);
                return;
            }

            // Desktop: Use GM_xmlhttpRequest to fetch then blob-inject.
            // This avoids CSP issues that a direct CDN <script> might
            // encounter on Torn.
            GM_xmlhttpRequest({
                method: 'GET',
                url: 'https://cdn.socket.io/4.7.5/socket.io.min.js',
                onload(res) {
                    if (res.status !== 200) {
                        return reject(new Error(`Failed to load Socket.IO: HTTP ${res.status}`));
                    }
                    try {
                        const blob = new Blob([res.responseText], { type: 'application/javascript' });
                        const blobUrl = URL.createObjectURL(blob);
                        const script = document.createElement('script');
                        script.src = blobUrl;
                        script.onload = () => {
                            URL.revokeObjectURL(blobUrl);
                            if (typeof window.io === 'function') {
                                log('Socket.IO loaded successfully');
                                resolve();
                            } else {
                                reject(new Error('Socket.IO loaded but window.io not found'));
                            }
                        };
                        script.onerror = () => {
                            URL.revokeObjectURL(blobUrl);
                            reject(new Error('Script injection failed'));
                        };
                        document.head.appendChild(script);
                    } catch (e) {
                        reject(e);
                    }
                },
                onerror(err) {
                    reject(new Error('GM_xmlhttpRequest failed: ' + String(err)));
                },
            });
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
