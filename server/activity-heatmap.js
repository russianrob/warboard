/**
 * Activity heatmap – server-side data collection.
 *
 * Records how many faction members are online at each hour/day-of-week.
 * Data persists to data/heatmap-<factionId>.json and is served to clients
 * so the heatmap works without the userscript being open.
 */

import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "./data";

/** @type {Map<string, object>} factionId → heatmap data */
const heatmaps = new Map();

/** Track which heatmaps have unsaved changes. */
const dirty = new Set();

/** Periodic flush interval handle. */
let flushInterval = null;

// ── Helpers ──────────────────────────────────────────────────────────────

function heatmapPath(factionId) {
  return path.join(DATA_DIR, `heatmap-${factionId}.json`);
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Record a single activity sample for a faction.
 * @param {string} factionId
 * @param {number} onlineCount – number of members currently online/idle
 */
export function recordSample(factionId, activeCount, totalMembers = 0) {
  if (!factionId || typeof activeCount !== "number") return;

  let map = heatmaps.get(factionId);
  if (!map) {
    map = {};
    heatmaps.set(factionId, map);
  }

  const now = new Date();
  // Day of week: 0=Mon .. 6=Sun (JS getUTCDay: 0=Sun, so shift)
  const jsDay = now.getUTCDay(); // 0=Sun
  const day = jsDay === 0 ? 6 : jsDay - 1; // 0=Mon..6=Sun
  const hour = now.getUTCHours();

  const dayKey = String(day);
  const hourKey = String(hour);

  if (!map[dayKey]) map[dayKey] = {};
  if (!map[dayKey][hourKey]) map[dayKey][hourKey] = { total: 0, samples: 0, membersTotal: 0 };

  const bucket = map[dayKey][hourKey];
  if (bucket.samples < 5000) {
    bucket.total += activeCount;
    bucket.membersTotal = (bucket.membersTotal || 0) + totalMembers;
    bucket.samples += 1;
  }

  dirty.add(factionId);
}

/**
 * Get the heatmap data for a faction.
 * @param {string} factionId
 * @returns {object} The heatmap object, or empty object if none.
 */
export function getHeatmap(factionId) {
  return heatmaps.get(factionId) || {};
}

/**
 * Reset (delete) the heatmap data for a faction.
 * @param {string} factionId
 */
export function resetHeatmap(factionId) {
  heatmaps.delete(factionId);
  dirty.delete(factionId);

  const filePath = heatmapPath(factionId);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.error(`[heatmap] Failed to delete ${filePath}:`, err.message);
  }
  console.log(`[heatmap] Reset heatmap for faction ${factionId}`);
}

/**
 * Save a single faction's heatmap to disk.
 * @param {string} factionId
 */
export function saveHeatmap(factionId) {
  ensureDataDir();
  const map = heatmaps.get(factionId);
  if (!map) return;

  try {
    fs.writeFileSync(heatmapPath(factionId), JSON.stringify(map));
    dirty.delete(factionId);
  } catch (err) {
    console.error(`[heatmap] Failed to save heatmap for faction ${factionId}:`, err.message);
  }
}

/**
 * Flush all dirty heatmaps to disk. Called periodically.
 */
export function flushDirty() {
  for (const factionId of dirty) {
    saveHeatmap(factionId);
  }
}

/**
 * Load all persisted heatmaps from disk (called once at startup).
 */
export function loadHeatmaps() {
  ensureDataDir();

  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith("heatmap-") && f.endsWith(".json"));
    for (const file of files) {
      const factionId = file.replace("heatmap-", "").replace(".json", "");
      try {
        const raw = fs.readFileSync(path.join(DATA_DIR, file), "utf-8");
        heatmaps.set(factionId, JSON.parse(raw));
      } catch (err) {
        console.error(`[heatmap] Failed to load ${file}:`, err.message);
      }
    }
    console.log(`[heatmap] Loaded ${heatmaps.size} heatmap(s) from disk`);
  } catch (err) {
    console.error("[heatmap] Failed to scan data dir:", err.message);
  }

  // Start periodic flush every 10 minutes
  if (!flushInterval) {
    flushInterval = setInterval(flushDirty, 10 * 60 * 1000);
  }
}

/**
 * Stop the periodic flush (for graceful shutdown).
 */
export function stopFlush() {
  if (flushInterval) {
    clearInterval(flushInterval);
    flushInterval = null;
  }
  flushDirty(); // one final flush
}
