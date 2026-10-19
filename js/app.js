import { toMono, trackBeats, pickOnsets, hitEnvelope } from './dsp.js';
import { analyzeSong, beatChroma, detectMeter, tempoStability, drumHits } from './analysis.js';
import { buildMarkers, markerKey, DENSITY, PACING, AUTO_DEFAULT } from './markers.js';
import { FRAME_RATES, MARKER_STYLES, buildFcpxml, buildCsv, buildShotCsv, toFrame, timecode } from './fcpxml.js';
import { barGrid, detectSections, sectionMarkers, LEVEL_LABEL } from './structure.js';
import { planCuts, sectionSummary } from './cutplan.js';
import { Player } from './player.js';
import { createTimeline, computePeaks, bandNorms } from './timeline.js';
import { readAudioInfo } from './fileinfo.js';

const $ = (id) => document.getElementById(id);
const TIGHTNESS = [5, 10, 20, 40, 70, 100, 200, 400, 800, 1600];
const SETTINGS_KEY = 'beatline.settings.v2';

const DEFAULTS = {
  mode: 'beats', density: 'bar', tight: '6', sens: '0.5', minShot: '0.5', lead: '0',
  autoLow: AUTO_DEFAULT.low, autoMid: AUTO_DEFAULT.mid, autoHigh: AUTO_DEFAULT.high,
  drumKick: true, drumSnare: true, drumHat: false,
  fps: '23.976', rounding: 'nearest', styleSection: 'chapter', styleDown: 'standard', styleBeat: 'standard',
  target: 'clip', folder: '', res: '1080p', version: '1.10', eventName: 'Beatline',
};
const SETTING_IDS = ['density', 'tight', 'sens', 'minShot', 'lead', 'autoLow', 'autoMid', 'autoHigh', 'fps', 'rounding',
  'styleSection', 'styleDown', 'styleBeat', 'folder', 'res', 'version', 'eventName'];
const DRUM_IDS = { drumKick: 'kick', drumSnare: 'snare', drumHat: 'hat' };

const state = {
  settings: { ...DEFAULTS },
  file: null,
  audioInfo: null,
  buffer: null,
  mono: null,
  wave: null,
  o: null,
  chroma: null,
  info: null,
  drums: { kick: [], snare: [], hat: [] },
  autoBpm: 0,
  bpm: 0,
  beatFrames: [],
  beats: [],
  onsets: [],
  bpb: 4,
  bpbAuto: true,
  autoPhase: 0,
  phaseShift: 0,
  stability: null,
  bars: [],
  sections: [],
  structureKey: '',
  markers: [],
  plan: null,
  cutFrames: new Set(),
  range: { in: null, out: null },
  edits: { added: [], removed: new Set() },
  view: { start: 0, dur: 1 },
  taps: [],
  server: null, // true when served by beatline.command (can locate files)
  locate: { status: 'idle', paths: [] },
};

let audioCtx = null;
let player = null;

// ---------- settings ----------

