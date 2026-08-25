/**
 * @fileoverview vt/decode-pool.js — page-format-native decode (Keyhole Stage 1
 * part 3). Written fresh rather than harvested: the V2 equivalents
 * (texture-pyramid-builder.js, tile-decode-pool.js) both import
 * TextureBudgetTracker/texture-budget-policy.js — V2's REACTIVE budget
 * controller, a §7 kill-list item — so porting them verbatim would drag that
 * coupling into src/ before anything needs it. This module owes nothing to
 * that system.
 *
 * Split the same way `atlas.js`/`three-allocator.js` split pure math from
 * browser-only execution: the pure half (page geometry, byte-header parsing,
 * URL normalization) now lives in `decode-primitives.js`, Node-tested there;
 * `getSourceBitmap()`/`decodePage()` use `fetch`/`createImageBitmap`, which
 * don't exist under Node, so they're verified live via the debug panel's
 * "VT Live Decode Test" report instead (src/boot.js).
 *
 * THE APPROACH: decode each source image's FULL bitmap exactly once (cached
 * by URL) via `createImageBitmap` — modern browsers decode this off the main
 * thread. Every page is then a cheap CROP of that already-decoded bitmap
 * (`createImageBitmap(existingBitmap, sx, sy, sw, sh, {resizeWidth,
 * resizeHeight})`), never a second full decode and never a `getImageData`
 * call — the 8250² / 260 MB heap / 550-850 ms stall class named in
 * Keyhole.md §1's evidence table is structurally absent from this path.
 *
 * DEFERRED, noted not silently dropped (Stage 1 remainder / Stage 2): a real
 * Worker pool (the harvested `tile-decode-worker.js` pattern) for true
 * off-main-thread cropping under load, and IndexedDB persistence
 * (`pyramid-indexed-db.js`) so a page decoded once survives a reload. Neither
 * is required for the concept to be correct at this stage — `createImageBitmap`
 * already off-threads real decode work in Chromium, which is enough to prove
 * the pipeline. Both are real, tracked follow-ups (see keyhole-stage-status
 * memory), not forgotten scope.
 *
 * SLICE-ONCE / PERSIST / RELEASE (added 2026-07-15 — the multi-layer decode-
 * memory fix). The original path held every source's FULL decoded bitmap
 * forever (~576 MB per 12000² image) to crop pages on demand. Fine for one
 * albedo × a few floors; fatal at 8 layers × 3 floors ≈ 22 held bitmaps ≈ 13 GB
 * — the browser refused new decodes (observed live: mask decode failures during
 * prewarm). The fix (§4.1): crop a page ONCE, persist the 256² page blob to
 * IndexedDB (`pyramid-store.js`), and RELEASE the full bitmap. Every later
 * request for that page comes from IndexedDB — a tiny blob — never from a
 * re-held 576 MB source. A bounded semaphore caps how many full source bitmaps
 * exist AT ONCE (`SLICE_MAX_CONCURRENT_SOURCES`), so peak decode memory is
 * `O(ring)`, independent of how many layers × floors the scene has. That is
 * what makes "many 12K layers on many floors" not explode.
 *
 * @module vt/decode-pool
 */

import { pageStoreKey, getPageBlob, putPageBlob } from './pyramid-store.js';
import { perfNowMs } from '../core/frame-clock.js';
// The pure half of this module (byte-header parsing, page geometry, URL
// normalization, a streaming byte reader, a generic semaphore) moved to
// decode-primitives.js on 2026-07-25 (size-ratchet god-object reversal) —
// none of it touches this file's stateful caches/worker, so all of it is
// Node-testable there. DEFAULT_BORDER_PX/pageWorldRect/computePagePlacement
// are re-exported below because decode-pool.worker.js, vt-live-decode-report.js,
// and vt-pan-viewer.js already import them from this path.
import {
  DEFAULT_BORDER_PX,
  pageWorldRect,
  computePagePlacement,
  createSemaphore,
  shouldYieldByTime,
  parseImageDimensions,
  toRootAbsoluteAssetUrl,
  readLeadingBytes,
  reducePinRefState,
  INITIAL_PIN_REF_STATE,
  parseContentRangeTotal,
} from './decode-primitives.js';

export { DEFAULT_BORDER_PX, pageWorldRect, computePagePlacement };

/**
 * Cooperative yield so a BURST of page decodes can't block the main thread
 * long enough to visibly freeze the render loop (2026-07-16, author-reported:
 * rapidly zooming the FULL range in or out can "temporarily stop" — a real
 * frame-rate stall, not just soft/blurry content, which means something WAS
 * blocking synchronously rather than gracefully falling behind). A rapid
 * full-range zoom can legitimately need many new pages across several mip
 * levels, for every mask layer of every floor, all within one residency
 * update's decode burst — the decode loops below used to run every one of
 * those back-to-back with no yield point at all.
 *
 * Waits for the next animation frame — the SAME clock the render loop itself
 * runs on (both are plain browser `requestAnimationFrame` callbacks, queued
 * and run in registration order), so this reliably lets at least one real
 * frame paint before a long decode burst continues, turning "one long freeze"
 * into "the frame rate dips while catching up" — the graceful-degradation
 * shape this whole project is built around, applied to CPU decode bursts the
 * same way the page cache already applies it to GPU memory pressure.
 */
function yieldToMain() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

// shouldYieldByTime moved to decode-primitives.js (imported above) — its own
// doc there explains the time-vs-count-budget history this file's yield loops
// (acquirePages/acquirePackedPages) still rely on.

/** Wall-clock budget per decode chunk before yielding once — comfortably
 * under one 60fps frame (16.7ms), leaving headroom for the render() call and
 * per-frame input handling that frame. Caught early by yielding after
 * WHICHEVER page pushes elapsed time past this, rather than waiting for a
 * fixed page count that a run of unusually expensive (coarse-mip) pages
 * could blow straight through. */
const MAX_MS_PER_DECODE_CHUNK = 10;

/**
 * How many FULL source bitmaps may be decoded/held at once for page slicing.
 * Each 12000² source is ~576 MB decoded, so this is the hard bound on peak
 * slice-decode memory (3 → ~1.7 GB worst case), independent of total layers ×
 * floors. Raise on a memory-rich machine for faster first-load slicing; the
 * correctness/bound doesn't depend on the value.
 */
export const SLICE_MAX_CONCURRENT_SOURCES = 3;

// pageWorldRect + computePagePlacement moved to decode-primitives.js (imported
// above, and pageWorldRect re-exported) — both pure, both Node-tested there;
// see that file for the edge-stretch bug computePagePlacement's doc explains.

/**
 * Read a decoded PAGE bitmap's pixels (≤ pageSizePx² — the sanctioned
 * per-page CPU-extraction unit, Keyhole §4.1). This is the mask authority's
 * injected `readPageImageData` (boot.js wires it in): ingest happens on the
 * pager's own already-decoded pages, so derived masks never trigger a second
 * fetch, a second source decode, or a GPU readback. Lives HERE, beside the
 * decode paths that produce those bitmaps, because page-pixel access is
 * decode machinery — `no-gpu-readback` correctly refused to let it sit in
 * boot.js.
 *
 * @param {ImageBitmap} bitmap
 * @returns {ImageData}
 */
export function readPageBitmapPixels(bitmap) {
  const pageCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = pageCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

/** @type {Map<string, Promise<ImageBitmap>>} URL -> in-flight/decoded full-image bitmap. */
const _sourceCache = new Map();

/** @type {Map<string, import('./decode-primitives.js').PinRefState>} URL -> acquireSliceSource's
 * pinned-path refcount + deferred-release flag. See reducePinRefState's doc (decode-primitives.js)
 * for the close-under-an-in-flight-read race this exists to prevent. */
const _pinRefStates = new Map();

/**
 * Fetch + decode a source image's FULL bitmap exactly once; every later call
 * for the same URL reuses the cached (settled or in-flight) promise.
 * Browser-only (fetch + createImageBitmap) — not Node-testable.
 *
 * @param {string} url
 * @returns {Promise<ImageBitmap>}
 */
export function getSourceBitmap(url) {
  let entry = _sourceCache.get(url);
  if (!entry) {
    entry = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`getSourceBitmap: ${url} -> HTTP ${res.status}`);
        return res.blob();
      })
      .then((blob) => createImageBitmap(blob));
    _sourceCache.set(url, entry);
  }
  return entry;
}

