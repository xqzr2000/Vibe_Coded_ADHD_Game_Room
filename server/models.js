// Groq models Focus Room is allowed to call.
//
// FREE ONLY. This list is the whole universe of models the server will send a
// request to. Anything else is refused before it reaches Groq, whatever the
// browser asks for. The IDs come from Groq's Free plan rate-limit table
// (console.groq.com/docs/rate-limits). Groq retires and renames models
// regularly — when the table changes, edit FREE_MODELS below, or override it
// without a code change:
//
//   GROQ_FREE_MODELS=openai/gpt-oss-120b,qwen/qwen3.8-27b,openai/gpt-oss-20b
//
// At startup (and whenever a key is tested) the live /models list is checked,
// so a model Groq has retired is dropped quietly instead of failing every turn.

export const GROQ = {
  label: "Groq",
  baseUrl: (process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, ""),
  keyUrl: "https://console.groq.com/keys",
  limitsUrl: "https://console.groq.com/settings/limits",
  keyPrefix: "gsk_",
  envVar: "GROQ_API_KEY",
};

// Free plan, per model: 30 req/min, 1,000 req/day, 8,000 tokens/min,
// 200,000 tokens/day. Limits are counted per model, so moving to another
// model in the list really does reach fresh quota.
const DEFAULT_FREE_MODELS = [
  { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B" },
  { id: "qwen/qwen3.8-27b", label: "Qwen 3.8 27B" },
  { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B" },
];

// What each model family supports on Groq.
//   reasoning: how to ask for (or hide) its reasoning
//   tools:     standard function calling
//   browserSearch: Groq's built-in server-side browser_search tool
function capabilities(id) {
  if (/^openai\/gpt-oss-(?!safeguard)/.test(id)) {
    return { reasoning: "gpt-oss", tools: true, browserSearch: true };
  }
  if (/^qwen\//.test(id)) return { reasoning: "qwen", tools: true, browserSearch: false };
  return { reasoning: "none", tools: true, browserSearch: false };
}

function fromEnv() {
  const raw = String(process.env.GROQ_FREE_MODELS || "").trim();
  if (!raw) return null;
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return ids.length ? ids.map((id) => ({ id, label: id.split("/").pop() })) : null;
}

export const FREE_MODELS = (fromEnv() || DEFAULT_FREE_MODELS).map((m) => ({
  ...m,
  ...capabilities(m.id),
}));

const FREE_IDS = new Set(FREE_MODELS.map((m) => m.id));

export function isFreeModel(id) {
  return FREE_IDS.has(String(id || ""));
}

export function modelInfo(id) {
  return FREE_MODELS.find((m) => m.id === id) || null;
}

// Default order each agent walks when its current model is busy or failing.
// Dr. Maple and Scout START on different models so a research burst cannot
// drain the per-minute token allowance the conversation needs.
const PREFERRED_START = {
  doctor: "openai/gpt-oss-120b",
  scout: "openai/gpt-oss-20b",
};

/** Ordered, de-duplicated chain for an agent, starting from `first` if free. */
export function chainFor(agentId, first) {
  const ids = FREE_MODELS.map((m) => m.id);
  const start = isFreeModel(first) ? first : isFreeModel(PREFERRED_START[agentId]) ? PREFERRED_START[agentId] : ids[0];
  const rest = agentId === "scout" ? [...ids].reverse() : ids;
  return [start, ...rest.filter((id) => id !== start)];
}

export function defaultModel(agentId) {
  return chainFor(agentId)[0];
}

// Models the live /models endpoint says no longer exist. Filled in by
// noteLiveModels(); empty until a key has been used, which means "trust the
// list" rather than "nothing is available".
const retired = new Set();

export function noteLiveModels(liveIds) {
  if (!Array.isArray(liveIds) || !liveIds.length) return;
  const live = new Set(liveIds);
  retired.clear();
  for (const m of FREE_MODELS) if (!live.has(m.id)) retired.add(m.id);
}

export function isRetired(id) {
  return retired.has(id);
}

export function publicModelList() {
  return FREE_MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    tools: m.tools,
    browserSearch: m.browserSearch,
    retired: retired.has(m.id),
  }));
}
