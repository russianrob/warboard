// ==UserScript==
// @name         Organized Crime Analytics (tornwar fork)
// @namespace    tornwar.com
// @version      3.0.1-wb1
// @description  Tracks and analyzes organized crime scenarios with local caching, player stats, faction stats, and UI. Tornwar fork: hash-agnostic React selectors so Torn React deploys don't break the UI.
// @author       Allenone[2033011] (fork by RussianRob)
// @match        https://www.torn.com/factions.php?step=your*
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
// @license      MIT
// @downloadURL  https://tornwar.com/scripts/oc-analytics.user.js
// @updateURL    https://tornwar.com/scripts/oc-analytics.meta.js
// ==/UserScript==
//
// =============================================================================
// CHANGELOG (tornwar fork)
// =============================================================================
// 3.0.1-wb1 — UI fix for Torn React deploys.
//   Upstream v3.0.1 hardcoded React-mangled class names like
//   `.buttonsContainer___aClaa`, `.button___cwmLf`, `.active___ImR61`,
//   etc. Torn rehashes these on every React deploy, which silently
//   breaks the UI: tabs don't inject, content doesn't toggle, the
//   "active" highlight never moves.
//
//   This fork:
//     - Switches every literal `.foo___hashHash` selector to a
//       wildcard `[class*="foo___"]` query.
//     - Auto-detects Torn's CURRENT button class + icon classes from a
//       live tab button at inject time, so our injected tabs match
//       Torn's current theme exactly (whatever the hash happens to be).
//     - Auto-detects Torn's CURRENT active class from whichever tab
//       button is currently highlighted.
//     - Replaces `classList.contains('foo___hash')` checks with
//       startsWith-based scans.
//
//   The fetch intercept, scenario parsing, and analytics storage are
//   unchanged from upstream — those weren't broken; the data side of
//   Torn's OC system hasn't shifted.
// =============================================================================

