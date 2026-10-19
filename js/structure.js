// Song structure: bars, energy per bar, and sections an editor can pace by.

export const LEVEL_LABEL = { low: 'Calm', mid: 'Groove', high: 'Peak' };

// Bars start on downbeats. Beats before the first downbeat belong to a pickup
// that the first section absorbs.
export function barGrid(beats, phase, beatsPerBar, duration) {
  const bars = [];
  for (let i = phase; i < beats.length; i += beatsPerBar) bars.push({ bar: bars.length + 1, start: beats[i] });
  const lens = bars.slice(1).map((b, k) => b.start - bars[k].start).sort((a, b) => a - b);
  const typical = lens.length ? lens[Math.floor(lens.length / 2)] : duration;
  bars.forEach((b, k) => {
    b.end = k + 1 < bars.length ? bars[k + 1].start : Math.min(duration, b.start + typical);
  });
  return bars;
}

function rmsDb(x, sr, start, end) {
  const a = Math.max(0, Math.floor(start * sr));
  const b = Math.min(x.length, Math.floor(end * sr));
  if (b <= a) return -100;
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return 10 * Math.log10(s / (b - a) + 1e-10);
}

const median3 = (v) => v.map((_, i) => [v[i - 1] ?? v[i], v[i], v[i + 1] ?? v[i]].sort((p, q) => p - q)[1]);

// Classify each bar as low / mid / high energy, then merge into sections of
// at least `minBars` bars.
export function detectSections(mono, sr, bars, duration, { minBars = 2 } = {}) {
  if (!bars.length) return [{ start: 0, end: duration, firstBar: 0, lastBar: 0, bars: 0, level: 'mid', db: 0, label: 'Song', drop: false }];
  const db = median3(bars.map((b) => rmsDb(mono, sr, b.start, b.end)));
  const sorted = [...db].sort((p, q) => p - q);
  const lo = sorted[Math.floor(sorted.length * 0.05)];
  const hi = sorted[Math.floor(sorted.length * 0.95)];
  const span = hi - lo;
  const level = (v) => (span < 4 ? 'mid' : v < lo + span / 3 ? 'low' : v < lo + (2 * span) / 3 ? 'mid' : 'high');

  // Runs of equal level.
  let runs = [];
  db.forEach((v, i) => {
    const l = level(v);
    const last = runs[runs.length - 1];
    if (last && last.level === l) last.to = i;
    else runs.push({ level: l, from: i, to: i });
  });
  // Absorb short runs into a neighbour, shortest first, until all are long enough.
  for (;;) {
    const short = runs
      .map((r, i) => ({ i, n: r.to - r.from + 1 }))
      .filter((r) => r.n < minBars && runs.length > 1)
      .sort((p, q) => p.n - q.n)[0];
    if (!short) break;
    const r = runs[short.i];
    const prev = runs[short.i - 1];
    const next = runs[short.i + 1];
    const into = !prev ? next : !next ? prev : prev.to - prev.from >= next.to - next.from ? prev : next;
    into.from = Math.min(into.from, r.from);
    into.to = Math.max(into.to, r.to);
    runs.splice(short.i, 1);
    // Neighbours may now share a level.
    runs = runs.reduce((acc, x) => {
      const last = acc[acc.length - 1];
      if (last && last.level === x.level) last.to = x.to;
      else acc.push(x);
      return acc;
    }, []);
  }

  const sections = runs.map((r, k) => {
    const slice = db.slice(r.from, r.to + 1);
    return {
      start: k === 0 ? 0 : bars[r.from].start,
      end: k === runs.length - 1 ? duration : bars[runs[k + 1].from].start,
      firstBar: bars[r.from].bar,
      lastBar: bars[r.to].bar,
      bars: r.to - r.from + 1,
      level: r.level,
      db: slice.reduce((a, b) => a + b, 0) / slice.length,
      drop: false,
    };
  });

  // The drop: the biggest jump up into a high-energy section.
  let best = -1;
  let bestJump = 3;
  sections.forEach((s, k) => {
    if (k > 0 && s.level === 'high' && s.db - sections[k - 1].db > bestJump) { best = k; bestJump = s.db - sections[k - 1].db; }
  });
  if (best >= 0) sections[best].drop = true;

  sections.forEach((s, k) => {
    s.label =
      s.drop ? 'Drop'
      : k === 0 && s.level === 'low' ? 'Intro'
      : k === sections.length - 1 && s.level === 'low' && k > 0 ? 'Outro'
      : LEVEL_LABEL[s.level];
  });
  return sections;
}

export function sectionAt(sections, t) {
  let s = sections[0];
  for (const x of sections) if (x.start <= t + 1e-6) s = x;
  return s;
}

export function sectionMarkers(sections) {
  return sections.map((s, k) => ({ time: s.start, kind: 'section', label: `${k + 1}. ${s.label} (bars ${s.firstBar}–${s.lastBar})` }));
}
