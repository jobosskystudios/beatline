// Final Cut Pro XML (FCPXML) writer. All times are written as exact
// rational seconds on frame boundaries, which is what Final Cut expects.

export const FRAME_RATES = {
  '23.976': { num: 1001, den: 24000, code: '2398' },
  '24': { num: 100, den: 2400, code: '24' },
  '25': { num: 100, den: 2500, code: '25' },
  '29.97': { num: 1001, den: 30000, code: '2997' },
  '30': { num: 100, den: 3000, code: '30' },
  '50': { num: 100, den: 5000, code: '50' },
  '59.94': { num: 1001, den: 60000, code: '5994' },
  '60': { num: 100, den: 6000, code: '60' },
};

export const RESOLUTIONS = {
  '1080p': { width: 1920, height: 1080, name: (c) => `FFVideoFormat1080p${c}` },
  '4k': { width: 3840, height: 2160, name: (c) => `FFVideoFormat3840x2160p${c}` },
  '720p': { width: 1280, height: 720, name: (c) => `FFVideoFormat720p${c}` },
  vertical: { width: 1080, height: 1920, name: null },
  square: { width: 1080, height: 1080, name: null },
};

export const MARKER_STYLES = {
  standard: 'Standard (blue)',
  todo: 'To-do (red)',
  done: 'Completed (green)',
  chapter: 'Chapter (orange)',
  none: 'Don’t export',
};

const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));

export function rational(numerator, denominator) {
  if (numerator === 0) return '0s';
  const g = gcd(numerator, denominator);
  const n = numerator / g;
  const d = denominator / g;
  return d === 1 ? `${n}s` : `${n}/${d}s`;
}

export function toFrame(seconds, rate, rounding = 'nearest') {
  const exact = (seconds * rate.den) / rate.num;
  const f = rounding === 'previous' ? Math.floor(exact + 1e-9) : rounding === 'next' ? Math.ceil(exact - 1e-9) : Math.round(exact);
  return Math.max(0, f);
}

export const frameTime = (frame, rate) => rational(frame * rate.num, rate.den);