function loadSettings() {
  try { Object.assign(state.settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch { /* storage unavailable */ }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch { /* ignore */ }
}
const fillSelect = (el, entries) => { el.innerHTML = entries.map(([v, l]) => `<option value="${v}">${l}</option>`).join(''); };

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
    const live = ['range', 'text', 'number'].includes(el.type);
    el.addEventListener(live ? 'input' : 'change', () => {
      s[id] = el.value;
      saveSettings();
      onSetting(id);
    });
  }
  for (const id of Object.keys(DRUM_IDS)) {
    $(id).checked = !!s[id];
    $(id).addEventListener('change', () => { s[id] = $(id).checked; saveSettings(); refresh(); });
  }
  for (const id of ['mode', 'target']) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      s[id] = b.dataset.v;
      saveSettings();
      updateVisibility();
      onSetting(id);
    });
  }
  for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));

  $('bpb').addEventListener('change', () => {
    state.bpb = +$('bpb').value;
    state.bpbAuto = false;
    state.structureKey = '';
    phaseFromAudio();
    refresh();
  });
  $('bpm').addEventListener('change', () => retrack(true));
  $('tap').addEventListener('click', tapTempo);
  $('half').addEventListener('click', () => setBpm(state.bpm / 2));
  $('double').addEventListener('click', () => setBpm(state.bpm * 2));
  $('phaseL').addEventListener('click', () => { state.phaseShift--; refresh(); });
  $('phaseR').addEventListener('click', () => { state.phaseShift++; refresh(); });
  $('barHere').addEventListener('click', barOneAtPlayhead);
  $('offset').addEventListener('input', refresh);
  $('nudgeL').addEventListener('click', () => nudge(-10));
  $('nudgeR').addEventListener('click', () => nudge(10));
  $('resetEdits').addEventListener('click', () => { state.edits = { added: [], removed: new Set() }; refresh(); });
  $('setIn').addEventListener('click', () => setRangeEdge('in'));
  $('setOut').addEventListener('click', () => setRangeEdge('out'));
  $('clearRange').addEventListener('click', clearRange);
  for (const b of document.querySelectorAll('[data-fit]')) b.addEventListener('click', () => quickRange(+b.dataset.fit));
  $('exportXml').addEventListener('click', exportXml);
  $('exportXml2').addEventListener('click', exportXml);
  $('exportCsv').addEventListener('click', exportCsv);
  $('exportShots').addEventListener('click', exportShots);
  $('copyXml').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('xmlText').value); toast('Copied FCPXML'); } catch { $('xmlText').select(); toast('Press ⌘C to copy'); }
  });
  $('folder').addEventListener('change', verifyFolder);
  $('sectionTable').addEventListener('click', onRowClick);
  $('shotTable').addEventListener('click', onRowClick);
  $('play').addEventListener('click', togglePlay);
  $('clickToggle').addEventListener('click', toggleClick);
  $('zoomIn').addEventListener('click', () => zoom(0.5));
  $('zoomOut').addEventListener('click', () => zoom(2));
  $('zoomFit').addEventListener('click', fitView);
  updateVisibility();
}

function showTab(tab) {
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const p of document.querySelectorAll('.tabpanel')) p.hidden = p.dataset.panel !== tab;
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
  for (const el of document.querySelectorAll('[data-mode-only]')) el.hidden = el.dataset.modeOnly !== s.mode;
  $('tightOut').textContent = `(${s.tight}/10)`;
  $('sensOut').textContent = `(${Math.round(s.sens * 100)}%)`;
}

function onSetting(id) {
  updateVisibility();
  if (!state.o) return;
  if (id === 'tight') retrack(false);
  else if (id === 'sens') { detectHits(); refresh(); }
  else if (id === 'fps') { refresh(); updateTime(); }
  else refresh();
}

// ---------- loading & analysis ----------

async function loadFile(file) {
  if (!file) return;
  audioCtx ??= new AudioContext();
  player ??= new Player(audioCtx);
  player.stop();
  setBusy(`Reading ${file.name}…`);
  $('fileName').textContent = file.name;
  $('fileMeta').textContent = 'Decoding…';
  try {
    const bytes = await file.arrayBuffer();
    state.audioInfo = readAudioInfo(bytes.slice(0, 1 << 20));
    let buffer;
    try {
      buffer = await audioCtx.decodeAudioData(bytes);
    } catch {
      $('fileMeta').textContent = 'Couldn’t read this file';
      setBusy(null, 'That file couldn’t be decoded. Try WAV, AIFF, MP3 or M4A.');
      toast('Couldn’t read that audio file');
      return;
    }
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    Object.assign(state, {
      file, buffer,
      mono: toMono(channels),
      edits: { added: [], removed: new Set() },
      range: { in: null, out: null },
      phaseShift: 0,
      bpbAuto: true,
      structureKey: '',
      view: { start: 0, dur: buffer.duration },
      locate: { status: 'idle', paths: [] },
    });
    $('bpm').value = '';
    $('offset').value = '0';
    player.load(buffer);
    setBusy('Listening: tempo, bars, sections, key, loudness…');
    const t0 = performance.now();
    const result = await analyzeInBackground(channels, buffer.sampleRate);
    applyAnalysis(result);
    // Open on the first 8 bars, where you can see each beat against the waveform.
    const firstBeat = state.beats[0] ?? 0;
    setView({ start: Math.max(0, firstBeat - 0.5), dur: Math.min(buffer.duration, (60 / state.bpm) * state.bpb * 8 + 1) });
    const rate = state.audioInfo?.sampleRate ?? buffer.sampleRate;
    $('fileMeta').textContent = `${fmtDur(buffer.duration)} · ${(rate / 1000).toFixed(1)} kHz · ${buffer.numberOfChannels} ch · ${Math.round(performance.now() - t0)} ms`;
    showWorkspace();
    locateSong();
  } catch (err) {
    console.error(err);
    setBusy(null, `Analysis failed: ${err.message}. Please report this with the song’s format.`);
    toast('Analysis failed');
  }
}

