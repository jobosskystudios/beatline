// Scores Beatline against librosa reference beats (see README.md).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, onsetEnvelope } from '../../js/dsp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ref = JSON.parse(fs.readFileSync(path.join(here, 'ref_librosa.json')));
const LIBROSA_LAG = 0.013;

function fmeasure(est, refb, tol = 0.07) {
  let hit = 0;
  const used = new Set();
  for (const e of est) {
    const j = refb.findIndex((r, k) => !used.has(k) && Math.abs(r - e) <= tol);
    if (j >= 0) { used.add(j); hit++; }
  }
  const p = hit / Math.max(1, est.length);
  const r = hit / Math.max(1, refb.length);
  return p + r ? (2 * p * r) / (p + r) : 0;
}

function onOff(beats, env, hop) {
  const at = (t) => { const f = Math.round(t / hop); let m = 0; for (let j = f - 2; j <= f + 2; j++) m = Math.max(m, env[j] ?? 0); return m; };
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return mean(beats.map(at)) / mean(beats.slice(1).map((b, i) => at((b + beats[i]) / 2)));
}

let total = 0;
for (const [name, info] of Object.entries(ref)) {
  const buf = fs.readFileSync(path.join(here, 'audio', `${name}.f32`));
  const x = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  const r = analyze(x, info.sr);
  const refBeats = info.beats.map((b) => b - LIBROSA_LAG);
  const f = fmeasure(r.beats, refBeats);
  const { env, hopTime } = onsetEnvelope(x, info.sr);
  total += f;
  console.log(
    name.slice(0, 30).padEnd(30),
    `bpm ${r.bpm.toFixed(1).padStart(6)} (ref ${info.tempo.toFixed(1).padStart(6)})`,
    `F ${f.toFixed(2)}`,
    `on/off ${onOff(r.beats, env, hopTime).toFixed(2)} (ref ${onOff(refBeats, env, hopTime).toFixed(2)})`,
  );
}
console.log('mean F', (total / Object.keys(ref).length).toFixed(3));
