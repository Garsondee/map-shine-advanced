/**
 * THE SHAPE MAP — the specular mask's broad FORM, baked once per mask on the CPU.
 *
 * ============================================================================
 * WHY THIS EXISTS (2026-11-02, mmp-9nb round 2 — "dynamic during camera pans")
 * ============================================================================
 * `specular-render.js`'s header records why the first PBR attempt failed: on a
 * flat top-down map `N` is one vector for the whole screen, so `N·H` cannot
 * vary and no highlight can ever move with the camera. Edge relief (round 1)
 * broke that premise at the scale of ink lines; this map breaks it at the
 * scale of OBJECTS. The painted value read as height, blurred to a few dozen
 * pixels, gives every dome, coin, pot and shield a smoothly curving normal — so
 * a camera-aware highlight can travel across it, the shimmer can bend around
 * it, and a sparkle can know which facets face the eye.
 *
 * Blurring on the GPU every frame would cost dozens of taps per pixel; the mask
 * never changes, so it is done ONCE here, beside the island pack, from the same
 * decoded bytes, and uploaded small and LINEAR-filtered.
 *
 * ============================================================================
 * THE TEXEL (RGBA8)
 * ============================================================================
 *   R, G — the broad SLOPE, in mask axes (+x right, +y down), as height change
 *          per blur radius, encoded `0.5 + 0.5·s` and clamped to ±1. The shader
 *          builds `N = normalize(−s.x, −s.y, 1)`. Dimensionless, so it means the
 *          same on a 1500 px tile and a 7000 px floor.
 *   B    — the blurred height itself (0..1).
 *   A    — convexity: `0.5 − ∇²h·k`, > 0.5 on a dome's crown, < 0.5 in a hollow.
 *
 * Pure JS, no THREE: Node-testable (`__tests__/specular-shape.test.mjs`).
 *
 * @module effects/specular/specular-shape
 */
import { SPECULAR_ALPHA_EPSILON, LUMA_601 } from './specular-material.js';

/** The longest side of the baked map. 384² × 4 bytes ≈ 0.6 MB per mask. */
export const SHAPE_MAX_SIDE = 384;
/** Blur radius in MASK pixels (the mask uploads at 0.75 of the art, so ≈ 24
 * map px): wide enough that a coin or a pot reads as one rounded body, narrow
 * enough that two coins side by side stay two. Fine detail is edge relief's job. */
export const SHAPE_BLUR_MASK_PX = 18;
/** Ink closing radius in MASK pixels: thicker than the author's ink lines and
 * small dark rings, thinner than a real gap between two objects. */
export const SHAPE_INK_CLOSE_MASK_PX = 9;
/** Slope gain: height change per blur radius → stored slope. At 1.5 a painted
 * dome rising 0 → 0.8 across its radius tilts ~50° at the rim. */
export const SHAPE_SLOPE_GAIN = 1.5;
/** Convexity gain for the A channel. */
export const SHAPE_CONVEXITY_GAIN = 6;

/**
 * Decode one texel's height exactly as the render does (`specular-render.js`'s
 * `rawStrengthNode`): Rec.601 luma, × alpha unless alpha is effectively absent.
 * @param {ArrayLike<number>} rgba @param {number} i texel index
 * @returns {number} 0..1
 */
export function shapeHeightAt(rgba, i) {
  const o = i * 4;
  const luma = (LUMA_601[0] * rgba[o] + LUMA_601[1] * rgba[o + 1] + LUMA_601[2] * rgba[o + 2]) / 255;
  const a = rgba[o + 3] / 255;
  return a < SPECULAR_ALPHA_EPSILON ? luma : luma * a;
}

/** Separable square max/min filter (grey dilate / erode), clamped edges.
 * @param {Float32Array} src @param {number} w @param {number} h @param {number} r
 * @param {(a: number, b: number) => number} pick Math.max or Math.min */
function rankFilter(src, w, h, r, pick) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = src[y * w + x];
      for (let k = 1; k <= r; k++) v = pick(v, src[y * w + Math.max(0, x - k)], src[y * w + Math.min(w - 1, x + k)]);
      tmp[y * w + x] = v;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = tmp[y * w + x];
      for (let k = 1; k <= r; k++) v = pick(v, tmp[Math.max(0, y - k) * w + x], tmp[Math.min(h - 1, y + k) * w + x]);
      out[y * w + x] = v;
    }
  return out;
}

