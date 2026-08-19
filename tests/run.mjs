// Focus Room test suite — run with `npm test`.
//
// These cover the logic that must hold no matter which model is running:
// crisis detection, reasoning-leak cleanup, and the gate that keeps free-tier
// rate limits from being burned on pointless calls.

import { assessRisk } from "../server/safety.js";
import { stripReasoning } from "../server/llm.js";
import { looksLikeReasoning } from "../server/agents/doctor.js";
import { skipResearchReason, shouldResearch } from "../server/agents/researcher.js";
import { fallbackSequence, isConstrainedFree, isFreeModel } from "../server/fallback.js";
import { classifyTask } from "../server/agents/scout-tasks.js";
import { agentCall } from "../server/config.js";
import { getProvider } from "../server/providers.js";

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

function group(title) {
  console.log(`\n${title}`);
}

// --- crisis detection -------------------------------------------------------
group("safety: crisis disclosures are detected");
for (const text of [
  "I want to kill myself",
  "I keep thinking about suicide",
  "I don't want to be here anymore",
  "sometimes I just want to die",
  "I have been cutting myself",
  "there is no point in living",
  "everyone would be better off without me",
  "I want to take my own life",
]) {
  check(`crisis: "${text}"`, assessRisk(text).level, "crisis");
}

group("safety: figures of speech are NOT treated as crises");
for (const text of [
  "this paperwork is killing me",
  "I am dying to finish this project",
  "I could murder a coffee right now",
  "my phone died halfway through",
  "I would rather die than do my taxes",
  "deadlines are killing me",
  "I keep killing time on my phone",
  "I am dead tired every morning",
  "I nearly died of embarrassment in that meeting",
]) {
  check(`idiom: "${text}"`, assessRisk(text).level, "none");
}

group("safety: serious distress is distinguished from crisis");
check("distress", assessRisk("I can't go on like this").level, "distress");
check("neutral", assessRisk("I lose my keys constantly").level, "none");

// --- reasoning leakage ------------------------------------------------------
group("output hygiene: reasoning is stripped");
check("think tags", stripReasoning("<think>planning</think>Hello there."), "Hello there.");
check("unclosed tag", stripReasoning("<think>truncated forever"), "");
check("orphan close", stripReasoning("notes here</think>The reply."), "The reply.");
check("clean text untouched", stripReasoning("Just a normal reply."), "Just a normal reply.");

group("output hygiene: narrated planning is detected");
check(
  "leaked plan",
  looksLikeReasoning("The user wants games. I need to follow the plan. This is the Orient stage."),
  true
);
check(
  "natural reply",
  looksLikeReasoning("So the spreadsheet won that round. Does that happen with things you enjoy too?"),
  false
);
check(
  "natural 'I should'",
  looksLikeReasoning("I should say plainly: I can't diagnose you. What's your week like?"),
  false
);

// --- cost control -----------------------------------------------------------
group("cost control: pointless research calls are skipped");
const turns = (...texts) => texts.map((t) => ({ from: "user", text: t }));
check("first turn skipped", Boolean(skipResearchReason(turns("hi"), {})), true);
check("short message skipped", Boolean(skipResearchReason(turns("hello", "ok"), {})), true);
check(
  "substantive message researched",
  skipResearchReason(turns("I am 34 and struggling", "I lose track of long documents constantly"), {}),
  null
);
check(
  "cooldown respected",
  Boolean(
    skipResearchReason(
      turns("aaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbb", "cccccccccccccccccccccccccccc"),
      { lastResearchTurn: 2 }
    )
  ),
  true
);

// --- task routing -----------------------------------------------------------
group("scout: requests route to the right task");
check("clinician", classifyTask("find me a good clinician"), "clinicians");
check("clinician (diagnose)", classifyTask("who can diagnose me in Vancouver"), "clinicians");
check("deals", classifyTask("how much does EndeavorOTC cost"), "deals");
check("deals (insurance)", classifyTask("is it covered by insurance"), "deals");
check("games", classifyTask("what other attention games are there"), "games");


