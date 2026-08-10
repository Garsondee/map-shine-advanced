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

import {
  coarseAlphaGridDims,
  extractAlphaGrid,
  coarseAlphaMean,
  createMinAlphaGrid,
  accumulateMinAlphaBand,
  COARSE_ALPHA_MAX_DIM,
} from '../coarse-alpha.js';

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

  // --- the min-alpha grid (Stage 1's interior certification) ---------------
  // The property that matters most is again NEGATIVE: a texel must never read
  // 255 unless EVERY source pixel under it was 255 — a false "fully opaque"
  // certifies an unblended draw that changes pixels.
  {
    const g = createMinAlphaGrid(4, 2);
    t.ok('a fresh min grid is all 255 — the identity of min', g.length === 8 && g.every((v) => v === 255));
    t.throws('bad dims throw rather than yielding an empty certifier', () => createMinAlphaGrid(0, 4), 'bad dims');
  }
  {
    // 8x4 image onto a 4x2 grid: each texel covers exactly 2x2 source px. One
    // 254 pixel at (1,1) must drop EXACTLY texel (0,0) — the case a box-MEAN
    // grid would round away entirely, which is this grid's whole reason to exist.
    const iw = 8;
    const ih = 4;
    const rgba = (fill) => {
      const d = new Uint8Array(iw * ih * 4);
      for (let i = 3; i < d.length; i += 4) d[i] = fill;
      return d;
    };
    const whole = rgba(255);
    whole[(1 * iw + 1) * 4 + 3] = 254;
    const g1 = createMinAlphaGrid(4, 2);
    accumulateMinAlphaBand({ grid: g1, gridW: 4, gridH: 2, band: whole, bandY: 0, bandH: ih, imageW: iw, imageH: ih });
    t.ok('one sub-255 pixel drops exactly its own texel', g1[0] === 254);
    t.ok('...and no other', g1[1] === 255 && g1[4] === 255 && g1[7] === 255);

    // Band-split equivalence: the worker reads in bands; the certification
    // must not care where the band edges fall.
    const g2 = createMinAlphaGrid(4, 2);
    const bandBytes = (y0, rows) => whole.subarray(y0 * iw * 4, (y0 + rows) * iw * 4);
    accumulateMinAlphaBand({
      grid: g2,
      gridW: 4,
      gridH: 2,
      band: bandBytes(0, 2),
      bandY: 0,
      bandH: 2,
      imageW: iw,
      imageH: ih,
    });
    accumulateMinAlphaBand({
      grid: g2,
      gridW: 4,
      gridH: 2,
      band: bandBytes(2, 2),
      bandY: 2,
      bandH: 2,
      imageW: iw,
      imageH: ih,
    });
    t.ok(
      'two bands accumulate to the same grid as one',
      g1.every((v, i) => v === g2[i])
    );

    // A hole at the far corner exercises the clamped last-row/last-column
    // mapping — the classic off-by-one hiding place.
    const holed = rgba(255);
    holed[(3 * iw + 7) * 4 + 3] = 0;
    const g3 = createMinAlphaGrid(4, 2);
    accumulateMinAlphaBand({ grid: g3, gridW: 4, gridH: 2, band: holed, bandY: 0, bandH: ih, imageW: iw, imageH: ih });
    t.ok('a corner hole pins its own texel to 0', g3[7] === 0 && g3[0] === 255);
  }
  {
    const g = createMinAlphaGrid(2, 2);
    t.throws(
      'a short band THROWS rather than certifying texels it never saw',
      () =>
        accumulateMinAlphaBand({
          grid: g,
          gridW: 2,
          gridH: 2,
          band: new Uint8Array(4),
          bandY: 0,
          bandH: 2,
          imageW: 4,
          imageH: 2,
        }),
      'expected'
    );
    t.throws(
      'a band past the image edge throws too',
      () =>
        accumulateMinAlphaBand({
          grid: g,
          gridW: 2,
          gridH: 2,
          band: new Uint8Array(4 * 2 * 4),
          bandY: 1,
          bandH: 2,
          imageW: 4,
          imageH: 2,
        }),
      'band geometry'
    );
  }
}
