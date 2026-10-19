import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onsetEnvelope, estimateTempo, resolveOctave, trackBeats } from '../js/dsp.js';
import { analyzeSong, loudness, detectKey, chromagram, periodicity, confidenceLevel } from '../js/analysis.js';
import { readAudioInfo } from '../js/fileinfo.js';

const SR = 22050;
let seed = 3;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
const kick = (t) => Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-t * 40)) * t) * Math.exp(-t * 12);
const tick = (t) => rnd() * Math.exp(-t * 70) * 0.5;

function addAt(x, t0, len, fn, gain = 1) {
  const s = Math.round(t0 * SR);
  for (let i = 0; i < len * SR && s + i < x.length; i++) x[s + i] += gain * fn(i / SR);
}

// Chord tones for a triad on `root` (MIDI note numbers).
const triad = (root, minor = false) => [root, root + (minor ? 3 : 4), root + 7];
const hz = (m) => 440 * 2 ** ((m - 69) / 12);

test('onset timing lands on the audible attack (within 10 ms)', () => {
  const times = Array.from({ length: 16 }, (_, i) => 0.5 + i * 0.47);
  const x = new Float32Array(SR * 9);
  for (const t of times) addAt(x, t, 0.3, kick, 0.8);
  const { env, hopTime } = onsetEnvelope(x, SR);
  const errs = times.map((t) => {
    const f = Math.round(t / hopTime);
    let bi = f - 6;
    for (let j = f - 6; j <= f + 6; j++) if (env[j] > env[bi]) bi = j;
    return Math.abs(bi * hopTime - t);
  });
  assert.ok(Math.max(...errs) < 0.010, `max error ${(Math.max(...errs) * 1000).toFixed(1)} ms`);
});

test('a waltz is detected as 3/4 with the bar on the bass note', () => {
  const beat = 60 / 150;
  const bars = 24;
  const x = new Float32Array(Math.ceil((bars * 3 * beat + 1) * SR));
  const prog = [triad(48), triad(53), triad(55), triad(48)]; // C F G C
  for (let b = 0; b < bars; b++) {
    const chord = prog[b % 4];
    for (let k = 0; k < 3; k++) {
      const t0 = 0.3 + (b * 3 + k) * beat;
      if (k === 0) addAt(x, t0, 0.35, kick, 0.9);
      else addAt(x, t0, 0.1, tick);
      // Chord stabs every beat, chord changes on the bar.
      addAt(x, t0, beat * 0.9, (t) => chord.reduce((s, m) => s + Math.sin(2 * Math.PI * hz(m + 12) * t), 0) * 0.08 * Math.exp(-t * 3));
    }
  }
  const r = analyzeSong({ channels: [x], sampleRate: SR });
  assert.ok(Math.abs(r.bpm - 150) < 2, `bpm ${r.bpm}`);
  assert.equal(r.info.meter.beatsPerBar, 3);
  const firstDown = r.beatFrames[r.info.meter.phase] * r.o.hopTime;
  const idx = Math.round((firstDown - 0.3) / beat);
  assert.equal(idx % 3, 0, `bar starts on beat ${idx}`);
  assert.equal(r.info.confidence, 'high');
});

test('slow detections double when the off-beats are strong', () => {
  // Kick on every beat at 140 BPM; the tempogram prior can land on 70.
  const beat = 60 / 140;
  const x = new Float32Array(SR * 20);
  for (let i = 0; i * beat < 19; i++) addAt(x, 0.2 + i * beat, 0.25, i % 2 ? tick : kick, i % 2 ? 1.8 : 0.9);
  const { env, hopTime, active } = onsetEnvelope(x, SR);
  assert.ok(Math.abs(resolveOctave(env, hopTime, 70, active) - 140) < 1);
  // A real half-time pulse (nothing between the beats) stays where it is.
  const y = new Float32Array(SR * 20);
  for (let i = 0; i * 2 * beat < 19; i++) addAt(y, 0.2 + i * 2 * beat, 0.25, kick, 0.9);
  const e2 = onsetEnvelope(y, SR);
  assert.ok(Math.abs(resolveOctave(e2.env, e2.hopTime, 70, e2.active) - 70) < 1);
});

test('no steady beat reads as low confidence', () => {
  let s2 = 11;
  const r2 = () => ((s2 = (s2 * 48271) % 2147483647) / 2147483647);
  const x = new Float32Array(SR * 16);
  let t = 0.3;
  while (t < 15.5) { addAt(x, t, 0.2, tick, 2); t += 0.15 + r2() * 1.3; }
  const { env, hopTime } = onsetEnvelope(x, SR);
  const bpm = estimateTempo(env, hopTime);
  assert.equal(confidenceLevel(periodicity(env, hopTime, bpm)), 'low');
  assert.ok(trackBeats(env, hopTime, bpm).length >= 0);
});

test('key of a C major progression', () => {
  const x = new Float32Array(SR * 12);
  [triad(60), triad(65), triad(67), triad(60), triad(57, true), triad(65), triad(67), triad(60)].forEach((ch, i) => {
    addAt(x, i * 1.5, 1.5, (t) => ch.reduce((s, m) => s + Math.sin(2 * Math.PI * hz(m) * t), 0) * 0.1);
  });
  assert.equal(detectKey(chromagram(x, SR)).name, 'C major');
});

test('loudness: a -20 dBFS 997 Hz tone in both channels reads -20 LUFS', () => {
  const sr = 48000;
  const a = 10 ** (-20 / 20);
  const ch = new Float32Array(sr * 5);
  for (let i = 0; i < ch.length; i++) ch[i] = a * Math.sin((2 * Math.PI * 997 * i) / sr);
  const L = loudness([ch, ch], sr);
  assert.ok(Math.abs(L.lufs + 20) < 0.3, `lufs ${L.lufs}`);
  assert.ok(Math.abs(L.peakDb + 20) < 0.05);
});

function wavHeader(sampleRate, channels) {
  const b = new ArrayBuffer(44);
  const v = new DataView(b);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true); w(36, 'data');
  return b;
}

test('reads the original sample rate from file headers', () => {
  assert.deepEqual(readAudioInfo(wavHeader(48000, 2)), { sampleRate: 48000, channels: 2 });
  // MPEG-1 Layer III, 44.1 kHz, stereo frame header after an empty ID3 tag.
  const mp3 = new Uint8Array(32);
  mp3.set([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x00]);
  assert.deepEqual(readAudioInfo(mp3.buffer), { sampleRate: 44100, channels: 2 });
  assert.equal(readAudioInfo(new Uint8Array(64).buffer), null);
});
