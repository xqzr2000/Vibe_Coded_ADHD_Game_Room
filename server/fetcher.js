// Lightweight page fetch — the default "depth" step in Scout's pipeline.
// Pulls a URL, strips it down to readable text, and truncates so it fits
// comfortably in a model prompt. No browser, no rendering: fast and cheap.

const UA = "FocusRoomBot/0.1 (+https://github.com/your-org/focus-room)";

export async function fetchPageText(url, { maxChars = 6000, timeoutMs = 15000 } = {}) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": UA, Accept: "text/html,*/*" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);

  const type = res.headers.get("content-type") || "";
  if (!/text|html|json/.test(type)) throw new Error(`Unsupported content-type ${type}`);

  const html = await res.text();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

  return text.slice(0, maxChars);
}

// Fetch several URLs in parallel; failures are skipped, not fatal.
export async function fetchPages(urls, opts) {
  const unique = [...new Set(urls.filter((u) => /^https?:\/\//i.test(u || "")))].slice(0, 3);
  const results = await Promise.allSettled(unique.map((u) => fetchPageText(u, opts)));
  return unique
    .map((url, i) => ({ url, text: results[i].status === "fulfilled" ? results[i].value : null }))
    .filter((r) => r.text);
}
