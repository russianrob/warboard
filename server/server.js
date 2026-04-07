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
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

import routes, { setIO, gateMiddleware } from "./routes.js";
import "./war-scanner.js";
import { socketAuth } from "./auth.js";
import { registerSocketHandlers } from "./socket-handlers.js";
import { startChainMonitor, stopAll as stopAllChainMonitors } from "./chain-monitor.js";
import { startWarStatusMonitor, stopAll as stopAllWarStatusMonitors } from "./war-status-monitor.js";
import { loadHeatmaps, stopFlush as stopHeatmapFlush } from "./activity-heatmap.js";
import { startMembershipSchedule, stopMembershipSchedule } from "./membership-check.js";
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
app.use(express.json({ limit: '5mb' }));

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

    // Skip unless: Tuesday before 14:00 UTC, or active war tracking
    if (day !== 2 && !hasActiveWar) return;
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
          if (!enemyChanged) startWarStatusMonitor(io, warId);
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
  httpServer.close(() => {
    console.log("[server] Server closed");
    process.exit(0);
  });
  // Force exit after 5 seconds if connections don't close
  setTimeout(() => process.exit(0), 5000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
