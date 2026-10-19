#!/bin/bash
# Beatline launcher: serves the app on localhost and opens it in its own
# window. Double-click it in Finder, or run ./beatline.command in Terminal.
#
#   BEATLINE_PORT=9000 ./beatline.command   use another port (default 8765)
#   BEATLINE_NO_OPEN=1 ./beatline.command   only start the server

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${BEATLINE_PORT:-8765}"

is_beatline() {
  curl -fs --max-time 1 "http://127.0.0.1:$1/index.html" 2>/dev/null | grep -q '<title>Beatline</title>'
}

open_app() {
  local url="$1"
  [ -n "$BEATLINE_NO_OPEN" ] && return
  if [ "$(uname)" = "Darwin" ]; then
    # A Chromium browser in --app mode gives a window without tabs or address bar.
    for app in "Google Chrome" "Microsoft Edge" "Brave Browser" "Arc" "Chromium"; do
      if open -Ra "$app" 2>/dev/null; then
        open -na "$app" --args --app="$url" && return
      fi
    done
    open "$url"
    echo "Tip: in Safari choose File › Add to Dock to keep Beatline as an app."
  else
    for bin in google-chrome chromium chromium-browser microsoft-edge brave-browser; do
      if command -v "$bin" >/dev/null; then
        "$bin" --app="$url" >/dev/null 2>&1 &
        return
      fi
    done
    command -v xdg-open >/dev/null && xdg-open "$url" >/dev/null 2>&1 &
  fi
}

# Already running (from an earlier launch)? Just open another window.
if is_beatline "$PORT"; then
  open_app "http://127.0.0.1:$PORT/"
  echo "Beatline is already running at http://127.0.0.1:$PORT/"
  exit 0
fi

# Keep the port fixed when possible: settings are saved per address.
while lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do PORT=$((PORT + 1)); done

if ! command -v python3 >/dev/null; then
  echo "Beatline needs python3 to serve the app. On a Mac run: xcode-select --install"
  exit 1
fi

python3 "$DIR/server.py" "$PORT" >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT INT TERM

for _ in $(seq 1 50); do
  is_beatline "$PORT" && break
  sleep 0.1
done
if ! is_beatline "$PORT"; then
  echo "Couldn't start the Beatline server on port $PORT."
  exit 1
fi

URL="http://127.0.0.1:$PORT/"
open_app "$URL"
echo "Beatline is running at $URL"
echo "Keep this window open while you use it. Press Ctrl+C to quit."
wait $SERVER
