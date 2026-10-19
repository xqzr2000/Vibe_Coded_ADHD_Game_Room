// Tavily: search + page extraction built for AI agents.
//
// Free plan: 1,000 credits a month, no card on file — so it cannot bill.
// Costs as Focus Room uses it: a basic search is 1 credit; extracting pages is
// 1 credit per 5 successful pages. One Scout run is capped at 2 searches and
// 3 pages, about 3 credits — roughly 300 runs a month on the free plan.
//
// Free-only guard: if the usage endpoint says the plan's credits are spent,
// Focus Room stops calling Tavily for that key instead of letting an account
// with pay-as-you-go enabled run up a bill. DuckDuckGo takes over.

import { SearchError } from "./errors.js";

const BASE = () => (process.env.TAVILY_BASE_URL || "https://api.tavily.com").replace(/\/$/, "");

async function post(path, apiKey, body, timeoutMs = 20_000) {
  if (!apiKey) throw new SearchError("No Tavily key.", { kind: "no_key", backend: "tavily" });
  let res;
  try {
    res = await fetch(`${BASE()}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new SearchError(`Couldn't reach Tavily: ${err.message}`, { kind: "network", backend: "tavily" });
  }
  if (!res.ok) throw classify(res.status, await res.text().catch(() => ""), res.headers);
  return res.json();
}

function classify(status, text, headers) {
  const retry = Number(headers?.get?.("retry-after")) * 1000 || 0;
  const opts = (kind) => ({ kind, backend: "tavily", status, retryAfterMs: retry });
  if (status === 401 || status === 403) return new SearchError("Tavily rejected this API key.", opts("bad_key"));
  if (status === 432) return new SearchError("This month's free Tavily credits are used up.", opts("out_of_credits"));
  if (status === 433) return new SearchError("Tavily's pay-as-you-go limit was reached.", opts("out_of_credits"));
  if (status === 429) return new SearchError("Tavily is rate limiting this key.", opts("rate_limited"));
  return new SearchError(`Tavily error ${status}: ${String(text).slice(0, 160)}`, opts(status >= 500 ? "network" : "unknown"));
}

export async function tavilySearch(query, { apiKey, maxResults = 5 } = {}) {
  const data = await post("/search", apiKey, {
    query,
    search_depth: "basic", // 1 credit; "advanced" would be 2
    max_results: maxResults,
    include_answer: false,
    include_raw_content: false,
    include_usage: true,
  });
  return {
    results: (data.results || []).map((r) => ({
      title: String(r.title || r.url || ""),
      url: String(r.url || ""),
      snippet: String(r.content || "").slice(0, 400),
    })),
    credits: Number(data.usage?.credits ?? 1),
  };
}

export async function tavilyExtract(urls, { apiKey, query } = {}) {
  const data = await post(
    "/extract",
    apiKey,
    {
      urls,
      extract_depth: "basic",
      format: "text",
      include_usage: true,
      ...(query ? { query, chunks_per_source: 3 } : {}),
    },
    30_000
  );
  return {
    pages: (data.results || []).map((r) => ({ url: String(r.url || ""), text: String(r.raw_content || "") })),
    failed: (data.failed_results || []).map((f) => ({ url: String(f.url || ""), error: String(f.error || "failed") })),
    credits: Number(data.usage?.credits ?? 0),
  };
}

/** Plan and usage for a key. Free to call. */
export async function tavilyUsage(apiKey) {
  if (!apiKey) throw new SearchError("No Tavily key.", { kind: "no_key", backend: "tavily" });
  let res;
  try {
    res = await fetch(`${BASE()}/usage`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new SearchError(`Couldn't reach Tavily: ${err.message}`, { kind: "network", backend: "tavily" });
  }
  if (!res.ok) throw classify(res.status, await res.text().catch(() => ""), res.headers);
  const data = await res.json();
  const a = data.account || {};
  const k = data.key || {};
  return {
    plan: String(a.current_plan || ""),
    planUsage: num(a.plan_usage),
    planLimit: num(a.plan_limit),
    paygoUsage: num(a.paygo_usage),
    paygoLimit: num(a.paygo_limit),
    keyUsage: num(k.usage),
    keyLimit: num(k.limit),
  };
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** True when the plan's included credits are gone (pay-as-you-go would bill). */
export function planExhausted(usage) {
  if (!usage) return false;
  if (usage.planLimit != null && usage.planUsage != null && usage.planLimit > 0) {
    return usage.planUsage >= usage.planLimit;
  }
  if (usage.keyLimit != null && usage.keyUsage != null && usage.keyLimit > 0) {
    return usage.keyUsage >= usage.keyLimit;
  }
  return false;
}
