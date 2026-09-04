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
 *
 * ============================================================================
 * ⚠️ THE QUEUE IS PRIORITISED, AND THAT IS A BUG FIX, NOT A NICETY (2026-08-11)
 * ============================================================================
 *
 * THE LIVE REPORT (author, on the real mansion): "I go up one floor. The upper
 * floor background image and foreground image take several minutes to actually
 * appear… minutes after everything else appeared." Reproducible ONLY on the
 * first load after a cache wipe (a `CACHE_VERSION` bump — S1.1 shipped v10, so
 * every user gets exactly one of these); instant on every reload after.
 *
 * THE MECHANISM. There is exactly ONE worker, and this module used to
 * `postMessage` every request the instant it arrived. Once posted, a job is in
 * the worker's own event queue and is served in strict arrival order — no
 * priority, no reordering, and no way to get in front. Meanwhile
 * `vt-pan-viewer.js#primeCoverAlphaGrids` deliberately asks for the coarse
 * alpha of EVERY cover item in the scene — every floor's background, foreground
 * and tiles, whether or not the viewed floor can see them (that breadth is
 * itself a correctness fix; shadow physics must not depend on what you are
 * looking at). So on a cold cache the queue fills with dozens of full
 * fetch+decode passes over 12000² images, and the floor you then switch to
 * appends its background/foreground compression to the BACK of all of it.
 *
 * The irony is exact, and worth keeping: that priming path's own comment says
 * blocking the load on it "would trade a visible stall for a shadow nobody is
 * looking at yet." Sharing one FIFO worker did precisely that, just indirectly
 * — the priming never blocked anything *directly*, it simply got there first.
 * A warm cache hides it completely (every priming job is an IndexedDB hit,
 * milliseconds), which is why this survived until a version bump exposed it.
 *
 * THE FIX. Jobs are held HERE, on the main thread, and posted one at a time;
 * whatever the player is actually waiting to see jumps the line. Two lanes:
 *
 *   'interactive' — a texture something is trying to DRAW right now. The
 *                   default for {@link requestCompressedTexture}, because a
 *                   compressed texture only ever exists to be displayed.
 *   'background'  — work whose result improves a later frame but which nothing
 *                   on screen is waiting for. The default for
 *                   {@link requestCoarseAlphaGrid} (shadow-cover physics), whose
 *                   own call site already documents itself as fire-and-forget.
 *
 * NOT FIXED BY ADDING WORKERS, deliberately: a second worker decoding a second
 * 12000² image concurrently is ~576 MB of transient decode memory on top of the
 * first, and reintroducing that is how the 12k map lost the device in the first
 * place ([[keyhole-device-loss-large-map]]). One worker, served in the right
 * order, is the whole fix.
 */

// perfNowMs, not Date.now() directly (time/one-clock, tools/verify-structure.mjs)
// — this is a worker-retry cooldown timer, exactly the "off-main-thread
// decode/worker latency" class perfNowMs's own header names, not animation
// state, so it doesn't belong on env.time either.
import { perfNowMs } from '../core/frame-clock.js';

/** A texture something is trying to draw right now — always served first. */
export const PRIORITY_INTERACTIVE = 'interactive';
/** Work that improves a later frame; nothing on screen is waiting for it. */
export const PRIORITY_BACKGROUND = 'background';

/**
 * How many jobs may sit in the worker's own queue at once.
 *
 * ONE, and the reasoning is not "keep it simple": every job posted beyond the
 * one actually executing is a job this module can no longer re-order, because
 * the worker serves its own event queue in arrival order. Holding the rest here
 * is what makes the lanes above mean anything at all. The cost is one
 * postMessage round-trip of worker idle between jobs — sub-millisecond, against
 * cold jobs that run for seconds. Note the worst case is unchanged either way:
 * an arriving interactive job always waits for at most the one job already
 * executing, which no amount of buffering could have prevented.
 */
const MAX_IN_FLIGHT = 1;

let _worker = null;
let _unavailable = false;
/** Set by `onerror` to a future `perfNowMs()` — `ensureWorker` refuses to build a
 * new `Worker` before this passes. See the reconstruction comment on
 * `onerror` below (mythica-machina-press#483) for why this exists instead of
 * `_unavailable` latching forever on the first error. */
let _cooldownUntil = 0;
/** Errors since the last successful reply. Reset to 0 by any `ok:true` reply —
 * a working reply proves the CURRENT worker is healthy, not just constructed. */
let _consecutiveFailures = 0;
/** After this many worker errors with no successful reply in between, stop
 * reconstructing and fall back to `_unavailable` (the old permanent-latch
 * behavior) — a bound so a genuinely broken environment (not one bad asset)
 * still degrades to raw textures for the rest of the session rather than
 * retrying forever. */
