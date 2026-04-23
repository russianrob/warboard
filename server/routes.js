/**
 * REST API route definitions.
 */

import { Router } from "express";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join as pathJoin, dirname as pathDirname } from "node:path";
import { fileURLToPath } from 'node:url';
import axios from "axios";
import { verifyTornApiKey, issueToken, verifyToken, requireAuth } from "./auth.js";
import * as store from "./store.js";
import { getAllowedBroadcastRoles, updateFactionSettings } from "./store.js";
import { fetchFactionMembers, fetchFactionChain, fetchRankedWar, fetchFactionBasic, fetchRankedWarReport, fetchFactionAttacks } from "./torn-api.js";

/** Mask an API key for safe logging — shows only last 4 chars. */
const maskKey = (key) => key ? `****${String(key).slice(-4)}` : '****';
import { getHeatmap, resetHeatmap } from "./activity-heatmap.js";
import { getOcSpawnData, getCachedCompletedCrimes, calculateOutcome } from "./oc-spawn.js";
import { getItemMarketValue } from "./item-values.js";
import * as vaultRequests from "./vault-requests.js";
import * as keyUsage from "./key-usage-log.js";
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
export function broadcastSSE(warId, data) {
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

/**
 * Schedule a call's expiry. When the timer fires, check whether any
 * faction member is currently viewing the target. If yes, re-schedule
 * (the call stays alive while someone's actively working it). If no,
 * uncall — the original "stale after N minutes" behavior, but now only
 * triggers when nobody's around to claim it.
 */
function scheduleCallExpiry(warId, targetId) {
  const war = store.getWar(warId);
  if (!war || !war.calls[targetId]) return;
  const call = war.calls[targetId];

  const timerKey = `${warId}:${targetId}`;
  clearExistingTimer(timerKey);

  const expireMs = call.isDeal ? DEAL_EXPIRE_MS : CALL_EXPIRE_MS;
  callTimers.set(
    timerKey,
    setTimeout(() => {
      const currentWar = store.getWar(warId);
      if (!currentWar || !currentWar.calls[targetId]) return;

      const viewers = store.getViewersForWar(warId) || {};
      const targetViewers = viewers[targetId] || [];
      if (targetViewers.length > 0) {
        console.log(
          `[call] extending ${warId}:${targetId} — ${targetViewers.length} viewer(s) still active`
        );
        scheduleCallExpiry(warId, targetId);
        return;
      }
      uncallTarget(warId, targetId);
    }, expireMs),
  );
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
  // Gate disabled — the landing page is now public. The /api/gate
  // endpoint and /gate.html are still available if you need to re-enable
  // later; just restore the logic below.
  return next();
  /* Previous gated behavior:
  if (
    req.path.startsWith("/api/") ||
    req.path.startsWith("/data/") ||
    req.path === "/gate.html" ||
    req.path.endsWith(".meta.js") || req.path.endsWith(".user.js")
  ) {
    return next();
  }
  const token = parseCookie(req.headers.cookie, "fo_gate");
  if (token) {
    try {
      verifyToken(token);
      return next();
    } catch (_) { }
  }
  if (req.path === "/" || req.path === "/index.html") {
    return res.redirect("/gate.html");
  }
  return res.redirect("/gate.html");
  */
}

/** Simple cookie parser — no dependency needed. */
function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

// ── POST /api/auth ──────────────────────────────────────────────────────

const FACTIONOPS_MIN_VERSION = '4.9.74';
function factionopsVersionTooOld(v) {
  if (!v || typeof v !== 'string') return false; // legacy clients that don't send a version — let them through
  const a = v.split('.').map(Number), b = FACTIONOPS_MIN_VERSION.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const ai = a[i] || 0, bi = b[i] || 0;
    if (ai < bi) return true;
    if (ai > bi) return false;
  }
  return false;
}

