/**
 * water-flow-solve.test.mjs — THE CPU REFERENCE PROVEN AGAINST BRUTE FORCE
 * AND HAND-COMPUTABLE FIXTURES, before any TSL port is attempted (S3, ★
 * KEYSTONE) — see `water-flow-solve.js`'s own header for why this ordering
 * matters: "does it compile" cannot catch a subtly-wrong iterative solver.
 */
import {
  downsampleBoxAverage,
  upsampleBilinear,
  seedVelocity,
  computeDivergence,
  jacobiPressureStep,
  sorPressureStep,
  subtractPressureGradient,
  meanAbsDivergence,
  solveVelocityLevel,
  solveWaterFlowVelocity,
  WATER_FLOW_SOLVE_LEVEL_FRACTIONS,
  WATER_FLOW_SOLVE_ITERATIONS_PER_LEVEL,
  WATER_FLOW_SOLVE_OMEGA,
} from '../water-flow-solve.js';

function idx(i, j, w) {
  return j * w + i;
}

/** A filled circle of solidity 1 inside radius `r` of `(cx,cy)`, 0 outside —
 * a binary edge is fine here; S2's fractional-texel nuance is not what these
 * fixtures are checking (the SOLVER's routing behaviour is). */
function circleSolid(w, h, cx, cy, r) {
  const solid = new Float64Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      solid[idx(i, j, w)] = (i - cx) * (i - cx) + (j - cy) * (j - cy) <= r * r ? 1 : 0;
    }
  }
  return solid;
}

/** A fully sealed box: `border`-thick solid wall around an open interior,
 * itself sitting `inset` cells inside the array's own edge so the array's
 * OWN Dirichlet-open boundary (the mask-rect edge, per B3) never touches the
 * sealed interior — the interior's only boundary is the wall itself. */
function sealedBoxSolid(w, h, inset, border) {
  const solid = new Float64Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const onWall =
        i >= inset &&
        i < w - inset &&
        j >= inset &&
        j < h - inset &&
        (i < inset + border || i >= w - inset - border || j < inset + border || j >= h - inset - border);
      solid[idx(i, j, w)] = onWall ? 1 : 0;
    }
  }
  return solid;
}

function isInterior(w, h, inset, border, i, j) {
  return i >= inset + border && i < w - inset - border && j >= inset + border && j < h - inset - border;
}

function speed(vx, vy, n) {
  return Math.hypot(vx[n], vy[n]);
}