export const MAX_CONSECUTIVE_WORKER_FAILURES = 3;
/** How long to wait after a worker error before trying a fresh `Worker`. Long
 * enough that a transient fault (one bad asset, a momentary OOM) isn't
 * immediately retried into the same failure; short enough that a real session
 * recovers within one scene load rather than staying degraded for its whole
 * length. */
export const WORKER_RECONSTRUCT_COOLDOWN_MS = 5000;
/** id -> {resolve, mode} for jobs POSTED to the worker and not yet answered. */
const _pending = new Map();
/** Jobs accepted but not yet posted, newest last, one array per lane. */
const _queue = { [PRIORITY_INTERACTIVE]: [], [PRIORITY_BACKGROUND]: [] };
let _inFlight = 0;
let _nextId = 1;
/** Diagnostics counters — surfaced so a report can tell a cache hit from a fresh
 * BC1 encode from a BC7 encode, without guessing (memory: feedback_instruments_must_not_lie). */
const _stats = {
  requests: 0,
  bc1: 0,
  bc7: 0,
  failed: 0,
  cached: 0,
  unavailable: 0,
  /** Coarse-alpha requests (the `coverAbove`/`skyReach` input — see
   * requestCoarseAlphaGrid). Counted separately from `requests` so a report can
   * tell "the shadow has no casters because nothing asked" apart from "…because
   * every ask failed" (feedback_instruments_must_not_lie). */
  alphaRequests: 0,
  alphaOk: 0,
  alphaFailed: 0,
  /** The deepest the main-thread queue ever got this session. A cold mansion
   * load should show this well above zero — if it reads 0 on a cold load, the
   * priority lanes are not actually being exercised and any conclusion drawn
   * from "the floor switch felt fast" is about the cache, not about this code. */
  maxQueueDepth: 0,
  /** Total `onerror` events across the whole session — surfaced so a report
   * can tell "never errored" from "errored once and recovered" from "errored
   * repeatedly and gave up" (mythica-machina-press#483), none of which read
   * the same under the old bool-only `unavailable` flag. */
  workerErrors: 0,
  /** Successful reconstructions after a cooldown (a fresh `Worker` that went
   * on to answer at least one job) — 0 forever on a session with no errors. */
  workerReconstructions: 0,
};

function _queueDepth() {
  return _queue[PRIORITY_INTERACTIVE].length + _queue[PRIORITY_BACKGROUND].length;
}

/** Shape one worker reply into the caller's contracted result, or `null`.
 * Split out so `onmessage` can resolve on exactly one path and always pump the
 * queue afterwards — an early `return` that skipped {@link _pump} would strand
 * every remaining job forever. */
function _resultFor(d, p) {
  const { ok, mode, format, levels, width, height, cached, alphaStats, alphaMinGrid } = d;
  if (!ok) {
    if (p.mode === 'alphaGrid') _stats.alphaFailed++;
    else _stats.failed++;
    return null; // resolve (not reject): the caller's contract is "null ⇒ use raw"
  }
  if (mode === 'alphaGrid') {
    _stats.alphaOk++;
    if (cached) _stats.cached++;
    return { width, height, gridW: d.gridW, gridH: d.gridH, grid: new Uint8Array(d.grid), cached: !!cached };
  }
  if (cached) _stats.cached++;
  if (format === 'bc7') _stats.bc7++;
  else _stats.bc1++;
  return {
    format,
    // levels[0] is the full-resolution level; the rest are the mip chain
    // (the "MSA noisier than PIXI zoomed out" fix — see bc-compress.worker.js).
    levels: levels.map((lvl) => ({ width: lvl.width, height: lvl.height, blocks: new Uint8Array(lvl.blocks) })),
    width,
    height,
    cached: !!cached,
    alphaStats: alphaStats ?? null,
    // Stage 1 (S1.1): the per-texel MIN alpha grid — null on pre-v10 cache
    // records; every consumer fails open on null (no split, today's pixels).
    alphaMinGrid: alphaMinGrid ?? null,
  };
}

/** Post as many queued jobs as the in-flight budget allows, interactive first. */
function _pump() {
  while (_inFlight < MAX_IN_FLIGHT) {
    const job = _queue[PRIORITY_INTERACTIVE].shift() ?? _queue[PRIORITY_BACKGROUND].shift();
    if (!job) return;
    const w = ensureWorker();
    if (!w) {
      // The worker died between accepting this job and dispatching it. Same
      // contract as every other failure path: resolve null, caller uses raw.
      if (job.mode === 'alphaGrid') _stats.alphaFailed++;
      else _stats.failed++;
      job.resolve(null);
      continue;
    }
    _pending.set(job.id, { resolve: job.resolve, mode: job.mode });
    try {
      w.postMessage(job.message);
      _inFlight++;
    } catch (_) {
      _pending.delete(job.id);
      if (job.mode === 'alphaGrid') _stats.alphaFailed++;
      else _stats.failed++;
      job.resolve(null); // not cloneable / worker gone — fall back to raw
    }
  }
}

