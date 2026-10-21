# Beatline

Beatline **listens to a song first** (tempo, beats, bar starts, time signature, sections, the drop, key, loudness), then **plans the cut** (total cuts, shot list, energy-aware pacing, cut-downs) and **hands Final Cut Pro a project already timed to the music** (markers or a pre-cut timeline, FCPXML).
Runs on your Mac: no upload, nothing else to install.

| Page | What it is |
| --- | --- |
| [`index.html`](index.html) | The app |
| [`guide.html`](guide.html) | From song to beat-synced rough cut, step by step |
| [`how-it-works.html`](how-it-works.html) | The analysis and export, and how they were tested |
| [`faq.html`](faq.html) | Silent audio in Final Cut, tempo, timing, Final Cut's own beat detection |
| [`ROADMAP.md`](ROADMAP.md) | Research notes and what's next |
| [`CHECKLIST.md`](CHECKLIST.md) | What to test on your Mac with Final Cut Pro |

## Features

**Listen**
- Tempo from a tempogram with half/double-time check; one-click alternatives (½×, ⅔×, 1.5×, 2×); tap tempo
- Beat grid (dynamic-programming tracker), timing calibrated to the audible attack (within ~5 ms)
- Confidence rating (steady / unsure), tempo stability (steady, live drift, tempo changes) and a tempo curve
- Time signature (3/4 vs 4/4) and bar 1 from bass + harmony; fix with **D** (bar 1 at playhead) and grid nudge
- Sections (calm / groove / peak) and the drop; key with Camelot code; integrated loudness (LUFS) and peak
- Drum hits (kick, snare, hi-hat) and any-hit detection
- Swing / triplet feel; accents (impacts, risers, breaks, the beat before the drop); voice-over phrases
- Fix the grid by hand: drag a beat line, ⌥-drag to move every later beat (tempo changes); best-fitting grid search

**Plan**
- Cut on the beat grid (every triplet / 8th note … every 8 bars, or **auto** by section energy), on drums, on any hit, or on voice phrases
- Total cuts, shots to fill, average shot length, cuts per minute, per-section breakdown, shot list CSV
- Ranges for cut-downs (drag the ruler, I/O, or 6/15/30/60/90 s ending on a bar line)
- Shortest-shot limit, cut 1–2 frames early, add/remove cuts by hand, metronome click on every cut
- **Cut the song to length** (15/30/60 s or any): keeps the opening and the real ending, jumps on a phrase where the harmony matches; preview, WAV, or use it for the cut plan and export
- **Fill the shots with your clips** (MOV/MP4 folder): each clip once before repeats, in-points on the clip's own frames
- **Shot board**: every shot with its clip's thumbnail; click to play it, ⟳ to try the next clip, 🔒 to keep it when you shuffle
- **Folders → energy**: subfolders become groups (Calm / Groove / Peak, guessed from their names); calm clips go on calm sections, peak clips on the drop, and the same folder isn't used twice in a row

**Export**
- Song + markers, pre-cut timeline (one placeholder per shot, song connected), markers only, or **your clips cut to the shots**
- Frame-exact at 23.976–60 fps; FCPXML 1.9/1.10/1.11; marker styles per type; section chapter markers
- Beatline.app opens songs and clips with Finder's own pickers, so it knows their paths: Final Cut links them (no silent or offline clips, nothing to paste), and exports open in Final Cut directly
- **Premiere Pro XML** (sequence with song + markers) and **DaVinci Resolve marker EDL**; marker and shot lists as CSV
- **Beatline.app** for Applications and the Dock: a small native helper with the app built in

## Download (no Terminal needed)

- **[`dist/Beatline.html`](dist/Beatline.html)**: download, double-click, done. Opens in your browser; paste the song's location in the Export tab.
- **[`dist/Beatline.dmg`](dist/Beatline.dmg)** (recommended): open it, drag **Beatline.app** onto **Applications**, open it. Nothing else to install (no Python, no command line tools). Use **Open a song…** and **Choose clips folder…**: Finder's picker opens and Beatline knows where everything is. First open: see *Opening an app from an unidentified developer* below.
- **[`dist/Beatline-mac.zip`](dist/Beatline-mac.zip)**: the same app as a zip.