function analyzeInBackground(channels, sampleRate) {
  const copies = channels.map((c) => c.slice());
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    } catch {
      resolve(analyzeSong({ channels: copies, sampleRate }));
      return;
    }
    worker.onmessage = ({ data }) => {
      worker.terminate();
      if (data.ok) resolve(data.result);
      else reject(new Error(data.error));
    };
    worker.onerror = (e) => {
      // Module workers unavailable: analyse inline instead.
      e.preventDefault();
      worker.terminate();
      try { resolve(analyzeSong({ channels: channels.map((c) => c.slice()), sampleRate })); } catch (err) { reject(err); }
    };
    worker.postMessage({ channels: copies, sampleRate }, copies.map((c) => c.buffer));
  });
}

function applyAnalysis(r) {
  state.o = r.o;
  state.chroma = r.chroma;
  state.info = r.info;
  state.drums = r.drums;
  state.autoBpm = r.bpm;
  state.bpb = r.info.meter.beatsPerBar;
  $('bpb').value = String(state.bpb);
  state.wave = {
    peaks: computePeaks(state.mono),
    bands: r.o.bands,
    hopTime: r.o.hopTime,
    norms: bandNorms(r.o.bands),
    sampleRate: state.buffer.sampleRate,
  };
  detectHits();
  retrack(true);
}

function detectHits() {
  const sens = +state.settings.sens;
  state.onsets = pickOnsets(hitEnvelope(state.o.env, state.o.low), state.o.hopTime, sens, 0.08, state.o.active);
  if (state.drums) state.drums = drumHits(state.o, sens);
}

function retrack(resetPhase) {
  if (!state.o) return;
  const manual = parseFloat($('bpm').value);
  state.bpm = manual > 0 ? manual : state.autoBpm;
  state.beatFrames = trackBeats(state.o.env, state.o.hopTime, state.bpm, TIGHTNESS[+state.settings.tight - 1], state.o.active);
  state.beats = state.beatFrames.map((f) => f * state.o.hopTime);
  state.stability = tempoStability(state.beats);
  state.structureKey = '';
  if (resetPhase) {
    state.phaseShift = 0;
    phaseFromAudio();
  }
  refresh();
}

function phaseFromAudio() {
  const meter = detectMeter(state.beatFrames, state.o.low, beatChroma(state.chroma, state.beats, state.buffer.duration), { candidates: [state.bpb] });
  state.autoPhase = meter.phase;
}

function setBpm(bpm) {
  if (!state.o) return;
  $('bpm').value = bpm.toFixed(2);
  retrack(true);
}

function tapTempo() {
  const now = performance.now() / 1000;
  if (state.taps.length && now - state.taps[state.taps.length - 1] > 2) state.taps = [];
  state.taps.push(now);
  if (state.taps.length < 4) { toast(`Keep tapping… ${4 - state.taps.length} more`); return; }
  const gaps = state.taps.slice(1).map((t, i) => t - state.taps[i]).sort((a, b) => a - b);
  const bpm = 60 / gaps[Math.floor(gaps.length / 2)];
  toast(`Tapped ${bpm.toFixed(1)} BPM`);
  if (state.o) setBpm(bpm); else $('bpm').value = bpm.toFixed(1);
}

