/**
 * Dynamic faction subscription manager.
 *
 * Polls the server owner's Torn money log looking for incoming transfers
 * of $50,000,000+. When detected, looks up the sender's faction and
 * whitelists it for 30 days. Repeat payments extend the expiration.
 *
 * Persists subscription state to data/subscriptions.json.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Configuration ───────────────────────────────────────────────────────

const OWNER_API_KEY = process.env.OWNER_API_KEY || "";
const OWNER_FACTION_ID = process.env.OWNER_FACTION_ID || "42055";
const SUBSCRIPTION_PRICE = parseInt(process.env.SUBSCRIPTION_PRICE, 10) || 50_000_000;
const SUBSCRIPTION_DAYS = parseInt(process.env.SUBSCRIPTION_DAYS, 10) || 30;
const TRIAL_PRICE = parseInt(process.env.TRIAL_PRICE, 10) || 1_000_000;
const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS, 10) || 7;
const POLL_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes

const DATA_DIR = process.env.DATA_DIR || join(__dirname, "data");
const SUBS_FILE = join(DATA_DIR, "subscriptions.json");

// ── State ───────────────────────────────────────────────────────────────

let state = {
  factions: {},            // { factionId: { factionName, paidBy: { playerId, playerName }, paidAt, expiresAt, transactionId, tier } }
  processedTransactions: [], // transaction IDs already handled
  trialsUsed: [],          // factionIds that have used their one-time trial
};

let pollTimer = null;

// ── Persistence ─────────────────────────────────────────────────────────

function loadState() {
  try {
    if (existsSync(SUBS_FILE)) {
      const raw = readFileSync(SUBS_FILE, "utf-8");
      const loaded = JSON.parse(raw);
      state.factions = loaded.factions || {};
      state.processedTransactions = loaded.processedTransactions || [];
      state.trialsUsed = loaded.trialsUsed || [];
      console.log(
        `[subscriptions] Loaded ${Object.keys(state.factions).length} faction(s), ` +
        `${state.processedTransactions.length} processed transaction(s)`
      );
    }
  } catch (err) {
    console.error("[subscriptions] Failed to load subscriptions.json:", err.message);
  }
}

function saveState() {
  try {
    const dir = dirname(SUBS_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(SUBS_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.error("[subscriptions] Failed to save subscriptions.json:", err.message);
  }
}

// ── Torn API helpers ────────────────────────────────────────────────────

async function fetchMoneyLog() {
  const url = `https://api.torn.com/user/?selections=log&log=5200&key=${OWNER_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Torn API HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Torn API error: ${data.error.error}`);
  return data.log || {};
}

async function fetchPlayerBasic(playerId) {
  const url = `https://api.torn.com/user/${playerId}?selections=basic&key=${OWNER_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Torn API HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Torn API error: ${data.error.error}`);
  return data;
}

// ── Core logic ──────────────────────────────────────────────────────────

async function pollPayments() {
  try {
    const log = await fetchMoneyLog();

    for (const [txId, entry] of Object.entries(log)) {
      // Skip already-processed transactions
      if (state.processedTransactions.includes(txId)) continue;

      // log type 5200 entries have "data.money" for the amount received
      // and "data.sender" or similar for the sender player ID
      const amount = entry.data?.money || entry.data?.amount || 0;
      const senderId = entry.data?.sender || entry.data?.user || null;

      if (!senderId || amount < SUBSCRIPTION_PRICE) {
        // Mark as processed — under full subscription price
        state.processedTransactions.push(txId);
        continue;
      }

      const tier = "full";
      const grantDays = SUBSCRIPTION_DAYS;

      // Look up the sender's faction
      try {
        const player = await fetchPlayerBasic(senderId);
        const factionId = String(player.faction?.faction_id || "");
        const factionName = player.faction?.faction_name || "Unknown";
        const playerName = player.name || `Player ${senderId}`;

        if (!factionId || factionId === "0") {
          console.log(
            `[subscriptions] Payment of $${amount.toLocaleString()} from ${playerName} [${senderId}] — ` +
            `player has no faction, skipping`
          );
          state.processedTransactions.push(txId);
          saveState();
          continue;
        }

        // Skip if it's the owner's own faction
        if (factionId === OWNER_FACTION_ID) {
          state.processedTransactions.push(txId);
          saveState();
          continue;
        }

        // Trial: one-time per faction
        if (tier === "trial" && state.trialsUsed.includes(factionId)) {
          console.log(
            `[subscriptions] Trial payment from ${playerName} [${senderId}] (faction ${factionId}) — ` +
            `trial already used, ignoring`
          );
          state.processedTransactions.push(txId);
          saveState();
          continue;
        }

        const now = new Date().toISOString();
        const existing = state.factions[factionId];
        let baseDate = new Date();

        // If already subscribed and not expired, extend from current expiry
        if (existing && new Date(existing.expiresAt) > new Date()) {
          baseDate = new Date(existing.expiresAt);
        }

        const expiresAt = new Date(baseDate.getTime() + grantDays * 24 * 60 * 60 * 1000).toISOString();

        state.factions[factionId] = {
          factionName,
          paidBy: { playerId: String(senderId), playerName },
          paidAt: now,
          expiresAt,
          transactionId: txId,
          tier,
        };

        // Mark trial as used for this faction
        if (tier === "trial" && !state.trialsUsed.includes(factionId)) {
          state.trialsUsed.push(factionId);
        }

        state.processedTransactions.push(txId);
        saveState();

        const expiryDate = new Date(expiresAt).toLocaleDateString("en-US", {
          year: "numeric", month: "short", day: "numeric",
        });

        const tierLabel = tier === "trial" ? `${TRIAL_DAYS}-day trial` : `${SUBSCRIPTION_DAYS}-day sub`;
        if (existing) {
          console.log(
            `[subscriptions] Faction renewed: ${factionName} (${factionId}) paid by ${playerName} — ` +
            `${tierLabel}, extended to ${expiryDate}`
          );
        } else {
          console.log(
            `[subscriptions] New faction subscribed: ${factionName} (${factionId}) paid by ${playerName} — ` +
            `${tierLabel}, expires ${expiryDate}`
          );
        }
      } catch (lookupErr) {
        console.error(`[subscriptions] Failed to look up player ${senderId}:`, lookupErr.message);
        // Don't mark as processed — retry next poll
      }
    }

    // Trim processedTransactions to last 1000 to prevent unbounded growth
    if (state.processedTransactions.length > 1000) {
      state.processedTransactions = state.processedTransactions.slice(-1000);
      saveState();
    }
  } catch (err) {
    console.error("[subscriptions] Poll failed:", err.message);
  }
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Check if a faction is allowed access.
 * Returns true if:
 *  - factionId is the owner's faction
 *  - OR factionId has an active (non-expired) subscription
 */
