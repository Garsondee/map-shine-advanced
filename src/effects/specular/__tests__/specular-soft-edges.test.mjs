/**
 * specular-soft-edges.test.mjs — THE SHIMMER FIELD HAS NO HARD EDGE ANYWHERE.
 *
 * The author has asked for this twice (*"strictly it needs to be gradients and
 * never cut off angles or edges"*, Round 19, and again 2026-10-18) and the first
 * answer — raising the `contrast` floor — left every cause in place. Measured on
 * the real shader, the causes were a lattice that cut each blob off along its
 * own cell border, a thresholded window whose foot the gain turned into a
 * crisp outline, a `max` that creased where two layers crossed, and a flicker
 * that clamped to zero. This suite is what keeps each of them fixed.
 *
 * ⚠️ WHAT KIND OF ASSERTION THIS IS. A hard edge is a property of the FIELD, not
 * of any value in it, so nothing here pins a number the hash would move. It
 * measures the field: how far it can step between two points a quarter of a
 * pixel apart, whether it agrees on both sides of a cell border, whether the
 * four-cell neighbourhood equals a larger one. And it carries its own detector
 * check — a deliberately cut lattice must register as a jump — because a
 * continuity test that cannot fail is the lying instrument this repo keeps
 * writing postmortems about (`feedback_instruments_must_not_lie`).
 */
import {
  anisotropicBlob,
  blobExponent,
  blobCutExponent,
  cellBlobExponent,
  smoothMin,
  shimmerLayer,
  softWindow,
  softWindowParams,
  legacyWindow,
  spreadForSoftness,
  unionLayers,
  flickerFactor,
  MIN_ROW_SPACING,
  BLOB_BLEND_WIDTH,
  BLOB_REACH_MIN_DISTANCE,
  LAYER_UNION_POWER,
  SPECULAR_FLICKER_LOG_GAIN,
} from '../specular-pattern.js';
import { SPECULAR_LAYER_PARAMS } from '../specular.js';
import { SPECULAR_LAYER_DEFAULTS } from '../specular-render.js';

/** Pattern units per world px at the shipped pattern scale (11840 px). */
const PX = 1 / 11840;

/** A seeded PRNG — the suite must be reproducible. @param {number} seed */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A shipped layer as `shimmerLayer`'s args, at pattern coordinate (u, v).
 * @param {object} L @param {number} u @param {number} v */
function layerArgs(L, u, v) {
  const g = (L.grainAngleDeg * Math.PI) / 180;
  return {
    u,
    v,
    grainX: Math.cos(g),
    grainY: Math.sin(g),
    density: L.density,
    rowSpacing: L.rowSpacing,
    softness: L.softness,
    streak: L.streak,
    contrast: L.contrast,
  };
}

/**
 * The pattern coordinate of a LATTICE coordinate — the inverse of the lattice's
 * own `along`/`across`, so a test can stand exactly on a cell border.
 * @param {object} a - args with grainX/grainY/density/rowSpacing
 * @param {number} along @param {number} across @returns {{u: number, v: number}}
 */
function atLattice(a, along, across) {
  const rows = Math.max(a.rowSpacing, MIN_ROW_SPACING);
  const px = -a.grainY;
  const py = a.grainX;
  return {
    u: (along * a.grainX + across * rows * px) / a.density,
    v: (along * a.grainY + across * rows * py) / a.density,
  };
}

/** The OLD lattice, rebuilt from the new pieces: each point sees only the blob
 * of the cell it sits in. Exists to prove the detectors below can fail.
 * @param {object} a @returns {number} */
function ownCellOnlyShimmer(a) {
  const rows = Math.max(a.rowSpacing, MIN_ROW_SPACING);
  const along = (a.u * a.grainX + a.v * a.grainY) * a.density;
  const across = ((a.u * -a.grainY + a.v * a.grainX) * a.density) / rows;
  const cx = Math.floor(along);
  const cy = Math.floor(across);
  const e = cellBlobExponent(
    cx,
    cy,
    along - cx - 0.5,
    across - cy - 0.5,
    rows,
    a.streak,
    spreadForSoftness(a.softness)
  );
  return softWindow(e, softWindowParams(a.contrast));
}

