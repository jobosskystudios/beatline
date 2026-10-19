import { toMono, onsetEnvelope, estimateTempo, trackBeats, downbeatPhase, pickOnsets, hitEnvelope } from './dsp.js';
import { buildMarkers, markerKey, DENSITY } from './markers.js';
import { FRAME_RATES, MARKER_STYLES, buildFcpxml, buildCsv, snapMarkers } from './fcpxml.js';

const $ = (id) => document.getElementById(id);
const TIGHTNESS = [5, 10, 20, 40, 70, 100, 200, 400, 800, 1600];
const SETTINGS_KEY = 'beatline.settings.v1';

const DEFAULTS = {
  mode: 'beats', bpb: '4', density: 'beat', tight: '6', sens: '0.5',
  fps: '23.976', rounding: 'nearest', styleDown: 'chapter', styleBeat: 'standard',
  target: 'clip', folder: '', res: '1080p', version: '1.10', eventName: 'Beatline',
};

const state = {
  file: null,
  buffer: null,
  mono: null,
  peaks: null, // max |sample| per PEAK_BIN samples
  env: null,
  low: null,
  hopTime: 0,
  autoBpm: 0,
  bpm: 0,
  beats: [],
  onsets: [],
  autoPhase: 0,
  phaseShift: 0,
  markers: [],
  edits: { added: [], removed: new Set() },
  view: { start: 0, dur: 1 },
  settings: { ...DEFAULTS },
  click: false,
  lastPlayTime: 0,
};
const PEAK_BIN = 256;

let audioCtx = null;
const audio = new Audio();
audio.preload = 'auto';

// ---------- settings ----------

function loadSettings() {
  try {
    Object.assign(state.settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
  } catch { /* storage unavailable */ }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch { /* ignore */ }
}

function fillSelect(el, entries) {
  el.innerHTML = entries.map(([v, label]) => `<option value="${v}">${label}</option>`).join('');
}

function initControls() {
  fillSelect($('density'), Object.entries(DENSITY));
  fillSelect($('fps'), Object.keys(FRAME_RATES).map((k) => [k, `${k} fps`]));
  for (const el of document.querySelectorAll('select.style')) fillSelect(el, Object.entries(MARKER_STYLES));

  const s = state.settings;
  for (const id of ['bpb', 'density', 'tight', 'sens', 'fps', 'rounding', 'styleDown', 'styleBeat', 'folder', 'res', 'version', 'eventName']) {
    const el = $(id);
    if (s[id] !== undefined && [...(el.options || [{ value: s[id] }])].some((o) => o.value === String(s[id]))) el.value = s[id];
    el.addEventListener(el.type === 'range' || el.type === 'text' ? 'input' : 'change', () => {
      s[id] = el.value;
      saveSettings();
      onSettingChanged(id);
    });
  }
  setupSeg('mode');
  setupSeg('target');
  updateOutputs();

  $('bpm').addEventListener('change', () => retrack(true));
  $('half').addEventListener('click', () => scaleBpm(0.5));
  $('double').addEventListener('click', () => scaleBpm(2));
  $('phaseL').addEventListener('click', () => shiftPhase(-1));
  $('phaseR').addEventListener('click', () => shiftPhase(1));
  $('offset').addEventListener('input', refresh);
  $('resetEdits').addEventListener('click', () => {
    state.edits = { added: [], removed: new Set() };
    refresh();
  });
  $('exportXml').addEventListener('click', exportXml);
  $('exportCsv').addEventListener('click', exportCsv);
}

function setupSeg(id) {
  const root = $(id);
  const apply = () => {
    for (const b of root.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === state.settings[id]));
    for (const b of root.querySelectorAll('button')) {
      for (const el of document.querySelectorAll(`[data-for="${b.dataset.v}"]`)) el.hidden = b.dataset.v !== state.settings[id];
    }
  };
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.settings[id] = b.dataset.v;
    saveSettings();
    apply();
    onSettingChanged(id);
  });
  apply();
}

function updateOutputs() {
  $('tightOut').textContent = `(${state.settings.tight}/10)`;
  $('sensOut').textContent = `(${Math.round(state.settings.sens * 100)}%)`;
}

