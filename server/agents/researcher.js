// Scout — the background researcher.
//
// Standard pipeline (default):
//   1. cheap decision call — "is there anything worth researching right now?"
//   2. web search via OpenRouter :online → draft game entries (JSON)
//   3. FETCH STEP: pull the official pages it found and run an enrich pass
//      so entries carry real details (pricing, platforms, requirements)
//   4. dedupe + save to data/games.json
//
// Deep pipeline (opt-in via the "Deep search" checkbox):
//   1. hand the task to the browser-use sidecar (a real headless browser
//      that navigates, clicks, and reads rendered pages)
//   2. structure its findings into the same JSON shape and save
//   Falls back to the standard pipeline if the sidecar isn't running.
//
// Scout also summarizes sessions into long-term memory (data/memories.json)
// that Dr. Maple reads on every turn.

import { chat, parseJson } from "../openrouter.js";
import { fetchPages } from "../fetcher.js";
import { getGames, saveGames, saveMemory } from "../store.js";

export const researcherAgent = {
  id: "researcher",
  name: "Scout",
  role: "Researcher",
  color: "#a4551e",
};

const MODEL = () => process.env.RESEARCHER_MODEL || "openai/gpt-4o-mini";
const SIDECAR = () => process.env.BROWSER_SERVICE_URL || "http://127.0.0.1:8010";

const GAME_SCHEMA = `{
  "games": [
    {
      "name": "",
      "audience": "e.g. children 8-17 / adults 18+",
      "access": "prescription-only | over-the-counter | free | subscription",
      "platform": "iOS / Android / web ...",
      "pricing": "current price if known, e.g. $24.99/mo (optional)",
      "description": "1-2 sentences, plain language",
      "evidence": "1 sentence on evidence or regulatory status (e.g. FDA authorization)",
      "url": "official page if found"
    }
  ],
  "note": "1-2 sentence message to post in the chat about what you found"
}`;

function transcript(history) {
  return history
    .map((m) => `${m.from === "user" ? "User" : m.agentName || "Agent"}: ${m.text}`)
    .join("\n");
}

// --- Decision call (no web search) ------------------------------------------

export async function shouldResearch(history) {
  const known = getGames().map((g) => g.name);
  const raw = await chat({
    model: MODEL(),
    json: true,
    temperature: 0,
    maxTokens: 300,
    messages: [
      {
        role: "system",
        content: `You decide whether a background web search would help right now. The topic is EndeavorRx / EndeavorOTC and other evidence-based attention-training games for ADHD.

Search when the conversation has revealed something searchable (the user's age group, platform, a question about availability/pricing/evidence) that the local library doesn't already cover.
Do NOT search on small talk, or if the library already covers what's needed, or if you searched for essentially the same thing already.

Local library already contains: ${known.join(", ") || "(empty)"}

Respond with only a JSON object: {"search": true|false, "query": "<web search focus, if true>", "reason": "<one short sentence>"}`,
      },
      { role: "user", content: transcript(history.slice(-12)) },
    ],
  });
  try {
    return parseJson(raw);
  } catch {
    return { search: false };
  }
}

// --- Research entry point ----------------------------------------------------

export async function research(query, { deep = false } = {}) {
  if (deep) {
    try {
      return await deepResearch(query);
    } catch (err) {
      const fallback = await standardResearch(query);
      fallback.note = `Deep search unavailable (${trim(err.message, 90)}) — used standard search instead. ${fallback.note || ""}`.trim();
      return fallback;
    }
  }
  return standardResearch(query);
}

// --- Standard pipeline: :online search, then fetch + enrich ------------------

async function standardResearch(query) {
  // 1) Search
  const raw = await chat({
    model: MODEL(),
    online: true, // OpenRouter web-search plugin
    temperature: 0.2,
    maxTokens: 1600,
    messages: [
      {
        role: "system",
        content: `You are Scout, a careful research agent. Use the web results provided to you. Focus on EndeavorRx, EndeavorOTC, and other legitimate, evidence-based digital therapeutics or attention-training games relevant to ADHD.

Return ONLY a JSON object in this exact shape:
${GAME_SCHEMA}

Rules: only include real products you found evidence for; never invent URLs or prices; note clearly when something requires a prescription.`,
      },
      { role: "user", content: `Research task: ${query}` },
    ],
  });

  const parsed = parseJson(raw);
  let games = Array.isArray(parsed.games) ? parsed.games : [];
  let note = parsed.note || "";

  // 2) Fetch step (default): read the official pages and enrich the drafts.
  const pages = await fetchPages(games.map((g) => g.url)).catch(() => []);
  if (pages.length && games.length) {
    try {
      const enriched = await enrich(query, games, pages);
      if (enriched.games?.length) games = enriched.games;
      if (enriched.note) note = enriched.note;
    } catch {
      // Enrichment is best-effort; keep the draft entries.
    }
  }

  const { games: library, added } = saveGames(games);
  return { games, library, added, note, mode: "standard" };
}

