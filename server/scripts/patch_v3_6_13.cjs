const fs = require('fs');
let code = fs.readFileSync('torn-profile-link-formatter.user.js', 'utf8');

const targetInjection = `            // --- Inject Progress Bar ---
            button.parentNode.style.position = 'relative';
            let progressBarContainer = button.parentNode.querySelector('.gnsc-progress-container');
            if (!progressBarContainer) {
                progressBarContainer = document.createElement('div');
                progressBarContainer.className = 'gnsc-progress-container';
                progressBarContainer.style.cssText = 'width: 100px; height: 8px; background-color: rgba(50,50,50,0.8); border: 1px solid #555; border-radius: 4px; position: absolute; margin-top: 25px; margin-left: 8px; z-index: 9999; overflow: hidden; box-shadow: inset 0 1px 3px rgba(0,0,0,0.5);';
                
                const progressBar = document.createElement('div');
                progressBar.className = 'gnsc-progress-bar';
                progressBar.style.cssText = 'height: 100%; width: 0%; background-color: #4CAF50; transition: width 0.1s linear;';
                
                progressBarContainer.appendChild(progressBar);
                button.parentNode.insertBefore(progressBarContainer, button.nextSibling);
            }
            progressBarContainer.style.display = 'block';
            const progressBar = progressBarContainer.querySelector('.gnsc-progress-bar');
            progressBar.style.width = '0%';
            // ---------------------------`;

const newInjection = `            // --- Inject Progress Bar (Fixed/Toast Style for React-Immunity) ---
            let progressBarContainer = document.getElementById('gnsc-fixed-progress-container');
            if (!progressBarContainer) {
                progressBarContainer = document.createElement('div');
                progressBarContainer.id = 'gnsc-fixed-progress-container';
                progressBarContainer.style.cssText = 'position: fixed; bottom: 30px; right: 30px; width: 250px; background-color: rgba(20,20,30,0.95); border: 1px solid #4CAF50; border-radius: 6px; z-index: 999999; padding: 10px; box-shadow: 0 4px 15px rgba(0,0,0,0.7); font-family: sans-serif;';
                
                const label = document.createElement('div');
                label.id = 'gnsc-progress-label';
                label.style.cssText = 'color: #eee; font-size: 12px; margin-bottom: 6px; font-weight: bold; text-align: center;';
                label.textContent = 'Faction Copy Progress...';
                
                const barOuter = document.createElement('div');
                barOuter.style.cssText = 'width: 100%; height: 12px; background-color: #333; border-radius: 6px; overflow: hidden; position: relative;';
                
                const progressBar = document.createElement('div');
                progressBar.id = 'gnsc-fixed-progress-bar';
                progressBar.style.cssText = 'height: 100%; width: 0%; background-color: #4CAF50; transition: width 0.1s linear;';
                
                barOuter.appendChild(progressBar);
                progressBarContainer.appendChild(label);
                progressBarContainer.appendChild(barOuter);
                document.body.appendChild(progressBarContainer);
            }
            progressBarContainer.style.display = 'block';
            const progressBar = document.getElementById('gnsc-fixed-progress-bar');
            const progressLabel = document.getElementById('gnsc-progress-label');
            progressBar.style.width = '0%';
            progressLabel.textContent = \`Copying: 0/\${totalMembers}\`;
            // ----------------------------------------------------------------`;

code = code.replace(targetInjection, newInjection);

// Update progress bar inside loop
code = code.replace(
  `button.textContent = \`\${processed}/\${totalMembers}\`;
                    progressBar.style.width = \`\${(processed / totalMembers) * 100}%\`;`,
  `if (button.isConnected) button.textContent = \`\${processed}/\${totalMembers}\`;
                    progressBar.style.width = \`\${(processed / totalMembers) * 100}%\`;
                    progressLabel.textContent = \`Copying: \${processed}/\${totalMembers}\`;`
);

// Second occurrence in loop
code = code.replace(
  `button.textContent = \`\${processed}/\${totalMembers}\`;
                progressBar.style.width = \`\${(processed / totalMembers) * 100}%\`;`,
  `if (button.isConnected) button.textContent = \`\${processed}/\${totalMembers}\`;
                progressBar.style.width = \`\${(processed / totalMembers) * 100}%\`;
                progressLabel.textContent = \`Copying: \${processed}/\${totalMembers}\`;`
);

// Update completion notification
code = code.replace(
  `button.textContent = \`✅ \${totalMembers}\`;
            button.title = 'Copied faction list with BSP/FF stats.';
            setTimeout(() => {
                button.textContent = '📋';
                button.title = 'Copy Faction Member List (BSP/FF cache)';
            }, 5000);`,
  `progressLabel.textContent = \`✅ Copied \${totalMembers} members!\`;
            if (button.isConnected) {
                button.textContent = \`✅ \${totalMembers}\`;
                button.title = 'Copied faction list with BSP/FF stats.';
                setTimeout(() => {
                    if (button.isConnected) {
                        button.textContent = '📋';
                        button.title = 'Copy Faction Member List (BSP/FF cache)';
                    }
                }, 5000);
            }`
);

// Update catch block
code = code.replace(
  `button.textContent = '❌';
            const existingPb = button.parentNode.querySelector('.gnsc-progress-container');
            if (existingPb) existingPb.style.display = 'none';`,
  `if (button.isConnected) button.textContent = '❌';
            if (progressBarContainer) progressBarContainer.style.display = 'none';`
);

// Bump version
code = code.replace(`// @version      3.6.12`, `// @version      3.6.13`);
code = code.replace(
  `// v3.6.12 - Fix progress bar visibility (absolute positioning) and delay hiding so 100% state is visible`,
  `// v3.6.13 - Move progress bar to fixed position toast to make it immune to React DOM updates
// v3.6.12 - Fix progress bar visibility (absolute positioning) and delay hiding so 100% state is visible`
);

fs.writeFileSync('torn-profile-link-formatter.user.js', code);

let meta = fs.readFileSync('torn-profile-link-formatter.meta.js', 'utf8');
meta = meta.replace(`// @version      3.6.12`, `// @version      3.6.13`);
fs.writeFileSync('torn-profile-link-formatter.meta.js', meta);
