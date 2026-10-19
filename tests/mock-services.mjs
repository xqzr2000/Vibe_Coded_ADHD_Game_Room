// A stand-in for Groq, Tavily, DuckDuckGo and a couple of web pages, so the
// whole app can be exercised end to end without network access or real keys.
//
//   node tests/mock-services.mjs 4010     (standalone, for manual UI testing)
//
// Behaviour knobs (set on the returned `control` object):
//   control.fail[model] = n      next n calls to that model return 429
//   control.delayMs              pause between streamed tokens

import http from "node:http";

const FREE = ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"];

export function startMockServices(port = 0) {
  const control = { fail: {}, delayMs: 8, calls: [], tavilyCalls: [], ddgCalls: 0 };
  const quota = new Map(FREE.map((m) => [m, 1000]));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    let body = "";
    for await (const c of req) body += c;
    const json = body ? safeJson(body) : {};
    const base = `http://127.0.0.1:${server.address().port}`;

    // ---- Groq ----
    if (url.pathname === "/openai/v1/models") {
      if (!/^Bearer gsk_/.test(req.headers.authorization || "")) return send(res, 401, { error: { message: "Invalid API Key", code: "invalid_api_key" } });
      return send(res, 200, { data: [...FREE, "some/paid-model"].map((id) => ({ id })) });
    }
    if (url.pathname === "/openai/v1/chat/completions") {
      if (!/^Bearer gsk_/.test(req.headers.authorization || "")) return send(res, 401, { error: { message: "Invalid API Key", code: "invalid_api_key" } });
      const model = json.model;
      control.calls.push({ model, stream: json.stream, tools: (json.tools || []).map((t) => t.function?.name || t.type), msgs: json.messages?.length, body: json });
      if (!FREE.includes(model)) return send(res, 404, { error: { message: `The model ${model} does not exist`, code: "model_not_found" } });
      const left = quota.get(model) - 1;
      quota.set(model, left);
      const headers = {
        "x-ratelimit-limit-requests": "1000",
        "x-ratelimit-remaining-requests": String(left),
        "x-ratelimit-reset-requests": "1m26.4s",
        "x-ratelimit-limit-tokens": "8000",
        "x-ratelimit-remaining-tokens": "7400",
        "x-ratelimit-reset-tokens": "4.5s",
      };
      if (control.fail[model] > 0) {
        control.fail[model] -= 1;
        return send(res, 429, { error: { message: `Rate limit reached for model ${model} on tokens per minute (TPM)`, code: "rate_limit_exceeded" } }, { ...headers, "retry-after": "7" });
      }
      const plan = respond(json, base);
      if (!json.stream) {
        return send(res, 200, {
          choices: [{ message: { role: "assistant", content: plan.content || null, reasoning: plan.reasoning, tool_calls: plan.toolCalls?.map(toOpenAiCall), executed_tools: plan.executed }, finish_reason: plan.toolCalls ? "tool_calls" : "stop" }],
          usage: { total_tokens: 300 },
        }, headers);
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", ...headers });
      const chunk = (delta, extra = {}) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, ...extra }] })}\n\n`);
      const wantsReasoning = json.include_reasoning === true || json.reasoning_format === "parsed";
      if (wantsReasoning && plan.reasoning) for (const w of words(plan.reasoning)) { chunk({ reasoning: w }); await sleep(control.delayMs); }
      if (plan.toolCalls) {
        plan.toolCalls.forEach((tc, i) => chunk({ tool_calls: [{ index: i, ...toOpenAiCall(tc) }] }));
      } else if (plan.executed) {
        chunk({ executed_tools: plan.executed });
      }
      if (plan.content) for (const w of words(plan.content)) { chunk({ content: w }); await sleep(control.delayMs); }
      chunk({}, { finish_reason: plan.toolCalls ? "tool_calls" : "stop" });
      res.write(`data: ${JSON.stringify({ choices: [], x_groq: { usage: { total_tokens: 320 } } })}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    // ---- Tavily ----
    if (url.pathname.startsWith("/tavily/")) {
      if (!/^Bearer tvly-/.test(req.headers.authorization || "")) return send(res, 401, { detail: { error: "Unauthorized" } });
      control.tavilyCalls.push(url.pathname);
      if (url.pathname === "/tavily/usage") {
        return send(res, 200, { key: { usage: 12, limit: null }, account: { current_plan: "Researcher", plan_usage: 12, plan_limit: 1000, paygo_usage: 0, paygo_limit: 0 } });
      }
      if (url.pathname === "/tavily/search") {
        return send(res, 200, {
          query: json.query,
          results: [
            { title: "EndeavorOTC — official site", url: `${base}/pages/endeavor`, content: "EndeavorOTC is an FDA-authorized attention game for adults with ADHD. Subscription pricing.", score: 0.9 },
            { title: "ADHD digital therapeutics overview", url: `${base}/pages/overview`, content: "Overview of attention-training apps and the evidence behind them.", score: 0.8 },
            { title: "Forum thread", url: "https://forum.example.org/t/123", content: "People discussing apps.", score: 0.3 },
          ],
          response_time: 0.4,
          usage: { credits: 1 },
        });
      }
      if (url.pathname === "/tavily/extract") {
        const urls = Array.isArray(json.urls) ? json.urls : [json.urls];
        return send(res, 200, {
          results: urls.filter((u) => u.includes("/pages/")).map((u) => ({ url: u, raw_content: pageText(u) })),
          failed_results: urls.filter((u) => !u.includes("/pages/")).map((u) => ({ url: u, error: "blocked" })),
          usage: { credits: 1 },
        });
      }
    }

    // ---- DuckDuckGo HTML ----
    if (url.pathname === "/ddg/html/") {
      control.ddgCalls += 1;
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(ddgHtml(base));
    }

    // ---- web pages ----
    if (url.pathname.startsWith("/pages/")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(`<html><head><title>${url.pathname}</title></head><body><nav>menu</nav><main><h1>Page</h1><p>${pageText(url.pathname)}</p></main></body></html>`);
    }
    send(res, 404, { error: "not found" });
  });

  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, control, port: server.address().port })));
}