/** @type {Map<string, Promise<string|null>>} URL -> the CURRENT content validator
 * (this session's cheap ranged-GET size probe result), settled or in-flight.
 * One fetch per URL per browser session — see `getContentValidator`'s own doc. */
const _validatorCache = new Map();

/**
 * The current content validator for a URL — a `bytes=0-0` ranged GET (same
 * technique `mask-discovery.js`'s existence probe already uses), reduced to
 * its `Content-Range` total via `parseContentRangeTotal`. Memoized per URL for
 * the life of this browser session: this exists to answer "has this URL's
 * FILE CONTENT changed since IndexedDB last cached a page from it" — see
 * `decode-primitives.js#parseContentRangeTotal`'s own header for the gap this
 * closes (`pageStoreKey`'s "URL+mtime" design intent, never finished) — and a
 * page is only ever a cache candidate ONCE per this same session, so re-
 * probing on every call would pay a network round trip for no new answer.
 *
 * ⚠️ FAILS SOFT TO `null`, THE SAME POSTURE EVERY OTHER PIECE OF THIS MODULE
 * TAKES ON A CACHE. A server that ignores Range, a CORS failure, an offline
 * probe — none of these are "the content changed"; they are "validation isn't
 * possible right now", and the caller's own null-check falls back to the
 * OLD, URL-only key (today's behaviour, unchanged) rather than treating an
 * unprobeable URL as permanently uncacheable.
 *
 * @param {string} url - already root-absolute (`toRootAbsoluteAssetUrl`).
 * @returns {Promise<string|null>} a short validator string to fold into a
 *   page-store key, or null if this URL can't be validated this way.
 */
function getContentValidator(url) {
  let entry = _validatorCache.get(url);
  if (!entry) {
    entry = fetch(url, { headers: { Range: 'bytes=0-0' } })
      .then((res) => {
        // Any non-2xx (including a server that doesn't have this URL at all)
        // fails soft below. A 200 (Range ignored, full body sent) is `res.ok`
        // too but carries no `Content-Range` header, so parseContentRangeTotal
        // already resolves that case to null on its own — no separate check needed.
        if (!res.ok) return null;
        const total = parseContentRangeTotal(res.headers.get('Content-Range'));
        return total === null ? null : `sz${total}`;
      })
      .catch(() => null);
    _validatorCache.set(url, entry);
  }
  return entry;
}

/**
 * Fold each URL's current content validator into its page-store key —
 * `pageStoreKey(url, ...)` becomes `pageStoreKey(`${url}#${validator}`, ...)`
 * when a validator is available, byte-identical to today's key otherwise. A
 * plain `Map` (not `Promise.all`) so a single slow/failed probe among several
 * URLs can't block the ones that resolved fine.
 * @param {string[]} urls @returns {Promise<Map<string, string>>} url -> keyed URL.
 */
async function resolveValidatedUrls(urls) {
  const out = new Map();
  await Promise.all(
    urls.map(async (url) => {
      const validator = await getContentValidator(url);
      out.set(url, validator ? `${url}#${validator}` : url);
    })
  );
  return out;
}

/**
 * Evict a cached source bitmap — e.g. a scene's background image changed, or
 * (boot.js's `registerFloorProxies`) the scene that pinned it is no longer
 * the active one. Deferred, not immediate, if `acquireSliceSource`'s pinned
 * fast path is still actively reading this URL right now (still-draining
 * page-streaming for the scene being left) — see `reducePinRefState`'s doc
 * (decode-primitives.js) for the close-under-an-in-flight-read race this
 * avoids. The common case (nothing pin-referencing this URL) closes
 * immediately, same as before this deferral existed.
 * @param {string} url
 */
export function releaseSourceBitmap(url) {
  const { state, shouldClose } = reducePinRefState(_pinRefStates.get(url) ?? INITIAL_PIN_REF_STATE, 'evict');
  if (!shouldClose) {
    _pinRefStates.set(url, state);
    return;
  }
  _pinRefStates.delete(url);
  closeAndForgetSource(url);
}

/** The actual close-and-drop `releaseSourceBitmap` defers until any in-flight
 * pinned-path reader (tracked in `_pinRefStates`) has released this URL. */
function closeAndForgetSource(url) {
  _sourceCache
    .get(url)
    ?.then((bmp) => bmp.close?.())
    .catch(() => {});
  _sourceCache.delete(url);
}

/**
 * Decode one page: crop `worldRect` out of an already-decoded source bitmap
 * and place it into a `pageSizePx` square output (border + payload together —
 * Keyhole Q1 default 256). This is the cheap step; `getSourceBitmap()` (the
 * one potentially-expensive full decode) should already have resolved before
 * calling this in a tight loop.
 *
 * TWO PATHS, chosen by `computePagePlacement` (see its doc for the bug this
 * split fixes):
 * - INTERIOR pages (the overwhelming majority — `worldRect` fully inside the
 *   world, clamped === unclamped): a single `createImageBitmap` resize, exactly
 *   as before. Cheapest path, unchanged.
 * - EDGE/CORNER pages (the world's outermost ring, wherever worldSizePx isn't
 *   an exact multiple of the page payload): composite via an `OffscreenCanvas`
 *   instead. `ctx.drawImage(source, sx,sy,sw,sh, dx,dy,dw,dh)` places the REAL
 *   crop at its true relative position/size (no stretch), then two clamp-
 *   extend passes repeat the nearest real edge pixel into the padding.
 *   Horizontal pass first (spanning only the real vertical extent [dy,dy+dh)),
 *   vertical pass second reading the FULL canvas width — by then the
 *   horizontal pass has already extended real content across the whole row,
 *   so the vertical pass's source row is full-width and fills the four
 *   corners too, with no separate corner-case code. `drawImage`'s source
 *   region is spec-guaranteed to be snapshotted before the destination write,
 *   so a self-referential canvas-onto-itself draw (used here) is well-defined
 *   even where source/dest rects are adjacent, never a race.
 *   OffscreenCanvas (not a DOM `<canvas>`) is also what a future Worker-based
 *   decode would need anyway — see this file's header's tracked Worker-pool
 *   deferral; this path is forward-compatible with it, not a detour from it.
 *
 * NOTE — world-rect -> source-pixel-rect assumes the source image's pixel
 * grid is 1:1 with this virtual texture's world units at mip 0 (true for the
 * torture fixture and for MSA's authored backgrounds/masks, which are
 * painted at native map resolution). A source atlas with a different native
 * resolution would need a scale factor here — not needed yet, noted for when
 * it is.
 *
 * @param {ImageBitmap} sourceBitmap
 * @param {{minX:number,minY:number,maxX:number,maxY:number,unclamped:{minX:number,minY:number,maxX:number,maxY:number}}} worldRect
 *   - the FULL `pageWorldRect()` result (its `.unclamped` field is required here).
 * @param {number} [pageSizePx]
 * @returns {Promise<ImageBitmap>}
 */
export function decodePage(sourceBitmap, worldRect, pageSizePx = 256) {
  return createImageBitmap(decodePageToCanvas(sourceBitmap, worldRect, pageSizePx));
}

