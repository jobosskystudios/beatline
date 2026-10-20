import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onsetEnvelope, trackBeats, estimateTempo } from '../js/dsp.js';
import { detectSwing, detectAccents, speechPhrases } from '../js/insights.js';
import { planMusicEdit, mapToEdit, renderEdit, encodeWav } from '../js/musicedit.js';
import { assignClips } from '../js/clips.js';
import { buildMarkers } from '../js/markers.js';
import { FRAME_RATES, buildFcpxml } from '../js/fcpxml.js';
import { buildPremiereXml, buildResolveEdl } from '../js/exports.js';
import { readMovieInfo, readAudioInfo } from '../js/fileinfo.js';

const SR = 22050;
let seed = 5;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
const kick = (t) => Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-t * 40)) * t) * Math.exp(-t * 12);
const hat = (t) => rnd() * Math.exp(-t * 90) * 0.6;
function addAt(x, t0, len, fn, gain = 1) {
  const s = Math.round(t0 * SR);
  for (let i = 0; i < len * SR && s + i < x.length; i++) x[s + i] += gain * fn(i / SR);
}

function groove({ bpm = 100, beats = 48, offbeat = 0.5 }) {
  const b = 60 / bpm;
  const x = new Float32Array(Math.ceil((beats * b + 1) * SR));
  for (let i = 0; i < beats; i++) {
    addAt(x, 0.3 + i * b, 0.3, kick, 0.9);
    addAt(x, 0.3 + i * b, 0.08, hat, 0.8); // hat on the beat
    addAt(x, 0.3 + (i + offbeat) * b, 0.08, hat, 0.5); // quieter hat between
  }
  const o = onsetEnvelope(x, SR);
  const beatTimes = trackBeats(o.env, o.hopTime, bpm, 100, o.active).map((f) => f * o.hopTime);
  return { x, o, beatTimes };
}

test('swing: straight vs swung off-beats', () => {
  const straight = groove({ offbeat: 0.5 });
  assert.equal(detectSwing(straight.o.env, straight.o.hopTime, straight.beatTimes, straight.o.active).feel, 'straight');
  const swung = groove({ offbeat: 0.66 });
  const sw = detectSwing(swung.o.env, swung.o.hopTime, swung.beatTimes, swung.o.active);
  assert.equal(sw.feel, 'swing');
  assert.ok(Math.abs(sw.ratio - 0.66) < 0.05, `ratio ${sw.ratio}`);
});

test('eighth-note pacing puts the off-beat on the swing', () => {
  const m = buildMarkers({ mode: 'beats', beats: [0, 1, 2], onsets: [], density: 'eighth', swingRatio: 0.66 });
  assert.deepEqual(m.map((v) => +v.time.toFixed(2)), [0, 0.66, 1, 1.66, 2]);
  assert.equal(m[1].kind, 'sub');
});

test('accents: a break before the drop, the beat before it, and impacts', () => {
  const bpm = 120;
  const b = 0.5;
  const x = new Float32Array(SR * 26);
  // 16 beats groove, 2 beats of silence, then a loud drop for 24 beats.
  for (let i = 0; i < 16; i++) addAt(x, 0.5 + i * b, 0.3, kick, 0.5);
  for (let i = 18; i < 42; i++) addAt(x, 0.5 + i * b, 0.3, kick, 0.9);
  addAt(x, 0.5 + 18 * b, 0.4, (t) => rnd() * Math.exp(-t * 8), 1.6); // crash on the drop
  const o = onsetEnvelope(x, SR);
  const beats = Array.from({ length: 42 }, (_, i) => 0.5 + i * b);
  const sections = [
    { start: 0, end: 9.5, level: 'mid', drop: false },
    { start: 9.5, end: 26, level: 'high', drop: true },
  ];
  const acc = detectAccents(o, { beats, bars: [], sections, duration: 26 });
  const types = acc.map((a) => a.type);
  assert.ok(types.includes('break'), types.join());
  const brk = acc.find((a) => a.type === 'break');
  assert.ok(brk.time > 8 && brk.time < 9.3, `break at ${brk.time}`);
  assert.ok(acc.some((a) => a.type === 'impact' && Math.abs(a.time - 9.5) < 0.1));
  assert.ok(acc.some((a) => a.type === 'predrop' && Math.abs(a.time - 9) < 0.01));
});

