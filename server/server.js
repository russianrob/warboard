/**
 * FactionOps Server – Torn.com faction war coordination tool.
 *
 * Express + Socket.IO backend providing:
 *  - JWT auth via Torn API key verification
 *  - Real-time target calling and status tracking
 *  - Enemy chain monitoring with bonus-hit alerts
 *  - File-based persistence for war state
 */

import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";

import routes, { setIO, gateMiddleware } from "./routes.js";
import "./war-scanner.js";
import { socketAuth } from "./auth.js";
import { registerSocketHandlers } from "./socket-handlers.js";
import { startChainMonitor, stopAll as stopAllChainMonitors } from "./chain-monitor.js";
import { startWarStatusMonitor, stopAll as stopAllWarStatusMonitors } from "./war-status-monitor.js";
import { loadHeatmaps, stopFlush as stopHeatmapFlush } from "./activity-heatmap.js";
import { startMembershipSchedule, stopMembershipSchedule } from "./membership-check.js";
import { startXanaxSubscriptions, stopXanaxSubscriptions, getActiveSubscribedFactionIds } from "./xanax-subscriptions.js";
import { startWeav3rCache, getWeav3rSnapshot, subscribeToWeav3r, kickVerifyOnPoolGrowth } from "./weav3r-cache.js";
import * as weav3rPool from "./weav3r-pool.js";
import * as vaultRequests from "./vault-requests.js";
import { startSubscriptionManager, stopSubscriptionManager } from "./subscription-manager.js";
import * as store from "./store.js";
import { loadSubscriptions } from "./push-notifications.js";
import { fetchRankedWar } from "./torn-api.js";
import { isFactionAllowed } from "./subscription-manager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Configuration ───────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT, 10) || 3000;

// ── Express setup ───────────────────────────────────────────────────────

const app = express();

// Trust Nginx proxy for correct IP detection (needed for rate limiting)
app.set("trust proxy", 1);

// Enable CORS for all API routes
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (/.torn.com$/.test(origin) || /tornwar.com/.test(origin) || /^https?:\/\/localhost/.test(origin)) {
        return callback(null, true);
      }
      callback(null, false);
    },
    credentials: true,
  })
);

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (PDA webview, mobile apps, curl)
      if (!origin) return callback(null, true);
      // Allow torn.com subdomains and localhost dev
      if (/\.torn\.com$/.test(origin) || /^https?:\/\/localhost/.test(origin)) {
        return callback(null, true);
      }
      callback(null, false);
    },
    credentials: true,
  }),
);
// 1MB is comfortable for scout-report / post-war-report payloads that
// carry BSP + FFScouter estimates for every enemy + own faction member
// in a ranked war (can hit a few hundred kb). 50kb was tripping 413s
// for members with large BSP caches.
app.use(express.json({ limit: '1mb' }));

// ── Security headers ───────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

// ── Rate limiting ────────────────────────────────────────────────────────

// Strict limit on auth endpoint — prevents API key brute-force and Torn API flooding
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  // Bumped from 20 → 60. A legitimate user with multiple tabs / script
  // versions open can easily burn through 20 on a pm2 restart (every tab
  // re-auths). 60/15min still caps brute-force attempts at 4/min average.
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts, try again in a few minutes' },
});
app.use('/api/auth', authLimiter);

// General limiter on all routes as a backstop.
// 500/15min (≈33/min) is too tight for authenticated clients — an active
// faction member with a couple of tabs open easily burns through that in
// normal play (polling, assist reports, viewing updates, static asset
// re-fetches, socket.io polling transport, etc.). 5000/15min (≈333/min)
// still protects against scrapers/scanners while giving legitimate clients
// headroom. Static scripts & socket.io are also excluded since they
// shouldn't consume the API budget.
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down' },
  skip: (req) =>
    req.path.startsWith('/scripts/') ||
    req.path.startsWith('/socket.io/') ||
    req.path === '/' ||
    req.path.startsWith('/assets/') ||
    req.path === '/api/stream',
});
app.use(globalLimiter);

// ── Landing page is public — gate is applied only to /scripts/*.user.js below ──

// ── Landing page gate ───────────────────────────────────────────────────
app.use(gateMiddleware);

// ── Static files (landing page) ─────────────────────────────────────────
app.use(express.static(join(__dirname, "public")));

