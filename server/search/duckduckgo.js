// DuckDuckGo's HTML results page — the no-key fallback.
//
// This is not an official API: it reads the same lightweight page a text
// browser gets. It can change shape or start returning a "please verify you're
// human" page, particularly from cloud IP ranges like Codespaces. When that
// happens it throws `blocked` and Scout moves on to the next backend.

import { SearchError } from "./errors.js";

const ENDPOINT = () => process.env.DDG_HTML_URL || "https://html.duckduckgo.com/html/";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export async function duckduckgoSearch(query, { maxResults = 5 } = {}) {
  let res;
  try {
    res = await fetch(ENDPOINT(), {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html",
      },
      body: new URLSearchParams({ q: query, kl: "wt-wt" }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new SearchError(`Couldn't reach DuckDuckGo: ${err.message}`, { kind: "network", backend: "duckduckgo" });
  }
  const html = await res.text().catch(() => "");
  if (res.status === 202 || /anomaly-modal|captcha|unusual traffic/i.test(html)) {
    throw new SearchError("DuckDuckGo asked for a human check (common from cloud servers).", {
      kind: "blocked",
      backend: "duckduckgo",
      status: res.status,
    });
  }
  if (!res.ok) {
    throw new SearchError(`DuckDuckGo answered ${res.status}.`, { kind: "network", backend: "duckduckgo", status: res.status });
  }
  const results = parseDuckDuckGo(html).slice(0, maxResults);
  return { results, credits: 0 };
}

const decode = (s) =>
  String(s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim();

function realUrl(href) {
  let h = decode(href);
  if (h.startsWith("//")) h = "https:" + h;
  try {
    const u = new URL(h, "https://duckduckgo.com");
    if (/duckduckgo\.com$/.test(u.hostname) && u.pathname.startsWith("/l/")) {
      return u.searchParams.get("uddg") || "";
    }
    if (/duckduckgo\.com$/.test(u.hostname)) return ""; // ads (/y.js) and internal links
    return u.href;
  } catch {
    return "";
  }
}

export function parseDuckDuckGo(html) {
  const out = [];
  const seen = new Set();
  const blocks = String(html || "").split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1);
  for (const block of blocks) {
    if (/result--ad\b/.test(block.slice(0, 200))) continue;
    const a = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const url = realUrl(a[1]);
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const snip = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(a|div|td)>/i);
    out.push({ title: decode(a[2]) || url, url, snippet: decode(snip?.[1] || "").slice(0, 400) });
  }
  return out;
}
