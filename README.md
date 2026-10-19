# Beatline

Beatline **listens to a song first** (tempo, beats, bar starts, time signature, sections, the drop, key, loudness), then **plans the cut** (total cuts, shot list, energy-aware pacing, cut-downs) and **hands Final Cut Pro a project already timed to the music** (markers or a pre-cut timeline, FCPXML).
Runs on your Mac: no upload, no dependencies beyond Python 3 for the launcher.

| Page | What it is |
| --- | --- |
| [`index.html`](index.html) | The app |
| [`guide.html`](guide.html) | From song to beat-synced rough cut, step by step |
| [`how-it-works.html`](how-it-works.html) | The analysis and export, and how they were tested |
| [`faq.html`](faq.html) | Silent audio in Final Cut, tempo, timing, Final Cut's own beat detection |
| [`ROADMAP.md`](ROADMAP.md) | Research notes and what's next |

## Features

**Listen**
- Tempo from a tempogram with half/double-time check; one-click alternatives (½×, ⅔×, 1.5×, 2×); tap tempo
- Beat grid (dynamic-programming tracker), timing calibrated to the audible attack (within ~5 ms)
- Confidence rating (steady / unsure), tempo stability (steady, live drift, tempo changes) and a tempo curve
- Time signature (3/4 vs 4/4) and bar 1 from bass + harmony; fix with **D** (bar 1 at playhead) and grid nudge
- Sections (calm / groove / peak) and the drop; key with Camelot code; integrated loudness (LUFS) and peak
- Drum hits (kick, snare, hi-hat) and any-hit detection

**Plan**
- Cut on the beat grid (every beat … every 8 bars, or **auto** by section energy), on drums, or on any hit
- Total cuts, shots to fill, average shot length, cuts per minute, per-section breakdown, shot list CSV
- Ranges for cut-downs (drag the ruler, I/O, or 6/15/30/60/90 s ending on a bar line)
- Shortest-shot limit, cut 1–2 frames early, add/remove cuts by hand, metronome click on every cut

**Export**
- Song + markers, pre-cut timeline (one placeholder per shot, song connected), or markers only
- Frame-exact at 23.976–60 fps; FCPXML 1.9/1.10/1.11; marker styles per type; section chapter markers
- The launcher finds the song on your Mac (so Final Cut links it, no silent offline clips) and opens the export in Final Cut Pro directly
- Marker list and shot list CSV for other editors

## Open it as an app

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
index.html, guide.html, how-it-works.html, faq.html, styles.css, icon.svg
beatline.command  launcher: local server + app window
manifest.webmanifest, sw.js, icons/  installable app, offline cache
js/dsp.js       onset envelopes, tempo, beat tracking (pure functions, no DOM)
js/analysis.js  confidence, stability, meter, key, loudness, drums
js/worker.js    runs the analysis off the main thread
js/player.js    Web Audio playback + sample-accurate click
js/timeline.js  timeline and overview canvases
js/fileinfo.js  sample rate from WAV/AIFF/FLAC/MP3/M4A headers
server.py       launcher server: static files, song finder, send to Final Cut
tools/eval/     beat-tracking evaluation on real recordings
js/markers.js   beats → marker list (pacing, bars, user edits)
js/structure.js bars, energy sections, drop
js/cutplan.js   cuts, shots and stats for a range
js/fcpxml.js    FCPXML + CSV writers
js/app.js       UI: loading, waveform, playback, export
tests/          node:test suites
```
