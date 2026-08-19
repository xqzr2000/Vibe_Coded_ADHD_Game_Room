// What Scout can research.
//
// Scout used to have exactly one job — find attention-training games — so any
// other request ("find me a clinician") got forced through a game-shaped prompt
// and came back useless. Each task now carries its own instructions, output
// shape, and rules about what happens to the result.
//
// Adding a task means adding an entry here; the pipeline in researcher.js is
// task-agnostic.

import { getGames, saveGames } from "../store.js";

// --- classification ---------------------------------------------------------

const CLINICIAN_HINTS =
  /\b(clinician|psychiatrist|psychologist|therapist|counsell?or|doctor|gp|physician|assessment|assessed|evaluation|evaluated|diagnos\w*|referral|refer|clinic|appointment|waitlist|waiting list|specialist|who can|where can i (get|go)|see someone)\b/i;
const DEAL_HINTS =
  /\b(deal|discount|coupon|promo|price|pricing|cost|cheap|afford|subscription|insurance|coverage|covered|reimburse|fsa|hsa|trial|free month|save money)\b/i;

export function classifyTask(query, fallback = "games") {
  const q = String(query || "");
  // Clinician wins ties: "how much does an ADHD assessment cost" is really a
  // question about getting assessed, not about a product's price.
  if (CLINICIAN_HINTS.test(q)) return "clinicians";
  if (DEAL_HINTS.test(q)) return "deals";
  return fallback;
}

// --- shared fragments -------------------------------------------------------

const NEVER_INVENT =
  "Only include things the sources actually support. Never invent names, URLs, prices, or availability. If you are unsure, leave the field out.";

// --- task definitions -------------------------------------------------------

