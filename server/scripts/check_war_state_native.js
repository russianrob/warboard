import fs from 'fs';
const data = JSON.parse(fs.readFileSync('../data/faction-keys.json', 'utf8'));
const apiKey = Object.values(data)[0];
const url = `https://api.torn.com/faction/42055?selections=rankedwars&key=${apiKey}`;
globalThis.fetch(url).then(r => r.json()).then(d => console.log(JSON.stringify(d, null, 2)));