/**
 * The crop itself, rendered into an `OffscreenCanvas` (both interior and
 * edge/corner pages). Split out from `decodePage` so ONE crop can feed BOTH the
 * GPU upload (`createImageBitmap(canvas)`) AND the IndexedDB persist
 * (`canvas.convertToBlob()`) — a canvas owns its pixels independently of any
 * derived bitmap, so there's no bitmap-lifetime race between "upload it" and
 * "persist it". Same two-case logic as `decodePage` had (see `computePagePlacement`).
 *
 * @param {ImageBitmap} source
 * @param {{minX:number,minY:number,maxX:number,maxY:number,unclamped:{minX:number,minY:number,maxX:number,maxY:number}}} worldRect
 * @param {number} [pageSizePx]
 * @returns {OffscreenCanvas}
 */
export function decodePageToCanvas(source, worldRect, pageSizePx = 256) {
  const sx = Math.round(worldRect.minX);
  const sy = Math.round(worldRect.minY);
  const sw = Math.max(1, Math.round(worldRect.maxX - worldRect.minX));
  const sh = Math.max(1, Math.round(worldRect.maxY - worldRect.minY));

  const canvas = new OffscreenCanvas(pageSizePx, pageSizePx);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const placement = computePagePlacement(worldRect, worldRect.unclamped, pageSizePx);
  if (!placement.needsPadding) {
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, pageSizePx, pageSizePx);
    return canvas;
  }

  const { dx, dy, dw, dh } = placement;
  ctx.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
  if (dx > 0) ctx.drawImage(canvas, dx, dy, 1, dh, 0, dy, dx, dh); // pad left: repeat leftmost real column
  if (dx + dw < pageSizePx) {
    ctx.drawImage(canvas, dx + dw - 1, dy, 1, dh, dx + dw, dy, pageSizePx - (dx + dw), dh); // pad right
  }
  if (dy > 0) ctx.drawImage(canvas, 0, dy, pageSizePx, 1, 0, 0, pageSizePx, dy); // pad top (full width — see doc above)
  if (dy + dh < pageSizePx) {
    ctx.drawImage(canvas, 0, dy + dh - 1, pageSizePx, 1, 0, dy + dh, pageSizePx, pageSizePx - (dy + dh)); // pad bottom
  }
  return canvas;
}

// ---------------------------------------------------------------------------
// Bounded slice-source management + IndexedDB-backed page acquisition.
// This is the decode-memory fix: never hold more than
// SLICE_MAX_CONCURRENT_SOURCES full bitmaps at once, and serve already-sliced
// pages from IndexedDB so a source need never be re-held once its pages exist.
// ---------------------------------------------------------------------------

// createSemaphore moved to decode-primitives.js (imported above) — a generic,
// pure counting semaphore with no decode-pool-specific knowledge.

const _sliceSem = createSemaphore(SLICE_MAX_CONCURRENT_SOURCES);
/** @type {Map<string, {bitmap: ImageBitmap, refs: number}>} url -> currently-held source for slicing */
const _sliceHeld = new Map();
/** @type {Map<string, Promise<ImageBitmap>>} url -> in-flight decode (dedupe concurrent acquires) */
const _sliceInflight = new Map();
const _decodeStats = {
  sourcesDecoded: 0,
  idbHits: 0,
  idbSlices: 0,
  idbPersists: 0,
  // SUB-STEP TIMING (2026-07-16 — the zoom-thrash-test showed a 775ms freeze
  // whose snapshot had sourcesDecoded 0→1 + heldSources 1 + only 4 slices,
  // meaning the time was in acquiring/first-touching the FULL source image,
  // NOT the per-page slice loop the time-budget yield already tames. These
  // pinpoint EXACTLY which un-chunkable main-thread operation is the cost, so
  // the real fix targets the right thing — see getDecodeStats' report shape.)
  maxSourceAcquireMs: 0, // wait for fetch + createImageBitmap(blob) of a full source
  lastSourceAcquireMs: 0,
  maxSinglePageMs: 0, // one page's decodePageToCanvas + createImageBitmap(canvas) — catches the
  // first-drawImage realization of a freshly-decoded 144MP source (a synchronous main-thread cost)
  lastSinglePageMs: 0,
  // PATH ATTRIBUTION (2026-07-16 — a SECOND live hitch, after the worker
  // shipped, had sourcesDecoded incrementing with almost no page-slicing done
  // yet: NOT the page-slice path (already off-thread) — traced to
  // getSourceDimensions()'s OWN separate fallback, called once per pack at
  // floor-load time (including from background floor-prewarm, fire-and-
  // forget, so it can fire mid-thrash with zero warning), which called
  // acquireSliceSource() DIRECTLY on the main thread. These two counters make
  // "did a source decode actually stay off the main thread" a durable,
  // permanent, always-visible fact in every report — not something that has
  // to be re-derived by correlating timestamps by hand, which is how the
  // first of these two path-specific bugs almost hid. workerSourceDecodes
  // should track sourcesDecoded 1:1 once every path is worker-ized;
  // mainThreadFallbackSourceDecodes > 0 is now an unambiguous, permanent
  // tripwire for "something is still touching the main thread with a giant
  // image" — exactly the class of regression that becomes far harder to spot
  // once real effects add more decode-triggering consumers.
  workerSourceDecodes: 0,
  mainThreadFallbackSourceDecodes: 0,
  // How many times the "cheap" ranged-fetch dimension probe did NOT get a
  // genuine partial (206) response — i.e. the asset server ignored the Range
  // header and returned the whole file, or the request failed outright. A
  // nonzero value here answers "does this server honor Range requests" with
  // a number instead of an assumption.
  rangedFetchMisses: 0,
};

/** Fetch + decode a full source bitmap (NOT cached — the ring owns its lifetime). @param {string} url @returns {Promise<ImageBitmap>} */
function fetchAndDecode(url) {
  return fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`decode-pool: ${url} -> HTTP ${res.status}`);
      return res.blob();
    })
    .then((blob) => createImageBitmap(blob));
}

/**
 * Acquire a full source bitmap for slicing, bounded by the semaphore so at most
 * SLICE_MAX_CONCURRENT_SOURCES exist at once. Reuses a pinned proxy bitmap
 * (`getSourceBitmap`'s `_sourceCache`) for free when present (avoids
 * double-decoding albedo). Returns the bitmap plus a `done()` the caller MUST
 * invoke when its slice batch is finished — the bitmap is closed + its
 * semaphore slot freed once the last user releases it.
 * @param {string} url @returns {Promise<{source: ImageBitmap, done: () => void}>}
 */
async function acquireSliceSource(url) {
  const pinned = _sourceCache.get(url);
  if (pinned) {
    // Ref BEFORE awaiting, not after — closes the window where a concurrent
    // releaseSourceBitmap could see zero refs and close the bitmap while this
    // call is still (in practice, briefly) waiting on that same promise. See
    // reducePinRefState's doc (decode-primitives.js) for the full race.
    _pinRefStates.set(url, reducePinRefState(_pinRefStates.get(url) ?? INITIAL_PIN_REF_STATE, 'acquire').state);
    try {
      const bitmap = await pinned;
      return { source: bitmap, done: () => releasePinRef(url) };
    } catch (err) {
      releasePinRef(url);
      throw err;
    }
  }

  const held = _sliceHeld.get(url);
  if (held) {
    held.refs++;
    return { source: held.bitmap, done: () => releaseSliceSource(url) };
  }

  await _sliceSem.acquire();
  // Re-check after the await — a concurrent acquire may have created it while we waited.
  const held2 = _sliceHeld.get(url);
  if (held2) {
    _sliceSem.release(); // we won't create one; give the slot back
    held2.refs++;
    return { source: held2.bitmap, done: () => releaseSliceSource(url) };
  }

  let bitmap;
  const acquireStartMs = perfNowMs();
  try {
    let p = _sliceInflight.get(url);
    if (!p) {
      p = fetchAndDecode(url);
      _sliceInflight.set(url, p);
    }
    bitmap = await p;
  } catch (err) {
    _sliceSem.release();
    _sliceInflight.delete(url);
    throw err;
  }
  const acquireMs = perfNowMs() - acquireStartMs;
  _decodeStats.lastSourceAcquireMs = Math.round(acquireMs);
  _decodeStats.maxSourceAcquireMs = Math.max(_decodeStats.maxSourceAcquireMs, Math.round(acquireMs));
  _sliceInflight.delete(url);
  _decodeStats.sourcesDecoded++;
  // This function ONLY ever runs on the main thread (it's the fallback path,
  // never called from the worker) — every call here is, by definition, a
  // giant-image decode the render loop could feel. See _decodeStats' own doc
  // for why this counter is a permanent tripwire, not a one-off debugging aid.
  _decodeStats.mainThreadFallbackSourceDecodes++;
  recordMainThreadFallback(acquireStartMs, url, acquireMs);
  _sliceHeld.set(url, { bitmap, refs: 1 });
  return { source: bitmap, done: () => releaseSliceSource(url) };
}

