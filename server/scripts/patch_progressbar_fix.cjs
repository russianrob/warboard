const fs = require('fs');
let code = fs.readFileSync('torn-profile-link-formatter.user.js', 'utf8');

// 1. Add relative positioning to parent node
code = code.replace(
  `// --- Inject Progress Bar ---`,
  `// --- Inject Progress Bar ---
            button.parentNode.style.position = 'relative';`
);

// 2. Update CSS for the container
code = code.replace(
  `progressBarContainer.style.cssText = 'width: 100px; height: 8px; background-color: rgba(50,50,50,0.8); border: 1px solid #555; border-radius: 4px; display: inline-block; vertical-align: middle; margin-left: 8px; overflow: hidden; box-shadow: inset 0 1px 3px rgba(0,0,0,0.5);';`,
  `progressBarContainer.style.cssText = 'width: 100px; height: 8px; background-color: rgba(50,50,50,0.8); border: 1px solid #555; border-radius: 4px; position: absolute; margin-top: 25px; margin-left: 8px; z-index: 9999; overflow: hidden; box-shadow: inset 0 1px 3px rgba(0,0,0,0.5);';`
);

// 3. Fix initial display style
code = code.replace(
  `progressBarContainer.style.display = 'inline-block';`,
  `progressBarContainer.style.display = 'block';`
);

// 4. Wrap hide command in setTimeout
code = code.replace(
  `// Hide progress bar on completion
            progressBarContainer.style.display = 'none';`,
  `// Hide progress bar on completion after a delay so it stays visible at 100%
            setTimeout(() => {
                if (progressBarContainer) progressBarContainer.style.display = 'none';
            }, 2500);`
);

// 5. Version bumps
code = code.replace(`// @version      3.6.11`, `// @version      3.6.12`);
code = code.replace(
  `// v3.6.11 - Add visual progress bar to faction copy and improve error handling for individual members`,
  `// v3.6.12 - Fix progress bar visibility (absolute positioning) and delay hiding so 100% state is visible
// v3.6.11 - Add visual progress bar to faction copy and improve error handling for individual members`
);

fs.writeFileSync('torn-profile-link-formatter.user.js', code);

let meta = fs.readFileSync('torn-profile-link-formatter.meta.js', 'utf8');
meta = meta.replace(`// @version      3.6.11`, `// @version      3.6.12`);
fs.writeFileSync('torn-profile-link-formatter.meta.js', meta);
