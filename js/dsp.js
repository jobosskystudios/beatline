// Beat analysis, pure JS so it runs in the browser and under Node tests.
//
// Pipeline:
//   1. onsetEnvelope  – mel-band spectral flux with a loudness knee, plus
//                       per-band envelopes (kick / snare / hat) and loudness
//   2. tempoProfile   – windowed autocorrelation (tempogram) of the envelope
//   3. estimateTempo  – tempogram peak under a log-normal prior around 120 BPM
//   4. trackBeats     – dynamic-programming beat tracker (Ellis 2007)
//   5. pickOnsets     – peak picking for "hit" markers (transients, not grid)
//
// Timing is calibrated so a detected beat lands on the audible attack
// (within a few ms on synthetic drums; see tests/dsp.test.js).

const ANALYSIS_RATE = 22050;
const N_FFT = 1024;
const HOP = 256;
const N_MELS = 64;
const SILENCE_BELOW_DB = 35;
const COMPRESS_DB = 50;

// Mel bands per role, by centre frequency (Hz).
const KICK_MAX = 150;
const SNARE = [150, 3000];
const HAT_MIN = 5000;
const COLOR_SPLIT = [250, 2500]; // waveform colouring: low | mid | high

export function toMono(channels) {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i];
  const k = 1 / channels.length;
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
}

export function decimate(x, sr, target = ANALYSIS_RATE) {
  const factor = Math.max(1, Math.floor(sr / target));
  if (factor === 1) return { x, sr };
  const n = Math.floor(x.length / factor);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const o = i * factor;
    for (let j = 0; j < factor; j++) s += x[o + j];
    y[i] = s / factor;
  }
  return { x: y, sr: sr / factor };
}

export function makeFFT(n) {
  const levels = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  return (re, im) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0; j < half; j++) {
          const k = j * step;
          const a = i + j;
          const b = a + half;
          const tr = re[b] * cos[k] + im[b] * sin[k];
          const ti = im[b] * cos[k] - re[b] * sin[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  };
}

export function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

function normalize(env) {
  let sq = 0;
  for (const v of env) sq += v * v;
  const sd = Math.sqrt(sq / Math.max(1, env.length)) || 1;
  for (let i = 0; i < env.length; i++) env[i] /= sd;
  return env;
}

// Triangular mel filterbank (HTK mel scale) over FFT power bins.
function melBank(nFft, sr, nMels, fMin, fMax) {
  const mel = (f) => 2595 * Math.log10(1 + f / 700);
  const hz = (m) => 700 * (10 ** (m / 2595) - 1);
  const bins = nFft / 2 + 1;
  const pts = [];
  for (let i = 0; i < nMels + 2; i++) pts.push(hz(mel(fMin) + ((mel(fMax) - mel(fMin)) * i) / (nMels + 1)));
  const bank = [];
  for (let m = 0; m < nMels; m++) {
    const [a, c, b] = [pts[m], pts[m + 1], pts[m + 2]];
    const w = [];
    for (let k = 0; k < bins; k++) {
      const f = (k * sr) / nFft;
      const v = f <= a || f >= b ? 0 : f <= c ? (f - a) / (c - a) : (b - f) / (b - c);
      if (v > 0) w.push([k, v]);
    }
    if (!w.length) w.push([Math.min(bins - 1, Math.round((c * nFft) / sr)), 1]);
    bank.push({ w, center: c });
  }
  return bank;
}

