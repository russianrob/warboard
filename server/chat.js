/**
 * Persistent war-chat store. Per-war message buffers, faction-scoped
 * by virtue of warId already mapping to one faction's room.
 *
 * Buffers are written to data/war-chat.json (debounced 2s) and
 * hydrated synchronously on module load — messages survive both
 * server restarts AND war boundaries (clearForWar is no longer
 * called from chain-monitor; per-war history accumulates indefinitely
 * unless an admin manually wipes it).
 *
 * No size cap: factions explicitly asked for full history. JSON file
 * stays small in practice (~500 bytes/message); a busy faction with
 * 1k messages/year totals well under 1 MB. If that ever becomes
 * unwieldy, switch to per-war files instead of a single blob.
 */

import { readFileSync, existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join as pathJoin, dirname } from 'node:path';

const DATA_DIR  = process.env.DATA_DIR || './data';
const CHAT_FILE = pathJoin(DATA_DIR, 'war-chat.json');

/** @type {Map<string, Array<{id: string, ts: number, playerId: string, playerName: string, factionPosition: string, text: string}>>} */
const buffers = new Map();

// Hydrate synchronously at module load — file is small enough that
// the brief block is fine, and it guarantees getHistory works the
// instant any caller imports this module.
try {
  if (existsSync(CHAT_FILE)) {
    const raw = readFileSync(CHAT_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    let msgCount = 0;
    for (const [wid, buf] of Object.entries(parsed)) {
      if (Array.isArray(buf)) {
        buffers.set(wid, buf);
        msgCount += buf.length;
      }
    }
    console.log(`[chat] hydrated ${buffers.size} war buffer(s), ${msgCount} message(s) from ${CHAT_FILE}`);
  }
} catch (e) {
  console.warn('[chat] hydrate failed:', e.message);
}

let writeTimer = null;
function persist() {
  if (writeTimer) clearTimeout(writeTimer);
  // 2 s debounce — coalesces bursts of messages into a single write
  // while keeping the at-risk window (messages added but not yet
  // flushed) bounded if the process crashes.
  writeTimer = setTimeout(async () => {
    writeTimer = null;
    try {
      await mkdir(dirname(CHAT_FILE), { recursive: true });
      const out = {};
      for (const [wid, buf] of buffers) out[wid] = buf;
      await writeFile(CHAT_FILE, JSON.stringify(out));
    } catch (e) {
      console.warn('[chat] persist failed:', e.message);
    }
  }, 2_000);
}

/** Tiny non-cryptographic id — collision odds inside a per-war buffer
 *  are negligible even with thousands of messages. */
function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function getHistory(warId, limit) {
  const buf = buffers.get(String(warId)) || [];
  // Default = return everything. Callers that want a tail-window
  // pass an explicit limit (e.g. ?limit=200 for a "last hour" view).
  if (limit === undefined || limit === null || limit <= 0) return buf.slice();
  return buf.slice(-limit);
}

export function addMessage(warId, { playerId, playerName, factionPosition, text }) {
  const wid = String(warId);
  const trimmed = String(text || "").trim().slice(0, 500);
  if (!trimmed) return null;
  const msg = {
    id: newId(),
    ts: Date.now(),
    playerId: String(playerId),
    playerName: String(playerName || "?"),
    factionPosition: String(factionPosition || ""),
    text: trimmed,
  };
  let buf = buffers.get(wid);
  if (!buf) { buf = []; buffers.set(wid, buf); }
  buf.push(msg);
  persist();
  return msg;
}

export function deleteMessage(warId, msgId) {
  const wid = String(warId);
  const buf = buffers.get(wid);
  if (!buf) return false;
  const idx = buf.findIndex(m => m.id === msgId);
  if (idx === -1) return false;
  buf.splice(idx, 1);
  persist();
  return true;
}

/** Manual admin wipe — no longer auto-called when a war ends.
 *  Kept for the diagnostic / "I want a clean slate" path. */
export function clearForWar(warId) {
  const wid = String(warId);
  const had = buffers.has(wid);
  buffers.delete(wid);
  if (had) persist();
  return had;
}

/** Diagnostic — dump all current buffer sizes (used by /api/debug). */
export function snapshot() {
  const out = {};
  for (const [wid, buf] of buffers) out[wid] = buf.length;
  return out;
}
