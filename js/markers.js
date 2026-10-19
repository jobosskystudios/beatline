// Turns detected beats/hits into the marker list the user exports.

export const DENSITY = {
  beat: 'Every beat',
  half: 'Every 2nd beat',
  bar: 'Every bar (downbeats)',
  bar2: 'Every 2 bars',
  bar4: 'Every 4 bars',
};

const mod = (a, n) => ((a % n) + n) % n;

// beats: seconds. phase: index of the first downbeat within the bar cycle.
export function buildMarkers({ mode, beats, onsets, phase = 0, beatsPerBar = 4, density = 'beat', offset = 0, edits }) {
  let list = [];
  if (mode === 'hits') {
    list = onsets.map((t, i) => ({ time: t, kind: 'hit', label: `Hit ${i + 1}` }));
  } else {
    beats.forEach((t, i) => {
      const rel = i - phase;
      const beatInBar = mod(rel, beatsPerBar) + 1;
      const bar = Math.floor(rel / beatsPerBar) + 1;
      const isDown = beatInBar === 1;
      const keep =
        density === 'beat' ||
        (density === 'half' && mod(rel, 2) === 0) ||
        (density === 'bar' && isDown) ||
        (density === 'bar2' && isDown && mod(bar - 1, 2) === 0) ||
        (density === 'bar4' && isDown && mod(bar - 1, 4) === 0);
      if (!keep) return;
      list.push({
        time: t,
        kind: isDown ? 'downbeat' : 'beat',
        label: isDown ? `Bar ${bar}` : `Bar ${bar} · Beat ${beatInBar}`,
      });
    });
  }
  list = list.map((m) => ({ ...m, time: m.time + offset }));
  if (edits) {
    list = list.filter((m) => !edits.removed.has(markerKey(m.time)));
    for (const t of edits.added) list.push({ time: t, kind: 'manual', label: 'Marker' });
  }
  return list.filter((m) => m.time >= 0).sort((a, b) => a.time - b.time);
}

export const markerKey = (t) => Math.round(t * 1000);
