/**
 * Socket.IO event handlers for real-time war coordination.
 */

import * as store from "./store.js";
import { fetchFactionMembers } from "./torn-api.js";

const CALL_EXPIRE_MS = parseInt(process.env.CALL_EXPIRE_MS, 10) || 5 * 60 * 1000; // 5 minutes
const SOFT_UNCALL_MS = 30_000; // 30 seconds after hospital detection
const REFRESH_COOLDOWN_MS = 30_000; // 30 seconds between refreshes per war

/** Track call expiry timers so they can be cancelled. */
const callTimers = new Map(); // `${warId}:${targetId}` → timeoutId

/** Track last refresh timestamp per warId. */
const refreshCooldowns = new Map(); // warId → timestamp

/**
 * Register all Socket.IO event handlers for a connected socket.
 * @param {import("socket.io").Server} io
 * @param {import("socket.io").Socket} socket
 */
export function registerSocketHandlers(io, socket) {
  const user = socket.user; // set by auth middleware: { playerId, playerName, factionId, factionName }

  // ── join_war ────────────────────────────────────────────────────────

  socket.on("join_war", ({ warId, factionId, enemyFactionId }) => {
    if (!warId || !factionId) {
      return socket.emit("error", { message: "warId and factionId are required" });
    }

    const room = `war_${warId}`;
    socket.join(room);

    // Track the player
    store.setPlayer(user.playerId, {
      socketId: socket.id,
      factionId,
      warId,
      name: user.playerName,
    });

    // Ensure war exists
    const war = store.getOrCreateWar(warId, factionId, enemyFactionId || null);

    console.log(`[ws] ${user.playerName} joined war room ${room}`);

    // Send current war state to the joining player
    socket.emit("war_state", {
      warId: war.warId,
      factionId: war.factionId,
      enemyFactionId: war.enemyFactionId,
      calls: war.calls,
      rallies: war.rallies,
      enemyStatuses: war.enemyStatuses,
      chainData: war.chainData,
      onlinePlayers: store.getOnlinePlayersForWar(warId),
    });
  });

  // ── call_target ─────────────────────────────────────────────────────

  socket.on("call_target", ({ targetId, targetName }) => {
    if (!targetId) {
      return socket.emit("error", { message: "targetId is required" });
    }

    const player = store.getPlayer(user.playerId);
    if (!player?.warId) {
      return socket.emit("error", { message: "You must join a war first" });
    }

    const war = store.getWar(player.warId);
    if (!war) return;

    // Check if target is already called
    if (war.calls[targetId]) {
      return socket.emit("error", {
        message: `Target ${targetId} is already called by ${war.calls[targetId].calledBy.name}`,
      });
    }

    // Register the call
    const callData = {
      calledBy: { id: user.playerId, name: user.playerName },
      timestamp: Date.now(),
    };
    war.calls[targetId] = callData;
    store.saveState();

    const room = `war_${player.warId}`;
    io.to(room).emit("target_called", {
      targetId,
      targetName: targetName || targetId,
      calledBy: callData.calledBy,
      timestamp: callData.timestamp,
    });

    // Set auto-expire timer
    const timerKey = `${player.warId}:${targetId}`;
    clearExistingTimer(timerKey);
    callTimers.set(
      timerKey,
      setTimeout(() => {
        uncallTarget(io, player.warId, targetId, "expired");
      }, CALL_EXPIRE_MS),
    );

    console.log(`[ws] ${user.playerName} called target ${targetId} in war ${player.warId}`);
  });

  // ── uncall_target ───────────────────────────────────────────────────

  socket.on("uncall_target", ({ targetId }) => {
    if (!targetId) {
      return socket.emit("error", { message: "targetId is required" });
    }

    const player = store.getPlayer(user.playerId);
    if (!player?.warId) return;

    const war = store.getWar(player.warId);
    if (!war) return;

    // Only the caller can uncall (or the system via auto-expire)
    const call = war.calls[targetId];
    if (!call) return;
    if (call.calledBy.id !== user.playerId) {
      return socket.emit("error", { message: "Only the caller can uncall this target" });
    }

    uncallTarget(io, player.warId, targetId, "manual");
    console.log(`[ws] ${user.playerName} uncalled target ${targetId}`);
  });

  // ── rally_target ────────────────────────────────────────────────────

  socket.on("rally_target", ({ targetId, targetName, message }) => {
    if (!targetId) {
      return socket.emit("error", { message: "targetId is required" });
    }

    const player = store.getPlayer(user.playerId);
    if (!player?.warId) {
      return socket.emit("error", { message: "You must join a war first" });
    }

    const war = store.getWar(player.warId);
    if (!war) return;

    if (war.rallies[targetId]) {
      return socket.emit("error", { message: "A rally already exists for this target" });
    }

    const rallyData = {
      createdBy: { id: user.playerId, name: user.playerName },
      message: message || "",
      participants: [{ id: user.playerId, name: user.playerName }],
      timestamp: Date.now(),
    };
    war.rallies[targetId] = rallyData;
    store.saveState();

    const room = `war_${player.warId}`;
    io.to(room).emit("rally_started", {
      targetId,
      targetName: targetName || targetId,
      createdBy: rallyData.createdBy,
      message: rallyData.message,
      participants: rallyData.participants,
    });

    console.log(`[ws] ${user.playerName} started rally on ${targetId}`);
  });

  // ── join_rally ──────────────────────────────────────────────────────

  socket.on("join_rally", ({ targetId }) => {
    if (!targetId) {
      return socket.emit("error", { message: "targetId is required" });
    }

    const player = store.getPlayer(user.playerId);
    if (!player?.warId) return;

    const war = store.getWar(player.warId);
    if (!war) return;

    const rally = war.rallies[targetId];
    if (!rally) {
      return socket.emit("error", { message: "No rally exists for this target" });
    }

    // Don't add duplicates
    if (rally.participants.some((p) => p.id === user.playerId)) return;

    rally.participants.push({ id: user.playerId, name: user.playerName });
    store.saveState();

    io.to(`war_${player.warId}`).emit("rally_updated", {
      targetId,
      participants: rally.participants,
    });

    console.log(`[ws] ${user.playerName} joined rally on ${targetId}`);
  });

  // ── leave_rally ─────────────────────────────────────────────────────

  socket.on("leave_rally", ({ targetId }) => {
    if (!targetId) return;

    const player = store.getPlayer(user.playerId);
    if (!player?.warId) return;

    const war = store.getWar(player.warId);
    if (!war) return;

    const rally = war.rallies[targetId];
    if (!rally) return;

    rally.participants = rally.participants.filter((p) => p.id !== user.playerId);
    store.saveState();

    io.to(`war_${player.warId}`).emit("rally_updated", {
      targetId,
      participants: rally.participants,
    });

    console.log(`[ws] ${user.playerName} left rally on ${targetId}`);
  });

  // ── cancel_rally ────────────────────────────────────────────────────

  socket.on("cancel_rally", ({ targetId }) => {
    if (!targetId) return;

    const player = store.getPlayer(user.playerId);
    if (!player?.warId) return;

    const war = store.getWar(player.warId);
    if (!war) return;

    const rally = war.rallies[targetId];
    if (!rally) return;

    // Only the rally creator can cancel
    if (rally.createdBy.id !== user.playerId) {
      return socket.emit("error", { message: "Only the rally creator can cancel it" });
    }

    delete war.rallies[targetId];
    store.saveState();

    io.to(`war_${player.warId}`).emit("rally_cancelled", { targetId });
    console.log(`[ws] ${user.playerName} cancelled rally on ${targetId}`);
  });

  // ── update_status ───────────────────────────────────────────────────

  socket.on("update_status", ({ targetId, status, until }) => {
    if (!targetId || !status) {
      return socket.emit("error", { message: "targetId and status are required" });
    }

    const player = store.getPlayer(user.playerId);
    if (!player?.warId) return;

    const war = store.getWar(player.warId);
    if (!war) return;

    // Merge with existing data (preserve name/level if already known)
    const existing = war.enemyStatuses[targetId] || {};
    war.enemyStatuses[targetId] = {
      ...existing,
      status,
      until: until ?? existing.until ?? 0,
    };
    store.saveState();

    io.to(`war_${player.warId}`).emit("status_updated", {
      targetId,
      status,
      until: until ?? 0,
      updatedBy: { id: user.playerId, name: user.playerName },
    });

    // If target is in hospital and is currently called, soft-uncall after delay
    if (status.toLowerCase().includes("hospital")) {
      const call = war.calls[targetId];
      if (call) {
        const timerKey = `${player.warId}:${targetId}`;
        clearExistingTimer(timerKey);
        callTimers.set(
          timerKey,
          setTimeout(() => {
            uncallTarget(io, player.warId, targetId, "hospital");
          }, SOFT_UNCALL_MS),
        );
      }
    }
  });

  // ── refresh_statuses ────────────────────────────────────────────────

  socket.on("refresh_statuses", async ({ factionId }) => {
    const player = store.getPlayer(user.playerId);
    if (!player?.warId) return;

    const war = store.getWar(player.warId);
    if (!war || !war.enemyFactionId) {
      return socket.emit("error", { message: "No enemy faction configured for this war" });
    }

    // Rate limit: max 1 refresh per 30s per war room
    const now = Date.now();
    const lastRefresh = refreshCooldowns.get(player.warId) || 0;
    if (now - lastRefresh < REFRESH_COOLDOWN_MS) {
      const waitSec = Math.ceil((REFRESH_COOLDOWN_MS - (now - lastRefresh)) / 1000);
      return socket.emit("error", { message: `Please wait ${waitSec}s before refreshing again` });
    }
    refreshCooldowns.set(player.warId, now);

    // Get an API key
    const apiKey = store.getApiKeyForFaction(factionId || war.factionId);
    if (!apiKey) {
      return socket.emit("error", { message: "No API key available for status refresh" });
    }

    try {
      const statuses = await fetchFactionMembers(war.enemyFactionId, apiKey);
      war.enemyStatuses = statuses;
      store.saveState();

      io.to(`war_${player.warId}`).emit("statuses_refreshed", { statuses });
      console.log(`[ws] Statuses refreshed for war ${player.warId} (${Object.keys(statuses).length} members)`);
    } catch (err) {
      console.error("[ws] Status refresh failed:", err.message);
      socket.emit("error", { message: `Status refresh failed: ${err.message}` });
    }
  });

  // ── disconnect ──────────────────────────────────────────────────────

  socket.on("disconnect", (reason) => {
    // Remove from online players but do NOT auto-uncall (they might reconnect)
    const removed = store.removePlayerBySocket(socket.id);
    if (removed) {
      console.log(`[ws] ${removed.name} disconnected (${reason})`);
    }
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────

function clearExistingTimer(timerKey) {
  if (callTimers.has(timerKey)) {
    clearTimeout(callTimers.get(timerKey));
    callTimers.delete(timerKey);
  }
}

function uncallTarget(io, warId, targetId, reason) {
  const war = store.getWar(warId);
  if (!war || !war.calls[targetId]) return;

  delete war.calls[targetId];
  store.saveState();

  const timerKey = `${warId}:${targetId}`;
  clearExistingTimer(timerKey);

  io.to(`war_${warId}`).emit("target_uncalled", { targetId, reason });
}
