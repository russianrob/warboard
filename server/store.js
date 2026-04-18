/**
 * In-memory data store with JSON file persistence.
 *
 * All war state lives in memory for fast access. On every mutation the
 * full state is flushed to disk so the server can resume after a restart.
 */

import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "./data";
const WARS_FILE = path.join(DATA_DIR, "wars.json");
const PLAYER_KEYS_FILE = path.join(DATA_DIR, "player-keys.json");
const FACTION_KEYS_FILE = path.join(DATA_DIR, "faction-keys.json");
const FACTION_SETTINGS_FILE = path.join(DATA_DIR, "faction-settings.json");
const KEY_POOL_FILE = path.join(DATA_DIR, "key-pool.json");
const PLAYER_FACTIONS_FILE = path.join(DATA_DIR, "player-factions.json");
const MEMBER_BARS_FILE = path.join(DATA_DIR, "member-bars.json");

const factionSettings = new Map();

// ── In-memory maps ──────────────────────────────────────────────────────

/** @type {Map<string, import("./types.js").War>} warId → War */
const wars = new Map();

/**
 * Connected players – tracks live socket sessions.
 * @type {Map<string, { socketId: string, factionId: string, warId: string, name: string }>}
 * playerId → session info
 */
const players = new Map();

/**
 * Stored Torn API keys – one per player, used for server-side API calls.
 * @type {Map<string, string>} playerId → apiKey
 */
const apiKeys = new Map();

/**
 * Faction-dedicated API keys – one per faction, used for server-side polling.
 * @type {Map<string, string>} factionId → apiKey
 */
const factionApiKeys = new Map();

/**
 * Per-player opt-in for the server-side key pool. When enabled, the
 * player's stored API key is eligible for rotation across pollers
 * (chain, war-status, attacks-feed, etc.) scoped to their faction.
 * @type {Map<string, { enabled: boolean, factionId: string }>} playerId → opt
 */
const keyPoolingOpt = new Map();

/**
 * Last-known faction id per player, persisted across restarts. Updated
 * every successful /api/auth. Used for push notifications that need to
 * reach offline/disconnected faction members (e.g. retal requests).
 * @type {Map<string, string>} playerId → factionId
 */
const lastKnownFaction = new Map();

/**
 * Per-faction aggregated bars/cooldowns. Each entry is a snapshot of
 * one member's bars reported by their own FactionOps client.
 * @type {Map<string, Map<string, { bars, cooldowns, name, updatedAt }>>}
 * factionId → playerId → report
 */
const factionBars = new Map();

// ── Persistence helpers ─────────────────────────────────────────────────

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/** Load persisted war state from disk (called once at startup). */
export function loadState() {
  ensureDataDir();
  if (!fs.existsSync(WARS_FILE)) return;

  try {
    const raw = fs.readFileSync(WARS_FILE, "utf-8");
    const data = JSON.parse(raw);
    for (const [id, war] of Object.entries(data)) {
      // Backfill fields that may be missing in wars created before they existed
      if (!war.priorities) war.priorities = {};
      if (!war.calls) war.calls = {};
      if (!war.enemyStatuses) war.enemyStatuses = {};
      if (!war.chainData) war.chainData = { current: 0, max: 0, timeout: 0, cooldown: 0 };
      if (!war.warTarget) war.warTarget = null;
      if (!war.enemyActivityLog) war.enemyActivityLog = [];
      if (!war.strategy) war.strategy = null;
      if (!war.enemyActivityByHour) war.enemyActivityByHour = null;
      wars.set(id, war);
    }
    console.log(`[store] Loaded ${wars.size} war(s) from disk`);
  } catch (err) {
    console.error("[store] Failed to load persisted state:", err.message);
  }
}

