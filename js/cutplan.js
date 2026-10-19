// Cut plan: every cut marker inside the range becomes an edit point; the
// spans between them are the shots an editor has to fill.
import { toFrame } from './fcpxml.js';
import { sectionAt } from './structure.js';

export const CUT_KINDS = new Set(['beat', 'downbeat', 'hit', 'manual', 'kick', 'snare', 'hat']);

export function planCuts({ markers, rate, rounding, inFrame, outFrame, minShotFrames = 1, sections = [] }) {
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
    const s = sections.length ? sectionAt(sections, sec(start)) : null;
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

// Per-section summary for the cut plan table.
export function sectionSummary(sections, plan, rate, inFrame, outFrame) {
  const sec = (f) => (f * rate.num) / rate.den;
  const a = sec(inFrame);
  const b = sec(outFrame);
  return sections
    .map((s, k) => {
      const start = Math.max(s.start, a);
      const end = Math.min(s.end, b);
      if (end <= start) return null;
      const cuts = plan.cuts.filter((f) => sec(f) >= start && sec(f) < end).length;
      const shots = plan.shots.filter((x) => x.section === s).length;
      return { n: k + 1, section: s, start, end, cuts, avgShot: (end - start) / Math.max(1, shots) };
    })
    .filter(Boolean);
}
