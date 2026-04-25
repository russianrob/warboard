/**
 * Authentication module – Torn API key verification + JWT issuance.
 */

import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "change-this-to-a-random-string";
const JWT_EXPIRY = "90d";

// ── Torn API verification ───────────────────────────────────────────────

// Cache auth validations in-memory so identical auth attempts within a
// short window don't re-hit Torn every time. Prevents the well-known
// cascade where a rate-limited user key fails auth → client auto-retries
// → every retry deepens Torn's penalty for that key.
const authCache = new Map(); // apiKey → { result?, error?, expiresAt }
const AUTH_CACHE_SUCCESS_TTL_MS = 5 * 60 * 1000; // 5 minutes on success
const AUTH_CACHE_FAILURE_TTL_MS = 30 * 1000;      // 30 seconds on failure

function setAuthCache(apiKey, entry) {
  authCache.set(apiKey, entry);
  // Defensive upper bound so the map can't grow unbounded with unique keys.
  if (authCache.size > 5000) {
    const oldest = authCache.keys().next().value;
    authCache.delete(oldest);
  }
}

/**
 * Verify a Torn API key by calling the Torn API and extracting player info.
 * Returns `{ playerId, playerName, factionId, factionName }` or throws.
 * Results are cached 5min (success) / 30s (failure) per-key.
 */
export async function verifyTornApiKey(apiKey) {
  const cached = authCache.get(apiKey);
  if (cached && Date.now() < cached.expiresAt) {
    if (cached.error) throw new Error(cached.error);
    return cached.result;
  }

  const userUrl = `https://api.torn.com/user/?selections=basic,profile&key=${encodeURIComponent(apiKey)}`;
  const keyUrl  = `https://api.torn.com/key/?selections=info&key=${encodeURIComponent(apiKey)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout
  let userRes, keyRes;
  try {
    [userRes, keyRes] = await Promise.all([
      fetch(userUrl, { signal: controller.signal }),
      fetch(keyUrl,  { signal: controller.signal }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  if (!userRes.ok) {
    const err = `Torn API returned HTTP ${userRes.status}`;
    setAuthCache(apiKey, { error: err, expiresAt: Date.now() + AUTH_CACHE_FAILURE_TTL_MS });
    throw new Error(err);
  }

  const data = await userRes.json();

  if (data.error) {
    const err = `Torn API error: ${data.error.error} (code ${data.error.code})`;
    setAuthCache(apiKey, { error: err, expiresAt: Date.now() + AUTH_CACHE_FAILURE_TTL_MS });
    throw new Error(err);
  }

  // /key/ can succeed independently; treat its failure as "unknown access"
  // rather than a fatal auth error — the user-endpoint call already proved
  // the key is at least Public.
  let accessLevel = 0;
  let accessType = "";
  let factionSelections = [];
  if (keyRes.ok) {
    try {
      const keyData = await keyRes.json();
      if (!keyData.error) {
        accessLevel = Number(keyData.access_level ?? 0);
        accessType = String(keyData.access_type || "");
        const sel = keyData.selections?.faction;
        if (Array.isArray(sel)) factionSelections = sel.map(String);
      }
    } catch (_) { /* ignore */ }
  }

  // Torn access levels: 1=Public, 2=Minimal, 3=Limited, 4=Full.
  // Faction endpoints (used by the OC spawn-key route) require Limited+.
  // Pool eligibility is stricter — see isPoolEligible() below.
  const result = {
    playerId: String(data.player_id),
    playerName: data.name,
    factionId: String(data.faction?.faction_id ?? 0),
    factionName: data.faction?.faction_name ?? "",
    factionPosition: data.faction?.position ?? "",
    hasFactionAccess: accessLevel >= 3,
    accessLevel,
    accessType,
    factionSelections,
  };
  setAuthCache(apiKey, { result, expiresAt: Date.now() + AUTH_CACHE_SUCCESS_TTL_MS });
  return result;
}

// ── Pool eligibility ────────────────────────────────────────────────────

// Faction selections any pool poller might use. With per-purpose
// routing in store.js the key only needs ONE of these to be useful —
// it'll be picked for the matching purpose's calls and skipped for
// the others. A key with NONE of these can't help any pool poller,
// so it shouldn't be added.
const ROUTABLE_POOL_SELECTIONS = ["attacks", "members", "chain"];

/**
 * Decide if an authenticated key is suitable for the rotating pool.
 * Returns { eligible: bool, reason: string|null, useful: string[] }.
 *
 * Full Access (level 4) keys always qualify (every faction selection
 * is implicitly granted). Limited Access (level 3) keys qualify if
 * their selections include AT LEAST ONE of the routable selections —
 * the per-purpose router in store.js dispatches each call to a key
 * that supports it, so a Limited key contributes to capacity for the
 * purposes it covers and is skipped for the rest. Public / Minimal
 * (level < 3) keys never qualify.
 */
export function isPoolEligible(authInfo) {
  if (!authInfo || authInfo.accessLevel < 3) {
    return { eligible: false, reason: 'Pool requires a Limited+ Access key', useful: [] };
  }
  if (authInfo.accessLevel >= 4) {
    return { eligible: true, reason: null, useful: ROUTABLE_POOL_SELECTIONS.slice() };
  }
  // Limited Access: useful if at least one routable selection is granted.
  const have = new Set(authInfo.factionSelections || []);
  const useful = ROUTABLE_POOL_SELECTIONS.filter(s => have.has(s));
  if (useful.length > 0) {
    return { eligible: true, reason: null, useful };
  }
  return {
    eligible: false,
    reason: `Limited Access key has none of the pool-routable faction selections (${ROUTABLE_POOL_SELECTIONS.join(', ')}). Enable at least one when generating your key.`,
    useful: [],
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
    // Opportunistically seed the persistent playerId → factionId map so
    // push notifications can reach offline members. Import lazily to
    // avoid a cycle between auth.js and store.js.
    if (req.user && req.user.playerId && req.user.factionId) {
      import("./store.js").then((s) => {
        if (typeof s.recordPlayerFaction === "function") {
          s.recordPlayerFaction(req.user.playerId, req.user.factionId);
        }
      }).catch(() => {});
    }
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
