const fs = require('fs');
const wars = JSON.parse(fs.readFileSync('../data/wars.json'));
const war = Object.values(wars).find(w => w.warOrigTarget === 11232);
console.log(war);
