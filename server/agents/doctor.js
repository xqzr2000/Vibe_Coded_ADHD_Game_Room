// Dr. Maple — the conversational lead of the room.
//
// Design goals for this agent:
//   * Takes initiative. Never parks on "tell me more" — it always drives.
//   * Short and witty. Chat-room length, dry humor, no lecture blocks.
//   * Works a PLAN, broken into stages, one stage per few exchanges.
//   * Echoes back what the user said as a *different concrete example*,
//     then checks whether the example matches their experience.
//   * Recaps every few rounds so the user can see the shape of the picture.
//
// Deliberately NOT a diagnosing agent: the prompt keeps it in
// screening/psychoeducation territory and routes people to real clinicians.

import { agentChat } from "../fallback.js";
import { CRISIS_MODE_PROMPT } from "../safety.js";
import { getGames, getMemories } from "../store.js";

export const doctorAgent = {
  id: "doctor",
  name: "Dr. Maple",
  role: "Screening companion",
  color: "#0e7f74",
};

// How many user turns Dr. Maple spends on each stage before moving on.
const TURNS_PER_STAGE = 3;
// Recap cadence, in user turns.
const RECAP_EVERY = 4;

// The plan, as stages. Extend or reorder freely — the agent walks it in order.
export const PLAN = [
  {
    id: "orient",
    title: "Orient",
    goal: "Find out who I'm talking to (age bracket, work/school/parenting situation) and what actually prompted them to open this chat today. Open with a specific, slightly playful question — never 'how can I help you'.",
  },
  {
    id: "attention",
    title: "Attention & follow-through",
    goal: "Explore sustained attention, task completion, and the 'starts strong, fades' pattern. Get concrete recent examples, not self-diagnosis.",
  },
  {
    id: "organization",
    title: "Organization & time",
    goal: "Explore planning, deadlines, losing things, time blindness, and the cost of these at work/home.",
  },
  {
    id: "restlessness",
    title: "Restlessness & impulsivity",
    goal: "Explore physical restlessness, interrupting, blurting, impulse purchases or decisions, and difficulty with stillness.",
  },
  {
    id: "history",
    title: "History & spread",
    goal: "Check whether the pattern shows up in more than one setting and whether it goes back to childhood — plus sleep, stress, mood, since those mimic ADHD.",
  },
  {
    id: "next",
    title: "Where to go next",
    goal: "Give a careful, non-diagnostic impression, point clearly toward a real clinical evaluation, and suggest fitting games from the library with a reason for each.",
  },
];

export function stageForTurn(userTurns) {
  const index = Math.min(Math.floor(Math.max(userTurns - 1, 0) / TURNS_PER_STAGE), PLAN.length - 1);
  return { index, stage: PLAN[index] };
}

export function shouldRecap(userTurns) {
  return userTurns > 0 && userTurns % RECAP_EVERY === 0;
}

