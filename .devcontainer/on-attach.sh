#!/usr/bin/env bash
# Runs every time VS Code (local or Codespaces) attaches to the container.
# Must never block and never fail the container.

cd "$(dirname "$0")/.." || exit 0
# Logs live OUTSIDE .devcontainer/: the Dev Containers extension watches that
# folder, and a log file written there triggers "configuration changed" prompts.
mkdir -p .logs 2>/dev/null

PORT="${PORT:-3000}"

# Dependencies missing (creation interrupted, or a fresh local clone)? Recover.
if [ ! -d node_modules/express ]; then
  echo "→ Installing dependencies…"
  bash .devcontainer/setup.sh || true
fi

# Key status, without printing any key.
if [ -n "${GROQ_API_KEY:-}" ] || grep -qE '^GROQ_API_KEY=.+' .env 2>/dev/null; then
  if [ "${ALLOW_SERVER_KEYS:-}" = "1" ] || grep -qE '^ALLOW_SERVER_KEYS=1' .env 2>/dev/null; then
    echo "✓ Groq key found and ALLOW_SERVER_KEYS=1 — the browser won't ask for a key."
  else
    echo "→ Groq key found but ALLOW_SERVER_KEYS isn't 1 — the browser will ask you to paste a key."
  fi
else
  echo "→ No server Groq key — paste yours in the browser (free at console.groq.com/keys)."
fi

if [ "${AUTOSTART:-1}" = "0" ]; then
  echo "→ Auto-start disabled (AUTOSTART=0). Run 'npm start' when you want it."
elif curl -sf "http://localhost:${PORT}/health" >/dev/null 2>&1; then
  echo "✓ Focus Room already running → port ${PORT}"
else
  # Start node directly (not via npm) so the recorded PID is the server itself.
  nohup node server/start.js > .logs/server.log 2>&1 &
  READY=0
  for _ in $(seq 1 40); do
    if curl -sf "http://localhost:${PORT}/health" >/dev/null 2>&1; then READY=1; break; fi
    sleep 0.25
  done
  if [ "$READY" = "1" ]; then
    if [ -n "${CODESPACES:-}" ]; then
      echo "✓ Focus Room ready → open port ${PORT} from the Ports tab"
    else
      echo "✓ Focus Room ready → http://localhost:${PORT}"
    fi
    echo "  Stop: npm run stop   Restart: npm run restart   Logs: .logs/server.log"
  else
    echo "⚠ Port ${PORT} didn't answer in 10s. Last lines of .logs/server.log:"
    tail -8 .logs/server.log 2>/dev/null | sed 's/^/    /'
  fi
fi

exit 0
