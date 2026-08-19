// Scout — the background researcher.
//
// Standard pipeline (default):
//   1. cheap decision call — "is there anything worth researching right now?"
//   2. web search via OpenRouter server tool → draft game entries (JSON)
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

import { parseJson } from "../llm.js";
import { agentCall } from "../config.js";
import { agentChat, fallbackSequence, isConstrainedFree } from "../fallback.js";
import { getProvider } from "../providers.js";
import { fetchPages } from "../fetcher.js";
import { getGames, saveGames, saveMemory } from "../store.js";
import { getTask, classifyTask, formatResult } from "./scout-tasks.js";

export const researcherAgent = {
  id: "scout",
  name: "Scout",
  role: "Researcher",
  color: "#a4551e",
};

const SIDECAR = () => process.env.BROWSER_SERVICE_URL || "http://127.0.0.1:8010";

function transcript(history) {
  return history
    .map((m) => `${m.from === "user" ? "User" : m.agentName || "Agent"}: ${m.text}`)
    .join("\n");
}

// --- Decision call (no web search) ------------------------------------------

// Cheap gate before the decision call. Every model call counts against free
// tier rate limits (~20/min), and a turn already costs a doctor reply; adding
// a decision call to "hi" is how you hit 429s and start churning fallbacks.
// Returns a reason string when research should be skipped without asking.
export function skipResearchReason(history, session = {}) {
  const userTurns = history.filter((m) => m.from === "user");
  const latest = userTurns[userTurns.length - 1]?.text || "";

  if (userTurns.length < 2) return "too early — nothing to research yet";
  if (latest.length < 25) return "message too short to research";
  if (/^(hi|hey|hello|yes|no|ok|okay|sure|thanks|yeah|nope|maybe)\b[\s.!?]*$/i.test(latest.trim()))
    return "conversational filler";

  // At most one research pass every few turns.
  const since = userTurns.length - (session.lastResearchTurn ?? -Infinity);
  if (since < 3) return `cooling down (${since} turn${since === 1 ? "" : "s"} since last)`;

  return null;
}

