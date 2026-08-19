// "Why isn't the agent responding?" — answered with actual evidence rather
// than guesswork.
//
// Runs a short sequence of checks and reports each one plainly:
//   1. Is there a key at all, and where did it come from?
//   2. What does the provider say about the account — credits used, limit
//      remaining, free tier, rate limits?
//   3. Does the model the agents are configured to use actually respond?
//   4. Does a free model respond? (Distinguishes "out of credits" from
//      "everything is broken" — the free tier often works when paid doesn't.)
//   5. Is the deep-search sidecar up?

import { getProvider } from "./providers.js";
import { chat, LlmError } from "./llm.js";

const mask = (key) =>
  key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-4)}` : `${key.slice(0, 3)}…`;

const money = (n) =>
  typeof n === "number" ? `$${n.toFixed(n < 1 ? 4 : 2)}` : String(n ?? "unknown");

// Provider account info. Only OpenRouter exposes a documented endpoint for
// this; the others are checked by making a real call instead.
async function accountCheck(providerId, apiKey) {
  if (providerId !== "openrouter") {
    return {
      id: "account",
      label: "Account status",
      status: "skip",
      detail: `${getProvider(providerId).label} doesn't publish a credits endpoint, so the live tests below are the real answer.`,
    };
  }

  try {
    // Use the configured base URL so this works behind a gateway/proxy too.
    const root = getProvider("openrouter").baseUrl.replace(/\/$/, "");
    const res = await fetch(`${root}/key`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });

    if (res.status === 401) {
      return {
        id: "account",
        label: "Account status",
        status: "fail",
        detail: "OpenRouter rejected this key.",
        hint: "Generate a new one at openrouter.ai/keys and paste it above.",
      };
    }
    if (!res.ok) {
      return {
        id: "account",
        label: "Account status",
        status: "warn",
        detail: `OpenRouter returned ${res.status} for the key endpoint.`,
      };
    }

    const { data } = await res.json();
    const usage = data?.usage;
    const limit = data?.limit; // null = no per-key cap
    const remaining = typeof limit === "number" ? limit - (usage || 0) : null;
    const rl = data?.rate_limit;

    const bits = [];
    if (typeof usage === "number") bits.push(`used ${money(usage)}`);
    if (typeof limit === "number") bits.push(`key limit ${money(limit)}`);
    if (remaining !== null) bits.push(`${money(remaining)} left on this key`);
    if (data?.is_free_tier === true) bits.push("free tier (no credits purchased)");
    if (data?.is_free_tier === false) bits.push("has purchased credits");
    if (rl?.requests) bits.push(`rate limit ${rl.requests}/${rl.interval}`);

    // The specific thing the user asked about: is the welcome credit gone?
    let status = "ok";
    let hint = "";
    if (remaining !== null && remaining <= 0) {
      status = "fail";
      hint =
        "This key's credit is used up. Free models still work while your balance is at or above zero — the agents switch to them automatically.";
    } else if (data?.is_free_tier === true) {
      hint =
        "On the free tier, :free models are capped at roughly 20 requests/minute and 50/day until $10 of credits has been purchased (then 1000/day). A negative balance causes 402 errors even on free models.";
    }

    return {
      id: "account",
      label: "Account status",
      status,
      detail: bits.join(" · ") || "Key is valid.",
      hint,
    };
  } catch (err) {
    return {
      id: "account",
      label: "Account status",
      status: "warn",
      detail: `Couldn't reach OpenRouter's key endpoint: ${err.message}`,
    };
  }
}

// A real (tiny) call is the only honest test of whether a model works.
async function modelCheck({ id, label, provider, model, apiKey, baseUrl }) {
  if (!model) return { id, label, status: "skip", detail: "No model set." };
  try {
    await chat({
      provider,
      model,
      apiKey,
      baseUrl,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
      maxTokens: 8,
      temperature: 0,
    });
    return { id, label, status: "ok", detail: `${model} responded.` };
  } catch (err) {
    if (err instanceof LlmError) {
      // An empty completion still means we reached the model.
      if (/empty response/i.test(err.message)) {
        return { id, label, status: "ok", detail: `${model} responded (empty, but reachable).` };
      }
      const status = err.kind === "rate_limited" ? "warn" : "fail";
      return { id, label, status, detail: `${model}: ${err.message}`, hint: err.hint || "" };
    }
    return { id, label, status: "fail", detail: `${model}: ${err.message}` };
  }
}

export async function runDiagnostics({ provider = "openrouter", apiKey, baseUrl, model } = {}) {
  const p = getProvider(provider);
  const sessionKey = apiKey || "";
  const key = sessionKey || process.env[p.envVar] || "";
  const checks = [];

  if (!key) {
    checks.push({
      id: "key",
      label: "API key",
      status: "fail",
      detail: `No ${p.label} key found in this browser or on the server.`,
      hint: "Paste a key above, or set one as a Codespaces secret and restart.",
    });
    return { provider: p.label, checks };
  }

  checks.push({
    id: "key",
    label: "API key",
    status: "ok",
    detail: `${p.label} key ${mask(key)}, from ${sessionKey ? "this browser" : "the server environment"}.`,
  });

  checks.push(await accountCheck(provider, key));

  const configured = model || p.freeModel;
  checks.push(
    await modelCheck({
      id: "configured",
      label: "Your model",
      provider,
      model: configured,
      apiKey: key,
      baseUrl,
    })
  );

  // Only worth a separate call if it's a different model.
  if (p.freeModel && p.freeModel !== configured) {
    checks.push(
      await modelCheck({
        id: "free",
        label: "Free model",
        provider,
        model: p.freeModel,
        apiKey: key,
        baseUrl,
      })
    );
  }

  // Deep search sidecar.
  try {
    const url = process.env.BROWSER_SERVICE_URL || "http://127.0.0.1:8010";
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
    checks.push({
      id: "deep",
      label: "Deep search",
      status: r.ok ? "ok" : "warn",
      detail: r.ok ? "Browser sidecar is running." : "Sidecar responded but not healthy.",
    });
  } catch {
    checks.push({
      id: "deep",
      label: "Deep search",
      status: "skip",
      detail: "Browser sidecar isn't running (optional — standard research still works).",
    });
  }

  return { provider: p.label, checks, summary: summarize(checks) };
}

function summarize(checks) {
  const failed = checks.filter((c) => c.status === "fail");
  const paidDead = checks.find((c) => c.id === "configured" && c.status === "fail");
  const freeAlive = checks.find((c) => c.id === "free" && c.status === "ok");

  if (!failed.length) return "Everything the agents need is working.";
  if (paidDead && freeAlive) {
    return "Your chosen model isn't usable, but free models are — the agents will switch to them automatically, so the conversation keeps working.";
  }
  if (checks.find((c) => c.id === "key" && c.status === "fail")) {
    return "No usable API key. The agents can't run until one is added.";
  }
  return "Something is blocking the agents — see the failing checks above.";
}