(function() {
    'use strict';

    const TARGET_URL_BASE = 'page.php?sid=organizedCrimesData&step=crimeList';
    const OC_ROOT_SELECTOR = '#faction-crimes-root, #factionCrimes-root';

    function isPDA() {
        return typeof PDA_httpGet !== 'undefined';
    }

    // wb1: helpers for hash-agnostic class detection
    function findHashedClass(el, prefix) {
        if (!el || !el.classList) return '';
        return [...el.classList].find(c => c.startsWith(prefix + '___')) || '';
    }
    function hasHashedClass(el, prefix) {
        return !!findHashedClass(el, prefix);
    }
    function getOcRoot() {
        return document.querySelector(OC_ROOT_SELECTOR);
    }
    function getTabContainer() {
        const root = getOcRoot();
        if (root) {
            const scoped = root.querySelector('[class*="buttonsContainer___"]');
            if (scoped) return scoped;
        }
        return document.querySelector('[class*="buttonsContainer___"]');
    }
    function getCurrentActiveClass() {
        const container = getTabContainer();
        if (!container) return '';
        const activeBtn = container.querySelector('button[class*="active___"]');
        return activeBtn ? findHashedClass(activeBtn, 'active') : '';
    }
    function getTornButtonClasses() {
        const container = getTabContainer();
        if (!container) return { btn: '', iconContainer: '', iconWrapper: '' };
        const sampleBtn = container.querySelector('button');
        if (!sampleBtn) return { btn: '', iconContainer: '', iconWrapper: '' };
        return {
            btn: findHashedClass(sampleBtn, 'button'),
            iconContainer: findHashedClass(sampleBtn.querySelector('[class*="iconContainer___"]'), 'iconContainer'),
            iconWrapper: findHashedClass(sampleBtn.querySelector('[class*="iconWrapper___"]'), 'iconWrapper')
        };
    }

    let cachedScenarios = GM_getValue('cachedScenarios', {});
    let playerAnalytics = GM_getValue('playerAnalytics', {});
    let factioncut = GM_getValue('factioncut', 0);

    // One-time migration: strip submission-only fields from existing stored data
    (function migrateStorage() {
        const migrated = GM_getValue('_oca_migrated_v28', false);
        if (migrated) return;

        let scenariosDirty = false;
        Object.values(cachedScenarios).forEach(scenario => {
            if ('preRequisiteCrimeID' in scenario) { delete scenario.preRequisiteCrimeID; scenariosDirty = true; }
            if (scenario.scenario && 'scenes' in scenario.scenario) { delete scenario.scenario.scenes; scenariosDirty = true; }
        });
        if (scenariosDirty) GM_setValue('cachedScenarios', cachedScenarios);

        let analyticsDirty = false;
        Object.values(playerAnalytics).forEach(player => {
            if (Array.isArray(player.scenarios)) {
                player.scenarios.forEach(s => {
                    if ('role' in s) { delete s.role; analyticsDirty = true; }
                });
            }
        });
        if (analyticsDirty) GM_setValue('playerAnalytics', playerAnalytics);

        GM_deleteValue('submittedScenarios');
        GM_deleteValue('SUBMIT_TO_API');
        GM_deleteValue('processedScenarios');
        GM_setValue('_oca_migrated_v28', true);
    })();

    // Ensure all existing playerAnalytics entries have necessary fields
    Object.keys(playerAnalytics).forEach(playerId => {
        if (!Array.isArray(playerAnalytics[playerId].scenarios)) {
            playerAnalytics[playerId].scenarios = [];
        }
    });

    // Fetch Interception (Unchanged from upstream)
    const win = (unsafeWindow || window);
    const originalFetch = win.fetch;
    win.fetch = async function(resource, config) {
        const url = typeof resource === 'string' ? resource : resource.url;
        if (config?.method?.toUpperCase() !== 'POST' || !url.includes(TARGET_URL_BASE)) {
            return originalFetch.apply(this, arguments);
        }

        let isCompletedGroup = false;
        if (config?.body instanceof FormData) {
            isCompletedGroup = config.body.get('group') === 'Completed';
        } else if (config?.body) {
            isCompletedGroup = config.body.toString().includes('group=Completed');
        }

        if (!isCompletedGroup) {
            return originalFetch.apply(this, arguments);
        }

        const response = await originalFetch.apply(this, arguments);
        try {
            const json = JSON.parse(await response.clone().text());
            if (json.success && json.data) {
                json.data.forEach(scenario => {
                    const scenarioId = String(scenario.ID);
                    if (!(scenarioId in cachedScenarios)) {
                        processScenario(scenario);
                    }
                });
                GM_setValue('cachedScenarios', cachedScenarios);
                GM_setValue('playerAnalytics', playerAnalytics);
            }
        } catch (err) {
            console.error("Error processing fetch response:", err);
        }
        return response;
    };

    function replaceUserIdsWithNames(text, playerSlots) {
        let modifiedText = text;
        playerSlots.forEach(slot => {
            const userId = `userId-${slot.player.ID}`;
            modifiedText = modifiedText.replace(new RegExp(`\\b${userId}\\b`, 'gi'), slot.player.name);
        });
        return modifiedText;
    }

    function enhanceScenarioEvents(events, playerSlots) {
        return events.map((event, index, arr) => {
            const sanitizedKey = event.id.replace(/^\[|\]$/g, '');
            const enhanced = {
                key: sanitizedKey,
                text: replaceUserIdsWithNames(event.description, playerSlots),
                type: event.type
            };
            if (index > 0) {
                enhanced.previous = arr[index - 1].key;
            }
            return enhanced;
        });
    }

    function processScenario(scenario) {
        const scenarioId = String(scenario.ID);
        const enhancedEvents = enhanceScenarioEvents(scenario.scenario.scenes.map(scene => scene.dialogues[0]), scenario.playerSlots);
        const checkpointSetupPlayers = new Map();

        enhancedEvents.forEach(event => {
            if (event.key.includes('-C') && !event.key.match(/[PF]$/)) {
                const playersInvolved = scenario.playerSlots
                    .filter(slot => event.text.toLowerCase().includes(slot.player.name.toLowerCase()))
                    .map(slot => slot.player.name.trim());
                if (playersInvolved.length > 0) {
                    checkpointSetupPlayers.set(event.key, playersInvolved);
                }
            }
        });

        const numPlayers = scenario.playerSlots.length;
        const totalRespect = scenario.rewards?.faction?.respect || 0;
        const totalMoney = scenario.rewards?.faction?.moneyEquivalent || 0;
        const respectPerPlayer = numPlayers > 0 ? Math.round(totalRespect / numPlayers) : 0;
        const moneyPerPlayer = numPlayers > 0 ? Math.round(totalMoney / numPlayers) : 0;
        const isSuccessful = scenario.status === "Successful";
        const expiresAt = scenario.expiresAt * 1000;

        scenario.playerSlots.forEach(slot => {
            const playerId = slot.player.ID;
            const playerName = slot.player.name.trim();
            const stats = playerAnalytics[playerId] || {
                name: playerName,
                scenarios: []
            };

            const scenarioStats = {
                expiresAt,
                successfulScenarios: isSuccessful ? 1 : 0,
                failedScenarios: isSuccessful ? 0 : 1,
                successfulCheckpoints: 0,
                failedCheckpoints: 0,
                injuries: slot.outcome === 'Hospitalized' ? 1 : 0,
                jailed: slot.outcome === 'Jailed' ? 1 : 0,
                totalRespect: respectPerPlayer,
                totalMoney: moneyPerPlayer,
                scenarioName: scenario.scenario.name
            };

            enhancedEvents.forEach(event => {
                if (event.key.includes('C') && (event.key.endsWith('P') || event.key.endsWith('F'))) {
                    let responsiblePlayers = [];
                    if (event.text.toLowerCase().includes(playerName.toLowerCase())) {
                        responsiblePlayers = [playerName];
                    } else {
                        const setupKey = event.key.slice(0, -1);
                        responsiblePlayers = checkpointSetupPlayers.get(setupKey) || [];
                    }
                    if (responsiblePlayers.includes(playerName)) {
                        if (event.key.endsWith('P')) scenarioStats.successfulCheckpoints += 1;
                        else if (event.key.endsWith('F')) scenarioStats.failedCheckpoints += 1;
                    }
                }
            });

            stats.scenarios.push(scenarioStats);
            playerAnalytics[playerId] = stats;
        });

        cachedScenarios[scenarioId] = {
            ID: scenario.ID,
            status: scenario.status,
            expiresAt: scenario.expiresAt,
            playerSlots: scenario.playerSlots.map(slot => ({
                key: slot.key,
                player: { ID: slot.player.ID, name: slot.player.name, successChance: slot.successChance },
                outcome: slot.outcome,
                role: slot.name
            })),
            rewards: scenario.rewards ? { faction: scenario.rewards.faction } : { faction: {} },
            scenario: {
                name: scenario.scenario.name,
                level: scenario.scenario.level
            }
        };
    }

    function injectStatsUI() {
        const style = document.createElement('style');
        style.textContent = `
        .oca-stats-section, .oca-faction-stats-section { display: none; }
        .oca-container { padding: 20px; }
        .oca-title-wrapper { background: rgb(42, 42, 42); border-radius: 8px; padding: 10px 20px; }
        .oca-title { font-size: 24px; font-weight: bold; color: #fff; text-align: center; }
        .oca-content-wrapper { background: #333; border-radius: 8px; margin-top: 20px; padding: 20px; }
        .oca-header { margin-bottom: 20px; }
        .oca-header h2 { font-size: 20px; color: #ddd; margin: 0 0 15px 0; text-align: center !important; }
        .oca-controls { display: flex; gap: 20px; align-items: center; flex-wrap: wrap; }
        .oca-controls label { color: #ccc; font-weight: bold; }
        .oca-select-container { min-width: 150px; }
        .oca-select-container select { width: 100%; padding: 8px; border-radius: 4px; background: #444; color: #fff; border: 1px solid #666; }
        .oca-button-container button { padding: 8px 16px; background: #555; color: #fff; border: 1px solid #777; border-radius: 4px; cursor: pointer; }
        .oca-button-container button:hover { background: #666; }
        .oca-stats-display { background: #2a2a2a; padding: 20px; border-radius: 8px; }
        .oca-stats-display p { margin: 0 0 10px; color: #ddd; font-size: 16px; }
        .oca-stats-display p:last-child { margin-bottom: 0; }
        .oca-stats-display strong { color: #fff; }
        .oca-stats-display h3 { margin-top: 20px; margin-bottom: 10px; border-bottom: 1px solid #555; padding-bottom: 5px; font-size: 18px; }
        .oca-stats-display table { width: 100%; border-collapse: collapse; color: #ddd; margin-top: 10px; margin-bottom: 20px; }
        .oca-stats-display th, .oca-stats-display td { padding: 8px !important; border: 1px solid #555 !important; text-align: left; }
        .oca-stats-display th { background: #444; font-weight: bold; }
        .oca-stats-display table td[data-player-id] { cursor: pointer; }
        .sortable { cursor: pointer; }
        .sortable:hover { background: #666; text-decoration: underline; }
        .oca-stats-display table, .oca-stats-display th, .oca-stats-display td { color: #fff; }
        .oca-two-column-layout { display: flex; justify-content: space-between; gap: 20px; margin-bottom: 20px; }
        .oca-column { flex: 1; min-width: 0; }
        .oca-oc-list, .oca-items-list { list-style: none; margin: 0; padding: 10px; background: #2a2a2a; border: 1px solid #555; border-radius: 4px; color: #ddd; font-size: 14px; line-height: 1.5; }
        .oca-oc-list li, .oca-items-list li { padding: 5px 0; border-bottom: 1px solid #444; }
        .oca-oc-list li:last-child, .oca-items-list li:last-child { border-bottom: none; }
        @media (max-width: 768px) {
            .oca-container { padding: 10px; }
            .oca-title { font-size: 20px; }
            .oca-header h2 { font-size: 18px; }
            .oca-controls { flex-direction: column; align-items: stretch; }
            .oca-select-container, .oca-button-container { width: 100%; margin-bottom: 10px; }
            .oca-stats-display { padding: 10px; }
            .oca-stats-display table { width: 100%; overflow-x: auto; display: block; }
            .oca-two-column-layout { flex-direction: column; gap: 15px; }
            .oca-column { width: 100%; }
            .oca-controls input[type="number"] { width: 100%; }
        }
        #oca-tab-row { display: flex; width: 100%; box-sizing: border-box; }
        #oca-tab-row button { flex: 1; }
        .oca-pda .oca-container { padding: 10px; }
        .oca-pda .oca-title { font-size: 20px; }
        .oca-pda .oca-header h2 { font-size: 18px; }
        .oca-pda .oca-controls { flex-direction: column; align-items: stretch; }
        .oca-pda .oca-select-container { width: 100%; margin-bottom: 10px; }
        .oca-pda .oca-stats-display { padding: 10px; }
        .oca-pda .oca-stats-display table { width: 100%; overflow-x: auto; display: block; }
        .oca-pda .oca-two-column-layout { flex-direction: column; gap: 15px; }
        .oca-pda .oca-column { width: 100%; }
        .oca-pda .oca-controls select,
        .oca-pda .oca-controls input[type="number"] { min-height: 44px; font-size: 16px; width: 100%; box-sizing: border-box; }
        .oca-pda .oca-stats-display th,
        .oca-pda .oca-stats-display td { font-size: 13px; padding: 10px 6px !important; }
    `;
        if (!document.head.querySelector('style[data-oc-analytics]')) {
            style.setAttribute('data-oc-analytics', 'true');
            document.head.appendChild(style);
        }

        const tabContainer = getTabContainer();
        if (tabContainer && !document.getElementById('oca-stats-tab-btn')) {
            const tornClasses = getTornButtonClasses();
            const btnCls = tornClasses.btn || '';
            const iconCls = tornClasses.iconContainer || '';
            const iconWrapCls = tornClasses.iconWrapper || '';

            const statsTabBtn = document.createElement('button');
            statsTabBtn.id = 'oca-stats-tab-btn';
            statsTabBtn.className = `${btnCls} oca-stats-tab`.trim();
            statsTabBtn.innerHTML = `<span class="${iconCls}"><span class="${iconWrapCls}"></span></span>Player Statistics`;

            const factionStatsTabBtn = document.createElement('button');
            factionStatsTabBtn.id = 'oca-faction-stats-tab-btn';
            factionStatsTabBtn.className = `${btnCls} oca-stats-tab`.trim();
            factionStatsTabBtn.innerHTML = `<span class="${iconCls}"><span class="${iconWrapCls}"></span></span>Faction Statistics`;

            if (isPDA()) {
                let ocaTabRow = document.getElementById('oca-tab-row');
                if (!ocaTabRow) {
                    ocaTabRow = document.createElement('div');
                    ocaTabRow.id = 'oca-tab-row';
                    tabContainer.parentElement.insertBefore(ocaTabRow, tabContainer.nextSibling);
                }
                ocaTabRow.appendChild(statsTabBtn);
                ocaTabRow.appendChild(factionStatsTabBtn);
            } else {
                tabContainer.appendChild(statsTabBtn);
                tabContainer.appendChild(factionStatsTabBtn);
            }
        }
        return !!tabContainer;
    }

    function switchToPlayerStats(playerId) {
        const playerSelect = document.getElementById('ocaPlayerSelect');
        playerSelect.value = playerId;
        const playerStatsTabBtn = document.getElementById('oca-stats-tab-btn');
        playerStatsTabBtn.click();
    }

    function markContentArea() {
        const root = getOcRoot();
        const scope = root || document;
        const wrapper = scope.querySelector('[class*="wrapper___"]');
        if (wrapper) {
            let contentArea = wrapper.parentElement;
            if (!contentArea.id) {
                contentArea.id = 'oc-content-area';
            }
            return contentArea;
        }
        return null;
    }

    function getContentArea() {
        let contentArea = document.getElementById('oc-content-area');
        if (!contentArea) {
            contentArea = markContentArea();
        }
        return contentArea;
    }

    function initializeStats() {
        const statsTabBtn = document.getElementById('oca-stats-tab-btn');
        const factionStatsTabBtn = document.getElementById('oca-faction-stats-tab-btn');
        const contentArea = getContentArea();
        if (!statsTabBtn || !factionStatsTabBtn || !contentArea) return;

        let statsSection = contentArea.querySelector('.oca-stats-section');
        if (!statsSection) {
            statsSection = document.createElement('div');
            statsSection.className = 'oca-stats-section';
            statsSection.style.display = 'none';
            statsSection.innerHTML = `
            <div class="oca-container">
                <div class="oca-title-wrapper">
                    <div class="oca-title">Player Analytics Dashboard</div>
                </div>
                <div class="oca-content-wrapper">
                    <div class="oca-header">
                        <div class="oca-controls" id="ocaControls">
                            <label for="ocaPlayerSelect">Player:</label>
                            <div class="oca-select-container" id="playerSelectContainer"></div>
                            <label for="ocaTimePeriod">Time Period:</label>
                            <div class="oca-select-container" id="timePeriodContainer"></div>
                        </div>
                    </div>
                    <div id="ocaStatsDisplay" class="oca-stats-display"></div>
                </div>
            </div>
        `;
            contentArea.appendChild(statsSection);
        }

        let factionStatsSection = contentArea.querySelector('.oca-faction-stats-section');
        if (!factionStatsSection) {
            factionStatsSection = document.createElement('div');
            factionStatsSection.className = 'oca-faction-stats-section';
            factionStatsSection.style.display = 'none';
            factionStatsSection.innerHTML = `
            <div class="oca-container">
                <div class="oca-title-wrapper">
                    <div class="oca-title">Faction Analytics Dashboard</div>
                </div>
                <div class="oca-content-wrapper">
                    <div class="oca-header">
                        <div class="oca-controls">
                            <label for="ocaFactionTimePeriod">Time Period:</label>
                            <div class="oca-select-container" id="factionTimePeriodContainer"></div>
                        </div>
                    </div>
                    <div id="ocaFactionStatsDisplay" class="oca-stats-display"></div>
                </div>
            </div>
        `;
            contentArea.appendChild(factionStatsSection);
        }

        if (isPDA()) {
            statsSection.classList.add('oca-pda');
            factionStatsSection.classList.add('oca-pda');
        }

        const playerSelectContainer = document.getElementById('playerSelectContainer');
        let playerSelect = document.getElementById('ocaPlayerSelect');
        let timePeriod = document.getElementById('ocaTimePeriod');

        if (!playerSelect) {
            playerSelect = document.createElement('select');
            playerSelect.id = 'ocaPlayerSelect';
            playerSelectContainer.appendChild(playerSelect);

            timePeriod = document.createElement('select');
            timePeriod.id = 'ocaTimePeriod';
            timePeriod.innerHTML = `
            <option value="7">Last 7 Days</option>
            <option value="30">Last 30 Days</option>
            <option value="90">Last 90 Days</option>
            <option value="all" selected>All Time</option>
        `;
            document.getElementById('timePeriodContainer').appendChild(timePeriod);

            playerSelect.addEventListener('change', () => {
                const selectedPlayerId = playerSelect.value;
                GM_setValue('lastSelectedPlayer', selectedPlayerId);
                updateStats();
            });
            timePeriod.addEventListener('change', updateStats);
        }

        playerSelect.innerHTML = '';
        const sortedPlayers = Object.entries(playerAnalytics).sort((a, b) =>
                                                                   a[1].name.localeCompare(b[1].name)
                                                                  );
        sortedPlayers.forEach(([id, stats]) => {
            const option = document.createElement('option');
            option.value = id;
            option.textContent = stats.name;
            playerSelect.appendChild(option);
        });

        const lastSelectedPlayer = GM_getValue('lastSelectedPlayer');
        if (lastSelectedPlayer && playerAnalytics[lastSelectedPlayer]) {
            playerSelect.value = lastSelectedPlayer;
        } else if (sortedPlayers.length > 0) {
            playerSelect.value = sortedPlayers[0][0];
        }

        const factionTimePeriodContainer = document.getElementById('factionTimePeriodContainer');
        let factionTimePeriod = document.getElementById('ocaFactionTimePeriod');
        if (!factionTimePeriod) {
            factionTimePeriod = document.createElement('select');
            factionTimePeriod.id = 'ocaFactionTimePeriod';
            factionTimePeriod.innerHTML = `
            <option value="7">Last 7 Days</option>
            <option value="30">Last 30 Days</option>
            <option value="90">Last 90 Days</option>
            <option value="all" selected>All Time</option>
        `;
            factionTimePeriodContainer.appendChild(factionTimePeriod);
            factionTimePeriod.addEventListener('change', updateFactionStats);
        }

        const factionControls = factionStatsSection.querySelector('.oca-controls');
        if (!factionControls.querySelector('#ocaFactionCut')) {
            const factionCutLabel = document.createElement('label');
            factionCutLabel.htmlFor = 'ocaFactionCut';
            factionCutLabel.textContent = 'Faction Cut: ';
            factionCutLabel.style.color = '#ccc';
            factionCutLabel.style.fontWeight = 'bold';

            const factionCutInput = document.createElement('input');
            factionCutInput.type = 'number';
            factionCutInput.id = 'ocaFactionCut';
            factionCutInput.min = '0';
            factionCutInput.max = '100';
            factionCutInput.value = factioncut;
            factionCutInput.style.width = '60px';
            factionCutInput.style.padding = '8px';
            factionCutInput.style.marginLeft = '5px';
            factionCutInput.style.borderRadius = '4px';
            factionCutInput.style.background = '#444';
            factionCutInput.style.color = '#fff';
            factionCutInput.style.border = '1px solid #666';
            factionCutInput.addEventListener('change', () => {
                factioncut = parseInt(factionCutInput.value) || 0;
                if (factioncut > 100) factioncut = 100;
                if (factioncut < 0) factioncut = 0;
                GM_setValue('factioncut', factioncut);
                updateFactionStats();
                updateStats();
            });

            factionControls.appendChild(factionCutLabel);
            factionControls.appendChild(factionCutInput);
        }

        // wb1: hash-agnostic tab queries
        const tabContainer = getTabContainer();
        const tornTabs = tabContainer ? tabContainer.querySelectorAll('button') : [];
        const ocaTabs = document.querySelectorAll('#oca-tab-row button');
        const tabs = [...tornTabs, ...ocaTabs];

        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                // wb1: detect Torn's CURRENT active class on every click
                // (it might change across React deploys, and detecting
                // it fresh on each click is robust even mid-session)
                const activeCls = getCurrentActiveClass();
                if (activeCls) {
                    tabs.forEach(t => t.classList.remove(activeCls));
                    tab.classList.add(activeCls);
                }

                const allChildren = contentArea.children;
                for (let child of allChildren) {
                    child.style.display = 'none';
                }

                const root = getOcRoot() || document;
                const manualSpawner = root.querySelector('[class*="manualSpawnerContainer___"]');
                const notInvolvedMembers = root.querySelector('[class*="notInvolvedMembers___"]');
                const hrBefore = contentArea.previousElementSibling;
                const hrAfter = contentArea.nextElementSibling;
                const allWrappers = contentArea.querySelectorAll('[class*="wrapper___"]');

                if (tab.id === 'oca-stats-tab-btn') {
                    statsSection.style.display = 'block';
                    updateStats();
                    if (manualSpawner) manualSpawner.style.display = 'none';
                    if (notInvolvedMembers) notInvolvedMembers.style.display = 'none';
                    if (hrBefore && hrBefore.tagName === 'HR') hrBefore.style.display = 'none';
                    if (hrAfter && hrAfter.tagName === 'HR') hrAfter.style.display = 'none';
                } else if (tab.id === 'oca-faction-stats-tab-btn') {
                    factionStatsSection.style.display = 'block';
                    updateFactionStats();
                    if (manualSpawner) manualSpawner.style.display = 'none';
                    if (notInvolvedMembers) notInvolvedMembers.style.display = 'none';
                    if (hrBefore && hrBefore.tagName === 'HR') hrBefore.style.display = 'none';
                    if (hrAfter && hrAfter.tagName === 'HR') hrAfter.style.display = 'none';
                } else {
                    if (manualSpawner) manualSpawner.style.display = '';
                    if (notInvolvedMembers) notInvolvedMembers.style.display = '';
                    if (hrBefore && hrBefore.tagName === 'HR') hrBefore.style.display = '';
                    if (hrAfter && hrAfter.tagName === 'HR') hrAfter.style.display = '';

                    allWrappers.forEach(wrapper => {
                        if (!wrapper.closest('.oca-stats-section') && !wrapper.closest('.oca-faction-stats-section')) {
                            if (tab.textContent === 'Planning' || tab.textContent === 'Recruiting') {
                                wrapper.style.display = 'block';
                            } else if (tab.textContent === 'Completed' && !hasHashedClass(wrapper, 'planning')) {
                                wrapper.style.display = 'block';
                            } else {
                                wrapper.style.display = 'none';
                            }
                        }
                    });
                }
            });
        });

        if (hasHashedClass(statsTabBtn, 'active')) {
            statsSection.style.display = 'block';
            updateStats();
        } else if (hasHashedClass(factionStatsTabBtn, 'active')) {
            factionStatsSection.style.display = 'block';
            updateFactionStats();
        }
    }

    function getFilteredStats(playerId, days) {
        const stats = playerAnalytics[playerId] || {
            name: 'Unknown',
            scenarios: []
        };

        const cutoff = days === 'all' ? 0 : Date.now() - (parseInt(days) * 24 * 60 * 60 * 1000);
        const filteredScenarios = stats.scenarios.filter(scenario => scenario.expiresAt >= cutoff);

        const aggregatedStats = {
            name: stats.name,
            totalScenarios: 0,
            successfulScenarios: 0,
            failedScenarios: 0,
            totalCheckpoints: 0,
            successfulCheckpoints: 0,
            failedCheckpoints: 0,
            injuries: 0,
            jailed: 0,
            totalRespect: 0,
            totalMoney: 0,
            scenarioParticipation: {}
        };

        filteredScenarios.forEach(scenario => {
            aggregatedStats.totalScenarios += 1;
            aggregatedStats.successfulScenarios += scenario.successfulScenarios;
            aggregatedStats.failedScenarios += scenario.failedScenarios;
            aggregatedStats.totalCheckpoints += (scenario.successfulCheckpoints + scenario.failedCheckpoints);
            aggregatedStats.successfulCheckpoints += scenario.successfulCheckpoints;
            aggregatedStats.failedCheckpoints += scenario.failedCheckpoints;
            aggregatedStats.injuries += scenario.injuries;
            aggregatedStats.jailed += scenario.jailed;
            aggregatedStats.totalRespect += scenario.totalRespect;
            aggregatedStats.totalMoney += scenario.totalMoney;
            aggregatedStats.scenarioParticipation[scenario.scenarioName] =
                (aggregatedStats.scenarioParticipation[scenario.scenarioName] || 0) + 1;
        });

        return aggregatedStats;
    }

    function updateStats() {
        const statsDisplay = document.getElementById('ocaStatsDisplay');
        const selectedPlayerId = document.getElementById('ocaPlayerSelect').value;
        const days = document.getElementById('ocaTimePeriod').value;
        const stats = getFilteredStats(selectedPlayerId, days);

        const playerScenarios = Object.values(cachedScenarios).filter(scenario =>
                                                                      scenario.status === 'Successful' && scenario.playerSlots.some(slot => slot.player.ID == selectedPlayerId)
                                                                     );

        let highestOC = { level: 0, role: '', successChance: 0 };
        playerScenarios.forEach(scenario => {
            if (scenario.scenario.level > highestOC.level) {
                const playerSlot = scenario.playerSlots.find(slot => slot.player.ID == selectedPlayerId);
                highestOC = {
                    name: scenario.scenario.name,
                    level: scenario.scenario.level,
                    role: playerSlot.role,
                    successChance: playerSlot.player.successChance || 0
                };
            }
        });

        statsDisplay.innerHTML = `
            <p><strong>Name:</strong> ${stats.name}</p>
            <p><strong>Total Scenarios:</strong> ${stats.totalScenarios}</p>
            <p><strong>Successful Scenarios:</strong> ${stats.successfulScenarios} ( ${stats.totalScenarios > 0 ? Math.round((stats.successfulScenarios / stats.totalScenarios) * 100) : 0}% )</p>
            <p><strong>Failed Scenarios:</strong> ${stats.failedScenarios} ( ${stats.totalScenarios > 0 ? Math.round((stats.failedScenarios / stats.totalScenarios) * 100) : 0}% )</p>
            <p><strong>Successful Checkpoints:</strong> ${stats.successfulCheckpoints} ( ${stats.totalCheckpoints > 0 ? Math.round((stats.successfulCheckpoints / stats.totalCheckpoints) * 100) : 0}% )</p>
            <p><strong>Failed Checkpoints:</strong> ${stats.failedCheckpoints} ( ${stats.totalCheckpoints > 0 ? Math.round((stats.failedCheckpoints / stats.totalCheckpoints) * 100) : 0}% )</p>
            <p><strong>Injuries:</strong> ${stats.injuries}</p>
            <p><strong>Jailed:</strong> ${stats.jailed}</p>
            <p><strong>Total Respect Earned:</strong> ${stats.totalRespect.toLocaleString()}</p>
            <p><strong>Total Money Earned:</strong> $${(stats.totalMoney * ((100-factioncut)/100)).toLocaleString()}</p>
            <p><strong>Most Common Scenario:</strong> ${Object.entries(stats.scenarioParticipation || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || 'None'}</p>
            <p><strong>Highest OC Completed:</strong> <span title="Role: ${highestOC.role}, Success Chance: ${highestOC.successChance}%">Level ${highestOC.level} : ${highestOC.name}</span></p>
        `;
    }

    function getFactionStats(days) {
        const cutoff = days === 'all' ? 0 : Date.now() - (parseInt(days) * 24 * 60 * 60 * 1000);
        const filteredScenarios = Object.values(cachedScenarios).filter(scenario => {
            const expiresAt = scenario.expiresAt * 1000;
            return expiresAt >= cutoff;
        });

        let totalMoney = 0;
        let totalRespect = 0;
        const ocCounts = {};
        const itemCounts = {};
        let totalScenarios = filteredScenarios.length;
        let successfulScenarios = 0;

        const ocLevelMap = {};
        const playerScenarioMap = {};
        filteredScenarios.forEach(scenario => {
            const ocName = scenario.scenario.name;
            ocLevelMap[ocName] = scenario.scenario.level;
            if (!ocCounts[ocName]) {
                ocCounts[ocName] = { total: 0, successful: 0 };
            }
            ocCounts[ocName].total += 1;

            if (scenario.status === 'Successful') {
                totalMoney += scenario.rewards?.faction?.moneyEquivalent || 0;
                totalRespect += scenario.rewards?.faction?.respect || 0;
                ocCounts[ocName].successful += 1;
                successfulScenarios += 1;

                if (scenario.rewards?.faction?.items) {
                    scenario.rewards.faction.items.forEach(item => {
                        itemCounts[item.name] = (itemCounts[item.name] || 0) + item.quantity;
                    });
                }

                scenario.playerSlots.forEach(slot => {
                    const id = slot.player.ID;
                    if (!playerScenarioMap[id]) playerScenarioMap[id] = [];
                    playerScenarioMap[id].push(scenario);
                });
            }
        });

        const successRate = totalScenarios > 0 ? Math.round((successfulScenarios / totalScenarios) * 100) : 0;

        const playerData = {};
        Object.entries(playerAnalytics).forEach(([id, stats]) => {
            const playerStats = getFilteredStats(id, days);
            const successfulPlayerScenarios = playerScenarioMap[id] || [];

            let level = 0;
            if (successfulPlayerScenarios.length > 0) {
                level = successfulPlayerScenarios.reduce((max, scenario) =>
                    scenario.scenario.level > max ? scenario.scenario.level : max, 0);
            }

            playerData[id] = {
                level,
                successChance: playerStats.totalScenarios > 0
                    ? Math.round((playerStats.successfulScenarios / playerStats.totalScenarios) * 100)
                    : 0,
                totalRespect: playerStats.totalRespect,
                totalMoney: playerStats.totalMoney
            };
        });

        return { totalMoney, totalRespect, ocCounts, ocLevelMap, playerData, itemCounts, totalScenarios, successfulScenarios, successRate };
    }

    function updateFactionStats() {
        const factionStatsDisplay = document.getElementById('ocaFactionStatsDisplay');
        if (!factionStatsDisplay) return;

        const days = document.getElementById('ocaFactionTimePeriod').value;
        const stats = getFactionStats(days);

        let playerTableData = Object.entries(stats.playerData).map(([id, data]) => ({
            id,
            name: playerAnalytics[id]?.name || 'Unknown',
            level: data.level,
            successChance: data.successChance,
            totalRespect: data.totalRespect,
            totalMoney: data.totalMoney * ((100 - factioncut) / 100)
        }));

        playerTableData.sort((a, b) => a.name.localeCompare(b.name));

        function renderPlayerTable() {
            return `
            <table>
                <thead>
                    <tr>
                        <th class="sortable" data-sort="name">Player</th>
                        <th class="sortable" data-sort="level">Highest OC Level</th>
                        <th class="sortable" data-sort="successChance">Success Rate (%)</th>
                        <th class="sortable" data-sort="totalRespect">Total Respect Earned</th>
                        <th class="sortable" data-sort="totalMoney">Total Money Earned</th>
                    </tr>
                </thead>
                <tbody>
                    ${playerTableData.map(player => `
                        <tr>
                            <td data-player-id="${player.id}">${player.name}</td>
                            <td>${player.level}</td>
                            <td>${player.successChance}</td>
                            <td>${player.totalRespect.toLocaleString()}</td>
                            <td>$${player.totalMoney.toLocaleString()}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
        }

        function renderCompletedOCs() {
            const ocEntries = Object.entries(stats.ocCounts).map(([ocName, counts]) => {
                const successRate = counts.total > 0 ? Math.round((counts.successful / counts.total) * 100) : 0;
                const level = stats.ocLevelMap[ocName] || 0;
                return { ocName, count: counts.successful, total: counts.total, successRate, level };
            });

            ocEntries.sort((a, b) => b.level - a.level);

            return `
            <ul class="oca-oc-list">${ocEntries.map(entry => `
                <li>${entry.ocName}: ${entry.count} / ${entry.total} (${entry.successRate}% Success)</li>
            `).join('')}</ul>
        `;
        }

        function renderItemsEarned() {
            const itemEntries = Object.entries(stats.itemCounts).map(([itemName, count]) => `<li>${itemName}: ${count}</li>`);
            return itemEntries.length > 0 ? `<ul class="oca-items-list">${itemEntries.join('')}</ul>` : '';
        }

        factionStatsDisplay.innerHTML = `
        <div class="oca-two-column-layout">
            <div class="oca-column">
                <p><strong>OCs Completed:</strong> ${stats.totalScenarios} (${stats.successRate}% success)</p>
                <p><strong>Total Money Earned:</strong> $${stats.totalMoney.toLocaleString()}</p>
                <p><strong>Total Respect Earned:</strong> ${stats.totalRespect.toLocaleString()}</p>
            </div>
            <div class="oca-column"></div>
        </div>
        <h3 style='text-align:center!important; margin-top: 2px;'>Completed OCs & Items Earned</h3>
        <div class="oca-two-column-layout">
            <div class="oca-column">${renderCompletedOCs()}</div>
            <div class="oca-column">${renderItemsEarned()}</div>
        </div>
        <h3 style='text-align:center!important;'>Player Performance Overview</h3>
        ${renderPlayerTable()}
    `;

        if (!factionStatsDisplay.dataset.clickListenerAdded) {
            factionStatsDisplay.addEventListener('click', (event) => {
                const td = event.target.closest('td[data-player-id]');
                if (td) {
                    const playerId = td.getAttribute('data-player-id');
                    switchToPlayerStats(playerId);
                }
            });
            factionStatsDisplay.dataset.clickListenerAdded = 'true';
        }

        document.querySelectorAll('#ocaFactionStatsDisplay .sortable').forEach(header => {
            header.addEventListener('click', () => {
                const sortKey = header.getAttribute('data-sort');
                const ascending = !header.classList.contains('asc');
                playerTableData.sort((a, b) => {
                    if (sortKey === 'name') {
                        return ascending ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
                    } else {
                        return ascending ? a[sortKey] - b[sortKey] : b[sortKey] - a[sortKey];
                    }
                });
                const tableBody = factionStatsDisplay.querySelector('table tbody');
                tableBody.innerHTML = playerTableData.map(player => `
                <tr>
                    <td data-player-id="${player.id}">${player.name}</td>
                    <td>${player.level}</td>
                    <td>${player.successChance}</td>
                    <td>${player.totalRespect.toLocaleString()}</td>
                    <td>$${player.totalMoney.toLocaleString()}</td>
                </tr>
            `).join('');
                factionStatsDisplay.querySelectorAll('.sortable').forEach(h => h.classList.remove('asc', 'desc'));
                header.classList.add(ascending ? 'asc' : 'desc');
            });
        });
    }

    function observeDOM() {
        const rootNode = getOcRoot() || document.body;
        let observer;

        function checkAndInitialize() {
            if (!window.location.hash.includes('#/tab=crimes')) return false;

            const tabContainer = getTabContainer();
            if (tabContainer && !document.getElementById('oca-stats-tab-btn')) {
                if (!injectStatsUI()) return false;
            }

            const statsTab = document.getElementById('oca-stats-tab-btn');
            const factionStatsTab = document.getElementById('oca-faction-stats-tab-btn');
            const root = getOcRoot() || document;
            const wrapper = root.querySelector('[class*="wrapper___"]');

            if (statsTab && factionStatsTab && tabContainer && wrapper && !wrapper.classList.contains('oc-stats-processed')) {
                markContentArea();
                initializeStats();
                wrapper.classList.add('oc-stats-processed');
                return true;
            }
            return false;
        }

        if (observer) observer.disconnect();

        observer = new MutationObserver(() => {
            checkAndInitialize();
        });

        observer.observe(rootNode, {
            childList: true,
            subtree: true
        });

        checkAndInitialize();
    }

    if (document.readyState === 'complete') {
        observeDOM();
    } else {
        window.addEventListener('load', observeDOM);
    }
})();
