/**
 * Web Push notification management for FactionOps.
 *
 * Stores push subscriptions per player and sends notifications
 * for war events (calls, chain alerts, hospital pops, etc.).
 * Per-player notification preferences control which alerts fire.
 *
 * @author RussianRob
 */

import webPush from "web-push";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── VAPID Configuration ──────────────────────────────────────────────────

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@tornwar.com";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log("[push] Web Push configured with VAPID keys");
} else {
  console.warn("[push] VAPID keys not set — push notifications disabled");
}

// ── Notification Types ──────────────────────────────────────────────────

/**
 * All available notification types with default enabled state.
 * This is the canonical list — the settings UI reads from this.
 */
export const NOTIFICATION_TYPES = {
  target_called:   { label: "Target Calls",         description: "When a teammate calls a target",                    default: true  },
  chain_alert:     { label: "Chain Break Alerts",    description: "When chain timer drops below 30s",                  default: true  },
  hospital_pop:    { label: "Hospital Pops",         description: "When an enemy target leaves the hospital",          default: true  },
  bonus_imminent:  { label: "Bonus Milestones",      description: "When a bonus hit is 1–2 attacks away",              default: true  },
  enemy_surge:     { label: "Enemy Online Surge",    description: "When multiple enemies come online at once",         default: true  },
  call_stolen:     { label: "Call Contested",        description: "When someone else views a target you called",       default: true  },
  war_target:      { label: "War Target Reached",    description: "When faction hits the custom war target",           default: true  },
};

// ── Subscription Storage ────────────────────────────────────────────────

const SUBS_FILE = join(__dirname, "data", "push-subscriptions.json");
const PREFS_FILE = join(__dirname, "data", "push-preferences.json");

/**
 * Map of playerId → PushSubscription[].
 * A player can have multiple devices subscribed.
 */
let subscriptions = {};

/**
 * Map of playerId → { target_called: bool, chain_alert: bool, ... }.
 * Missing keys inherit from NOTIFICATION_TYPES defaults.
 */
let preferences = {};

/** Load subscriptions from disk. */
export function loadSubscriptions() {
  try {
    if (existsSync(SUBS_FILE)) {
      subscriptions = JSON.parse(readFileSync(SUBS_FILE, "utf-8"));
      const total = Object.values(subscriptions).reduce((s, a) => s + a.length, 0);
      console.log(`[push] Loaded ${total} push subscriptions for ${Object.keys(subscriptions).length} players`);
    }
  } catch (err) {
    console.error("[push] Failed to load subscriptions:", err.message);
    subscriptions = {};
  }

  try {
    if (existsSync(PREFS_FILE)) {
      preferences = JSON.parse(readFileSync(PREFS_FILE, "utf-8"));
      console.log(`[push] Loaded preferences for ${Object.keys(preferences).length} players`);
    }
  } catch (err) {
    console.error("[push] Failed to load preferences:", err.message);
    preferences = {};
  }
}

/** Persist subscriptions to disk. */
function saveSubscriptions() {
  try {
    writeFileSync(SUBS_FILE, JSON.stringify(subscriptions, null, 2));
  } catch (err) {
    console.error("[push] Failed to save subscriptions:", err.message);
  }
}

/** Persist preferences to disk. */
function savePreferences() {
  try {
    writeFileSync(PREFS_FILE, JSON.stringify(preferences, null, 2));
  } catch (err) {
    console.error("[push] Failed to save preferences:", err.message);
  }
}

// ── Preferences API ─────────────────────────────────────────────────────

/**
 * Get a player's notification preferences (merged with defaults).
 * @param {string} playerId
 * @returns {Object} { target_called: bool, chain_alert: bool, ... }
 */
export function getPreferences(playerId) {
  const saved = preferences[playerId] || {};
  const result = {};
  for (const [type, config] of Object.entries(NOTIFICATION_TYPES)) {
    result[type] = saved[type] !== undefined ? saved[type] : config.default;
  }
  return result;
}

/**
 * Update a player's notification preferences.
 * @param {string} playerId
 * @param {Object} prefs - Partial map of type → bool
 */
export function setPreferences(playerId, prefs) {
  if (!preferences[playerId]) preferences[playerId] = {};
  for (const [type, enabled] of Object.entries(prefs)) {
    if (type in NOTIFICATION_TYPES && typeof enabled === "boolean") {
      preferences[playerId][type] = enabled;
    }
  }
  savePreferences();
}

