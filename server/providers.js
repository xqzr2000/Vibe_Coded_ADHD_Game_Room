// Provider registry.
//
// Every provider here speaks the OpenAI /chat/completions shape with Bearer
// auth, so one client (server/llm.js) drives all of them. Adding a provider
// is a matter of adding an entry — no agent code changes.

export const PROVIDERS = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    modelsPath: "/models",
    modelsNeedKey: false, // public catalogue — we can list models before login
    supportsOnline: true, // OpenRouter web-search server tool for Scout
    keyUrl: "https://openrouter.ai/keys",
    keyPrefixHint: "sk-or-",
    envVar: "OPENROUTER_API_KEY",
    note: "New accounts get a small free credit. When it runs out, switch to a :free model — they cost nothing but are rate limited.",
    freeModel: "openrouter/free", // auto-router that picks an available free model
    // Prefer OpenRouter's dynamic free router instead of hard-coding free model
    // IDs that churn. Live discovery is the last-resort escape hatch.
    freeModels: ["openrouter/free"],
    presets: [
      { id: "openrouter/free", label: "Free auto-router", free: true },
      { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4 (paid)" },
      { id: "openai/gpt-4o-mini", label: "GPT-4o mini (paid, cheap)" },
    ],
  },

  groq: {
    id: "groq",
    label: "Groq",
    baseUrl: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
    modelsPath: "/models",
    modelsNeedKey: true,
    supportsOnline: false,
    keyUrl: "https://console.groq.com/keys",
    keyPrefixHint: "gsk_",
    envVar: "GROQ_API_KEY",
    note: "Free tier with generous rate limits and very fast responses. No built-in web search — Scout falls back to deep search or its saved library.",
    freeModel: "openai/gpt-oss-120b",
    freeModels: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b"],
    presets: [],
  },

  gemini: {
    id: "gemini",
    label: "Google Gemini",
    // Note the trailing /openai/ — that segment is the compatibility shim.
    baseUrl: process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai",
    modelsPath: "/models",
    modelsNeedKey: true,
    supportsOnline: false,
    keyUrl: "https://aistudio.google.com/apikey",
    keyPrefixHint: "AIza",
    envVar: "GEMINI_API_KEY",
    note: "Google AI Studio offers a free tier with daily request limits. No built-in web search through this endpoint.",
    freeModel: "gemini-2.5-flash",
    freeModels: ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest"],
    presets: [],
  },

  custom: {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    baseUrl: "", // supplied by the user
    modelsPath: "/models",
    modelsNeedKey: true,
    supportsOnline: false,
    keyUrl: "",
    keyPrefixHint: "",
    envVar: "CUSTOM_API_KEY",
    note: "Any endpoint that speaks the OpenAI chat-completions format: a local server, a proxy, or another provider.",
    presets: [],
  },
};

export function getProvider(id) {
  return PROVIDERS[id] || PROVIDERS.openrouter;
}

// Safe to send to the browser — contains no keys.
export function publicProviderList() {
  return Object.values(PROVIDERS).map(
    ({ id, label, supportsOnline, keyUrl, keyPrefixHint, note, presets, modelsNeedKey }) => ({
      id,
      label,
      supportsOnline,
      keyUrl,
      keyPrefixHint,
      note,
      presets,
      modelsNeedKey,
    })
  );
}
