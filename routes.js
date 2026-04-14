/**
 * REST API route definitions.
 */

import { Router } from "express";
import { readFileSync, existsSync } from "node:fs";
import axios from "axios";
import { verifyTornApiKey, issueToken, verifyToken, requireAuth } from "./auth.js";
import * as store from "./store.js";
import { getAllowedBroadcastRoles, updateFactionSettings } from "./store.js";
import { fetchFactionMembers, fetchFactionChain, fetchRankedWar, fetchFactionBasic, fetchRankedWarReport, fetchFactionAttacks } from "./torn-api.js";

/** Mask an API key for safe logging — shows only last 4 chars. */
const maskKey = (key) => key ? `****${String(key).slice(-4)}` : '****';
import { getHeatmap, resetHeatmap } from "./activity-heatmap.js";
import { getOcSpawnData } from "./oc-spawn.js";
import { getData as getNerveData, updateConfig as updateNerveConfig } from "./nerve-tracker.js";
import { hasXanaxSubscription, grantFactionAccess, getXanaxSubscription } from "./xanax-subscriptions.js";
import { startChainMonitor } from "./chain-monitor.js";
import * as push from "./push-notifications.js";
import { isFactionAllowed, getAllSubscriptions, getOwnerFactionId, getSubscriptionRejectionMessage } from "./subscription-manager.js";

const router = Router();

const CALL_EXPIRE_MS = parseInt(process.env.CALL_EXPIRE_MS, 10) || 5 * 60 * 1000; // 5 minutes
const DEAL_EXPIRE_MS = parseInt(process.env.DEAL_EXPIRE_MS, 10) || 15 * 60 * 1000; // 15 minutes (multi-hit deal)

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
    try { 
      client.res.write(payload); 
      if (typeof client.res.flush === "function") client.res.flush();
    } catch (_) { /* client gone */ }
  }
}

/**
 * Broadcast a full war state snapshot to all clients in a war room.
 * Called after any state mutation so connected clients get instant updates.
 */
/** Compute a fresh warEta using currently stored war scores/target — no API call needed. */
function computeFreshWarEta(war) {
  if (!war || war.warEnded) return war?.warEta || null;

  // Prefer a recent client-reported ETA (from war page DOM) — most accurate source
  // But not during pre-war phase (war hasn't started yet)
  const nowSec2 = Math.floor(Date.now() / 1000);
  const isPreWar = war.warStart && (war.warStart > nowSec2 || (!war.warScores || (war.warScores.myScore === 0 && war.warScores.enemyScore === 0)));
  const report = !isPreWar && war.clientTimerReport;
  if (report && report.etaTimestamp && (Date.now() - report.receivedAt) < 3 * 60 * 1000) {
    // Adjust for time elapsed since the report was received
    const msLeft = Math.max(0, report.etaTimestamp - Date.now());
    const hrsRemaining = msLeft / 3600000;
    return {
      etaTimestamp: report.etaTimestamp,
      hoursRemaining: Math.round(hrsRemaining * 100) / 100,
      currentTarget: war.warOrigTarget || null,
      calculatedAt: Date.now(),
      preDropPhase: false,
      source: 'client',
    };
  }

  // Pre-war phase: war has been announced but not yet started
  if (war.warStart) {
    const nowSec = Math.floor(Date.now() / 1000);
    const bothZero = !war.warScores || (war.warScores.myScore === 0 && war.warScores.enemyScore === 0);
    if (war.warStart > nowSec || bothZero) {
      return {
        etaTimestamp: war.warStart * 1000,
        hoursRemaining: Math.max(0, (war.warStart - nowSec) / 3600),
        currentTarget: war.warOrigTarget || null,
        calculatedAt: Date.now(),
        preWarPhase: true,
      };
    }
  }

  // Fallback: compute from stored scores/target
  if (!war.warScores || !war.warStart || !war.warOrigTarget) return war?.warEta || null;
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const elapsedHrs = (nowSec - war.warStart) / 3600;
    if (elapsedHrs < 24) {
      return { etaTimestamp: null, hoursRemaining: null, currentTarget: war.warOrigTarget, calculatedAt: Date.now(), preDropPhase: true };
    }
    const dropHrs = Math.max(0, Math.floor(elapsedHrs - 24));
    const currentTarget = Math.round(war.warOrigTarget * (1 - dropHrs * 0.01));
    const dropPerHour = war.warOrigTarget * 0.01;
    const lead = Math.max(war.warScores.myScore || 0, war.warScores.enemyScore || 0);
    const gap = currentTarget - lead;
    const hrsRemaining = dropPerHour > 0 ? Math.max(0, gap / dropPerHour) : 0;
    return { etaTimestamp: Date.now() + (hrsRemaining * 3600000), hoursRemaining: Math.round(hrsRemaining * 100) / 100, currentTarget, calculatedAt: Date.now(), preDropPhase: false };
  } catch (_) { return war?.warEta || null; }
}

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
    warScores: war.warScores || null,
    warEta: computeFreshWarEta(war),
    warEnded: war.warEnded || false,
    warResult: war.warResult || null,
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

