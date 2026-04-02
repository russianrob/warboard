// ==UserScript==
// @name         Torn Easter Egg Hunter 2026
// @namespace    torn.easter.egg.hunter
// @version      1.2.2
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
    const EGG_COLORS = {
        618: 'Green', 619: 'Red', 620: 'Yellow', 621: 'White',
        622: 'Black', 623: 'Blue', 624: 'Brown', 625: 'Purple', 626: 'Gold'
    };
    
    // FULL LIST of 315+ pages extracted from Ultimate Hunter
    const NAV_PAGES = [
        "index.php", "preferences.php", "personalstats.php", "personalstats.php?ID=1", "playerreport.php", "page.php?sid=report#/add", "authenticate.php", "page.php?sid=log", "page.php?sid=events", "page.php?sid=events#onlySaved=true", "events.php#/step=all",
        "profiles.php?XID=1", "profiles.php?XID=3", "profiles.php?XID=4", "profiles.php?XID=7", "profiles.php?XID=8", "profiles.php?XID=9", "profiles.php?XID=10", "profiles.php?XID=15", "profiles.php?XID=17", "profiles.php?XID=19", "profiles.php?XID=20", "profiles.php?XID=21", "profiles.php?XID=23", "profiles.php?XID=50", "profiles.php?XID=100", "profiles.php?XID=101", "profiles.php?XID=102", "profiles.php?XID=103", "profiles.php?XID=104",
        "page.php?sid=gallery&XID=1", "page.php?sid=awards&tab=honors", "page.php?sid=awards&tab=medals", "page.php?sid=awards&tab=merits", "page.php?sid=hof", "revive.php", "pc.php", "city.php", "citystats.php", "usersonline.php", "page.php?sid=UserList", "index.php?page=people", "index.php?page=fortune", "index.php?page=rehab", "index.php?page=hunting",
        "item.php", "page.php?sid=itemsMods", "page.php?sid=ammo", "itemuseparcel.php", "displaycase.php", "displaycase.php#display/1", "displaycase.php#display/4", "displaycase.php#display/7", "displaycase.php#display/10", "displaycase.php#display/15", "displaycase.php#display/50", "displaycase.php#manage", "displaycase.php#add", "keepsakes.php", "trade.php", "museum.php", "amarket.php", "pmarket.php", "page.php?sid=ItemMarket", "page.php?sid=ItemMarket#/market/view=category&categoryName=Most%20Popular",
        "page.php?sid=bazaar", "bazaar.php#/add", "bazaar.php#/manage", "bazaar.php#/personalize", "bazaar.php?userId=1", "bazaar.php?userId=4", "bazaar.php?userId=7", "bazaar.php?userId=10", "bazaar.php?userId=15", "bazaar.php?userId=19", "bazaar.php?userId=20", "bazaar.php?userId=21", "bazaar.php?userId=23", "bazaar.php?userId=50",
        "page.php?sid=stocks", "bank.php", "points.php", "loan.php", "donator.php", "donatordone.php", "token_shop.php", "freebies.php", "bringafriend.php", "bounties.php", "bounties.php#!p=main", "bounties.php#/p=add", "jailview.php", "hospitalview.php",
        "casino.php", "loader.php?sid=slots", "loader.php?sid=roulette", "loader.php?sid=blackjack", "loader.php?sid=poker", "loader.php?sid=bookie", "loader.php?sid=lottery", "loader.php?sid=keno", "loader.php?sid=highlow", "loader.php?sid=craps", "page.php?sid=slots", "page.php?sid=slotsLastRolls", "page.php?sid=slotsStats", "page.php?sid=roulette", "page.php?sid=rouletteLastSpins", "page.php?sid=rouletteStatistics", "page.php?sid=highlow", "page.php?sid=highlowLastGames", "page.php?sid=highlowStats", "page.php?sid=keno", "page.php?sid=kenoLastGames", "page.php?sid=kenoStatistics", "page.php?sid=craps", "page.php?sid=crapsLastRolls", "page.php?sid=crapsStats", "page.php?sid=bookie", "page.php?sid=bookie#/your-bets", "page.php?sid=bookie#/stats/", "page.php?sid=lottery", "page.php?sid=lotteryTicketsBought", "page.php?sid=lotteryPreviousWinners", "page.php?sid=blackjack", "page.php?sid=blackjackLastGames", "page.php?sid=blackjackStatistics", "page.php?sid=holdem", "page.php?sid=holdemStats", "page.php?sid=holdemFull", "page.php?sid=russianRoulette", "loader.php?sid=viewRussianRouletteLastGames", "loader.php?sid=viewRussianRouletteStats", "page.php?sid=spinTheWheel", "page.php?sid=spinTheWheelLastSpins", "loader.php?sid=slotsLastRolls", "loader.php?sid=viewSlotsStats", "loader.php?sid=rouletteLastSpins", "loader.php?sid=rouletteStatistics", "loader.php?sid=viewHighLowLastGames", "loader.php?sid=viewHighLowStats", "loader.php?sid=crapsLastRolls", "loader.php?sid=viewCrapsStats", "loader.php?sid=viewLotteryUserStats", "loader.php?sid=viewLotteryStats", "loader.php?sid=viewBlackjackLastGames", "loader.php?sid=viewBlackjackStats",
        "bigalgunshop.php", "shops.php?step=bitsnbobs", "shops.php?step=cyberforce", "shops.php?step=docks", "shops.php?step=jewelry", "shops.php?step=nikeh", "shops.php?step=pawnshop", "shops.php?step=pharmacy", "shops.php?step=postoffice", "shops.php?step=printstore", "shops.php?step=recyclingcenter", "shops.php?step=super", "shops.php?step=candy", "shops.php?step=clothes", "page.php?sid=bunker", "estateagents.php",
        "properties.php", "properties.php#/p=yourProperties", "properties.php#/p=spousesProperties", "properties.php?step=rentalmarket", "properties.php?step=sellingmarket", "properties.php?step=rentalmarket#/property=13", "properties.php?step=sellingmarket#/property=13",
        "education.php", "education.php#/step=main", "page.php?sid=education", "gym.php", "crimes.php", "crimes.php#/", "missions.php", "loader.php?sid=missions", "newspaper.php", "newspaper.php#/archive", "newspaper.php#/tell_your_story", "newspaper.php#!/articles/1126", "newspaper_class.php", "comics.php#!p=main", "job.php", "jobs.php", "joblist.php#!p=main", "joblisting.php", "factions.php", "travelagency.php", "page.php?sid=travel", "raceway.php", "loader.php?sid=racing",
        "crimes.php#/searchforcash", "crimes.php#/bootlegging", "crimes.php#/graffiti", "crimes.php#/shoplifting", "crimes.php#/burglary", "crimes.php#/hustling", "crimes.php#/pickpocketing", "crimes.php#/cracking", "page.php?sid=crimes2", "page.php?sid=criminalrecords", "page.php?sid=crimesRecord", "page.php?sid=crimes#/searchforcash", "page.php?sid=crimes#/bootlegging", "page.php?sid=crimes#/graffiti", "page.php?sid=crimes#/shoplifting", "page.php?sid=crimes#/pickpocketing", "page.php?sid=crimes#/cardskimming", "page.php?sid=crimes#/burglary", "page.php?sid=crimes#/hustling", "page.php?sid=crimes#/disposal", "page.php?sid=crimes#/cracking", "page.php?sid=crimes#/forgery", "page.php?sid=crimes#/scamming", "page.php?sid=crimes#/arson", "loader.php?sid=crimes", "loader.php?sid=crimes#/searchforcash", "loader.php?sid=crimes#/bootlegging", "loader.php?sid=crimes#/graffiti", "loader.php?sid=crimes#/shoplifting", "loader.php?sid=crimes#/pickpocketing", "loader.php?sid=crimes#/cardskimming", "loader.php?sid=crimes#/burglary", "loader.php?sid=crimes#/hustling", "loader.php?sid=crimes#/disposal", "loader.php?sid=crimes#/cracking", "loader.php?sid=crimes#/forgery", "loader.php?sid=crimes#/scamming",
        "factions.php?step=your", "factions.php?step=your#/tab=info", "factions.php?step=your#/tab=rank", "factions.php?step=your#/tab=territory", "factions.php?step=your&type=12#/tab=crimes", "factions.php?step=your#/tab=upgrades", "factions.php?step=your#/tab=controls", "factions.php?step=your#/tab=armoury", "factions.php?step=your&type=1#/tab=armoury&start=0&sub=weapons", "factions.php?step=your&type=1#/tab=armoury&start=0&sub=armour", "factions.php?step=your&type=1#/tab=armoury&start=0&sub=medical", "factions.php?step=your&type=1#/tab=armoury&start=0&sub=drugs", "factions.php?step=your&type=1#/tab=armoury&start=0&sub=boosters", "factions.php?step=your&type=1#/tab=armoury&start=0&sub=temporary", "factions.php?step=your&type=1#/tab=armoury&start=0&sub=consumables", "factions.php?step=your&type=1#/tab=armoury&start=0&sub=utilities", "factions.php?step=your&type=1#/tab=armoury&start=0&sub=loot", "factions.php?step=your&type=1#/tab=armoury&start=0&sub=points", "factions.php?step=your&type=1#/tab=armoury&start=0&sub=donate", "page.php?sid=factionWarfare", "page.php?sid=factionWarfare#/ranked", "page.php?sid=factionWarfare#/territory", "page.php?sid=factionWarfare#/raids", "page.php?sid=factionWarfare#/chains", "page.php?sid=factionWarfare#/dirty-bombs",
        "forums.php", "forums.php#/p=forums&f=1", "forums.php#/p=forums&f=2", "forums.php#/p=forums&f=67", "forums.php#p=newthread&f=61&b=0&a=0", "old_forums.php",
        "staff.php", "staff.php#/p=helpapp", "rules.php", "rules.php#tab=torn_rules", "rules.php#tab=privacy_policy", "rules.php#tab=terms_of_use", "rules.php#tab=acceptable_use", "rules.php#tab=terms_of_supply", "donates.php", "halloffame.php", "competition.php", "calendar.php", "credits.php", "committee.php#/step=main", "archives.php", "archives.php#/TheBirthOfTorn", "archives.php#/Factions", "archives.php#/Employment", "archives.php#/TheMarkets", "archives.php#/RealEstate", "church.php", "church.php?step=proposals", "christmas_town.php#/", "christmas_town.php#/mymaps", "christmas_town.php#/mapeditor", "christmas_town.php#/parametereditor", "christmas_town.php#/npceditor",
        "friendlist.php", "friendlist.php#p=add", "enemylist.php", "blacklist.php", "blacklist.php#p=add", "page.php?sid=list&type=friends", "page.php?sid=list&type=enemies", "page.php?sid=list&type=targets", "messages.php", "messages.php#/p=inbox", "messages.php#/p=compose", "messages.php#/p=outbox", "messages.php#/p=saved", "messages.php#/p=ignorelist", "messageinc.php", "messageinc.php#/p=send", "messageinc2.php#!p=main", "messageinc2.php#!p=viewall", "fans.php", "personals.php#!p=main", "personals.php#!p=search&type=2", "personals.php#/p=add", "dump.php", "dump.php#/trash"
    ];

    const STORAGE_KEY_NAV_INDEX = 'torn_egg_nav_index';
    const STORAGE_KEY_ENABLED = 'torn_egg_hunter_enabled';
    const STORAGE_KEY_ROUTE = 'torn_egg_route';
    const STORAGE_KEY_MINIMIZED = 'torn_egg_minimized';

    // --- AUDIO HELPER ---
    function playBeep() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gainNode = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(880, ctx.currentTime);
            gainNode.gain.setValueAtTime(0.1, ctx.currentTime);
            osc.connect(gainNode);
            gainNode.connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 0.3);
        } catch(e) {}
    }

    // --- EGG FINDER LOGIC ---
    function highlightEggs() {
        if (!getEnabled()) return;

        // 1. Detection via Native Container (Most Robust)
        const nativeRoot = document.getElementById('easter-egg-hunt-root');
        if (nativeRoot) {
            const eggImages = nativeRoot.querySelectorAll('img');
            eggImages.forEach(img => {
                let color = null;
                for (let [id, col] of Object.entries(EGG_COLORS)) {
                    if (img.src.includes(`/items/${id}/`)) { color = col; break; }
                }
                processEgg(img, color);
            });
        }

        // 2. Detection via Image Scan (Fallback/Safety)
        const allImages = document.getElementsByTagName('img');
        for (let img of allImages) {
            // Ignore UI icons, large banners, and images inside specific containers (chat, profiles, etc.)
            if (
                img.width < 20 ||
                img.width > 150 ||
                img.height < 20 ||
                img.closest('[class*="filter"], [class*="category"], [class*="calendar"], [class*="title-black"], [class*="museum"], [class*="inventory"], [class*="item-wrap"], [class*="display"], [class*="chat"], [class*="profile-image"], [class*="user-info"], [class*="signature"]')
            ) {
                continue;
            }

            const cleanSrc = img.src.split('?')[0].split('#')[0];
            let foundColor = null;
            let isEgg = false;
            
            for (let [id, col] of Object.entries(EGG_COLORS)) {
                if (cleanSrc.includes(`/items/${id}/`)) { 
                    foundColor = col; 
                    isEgg = true;
                    break; 
                }
            }

            if (!isEgg && (cleanSrc.includes('easter_egg') || cleanSrc.includes('easter-egg'))) {
                isEgg = true;
            }

            if (isEgg) processEgg(img, foundColor);
        }
    }

    function processEgg(img, color) {
        if (img.dataset.foundByHunter) return;
        img.dataset.foundByHunter = "true";

        console.log("%c [EGG FOUND!] ", "background: #222; color: #bada55; font-size: 20px;");
        
        let parent = img.parentElement;
        while (parent && parent !== document.body) {
            parent.style.overflow = 'visible';
            parent = parent.parentElement;
        }

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

        const toast = document.createElement('div');
        toast.className = 'ueeh-toast';
        toast.innerText = color ? `🥚 ${color.toUpperCase()} EGG DETECTED! 🥚` : '🥚 EGG DETECTED! 🥚';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 5000);

        if (typeof GM_notification === 'function') {
            GM_notification({ title: 'Torn Egg Found!', text: 'An egg has been centered on your screen!', timeout: 10000 });
        }
        
        playBeep();
    }

    // --- SIDEBAR UI ---
    function addNavUI() {
        if (window.location.href.includes('sid=attack')) return; // Hide on attack pages

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
        header.style.cssText = 'font-weight: bold; color: gold; margin-bottom: 5px; display: flex; justify-content: space-between; align-items: center;';
        header.innerHTML = '<span>🥚 Egg Hunter v1.2.2</span>';
        
        const headerControls = document.createElement('div');
        headerControls.style.cssText = 'display: flex; align-items: center;';

        const toggleBtn = document.createElement('span');
        toggleBtn.id = 'egg-hunter-toggle';
        toggleBtn.style.cssText = 'cursor: pointer; font-size: 10px; padding: 2px 8px; border-radius: 10px; font-weight: bold;';
        updateToggleStyle(toggleBtn);
        toggleBtn.onclick = () => {
            setEnabled(!getEnabled());
            updateToggleStyle(toggleBtn);
            if (getEnabled()) highlightEggs();
        };
        headerControls.appendChild(toggleBtn);

        const minimizeBtn = document.createElement('span');
        minimizeBtn.innerText = '✖';
        minimizeBtn.title = 'Minimize Hunter';
        minimizeBtn.style.cssText = 'cursor: pointer; font-size: 14px; margin-left: 8px; color: #aaa; transition: color 0.2s; line-height: 1;';
        minimizeBtn.onmouseover = () => minimizeBtn.style.color = '#fff';
        minimizeBtn.onmouseout = () => minimizeBtn.style.color = '#aaa';
        minimizeBtn.onclick = () => {
            GM_setValue(STORAGE_KEY_MINIMIZED, true);
            updateVisibility();
        };
        headerControls.appendChild(minimizeBtn);

        header.appendChild(headerControls);

        const routeControls = document.createElement('div');
        routeControls.style.cssText = 'display: flex; justify-content: space-between; margin-bottom: 10px; font-size: 10px;';
        
        const isShuffled = getRoute()[0] !== NAV_PAGES[0];
        const shuffleBtn = document.createElement('span');
        shuffleBtn.id = 'egg-shuffle-btn';
        shuffleBtn.innerText = isShuffled ? '🔀 Route: Shuffled' : '▶ Route: Default';
        shuffleBtn.style.cursor = 'pointer';
        shuffleBtn.style.color = isShuffled ? '#bada55' : '#ccc';
        shuffleBtn.onclick = () => {
            if (getRoute()[0] !== NAV_PAGES[0]) resetRoute();
            else shuffleCurrentRoute();
        };
        routeControls.appendChild(shuffleBtn);

        const progressContainer = document.createElement('div');
        progressContainer.style.cssText = 'height: 4px; background: #333; border-radius: 2px; margin-bottom: 10px; overflow: hidden;';
        const progressBar = document.createElement('div');
        progressBar.id = 'egg-progress-bar';
        progressBar.style.cssText = `height: 100%; width: 0%; background: gold; transition: width 0.3s;`;
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
        container.appendChild(routeControls);
        container.appendChild(progressContainer);
        container.appendChild(navBtn);
        container.appendChild(footer);

        const firstChild = sidebar.firstChild;
        if (firstChild) sidebar.insertBefore(container, firstChild);
        else sidebar.appendChild(container);

        // Setup Floating Minimized Egg Icon
        let miniEgg = document.getElementById('egg-hunter-minimized');
        if (!miniEgg) {
            miniEgg = document.createElement('div');
            miniEgg.id = 'egg-hunter-minimized';
            miniEgg.innerHTML = '🥚';
            miniEgg.style.cssText = `
                position: fixed; bottom: 20px; right: 20px; font-size: 24px;
                cursor: pointer; z-index: 2147483647; background: rgba(0,0,0,0.8);
                border: 2px solid gold; border-radius: 50%; width: 45px; height: 45px;
                display: none; align-items: center; justify-content: center;
                box-shadow: 0 0 10px rgba(255, 215, 0, 0.5); transition: transform 0.2s;
            `;
            miniEgg.title = "Restore Egg Hunter UI";
            miniEgg.onmouseover = () => miniEgg.style.transform = 'scale(1.1)';
            miniEgg.onmouseout = () => miniEgg.style.transform = 'scale(1)';
            miniEgg.onclick = () => {
                GM_setValue(STORAGE_KEY_MINIMIZED, false);
                updateVisibility();
            };
            document.body.appendChild(miniEgg);
        }

        updateVisibility();
        updateNavUI();
    }

    function updateVisibility() {
        const isMin = GM_getValue(STORAGE_KEY_MINIMIZED, false);
        const container = document.getElementById('egg-hunter-container');
        const miniEgg = document.getElementById('egg-hunter-minimized');
        if (container) container.style.display = isMin ? 'none' : 'block';
        if (miniEgg) miniEgg.style.display = isMin ? 'flex' : 'none';
    }

    function navigate(direction) {
        let idx = getNavIndex();
        const route = getRoute();
        
        if (direction > 0) {
            if (idx >= route.length) idx = 0;
        } else {
            idx -= 2;
            if (idx < 0) idx = route.length + idx;
        }
        
        const nextPage = route[idx];
        setNavIndex(idx + 1);

        // Humanized Delay
        const delay = Math.floor(Math.random() * 200) + 100;
        setTimeout(() => {
            window.location.href = `https://www.torn.com/${nextPage}`;
        }, delay);
    }

    function updateNavUI() {
        const route = getRoute();
        const btn = document.getElementById('egg-nav-btn');
        if (btn) btn.innerHTML = `HUNT NEXT PAGE <br> (${getNavIndex()}/${route.length})`;
        
        const bar = document.getElementById('egg-progress-bar');
        if (bar) bar.style.width = `${(getNavIndex() / route.length) * 100}%`;

        const shuffleBtn = document.getElementById('egg-shuffle-btn');
        if (shuffleBtn) {
            const isShuffled = route[0] !== NAV_PAGES[0];
            shuffleBtn.innerText = isShuffled ? '🔀 Route: Shuffled' : '▶ Route: Default';
            shuffleBtn.style.color = isShuffled ? '#bada55' : '#ccc';
        }
    }

    function updateToggleStyle(btn) {
        const enabled = getEnabled();
        btn.innerText = enabled ? 'ACTIVE' : 'DISABLED';
        btn.style.background = enabled ? '#2d4d2d' : '#4d2d2d';
        btn.style.color = enabled ? '#4caf50' : '#f44336';
        btn.style.border = `1px solid ${enabled ? '#4caf50' : '#f44336'}`;
    }

    // --- ROUTE & STORAGE HELPERS ---
    function shuffleCurrentRoute() {
        let route = [...NAV_PAGES];
        for (let i = route.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [route[i], route[j]] = [route[j], route[i]];
        }
        setRoute(route);
        setNavIndex(0);
        updateNavUI();
    }

    function resetRoute() {
        setRoute(NAV_PAGES);
        setNavIndex(0);
        updateNavUI();
    }

    function getNavIndex() { return GM_getValue(STORAGE_KEY_NAV_INDEX, 0); }
    function setNavIndex(idx) { GM_setValue(STORAGE_KEY_NAV_INDEX, idx); }
    function getEnabled() { return GM_getValue(STORAGE_KEY_ENABLED, true); }
    function setEnabled(val) { GM_setValue(STORAGE_KEY_ENABLED, val); }
    function getRoute() { return GM_getValue(STORAGE_KEY_ROUTE, NAV_PAGES); }
    function setRoute(route) { GM_setValue(STORAGE_KEY_ROUTE, route); }

    // --- KEYBOARD SHORTCUTS ---
    function handleKeydown(e) {
        if (e.altKey && e.key === 'ArrowRight') {
            navigate(1);
        } else if (e.altKey && e.key === 'ArrowLeft') {
            navigate(-1);
        }
    }

    // --- INITIALIZATION ---
    function init() {
        highlightEggs();
        addNavUI();
        window.addEventListener('keydown', handleKeydown);

        const observer = new MutationObserver((mutations) => {
            let hasAddedNodes = mutations.some(m => m.addedNodes.length > 0);
            if (!hasAddedNodes) return;

            if (window.eggHunterTimeout) clearTimeout(window.eggHunterTimeout);
            window.eggHunterTimeout = setTimeout(() => {
                highlightEggs();
                addNavUI();
            }, 300);
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

})();