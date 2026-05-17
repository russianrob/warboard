// One-shot xanax backfill for war_42055 using a specific user key
// for the armoury-news fetch. Writes results back into wars.json.
//
// Reads API key from env XANAX_KEY (do not hardcode here).

import fs from 'node:fs';

const KEY = process.env.XANAX_KEY;
if (!KEY) { console.error('XANAX_KEY env required'); process.exit(1); }

const WARS_FILE = '/opt/warboard/server/data/wars.json';
const wars = JSON.parse(fs.readFileSync(WARS_FILE, 'utf8'));
const war = wars['war_42055'];
if (!war) { console.error('war_42055 not found'); process.exit(1); }

const factionId = war.factionId;
const PRE_LOOKBACK = 24 * 3600;
const POST_LOOKAHEAD = 24 * 3600;
const fromTs = (war.warStart || Math.floor(Date.now()/1000)) - PRE_LOOKBACK;
const toTs = war.warEndedAt
  ? Math.min(Math.floor(Number(war.warEndedAt)/1000) + POST_LOOKAHEAD, Math.floor(Date.now()/1000))
  : Math.floor(Date.now()/1000);

console.log(`Backfill war_42055 (faction ${factionId}) from ${new Date(fromTs*1000).toISOString()} to ${new Date(toTs*1000).toISOString()}`);

// Actual Torn armoury news format:
//   <a href="...XID=PLAYERID">NAME</a> used one of the faction's Xanax items
// (one entry per xanax taken)
// Deposits look like "deposited Nx Xanax" — those should NOT count.
function parseXanaxEntry(news) {
  const html = String(news || '');
  // Match "used one of the faction's Xanax items" specifically
  if (!/used one of the faction's Xanax items/i.test(html)) return null;
  const m = html.match(/XID=(\d+)["'][^>]*>([^<]+)</);
  if (!m) return null;
  return {
    playerId: m[1],
    playerName: m[2].trim(),
    qty: 1, // one entry = one xanax taken
  };
}

async function fetchPage(toCursor) {
  // v1 API: /faction/<id>?selections=armorynews&from=&to=&key=
  // Response shape: { armorynews: { <id>: { news, timestamp } } }
  const url = `https://api.torn.com/faction/${encodeURIComponent(factionId)}?selections=armorynews&from=${fromTs}&to=${toCursor}&key=${encodeURIComponent(KEY)}&comment=wb-backfill`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  if (d.error) throw new Error(`Torn: ${d.error.error || d.error.code}`);
  return Object.entries(d.armorynews || {})
    .map(([id, v]) => ({ id, news: v.news || '', timestamp: Number(v.timestamp) || 0 }));
}

const all = [];
const seen = new Set();
let to = toTs;
for (let page = 0; page < 30; page++) {
  let batch;
  try { batch = await fetchPage(to); }
  catch (e) { console.error(`page ${page} failed: ${e.message}`); break; }
  console.log(`page ${page}: ${batch.length} entries, to=${new Date(to*1000).toISOString()}`);
  if (batch.length === 0) break;
  let oldest = Infinity;
  for (const e of batch) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    all.push(e);
    if (e.timestamp < oldest) oldest = e.timestamp;
  }
  if (batch.length < 100 || oldest <= fromTs) break;
  to = oldest - 1;
}

const taken = {}, names = {};
let xanaxParsed = 0;
for (const e of all) {
  const p = parseXanaxEntry(e.news);
  if (!p || !p.qty) continue;
  taken[p.playerId] = (taken[p.playerId] || 0) + p.qty;
  names[p.playerId] = p.playerName;
  xanaxParsed += p.qty;
}

war.xanaxStats = {
  lastPolledAt: toTs,
  taken,
  names,
  entryCount: all.length,
  backfilledFrom: fromTs,
  backfilledTo: toTs,
  backfilledAt: Date.now(),
};
fs.writeFileSync(WARS_FILE, JSON.stringify(wars, null, 2));

console.log(`\nDone. ${all.length} armoury entries, ${Object.keys(taken).length} members reported xanax, ${xanaxParsed} total xanax parsed.`);
console.log('Top 10:');
for (const [pid, n] of Object.entries(taken).sort((a,b)=>b[1]-a[1]).slice(0,10)) {
  console.log(`  ${names[pid] || pid}: ${n}`);
}
