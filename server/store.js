// File-backed storage: plain JSON on disk so the data survives restarts and is
// human-readable/editable. Single-user by design — there are no accounts, so
// data/memories.json belongs to whoever runs this copy of Focus Room.
// Set LOCAL_MEMORY=0 to keep nothing between sessions.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.FOCUS_ROOM_DATA_DIR || path.join(__dirname, "..", "data");
const GAMES_FILE = path.join(DATA_DIR, "games.json");
const MEMORY_FILE = path.join(DATA_DIR, "memories.json");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file); // atomic: a crash mid-write can't leave half a file
}

export const memoryEnabled = () => process.env.LOCAL_MEMORY !== "0";

// ---------- Games library ----------

export function getGames() {
  const games = readJson(GAMES_FILE, []);
  return Array.isArray(games) ? games : [];
}

const MERGEABLE = ["audience", "access", "platform", "pricing", "description", "evidence", "url"];

// Models sometimes copy the schema's example text into a field ("current price
// if known") or describe a fetch failure as if it were a fact ("the page is a
// parked domain"). Neither belongs in a shared library.
const PLACEHOLDER = /^(current price if known|official page if found|e\.g\.|1-2 sentences|1 sentence on|unknown|n\/a|none|tbd|\?)/i;
const PAGE_NOISE = /\b(parked domain|page (was|is) (unavailable|empty|blank)|could not (load|access|fetch)|no information about)\b/i;

export function cleanField(field, value) {
  const v = String(value ?? "").trim();
  if (!v || PLACEHOLDER.test(v) || PAGE_NOISE.test(v)) return "";
  if (field === "url" && !/^https?:\/\/[^\s]+\.[^\s]+/i.test(v)) return "";
  return v;
}

export function saveGames(newGames) {
  const existing = getGames();
  const byName = new Map(existing.map((g) => [String(g.name).toLowerCase(), g]));
  let added = 0;
  const updatedFields = [];

  for (const raw of newGames || []) {
    const name = String(raw?.name || "").trim();
    if (!name || PLACEHOLDER.test(name)) continue;
    const game = { name };
    for (const field of MERGEABLE) {
      const v = cleanField(field, raw[field]);
      if (v) game[field] = v;
    }
    const key = name.toLowerCase();
    const current = byName.get(key);

    if (!current) {
      byName.set(key, { ...game, savedAt: new Date().toISOString() });
      added += 1;
      continue;
    }

    const next = { ...current };
    let changed = false;
    for (const field of MERGEABLE) {
      const incoming = game[field] || "";
      const held = String(current[field] ?? "").trim();
      if (!incoming || incoming === held) continue;
      // Don't let a vaguer answer overwrite a specific one we already have —
      // but a held value that is itself junk is always replaceable.
      if (cleanField(field, held) && incoming.length < held.length / 2) continue;
      next[field] = incoming;
      changed = true;
      updatedFields.push(`${current.name}: ${field}`);
    }
    if (changed) next.updatedAt = new Date().toISOString();
    byName.set(key, next);
  }

  const merged = [...byName.values()];
  writeJson(GAMES_FILE, merged);
  return { games: merged, added, updated: updatedFields.length, updatedFields };
}

// ---------- Long-term memory ----------

export function getMemories() {
  if (!memoryEnabled()) return [];
  const memories = readJson(MEMORY_FILE, []);
  return Array.isArray(memories) ? memories : [];
}

export function saveMemory(memory) {
  if (!memoryEnabled()) return null;
  const memories = getMemories();
  memories.push({ id: `mem_${Date.now()}`, createdAt: new Date().toISOString(), ...memory });
  writeJson(MEMORY_FILE, memories);
  return memories;
}