function onSettingChanged(id) {
  updateOutputs();
  if (!state.env) return;
  if (id === 'tight') retrack(false);
  else if (id === 'sens') { detectHits(); refresh(); }
  else if (id === 'bpb') { state.phaseShift = 0; state.autoPhase = downbeatPhase(state.beatFrames, state.low, +state.settings.bpb); refresh(); }
  else refresh();
}

// ---------- loading & analysis ----------

async function loadFile(file) {
  if (!file) return;
  audioCtx ??= new AudioContext();
  $('dropTitle').textContent = file.name;
  $('dropSub').textContent = 'Decoding…';
  try {
    const buffer = await audioCtx.decodeAudioData(await file.arrayBuffer());
    state.file = file;
    state.buffer = buffer;
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    state.mono = toMono(channels);
    state.peaks = computePeaks(state.mono);
    state.edits = { added: [], removed: new Set() };
    state.phaseShift = 0;
    $('bpm').value = '';
    if (audio.src) URL.revokeObjectURL(audio.src);
    audio.src = URL.createObjectURL(file);
    state.view = { start: 0, dur: buffer.duration };
    $('dropSub').textContent = 'Analyzing beats…';
    await new Promise((r) => setTimeout(r, 30)); // let the label paint
    const t0 = performance.now();
    const { env, low, hopTime } = onsetEnvelope(state.mono, buffer.sampleRate);
    Object.assign(state, { env, low, hopTime });
    state.autoBpm = estimateTempo(env, hopTime);
    detectHits();
    retrack(true);
    $('dropSub').textContent = `${fmtDur(buffer.duration)} · ${buffer.numberOfChannels} ch · analyzed in ${Math.round(performance.now() - t0)} ms · click to load another`;
    $('drop').classList.add('compact');
    $('waveEmpty').hidden = true;
    for (const id of ['play', 'clickToggle', 'zoomIn', 'zoomOut', 'zoomFit', 'exportXml', 'exportCsv']) $(id).disabled = false;
  } catch (err) {
    console.error(err);
    $('dropSub').textContent = 'Couldn’t decode that file. Try WAV, AIFF, MP3 or M4A.';
    toast('Couldn’t read that audio file');
  }
}

