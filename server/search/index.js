// One search interface for Scout, whichever backend answers.
//
//   web search:  Tavily (if a key is set and free credits remain)
//                → DuckDuckGo HTML (no key)
//   page reading: Tavily extract (handles JavaScript-heavy pages)
//                → plain fetch (server/fetcher.js)
//
// If every web backend fails, the caller falls back to Groq's built-in
// browser_search (see researcher.js), and after that to a no-search answer.

import { resolveKey } from "../config.js";
import { keyHash } from "../quota.js";
import { fetchPages } from "../fetcher.js";
import { SearchError, domainOf } from "./errors.js";
import { tavilySearch, tavilyExtract, tavilyUsage, planExhausted } from "./tavily.js";
import { duckduckgoSearch } from "./duckduckgo.js";

const usageCache = new Map(); // keyHash -> { usage, at }
const USAGE_TTL_MS = 5 * 60_000;

export async function tavilyUsageCached(apiKey, { force = false } = {}) {
  const k = keyHash(apiKey);
  const hit = usageCache.get(k);
  if (!force && hit && Date.now() - hit.at < USAGE_TTL_MS) return hit.usage;
  const usage = await tavilyUsage(apiKey);
  usageCache.set(k, { usage, at: Date.now() });
  return usage;
}

function noteCredits(apiKey, credits) {
  const hit = usageCache.get(keyHash(apiKey));
  if (hit?.usage && typeof hit.usage.planUsage === "number") hit.usage.planUsage += credits;
  if (hit?.usage && typeof hit.usage.keyUsage === "number") hit.usage.keyUsage += credits;
}

export function createSearcher(config) {
  const tavilyKey = resolveKey(config, "tavily");
  const state = { credits: 0, backends: new Set(), tavilyOff: tavilyKey ? null : "no key", notes: [] };

  async function tavilyReady() {
    if (state.tavilyOff) return false;
    try {
      const usage = await tavilyUsageCached(tavilyKey);
      if (planExhausted(usage)) {
        state.tavilyOff = "this month's free credits are used up";
        state.notes.push("Tavily's free credits are used up for this month, so DuckDuckGo is standing in.");
        return false;
      }
    } catch (err) {
      if (err.kind === "bad_key") {
        state.tavilyOff = "key rejected";
        state.notes.push("Tavily rejected the key in Settings, so DuckDuckGo is standing in.");
        return false;
      }
      // Usage endpoint hiccup: the search itself will tell us if the key is bad.
    }
    return true;
  }

  function tavilyFailed(err) {
    if (["bad_key", "out_of_credits"].includes(err.kind)) {
      state.tavilyOff = err.message;
      state.notes.push(`${err.message} DuckDuckGo is standing in.`);
    }
  }

  return {
    state,
    async search(query, { maxResults = 5 } = {}) {
      const errors = [];
      if (await tavilyReady()) {
        try {
          const r = await tavilySearch(query, { apiKey: tavilyKey, maxResults });
          state.credits += r.credits;
          noteCredits(tavilyKey, r.credits);
          state.backends.add("Tavily");
          return { backend: "Tavily", results: r.results, credits: r.credits };
        } catch (err) {
          tavilyFailed(err);
          errors.push(err);
        }
      }
      try {
        const r = await duckduckgoSearch(query, { maxResults });
        state.backends.add("DuckDuckGo");
        return { backend: "DuckDuckGo", results: r.results, credits: 0 };
      } catch (err) {
        errors.push(err);
      }
      throw new SearchError(errors.map((e) => e.message).join(" "), { kind: "blocked", backend: "all" });
    },

    async read(urls, { query } = {}) {
      const list = [...new Set((urls || []).filter((u) => /^https?:\/\//i.test(u)))].slice(0, 3);
      if (!list.length) return { pages: [], failed: [] };
      let pages = [];
      let failed = list.map((url) => ({ url, error: "not read" }));

      if (await tavilyReady()) {
        try {
          const r = await tavilyExtract(list, { apiKey: tavilyKey, query });
          state.credits += r.credits;
          noteCredits(tavilyKey, r.credits);
          state.backends.add("Tavily extract");
          pages = r.pages
            .filter((p) => p.text.trim().length > 80)
            .map((p) => ({ url: p.url, title: domainOf(p.url), text: p.text, via: "Tavily" }));
          const got = new Set(pages.map((p) => p.url));
          failed = list.filter((u) => !got.has(u)).map((url) => ({
            url,
            error: r.failed.find((f) => f.url === url)?.error || "no readable text",
          }));
        } catch (err) {
          tavilyFailed(err);
        }
      }
      if (failed.length) {
        const r = await fetchPages(failed.map((f) => f.url));
        state.backends.add("direct fetch");
        pages = pages.concat(r.pages.map((p) => ({ ...p, via: "direct" })));
        failed = r.failed;
      }
      return { pages, failed };
    },
  };
}
