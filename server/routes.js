/**
 * REST API route definitions.
 */

import { Router } from "express";
import { verifyTornApiKey, issueToken, verifyToken, requireAuth } from "./auth.js";
import * as store from "./store.js";
import { fetchFactionMembers, fetchFactionChain, fetchRankedWar } from "./torn-api.js";
import { getHeatmap, resetHeatmap } from "./activity-heatmap.js";
import { startChainMonitor } from "./chain-monitor.js";
import * as push from "./push-notifications.js";

const router = Router();

const CALL_EXPIRE_MS = parseInt(process.env.CALL_EXPIRE_MS, 10) || 5 * 60 * 1000; // 5 minutes
const DEAL_EXPIRE_MS = parseInt(process.env.DEAL_EXPIRE_MS, 10) || 15 * 60 * 1000; // 15 minutes (multi-hit deal)
const ALLOWED_FACTION_ID = "42055";
const SOFT_UNCALL_MS = 30_000; // 30 seconds after hospital detection
const REFRESH_COOLDOWN_MS = 30_000; // 30 seconds between refreshes per war

/** Socket.IO server instance — set via setIO() from server.js. */
let io = null;

/** Called by server.js to share the Socket.IO instance with route handlers. */
export function setIO(ioInstance) {
  io = ioInstance;
}

// ── SSE stream clients (for Tampermonkey GM_xmlhttpRequest onprogress) ───────
// Map<warId, Set<{ res, playerId }>>
const sseClients = new Map();

function addSSEClient(warId, client) {
  if (!sseClients.has(warId)) sseClients.set(warId, new Set());
  sseClients.get(warId).add(client);
}

function removeSSEClient(warId, client) {
  const set = sseClients.get(warId);
  if (set) {
    set.delete(client);
    if (set.size === 0) sseClients.delete(warId);
  }
}

/** Push SSE event to all stream clients in a war room. */
function broadcastSSE(warId, data) {
  const set = sseClients.get(warId);
  if (!set || set.size === 0) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of set) {
    try { client.res.write(payload); } catch (_) { /* client gone */ }
  }
}

/**
 * Broadcast a full war state snapshot to all clients in a war room.
 * Called after any state mutation so connected clients get instant updates.
 */
function broadcastWarUpdate(warId) {
  const war = store.getWar(warId);
  if (!war) return;
  const payload = {
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
    ourFactionOnline: war.ourFactionOnline || null,
    factionKeyStored: !!store.getFactionApiKey(war.factionId),
    warTarget: war.warTarget || null,
  };
  // Push to Socket.IO clients
  if (io) io.to(`war_${warId}`).emit("war_update", payload);
  // Push to SSE stream clients
  broadcastSSE(warId, payload);
}

/** Track call expiry timers so they can be cancelled. */
const callTimers = new Map(); // `${warId}:${targetId}` → timeoutId

/** Track last refresh timestamp per warId. */
const refreshCooldowns = new Map(); // warId → timestamp

/** Track last ranked war detection timestamp per warId. */
const rankedWarDetectCooldowns = new Map(); // warId → timestamp
const RANKED_WAR_DETECT_COOLDOWN_MS = 60000; // only check once per minute

/** Track last chain alert push per warId to avoid spamming. */
const chainAlertCooldowns = new Map(); // warId → timestamp
const CHAIN_ALERT_COOLDOWN_MS = 30000; // max one chain alert push per 30s

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

  broadcastWarUpdate(warId);
}

// ── GET /api/health ──────────────────────────────────────────────────────
// Unauthenticated — used by the landing page to show a live status dot.

router.get("/api/health", (req, res) => {
  res.json({ status: "ok", uptime: Math.floor(process.uptime()) });
});


// ── POST /api/gate ──────────────────────────────────────────────────────
// Verify Torn API key for landing page access. Sets a cookie on success.

