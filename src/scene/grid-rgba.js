/**
 * @fileoverview scene/grid-rgba.js — expand a one-byte mask grid to RGBA bytes,
 * ONCE per grid.
 *
 * Four per-floor gates (`_Outdoors`, `_Fire`, `_Ash`, and the plain sky-reach)
 * are baked into `DataTexture`s the same way: a `w × h` grid of one byte per cell
 * becomes `w × h × 4` bytes with the byte replicated into R, G and B and alpha
 * 255 (RGBA matches every other DataTexture in the viewer and avoids a
 * per-backend question about single-channel formats). On a 2048² grid that is a
 * 4-million-iteration JS loop and a 16 MB allocation — per gate, per floor
 * change, on the commit frame (loading audit P-06, 2026-10-25).
 *
 * The expansion depends only on the grid's bytes, and the mask authority hands
 * back the SAME product object until something feeding it changes, so the result
 * is cached against the source array's identity in a WeakMap: floor PREPARE
 * expands the target floor's grids off screen, the commit gets the bytes back
 * for free, and a floor that is visited again reuses them. A re-derived grid is a
 * different array, so it misses and re-expands — never stale. The WeakMap lets
 * the expansion go when the grid does.
 *
 * Pure (typed arrays in, typed array out): Node-tested.
 *
 * @module scene/grid-rgba
 */

/** @type {WeakMap<ArrayLike<number>, {w:number, h:number, fallback:number, rgba:Uint8Array}>} */
const expansions = new WeakMap();

let hits = 0;
let misses = 0;

/**
 * @param {ArrayLike<number>} data - one byte per cell, row 0 first.
 * @param {number} w @param {number} h - the grid's dimensions.
 * @param {number} fallbackByte - used for a cell the source does not have
 *   (a short array), matching each caller's existing `grid.data[i] ?? FALLBACK`.
 * @returns {Uint8Array} `w*h*4` bytes: R=G=B=value, A=255.
 */
export function expandGridToRgba(data, w, h, fallbackByte) {
  const cached = expansions.get(data);
  if (cached && cached.w === w && cached.h === h && cached.fallback === fallbackByte) {
    hits++;
    return cached.rgba;
  }
  misses++;
  const n = w * h;
  const rgba = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const v = data[i] ?? fallbackByte;
    const o = i * 4;
    rgba[o] = v;
    rgba[o + 1] = v;
    rgba[o + 2] = v;
    rgba[o + 3] = 255;
  }
  expansions.set(data, { w, h, fallback: fallbackByte, rgba });
  return rgba;
}

/** Hit/miss tally, for the cache report. @returns {{hits:number, misses:number}} */
export function getGridRgbaStats() {
  return { hits, misses };
}