export function timecode(frame, rate) {
  const fps = Math.round(rate.den / rate.num);
  const ff = frame % fps;
  const total = Math.floor(frame / fps);
  const pad = (v) => String(v).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}:${pad(ff)}`;
}

export const escapeXml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

export function fileUrl(folder, fileName) {
  const parts = `${folder.replace(/\/+$/, '')}/${fileName}`.split('/');
  return 'file://' + parts.map((p) => encodeURIComponent(p)).join('/');
}

// Snap markers to frames, drop duplicates (first in priority order wins).
export function snapMarkers(markers, rate, rounding, styles) {
  const priority = { section: 0, accent: 1, downbeat: 2, manual: 3, beat: 4, phrase: 5, kick: 6, snare: 7, hit: 8, sub: 9, hat: 10 };
  const byFrame = new Map();
  [...markers]
    .filter((m) => styles[m.kind] && styles[m.kind] !== 'none')
    .sort((a, b) => priority[a.kind] - priority[b.kind])
    .forEach((m) => {
      const frame = toFrame(m.time, rate, rounding);
      if (!byFrame.has(frame)) byFrame.set(frame, { ...m, frame });
    });
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

function markerXml(m, frame, rate, style, indent) {
  const start = frameTime(frame, rate);
  const dur = frameTime(1, rate);
  const value = escapeXml(m.label);
  if (style === 'chapter') return `${indent}<chapter-marker start="${start}" duration="${dur}" value="${value}" posterOffset="0s"/>`;
  const completed = style === 'todo' ? ' completed="0"' : style === 'done' ? ' completed="1"' : '';
  return `${indent}<marker start="${start}" duration="${dur}" value="${value}"${completed}/>`;
}

// Exact rational time helpers for mixing project and clip frame rates.
const frac = (n, d) => {
  const g = gcd(n, d) || 1;
  return { n: n / g, d: d / g };
};
const fadd = (a, b) => frac(a.n * b.d + b.n * a.d, a.d * b.d);
const fstr = (f) => rational(f.n, f.d);
const fFrames = (frames, rate) => frac(frames * rate.num, rate.den);

/**
 * opts: {
 *   markers (song time), fps, resolution, rounding, version,
 *   styles: { section, accent, beat, downbeat, ... } -> MARKER_STYLES key,
 *   target: 'clip' (song + markers) | 'blocked' (a placeholder per shot, song underneath)
 *         | 'gap' (markers only) | 'assembled' (your clips cut to the shots, song underneath),
 *   segments: [{ inFrame, outFrame }] song frames played back to back (a range or a music
 *             edit); defaults to the whole song,
 *   shots: [{ index, start, end, section }] timeline frames (for 'blocked' / 'assembled'),
 *   placements: [{ shot, clip, inPoint: { n, d } seconds }] (for 'assembled'),
 *   muteClips: true to silence the clips' own audio,
 *   song: { name, fileName, folder, duration, sampleRate, audioRate, channels },
 *   eventName, projectName
 * }
 */
export function buildFcpxml(opts) {
  const rate = FRAME_RATES[opts.fps];
  const res = RESOLUTIONS[opts.resolution];
  const { song } = opts;
  const songFrames = Math.max(1, Math.floor((song.duration * rate.den) / rate.num));
  const segments = (opts.segments?.length ? opts.segments : [{ inFrame: opts.range?.inFrame ?? 0, outFrame: opts.range?.outFrame ?? songFrames }])
    .map((g) => ({ inFrame: Math.max(0, g.inFrame), outFrame: Math.min(songFrames, g.outFrame) }))
    .filter((g) => g.outFrame > g.inFrame);
  let acc = 0;
  for (const g of segments) { g.offset = acc; acc += g.outFrame - g.inFrame; }
  const lenF = Math.max(1, acc);
  const duration = frameTime(lenF, rate);
  const formatName = res.name ? ` name="${res.name(rate.code)}"` : '';
  const snapped = snapMarkers(opts.markers, rate, opts.rounding, opts.styles);
  const inSeg = (g) => snapped.filter((m) => m.frame >= g.inFrame && m.frame < g.outFrame);
  const markerLines = (list, ind, toFrame) => list.map((m) => markerXml(m, toFrame(m), rate, opts.styles[m.kind], ind));

  const resources = [
    `        <format id="r1"${formatName} frameDuration="${frameTime(1, rate)}" width="${res.width}" height="${res.height}" colorSpace="1-1-1 (Rec. 709)"/>`,
  ];
  if (opts.target !== 'gap') {
    const sr = Math.round(song.sampleRate);
    resources.push(
      `        <asset id="r2" name="${escapeXml(song.name)}" start="0s" duration="${rational(Math.round(song.duration * sr), sr)}" hasAudio="1" audioSources="1" audioChannels="${song.channels}"${song.audioRate ? ` audioRate="${song.audioRate}"` : ''}>`,
      `            <media-rep kind="original-media" src="${escapeXml(fileUrl(song.folder, song.fileName))}"/>`,
      `        </asset>`,
    );
  }

  // One song clip per segment; `offset` is in the parent's time (spine or a
  // parent clip's local time when connected).
  const songClip = (g, ind, attrs, offset) => [
    `${ind}<asset-clip ref="r2"${attrs} offset="${offset}" name="${escapeXml(song.name)}" start="${frameTime(g.inFrame, rate)}" duration="${frameTime(g.outFrame - g.inFrame, rate)}" audioRole="music">`,
    ...markerLines(inSeg(g), ind + '    ', (m) => m.frame),
    `${ind}</asset-clip>`,
  ];
  // Which shot each segment starts in, so the song can hang under it.
  const hostOf = (shots, g) => shots.findIndex((s) => g.offset >= s.start && g.offset < s.end);

  const I = ' '.repeat(24);
  let spine = [];
  if (opts.target === 'clip') {
    spine = segments.flatMap((g) => songClip(g, I, '', frameTime(g.offset, rate)));
  } else if (opts.target === 'gap') {
    spine = [
      `${I}<gap name="${escapeXml(song.name)} markers" offset="0s" start="0s" duration="${duration}">`,
      ...segments.flatMap((g) => markerLines(inSeg(g), I + '    ', (m) => m.frame - g.inFrame + g.offset)),
      `${I}</gap>`,
    ];
  } else if (opts.target === 'blocked') {
    const hosts = segments.map((g) => hostOf(opts.shots, g));
    spine = opts.shots.flatMap((s, k) => {
      const name = escapeXml(`Shot ${s.index}${s.section ? ` · ${s.section.label}` : ''}`);
      const open = `${I}<gap name="${name}" offset="${frameTime(s.start, rate)}" start="0s" duration="${frameTime(s.end - s.start, rate)}"`;
      const children = segments.flatMap((g, gi) => (hosts[gi] === k ? songClip(g, I + '    ', ' lane="-1"', frameTime(g.offset - s.start, rate)) : []));
      return children.length ? [`${open}>`, ...children, `${I}</gap>`] : [`${open}/>`];
    });
  } else if (opts.target === 'assembled') {
    const clipIds = new Map();
    const formatIds = new Map();
    for (const p of opts.placements) {
      const c = p.clip;
      if (clipIds.has(c)) continue;
      const fd = c.frameDuration;
      const fkey = `${c.width}x${c.height}@${fd ? `${fd.num}/${fd.den}` : '?'}`;
      if (!formatIds.has(fkey)) {
        const id = `f${formatIds.size + 1}`;
        formatIds.set(fkey, id);
        resources.push(`        <format id="${id}"${fd ? ` frameDuration="${rational(fd.num, fd.den)}"` : ''} width="${c.width}" height="${c.height}"/>`);
      }
      const id = `c${clipIds.size + 1}`;
      clipIds.set(c, id);
      const durF = fd ? frac(Math.floor((c.duration * fd.den) / fd.num) * fd.num, fd.den) : frac(Math.round(c.duration * 1000), 1000);
      const audio = c.audio ? ` hasAudio="1" audioSources="1" audioChannels="${c.audio.channels}" audioRate="${c.audio.sampleRate}"` : '';
      resources.push(
        `        <asset id="${id}" name="${escapeXml(c.name)}" start="0s" duration="${fstr(durF)}" hasVideo="1" format="${formatIds.get(fkey)}"${audio}>`,
        `            <media-rep kind="original-media" src="${escapeXml(fileUrl(c.folder, c.fileName))}"/>`,
        `        </asset>`,
      );
    }
    const byShot = new Map(opts.placements.map((p) => [p.shot, p]));
    const hosts = segments.map((g) => hostOf(opts.shots, g));
    spine = opts.shots.flatMap((s, k) => {
      const p = byShot.get(s);
      const dur = frameTime(s.end - s.start, rate);
      const songChildren = (local) => segments.flatMap((g, gi) => (hosts[gi] === k ? songClip(g, I + '    ', ' lane="-1"', fstr(fadd(local, fFrames(g.offset - s.start, rate)))) : []));
      if (!p) {
        const kids = songChildren(frac(0, 1));
        const open = `${I}<gap name="Shot ${s.index} (no clip)" offset="${frameTime(s.start, rate)}" start="0s" duration="${dur}"`;
        return kids.length ? [`${open}>`, ...kids, `${I}</gap>`] : [`${open}/>`];
      }
      const kids = [
        ...(opts.muteClips && p.clip.audio ? [`${I}    <adjust-volume amount="-96dB"/>`] : []),
        ...songChildren(p.inPoint),
      ];
      const open = `${I}<asset-clip ref="${clipIds.get(p.clip)}" offset="${frameTime(s.start, rate)}" name="${escapeXml(p.clip.name)}" start="${fstr(p.inPoint)}" duration="${dur}" tcFormat="NDF"`;
      return kids.length ? [`${open}>`, ...kids, `${I}</asset-clip>`] : [`${open}/>`];
    });
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE fcpxml>',
    '',
    `<fcpxml version="${opts.version}">`,
    '    <resources>',
    ...resources,
    '    </resources>',
    '    <library>',
    `        <event name="${escapeXml(opts.eventName)}">`,
    `            <project name="${escapeXml(opts.projectName)}">`,
    `                <sequence format="r1" duration="${duration}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">`,
    '                    <spine>',
    ...spine,
    '                    </spine>',
    '                </sequence>',
    '            </project>',
    '        </event>',
    '    </library>',
    '</fcpxml>',
    '',
  ].join('\n');
}

const csvText = (s) => `"${String(s).replace(/"/g, '""')}"`;

