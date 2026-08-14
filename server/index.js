// Focus Room gateway — a tiny, OpenClaw-inspired control plane:
// one server that hosts the web UI, holds the session, and routes
// each user message through the agents.

import "dotenv/config";
import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import { agents } from "./agents/registry.js";
import { doctorAgent, doctorReply, doctorOpener } from "./agents/doctor.js";
import {
  researcherAgent,
  shouldResearch,
  research,
  summarizeSession,
  professionalStatement,
} from "./agents/researcher.js";
import { getGames, getMemories } from "./store.js";
import { renderReportPdf } from "./report.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const AUTO_SUMMARY_EVERY = 8; // user messages between automatic memory saves

const app = express();
app.use(express.static(path.join(__dirname, "..", "public")));
app.get("/health", (_req, res) => res.json({ ok: true }));

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

wss.on("connection", (ws) => {
  // Per-connection session state (one user per room, like OpenClaw's single-operator model).
  const history = [];
  let userTurns = 0;
  let researching = false;

  const send = (msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  // Hello: agent roster + current library and memory so the sidebar fills in.
  send({ type: "hello", agents, games: getGames(), memories: getMemories() });


  const postAgentMessage = (agent, text) => {
    const entry = { from: "agent", agentId: agent.id, agentName: agent.name, text, at: Date.now() };
    history.push(entry);
    send({ type: "agent_message", agent: agent.id, name: agent.name, text });
  };
  // Dr. Maple opens the conversation rather than waiting to be prompted.
  (async () => {
    send({ type: "status", agent: doctorAgent.id, state: "typing" });
    try {
      const opener = await doctorOpener();
      postAgentMessage(doctorAgent, opener);
    } catch (err) {
      send({ type: "log", text: `Opener failed: ${String(err.message || err)}` });
    } finally {
      send({ type: "status", agent: doctorAgent.id, state: "idle" });
    }
  })();

  async function runDoctor() {
    send({ type: "status", agent: doctorAgent.id, state: "typing" });
    try {
      const reply = await doctorReply(history, { userTurns });
      postAgentMessage(doctorAgent, reply);
    } catch (err) {
      send({ type: "error", text: String(err.message || err) });
    } finally {
      send({ type: "status", agent: doctorAgent.id, state: "idle" });
    }
  }

  async function runResearcher(deep = false) {
    if (researching) return; // one research task at a time
    researching = true;
    try {
      const decision = await shouldResearch(history);
      if (!decision?.search || !decision.query) return;

      send({ type: "status", agent: researcherAgent.id, state: deep ? "deep-searching" : "researching" });
      const result = await research(decision.query, { deep });

      if (result.added > 0 || result.note) {
        const lines = [
          result.note || `Looked into: ${decision.query}.`,
          result.added > 0
            ? `Saved ${result.added} new item${result.added === 1 ? "" : "s"} to the game library.`
            : "Nothing new to add — the library already covers this.",
        ];
        postAgentMessage(researcherAgent, lines.join(" "));
        send({ type: "games", games: result.library });
      }
    } catch (err) {
      // Research is best-effort background work; report quietly.
      send({ type: "log", text: `Scout research failed: ${String(err.message || err)}` });
    } finally {
      researching = false;
      send({ type: "status", agent: researcherAgent.id, state: "idle" });
    }
  }

  async function runSummary({ announce } = { announce: true }) {
    send({ type: "status", agent: researcherAgent.id, state: "summarizing" });
    try {
      const memories = await summarizeSession(history);
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
      send({ type: "log", text: `Scout summary failed: ${String(err.message || err)}` });
    } finally {
      send({ type: "status", agent: researcherAgent.id, state: "idle" });
    }
  }

  async function runStatement() {
    send({ type: "status", agent: researcherAgent.id, state: "writing statement" });
    try {
      const report = await professionalStatement(history);
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
    } catch (err) {
      send({ type: "error", text: `Statement failed: ${String(err.message || err)}` });
    } finally {
      send({ type: "status", agent: researcherAgent.id, state: "idle" });
    }
  }

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "user_message" && typeof msg.text === "string" && msg.text.trim()) {
      history.push({ from: "user", text: msg.text.trim(), at: Date.now() });
      userTurns += 1;

      // Doctor answers in the foreground; Scout works in the background.
      runDoctor();
      runResearcher(msg.deep === true);

      if (userTurns % AUTO_SUMMARY_EVERY === 0) {
        runSummary({ announce: false });
      }
    }

    if (msg.type === "end_session") {
      await runSummary({ announce: true });
      await runStatement();
    }

    if (msg.type === "request_statement") {
      await runStatement();
    }

    if (msg.type === "request_research" && typeof msg.query === "string" && msg.query.trim()) {
      history.push({ from: "user", text: `(asks Scout directly) ${msg.query.trim()}`, at: Date.now() });
      if (!researching) {
        researching = true;
        const deep = msg.deep === true;
        send({ type: "status", agent: researcherAgent.id, state: deep ? "deep-searching" : "researching" });
        try {
          const result = await research(msg.query.trim(), { deep });
          postAgentMessage(
            researcherAgent,
            `${result.note || "Done."} ${result.added > 0 ? `Saved ${result.added} to the library.` : ""}`.trim()
          );
          send({ type: "games", games: result.library });
        } catch (err) {
          send({ type: "error", text: String(err.message || err) });
        } finally {
          researching = false;
          send({ type: "status", agent: researcherAgent.id, state: "idle" });
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Focus Room running → http://localhost:${PORT}`);
  if (!process.env.OPENROUTER_API_KEY) {
    console.warn("⚠ OPENROUTER_API_KEY is not set — agents will error until you add it (.env or Codespaces secret).");
  }
});
