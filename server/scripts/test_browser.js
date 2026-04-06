const state = {
    warScores: { myScore: 3000, enemyScore: 5102 },
    warEta: { currentTarget: 11700 }
};
const document = {
    documentElement: { textContent: "WAR 48:00:00" },
    getElementById: () => ({}),
    querySelector: () => null
};

        let lead = null, currentTarget = null, totalElapsedHours = null;
        let timerDays = 0, timerHours = 0, timerMinutes = 0;

        if (state.warScores) {
            lead = Math.max(state.warScores.myScore || 0, state.warScores.enemyScore || 0);
        }
        if (state.warEta && state.warEta.currentTarget) {
            currentTarget = state.warEta.currentTarget;
        }

        const allText = document.documentElement.textContent || "";
        const timeMatches = [...allText.matchAll(/(?:WAR\s*)?(?:(\d+)\s*[dD]\s*)?(\d{1,3})\s*:\s*(\d{2})(?:\s*:\s*(\d{2}))?/gi)];
        for (let m of timeMatches) {
            const p1 = parseInt(m[1]) || 0, p2 = parseInt(m[2]) || 0, p3 = parseInt(m[3]) || 0, p4 = m[4] ? parseInt(m[4]) : null;
            if (p1 > 7 || p2 > 100) continue;
            if (p4 !== null || p1 > 0 || p2 > 5 || m[0].toUpperCase().includes('WAR')) {
                timerDays = p1; timerHours = p2; timerMinutes = p3;
                break;
            }
        }

        totalElapsedHours = (timerDays * 24) + timerHours + (timerMinutes / 60);

        const myFactionScore = (state.warScores && state.warScores.myScore != null) ? state.warScores.myScore : lead;
        const effectiveScore = myFactionScore;

        const calculateHoursRemaining = (goal, isDecaying) => {
            const scoreToUse = lead !== null ? lead : effectiveScore;
            const currentGap = goal - scoreToUse;
            if (currentGap <= 0) return 0;

            const dropHours = Math.max(0, Math.floor(totalElapsedHours - 24));
            const originalTarget = currentTarget / (1 - (dropHours * 0.01));
            const DROP_PER_HOUR = isDecaying ? (originalTarget * 0.01) : 0;

            if (totalElapsedHours >= 24) {
                const closingSpeed = DROP_PER_HOUR;
                return closingSpeed > 0 ? (currentGap / closingSpeed) : 999;
            } else {
                const timeTo24h = 24 - totalElapsedHours;
                return timeTo24h + (DROP_PER_HOUR > 0 ? (currentGap / DROP_PER_HOUR) : 999);
            }
        };

        const hoursRemainingFloat = calculateHoursRemaining(currentTarget, true);
        console.log("hoursRemainingFloat:", hoursRemainingFloat);
