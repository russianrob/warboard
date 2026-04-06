const fs = require('fs');
let code = fs.readFileSync('torn-profile-link-formatter.user.js', 'utf8');

code = code.replace(`// @version      3.6.9`, `// @version      3.6.10`);
code = code.replace(
`// v3.6.9  - Update profile name DOM selector to support Torn's new HTML layout
// v3.6.8  - Fix profile page injection by using correct name selector (restored from 3.6.1 to fix syntax errors)`,
`// v3.6.10 - Make profile injection completely bulletproof against DOM updates by falling back to #skip-to-content and document.title
// v3.6.9  - Update profile name DOM selector to support Torn's new HTML layout
// v3.6.8  - Fix profile page injection by using correct name selector (restored from 3.6.1 to fix syntax errors)`
);
fs.writeFileSync('torn-profile-link-formatter.user.js', code);

let meta = fs.readFileSync('torn-profile-link-formatter.meta.js', 'utf8');
meta = meta.replace(`// @version      3.6.9`, `// @version      3.6.10`);
fs.writeFileSync('torn-profile-link-formatter.meta.js', meta);
