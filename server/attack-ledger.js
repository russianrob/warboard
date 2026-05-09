// Per-war attack telemetry ledger. Members POST their own
// /user/?selections=attacks history (their personal key) every ~60s
// from any client (factionops, iOS, Android). We dedupe by Torn fight
// ID and persist per-war so the post-war report can build richer
// analytics than the faction attacks-feed alone allows — mug $, true
// respect, defends-against, fight-modifier breakdowns, KO/hosp outcomes.
//
// One JSON file per war: data/attack-ledger/war_<warId>.json
// Shape: { warId, factionId, attacks: { <fightId>: AttackRecord } }
//
// Loaded lazily on first read/write per war. Writes debounced 5s so a
// burst of POSTs from many members doesn't thrash disk.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data", "attack-ledger");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/** @type {Map<string, { warId: string, factionId: string, attacks: Record<string, any>, dirty: boolean, _saveTimer: NodeJS.Timeout|null }>} */
const ledgers = new Map();

function fileFor(warId) {
  return path.join(DATA_DIR, `war_${warId}.json`);
}

function loadLedger(warId, factionId) {
  const wid = String(warId);
  if (ledgers.has(wid)) return ledgers.get(wid);
  let initial = { warId: wid, factionId: String(factionId || ""), attacks: {} };
  try {
    const raw = fs.readFileSync(fileFor(wid), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.attacks) {
      initial = { warId: wid, factionId: String(parsed.factionId || factionId || ""), attacks: parsed.attacks };
    }
  } catch { /* fresh ledger */ }
  const ledger = { ...initial, dirty: false, _saveTimer: null };
  ledgers.set(wid, ledger);
  return ledger;
}

function scheduleSave(ledger) {
  if (ledger._saveTimer) return;
  ledger._saveTimer = setTimeout(() => {
    ledger._saveTimer = null;
    try {
      const out = { warId: ledger.warId, factionId: ledger.factionId, attacks: ledger.attacks };
      fs.writeFileSync(fileFor(ledger.warId), JSON.stringify(out));
      ledger.dirty = false;
    } catch (e) {
      console.error(`[attack-ledger] save failed for war ${ledger.warId}:`, e?.message);
    }
  }, 5_000);
}

/**
 * Normalize a single Torn /user/?selections=attacks v1 entry into our
 * stored shape. Strips fields we don't need; keeps the bits the post-war
 * report consumes. Returns null if the record is malformed.
 */
function normalize(fightId, raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(fightId || raw.code || raw.id || "");
  if (!id) return null;
  return {
    fightId: id,
    code: raw.code || null,
    started: Number(raw.timestamp_started) || 0,
    ended: Number(raw.timestamp_ended) || 0,
    attackerId: raw.attacker_id != null ? String(raw.attacker_id) : null,
    attackerName: raw.attacker_name || null,
    attackerFactionId: raw.attacker_faction != null ? String(raw.attacker_faction) : null,
    attackerFactionName: raw.attacker_factionname || null,
    defenderId: raw.defender_id != null ? String(raw.defender_id) : null,
    defenderName: raw.defender_name || null,
    defenderFactionId: raw.defender_faction != null ? String(raw.defender_faction) : null,
    defenderFactionName: raw.defender_factionname || null,
    result: raw.result || null,
    stealthed: raw.stealthed === 1 || raw.stealthed === true,
    respectGain: typeof raw.respect_gain === "number"
      ? raw.respect_gain
      : (typeof raw.respect === "number" ? raw.respect : 0),
    chain: Number(raw.chain) || 0,
    moneyMugged: Number(raw.money_mugged) || 0,
    modifiers: raw.modifiers && typeof raw.modifiers === "object"
      ? {
          fairFight:  Number(raw.modifiers.fair_fight)    || 0,
          war:        Number(raw.modifiers.war)           || 0,
          retaliation: Number(raw.modifiers.retaliation)  || 0,
          group:      Number(raw.modifiers.group_attack)  || 0,
          overseas:   Number(raw.modifiers.overseas)      || 0,
          chainBonus: Number(raw.modifiers.chain_bonus)   || 0,
          warlord:    Number(raw.modifiers.warlord_bonus) || 0,
        }
      : null,
  };
}

/**
 * Ingest a batch of fights from a member's POST. `war` is the active war
 * the fight is being attributed to (already filtered by timestamp window
 * + faction match by the caller). Returns the count of newly-added fights
 * (deduped by fightId).
 */
export function ingestForWar(warId, factionId, rawAttacks) {
  const ledger = loadLedger(warId, factionId);
  let added = 0;
  for (const [k, v] of Object.entries(rawAttacks || {})) {
    const norm = normalize(k, v);
    if (!norm) continue;
    if (ledger.attacks[norm.fightId]) continue; // dedupe
    ledger.attacks[norm.fightId] = norm;
    added++;
  }
  if (added > 0) {
    ledger.dirty = true;
    scheduleSave(ledger);
  }
  return added;
}

/** All fights recorded for a given war, as an array sorted by ended ts. */
export function getAttacksForWar(warId, factionId) {
  const ledger = loadLedger(warId, factionId);
  return Object.values(ledger.attacks).sort((a, b) => a.ended - b.ended);
}

/** Drop a war's ledger from memory + disk (e.g., post-war cleanup). */
export function clearWar(warId) {
  const wid = String(warId);
  ledgers.delete(wid);
  try { fs.unlinkSync(fileFor(wid)); } catch { /* fine if missing */ }
}

/** Flush all dirty ledgers immediately — call from process shutdown hook. */
export function flushAll() {
  for (const ledger of ledgers.values()) {
    if (ledger._saveTimer) { clearTimeout(ledger._saveTimer); ledger._saveTimer = null; }
    if (!ledger.dirty) continue;
    try {
      const out = { warId: ledger.warId, factionId: ledger.factionId, attacks: ledger.attacks };
      fs.writeFileSync(fileFor(ledger.warId), JSON.stringify(out));
      ledger.dirty = false;
    } catch (e) {
      console.error(`[attack-ledger] flush failed for war ${ledger.warId}:`, e?.message);
    }
  }
}
