/**
 * @fileoverview vt/decode-pool.js — page-format-native decode (Keyhole Stage 1
 * part 3). Written fresh rather than harvested: the V2 equivalents
 * (texture-pyramid-builder.js, tile-decode-pool.js) both import
 * TextureBudgetTracker/texture-budget-policy.js — V2's REACTIVE budget
 * controller, a §7 kill-list item — so porting them verbatim would drag that
 * coupling into src/ before anything needs it. This module owes nothing to
 * that system.
 *
 * Split the same way `atlas.js`/`ThreeAllocator.js` split pure math from
 * browser-only execution: `pageWorldRect()` is pure and Node-tested;
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
 * @module vt/decode-pool
 */

/** Default border width in texels (Keyhole Q1: 256px page - 248 payload = 4px/side). */
export const DEFAULT_BORDER_PX = 4;

/**
 * Pure: the world-space rect (in this virtual texture's mip-0 world units) a
 * page's ATLAS SLOT covers, payload + border, clamped to the world bounds.
 * This is what the decode step crops from the source image — border texels
 * come from the real neighboring source pixels (not synthesized padding),
 * which is what makes seams disappear at page boundaries.
 *
 * @param {import('./page-table.js').PageTable} table
 * @param {number} mip @param {number} px @param {number} py
 * @param {object} [opts] @param {number} [opts.borderPx]
 * @returns {{minX:number,minY:number,maxX:number,maxY:number, unclamped:{minX:number,minY:number,maxX:number,maxY:number}}}
 */
export function pageWorldRect(table, mip, px, py, opts = {}) {
  const borderPx = opts.borderPx ?? DEFAULT_BORDER_PX;
  const payloadSpan = table.payloadPx * (1 << mip);
  const borderSpan = borderPx * (1 << mip);

  const x0 = px * payloadSpan - borderSpan;
  const y0 = py * payloadSpan - borderSpan;
  const x1 = (px + 1) * payloadSpan + borderSpan;
  const y1 = (py + 1) * payloadSpan + borderSpan;

  return {
    minX: Math.max(0, x0),
    minY: Math.max(0, y0),
    maxX: Math.min(table.worldSizePx, x1),
    maxY: Math.min(table.worldSizePx, y1),
    unclamped: { minX: x0, minY: y0, maxX: x1, maxY: y1 },
  };
}

/** @type {Map<string, Promise<ImageBitmap>>} URL -> in-flight/decoded full-image bitmap. */
const _sourceCache = new Map();

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

/** Evict a cached source bitmap (e.g. a scene's background image changed). @param {string} url */
export function releaseSourceBitmap(url) {
  _sourceCache.get(url)?.then((bmp) => bmp.close?.()).catch(() => {});
  _sourceCache.delete(url);
}

/**
 * Decode one page: crop `worldRect` out of an already-decoded source bitmap
 * and resize to exactly `pageSizePx` square (border + payload together —
 * Keyhole Q1 default 256). This is the cheap step; `getSourceBitmap()` (the
 * one potentially-expensive full decode) should already have resolved before
 * calling this in a tight loop.
 *
 * NOTE — world-rect -> source-pixel-rect assumes the source image's pixel
 * grid is 1:1 with this virtual texture's world units at mip 0 (true for the
 * torture fixture and for MSA's authored backgrounds/masks, which are
 * painted at native map resolution). A source atlas with a different native
 * resolution would need a scale factor here — not needed yet, noted for when
 * it is.
 *
 * @param {ImageBitmap} sourceBitmap
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} worldRect
 * @param {number} [pageSizePx]
 * @returns {Promise<ImageBitmap>}
 */
export function decodePage(sourceBitmap, worldRect, pageSizePx = 256) {
  const sx = Math.round(worldRect.minX);
  const sy = Math.round(worldRect.minY);
  const sw = Math.max(1, Math.round(worldRect.maxX - worldRect.minX));
  const sh = Math.max(1, Math.round(worldRect.maxY - worldRect.minY));
  return createImageBitmap(sourceBitmap, sx, sy, sw, sh, {
    resizeWidth: pageSizePx,
    resizeHeight: pageSizePx,
    resizeQuality: 'high',
  });
}
