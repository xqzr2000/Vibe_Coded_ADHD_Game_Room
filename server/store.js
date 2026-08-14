// File-backed storage, OpenClaw-workspace style: plain JSON on disk so the
// data survives restarts and is human-readable/editable.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
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
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

// ---------- Games library ----------

export function getGames() {
  return readJson(GAMES_FILE, []);
}

export function saveGames(newGames) {
  const existing = getGames();
  const byName = new Map(existing.map((g) => [g.name.toLowerCase(), g]));
  let added = 0;
  for (const game of newGames) {
    if (!game?.name) continue;
    const key = game.name.toLowerCase();
    if (byName.has(key)) {
      // Merge: keep existing, fill in any new fields.
      byName.set(key, { ...game, ...byName.get(key) });
    } else {
      byName.set(key, { ...game, savedAt: new Date().toISOString() });
      added += 1;
    }
  }
  const merged = [...byName.values()];
  writeJson(GAMES_FILE, merged);
  return { games: merged, added };
}

// ---------- Long-term memory ----------

export function getMemories() {
  return readJson(MEMORY_FILE, []);
}

export function saveMemory(memory) {
  const memories = getMemories();
  memories.push({ id: `mem_${Date.now()}`, createdAt: new Date().toISOString(), ...memory });
  writeJson(MEMORY_FILE, memories);
  return memories;
}
