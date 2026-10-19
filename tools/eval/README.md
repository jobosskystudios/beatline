# Beat-tracking evaluation

Scores Beatline's beat tracker on real recordings against [librosa](https://librosa.org)
as a reference, plus a reference-free check (onset strength on the beats vs. halfway between them).

```sh
pip install librosa soundfile
./tools/eval/fetch.sh            # 8 Creative Commons tracks from the librosa data repo → tools/eval/audio/
python3 tools/eval/reference.py  # decode to .f32 + librosa beats → tools/eval/ref_librosa.json
node tools/eval/score.mjs        # F-measure (±70 ms), tempo, on/off-beat ratio per track
```

librosa's beats sit about 13 ms after the true attack on synthetic drums; `score.mjs` corrects
for that. A higher on/off-beat ratio means the beats sit on stronger onsets. Audio files are not
committed (see each file's license in the librosa data repository).
