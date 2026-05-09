// Persisted partner factions — free-access allowlist managed via the
// admin UI. Replaces the hard-coded PARTNER_FACTIONS array in routes.js.
//
// Schema: { [factionId]: { factionId, factionName, note, addedAt, services } }
//   services: array of "oc-spawn" | "factionops". Missing => ["oc-spawn"]
//   so legacy entries (added before per-service grants) keep working.

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

/** Canonical service identifiers. Anything outside this set is dropped
 *  on persist so a typo can't accidentally grant access to nothing. */
export const VALID_SERVICES = ['oc-spawn', 'factionops'];

function _normalizeServices(input) {
  if (input == null) return null;
  const arr = Array.isArray(input) ? input : String(input).split(',');
  const out = [];
  for (const raw of arr) {
    const v = String(raw || '').trim().toLowerCase();
    if (VALID_SERVICES.includes(v) && !out.includes(v)) out.push(v);
  }
  return out.length > 0 ? out : null;
}

/** Services a partner is granted. Empty list (or missing field) defaults
 *  to ["oc-spawn"] so legacy entries keep working without migration. */
function _servicesFor(p) {
  if (!p) return [];
  if (Array.isArray(p.services) && p.services.length > 0) return p.services;
  return ['oc-spawn'];
}

export function listPartnerFactions() {
  return Object.values(_state)
    .map(p => ({ ...p, services: _servicesFor(p) }))
    .sort((a, b) => a.factionId.localeCompare(b.factionId));
}

/** Backwards-compat: was a binary "is this a partner at all". Existing
 *  callers (all OC Spawn auth gates) keep working — every partner gets
 *  oc-spawn by default. New callers should prefer isPartnerFor(). */
export function isPartnerFaction(factionId) {
  return isPartnerFor(factionId, 'oc-spawn');
}

/** Per-service partner check. Use this to gate FactionOps separately
 *  from OC Spawn. Returns false on expired entries even if the service
 *  is granted. */
export function isPartnerFor(factionId, service) {
  const p = _state[String(factionId)];
  if (!p) return false;
  if (p.expiresAt && Date.now() > p.expiresAt) return false;
  const svc = String(service || '').toLowerCase();
  return _servicesFor(p).includes(svc);
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
  // Services: explicit override wins; missing => preserve existing
  // (or default ["oc-spawn"] for brand-new partners). Caller can pass
  // an empty array to clear, but we coerce that back to oc-spawn so
  // a partner is never "granted nothing" by accident.
  let services = _servicesFor(existing);
  if (Object.prototype.hasOwnProperty.call(opts, 'services')) {
    const normalized = _normalizeServices(opts.services);
    if (normalized) services = normalized;
  }
  _state[fid] = {
    factionId: fid,
    factionName: String(factionName || '').slice(0, 64),
    note: String(note || '').slice(0, 200),
    addedAt: existing?.addedAt || Date.now(),
    updatedAt: Date.now(),
    expiresAt,
    services,
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