export function onsetEnvelope(samples, sampleRate) {
  const { x, sr } = decimate(samples, sampleRate);
  const pad = N_FFT / 2;
  const nFrames = Math.floor(x.length / HOP) + 1;
  const fft = makeFFT(N_FFT);
  const win = hann(N_FFT);
  const bank = melBank(N_FFT, sr, N_MELS, 30, Math.min(8000, sr / 2));
  const inBand = (lo, hi) => bank.map((b) => b.center >= lo && b.center < hi);
  const roles = {
    kick: inBand(0, KICK_MAX),
    snare: inBand(SNARE[0], SNARE[1]),
    hat: inBand(HAT_MIN, Infinity),
    c0: inBand(0, COLOR_SPLIT[0]),
    c1: inBand(COLOR_SPLIT[0], COLOR_SPLIT[1]),
    c2: inBand(COLOR_SPLIT[1], Infinity),
  };
  const count = (mask) => Math.max(1, mask.filter(Boolean).length);

  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const pow = new Float64Array(N_FFT / 2 + 1);
  const S = new Float32Array(nFrames * N_MELS);
  const rmsDb = new Float32Array(nFrames);
  let maxE = 1e-20;
  for (let f = 0; f < nFrames; f++) {
    const start = f * HOP - pad;
    for (let i = 0; i < N_FFT; i++) {
      const s = start + i;
      re[i] = s >= 0 && s < x.length ? x[s] * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    let total = 0;
    for (let k = 0; k < pow.length; k++) { pow[k] = re[k] * re[k] + im[k] * im[k]; total += pow[k]; }
    rmsDb[f] = 10 * Math.log10(total / (N_FFT * N_FFT) + 1e-12);
    for (let m = 0; m < N_MELS; m++) {
      let e = 0;
      for (const [k, v] of bank[m].w) e += pow[k] * v;
      S[f * N_MELS + m] = e;
      if (e > maxE) maxE = e;
    }
  }

  // Log compression with a knee COMPRESS_DB below the loudest band: like dB
  // for the music, but hiss and room tone far below it stay near zero.
  const gamma = 10 ** (COMPRESS_DB / 10) / maxE;
  for (let i = 0; i < S.length; i++) S[i] = Math.log1p(gamma * S[i]);

  const env = new Float32Array(nFrames);
  const out = { kick: new Float32Array(nFrames), snare: new Float32Array(nFrames), hat: new Float32Array(nFrames) };
  const bands = new Float32Array(nFrames * 3);
  for (let f = 0; f < nFrames; f++) {
    const sums = { all: 0, kick: 0, snare: 0, hat: 0 };
    const col = [0, 0, 0];
    for (let m = 0; m < N_MELS; m++) {
      const v = S[f * N_MELS + m];
      col[roles.c0[m] ? 0 : roles.c1[m] ? 1 : 2] += v;
      if (f === 0) continue;
      const d = v - S[(f - 1) * N_MELS + m];
      if (d <= 0) continue;
      sums.all += d;
      if (roles.kick[m]) sums.kick += d;
      if (roles.snare[m]) sums.snare += d;
      if (roles.hat[m]) sums.hat += d;
    }
    bands[f * 3] = col[0] / count(roles.c0);
    bands[f * 3 + 1] = col[1] / count(roles.c1);
    bands[f * 3 + 2] = col[2] / count(roles.c2);
    // Flux peaks about one hop before the audible attack; store it one frame
    // later so frame times line up with what you hear.
    if (f + 1 < nFrames) {
      env[f + 1] = sums.all / N_MELS;
      out.kick[f + 1] = sums.kick / count(roles.kick);
      out.snare[f + 1] = sums.snare / count(roles.snare);
      out.hat[f + 1] = sums.hat / count(roles.hat);
    }
  }

  // Frames this far below the loud parts are silence: no beats, no hits.
  const sorted = Float32Array.from(rmsDb).sort();
  const silenceDb = sorted[Math.floor(sorted.length * 0.95)] - SILENCE_BELOW_DB;
  const active = new Uint8Array(nFrames);
  for (let f = 0; f < nFrames; f++) active[f] = rmsDb[f] > silenceDb ? 1 : 0;

  return {
    env: normalize(env),
    low: normalize(out.kick),
    kick: out.kick,
    snare: normalize(out.snare),
    hat: normalize(out.hat),
    bands,
    rmsDb,
    active,
    hopTime: HOP / sr,
  };
}

// Windowed autocorrelation of the onset envelope, summed over the song.
// acc[lag] is high when beats repeat every `lag` frames.
export function tempoProfile(env, hopTime, { minBpm = 50, maxBpm = 220, winSec = 8 } = {}) {
  const n = env.length;
  const minLag = Math.max(1, Math.floor(60 / (maxBpm * hopTime)));
  const maxLag = Math.max(minLag + 1, Math.min(n - 2, Math.ceil(60 / (minBpm * hopTime))));
  const acc = new Float64Array(maxLag + 2);
  const W = Math.min(n, Math.max(maxLag * 2, Math.round(winSec / hopTime)));
  const step = Math.max(1, Math.floor(W / 4));
  const w = hann(W);
  const seg = new Float64Array(W);
  // Full windows only (a zero-padded tail window skews short songs).
  for (let s0 = 0; s0 + W <= n; s0 += step) {
    for (let i = 0; i < W; i++) seg[i] = env[s0 + i] * w[i];
    let z = 0;
    for (let i = 0; i < W; i++) z += seg[i] * seg[i];
    if (z > 1e-9) {
      for (let lag = Math.max(1, minLag - 1); lag <= maxLag + 1; lag++) {
        let s = 0;
        for (let i = lag; i < W; i++) s += seg[i] * seg[i - lag];
        acc[lag] += s / z;
      }
    }
  }
  return { acc, minLag, maxLag };
}

export const tempoPrior = (bpm, prior = 120, octaves = 1) => Math.exp(-0.5 * (Math.log2(bpm / prior) / octaves) ** 2);

// Sub-frame peak position by parabolic interpolation.
export function refineLag(score, best) {
  const a = score[best - 1] ?? 0;
  const b = score[best];
  const c = score[best + 1] ?? 0;
  const denom = a - 2 * b + c;
  return best > 1 && denom < 0 ? best + (0.5 * (a - c)) / denom : best;
}

export function estimateTempo(env, hopTime, { minBpm = 50, maxBpm = 220, prior = 120 } = {}) {
  const { acc, minLag, maxLag } = tempoProfile(env, hopTime, { minBpm, maxBpm });
  const score = new Float64Array(acc.length);
  for (let lag = Math.max(1, minLag - 1); lag < acc.length; lag++) score[lag] = acc[lag] * tempoPrior(60 / (lag * hopTime), prior);
  let best = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) if (score[lag] > score[best]) best = lag;
  return 60 / (refineLag(score, best) * hopTime);
}

