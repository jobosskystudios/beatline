// "Understand the song" layer on top of dsp.js: how sure we are about the
// tempo, how steady it is, the time signature and bar start, key, loudness,
// where the music starts and ends, and individual drum hits.
import { makeFFT, hann, decimate, tempoProfile, pickOnsets, toMono, onsetEnvelope, estimateTempo, resolveOctave, trackBeats } from './dsp.js';

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const zscore = (a) => {
  const m = mean(a);
  const sd = Math.sqrt(mean(a.map((v) => (v - m) ** 2))) || 1;
  return a.map((v) => (v - m) / sd);
};
const peakNear = (env, f, r = 2) => {
  let m = 0;
  for (let j = f - r; j <= f + r; j++) m = Math.max(m, env[j] ?? 0);
  return m;
};

// ---------- tempo ----------

// How strongly the envelope repeats at the beat period, per 8 s window
// (median of windows). Steady music scores 0.2–0.7; speech and rubato
// classical score under 0.1.
export function periodicity(env, hopTime, bpm) {
  const lag = Math.round(60 / bpm / hopTime);
  const W = Math.min(env.length, Math.round(8 / hopTime));
  const vals = [];
  for (let s0 = 0; s0 + W <= env.length; s0 += Math.floor(W / 2)) {
    let m = 0;
    for (let i = 0; i < W; i++) m += env[s0 + i];
    m /= W;
    let z = 0;
    for (let i = 0; i < W; i++) z += (env[s0 + i] - m) ** 2;
    if (z < 1e-9) continue;
    let best = -1;
    for (let d = -2; d <= 2; d++) {
      let q = 0;
      for (let i = lag + d; i < W; i++) q += (env[s0 + i] - m) * (env[s0 + i - lag - d] - m);
      best = Math.max(best, q / z);
    }
    vals.push(best);
  }
  return Math.max(0, median(vals));
}

export function confidenceLevel(p) {
  return p >= 0.2 ? 'high' : p >= 0.12 ? 'medium' : 'low';
}

// The detected tempo plus the musically related alternatives an editor might
// prefer (half, double, and 2/3 or 3/2 for swing and triplet feels), each
// with its relative strength in the tempogram.
export function tempoCandidates(env, hopTime, bpm) {
  const { acc, minLag, maxLag } = tempoProfile(env, hopTime, { minBpm: 40, maxBpm: 260 });
  const strengthAt = (b) => {
    const lag = 60 / (b * hopTime);
    const i = Math.round(lag);
    if (i < minLag - 1 || i > maxLag + 1) return 0;
    return Math.max(acc[i - 1] ?? 0, acc[i] ?? 0, acc[i + 1] ?? 0);
  };
  const base = strengthAt(bpm) || 1;
  const rel = [
    { ratio: 0.5, label: '½×' },
    { ratio: 2 / 3, label: '⅔×' },
    { ratio: 1.5, label: '1.5×' },
    { ratio: 2, label: '2×' },
  ];
  return [
    { bpm, label: 'Detected', strength: 1 },
    ...rel
      .map((r) => ({ bpm: bpm * r.ratio, label: r.label, strength: strengthAt(bpm * r.ratio) / base }))
      .filter((c) => c.bpm >= 40 && c.bpm <= 260),
  ];
}

// Tempo over time from the tracked beats: steady (click track, programmed)
// vs. drifting (live band) vs. changing (tempo changes / rubato).
export function tempoStability(beats) {
  if (beats.length < 8) return { kind: 'unknown', min: 0, max: 0, cv: 0, curve: [] };
  const ibi = beats.slice(1).map((b, i) => b - beats[i]);
  const m = mean(ibi);
  const cv = Math.sqrt(mean(ibi.map((v) => (v - m) ** 2))) / m;
  // Local tempo over 8-beat windows.
  const curve = [];
  for (let i = 0; i + 8 < beats.length; i += 4) {
    curve.push({ time: beats[i], bpm: 60 / median(ibi.slice(i, i + 8)) });
  }
  const bpms = curve.map((c) => c.bpm);
  const min = Math.min(...bpms);
  const max = Math.max(...bpms);
  const spread = (max - min) / median(bpms);
  const kind = spread > 0.08 ? 'changing' : cv > 0.04 ? 'live' : 'steady';
  return { kind, min, max, cv, curve };
}

// ---------- harmony: chroma, key ----------

const CHROMA_RATE = 11025;
const CHROMA_FFT = 4096;
const CHROMA_HOP = 2048;