// ── Userscript download route (legacy) ──────────────────────────────────
const USERSCRIPT_PATH = join(__dirname, "..", "client", "factionops.user.js");

app.get("/download/factionops.user.js", (_req, res) => {
  try {
    const script = readFileSync(USERSCRIPT_PATH, "utf-8");
    res.setHeader("Content-Type", "text/javascript; charset=UTF-8");
    res.setHeader("Content-Disposition", 'inline; filename="factionops.user.js"');
    res.setHeader("Cache-Control", "no-cache");
    res.send(script);
  } catch (err) {
    console.error("[server] Failed to read userscript:", err.message);
    res.status(500).json({ error: "Script file not found" });
  }
});

// ── Scripts hosting ─────────────────────────────────────────────────────
// Serves userscripts by exact filename only. No directory listing.
// Scripts are stored in /opt/warboard/scripts/ on the VPS.
const SCRIPTS_DIR = join(__dirname, "scripts");

// Block directory listing and any path traversal
app.get("/scripts/", (_req, res) => res.status(403).json({ error: "Forbidden" }));
app.get("/scripts", (_req, res) => res.status(403).json({ error: "Forbidden" }));

// Serve individual .user.js and .meta.js files
app.get("/scripts/:filename", (req, res) => {
  const filename = req.params.filename;

  // Only allow .user.js and .meta.js files, no path traversal
  if (!/^[\w.-]+\.(?:user|meta)\.js$/.test(filename) || filename.includes("..")) {
    return res.status(404).json({ error: "Not found" });
  }

  const filePath = join(SCRIPTS_DIR, filename);
  if (!existsSync(filePath)) {
    return res.status(404).json({ error: "Not found" });
  }

  try {
    const script = readFileSync(filePath, "utf-8");
    res.setHeader("Content-Type", "text/javascript; charset=UTF-8");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-cache");
    res.send(script);
  } catch (err) {
    console.error(`[server] Failed to read script ${filename}:`, err.message);
    res.status(500).json({ error: "Failed to read script" });
  }
});

// ── Data files hosting ──────────────────────────────────────────────────
const DATA_DIR = join(__dirname, "data");

app.get("/data/", (_req, res) => res.status(403).json({ error: "Forbidden" }));
app.get("/data", (_req, res) => res.status(403).json({ error: "Forbidden" }));