/** Time one page's synchronous decode (drawImage crop + createImageBitmap) — records the max/last
 * single-page cost so a giant first-drawImage realization of a fresh 144MP source is visible in stats. */
async function timedDecodePage(source, rect, pageSizePx) {
  const t0 = perfNowMs();
  const canvas = decodePageToCanvas(source, rect, pageSizePx);
  const bitmap = await createImageBitmap(canvas);
  const ms = perfNowMs() - t0;
  _decodeStats.lastSinglePageMs = Math.round(ms);
  _decodeStats.maxSinglePageMs = Math.max(_decodeStats.maxSinglePageMs, Math.round(ms));
  return { canvas, bitmap };
}

// ---------------------------------------------------------------------------
// OFF-MAIN-THREAD DECODE (2026-07-16). Routes the expensive source-decode +
// slice through decode-pool.worker.js so the main thread never touches the
// 144MP source (the ~398ms decode + ~601ms first-draw freeze the zoom-thrash-
// test pinned down). A robust fallback keeps the ORIGINAL main-thread path as
// a safety net: if the worker can't be constructed (module-worker unsupported,
// URL blocked, etc.) or a request errors, acquirePages/acquirePackedPages
// silently fall back to slicing on the main thread — the behavior that already
// worked (just with the freeze). Nothing this adds can BREAK decoding; worst
// case it doesn't help.
// ---------------------------------------------------------------------------
let _decodeWorker = null;
let _decodeWorkerUnavailable = false; // set once if construction/loading ever fails — never retried (avoids thrash)
let _decodeWorkerUnavailableReason = null; // the ACTUAL error, surfaced in getDecodeStats — never require a console check to see why
const _workerPending = new Map(); // reqId -> { resolve, reject }
let _nextWorkerReqId = 1;

function ensureDecodeWorker() {
  if (_decodeWorker || _decodeWorkerUnavailable) return _decodeWorker;
  try {
    _decodeWorker = new Worker(new URL('./decode-pool.worker.js', import.meta.url), { type: 'module' });
    _decodeWorker.onmessage = (e) => {
      const { id, ok, results, dimensions, stats, error } = e.data;
      const pending = _workerPending.get(id);
      if (!pending) return;
      _workerPending.delete(id);
      if (ok) pending.resolve({ results, dimensions, stats });
      else pending.reject(new Error(error));
    };
    _decodeWorker.onerror = (e) => {
      // Worker crashed or failed to load — permanently fall back to main thread.
      _decodeWorkerUnavailable = true;
      _decodeWorkerUnavailableReason = String(e?.message || e || 'unknown worker error');
      for (const p of _workerPending.values()) p.reject(new Error(`decode worker error: ${e?.message || 'unknown'}`));
      _workerPending.clear();
      try {
        _decodeWorker?.terminate?.();
      } catch (_) {}
      _decodeWorker = null;
      console.error('[decode-pool] decode worker failed — falling back to main-thread decode.', e?.message || e);
    };
  } catch (err) {
    _decodeWorkerUnavailable = true;
    _decodeWorkerUnavailableReason = String(err?.message || err);
    _decodeWorker = null;
    console.warn('[decode-pool] could not create decode worker — using main-thread decode.', err?.message || err);
  }
  return _decodeWorker;
}

/**
 * PER-REQUEST WORKER FAILURES (2026-07-17 — the freeze investigation). Every
 * failure here used to be swallowed silently (`catch(_){ return null; }`) —
 * `tryWorkerSlice` returning null is the ONLY thing separating a fast
 * off-thread decode from a main-thread one big enough to freeze the frame
 * (measured live: a 2.5s stall), and until now there was NO way to see which
 * requests fell that way, or why. `mainThreadFallbackSourceDecodes` said HOW
 * MANY; nothing said WHICH SOURCE or WHAT ERROR. Bounded ring buffer — this
 * is diagnostics, not a growing log.
 * @type {Array<{kind:string, url:string, reason:string}>}
 */
const _workerRequestFailures = [];
const WORKER_REQUEST_FAILURE_LOG_MAX = 10;

/** @param {string} kind @param {string} url @param {string} reason */
function recordWorkerRequestFailure(kind, url, reason) {
  _workerRequestFailures.push({ kind, url: String(url).slice(-80), reason });
  if (_workerRequestFailures.length > WORKER_REQUEST_FAILURE_LOG_MAX) _workerRequestFailures.shift();
}

/**
 * PER-EVENT MAIN-THREAD FALLBACK TIMING (rapid-pan-hitch-2026-08-12). A
 * DIFFERENT question from `_workerRequestFailures` above: that log says WHY a
 * request fell back (a worker failure); this one says HOW LONG each fallback
 * actually took and WHEN, which `mainThreadFallbackSourceDecodes` (a count)
 * and `maxSourceAcquireMs`/`lastSourceAcquireMs` (session-lifetime max/last)
 * cannot: a single catastrophic 2.5s event and five 200ms ones both look
 * identical in those three numbers alone. Fed by `acquireSliceSource`'s own
 * already-computed `acquireStartMs`/`acquireMs` — no new clock read. Bounded
 * ring buffer, same discipline as `_workerRequestFailures` immediately above.
 * @type {Array<{atMs: number, url: string, ms: number}>}
 */
const _mainThreadFallbackLog = [];
const MAIN_THREAD_FALLBACK_LOG_MAX = 10;

/** @param {number} atMs @param {string} url @param {number} ms */
function recordMainThreadFallback(atMs, url, ms) {
  _mainThreadFallbackLog.push({ atMs: Math.round(atMs), url: String(url).slice(-80), ms: Math.round(ms) });
  if (_mainThreadFallbackLog.length > MAIN_THREAD_FALLBACK_LOG_MAX) _mainThreadFallbackLog.shift();
}

/**
 * Send a slice request to the worker; resolve with `{results, dimensions, stats}`
 * or return null if the worker is unavailable (caller must fall back). A
 * request-level error also resolves to null — a single failed worker request
 * must never take down decoding; the main-thread path covers it. The FAILURE
 * ITSELF is no longer discarded — see `recordWorkerRequestFailure` above.
 * @param {object} msg
 * @returns {Promise<{results?: Array<{key:string, bitmap:ImageBitmap}>, dimensions?: {width:number,height:number}, stats:object}|null>}
 */
async function tryWorkerSlice(msg) {
  const w = ensureDecodeWorker();
  if (!w) return null;
  const id = _nextWorkerReqId++;
  const promise = new Promise((resolve, reject) => _workerPending.set(id, { resolve, reject }));
  try {
    w.postMessage({ ...msg, id });
  } catch (err) {
    _workerPending.delete(id);
    recordWorkerRequestFailure(msg.kind, msg.url, `postMessage threw: ${err?.message || err}`); // e.g. not cloneable
    return null;
  }
  try {
    return await promise;
  } catch (err) {
    recordWorkerRequestFailure(msg.kind, msg.url, err?.message || String(err)); // the worker reported ok:false
    return null;
  }
}