/** Persist current war state to disk. Called after every mutation. */
export function saveState() {
  ensureDataDir();
  try {
    const obj = Object.fromEntries(wars);
    fs.writeFileSync(WARS_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error("[store] Failed to persist state:", err.message);
  }
}

// ── War CRUD ────────────────────────────────────────────────────────────

export function getWar(warId) {
  return wars.get(warId) ?? null;
}

export function getOrCreateWar(warId, factionId, enemyFactionId = null) {
  if (wars.has(warId)) {
    const war = wars.get(warId);
    if (enemyFactionId && war.enemyFactionId !== enemyFactionId) {
      console.log(`[store] New enemy detected (${enemyFactionId}). Resetting stale war data.`);
      
      // Attempt to clear previous enemy's heatmap to prevent ghost data
      if (war.enemyFactionId) {
          import('./activity-heatmap.js').then(hm => hm.resetHeatmap(war.enemyFactionId)).catch(() => {});
      }

      war.enemyFactionId = enemyFactionId;
      war.calls = {};
      war.priorities = {};
      war.enemyStatuses = {};
      war.warTarget = null;
      war.enemyActivityLog = [];
      war.strategy = null;
      war.enemyActivityByHour = null;
      war.chainData = { current: 0, max: 0, timeout: 0, cooldown: 0 };
      delete war.status;
      delete war.ourScore;
      delete war.enemyScore;
      delete war.winner;
      delete war.warResult;
      delete war.warEnded;
      delete war.warEndedAt;
      delete war.warEta;
      saveState();
    }
    return war;
  }

  const war = {
    warId,
    factionId,
    enemyFactionId,
    calls: {},
    priorities: {},
    enemyStatuses: {},
    chainData: { current: 0, max: 0, timeout: 0, cooldown: 0 },
    warTarget: null,
    enemyActivityLog: [],
    strategy: null,
    enemyActivityByHour: null,
  };
  wars.set(warId, war);
  saveState();
  return war;
}

export function getAllWars() {
  return wars;
}

// ── Player tracking ─────────────────────────────────────────────────────

export function setPlayer(playerId, info) {
  players.set(playerId, info);
}

export function getPlayer(playerId) {
  return players.get(playerId) ?? null;
}

export function removePlayerBySocket(socketId) {
  for (const [id, p] of players) {
    if (p.socketId === socketId) {
      players.delete(id);
      return { playerId: id, ...p };
    }
  }
  return null;
}

export function getOnlinePlayersForWar(warId) {
  const result = [];
  for (const [id, p] of players) {
    if (p.warId === warId) result.push({ id, name: p.name });
  }
  return result;
}

/** Set which target a player is currently viewing (attack page). */
export function setViewingTarget(playerId, targetId) {
  const p = players.get(playerId);
  if (p) {
    p.viewingTarget = targetId || null;
  }
}

/** Get a map of targetId → [{ id, name }] for all players viewing targets in a war. */
export function getViewersForWar(warId) {
  const viewers = {};
  for (const [id, p] of players) {
    if (p.warId === warId && p.viewingTarget) {
      if (!viewers[p.viewingTarget]) viewers[p.viewingTarget] = [];
      viewers[p.viewingTarget].push({ id, name: p.name });
    }
  }
  return viewers;
}

// ── API key storage ─────────────────────────────────────────────────────

export function storeApiKey(playerId, apiKey) {
  apiKeys.set(playerId, apiKey);
  savePlayerKeys();
}

/** Get any available API key for a faction (picks the first one found). */
export function getApiKeyForFaction(factionId) {
  for (const [playerId, key] of apiKeys) {
    const player = players.get(playerId);
    if (player && player.factionId === factionId) return key;
  }
  // Fallback: return any stored key for a player whose factionId we recorded
  // even if they're offline – the key is still valid.
  return apiKeys.values().next().value ?? null;
}

export function getApiKeyForPlayer(playerId) {
  return apiKeys.get(playerId) ?? null;
}

export function removeApiKey(playerId) {
  apiKeys.delete(playerId);
  savePlayerKeys();
}

/** Returns all stored player API keys as [playerId, apiKey] pairs. */
export function getAllApiKeys() {
  return [...apiKeys.entries()];
}

/** Load player API keys from disk (called once at startup). */
export function loadPlayerKeys() {
  ensureDataDir();
  if (!fs.existsSync(PLAYER_KEYS_FILE)) return;

  try {
    const raw = fs.readFileSync(PLAYER_KEYS_FILE, "utf-8");
    const data = JSON.parse(raw);
    for (const [playerId, key] of Object.entries(data)) {
      apiKeys.set(playerId, key);
    }
    console.log(`[store] Loaded ${apiKeys.size} player API key(s) from disk`);
  } catch (err) {
    console.error("[store] Failed to load player keys:", err.message);
  }
}

/** Persist player API keys to disk. */
function savePlayerKeys() {
  ensureDataDir();
  try {
    const obj = Object.fromEntries(apiKeys);
    fs.writeFileSync(PLAYER_KEYS_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error("[store] Failed to persist player keys:", err.message);
  }
}

// ── Faction API key storage ──────────────────────────────────────────────

// ── Faction Settings ────────────────────────────────────────────────────

export function loadFactionSettings() {
  ensureDataDir();
  if (!fs.existsSync(FACTION_SETTINGS_FILE)) return;
  try {
    const raw = fs.readFileSync(FACTION_SETTINGS_FILE, "utf-8");
    const data = JSON.parse(raw);
    for (const [factionId, settings] of Object.entries(data)) {
      factionSettings.set(factionId, settings);
    }
    console.log(`[store] Loaded ${factionSettings.size} faction settings`);
  } catch (err) {
    console.error("[store] Failed to load faction settings:", err.message);
  }
}

function saveFactionSettings() {
  ensureDataDir();
  try {
    const obj = Object.fromEntries(factionSettings);
    fs.writeFileSync(FACTION_SETTINGS_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error("[store] Failed to save faction settings:", err.message);
  }
}

export function getFactionSettings(factionId) {
  return factionSettings.get(String(factionId)) || {};
}

export function updateFactionSettings(factionId, newSettings) {
  const current = getFactionSettings(factionId);
  factionSettings.set(String(factionId), { ...current, ...newSettings });
  saveFactionSettings();
}

export function getAllowedBroadcastRoles(factionId) {
  const settings = getFactionSettings(factionId);
  // Default roles if not configured or empty
  if (!settings.broadcastRoles || !Array.isArray(settings.broadcastRoles) || settings.broadcastRoles.length === 0) {
    return ["leader", "co-leader", "war leader", "banker"];
  }
  return settings.broadcastRoles;
}

/** Load faction API keys from disk (called once at startup). */
export function loadFactionKeys() {
  ensureDataDir();
  if (!fs.existsSync(FACTION_KEYS_FILE)) return;

  try {
    const raw = fs.readFileSync(FACTION_KEYS_FILE, "utf-8");
    const data = JSON.parse(raw);
    for (const [factionId, key] of Object.entries(data)) {
      factionApiKeys.set(factionId, key);
    }
    console.log(`[store] Loaded ${factionApiKeys.size} faction API key(s) from disk`);
  } catch (err) {
    console.error("[store] Failed to load faction keys:", err.message);
  }
}

/** Persist faction API keys to disk. */
export function saveFactionKeys() {
  ensureDataDir();
  try {
    const obj = Object.fromEntries(factionApiKeys);
    fs.writeFileSync(FACTION_KEYS_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error("[store] Failed to persist faction keys:", err.message);
  }
}

export function getAllFactionKeys() {
  return Array.from(factionApiKeys.entries());
}

export function storeFactionApiKey(factionId, apiKey) {
  factionApiKeys.set(factionId, apiKey);
  saveFactionKeys();
}

export function getFactionApiKey(factionId) {
  return factionApiKeys.get(factionId) ?? null;
}

export function removeFactionApiKey(factionId) {
  factionApiKeys.delete(factionId);
  saveFactionKeys();
}

// ── Key pooling opt-in ──────────────────────────────────────────────────

export function loadKeyPoolingOpt() {
  ensureDataDir();
  if (!fs.existsSync(KEY_POOL_FILE)) return;
  try {
    const raw = fs.readFileSync(KEY_POOL_FILE, "utf-8");
    const data = JSON.parse(raw);
    for (const [playerId, opt] of Object.entries(data)) {
      keyPoolingOpt.set(String(playerId), opt);
    }
    console.log(`[store] Loaded ${keyPoolingOpt.size} key-pool opt-in(s)`);
  } catch (err) {
    console.error("[store] Failed to load key-pool opts:", err.message);
  }
}

function saveKeyPoolingOpt() {
  ensureDataDir();
  try {
    const obj = Object.fromEntries(keyPoolingOpt);
    fs.writeFileSync(KEY_POOL_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error("[store] Failed to persist key-pool opts:", err.message);
  }
}

/**
 * Record a player's opt-in/out decision for the key pool.
 * Stores the factionId at opt-in time so if they later switch factions
 * their key isn't used for their old faction's pool.
 */
export function setKeyPoolingOpt(playerId, enabled, factionId) {
  keyPoolingOpt.set(String(playerId), {
    enabled: !!enabled,
    factionId: String(factionId || ""),
  });
  saveKeyPoolingOpt();
}

/**
 * Return the player's explicit pool opt. If they've never been recorded,
 * default to enabled: true — the pool is opt-OUT not opt-in. Users who
 * don't want to contribute can toggle it off in settings at any time.
 */
export function getKeyPoolingOpt(playerId) {
  return keyPoolingOpt.get(String(playerId)) || { enabled: true, factionId: "", defaulted: true };
}

/**
 * Create a default pool opt-in for a player if they don't already have
 * an explicit record. Called from /api/auth. Existing records (including
 * explicit opt-outs) are preserved.
 */
export function ensureDefaultPoolOpt(playerId, factionId) {
  const pid = String(playerId);
  if (keyPoolingOpt.has(pid)) return false; // already has an explicit record
  keyPoolingOpt.set(pid, {
    enabled: true,
    factionId: String(factionId || ""),
  });
  saveKeyPoolingOpt();
  return true;
}

/**
 * Return all keys opted into the faction's pool, stable-sorted by
 * playerId so purpose-hash rotation is deterministic across restarts.
 */
export function getPooledKeysForFaction(factionId) {
  const fid = String(factionId);
  const out = [];
  for (const [playerId, opt] of keyPoolingOpt) {
    if (!opt.enabled) continue;
    if (String(opt.factionId) !== fid) continue;
    const key = apiKeys.get(playerId);
    if (key) out.push({ playerId, key });
  }
  out.sort((a, b) => a.playerId.localeCompare(b.playerId));
  return out;
}

/** Tiny deterministic string hash for rotating keys by purpose. */
function stringHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

/**
 * Primary helper for server-side pollers to pick a Torn API key. Rotates
 * across opted-in pool keys by hashing the `purpose` string, so each
 * poller (chain, war-status, attacks-feed, …) consistently lands on a
 * different key as long as enough are pooled. Falls back to the faction-
 * dedicated key, then to any stored key, preserving prior behavior for
 * factions that haven't collected opt-ins yet.
 */
// ── Player ↔ faction persistence ────────────────────────────────────────

export function loadPlayerFactions() {
  ensureDataDir();
  if (!fs.existsSync(PLAYER_FACTIONS_FILE)) return;
  try {
    const raw = fs.readFileSync(PLAYER_FACTIONS_FILE, "utf-8");
    const data = JSON.parse(raw);
    for (const [playerId, factionId] of Object.entries(data)) {
      lastKnownFaction.set(String(playerId), String(factionId));
    }
    console.log(`[store] Loaded ${lastKnownFaction.size} player-faction mapping(s)`);
  } catch (err) {
    console.error("[store] Failed to load player-factions:", err.message);
  }
}

function savePlayerFactions() {
  ensureDataDir();
  try {
    const obj = Object.fromEntries(lastKnownFaction);
    fs.writeFileSync(PLAYER_FACTIONS_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error("[store] Failed to persist player-factions:", err.message);
  }
}

export function recordPlayerFaction(playerId, factionId) {
  if (!playerId || !factionId) return;
  const pid = String(playerId);
  const fid = String(factionId);
  if (lastKnownFaction.get(pid) === fid) return;
  lastKnownFaction.set(pid, fid);
  savePlayerFactions();
}

/**
 * Return every playerId we've ever seen authenticated as a member of the
 * given faction. Used for broadcast-to-faction push (e.g. retal).
 */
export function getPlayerIdsForFaction(factionId) {
  const fid = String(factionId);
  const out = [];
  for (const [pid, f] of lastKnownFaction) {
    if (f === fid) out.push(pid);
  }
  return out;
}

/**
 * Dynamic poll interval that scales with pool size. More pooled keys →
 * tighter polling (fresher data). Single-key pool → conservative
 * intervals that stay under Torn's 100/min per-key limit.
 *
 * Floor values are near Torn's endpoint cache TTLs — polling faster
 * than that just returns duplicates and burns budget with no benefit.
 */
export function getPollInterval(factionId, purpose) {
  const pool = getPooledKeysForFaction(factionId);
  const n = Math.max(1, pool.length);
  const config = {
    chain:           { min: 10_000, max: 20_000 }, // Torn cache ~15s
    "war-status":    { min: 15_000, max: 30_000 }, // Torn cache ~30s
    "attacks-feed":  { min: 15_000, max: 60_000 }, // our faction's attacks feed
    "enemy-attacks": { min: 10_000, max: 30_000 }, // (unused — Torn blocks other factions' attacks)
    // Per-enemy profile round-robin. Concurrency scales with pool size
    // up to the cap in war-status-monitor.js (currently 25), so every
    // tick fires min(n, ids.length, 25) parallel requests. Per-key rate
    // is 60000/tick_ms per minute; 700ms floor keeps that under Torn's
    // 100/min per-key limit (≈85/min/key, 15% buffer).
    // pool=1:  1500ms tick → 37.5s full sweep (25 enemies serial).
    // pool=7:  700ms floor  → 2.8s full sweep (ceil(25/7)=4 ticks).
    // pool=13: 700ms floor  → 1.4s full sweep (ceil(25/13)=2 ticks).
    // pool=25: 700ms floor  → 0.7s full sweep (1 tick at cap).
    "enemy-profile": { min: 700, max: 1500 },
  };
  const c = config[purpose] || config["war-status"];
  // Divide the conservative max by pool size, floor at min.
  return Math.max(c.min, Math.round(c.max / n));
}

// ── Faction member bars aggregation ─────────────────────────────────────

/**
 * Record a member's self-reported bars snapshot. Persisted to disk
 * (debounced) so the Faction Cooldowns panel keeps its last-known state
 * across server restarts. Old entries age out after 4 hours of no refresh.
 */
export function recordMemberBars(factionId, playerId, playerName, data) {
  const fid = String(factionId);
  const pid = String(playerId);
  if (!factionBars.has(fid)) factionBars.set(fid, new Map());
  factionBars.get(fid).set(pid, {
    bars: data.bars || null,
    cooldowns: data.cooldowns || null,
    name: playerName || pid,
    updatedAt: Date.now(),
  });
  scheduleMemberBarsSave();
}

/**
 * Return all fresh bars snapshots for a faction. Snapshots older than
 * `staleMs` are filtered out so the UI never shows zombie data.
 */
export function getFactionBars(factionId, staleMs = 4 * 60 * 60 * 1000) {
  const fid = String(factionId);
  const m = factionBars.get(fid);
  if (!m) return {};
  const cutoff = Date.now() - staleMs;
  const out = {};
  for (const [pid, entry] of m) {
    if (entry.updatedAt >= cutoff) {
      out[pid] = entry;
    }
  }
  return out;
}

// Debounced persistence for factionBars. Every member poll hits this ~every
// 60s × membersCount, which could be dozens of writes/minute. Coalesce into
// at most one write per 30s.
let _memberBarsSaveTimer = null;
function scheduleMemberBarsSave() {
  if (_memberBarsSaveTimer) return;
  _memberBarsSaveTimer = setTimeout(() => {
    _memberBarsSaveTimer = null;
    saveMemberBars();
  }, 30_000);
}

/** Persist factionBars to disk. Nested-Map → plain object. */
export function saveMemberBars() {
  ensureDataDir();
  try {
    const obj = {};
    const cutoff = Date.now() - 4 * 60 * 60 * 1000;
    for (const [fid, members] of factionBars) {
      const fresh = {};
      for (const [pid, entry] of members) {
        if (entry.updatedAt >= cutoff) fresh[pid] = entry;
      }
      if (Object.keys(fresh).length) obj[fid] = fresh;
    }
    fs.writeFileSync(MEMBER_BARS_FILE, JSON.stringify(obj));
  } catch (err) {
    console.error("[store] Failed to save member-bars:", err.message);
  }
}

/** Load persisted factionBars from disk (called once at startup). */
export function loadMemberBars() {
  ensureDataDir();
  if (!fs.existsSync(MEMBER_BARS_FILE)) return;
  try {
    const raw = fs.readFileSync(MEMBER_BARS_FILE, "utf-8");
    const data = JSON.parse(raw);
    let total = 0;
    const cutoff = Date.now() - 4 * 60 * 60 * 1000;
    for (const [fid, members] of Object.entries(data)) {
      const m = new Map();
      for (const [pid, entry] of Object.entries(members)) {
        if (entry && entry.updatedAt >= cutoff) {
          m.set(pid, entry);
          total++;
        }
      }
      if (m.size) factionBars.set(fid, m);
    }
    console.log(`[store] Loaded ${total} member-bars snapshot(s) from disk`);
  } catch (err) {
    console.error("[store] Failed to load member-bars:", err.message);
  }
}

export function getPollingKey(factionId, purpose, index) {
  const pool = getPooledKeysForFaction(factionId);
  if (pool.length > 0) {
    // If caller passes a numeric index, rotate request-by-request
    // across the pool (used by high-frequency pollers like per-enemy
    // profile round-robin). Otherwise fall back to the stable,
    // purpose-hashed choice so each low-frequency poller lands on the
    // same key predictably.
    const idx = typeof index === "number"
      ? Math.abs(index) % pool.length
      : stringHash(String(purpose || "default")) % pool.length;
    return pool[idx].key;
  }
  return (
    factionApiKeys.get(String(factionId)) ||
    getApiKeyForFaction(factionId) ||
    null
  );
}
