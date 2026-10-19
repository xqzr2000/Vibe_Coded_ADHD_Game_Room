// When may an agent use the user's name?
//
// Prompting alone does not work here. Told "use their name occasionally,"
// models either open every message with it or never use it once. So the
// decision is made in code — the same pattern as skipResearchReason() and
// safety.js — and the model is told, per turn, exactly what it may do.
//
// Natural beats are deliberately few: the opening, a welcome back, a recap,
// and re-engagement after a crisis moment. Roughly one use every four to six
// turns, which reads as warmth rather than a sales script.

const COOLDOWN_TURNS = 4;
const RETURNING_GAP_MS = 6 * 60 * 60 * 1000;

/**
 * @returns {{allow: boolean, reason: string, nickname: string}}
 */
export function nameBudget({ nickname, userTurns = 0, lastNameTurn, lastSeenAt, recap = false } = {}) {
  const name = String(nickname || "").trim();
  if (!name) return { allow: false, reason: "no nickname", nickname: "" };

  const last = Number.isFinite(lastNameTurn) ? lastNameTurn : -Infinity;
  const since = userTurns - last;

  if (userTurns <= 1) return { allow: true, reason: "greeting", nickname: name };
  if (since < COOLDOWN_TURNS) return { allow: false, reason: "cooldown", nickname: name };
  if (lastSeenAt && Date.now() - lastSeenAt > RETURNING_GAP_MS) {
    return { allow: true, reason: "welcome back", nickname: name };
  }
  if (recap) return { allow: true, reason: "recap beat", nickname: name };
  return { allow: false, reason: "no natural beat", nickname: name };
}

/** The line handed to the model for this turn. */
export function nameInstruction(budget) {
  if (!budget.nickname) return "The user has not given a name. Never invent one or ask for one.";
  return budget.allow
    ? `The user's name is ${budget.nickname}. You may address them by name ONCE in this reply, where it lands naturally. Do not use it more than once.`
    : `The user's name is ${budget.nickname}, but do NOT use it in this reply. Address them directly instead.`;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Enforce the budget on generated text.
 *
 * Plain string replacement is wrong here: a nickname of "Ann" would mangle
 * "announced", "Al" would wreck "already". Matching uses lookarounds against
 * letters and marks so it works for non-ASCII names too, where \b is unreliable.
 * Removing a vocative also strands its punctuation ("Sure, Ann, that…"), so the
 * comma goes with it.
 */
export function enforceNameLimit(text, budget) {
  const name = budget?.nickname;
  if (!name || !text) return text;

  const n = escapeRe(name);
  // Vocative form first: ", Ann," / "Ann, " / " — Ann". Take the *separating*
  // punctuation with it, but never terminal punctuation — eating the "?" from
  // "how did it go, Ann?" would turn a question into a fragment.
  const vocative = new RegExp(
    `(?<![\\p{L}\\p{M}])[,;:—-]?\\s*${n}\\s*[,;:]?(?![\\p{L}\\p{M}])`,
    "giu"
  );
  const bare = new RegExp(`(?<![\\p{L}\\p{M}])${n}(?![\\p{L}\\p{M}])`, "giu");

  let kept = false;
  const out = text.replace(vocative, (match) => {
    if (budget.allow && !kept) {
      kept = true;
      return match;
    }
    // Keep a separating space when the match sat between two words.
    return /^\s/.test(match) && /\s$/.test(match) ? " " : "";
  });

  return tidy(bare.test(out) && !budget.allow ? out.replace(bare, "") : out);
}

/** Removing a sentence-initial name leaves a lowercase start. Put it back. */
function recapitalize(s) {
  return s.replace(/(^|[.!?]\s+|\n\s*)(\p{Ll})/gu, (_, lead, ch) => lead + ch.toUpperCase());
}

function tidy(s) {
  return recapitalize(
    s
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/([,;:])\s*([,.;:!?])/g, "$2")
      .replace(/(^|\n)\s*[,;:]\s*/g, "$1")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .trim()
  );
}
