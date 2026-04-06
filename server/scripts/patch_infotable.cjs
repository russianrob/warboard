const fs = require('fs');
let code = fs.readFileSync('torn-profile-link-formatter.user.js', 'utf8');

code = code.replace(
  `if (nameElement && infoTable && infoTable.children.length > 5 && !alreadyInjected) {`,
  `if (nameElement && !alreadyInjected) {`
);

// We need to make sure we query for divs too in mainProfile.
code = code.replace(
  `const infoListItems = infoTable.querySelectorAll('li');`,
  `const infoListItems = infoTable ? infoTable.querySelectorAll('li, div[class*="infoRow_"], div[class*="info-row"], [class*="row_"]') : [];`
);

code = code.replace(
  `const titleEl = item.querySelector('[class*="userInformationSection"] [class*="bold"]');`,
  `const titleEl = item.querySelector('[class*="userInformationSection"] [class*="bold"], [class*="title_"], .title');`
);

fs.writeFileSync('torn-profile-link-formatter.user.js', code);
