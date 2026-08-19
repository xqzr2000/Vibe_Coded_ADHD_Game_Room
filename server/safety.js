// Deterministic safety checks.
//
// Everything else in Focus Room degrades gracefully when a model is weak, slow,
// or swapped out underneath us. This must not. A screening conversation invites
// people to describe how badly things are going, so the response to a crisis
// disclosure cannot depend on which free model happened to win the fallback
// race this minute. These checks run in code, before any model is called.
//
// Design notes:
//  * Recall matters more than precision here, but false positives have a cost
//    too — being handed crisis resources for saying "this spreadsheet is
//    killing me" is jarring and teaches people the app doesn't listen. Idioms
//    are stripped first, then intent patterns are matched against what's left.
//  * We never name or describe methods, including when acknowledging what
//    someone said.

// Figures of speech that contain crisis words but carry no crisis meaning.
const IDIOMS = [
  /\b(is|are|was|were|it'?s)\s+killing\s+(me|us)\b/gi,
  /\bkill(ing)?\s+time\b/gi,
  /\bcould\s+(kill|murder)\s+(for\s+)?a\b/gi,
  /\bdying\s+to\s+\w+/gi,
  /\bdie\s+of\s+(boredom|embarrassment|laughter)\b/gi,
  /\brather\s+die\s+than\b/gi,
  /\bdead\s+(tired|line|lines|weight|end|ends)\b/gi,
  /\bdeadlines?\b/gi,
  /\b(my|the|his|her|their)\s+(phone|laptop|battery|car|computer)\s+die[ds]?\b/gi,
  /\bhalf\s+dead\b/gi,
  /\bkiller\s+(app|feature|deal)\b/gi,
];

// Direct statements of intent or ideation.
const CRISIS_PATTERNS = [
  /\bkill(ing)?\s+my\s?self\b/i,
  /\bsuicide\b/i, // covers "thinking about suicide", "suicide attempt", etc.
  /\bsuicidal\b/i,
  /\btake\s+my\s+own\s+life\b/i,
  /\bkill\s+me\s?self\b/i,
  /\b(want|wanting|going|plan|planning|thinking about|think about)\s+(to\s+)?(die|end\s+(it|my\s+life)|kill\s+my\s?self)\b/i,
  /\bend(ing)?\s+(it\s+all|my\s+life)\b/i,
  /\b(don'?t|do\s+not|no\s+longer)\s+want\s+to\s+(be\s+(here|alive)|live|wake\s+up)\b/i,
  /\b(no|not\s+any)\s+(point|reason)\s+(in|to)\s+(living|going\s+on|being\s+here)\b/i,
  /\bbetter\s+off\s+(without\s+me|dead|if\s+i\s+(was|were)\s+(gone|dead))\b/i,
  /\b(hurt|harm|cut|cutting)\s+my\s?self\b/i,
  /\bself[-\s]?harm(ing)?\b/i,
  /\bwant\s+to\s+disappear\s+(forever|for\s+good)\b/i,
];

// Serious distress that isn't a stated intent — worth softening toward, but not
// worth overriding the conversation for.
const DISTRESS_PATTERNS = [
  /\b(can'?t|cannot)\s+(go\s+on|take\s+(it|this)\s+any\s?more|cope)\b/i,
  /\b(hopeless|worthless|a\s+burden\s+to\s+everyone)\b/i,
  /\bfalling\s+apart\b/i,
  /\brock\s+bottom\b/i,
];

function stripIdioms(text) {
  let out = String(text || "");
  for (const idiom of IDIOMS) out = out.replace(idiom, " ");
  return out;
}

/**
 * @returns {{ level: "none"|"distress"|"crisis" }}
 */
export function assessRisk(text) {
  const cleaned = stripIdioms(text);
  if (CRISIS_PATTERNS.some((re) => re.test(cleaned))) return { level: "crisis" };
  if (DISTRESS_PATTERNS.some((re) => re.test(cleaned))) return { level: "distress" };
  return { level: "none" };
}

// The message Dr. Maple sends on a crisis disclosure. Fixed text, written once,
// deliberately not model-generated: it should read the same on a bad day for
// the API as on a good one. No methods are named or asked about.
export const CRISIS_RESPONSE = `I want to stop the questions for a moment, because what you just said matters more than anything else we were doing.

I'm an AI, and this is beyond what I can help with — but you shouldn't have to sit with it alone. Please reach out to someone who can actually be there:

• If you're in immediate danger, call your local emergency number.
• In the US and Canada, you can call or text 988 to reach the Suicide & Crisis Lifeline.
• Anywhere else, findahelpline.com lists free, confidential lines by country.
• If there's someone you trust — a friend, family member, your doctor — telling them tonight is worth more than anything I can offer.

I'm still here if you want to keep talking. We can leave the screening questions where they are.`;

// Once someone has disclosed a crisis, the screening flow is the wrong shape
// for the rest of the conversation. This replaces Dr. Maple's plan.
export const CRISIS_MODE_PROMPT = `The person in this conversation has disclosed thoughts of suicide or self-harm. Everything below overrides your usual instructions.

- The ADHD screening is over. Do not return to the plan, the stages, or the questions. Do not suggest games or apps. Do not offer a PDF or mention long-term memory.
- Be present and human. Short replies. Listen more than you speak. Reflect back what they've said without minimizing it, dramatizing it, or rushing to fix it.
- Do not ask about methods, plans, or means, and never name or describe any. Do not ask them to promise anything.
- Gently keep the door open to real-world support — a crisis line, their doctor, someone they trust — without repeating the resource list every message, and without pressuring them.
- Never suggest that talking to you is a substitute for a person. You are a stopgap, and it's fine to say so.
- If they change the subject or say they're okay, follow their lead rather than interrogating them, but stay warm and don't jump back into screening questions.`;
