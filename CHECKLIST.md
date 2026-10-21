# Beatline: test checklist for your Mac

Everything below was tested in a browser on Linux with real songs, but not on a Mac with Final Cut
Pro. Please go through it once and tick what works. Anything that fails: note the step, your macOS
and Final Cut versions, and the message you saw.

## 0. Install (v1.7)

- [ ] Quit the old Beatline and delete the old **Beatline.app** from Applications.
- [ ] Open **Beatline.dmg**, drag **Beatline.app** onto **Applications**.
- [ ] Open Beatline. First time: macOS blocks it → **Done** → System Settings › Privacy & Security →
      **Open Anyway**. → A Beatline window opens; the top left says **v1.7**.
- [ ] If macOS asks whether Beatline may access a folder (Desktop, Documents…), click **Allow**.
- [ ] Opening Beatline again while it's open just opens another window.

## 1. Listening (use 3 songs you know well: one steady pop/EDM, one live band, one slow/rubato)

- [ ] **Open a song…** → Finder's picker opens → pick the song → analysis finishes in a few seconds.
- [ ] Export tab already says **✓ Found on your Mac** with the song's path: nothing to paste.
- [ ] Dropping a song onto the window also works; if Beatline can't find it, **Show Beatline where the song is…** opens Finder's picker.
- [ ] **Play** (Space) plays the song; the timecode runs.
- [ ] **Click** (C) + play → a click on every cut, higher on bar starts, in time with the music.
- [ ] Zoomed in, the faint beat ticks and the orange bar lines sit on the drum hits.
- [ ] Tempo matches what you'd tap. If it's double/half, a tempo chip (½×, 2×) fixes it.
- [ ] "Time signature" says 4/4 for a pop song, 3/4 for a waltz (if you have one).
- [ ] Bar 1 is on the real "one". If not: playhead on the one, press **D** → bar numbers move.
- [ ] Confidence: steady songs say **Confident**; a voice memo or rubato piano says **Unsure**.
- [ ] Tempo line says "Steady" for programmed music, "Live feel" / "Tempo changes" for a band.
- [ ] Drag one beat line → it moves; ⌥-drag → all later beats move. **Reset grid edits** undoes it.
- [ ] **Find best-fitting grid** (Grid tab) → a toast with the tempo and strictness it chose.
- [ ] Feel: a shuffle/swing song says **Swing NN%**; a straight pop song says **Straight**.
- [ ] Accents: impacts / riser / breaks show as dashed yellow lines where you'd expect them.
- [ ] Key and LUFS look plausible (compare with a tagger/meter if you have one).

## 2. Planning

- [ ] Total cuts, shots, average shot and cuts/min change when you change **Cut pacing**.
- [ ] **Auto: follow the song's energy** → fewer cuts in calm sections, more in the drop.
- [ ] **Every 8th note** on a swing song → the in-between cuts sit on the swung off-beat.
- [ ] **Drums** → Kick / Snare / Hi-hat markers land on those drums.
- [ ] **Voice** on a voice-over → one cut per phrase after a pause.
- [ ] Drag across the ruler → a range; the plan counts only that part. **X** clears it.
- [ ] **Shortest shot** 1.0 → cuts closer than 1 s fade out and the count drops.

## 3. Song to length (Edit tab)

- [ ] Press **30** → "0:30 edit · … Jumps from bar X to bar Y · harmony match NN%".
- [ ] **Preview** plays from 6 s before the join; the join sounds musical (no skip or bump).
- [ ] **Download WAV** → a WAV of the shortened song that plays in QuickTime.
- [ ] With **Use this edit** ticked, the cut plan length shows the edit length.

## 3½. Clips and the shot board (Edit tab)

- [ ] **Choose clips folder…** → Finder's picker → pick a folder with subfolders of MOV/MP4 clips.
      → "N clips · X of Y shots filled · ✓ All clips linked". No path to paste.
- [ ] The **Shot board** (under the timeline) shows every shot with a thumbnail of its clip.
- [ ] Click a shot → it plays from that shot; the playing shot is outlined in orange.
- [ ] **⟳** on a shot → the next clip goes in and the shot is locked (green). **🔒** unlocks it.
- [ ] **Shuffle again** → unlocked shots change, locked ones stay. **Unlock all shots** clears them.
- [ ] **Folders and energy**: subfolders are listed with Calm / Groove / Peak (guessed from names).
      Set one folder to Peak → its clips land on the loud sections.
- [ ] "Don't use the same folder twice in a row" → neighbouring shots come from different folders.

## 4. Final Cut Pro (the important part)

For each export below, check: the project opens, the song **plays** (not offline/red), markers are
on the beat, and nothing is reported as an error on import.

- [ ] Export tab shows **✓ Found on your Mac** with the song's real path.
- [ ] **Song + markers** → Final Cut opens with the project; song plays; markers on the beat;
      section markers are chapter markers (orange).
- [ ] **Pre-cut** → a placeholder per shot, song underneath. Drag a clip onto a placeholder →
      **Replace from Start** → the clip takes the placeholder's length.
- [ ] **Markers** only → a gap clip carrying the markers.
- [ ] With a **30 s music edit** applied → two song pieces back to back; the join is on a bar line.
- [ ] **My clips** (Edit tab → Choose clips folder…, then Export → My clips):
      clips appear on the timeline cut to the shots, clip audio muted, song underneath.
      Check the clips play at normal speed (not slowed/sped up) and show the right part of each take.
- [ ] Try FCPXML version **1.9** if your Final Cut is older than 10.6.

## 5. Other editors (if you have them)

- [ ] **Premiere XML** → Premiere: File › Import → a sequence with the song and markers.
- [ ] **Resolve EDL** → Resolve: Timeline › Import › Timeline Markers from EDL → markers appear
      (timeline must start at 01:00:00:00).

## 6. Report back

Send: which boxes failed, the song (or its genre/BPM), your macOS + Final Cut version, and any
error text. A screenshot of the Beatline timeline zoomed into a bad spot helps most.
