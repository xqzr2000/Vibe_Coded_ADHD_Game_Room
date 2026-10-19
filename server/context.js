// Keeping prompts inside Groq's free-tier token budget.
//
// The free plan allows 8,000 tokens per minute per model, and that budget
// covers the prompt AND the reply. Dr. Maple sends her (long) instructions plus
// the whole conversation every turn, so a long session would eventually exceed
// the limit in a single request. Trimming the oldest turns keeps every request
// comfortably inside it; the stage plan and long-term memory carry the thread.

// A deliberately pessimistic estimate (real English is ~4 chars/token), so a
// request we think fits really does.
export function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.ceil(text.length / 3.2) + 4;
}

export function messagesTokens(messages) {
  return messages.reduce((n, m) => n + estimateTokens(m.content || "") + 4, 0);
}

export const TPM_LIMIT = Number(process.env.GROQ_TPM_LIMIT || 8000);

/**
 * Keep the system message(s) and as many of the most recent messages as fit in
 * `budget` tokens. Returns { messages, dropped }.
 */
export function fitMessages(messages, budget) {
  const head = [];
  let i = 0;
  while (i < messages.length && messages[i].role === "system") head.push(messages[i++]);
  const body = messages.slice(i);

  let used = messagesTokens(head);
  const kept = [];
  for (let j = body.length - 1; j >= 0; j -= 1) {
    const cost = estimateTokens(body[j].content || "") + 4;
    // Always keep the newest message, even if it alone is large.
    if (kept.length && used + cost > budget) break;
    kept.unshift(body[j]);
    used += cost;
  }
  // A tool result is only valid right after the assistant turn that asked for
  // it; never let trimming leave one dangling at the front.
  while (kept.length > 1 && kept[0].role === "tool") kept.shift();
  const dropped = body.length - kept.length;
  if (dropped > 0) {
    head.push({
      role: "system",
      content: `(Older conversation trimmed to fit the model's limit: ${dropped} earlier message${dropped === 1 ? "" : "s"} not shown. Don't mention this.)`,
    });
  }
  return { messages: [...head, ...kept], dropped };
}

/** Input budget for a call that may produce up to `maxTokens` of output. */
export function inputBudget(maxTokens, { share = 0.85 } = {}) {
  return Math.max(1200, Math.floor(TPM_LIMIT * share) - maxTokens);
}
