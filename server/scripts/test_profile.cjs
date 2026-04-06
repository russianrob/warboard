const fs = require('fs');
let code = fs.readFileSync('torn-profile-link-formatter.user.js', 'utf8');

code = code.replace(
  `const nameElement = document.querySelector('h4[class^="name___"], h4[class*="name_"]');`,
  `const nameElement = document.querySelector('[class*="profile-wrapper"] [class*="name___"], [class*="profile-wrapper"] [class*="name_"], h4[class*="name_"], h1[class*="name_"], div[class*="name_"], span[class*="name_"], .profile-heading');`
);

code = code.replace(
  `const infoTable = document.querySelector('div[class*="basicInformation"] ul[class*="infoTable"], .basic-information .info-table, [class*="infoTable"], [class*="basicInformation"]');`,
  `const infoTable = document.querySelector('div[class*="basicInformation"] ul[class*="infoTable"], .basic-information .info-table, [class*="infoTable"], [class*="basicInformation"], [class*="profile-right-wrapper"] ul');`
);

// We should also ensure `mainProfile` handles elements that might be undefined safely.
fs.writeFileSync('torn-profile-link-formatter.user.js', code);
