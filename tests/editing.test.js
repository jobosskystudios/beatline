import { test } from 'node:test';
import assert from 'node:assert/strict';
import { barGrid, detectSections, sectionMarkers } from '../js/structure.js';
import { planCuts, sectionSummary } from '../js/cutplan.js';
import { buildMarkers } from '../js/markers.js';
import { FRAME_RATES, buildFcpxml, buildShotCsv } from '../js/fcpxml.js';

const r25 = FRAME_RATES['25'];

// 120 BPM, 4/4: quiet 8 bars, medium 8 bars, loud 8 bars, quiet 4 bars.
function layeredSong(sr = 8000) {
  const beat = 0.5;
  const plan = [...Array(8).fill(0.05), ...Array(8).fill(0.2), ...Array(8).fill(0.8), ...Array(4).fill(0.05)];
  const beats = [];
  const x = new Float32Array(Math.ceil(plan.length * 4 * beat * sr) + sr);
  plan.forEach((amp, bar) => {
    for (let k = 0; k < 4; k++) beats.push((bar * 4 + k) * beat);
    const a = Math.floor(bar * 2 * sr);
    for (let i = 0; i < 2 * sr; i++) x[a + i] = amp * Math.sin((2 * Math.PI * 220 * i) / sr);
  });
  return { x, sr, beats, duration: x.length / sr };
}

test('sections follow energy and the drop is found', () => {
  const { x, sr, beats, duration } = layeredSong();
  const bars = barGrid(beats, 0, 4, duration);
  assert.equal(bars.length, 28);
  const s = detectSections(x, sr, bars, duration);
  assert.deepEqual(s.map((v) => v.level), ['low', 'mid', 'high', 'low']);
  assert.deepEqual(s.map((v) => v.label), ['Intro', 'Groove', 'Drop', 'Outro']);
  assert.deepEqual(s.map((v) => v.firstBar), [1, 9, 17, 25]);
  assert.equal(s[0].start, 0);
  assert.equal(s[3].end, duration);
  assert.match(sectionMarkers(s)[2].label, /^3\. Drop \(bars 17–24\)$/);
});

test('auto pacing cuts slower in calm sections and faster in peaks', () => {
  const { x, sr, beats, duration } = layeredSong();
  const sections = detectSections(x, sr, barGrid(beats, 0, 4, duration), duration);
  const m = buildMarkers({ mode: 'beats', beats, onsets: [], phase: 0, beatsPerBar: 4, density: 'auto', sections, autoMap: { low: 'bar4', mid: 'bar', high: 'beat' } });
  const inRange = (a, b) => m.filter((v) => v.time >= a && v.time < b).length;
  assert.equal(inRange(0, 16), 2); // 8 calm bars, a cut every 4 bars
  assert.equal(inRange(16, 32), 8); // 8 groove bars, every bar
  assert.equal(inRange(32, 48), 32); // 8 peak bars, every beat
});

test('cut plan counts cuts, shots and enforces the shortest shot', () => {
  const markers = [0.2, 1, 2, 2.1, 3, 4.96].map((t) => ({ time: t, kind: 'beat', label: '' }));
  const plan = planCuts({ markers, rate: r25, rounding: 'nearest', inFrame: 0, outFrame: 125, minShotFrames: 10 });
  // 0.2s (5f) is too close to the start, 2.1s too close to 2s, 4.96s too close to the end.
  assert.deepEqual(plan.cuts, [25, 50, 75]);
  assert.equal(plan.stats.cuts, 3);
  assert.equal(plan.stats.shots, 4);
  assert.equal(plan.stats.lengthSec, 5);
  assert.equal(plan.stats.avgShot, 1.25);
  assert.equal(plan.stats.cutsPerMin, 36);
  assert.deepEqual(plan.shots.map((s) => s.frames), [25, 25, 25, 50]);
});

test('cut plan respects an in/out range and summarises by section', () => {
  const markers = [1, 2, 3, 4, 5, 6].map((t) => ({ time: t, kind: 'downbeat', label: '' }));
  const sections = [
    { start: 0, end: 3.5, label: 'Intro', level: 'low' },
    { start: 3.5, end: 10, label: 'Peak', level: 'high' },
  ];
  const plan = planCuts({ markers, rate: r25, rounding: 'nearest', inFrame: 50, outFrame: 150, sections });
  assert.deepEqual(plan.cuts, [75, 100, 125]);
  assert.equal(plan.shots[0].section.label, 'Intro');
  assert.equal(plan.shots[1].section.label, 'Intro');
  assert.equal(plan.shots[2].section.label, 'Peak');
  const sum = sectionSummary(sections, plan, r25, 50, 150);
  assert.deepEqual(sum.map((s) => [s.section.label, s.cuts]), [['Intro', 1], ['Peak', 2]]);
});

const song = { name: 'Track', fileName: 'Track.wav', folder: '/Users/me/Music', duration: 10, sampleRate: 48000, channels: 2 };
const styles = { section: 'chapter', downbeat: 'standard', beat: 'standard', hit: 'standard', manual: 'todo' };

test('pre-cut timeline: one placeholder per shot with the song connected below', () => {
  const markers = [2, 4].map((t) => ({ time: t, kind: 'downbeat', label: `Bar ${t}` }));
  // Range 1 s–6 s of the song; cuts at song 2 s and 4 s = timeline 1 s and 3 s.
  const timelineMarkers = markers.map((m) => ({ ...m, time: m.time - 1 }));
  const plan = planCuts({ markers: timelineMarkers, rate: r25, rounding: 'nearest', inFrame: 0, outFrame: 125 });
  const xml = buildFcpxml({
    markers, fps: '25', resolution: '1080p', rounding: 'nearest', version: '1.10', styles,
    target: 'blocked', segments: [{ inFrame: 25, outFrame: 150 }], shots: plan.shots, song, eventName: 'E', projectName: 'P',
  });
  const gaps = [...xml.matchAll(/<gap name="(Shot \d+)" offset="([^"]+)" start="0s" duration="([^"]+)"/g)].map((m) => m.slice(1));
  assert.deepEqual(gaps, [['Shot 1', '0s', '1s'], ['Shot 2', '1s', '2s'], ['Shot 3', '3s', '2s']]);
  assert.match(xml, /<asset-clip ref="r2" lane="-1" offset="0s" name="Track" start="1s" duration="5s"/);
  assert.match(xml, /<sequence format="r1" duration="5s"/);
  // Markers inside the song clip stay in song time.
  assert.match(xml, /<marker start="2s"/);
});

test('markers-only export shifts markers to the range start', () => {
  const xml = buildFcpxml({
    markers: [{ time: 3, kind: 'beat', label: 'b' }, { time: 0.5, kind: 'beat', label: 'outside' }],
    fps: '25', resolution: '1080p', rounding: 'nearest', version: '1.10', styles,
    target: 'gap', range: { inFrame: 50, outFrame: 100 }, song, eventName: 'E', projectName: 'P',
  });
  assert.match(xml, /<marker start="1s" duration="1\/25s" value="b"\/>/);
  assert.doesNotMatch(xml, /outside/);
});

test('shot list CSV uses timeline timecode', () => {
  const shots = [{ index: 1, start: 0, end: 25, frames: 25, seconds: 1, section: { label: 'Drop', level: 'high' } }];
  assert.equal(buildShotCsv(shots, '25', (f) => f + 50).split('\n')[1], '1,00:00:00:00,00:00:01:00,25,1.000,00:00:02:00,"Drop",high');
});
