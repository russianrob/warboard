const fs = require('fs');
const oldScript = fs.readFileSync('factionops_4_5_22.user.js', 'utf8');
const newScript = fs.readFileSync('factionops.user.js', 'utf8');

const startStr = '    function updateWarTimer() {';
const endStr = '    function updateWarTimerDisplay() {';

const timer4522 = oldScript.substring(
    oldScript.indexOf(startStr),
    oldScript.indexOf(endStr)
);

const pre = newScript.substring(0, newScript.indexOf(startStr));
const post = newScript.substring(newScript.indexOf(endStr));

fs.writeFileSync('factionops.user.js', pre + timer4522 + post);
