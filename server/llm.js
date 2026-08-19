// Unified chat client. Every provider in the registry speaks the OpenAI
// chat-completions shape, so this one function serves all of them.
//
// The important extra job here is error CLASSIFICATION: when a key is dead or
// credits run out, the UI needs to know *which* it was so it can offer the
// right one-click fix instead of a raw HTTP error.

import { getProvider } from "./providers.js";

export class LlmError extends Error {
  constructor(message, { kind = "unknown", provider, status, hint, retryAfterMs = 0, providerWide = false } = {}) {
    super(message);
    this.kind = kind; // no_key | bad_key | out_of_credits | rate_limited | bad_model | network | unknown
    this.provider = provider;
    this.status = status;
    this.hint = hint;
    this.retryAfterMs = retryAfterMs || 0;
    this.providerWide = providerWide === true;
  }
}

function retryAfterMs(headers) {
  const raw = headers?.get?.("retry-after");
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

function classify(status, body, providerId, headers) {
  const provider = getProvider(providerId);
  const label = provider.label;
  const text = String(body || "").slice(0, 600);
  const lower = text.toLowerCase();
  const retry = retryAfterMs(headers);
  let metadata = {};
  try { metadata = JSON.parse(text)?.error?.metadata || {}; } catch { /* plain-text error */ }

  if (status === 401 || status === 403) {
    return new LlmError(`That ${label} API key was rejected.`, {
      kind: "bad_key", provider: providerId, status, providerWide: true,
      hint: "Check the key, or paste a new one in Settings.",
    });
  }
  if (status === 402 || lower.includes("insufficient") || lower.includes("credit")) {
    return new LlmError(`Your ${label} credits are used up.`, {
      kind: "out_of_credits", provider: providerId, status, providerWide: true,
      hint: providerId === "openrouter"
        ? "Focus Room will try OpenRouter's free router and any other keyed provider automatically."
        : "Focus Room will try another configured free provider automatically.",
    });
  }
  if (status === 429 || lower.includes("rate limit") || lower.includes("quota")) {
    // OpenRouter distinguishes its own account/platform limits from an
    // upstream provider being full: upstream errors carry metadata.provider_code.
    // Only the former should suppress every OpenRouter candidate for this turn.
    const upstreamOpenRouterLimit = providerId === "openrouter" && metadata?.provider_code != null;
    return new LlmError(`${label} is rate limiting this key right now.`, {
      kind: "rate_limited", provider: providerId, status, retryAfterMs: retry,
      providerWide: !upstreamOpenRouterLimit,
      hint: upstreamOpenRouterLimit
        ? "That upstream route is busy; Focus Room will rotate to another candidate."
        : "Focus Room will cool this provider down instead of burning more requests against the same quota.",
    });
  }
  if (status === 404 || (lower.includes("model") && lower.includes("not found"))) {
    return new LlmError(`That model isn't available on ${label}.`, {
      kind: "bad_model", provider: providerId, status,
      hint: "The model will be sidelined and live model discovery will look for a replacement.",
    });
  }
  if ([408, 500, 502, 503, 504].includes(status)) {
    return new LlmError(`${label} is temporarily unavailable (${status}).`, {
      kind: "network", provider: providerId, status, retryAfterMs: retry,
      hint: "Focus Room will try another route and retry this one after a short cooldown.",
    });
  }
  return new LlmError(`${label} error ${status}: ${text.slice(0, 200)}`, {
    kind: "unknown", provider: providerId, status, retryAfterMs: retry,
  });
}

// Reasoning models often emit their scratchpad in the message content — as
// <think> blocks, or as a "Thought:" preamble. Users should never see it.
export function stripReasoning(text) {
  let out = String(text || "");

  // Paired tags, including an unclosed opener (truncated output).
  out = out.replace(/<(think|thinking|reasoning|scratchpad|analysis)>[\s\S]*?<\/\1>/gi, " ");
  out = out.replace(/<(think|thinking|reasoning|scratchpad|analysis)>[\s\S]*$/i, " ");
  // Some models close without opening after the API strips the opener.
  out = out.replace(/^[\s\S]*?<\/(think|thinking|reasoning|scratchpad|analysis)>/i, " ");
  // Labelled preambles.
  out = out.replace(/^\s*(thought|reasoning|analysis|scratchpad)\s*:\s*[\s\S]*?\n\s*(final answer|answer|response|reply)\s*:\s*/i, "");

  return out.trim();
}

export async function chat({
  provider: providerId = "openrouter",
  model,
  apiKey,
  baseUrl, // only for the "custom" provider
  messages,
  online = false,
  json = false,
  temperature = 0.7,
  maxTokens = 1400,
}) {
  const provider = getProvider(providerId);
  const root = (providerId === "custom" ? baseUrl : provider.baseUrl) || "";

  if (!root) {
    throw new LlmError("No base URL set for the custom provider.", {
      kind: "no_key",
      provider: providerId,
      hint: "Add the endpoint URL in Settings.",
    });
  }
  if (!apiKey) {
    throw new LlmError(`No ${provider.label} API key yet.`, {
      kind: "no_key",
      provider: providerId,
      hint: `Add one in Settings${provider.keyUrl ? ` — get a key at ${provider.keyUrl}` : ""}.`,
    });
  }

  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  // OpenRouter deprecated the :online model suffix. The current API exposes
  // web search as a server tool; cap it tightly so one Scout pass cannot fan
  // out into a pile of paid searches. Other providers ignore `online`.
  if (online && providerId === "openrouter" && provider.supportsOnline) {
    body.tools = [
      {
        type: "openrouter:web_search",
        parameters: { max_results: 5, max_total_results: 8, search_context_size: "medium" },
      },
    ];
    body.max_tool_calls = 2;
  }
  if (json) body.response_format = { type: "json_object" };
  // OpenRouter-specific: don't bill or return reasoning tokens we won't show.
  if (providerId === "openrouter") body.reasoning = { exclude: true };

  const post = (payload) =>
    fetch(`${root.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // OpenRouter uses these for attribution; harmless elsewhere.
        "HTTP-Referer": "https://github.com/your-org/focus-room",
        "X-Title": "Focus Room",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120000),
    });

  let res;
  try {
    res = await post(body);

    // Plenty of smaller/free models reject response_format outright with a 400.
    // The prompts already demand JSON-only output, so drop the parameter and
    // try once more rather than failing the whole turn.
    if (res.status === 400 && body.response_format) {
      const text = await res.text().catch(() => "");
      if (/response_format|json_object|not supported|unsupported/i.test(text)) {
        const { response_format, ...withoutFormat } = body;
        res = await post(withoutFormat);
      } else {
        throw classify(400, text, providerId, res.headers);
      }
    }
  } catch (err) {
    if (err instanceof LlmError) throw err;
    throw new LlmError(`Couldn't reach ${provider.label}: ${err.message}`, {
      kind: "network",
      provider: providerId,
    });
  }

  if (!res.ok) throw classify(res.status, await res.text().catch(() => ""), providerId, res.headers);

  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content;
  const content = typeof raw === "string" ? stripReasoning(raw) : raw;
  if (typeof content !== "string" || !content.trim()) {
    throw new LlmError(`${provider.label} returned an empty response.`, {
      kind: "empty_response",
      provider: providerId,
      hint: "That route returned no usable text; Focus Room will try another model automatically.",
    });
  }
  return content.trim();
}

