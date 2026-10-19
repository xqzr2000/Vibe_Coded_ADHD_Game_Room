// Scout — the background researcher.
//
// Research is a small agent loop on Groq function calling:
//
//   think → web_search(query) → think → read_pages(urls) → think → final JSON
//
// Every step is reported through `trace` so the side panel can show Scout's
// trajectory live: what it searched, what came back, which pages it read, and
// its reasoning in between. Budget per run: 2 searches, 1 read of up to 3
// pages (about 3 Tavily credits).
//
// If the loop can't run (a model mangles tool calls, say), a fixed pipeline
// does the same job: search → read the top pages → write. If no search backend
// works at all, Groq's built-in browser_search is tried, and only then does
// Scout answer from what it already knows — saying so.

import { parseJson, LlmError } from "../llm.js";
import { agentChat, agentText } from "../fallback.js";
import { modelInfo } from "../models.js";
import { createSearcher } from "../search/index.js";
import { SearchError, domainOf } from "../search/errors.js";
import { getGames, saveMemory } from "../store.js";
import { getTask, classifyTask, formatResult } from "./scout-tasks.js";

export const researcherAgent = {
  id: "scout",
  name: "Scout",
  role: "Researcher",
  color: "#a4551e",
};

const SEARCH_BUDGET = 2;
const READ_BUDGET = 1;
const MAX_URLS = 3;
const MAX_STEPS = 6;
const PAGE_CHARS = 1800;

function transcript(history) {
  return history.map((m) => `${m.from === "user" ? "User" : m.agentName || "Agent"}: ${m.text}`).join("\n");
}

// --- When to research --------------------------------------------------------
// Every model call counts against free-tier limits, so there is no "should I
// research?" model call: cheap code decides.

const SEARCHABLE =
  /\b(endeavor|game|games|app|apps|assessment|assessed|diagnos\w*|clinician|psychiatr\w*|psycholog\w*|waitlist|referral|price|pricing|cost|insurance|coverage|covered|fsa|hsa|trial|discount)\b/i;

export function skipResearchReason(history, session = {}) {
  const userTurns = history.filter((m) => m.from === "user");
  const latest = userTurns[userTurns.length - 1]?.text || "";

  if (latest.length < 25) return "message too short to research";
  // On the first turn, research only an explicit question ("what does X cost?").
  if (userTurns.length < 2 && !SEARCHABLE.test(latest)) return "too early — nothing to research yet";
  if (/^(hi|hey|hello|yes|no|ok|okay|sure|thanks|yeah|nope|maybe)\b[\s.!?]*$/i.test(latest.trim()))
    return "conversational filler";
  const since = userTurns.length - (session.lastResearchTurn ?? -Infinity);
  if (since < 3) return `cooling down (${since} turn${since === 1 ? "" : "s"} since last)`;
  return null;
}



const words = (q) =>
  String(q).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3);

export async function shouldResearch(history, { config } = {}) {
  const latest = [...history].reverse().find((m) => m.from === "user")?.text || "";
  if (!SEARCHABLE.test(latest)) return { search: false, reason: "nothing specific to look up" };

  const now = new Set(words(latest));
  for (const prev of config?._searched || []) {
    const prevWords = words(prev);
    const overlap = prevWords.filter((w) => now.has(w)).length;
    const base = Math.min(prevWords.length, now.size);
    if (base && overlap / base >= 0.6) return { search: false, reason: "already covered this session" };
  }
  config._searched = config._searched || new Set();
  config._searched.add(latest.slice(0, 500));
  return { search: true, task: classifyTask(latest), query: latest.slice(0, 500), reason: "research intent detected" };
}

// --- Trajectory reporting ----------------------------------------------------