/** Three box passes ≈ a Gaussian; separable, in place, clamped edges.
 * @param {Float32Array} src @param {number} w @param {number} h @param {number} r */
function blur3(src, w, h, r) {
  if (r < 1) return src;
  const a = src;
  const b = new Float32Array(src.length);
  const pass = (from, to, horizontal) => {
    const n = horizontal ? w : h;
    const lines = horizontal ? h : w;
    const inv = 1 / (2 * r + 1);
    for (let line = 0; line < lines; line++) {
      const at = (k) => {
        const kk = k < 0 ? 0 : k >= n ? n - 1 : k;
        return horizontal ? from[line * w + kk] : from[kk * w + line];
      };
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += at(k);
      for (let k = 0; k < n; k++) {
        const idx = horizontal ? line * w + k : k * w + line;
        to[idx] = sum * inv;
        sum += at(k + r + 1) - at(k - r);
      }
    }
  };
  for (let p = 0; p < 3; p++) {
    pass(a, b, true);
    pass(b, a, false);
  }
  return a;
}

/**
 * Bake the shape map from a decoded mask.
 * @param {{rgba: ArrayLike<number>, width: number, height: number}} mask
 * @returns {{data: Uint8Array, w: number, h: number, scale: number, blurTexels: number}}
 *   `scale` = shape texels per mask pixel.
 */
export function buildSpecularShapeMap({ rgba, width, height }) {
  const W = Math.max(1, width | 0);
  const H = Math.max(1, height | 0);
  const scale = Math.min(1, SHAPE_MAX_SIDE / Math.max(W, H));
  const w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));

  // Downsample by FOUR point samples per cell (its quarter points), not a full
  // box average: visiting every texel of a 5500×5000 floor mask took > 1 s on
  // the main thread (a load freeze — this project's own scar,
  // `msa-load-freeze-derive-cache`), and the blur below spans ~17 cells, so the
  // extra averaging bought nothing visible. Cost is now O(cells), ~10 ms.
  const sum = new Float32Array(w * h);
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      let s = 0;
      for (let q = 0; q < 4; q++) {
        const mx = Math.min(W - 1, Math.floor(((cx + 0.25 + 0.5 * (q & 1)) * W) / w));
        const my = Math.min(H - 1, Math.floor(((cy + 0.25 + 0.5 * (q >> 1)) * H) / h));
        s += shapeHeightAt(rgba, my * W + mx);
      }
      sum[cy * w + cx] = s / 4;
    }
  }

  // CLOSE the author's ink before blurring (grey dilate then erode): a small
  // dark ink ring inside bright paint is DRAWING, not a pit in the metal, and
  // blurred as height it became a crater whose inward slopes lit as a bullseye
  // (lab, Bank T07's dome, 2026-11-02). Thin ink is edge relief's job.
  const closeTexels = Math.max(1, Math.round(SHAPE_INK_CLOSE_MASK_PX * scale));
  const closed = rankFilter(rankFilter(sum, w, h, closeTexels, Math.max), w, h, closeTexels, Math.min);
  const blurTexels = Math.max(1, Math.round(SHAPE_BLUR_MASK_PX * scale));
  const hb = blur3(closed, w, h, blurTexels);

  const data = new Uint8Array(w * h * 4);
  const at = (x, y) => hb[(y < 0 ? 0 : y >= h ? h - 1 : y) * w + (x < 0 ? 0 : x >= w ? w - 1 : x)];
  // Central difference per texel → per blur radius (× blurTexels), then gain.
  const slopeK = (SHAPE_SLOPE_GAIN * blurTexels) / 2;
  const lapK = SHAPE_CONVEXITY_GAIN * blurTexels * blurTexels;
  const enc = (v) => Math.round(255 * Math.min(1, Math.max(0, v)));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = (at(x + 1, y) - at(x - 1, y)) * slopeK;
      const sy = (at(x, y + 1) - at(x, y - 1)) * slopeK;
      const lap = at(x + 1, y) + at(x - 1, y) + at(x, y + 1) + at(x, y - 1) - 4 * at(x, y);
      const o = (y * w + x) * 4;
      data[o] = enc(0.5 + 0.5 * sx);
      data[o + 1] = enc(0.5 + 0.5 * sy);
      data[o + 2] = enc(at(x, y));
      data[o + 3] = enc(0.5 - lap * lapK);
    }
  }
  return { data, w, h, scale, blurTexels };
}
