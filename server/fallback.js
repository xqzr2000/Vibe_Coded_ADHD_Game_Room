// Automatic provider/model fallback with circuit breaking.
//
// The foreground conversation gets priority. A failed route is cooled down
// instead of being hammered on every turn, OpenRouter's dynamic free router is
// preferred over stale hard-coded :free IDs, and live model discovery remains
// the last-resort escape hatch.

import { chat, listModels, LlmError } from "./llm.js";
import { getProvider, PROVIDERS } from "./providers.js";
import { agentCall, resolveKey, savePrefs } from "./config.js";

const FALLBACK_KINDS = new Set([
  "out_of_credits",
  "bad_key",
  "rate_limited",
  "bad_model",
  "network",
  "empty_response",
  "unknown",
]);

const STICKY_DEAD = new Set(["out_of_credits", "bad_key"]);
const COOLDOWN_MS = {
  rate_limited: 60_000,
  bad_model: 6 * 60 * 60 * 1000,
  network: 20_000,
  empty_response: 20_000,
  unknown: 30_000,
};

export function shouldFallback(err) {
  if (!(err instanceof LlmError)) return false;
  if (err.kind === "no_key") return true;
  if (err.status && [400, 422].includes(err.status)) return false;
  return FALLBACK_KINDS.has(err.kind);
}

export function isFreeModel(providerId, model) {
  const m = String(model || "");
  if (providerId === "openrouter") return m === "openrouter/free" || m.endsWith(":free");
  const p = getProvider(providerId);
  return m === p.freeModel || (p.freeModels || []).includes(m);
}

export function isConstrainedFree(config, agentId) {
  const call = agentCall(config, agentId);
  return config?.fallback?.allowPaid !== true && isFreeModel(call.provider, call.model);
}

function candidateKey(c) {
  return `${c.provider}::${c.model}`;
}

function cooldowns(config) {
  if (!(config._cooldowns instanceof Map)) config._cooldowns = new Map();
  return config._cooldowns;
}

function isBlocked(config, key) {
  if (config._dead?.has(key)) return true;
  const map = cooldowns(config);
  const until = map.get(key) || 0;
  if (until && until <= Date.now()) {
    map.delete(key);
    return false;
  }
  return until > Date.now();
}

function markFailed(config, candidate, err) {
  const key = candidateKey(candidate);
  config._lastFallbackError = err;

  if (STICKY_DEAD.has(err?.kind)) {
    config._dead = config._dead || new Set();
    config._dead.add(key);
    return;
  }

  const base = COOLDOWN_MS[err?.kind] || 0;
  const requested = Number(err?.retryAfterMs || 0);
  const wait = Math.max(base, requested);
  if (wait > 0) cooldowns(config).set(key, Date.now() + Math.min(wait, 6 * 60 * 60 * 1000));
}

function asCandidate(config, providerId, model, { paid = false, isCurrent = false } = {}) {
  const p = getProvider(providerId);
  return {
    provider: providerId,
    model,
    apiKey: resolveKey(config, providerId),
    baseUrl: config.customBaseUrl || "",
    label: `${p.label} · ${model}`,
    free: !paid,
    isCurrent,
  };
}

/** Build the ordered list of immediately usable routes for one agent. */
export function fallbackSequence(config, agentId) {
  const current = agentCall(config, agentId);
  const settings = config.fallback || {};
  const auto = settings.auto !== false;
  const allowPaid = settings.allowPaid === true;
  const seq = [];
  const seen = new Set();

  const push = (providerId, model, { paid = false, isCurrent = false, ignoreBlock = false } = {}) => {
    if (!model) return;
    const key = `${providerId}::${model}`;
    if (seen.has(key)) return;
    if (!resolveKey(config, providerId)) return;
    if (paid && !allowPaid && !isCurrent) return;
    if (!ignoreBlock && isBlocked(config, key)) return;
    seen.add(key);
    seq.push(asCandidate(config, providerId, model, { paid, isCurrent }));
  };

  // When automatic fallback is disabled, honor the user's choice exactly.
  if (!auto) {
    push(current.provider, current.model, {
      paid: !isFreeModel(current.provider, current.model),
      isCurrent: true,
      ignoreBlock: true,
    });
    return seq;
  }

  // 0. Current route, unless its circuit is open from a recent failure.
  push(current.provider, current.model, {
    paid: !isFreeModel(current.provider, current.model),
    isCurrent: true,
  });

  // 1. Same-provider free route. For OpenRouter this is intentionally just
  //    openrouter/free: OpenRouter itself dynamically selects a compatible
  //    free model, which is more durable than shipping model IDs that churn.
  for (const m of getProvider(current.provider).freeModels || []) push(current.provider, m);

  // 2. Free options on other providers that already have a key.
  for (const p of Object.values(PROVIDERS)) {
    if (p.id === current.provider || p.id === "custom") continue;
    for (const m of p.freeModels || []) push(p.id, m);
  }

  // 3. Custom endpoint only when paid fallback is explicitly allowed; we
  //    cannot infer whether a custom endpoint costs money.
  const customModel =
    config.doctor?.provider === "custom"
      ? config.doctor.model
      : config.scout?.provider === "custom"
        ? config.scout.model
        : null;
  if (config.customBaseUrl && customModel) push("custom", customModel, { paid: true });

  return seq;
}

