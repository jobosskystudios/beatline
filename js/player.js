// Web Audio playback of the decoded song with a sample-accurate metronome.
// (Plays from memory, so it works anywhere the page can decode the file.)

const LOOKAHEAD = 0.12; // seconds of clicks scheduled ahead
const TICK_MS = 25;

export class Player {
  constructor(ctx) {
    this.ctx = ctx;
    this.buffer = null;
    this.source = null;
    this.offset = 0; // song time when paused
    this.startedAt = 0; // ctx time that maps to song time 0 while playing
    this.clickTimes = () => [];
    this.accentAt = () => false;
    this.clickOn = false;
    this.gain = ctx.createGain();
    this.gain.connect(ctx.destination);
    this.onended = null;
    this.timer = null;
    this.scheduledUntil = 0;
  }

  load(buffer) {
    this.stop();
    this.buffer = buffer;
    this.offset = 0;
  }

  get playing() {
    return !!this.source;
  }

  get duration() {
    return this.buffer?.duration ?? 0;
  }

  // Song time at the speakers (accounts for output latency).
  get time() {
    if (!this.source) return this.offset;
    const lat = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    return Math.min(this.duration, Math.max(0, this.ctx.currentTime - this.startedAt - lat));
  }

  async play(from = this.offset) {
    if (!this.buffer) return;
    if (this.ctx.state !== 'running') await this.ctx.resume();
    this.stopSource();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gain);
    const at = Math.min(Math.max(0, from), this.duration);
    this.startedAt = this.ctx.currentTime - at;
    src.start(0, at);
    src.onended = () => {
      if (this.source !== src) return;
      this.source = null;
      this.offset = this.duration;
      clearInterval(this.timer);
      this.onended?.();
    };
    this.source = src;
    this.scheduledUntil = at;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.scheduleClicks(), TICK_MS);
    this.scheduleClicks();
  }

  pause() {
    if (!this.source) return;
    this.offset = this.time;
    this.stopSource();
  }

  stop() {
    this.stopSource();
    this.offset = 0;
  }

  seek(t) {
    const was = this.playing;
    this.offset = Math.min(Math.max(0, t), this.duration);
    if (was) this.play(this.offset);
  }

  stopSource() {
    clearInterval(this.timer);
    if (this.source) {
      const s = this.source;
      this.source = null;
      try { s.stop(); } catch { /* already stopped */ }
    }
  }

  scheduleClicks() {
    if (!this.source || !this.clickOn) {
      this.scheduledUntil = this.ctx.currentTime - this.startedAt + LOOKAHEAD;
      return;
    }
    const now = this.ctx.currentTime - this.startedAt;
    const until = now + LOOKAHEAD;
    for (const t of this.clickTimes()) {
      if (t >= this.scheduledUntil && t < until) this.click(this.startedAt + t, this.accentAt(t));
    }
    this.scheduledUntil = until;
  }

  click(when, accent) {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(accent ? 0.6 : 0.35, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    osc.connect(g).connect(this.ctx.destination);
    osc.start(when);
    osc.stop(when + 0.06);
  }
}