/**
 * Ask the worker to decode a source purely to read its width/height — the
 * off-thread counterpart to `getSourceDimensions()`'s ranged-fetch fallback
 * (2026-07-16, see decode-pool.worker.js's `handleDimensions` doc for the
 * real live bug this closes). Returns null (caller falls back to main-thread
 * `acquireSliceSource`) if the worker is unavailable or the request errors.
 * @param {string} url
 * @returns {Promise<{width:number, height:number}|null>}
 */
async function tryWorkerDimensions(url) {
  const worker = await tryWorkerSlice({ kind: 'dimensions', url });
  if (!worker || !worker.dimensions) return null;
  _decodeStats.workerSourceDecodes++;
  if (typeof worker.stats?.sourceAcquireMs === 'number') {
    _decodeStats.lastSourceAcquireMs = Math.round(worker.stats.sourceAcquireMs);
    _decodeStats.maxSourceAcquireMs = Math.max(
      _decodeStats.maxSourceAcquireMs,
      Math.round(worker.stats.sourceAcquireMs)
    );
  }
  return worker.dimensions;
}

/** Fold a worker slice response's timing/counters into the shared _decodeStats + return the paged results. */
function foldWorkerResults(worker, pages, sourcesDecodedDelta) {
  _decodeStats.workerSourceDecodes += sourcesDecodedDelta;
  const pageByKey = new Map(pages.map((p) => [p.key, p]));
  const out = [];
  for (const { key, bitmap } of worker.results) {
    const page = pageByKey.get(key);
    if (page) out.push({ page, bitmap });
  }
  const s = worker.stats || {};
  _decodeStats.idbSlices += s.sliced ?? worker.results.length;
  _decodeStats.sourcesDecoded += sourcesDecodedDelta;
  if (typeof s.sourceAcquireMs === 'number') {
    _decodeStats.lastSourceAcquireMs = Math.round(s.sourceAcquireMs);
    _decodeStats.maxSourceAcquireMs = Math.max(_decodeStats.maxSourceAcquireMs, Math.round(s.sourceAcquireMs));
  }
  if (typeof s.maxSinglePageMs === 'number') {
    _decodeStats.maxSinglePageMs = Math.max(_decodeStats.maxSinglePageMs, Math.round(s.maxSinglePageMs));
  }
  return out;
}

/** Minimal cloneable page list for a worker message (strip to just what the worker reads). */
function pagesForWorker(pages) {
  return pages.map((p) => ({ mip: p.mip, px: p.px, py: p.py, key: p.key }));
}

function releaseSliceSource(url) {
  const held = _sliceHeld.get(url);
  if (!held) return;
  held.refs--;
  if (held.refs <= 0) {
    try {
      held.bitmap.close?.();
    } catch (_) {}
    _sliceHeld.delete(url);
    _sliceSem.release(); // free the slot for the next NEW source
  }
}

/** `done()` for acquireSliceSource's PINNED fast path — the `_pinRefStates`
 * counterpart to `releaseSliceSource` above. Closes the source here (instead
 * of immediately in releaseSourceBitmap) if a releaseSourceBitmap(url) call
 * arrived while this was still the last active pinned-path reader. */
function releasePinRef(url) {
  const { state, shouldClose } = reducePinRefState(_pinRefStates.get(url) ?? INITIAL_PIN_REF_STATE, 'release');
  if (shouldClose) {
    _pinRefStates.delete(url);
    closeAndForgetSource(url);
    return;
  }
  // Back to the untracked initial state (no active reader, nothing pending)?
  // Drop the entry rather than storing one indistinguishable from "absent" —
  // `_pinRefStates` should stay bounded to URLs with something to remember
  // right now, not grow one entry per distinct URL ever pin-referenced this
  // session (the exact unbounded-growth shape this whole fix exists to end).
  if (state.refs === 0 && !state.pendingRelease) {
    _pinRefStates.delete(url);
  } else {
    _pinRefStates.set(url, state);
  }
}

/** Persist one sliced page's pixels (fire-and-forget; failure is non-fatal). @param {string} key @param {OffscreenCanvas} canvas */
function persistPage(key, canvas) {
  try {
    canvas
      .convertToBlob({ type: 'image/png' })
      .then((blob) => putPageBlob(key, blob))
      .then((ok) => {
        if (ok) _decodeStats.idbPersists++;
      })
      .catch(() => {});
  } catch (_) {}
}

/**
 * Re-persist a WORKER-decoded page under the validated key, closing the loop
 * `getContentValidator` opens. The worker's own `persist()` (decode-pool.
 * worker.js) still writes under the PLAIN url/packId it was dispatched with —
 * changing that would mean widening the worker message protocol, a cross-
 * thread change this fix deliberately avoids touching. Left alone, that gap
 * would make every worker-decoded page a PERMANENT miss against the validated
 * key every future lookup asks for — correct (never stale) but wasteful
 * (re-decoding pages that haven't actually changed, every single session).
 * This closes it from the main thread instead: cheap (an `ImageBitmap` is
 * already fully decoded; drawing it once costs nothing like a real decode),
 * additive (the worker's own persist is untouched, so this is pure belt-and-
 * braces), and only ever runs for genuine MISSES — never the hot hit path.
 * @param {string} keyUrl @param {{mip:number,px:number,py:number}} page @param {ImageBitmap} bitmap
 */
function repersistUnderValidatedKey(keyUrl, page, bitmap) {
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    persistPage(pageStoreKey(keyUrl, page.mip, page.px, page.py), canvas);
  } catch (_) {
    // Best-effort — the page still renders fine this frame either way; only
    // a FUTURE session's cache-hit rate is at stake here, never correctness.
  }
}

// parseImageDimensions moved to decode-primitives.js (imported above) — pure
// PNG/WebP header parsing; see that file for the WebP device-loss history.

// toRootAbsoluteAssetUrl moved to decode-primitives.js (imported above) —
// pure string transform; see that file for the mansion-mask-404 history.

/**
 * Read a source image's dimensions WITHOUT a full decode, via a tiny ranged
 * fetch of just its header (see `parseImageDimensions` for the formats and the
 * WebP bug that made this path the device-loss investigation's smoking gun).
 *
 * FALLBACK IS OFF-MAIN-THREAD FIRST (2026-07-16 — a real live bug: this
 * fallback used to call `acquireSliceSource()` directly on the main thread —
 * a full source decode NEVER routed through decode-pool.worker.js, since it's
 * a completely separate code path from page slicing. Called once per PACK at
 * floor-load time, INCLUDING from the background floor-prewarm
 * (`vt-pan-viewer.js`, fire-and-forget) — so it could fire mid-pan/mid-zoom
 * with zero warning). Now that the header path handles WebP too, this decode
 * fallback is genuinely rare (a truncated/corrupt/unknown header), not the
 * every-single-source cost it silently was.
 * @param {string} url @returns {Promise<{width:number, height:number}>}
 */
export async function getSourceDimensions(url) {
  url = toRootAbsoluteAssetUrl(url); // worker-fetchable + key-consistent (see toRootAbsoluteAssetUrl)
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-33' } });
    if (res.ok || res.status === 206) {
      // STREAMED, NOT res.arrayBuffer() (found 2026-07-17, the freeze
      // investigation — a REAL, separate waste, not just a theory): if the
      // server IGNORES the Range header and answers 200 with the FULL FILE,
      // `res.arrayBuffer()` buffers the ENTIRE response before this function
      // can read even one byte of it — for this project's own scale (a Level
      // background is hundreds of MB) that is exactly the "one line looks
      // entirely reasonable and IS the crisis" trap §0's law exists to catch,
      // just on the network/memory axis. `readLeadingBytes` reads only what the
      // header needs and CANCELS the rest — cheap whether or not Range was
      // honored. 30 bytes: enough for a WebP VP8X/VP8X canvas header (PNG needs 24).
      const header = await readLeadingBytes(res, 30);
      const dims = parseImageDimensions(header);
      if (dims) {
        // A genuine 206 means Range was honored; a 200 means the server sent the
        // whole file and only `readLeadingBytes`'s stream-cancel saved us — THAT
        // is the real "range miss", and now that WebP parses it's an honest
        // signal again instead of firing on every valid WebP.
        if (res.status !== 206) _decodeStats.rangedFetchMisses++;
        return dims;
      }
    }
  } catch (_) {}

  _decodeStats.rangedFetchMisses++;
  const worker = await tryWorkerDimensions(url);
  if (worker) return worker;

  const { source, done } = await acquireSliceSource(url);
  try {
    return { width: source.width, height: source.height };
  } finally {
    done();
  }
}

