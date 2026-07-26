/**
 * LOAD A MASK FILE AS A HIGH-RESOLUTION SINGLE-CHANNEL TEXTURE.
 *
 * ============================================================================
 * WHY THIS EXISTS — THE MASK PIPELINE HAD NO HIGH-RES PATH AT ALL
 * ============================================================================
 * Until 2026-07-26 a `_Water`-style mask reached the GPU by exactly two
 * routes, and BOTH are thumbnails:
 *
 *   1. `maskAuthority.getDerived(...)` — the CPU derivation grid, capped at
 *      `MASK_GRID_MAX_DIM` (512) on the long side. On a 10,650px map that is
 *      ~21 world px per texel.
 *   2. The VT layer's coarse pin — a handful of 256px pages (~768px across the
 *      same map, ~14 world px/texel).
 *
 * Both are correct for what they were built for: cheap, coarse, whole-scene
 * COVERAGE questions ("is this point outdoors", "is anything above me"). Both
 * are useless for a SILHOUETTE, because a silhouette is the highest-frequency
 * part of the signal and these throw exactly that away.
 *
 * ============================================================================
 * THE BUG THIS FIXES, AND WHY THREE EARLIER FIXES DID NOT
 * ============================================================================
 * Water's tier-0 shoreline came from thresholding the jump-flood SDF, and the
 * SDF was seeded from route 1. Three successive fixes attacked the wrong
 * layer — LINEAR on the resolved pack, then LINEAR on the mask, then 3×
 * supersampling the flood — and the author's report stayed the same:
 * *"extremely pixelated... the shoreline looks like a square wave."*
 *
 * The reason is worth stating once, properly: **an SDF renders crisply far
 * below its source resolution ONLY because it was BUILT from a high-res
 * source.** That is the whole Valve-SDF-text result — a 64² field renders
 * sharp glyphs at 500px, because each texel stores a continuous distance
 * encoding where the edge sits BETWEEN texels. Seed a flood from a 512
 * point-sampled grid and there is no sub-texel information to preserve; the
 * seeds sit on texel centres and an angled shore bakes in a real staircase.
 * Supersampling the flood over that same grid samples the same thumbnail more
 * densely and finds nothing, which is exactly what was observed.
 *
 * So: **the SDF is not asked for the edge any more.** The edge comes from
 * here — the mask file itself, at real resolution, linearly filtered, exactly
 * as crisp as the map art beside it. The SDF keeps the job it is genuinely
 * good at (distance-derived, inherently low-frequency effects: depth ramp,
 * foam band width, shoaling, flow tangent), where 512 was always plenty.
 *
 * ============================================================================
 * COST, STATED HONESTLY
 * ============================================================================
 * `MASK_IMAGE_SCALE` (0.5) of a 10,650 × 4,950 mask is 5,325 × 2,475 ≈ 13.2 M
 * texels. Uploaded RED/UnsignedByte — ONE byte per texel — that is **~13 MB**,
 * against a scene already holding ~265 MB of texture. Full res would be ~53 MB.
 *
 * RED, not the RGBA every other DataTexture in this renderer uses: those are
 * all ≤512² where the 4× waste is invisible, and their headers cite avoiding a
 * "per-backend format-support question". At 13 M texels that waste is 40 MB,
 * which changes the answer — and `r8unorm` is core in both WebGL2 and WebGPU,
 * so the format question has a known answer here rather than being ducked.
 *
 * The transient cost is one `getImageData` (~53 MB, RGBA) during decode, freed
 * immediately. That is why this module lives in `vt/`: `no-gpu-readback` allows
 * `.getImageData(` only in `vt/` and `diag/`, and `gpu/textures-in-vt-only`
 * allows `new ...Texture(` only in `vt/`. Both are satisfied by being here
 * rather than by a callback dance.
 *
 * @module vt/mask-image
 */

import { createLogger } from '../core/log.js';

const log = createLogger('MaskImage');

/**
 * Fraction of the mask file's NATIVE resolution to upload. Half, chosen with
 * the author 2026-07-26 on the explicit understanding that full res is a
 * one-number change if the difference is ever visible.
 *
 * At half res on a 10,650px-wide map a texel is ~2 world px; at the reported
 * play zoom (~1.7 world px per screen px) that is well under one screen pixel,
 * so the shoreline's crispness is bounded by the display, not by this.
 */
export const MASK_IMAGE_SCALE = 0.5;

