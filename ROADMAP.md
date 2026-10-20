# Beatline roadmap

Beatline's job: understand the song first, then plan the cut, then hand Final Cut Pro a
project that is already timed to the music.

## What editors say about Final Cut Pro's built-in beat detection

Final Cut Pro 12 added Beat Detection (Clip › Beat Detection, ⌥B): a grid of song parts, bars
and beats that edits can snap to. What we learned from Apple's docs, reviews and user reports:

- **Accuracy regressed for some users.** An Apple Community thread reports that beat markers in
  12.2 were "often misaligned" and "pretty far off" on the same files that tracked "right on the
  beat" in 12.0; another user agreed. ([Apple Community](https://discussions.apple.com/thread/256279994))
- **Tuned for 4/4.** Apple: "To ensure the most musically accurate beat grid, choose a music clip
  with a 4/4 time signature." ([Apple Support](https://support.apple.com/guide/final-cut-pro/edit-to-the-beat-ver65b55a2b7/mac))
- **Grid only.** It draws lines to snap to; it doesn't plan or build the edit (also the pitch of
  third-party tools such as Beat2Cut). ([Beat2Cut](https://beat2cut.com/blog/final-cut-pro-markers-from-audio/))
- **Fast and simple** when it works: under 5 s for a 3-minute song on an M-series Mac.
  ([Larry Jordan](https://larryjordan.com/articles/the-new-beat-detection-in-final-cut-pro-12-is-simple-and-effective/))

How Beatline answers that: a confidence rating instead of a confident wrong grid; tempo chips,
bar-1-at-playhead and grid nudge to fix what's wrong; 3/4 detection; drum and hit markers; a cut
plan, energy-aware pacing and a pre-cut timeline; results independent of the Final Cut version.

## Done

- v1 – beat grid, downbeats, FCPXML markers, CSV
- v2 – cut plan (total cuts, shots, ASL, cuts/min), sections & drop, auto pacing, ranges,
  pre-cut timeline, tap tempo, shortest shot
- v3 – **new listening engine** (mel-band onset envelope with loudness knee, attack-calibrated
  timing, tempogram tempo, half/double-time check); confidence; tempo stability and tempo curve;
  3/4 vs 4/4 and bar 1 from bass + harmony; key (Camelot); loudness (LUFS); drum markers (kick,
  snare, hi-hat); Web Audio playback with a sample-accurate click; editor-style UI with colour
  waveform, overview, sections and tempo lanes; song location finder and send-to-Final-Cut via
  the launcher; evaluation tools on real recordings
- v4 – hand-editable grid (drag a beat, ⌥-drag for tempo changes) and best-fitting grid search;
  cut the song to length (phrase- and harmony-aware, preview, WAV, export); fill the shots with
  your clips (MOV/MP4, frame-accurate in-points, muted); voice-over phrases; accents (impacts,
  risers, breaks, pre-drop beat); swing/triplet feel with 8th-note and triplet pacing; Premiere XML
  and Resolve EDL; Beatline.app builder

## Not done, and why

- **Neural beat/downbeat model** and **stem separation (drums/vocals)**: both need large trained
  models (tens to hundreds of MB) that this project doesn't ship, and the hosts for the published
  weights weren't reachable from the build environment, so nothing could be tested. The
  best-fitting grid search is the higher-accuracy option for now.
- **Vocal-aware cuts inside full songs** depend on stem separation (above). Voice-over phrases work
  on speech and sparse arrangements.
- **Native Swift app**: needs Xcode on a Mac to build and test. Beatline.app (a launcher bundle)
  covers Dock/Launchpad use in the meantime.

## Next

1. Test pass on a Mac with Final Cut Pro (see CHECKLIST.md) and fix what it finds.
2. Human-annotated beat datasets in `tools/eval`, run in CI.
3. Neural beat model as an optional download, if the weights can be bundled.
4. Native Swift app with drag-to-Final-Cut.

## Quality bar

- Every change to the analysis is scored with `tools/eval/` on real recordings, and the synthetic
  tests (timing within 10 ms, 3/4 detection, key, loudness) must pass.
- Next: add human-annotated beat datasets (Ballroom, GTZAN rhythm, Harmonix) to the evaluation and
  run it in CI.
