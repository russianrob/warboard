const fs = require('fs');
const path = '../store.js';
let code = fs.readFileSync(path, 'utf8');

const oldCode1 = `const PLAYER_KEYS_FILE = path.join(DATA_DIR, "player-keys.json");

// ── In-memory maps ──────────────────────────────────────────────────────`;

const newCode1 = `const PLAYER_KEYS_FILE = path.join(DATA_DIR, "player-keys.json");
const FACTION_SETTINGS_FILE = path.join(DATA_DIR, "faction-settings.json");

// ── In-memory maps ──────────────────────────────────────────────────────`;

const oldCode2 = `/**
 * Stored Torn API keys – one per player, used for server-side API calls.
 * @type {Map<string, string>} playerId → apiKey
 */
const playerKeys = new Map();`;

const newCode2 = `/**
 * Stored Torn API keys – one per player, used for server-side API calls.
 * @type {Map<string, string>} playerId → apiKey
 */
const playerKeys = new Map();

/**
 * Faction settings (broadcast roles, etc.)
 * @type {Map<string, object>} factionId → settingsObject
 */
const factionSettings = new Map();`;

const oldCode3 = `/** Load faction API keys from disk (called once at startup). */
export function loadFactionKeys() {`;

const newCode3 = `// ── Faction Settings ────────────────────────────────────────────────────

export function loadFactionSettings() {
  ensureDataDir();
  if (!fs.existsSync(FACTION_SETTINGS_FILE)) return;
  try {
    const raw = fs.readFileSync(FACTION_SETTINGS_FILE, "utf-8");
    const data = JSON.parse(raw);
    for (const [factionId, settings] of Object.entries(data)) {
      factionSettings.set(factionId, settings);
    }
    console.log(\`[store] Loaded \${factionSettings.size} faction settings\`);
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
export function loadFactionKeys() {`;

code = code.replace(oldCode1, newCode1);
code = code.replace(oldCode2, newCode2);
code = code.replace(oldCode3, newCode3);
fs.writeFileSync(path, code);
console.log('Successfully patched store.js');
