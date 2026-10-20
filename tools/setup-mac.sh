#!/bin/bash
# One-time Beatline setup on a Mac: checks what Beatline needs, installs
# what's missing, builds Beatline.app and opens it.
#
#   cd beatline && ./tools/setup-mac.sh
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ok() { printf '  ✓ %s\n' "$1"; }
todo() { printf '  • %s\n' "$1"; }

echo "Beatline setup"

# 1. Apple's command line tools give python3 and git.
if xcode-select -p >/dev/null 2>&1 && python3 -c 'import sys' >/dev/null 2>&1; then
  ok "Command line tools (python3 $(python3 -c 'import platform;print(platform.python_version())'))"
else
  todo "Installing Apple's command line tools (python3, git)…"
  xcode-select --install || true
  echo "    Click Install in the window that opened, wait for it to finish, then run this script again."
  exit 0
fi

# 2. A Chromium browser gives Beatline its own app window (Safari works too).
BROWSER=""
for app in "Google Chrome" "Microsoft Edge" "Brave Browser" "Arc" "Chromium"; do
  if open -Ra "$app" 2>/dev/null; then BROWSER="$app"; break; fi
done
if [ -n "$BROWSER" ]; then
  ok "$BROWSER (Beatline opens in its own window)"
else
  todo "No Chrome/Edge/Brave/Arc found: Beatline will open in Safari."
  echo "    For a separate app window, install Chrome: https://www.google.com/chrome/"
fi

# 3. Final Cut Pro.
if open -Ra "Final Cut Pro" 2>/dev/null; then ok "Final Cut Pro"; else todo "Final Cut Pro not found (exports will be saved to ~/Movies/Beatline)"; fi

# 4. Launcher permissions, then the app.
chmod +x "$REPO/beatline.command" "$REPO/tools/make-mac-app.sh"
xattr -d com.apple.quarantine "$REPO/beatline.command" 2>/dev/null || true
"$REPO/tools/make-mac-app.sh" >/dev/null
ok "Beatline.app in ~/Applications"

echo "Opening Beatline…"
open "$HOME/Applications/Beatline.app"
