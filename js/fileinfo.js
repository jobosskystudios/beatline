// Reads the original sample rate and channel count from common audio file
// headers. The browser resamples on decode, but Final Cut wants the file's
// own rate in the FCPXML asset. Returns null when the format isn't known.

const ascii = (v, o, n) => String.fromCharCode(...new Uint8Array(v.buffer, v.byteOffset + o, n));

function wav(v) {
  if (ascii(v, 0, 4) !== 'RIFF' || ascii(v, 8, 4) !== 'WAVE') return null;
  for (let o = 12; o + 8 <= v.byteLength;) {
    const id = ascii(v, o, 4);
    const size = v.getUint32(o + 4, true);
    if (id === 'fmt ') return { sampleRate: v.getUint32(o + 12, true), channels: v.getUint16(o + 10, true) };
    o += 8 + size + (size & 1);
  }
  return null;
}

// 80-bit IEEE extended float (AIFF sample rate).
function extended(v, o) {
  const exp = v.getUint16(o) & 0x7fff;
  const hi = v.getUint32(o + 2);
  const lo = v.getUint32(o + 6);
  return (hi * 2 ** 32 + lo) * 2 ** (exp - 16383 - 63);
}

function aiff(v) {
  if (ascii(v, 0, 4) !== 'FORM' || !['AIFF', 'AIFC'].includes(ascii(v, 8, 4))) return null;
  for (let o = 12; o + 8 <= v.byteLength;) {
    const id = ascii(v, o, 4);
    const size = v.getUint32(o + 4);
    if (id === 'COMM') return { sampleRate: Math.round(extended(v, o + 16)), channels: v.getUint16(o + 8) };
    o += 8 + size + (size & 1);
  }
  return null;
}

const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function flac(v) {
  if (ascii(v, 0, 4) !== 'fLaC') return null;
  const b = (i) => v.getUint8(i);
  // STREAMINFO follows the 4-byte block header at offset 4.
  return { sampleRate: (b(18) << 12) | (b(19) << 4) | (b(20) >> 4), channels: ((b(20) >> 1) & 7) + 1 };
}

function mp3(v) {
  let o = 0;
  if (ascii(v, 0, 3) === 'ID3') {
    o = 10 + ((v.getUint8(6) << 21) | (v.getUint8(7) << 14) | (v.getUint8(8) << 7) | v.getUint8(9));
  } else if (v.getUint8(0) !== 0xff || (v.getUint8(1) & 0xe0) !== 0xe0) {
    return null; // not an MP3 stream
  }
  const limit = Math.min(v.byteLength - 4, o + 65536);
  for (; o < limit; o++) {
    if (v.getUint8(o) !== 0xff || (v.getUint8(o + 1) & 0xe0) !== 0xe0) continue;
    const version = (v.getUint8(o + 1) >> 3) & 3;
    const rateIdx = (v.getUint8(o + 2) >> 2) & 3;
    const mode = (v.getUint8(o + 3) >> 6) & 3;
    if (version === 1 || rateIdx === 3) continue;
    return { sampleRate: MP3_RATES[version][rateIdx], channels: mode === 3 ? 1 : 2 };
  }
  return null;
}

// MP4/M4A: the audio sample entry ('mp4a', 'alac', …) inside 'stsd' carries the rate.
function mp4(v) {
  if (ascii(v, 4, 4) !== 'ftyp') return null;
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  for (let i = 0; i + 36 < bytes.length; i++) {
    if (bytes[i] === 0x73 && ascii(v, i, 4) === 'stsd') {
      const entry = i + 12; // after 'stsd' + version/flags + count
      const fmt = ascii(v, entry + 4, 4);
      if (!/^(mp4a|alac|ac-3|ec-3|lpcm|Opus|fLaC)$/.test(fmt)) continue;
      const channels = v.getUint16(entry + 24);
      const sampleRate = v.getUint32(entry + 32) >>> 16;
      if (sampleRate > 0) return { sampleRate, channels };
    }
  }
  return null;
}

export function readAudioInfo(arrayBuffer) {
  const v = new DataView(arrayBuffer);
  if (v.byteLength < 16) return null;
  try {
    return wav(v) ?? aiff(v) ?? flac(v) ?? mp4(v) ?? mp3(v);
  } catch {
    return null;
  }
}