test('voice phrases start after pauses', () => {
  const x = new Float32Array(SR * 6);
  const voice = (t) => Math.sin(2 * Math.PI * 180 * t) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t)) * 0.4;
  for (const [a, len] of [[0.5, 1.2], [2.2, 0.9], [3.15, 0.05], [3.6, 1.5]]) addAt(x, a, len, voice);
  const o = onsetEnvelope(x, SR);
  const p = speechPhrases(o, { minPause: 0.3 });
  const starts = p.map((v) => +v.time.toFixed(1));
  assert.deepEqual(starts, [0.5, 2.2, 3.6]); // the 50 ms blip is too short to count
});

test('music edit: keeps the opening and the real ending, on bar lines, near the target', () => {
  const bars = Array.from({ length: 48 }, (_, i) => ({ bar: i + 1, start: i * 2, end: i * 2 + 2 }));
  // Bars 1–16 chord A, 17–32 chord B, 33–48 chord A again.
  const A = Float32Array.from([1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0]);
  const B = Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0]);
  const barChroma = bars.map((_, i) => (i >= 16 && i < 32 ? B : A));
  const e = planMusicEdit({ bars, barChroma, duration: 96, target: 30 });
  assert.equal(e.segments.length, 2);
  assert.equal(e.segments[0].start, 0);
  assert.equal(e.segments[1].end, 96);
  assert.ok(Math.abs(e.length - 30) <= 2, `length ${e.length}`);
  // Seam on bar lines, phrase-aligned, with matching harmony.
  assert.equal(e.segments[0].end % 2, 0);
  assert.equal((e.seam.fromBar - 1) % 4, 0);
  assert.equal((e.seam.toBar - 1) % 4, 0);
  assert.ok(e.seam.match > 0.99);
  assert.equal(mapToEdit(e.segments, 1), 1);
  assert.equal(mapToEdit(e.segments, e.segments[1].start + 1), e.segments[0].end + 1);
  assert.equal(mapToEdit(e.segments, e.segments[0].end + 0.5), null);
  assert.equal(planMusicEdit({ bars, barChroma, duration: 96, target: 120 }), null);
});

test('rendered edit length and WAV encoding', () => {
  const sr = 8000;
  const ch = new Float32Array(sr * 10).fill(0.5);
  const out = renderEdit([ch, ch], sr, [{ start: 0, end: 4 }, { start: 8, end: 10 }], { fadeMs: 30 });
  assert.equal(out[0].length, sr * 6 - Math.round(0.03 * sr));
  // Equal-power crossfade of identical signals never drops below the level.
  const mid = Math.round(4 * sr) - Math.round(0.03 * sr) + 10;
  assert.ok(out[0][mid] >= 0.5 - 1e-6);
  const wav = encodeWav(out, sr);
  assert.deepEqual(readAudioInfo(wav), { sampleRate: sr, channels: 2 });
  assert.equal(wav.byteLength, 44 + out[0].length * 4);
});

test('clips: each used once before repeats, in-points inside the take on its frames', () => {
  const fd = { num: 1001, den: 24000 };
  const clips = ['C', 'A', 'B'].map((n, i) => ({ name: n, duration: 4 + i, frameDuration: fd }));
  const shots = Array.from({ length: 5 }, (_, i) => ({ index: i + 1, seconds: 2 }));
  const p = assignClips(shots, clips, { order: 'name' });
  assert.deepEqual(p.map((x) => x.clip.name), ['A', 'B', 'C', 'A', 'B']);
  for (const x of p) {
    const inSec = x.inPoint.n / x.inPoint.d;
    assert.ok(inSec >= 0 && inSec + 2 <= x.clip.duration + 1e-9);
    assert.equal(x.inPoint.d, 24000);
    assert.equal(x.inPoint.n % 1001, 0);
  }
  // A shot longer than every clip is left empty.
  assert.equal(assignClips([{ index: 1, seconds: 30 }], clips).length, 0);
  // Shuffle is repeatable with the same seed.
  const a = assignClips(shots, clips, { order: 'shuffle', seed: 7 }).map((x) => x.clip.name).join();
  const b = assignClips(shots, clips, { order: 'shuffle', seed: 7 }).map((x) => x.clip.name).join();
  assert.equal(a, b);
});

