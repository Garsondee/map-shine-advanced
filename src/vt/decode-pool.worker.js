/**
 * @fileoverview vt/decode-pool.worker.js — the OFF-MAIN-THREAD source decode +
 * page slicing worker (Keyhole.md §4.1 "worker-decoded", §6 harvest manifest's
 * `tile-decode-worker.js`, §9 risk 2).
 *
 * WHY THIS EXISTS (author-reported live, 2026-07-16, confirmed with hard
 * numbers via the zoom-thrash-test tool + sub-step timing): decoding a full
 * 12000² (144-megapixel, ~576 MB) source image on the MAIN thread froze the
 * render loop for hundreds of ms — `maxSourceAcquireMs: 398` (the
 * `createImageBitmap(blob)` of the giant PNG) + `maxSinglePageMs: 601` (the
 * FIRST `ctx.drawImage(hugeSource, …)` synchronously realizing the 576 MB
 * bitmap into a 2D context). Both are single, un-chunkable browser operations
 * — the per-page cooperative-yield fix (decode-pool.js's `shouldYieldByTime`)
 * cannot break them up, because they aren't a loop. Moving them here means the
 * MAIN thread never touches the giant source at all: it only ever receives the
 * finished, tiny 256² page bitmaps (transferred, zero-copy).
 *
 * SERIAL BY DESIGN: messages are processed one at a time (a promise-chain
 * queue), so at most ONE full source bitmap is ever held in this worker's
 * memory — the same `SLICE_MAX_CONCURRENT_SOURCES`-style bound the main-thread
 * path used, achieved here for free by not overlapping. Total streaming
 * throughput is slightly lower than N-way concurrency, but it's all off the
 * main thread, so the user never feels it — 60 fps holds regardless.
 *
 * IMPORTS: only the PURE page-rasterization functions from decode-pool.js
 * (`pageWorldRect`, `decodePageToCanvas`, `DEFAULT_BORDER_PX`) and the IndexedDB
 * page store (`pyramid-store.js`). decode-pool.js's module-top-level is
 * worker-safe (no `window`/`document`/`requestAnimationFrame` at module scope,
 * only pure declarations); its main-thread worker-client code is lazy and
 * never invoked from inside a worker, so there is no nested-worker recursion.
 * `OffscreenCanvas`, `createImageBitmap`, `fetch`, and IndexedDB all exist in
 * a Worker context.
 *
 * @module vt/decode-pool.worker
 */

import { pageWorldRect, decodePageToCanvas, DEFAULT_BORDER_PX, compositePackedTexels } from './decode-pool.js';
import { pageStoreKey, putPageBlob } from './pyramid-store.js';
import { perfNowMs } from '../core/frame-clock.js';

/** Fetch + fully decode one source image. This is the expensive op we moved off the main thread. */
function fetchAndDecode(url) {
  return fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`decode-pool.worker: ${url} -> HTTP ${res.status}`);
      return res.blob();
    })
    .then((blob) => createImageBitmap(blob));
}

/** Slice one page → {bitmap (for GPU upload), canvas (for persistence)}. */
async function slicePage(source, table, page, borderPx, pageSizePx) {
  const rect = pageWorldRect(table, page.mip, page.px, page.py, { borderPx });
  const canvas = decodePageToCanvas(source, rect, pageSizePx);
  const bitmap = await createImageBitmap(canvas);
  return { bitmap, canvas };
}

/** Persist one sliced page's pixels to IndexedDB (fire-and-forget; failure is non-fatal). */
function persist(key, canvas) {
  try {
    canvas
      .convertToBlob({ type: 'image/png' })
      .then((blob) => putPageBlob(key, blob))
      .catch(() => {});
  } catch (_) {}
}

/**
 * Handle a single-source slice request: decode the source, slice every
 * requested page from it, persist each, and return the page bitmaps. Source
 * is released (closed) the moment slicing finishes — never held past one
 * message, so worker memory stays bounded to one source at a time.
 */
async function handleSlice(msg) {
  const { url, pages, worldWidthPx, worldHeightPx, payloadPx, pageSizePx } = msg;
  const borderPx = msg.borderPx ?? DEFAULT_BORDER_PX;
  const table = { payloadPx, worldWidthPx, worldHeightPx };

  const t0 = perfNowMs();
  const source = await fetchAndDecode(url);
  const sourceAcquireMs = perfNowMs() - t0;

  const results = [];
  const transfer = [];
  let maxSinglePageMs = 0;
  try {
    for (const page of pages) {
      const p0 = perfNowMs();
      const { bitmap, canvas } = await slicePage(source, table, page, borderPx, pageSizePx);
      maxSinglePageMs = Math.max(maxSinglePageMs, perfNowMs() - p0);
      results.push({ key: page.key, bitmap });
      transfer.push(bitmap);
      persist(pageStoreKey(url, page.mip, page.px, page.py), canvas);
    }
  } finally {
    source.close?.();
  }
  return { results, transfer, sourceAcquireMs, maxSinglePageMs, sliced: results.length };
}