function rotate(items, offset) {
  if (!items.length) return items;
  const n = ((offset % items.length) + items.length) % items.length;
  return items.slice(n).concat(items.slice(0, n));
}

// Ask live provider catalogues for replacements. Discovery prefers models that
// advertise response-format support (useful for Scout) and larger contexts,
// then rotates the starting point so many sessions do not all dog-pile the
// same first free model.
async function discover(config, agentId, seq, skipProviders = new Set()) {
  const tried = new Set(seq.map(candidateKey));
  const out = [];
  config._rotationCursor = config._rotationCursor || {};

  for (const provider of Object.values(PROVIDERS)) {
    const providerId = provider.id;
    if (providerId === "custom" || skipProviders.has(providerId)) continue;
    const apiKey = resolveKey(config, providerId);
    if (!apiKey) continue;

    try {
      let models = await listModels({
        provider: providerId,
        apiKey,
        baseUrl: config.customBaseUrl || "",
        freeOnly: true,
      });

      models = models
        .filter((m) => m?.id && !isBlocked(config, `${providerId}::${m.id}`))
        .sort((a, b) => {
          const aJson = a.supportedParameters?.includes("response_format") ? 1 : 0;
          const bJson = b.supportedParameters?.includes("response_format") ? 1 : 0;
          if (aJson !== bJson) return bJson - aJson;
          return Number(b.context || 0) - Number(a.context || 0);
        });

      const cursor = config._rotationCursor[providerId] || 0;
      config._rotationCursor[providerId] = cursor + 1;
      models = rotate(models.slice(0, 12), cursor);

      for (const m of models.slice(0, 4)) {
        const key = `${providerId}::${m.id}`;
        if (tried.has(key)) continue;
        tried.add(key);
        out.push(asCandidate(config, providerId, m.id, { paid: false }));
      }
    } catch {
      // Discovery is an escape hatch. A catalogue failure should never mask the
      // original model error.
    }
  }
  return out;
}

/** Call an agent model, walking known routes and then live discovery. */
export async function agentChat(config, agentId, options = {}) {
  let seq = fallbackSequence(config, agentId);
  let lastErr = config._lastFallbackError || null;
  let discovered = false;
  const hardFailedProviders = new Set();

  // If every known route is cooling down, go directly to live discovery
  // instead of probing a route we already know just failed.
  if (!seq.length && config.fallback?.auto !== false) {
    seq = await discover(config, agentId, [], hardFailedProviders);
    discovered = true;
  }

  for (let i = 0; i < seq.length; i += 1) {
    const candidate = seq[i];
    try {
      const result = await chat({
        provider: candidate.provider,
        model: candidate.model,
        apiKey: candidate.apiKey,
        baseUrl: candidate.baseUrl,
        ...options,
      });

      const configured = agentCall(config, agentId);
      if (configured.provider !== candidate.provider || configured.model !== candidate.model) {
        promote(config, agentId, candidate, lastErr);
      }
      return result;
    } catch (err) {
      lastErr = err;
      markFailed(config, candidate, err);
      if (!shouldFallback(err)) throw err;

      // A free route hitting a key/credit/rate wall usually means trying more
      // models on that same provider in this same turn only burns requests.
      if (
        err?.kind === "bad_key" ||
        (candidate.free && err?.kind === "out_of_credits") ||
        (err?.kind === "rate_limited" && err?.providerWide === true)
      ) {
        hardFailedProviders.add(candidate.provider);
      }

      if (i === seq.length - 1 && !discovered && config.fallback?.auto !== false) {
        discovered = true;
        const extra = await discover(config, agentId, seq, hardFailedProviders);
        if (extra.length) seq = seq.concat(extra);
      }

      if (i >= seq.length - 1) throw err;

      config.onFallbackAttempt?.({
        agentId,
        from: candidate.label,
        to: seq[i + 1].label,
        kind: err.kind,
      });
    }
  }

  if (!lastErr) {
    const current = agentCall(config, agentId);
    const anyKey = Object.values(PROVIDERS).some((p) => p.id !== "custom" && resolveKey(config, p.id));
    if (!anyKey && !resolveKey(config, current.provider)) {
      throw new LlmError("No AI provider key is available for this session.", {
        kind: "no_key",
        provider: current.provider,
        providerWide: true,
        hint: "Add an OpenRouter, Groq, or Gemini key in Settings. Backup keys let free-tier fallback cross providers.",
      });
    }
  }

  throw (
    lastErr ||
    new LlmError("All configured model routes are temporarily unavailable.", {
      kind: "rate_limited",
      hint: "The failed routes are cooling down; try the next message shortly or add another provider key.",
    })
  );
}

function promote(config, agentId, candidate, err) {
  config[agentId] = { provider: candidate.provider, model: candidate.model };
  savePrefs(config);
  config.onSwitch?.({
    agentId,
    provider: candidate.provider,
    model: candidate.model,
    label: candidate.label,
    reason: err?.kind || "unknown",
    reasonText: err?.message || "",
    free: candidate.free,
  });
}
