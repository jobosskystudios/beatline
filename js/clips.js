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
 * shots: [{ index, start, seconds, section? }], clips: [{ name, duration, frameDuration?, group?, energy? }]
 * order: 'name' | 'shuffle' | 'fit' (longest clips on the longest shots)
 * use: 'start' (just after the first second) | 'middle'
 * energy: true → clips tagged 'low' | 'mid' | 'high' go on shots of that section level
 * mixGroups: true → avoid two clips from the same folder back to back
 * fixed: Map(shot.start → clip) for shots you picked or locked
 * Returns [{ shot, clip, inPoint: { n, d }, fixed? }]; shots no clip is long enough for are left out.
 */
export function assignClips(shots, clips, { order = 'name', use = 'start', seed = 1, margin = 1, energy = false, mixGroups = false, fixed = null } = {}) {
  const usable = clips.filter((c) => c.duration > 0);
  if (!usable.length) return [];
  let queue;
  if (order === 'shuffle') queue = shuffled(usable, seed);
  else if (order === 'fit') queue = [...usable].sort((a, b) => b.duration - a.duration);
  else queue = [...usable].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const used = new Map(queue.map((c) => [c, 0]));
  const pinned = new Map();
  for (const shot of shots) {
    const c = fixed?.get(shot.start);
    if (c && used.has(c) && c.duration >= shot.seconds) { pinned.set(shot, c); used.set(c, used.get(c) + 1); }
  }
  const shotOrder = order === 'fit' ? [...shots].sort((a, b) => b.seconds - a.seconds) : shots;
  const seen = new Map(); // uses so far, for moving reuses further into the take
  let cursor = 0;
  let prev = null;
  const out = [];
  const place = (shot, pick, isFixed) => {
    const reuse = seen.get(pick) ?? 0;
    seen.set(pick, reuse + 1);
    const room = pick.duration - shot.seconds;
    const m = Math.min(margin, room / 2);
    // Reuses of a clip move further into the take so repeats show new frames.
    let start = use === 'middle' ? room / 2 : m;
    if (reuse > 0) start = Math.min(room - m, m + reuse * (shot.seconds + 0.5));
    out.push({ shot, clip: pick, inPoint: snapToClip(Math.max(0, Math.min(start, room)), pick), ...(isFixed ? { fixed: true } : {}) });
  };
  for (const shot of shotOrder) {
    if (pinned.has(shot)) { prev = pinned.get(shot); place(shot, prev, true); continue; }
    // Best long-enough clip: right energy first, then fewest uses, then not the
    // same folder as the last shot, then queue order.
    const level = energy ? shot.section?.level : null;
    let pick = null;
    let best = Infinity;
    for (let k = 0; k < queue.length; k++) {
      const c = queue[(cursor + k) % queue.length];
      if (c.duration < shot.seconds) continue;
      const score = (level && c.energy && c.energy !== level ? 1e6 : 0) + used.get(c) * 10 +
        (mixGroups && prev && c.group && c.group === prev.group ? 1 : 0);
      if (score < best) { best = score; pick = c; }
    }
    if (!pick) continue;
    cursor = (queue.indexOf(pick) + 1) % queue.length;
    used.set(pick, used.get(pick) + 1);
    prev = pick;
    place(shot, pick, false);
  }
  return out;
}

// Rough energy from a folder's name ("calm", "b-roll" → low; "action", "drop" → high).
export function guessEnergy(name) {
  const n = name.toLowerCase();
  if (/calm|slow|intro|outro|b-?roll|wide|establish|ambien|scenic|detail/.test(n)) return 'low';
  if (/peak|action|drop|fast|hype|dance|energy|crowd|party|jump|stunt/.test(n)) return 'high';
  if (/groove|mid|medium|walk|talk|perform|verse/.test(n)) return 'mid';
  return '';
}
