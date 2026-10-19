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
  const priority = { downbeat: 0, manual: 1, beat: 2, hit: 3 };
  const byFrame = new Map();
  [...markers]
    .filter((m) => styles[m.kind] !== 'none')
    .sort((a, b) => priority[a.kind] - priority[b.kind])
    .forEach((m) => {
      const frame = toFrame(m.time, rate, rounding);
      if (!byFrame.has(frame)) byFrame.set(frame, { ...m, frame });
    });
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

function markerXml(m, rate, style, indent) {
  const start = frameTime(m.frame, rate);
  const dur = frameTime(1, rate);
  const value = escapeXml(m.label);
  if (style === 'chapter') return `${indent}<chapter-marker start="${start}" duration="${dur}" value="${value}" posterOffset="0s"/>`;
  const completed = style === 'todo' ? ' completed="0"' : style === 'done' ? ' completed="1"' : '';
  return `${indent}<marker start="${start}" duration="${dur}" value="${value}"${completed}/>`;
}

/**
 * opts: {
 *   markers, fps, resolution, rounding, version,
 *   styles: { beat, downbeat, hit, manual } -> MARKER_STYLES key,
 *   target: 'clip' | 'gap',
 *   song: { name, fileName, folder, duration, sampleRate, channels },
 *   eventName, projectName
 * }
 */
export function buildFcpxml(opts) {
  const rate = FRAME_RATES[opts.fps];
  const res = RESOLUTIONS[opts.resolution];
  const { song } = opts;
  const snapped = snapMarkers(opts.markers, rate, opts.rounding, opts.styles);
  const durFrames = Math.max(1, Math.floor((song.duration * rate.den) / rate.num));
  const duration = frameTime(durFrames, rate);
  const formatName = res.name ? ` name="${res.name(rate.code)}"` : '';
  const ind = ' '.repeat(28);
  const markerLines = snapped
    .filter((m) => m.frame < durFrames)
    .map((m) => markerXml(m, rate, opts.styles[m.kind], ind))
    .join('\n');

  const resources = [
    `        <format id="r1"${formatName} frameDuration="${frameTime(1, rate)}" width="${res.width}" height="${res.height}" colorSpace="1-1-1 (Rec. 709)"/>`,
  ];
  let clip;
  if (opts.target === 'clip') {
    const sr = Math.round(song.sampleRate);
    resources.push(
      `        <asset id="r2" name="${escapeXml(song.name)}" start="0s" duration="${rational(Math.round(song.duration * sr), sr)}" hasAudio="1" audioSources="1" audioChannels="${song.channels}">`,
      `            <media-rep kind="original-media" src="${escapeXml(fileUrl(song.folder, song.fileName))}"/>`,
      `        </asset>`,
    );
    clip = [
      `                        <asset-clip ref="r2" offset="0s" name="${escapeXml(song.name)}" start="0s" duration="${duration}" audioRole="music">`,
      markerLines,
      `                        </asset-clip>`,
    ];
  } else {
    clip = [
      `                        <gap name="${escapeXml(song.name)} markers" offset="0s" start="0s" duration="${duration}">`,
      markerLines,
      `                        </gap>`,
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
    ...clip.filter(Boolean),
    '                    </spine>',
    '                </sequence>',
    '            </project>',
    '        </event>',
    '    </library>',
    '</fcpxml>',
    '',
  ].join('\n');
}

export function buildCsv(markers, fps, rounding) {
  const rate = FRAME_RATES[fps];
  const rows = [['index', 'seconds', 'frame', 'timecode', 'type', 'label']];
  const all = { beat: 'standard', downbeat: 'standard', hit: 'standard', manual: 'standard' };
  snapMarkers(markers, rate, rounding, all).forEach((m, i) => {
    const sec = (m.frame * rate.num) / rate.den;
    rows.push([i + 1, sec.toFixed(4), m.frame, timecode(m.frame, rate), m.kind, `"${m.label.replace(/"/g, '""')}"`]);
  });
  return rows.map((r) => r.join(',')).join('\n') + '\n';
}
