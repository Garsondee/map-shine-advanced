/**
 * light-polygon-repair.test.mjs — the hair-thin "folds" Foundry's wall sweep leaves beside a post
 * (`light-polygon-repair.js`), the thin lines of light the author reported at wall joins (2026-10-19).
 *
 * The numbers in the first case are the real ones, read off the fire at (6939.84, 6644.53) on the Mad Scientist's
 * Compound: vertex 31 sat 0.098 degrees on the wrong side of the post corner (vertex 32).
 */
import { repairLightPolygonFolds, MAX_FOLD_RAD } from '../light-polygon-repair.js';
import { triangulateLightFan } from '../point-light-illumination.js';

const DEG = Math.PI / 180;

function polar(list) {
  const lx = new Float64Array(list.length);
  const ly = new Float64Array(list.length);
  list.forEach(([deg, r], i) => {
    lx[i] = Math.cos(deg * DEG) * r;
    ly[i] = Math.sin(deg * DEG) * r;
  });
  return { lx, ly, n: list.length };
}
const angleOf = (p, i) => Math.atan2(p.ly[i], p.lx[i]) / DEG;
const radiusOf = (p, i) => Math.hypot(p.lx[i], p.ly[i]);

export function run(t) {
  const { ok } = t;
  const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

  // ── the real case: a far point 0.098 degrees past a post corner, folding back onto the corner ──
  // (a lit window beam up to 148, then the fold, then the post's shadow, then the next window's beam)
  const p = polar([
    [140, 0.6], //  0  far, window beam
    [149.7491, 0.7], //  1  far, just before the corner (window beam edge)
    [149.8472, 0.8], //  2  far, 0.098 deg PAST the corner: the fold
    [149.7491, 0.2], //  3  near, the post corner
    [152.0581, 0.22], //  4  near, the post's other end
    [152.15, 0.86], //  5  far, beyond the post
    [200, 0.9], //  6
    [260, 0.9], //  7
    [320, 0.9], //  8
    [20, 0.9], //  9
    [80, 0.9], // 10
  ]);
  const before2 = angleOf(p, 2);
  const fixed = repairLightPolygonFolds(p.lx, p.ly, p.n);
  ok('the fold is found and repaired (one point moved)', fixed >= 1);
  ok(
    'the far point is slid onto the corner’s ray',
    near(angleOf(p, 2), angleOf(p, 3), 1e-9) && angleOf(p, 2) < before2
  );
  ok(
    'it keeps its distance from the light (so the beam outline moves by under a pixel)',
    near(radiusOf(p, 2), 0.8, 1e-9)
  );
  ok('the corner itself is untouched', near(radiusOf(p, 3), 0.2, 1e-9) && near(angleOf(p, 3), 149.7491, 1e-9));
  ok('a legitimate wide step is untouched (the next beam starts where it should)', near(angleOf(p, 5), 152.15, 1e-9));

  // ── nothing to repair ───────────────────────────────────────────────────
  const clean = polar([
    [0, 1],
    [90, 1],
    [180, 1],
    [270, 1],
  ]);
  const snap = Array.from(clean.lx).concat(Array.from(clean.ly));
  eq3(repairLightPolygonFolds(clean.lx, clean.ly, clean.n), 0);
  ok(
    'an ordinary polygon is left exactly as it was',
    snap.every((v, i) => v === (i < 4 ? clean.lx[i] : clean.ly[i - 4]))
  );
  function eq3(got, want) {
    ok(`an ordinary polygon needs no repair (got ${got})`, got === want);
  }

  // ── a big backwards step is real geometry, never a fold ─────────────────
  const real = polar([
    [0, 1],
    [100, 1],
    [60, 0.5],
    [200, 1],
    [300, 1],
  ]);
  ok('a backwards step over several degrees is left alone', repairLightPolygonFolds(real.lx, real.ly, real.n) === 0);
  ok('the fold limit is under half a degree', MAX_FOLD_RAD < 0.5 * DEG);

  // ── clockwise polygons, and the +-180 degree seam ───────────────────────
  const cw = polar([
    [80, 0.9],
    [20, 0.9],
    [-40, 0.9],
    [-100.0, 0.8],
    [-100.1, 0.2],
    [-150, 0.9],
    [-200, 0.9],
  ]);
  // winding is clockwise here; the step -100 -> -100.1 is WITH the winding, so this polygon has no fold
  ok('a clockwise polygon with no fold is untouched', repairLightPolygonFolds(cw.lx, cw.ly, cw.n) === 0);
  const cwFold = polar([
    [80, 0.9],
    [20, 0.9],
    [-40, 0.9],
    [-100.1, 0.8],
    [-100.0, 0.2],
    [-150, 0.9],
    [-200, 0.9],
  ]);
  ok('a clockwise polygon with a fold is repaired', repairLightPolygonFolds(cwFold.lx, cwFold.ly, cwFold.n) >= 1);
  const seam = polar([
    [170, 0.9],
    [179.9, 0.8],
    [-179.95, 0.9],
    [179.85, 0.2],
    [-120, 0.9],
    [-60, 0.9],
    [0, 0.9],
    [90, 0.9],
  ]);
  ok('a fold across the +-180 degree seam is found', repairLightPolygonFolds(seam.lx, seam.ly, seam.n) >= 1);

  // ── degenerate input never throws ───────────────────────────────────────
  ok('fewer than 4 points: nothing to do', repairLightPolygonFolds(new Float64Array(3), new Float64Array(3), 3) === 0);
  const atOrigin = { lx: new Float64Array([0, 0, 1, 0, -1, 0]), ly: new Float64Array([0, 0, 0, 1, 0, -1]), n: 6 };
  ok(
    'points sitting on the light itself are skipped, never divided by',
    (() => {
      try {
        repairLightPolygonFolds(atOrigin.lx, atOrigin.ly, atOrigin.n);
        return true;
      } catch (e) {
        return false;
      }
    })()
  );

  // ── it is wired into the real fan: the fan built from the folded shape has no triangle in the post's shadow ──
  const R = 1000;
  const x0 = 500;
  const y0 = 500;
  const shape = [];
  for (let i = 0; i < p.n; i++) {
    shape.push(x0 + Math.cos(angleOf(polar([[0, 1]]), 0) * DEG) * 0, 0); // placeholder, replaced below
  }
  shape.length = 0;
  const fold = polar([
    [140, 0.6],
    [149.7491, 0.7],
    [149.8472, 0.8],
    [149.7491, 0.2],
    [152.0581, 0.22],
    [152.15, 0.86],
    [200, 0.9],
    [260, 0.9],
    [320, 0.9],
    [20, 0.9],
    [80, 0.9],
  ]);
  for (let i = 0; i < fold.n; i++) shape.push(x0 + fold.lx[i] * R, y0 + fold.ly[i] * R);
  const { array, vertexCount, normalized } = triangulateLightFan(shape, x0, y0, R);
  ok('the fan keeps every triangle', vertexCount === fold.n * 3);
  // find the fan triangle of the folded edge (vertex 2 -> 3): both its outer corners must now lie on one ray
  const o = 2 * 9;
  const ax = array[o + 3];
  const ay = array[o + 4];
  const bx = array[o + 6];
  const by = array[o + 7];
  ok(
    'the fold’s fan triangle has no area left (its two outer corners are on one ray)',
    Math.abs(ax * by - ay * bx) < 1e-9
  );
  ok(
    'and the SDF data was repaired with it',
    normalized.n === fold.n && near(Math.atan2(normalized.ly[2], normalized.lx[2]) / DEG, 149.7491, 1e-6)
  );
}