export const TASKS = {
  games: {
    id: "games",
    label: "attention-training games",
    status: "researching",
    // Reading the official pages of what it finds is worthwhile here.
    enrich: true,
    schema: `{
  "games": [
    {
      "name": "", "audience": "e.g. children 8-17 / adults 18+",
      "access": "prescription-only | over-the-counter | free | subscription",
      "platform": "iOS / Android / web ...",
      "pricing": "current price if known",
      "description": "1-2 sentences, plain language",
      "evidence": "1 sentence on evidence or regulatory status",
      "url": "official page if found"
    }
  ],
  "note": "Message for the chat ONLY if you learned something not already in the library. Otherwise an empty string. Never write status updates."
}`,
    system: ({ knownNames }) => `You are Scout, researching legitimate, evidence-based digital therapeutics and attention-training games relevant to ADHD.

Already in the shared library (don't re-report these unless a detail has changed): ${knownNames.join(", ") || "(empty)"}

Be clear when something requires a prescription. ${NEVER_INVENT}`,
    urlsFrom: (parsed) => (parsed.games || []).map((g) => g.url),
    persist: (parsed) => saveGames(Array.isArray(parsed.games) ? parsed.games : []),
    // Did this produce anything worth interrupting the room for?
    worthSaying: (r) => r.added > 0 || r.updated > 0,
    detail: (r) =>
      r.added > 0
        ? `Added ${r.added} new item${r.added === 1 ? "" : "s"} to the library.`
        : `Updated ${r.updatedFields.slice(0, 3).join(", ")}.`,
  },

  clinicians: {
    id: "clinicians",
    label: "how to get assessed",
    status: "finding care options",
    enrich: false,
    schema: `{
  "needLocation": true or false,
  "routes": [
    { "route": "e.g. via your GP / a public ADHD service / a private psychiatrist",
      "who": "the kind of professional involved",
      "how": "the concrete first step someone takes",
      "cost": "typical cost or funding route, if known",
      "wait": "typical wait, if known" }
  ],
  "directories": [
    { "name": "", "covers": "region or country", "url": "", "why": "what it's useful for" }
  ],
  "questions": ["questions worth asking when booking"],
  "note": "1-3 sentences for the chat"
}`,
    system: ({ location }) => `You are Scout, helping someone work out how to get a real ADHD assessment${location ? ` in or near ${location}` : ""}.

WHAT TO PRODUCE
- Routes to assessment that exist ${location ? `in ${location}` : "in their area"}: public health services, GP referral, private psychiatrists/psychologists, university clinics, employer or student health schemes.
- Reputable DIRECTORIES and professional registers people can search themselves (medical boards, psychological societies, national ADHD charities, insurer directories). These are the durable, verifiable answer.
- Practical questions to ask when booking (waitlist, cost, whether they assess adults, what the assessment involves).

HARD RULES
- Do NOT rank, rate, or vouch for individual named practitioners, and do not present anyone as "the best". You cannot verify quality, and a wrong recommendation here has real consequences. Point to registers and let the person choose.
- Prefer official registers and public health pages over listicles or lead-generation sites.
- If you don't know the person's country or region, set "needLocation": true and leave the lists empty — advice for the wrong health system is worse than none.
- Never suggest that this chat, or any AI, can diagnose. The point of this task is to get them to a qualified human.
${NEVER_INVENT}`,
    urlsFrom: () => [],
    // Deliberately NOT persisted: this is location-specific to one person, and
    // the library is shared across everyone using this instance.
    persist: () => ({ games: getGames(), added: 0, updated: 0, updatedFields: [] }),
    worthSaying: () => true,
    detail: () => "",
  },

  deals: {
    id: "deals",
    label: "pricing and coverage",
    status: "checking prices",
    enrich: true,
    schema: `{
  "findings": [
    { "product": "", "price": "current list price if found",
      "offer": "free trial, discount, bundle — only if genuinely advertised",
      "eligibility": "who qualifies",
      "coverage": "insurance / FSA / HSA / public funding notes, if any",
      "url": "official source" }
  ],
  "note": "1-3 sentences for the chat"
}`,
    system: ({ knownNames }) => `You are Scout, checking what these cost and how people actually pay for them: ${knownNames.join(", ") || "ADHD attention-training apps"}.

WHAT TO LOOK FOR
- Current official list price and subscription terms from the vendor's own page.
- Legitimate savings routes: free trials, student or family plans, manufacturer discounts, insurance coverage, FSA/HSA eligibility, public health funding, patient assistance programmes.

HARD RULES
- Only official vendor pages, insurers, and reputable health sources. No coupon-aggregator spam, no resold licence keys, no grey-market sellers.
- EndeavorRx is prescription-only for ages 8-17: a cheaper price is irrelevant without a prescriber, so say that plainly rather than presenting it as a purchase option.
- Prices change constantly. Say where the figure came from and that it should be checked on the vendor's page.
${NEVER_INVENT}`,
    urlsFrom: (parsed) => (parsed.findings || []).map((f) => f.url),
    // Feed prices back into the shared library so Dr. Maple can quote them.
    persist: (parsed) =>
      saveGames(
        (parsed.findings || [])
          .filter((f) => f.product)
          .map((f) => ({ name: f.product, pricing: f.price, url: f.url }))
      ),
    worthSaying: (r, parsed) => r.added > 0 || r.updated > 0 || (parsed.findings || []).length > 0,
    detail: (r) => (r.updated > 0 ? `Updated ${r.updatedFields.slice(0, 3).join(", ")}.` : ""),
  },
};

export function getTask(id) {
  return TASKS[id] || TASKS.games;
}

// Turn a task's structured result into something readable in chat.
export function formatResult(taskId, parsed) {
  if (taskId === "clinicians") {
    if (parsed.needLocation) return "";
    const lines = [];
    for (const r of (parsed.routes || []).slice(0, 4)) {
      lines.push(
        `• ${r.route}${r.who ? ` (${r.who})` : ""} — ${r.how}${r.cost ? ` Cost: ${r.cost}.` : ""}${r.wait ? ` Typical wait: ${r.wait}.` : ""}`
      );
    }
    for (const d of (parsed.directories || []).slice(0, 4)) {
      lines.push(`• ${d.name} — ${d.why || d.covers}${d.url ? ` ${d.url}` : ""}`);
    }
    if (parsed.questions?.length) {
      lines.push(`Worth asking when you book: ${parsed.questions.slice(0, 3).join("; ")}.`);
    }
    return lines.join("\n");
  }

  if (taskId === "deals") {
    return (parsed.findings || [])
      .slice(0, 4)
      .map((f) => {
        const bits = [f.price, f.offer, f.coverage].filter(Boolean).join(" · ");
        return `• ${f.product}${bits ? ` — ${bits}` : ""}${f.url ? ` ${f.url}` : ""}`;
      })
      .join("\n");
  }

  return "";
}
