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

const MERGEABLE = ["audience", "access", "platform", "pricing", "description", "evidence", "url"];

export function saveGames(newGames) {
  const existing = getGames();
  const byName = new Map(existing.map((g) => [g.name.toLowerCase(), g]));
  let added = 0;
  const updatedFields = []; // e.g. "EndeavorOTC: pricing"

  for (const game of newGames) {
    if (!game?.name) continue;
    const key = game.name.toLowerCase();
    const current = byName.get(key);

    if (!current) {
      byName.set(key, { ...game, savedAt: new Date().toISOString() });
      added += 1;
      continue;
    }

    // Fill in blanks and take genuinely different values from the new record.
    // (The old merge let the existing entry win every field, which silently
    //  threw away everything the fetch/enrich step learned — so a known game
    //  could never gain a price, and every run reported "nothing new".)
    const next = { ...current };
    let changed = false;
    for (const field of MERGEABLE) {
      const incoming = String(game[field] ?? "").trim();
      const held = String(current[field] ?? "").trim();
      if (!incoming || incoming === held) continue;
      // Don't let a vaguer answer overwrite a specific one we already have.
      if (held && incoming.length < held.length / 2) continue;
      next[field] = game[field];
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
  return readJson(MEMORY_FILE, []);
}

export function saveMemory(memory) {
  const memories = getMemories();
  memories.push({ id: `mem_${Date.now()}`, createdAt: new Date().toISOString(), ...memory });
  writeJson(MEMORY_FILE, memories);
  return memories;
}
