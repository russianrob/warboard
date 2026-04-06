// Find a combination of inputs that results in exactly 1.48 hours remaining
for (let score = 0; score <= 11700; score += 100) {
    for (let target = 8000; target <= 11700; target += 500) {
        for (let elapsed = 24; elapsed <= 100; elapsed += 1) {
            const exactDropFactor = Math.max(0.01, 1 - ((elapsed - 24) * 0.01));
            const warOrigTarget = Math.round(target / exactDropFactor);
            const dropPerHour = warOrigTarget * 0.01;
            const totalGap = Math.max(0, warOrigTarget - score);
            const exactWinHour = 24 + (totalGap / dropPerHour);
            const hoursRemaining = Math.max(0, exactWinHour - elapsed);
            if (hoursRemaining >= 1.48 && hoursRemaining <= 1.49) {
                console.log(`FOUND! Score: ${score}, Target: ${target}, Elapsed: ${elapsed}, HrsRem: ${hoursRemaining}`);
            }
        }
    }
}
