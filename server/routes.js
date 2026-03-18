/**
 * REST API route definitions.
 */

import { Router } from "express";
import { verifyTornApiKey, issueToken, requireAuth } from "./auth.js";
import * as store from "./store.js";
import { fetchFactionMembers, fetchFactionChain, fetchRankedWar } from "./torn-api.js";
import { getHeatmap, resetHeatmap } from "./activity-heatmap.js";
import { startChainMonitor } from "./chain-monitor.js";

const router = Router();

const CALL_EXPIRE_MS = parseInt(process.env.CALL_EXPIRE_MS, 10) || 5 * 60 * 1000; // 5 minutes
const ALLOWED_FACTION_ID = "42055";
const SOFT_UNCALL_MS = 30_000; // 30 seconds after hospital detection
const REFRESH_COOLDOWN_MS = 30_000; // 30 seconds between refreshes per war

/** Track call expiry timers so they can be cancelled. */
const callTimers = new Map(); // `${warId}:${targetId}` → timeoutId

/** Track last refresh timestamp per warId. */
const refreshCooldowns = new Map(); // warId → timestamp

/** Track last ranked war detection timestamp per warId. */
const rankedWarDetectCooldowns = new Map(); // warId → timestamp
const RANKED_WAR_DETECT_COOLDOWN_MS = 60000; // only check once per minute

function clearExistingTimer(timerKey) {
  if (callTimers.has(timerKey)) {
    clearTimeout(callTimers.get(timerKey));
    callTimers.delete(timerKey);
  }
}

/**
 * Faction gate — verify the authenticated player belongs to the war's faction.
 * Returns the war object if OK, or sends a 403 and returns null.
 */
function requireWarMember(req, res, warId) {
  const war = store.getWar(warId);
  if (!war) return null; // let caller handle 404
  if (war.factionId !== req.user.factionId) {
    res.status(403).json({ error: "You are not a member of this war's faction" });
    return null;
  }
  return war;
}

function uncallTarget(warId, targetId) {
  const war = store.getWar(warId);
  if (!war || !war.calls[targetId]) return;

  delete war.calls[targetId];
  store.saveState();

  const timerKey = `${warId}:${targetId}`;
  clearExistingTimer(timerKey);
}

// ── GET /api/health ──────────────────────────────────────────────────────
// Unauthenticated — used by the landing page to show a live status dot.

router.get("/api/health", (req, res) => {
  res.json({ status: "ok", uptime: Math.floor(process.uptime()) });
});

// ── POST /api/auth ──────────────────────────────────────────────────────

router.post("/api/auth", async (req, res) => {
  const { apiKey } = req.body ?? {};
  if (!apiKey || typeof apiKey !== "string") {
    return res.status(400).json({ error: "apiKey is required" });
  }

  try {
    const info = await verifyTornApiKey(apiKey);

    // Faction lock — only members of the allowed faction can use the system
    if (info.factionId !== ALLOWED_FACTION_ID) {
      console.log(`[auth] Rejected ${info.playerName} (${info.playerId}) — faction ${info.factionId} not allowed`);
      return res.status(403).json({ error: "This system is restricted to authorized factions only" });
    }

    // Store the API key server-side for later Torn API calls
    store.storeApiKey(info.playerId, apiKey);

    const token = issueToken({
      playerId: info.playerId,
      playerName: info.playerName,
      factionId: info.factionId,
      factionName: info.factionName,
      factionPosition: info.factionPosition,
    });

    console.log(`[auth] Player ${info.playerName} (${info.playerId}) authenticated`);

    return res.json({
      token,
      player: info,
    });
  } catch (err) {
    console.error("[auth] Authentication failed:", err.message);
    return res.status(401).json({ error: err.message });
  }
});

// ── GET /api/faction/:factionId/war ─────────────────────────────────────

router.get("/api/faction/:factionId/war", requireAuth, (req, res) => {
  const { factionId } = req.params;

  // Faction gate — only your own faction's wars
  if (factionId !== req.user.factionId) {
    return res.status(403).json({ error: "You are not a member of this faction" });
  }

  // Find all wars for this faction
  const result = [];
  for (const [, war] of store.getAllWars()) {
    if (war.factionId === factionId) {
      result.push({
        warId: war.warId,
        enemyFactionId: war.enemyFactionId,
        calls: war.calls,
        priorities: war.priorities,
        enemyStatuses: war.enemyStatuses,
        chainData: war.chainData,
      });
    }
  }

  return res.json({ wars: result });
});

