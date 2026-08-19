// Focus Room gateway — a tiny, OpenClaw-inspired control plane:
// one server that hosts the web UI, holds the session, and routes
// each user message through the agents.

import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import { agents } from "./agents/registry.js";
import { doctorAgent, doctorReply, doctorOpener } from "./agents/doctor.js";
import {
  researcherAgent,
  shouldResearch,
  skipResearchReason,
  research,
  summarizeSession,
  professionalStatement,
} from "./agents/researcher.js";
import { getGames, getMemories } from "./store.js";
import { getTask } from "./agents/scout-tasks.js";
import { assessRisk, CRISIS_RESPONSE } from "./safety.js";
import { runDiagnostics } from "./diagnose.js";
import { renderReportPdf } from "./report.js";
import { publicProviderList } from "./providers.js";
import { listModels, LlmError } from "./llm.js";
import { defaultConfig, configStatus, savePrefs, PRESETS } from "./config.js";
import { isConstrainedFree } from "./fallback.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
// Written on listen, removed on exit. Lets `npm run stop` target this exact
// process instead of guessing, and lets a second start explain itself.
const PID_FILE = path.join(__dirname, "..", ".focus-room.pid");
const AUTO_SUMMARY_EVERY = 8; // paid/owned-account cadence
const FREE_AUTO_SUMMARY_EVERY = 16; // preserve scarce free requests for replies

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

// Providers + one-click presets for the settings panel.
app.get("/api/providers", (_req, res) =>
  res.json({ providers: publicProviderList(), presets: PRESETS })
);

// Model catalogue proxy. The key is used for this request and discarded —
// it is never logged or written to disk.
app.post("/api/models", async (req, res) => {
  try {
    const models = await listModels({
      provider: req.body?.provider,
      apiKey: req.body?.apiKey,
      baseUrl: req.body?.baseUrl,
      freeOnly: req.body?.freeOnly === true,
    });
    res.json({ models });
  } catch (err) {
    res.status(err instanceof LlmError && err.kind === "no_key" ? 400 : 502).json({
      error: err.message,
      kind: err.kind || "unknown",
      hint: err.hint || "",
    });
  }
});
app.get("/health", (_req, res) => res.json({ ok: true }));

// Account status for the OAuth sign-in chip. Proxied through the server so
// the browser never depends on OpenRouter's CORS policy for this endpoint.
// Same key policy as /api/models: used for this one request, never stored.
app.post("/api/openrouter/key-info", async (req, res) => {
  const key = String(req.body?.key || "").trim();
  if (!key) return res.status(400).json({ error: "Missing key." });
  try {
    const r = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${key}` },
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status === 401 || r.status === 403 ? 401 : 502).json({
        error: body?.error?.message || `OpenRouter answered ${r.status}.`,
        invalid: r.status === 401 || r.status === 403,
      });
    }
    const d = body?.data || {};
    res.json({
      label: d.label || "",
      usage: typeof d.usage === "number" ? d.usage : null,
      limit: typeof d.limit === "number" ? d.limit : null,
      freeTier: d.is_free_tier === true,
    });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

// "Why aren't the agents responding?" — runs real checks against the provider
// and reports what it finds. The key is used for these requests and discarded.
app.post("/api/diagnose", async (req, res) => {
  try {
    const result = await runDiagnostics({
      provider: req.body?.provider,
      apiKey: req.body?.apiKey,
      baseUrl: req.body?.baseUrl,
      model: req.body?.model,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Start (and if needed install) the deep-search sidecar on demand, so the
// answer to "it isn't up yet" is a button rather than a terminal command.
let deepStarting = false;
app.post("/api/deep/start", (_req, res) => {
  if (deepStarting) return res.json({ starting: true, already: true });
  deepStarting = true;
  const child = spawn("bash", ["setup-browser-service.sh", "--autostart"], {
    cwd: path.join(__dirname, ".."),
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  child.on("error", () => {
    deepStarting = false;
  });
  // Allow a retry after a few minutes if it never came up.
  setTimeout(() => {
    deepStarting = false;
  }, 5 * 60 * 1000).unref();
  res.json({ starting: true });
});

// Is the deep-search sidecar up? The UI polls this so it can say whether
// deep search is live yet — in Codespaces it installs in the background.
app.get("/health/deep", async (_req, res) => {
  const url = process.env.BROWSER_SERVICE_URL || "http://127.0.0.1:8010";
  const installed = fs.existsSync(
    path.join(__dirname, "..", "browser-service", ".venv", "bin", "uvicorn")
  );
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1200) });
    const detail = await r.json().catch(() => ({}));
    res.json({ ready: r.ok && detail?.ok !== false, installed, starting: deepStarting, ...detail });
  } catch (err) {
    res.json({
      ready: false,
      installed,
      starting: deepStarting,
      error: String(err?.message || err),
    });
  }
});

// Generated statements live in memory, keyed by id, until the server restarts.
// The browser fetches them as PDF via a normal link, so downloads "just work"
// in Codespaces' forwarded HTTPS port.
const reports = new Map();

app.get("/report/:id.pdf", (req, res) => {
  const report = reports.get(req.params.id);
  if (!report) return res.status(404).send("That statement has expired. Generate a new one from the chat.");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="focus-room-statement-${(report.generatedAt || "").slice(0, 10)}.pdf"`
  );
  renderReportPdf(report, res);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Sessions outlive their WebSocket. A dropped connection (sleeping laptop, a
// Codespaces port idling out, a page refresh) used to mean a brand-new room
// with no history; now the browser reconnects with its session id and picks up
// exactly where it left off.
const sessions = new Map();
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2h after the last activity

setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) if (s.lastSeen < cutoff) sessions.delete(id);
}, 10 * 60 * 1000).unref();

