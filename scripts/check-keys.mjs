// `npm run check` — tests the keys in .env (or the environment) from the
// command line, without starting the app. Handy on a fresh Ubuntu box or in a
// Codespace terminal. Costs nothing on Groq (lists models only) and nothing on
// Tavily (reads usage only).

import "dotenv/config";
import { testGroqKey, testTavilyKey } from "../server/diagnose.js";
import { FREE_MODELS } from "../server/models.js";

const groq = String(process.env.GROQ_API_KEY || "").trim();
const tavily = String(process.env.TAVILY_API_KEY || "").trim();
let bad = 0;

console.log("\nFocus Room key check\n");
console.log(`Node ${process.versions.node}`);
console.log(`Free models on the allowlist: ${FREE_MODELS.map((m) => m.id).join(", ")}\n`);

if (!groq) {
  console.log("· GROQ_API_KEY   not set — fine if you paste a key in the browser instead.");
} else {
  const r = await testGroqKey(groq);
  if (r.ok) {
    const retired = r.models.filter((m) => m.retired).map((m) => m.id);
    console.log(`✓ GROQ_API_KEY   ${r.masked} works · ${r.usable} free models available · ${r.latencyMs} ms`);
    if (retired.length) console.log(`  ⚠ Groq no longer lists: ${retired.join(", ")} — update FREE_MODELS in server/models.js`);
  } else {
    bad += 1;
    console.log(`✕ GROQ_API_KEY   ${r.error}${r.hint ? `\n  ${r.hint}` : ""}`);
  }
}

if (!tavily) {
  console.log("· TAVILY_API_KEY not set — Scout will use DuckDuckGo (or paste a key in Settings).");
} else {
  const r = await testTavilyKey(tavily);
  if (r.ok) {
    const u = r.usage || {};
    const used = u.planUsage ?? u.keyUsage;
    const limit = u.planLimit ?? u.keyLimit;
    console.log(`✓ TAVILY_API_KEY ${r.masked} works${used != null && limit ? ` · ${used}/${limit} credits used this month` : ""}${u.plan ? ` · plan ${u.plan}` : ""}`);
    if (r.exhausted) console.log("  ⚠ Free credits are used up for this month — Scout falls back to DuckDuckGo.");
  } else {
    bad += 1;
    console.log(`✕ TAVILY_API_KEY ${r.error}`);
  }
}

console.log(
  process.env.ALLOW_SERVER_KEYS === "1"
    ? "\nALLOW_SERVER_KEYS=1 → browsers use these keys without pasting their own (private machines only)."
    : "\nALLOW_SERVER_KEYS is not 1 → these keys are NOT lent to browsers; each browser pastes its own.\nSet ALLOW_SERVER_KEYS=1 in .env if this is your own private machine."
);
process.exit(bad ? 1 : 0);
