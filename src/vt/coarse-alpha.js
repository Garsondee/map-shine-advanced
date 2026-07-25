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
