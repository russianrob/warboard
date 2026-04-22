/**
 * Warboard Developer Platform — v1 API, Personal Access Tokens, OpenAPI spec.
 *
 * Third-party developers register via their Torn API key → receive a long-lived
 * Personal Access Token (PAT) scoped to actions on factions they have access to.
 * PATs are hashed at rest (sha256) and only returned in full on creation.
 *
 * Scopes (draft):
 *   read:faction       — read basic faction state, war status, heatmap
 *   read:oc            — read OC spawn data
 *   read:bars          — read member bar/cooldown data
 *   subscribe:events   — subscribe to SSE event streams
 *   manage:webhooks    — create/delete webhooks for the faction
 *
 * Future scopes:
 *   write:vault-request, write:push, etc. — currently unimplemented
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { verifyTornApiKey } from "./auth.js";

const DATA_DIR   = process.env.DATA_DIR || "./data";
const PATS_FILE  = path.join(DATA_DIR, "dev-pats.json");
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT     = 100;   // 100 calls/min per PAT baseline

/** @type {Map<string, Pat>} tokenHash → pat record */
const pats = new Map();
/** @type {Map<string, number[]>} tokenHash → recent call timestamps */
const callWindow = new Map();

/** @typedef {{
 *   id: string,
 *   tokenHash: string,
 *   ownerPlayerId: string,
 *   ownerName: string,
 *   ownerFactionId: string,
 *   scopes: string[],
 *   name: string,
 *   createdAt: number,
 *   lastUsedAt: number,
 *   revoked: boolean,
 * }} Pat */

function load() {
  try {
    if (!fs.existsSync(PATS_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(PATS_FILE, "utf8"));
    for (const rec of raw) pats.set(rec.tokenHash, rec);
    console.log(`[dev-platform] loaded ${pats.size} PAT(s)`);
  } catch (e) {
    console.warn("[dev-platform] load failed:", e.message);
  }
}
function save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PATS_FILE, JSON.stringify([...pats.values()], null, 2), "utf8");
  } catch (e) {
    console.warn("[dev-platform] save failed:", e.message);
  }
}
load();

function hash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

/**
 * Create a new PAT after verifying ownership via Torn API key.
 * Returns { token, pat } — token shown ONCE, pat record saved hashed.
 */
export async function issuePat({ apiKey, scopes, name }) {
  if (!apiKey) throw new Error("apiKey required");
  if (!Array.isArray(scopes) || scopes.length === 0) throw new Error("scopes required");
  const info = await verifyTornApiKey(apiKey);
  const token = "wb_pat_" + crypto.randomBytes(24).toString("base64url");
  const rec = {
    id: newId("pat"),
    tokenHash: hash(token),
    ownerPlayerId: String(info.playerId),
    ownerName: info.playerName,
    ownerFactionId: String(info.factionId),
    scopes: scopes.slice(),
    name: name || "unnamed",
    createdAt: Date.now(),
    lastUsedAt: 0,
    revoked: false,
  };
  pats.set(rec.tokenHash, rec);
  save();
  return { token, pat: { ...rec, tokenHash: undefined } };
}

export function listPatsForPlayer(playerId) {
  const pid = String(playerId);
  return [...pats.values()]
    .filter(p => p.ownerPlayerId === pid && !p.revoked)
    .map(p => ({ ...p, tokenHash: undefined }));
}

export function revokePat(playerId, patId) {
  const pid = String(playerId);
  for (const p of pats.values()) {
    if (p.id === patId && p.ownerPlayerId === pid) {
      p.revoked = true;
      save();
      return true;
    }
  }
  return false;
}

/**
 * Middleware: parse Authorization: Bearer <token>, enforce rate limit + scopes.
 * Attaches req.pat on success.
 */
export function requirePat(requiredScopes = []) {
  return (req, res, next) => {
    const auth = req.headers.authorization || "";
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: "Bearer token required" });
    const token = m[1].trim();
    const rec = pats.get(hash(token));
    if (!rec || rec.revoked) return res.status(401).json({ error: "Invalid or revoked token" });
    // Scope check
    for (const need of requiredScopes) {
      if (!rec.scopes.includes(need)) {
        return res.status(403).json({ error: `Token missing required scope: ${need}` });
      }
    }
    // Rate limit
    const now = Date.now();
    const arr = callWindow.get(rec.tokenHash) || [];
    const pruned = arr.filter(t => t > now - RATE_WINDOW_MS);
    if (pruned.length >= RATE_LIMIT) {
      return res.status(429).json({ error: `Rate limit: ${RATE_LIMIT}/min per token` });
    }
    pruned.push(now);
    callWindow.set(rec.tokenHash, pruned);
    rec.lastUsedAt = now;
    req.pat = rec;
    next();
  };
}