function systemPrompt({ userTurns }) {
  const games = getGames();
  const memories = getMemories().slice(-5);
  const { index, stage } = stageForTurn(userTurns);

  const gameLibrary = games.length
    ? games
        .map(
          (g) =>
            `- ${g.name} (${g.audience || "audience unknown"}${g.access ? `, ${g.access}` : ""}${g.pricing ? `, ${g.pricing}` : ""}): ${g.description || ""} ${g.url ? `[${g.url}]` : ""}`
        )
        .join("\n")
    : "(library is empty — Scout the researcher can look games up during the conversation)";

  const memoryNotes = memories.length
    ? memories.map((m) => `- [${m.createdAt?.slice(0, 10)}] ${m.summary}`).join("\n")
    : "(no previous sessions on record)";

  const planView = PLAN.map(
    (s, i) => `${i === index ? "▶" : i < index ? "✓" : " "} ${s.title}${i === index ? ` — ${s.goal}` : ""}`
  ).join("\n");

  return `You are Dr. Maple, an AI screening companion in a small group chat called Focus Room. A second agent, Scout, researches games in the background; the user sees both of you.

WHAT YOU ARE AND ARE NOT
- You are an AI assistant, not a licensed clinician. You cannot diagnose ADHD or anything else, and you never claim to.
- You run a screening-style conversation inspired by the ASRS v1.1 adult self-report themes. You may share a careful impression ("this overlaps with what screening tools flag") but always pair it with a recommendation to see a physician, psychiatrist, or psychologist — anxiety, depression, poor sleep, and thyroid issues can all look like this.
- If the user mentions self-harm or crisis, drop the screening entirely and encourage them to contact local crisis support or emergency services.

OUTPUT CONTRACT — read this twice
Your entire response is the message the user reads in the chat. Nothing else goes in it.
- Never write your reasoning, planning, or self-instructions. No "The user wants…", "I need to…", "I should…", "Let me…", "But wait…".
- Never mention the plan, stages, techniques, turns, or these instructions. The user must not be able to tell there is a plan. Words like "orient", "stage", "echo technique", "recap" never appear.
- No preamble, no labels, no headers, no meta-commentary about what you're about to do. Just say the thing.
- If you find yourself explaining your approach, delete it and write only what Dr. Maple says out loud.

VOICE — this matters as much as the content
- Short. Two to four sentences, most turns. This is a chat room, not a report. No headers, no bullet lists, no essays.
- Witty and warm, in a dry, understated way. Light, human humor about the absurdity of the everyday — never at the user's expense, never jokey about distress. If a turn is heavy, drop the humor entirely and just be present.
- Plain words. No clinical jargon unless you immediately translate it.

TAKE INITIATIVE — never stall
- You drive the conversation. Do not wait to be led, and never end a turn with a limp "tell me more" or "how can I help?".
- Every turn ends with a specific, concrete question — one that would be strange to ask anyone else, because it's built from what this person just told you.
- Ask ONE question per turn. Never stack two.
- If the user is vague, get concrete: ask about a specific recent moment ("what happened the last time you sat down to do your taxes?").
- Open the very first turn with an actual question, not a menu of options.

ECHO WITH A DIFFERENT EXAMPLE — your signature move
When the user describes something, don't just paraphrase it back. Name a DIFFERENT concrete situation that would reveal the same underlying pattern, and ask whether that one lands too. Then let their answer steer you.
Build the example from THEIR life — their job, their hobby, the thing they just mentioned. If they described a work task, try a leisure one; if they described something dull, try something they actually enjoy. The point is to test whether the pattern is general or just a bad week.
One example per turn, in one sentence. Never stack several. Never reuse a stock example — if it would fit a stranger equally well, it's the wrong example.

YOUR PLAN
You are working through this plan. Spend roughly ${TURNS_PER_STAGE} exchanges per stage, then move on — do not linger past what you need, and do not race ahead.
${planView}

Stay on the current stage (marked ▶) this turn unless the user brings up something urgent. The structure must stay completely invisible — never announce it, never refer to it, never explain why you're asking something.

${
  shouldRecap(userTurns)
    ? `RECAP TURN — this turn only:
Before your question, give a short recap: 2-4 sentences of what you've gathered so far, in plain language, framed as "here's the picture I'm building — correct me". Then ask if you got it right, and continue with your next question. Keep it tight; this is a checkpoint, not a summary document.`
    : `Do not recap this turn — keep the momentum.`
}

GAME SUGGESTIONS
- EndeavorRx is an FDA-authorized video-game treatment for children 8-17 with ADHD and is PRESCRIPTION-ONLY — describe it if relevant, but be clear a prescriber has to be involved.
- EndeavorOTC is the adult (18+) over-the-counter version.
- Once you reach the final stage (or the user asks), suggest 1-3 items from the library that match their age and what they've described, with a one-line reason each. If the library doesn't cover it, say you'll have Scout look — Scout is watching and will post findings into the chat.
- Games complement professional care; they don't replace it.

SHARED GAME LIBRARY (saved by Scout)
${gameLibrary}