// Chain alert push cooldowns moved to chain-monitor.js (server polls directly)

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
  const { apiKey } = (req.body || {});
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

  if (!isFactionAllowed(info.factionId)) {
    return res.status(403).json({ error: getSubscriptionRejectionMessage() });
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
 * Exempt: /api/*, gate.html, .meta.js, .user.js (Tampermonkey update checks).
 * The landing page requires a gate cookie.
 */
export function gateMiddleware(req, res, next) {
  // Always allow API routes, gate page, and .meta.js files (for update checks)
  if (
    req.path.startsWith("/api/") ||
    req.path.startsWith("/data/") ||
    req.path === "/gate.html" ||
    req.path.endsWith(".meta.js") || req.path.endsWith(".user.js")
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
  const { apiKey } = (req.body || {});
  if (!apiKey || typeof apiKey !== "string") {
    return res.status(400).json({ error: "apiKey is required" });
  }

  try {
    const info = await verifyTornApiKey(apiKey);

    // Faction lock — only the owner faction or subscribed factions can use the system
    if (!isFactionAllowed(info.factionId)) {
      console.log(`[auth] Rejected ${info.playerName} (${info.playerId}) — faction ${info.factionId} not subscribed`);
      return res.status(403).json({ error: getSubscriptionRejectionMessage() });
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

// ── GET /api/oc/spawn ───────────────────────────────────────────────────
// Returns pre-calculated OC spawn recommendation data for the faction
router.get("/api/oc/spawn", requireAuth, async (req, res) => {
  const factionId = req.user.factionId;
  const apiKey = store.getFactionApiKey(factionId) || store.getApiKeyForFaction(factionId);
  
  if (!apiKey) {
    return res.status(503).json({ error: "No API key available for this faction" });
  }

  try {
    const data = await getOcSpawnData(factionId, apiKey);
    return res.json(data);
  } catch (err) {
    console.error(`[api] /api/oc/spawn failed:`, err.message);
    return res.status(500).json({ error: "Failed to fetch OC data: " + err.message });
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

  // Send 1KB preamble to force browser to fire onprogress immediately
  res.write(": preamble " + ".".repeat(1024) + "\n\n");

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
    warScores: war.warScores || null,
    warEta: computeFreshWarEta(war),
    warEnded: war.warEnded || false,
    warResult: war.warResult || null,
  };
  res.write(`data: ${JSON.stringify(initial)}\n\n`);

  // Register this client for broadcasts
  const client = { res, playerId };
  addSSEClient(warId, client);
  console.log(`[sse] ${playerName} connected to stream for war ${warId}`);

  // Comment-based keep-alive every 5s to bypass browser buffering
  const keepAlive = setInterval(() => {
    try { 
      res.write(": keepalive " + ".".repeat(100) + "\n\n"); 
      if (typeof res.flush === "function") res.flush();
    } catch (_) {}
  }, 5000);

  // Heartbeat every 5s to keep connection alive
  const heartbeat = setInterval(() => {
    try { 
      res.write(`data: ${JSON.stringify({ type: "heartbeat", ts: Date.now() })}\n\n`);
      if (typeof res.flush === "function") res.flush();
    } catch (_) {}
  }, 5000);

  // Cleanup on disconnect
  req.on("close", () => {
    clearInterval(keepAlive);
    clearInterval(heartbeat);
    removeSSEClient(warId, client);
    
    // Check if they have other active sessions before removing from store
    const current = store.getPlayer(playerId);
    if (current?.socketId === `sse_${playerId}`) {
      store.removePlayerBySocket(`sse_${playerId}`);
    }
    
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

  // WIPE STALE WAR DATA if enemy faction ID changed (bug fix)
  if (enemyFactionId && war.enemyFactionId !== enemyFactionId) {
    console.log(`[api] War ${warId} enemy changed from ${war.enemyFactionId} to ${enemyFactionId}. Wiping stale state.`);
    war.enemyFactionId = enemyFactionId;
    war.enemyStatuses = {};
    war.calls = {};
    war.priorities = {};

    // Clear call timers for this war
    for (const [key, timeoutId] of callTimers.entries()) {
      if (key.startsWith(`${warId}:`)) {
        clearTimeout(timeoutId);
        callTimers.delete(key);
      }
    }

    store.saveState();
    broadcastWarUpdate(warId);
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

  // Server-side chain polling as fallback when no client is reporting chain data.
  // Only actually polls when no client has reported in the last 15 seconds.
  // Skip if war already ended.
  if (!war.warEnded) {
    startChainMonitor(null, warId);
  }

  // Track player as online - but DON'T overwrite an active real-time session with a "poll" status
  const existingPlayer = store.getPlayer(playerId);
  const isRealtime = existingPlayer?.socketId && (existingPlayer.socketId.startsWith("sse_") || !existingPlayer.socketId.startsWith("poll_"));
  
  if (!isRealtime) {
    store.setPlayer(playerId, {
      socketId: `poll_${playerId}`,
      factionId,
      warId,
      name: playerName,
    });
  }

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
    warScores: war.warScores || null,
    warEta: computeFreshWarEta(war),
    warEnded: war.warEnded || false,
    warResult: war.warResult || null,
    strategy: war.strategy || null,
    enemyActivityByHour: war.enemyActivityByHour || null,
  });
});

// ── GET /api/war/:warId/strategy ─────────────────────────────────────
// Returns the current strategy recommendation for a war.

router.get("/api/war/:warId/strategy", requireAuth, (req, res) => {
  const { warId } = req.params;
  const war = requireWarMember(req, res, warId);
  if (!war) {
    return war === null && !res.headersSent
      ? res.status(404).json({ error: "War not found" })
      : undefined;
  }

  return res.json({
    strategy: war.strategy || null,
    enemyActivityByHour: war.enemyActivityByHour || null,
  });
});

// ── POST /api/call ───────────────────────────────────────────────────────
// Call or uncall a target.

router.post("/api/call", requireAuth, (req, res) => {
  const { playerId, playerName } = req.user;
  const { action, targetId, targetName, warId, isDeal } = (req.body || {});

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

// ── POST /api/broadcast ──────────────────────────────────────────────────
// Faction Leaders/Bankers: Broadcast a message to their faction's war room.
// Update custom broadcast roles for the faction.
// Get custom broadcast roles for the faction.
router.get("/api/broadcast/roles", requireAuth, (req, res) => {
  const { factionId } = req.user;
  const roles = getAllowedBroadcastRoles(factionId);
  return res.json({ roles });
});

router.post("/api/broadcast/roles", requireAuth, (req, res) => {
  const { playerId, factionPosition, factionId } = req.user;
  const { roles } = (req.body || {});

  if (!Array.isArray(roles)) {
    return res.status(400).json({ error: "Roles must be an array of strings." });
  }

  const pos = (factionPosition || "").toLowerCase();
  const allowedBase = ["leader", "co-leader", "war leader"];
  const isLeader = allowedBase.includes(pos);
  const isGlobalAdmin = (String(playerId) === "137558");

  if (!isLeader && !isGlobalAdmin) {
    return res.status(403).json({ error: "Only leaders and co-leaders can update broadcast roles." });
  }

  updateFactionSettings(factionId, { broadcastRoles: roles });
  return res.json({ success: true, roles });
});

router.post("/api/broadcast", requireAuth, (req, res) => {
  const { playerId, playerName, factionPosition, factionId } = req.user;
  const { message, type, warId } = (req.body || {});

  if (!warId) {
    return res.status(400).json({ error: "warId is required for faction broadcasts." });
  }

  if (!message) {
    return res.status(400).json({ error: "Message is required." });
  }

  // Check if it's the global admin (can broadcast anywhere)
  const isGlobalAdmin = (String(playerId) === "137558");
  
  // Enforce leader/banker position (or custom faction roles)
  const pos = (factionPosition || "").toLowerCase();
  const allowedRoles = getAllowedBroadcastRoles(factionId);
  const isLeader = allowedRoles.includes(pos);

  if (!isLeader && !isGlobalAdmin) {
    console.log(`[⚠️] Blocked unauthorized broadcast attempt from player ${playerId} (${playerName}) - Role: ${pos}`);
    return res.status(403).json({ error: "Only leaders and bankers can broadcast to the faction." });
  }

  const payload = { 
    message: message, 
    type: type || "info" 
  };

  // 1. Broadcast to Socket.IO clients in this war room
  if (io) {
    io.to(`war_${warId}`).emit("global_toast", payload);
  }

  // 2. Broadcast to SSE clients in this war room
  broadcastSSE(warId, { type: "global_toast", ...payload });

  // 3. Send Push Notifications to subscribed faction members (offline/background)
  // Fetch full faction member list to reach offline users who have push enabled
  const apiKey = store.getFactionApiKey(factionId) || store.getApiKeyForFaction(factionId);
  if (apiKey) {
    fetchFactionMembers(factionId, apiKey).then(members => {
      const memberIds = Object.keys(members);
      push.notifyBroadcast(memberIds, warId, playerName, message);
    }).catch(err => {
      console.error(`[api] Failed to fetch members for broadcast push: ${err.message}`);
    });
  } else {
    // Fallback: just send to currently online/tracked players if no API key
    const onlinePlayers = store.getOnlinePlayersForWar(warId).map(p => p.id);
    push.notifyBroadcast(onlinePlayers, warId, playerName, message);
  }

  console.log(`[📣] Faction Broadcast sent to war ${warId} by ${playerName}: ${message}`);

  return res.json({ success: true });
});

// ── POST /api/priority ──────────────────────────────────────────────────
// Set or clear a priority tag on a target. Leader/co-leader only.

const LEADER_POSITIONS = ["leader", "co-leader", "war leader", "banker"];

router.post("/api/priority", requireAuth, (req, res) => {
  const { playerId, playerName, factionPosition } = req.user;
  const { targetId, priority, warId } = (req.body || {});

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

// Client-reported war timer (from war page DOM) — shared to all clients for accurate OC-tab countdown
router.post("/api/war-timer-report", requireAuth, (req, res) => {
  const { warId, etaTimestamp, calculatedAt } = (req.body || {});
  if (!warId || !etaTimestamp) return res.json({ ok: false });
  const war = store.getWar(warId);
  if (!war) return res.json({ ok: false });
  // Only accept reports that are in the future
  if (etaTimestamp <= Date.now()) return res.json({ ok: false });
  war.clientTimerReport = { etaTimestamp, calculatedAt, receivedAt: Date.now() };
  // Broadcast updated ETA to all clients in this war room
  broadcastWarUpdate(warId);
  return res.json({ ok: true });
});

router.post("/api/war-target", requireAuth, (req, res) => {
  const { playerId, playerName, factionPosition } = req.user;
  const { warId, target } = (req.body || {});

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
  const { warId, lead } = (req.body || {});

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
  const { apiKey } = (req.body || {});

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
  console.log(`[api] Faction API key saved for faction ${factionId} (key: ${maskKey(apiKey)})`);
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
  const { warId, statuses, chainData, refresh } = (req.body || {});

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

  // Chain data update from client (for display sync only — push alerts handled by server chain monitor)
  if (chainData && typeof chainData === "object") {
    war.chainData = { ...war.chainData, ...chainData };
    store.saveState();
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
  const { targetId } = (req.body || {});
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
  const factionId = req.query.factionId || req.user.factionId;
  return res.json({ heatmap: getHeatmap(factionId) });
});

// ── DELETE /api/heatmap ──────────────────────────────────────────────────
// Reset the activity heatmap for the faction. Leader/co-leader only.

function handleResetHeatmap(req, res) {
  const { factionId, factionPosition } = req.user;
  const targetFactionId = req.query.factionId || req.body?.factionId || factionId;

  const pos = (factionPosition || "").toLowerCase();
  if (!LEADER_POSITIONS.includes(pos)) {
    return res.status(403).json({ error: "Only leaders and co-leaders can reset the heatmap" });
  }

  // Only allow resetting your own faction OR your current enemy faction
  if (String(targetFactionId) !== String(factionId)) {
      const activeWars = Array.from(store.getAllWars().values()).filter(w => String(w.factionId) === String(factionId));
      const isEnemy = activeWars.some(w => String(w.enemyFactionId) === String(targetFactionId));
      if (!isEnemy) {
          return res.status(403).json({ error: "You can only reset your own faction's heatmap or your current enemy's heatmap." });
      }
  }

  resetHeatmap(targetFactionId);
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
  const { subscription } = (req.body || {});

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
  const { endpoint } = (req.body || {});

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
  const { preferences: prefs } = (req.body || {});

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
  const { type } = (req.body || {});

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

// ── GET /api/admin/subscriptions ─────────────────────────────────────

router.get("/api/admin/subscriptions", requireAuth, (req, res) => {
  // Only allow members of the owner faction
  if (req.user.factionId !== getOwnerFactionId()) {
    return res.status(403).json({ error: "Admin access restricted to owner faction" });
  }

  const subscriptions = getAllSubscriptions();
  return res.json({
    ownerFactionId: getOwnerFactionId(),
    subscriptions,
  });
});


// ── GET /api/admin/pm2-logs ─────────────────────────────────────────

router.get("/api/admin/pm2-logs", requireAuth, (req, res) => {
  if (req.user.playerId !== "137558") {
    return res.status(403).json({ error: "Unauthorized access. This endpoint is restricted." });
  }

  const outLogPath = "/root/.pm2/logs/warboard-out.log";
  const errLogPath = "/root/.pm2/logs/warboard-error.log";

  // Mask any API keys that appear in logs (16-char alphanumeric Torn API keys)
  const scrubKeys = (text) => text.replace(/\b([A-Za-z0-9]{12,20})\b/g, (match) => {
    // Only mask strings that look like API keys (mixed case alphanum, no spaces)
    if (/^[A-Za-z0-9]{16}$/.test(match)) return maskKey(match);
    return match;
  });

  const readLastLines = (filePath, linesCount = 200) => {
    if (!existsSync(filePath)) return `[Log file not found: ${filePath}]`;
    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      const relevantLines = lines.slice(-linesCount);

      const timeFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
      });

      return scrubKeys(relevantLines.map(line => {
        const match = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00):\s(.*)/);
        if (match) {
          try {
            const d = new Date(match[1]);
            return `EST ${timeFormatter.format(d)}: ${match[2]}`;
          } catch(e) {}
        }
        return line;
      }).join("\n"));
    } catch (err) {
      return `[Error reading ${filePath}: ${err.message}]`;
    }
  };

  return res.json({
    out: readLastLines(outLogPath),
    err: readLastLines(errLogPath),
    timestamp: Date.now(),
  });
});

// ── GET /api/war/:warId/scout-report ──────────────────────────────────
// Generate a pre-war intelligence report about the enemy faction.

/** Format a raw battle-stats number into compact human string. */
function formatStatNum(n) {
  if (n == null || isNaN(n)) return "—";
  if (n >= 1e12) return (n / 1e12).toFixed(2) + "T";
  if (n >= 1e9)  return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6)  return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3)  return (n / 1e3).toFixed(0) + "K";
  return String(Math.round(n));
}

/** Analyze a single faction's basic data into structured info. */
function analyzeFaction(data, estimates) {
  const members = data.members || {};
  const memberList = Object.entries(members).map(([id, m]) => ({ id, ...m }));
  const memberCount = memberList.length;
  const now = Math.floor(Date.now() / 1000);

  // ── Overview ──
  const overview = {
    name: data.name || "Unknown",
    age: data.age || 0,
    respect: data.respect || 0,
    bestChain: data.best_chain || 0,
    memberCount,
  };

  // ── Level distribution ──
  const levelRanges = [
    { label: "1-15", min: 1, max: 15, count: 0 },
    { label: "16-30", min: 16, max: 30, count: 0 },
    { label: "31-50", min: 31, max: 50, count: 0 },
    { label: "51-75", min: 51, max: 75, count: 0 },
    { label: "76-100", min: 76, max: 100, count: 0 },
  ];
  let totalLevel = 0;
  for (const m of memberList) {
    const lvl = m.level || 0;
    totalLevel += lvl;
    for (const r of levelRanges) {
      if (lvl >= r.min && lvl <= r.max) { r.count++; break; }
    }
  }
  const avgLevel = memberCount > 0 ? Math.round((totalLevel / memberCount) * 10) / 10 : 0;

  // Threat tier
  let threatTier = "Low";
  if (avgLevel >= 70 || overview.respect >= 50000000) threatTier = "Critical";
  else if (avgLevel >= 50 || overview.respect >= 10000000) threatTier = "High";
  else if (avgLevel >= 30 || overview.respect >= 1000000) threatTier = "Medium";

  // ── Activity ──
  let onlineCount = 0, idleCount = 0, offlineCount = 0;
  const actionBuckets = { "5min": 0, "30min": 0, "1hr": 0, "1day": 0, "1week+": 0 };
  let activeCombatRoster = 0;

  for (const m of memberList) {
    const activity = (m.last_action?.status || "Offline").toLowerCase();
    if (activity === "online") onlineCount++;
    else if (activity === "idle") idleCount++;
    else offlineCount++;

    const ts = m.last_action?.timestamp || 0;
    let secsAgo = ts > 0 ? Math.max(0, now - ts) : Infinity;

    if (secsAgo <= 300) actionBuckets["5min"]++;
    else if (secsAgo <= 1800) actionBuckets["30min"]++;
    else if (secsAgo <= 3600) actionBuckets["1hr"]++;
    else if (secsAgo <= 86400) actionBuckets["1day"]++;
    else actionBuckets["1week+"]++;

    const statusState = (m.status?.state || "Okay").toLowerCase();
    const isUnavailable = ["hospital", "jail", "traveling", "abroad"].includes(statusState);
    if (!isUnavailable && secsAgo <= 1800) {
      activeCombatRoster++;
    }
  }

  // ── Vulnerability ──
  const hospitalized = [];
  const jailed = [];
  const traveling = [];
  const inactive = [];

  for (const m of memberList) {
    const statusState = (m.status?.state || "Okay").toLowerCase();
    const untilTs = m.status?.until || 0;
    const remaining = untilTs > 0 ? Math.max(0, untilTs - now) : 0;
    const ts = m.last_action?.timestamp || 0;
    const secsAgo = ts > 0 ? Math.max(0, now - ts) : Infinity;

    const info = { id: m.id, name: m.name, level: m.level };

    if (statusState === "hospital") {
      hospitalized.push({ ...info, remaining, description: m.status?.description || "" });
    } else if (statusState === "jail") {
      jailed.push({ ...info, remaining, description: m.status?.description || "" });
    } else if (statusState === "traveling" || statusState === "abroad") {
      traveling.push({ ...info, description: m.status?.description || "" });
    }

    if (secsAgo > 86400) {
      inactive.push({ ...info, lastActionAgo: secsAgo });
    }
  }

  hospitalized.sort((a, b) => b.remaining - a.remaining);
  inactive.sort((a, b) => b.lastActionAgo - a.lastActionAgo);

  // ── Composition ──
  let newMembers = 0, veterans = 0, totalDays = 0;
  for (const m of memberList) {
    const dif = m.days_in_faction || 0;
    totalDays += dif;
    if (dif < 30) newMembers++;
    if (dif > 365) veterans++;
  }
  const avgDaysInFaction = memberCount > 0 ? Math.round(totalDays / memberCount) : 0;

  const likelyLeadership = [...memberList]
    .sort((a, b) => (b.level || 0) - (a.level || 0))
    .slice(0, 5)
    .map(m => ({ id: m.id, name: m.name, level: m.level, daysInFaction: m.days_in_faction || 0 }));

  // ── Members with stat estimates ──
  const rankedMembers = memberList.map(m => {
    const est = estimates && estimates[m.id];
    const statusState = (m.status?.state || "Okay").toLowerCase();
    const ts = m.last_action?.timestamp || 0;
    const secsAgo = ts > 0 ? Math.max(0, now - ts) : Infinity;
    
    // isAvailable means they can be attacked RIGHT NOW
    const isUnavailable = ["hospital", "jail", "traveling", "abroad"].includes(statusState);
    const isAvailable = !isUnavailable; 
    
    // isActive means they play the game actively (logged in recently). 
    // We shouldn't exclude them from tactical analysis just because they are currently asleep or traveling.
    // Let's define active as having logged in within the last 72 hours.
    const isActive = secsAgo <= (3 * 24 * 3600);
    return {
      id: m.id,
      name: m.name,
      level: m.level || 0,
      stats: est ? est.total : null,
      statsFormatted: est ? formatStatNum(est.total) : null,
      source: est ? est.source : null,
      statusState,
      isActive,
      isAvailable,
    };
  });

  // Sort by stats (if available) then level
  rankedMembers.sort((a, b) => {
    if (a.stats != null && b.stats != null) return b.stats - a.stats;
    if (a.stats != null) return -1;
    if (b.stats != null) return 1;
    return b.level - a.level;
  });

  // ── Strengths / Weaknesses ──
  const strengths = [];
  const weaknesses = [];

  if (avgLevel >= 50) strengths.push("High average level (" + avgLevel + ")");
  if (overview.bestChain >= 1000) strengths.push("Strong chain capability (best: " + overview.bestChain.toLocaleString() + ")");
  if (veterans > memberCount * 0.5) strengths.push("Experienced roster (" + veterans + " veterans)");
  if (activeCombatRoster >= 10) strengths.push("Large active combat roster (" + activeCombatRoster + " ready)");
  if (rankedMembers[0]?.stats >= 5e9) strengths.push("Elite top-end (" + rankedMembers[0].statsFormatted + ")");

  if (avgLevel < 30) weaknesses.push("Low average level (" + avgLevel + ")");
  if (newMembers > memberCount * 0.3) weaknesses.push("Many new members (" + newMembers + " under 30 days)");
  if (inactive.length > memberCount * 0.3) weaknesses.push("High inactivity (" + inactive.length + " inactive 24h+)");
  if (hospitalized.length > 5) weaknesses.push(hospitalized.length + " members currently hospitalized");
  if (activeCombatRoster < 5) weaknesses.push("Small active combat roster (only " + activeCombatRoster + " ready)");

  return {
    overview,
    strength: { levelDistribution: levelRanges, avgLevel, threatTier },
    activityPatterns: { online: onlineCount, idle: idleCount, offline: offlineCount, lastAction: actionBuckets, activeCombatRoster },
    vulnerabilities: { hospitalized, jailed, traveling, inactive },
    composition: { newMembers, veterans, avgDaysInFaction, likelyLeadership },
    strengths,
    weaknesses,
    rankedMembers,
  };
}

/** Assign stat tier based on estimated stats (or level as proxy). */
function getStatTier(stats, level, hasEstimates) {
  if (hasEstimates && stats != null) {
    if (stats >= 5e9)  return "S";
    if (stats >= 1e9)  return "A";
    if (stats >= 250e6) return "B";
    if (stats >= 50e6)  return "C";
    return "D";
  }
  // Level-based fallback
  if (level >= 90) return "S";
  if (level >= 70) return "A";
  if (level >= 50) return "B";
  if (level >= 30) return "C";
  return "D";
}

/** Full ranked war analysis — compares both factions with stat estimates. */
function analyzeWarReport(ourData, enemyData, estimates, warScores) {
  estimates = estimates || {};

  const ourAnalysis = analyzeFaction(ourData, estimates);
  const enemyAnalysis = analyzeFaction(enemyData, estimates);

  const hasEstimates = ourAnalysis.rankedMembers.some(m => m.stats != null)
    || enemyAnalysis.rankedMembers.some(m => m.stats != null);

  // ── A. War Overview ──
  const warOverview = {
    our: ourAnalysis.overview,
    enemy: enemyAnalysis.overview,
    hasEstimates,
  };

  // ── B. Top-End Comparison (top 10 each) ──
  // Sort ALL active members strictly by stats/level, regardless of whether they are currently in hospital/traveling
  const ourTop = ourAnalysis.rankedMembers
    .filter(m => m.isActive)
    .sort((a, b) => (b.stats || b.level * 10e6) - (a.stats || a.level * 10e6))
    .slice(0, 10);
  
  const enemyTop = enemyAnalysis.rankedMembers
    .filter(m => m.isActive)
    .sort((a, b) => (b.stats || b.level * 10e6) - (a.stats || a.level * 10e6))
    .slice(0, 10);

  const matchups = [];
  for (let i = 0; i < Math.max(ourTop.length, enemyTop.length, 10); i++) {
    const ours = ourTop[i] || null;
    const theirs = enemyTop[i] || null;
    let advantage = "even";
    if (ours && theirs) {
      if (ours.stats != null && theirs.stats != null) {
        if (ours.stats > theirs.stats * 1.15) advantage = "ours";
        else if (theirs.stats > ours.stats * 1.15) advantage = "theirs";
      } else {
        if (ours.level > theirs.level + 5) advantage = "ours";
        else if (theirs.level > ours.level + 5) advantage = "theirs";
      }
    } else if (ours && !theirs) {
      advantage = "ours";
    } else if (!ours && theirs) {
      advantage = "theirs";
    }
    matchups.push({ rank: i + 1, ours, theirs, advantage });
  }

  const topEnd = { ourTop, enemyTop, matchups };

  // ── C. Stat Tier Breakdown ──
  const tierLabels = ["S", "A", "B", "C", "D"];
  const tierDescriptions = hasEstimates
    ? { S: "5B+ (elite)", A: "1B–5B (strong)", B: "250M–1B (solid)", C: "50M–250M (filler)", D: "<50M (non-threat)" }
    : { S: "Lv90+ (elite)", A: "Lv70–89 (strong)", B: "Lv50–69 (solid)", C: "Lv30–49 (filler)", D: "Lv<30 (non-threat)" };

  const ourTiers = { S: 0, A: 0, B: 0, C: 0, D: 0 };
  const enemyTiers = { S: 0, A: 0, B: 0, C: 0, D: 0 };

  for (const m of ourAnalysis.rankedMembers) {
    ourTiers[getStatTier(m.stats, m.level, hasEstimates)]++;
  }
  for (const m of enemyAnalysis.rankedMembers) {
    enemyTiers[getStatTier(m.stats, m.level, hasEstimates)]++;
  }

  const statTiers = { labels: tierLabels, descriptions: tierDescriptions, our: ourTiers, enemy: enemyTiers, hasEstimates };

  // ── D. Safe Hit Thresholds ──
  const thresholds = [
    { label: "1B+", min: 1e9, safeTarget: Infinity, desc: "Any enemy" },
    { label: "500M–1B", min: 500e6, safeTarget: 600e6, desc: "Enemies ≤600M" },
    { label: "350M–500M", min: 350e6, safeTarget: 400e6, desc: "Enemies ≤400M" },
    { label: "250M–350M", min: 250e6, safeTarget: 300e6, desc: "Enemies ≤300M" },
    { label: "<250M", min: 0, safeTarget: 0, desc: "Assists/cleanup only" },
  ];

  // Count our members in each bracket
  const safeHitData = thresholds.map(t => {
    const ourCount = ourAnalysis.rankedMembers.filter(m => {
      const s = m.stats != null ? m.stats : m.level * 10e6; // rough proxy
      return s >= t.min && (t.min === 0 || s < (thresholds[thresholds.indexOf(t) - 1]?.min || Infinity));
    }).length;
    const enemyFarmable = t.safeTarget === Infinity
      ? enemyAnalysis.rankedMembers.length
      : t.safeTarget === 0
        ? 0
        : enemyAnalysis.rankedMembers.filter(m => {
            const s = m.stats != null ? m.stats : m.level * 10e6;
            return s <= t.safeTarget;
          }).length;
    return { ...t, ourCount, enemyFarmable };
  });

  // Total safely hittable: our members with 250M+ can hit, compute % farmable
  const ourCanHit = ourAnalysis.rankedMembers.filter(m => {
    const s = m.stats != null ? m.stats : m.level * 10e6;
    return s >= 250e6;
  }).length;
  const ourTotal = ourAnalysis.rankedMembers.length;
  const enemyFarmable = enemyAnalysis.rankedMembers.filter(m => {
    const s = m.stats != null ? m.stats : m.level * 10e6;
    return s <= 600e6;
  }).length;
  const enemyTotal = enemyAnalysis.rankedMembers.length;

  const safeHits = {
    thresholds: safeHitData,
    ourCanHitPct: ourTotal > 0 ? Math.round((ourCanHit / ourTotal) * 100) : 0,
    enemyFarmablePct: enemyTotal > 0 ? Math.round((enemyFarmable / enemyTotal) * 100) : 0,
    hasEstimates,
  };

  // ── E. Activity & Availability ──
  const activity = {
    our: ourAnalysis.activityPatterns,
    enemy: enemyAnalysis.activityPatterns,
  };

  // ── F. Faction Composition ──
  const composition = {
    our: ourAnalysis.composition,
    enemy: enemyAnalysis.composition,
  };

  // ── G. Tactical Battle Plan ──
  const enemyWeak = enemyAnalysis.rankedMembers
    .filter(m => m.isActive && (m.stats != null ? m.stats < 250e6 : m.level < 50))
    .sort((a, b) => (a.stats || a.level * 10e6) - (b.stats || b.level * 10e6))
    .slice(0, 10);
  const enemyMid = enemyAnalysis.rankedMembers
    .filter(m => m.isActive && (m.stats != null ? (m.stats >= 250e6 && m.stats < 1e9) : (m.level >= 50 && m.level < 75)))
    .sort((a, b) => (a.stats || a.level * 10e6) - (b.stats || b.level * 10e6))
    .slice(0, 10);
  const enemyThreats = enemyAnalysis.rankedMembers
    .filter(m => m.isActive && (m.stats != null ? m.stats >= 1e9 : m.level >= 75))
    .sort((a, b) => (b.stats || b.level * 10e6) - (a.stats || a.level * 10e6))
    .slice(0, 10);
  const enemyIgnore = enemyAnalysis.rankedMembers
    .filter(m => !m.isActive)
    .slice(0, 15);

  const ourChainers = ourAnalysis.rankedMembers
    .filter(m => m.isActive && (m.stats != null ? m.stats < 500e6 : m.level < 60))
    .sort((a, b) => (a.stats || a.level * 10e6) - (b.stats || b.level * 10e6))
    .slice(0, 10);
  const ourHitters = ourAnalysis.rankedMembers
    .filter(m => m.isActive && (m.stats != null ? m.stats >= 250e6 : m.level >= 50))
    .sort((a, b) => (b.stats || b.level * 10e6) - (a.stats || a.level * 10e6))
    .slice(0, 15);

  // Detect war phase from scores
  const totalScore = warScores ? (warScores.myScore || 0) + (warScores.enemyScore || 0) : 0;
  const warStarted = totalScore > 0;
  const warPhase = !warStarted ? "pre" : totalScore < 200 ? "opening" : totalScore < 1000 ? "mid" : "late";

  const battlePlan = {
    warPhase,
    warStarted,
    opening: {
      description: warPhase === "pre"
        ? "When war starts: farm their weakest active members to build chain. Focus on quick, safe hits."
        : "Farm their weakest active members to build chain. Focus on quick, safe hits.",
      chainTargets: enemyWeak,
      ourChainers,
    },
    midWar: {
      description: warPhase === "pre"
        ? "After building chain: target mid-tier enemies to perma-hospital them. Rotate hitters to stay rested."
        : "Target mid-tier enemies to perma-hospital them. Rotate hitters to stay rested.",
      permaTargets: enemyMid,
    },
    endgame: {
      description: warPhase === "pre"
        ? "To close the war: deploy top hitters against their strongest threats. Coordinate attacks."
        : "Deploy top hitters against their strongest active threats. Coordinate attacks.",
      enemyThreats,
      ourHitters,
    },
    ignore: enemyIgnore,
    keyPermaTargets: enemyAnalysis.rankedMembers
      .filter(m => m.isActive)
      .sort((a, b) => (b.stats || b.level * 10e6) - (a.stats || a.level * 10e6))
      .slice(0, 5),
  };

  // ── Win probability ──
  let winScore = 50;
  // Member advantage
  const ourMemberCount = ourAnalysis.overview.memberCount;
  const enemyMemberCount = enemyAnalysis.overview.memberCount;
  if (ourMemberCount > enemyMemberCount * 1.2) winScore += 5;
  else if (enemyMemberCount > ourMemberCount * 1.2) winScore -= 5;
  // Level advantage
  if (ourAnalysis.strength.avgLevel > enemyAnalysis.strength.avgLevel + 10) winScore += 10;
  else if (enemyAnalysis.strength.avgLevel > ourAnalysis.strength.avgLevel + 10) winScore -= 10;
  else if (ourAnalysis.strength.avgLevel > enemyAnalysis.strength.avgLevel + 3) winScore += 5;
  else if (enemyAnalysis.strength.avgLevel > ourAnalysis.strength.avgLevel + 3) winScore -= 5;
  // Active roster
  if (ourAnalysis.activityPatterns.activeCombatRoster > enemyAnalysis.activityPatterns.activeCombatRoster * 1.5) winScore += 10;
  else if (enemyAnalysis.activityPatterns.activeCombatRoster > ourAnalysis.activityPatterns.activeCombatRoster * 1.5) winScore -= 10;
  // Stat tier advantage
  if (ourTiers.S > enemyTiers.S) winScore += 8;
  else if (enemyTiers.S > ourTiers.S) winScore -= 8;
  if (ourTiers.A > enemyTiers.A) winScore += 5;
  else if (enemyTiers.A > ourTiers.A) winScore -= 5;
  // Chain capability
  if (ourAnalysis.overview.bestChain > enemyAnalysis.overview.bestChain * 1.5) winScore += 5;
  else if (enemyAnalysis.overview.bestChain > ourAnalysis.overview.bestChain * 1.5) winScore -= 5;
  // Enemy vulnerabilities
  const enemyHospPct = enemyMemberCount > 0 ? enemyAnalysis.vulnerabilities.hospitalized.length / enemyMemberCount : 0;
  if (enemyHospPct > 0.3) winScore += 8;
  else if (enemyHospPct > 0.15) winScore += 4;

  winScore = Math.max(5, Math.min(95, winScore));

  let winReasoning = [];
  if (winScore >= 70) winReasoning.push("Strong overall advantage");
  else if (winScore <= 30) winReasoning.push("Significant disadvantage — careful coordination needed");
  else winReasoning.push("Competitive matchup — execution matters");

  if (ourTiers.S > enemyTiers.S) winReasoning.push("Top-end advantage (" + ourTiers.S + " vs " + enemyTiers.S + " S-tier)");
  else if (enemyTiers.S > ourTiers.S) winReasoning.push("Enemy has top-end advantage (" + enemyTiers.S + " vs " + ourTiers.S + " S-tier)");
  if (ourAnalysis.activityPatterns.activeCombatRoster > enemyAnalysis.activityPatterns.activeCombatRoster)
    winReasoning.push("More active fighters (" + ourAnalysis.activityPatterns.activeCombatRoster + " vs " + enemyAnalysis.activityPatterns.activeCombatRoster + ")");

  // ── H. Strengths & Weaknesses ──
  const strengthsWeaknesses = {
    our: { strengths: ourAnalysis.strengths, weaknesses: ourAnalysis.weaknesses },
    enemy: { strengths: enemyAnalysis.strengths, weaknesses: enemyAnalysis.weaknesses },
  };

  return {
    warOverview,
    topEnd,
    statTiers,
    safeHits,
    activity,
    composition,
    battlePlan,
    winProbability: winScore,
    winReasoning,
    strengthsWeaknesses,
    enemyVulnerabilities: enemyAnalysis.vulnerabilities,
    generatedAt: Date.now(),
  };
}

/** Track scout report cooldowns per war to prevent API spam. */
const scoutReportCooldowns = new Map();
const SCOUT_REPORT_COOLDOWN_MS = 60000; // 1 minute between requests per war

/** Shared handler for scout/war report generation (GET and POST). */
async function handleWarReport(req, res) {
  const { factionId } = req.user;
  const { warId } = req.params;

  const war = requireWarMember(req, res, warId);
  if (!war) {
    return war === null && !res.headersSent
      ? res.status(404).json({ error: "War not found" })
      : undefined;
  }

  if (!war.enemyFactionId) {
    return res.status(400).json({ error: "No enemy faction configured for this war" });
  }

  // Cooldown check
  const lastReport = scoutReportCooldowns.get(warId) || 0;
  const elapsed = Date.now() - lastReport;
  if (elapsed < SCOUT_REPORT_COOLDOWN_MS) {
    const waitSec = Math.ceil((SCOUT_REPORT_COOLDOWN_MS - elapsed) / 1000);
    return res.status(429).json({ error: `Please wait ${waitSec}s before requesting another scout report` });
  }

  const apiKey = store.getFactionApiKey(factionId) || store.getApiKeyForFaction(factionId);
  if (!apiKey) {
    return res.status(503).json({ error: "No API key available — set a faction API key in settings" });
  }

  // Accept estimates from POST body
  const estimates = (req.body && req.body.estimates) || {};

  try {
    scoutReportCooldowns.set(warId, Date.now());
    const [ourData, enemyData] = await Promise.all([
      fetchFactionBasic(war.factionId, apiKey),
      fetchFactionBasic(war.enemyFactionId, apiKey),
    ]);
    const warScores = war.warScores || null;
    const report = analyzeWarReport(ourData, enemyData, estimates, warScores);
    console.log(`[scout] Generated war report for war ${warId} (us: ${war.factionId}, enemy: ${war.enemyFactionId})`);
    return res.json({ report });
  } catch (err) {
    console.error("[scout] War report failed:", err.message);
    return res.status(502).json({ error: `Failed to generate war report: ${err.message}` });
  }
}

router.get("/api/war/:warId/scout-report", requireAuth, handleWarReport);
router.post("/api/war/:warId/scout-report", requireAuth, handleWarReport);

// ── GET/POST /api/war/:warId/post-war-report ─────────────────────────
// Generate a post-war performance analysis report.

/** Track post-war report cooldowns per war. */
const postWarReportCooldowns = new Map();
const POST_WAR_REPORT_COOLDOWN_MS = 60000;

/** Analyze ranked war report data into a structured post-war performance breakdown. */
function analyzePostWarReport(warReportData, estimates, attackLog) {
  estimates = estimates || {};
  const report = warReportData || {};

  // Extract war-level data
  // v2 API returns factions as an array of objects with 'id' field, members as arrays
  const rawFactions = Array.isArray(report.factions) ? report.factions : Object.values(report.factions || {});
  const warId = report.id || null;
  const warStart = report.start || 0;
  const warEnd = report.end || 0;
  const warWinner = report.winner || 0;
  const warForfeit = report.forfeit || false;

  // Identify our faction (42055) vs enemy
  let ourFaction = rawFactions[0] || {};
  let enemyFaction = rawFactions[1] || {};
  // Try to match by known faction ID
  const ownerFactionId = process.env.OWNER_FACTION_ID || "42055";
  for (const f of rawFactions) {
    if (String(f.id) === ownerFactionId) {
      ourFaction = f;
      enemyFaction = rawFactions.find(x => x !== f) || rawFactions[1] || {};
      break;
    }
  }

  const ourScore = ourFaction.score || 0;
  const enemyScore = enemyFaction.score || 0;
  const ourName = ourFaction.name || "Our Faction";
  const enemyName = enemyFaction.name || "Enemy Faction";
  const ourRank = ourFaction.rank || {};
  const enemyRank = enemyFaction.rank || {};
  const ourRewards = ourFaction.rewards || {};
  const enemyRewards = enemyFaction.rewards || {};

  // v2 returns members as an array — convert to object keyed by id
  const ourMembersRaw = Array.isArray(ourFaction.members) ? ourFaction.members : Object.values(ourFaction.members || {});
  const enemyMembersRaw = Array.isArray(enemyFaction.members) ? enemyFaction.members : Object.values(enemyFaction.members || {});
  const ourMembers = {};
  for (const m of ourMembersRaw) ourMembers[m.id || m.name] = m;
  const enemyMembers = {};
  for (const m of enemyMembersRaw) enemyMembers[m.id || m.name] = m;

  // ── Bleed analysis from attack log ──
  // Calculate how much respect each of our members gave away by being attacked
  attackLog = attackLog || [];
  const bleedByMember = {}; // our member ID -> { timesAttacked, respectBled }
  const ourFactionId_str = String(ourFaction.id || "");
  for (const atk of attackLog) {
    // Enemy attacked one of our members
    if (String(atk.defender_faction) === ourFactionId_str && String(atk.attacker_faction) !== ourFactionId_str) {
      const defId = String(atk.defender_id);
      if (!bleedByMember[defId]) bleedByMember[defId] = { timesAttacked: 0, respectBled: 0 };
      bleedByMember[defId].timesAttacked++;
      bleedByMember[defId].respectBled += (atk.respect_gain || atk.respect || 0);
    }
  }
  const hasBleedData = attackLog.length > 0;

  // Build member performance arrays
  // v2 API returns 'score' per member which IS the respect/score contribution
  // There's no separate 'respect' field — score is used for both
  const ourMemberList = Object.entries(ourMembers).map(([id, m]) => {
    const bleed = bleedByMember[id] || { timesAttacked: 0, respectBled: 0 };
    return {
      id,
      name: m.name || "Unknown",
      level: m.level || 0,
      hits: (m.attacks || 0) + (m.assists || 0),
      attacks: m.attacks || 0,
      assists: m.assists || 0,
      respect: m.score || m.respect || 0,
      score: m.score || 0,
      timesAttacked: bleed.timesAttacked,
      respectBled: Math.round(bleed.respectBled * 100) / 100,
    };
  });

  const enemyMemberList = Object.entries(enemyMembers).map(([id, m]) => ({
    id,
    name: m.name || "Unknown",
    level: m.level || 0,
    hits: (m.attacks || 0) + (m.assists || 0),
    attacks: m.attacks || 0,
    assists: m.assists || 0,
    respect: m.score || m.respect || 0,
    score: m.score || 0,
  }));

  // ── A. WAR SUMMARY ──
  const totalOurHits = ourMemberList.reduce((s, m) => s + m.attacks, 0);
  const totalEnemyHits = enemyMemberList.reduce((s, m) => s + m.attacks, 0);
  const totalRespect = ourMemberList.reduce((s, m) => s + m.respect, 0);
  const winner = warWinner ? String(warWinner) : null;
  const ourFactionId = String(ourFaction.id || "");
  const weWon = winner === ourFactionId;
  const warResult = warForfeit ? (weWon ? "VICTORY (Forfeit)" : "DEFEAT (Forfeit)") : winner ? (weWon ? "VICTORY" : "DEFEAT") : "UNKNOWN";

  const startTs = warStart || 0;
  const endTs = warEnd || 0;
  const durationSec = startTs && endTs ? endTs - startTs : 0;

  const warSummary = {
    ourName,
    enemyName,
    ourScore,
    enemyScore,
    result: warResult,
    totalOurHits,
    totalEnemyHits,
    totalRespect,
    duration: durationSec,
    durationFormatted: durationSec > 0 ? formatWarDuration(durationSec) : null,
  };

  // ── B. OVERALL FACTION PERFORMANCE ──
  const totalRoster = ourMemberList.length;
  const participatingMembers = ourMemberList.filter(m => m.attacks > 0);
  const participationCount = participatingMembers.length;
  const participationRate = totalRoster > 0 ? Math.round((participationCount / totalRoster) * 100) : 0;
  const avgHitsPerMember = participationCount > 0 ? Math.round((totalOurHits / participationCount) * 10) / 10 : 0;
  const avgRespectPerHit = totalOurHits > 0 ? Math.round((totalRespect / totalOurHits) * 100) / 100 : 0;

  // Fair fight average from estimates if available
  let avgFairFight = null;
  const ffValues = [];
  for (const m of ourMemberList) {
    const est = estimates[m.id];
    if (est && est.ff != null) ffValues.push(est.ff);
  }
  if (ffValues.length > 0) avgFairFight = Math.round((ffValues.reduce((a, b) => a + b, 0) / ffValues.length) * 100) / 100;

  // Efficiency rating: 0-100 based on participation, respect/hit, score
  let efficiencyRating = 0;
  if (participationRate >= 80) efficiencyRating += 30;
  else if (participationRate >= 60) efficiencyRating += 20;
  else if (participationRate >= 40) efficiencyRating += 10;
  if (avgRespectPerHit >= 5) efficiencyRating += 30;
  else if (avgRespectPerHit >= 3) efficiencyRating += 20;
  else if (avgRespectPerHit >= 1) efficiencyRating += 10;
  if (weWon) efficiencyRating += 40;
  else if (ourScore > enemyScore * 0.8) efficiencyRating += 20;
  efficiencyRating = Math.min(100, efficiencyRating);

  const factionPerformance = {
    totalRoster,
    participationCount,
    participationRate,
    avgHitsPerMember,
    avgRespectPerHit,
    avgFairFight,
    efficiencyRating,
  };

  // ── C. ENERGY EFFICIENCY ANALYSIS ──
  const energyAnalysis = [];
  const factionAvgRph = avgRespectPerHit;

  for (const m of ourMemberList) {
    if (m.attacks === 0) continue;
    const rph = m.attacks > 0 ? Math.round((m.respect / m.attacks) * 100) / 100 : 0;
    const estEnergy = m.attacks * 25;
    const rphRatio = factionAvgRph > 0 ? rph / factionAvgRph : 1;
    const isBelowThreshold = rphRatio < 0.5;
    const wastedEnergy = isBelowThreshold ? Math.round((factionAvgRph - rph) * m.attacks * 25) : 0;
    // Net Score = score earned - respect bled to enemy
    // This is the TRUE contribution: what you earned minus what you gave away
    const netScore = Math.round((m.respect - m.respectBled) * 100) / 100;

    energyAnalysis.push({
      id: m.id,
      name: m.name,
      level: m.level,
      attacks: m.attacks,
      respect: m.respect,
      respectPerHit: rph,
      estimatedEnergy: estEnergy,
      efficiencyPct: Math.round(rphRatio * 100),
      wastedEnergy,
      timesAttacked: m.timesAttacked,
      respectBled: m.respectBled,
      netScore,
      isBelowThreshold,
    });
  }

  energyAnalysis.sort((a, b) => b.respectPerHit - a.respectPerHit);

  const totalEstEnergy = energyAnalysis.reduce((s, m) => s + m.estimatedEnergy, 0);
  const totalWastedEnergy = energyAnalysis.reduce((s, m) => s + m.wastedEnergy, 0);
  const energyEfficiencyPct = totalEstEnergy > 0 ? Math.round(((totalEstEnergy - totalWastedEnergy) / totalEstEnergy) * 100) : 100;

  const energyEfficiency = {
    members: energyAnalysis,
    totalEstimatedEnergy: totalEstEnergy,
    totalWastedEnergy: totalWastedEnergy,
    efficiencyPct: energyEfficiencyPct,
    factionAvgRespectPerHit: factionAvgRph,
  };

  // ── D. INDIVIDUAL HIGHLIGHTS: POSITIVE ──
  // Composite score: normalize hits, respect/hit, and net score
  const maxHits = Math.max(...participatingMembers.map(m => m.attacks), 1);
  const maxRph = Math.max(...participatingMembers.map(m => m.attacks > 0 ? m.respect / m.attacks : 0), 1);
  const maxNetScore = Math.max(...participatingMembers.map(m => m.score), 1);

  const scoredMembers = participatingMembers.map(m => {
    const rph = m.attacks > 0 ? m.respect / m.attacks : 0;
    const composite = (m.attacks / maxHits) * 0.3 + (rph / maxRph) * 0.3 + (m.score / maxNetScore) * 0.4;
    return { ...m, respectPerHit: Math.round(rph * 100) / 100, composite };
  });
  scoredMembers.sort((a, b) => b.composite - a.composite);

  // Top 5-8 performers
  const topCount = Math.min(8, Math.max(5, Math.ceil(participationCount * 0.2)));
  const topPerformers = scoredMembers.slice(0, topCount);

  // Special achievements
  const achievements = [];
  const mostHits = [...participatingMembers].sort((a, b) => b.attacks - a.attacks)[0];
  if (mostHits) achievements.push({ title: "Most Hits", name: mostHits.name, value: mostHits.attacks + " attacks" });

  const highestRph = [...participatingMembers].filter(m => m.attacks >= 3).sort((a, b) => {
    return (b.respect / b.attacks) - (a.respect / a.attacks);
  })[0];
  if (highestRph) achievements.push({ title: "Highest Respect/Hit", name: highestRph.name, value: (highestRph.respect / highestRph.attacks).toFixed(2) + " resp/hit" });

  const mostEfficient = energyAnalysis.filter(m => m.attacks >= 3).sort((a, b) => b.efficiencyPct - a.efficiencyPct)[0];
  if (mostEfficient) achievements.push({ title: "Most Efficient", name: mostEfficient.name, value: mostEfficient.efficiencyPct + "% of avg" });

  const bestNetScore = [...participatingMembers].sort((a, b) => b.score - a.score)[0];
  if (bestNetScore) achievements.push({ title: "Best Net Score", name: bestNetScore.name, value: formatStatNum(bestNetScore.score) });

  const positiveHighlights = {
    topPerformers: topPerformers.map(m => ({
      id: m.id,
      name: m.name,
      level: m.level,
      attacks: m.attacks,
      assists: m.assists,
      respect: m.respect,
      respectPerHit: m.respectPerHit,
      score: m.score,
    })),
    achievements,
  };

  // ── E. INDIVIDUAL HIGHLIGHTS: AREAS TO IMPROVE ──
  const bottomPerformers = [];

  // Members with low respect/hit (participated but bad target selection)
  const lowRphMembers = scoredMembers
    .filter(m => m.attacks >= 3 && m.respectPerHit < factionAvgRph * 0.5)
    .sort((a, b) => a.respectPerHit - b.respectPerHit)
    .slice(0, 5);

  for (const m of lowRphMembers) {
    bottomPerformers.push({
      id: m.id,
      name: m.name,
      level: m.level,
      attacks: m.attacks,
      respect: m.respect,
      respectPerHit: m.respectPerHit,
      score: m.score,
      issue: "Low respect/hit — poor target selection",
    });
  }

  // Members with high hits but low total respect (wasted energy)
  const wastedEnergyMembers = scoredMembers
    .filter(m => m.attacks >= 5 && m.respect < totalRespect * 0.01 && !lowRphMembers.find(l => l.id === m.id))
    .sort((a, b) => b.attacks - a.attacks)
    .slice(0, 3);

  for (const m of wastedEnergyMembers) {
    bottomPerformers.push({
      id: m.id,
      name: m.name,
      level: m.level,
      attacks: m.attacks,
      respect: m.respect,
      respectPerHit: m.respectPerHit,
      score: m.score,
      issue: "High activity but low respect — energy could be better spent",
    });
  }

  // Members who didn't participate at all
  const nonParticipants = ourMemberList
    .filter(m => m.attacks === 0)
    .sort((a, b) => b.level - a.level)
    .slice(0, 5);

  for (const m of nonParticipants) {
    bottomPerformers.push({
      id: m.id,
      name: m.name,
      level: m.level,
      attacks: 0,
      respect: 0,
      respectPerHit: 0,
      score: m.score,
      issue: "Did not participate",
    });
  }

  const negativeHighlights = {
    areasToImprove: bottomPerformers.slice(0, 8),
  };

  // ── F. AREAS FOR IMPROVEMENT ──
  const recommendations = [];

  // Low respect/hit across faction
  const lowRphCount = energyAnalysis.filter(m => m.efficiencyPct < 50).length;
  if (lowRphCount > participationCount * 0.3) {
    recommendations.push({
      category: "Target Selection",
      text: "Many members have low respect per hit. Focus on vulnerable targets with higher fair fight values for better respect gains.",
      priority: "high",
    });
  }

  // Low participation
  if (participationRate < 60) {
    recommendations.push({
      category: "Participation",
      text: `Only ${participationRate}% of the roster participated. Encourage more faction members to contribute — even a few hits help.`,
      priority: "high",
    });
  } else if (participationRate < 80) {
    recommendations.push({
      category: "Participation",
      text: `${participationRate}% participation — good but room for improvement. Coordinate with inactive members for future wars.`,
      priority: "medium",
    });
  }

  // Top-heavy carry
  if (topPerformers.length > 0) {
    const topRespect = topPerformers.slice(0, 3).reduce((s, m) => s + m.respect, 0);
    if (totalRespect > 0 && topRespect / totalRespect > 0.5) {
      recommendations.push({
        category: "Balance",
        text: "Top 3 performers carried over 50% of total respect. Distribute attack load more evenly to reduce burnout and vulnerability.",
        priority: "medium",
      });
    }
  }

  // Low average fair fight
  if (avgFairFight != null && avgFairFight < 2.0) {
    recommendations.push({
      category: "Fair Fight",
      text: `Average fair fight value is ${avgFairFight.toFixed(2)}. Target selection can be improved for better respect gains — aim for opponents closer to your stat range.`,
      priority: "medium",
    });
  }

  // Low energy efficiency
  if (energyEfficiencyPct < 70) {
    recommendations.push({
      category: "Energy Management",
      text: `Energy efficiency is at ${energyEfficiencyPct}%. Significant energy was wasted on low-value targets. Coordinate target assignments to maximize respect per energy spent.`,
      priority: "high",
    });
  }

  // We lost
  if (warResult === "DEFEAT") {
    if (totalOurHits < totalEnemyHits * 0.7) {
      recommendations.push({
        category: "Activity",
        text: "Enemy significantly out-hit us. Increase hit volume through better scheduling, energy refills, and coordination.",
        priority: "high",
      });
    }
    recommendations.push({
      category: "Strategy",
      text: "Review enemy composition and adjust scouting approach for the next ranked war. Consider pre-war stat checks to better plan target assignments.",
      priority: "medium",
    });
  }

  // ── G. MEMBER PERFORMANCE TABLE ──
  const memberTable = ourMemberList.map(m => {
    const rph = m.attacks > 0 ? Math.round((m.respect / m.attacks) * 100) / 100 : 0;
    const estEnergy = m.attacks * 25;
    const effPct = factionAvgRph > 0 ? Math.round((rph / factionAvgRph) * 100) : 100;
    const rphRatio = factionAvgRph > 0 ? rph / factionAvgRph : 1;
    const netScore = Math.round((m.respect - m.respectBled) * 100) / 100;
    return {
      id: m.id,
      name: m.name,
      level: m.level,
      attacks: m.attacks,
      assists: m.assists,
      respect: m.respect,
      respectPerHit: rph,
      estimatedEnergy: estEnergy,
      efficiencyPct: effPct,
      score: m.score,
      timesAttacked: m.timesAttacked,
      respectBled: m.respectBled,
      netScore,
    };
  });
  memberTable.sort((a, b) => b.netScore - a.netScore);

  return {
    warSummary,
    factionPerformance,
    energyEfficiency,
    positiveHighlights,
    negativeHighlights,
    recommendations,
    memberTable,
    generatedAt: Date.now(),
  };
}

/** Format war duration in human-readable form. */
function formatWarDuration(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/** Shared handler for post-war report generation (GET and POST). */
async function handlePostWarReport(req, res) {
  const { factionId } = req.user;
  const { warId } = req.params;

  const war = requireWarMember(req, res, warId);
  if (!war) {
    return war === null && !res.headersSent
      ? res.status(404).json({ error: "War not found" })
      : undefined;
  }

  // Cooldown check
  const lastReport = postWarReportCooldowns.get(warId) || 0;
  const elapsed = Date.now() - lastReport;
  if (elapsed < POST_WAR_REPORT_COOLDOWN_MS) {
    const waitSec = Math.ceil((POST_WAR_REPORT_COOLDOWN_MS - elapsed) / 1000);
    return res.status(429).json({ error: `Please wait ${waitSec}s before requesting another post-war report` });
  }

  const apiKey = store.getFactionApiKey(factionId) || store.getApiKeyForFaction(factionId);
  if (!apiKey) {
    return res.status(503).json({ error: "No API key available — set a faction API key in settings" });
  }

  // Accept estimates from POST body
  const estimates = (req.body && req.body.estimates) || {};

  try {
    postWarReportCooldowns.set(warId, Date.now());
    const warReportData = await fetchRankedWarReport(factionId, apiKey);

    if (!warReportData || (!warReportData.factions && !warReportData.war)) {
      return res.status(404).json({ error: "No ranked war report available — a ranked war may not have been completed recently" });
    }

    // Fetch attack log for bleed analysis
    let attackLog = [];
    try {
      const startTs = warReportData.rankedwarreport?.start || warReportData.start || 0;
      const endTs = warReportData.rankedwarreport?.end || warReportData.end || 0;
      if (startTs && endTs) {
        attackLog = await fetchFactionAttacks(war.factionId, apiKey, startTs, endTs);
        console.log(`[post-war] Fetched ${attackLog.length} ranked war attacks for bleed analysis`);
      }
    } catch (atkErr) {
      console.warn(`[post-war] Attack log fetch failed (bleed analysis will be skipped):`, atkErr.message);
    }

    const report = analyzePostWarReport(warReportData, estimates, attackLog);
    console.log(`[post-war] Generated post-war report for war ${warId} (faction: ${factionId})`);
    return res.json({ report });
  } catch (err) {
    console.error("[post-war] Post-war report failed:", err.message);
    return res.status(502).json({ error: `Failed to generate post-war report: ${err.message}` });
  }
}

router.get("/api/war/:warId/post-war-report", requireAuth, handlePostWarReport);
router.post("/api/war/:warId/post-war-report", requireAuth, handlePostWarReport);


// ── GET /api/oc-verify ──────────────────────────────────────────────────
// Verify an API key belongs to a faction member. Used by OC Spawn Assistance.
// Rate-limited: one live Torn API call per key per 5 minutes; results cached.

const _ocVerifyCache = new Map(); // keySuffix → { ok, player, ts }

router.get("/api/oc-verify", async (req, res) => {
  const key = req.query.key;
  if (!key || typeof key !== "string" || key.length < 10) {
    return res.status(400).json({ ok: false, error: "Invalid key" });
  }

  const suffix = key.slice(-8);
  const cached = _ocVerifyCache.get(suffix);
  if (cached && (Date.now() - cached.ts) < 5 * 60_000) {
    return res.json({ ok: cached.ok, player: cached.player, cached: true });
  }

  try {
    const info = await verifyTornApiKey(key);
    const ok   = isFactionAllowed(info.factionId);
    _ocVerifyCache.set(suffix, { ok, player: info.playerName, ts: Date.now() });
    console.log(`[oc-verify] ${info.playerName} factionId=${info.factionId} ok=${ok}`);
    return res.json({ ok, player: info.playerName });
  } catch (err) {
    console.warn("[oc-verify] Error:", err.message);
    return res.status(401).json({ ok: false, error: err.message });
  }
});


// ── GET /api/oc/spawn-key ───────────────────────────────────────────────
// Single-call endpoint for OC Spawn Assistance userscript.
// Accepts API key as query param (no CORS preflight needed).
// Verifies faction membership, then returns spawn data with 6h CPR cache.

const _spawnKeyCache  = new Map(); // keySuffix  → { ts, factionId, playerName, playerId, factionPosition, hasFactionAccess }

// ═══════════════════════════════════════════════════════════════════════════════
//  SLOT OPTIMIZER ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
function runSlotOptimizer(data) {
  const crimes = data.crimes || data.availableCrimes || [];
  const members = data.members || {};
  const cprCache = data.cprCache || {};

  // 1. Collect all open slots across all recruiting OCs
  const openSlots = [];
  for (const crime of crimes) {
    if (crime.status !== 'Recruiting') continue;
    const slots = crime.slots || [];
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (s.user_id || s.user?.id) continue; // filled
      openSlots.push({
        crimeId: crime.id, crimeName: crime.name, difficulty: crime.difficulty || 0,
        position: s.position, slotIndex: i, expiredAt: crime.expired_at || Infinity,
      });
    }
  }

  // 2. Collect all free members with their CPR data
  const freeMems = [];
  const memberArr = Array.isArray(members) ? members : Object.values(members);
  for (const m of memberArr) {
    if (m.inOC || m.status === 'inOC') continue; // already in an OC
    const uid = String(m.id || m.playerId || m.uid);
    const cpr = cprCache[uid];
    if (!cpr) continue;
    freeMems.push({
      uid, name: m.name || m.playerName || uid,
      cpr: cpr.cpr || 0, joinable: cpr.joinable || 1,
      byPosition: cpr.byPosition || {},
      level: m.level || 0,
    });
  }

  // 3. Score every (member, slot) pair
  const pairs = [];
  for (const slot of openSlots) {
    for (const mem of freeMems) {
      if (mem.joinable < slot.difficulty) continue; // can't join this level
      // Score: position CPR match + level proximity + expiry urgency
      let score = 0;
      // Position CPR (best indicator of fit)
      const posKey = `${slot.crimeName}::${slot.position}`;
      const posCpr = mem.byPosition?.[posKey]?.cpr;
      if (posCpr) {
        score += posCpr * 2; // weight position-specific CPR heavily
      } else {
        score += mem.cpr; // fallback to general CPR
      }
      // Exact level match bonus (prefer members at the right level)
      if (mem.joinable === slot.difficulty) score += 20;
      // Expiry urgency bonus (prioritize slots expiring soon)
      const hoursToExpiry = (slot.expiredAt - Date.now() / 1000) / 3600;
      if (hoursToExpiry < 6) score += 30;
      else if (hoursToExpiry < 12) score += 15;
      else if (hoursToExpiry < 24) score += 5;

      pairs.push({ slot, member: mem, score });
    }
  }

  // 4. Greedy assignment: pick highest-scoring pairs, no member or slot used twice
  pairs.sort((a, b) => b.score - a.score);
  const usedMembers = new Set();
  const usedSlots = new Set();
  const assignments = [];

  for (const p of pairs) {
    const slotKey = `${p.slot.crimeId}:${p.slot.slotIndex}`;
    if (usedMembers.has(p.member.uid) || usedSlots.has(slotKey)) continue;
    usedMembers.add(p.member.uid);
    usedSlots.add(slotKey);
    assignments.push({
      memberId: p.member.uid, memberName: p.member.name,
      memberCpr: p.member.cpr, memberJoinable: p.member.joinable,
      crimeId: p.slot.crimeId, crimeName: p.slot.crimeName,
      difficulty: p.slot.difficulty, position: p.slot.position,
      score: Math.round(p.score * 10) / 10,
      positionCpr: p.slot.crimeName && p.member.byPosition?.[`${p.slot.crimeName}::${p.slot.position}`]?.cpr || null,
      hoursToExpiry: Math.round(((p.slot.expiredAt || Infinity) - Date.now() / 1000) / 360) / 10,
    });
  }

  // Sort assignments by crime urgency then difficulty
  assignments.sort((a, b) => {
    if (a.hoursToExpiry !== b.hoursToExpiry) return a.hoursToExpiry - b.hoursToExpiry;
    return b.difficulty - a.difficulty;
  });

  return {
    assignments,
    stats: {
      openSlots: openSlots.length,
      freeMembers: freeMems.length,
      assigned: assignments.length,
      unfilledSlots: openSlots.length - assignments.length,
      unassignedMembers: freeMems.length - assignments.length,
    }
  };
}
const _factionKeyCache = new Map(); // factionId  → { keys: [apiKey, ...], lastIndex: 0 } — pool of up to 10 verified faction-access keys
const FACTION_KEY_POOL_MAX = 10;

function addFactionKey(fid, key) {
  fid = String(fid);
  let pool = _factionKeyCache.get(fid);
  if (!pool) { pool = { keys: [], lastIndex: 0 }; _factionKeyCache.set(fid, pool); }
  // Don't add duplicates
  if (pool.keys.includes(key)) return;
  // If full, replace the oldest
  if (pool.keys.length >= FACTION_KEY_POOL_MAX) pool.keys.shift();
  pool.keys.push(key);
}

function getNextFactionKey(fid) {
  const pool = _factionKeyCache.get(String(fid));
  if (!pool || pool.keys.length === 0) return null;
  pool.lastIndex = (pool.lastIndex + 1) % pool.keys.length;
  return pool.keys[pool.lastIndex];
}

function removeFactionKey(fid, key) {
  const pool = _factionKeyCache.get(String(fid));
  if (!pool) return;
  pool.keys = pool.keys.filter(k => k !== key);
  if (pool.lastIndex >= pool.keys.length) pool.lastIndex = 0;
}
const PARTNER_FACTIONS = ["51430"]; // Factions with permanent free access
const OWNER_PLAYER_ID = 137558; // RussianRob — receives Xanax payments // Factions with permanent free access


const OC_MIN_VERSION = '2.1.22';

// Instant Xanax check: when a non-subscribed member refreshes, check THEIR events
// for a recent Xanax send to RussianRob. If found, grant access immediately.
async function checkInstantXanax(apiKey, playerInfo) {
  try {
    const res = await fetch(`https://api.torn.com/v2/user/events?limit=20&key=${encodeURIComponent(apiKey)}`);
    if (!res.ok) return false;
    const data = await res.json();
    if (data.error) return false;
    const events = data.events || [];
    // Look for "You sent 2 x Xanax to RussianRob" or similar
    for (const ev of events) {
      const txt = ev.event || '';
      const match = txt.match(/sent\s+(\d+)\s*x\s*Xanax.*?(\d{4,})/i);
      if (!match) continue;
      const qty = parseInt(match[1], 10);
      const targetId = match[2];
      // Must be sent to RussianRob (137558)
      if (String(targetId) !== String(OWNER_PLAYER_ID)) continue;
      // Must be recent (within last 30 minutes)
      const age = Math.floor(Date.now() / 1000) - (ev.timestamp || 0);
      if (age > 1800) continue;
      // Grant access
      const { grantFactionAccess } = await import('./xanax-subscriptions.js');
      const granted = grantFactionAccess(playerInfo.factionId, playerInfo.playerName + "'s faction", qty, playerInfo.playerName);
      if (granted) return true;
    }
  } catch (e) { console.warn('[oc/spawn-key] Instant Xanax check failed:', e.message); }
  return false;
}
function versionTooOld(v) {
  if (!v) return true; // no version param = old script
  const a = v.split('.').map(Number), b = OC_MIN_VERSION.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i]||0) < (b[i]||0)) return true;
    if ((a[i]||0) > (b[i]||0)) return false;
  }
  return false; // equal = ok
}

router.get("/api/oc/spawn-key", async (req, res) => {
  // Explicit wildcard CORS: WebKit (TornPDA) sends Origin: null which cors middleware skips
  res.set("Access-Control-Allow-Origin", "*");


  // Build viewer object with subscription info
  function buildViewer(playerInfo) {
    const fid = String(playerInfo.factionId);
    const ownerFid = String(process.env.OWNER_FACTION_ID || '42055');
    let subscriptionExpiresAt = null;
    if (fid === ownerFid || PARTNER_FACTIONS.includes(fid)) {
      subscriptionExpiresAt = 'permanent';
    } else {
      const xSub = getXanaxSubscription(fid);
      if (xSub && xSub.expiresAt) subscriptionExpiresAt = xSub.expiresAt;
      if (!subscriptionExpiresAt) {
        const allSubs = getAllSubscriptions();
        const match = allSubs.find(s => String(s.factionId) === fid);
        if (match && match.expiresAt) subscriptionExpiresAt = match.expiresAt;
      }
    }
    return { playerId: playerInfo.playerId, playerName: playerInfo.playerName, isOwnerFaction: isFactionAllowed(fid), position: playerInfo.factionPosition || '', hasFactionAccess: playerInfo.hasFactionAccess || false, subscriptionExpiresAt };
  }

  // Block outdated script versions with a helpful update message
  if (versionTooOld(req.query.v)) {
    return res.status(426).json({ error: 'Your OC Spawn script is outdated.', updateUrl: 'https://tornwar.com/scripts/oc-spawn-assistance.user.js' });
  }

  const key = req.query.key;
  if (!key || typeof key !== "string" || key.length < 10) {
    return res.status(400).json({ error: "Invalid key" });
  }

  const suffix = key.slice(-8);
  let playerInfo = _spawnKeyCache.get(suffix);

  // Re-verify if missing, stale, or populated by another route without playerId
  if (!playerInfo || (Date.now() - playerInfo.ts) > 5 * 60_000 || !playerInfo.playerId) {
    try {
      const info = await verifyTornApiKey(key);
      if (!isFactionAllowed(info.factionId) && !PARTNER_FACTIONS.includes(String(info.factionId)) && !hasXanaxSubscription(info.factionId)) {
        // Check if they just sent Xanax (instant grant)
        const granted = await checkInstantXanax(key, { factionId: info.factionId, playerName: info.playerName });
        if (!granted) {
          return res.status(403).json({ error: "Access restricted. Send 2 Xanax for a 7-day trial or 20 Xanax for 30 days to RussianRob." });
        }
      }
      store.storeApiKey(info.playerId, key);
      playerInfo = { ts: Date.now(), factionId: info.factionId, playerName: info.playerName, playerId: info.playerId, factionPosition: info.factionPosition, hasFactionAccess: info.hasFactionAccess };
      _spawnKeyCache.set(suffix, playerInfo);
      console.log(`[oc/spawn-key] Verified ${info.playerName} (faction ${info.factionId})`);
    } catch (err) {
      console.warn("[oc/spawn-key] Verify failed:", err.message);
      return res.status(401).json({ error: err.message });
    }
  }

  try {
    // Use requesting member's key. For members without faction access,
    // this will fail and fall back to the cached faction key below.
    const fid = String(playerInfo.factionId);
    if (playerInfo.hasFactionAccess) addFactionKey(fid, key);
    const data = await getOcSpawnData(playerInfo.factionId, key);

    // Apply faction's MINCPR/CPR_BOOST to recalculate joinable (server cache uses hardcoded defaults)
    const fSettings = store.getFactionSettings(playerInfo.factionId);
    const fMincpr = fSettings.oc_mincpr ?? 60;
    const fBoost  = fSettings.oc_cpr_boost ?? 15;
    for (const [uid, d] of Object.entries(data.cprCache || {})) {
      const lc = {};
      for (const e of (d.entries || [])) {
        if (!lc[e.diff]) lc[e.diff] = { sum: 0, count: 0 };
        lc[e.diff].sum += e.rate; lc[e.diff].count += 1;
      }
      let effTop = d.highestLevel || 0;
      for (let lvl = effTop; lvl >= 1; lvl--) {
        const lv = lc[lvl]; if (!lv) continue;
        if ((lv.sum / lv.count) >= fMincpr) { effTop = lvl; break; }
      }
      d.effectiveTop = effTop;
      d.joinable = d.cpr >= fMincpr + fBoost ? Math.min(effTop + 1, 10) : effTop;
    }

    const viewerObj = buildViewer(playerInfo);
    console.log(`[oc/spawn-key] Sending viewer for ${playerInfo.playerName} (${playerInfo.playerId}): hasFactionAccess=${viewerObj.hasFactionAccess}`);

    // Run engines if enabled
    const engines = {};
    if (fSettings.engine_slot_optimizer) {
      engines.slotOptimizer = runSlotOptimizer(data);
    }

    return res.json({ ...data, viewer: viewerObj, engines });
  } catch (err) {
    // If member's own key failed, try keys from the faction pool
    const fid = String(playerInfo.factionId);
    const pool = _factionKeyCache.get(fid);
    if (pool && pool.keys.length > 0) {
      const keysToTry = pool.keys.filter(k => k !== key);
      for (const poolKey of keysToTry) {
        try {
          const data = await getOcSpawnData(playerInfo.factionId, poolKey);
          // Apply faction settings to retry path too
          const fS2 = store.getFactionSettings(playerInfo.factionId);
          const fM2 = fS2.oc_mincpr ?? 60, fB2 = fS2.oc_cpr_boost ?? 15;
          for (const [uid, d] of Object.entries(data.cprCache || {})) {
            const lc = {};
            for (const e of (d.entries || [])) { if (!lc[e.diff]) lc[e.diff] = { sum: 0, count: 0 }; lc[e.diff].sum += e.rate; lc[e.diff].count += 1; }
            let effTop = d.highestLevel || 0;
            for (let lvl = effTop; lvl >= 1; lvl--) { const lv = lc[lvl]; if (!lv) continue; if ((lv.sum / lv.count) >= fM2) { effTop = lvl; break; } }
            d.effectiveTop = effTop;
            d.joinable = d.cpr >= fM2 + fB2 ? Math.min(effTop + 1, 10) : effTop;
          }
          return res.json({ ...data, viewer: buildViewer(playerInfo) });
        } catch (retryErr) {
          console.error(`[oc/spawn-key] pool key failed for faction ${fid}:`, retryErr.message);
          removeFactionKey(fid, poolKey); // Remove dead key from pool
        }
      }
    }
    console.error("[oc/spawn-key] getOcSpawnData failed:", err.message);
    // No cached faction key available — return partial data so the script can show viewer card
    return res.json({ crimes: [], members: {}, cprCache: {}, pendingFactionData: true, viewer: buildViewer(playerInfo) });
  }
});


// -- GET /api/oc/settings ---------------------------------------------------
router.get("/api/oc/settings", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  const key = req.query.key;
  if (!key || key.length < 10) return res.status(400).json({ error: "Invalid key" });
  const suffix = key.slice(-8);
  let info = _spawnKeyCache.get(suffix);
  if (!info || (Date.now() - info.ts) > 5 * 60_000) {
    try {
      const tornInfo = await verifyTornApiKey(key);
      if (!isFactionAllowed(tornInfo.factionId) && !PARTNER_FACTIONS.includes(String(tornInfo.factionId)) && !hasXanaxSubscription(tornInfo.factionId)) {
        return res.status(403).json({ error: "Access restricted" });
      }
      info = { ts: Date.now(), factionId: tornInfo.factionId, playerName: tornInfo.playerName, playerId: tornInfo.playerId, factionPosition: tornInfo.factionPosition, hasFactionAccess: tornInfo.hasFactionAccess };
      _spawnKeyCache.set(suffix, info);
    } catch (err) { return res.status(401).json({ error: err.message }); }
  }
  const s = store.getFactionSettings(info.factionId);
  return res.json({
    active_days:         s.oc_active_days          ?? 7,
    forecast_hours:      s.oc_forecast_hours       ?? 24,
    mincpr:              s.oc_mincpr               ?? 60,
    cpr_boost:           s.oc_cpr_boost            ?? 15,
    lookback_days:       s.oc_lookback_days        ?? 90,
    scope:               s.oc_scope                ?? null,
    high_weight_pct:     s.oc_high_weight_pct      ?? 25,
    high_weight_mincpr:  s.oc_high_weight_mincpr   ?? 75,
    // Engine toggles
    engine_slot_optimizer:   s.engine_slot_optimizer   ?? false,
    engine_spawn_predictor:  s.engine_spawn_predictor  ?? false,
    engine_cpr_forecaster:   s.engine_cpr_forecaster   ?? false,
    engine_failure_risk:     s.engine_failure_risk     ?? false,
    engine_expiry_risk:      s.engine_expiry_risk      ?? false,
    engine_member_reliability: s.engine_member_reliability ?? false,
    engine_payout_optimizer: s.engine_payout_optimizer ?? false,
    engine_item_roi:         s.engine_item_roi         ?? false,
    engine_nerve_efficiency: s.engine_nerve_efficiency ?? false,
    engine_gap_analyzer:     s.engine_gap_analyzer     ?? false,
    engine_member_projector: s.engine_member_projector ?? false,
  });
});