router.post("/api/gate", async (req, res) => {
  const { apiKey } = req.body ?? {};
  if (!apiKey || typeof apiKey !== "string") {
    return res.status(400).json({ error: "API key is required" });
  }

  // Retry once on transient Torn API failures
  let info;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      info = await verifyTornApiKey(apiKey);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      // If it's a Torn API error (invalid key), don't retry
      if (err.message.includes("Torn API error")) break;
      // Otherwise (network/timeout), wait 1s and retry
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1000));
    }
  }

  if (lastErr) {
    console.error("[gate] Verification failed:", lastErr.message);
    const msg = lastErr.message.includes("Torn API error") ? "Invalid API key" : "Verification failed — please try again";
    return res.status(401).json({ error: msg });
  }

  if (info.factionId !== ALLOWED_FACTION_ID) {
    return res.status(403).json({ error: "Access restricted to faction members only" });
  }

  // Issue a gate-specific JWT (24h) stored as a cookie
  const gateToken = issueToken({ playerId: info.playerId, playerName: info.playerName, gate: true });
  res.cookie("fo_gate", gateToken, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  });

  return res.json({ ok: true, playerName: info.playerName });
});

/**
 * Middleware: gate the entire site behind faction membership.
 * Exempt: /api/*, gate.html, .meta.js (Tampermonkey update checks).
 * Script downloads (.user.js) and the landing page require gate cookie.
 */
export function gateMiddleware(req, res, next) {
  // Always allow API routes, gate page, and .meta.js files (for update checks)
  if (
    req.path.startsWith("/api/") ||
    req.path === "/gate.html" ||
    req.path.endsWith(".meta.js")
  ) {
    return next();
  }

  // Check for gate cookie
  const token = parseCookie(req.headers.cookie, "fo_gate");
  if (token) {
    try {
      verifyToken(token);
      return next(); // Valid — let through
    } catch (_) {
      // Expired or invalid — fall through to gate
    }
  }

  // Redirect to gate page
  if (req.path === "/" || req.path === "/index.html") {
    return res.redirect("/gate.html");
  }

  // Block other static assets for unauthenticated users
  return res.redirect("/gate.html");
}

/** Simple cookie parser — no dependency needed. */
function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

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

// ── GET /api/stream ──────────────────────────────────────────────────────
// SSE stream for Tampermonkey clients (GM_xmlhttpRequest onprogress).
// Holds the connection open and pushes war updates as SSE events.
// Auth via ?token= query param. Heartbeat every 25s to keep alive.

router.get("/api/stream", (req, res, next) => {
  if (!req.headers.authorization && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
}, requireAuth, (req, res) => {
  const { playerId, playerName, factionId } = req.user;
  const { warId, enemyFactionId } = req.query;

  if (!warId) {
    return res.status(400).json({ error: "warId query parameter is required" });
  }

  const war = store.getOrCreateWar(warId, factionId, enemyFactionId || null);
  if (war.factionId !== factionId) {
    return res.status(403).json({ error: "Not a member of this war's faction" });
  }

  // Track player as online
  store.setPlayer(playerId, {
    socketId: `sse_${playerId}`,
    factionId,
    warId,
    name: playerName,
  });

  // Set up SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Send initial war state immediately
  const initial = {
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
    ourFactionOnline: war.ourFactionOnline || null,
    factionKeyStored: !!store.getFactionApiKey(factionId),
    warTarget: war.warTarget || null,
  };
  res.write(`data: ${JSON.stringify(initial)}\n\n`);

  // Register this client for broadcasts
  const client = { res, playerId };
  addSSEClient(warId, client);
  console.log(`[sse] ${playerName} connected to stream for war ${warId}`);

  // Heartbeat every 25s to keep connection alive
  const heartbeat = setInterval(() => {
    try { res.write(`: heartbeat\n\n`); } catch (_) {}
  }, 25000);

  // Cleanup on disconnect
  req.on("close", () => {
    clearInterval(heartbeat);
    removeSSEClient(warId, client);
    console.log(`[sse] ${playerName} disconnected from stream`);
  });
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
    ourFactionOnline: war.ourFactionOnline || null,
    factionKeyStored: !!store.getFactionApiKey(factionId),
    warTarget: war.warTarget || null,
  });
});

// ── POST /api/call ───────────────────────────────────────────────────────
// Call or uncall a target.