export function chromagram(mono, sampleRate) {
  const { x, sr } = decimate(mono, sampleRate, CHROMA_RATE);
  const fft = makeFFT(CHROMA_FFT);
  const win = hann(CHROMA_FFT);
  const re = new Float64Array(CHROMA_FFT);
  const im = new Float64Array(CHROMA_FFT);
  // Map FFT bins (55 Hz – 2 kHz) to pitch classes.
  const map = [];
  for (let k = 1; k < CHROMA_FFT / 2; k++) {
    const f = (k * sr) / CHROMA_FFT;
    if (f < 55 || f > 2000) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    map.push([k, ((Math.round(midi) % 12) + 12) % 12]);
  }
  const n = Math.max(1, Math.floor((x.length - CHROMA_FFT) / CHROMA_HOP) + 1);
  const frames = new Float32Array(n * 12);
  for (let t = 0; t < n; t++) {
    const o = t * CHROMA_HOP;
    for (let i = 0; i < CHROMA_FFT; i++) { re[i] = (x[o + i] ?? 0) * win[i]; im[i] = 0; }
    fft(re, im);
    let norm = 0;
    for (const [k, pc] of map) {
      const v = Math.log1p(100 * Math.hypot(re[k], im[k]));
      frames[t * 12 + pc] += v;
    }
    for (let c = 0; c < 12; c++) norm = Math.max(norm, frames[t * 12 + c]);
    if (norm > 0) for (let c = 0; c < 12; c++) frames[t * 12 + c] /= norm;
  }
  return { frames, n, hopTime: CHROMA_HOP / sr };
}

// Average chroma between consecutive beats.
export function beatChroma(chroma, beats, duration) {
  const out = [];
  const edges = [...beats, duration];
  for (let i = 0; i < beats.length; i++) {
    const a = Math.floor(edges[i] / chroma.hopTime);
    const b = Math.max(a + 1, Math.floor(edges[i + 1] / chroma.hopTime));
    const v = new Float32Array(12);
    let cnt = 0;
    for (let t = a; t < Math.min(b, chroma.n); t++, cnt++) for (let c = 0; c < 12; c++) v[c] += chroma.frames[t * 12 + c];
    if (cnt) for (let c = 0; c < 12; c++) v[c] /= cnt;
    out.push(v);
  }
  return out;
}

const NOTE = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
// Krumhansl–Kessler key profiles.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
// Camelot wheel numbers for major keys by tonic pitch class; minor = relative.
const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];

function corr(a, b) {
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db || 1);
}

export function detectKey(chroma) {
  const total = new Array(12).fill(0);
  for (let t = 0; t < chroma.n; t++) for (let c = 0; c < 12; c++) total[c] += chroma.frames[t * 12 + c];
  const scores = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    const rot = (p) => p.map((_, i) => p[(i - tonic + 12) % 12]);
    scores.push({ tonic, mode: 'major', r: corr(total, rot(MAJOR)) });
    scores.push({ tonic, mode: 'minor', r: corr(total, rot(MINOR)) });
  }
  scores.sort((a, b) => b.r - a.r);
  const best = scores[0];
  const camelot = best.mode === 'major'
    ? `${CAMELOT_MAJOR[best.tonic]}B`
    : `${CAMELOT_MAJOR[(best.tonic + 3) % 12]}A`;
  return {
    name: `${NOTE[best.tonic]} ${best.mode}`,
    camelot,
    confidence: best.r - scores[1].r,
  };
}

// ---------- meter & downbeat ----------

// Bar starts usually bring a kick and a chord change. Score each beat by bass
// attack plus harmonic change, then pick the beats-per-bar and phase where
// those strong beats line up.
export function detectMeter(beatFrames, low, chromaPerBeat, { candidates = [3, 4] } = {}) {
  const n = beatFrames.length;
  if (n < 12) return { beatsPerBar: 4, phase: 0, confidence: 0, alternatives: [] };
  const bass = zscore(beatFrames.map((f) => peakNear(low, f)));
  const change = zscore(chromaPerBeat.map((c, i) => {
    if (i === 0) return 0;
    const p = chromaPerBeat[i - 1];
    let d = 0;
    let na = 0;
    let nb = 0;
    for (let k = 0; k < 12; k++) { d += c[k] * p[k]; na += c[k] * c[k]; nb += p[k] * p[k]; }
    return 1 - d / Math.sqrt(na * nb || 1);
  }));
  const novelty = bass.map((v, i) => v + change[i]);
  const results = candidates.map((bpb) => {
    const sums = new Array(bpb).fill(0);
    const cnt = new Array(bpb).fill(0);
    novelty.forEach((v, i) => { sums[i % bpb] += v; cnt[i % bpb]++; });
    const avg = sums.map((s, p) => s / (cnt[p] || 1));
    const phase = avg.indexOf(Math.max(...avg));
    const others = avg.filter((_, p) => p !== phase);
    // How much the chosen downbeat stands out from the other beats.
    return { beatsPerBar: bpb, phase, contrast: avg[phase] - mean(others) };
  });
  results.sort((a, b) => b.contrast - a.contrast);
  const [best, next] = results;
  return {
    beatsPerBar: best.beatsPerBar,
    phase: best.phase,
    confidence: Math.max(0, best.contrast - (next?.contrast ?? 0)),
    alternatives: results,
  };
}

