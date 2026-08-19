// Per-session agent configuration.
//
// SECURITY MODEL — worth reading before changing anything here:
//   * API keys live in the user's BROWSER (localStorage) and are sent over the
//     WebSocket with each session. They are held in memory for the life of the
//     connection and are NEVER written to disk by this server.
//   * Only non-secret preferences (which provider/model each agent uses) are
//     persisted, to data/settings.json, so a returning user doesn't have to
//     re-pick their models.
//   * Env vars remain a fallback, so the Codespace owner's own key still works
//     with zero setup.
// This is why there's no password database here: storing other people's API
// keys server-side would be a much bigger liability than it's worth for a demo.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getProvider } from "./providers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_FILE = path.join(__dirname, "..", "data", "settings.json");

const DEFAULTS = {
  // Default to the official dynamic free router. A user who adds their own
  // paid account in the UI is explicitly opting into paid models.
  doctor: { provider: "openrouter", model: "openrouter/free" },
  scout: { provider: "openrouter", model: "openrouter/free" },
  // auto: try the next usable option when a call fails.
  // allowPaid: OFF by default — never spend someone's money unprompted.
  fallback: { auto: true, allowPaid: false },
};

// One-click presets the UI offers.
export const PRESETS = [
  {
    id: "free",
    label: "Free (no credits needed)",
    description: "OpenRouter's free auto-router for both agents. Rate limited, but costs nothing.",
    config: {
      doctor: { provider: "openrouter", model: "openrouter/free" },
      scout: { provider: "openrouter", model: "openrouter/free" },
    },
  },
  {
    id: "quality",
    label: "Best quality (paid credits)",
    description: "Claude for the conversation, a cheap fast model for research.",
    config: {
      doctor: { provider: "openrouter", model: "anthropic/claude-sonnet-4" },
      scout: { provider: "openrouter", model: "openai/gpt-4o-mini" },
    },
  },
  {
    id: "groq",
    label: "Groq free tier (fastest)",
    description: "Very fast and free, but no built-in web search for Scout.",
    config: {
      doctor: { provider: "groq", model: "openai/gpt-oss-120b" },
      scout: { provider: "groq", model: "openai/gpt-oss-120b" },
    },
  },
  {
    id: "gemini",
    label: "Gemini free tier",
    description: "Google AI Studio's free tier. No built-in web search for Scout.",
    config: {
      doctor: { provider: "gemini", model: "gemini-2.5-flash" },
      scout: { provider: "gemini", model: "gemini-2.5-flash" },
    },
  },
];

function readSaved() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch {
    return {};
  }
}

// Non-secret preferences only. Anything key-shaped is stripped before writing.
export function savePrefs(prefs) {
  const clean = {
    doctor: { provider: prefs?.doctor?.provider, model: prefs?.doctor?.model },
    scout: { provider: prefs?.scout?.provider, model: prefs?.scout?.model },
    customBaseUrl: prefs?.customBaseUrl || undefined,
    // Paid-fallback consent is session-only because the key itself is
    // session-only. Persisting allowPaid=true could make a later server-env
    // key spend money before the browser has restored the user's settings.
    fallback: {
      auto: prefs?.fallback?.auto !== false,
      allowPaid: false,
    },
    updatedAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(clean, null, 2));
  } catch {
    /* preferences are a convenience; never fail a session over them */
  }
  return clean;
}

export function defaultConfig() {
  const saved = readSaved();
  return {
    doctor: { ...DEFAULTS.doctor, ...(saved.doctor || {}) },
    scout: { ...DEFAULTS.scout, ...(saved.scout || {}) },
    customBaseUrl: saved.customBaseUrl || process.env.CUSTOM_BASE_URL || "",
    // Never resurrect paid-fallback consent from disk. The browser must
    // explicitly re-establish it with its own primary key each session.
    fallback: { ...DEFAULTS.fallback, ...(saved.fallback || {}), allowPaid: false },
    keys: {}, // never loaded from disk — supplied by the browser or env
  };
}

// Resolve the key for a provider: session (browser) first, then env fallback.
export function resolveKey(config, providerId) {
  const fromSession = config?.keys?.[providerId];
  if (fromSession) return fromSession;
  const provider = getProvider(providerId);
  return process.env[provider.envVar] || "";
}

// Everything an agent needs to make a call.
export function agentCall(config, agentId) {
  const agent = config?.[agentId] || DEFAULTS[agentId];
  return {
    provider: agent.provider,
    model: agent.model,
    apiKey: resolveKey(config, agent.provider),
    baseUrl: agent.provider === "custom" ? config?.customBaseUrl || "" : "",
  };
}

// Safe to send to the browser: which agents point where, and which providers
// currently have a usable key — without ever echoing the key itself.
export function configStatus(config) {
  const providers = new Set([config.doctor.provider, config.scout.provider]);
  const keyed = {};
  for (const id of providers) {
    const key = resolveKey(config, id);
    keyed[id] = {
      hasKey: Boolean(key),
      // Where the key came from, so the UI can say "using the server's key".
      source: config?.keys?.[id] ? "you" : key ? "server" : "none",
    };
  }
  return {
    doctor: { ...config.doctor },
    scout: { ...config.scout },
    customBaseUrl: config.customBaseUrl || "",
    fallback: { ...config.fallback },
    providers: keyed,
  };
}
