// ==UserScript==
// @name         Torn OC Loan Manager (PDA)
// @namespace    https://torn.com
// @version      2.0.7-pda
// @description  Highlights over-loaned items, helps loan missing OC items (tools, drugs, medical, temporary, clothing, armor), tracks unpaid OC payouts (PDA compatible)
// @match        https://www.torn.com/factions.php?step=your*
// @run-at       document-end
// @downloadURL  https://tornwar.com/scripts/torn-oc-loan-manager-pda.user.js
// @updateURL    https://tornwar.com/scripts/torn-oc-loan-manager-pda.meta.js
// ==/UserScript==
// =============================================================================
// CHANGELOG
// =============================================================================
// v2.0.7-pda - Add support for clothing and armor (e.g. Construction Helmet) in armory categories
// v2.0.6-pda - Fix: Payouts now detects item-reward OCs (e.g. Xanax payouts), not just cash
// v2.0.5-pda - Fix: Payouts — add time range + limit to catch recent OCs, log total count for debugging
// v2.0.4-pda - Fix: Payouts detection — accept any success-like status, use cat=successful, add debug logging
// v2.0.3-pda - Fix: prevent double-loan — better success detection, disable button permanently after loan attempt
// v2.0.2-pda - Fix: loan button now always refreshes armory cache (fixes needing to press twice)
// v2.0.1-pda - Unused tab: exclude temporary items (members can freely loan temps)
// v2.0.0-pda - Multi-category armory: loan/retrieve drugs, medical, temporary items (not just tools)
// v1.9.1-pda - Payouts tab: replace broken Pay All with Open Payouts link to Torn's completed crimes page
// v1.9.0-pda - Payouts tab: Pay All button with configurable payout %, pays to faction balance
// v1.8.3-pda - Fix: Unused tab now checks all OC item needs, not just missing ones
// v1.8.2-pda - Fix: resolve item names from Torn API when not in local cache
// v1.8.1-pda - Fix: filter out chain link crimes ($0 reward) from Payouts tab
// v1.8.0-pda - Replace Split tab with Payouts: shows completed OCs awaiting payout
// v1.7.2-pda - Fix: Settings tab now shows PDA key status, allows override/clear
// v1.7.1-pda - Fix: draggable button click detection
// v1.7.0-pda - Draggable OC button with position memory
// v1.6.0-pda - Add API Settings panel, shrink floating button
// v1.5.2-pda - Update URLs to tornwar.com hosting
// v1.5.1-pda - Fix: retrieve role parameter (use "retrieve" not "return")
// v1.5.0-pda - Unused tab card UI with Retrieve Item button
// v1.4.1-pda - Initial PDA-compatible release: highlights over-loaned items,
//              helps loan missing OC tools, split calculator
// =============================================================================
(function () {
  'use strict';

  // ------------------- PDA / API detection -------------------
  let inPDA = false;
  let apiKey = '';
  try {
    const PDAKey = "###PDA-APIKEY###";
    if (PDAKey && PDAKey.charAt(0) !== "#") {
      inPDA = true;
      apiKey = PDAKey; // Use PDA API key
    }
  } catch (e) {
    // Not in PDA, ignore
  }

  // ------------------- Storage shim (no GM_* APIs) -------------------
  const storage = {
    get(key, def = '') {
      try { const v = localStorage.getItem(key); return v === null ? def : v; }
      catch { return def; }
    },
    set(key, value) {
      try { localStorage.setItem(key, value); }
      catch { /* ignore */ }
    }
  };

  const getApiKey = () => {
    const override = storage.get('OCLM_API_KEY', '');
    if (override) return override;
    if (inPDA) return apiKey;
    return '';
  };

  const requireApiKeyOrThrow = () => {
    const key = getApiKey();
    if (!key) {
      const err = new Error('MISSING_API_KEY');
      err.isApiKeyError = true;
      throw err;
    }
    return key;
  };

  const BLACKLISTED_ITEM_IDS = new Set([1012, 226]);

  const overAllocated = new Map();
  const memberNameMap = new Map();
  let membersLoaded = false;

  // itemID -> { armoryID, qty, armoryType }
  const armoryCache = new Map();
  let preparedArmoryID = null;
  let pendingArmoryItemID = null;

  // Torn item type -> armory tab type mapping
  // The armory POST `type` param needs the armory tab name, not the Torn item type
  const ITEM_TYPE_TO_ARMORY_TAB = {
    'Tool': 'utilities',
    'Drug': 'drugs',
    'Medical': 'medical',
    'Booster': 'boosters',
    'Temporary': 'temporary',
    'Clothing': 'clothing',
    'Armor': 'armor'
  };

  // Armory tab type -> POST `type` param for loan/retrieve actions
  const ARMORY_TAB_TO_POST_TYPE = {
    'utilities': 'Tool',
    'drugs': 'Drug',
    'medical': 'Medical',
    'boosters': 'Booster',
    'temporary': 'Temporary',
    'clothing': 'Clothing',
    'armor': 'Armor'
  };

  // All armory categories that can hold OC items
  const ARMORY_CATEGORIES = ['utilities', 'drugs', 'medical', 'boosters', 'temporary', 'clothing', 'armor'];

  // Cache: itemID -> Torn item type (e.g. 'Tool', 'Drug', 'Medical')
  const itemTypeCache = new Map();

  // ------------------- Utilities -------------------
  const getRfcvToken = () => {
    const match = document.cookie.match(/rfc_v=([^;]+)/);
    return match ? match[1] : null;
  };

  const isOnArmoryUtilities = () => {
    return location.hash.includes('#/tab=armoury') && location.hash.includes('sub=utilities');
  };

  const formatNumber = (num) => {
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  };

  // ------------------- API Helpers -------------------
  const loadMembers = async () => {
    if (membersLoaded) return;
    const key = requireApiKeyOrThrow();
    const res = await fetch(`https://api.torn.com/v2/faction/members?key=${key}`);
    if (!res.ok) throw new Error('Failed to load members');
    const data = await res.json();
    Object.values(data.members || {}).forEach(m => memberNameMap.set(m.id, m.name));
    membersLoaded = true;
  };

  const getMissingOCItems = async () => {
    const key = requireApiKeyOrThrow();
    const res = await fetch(`https://api.torn.com/v2/faction/crimes?cat=available&key=${key}`);
    if (!res.ok) throw new Error('Failed to load OC data');
    const data = await res.json();
    const missing = [];
    data.crimes.forEach(crime => {
      crime.slots?.forEach(slot => {
        if (slot.item_requirement && !slot.item_requirement.is_available &&
            slot.user?.id &&
            !BLACKLISTED_ITEM_IDS.has(slot.item_requirement.id)
        ) {
          missing.push({
            crimeName: crime.name,
            position: slot.position,
            itemID: slot.item_requirement.id,
            userID: slot.user.id,
            userName: memberNameMap.get(slot.user.id) || `Unknown [${slot.user.id}]`
          });
        }
      });
    });
    return missing;
  };

  // Returns ALL item requirements for active OCs (both available and missing)
  const getAllOCItemRequirements = async () => {
    const key = requireApiKeyOrThrow();
    const res = await fetch(`https://api.torn.com/v2/faction/crimes?cat=available&key=${key}`);
    if (!res.ok) throw new Error('Failed to load OC data');
    const data = await res.json();
    // userID -> Set of itemIDs they need for any OC
    const neededByUser = new Map();
    data.crimes.forEach(crime => {
      crime.slots?.forEach(slot => {
        if (slot.item_requirement && slot.user?.id) {
          const uid = slot.user.id;
          const iid = slot.item_requirement.id;
          if (!neededByUser.has(uid)) neededByUser.set(uid, new Set());
          neededByUser.get(uid).add(iid);
        }
      });
    });
    return neededByUser;
  };

  const getUnpaidCompletedCrimes = async () => {
    const key = requireApiKeyOrThrow();
    // Fetch successful crimes from the last 30 days
    const now = Math.floor(Date.now() / 1000);
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60);
    // Use cat=successful with time range to catch recent OCs
    const res = await fetch(`https://api.torn.com/v2/faction/crimes?cat=successful&filter=executed_at&from=${thirtyDaysAgo}&to=${now}&sort=DESC&limit=100&key=${key}`);
    if (!res.ok) throw new Error('Failed to load completed crimes');
    const data = await res.json();
    if (data?.error) throw new Error(`API error: ${data.error.error || JSON.stringify(data.error)}`);
    const crimes = Array.isArray(data?.crimes) ? data.crimes : (data?.crimes && typeof data.crimes === 'object' ? Object.values(data.crimes) : []);
    console.log('[OCLM] Fetched crimes:', crimes.length, 'raw data keys:', Object.keys(data || {}));
    const unpaid = [];
    for (const c of crimes) {
      // Log first few crimes for debugging
      if (crimes.indexOf(c) < 3) {
        console.log('[OCLM] Crime #' + c.id + ':', JSON.stringify(c).substring(0, 500));
      }
      const paidAt = c?.rewards?.payout?.paid_at;
      if (paidAt) continue; // already paid
      const money = Number(c?.rewards?.money || 0);
      const respect = Number(c?.rewards?.respect || 0);
      const hasItems = Array.isArray(c?.rewards?.items) ? c.rewards.items.length > 0 : false;
      // Skip only if there's truly nothing to pay out (no money, no respect, no items)
      // This catches chain link 1 crimes that have $0 and are waiting on link 2
      if (money <= 0 && respect <= 0 && !hasItems) continue;
      unpaid.push({
        id: c.id,
        name: c.name || 'Unknown OC',
        difficulty: c.difficulty || null,
        executedAt: c.executed_at,
        money,
        respect,
        hasItems,
        payoutPct: c?.rewards?.payout?.percentage ?? null
      });
    }
    console.log('[OCLM] Unpaid crimes found:', unpaid.length);
    return unpaid;
  };

  const ITEM_NAME_CACHE_KEY = 'UTILITY_ITEM_ID_NAME_MAP';

  const getItemNameMap = () => {
    try {
      const raw = storage.get(ITEM_NAME_CACHE_KEY, '{}');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
  };

  const setItemName = (itemID, name) => {
    const map = getItemNameMap();
    if (!map[itemID]) {
      map[itemID] = name;
      storage.set(ITEM_NAME_CACHE_KEY, JSON.stringify(map));
    }
  };

  const getItemName = (itemID) => {
    const map = getItemNameMap();
    return map[itemID] || null;
  };

  // Resolve unknown item names via Torn API
  const resolveItemNames = async (itemIDs) => {
    const unknown = itemIDs.filter(id => !getItemName(id));
    if (!unknown.length) return;
    const key = requireApiKeyOrThrow();
    const unique = [...new Set(unknown)];
    // Torn API v2 items endpoint
    try {
      const res = await fetch(`https://api.torn.com/v2/torn/items?ids=${unique.join(',')}&key=${key}`);
      if (!res.ok) return;
      const data = await res.json();
      const items = Array.isArray(data?.items) ? data.items : Object.values(data?.items || {});
      for (const item of items) {
        if (item?.id && item?.name) {
          setItemName(item.id, item.name);
        }
      }
    } catch { /* non-critical, fall back to ID */ }
  };

  // ------------------- Armory Cache (multi-category) -------------------
  const fetchArmoryCategoryJSON = async (category) => {
    const rfcv = getRfcvToken();
    if (!rfcv) throw new Error('Missing RFCV token');
    const body = new URLSearchParams({
      step: 'armouryTabContent',
      type: category,
      start: '0',
      ajax: 'true'
    });
    const res = await fetch(`https://www.torn.com/factions.php?rfcv=${rfcv}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body,
      credentials: 'same-origin'
    });
    if (!res.ok) return []; // Category may not be unlocked
    try {
      const data = await res.json();
      if (!data?.items) return [];
      for (const entry of data.items) {
        if (entry.itemID && entry.name) {
          setItemName(entry.itemID, entry.name);
        }
      }
      // Tag each item with its armory category
      return data.items.map(item => ({ ...item, armoryCategory: category }));
    } catch { return []; }
  };

  // Fetch all armory categories and return combined items
  const fetchAllArmoryItems = async () => {
    const results = await Promise.all(
      ARMORY_CATEGORIES.map(cat => fetchArmoryCategoryJSON(cat))
    );
    return results.flat();
  };

  const refreshArmoryCache = async () => {
    armoryCache.clear();
    const items = await fetchAllArmoryItems();
    for (const entry of items) {
      if (entry.user === false && entry.qty > 0) {
        armoryCache.set(entry.itemID, {
          armoryID: entry.armoryID,
          qty: entry.qty,
          armoryCategory: entry.armoryCategory
        });
      }
    }
  };

  const prepareArmouryForItem = async (itemID) => {
    // Always refresh to get the latest stock — avoids stale cache issues
    // that required pressing the Loan button twice
    await refreshArmoryCache();
    const entry = armoryCache.get(itemID);
    if (!entry || entry.qty <= 0) return null;
    preparedArmoryID = entry.armoryID;
    pendingArmoryItemID = itemID;
    return entry.armoryID;
  };

  // Get the correct POST type for an item based on its armory category
  const getPostTypeForItem = (itemID) => {
    const cached = armoryCache.get(itemID);
    if (cached?.armoryCategory) {
      return ARMORY_TAB_TO_POST_TYPE[cached.armoryCategory] || 'Tool';
    }
    return 'Tool'; // fallback
  };

  // ------------------- Retrieve (return loaned item) -------------------
  const retrieveItem = async ({ armoryID, itemID, userID, userName, postType }) => {
    const rfcv = getRfcvToken();
    if (!rfcv) throw new Error('Missing RFCV token');
    const itemPostType = postType || getPostTypeForItem(itemID);
    const body = new URLSearchParams({
      ajax: 'true',
      step: 'armouryActionItem',
      role: 'retrieve',
      item: armoryID,
      itemID: itemID,
      type: itemPostType,
      user: `${userName} [${userID}]`,
      quantity: '1'
    });
    const res = await fetch(`https://www.torn.com/factions.php?rfcv=${rfcv}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body,
      credentials: 'same-origin'
    });
    if (!res.ok) throw new Error('Retrieve request failed');
    const text = await res.text();
    if (!text.includes('success')) throw new Error('Retrieve failed');
  };

  // ------------------- Loaning (correct armoryID + itemID) -------------------
  const loanItem = async ({ armoryID, itemID, userID, userName }) => {
    const rfcv = getRfcvToken();
    if (!rfcv) throw new Error('Missing RFCV token');
    const itemPostType = getPostTypeForItem(itemID);
    const body = new URLSearchParams({
      ajax: 'true',
      step: 'armouryActionItem',
      role: 'loan',
      item: armoryID,
      itemID: itemID,
      type: itemPostType,
      user: `${userName} [${userID}]`,
      quantity: '1'
    });
    const res = await fetch(`https://www.torn.com/factions.php?rfcv=${rfcv}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body,
      credentials: 'same-origin'
    });
    if (!res.ok) throw new Error('Loan request failed');
    const text = await res.text();
    // Torn returns various responses — treat as success unless it clearly contains an error
    const lower = text.toLowerCase();
    if (lower.includes('error') || lower.includes('cannot') || lower.includes('not enough') || lower.includes('fail')) {
      throw new Error('Loan rejected by server');
    }
    // If we got an OK response without error keywords, treat as success
  };

  const loanPreparedItem = async ({ userID, userName }) => {
    if (!preparedArmoryID || pendingArmoryItemID === null)
      throw new Error('Armoury not prepared');
    await loanItem({
      armoryID: preparedArmoryID,
      itemID: pendingArmoryItemID,
      userID,
      userName
    });
    const entry = armoryCache.get(pendingArmoryItemID);
    if (entry) {
      entry.qty -= 1;
      if (entry.qty <= 0) armoryCache.delete(pendingArmoryItemID);
    }
    preparedArmoryID = null;
    pendingArmoryItemID = null;
  };

  // ------------------- Highlighting -------------------
  let highlightedRows = new Set();

  const clearHighlights = () => {
    highlightedRows.forEach(el => {
      if (el?.style) {
        el.style.outline = '';
        el.style.boxShadow = '';
        el.style.background = '';
      }
    });
    highlightedRows.clear();
  };

  const highlightOverAllocated = () => {
    clearHighlights();
    const container = document.querySelector('#tab\\=armoury\\&sub\\=utilities');
    if (!container) return;
    container.querySelectorAll('li').forEach(li => {
      const loanedDiv = li.querySelector('.loaned');
      if (!loanedDiv) return;
      const link = loanedDiv.querySelector('a[href^="/profiles.php?XID="]');
      if (!link) return;
      const playerId = parseInt(link.href.match(/XID=(\d+)/)?.[1], 10);
      if (!playerId) return;
      const itemImg = li.querySelector('.img-wrap');
      const itemId = parseInt(itemImg?.getAttribute('data-itemid'), 10);
      if (!itemId) return;
      if (overAllocated.get(playerId)?.has(itemId)) {
        li.style.outline = '2px solid var(--default-yellow-color)';
        li.style.outlineOffset = '-2px';
        li.style.background = 'linear-gradient(90deg, rgba(240,200,90,0.22), transparent)';
        li.style.transition = 'background 0.25s ease, outline 0.25s ease';
        highlightedRows.add(li);
      }
    });
  };

  // ------------------- UI -------------------
  const createUI = async () => {
    document.querySelectorAll('#oc-loan-btn, #oc-loan-panel').forEach(el => el.remove());

    const button = document.createElement('button');
    button.id = 'oc-loan-btn';
    button.textContent = 'OC';

    // Restore saved position or use default
    const savedPos = (() => {
      try {
        const raw = storage.get('OCLM_BTN_POS', '');
        if (!raw) return null;
        const p = JSON.parse(raw);
        if (typeof p.x === 'number' && typeof p.y === 'number') return p;
      } catch { /* ignore */ }
      return null;
    })();

    button.style.cssText = `
      position: fixed;
      z-index: 99999;
      padding: 5px 10px;
      min-height: 26px;
      background: #2a3cff;
      color: #fff;
      border: none;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.3px;
      cursor: grab;
      box-shadow: 0 3px 10px rgba(42, 60, 255, 0.3), inset 0 0 0 1px rgba(255,255,255,0.15);
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
    `;

    if (savedPos) {
      button.style.left = Math.min(savedPos.x, window.innerWidth - 40) + 'px';
      button.style.top = Math.min(savedPos.y, window.innerHeight - 26) + 'px';
    } else {
      button.style.top = '10px';
      button.style.right = '10px';
    }

    // ---- Drag logic (mouse + touch, with click detection) ----
    let isDragging = false;
    let wasDragged = false;
    let dragStartX = 0, dragStartY = 0;
    let btnStartX = 0, btnStartY = 0;
    const DRAG_THRESHOLD = 5; // px movement before it counts as a drag

    const getClientPos = (e) => {
      if (e.touches && e.touches.length) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
      return { x: e.clientX, y: e.clientY };
    };

    const onDragStart = (e) => {
      // Only left mouse button or touch
      if (e.type === 'mousedown' && e.button !== 0) return;
      // Only preventDefault for touch (prevents scroll); mouse needs click to fire
      if (e.type === 'touchstart') e.preventDefault();

      const pos = getClientPos(e);
      dragStartX = pos.x;
      dragStartY = pos.y;
      const rect = button.getBoundingClientRect();
      btnStartX = rect.left;
      btnStartY = rect.top;
      isDragging = true;
      wasDragged = false;
      button.style.cursor = 'grabbing';

      document.addEventListener('mousemove', onDragMove, { passive: false });
      document.addEventListener('mouseup', onDragEnd);
      document.addEventListener('touchmove', onDragMove, { passive: false });
      document.addEventListener('touchend', onDragEnd);
    };

    const onDragMove = (e) => {
      if (!isDragging) return;
      const pos = getClientPos(e);
      const dx = pos.x - dragStartX;
      const dy = pos.y - dragStartY;
      if (!wasDragged && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      wasDragged = true;
      e.preventDefault();
      // Clamp to viewport
      const bw = button.offsetWidth;
      const bh = button.offsetHeight;
      const newX = Math.max(0, Math.min(window.innerWidth - bw, btnStartX + dx));
      const newY = Math.max(0, Math.min(window.innerHeight - bh, btnStartY + dy));
      button.style.left = newX + 'px';
      button.style.top = newY + 'px';
      button.style.right = 'auto';
    };

    const onDragEnd = (e) => {
      if (!isDragging) return;
      isDragging = false;
      button.style.cursor = 'grab';
      document.removeEventListener('mousemove', onDragMove);
      document.removeEventListener('mouseup', onDragEnd);
      document.removeEventListener('touchmove', onDragMove);
      document.removeEventListener('touchend', onDragEnd);

      if (wasDragged) {
        // Persist position
        const rect = button.getBoundingClientRect();
        storage.set('OCLM_BTN_POS', JSON.stringify({ x: Math.round(rect.left), y: Math.round(rect.top) }));
      } else if (e.type === 'touchend') {
        // Touch didn't drag — treat as a tap (click won't fire after touchstart preventDefault)
        isOpen ? closePanel() : openPanel();
      }
    };

    button.addEventListener('mousedown', onDragStart);
    button.addEventListener('touchstart', onDragStart, { passive: false });
    button.onmouseover = () => { if (!isDragging) button.style.opacity = '0.85'; };
    button.onmouseout = () => { button.style.opacity = '1'; };

    const panel = document.createElement('div');
    panel.id = 'oc-loan-panel';
    panel.style.cssText = `
      position:fixed;
      width:320px;
      max-width:90vw;
      max-height:80vh;
      background: var(--default-bg-panel-color);
      border: 1px solid var(--default-panel-divider-outer-side-color);
      border-radius: 8px;
      box-shadow: 0 8px 20px rgba(0,0,0,0.4);
      z-index:99998;
      opacity:0;
      visibility:hidden;
      transform:translateY(-8px);
      transition: opacity 0.25s ease, transform 0.25s ease;
      display:flex;
      flex-direction:column;
      overflow:hidden;
    `;

    const style = document.createElement('style');
    style.textContent = `
      #oc-loan-panel { color: #e6e6e6; font-size: 13.5px; }
      #oc-loan-panel * { box-sizing: border-box; }
      #oc-loan-panel .oc-header {
        padding: 8px 10px 4px 10px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        background: #121212;
        border-bottom: 1px solid #222;
        gap: 4px;
        flex-wrap: wrap;
      }
      #oc-loan-panel .oc-title { font-size: 15px; font-weight: 700; letter-spacing: 0.3px; }
      #oc-loan-panel .oc-status { font-size: 11px; color: #888; }
      #oc-loan-panel .oc-tabs { display: flex; gap: 6px; }
      #oc-loan-panel .oc-tab {
        padding: 6px 12px;
        background: #1b1b1b;
        border-radius: 999px;
        border: none;
        color: #aaa;
        cursor: pointer;
        font-weight: 600;
      }
      #oc-loan-panel .oc-tab.active { background: #2a3cff; color: #fff; }
      #oc-loan-panel .oc-tab:hover:not(.active) { background: #222; color: #ddd; }
      #oc-content {
        padding: 12px 14px 14px 14px;
        overflow-y: auto;
        overflow-x: hidden;
        max-height: calc(80vh - 52px);
      }
      #action-btn {
        width: 100%;
        padding: 14px;
        margin-top: 14px;
        border-radius: 10px;
        border: none;
        font-weight: 700;
        font-size: 14px;
        background: #2a2a2a;
        color: #aaa;
        cursor: pointer;
      }
      #action-btn.ready { background: #2a3cff; color: #fff; }
      #action-btn.ready:hover { filter: brightness(1.1); }
      #oc-loan-panel table { width: 100%; border-collapse: collapse; }
      #oc-loan-panel th { text-align: left; color: #888; font-weight: 600; padding-bottom: 6px; }
      #oc-loan-panel td { padding: 6px 0; }
      #oc-close { cursor: pointer; font-size: 22px; opacity: 0.6; }
      #oc-close:hover { opacity: 1; }
    `;
    document.head.appendChild(style);

    const apiStatus = inPDA ? 'API: PDA key' : (getApiKey() ? 'API: Local key' : 'API: missing — set key in ⚙');

    panel.innerHTML = `
      <div class="oc-header">
        <span class="oc-title">OC Loan Manager</span>
        <span id="oc-close">&times;</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px;padding:6px 10px 2px 10px;flex-wrap:wrap;">
        <div class="oc-tabs">
          <button class="oc-tab active" data-tab="missing">Missing</button>
          <button class="oc-tab" data-tab="unused">Unused</button>
          <button class="oc-tab" data-tab="payouts">Payouts</button>
          <button class="oc-tab" data-tab="settings">⚙</button>
        </div>
        <span class="oc-status">${apiStatus}</span>
      </div>
      <div id="oc-content"></div>
    `;

    document.body.appendChild(button);
    document.body.appendChild(panel);

    let isOpen = false;

    const positionPanel = () => {
      const btnRect = button.getBoundingClientRect();
      const panelW = 320;
      const panelH = panel.offsetHeight || 300;
      let left = btnRect.right + 8;
      let top = btnRect.top;
      if (left + panelW > window.innerWidth) left = btnRect.left - panelW - 8;
      if (left < 4) left = 4;
      if (top + panelH > window.innerHeight) top = window.innerHeight - panelH - 8;
      if (top < 4) top = 4;
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
    };

    const openPanel = () => {
      positionPanel();
      panel.style.opacity = '1';
      panel.style.visibility = 'visible';
      panel.style.transform = 'translateY(0)';
      isOpen = true;
      loadTab('missing');
    };
    const closePanel = () => {
      panel.style.opacity = '0';
      panel.style.visibility = 'hidden';
      panel.style.transform = 'translateY(-8px)';
      isOpen = false;
    };

    // Click (mouse only — touch tap handled in onDragEnd)
    button.addEventListener('click', (e) => {
      if (wasDragged) return; // ignore click after drag
      isOpen ? closePanel() : openPanel();
    });

    panel.querySelector('#oc-close').onclick = closePanel;

    // ----------- Tabs -----------
    let activeTab = 'missing';
    panel.querySelectorAll('.oc-tab').forEach(tab => {
      tab.onclick = () => {
        panel.querySelectorAll('.oc-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        activeTab = tab.dataset.tab;
        loadTab(activeTab);
      };
    });

    const content = panel.querySelector('#oc-content');

    // ----------- Missing Tab -----------
    const loadMissingTab = async () => {
      content.innerHTML = '<div style="text-align:center;color:#888;padding:20px;">Loading OC data…</div>';
      try {
        await loadMembers();
        const missing = await getMissingOCItems();
        if (!missing.length) {
          content.innerHTML = '<div style="text-align:center;color:#6c6;padding:20px;">All OC items allocated ✓</div>';
          return;
        }
        // Resolve any unknown item names from the API
        await resolveItemNames(missing.map(m => m.itemID));
        let html = '<table><tr><th>Crime</th><th>Item</th><th>Player</th><th></th></tr>';
        for (const m of missing) {
          const itemName = getItemName(m.itemID) || `Item #${m.itemID}`;
          html += `<tr>
            <td style="font-size:12px;">${m.crimeName}</td>
            <td style="font-size:12px;">${itemName}</td>
            <td style="font-size:12px;"><a href="/profiles.php?XID=${m.userID}" style="color:#7af;">${m.userName}</a></td>
            <td><button class="loan-btn" data-itemid="${m.itemID}" data-userid="${m.userID}" data-username="${m.userName}"
              style="padding:4px 10px;border-radius:6px;border:none;background:#2a3cff;color:#fff;font-size:11px;cursor:pointer;white-space:nowrap;">
              Loan</button></td>
          </tr>`;
        }
        html += '</table>';
        content.innerHTML = html;

        // Loan buttons
        content.querySelectorAll('.loan-btn').forEach(btn => {
          btn.onclick = async () => {
            if (btn.dataset.loaning === 'true') return; // prevent double-click
            btn.dataset.loaning = 'true';
            const itemID = parseInt(btn.dataset.itemid, 10);
            const userID = parseInt(btn.dataset.userid, 10);
            const userName = btn.dataset.username;
            btn.disabled = true;
            btn.textContent = '…';
            btn.style.opacity = '0.6';
            try {
              const armoryID = await prepareArmouryForItem(itemID);
              if (!armoryID) {
                btn.textContent = 'No stock';
                btn.style.background = '#555';
                btn.style.opacity = '1';
                // Allow retry for no stock — item might be restocked
                setTimeout(() => {
                  btn.dataset.loaning = 'false';
                  btn.disabled = false;
                  btn.textContent = 'Loan';
                  btn.style.background = '#2a3cff';
                }, 3000);
                return;
              }
              await loanPreparedItem({ userID, userName });
              btn.textContent = '✓ Loaned';
              btn.style.background = '#1a7a1a';
              btn.style.opacity = '1';
              // Stay disabled permanently — item is loaned
            } catch (e) {
              // Loan may have gone through even if response was unexpected
              // Keep disabled to prevent accidental double-loan
              btn.textContent = '? Check';
              btn.style.background = '#b8860b';
              btn.style.opacity = '1';
              // Don't re-enable — user should refresh the tab to see current state
              console.error('[OCLM] Loan error:', e);
            }
          };
        });
      } catch (e) {
        if (e.isApiKeyError) {
          content.innerHTML = '<div style="text-align:center;color:#f88;padding:20px;">API key required.<br>Set it in the ⚙ tab.</div>';
        } else {
          content.innerHTML = `<div style="text-align:center;color:#f88;padding:20px;">Error: ${e.message}</div>`;
        }
      }
    };

    // ----------- Unused Tab -----------
    const loadUnusedTab = async () => {
      content.innerHTML = '<div style="text-align:center;color:#888;padding:20px;">Loading armory & OC data…</div>';
      try {
        await loadMembers();
        const [armoryItems, neededByUser] = await Promise.all([
          fetchAllArmoryItems(),
          getAllOCItemRequirements()
        ]);

        // Find items loaned to members who do NOT need them for any OC
        // Skip temporary items — members can freely loan those for personal use
        const unused = [];
        for (const entry of armoryItems) {
          if (entry.armoryCategory === 'temporary') continue;
          if (entry.user && entry.user !== false && entry.user.userID) {
            const uid = entry.user.userID;
            const iid = entry.itemID;
            // Loaned to someone — check if they need this item for an OC (available or not)
            const needed = neededByUser.get(uid);
            if (!needed || !needed.has(iid)) {
              unused.push({
                itemID: iid,
                itemName: entry.name || getItemName(iid) || `Item #${iid}`,
                armoryID: entry.armoryID,
                armoryCategory: entry.armoryCategory || 'utilities',
                userID: uid,
                userName: entry.user.userName || memberNameMap.get(uid) || `Unknown [${uid}]`
              });
            }
          }
        }

        if (!unused.length) {
          content.innerHTML = '<div style="text-align:center;color:#6c6;padding:20px;">No unused loaned items ✓</div>';
          return;
        }

        let html = '<div style="margin-bottom:8px;font-size:12px;color:#aaa;">Items loaned but not needed for any current OC:</div>';
        html += '<table><tr><th>Item</th><th>Loaned To</th><th></th></tr>';
        for (const u of unused) {
          html += `<tr>
            <td style="font-size:12px;">${u.itemName}</td>
            <td style="font-size:12px;"><a href="/profiles.php?XID=${u.userID}" style="color:#7af;">${u.userName}</a></td>
            <td><button class="retrieve-btn" data-armoryid="${u.armoryID}" data-itemid="${u.itemID}" data-userid="${u.userID}" data-username="${u.userName}" data-category="${u.armoryCategory || 'utilities'}"
              style="padding:4px 10px;border-radius:6px;border:none;background:#c44;color:#fff;font-size:11px;cursor:pointer;white-space:nowrap;">
              Retrieve</button></td>
          </tr>`;
        }
        html += '</table>';
        content.innerHTML = html;

        // Retrieve buttons
        content.querySelectorAll('.retrieve-btn').forEach(btn => {
          btn.onclick = async () => {
            const armoryID = parseInt(btn.dataset.armoryid, 10);
            const itemID = parseInt(btn.dataset.itemid, 10);
            const userID = parseInt(btn.dataset.userid, 10);
            const userName = btn.dataset.username;
            btn.disabled = true;
            btn.textContent = '…';
            try {
              const postType = ARMORY_TAB_TO_POST_TYPE[btn.dataset.category] || 'Tool';
              await retrieveItem({ armoryID, itemID, userID, userName, postType });
              btn.textContent = '✓ Retrieved';
              btn.style.background = '#1a7a1a';
            } catch (e) {
              btn.textContent = 'Error';
              btn.style.background = '#a00';
              console.error('[OCLM] Retrieve error:', e);
            }
          };
        });
      } catch (e) {
        if (e.isApiKeyError) {
          content.innerHTML = '<div style="text-align:center;color:#f88;padding:20px;">API key required.<br>Set it in the ⚙ tab.</div>';
        } else {
          content.innerHTML = `<div style="text-align:center;color:#f88;padding:20px;">Error: ${e.message}</div>`;
        }
      }
    };

    // ----------- Payouts Tab -----------
    const loadPayoutsTab = async () => {
      content.innerHTML = '<div style="text-align:center;color:#888;padding:20px;">Loading completed crimes…</div>';
      try {
        const unpaid = await getUnpaidCompletedCrimes();
        if (!unpaid.length) {
          content.innerHTML = '<div style="text-align:center;color:#6c6;padding:20px;">All completed OCs have been paid out ✓</div>';
          return;
        }

        let totalMoney = 0;
        let itemRewardCount = 0;
        unpaid.forEach(c => { totalMoney += c.money; if (c.hasItems) itemRewardCount++; });

        let html = `<div style="margin-bottom:10px;font-size:12px;color:#aaa;">Completed OCs awaiting payout: <strong style="color:#f8d866;">${unpaid.length}</strong></div>`;
        html += `<div style="margin-bottom:12px;padding:8px 10px;border-radius:6px;background:#1a1a2e;border:1px solid #333;">`;
        if (totalMoney > 0) {
          html += `<span style="font-size:12px;color:#888;">Total unpaid:</span> <strong style="color:#6c6;font-size:14px;">$${formatNumber(totalMoney)}</strong>`;
        }
        if (itemRewardCount > 0) {
          html += `${totalMoney > 0 ? '<br>' : ''}<span style="font-size:12px;color:#888;">Item rewards:</span> <strong style="color:#7af;font-size:13px;">${itemRewardCount} OC${itemRewardCount !== 1 ? 's' : ''}</strong>`;
        }
        html += `</div>`;

        // Open Payouts button — navigates to Torn's completed crimes page
        html += `<div style="margin-bottom:12px;">`;
        html += `<a id="open-payouts-btn" href="https://www.torn.com/factions.php?step=your#/tab=crimes&crimeSubTab=completed" target="_blank" style="display:block;text-align:center;padding:10px 12px;border-radius:6px;background:#2a3cff;color:#fff;font-weight:700;font-size:13px;text-decoration:none;cursor:pointer;">Open Payouts Page (${unpaid.length} unpaid)</a>`;
        html += `</div>`;

        html += '<table><tr><th>Crime</th><th style="text-align:right;">Reward</th><th style="text-align:right;">Age</th></tr>';
        for (const c of unpaid) {
          const ageSec = Math.floor(Date.now() / 1000) - c.executedAt;
          const ageDays = Math.floor(ageSec / 86400);
          const ageHrs = Math.floor((ageSec % 86400) / 3600);
          const ageStr = ageDays > 0 ? `${ageDays}d ${ageHrs}h` : `${ageHrs}h`;
          const diffLabel = c.difficulty ? ` <span style="color:#666;">(Lv${c.difficulty})</span>` : '';
          const pctLabel = c.payoutPct !== null ? ` <span style="color:#666;font-size:10px;">${c.payoutPct}%</span>` : '';
          const ageColor = ageDays >= 7 ? '#f88' : (ageDays >= 3 ? '#f8d866' : '#aaa');
          html += `<tr>
            <td style="font-size:12px;">${c.name}${diffLabel}</td>
            <td style="font-size:12px;text-align:right;">${c.money > 0 ? '$' + formatNumber(c.money) : ''}${c.hasItems ? '<span style="color:#7af;">Items</span>' : ''}${c.money <= 0 && !c.hasItems && c.respect > 0 ? '<span style="color:#ccc;">Respect</span>' : ''}${pctLabel}</td>
            <td style="font-size:12px;text-align:right;color:${ageColor};">${ageStr}</td>
          </tr>`;
        }
        html += '</table>';
        content.innerHTML = html;

        // Open payouts button hover effect
        const openBtn = document.getElementById('open-payouts-btn');
        openBtn.onmouseover = () => { openBtn.style.filter = 'brightness(1.15)'; };
        openBtn.onmouseout = () => { openBtn.style.filter = ''; };
      } catch (e) {
        if (e.isApiKeyError) {
          content.innerHTML = '<div style="text-align:center;color:#f88;padding:20px;">API key required.<br>Set it in the ⚙ tab.</div>';
        } else {
          content.innerHTML = `<div style="text-align:center;color:#f88;padding:20px;">Error: ${e.message}</div>`;
        }
      }
    };

    // ----------- Settings Tab -----------
    const loadSettingsTab = () => {
      const overrideKey = storage.get('OCLM_API_KEY', '');
      const activeKey = overrideKey || (inPDA ? apiKey : '');
      const masked = activeKey ? activeKey.slice(0, 4) + '…' + activeKey.slice(-4) : 'No key saved';
      const sourceLabel = overrideKey ? 'Local override' : (inPDA ? 'PDA key' : 'Not set');

      let html = `<div style="font-size:15px;font-weight:700;color:#ccc;margin-bottom:10px;">API Settings</div>`;

      if (inPDA) {
        html += `<div style="font-size:12.5px;color:#aaa;margin-bottom:14px;">Running in PDA — API key is provided automatically. You can still override it below.</div>`;
      }

      html += `<div style="font-size:12px;color:#888;margin-bottom:4px;">Current Key <span style="color:#666;">(${sourceLabel})</span></div>`;
      html += `<div style="padding:10px;border-radius:6px;background:#1b1b1b;color:#999;border:1px solid #333;margin-bottom:14px;font-family:monospace;font-size:13px;">${masked}</div>`;

      html += `<div style="font-size:12px;color:#888;margin-bottom:4px;">New API Key</div>`;
      html += `<input id="settings-key" type="text" placeholder="Paste your Torn API key" style="width:100%;padding:10px;border-radius:6px;background:#1b1b1b;color:#eee;border:1px solid #333;margin-bottom:10px;font-family:monospace;font-size:13px;">`;

      html += `<div style="display:flex;gap:8px;">`;
      html += `<button id="settings-save" style="flex:1;padding:12px;border-radius:8px;border:none;background:#2a3cff;color:#fff;font-weight:700;font-size:14px;cursor:pointer;">Save Key</button>`;
      html += `<button id="settings-clear" style="flex:1;padding:12px;border-radius:8px;border:1px solid #444;background:#1b1b1b;color:#ccc;font-weight:700;font-size:14px;cursor:pointer;">Clear Key</button>`;
      html += `</div>`;

      html += `<div style="margin-top:14px;font-size:11px;color:#555;">Your key is stored in localStorage and never leaves your browser. Use a <strong style="color:#888;">Limited Access</strong> key with only the permissions this script needs.</div>`;

      content.innerHTML = html;

      document.getElementById('settings-save').onclick = () => {
        const val = document.getElementById('settings-key').value.trim();
        if (val) {
          storage.set('OCLM_API_KEY', val);
          const saveBtn = document.getElementById('settings-save');
          saveBtn.textContent = '✓ Saved';
          saveBtn.style.background = '#1a7a1a';
          panel.querySelector('.oc-status').textContent = 'API: Local override';
          // Refresh display after short delay
          setTimeout(() => loadSettingsTab(), 800);
        }
      };

      document.getElementById('settings-clear').onclick = () => {
        storage.set('OCLM_API_KEY', '');
        const clearBtn = document.getElementById('settings-clear');
        clearBtn.textContent = '✓ Cleared';
        clearBtn.style.background = '#1a7a1a';
        clearBtn.style.color = '#fff';
        clearBtn.style.borderColor = '#1a7a1a';
        panel.querySelector('.oc-status').textContent = inPDA ? 'API: PDA key' : 'API: missing — set key in ⚙';
        setTimeout(() => loadSettingsTab(), 800);
      };
    };

    // ----------- Tab Router -----------
    const loadTab = (tab) => {
      if (tab === 'missing') loadMissingTab();
      else if (tab === 'unused') loadUnusedTab();
      else if (tab === 'payouts') loadPayoutsTab();
      else if (tab === 'settings') loadSettingsTab();
    };
  };

  // ------------------- Init -------------------
  const init = () => {
    if (window.location.href.includes('factions.php?step=your')) {
      createUI();
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
