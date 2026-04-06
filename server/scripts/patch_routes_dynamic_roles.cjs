const fs = require('fs');
const path = '../routes.js';
let code = fs.readFileSync(path, 'utf8');

const oldCode1 = `import * as store from "./store.js";`;

const newCode1 = `import * as store from "./store.js";
import { getAllowedBroadcastRoles, updateFactionSettings } from "./store.js";`;

const oldCode2 = `  // Enforce leader/banker position
  const pos = (factionPosition || "").toLowerCase();
  const isLeader = ["leader", "co-leader", "war leader", "banker"].includes(pos);

  if (!isLeader && !isGlobalAdmin) {`;

const newCode2 = `  // Enforce leader/banker position (or custom faction roles)
  const pos = (factionPosition || "").toLowerCase();
  const allowedRoles = getAllowedBroadcastRoles(req.user.factionId);
  const isLeader = allowedRoles.includes(pos);

  if (!isLeader && !isGlobalAdmin) {`;

code = code.replace(oldCode1, newCode1);
code = code.replace(oldCode2, newCode2);
fs.writeFileSync(path, code);
console.log('Successfully patched routes.js');
