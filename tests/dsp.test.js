import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../js/dsp.js';

// Synthetic drum loop: low "kick" on beat 1 of each bar, bright "hat" on the
// others, with a little noise floor and a silent intro.
function drumLoop({ bpm, bars, beatsPerBar = 4, sr = 44100, intro = 1.0 }) {
  const beat = 60 / bpm;
  const len = Math.ceil((intro + bars * beatsPerBar * beat + 1) * sr);
  const x = new Float32Array(len);
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  for (let i = 0; i < len; i++) x[i] = 0.01 * rnd();
  const times = [];
  for (let b = 0; b < bars * beatsPerBar; b++) {
    const t0 = intro + b * beat;
    times.push(t0);
    const start = Math.round(t0 * sr);
    const kick = b % beatsPerBar === 0;
    for (let i = 0; i < 0.15 * sr && start + i < len; i++) {
      const t = i / sr;
      x[start + i] += kick
        ? 0.9 * Math.sin(2 * Math.PI * 55 * t) * Math.exp(-t * 25)
        : 0.4 * rnd() * Math.exp(-t * 60);
    }
  }
  return { x, sr, times };
}

for (const bpm of [90, 120, 128, 150]) {
  test(`tracks a ${bpm} BPM loop`, () => {
    const { x, sr, times } = drumLoop({ bpm, bars: 16 });
    const r = analyze(x, sr, { beatsPerBar: 4 });
    assert.ok(Math.abs(r.bpm - bpm) < 1.5, `bpm ${r.bpm}`);
    assert.ok(r.beats.length >= times.length - 2, `found ${r.beats.length} of ${times.length}`);
    for (const b of r.beats) {
      const err = Math.min(...times.map((t) => Math.abs(t - b)));
      assert.ok(err < 0.03, `beat ${b.toFixed(3)} is ${err.toFixed(3)}s off`);
    }
    // The beat at phase index must be a kick (bar start).
    const first = r.beats[r.phase];
    const idx = times.findIndex((t) => Math.abs(t - first) < 0.03);
    assert.equal(idx % 4, 0, 'downbeat phase lands on the kick');
  });
}

test('manual BPM override is respected', () => {
  const { x, sr } = drumLoop({ bpm: 120, bars: 8 });
  const r = analyze(x, sr, { bpm: 60 });
  assert.equal(r.bpm, 60);
  const gaps = r.beats.slice(1).map((b, i) => b - r.beats[i]);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  assert.ok(Math.abs(mean - 1) < 0.05, `mean gap ${mean}`);
});

test('hit detection finds every transient', () => {
  const { x, sr, times } = drumLoop({ bpm: 100, bars: 4 });
  const r = analyze(x, sr, { sensitivity: 0.5 });
  for (const t of times) {
    assert.ok(r.onsets.some((o) => Math.abs(o - t) < 0.03), `missed hit at ${t}`);
  }
  assert.ok(r.onsets.length <= times.length + 2, `too many hits: ${r.onsets.length}`);
});