router.post("/api/call", requireAuth, (req, res) => {
  const { playerId, playerName } = req.user;
  const { action, targetId, targetName, warId, isDeal } = req.body ?? {};

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

    uncallTarget(warId, targetId); // broadcasts inside
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
    isDeal: !!isDeal,
  };
  war.calls[targetId] = callData;
  store.saveState();

  // Set auto-expire timer (deal calls get a longer timeout)
  const timerKey = `${warId}:${targetId}`;
  const expireMs = isDeal ? DEAL_EXPIRE_MS : CALL_EXPIRE_MS;
  clearExistingTimer(timerKey);
  callTimers.set(
    timerKey,
    setTimeout(() => {
      uncallTarget(warId, targetId);
    }, expireMs),
  );

  broadcastWarUpdate(warId);
  console.log(`[api] ${playerName} ${isDeal ? 'deal-called' : 'called'} target ${targetId} in war ${warId}`);

  // Push notification to war room (except the caller)
  const warPlayers = store.getOnlinePlayersForWar(warId);
  push.notifyTargetCalled(warPlayers, warId, playerName, targetName || targetId, playerId);

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

  broadcastWarUpdate(warId);
  console.log(`[api] ${playerName} set priority '${priority}' on target ${targetId} in war ${warId}`);
  return res.json({ ok: true, priority: war.priorities[targetId] || null });
});


// ── GET /api/war-target ──────────────────────────────────────────────────
// Get the custom war target for a specific war.

router.get("/api/war-target", requireAuth, (req, res) => {
  const { warId } = req.query;
  if (!warId) {
    return res.status(400).json({ error: "warId query parameter is required" });
  }
  const war = requireWarMember(req, res, warId);
  if (!war) {
    return war === null && !res.headersSent
      ? res.status(404).json({ error: "War not found" })
      : undefined;
  }
  return res.json({ warTarget: war.warTarget || null });
});

// ── POST /api/war-target ─────────────────────────────────────────────────
// Set or clear the custom war target. Leader/co-leader only.

router.post("/api/war-target", requireAuth, (req, res) => {
  const { playerId, playerName, factionPosition } = req.user;
  const { warId, target } = req.body ?? {};

  // Enforce leader/co-leader
  const pos = (factionPosition || "").toLowerCase();
  if (!LEADER_POSITIONS.includes(pos)) {
    return res.status(403).json({ error: "Only leaders and co-leaders can set the war target" });
  }

  if (!warId) {
    return res.status(400).json({ error: "warId is required" });
  }

  const war = requireWarMember(req, res, warId);
  if (!war) {
    return war === null && !res.headersSent
      ? res.status(404).json({ error: "War not found" })
      : undefined;
  }

  if (target === null || target === undefined || target === 0) {
    war.warTarget = null;
    store.saveState();
    broadcastWarUpdate(warId);
    console.log(`[api] ${playerName} cleared war target for war ${warId}`);
    return res.json({ ok: true, warTarget: null });
  }

  const numTarget = parseInt(target, 10);
  if (isNaN(numTarget) || numTarget <= 0) {
    return res.status(400).json({ error: "target must be a positive number" });
  }

  war.warTarget = {
    value: numTarget,
    setBy: { id: playerId, name: playerName },
    timestamp: Date.now(),
  };
  store.saveState();
  broadcastWarUpdate(warId);
  console.log(`[api] ${playerName} set war target to ${numTarget.toLocaleString()} for war ${warId}`);
  return res.json({ ok: true, warTarget: war.warTarget });
});

// ── POST /api/war-target-reached ──────────────────────────────────────────
// Trigger push notification when custom war target is reached. Fires once.

