// Musical details an editor cuts to beyond the grid: swing feel, accents
// (impacts, risers, breaks, the beat before the drop) and pauses in speech.
import { pickOnsets } from './dsp.js';

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const percentile = (arr, p) => {
  const s = Float32Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
};

// ---------- swing ----------

// Where do the off-beat hits fall inside each beat? Straight eighths sit at
// 0.5, swung ones around 0.6–0.7, triplet feels add hits at 1/3 and 2/3.
export function detectSwing(env, hopTime, beats, active = null) {
  const onsets = pickOnsets(env, hopTime, 0.6, 0.05, active);
  const at = (t) => env[Math.round(t / hopTime)] ?? 0;
  const bins = { straight: 0, swing: 0, third: 0 };
  const swingPhases = [];
  let total = 0;
  let b = 0;
  for (const t of onsets) {
    while (b + 1 < beats.length && beats[b + 1] <= t) b++;
    if (b + 1 >= beats.length || t < beats[b]) continue;
    const phase = (t - beats[b]) / (beats[b + 1] - beats[b]);
    if (phase < 0.2 || phase > 0.85) continue; // on the beat
    const w = at(t);
    total += w;
    if (phase >= 0.44 && phase < 0.56) bins.straight += w;
    else if (phase >= 0.56 && phase <= 0.76) { bins.swing += w; swingPhases.push(phase); }
    if (phase >= 0.27 && phase <= 0.4) bins.third += w;
  }
  if (total === 0) return { feel: 'straight', ratio: 0.5, label: 'Straight' };
  const ratio = swingPhases.length ? mean(swingPhases) : 0.5;
  if (bins.third / total > 0.25 && bins.swing / total > 0.25) return { feel: 'triplet', ratio: 2 / 3, label: 'Triplet feel' };
  if (bins.swing > bins.straight * 1.3 && bins.swing / total > 0.3) {
    return { feel: 'swing', ratio, label: `Swing ${Math.round(ratio * 100)}%` };
  }
  return { feel: 'straight', ratio: 0.5, label: 'Straight' };
}

// ---------- accents ----------

// Per-bar mean of a per-frame series (frames of hopTime) over [start, end).
function barMean(series, stride, offset, hopTime, start, end) {
  const a = Math.max(0, Math.floor(start / hopTime));
  const b = Math.max(a + 1, Math.floor(end / hopTime));
  let s = 0;
  let n = 0;
  for (let f = a; f < b && f * stride + offset < series.length; f++, n++) s += series[f * stride + offset];
  return n ? s / n : 0;
}

// o: onsetEnvelope() output. Returns markers { time, kind: 'accent', label, type }.
export function detectAccents(o, { beats = [], bars = [], sections = [], duration = 0 } = {}) {
  const out = [];
  const hop = o.hopTime;

  // Impacts: the hardest hits in the song, at least 2 s apart, and only the
  // strongest (about one per 20 s) so they stay special.
  const thr = Math.max(percentile(o.env, 0.995), 3 * percentile(o.env, 0.9));
  const peaks = [];
  for (let f = 2; f < o.env.length - 2; f++) {
    const v = o.env[f];
    if (v < thr || !o.active[f]) continue;
    if (v < o.env[f - 1] || v < o.env[f + 1] || v < o.env[f - 2] || v < o.env[f + 2]) continue;
    peaks.push({ f, v });
  }
  const cap = Math.max(3, Math.round((o.env.length * hop) / 20));
  const kept = [];
  for (const p of peaks.sort((a, b) => b.v - a.v)) {
    if (kept.length >= cap) break;
    if (kept.every((k) => Math.abs(k.f - p.f) * hop >= 2)) kept.push(p);
  }
  for (const p of kept) out.push({ time: p.f * hop, kind: 'accent', type: 'impact', label: 'Impact' });

  // Breaks: the music drops out (≥ 12 dB below its surroundings) for at least
  // one beat, e.g. the gap before a drop.
  const beat = beats.length > 1 ? (beats[beats.length - 1] - beats[0]) / (beats.length - 1) : 0.5;
  const smoothN = Math.max(1, Math.round(0.1 / hop));
  const ctxN = Math.round(4 / hop);
  const loud = new Float32Array(o.rmsDb.length);
  for (let f = 0; f < loud.length; f++) {
    let s = 0;
    let n = 0;
    for (let j = f - smoothN; j <= f + smoothN; j++) if (j >= 0 && j < loud.length) { s += o.rmsDb[j]; n++; }
    loud[f] = s / n;
  }
  const minLen = Math.round((beat * 0.9) / hop);
  for (let f = 0; f < loud.length;) {
    const lo = Math.max(0, f - ctxN);
    const hi = Math.min(loud.length, f + ctxN);
    const around = percentile(loud.subarray(lo, hi), 0.75);
    if (loud[f] < around - 12 && o.active[Math.max(0, f - ctxN)] && f > ctxN && f < loud.length - ctxN) {
      let g = f;
      while (g < loud.length && loud[g] < around - 12) g++;
      if (g - f >= minLen) {
        out.push({ time: f * hop, kind: 'accent', type: 'break', label: 'Break' });
        out.push({ time: g * hop, kind: 'accent', type: 'back', label: 'Back in' });
      }
      f = g + 1;
    } else {
      f += 4;
    }
  }

  // Risers: brightness and loudness climbing bar by bar into a section that
  // gets louder (or the drop).
  if (bars.length >= 4 && o.bands) {
    const high = bars.map((b) => barMean(o.bands, 3, 2, hop, b.start, b.end));
    const lvl = bars.map((b) => barMean(o.rmsDb, 1, 0, hop, b.start, b.end));
    const order = { low: 0, mid: 1, high: 2 };
    sections.forEach((s, k) => {
      if (k === 0) return;
      const prev = sections[k - 1];
      if (!(s.drop || order[s.level] > order[prev.level])) return;
      const bi = bars.findIndex((b) => b.start >= s.start - 0.05);
      if (bi < 2) return;
      let n = 0;
      while (bi - n - 2 >= 0 && n < 8 && high[bi - n - 1] >= high[bi - n - 2] * 0.98 && lvl[bi - n - 1] >= lvl[bi - n - 2] - 0.5) n++;
      const rise = high[bi - 1] - high[bi - 1 - n];
      if (n >= 2 && rise > 0.15 * Math.max(...high)) {
        out.push({ time: bars[bi - 1 - n].start, kind: 'accent', type: 'riser', label: `Riser (${n + 1} bars)` });
      }
    });
  }

  // The last beat before the drop.
  const drop = sections.find((s) => s.drop);
  if (drop) {
    const before = beats.filter((t) => t < drop.start - 0.05);
    if (before.length) out.push({ time: before[before.length - 1], kind: 'accent', type: 'predrop', label: 'Last beat before the drop' });
  }

  return out.filter((m) => m.time >= 0 && (!duration || m.time < duration)).sort((a, b) => a.time - b.time);
}

