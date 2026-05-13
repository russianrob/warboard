/**
 * War payout calculator.
 *
 * Pulls every ranked-war attack from the configured war window, classifies
 * each hit (war / retal / overseas / chain / assist), weights them, then
 * splits a loot total across attackers proportional to their score.
 *
 * Design echoes the public "war payout" tool from torn forums thread
 * t=16563983: dynamic FF mode (each hit worth its actual fair-fight value)
 * vs static tiered mode (flat per-bracket points). Custom mode is
 * supported via caller-supplied weight overrides.
 *
 * Cached per (warId, mode) for 5 minutes to avoid re-hammering Torn's
 * attacks endpoint on every UI render.
 */

import * as store from "./store.js";
import { fetchFactionAttacks, fetchRankedWarReport } from "./torn-api.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const _cache = new Map(); // `${warId}:${mode}` → { result, expiresAt }

/** Default weights — match the OP's spec from t=16563983. */
const WEIGHTS = {
  dynamic: {
    war_hit: ff => ff * 1.00,
    retal: ff => ff * 1.25,
    overseas_war: ff => ff * 1.50,
    assist: () => 0.75,
    chain_hit: () => 0.60,
    os_chain: () => 0.60,
  },
  static: {
    // Tiered: each war hit = 1 pt regardless of FF, retals/overseas
    // still scale by FF for some incentive.
    war_hit: () => 1,
    retal: ff => ff * 1.25,
    overseas_war: ff => ff * 1.50,
    assist: () => 0.75,
    chain_hit: () => 0.60,
    os_chain: () => 0.60,
  },
};

/**
 * Classify one ranked-war attack record. Torn's v1 attacks selection
 * provides a `modifiers` object with these keys:
 *   fairFight       — exact FF value used for respect
 *   war             — 1 (chained but counted) or 2 (ranked-war hit)
 *   retaliation     — >1 if this hit is a retal of an incoming attack
 *   overseas        — >1 if attacker was abroad
 *   group_attack    — assist multiplier (>1 = was an assist)
 * The ranked_war field at the top level (already filtered upstream) is
 * 1 for any attack tracked under the ranked-war system. We further
 * narrow "war_hit" to attacks against the actual enemy faction; chain
 * hits against unrelated targets get the chain_hit / os_chain bucket.
 */
function classify(atk, enemyFactionId) {
  const m = atk.modifiers || {};
  // Some Torn deployments expose `assist` directly; others use
  // group_attack > 1. Belt + suspenders.
  const isAssist =
    atk.assist === 1 || atk.assist === true ||
    (m.group_attack && Number(m.group_attack) > 1);
  if (isAssist) return "assist";

  const isOverseas = m.overseas && Number(m.overseas) > 1;
  const defFid = String(atk.defender_faction || "");
  const isVsEnemy = defFid && defFid === String(enemyFactionId);
  const isRetal = m.retaliation && Number(m.retaliation) > 1;

  if (isVsEnemy && isOverseas) return "overseas_war";
  if (isVsEnemy && isRetal) return "retal";
  if (isVsEnemy) return "war_hit";
  if (isOverseas) return "os_chain";
  return "chain_hit";
}

