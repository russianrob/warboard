import fs from 'fs';
const data = JSON.parse(fs.readFileSync('../data/wars.json', 'utf8'));
for (const [warId, war] of Object.entries(data)) {
  if (war.warEta && war.warEta.currentTarget) {
    console.log(`War ${warId} Target: ${war.warEta.currentTarget}`);
  }
}
