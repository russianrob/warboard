const fs = require('fs');
const path = '../chain-monitor.js';
let code = fs.readFileSync(path, 'utf8');

const oldCode = `            // Calculate ETA based exactly on the GreasyFork script math (Server Edition).
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

const newCode = `            // Server-side calculation. Wait, if hoursRemaining is < 0 it was setting etaTimestamp to the past, making the client say WON.
            // Let's protect against gap <= 0
            if (warStart && rw.warTarget && rw.myScore != null) {
              const nowSec = Math.floor(Date.now() / 1000);
              const totalElapsedHours = (nowSec - warStart) / 3600;
              if (totalElapsedHours > 24) {
                const dropHours = Math.floor(totalElapsedHours - 24);
                
                // Server API gives the ORIGINAL target.
                const originalTarget = rw.warTarget;
                
                // Calculate what the target is RIGHT NOW in the UI
                const currentDecayedTarget = Math.round(originalTarget * (1 - (dropHours * 0.01)));
                
                const DROP_PER_HOUR = originalTarget * 0.01;
                const lead = Math.max(rw.myScore, rw.enemyScore);
                
                // Calculate the gap from the CURRENT UI TARGET
                const gap = currentDecayedTarget - lead;
                const hoursRemainingFloat = gap / DROP_PER_HOUR;
                
                // If the gap is less than 0, we actually HAVE won!
                // But wait, what if myScore isn't the lead?
                // myScore is just ONE faction's score. The gap is based on the LEAD.
                // If hoursRemainingFloat is negative, it means LEAD > TARGET.
                // It should only say WON if MY faction is the lead.
                
                war.warEta = {
                  etaTimestamp: hoursRemainingFloat > 0 ? Math.floor(Date.now() + (hoursRemainingFloat * 3600000)) : 0,
                  hoursRemaining: hoursRemainingFloat,
                  currentTarget: currentDecayedTarget,
                  calculatedAt: Date.now(),
                };
              } else {`;

if (code.includes(oldCode)) {
    fs.writeFileSync(path, code.replace(oldCode, newCode));
    console.log('Successfully patched server ETA negative protection');
} else {
    console.log('Failed to find old code in server');
}
