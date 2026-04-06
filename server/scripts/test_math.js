const elapsed = 51.51666;
const currentTarget = 8541; // Just a guess
const effectiveScore = 8424;

// Continuous math without Math.floor
const dropFactor = 1 - (elapsed - 24) * 0.01;
const originalTarget = currentTarget / dropFactor;
const dropPerHour = originalTarget * 0.01;
const gap = currentTarget - effectiveScore;
const hoursRemaining = gap / dropPerHour;

console.log(`Original Target: ${originalTarget}`);
console.log(`Hours Remaining: ${hoursRemaining} (${hoursRemaining * 60} mins)`);
