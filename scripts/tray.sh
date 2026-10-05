#!/bin/sh
# Starts or stops the tray (tray/marumado_tray.py) in the background, beside the container.
# `make up` starts it, `make down` stops it. Skipped where it can't show (no uv, no desktop),
# or with MARUMADO_TRAY=0 in .env or the environment.
set -eu
PID=tray/tray.pid
LOG=tray/tray.log
env_value() { if [ -f .env ]; then sed -n "s/^$1=//p" .env | tail -n 1 | sed 's/^["'\'']//; s/["'\'']$//'; fi; }
running() { [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; }

case "${1:-start}" in
start)
  if [ "${MARUMADO_TRAY:-$(env_value MARUMADO_TRAY)}" = 0 ]; then exit 0; fi
  if running; then echo "tray: already running"; exit 0; fi
  if ! command -v uv >/dev/null 2>&1; then echo "tray: skipped (needs uv, see tray/README.md)"; exit 0; fi
  if [ "$(uname)" = Linux ] && [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then echo "tray: skipped (no desktop)"; exit 0; fi
  bind=$(env_value MARUMADO_BIND); port=$(env_value MARUMADO_PORT)
  case "${bind:-127.0.0.1}" in 0.0.0.0 | ::) bind=127.0.0.1 ;; esac
  url="http://${bind:-127.0.0.1}:${port:-7878}"
  # Wait for Marumado to answer, so the tray finds its token on the first try.
  if command -v curl >/dev/null 2>&1; then
    i=0
    until curl -s -o /dev/null --max-time 2 "$url/" || [ $i -ge 30 ]; do i=$((i + 1)); sleep 1; done
  fi
  # Its own session, so stopping it stops uv's Python and the card with it.
  if command -v setsid >/dev/null 2>&1; then
    nohup setsid uv run tray/marumado_tray.py --url "$url" >"$LOG" 2>&1 &
  else
    nohup uv run tray/marumado_tray.py --url "$url" >"$LOG" 2>&1 &
  fi
  echo $! >"$PID"
  echo "tray: started (log in $LOG)"
  ;;
stop)
  if running; then
    pid=$(cat "$PID")
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    echo "tray: stopped"
  fi
  rm -f "$PID"
  ;;
*)
  echo "usage: $0 start|stop" >&2
  exit 2
  ;;
esac
