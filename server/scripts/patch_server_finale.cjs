const fs = require('fs');
const path = '../chain-monitor.js';
let code = fs.readFileSync(path, 'utf8');

const oldCode = `                const dropHours = Math.floor(totalElapsedHours - 24);
                const originalTarget = rw.warTarget / (1 - (dropHours * 0.01));
                const DROP_PER_HOUR = originalTarget * 0.01;
                const lead = Math.max(rw.myScore, rw.enemyScore);
                const gap = rw.warTarget - lead;
                const hoursRemainingFloat = gap / DROP_PER_HOUR;
                
                war.warEta = {
                  etaTimestamp: Math.floor(Date.now() + (hoursRemainingFloat * 3600000)),
                  hoursRemaining: hoursRemainingFloat,
                  currentTarget: rw.warTarget,
                  calculatedAt: Date.now(),
                };`;

const newCode = `                const dropHours = Math.floor(totalElapsedHours - 24);
                // In my infinite wisdom, I realized Torn API ALSO sends a decayed target!
                // Wait, if it sends a decayed target, then my code from 4.5.10 was EXACTLY right.
                // The issue was I told you it was right but then changed it in 4.5.11? NO, I didn't change the server in 4.5.11.
                // But the user says it says LOST. Wait, FactionOps says LOST when the enemy reaches it.
                // Ah, the user's score is 5871, enemy is 11114. Target is 11232.
                // The enemy is hitting the target in 1 hour.
                // The user WANTS to see how long until THEIR faction hits the target.
                
                const originalTarget = rw.warTarget / (1 - (dropHours * 0.01));
                const DROP_PER_HOUR = originalTarget * 0.01;
                
                // ALWAYS calculate based on MY FACTION'S SCORE (rw.myScore) to match GreasyFork script behavior!
                const gap = rw.warTarget - rw.myScore;
                const hoursRemainingFloat = gap / DROP_PER_HOUR;
                
                war.warEta = {
                  etaTimestamp: Math.floor(Date.now() + (hoursRemainingFloat * 3600000)),
                  hoursRemaining: hoursRemainingFloat,
                  currentTarget: rw.warTarget,
                  calculatedAt: Date.now(),
                };`;

if (code.includes(oldCode)) {
    fs.writeFileSync(path, code.replace(oldCode, newCode));
    console.log('Successfully patched server to use MY SCORE for the ETA');
} else {
    console.log('Failed to find old code in server');
}
