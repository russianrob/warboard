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
import fs from "fs";
import path from "path";

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

// Cache the item-market-values.json read in-process — it's static-ish
// and we don't want to hit the disk for every payout call.
let _itemValuesCache = null;
let _itemValuesLoadedAt = 0;
function loadItemMarketValues() {
  if (_itemValuesCache && Date.now() - _itemValuesLoadedAt < 600_000) {
    return _itemValuesCache;
  }
  try {
    const file = path.join(process.env.DATA_DIR || "./data", "item-market-values.json");
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw);
    _itemValuesCache = parsed.values || parsed || {};
    _itemValuesLoadedAt = Date.now();
  } catch (_) {
    _itemValuesCache = {};
  }
  return _itemValuesCache;
}

/**
 * Auto-detect loot total from Torn's ranked war report rewards.
 *
 * Prior bug: this returned `respect × $1000`. Respect is a faction
 * stat — not cash — so the auto-detected loot for war 40638 came back
 * as ~$6.37M when the actual cache value was ~$1.73B.
 *
 * New approach: sum the market value of each item cache we received
 * (Armor / Melee / Small / Medium / Heavy Arms), using the cached
 * data/item-market-values.json the warboard already maintains. That
 * gives the *theoretical* sale value at current market prices — the
 * admin can still override per-war via /api/war/:warId/loot-override
 * to reflect actual realized sale price + treasury contribution.
 */
