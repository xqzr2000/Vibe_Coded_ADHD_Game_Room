// Settings-panel checks: "is my key good, can I reach Groq, what quota is
// left, and does search work?" — answered with real requests, not guesses.
// Keys are used for the request and discarded; never logged or stored.

import { GROQ, FREE_MODELS, noteLiveModels, publicModelList } from "./models.js";
import { listModels, chat, LlmError } from "./llm.js";
import { snapshot, planGuess } from "./quota.js";
import { tavilySearch } from "./search/tavily.js";
import { tavilyUsageCached } from "./search/index.js";
import { planExhausted } from "./search/tavily.js";

export const mask = (key) => {
  const k = String(key || "");
  return k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : k ? `${k.slice(0, 3)}…` : "";
};

/**
 * Groq key test. The model list costs nothing; `probe: true` additionally
 * sends one tiny request so the quota numbers are fresh (costs 1 request).
 */
export async function testGroqKey(apiKey, { probe = false } = {}) {
  const key = String(apiKey || "").trim();
  if (!key) return { ok: false, kind: "no_key", error: "No Groq key to test." };
  const started = Date.now();
  let live;
  try {
    live = await listModels(key);
  } catch (err) {
    return {
      ok: false,
      kind: err.kind || "unknown",
      error: err.message,
      hint: err.kind === "bad_key" ? `Create a new key at ${GROQ.keyUrl} and paste it again.` : err.hint || "",
    };
  }
  const latencyMs = Date.now() - started;
  noteLiveModels(live);
  const models = publicModelList();

  let probeResult = null;
  if (probe) {
    const target = models.find((m) => !m.retired)?.id;
    if (target) {
      try {
        await chat({
          model: target,
          apiKey: key,
          messages: [{ role: "user", content: "Reply with the single word: ok" }],
          maxTokens: 40,
          temperature: 0,
          allowEmpty: true,
        });
        probeResult = { model: target, ok: true };
      } catch (err) {
        probeResult = { model: target, ok: false, kind: err instanceof LlmError ? err.kind : "unknown", error: err.message };
      }
    }
  }

  const ids = FREE_MODELS.map((m) => m.id);
  return {
    ok: true,
    masked: mask(key),
    latencyMs,
    models,
    usable: models.filter((m) => !m.retired).length,
    quota: snapshot(key, ids),
    plan: planGuess(key, ids),
    probe: probeResult,
  };
}

/** Tavily key test: plan/usage (free), plus one basic search (1 credit) if asked. */
export async function testTavilyKey(apiKey, { search = false } = {}) {
  const key = String(apiKey || "").trim();
  if (!key) return { ok: false, kind: "no_key", error: "No Tavily key to test." };
  const out = { ok: false, masked: mask(key) };
  try {
    const usage = await tavilyUsageCached(key, { force: true });
    out.ok = true;
    out.usage = usage;
    out.exhausted = planExhausted(usage);
    out.paygo = (usage.paygoLimit || 0) > 0;
  } catch (err) {
    if (err.kind === "bad_key") return { ok: false, kind: "bad_key", error: err.message, masked: out.masked };
    out.usageError = err.message; // usage endpoint optional; the search below decides
  }
  if (search || !out.ok) {
    const started = Date.now();
    try {
      const r = await tavilySearch("ADHD attention training digital therapeutic", { apiKey: key, maxResults: 3 });
      out.ok = true;
      out.search = { latencyMs: Date.now() - started, results: r.results.map((x) => ({ title: x.title, url: x.url })), credits: r.credits };
    } catch (err) {
      return { ...out, ok: false, kind: err.kind || "unknown", error: err.message };
    }
  }
  return out;
}
