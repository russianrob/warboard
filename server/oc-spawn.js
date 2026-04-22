import { fetchFactionBasic } from "./torn-api.js";
import * as store from "./store.js";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const OC_HISTORY_DIR = pathJoin(process.env.DATA_DIR || pathJoin(__dirname, 'data'), 'oc-history');

// Read the disk OC history archive. This contains older completions that
// rolled out of the 90-day Torn API window but still matter for establishing
// how experienced a member is. Normalized to the same shape as API crimes so
// buildCprCache can treat both identically.
function loadAndNormalizeDiskHistory(factionId) {
  try {
    const file = pathJoin(OC_HISTORY_DIR, `${factionId}.json`);
    if (!existsSync(file)) return [];
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    if (!Array.isArray(raw)) return [];
    return raw.map(e => ({
      id: e.crimeId,
      name: e.crimeName,
      difficulty: e.difficulty || 0,
      slots: (e.slots || []).map(s => ({
        user_id: s.userId,
        position: s.position,
        checkpoint_pass_rate: s.weight,
      })),
    }));
  } catch (_) {
    return [];
  }
}

const CPR_LOOKBACK_DAYS = 90;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

const factionOcsCache    = new Map(); // factionId -> { timestamp, cprCache, completedCrimes }
// Short-TTL caches for high-frequency endpoints. These were being called on
// every spawn-key request (one per user refresh), burning through Torn's
// 100-req/min rate limit. 30s TTL is short enough that recruitment / member
// state still feels live, long enough that 10 users hitting the panel
// simultaneously share a single API call.
const AVAILABLE_TTL_MS   = 30 * 1000;
const BASIC_TTL_MS       = 30 * 1000;
const availableCache     = new Map(); // factionId -> { ts, crimes }
const basicCache         = new Map(); // factionId -> { ts, data }

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
  const now = Date.now();
  const cached = availableCache.get(String(factionId));
  if (cached && (now - cached.ts) < AVAILABLE_TTL_MS) return cached.crimes;

  const url = `https://api.torn.com/v2/faction/crimes?cat=available&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Torn API HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.error);

  const crimes = Array.isArray(data.crimes) ? data.crimes : Object.values(data.crimes || {});
  availableCache.set(String(factionId), { ts: now, crimes });
  return crimes;
}

// Minimum # of completed crimes at topLevel before we'll project a member
// up to topLevel+1 (joinable boost). Without this, a single lucky completion
// pushes a member into the next tier on the optimizer's recommendations,
// which for new/returning members almost always fails.
const MIN_SAMPLES_FOR_BOOST = 3;

// Extract current placements from non-completed crimes. A member sitting
// on a level-4 Planning/Executing crime right now is demonstrably at least
// level-4-capable — someone placed them there. We use this as evidence that
// boosts their `highestLevel` floor even if their completed-crime history
// is thin (brand-new members especially).
function extractCurrentPlacements(crimes) {
  const placements = {};
  for (const crime of crimes) {
    // Recruiting: slot-filler may not have been accepted yet. Skip.
    if (crime.status === 'Recruiting') continue;
    const diff = crime.difficulty || 0;
    if (!Array.isArray(crime.slots)) continue;
    for (const slot of crime.slots) {
      const uid = slot.user_id ?? slot.user?.id;
      if (!uid) continue;
      if ((placements[uid] || 0) < diff) placements[uid] = diff;
    }
  }
  return placements;
}

function buildCprCache(completedCrimes, currentPlacements = {}) {
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

  // Merge in-progress placements. This helps new members who are currently
  // sitting on a higher-difficulty OC but have no completions to show for it.
  for (const [uid, diff] of Object.entries(currentPlacements)) {
    if ((highestLevel[uid] || 0) < diff) highestLevel[uid] = diff;
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

      if (!cache[uid]) cache[uid] = { rateSum: 0, count: 0, entries: [], topLevelCount: 0 };
      cache[uid].rateSum += rawRate;
      cache[uid].count += 1;
      cache[uid].entries.push({ diff, rate: rawRate });
      if (diff === topLevel) cache[uid].topLevelCount += 1;
    }
  }

  const result = {};
  const MINCPR = 60;
  const CPR_BOOST = 15;
  for (const [uid, d] of Object.entries(cache)) {
    const cpr = d.count > 0 ? d.rateSum / d.count : 0;
    const topLevel = highestLevel[uid] || 0;
    // Only allow joinable+1 projection if we have enough samples AT the
    // current top level. One lucky completion isn't enough evidence.
    const eligibleForBoost =
        cpr >= MINCPR + CPR_BOOST
        && d.topLevelCount >= MIN_SAMPLES_FOR_BOOST;
    const joinable = eligibleForBoost ? Math.min(topLevel + 1, 10) : topLevel;
    result[uid] = {
      cpr: Math.round(cpr * 10) / 10,
      samples: d.count,
      topLevelSamples: d.topLevelCount,
      highestLevel: topLevel,
      joinable,
      entries: d.entries,
      currentPlacement: currentPlacements[uid] || 0,
    };
  }

  // Members currently placed in a crime but with NO completed history.
  // Their placement is evidence of capability at that difficulty.
  for (const [uid, diff] of Object.entries(currentPlacements)) {
    if (result[uid]) continue;
    result[uid] = {
      cpr: 0, samples: 0, topLevelSamples: 0,
      highestLevel: diff,
      joinable: diff,
      entries: [],
      currentPlacement: diff,
    };
  }

  return result;
}

/**
 * Return raw completed crimes from the cache for a given faction.
 * Used by routes.js engines (slot optimizer, failure risk, etc.) for OC history.
 * Returns [] if no cached data yet (caller should handle gracefully).
 */
// ── OC Outcome Distribution (private admin build) ────────────────────────
// Proxies tornprobability.com's CalculateSuccess endpoint for a given
// scenario + CPR-per-slot array and returns the full outcome distribution
// (success/failure plus per-ending probabilities).
//
// Deliberately admin-only in routes.js — surfacing expected-reward
// probabilities to every faction member creates adverse selection
// (members cluster into high-EV OCs, low-tier slates starve). This helper
// is plumbing only; no public endpoint exposes it without role check.
//
// Cached per (scenario, rounded-CPR-tuple). CPRs rounded to whole numbers
// so near-identical slates share a cache entry.
const _outcomeCache = new Map();
const OUTCOME_TTL_MS = 15 * 60 * 1000;
export async function calculateOutcome(scenario, cprs) {
  if (!scenario || !Array.isArray(cprs) || cprs.length === 0) {
    return { error: "missing scenario or cprs" };
  }
  const rounded = cprs.map((v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
  });
  const key = scenario + "|" + rounded.join(",");
  const cached = _outcomeCache.get(key);
  if (cached && (Date.now() - cached.ts) < OUTCOME_TTL_MS) return cached.data;
  try {
    const res = await fetch("https://tornprobability.com:3000/api/CalculateSuccess", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario, parameters: rounded }),
    });
    if (!res.ok) return { error: "upstream " + res.status };
    const data = await res.json();
    _outcomeCache.set(key, { data, ts: Date.now() });
    return data;
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

export function getCachedCompletedCrimes(factionId) {
  const cached = factionOcsCache.get(factionId);
  if (cached && cached.completedCrimes) return cached.completedCrimes;
  return [];
}

// Add synthetic cprCache entries for members with no completed-crime history
// AND no current OC placement. Uses level-bucketed priors from established
// members in the faction so a level-41 new member inherits the typical
// joinable level of other 40-59 members, not joinable=1.
function augmentWithSyntheticProfiles(cprCache, members) {
  const levelByUid = {};
  for (const m of members) levelByUid[String(m.id || m.playerId || m.uid)] = m.level || 0;

  const bucketKey = (lvl) => {
    if (!lvl) return 'unknown';
    if (lvl < 20)  return '1-19';
    if (lvl < 40)  return '20-39';
    if (lvl < 60)  return '40-59';
    if (lvl < 80)  return '60-79';
    if (lvl < 100) return '80-99';
    return '100+';
  };

  // Build level-bucket priors from established members (3+ samples)
  const buckets = {};
  for (const [uid, c] of Object.entries(cprCache)) {
    if ((c.samples || 0) < 3) continue;
    const b = bucketKey(levelByUid[uid]);
    if (!buckets[b]) buckets[b] = { cprSum: 0, cprCount: 0, joinables: [] };
    buckets[b].cprSum += c.cpr || 0;
    buckets[b].cprCount += 1;
    if (typeof c.joinable === 'number') buckets[b].joinables.push(c.joinable);
  }
  function priorCprFor(lvl) {
    const b = buckets[bucketKey(lvl)];
    return (!b || b.cprCount < 2) ? 50 : Math.round((b.cprSum / b.cprCount) * 10) / 10;
  }
  function priorJoinableFor(lvl) {
    const b = buckets[bucketKey(lvl)];
    if (!b || b.joinables.length < 2) return 1;
    const sorted = b.joinables.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
      : sorted[mid];
  }

  // Fill in synthetic profiles for everyone missing from cache
  for (const m of members) {
    const uid = String(m.id || m.playerId || m.uid);
    if (cprCache[uid]) continue;   // real history, skip
    const pc = priorCprFor(m.level);
    const pj = priorJoinableFor(m.level);
    cprCache[uid] = {
      cpr: pc,
      samples: 0, topLevelSamples: 0,
      highestLevel: pj,
      joinable: pj,
      entries: [],
      currentPlacement: 0,
      synthetic: true,               // lets the client distinguish projected vs real
    };
  }
  return cprCache;
}

export async function getOcSpawnData(factionId, apiKey) {
  // Fetch available first so we can extract current placements and feed
  // them into the cache build. Completed-crimes cache is long-lived (6h TTL),
  // but placements are re-derived every call — they change minute to minute.
  const availableCrimes = await fetchAvailableCrimes(factionId, apiKey);
  const currentPlacements = extractCurrentPlacements(availableCrimes);

  // Load disk history every call (fast, small file, may have been updated
  // by routes.js's persist path in the last few minutes). API crimes are
  // cached for 6h separately.
  const diskHistory = loadAndNormalizeDiskHistory(factionId);

  let cprCache = null;
  const cached = factionOcsCache.get(factionId);
  const cacheFresh = cached && (Date.now() - cached.timestamp < CACHE_TTL_MS);
  let completedCrimes;
  if (cacheFresh) {
    completedCrimes = cached.completedCrimes;
  } else {
    completedCrimes = await fetchCompletedCrimes(factionId, apiKey);
    factionOcsCache.set(factionId, { timestamp: Date.now(), completedCrimes });
  }

  // Merge API completions (last 90 days, high fidelity) with disk history
  // (older archive). Dedupe by crimeId — API wins when overlap exists since
  // it has the checkpoint_pass_rate directly.
  const seen = new Set();
  const mergedCrimes = [];
  for (const c of completedCrimes) {
    const cid = String(c.id);
    if (seen.has(cid)) continue;
    seen.add(cid);
    mergedCrimes.push(c);
  }
  for (const c of diskHistory) {
    const cid = String(c.id);
    if (seen.has(cid)) continue;
    seen.add(cid);
    mergedCrimes.push(c);
  }
  cprCache = buildCprCache(mergedCrimes, currentPlacements);

  // Short-lived cache for faction basic data (member list + status) —
  // avoids calling this endpoint once per spawn-key request per user.
  const now = Date.now();
  let basicData;
  const basicCached = basicCache.get(String(factionId));
  if (basicCached && (now - basicCached.ts) < BASIC_TTL_MS) {
    basicData = basicCached.data;
  } else {
    basicData = await fetchFactionBasic(factionId, apiKey);
    basicCache.set(String(factionId), { ts: now, data: basicData });
  }
  const members = Object.entries(basicData.members || {}).map(([id, m]) => ({ id, ...m }));

  // Now that we have both cprCache + members, backfill synthetic entries for
  // members missing from the cache (no history AND not currently placed).
  augmentWithSyntheticProfiles(cprCache, members);

  return { members, availableCrimes, cprCache };
}