router.post("/api/auth", async (req, res) => {
  const { apiKey, scriptVersion } = (req.body || {});
  if (!apiKey || typeof apiKey !== "string") {
    return res.status(400).json({ error: "apiKey is required" });
  }

  if (factionopsVersionTooOld(scriptVersion)) {
    return res.status(426).json({
      error: `FactionOps ${scriptVersion} is outdated — please update to v${FACTIONOPS_MIN_VERSION} or newer.`,
      updateUrl: 'https://tornwar.com/scripts/factionops.user.js',
    });
  }

  try {
    const info = await verifyTornApiKey(apiKey);

    // Faction lock — only the owner faction or subscribed factions can use the system
    if (!isFactionAllowed(info.factionId)) {
      console.log(`[auth] Rejected ${info.playerName} (${info.playerId}) — faction ${info.factionId} not subscribed (FactionOps v${scriptVersion || 'unknown'})`);
      return res.status(403).json({ error: getSubscriptionRejectionMessage() });
    }

    // Store the API key server-side for later Torn API calls
    store.storeApiKey(info.playerId, apiKey);

    // Persist playerId → factionId so offline/disconnected members can
    // still be reached by faction-scoped push notifications (retal).
    store.recordPlayerFaction(info.playerId, info.factionId);

    // Pool opt is opt-OUT: first time we see this player, default their
    // key to the rotating pool. Preserves explicit opt-outs. Clients are
    // told on first login (via the disclosure flag in the /api/auth
    // response) so they can show a one-time notice.
    const createdDefault = store.ensureDefaultPoolOpt(info.playerId, info.factionId);

    const token = issueToken({
      playerId: info.playerId,
      playerName: info.playerName,
      factionId: info.factionId,
      factionName: info.factionName,
      factionPosition: info.factionPosition,
    });

    console.log(`[auth] Player ${info.playerName} (${info.playerId}) authenticated (FactionOps v${scriptVersion || 'unknown'})`);

    return res.json({
      token,
      player: info,
      // Client uses this to show a one-time "your key is helping the
      // faction's polling pool" notice. Server only returns true on the
      // first auth for this player.
      poolingDefaultApplied: createdDefault,
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
    // Option B faction cooldowns — included here so PDA clients (which
    // use HTTP polling, not Socket.IO / SSE) pick up bars updates.
    memberBars: store.getFactionBars(war.factionId),
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

// ── POST /api/assist-request ─────────────────────────────────────────────
// Assist (war target) OR Retal (profile page). Broadcast to the faction's
// active war room. `mode` = "assist" (default) or "retal" distinguishes
// what notification text clients render.

router.post("/api/assist-request", requireAuth, (req, res) => {
  const { playerId, playerName, factionId } = req.user;
  const { warId, targetId, targetName, mode } = (req.body || {});
  const kind = mode === "retal" ? "retal" : "assist";

  if (!targetId) {
    return res.status(400).json({ error: "targetId is required" });
  }

  // Pick a broadcast scope: prefer the active war room; fall back to any
  // war for the caller's faction (so retals on profile pages work even
  // when the client hasn't joined a war room this session).
  let broadcastWarId = warId;
  if (!broadcastWarId) {
    const wars = store.getAllWars();
    for (const [id, w] of wars) {
      if (String(w.factionId) === String(factionId) && !w.warEnded) {
        broadcastWarId = id;
        break;
      }
    }
  }
  if (!broadcastWarId) {
    return res.status(400).json({ error: "No active war to broadcast into" });
  }

  const war = store.getWar(broadcastWarId);
  if (!war || String(war.factionId) !== String(factionId)) {
    return res.status(403).json({ error: "Not a member of this war's faction" });
  }

  const payload = {
    type: kind === "retal" ? "retal_request" : "assist_request",
    mode: kind,
    playerId,
    playerName,
    targetId,
    targetName: targetName || `Player [${targetId}]`,
    attackUrl: `https://www.torn.com/page.php?sid=attack&user2ID=${targetId}`,
    timestamp: Date.now(),
  };

  const eventName = kind === "retal" ? "retal_request" : "assist_request";
  if (io) io.to(`war_${broadcastWarId}`).emit(eventName, payload);
  broadcastSSE(broadcastWarId, payload);

  // Assist targets war-room members only (they're actively fighting);
  // retal targets the whole faction (offline members too) and INCLUDES
  // the sender — they usually want the push confirmation on their other
  // devices and it also verifies the pipeline is reaching them.
  let pushTargets;
  if (kind === "retal") {
    pushTargets = store.getPlayerIdsForFaction(factionId);
  } else {
    const warPlayers = store.getOnlinePlayersForWar(broadcastWarId);
    pushTargets = warPlayers.map(p => p.playerId || p.id).filter(id => id !== playerId);
  }
  push.notifyAssistRequest(pushTargets, broadcastWarId, playerName, targetName || targetId, targetId, kind);

  console.log(`[api] ${playerName} requested ${kind} on ${targetId} in war ${broadcastWarId}`);
  return res.json({ ok: true });
});

// ── Member bars/cooldowns self-report ────────────────────────────────────
// Each FactionOps client periodically fetches their own bars+cooldowns
// and POSTs the payload here so the faction can aggregate. Authenticated
// so only real faction members contribute.

router.post("/api/me/bars", requireAuth, (req, res) => {
  const { playerId, playerName, factionId } = req.user;
  const { bars, cooldowns } = (req.body || {});

  if (!bars && !cooldowns) {
    return res.status(400).json({ error: "bars and/or cooldowns required" });
  }

  console.log(`[bars] ${playerName} (${playerId}) reported: energy ${bars?.energy?.current}/${bars?.energy?.maximum}`);
  store.recordMemberBars(factionId, playerId, playerName, { bars, cooldowns });

  // Broadcast the fresh entry to everyone watching the war(s) this
  // faction owns. Clients merge it into their local state.memberBars.
  const entry = { bars, cooldowns, name: playerName, updatedAt: Date.now() };
  const wars = store.getAllWars();
  let broadcastCount = 0;
  for (const [wid, w] of wars) {
    if (String(w.factionId) === String(factionId)) {
      if (io) io.to(`war_${wid}`).emit("member_bars", { playerId, ...entry });
      broadcastSSE(wid, { memberBars: { [playerId]: entry } });
      broadcastCount++;
    }
  }
  console.log(`[bars] broadcast to ${broadcastCount} war room(s) for faction ${factionId}`);

  return res.json({ ok: true });
});

// Full snapshot for when a client joins. Returns every fresh member
// bars entry for the caller's faction.
router.get("/api/faction/bars", requireAuth, (req, res) => {
  const { factionId } = req.user;
  return res.json({ memberBars: store.getFactionBars(factionId) });
});

// ── Key-pool opt-in ──────────────────────────────────────────────────────
// Per-player consent flag: when enabled, the player's stored API key is
// eligible to be used for server-side faction pollers (chain, war-status,
// attacks-feed). Scoped to their current faction — if they move, we
// refresh the factionId on their next opt-in.

router.get("/api/pool-opt", requireAuth, (req, res) => {
  const opt = store.getKeyPoolingOpt(req.user.playerId);
  return res.json({
    enabled: !!opt.enabled,
    factionId: opt.factionId || String(req.user.factionId || ""),
  });
});

router.post("/api/pool-opt", requireAuth, (req, res) => {
  const { enabled } = (req.body || {});
  store.setKeyPoolingOpt(req.user.playerId, !!enabled, req.user.factionId);
  console.log(
    `[pool-opt] ${req.user.playerName} (${req.user.playerId}) ${enabled ? "opted IN to" : "opted OUT of"} faction ${req.user.factionId} key pool`
  );
  return res.json({ ok: true, enabled: !!enabled });
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

  // Expiry auto-extends while any faction member is viewing the target's
  // attack page. Baseline timeout still applies when nobody's around.
  scheduleCallExpiry(warId, targetId);

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

    if (targetId) {
      const war = store.getWar(player.warId);
      if (war) {
        const call = war.calls[targetId];
        if (call) {
          if (call.calledBy.id === playerId) {
            // Caller re-entered the attack page — refresh expiry so
            // their claim doesn't time out while they're working it.
            scheduleCallExpiry(player.warId, targetId);
          } else {
            // Call-stolen detection: someone else is viewing a target
            // that's already called.
            const targetInfo = war.enemyStatuses[targetId];
            const targetName = targetInfo?.name || targetId;
            push.notifyCallStolen(call.calledBy.id, playerName, targetName, targetId);
          }
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
const _engineCache    = new Map(); // factionId  → { ts, engines, settingsHash }

// In-memory flyer-delay observations. Clients POST per-render to
// /api/oc/flyer-delay; we keep the max delayedSec seen per
// (factionId, crimeId, memberId) until the crime completes and
// collectOcHistory bakes it into the disk history.
// Shape: Map<factionId, Map<crimeId::memberId, { delayedSec, observedAt, memberName, crimeName }>>
const _flyerDelays = new Map();
// Resolved lazily — OC_HISTORY_DIR is declared later in this file. Using a
// getter dodges the Temporal Dead Zone while keeping a single canonical path.
function flyerDelaysFile() { return pathJoin(OC_HISTORY_DIR, '..', 'flyer-delays.json'); }
function loadFlyerDelays() {
  try {
    const file = flyerDelaysFile();
    if (!existsSync(file)) return;
    const raw = readFileSync(file, 'utf-8');
    const data = JSON.parse(raw);
    const cutoff = Date.now() - 48 * 60 * 60 * 1000; // drop anything >48h old on load
    let total = 0;
    for (const [fid, entries] of Object.entries(data)) {
      const m = new Map();
      for (const [k, v] of Object.entries(entries)) {
        if (v && v.observedAt >= cutoff) { m.set(k, v); total++; }
      }
      if (m.size) _flyerDelays.set(fid, m);
    }
    console.log(`[flyer-delays] Loaded ${total} pending observation(s) from disk`);
  } catch (e) {
    console.error('[flyer-delays] Load error:', e.message);
  }
}
let _flyerDelaysSaveTimer = null;
function scheduleFlyerDelaysSave() {
  if (_flyerDelaysSaveTimer) return;
  _flyerDelaysSaveTimer = setTimeout(() => {
    _flyerDelaysSaveTimer = null;
    try {
      const obj = {};
      for (const [fid, entries] of _flyerDelays) {
        const sub = {};
        for (const [k, v] of entries) sub[k] = v;
        if (Object.keys(sub).length) obj[fid] = sub;
      }
      writeFileSync(flyerDelaysFile(), JSON.stringify(obj));
    } catch (e) {
      console.error('[flyer-delays] Save error:', e.message);
    }
  }, 30_000);
}
// Defer load until OC_HISTORY_DIR (declared further down) has initialised.
setImmediate(loadFlyerDelays);
function engineSettingsHash(s) {
  return `${!!s.engine_slot_optimizer}|${!!s.engine_failure_risk}|${!!s.engine_cpr_forecaster}|${!!s.engine_member_projector}|${!!s.engine_member_reliability}|${!!s.engine_auto_dispatcher}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SLOT OPTIMIZER ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
function runSlotOptimizer(factionId, data) {
  const crimes = data.crimes || data.availableCrimes || [];
  const members = data.members || {};
  const cprCache = data.cprCache || {};

  // Enrich byPosition with historical data from OC history
  const allHistory = loadOcHistory(factionId);
  const histByPos = {}; // "uid::crimeName::position" -> { rateSum, count }
  for (const h of allHistory) {
    if (!Array.isArray(h.slots)) continue;
    for (const slot of h.slots) {
      if (!slot.userId || !slot.weight) continue;
      const key = `${slot.userId}::${h.crimeName}::${slot.position}`;
      if (!histByPos[key]) histByPos[key] = { rateSum: 0, count: 0 };
      histByPos[key].rateSum += slot.weight;
      histByPos[key].count++;
    }
  }

  // 1. Collect all open slots across all recruiting OCs
  const openSlots = [];
  for (const crime of crimes) {
    if (crime.status !== 'Recruiting') continue;
    const slots = crime.slots || [];
    const totalSlots = slots.length;
    const filledSlots = slots.filter(s => (s.user_id ?? s.user?.id) != null).length;
    const fillPct = totalSlots > 0 ? filledSlots / totalSlots : 0;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (s.user_id || s.user?.id) continue; // filled
      openSlots.push({
        crimeId: crime.id, crimeName: crime.name, difficulty: crime.difficulty || 0,
        position: s.position, slotIndex: i, expiredAt: crime.expired_at || Infinity,
        filledSlots, totalSlots, fillPct,
      });
    }
  }

  // Build a faction-wide level prior: avg CPR bucketed by the player's
  // Torn level. Used to give new members a reasonable starting projection
  // based on their level alone (level-80 new member more likely to handle
  // a harder crime than a level-20 new member). Falls back to 50% when
  // the bucket has no data.
  const levelBuckets = {};   // bucketKey -> { sum, count, joinables: [] }
  function levelBucketKey(lvl) {
    if (!lvl) return 'unknown';
    if (lvl < 20)  return '1-19';
    if (lvl < 40)  return '20-39';
    if (lvl < 60)  return '40-59';
    if (lvl < 80)  return '60-79';
    if (lvl < 100) return '80-99';
    return '100+';
  }
  const memberArr = Array.isArray(members) ? members : Object.values(members);
  const levelByUid = {};
  for (const m of memberArr) {
    levelByUid[String(m.id || m.playerId || m.uid)] = m.level || 0;
  }
  for (const [uid, c] of Object.entries(cprCache)) {
    if ((c.samples || 0) < 3) continue;  // only established members shape the prior
    const bucket = levelBucketKey(levelByUid[uid]);
    if (!levelBuckets[bucket]) levelBuckets[bucket] = { sum: 0, count: 0, joinables: [] };
    levelBuckets[bucket].sum += c.rawCpr || c.cpr || 0;
    levelBuckets[bucket].count += 1;
    if (typeof c.joinable === 'number') levelBuckets[bucket].joinables.push(c.joinable);
  }
  function priorCprForLevel(lvl) {
    const bucket = levelBuckets[levelBucketKey(lvl)];
    if (!bucket || bucket.count < 2) return 50;
    return Math.round((bucket.sum / bucket.count) * 10) / 10;
  }
  // Median joinable of established members in this level bucket. A level-41
  // new member should start projecting at the level that other level-40ish
  // members in this faction typically handle — not be stuck at 1.
  function priorJoinableForLevel(lvl) {
    const bucket = levelBuckets[levelBucketKey(lvl)];
    if (!bucket || bucket.joinables.length < 2) return 1;  // not enough data, stay conservative
    const sorted = bucket.joinables.slice().sort((a, b) => a - b);
    // Use median, not mean — more robust when a bucket has outliers
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
      : sorted[mid];
  }

  // 2. Collect all free members with their CPR data
  const freeMems = [];
  for (const m of memberArr) {
    if (m.inOC || m.status === 'inOC') continue; // already in an OC
    const uid = String(m.id || m.playerId || m.uid);
    let cpr = cprCache[uid];
    // New-member synthetic profile: members with no completed-crime history
    // were being dropped entirely by the optimizer. Give them a profile
    // derived from level-based priors — both CPR and joinable level come
    // from what other established members in their level bucket typically
    // achieve. A level-41 new member should start around the level that
    // other level-40-ish members typically handle, not be stuck at joinable=1.
    if (!cpr) {
      const priorCpr = priorCprForLevel(m.level);
      const priorJoinable = priorJoinableForLevel(m.level);
      cpr = {
        cpr: priorCpr, samples: 0, topLevelSamples: 0,
        highestLevel: priorJoinable,
        joinable: priorJoinable,
        entries: [],
      };
    }
    const joinable = cpr.joinable || 1;
    const cprVal = cpr.cpr || 0;
    // Build per-level CPR from entries
    const levelCprs = {};
    for (const e of (cpr.entries || [])) {
      if (!levelCprs[e.diff]) levelCprs[e.diff] = { sum: 0, count: 0 };
      levelCprs[e.diff].sum += e.rate;
      levelCprs[e.diff].count += 1;
    }
    // If CPR at current level >= 75%, they're ready for next level (boost pushes them to ~90%)
    const topLevelCpr = levelCprs[joinable] ? levelCprs[joinable].sum / levelCprs[joinable].count : cprVal;
    // Only let effectiveLevel jump above joinable if we have enough samples
    // AT that joinable level — one lucky completion at 90% shouldn't push
    // a member into the next difficulty tier.
    const topLevelSamples = levelCprs[joinable]?.count || 0;
    const effectiveLevel = (topLevelCpr >= 75 && topLevelSamples >= 3) ? joinable + 1 : joinable;
    freeMems.push({
      uid, name: m.name || m.playerName || uid,
      cpr: cprVal, joinable, effectiveLevel, levelCprs,
      byPosition: cpr.byPosition || {},
      level: m.level || 0,
      samples: cpr.samples || 0,
    });
  }

  // 3. Score every (member, slot) pair
  const pairs = [];
  for (const slot of openSlots) {
    for (const mem of freeMems) {
      if (mem.joinable < slot.difficulty) continue; // can't join this level
      if (mem.effectiveLevel < slot.difficulty) continue; // CPR too low for this level
      if (mem.effectiveLevel > slot.difficulty + 1) continue; // don't recommend members 2+ effective levels above
      // Score: position CPR match + level proximity + expiry urgency
      let score = 0;
      // Position CPR (best indicator of fit)
      // Strip "#1", "#2" suffix to match byPosition keys (e.g. "Thief" not "Thief #1")
      const posBase = slot.position.replace(/\s*#\d+$/, '');
      let posCpr = mem.byPosition?.[`${slot.crimeName}::${posBase}`]?.cpr
                  || mem.byPosition?.[`${slot.crimeName}::${slot.position}`]?.cpr
                  || null;
      // Fallback: historical position CPR from OC history (covers older data + returning members)
      if (!posCpr) {
        const hKey = `${mem.uid}::${slot.crimeName}::${posBase}`;
        const hData = histByPos[hKey];
        if (hData && hData.count >= 1) posCpr = Math.round(hData.rateSum / hData.count * 10) / 10;
      }
      // Fallback: use level-specific CPR for this OC's difficulty, not overall average
      const levelCpr = mem.levelCprs[slot.difficulty]
        ? Math.round(mem.levelCprs[slot.difficulty].sum / mem.levelCprs[slot.difficulty].count * 10) / 10
        : null;
      const usedCpr = posCpr || levelCpr || mem.cpr;
      score += usedCpr * 2;
      // Level fit: prefer members at their effective level
      if (mem.effectiveLevel === slot.difficulty) score += 20;
      else if (mem.effectiveLevel > slot.difficulty) score -= 30; // 1 effective level above: penalty
      // Fill priority: strongly prefer OCs that already have members (0-50 bonus)
      // An OC with 5/6 filled gets 50 * (5/6) ≈ 42 bonus; empty OC gets 0
      score += slot.fillPct * 50;

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
    const pb = p.slot.position.replace(/\s*#\d+$/, '');
    let exactPosCpr = p.member.byPosition?.[`${p.slot.crimeName}::${pb}`]?.cpr
                     || p.member.byPosition?.[`${p.slot.crimeName}::${p.slot.position}`]?.cpr
                     || null;
    // Fallback: historical position CPR
    if (!exactPosCpr) {
      const hKey2 = `${p.member.uid}::${p.slot.crimeName}::${pb}`;
      const hData2 = histByPos[hKey2];
      if (hData2 && hData2.count >= 1) exactPosCpr = Math.round(hData2.rateSum / hData2.count * 10) / 10;
    }
    const lvlCpr = p.member.levelCprs[p.slot.difficulty]
      ? Math.round(p.member.levelCprs[p.slot.difficulty].sum / p.member.levelCprs[p.slot.difficulty].count * 10) / 10
      : null;
    // Best CPR to display: position-specific > level-specific > overall
    const displayCpr = exactPosCpr || lvlCpr || p.member.cpr;
    assignments.push({
      memberId: p.member.uid, memberName: p.member.name,
      memberCpr: displayCpr, memberJoinable: p.member.joinable,
      crimeId: p.slot.crimeId, crimeName: p.slot.crimeName,
      difficulty: p.slot.difficulty, position: p.slot.position,
      score: Math.round(p.score * 10) / 10,
      positionCpr: exactPosCpr,
      levelCpr: lvlCpr,
      isEstimatedCpr: !exactPosCpr && !lvlCpr,
      hoursToExpiry: Math.round(((p.slot.expiredAt || Infinity) - Date.now() / 1000) / 3600 * 10) / 10,
      fillInfo: `${p.slot.filledSlots}/${p.slot.totalSlots}`,
      // Exposed for dev-only diagnostic display (gated client-side to XID 137558):
      samples: p.member.samples || 0,
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
// ═══════════════════════════════════════════════════════════════════════════════
//  AUTO-DISPATCHER ENGINE — personalized "join this OC" recommendation per member
//  Unlike other engines (faction-wide cache), this runs per-request since it's
//  personalized to the requesting player.
// ═══════════════════════════════════════════════════════════════════════════════
function runAutoDispatcher(factionId, data, requestingPlayerId) {
  const crimes = data.crimes || data.availableCrimes || [];
  const members = data.members || {};
  const cprCache = data.cprCache || {};
  const weights = data.weights || {};  // tornprobability.com role weights
  const pid = String(requestingPlayerId);

  // Find the requesting player's info
  const memberArr = Array.isArray(members) ? members : Object.values(members);
  const me = memberArr.find(m => String(m.id || m.playerId || m.uid) === pid);
  if (!me) return { recommendation: null, fallbacks: [], reason: 'Player not found in faction members' };

  const myCpr = cprCache[pid];
  if (!myCpr) return { recommendation: null, fallbacks: [], reason: 'No CPR data for player' };

  // Check if player is already in an OC by scanning crime slots
  let playerInOC = me.inOC || me.status === 'inOC';
  let playerCrimeName = null;
  if (!playerInOC) {
    for (const crime of crimes) {
      if (!Array.isArray(crime.slots)) continue;
      for (const s of crime.slots) {
        const slotUid = String(s.user_id ?? s.user?.id ?? '');
        if (slotUid === pid) { playerInOC = true; playerCrimeName = crime.name || 'Unknown'; break; }
      }
      if (playerInOC) break;
    }
  }
  if (playerInOC) {
    return { recommendation: null, fallbacks: [], reason: 'Already in an OC', inOC: true, crimeName: playerCrimeName };
  }

  // Load OC history for historical position CPR
  const allHistory = loadOcHistory(factionId);
  const histByPos = {};
  for (const h of allHistory) {
    if (!Array.isArray(h.slots)) continue;
    for (const slot of h.slots) {
      if (!slot.userId || !slot.weight) continue;
      const key = `${slot.userId}::${h.crimeName}::${slot.position}`;
      if (!histByPos[key]) histByPos[key] = { rateSum: 0, count: 0 };
      histByPos[key].rateSum += slot.weight;
      histByPos[key].count++;
    }
  }

  // Build player's per-level CPR map
  const myLevelCprs = {};
  for (const e of (myCpr.entries || [])) {
    if (!myLevelCprs[e.diff]) myLevelCprs[e.diff] = { sum: 0, count: 0 };
    myLevelCprs[e.diff].sum += e.rate;
    myLevelCprs[e.diff].count++;
  }
  const myJoinable = myCpr.joinable || 1;
  const myOverallCpr = myCpr.cpr || 0;
  const myByPosition = myCpr.byPosition || {};

  // Collect all open slots in recruiting OCs
  const candidates = [];
  for (const crime of crimes) {
    if (crime.status !== 'Recruiting') continue;
    const slots = crime.slots || [];
    const totalSlots = slots.length;
    const filledSlots = slots.filter(s => s.user_id || s.user?.id);
    const emptySlots = totalSlots - filledSlots.length;

    // Count how many unplanned/recent joins are stacked (for overstacking penalty)
    // "Unplanned" = joined but progress is 0 or very low, meaning they just joined
    const recentJoins = filledSlots.filter(s => {
      const prog = s.user?.progress ?? 100;
      return prog < 10; // progress < 10% = just joined, not yet contributing
    }).length;

    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (s.user_id || s.user?.id) continue; // slot already filled

      // Can I join this level? Hard cap on both ends:
      //   - Skip if my joinable is BELOW the OC's difficulty (can't qualify)
      //   - Skip if my joinable is MORE THAN 1 LEVEL ABOVE the OC's difficulty
      //     (a level-8 player should never be dispatched to a level-2 OC just
      //     because it's near-full + expiring — that's wasted CPR potential.
      //     Same rule the slot-optimizer uses.)
      if (myJoinable < (crime.difficulty || 0)) continue;
      if (myJoinable > (crime.difficulty || 0) + 1) continue;

      const posBase = s.position.replace(/\s*#\d+$/, '');

      // ── Factor 1: CPR x Role Weight (weighted contribution) ──
      // Get my CPR for this specific position
      let posCpr = myByPosition?.[`${crime.name}::${posBase}`]?.cpr
                || myByPosition?.[`${crime.name}::${s.position}`]?.cpr
                || null;
      // Fallback: historical position CPR
      if (!posCpr) {
        const hKey = `${pid}::${crime.name}::${posBase}`;
        const hData = histByPos[hKey];
        if (hData && hData.count >= 1) posCpr = Math.round(hData.rateSum / hData.count * 10) / 10;
      }
      // Fallback: level-specific CPR
      const lvlCpr = myLevelCprs[crime.difficulty]
        ? Math.round(myLevelCprs[crime.difficulty].sum / myLevelCprs[crime.difficulty].count * 10) / 10
        : null;
      const effectiveCpr = posCpr || lvlCpr || myOverallCpr;

      // Get role weight from tornprobability.com data
      const crimeWeights = weights[crime.name] || {};
      const roleWeight = crimeWeights[posBase] || crimeWeights[s.position] || 0;
      // Normalize weight: tornprobability returns % (sum ~100), convert to 0-1 scale
      const normalizedWeight = roleWeight / 100;

      // Weighted contribution: how much this slot benefits from MY cpr
      const weightedContribution = effectiveCpr * (normalizedWeight > 0 ? normalizedWeight : 0.15);

      // ── Factor 2: Time priority (last slot = unblock execution) ──
      let timePriority = 1.0;
      if (emptySlots === 1) timePriority = 2.5;       // I'm the LAST slot — huge bonus
      else if (emptySlots === 2) timePriority = 1.6;   // Near completion
      else if (emptySlots <= 3) timePriority = 1.2;

      // Expiry urgency stacks on top
      const hoursToExpiry = ((crime.expired_at || Infinity) - Date.now() / 1000) / 3600;
      if (hoursToExpiry < 4) timePriority *= 1.8;
      else if (hoursToExpiry < 8) timePriority *= 1.4;
      else if (hoursToExpiry < 16) timePriority *= 1.1;

      // ── Factor 3: Overstacking penalty ──
      // Don't recommend joining behind 2+ freshly-joined members (queue behind them)
      let overstackPenalty = 1.0;
      if (recentJoins >= 3) overstackPenalty = 0.4;
      else if (recentJoins >= 2) overstackPenalty = 0.65;
      else if (recentJoins >= 1) overstackPenalty = 0.85;

      // ── Factor 4: Level matching ──
      // Don't waste high-CPR players on low-level OCs
      let levelMatch = 1.0;
      const diff = crime.difficulty || 0;
      if (myJoinable > diff + 1) levelMatch = 0.5;  // 2+ levels above = waste
      else if (myJoinable > diff) levelMatch = 0.8;  // 1 level above = slight waste
      else if (myJoinable === diff) levelMatch = 1.0; // perfect match

      // ── Factor 5: Scope efficiency (crime progress) ──
      // Prefer OCs that are further along in planning
      const filledPct = filledSlots.length / totalSlots;
      const scopeBonus = 1.0 + (filledPct * 0.4); // up to 1.4x for nearly-full OCs

      // ── Final score ──
      const score = weightedContribution * timePriority * overstackPenalty * levelMatch * scopeBonus;

      // Use ready_at from the API if available (actual execution timestamp)
      // Otherwise estimate based on empty slots
      let readyAtHours = null;
      if (crime.ready_at) {
        readyAtHours = Math.round(((crime.ready_at - Date.now() / 1000) / 3600) * 10) / 10;
        if (readyAtHours < 0) readyAtHours = null; // already passed
      }

      candidates.push({
        crimeId: crime.id,
        crimeName: crime.name,
        difficulty: diff,
        position: s.position,
        positionBase: posBase,
        slotIndex: i,
        score: Math.round(score * 100) / 100,
        // Display data
        cpr: effectiveCpr,
        cprSource: posCpr ? 'position' : lvlCpr ? 'level' : 'overall',
        roleWeight: Math.round(normalizedWeight * 100),
        emptySlots,
        totalSlots,
        filledPct: Math.round(filledPct * 100),
        hoursToExpiry: hoursToExpiry === Infinity ? null : Math.round(hoursToExpiry * 10) / 10,
        readyAtHours, // actual execution countdown from Torn API
        isLastSlot: emptySlots === 1,
        // Scoring breakdown for transparency
        breakdown: {
          weightedContribution: Math.round(weightedContribution * 100) / 100,
          timePriority: Math.round(timePriority * 100) / 100,
          overstackPenalty: Math.round(overstackPenalty * 100) / 100,
          levelMatch: Math.round(levelMatch * 100) / 100,
          scopeBonus: Math.round(scopeBonus * 100) / 100,
        },
      });
    }
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  // Top recommendation + 3 fallbacks
  const top = candidates[0] || null;
  const fallbacks = candidates.slice(1, 4);

  return {
    recommendation: top,
    fallbacks,
    totalCandidates: candidates.length,
    player: { id: pid, name: me.name || me.playerName || pid, cpr: myOverallCpr, joinable: myJoinable },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  OC HISTORY COLLECTOR — logs completed OC results for future failure rate analysis
// ═══════════════════════════════════════════════════════════════════════════════
const __routes_dir = pathDirname(fileURLToPath(import.meta.url));
const OC_HISTORY_DIR = pathJoin(process.env.DATA_DIR || pathJoin(__routes_dir, 'data'), 'oc-history');
const _seenCrimeIds = new Set(); // prevent duplicate logging per restart

function collectOcHistory(factionId, data) {
  try {
    const crimes = data.crimes || data.availableCrimes || [];
    const members = data.members || {};
    const memberArr = Array.isArray(members) ? members : Object.values(members);
    const nameMap = {};
    for (const m of memberArr) { nameMap[String(m.id || m.playerId || m.uid)] = m.name || m.playerName || ''; }

    // Use completedCrimes from oc-spawn cache if available, else filter from crimes array
    const completedSrc = data.completedCrimes || crimes;
    const completed = completedSrc.filter(c => c.status === 'Successful' || c.status === 'Failed');
    if (completed.length === 0) return;

    if (!existsSync(OC_HISTORY_DIR)) mkdirSync(OC_HISTORY_DIR, { recursive: true });
    const histFile = pathJoin(OC_HISTORY_DIR, `${factionId}.json`);
    let history = [];
    try { history = JSON.parse(readFileSync(histFile, 'utf-8')); } catch (_) {}

    let added = 0;
    for (const c of completed) {
      const cid = String(c.id);
      if (_seenCrimeIds.has(cid)) continue;
      // Check if already in history file
      if (history.some(h => String(h.crimeId) === cid)) { _seenCrimeIds.add(cid); continue; }
      _seenCrimeIds.add(cid);

      // Merge in flyer-delay observations collected while the crime was
      // in Planning. The store keys are "crimeId::memberId"; pull any
      // that match and attach to the corresponding slot. Delete once
      // baked so the in-memory store stays tight.
      const fdMap = _flyerDelays.get(String(factionId));
      const slots = (c.slots || []).map(s => {
        const uid = String(s.user_id || s.user?.id || '');
        const slot = {
          position: s.position,
          userId: uid,
          userName: nameMap[uid] || '',
          weight: s.checkpoint_pass_rate || 0,
        };
        if (fdMap && uid) {
          const key = `${cid}::${uid}`;
          const obs = fdMap.get(key);
          if (obs && obs.delayedSec > 0) {
            slot.delayedSec = Math.round(obs.delayedSec);
            fdMap.delete(key);
          }
        }
        return slot;
      });
      if (fdMap) {
        // Also clear any other entries for this crimeId — no longer useful.
        for (const k of Array.from(fdMap.keys())) {
          if (k.startsWith(`${cid}::`)) fdMap.delete(k);
        }
        if (fdMap.size === 0) _flyerDelays.delete(String(factionId));
        scheduleFlyerDelaysSave();
      }

      // Store rewards data for payout tracking (only present on successful crimes)
      const rewards = c.rewards ? {
        money: c.rewards.money || 0,
        respect: c.rewards.respect || 0,
        items: c.rewards.items || [],
      } : null;

      history.push({
        crimeId: cid, crimeName: c.name, difficulty: c.difficulty || 0,
        status: c.status, completedAt: Date.now(),
        executedAt: c.executed_at || 0,
        planningAt: c.planning_at || 0,
        slots, rewards,
      });
      added++;
    }

    if (added > 0) {
      // v3.1.45: raised from 500 to 5000 so pagination backfill of the
      // full 90-day window can land without truncating older entries.
      if (history.length > 5000) history = history.slice(-5000);
      writeFileSync(histFile, JSON.stringify(history, null, 2));
      console.log(`[oc-history] Logged ${added} completed OC(s) for faction ${factionId}`);
    }
  } catch (e) {
    console.error('[oc-history] Error:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SHARED OC HISTORY LOADER — merges API completedCrimes + on-disk history
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Returns a unified array of completed OC entries from two sources:
 *  1. getCachedCompletedCrimes(factionId) — recent Torn API data (has checkpoint_pass_rate per slot)
 *  2. /opt/warboard/server/data/oc-history/{factionId}.json — our long-term collected history
 *
 * Deduplicates by crimeId. API data wins on conflicts (fresher CPR values).
 * Each entry normalised to: { crimeId, crimeName, difficulty, status, executedAt, slots: [{ userId, position, weight }] }
 */
function loadOcHistory(factionId) {
  const apiCrimes = getCachedCompletedCrimes(factionId) || [];

  // Load on-disk history
  let diskHistory = [];
  try {
    const histFile = pathJoin(OC_HISTORY_DIR, `${factionId}.json`);
    if (existsSync(histFile)) {
      diskHistory = JSON.parse(readFileSync(histFile, 'utf-8'));
    }
  } catch (_) { /* file missing or corrupt — skip */ }

  // Index API crimes by crimeId for fast dedup
  const seen = new Set();
  const merged = [];

  // API crimes first (higher fidelity — have checkpoint_pass_rate per slot)
  for (const c of apiCrimes) {
    const cid = String(c.id);
    if (seen.has(cid)) continue;
    seen.add(cid);
    merged.push({
      crimeId: cid,
      crimeName: c.name,
      difficulty: c.difficulty || 0,
      status: c.status,
      executedAt: c.executed_at || c.planning_at || c.created_at || 0,
      slots: (c.slots || []).map(s => ({
        userId: String(s.user_id ?? s.user?.id ?? ''),
        position: (s.position || '').replace(/\s*#\d+$/, ''),
        weight: s.checkpoint_pass_rate ?? s.success_chance ?? 0,
        userName: s.user?.name || '',
      })),
      rewards: c.rewards ? { money: c.rewards.money || 0, respect: c.rewards.respect || 0, items: c.rewards.items || [] } : null,
      source: 'api',
    });
  }

  // Disk history second (older entries the API no longer returns)
  for (const h of diskHistory) {
    const cid = String(h.crimeId);
    if (seen.has(cid)) continue;
    seen.add(cid);
    merged.push({
      crimeId: cid,
      crimeName: h.crimeName,
      difficulty: h.difficulty || 0,
      status: h.status,
      executedAt: h.completedAt ? Math.floor(h.completedAt / 1000) : (h.executedAt || 0),
      slots: (h.slots || []).map(s => ({
        userId: String(s.userId || ''),
        position: (s.position || '').replace(/\s*#\d+$/, ''),
        weight: s.weight || 0,
        userName: s.userName || '',
      })),
      rewards: h.rewards || null,
      source: 'disk',
    });
  }

  // Sort oldest → newest
  merged.sort((a, b) => a.executedAt - b.executedAt);
  return merged;
}

// v3.1.38 / v3.1.44: empirical "top-tier hit rate" per scenario, computed
// from faction's historical completions. Since Torn doesn't label
// outcomes by ending tier (goodEnding1 vs 2 vs 3 …), we bucket by
// *effective payout* = cash money + estimated market value of any
// dropped items (via item-values cache refreshed from /v2/torn?
// selections=items). Fixes the empty "Top end $" problem on scenarios
// like Best of the Lot / Smoke and Wing Mirrors where the reward is an
// item drop rather than cash. Completions whose effective payout is in
// the top quartile for that scenario are counted as "top-tier hits."
function computeScenarioHitRates(factionId) {
  const hist = loadOcHistory(factionId);
  const byName = {};
  for (const h of hist) {
    const money = Number(h.rewards?.money) || 0;
    const items = Array.isArray(h.rewards?.items) ? h.rewards.items : [];
    let itemsValue = 0;
    for (const it of items) {
      const qty = Number(it?.quantity) || 0;
      if (qty <= 0) continue;
      itemsValue += qty * getItemMarketValue(it.id);
    }
    const payout = money + itemsValue;
    if (payout <= 0) continue; // skip failures + no-reward + all-unpriced items
    const name = (h.crimeName || '').trim();
    if (!name) continue;
    if (!byName[name]) byName[name] = [];
    byName[name].push(payout);
  }
  const MIN_SAMPLES = 4;
  const out = {};
  for (const [name, payouts] of Object.entries(byName)) {
    if (payouts.length < MIN_SAMPLES) {
      out[name] = { count: payouts.length, topCount: null, rate: null, threshold: null };
      continue;
    }
    const sorted = [...payouts].sort((a, b) => a - b);
    // Top quartile threshold (75th percentile). Completions ≥ threshold
    // are counted as top-tier hits.
    const qIdx = Math.floor(sorted.length * 0.75);
    const threshold = sorted[qIdx];
    const topPayouts = payouts.filter(p => p >= threshold);
    const topAvgPayout = topPayouts.length
      ? topPayouts.reduce((a, b) => a + b, 0) / topPayouts.length
      : null;
    out[name] = {
      count: payouts.length,
      topCount: topPayouts.length,
      rate: topPayouts.length / payouts.length,
      threshold,
      // v3.1.41: avg dollar payout across top-quartile completions.
      // Shown next to the Top end % column so admins see what "top tier"
      // actually pays for their faction on this scenario.
      topAvgPayout,
    };
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FAILURE RISK ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
function runFailureRisk(factionId, data) {
  const crimes = data.crimes || data.availableCrimes || [];
  const cprCache = data.cprCache || {};
  const weights = data.weights || {};
  const members = data.members || {};
  const memberArr = Array.isArray(members) ? members : Object.values(members);
  const nameMap = {};
  for (const m of memberArr) { nameMap[String(m.id || m.playerId || m.uid)] = m.name || m.playerName || ''; }

  // Build historical failure rates per crime+position from OC history
  const allHistory = loadOcHistory(factionId);
  const histRates = {}; // "crimeName::position" -> { succeeded, failed }
  const memberHistRates = {}; // "uid::crimeName::position" -> { succeeded, failed }
  for (const h of allHistory) {
    if (h.status !== 'Successful' && h.status !== 'Failed') continue;
    for (const slot of (h.slots || [])) {
      const posKey = `${h.crimeName}::${slot.position}`;
      if (!histRates[posKey]) histRates[posKey] = { succeeded: 0, failed: 0 };
      if (h.status === 'Successful') histRates[posKey].succeeded++;
      else histRates[posKey].failed++;
      // Per-member rates
      if (slot.userId) {
        const mKey = `${slot.userId}::${posKey}`;
        if (!memberHistRates[mKey]) memberHistRates[mKey] = { succeeded: 0, failed: 0 };
        if (h.status === 'Successful') memberHistRates[mKey].succeeded++;
        else memberHistRates[mKey].failed++;
      }
    }
  }

  const results = [];

  // Helper: convert crime name to camelCase key used in weights
  function toCamelKey(name) {
    return name.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+(.)/g, (_, c) => c.toUpperCase()).replace(/^(.)/, (_, c) => c.toUpperCase());
  }

  for (const crime of crimes) {
    if (crime.status !== 'Recruiting' && crime.status !== 'Planning') continue;
    const slots = crime.slots || [];
    const slotRisks = [];
    let hasEmpty = false;
    const crimeWeights = weights[toCamelKey(crime.name)] || {};

    for (const s of slots) {
      const uid = String(s.user_id || s.user?.id || '');
      if (!uid) { hasEmpty = true; continue; }
      const cpr = cprCache[uid];
      const posKey = `${crime.name}::${s.position}`;
      const posCpr = cpr?.byPosition?.[posKey]?.cpr || cpr?.cpr || 0;
      // Look up weight from weights object using position label
      const posLabel = s.position_info?.label || s.position || '';
      const posBase = posLabel.replace(/\s*#\d+$/, ''); // strip "#1" etc
      // Try exact label first, then numbered variants
      let weight = crimeWeights[posLabel] || crimeWeights[posBase] || crimeWeights[posLabel.replace(/\s/g, '')] || crimeWeights[posBase.replace(/\s/g, '')] || 0;
      // Also try with number suffix: Looter1, Looter2 etc
      if (!weight && s.position_info?.number) {
        weight = crimeWeights[posBase.replace(/\s/g, '') + s.position_info.number] || 0;
      }

      // Check historical failure rate for this member+crime+position
      const posKeyBase = `${crime.name}::${posBase}`;
      const mHist = memberHistRates[`${uid}::${posKeyBase}`];
      const pHist = histRates[posKeyBase];
      // Historical success rate: prefer member-specific, fall back to position-wide
      const histSuccessRate = mHist && (mHist.succeeded + mHist.failed) >= 3
        ? mHist.succeeded / (mHist.succeeded + mHist.failed)
        : pHist && (pHist.succeeded + pHist.failed) >= 3
          ? pHist.succeeded / (pHist.succeeded + pHist.failed)
          : null;

      // Members at or above 60% CPR are near-certain success; only below 60% is real risk
      // Blend with historical rate when available (70% CPR-based, 30% historical)
      let effectiveSuccessProb = posCpr >= 60 ? 0.98 : posCpr / 100;
      if (histSuccessRate !== null) {
        effectiveSuccessProb = effectiveSuccessProb * 0.7 + histSuccessRate * 0.3;
      }
      const riskScore = weight > 0 && posCpr < 60 ? Math.round((1 - effectiveSuccessProb) * weight) : 0;
      slotRisks.push({
        uid, name: nameMap[uid] || s.user?.name || uid,
        position: s.position, cpr: posCpr, weight,
        riskScore, successProb: effectiveSuccessProb,
        histRate: histSuccessRate !== null ? Math.round(histSuccessRate * 100) : null,
      });
    }

    // Only analyze fully filled OCs — no empty slots
    const filledSlots = slotRisks.filter(s => s.successProb > 0);
    const totalSlots = slots.length;
    const emptyCount = slots.filter(s => !s.user_id && !s.user?.id).length;
    if (emptyCount > 0 || filledSlots.length === 0) continue;
    let overallSuccess = filledSlots.reduce((acc, s) => acc * s.successProb, 1);
    const failureRisk = Math.round((1 - overallSuccess) * 1000) / 10;

    // Find weakest link: highest risk score
    slotRisks.sort((a, b) => b.riskScore - a.riskScore);
    const weakestLink = slotRisks[0] || null;

    // Flag high-weight + low CPR combos (below 60% MINCPR threshold)
    const dangerSlots = slotRisks.filter(s => s.weight >= 20 && s.cpr < 60);

    results.push({
      crimeId: crime.id, crimeName: crime.name, difficulty: crime.difficulty || 0,
      failureRisk, overallSuccess: Math.round(overallSuccess * 1000) / 10,
      totalSlots, filledSlots: filledSlots.length, emptySlots: slots.filter(s => !s.user_id && !s.user?.id).length,
      weakestLink: weakestLink ? { name: weakestLink.name, position: weakestLink.position, cpr: weakestLink.cpr, weight: weakestLink.weight } : null,
      dangerSlots: dangerSlots.map(s => ({ name: s.name, position: s.position, cpr: s.cpr, weight: s.weight })),
      slotRisks,
    });
  }

  // Sort by failure risk descending (riskiest OCs first)
  results.sort((a, b) => b.failureRisk - a.failureRisk);
  return { crimes: results };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CPR FORECASTER ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
function runCprForecaster(factionId, data) {
  const allHistory = loadOcHistory(factionId);
  if (!allHistory || allHistory.length === 0) return { members: [] };

  const members = data.members || {};
  const memberArr = Array.isArray(members) ? members : Object.values(members);
  const nameMap = {};
  for (const m of memberArr) { nameMap[String(m.id || m.playerId || m.uid)] = m.name || m.playerName || ''; }

  const now = Date.now() / 1000;
  const DAY = 86400;
  const windows = [
    { label: '90d', from: now - 90 * DAY, days: 90 },
    { label: '60d', from: now - 60 * DAY, days: 60 },
    { label: '30d', from: now - 30 * DAY, days: 30 },
    { label: '14d', from: now - 14 * DAY, days: 14 },
    { label: '7d',  from: now - 7 * DAY,  days: 7 },
  ];

  // Build per-member, per-level, per-role entries from merged history
  const memberData = {}; // uid -> [{ execAt, diff, role, rate }]
  for (const crime of allHistory) {
    const execAt = crime.executedAt || 0;
    if (!execAt || !Array.isArray(crime.slots)) continue;
    const diff = crime.difficulty || 0;
    for (const slot of crime.slots) {
      const uid = String(slot.userId || '');
      if (!uid) continue;
      const rate = slot.weight ?? null;
      if (rate === null || rate === 0) continue;
      const role = slot.position || '';
      if (!memberData[uid]) memberData[uid] = [];
      memberData[uid].push({ execAt, diff, role, rate });
    }
  }

  function calcTrend(entries) {
    entries.sort((a, b) => a.execAt - b.execAt);
    const mid = Math.floor(entries.length / 2);
    const firstHalf = entries.slice(0, mid);
    const secondHalf = entries.slice(mid);
    const firstAvg = firstHalf.reduce((s, e) => s + e.rate, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((s, e) => s + e.rate, 0) / secondHalf.length;
    const timeSpanDays = (entries[entries.length - 1].execAt - entries[0].execAt) / DAY;
    const change = secondAvg - firstAvg;
    const changePerMonth = timeSpanDays > 7 ? Math.round((change / timeSpanDays) * 30 * 10) / 10 : 0;
    const projected30d = Math.round(Math.min(100, Math.max(0, secondAvg + changePerMonth)) * 10) / 10;
    let trend = 'stable';
    if (changePerMonth >= 2) trend = 'improving';
    else if (changePerMonth <= -2) trend = 'declining';
    return {
      currentCpr: Math.round(secondAvg * 10) / 10, trend, changePerMonth, projected30d,
      projectedMin: Math.round(Math.max(0, projected30d - 3) * 10) / 10,
      projectedMax: Math.round(Math.min(100, projected30d + 3) * 10) / 10,
      count: entries.length,
    };
  }

  const results = [];
  for (const [uid, entries] of Object.entries(memberData)) {
    if (entries.length < 2) continue;

    // Group by level, then by role within each level
    const byLevel = {};
    for (const e of entries) {
      const key = e.diff;
      if (!byLevel[key]) byLevel[key] = {};
      if (!byLevel[key][e.role]) byLevel[key][e.role] = [];
      byLevel[key][e.role].push(e);
    }

    const levels = [];
    for (const [lvl, roles] of Object.entries(byLevel)) {
      const roleBreakdown = [];
      for (const [role, roleEntries] of Object.entries(roles)) {
        if (roleEntries.length < 2) {
          // Still show single-entry roles but without trend
          const avg = roleEntries.reduce((s, e) => s + e.rate, 0) / roleEntries.length;
          roleBreakdown.push({
            role, currentCpr: Math.round(avg * 10) / 10, trend: 'stable',
            changePerMonth: 0, projected30d: Math.round(avg * 10) / 10,
            projectedMin: Math.round(Math.max(0, avg - 3) * 10) / 10,
            projectedMax: Math.round(Math.min(100, avg + 3) * 10) / 10,
            count: roleEntries.length,
          });
          continue;
        }
        const t = calcTrend(roleEntries);
        roleBreakdown.push({ role, ...t });
      }
      roleBreakdown.sort((a, b) => b.count - a.count); // most OCs first

      // Level-wide: derive from role breakdowns (weighted by count)
      if (roleBreakdown.length === 0) continue;
      const totalCount = roleBreakdown.reduce((s, r) => s + r.count, 0);
      const weightedCpr = roleBreakdown.reduce((s, r) => s + r.currentCpr * r.count, 0) / totalCount;
      const weightedChange = roleBreakdown.reduce((s, r) => s + r.changePerMonth * r.count, 0) / totalCount;
      const roundedChange = Math.round(weightedChange * 10) / 10;
      let lvlTrend = 'stable';
      if (roundedChange >= 2) lvlTrend = 'improving';
      else if (roundedChange <= -2) lvlTrend = 'declining';
      const lvlProjected = Math.round(Math.min(100, Math.max(0, weightedCpr + roundedChange)) * 10) / 10;
      levels.push({
        level: Number(lvl), currentCpr: Math.round(weightedCpr * 10) / 10,
        trend: lvlTrend, changePerMonth: roundedChange,
        projected30d: lvlProjected,
        projectedMin: Math.round(Math.max(0, lvlProjected - 3) * 10) / 10,
        projectedMax: Math.round(Math.min(100, lvlProjected + 3) * 10) / 10,
        count: totalCount, roles: roleBreakdown,
      });
    }

    if (levels.length === 0) continue;
    levels.sort((a, b) => b.level - a.level);

    const mainCpr = data.cprCache?.[uid]?.cpr ?? levels[0].currentCpr;
    const joinable = data.cprCache?.[uid]?.joinable ?? 1;
    const primaryLevel = levels[0];

    results.push({
      uid, name: nameMap[uid] || uid,
      currentCpr: mainCpr, joinable,
      trend: primaryLevel.trend, changePerMonth: primaryLevel.changePerMonth,
      levels, totalEntries: entries.length,
    });
  }

  const trendOrder = { declining: 0, improving: 1, stable: 2 };
  results.sort((a, b) => {
    if (trendOrder[a.trend] !== trendOrder[b.trend]) return trendOrder[a.trend] - trendOrder[b.trend];
    return Math.abs(b.changePerMonth) - Math.abs(a.changePerMonth);
  });

  return { members: results };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MEMBER PROJECTOR ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
function runMemberProjector(factionId, data) {
  const allHistory = loadOcHistory(factionId);
  const members = data.members || {};
  const cprCache = data.cprCache || {};
  const memberArr = Array.isArray(members) ? members : Object.values(members);
  const nameMap = {};
  for (const m of memberArr) {
    nameMap[String(m.id || m.playerId || m.uid)] = m.name || m.playerName || '';
  }

  // Build per-member OC participation stats from merged history (API + disk)
  const memberHistory = {}; // uid -> { totalOCs, firstOCAt, lastOCAt, byLevel: { [diff]: { count, avgCpr, roles } } }
  for (const crime of allHistory) {
    const execAt = crime.executedAt || 0;
    if (!execAt || !Array.isArray(crime.slots)) continue;
    const diff = crime.difficulty || 0;
    for (const slot of crime.slots) {
      const uid = String(slot.userId || '');
      if (!uid) continue;
      const rate = slot.weight ?? null;
      if (rate === null || rate === 0) continue;
      const role = slot.position || '';

      if (!memberHistory[uid]) memberHistory[uid] = { totalOCs: 0, firstOCAt: execAt, lastOCAt: execAt, byLevel: {} };
      const h = memberHistory[uid];
      h.totalOCs++;
      if (execAt < h.firstOCAt) h.firstOCAt = execAt;
      if (execAt > h.lastOCAt) h.lastOCAt = execAt;

      if (!h.byLevel[diff]) h.byLevel[diff] = { count: 0, rateSum: 0, roles: {} };
      h.byLevel[diff].count++;
      h.byLevel[diff].rateSum += rate;
      if (!h.byLevel[diff].roles[role]) h.byLevel[diff].roles[role] = { count: 0, rateSum: 0 };
      h.byLevel[diff].roles[role].count++;
      h.byLevel[diff].roles[role].rateSum += rate;
    }
  }

  // Build benchmark: for each OC level, what's the avg CPR of members who participate
  const levelBenchmarks = {}; // diff -> { avgCpr, memberCount, minCpr, maxCpr }
  for (const [uid, h] of Object.entries(memberHistory)) {
    for (const [diff, ld] of Object.entries(h.byLevel)) {
      const avgCpr = ld.rateSum / ld.count;
      if (!levelBenchmarks[diff]) levelBenchmarks[diff] = { cprSum: 0, memberCount: 0, minCpr: 100, maxCpr: 0 };
      levelBenchmarks[diff].cprSum += avgCpr;
      levelBenchmarks[diff].memberCount++;
      if (avgCpr < levelBenchmarks[diff].minCpr) levelBenchmarks[diff].minCpr = avgCpr;
      if (avgCpr > levelBenchmarks[diff].maxCpr) levelBenchmarks[diff].maxCpr = avgCpr;
    }
  }
  for (const [diff, b] of Object.entries(levelBenchmarks)) {
    b.avgCpr = Math.round(b.cprSum / b.memberCount * 10) / 10;
    b.minCpr = Math.round(b.minCpr * 10) / 10;
    b.maxCpr = Math.round(b.maxCpr * 10) / 10;
  }

  // Build similar-member progression data: how long did it take members to go from level N to N+1
  const progressionTimes = {}; // "fromLevel->toLevel" -> [days]
  for (const [uid, h] of Object.entries(memberHistory)) {
    const levels = Object.keys(h.byLevel).map(Number).sort((a, b) => a - b);
    for (let i = 0; i < levels.length - 1; i++) {
      const fromLvl = levels[i];
      const toLvl = levels[i + 1];
      // Find earliest OC at toLvl and latest OC at fromLvl before that
      const fromEntries = [];
      const toEntries = [];
      for (const crime of allHistory) {
        const execAt = crime.executedAt || 0;
        if (!execAt || !Array.isArray(crime.slots)) continue;
        const diff = crime.difficulty || 0;
        for (const slot of crime.slots) {
          if (String(slot.userId || '') !== uid) continue;
          if (diff === fromLvl) fromEntries.push(execAt);
          if (diff === toLvl) toEntries.push(execAt);
        }
      }
      if (fromEntries.length > 0 && toEntries.length > 0) {
        const firstTo = Math.min(...toEntries);
        const lastFrom = Math.max(...fromEntries.filter(t => t <= firstTo));
        if (lastFrom > 0) {
          const days = Math.round((firstTo - lastFrom) / 86400);
          const key = `${fromLvl}->${toLvl}`;
          if (!progressionTimes[key]) progressionTimes[key] = [];
          progressionTimes[key].push(days);
        }
      }
    }
  }

  // Average progression times
  const avgProgressionDays = {};
  for (const [key, times] of Object.entries(progressionTimes)) {
    if (times.length === 0) continue;
    const sorted = [...times].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    avgProgressionDays[key] = { median, avg: Math.round(times.reduce((s, t) => s + t, 0) / times.length), samples: times.length };
  }

  const now = Math.floor(Date.now() / 1000);
  const DAY = 86400;
  const results = [];

  for (const m of memberArr) {
    const uid = String(m.id || m.playerId || m.uid);
    const cpr = cprCache[uid];
    if (!cpr) continue;

    const history = memberHistory[uid];
    const currentLevel = cpr.effectiveTop || cpr.highestLevel || 0;
    const joinable = cpr.joinable || currentLevel;
    const isEstimated = !!cpr.estimated; // no real OC data, using level-based estimate

    // Current level CPR
    let currentLevelCpr = cpr.cpr;
    if (history?.byLevel[currentLevel]) {
      currentLevelCpr = Math.round(history.byLevel[currentLevel].rateSum / history.byLevel[currentLevel].count * 10) / 10;
    }

    // Best roles at current level
    const bestRoles = [];
    if (history?.byLevel[currentLevel]?.roles) {
      for (const [role, rd] of Object.entries(history.byLevel[currentLevel].roles)) {
        bestRoles.push({ role, cpr: Math.round(rd.rateSum / rd.count * 10) / 10, count: rd.count });
      }
      bestRoles.sort((a, b) => b.cpr - a.cpr);
    }

    // Projection: can they move up?
    const nextLevel = currentLevel + 1;
    let projection = null;
    if (nextLevel <= 10) {
      const nextBench = levelBenchmarks[nextLevel];
      const progressKey = `${currentLevel}->${nextLevel}`;
      const progression = avgProgressionDays[progressKey];

      // CPR gap analysis
      const MINCPR = 60; // minimum to be viable
      const gapToBenchmark = nextBench ? Math.round((nextBench.avgCpr - currentLevelCpr) * 10) / 10 : null;

      // Estimate readiness based on CPR trend from CPR Forecaster data
      let readiness = 'not_ready';
      let readinessLabel = 'Not Ready';
      let estimatedDays = null;

      if (currentLevelCpr >= 75 && joinable >= nextLevel) {
        readiness = 'ready';
        readinessLabel = 'Ready Now';
        estimatedDays = 0;
      } else if (currentLevelCpr >= 70) {
        readiness = 'developing';
        readinessLabel = 'Developing';
        if (progression) {
          estimatedDays = progression.median;
          const cprAboveThresh = currentLevelCpr - 70;
          const cprNeeded = 75 - 70; // 5 points from developing to ready
          const progress = Math.min(1, Math.max(0, cprAboveThresh / cprNeeded));
          estimatedDays = Math.round(progression.median * (1 - progress * 0.7));
        }
      } else if (currentLevelCpr >= MINCPR) {
        readiness = 'building';
        readinessLabel = 'Building';
      } else {
        readiness = 'not_ready';
        readinessLabel = 'Not Ready';
      }

      // Suggested roles at next level based on best current roles (role names carry across levels)
      const suggestedRoles = bestRoles.slice(0, 3).map(r => r.role);

      projection = {
        nextLevel,
        benchmarkCpr: nextBench ? nextBench.avgCpr : null,
        benchmarkRange: nextBench ? { min: nextBench.minCpr, max: nextBench.maxCpr } : null,
        gapToBenchmark,
        readiness,
        readinessLabel,
        estimatedDays,
        progressionData: progression || null,
        suggestedRoles,
      };
    }

    // Experience summary
    const totalOCs = history?.totalOCs || 0;
    const daysSinceFirst = history ? Math.round((now - history.firstOCAt) / DAY) : 0;
    const daysSinceLast = history ? Math.round((now - history.lastOCAt) / DAY) : 0;

    results.push({
      uid,
      name: nameMap[uid] || uid,
      level: m.level || 0,
      daysInFaction: m.days_in_faction || 0,
      currentOcLevel: currentLevel,
      currentLevelCpr,
      joinableLevel: joinable,
      isEstimated,
      bestRoles: bestRoles.slice(0, 3),
      totalOCs,
      daysSinceFirstOC: daysSinceFirst,
      daysSinceLastOC: daysSinceLast,
      projection,
    });
  }

  // Sort: ready first, then developing, then not ready. Within each group, by next level desc then CPR desc.
  const readinessOrder = { ready: 0, developing: 1, building: 2, not_ready: 3 };
  results.sort((a, b) => {
    const aR = readinessOrder[a.projection?.readiness] ?? 2;
    const bR = readinessOrder[b.projection?.readiness] ?? 2;
    if (aR !== bR) return aR - bR;
    if ((a.projection?.nextLevel || 0) !== (b.projection?.nextLevel || 0)) return (b.projection?.nextLevel || 0) - (a.projection?.nextLevel || 0);
    return b.currentLevelCpr - a.currentLevelCpr;
  });

  return {
    members: results,
    benchmarks: levelBenchmarks,
    progressionTimes: avgProgressionDays,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MEMBER RELIABILITY ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
function runMemberReliability(factionId, data) {
  const allHistory = loadOcHistory(factionId);
  const members = data.members || {};
  const cprCache = data.cprCache || {};
  const memberArr = Array.isArray(members) ? members : Object.values(members);
  const nameMap = {};
  for (const m of memberArr) {
    nameMap[String(m.id || m.playerId || m.uid)] = m.name || m.playerName || '';
  }

  const now = Math.floor(Date.now() / 1000);
  const DAY = 86400;
  const LOOKBACK = 90 * DAY;
  const cutoff = now - LOOKBACK;

  // Build per-member participation stats from merged history (API + disk)
  const memberStats = {}; // uid -> { total, succeeded, failed, entries: [{ execAt, diff, status, role }] }
  for (const crime of allHistory) {
    const execAt = crime.executedAt || 0;
    if (!execAt || execAt < cutoff || !Array.isArray(crime.slots)) continue;
    const diff = crime.difficulty || 0;
    const status = crime.status || '';
    const isSuccess = status === 'Successful';
    const isFailed = status === 'Failed';
    if (!isSuccess && !isFailed) continue;

    for (const slot of crime.slots) {
      const uid = String(slot.userId || '');
      if (!uid) continue;
      const role = slot.position || '';

      if (!memberStats[uid]) memberStats[uid] = { total: 0, succeeded: 0, failed: 0, entries: [] };
      memberStats[uid].total++;
      if (isSuccess) memberStats[uid].succeeded++;
      if (isFailed) memberStats[uid].failed++;
      memberStats[uid].entries.push({ execAt, diff, status, role });
    }
  }

  // Calculate consistency: split 90 days into 6 windows of 15 days each
  // A consistent member participates in most windows
  const WINDOW_SIZE = 15 * DAY;
  const NUM_WINDOWS = 6;

  function calcConsistency(entries) {
    if (entries.length < 2) return 0;
    const windows = new Set();
    for (const e of entries) {
      const windowIdx = Math.floor((e.execAt - cutoff) / WINDOW_SIZE);
      windows.add(Math.min(windowIdx, NUM_WINDOWS - 1));
    }
    return Math.round(windows.size / NUM_WINDOWS * 100);
  }

  // Calculate streak: current streak of successive successful OCs
  function calcStreak(entries) {
    const sorted = [...entries].sort((a, b) => b.execAt - a.execAt); // newest first
    let streak = 0;
    for (const e of sorted) {
      if (e.status === 'Successful') streak++;
      else break;
    }
    return streak;
  }

  const results = [];

  for (const m of memberArr) {
    const uid = String(m.id || m.playerId || m.uid);
    const stats = memberStats[uid];
    const cpr = cprCache[uid];

    // Activity score based on current status
    let activityScore = 0;
    let activityLabel = 'Unknown';
    const lastActionStatus = (m.last_action?.status || 'Offline').toLowerCase();
    const lastActionTs = m.last_action?.timestamp || 0;
    const statusState = (m.status?.state || 'Okay').toLowerCase();
    const daysSinceAction = lastActionTs > 0 ? Math.round((now - lastActionTs) / DAY) : 999;

    if (statusState === 'hospitalized' || statusState === 'jail') {
      activityScore = 30;
      activityLabel = statusState === 'hospitalized' ? 'Hospitalized' : 'Jailed';
    } else if (statusState === 'traveling') {
      activityScore = 50;
      activityLabel = 'Traveling';
    } else if (lastActionStatus === 'online') {
      activityScore = 100;
      activityLabel = 'Online';
    } else if (lastActionStatus === 'idle') {
      activityScore = 75;
      activityLabel = 'Idle';
    } else if (daysSinceAction <= 1) {
      activityScore = 60;
      activityLabel = 'Recent';
    } else if (daysSinceAction <= 3) {
      activityScore = 40;
      activityLabel = 'Away';
    } else if (daysSinceAction <= 7) {
      activityScore = 20;
      activityLabel = 'Inactive';
    } else {
      activityScore = 5;
      activityLabel = daysSinceAction > 30 ? 'Gone' : 'Inactive';
    }

    // If no OC history, still include with activity data
    const successRate = stats && stats.total > 0 ? Math.round(stats.succeeded / stats.total * 100) : null;
    const participationCount = stats?.total || 0;
    const consistency = stats ? calcConsistency(stats.entries) : 0;
    const currentStreak = stats ? calcStreak(stats.entries) : 0;

    // Participation rate: OCs per 30 days
    const ocsPerMonth = stats && stats.entries.length > 0
      ? Math.round(stats.total / ((now - Math.min(...stats.entries.map(e => e.execAt))) / (30 * DAY)) * 10) / 10
      : 0;

    // Days since last OC
    const lastOcAt = stats?.entries.length > 0 ? Math.max(...stats.entries.map(e => e.execAt)) : 0;
    const daysSinceLastOC = lastOcAt > 0 ? Math.round((now - lastOcAt) / DAY) : null;

    // Overall reliability score (0-100): weighted composite
    // 35% success rate, 25% consistency, 20% activity, 20% participation frequency
    let reliabilityScore = 0;
    let isNewMember = false;
    if (stats && stats.total >= 2) {
      const successComponent = (successRate || 0) * 0.35;
      const consistencyComponent = consistency * 0.25;
      const activityComponent = activityScore * 0.20;
      // Participation frequency: cap at 4+ OCs/month = 100%
      const freqComponent = Math.min(100, ocsPerMonth / 4 * 100) * 0.20;
      reliabilityScore = Math.round(successComponent + consistencyComponent + activityComponent + freqComponent);
    } else if (stats && stats.total === 1) {
      // Single OC: can't really judge, give partial credit
      reliabilityScore = Math.round(activityScore * 0.5 + (successRate || 0) * 0.5);
    } else {
      // No OC history: predict based on activity + days in faction
      // Active + established members get benefit of the doubt
      const daysInFac = m.days_in_faction || 0;
      const tenureBonus = Math.min(20, Math.round(daysInFac / 7 * 5)); // up to 20 pts for 4+ weeks
      reliabilityScore = Math.round(activityScore * 0.6 + tenureBonus);
      isNewMember = true;
    }

    // Tier label
    let tier, tierColor;
    if (isNewMember) {
      // New members get a special tier -- predicted, not earned
      if (reliabilityScore >= 60) { tier = 'New - Promising'; tierColor = '#818cf8'; }
      else if (reliabilityScore >= 40) { tier = 'New'; tierColor = '#a78bfa'; }
      else { tier = 'New - Unknown'; tierColor = '#6b7280'; }
    } else if (reliabilityScore >= 80) { tier = 'Reliable'; tierColor = '#4ade80'; }
    else if (reliabilityScore >= 60) { tier = 'Dependable'; tierColor = '#60a5fa'; }
    else if (reliabilityScore >= 40) { tier = 'Inconsistent'; tierColor = '#e5b567'; }
    else if (reliabilityScore >= 20) { tier = 'Unreliable'; tierColor = '#f97316'; }
    else { tier = 'Inactive'; tierColor = '#ef4444'; }

    // Most common role
    let topRole = null;
    if (stats?.entries.length > 0) {
      const roleCounts = {};
      for (const e of stats.entries) {
        roleCounts[e.role] = (roleCounts[e.role] || 0) + 1;
      }
      const sorted = Object.entries(roleCounts).sort((a, b) => b[1] - a[1]);
      topRole = sorted[0] ? { role: sorted[0][0], count: sorted[0][1] } : null;
    }

    results.push({
      uid,
      name: nameMap[uid] || uid,
      level: m.level || 0,
      daysInFaction: m.days_in_faction || 0,
      reliabilityScore,
      tier,
      tierColor,
      isNewMember,
      successRate,
      totalOCs: participationCount,
      succeeded: stats?.succeeded || 0,
      failed: stats?.failed || 0,
      ocsPerMonth,
      consistency,
      currentStreak,
      activityScore,
      activityLabel,
      daysSinceAction,
      daysSinceLastOC,
      topRole,
    });
  }

  // Sort by reliability score descending
  results.sort((a, b) => b.reliabilityScore - a.reliabilityScore);

  // Faction-wide summary
  const withHistory = results.filter(r => r.totalOCs >= 2);
  const avgReliability = withHistory.length > 0
    ? Math.round(withHistory.reduce((s, r) => s + r.reliabilityScore, 0) / withHistory.length)
    : 0;
  const tierCounts = { Reliable: 0, Dependable: 0, Inconsistent: 0, Unreliable: 0, Inactive: 0, New: 0 };
  for (const r of results) {
    if (r.isNewMember) tierCounts.New++;
    else tierCounts[r.tier] = (tierCounts[r.tier] || 0) + 1;
  }

  return {
    members: results,
    summary: {
      avgReliability,
      totalMembers: results.length,
      withHistory: withHistory.length,
      tierCounts,
    },
  };
}

// OC-spawn-only faction-access key cache. Seeded when a Full-access
// member hits /api/oc/spawn-key. Strictly separated from the FactionOps
// persisted pool — those keys are opted in for war coordination, not
// OC-spawn fallback. See earlier discussion: mental model is "FactionOps
// pool serves FactionOps; OC spawn cross-references its own cache."
//
// TTL: entries older than 24h since last use are evicted when the cache
// is read. Freshly-used keys are preferred in fallback rotation so
// stale entries don't tie up slots.
//
// Persisted to disk so a pm2 reload doesn't wipe the cache and create a
// cold-start gap where Limited-tier members see "insufficient access"
// until a Full-access member refreshes. Writes are debounced so the
// disk isn't hit on every fallback touch.
const _factionKeyCache = new Map(); // factionId → Map<apiKey, { addedAt, lastUsedAt }>
const FACTION_KEY_POOL_MAX = 10;
const FACTION_KEY_TTL_MS   = 24 * 60 * 60 * 1000;
const OC_SPAWN_KEYS_FILE   = pathJoin(process.env.DATA_DIR || './data', 'oc-spawn-keys.json');

let _persistTimer = null;

function _persistFactionKeysToDisk() {
  try {
    const out = {};
    const cutoff = Date.now() - FACTION_KEY_TTL_MS;
    for (const [fid, pool] of _factionKeyCache) {
      const fresh = {};
      for (const [key, info] of pool) {
        if (info.lastUsedAt >= cutoff) fresh[key] = info;
      }
      if (Object.keys(fresh).length) out[fid] = fresh;
    }
    const dir = pathDirname(OC_SPAWN_KEYS_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(OC_SPAWN_KEYS_FILE, JSON.stringify(out, null, 2), "utf8");
  } catch (e) {
    console.warn("[oc-spawn-keys] persist failed:", e.message);
  }
}

function _schedulePersistFactionKeys() {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    _persistFactionKeysToDisk();
  }, 2000);
}

function _loadFactionKeysFromDisk() {
  try {
    if (!existsSync(OC_SPAWN_KEYS_FILE)) return;
    const raw = readFileSync(OC_SPAWN_KEYS_FILE, "utf8");
    const obj = JSON.parse(raw);
    const cutoff = Date.now() - FACTION_KEY_TTL_MS;
    let loaded = 0, dropped = 0;
    for (const [fid, keys] of Object.entries(obj || {})) {
      const pool = new Map();
      for (const [key, info] of Object.entries(keys || {})) {
        const lastUsedAt = Number(info?.lastUsedAt) || 0;
        const addedAt    = Number(info?.addedAt) || lastUsedAt;
        if (!key || lastUsedAt < cutoff) { dropped++; continue; }
        pool.set(key, { addedAt, lastUsedAt });
        loaded++;
      }
      if (pool.size) _factionKeyCache.set(fid, pool);
    }
    console.log(`[oc-spawn-keys] hydrated ${loaded} key(s) across ${_factionKeyCache.size} faction(s) (dropped ${dropped} stale)`);
  } catch (e) {
    console.warn("[oc-spawn-keys] load failed:", e.message);
  }
}
_loadFactionKeysFromDisk();

function _getFactionPool(fid) {
  fid = String(fid);
  let pool = _factionKeyCache.get(fid);
  if (!pool) { pool = new Map(); _factionKeyCache.set(fid, pool); }
  return pool;
}

function _pruneFactionPool(pool) {
  const cutoff = Date.now() - FACTION_KEY_TTL_MS;
  for (const [k, info] of pool) {
    if (info.lastUsedAt < cutoff) pool.delete(k);
  }
}

function addFactionKey(fid, key) {
  const pool = _getFactionPool(fid);
  _pruneFactionPool(pool);
  const now = Date.now();
  if (pool.has(key)) {
    // Refresh lastUsedAt so re-verification keeps the entry alive.
    pool.get(key).lastUsedAt = now;
    _schedulePersistFactionKeys();
    return;
  }
  // Evict oldest-used when full.
  if (pool.size >= FACTION_KEY_POOL_MAX) {
    let oldest = null, oldestTs = Infinity;
    for (const [k, info] of pool) {
      if (info.lastUsedAt < oldestTs) { oldest = k; oldestTs = info.lastUsedAt; }
    }
    if (oldest) pool.delete(oldest);
  }
  pool.set(key, { addedAt: now, lastUsedAt: now });
  _schedulePersistFactionKeys();
}

/** Freshness-ordered list of currently-valid keys, most-recently-used first. */
function getFactionKeys(fid) {
  const pool = _getFactionPool(fid);
  _pruneFactionPool(pool);
  return [...pool.entries()]
    .sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt)
    .map(([k]) => k);
}

/** Mark a key as used — called when the fallback actually dispatches it. */
function touchFactionKey(fid, key) {
  const pool = _factionKeyCache.get(String(fid));
  if (pool && pool.has(key)) {
    pool.get(key).lastUsedAt = Date.now();
    _schedulePersistFactionKeys();
  }
}

function removeFactionKey(fid, key) {
  const pool = _factionKeyCache.get(String(fid));
  if (pool) {
    pool.delete(key);
    _schedulePersistFactionKeys();
  }
}
const PARTNER_FACTIONS = ["51430"]; // Factions with permanent free access
const OWNER_PLAYER_ID = 137558; // RussianRob — receives Xanax payments // Factions with permanent free access


const OC_MIN_VERSION = '3.1.4';

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
      const granted = grantFactionAccess(
        playerInfo.factionId,
        playerInfo.playerName + "'s faction",
        qty,
        playerInfo.playerName,
        {
          paidById:       playerInfo.playerId,
          paidByPosition: playerInfo.factionPosition || '',
        }
      );
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
    // Tab visibility is gated on the OC-specific admin roles list
    // (configurable via OC Settings → Admin roles). Defaults to leader +
    // co-leader if never customized. Independent from the broadcast role
    // list so leadership can delegate "tab access" separately from "shouts."
    const adminRoles = store.getAdminRoles(fid).map(r => String(r).toLowerCase());
    const pos = String(playerInfo.factionPosition || '').toLowerCase();
    const hasAdminAccess = adminRoles.includes(pos);
    return {
      playerId: playerInfo.playerId,
      playerName: playerInfo.playerName,
      isOwnerFaction: isFactionAllowed(fid),
      position: playerInfo.factionPosition || '',
      hasFactionAccess: hasAdminAccess,
      subscriptionExpiresAt,
    };
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
    keyUsage.logCall(key, 'faction/spawn (primary)', `oc-spawn:${playerInfo.playerName}`);
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

    // Collect OC history from completed crimes (stored in CPR cache, not in the response)
    const completedForHistory = getCachedCompletedCrimes(playerInfo.factionId);
    if (completedForHistory && completedForHistory.length > 0) {
      collectOcHistory(playerInfo.factionId, { crimes: completedForHistory, members: data.members });
    }

    // Run engines if enabled — cached per faction for 1 hour (same TTL as CPR cache)
    if (!_engineCache.has(fid) || (Date.now() - _engineCache.get(fid).ts) > 3600_000 || _engineCache.get(fid).settingsHash !== engineSettingsHash(fSettings)) {
      const engines = {};
      if (fSettings.engine_slot_optimizer) engines.slotOptimizer = runSlotOptimizer(fid, data);
      if (fSettings.engine_failure_risk) engines.failureRisk = runFailureRisk(fid, data);
      if (fSettings.engine_cpr_forecaster) engines.cprForecaster = runCprForecaster(fid, data);
      if (fSettings.engine_member_projector) engines.memberProjector = runMemberProjector(fid, data);
      if (fSettings.engine_member_reliability) engines.memberReliability = runMemberReliability(fid, data);


      _engineCache.set(fid, { ts: Date.now(), engines, settingsHash: engineSettingsHash(fSettings) });
    }
    const engines = { ..._engineCache.get(fid).engines };

    // Auto-Dispatcher is per-player (not faction-cached), runs every request
    // Default to true if not explicitly set in faction settings
    if (fSettings.engine_auto_dispatcher ?? true) {
      engines.autoDispatcher = runAutoDispatcher(fid, data, playerInfo.playerId);
    }

    // v3.1.38: empirical top-tier hit rates per scenario (from completed
    // OC payouts). Lets the client show predicted vs observed alongside.
    const hitRates = computeScenarioHitRates(playerInfo.factionId);

    return res.json({ ...data, viewer: viewerObj, engines, hitRates });
  } catch (err) {
    // If member's own key failed, try keys from the faction pool
    const fid = String(playerInfo.factionId);
    // OC-spawn-only fallback: try keys cached from other Full-access
    // members' recent refreshes. Strict separation — we no longer fall
    // through to the FactionOps persisted pool, which is reserved for
    // war coordination. Cold-start tradeoff: until one Full-access member
    // hits Refresh after a reload, Limited-tier members will see an
    // "insufficient access" error on OC data. Normal-operation coverage
    // is unaffected because leader/banker refreshes continuously seed
    // the cache.
    const keysToTry = getFactionKeys(fid).filter(k => k !== key);
    if (keysToTry.length > 0) {
      // Log WHY we're falling back so debug output ties pool 429s back to the
      // original caller whose key triggered the retry.
      console.warn(`[oc/spawn-key] primary failed for ${playerInfo.playerName} (${playerInfo.playerId}, faction ${fid}) key ****${String(key).slice(-4)}: ${err.message} — trying ${keysToTry.length} pool key(s)`);
      for (const poolKey of keysToTry) {
        try {
          keyUsage.logCall(poolKey, 'faction/spawn (fallback)', `oc-spawn-fallback:for:${playerInfo.playerName}`);
          touchFactionKey(fid, poolKey);
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
          // Run engines on fallback data too
          const fS2engines = {};
          if (!_engineCache.has(fid) || (Date.now() - _engineCache.get(fid).ts) > 3600_000) {
            if (fS2.engine_slot_optimizer) fS2engines.slotOptimizer = runSlotOptimizer(fid, data);
            if (fS2.engine_failure_risk) fS2engines.failureRisk = runFailureRisk(fid, data);
            if (fS2.engine_cpr_forecaster) fS2engines.cprForecaster = runCprForecaster(fid, data);
            if (fS2.engine_member_projector) fS2engines.memberProjector = runMemberProjector(fid, data);
            if (fS2.engine_member_reliability) fS2engines.memberReliability = runMemberReliability(fid, data);
            _engineCache.set(fid, { ts: Date.now(), engines: fS2engines, settingsHash: engineSettingsHash(fS2) });
          }
          const retryEngines = { ...(_engineCache.get(fid)?.engines || {}) };
          if (fS2.engine_auto_dispatcher ?? true) {
            retryEngines.autoDispatcher = runAutoDispatcher(fid, data, playerInfo.playerId);
          }
          return res.json({ ...data, viewer: buildViewer(playerInfo), engines: retryEngines });
        } catch (retryErr) {
          // 429 ("Too many requests" / "code 5") is transient saturation —
          // keep the key in the cache, just try the next one this call.
          // Evict only on auth-like failures (invalid key, revoked, insufficient
          // access) where retrying this key would permanently fail.
          const msg = String(retryErr.message || '');
          const isRateLimit = /Too many requests|code 5/i.test(msg);
          if (isRateLimit) {
            console.warn(`[oc/spawn-key] pool key ****${poolKey.slice(-4)} rate-limited for faction ${fid} — keeping in cache, trying next`);
          } else {
            console.error(`[oc/spawn-key] pool key ****${poolKey.slice(-4)} failed for faction ${fid}: ${msg} — evicting`);
            removeFactionKey(fid, poolKey);
          }
        }
      }
    }
    console.error(`[oc/spawn-key] getOcSpawnData failed for ${playerInfo.playerName} (${playerInfo.playerId}, faction ${playerInfo.factionId}): ${err.message}`);
    // No cached faction key available — return partial data so the script can show viewer card.
    // errorReason carries the Torn API message from the user's own key so the client can render
    // actionable guidance ("enable Faction permission", "use Full access key", etc).
    return res.json({ crimes: [], members: {}, cprCache: {}, pendingFactionData: true, errorReason: err.message, viewer: buildViewer(playerInfo), engines: {} });
  }
});

// Shared helper — resolves the API key to a cached playerInfo (or
// verifies against Torn if the cache entry is missing/stale). Mirrors
// the guard used in /api/oc/spawn-key so new /api/oc/* endpoints can
// reuse the same auth path without duplicating code.
async function resolveSpawnKeyInfo(req, res) {
  res.set("Access-Control-Allow-Origin", "*");
  const key = req.query.key;
  if (!key || typeof key !== "string" || key.length < 10) {
    res.status(400).json({ error: "Invalid key" });
    return null;
  }
  const suffix = key.slice(-8);
  let info = _spawnKeyCache.get(suffix);
  if (!info || (Date.now() - info.ts) > 5 * 60_000) {
    try {
      const tornInfo = await verifyTornApiKey(key);
      if (!isFactionAllowed(tornInfo.factionId) && !PARTNER_FACTIONS.includes(String(tornInfo.factionId)) && !hasXanaxSubscription(tornInfo.factionId)) {
        res.status(403).json({ error: "Access restricted" });
        return null;
      }
      info = { ts: Date.now(), factionId: tornInfo.factionId, playerName: tornInfo.playerName, playerId: tornInfo.playerId, factionPosition: tornInfo.factionPosition, hasFactionAccess: tornInfo.hasFactionAccess };
      _spawnKeyCache.set(suffix, info);
    } catch (err) {
      res.status(401).json({ error: err.message });
      return null;
    }
  }
  return info;
}

// ── POST /api/oc/flyer-delay ──────────────────────────────────────────
// Client-side observation: a crew member was flying while their OC was
// ready to execute. We keep the MAX delayedSec observed per
// (factionId, crimeId, memberId) so when the crime finally launches
// and lands in history, we can attach the true peak delay.
router.post("/api/oc/flyer-delay", async (req, res) => {
  const info = await resolveSpawnKeyInfo(req, res);
  if (!info) return;
  const { crimeId, memberId, memberName, crimeName } = (req.body || {});
  if (!crimeId || !memberId) return res.status(400).json({ error: "crimeId and memberId are required" });
  const fid = String(info.factionId);
  if (!_flyerDelays.has(fid)) _flyerDelays.set(fid, new Map());
  const m = _flyerDelays.get(fid);
  const key = `${crimeId}::${memberId}`;
  const prev = m.get(key);
  // v3.1.46: compute delayedSec server-side from first-observation.
  // Previously we trusted the client's delayedSec (= "OC has been ready
  // for N seconds"), which over-credited members who started blocking
  // LATE — if the OC sat ready for 5h and member joined the block 10min
  // ago, they'd still get credited with a 5h delay. Now: delayedSec is
  // simply now - firstObservedAt, so each member's tally reflects their
  // own block duration. firstObservedAt persists across server restarts
  // via the disk save.
  const now = Date.now();
  const firstObservedAt = Number(prev?.firstObservedAt) || now;
  const serverDelay = Math.max(0, Math.floor((now - firstObservedAt) / 1000));
  m.set(key, {
    delayedSec: serverDelay,
    firstObservedAt,
    observedAt: now,
    memberName: String(memberName || prev?.memberName || memberId),
    crimeName:  String(crimeName  || prev?.crimeName  || crimeId),
  });
  scheduleFlyerDelaysSave();
  return res.json({ ok: true, delayedSec: serverDelay });
});

// ── GET /api/oc/delays ───────────────────────────────────────────────
// Aggregates per-member delay stats over the faction's OC history.
// Reads the on-disk history file (written by collectOcHistory) and
// also includes any still-pending in-memory observations from
// _flyerDelays so a crime currently holding up the crew shows in the
// leaderboard before it completes. Returns a sorted array by total
// delayed seconds descending.
router.get("/api/oc/delays", async (req, res) => {
  const info = await resolveSpawnKeyInfo(req, res);
  if (!info) return;
  const fid = String(info.factionId);
  const lookbackDays = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  const cutoff = Date.now() - lookbackDays * 86400 * 1000;

  const stats = new Map(); // memberId → { name, count, totalSec, longestSec, crimes: [] }
  function add(memberId, name, crimeName, crimeId, completedAt, delayedSec) {
    if (!memberId || delayedSec <= 0) return;
    if (completedAt && completedAt < cutoff) return;
    let s = stats.get(memberId);
    if (!s) { s = { memberId, name: name || memberId, count: 0, totalSec: 0, longestSec: 0, crimes: [] }; stats.set(memberId, s); }
    if (name) s.name = name;
    s.count++;
    s.totalSec += delayedSec;
    if (delayedSec > s.longestSec) s.longestSec = delayedSec;
    s.crimes.push({ crimeId, crimeName, delayedSec, completedAt: completedAt || null, pending: !completedAt });
  }

  try {
    const histFile = pathJoin(OC_HISTORY_DIR, `${fid}.json`);
    if (existsSync(histFile)) {
      const history = JSON.parse(readFileSync(histFile, 'utf-8'));
      for (const c of history) {
        if (!Array.isArray(c.slots)) continue;
        for (const s of c.slots) {
          if (!s.delayedSec) continue;
          add(String(s.userId), s.userName, c.crimeName, c.crimeId, c.completedAt, Number(s.delayedSec));
        }
      }
    }
  } catch (e) {
    console.error('[oc/delays] history read failed:', e.message);
  }

  // Layer in-memory pending delays on top (for in-flight crimes).
  const pend = _flyerDelays.get(fid);
  if (pend) {
    for (const [k, v] of pend) {
      const [crimeId, memberId] = k.split('::');
      add(memberId, v.memberName, v.crimeName, crimeId, null, Number(v.delayedSec || 0));
    }
  }

  const out = Array.from(stats.values()).sort((a, b) => b.totalSec - a.totalSec);
  return res.json({ days: lookbackDays, members: out });
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
    engine_cpr_forecaster:   s.engine_cpr_forecaster   ?? false,
    engine_failure_risk:     s.engine_failure_risk     ?? false,

    engine_member_reliability: s.engine_member_reliability ?? false,


    engine_member_projector: s.engine_member_projector ?? false,
    engine_auto_dispatcher:  s.engine_auto_dispatcher  ?? true,
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
  const prev = store.getFactionSettings(info.factionId)?.oc_scope;
  const next = Math.max(0, Math.min(100, scopeRaw));
  store.updateFactionSettings(info.factionId, { oc_scope: next });
  // Audit trail: who pushed which scope value and what it replaced.
  // Useful for tracking down the "my scope keeps resetting to X" class of
  // bug where auto-detection picks up a stale/wrong value from the DOM.
  const src = (req.query.source || req.get('x-scope-source') || 'auto').toString().slice(0, 32);
  console.log(`[oc/scope] ${info.playerName} (${info.playerId}) pushed scope ${prev ?? 'null'} -> ${next} for faction ${info.factionId} [source=${src}]`);
  return res.json({ ok: true });
});

// -- GET /api/oc/engines/update — engine toggles only, separate from main settings
router.get("/api/oc/engines/update", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  const key = req.query.key;
  if (!key || key.length < 10) return res.status(400).json({ error: "Invalid key" });
  const suffix = key.slice(-8);
  let info = _spawnKeyCache.get(suffix);
  if (!info || (Date.now() - info.ts) > 5 * 60_000) {
    try {
      const tornInfo = await verifyTornApiKey(key);
      if (!isFactionAllowed(tornInfo.factionId)) return res.status(403).json({ error: "Access restricted" });
      info = { ts: Date.now(), factionId: tornInfo.factionId, playerName: tornInfo.playerName, playerId: tornInfo.playerId, factionPosition: tornInfo.factionPosition, hasFactionAccess: tornInfo.hasFactionAccess };
      _spawnKeyCache.set(suffix, info);
    } catch (err) { return res.status(401).json({ error: err.message }); }
  }
  const bool = (k) => req.query[k] === 'true' || req.query[k] === '1';
  store.updateFactionSettings(info.factionId, {
    engine_slot_optimizer:   bool('engine_slot_optimizer'),
    engine_cpr_forecaster:   bool('engine_cpr_forecaster'),
    engine_failure_risk:     bool('engine_failure_risk'),

    engine_member_reliability: bool('engine_member_reliability'),
    engine_auto_dispatcher:   bool('engine_auto_dispatcher'),

    engine_member_projector: bool('engine_member_projector'),
  });
  console.log(`[oc/engines] ${info.playerName} updated engines for faction ${info.factionId}`);
  return res.json({ ok: true });
});

// -- GET /api/oc/outcome (PRIVATE admin build) -----------------------------
// Returns the full outcome probability distribution for a given OC
// scenario + per-slot CPR array, sourced from tornprobability.com's
// CalculateSuccess endpoint via a 15-min server-side cache.
//
// Admin-gated: caller must be in the faction's configured admin-roles
// list OR be the dev account. Never exposed to regular members — seeing
// expected-reward numbers creates adverse selection where everyone
// clusters into the high-EV OCs and low-tier slates starve.
//
// Query params:
//   key       — Torn API key (validated + faction-bound)
//   scenario  — OC name matching GetSupportedScenarios (e.g. "Blast from the Past")
//   cprs      — comma-separated CPRs in slot order, e.g. "70,65,80,72,68,75"
router.get("/api/oc/outcome", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  const key = req.query.key;
  if (!key || key.length < 10) return res.status(400).json({ error: "Invalid key" });
  const suffix = key.slice(-8);
  let info = _spawnKeyCache.get(suffix);
  if (!info || (Date.now() - info.ts) > 5 * 60_000) {
    try {
      const tornInfo = await verifyTornApiKey(key);
      info = {
        ts: Date.now(),
        factionId: tornInfo.factionId,
        playerName: tornInfo.playerName,
        playerId: tornInfo.playerId,
        factionPosition: tornInfo.factionPosition,
        hasFactionAccess: tornInfo.hasFactionAccess,
      };
      _spawnKeyCache.set(suffix, info);
    } catch (err) { return res.status(401).json({ error: err.message }); }
  }
  // Admin gate: must be in configured admin-roles OR dev.
  const isDev = String(info.playerId) === "137558";
  const adminRoles = store.getAdminRoles(info.factionId).map((r) => String(r).toLowerCase());
  const pos = String(info.factionPosition || "").toLowerCase();
  if (!isDev && !adminRoles.includes(pos)) {
    return res.status(403).json({ error: "Admin role required" });
  }

  const scenario = String(req.query.scenario || "").trim();
  const cprsRaw = String(req.query.cprs || "").trim();
  if (!scenario) return res.status(400).json({ error: "Missing scenario" });
  if (!cprsRaw) return res.status(400).json({ error: "Missing cprs" });
  const cprs = cprsRaw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  if (cprs.length === 0) return res.status(400).json({ error: "Invalid cprs" });

  console.log(`[oc/outcome] ${info.playerName} scenario="${scenario}" cprs=${cprs.join(',')} admin=${isDev || adminRoles.includes(pos)}`);
  const out = await calculateOutcome(scenario, cprs);
  if (out?.error) return res.status(502).json({ error: out.error });
  return res.json(out);
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
  // v3.1.30 fix: fall back to the STORED value (not a hard-coded default)
  // when a field is missing from the query. Otherwise a partial push (e.g.
  // pushScopeOnly sending just `scope`) silently clobbers every other
  // setting — mincpr snaps back to 60, cpr_boost to 15, etc. — every time
  // the Recruiting-tab scope detector fires.
  const cur = store.getFactionSettings(info.factionId) || {};
  const num = (k, storedKey, fallback) => {
    if (req.query[k] === undefined) {
      return cur[storedKey] !== undefined ? cur[storedKey] : fallback;
    }
    const v = parseInt(req.query[k], 10);
    return isNaN(v) ? (cur[storedKey] !== undefined ? cur[storedKey] : fallback) : v;
  };
  const scopeProvided = req.query.scope !== undefined;
  const scopeRaw = parseInt(req.query.scope, 10);
  const scopeValue = !scopeProvided
    ? (cur.oc_scope !== undefined ? cur.oc_scope : null)
    : (isNaN(scopeRaw) ? null : Math.max(0, Math.min(100, scopeRaw)));
  store.updateFactionSettings(info.factionId, {
    oc_active_days:         num("active_days",         "oc_active_days",         7),
    oc_forecast_hours:      num("forecast_hours",      "oc_forecast_hours",      24),
    oc_mincpr:              num("mincpr",              "oc_mincpr",              60),
    oc_cpr_boost:           num("cpr_boost",           "oc_cpr_boost",           15),
    oc_lookback_days:       num("lookback_days",       "oc_lookback_days",       90),
    oc_high_weight_pct:     num("high_weight_pct",     "oc_high_weight_pct",     25),
    oc_high_weight_mincpr:  num("high_weight_mincpr",  "oc_high_weight_mincpr",  75),
    oc_scope:               scopeValue,
  });
  console.log("[oc/settings] " + info.playerName + " updated faction " + info.factionId + " OC settings");
  return res.json({ ok: true });
});


// ── Admin roles for OC spawn-assistance tabs ───────────────────────────────
// GET = list current admin roles for caller's faction
// POST = replace the role list (caller must currently have admin access)
router.get("/api/oc/admin-roles", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  const ctx = await resolveVaultCaller(req, res);
  if (!ctx) return;
  return res.json({
    roles: store.getAdminRoles(ctx.info.factionId),
    yourPosition: ctx.info.factionPosition || '',
  });
});

router.post("/api/oc/admin-roles", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  const ctx = await resolveVaultCaller(req, res);
  if (!ctx) return;
  const { info } = ctx;

  // Bootstrapping rule: anyone in the CURRENT admin role list can edit it.
  // Dev (XID 137558) can always edit.
  const cur = store.getAdminRoles(info.factionId).map(r => String(r).toLowerCase());
  const myPos = String(info.factionPosition || '').toLowerCase();
  const isDev = String(info.playerId) === '137558';
  if (!isDev && !cur.includes(myPos)) {
    return res.status(403).json({ error: "Only existing admin-role members can edit the list." });
  }

  // Normalize incoming roles
  const newRoles = (Array.isArray(req.body?.roles) ? req.body.roles : [])
    .map(r => String(r).trim().toLowerCase()).filter(Boolean);

  // Safeguard 1: never accept an empty list — would lock everyone out and
  // fall back to the default. Force the user to acknowledge a default by
  // explicitly typing "leader, co-leader" if that's what they want.
  if (newRoles.length === 0) {
    return res.status(400).json({
      error: "Role list cannot be empty. Add at least one position (e.g. 'leader').",
    });
  }

  // Safeguard 2: don't allow removing your own position unless you're dev.
  // Prevents accidental self-lockout — if you want to step down, ask
  // another admin to do the removal.
  if (!isDev && !newRoles.includes(myPos)) {
    return res.status(400).json({
      error: `New list must still include your position ('${myPos}') so you don't lock yourself out. Ask another admin to remove you, or add it back and save again.`,
    });
  }

  // Safeguard 3: detect mass-removal — if more than half the existing roles
  // would be dropped in one save, require explicit confirm flag.
  const removed = cur.filter(r => !newRoles.includes(r));
  if (removed.length > 0 && removed.length >= cur.length / 2 && !req.body?.confirmRemove) {
    return res.status(409).json({
      error: `This save would remove ${removed.length} role(s): ${removed.join(', ')}. Resubmit with confirmRemove=true to proceed.`,
      removing: removed,
    });
  }

  const saved = store.setAdminRoles(info.factionId, newRoles);
  console.log(`[oc/admin-roles] ${info.playerName} (${info.playerId}) faction ${info.factionId}: [${cur.join(', ')}] → [${saved.join(', ')}]`);
  return res.json({ ok: true, roles: saved, removed });
});

// ── Vault requests (faction members ask for $X from the vault) ─────────────
// Everyone in the faction sees pending requests. When Torn's currencynews
// shows the requester received money ≥ their ask, the poller auto-removes
// the request. Push notifications on submit, filterable to online-only.

// Helper: resolve the caller's info from the spawn-key cache (5min TTL).
async function resolveVaultCaller(req, res) {
  const key = req.query.key || (req.body && req.body.key);
  if (!key || key.length < 10) { res.status(400).json({ error: "Invalid key" }); return null; }
  const suffix = key.slice(-8);
  let info = _spawnKeyCache.get(suffix);
  if (!info || (Date.now() - info.ts) > 5 * 60_000 || !info.playerId) {
    try {
      const tornInfo = await verifyTornApiKey(key);
      if (!isFactionAllowed(tornInfo.factionId) && !PARTNER_FACTIONS.includes(String(tornInfo.factionId)) && !hasXanaxSubscription(tornInfo.factionId)) {
        res.status(403).json({ error: "Access restricted" });
        return null;
      }
      info = {
        ts: Date.now(),
        factionId: tornInfo.factionId,
        playerName: tornInfo.playerName,
        playerId: tornInfo.playerId,
        factionPosition: tornInfo.factionPosition,
        hasFactionAccess: tornInfo.hasFactionAccess,
      };
      store.storeApiKey(info.playerId, key);
      _spawnKeyCache.set(suffix, info);
    } catch (e) {
      res.status(401).json({ error: e.message });
      return null;
    }
  }
  return { info, key };
}

// List pending requests for the caller's faction.
router.get("/api/oc/vault-requests", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  const ctx = await resolveVaultCaller(req, res);
  if (!ctx) return;
  // Piggy-back cleanup: use the caller's own key to poll their own
  // faction's fundsnews and clear fulfilled requests. Works for ANY
  // subscribed faction without any stored keys — each user's key only
  // polls their own faction's events (same scope the user already has).
  // Throttled to ≤1 poll per 5s per faction to avoid hammering Torn.
  try {
    await vaultRequests.pollFactionWithKey(ctx.info.factionId, ctx.key);
  } catch (_) { /* non-fatal — list still returns */ }
  return res.json({ requests: vaultRequests.listRequests(ctx.info.factionId) });
});

// Submit a new request. Amount auto-capped at caller's vault balance.
router.post("/api/oc/vault-request", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  const ctx = await resolveVaultCaller(req, res);
  if (!ctx) return;
  const { info, key } = ctx;
  let { amount, target } = req.body || {};
  amount = Number(amount);
  if (!isFinite(amount) || amount < 1) return res.status(400).json({ error: "Invalid amount" });
  if (target !== 'online' && target !== 'both') target = 'both';

  // Cap at the requester's own vault balance. Try their own key first
  // (fast path); if it fails fall back to any Full-access key from the
  // faction's spawn-key pool. If neither source works, we log the issue
  // but still let the request through uncapped — matches the historical
  // behaviour this feature shipped with, and admins visually eyeball
  // amounts before fulfilling anyway. The cap is a nice-to-have, not
  // a hard security boundary.
  let maxAmount = null;
  let fetchErr = null;
  try {
    maxAmount = await vaultRequests.fetchVaultBalance(info.factionId, info.playerId, key);
  } catch (e) {
    fetchErr = e;
  }
  if (maxAmount === null || !Number.isFinite(maxAmount)) {
    const poolKeys = getFactionKeys(info.factionId).filter(k => k !== key);
    for (const pk of poolKeys) {
      try {
        const tryAmt = await vaultRequests.fetchVaultBalance(info.factionId, info.playerId, pk);
        if (Number.isFinite(tryAmt)) {
          maxAmount = tryAmt;
          touchFactionKey(info.factionId, pk);
          console.log(`[vault-request] balance for ${info.playerId} via pool key ****${pk.slice(-4)} (own key failed: ${fetchErr?.message || 'null'})`);
          fetchErr = null;
          break;
        }
      } catch (_) { /* try next */ }
    }
  }
  if (fetchErr && (maxAmount === null || !Number.isFinite(maxAmount))) {
    console.warn(`[vault-request] balance fetch failed for ${info.playerId} (own + pool): ${fetchErr.message} — proceeding uncapped`);
    maxAmount = Infinity; // permissive: create the request anyway
  }
  if (!(maxAmount > 0)) {
    return res.status(400).json({ error: "No vault balance available to request." });
  }

  const reqObj = vaultRequests.createRequest(info.factionId, {
    requesterId: info.playerId,
    requesterName: info.playerName,
    amount,
    target,
    maxAmount,
  });

  // Fire push notifications only to members with shout/broadcast-allowed
  // faction positions — i.e., those with vault-giving permissions. No
  // point pinging regular members who can't fulfill the request anyway.
  // Same role set the /api/broadcast endpoint uses.
  (async () => {
    try {
      const basic = await fetchFactionBasic(info.factionId, key);
      const allowedRoles = getAllowedBroadcastRoles(info.factionId)
        .map(r => String(r).toLowerCase());
      const targetIds = Object.entries(basic.members || {})
        .filter(([, m]) => {
          const pos = String(m.position || m.faction_position || '').toLowerCase();
          return allowedRoles.includes(pos);
        })
        .map(([id]) => String(id));
      // Dev (XID 137558) always gets notified regardless of role.
      if (!targetIds.includes('137558')) targetIds.push('137558');
      await vaultRequests.notifyNewRequest(reqObj, targetIds);
    } catch (e) {
      console.warn('[vault-request] notify failed:', e.message);
    }
  })();

  return res.json({ ok: true, request: reqObj, cappedAt: maxAmount });
});

// Return the caller's personal faction-vault balance so the client can
// show a "max: $X" hint + a $ tap-to-fill button without guessing.
router.get("/api/oc/vault-balance", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  const ctx = await resolveVaultCaller(req, res);
  if (!ctx) return;
  try {
    const balance = await vaultRequests.fetchVaultBalance(
      ctx.info.factionId, ctx.info.playerId, ctx.key
    );
    return res.json({ balance: Number(balance) || 0 });
  } catch (e) {
    return res.status(500).json({ error: e.message, balance: 0 });
  }
});

// Cancel a request. Requester can cancel their own; faction-API-access/dev
// can cancel any.
router.delete("/api/oc/vault-request/:id", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  const ctx = await resolveVaultCaller(req, res);
  if (!ctx) return;
  const { info } = ctx;
  const isAdmin = info.hasFactionAccess === true || String(info.playerId) === '137558';
  const removed = vaultRequests.removeRequest(info.factionId, req.params.id, info.playerId, isAdmin);
  if (!removed) return res.status(403).json({ error: "Not found or not authorized" });
  return res.json({ ok: true, removed });
});

// Per-user push-notification preferences, auth'd by Torn API key so the
// OC Spawn Assistance settings panel can read/write them without needing
// a FactionOps JWT. Currently exposes vault_request only; extend the
// whitelist as more OC-spawn-originated notification types appear.
const OC_PUSH_PREF_KEYS = new Set(["vault_request"]);

router.get("/api/oc/notification-prefs", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  const ctx = await resolveVaultCaller(req, res);
  if (!ctx) return;
  const all = push.getPreferences(ctx.info.playerId) || {};
  const filtered = {};
  for (const k of OC_PUSH_PREF_KEYS) if (k in all) filtered[k] = all[k];
  return res.json({ preferences: filtered });
});

router.post("/api/oc/notification-prefs", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  const ctx = await resolveVaultCaller(req, res);
  if (!ctx) return;
  const prefs = (req.body && req.body.preferences) || {};
  const safe = {};
  for (const [k, v] of Object.entries(prefs)) {
    if (OC_PUSH_PREF_KEYS.has(k) && typeof v === 'boolean') safe[k] = v;
  }
  push.setPreferences(ctx.info.playerId, safe);
  const all = push.getPreferences(ctx.info.playerId) || {};
  const filtered = {};
  for (const k of OC_PUSH_PREF_KEYS) if (k in all) filtered[k] = all[k];
  return res.json({ ok: true, preferences: filtered });
});

