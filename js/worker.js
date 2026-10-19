// Runs the song analysis off the main thread so the page stays responsive.
import { analyzeSong } from './analysis.js';

self.onmessage = ({ data }) => {
  try {
    const result = analyzeSong(data);
    const { o, chroma } = result;
    const transfer = [o.env, o.low, o.snare, o.hat, o.bands, o.rmsDb, o.active, chroma.frames].map((a) => a.buffer);
    self.postMessage({ ok: true, result }, [...new Set(transfer)]);
  } catch (err) {
    self.postMessage({ ok: false, error: String(err?.message ?? err) });
  }
};
