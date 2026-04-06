const fs = require('fs');
const data = JSON.parse(fs.readFileSync('../data/wars.json', 'utf8'));
for (const [id, w] of Object.entries(data)) {
  console.log(`War ${id}: warOrigTarget=${w.warOrigTarget}, currentEtaTarget=${w.warEta ? w.warEta.currentTarget : 'N/A'}`);
}
