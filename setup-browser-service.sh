#!/usr/bin/env bash
# Sets up the optional browser-use sidecar used by "Deep search".
# Never fails the Codespace: standard research remains available if this breaks.
#
# Usage: npm run setup:browser
#        bash setup-browser-service.sh --autostart
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT/browser-service"

fail() { echo "⚠ $1 — deep search will fall back to standard search."; exit 0; }

if ! command -v python3 >/dev/null; then
  echo "→ python3 not found; attempting install…"
  sudo apt-get update -qq && sudo apt-get install -y -qq python3 python3-venv || fail "could not install python3"
fi

if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv 2>/dev/null || {
    sudo apt-get update -qq && sudo apt-get install -y -qq python3-venv || fail "python3-venv unavailable"
    python3 -m venv .venv || fail "could not create virtualenv"
  }
fi

REQ_HASH="$(sha1sum requirements.txt 2>/dev/null | cut -d' ' -f1 || echo unknown)"
STAMP=".venv/.focus-room-browser-ready"

if [ -f "$STAMP" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$REQ_HASH" ]; then
  echo "✓ Deep search dependencies already in sync."
else
  echo "→ Installing browser-use…"
  ./.venv/bin/pip install --quiet --upgrade pip || fail "pip upgrade failed"
  ./.venv/bin/pip install --quiet -r requirements.txt || fail "pip install failed"

  echo "→ Installing headless Chromium…"
  # Prefer Browser Use's installer so its browser build matches the package.
  ./.venv/bin/browser-use install 2>/dev/null \
    || ./.venv/bin/python -m playwright install --with-deps chromium 2>/dev/null \
    || ./.venv/bin/python -m playwright install chromium \
    || fail "Chromium install failed"

  echo "$REQ_HASH" > "$STAMP"
  echo "✓ Deep search ready."
fi

if [ "${1:-}" = "--autostart" ]; then
  cd "$ROOT"
  mkdir -p .logs 2>/dev/null
  if curl -sf http://127.0.0.1:8010/health >/dev/null 2>&1; then
    echo "✓ Sidecar is already running on port 8010."
  else
    nohup npm run browser > .logs/browser.log 2>&1 &
    echo "✓ Sidecar started on port 8010."
  fi
else
  echo "  Start it with: npm run browser"
fi
