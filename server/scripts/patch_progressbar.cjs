const fs = require('fs');
let code = fs.readFileSync('torn-profile-link-formatter.user.js', 'utf8');

const targetLoop = `            const totalMembers = validRows.length;
            let processed = 0;
            button.textContent = \`0/\${totalMembers}\`;

            for (const { row, link, id } of validRows) {
                try {
                    let name = (link.textContent || '').trim();
                    name = stripBspPrefix(name);
                    if (!name) { processed++; continue; }

                    const profileLabel = name;
                    let statsString = "(Stats: N/A)";

                    if (settings.battlestats) {
                        // Faction copy: skip spy data, only use BSP prediction or FF Scouter
                        const predOnly = getBspPredictionOrFf(id);
                        if (predOnly?.type === 'prediction' && predOnly.prediction) {
                            statsString = formatPredictionString(predOnly.prediction);
                        } else {
                            const ff = await getFfScouterEstimate(id);
                            if (ff && ff.total != null) {
                                statsString = formatFfScouterString(ff, settings.battleStatsFormat);
                            } else {
                                statsString = "(Stats: N/A)";
                            }
                        }
                    }

                    const extras = [];

                    const level = getMemberLevel(id, row);
                    if (level != null) extras.push(\`Lvl \${level}\`);

                    const pStats = await getPersonalStats(id);
                    if (pStats.xantaken != null) extras.push(\`Xan: \${pStats.xantaken.toLocaleString()}\`);
                    if (pStats.boostersused != null) extras.push(\`Boosters: \${pStats.boostersused.toLocaleString()}\`);

                    const extraStr = extras.length > 0 ? \` - \${extras.join(' - ')}\` : '';

                    lines.push(\`\${profileLabel} - \${statsString}\${extraStr}\`);
                } catch (rowErr) {
                    if (debug) console.error('GNSC faction copy: error on member row', row, rowErr);
                }
                processed++;
                button.textContent = \`\${processed}/\${totalMembers}\`;
                // Yield to UI so the counter visually updates
                await new Promise(r => setTimeout(r, 0));
            }

            if (!lines.length) {`;

const newLoop = `            const totalMembers = validRows.length;
            let processed = 0;
            button.textContent = \`0/\${totalMembers}\`;

            // --- Inject Progress Bar ---
            let progressBarContainer = button.parentNode.querySelector('.gnsc-progress-container');
            if (!progressBarContainer) {
                progressBarContainer = document.createElement('div');
                progressBarContainer.className = 'gnsc-progress-container';
                progressBarContainer.style.cssText = 'width: 100px; height: 8px; background-color: rgba(50,50,50,0.8); border: 1px solid #555; border-radius: 4px; display: inline-block; vertical-align: middle; margin-left: 8px; overflow: hidden; box-shadow: inset 0 1px 3px rgba(0,0,0,0.5);';
                
                const progressBar = document.createElement('div');
                progressBar.className = 'gnsc-progress-bar';
                progressBar.style.cssText = 'height: 100%; width: 0%; background-color: #4CAF50; transition: width 0.1s linear;';
                
                progressBarContainer.appendChild(progressBar);
                button.parentNode.insertBefore(progressBarContainer, button.nextSibling);
            }
            progressBarContainer.style.display = 'inline-block';
            const progressBar = progressBarContainer.querySelector('.gnsc-progress-bar');
            progressBar.style.width = '0%';
            // ---------------------------

            for (const { row, link, id } of validRows) {
                let name = (link.textContent || '').trim();
                name = stripBspPrefix(name);
                
                if (!name) {
                    processed++;
                    button.textContent = \`\${processed}/\${totalMembers}\`;
                    progressBar.style.width = \`\${(processed / totalMembers) * 100}%\`;
                    continue;
                }

                const profileLabel = name;
                let statsString = "(Stats: N/A)";
                const extras = [];

                try {
                    // Try to fetch battle stats
                    if (settings.battlestats) {
                        const predOnly = getBspPredictionOrFf(id);
                        if (predOnly?.type === 'prediction' && predOnly.prediction) {
                            statsString = formatPredictionString(predOnly.prediction);
                        } else {
                            const ff = await getFfScouterEstimate(id);
                            if (ff && ff.total != null) {
                                statsString = formatFfScouterString(ff, settings.battleStatsFormat);
                            }
                        }
                    }
                } catch (statErr) {
                    if (debug) console.error('GNSC faction copy: stat error for', id, statErr);
                    statsString = "(Stats: Error)";
                }

                try {
                    // Try to fetch personal stats (Xanax/Boosters)
                    const level = getMemberLevel(id, row);
                    if (level != null) extras.push(\`Lvl \${level}\`);

                    const pStats = await getPersonalStats(id);
                    if (pStats && pStats.xantaken != null) extras.push(\`Xan: \${pStats.xantaken.toLocaleString()}\`);
                    if (pStats && pStats.boostersused != null) extras.push(\`Boosters: \${pStats.boostersused.toLocaleString()}\`);
                } catch (apiErr) {
                    if (debug) console.error('GNSC faction copy: API/Personal stats error for', id, apiErr);
                }

                const extraStr = extras.length > 0 ? \` - \${extras.join(' - ')}\` : '';
                lines.push(\`\${profileLabel} - \${statsString}\${extraStr}\`);

                processed++;
                button.textContent = \`\${processed}/\${totalMembers}\`;
                progressBar.style.width = \`\${(processed / totalMembers) * 100}%\`;
                
                // Yield to UI so the counter and progress bar visually update
                await new Promise(r => setTimeout(r, 0));
            }
            
            // Hide progress bar on completion
            progressBarContainer.style.display = 'none';

            if (!lines.length) {`;

if (code.includes(targetLoop)) {
    code = code.replace(targetLoop, newLoop);
} else {
    console.error("Target loop not found!");
    process.exit(1);
}

// Add progress bar hiding to the main catch block
const targetCatch = `        } catch (err) {
            if (debug) console.error('[Faction Copy BSP/FF] Error:', err);
            button.textContent = '❌';`;
            
const newCatch = `        } catch (err) {
            if (debug) console.error('[Faction Copy BSP/FF] Error:', err);
            button.textContent = '❌';
            const existingPb = button.parentNode.querySelector('.gnsc-progress-container');
            if (existingPb) existingPb.style.display = 'none';`;

if (code.includes(targetCatch)) {
    code = code.replace(targetCatch, newCatch);
} else {
    console.error("Target catch not found!");
    process.exit(1);
}

// Bump version to 3.6.11
code = code.replace(`// @version      3.6.10`, `// @version      3.6.11`);
code = code.replace(
`// v3.6.10 - Make profile injection completely bulletproof against DOM updates by falling back to #skip-to-content and document.title`,
`// v3.6.11 - Add visual progress bar to faction copy and improve error handling for individual members
// v3.6.10 - Make profile injection completely bulletproof against DOM updates by falling back to #skip-to-content and document.title`
);

fs.writeFileSync('torn-profile-link-formatter.user.js', code);

let meta = fs.readFileSync('torn-profile-link-formatter.meta.js', 'utf8');
meta = meta.replace(`// @version      3.6.10`, `// @version      3.6.11`);
fs.writeFileSync('torn-profile-link-formatter.meta.js', meta);
