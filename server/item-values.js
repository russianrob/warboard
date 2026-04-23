// Torn item market-value cache.
// Feeds the OC outcome-analysis path (v3.1.44+) with an approximate cash
// equivalent for item-based OC payouts so "Top end $" isn't empty on
// scenarios like Best of the Lot / Pet Project that pay in items
// instead of cash.
//
// Loads from Torn v2 /torn?selections=items on startup and every 6h.
// No faction access required — minimal key suffices.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname as pathDirname, join as pathJoin } from "node:path";

const CACHE_FILE = pathJoin(process.env.DATA_DIR || './data', 'item-market-values.json');
const REFRESH_MS = 6 * 60 * 60 * 1000;

let _values = {};          // { [itemId]: marketValue }
let _fetchedAt = 0;

function _load() {
  try {
    if (!existsSync(CACHE_FILE)) return;
    const raw = readFileSync(CACHE_FILE, 'utf8');
    const obj = JSON.parse(raw);
    if (obj?.values && typeof obj.values === 'object') {
      _values = obj.values;
      _fetchedAt = Number(obj.fetchedAt) || 0;
      console.log(`[item-values] loaded ${Object.keys(_values).length} item prices from disk (fetchedAt ${new Date(_fetchedAt).toISOString()})`);
    }
  } catch (e) {
    console.warn('[item-values] load failed:', e.message);
  }
}
_load();

function _save() {
  try {
    const dir = pathDirname(CACHE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ values: _values, fetchedAt: _fetchedAt }, null, 0), 'utf8');
  } catch (e) {
    console.warn('[item-values] save failed:', e.message);
  }
}

async function _refresh() {
  const key = process.env.OWNER_API_KEY;
  if (!key) {
    console.warn('[item-values] no OWNER_API_KEY, skipping refresh');
    return;
  }
  try {
    const url = `https://api.torn.com/v2/torn?selections=items&key=${encodeURIComponent(key)}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[item-values] HTTP ${res.status} on refresh`);
      return;
    }
    const data = await res.json();
    if (data?.error) {
      console.warn('[item-values] API error:', data.error.error || data.error);
      return;
    }
    // v2 returns `items` as an array, each with nested `value.market_price`
    // (not a flat market_value). Normalise to { [id]: price }.
    const items = Array.isArray(data.items) ? data.items : Object.values(data.items || {});
    const out = {};
    for (const it of items) {
      const id = it?.id ?? it?.ID;
      if (id == null) continue;
      const mp = Number(
        it?.value?.market_price ?? it?.market_value ?? it?.marketValue ?? 0
      );
      if (Number.isFinite(mp) && mp > 0) out[String(id)] = mp;
    }
    if (Object.keys(out).length > 0) {
      _values = out;
      _fetchedAt = Date.now();
      _save();
      console.log(`[item-values] refreshed ${Object.keys(_values).length} item prices`);
    }
  } catch (e) {
    console.warn('[item-values] refresh failed:', e.message);
  }
}

export function getItemMarketValue(id) {
  if (id == null) return 0;
  return Number(_values[String(id)]) || 0;
}

export function getItemValueFetchedAt() { return _fetchedAt; }

// Kick a refresh at startup if cache is stale (or empty), and schedule
// periodic refreshes every 6h.
if (Date.now() - _fetchedAt > REFRESH_MS) {
  setTimeout(_refresh, 5000); // small delay so server finishes booting first
}
setInterval(_refresh, REFRESH_MS);