function nudge(ms) {
  $('offset').value = String((parseFloat($('offset').value) || 0) + ms);
  refresh();
}

function barOneAtPlayhead() {
  if (!state.beats.length) return;
  const t = player.time;
  let i = 0;
  state.beats.forEach((b, k) => { if (Math.abs(b - t) < Math.abs(state.beats[i] - t)) i = k; });
  const bpb = state.bpb;
  state.phaseShift = ((i - state.autoPhase) % bpb + bpb) % bpb;
  toast(`Bar 1 now starts at ${fmtTime(state.beats[i])}`);
  refresh();
}

// ---------- song location (for Final Cut) ----------

async function api(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(res.status);
  return res.json();
}

async function detectServer() {
  try { state.server = (await api('api/ping')).app === 'beatline'; } catch { state.server = false; }
}

const dirname = (p) => p.replace(/\/[^/]*$/, '') || '/';

async function locateSong() {
  if (state.server === null) await detectServer();
  if (!state.server) {
    state.locate = { status: 'unavailable', paths: [] };
    renderLocate();
    return;
  }
  state.locate = { status: 'searching', paths: [] };
  renderLocate();
  try {
    const { paths } = await api(`api/locate?name=${encodeURIComponent(state.file.name)}&size=${state.file.size}`);
    if (paths.length) {
      state.locate = { status: 'found', paths };
      $('folder').value = state.settings.folder = dirname(paths[0]);
      saveSettings();
    } else {
      state.locate = { status: 'notfound', paths: [] };
    }
  } catch {
    state.locate = { status: 'unavailable', paths: [] };
  }
  renderLocate();
}

async function verifyFolder() {
  if (!state.server || !state.file) return renderLocate();
  const path = `${$('folder').value.trim().replace(/\/+$/, '')}/${state.file.name}`;
  try {
    const { exists, size } = await api(`api/exists?path=${encodeURIComponent(path)}`);
    state.locate = { status: exists && size === state.file.size ? 'found' : 'missing', paths: exists ? [path] : [] };
  } catch { /* keep previous */ }
  renderLocate();
}

function renderLocate() {
  const { status, paths } = state.locate;
  const msg = {
    idle: 'Open a song first.',
    searching: '<span class="busy"><span class="spinner"></span>Looking for the song on your Mac…</span>',
    found: `<span class="ok">✓ Found on your Mac${paths.length > 1 ? ` (${paths.length} copies, using the newest)` : ''}</span>`,
    notfound: '<span class="bad">Couldn’t find this file on your Mac.</span> Type its folder below.',
    missing: '<span class="bad">✗ That folder doesn’t contain this song.</span> Final Cut would show it offline.',
    unavailable: 'Browsers can’t see where a file lives. Type its folder below, or run <code>./beatline.command</code> and Beatline finds it for you.',
  }[status];
  $('locateStatus').innerHTML = msg;
  $('locatePath').textContent = status === 'found' ? paths[0] : '';
}

// ---------- range ----------

const rate = () => FRAME_RATES[state.settings.fps];
const fpsNum = () => rate().den / rate().num;
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
  state.range[edge] = player.time;
  const { in: a, out: b } = state.range;
  if (a != null && b != null && b <= a) state.range[edge === 'in' ? 'out' : 'in'] = null;
  refresh();
}

function clearRange() {
  state.range = { in: null, out: null };
  refresh();
}

function quickRange(seconds) {
  if (!state.buffer) return;
  const lines = [0, ...state.bars.map((b) => b.start), state.buffer.duration];
  const nearest = (t) => lines.reduce((p, c) => (Math.abs(c - t) < Math.abs(p - t) ? c : p), lines[0]);
  const a = nearest(player.time);
  let b = nearest(a + seconds);
  if (b <= a) b = Math.min(state.buffer.duration, a + seconds);
  state.range = { in: a, out: b };
  setView({ start: a - seconds * 0.1, dur: seconds * 1.2 });
  refresh();
}

// ---------- markers, structure & cut plan ----------