/** Accept a job into its lane and try to dispatch. */
function _enqueue({ message, mode, priority }) {
  const id = _nextId++;
  return new Promise((resolve) => {
    const lane = priority === PRIORITY_INTERACTIVE ? PRIORITY_INTERACTIVE : PRIORITY_BACKGROUND;
    _queue[lane].push({ id, message: { ...message, id }, mode, resolve });
    const depth = _queueDepth();
    if (depth > _stats.maxQueueDepth) _stats.maxQueueDepth = depth;
    _pump();
  });
}

function ensureWorker() {
  if (_worker) return _worker;
  if (_unavailable) return null;
  // A prior `onerror` set a cooldown instead of latching permanently
  // (mythica-machina-press#483) — refuse to reconstruct until it passes.
  // `_pump`'s existing "worker died between accepting and dispatching" path
  // already resolves `null` for whatever called this, so callers during a
  // cooldown get exactly the same degrade-to-raw contract as a hard failure.
  if (_cooldownUntil && perfNowMs() < _cooldownUntil) return null;
  try {
    _worker = new Worker(new URL('./bc-compress.worker.js', import.meta.url), { type: 'module' });
    _worker.onmessage = (e) => {
      const d = e.data || {};
      const p = _pending.get(d.id);
      // An id we no longer know (a reply that raced `onerror`'s clear) must not
      // decrement the in-flight count — that would open a phantom slot and let
      // the budget drift past MAX_IN_FLIGHT.
      if (!p) return;
      _pending.delete(d.id);
      _inFlight = Math.max(0, _inFlight - 1);
      // A real reply proves THIS worker is healthy — an error on some earlier,
      // already-discarded worker must not keep counting against a fresh one
      // that is actually doing its job.
      if (d.ok !== false && _consecutiveFailures > 0) {
        _stats.workerReconstructions++;
        _consecutiveFailures = 0;
      }
      try {
        p.resolve(_resultFor(d, p));
      } finally {
        _pump();
      }
    };
    _worker.onerror = () => {
      // A hard worker error dooms the CURRENT worker instance — drop it and
      // fail every in-flight AND still-queued request back to raw. The queued
      // ones matter as much as the posted ones: a caller awaiting a job that
      // was never dispatched would otherwise hang forever, and `itemsLoading`
      // would never fall to zero, so the scene could never settle
      // (vt/settle.js).
      //
      // ⚠️ THIS USED TO SET `_unavailable = true` HERE, PERMANENTLY, ON THE
      // FIRST ERROR (mythica-machina-press#483) — one bad asset, anywhere in
      // the session, silently condemned every OTHER asset to uncompressed
      // textures (up to ~7.6x the VRAM) for the rest of the page's life, with
      // nothing surfaced anywhere. Now: drop the worker, start a cooldown, and
      // let the NEXT `ensureWorker()` call (any later job, via `_pump`) build
      // a fresh one — only after `MAX_CONSECUTIVE_WORKER_FAILURES` straight
      // failures with no successful reply in between does this still fall
      // back to the old permanent latch, on the theory that the environment
      // itself (not one asset) is the problem by that point.
      _worker = null;
      _stats.workerErrors++;
      _consecutiveFailures++;
      if (_consecutiveFailures >= MAX_CONSECUTIVE_WORKER_FAILURES) {
        _unavailable = true;
      } else {
        _cooldownUntil = perfNowMs() + WORKER_RECONSTRUCT_COOLDOWN_MS;
      }
      for (const [, p] of _pending) p.resolve(null);
      _pending.clear();
      for (const lane of [PRIORITY_INTERACTIVE, PRIORITY_BACKGROUND]) {
        for (const job of _queue[lane]) job.resolve(null);
        _queue[lane].length = 0;
      }
      _inFlight = 0;
    };
  } catch (_) {
    // Worker construction itself throwing (CSP, unsupported) is an
    // environment fact, not a transient fault — permanent, silent fallback,
    // no cooldown to wait out.
    _unavailable = true;
  }
  return _worker;
}

/**
 * Ask the worker for GPU-compressed blocks for `src`: BC1 if the image is
 * opaque, BC7 if it has alpha. The caller picks the matching THREE format.
 *
 * Served at {@link PRIORITY_INTERACTIVE} by default — a compressed texture only
 * ever exists to be drawn, so it outranks anything nothing is looking at.
 *
 * @param {string} src root-absolute asset URL (same string the raw path fetches)
 * @param {{priority?: string}} [opts]
 * @returns {Promise<
 *   | { format: 'bc1'|'bc7', levels: Array<{width:number,height:number,blocks:Uint8Array}>,
 *       width: number, height: number, cached: boolean,
 *       alphaStats: {min:number,max:number,mean:number}|null,
 *       alphaMinGrid: {w:number,h:number,data:Uint8Array}|null }
 *   | null                              // worker unavailable/failed — caller uses a raw texture
 * >}
 */