router.post("/api/war-target-reached", requireAuth, (req, res) => {
  const { warId, lead } = req.body ?? {};

  if (!warId) {
    return res.status(400).json({ error: "warId is required" });
  }

  const war = requireWarMember(req, res, warId);
  if (!war) {
    return war === null && !res.headersSent
      ? res.status(404).json({ error: "War not found" })
      : undefined;
  }

  if (!war.warTarget) {
    return res.status(400).json({ error: "No war target set" });
  }

  // Only fire once per target value
  if (war.warTarget.notifiedAt) {
    return res.json({ ok: true, alreadyNotified: true });
  }

  war.warTarget.notifiedAt = Date.now();
  store.saveState();

  const warPlayers = store.getOnlinePlayersForWar(warId);
  push.notifyWarTargetReached(warPlayers, warId, war.warTarget.value, lead || war.warTarget.value);

  console.log(`[api] War target reached notification sent for war ${warId} (target: ${war.warTarget.value})`);
  return res.json({ ok: true });
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
      const wasHospital = existing.status && existing.status.toLowerCase().includes("hospital");
      war.enemyStatuses[targetId] = {
        ...existing,
        ...statusData,
      };

      const st = statusData.status || "";
      const isHospital = st.toLowerCase().includes("hospital");

      // If hospital, soft-uncall after delay — but NOT for deal calls
      // (deal calls reserve the target for multiple hits, so hospitalization is expected)
      if (isHospital && war.calls[targetId] && !war.calls[targetId].isDeal) {
        const timerKey = `${warId}:${targetId}`;
        clearExistingTimer(timerKey);
        callTimers.set(
          timerKey,
          setTimeout(() => {
            uncallTarget(warId, targetId);
          }, SOFT_UNCALL_MS),
        );
      }

      // Push notification: target left hospital (was hospital, now isn't)
      if (wasHospital && !isHospital) {
        const targetName = statusData.name || existing.name || targetId;
        // Notify all subscribed war members
        const warPlayers = store.getOnlinePlayersForWar(warId);
        for (const p of warPlayers) {
          push.notifyHospitalPop(p.id, targetName, targetId);
        }
      }
    }
    store.saveState();
  }

  // Chain data update from intercepted data
  if (chainData && typeof chainData === "object") {
    const prevChain = { ...war.chainData };
    war.chainData = { ...war.chainData, ...chainData };
    store.saveState();

    // Push chain-break alert if timeout is dangerously low (< 60s)
    const timeout = chainData.timeout ?? war.chainData.timeout;
    const current = chainData.current ?? war.chainData.current;
    const lastChainAlert = chainAlertCooldowns.get(warId) || 0;
    if (timeout > 0 && timeout <= 60 && current > 0 && Date.now() - lastChainAlert > CHAIN_ALERT_COOLDOWN_MS) {
      chainAlertCooldowns.set(warId, Date.now());
      const warPlayers = store.getOnlinePlayersForWar(warId);
      push.notifyChainAlert(warPlayers, warId, current, timeout, Math.round(timeout));
    }

    // Push bonus-imminent alert (within 2 hits of a milestone)
    const BONUSES = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];
    if (current > 0) {
      const nextBonus = BONUSES.find((b) => b > current);
      if (nextBonus && nextBonus - current <= 2 && (prevChain.current || 0) < current) {
        const warPlayers = store.getOnlinePlayersForWar(warId);
        push.notifyBonusImminent(warPlayers, warId, current, nextBonus);
      }
    }
  }

  // Broadcast if anything changed
  if ((statuses && typeof statuses === "object") || (chainData && typeof chainData === "object")) {
    broadcastWarUpdate(warId);
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
      broadcastWarUpdate(warId);
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
  const { playerId, playerName } = req.user;
  const { targetId } = req.body ?? {};
  store.setViewingTarget(playerId, targetId || null);

  // Broadcast viewer change — need warId from the player's current session
  const player = store.getPlayer(playerId);
  if (player?.warId) {
    broadcastWarUpdate(player.warId);

    // Call-stolen detection: if this target is called by someone else, notify the caller
    if (targetId) {
      const war = store.getWar(player.warId);
      if (war) {
        const call = war.calls[targetId];
        if (call && call.calledBy.id !== playerId) {
          // Someone is viewing a target called by another player
          const targetInfo = war.enemyStatuses[targetId];
          const targetName = targetInfo?.name || targetId;
          push.notifyCallStolen(call.calledBy.id, playerName, targetName, targetId);
        }
      }
    }
  }

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

// ── Push notification auth ─────────────────────────────────────────────
// Landing page is ungated, so push endpoints authenticate via Bearer JWT
// obtained from /api/auth (stored in localStorage on the client).

// ── GET /api/push/vapid-key ────────────────────────────────────────────
// Returns the VAPID public key for client-side push subscription.
// Unauthenticated — needed before login for early subscription.

router.get("/api/push/vapid-key", (_req, res) => {
  const key = push.getPublicKey();
  if (!key) {
    return res.status(503).json({ error: "Push notifications not configured" });
  }
  return res.json({ publicKey: key });
});

// ── POST /api/push/subscribe ──────────────────────────────────────────
// Subscribe a device for push notifications.

router.post("/api/push/subscribe", requireAuth, (req, res) => {
  const { playerId } = req.user;
  const { subscription } = req.body ?? {};

  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: "Push subscription object is required" });
  }

  push.subscribe(playerId, subscription);
  return res.json({ ok: true });
});