/**
 * Handle a channel-packed slice request: decode all 3 channel sources, and for
 * each page composite R/G/B + one alpha into one RGBA page — via the SHARED
 * `compositePackedTexels`, so this and the main-thread fallback cannot drift
 * (the alpha rule was two hand-written copies, and both were wrong the same way).
 * Same shape as decode-pool.js's main-thread `acquirePackedPages`, off-thread.
 *
 * `packId` already carries `PACK_RECIPE_VERSION` — `acquirePackedPages` stamps
 * it before sending, so `persist()` below writes under the same key the caller
 * will look up.
 */
async function handleSlicePacked(msg) {
  const { packId, channelUrls, pages, worldWidthPx, worldHeightPx, payloadPx, pageSizePx, channelPolicy } = msg;
  const borderPx = msg.borderPx ?? DEFAULT_BORDER_PX;
  const table = { payloadPx, worldWidthPx, worldHeightPx };

  // ONE channel source held at a time (decode → extract all pages' pixels →
  // close → next channel), NOT all 3 at once — matches the main-thread path's
  // memory discipline and keeps peak worker memory to ~one 576MB source, not
  // ~1.7GB. Per-page 256² pixel data across all 3 channels is small by
  // comparison and is what's accumulated instead.
  let sourceAcquireMs = 0;
  const channelPixels = { r: new Map(), g: new Map(), b: new Map() };
  for (const ch of ['r', 'g', 'b']) {
    const t0 = perfNowMs();
    const source = await fetchAndDecode(channelUrls[ch]);
    sourceAcquireMs += perfNowMs() - t0;
    try {
      for (const page of pages) {
        const rect = pageWorldRect(table, page.mip, page.px, page.py, { borderPx });
        const data = decodePageToCanvas(source, rect, pageSizePx)
          .getContext('2d')
          .getImageData(0, 0, pageSizePx, pageSizePx).data;
        channelPixels[ch].set(page.key, data);
      }
    } finally {
      source.close?.();
    }
  }

  const results = [];
  const transfer = [];
  let maxSinglePageMs = 0;
  for (const page of pages) {
    const p0 = perfNowMs();
    const rPix = channelPixels.r.get(page.key);
    const gPix = channelPixels.g.get(page.key);
    const bPix = channelPixels.b.get(page.key);
    const canvas = new OffscreenCanvas(pageSizePx, pageSizePx);
    const ctx = canvas.getContext('2d');
    const out = ctx.createImageData(pageSizePx, pageSizePx);
    compositePackedTexels(out.data, rPix, gPix, bPix, channelPolicy);
    ctx.putImageData(out, 0, 0);
    const bitmap = await createImageBitmap(canvas);
    maxSinglePageMs = Math.max(maxSinglePageMs, perfNowMs() - p0);
    results.push({ key: page.key, bitmap });
    transfer.push(bitmap);
    persist(pageStoreKey(packId, page.mip, page.px, page.py), canvas);
  }
  return { results, transfer, sourceAcquireMs, maxSinglePageMs, sliced: results.length };
}

/**
 * Handle a DIMENSIONS-ONLY request — the off-thread fallback for
 * `getSourceDimensions()`'s ranged-fetch probe (2026-07-16, a real live gap
 * found via the zoom-thrash-test tool: background floor-prewarm builds every
 * pack's PageTable via `getSourceDimensions()`, whose fallback used to call
 * `acquireSliceSource()` DIRECTLY ON THE MAIN THREAD — a full source decode
 * that never went through this worker at all, since it's a completely
 * separate code path from page slicing. A hitch's snapshot with
 * `sourcesDecoded` incrementing but almost no pages yet sliced is exactly
 * this signature, not the page-slice path — which was already off-thread).
 * Decodes the source ONLY to read its width/height, then releases it
 * immediately — never holds it, never slices a page from it.
 */
async function handleDimensions(msg) {
  const t0 = perfNowMs();
  const source = await fetchAndDecode(msg.url);
  const sourceAcquireMs = perfNowMs() - t0;
  const width = source.width;
  const height = source.height;
  source.close?.();
  return { width, height, sourceAcquireMs };
}

/** Serial queue — each message fully completes before the next starts, so at
 * most ONE source (single) or ONE trio (packed) is held at any instant. */
let _queue = Promise.resolve();

self.onmessage = (e) => {
  const msg = e.data;
  _queue = _queue
    .then(async () => {
      try {
        if (msg.kind === 'dimensions') {
          const out = await handleDimensions(msg);
          self.postMessage({
            id: msg.id,
            ok: true,
            dimensions: { width: out.width, height: out.height },
            stats: { sourceAcquireMs: out.sourceAcquireMs },
          });
          return;
        }
        const out = msg.kind === 'slicePacked' ? await handleSlicePacked(msg) : await handleSlice(msg);
        self.postMessage(
          {
            id: msg.id,
            ok: true,
            results: out.results,
            stats: { sourceAcquireMs: out.sourceAcquireMs, maxSinglePageMs: out.maxSinglePageMs, sliced: out.sliced },
          },
          out.transfer // zero-copy transfer of the page ImageBitmaps to the main thread
        );
      } catch (err) {
        self.postMessage({ id: msg.id, ok: false, error: String(err?.message || err) });
      }
    })
    .catch(() => {});
};
