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
  };
}
