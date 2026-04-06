const totalElapsedHours = 48;
const lead = 11116;
const myScore = 5871;
const enemyScore = 11116;
const effectiveScore = myScore;

// From server
const originalTarget = 11232;
const dropHours_server = Math.floor(totalElapsedHours - 24);
const currentDecayedTarget = Math.round(originalTarget * (1 - (dropHours_server * 0.01)));

// Client logic
let currentTarget = currentDecayedTarget;
let timerDays = 2, timerHours = 0, timerMinutes = 0; // 48h
let totalElapsedHours_client = (timerDays * 24) + timerHours + (timerMinutes / 60);

const calculateHoursRemaining = (goal, isDecaying) => {
    const scoreToUse = lead !== null ? lead : effectiveScore;
    const currentGap = goal - scoreToUse;
    if (currentGap <= 0) return 0;

    const dropHours = Math.max(0, Math.floor(totalElapsedHours_client - 24));
    const originalTarget = currentTarget / (1 - (dropHours * 0.01));
    const DROP_PER_HOUR = isDecaying ? (originalTarget * 0.01) : 0;

    if (totalElapsedHours_client >= 24) {
        const closingSpeed = DROP_PER_HOUR;
        return closingSpeed > 0 ? (currentGap / closingSpeed) : 999;
    } else {
        const timeTo24h = 24 - totalElapsedHours_client;
        return timeTo24h + (DROP_PER_HOUR > 0 ? (currentGap / DROP_PER_HOUR) : 999);
    }
};

const hoursRemainingFloat = calculateHoursRemaining(currentTarget, true);
console.log({
    currentTarget,
    lead,
    currentGap: currentTarget - lead,
    hoursRemainingFloat
});
