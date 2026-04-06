const fs = require('fs');
let code = fs.readFileSync('torn-profile-link-formatter.user.js', 'utf8');

// Fix profile name selector
code = code.replace(
  `const nameElement = document.querySelector('#skip-to-content');`,
  `const nameElement = document.querySelector('h4[class^="name___"], h4[class*="name_"]');`
);

// initRankedWarPage
code = code.replace(
  `const factionNames = document.querySelectorAll('.faction-names .name___PlMCO');`,
  `const factionNames = document.querySelectorAll('div[class*="factionNames"] div[class*="name_"], .faction-names [class*="name_"]');`
);
code = code.replace(
  `const textNode = nameDiv.querySelector('.text___chra_') || nameDiv;`,
  `const textNode = nameDiv.querySelector('div[class*="text_"]') || nameDiv;`
);

// initMiniProfile
code = code.replace(
  `const miniProfile = document.querySelector('.profile-mini-_wrapper___Arw8R:not(.gnsc-injected), .mini-profile-wrapper:not(.gnsc-injected)');`,
  `const miniProfile = document.querySelector('[class*="profile-mini-_wrapper"]:not(.gnsc-injected), .mini-profile-wrapper:not(.gnsc-injected)');`
);

// initFactionPage
code = code.replace(
  `const memberLists = document.querySelectorAll('.members-list, .enemy-list, .your-faction');`,
  `const memberLists = document.querySelectorAll('[class*="membersList"], [class*="enemyList"], [class*="yourFaction"], .members-list, .enemy-list, .your-faction');`
);

// injectButtonsIntoList
code = code.replace(
  `const members = listElement.querySelectorAll('li.member, li.table-row, li.enemy, li.your');`,
  `const members = listElement.querySelectorAll('li[class*="member"], li[class*="tableRow"], li[class*="enemy"], li[class*="your"], li.member, li.table-row, li.enemy, li.your');`
);

// statusEl in handleListCopyClick
code = code.replace(
  `const statusEl = memberElement.querySelector('.userStatusWrap___ljSJG svg, li[class*="user-status-16-"]');`,
  `const statusEl = memberElement.querySelector('[class*="userStatusWrap"] svg, li[class*="user-status-16-"]');`
);

// toast anchor in showCopyToast
code = code.replace(
  `const anchor = document.querySelector('.faction-names, .faction-war-info, [class*="factionTitle"]');`,
  `const anchor = document.querySelector('[class*="factionNames"], [class*="factionWarInfo"], [class*="factionTitle"], .faction-names, .faction-war-info');`
);

// warRoot in handleFactionCopyClick
code = code.replace(
  `document.querySelector('.faction-war-info, .ranked-war, .war-report, #react-root, #root') ||`,
  `document.querySelector('[class*="factionWarInfo"], [class*="rankedWar"], [class*="warReport"], .faction-war-info, .ranked-war, .war-report, #react-root, #root') ||`
);

// Bump version
code = code.replace(`// @version      3.6.1`, `// @version      3.6.8`);

// Update changelog
code = code.replace(
`// =============================================================================
// CHANGELOG
// =============================================================================`,
`// =============================================================================
// CHANGELOG
// =============================================================================
// v3.6.8  - Fix profile page injection by using correct name selector (restored from 3.6.1 to fix syntax errors)
// v3.6.2 to 3.6.7 - Rolled back due to severe syntax errors introduced in earlier commit`
);

fs.writeFileSync('torn-profile-link-formatter.user.js', code);

let meta = fs.readFileSync('torn-profile-link-formatter.meta.js', 'utf8');
meta = meta.replace(`// @version      3.6.1`, `// @version      3.6.8`);
fs.writeFileSync('torn-profile-link-formatter.meta.js', meta);