// ---------- video clips (QuickTime / MP4) ----------

// Walks ISO-BMFF boxes inside a DataView window [start, end).
function* boxes(v, start, end) {
  let o = start;
  while (o + 8 <= end) {
    let size = v.getUint32(o);
    const type = ascii(v, o + 4, 4);
    let header = 8;
    if (size === 1) {
      size = Number(v.getBigUint64(o + 8));
      header = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < header || o + size > end) return;
    yield { type, start: o + header, end: o + size };
    o += size;
  }
}
const child = (v, box, type) => {
  for (const b of boxes(v, box.start, box.end)) if (b.type === type) return b;
  return null;
};

function parseMoov(v, moov) {
  const info = { duration: 0, video: null, audio: null };
  const mvhd = child(v, moov, 'mvhd');
  if (mvhd) {
    const ver = v.getUint8(mvhd.start);
    const ts = v.getUint32(mvhd.start + (ver ? 20 : 12));
    const dur = ver ? Number(v.getBigUint64(mvhd.start + 24)) : v.getUint32(mvhd.start + 16);
    info.duration = ts ? dur / ts : 0;
  }
  for (const trak of boxes(v, moov.start, moov.end)) {
    if (trak.type !== 'trak') continue;
    const tkhd = child(v, trak, 'tkhd');
    const mdia = child(v, trak, 'mdia');
    if (!mdia) continue;
    const hdlr = child(v, mdia, 'hdlr');
    const handler = hdlr ? ascii(v, hdlr.start + 8, 4) : '';
    const mdhd = child(v, mdia, 'mdhd');
    const mver = mdhd ? v.getUint8(mdhd.start) : 0;
    const timescale = mdhd ? v.getUint32(mdhd.start + (mver ? 20 : 12)) : 0;
    const stbl = child(v, child(v, mdia, 'minf') ?? { start: 0, end: 0 }, 'stbl');
    if (handler === 'vide' && !info.video) {
      const width = tkhd ? v.getUint32(tkhd.end - 8) / 65536 : 0;
      const height = tkhd ? v.getUint32(tkhd.end - 4) / 65536 : 0;
      let frameDuration = null;
      const stts = stbl && child(v, stbl, 'stts');
      if (stts && v.getUint32(stts.start + 4) > 0) frameDuration = { num: v.getUint32(stts.start + 12), den: timescale };
      const stsd = stbl && child(v, stbl, 'stsd');
      const codec = stsd ? ascii(v, stsd.start + 12, 4) : '';
      info.video = { width: Math.round(width), height: Math.round(height), frameDuration, codec };
    } else if (handler === 'soun' && !info.audio) {
      const stsd = stbl && child(v, stbl, 'stsd');
      const entry = stsd ? stsd.start + 8 : 0;
      info.audio = stsd ? { channels: v.getUint16(entry + 24), sampleRate: v.getUint32(entry + 32) >>> 16 } : { channels: 2, sampleRate: 48000 };
    }
  }
  return info;
}

function findMoov(buf) {
  const v = new DataView(buf);
  for (const b of boxes(v, 0, v.byteLength)) if (b.type === 'moov') return parseMoov(v, b);
  return null;
}

// Reads a File's header (and tail, for files whose index is at the end).
export async function readMovieInfo(file) {
  const HEAD = 4 << 20;
  try {
    const head = await file.slice(0, Math.min(file.size, HEAD)).arrayBuffer();
    const v = new DataView(head);
    let o = 0;
    for (const b of boxes(v, 0, v.byteLength)) {
      if (b.type === 'moov') return parseMoov(v, b);
      o = b.end;
    }
    // Walk top-level box headers through the file to find 'moov'.
    while (o + 16 <= file.size) {
      const h = new DataView(await file.slice(o, o + 16).arrayBuffer());
      let size = h.getUint32(0);
      if (size === 1) size = Number(h.getBigUint64(8));
      if (size < 8) return null;
      if (ascii(h, 4, 4) === 'moov') {
        if (size > 64 << 20) return null;
        return findMoov(await file.slice(o, o + size).arrayBuffer());
      }
      o += size;
    }
  } catch { /* not a movie we can read */ }
  return null;
}
