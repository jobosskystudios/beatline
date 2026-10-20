// Builds the double-click versions of Beatline into dist/:
//   dist/Beatline.html      everything in one file; opens from Finder, no install
//   dist/Beatline-mac.zip   Beatline.app (finds your songs, opens exports in Final Cut)
//
//   npm install && npm run build
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const bundle = async (entry) => (await esbuild.build({
  entryPoints: [path.join(root, entry)],
  bundle: true,
  format: 'iife',
  minify: true,
  write: false,
  target: ['safari15', 'chrome100'],
  logLevel: 'error',
})).outputFiles[0].text;

// ---------- single file ----------
const appJs = await bundle('js/app.js');
const workerJs = await bundle('js/worker.js');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const icon = `data:image/svg+xml;base64,${fs.readFileSync(path.join(root, 'icon.svg')).toString('base64')}`;
const safeScript = (js) => js.replace(/<\/script/gi, '<\\/script');

let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
html = html
  .replace(/\s*<link rel="manifest"[^>]*>/, '')
  .replace(/\s*<link rel="apple-touch-icon"[^>]*>/, '')
  .replace('<link rel="stylesheet" href="styles.css">', () => `<style>${css}</style>`)
  .replace(/href="icon\.svg"/g, `href="${icon}"`)
  .replace(/src="icon\.svg"/g, `src="${icon}"`)
  // Docs pages aren't part of the single file: link to the GitHub repo instead.
  .replace(/<nav class="appnav">[\s\S]*?<\/nav>/, '<nav class="appnav"><a href="https://github.com/jobosskystudios/beatline#readme" target="_blank" rel="noopener">Help</a></nav>')
  .replace('<script type="module" src="js/app.js"></script>', () =>
    `<script>globalThis.BEATLINE_WORKER_SRC = ${JSON.stringify(workerJs).replace(/<\/script/gi, '<\\/script')};</script>\n  <script>${safeScript(appJs)}</script>`);
fs.writeFileSync(path.join(dist, 'Beatline.html'), html);

// ---------- Beatline.app ----------
const app = path.join(dist, 'Beatline.app');
const res = path.join(app, 'Contents', 'Resources');
const web = path.join(res, 'web');
fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
fs.mkdirSync(web, { recursive: true });
for (const f of ['index.html', 'guide.html', 'how-it-works.html', 'faq.html', 'styles.css', 'icon.svg', 'manifest.webmanifest', 'sw.js', 'server.py', 'beatline.command']) {
  fs.copyFileSync(path.join(root, f), path.join(web, f));
}
fs.cpSync(path.join(root, 'js'), path.join(web, 'js'), { recursive: true });
fs.cpSync(path.join(root, 'icons'), path.join(web, 'icons'), { recursive: true });
fs.copyFileSync(path.join(dist, 'Beatline.html'), path.join(web, 'Beatline.html'));
fs.chmodSync(path.join(web, 'beatline.command'), 0o755);

// .icns holding the 512 px PNG ('ic09'); macOS scales it for the Dock and Finder.
const png = fs.readFileSync(path.join(root, 'icons', 'icon-512.png'));
const icns = Buffer.alloc(16 + png.length);
icns.write('icns', 0); icns.writeUInt32BE(16 + png.length, 4);
icns.write('ic09', 8); icns.writeUInt32BE(8 + png.length, 12);
png.copy(icns, 16);
fs.writeFileSync(path.join(res, 'Beatline.icns'), icns);

fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
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
`);

const launcher = path.join(app, 'Contents', 'MacOS', 'Beatline');
fs.writeFileSync(launcher, `#!/bin/bash
# Beatline.app: with Apple's command line tools (python3) installed, run the
# full Beatline (finds songs, opens exports in Final Cut). Without them, open
# the single-file Beatline in the browser and offer the one-time install.
WEB="$(cd "$(dirname "$0")/../Resources/web" && pwd)"

if /usr/bin/xcode-select -p >/dev/null 2>&1; then
  nohup "$WEB/beatline.command" >/dev/null 2>&1 &
  exit 0
fi

URL="file://$WEB/Beatline.html"
opened=""
for app in "Google Chrome" "Microsoft Edge" "Brave Browser" "Arc"; do
  if open -Ra "$app" 2>/dev/null; then open -na "$app" --args --app="$URL" && opened=1 && break; fi
done
[ -z "$opened" ] && open "$WEB/Beatline.html"

answer=$(osascript -e 'button returned of (display dialog "Beatline is open in your browser.\\n\\nFor the full version (finds your song automatically and opens exports in Final Cut), install Apple’s free command line tools once." buttons {"Later", "Install"} default button "Install" with title "Beatline")' 2>/dev/null)
[ "$answer" = "Install" ] && /usr/bin/xcode-select --install
exit 0
`);
fs.chmodSync(launcher, 0o755);

// Zip with permissions kept (Finder's Archive Utility restores them).
execFileSync('zip', ['-qry', 'Beatline-mac.zip', 'Beatline.app'], { cwd: dist });
fs.rmSync(app, { recursive: true, force: true });
console.log('dist/Beatline.html', (fs.statSync(path.join(dist, 'Beatline.html')).size / 1024).toFixed(0), 'KB');
console.log('dist/Beatline-mac.zip', (fs.statSync(path.join(dist, 'Beatline-mac.zip')).size / 1024).toFixed(0), 'KB');