// readLeadingBytes moved to decode-primitives.js (imported above) — pure
// stream-read-then-cancel; see that file for the Range-miss history.

/**
 * Acquire the decoded page bitmaps for a set of pages of one source — the
 * memory-bounded replacement for "hold the whole source and crop on demand".
 * For each page: try IndexedDB first (a tiny persisted blob → `createImageBitmap`,
 * no source decode). Only pages NOT yet persisted trigger a bounded acquire of
 * the full source; each is sliced, uploaded-caller-side, AND persisted so it's
 * an IndexedDB hit next time. The full source is released the instant the batch
 * ends, so it never lingers.
 *
 * @param {string} url - the source image URL (identity for the page store + ring).
 * @param {import('./page-table.js').PageTable} table
 * @param {Array<{mip:number, px:number, py:number}>} pages
 * @param {object} [opts] @param {number} [opts.borderPx] @param {number} [opts.pageSizePx]
 * @returns {Promise<Array<{page:{mip:number,px:number,py:number}, bitmap: ImageBitmap}>>}
 */
export async function acquirePages(url, table, pages, opts = {}) {
  url = toRootAbsoluteAssetUrl(url); // fetch + page-store key both use this form (see toRootAbsoluteAssetUrl)
  const borderPx = opts.borderPx ?? DEFAULT_BORDER_PX;
  const pageSizePx = opts.pageSizePx ?? 256;
  const results = [];
  const misses = [];
  // THE CONTENT VALIDATOR — see `getContentValidator`'s own doc for the gap
  // this closes (`pageStoreKey`'s unfinished "URL+mtime" design intent). Falls
  // back to the plain `url` (today's behaviour, byte-identical) when this
  // URL can't be validated. Resolved ONCE per call, not per page — same
  // "once per batch" cost discipline `acquirePackedPages` already applies to
  // its own channel-source acquisition.
  const keyUrl = (await resolveValidatedUrls([url])).get(url) ?? url;

  for (const page of pages) {
    const key = pageStoreKey(keyUrl, page.mip, page.px, page.py);
    let blob = null;
    try {
      blob = await getPageBlob(key);
    } catch (_) {
      blob = null;
    }
    if (blob) {
      try {
        results.push({ page, bitmap: await createImageBitmap(blob) });
        _decodeStats.idbHits++;
        continue;
      } catch (_) {
        // Corrupt persisted blob — fall through and re-slice from source.
      }
    }
    misses.push(page);
  }

  if (misses.length > 0) {
    // OFF-MAIN-THREAD FIRST: hand the source-decode + slice to the worker so
    // the giant-source touch never blocks the render loop. Returns null (and
    // we fall through to the main-thread path below) if the worker is
    // unavailable or this request errored.
    const worker = await tryWorkerSlice({
      kind: 'slice',
      url,
      pages: pagesForWorker(misses),
      worldWidthPx: table.worldWidthPx,
      worldHeightPx: table.worldHeightPx,
      payloadPx: table.payloadPx,
      borderPx,
      pageSizePx,
    });
    if (worker) {
      const fromWorker = foldWorkerResults(worker, misses, 1); // one source decoded
      results.push(...fromWorker);
      // See `repersistUnderValidatedKey`'s own doc — the worker's own persist
      // (decode-pool.worker.js) still writes under the plain `url`; this
      // closes the loop so a FUTURE session's validated lookup can hit too.
      if (keyUrl !== url) for (const { page, bitmap } of fromWorker) repersistUnderValidatedKey(keyUrl, page, bitmap);
    } else {
      // FALLBACK — the original main-thread slice path (still correct, just
      // with the giant-source freeze the worker exists to remove).
      const { source, done } = await acquireSliceSource(url);
      let lastYieldMs = perfNowMs();
      try {
        for (const page of misses) {
          const rect = pageWorldRect(table, page.mip, page.px, page.py, { borderPx });
          const { canvas, bitmap } = await timedDecodePage(source, rect, pageSizePx);
          results.push({ page, bitmap });
          _decodeStats.idbSlices++;
          persistPage(pageStoreKey(keyUrl, page.mip, page.px, page.py), canvas);
          const now = perfNowMs();
          if (shouldYieldByTime(now - lastYieldMs, MAX_MS_PER_DECODE_CHUNK)) {
            await yieldToMain();
            lastYieldMs = perfNowMs();
          }
        }
      } finally {
        done();
      }
    }
  }
  return results;
}

/**
 * ⚠️⚠️ THE PACKED TRIO HAS ONE ALPHA SLOT AND THREE SEPARATELY-AUTHORED
 * SOURCES (2026-08-02, the cause of "Foundry's shadows look nothing like the
 * Shader Lab's").
 *
 * The original packer wrote `out[a] = rPix[a]` under a comment reading *"shared
 * structural-hole alpha (identical across the trio by design)"*. That invariant
 * is REAL — for `tools/make-torture-world.mjs`, whose `fillHoleAlpha` paints the
 * same hole into all three synthetic masks. It is FALSE for authored art: on the
 * real Town River Bridge map `_Shadow` and `_Outdoors` are different paintings
 * with different transparency, and `_Outdoors`' own alpha never survived packing.
 *
 * What that cost: `mask-derive.js#compositeItemOverwrite` composites a floor's
 * `_Outdoors` sources by alpha, because the author's ruling is *"transparent
 * means unpainted — composite by alpha. Transparent also means not inside a
 * building."* Fed `_Shadow`'s alpha instead (opaque wherever the shadow mask is
 * painted), every transparent `_Outdoors` texel wrote its colour byte — which is
 * 0 — i.e. INDOORS. `Tower_Bridge_Middle_Overhead_Outdoors.webp` is 98.1%
 * transparent and contains ZERO opaque-dark pixels, yet it was blackening the
 * map: the floor's wall channel measured 73.8% covered live against 14.4% in the
 * bench off the same file. Near-total wall coverage is what the author saw as a
 * blurred, detached shadow — the receiver gate blanked most of the floor and
 * every surviving outdoor sliver sat inside overlapping smears from all sides.
 *
 * THE RULE: the alpha slot belongs to the ONE kind that composites by alpha
 * (`MaskKind.rasterize`); the other two are resolved against their own
 * `absentValue` AT PACK TIME, where their alpha still exists. Afterwards every
 * channel means what it says with no alpha needed — except the owner, whose
 * alpha is exactly the "did the author paint here" bit its rasterizer wants.
 *
 * ⚠️ THAT RESOLUTION IS A THRESHOLD, NOT A LINEAR BLEND (2026-08-13). The
 * first version computed `raw × a + absentByte × (1 − a)` — a genuinely
 * transparent (a=0) texel correctly resolved to `absentByte`, exactly the
 * catalog's own reasoning for giving `fire` no alpha slot ("a transparent
 * texel is not fire" — `mask-catalog.js#packedTrioChannelPolicy`) — but a
 * PARTIALLY transparent one (an antialiased brush edge, a=0.3..0.9) got its
 * RAW VALUE scaled down by however soft that edge happened to be, even though
 * neither `fire`'s nor `shadow`'s own catalog `meaning` says anything about
 * alpha at all — both are pure grayscale signals ("white=fire, black=none").
 * A small/thin painted stroke is mostly edge and almost no solid core, so it
 * lost far more of its intensity to this than a large blob with a big opaque
 * centre ever would — author-reported live: fire painted small on an upper
 * floor registered nothing, while the identical paint amount worked fine on
 * the ground floor, and the SAME small paint's own peak stored byte measured
 * 234/255 rather than a clean 255 — exactly this attenuation's signature.
 * `compositePackedTexels` now gates on alpha (`PACKED_CHANNEL_ALPHA_GATE`)
 * instead of scaling by it: below the gate a texel is the faintest fringe of
 * nothing really painted there (still correctly absent); at or above it, the
 * artist meant to paint here, and gets their RAW value back, undimmed by
 * whatever alpha their brush's edge happened to leave behind.
 *
 * Passing no policy reproduces the old bytes exactly, so the torture world (whose
 * shared-hole invariant is genuine) is unaffected.
 *
 * @typedef {{alphaOwner:'r'|'g'|'b', absentByte:{r:number|null,g:number|null,b:number|null}}} PackChannelPolicy
 */