function phase() {
  return (((state.autoPhase + state.phaseShift) % state.bpb) + state.bpb) % state.bpb;
}

function updateStructure() {
  const key = `${state.beats.length}|${state.beats[0]}|${state.bpm}|${phase()}|${state.bpb}`;
  if (key === state.structureKey) return;
  state.structureKey = key;
  state.bars = barGrid(state.beats, phase(), state.bpb, state.buffer.duration);
  state.sections = detectSections(state.mono, state.buffer.sampleRate, state.bars, state.buffer.duration);
}

function refresh() {
  if (!state.o) return;
  updateStructure();
  const s = state.settings;
  const offset = (parseFloat($('offset').value) || 0) / 1000 - (parseInt(s.lead, 10) || 0) / fpsNum();
  state.markers = buildMarkers({
    mode: s.mode,
    beats: state.beats,
    onsets: state.onsets,
    drums: state.drums,
    drumKinds: Object.entries(DRUM_IDS).filter(([id]) => s[id]).map(([, k]) => k),
    phase: phase(),
    beatsPerBar: state.bpb,
    density: s.density,
    offset,
    edits: state.edits,
    sections: state.sections,
    autoMap: { low: s.autoLow, mid: s.autoMid, high: s.autoHigh },
  });
  const { inFrame, outFrame } = rangeFrames();
  state.plan = planCuts({
    markers: state.markers,
    rate: rate(),
    rounding: s.rounding,
    inFrame,
    outFrame,
    minShotFrames: Math.round((parseFloat(s.minShot) || 0) * fpsNum()),
    sections: state.sections,
  });
  state.cutFrames = new Set(state.plan.cuts);

  const st = state.plan.stats;
  $('sCuts').textContent = st.cuts;
  $('sShots').textContent = st.shots;
  $('sAsl').textContent = `${st.avgShot.toFixed(1)}s`;
  $('sCpm').textContent = st.cutsPerMin.toFixed(0);
  $('sLen').textContent = fmtDur(st.lengthSec);
  const ranged = state.range.in != null || state.range.out != null;
  $('sLenLabel').textContent = ranged ? 'range length' : 'length';
  $('rangeLabel').textContent = ranged ? `${timecode(inFrame, rate())} → ${timecode(outFrame, rate())}` : 'Whole song';
  $('resetEdits').disabled = !state.edits.added.length && !state.edits.removed.size;
  $('bpm').placeholder = `auto (${state.autoBpm.toFixed(1)})`;
  renderAnalysis();
  renderPlan(inFrame, outFrame);
  draw();
}

// ---------- rendering: analysis facts ----------