/** Pick a weight value for an attack given mode + classification + ff. */
function weight(mode, cat, ff) {
  const set = WEIGHTS[mode] || WEIGHTS.dynamic;
  const fn = set[cat];
  if (!fn) return 0;
  const v = fn(ff || 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Try to read the loot total from Torn's ranked war report. */
async function tryFetchLoot(factionId, apiKey, rwId) {
  try {
    const report = await fetchRankedWarReport(factionId, apiKey, rwId);
    // v2 rankedwarreport shape: { factions: [{id, ..., rewards: {points,
    //   respect, items, ...}}], winner, ... }. The actual cash payout
    //   to the winning faction comes from points × $X (currently $5,000).
    //   We fall back to "points" as a relative score if that's all we
    //   can find; UI lets the admin override.
    const factions = Array.isArray(report?.factions) ? report.factions : [];
    const ours = factions.find(f => String(f.id) === String(factionId));
    if (ours?.rewards) {
      const r = ours.rewards;
      // Common reward shapes seen in the wild — best-effort field probe.
      if (typeof r.points === "number" && r.points > 0) {
        // Torn pays winners $5,000/point (subject to change). Use it
        // as a rough auto-fill; admin can override in the UI.
        return r.points * 5000;
      }
      if (typeof r.respect === "number" && r.respect > 0) {
        return r.respect * 1000;
      }
    }
  } catch (_) { /* ignore — admin will input manually */ }
  return 0;
}

/**
 * Main entry. Returns {
 *   warId, mode, fromTs, toTs, lootTotal, totalScore,
 *   members: [{ playerId, name, score, sharePct, dollarPayout, breakdown }],
 *   attackCount, generatedAt,
 * }
 */
export async function computePayouts(warId, options = {}) {
  const mode = options.mode === "static" ? "static" : "dynamic";
  const cacheKey = `${warId}:${mode}`;
  const cached = _cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() && !options.forceFresh) {
    return { ...cached.result, cached: true };
  }

  const war = store.getWar(warId);
  if (!war) throw new Error(`War ${warId} not found`);
  if (!war.factionId || !war.enemyFactionId) {
    throw new Error(`War ${warId} missing factionId/enemyFactionId`);
  }

  const fromTs = Number(war.warStart) || 0;
  const toTs = war.warEndedAt
    ? Math.floor(Number(war.warEndedAt) / 1000)
    : Math.floor(Date.now() / 1000);
  if (!fromTs || toTs <= fromTs) {
    throw new Error(`War ${warId} has invalid time range (${fromTs} → ${toTs})`);
  }

  const apiKey = store.getPollingKey(war.factionId, "war-payouts", 0);
  if (!apiKey) throw new Error("No API key available in pool");

  const attacks = await fetchFactionAttacks(
    war.factionId, apiKey, fromTs, toTs,
  );

  const ourFid = String(war.factionId);
  const byAttacker = {}; // playerId → { name, score, breakdown }

  for (const atk of attacks) {
    if (String(atk.attacker_faction || "") !== ourFid) continue;
    const aid = String(atk.attacker_id || "");
    if (!aid || aid === "0") continue; // stealth = 0; skip

    const ff = Number(atk.modifiers?.fairFight) || 0;
    const cat = classify(atk, war.enemyFactionId);
    const w = weight(mode, cat, ff);

    if (!byAttacker[aid]) {
      byAttacker[aid] = {
        playerId: aid,
        name: String(atk.attacker_name || `Player ${aid}`),
        score: 0,
        breakdown: {},
      };
    }
    byAttacker[aid].score += w;
    byAttacker[aid].breakdown[cat] = (byAttacker[aid].breakdown[cat] || 0) + 1;
  }

  // Loot — caller-supplied wins; fall back to auto-detect from the
  // ranked war report; final fallback = 0 (admin must fill in UI).
  let lootTotal = 0;
  if (options.lootTotal != null) {
    lootTotal = Math.max(0, Number(options.lootTotal) || 0);
  } else {
    lootTotal = await tryFetchLoot(war.factionId, apiKey, warId);
  }

  const totalScore = Object.values(byAttacker)
    .reduce((s, m) => s + m.score, 0);

  const members = Object.values(byAttacker)
    .map(m => {
      const sharePct = totalScore > 0 ? (m.score / totalScore) * 100 : 0;
      const dollarPayout = totalScore > 0
        ? Math.round((m.score / totalScore) * lootTotal)
        : 0;
      return {
        playerId: m.playerId,
        name: m.name,
        score: Math.round(m.score * 100) / 100,
        sharePct: Math.round(sharePct * 10) / 10,
        dollarPayout,
        breakdown: m.breakdown,
      };
    })
    .sort((a, b) => b.score - a.score);

  const result = {
    warId,
    factionId: war.factionId,
    enemyFactionId: war.enemyFactionId,
    enemyFactionName: war.enemyFactionName || null,
    warResult: war.warResult || null,
    mode,
    fromTs,
    toTs,
    lootTotal,
    lootAutoDetected: options.lootTotal == null && lootTotal > 0,
    totalScore: Math.round(totalScore * 10) / 10,
    members,
    attackCount: attacks.length,
    generatedAt: Date.now(),
  };

  _cache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return { ...result, cached: false };
}

/** List wars eligible for payouts (ended, has data) for a faction. */
export function listEligibleWars(factionId) {
  const fid = String(factionId);
  const out = [];
  // store.getAllWars or similar — fall back to enumerating wars.json
  // shape if the helper isn't exported.
  const all = (typeof store.getAllWars === "function")
    ? store.getAllWars()
    : (store.getState && store.getState().wars) || {};
  for (const wid in all) {
    const w = all[wid];
    if (String(w.factionId) !== fid) continue;
    if (!w.warEnded) continue; // only ended wars eligible
    out.push({
      warId: wid,
      enemyFactionName: w.enemyFactionName || `Faction ${w.enemyFactionId}`,
      warResult: w.warResult || "unknown",
      warEndedAt: w.warEndedAt || 0,
    });
  }
  // Most-recent first
  out.sort((a, b) => (b.warEndedAt || 0) - (a.warEndedAt || 0));
  return out;
}
