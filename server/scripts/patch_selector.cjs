const fs = require('fs');
let code = fs.readFileSync('torn-profile-link-formatter.user.js', 'utf8');

code = code.replace(
  `const nameElement = document.querySelector('[class*="profile-wrapper"] [class*="name___"], [class*="profile-wrapper"] [class*="name_"], h4[class*="name_"], h1[class*="name_"], div[class*="name_"], span[class*="name_"], .profile-heading');`,
  `// Extremely broad selector for the user's name element on the profile page, handling Torn's recent React updates
        const nameElement = document.querySelector(
            '[class*="profile-wrapper"] [class*="name___"], ' +
            '[class*="profile-wrapper"] h1[class*="name_"], ' +
            '[class*="profile-wrapper"] h2[class*="name_"], ' +
            '[class*="profile-wrapper"] h3[class*="name_"], ' +
            '[class*="profile-wrapper"] h4[class*="name_"], ' +
            '[class*="profile-wrapper"] div[class*="name_"], ' +
            '[class*="profileWrapper"] [class*="name___"], ' +
            'h1[class*="name___"], h2[class*="name___"], h3[class*="name___"], h4[class*="name___"], div[class*="name___"], ' +
            '.profile-heading'
        );`
);

fs.writeFileSync('torn-profile-link-formatter.user.js', code);

// Bump version to 3.6.9
code = code.replace(`// @version      3.6.8`, `// @version      3.6.9`);
code = code.replace(
`// v3.6.8  - Fix profile page injection by using correct name selector (restored from 3.6.1 to fix syntax errors)`,
`// v3.6.9  - Update profile name DOM selector to support Torn's new HTML layout
// v3.6.8  - Fix profile page injection by using correct name selector (restored from 3.6.1 to fix syntax errors)`
);
fs.writeFileSync('torn-profile-link-formatter.user.js', code);

let meta = fs.readFileSync('torn-profile-link-formatter.meta.js', 'utf8');
meta = meta.replace(`// @version      3.6.8`, `// @version      3.6.9`);
fs.writeFileSync('torn-profile-link-formatter.meta.js', meta);

