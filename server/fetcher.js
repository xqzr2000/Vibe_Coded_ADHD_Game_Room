// Plain page reader — Scout's way to read a page when Tavily isn't available.
// Pulls a URL, strips it to readable text and truncates so it fits in a prompt.
// No browser, no JavaScript: fast and cheap, but sites that build their content
// with JavaScript come back thin.
//
// The URLs come from search results and model output, so the server refuses
// to fetch anything on this machine or the local network.

import dns from "node:dns/promises";
import net from "node:net";

const UA = "Mozilla/5.0 (compatible; FocusRoomScout/1.0; +https://github.com/)";
const MAX_BYTES = 1_500_000;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  return true;
}

export async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Not a valid URL.");
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only http(s) pages can be read.");
  if (process.env.FOCUS_ROOM_ALLOW_PRIVATE_FETCH === "1") return url; // test harness only
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$|\.local$|\.internal$/i.test(host)) throw new Error("Local addresses are not fetched.");
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("Private addresses are not fetched.");
    return url;
  }
  try {
    const addrs = await dns.lookup(host, { all: true });
    if (addrs.some((a) => isPrivateIp(a.address))) throw new Error("That host resolves to a private address.");
  } catch (err) {
    if (/private address/.test(err.message)) throw err;
    throw new Error(`Couldn't resolve ${host}.`);
  }
  return url;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", copy: "©", reg: "®", trade: "™" };

export function htmlToText(html) {
  let s = String(html || "");
  const title = (s.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim();
  s = s
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  // Prefer the main content region when the page marks one and it has substance.
  const main = s.match(/<(main|article)\b[\s\S]*?<\/\1>/i)?.[0];
  if (main && main.replace(/<[^>]+>/g, "").trim().length > 400) s = main;
  else s = s.replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ");
  s = s
    .replace(/<(br|p|div|li|h[1-6]|tr|section)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") {
        const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : " ";
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return { title: htmlDecodeTitle(title), text: s };
}

const htmlDecodeTitle = (t) => t.replace(/&amp;/g, "&").replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

export async function fetchPageText(url, { maxChars = 6000, timeoutMs = 15_000 } = {}) {
  await assertPublicUrl(url);
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // Redirects could land somewhere private; check where we ended up.
  if (res.url && res.url !== url) await assertPublicUrl(res.url);

  const type = res.headers.get("content-type") || "";
  if (!/text|html|json|xml/.test(type)) throw new Error(`Not a text page (${type || "unknown type"})`);

  let received = 0;
  const chunks = [];
  for await (const chunk of res.body) {
    received += chunk.length;
    chunks.push(chunk);
    if (received > MAX_BYTES) break;
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const { title, text } = /html|xml/.test(type) ? htmlToText(raw) : { title: "", text: raw };
  return { url, title, text: text.slice(0, maxChars) };
}

// Fetch several URLs in parallel; failures are reported, not fatal.
export async function fetchPages(urls, opts) {
  const unique = [...new Set((urls || []).filter((u) => /^https?:\/\//i.test(u || "")))].slice(0, 3);
  const settled = await Promise.allSettled(unique.map((u) => fetchPageText(u, opts)));
  const pages = [];
  const failed = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value.text.trim().length > 80) pages.push(r.value);
    else failed.push({ url: unique[i], error: r.status === "rejected" ? String(r.reason?.message || r.reason) : "page had no readable text" });
  });
  return { pages, failed };
}
