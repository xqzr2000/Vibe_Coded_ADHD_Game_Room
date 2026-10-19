// Focus Room gateway — one small server that hosts the web UI, holds each
// session, and routes every user message through the two agents.
//
//   Dr. Maple  foreground, streamed to the chat bubble as she writes
//   Scout      background research, with every step streamed to the side panel
//
// Groq only, free models only. No accounts, no database.

import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
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
import { getGames, getMemories, memoryEnabled } from "./store.js";
import { getTask } from "./agents/scout-tasks.js";
import { assessRisk, CRISIS_RESPONSE } from "./safety.js";
import { renderReportPdf } from "./report.js";
import { GROQ, FREE_MODELS, modelInfo, noteLiveModels, publicModelList } from "./models.js";
import { listModels } from "./llm.js";
import { defaultConfig, configStatus, applyUpdate, resolveKey, serverKeysAvailable, allowServerKeys } from "./config.js";
import { sanitizeProfile, AVATAR_EMOJI, AVATAR_COLORS, DEFAULT_PROFILE } from "./profile.js";
import { snapshot, planGuess } from "./quota.js";
import { testGroqKey, testTavilyKey, mask } from "./diagnose.js";
import { tavilyUsageCached } from "./search/index.js";
import { planExhausted } from "./search/tavily.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PORT || 3000);
const IN_CONTAINER = Boolean(
  process.env.CODESPACES || process.env.REMOTE_CONTAINERS || process.env.DEVCONTAINER || fs.existsSync("/.dockerenv")
);
// In a dev container the port is forwarded from outside, so listen on all
// interfaces. On a plain machine, stay on localhost unless HOST says otherwise
// (HOST=0.0.0.0 to open it to your local network).
const HOST = process.env.HOST || (IN_CONTAINER ? "0.0.0.0" : "127.0.0.1");
const PID_FILE = path.join(ROOT, ".focus-room.pid");
const AUTO_SUMMARY_EVERY = 16; // every summary is a model call; free quota goes to replies first
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const STARTED_AT = Date.now();

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(ROOT, "public")));

// These routes make outbound calls on the caller's behalf; cap them per IP so
// the server can't be used as a relay.
const hits = new Map();
function rateLimited(ip, limit = 20, windowMs = 60_000) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 500) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  return list.length > limit;
}

// A browser that sends no key may test the server's key — but only when the
// operator has allowed server keys at all.
const keyFor = (service, supplied) => {
  const own = String(supplied || "").trim();
  if (own) return { key: own, source: "browser" };
  const server = resolveKey({ allowServerKeys: allowServerKeys(), keys: {} }, service);
  return { key: server, source: server ? "server" : "none" };
};

app.get("/api/meta", (_req, res) =>
  res.json({
    version: VERSION,
    groq: { keyUrl: GROQ.keyUrl, limitsUrl: GROQ.limitsUrl, keyPrefix: GROQ.keyPrefix },
    tavily: { keyUrl: "https://app.tavily.com", keyPrefix: "tvly-" },
    models: publicModelList(),
    serverKeys: serverKeysAvailable(),
    memory: memoryEnabled() ? "local" : "off",
    avatars: { emoji: AVATAR_EMOJI, colors: AVATAR_COLORS },
  })
);

app.post("/api/groq/test", async (req, res) => {
  if (rateLimited(req.ip)) return res.status(429).json({ ok: false, error: "Too many checks. Wait a minute." });
  const { key, source } = keyFor("groq", req.body?.key);
  const result = await testGroqKey(key, { probe: req.body?.probe === true });
  res.json({ ...result, source });
});

app.post("/api/tavily/test", async (req, res) => {
  if (rateLimited(req.ip)) return res.status(429).json({ ok: false, error: "Too many checks. Wait a minute." });
  const { key, source } = keyFor("tavily", req.body?.key);
  const result = await testTavilyKey(key, { search: req.body?.search === true });
  res.json({ ...result, source });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    memory: memoryEnabled() ? "local" : "off",
    serverKeys: serverKeysAvailable(),
    models: publicModelList(),
  });
});