app.get("/data/:filename", (req, res) => {
  const filename = req.params.filename;
  if (!/^[\w.-]+\.json$/.test(filename) || filename.includes("..")) {
    return res.status(404).json({ error: "Not found" });
  }
  const filePath = join(DATA_DIR, filename);
  if (!existsSync(filePath)) {
    return res.status(404).json({ error: "Not found" });
  }
  try {
    const data = readFileSync(filePath, "utf-8");
    res.setHeader("Content-Type", "application/json; charset=UTF-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(data);
  } catch (err) {
    console.error(`[server] Failed to read data file ${filename}:`, err.message);
    res.status(500).json({ error: "Failed to read file" });
  }
});

// ── Serve Socket.IO client (for PDA and CSP-restricted environments) ───
app.get("/socket.io.min.js", (_req, res) => {
  const sioPath = join(__dirname, "node_modules", "socket.io", "client-dist", "socket.io.min.js");
  try {
    const script = readFileSync(sioPath, "utf-8");
    res.setHeader("Content-Type", "application/javascript");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(script);
  } catch (err) {
    console.error("[server] Failed to serve Socket.IO client:", err.message);
    res.status(404).json({ error: "Socket.IO client not found" });
  }
});

// ── WhisperBoard training telemetry ─────────────────────────────────────
// Receives one-shot training-run reports from the keyboard so the user can
// see whether overnight auto-training actually ran (and succeeded). No auth:
// personal fork on one device, and the log is append-only JSON lines with
// no sensitive content (samples count + loss + error message, nothing
// user-typed). View at /whisperboard/training_log.
const WHISPERBOARD_LOG_DIR = join(__dirname, "..", "logs");
const WHISPERBOARD_LOG_PATH = join(WHISPERBOARD_LOG_DIR, "whisperboard_training.log");
try { mkdirSync(WHISPERBOARD_LOG_DIR, { recursive: true }); } catch {}

app.post("/whisperboard/training_log", (req, res) => {
  const body = req.body || {};
  const entry = {
    ts: new Date().toISOString(),
    ip: req.ip,
    versionName: String(body.versionName || "").slice(0, 32),
    versionCode: Number.isFinite(+body.versionCode) ? +body.versionCode : null,
    success: !!body.success,
    state: String(body.state || "").slice(0, 32),
    samples: Number.isFinite(+body.samples) ? +body.samples : null,
    loss: Number.isFinite(+body.loss) ? +body.loss : null,
    durationMs: Number.isFinite(+body.durationMs) ? +body.durationMs : null,
    trigger: String(body.trigger || "").slice(0, 32),
    error: body.error ? String(body.error).slice(0, 512) : null,
  };
  try {
    appendFileSync(WHISPERBOARD_LOG_PATH, JSON.stringify(entry) + "\n");
    res.json({ ok: true });
  } catch (err) {
    console.error("[whisperboard] log append failed:", err.message);
    res.status(500).json({ ok: false });
  }
});

app.get("/whisperboard/training_log", (_req, res) => {
  try {
    const content = existsSync(WHISPERBOARD_LOG_PATH)
      ? readFileSync(WHISPERBOARD_LOG_PATH, "utf-8")
      : "";
    res.setHeader("Content-Type", "text/plain; charset=UTF-8");
    res.setHeader("Cache-Control", "no-cache");
    res.send(content);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Weav3r dollar-deals cache ───────────────────────────────────────────
// Shared snapshot of weav3r.dev's dollar-bazaars list, refreshed every 30s
// by one background poller. Userscript clients connect via SSE and get live
// pushes instead of each polling weav3r themselves.
app.get("/api/weav3r/deals", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  weav3rDealsHits++;
  res.json(getWeav3rSnapshot());
});

// Lightweight usage telemetry for weav3r endpoints. Used to decide
// whether the polling budget is worth the 60/min API calls it burns.
let weav3rDealsHits = 0;
let weav3rStreamSubs = 0;
let weav3rStreamOpens = 0;

app.get("/api/weav3r/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type":  "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection":    "keep-alive",
    // CORS allowed separately at top of file for torn.com origins.
  });

  weav3rStreamSubs++;
  weav3rStreamOpens++;
  const clientIp = req.ip || req.headers['x-forwarded-for'] || '?';
  console.log(`[weav3r-usage] stream-open from ${clientIp} — active subs: ${weav3rStreamSubs}`);

  // Immediate snapshot on connect so the client has data within ~1 RTT.
  const initial = getWeav3rSnapshot();
  res.write(`event: snapshot\ndata: ${JSON.stringify(initial)}\n\n`);

  // Subscribe to refresh events.
  const unsub = subscribeToWeav3r((snap) => {
    try {
      res.write(`event: update\ndata: ${JSON.stringify(snap)}\n\n`);
    } catch (_) { /* client gone, cleanup via close below */ }
  });

  // Periodic keepalive so intermediaries / mobile networks don't drop idle.
  const ping = setInterval(() => {
    try { res.write(":ping\n\n"); } catch (_) {}
  }, 25_000);

  req.on("close", () => {
    clearInterval(ping);
    unsub();
    weav3rStreamSubs--;
    console.log(`[weav3r-usage] stream-close — active subs: ${weav3rStreamSubs}`);
  });
});

// Admin-only usage snapshot. Dev XID 137558 only.
app.get("/api/weav3r/usage", (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json({ error: "key required" });
  // Lightweight check: just require it matches the dev key. Intentionally
  // no Torn API verify here to keep it cheap — leaks nothing sensitive.
  import("./auth.js").then(async ({ verifyTornApiKey }) => {
    try {
      const info = await verifyTornApiKey(key);
      if (String(info.playerId) !== '137558') {
        return res.status(403).json({ error: "dev only" });
      }
      res.json({
        dealsHits: weav3rDealsHits,
        streamSubsActive: weav3rStreamSubs,
        streamOpensTotal: weav3rStreamOpens,
        snapshot: getWeav3rSnapshot(),
      });
    } catch (e) {
      res.status(401).json({ error: e.message });
    }
  });
});

