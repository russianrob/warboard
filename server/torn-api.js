/**
 * Torn API helper functions for server-side calls.
 */

/**
 * Fetch faction member statuses from the Torn API.
 * Returns a map of memberId → { status, until, lastAction, online, level, name }.
 */
export async function fetchFactionMembers(factionId, apiKey) {
  const url = `https://api.torn.com/faction/${encodeURIComponent(factionId)}?selections=basic&key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Torn API returned HTTP ${res.status}`);
  }

  const data = await res.json();

  if (data.error) {
    throw new Error(`Torn API error: ${data.error.error} (code ${data.error.code})`);
  }

  // Use Torn's response timestamp to compensate for API cache age.
  // data.timestamp is when Torn generated the response — may be up to 29s
  // stale. Using wallclock (Date.now) as the reference subtracts the
  // cache age automatically, giving the client an already-adjusted value.
  const now = Math.floor(Date.now() / 1000);
  const statuses = {};
  if (data.members) {
    for (const [memberId, member] of Object.entries(data.members)) {
      // Torn API returns `until` as a Unix timestamp; convert to seconds remaining
      // Using wallclock (not data.timestamp) so cache age is already subtracted
      const untilTs = member.status?.until ?? 0;
      const untilRemaining = untilTs > 0 ? Math.max(0, untilTs - now) : 0;
      statuses[memberId] = {
        name: member.name,
        level: member.level,
        status: (member.status?.state ?? "Okay").toLowerCase(),
        description: member.status?.description ?? "",
        until: untilRemaining,
        lastAction: member.last_action?.relative ?? "Unknown",
        activity: (member.last_action?.status ?? "Offline").toLowerCase(),
      };
    }
  }

  return statuses;
}

/**
 * Fetch full faction basic data from the Torn API.
 * Returns the complete basic response including faction-level fields
 * (name, age, best_chain, respect, members) and per-member data.
 */
export async function fetchFactionBasic(factionId, apiKey) {
  const url = `https://api.torn.com/faction/${encodeURIComponent(factionId)}?selections=basic&key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Torn API returned HTTP ${res.status}`);
  }

  const data = await res.json();

  if (data.error) {
    throw new Error(`Torn API error: ${data.error.error} (code ${data.error.code})`);
  }

  return data;
}

/**
 * Fetch faction chain data from the Torn API.
 * Returns { current, max, timeout, cooldown }.
 */
export async function fetchFactionChain(factionId, apiKey) {
  const url = `https://api.torn.com/faction/${encodeURIComponent(factionId)}?selections=chain&key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Torn API returned HTTP ${res.status}`);
  }

  const data = await res.json();

  if (data.error) {
    throw new Error(`Torn API error: ${data.error.error} (code ${data.error.code})`);
  }

  const chain = data.chain ?? {};
  return {
    current: chain.current ?? 0,
    max: chain.max ?? 0,
    timeout: chain.timeout ?? 0,
    cooldown: chain.cooldown ?? 0,
    timestamp: data.timestamp ?? 0,
  };
}

/**
 * Fetch current ranked war data for a faction.
 * Returns { warId, enemyFactionId, enemyFactionName, myScore, enemyScore } or null if no active ranked war.
 *
 * Torn API v1: GET /faction/<factionId>?selections=rankedwars&key=KEY
 */
export async function fetchRankedWar(factionId, apiKey) {
  const url = `https://api.torn.com/faction/${encodeURIComponent(factionId)}?selections=rankedwars&key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Torn API returned HTTP ${res.status}`);
  }

  const data = await res.json();

  if (data.error) {
    throw new Error(`Torn API error: ${data.error.error} (code ${data.error.code})`);
  }

  // rankedwars is an object keyed by war ID
  if (!data.rankedwars || typeof data.rankedwars !== 'object') {
    return null; // no active ranked war
  }

  // Find the active war (winner === 0 means ongoing)
  for (const [warId, warData] of Object.entries(data.rankedwars)) {
    const factions = warData.factions;
    if (!factions || typeof factions !== 'object') continue;

    const factionIds = Object.keys(factions);
    if (factionIds.length !== 2) continue;

    // Check if war is still active (winner is 0 or undefined)
    if (warData.war && warData.war.winner && warData.war.winner !== 0) continue;

    // Find the enemy faction (the one that isn't us)
    const myFid = String(factionId);
    const enemyFid = factionIds.find(fid => String(fid) !== myFid);
    if (!enemyFid) continue;

    return {
      warId: String(warId),
      enemyFactionId: enemyFid,
      enemyFactionName: factions[enemyFid]?.name || null,
      myScore: factions[myFid]?.score || 0,
      enemyScore: factions[enemyFid]?.score || 0,
    };
  }

  return null; // no active ranked war found
}

/**
 * Fetch the ranked war report for a faction's most recent ranked war.
 * Returns the raw rankedwarreport data from the Torn API.
 */
export async function fetchRankedWarReport(factionId, apiKey, warId) {
  // v2 endpoint: /v2/faction/rankedwarreport?id=WAR_ID
  // If no warId provided, fetch rankedwars first to find the last completed war
  let rwId = warId;
  if (!rwId) {
    const rwUrl = `https://api.torn.com/faction/${encodeURIComponent(factionId)}?selections=rankedwars&key=${encodeURIComponent(apiKey)}`;
    const rwRes = await fetch(rwUrl);
    if (rwRes.ok) {
      const rwData = await rwRes.json();
      if (rwData.rankedwars) {
        // Find the most recent completed war (winner !== 0)
        let latest = null;
        for (const [id, w] of Object.entries(rwData.rankedwars)) {
          if (w.war && w.war.winner && w.war.winner !== 0) {
            if (!latest || Number(id) > Number(latest)) latest = id;
          }
        }
        // If no completed war, try the most recent active one
        if (!latest) {
          for (const id of Object.keys(rwData.rankedwars)) {
            if (!latest || Number(id) > Number(latest)) latest = id;
          }
        }
        rwId = latest;
      }
    }
  }
  if (!rwId) throw new Error("No ranked war found");
  const url = `https://api.torn.com/v2/faction/rankedwarreport?id=${encodeURIComponent(rwId)}&key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Torn API returned HTTP ${res.status}`);
  }

  const data = await res.json();

  if (data.error) {
    throw new Error(`Torn API error: ${data.error.error} (code ${data.error.code})`);
  }

  return data.rankedwarreport || data;
}

/**
 * Fetch a player's energy, nerve bars and cooldowns.
 * Returns { energy: { current, maximum, fulltime }, nerve: { current, maximum, fulltime }, cooldowns: { drug, medical, booster } }.
 */
export async function fetchUserBars(apiKey) {
  const url = `https://api.torn.com/user/?selections=bars,cooldowns&key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Torn API returned HTTP ${res.status}`);
  }

  const data = await res.json();

  if (data.error) {
    throw new Error(`Torn API error: ${data.error.error} (code ${data.error.code})`);
  }

  return {
    energy: {
      current: data.energy?.current ?? 0,
      maximum: data.energy?.maximum ?? 0,
      fulltime: data.energy?.fulltime ?? 0,
    },
    nerve: {
      current: data.nerve?.current ?? 0,
      maximum: data.nerve?.maximum ?? 0,
      fulltime: data.nerve?.fulltime ?? 0,
    },
    cooldowns: {
      drug: data.cooldowns?.drug ?? 0,
      medical: data.cooldowns?.medical ?? 0,
      booster: data.cooldowns?.booster ?? 0,
    },
  };
}
