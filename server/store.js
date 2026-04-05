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
const FACTION_KEYS_FILE = path.join(DATA_DIR, "faction-keys.json");
const PLAYER_KEYS_FILE = path.join(DATA_DIR, "player-keys.json");
const FACTION_SETTINGS_FILE = path.join(DATA_DIR, "faction-settings.json");

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
  // Default roles if not configured
  if (!settings.broadcastRoles || !Array.isArray(settings.broadcastRoles)) {
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
