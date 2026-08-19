# Vibe_Coded_ADHD_Game_Room

A small multi-agent chat room to **screen** for ADHD and recommend therapeutic games like **EndeavorOTC (for adults 18+)**. Inspired by [OpenClaw](https://github.com/openclaw/openclaw)'s single-operator gateway, agents, and workspace-files architecture, this project is built as a single, lightweight Node.js app designed to **run on GitHub Codespaces in just one click**. (And now it's Android App ready. )

> **Important framing:** this is a screening and education tool, **not** a diagnostic or prescribing system. No AI can diagnose ADHD; The agent, Dr. Maple's prompt explicitly keeps it to screening-style conversation and always points to licensed clinicians for evaluation. Note also that **EndeavorRx (ages 8–17) is prescription-only**; the app can refer to it, but a real prescriber has to be involved. **EndeavorOTC (adults 18+)** is available over the counter.

---

## Putting the "Fail Fast, Iterate Faster" ideology into practice.

Vibe_Coded_ADHD_Game_Room launches the first Node.js app with a web interface in the "Vibe Coded" series. Its goal is to deliver tangible code that can be tested, edited, and improved, with speed.

*This series is based on memos from brainstorming sessions with Wael.*

---

## Codespaces Quick Start 

Ready when you are!

1. Fork or clone this repository. Give me a GitHub Star.
2. Click **Code** → **Codespaces** → **Create codespace on main** → (a few moments later...) **Trust the folder and Continue**.
3. Port 3000 auto-starts and opens the Focus Room preview automatically. You can also open that URL in a new Tab.
4. Sign in with **OpenRouter** and chat.

### OpenRouter sign-in gate: bring your own key (BYOK)

The room stays locked until **your browser** holds an API key. 

Luckily, OpenRouter offers it for free.

**Sign in:** click **Connect OpenRouter** (`OAuth PKCE`, `S256`). OpenRouter redirects back with a one-time code, and your browser exchanges it for a user-controlled API key stored locally.

**No information leaves your browser,** because you host the backend. Returning users get a fresh key without touching existing ones.

**Extras:** the ⚙ drawer shows usage/limits, owner-only key links, and accepts optional free backup keys (OpenRouter, Groq, Gemini are free, and Deepseek is really cheap) for independent fallback routes. All stored in-browser.

**Enforcement:** the gate is also enforced over WebSocket, and a rejected key (`bad_key`) is cleared automatically, reopening the gate.

---

## Current agents

### Dr. Maple: `server/agents/doctor.js`

Dr. Maple's mission is simple: **run the screening conversation.**

She opens the conversation and drives it through a six-stage plan: orient → attention → organization → restlessness → history → next steps. 

Along the way she:

- keeps replies short and dry-witted;
- echoes what you said back as a *different* concrete example to test whether the pattern is real;
- recaps the picture every four turns;
- suggests games from the shared library;
- reads long-term memory so returning sessions pick up where you left off.

### Scout: `server/agents/researcher.js`

Scout is the research agent. 

She investigates evidence-based attention-training games, assessment pathways, pricing, and insurance coverage. Findings are persisted to shared JSON memory, and Scout can generate a neutral, clinician-ready PDF session statement on demand.

#### Background behavior

Scout runs passively alongside the conversation and activates when she detects something worth researching:

- Monitors the conversation and reacts when a searchable topic comes up
- Performs web searches for EndeavorRx / EndeavorOTC and other evidence-based attention-training games
- Fetches the official pages it finds and runs an enrichment pass (pricing, platforms, prescription requirements) before saving anything
- Saves enriched game data to local storage (`data/games.json`)
- Writes session summaries to long-term memory (`data/memories.json`)
- On request, or at session end, produces a professional session statement, downloadable as a PDF to share with a clinician

#### Task capabilities

Scout supports three task types, implemented in `server/agents/scout-tasks.js`. Requests are routed in one of three ways: keyword matching, the background decision call, or explicitly via the buttons under the composer.

| Task | Triggered by | Output |
|---|---|---|
| **games** | Default; e.g. "what else is there", "apps like X" | Library entries: target audience, access requirements, platform, evidence base, official URL |
| **clinicians** | "Find how to get assessed" button; e.g. "who can diagnose me", "waitlist", "referral" | Assessment routes in your area (public and private), searchable professional registers, typical costs and wait times, and suggested questions to ask when booking |
| **deals** | "Check prices & coverage" button; e.g. "how much", "insurance", "discount" | Current list prices, free trials, and coverage details (insurance, FSA/HSA, funding programs), written back into the library so Dr. Maple can quote them |

Scout gathers and organizes the information; the final decision always stays with you.

#### Deep search (experimental)

Enable **Deep search** in the UI to route Scout's research through a real headless browser instead of standard web search. This module is forked from [browser-use](https://github.com/browser-use/browser-use).

> ⚠️ **Experimental:** Deep search currently has a loooong startup time and is still under active development. Standard search is recommended for now.

If web search or page fetching fails, whether due to blocked requests or unexpected HTML changes, the chat continues to work normally. Scout receives the attempted search URL along with an explicit failure note, ensuring her never fabricates results.


---

## Add another agent

to be updated

---

## How Dr. Maple runs a conversation

The agent isn't a passive Q&A box. Four behaviors are baked into its prompt and its wiring:

- **It opens.** On connect, Dr. Maple posts first with a specific question, so there's no empty room, no dry "how can I help you?".
- **It follows a plan.** `PLAN` in `server/agents/doctor.js` defines six stages; the agent spends ~3 exchanges per stage and advances automatically as your turn count grows. The structure is invisible to the user, it never announces stages.
- **It echoes with a different example.** Its signature move: when you describe something, it offers a *different* concrete situation that would reveal the same underlying pattern and asks whether that one lands too. That's how it checks whether a pattern is general rather than one bad week.
- **It recaps.** Every 4 user turns the prompt switches on a checkpoint: a short "here's the picture I'm building, correct me before the next question".

Tune any of it by editing `PLAN`, `TURNS_PER_STAGE`, or `RECAP_EVERY` at the top of `server/agents/doctor.js`.

---

## The session statement (PDF)

Click **Write statement (PDF)** any time, or **End session & save memory** (which saves memory *and* writes the statement).

Scout re-reads the conversation and produces a neutral, third-person write-up: purpose, summary, reported experiences, areas discussed, resources reviewed, next steps, and questions to ask a clinician, then a download card appears under the chat.

Rendering is `server/report.js` using [pdfkit](https://pdfkit.org): pure JS, streamed straight to the HTTP response, nothing written to disk. 

Statements live in memory keyed by id and disappear on restart, so no transcript-derived documents are persisted to the repo. The statement's language is constrained by prompt: it describes only what was reported and never asserts a diagnosis, and every PDF carries a disclaimer footer.

---

## Token Scavenger

New OpenRouter accounts usually start with a small free credit. That credit is enough to run stronger models, such as Claude; these models will power Dr. Maple's conversation, and Scout’s web search for a while. However, once the free credit runs out, the agents may slow down, lose access to stronger models, or stop responding if no usable free model is available.

**Token Scavenger** is the project’s automatic fallback system for handling this problem. Instead of asking users to edit configuration files or manually switch models, the app quietly looks for another usable model in the background and keeps the conversation moving.

### Automatic model fallback

When a model call fails for a recoverable reason, the agent walks through a fallback chain:

```text
your selected model
→ other free models on the same provider
→ free models on any other provider you have a key for
→ live discovery from the provider catalogue
→ use the best available free model found

Or, ideally, BYOK (Bring Your Own Key)
→ the user provides an API key and selects their preferred model

```

---

## Repository layout

```text
Vibe_Coded_ADHD_Game_Room/
├── server/                  ← the app
│   ├── index.js                 orchestrator: HTTP + WebSocket + turn-taking
│   ├── config.js                per-session settings & key resolution
│   ├── providers.js             registry: OpenRouter / Groq / Gemini / custom
│   ├── llm.js                   one chat client + error classification
│   ├── fallback.js              automatic route switching, circuit breaking
│   ├── safety.js                deterministic crisis detection
│   ├── fetcher.js               lightweight page → text
│   ├── store.js                 JSON persistence (games, memories)
│   ├── report.js                PDF rendering
│   ├── diagnose.js              "why aren't the agents responding?"
│   └── agents/
│       ├── registry.js          agent list / extension point
│       ├── doctor.js            Dr. Maple — conversation lead
│       ├── researcher.js        Scout — background research pipeline
│       └── scout-tasks.js       what Scout can research
├── public/
│   └── index.html            ← the entire frontend
├── browser-service/         ← optional Python sidecar (deep search)
│   ├── app.py
│   └── requirements.txt
├── data/
│   ├── games.json
│   └── memories.json
├── .devcontainer/           ← Codespaces boot
│   ├── devcontainer.json
│   ├── setup.sh
│   ├── on-attach.sh
│   └── devcontainer.minimal.json
├── scripts/
│   └── stop.sh
├── tests/
│   └── run.mjs
├── setup-browser-service.sh
├── package.json
├── package-lock.json
├── .env.example
├── .gitattributes
├── .gitignore
├── .npmrc
└── README.md

```
