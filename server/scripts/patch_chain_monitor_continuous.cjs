const fs = require('fs');
const path = '../chain-monitor.js';
let code = fs.readFileSync(path, 'utf8');

const oldCode = `            // Torn decays the target discretely by 1% of the original target every hour on the hour after 24h.
            if (warStart && rw.warTarget && rw.myScore != null) {
              const nowSec = Math.floor(Date.now() / 1000);
              const elapsedHrs = (nowSec - warStart) / 3600;
              if (elapsedHrs > 24) {
                const dropHrs = Math.floor(elapsedHrs - 24);
                const safeDropFactor = Math.max(0.01, 1 - dropHrs * 0.01);
                // Calculate original target to find the 1% drop rate
                const warOrigTarget = Math.round(rw.warTarget / safeDropFactor);
                const dropPerHour = warOrigTarget * 0.01;
                
                // Absolute math: how many total hours until target drops below the leader's score?
                const lead = Math.max(rw.myScore, rw.enemyScore);
                const totalGap = Math.max(0, warOrigTarget - lead);
                const dropsNeeded = Math.ceil(totalGap / dropPerHour);
                const winHour = 24 + dropsNeeded;
                const winTimestampSec = warStart + (winHour * 3600);
                
                war.warEta = {
                  etaTimestamp: winTimestampSec * 1000,
                  hoursRemaining: Math.max(0, (winTimestampSec - nowSec) / 3600),
                  currentTarget: rw.warTarget,
                  calculatedAt: Date.now(),
                };
              } else {`;

const newCode = `            // Torn decays the target CONTINUOUSLY after 24h.
            if (warStart && rw.warTarget && rw.myScore != null) {
              const nowSec = Math.floor(Date.now() / 1000);
              const elapsedHrs = (nowSec - warStart) / 3600;
              if (elapsedHrs > 24) {
                const exactDropFactor = Math.max(0.01, 1 - ((elapsedHrs - 24) * 0.01));
                // Calculate original target to find the 1% drop rate
                const warOrigTarget = Math.round(rw.warTarget / exactDropFactor);
                const dropPerHour = warOrigTarget * 0.01;
                
                const lead = Math.max(rw.myScore, rw.enemyScore);
                const totalGap = Math.max(0, warOrigTarget - lead);
                const exactWinHour = 24 + (totalGap / dropPerHour);
                const winTimestampSec = warStart + (exactWinHour * 3600);
                
                war.warEta = {
                  etaTimestamp: Math.floor(winTimestampSec * 1000),
                  hoursRemaining: Math.max(0, exactWinHour - elapsedHrs),
                  currentTarget: rw.warTarget,
                  calculatedAt: Date.now(),
                };
              } else {`;

if (code.includes(oldCode)) {
    fs.writeFileSync(path, code.replace(oldCode, newCode));
    console.log('Successfully patched chain-monitor.js with CONTINUOUS math');
} else {
    console.log('Failed to find old code in chain-monitor.js');
}
