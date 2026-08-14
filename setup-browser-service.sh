#!/usr/bin/env bash
# Sets up the optional browser-use sidecar (deep search).
# Safe to re-run; skipped gracefully if python3 is unavailable.
set -e
cd "$(dirname "$0")/browser-service"

if ! command -v python3 >/dev/null; then
  echo "python3 not found — skipping browser sidecar setup (deep search will fall back to standard search)."
  exit 0
fi

python3 -m venv .venv
./.venv/bin/pip install --quiet --upgrade pip
./.venv/bin/pip install --quiet -r requirements.txt
# Chromium + system deps for headless browsing
./.venv/bin/playwright install --with-deps chromium || ./.venv/bin/playwright install chromium
echo "Browser sidecar ready. Start it with: npm run browser"
