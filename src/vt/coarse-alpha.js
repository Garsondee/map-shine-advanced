/**
 * COARSE ALPHA — an item's art opacity, reduced to a few hundred texels a side,
 * so the mask authority can answer "is there something solid above me?" without
 * anything ever holding a world-resolution buffer.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS AT ALL (a live defect, not a new feature)
 * ============================================================================
 *
 * `scene/mask-derive.js` derives `coverAbove` (and therefore `skyReach`) from
 * each item's ALPHA. It gets that alpha through `mask-authority.js#
 * ingestDecodedPage`, which is fed by the viewer's pack-decode loop — and a
 * "pack" is the small tiled-pyramid structure the streaming engine used.
 *
 * When the streaming engine was retired (2026-07-22) the ALBEDO pack went with
 * it: `ensureItemLoaded`'s own comment now reads *"there is no albedo pack any
 * more"*, and `buildPack` survives with exactly ONE call site —
 * `loadExtraLayerPacks`, which iterates the MASK descriptors only. So no page
 * has reached the ingest seam carrying `layerName === 'albedo'` since that day.
 * Every item's `alpha` arrives at the derivation as `null`, `compositeItemMax`
 * is never called for cover, and **`coverAbove` has been uniformly zero on every
 * floor of every scene** — which silently collapses `skyReach` into a copy of
 * `outdoors`.
 *
 * That is [[feedback_mode_forks_silently_drop_features]] for the second time in
 * the same file, one door away from the identical `_Outdoors`-never-loaded bug
 * fixed on the same day the fork landed. The derivation was never wrong; its
 * input was cut off.
 *
 * ============================================================================
 * WHY A SEPARATE, TINY DECODE RATHER THAN REVIVING THE ALBEDO PACK
 * ============================================================================
 *
 * The question `coverAbove` answers — "is there a building above me?" — is
 * inherently coarse (building footprints are hundreds of pixels). Reviving a
 * pyramid pack to answer it would re-introduce the machinery Keyhole deleted.
 *
 * Instead the worker asks the browser to decode the image DIRECTLY at grid
 * resolution (`createImageBitmap(blob, { resizeWidth, resizeHeight })`), which
 * is the cheapest possible way to get this data: the decoder does the
 * downsample, the alpha channel is box-averaged for free (so a texel's value is
 * the FRACTION of it that is opaque — exactly the soft coverage a shadow
 * wants), and the readback is ~1 MB instead of 576 MB. It works for tiles too,
 * which never had mask packs and so could never have contributed cover.
 *
 * This module is the pure half — dimensions and channel extraction, Node-tested.
 * The fetch/decode lives in `bc-compress.worker.js` where the other
 * off-main-thread image work already lives.
 *
 * @module vt/coarse-alpha
 */

/**
 * Longest side of a coarse alpha grid. 512 matches `scene/mask-derive.js`'s
 * `MASK_GRID_MAX_DIM`, so an item that covers the whole map contributes at
 * roughly one source texel per destination texel and nothing is thrown away
 * twice. Raising this is the ONE lever that makes a cast shadow's contact edge
 * crisper (docs/planning/Sun-Shadows.md §7.7) — it is not a march parameter.
 */
export const COARSE_ALPHA_MAX_DIM = 512;

/**
 * Size a coarse alpha grid for a source image, preserving aspect ratio and
 * never upscaling (a 64px icon stays 64px — resizing it UP would invent
 * coverage detail that does not exist).
 *
 * @param {number} width - source image width in pixels.
 * @param {number} height - source image height in pixels.
 * @param {number} [maxDim]
 * @returns {{w: number, h: number}} at least 1x1 for any finite input.
 */
export function coarseAlphaGridDims(width, height, maxDim = COARSE_ALPHA_MAX_DIM) {
  const sw = Number.isFinite(width) && width > 0 ? width : 1;
  const sh = Number.isFinite(height) && height > 0 ? height : 1;
  const cap = Number.isFinite(maxDim) && maxDim > 0 ? maxDim : COARSE_ALPHA_MAX_DIM;
  const scale = Math.min(1, cap / Math.max(sw, sh));
  return { w: Math.max(1, Math.round(sw * scale)), h: Math.max(1, Math.round(sh * scale)) };
}

/**
 * Pull the alpha channel out of decoded RGBA bytes into a `ContentGrid` — the
 * exact shape `scene/mask-derive.js#compositeItemMax` consumes (`{w, h, data}`,
 * row 0 = the image's TOP, matching `extractContentWindow`'s own convention so
 * the two producers cannot disagree about orientation).
 *
 * Throws on a length mismatch rather than reading past the end or silently
 * truncating: a short buffer means the decode did not produce what it claimed,
 * and a half-filled coverage grid is worse than no grid at all (the caller
 * records "missing" and the report says so — `deriveFloorProducts` already has
 * that path).
 *
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} imageData
 * @returns {{w: number, h: number, data: Uint8Array}}
 */
export function extractAlphaGrid(imageData) {
  const w = imageData?.width | 0;
  const h = imageData?.height | 0;
  const src = imageData?.data;
  if (!(w > 0 && h > 0) || !src) {
    throw new Error(`extractAlphaGrid: bad imageData (${w}x${h}, data ${src ? src.length : 'missing'})`);
  }
  const need = w * h * 4;
  if (src.length < need) {
    throw new Error(`extractAlphaGrid: expected ${need} bytes for ${w}x${h} RGBA, got ${src.length}`);
  }
  const data = new Uint8Array(w * h);
  for (let i = 0, j = 3; i < data.length; i++, j += 4) data[i] = src[j];
  return { w, h, data };
}

