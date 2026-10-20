// Cut a song to a target length the way an editor would: keep the start,
// jump on a bar line to the song's real ending, and pick the jump where the
// harmony on both sides matches so the seam is hard to hear.

const cosine = (a, b) => {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
};

/**
 * bars: [{ bar, start, end }], barChroma: one 12-vector per bar,
 * duration: song length, target: seconds. Returns null when no edit is needed.
 * Result: { segments: [{ start, end }], length, seam: { from, to, fromBar, toBar, match } }
 */
export function planMusicEdit({ bars, barChroma, duration, target, phrase = 4, sections = [] }) {
  if (!bars.length || target >= duration - 0.5) return null;
  const ends = bars.map((b) => b.start);
  const sectionStarts = new Set(sections.map((s) => s.start));
  const isPhrase = (i) => (bars[i].bar - 1) % phrase === 0 || sectionStarts.has(bars[i].start);
  let best = null;
  // `h`: the head ends where bar h starts. `t`: the tail starts at bar t and
  // runs to the end of the song (keeping the real ending).
  for (let t = 1; t < bars.length; t++) {
    const tail = duration - bars[t].start;
    if (tail > target) continue;
    for (let h = 0; h <= t; h++) {
      const head = ends[h];
      const len = head + tail;
      const err = Math.abs(len - target) / target;
      if (err > 0.12) continue;
      // Harmony just before the seam vs. just before the tail would have played.
      const match = h > 0 && t > 0 ? cosine(barChroma[h - 1], barChroma[t - 1]) * 0.5 + cosine(barChroma[h], barChroma[t]) * 0.5 : 0.5;
      const score = err * 8 + (1 - match) * 3 + (isPhrase(h) ? 0 : 0.6) + (isPhrase(t) ? 0 : 0.6) + (h === 0 ? 1 : 0);
      if (!best || score < best.score) best = { h, t, score, match, len };
    }
  }
  if (!best) {
    // Too short for head + ending: take the opening and end on a bar line.
    let h = bars.findIndex((b) => b.start >= target);
    if (h < 0) h = bars.length - 1;
    return { segments: [{ start: 0, end: bars[h].start }], length: bars[h].start, seam: null, fadeOut: true };
  }
  const { h, t } = best;
  const segments = h === 0 ? [{ start: bars[t].start, end: duration }] : [{ start: 0, end: bars[h].start }, { start: bars[t].start, end: duration }];
  return {
    segments,
    length: segments.reduce((s, x) => s + x.end - x.start, 0),
    seam: h === 0 ? null : { from: bars[h].start, to: bars[t].start, fromBar: bars[h].bar, toBar: bars[t].bar, match: best.match },
  };
}

// Mean chroma per bar from beat-level chroma (one vector per beat).
export function barChromaFromBeats(beatChromaList, beats, bars) {
  return bars.map((b) => {
    const v = new Float32Array(12);
    let n = 0;
    beats.forEach((t, i) => {
      if (t >= b.start - 1e-3 && t < b.end - 1e-3 && beatChromaList[i]) {
        for (let k = 0; k < 12; k++) v[k] += beatChromaList[i][k];
        n++;
      }
    });
    if (n) for (let k = 0; k < 12; k++) v[k] /= n;
    return v;
  });
}

// Map a song time to the edited timeline (null when it was cut out).
export function mapToEdit(segments, t) {
  let offset = 0;
  for (const s of segments) {
    if (t >= s.start && t < s.end) return offset + (t - s.start);
    offset += s.end - s.start;
  }
  return null;
}

// Render the edit with short equal-power crossfades at each seam.
export function renderEdit(channels, sampleRate, segments, { fadeMs = 30, fadeOut = false } = {}) {
  const fade = Math.round((fadeMs / 1000) * sampleRate);
  const pieces = segments.map((s) => [Math.round(s.start * sampleRate), Math.round(s.end * sampleRate)]);
  const length = pieces.reduce((n, [a, b]) => n + (b - a), 0) - fade * (pieces.length - 1);
  const out = channels.map(() => new Float32Array(Math.max(0, length)));
  channels.forEach((ch, c) => {
    let pos = 0;
    pieces.forEach(([a, b], i) => {
      const n = b - a;
      for (let j = 0; j < n; j++) {
        const dst = pos + j;
        if (dst >= out[c].length) break;
        let g = 1;
        if (i > 0 && j < fade) g = Math.sin((Math.PI / 2) * (j / fade));
        if (i < pieces.length - 1 && j >= n - fade) g = Math.cos((Math.PI / 2) * ((j - (n - fade)) / fade));
        out[c][dst] += ch[a + j] * g;
      }
      pos += n - fade;
    });
    if (fadeOut) {
      const len = Math.min(out[c].length, Math.round(1.5 * sampleRate));
      for (let j = 0; j < len; j++) out[c][out[c].length - len + j] *= 1 - j / len;
    }
  });
  return out;
}

// 16-bit PCM WAV.
export function encodeWav(channels, sampleRate) {
  const n = channels[0]?.length ?? 0;
  const ch = channels.length;
  const buf = new ArrayBuffer(44 + n * ch * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * ch * 2, true);
  v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * ch * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return buf;
}