// Pick the metrical level an editor would tap along to. Below 90 BPM, if the
// halfway points between beats carry nearly as much attack as the beats,
// the faster tempo is the real pulse; above 170 BPM, if every other beat is
// much weaker, the slower one is.
export function resolveOctave(env, hopTime, bpm, active = null) {
  const at = (t) => {
    let m = 0;
    for (let j = t - 2; j <= t + 2; j++) m = Math.max(m, env[j] ?? 0);
    return m;
  };
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  if (bpm < 90) {
    const b = trackBeats(env, hopTime, bpm, 100, active);
    const on = mean(b.map(at));
    const mid = mean(b.slice(1).map((f, i) => at(Math.round((f + b[i]) / 2))));
    if (on > 0 && mid / on >= 0.35) return bpm * 2;
  } else if (bpm > 170) {
    const b = trackBeats(env, hopTime, bpm, 100, active);
    const even = mean(b.filter((_, i) => i % 2 === 0).map(at));
    const odd = mean(b.filter((_, i) => i % 2 === 1).map(at));
    if (Math.min(even, odd) / Math.max(even, odd, 1e-9) < 0.45) return bpm / 2;
  }
  return bpm;
}

export function trackBeats(env, hopTime, bpm, tightness = 100, active = null) {
  const n = env.length;
  const period = 60 / (bpm * hopTime);
  if (!(period > 1) || n < 2) return [];

  // Local score: envelope smoothed by a Gaussian a fraction of a beat wide.
  const radius = Math.max(1, Math.round(period));
  const sigma = Math.max(1, period / 32);
  const kernel = [];
  for (let i = -radius; i <= radius; i++) kernel.push(Math.exp(-0.5 * (i / sigma) ** 2));
  const local = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    let s = 0;
    for (let i = -radius; i <= radius; i++) {
      const j = t + i;
      if (j >= 0 && j < n) s += env[j] * kernel[i + radius];
    }
    local[t] = s;
  }

  const cum = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const minGap = Math.max(1, Math.round(period / 2));
  const maxGap = Math.round(2 * period);
  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    let arg = -1;
    for (let d = minGap; d <= maxGap; d++) {
      const p = t - d;
      if (p < 0) break;
      const c = cum[p] - tightness * Math.log(d / period) ** 2;
      if (c > best) { best = c; arg = p; }
    }
    if (arg >= 0 && best > 0) {
      cum[t] = local[t] + best;
      back[t] = arg;
    } else {
      cum[t] = local[t];
    }
  }

  // Last beat: the last local maximum of the cumulative score that is
  // reasonably strong (guards against fading tails).
  const peaks = [];
  for (let t = 1; t < n - 1; t++) if (cum[t] >= cum[t - 1] && cum[t] > cum[t + 1]) peaks.push(t);
  if (!peaks.length) return [];
  const sorted = peaks.map((t) => cum[t]).sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)];
  let end = peaks[peaks.length - 1];
  for (let i = peaks.length - 1; i >= 0; i--) {
    if (cum[peaks[i]] >= 0.5 * median) { end = peaks[i]; break; }
  }

  const beats = [];
  for (let t = end; t >= 0; t = back[t]) beats.push(t);
  beats.reverse();

  // Trim beats at the edges that sit on silence or on nothing at all.
  let sq = 0;
  for (const v of local) sq += v * v;
  const thr = 0.35 * Math.sqrt(sq / n);
  const weak = (f) => local[f] < thr || (active && !active[f]);
  let s = 0;
  let e = beats.length;
  while (s < e && weak(beats[s])) s++;
  while (e > s && weak(beats[e - 1])) e--;
  return beats.slice(s, e);
}