// ── POST /api/push/unsubscribe ────────────────────────────────────────
// Unsubscribe a device from push notifications.

router.post("/api/push/unsubscribe", requireAuth, (req, res) => {
  const { playerId } = req.user;
  const { endpoint } = req.body ?? {};

  if (!endpoint) {
    return res.status(400).json({ error: "endpoint is required" });
  }

  if (endpoint === "all") {
    push.unsubscribeAll(playerId);
  } else {
    push.unsubscribe(playerId, endpoint);
  }
  return res.json({ ok: true });
});

// ── GET /api/push/status ──────────────────────────────────────────────
// Check if the authenticated player has push subscriptions.

router.get("/api/push/status", requireAuth, (req, res) => {
  const { playerId } = req.user;
  return res.json({ subscribed: push.isSubscribed(playerId) });
});

// ── GET /api/push/types ──────────────────────────────────────────────
// Returns all notification types with labels and descriptions.
// Unauthenticated — needed for the settings UI before login.

router.get("/api/push/types", (_req, res) => {
  return res.json({ types: push.NOTIFICATION_TYPES });
});

// ── GET /api/push/preferences ────────────────────────────────────────
// Returns the authenticated player's notification preferences.

router.get("/api/push/preferences", requireAuth, (req, res) => {
  const { playerId } = req.user;
  return res.json({ preferences: push.getPreferences(playerId) });
});

// ── POST /api/push/preferences ───────────────────────────────────────
// Update the authenticated player's notification preferences.

router.post("/api/push/preferences", requireAuth, (req, res) => {
  const { playerId } = req.user;
  const { preferences: prefs } = req.body ?? {};

  if (!prefs || typeof prefs !== "object") {
    return res.status(400).json({ error: "preferences object is required" });
  }

  push.setPreferences(playerId, prefs);
  return res.json({ ok: true, preferences: push.getPreferences(playerId) });
});

// ── POST /api/push/test ────────────────────────────────────────────────────
// Send a test push notification to the authenticated player.

router.post("/api/push/test", requireAuth, async (req, res) => {
  const { playerId } = req.user;
  const { type } = req.body ?? {};

  if (!push.isSubscribed(playerId)) {
    return res.status(400).json({ error: "No push subscription found" });
  }

  try {
    if (type === "chain") {
      // Simulate an urgent chain-breaking alert
      await push.sendToPlayer(playerId, {
        title: "🚨 CHAIN BREAKING!",
        body: "TEST — Chain 248 — 12s remaining! Attack now!",
        tag: "chain-alert-test",
        icon: "/icon-192.png",
        data: { type: "chain-alert" },
      }, null, { urgency: "high", TTL: 30 });
    } else {
      // Regular test notification
      await push.sendToPlayer(playerId, {
        title: "🎯 Target Called",
        body: "TEST — RussianRob called EnemyTarget [1]",
        tag: "test-notification",
        icon: "/icon-192.png",
        data: { type: "call" },
      });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error("[push] Test notification failed:", err.message);
    return res.status(500).json({ error: "Failed to send test notification" });
  }
});

export default router;
