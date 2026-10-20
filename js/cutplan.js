// Cut plan: every cut marker on the timeline becomes an edit point; the spans
// between them are the shots an editor has to fill.
//
// Times here are *timeline* times: the song as it will play in the edit (a
// range of it, or a music edit made of several pieces). `songTimeAt` maps a
// timeline time back to the song for section lookups.
import { toFrame } from './fcpxml.js';
import { sectionAt } from './structure.js';

export const CUT_KINDS = new Set(['beat', 'downbeat', 'hit', 'manual', 'kick', 'snare', 'hat', 'sub', 'phrase']);

export function planCuts({ markers, rate, rounding, inFrame, outFrame, minShotFrames = 1, sections = [], songTimeAt = (t) => t }) {
  const frames = [...new Set(
    markers.filter((m) => CUT_KINDS.has(m.kind)).map((m) => toFrame(m.time, rate, rounding)),
  )].filter((f) => f > inFrame && f < outFrame).sort((a, b) => a - b);

  const min = Math.max(1, minShotFrames);
  const cuts = [];
  let prev = inFrame;
  for (const f of frames) {
    if (f - prev >= min) { cuts.push(f); prev = f; }
  }
  if (cuts.length && outFrame - cuts[cuts.length - 1] < min) cuts.pop();

  const sec = (f) => (f * rate.num) / rate.den;
  const bounds = [inFrame, ...cuts, outFrame];
  const shots = bounds.slice(1).map((end, i) => {
    const start = bounds[i];
    const s = sections.length ? sectionAt(sections, songTimeAt(sec(start))) : null;
    return { index: i + 1, start, end, frames: end - start, seconds: sec(end - start), section: s };
  });
  const lengthSec = sec(outFrame - inFrame);
  const lens = shots.map((s) => s.seconds);
  return {
    cuts,
    shots,
    stats: {
      cuts: cuts.length,
      dropped: frames.length - cuts.length,
      shots: shots.length,
      lengthSec,
      avgShot: lengthSec / Math.max(1, shots.length),
      cutsPerMin: lengthSec > 0 ? cuts.length / (lengthSec / 60) : 0,
      shortest: Math.min(...lens),
      longest: Math.max(...lens),
    },
  };
}

// Per-section summary. `segments` are the song pieces on the timeline, in
// song seconds ({ start, end }); the default is a range [inFrame, outFrame).
export function sectionSummary(sections, plan, rate, inFrame, outFrame, segments = null) {
  const sec = (f) => (f * rate.num) / rate.den;
  const pieces = segments ?? [{ start: sec(inFrame), end: sec(outFrame) }];
  // Timeline offset of each piece.
  let acc = segments ? 0 : sec(inFrame);
  const placed = pieces.map((p) => { const o = acc; acc += p.end - p.start; return { ...p, offset: o }; });
  return sections
    .map((s, k) => {
      let length = 0;
      let cuts = 0;
      let first = null;
      for (const p of placed) {
        const a = Math.max(s.start, p.start);
        const b = Math.min(s.end, p.end);
        if (b <= a) continue;
        const ta = p.offset + (a - p.start);
        const tb = p.offset + (b - p.start);
        first ??= a;
        length += tb - ta;
        cuts += plan.cuts.filter((f) => sec(f) >= ta && sec(f) < tb).length;
      }
      if (!length) return null;
      const shots = plan.shots.filter((x) => x.section === s).length;
      return { n: k + 1, section: s, start: first, end: first + length, cuts, avgShot: length / Math.max(1, shots) };
    })
    .filter(Boolean);
}
