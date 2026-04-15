/**
 * Authentication module – Torn API key verification + JWT issuance.
 */

import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "change-this-to-a-random-string";
const JWT_EXPIRY = "90d";

// ── Torn API verification ───────────────────────────────────────────────

/**
 * Verify a Torn API key by calling the Torn API and extracting player info.
 * Returns `{ playerId, playerName, factionId, factionName }` or throws.
 */
export async function verifyTornApiKey(apiKey) {
  const url = `https://api.torn.com/user/?selections=basic,profile&key=${encodeURIComponent(apiKey)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout
  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    throw new Error(`Torn API returned HTTP ${res.status}`);
  }

  const data = await res.json();

  if (data.error) {
    throw new Error(`Torn API error: ${data.error.error} (code ${data.error.code})`);
  }

  // Check if key has faction API access
  // Use v2 faction/crimes (requires faction perms). If Torn returns a permission error
  // (code 7 = not enough access), that's a real "no access". If it times out or 5xx,
  // assume access is fine (benefit of the doubt) so the user isn't locked out.
  let hasFactionAccess = true; // default true -- only set false on explicit permission denial
  try {
    const fRes = await fetch(`https://api.torn.com/v2/faction/crimes?cat=available&limit=1&key=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(5000) });
    if (fRes.ok) {
      const fData = await fRes.json();
      if (fData.error) {
        const code = fData.error.code;
        // Code 7 = insufficient permissions, code 16 = access level too low
        if (code === 7 || code === 16) hasFactionAccess = false;
        // Other errors (rate limit, server error) -- keep true
      }
    }
    // HTTP 5xx / timeout -- keep hasFactionAccess = true
  } catch (_) { /* network error / timeout -- keep true */ }

  return {
    playerId: String(data.player_id),
    playerName: data.name,
    factionId: String(data.faction?.faction_id ?? 0),
    factionName: data.faction?.faction_name ?? "",
    factionPosition: data.faction?.position ?? "",
    hasFactionAccess,
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