export const LEGACY_PACK_CHANNEL_POLICY = /** @type {PackChannelPolicy} */ (
  Object.freeze({ alphaOwner: 'r', absentByte: Object.freeze({ r: null, g: null, b: null }) })
);

/**
 * THE ANTIALIASED-FRINGE GATE for a non-owner packed channel's own alpha byte
 * (0..255) — mirrors `scene/mask-derive.js#HEIGHT_COVERAGE_THRESHOLD`'s own
 * value and reasoning exactly (that module is a different zone; `vt/` cannot
 * import across the boundary, so this is its own copy, not a shared
 * reference — the same "every consumer gets its own copy" discipline this
 * codebase already applies to its depth-authority resolvers). Below this, a
 * texel is the faintest fringe of an antialiased edge, nothing really painted
 * there. At or above it, the artist meant this pixel to carry real content.
 */
const PACKED_CHANNEL_ALPHA_GATE = 8;

/**
 * Bumped whenever the recipe above changes. It rides in the IndexedDB page-store
 * key, because a packed page is persisted by `packId` and a stale composite is
 * indistinguishable from a fresh one — the [[feedback_url_keyed_cache_needs_a_content_validator]]
 * class, where a same-name re-upload served the OLD encode. Without this bump
 * every returning session would keep serving pages packed under the broken rule
 * and the fix would look like it did nothing.
 */
export const PACK_RECIPE_VERSION = 4;

/**
 * Composite one packed RGBA page from its three channel sources, in place.
 * SHARED by the main-thread fallback and the worker so the two can never drift
 * (they were two hand-written copies of the same four lines until this landed).
 *
 * @param {Uint8ClampedArray} out - destination RGBA bytes.
 * @param {Uint8ClampedArray} rPix @param {Uint8ClampedArray} gPix @param {Uint8ClampedArray} bPix
 * @param {PackChannelPolicy} [policy]
 */
export function compositePackedTexels(out, rPix, gPix, bPix, policy) {
  const { alphaOwner, absentByte } = policy ?? LEGACY_PACK_CHANNEL_POLICY;
  const src = { r: rPix, g: gPix, b: bPix };
  const ownerPix = src[alphaOwner] ?? rPix;
  const offsetOf = { r: 0, g: 1, b: 2 };
  for (let j = 0; j < out.length; j += 4) {
    for (const ch of /** @type {const} */ (['r', 'g', 'b'])) {
      const pix = src[ch];
      const raw = pix[j];
      const absent = absentByte?.[ch];
      // The owner keeps its RAW byte: its consumer has the alpha and does the
      // source-over itself, so pre-resolving here would apply it twice on the
      // antialiased edge texels. A channel with no absent byte declared keeps
      // the legacy behaviour rather than guessing one.
      if (ch === alphaOwner || absent == null) {
        out[j + offsetOf[ch]] = raw;
      } else {
        // A GATE, NOT A SCALE — see this function's own header for why. Below
        // the fringe threshold the artist didn't mean to paint here (absent);
        // at or above it, they did, and their RAW value survives undimmed —
        // never scaled down by however soft their brush's own edge happened
        // to be, which used to punish a small/thin stroke (mostly edge) far
        // harder than a large blob (mostly solid core) for painting the same
        // way.
        out[j + offsetOf[ch]] = pix[j + 3] >= PACKED_CHANNEL_ALPHA_GATE ? raw : absent;
      }
    }
    out[j + 3] = ownerPix[j + 3];
  }
}

/**
 * CHANNEL-PACKING (Keyhole §4.1, 2026-07-16 — author-confirmed mask taxonomy:
 * single-channel masks — `_Shadow`/`_Outdoors`/`_Fire` — are the only ones that
 * pack; coloured masks (`_Specular`/`_Window`) and RGBA masks (`_Tree`/`_Bush`)
 * each need their own texture). The 3 single-channel masks' source PNGs stay
 * SEPARATE files on disk (each authored/painted independently) — packing
 * happens HERE, at decode time: one composited RGBA page (R/G/B = the three
 * masks' grayscale intensity, A = the SHARED structural-hole alpha, author-
 * confirmed 2026-07-16 to be identical across all masks of one floor) replaces
 * what would otherwise be 3 separate page-tables/indirection-textures/coarse-
 * pin sets. This is what turns "7 masks" into "4 packs" (§4.1's real math,
 * corrected from the plan's original optimistic "13→6" estimate) — the direct
 * lever on the GPU page-cache pressure every live report this session showed
 * (thousands of evictions/misses at 24 unpacked packs × 3 floors).
 *
 * Acquires each of the 3 channel sources ONCE per batch (not once per page) —
 * for a batch of N missed pages, this is 3 bounded slice-source acquisitions
 * total, not 3×N — keeping it as decode-memory-cheap as the unpacked path.
 * `getImageData`/`putImageData` operate on a single 256² page canvas, not the
 * 12000² source — the exact CPU-extraction discipline Keyhole.md §4.1
 * mandates ("per-page CPU extraction... kills the getImageData class" refers
 * to full-source scans; a 256² page is the sanctioned unit).
 *
 * @param {string} packId - a stable synthetic identity for the PACKED result
 *   (e.g. `packed://floor2/shadowOutdoorsFire`) — used as the IndexedDB
 *   persistence key prefix so a packed page, once composited, is never
 *   re-composited. Distinct from any of the 3 channel source URLs.
 * @param {{r:string, g:string, b:string}} channelUrls - the 3 single-channel
 *   mask source URLs.
 * @param {import('./page-table.js').PageTable} table
 * @param {Array<{mip:number, px:number, py:number}>} pages
 * @param {object} [opts] @param {number} [opts.borderPx] @param {number} [opts.pageSizePx]
 * @param {PackChannelPolicy} [opts.channelPolicy] - who owns the alpha slot and
 *   what the other two resolve to where they are transparent. See
 *   `compositePackedTexels`. Omitted = the legacy shared-hole-alpha bytes.
 * @returns {Promise<Array<{page:{mip:number,px:number,py:number}, bitmap: ImageBitmap}>>}
 */
