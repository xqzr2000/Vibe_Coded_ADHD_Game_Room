# Container troubleshooting

## "This codespace is currently running in recovery mode due to a container error."

Recovery mode means the container **failed to build or start**, so Codespaces
booted a bare fallback instead. Messages like:

```
mkdir: cannot create directory '/home/node': Permission denied
touch: cannot touch '/home/node/.config/...': No such file or directory
```

are a *symptom* of recovery mode, not the cause — the recovery container runs as
a different user than the intended image, so anything expecting `/home/node`
fails. Don't chase those lines; read the creation log.

### Step 1 — read the real error

`Cmd/Ctrl + Shift + P` → **Codespaces: View Creation Log**. Look for the first
line containing `ERROR`, `failed`, or `not found`. That's the actual cause.

### Step 2 — rebuild

`Cmd/Ctrl + Shift + P` → **Codespaces: Rebuild Container**. If it still fails,
try **Full Rebuild** (ignores cached layers) — a corrupt cached layer is a
common cause of a config that used to work.

### Step 3 — if it still fails, use the fallback config

Swap in the minimal config, which uses the image Codespaces pre-caches on its
hosts and does nothing clever:

```bash
cp .devcontainer/devcontainer.minimal.json .devcontainer/devcontainer.json
```

Commit, then rebuild. If that works, the problem was in the main config — the
image tag or a lifecycle command — and the creation log will say which.

### Working while stuck in recovery mode

Recovery mode still gives you a terminal and the repo, so you are not blocked:

```bash
npm install
npm start          # then paste your Groq key in the browser
```

Then open the forwarded port 3000.

## "Port 3000 is already in use"

The server auto-starts when the codespace attaches, so a manual `npm start`
finds the port taken. You don't need to hunt for the process:

```bash
npm run stop      # stop the auto-started copy
npm run restart   # stop it and run in this terminal instead
```

Set the Codespaces variable `AUTOSTART=0` to stop it starting on attach at all.

## "We've noticed a change to the dev container configuration" — every launch

If this appears on every single launch (not just after you edit the config),
something is *writing into* `.devcontainer/` at runtime. The Dev Containers
extension watches that whole folder, not just `devcontainer.json`, so a log
file, a lock file, or a cache written there looks like a config change.

This repo had exactly that bug: the attach script wrote `server.log` into
`.devcontainer/logs/`. Logs now go to `.logs/` at the repo root instead.

If you add anything that writes at runtime, keep it out of `.devcontainer/`.

If the prompt appears **once** after you pull changes, that's correct
behaviour — your running container was built from the older config. Rebuild
once (`Cmd/Ctrl+Shift+P` → **Codespaces: Rebuild Container**) and it stops.

## How this config avoids common failure modes

- **Pinned image tag** (`1-22-bookworm`) rather than a floating one, so an
  upstream retag can't break a previously working setup.
- **Explicit `remoteUser: node` + `updateRemoteUserUID`**, which prevents the
  UID/home-directory mismatches behind most `/home/node` permission errors.
- **Every lifecycle command ends in `|| true`**, and the scripts themselves
  always `exit 0`. A failed npm install prints a warning and moves on instead
  of failing container creation.
- **`.gitattributes` forces LF endings** on `*.sh`. A Windows checkout that
  converts scripts to CRLF makes bash fail with `\r: command not found`, which
  reads like a mysterious container error.
- **Strict JSON, no comments**, so any parser handles the file identically.

## Local VS Code (Dev Containers) vs Codespaces

The same `devcontainer.json` serves both. Differences worth knowing:

- **Secrets.** Codespaces secrets (`GROQ_API_KEY`, `TAVILY_API_KEY`,
  `ALLOW_SERVER_KEYS`) only exist in Codespaces. Locally, put the same lines in
  `.env` in the repo folder — it's mounted into the container and git-ignored.
- **Ports.** Both forward port 3000. Locally it's <http://localhost:3000>; in
  Codespaces use the Ports tab. Inside a container the server listens on
  `0.0.0.0` so forwarding works; on a bare Ubuntu machine it defaults to
  `127.0.0.1`.
- **File ownership.** `updateRemoteUserUID` maps the container's `node` user to
  your Linux UID, so files the app writes in `data/` stay owned by you.
