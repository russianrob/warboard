const fs = require('fs');
let code = fs.readFileSync('factionops.user.js', 'utf8');

const target1 = `                if (hoursRemainingFloat <= 0) {
                    warTimerEl.className = 'fo-war-timer safe';
                    warTimerValue.textContent = '✓ WON';
                } else {`;
const rep1 = `                if (hoursRemainingFloat <= 0) {
                    const isLosing = state.warScores && (state.warScores.enemyScore > state.warScores.myScore);
                    warTimerEl.className = 'fo-war-timer ' + (isLosing ? 'danger' : 'safe');
                    warTimerValue.textContent = isLosing ? '✗ LOST' : '✓ WON';
                } else {`;
code = code.replace(target1, rep1);

const target2 = `            if (hoursRemainingFloat <= 0) {
                warTimerEl.className = 'fo-war-timer safe';
                warTimerValue.textContent = 'WON';
            } else {`;
const rep2 = `            if (hoursRemainingFloat <= 0) {
                const isLosing = state.warScores && (state.warScores.enemyScore > state.warScores.myScore);
                warTimerEl.className = 'fo-war-timer ' + (isLosing ? 'danger' : 'safe');
                warTimerValue.textContent = isLosing ? 'LOST' : 'WON';
            } else {`;
code = code.replace(target2, rep2);

fs.writeFileSync('factionops.user.js', code);
