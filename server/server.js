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

import routes, { setIO } from "./routes.js";
import { socketAuth } from "./auth.js";
import { registerSocketHandlers } from "./socket-handlers.js";
import { startChainMonitor, stopAll as stopAllChainMonitors } from "./chain-monitor.js";
import { startWarStatusMonitor, stopAll as stopAllWarStatusMonitors } from "./war-status-monitor.js";
import { loadHeatmaps, stopFlush as stopHeatmapFlush } from "./activity-heatmap.js";
import { startMembershipSchedule, stopMembershipSchedule } from "./membership-check.js";
import * as store from "./store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Configuration ───────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT, 10) || 3000;

// ── Express setup ───────────────────────────────────────────────────────

const app = express();

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
app.use(express.json());

// ── Landing page is public — gate is applied only to /scripts/*.user.js below ──

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
      if (!origin) return callback(null, true);
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
loadHeatmaps();

// Resume war status monitors for any persisted wars
// Chain data comes from clients via DOM reading — no server-side chain polling needed
for (const [warId, war] of store.getAllWars()) {
  if (war.enemyFactionId) {
    startWarStatusMonitor(io, warId);
  }
}

// Schedule weekly membership verification (every Tuesday)
startMembershipSchedule();

httpServer.listen(PORT, () => {
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
  stopHeatmapFlush();
  stopMembershipSchedule();
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
