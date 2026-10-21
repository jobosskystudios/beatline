// Builds the double-click versions of Beatline into dist/:
//   dist/Beatline.html      everything in one file; opens from Finder, no install
//   dist/Beatline-mac.zip   Beatline.app (Finder pickers, opens exports in Final Cut)
//   dist/Beatline.dmg       the same app, drag to Applications
//
//   npm install && npm run build      (needs Go for the app's helper: https://go.dev/dl)
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
// The app is a small native helper (helper/main.go) with the web app built in.
// It needs nothing else installed on the Mac.
const app = path.join(dist, 'Beatline.app');
const res = path.join(app, 'Contents', 'Resources');
const macos = path.join(app, 'Contents', 'MacOS');
fs.mkdirSync(macos, { recursive: true });
fs.mkdirSync(res, { recursive: true });

const helperWeb = path.join(root, 'helper', 'web');
fs.rmSync(helperWeb, { recursive: true, force: true });
fs.mkdirSync(helperWeb, { recursive: true });
for (const f of ['index.html', 'guide.html', 'how-it-works.html', 'faq.html', 'styles.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) {
  fs.copyFileSync(path.join(root, f), path.join(helperWeb, f));
}
fs.cpSync(path.join(root, 'js'), path.join(helperWeb, 'js'), { recursive: true });
fs.cpSync(path.join(root, 'icons'), path.join(helperWeb, 'icons'), { recursive: true });

const findGo = () => {
  for (const g of ['go', '/usr/local/go/bin/go', '/opt/homebrew/bin/go']) {
    try { execFileSync(g, ['version'], { stdio: 'ignore' }); return g; } catch { /* next */ }
  }
  throw new Error('Building Beatline.app needs Go (https://go.dev/dl).');
};
const go = findGo();
for (const [goarch, arch] of [['arm64', 'arm64'], ['amd64', 'x86_64']]) {
  execFileSync(go, ['build', '-trimpath', '-ldflags', '-s -w', '-o', path.join(macos, `beatline-${arch}`), '.'], {
    cwd: path.join(root, 'helper'),
    env: { ...process.env, GOOS: 'darwin', GOARCH: goarch, CGO_ENABLED: '0' },
    stdio: 'inherit',
  });
}

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
  <key>CFBundleVersion</key><string>7</string>
  <key>CFBundleShortVersionString</key><string>1.7</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Beatline</string>
  <key>CFBundleIconFile</key><string>Beatline</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`);

const launcher = path.join(macos, 'Beatline');
fs.writeFileSync(launcher, `#!/bin/bash
# Beatline.app: start the helper for this Mac's chip. It opens Beatline's
# window, or a new window if Beatline is already running.
DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="$DIR/beatline-$(uname -m)"
[ -x "$BIN" ] || BIN="$DIR/beatline-x86_64"
nohup "$BIN" >/dev/null 2>&1 &
exit 0
`);
fs.chmodSync(launcher, 0o755);

// Zip with permissions kept (Finder's Archive Utility restores them).
execFileSync('zip', ['-qry', 'Beatline-mac.zip', 'Beatline.app'], { cwd: dist });

// Disk image: Beatline.app next to an Applications shortcut, drag to install.
// Built as ISO 9660 with Rock Ridge (keeps permissions and the symlink), which
// macOS opens like any .dmg. Needs xorriso (Linux) or hdiutil (macOS).
const stage = path.join(dist, 'dmg');
fs.mkdirSync(stage);
fs.cpSync(app, path.join(stage, 'Beatline.app'), { recursive: true, verbatimSymlinks: true });
fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
fs.writeFileSync(path.join(stage, 'Read me first.txt'), `Install Beatline
================

1. Drag Beatline.app onto the Applications folder in this window.
2. Open Beatline from Launchpad or Spotlight.

First open: macOS blocks apps that aren't from the App Store or signed by an
identified developer. Click Done, then open System Settings > Privacy &
Security, scroll down and click "Open Anyway" next to Beatline.
(Or in Terminal: xattr -cr /Applications/Beatline.app)

Nothing else to install. Beatline opens in its own window (Chrome, Edge or
Brave if you have one, otherwise Safari). Open songs and clips with its
buttons: Finder's picker opens and Beatline knows where everything is, so
Final Cut links the song and clips by itself.
`);
const dmg = path.join(dist, 'Beatline.dmg');
const has = (cmd) => { try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; } };
if (has('hdiutil')) {
  execFileSync('hdiutil', ['create', '-volname', 'Beatline', '-srcfolder', stage, '-ov', '-format', 'UDZO', dmg]);
} else if (has('xorriso')) {
  execFileSync('xorriso', ['-as', 'mkisofs', '-quiet', '-V', 'Beatline', '-R', '-J', '-o', dmg, stage]);
} else {
  console.log('(no hdiutil or xorriso: skipped Beatline.dmg)');
}
fs.rmSync(stage, { recursive: true, force: true });
fs.rmSync(app, { recursive: true, force: true });
if (fs.existsSync(dmg)) console.log('dist/Beatline.dmg', (fs.statSync(dmg).size / 1024).toFixed(0), 'KB');
console.log('dist/Beatline.html', (fs.statSync(path.join(dist, 'Beatline.html')).size / 1024).toFixed(0), 'KB');
console.log('dist/Beatline-mac.zip', (fs.statSync(path.join(dist, 'Beatline-mac.zip')).size / 1024).toFixed(0), 'KB');
