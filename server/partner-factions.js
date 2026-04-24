// Persisted partner factions — free-access allowlist managed via the
// admin UI. Replaces the hard-coded PARTNER_FACTIONS array in routes.js.
//
// Schema: { [factionId]: { factionId, factionName, note, addedAt } }

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname as pathDirname, join as pathJoin } from "node:path";

const FILE = pathJoin(process.env.DATA_DIR || './data', 'partner-factions.json');
let _state = {};

function _load() {
  try {
    if (!existsSync(FILE)) {
      // Seed with the historical hard-coded partner so the migration
      // is lossless. Remove via the UI if no longer wanted.
      _state = {
        "51430": { factionId: "51430", factionName: "", note: "seeded from hard-coded PARTNER_FACTIONS", addedAt: Date.now() },
      };
      _save();
      return;
    }
    const raw = readFileSync(FILE, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') _state = obj;
    console.log(`[partners] loaded ${Object.keys(_state).length} partner faction(s) from disk`);
  } catch (e) {
    console.warn('[partners] load failed:', e.message);
    _state = {};
  }
}
_load();

function _save() {
  try {
    const dir = pathDirname(FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(FILE, JSON.stringify(_state, null, 2), 'utf8');
  } catch (e) {
    console.warn('[partners] save failed:', e.message);
  }
}

export function listPartnerFactions() {
  return Object.values(_state).sort((a, b) => a.factionId.localeCompare(b.factionId));
}

export function isPartnerFaction(factionId) {
  const p = _state[String(factionId)];
  if (!p) return false;
  if (p.expiresAt && Date.now() > p.expiresAt) return false;
  return true;
}

export function addPartnerFaction(factionId, factionName = '', note = '', opts = {}) {
  const fid = String(factionId);
  if (!/^\d+$/.test(fid)) throw new Error('Invalid faction ID');
  const existing = _state[fid];
  // Preserve existing expiry unless caller explicitly passes durationWeeks.
  // durationWeeks === 0 or '' or null => permanent (clears expiry).
  let expiresAt = existing?.expiresAt ?? null;
  if (Object.prototype.hasOwnProperty.call(opts, 'durationWeeks')) {
    const w = Number(opts.durationWeeks);
    if (Number.isFinite(w) && w > 0) {
      expiresAt = Date.now() + Math.round(w * 7 * 24 * 60 * 60 * 1000);
    } else {
      expiresAt = null;
    }
  }
  _state[fid] = {
    factionId: fid,
    factionName: String(factionName || '').slice(0, 64),
    note: String(note || '').slice(0, 200),
    addedAt: existing?.addedAt || Date.now(),
    updatedAt: Date.now(),
    expiresAt,
  };
  _save();
  return _state[fid];
}

export function removePartnerFaction(factionId) {
  const fid = String(factionId);
  if (!_state[fid]) return false;
  delete _state[fid];
  _save();
  return true;
}
