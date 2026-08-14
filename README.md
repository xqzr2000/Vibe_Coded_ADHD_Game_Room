# Focus Room 🦞

A small multi-agent chat room, inspired by [OpenClaw](https://github.com/openclaw/openclaw)'s single-operator gateway + agents + workspace-files architecture, but built as one tiny Node app so it runs anywhere — including GitHub Codespaces in one click.

Two agents share the room with you:

| Agent | Model (default) | What it does |
|---|---|---|
| **Dr. Maple** — screening companion | `anthropic/claude-sonnet-4` | Opens the conversation and drives it. Works a six-stage plan (orient → attention → organization → restlessness → history → next steps), keeps replies short and dry-witted, echoes what you said back as a *different* concrete example to test whether the pattern is real, and recaps the picture every four turns. Suggests games from the shared library and reads long-term memory so returning sessions pick up where you left off. |
| **Scout** — researcher | `openai/gpt-4o-mini` + OpenRouter `:online` web search | Watches the conversation in the background. When something searchable comes up, it web-searches for EndeavorRx / EndeavorOTC and other evidence-based attention-training games, **then fetches the official pages it found and runs an enrich pass** (pricing, platforms, prescription requirements) before saving to local storage (`data/games.json`). Also writes session summaries to long-term memory (`data/memories.json`) and, on request or at session end, a **professional statement you can download as a PDF** to bring to a clinician. Tick **Deep search** in the UI to route research through a real headless browser instead (browser-use sidecar). |

> **Important framing:** this is a screening and education tool, **not** a diagnostic or prescribing system. No AI can diagnose ADHD; Dr. Maple's prompt explicitly keeps it to screening-style conversation and always points to licensed clinicians for evaluation. Note also that **EndeavorRx (ages 8–17) is prescription-only** — the app can describe it, but a real prescriber has to be involved. **EndeavorOTC (adults 18+)** is available over the counter.

## Run in GitHub Codespaces

1. Push this repo to GitHub, then click **Code → Codespaces → Create codespace on main**.
2. Add your OpenRouter key (get one at <https://openrouter.ai/keys>) either way:
   - **Recommended:** GitHub → Settings → Codespaces → Secrets → add `OPENROUTER_API_KEY` for this repo (the devcontainer requests it automatically), or
   - edit the `.env` file that's created for you on first boot.
3. In the terminal:
   ```bash
   npm start
   ```
4. Codespaces forwards port 3000 and opens a preview automatically. Chat away.

## Run locally

```bash
cp .env.example .env   # add your OPENROUTER_API_KEY
npm install
npm start              # http://localhost:3000
```

## How it works

```
browser ──WebSocket──► server/index.js  (the "gateway": session, routing, orchestration)
                         │
              ┌──────────┴──────────────┐
              ▼                         ▼
   agents/doctor.js            agents/researcher.js
   replies in the              background loop:
   foreground, reading         1. cheap "should I search?" decision call
   games + memory into         2a. STANDARD: :online web search → drafts
   its system prompt               → fetch official pages (server/fetcher.js)
                                   → enrich pass → JSON
                               2b. DEEP (checkbox): browser-use sidecar
                                   (POST /task) → structure findings → JSON
                                   ↳ falls back to standard if sidecar is down
                               3. dedupe + save to data/games.json
                               4. session summaries → data/memories.json
              │                         │
              └────────► data/ ◄────────┘
                 games.json  memories.json   (shared, human-readable workspace files)

browser-service/app.py  = optional FastAPI sidecar wrapping browser-use
                          (real headless Chromium; same OpenRouter key)
```

- **One key, everything through OpenRouter.** Chat completions and web search both go through the OpenRouter API (`server/openrouter.js`); the researcher appends `:online` to its model to enable OpenRouter's built-in web search plugin.
- **Memory is just files.** Like OpenClaw's workspace, long-term state is plain JSON you can read and edit. Delete a file to reset it. Summaries are written automatically every 8 user messages and whenever you click **End session & save memory**.
- **The doctor sees what the researcher saves.** Every doctor turn rebuilds its system prompt from the current `games.json` and the last 5 entries of `memories.json`.
- **Two research depths.** By default Scout searches, then *fetches the official pages it found* and verifies/enriches its entries against the real page text — fast and cheap. The **Deep search** checkbox next to the chat input switches research to the browser-use sidecar: a real headless browser that can navigate and read rendered pages (current pricing, app-store details). Deep search is slower and costs more model calls; if the sidecar isn't running, Scout falls back to standard search automatically and says so.

## Deep search (browser-use sidecar)

In Codespaces the devcontainer sets this up automatically. Locally:

```bash
npm run setup:browser   # one-time: venv + browser-use + headless Chromium
npm run browser         # keep running in a second terminal (port 8010)
```

Then tick **Deep search** in the UI. Both chat messages (background research) and the "Ask Scout to research…" button respect the checkbox.

## How Dr. Maple runs a conversation

The agent isn't a passive Q&A box. Four behaviors are baked into its prompt and its wiring:

- **It opens.** On connect, Dr. Maple posts first with a specific question — no empty room, no "how can I help you?".
- **It follows a plan.** `PLAN` in `server/agents/doctor.js` defines six stages; the agent spends ~3 exchanges per stage and advances automatically as your turn count grows. The structure is invisible to the user — it never announces stages.
- **It echoes with a different example.** Its signature move: when you describe something, it offers a *different* concrete situation that would reveal the same underlying pattern and asks whether that one lands too. That's how it checks whether a pattern is general rather than one bad week.
- **It recaps.** Every 4 user turns the prompt switches on a checkpoint: a short "here's the picture I'm building — correct me" before the next question.

Tune any of it by editing `PLAN`, `TURNS_PER_STAGE`, or `RECAP_EVERY` at the top of `server/agents/doctor.js`.

## The session statement (PDF)

Click **Write statement (PDF)** any time, or **End session & save memory** (which saves memory *and* writes the statement). Scout re-reads the conversation and produces a neutral, third-person write-up — purpose, summary, reported experiences, areas discussed, resources reviewed, next steps, and questions to ask a clinician — then a download card appears under the chat.

Rendering is `server/report.js` using [pdfkit](https://pdfkit.org): pure JS, streamed straight to the HTTP response, nothing written to disk. Statements live in memory keyed by id and disappear on restart, so no transcript-derived documents are persisted to the repo. The statement's language is constrained by prompt: it describes only what was reported and never asserts a diagnosis, and every PDF carries a disclaimer footer.

## Adding more agents (designed for it)

1. Create `server/agents/youragent.js` exporting an agent card `{ id, name, role, color }` plus its behavior function(s).
2. Register the card in `server/agents/registry.js` — the presence rail and message styling in the UI pick it up automatically.
3. Wire its behavior into the orchestrator in `server/index.js` (e.g. call it after the doctor, or on a custom message type like `request_research`).

Ideas: a coach agent for daily routines, a note-taker that exports Markdown reports, a scheduler that helps find a real clinician.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | — | Required. Used by all agents. |
| `DOCTOR_MODEL` | `anthropic/claude-sonnet-4` | Any OpenRouter model id. |
| `RESEARCHER_MODEL` | `openai/gpt-4o-mini` | Any OpenRouter model id; `:online` is appended for searches. |
| `PORT` | `3000` | Server port. |
| `BROWSER_SERVICE_URL` | `http://127.0.0.1:8010` | Where the deep-search sidecar listens. |
| `BROWSER_MODEL` | `openai/gpt-4o-mini` | Model the browser agent uses (via OpenRouter). |
| `BROWSER_MAX_STEPS` | `20` | Max browser-agent steps per deep task. |
| `BROWSER_TIMEOUT_MS` | `240000` | How long the Node app waits for a deep task. |

## License

MIT