export function isFactionAllowed(factionId) {
  return String(factionId) === OWNER_FACTION_ID;
}

/**
 * Get all subscriptions with their current status.
 */
export function getAllSubscriptions() {
  const now = new Date();
  const result = {};

  for (const [factionId, sub] of Object.entries(state.factions)) {
    result[factionId] = {
      ...sub,
      status: new Date(sub.expiresAt) > now ? "active" : "expired",
    };
  }

  return result;
}

/**
 * Get the owner faction ID.
 */
export function getOwnerFactionId() {
  return OWNER_FACTION_ID;
}

/**
 * Get human-readable rejection message for unauthorized factions.
 */
export function getSubscriptionRejectionMessage() {
  return "Access denied. FactionOps is currently restricted to faction " + OWNER_FACTION_ID + ".";
}

/**
 * Start the subscription manager — load state and begin polling.
 */
export function startSubscriptionManager() {
  loadState();

  if (!OWNER_API_KEY) {
    console.log("[subscriptions] OWNER_API_KEY not set — subscription polling disabled");
    console.log("[subscriptions] Only the owner faction (ID: " + OWNER_FACTION_ID + ") will have access");
    return;
  }

  // Payment polling disabled — manual subscription management only
  console.log(`[subscriptions] Payment polling disabled — owner faction (${OWNER_FACTION_ID}) has permanent access`);
}

/**
 * Stop the subscription manager — clear timer and save state.
 */
export function stopSubscriptionManager() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  saveState();
  console.log("[subscriptions] Stopped and saved");
}