/**
 * Mean coverage 0..1 of a coarse alpha grid — the one number that tells a
 * report reader "this item contributes nothing" apart from "this item never
 * arrived". Both look like an absent shadow on screen; only this distinguishes
 * them (feedback_instruments_must_not_lie).
 *
 * @param {{data: Uint8Array}} grid
 * @returns {number}
 */
export function coarseAlphaMean(grid) {
  const d = grid?.data;
  if (!d || d.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < d.length; i++) sum += d[i];
  return sum / (d.length * 255);
}

// ---------------------------------------------------------------------------
// THE MIN-ALPHA GRID — Stage 1's interior certification ground truth
// (docs/planning/Stage-1-Shade-Once.md §2).
//
// The grid above is a box-averaged MEAN (`createImageBitmap` downsample): a
// texel answers "how much of me is opaque". Stage 1's interior/boundary split
// needs a DIFFERENT question answered soundly: "is EVERY source pixel under
// this texel fully opaque (alpha exactly 255)?" — because only alpha≡1 makes
// an unblended draw byte-identical to today's blended one. A mean structurally
// cannot certify that: at ~23²px per texel, one 254-alpha pixel among 529
// still box-averages and rounds to 255 (the aggregate cannot name its source).
//
// So this grid stores the true per-texel MIN, accumulated by
// `bc-compress.worker.js#handle()`'s existing full-pixel banded scan — the one
// place every source pixel is already being read — one band at a time. Pixels
// partition into texels by plain floor binning; the consumer
// (`splitCoverageCellMask`) maps mesh cells onto texel RECTS with its own
// ceil-overlap conservatism, so the two mappings do not need to agree about
// texel edges, only about which texels exist.
// ---------------------------------------------------------------------------

/**
 * A fresh min-alpha grid, every texel at 255 — the identity of `min`, so a
 * texel nothing ever lowers reads "fully opaque", which is only reachable when
 * every band was accumulated (the worker walks ALL rows; a partial walk is a
 * thrown error there, never a silently-optimistic grid here).
 *
 * @param {number} gridW @param {number} gridH
 * @returns {Uint8Array}
 */
export function createMinAlphaGrid(gridW, gridH) {
  const w = Math.floor(Number(gridW) || 0);
  const h = Math.floor(Number(gridH) || 0);
  if (w < 1 || h < 1) throw new Error(`createMinAlphaGrid: bad dims ${gridW}x${gridH}`);
  return new Uint8Array(w * h).fill(255);
}

/**
 * Fold one decoded RGBA band (source rows `[bandY, bandY+bandH)`) into a
 * min-alpha grid. Throws on a short buffer rather than reading past the end —
 * a half-accumulated grid would certify texels it never saw
 * (feedback_instruments_must_not_lie, the same discipline `extractAlphaGrid`
 * already applies one function up).
 *
 * @param {object} args
 * @param {Uint8Array} args.grid - from {@link createMinAlphaGrid}, mutated.
 * @param {number} args.gridW @param {number} args.gridH
 * @param {Uint8Array|Uint8ClampedArray} args.band - RGBA bytes, `imageW*bandH*4`.
 * @param {number} args.bandY - first source row this band covers.
 * @param {number} args.bandH - rows in this band.
 * @param {number} args.imageW @param {number} args.imageH - source dims in px.
 */
export function accumulateMinAlphaBand({ grid, gridW, gridH, band, bandY, bandH, imageW, imageH }) {
  const gw = Math.floor(Number(gridW) || 0);
  const gh = Math.floor(Number(gridH) || 0);
  const iw = Math.floor(Number(imageW) || 0);
  const ih = Math.floor(Number(imageH) || 0);
  const by = Math.floor(Number(bandY) || 0);
  const bh = Math.floor(Number(bandH) || 0);
  if (gw < 1 || gh < 1 || !grid || grid.length < gw * gh) {
    throw new Error(`accumulateMinAlphaBand: bad grid (${gridW}x${gridH}, data ${grid ? grid.length : 'missing'})`);
  }
  if (iw < 1 || ih < 1 || bh < 1 || by < 0 || by + bh > ih) {
    throw new Error(
      `accumulateMinAlphaBand: bad band geometry (rows [${bandY},${bandY}+${bandH}) of ${imageW}x${imageH})`
    );
  }
  const need = iw * bh * 4;
  if (!band || band.length < need) {
    throw new Error(
      `accumulateMinAlphaBand: expected ${need} bytes for ${iw}x${bh} RGBA, got ${band ? band.length : 'missing'}`
    );
  }
  // Column → texel-x once per band, not once per pixel: 12,000 divisions
  // instead of 72 million for a mansion-sized layer.
  const colGx = new Int32Array(iw);
  for (let x = 0; x < iw; x++) colGx[x] = Math.min(gw - 1, Math.floor((x * gw) / iw));
  for (let ry = 0; ry < bh; ry++) {
    const gy = Math.min(gh - 1, Math.floor(((by + ry) * gh) / ih));
    const rowBase = gy * gw;
    let i = ry * iw * 4 + 3;
    for (let x = 0; x < iw; x++, i += 4) {
      const a = band[i];
      const gi = rowBase + colGx[x];
      if (a < grid[gi]) grid[gi] = a;
    }
  }
}
