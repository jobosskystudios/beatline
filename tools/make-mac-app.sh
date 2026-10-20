#!/bin/bash
# Builds Beatline.app so Beatline opens like any Mac app (Dock, Launchpad,
# Spotlight). Run on your Mac from the Beatline folder:
#
#   ./tools/make-mac-app.sh            → ~/Applications/Beatline.app
#   ./tools/make-mac-app.sh /Applications
#
# The app runs this folder's beatline.command, so keep the folder where it is
# (or run the script again after moving it). Beatline keeps a small server
# running in the background; stop it with ./beatline.command stop.
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$HOME/Applications}"
APP="$DEST/Beatline.app"

mkdir -p "$DEST"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Beatline</string>
  <key>CFBundleDisplayName</key><string>Beatline</string>
  <key>CFBundleIdentifier</key><string>studio.jobossky.beatline</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Beatline</string>
  <key>CFBundleIconFile</key><string>Beatline</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

cat > "$APP/Contents/MacOS/Beatline" <<RUN
#!/bin/bash
# Started by Beatline.app: run the launcher in the background and return, so
# the app opens Beatline's window and leaves the Dock straight away.
nohup "$REPO/beatline.command" >/dev/null 2>&1 &
RUN
chmod +x "$APP/Contents/MacOS/Beatline"

# Icon: render the PNG at every size macOS wants, then pack an .icns.
if command -v sips >/dev/null && command -v iconutil >/dev/null; then
  SET="$(mktemp -d)/Beatline.iconset"
  mkdir -p "$SET"
  for size in 16 32 128 256 512; do
    sips -z $size $size "$REPO/icons/icon-512.png" --out "$SET/icon_${size}x${size}.png" >/dev/null
    sips -z $((size * 2)) $((size * 2)) "$REPO/icons/icon-512.png" --out "$SET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$SET" -o "$APP/Contents/Resources/Beatline.icns"
fi

echo "Built $APP"
echo "Open it from Finder, Launchpad or Spotlight. The first time, right-click › Open."