function makeTracer(emit = () => {}) {
  let n = 0;
  const handle = (id) => ({
    id,
    update: (patch) => emit({ op: "update", id, patch }),
    done: (patch = {}) => emit({ op: "update", id, patch: { ...patch, status: "done" } }),
    fail: (patch = {}) => emit({ op: "update", id, patch: { ...patch, status: "error" } }),
  });
  const tracer = {
    add(kind, data = {}) {
      const id = `s${++n}`;
      const status = data.status || (["note", "done"].includes(kind) ? "done" : "active");
      emit({ op: "add", step: { id, kind, at: Date.now(), ...data, status } });
      return handle(id);
    },
    // A reasoning step that only appears once the model actually starts thinking.
    thinking(title = "Thinking") {
      let h = null;
      let model = "";
      let size = 0;
      return {
        setModel(m) {
          model = modelInfo(m)?.label || m;
          if (h) h.update({ model });
        },
        append(text) {
          if (!text) return;
          if (!h) h = tracer.add("thinking", { title, model });
          if (size > 6000) return; // enough to follow along; don't flood the socket
          size += text.length;
          emit({ op: "append", id: h.id, text });
        },
        close() {
          if (h) h.done();
        },
      };
    },
  };
  return tracer;
}

// --- Research entry point ----------------------------------------------------

export async function research(query, { config, task, trace } = {}) {
  const t = getTask(task || classifyTask(query));
  const tracer = makeTracer(trace);
  const searcher = createSearcher(config);
  tracer.add("start", { title: `Looking into ${t.label}`, detail: query, status: "done" });

  let outcome;
  let mode;
  try {
    outcome = await agentLoop(query, t, config, searcher, tracer);
    mode = "agent";
  } catch (err) {
    if (isFatal(err)) throw err;
    if (err instanceof SearchError) {
      outcome = await viaGroqBrowser(query, t, config, tracer, err).catch((e) => {
        if (isFatal(e)) throw e;
        return null;
      });
      mode = "groq-browser";
    } else {
      tracer.add("note", { title: "Switching to the simpler search path", detail: err.message });
      try {
        outcome = await simplePipeline(query, t, config, searcher, tracer);
        mode = "pipeline";
      } catch (err2) {
        if (isFatal(err2)) throw err2;
        outcome = await viaGroqBrowser(query, t, config, tracer, err2).catch((e) => {
          if (isFatal(e)) throw e;
          return null;
        });
        mode = "groq-browser";
      }
    }
    if (!outcome) {
      outcome = await fromKnowledge(query, t, config, tracer);
      mode = "no-search";
    }
  }

  const parsed = outcome.parsed || {};
  const saved = t.persist(parsed);
  const { games: library, added, updated, updatedFields } = saved;
  const sources = dedupeSources(outcome.sources || []);
  const worthSaying = t.worthSaying({ added, updated, updatedFields }, parsed);

  for (const note of searcher.state.notes) tracer.add("note", { title: note });
  tracer.add("done", {
    title: added || updated ? `Saved: ${t.detail({ added, updated, updatedFields }, parsed) || "library updated"}` : worthSaying ? "Findings ready" : "Nothing new for the library",
    detail: [
      sources.length ? `${sources.length} source${sources.length === 1 ? "" : "s"}` : "",
      searcher.state.credits ? `${searcher.state.credits} Tavily credit${searcher.state.credits === 1 ? "" : "s"}` : "",
      [...searcher.state.backends].join(", "),
    ].filter(Boolean).join(" · "),
  });

  return {
    task: t.id,
    parsed,
    body: formatResult(t.id, parsed),
    needLocation: parsed.needLocation === true,
    library,
    added,
    updated,
    updatedFields,
    note: parsed.note || "",
    worthSaying,
    detail: t.detail({ added, updated, updatedFields }, parsed),
    mode,
    searchUsed: mode !== "no-search",
    searchBlocked: mode === "no-search" ? "no-backend" : null,
    sources,
    credits: searcher.state.credits,
    backends: [...searcher.state.backends],
  };
}

const isFatal = (err) => err instanceof LlmError && ["no_key", "bad_key", "not_free", "rate_limited"].includes(err.kind);

function dedupeSources(list) {
  const seen = new Set();
  return list.filter((s) => s?.url && !seen.has(s.url) && seen.add(s.url)).slice(0, 5);
}

// --- The agent loop ----------------------------------------------------------

const TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web. Returns titles, URLs and short snippets for the top results.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "A focused search query, 3-12 words." } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_pages",
      description: "Read the main text of up to 3 pages from the search results. Prefer official and reputable sources.",
      parameters: {
        type: "object",
        properties: { urls: { type: "array", items: { type: "string" }, maxItems: MAX_URLS } },
        required: ["urls"],
      },
    },
  },
];

function taskPrompt(t, config) {
  return t.system({ knownNames: getGames().map((g) => g.name), location: config?.location || "" });
}

function loopSystem(t, config) {
  return `${taskPrompt(t, config)}

HOW YOU WORK
You have two tools: web_search and read_pages. Budget for this task: at most ${SEARCH_BUDGET} web_search calls and ${READ_BUDGET} read_pages call (up to ${MAX_URLS} URLs).
1. Search first. Make the query specific.
2. Pick the most official, reputable results and read them.
3. Then answer. Use only facts the search results or pages support.

When you are done, reply with ONLY a JSON object in this exact shape — no prose around it:
${t.schema}`;
}

function formatResults(results) {
  if (!results.length) return "No results.";
  return results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${(r.snippet || "").slice(0, 260)}`)
    .join("\n\n");
}

async function runSearch(searcher, tracer, q, found) {
  const step = tracer.add("search", { title: `Searching “${q}”`, query: q });
  try {
    const r = await searcher.search(q);
    for (const x of r.results) found.set(x.url, x);
    step.done({
      backend: r.backend,
      detail: `${r.results.length} result${r.results.length === 1 ? "" : "s"} via ${r.backend}`,
      results: r.results.map((x) => ({ title: x.title, url: x.url, domain: domainOf(x.url) })),
    });
    return r.results;
  } catch (err) {
    step.fail({ detail: err.message });
    throw err;
  }
}

async function runRead(searcher, tracer, urls, query, pagesOut) {
  const list = urls.filter((u) => /^https?:\/\//i.test(u)).slice(0, MAX_URLS);
  const step = tracer.add("read", {
    title: `Reading ${list.map(domainOf).filter(Boolean).join(", ") || "pages"}`,
    pages: list.map((url) => ({ url, domain: domainOf(url), status: "reading" })),
  });
  const r = await searcher.read(list, { query });
  pagesOut.push(...r.pages);
  step.done({
    detail: `${r.pages.length} of ${list.length} read`,
    pages: [
      ...r.pages.map((p) => ({ url: p.url, domain: domainOf(p.url), status: "ok", chars: p.text.length, via: p.via })),
      ...r.failed.map((f) => ({ url: f.url, domain: domainOf(f.url), status: "failed", error: f.error })),
    ],
  });
  return r;
}

const pageBlock = (pages) =>
  pages.map((p) => `--- PAGE: ${p.url} ---\n${p.text.slice(0, PAGE_CHARS)}`).join("\n\n");

async function agentLoop(query, t, config, searcher, tracer) {
  const messages = [
    { role: "system", content: loopSystem(t, config) },
    { role: "user", content: `Research task: ${query}` },
  ];
  const found = new Map();
  const pages = [];
  let searches = 0;
  let reads = 0;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const budgetLeft = searches < SEARCH_BUDGET || reads < READ_BUDGET;
    const think = tracer.thinking(step === 0 ? "Planning" : "Thinking");
    const res = await agentChat(config, "scout", {
      messages,
      ...(budgetLeft ? { tools: TOOLS, requires: "tools" } : { json: true }),
      stream: true,
      reasoning: "show",
      temperature: 0.2,
      maxTokens: 1400,
      onAttempt: ({ model }) => think.setModel(model),
      onDelta: (d) => d.type === "reasoning" && think.append(d.text),
    });
    think.close();

    if (res.toolCalls.length) {
      messages.push({
        role: "assistant",
        content: res.content || null, // OpenAI/Groq shape: null when the turn is only tool calls
        tool_calls: res.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments || "{}" },
        })),
      });
      for (const tc of res.toolCalls) {
        let args = {};
        try {
          args = JSON.parse(tc.arguments || "{}");
        } catch {
          /* model sent junk arguments; handled below */
        }
        let output;
        if (tc.name === "web_search") {
          if (searches >= SEARCH_BUDGET) {
            output = "Search budget used up. Read pages or give your final JSON answer.";
          } else {
            searches += 1;
            const q = String(args.query || query).slice(0, 200);
            output = formatResults(await runSearch(searcher, tracer, q, found));
          }
        } else if (tc.name === "read_pages") {
          if (reads >= READ_BUDGET) {
            output = "Reading budget used up. Give your final JSON answer now.";
          } else {
            reads += 1;
            const urls = Array.isArray(args.urls) ? args.urls.map(String) : [];
            const r = await runRead(searcher, tracer, urls, query, pages);
            output =
              (r.pages.length ? pageBlock(r.pages) : "No pages could be read.") +
              (r.failed.length ? `\n\nCould not read: ${r.failed.map((f) => f.url).join(", ")}` : "");
          }
        } else {
          output = `There is no tool called ${tc.name}.`;
        }
        messages.push({ role: "tool", tool_call_id: tc.id, content: output });
      }
      continue;
    }

    // The model answered without searching at all: ground it with one search.
    if (searches === 0) {
      searches += 1;
      const results = await runSearch(searcher, tracer, query.slice(0, 200), found);
      messages.push({
        role: "user",
        content: `Here are web results for the task. Read the best pages with read_pages if useful, then give the final JSON.\n\n${formatResults(results)}`,
      });
      continue;
    }

    return { parsed: await toJson(res.content, t, config, tracer, messages), sources: sourcesFrom(pages, found) };
  }

  // Out of steps: insist on the answer.
  messages.push({ role: "user", content: "Give your final JSON answer now." });
  const final = await agentText(config, "scout", { messages, json: true, temperature: 0.1, maxTokens: 1400 });
  return { parsed: await toJson(final, t, config, tracer, messages), sources: sourcesFrom(pages, found) };
}

function sourcesFrom(pages, found) {
  const fromPages = pages.map((p) => ({ url: p.url, title: found.get(p.url)?.title || p.title || domainOf(p.url) }));
  return fromPages.length ? fromPages : [...found.values()].slice(0, 3).map((r) => ({ url: r.url, title: r.title }));
}

async function toJson(text, t, config, tracer, context) {
  try {
    return parseJson(text);
  } catch {
    const step = tracer.add("note", { title: "Tidying the answer into the library format", status: "active" });
    const raw = await agentText(config, "scout", {
      json: true,
      temperature: 0,
      maxTokens: 1200,
      messages: [
        { role: "system", content: `Rewrite the research below as ONLY a JSON object in this exact shape:\n${t.schema}\nKeep only facts that are stated. Never invent.` },
        { role: "user", content: String(text || "").slice(0, 6000) || pageBlock([]) || JSON.stringify(context.slice(-3)) },
      ],
    });
    step.done();
    return parseJson(raw);
  }
}

// --- Fixed pipeline (no tool calling) ----------------------------------------

async function simplePipeline(query, t, config, searcher, tracer) {
  const found = new Map();
  const pages = [];
  const results = await runSearch(searcher, tracer, query.slice(0, 200), found);
  const picks = [];
  const domains = new Set();
  for (const r of results) {
    const d = domainOf(r.url);
    if (d && !domains.has(d)) {
      domains.add(d);
      picks.push(r.url);
    }
    if (picks.length >= MAX_URLS) break;
  }
  if (picks.length) await runRead(searcher, tracer, picks, query, pages);

  const think = tracer.thinking("Writing up");
  const res = await agentChat(config, "scout", {
    json: true,
    stream: true,
    reasoning: "show",
    temperature: 0.2,
    maxTokens: 1400,
    onAttempt: ({ model }) => think.setModel(model),
    onDelta: (d) => d.type === "reasoning" && think.append(d.text),
    messages: [
      { role: "system", content: `${taskPrompt(t, config)}\n\nUse only the search results and pages provided. Return ONLY a JSON object in this exact shape:\n${t.schema}` },
      { role: "user", content: `Research task: ${query}\n\nSEARCH RESULTS\n${formatResults(results)}\n\n${pageBlock(pages)}` },
    ],
  });
  think.close();
  return { parsed: await toJson(res.content, t, config, tracer, []), sources: sourcesFrom(pages, found) };
}

// --- Groq's built-in browser search (last web resort) --------------------------

export function executedToolsSummary(executed = []) {
  const queries = [];
  const results = [];
  for (const tool of executed) {
    let args = tool?.arguments;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = { query: args };
      }
    }
    if (args?.query) queries.push(String(args.query));
    const list = tool?.search_results?.results || tool?.search_results || [];
    if (Array.isArray(list)) {
      for (const r of list) if (r?.url) results.push({ title: String(r.title || r.url), url: String(r.url), domain: domainOf(r.url) });
    }
  }
  return { queries, results };
}

async function viaGroqBrowser(query, t, config, tracer, cause) {
  tracer.add("note", {
    title: "Web search backends unavailable — trying Groq's built-in browser search",
    detail: cause?.message || "",
  });
  const step = tracer.add("search", { title: `Groq browser search: “${query.slice(0, 80)}”`, backend: "Groq browser search" });
  const think = tracer.thinking("Searching and reading");
  let res;
  try {
    res = await agentChat(config, "scout", {
      requires: "browserSearch",
      tools: [{ type: "browser_search" }],
      toolChoice: "required",
      stream: true,
      reasoning: "show",
      temperature: 0.2,
      maxTokens: 1800,
      onAttempt: ({ model }) => think.setModel(model),
      onDelta: (d) => d.type === "reasoning" && think.append(d.text),
      messages: [
        { role: "system", content: `${taskPrompt(t, config)}\n\nSearch the web, then reply with ONLY a JSON object in this exact shape:\n${t.schema}` },
        { role: "user", content: `Research task: ${query}` },
      ],
    });
  } catch (err) {
    think.close();
    step.fail({ detail: err.message });
    throw err;
  }
  think.close();
  const { queries, results } = executedToolsSummary(res.executedTools);
  step.done({
    detail: queries.length ? `Searched: ${queries.join(" · ")}` : "Search ran on Groq's side",
    results: results.slice(0, 6),
  });
  return { parsed: await toJson(res.content, t, config, tracer, []), sources: results.slice(0, 3) };
}

// --- No search at all ----------------------------------------------------------

async function fromKnowledge(query, t, config, tracer) {
  tracer.add("note", {
    title: "No web search available right now — answering from general knowledge",
    detail: "Entries should be checked on the official pages.",
  });
  const raw = await agentText(config, "scout", {
    json: true,
    temperature: 0.2,
    maxTokens: 1200,
    messages: [
      {
        role: "system",
        content: `${taskPrompt(t, config)}\n\nYou have NO live web results. Offer only well-established things you are confident about, with official URLs where you know them. Prefer fewer, surer entries, and say in "note" that details should be verified.\n\nReturn ONLY a JSON object in this exact shape:\n${t.schema}`,
      },
      { role: "user", content: `Research task: ${query}` },
    ],
  });
  return { parsed: parseJson(raw), sources: [] };
}

// --- Session summaries → long-term memory ------------------------------------

export async function summarizeSession(history, { config } = {}) {
  if (!history.some((m) => m.from === "user")) return null;
  const raw = await agentText(config, "scout", {
    json: true,
    temperature: 0.2,
    maxTokens: 900,
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
  return saveMemory(parseJson(raw));
}

// --- Professional session statement (for PDF export) -------------------------

export async function professionalStatement(history, { config } = {}) {
  if (!history.some((m) => m.from === "user")) return null;
  const known = getGames()
    .map((g) => `${g.name} (${g.audience || "?"}, ${g.access || "?"})`)
    .join("; ");

  const raw = await agentText(config, "scout", {
    json: true,
    temperature: 0.2,
    maxTokens: 1800,
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
  return { ...parseJson(raw), generatedAt: new Date().toISOString() };
}