// ---------- loudness (ITU-R BS.1770 / EBU R128, integrated) ----------

function biquad(x, b0, b1, b2, a1, a2) {
  const y = new Float32Array(x.length);
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

// K-weighting filter coefficients for any sample rate (as in pyloudnorm).
function kWeight(x, sr) {
  // Stage 1: high shelf, +4 dB around 1.7 kHz.
  let G = 3.99984385397;
  let Q = 0.7071752369554193;
  let fc = 1681.974450955533;
  let K = Math.tan((Math.PI * fc) / sr);
  let Vh = 10 ** (G / 20);
  let Vb = Vh ** 0.499666774155;
  let a0 = 1 + K / Q + K * K;
  const s1 = biquad(x, (Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0);
  // Stage 2: high pass around 38 Hz.
  Q = 0.5003270373253953;
  fc = 38.13547087613982;
  K = Math.tan((Math.PI * fc) / sr);
  a0 = 1 + K / Q + K * K;
  return biquad(s1, 1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0);
}

export function loudness(channels, sr) {
  let peak = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) { const v = Math.abs(ch[i]); if (v > peak) peak = v; }
  const weighted = channels.slice(0, 2).map((ch) => kWeight(ch, sr));
  const block = Math.round(0.4 * sr);
  const step = Math.round(0.1 * sr);
  const blocks = [];
  for (let s = 0; s + block <= weighted[0].length; s += step) {
    let z = 0;
    for (const ch of weighted) {
      let e = 0;
      for (let i = s; i < s + block; i++) e += ch[i] * ch[i];
      z += e / block;
    }
    blocks.push(z);
  }
  const lufs = (zs) => -0.691 + 10 * Math.log10(mean(zs) || 1e-12);
  const abs = blocks.filter((z) => -0.691 + 10 * Math.log10(z) > -70);
  const rel = lufs(abs) - 10;
  const gated = abs.filter((z) => -0.691 + 10 * Math.log10(z) > rel);
  return {
    lufs: gated.length ? lufs(gated) : -Infinity,
    peakDb: 20 * Math.log10(peak || 1e-12),
  };
}

// ---------- span & drums ----------

export function musicSpan(active, hopTime) {
  let a = 0;
  let b = active.length - 1;
  while (a < b && !active[a]) a++;
  while (b > a && !active[b]) b--;
  return { start: a * hopTime, end: b * hopTime };
}

export function drumHits(o, sensitivity = 0.5) {
  return {
    kick: pickOnsets(o.kick, o.hopTime, sensitivity, 0.1, o.active),
    snare: pickOnsets(o.snare, o.hopTime, sensitivity, 0.1, o.active),
    hat: pickOnsets(o.hat, o.hopTime, sensitivity, 0.06, o.active),
  };
}

// ---------- everything at once ----------

// Full analysis of a decoded song. Runs in a worker (js/worker.js) or inline.
export function analyzeSong({ channels, sampleRate }) {
  const mono = toMono(channels);
  const duration = mono.length / sampleRate;
  const o = onsetEnvelope(mono, sampleRate);
  const bpm = resolveOctave(o.env, o.hopTime, estimateTempo(o.env, o.hopTime), o.active);
  const beatFrames = trackBeats(o.env, o.hopTime, bpm, 100, o.active);
  const beats = beatFrames.map((f) => f * o.hopTime);
  const chroma = chromagram(mono, sampleRate);
  const meter = detectMeter(beatFrames, o.low, beatChroma(chroma, beats, duration));
  const p = periodicity(o.env, o.hopTime, bpm);
  return {
    o,
    bpm,
    beatFrames,
    chroma,
    drums: drumHits(o),
    info: {
      periodicity: p,
      confidence: confidenceLevel(p),
      candidates: tempoCandidates(o.env, o.hopTime, bpm),
      stability: tempoStability(beats),
      meter,
      key: detectKey(chroma),
      loudness: loudness(channels, sampleRate),
      span: musicSpan(o.active, o.hopTime),
    },
  };
}
