const target = 11700; // Original target from API
for (let score = 0; score <= 16000; score += 100) {
    for (let elapsed = 45; elapsed <= 55; elapsed += 0.1) {
        const exactDropFactor = Math.max(0.01, 1 - ((elapsed - 24) * 0.01));
        const warOrigTarget = Math.round(target / exactDropFactor);
        const dropPerHour = warOrigTarget * 0.01;
        const totalGap = Math.max(0, warOrigTarget - score);
        const exactWinHour = 24 + (totalGap / dropPerHour);
        const hoursRemaining = Math.max(0, exactWinHour - elapsed);
        if (hoursRemaining >= 1.48 && hoursRemaining <= 1.5) {
            console.log(`FOUND bug! Score: ${score}, Elapsed: ${elapsed}, HrsRem: ${hoursRemaining}`);
        }
    }
}
