# Focus Room

A two-agent ADHD screening-conversation and research room that runs as a small Node.js app.

- **Dr. Maple** leads a structured, screening-style conversation. It is educational, not diagnostic, and points you to a real clinician. Replies stream in as she writes them, with a short line showing what she's doing (reading your message → the topic she's on → thinking → writing).
- **Scout** researches in the background: attention-training games, how to get assessed where you live, prices and coverage. Every search, every page it reads, and its reasoning in between show up live in the **Scout activity** panel. Scout also saves session summaries to long-term memory and can write a neutral PDF statement for a clinician.

**Groq only, free models only.** Focus Room calls nothing but the models on Groq's Free plan. Scout's web search uses **Tavily** (free, 1,000 credits a month) and falls back to DuckDuckGo when there's no Tavily key.

There are no accounts and no database. Your preferred name and icon are saved in your browser, and the agents call you by that name now and then.

---

## Run it — pick one

### A. GitHub Codespaces

1. On GitHub: **Code → Codespaces → Create codespace on main**.
2. Wait for the container to build. The app starts by itself and port 3000 opens in a new tab (or open it from the **Ports** tab).
3. Paste your Groq key when the app asks (see [Keys](#keys) below).

Optional — skip pasting keys: add **Codespaces secrets** (GitHub → your repo → *Settings → Secrets and variables → Codespaces*) named `GROQ_API_KEY`, `TAVILY_API_KEY`, and `ALLOW_SERVER_KEYS` = `1`, then rebuild the codespace. Only do this while the port stays **Private** (the default), because anyone who can open the page can then use your keys.

### B. Local VS Code with the dev container

Needs Docker and the VS Code **Dev Containers** extension.

1. Open the folder in VS Code → **Reopen in Container** (or `F1` → *Dev Containers: Reopen in Container*).
2. The app starts by itself; VS Code forwards it to <http://localhost:3000>.
3. Keys: paste them in the app, or put them in `.env` (see below). Codespaces secrets don't apply locally — `.env` is the local equivalent.

### C. Ubuntu, no container — `npm start`

Needs Node.js **20.3 or newer** (22 recommended). Ubuntu's own `nodejs` package is often too old; the simplest fix is nvm:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 22          # the repo's .nvmrc also says 22, so later just: nvm use
```

Then:

```bash
cd ADHD
npm install
cp -n .env.example .env   # optional; edit it to add keys
npm start
```

Open <http://localhost:3000>. By default the server listens on this machine only; set `HOST=0.0.0.0` in `.env` to reach it from your phone or another computer on your network (plain HTTP — keep that to a network you trust).

`npm run check` tests the keys in `.env` from the terminal without starting the app.

---

## Keys

### Groq (required)

1. Go to <https://console.groq.com/keys> and sign in.
2. **Create API Key**, name it "Focus Room", copy it (starts with `gsk_`).
3. Paste it into the app's welcome screen, or later in **⚙ Settings → Groq key → Test → Save**.

### Tavily (optional, recommended for Scout)

1. Go to <https://app.tavily.com> and sign up — no card needed.
2. Copy your API key from the dashboard (starts with `tvly-`).
3. In the app: **⚙ Settings → Web search for Scout**, paste it, click **Test**, then **Save**.

The free plan is 1,000 credits a month. One Scout run is capped at 2 searches + reading up to 3 pages, about **3 credits**, so roughly 300 research runs a month. Without a Tavily key Scout uses DuckDuckGo and reads pages itself, which works but can get blocked from cloud servers (Codespaces especially).

### Where keys live

- Pasted keys are saved in **your browser** (localStorage) and sent to the server only to make your own calls. The server never writes them to disk or logs.
- Keys in `.env` or Codespaces secrets are used **only if `ALLOW_SERVER_KEYS=1`**. Leave it at `0` for anything other people can reach; set it to `1` on your own private machine and you'll never need to paste a key.

---

## How "free only" is enforced

- **Allowlist.** `server/models.js` lists the Free-plan models: `openai/gpt-oss-120b`, `qwen/qwen3.8-27b`, `openai/gpt-oss-20b`. The server refuses to call anything else, whatever the browser asks for.
- **Plan check.** Groq's API can't say which plan a key is on, but every response reports its daily request cap. Settings shows **Free plan** when that cap is 1,000/day, and warns if it's higher — that would be a paid Developer account, where even these models can be billed.
- **Tavily.** Focus Room reads your Tavily usage and stops calling Tavily once the month's free credits are spent (DuckDuckGo takes over), so an account with pay-as-you-go turned on isn't billed by this app.
- **When Groq changes its Free plan**, edit `FREE_MODELS` in `server/models.js`, or set `GROQ_FREE_MODELS=…` in `.env`. The app checks Groq's live model list and skips any listed model Groq has retired (Settings shows it as *retired*).

## Fallback between free models

Each free model has its own allowance (Free plan: 30 requests/minute, 1,000/day, 8,000 tokens/minute, 200,000 tokens/day), so moving to another model really does reach fresh quota.

- Dr. Maple tries **GPT-OSS 120B → Qwen 3.8 27B → GPT-OSS 20B**.
- Scout tries **GPT-OSS 20B → Qwen 3.8 27B → GPT-OSS 120B**. Starting on different models means a research burst can't use up the per-minute allowance the conversation needs.
- Before each call the app checks the quota numbers Groq sent back last time and skips a model that is about to run out, rather than waiting for an error. A model that fails rests for a while; a short wait is used only when every model is briefly busy (Dr. Maple waits at most ~2.5s, Scout up to ~12s).
- Older conversation is trimmed so a long session stays inside the 8,000-tokens-per-minute limit.
- You can pick each agent's starting model in Settings; the rest of the chain follows.

## Scout's web search (Node only)

Scout runs a small agent loop using Groq tool calling: **plan → `web_search` → read results → `read_pages` → think → write**. If a model mangles its tool calls, a fixed pipeline does the same job (search → read the top pages → write). If no search backend works at all, Scout tries Groq's built-in `browser_search` (GPT-OSS models only), and only then answers from general knowledge — and says so.

Every step is streamed to the **Scout activity** panel: the queries, the results (site + title), which pages were read or failed, the model's reasoning (collapsible), and what got saved to the library. The last few runs are replayed if you refresh the page.

## Settings (⚙ / your name in the header)

- **You** — preferred name, icon and color. Saved in this browser.
- **Groq key** — paste, show/hide, **Test** (lists models, costs no tokens).
- **Connection** — live link to the server, server version and uptime, Groq reachability and latency, which search backend is active. **Run checks** re-tests everything.
- **Models & quota** — starting model per agent; requests left today and tokens left this minute for each free model; models that are resting; plan detection. *Refresh numbers* spends 1 request to get fresh figures.
- **Web search for Scout** — Tavily key, **Test** (runs one search, 1 credit), credits used this month, how-to.

## Safety

Crisis detection runs in deterministic server code before any model call. On a crisis disclosure the screening stops, Scout is disabled for the session, and fixed supportive text is used instead of model output. That reply is not streamed.

Dr. Maple's raw reasoning is never shown — only step labels. Raw model reasoning can include diagnostic-sounding speculation and the hidden stage plan, which the app is designed to keep out of the conversation. Scout's reasoning *is* shown, because it's about searching, not about you.

## Memory and privacy

- Session summaries go to `data/memories.json` on the machine running Focus Room. Set `LOCAL_MEMORY=0` to keep nothing.
- `data/memories.json` is git-ignored. If an older copy of the repo already tracks it, run `git rm --cached data/memories.json` once so your summaries are never pushed to GitHub.
- The game library (`data/games.json`) is shared, non-personal research.

## Commands

```bash
npm start          # start (checks Node version and dependencies first)
npm run dev        # start with auto-reload on file changes
npm run stop       # stop a running copy (auto-started or not)
npm run restart    # stop, then start in this terminal
npm run check      # test the keys in .env from the terminal
npm test           # logic + integration tests against local mock services
npm run test:e2e   # starts the real server and drives it like a browser
```

Tests need no network or real keys: `tests/mock-services.mjs` stands in for Groq, Tavily, DuckDuckGo and a few web pages.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Port 3000 is already in use" | It's already running (the container starts it on attach). Open it, or `npm run restart`. Set `AUTOSTART=0` to stop auto-start. |
| "Focus Room needs Node.js 20.3 or newer" | Install Node 22 with nvm (above), or use the dev container. |
| "Dependencies aren't installed yet" | `npm install` |
| Key rejected | Settings → Groq key → paste a fresh key from console.groq.com/keys → Test. |
| "Every free Groq model is busy" | Free per-minute limits refill within a minute — press *Try again*. If it persists, check the daily numbers in Settings → Models & quota. |
| Scout says no web search is available | Add a Tavily key. DuckDuckGo often blocks cloud IPs like Codespaces. |
| A model shows as *retired* | Groq dropped it — update `FREE_MODELS` in `server/models.js` from <https://console.groq.com/docs/rate-limits>. |

Container-specific problems (recovery mode, rebuild prompts): see `.devcontainer/README.md`.

## See it in action

https://github.com/user-attachments/assets/4668038a-875c-45f3-b3a6-fdbb7961319e