export async function shouldResearch(history, { config } = {}) {
  const known = getGames().map((g) => g.name);

  // Protect the foreground conversation when we are on a constrained free
  // route. Instead of spending a model call merely deciding whether Scout
  // should research, use a conservative keyword gate and save the request for
  // the actual research.
  if (isConstrainedFree(config, "scout")) {
    const latest = [...history].reverse().find((m) => m.from === "user")?.text || "";
    const searchable = /\b(endeavor|game|games|app|apps|assessment|assessed|diagnos|clinician|psychiatr|psycholog|waitlist|referral|price|pricing|cost|insurance|coverage|covered|fsa|hsa|trial|discount)\b/i;
    if (!searchable.test(latest)) return { search: false, reason: "free-tier request reserved for the conversation" };

    // The normal path remembers its searches after the decision call. Free
    // mode has no decision call, so do the same bookkeeping here or a user
    // saying essentially the same thing a few turns later would burn another
    // scarce request.
    const norm = (q) =>
      String(q).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3);
    const words = new Set(norm(latest));
    for (const prev of config?._searched || []) {
      const prevWords = norm(prev);
      const overlap = prevWords.filter((w) => words.has(w)).length;
      const base = Math.min(prevWords.length, words.size);
      if (base && overlap / base >= 0.6) {
        return { search: false, reason: "already covered this session" };
      }
    }
    config._searched = config._searched || new Set();
    config._searched.add(latest.slice(0, 500));

    return {
      search: true,
      task: classifyTask(latest),
      query: latest.slice(0, 500),
      reason: "direct intent detected without a decision-model call",
    };
  }
  const alreadySearched = [...(config?._searched || [])];
  const raw = await agentChat(config, "scout", {
    json: true,
    temperature: 0,
    maxTokens: 300,
    messages: [
      {
        role: "system",
        content: `You decide whether background research would help right now, and what KIND.

Tasks you can choose:
- "games": find evidence-based attention-training games / digital therapeutics for ADHD.
- "clinicians": how this person can get a real assessment where they live — routes to care, directories, professional registers.
- "deals": what a product they're interested in costs, and how people pay for it (insurance, FSA/HSA, trials, funding).

Pick "clinicians" when they ask about getting assessed, diagnosed, seeing someone, waitlists, or what to do next.
Pick "deals" when they've shown interest in a specific product and price or affordability is the open question.
Otherwise "games".

Search when the conversation has revealed something specific and searchable that the library can't already answer.
Do NOT search on small talk, or if the library already covers what's needed, or if you searched for essentially the same thing already.

Local library already contains: ${known.join(", ") || "(empty)"}
Already researched this session (do NOT repeat these or minor rewordings of them): ${alreadySearched.join(" | ") || "(nothing yet)"}

Default to false. Only answer true when there is a SPECIFIC, NEW question the library can't answer — a different age group, a platform, a price, an alternative product nobody has mentioned yet. General interest in ADHD or attention games is not enough.

Respond with only a JSON object: {"search": true|false, "task": "games"|"clinicians"|"deals", "query": "<research focus, if true>", "reason": "<one short sentence>"}`,
      },
      { role: "user", content: transcript(history.slice(-12)) },
    ],
  });
  let decision;
  try {
    decision = parseJson(raw);
  } catch {
    return { search: false };
  }

  // Belt and braces: block near-duplicates of anything already searched, since
  // a repeated search can only ever produce "nothing new" a second time.
  if (decision?.search && decision.query) {
    const norm = (q) =>
      String(q).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3);
    const words = new Set(norm(decision.query));
    for (const prev of config?._searched || []) {
      const prevWords = norm(prev);
      const overlap = prevWords.filter((w) => words.has(w)).length;
      const base = Math.min(prevWords.length, words.size);
      if (base && overlap / base >= 0.6) {
        return { search: false, reason: "already covered this session" };
      }
    }
    config._searched = config._searched || new Set();
    config._searched.add(decision.query);
  }
  return decision;
}

// --- Research entry point ----------------------------------------------------

export async function research(query, { deep = false, config, task } = {}) {
  const taskId = task || classifyTask(query);
  if (deep) {
    try {
      return await deepResearch(query, config, taskId);
    } catch (err) {
      const fallback = await standardResearch(query, config, taskId);
      fallback.deepUnavailable = trim(err.message, 90);
      return fallback;
    }
  }
  return standardResearch(query, config, taskId);
}

// --- Standard pipeline: OpenRouter web tool, then fetch + enrich --------------

