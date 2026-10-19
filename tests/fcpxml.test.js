import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRAME_RATES, rational, toFrame, timecode, fileUrl, buildFcpxml, buildCsv } from '../js/fcpxml.js';
import { buildMarkers } from '../js/markers.js';

const r2398 = FRAME_RATES['23.976'];

test('rational times are reduced', () => {
  assert.equal(rational(0, 24000), '0s');
  assert.equal(rational(24000, 24000), '1s');
  assert.equal(rational(1001, 24000), '1001/24000s');
  assert.equal(rational(200, 2400), '1/12s');
});

test('frame snapping honours rounding mode', () => {
  const t = 1.02; // 24.4554 frames at 23.976
  assert.equal(toFrame(t, r2398, 'nearest'), 24);
  assert.equal(toFrame(t, r2398, 'previous'), 24);
  assert.equal(toFrame(t, r2398, 'next'), 25);
  assert.equal(toFrame(1, FRAME_RATES['25'], 'next'), 25);
});

test('timecode', () => {
  assert.equal(timecode(25 * 61 + 3, FRAME_RATES['25']), '00:01:01:03');
});

test('file URLs are percent-encoded per segment', () => {
  assert.equal(fileUrl('/Users/me/My Music/', 'Song #1 (mix).mp3'), 'file:///Users/me/My%20Music/Song%20%231%20(mix).mp3');
});

test('marker density and bar labels', () => {
  const beats = Array.from({ length: 12 }, (_, i) => i * 0.5);
  const all = buildMarkers({ mode: 'beats', beats, onsets: [], phase: 1, beatsPerBar: 4, density: 'beat' });
  assert.equal(all.length, 12);
  assert.equal(all[0].label, 'Bar 0 · Beat 4'); // pickup beat before first downbeat
  assert.equal(all[1].kind, 'downbeat');
  assert.equal(all[1].label, 'Bar 1');
  const bars = buildMarkers({ mode: 'beats', beats, onsets: [], phase: 1, beatsPerBar: 4, density: 'bar' });
  assert.deepEqual(bars.map((m) => m.time), [0.5, 2.5, 4.5]);
  const bar2 = buildMarkers({ mode: 'beats', beats, onsets: [], phase: 1, beatsPerBar: 4, density: 'bar2' });
  assert.deepEqual(bar2.map((m) => m.time), [0.5, 4.5]);
});

test('FCPXML clip export', () => {
  const markers = [
    { time: 0.5, kind: 'downbeat', label: 'Bar 1' },
    { time: 0.51, kind: 'beat', label: 'dupe frame' },
    { time: 1.0, kind: 'beat', label: 'Bar 1 · Beat 2 & <x>' },
    { time: 99, kind: 'beat', label: 'past end' },
  ];
  const xml = buildFcpxml({
    markers, fps: '23.976', resolution: '1080p', rounding: 'nearest', version: '1.10',
    styles: { beat: 'standard', downbeat: 'chapter', hit: 'standard', manual: 'todo' },
    target: 'clip',
    song: { name: 'Track', fileName: 'Track.wav', folder: '/Users/me/Music', duration: 10, sampleRate: 48000, channels: 2 },
    eventName: 'Beatline', projectName: 'Track – beats',
  });
  assert.match(xml, /<fcpxml version="1.10">/);
  assert.match(xml, /name="FFVideoFormat1080p2398" frameDuration="1001\/24000s"/);
  assert.match(xml, /src="file:\/\/\/Users\/me\/Music\/Track.wav"/);
  assert.match(xml, /<chapter-marker start="1001\/2000s"/);
  assert.equal((xml.match(/<marker /g) || []).length, 1, 'duplicate frame and out-of-range markers dropped');
  assert.match(xml, /Beat 2 &amp; &lt;x&gt;/);
  assert.match(xml, /<asset-clip ref="r2"[^>]*duration="239239\/24000s"/);
});

test('FCPXML gap (markers only) export has no asset', () => {
  const xml = buildFcpxml({
    markers: [{ time: 1, kind: 'hit', label: 'Hit 1' }], fps: '25', resolution: 'vertical', rounding: 'nearest', version: '1.10',
    styles: { beat: 'standard', downbeat: 'standard', hit: 'todo', manual: 'standard' },
    target: 'gap', song: { name: 'X', duration: 5 }, eventName: 'E', projectName: 'P',
  });
  assert.doesNotMatch(xml, /<asset /);
  assert.match(xml, /<gap name="X markers"/);
  assert.match(xml, /<marker start="1s" duration="1\/25s" value="Hit 1" completed="0"\/>/);
  assert.match(xml, /<format id="r1" frameDuration="1\/25s" width="1080" height="1920"/);
});

test('CSV export', () => {
  const csv = buildCsv([{ time: 1, kind: 'beat', label: 'a "b"' }], '25', 'nearest');
  assert.equal(csv.split('\n')[1], '1,1.0000,25,00:00:01:00,beat,"a ""b"""');
});