async function enrich(query, draftGames, pages) {
  const pageBlocks = pages
    .map((p) => `--- PAGE: ${p.url} ---\n${p.text}`)
    .join("\n\n");

  const raw = await chat({
    model: MODEL(),
    json: true,
    temperature: 0.1,
    maxTokens: 1600,
    messages: [
      {
        role: "system",
        content: `You verify and enrich draft game entries using text extracted from their official pages. Correct anything the pages contradict, and fill in concrete details the pages confirm (pricing, platforms, age ranges, prescription requirements). If a page doesn't confirm a detail, leave the field as it was — never invent.

Return ONLY a JSON object in this exact shape:
${GAME_SCHEMA}`,
      },
      {
        role: "user",
        content: `Research task: ${query}\n\nDraft entries:\n${JSON.stringify(draftGames, null, 2)}\n\nExtracted page text:\n${pageBlocks}`,
      },
    ],
  });
  return parseJson(raw);
}

// --- Deep pipeline: browser-use sidecar --------------------------------------

async function deepResearch(query) {
  const instruction = `Research this for someone exploring ADHD attention-training games: "${query}".
Visit official sources (e.g. endeavorrx.com, endeavorotc.com, app stores, FDA pages) as relevant. Collect for each product: name, intended audience/ages, whether a prescription is required, platforms, CURRENT pricing if shown, a plain-language description, and evidence/regulatory status. Finish by writing out everything you found as plain text.`;

  const res = await fetch(`${SIDECAR()}/task`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instruction }),
    signal: AbortSignal.timeout(Number(process.env.BROWSER_TIMEOUT_MS || 240000)),
  });
  if (!res.ok) throw new Error(`sidecar HTTP ${res.status}`);
  const { result } = await res.json();
  if (!result) throw new Error("sidecar returned no result");

  // Structure the browser findings into the shared schema.
  const raw = await chat({
    model: MODEL(),
    json: true,
    temperature: 0.1,
    maxTokens: 1600,
    messages: [
      {
        role: "system",
        content: `Convert these browser-research findings into structured game entries. Only include what the findings support; never invent URLs or prices.

Return ONLY a JSON object in this exact shape:
${GAME_SCHEMA}`,
      },
      { role: "user", content: `Research task: ${query}\n\nBrowser findings:\n${result}` },
    ],
  });

  const parsed = parseJson(raw);
  const games = Array.isArray(parsed.games) ? parsed.games : [];
  const { games: library, added } = saveGames(games);
  return {
    games,
    library,
    added,
    note: parsed.note ? `🔎 (deep) ${parsed.note}` : "🔎 Deep search complete.",
    mode: "deep",
  };
}

// --- Session summaries → long-term memory ------------------------------------

export async function summarizeSession(history) {
  if (!history.some((m) => m.from === "user")) return null;

  const raw = await chat({
    model: MODEL(),
    json: true,
    temperature: 0.2,
    maxTokens: 700,
    messages: [
      {
        role: "system",
        content: `Summarize this Focus Room session into long-term memory for future sessions. Be factual and concise; note only what the user actually said. Respond with ONLY a JSON object:
{
  "summary": "3-5 sentence recap of what the user shared and what was discussed",
  "keyPoints": ["short bullet", "..."],
  "gamesDiscussed": ["names only"],
  "followUps": ["what to pick up next session"]
}`,
      },
      { role: "user", content: transcript(history) },
    ],
  });

  const parsed = parseJson(raw);
  return saveMemory(parsed);
}

// --- Professional session statement (for PDF export) -------------------------

export async function professionalStatement(history) {
  if (!history.some((m) => m.from === "user")) return null;

  const known = getGames()
    .map((g) => `${g.name} (${g.audience || "?"}, ${g.access || "?"})`)
    .join("; ");

  const raw = await chat({
    model: MODEL(),
    json: true,
    temperature: 0.2,
    maxTokens: 1600,
    messages: [
      {
        role: "system",
        content: `You are Scout, writing a clean, professional statement summarizing a Focus Room session so the user can bring it to a real clinician.

Register: neutral, factual, third-person clinical-adjacent prose ("The user reported…"). No humor, no second-person address, no diagnostic language. Never state or imply that the user has ADHD or any condition — describe only what was reported and discussed. Only include what the user actually said; if a section has nothing, return an empty array or omit it.

Games in the shared library: ${known || "(none)"}

Respond with ONLY a JSON object:
{
  "purpose": "2-3 sentences on what this document is and is not",
  "summary": "1-2 paragraphs summarizing the conversation factually",
  "reportedExperiences": ["specific things the user described, in neutral language"],
  "areasDiscussed": ["screening themes covered, e.g. sustained attention, time management"],
  "resourcesReviewed": ["games/resources discussed, with access requirements noted"],
  "nextSteps": ["concrete, non-prescriptive suggestions, including professional evaluation"],
  "questionsForClinician": ["questions the user might usefully ask a clinician"]
}`,
      },
      { role: "user", content: transcript(history) },
    ],
  });

  const parsed = parseJson(raw);
  return { ...parsed, generatedAt: new Date().toISOString() };
}

function trim(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}
