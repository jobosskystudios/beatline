# Beatline

Detect the beats in a song and export **Final Cut Pro markers (FCPXML)** for fast, beat-synced rough cuts.
Everything runs in the browser — no install, no upload, no dependencies.

**Pages**

| Page | What it is |
| --- | --- |
| [`index.html`](index.html) | The app: drop a song, check the beat grid, export `.fcpxml` / `.csv` |
| [`guide.html`](guide.html) | Step-by-step beat-cut workflow in Final Cut Pro |
| [`how-it-works.html`](how-it-works.html) | Beat detection and FCPXML export explained |
| [`faq.html`](faq.html) | Troubleshooting and common questions |

## Features

- **Cut plan:** total cuts, shots to fill, average shot length, cuts per minute, per-section breakdown and a shot list (CSV)
- **Song sections:** calm / groove / peak energy per bar, drop detection, section chapter markers
- **Auto pacing:** slower cuts in calm parts, faster in peaks (pace per energy level is configurable)
- **Range:** In/Out or quick 15/30/60/90 s ranges snapped to bar lines, for cut-downs
- **Pre-cut timeline export:** one placeholder per shot with the song connected below, ready for Replace from Start
- Tap tempo, shortest-shot limit, every-8-bars (phrase) pacing

- Automatic tempo + beat grid (spectral flux → autocorrelation → dynamic-programming beat tracker)
- Downbeat detection (bass-weighted), bar-aware labels (`Bar 12 · Beat 3`), 2–7 beats per bar
- Marker density: every beat, every 2nd beat, every bar, every 2 or 4 bars
- **Hits** mode for transient/accent markers with a sensitivity control
- Manual BPM, ½× / 2×, grid strictness, global nudge in ms
- Edit markers by hand (Shift+click, `M` while playing) and audition with a metronome click
- Frame-exact export at 23.976, 24, 25, 29.97, 30, 50, 59.94, 60 fps with nearest/previous/next snapping
- Marker styles: standard, to-do, completed, chapter — chosen separately for downbeats and beats
- Export the song clip with markers, a pre-cut timeline, or a markers-only gap clip; FCPXML 1.9 / 1.10 / 1.11
- CSV marker list (seconds, frame, timecode) for other editors

## Open it as an app

```sh
git clone https://github.com/jobosskystudios/beatline.git
cd beatline
./beatline.command        # or: npm run app
```

The launcher serves Beatline on `http://127.0.0.1:8765` and opens it in its own window (Chrome, Edge, Brave or Arc in app mode; Safari otherwise). Keep the Terminal window open while you work; **Ctrl+C** quits. In Finder you can also double-click `beatline.command`.

To keep it in the Dock: in Chrome/Edge choose **Install Beatline** (the install icon in the address bar, or ⋮ › Cast, save and share › Install page as app); in Safari choose **File › Add to Dock**. Once installed it works offline, and Chrome/Edge can open audio files with it from Finder (right-click › Open With › Beatline).

Needs `python3` (on a Mac: `xcode-select --install` if it's missing). Options: `BEATLINE_PORT=9000` picks another port, `BEATLINE_NO_OPEN=1` only starts the server.

## Run it

Open it from any static host (GitHub Pages: *Settings → Pages → Deploy from branch → main / root*), or locally:

```sh
python3 -m http.server 8080   # then open http://localhost:8080
```

ES modules need to be served over HTTP; opening `index.html` as a `file://` URL won't work.

## Tests

```sh
npm test   # Node 18+; no packages to install
```

The tests generate synthetic drum loops (90–150 BPM) and check tempo, beat positions, downbeat phase and hit detection, plus FCPXML/CSV output (rational frame times, escaping, file URLs, duplicate-frame merging).

## Layout

```
index.html, guide.html, how-it-works.html, faq.html, styles.css, icon.svg
beatline.command  launcher: local server + app window
manifest.webmanifest, sw.js, icons/  installable app, offline cache
js/dsp.js       beat analysis (pure functions, no DOM)
js/markers.js   beats → marker list (pacing, bars, user edits)
js/structure.js bars, energy sections, drop
js/cutplan.js   cuts, shots and stats for a range
js/fcpxml.js    FCPXML + CSV writers
js/app.js       UI: loading, waveform, playback, export
tests/          node:test suites
```
