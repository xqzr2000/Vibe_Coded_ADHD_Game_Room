// Focus Room test suite — `npm test`.
//
// Pure logic (safety, output hygiene, names, parsing) plus integration tests
// against tests/mock-services.mjs, a local stand-in for Groq, Tavily and
// DuckDuckGo. No network access or real keys are needed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockServices } from "./mock-services.mjs";

const mock = await startMockServices(0);
const BASE = `http://127.0.0.1:${mock.port}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "focus-room-test-"));
fs.copyFileSync(new URL("../data/games.json", import.meta.url), path.join(DATA, "games.json"));
Object.assign(process.env, {
  GROQ_BASE_URL: `${BASE}/openai/v1`,
  TAVILY_BASE_URL: `${BASE}/tavily`,
  DDG_HTML_URL: `${BASE}/ddg/html/`,
  FOCUS_ROOM_DATA_DIR: DATA,
  FOCUS_ROOM_ALLOW_PRIVATE_FETCH: "1",
  ALLOW_SERVER_KEYS: "0",
  LOCAL_MEMORY: "1",
});
delete process.env.GROQ_FREE_MODELS;

const { assessRisk } = await import("../server/safety.js");
const { stripReasoning, chat, classify, LlmError } = await import("../server/llm.js");
const { looksLikeReasoning, doctorReply } = await import("../server/agents/doctor.js");
const { skipResearchReason, shouldResearch, research, executedToolsSummary } = await import("../server/agents/researcher.js");
const { classifyTask } = await import("../server/agents/scout-tasks.js");
const { agentChat, usableChain } = await import("../server/fallback.js");
const { FREE_MODELS, chainFor, isFreeModel } = await import("../server/models.js");
const { defaultConfig, applyUpdate, resolveKey } = await import("../server/config.js");
const { parseDuration, headroom, recordHeaders, _resetForTests } = await import("../server/quota.js");
const { fitMessages } = await import("../server/context.js");
const { sanitizeProfile, validateNickname } = await import("../server/profile.js");
const { nameBudget, enforceNameLimit } = await import("../server/nickname.js");
const { parseDuckDuckGo } = await import("../server/search/duckduckgo.js");
const { htmlToText, assertPublicUrl } = await import("../server/fetcher.js");
const { cleanField, saveGames, getGames } = await import("../server/store.js");
const { planExhausted } = await import("../server/search/tavily.js");
const { testGroqKey, testTavilyKey } = await import("../server/diagnose.js");

let failures = 0;
let count = 0;
function check(name, actual, expected) {
  count += 1;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures += 1;
    console.error(`FAIL  ${name}\n        got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}
const group = (t) => console.log(`\n${t}`);
const cfg = (extra = {}) => ({ ...defaultConfig(), keys: { groq: "gsk_test" }, ...extra });

// --- safety -------------------------------------------------------------------
group("safety: crisis disclosures are detected");
for (const text of ["I want to kill myself", "I keep thinking about suicide", "I don't want to be here anymore", "sometimes I just want to die", "I have been cutting myself", "there is no point in living", "everyone would be better off without me"]) {
  check(`crisis: "${text}"`, assessRisk(text).level, "crisis");
}
group("safety: figures of speech are not crises");
for (const text of ["this paperwork is killing me", "I am dying to finish this project", "my phone died halfway through", "deadlines are killing me", "I am dead tired every morning"]) {
  check(`idiom: "${text}"`, assessRisk(text).level, "none");
}

// --- output hygiene -----------------------------------------------------------
group("output hygiene");
check("think tags stripped", stripReasoning("<think>planning</think>Hello there."), "Hello there.");
check("unclosed think stripped", stripReasoning("<think>truncated forever"), "");
check("leaked plan detected", looksLikeReasoning("The user wants games. I need to follow the plan. This is the Orient stage."), true);
check("natural reply passes", looksLikeReasoning("Ha — the classic 'I'll just check one thing'. What were you supposed to be doing when that happened?"), false);

