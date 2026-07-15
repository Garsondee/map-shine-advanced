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

/**
 * Pure: where a page's REAL (clamped, world-bounds-respecting) crop should
 * land within a `pageSizePx`-square output, and its scaled size there — given
 * both the clamped rect (what's actually available to sample) and the
 * unclamped nominal rect (this page's full, un-truncated world-space span,
 * always exactly `pageSizePx * 2^mip` wide/tall — see `pageWorldRect`).
 *
 * WHY THIS EXISTS (author-reported live bug, 2026-07-15, real 12000² mansion
 * art: "strangeness around the right and bottom edges" — the torture fixture's
 * regular labeled grid made the same artifact much less noticeable). The
 * ORIGINAL `decodePage` cropped only the CLAMPED rect and resized THAT up to a
 * full `pageSizePx` square. For any page whose nominal span crosses a world
 * edge — which is EVERY page along the world's last row/column whenever
 * worldSizePx isn't an exact multiple of the page payload (12000/248 isn't:
 * the last page's real content is only ~100 of 256 nominal texels — hand-
 * verified in decode-pool.test.mjs's own "page(0,48,48)" case), and even
 * page (0,0) by the 4px border alone — that naive resize non-uniformly
 * STRETCHES real image content by up to ~2.56x. The fix: place the real crop
 * at its TRUE relative position/size within the output (no stretch beyond
 * what the mip's own zoom factor already implies) and clamp-extend (repeat
 * the nearest real edge pixel) into the genuinely-missing region — there ARE
 * no source pixels there, so synthesizing padding beats distorting real ones.
 *
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} clamped
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} unclamped
 * @param {number} pageSizePx
 * @returns {{dx:number,dy:number,dw:number,dh:number,needsPadding:boolean}}
 */
export function computePagePlacement(clamped, unclamped, pageSizePx) {
  const fullSpanX = unclamped.maxX - unclamped.minX;
  const fullSpanY = unclamped.maxY - unclamped.minY;
  const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const dx = clampInt(Math.round(((clamped.minX - unclamped.minX) / fullSpanX) * pageSizePx), 0, pageSizePx - 1);
  const dy = clampInt(Math.round(((clamped.minY - unclamped.minY) / fullSpanY) * pageSizePx), 0, pageSizePx - 1);
  // dw/dh's upper bound is `pageSizePx - dx/dy` (not a bare pageSizePx clamp)
  // so independent rounding of dx and dw can never let dx+dw exceed pageSizePx
  // — that would otherwise hand the padding math a negative width below.
  const dw = clampInt(Math.round(((clamped.maxX - clamped.minX) / fullSpanX) * pageSizePx), 1, pageSizePx - dx);
  const dh = clampInt(Math.round(((clamped.maxY - clamped.minY) / fullSpanY) * pageSizePx), 1, pageSizePx - dy);

  const needsPadding = dx > 0 || dy > 0 || dx + dw < pageSizePx || dy + dh < pageSizePx;
  return { dx, dy, dw, dh, needsPadding };
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
  const sx = Math.round(worldRect.minX);
  const sy = Math.round(worldRect.minY);
  const sw = Math.max(1, Math.round(worldRect.maxX - worldRect.minX));
  const sh = Math.max(1, Math.round(worldRect.maxY - worldRect.minY));

  const placement = computePagePlacement(worldRect, worldRect.unclamped, pageSizePx);
  if (!placement.needsPadding) {
    return createImageBitmap(sourceBitmap, sx, sy, sw, sh, {
      resizeWidth: pageSizePx,
      resizeHeight: pageSizePx,
      resizeQuality: 'high',
    });
  }

  const { dx, dy, dw, dh } = placement;
  const canvas = new OffscreenCanvas(pageSizePx, pageSizePx);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(sourceBitmap, sx, sy, sw, sh, dx, dy, dw, dh);

  if (dx > 0) ctx.drawImage(canvas, dx, dy, 1, dh, 0, dy, dx, dh); // pad left: repeat leftmost real column
  if (dx + dw < pageSizePx) {
    ctx.drawImage(canvas, dx + dw - 1, dy, 1, dh, dx + dw, dy, pageSizePx - (dx + dw), dh); // pad right
  }
  if (dy > 0) ctx.drawImage(canvas, 0, dy, pageSizePx, 1, 0, 0, pageSizePx, dy); // pad top (full width — see doc above)
  if (dy + dh < pageSizePx) {
    ctx.drawImage(canvas, 0, dy + dh - 1, pageSizePx, 1, 0, dy + dh, pageSizePx, pageSizePx - (dy + dh)); // pad bottom
  }

  return createImageBitmap(canvas);
}
