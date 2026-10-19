// Free-model fallback for Groq.
//
// Each agent walks an ordered chain of FREE models (server/models.js). Before a
// call, the quota tracker is asked whether that model has headroom; a model
// that is cooling down or nearly out of per-minute tokens is skipped rather
// than hit. A failure cools that model down and the next one is tried. If
// every model is briefly busy, a short wait beats failing the turn — but the
// foreground conversation waits far less than background research.

import { chat, LlmError } from "./llm.js";
import { chainFor, isRetired, modelInfo } from "./models.js";
import { resolveKey } from "./config.js";
import { headroom, recordFailure, clearFailure } from "./quota.js";
import { fitMessages, inputBudget, messagesTokens } from "./context.js";

const STOP_KINDS = new Set(["no_key", "bad_key", "not_free"]);
const COOLDOWN_KINDS = new Set(["rate_limited", "bad_model", "network", "empty_response", "tool_failed", "unknown"]);

export function shouldFallback(err) {
  return err instanceof LlmError && !STOP_KINDS.has(err.kind);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The models an agent would try, in order, given what it needs. */
export function usableChain(config, agentId, requires) {
  return chainFor(agentId, config?.models?.[agentId]).filter((id) => {
    if (isRetired(id)) return false;
    const info = modelInfo(id);
    if (requires === "tools") return info?.tools;
    if (requires === "browserSearch") return info?.browserSearch;
    return true;
  });
}

/**
 * Call an agent's model with automatic free-model fallback.
 * Accepts every option chat() does, plus:
 *   requires:   "tools" | "browserSearch" — only models that support it
 *   maxWaitMs:  how long to wait for a busy model before giving up
 *   onAttempt:  ({ model, retry }) => void — fires before each try (UI resets a stream)
 * Returns chat()'s result plus { model }.
 */
export async function agentChat(config, agentId, options = {}) {
  const apiKey = resolveKey(config, "groq");
  if (!apiKey) {
    throw new LlmError("No Groq API key is available for this session.", {
      kind: "no_key",
      hint: "Paste your Groq key in Settings (free at console.groq.com/keys).",
    });
  }

  const chain = usableChain(config, agentId, options.requires);
  if (!chain.length) {
    throw new LlmError(`No free Groq model on the list supports ${options.requires || "this request"}.`, {
      kind: "bad_model",
    });
  }

  const maxTokens = options.maxTokens ?? 1024;
  const budget = inputBudget(maxTokens);
  const fitted = fitMessages(options.messages || [], budget).messages;
  const estimate = messagesTokens(fitted) + Math.round(maxTokens * 0.5);
  const maxWait = options.maxWaitMs ?? (agentId === "doctor" ? 2500 : 12_000);

  const tried = new Set();
  let lastErr = null;
  let previous = null;

  for (let pass = 0; pass < 3; pass += 1) {
    for (const model of chain) {
      if (tried.has(model)) continue;
      if (!headroom(apiKey, model, estimate).ok) continue;
      tried.add(model);

      if (previous) {
        config.onFallbackAttempt?.({ agentId, from: previous, to: model, kind: lastErr?.kind || "busy" });
      }
      try {
        const result = await attempt(config, agentId, model, apiKey, fitted, budget, options);
        clearFailure(apiKey, model);
        noteActive(config, agentId, model, lastErr);
        config.onQuota?.();
        return { ...result, model };
      } catch (err) {
        lastErr = err;
        config.onQuota?.();
        if (!shouldFallback(err)) throw err;
        if (COOLDOWN_KINDS.has(err.kind)) recordFailure(apiKey, model, err);
        previous = model;
      }
    }

    // Nothing usable right now. If some untried model frees up soon, wait for it.
    const waits = chain
      .filter((m) => !tried.has(m))
      .map((m) => headroom(apiKey, m, estimate))
      .filter((r) => !r.ok)
      .map((r) => r.waitMs);
    const soonest = waits.length ? Math.min(...waits) : null;
    if (soonest == null || soonest > maxWait) {
      throw (
        lastErr ||
        new LlmError("Every free Groq model is busy for a moment.", {
          kind: "rate_limited",
          retryAfterMs: soonest || 20_000,
          hint: "Free-tier limits refill every minute — try again shortly.",
        })
      );
    }
    config.onWait?.({ agentId, ms: soonest });
    await sleep(soonest + 150);
  }
  throw lastErr || new LlmError("Every free Groq model is busy for a moment.", { kind: "rate_limited" });
}

async function attempt(config, agentId, model, apiKey, fitted, budget, options) {
  const { requires, maxWaitMs, onAttempt, ...chatOptions } = options;
  onAttempt?.({ model, retry: false });
  try {
    return await chat({ ...chatOptions, messages: fitted, model, apiKey });
  } catch (err) {
    if (err?.kind !== "too_large") throw err;
    // Same model, smaller prompt: the limit is per minute, not per model.
    const smaller = fitMessages(options.messages || [], Math.floor(budget * 0.55)).messages;
    onAttempt?.({ model, retry: true });
    return chat({ ...chatOptions, messages: smaller, model, apiKey });
  }
}

function noteActive(config, agentId, model, err) {
  config._active = config._active || {};
  const before = config._active[agentId];
  config._active[agentId] = model;
  if (before !== model) {
    config.onActive?.({
      agentId,
      model,
      label: modelInfo(model)?.label || model,
      preferred: config.models?.[agentId] === model,
      reason: err?.kind || null,
    });
  }
}

/** Convenience for callers that only want the text. */
export async function agentText(config, agentId, options) {
  return (await agentChat(config, agentId, options)).content;
}
