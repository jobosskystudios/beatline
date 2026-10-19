"""Decode the evaluation tracks and compute librosa reference beats."""
import glob, json, os
import numpy as np, soundfile as sf, librosa

HERE = os.path.dirname(os.path.abspath(__file__))
out = {}
for p in sorted(glob.glob(os.path.join(HERE, "audio", "*.ogg"))):
    y, sr = sf.read(p, dtype="float32", always_2d=True)
    mono = y.mean(1)
    mono.astype("<f4").tofile(p + ".f32")
    tempo, beats = librosa.beat.beat_track(y=mono, sr=sr, units="time")
    out[os.path.basename(p)] = {"sr": sr, "tempo": float(np.atleast_1d(tempo)[0]), "beats": [float(b) for b in beats]}
    print(os.path.basename(p), round(out[os.path.basename(p)]["tempo"], 1))
json.dump(out, open(os.path.join(HERE, "ref_librosa.json"), "w"))
