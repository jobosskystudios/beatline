// Timeline + overview canvases. Lanes, top to bottom: ruler (bars or time),
// song sections, tempo curve, waveform coloured by bass/mids/highs with the
// cut markers, and (in Drums mode) kick/snare/hi-hat lanes.

export const PEAK_BIN = 256;
const RULER = 22;
const SECT = 18;
const TEMPO = 26;
const DRUM_ROW = 11;

const LEVEL_VAR = { low: '--lvl-low', mid: '--lvl-mid', high: '--lvl-high' };
const KIND_VAR = { downbeat: '--downbeat', beat: '--beat', hit: '--hit', manual: '--manual', kick: '--kick', snare: '--snare', hat: '--hat' };

export function computePeaks(mono) {
  const n = Math.ceil(mono.length / PEAK_BIN);
  const peaks = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    const end = Math.min(mono.length, (i + 1) * PEAK_BIN);
    for (let j = i * PEAK_BIN; j < end; j++) { const v = Math.abs(mono[j]); if (v > m) m = v; }
    peaks[i] = m;
  }
  return peaks;
}

// Per-band normalisers so each band's colour weight spans 0..1 over the song.
export function bandNorms(bands) {
  const out = [1, 1, 1];
  for (let b = 0; b < 3; b++) {
    const v = [];
    for (let i = b; i < bands.length; i += 3 * 4) v.push(bands[i]);
    v.sort((x, y) => x - y);
    out[b] = v[Math.floor(v.length * 0.98)] || 1;
  }
  return out;
}