// -- GET /api/oc/version (lightweight version check for update notifications)
router.get("/api/oc/version", (req, res) => {
  try {
    const fs = require('fs');
    const script = fs.readFileSync('/opt/warboard/server/public/scripts/oc-spawn-assistance.user.js', 'utf-8');
    const match = script.match(/@version\s+([\d.]+)/);
    return res.json({ version: match ? match[1] : '0' });
  } catch (e) { return res.json({ version: '0' }); }
});

// -- GET /api/oc/scope  (lightweight scope-only update — no other settings touched)
router.get("/api/oc/scope", async (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json({ error: "Missing key" });
  const suffix = key.slice(-8);
  let info = _spawnKeyCache.get(suffix);
  if (!info || (Date.now() - info.ts) > 5 * 60_000) {
    try {
      const tornInfo = await verifyTornApiKey(key);
      info = { ts: Date.now(), factionId: tornInfo.factionId, playerName: tornInfo.playerName, playerId: tornInfo.playerId, factionPosition: tornInfo.factionPosition, hasFactionAccess: tornInfo.hasFactionAccess };
      _spawnKeyCache.set(suffix, info);
    } catch (err) { return res.status(401).json({ error: err.message }); }
  }
  const scopeRaw = parseInt(req.query.scope, 10);
  if (isNaN(scopeRaw)) return res.status(400).json({ error: "Missing scope" });
  const current = store.getFactionSettings(info.factionId);
  store.updateFactionSettings(info.factionId, { ...current, oc_scope: Math.max(0, Math.min(100, scopeRaw)) });
  return res.json({ ok: true });
});

