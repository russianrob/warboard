const totalElapsedHours = 51.5;
const effectiveScore = 2516;
// UI target at 51 hours
const trueOriginalTarget = 11700;
const currentTarget = Math.round(trueOriginalTarget * (1 - 27 * 0.01)); // 8541

// v4.5.8 logic
const exactDropFactor = Math.max(0.01, 1 - ((totalElapsedHours - 24) * 0.01)); // 0.725
const originalTarget = Math.round(currentTarget / exactDropFactor); // 8541 / 0.725 = 11781
const DROP_PER_HOUR = originalTarget * 0.01; // 117.81

const totalGap = Math.max(0, originalTarget - effectiveScore); // 11781 - 2516 = 9265
const exactWinHour = 24 + (totalGap / DROP_PER_HOUR); // 24 + 78.64 = 102.64
const hoursRemaining = Math.max(0, exactWinHour - totalElapsedHours); // 102.64 - 51.5 = 51.14

console.log(`v4.5.8 Hours Remaining: ${hoursRemaining} (${Math.floor(hoursRemaining)}h ${Math.round((hoursRemaining%1)*60)}m)`);

// v4.5.7 logic
const dropHours = Math.floor(totalElapsedHours - 24); // 27
const safeDropFactor = Math.max(0.01, 1 - (dropHours * 0.01)); // 0.73
const origTarget_457 = currentTarget / safeDropFactor; // 11700
const dropPerHr_457 = origTarget_457 * 0.01; // 117
const totalGap_457 = Math.max(0, origTarget_457 - effectiveScore); // 11700 - 2516 = 9184
const exactWinHour_457 = 24 + Math.ceil(totalGap_457 / dropPerHr_457); // 24 + Math.ceil(78.49) = 103

const approximateWarStartMs = Date.now() - (totalElapsedHours * 3600000);
const warTimerEtaMs = approximateWarStartMs + (exactWinHour_457 * 3600000);
const msRemaining = warTimerEtaMs - Date.now();
const hrsLeft_457 = Math.max(0, msRemaining / 3600000);
console.log(`v4.5.7 Hours Remaining: ${hrsLeft_457}`);

// Oldest logic (v4.5.4)
const gap_old = currentTarget - effectiveScore; // 8541 - 2516 = 6025
const hoursRemaining_old = gap_old / dropPerHr_457; // 6025 / 117 = 51.49
console.log(`v4.5.4 Hours Remaining: ${hoursRemaining_old}`);