Rebuild them with `npm install && npm run build` (building the app needs [Go](https://go.dev/dl); the helper's source is `helper/main.go`).

### Opening an app from an unidentified developer

Beatline.app isn't signed by Apple, so macOS blocks the first open. Double-click it once, click **Done**, then open **System Settings › Privacy & Security**, scroll down and click **Open Anyway** next to "Beatline". (On older macOS: right-click the app › Open.)

## Open it as an app

First time on a Mac: `./tools/setup-mac.sh` installs what's missing (Apple's command line tools for python3), builds **Beatline.app** in `~/Applications` and opens it.

```sh
git clone https://github.com/jobosskystudios/beatline.git
cd beatline
./beatline.command        # or: npm run app
```

The launcher serves Beatline on `http://127.0.0.1:8765` and opens it in its own window (Chrome, Edge, Brave or Arc in app mode; Safari otherwise). Keep the Terminal window open while you work; **Ctrl+C** quits. In Finder you can also double-click `beatline.command`.

To keep it in the Dock: in Chrome/Edge choose **Install Beatline** (the install icon in the address bar, or ⋮ › Cast, save and share › Install page as app); in Safari choose **File › Add to Dock**. Once installed it works offline, and Chrome/Edge can open audio files with it from Finder (right-click › Open With › Beatline).

Needs `python3` (on a Mac: `xcode-select --install` if it's missing). Options: `BEATLINE_PORT=9000` picks another port, `BEATLINE_NO_OPEN=1` only starts the server.

## Run it as a website

It also works from any static host (GitHub Pages: *Settings → Pages → Deploy from branch → main / root*) or `python3 -m http.server`. Without the launcher, Beatline can't see where the song lives on disk, so you type its folder in the Export tab and import the downloaded `.fcpxml` yourself. ES modules need HTTP; opening `index.html` as a `file://` URL won't work.

## Tests

```sh
npm test   # Node 18+; no packages to install
```

The tests synthesise drum loops (90–150 BPM), a waltz, a chord progression and a reference tone, and check attack timing (within 10 ms), tempo, beats, half/double-time choice, 3/4 detection and bar 1, confidence, key, loudness (−20 dBFS → −20 LUFS), file-header parsing, sections, the cut plan and FCPXML/CSV output. For real recordings, see `tools/eval/`.

## Layout

```
helper/main.go  Beatline.app's helper: serves the app, Finder pickers, thumbnails, send to Final Cut
index.html, guide.html, how-it-works.html, faq.html, styles.css, icon.svg
beatline.command  launcher: local server + app window
manifest.webmanifest, sw.js, icons/  installable app, offline cache
js/dsp.js       onset envelopes, tempo, beat tracking (pure functions, no DOM)
js/analysis.js  confidence, stability, meter, key, loudness, drums
js/worker.js    runs the analysis off the main thread
js/player.js    Web Audio playback + sample-accurate click
js/timeline.js  timeline and overview canvases
js/fileinfo.js  sample rate from WAV/AIFF/FLAC/MP3/M4A headers
js/insights.js  swing, accents, voice phrases, best-fitting grid
js/musicedit.js cut a song to length, render and WAV
js/clips.js     give each shot a clip
js/exports.js   Premiere XML and Resolve EDL
server.py       launcher server: static files, song finder, send to Final Cut
tools/make-mac-app.sh  builds Beatline.app
tools/eval/     beat-tracking evaluation on real recordings
js/markers.js   beats → marker list (pacing, bars, user edits)
js/structure.js bars, energy sections, drop
js/cutplan.js   cuts, shots and stats for a range
js/fcpxml.js    FCPXML + CSV writers
js/app.js       UI: loading, waveform, playback, export
tests/          node:test suites
```
