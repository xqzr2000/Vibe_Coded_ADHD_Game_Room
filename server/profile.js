// The user's preferred name and icon.
//
// No accounts: the profile lives in the browser (localStorage) and is sent to
// the server when the page connects or when it changes in Settings. The server
// validates it and keeps it in memory for the session, so the agents can use
// the name (sparingly — see server/nickname.js).

const AGENT_NAMES = ["dr. maple", "dr maple", "maple", "scout"];

export const AVATAR_EMOJI = ["🌱", "🍁", "🦊", "🐢", "🌙", "⚓", "🧭", "🎧", "☕", "🪴", "🐚", "🔭", "🧩", "🌤"];
export const AVATAR_COLORS = ["#0e7f74", "#a4551e", "#4a5d8a", "#7a5c9e", "#2f7a4f", "#8a4b4b"];
export const DEFAULT_PROFILE = { nickname: "", avatarEmoji: "🌱", avatarColor: "#0e7f74" };

export function validateNickname(raw) {
  // eslint-disable-next-line no-control-regex
  const cleaned = String(raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return { ok: true, value: "" }; // no name is a valid choice
  if ([...cleaned].length > 24) return { ok: false, error: "Names are limited to 24 characters." };
  if (AGENT_NAMES.includes(cleaned.toLowerCase())) {
    return { ok: false, error: "That's one of the agents — pick something else so the transcript stays readable." };
  }
  return { ok: true, value: cleaned };
}

/** Clean a browser-supplied profile. Unknown icons/colors fall back to defaults. */
export function sanitizeProfile(input = {}) {
  const name = validateNickname(input.nickname);
  return {
    profile: {
      nickname: name.ok ? name.value : "",
      avatarEmoji: AVATAR_EMOJI.includes(input.avatarEmoji) ? input.avatarEmoji : DEFAULT_PROFILE.avatarEmoji,
      avatarColor: AVATAR_COLORS.includes(input.avatarColor) ? input.avatarColor : DEFAULT_PROFILE.avatarColor,
    },
    error: name.ok ? "" : name.error,
  };
}