export async function acquirePackedPages(packId, channelUrls, table, pages, opts = {}) {
  // Channel URLs must be worker-fetchable (see toRootAbsoluteAssetUrl); the
  // page-store key is `packId`, so normalizing the channels can't desync it.
  channelUrls = {
    r: toRootAbsoluteAssetUrl(channelUrls.r),
    g: toRootAbsoluteAssetUrl(channelUrls.g),
    b: toRootAbsoluteAssetUrl(channelUrls.b),
  };
  const channelPolicy = opts.channelPolicy ?? null;
  // ONE place stamps the recipe onto the persistence identity, so the main
  // thread, the worker's `persist()`, and the IndexedDB lookup below can never
  // disagree about which recipe a stored page was baked under.
  packId = `${packId}#pack${PACK_RECIPE_VERSION}`;
  // THE CONTENT VALIDATOR — see `getContentValidator`'s own doc for the gap
  // this closes. All 3 channel sources fold in (any one of `_Shadow`/
  // `_Outdoors`/`_Fire` changing must invalidate the SHARED packed page), and
  // `keyPackId` falls back to the plain `packId` (today's behaviour, byte-
  // identical) when none of the three can be validated.
  const [rV, gV, bV] = await Promise.all([channelUrls.r, channelUrls.g, channelUrls.b].map(getContentValidator));
  const keyPackId = rV || gV || bV ? `${packId}@${rV ?? '_'}-${gV ?? '_'}-${bV ?? '_'}` : packId;
  const borderPx = opts.borderPx ?? DEFAULT_BORDER_PX;
  const pageSizePx = opts.pageSizePx ?? 256;
  const results = [];
  const misses = [];

  for (const page of pages) {
    const key = pageStoreKey(keyPackId, page.mip, page.px, page.py);
    let blob = null;
    try {
      blob = await getPageBlob(key);
    } catch (_) {
      blob = null;
    }
    if (blob) {
      try {
        results.push({ page, bitmap: await createImageBitmap(blob) });
        _decodeStats.idbHits++;
        continue;
      } catch (_) {
        // Corrupt persisted blob — fall through and re-composite from sources.
      }
    }
    misses.push(page);
  }

  if (misses.length > 0) {
    // OFF-MAIN-THREAD FIRST (same fallback discipline as acquirePages) — the
    // worker decodes all 3 channel sources + composites, off the render loop.
    const worker = await tryWorkerSlice({
      kind: 'slicePacked',
      packId,
      channelUrls,
      pages: pagesForWorker(misses),
      worldWidthPx: table.worldWidthPx,
      worldHeightPx: table.worldHeightPx,
      payloadPx: table.payloadPx,
      borderPx,
      pageSizePx,
      channelPolicy,
    });
    if (worker) {
      const fromWorker = foldWorkerResults(worker, misses, 3); // 3 channel sources decoded
      results.push(...fromWorker);
      // See `repersistUnderValidatedKey`'s own doc — the worker's own persist
      // (decode-pool.worker.js) still writes under the plain `packId`; this
      // closes the loop so a FUTURE session's validated lookup can hit too.
      if (keyPackId !== packId)
        for (const { page, bitmap } of fromWorker) repersistUnderValidatedKey(keyPackId, page, bitmap);
    } else {
      // FALLBACK — the original main-thread packed compositing path.
      // Slice each channel source ONCE for the whole miss batch, extracting
      // the raw RGBA ImageData per missed page (R=G=B for these grayscale
      // masks, so reading the red byte is the mask's intensity; which source's
      // alpha survives is `channelPolicy`'s call — see compositePackedTexels).
      const channelPixels = {}; // 'r'|'g'|'b' -> Map<pageKey, Uint8ClampedArray>
      for (const ch of /** @type {const} */ (['r', 'g', 'b'])) {
        const { source, done } = await acquireSliceSource(channelUrls[ch]);
        let lastYieldMs = perfNowMs();
        try {
          const perPage = new Map();
          for (const page of misses) {
            const rect = pageWorldRect(table, page.mip, page.px, page.py, { borderPx });
            const canvas = decodePageToCanvas(source, rect, pageSizePx);
            perPage.set(page.key, canvas.getContext('2d').getImageData(0, 0, pageSizePx, pageSizePx).data);
            const now = perfNowMs();
            if (shouldYieldByTime(now - lastYieldMs, MAX_MS_PER_DECODE_CHUNK)) {
              await yieldToMain();
              lastYieldMs = perfNowMs();
            }
          }
          channelPixels[ch] = perPage;
        } finally {
          done();
        }
      }

      let lastYieldMs = perfNowMs();
      for (const page of misses) {
        const canvas = new OffscreenCanvas(pageSizePx, pageSizePx);
        const ctx = canvas.getContext('2d');
        const out = ctx.createImageData(pageSizePx, pageSizePx);
        const rPix = channelPixels.r.get(page.key);
        const gPix = channelPixels.g.get(page.key);
        const bPix = channelPixels.b.get(page.key);
        compositePackedTexels(out.data, rPix, gPix, bPix, channelPolicy);
        ctx.putImageData(out, 0, 0);
        results.push({ page, bitmap: await createImageBitmap(canvas) });
        _decodeStats.idbSlices++;
        persistPage(pageStoreKey(keyPackId, page.mip, page.px, page.py), canvas);
        const now = perfNowMs();
        if (shouldYieldByTime(now - lastYieldMs, MAX_MS_PER_DECODE_CHUNK)) {
          await yieldToMain();
          lastYieldMs = perfNowMs();
        }
      }
    }
  }
  return results;
}

/** Decode/persistence telemetry for the debug panel (see boot.js). */
export function getDecodeStats() {
  return {
    ..._decodeStats,
    heldSources: _sliceHeld.size,
    semaphore: _sliceSem.stats(),
    // PINNED SOURCES — `_sourceCache` (boot.js's `registerFloorProxies`, via
    // `getSourceBitmap`). Unlike heldSources/semaphore above (the BOUNDED
    // slice-decode ring, capped at SLICE_MAX_CONCURRENT_SOURCES), this cache
    // has no size cap by construction: an entry is released only by an
    // explicit `releaseSourceBitmap(url)` call. A count that only ever grows
    // as more distinct scenes are visited in one session is exactly the
    // unbounded-growth `releaseSourceBitmap`'s scene-change caller exists to
    // stop — see that function's own doc.
    pinnedSources: _sourceCache.size,
    // Non-zero here for more than an instant means a releaseSourceBitmap
    // call is waiting on an in-flight pinned-path read to drain (see
    // reducePinRefState's doc) — expected to settle back to 0 quickly, not a
    // steady-state value; a report that keeps finding it nonzero would mean
    // something is holding a pinned read open far longer than a page-slice
    // should ever take.
    pinnedSourcesAwaitingRelease: Array.from(_pinRefStates.values()).filter((s) => s.pendingRelease).length,
    // Worker health, always visible without a console check (this project's
    // established debug-panel protocol): 'active' once successfully created,
    // 'unavailable' + the ACTUAL error if construction/loading ever failed
    // (permanent — never retried), 'not-yet-created' if nothing has asked
    // for it yet this session.
    workerStatus: _decodeWorker ? 'active' : _decodeWorkerUnavailable ? 'unavailable' : 'not-yet-created',
    workerUnavailableReason: _decodeWorkerUnavailableReason,
    // PER-REQUEST failures — the worker can be 'active' (the WHOLE worker is
    // healthy) while INDIVIDUAL requests still fail and fall back to the main
    // thread (mainThreadFallbackSourceDecodes counts how many; THIS is why —
    // 2026-07-17, the freeze investigation). Empty means every worker request
    // this session succeeded; workerStatus:'active' + a nonzero
    // mainThreadFallbackSourceDecodes + an EMPTY log here would mean some
    // OTHER, still-unaccounted-for path is reaching acquireSliceSource — a
    // real gap this log would make visible rather than hide.
    workerRequestFailures: [..._workerRequestFailures],
    // PER-EVENT TIMING for those same fallback decodes (rapid-pan-hitch-
    // 2026-08-12) — see _mainThreadFallbackLog's own doc for what this adds
    // over mainThreadFallbackSourceDecodes/maxSourceAcquireMs above: the last
    // few EVENTS themselves (when, which asset, how long), not just an
    // aggregate count and a session-lifetime max.
    mainThreadFallbackLog: [..._mainThreadFallbackLog],
  };
}

// __createSemaphore / __readLeadingBytes test seams moved to
// decode-primitives.js with the functions they expose.
