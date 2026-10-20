// Exports for other editors: Premiere Pro (FCP7 XML / xmeml sequence with
// the song and markers) and DaVinci Resolve (marker EDL).
import { FRAME_RATES, escapeXml, timecode } from './fcpxml.js';

const NTSC = new Set(['23.976', '29.97', '59.94']);

function rateXml(fps, ind) {
  const tb = Math.round(FRAME_RATES[fps].den / FRAME_RATES[fps].num);
  return `${ind}<rate><timebase>${tb}</timebase><ntsc>${NTSC.has(fps) ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
}

const pathUrl = (folder, fileName) =>
  'file://localhost' + `${folder.replace(/\/+$/, '')}/${fileName}`.split('/').map((p) => encodeURIComponent(p)).join('/');

/**
 * markers: [{ frame (timeline), label, kind }] already snapped,
 * segments: [{ inFrame, outFrame }] song frames placed back to back,
 * song: { name, fileName, folder, duration, channels, audioRate }.
 */
export function buildPremiereXml({ name, fps, width = 1920, height = 1080, markers, segments, song }) {
  const r = FRAME_RATES[fps];
  const songFrames = Math.floor((song.duration * r.den) / r.num);
  let at = 0;
  const items = segments.map((g, i) => {
    const len = g.outFrame - g.inFrame;
    const file = i === 0
      ? [
        `            <file id="file-1">`,
        `              <name>${escapeXml(song.fileName)}</name>`,
        `              <pathurl>${escapeXml(pathUrl(song.folder, song.fileName))}</pathurl>`,
        rateXml(fps, '              '),
        `              <duration>${songFrames}</duration>`,
        `              <media><audio><samplecharacteristics><depth>16</depth><samplerate>${song.audioRate ?? 48000}</samplerate></samplecharacteristics><channelcount>${song.channels}</channelcount></audio></media>`,
        `            </file>`,
      ]
      : ['            <file id="file-1"/>'];
    const out = [
      `          <clipitem id="clipitem-${i + 1}">`,
      `            <name>${escapeXml(song.name)}</name>`,
      '            <enabled>TRUE</enabled>',
      `            <duration>${songFrames}</duration>`,
      rateXml(fps, '            '),
      `            <start>${at}</start>`,
      `            <end>${at + len}</end>`,
      `            <in>${g.inFrame}</in>`,
      `            <out>${g.outFrame}</out>`,
      ...file,
      '            <sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>',
      '          </clipitem>',
    ];
    at += len;
    return out;
  });
  const marks = markers.map((m) => [
    '    <marker>',
    `      <name>${escapeXml(m.label)}</name>`,
    '      <comment></comment>',
    `      <in>${m.frame}</in>`,
    '      <out>-1</out>',
    '    </marker>',
  ]);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE xmeml>',
    '<xmeml version="4">',
    '  <sequence id="sequence-1">',
    `    <name>${escapeXml(name)}</name>`,
    `    <duration>${at}</duration>`,
    rateXml(fps, '    '),
    '    <timecode>',
    rateXml(fps, '      '),
    '      <string>00:00:00:00</string>',
    '      <frame>0</frame>',
    '      <displayformat>NDF</displayformat>',
    '    </timecode>',
    '    <media>',
    '      <video>',
    '        <format><samplecharacteristics>',
    rateXml(fps, '          '),
    `          <width>${width}</width><height>${height}</height><pixelaspectratio>square</pixelaspectratio>`,
    '        </samplecharacteristics></format>',
    '        <track></track>',
    '      </video>',
    '      <audio>',
    '        <numOutputChannels>2</numOutputChannels>',
    '        <track>',
    ...items.flat(),
    '        </track>',
    '      </audio>',
    '    </media>',
    ...marks.flat(),
    '  </sequence>',
    '</xmeml>',
    '',
  ].join('\n');
}

const RESOLVE_COLOR = {
  section: 'ResolveColorPurple',
  accent: 'ResolveColorRed',
  downbeat: 'ResolveColorBlue',
  manual: 'ResolveColorPink',
};

// Resolve: Timeline › Import › Timeline Markers from EDL. Resolve timelines
// start at 01:00:00:00 by default.
export function buildResolveEdl({ name, fps, markers, startHour = 1 }) {
  const r = FRAME_RATES[fps];
  const base = startHour * 3600 * Math.round(r.den / r.num);
  const lines = [`TITLE: ${name}`, 'FCM: NON-DROP FRAME', ''];
  markers.forEach((m, i) => {
    const a = timecode(base + m.frame, r);
    const b = timecode(base + m.frame + 1, r);
    lines.push(`${String(i + 1).padStart(3, '0')}  001      V     C        ${a} ${b} ${a} ${b}  `);
    lines.push(` |C:${RESOLVE_COLOR[m.kind] ?? 'ResolveColorGreen'} |M:${m.label.replace(/\|/g, '/')} |D:1`);
    lines.push('');
  });
  return lines.join('\n');
}
