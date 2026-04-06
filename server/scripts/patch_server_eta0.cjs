const fs = require('fs');
const path = '../chain-monitor.js';
let code = fs.readFileSync(path, 'utf8');

const oldCode = `                war.warEta = {
                  etaTimestamp: hoursRemainingFloat > 0 ? Math.floor(Date.now() + (hoursRemainingFloat * 3600000)) : 0,
                  hoursRemaining: hoursRemainingFloat,
                  currentTarget: currentDecayedTarget,
                  calculatedAt: Date.now(),
                };`;

const newCode = `                war.warEta = {
                  etaTimestamp: hoursRemainingFloat > 0 ? Math.floor(Date.now() + (hoursRemainingFloat * 3600000)) : Date.now(),
                  hoursRemaining: hoursRemainingFloat,
                  currentTarget: currentDecayedTarget,
                  calculatedAt: Date.now(),
                };`;

if (code.includes(oldCode)) {
    fs.writeFileSync(path, code.replace(oldCode, newCode));
    console.log('Successfully patched server etaTimestamp zero bug');
} else {
    console.log('Failed to find old code in server');
}
