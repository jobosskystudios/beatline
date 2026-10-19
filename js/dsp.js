// Beat analysis, pure JS so it runs in the browser and under Node tests.
//
// Pipeline:
//   1. onsetEnvelope  – log-magnitude spectral flux (full band + bass band)
//   2. estimateTempo  – autocorrelation of the envelope with a tempo prior
//   3. trackBeats     – dynamic-programming beat tracker (Ellis 2007)
//   4. downbeatPhase  – which beat of the bar carries the most bass energy
//   5. pickOnsets     – peak picking for "hit" markers (transients, not grid)

const ANALYSIS_RATE = 22050;
const N_FFT = 1024;
const HOP = 256;
const LOW_HZ = 150;

export function toMono(channels) {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i];
  const k = 1 / channels.length;
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
}

function decimate(x, sr) {
  const factor = Math.max(1, Math.floor(sr / ANALYSIS_RATE));
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

function makeFFT(n) {
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

function detrend(env, radius) {
  const n = env.length;
  const out = new Float32Array(n);
  let sum = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < n; i++) {
    while (hi < Math.min(n - 1, i + radius)) sum += env[++hi];
    while (lo < i - radius) sum -= env[lo++];
    out[i] = Math.max(0, env[i] - sum / (hi - lo + 1));
  }
  return out;
}

function normalize(env) {
  let sq = 0;
  for (const v of env) sq += v * v;
  const sd = Math.sqrt(sq / Math.max(1, env.length)) || 1;
  for (let i = 0; i < env.length; i++) env[i] /= sd;
  return env;
}

export function onsetEnvelope(samples, sampleRate) {
  const { x, sr } = decimate(samples, sampleRate);
  const pad = N_FFT / 2;
  const nFrames = Math.floor(x.length / HOP) + 1;
  const fft = makeFFT(N_FFT);
  const win = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);
  const bins = N_FFT / 2 + 1;
  const lowBins = Math.max(2, Math.round((LOW_HZ * N_FFT) / sr));
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  let prev = new Float64Array(bins);
  let cur = new Float64Array(bins);
  const env = new Float32Array(nFrames);
  const low = new Float32Array(nFrames);

  for (let f = 0; f < nFrames; f++) {
    const start = f * HOP - pad;
    for (let i = 0; i < N_FFT; i++) {
      const s = start + i;
      re[i] = s >= 0 && s < x.length ? x[s] * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    let flux = 0;
    let lowFlux = 0;
    for (let k = 0; k < bins; k++) {
      cur[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      const d = cur[k] - prev[k];
      if (f > 0 && d > 0) {
        flux += d;
        if (k < lowBins) lowFlux += d;
      }
    }
    env[f] = flux;
    low[f] = lowFlux;
    const t = prev; prev = cur; cur = t;
  }
  return {
    env: normalize(detrend(env, 8)),
    low: normalize(detrend(low, 8)),
    hopTime: HOP / sr,
  };
}

export function estimateTempo(env, hopTime, { minBpm = 60, maxBpm = 200, prior = 120 } = {}) {
  const n = env.length;
  const minLag = Math.max(1, Math.floor(60 / (maxBpm * hopTime)));
  const maxLag = Math.min(n - 2, Math.ceil(60 / (minBpm * hopTime)));
  if (maxLag <= minLag) return prior;
  const score = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    if (lag < 1) continue;
    let s = 0;
    for (let i = lag; i < n; i++) s += env[i] * env[i - lag];
    const bpm = 60 / (lag * hopTime);
    const w = Math.exp(-0.5 * (Math.log2(bpm / prior) / 0.9) ** 2);
    score[lag] = (s / (n - lag)) * w;
  }
  let best = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) if (score[lag] > score[best]) best = lag;
  // Parabolic interpolation for sub-frame lag precision.
  let lag = best;
  const a = score[best - 1] ?? 0;
  const b = score[best];
  const c = score[best + 1] ?? 0;
  const denom = a - 2 * b + c;
  if (best > 1 && denom < 0) lag = best + (0.5 * (a - c)) / denom;
  return 60 / (lag * hopTime);
}

export function trackBeats(env, hopTime, bpm, tightness = 100) {
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

  // Trim weak beats at the edges (silence before/after the music).
  let sq = 0;
  for (const v of local) sq += v * v;
  const thr = 0.5 * Math.sqrt(sq / n);
  let s = 0;
  let e = beats.length;
  while (s < e && local[beats[s]] < thr) s++;
  while (e > s && local[beats[e - 1]] < thr) e--;
  return beats.slice(s, e);
}

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

export function pickOnsets(env, hopTime, sensitivity = 0.5, minGapSec = 0.08) {
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
    if (!isMax) continue;
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

// One-shot analysis. Keep the returned envelope around: re-tracking with a
// different BPM or strictness only needs trackBeats(), not a new FFT pass.
export function analyze(samples, sampleRate, opts = {}) {
  const { env, low, hopTime } = onsetEnvelope(samples, sampleRate);
  const bpm = opts.bpm > 0 ? opts.bpm : estimateTempo(env, hopTime, opts);
  const frames = trackBeats(env, hopTime, bpm, opts.tightness ?? 100);
  return {
    env,
    low,
    hopTime,
    bpm,
    beatFrames: frames,
    beats: frames.map((f) => f * hopTime),
    phase: downbeatPhase(frames, low, opts.beatsPerBar ?? 4),
    onsets: pickOnsets(hitEnvelope(env, low), hopTime, opts.sensitivity ?? 0.5),
  };
}
