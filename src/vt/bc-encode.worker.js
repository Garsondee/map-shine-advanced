/**
 * BC STRIP ENCODER (2026-09-24, perf goal attempt 1) — one of a small pool the
 * BC-compress worker (`bc-compress.worker.js`) spawns so a big texture's strips
 * encode in parallel instead of one after another. See
 * `block-compress.js#encodeStripedParallel` for why and for the byte-identity
 * guarantee.
 *
 * PROTOCOL: `{ id, strip: ArrayBuffer, width, h, format }` in (strip
 * transferred) → `{ id, blocks: ArrayBuffer }` out (transferred), or
 * `{ id, error }`. Stateless: pure `encodeBC1`/`encodeBC7`, nothing cached.
 */
import { encodeBC1, encodeBC7 } from './block-compress.js';

self.onmessage = (e) => {
  const { id, strip, width, h, format } = e.data || {};
  try {
    const rgba = new Uint8Array(strip);
    const blocks = format === 'bc7' ? encodeBC7(rgba, width, h) : encodeBC1(rgba, width, h);
    self.postMessage({ id, blocks: blocks.buffer }, [blocks.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
