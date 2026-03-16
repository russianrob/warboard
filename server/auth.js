/**
 * Authentication module – Torn API key verification + JWT issuance.
 */

import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "change-this-to-a-random-string";
const JWT_EXPIRY = "24h";

// ── Torn API verification ───────────────────────────────────────────────

/**
 * Verify a Torn API key by calling the Torn API and extracting player info.
 * Returns `{ playerId, playerName, factionId, factionName }` or throws.
 */
export async function verifyTornApiKey(apiKey) {
  const url = `https://api.torn.com/user/?selections=basic,profile&key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Torn API returned HTTP ${res.status}`);
  }

  const data = await res.json();

  if (data.error) {
    throw new Error(`Torn API error: ${data.error.error} (code ${data.error.code})`);
  }

  return {
    playerId: String(data.player_id),
    playerName: data.name,
    factionId: String(data.faction?.faction_id ?? 0),
    factionName: data.faction?.faction_name ?? "",
    factionPosition: data.faction?.position ?? "",
  };
}

// ── JWT helpers ─────────────────────────────────────────────────────────

/**
 * Issue a JWT containing the player's identity claims.
 */
export function issueToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

/**
 * Verify and decode a JWT. Returns the payload or throws on invalid/expired.
 */
export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// ── Express middleware ──────────────────────────────────────────────────

/**
 * Express middleware that requires a valid JWT in the Authorization header.
 * Attaches the decoded payload to `req.user`.
 */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) {
    return res.status(401).json({ error: "Missing Authorization header" });
  }

  const token = header.startsWith("Bearer ") ? header.slice(7) : header;

  try {
    req.user = verifyToken(token);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ── Socket.IO auth middleware ───────────────────────────────────────────

/**
 * Socket.IO middleware – verifies JWT passed via `auth.token` during handshake.
 */
export function socketAuth(socket, next) {
  const token = socket.handshake.auth?.token;
  if (!token) {
    return next(new Error("Authentication required"));
  }

  try {
    socket.user = verifyToken(token);
    next();
  } catch {
    next(new Error("Invalid or expired token"));
  }
}