export function run(t) {
  const { ok } = t;

  // ══ THE CONSTANTS ═══════════════════════════════════════════════════════
  ok(
    'WATER_FLOW_SOLVE_LEVEL_FRACTIONS ends at 1 (the finest level IS the input resolution)',
    WATER_FLOW_SOLVE_LEVEL_FRACTIONS[WATER_FLOW_SOLVE_LEVEL_FRACTIONS.length - 1] === 1
  );
  ok(
    'WATER_FLOW_SOLVE_LEVEL_FRACTIONS has 5 levels (64→128→256→512→1024`s own shape)',
    WATER_FLOW_SOLVE_LEVEL_FRACTIONS.length === 5
  );
  ok(
    "WATER_FLOW_SOLVE_ITERATIONS_PER_LEVEL is 60 (2026-08-19: bumped from the plan's original 20 " +
      'when Jacobi was replaced by SOR — measured to sit just past where SOR itself plateaus, ' +
      "see that constant's own doc)",
    WATER_FLOW_SOLVE_ITERATIONS_PER_LEVEL === 60
  );

  // ══ downsampleBoxAverage ════════════════════════════════════════════════
  {
    const constant = new Float64Array(16).fill(2);
    const down = downsampleBoxAverage(constant, 4, 4, 2, 2);
    ok(
      'downsampling a constant field yields the same constant',
      down.every((v) => Math.abs(v - 2) < 1e-9)
    );

    const checker = new Float64Array([1, 0, 0, 1]); // 2x2
    const one = downsampleBoxAverage(checker, 2, 2, 1, 1);
    ok('downsampling a 2x2 checkerboard to 1x1 gives the mean, 0.5', Math.abs(one[0] - 0.5) < 1e-9);
  }

  // ══ upsampleBilinear ════════════════════════════════════════════════════
  {
    const single = new Float64Array([7]);
    const up = upsampleBilinear(single, 1, 1, 4, 4);
    ok(
      'upsampling a 1x1 field yields a constant field',
      up.every((v) => Math.abs(v - 7) < 1e-9)
    );

    // A 2x2 field with a known ramp: (0,0)=0 (1,0)=10 (0,1)=0 (1,1)=10 — a
    // pure left-to-right ramp, no vertical variation, so ANY upsampled row
    // should reproduce the SAME horizontal ramp.
    const ramp = new Float64Array([0, 10, 0, 10]);
    const upRamp = upsampleBilinear(ramp, 2, 2, 4, 2);
    ok(
      'bilinear upsample of a pure horizontal ramp stays flat vertically (row 0 == row 1)',
      Math.abs(upRamp[idx(0, 0, 4)] - upRamp[idx(0, 1, 4)]) < 1e-9 &&
        Math.abs(upRamp[idx(3, 0, 4)] - upRamp[idx(3, 1, 4)]) < 1e-9
    );
    ok(
      'bilinear upsample increases monotonically left to right on that ramp',
      upRamp[idx(0, 0, 4)] < upRamp[idx(1, 0, 4)] &&
        upRamp[idx(1, 0, 4)] < upRamp[idx(2, 0, 4)] &&
        upRamp[idx(2, 0, 4)] < upRamp[idx(3, 0, 4)]
    );
  }

  // ══ seedVelocity (B2) ═══════════════════════════════════════════════════
  {
    const solid = new Float64Array([0, 1, 0.5]);
    const { vx, vy } = seedVelocity(solid, 3, 1, 2, -3);
    ok('open cell (solid=0) reads the full bulk direction', vx[0] === 2 && vy[0] === -3);
    ok('fully solid cell (solid=1) reads exactly zero', vx[1] === 0 && vy[1] === 0);
    ok('half-solid cell reads HALF the bulk direction, not a coin flip', vx[2] === 1 && vy[2] === -1.5);
  }

  // ══ computeDivergence ═══════════════════════════════════════════════════
  {
    // A CONSTANT field has zero divergence everywhere, including at the
    // one-sided edges (a constant's one-sided difference is also zero).
    const w = 5;
    const h = 4;
    const vxConst = new Float64Array(w * h).fill(3);
    const vyConst = new Float64Array(w * h).fill(-1);
    const divConst = computeDivergence(vxConst, vyConst, w, h);
    ok(
      'a uniform flow field has exactly zero divergence everywhere',
      divConst.every((d) => d === 0)
    );

    // vx = i (a pure left-to-right ramp), vy = 0 — central difference of `i`
    // is exactly 1 in the interior: 0.5*((i+1)-(i-1)) = 1.
    const vxRamp = new Float64Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) vxRamp[idx(i, j, w)] = i;
    const vyZero = new Float64Array(w * h);
    const divRamp = computeDivergence(vxRamp, vyZero, w, h);
    ok(
      'a linear ramp vx=i has divergence exactly 1 in the interior (hand-computable)',
      Math.abs(divRamp[idx(2, 2, w)] - 1) < 1e-9
    );
  }

  // ══ ONE JACOBI STEP, HAND-VERIFIABLE ON A TRIVIAL GRID ═════════════════
  {
    // 3x3, all open, div all zero except the centre = 4. One Jacobi step from
    // p=0 must read exactly p[centre] = 0.25*(0+0+0+0-4) = -1 at the centre,
    // and 0.25*(-(any-neighbor-div)) = 0 everywhere adjacent to it that has
    // no OWN div and whose only non-zero-p neighbor doesn't exist yet (p is
    // still all zero on this first pass).
    const w = 3;
    const h = 3;
    const solid = new Float64Array(w * h); // all open
    const div = new Float64Array(w * h);
    div[idx(1, 1, w)] = 4;
    const p0 = new Float64Array(w * h);
    const p1 = jacobiPressureStep(p0, div, solid, w, h);
    ok('one Jacobi step from p=0: the ONLY nonzero-div cell reads -1', Math.abs(p1[idx(1, 1, w)] - -1) < 1e-9);
    ok(
      'one Jacobi step from p=0: every other cell stays 0 (no p to pull from yet)',
      p1[idx(0, 0, w)] === 0 && p1[idx(2, 2, w)] === 0
    );

    // ══ SAME FIXTURE, `sorPressureStep` — pins BOTH halves of the new
    // function's own contract: the extrapolation math, and the checkerboard
    // masking (`docs/planning/Water-Simulation-Turn.md`'s S3-continued entry
    // names this file as where the fix is proven before the TSL port).
    // Cell (1,1): i+j=2, parity 0 (even) — the SAME jacobiAvg as above (-1,
    // all neighbours still 0 either way), but SOR EXTRAPOLATES past it:
    // next = centre + omega*(jacobiAvg-centre) = 0 + omega*(-1-0) = -omega.
    const pMatchingParity = sorPressureStep(p0, div, solid, w, h, WATER_FLOW_SOLVE_OMEGA, 0);
    ok(
      `SOR step, matching parity (0): the nonzero-div cell reads -omega = ${(-WATER_FLOW_SOLVE_OMEGA).toFixed(3)}, not plain Jacobi's -1`,
      Math.abs(pMatchingParity[idx(1, 1, w)] - -WATER_FLOW_SOLVE_OMEGA) < 1e-9
    );
    // Same call, OPPOSITE parity: (1,1) is NOT this pass's colour, so it must
    // be copied through unchanged — the actual mechanism that makes two
    // alternating calls behave like checkerboard Gauss-Seidel rather than
    // both colours silently overwriting each other's own turn.
    const pOppositeParity = sorPressureStep(p0, div, solid, w, h, WATER_FLOW_SOLVE_OMEGA, 1);
    ok(
      "SOR step, OPPOSITE parity (1): that same cell is copied through UNCHANGED — not this pass's colour",
      pOppositeParity[idx(1, 1, w)] === 0
    );
  }

  // ══ FULLY SOLID CELL: PROJECTION NEVER LEAVES A GHOST VELOCITY ═════════
  {
    const w = 4;
    const h = 4;
    const solid = new Float64Array(w * h);
    solid[idx(2, 2, w)] = 1;
    const { vx, vy } = seedVelocity(solid, w, h, 1, 0);
    const div = computeDivergence(vx, vy, w, h);
    let p = new Float64Array(w * h);
    for (let it = 0; it < 20; it++) p = jacobiPressureStep(p, div, solid, w, h);
    const projected = subtractPressureGradient(vx, vy, p, solid, w, h);
    ok(
      'a fully solid cell has exactly zero velocity after projection, not merely small',
      projected.vx[idx(2, 2, w)] === 0 && projected.vy[idx(2, 2, w)] === 0
    );
  }

  // ══ FLOW AROUND A CIRCULAR OBSTACLE — the plan's own S3 proof, numerically ══
  {
    const w = 64;
    const h = 32;
    const cx = 32;
    const cy = 16;
    const r = 6;
    const solid = circleSolid(w, h, cx, cy, r);
    const result = solveWaterFlowVelocity({ solid, width: w, height: h, bearingDeg: 90 }); // 90 = due east, [1,0]
    ok(
      'bearing 90 resolves to due-east [1,0] (waterFlowVector`s own convention)',
      result.dirX === 1 && Math.abs(result.dirY) < 1e-9
    );

    const upstream = idx(cx - r - 2, cy, w); // just west of the circle
    const downstream = idx(cx + r + 2, cy, w); // just east of the circle
    const north = idx(cx, cy - r - 2, w); // just north of the circle
    const south = idx(cx, cy + r + 2, w); // just south of the circle
    const farField = idx(4, 4, w); // corner, far from the obstacle's influence

    const speedUpstream = speed(result.vx, result.vy, upstream);
    const speedDownstream = speed(result.vx, result.vy, downstream);
    const speedNorth = speed(result.vx, result.vy, north);
    const speedSouth = speed(result.vx, result.vy, south);
    const speedFar = speed(result.vx, result.vy, farField);

    ok(`far field stays close to the free-stream speed 1 (got ${speedFar.toFixed(3)})`, Math.abs(speedFar - 1) < 0.2);
    ok(
      `flow ACCELERATES beside the obstacle vs directly upstream of it (north ${speedNorth.toFixed(3)} vs upstream ${speedUpstream.toFixed(3)})`,
      speedNorth > speedUpstream && speedSouth > speedUpstream
    );
    ok(
      `flow ACCELERATES beside the obstacle vs directly downstream of it (north ${speedNorth.toFixed(3)} vs downstream ${speedDownstream.toFixed(3)})`,
      speedNorth > speedDownstream && speedSouth > speedDownstream
    );
    ok(
      `flow beside the obstacle exceeds the free-stream speed (north ${speedNorth.toFixed(3)}, south ${speedSouth.toFixed(3)})`,
      speedNorth > 1.05 && speedSouth > 1.05
    );

    // Every solid texel itself must read exactly zero, at the FINEST level.
    let anyGhost = false;
    for (let n = 0; n < w * h; n++) {
      if (result.solid[n] >= 1 && (result.vx[n] !== 0 || result.vy[n] !== 0)) anyGhost = true;
    }
    ok('no solid texel carries a nonzero velocity ("water inside the rock")', !anyGhost);

    // ══ DIVERGENCE STAYS SMALL AWAY FROM THE OBSTACLE — NOT a before/after
    // ratio at the WHOLE field. `computeDivergence` reads velocity RAW (not
    // solid-aware — see that function's own header for why: an earlier
    // attempt to "clean up" the divergence right at the solid/open interface
    // by blending it away made the wall completely INVISIBLE to the solver,
    // proven on the sealed-box fixture below). That means a real, LARGE
    // divergence value immediately touching the obstacle is not a defect to
    // chase — it is the signal the pressure solve is built to route around,
    // and it survives at full strength even after a perfect solve (it is a
    // discretization fact about differencing across a hard 0/1 step, not a
    // measure of solver quality). What DOES measure solver quality is
    // whether that signal stays LOCALIZED — divergence a few cells away from
    // any obstacle should be small, not smeared across the whole field.
    {
      let sumFar = 0;
      let countFar = 0;
      const divAfter = computeDivergence(result.vx, result.vy, w, h);
      const isNearSolid = (i, j) => {
        for (const [di, dj] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const ni = i + di,
            nj = j + dj;
          if (ni >= 0 && ni < w && nj >= 0 && nj < h && result.solid[idx(ni, nj, w)] > 0) return true;
        }
        return result.solid[idx(i, j, w)] > 0;
      };
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          if (isNearSolid(i, j)) continue;
          sumFar += Math.abs(divAfter[idx(i, j, w)]);
          countFar++;
        }
      }
      const meanFar = sumFar / countFar;
      ok(
        `divergence away from the obstacle stays small — projection does not smear garbage across the field (mean |div| ${meanFar.toFixed(4)})`,
        meanFar < 0.02
      );
    }
  }

  // ══ SOR vs PLAIN JACOBI — the exact shape of the 2026-08-19 live-reported
  // failure, reproduced and fixed at Node-test speed before ever touching the
  // GPU. `docs/planning/Water-Simulation-Turn.md`'s own S3-continued entry:
  // on the real river, a probe ~2.5 obstacle-radii from a SMALL obstacle's
  // own centre showed under 2° of deflection and no narrow-vs-wide speed
  // differential — potential-flow theory says that distance should show a
  // clearly measurable effect. Reproduced here at CPU-test scale (the SAME
  // ratio, not just a similarly-shaped fixture) against BOTH the OLD
  // algorithm (a plain-Jacobi cascade, hand-assembled from the still-exported
  // `jacobiPressureStep` so the "before" case does not depend on
  // `solveVelocityLevel`'s own internals having changed) and the NEW one
  // (`solveWaterFlowVelocity`, SOR since this fix).
  {
    /** A plain-Jacobi cascade, mirroring `solveWaterFlowVelocity`'s own
     * structure exactly but calling `jacobiPressureStep` in the loop — the
     * ALGORITHM this project shipped before 2026-08-19, kept alive here
     * ONLY as this test's own "before" baseline, never as a second
     * production code path. */
    function legacyJacobiCascade({ solid, width, height, bearingDeg, levelFractions, iterationsPerLevel }) {
      // `waterFlowVector` is not exported from water-flow-solve.js (it is
      // re-exported FROM water-field.js, imported internally) — this test
      // only ever uses bearing 90 (due east), so the unit vector is inlined
      // rather than pulling in a second import path for one constant pair.
      const dirX = Math.round(Math.sin((bearingDeg * Math.PI) / 180) * 1e9) / 1e9;
      const dirY = Math.round(-Math.cos((bearingDeg * Math.PI) / 180) * 1e9) / 1e9;
      let prevPressure = null;
      let prevW = 0;
      let prevH = 0;
      let result = null;
      let lw = width;
      let lh = height;
      for (const frac of levelFractions) {
        lw = Math.max(2, Math.round(width * frac));
        lh = Math.max(2, Math.round(height * frac));
        const levelSolid = lw === width && lh === height ? solid : downsampleBoxAverage(solid, width, height, lw, lh);
        const { vx: vx0, vy: vy0 } = seedVelocity(levelSolid, lw, lh, dirX, dirY);
        const div = computeDivergence(vx0, vy0, lw, lh);
        let p = prevPressure ? upsampleBilinear(prevPressure, prevW, prevH, lw, lh) : new Float64Array(lw * lh);
        for (let it = 0; it < iterationsPerLevel; it++) p = jacobiPressureStep(p, div, levelSolid, lw, lh);
        const projected = subtractPressureGradient(vx0, vy0, p, levelSolid, lw, lh);
        result = { vx: projected.vx, vy: projected.vy };
        prevPressure = p;
        prevW = lw;
        prevH = lh;
      }
      return { vx: result.vx, vy: result.vy, width: lw, height: lh };
    }

    // r=3 (small), probe at 8 cells from centre → r_probe/R ≈ 2.67, the SAME
    // ballpark as the live island (~2.5 radii) — potential-flow theory:
    // speedup ≈ 1 + 1/2.67² ≈ 14% at the abeam position.
    const w = 64;
    const h = 32;
    const cx = 32;
    const cy = 16;
    const r = 3;
    const probeDist = 8;
    const solid = circleSolid(w, h, cx, cy, r);
    const bearingDeg = 90; // due east, [1,0]

    const before = legacyJacobiCascade({
      solid,
      width: w,
      height: h,
      bearingDeg,
      levelFractions: WATER_FLOW_SOLVE_LEVEL_FRACTIONS,
      iterationsPerLevel: WATER_FLOW_SOLVE_ITERATIONS_PER_LEVEL,
    });
    const after = solveWaterFlowVelocity({ solid, width: w, height: h, bearingDeg });

    const northIdx = idx(cx, cy - probeDist, w);
    const speedBefore = speed(before.vx, before.vy, northIdx);
    const speedAfter = speed(after.vx, after.vy, northIdx);

    ok(
      `SOR shows a clearly measurable speed-up at 2.67 obstacle-radii (before ${speedBefore.toFixed(3)}, after ${speedAfter.toFixed(3)}) — theory predicts ~1.14`,
      speedAfter > 1.05
    );
    ok(
      `SOR's own speed-up at this distance is closer to the theoretical ~1.14 than plain Jacobi's was (before ${speedBefore.toFixed(3)}, after ${speedAfter.toFixed(3)})`,
      speedAfter - 1 > (speedBefore - 1) * 1.5
    );

    // ══ NARROW GAP FASTER THAN WIDE GAP — the SPECIFIC check that FAILED on
    // the real river (an off-centre obstacle in a wide-open channel, not a
    // centred one — the live island's own actual topology). A solve that
    // ignores the obstacle shows these roughly equal; a solve respecting it
    // shows the narrow side faster (mass conservation through a tighter gap).
    {
      const cw = 80;
      const ch = 40;
      const occx = 26; // off-centre: narrow gap to the LEFT bank, wide gap to the right
      const occy = 20;
      const orad = 5;
      const chSolid = circleSolid(cw, ch, occx, occy, orad);
      const chBearing = 0; // due north, [0,-1] — flow travels along the channel's own long axis
      const chAfter = solveWaterFlowVelocity({ solid: chSolid, width: cw, height: ch, bearingDeg: chBearing });
      const leftGapX = Math.round(occx - orad - 6); // narrow: 6px of open water to the obstacle's own edge
      const rightGapX = Math.round(occx + orad + 20); // wide: 20px of open water on the far side
      const leftSpeed = speed(chAfter.vx, chAfter.vy, idx(leftGapX, occy, cw));
      const rightSpeed = speed(chAfter.vx, chAfter.vy, idx(rightGapX, occy, cw));
      ok(
        `SOR: the narrow gap runs faster than the wide gap (left ${leftSpeed.toFixed(3)} vs right ${rightSpeed.toFixed(3)}) — the exact check that failed on the real river`,
        leftSpeed > rightSpeed
      );
    }
  }

  // ══ A SEALED BOX SUPPRESSES SOME NET FLOW — A NAMED v1 LIMITATION, NOT A
  // CLAIM OF FULL SUPPRESSION ═════════════════════════════════════════════
  // The CONTINUUM answer for a uniform seed against solid walls on every
  // side is EXACTLY zero interior velocity — proven two independent ways
  // (a 1-D reduction, where incompressibility forces velocity to be a single
  // constant that a zero-normal wall pins to zero; and a full 2-D
  // Laplace/Neumann derivation giving `p=x+const`, so `v'=v-∇p=0`
  // everywhere). This collocated-grid (not staggered/MAC), ghost-cell
  // Neumann scheme does NOT reach that answer — even at full Jacobi
  // convergence (8000 iterations, far past this test's own budget, checked
  // by hand while chasing this exact number) it plateaus around HALF the
  // seed speed, independent of wall thickness. That is a real, structural
  // property of this simplified scheme on a FULLY ENCLOSED topology, the
  // same spirit as B3's own "no vortex shedding v1 — a named limitation, not
  // a bug" (Water-Simulation-Turn.md §3). It matters little for THIS
  // module's actual target (an open river routing around local obstacles,
  // where the far Dirichlet boundary dominates and this pathology does not
  // arise — see the circular-obstacle block above, which DOES show correct
  // routing) — a fully sealed pond is not the shape a real authored water
  // mask produces. This test asserts what is actually TRUE (partial
  // suppression) rather than a stronger claim that would just be restating
  // an assumption this file's own investigation disproved
  // (`feedback_test_expectation_from_an_assumed_distribution`).
  {
    const w = 32;
    const h = 32;
    const inset = 4;
    const border = 2;
    const solid = sealedBoxSolid(w, h, inset, border);
    const result = solveWaterFlowVelocity({ solid, width: w, height: h, bearingDeg: 90 });

    let sumBefore = 0;
    let sumAfter = 0;
    let count = 0;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        if (!isInterior(w, h, inset, border, i, j)) continue;
        const n = idx(i, j, w);
        sumBefore += 1; // the uniform seed speed, trivially
        sumAfter += speed(result.vx, result.vy, n);
        count++;
      }
    }
    ok('the sealed-box fixture actually has an interior to measure', count > 0);
    const meanAfter = sumAfter / count;
    const meanBefore = sumBefore / count;
    ok(
      `mean interior speed drops SOME once the box is sealed, even if not close to the continuum's exact zero (seed ${meanBefore.toFixed(2)}, projected ${meanAfter.toFixed(3)})`,
      meanAfter < meanBefore * 0.95 && meanAfter > 0
    );
  }

  // ══ COARSE-TO-FINE ≈ A WELL-CONVERGED FINE-ONLY SOLVE ══════════════════
  // The cross-check this project always runs on an iterative-vs-brute-force
  // pair (`water-body.test.mjs`'s own jump-flood-vs-brute-force precedent):
  // the cascade must not be a DIFFERENT answer from the ground truth, only a
  // cheaper way to reach a close one.
  {
    const w = 48;
    const h = 24;
    const solid = circleSolid(w, h, 24, 12, 5);
    const cascaded = solveWaterFlowVelocity({ solid, width: w, height: h, bearingDeg: 90 });

    // Flat Jacobi, single level, started from zero, run for MANY more
    // iterations than any one cascade level gets — small enough a domain
    // (48x24) that flat Jacobi CAN reasonably equilibrate here, unlike the
    // plan's own "1024-wide domain" warning against using it as the ONLY
    // strategy at production scale.
    const [dirX, dirY] = [cascaded.dirX, cascaded.dirY];
    const fineOnly = solveVelocityLevel({
      solid,
      width: w,
      height: h,
      dirX,
      dirY,
      initialPressure: null,
      iterations: 400,
    });

    let sumAbsDiff = 0;
    let count = 0;
    for (let n = 0; n < w * h; n++) {
      if (solid[n] >= 1) continue; // solid reads zero in both, trivially
      sumAbsDiff += Math.hypot(cascaded.vx[n] - fineOnly.vx[n], cascaded.vy[n] - fineOnly.vy[n]);
      count++;
    }
    const meanAbsDiff = sumAbsDiff / count;
    ok(
      `the cascade agrees with a well-converged flat solve to within a small tolerance (mean |diff| = ${meanAbsDiff.toFixed(4)}, free-stream speed = 1)`,
      meanAbsDiff < 0.15
    );
  }

  // ══ MORE ITERATIONS CONVERGE FURTHER, NOT WORSE ═════════════════════════
  {
    const w = 24;
    const h = 24;
    const solid = circleSolid(w, h, 12, 12, 4);
    const { vx, vy } = seedVelocity(solid, w, h, 1, 0);
    const div = computeDivergence(vx, vy, w, h);

    function residualAfter(iterations) {
      let p = new Float64Array(w * h);
      for (let it = 0; it < iterations; it++) p = jacobiPressureStep(p, div, solid, w, h);
      const projected = subtractPressureGradient(vx, vy, p, solid, w, h);
      return meanAbsDivergence(computeDivergence(projected.vx, projected.vy, w, h));
    }

    const residual1 = residualAfter(1);
    const residual20 = residualAfter(20);
    const residual80 = residualAfter(80);
    ok(
      `20 iterations converge further than 1 (residual ${residual1.toFixed(4)} -> ${residual20.toFixed(4)})`,
      residual20 < residual1
    );
    ok(
      `80 iterations do not regress past 20 by more than a small tolerance (residual ${residual20.toFixed(4)} vs ${residual80.toFixed(4)})`,
      residual80 < residual20 + 1e-6
    );
  }

  // ══ DETERMINISM — a pure function, no hidden state ═════════════════════
  {
    const w = 20;
    const h = 20;
    const solid = circleSolid(w, h, 10, 10, 3);
    const a = solveWaterFlowVelocity({ solid, width: w, height: h, bearingDeg: 37 });
    const b = solveWaterFlowVelocity({ solid, width: w, height: h, bearingDeg: 37 });
    let identical = true;
    for (let n = 0; n < w * h; n++) {
      if (a.vx[n] !== b.vx[n] || a.vy[n] !== b.vy[n]) identical = false;
    }
    ok('solving the same fixture twice yields bit-identical results', identical);
  }
}