function renderAnalysis() {
  const info = state.info;
  const stab = state.stability;
  const conf = info.confidence;
  $('confPill').className = `pill ${conf}`;
  $('confPill').textContent = { high: '● Confident', medium: '● Fairly sure', low: '● Unsure' }[conf];
  $('confPill').title = `Beat periodicity ${(info.periodicity * 100).toFixed(0)}%`;
  $('lowConf').hidden = conf !== 'low';
  $('lowConfText').textContent = 'No steady beat here (speech, rubato or free-time music), so the grid may wander. Try Drums or Any hit, tap the tempo, or add cuts by hand.';

  $('fTempo').innerHTML = `${state.bpm.toFixed(1)} <small>BPM</small>`;
  const kindText = { steady: 'Steady tempo', live: 'Live feel, slight drift', changing: 'Tempo changes', unknown: 'Too short to tell' }[stab.kind];
  $('fTempoSub').textContent = stab.kind === 'unknown' ? kindText : `${kindText} · ${stab.min.toFixed(0)}–${stab.max.toFixed(0)} BPM`;
  $('tempoChips').innerHTML = info.candidates
    .filter((c) => c.label !== 'Detected')
    .map((c) => `<button data-bpm="${c.bpm}" class="${Math.abs(c.bpm - state.bpm) < 0.5 ? 'on' : ''}" title="${c.label} the detected tempo · ${Math.round(c.strength * 100)}% as strong">${c.label} ${c.bpm.toFixed(0)}</button>`)
    .join('') + (Math.abs(state.bpm - state.autoBpm) > 0.5 ? `<button data-bpm="${state.autoBpm}">Detected ${state.autoBpm.toFixed(1)}</button>` : '');
  for (const b of $('tempoChips').querySelectorAll('button')) b.onclick = () => setBpm(+b.dataset.bpm);
  const tightHigh = +state.settings.tight >= 6;
  $('tightNote').innerHTML = stab.kind !== 'steady' && stab.kind !== 'unknown' && tightHigh
    ? `This song’s tempo moves (${stab.min.toFixed(0)}–${stab.max.toFixed(0)} BPM). <a href="#" id="loosen">Loosen the grid</a> so it follows the band.`
    : 'High for click-tracked pop and EDM; low for live bands that drift.';
  $('loosen')?.addEventListener('click', (e) => { e.preventDefault(); $('tight').value = '3'; state.settings.tight = '3'; saveSettings(); updateVisibility(); retrack(false); });

  const det = info.meter.beatsPerBar;
  $('fMeter').innerHTML = `${state.bpb}/${state.bpb === 6 ? 8 : 4}`;
  const bar1 = state.bars[0]?.start ?? 0;
  $('fMeterSub').textContent = `${state.bpbAuto ? 'Detected' : `Set by you (heard ${det}/4)`} · bar 1 at ${fmtTime(bar1)}`;

  const secs = state.sections;
  const drop = secs.find((x) => x.drop);
  $('fShape').innerHTML = `${secs.length} <small>${secs.length === 1 ? 'section' : 'sections'} · ${state.bars.length} bars</small>`;
  $('fShapeSub').textContent = secs.length === 1 ? 'Even energy throughout' : drop ? `Drop at ${fmtTime(drop.start)} (bar ${drop.firstBar})` : secs.some((x) => x.level === 'high') ? `Peak at ${fmtTime(secs.find((x) => x.level === 'high').start)}` : 'Even energy throughout';

  $('fKey').textContent = info.key.name;
  $('fKeySub').textContent = `Camelot ${info.key.camelot} · estimate`;

  const L = info.loudness;
  $('fLoud').innerHTML = `${Number.isFinite(L.lufs) ? L.lufs.toFixed(1) : '–'} <small>LUFS</small>`;
  $('fLoudSub').textContent = `Peak ${L.peakDb.toFixed(1)} dBFS · streaming plays at about −14`;

  const sp = info.span;
  $('fSpan').innerHTML = `${fmtTime(sp.start)} <small>→ ${fmtDur(sp.end)}</small>`;
  $('fSpanSub').textContent = `Lead-in ${sp.start.toFixed(2)} s · tail ${(state.buffer.duration - sp.end).toFixed(1)} s`;
}

// ---------- rendering: cut plan ----------

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
  const notes = [`Shortest shot ${st.shortest.toFixed(2)} s`, `longest ${st.longest.toFixed(2)} s`];
  if (st.dropped > 0) notes.push(`${st.dropped} cut${st.dropped > 1 ? 's' : ''} skipped by the shortest-shot limit (faded on the timeline)`);
  $('planNote').textContent = `${notes.join(' · ')}.`;
  $('shotSummary').textContent = `Shot list: ${st.shots} shots`;
  $('shotTable').tBodies[0].innerHTML = state.plan.shots.map((x) => `<tr class="clickable" data-t="${frameSec(x.start)}">
      <td>${x.index}</td><td>${timecode(x.start - inFrame, rate())}</td><td>${x.seconds.toFixed(2)}s</td><td>${x.frames}</td>
      <td>${x.section ? `<span class="chip"><i class="dot" style="background:var(${LEVEL_VAR[x.section.level]})"></i>${x.section.label}</span>` : ''}</td>
    </tr>`).join('');
}

function onRowClick(e) {
  const tr = e.target.closest('tr[data-t]');
  if (!tr) return;
  const t = +tr.dataset.t;
  seek(t);
  if (t < state.view.start || t > state.view.start + state.view.dur) setView({ start: t - state.view.dur * 0.1, dur: state.view.dur });
}

