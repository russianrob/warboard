const fs = require('fs');
let code = fs.readFileSync('torn-profile-link-formatter.user.js', 'utf8');

code = code.replace(
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
        );`,
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
            '.profile-heading, ' +
            '#skip-to-content' // Fallback to ensure UI injection
        );`
);

code = code.replace(
  `const cleanedName = nameElement.textContent.replace("'s Profile", "").split(' [')[0].trim();`,
  `let cleanedName = nameElement.textContent.replace("'s Profile", "").split(' [')[0].trim();
        
        // If we hit the fallback, try to extract the real name from the document title
        if (cleanedName === 'Skip to content' || nameElement.id === 'skip-to-content') {
            const titleMatch = document.title.match(/(.+?)'s Profile/i);
            if (titleMatch && titleMatch[1]) {
                cleanedName = titleMatch[1].trim();
            } else {
                cleanedName = 'Unknown Player';
            }
        }`
);

fs.writeFileSync('torn-profile-link-formatter.user.js', code);