const fmtClock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export function createTimeline({ canvas, overview, get, onSeek, onToggle, onRange, onView }) {
  const ctx = canvas.getContext('2d');
  const octx = overview.getContext('2d');
  const probe = document.createElement('canvas').getContext('2d');
  let colorCache = null;
  let overviewImage = null;
  let overviewKey = '';

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const rgb = (color) => {
    probe.fillStyle = '#000';
    probe.fillStyle = color;
    const s = probe.fillStyle;
    if (s.startsWith('#')) return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
    return s.match(/[\d.]+/g).slice(0, 3).map(Number);
  };
  function colors() {
    if (colorCache) return colorCache;
    const c = {};
    for (const v of ['--text', '--muted', '--faint', '--line', '--panel', '--panel-2', '--accent', '--dim', '--grid', ...Object.values(LEVEL_VAR), ...Object.values(KIND_VAR)]) c[v] = css(v);
    c.waveRGB = ['--wave-low', '--wave-mid', '--wave-high'].map((v) => rgb(css(v)));
    colorCache = c;
    return c;
  }
  function invalidateColors() {
    colorCache = null;
    overviewKey = '';
  }

  function fit(cv, c2d) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  // Waveform columns between pixel x0..x1 for song time t(x).
  function drawWave(c2d, s, x0, x1, y0, y1, timeAt) {
    const C = colors();
    const { peaks, bands, hopTime, norms, sampleRate } = s.wave;
    const mid = (y0 + y1) / 2;
    const half = (y1 - y0) / 2 - 2;
    for (let x = x0; x < x1; x++) {
      const ta = timeAt(x);
      const tb = timeAt(x + 1);
      const b0 = Math.max(0, Math.floor((ta * sampleRate) / PEAK_BIN));
      const b1 = Math.min(peaks.length, Math.max(b0 + 1, Math.floor((tb * sampleRate) / PEAK_BIN)));
      let m = 0;
      for (let b = b0; b < b1; b++) if (peaks[b] > m) m = peaks[b];
      if (m <= 0) continue;
      const f0 = Math.max(0, Math.floor(ta / hopTime));
      const f1 = Math.max(f0 + 1, Math.floor(tb / hopTime));
      const e = [0, 0, 0];
      let n = 0;
      for (let f = f0; f < f1 && f * 3 + 2 < bands.length; f++, n++) for (let k = 0; k < 3; k++) e[k] += bands[f * 3 + k];
      let r = 0; let g = 0; let bl = 0; let wsum = 0;
      for (let k = 0; k < 3; k++) {
        const wgt = Math.min(1, (n ? e[k] / n : 0) / norms[k]) ** 2 + 0.02;
        r += C.waveRGB[k][0] * wgt; g += C.waveRGB[k][1] * wgt; bl += C.waveRGB[k][2] * wgt; wsum += wgt;
      }
      c2d.fillStyle = `rgb(${(r / wsum) | 0},${(g / wsum) | 0},${(bl / wsum) | 0})`;
      const y = Math.max(0.5, Math.min(1, m) * half);
      c2d.fillRect(x, mid - y, 1, y * 2);
    }
  }

  function draw() {
    const s = get();
    const { w, h } = fit(canvas, ctx);
    if (!w || !h) return; // hidden
    ctx.clearRect(0, 0, w, h);
    if (!s) return;
    const C = colors();
    const { start, dur } = s.view;
    const xOf = (t) => ((t - start) / dur) * w;
    const tAt = (x) => start + (x / w) * dur;
    const drums = s.mode === 'drums';
    const waveTop = RULER + SECT + TEMPO;
    const waveBottom = h - (drums ? DRUM_ROW * 3 + 4 : 0);
    ctx.font = '11px -apple-system, system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    // Ruler.
    ctx.fillStyle = C['--panel'];
    ctx.fillRect(0, 0, w, RULER);
    const pxPerSec = w / dur;
    const barPx = s.barLen * pxPerSec;
    ctx.fillStyle = C['--muted'];
    if (s.bars.length && barPx >= 22) {
      const every = barPx >= 34 ? 1 : barPx >= 17 ? 2 : 4;
      for (const b of s.bars) {
        if (b.start < start - 1 || b.start > start + dur) continue;
        const x = Math.round(xOf(b.start)) + 0.5;
        ctx.fillStyle = C['--line'];
        ctx.fillRect(x, RULER - 6, 1, 6);
        if ((b.bar - 1) % every === 0) {
          ctx.fillStyle = C['--muted'];
          ctx.fillText(String(b.bar), x + 3, RULER / 2);
        }
      }
    } else {
      const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];
      const step = steps.find((v) => v * pxPerSec >= 70) ?? 300;
      for (let t = Math.ceil(start / step) * step; t <= start + dur; t += step) {
        const x = Math.round(xOf(t)) + 0.5;
        ctx.fillStyle = C['--line'];
        ctx.fillRect(x, RULER - 6, 1, 6);
        ctx.fillStyle = C['--muted'];
        ctx.fillText(fmtClock(t), x + 3, RULER / 2);
      }
    }

    // Sections lane.
    for (const sec of s.sections) {
      const x0 = Math.max(0, xOf(sec.start));
      const x1 = Math.min(w, xOf(sec.end));
      if (x1 <= 0 || x0 >= w) continue;
      ctx.fillStyle = C[LEVEL_VAR[sec.level]];
      ctx.fillRect(x0, RULER + 1, Math.max(1, x1 - x0 - 1), SECT - 2);
      if (x1 - x0 > 40) {
        ctx.fillStyle = '#fff';
        ctx.fillText(sec.drop ? '▼ Drop' : sec.label, x0 + 5, RULER + SECT / 2);
      }
    }

    // Tempo lane: local tempo over time.
    const ty0 = RULER + SECT + 3;
    const ty1 = RULER + SECT + TEMPO - 3;
    const curve = s.tempoCurve;
    if (curve.length > 1) {
      const bpms = curve.map((c) => c.bpm);
      let lo = Math.min(...bpms);
      let hi = Math.max(...bpms);
      const pad = Math.max(3, (hi - lo) * 0.2);
      lo -= pad; hi += pad;
      const yOf = (b) => ty1 - ((b - lo) / (hi - lo)) * (ty1 - ty0);
      ctx.strokeStyle = C['--grid'];
      ctx.beginPath(); ctx.moveTo(0, yOf(s.bpm) + 0.5); ctx.lineTo(w, yOf(s.bpm) + 0.5); ctx.stroke();
      ctx.strokeStyle = C['--muted'];
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      curve.forEach((c, i) => (i ? ctx.lineTo(xOf(c.time), yOf(c.bpm)) : ctx.moveTo(xOf(c.time), yOf(c.bpm))));
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    const label = `${s.bpm.toFixed(1)} BPM`;
    ctx.fillStyle = C['--panel'];
    ctx.fillRect(2, ty0, ctx.measureText(label).width + 8, ty1 - ty0);
    ctx.fillStyle = C['--faint'];
    ctx.fillText(label, 6, (ty0 + ty1) / 2);

    // Waveform.
    ctx.fillStyle = C['--grid'];
    ctx.fillRect(0, waveTop, w, 1);
    drawWave(ctx, s, 0, w, waveTop + 2, waveBottom, tAt);

    // Drum lanes.
    if (drums) {
      ['kick', 'snare', 'hat'].forEach((k, row) => {
        const y = waveBottom + 2 + row * DRUM_ROW + DRUM_ROW / 2;
        ctx.fillStyle = C[KIND_VAR[k]];
        for (const t of s.drums[k] ?? []) {
          if (t < start || t > start + dur) continue;
          ctx.fillRect(Math.round(xOf(t)) - 1, y - 3, 3, 6);
        }
      });
    }

    // Full beat grid, faint, so the beats stay visible whatever the cut pacing.
    if (s.beats?.length && s.mode === 'beats') {
      ctx.fillStyle = C['--beat'];
      ctx.globalAlpha = 0.22;
      const tick = Math.max(6, (waveBottom - waveTop) * 0.08);
      for (const t of s.beats) {
        if (t < start || t > start + dur) continue;
        const x = Math.round(xOf(t));
        ctx.fillRect(x, waveTop, 1, tick);
        ctx.fillRect(x, waveBottom - tick, 1, tick);
      }
      ctx.globalAlpha = 1;
    }

    // Markers.
    const cut = s.isCut;
    for (const m of s.markers) {
      if (m.time < start || m.time > start + dur) continue;
      const x = Math.round(xOf(m.time)) + 0.5;
      const on = cut(m);
      const light = m.kind === 'beat' || m.kind === 'hat';
      ctx.strokeStyle = C[KIND_VAR[m.kind]] || C['--text'];
      ctx.lineWidth = light ? 1 : 2;
      ctx.globalAlpha = on ? (light ? 0.7 : 1) : 0.18;
      ctx.beginPath();
      ctx.moveTo(x, waveTop + (light ? (waveBottom - waveTop) * 0.15 : 0));
      ctx.lineTo(x, waveBottom - (light ? (waveBottom - waveTop) * 0.15 : 0));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;

    // Range.
    if (s.range) {
      const a = xOf(s.range[0]);
      const b = xOf(s.range[1]);
      ctx.fillStyle = C['--dim'];
      if (a > 0) ctx.fillRect(0, RULER, Math.min(w, a), h - RULER);
      if (b < w) ctx.fillRect(Math.max(0, b), RULER, w - Math.max(0, b), h - RULER);
      ctx.fillStyle = C['--accent'];
      ctx.globalAlpha = 0.25;
      ctx.fillRect(Math.max(0, a), 0, Math.min(w, b) - Math.max(0, a), RULER);
      ctx.globalAlpha = 1;
      for (const x of [a, b]) if (x >= 0 && x <= w) ctx.fillRect(Math.round(x) - 1, 0, 2, h);
    }

    // Playhead.
    const px = xOf(s.time);
    if (px >= 0 && px <= w) {
      ctx.fillStyle = C['--text'];
      ctx.fillRect(Math.round(px) - 1, 0, 2, h);
      ctx.beginPath();
      ctx.moveTo(px - 5, 0); ctx.lineTo(px + 5, 0); ctx.lineTo(px, 7); ctx.fill();
    }
  }

  function drawOverview() {
    const s = get();
    const { w, h } = fit(overview, octx);
    if (!w || !h) return; // hidden
    octx.clearRect(0, 0, w, h);
    if (!s) return;
    const C = colors();
    const total = s.duration;
    const xOf = (t) => (t / total) * w;
    const key = `${w}x${h}|${s.wave.peaks.length}|${s.sectionsKey}|${C['--panel']}`;
    if (key !== overviewKey) {
      const off = document.createElement('canvas');
      const dpr = window.devicePixelRatio || 1;
      off.width = Math.round(w * dpr);
      off.height = Math.round(h * dpr);
      const o2 = off.getContext('2d');
      o2.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const sec of s.sections) {
        o2.fillStyle = C[LEVEL_VAR[sec.level]];
        o2.globalAlpha = 0.22;
        o2.fillRect(xOf(sec.start), 0, xOf(sec.end) - xOf(sec.start), h);
      }
      o2.globalAlpha = 1;
      drawWave(o2, s, 0, w, 3, h - 3, (x) => (x / w) * total);
      overviewImage = off;
      overviewKey = key;
    }
    octx.drawImage(overviewImage, 0, 0, w, h);
    if (s.range) {
      octx.fillStyle = C['--accent'];
      octx.globalAlpha = 0.18;
      octx.fillRect(xOf(s.range[0]), 0, xOf(s.range[1]) - xOf(s.range[0]), h);
      octx.globalAlpha = 1;
    }
    const vx = xOf(s.view.start);
    const vw = Math.max(3, xOf(s.view.start + s.view.dur) - vx);
    octx.strokeStyle = C['--text'];
    octx.lineWidth = 1.5;
    octx.strokeRect(vx + 0.75, 0.75, vw - 1.5, h - 1.5);
    octx.lineWidth = 1;
    octx.fillStyle = C['--accent'];
    octx.fillRect(Math.round(xOf(s.time)) - 1, 0, 2, h);
  }

  // ---------- interaction ----------
  const timeAtClient = (cv, clientX, t0, d) => {
    const r = cv.getBoundingClientRect();
    return t0 + ((clientX - r.left) / r.width) * d;
  };
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    const s = get();
    if (!s) return;
    const r = canvas.getBoundingClientRect();
    const y = e.clientY - r.top;
    drag = {
      kind: y < RULER ? 'range' : 'pan',
      x: e.clientX,
      t: timeAtClient(canvas, e.clientX, s.view.start, s.view.dur),
      viewStart: s.view.start,
      moved: false,
      shift: e.shiftKey,
    };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const s = get();
    if (Math.abs(e.clientX - drag.x) > 3) drag.moved = true;
    if (!drag.moved) return;
    if (drag.kind === 'range') {
      const t = timeAtClient(canvas, e.clientX, s.view.start, s.view.dur);
      onRange(Math.min(drag.t, t), Math.max(drag.t, t));
    } else {
      const dt = ((e.clientX - drag.x) / canvas.clientWidth) * s.view.dur;
      onView({ start: drag.viewStart - dt, dur: s.view.dur });
      canvas.style.cursor = 'grabbing';
    }
  });
  const end = (e) => {
    if (!drag) return;
    canvas.style.cursor = '';
    if (!drag.moved) {
      if (drag.shift) onToggle(drag.t);
      else onSeek(drag.t);
    }
    drag = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  canvas.addEventListener('wheel', (e) => {
    const s = get();
    if (!s) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const c = timeAtClient(canvas, e.clientX, s.view.start, s.view.dur);
      const dur = s.view.dur * Math.exp(e.deltaY * 0.01);
      const rel = (c - s.view.start) / s.view.dur;
      onView({ start: c - rel * dur, dur });
    } else {
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      onView({ start: s.view.start + (d / canvas.clientWidth) * s.view.dur, dur: s.view.dur });
    }
  }, { passive: false });

  let odrag = false;
  const centerAt = (e) => {
    const s = get();
    if (!s) return;
    const t = timeAtClient(overview, e.clientX, 0, s.duration);
    onView({ start: t - s.view.dur / 2, dur: s.view.dur });
  };
  overview.addEventListener('pointerdown', (e) => { odrag = true; overview.setPointerCapture(e.pointerId); centerAt(e); });
  overview.addEventListener('pointermove', (e) => { if (odrag) centerAt(e); });
  overview.addEventListener('pointerup', () => { odrag = false; });

  return { draw, drawOverview, invalidateColors };
}