// Minimal QuickTime file: ftyp, mdat, then moov (index at the end).
function fakeMov() {
  const enc = (s) => [...s].map((c) => c.charCodeAt(0));
  const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const u16 = (v) => [(v >>> 8) & 255, v & 255];
  const box = (type, payload) => [...u32(8 + payload.length), ...enc(type), ...payload];
  const zeros = (n) => new Array(n).fill(0);
  const mvhd = box('mvhd', [...zeros(4), ...zeros(8), ...u32(600), ...u32(600 * 12), ...zeros(80)]);
  const tkhd = box('tkhd', [...zeros(4), ...zeros(72), ...u32(3840 << 16 >>> 0), ...u32(2160 << 16)]);
  const mdhd = box('mdhd', [...zeros(4), ...zeros(8), ...u32(25), ...u32(300), ...zeros(4)]);
  const hdlr = box('hdlr', [...zeros(8), ...enc('vide'), ...zeros(12)]);
  const stts = box('stts', [...zeros(4), ...u32(1), ...u32(300), ...u32(1)]);
  const stsd = box('stsd', [...zeros(4), ...u32(1), ...u32(16), ...enc('avc1'), ...zeros(8)]);
  const trak = box('trak', [...tkhd, ...box('mdia', [...mdhd, ...hdlr, ...box('minf', box('stbl', [...stts, ...stsd]))])]);
  const ahdlr = box('hdlr', [...zeros(8), ...enc('soun'), ...zeros(12)]);
  const astsd = box('stsd', [...zeros(4), ...u32(1), ...u32(36), ...enc('mp4a'), ...zeros(16), ...u16(2), ...zeros(6), ...u32(48000 * 65536)]);
  const atrak = box('trak', box('mdia', [...box('mdhd', [...zeros(4), ...zeros(8), ...u32(48000), ...u32(0), ...zeros(4)]), ...ahdlr, ...box('minf', box('stbl', astsd))]));
  return new Uint8Array([...box('ftyp', [...enc('qt  '), ...zeros(4)]), ...box('mdat', zeros(5000)), ...box('moov', [...mvhd, ...trak, ...atrak])]);
}

test('reads duration, frame rate, size and audio from a QuickTime file', async () => {
  const info = await readMovieInfo(new Blob([fakeMov()]));
  assert.equal(info.duration, 12);
  assert.deepEqual(info.video.frameDuration, { num: 1, den: 25 });
  assert.equal(info.video.width, 3840);
  assert.equal(info.video.height, 2160);
  assert.deepEqual(info.audio, { channels: 2, sampleRate: 48000 });
});

const r25 = FRAME_RATES['25'];
const song = { name: 'Track', fileName: 'Track.wav', folder: '/Users/me/Music', duration: 60, sampleRate: 48000, channels: 2 };
const styles = { section: 'chapter', accent: 'todo', downbeat: 'standard', beat: 'standard', manual: 'todo' };

test('music edit export: two song clips back to back, markers kept in song time', () => {
  const xml = buildFcpxml({
    markers: [{ time: 2, kind: 'beat', label: 'early' }, { time: 50, kind: 'beat', label: 'late' }, { time: 30, kind: 'beat', label: 'cut out' }],
    fps: '25', resolution: '1080p', rounding: 'nearest', version: '1.10', styles, target: 'clip',
    segments: [{ inFrame: 0, outFrame: 250 }, { inFrame: 1125, outFrame: 1500 }], song, eventName: 'E', projectName: 'P',
  });
  const clips = [...xml.matchAll(/<asset-clip ref="r2" offset="([^"]+)" name="Track" start="([^"]+)" duration="([^"]+)"/g)].map((m) => m.slice(1));
  assert.deepEqual(clips, [['0s', '0s', '10s'], ['10s', '45s', '15s']]);
  assert.match(xml, /<marker start="2s"[^>]*value="early"/);
  assert.match(xml, /<marker start="50s"[^>]*value="late"/);
  assert.doesNotMatch(xml, /cut out/);
  assert.match(xml, /<sequence format="r1" duration="25s"/);
});

