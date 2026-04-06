const fs = require('fs');
let code = fs.readFileSync('torn-profile-link-formatter.user.js', 'utf8');

code = code.replace(
  `const titleEl = item.querySelector('.user-information-section .bold');`,
  `const titleEl = item.querySelector('[class*="userInformationSection"] [class*="bold"], [class*="title_"], .title, .user-information-section .bold');`
);

code = code.replace(
  `if (title === 'Faction') factionLinkEl = item.querySelector('.user-info-value a');
            if (title === 'Job') companyLinkEl = item.querySelector('.user-info-value a');`,
  `if (title === 'Faction') factionLinkEl = item.querySelector('.user-info-value a, a');
            if (title === 'Job') companyLinkEl = item.querySelector('.user-info-value a, a');`
);

fs.writeFileSync('torn-profile-link-formatter.user.js', code);
