// ==UserScript==
// @name         Torn Easter Egg Hunter 2026
// @namespace    torn.easter.egg.hunter
// @version      1.0.0
// @description  Detects, highlights, and helps you navigate for Easter Eggs in Torn City.
// @author       RussianRob
// @match        https://www.torn.com/*
// @run-at       document-end
// @downloadURL  https://tornwar.com/scripts/torn-easter-egg-hunt.user.js
// @updateURL    https://tornwar.com/scripts/torn-easter-egg-hunt.meta.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// ==/UserScript==

(function() {
    'use strict';

    // --- CONFIGURATION ---
    const EGG_IDS = [618, 619, 620, 621, 622, 623, 624, 625, 626]; // IDs for Green, Red, Yellow, White, Black, Blue, Brown, Purple, Gold
    const NAV_PAGES = [
        "index.php", "home.php", "items.php", "properties.php", "education.php", "gym.php", "crimes.php", "missions.php", "newspaper.php", "jail.php", "hospital.php", "casino.php", "forums.php", "city.php", "job.php", "bounties.php", "halloffame.php", "factions.php", "points.php", "trade.php", "stockmarket.php", "museum.php", "travelagency.php", "raceway.php", "page.php?sid=map",
        "loader.php?sid=slots", "loader.php?sid=roulette", "loader.php?sid=blackjack", "loader.php?sid=poker", "loader.php?sid=bookie", "loader.php?sid=lottery", "loader.php?sid=keno", "loader.php?sid=highlow", "loader.php?sid=craps",
        "shops.php?step=bitsnbobs", "shops.php?step=bigals", "shops.php?step=pharmacy", "shops.php?step=jewelry", "shops.php?step=sweetshop", "shops.php?step=clothing", "shops.php?step=hardware", "shops.php?step=superstore", "shops.php?step=postoffice", "shops.php?step=cyberforce", "shops.php?step=nikeh", "shops.php?step=pawnshop"
    ];

    const STORAGE_KEY_NAV_INDEX = 'torn_egg_nav_index';
    const STORAGE_KEY_ENABLED = 'torn_egg_hunter_enabled';

    // --- EGG FINDER LOGIC ---
    function highlightEggs() {
        if (!getEnabled()) return;

        const images = document.getElementsByTagName('img');
        let eggsFoundOnPage = 0;

        for (let img of images) {
            // Check if the image source matches a Torn item ID for an egg or has "easter_egg" in its URL
            const isEgg = EGG_IDS.some(id => img.src.includes(`/items/${id}/`)) || 
                        img.src.includes('easter_egg') || 
                        img.src.includes('easter-egg');
            
            if (isEgg && !img.dataset.foundByHunter) {
                img.dataset.foundByHunter = "true";
                eggsFoundOnPage++;
                
                console.log("%c [EGG FOUND!] ", "background: #222; color: #bada55; font-size: 20px;");
                
                // Apply High Visibility Styles
                Object.assign(img.style, {
                    position: 'fixed',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%) scale(1)',
                    width: '300px',
                    height: 'auto',
                    zIndex: '2147483647', // Max z-index
                    border: '10px solid gold',
                    borderRadius: '10px',
                    boxShadow: '0 0 100px 50px rgba(255, 215, 0, 0.9)',
                    cursor: 'pointer',
                    animation: 'egg-pulsate 1.5s infinite',
                    pointerEvents: 'auto',
                    visibility: 'visible',
                    display: 'block'
                });

                // Add animation if not exists
                if (!document.getElementById('egg-hunter-styles')) {
                    const style = document.createElement('style');
                    style.id = 'egg-hunter-styles';
                    style.innerHTML = `
                        @keyframes egg-pulsate {
                            0% { transform: translate(-50%, -50%) scale(1); box-shadow: 0 0 50px 25px rgba(255, 215, 0, 0.7); }
                            50% { transform: translate(-50%, -50%) scale(1.1); box-shadow: 0 0 100px 50px rgba(255, 215, 0, 0.9); }
                            100% { transform: translate(-50%, -50%) scale(1); box-shadow: 0 0 50px 25px rgba(255, 215, 0, 0.7); }
                        }
                    `;
                    document.head.appendChild(style);
                }

                // Browser Notification
                if (typeof GM_notification === 'function') {
                    GM_notification({
                        title: 'Torn Easter Egg Found!',
                        text: 'Click the highlighted egg on your screen!',
                        timeout: 5000
                    });
                }
                
                // Audio Alert (Gentle Ding)
                try {
                    const audio = new Audio('https://www.myinstants.com/media/sounds/ding-sound-effect.mp3');
                    audio.play().catch(() => {}); // Catch play() errors if browser blocks autoplay
                } catch (e) {}
            }
        }
    }

    // --- SIDEBAR UI ---
    function addNavUI() {
        const sidebar = document.querySelector('#sidebarroot') || document.querySelector('.sidebar-menu');
        if (!sidebar || document.getElementById('egg-hunter-container')) return;

        const container = document.createElement('div');
        container.id = 'egg-hunter-container';
        container.style.cssText = `
            background: #1a1a1a;
            color: #ccc;
            margin: 10px 5px;
            padding: 10px;
            border-radius: 5px;
            border: 1px solid #333;
            font-family: Arial, sans-serif;
            font-size: 12px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.5);
        `;

        const header = document.createElement('div');
        header.style.cssText = 'font-weight: bold; color: gold; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;';
        header.innerHTML = '<span>🥚 Egg Hunter 2026</span>';
        
        const toggleBtn = document.createElement('span');
        toggleBtn.id = 'egg-hunter-toggle';
        toggleBtn.style.cssText = 'cursor: pointer; font-size: 10px; padding: 2px 5px; border-radius: 3px;';
        updateToggleStyle(toggleBtn);
        toggleBtn.onclick = () => {
            setEnabled(!getEnabled());
            updateToggleStyle(toggleBtn);
            if (getEnabled()) highlightEggs();
        };
        header.appendChild(toggleBtn);

        const navBtn = document.createElement('div');
        navBtn.id = 'egg-nav-btn';
        navBtn.style.cssText = `
            background: #444;
            color: #fff;
            padding: 8px;
            cursor: pointer;
            text-align: center;
            border-radius: 3px;
            border: 1px solid #555;
            transition: background 0.2s;
        `;
        navBtn.onmouseover = () => navBtn.style.background = '#555';
        navBtn.onmouseout = () => navBtn.style.background = '#444';
        
        const currentIndex = getNavIndex();
        navBtn.innerHTML = `HUNT NEXT PAGE (<span id="egg-nav-count">${currentIndex}</span>/${NAV_PAGES.length})`;
        
        navBtn.onclick = function() {
            let idx = getNavIndex();
            if (idx >= NAV_PAGES.length) idx = 0;
            
            const nextPage = NAV_PAGES[idx];
            setNavIndex(idx + 1);
            window.location.href = `https://www.torn.com/${nextPage}`;
        };

        const resetBtn = document.createElement('div');
        resetBtn.style.cssText = 'margin-top: 5px; font-size: 9px; text-align: center; color: #666; cursor: pointer; text-decoration: underline;';
        resetBtn.innerText = 'Reset Index';
        resetBtn.onclick = () => {
            setNavIndex(0);
            document.getElementById('egg-nav-count').innerText = '0';
        };

        container.appendChild(header);
        container.appendChild(navBtn);
        container.appendChild(resetBtn);

        // Prepend to sidebar or after some specific element
        const firstChild = sidebar.firstChild;
        if (firstChild) sidebar.insertBefore(container, firstChild);
        else sidebar.appendChild(container);
    }

    function updateToggleStyle(btn) {
        const enabled = getEnabled();
        btn.innerText = enabled ? 'ON' : 'OFF';
        btn.style.background = enabled ? '#2a4a2a' : '#4a2a2a';
        btn.style.color = enabled ? '#4caf50' : '#f44336';
        btn.style.border = `1px solid ${enabled ? '#4caf50' : '#f44336'}`;
    }

    // --- STORAGE HELPERS ---
    function getNavIndex() {
        return parseInt(localStorage.getItem(STORAGE_KEY_NAV_INDEX) || '0', 10);
    }

    function setNavIndex(idx) {
        localStorage.setItem(STORAGE_KEY_NAV_INDEX, idx.toString());
    }

    function getEnabled() {
        const val = localStorage.getItem(STORAGE_KEY_ENABLED);
        return val === null ? true : val === 'true';
    }

    function setEnabled(val) {
        localStorage.setItem(STORAGE_KEY_ENABLED, val.toString());
    }

    // --- INITIALIZATION ---
    function init() {
        highlightEggs();
        addNavUI();

        // Observe DOM changes for eggs that load dynamically (e.g. in popups or city map)
        const observer = new MutationObserver((mutations) => {
            // Basic debounce to prevent heavy processing
            if (window.eggHunterTimeout) clearTimeout(window.eggHunterTimeout);
            window.eggHunterTimeout = setTimeout(highlightEggs, 300);
        });
        
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // Run on load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