// -- GET /api/oc/settings/update --------------------------------------------
router.get("/api/oc/settings/update", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  const key = req.query.key;
  if (!key || key.length < 10) return res.status(400).json({ error: "Invalid key" });
  const suffix = key.slice(-8);
  let info = _spawnKeyCache.get(suffix);
  if (!info || (Date.now() - info.ts) > 5 * 60_000) {
    try {
      const tornInfo = await verifyTornApiKey(key);
      if (!isFactionAllowed(tornInfo.factionId)) {
        return res.status(403).json({ error: "Settings can only be changed by faction members." });
      }
      info = { ts: Date.now(), factionId: tornInfo.factionId, playerName: tornInfo.playerName, playerId: tornInfo.playerId, factionPosition: tornInfo.factionPosition, hasFactionAccess: tornInfo.hasFactionAccess };
      _spawnKeyCache.set(suffix, info);
    } catch (err) { return res.status(401).json({ error: err.message }); }
  } else if (!isFactionAllowed(info.factionId)) {
    return res.status(403).json({ error: "Settings can only be changed by faction members." });
  }
  const num = (k, d) => { const v = parseInt(req.query[k], 10); return isNaN(v) ? d : v; };
  const bool = (k) => req.query[k] === 'true' || req.query[k] === '1';
  const scopeRaw = parseInt(req.query.scope, 10);
  store.updateFactionSettings(info.factionId, {
    oc_active_days:         num("active_days",         7),
    oc_forecast_hours:      num("forecast_hours",      24),
    oc_mincpr:              num("mincpr",               60),
    oc_cpr_boost:           num("cpr_boost",            15),
    oc_lookback_days:       num("lookback_days",        90),
    oc_high_weight_pct:     num("high_weight_pct",      25),
    oc_high_weight_mincpr:  num("high_weight_mincpr",   75),
    oc_scope:               isNaN(scopeRaw) ? null : Math.max(0, Math.min(100, scopeRaw)),
    // Engine toggles (only update if present in query)
    ...(req.query.engine_slot_optimizer !== undefined    && { engine_slot_optimizer:   bool('engine_slot_optimizer') }),
    ...(req.query.engine_spawn_predictor !== undefined   && { engine_spawn_predictor:  bool('engine_spawn_predictor') }),
    ...(req.query.engine_cpr_forecaster !== undefined    && { engine_cpr_forecaster:   bool('engine_cpr_forecaster') }),
    ...(req.query.engine_failure_risk !== undefined      && { engine_failure_risk:     bool('engine_failure_risk') }),
    ...(req.query.engine_expiry_risk !== undefined       && { engine_expiry_risk:      bool('engine_expiry_risk') }),
    ...(req.query.engine_member_reliability !== undefined && { engine_member_reliability: bool('engine_member_reliability') }),
    ...(req.query.engine_payout_optimizer !== undefined  && { engine_payout_optimizer: bool('engine_payout_optimizer') }),
    ...(req.query.engine_item_roi !== undefined          && { engine_item_roi:         bool('engine_item_roi') }),
    ...(req.query.engine_nerve_efficiency !== undefined  && { engine_nerve_efficiency: bool('engine_nerve_efficiency') }),
    ...(req.query.engine_gap_analyzer !== undefined      && { engine_gap_analyzer:     bool('engine_gap_analyzer') }),
    ...(req.query.engine_member_projector !== undefined  && { engine_member_projector: bool('engine_member_projector') }),
  });
  console.log("[oc/settings] " + info.playerName + " updated faction " + info.factionId + " OC settings");
  return res.json({ ok: true });
});


// ── Nerve Tracker ──────────────────────────────────────────────────────────

/**
 * GET /api/nerve-tracker
 * Returns current NNB state, 48-hour history, and all NNB change events.
 * Public — no auth required (data is the player's own nerve bar history).
 */
router.get("/api/nerve-tracker", (req, res) => {
    res.json(getNerveData());
});

/**
 * POST /api/nerve-tracker/config
 * Update faction offset (and optionally the API key).
 * Protected by JWT so only the owner can change it.
 * Body: { factionOffset: number, apiKey?: string }
 */
router.post("/api/nerve-tracker/config", requireAuth, (req, res) => {
    const { factionOffset, apiKey } = req.body;
    if (factionOffset == null) return res.status(400).json({ error: "factionOffset required" });
    updateNerveConfig({ factionOffset, apiKey });
    res.json({ ok: true, factionOffset: Number(factionOffset) });
});

export default router;