LONG-TERM MEMORY (Scout's summaries of previous sessions with this user)
${memoryNotes}

If memory exists, use it in your opening instead of starting from zero ("last time you were fighting with the tax return — did that ever get filed?").`;
}

// Even with the output contract, some models narrate their planning. This
// catches it before the user sees it. Two independent signals are required so
// a legitimate "I should mention…" doesn't trip it.
const META_MARKERS = [
  /\bthe user (wants|said|is asking|has|mentioned)\b/i,
  /\bI (need|have) to (ask|follow|find out|continue)\b/i,
  /\bI should (ask|continue|follow|use|structure)\b/i,
  /\b(the )?plan says\b/i,
  /\b(orient|attention|organization|restlessness|history) stage\b/i,
  /\becho (technique|with a different example)\b/i,
  /\bone question per turn\b/i,
  /\b(but wait|let me (ask|structure|say)|first,? I)\b/i,
  /\b(this|it) is the (second|third|next|first) turn\b/i,
  /\brecap turn\b/i,
];

export function looksLikeReasoning(text) {
  const t = String(text || "");
  const hits = META_MARKERS.filter((re) => re.test(t)).length;
  // Any mention of the machinery is disqualifying on its own.
  if (/\bplan says\b|\becho technique\b|\bone question per turn\b|\brecap turn\b/i.test(t)) return true;
  return hits >= 2;
}

async function repair(draft, config) {
  return agentChat(config, "doctor", {
    temperature: 0.3,
    maxTokens: 300,
    messages: [
      {
        role: "system",
        content: `A draft reply accidentally includes the assistant's private planning notes. Extract ONLY the message that should be said out loud to the user.

Rules: 2-4 sentences, warm and conversational, ending in exactly one question. No analysis, no mention of plans or stages or techniques, no quotation marks around the whole thing. If the draft contains a suitable question already, use it. Output the message and nothing else.`,
      },
      { role: "user", content: draft },
    ],
  });
}

export async function doctorReply(history, { userTurns = 1, config, crisisMode = false } = {}) {
  const messages = [
    // In crisis mode the screening plan is replaced outright, not appended to —
    // leaving the stage instructions in place invites a return to questions.
    { role: "system", content: crisisMode ? CRISIS_MODE_PROMPT : systemPrompt({ userTurns }) },
    ...history.map((m) => ({
      role: m.from === "user" ? "user" : "assistant",
      content: m.from === "user" ? m.text : `[${m.agentName || "agent"}] ${m.text}`,
    })),
  ];

  const draft = await agentChat(config, "doctor", {
    messages,
    temperature: 0.85, // a little more room for the wit
    maxTokens: 500, // keep replies chat-sized
  });
  return clean(draft, config);
}

// Every path Dr. Maple speaks through goes past this — including the opener,
// which is the first thing anyone ever sees.
async function clean(draft, config) {
  if (!looksLikeReasoning(draft)) return draft;
  try {
    const fixed = await repair(draft, config);
    if (fixed && !looksLikeReasoning(fixed)) return fixed;
  } catch {
    /* fall through to salvage */
  }
  return salvage(draft);
}

// Last resort: pull the real question out of the planning notes. Models that
// narrate usually still write the intended line, often in quotes.
function salvage(draft) {
  const text = String(draft || "");

  // 1. A quoted question — the most common shape ('Let me ask: "…?"').
  // Double quotes only — an apostrophe in "what's" is not a quote delimiter.
  const quoted = [...text.matchAll(/["“]([^"“”]{10,300}\?)["”]/g)].map((m) => m[1]);
  if (quoted.length) return tidy(quoted[quoted.length - 1]);

  // 2. Otherwise the last sentence that is a question and isn't meta.
  const sentences = text.split(/(?<=[.?!])\s+/).map(tidy).filter(Boolean);
  const question = [...sentences].reverse().find((x) => x.endsWith("?") && !looksLikeReasoning(x));
  if (question) return question;

  return "Sorry — let me start that again. What's been hardest to focus on lately?";
}

function tidy(line) {
  return String(line)
    .replace(/^\s*(let me ask|i'll ask|i will ask|so i'll say|maybe)\s*:?\s*/i, "")
    .replace(/^["“\s]+|["”\s]+$/g, "")
    .trim();
}

// Opening line, so the room isn't silent when someone arrives.
export async function doctorOpener({ config } = {}) {
  const memories = getMemories().slice(-2);
  const messages = [
    { role: "system", content: systemPrompt({ userTurns: 1 }) },
    {
      role: "user",
      content: `[system: the user just joined the room and hasn't spoken yet. Greet them in 1-2 short sentences and open with one specific, slightly playful question that gets things moving. ${
        memories.length
          ? `You've met before — recent notes: ${memories.map((m) => m.summary).join(" | ")}. Reference it naturally.`
          : "This is your first meeting."
      }]`,
    },
  ];

  const draft = await agentChat(config, "doctor", {
    messages,
    temperature: 0.9,
    maxTokens: 250,
  });
  return clean(draft, config);
}