/**
 * Hard ceiling on the uploaded long side, INDEPENDENT of the scale above — a
 * backstop against a pathologically large source file, not a tuning knob.
 * Comfortably under the 16,384 texture limit real hardware reports, and under
 * the 8,192 a conservative device might.
 */
export const MASK_IMAGE_MAX_DIM = 8192;

/**
 * The uploaded dimensions for a source of this size: scaled, capped, and never
 * upscaled past native (a 2,000px mask stays 1,000px, it does not become 8,192).
 * Pure, so the sizing rule is Node-testable without a browser.
 *
 * @param {number} nativeW @param {number} nativeH
 * @param {number} [scale] @param {number} [maxDim]
 * @returns {{width: number, height: number}}
 */
export function maskImageTargetSize(nativeW, nativeH, scale = MASK_IMAGE_SCALE, maxDim = MASK_IMAGE_MAX_DIM) {
  const w0 = Math.max(1, Math.floor(nativeW * scale));
  const h0 = Math.max(1, Math.floor(nativeH * scale));
  const longest = Math.max(w0, h0);
  if (longest <= maxDim) return { width: w0, height: h0 };
  const k = maxDim / longest;
  return { width: Math.max(1, Math.floor(w0 * k)), height: Math.max(1, Math.floor(h0 * k)) };
}

/**
 * Fetch a mask image and upload its RED channel as a single-channel texture.
 *
 * Resolves to `null` — never throws — on any failure (404, decode error, a
 * browser without `createImageBitmap` resize support). The caller treats null
 * as "no high-res mask", which is a degraded look, not a broken frame; the
 * failure is logged loudly rather than swallowed (`no-silent-catch`).
 *
 * @param {object} args
 * @param {string} args.url
 * @param {*} args.THREE
 * @param {number} [args.scale]
 * @returns {Promise<{texture: *, width: number, height: number, nativeWidth: number,
 *   nativeHeight: number, bytes: number}|null>}
 */
export async function loadMaskImageTexture({ url, THREE, scale = MASK_IMAGE_SCALE }) {
  if (!url) return null;
  let bitmap = null;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      log.error(`mask image fetch failed (${response.status}) for ${url}`);
      return null;
    }
    const blob = await response.blob();
    // Decode once at NATIVE size only to learn the dimensions, then re-decode
    // at the target — `createImageBitmap`'s own resize is the browser's
    // (GPU-accelerated, properly filtered) downscale, which is both faster and
    // better than drawing a full-size bitmap into a smaller canvas ourselves.
    const probe = await createImageBitmap(blob);
    const nativeWidth = probe.width;
    const nativeHeight = probe.height;
    const { width, height } = maskImageTargetSize(nativeWidth, nativeHeight, scale);
    probe.close();
    bitmap = await createImageBitmap(blob, {
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: 'high',
    });

    // ONE readback, freed immediately. `willReadFrequently` is deliberately
    // NOT set: this runs once per mask per scene load, and the flag trades GPU
    // acceleration for CPU-side caching that only pays off on repeat reads.
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { alpha: true });
    ctx.drawImage(bitmap, 0, 0);
    const rgba = ctx.getImageData(0, 0, width, height).data;

    // R only — the water mask carries depth AND presence there (see the
    // `water` kind's own `meaning` in scene/mask-catalog.js). One byte per
    // texel instead of four; see this module's header for why that matters at
    // this size when it does not at 512².
    const red = new Uint8Array(width * height);
    for (let i = 0; i < red.length; i++) red[i] = rgba[i * 4];

    const texture = new THREE.DataTexture(red, width, height, THREE.RedFormat, THREE.UnsignedByteType);
    // LINEAR — the whole point. The file's own antialiased edge becomes a
    // smooth ramp the surface shader can threshold into a crisp, resolution-
    // independent shoreline.
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    // flipY:false — v=0 is the image's TOP row, the world-quad convention every
    // tile in this renderer already uses (see setTileGeometry's own tex setup).
    // Getting this wrong flips the water vertically, which is this repo's named
    // recurring bug class (feedback_y_flip_recurring_risk).
    texture.flipY = false;
    texture.needsUpdate = true;

    return { texture, width, height, nativeWidth, nativeHeight, bytes: red.length };
  } catch (err) {
    log.error(`mask image load failed for ${url} —`, err);
    return null;
  } finally {
    bitmap?.close?.();
  }
}
