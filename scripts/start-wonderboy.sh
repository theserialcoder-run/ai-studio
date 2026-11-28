#!/usr/bin/env bash
# Starts Wonderboy AI Studio (production server) and opens it in the browser.
# Used by the desktop launcher (scripts/install-launcher.sh). Close the terminal
# window, or press Ctrl+C, to stop Wonderboy.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${WONDERBOY_PORT:-3000}"
URL="http://localhost:${PORT}"
cd "$APP_DIR"

# Desktop launchers don't load ~/.bashrc, so load nvm's Node if it's installed that way.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if ! command -v node >/dev/null 2>&1 && [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install it (https://nodejs.org) and try again."
  read -r -p "Press Enter to close." _
  exit 1
fi

pause_and_exit() { echo; read -r -p "Press Enter to close." _; exit "$1"; }

echo "Wonderboy AI Studio"
echo "==================="

# Already running (this launcher or `npm run dev`)? Just open it.
if curl -fs -o /dev/null --max-time 3 "$URL/api/providers"; then
  echo "Wonderboy is already running (in another window or via npm run dev). Opening $URL"
  echo "This window closes in a few seconds; the running Wonderboy keeps going."
  xdg-open "$URL" >/dev/null 2>&1 || true
  sleep 6
  exit 0
fi
if ss -ltn 2>/dev/null | grep -q ":${PORT} "; then
  echo "Port ${PORT} is used by another program. Close it, or start with WONDERBOY_PORT=3001."
  pause_and_exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing packages (first run only)…"
  npm install || pause_and_exit 1
fi

# Rebuild only when the code changed since the last build.
if [ ! -f .next/BUILD_ID ] || [ -n "$(find src package.json next.config.ts -newer .next/BUILD_ID -print -quit 2>/dev/null)" ]; then
  echo "Preparing the app (only after updates; takes about a minute)…"
  npm run build || pause_and_exit 1
fi

# Open the browser as soon as the server answers.
(
  for _ in $(seq 1 60); do
    if curl -fs -o /dev/null --max-time 2 "$URL/api/providers"; then
      xdg-open "$URL" >/dev/null 2>&1 || true
      exit 0
    fi
    sleep 1
  done
) &

# Server output also goes to a log, so a crash can be looked at afterwards (kept under 5 MB).
LOG_DIR="${WONDERBOY_DATA_DIR:-$APP_DIR/data}/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/server.log"
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 5000000 ]; then mv -f "$LOG" "$LOG.old"; fi
echo "===== $(date '+%Y-%m-%d %H:%M:%S') starting Wonderboy on port $PORT =====" >> "$LOG"

echo
echo "Wonderboy is running at $URL"
echo "Keep this window open while you work. Close it (or press Ctrl+C) to stop Wonderboy."
echo
set +e
node_modules/.bin/next start -p "$PORT" 2>&1 | tee -a "$LOG"
code=${PIPESTATUS[0]}
echo "===== $(date '+%Y-%m-%d %H:%M:%S') stopped (exit code $code) =====" >> "$LOG"
# Ctrl+C (130) or closing the window is a normal stop. Anything else: keep the window open so the error stays readable.
if [ "$code" -ne 0 ] && [ "$code" -ne 130 ] && [ "$code" -ne 143 ]; then
  echo
  echo "Wonderboy stopped unexpectedly (exit code $code)."
  [ "$code" -eq 137 ] && echo "Code 137 usually means the computer ran out of memory: close some browser tabs or other apps and start it again."
  echo "The messages above are also saved in $LOG"
  pause_and_exit "$code"
fi
