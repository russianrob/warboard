const fs = require('fs');
const path = '../chain-monitor.js';
let code = fs.readFileSync(path, 'utf8');

const oldCode = `            // Calculate ETA based exactly on the GreasyFork script math.
            if (warStart && rw.warTarget && rw.myScore != null) {
              const nowSec = Math.floor(Date.now() / 1000);
              const totalElapsedHours = (nowSec - warStart) / 3600;
              if (totalElapsedHours > 24) {
                const dropHours = Math.floor(totalElapsedHours - 24);
                const originalTarget = rw.warTarget / (1 - (dropHours * 0.01));
                const DROP_PER_HOUR = originalTarget * 0.01;
                const lead = Math.max(rw.myScore, rw.enemyScore);
                const gap = rw.warTarget - lead;
                const hoursRemainingFloat = gap / DROP_PER_HOUR;
                
                war.warEta = {
                  etaTimestamp: Math.floor(Date.now() + (hoursRemainingFloat * 3600000)),
                  hoursRemaining: Math.max(0, hoursRemainingFloat),
                  currentTarget: rw.warTarget,
                  calculatedAt: Date.now(),
                };
              } else {`;

const newCode = `            // Calculate ETA based exactly on the GreasyFork script math (Server Edition).
            // NOTE: Torn API provides the ORIGINAL target, not the decayed target!
            if (warStart && rw.warTarget && rw.myScore != null) {
              const nowSec = Math.floor(Date.now() / 1000);
              const totalElapsedHours = (nowSec - warStart) / 3600;
              if (totalElapsedHours > 24) {
                const dropHours = Math.floor(totalElapsedHours - 24);
                
                // Server API gives the ORIGINAL target. We do NOT divide by drop factor here.
                const originalTarget = rw.warTarget;
                
                // Calculate what the target is RIGHT NOW in the UI
                const currentDecayedTarget = Math.round(originalTarget * (1 - (dropHours * 0.01)));
                
                const DROP_PER_HOUR = originalTarget * 0.01;
                const lead = Math.max(rw.myScore, rw.enemyScore);
                
                // Calculate the gap from the CURRENT UI TARGET
                const gap = currentDecayedTarget - lead;
                const hoursRemainingFloat = gap / DROP_PER_HOUR;
                
                war.warEta = {
                  etaTimestamp: Math.floor(Date.now() + (hoursRemainingFloat * 3600000)),
                  hoursRemaining: Math.max(0, hoursRemainingFloat),
                  currentTarget: currentDecayedTarget,
                  calculatedAt: Date.now(),
                };
              } else {`;

if (code.includes(oldCode)) {
    fs.writeFileSync(path, code.replace(oldCode, newCode));
    console.log('Successfully patched server with correct API target math');
} else {
    console.log('Failed to find old code in server');
}