export function requestCompressedTexture(src, { priority = PRIORITY_INTERACTIVE } = {}) {
  _stats.requests++;
  const w = ensureWorker();
  if (!w) {
    _stats.unavailable++;
    return Promise.resolve(null);
  }
  return _enqueue({ message: { src }, mode: 'bc', priority });
}

/**
 * Ask the worker for `src`'s art opacity reduced to <=512 texels a side — the
 * input `scene/mask-derive.js` needs to derive `coverAbove`/`skyReach`, and has
 * been starved of since the streaming engine was retired (see
 * `vt/coarse-alpha.js`'s header for the defect this repairs).
 *
 * DEGRADATION-FIRST, exactly like {@link requestCompressedTexture}: `null` means
 * "no coverage data for this item". The caller must record that as MISSING —
 * never as "nothing above me", which is a different and much more dangerous
 * claim (it is the silent-numeric-default class that
 * feedback_required_masks_fail_loud exists to kill).
 *
 * Served at {@link PRIORITY_BACKGROUND} by default: the bulk caller
 * (`primeCoverAlphaGrids`) wants every item on every floor for shadow physics,
 * and its own doc calls that fire-and-forget. A caller whose request genuinely
 * gates a visible mesh should pass {@link PRIORITY_INTERACTIVE} explicitly.
 *
 * @param {string} src root-absolute asset URL (the same string the raw path fetches)
 * @param {{priority?: string}} [opts]
 * @returns {Promise<{width:number, height:number, gridW:number, gridH:number,
 *   grid:Uint8Array, cached:boolean} | null>}
 */
export function requestCoarseAlphaGrid(src, { priority = PRIORITY_BACKGROUND } = {}) {
  _stats.alphaRequests++;
  const w = ensureWorker();
  if (!w) {
    _stats.unavailable++;
    return Promise.resolve(null);
  }
  return _enqueue({ message: { src, mode: 'alphaGrid' }, mode: 'alphaGrid', priority });
}

/** Snapshot of the client's counters for the flight recorder. */
export function getCompressedTextureStats() {
  // `pending` is the DIRECT count of requests that have not been answered yet
  // — never derived by subtracting completions from `requests`, which would
  // double-count a cached hit (it increments both `cached` and its format
  // counter) and quietly drift negative. The scene-settle detector
  // (`vt/settle.js`) reads exactly this: a 12,000² BC compress is the longest
  // pole in a cold load, and "is one still running" must be a fact, not a sum.
  //
  // ⚠️ IT COUNTS QUEUED JOBS TOO, not just posted ones (2026-08-11, with the
  // priority lanes). A job waiting in `_queue` is work this scene is still
  // owed; reporting only the in-flight one would let settle declare the map
  // finished while a hundred jobs sat behind a single dispatch slot — the
  // precise "loading screen goes away too soon" lie settle.js exists to end.
  return {
    ..._stats,
    pending: _pending.size + _queueDepth(),
    inFlight: _inFlight,
    queued: _queueDepth(),
    queuedInteractive: _queue[PRIORITY_INTERACTIVE].length,
    queuedBackground: _queue[PRIORITY_BACKGROUND].length,
    unavailable: _unavailable,
    workerCreated: !!_worker,
    // Mid-cooldown after an error, waiting to try a fresh Worker — distinct
    // from `unavailable` (which means "gave up for the rest of the session").
    cooldownActive: !_worker && !_unavailable && _cooldownUntil > perfNowMs(),
    consecutiveWorkerFailures: _consecutiveFailures,
  };
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
  // ⚠️ EVERY OUTSTANDING CALLER IS RESOLVED, NOT DROPPED — both the jobs posted
  // to the (now terminated) worker and the ones still queued here. This used to
  // be a bare `_pending.clear()`, which silently abandoned each in-flight
  // promise: after `terminate()` no reply can ever arrive, so an awaiting
  // `ensureWholeImage` would hang for the life of the page with
  // `wi.status === 'loading'` — and `itemsLoading` never falling to zero means
  // the scene can never settle (vt/settle.js) and the whole-image load chain
  // never releases its next link. Caught by this module's own Node test, which
  // deadlocked on exactly that.
  for (const [, p] of _pending) p.resolve(null);
  _pending.clear();
  for (const lane of [PRIORITY_INTERACTIVE, PRIORITY_BACKGROUND]) {
    for (const job of _queue[lane]) job.resolve(null);
    _queue[lane].length = 0;
  }
  _inFlight = 0;
}
