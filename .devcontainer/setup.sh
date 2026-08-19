#!/usr/bin/env bash
# Runs at container CREATE time (cached by Codespaces prebuilds).
# Deliberately NEVER exits non-zero: a failure here must not push the
# codespace into recovery mode. Anything that breaks is reported and skipped.

cd "$(dirname "$0")/.." || exit 0

echo "→ Focus Room setup starting (node $(node --version 2>/dev/null || echo '?'))"

STAMP="node_modules/.focus-room-lock-hash"
HASH="$(sha1sum package-lock.json 2>/dev/null | cut -d' ' -f1 || echo none)"

if [ -f "$STAMP" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$HASH" ]; then
  echo "✓ Dependencies already in sync — skipping install."
else
  echo "→ Installing Node dependencies…"
  if [ -f package-lock.json ] && npm ci --prefer-offline --no-audit --fund=false; then
    mkdir -p node_modules && echo "$HASH" > "$STAMP"
  elif npm install --no-audit --fund=false; then
    mkdir -p node_modules && echo "$HASH" > "$STAMP"
  else
    echo "⚠ npm install failed. Run 'npm install' manually in the terminal."
  fi
fi

[ -f .env ] || cp .env.example .env 2>/dev/null || true

echo "✓ Setup finished. The app auto-starts on attach; 'npm start' runs it manually."
exit 0
