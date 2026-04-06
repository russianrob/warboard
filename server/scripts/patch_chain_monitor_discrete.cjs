const fs = require('fs');
const path = '../chain-monitor.js';
let code = fs.readFileSync(path, 'utf8');

const oldCode = `            // Calculate server-side war ETA
            const warStart = rw.warStart || war.warStart || 0;
            if (warStart) war.warStart = warStart;
            
            // The Torn API target (rw.warTarget) is the CURRENT decayed target, not the original target.
            if (warStart && rw.warTarget && rw.myScore != null) {
              const nowSec = Math.floor(Date.now() / 1000);
              const elapsedHrs = (nowSec - warStart) / 3600;
              if (elapsedHrs > 24) {
                const dropHrs = Math.floor(elapsedHrs - 24);
                const safeDropFactor = Math.max(0.01, 1 - dropHrs * 0.01);
                // Calculate original target to find the 1% drop rate
                const warOrigTarget = Math.round(rw.warTarget / safeDropFactor);
                const dropPerHour = warOrigTarget * 0.01;
                // Use lead (higher score) for gap calculation
                const lead = Math.max(rw.myScore, rw.enemyScore);
                const gap = Math.max(0, rw.warTarget - lead);
                const hrsRemaining = dropPerHour > 0 ? gap / dropPerHour : 0;
                war.warEta = {
                  etaTimestamp: Math.floor(Date.now() + (hrsRemaining * 3600000)),
                  hoursRemaining: Math.round(hrsRemaining * 100) / 100,
                  currentTarget: rw.warTarget,
                  calculatedAt: Date.now(),
                };
              } else {`;

const newCode = `            // Calculate server-side war ETA
            const warStart = rw.warStart || war.warStart || 0;
            if (warStart) war.warStart = warStart;
            
            // Torn decays the target discretely by 1% of the original target every hour on the hour after 24h.
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

if (code.includes(oldCode)) {
    fs.writeFileSync(path, code.replace(oldCode, newCode));
    console.log('Successfully patched chain-monitor.js with discrete math');
} else {
    console.log('Failed to find old code in chain-monitor.js');
}