test('assembled export: clips cut to the shots, muted, song connected under the first', () => {
  const clip = { name: 'Take 1', fileName: 'Take 1.mov', folder: '/Users/me/Clips', duration: 12, frameDuration: { num: 1001, den: 24000 }, width: 3840, height: 2160, audio: { channels: 2, sampleRate: 48000 } };
  const shots = [{ index: 1, start: 0, end: 50 }, { index: 2, start: 50, end: 125 }];
  const xml = buildFcpxml({
    markers: [], fps: '25', resolution: '4k', rounding: 'nearest', version: '1.10', styles, target: 'assembled',
    segments: [{ inFrame: 0, outFrame: 125 }], shots,
    placements: [{ shot: shots[0], clip, inPoint: { n: 24024, d: 24000 } }, { shot: shots[1], clip, inPoint: { n: 72072, d: 24000 } }],
    muteClips: true, song, eventName: 'E', projectName: 'P',
  });
  assert.match(xml, /<format id="f1" frameDuration="1001\/24000s" width="3840" height="2160"\/>/);
  assert.match(xml, /<asset id="c1" name="Take 1"[^>]*hasVideo="1" format="f1" hasAudio="1"/);
  assert.match(xml, /src="file:\/\/\/Users\/me\/Clips\/Take%201.mov"/);
  assert.match(xml, /<asset-clip ref="c1" offset="0s" name="Take 1" start="1001\/1000s" duration="2s"/);
  assert.match(xml, /<asset-clip ref="c1" offset="2s" name="Take 1" start="3003\/1000s" duration="3s"/);
  assert.equal((xml.match(/<adjust-volume amount="-96dB"\/>/g) || []).length, 2);
  // Song hangs under the first clip at that clip's in-point (its local time).
  assert.match(xml, /<asset-clip ref="r2" lane="-1" offset="1001\/1000s" name="Track" start="0s" duration="5s"/);
});

test('Premiere XML and Resolve EDL', () => {
  const markers = [{ frame: 12, label: 'Bar 1', kind: 'downbeat' }, { frame: 48, label: '2. Drop', kind: 'section' }];
  const px = buildPremiereXml({ name: 'Track – beats', fps: '23.976', markers, segments: [{ inFrame: 0, outFrame: 240 }], song });
  assert.match(px, /<timebase>24<\/timebase><ntsc>TRUE<\/ntsc>/);
  assert.match(px, /<pathurl>file:\/\/localhost\/Users\/me\/Music\/Track.wav<\/pathurl>/);
  assert.match(px, /<marker>\s*<name>Bar 1<\/name>\s*<comment><\/comment>\s*<in>12<\/in>/);
  assert.match(px, /<start>0<\/start>\s*<end>240<\/end>\s*<in>0<\/in>\s*<out>240<\/out>/);
  const edl = buildResolveEdl({ name: 'Track', fps: '25', markers });
  const lines = edl.split('\n');
  assert.equal(lines[0], 'TITLE: Track');
  assert.equal(lines[3], '001  001      V     C        01:00:00:12 01:00:00:13 01:00:00:12 01:00:00:13  ');
  assert.equal(lines[4], ' |C:ResolveColorBlue |M:Bar 1 |D:1');
  assert.match(edl, /\|C:ResolveColorPurple \|M:2\. Drop \|D:1/);
});

test('estimateTempo is unaffected by the new modules (sanity)', () => {
  const { o } = groove({ bpm: 100 });
  assert.ok(Math.abs(estimateTempo(o.env, o.hopTime) - 100) < 2);
});

test('strongest hits keeps only the biggest events', async () => {
  const { strongestHits } = await import('../js/insights.js');
  const x = new Float32Array(SR * 30);
  for (let i = 0; i < 60; i++) addAt(x, 0.5 + i * 0.48, 0.2, kick, 0.25); // steady quiet beat
  for (const t of [5.3, 13.0, 21.4]) addAt(x, t, 0.5, (u) => rnd() * Math.exp(-u * 6), 1.8); // three slams
  const o = onsetEnvelope(x, SR);
  const hits = strongestHits(o.env, o.hopTime, { perMinute: 6, active: o.active });
  assert.equal(hits.length, 3);
  [5.3, 13.0, 21.4].forEach((t, i) => assert.ok(Math.abs(hits[i] - t) < 0.02, `hit ${hits[i]} vs ${t}`));
});

test('grid cuts snap onto a nearby attack, but not across empty space', async () => {
  const { snapToHits } = await import('../js/insights.js');
  const x = new Float32Array(SR * 6);
  for (const t of [1.04, 2.04, 3.04, 4.04]) addAt(x, t, 0.3, kick, 0.9); // hits 40 ms after the grid
  const o = onsetEnvelope(x, SR);
  const grid = [1, 2, 3, 4, 5].map((t) => ({ time: t, kind: 'beat', label: '' }));
  const out = snapToHits(grid, o.env, o.hopTime, 0.06);
  out.slice(0, 4).forEach((m, i) => assert.ok(Math.abs(m.time - (i + 1.04)) < 0.012, `snapped to ${m.time}`));
  assert.equal(out[4].time, 5); // nothing near 5 s: stays on the grid
});
