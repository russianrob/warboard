const fs = require('fs');
const path = '../routes.js';
let code = fs.readFileSync(path, 'utf8');

const oldCode = `// ── POST /api/broadcast ──────────────────────────────────────────────────
// Admin only: Broadcast a message to all connected clients (Socket.IO and SSE).
router.post("/api/broadcast", requireAuth, (req, res) => {
  const { playerId, playerName } = req.user;
  const { message, type } = req.body ?? {};

  // Security Check: Lock this down to player ID 137558 (The Dev)
  const myPlayerId = '137558'; 
  
  if (String(playerId) !== myPlayerId) {
    console.log(\`[⚠️] Blocked unauthorized HTTP broadcast attempt from player \${playerId} (\${playerName}).\`);
    return res.status(403).json({ error: "Unauthorized broadcast attempt." });
  }

  if (!message) {
    return res.status(400).json({ error: "Message is required." });
  }

  // 1. Broadcast to Socket.IO clients
  if (io) {
    io.emit('global_toast', { 
        message: message, 
        type: type || 'info' 
    });
    console.log(\`[📣] Admin Broadcast (HTTP) sent to Socket.IO: \${message}\`);
  }

  // 2. Broadcast to SSE clients
  const payload = { type: 'global_toast', message, type: type || 'info' };
  for (const [warId, _clients] of sseClients.entries()) {
    broadcastSSE(warId, payload);
  }

  return res.json({ success: true });
});`;

const newCode = `// ── POST /api/broadcast ──────────────────────────────────────────────────
// Faction Leaders/Bankers: Broadcast a message to their faction's war room.
router.post("/api/broadcast", requireAuth, (req, res) => {
  const { playerId, playerName, factionPosition } = req.user;
  const { message, type, warId } = req.body ?? {};

  if (!warId) {
    return res.status(400).json({ error: "warId is required for faction broadcasts." });
  }

  if (!message) {
    return res.status(400).json({ error: "Message is required." });
  }

  // Check if it's the global admin (can broadcast anywhere)
  const isGlobalAdmin = (String(playerId) === '137558');
  
  // Enforce leader/banker position
  const pos = (factionPosition || "").toLowerCase();
  const isLeader = ["leader", "co-leader", "war leader", "banker"].includes(pos);

  if (!isLeader && !isGlobalAdmin) {
    console.log(\`[⚠️] Blocked unauthorized broadcast attempt from player \${playerId} (\${playerName}) - Role: \${pos}\`);
    return res.status(403).json({ error: "Only leaders and bankers can broadcast to the faction." });
  }

  const payload = { 
    message: message, 
    type: type || 'info' 
  };

  // 1. Broadcast to Socket.IO clients in this war room
  if (io) {
    io.to(\`war_\${warId}\`).emit('global_toast', payload);
  }

  // 2. Broadcast to SSE clients in this war room
  broadcastSSE(warId, { type: 'global_toast', ...payload });

  console.log(\`[📣] Faction Broadcast sent to war \${warId} by \${playerName}: \${message}\`);

  return res.json({ success: true });
});`;

if (code.includes(oldCode)) {
    fs.writeFileSync(path, code.replace(oldCode, newCode));
    console.log('Successfully updated routes.js to support Faction Broadcasts');
} else {
    console.log('Failed to find old code in routes.js');
}
