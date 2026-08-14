# Vibe_Coded_ADHD_Game_Room

A small multi-agent chat room to **screen** for ADHD and recommend therapeutic games like **EndeavorOTC (for adults 18+)**. Inspired by [OpenClaw](https://github.com/openclaw/openclaw)'s single-operator gateway, agents, and workspace-files architecture, this project is built as a single, lightweight Node.js app designed to **run on GitHub Codespaces in just one click**.

> **Important framing:** this is a screening and education tool, **not** a diagnostic or prescribing system. No AI can diagnose ADHD; The agent, Dr. Maple's prompt explicitly keeps it to screening-style conversation and always points to licensed clinicians for evaluation. Note also that **EndeavorRx (ages 8–17) is prescription-only**; the app can refer to it, but a real prescriber has to be involved. **EndeavorOTC (adults 18+)** is available over the counter.

---

## Putting the "Fail Fast, Iterate Faster" ideology into practice.

Vibe_Coded_ADHD_Game_Room launches the first Node.js app with a web interface in the "Vibe Coded" series. Its goal is to deliver tangible code that can be tested, edited, and improved, with speed.

*This series is based on memos from brainstorming sessions with Wael.*

## Codespaces Quick Start: `npm start`

### Step 0: Fork or clone this repository to GitHub.

### Step 1: Set up the OpenRouter API Key in GitHub Codespaces

**OpenRouter account → API key → GitHub Codespaces Secret → Environment variable → Your code**

1. Sign up for free on [OpenRouter](https://openrouter.ai/).
2. Go to **Keys** / **API Keys**, then click **Create Key** with the name `github-codespace`.
It will look something like: `sk-or-v1-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
3. In your GitHub repository, navigate to **Settings** → **Secrets and variables** → **Codespaces** choose this repo → **Codespaces secrets** → **New secret**.
4. Set the **Name** to: `OPENROUTER_API_KEY`
5. Paste your OpenRouter key into the **Value** field and click **Add secret**.

### Step 2: Spin Up the Codespace

1. Click **Code** → **Codespaces** → **Create codespace on main**.
2. In the Codespace terminal, run: `npm start`.
3. Codespaces forwards port 3000 and opens a preview automatically. Chat away.

---

## Current agents

### Dr. Maple: `agents/dr_maple.py`

Dr. Maple's mission is simple: **run the screening conversation.** (Default model: `openrouter/free`.)

She opens the conversation and drives it through a six-stage plan: orient → attention → organization → restlessness → history → next steps. 

Along the way she:

- keeps replies short and dry-witted;
- echoes what you said back as a *different* concrete example to test whether the pattern is real;
- recaps the picture every four turns;
- suggests games from the shared library;
- reads long-term memory so returning sessions pick up where you left off.

### Scout: `agents/scout.py`

Scout takes the background role. (Default model: `openrouter/free` + OpenRouter `:online` web search.) 

Scout:

- watches the conversation silently and reacts when something searchable comes up;
- web-searches for EndeavorRx / EndeavorOTC and other evidence-based attention-training games;
- fetches the official pages it found and runs an enrich pass (pricing, platforms, prescription requirements) before saving anything;
- saves enriched game data to local storage (`data/games.json`);
- writes session summaries to long-term memory (`data/memories.json`);
- on request or at session end, produces a professional statement you can download as a PDF to bring to a clinician.

Tick **Deep search** in the UI to route Scout's research through a real headless browser instead, module forked from [browser-use](https://github.com/browser-use/browser-use).

If web search or page fetching blocks the request or changes its HTML, the chat keeps working and Scout receives the search URL plus a clear failure note instead of fabricated results.

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

Rendering is `server/report.js` using [pdfkit](https://pdfkit.org): pure JS, streamed straight to the HTTP response, nothing written to disk. Statements live in memory keyed by id and disappear on restart, so no transcript-derived documents are persisted to the repo. The statement's language is constrained by prompt: it describes only what was reported and never asserts a diagnosis, and every PDF carries a disclaimer footer.

---

## Repository layout

To add later