// Keepalive: without traffic, proxies quietly drop idle WebSockets and the
// client only finds out when a message vanishes. Ping every 30s and drop
// anything that stops answering so the client can reconnect promptly.
setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    try {
      client.ping();
    } catch {
      /* already gone */
    }
  }
}, 30000).unref();

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  // Resume by id when the browser offers one, otherwise start a room.
  const requestedId = (() => {
    try {
      return new URL(req.url, "http://localhost").searchParams.get("session");
    } catch {
      return null;
    }
  })();

  const sessionId = requestedId && sessions.has(requestedId) ? requestedId : randomUUID();
  const resumed = sessions.has(sessionId);

  if (!resumed) {
    sessions.set(sessionId, {
      history: [],
      userTurns: 0,
      // Agent configuration for THIS session. Keys arrive from the browser and
      // stay in memory only; models/providers fall back to saved prefs then env.
      config: defaultConfig(),
      lastSeen: Date.now(),
    });
  }

  const session = sessions.get(sessionId);
  session.lastSeen = Date.now();

  const history = session.history;
  let researching = false;

  // Hooks the fallback engine calls. A silent provider switch would be a
  // quality change the user can't see, so every one of them is announced.
  function attachHooks(cfg) {
    cfg.onFallbackAttempt = ({ agentId, from, to, kind }) =>
      send({ type: "log", text: `${agentId}: ${from} failed (${kind}) — trying ${to}` });

    cfg.onSwitch = (info) => {
      send({ type: "provider_switch", ...info, config: configStatus(cfg) });
    };
    return cfg;
  }
  attachHooks(session.config);

  const send = (msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  // Turn an LLM failure into something the UI can act on: "out of credits"
  // becomes a one-click switch to a free model rather than a raw 402.
  // Model problems are shown on the agent's chip in the header, never as a
  // popup in the conversation. By the time one of these reaches the user, the
  // fallback chain and live model discovery have both already failed, so the
  // only useful signal is a quiet "this agent can't run right now".
  const sendLlmError = (err, where) => {
    const kind = err?.kind || "unknown";
    const agentId = where === "scout" ? "scout" : "doctor";
    send({
      type: "agent_problem",
      agentId,
      kind,
      where,
      provider: err?.provider || null,
      text: err?.message || String(err),
      hint: err?.hint || "",
      // Only a missing key genuinely needs the user; everything else is us
      // having run out of options.
      needsKey: ["no_key", "bad_key"].includes(kind),
    });
  };

  // Hello: agent roster + current library and memory so the sidebar fills in.
  send({
    type: "hello",
    agents,
    games: getGames(),
    memories: getMemories(),
    sessionId,
    resumed,
    // Replay the transcript so a refresh or reconnect restores the room.
    transcript: history.map((m) => ({
      from: m.from,
      agentId: m.agentId || null,
      agentName: m.agentName || null,
      text: m.text,
    })),
    config: configStatus(session.config),
  });


  const postAgentMessage = (agent, text) => {
    const entry = { from: "agent", agentId: agent.id, agentName: agent.name, text, at: Date.now() };
    history.push(entry);
    send({ type: "agent_message", agent: agent.id, name: agent.name, text });
  };
  // Dr. Maple opens the conversation rather than waiting to be prompted.
  // Also re-runnable: if the opener failed because of a bad key, fixing the
  // config in Settings retries it instead of leaving an empty room.
  let openerRunning = false;
  let openerFallbackTimer = null;
  async function runOpener() {
    if (openerRunning || history.length > 0) return;
    openerRunning = true;
    send({ type: "status", agent: doctorAgent.id, state: "typing" });
    try {
      const opener = await doctorOpener({ config: session.config });
      postAgentMessage(doctorAgent, opener);
    } catch (err) {
      sendLlmError(err, "opener");
    } finally {
      openerRunning = false;
      send({ type: "status", agent: doctorAgent.id, state: "idle" });
    }
  }
  // Wait for the browser to restore its in-browser keys before the first model
  // call. Without this handshake a fresh room could race `set_config`, fail the
  // opener with "no key", or (worse) use a stale server-env paid route. Old
  // clients still get an opener through this compatibility timeout.
  if (!resumed && history.length === 0) {
    openerFallbackTimer = setTimeout(() => runOpener(), 3000);
    openerFallbackTimer.unref?.();
  }

  async function runDoctor() {
    send({ type: "status", agent: doctorAgent.id, state: "typing" });
    try {
      const reply = await doctorReply(history, {
        userTurns: session.userTurns,
        config: session.config,
        crisisMode: session.crisisMode === true,
      });
      postAgentMessage(doctorAgent, reply);
    } catch (err) {
      sendLlmError(err, "doctor");
    } finally {
      send({ type: "status", agent: doctorAgent.id, state: "idle" });
    }
  }

  // One place that turns a Scout result into a chat message, whichever task
  // produced it and however it was triggered.
  function postScoutResult(result) {
    if (result.needLocation) {
      postAgentMessage(
        researcherAgent,
        "Happy to look into how you'd get assessed — which country or city should I look at? Health systems differ enough that advice for the wrong one is worse than none."
      );
      return;
    }

    const parts = [result.note, result.body, result.detail].filter(Boolean);
    if (result.deepUnavailable) {
      parts.push(
        "(Deep search isn't up yet, so this is standard research — you can start it from the ⚙ panel.)"
      );
    }
    if (result.task === "clinicians") {
      parts.push(
        "I can't vouch for individual practitioners, so those are registers and routes to check yourself."
      );
    }
    if (!parts.length) return;

    postAgentMessage(researcherAgent, parts.join("\n\n"));
    if (result.added > 0 || result.updated > 0) send({ type: "games", games: result.library });
  }

  async function runResearcher(deep = false) {
    if (researching) return; // one research task at a time

    // Free rate limits are tight, so don't spend a model call deciding whether
    // to research when a glance at the message already answers it.
    const skip = skipResearchReason(history, session);
    if (skip) {
      send({ type: "log", text: `Scout: skipped research (${skip}).` });
      return;
    }

    researching = true;
    try {
      const decision = await shouldResearch(history, { config: session.config });
      if (!decision?.search || !decision.query) return;

      send({
        type: "status",
        agent: researcherAgent.id,
        state: deep ? "deep-searching" : getTask(decision.task).status,
      });
      session.lastResearchTurn = history.filter((m) => m.from === "user").length;
      const result = await research(decision.query, { deep, config: session.config, task: decision.task });

      // Scout is a background agent: it speaks only when it has something the
      // room didn't already know. Announcing "nothing new" every turn is noise,
      // and it reads as the agent being confused rather than being quiet.
      // Explain the reduced capability once per session, not every turn.
      if (result.searchBlocked && !session.toldNoSearch) {
        session.toldNoSearch = true;
        postAgentMessage(
          researcherAgent,
          result.searchBlocked === "free-model"
            ? "Heads up: OpenRouter bills live web search separately from tokens, so on a free model I can't run one. I'll read the official pages I know about and flag anything that's changed — or turn on Deep search, which browses for real."
            : `${researcherAgent.name} can't run a live web search on this provider — I'll work from the official pages I can read directly, or you can turn on Deep search.`
        );
      }

      if (result.worthSaying) {
        postScoutResult(result);
      } else {
        // Nothing new — stay quiet, but leave a trace in the console for you.
        send({ type: "log", text: `Scout: researched "${decision.query}" — nothing the library didn't have.` });
      }
    } catch (err) {
      // Background research: surface it only if the user can fix it.
      if (["no_key", "bad_key", "out_of_credits"].includes(err?.kind)) sendLlmError(err, "scout");
      else send({ type: "log", text: `Scout research failed: ${String(err.message || err)}` });
    } finally {
      researching = false;
      send({ type: "status", agent: researcherAgent.id, state: "idle" });
    }
  }

  async function runSummary({ announce } = { announce: true }) {
    send({ type: "status", agent: researcherAgent.id, state: "summarizing" });
    try {
      const memories = await summarizeSession(history, { config: session.config });
      if (memories) {
        send({ type: "memories", memories });
        if (announce) {
          postAgentMessage(
            researcherAgent,
            "I saved a summary of this session to long-term memory, so Dr. Maple can pick up where you left off next time."
          );
        }
      }
    } catch (err) {
      sendLlmError(err, "summary");
    } finally {
      send({ type: "status", agent: researcherAgent.id, state: "idle" });
    }
  }

  async function runStatement() {
    send({ type: "status", agent: researcherAgent.id, state: "writing statement" });
    try {
      const report = await professionalStatement(history, { config: session.config });
      if (!report) {
        send({ type: "log", text: "Nothing to summarize yet." });
        return;
      }
      const id = `rep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      reports.set(id, report);
      postAgentMessage(
        researcherAgent,
        "I've written up this session as a professional statement you can take to a clinician. The download link is below the chat."
      );
      send({
        type: "report_ready",
        id,
        url: `/report/${id}.pdf`,
        generatedAt: report.generatedAt,
        summary: report.summary,
      });

      // The statement is only useful if it reaches a clinician, so offer the
      // next step rather than leaving the user to work it out.
      if (!session.offeredClinicians) {
        session.offeredClinicians = true;
        postAgentMessage(
          researcherAgent,
          "That statement is meant to be handed to a real clinician. If you tell me your country or city, I'll pull together the routes to an ADHD assessment there — public and private — plus the registers you can search yourself."
        );
      }
    } catch (err) {
      sendLlmError(err, "statement");
    } finally {
      send({ type: "status", agent: researcherAgent.id, state: "idle" });
    }
  }

  ws.on("message", async (raw) => {
    session.lastSeen = Date.now();
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "user_message" && typeof msg.text === "string" && msg.text.trim()) {
      const text = msg.text.trim();
      history.push({ from: "user", text, at: Date.now() });
      session.userTurns += 1;
      session.lastSeen = Date.now();

      // SAFETY FIRST — before any model call, and independent of which model
      // is running. On a crisis disclosure the screening stops for good: fixed
      // text goes out immediately, and the rest of the turn is skipped.
      const risk = assessRisk(text);
      if (risk.level === "crisis") {
        if (!session.crisisMode) {
          session.crisisMode = true;
          postAgentMessage(doctorAgent, CRISIS_RESPONSE);
          return; // no model call, no research, no summary this turn
        }
        // Already in crisis mode: let Dr. Maple respond supportively.
      }

      // Doctor answers in the foreground; Scout works in the background —
      // but never while someone is in crisis. Researching game prices at that
      // moment would be grotesque.
      runDoctor();
      if (!session.crisisMode) runResearcher(msg.deep === true);

      if (!session.crisisMode) {
        const summaryEvery = isConstrainedFree(session.config, "scout")
          ? FREE_AUTO_SUMMARY_EVERY
          : AUTO_SUMMARY_EVERY;
        if (session.userTurns % summaryEvery === 0) runSummary({ announce: false });
      }
    }

    if (msg.type === "end_session") {
      await runSummary({ announce: true });
      await runStatement();
    }

    if (msg.type === "request_statement") {
      await runStatement();
    }

    if (msg.type === "client_ready") {
      if (openerFallbackTimer) {
        clearTimeout(openerFallbackTimer);
        openerFallbackTimer = null;
      }
      if (!resumed && history.length === 0) runOpener();
      return;
    }

    // Live configuration switch — no restart, no .env edit, mid-conversation safe.
    if (msg.type === "set_config" && msg.config) {
      const next = msg.config;
      session.config = attachHooks({
        doctor: { ...session.config.doctor, ...(next.doctor || {}) },
        scout: { ...session.config.scout, ...(next.scout || {}) },
        customBaseUrl: next.customBaseUrl ?? session.config.customBaseUrl,
        fallback: { ...session.config.fallback, ...(next.fallback || {}) },
        // Normal updates merge keys. The settings drawer can explicitly
        // replace them so "Remove" really removes browser-supplied backups
        // from this live session (environment keys remain available).
        keys: next.replaceKeys ? { ...(next.keys || {}) } : { ...session.config.keys, ...(next.keys || {}) },
        // A manual change means "try again": forget what we marked dead,
        // since the user may have topped up credits or fixed a key.
        _dead: new Set(),
      });
      // Persist model/provider choices only — never keys.
      savePrefs(session.config);
      send({ type: "config", config: configStatus(session.config), applied: true });

      if (next.retry === true) {
        // The user fixed a broken config mid-conversation; pick the thread back up.
        if (history.length === 0) {
          runOpener();
        } else if (history[history.length - 1]?.from === "user") {
          runDoctor();
        }
      }
    }

    if (msg.type === "request_research" && typeof msg.query === "string" && msg.query.trim()) {
      history.push({ from: "user", text: `(asks Scout directly) ${msg.query.trim()}`, at: Date.now() });
      if (!researching) {
        researching = true;
        const deep = msg.deep === true;
        send({ type: "status", agent: researcherAgent.id, state: deep ? "deep-searching" : "researching" });
        try {
          const result = await research(msg.query.trim(), {
            deep,
            config: session.config,
            task: msg.task,
          });
          if (result.needLocation || result.worthSaying) postScoutResult(result);
          else postAgentMessage(researcherAgent, "Nothing there I can stand behind — the library already covers it.");
        } catch (err) {
          sendLlmError(err, "scout");
        } finally {
          researching = false;
          send({ type: "status", agent: researcherAgent.id, state: "idle" });
        }
      }
    }
  });
});

// A port clash is almost always "it auto-started on attach and is still
// running" — say that, instead of dumping an EADDRINUSE stack trace.
// The listen error reaches both the HTTP server and the WebSocket server
// wrapping it; without a handler on each, ws rethrows before we can print.
let reportedPortClash = false;
const onServerError = (err) => {
  if (err.code !== "EADDRINUSE") throw err;
  if (reportedPortClash) return;
  reportedPortClash = true;

  let owner = "";
  try {
    const pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
    process.kill(pid, 0); // throws if that process is gone
    owner = ` (PID ${pid}, started automatically when the codespace attached)`;
  } catch {
    owner = " by another process";
  }

  console.error(
    [
      "",
      `✗ Port ${PORT} is already in use${owner}.`,
      "",
      "  Focus Room is probably already running — open the forwarded port and use it.",
      "",
      "  To take over this terminal instead:",
      "    npm run restart      stop the running copy and start here",
      "    npm run stop         just stop the running copy",
      "",
      `  Or run a second copy on another port:  PORT=3001 npm start`,
      "",
      "  To stop it auto-starting on attach, set the Codespaces variable AUTOSTART=0.",
      "",
    ].join("\n")
  );
  process.exit(1);
};

server.on("error", onServerError);
wss.on("error", onServerError);

function cleanup() {
  try {
    if (fs.readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) fs.unlinkSync(PID_FILE);
  } catch {
    /* nothing to clean up */
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    console.log(`\nFocus Room shutting down (${signal})…`);
    cleanup();
    server.close(() => process.exit(0));
    // Don't hang forever on open WebSockets.
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
process.on("exit", cleanup);

server.listen(PORT, () => {
  try {
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch {
    /* pid file is a convenience, not a requirement */
  }
  console.log(`Focus Room running → http://localhost:${PORT}`);
  const anyKey = ["OPENROUTER_API_KEY", "GROQ_API_KEY", "GEMINI_API_KEY", "CUSTOM_API_KEY"].some(
    (k) => process.env[k]
  );
  if (!anyKey) {
    console.log("ℹ No API key in the environment — that's fine: open the app and set a provider, model, and key from the ⚙ settings panel.");
  }
});
