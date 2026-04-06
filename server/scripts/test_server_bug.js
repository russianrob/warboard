const elapsedHrs = 51.5;
const rw_warTarget = 11700; // Original target from API
const myScore = 8425; // Random guess
const warStart = Math.floor(Date.now()/1000) - (elapsedHrs * 3600);

// v4.5.8 Server Logic
const exactDropFactor = Math.max(0.01, 1 - ((elapsedHrs - 24) * 0.01));
const warOrigTarget = Math.round(rw_warTarget / exactDropFactor);
const dropPerHour = warOrigTarget * 0.01;

const lead = myScore;
const totalGap = Math.max(0, warOrigTarget - lead);
const exactWinHour = 24 + (totalGap / dropPerHour);
const hoursRemaining = Math.max(0, exactWinHour - elapsedHrs);

console.log(`v4.5.8 Server Hours Remaining: ${hoursRemaining}`);

// v4.5.7 Server Logic
const dropHrs = Math.floor(elapsedHrs - 24);
const safeDropFactor = Math.max(0.01, 1 - dropHrs * 0.01);
const warOrigTarget_457 = Math.round(rw_warTarget / safeDropFactor);
const dropPerHour_457 = warOrigTarget_457 * 0.01;
const totalGap_457 = Math.max(0, warOrigTarget_457 - lead);
const dropsNeeded = Math.ceil(totalGap_457 / dropPerHour_457);
const winHour = 24 + dropsNeeded;
const winTimestampSec = warStart + (winHour * 3600);
const hrsRemaining_457 = Math.max(0, (winTimestampSec - (Date.now()/1000)) / 3600);

console.log(`v4.5.7 Server Hours Remaining: ${hrsRemaining_457}`);
