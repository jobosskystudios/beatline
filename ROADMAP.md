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

## Next

1. **Edit the grid by hand.** Drag any beat or bar line; add tempo-change points for songs that
   speed up or slow down (a tempo map instead of one BPM).
2. **Auto-assemble from a folder of clips.** Pick a folder; Beatline fills the pre-cut timeline
   with clips in order, at random, or by shot length, never reusing a take. Horizontal and vertical.
3. **Cut the music to length.** "Make this 30 s / 60 s": remove whole bars or sections so the song
   ends on a downbeat, export the music edit as an FCPXML with crossfades.
4. **Phrases and vocals.** Mark where sung lines start and end so cuts don't land mid-word; speech
   and silence regions for interviews.
5. **Accent markers.** Risers, impacts, the last beat before the drop, fills; for SFX and speed ramps.
6. **Swing and triplets.** Detect shuffle feel and offer a triplet grid.
7. **Higher-accuracy mode.** An optional neural beat/downbeat model (ONNX in the browser) for hard
   material; compare with the current engine on the evaluation set.
8. **Stems.** Optional drum/vocal separation so drum markers ignore bass lines and vocals.
9. **Other editors.** Premiere Pro XML and DaVinci Resolve marker EDL export.
10. **Native Mac app.** Swift + AVFoundation: drag a song in, drag the project straight into Final
    Cut, no launcher needed.

## Quality bar

- Every change to the analysis is scored with `tools/eval/` on real recordings, and the synthetic
  tests (timing within 10 ms, 3/4 detection, key, loudness) must pass.
- Next: add human-annotated beat datasets (Ballroom, GTZAN rhythm, Harmonix) to the evaluation and
  run it in CI.
