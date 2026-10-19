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