// ---------- editing ----------

function isCut(m) {
  return state.cutFrames.has(toFrame(m.time, rate(), state.settings.rounding));
}

function toggleMarkerAt(time) {
  const tol = (8 / $('timeline').clientWidth) * state.view.dur;
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

function jumpCut(dir) {
  const t = player.time;
  const times = state.plan.cuts.map(frameSec);
  const next = dir > 0 ? times.find((x) => x > t + 0.01) : [...times].reverse().find((x) => x < t - 0.01);
  if (next != null) {
    seek(next);
    if (next < state.view.start || next > state.view.start + state.view.dur) setView({ start: next - state.view.dur / 2, dur: state.view.dur });
  }
}

// ---------- export ----------

const songBase = () => state.file.name.replace(/\.[^.]+$/, '');

function exportMarkers() {
  const cuts = state.markers.filter(isCut);
  return [...cuts, ...sectionMarkers(state.sections)];
}

function exportStyles() {
  const s = state.settings;
  return { section: s.styleSection, downbeat: s.styleDown, beat: s.styleBeat, hit: s.styleBeat, kick: s.styleBeat, snare: s.styleBeat, hat: s.styleBeat, manual: 'todo' };
}

function exportXml() {
  if (!state.plan) return;
  const s = state.settings;
  if (s.target !== 'gap') {
    if (!s.folder.trim().startsWith('/')) {
      showTab('export');
      toast('Add the song’s folder (starts with /) so Final Cut can play it, or export Markers only');
      $('folder').focus();
      return;
    }
    if (state.locate.status === 'missing') {
      showTab('export');
      toast('That folder doesn’t contain the song: Final Cut would import it silent. Fix the folder first.');
      $('folder').focus();
      return;
    }
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
      audioRate: state.audioInfo?.sampleRate,
      channels: state.audioInfo?.channels ?? state.buffer.numberOfChannels,
    },
    eventName: s.eventName || 'Beatline',
    projectName: `${name} – ${kind} (${state.plan.stats.cuts} cuts)`,
  });
  $('xmlText').value = xml;
  $('xmlBox').hidden = false;
  sendToFinalCut(`${name} ${kind}`, xml);
}