// Fire a test vault_request push to the caller so they can verify their
// subscription is live. Bypasses the preference check on purpose — users
// who've opted out still want the test button to work when they're
// toggling things. Does NOT create or broadcast a real vault request.
router.post("/api/oc/notification-test", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  const ctx = await resolveVaultCaller(req, res);
  if (!ctx) return;
  try {
    await push.sendToPlayer(ctx.info.playerId, {
      title: "Vault Request — test",
      body: `If you see this, vault-request notifications are working.`,
      icon: "/icon-192.png",
      badge: "/icon-badge.png",
      tag: "vault-request-test",
      data: { test: true, type: "vault_request" },
    }, null);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── Debug: API key usage tracker ───────────────────────────────────────────
// Last N minutes of server-side Torn API calls with summary by source.
// Auth: Torn API key query param verified against dev XID 137558. Zero
// infra cost — in-memory ring buffer, max 15 min / 5k entries.
router.get("/api/debug/key-usage", async (req, res) => {
  const key = req.query.key;
  if (!key || String(key).length < 10) return res.status(400).json({ error: "key required" });
  try {
    const info = await verifyTornApiKey(String(key));
    if (String(info.playerId) !== '137558') return res.status(403).json({ error: "dev only" });
    const windowMin = Math.max(1, Math.min(15, Number(req.query.window) || 10));
    const keySuffix = req.query.keySuffix ? String(req.query.keySuffix) : null;
    return res.json(keyUsage.getRecent(windowMin, keySuffix));
  } catch (e) {
    return res.status(401).json({ error: e.message });
  }
});

router.post("/api/debug/key-usage/clear", async (req, res) => {
  const key = (req.body && req.body.key) || req.query.key;
  if (!key || String(key).length < 10) return res.status(400).json({ error: "key required" });
  try {
    const info = await verifyTornApiKey(String(key));
    if (String(info.playerId) !== '137558') return res.status(403).json({ error: "dev only" });
    keyUsage.clear();
    return res.json({ ok: true });
  } catch (e) {
    return res.status(401).json({ error: e.message });
  }
});

export default router;
