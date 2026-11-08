/**
 * THE MIST'S SOFT WALL GATE — the atmosphere gate, coarsened and blurred once per bake (CPU), so the ground mist
 * thins toward a wall over a real distance instead of stopping on the mask's line (mmp-63o.1).
 *
 * The first cut sampled the gate five times in the shader. Five taps of a hard mask are a STAIRCASE (0.2 steps),
 * and the lab showed it: straight bright bands along every wall. A blurred copy is smoother AND cheaper (one tap).
 * Same shape as `vt-pan-viewer.js`'s interior cut for the cloud tops: the mask, coarse and blurred wide.
 *
 * Pure: arrays in, arrays out. Node-tested.
 *
 * @module effects/precipitation/ground-mist-gate
 */

/** Coarse texels per feather distance — enough for a smooth ramp, few enough to be free. */
export const MIST_GATE_TEXELS_PER_FEATHER = 6;
/** Box-blur passes (three box passes ≈ a Gaussian). */
export const MIST_GATE_BLUR_PASSES = 3;

/**
 * Coarsen and blur one channel of an RGBA8 gate.
 *
 * @param {Uint8Array|Uint8ClampedArray} rgba - the gate, `w*h*4` bytes, row 0 = minY.
 * @param {number} w @param {number} h
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} rect - the world rect the gate covers.
 * @param {number} featherPx - world px the mist fades over at a wall.
 * @returns {{data: Uint8Array, w: number, h: number, rect: {minX:number,minY:number,maxX:number,maxY:number}}|null}
 *   an RGBA8 grid (all four channels the blurred value) and the world rect it covers EXACTLY (the coarse grid can
 *   overhang the source by under one block, and the rect says so, so a sample lands on the same world point).
 *   `null` for unusable input.
 */
export function buildMistGateGrid(rgba, w, h, rect, featherPx) {
  if (!rgba || !(w > 0) || !(h > 0) || rgba.length < w * h * 4 || !rect) return null;
  const spanX = rect.maxX - rect.minX;
  const spanY = rect.maxY - rect.minY;
  if (!(spanX > 0) || !(spanY > 0) || !(featherPx > 0)) return null;
  const texelPx = spanX / w;
  const want = featherPx / MIST_GATE_TEXELS_PER_FEATHER;
  const f = Math.max(1, Math.floor(want / Math.max(texelPx, 1e-6)));
  const cw = Math.ceil(w / f);
  const ch = Math.ceil(h / f);
  const a = new Float32Array(cw * ch);
  for (let cy = 0; cy < ch; cy++) {
    const y0 = cy * f;
    const y1 = Math.min(h, y0 + f);
    for (let cx = 0; cx < cw; cx++) {
      const x0 = cx * f;
      const x1 = Math.min(w, x0 + f);
      let sum = 0;
      for (let y = y0; y < y1; y++) {
        let i = (y * w + x0) * 4;
        for (let x = x0; x < x1; x++, i += 4) sum += rgba[i];
      }
      a[cy * cw + cx] = sum / ((y1 - y0) * (x1 - x0) * 255);
    }
  }
  // Box radius in coarse texels: three passes of radius r spread an edge over about ±1.5·(2r+1)/2 texels, which at
  // MIST_GATE_TEXELS_PER_FEATHER texels per feather is about one feather each side of the wall.
  const r = Math.max(1, Math.round(MIST_GATE_TEXELS_PER_FEATHER / 3));
  const b = new Float32Array(cw * ch);
  for (let pass = 0; pass < MIST_GATE_BLUR_PASSES; pass++) {
    boxBlur1D(a, b, cw, ch, r, true);
    boxBlur1D(b, a, cw, ch, r, false);
  }
  const data = new Uint8Array(cw * ch * 4);
  for (let i = 0; i < cw * ch; i++) {
    const v = Math.max(0, Math.min(255, Math.round(a[i] * 255)));
    const o = i * 4;
    data[o] = v;
    data[o + 1] = v;
    data[o + 2] = v;
    data[o + 3] = 255;
  }
  const texelX = spanX / w;
  const texelY = spanY / h;
  return {
    data,
    w: cw,
    h: ch,
    rect: {
      minX: rect.minX,
      minY: rect.minY,
      maxX: rect.minX + cw * f * texelX,
      maxY: rect.minY + ch * f * texelY,
    },
  };
}

/** One box pass along rows (`horizontal`) or columns, edge-clamped. */
function boxBlur1D(src, dst, w, h, r, horizontal) {
  const n = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const norm = 1 / (2 * r + 1);
  for (let line = 0; line < lines; line++) {
    const at = (k) => {
      const kk = k < 0 ? 0 : k >= n ? n - 1 : k;
      return horizontal ? src[line * w + kk] : src[kk * w + line];
    };
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += at(k);
    for (let k = 0; k < n; k++) {
      if (horizontal) dst[line * w + k] = sum * norm;
      else dst[k * w + line] = sum * norm;
      sum += at(k + r + 1) - at(k - r);
    }
  }
}