async function tryFetchLoot(factionId, apiKey, rwId) {
  // Returns { total, items: [{id, name, quantity, unitPrice, lineTotal}], cash, source }
  // so the UI can show *how* the estimate was computed (per-cache market
  // value × quantity), which is what admins actually need to verify the
  // number — and to override it if they sold below market or added
  // treasury cash.
  const out = { total: 0, items: [], cash: 0, source: "none" };
  try {
    const report = await fetchRankedWarReport(factionId, apiKey, rwId);
    const factions = Array.isArray(report?.factions) ? report.factions : [];
    const ours = factions.find(f => String(f.id) === String(factionId));
    if (!ours?.rewards) return out;
    const r = ours.rewards;
    if (typeof r.cash === "number" && r.cash > 0) out.cash += r.cash;
    if (typeof r.money === "number" && r.money > 0) out.cash += r.money;
    out.total += out.cash;
    if (Array.isArray(r.items) && r.items.length > 0) {
      const values = loadItemMarketValues();
      for (const it of r.items) {
        const id = String(it.id);
        const qty = Number(it.quantity) || 0;
        const unit = Number(values[id]) || 0;
        const lineTotal = qty * unit;
        out.items.push({
          id,
          name: it.name || `Item ${id}`,
          quantity: qty,
          unitPrice: unit,
          lineTotal,
        });
        out.total += lineTotal;
      }
    }
    if (out.total > 0) {
      out.source = out.items.length > 0 ? "caches+cash" : "cash";
    } else if (typeof r.points === "number" && r.points > 0) {
      // Last-resort fallback (Torn pays $5K/pt for some war tiers).
      out.total = r.points * 5000;
      out.source = "points";
    }
  } catch (_) { /* admin will input manually */ }
  return out;
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

  // Pool keys can return Torn error code 7 ("Incorrect ID-entity
  // relation") when the key's owner left the faction or lost access.
  // Rotate through up to POOL_RETRY_LIMIT pool keys, quarantining any
  // that fail with code 7 so future calls skip them. Without this
  // rotation a single dead key in the pool silently returns [] and
  // the Payouts UI shows "no wars available" even with valid wars.
  const POOL_RETRY_LIMIT = 8;
  const triedKeys = new Set();
  let attacks = null;
  let lastErr = null;
  let apiKey = null; // hoisted — downstream (tryFetchLoot) reuses the working key.
  for (let attempt = 0; attempt < POOL_RETRY_LIMIT; attempt++) {
    const candidate = store.getPollingKey(war.factionId, "war-payouts", attempt);
    if (!candidate) break;
    if (triedKeys.has(candidate)) continue;
    triedKeys.add(candidate);
    try {
      attacks = await fetchFactionAttacks(war.factionId, candidate, fromTs, toTs);
      apiKey = candidate;
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (err.code === 7) {
        // Permanent key issue for THIS faction — quarantine + try the next.
        store.quarantinePoolKey(candidate, war.factionId, `war-payouts: code 7 (${err.message})`);
        continue;
      }
      // Any other error (rate limit, network, etc.) — bail immediately
      // rather than burn through every key in the pool.
      throw err;
    }
  }
  if (attacks == null) {
    throw new Error(
      lastErr
        ? `All pool keys failed (last: ${lastErr.message})`
        : "No API key available in pool"
    );
  }

  const ourFid = String(war.factionId);
  const byAttacker = {}; // playerId → { name, computedScore, breakdown, attackCount }

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
        computedScore: 0,
        breakdown: {},
        attackCount: 0,
      };
    }
    byAttacker[aid].computedScore += w;
    byAttacker[aid].breakdown[cat] = (byAttacker[aid].breakdown[cat] || 0) + 1;
    byAttacker[aid].attackCount += 1;
  }

  // ── Authoritative scores: pull Torn's official ranked-war report ─────
  // Prior bug: my weighted-attack score (war_hit=ff*1, retal=ff*1.25, …)
  // is a rough approximation that doesn't match what Torn actually
  // shows in war.php?step=rankreport. Torn's score factors in defender
  // level, fair fight, group bonuses, overseas penalties — all the
  // respect-formula nuance that's not in the attack-modifiers field.
  // When the official report exists, use its per-member scores 1:1 so
  // the Payouts tab matches Torn's own ranking. Fall back to weighted
  // computation only when the report isn't available (war too recent
  // for the report to be published, or API rejects it).
  let reportMembers = null;
  let scoreSource = "computed";
  let reportTotalScore = 0;
  let reportTotalAttacks = 0;
  try {
    const report = await fetchRankedWarReport(war.factionId, apiKey, warId);
    const factionsList = Array.isArray(report.factions)
      ? report.factions
      : Object.values(report.factions || {});
    const myFaction = factionsList.find(f => String(f.id) === ourFid);
    if (myFaction && Array.isArray(myFaction.members) && myFaction.members.length > 0) {
      reportMembers = myFaction.members;
      scoreSource = "report";
      for (const m of reportMembers) {
        reportTotalScore += Number(m.score) || 0;
        reportTotalAttacks += Number(m.attacks) || 0;
      }
    }
  } catch (_) {
    // Report unavailable — use computed weighted scores below.
  }

  // Loot — caller-supplied wins; fall back to auto-detect from the
  // ranked war report; final fallback = 0 (admin must fill in UI).
  let lootTotal = 0;
  let lootBreakdown = null;
  let lootSource = "none";
  if (options.lootTotal != null) {
    lootTotal = Math.max(0, Number(options.lootTotal) || 0);
    lootSource = "override";
  } else {
    const detected = await tryFetchLoot(war.factionId, apiKey, warId);
    lootTotal = detected.total;
    lootBreakdown = detected;
    lootSource = detected.source;
  }

  let members;
  let totalScore;

  if (reportMembers) {
    // Build the member list from the official report. Merge our
    // attack-derived `breakdown` (war_hit / retal / overseas / chain /
    // assist counts) for each member as additional context, but the
    // score itself is the report's authoritative number.
    totalScore = reportTotalScore;
    members = reportMembers
      .map(m => {
        const aid = String(m.id);
        const score = Number(m.score) || 0;
        const sharePct = totalScore > 0 ? (score / totalScore) * 100 : 0;
        const dollarPayout = totalScore > 0
          ? Math.round((score / totalScore) * lootTotal)
          : 0;
        const local = byAttacker[aid] || {};
        return {
          playerId: aid,
          name: String(m.name || local.name || `Player ${aid}`),
          score: Math.round(score * 100) / 100,
          sharePct: Math.round(sharePct * 10) / 10,
          dollarPayout,
          attackCount: Number(m.attacks) || local.attackCount || 0,
          level: Number(m.level) || null,
          breakdown: local.breakdown || {},
        };
      })
      .sort((a, b) => b.score - a.score);
  } else {
    // Fall back to weighted-attack computation (mode-dependent).
    totalScore = Object.values(byAttacker)
      .reduce((s, m) => s + m.computedScore, 0);
    members = Object.values(byAttacker)
      .map(m => {
        const sharePct = totalScore > 0 ? (m.computedScore / totalScore) * 100 : 0;
        const dollarPayout = totalScore > 0
          ? Math.round((m.computedScore / totalScore) * lootTotal)
          : 0;
        return {
          playerId: m.playerId,
          name: m.name,
          score: Math.round(m.computedScore * 100) / 100,
          sharePct: Math.round(sharePct * 10) / 10,
          dollarPayout,
          attackCount: m.attackCount,
          breakdown: m.breakdown,
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  const result = {
    warId,
    factionId: war.factionId,
    enemyFactionId: war.enemyFactionId,
    enemyFactionName: war.enemyFactionName || null,
    warResult: war.warResult || null,
    mode,
    scoreSource, // "report" (Torn-authoritative) or "computed" (our weighting)
    fromTs,
    toTs,
    lootTotal,
    lootBreakdown,
    lootSource,
    lootAutoDetected: options.lootTotal == null && lootTotal > 0,
    totalScore: Math.round(totalScore * 10) / 10,
    members,
    attackCount: scoreSource === "report" ? reportTotalAttacks : attacks.length,
    generatedAt: Date.now(),
  };

  _cache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return { ...result, cached: false };
}

/**
 * Build a combined member×war matrix for the heatmap view. Each member
 * row carries their score per war + total. Wars are returned in
 * chronological order so the UI can render columns left→right oldest→
 * newest. Reuses computePayouts (and its 5-min cache) for each war —
 * subsequent calls within the cache window are cheap.
 *
 * Loot is read from the per-war auto-detect; explicit overrides aren't
 * supported here (keeps the matrix one-shot computable; per-war manual
 * loot is still available via the per-war drilldown UI).
 */
export async function computePayoutsHeatmap(factionId, options = {}) {
  const mode = options.mode === "static" ? "static" : "dynamic";
  const wars = listEligibleWars(factionId);
  const perWar = [];
  // Sequential to avoid hammering Torn's attack endpoint when the
  // cache is cold; cached calls return instantly anyway.
  for (const w of wars) {
    try {
      const r = await computePayouts(w.warId, { mode });
      perWar.push({
        warId: w.warId,
        enemyFactionName: w.enemyFactionName,
        warResult: w.warResult,
        warEndedAt: w.warEndedAt,
        lootTotal: r.lootTotal,
        // Pass-through so the drilldown UI can show 'how was the
        // loot total computed' (Armor Cache x1 = $324M, etc.) —
        // user explicitly asked for this estimate breakdown.
        lootBreakdown: r.lootBreakdown,
        lootSource: r.lootSource,
        totalScore: r.totalScore,
        members: r.members,
      });
    } catch (e) {
      perWar.push({
        warId: w.warId,
        enemyFactionName: w.enemyFactionName,
        warResult: w.warResult,
        warEndedAt: w.warEndedAt,
        error: e.message,
      });
    }
  }

  // Build the member matrix. Key by playerId; track most-recent name
  // (later-war scores overwrite if a player changed their display name).
  const memberMap = {};
  for (const w of perWar) {
    if (!Array.isArray(w.members)) continue;
    for (const m of w.members) {
      if (!memberMap[m.playerId]) {
        memberMap[m.playerId] = {
          playerId: m.playerId,
          name: m.name,
          scoresByWar: {},
          payoutsByWar: {},
          // Per-war attack count + breakdown so the drilldown can show
          // 'Atk / Asst / War / Retal' columns instead of just a score.
          // Without these the UI had no way to surface 'how did I earn
          // this score' — user only saw aggregate dollar payouts.
          attacksByWar: {},
          breakdownByWar: {},
          totalScore: 0,
          totalPayout: 0,
          totalAttacks: 0,
          totalBreakdown: {}, // war_hit / retal / overseas_war / chain_hit / os_chain / assist counts
          warsParticipated: 0,
        };
      }
      memberMap[m.playerId].name = m.name;
      memberMap[m.playerId].scoresByWar[w.warId] = m.score;
      memberMap[m.playerId].payoutsByWar[w.warId] = m.dollarPayout;
      memberMap[m.playerId].attacksByWar[w.warId] = m.attackCount || 0;
      memberMap[m.playerId].breakdownByWar[w.warId] = m.breakdown || {};
      memberMap[m.playerId].totalScore += m.score;
      memberMap[m.playerId].totalPayout += m.dollarPayout;
      memberMap[m.playerId].totalAttacks += m.attackCount || 0;
      memberMap[m.playerId].warsParticipated++;
      // Roll up per-category breakdown across wars
      if (m.breakdown) {
        for (const [cat, n] of Object.entries(m.breakdown)) {
          memberMap[m.playerId].totalBreakdown[cat] =
            (memberMap[m.playerId].totalBreakdown[cat] || 0) + n;
        }
      }
    }
  }
  const members = Object.values(memberMap)
    .map(m => ({
      ...m,
      totalScore: Math.round(m.totalScore * 10) / 10,
    }))
    .sort((a, b) => b.totalScore - a.totalScore);

  return {
    factionId: String(factionId),
    mode,
    wars: perWar.map(w => ({
      warId: w.warId,
      enemyFactionName: w.enemyFactionName,
      warResult: w.warResult,
      warEndedAt: w.warEndedAt,
      lootTotal: w.lootTotal || 0,
      lootBreakdown: w.lootBreakdown || null,
      lootSource: w.lootSource || null,
      totalScore: w.totalScore || 0,
      error: w.error || null,
    })),
    members,
    generatedAt: Date.now(),
  };
}

/** List wars eligible for payouts (ended, has data) for a faction. */
export function listEligibleWars(factionId) {
  const fid = String(factionId);
  const out = [];
  // getAllWars() returns a Map — iterate via .entries() not for...in
  // (the latter only works for plain objects).
  const all = store.getAllWars();
  const entries = (all instanceof Map)
    ? Array.from(all.entries())
    : Object.entries(all || {});
  for (const [wid, w] of entries) {
    if (!w || String(w.factionId) !== fid) continue;
    if (!w.warEnded) continue; // only ended wars eligible
    out.push({
      warId: String(wid),
      enemyFactionName: w.enemyFactionName || `Faction ${w.enemyFactionId}`,
      warResult: w.warResult || "unknown",
      warEndedAt: w.warEndedAt || 0,
    });
  }
  // Most-recent first
  out.sort((a, b) => (b.warEndedAt || 0) - (a.warEndedAt || 0));
  return out;
}
