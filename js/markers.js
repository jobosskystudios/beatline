// Turns detected beats/hits into the marker list the user exports.
import { sectionAt } from './structure.js';

export const PACING = {
  triplet: 'Every triplet (3 per beat)',
  eighth: 'Every 8th note (follows swing)',
  beat: 'Every beat',
  half: 'Every 2nd beat',
  bar: 'Every bar',
  bar2: 'Every 2 bars',
  bar4: 'Every 4 bars',
  bar8: 'Every 8 bars (phrase)',
};
export const DENSITY = { ...PACING, auto: 'Auto: follow the song’s energy' };
export const AUTO_DEFAULT = { low: 'bar2', mid: 'bar', high: 'half' };

const mod = (a, n) => ((a % n) + n) % n;
const BAR_STEP = { bar: 1, bar2: 2, bar4: 4, bar8: 8 };

function keep(density, rel, isDown, bar) {
  if (density === 'beat') return true;
  if (density === 'half') return mod(rel, 2) === 0;
  return isDown && mod(bar - 1, BAR_STEP[density]) === 0;
}

// beats: seconds. phase: index of the first downbeat within the bar cycle.
export const DRUM_LABEL = { kick: 'Kick', snare: 'Snare', hat: 'Hi-hat' };

const SUBDIV = { eighth: 2, triplet: 3 };

export function buildMarkers({ mode, beats, onsets, drums, drumKinds = ['kick', 'snare'], phrases = [], phase = 0, beatsPerBar = 4, density = 'beat', offset = 0, edits, sections, autoMap = AUTO_DEFAULT, swingRatio = 0.5, adjust = null }) {
  let list = [];
  if (mode === 'phrases') {
    list = phrases.map((p, i) => ({ time: p.time, kind: 'phrase', label: `Phrase ${i + 1}` }));
  } else if (mode === 'hits') {
    list = onsets.map((t, i) => ({ time: t, kind: 'hit', label: `Hit ${i + 1}` }));
  } else if (mode === 'drums') {
    for (const kind of drumKinds) {
      (drums?.[kind] ?? []).forEach((t, i) => list.push({ time: t, kind, label: `${DRUM_LABEL[kind]} ${i + 1}` }));
    }
  } else {
    beats.forEach((t, i) => {
      const rel = i - phase;
      const beatInBar = mod(rel, beatsPerBar) + 1;
      const bar = Math.floor(rel / beatsPerBar) + 1;
      const isDown = beatInBar === 1;
      const d = density === 'auto' ? autoMap[sections?.length ? sectionAt(sections, t).level : 'mid'] : density;
      const sub = SUBDIV[d];
      if (!sub && !keep(d, rel, isDown, bar)) return;
      list.push({
        time: t,
        kind: isDown ? 'downbeat' : 'beat',
        label: isDown ? `Bar ${bar}` : `Bar ${bar} · Beat ${beatInBar}`,
      });
      // Subdivisions between this beat and the next (8ths sit on the swing).
      if (sub && i + 1 < beats.length) {
        const len = beats[i + 1] - t;
        const parts = sub === 2 ? [swingRatio] : [1 / 3, 2 / 3];
        parts.forEach((f, j) => list.push({ time: t + f * len, kind: 'sub', label: `Bar ${bar} · Beat ${beatInBar}${sub === 2 ? ' &' : ` ${['trip', 'let'][j]}`}` }));
      }
    });
  }
  list = list.map((m) => ({ ...m, time: m.time + offset }));
  // e.g. snapping to hits; runs before your edits so Shift+click sees final times.
  if (adjust) list = adjust(list);
  if (edits) {
    list = list.filter((m) => !edits.removed.has(markerKey(m.time)));
    for (const t of edits.added) list.push({ time: t, kind: 'manual', label: 'Marker' });
  }
  return list.filter((m) => m.time >= 0).sort((a, b) => a.time - b.time);
}

export const markerKey = (t) => Math.round(t * 1000);
