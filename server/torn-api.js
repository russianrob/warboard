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

  const statuses = {};
  if (data.members) {
    for (const [memberId, member] of Object.entries(data.members)) {
      statuses[memberId] = {
        name: member.name,
        level: member.level,
        status: member.status?.description ?? "Unknown",
        until: member.status?.until ?? 0,
        lastAction: member.last_action?.relative ?? "Unknown",
        online: member.last_action?.status ?? "Offline",
      };
    }
  }

  return statuses;
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