// Fetch a provider's model catalogue so the UI can offer a live list.
export async function listModels({ provider: providerId, apiKey, baseUrl, freeOnly = false }) {
  const provider = getProvider(providerId);
  const root = (providerId === "custom" ? baseUrl : provider.baseUrl) || "";
  if (!root) throw new LlmError("No base URL for this provider.", { kind: "no_key" });
  if (provider.modelsNeedKey && !apiKey) {
    throw new LlmError(`A ${provider.label} key is needed to list models.`, {
      kind: "no_key",
      provider: providerId,
    });
  }

  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const res = await fetch(`${root.replace(/\/$/, "")}${provider.modelsPath}`, {
    headers,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw classify(res.status, await res.text().catch(() => ""), providerId, res.headers);

  const data = await res.json();
  const raw = Array.isArray(data?.data) ? data.data : [];

  let models = raw.map((m) => {
    const promptPrice = Number(m?.pricing?.prompt ?? NaN);
    const completionPrice = Number(m?.pricing?.completion ?? NaN);
    const free =
      String(m.id || "").endsWith(":free") ||
      (Number.isFinite(promptPrice) && promptPrice === 0 && Number.isFinite(completionPrice) && completionPrice === 0);
    return {
      id: m.id,
      name: m.name || m.id,
      free,
      context: m.context_length || null,
      supportedParameters: Array.isArray(m.supported_parameters) ? m.supported_parameters : [],
    };
  });

  if (freeOnly) models = models.filter((m) => m.free);
  models.sort((a, b) => (a.free === b.free ? a.id.localeCompare(b.id) : a.free ? -1 : 1));
  return models;
}

export function parseJson(text) {
  const cleaned = text.replace(/^```(?:json)?/im, "").replace(/```\s*$/m, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found in model output.");
  return JSON.parse(cleaned.slice(start, end + 1));
}
