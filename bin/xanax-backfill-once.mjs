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

// Torn armoury news formats (verified live 2026-05-17):
//   <a ...XID=ID>NAME</a> used one of the faction's Xanax items     → use, qty=1
//   <a ...XID=ID>NAME</a> deposited Nx Xanax                        → deposit, qty=N
// Deposits subtract from the consumption count (user request: account
// for xanax taken-but-not-used that gets put back).
const USED_RE    = /<a[^>]*XID=(\d+)[^>]*>([^<]+)<\/a>\s+used\s+one\s+of\s+the\s+faction's\s+Xanax\s+items/i;
const DEPOSIT_RE = /<a[^>]*XID=(\d+)[^>]*>([^<]+)<\/a>\s+deposited\s+(\d+)\s*x?\s*Xanax/i;
function parseXanaxEntry(news) {
  const html = String(news || '');
  let m = html.match(USED_RE);
  if (m) return { playerId: m[1], playerName: m[2].trim(), qty: 1, type: 'used' };
  m = html.match(DEPOSIT_RE);
  if (m) {
    const qty = parseInt(m[3], 10);
    if (!Number.isFinite(qty) || qty <= 0) return null;
    return { playerId: m[1], playerName: m[2].trim(), qty, type: 'deposited' };
  }
  return null;
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
let netParsed = 0;
let useCount = 0, depCount = 0;
// Sort by timestamp so deposits subtract from running totals as we
// walk forward (mirrors the live tracker's chronological processing).
all.sort((a, b) => a.timestamp - b.timestamp);
for (const e of all) {
  const p = parseXanaxEntry(e.news);
  if (!p || !p.qty) continue;
  if (p.type === 'deposited') {
    const cur = taken[p.playerId] || 0;
    taken[p.playerId] = Math.max(0, cur - p.qty);
    names[p.playerId] = p.playerName;
    netParsed -= p.qty;
    depCount += p.qty;
  } else {
    taken[p.playerId] = (taken[p.playerId] || 0) + p.qty;
    names[p.playerId] = p.playerName;
    netParsed += p.qty;
    useCount += p.qty;
  }
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

console.log(`\nDone. ${all.length} armoury entries, ${Object.keys(taken).filter(k => taken[k] > 0).length} members with net>0 xanax.`);
console.log(`  uses: +${useCount}   deposits: -${depCount}   net: ${netParsed}`);
console.log('Top 10:');
for (const [pid, n] of Object.entries(taken).sort((a,b)=>b[1]-a[1]).slice(0,10)) {
  console.log(`  ${names[pid] || pid}: ${n}`);
}