/**
 * Check if a specific notification type is enabled for a player.
 * @param {string} playerId
 * @param {string} type - One of NOTIFICATION_TYPES keys
 * @returns {boolean}
 */
function isTypeEnabled(playerId, type) {
  const saved = preferences[playerId];
  if (saved && saved[type] !== undefined) return saved[type];
  return NOTIFICATION_TYPES[type]?.default ?? true;
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Subscribe a player's device for push notifications.
 * @param {string} playerId
 * @param {object} subscription - PushSubscription from the browser
 */
export function subscribe(playerId, subscription) {
  if (!subscriptions[playerId]) {
    subscriptions[playerId] = [];
  }

  // Avoid duplicates (same endpoint)
  const exists = subscriptions[playerId].some((s) => s.endpoint === subscription.endpoint);
  if (!exists) {
    subscriptions[playerId].push(subscription);
    saveSubscriptions();
    console.log(`[push] Player ${playerId} subscribed (${subscriptions[playerId].length} devices)`);
  }
  return true;
}

/**
 * Unsubscribe a specific endpoint for a player.
 * @param {string} playerId
 * @param {string} endpoint - The endpoint URL to remove
 */
export function unsubscribe(playerId, endpoint) {
  if (!subscriptions[playerId]) return;
  subscriptions[playerId] = subscriptions[playerId].filter((s) => s.endpoint !== endpoint);
  if (subscriptions[playerId].length === 0) {
    delete subscriptions[playerId];
  }
  saveSubscriptions();
  console.log(`[push] Player ${playerId} unsubscribed endpoint`);
}

/**
 * Unsubscribe all endpoints for a player.
 * @param {string} playerId
 */
export function unsubscribeAll(playerId) {
  delete subscriptions[playerId];
  saveSubscriptions();
}

/**
 * Get the VAPID public key for client-side subscription.
 */
export function getPublicKey() {
  return VAPID_PUBLIC_KEY || null;
}

/**
 * Check if a player has any push subscriptions.
 * @param {string} playerId
 */
export function isSubscribed(playerId) {
  return !!(subscriptions[playerId] && subscriptions[playerId].length > 0);
}

/**
 * Get all player IDs that have active push subscriptions.
 * @returns {string[]}
 */
export function getSubscribedPlayerIds() {
  return Object.keys(subscriptions).filter((id) => subscriptions[id] && subscriptions[id].length > 0);
}

// ── Send Notifications ──────────────────────────────────────────────────

/**
 * Send a push notification to a specific player (all their devices).
 * Respects the player's notification type preference.
 * @param {string} playerId
 * @param {object} payload - { title, body, icon?, tag?, url?, data? }
 * @param {string} [notifType] - Notification type key for preference check
 * @param {object} [pushOptions] - web-push options (e.g. { urgency: 'high' })
 */
export async function sendToPlayer(playerId, payload, notifType, pushOptions) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;

  // Check preference if a type is specified
  if (notifType && !isTypeEnabled(playerId, notifType)) return;

  const subs = subscriptions[playerId];
  if (!subs || subs.length === 0) return;

  const message = JSON.stringify(payload);
  const stale = [];

  for (const sub of subs) {
    try {
      await webPush.sendNotification(sub, message, pushOptions);
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Subscription expired or invalid — mark for removal
        stale.push(sub.endpoint);
      } else {
        console.error(`[push] Failed to send to ${playerId}:`, err.message);
      }
    }
  }

  // Clean up stale subscriptions
  if (stale.length > 0) {
    subscriptions[playerId] = subs.filter((s) => !stale.includes(s.endpoint));
    if (subscriptions[playerId].length === 0) delete subscriptions[playerId];
    saveSubscriptions();
  }
}

/**
 * Send a push notification to multiple players (preference-aware).
 * @param {string[]} playerIds
 * @param {object} payload - { title, body, icon?, tag?, url?, data? }
 * @param {string} [notifType] - Notification type key for preference check
 * @param {object} [pushOptions] - web-push options (e.g. { urgency: 'high' })
 */
export async function sendToPlayers(playerIds, payload, notifType, pushOptions) {
  await Promise.allSettled(playerIds.map((id) => sendToPlayer(id, payload, notifType, pushOptions)));
}

/**
 * Send a push notification to all subscribed players in a war (preference-aware).
 * @param {Function} getPlayersForWar - Returns array of { id, name }
 * @param {string} warId
 * @param {object} payload
 * @param {string} [notifType] - Notification type key
 * @param {string} [excludePlayerId] - don't notify this player (the actor)
 * @param {object} [pushOptions] - web-push options (e.g. { urgency: 'high' })
 */
