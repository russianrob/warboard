// ==UserScript==
// @name         Torn Easter Egg Hunter 2026
// @namespace    torn.easter.egg.hunter
// @version      1.1.3
// @description  Ultimate Detection & Navigation for Torn Easter Eggs. Detects eggs in the root container, highlights them, and provides a 300+ page navigation tool with keyboard shortcuts.
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
    
    // Extracted 300+ pages from Ultimate Hunter
    const NAV_PAGES = [
        "index.php", "preferences.php", "personalstats.php", "personalstats.php?ID=1", "playerreport.php", "page.php?sid=report#/add", "authenticate.php", "page.php?sid=log", "page.php?sid=events", "page.php?sid=events#onlySaved=true", "events.php#/step=all",
        "profiles.php?XID=1", "profiles.php?XID=3", "profiles.php?XID=4", "profiles.php?XID=7", "profiles.php?XID=8", "profiles.php?XID=9", "profiles.php?XID=10", "profiles.php?XID=15", "profiles.php?XID=17", "profiles.php?XID=19", "profiles.php?XID=20", "profiles.php?XID=21", "profiles.php?XID=23", "profiles.php?XID=50", "profiles.php?XID=100", "profiles.php?XID=101", "profiles.php?XID=102", "profiles.php?XID=103", "profiles.php?XID=104",
        "page.php?sid=gallery&XID=1", "page.php?sid=awards&tab=honors", "page.php?sid=awards&tab=medals", "page.php?sid=awards&tab=merits", "page.php?sid=hof", "revive.php", "pc.php", "city.php", "citystats.php", "usersonline.php", "page.php?sid=UserList", "index.php?page=people", "index.php?page=fortune", "index.php?page=rehab", "index.php?page=hunting",
        "item.php", "page.php?sid=itemsMods", "page.php?sid=ammo", "itemuseparcel.php", "displaycase.php", "displaycase.php#display/1", "displaycase.php#display/4", "displaycase.php#display/7", "displaycase.php#display/10", "displaycase.php#display/15", "displaycase.php#display/50", "displaycase.php#manage", "displaycase.php#add", "keepsakes.php", "trade.php", "museum.php", "amarket.php", "pmarket.php", "page.php?sid=ItemMarket", "page.php?sid=ItemMarket#/market/view=category&categoryName=Most%20Popular",
        "page.php?sid=bazaar", "bazaar.php#/add", "bazaar.php#/manage", "bazaar.php#/personalize", "bazaar.php?userId=1", "bazaar.php?userId=4", "bazaar.php?userId=7", "bazaar.php?userId=10", "bazaar.php?userId=15", "bazaar.php?userId=19", "bazaar.php?userId=20", "bazaar.php?userId=21", "bazaar.php?userId=23", "bazaar.php?userId=50",
        "page.php?sid=stocks", "bank.php", "points.php", "loan.php", "donator.php", "donatordone.php", "token_shop.php", "freebies.php", "bringafriend.php", "bounties.php", "jailview.php", "hospitalview.php",
        "casino.php", "loader.php?sid=slots", "loader.php?sid=roulette", "loader.php?sid=blackjack", "loader.php?sid=poker", "loader.php?sid=bookie", "loader.php?sid=lottery", "loader.php?sid=keno", "loader.php?sid=highlow", "loader.php?sid=craps", "page.php?sid=slots", "page.php?sid=roulette", "page.php?sid=blackjack", "page.php?sid=poker", "page.php?sid=bookie", "page.php?sid=lottery", "page.php?sid=keno", "page.php?sid=highlow", "page.php?sid=craps",
        "shops.php?step=bitsnbobs", "shops.php?step=bigals", "shops.php?step=pharmacy", "shops.php?step=jewelry", "shops.php?step=sweetshop", "shops.php?step=clothing", "shops.php?step=hardware", "shops.php?step=superstore", "shops.php?step=postoffice", "shops.php?step=cyberforce", "shops.php?step=nikeh", "shops.php?step=pawnshop",
        "education.php", "gym.php", "crimes.php", "missions.php", "newspaper.php", "job.php", "factions.php", "travelagency.php", "raceway.php",
        "crimes.php#/searchforcash", "crimes.php#/bootlegging", "crimes.php#/graffiti", "crimes.php#/shoplifting", "crimes.php#/burglary", "crimes.php#/hustling", "crimes.php#/pickpocketing", "crimes.php#/cracking",
        "factions.php?step=your#/tab=armoury", "factions.php?step=your#/tab=crimes", "factions.php?step=your#/tab=wars", "factions.php?step=your#/tab=controls", "factions.php?step=your#/tab=info", "factions.php?step=your#/tab=main",
        "forums.php", "forums.php#/p=threads&f=1", "forums.php#/p=threads&f=2", "forums.php#/p=threads&f=3", "forums.php#/p=threads&f=9", "forums.php#/p=threads&f=10",
        "staff.php", "rules.php", "donates.php", "halloffame.php", "competition.php", "calendar.php", "credits.php", "committee.php#/step=main", "archives.php", "church.php", "christmas_town.php#/",
        "friendlist.php", "enemylist.php", "blacklist.php", "messages.php"
    ];

    const STORAGE_KEY_NAV_INDEX = 'torn_egg_nav_index';
    const STORAGE_KEY_ENABLED = 'torn_egg_hunter_enabled';

    // --- EGG FINDER LOGIC ---
    function highlightEggs() {
        if (!getEnabled()) return;

        // 1. Detection via Native Container (Most Robust)
        const nativeRoot = document.getElementById('easter-egg-hunt-root');
        if (nativeRoot) {
            const eggImages = nativeRoot.querySelectorAll('img');
            eggImages.forEach(img => processEgg(img));
        }

        // 2. Detection via Image Scan (Fallback/Safety)
        const allImages = document.getElementsByTagName('img');
        for (let img of allImages) {
            const isEgg = EGG_IDS.some(id => img.src.includes(`/items/${id}/`)) || 
                        img.src.includes('easter_egg') || 
                        img.src.includes('easter-egg');
            
            if (isEgg) processEgg(img);
        }
    }

    function processEgg(img) {
        if (img.dataset.foundByHunter) return;
        img.dataset.foundByHunter = "true";

        console.log("%c [EGG FOUND!] ", "background: #222; color: #bada55; font-size: 20px;");
        
        // Ensure parent doesn't clip the enlarged egg
        let parent = img.parentElement;
        while (parent && parent !== document.body) {
            parent.style.overflow = 'visible';
            parent = parent.parentElement;
        }

        // Apply "Mega-Egg" Center-Screen Styles
        Object.assign(img.style, {
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%) scale(1)',
            width: 'min(350px, 60vw)',
            height: 'auto',
            zIndex: '2147483647',
            border: '10px solid gold',
            borderRadius: '20px',
            boxShadow: '0 0 150px 75px rgba(255, 215, 0, 0.9)',
            cursor: 'pointer',
            animation: 'egg-pulsate-mega 1.2s infinite ease-in-out',
            pointerEvents: 'auto',
            visibility: 'visible',
            display: 'block',
            background: 'rgba(0,0,0,0.5)'
        });

        // Add visual indicator styles
        if (!document.getElementById('egg-hunter-styles')) {
            const style = document.createElement('style');
            style.id = 'egg-hunter-styles';
            style.innerHTML = `
                @keyframes egg-pulsate-mega {
                    0% { transform: translate(-50%, -50%) scale(1); box-shadow: 0 0 70px 35px rgba(255, 215, 0, 0.6); }
                    50% { transform: translate(-50%, -50%) scale(1.15); box-shadow: 0 0 150px 75px rgba(255, 215, 0, 0.9); }
                    100% { transform: translate(-50%, -50%) scale(1); box-shadow: 0 0 70px 35px rgba(255, 215, 0, 0.6); }
                }
                .ueeh-toast {
                    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
                    background: gold; color: black; padding: 15px 30px; border-radius: 50px;
                    font-weight: bold; font-size: 18px; z-index: 2147483647; box-shadow: 0 5px 15px rgba(0,0,0,0.5);
                    animation: slideUp 0.5s ease-out;
                }
                @keyframes slideUp { from { bottom: -100px; } to { bottom: 20px; } }
            `;
            document.head.appendChild(style);
        }

        // Visual Toast Notification
        const toast = document.createElement('div');
        toast.className = 'ueeh-toast';
        toast.innerText = '🥚 EGG DETECTED! 🥚';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 5000);

        // System Notification
        if (typeof GM_notification === 'function') {
            GM_notification({ title: 'Torn Egg Found!', text: 'An egg has been centered on your screen!', timeout: 10000 });
        }
        
        // Audio Alert
        try {
            new Audio('https://www.myinstants.com/media/sounds/ding-sound-effect.mp3').play().catch(() => {});
        } catch (e) {}
    }

    // --- SIDEBAR UI ---
    function addNavUI() {
        const sidebar = document.querySelector('#sidebarroot') || document.querySelector('.sidebar-menu');
        if (!sidebar || document.getElementById('egg-hunter-container')) return;

        const container = document.createElement('div');
        container.id = 'egg-hunter-container';
        container.style.cssText = `
            background: #1a1a1a; color: #ccc; margin: 10px 5px; padding: 12px;
            border-radius: 8px; border: 1px solid gold; font-family: Arial, sans-serif;
            font-size: 12px; box-shadow: 0 4px 8px rgba(0,0,0,0.7);
        `;

        const header = document.createElement('div');
        header.style.cssText = 'font-weight: bold; color: gold; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;';
        header.innerHTML = '<span>🥚 Egg Hunter v1.1.3</span>';
        
        const toggleBtn = document.createElement('span');
        toggleBtn.id = 'egg-hunter-toggle';
        toggleBtn.style.cssText = 'cursor: pointer; font-size: 10px; padding: 2px 8px; border-radius: 10px; font-weight: bold;';
        updateToggleStyle(toggleBtn);
        toggleBtn.onclick = () => {
            setEnabled(!getEnabled());
            updateToggleStyle(toggleBtn);
            if (getEnabled()) highlightEggs();
        };
        header.appendChild(toggleBtn);

        const progressContainer = document.createElement('div');
        progressContainer.style.cssText = 'height: 4px; background: #333; border-radius: 2px; margin-bottom: 10px; overflow: hidden;';
        const progressBar = document.createElement('div');
        progressBar.id = 'egg-progress-bar';
        const percent = (getNavIndex() / NAV_PAGES.length) * 100;
        progressBar.style.cssText = `height: 100%; width: ${percent}%; background: gold; transition: width 0.3s;`;
        progressContainer.appendChild(progressBar);

        const navBtn = document.createElement('div');
        navBtn.id = 'egg-nav-btn';
        navBtn.style.cssText = `
            background: #222; color: #fff; padding: 10px; cursor: pointer;
            text-align: center; border-radius: 5px; border: 1px solid #444;
            font-weight: bold; transition: all 0.2s;
        `;
        navBtn.onmouseover = () => { navBtn.style.background = '#333'; navBtn.style.borderColor = 'gold'; };
        navBtn.onmouseout = () => { navBtn.style.background = '#222'; navBtn.style.borderColor = '#444'; };
        
        updateNavBtnLabel(navBtn);
        navBtn.onclick = () => navigate(1);

        const footer = document.createElement('div');
        footer.style.cssText = 'display: flex; justify-content: space-between; margin-top: 8px; font-size: 9px; color: #888;';
        
        const prevBtn = document.createElement('span');
        prevBtn.innerText = '← Previous (Alt+Left)';
        prevBtn.style.cursor = 'pointer';
        prevBtn.onclick = () => navigate(-1);

        const resetBtn = document.createElement('span');
        resetBtn.innerText = 'Reset';
        resetBtn.style.cursor = 'pointer';
        resetBtn.onclick = () => { setNavIndex(0); updateNavUI(); };

        footer.appendChild(prevBtn);
        footer.appendChild(resetBtn);

        container.appendChild(header);
        container.appendChild(progressContainer);
        container.appendChild(navBtn);
        container.appendChild(footer);

        const firstChild = sidebar.firstChild;
        if (firstChild) sidebar.insertBefore(container, firstChild);
        else sidebar.appendChild(container);
    }

    function navigate(direction) {
        let idx = getNavIndex(); // Current 1-based index (page to visit next)
        
        if (direction > 0) {
            if (idx >= NAV_PAGES.length) idx = 0;
        } else {
            idx -= 2;
            if (idx < 0) idx = NAV_PAGES.length + idx;
        }
        
        const nextPage = NAV_PAGES[idx];
        setNavIndex(idx + 1);
        window.location.href = `https://www.torn.com/${nextPage}`;
    }

    function updateNavBtnLabel(btn) {
        const currentIndex = getNavIndex();
        btn.innerHTML = `HUNT NEXT PAGE <br> (${currentIndex}/${NAV_PAGES.length})`;
    }

    function updateNavUI() {
        const btn = document.getElementById('egg-nav-btn');
        if (btn) updateNavBtnLabel(btn);
        const bar = document.getElementById('egg-progress-bar');
        if (bar) bar.style.width = `${(getNavIndex() / NAV_PAGES.length) * 100}%`;
    }

    function updateToggleStyle(btn) {
        const enabled = getEnabled();
        btn.innerText = enabled ? 'ACTIVE' : 'DISABLED';
        btn.style.background = enabled ? '#2d4d2d' : '#4d2d2d';
        btn.style.color = enabled ? '#4caf50' : '#f44336';
        btn.style.border = `1px solid ${enabled ? '#4caf50' : '#f44336'}`;
    }

    // --- KEYBOARD SHORTCUTS ---
    function handleKeydown(e) {
        if (e.altKey && e.key === 'ArrowRight') {
            navigate(1);
        } else if (e.altKey && e.key === 'ArrowLeft') {
            navigate(-1);
        }
    }

    // --- STORAGE HELPERS ---
    function getNavIndex() { return parseInt(localStorage.getItem(STORAGE_KEY_NAV_INDEX) || '0', 10); }
    function setNavIndex(idx) { localStorage.setItem(STORAGE_KEY_NAV_INDEX, idx.toString()); }
    function getEnabled() { const val = localStorage.getItem(STORAGE_KEY_ENABLED); return val === null ? true : val === 'true'; }
    function setEnabled(val) { localStorage.setItem(STORAGE_KEY_ENABLED, val.toString()); }

    // --- INITIALIZATION ---
    function init() {
        highlightEggs();
        addNavUI();
        window.addEventListener('keydown', handleKeydown);

        const observer = new MutationObserver(() => {
            if (window.eggHunterTimeout) clearTimeout(window.eggHunterTimeout);
            window.eggHunterTimeout = setTimeout(highlightEggs, 300);
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

})();
