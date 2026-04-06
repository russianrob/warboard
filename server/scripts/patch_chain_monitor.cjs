const fs = require('fs');
const path = '../chain-monitor.js';
let code = fs.readFileSync(path, 'utf8');

const oldCode = `            // Calculate server-side war ETA
            const warStart = rw.warStart || war.warStart || 0;
            const warOrigTarget = rw.warTarget || war.warOrigTarget || 0;
            if (warStart) war.warStart = warStart;
            if (warOrigTarget) war.warOrigTarget = warOrigTarget;
            if (warStart && warOrigTarget && rw.myScore != null) {
              const nowSec = Math.floor(Date.now() / 1000);
              const elapsedHrs = (nowSec - warStart) / 3600;
              if (elapsedHrs > 24) {
                const dropHrs = Math.floor(elapsedHrs - 24);
                const currentTarget = Math.round(warOrigTarget * (1 - dropHrs * 0.01));
                const dropPerHour = warOrigTarget * 0.01;
                // Use lead (higher score) for gap calculation
                const lead = Math.max(rw.myScore, rw.enemyScore);
                const gap = currentTarget - lead;
                const hrsRemaining = dropPerHour > 0 ? gap / dropPerHour : 0;
                war.warEta = {
                  etaTimestamp: Math.floor(Date.now() + (hrsRemaining * 3600000)),
                  hoursRemaining: Math.round(hrsRemaining * 100) / 100,
                  currentTarget,
                  calculatedAt: Date.now(),
                };
              } else {
                war.warEta = {
                  etaTimestamp: null,
                  hoursRemaining: null,
                  currentTarget: warOrigTarget,
                  calculatedAt: Date.now(),
                  preDropPhase: true,
                };
              }
            }`;

const newCode = `            // Calculate server-side war ETA
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
              } else {
                war.warEta = {
                  etaTimestamp: null,
                  hoursRemaining: null,
                  currentTarget: rw.warTarget,
                  calculatedAt: Date.now(),
                  preDropPhase: true,
                };
              }
            }`;

if (code.includes(oldCode)) {
    fs.writeFileSync(path, code.replace(oldCode, newCode));
    console.log('Successfully patched chain-monitor.js');
} else {
    console.log('Failed to find old code in chain-monitor.js');
}