// --- fallback resilience ----------------------------------------------------
group("fallback: free routing is dynamic and conversation-first");
const freeCfg = {
  doctor: { provider: "openrouter", model: "anthropic/claude-sonnet-4" },
  scout: { provider: "openrouter", model: "openrouter/free" },
  keys: { openrouter: "test-key" },
  fallback: { auto: true, allowPaid: false },
  customBaseUrl: "",
};
check("OpenRouter free router recognized", isFreeModel("openrouter", "openrouter/free"), true);
check("Scout is constrained-free", isConstrainedFree(freeCfg, "scout"), true);
check(
  "paid current falls back to dynamic free router",
  fallbackSequence(freeCfg, "doctor").slice(0, 2).map((c) => c.model),
  ["anthropic/claude-sonnet-4", "openrouter/free"]
);

const freeDecision = await shouldResearch(
  turns("I am 34 and struggling", "I lose track of long documents constantly"),
  { config: freeCfg }
);
check("free mode skips decision-model call for ordinary conversation", freeDecision.search, false);
const freeResearchDecision = await shouldResearch(
  turns("I am 34 and struggling", "How much does EndeavorOTC cost and is insurance likely to cover it?"),
  { config: freeCfg }
);
check("free mode still catches explicit research intent", freeResearchDecision.task, "deals");
const repeatedFreeResearch = await shouldResearch(
  turns("I am 34 and struggling", "Is EndeavorOTC covered by insurance and what does it cost?"),
  { config: freeCfg }
);
check("free mode remembers near-duplicate research", repeatedFreeResearch.search, false);

const multiProviderCfg = {
  doctor: { provider: "openrouter", model: "openrouter/free" },
  scout: { provider: "openrouter", model: "openrouter/free" },
  keys: { openrouter: "or", groq: "g", gemini: "gm" },
  fallback: { auto: true, allowPaid: false },
  customBaseUrl: "http://should-only-apply-to-custom/v1",
};
const multiModels = fallbackSequence(multiProviderCfg, "doctor").map((c) => `${c.provider}:${c.model}`);
check("Groq fallback uses current GPT-OSS route", multiModels.includes("groq:openai/gpt-oss-120b"), true);
check("retired Groq 70B route removed", multiModels.some((m) => m.includes("llama-3.3-70b-versatile")), false);
check("Gemini fallback remains available", multiModels.includes("gemini:gemini-2.5-flash"), true);
check("non-custom calls ignore custom base URL", agentCall(multiProviderCfg, "doctor").baseUrl, "");
check("Groq registry primary matches current fallback", getProvider("groq").freeModel, "openai/gpt-oss-120b");

// --- OAuth sign-in gate -------------------------------------------------------
// The flow itself needs a browser + OpenRouter, but the invariants that break
// silently in a refactor are all checkable from the source: the gate exists,
// PKCE is S256, the callback is computed at runtime (Codespaces hostnames
// differ per codespace), and the key-info proxy route is registered.
group("oauth: sign-in gate wiring");
{
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const server = readFileSync(new URL("../server/index.js", import.meta.url), "utf8");

  check("gate overlay exists", html.includes('id="gate"'), true);
  check("gate has an escape hatch to manual keys", html.includes('id="gateManual"'), true);
  check("auth URL targets openrouter.ai/auth", html.includes("https://openrouter.ai/auth?callback_url="), true);
  check("PKCE uses S256", html.includes("code_challenge_method=S256"), true);
  check("code exchange hits /api/v1/auth/keys", html.includes("https://openrouter.ai/api/v1/auth/keys"), true);
  check("callback computed at runtime, not hardcoded", html.includes("location.origin + location.pathname"), true);
  check("no hardcoded codespace hostname", html.includes("app.github.dev"), false);
  check("verifier survives the redirect via sessionStorage", html.includes("focusroom.oauth.verifier"), true);
  check("dead OAuth keys reopen the gate", html.includes("own?.via === \"oauth\" && msg.needsKey"), true);
  check("key-info proxy route registered", server.includes("/api/openrouter/key-info"), true);
  check("key-info proxy queries the key endpoint", server.includes("https://openrouter.ai/api/v1/key"), true);
}

// --- result -----------------------------------------------------------------
console.log(`\n${count - failures}/${count} checks passed`);
process.exit(failures ? 1 : 0);