export function buildCsv(markers, fps, rounding) {
  const rate = FRAME_RATES[fps];
  const rows = [['index', 'seconds', 'frame', 'timecode', 'type', 'label']];
  const all = Object.fromEntries(['section', 'accent', 'beat', 'downbeat', 'hit', 'manual', 'kick', 'snare', 'hat', 'sub', 'phrase'].map((k) => [k, 'standard']));
  snapMarkers(markers, rate, rounding, all).forEach((m, i) => {
    const sec = (m.frame * rate.num) / rate.den;
    rows.push([i + 1, sec.toFixed(4), m.frame, timecode(m.frame, rate), m.kind, csvText(m.label)]);
  });
  return rows.map((r) => r.join(',')).join('\n') + '\n';
}

// Shot list for planning footage: one row per shot. Shots are in timeline
// frames; `songFrameAt` maps a timeline frame to the song (for song_in).
export function buildShotCsv(shots, fps, songFrameAt = (f) => f) {
  const rate = FRAME_RATES[fps];
  const rows = [['shot', 'timeline_in', 'timeline_out', 'frames', 'seconds', 'song_in', 'section', 'energy']];
  for (const s of shots) {
    rows.push([
      s.index,
      timecode(s.start, rate),
      timecode(s.end, rate),
      s.frames,
      s.seconds.toFixed(3),
      timecode(songFrameAt(s.start), rate),
      csvText(s.section?.label ?? ''),
      s.section?.level ?? '',
    ]);
  }
  return rows.map((r) => r.join(',')).join('\n') + '\n';
}
