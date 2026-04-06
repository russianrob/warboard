const fs = require('fs');
const path = '../routes.js';
let code = fs.readFileSync(path, 'utf8');

const oldCode = `// ── POST /api/broadcast ──────────────────────────────────────────────────
// Faction Leaders/Bankers: Broadcast a message to their faction's war room.
router.post("/api/broadcast", requireAuth, (req, res) => {`;

const newCode = `// ── POST /api/broadcast ──────────────────────────────────────────────────
// Faction Leaders/Bankers: Broadcast a message to their faction's war room.
router.post("/api/broadcast", requireAuth, (req, res) => {`;

const newRoute = `
// Update custom broadcast roles for the faction.
router.post("/api/broadcast/roles", requireAuth, (req, res) => {
  const { playerId, factionPosition, factionId } = req.user;
  const { roles } = req.body ?? {};

  if (!Array.isArray(roles)) {
    return res.status(400).json({ error: "Roles must be an array of strings." });
  }

  const pos = (factionPosition || "").toLowerCase();
  const isLeader = ["leader", "co-leader", "war leader"].includes(pos);
  const isGlobalAdmin = (String(playerId) === '137558');

  if (!isLeader && !isGlobalAdmin) {
    return res.status(403).json({ error: "Only leaders and co-leaders can update broadcast roles." });
  }

  updateFactionSettings(factionId, { broadcastRoles: roles });
  return res.json({ success: true, roles });
});

`;

code = code.replace(oldCode, newCode + newRoute);
fs.writeFileSync(path, code);
console.log('Successfully added /api/broadcast/roles endpoint');
