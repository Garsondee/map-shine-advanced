/**
 * coarse-alpha.test.mjs — the art-opacity grid the cover derivation was starved
 * of (see `vt/coarse-alpha.js`'s header for the defect).
 *
 * Small surface, but the two things asserted here are the two that would fail
 * silently: an aspect ratio that squashes an item's silhouette (its shadow would
 * be the wrong SHAPE, which looks like an art problem, not a code one), and a
 * short buffer read as real data (a half-filled coverage grid renders as a
 * building that stops halfway).
 */

import { coarseAlphaGridDims, extractAlphaGrid, coarseAlphaMean, COARSE_ALPHA_MAX_DIM } from '../coarse-alpha.js';

/** @param {{ok:(name:string, cond:boolean)=>void, throws:Function}} t */
export function run(t) {
  // --- dimensions ---------------------------------------------------------
  {
    const wide = coarseAlphaGridDims(4000, 1000);
    t.ok('the long side lands on the cap', Math.max(wide.w, wide.h) === COARSE_ALPHA_MAX_DIM);
    t.ok('aspect ratio survives (4:1 in, 4:1 out)', Math.abs(wide.w / wide.h - 4) < 0.02);

    const tall = coarseAlphaGridDims(1000, 4000);
    t.ok('and on the other axis too', tall.h === COARSE_ALPHA_MAX_DIM && Math.abs(tall.h / tall.w - 4) < 0.02);

    const small = coarseAlphaGridDims(64, 48);
    t.ok(
      'a small image is NEVER upscaled — that would invent coverage detail that does not exist',
      small.w === 64 && small.h === 48
    );

    t.ok('a degenerate size still produces a usable 1x1', coarseAlphaGridDims(0, 0).w === 1);
    t.ok('and so does a nonsense one', coarseAlphaGridDims(NaN, undefined).h === 1);
  }

  // --- extraction ---------------------------------------------------------
  {
    const w = 3;
    const h = 2;
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4 + 0] = 200; // r — must be ignored
      data[i * 4 + 3] = i * 40; // a — 0,40,80,120,160,200
    }
    const grid = extractAlphaGrid({ data, width: w, height: h });
    t.ok('shape is preserved', grid.w === 3 && grid.h === 2);
    t.ok('it reads ALPHA, not red', grid.data[0] === 0 && grid.data[1] === 40 && grid.data[5] === 200);
    t.ok(
      'row order is the image’s own (row 0 = top) — the same convention extractContentWindow uses',
      grid.data[3] === 120
    );
    t.ok('the mean is a 0..1 coverage fraction', Math.abs(coarseAlphaMean(grid) - 100 / 255) < 0.01);
  }

  // --- refusal ------------------------------------------------------------
  {
    t.throws(
      'a short buffer THROWS rather than producing a half-filled grid',
      () => extractAlphaGrid({ data: new Uint8Array(4), width: 10, height: 10 }),
      'expected'
    );
    t.throws('a missing buffer throws too', () => extractAlphaGrid({ width: 4, height: 4 }), 'bad imageData');
    t.ok('an empty grid means zero coverage, not NaN', coarseAlphaMean({ data: new Uint8Array(0) }) === 0);
    t.ok('and so does a missing one', coarseAlphaMean(null) === 0);
  }
}
