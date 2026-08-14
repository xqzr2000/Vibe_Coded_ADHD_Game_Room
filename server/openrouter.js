// Thin OpenRouter client. All agents share this.
// Docs: https://openrouter.ai/docs

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export async function chat({
  model,
  messages,
  online = false, // appends :online -> OpenRouter runs a web search for the model
  json = false, // ask for a JSON object response
  temperature = 0.7,
  maxTokens = 1400,
}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not set. Copy .env.example to .env (or add a Codespaces secret) and restart."
    );
  }

  const body = {
    model: online ? `${model}:online` : model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (json) body.response_format = { type: "json_object" };

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/your-org/focus-room",
      "X-Title": "Focus Room",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("OpenRouter returned an empty response.");
  }
  return content.trim();
}

// Best-effort JSON extraction: models sometimes wrap JSON in ``` fences.
export function parseJson(text) {
  const cleaned = text
    .replace(/^```(?:json)?/im, "")
    .replace(/```\s*$/m, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found in model output.");
  return JSON.parse(cleaned.slice(start, end + 1));
}
