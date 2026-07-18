/**
 * @fileoverview vt/compressed-textures.js — main-thread client for
 * bc-compress.worker.js. Requests BC-compressed blocks for a source image; the
 * worker does the fetch/decode/opacity-check/encode/cache off-thread and returns
 * BC1 (opaque) or BC7 (alpha).
 *
 * This is the WebGPU-memory-ceiling fix (see block-compress.js /
 * bc-compress.worker.js). It is DEGRADATION-FIRST: if the worker can't be
 * constructed (CSP, unsupported) or it errors, the caller gets `null` and MUST
 * fall back to a raw texture — compression must never break rendering (the
 * safety slide, memory: feedback_safety_slide_outranks_doctrine).
 *
 * Worker construction mirrors decode-pool.js exactly: `new Worker(new URL(...,
 * import.meta.url), { type: 'module' })` — the only reference form that both
 * resolves correctly under Foundry's raw module serving AND is followed by the
 * reachability wall (tools/reachability.mjs form 4).
 */

let _worker = null;
let _unavailable = false;
const _pending = new Map();
let _nextId = 1;
/** Diagnostics counters — surfaced so a report can tell a cache hit from a fresh
 * BC1 encode from a BC7 encode, without guessing (memory: feedback_instruments_must_not_lie). */
const _stats = { requests: 0, bc1: 0, bc7: 0, failed: 0, cached: 0, unavailable: 0 };

function ensureWorker() {
  if (_worker || _unavailable) return _worker;
  try {
    _worker = new Worker(new URL('./bc-compress.worker.js', import.meta.url), { type: 'module' });
    _worker.onmessage = (e) => {
      const { id, ok, format, blocks, width, height, cached, alphaStats } = e.data || {};
      const p = _pending.get(id);
      if (!p) return;
      _pending.delete(id);
      if (!ok) {
        _stats.failed++;
        p.resolve(null); // resolve (not reject): the caller's contract is "null ⇒ use raw"
        return;
      }
      if (cached) _stats.cached++;
      if (format === 'bc7') _stats.bc7++;
      else _stats.bc1++;
      p.resolve({
        format,
        blocks: new Uint8Array(blocks),
        width,
        height,
        cached: !!cached,
        alphaStats: alphaStats ?? null,
      });
    };
    _worker.onerror = () => {
      // A hard worker error dooms the whole worker — mark unavailable and let
      // every in-flight (and future) request fall back to raw.
      _unavailable = true;
      for (const [, p] of _pending) p.resolve(null);
      _pending.clear();
    };
  } catch (_) {
    // Worker construction blocked (CSP, unsupported) — permanent, silent fallback.
    _unavailable = true;
  }
  return _worker;
}

/**
 * Ask the worker for GPU-compressed blocks for `src`: BC1 if the image is
 * opaque, BC7 if it has alpha. The caller picks the matching THREE format.
 * @param {string} src root-absolute asset URL (same string the raw path fetches)
 * @returns {Promise<
 *   | { format: 'bc1'|'bc7', blocks: Uint8Array, width: number, height: number, cached: boolean,
 *       alphaStats: {min:number,max:number,mean:number}|null }
 *   | null                              // worker unavailable/failed — caller uses a raw texture
 * >}
 */
export function requestCompressedTexture(src) {
  _stats.requests++;
  const w = ensureWorker();
  if (!w) {
    _stats.unavailable++;
    return Promise.resolve(null);
  }
  const id = _nextId++;
  const promise = new Promise((resolve) => _pending.set(id, { resolve }));
  try {
    w.postMessage({ id, src });
  } catch (_) {
    _pending.delete(id);
    _stats.failed++;
    return Promise.resolve(null); // not cloneable / worker gone — fall back to raw
  }
  return promise;
}

/** Snapshot of the client's counters for the flight recorder. */
export function getCompressedTextureStats() {
  return { ..._stats, unavailable: _unavailable, workerCreated: !!_worker };
}

/** Tear down the worker (viewer dispose). Best-effort. */
export function disposeCompressedTextureWorker() {
  if (_worker) {
    try {
      _worker.terminate();
    } catch (_) {
      // already gone — nothing to do
    }
    _worker = null;
  }
  _pending.clear();
}
