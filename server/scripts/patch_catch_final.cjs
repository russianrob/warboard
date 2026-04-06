const fs = require('fs');
let code = fs.readFileSync('torn-profile-link-formatter.user.js', 'utf8');

code = code.replace(
`setTimeout(() => {
                button.textContent = '📋';
                button.title = 'Copy Faction Member List (BSP/FF cache)';
            }, 2500);`,
`setTimeout(() => {
                if (button && button.isConnected) {
                    button.textContent = '📋';
                    button.title = 'Copy Faction Member List (BSP/FF cache)';
                }
            }, 2500);`
);

fs.writeFileSync('torn-profile-link-formatter.user.js', code);
