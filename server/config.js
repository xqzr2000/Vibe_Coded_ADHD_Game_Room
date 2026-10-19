// Per-session configuration.
//
// SECURITY MODEL — worth reading before changing anything here:
//   * API keys (Groq, Tavily) live in the user's BROWSER (localStorage) and are
//     sent over the WebSocket. The server holds them in memory for the life of
//     the session and never writes them to disk or logs.
//   * Server environment keys (GROQ_API_KEY, TAVILY_API_KEY in .env or a
//     Codespaces secret) are used ONLY when the operator sets
//     ALLOW_SERVER_KEYS=1. Otherwise anyone who can open the page could spend
//     the operator's free quota. On a private machine, turning it on means you
//     never have to paste a key into the browser.
//   * There are no accounts and no database. The user's preferred name and
//     icon also live in the browser and are sent with each session.

import { GROQ, chainFor, defaultModel, isFreeModel } from "./models.js";

export const allowServerKeys = () => process.env.ALLOW_SERVER_KEYS === "1";

export function defaultConfig() {
  return {
    models: { doctor: defaultModel("doctor"), scout: defaultModel("scout") },
    keys: {}, // never loaded from disk — supplied by the browser
    allowServerKeys: allowServerKeys(),
  };
}

/** Key for a service: browser first, then the environment if the operator allows it. */
export function resolveKey(config, service) {
  const fromSession = String(config?.keys?.[service] || "").trim();
  if (fromSession) return fromSession;
  if (config?.allowServerKeys !== true) return "";
  const env = service === "groq" ? GROQ.envVar : service === "tavily" ? "TAVILY_API_KEY" : "";
  return env ? String(process.env[env] || "").trim() : "";
}

export function keySource(config, service) {
  if (String(config?.keys?.[service] || "").trim()) return "browser";
  return resolveKey(config, service) ? "server" : "none";
}

/** Which keys the server environment will lend to browser sessions. */
export function serverKeysAvailable() {
  if (!allowServerKeys()) return { groq: false, tavily: false };
  return {
    groq: Boolean(String(process.env[GROQ.envVar] || "").trim()),
    tavily: Boolean(String(process.env.TAVILY_API_KEY || "").trim()),
  };
}

/** Merge a browser config update. Non-free models are silently refused. */
export function applyUpdate(config, next = {}) {
  const models = { ...config.models };
  for (const agentId of ["doctor", "scout"]) {
    const wanted = next.models?.[agentId];
    if (wanted && isFreeModel(wanted)) models[agentId] = wanted;
  }
  const keys = next.replaceKeys ? {} : { ...config.keys };
  for (const service of ["groq", "tavily"]) {
    if (next.keys && Object.prototype.hasOwnProperty.call(next.keys, service)) {
      const v = String(next.keys[service] || "").trim();
      if (v) keys[service] = v;
      else delete keys[service];
    }
  }
  return {
    ...config,
    models,
    keys,
    // Operator-only switch; never accepted from the browser payload.
    allowServerKeys: allowServerKeys(),
  };
}

// Safe to send to the browser — never echoes a key.
export function configStatus(config) {
  return {
    models: { ...config.models },
    chains: { doctor: chainFor("doctor", config.models.doctor), scout: chainFor("scout", config.models.scout) },
    active: { ...(config._active || {}) },
    keys: {
      groq: keySource(config, "groq"),
      tavily: keySource(config, "tavily"),
    },
  };
}
