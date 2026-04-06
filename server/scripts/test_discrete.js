const totalElapsedHours = 51.51666; // 51 hours, 31 mins
const currentTarget = 8541; // Target at 51 hours
const effectiveScore = 8450; // A score that wins at 52 hours

const dropHours = Math.floor(totalElapsedHours - 24);
const safeDropFactor = Math.max(0.01, 1 - (dropHours * 0.01));
const originalTarget = currentTarget / safeDropFactor;
const DROP_PER_HOUR = originalTarget * 0.01;

const totalGap = Math.max(0, originalTarget - effectiveScore);
const dropsNeeded = Math.ceil(totalGap / DROP_PER_HOUR);
const winHour = 24 + dropsNeeded;

const approximateWarStartMs = Date.now() - (totalElapsedHours * 3600000);
const warTimerEtaMs = approximateWarStartMs + (winHour * 3600000);
const msRemaining = warTimerEtaMs - Date.now();
const hoursRemaining = Math.max(0, msRemaining / 3600000);

console.log(`Original Target: ${originalTarget}`);
console.log(`Total Gap: ${totalGap}`);
console.log(`Drop Per Hour: ${DROP_PER_HOUR}`);
console.log(`Drops Needed: ${dropsNeeded}`);
console.log(`Win Hour: ${winHour}`);
console.log(`Hours Remaining: ${hoursRemaining} (${hoursRemaining * 60} mins)`);
