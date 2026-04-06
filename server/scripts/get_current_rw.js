import { fetchRankedWar } from '../torn-api.js';
import fs from 'fs';
const data = JSON.parse(fs.readFileSync('../data/faction-keys.json', 'utf8'));
const apiKey = Object.values(data)[0]; // Just grab a key
fetchRankedWar(42055, apiKey).then(rw => {
    console.log("Current API rw object:", rw);
}).catch(console.error);
