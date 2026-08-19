#!/usr/bin/env bash
# Runs on every attach. Must never block and never fail the container.

cd "$(dirname "$0")/.." || exit 0
# Logs deliberately live OUTSIDE .devcontainer/: the Dev Containers extension
# watches that folder, so writing a log file there makes VS Code announce
# "we've noticed a change to the dev container configuration" on every launch.
mkdir -p .logs 2>/dev/null

# Dependencies missing (e.g. creation was interrupted)? Recover quietly.
if [ ! -d node_modules ]; then
  echo "→ node_modules missing; installing now…"
  bash .devcontainer/setup.sh || true
fi

# 1. Start the app unless it's already answering.
#    Set the Codespaces variable AUTOSTART=0 if you'd rather start it yourself.
if [ "${AUTOSTART:-1}" = "0" ]; then
  echo "→ Auto-start disabled (AUTOSTART=0). Run 'npm start' when you want it."
elif curl -sf "http://localhost:${PORT:-3000}/health" >/dev/null 2>&1; then
  echo "→ Focus Room is already running on port ${PORT:-3000}."
else
  # Start node directly rather than through npm, so the PID we record is the
  # server itself — killing an npm wrapper can leave the child holding the port.
  nohup node server/index.js > .logs/server.log 2>&1 &
  echo "→ Focus Room starting on port ${PORT:-3000} (logs: .logs/server.log)"
  echo "   Stop it any time with: npm run stop     Take it over with: npm run restart"
fi

# 2. Optional deep-search sidecar, always in the background.
#    Set the Codespaces variable SETUP_BROWSER=0 to skip it entirely.
if [ "${SETUP_BROWSER:-1}" = "1" ]; then
  if [ -x browser-service/.venv/bin/uvicorn ]; then
    if ! curl -sf http://127.0.0.1:8010/health >/dev/null 2>&1; then
      nohup npm run browser > .logs/browser.log 2>&1 &
      echo "→ Deep-search sidecar starting on port 8010."
    fi
  else
    echo "→ Preparing deep search in the background (standard search already works)."
    nohup bash setup-browser-service.sh --autostart > .logs/browser-setup.log 2>&1 &
  fi
fi

exit 0
