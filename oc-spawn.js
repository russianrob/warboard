import { fetchFactionBasic } from "./torn-api.js";
import * as store from "./store.js";

const CPR_LOOKBACK_DAYS = 90;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

const factionOcsCache = new Map(); // factionId -> { timestamp, cprCache }

// Helper to fetch from Torn API directly if not in torn-api.js
function _tornError(data) {
  if (!data.error) return null;
  if (data.error.code === 8 || /incorrect.*id|id.*entity/i.test(data.error.error))
    return new Error('Forbidden — please use a faction API access key (Limited or higher).');
  return new Error(data.error.error);
}

async function fetchCompletedCrimes(factionId, apiKey) {
  const fromTs = Math.floor(Date.now() / 1000) - (CPR_LOOKBACK_DAYS * 86400);
  const url = `https://api.torn.com/v2/faction/crimes?cat=completed&sort=DESC&from=${fromTs}&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Torn API HTTP ${res.status}`);
  const data = await res.json();
  const err = _tornError(data); if (err) throw err;
  
  if (Array.isArray(data.crimes)) return data.crimes;
  return Object.values(data.crimes || {});
}

async function fetchAvailableCrimes(factionId, apiKey) {
  const url = `https://api.torn.com/v2/faction/crimes?cat=available&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Torn API HTTP ${res.status}`);
  const data = await res.json();
  const err = _tornError(data); if (err) throw err;
  
  if (Array.isArray(data.crimes)) return data.crimes;
  return Object.values(data.crimes || {});
}

function buildCprCache(completedCrimes) {
  const highestLevel = {};
  for (const crime of completedCrimes) {
    const diff = crime.difficulty || 0;
    if (!Array.isArray(crime.slots)) continue;
    for (const slot of crime.slots) {
      const uid = slot.user_id ?? slot.user?.id;
      if (!uid) continue;
      if ((highestLevel[uid] || 0) < diff) highestLevel[uid] = diff;
    }
  }

  const cache = {};
  for (const crime of completedCrimes) {
    const diff = crime.difficulty || 0;
    if (!Array.isArray(crime.slots)) continue;

    for (const slot of crime.slots) {
      const uid = slot.user_id ?? slot.user?.id;
      if (!uid) continue;
      const topLevel = highestLevel[uid] || 0;
      if (diff < topLevel - 1) continue;

      const rawRate = slot.checkpoint_pass_rate ?? slot.success_chance ?? null;
      if (rawRate === null) continue;

      if (!cache[uid]) cache[uid] = { rateSum: 0, count: 0, entries: [], byPosition: {} };
      cache[uid].rateSum += rawRate;
      cache[uid].count += 1;
      const crimeName = crime.name || '';
      const posName   = slot.position || 'Unknown';
      // Scope to crime type so "Cleaner" in "Break the Bank" is separate from "Blast from the Past"
      const posKey    = `${crimeName}::${slot.position_id || slot.position || 'unknown'}`;
      cache[uid].entries.push({ diff, rate: rawRate, position: posName, crimeName });
      if (!cache[uid].byPosition[posKey]) {
        cache[uid].byPosition[posKey] = { position: posName, crimeName, rateSum: 0, count: 0 };
      }
      cache[uid].byPosition[posKey].rateSum += rawRate;
      cache[uid].byPosition[posKey].count   += 1;
    }
  }

  const result = {};
  const MINCPR = 60;
  const CPR_BOOST = 15;
  for (const [uid, d] of Object.entries(cache)) {
    const cpr = d.count > 0 ? d.rateSum / d.count : 0;
    const topLevel = highestLevel[uid] || 0;
    const joinable = cpr >= MINCPR + CPR_BOOST ? Math.min(topLevel + 1, 10) : topLevel;
    const byPosition = {};
    for (const [posKey, pd] of Object.entries(d.byPosition || {})) {
      byPosition[posKey] = { position: pd.position, crimeName: pd.crimeName || '', cpr: Math.round(pd.rateSum / pd.count * 10) / 10, count: pd.count };
    }
    result[uid] = { cpr: Math.round(cpr * 10) / 10, highestLevel: topLevel, joinable, entries: d.entries, byPosition };
  }
  return result;
}


function estimateCprFromLevel(level) {
    if      (level <= 15)  return { cpr: 40, highestLevel: 1, entries: [], estimated: true };
    else if (level <= 30)  return { cpr: 55, highestLevel: 3, entries: [], estimated: true };
    else if (level <= 50)  return { cpr: 65, highestLevel: 5, entries: [], estimated: true };
    else if (level <= 75)  return { cpr: 72, highestLevel: 7, entries: [], estimated: true };
    else if (level <= 100) return { cpr: 78, highestLevel: 8, entries: [], estimated: true };
    else                   return { cpr: 82, highestLevel: 9, entries: [], estimated: true };
}


// ── OC Role Weights (from tornprobability.com) ────────────────────────────
let _weightsCache = null;
let _weightsFetchedAt = 0;
const WEIGHTS_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function _normalizeKey(str) {
    return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function getOcWeights() {
    if (_weightsCache && (Date.now() - _weightsFetchedAt) < WEIGHTS_TTL_MS) return _weightsCache;
    try {
        const res = await fetch('https://tornprobability.com:3000/api/GetRoleWeights');
        if (res.ok) {
            _weightsCache = await res.json();
            _weightsFetchedAt = Date.now();
            console.log('[oc-weights] Fetched role weights from tornprobability.com');
        }
    } catch (e) {
        console.warn('[oc-weights] Failed to fetch weights:', e.message);
    }
    return _weightsCache || {};
}

export async function getOcSpawnData(factionId, apiKey) {
  // Use OWNER_API_KEY only for the owner's own faction (42055).
  // v2 /faction/crimes has no faction ID param — it returns the key holder's faction.
  // For other factions, we must use the member's own key so crimes come from the right faction.
  const ownerFactionId = String(process.env.OWNER_FACTION_ID || '42055');
  const fetchKey = (String(factionId) === ownerFactionId && process.env.OWNER_API_KEY)
    ? process.env.OWNER_API_KEY
    : apiKey;

  let cprCache = null;
  const cached = factionOcsCache.get(factionId);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
    cprCache = cached.cprCache;
  } else {
    const completedCrimes = await fetchCompletedCrimes(factionId, fetchKey);
    cprCache = buildCprCache(completedCrimes);
    factionOcsCache.set(factionId, { timestamp: Date.now(), cprCache });
  }

  const availableCrimes = await fetchAvailableCrimes(factionId, fetchKey);
  const basicData = await fetchFactionBasic(factionId, fetchKey);
  const members = Object.entries(basicData.members || {}).map(([id, m]) => ({ id, ...m }));

  for (const m of members) {
    const uid = String(m.id);
    if (!cprCache[uid] && m.level) cprCache[uid] = estimateCprFromLevel(m.level);
  }
  // Fetch role weights (cached 24h)
  const weights = await getOcWeights();

  return { members, availableCrimes, cprCache, weights };
}