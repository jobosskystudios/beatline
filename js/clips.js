// Auto-assemble: give every shot of the cut plan a clip from your folder.
// Clips are used once each before any repeats; in-points skip the shaky
// first and last moments of a take and land on the clip's own frames.

// Deterministic shuffle so "Shuffle" gives the same edit for the same seed.
function shuffled(list, seed) {
  const a = [...list];
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const snapToClip = (seconds, clip) => {
  const fd = clip.frameDuration;
  if (!fd) {
    const ms = Math.max(0, Math.round(seconds * 1000));
    return { n: ms, d: 1000 };
  }
  const frames = Math.max(0, Math.floor((seconds * fd.den) / fd.num));
  return { n: frames * fd.num, d: fd.den };
};

/**
 * shots: [{ index, seconds }], clips: [{ name, duration, frameDuration? }]
 * order: 'name' | 'shuffle' | 'fit' (longest clips on the longest shots)
 * use: 'start' (just after the first second) | 'middle'
 * Returns [{ shot, clip, inPoint: { n, d } }]; shots no clip is long enough for are left out.
 */
export function assignClips(shots, clips, { order = 'name', use = 'start', seed = 1, margin = 1 } = {}) {
  const usable = clips.filter((c) => c.duration > 0);
  if (!usable.length) return [];
  let queue;
  if (order === 'shuffle') queue = shuffled(usable, seed);
  else if (order === 'fit') queue = [...usable].sort((a, b) => b.duration - a.duration);
  else queue = [...usable].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const shotOrder = order === 'fit' ? [...shots].sort((a, b) => b.seconds - a.seconds) : shots;
  const used = new Map(queue.map((c) => [c, 0]));
  let cursor = 0;
  const out = [];
  for (const shot of shotOrder) {
    // Next clip (in queue order, fewest uses first) that is long enough.
    let pick = null;
    const minUse = Math.min(...used.values());
    for (let k = 0; k < queue.length && !pick; k++) {
      const c = queue[(cursor + k) % queue.length];
      if (used.get(c) === minUse && c.duration >= shot.seconds) { pick = c; cursor = (cursor + k + 1) % queue.length; }
    }
    for (let k = 0; k < queue.length && !pick; k++) {
      const c = queue[(cursor + k) % queue.length];
      if (c.duration >= shot.seconds) { pick = c; cursor = (cursor + k + 1) % queue.length; }
    }
    if (!pick) continue;
    used.set(pick, used.get(pick) + 1);
    const room = pick.duration - shot.seconds;
    const m = Math.min(margin, room / 2);
    // Reuses of a clip move further into the take so repeats show new frames.
    const reuse = used.get(pick) - 1;
    let start = use === 'middle' ? room / 2 : m;
    if (reuse > 0) start = Math.min(room - m, m + reuse * (shot.seconds + 0.5));
    out.push({ shot, clip: pick, inPoint: snapToClip(Math.max(0, Math.min(start, room)), pick) });
  }
  return out;
}