// Simple downbeat guess from bass energy alone (analysis.js has the full one).
export function downbeatPhase(beatFrames, low, beatsPerBar) {
  if (beatsPerBar <= 1 || !beatFrames.length) return 0;
  const sums = new Float64Array(beatsPerBar);
  const counts = new Float64Array(beatsPerBar);
  beatFrames.forEach((f, i) => {
    let v = 0;
    for (let j = f - 2; j <= f + 2; j++) if (j >= 0 && j < low.length) v = Math.max(v, low[j]);
    sums[i % beatsPerBar] += v;
    counts[i % beatsPerBar]++;
  });
  let best = 0;
  for (let p = 1; p < beatsPerBar; p++) {
    if (sums[p] / (counts[p] || 1) > sums[best] / (counts[best] || 1)) best = p;
  }
  return best;
}

export function pickOnsets(env, hopTime, sensitivity = 0.5, minGapSec = 0.08, active = null) {
  const n = env.length;
  const w = 3;
  const avgW = 12;
  const delta = 0.1 + (1 - sensitivity) * 2;
  const minGap = Math.max(1, Math.round(minGapSec / hopTime));
  const out = [];
  let last = -Infinity;
  for (let t = 0; t < n; t++) {
    const v = env[t];
    let isMax = true;
    for (let j = Math.max(0, t - w); j <= Math.min(n - 1, t + w); j++) {
      if (env[j] > v) { isMax = false; break; }
    }
    if (!isMax || (active && !active[t])) continue;
    let sum = 0;
    let cnt = 0;
    for (let j = Math.max(0, t - avgW); j <= Math.min(n - 1, t + avgW); j++) { sum += env[j]; cnt++; }
    if (v > sum / cnt + delta && t - last >= minGap) {
      out.push(t * hopTime);
      last = t;
    }
  }
  return out;
}

// Hits use whichever band moved most, so bass-only kicks still register.
export function hitEnvelope(env, low) {
  const out = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) out[i] = Math.max(env[i], low[i]);
  return out;
}

// One-shot analysis. Keep the returned envelopes around: re-tracking with a
// different BPM or strictness only needs trackBeats(), not a new FFT pass.
export function analyze(samples, sampleRate, opts = {}) {
  const o = onsetEnvelope(samples, sampleRate);
  const bpm = opts.bpm > 0 ? opts.bpm : resolveOctave(o.env, o.hopTime, estimateTempo(o.env, o.hopTime, opts), o.active);
  const frames = trackBeats(o.env, o.hopTime, bpm, opts.tightness ?? 100, o.active);
  return {
    ...o,
    bpm,
    beatFrames: frames,
    beats: frames.map((f) => f * o.hopTime),
    phase: downbeatPhase(frames, o.low, opts.beatsPerBar ?? 4),
    onsets: pickOnsets(hitEnvelope(o.env, o.low), o.hopTime, opts.sensitivity ?? 0.5, 0.08, o.active),
  };
}