// --- free-only allowlist and chains -------------------------------------------
group("models: free only");
check("three default free models", FREE_MODELS.map((m) => m.id), ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"]);
check("stale qwen3.6 id is gone", isFreeModel("qwen/qwen3.6-27b"), false);
check("paid model refused", isFreeModel("moonshotai/kimi-k2-instruct"), false);
check("Dr. Maple chain", chainFor("doctor"), ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"]);
check("Scout chain starts elsewhere", chainFor("scout"), ["openai/gpt-oss-20b", "qwen/qwen3.8-27b", "openai/gpt-oss-120b"]);
check("browser search only on gpt-oss", usableChain(cfg(), "scout", "browserSearch"), ["openai/gpt-oss-20b", "openai/gpt-oss-120b"]);
const upd = applyUpdate(defaultConfig(), { models: { doctor: "anthropic/claude-sonnet-4", scout: "qwen/qwen3.8-27b" } });
check("browser cannot pick a paid model", upd.models.doctor, "openai/gpt-oss-120b");
check("browser can pick another free model", upd.models.scout, "qwen/qwen3.8-27b");
try {
  await chat({ model: "meta-llama/llama-4-maverick", apiKey: "gsk_x", messages: [] });
  check("non-free model call refused", "called", "refused");
} catch (err) {
  check("non-free model call refused before any request", err.kind, "not_free");
}

group("config: server keys need operator opt-in");
process.env.GROQ_API_KEY = "gsk_server";
check("env key hidden by default", resolveKey(defaultConfig(), "groq"), "");
check("env key used when allowed", resolveKey({ ...defaultConfig(), allowServerKeys: true }, "groq"), "gsk_server");
check("browser key wins", resolveKey({ keys: { groq: "gsk_mine" }, allowServerKeys: true }, "groq"), "gsk_mine");
delete process.env.GROQ_API_KEY;
const fromBrowser = applyUpdate(defaultConfig(), { allowServerKeys: true, keys: {} });
check("browser cannot enable server keys", fromBrowser.allowServerKeys, false);

// --- quota --------------------------------------------------------------------
group("quota: Groq rate-limit headers");
check("parse 2m59.56s", parseDuration("2m59.56s"), 179560);
check("parse 7.66s", parseDuration("7.66s"), 7660);
check("parse 250ms", parseDuration("250ms"), 250);
_resetForTests();
const h = new Headers({ "x-ratelimit-limit-tokens": "8000", "x-ratelimit-remaining-tokens": "300", "x-ratelimit-reset-tokens": "40s", "x-ratelimit-limit-requests": "1000", "x-ratelimit-remaining-requests": "999" });
recordHeaders("gsk_q", "openai/gpt-oss-120b", h);
check("low tokens → no headroom for a big request", headroom("gsk_q", "openai/gpt-oss-120b", 3000).ok, false);
check("small request still fits", headroom("gsk_q", "openai/gpt-oss-120b", 200).ok, true);
_resetForTests();

// --- context trimming ---------------------------------------------------------
group("context: stays inside the 8K TPM budget");
const longHistory = [{ role: "system", content: "sys" }, ...Array.from({ length: 80 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `message ${i} `.repeat(40) }))];
const fitted = fitMessages(longHistory, 2000);
check("old turns dropped", fitted.dropped > 0, true);
check("newest message kept", fitted.messages[fitted.messages.length - 1].content, longHistory[longHistory.length - 1].content);
check("system prompt kept", fitted.messages[0].content, "sys");
const toolStart = fitMessages([{ role: "system", content: "s" }, { role: "tool", content: "x".repeat(9000), tool_call_id: "a" }, { role: "user", content: "hi" }], 500);
check("never starts with an orphan tool result", toolStart.messages.some((m) => m.role === "tool"), false);

// --- profile & names ----------------------------------------------------------
group("profile");
check("name trimmed", validateNickname("  Alex  ").value, "Alex");
check("agent name refused", validateNickname("Scout").ok, false);
check("25 chars refused", validateNickname("x".repeat(25)).ok, false);
check("unknown icon → default", sanitizeProfile({ avatarEmoji: "💣" }).profile.avatarEmoji, "🌱");
check("known icon kept", sanitizeProfile({ avatarEmoji: "🦊", avatarColor: "#4a5d8a" }).profile.avatarColor, "#4a5d8a");
check("name used on greeting", nameBudget({ nickname: "Ann", userTurns: 1 }).allow, true);
check("name held back in cooldown", nameBudget({ nickname: "Ann", userTurns: 3, lastNameTurn: 1 }).allow, false);
check("name stripped when not allowed", enforceNameLimit("Sure, Ann, that announcement helps.", { nickname: "Ann", allow: false }), "Sure, that announcement helps.");

// --- research gating ----------------------------------------------------------
group("research gating");
const turns = (...texts) => texts.map((text) => ({ from: "user", text }));
check("first turn skipped", Boolean(skipResearchReason(turns("hi"), {})), true);
check("clinician task", classifyTask("who can diagnose me in Vancouver"), "clinicians");
check("deals task", classifyTask("how much does EndeavorOTC cost"), "deals");
const gateCfg = cfg();
check("ordinary chat: no research", (await shouldResearch(turns("hello", "I keep zoning out in meetings at work lately"), { config: gateCfg })).search, false);
check("price question: research", (await shouldResearch(turns("hello", "how much does the EndeavorOTC subscription cost per month?"), { config: gateCfg })).task, "deals");
check("repeat question: skipped", (await shouldResearch(turns("hello", "how much does the EndeavorOTC subscription cost each month?"), { config: gateCfg })).search, false);

// --- parsing helpers ----------------------------------------------------------
group("search parsing");
const ddg = parseDuckDuckGo(`<div class="result results_links"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fa&amp;rut=1">Example <b>A</b></a><a class="result__snippet">Snip &amp; more</a></div><div class="result result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?x">Ad</a></div>`);
check("DDG result URL decoded", ddg[0]?.url, "https://example.org/a");
check("DDG title cleaned", ddg[0]?.title, "Example A");
check("DDG ads skipped", ddg.length, 1);
const page = htmlToText("<html><title>T &amp; Co</title><nav>Menu Menu</nav><main><p>" + "Real content. ".repeat(40) + "</p><script>x()</script></main></html>");
check("page title decoded", page.title, "T & Co");
check("main content preferred", page.text.includes("Menu"), false);
check("Groq executed_tools summarized", executedToolsSummary([{ arguments: '{"query":"q1"}', search_results: { results: [{ title: "A", url: "https://a.org" }] } }]).queries, ["q1"]);
check("Tavily plan exhausted", planExhausted({ planUsage: 1000, planLimit: 1000 }), true);
check("Tavily plan fine", planExhausted({ planUsage: 12, planLimit: 1000 }), false);

delete process.env.FOCUS_ROOM_ALLOW_PRIVATE_FETCH;
for (const bad of ["http://localhost:3000/", "http://127.0.0.1/", "http://169.254.169.254/latest", "http://192.168.1.4/", "file:///etc/passwd"]) {
  let refused = false;
  try { await assertPublicUrl(bad); } catch { refused = true; }
  check(`page reader refuses ${bad}`, refused, true);
}
process.env.FOCUS_ROOM_ALLOW_PRIVATE_FETCH = "1";

group("library hygiene");
check("schema placeholder rejected", cleanField("pricing", "current price if known"), "");
check("fetch failure is not evidence", cleanField("evidence", "The provided page is a parked domain and contains no information."), "");
check("real price kept", cleanField("pricing", "$24.99/month"), "$24.99/month");
saveGames([{ name: "EndeavorRx", pricing: "current price if known", url: "not a url" }]);
check("junk fields never saved", getGames().find((g) => g.name === "EndeavorRx").pricing, undefined);

// --- classification ------------------------------------------------------------
group("Groq error classification");
check("401 → bad_key", classify(401, "", null, "m").kind, "bad_key");
check("413 → too_large", classify(413, '{"error":{"code":"request_too_large"}}', null, "m").kind, "too_large");
check("429 → rate_limited", classify(429, "Rate limit reached", new Headers({ "retry-after": "7" }), "m").retryAfterMs, 7000);
check("decommissioned → bad_model", classify(400, '{"error":{"code":"model_decommissioned"}}', null, "m").kind, "bad_model");
check("tool_use_failed → tool_failed", classify(400, '{"error":{"code":"tool_use_failed"}}', null, "m").kind, "tool_failed");

// --- integration against the mock services ---------------------------------
group("integration: streaming chat");
_resetForTests();
const deltas = [];
const streamed = await chat({ model: "openai/gpt-oss-120b", apiKey: "gsk_t", stream: true, reasoning: "show", messages: [{ role: "user", content: "hello" }], onDelta: (d) => deltas.push(d.type) });
check("content streamed token by token", deltas.filter((t) => t === "content").length > 5, true);
check("reasoning streamed when asked", deltas.includes("reasoning"), true);
check("gpt-oss asked for low effort", mock.control.calls.at(-1).body.reasoning_effort, "low");
check("full text assembled", streamed.content.startsWith("That sounds frustrating"), true);

group("integration: fallback to the next free model");
_resetForTests();
mock.control.fail["openai/gpt-oss-120b"] = 1;
const switches = [];
const fbCfg = cfg({ onFallbackAttempt: (e) => switches.push(e), onActive: () => {} });
const fb = await agentChat(fbCfg, "doctor", { messages: [{ role: "user", content: "hi" }], maxTokens: 200 });
check("rate-limited model skipped", fb.model, "qwen/qwen3.8-27b");
check("switch announced", switches[0]?.to, "qwen/qwen3.8-27b");
check("qwen reasoning hidden for chat", mock.control.calls.at(-1).body.reasoning_format, "hidden");
const fb2 = await agentChat(fbCfg, "doctor", { messages: [{ role: "user", content: "hi again" }], maxTokens: 200 });
check("cooling model not hit again next turn", fb2.model, "qwen/qwen3.8-27b");
check("only free models were ever called", mock.control.calls.every((c) => isFreeModel(c.model)), true);

group("integration: Dr. Maple streams with steps and uses the name");
_resetForTests();
const events = [];
const reply = await doctorReply([{ from: "user", text: "I drift off in meetings" }], {
  userTurns: 1,
  config: cfg(),
  user: { nickname: "Russell" },
  onEvent: (e) => events.push(e),
});
check("process steps sent", events.filter((e) => e.type === "step").map((e) => e.id).slice(0, 3), ["read", "focus", "think"]);
check("reply streamed in pieces", events.filter((e) => e.type === "delta").length > 1, true);
check("final text returned", reply.text.length > 20, true);

group("integration: Scout's search loop and trajectory");
_resetForTests();
const trace = [];
const scoutCfg = cfg({ keys: { groq: "gsk_t", tavily: "tvly-test" } });
const r = await research("EndeavorOTC price for adults", { config: scoutCfg, task: "deals", trace: (op) => trace.push(op) });
const kinds = trace.filter((o) => o.op === "add").map((o) => o.step.kind);
check("loop mode used", r.mode, "agent");
check("trajectory: search then read", kinds.includes("search") && kinds.indexOf("read") > kinds.indexOf("search"), true);
check("reasoning streamed into the trajectory", trace.some((o) => o.op === "append"), true);
const searchDone = trace.find((o) => o.op === "update" && o.patch.backend);
check("search used Tavily", searchDone?.patch.backend, "Tavily");
const readDone = trace.find((o) => o.op === "update" && o.patch.pages && o.patch.status === "done");
check("unreadable page reported, not fatal", readDone.patch.pages.some((p) => p.status === "failed"), true);
check("deals findings parsed", r.parsed.findings?.[0]?.price, "$24.99/month or $129.99/year");
check("price posted to the library", getGames().find((g) => g.name === "EndeavorOTC")?.pricing, "$24.99/month or $129.99/year");
check("sources collected", r.sources.length > 0, true);
check("credits counted", r.credits, 2);
check("Scout ran on its own model", mock.control.calls.filter((c) => c.tools.includes("web_search")).every((c) => c.model === "openai/gpt-oss-20b"), true);

group("integration: no Tavily key → DuckDuckGo + direct page reading");
_resetForTests();
const before = mock.control.ddgCalls;
const r2 = await research("EndeavorOTC price for adults", { config: cfg(), task: "games", trace: () => {} });
check("DuckDuckGo searched", mock.control.ddgCalls > before, true);
check("pages read directly", r2.backends.includes("direct fetch"), true);

group("integration: settings checks");
const gt = await testGroqKey("gsk_ok");
check("Groq key test passes", gt.ok, true);
check("Groq key test reports usable models", gt.usable, 3);
check("bad Groq key reported", (await testGroqKey("nope")).kind, "bad_key");
const tt = await testTavilyKey("tvly-test", { search: true });
check("Tavily test shows plan usage", tt.usage?.planLimit, 1000);
check("Tavily test search ran", tt.search?.results.length, 3);

group("UI: no OpenRouter, no accounts");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const serverSrc = ["index.js", "config.js", "llm.js", "fallback.js"].map((f) => fs.readFileSync(new URL(`../server/${f}`, import.meta.url), "utf8")).join("\n");
check("no OpenRouter in UI", /openrouter/i.test(html), false);
check("no OpenRouter in server", /openrouter/i.test(serverSrc), false);
check("no /api/me account routes", serverSrc.includes('"/api/me"'), false);
check("UI shows Scout activity panel", html.includes('id="runs"'), true);
check("UI handles streamed deltas", html.includes('case "agent_delta"'), true);
check("UI has Tavily key field", html.includes('id="tavilyKey"'), true);
check("UI has profile name + icon", html.includes('id="profileName"') && html.includes('id="profileEmoji"'), true);

mock.server.close();
fs.rmSync(DATA, { recursive: true, force: true });
console.log(`\n${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
