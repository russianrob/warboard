const fs = require('fs');
const path = '../chain-monitor.js';
let code = fs.readFileSync(path, 'utf8');

const oldCode = `                const originalTarget = rw.warTarget / (1 - (dropHours * 0.01));
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

const newCode = `                const originalTarget = rw.warTarget / (1 - (dropHours * 0.01));
                const DROP_PER_HOUR = originalTarget * 0.01;
                // Calculate gap based ONLY on my faction's score to perfectly match GreasyFork script
                const gap = rw.warTarget - rw.myScore;
                const hoursRemainingFloat = gap / DROP_PER_HOUR;
                
                war.warEta = {
                  // If my score has reached target, set to 0. Otherwise future timestamp.
                  etaTimestamp: hoursRemainingFloat > 0 ? Math.floor(Date.now() + (hoursRemainingFloat * 3600000)) : 0,
                  hoursRemaining: Math.max(0, hoursRemainingFloat),
                  currentTarget: rw.warTarget,
                  calculatedAt: Date.now(),
                };`;

if (code.includes(oldCode)) {
    fs.writeFileSync(path, code.replace(oldCode, newCode));
    console.log('Successfully patched server to use MY SCORE for the ETA');
} else {
    console.log('Failed to find old code in server');
}
