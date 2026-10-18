/**
 * Node verification for scene/grid-edt.js — the exact squared Euclidean
 * distance transform shared by critter zones and the rain-on-glass flow field.
 *
 * The oracle is brute force: for every cell, the minimum squared distance to
 * any source. The transform must match it EXACTLY (it is an exact algorithm,
 * not an approximation), on square and non-square grids, with scattered
 * sources, and the "no source anywhere" sentinel must stay finite.
 */
import { squaredDistanceField, EDT_INF } from '../grid-edt.js';

/** Deterministic xorshift so a failure reproduces. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function bruteForce(isSource, cols, rows) {
  const out = new Float64Array(cols * rows).fill(Infinity);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let best = Infinity;
      for (let sy = 0; sy < rows; sy++) {
        for (let sx = 0; sx < cols; sx++) {
          if (!isSource[sy * cols + sx]) continue;
          const d = (x - sx) * (x - sx) + (y - sy) * (y - sy);
          if (d < best) best = d;
        }
      }
      out[y * cols + x] = best;
    }
  }
  return out;
}

export function run(t) {
  // 1. A single source: the field is the plain squared distance to it.
  {
    const cols = 9;
    const rows = 7;
    const src = new Uint8Array(cols * rows);
    src[3 * cols + 4] = 1;
    const got = squaredDistanceField(src, cols, rows);
    const want = bruteForce(src, cols, rows);
    let exact = true;
    for (let i = 0; i < got.length; i++) if (got[i] !== want[i]) exact = false;
    t.ok('grid-edt: single source matches brute force exactly', exact);
    t.ok('grid-edt: the source cell itself is 0', got[3 * cols + 4] === 0);
  }

  // 2. Scattered sources on non-square grids, several densities.
  for (const [cols, rows, density, seed] of [
    [23, 11, 0.05, 7],
    [11, 29, 0.02, 99],
    [17, 17, 0.2, 5],
    [40, 3, 0.1, 1234],
  ]) {
    const rand = rng(seed);
    const src = new Uint8Array(cols * rows);
    for (let i = 0; i < src.length; i++) src[i] = rand() < density ? 1 : 0;
    src[0] = 1; // guarantee at least one source
    const got = squaredDistanceField(src, cols, rows);
    const want = bruteForce(src, cols, rows);
    let worst = 0;
    for (let i = 0; i < got.length; i++) worst = Math.max(worst, Math.abs(got[i] - want[i]));
    t.ok('grid-edt: ' + cols + 'x' + rows + ' scattered sources, worst error ' + worst + ' === 0', worst === 0);
  }

  // 3. Every cell a source: all zero.
  {
    const src = new Uint8Array(6 * 5).fill(1);
    const got = squaredDistanceField(src, 6, 5);
    t.ok(
      'grid-edt: all sources gives all zeros',
      got.every((v) => v === 0)
    );
  }

  // 4. No source anywhere: the finite sentinel, never Infinity or NaN
  // (an Infinity would turn the parabola intersection into NaN).
  {
    const got = squaredDistanceField(new Uint8Array(8 * 8), 8, 8);
    t.ok(
      'grid-edt: no source stays finite and at or above half the sentinel',
      got.every((v) => Number.isFinite(v) && v >= EDT_INF * 0.5)
    );
  }

  // 5. Row-major with row 0 first: a source in the top-right corner of a wide grid.
  {
    const cols = 10;
    const rows = 2;
    const src = new Uint8Array(cols * rows);
    src[cols - 1] = 1;
    const got = squaredDistanceField(src, cols, rows);
    t.ok('grid-edt: distance along the row is dx squared', got[0] === 81 && got[cols - 2] === 1);
    t.ok('grid-edt: the row below adds dy squared', got[cols + cols - 1] === 1 && got[cols] === 82);
  }
}