// With the launcher running, save straight to ~/Movies/Beatline and open it
// in Final Cut; otherwise download the file.
async function sendToFinalCut(name, xml) {
  if (state.server) {
    try {
      const res = await fetch(`api/send?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml', 'X-Beatline': '1' },
        body: xml,
      });
      if (res.ok) {
        const { path, opened } = await res.json();
        toast(opened ? 'Opening in Final Cut Pro…' : `Saved to ${path}. In Final Cut: File › Import › XML…`);
        return;
      }
    } catch { /* fall back to a download */ }
  }
  download(`${name}.fcpxml`, xml, 'application/xml');
  toast('Saved. Double-click it, or in Final Cut: File › Import › XML…');
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

// ---------- timeline & playback ----------

const timeline = createTimeline({
  canvas: $('timeline'),
  overview: $('overview'),
  get: () => (state.o && state.wave ? {
    duration: state.buffer.duration,
    view: state.view,
    time: player.time,
    wave: state.wave,
    bars: state.bars,
    beats: state.beats,
    barLen: (60 / state.bpm) * state.bpb,
    bpm: state.bpm,
    sections: state.sections,
    sectionsKey: state.structureKey,
    tempoCurve: state.stability?.curve ?? [],
    markers: state.markers,
    isCut,
    mode: state.settings.mode,
    drums: state.drums,
    range: state.range.in != null || state.range.out != null ? [frameSec(rangeFrames().inFrame), frameSec(rangeFrames().outFrame)] : null,
  } : null),
  onSeek: (t) => seek(t),
  onToggle: (t) => toggleMarkerAt(t),
  onRange: (a, b) => { state.range = { in: a, out: b }; refresh(); },
  onView: (v) => setView(v),
});

function draw() {
  timeline.draw();
  timeline.drawOverview();
}

function setView(v) {
  const total = state.buffer.duration;
  const dur = Math.min(total, Math.max(0.5, v.dur));
  state.view = { start: Math.min(total - dur, Math.max(0, v.start)), dur };
  draw();
}

function zoom(k) {
  if (!state.buffer) return;
  const c = player.playing || (player.time >= state.view.start && player.time <= state.view.start + state.view.dur) ? player.time : state.view.start + state.view.dur / 2;
  const dur = state.view.dur * k;
  setView({ start: c - (c - state.view.start) * k, dur });
}

function fitView() {
  if (state.buffer) setView({ start: 0, dur: state.buffer.duration });
}

function seek(t) {
  player.seek(t);
  updateTime();
  draw();
}

function togglePlay() {
  if (!player?.buffer) return;
  if (player.playing) player.pause();
  else player.play(player.time >= player.duration - 0.05 ? 0 : player.time);
  syncPlayButton();
  if (player.playing) requestAnimationFrame(tick);
}

function toggleClick() {
  if (!player) return;
  player.clickOn = !player.clickOn;
  $('clickToggle').setAttribute('aria-pressed', String(player.clickOn));
}

function syncPlayButton() {
  $('play').textContent = player.playing ? '❚❚' : '▶';
  $('play').setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
}

function tick() {
  const t = player.time;
  const { start, dur } = state.view;
  if (t > start + dur * 0.92 || t < start) setView({ start: t - dur * 0.1, dur });
  updateTime();
  draw();
  if (player.playing) requestAnimationFrame(tick);
  else syncPlayButton();
}

function updateTime() {
  const t = player?.time ?? 0;
  $('time').textContent = timecode(Math.floor(t * fpsNum() + 1e-6), rate());
}

// ---------- misc UI ----------

function setBusy(msg, error) {
  $('empty').hidden = false;
  for (const id of ['timelineCard', 'analysisCard', 'planCard']) $(id).hidden = true;
  $('emptySub').innerHTML = msg ? `<span class="busy"><span class="spinner"></span>${msg}</span>` : error;
}

function showWorkspace() {
  $('empty').hidden = true;
  for (const id of ['timelineCard', 'analysisCard', 'planCard']) $(id).hidden = false;
  for (const id of ['play', 'clickToggle', 'exportXml', 'exportXml2']) $(id).disabled = false;
  syncPlayButton();
  updateTime();
  refresh();
}

function fmtTime(t) {
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(2).padStart(5, '0')}`;
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
  toastTimer = setTimeout(() => el.classList.remove('show'), 3600);
}

function initDrop() {
  $('file').addEventListener('change', (e) => loadFile(e.target.files[0]));
  const zones = [$('empty'), $('fileBtn')];
  window.addEventListener('dragover', (e) => { e.preventDefault(); zones.forEach((z) => z.classList.add('over')); });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) zones.forEach((z) => z.classList.remove('over')); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    zones.forEach((z) => z.classList.remove('over'));
    if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });
}

function initKeys() {
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') { e.preventDefault(); exportXml(); return; }
    if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
    if (k === 't') { tapTempo(); return; }
    if (!state.o) return;
    const actions = {
      arrowleft: () => jumpCut(-1),
      arrowright: () => jumpCut(1),
      m: () => { state.edits.added.push(player.time); refresh(); },
      d: barOneAtPlayhead,
      i: () => setRangeEdge('in'),
      o: () => setRangeEdge('out'),
      x: clearRange,
      c: toggleClick,
      '[': () => nudge(-10),
      ']': () => nudge(10),
      '+': () => zoom(0.5),
      '=': () => zoom(0.5),
      '-': () => zoom(2),
      '\\': fitView,
    };
    if (actions[k]) { e.preventDefault(); actions[k](); }
  });
}

// Installed app: offline cache, and audio files opened with Beatline from Finder.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* not available here */ });
}
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (params.files?.length) loadFile(await params.files[0].getFile());
  });
}

window.addEventListener('resize', draw);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { timeline.invalidateColors(); draw(); });

loadSettings();
initControls();
initDrop();
initKeys();
detectServer();