// Generated statements live in memory until the server restarts.
const reports = new Map();
app.get("/report/:id.pdf", (req, res) => {
  const report = reports.get(req.params.id);
  if (!report) return res.status(404).send("That statement has expired. Generate a new one from the chat.");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="focus-room-statement-${(report.generatedAt || "").slice(0, 10)}.pdf"`);
  renderReportPdf(report, res);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Sessions outlive their WebSocket: a refresh or a dropped connection resumes
// the same room by session id.
const sessions = new Map();
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) if (s.lastSeen < cutoff) sessions.delete(id);
}, 10 * 60 * 1000).unref();

// Keepalive so idle proxies don't silently drop the socket.
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
}, 30_000).unref();

const MAX_RUNS = 6;

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  const requestedId = (() => {
    try {
      return new URL(req.url, "http://localhost").searchParams.get("session");
    } catch {
      return null;
    }
  })();
  const resumed = Boolean(requestedId && sessions.has(requestedId));
  const sessionId = resumed ? requestedId : randomUUID();
  if (!resumed) {
    sessions.set(sessionId, {
      history: [],
      userTurns: 0,
      config: defaultConfig(),
      profile: { ...DEFAULT_PROFILE },
      scoutRuns: [],
      lastSeen: Date.now(),
    });
  }
  const session = sessions.get(sessionId);
  session.lastSeen = Date.now();
  // Each new socket must re-present its configuration (and so its key) before
  // anything spends a model call.
  let socketReady = false;
  let researching = false;
  let doctorStream = null; // streamId of the reply being written
  let activeRun = null; // Scout run currently in progress

  const history = session.history;
  const send = (msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  // ---- hooks the fallback engine calls -------------------------------------
  let quotaTimer = null;
  function sendQuota() {
    clearTimeout(quotaTimer);
    quotaTimer = setTimeout(() => {
      const key = resolveKey(session.config, "groq");
      if (!key) return;
      const ids = FREE_MODELS.map((m) => m.id);
      send({ type: "quota", quota: snapshot(key, ids), plan: planGuess(key, ids) });
    }, 250);
  }
  function attachHooks(cfg) {
    cfg.onFallbackAttempt = ({ agentId, from, to, kind }) => {
      const label = `${modelInfo(from)?.label || from} ${kind === "rate_limited" ? "is at its free limit" : `failed (${kind})`} — switching to ${modelInfo(to)?.label || to}`;
      send({ type: "log", text: `${agentId}: ${label}` });
      if (agentId === "doctor" && doctorStream) send({ type: "agent_step", streamId: doctorStream, id: "switch", label });
      if (agentId === "scout" && activeRun) activeRun.emit({ op: "add", step: { id: `f${Date.now()}`, kind: "note", status: "done", title: label, at: Date.now() } });
    };
    cfg.onWait = ({ agentId, ms }) => {
      const label = `Waiting ${Math.ceil(ms / 1000)}s for free-tier quota to refill`;
      if (agentId === "doctor" && doctorStream) send({ type: "agent_step", streamId: doctorStream, id: "wait", label });
      if (agentId === "scout" && activeRun) activeRun.emit({ op: "add", step: { id: `w${Date.now()}`, kind: "note", status: "done", title: label, at: Date.now() } });
    };
    cfg.onActive = (info) => send({ type: "model_switch", ...info, config: configStatus(cfg) });
    cfg.onQuota = sendQuota;
    return cfg;
  }
  attachHooks(session.config);

  // Model problems are shown on the agent's chip, not as chat messages. By the
  // time one gets here, every free model has already been tried.
  const sendLlmError = (err, where) => {
    const kind = err?.kind || "unknown";
    send({
      type: "agent_problem",
      agentId: ["scout", "summary", "statement"].includes(where) ? "scout" : "doctor",
      kind,
      where,
      text: err?.message || String(err),
      hint: err?.hint || "",
      retryAfterMs: err?.retryAfterMs || 0,
      needsKey: ["no_key", "bad_key"].includes(kind),
    });
  };

  send({
    type: "hello",
    agents,
    games: getGames(),
    memories: getMemories(),
    memory: memoryEnabled() ? "local" : "off",
    sessionId,
    resumed,
    transcript: history.map((m) => ({ from: m.from, agentId: m.agentId || null, agentName: m.agentName || null, text: m.text })),
    config: configStatus(session.config),
    profile: session.profile,
    serverKeys: serverKeysAvailable(),
    models: publicModelList(),
    scoutRuns: session.scoutRuns,
  });

  const postAgentMessage = (agent, text, { streamId, model } = {}) => {
    const safeText = String(text || "").trim();
    if (!safeText) throw new TypeError(`${agent.name} produced an empty message.`);
    history.push({ from: "agent", agentId: agent.id, agentName: agent.name, text: safeText, at: Date.now() });
    if (streamId) send({ type: "agent_final", streamId, agent: agent.id, name: agent.name, text: safeText, model: modelInfo(model)?.label || model || "" });
    else send({ type: "agent_message", agent: agent.id, name: agent.name, text: safeText });
  };

  // ---- Dr. Maple, streamed ---------------------------------------------------
  function streamEvents(streamId) {
    return (e) => {
      if (e.type === "step") send({ type: "agent_step", streamId, id: e.id, label: e.label, model: e.model || "" });
      else if (e.type === "delta") send({ type: "agent_delta", streamId, text: e.text });
      else if (e.type === "reset") send({ type: "agent_reset", streamId, model: e.modelLabel || e.model });
    };
  }

  async function runDoctorTurn(kind) {
    const streamId = `d_${randomUUID().slice(0, 8)}`;
    doctorStream = streamId;
    send({ type: "status", agent: doctorAgent.id, state: kind === "opener" ? "saying hello" : "replying" });
    send({ type: "agent_start", streamId, agent: doctorAgent.id, name: doctorAgent.name });
    try {
      const reply =
        kind === "opener"
          ? await doctorOpener({ config: session.config, user: session.profile, onEvent: streamEvents(streamId) })
          : await doctorReply(history, {
              userTurns: session.userTurns,
              config: session.config,
              crisisMode: session.crisisMode === true,
              user: session.profile,
              lastNameTurn: session.lastNameTurn,
              onEvent: streamEvents(streamId),
            });
      if (reply.usedName && kind !== "opener") session.lastNameTurn = session.userTurns;
      postAgentMessage(doctorAgent, reply.text, { streamId, model: reply.model });
    } catch (err) {
      send({ type: "agent_abort", streamId });
      sendLlmError(err, kind);
    } finally {
      if (doctorStream === streamId) doctorStream = null;
      send({ type: "status", agent: doctorAgent.id, state: "idle" });
    }
  }

  let openerRunning = false;
  async function runOpener() {
    if (openerRunning || history.length > 0) return;
    openerRunning = true;
    try {
      await runDoctorTurn("opener");
    } finally {
      openerRunning = false;
    }
  }

  // ---- Scout runs (each one shows up in the side panel) -----------------------
  function startRun(kind, title, detail = "") {
    const run = { id: `r_${randomUUID().slice(0, 8)}`, kind, title, detail, status: "active", startedAt: Date.now(), steps: [] };
    session.scoutRuns.push(run);
    while (session.scoutRuns.length > MAX_RUNS) session.scoutRuns.shift();
    send({ type: "scout_run", op: "start", run });
    const emit = (op) => {
      if (op.op === "add") run.steps.push({ ...op.step });
      else if (op.op === "update") Object.assign(run.steps.find((s) => s.id === op.id) || {}, op.patch);
      else if (op.op === "append") {
        const s = run.steps.find((x) => x.id === op.id);
        if (s && (s.text || "").length < 6000) s.text = (s.text || "") + op.text;
      }
      send({ type: "scout_trace", runId: run.id, ...op });
    };
    const handle = {
      run,
      emit,
      finish(status, summary = "") {
        run.status = status;
        run.summary = summary;
        run.endedAt = Date.now();
        for (const s of run.steps) if (s.status === "active") s.status = status === "error" ? "error" : "done";
        send({ type: "scout_run", op: "end", runId: run.id, status, summary });
        if (activeRun === handle) activeRun = null;
      },
    };
    activeRun = handle;
    return handle;
  }

  function postScoutResult(result) {
    if (result.needLocation) {
      postAgentMessage(
        researcherAgent,
        "Happy to look into how you'd get assessed — which country or city should I look at? Health systems differ enough that advice for the wrong one is worse than none."
      );
      return;
    }
    const parts = [result.note, result.body, result.detail].filter(Boolean);
    if (result.task === "clinicians") {
      parts.push("I can't vouch for individual practitioners, so those are registers and routes to check yourself.");
    }
    if (!parts.length) return;
    if (result.sources?.length) parts.push(`Sources: ${result.sources.slice(0, 3).map((s) => s.url).join("  ")}`);
    if (result.mode === "no-search") parts.push("(No live web search was available, so check these details on the official pages.)");
    postAgentMessage(researcherAgent, parts.join("\n\n"));
    if (result.added > 0 || result.updated > 0) send({ type: "games", games: result.library });
  }

  async function runResearch(query, task, { direct = false } = {}) {
    researching = true;
    const t = getTask(task);
    send({ type: "status", agent: researcherAgent.id, state: t.status });
    const run = startRun("research", `Research: ${t.label}`, query);
    try {
      const result = await research(query, { config: session.config, task: t.id, trace: run.emit });
      run.finish("done", result.detail || (result.worthSaying ? "Findings posted in the chat" : "Nothing new"));
      if (result.needLocation || result.worthSaying) postScoutResult(result);
      else if (direct) postAgentMessage(researcherAgent, "Nothing there I can stand behind that the library doesn't already have.");
      else send({ type: "log", text: `Scout: researched "${query}" — nothing new.` });
    } catch (err) {
      run.emit({ op: "add", step: { id: "err", kind: "error", status: "error", title: err.message, detail: err.hint || "", at: Date.now() } });
      run.finish("error", err.message);
      if (direct || ["no_key", "bad_key"].includes(err?.kind)) sendLlmError(err, "scout");
      else send({ type: "log", text: `Scout research failed: ${err.message}` });
    } finally {
      researching = false;
      send({ type: "status", agent: researcherAgent.id, state: "idle" });
    }
  }

  async function runResearcher() {
    if (researching) return;
    const skip = skipResearchReason(history, session);
    if (skip) {
      send({ type: "log", text: `Scout: skipped research (${skip}).` });
      return;
    }
    const decision = await shouldResearch(history, { config: session.config });
    if (!decision?.search || !decision.query) {
      send({ type: "log", text: `Scout: no research (${decision?.reason || "nothing to do"}).` });
      return;
    }
    session.lastResearchTurn = history.filter((m) => m.from === "user").length;
    await runResearch(decision.query, decision.task);
  }

  async function runSummary({ announce } = { announce: true }) {
    if (!memoryEnabled()) {
      if (announce) send({ type: "log", text: "Long-term memory is off (LOCAL_MEMORY=0)." });
      return;
    }
    send({ type: "status", agent: researcherAgent.id, state: "summarizing" });
    const run = startRun("summary", "Saving a session summary");
    const step = { id: "s1", kind: "thinking", status: "active", title: "Summarizing the conversation", at: Date.now() };
    run.emit({ op: "add", step });
    try {
      const memories = await summarizeSession(history, { config: session.config });
      run.emit({ op: "update", id: "s1", patch: { status: "done" } });
      run.finish("done", memories ? "Saved to long-term memory" : "Nothing to save yet");
      if (memories) {
        send({ type: "memories", memories });
        if (announce) {
          postAgentMessage(researcherAgent, "I saved a summary of this session to long-term memory, so Dr. Maple can pick up where you left off next time.");
        }
      }
    } catch (err) {
      run.finish("error", err.message);
      sendLlmError(err, "summary");
    } finally {
      send({ type: "status", agent: researcherAgent.id, state: "idle" });
    }
  }

  async function runStatement() {
    send({ type: "status", agent: researcherAgent.id, state: "writing statement" });
    const run = startRun("statement", "Writing the session statement");
    run.emit({ op: "add", step: { id: "s1", kind: "thinking", status: "active", title: "Drafting a neutral write-up for a clinician", at: Date.now() } });
    try {
      const report = await professionalStatement(history, { config: session.config });
      run.emit({ op: "update", id: "s1", patch: { status: "done" } });
      if (!report) {
        run.finish("done", "Nothing to write up yet");
        send({ type: "log", text: "Nothing to summarize yet." });
        return;
      }
      const id = `rep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      reports.set(id, report);
      run.finish("done", "PDF ready below the chat");
      postAgentMessage(researcherAgent, "I've written up this session as a professional statement you can take to a clinician. The download link is below the chat.");
      send({ type: "report_ready", id, url: `/report/${id}.pdf`, generatedAt: report.generatedAt, summary: report.summary });
      if (!session.offeredClinicians) {
        session.offeredClinicians = true;
        postAgentMessage(
          researcherAgent,
          "That statement is meant to be handed to a real clinician. If you tell me your country or city, I'll pull together the routes to an ADHD assessment there — public and private — plus the registers you can search yourself."
        );
      }
    } catch (err) {
      run.finish("error", err.message);
      sendLlmError(err, "statement");
    } finally {
      send({ type: "status", agent: researcherAgent.id, state: "idle" });
    }
  }

  function requireCapability() {
    if (socketReady && resolveKey(session.config, "groq")) return true;
    send({ type: "capability_required", text: "Add your Groq API key to start the room." });
    return false;
  }

  async function statusReport() {
    const groqKey = resolveKey(session.config, "groq");
    const tavilyKey = resolveKey(session.config, "tavily");
    const ids = FREE_MODELS.map((m) => m.id);
    const out = {
      server: { version: VERSION, uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000), memory: memoryEnabled() ? "local" : "off" },
      groq: {
        source: configStatus(session.config).keys.groq,
        masked: mask(groqKey),
        quota: groqKey ? snapshot(groqKey, ids) : [],
        plan: groqKey ? planGuess(groqKey, ids) : "unknown",
        models: publicModelList(),
        config: configStatus(session.config),
      },
      tavily: { source: configStatus(session.config).keys.tavily, masked: mask(tavilyKey) },
    };
    if (tavilyKey) {
      try {
        const usage = await tavilyUsageCached(tavilyKey);
        out.tavily.usage = usage;
        out.tavily.exhausted = planExhausted(usage);
        out.tavily.paygo = (usage.paygoLimit || 0) > 0;
      } catch (err) {
        out.tavily.error = err.message;
      }
    }
    return out;
  }

  ws.on("message", async (raw) => {
    session.lastSeen = Date.now();
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "set_config" && msg.config) {
      session.config = attachHooks(applyUpdate(session.config, msg.config));
      socketReady = true;
      send({ type: "config", config: configStatus(session.config), serverKeys: serverKeysAvailable() });
      if (msg.config.retry === true && resolveKey(session.config, "groq")) {
        if (history.length === 0) runOpener();
        else if (history[history.length - 1]?.from === "user") runDoctorTurn("reply");
      }
      return;
    }

    if (msg.type === "set_profile") {
      const { profile, error } = sanitizeProfile(msg.profile || {});
      // A name that fails validation keeps the previous name rather than none.
      session.profile = error ? { ...profile, nickname: session.profile.nickname } : profile;
      send({ type: "profile", profile: session.profile, error });
      return;
    }

    if (msg.type === "get_status") {
      send({ type: "status_report", report: await statusReport() });
      return;
    }

    if (msg.type === "client_ready") {
      if (!requireCapability()) return;
      if (!resumed && history.length === 0) runOpener();
      return;
    }

    if (msg.type === "user_message" && typeof msg.text === "string" && msg.text.trim()) {
      if (!requireCapability()) return;
      const text = msg.text.trim().slice(0, 4000);
      history.push({ from: "user", text, at: Date.now() });
      session.userTurns += 1;

      // SAFETY FIRST — before any model call, independent of which model runs.
      const risk = assessRisk(text);
      if (risk.level === "crisis" && !session.crisisMode) {
        session.crisisMode = true;
        postAgentMessage(doctorAgent, CRISIS_RESPONSE);
        return; // no model call, no research, no summary this turn
      }

      runDoctorTurn("reply");
      if (!session.crisisMode) {
        runResearcher();
        if (session.userTurns % AUTO_SUMMARY_EVERY === 0) runSummary({ announce: false });
      }
      return;
    }

    if (msg.type === "request_research" && typeof msg.query === "string" && msg.query.trim()) {
      if (!requireCapability()) return;
      if (session.crisisMode) return;
      const query = msg.query.trim().slice(0, 500);
      history.push({ from: "user", text: `(asks Scout directly) ${query}`, at: Date.now() });
      if (researching) {
        send({ type: "log", text: "Scout is already researching; try again when it finishes." });
        return;
      }
      await runResearch(query, msg.task, { direct: true });
      return;
    }

    if (msg.type === "end_session") {
      if (!requireCapability()) return;
      await runSummary({ announce: true });
      await runStatement();
      return;
    }

    if (msg.type === "request_statement") {
      if (!requireCapability()) return;
      await runStatement();
    }
  });
});

