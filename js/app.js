import { toMono, onsetEnvelope, estimateTempo, trackBeats, downbeatPhase, pickOnsets, hitEnvelope } from './dsp.js';
import { buildMarkers, markerKey, DENSITY, PACING, AUTO_DEFAULT } from './markers.js';
import { FRAME_RATES, MARKER_STYLES, buildFcpxml, buildCsv, buildShotCsv, toFrame, timecode } from './fcpxml.js';
import { barGrid, detectSections, sectionMarkers, LEVEL_LABEL } from './structure.js';
import { planCuts, sectionSummary } from './cutplan.js';

const $ = (id) => document.getElementById(id);
const TIGHTNESS = [5, 10, 20, 40, 70, 100, 200, 400, 800, 1600];
const SETTINGS_KEY = 'beatline.settings.v1';
const PEAK_BIN = 256;
const BAND = 18; // px height of the section band above the waveform

const DEFAULTS = {
  mode: 'beats', bpb: '4', density: 'beat', tight: '6', sens: '0.5', minShot: '0.5',
  autoLow: AUTO_DEFAULT.low, autoMid: AUTO_DEFAULT.mid, autoHigh: AUTO_DEFAULT.high,
  fps: '23.976', rounding: 'nearest', styleSection: 'chapter', styleDown: 'standard', styleBeat: 'standard',
  target: 'clip', folder: '', res: '1080p', version: '1.10', eventName: 'Beatline',
};

const state = {
  file: null,
  buffer: null,
  mono: null,
  peaks: null,
  env: null,
  low: null,
  hopTime: 0,
  autoBpm: 0,
  bpm: 0,
  beatFrames: [],
  beats: [],
  onsets: [],
  autoPhase: 0,
  phaseShift: 0,
  bars: [],
  sections: [],
  structureKey: '',
  markers: [],
  plan: null,
  cutTimes: [],
  range: { in: null, out: null },
  edits: { added: [], removed: new Set() },
  view: { start: 0, dur: 1 },
  settings: { ...DEFAULTS },
  click: false,
  lastPlayTime: 0,
  taps: [],
};

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

const SETTING_IDS = ['bpb', 'density', 'tight', 'sens', 'minShot', 'autoLow', 'autoMid', 'autoHigh', 'fps', 'rounding',
  'styleSection', 'styleDown', 'styleBeat', 'folder', 'res', 'version', 'eventName'];

function initControls() {
  fillSelect($('density'), Object.entries(DENSITY));
  for (const el of document.querySelectorAll('select.pace')) fillSelect(el, Object.entries(PACING));
  fillSelect($('fps'), Object.keys(FRAME_RATES).map((k) => [k, `${k} fps`]));
  for (const el of document.querySelectorAll('select.style')) fillSelect(el, Object.entries(MARKER_STYLES));

  const s = state.settings;
  for (const id of SETTING_IDS) {
    const el = $(id);
    const valid = el.tagName !== 'SELECT' || [...el.options].some((o) => o.value === String(s[id]));
    if (s[id] !== undefined && valid) el.value = s[id];
    else s[id] = el.value;
    const live = el.type === 'range' || el.type === 'text' || el.type === 'number';
    el.addEventListener(live ? 'input' : 'change', () => {
      s[id] = el.value;
      saveSettings();
      onSettingChanged(id);
    });
  }
  setupSeg('mode');
  setupSeg('target');
  updateVisibility();

  $('bpm').addEventListener('change', () => retrack(true));
  $('tap').addEventListener('click', tapTempo);
  $('half').addEventListener('click', () => scaleBpm(0.5));
  $('double').addEventListener('click', () => scaleBpm(2));
  $('phaseL').addEventListener('click', () => shiftPhase(-1));
  $('phaseR').addEventListener('click', () => shiftPhase(1));
  $('offset').addEventListener('input', refresh);
  $('resetEdits').addEventListener('click', () => {
    state.edits = { added: [], removed: new Set() };
    refresh();
  });
  $('setIn').addEventListener('click', () => setRangeEdge('in'));
  $('setOut').addEventListener('click', () => setRangeEdge('out'));
  $('clearRange').addEventListener('click', clearRange);
  for (const b of document.querySelectorAll('[data-fit]')) b.addEventListener('click', () => quickRange(+b.dataset.fit));
  $('exportXml').addEventListener('click', exportXml);
  $('exportCsv').addEventListener('click', exportCsv);
  $('exportShots').addEventListener('click', exportShots);
  $('copyXml').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('xmlText').value);
      toast('Copied FCPXML');
    } catch {
      $('xmlText').select();
      toast('Press ⌘C to copy');
    }
  });
}