async function standardResearch(query, config, taskId = "games") {
  const task = getTask(taskId);
  const call = agentCall(config, "scout");
  const providerCanSearch = getProvider(call.provider).supportsOnline;
  // OpenRouter bills web search per request, separately from tokens — so a
  // free model on a spent account can't actually search. Say so rather than
  // letting Scout quietly answer from memory and call it research.
  const constrainedFree = isConstrainedFree(config, "scout");
  const canSearch = providerCanSearch && !constrainedFree;

  // 1) Search — or, on a provider without web search, work from knowledge and
  //    let the fetch step below do the verifying against live pages.
  const raw = await agentChat(config, "scout", {
    online: canSearch, // OpenRouter web-search server tool (OpenRouter only)
    temperature: 0.2,
    maxTokens: 1600,
    messages: [
      {
        role: "system",
        content: `${task.system({ knownNames: getGames().map((g) => g.name), location: config?.location || "" })}

${
  canSearch
    ? "Use the web results provided to you."
    : "You have NO live web results this time. Offer only well-established things you are confident about, with official URLs where you know them; a later step fetches those pages and corrects you. Prefer fewer, surer entries, and say when something should be verified."
}

Return ONLY a JSON object in this exact shape:
${task.schema}`,
      },
      { role: "user", content: `Research task: ${query}` },
    ],
  });

  let parsed = parseJson(raw);
  let note = parsed.note || "";

  // 2) Fetch step (default): read the official pages and enrich the drafts.
  //    Without live search this is the only source of *current* facts, so also
  //    pull the URLs already in the library — that's how a free-tier Scout can
  //    still discover a price or an availability change.
  let pages = [];
  if (task.enrich) {
    const urls = task.urlsFrom(parsed).filter(Boolean);
    if (!canSearch) urls.push(...getGames().map((g) => g.url));
    pages = await fetchPages(urls).catch(() => []);
    if (pages.length) {
      try {
        const enriched = await enrich(query, parsed, pages, config, task);
        if (enriched && typeof enriched === "object") {
          parsed = { ...parsed, ...enriched };
          if (enriched.note) note = enriched.note;
        }
      } catch {
        // Enrichment is best-effort; keep the draft entries.
      }
    }
  }

  const saved = task.persist(parsed);
  const { games: library, added, updated, updatedFields } = saved;
  return {
    task: task.id,
    parsed,
    body: formatResult(task.id, parsed),
    needLocation: parsed.needLocation === true,
    library,
    added,
    updated,
    updatedFields,
    note,
    worthSaying: task.worthSaying({ added, updated, updatedFields }, parsed),
    detail: task.detail({ added, updated, updatedFields }, parsed),
    mode: canSearch ? "standard" : "no-search",
    searchUsed: canSearch,
    // Reason the caller can show the user, once.
    searchBlocked: canSearch
      ? null
      : constrainedFree
        ? "free-model"
        : "provider",
    pagesRead: pages.length,
  };
}

async function enrich(query, draft, pages, config, task) {
  const pageBlocks = pages
    .map((p) => `--- PAGE: ${p.url} ---\n${p.text}`)
    .join("\n\n");

  const raw = await agentChat(config, "scout", {
    json: true,
    temperature: 0.1,
    maxTokens: 1600,
    messages: [
      {
        role: "system",
        content: `You verify and enrich a draft result using text extracted from the relevant official pages. Correct anything the pages contradict, and fill in concrete details the pages confirm (pricing, platforms, age ranges, prescription requirements, eligibility). If a page doesn't confirm a detail, leave it as it was — never invent.

Return ONLY a JSON object in this exact shape:
${task.schema}`,
      },
      {
        role: "user",
        content: `Research task: ${query}\n\nDraft result:\n${JSON.stringify(draft, null, 2)}\n\nExtracted page text:\n${pageBlocks}`,
      },
    ],
  });
  return parseJson(raw);
}

// --- Deep pipeline: browser-use sidecar --------------------------------------