// ---- startup ----------------------------------------------------------------

let reportedPortClash = false;
const onServerError = (err) => {
  if (err.code !== "EADDRINUSE") throw err;
  if (reportedPortClash) return;
  reportedPortClash = true;
  let owner = " by another process";
  try {
    const pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
    process.kill(pid, 0);
    owner = ` (PID ${pid}${IN_CONTAINER ? ", probably started automatically when the container attached" : ""})`;
  } catch {
    /* no live pid file */
  }
  console.error(
    [
      "",
      `✗ Port ${PORT} is already in use${owner}.`,
      "",
      "  Focus Room is probably already running — open it in the browser.",
      "    npm run restart      stop the running copy and start here",
      "    npm run stop         just stop the running copy",
      `    PORT=3001 npm start  run a second copy on another port`,
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
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
process.on("exit", cleanup);

server.listen(PORT, HOST, async () => {
  try {
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch {
    /* convenience only */
  }
  const shown = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST;
  console.log(`✓ Focus Room ${VERSION} running → http://${shown}:${PORT}`);
  if (process.env.CODESPACES) console.log("  (Codespaces: open it from the Ports tab, port " + PORT + ")");
  else if (!IN_CONTAINER && HOST === "127.0.0.1") console.log("  Listening on this machine only. Set HOST=0.0.0.0 to open it to your network.");

  const keys = serverKeysAvailable();
  const envGroq = Boolean(process.env[GROQ.envVar]);
  const envTavily = Boolean(process.env.TAVILY_API_KEY);
  if (keys.groq) console.log("ℹ Using the server's GROQ_API_KEY for browser sessions (ALLOW_SERVER_KEYS=1).");
  else if (envGroq) console.log("ℹ GROQ_API_KEY is set but protected: browsers must paste their own key. Set ALLOW_SERVER_KEYS=1 on a private machine to use it.");
  else console.log("ℹ No server Groq key — each browser pastes its own (free at console.groq.com/keys).");
  if (keys.tavily) console.log("ℹ Using the server's TAVILY_API_KEY for Scout's search.");
  else if (envTavily) console.log("ℹ TAVILY_API_KEY is set but protected (ALLOW_SERVER_KEYS is not 1).");
  console.log(`ℹ Free models: ${FREE_MODELS.map((m) => m.id).join(", ")}`);

  // With a usable server key, check the live model list once so a model Groq
  // has retired is dropped before the first conversation.
  if (keys.groq) {
    try {
      const live = await listModels(process.env[GROQ.envVar]);
      noteLiveModels(live);
      const retired = publicModelList().filter((m) => m.retired).map((m) => m.id);
      if (retired.length) console.log(`⚠ Not offered by Groq any more: ${retired.join(", ")} — update FREE_MODELS in server/models.js.`);
    } catch (err) {
      console.log(`⚠ Couldn't check Groq's model list: ${err.message}`);
    }
  }
});
