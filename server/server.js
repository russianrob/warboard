/**
 * FactionOps Server – Torn.com faction war coordination tool.
 *
 * Express + Socket.IO backend providing:
 *  - JWT auth via Torn API key verification
 *  - Real-time target calling, rallying, and status tracking
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
import { readFileSync } from "node:fs";

import routes from "./routes.js";
import { socketAuth } from "./auth.js";
import { registerSocketHandlers } from "./socket-handlers.js";
import { startChainMonitor, stopAll as stopAllChainMonitors } from "./chain-monitor.js";
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

// ── Static files (landing page) ─────────────────────────────────────────
app.use(express.static(join(__dirname, "public")));

// ── Userscript download route ───────────────────────────────────────────
const USERSCRIPT_PATH = join(__dirname, "..", "client", "factionops.user.js");

app.get("/download/factionops.user.js", (_req, res) => {
  try {
    const script = readFileSync(USERSCRIPT_PATH, "utf-8");
    res.setHeader("Content-Type", "text/javascript");
    res.setHeader("Content-Disposition", 'inline; filename="factionops.user.js"');
    res.send(script);
  } catch (err) {
    console.error("[server] Failed to serve userscript:", err.message);
    res.status(404).json({ error: "Userscript not found" });
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
      if (/\.torn\.com$/.test(origin) || /^https?:\/\/localhost/.test(origin)) {
        return callback(null, true);
      }
      callback(null, false);
    },
    credentials: true,
  },
});

// Authenticate every socket connection via JWT
io.use(socketAuth);

io.on("connection", (socket) => {
  console.log(`[ws] Socket connected: ${socket.id} (player: ${socket.user.playerName})`);
  registerSocketHandlers(io, socket);

  // When a player joins a war that has an enemy faction, ensure chain monitoring is running
  socket.on("join_war", ({ warId }) => {
    // Small delay to let the war get created/loaded first
    setTimeout(() => {
      const war = store.getWar(warId);
      if (war?.enemyFactionId) {
        startChainMonitor(io, warId);
      }
    }, 100);
  });
});

// ── Load persisted state & start ────────────────────────────────────────

store.loadState();

// Resume chain monitors for any persisted wars with enemy factions
for (const [warId, war] of store.getAllWars()) {
  if (war.enemyFactionId) {
    startChainMonitor(io, warId);
  }
}

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