/**
 * The largest change in `fn` between samples a quarter of a world pixel apart,
 * along `lines` horizontal lines of `steps` samples.
 * @param {(a: object) => number} fn @param {object} base
 * @param {number} lines @param {number} steps @returns {number}
 */
function worstStep(fn, base, lines, steps) {
  const stride = 0.25 * PX;
  let worst = 0;
  for (let line = 0; line < lines; line++) {
    const v = 0.31 + line * 0.0173;
    let prev = null;
    for (let i = 0; i < steps; i++) {
      const val = fn({ ...base, u: 0.17 + i * stride, v });
      if (prev !== null) worst = Math.max(worst, Math.abs(val - prev));
      prev = val;
    }
  }
  return worst;
}

/** @param {{ok: Function}} t */
export function run(t) {
  const { ok } = t;

  // ── 1. A BLOB CONTINUES ACROSS A CELL BORDER ─────────────────────────────
  // The old lattice evaluated one cell per point, so a blob jittered or rotated
  // toward a border was sliced off dead straight: 0.66 of full scale between
  // two points 1e-7 apart, along every such border. Stand exactly on borders —
  // in the lattice's own coordinates, so the grain angle cannot hide one — and
  // compare the two sides.
  const rand = mulberry32(20261018);
  let seamAlong = 0;
  let seamAcross = 0;
  for (const L of SPECULAR_LAYER_DEFAULTS) {
    const a = layerArgs(L, 0, 0);
    for (let i = 0; i < 120; i++) {
      const border = 1 + Math.floor(rand() * 60);
      const free = rand() * 40;
      const eps = 1e-7;
      const l1 = atLattice(a, border - eps, free);
      const r1 = atLattice(a, border + eps, free);
      seamAlong = Math.max(seamAlong, Math.abs(shimmerLayer({ ...a, ...l1 }) - shimmerLayer({ ...a, ...r1 })));
      const l2 = atLattice(a, free, border - eps);
      const r2 = atLattice(a, free, border + eps);
      seamAcross = Math.max(seamAcross, Math.abs(shimmerLayer({ ...a, ...l2 }) - shimmerLayer({ ...a, ...r2 })));
    }
  }
  ok(
    `every shipped layer agrees on both sides of an ALONG-grain cell border (worst ${seamAlong.toExponential(1)})`,
    seamAlong < 1e-3
  );
  ok(`…and of an ACROSS-grain one (worst ${seamAcross.toExponential(1)})`, seamAcross < 1e-3);

  // The detector's own check: rebuilt with the old own-cell-only lattice, the
  // SAME probe must see a cut. Without this the test above could be vacuous.
  let seamCut = 0;
  for (let i = 0; i < 400 && seamCut < 0.2; i++) {
    const a = layerArgs(SPECULAR_LAYER_DEFAULTS[0], 0, 0);
    const border = 1 + Math.floor(rand() * 60);
    const free = rand() * 40;
    const l = atLattice(a, border - 1e-7, free);
    const r = atLattice(a, border + 1e-7, free);
    seamCut = Math.max(seamCut, Math.abs(ownCellOnlyShimmer({ ...a, ...l }) - ownCellOnlyShimmer({ ...a, ...r })));
  }
  ok(`the seam probe CAN fail: the old own-cell lattice steps ${seamCut.toFixed(2)} across a border`, seamCut > 0.2);

  // ── 2. NO JUMP ANYWHERE, AT PIXEL SCALE ──────────────────────────────────
  // A dense scan, a quarter of a world pixel per step. A real cut is a step of
  // 0.3-1.0 in one sample; the steepest honest edge in the whole parameter space
  // is a thin, tight scratch at ~0.03.
  let shippedStep = 0;
  for (const L of SPECULAR_LAYER_DEFAULTS)
    shippedStep = Math.max(shippedStep, worstStep(shimmerLayer, layerArgs(L, 0, 0), 24, 4000));
  ok(
    `the six shipped layers never step more than 0.01 per quarter pixel (worst ${shippedStep.toFixed(4)})`,
    shippedStep < 0.01
  );

  let gridStep = 0;
  for (const rowSpacing of [1, 4, 8]) {
    for (const softness of [0, 0.5, 1]) {
      for (const streak of [0, 1.7, 3]) {
        for (const contrast of [0.5, 0.85, 1]) {
          const base = { grainX: 0.6, grainY: 0.8, density: 32, rowSpacing, softness, streak, contrast };
          gridStep = Math.max(gridStep, worstStep(shimmerLayer, base, 4, 1500));
        }
      }
    }
  }
  ok(
    `…nor does ANY permitted combination of row spacing, softness, streak and coverage (worst ${gridStep.toFixed(4)})`,
    gridStep < 0.08
  );
  let cutScan = 0;
  for (const L of SPECULAR_LAYER_DEFAULTS)
    cutScan = Math.max(cutScan, worstStep(ownCellOnlyShimmer, layerArgs(L, 0, 0), 24, 4000));
  ok(`the scan CAN fail: the old own-cell lattice jumps ${cutScan.toFixed(2)} in one step`, cutScan > 0.3);

  // ── 3. FOUR CELLS ARE EXACTLY ENOUGH ─────────────────────────────────────
  // The claim in the module header. The reference folds the same four cells the
  // same way and then every other cell of a 5×5 neighbourhood in after them, so
  // the ONLY thing that can differ is whether a neglected cell mattered.
  let exactWorst = 0;
  // The inequality the proof rests on, measured directly: no cell outside the
  // 2×2 ever has an exponent below `k · BLOB_REACH_MIN_DISTANCE²`. Checking the
  // OUTPUT alone cannot catch a too-generous constant — the adversarial
  // alignment (a corner jitter, a long axis aimed at the point) is rare enough
  // that a random sample of outputs misses it — so check the quantity itself.
  let neglectedMin = Infinity;
  const exactRand = mulberry32(7);
  for (const rowSpacing of [1, 1.5, 2.5, 4, 8]) {
    for (const softness of [0, 0.31, 0.5, 0.75, 1]) {
      for (const streak of [0, 0.5, 1.7, 3]) {
        for (const contrast of [0.5, 0.85, 1]) {
          const wp = softWindowParams(contrast);
          const cut = blobCutExponent(spreadForSoftness(softness));
          const k = spreadForSoftness(softness);
          for (let i = 0; i < 40; i++) {
            const g = exactRand() * Math.PI * 2;
            const a = {
              u: exactRand() * 6,
              v: exactRand() * 6,
              grainX: Math.cos(g),
              grainY: Math.sin(g),
              density: 11,
              rowSpacing,
              softness,
              streak,
              contrast,
            };
            const along = (a.u * a.grainX + a.v * a.grainY) * a.density;
            const across = ((a.u * -a.grainY + a.v * a.grainX) * a.density) / rowSpacing;
            const cx = Math.floor(along);
            const cy = Math.floor(across);
            const ox = along - cx - 0.5;
            const oy = across - cy - 0.5;
            const sx = ox < 0 ? -1 : 1;
            const sy = oy < 0 ? -1 : 1;
            const E = (dx, dy) => cellBlobExponent(cx + dx, cy + dy, ox - dx, oy - dy, rowSpacing, streak, k);
            let e = smoothMin(
              smoothMin(E(0, 0), E(sx, 0), BLOB_BLEND_WIDTH),
              smoothMin(E(0, sy), E(sx, sy), BLOB_BLEND_WIDTH),
              BLOB_BLEND_WIDTH
            );
            for (let dy = -2; dy <= 2; dy++) {
              for (let dx = -2; dx <= 2; dx++) {
                if ((dx === 0 || dx === sx) && (dy === 0 || dy === sy)) continue;
                const neglected = E(dx, dy);
                neglectedMin = Math.min(neglectedMin, neglected / k);
                e = smoothMin(e, neglected, BLOB_BLEND_WIDTH);
              }
            }
            exactWorst = Math.max(exactWorst, Math.abs(softWindow(blobExponent(a), wp, cut) - softWindow(e, wp, cut)));
          }
        }
      }
    }
  }
  ok(
    `the four-cell neighbourhood equals a 5×5 one over the whole parameter space (worst ${exactWorst.toExponential(1)})`,
    exactWorst < 1e-9
  );
  ok(
    `…because no cell outside the 2×2 comes closer than BLOB_REACH_MIN_DISTANCE (closest seen ${neglectedMin.toFixed(3)}, bound ${BLOB_REACH_MIN_DISTANCE ** 2})`,
    neglectedMin >= BLOB_REACH_MIN_DISTANCE ** 2 - 1e-9
  );
  ok(
    '…and the window is exactly zero from the cut up',
    softWindow(blobCutExponent(spreadForSoftness(1)), softWindowParams(1), blobCutExponent(spreadForSoftness(1))) === 0
  );

  // ── 4. THE SOFT WINDOW ───────────────────────────────────────────────────
  let centreOk = true;
  let monotone = true;
  let slopeOk = true;
  let widerOk = true;
  let widest = Infinity;
  for (const contrast of [0.5, 0.6, 0.7, 0.85, 0.9, 1]) {
    const wp = softWindowParams(contrast);
    centreOk = centreOk && Math.abs(softWindow(0, wp) - 1) < 1e-12;
    let prev = Infinity;
    let maxSlope = 0;
    for (let i = 0; i <= 600; i++) {
      const e = i * 0.01;
      const w = softWindow(e, wp);
      if (w > prev + 1e-12) monotone = false;
      if (i > 0) maxSlope = Math.max(maxSlope, (prev - w) / 0.01);
      prev = w;
    }
    // a logistic's steepest slope is sharp/4 (× the peak normaliser) — nowhere is it a step
    slopeOk = slopeOk && maxSlope < 1.2;

    // The visible ramp, in the exponent: from a glint's full brightness (the
    // window at 0.5) down to a faint skirt (0.005), against the window it replaced.
    const exponentAt = (fn, level) => {
      let lo = 0;
      let hi = 40;
      for (let i = 0; i < 80; i++) {
        const mid = (lo + hi) / 2;
        if (fn(mid) > level) lo = mid;
        else hi = mid;
      }
      return lo;
    };
    const { lo: wlo, hi: whi } = legacyWindow(contrast);
    const legacy = (e) => {
      const b = Math.exp(-e);
      const x = Math.min(1, Math.max(0, (b - wlo) / (whi - wlo)));
      return x * x * (3 - 2 * x);
    };
    const soft = (e) => softWindow(e, wp);
    const rampSoft = exponentAt(soft, 0.005) - exponentAt(soft, 0.5);
    const rampLegacy = exponentAt(legacy, 0.005) - exponentAt(legacy, 0.5);
    widest = Math.min(widest, rampSoft / rampLegacy);
    widerOk = widerOk && rampSoft > rampLegacy * 1.5;
  }
  ok('the blob centre reads exactly 1, at every coverage', centreOk);
  ok('the window only ever falls as the exponent grows', monotone);
  ok('…and nowhere falls faster than a logistic does — there is no cut in it', slopeOk);
  ok(
    `the visible edge is at least 1.5× wider than the window it replaced, at every coverage (narrowest ${widest.toFixed(2)}×)`,
    widerOk
  );
  ok(
    'higher coverage places the window further out, monotonically',
    [0.5, 0.7, 0.85, 1].every((c, i, arr) => i === 0 || softWindowParams(c).mid > softWindowParams(arr[i - 1]).mid)
  );

  // ── 5. LAYERS JOIN WITHOUT A CREASE ──────────────────────────────────────
  ok('one layer joins to itself', Math.abs(unionLayers([0.37]) - 0.37) < 1e-12);
  ok('the join is never below the brightest layer', unionLayers([0.4, 0.7, 0.2]) >= 0.7);
  ok(
    `…and two equal layers stack by 2^(1/${LAYER_UNION_POWER}), not by 2 — the author's reason for max over sum survives`,
    Math.abs(unionLayers([1, 1]) - Math.pow(2, 1 / LAYER_UNION_POWER)) < 1e-12
  );
  const slopeAt = (tt) => (unionLayers([tt + 1e-4, 1 - tt - 1e-4]) - unionLayers([tt - 1e-4, 1 - tt + 1e-4])) / 2e-4;
  const creaseUnion = Math.abs(slopeAt(0.5 + 0.02) - slopeAt(0.5 - 0.02));
  const maxSlope = (tt) => (Math.max(tt + 1e-4, 1 - tt - 1e-4) - Math.max(tt - 1e-4, 1 - tt + 1e-4)) / 2e-4;
  const creaseMax = Math.abs(maxSlope(0.5 + 0.02) - maxSlope(0.5 - 0.02));
  ok(
    `two crossing ramps meet without a crease (slope change ${creaseUnion.toFixed(2)}; a plain max is ${creaseMax.toFixed(1)})`,
    creaseMax > 1.5 && creaseUnion < creaseMax / 3
  );

  // ── 6. THE FLUTTER CANNOT CUT THE SHINE OFF ──────────────────────────────
  ok('no flutter where nothing lights the pixel', flickerFactor(0.9, 3, 0) === 1);
  ok('…nor at amount 0', flickerFactor(-0.7, 0, 1) === 1);
  let flickerPositive = true;
  for (let n = -1.5; n <= 1.5; n += 0.05)
    for (const amount of [0.5, 1.5, 3, 6]) flickerPositive = flickerPositive && flickerFactor(n, amount, 1) > 0;
  ok('the flutter is strictly positive for every noise value and amount — the old clamp reached 0', flickerPositive);
  ok(
    'at the live amount (3) and |noise| 0.8 it spans about ×0.3 .. ×3.3, the range the clamp had',
    Math.abs(flickerFactor(-0.8, 3, 1) - 0.3) < 0.02 && Math.abs(flickerFactor(0.8, 3, 1) - 3.32) < 0.05
  );
  // Constant log-gradient: what makes it impossible to be an edge.
  const d1 = Math.log(flickerFactor(0.1, 3, 1)) - Math.log(flickerFactor(0.0, 3, 1));
  const d2 = Math.log(flickerFactor(0.9, 3, 1)) - Math.log(flickerFactor(0.8, 3, 1));
  ok(
    'its log-gradient is the same everywhere (no point where it steepens)',
    Math.abs(d1 - d2) < 1e-12 && Math.abs(d1 - 0.1 * 3 * SPECULAR_FLICKER_LOG_GAIN) < 1e-12
  );

  // ── 7. THE FLOORS THE PROOF RESTS ON ─────────────────────────────────────
  ok('the row-spacing floor is the one the four-cell proof needs (>= 1)', MIN_ROW_SPACING >= 1);
  ok(
    '…and the schema offers nothing below it (no dead stretch on the slider)',
    SPECULAR_LAYER_PARAMS.rowSpacing.min === MIN_ROW_SPACING
  );
  const base = { u: 0.42, v: 0.13, grainX: 0.8, grainY: 0.6, density: 11, softness: 0.31, streak: 1.7 };
  ok(
    'a row spacing below the floor is clamped to it, not rendered as strips',
    blobExponent({ ...base, rowSpacing: 0.2 }) === blobExponent({ ...base, rowSpacing: MIN_ROW_SPACING })
  );
  ok(
    'the public blob is still a 0..1 value',
    anisotropicBlob({ ...base, rowSpacing: 4 }) <= 1 && anisotropicBlob({ ...base, rowSpacing: 4 }) >= 0
  );
}
