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
  const priority = { section: 0, downbeat: 1, manual: 2, beat: 3, kick: 4, snare: 5, hit: 6, hat: 7 };
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

/**
 * opts: {
 *   markers, fps, resolution, rounding, version,
 *   styles: { section, beat, downbeat, hit, manual } -> MARKER_STYLES key,
 *   target: 'clip' (song + markers) | 'blocked' (one placeholder per shot, song underneath) | 'gap' (markers only),
 *   range: { inFrame, outFrame } (optional, defaults to the whole song),
 *   shots: [{ start, end, index, section }] (required for 'blocked'),
 *   song: { name, fileName, folder, duration, sampleRate, channels },
 *   eventName, projectName
 * }
 */
export function buildFcpxml(opts) {
  const rate = FRAME_RATES[opts.fps];
  const res = RESOLUTIONS[opts.resolution];
  const { song } = opts;
  const songFrames = Math.max(1, Math.floor((song.duration * rate.den) / rate.num));
  const inF = Math.max(0, opts.range?.inFrame ?? 0);
  const outF = Math.min(songFrames, opts.range?.outFrame ?? songFrames);
  const lenF = Math.max(1, outF - inF);
  const duration = frameTime(lenF, rate);
  const formatName = res.name ? ` name="${res.name(rate.code)}"` : '';
  const snapped = snapMarkers(opts.markers, rate, opts.rounding, opts.styles).filter((m) => m.frame >= inF && m.frame < outF);
  const markerLines = (ind, shift) => snapped.map((m) => markerXml(m, m.frame - shift, rate, opts.styles[m.kind], ind));

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
  const songClip = (ind, attrs) => [
    `${ind}<asset-clip ref="r2"${attrs} offset="0s" name="${escapeXml(song.name)}" start="${frameTime(inF, rate)}" duration="${duration}" audioRole="music">`,
    ...markerLines(ind + '    ', 0),
    `${ind}</asset-clip>`,
  ];

  const I = ' '.repeat(24);
  let spine;
  if (opts.target === 'clip') {
    spine = songClip(I, '');
  } else if (opts.target === 'blocked') {
    spine = opts.shots.flatMap((s, k) => {
      const name = escapeXml(`Shot ${s.index}${s.section ? ` · ${s.section.label}` : ''}`);
      const open = `${I}<gap name="${name}" offset="${frameTime(s.start - inF, rate)}" start="0s" duration="${frameTime(s.end - s.start, rate)}"`;
      return k === 0 ? [`${open}>`, ...songClip(I + '    ', ' lane="-1"'), `${I}</gap>`] : [`${open}/>`];
    });
  } else {
    spine = [
      `${I}<gap name="${escapeXml(song.name)} markers" offset="0s" start="0s" duration="${duration}">`,
      ...markerLines(I + '    ', inF),
      `${I}</gap>`,
    ];
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
  const all = { section: 'standard', beat: 'standard', downbeat: 'standard', hit: 'standard', manual: 'standard', kick: 'standard', snare: 'standard', hat: 'standard' };
  snapMarkers(markers, rate, rounding, all).forEach((m, i) => {
    const sec = (m.frame * rate.num) / rate.den;
    rows.push([i + 1, sec.toFixed(4), m.frame, timecode(m.frame, rate), m.kind, csvText(m.label)]);
  });
  return rows.map((r) => r.join(',')).join('\n') + '\n';
}

// Shot list for planning footage: one row per shot, timecodes relative to the
// start of the exported range (= the FCP project's timeline).
export function buildShotCsv(shots, fps, inFrame = 0) {
  const rate = FRAME_RATES[fps];
  const rows = [['shot', 'timeline_in', 'timeline_out', 'frames', 'seconds', 'song_in', 'section', 'energy']];
  for (const s of shots) {
    rows.push([
      s.index,
      timecode(s.start - inFrame, rate),
      timecode(s.end - inFrame, rate),
      s.frames,
      s.seconds.toFixed(3),
      timecode(s.start, rate),
      csvText(s.section?.label ?? ''),
      s.section?.level ?? '',
    ]);
  }
  return rows.map((r) => r.join(',')).join('\n') + '\n';
}