async function deepResearch(query, config, taskId = "games") {
  const task = getTask(taskId);
  const instruction =
    taskId === "clinicians"
      ? `Research how someone can get an ADHD assessment: "${query}".
Visit official health-service pages, professional registers, and national ADHD charities. Collect the routes to assessment available there, the directories or registers people can search themselves, typical costs and waits, and what to ask when booking. Do not rank individual practitioners. Finish by returning the final answer as JSON only, using the exact schema appended below.`
      : taskId === "deals"
        ? `Research current pricing and how people pay for these: "${query}".
Visit the vendors' own pages (e.g. endeavorotc.com) plus insurer or health-funding pages. Collect current list prices, subscription terms, trials, discounts, and insurance/FSA/HSA eligibility. Ignore coupon-aggregator and resale sites. Finish by returning the final answer as JSON only, using the exact schema appended below.`
        : `Research this for someone exploring ADHD attention-training games: "${query}".
Visit official sources (e.g. endeavorrx.com, endeavorotc.com, app stores, FDA pages) as relevant. Collect for each product: name, intended audience/ages, whether a prescription is required, platforms, CURRENT pricing if shown, a plain-language description, and evidence/regulatory status. Finish by returning the final answer as JSON only, using the exact schema appended below.`;

  const browserInstruction = `${instruction}

FINAL OUTPUT CONTRACT
Return ONLY a JSON object matching this exact shape. Do not wrap it in commentary:
${task.schema}`;

  const call = agentCall(config, "scout");
  // Deep search bypasses agentChat while the browser is running, so give
  // Browser Use a healthy primary route plus one independent backup route.
  // Prefer a different provider for the backup to survive account-level free
  // quotas, then fall back to another model on the same provider if needed.
  const browserRoutes = fallbackSequence(config, "scout");
  const primary = browserRoutes[0] || {
    provider: call.provider, model: call.model, apiKey: call.apiKey, baseUrl: call.baseUrl,
  };
  const alternatives = browserRoutes.filter(
    (c) => c.provider !== primary.provider || c.model !== primary.model
  );
  const browserFallback = alternatives.find((c) => c.provider !== primary.provider) || alternatives[0];

  const res = await fetch(`${SIDECAR()}/task`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Send the active session's credentials so deep search uses whatever
    // provider the user picked, not a stale server-side env var.
    body: JSON.stringify({
      instruction: browserInstruction,
      api_key: primary.apiKey || undefined,
      model: primary.model || undefined,
      base_url: primary.baseUrl || undefined,
      provider: primary.provider || undefined,
      fallback_api_key: browserFallback?.apiKey || undefined,
      fallback_model: browserFallback?.model || undefined,
      fallback_base_url: browserFallback?.baseUrl || undefined,
      fallback_provider: browserFallback?.provider || undefined,
    }),
    signal: AbortSignal.timeout(Number(process.env.BROWSER_TIMEOUT_MS || 240000)),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`sidecar HTTP ${res.status}${detail ? `: ${trim(detail, 180)}` : ""}`);
  }
  const payload = await res.json();
  const result = payload?.result;
  if (!result) throw new Error("sidecar returned no result");

  // Browser Use can usually produce the requested JSON itself. Parse that
  // first so deep search does not automatically spend one extra Scout call.
  // Keep the old structuring pass only as a compatibility fallback for models
  // that ignore the final-output contract.
  let parsed;
  try {
    parsed = result && typeof result === "object" ? result : parseJson(String(result));
  } catch {
    const raw = await agentChat(config, "scout", {
    json: true,
    temperature: 0.1,
    maxTokens: 1600,
    messages: [
      {
        role: "system",
        content: `Convert these browser-research findings into structured data. Only include what the findings support; never invent names, URLs, or prices.

Return ONLY a JSON object in this exact shape:
${task.schema}`,
      },
      { role: "user", content: `Research task: ${query}\n\nBrowser findings:\n${result}` },
    ],
  });

    parsed = parseJson(raw);
  }
  const { games: library, added, updated, updatedFields } = getTask(taskId).persist(parsed);
  return {
    task: taskId,
    parsed,
    body: formatResult(taskId, parsed),
    needLocation: parsed.needLocation === true,
    library,
    added,
    updated,
    updatedFields,
    note: parsed.note || "",
    worthSaying: true,
    detail: getTask(taskId).detail({ added, updated, updatedFields }, parsed),
    mode: "deep",
    searchUsed: true,
  };
}

// --- Session summaries → long-term memory ------------------------------------

export async function summarizeSession(history, { config } = {}) {
  if (!history.some((m) => m.from === "user")) return null;

  const raw = await agentChat(config, "scout", {
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

export async function professionalStatement(history, { config } = {}) {
  if (!history.some((m) => m.from === "user")) return null;

  const known = getGames()
    .map((g) => `${g.name} (${g.audience || "?"}, ${g.access || "?"})`)
    .join("; ");

  const raw = await agentChat(config, "scout", {
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
