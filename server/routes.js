/**
 * REST API route definitions.
 */

import { Router } from "express";
import { verifyTornApiKey, issueToken, requireAuth } from "./auth.js";
import * as store from "./store.js";
import { fetchFactionMembers, fetchFactionChain } from "./torn-api.js";

const router = Router();

// ── POST /api/auth ──────────────────────────────────────────────────────

router.post("/api/auth", async (req, res) => {
  const { apiKey } = req.body ?? {};
  if (!apiKey || typeof apiKey !== "string") {
    return res.status(400).json({ error: "apiKey is required" });
  }

  try {
    const info = await verifyTornApiKey(apiKey);

    // Store the API key server-side for later Torn API calls
    store.storeApiKey(info.playerId, apiKey);

    const token = issueToken({
      playerId: info.playerId,
      playerName: info.playerName,
      factionId: info.factionId,
      factionName: info.factionName,
    });

    console.log(`[auth] Player ${info.playerName} (${info.playerId}) authenticated`);

    return res.json({
      token,
      player: info,
    });
  } catch (err) {
    console.error("[auth] Authentication failed:", err.message);
    return res.status(401).json({ error: err.message });
  }
});

// ── GET /api/faction/:factionId/war ─────────────────────────────────────

router.get("/api/faction/:factionId/war", requireAuth, (req, res) => {
  const { factionId } = req.params;

  // Find all wars for this faction
  const result = [];
  for (const [, war] of store.getAllWars()) {
    if (war.factionId === factionId) {
      result.push({
        warId: war.warId,
        enemyFactionId: war.enemyFactionId,
        calls: war.calls,
        rallies: war.rallies,
        enemyStatuses: war.enemyStatuses,
        chainData: war.chainData,
      });
    }
  }

  return res.json({ wars: result });
});

// ── GET /api/faction/:factionId/chain ───────────────────────────────────

router.get("/api/faction/:factionId/chain", requireAuth, async (req, res) => {
  const { factionId } = req.params;

  // We need an API key for this faction
  const apiKey = store.getApiKeyForFaction(factionId);
  if (!apiKey) {
    return res.status(503).json({ error: "No API key available for this faction" });
  }

  try {
    // Fetch chain data for the enemy faction referenced in any active war
    // For simplicity, find the first war for this faction
    let enemyFactionId = null;
    for (const [, war] of store.getAllWars()) {
      if (war.factionId === factionId && war.enemyFactionId) {
        enemyFactionId = war.enemyFactionId;
        break;
      }
    }

    if (!enemyFactionId) {
      return res.json({ chain: { current: 0, max: 0, timeout: 0, cooldown: 0 } });
    }

    const chain = await fetchFactionChain(enemyFactionId, apiKey);
    return res.json({ chain });
  } catch (err) {
    console.error("[chain] Failed to fetch chain data:", err.message);
    return res.status(502).json({ error: "Failed to fetch chain data from Torn API" });
  }
});

export default router;