// Weav3r verify-key pool (see weav3r-pool.js). Users contribute their
// Torn API key to spread the per-seller bazaar verify load across many
// members instead of burning OWNER_API_KEY's 100/min budget. The query
// selection `user/<id>?selections=bazaar` is public — pooling is safe.
app.get("/api/weav3r/pool/status", async (req, res) => {
  const key = req.query.key;
  if (!key || String(key).length < 10) return res.status(400).json({ error: "key required" });
  try {
    const { verifyTornApiKey } = await import("./auth.js");
    const info = await verifyTornApiKey(String(key));
    res.json({
      optedIn:  weav3rPool.hasKey(info.playerId),
      poolSize: weav3rPool.size(),
      playerId: String(info.playerId),
    });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

app.post("/api/weav3r/pool/opt-in", async (req, res) => {
  const key = (req.body && req.body.key) || req.query.key;
  if (!key || String(key).length < 10) return res.status(400).json({ error: "key required" });
  try {
    const { verifyTornApiKey } = await import("./auth.js");
    const info = await verifyTornApiKey(String(key));
    if (weav3rPool.isBlocked(info.playerId)) {
      // Dev / owner — intentionally never enrolled so pool load stays
      // spread across community contributors. Return ok so the UI shows
      // the expected "off" state without showing an error.
      return res.json({ ok: true, optedIn: false, blocked: true, poolSize: weav3rPool.size() });
    }
    const sizeBefore = weav3rPool.size();
    weav3rPool.addKey(info.playerId, String(key));
    const sizeAfter = weav3rPool.size();
    console.log(`[weav3r-pool] opt-in: ${info.playerName} (${info.playerId}) — pool size: ${sizeAfter}`);
    // First contributor after an empty pool? Kick verify immediately so we
    // don't wait ~15s for the next weav3r refresh cycle.
    if (sizeBefore === 0 && sizeAfter > 0) kickVerifyOnPoolGrowth();
    res.json({ ok: true, optedIn: true, poolSize: sizeAfter });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

app.post("/api/weav3r/pool/opt-out", async (req, res) => {
  const key = (req.body && req.body.key) || req.query.key;
  if (!key || String(key).length < 10) return res.status(400).json({ error: "key required" });
  try {
    const { verifyTornApiKey } = await import("./auth.js");
    const info = await verifyTornApiKey(String(key));
    weav3rPool.removeKey(info.playerId);
    console.log(`[weav3r-pool] opt-out: ${info.playerName} (${info.playerId}) — pool size: ${weav3rPool.size()}`);
    res.json({ ok: true, optedIn: false, poolSize: weav3rPool.size() });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

// Anonymous diagnostic channel for in-browser userscripts. Accepts a small
// JSON body and logs it with a tag we can grep from pm2. Used temporarily
// to debug why a feature fires or doesn't on a user's browser without
// needing them to paste console output.
const _diagHits = new Map(); // ip → { count, firstAt }
app.post("/api/debug/client-log", express.json({ limit: "4kb" }), (req, res) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  const bucket = _diagHits.get(ip) || { count: 0, firstAt: now };
  if (now - bucket.firstAt > 60_000) { bucket.count = 0; bucket.firstAt = now; }
  bucket.count++;
  _diagHits.set(ip, bucket);
  if (bucket.count > 60) return res.status(429).end(); // 60/min per IP cap
  const tag = String(req.body?.tag || 'client-diag').slice(0, 40);
  let payload;
  try { payload = JSON.stringify(req.body?.data || {}).slice(0, 1500); }
  catch (_) { payload = '<unserializable>'; }
  console.log(`[${tag}] ${payload}`);
  res.status(204).end();
});

app.use(routes);

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// ── HTTP + Socket.IO server ─────────────────────────────────────────────

const httpServer = createServer(app);

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: function (origin, callback) {
      // Allow requests with no origin (like mobile apps or some curl requests)
      // or "null" origin (common in some sandbox/userscript environments)
      if (!origin || origin === "null") {
        return callback(null, true);
      }
      if (/\.torn\.com$/.test(origin) || /tornwar\.com/.test(origin) || /^https?:\/\/localhost/.test(origin)) {
        return callback(null, true);
      }
      // Log unexpected origins for debugging
      console.log('[ws] CORS rejected origin:', origin);
      callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST'],
  },
  allowEIO3: true,
});

// Share io instance with route handlers for real-time broadcasts
setIO(io);

// Authenticate every socket connection via JWT
io.use(socketAuth);

io.on("connection", (socket) => {
  console.log(`[ws] Socket connected: ${socket.id} (player: ${socket.user.playerName})`);
  
  // Admin/Leader Broadcast Listener
  socket.on('admin_broadcast', (data) => {
      const adminId = '137558'; 
      const pos = socket.user?.factionPosition || '';
      const isLeader = pos === 'leader' || pos === 'co-leader' || pos === 'war leader' || pos === 'banker';
      
      if (socket.user && String(socket.user.playerId) === adminId) {
          // Global broadcast
          io.emit('global_toast', { 
              message: data.message, 
              type: data.type || 'info' 
          });
          console.log(`[📣] Global Admin Broadcast sent: ${data.message}`);
      } else if (socket.user && isLeader) {
          // Faction-only broadcast
          const warId = `war_${socket.user.factionId}`;
          const room = `war_${warId}`;
          
          io.to(room).emit('global_toast', { 
              message: data.message, 
              type: data.type || 'info' 
          });
          console.log(`[📣] Faction Broadcast sent by ${socket.user.playerName} to room ${room}: ${data.message}`);
      } else {
          console.log(`[⚠️] Blocked unauthorized broadcast attempt.`);
      }
  });

  registerSocketHandlers(io, socket);

  // When a player joins a war, ensure status monitoring is running
  // Chain data comes from clients via DOM reading — no server-side chain polling needed
  socket.on("join_war", ({ warId }) => {
    // Small delay to let the war get created/loaded first
    setTimeout(() => {
      const war = store.getWar(warId);
      if (war?.enemyFactionId) {
        startWarStatusMonitor(io, warId);
      }
    }, 100);
  });
});

// ── Load persisted state & start ────────────────────────────────────────

store.loadState();
store.loadFactionKeys();
store.loadPlayerKeys();
store.loadFactionSettings();
store.loadKeyPoolingOpt();
store.loadPlayerFactions();
store.loadMemberBars();
loadHeatmaps();
loadSubscriptions();

// Resume war status monitors for any persisted wars (skip ended wars)
for (const [warId, war] of store.getAllWars()) {
  if (war.enemyFactionId && !war.warEnded) {
    startWarStatusMonitor(io, warId);
  }
}

// Schedule weekly membership verification (every Tuesday)
startMembershipSchedule();
  startXanaxSubscriptions();
  startWeav3rCache();
  // Background poller handles OWNER faction only (uses OWNER_API_KEY).
  // Other factions get "piggy-back" cleanup — /api/oc/vault-requests
  // opportunistically triggers a fundsnews poll using the caller's OWN
  // key whenever someone opens the panel. No stored keys needed, each
  // user's key only polls their own faction. See vault-requests.js.
  const OWNER_FID = String(process.env.OWNER_FACTION_ID || '42055');
  vaultRequests.startPoller({
    getApiKeyForFaction: async (factionId) =>
      String(factionId) === OWNER_FID ? (process.env.OWNER_API_KEY || '') : '',
    listActiveFactions: () => [OWNER_FID],
  });

// Start faction subscription manager (polls for 50M payments)
startSubscriptionManager();

// ── Auto-detect new ranked wars every 5 minutes ─────────────────────────
let warDetectTimer = null;
const WAR_DETECT_INTERVAL_NORMAL = 5 * 60 * 1000; // 5 minutes
const WAR_DETECT_INTERVAL_ACTIVE = 60 * 1000;      // 1 minute during war start window

async function detectNewWars() {
  try {
    const now = new Date();
    const day = now.getUTCDay(); // 0=Sun, 2=Tue
    const utcHour = now.getUTCHours();
    const hasActiveWar = [...store.getAllWars()].some(([, w]) => w.enemyFactionId && !w.warEnded);

    // Always check if there's an active war (war spans multiple days)
    // On non-Tuesday days with no active war, skip to save API calls
    if (!hasActiveWar && day !== 2) return;
    // if (day === 2 && utcHour >= 14 && !hasActiveWar) return; // no match this week, stop polling

    // On Tuesdays, poll every 1 min between 11:45-12:30 UTC (war start window)
    // Outside that window, poll every 5 min
    const inStartWindow = day === 2 && ((utcHour === 11 && now.getUTCMinutes() >= 45) || utcHour === 12 && now.getUTCMinutes() <= 30);
    if (inStartWindow && warDetectTimer) {
      clearInterval(warDetectTimer);
      warDetectTimer = setInterval(detectNewWars, WAR_DETECT_INTERVAL_ACTIVE);
    } else if (!inStartWindow && warDetectTimer) {
      clearInterval(warDetectTimer);
      warDetectTimer = setInterval(detectNewWars, WAR_DETECT_INTERVAL_NORMAL);
    }

    // Check all factions that have stored API keys
    const allWars = store.getAllWars();
    const activeWarFactions = new Set();
    for (const [, war] of allWars) {
      if (war.factionId) activeWarFactions.add(war.factionId);
    }

    // Check each faction with a stored key
    const factionKeys = store.getAllFactionKeys ? store.getAllFactionKeys() : [];
    for (const [factionId, apiKey] of factionKeys) {
      if (!isFactionAllowed(factionId)) continue;
      try {
        const rw = await fetchRankedWar(factionId, apiKey);
        if (!rw || !rw.warId || !rw.enemyFactionId) continue;

        const warId = `war_${factionId}`;
        const existing = store.getWar(warId);
        if (existing && !existing.enemyFactionName && rw.enemyFactionName) {
          existing.enemyFactionName = rw.enemyFactionName;
          store.saveState();
        }

        const enemyChanged = existing && String(existing.enemyFactionId) !== String(rw.enemyFactionId);
        console.log(`[war-detect] Check: existing=${existing?.enemyFactionId || 'none'}, api=${rw.enemyFactionId}, changed=${enemyChanged}, ended=${existing?.warEnded}`);

        // If no existing war, enemy changed, or war ended — reset and create fresh entry
        if (!existing || !existing.enemyFactionId || existing.warEnded || enemyChanged) {
          if (enemyChanged) {
            console.log(`[war-detect] Enemy changed: ${existing.enemyFactionId} → ${rw.enemyFactionId} — resetting war state`);
            // Clear stale data from old war
            const war = store.getWar(warId);
            if (war) {
              war.warEnded = false; war.warResult = null; war.warEndedAt = null;
              war.warScores = null; war.warStart = null; war.warOrigTarget = null;
              war.warEta = null; war.clientTimerReport = null; war.chainData = null;
              war.enemyActivityLog = []; war.enemyActivityByHour = {};
            }
          }
          const war = store.getOrCreateWar(warId, factionId, rw.enemyFactionId);
          war.enemyFactionName = rw.enemyFactionName;
          war.enemyFactionId = rw.enemyFactionId;
          // Store war start time from API
          if (rw.warStart) war.warStart = rw.warStart;
          if (rw.warTarget) war.warOrigTarget = rw.warTarget;
          store.saveState();
          startWarStatusMonitor(io, warId);
          console.log(`[war-detect] Detected war: ${factionId} vs ${rw.enemyFactionName} (${rw.enemyFactionId}), starts: ${new Date(rw.warStart * 1000).toISOString()}`);
        }
      } catch (_) {
        // API error for this faction, skip
      }
    }
  } catch (err) {
    console.error('[war-detect] Detection failed:', err.message);
  }
}

// Run detection on startup (after a short delay) and every 5 minutes
setTimeout(detectNewWars, 10000);
warDetectTimer = setInterval(detectNewWars, WAR_DETECT_INTERVAL_NORMAL);
console.log('[war-detect] Auto-detection scheduled (5 min normal, 1 min during Tuesday 11:45-12:30 UTC)');

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`[server] FactionOps server listening on port ${PORT}`);
  console.log(`[server] Landing page: http://localhost:${PORT}`);
  console.log(`[server] Script download: http://localhost:${PORT}/download/factionops.user.js`);
  console.log(`[server] REST API: http://localhost:${PORT}/api`);
  console.log(`[server] WebSocket: ws://localhost:${PORT}`);
});

// ── Graceful shutdown ───────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`\n[server] Received ${signal}, shutting down...`);
  stopAllChainMonitors();
  stopAllWarStatusMonitors();
  if (warDetectTimer) { clearInterval(warDetectTimer); warDetectTimer = null; }
  try { stopPersonalMonitor(); } catch (_) {}
  stopHeatmapFlush();
  stopMembershipSchedule();
  stopSubscriptionManager();

  store.saveState();
  store.saveMemberBars();
  httpServer.close(() => {
    console.log("[server] Server closed");
    process.exit(0);
  });
  // Force exit after 5 seconds if connections don't close
  setTimeout(() => process.exit(0), 5000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
