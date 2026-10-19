// End-to-end: starts the real server against tests/mock-services.mjs and
// drives it over a WebSocket exactly as the browser does.  `npm run test:e2e`

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { startMockServices } from "./mock-services.mjs";

const mock = await startMockServices(0);
const BASE = `http://127.0.0.1:${mock.port}`;
const PORT = 3900 + Math.floor(Math.random() * 90);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "focus-room-e2e-"));
fs.copyFileSync(new URL("../data/games.json", import.meta.url), path.join(DATA, "games.json"));

const env = {
  ...process.env,
  PORT: String(PORT),
  HOST: "127.0.0.1",
  GROQ_BASE_URL: `${BASE}/openai/v1`,
  TAVILY_BASE_URL: `${BASE}/tavily`,
  DDG_HTML_URL: `${BASE}/ddg/html/`,
  FOCUS_ROOM_DATA_DIR: DATA,
  FOCUS_ROOM_ALLOW_PRIVATE_FETCH: "1",
  ALLOW_SERVER_KEYS: "0",
  GROQ_API_KEY: "",
  TAVILY_API_KEY: "",
};
const root = new URL("..", import.meta.url).pathname;
const proc = spawn(process.execPath, ["server/start.js"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
proc.stdout.on("data", (d) => (serverLog += d));
proc.stderr.on("data", (d) => (serverLog += d));

let failures = 0;
let count = 0;
const check = (name, ok, extra = "") => {
  count += 1;
  if (!ok) {
    failures += 1;
    console.error(`FAIL  ${name} ${extra}`);
  } else console.log(`ok    ${name}`);
};

async function waitForHealth() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return r.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not start:\n" + serverLog);
}

function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
  const msgs = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    msgs.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  const wait = (pred, ms = 15000) =>
    new Promise((resolve, reject) => {
      const hit = msgs.find(pred);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error("timeout waiting; got: " + msgs.map((m) => m.type).join(","))), ms);
      waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  const send = (m) => ws.send(JSON.stringify(m));
  return { ws, msgs, wait, send, open: new Promise((r) => ws.on("open", r)) };
}

try {
  const health = await waitForHealth();
  check("server healthy", health.ok === true);
  check("health lists 3 free models", health.models.length === 3);

  const meta = await fetch(`http://127.0.0.1:${PORT}/api/meta`).then((r) => r.json());
  check("meta: no server keys lent", meta.serverKeys.groq === false);

  const keyTest = await fetch(`http://127.0.0.1:${PORT}/api/groq/test`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "gsk_e2e" }),
  }).then((r) => r.json());
  check("key test endpoint works", keyTest.ok && keyTest.usable === 3);

  const c = client();
  await c.open;
  const hello = await c.wait((m) => m.type === "hello");
  check("hello received", Boolean(hello.sessionId));

  // Room is locked without a key.
  c.send({ type: "client_ready" });
  await c.wait((m) => m.type === "capability_required");
  check("room locked until a key arrives", true);

  c.send({ type: "set_config", config: { keys: { groq: "gsk_e2e", tavily: "tvly-e2e" }, replaceKeys: true } });
  c.send({ type: "set_profile", profile: { nickname: "Russell", avatarEmoji: "🦊", avatarColor: "#4a5d8a" } });
  c.send({ type: "client_ready" });

  const start = await c.wait((m) => m.type === "agent_start");
  await c.wait((m) => m.type === "agent_step" && m.streamId === start.streamId && m.id === "think");
  await c.wait((m) => m.type === "agent_delta" && m.streamId === start.streamId);
  const opener = await c.wait((m) => m.type === "agent_final" && m.streamId === start.streamId);
  check("opener streamed then finalized", opener.text.length > 10);
  check("opener uses the preferred name", opener.text.includes("Russell"), opener.text);
  check("deltas came before final", c.msgs.filter((m) => m.type === "agent_delta" && m.streamId === start.streamId).length > 3);

  c.send({ type: "user_message", text: "hi there" });
  const s2 = await c.wait((m) => m.type === "agent_start" && m.streamId !== start.streamId);
  await c.wait((m) => m.type === "agent_final" && m.streamId === s2.streamId);
  check("second reply streamed", true);

  // A research-worthy message: Dr. Maple replies AND Scout researches.
  c.send({ type: "user_message", text: "How much does the EndeavorOTC subscription cost per month for adults?" });
  const run = await c.wait((m) => m.type === "scout_run" && m.op === "start", 20000);
  check("Scout run started", run.run.kind === "research");
  await c.wait((m) => m.type === "scout_trace" && m.op === "add" && m.step.kind === "search");
  await c.wait((m) => m.type === "scout_trace" && m.op === "append");
  await c.wait((m) => m.type === "scout_trace" && m.op === "add" && m.step.kind === "read");
  const end = await c.wait((m) => m.type === "scout_run" && m.op === "end" && m.runId === run.run.id, 20000);
  check("Scout run finished", end.status === "done", JSON.stringify(end));
  const scoutMsg = await c.wait((m) => m.type === "agent_message" && m.agent === "scout");
  check("Scout posted findings with sources", /Sources:/.test(scoutMsg.text), scoutMsg.text);
  const quota = await c.wait((m) => m.type === "quota");
  check("quota numbers pushed to the UI", quota.quota.some((q) => q.remainingRequests != null) && quota.plan === "free");

  c.send({ type: "get_status" });
  const status = await c.wait((m) => m.type === "status_report");
  check("status report: Tavily usage", status.report.tavily.usage?.planLimit === 1000);
  check("status report never echoes keys", !JSON.stringify(status).includes("gsk_e2e") && !JSON.stringify(status).includes("tvly-e2e"));

  // Reconnect resumes the same room with transcript and Scout history.
  const id = hello.sessionId;
  const ws3 = new WebSocket(`ws://127.0.0.1:${PORT}/?session=${id}`);
  const hello3 = await new Promise((r) => ws3.on("message", (raw) => { const m = JSON.parse(raw); if (m.type === "hello") r(m); }));
  check("reconnect resumes transcript", hello3.resumed && hello3.transcript.length >= 4);
  check("reconnect replays Scout runs", hello3.scoutRuns.length >= 1 && hello3.scoutRuns[0].steps.length > 2);
  ws3.close();

  // End session → memory + PDF.
  c.send({ type: "end_session" });
  const rep = await c.wait((m) => m.type === "report_ready", 20000);
  const pdf = await fetch(`http://127.0.0.1:${PORT}${rep.url}`);
  check("statement PDF downloads", pdf.ok && (pdf.headers.get("content-type") || "").includes("pdf"));
  check("memory saved to data dir", JSON.parse(fs.readFileSync(path.join(DATA, "memories.json"), "utf8")).length === 1);

  check("only free Groq models were called", mock.control.calls.every((x) => ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"].includes(x.model)));
  check("no key in server output", !serverLog.includes("gsk_e2e") && !serverLog.includes("tvly-e2e"));
  c.ws.close();
} catch (err) {
  failures += 1;
  console.error("FAIL ", err.message);
  console.error(serverLog.slice(-2000));
} finally {
  proc.kill("SIGTERM");
  mock.server.close();
  fs.rmSync(DATA, { recursive: true, force: true });
}
console.log(`\n${count - failures}/${count} e2e checks passed`);
process.exit(failures ? 1 : 0);