export async function sendToWar(getPlayersForWar, warId, payload, notifType, excludePlayerId, pushOptions) {
  const warPlayers = getPlayersForWar(warId);
  if (!warPlayers || warPlayers.length === 0) return;

  const targets = warPlayers
    .map((p) => p.playerId || p.id)
    .filter((id) => id !== excludePlayerId && isSubscribed(id));

  if (targets.length > 0) {
    await sendToPlayers(targets, payload, notifType, pushOptions);
  }
}

// ── War Event Helpers ───────────────────────────────────────────────────

/**
 * Notify war room that a target was called.
 */
export async function notifyTargetCalled(warPlayers, warId, callerName, targetName, excludePlayerId) {
  await sendToWar(
    () => warPlayers,
    warId,
    {
      title: "🎯 Target Called",
      body: `${callerName} called ${targetName}`,
      tag: `call-${targetName}`,
      icon: "/icon-192.png",
      data: { type: "call", warId },
    },
    "target_called",
    excludePlayerId,
  );
}

/**
 * Notify war room about chain danger.
 */
export async function notifyChainAlert(warPlayers, warId, current, timeout, timeLeft) {
  const playerIds = warPlayers.map((p) => p.playerId || p.id);
  await sendToPlayers(
    playerIds.filter((id) => isSubscribed(id)),
    {
      title: "🚨 CHAIN BREAKING!",
      body: `Chain ${current} — ${timeLeft}s remaining! Attack now!`,
      tag: "chain-alert",
      icon: "/icon-192.png",
      data: { type: "chain-alert", warId },
    },
    "chain_alert",
    { urgency: "high", TTL: 30 },
  );
}

/**
 * Notify a specific player that a target left hospital.
 */
export async function notifyHospitalPop(playerId, targetName, targetId) {
  await sendToPlayer(playerId, {
    title: "🏥 Target Out of Hospital",
    body: `${targetName} just left the hospital — attack now!`,
    tag: `hosp-${targetId}`,
    icon: "/icon-192.png",
    data: { type: "hospital-pop", targetId },
  }, "hospital_pop");
}

/**
 * Notify war room about a bonus hit milestone approaching.
 */
export async function notifyBonusImminent(warPlayers, warId, current, nextBonus) {
  const playerIds = warPlayers.map((p) => p.playerId || p.id);
  await sendToPlayers(
    playerIds.filter((id) => isSubscribed(id)),
    {
      title: "💥 Bonus Hit Imminent",
      body: `Chain at ${current}/${nextBonus} — bonus hit incoming!`,
      tag: "bonus-alert",
      icon: "/icon-192.png",
      data: { type: "bonus", warId },
    },
    "bonus_imminent",
  );
}

/**
 * Notify war room about an enemy online surge.
 */
export async function notifyEnemySurge(warPlayers, warId, newOnlineCount, totalEnemies) {
  const playerIds = warPlayers.map((p) => p.playerId || p.id);
  await sendToPlayers(
    playerIds.filter((id) => isSubscribed(id)),
    {
      title: "🚨 Enemy Online Surge",
      body: `${newOnlineCount} enemies just came online (${totalEnemies} total)`,
      tag: "enemy-surge",
      icon: "/icon-192.png",
      data: { type: "enemy-surge", warId },
    },
    "enemy_surge",
  );
}

/**
 * Notify a player that someone else is viewing their called target.
 */
export async function notifyCallStolen(playerId, viewerName, targetName, targetId) {
  await sendToPlayer(playerId, {
    title: "👁️ Call Contested",
    body: `${viewerName} is viewing ${targetName} — you have this target called`,
    tag: `contested-${targetId}`,
    icon: "/icon-192.png",
    data: { type: "call-contested", targetId },
  }, "call_stolen");
}

/**
 * Notify all war members that the custom war target has been reached.
 */
export async function notifyWarTargetReached(warPlayers, warId, targetValue, currentLead) {
  const playerIds = warPlayers.map((p) => p.playerId || p.id);
  await sendToPlayers(
    playerIds.filter((id) => isSubscribed(id)),
    {
      title: "🎯 War Target Reached!",
      body: `Faction hit ${currentLead.toLocaleString()} / ${targetValue.toLocaleString()} respect — hold the line!`,
      tag: "war-target-reached",
      icon: "/icon-192.png",
      data: { type: "war-target", warId },
    },
    "war_target",
    { urgency: "high", TTL: 300 },
  );
}