function computePeaks(mono) {
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

function detectHits() {
  state.onsets = pickOnsets(hitEnvelope(state.env, state.low), state.hopTime, +state.settings.sens);
}

function retrack(resetPhase) {
  if (!state.env) return;
  const manual = parseFloat($('bpm').value);
  state.bpm = manual > 0 ? manual : state.autoBpm;
  state.beatFrames = trackBeats(state.env, state.hopTime, state.bpm, TIGHTNESS[+state.settings.tight - 1]);
  state.beats = state.beatFrames.map((f) => f * state.hopTime);
  if (resetPhase) {
    state.phaseShift = 0;
    state.autoPhase = downbeatPhase(state.beatFrames, state.low, +state.settings.bpb);
  }
  refresh();
}

function scaleBpm(k) {
  if (!state.env) return;
  $('bpm').value = (state.bpm * k).toFixed(2);
  retrack(true);
}

function shiftPhase(d) {
  state.phaseShift += d;
  refresh();
}

// ---------- markers ----------

function refresh() {
  if (!state.env) return;
  const bpb = +state.settings.bpb;
  const phase = (((state.autoPhase + state.phaseShift) % bpb) + bpb) % bpb;
  state.markers = buildMarkers({
    mode: state.settings.mode,
    beats: state.beats,
    onsets: state.onsets,
    phase,
    beatsPerBar: bpb,
    density: state.settings.density,
    offset: (parseFloat($('offset').value) || 0) / 1000,
    edits: state.edits,
  });
  const rate = FRAME_RATES[state.settings.fps];
  const exported = snapMarkers(state.markers, rate, state.settings.rounding, exportStyles());
  $('sBpm').textContent = state.bpm ? state.bpm.toFixed(1) : '–';
  $('bpm').placeholder = state.autoBpm ? `auto (${state.autoBpm.toFixed(1)})` : 'auto';
  $('sBeats').textContent = state.settings.mode === 'hits' ? state.onsets.length : state.beats.length;
  $('sMarkers').textContent = exported.length;
  $('sDur').textContent = fmtDur(state.buffer.duration);
  $('resetEdits').disabled = !state.edits.added.length && !state.edits.removed.size;
  draw();
}

function exportStyles() {
  const s = state.settings;
  return { downbeat: s.styleDown, beat: s.styleBeat, hit: s.styleBeat, manual: 'todo' };
}

function toggleMarkerAt(time, pxTolerance) {
  const tol = (pxTolerance / canvas.clientWidth) * state.view.dur;
  let nearest = null;
  for (const m of state.markers) {
    if (Math.abs(m.time - time) <= tol && (!nearest || Math.abs(m.time - time) < Math.abs(nearest.time - time))) nearest = m;
  }
  if (nearest) {
    if (nearest.kind === 'manual') state.edits.added = state.edits.added.filter((t) => t !== nearest.time);
    else state.edits.removed.add(markerKey(nearest.time));
  } else {
    state.edits.added.push(time);
  }
  refresh();
}

// ---------- export ----------

function songBase() {
  return state.file.name.replace(/\.[^.]+$/, '');
}

function exportXml() {
  const s = state.settings;
  if (s.target === 'clip' && !s.folder.trim().startsWith('/')) {
    toast('Add the folder path of the song (starts with /) — or choose “Markers only”');
    $('folder').focus();
    return;
  }
  const name = songBase();
  const xml = buildFcpxml({
    markers: state.markers,
    fps: s.fps,
    resolution: s.res,
    rounding: s.rounding,
    version: s.version,
    styles: exportStyles(),
    target: s.target,
    song: {
      name,
      fileName: state.file.name,
      folder: s.folder.trim(),
      duration: state.buffer.duration,
      sampleRate: state.buffer.sampleRate,
      channels: state.buffer.numberOfChannels,
    },
    eventName: s.eventName || 'Beatline',
    projectName: `${name} – ${s.mode === 'hits' ? 'hits' : 'beats'}`,
  });
  download(`${name}.fcpxml`, xml, 'application/xml');
  toast('Saved. In Final Cut Pro: File › Import › XML…');
}

function exportCsv() {
  download(`${songBase()} markers.csv`, buildCsv(state.markers, state.settings.fps, state.settings.rounding), 'text/csv');
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- waveform ----------

const canvas = $('wave');
const ctx2d = canvas.getContext('2d');
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const KIND_COLOR = { downbeat: '--downbeat', beat: '--beat', hit: '--hit', manual: '--manual' };

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx2d.clearRect(0, 0, w, h);
  if (!state.buffer) return;

  const { start, dur } = state.view;
  const sr = state.buffer.sampleRate;
  const mid = h / 2;
  const xOf = (t) => ((t - start) / dur) * w;

  // Waveform (max |amplitude| per column).
  ctx2d.fillStyle = css('--wave-strong');
  const peaks = state.peaks;
  for (let x = 0; x < w; x++) {
    const b0 = Math.floor(((start + (x / w) * dur) * sr) / PEAK_BIN);
    const b1 = Math.max(b0 + 1, Math.floor(((start + ((x + 1) / w) * dur) * sr) / PEAK_BIN));
    let m = 0;
    for (let b = Math.max(0, b0); b < Math.min(peaks.length, b1); b++) if (peaks[b] > m) m = peaks[b];
    const y = Math.max(0.5, m * (h / 2 - 14));
    ctx2d.fillRect(x, mid - y, 1, y * 2);
  }

  // Markers.
  const colors = Object.fromEntries(Object.entries(KIND_COLOR).map(([k, v]) => [k, css(v)]));
  const pxPerSec = w / dur;
  const showLabels = state.settings.mode === 'beats' && pxPerSec * (60 / (state.bpm || 120)) * +state.settings.bpb > 36;
  ctx2d.font = '11px -apple-system, system-ui, sans-serif';
  for (const m of state.markers) {
    if (m.time < start || m.time > start + dur) continue;
    const x = Math.round(xOf(m.time)) + 0.5;
    ctx2d.strokeStyle = colors[m.kind];
    ctx2d.lineWidth = m.kind === 'beat' ? 1 : 2;
    ctx2d.globalAlpha = m.kind === 'beat' ? 0.85 : 1;
    ctx2d.beginPath();
    const inset = m.kind === 'beat' ? h * 0.18 : 0;
    ctx2d.moveTo(x, inset);
    ctx2d.lineTo(x, h - inset);
    ctx2d.stroke();
    ctx2d.globalAlpha = 1;
    if (showLabels && m.kind === 'downbeat') {
      ctx2d.fillStyle = colors.downbeat;
      ctx2d.fillText(m.label.replace('Bar ', ''), x + 3, 12);
    }
  }

  // Playhead.
  const px = xOf(audio.currentTime || 0);
  if (px >= 0 && px <= w) {
    ctx2d.fillStyle = css('--text');
    ctx2d.fillRect(Math.round(px) - 1, 0, 2, h);
  }
}

function clampView() {
  const total = state.buffer.duration;
  state.view.dur = Math.min(total, Math.max(0.5, state.view.dur));
  state.view.start = Math.min(total - state.view.dur, Math.max(0, state.view.start));
}

function zoomAt(factor, centerTime) {
  if (!state.buffer) return;
  const c = centerTime ?? state.view.start + state.view.dur / 2;
  const rel = (c - state.view.start) / state.view.dur;
  state.view.dur *= factor;
  state.view.start = c - rel * state.view.dur;
  clampView();
  draw();
}

const timeAtX = (clientX) => {
  const r = canvas.getBoundingClientRect();
  return state.view.start + ((clientX - r.left) / r.width) * state.view.dur;
};

canvas.addEventListener('wheel', (e) => {
  if (!state.buffer) return;
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    zoomAt(Math.exp(e.deltaY * 0.01), timeAtX(e.clientX));
  } else {
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    state.view.start += (d / canvas.clientWidth) * state.view.dur;
    clampView();
    draw();
  }
}, { passive: false });

