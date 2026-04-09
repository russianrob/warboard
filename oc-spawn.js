import { fetchFactionBasic } from "./torn-api.js";
import * as store from "./store.js";

const CPR_LOOKBACK_DAYS = 90;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

const factionOcsCache = new Map(); // factionId -> { timestamp, cprCache }

// Helper to fetch from Torn API directly if not in torn-api.js
async function fetchCompletedCrimes(factionId, apiKey) {
  const fromTs = Math.floor(Date.now() / 1000) - (CPR_LOOKBACK_DAYS * 86400);
  const url = `https://api.torn.com/v2/faction/crimes?cat=completed&sort=DESC&from=${fromTs}&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Torn API HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.error);
  
  if (Array.isArray(data.crimes)) return data.crimes;
  return Object.values(data.crimes || {});
}

async function fetchAvailableCrimes(factionId, apiKey) {
  const url = `https://api.torn.com/v2/faction/crimes?cat=available&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Torn API HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.error);
  
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
      const posKey  = slot.position_id || slot.position || 'unknown';
      const posName = slot.position    || 'Unknown';
      cache[uid].entries.push({ diff, rate: rawRate, position: posName });
      if (!cache[uid].byPosition[posKey]) {
        cache[uid].byPosition[posKey] = { position: posName, rateSum: 0, count: 0 };
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
      byPosition[posKey] = { position: pd.position, cpr: Math.round(pd.rateSum / pd.count * 10) / 10, count: pd.count };
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

export async function getOcSpawnData(factionId, apiKey) {
  let cprCache = null;
  const cached = factionOcsCache.get(factionId);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
    cprCache = cached.cprCache;
  } else {
    const completedCrimes = await fetchCompletedCrimes(factionId, apiKey);
    cprCache = buildCprCache(completedCrimes);
    factionOcsCache.set(factionId, { timestamp: Date.now(), cprCache });
  }

  const availableCrimes = await fetchAvailableCrimes(factionId, apiKey);
  const basicData = await fetchFactionBasic(factionId, apiKey);
  const members = Object.entries(basicData.members || {}).map(([id, m]) => ({ id, ...m }));

  for (const m of members) {
    const uid = String(m.id);
    if (!cprCache[uid] && m.level) cprCache[uid] = estimateCprFromLevel(m.level);
  }
  return { members, availableCrimes, cprCache };
}