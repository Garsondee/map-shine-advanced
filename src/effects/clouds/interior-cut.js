/**
 * INTERIOR CUT — a very soft hole in the cloud tops over the dark parts of `_Outdoors`
 * (author, 2026-11-04: "cut a soft edged (very blurred) shape through the cloud cover (just the cloud
 * tops) where the dark parts of _Outside is ... stop covering the interiors of buildings with clouds ...
 * very strong when zoomed in or at medium zoom, but weak when the user zooms all the way out").
 *
 * Two pure pieces, Node-testable, no THREE:
 *   - {@link buildInteriorCutGrid}: the outdoors grid, area-averaged down to a coarse grid and
 *     blurred wide (3 box passes ≈ a Gaussian), as bytes. Done once per floor bake on the CPU so the
 *     shader pays ONE bilinear tap, never a wide multi-tap blur per pixel.
 *   - {@link interiorCutZoomFactor}: how much of the cut survives at the current zoom.
 *
 * The cut is cosmetic and only ever touches the cloud TOPS (the sky seen from above). The ground
 * shadow, window light and the overcast mood are separate effects and are untouched.
 *
 * @module effects/clouds/interior-cut
 */

/** The coarse grid's texel size in world px (the blur is meant to be wide; fine detail is wasted). */
export const INTERIOR_CUT_MIN_TEXEL_PX = 24;
/** Blur radius in world px (per box pass, three passes): "very blurred". */
export const INTERIOR_CUT_BLUR_PX = 110;
/** Hard ceiling on the coarse grid's longest side, so a huge scene never costs a slow bake. */
export const INTERIOR_CUT_MAX_SIDE = 512;
/**
 * The zoom law, in "fit": the view's size as a fraction of the scene's, taken on whichever axis is
 * tighter (1 = the scene exactly fills the view). At or below `FULL_BELOW` the cut is whole; at or
 * above `GONE_AT` only the zoomed-out remainder is left.
 */
export const INTERIOR_CUT_FULL_BELOW_FIT = 0.5;
export const INTERIOR_CUT_GONE_AT_FIT = 0.95;

/**
 * One in-place box blur pass along rows or columns, edges clamped (outside reads as the edge cell).
 * Running sum, so O(n) whatever the radius.
 */
function boxPass(src, dst, w, h, radius, vertical) {
  const lines = vertical ? w : h;
  const len = vertical ? h : w;
  const stride = vertical ? w : 1;
  const lineStep = vertical ? 1 : w;
  const r = Math.max(0, Math.floor(radius));
  const inv = 1 / (2 * r + 1);
  for (let l = 0; l < lines; l++) {
    const base = l * lineStep;
    let sum = 0;
    for (let k = -r; k <= r; k++) {
      const i = k < 0 ? 0 : k >= len ? len - 1 : k;
      sum += src[base + i * stride];
    }
    for (let i = 0; i < len; i++) {
      dst[base + i * stride] = sum * inv;
      const add = i + r + 1;
      const sub = i - r;
      sum += src[base + (add >= len ? len - 1 : add) * stride] - src[base + (sub < 0 ? 0 : sub) * stride];
    }
  }
}

/**
 * Blur a float grid with three box passes per axis (≈ Gaussian, no ringing).
 * @param {Float32Array} grid - w*h values, modified in place.
 */
export function blurGridFloat(grid, w, h, radius) {
  if (!(radius >= 1)) return grid;
  const tmp = new Float32Array(grid.length);
  for (let pass = 0; pass < 3; pass++) {
    boxPass(grid, tmp, w, h, radius, false);
    boxPass(tmp, grid, w, h, radius, true);
  }
  return grid;
}

/**
 * Turn an outdoors grid into the interior-cut bytes: 255 = outdoors / open sky, 0 = deep inside a
 * building, soft in between. Area-averages onto a coarse grid first (so a big scene bakes fast),
 * then blurs by {@link INTERIOR_CUT_BLUR_PX} world px.
 *
 * @param {ArrayLike<number>} data - source bytes, one per cell, row 0 first (255 = outdoors).
 * @param {{w:number,h:number,width:number,height:number}} spec - the source grid; `width`/`height` are
 *   its world-px extent, `w`/`h` its cell counts.
 * @returns {{data: Uint8Array, w: number, h: number}}
 */
export function buildInteriorCutGrid(data, spec, { blurPx = INTERIOR_CUT_BLUR_PX } = {}) {
  const sw = spec.w | 0;
  const sh = spec.h | 0;
  const worldW = spec.width > 0 ? spec.width : sw;
  const worldH = spec.height > 0 ? spec.height : sh;
  const cw = Math.max(2, Math.min(INTERIOR_CUT_MAX_SIDE, Math.ceil(worldW / INTERIOR_CUT_MIN_TEXEL_PX), sw));
  const ch = Math.max(2, Math.min(INTERIOR_CUT_MAX_SIDE, Math.ceil(worldH / INTERIOR_CUT_MIN_TEXEL_PX), sh));
  const sum = new Float32Array(cw * ch);
  const count = new Float32Array(cw * ch);
  for (let y = 0; y < sh; y++) {
    const cy = Math.min(ch - 1, Math.floor((y * ch) / sh));
    for (let x = 0; x < sw; x++) {
      const cx = Math.min(cw - 1, Math.floor((x * cw) / sw));
      const i = cy * cw + cx;
      sum[i] += (data[y * sw + x] ?? 255) / 255;
      count[i] += 1;
    }
  }
  for (let i = 0; i < sum.length; i++) sum[i] = count[i] > 0 ? sum[i] / count[i] : 1;
  const texelPx = Math.max(worldW / cw, worldH / ch);
  blurGridFloat(sum, cw, ch, blurPx / texelPx);
  const out = new Uint8Array(cw * ch);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(sum[i] * 255)));
  return { data: out, w: cw, h: ch };
}

/**
 * How much of the interior cut applies at this zoom, 0..1 — 1 up to a medium view, falling smoothly
 * to `zoomedOutKeep` once the view takes in the whole scene.
 *
 * @param {object} a
 * @param {number} a.viewWidthWorldPx @param {number} a.viewHeightWorldPx
 * @param {number} a.sceneWidthPx @param {number} a.sceneHeightPx
 * @param {number} [a.zoomedOutKeep] - share of the cut left when fully zoomed out (the dial).
 * @returns {number}
 */
export function interiorCutZoomFactor({
  viewWidthWorldPx,
  viewHeightWorldPx,
  sceneWidthPx,
  sceneHeightPx,
  zoomedOutKeep = 0.12,
}) {
  const keep = Number.isFinite(zoomedOutKeep) ? Math.min(1, Math.max(0, zoomedOutKeep)) : 0.12;
  if (!(sceneWidthPx > 0 && sceneHeightPx > 0 && viewWidthWorldPx > 0)) return 1;
  const fitW = viewWidthWorldPx / sceneWidthPx;
  const fitH = viewHeightWorldPx > 0 ? viewHeightWorldPx / sceneHeightPx : fitW;
  const fit = Math.max(fitW, fitH);
  const t = Math.min(
    1,
    Math.max(0, (fit - INTERIOR_CUT_FULL_BELOW_FIT) / (INTERIOR_CUT_GONE_AT_FIT - INTERIOR_CUT_FULL_BELOW_FIT))
  );
  const s = t * t * (3 - 2 * t);
  return 1 + (keep - 1) * s;
}
