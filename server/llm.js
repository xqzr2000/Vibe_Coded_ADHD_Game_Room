// Groq chat client (OpenAI-compatible /chat/completions).
//
// Three jobs beyond "send a request":
//   1. Refuse anything that is not on the free allowlist (server/models.js).
//   2. Stream: content and reasoning arrive token by token through onDelta, so
//      the UI can show work in progress instead of a long silence.
//   3. Classify failures, so the fallback engine knows whether to try another
//      model, wait, trim the prompt, or stop and ask for a key.

import { GROQ, isFreeModel, modelInfo } from "./models.js";
import { recordHeaders } from "./quota.js";

export class LlmError extends Error {
  constructor(message, { kind = "unknown", status, hint, retryAfterMs = 0, model } = {}) {
    super(message);
    // no_key | bad_key | not_free | rate_limited | too_large | bad_model |
    // tool_failed | bad_output | network | empty_response | unknown
    this.kind = kind;
    this.status = status;
    this.hint = hint;
    this.retryAfterMs = retryAfterMs || 0;
    this.model = model;
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

export function classify(status, body, headers, model) {
  const text = String(body || "").slice(0, 800);
  const lower = text.toLowerCase();
  let code = "";
  try {
    const parsed = JSON.parse(text)?.error || {};
    code = String(parsed.code || parsed.type || "");
  } catch {
    /* plain-text error */
  }
  const retry = retryAfterMs(headers);
  const opts = (kind, extra = {}) => ({ kind, status, retryAfterMs: retry, model, ...extra });

  if (status === 401 || status === 403 || code === "invalid_api_key") {
    return new LlmError("Groq rejected this API key.", opts("bad_key", {
      hint: `Check the key in Settings, or create a new one at ${GROQ.keyUrl}.`,
    }));
  }
  if (status === 413 || code === "request_too_large" || /request too large/.test(lower)) {
    return new LlmError(`That request is too large for ${model}'s per-minute token limit.`, opts("too_large", {
      hint: "Focus Room trims older conversation and retries.",
    }));
  }
  if (status === 429 || code === "rate_limit_exceeded" || /rate limit/.test(lower)) {
    const daily = /per day|\(rpd\)|\(tpd\)/.test(lower);
    return new LlmError(`${model} hit its ${daily ? "daily" : "per-minute"} free-tier limit.`, opts("rate_limited", {
      retryAfterMs: retry || (daily ? 15 * 60_000 : 20_000),
      hint: "Focus Room moves to another free model while this one recovers.",
    }));
  }
  if (status === 404 || code === "model_not_found" || code === "model_decommissioned" || /decommission|does not exist/.test(lower)) {
    return new LlmError(`${model} isn't available on Groq any more.`, opts("bad_model", {
      hint: "Update FREE_MODELS in server/models.js (or GROQ_FREE_MODELS) from Groq's rate-limits page.",
    }));
  }
  if (code === "tool_use_failed" || /tool_use_failed|failed to call a function/.test(lower)) {
    return new LlmError(`${model} produced a malformed tool call.`, opts("tool_failed"));
  }
  if (code === "json_validate_failed" || /json_validate_failed|failed to generate json/.test(lower)) {
    return new LlmError(`${model} produced invalid JSON.`, opts("bad_output"));
  }
  if ([408, 500, 502, 503, 504, 498].includes(status)) {
    return new LlmError(`Groq is temporarily unavailable (${status}).`, opts("network"));
  }
  return new LlmError(`Groq error ${status}: ${text.slice(0, 200)}`, opts("unknown"));
}

// Some models put their scratchpad in the content — as <think> blocks or a
// "Thought:" preamble. That must never reach the chat.
export function stripReasoning(text) {
  let out = String(text || "");
  out = out.replace(/<(think|thinking|reasoning|scratchpad|analysis)>[\s\S]*?<\/\1>/gi, " ");
  out = out.replace(/<(think|thinking|reasoning|scratchpad|analysis)>[\s\S]*$/i, " ");
  out = out.replace(/^[\s\S]*?<\/(think|thinking|reasoning|scratchpad|analysis)>/i, " ");
  out = out.replace(/^\s*(thought|reasoning|analysis|scratchpad)\s*:\s*[\s\S]*?\n\s*(final answer|answer|response|reply)\s*:\s*/i, "");
  return out.trim();
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

// Streaming filter: holds back anything inside <think>…</think> that a model
// writes into the content channel, so it never flashes up in the bubble.
function thinkFilter() {
  let inside = false;
  let carry = "";
  return (chunk) => {
    let s = carry + chunk;
    carry = "";
    let out = "";
    while (s) {
      if (inside) {
        const end = s.search(/<\/(think|thinking|reasoning)>/i);
        if (end === -1) return out;
        s = s.slice(s.indexOf(">", end) + 1);
        inside = false;
      } else {
        const start = s.search(/<(think|thinking|reasoning)>/i);
        if (start === -1) {
          // Keep a possible partial tag for the next chunk.
          const lt = s.lastIndexOf("<");
          if (lt !== -1 && s.length - lt < 12) {
            carry = s.slice(lt);
            return out + s.slice(0, lt);
          }
          return out + s;
        }
        out += s.slice(0, start);
        s = s.slice(s.indexOf(">", start) + 1);
        inside = true;
      }
    }
    return out;
  };
}

function reasoningParams(model, { reasoning, reasoningEffort }) {
  const family = modelInfo(model)?.reasoning || "none";
  const show = reasoning === "show";
  if (family === "gpt-oss") {
    // GPT-OSS always reasons; "low" keeps that cheap against the 8K TPM budget.
    return { include_reasoning: show, reasoning_effort: reasoningEffort || "low" };
  }
  if (family === "qwen") {
    // "raw" is rejected alongside JSON mode and tools, so only parsed/hidden.
    return show
      ? { reasoning_format: "parsed", reasoning_effort: reasoningEffort || "low" }
      : { reasoning_format: "hidden", reasoning_effort: "none" };
  }
  return {};
}

/**
 * One call to one model.
 *
 * @returns {Promise<{content: string, reasoning: string, toolCalls: Array, executedTools: Array, usage: object|null, finishReason: string}>}
 */
export async function chat({
  model,
  apiKey,
  messages,
  tools,
  toolChoice,
  json = false,
  temperature = 0.7,
  maxTokens = 1024,
  reasoning = "hide", // "show" streams/returns the model's reasoning
  reasoningEffort,
  stream = false,
  onDelta, // ({ type: "content" | "reasoning", text }) => void
  signal,
  timeoutMs = 90_000,
  allowEmpty = false,
}) {
  if (!isFreeModel(model)) {
    throw new LlmError(`${model || "That model"} is not on Focus Room's free-model list, so it was not called.`, {
      kind: "not_free",
      model,
    });
  }
  if (!apiKey) {
    throw new LlmError("No Groq API key yet.", {
      kind: "no_key",
      model,
      hint: `Paste one in Settings — get a free key at ${GROQ.keyUrl}.`,
    });
  }

  const body = {
    model,
    messages,
    temperature,
    max_completion_tokens: maxTokens,
    stream: Boolean(stream),
    ...reasoningParams(model, { reasoning, reasoningEffort }),
  };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = toolChoice || "auto";
  } else if (json) {
    body.response_format = { type: "json_object" };
  }

  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);

  let res;
  try {
    res = await fetch(`${GROQ.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    throw new LlmError(`Couldn't reach Groq: ${err.message}`, { kind: "network", model });
  }

  recordHeaders(apiKey, model, res.headers);

  if (!res.ok) throw classify(res.status, await res.text().catch(() => ""), res.headers, model);

  const result = stream ? await readStream(res, onDelta, model) : await readJson(res);

  result.content = stripReasoning(result.content);
  if (!result.content && !result.toolCalls.length && !allowEmpty) {
    throw new LlmError(`${model} returned an empty response.`, { kind: "empty_response", model });
  }
  return result;
}

async function readJson(res) {
  const data = await res.json();
  const msg = data?.choices?.[0]?.message || {};
  return {
    content: textFromContent(msg.content),
    reasoning: String(msg.reasoning || ""),
    toolCalls: (msg.tool_calls || []).map((t) => ({
      id: t.id,
      name: t.function?.name || "",
      arguments: t.function?.arguments || "",
    })),
    executedTools: Array.isArray(msg.executed_tools) ? msg.executed_tools : [],
    usage: data?.usage || null,
    finishReason: data?.choices?.[0]?.finish_reason || "",
  };
}

async function readStream(res, onDelta, model) {
  const decoder = new TextDecoder();
  const filter = thinkFilter();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let usage = null;
  let finishReason = "";
  const tools = new Map(); // index -> { id, name, arguments }
  let executedTools = [];

  const emit = (type, text) => {
    if (!text) return;
    try {
      onDelta?.({ type, text });
    } catch {
      /* a UI hiccup must never break the model call */
    }
  };

  const handle = (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let evt;
    try {
      evt = JSON.parse(payload);
    } catch {
      return;
    }
    if (evt.error) {
      const e = evt.error;
      throw classify(e.status_code || 500, JSON.stringify({ error: e }), null, model);
    }
    if (evt.x_groq?.usage) usage = evt.x_groq.usage;
    if (evt.usage) usage = evt.usage;
    const choice = evt.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const d = choice.delta || {};
    if (typeof d.reasoning === "string" && d.reasoning) {
      reasoning += d.reasoning;
      emit("reasoning", d.reasoning);
    }
    if (typeof d.content === "string" && d.content) {
      content += d.content;
      emit("content", filter(d.content));
    }
    for (const t of d.tool_calls || []) {
      const idx = t.index ?? tools.size;
      const cur = tools.get(idx) || { id: "", name: "", arguments: "" };
      if (t.id) cur.id = t.id;
      if (t.function?.name) cur.name += t.function.name;
      if (t.function?.arguments) cur.arguments += t.function.arguments;
      tools.set(idx, cur);
    }
    if (Array.isArray(d.executed_tools)) executedTools = executedTools.concat(d.executed_tools);
  };

  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        handle(line);
      }
    }
    if (buffer.trim()) handle(buffer.trim());
  } catch (err) {
    if (err instanceof LlmError) throw err;
    throw new LlmError(`The Groq stream broke off: ${err.message}`, { kind: "network", model });
  }

  return {
    content,
    reasoning,
    toolCalls: [...tools.values()].filter((t) => t.name),
    executedTools,
    usage,
    finishReason,
  };
}

/** Live model IDs for a key. Costs no tokens. */
export async function listModels(apiKey) {
  if (!apiKey) throw new LlmError("A Groq key is needed to list models.", { kind: "no_key" });
  let res;
  try {
    res = await fetch(`${GROQ.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new LlmError(`Couldn't reach Groq: ${err.message}`, { kind: "network" });
  }
  if (!res.ok) throw classify(res.status, await res.text().catch(() => ""), res.headers, "models");
  const data = await res.json();
  return (Array.isArray(data?.data) ? data.data : []).map((m) => m.id).filter(Boolean);
}

export function parseJson(text) {
  const cleaned = String(text || "").replace(/^```(?:json)?/im, "").replace(/```\s*$/m, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found in model output.");
  return JSON.parse(cleaned.slice(start, end + 1));
}
