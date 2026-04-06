const elapsedHrs = 51.51666; // 51h 31m
const rw = { warTarget: 8541, myScore: 8425, enemyScore: 0 };
const warStart = Date.now() / 1000 - (elapsedHrs * 3600);

const dropHrs = Math.floor(elapsedHrs - 24);
const safeDropFactor = Math.max(0.01, 1 - dropHrs * 0.01);
const warOrigTarget = Math.round(rw.warTarget / safeDropFactor);
const dropPerHour = warOrigTarget * 0.01;

const lead = Math.max(rw.myScore, rw.enemyScore);
const totalGap = Math.max(0, warOrigTarget - lead);
const dropsNeeded = Math.ceil(totalGap / dropPerHour);
const winHour = 24 + dropsNeeded;
const winTimestampSec = warStart + (winHour * 3600);

const hrsRemaining = Math.max(0, (winTimestampSec - (Date.now() / 1000)) / 3600);

console.log(`Original Target: ${warOrigTarget}`);
console.log(`Drops Needed: ${dropsNeeded}`);
console.log(`Win Hour: ${winHour}`);
console.log(`Hours Remaining: ${hrsRemaining} (${hrsRemaining * 60} mins)`);
