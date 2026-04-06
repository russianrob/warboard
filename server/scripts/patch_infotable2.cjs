const fs = require('fs');
let code = fs.readFileSync('torn-profile-link-formatter.user.js', 'utf8');

code = code.replace(
  `const infoTable = document.querySelector('.basic-information .info-table');`,
  `const infoTable = document.querySelector('div[class*="basicInformation"] ul[class*="infoTable"], .basic-information .info-table, [class*="infoTable"], [class*="basicInformation"], [class*="profile-right-wrapper"] ul, [class*="profileRightWrapper"]');`
);

fs.writeFileSync('torn-profile-link-formatter.user.js', code);