// ── GET /api/faction/:factionId/chain ───────────────────────────────────

router.get("/api/faction/:factionId/chain", requireAuth, async (req, res) => {
  const { factionId } = req.params;

  // Faction gate — only your own faction's chain
  if (factionId !== req.user.factionId) {
    return res.status(403).json({ error: "You are not a member of this faction" });
  }

  // We need an API key for this faction — prefer faction-dedicated key
  const apiKey = store.getFactionApiKey(factionId) || store.getApiKeyForFaction(factionId);
  if (!apiKey) {
    return res.status(503).json({ error: "No API key available for this faction" });
  }

  try {
    // Fetch our own faction's chain data
    const chain = await fetchFactionChain(factionId, apiKey);
    return res.json({ chain });
  } catch (err) {
    console.error("[chain] Failed to fetch chain data:", err.message);
    return res.status(502).json({ error: "Failed to fetch chain data from Torn API" });
  }
});

// ── GET /api/poll ────────────────────────────────────────────────────────
// Returns full war state for the authenticated player's faction.
// The client polls this endpoint at 1-2s intervals instead of using Socket.IO.
// Accepts token via Authorization header OR ?token= query param (for PDA).

router.get("/api/poll", (req, res, next) => {
  // Allow token in query string for PDA (PDA_httpGet can't set headers)
  if (!req.headers.authorization && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
}, requireAuth, async (req, res) => {
  const { playerId, playerName, factionId } = req.user;
  const { warId, enemyFactionId } = req.query;

  if (!warId) {
    return res.status(400).json({ error: "warId query parameter is required" });
  }

  // Ensure war exists (join_war equivalent)
  const war = store.getOrCreateWar(warId, factionId, enemyFactionId || null);

  // Faction gate — if this war already belongs to another faction, reject
  if (war.factionId !== factionId) {
    return res.status(403).json({ error: "You are not a member of this war's faction" });
  }

  // Auto-detect ranked war enemy if not set
  if (!war.enemyFactionId) {
    const lastDetect = rankedWarDetectCooldowns.get(warId) || 0;
    if (Date.now() - lastDetect > RANKED_WAR_DETECT_COOLDOWN_MS) {
      rankedWarDetectCooldowns.set(warId, Date.now());
      const apiKey = store.getFactionApiKey(factionId) || store.getApiKeyForFaction(factionId);
      if (apiKey) {
        try {
          const rw = await fetchRankedWar(factionId, apiKey);
          if (rw && rw.enemyFactionId) {
            war.enemyFactionId = rw.enemyFactionId;
            war.enemyFactionName = rw.enemyFactionName;
            console.log(`[api] Auto-detected ranked war: enemy faction ${rw.enemyFactionId} (${rw.enemyFactionName})`);

            // Also fetch enemy members immediately
            try {
              const freshStatuses = await fetchFactionMembers(rw.enemyFactionId, apiKey);
              war.enemyStatuses = freshStatuses;
              console.log(`[api] Fetched ${Object.keys(freshStatuses).length} enemy members`);
            } catch (err) {
              console.error('[api] Failed to fetch enemy members:', err.message);
            }

            store.saveState();
          }
        } catch (err) {
          console.error('[api] Ranked war detection failed:', err.message);
        }
      }
    }
  }

  // Chain data now comes from clients via DOM reading — no server-side chain polling
  // startChainMonitor(null, warId);

  // Track player as online (use playerId as pseudo-socketId for polling clients)
  store.setPlayer(playerId, {
    socketId: `poll_${playerId}`,
    factionId,
    warId,
    name: playerName,
  });

  return res.json({
    warId: war.warId,
    factionId: war.factionId,
    enemyFactionId: war.enemyFactionId,
    enemyFactionName: war.enemyFactionName || null,
    calls: war.calls,
    priorities: war.priorities,
    enemyStatuses: war.enemyStatuses,
    chainData: war.chainData,
    onlinePlayers: store.getOnlinePlayersForWar(warId),
    viewers: store.getViewersForWar(warId),
    factionKeyStored: !!store.getFactionApiKey(factionId),
  });
});

// ── POST /api/call ───────────────────────────────────────────────────────
// Call or uncall a target.

router.post("/api/call", requireAuth, (req, res) => {
  const { playerId, playerName } = req.user;
  const { action, targetId, targetName, warId } = req.body ?? {};

  if (!targetId || !warId) {
    return res.status(400).json({ error: "targetId and warId are required" });
  }

  const war = requireWarMember(req, res, warId);
  if (!war) {
    return war === null && !res.headersSent
      ? res.status(404).json({ error: "War not found" })
      : undefined;
  }

  if (action === "uncall") {
    const call = war.calls[targetId];
    if (!call) {
      return res.json({ ok: true }); // already uncalled, idempotent
    }
    if (call.calledBy.id !== playerId) {
      return res.status(403).json({ error: "Only the caller can uncall this target" });
    }

    uncallTarget(warId, targetId);
    console.log(`[api] ${playerName} uncalled target ${targetId}`);
    return res.json({ ok: true });
  }

  // Default action: call
  if (war.calls[targetId]) {
    return res.status(409).json({
      error: `Target ${targetId} is already called by ${war.calls[targetId].calledBy.name}`,
    });
  }

  const callData = {
    calledBy: { id: playerId, name: playerName },
    timestamp: Date.now(),
  };
  war.calls[targetId] = callData;
  store.saveState();

  // Set auto-expire timer
  const timerKey = `${warId}:${targetId}`;
  clearExistingTimer(timerKey);
  callTimers.set(
    timerKey,
    setTimeout(() => {
      uncallTarget(warId, targetId);
    }, CALL_EXPIRE_MS),
  );

  console.log(`[api] ${playerName} called target ${targetId} in war ${warId}`);
  return res.json({ ok: true, call: callData });
});

// ── POST /api/priority ──────────────────────────────────────────────────
// Set or clear a priority tag on a target. Leader/co-leader only.

const LEADER_POSITIONS = ["leader", "co-leader", "war leader", "banker"];

router.post("/api/priority", requireAuth, (req, res) => {
  const { playerId, playerName, factionPosition } = req.user;
  const { targetId, priority, warId } = req.body ?? {};

  // Enforce leader/co-leader
  const pos = (factionPosition || "").toLowerCase();
  if (!LEADER_POSITIONS.includes(pos)) {
    return res.status(403).json({ error: "Only leaders and co-leaders can set priority tags" });
  }

  if (!targetId || !warId) {
    return res.status(400).json({ error: "targetId and warId are required" });
  }

  const validPriorities = ["high", "medium", "low", null];
  if (!validPriorities.includes(priority)) {
    return res.status(400).json({ error: "priority must be 'high', 'medium', 'low', or null" });
  }

  const war = requireWarMember(req, res, warId);
  if (!war) {
    return war === null && !res.headersSent
      ? res.status(404).json({ error: "War not found" })
      : undefined;
  }

  // Ensure priorities map exists (wars created before this field may lack it)
  if (!war.priorities) war.priorities = {};

  if (priority === null) {
    delete war.priorities[targetId];
  } else {
    war.priorities[targetId] = {
      level: priority,
      setBy: { id: playerId, name: playerName },
      timestamp: Date.now(),
    };
  }
  store.saveState();

  console.log(`[api] ${playerName} set priority '${priority}' on target ${targetId} in war ${warId}`);
  return res.json({ ok: true, priority: war.priorities[targetId] || null });
});


// ── POST /api/faction-key ─────────────────────────────────────────────────
// Save a faction-dedicated API key for server-side polling.

router.post("/api/faction-key", requireAuth, async (req, res) => {
  const { factionId } = req.user;
  const { apiKey } = req.body ?? {};

  if (!apiKey || typeof apiKey !== "string") {
    return res.status(400).json({ error: "apiKey is required" });
  }

  // Validate the key by making a test call to Torn API
  try {
    const url = `https://api.torn.com/user/?selections=basic&key=${encodeURIComponent(apiKey)}`;
    const tornRes = await fetch(url);
    if (!tornRes.ok) {
      return res.status(502).json({ error: `Torn API returned HTTP ${tornRes.status}` });
    }
    const data = await tornRes.json();
    if (data.error) {
      return res.status(400).json({ error: `Invalid API key: ${data.error.error}` });
    }
  } catch (err) {
    return res.status(502).json({ error: `Failed to validate key: ${err.message}` });
  }

  store.storeFactionApiKey(factionId, apiKey);
  console.log(`[api] Faction API key saved for faction ${factionId}`);
  return res.json({ ok: true });
});

// ── DELETE /api/faction-key ──────────────────────────────────────────────
// Remove the faction-dedicated API key.

function handleRemoveFactionKey(req, res) {
  const { factionId } = req.user;
  store.removeFactionApiKey(factionId);
  console.log(`[api] Faction API key removed for faction ${factionId}`);
  return res.json({ ok: true });
}

router.delete("/api/faction-key", requireAuth, handleRemoveFactionKey);
// POST alias for PDA compatibility (PDA's WebView only supports GET/POST)
router.post("/api/faction-key/remove", requireAuth, handleRemoveFactionKey);

// ── POST /api/status ─────────────────────────────────────────────────────
// Bulk update enemy statuses or report chain data.

router.post("/api/status", requireAuth, async (req, res) => {
  const { playerId, playerName, factionId } = req.user;
  const { warId, statuses, chainData, refresh } = req.body ?? {};

  if (!warId) {
    return res.status(400).json({ error: "warId is required" });
  }

  const war = requireWarMember(req, res, warId);
  if (!war) {
    return war === null && !res.headersSent
      ? res.status(404).json({ error: "War not found" })
      : undefined;
  }

  // Bulk status update from intercepted data
  if (statuses && typeof statuses === "object") {
    for (const [targetId, statusData] of Object.entries(statuses)) {
      const existing = war.enemyStatuses[targetId] || {};
      war.enemyStatuses[targetId] = {
        ...existing,
        ...statusData,
      };

      // If hospital, soft-uncall after delay
      const st = statusData.status || "";
      if (st.toLowerCase().includes("hospital") && war.calls[targetId]) {
        const timerKey = `${warId}:${targetId}`;
        clearExistingTimer(timerKey);
        callTimers.set(
          timerKey,
          setTimeout(() => {
            uncallTarget(warId, targetId);
          }, SOFT_UNCALL_MS),
        );
      }
    }
    store.saveState();
  }

  // Chain data update from intercepted data
  if (chainData && typeof chainData === "object") {
    war.chainData = { ...war.chainData, ...chainData };
    store.saveState();
  }

  // Full refresh from Torn API
  if (refresh) {
    if (!war.enemyFactionId) {
      return res.status(400).json({ error: "No enemy faction configured for this war" });
    }

    const now = Date.now();
    const lastRefresh = refreshCooldowns.get(warId) || 0;
    if (now - lastRefresh < REFRESH_COOLDOWN_MS) {
      const waitSec = Math.ceil((REFRESH_COOLDOWN_MS - (now - lastRefresh)) / 1000);
      return res.status(429).json({ error: `Please wait ${waitSec}s before refreshing again` });
    }
    refreshCooldowns.set(warId, now);

    const apiKey = store.getFactionApiKey(factionId) || store.getApiKeyForFaction(factionId);
    if (!apiKey) {
      return res.status(503).json({ error: "No API key available for status refresh" });
    }

    try {
      const freshStatuses = await fetchFactionMembers(war.enemyFactionId, apiKey);
      war.enemyStatuses = freshStatuses;
      store.saveState();
      console.log(`[api] Statuses refreshed for war ${warId} (${Object.keys(freshStatuses).length} members)`);
    } catch (err) {
      console.error("[api] Status refresh failed:", err.message);
      return res.status(502).json({ error: `Status refresh failed: ${err.message}` });
    }
  }

  return res.json({ ok: true });
});

// ── POST /api/viewing ────────────────────────────────────────────────────
// Report which target the player is currently viewing (attack page).
// Send targetId = null when leaving the attack page.

router.post("/api/viewing", requireAuth, (req, res) => {
  const { playerId } = req.user;
  const { targetId } = req.body ?? {};
  store.setViewingTarget(playerId, targetId || null);
  return res.json({ ok: true });
});

// ── GET /api/heatmap ─────────────────────────────────────────────────────
// Returns the activity heatmap data for the authenticated player's faction.

router.get("/api/heatmap", requireAuth, (req, res) => {
  const { factionId } = req.user;
  return res.json({ heatmap: getHeatmap(factionId) });
});

// ── DELETE /api/heatmap ──────────────────────────────────────────────────
// Reset the activity heatmap for the faction. Leader/co-leader only.

function handleResetHeatmap(req, res) {
  const { factionId, factionPosition } = req.user;
  const pos = (factionPosition || "").toLowerCase();
  if (!LEADER_POSITIONS.includes(pos)) {
    return res.status(403).json({ error: "Only leaders and co-leaders can reset the heatmap" });
  }
  resetHeatmap(factionId);
  return res.json({ ok: true });
}

router.delete("/api/heatmap", requireAuth, handleResetHeatmap);
// POST alias for PDA compatibility (PDA's WebView only supports GET/POST)
router.post("/api/heatmap/remove", requireAuth, handleResetHeatmap);

export default router;
