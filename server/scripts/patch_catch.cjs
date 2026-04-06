const fs = require('fs');
let code = fs.readFileSync('torn-profile-link-formatter.user.js', 'utf8');

const targetCatch = `if (button.isConnected) button.textContent = '❌';
            if (progressBarContainer) progressBarContainer.style.display = 'none';`;

const newCatch = `if (button && button.isConnected) button.textContent = '❌';
            const fixedPb = document.getElementById('gnsc-fixed-progress-container');
            if (fixedPb) fixedPb.style.display = 'none';`;

code = code.replace(targetCatch, newCatch);

fs.writeFileSync('torn-profile-link-formatter.user.js', code);
