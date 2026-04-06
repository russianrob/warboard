const fs = require('fs');
const path = '../chain-monitor.js';
let code = fs.readFileSync(path, 'utf8');

const oldCode = `            // Calculate ETA based on continuous decay mechanics.
            if (warStart && rw.warTarget && rw.myScore != null) {
              const nowSec = Math.floor(Date.now() / 1000);
              const elapsedHrs = (nowSec - warStart) / 3600;
              if (elapsedHrs > 24) {
                // The API provides the ORIGINAL target directly. Do not inflate it.
                const warOrigTarget = rw.warTarget;
                const dropPerHour = warOrigTarget * 0.01;
                
                const lead = Math.max(rw.myScore, rw.enemyScore);
                const totalGap = Math.max(0, warOrigTarget - lead);
                const exactWinHour = 24 + (totalGap / dropPerHour);
                const winTimestampSec = warStart + (exactWinHour * 3600);
                
                war.warEta = {
                  etaTimestamp: Math.floor(winTimestampSec * 1000),
                  hoursRemaining: Math.max(0, exactWinHour - elapsedHrs),
                  currentTarget: Math.round(warOrigTarget * Math.max(0.01, 1 - (Math.floor(elapsedHrs - 24) * 0.01))),
                  calculatedAt: Date.now(),
                };
              } else {`;

const newCode = `            // Calculate ETA based on continuous decay mechanics.
            if (warStart && rw.warTarget && rw.myScore != null) {
              const nowSec = Math.floor(Date.now() / 1000);
              const elapsedHrs = (nowSec - warStart) / 3600;
              if (elapsedHrs > 24) {
                // The API target (rw.warTarget) decays over time!
                // We MUST reverse-engineer the original target to calculate the exact win hour.
                const dropHours = Math.floor(elapsedHrs - 24);
                const uiDropFactor = Math.max(0.01, 1 - (dropHours * 0.01));
                const warOrigTarget = Math.round(rw.warTarget / uiDropFactor);
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
    console.log('Successfully patched server');
} else {
    console.log('Failed to find old code in server');
}
