// Groq quota tracking.
//
// Every Groq response carries x-ratelimit-* headers: requests left TODAY and
// tokens left THIS MINUTE, for the model that answered. Recording them lets
// Focus Room skip a model that is about to run out instead of finding out from
// a 429. Limits belong to the Groq organization behind a key, so the tracker
// is keyed by a hash of the key (never the key itself) plus the model, and is
// shared by every session using that key.

import crypto from "node:crypto";

const state = new Map(); // `${keyHash}::${model}` -> record

export const keyHash = (key) =>
  crypto.createHash("sha256").update(String(key || "")).digest("hex").slice(0, 16);

const id = (key, model) => `${keyHash(key)}::${model}`;

/** "2m59.56s" | "7.66s" | "1h2m" | "250ms" -> milliseconds */
export function parseDuration(raw) {
  const s = String(raw || "").trim();
  if (!s) return 0;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  let ms = 0;
  let matched = false;
  for (const [, num, unit] of s.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    const n = Number(num);
    ms += unit === "h" ? n * 3600_000 : unit === "m" ? n * 60_000 : unit === "s" ? n * 1000 : n;
  }
  return matched ? Math.round(ms) : 0;
}

export function parseRateHeaders(headers) {
  const get = (name) => headers?.get?.(name);
  const num = (name) => {
    const v = get(name);
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const out = {
    limitRequests: num("x-ratelimit-limit-requests"), // per day
    remainingRequests: num("x-ratelimit-remaining-requests"),
    resetRequestsMs: parseDuration(get("x-ratelimit-reset-requests")),
    limitTokens: num("x-ratelimit-limit-tokens"), // per minute
    remainingTokens: num("x-ratelimit-remaining-tokens"),
    resetTokensMs: parseDuration(get("x-ratelimit-reset-tokens")),
  };
  return Object.values(out).some((v) => v != null && v !== 0) ? out : null;
}

export function recordHeaders(key, model, headers) {
  const parsed = parseRateHeaders(headers);
  if (!parsed) return null;
  const now = Date.now();
  const rec = state.get(id(key, model)) || {};
  Object.assign(rec, parsed, {
    updatedAt: now,
    resetRequestsAt: now + (parsed.resetRequestsMs || 0),
    resetTokensAt: now + (parsed.resetTokensMs || 0),
  });
  state.set(id(key, model), rec);
  return rec;
}

const COOLDOWN_MS = {
  rate_limited: 30_000,
  bad_model: 6 * 60 * 60 * 1000,
  network: 15_000,
  empty_response: 10_000,
  tool_failed: 10_000,
  unknown: 20_000,
};

export function recordFailure(key, model, err) {
  const rec = state.get(id(key, model)) || {};
  const base = COOLDOWN_MS[err?.kind] ?? 0;
  const wait = Math.min(Math.max(base, Number(err?.retryAfterMs || 0)), 6 * 60 * 60 * 1000);
  if (wait > 0) rec.cooldownUntil = Date.now() + wait;
  rec.lastError = { kind: err?.kind || "unknown", message: String(err?.message || ""), at: Date.now() };
  state.set(id(key, model), rec);
}

export function clearFailure(key, model) {
  const rec = state.get(id(key, model));
  if (rec) {
    delete rec.cooldownUntil;
    delete rec.lastError;
  }
}

/**
 * Can this model take a request of roughly `estTokens` right now?
 * Returns { ok: true } or { ok: false, waitMs, reason }.
 */
export function headroom(key, model, estTokens = 0) {
  const rec = state.get(id(key, model));
  if (!rec) return { ok: true };
  const now = Date.now();
  if (rec.cooldownUntil && rec.cooldownUntil > now) {
    return { ok: false, waitMs: rec.cooldownUntil - now, reason: rec.lastError?.kind || "cooling down" };
  }
  if (rec.remainingRequests === 0 && rec.resetRequestsAt > now) {
    return { ok: false, waitMs: rec.resetRequestsAt - now, reason: "daily requests used up" };
  }
  // Tokens refill continuously; estimate what has come back since the reading.
  if (rec.remainingTokens != null && rec.limitTokens) {
    const elapsed = now - (rec.updatedAt || now);
    const refillPerMs = rec.limitTokens / 60_000;
    const available = Math.min(rec.limitTokens, rec.remainingTokens + elapsed * refillPerMs);
    if (estTokens > available) {
      const waitMs = Math.ceil((estTokens - available) / refillPerMs);
      return { ok: false, waitMs, reason: "per-minute tokens low" };
    }
  }
  return { ok: true };
}

/** Snapshot for the settings panel. */
export function snapshot(key, models) {
  const now = Date.now();
  return models.map((model) => {
    const rec = state.get(id(key, model)) || null;
    if (!rec) return { model, known: false };
    return {
      model,
      known: rec.updatedAt != null,
      limitRequests: rec.limitRequests ?? null,
      remainingRequests: rec.remainingRequests ?? null,
      resetRequestsInMs: rec.resetRequestsAt ? Math.max(0, rec.resetRequestsAt - now) : null,
      limitTokens: rec.limitTokens ?? null,
      remainingTokens: rec.remainingTokens ?? null,
      coolingDownForMs: rec.cooldownUntil && rec.cooldownUntil > now ? rec.cooldownUntil - now : 0,
      lastError: rec.lastError || null,
      updatedAt: rec.updatedAt || null,
    };
  });
}

/**
 * Groq's API cannot say which plan a key belongs to, but the daily request cap
 * it reports gives it away: the Free plan allows 1,000 requests/day per model.
 */
export function planGuess(key, models) {
  const caps = snapshot(key, models).map((s) => s.limitRequests).filter((n) => typeof n === "number");
  if (!caps.length) return "unknown";
  return caps.every((n) => n <= 1000) ? "free" : "higher";
}

export function _resetForTests() {
  state.clear();
}
