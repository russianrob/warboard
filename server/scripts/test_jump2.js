const totalElapsedHours = 51.5;
const currentTarget = 8541;
const score = 2516;
const exactDropFactor = Math.max(0.01, 1 - ((totalElapsedHours - 24) * 0.01));
const origTarget = Math.round(currentTarget / exactDropFactor);
const dropPerHr = origTarget * 0.01;

// "totalGap" vs old "gap"
const gap_old = currentTarget - score;
const hrsLeft_old = gap_old / dropPerHr;

const totalGap = Math.max(0, origTarget - score);
const exactWinHour = 24 + (totalGap / dropPerHr);
const approximateWarStartMs = Date.now() - (totalElapsedHours * 3600000);
const warTimerEtaMs = approximateWarStartMs + (exactWinHour * 3600000);
const msRemaining = warTimerEtaMs - Date.now();
const hrsLeft_new = Math.max(0, msRemaining / 3600000);

console.log(`Old Hrs Left: ${hrsLeft_old}`);
console.log(`New Hrs Left: ${hrsLeft_new}`);

// Wait, what if totalElapsedHours is parsed from "51:29"?
// If timer string was "51:29", totalElapsedHours = 51 + 29/60 = 51.483.
// Wait! What if timer parser logic in 4.5.6 broke and parsed it wrong?
const timeParts = ["51", "29"];
let timerDays = 0, timerHours = 0, timerMinutes = 0, totalElapsedHours_parsed = 0;
if (timeParts.length === 3) {
    const hh = parseInt(timeParts[0], 10) || 0;
    timerDays = Math.floor(hh / 24);
    timerHours = hh % 24;
    timerMinutes = parseInt(timeParts[1], 10) || 0;
} else if (timeParts.length === 2) {
    // I DID NOT ADD A 2-LENGTH CHECK IN 4.5.6!!
}
