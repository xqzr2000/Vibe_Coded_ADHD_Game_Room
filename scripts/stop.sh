#!/usr/bin/env bash
# Stop a running Focus Room — whether it was auto-started on attach or by
# `npm start` in another terminal. Tries the PID file first, then falls back to
# whatever tool this container happens to have for finding a port's owner.
#
#   npm run stop
#   npm run restart

cd "$(dirname "$0")/.." || exit 0
PORT="${PORT:-3000}"
PID_FILE=".focus-room.pid"
stopped=0

wait_gone() {
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$1" 2>/dev/null || return 0
    sleep 0.3
  done
  return 1
}

stop_pid() {
  local pid="$1" how="$2"
  kill -0 "$pid" 2>/dev/null || return 1
  echo "→ Stopping Focus Room (PID $pid, found via $how)…"
  kill "$pid" 2>/dev/null            # SIGTERM: lets the server clean up
  if ! wait_gone "$pid"; then
    echo "  …not responding, forcing."
    kill -9 "$pid" 2>/dev/null
    sleep 0.3
  fi
  stopped=1
  return 0
}

# 1. The PID file the server writes on listen.
if [ -f "$PID_FILE" ]; then
  stop_pid "$(cat "$PID_FILE" 2>/dev/null)" "pid file" || rm -f "$PID_FILE"
fi

# 2. Whoever is holding the port. Containers vary in which of these exist.
if [ "$stopped" = "0" ]; then
  pids=""
  if command -v lsof >/dev/null; then
    pids="$(lsof -ti tcp:"$PORT" 2>/dev/null)"
  elif command -v fuser >/dev/null; then
    pids="$(fuser "$PORT"/tcp 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$')"
  elif command -v ss >/dev/null; then
    pids="$(ss -lptnH "sport = :$PORT" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)"
  fi
  for pid in $pids; do stop_pid "$pid" "port $PORT"; done
fi

# 3. Last resort: match the process by name. Guarded, because a shell whose
#    command line merely CONTAINS this string (like the one running this
#    script) would otherwise match and get killed.
if [ "$stopped" = "0" ]; then
  for pid in $(pgrep -f "node .*server/index\.js" 2>/dev/null); do
    [ "$pid" = "$$" ] && continue
    [ "$pid" = "$PPID" ] && continue
    # Only ever kill something that is genuinely a node process.
    comm="$(cat "/proc/$pid/comm" 2>/dev/null)"
    [ "$comm" = "node" ] || continue
    stop_pid "$pid" "process name"
  done
fi

rm -f "$PID_FILE"

if [ "$stopped" = "1" ]; then
  echo "✓ Stopped. Port $PORT is free — 'npm start' will work now."
else
  echo "✓ Nothing was running on port $PORT."
fi
exit 0