canvas.addEventListener('click', (e) => {
  if (!state.buffer) return;
  const t = timeAtX(e.clientX);
  if (e.shiftKey) toggleMarkerAt(t, 6);
  else {
    audio.currentTime = Math.max(0, t);
    state.lastPlayTime = audio.currentTime;
    updateTime();
    draw();
  }
});

// ---------- playback ----------

function togglePlay() {
  if (!state.buffer) return;
  audioCtx?.resume();
  if (audio.paused) audio.play(); else audio.pause();
}

audio.addEventListener('play', () => {
  $('play').textContent = '❚❚ Pause';
  state.lastPlayTime = audio.currentTime;
  requestAnimationFrame(tick);
});
audio.addEventListener('pause', () => { $('play').textContent = '▶ Play'; draw(); });
audio.addEventListener('ended', () => { $('play').textContent = '▶ Play'; });

function tick() {
  const now = audio.currentTime;
  if (state.click && now > state.lastPlayTime) {
    for (const m of state.markers) if (m.time > state.lastPlayTime && m.time <= now) playClick(m.kind === 'downbeat');
  }
  state.lastPlayTime = now;
  const { start, dur } = state.view;
  if (now > start + dur * 0.92 || now < start) {
    state.view.start = now - dur * 0.1;
    clampView();
  }
  updateTime();
  draw();
  if (!audio.paused) requestAnimationFrame(tick);
}

function playClick(accent) {
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.frequency.value = accent ? 1760 : 1100;
  g.gain.setValueAtTime(accent ? 0.5 : 0.3, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
  osc.connect(g).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + 0.06);
}

function updateTime() {
  $('time').textContent = fmtTime(audio.currentTime || 0);
}

// ---------- misc ----------

function fmtTime(t) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}
function fmtDur(t) {
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
}

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function initDrop() {
  const drop = $('drop');
  $('file').addEventListener('change', (e) => loadFile(e.target.files[0]));
  for (const ev of ['dragenter', 'dragover']) {
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  }
  for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('over'));
  // The drop itself is handled on window, so dropping anywhere on the page works.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
}

function initKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'm' || e.key === 'M') { if (state.buffer) { state.edits.added.push(audio.currentTime); refresh(); } }
    else if (e.key === '+' || e.key === '=') zoomAt(0.5);
    else if (e.key === '-') zoomAt(2);
  });
}

$('play').addEventListener('click', togglePlay);
$('clickToggle').addEventListener('click', () => {
  state.click = !state.click;
  $('clickToggle').setAttribute('aria-pressed', String(state.click));
  audioCtx?.resume();
});
$('zoomIn').addEventListener('click', () => zoomAt(0.5));
$('zoomOut').addEventListener('click', () => zoomAt(2));
$('zoomFit').addEventListener('click', () => { if (state.buffer) { state.view = { start: 0, dur: state.buffer.duration }; draw(); } });
window.addEventListener('resize', draw);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', draw);

loadSettings();
initControls();
initDrop();
initKeys();
draw();
