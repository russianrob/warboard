/**
 * Web Push notification management for FactionOps.
 *
 * Stores push subscriptions per player and sends notifications
 * for war events (calls, chain alerts, hospital pops).
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

// ── Subscription Storage ────────────────────────────────────────────────

const SUBS_FILE = join(__dirname, "data", "push-subscriptions.json");

/**
 * Map of playerId → PushSubscription[].
 * A player can have multiple devices subscribed.
 */
let subscriptions = {};

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
}

/** Persist subscriptions to disk. */
function saveSubscriptions() {
  try {
    writeFileSync(SUBS_FILE, JSON.stringify(subscriptions, null, 2));
  } catch (err) {
    console.error("[push] Failed to save subscriptions:", err.message);
  }
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

// ── Send Notifications ──────────────────────────────────────────────────

/**
 * Send a push notification to a specific player (all their devices).
 * @param {string} playerId
 * @param {object} payload - { title, body, icon?, tag?, url?, data? }
 */
export async function sendToPlayer(playerId, payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  const subs = subscriptions[playerId];
  if (!subs || subs.length === 0) return;

  const message = JSON.stringify(payload);
  const stale = [];

  for (const sub of subs) {
    try {
      await webPush.sendNotification(sub, message);
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
 * Send a push notification to multiple players.
 * @param {string[]} playerIds
 * @param {object} payload - { title, body, icon?, tag?, url?, data? }
 */
export async function sendToPlayers(playerIds, payload) {
  await Promise.allSettled(playerIds.map((id) => sendToPlayer(id, payload)));
}

/**
 * Send a push notification to all subscribed players in a war.
 * @param {Map|Object} players - store's player map or subset
 * @param {string} warId - filter by war
 * @param {object} payload - { title, body, icon?, tag?, url?, data? }
 * @param {string} [excludePlayerId] - don't notify this player (the actor)
 */
export async function sendToWar(getPlayersForWar, warId, payload, excludePlayerId) {
  const warPlayers = getPlayersForWar(warId);
  if (!warPlayers || warPlayers.length === 0) return;

  const targets = warPlayers
    .map((p) => p.playerId || p.id)
    .filter((id) => id !== excludePlayerId && isSubscribed(id));

  if (targets.length > 0) {
    await sendToPlayers(targets, payload);
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
      title: "⚠️ Chain Breaking!",
      body: `Chain ${current} — ${timeLeft}s remaining! Attack now!`,
      tag: "chain-alert",
      icon: "/icon-192.png",
      data: { type: "chain-alert", warId },
    },
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
  });
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
  );
}