function pageText(u) {
  if (String(u).includes("endeavor")) return "EndeavorOTC is available on iOS and Android for adults 18 and over. It costs $24.99 per month or $129.99 per year. It is FDA-authorized as an over-the-counter digital therapeutic. ".repeat(3);
  return "Attention-training apps vary in evidence. Look for regulatory status and published trials. ".repeat(4);
}

function ddgHtml(base) {
  const r = (href, title, snip) => `<div class="result results_links results_links_deep web-result"><div class="links_main"><h2 class="result__title"><a rel="nofollow" class="result__a" href="${href}">${title}</a></h2><a class="result__snippet" href="${href}">${snip}</a></div></div>`;
  return `<html><body>
  <div class="result result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Sponsored thing</a></div>
  ${r(`//duckduckgo.com/l/?uddg=${encodeURIComponent(base + "/pages/endeavor")}&amp;rut=abc`, "Endeavor<b>OTC</b> &amp; you", "Official <b>site</b> for adults")}
  ${r(`//duckduckgo.com/l/?uddg=${encodeURIComponent(base + "/pages/overview")}&amp;rut=def`, "Overview of apps", "Evidence &#39;matters&#39;")}
  </body></html>`;
}

// Decide what the fake model says, from the shape of the request.
function respond(req, base) {
  const msgs = req.messages || [];
  const system = String(msgs.find((m) => m.role === "system")?.content || "");
  const last = msgs[msgs.length - 1] || {};
  const toolNames = (req.tools || []).map((t) => t.function?.name || t.type);

  if (toolNames.includes("browser_search")) {
    return {
      reasoning: "I will search the web for this.",
      executed: [{ index: 0, type: "browser_search", arguments: JSON.stringify({ query: "EndeavorOTC price" }), search_results: { results: [{ title: "EndeavorOTC", url: `${base}/pages/endeavor` }] } }],
      content: JSON.stringify({ games: [{ name: "EndeavorOTC", pricing: "$24.99/month", url: `${base}/pages/endeavor` }], note: "Found via browser search." }),
    };
  }
  if (toolNames.includes("web_search")) {
    const toolMsgs = msgs.filter((m) => m.role === "tool");
    if (toolMsgs.length === 0) {
      return { reasoning: "The user wants current pricing for adult attention apps. I should search for the official EndeavorOTC page first.", toolCalls: [{ id: "call_1", name: "web_search", arguments: JSON.stringify({ query: "EndeavorOTC price adults" }) }] };
    }
    if (toolMsgs.length === 1) {
      return { reasoning: "The first result is the official site. Reading it and the overview.", toolCalls: [{ id: "call_2", name: "read_pages", arguments: JSON.stringify({ urls: [`${base}/pages/endeavor`, `${base}/pages/overview`, "https://forum.example.org/t/123"] }) }] };
    }
    if (/"findings"/.test(system)) {
      return {
        reasoning: "The page confirms the price. Writing the JSON.",
        content: JSON.stringify({ findings: [{ product: "EndeavorOTC", price: "$24.99/month or $129.99/year", offer: "", eligibility: "adults 18+", coverage: "", url: `${base}/pages/endeavor` }], note: "EndeavorOTC is $24.99 a month or $129.99 a year, per the official page." }),
      };
    }
    return {
      reasoning: "The page confirms the price and platforms. Writing the JSON.",
      content: JSON.stringify({
        games: [{ name: "EndeavorOTC", audience: "adults 18+", access: "over-the-counter", platform: "iOS / Android", pricing: "$24.99/month or $129.99/year", description: "Adult attention-training game.", evidence: "FDA-authorized OTC digital therapeutic.", url: `${base}/pages/endeavor` }],
        note: "EndeavorOTC is $24.99 a month or $129.99 a year, per the official page.",
      }),
    };
  }
  if (req.response_format?.type === "json_object" || /JSON object/.test(system)) {
    if (/Summarize this Focus Room session/.test(system)) return { content: JSON.stringify({ summary: "The user talked about focus at work.", keyPoints: ["focus"], gamesDiscussed: [], followUps: ["ask about sleep"] }) };
    if (/professional statement/.test(system)) return { content: JSON.stringify({ purpose: "A summary.", summary: "The user reported difficulty focusing.", reportedExperiences: ["drifting in meetings"], areasDiscussed: ["attention"], resourcesReviewed: [], nextSteps: ["see a clinician"], questionsForClinician: ["what else could cause this?"] }) };
    return { content: JSON.stringify({ games: [{ name: "EndeavorOTC", pricing: "$24.99/month", url: `${base}/pages/endeavor` }], note: "Pricing from the official page." }) };
  }
  // Dr. Maple
  const name = (system.match(/The user's name is ([^.,]+)\. You may address/) || [])[1];
  if (/just joined the room/.test(String(last.content || ""))) {
    return { reasoning: "Greet warmly.", content: `${name ? `Hi ${name}! ` : "Hi! "}I'm Dr. Maple. What's the last thing you meant to do today that's still sitting there, quietly judging you?` };
  }
  return { reasoning: "Ask about a concrete example.", content: "That sounds frustrating — the meeting drifts and so do you. When you're doing something you actually enjoy, like cooking, does your mind still wander off mid-recipe?" };
}

function toOpenAiCall(tc) {
  return { id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } };
}
const words = (s) => String(s).match(/\S+\s*/g) || [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function safeJson(s) {
  try { return JSON.parse(s); } catch { return Object.fromEntries(new URLSearchParams(s)); }
}
function send(res, status, obj, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = await startMockServices(Number(process.argv[2] || 4010));
  console.log(`mock services on http://127.0.0.1:${port}`);
}