function setupSeg(id) {
  const root = $(id);
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.settings[id] = b.dataset.v;
    saveSettings();
    updateVisibility();
    onSettingChanged(id);
  });
}

function updateVisibility() {
  const s = state.settings;
  for (const id of ['mode', 'target']) {
    const values = [...$(id).querySelectorAll('button')].map((b) => b.dataset.v);
    for (const b of $(id).querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === s[id]));
    for (const el of document.querySelectorAll('[data-for]')) {
      const tokens = el.dataset.for.split(' ');
      if (tokens.some((t) => values.includes(t))) el.hidden = !tokens.includes(s[id]);
    }
  }
  for (const el of document.querySelectorAll('[data-for-density]')) el.hidden = s.density !== el.dataset.forDensity;
  $('tightOut').textContent = `(${s.tight}/10)`;
  $('sensOut').textContent = `(${Math.round(s.sens * 100)}%)`;
}

function onSettingChanged(id) {
  updateVisibility();
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
    state.range = { in: null, out: null };
    state.phaseShift = 0;
    state.structureKey = '';
    $('bpm').value = '';
    if (audio.src) URL.revokeObjectURL(audio.src);
    audio.src = URL.createObjectURL(file);
    state.view = { start: 0, dur: buffer.duration };
    $('dropSub').textContent = 'Analyzing beats and sections…';
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
    $('planPanel').hidden = false;
    for (const id of ['play', 'clickToggle', 'zoomIn', 'zoomOut', 'zoomFit', 'exportXml', 'exportCsv', 'exportShots']) $(id).disabled = false;
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

function tapTempo() {
  const now = performance.now() / 1000;
  if (state.taps.length && now - state.taps[state.taps.length - 1] > 2) state.taps = [];
  state.taps.push(now);
  if (state.taps.length < 4) {
    toast(`Keep tapping… ${4 - state.taps.length} more`);
    return;
  }
  const gaps = state.taps.slice(1).map((t, i) => t - state.taps[i]).sort((a, b) => a - b);
  const bpm = 60 / gaps[Math.floor(gaps.length / 2)];
  $('bpm').value = bpm.toFixed(1);
  toast(`Tapped ${bpm.toFixed(1)} BPM`);
  if (state.env) retrack(true);
}

// ---------- range ----------

const rate = () => FRAME_RATES[state.settings.fps];
const songFrames = () => Math.max(1, Math.floor((state.buffer.duration * rate().den) / rate().num));
const frameSec = (f) => (f * rate().num) / rate().den;

function rangeFrames() {
  const total = songFrames();
  let a = state.range.in == null ? 0 : toFrame(state.range.in, rate(), 'nearest');
  let b = state.range.out == null ? total : toFrame(state.range.out, rate(), 'nearest');
  a = Math.min(Math.max(0, a), total - 1);
  b = Math.min(Math.max(a + 1, b), total);
  return { inFrame: a, outFrame: b };
}

function setRangeEdge(edge) {
  if (!state.buffer) return;
  const t = audio.currentTime || 0;
  state.range[edge] = t;
  const { in: a, out: b } = state.range;
  if (a != null && b != null && b <= a) state.range[edge === 'in' ? 'out' : 'in'] = null;
  refresh();
}

function clearRange() {
  state.range = { in: null, out: null };
  refresh();
}

// A range of about `seconds`, starting on the bar line nearest the playhead
// and ending on a bar line, so the music edit lands on the grid.
function quickRange(seconds) {
  if (!state.buffer) return;
  const lines = [0, ...state.bars.map((b) => b.start), state.buffer.duration];
  const nearest = (t) => lines.reduce((p, c) => (Math.abs(c - t) < Math.abs(p - t) ? c : p), lines[0]);
  const a = nearest(audio.currentTime || 0);
  let b = nearest(a + seconds);
  if (b <= a) b = Math.min(state.buffer.duration, a + seconds);
  state.range = { in: a, out: b };
  state.view = { start: Math.max(0, a - seconds * 0.1), dur: Math.min(state.buffer.duration, seconds * 1.2) };
  clampView();
  refresh();
}

// ---------- markers, structure & cut plan ----------

function phase() {
  const bpb = +state.settings.bpb;
  return (((state.autoPhase + state.phaseShift) % bpb) + bpb) % bpb;
}

function updateStructure() {
  const key = `${state.beats.length}|${state.beats[0]}|${state.bpm}|${phase()}|${state.settings.bpb}`;
  if (key === state.structureKey) return;
  state.structureKey = key;
  state.bars = barGrid(state.beats, phase(), +state.settings.bpb, state.buffer.duration);
  state.sections = detectSections(state.mono, state.buffer.sampleRate, state.bars, state.buffer.duration);
}

function refresh() {
  if (!state.env) return;
  updateStructure();
  const s = state.settings;
  state.markers = buildMarkers({
    mode: s.mode,
    beats: state.beats,
    onsets: state.onsets,
    phase: phase(),
    beatsPerBar: +s.bpb,
    density: s.density,
    offset: (parseFloat($('offset').value) || 0) / 1000,
    edits: state.edits,
    sections: state.sections,
    autoMap: { low: s.autoLow, mid: s.autoMid, high: s.autoHigh },
  });
  const { inFrame, outFrame } = rangeFrames();
  const fps = rate().den / rate().num;
  state.plan = planCuts({
    markers: state.markers,
    rate: rate(),
    rounding: s.rounding,
    inFrame,
    outFrame,
    minShotFrames: Math.round((parseFloat(s.minShot) || 0) * fps),
    sections: state.sections,
  });
  state.cutTimes = state.plan.cuts.map(frameSec);

  const st = state.plan.stats;
  $('sBpm').textContent = state.bpm ? state.bpm.toFixed(1) : '–';
  $('bpm').placeholder = state.autoBpm ? `auto (${state.autoBpm.toFixed(1)})` : 'auto';
  $('sCuts').textContent = st.cuts;
  $('sShots').textContent = st.shots;
  $('sAsl').textContent = `${st.avgShot.toFixed(1)}s`;
  $('sCpm').textContent = st.cutsPerMin.toFixed(0);
  $('sLen').textContent = fmtDur(st.lengthSec);
  const ranged = state.range.in != null || state.range.out != null;
  $('sLenLabel').textContent = ranged ? 'range length' : 'length';
  $('rangeLabel').textContent = ranged
    ? `${timecode(inFrame, rate())} → ${timecode(outFrame, rate())}`
    : 'Whole song';
  $('resetEdits').disabled = !state.edits.added.length && !state.edits.removed.size;
  renderPlan(inFrame, outFrame);
  draw();
}

const LEVEL_VAR = { low: '--lvl-low', mid: '--lvl-mid', high: '--lvl-high' };

function renderPlan(inFrame, outFrame) {
  const rows = sectionSummary(state.sections, state.plan, rate(), inFrame, outFrame);
  const dbs = state.sections.map((x) => x.db);
  const lo = Math.min(...dbs);
  const hi = Math.max(...dbs);
  $('sectionTable').tBodies[0].innerHTML = rows.map((r) => {
    const x = r.section;
    const pct = hi > lo ? Math.round(15 + (85 * (x.db - lo)) / (hi - lo)) : 60;
    return `<tr class="clickable" data-t="${r.start}">
      <td>${r.n}</td>
      <td><span class="chip"><i class="dot" style="background:var(${LEVEL_VAR[x.level]})"></i>${x.label}</span></td>
      <td>${fmtTime(r.start)}</td>
      <td>${x.firstBar}–${x.lastBar}</td>
      <td><span class="meter"><i style="width:${pct}%;background:var(${LEVEL_VAR[x.level]})"></i></span>${LEVEL_LABEL[x.level]}</td>
      <td>${r.cuts}</td>
      <td>${r.avgShot.toFixed(1)}s</td>
    </tr>`;
  }).join('');

  const st = state.plan.stats;
  const notes = [`Shortest shot ${st.shortest.toFixed(2)}s`, `longest ${st.longest.toFixed(2)}s`];
  if (st.dropped > 0) notes.push(`${st.dropped} cut${st.dropped > 1 ? 's' : ''} skipped by the shortest-shot limit (shown faded)`);
  $('planNote').textContent = notes.join(' · ') + '.';

  $('shotSummary').textContent = `Shot list: ${st.shots} shots`;
  $('shotTable').tBodies[0].innerHTML = state.plan.shots.map((x) => `<tr class="clickable" data-t="${frameSec(x.start)}">
      <td>${x.index}</td>
      <td>${timecode(x.start - inFrame, rate())}</td>
      <td>${x.seconds.toFixed(2)}s</td>
      <td>${x.frames}</td>
      <td>${x.section ? `<i class="dot" style="background:var(${LEVEL_VAR[x.section.level]})"></i>${x.section.label}` : ''}</td>
    </tr>`).join('');
}

function onTableClick(e) {
  const tr = e.target.closest('tr[data-t]');
  if (!tr) return;
  seek(+tr.dataset.t);
  const t = +tr.dataset.t;
  if (t < state.view.start || t > state.view.start + state.view.dur) {
    state.view.start = t - state.view.dur * 0.1;
    clampView();
  }
  draw();
}
$('sectionTable').addEventListener('click', onTableClick);
$('shotTable').addEventListener('click', onTableClick);

function exportStyles() {
  const s = state.settings;
  return { section: s.styleSection, downbeat: s.styleDown, beat: s.styleBeat, hit: s.styleBeat, manual: 'todo' };
}

// Only cuts that survive the shortest-shot rule are exported, plus section markers.
function exportMarkers() {
  const cutFrames = new Set(state.plan.cuts);
  const cuts = state.markers.filter((m) => cutFrames.has(toFrame(m.time, rate(), state.settings.rounding)));
  return [...cuts, ...sectionMarkers(state.sections)];
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
  if (s.target !== 'gap' && !s.folder.trim().startsWith('/')) {
    toast('Add the song’s folder path (starts with /), or choose “Markers only”');
    $('folder').focus();
    return;
  }
  const name = songBase();
  const kind = { clip: 'markers', blocked: 'pre-cut', gap: 'markers only' }[s.target];
  const xml = buildFcpxml({
    markers: exportMarkers(),
    fps: s.fps,
    resolution: s.res,
    rounding: s.rounding,
    version: s.version,
    styles: exportStyles(),
    target: s.target,
    range: rangeFrames(),
    shots: state.plan.shots,
    song: {
      name,
      fileName: state.file.name,
      folder: s.folder.trim(),
      duration: state.buffer.duration,
      sampleRate: state.buffer.sampleRate,
      channels: state.buffer.numberOfChannels,
    },
    eventName: s.eventName || 'Beatline',
    projectName: `${name} – ${kind} (${state.plan.stats.cuts} cuts)`,
  });
  download(`${name} ${kind}.fcpxml`, xml, 'application/xml');
  $('xmlText').value = xml;
  $('xmlBox').hidden = false;
  toast('Saved. In Final Cut Pro: File › Import › XML…');
}

function exportCsv() {
  download(`${songBase()} markers.csv`, buildCsv(exportMarkers(), state.settings.fps, state.settings.rounding), 'text/csv');
}

function exportShots() {
  download(`${songBase()} shot list.csv`, buildShotCsv(state.plan.shots, state.settings.fps, rangeFrames().inFrame), 'text/csv');
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
  const top = BAND + 2;
  const mid = top + (h - top) / 2;
  const xOf = (t) => ((t - start) / dur) * w;
  ctx2d.font = '11px -apple-system, system-ui, sans-serif';

  // Section band.
  for (const s of state.sections) {
    const x0 = Math.max(0, xOf(s.start));
    const x1 = Math.min(w, xOf(s.end));
    if (x1 <= 0 || x0 >= w) continue;
    ctx2d.fillStyle = css(LEVEL_VAR[s.level]);
    ctx2d.globalAlpha = 0.85;
    ctx2d.fillRect(x0, 0, x1 - x0 - 1, BAND);
    ctx2d.globalAlpha = 1;
    if (x1 - x0 > 44) {
      ctx2d.fillStyle = '#fff';
      ctx2d.fillText(s.drop ? '▼ DROP' : s.label, x0 + 5, 13);
    }
  }

  // Waveform (max |amplitude| per column).
  ctx2d.fillStyle = css('--wave-strong');
  const peaks = state.peaks;
  const half = (h - top) / 2 - 6;
  for (let x = 0; x < w; x++) {
    const b0 = Math.floor(((start + (x / w) * dur) * sr) / PEAK_BIN);
    const b1 = Math.max(b0 + 1, Math.floor(((start + ((x + 1) / w) * dur) * sr) / PEAK_BIN));
    let m = 0;
    for (let b = Math.max(0, b0); b < Math.min(peaks.length, b1); b++) if (peaks[b] > m) m = peaks[b];
    const y = Math.max(0.5, m * half);
    ctx2d.fillRect(x, mid - y, 1, y * 2);
  }

  // Cut markers; markers that aren't cuts (range, shortest-shot rule) are faded.
  const colors = Object.fromEntries(Object.entries(KIND_COLOR).map(([k, v]) => [k, css(v)]));
  const cutFrames = new Set(state.plan?.cuts ?? []);
  const pxPerSec = w / dur;
  const showLabels = state.settings.mode === 'beats' && pxPerSec * (60 / (state.bpm || 120)) * +state.settings.bpb > 36;
  for (const m of state.markers) {
    if (m.time < start || m.time > start + dur) continue;
    const isCut = cutFrames.has(toFrame(m.time, rate(), state.settings.rounding));
    const x = Math.round(xOf(m.time)) + 0.5;
    ctx2d.strokeStyle = colors[m.kind];
    ctx2d.lineWidth = m.kind === 'beat' ? 1 : 2;
    ctx2d.globalAlpha = isCut ? (m.kind === 'beat' ? 0.85 : 1) : 0.25;
    ctx2d.beginPath();
    const inset = m.kind === 'beat' ? (h - top) * 0.18 : 0;
    ctx2d.moveTo(x, top + inset);
    ctx2d.lineTo(x, h - inset);
    ctx2d.stroke();
    ctx2d.globalAlpha = 1;
    if (showLabels && m.kind === 'downbeat') {
      ctx2d.fillStyle = colors.downbeat;
      ctx2d.fillText(m.label.replace('Bar ', ''), x + 3, top + 12);
    }
  }

  // Range: dim what's outside, edge lines inside.
  if (state.range.in != null || state.range.out != null) {
    const { inFrame, outFrame } = rangeFrames();
    const a = xOf(frameSec(inFrame));
    const b = xOf(frameSec(outFrame));
    ctx2d.fillStyle = css('--dim');
    if (a > 0) ctx2d.fillRect(0, top, Math.min(w, a), h - top);
    if (b < w) ctx2d.fillRect(Math.max(0, b), top, w - Math.max(0, b), h - top);
    ctx2d.fillStyle = css('--accent');
    for (const x of [a, b]) if (x >= 0 && x <= w) ctx2d.fillRect(Math.round(x) - 1, top, 2, h - top);
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
  else { seek(t); draw(); }
});

// ---------- playback ----------

function seek(t) {
  audio.currentTime = Math.max(0, t);
  state.lastPlayTime = audio.currentTime;
  updateTime();
}

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
    const downs = new Set(state.markers.filter((m) => m.kind === 'downbeat').map((m) => toFrame(m.time, rate(), state.settings.rounding)));
    state.plan.cuts.forEach((f, i) => {
      const t = state.cutTimes[i];
      if (t > state.lastPlayTime && t <= now) playClick(downs.has(f));
    });
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
    if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (k === 't') tapTempo();
    else if (!state.buffer) return;
    else if (k === 'm') { state.edits.added.push(audio.currentTime); refresh(); }
    else if (k === 'i') setRangeEdge('in');
    else if (k === 'o') setRangeEdge('out');
    else if (k === 'x') clearRange();
    else if (k === '+' || k === '=') zoomAt(0.5);
    else if (k === '-') zoomAt(2);
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