// ---------- speech / voice-over phrases ----------

// Phrase starts in a voice-over or interview: speech that follows a pause of
// at least `minPause` seconds. Gaps shorter than the pause (between words and
// syllables) are joined first, so only real pauses split phrases.
export function speechPhrases(o, { minPause = 0.3, minPhrase = 0.25 } = {}) {
  const hop = o.hopTime;
  const floor = percentile(o.rmsDb, 0.9) - 25;
  const runs = [];
  let startF = -1;
  for (let f = 0; f <= o.rmsDb.length; f++) {
    const on = f < o.rmsDb.length && o.rmsDb[f] > floor;
    if (on && startF < 0) startF = f;
    if (!on && startF >= 0) { runs.push([startF * hop, f * hop]); startF = -1; }
  }
  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] < minPause) last[1] = r[1];
    else merged.push([...r]);
  }
  return merged
    .filter(([a, b]) => b - a >= minPhrase)
    .map(([a], i, all) => ({ time: a, pause: i ? a - all[i - 1][1] : a }));
}

// ---------- thorough mode ----------

// Mean onset strength on the beats divided by halfway between them.
export function gridFit(env, hopTime, beats) {
  if (beats.length < 4) return 0;
  const at = (t) => {
    const f = Math.round(t / hopTime);
    let m = 0;
    for (let j = f - 2; j <= f + 2; j++) m = Math.max(m, env[j] ?? 0);
    return m;
  };
  const on = mean(beats.map(at));
  const off = mean(beats.slice(1).map((b, i) => at((b + beats[i]) / 2)));
  return off > 0 ? on / off : on;
}

// Try several grid strictness values (and ±1 % tempo) and keep the grid whose
// beats sit on the strongest onsets. Helps rubato, live and speech material;
// on steady songs the default grid is already the best, so the app runs this
// automatically only when confidence is low.
export function thoroughGrid(env, hopTime, bpm, active, trackBeats, tightnessValues) {
  let best = null;
  for (const tightness of tightnessValues) {
    for (const k of [0.99, 1, 1.01]) {
      const beats = trackBeats(env, hopTime, bpm * k, tightness, active).map((f) => f * hopTime);
      const fit = gridFit(env, hopTime, beats);
      if (!best || fit > best.fit + 1e-9) best = { fit, tightness, bpm: bpm * k };
    }
  }
  return best;
}

// ---------- strongest hits & snapping ----------

// The song's biggest hits: onset peaks ranked by strength, at most `perMinute`
// of them, at least `minGap` seconds apart (the drops and slams you'd cut on).
export function strongestHits(env, hopTime, { perMinute = 12, minGap = 0.4, active = null } = {}) {
  const peaks = [];
  for (let f = 2; f < env.length - 2; f++) {
    const v = env[f];
    if (active && !active[f]) continue;
    if (v > 0 && v >= env[f - 1] && v > env[f + 1] && v >= env[f - 2] && v >= env[f + 2]) peaks.push({ f, v });
  }
  const cap = Math.max(1, Math.round(((env.length * hopTime) / 60) * perMinute));
  const kept = [];
  for (const p of peaks.sort((a, b) => b.v - a.v)) {
    if (kept.length >= cap) break;
    if (kept.every((k) => Math.abs(k.f - p.f) * hopTime >= minGap)) kept.push(p);
  }
  return kept.map((p) => p.f * hopTime).sort((a, b) => a - b);
}

// Move each grid cut onto the real attack when one is close: the strongest
// onset within ±window seconds, if it clearly stands out from its surroundings.
export function snapToHits(markers, env, hopTime, window = 0.06, kinds = new Set(['beat', 'downbeat', 'sub'])) {
  const w = Math.max(1, Math.round(window / hopTime));
  const ctx = Math.round(0.5 / hopTime);
  return markers.map((m) => {
    if (!kinds.has(m.kind)) return m;
    const f = Math.round(m.time / hopTime);
    let best = -1;
    let bestV = 0;
    for (let j = Math.max(0, f - w); j <= Math.min(env.length - 1, f + w); j++) {
      if (env[j] > bestV) { bestV = env[j]; best = j; }
    }
    if (best < 0) return m;
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, f - ctx); j <= Math.min(env.length - 1, f + ctx); j++) { sum += env[j]; n++; }
    return bestV > 2 * (sum / n) ? { ...m, time: best * hopTime } : m;
  });
}
