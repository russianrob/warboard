const elapsedHrs = 27.72;
const rw_warTarget = 11700; // Original target from API
const lead = 5500; // Guessing their score

const dropHours = Math.floor(elapsedHrs - 24); // 3
const originalTarget = rw_warTarget;
const currentDecayedTarget = Math.round(originalTarget * (1 - (dropHours * 0.01))); // 11700 * 0.97 = 11349
const DROP_PER_HOUR = originalTarget * 0.01; // 117
const gap = currentDecayedTarget - lead; // 11349 - 5500 = 5849
const hoursRemainingFloat = gap / DROP_PER_HOUR; // 5849 / 117 = 49.99

console.log(`Drop Hours: ${dropHours}`);
console.log(`Original Target: ${originalTarget}`);
console.log(`Current Decayed Target: ${currentDecayedTarget}`);
console.log(`Drop Per Hour: ${DROP_PER_HOUR}`);
console.log(`Gap: ${gap}`);
console.log(`Hours Remaining: ${hoursRemainingFloat}`);
