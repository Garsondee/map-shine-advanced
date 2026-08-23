/**
 * water-flow-solve.js — THE CPU REFERENCE for B2 (seed) + B3 (coarse-to-fine
 * pressure projection), `docs/planning/Water-Simulation-Turn.md` §3 Layer B,
 * S3 (★ KEYSTONE).
 *
 * ============================================================================
 * WHY THIS IS PURE JS, PORTED TO TSL ONLY AFTER IT IS PINNED HERE
 * ============================================================================
 * TSL itself is not Node-testable (`src/CONVENTIONS.md` §4) — "does it
 * compile" cannot catch a subtly-wrong iterative solver, and an incompressible
 * pressure projection is exactly the kind of algorithm that LOOKS plausible
 * wrong (a sign flip in the boundary treatment still produces SOME flow field,
 * just not a divergence-free one) while being wrong. This project's own
 * precedent for exactly this risk is `water-body.js#rebaseNeighborOffset` — a
 * pure-JS reference proven against brute force BEFORE the jump-flood TSL port
 * — and `docs/planning/Water-Simulation-Turn.md` §4 S3 names this file in
 * advance as the same move: "write and Node-test the pressure-projection CPU
 * reference before any shader port."
 *
 * ⚠️ THIS FILE WAS WRITTEN WITH NO CONSUMER, ON PURPOSE — the whole point of
 * proving the algorithm out BEFORE the TSL port was that it had to stand on
 * its own, correctness-wise, with nothing downstream yet depending on it
 * (`graph/reachable-from-boot`'s own ratchet was bumped 2→3 to admit exactly
 * that state for one session, `depth-of-field-blur.js`'s same mechanism).
 * **That state ended the same day**: `water-flow-subsystem.js` now imports
 * {@link WATER_FLOW_SOLVE_LEVEL_FRACTIONS} and
 * {@link WATER_FLOW_SOLVE_ITERATIONS_PER_LEVEL} directly (never re-declared —
 * the shader and the CPU reference read the SAME two numbers, the same
 * "one formula, not two copies" discipline `water-body.js#rebaseNeighborOffset`
 * already established), making this file reachable from `boot.js` again on
 * its own; the ratchet bound moved back 3→2. `water-flow.js`'s own five
 * material builders are the actual TSL PORT of every function below —
 * function for function, ported only AFTER this file's own Node tests caught
 * and fixed the gradient-halving bug this header's next section documents.
 *
 * ============================================================================
 * THE ALGORITHM, AND WHERE EACH LINE CAME FROM
 * ============================================================================
 * Water-Simulation-Turn.md §3 Layer B, verbatim pseudocode:
 *
 *   v    = current × (1 − solid)                              // B2, seed
 *   div  = 0.5 * ((vR.x − vL.x) + (vU.y − vD.y))               // B3, divergence
 *   p    = 0.25 * (pL + pR + pU + pD − div)                    // B3, Jacobi
 *   v   -= 0.5 * vec2(pR − pL, pU − pD)                        // B3, project
 *
 * "Must be a coarse-to-fine cascade, not flat Jacobi" — flat Jacobi propagates
 * information one texel per iteration, so a fixed iteration count on a
 * 1024-wide domain cannot equilibrate globally. {@link solveWaterFlowVelocity}
 * solves at a sequence of coarser grids first (~20 Jacobi iterations each,
 * {@link WATER_FLOW_SOLVE_ITERATIONS_PER_LEVEL}), upsampling the PRESSURE
 * field (never velocity) as the next level's initial guess — the standard
 * multigrid "prolongation" step, which is why {@link upsampleBilinear} below
 * is a plain bilinear filter and NOT the quintic remap
 * `feedback_bilinear_is_c0_and_steep_reads_amplify_the_crease` demands for a
 * VISUALLY sampled field: this upsample only seeds further Jacobi iterations
 * that smooth out any blockiness in the initial guess, so its own C0 seams
 * are never the thing anyone looks at.
 *
 * Boundaries, verbatim from the plan: "`solid` cells → Neumann (reflect);
 * water cells touching the mask-rect edge → Dirichlet `p = 0` (open
 * inflow/outflow, so a river flows through rather than filling a bathtub)."
 * {@link neighborPressureEffective} implements both in one function: an
 * off-grid neighbor (the mask-rect edge) reads as `p = 0` (Dirichlet); an
 * on-grid neighbor blends toward the CENTER cell's own pressure in proportion
 * to that neighbor's solidity (Neumann's "zero gradient across the wall",
 * generalised continuously — solidity is FRACTIONAL since S2, so a neighbor
 * that is 30% obstructed should only PARTLY mirror, not fully reflect).
 *
 * ============================================================================
 * WHAT THIS FILE'S OWN NODE TEST ACTUALLY CAUGHT — READ BEFORE "SIMPLIFYING"
 * ANY OF THE BOUNDARY CODE BELOW
 * ============================================================================
 * The plan's pseudocode above, taken completely literally, ships a real bug:
 * `0.5 * (pR - pL)` assumes both neighbors sit a full cell away, but a
 * Neumann-mirrored neighbor (substituted with the CENTRE's own value) sits at
 * EFFECTIVE DISTANCE ZERO — so the naive formula silently HALVES the gradient
 * at every open cell touching so much as one solid neighbor.
 * {@link subtractPressureGradient} therefore goes through
 * {@link blendedNeighbor} + {@link axisGradient}, which divide by the actual
 * effective span instead of a hardcoded 2 — see {@link blendedNeighbor}'s own
 * doc for the live number this fixed (a sealed-box fixture stuck at exactly
 * `0.5×` the correct pressure slope, independent of wall thickness).
 *
 * The OPPOSITE fix was also tried and REVERTED the same day:
 * {@link computeDivergence} does NOT apply the same solid-aware blending to
 * the raw velocity field, even though the resulting divergence value right at
 * a solid/open interface is large (correctly so — see that function's own
 * header for the experiment that proved removing it makes the wall
 * completely invisible to the solver, and the "projected" velocity come back
 * bit-for-bit identical to the unprojected seed).
 *
 * Even with the gradient fix, a FULLY SEALED body of water (walls on every
 * side, no outlet) only reaches roughly HALF suppression of a uniform seed,
 * not the continuum's exact zero — a genuine, accepted v1 limitation of this
 * collocated-grid (not staggered/MAC) scheme, named here rather than chased
 * further because it does not affect this module's actual target: an OPEN
 * river routing around LOCAL obstacles, where the far Dirichlet boundary
 * dominates and a fully-enclosed topology never arises from a real authored
 * water mask. `water-flow-solve.test.mjs`'s own sealed-box block asserts
 * PARTIAL suppression, honestly, not the stronger claim this investigation
 * disproved.
 *
 * @module effects/water/water-flow-solve
 */

import { waterFlowVector } from './water-field.js';

/**
 * The cascade, as FRACTIONS of the finest level's own width/height rather
 * than the plan's literal "64 → 128 → 256 → 512 → 1024" — a real flow grid is
 * whatever aspect ratio the water body has (`water-flow-subsystem.js#sizeFlowGrid`
 * keeps it aspect-preserving, capped at `WATER_FLOW_GRID_MAX_DIM` on the long
 * side), so a hardcoded square cascade would either not reach the actual
 * resolution or distort the aspect mid-solve. `1/16, 1/8, 1/4, 1/2, 1` is the
 * SAME five-level, doubling-each-step shape the plan names (1024/16 = 64),
 * generalised to whatever the finest level's own dimensions are.
 */
export const WATER_FLOW_SOLVE_LEVEL_FRACTIONS = Object.freeze([1 / 16, 1 / 8, 1 / 4, 1 / 2, 1]);

/**
 * Water-Simulation-Turn.md §3's own number was "~20 iterations per level",
 * verbatim, sized for PLAIN JACOBI. Bumped 20→60 the same day
 * {@link sorPressureStep} replaced Jacobi as the solve path — MEASURED, not
 * guessed: a Node-side iteration sweep (20/40/80/160/320) on a fixture
 * shaped like the live-reported failure showed SOR itself keeps improving
 * through roughly 80 iterations then genuinely PLATEAUS (8.0% speed-up at
 * 80, 8.1% at 320 — no further gain, and critically no oscillation or
 * instability either, unlike a divergent solver would show at high counts).
 * 60 captures nearly all of that available gain (7.9%, against the 8.0-8.1%
 * ceiling) while stopping short of fully-plateaued, wasted iterations. This
 * is a one-time BAKE cost (`docs/planning/Water-Simulation-Turn.md`'s own
 * S3-continued entry — the author's own framing: "the flow of the river
 * shouldn't change during the session... bake once"), so 3× the old count
 * is not a real cost the way it would be for a per-frame solve.
 */
export const WATER_FLOW_SOLVE_ITERATIONS_PER_LEVEL = 60;

/**
 * The SOR over-relaxation factor (2026-08-19) — see {@link sorPressureStep}'s
 * own doc for the full account of why plain Jacobi was replaced. `1 < omega
 * < 2` extrapolates PAST the plain Gauss-Seidel-style update; `omega = 1`
 * would be Gauss-Seidel with no extrapolation at all (still strictly better
 * than Jacobi, from the checkerboard ordering alone); `omega >= 2` is
 * unconditionally unstable for this class of system. 1.7 is a FIXED,
 * documented-as-provisional value, comfortably inside the stable `(0,2)`
 * range without sitting near its unstable edge — NOT the per-grid-size
 * analytically optimal value (the closed-form formula, `2/(1+sin(pi/N))`,
 * assumes a clean rectangular ALL-Dirichlet domain; this solver's own mixed
 * Neumann/Dirichlet boundary and irregular, author-painted obstacle shapes
 * have no equally clean closed form). Empirically checked, not just
 * asserted: `water-flow-solve.test.mjs`'s own SOR-vs-Jacobi block measures
 * this value converging faster than plain Jacobi at the SAME iteration
 * count, on both the original circular-obstacle fixture and a NEW
 * small-obstacle-in-open-water fixture shaped like the live-reported
 * failure (`docs/planning/Water-Simulation-Turn.md`'s own S3-continued
 * entry) — a future, more thorough per-level tuning pass is a reasonable
 * follow-up, not a prerequisite for this being a real improvement over
 * omega=1 (plain Jacobi).
 */
export const WATER_FLOW_SOLVE_OMEGA = 1.7;

/** A level may not shrink below this on either axis — a 1×1 or 0-width Jacobi
 * grid is not a meaningful pressure solve, just a degenerate edge case a tiny
 * or extreme-aspect water body could otherwise reach at the coarsest fraction. */
export const WATER_FLOW_SOLVE_MIN_LEVEL_DIM = 2;

function idx(i, j, w) {
  return j * w + i;
}

/**
 * Box-filter downsample — the SAME "area, not a point sample" principle
 * `water-flow.js#buildWaterSoliditySeedMaterial` uses at the mask→flow-texel
 * step, applied one level further: shrinking an ALREADY-fractional solidity
 * field is a plain arithmetic mean over each destination cell's own source
 * footprint (no presence threshold needed here — that step already happened
 * once, upstream, at the mask→finest-level bake).
 * @param {Float64Array} src @param {number} sw @param {number} sh
 * @param {number} dw @param {number} dh
 * @returns {Float64Array}
 */
export function downsampleBoxAverage(src, sw, sh, dw, dh) {
  const out = new Float64Array(dw * dh);
  for (let dj = 0; dj < dh; dj++) {
    const sy0 = Math.floor((dj / dh) * sh);
    const sy1 = Math.max(sy0 + 1, Math.floor(((dj + 1) / dh) * sh));
    for (let di = 0; di < dw; di++) {
      const sx0 = Math.floor((di / dw) * sw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((di + 1) / dw) * sw));
      let sum = 0;
      let count = 0;
      for (let sy = sy0; sy < Math.min(sy1, sh); sy++) {
        for (let sx = sx0; sx < Math.min(sx1, sw); sx++) {
          sum += src[idx(sx, sy, sw)];
          count++;
        }
      }
      out[idx(di, dj, dw)] = count > 0 ? sum / count : 0;
    }
  }
  return out;
}

/**
 * Bilinear upsample, cell-centre sampling (no half-texel edge bias) — the
 * multigrid PROLONGATION step. See this module's own header for why plain
 * bilinear, not the quintic remap a visually-sampled field would need.
 * @param {Float64Array} src @param {number} sw @param {number} sh
 * @param {number} dw @param {number} dh
 * @returns {Float64Array}
 */
export function upsampleBilinear(src, sw, sh, dw, dh) {
  const out = new Float64Array(dw * dh);
  if (sw === 1 && sh === 1) {
    out.fill(src[0]);
    return out;
  }
  for (let dj = 0; dj < dh; dj++) {
    const sy = sh <= 1 ? 0 : ((dj + 0.5) / dh) * sh - 0.5;
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    const cy0 = Math.min(Math.max(y0, 0), sh - 1);
    const cy1 = Math.min(Math.max(y0 + 1, 0), sh - 1);
    for (let di = 0; di < dw; di++) {
      const sx = sw <= 1 ? 0 : ((di + 0.5) / dw) * sw - 0.5;
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      const cx0 = Math.min(Math.max(x0, 0), sw - 1);
      const cx1 = Math.min(Math.max(x0 + 1, 0), sw - 1);
      const v00 = src[idx(cx0, cy0, sw)];
      const v10 = src[idx(cx1, cy0, sw)];
      const v01 = src[idx(cx0, cy1, sw)];
      const v11 = src[idx(cx1, cy1, sw)];
      const top = v00 + (v10 - v00) * fx;
      const bot = v01 + (v11 - v01) * fx;
      out[idx(di, dj, dw)] = top + (bot - top) * fy;
    }
  }
  return out;
}

/**
 * B2 — the seed. `v = current × (1 − solid)`: full bulk speed in open water,
 * zero inside a fully solid cell, a FRACTION for a partially-obstructed one
 * (S2's own continuous solidity carried straight through, never re-thresholded).
 * @param {Float64Array} solid @param {number} w @param {number} h
 * @param {number} dirX @param {number} dirY
 * @returns {{vx: Float64Array, vy: Float64Array}}
 */
export function seedVelocity(solid, w, h, dirX, dirY) {
  const vx = new Float64Array(w * h);
  const vy = new Float64Array(w * h);
  for (let n = 0; n < w * h; n++) {
    const open = 1 - solid[n];
    vx[n] = dirX * open;
    vy[n] = dirY * open;
  }
  return { vx, vy };
}

/**
 * A neighboring SAMPLE of a scalar field (pressure OR one velocity
 * component — the logic is identical for both, see this module's header),
 * blended by the neighbor's own solidity, PLUS the effective distance that
 * sample sits at — the distance is what {@link axisGradient} needs to avoid
 * the halving bug this module's header documents in full.
 *
 * `s=0` (open): the neighbor's real value, at the real distance of 1 whole
 * cell. `s=1` (fully solid): mirrors the CENTRE's own value — a Neumann
 * ghost, which is NOT a real sample and sits at distance 0. A fractional `s`
 * blends both continuously, matching {@link seedVelocity}'s own "partial
 * obstruction still deflects flow, never a coin flip" treatment.
 * @param {Float64Array} field @param {Float64Array} solid
 * @param {number} w @param {number} i @param {number} j @param {number} centerValue
 * @returns {{value: number, distance: number}}
 */
function blendedNeighbor(field, solid, w, i, j, centerValue) {
  const n = idx(i, j, w);
  const s = solid[n];
  const v = field[n];
  return { value: v + (centerValue - v) * s, distance: 1 - s };
}

/**
 * One axis of a central difference: `(posSide.value - negSide.value) /
 * (their combined EFFECTIVE span)`, never a hardcoded divisor — see
 * {@link blendedNeighbor}'s and this module's own header for exactly why a
 * fixed divisor silently halves the result next to a solid neighbor. Both
 * sides fully solid (`span≈0`) reads as zero: there is no real sample on
 * EITHER side to estimate a slope from, and the numerator is itself ~0 in
 * that case too (both sides equal `centerValue`), so this is a
 * divide-by-zero guard, not an approximation.
 * @param {{value:number, distance:number}} negSide
 * @param {{value:number, distance:number}} posSide
 * @returns {number}
 */
function axisGradient(negSide, posSide) {
  const span = negSide.distance + posSide.distance;
  return span > 1e-9 ? (posSide.value - negSide.value) / span : 0;
}

/**
 * B3 line 1 — divergence, central differences inside the grid, EXACTLY the
 * raw velocity field — deliberately NOT solid-aware, and this needed a real,
 * numbered experiment to confirm rather than assumption:
 *
 * ⚠️ **AN EARLIER VERSION OF THIS FUNCTION BLENDED SOLID NEIGHBORS THROUGH
 * {@link blendedNeighbor} (mirroring toward the centre, the same Neumann
 * treatment pressure gets) TO AVOID A DIVERGENCE "CLIFF" AT THE SOLID/OPEN
 * INTERFACE — reasoning, WRONGLY, that the cliff was a discretization
 * artifact.** It is not: it is the ONLY signal that tells the pressure
 * solve a wall is there at all. Verified by REMOVING it entirely on a
 * fully-sealed-box fixture (continuum answer: zero interior velocity, proven
 * two ways — a 1-D reduction and a full 2-D Laplace/Neumann derivation, both
 * giving `p=x+const`): with the blend, `div` collapsed to ~0 EVERYWHERE
 * (open interior AND at the wall alike), Jacobi had nothing to solve for,
 * and the "projected" velocity came back EXACTLY EQUAL to the unprojected
 * seed — not approximately, bit-for-bit — proving the wall had become
 * completely invisible to the solver. Reverted the same day it was added.
 *
 * The RIGHT fix for the cliff turned out to be downstream, in
 * {@link subtractPressureGradient}'s gradient (see {@link blendedNeighbor}'s
 * own doc) — divergence needs to see the real discontinuity; only the
 * GRADIENT step needed distance-awareness.
 *
 * At the grid's OWN edge (the mask-rect boundary — see this module's header
 * on Dirichlet `p=0`) there is no off-grid neighbor to read, so a one-sided
 * difference is used instead of inventing one; this is the standard
 * open-boundary treatment (a river's divergence at the rect edge is measured
 * from what is actually there, not from an assumed mirror).
 * @param {Float64Array} vx @param {Float64Array} vy
 * @param {number} w @param {number} h
 * @returns {Float64Array}
 */
export function computeDivergence(vx, vy, w, h) {
  const div = new Float64Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const n = idx(i, j, w);
      let dvx;
      if (w === 1) dvx = 0;
      else if (i === 0) dvx = vx[idx(i + 1, j, w)] - vx[n];
      else if (i === w - 1) dvx = vx[n] - vx[idx(i - 1, j, w)];
      else dvx = 0.5 * (vx[idx(i + 1, j, w)] - vx[idx(i - 1, j, w)]);
      let dvy;
      if (h === 1) dvy = 0;
      else if (j === 0) dvy = vy[idx(i, j + 1, w)] - vy[n];
      else if (j === h - 1) dvy = vy[n] - vy[idx(i, j - 1, w)];
      else dvy = 0.5 * (vy[idx(i, j + 1, w)] - vy[idx(i, j - 1, w)]);
      div[n] = dvx + dvy;
    }
  }
  return div;
}

/**
 * A neighbor's pressure, as the Jacobi update and the projection step should
 * both read it — see this module's header for the boundary account. Off-grid
 * (the mask-rect edge) → Dirichlet `0`. On-grid → blended toward the CENTER
 * cell's own pressure by the neighbor's solidity (`mix(pNeighbor, pCenter,
 * solidNeighbor)`): open (`solid=0`) reads the neighbor's real value
 * unchanged; fully solid (`solid=1`) mirrors the centre exactly (Neumann,
 * zero gradient across the wall); a fractional obstruction blends smoothly
 * between the two, the same "partial obstruction still deflects flow"
 * treatment {@link seedVelocity} already gives velocity.
 * @param {Float64Array} p @param {Float64Array} solid
 * @param {number} w @param {number} h @param {number} i @param {number} j
 * @param {number} centerP
 * @returns {number}
 */
function neighborPressureEffective(p, solid, w, h, i, j, centerP) {
  if (i < 0 || i >= w || j < 0 || j >= h) return 0;
  const n = idx(i, j, w);
  const s = solid[n];
  const pn = p[n];
  return pn + (centerP - pn) * s;
}

/**
 * {@link blendedNeighbor} for PRESSURE specifically, adding the off-grid
 * (Dirichlet, mask-rect edge) case that function alone does not handle —
 * unlike {@link computeDivergence}, which branches to a one-sided difference
 * at the array edge and so never calls `blendedNeighbor` off-grid at all,
 * {@link subtractPressureGradient} reads all 4 neighbors through ONE
 * uniform call, so this wrapper is where the edge case lives instead. A
 * Dirichlet neighbor is a real value at a real distance-1 location — the
 * same as any ordinary open neighbor, never a distance-0 ghost.
 * @param {Float64Array} p @param {Float64Array} solid
 * @param {number} w @param {number} h @param {number} i @param {number} j
 * @param {number} centerP
 * @returns {{value: number, distance: number}}
 */
function neighborPressureForGradient(p, solid, w, h, i, j, centerP) {
  if (i < 0 || i >= w || j < 0 || j >= h) return { value: 0, distance: 1 };
  return blendedNeighbor(p, solid, w, i, j, centerP);
}

/**
 * B3 line 2 — ONE Jacobi iteration. `p = 0.25 * (pL + pR + pU + pD - div)`,
 * every neighbor read through {@link neighborPressureEffective} so the two
 * boundary conditions apply uniformly rather than as a special case bolted
 * onto the interior formula.
 * @param {Float64Array} p @param {Float64Array} div @param {Float64Array} solid
 * @param {number} w @param {number} h
 * @returns {Float64Array}
 */
export function jacobiPressureStep(p, div, solid, w, h) {
  const next = new Float64Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const n = idx(i, j, w);
      const centerP = p[n];
      const pL = neighborPressureEffective(p, solid, w, h, i - 1, j, centerP);
      const pR = neighborPressureEffective(p, solid, w, h, i + 1, j, centerP);
      const pU = neighborPressureEffective(p, solid, w, h, i, j - 1, centerP);
      const pD = neighborPressureEffective(p, solid, w, h, i, j + 1, centerP);
      next[n] = 0.25 * (pL + pR + pU + pD - div[n]);
    }
  }
  return next;
}

/**
 * B3 line 2, SOR VARIANT (2026-08-19) — replaces plain Jacobi as the
 * PRODUCTION solve path (`solveVelocityLevel`'s own loop). `jacobiPressureStep`
 * above is UNCHANGED and stays exported — still correct, still a useful
 * reference/comparison point (`water-flow-solve.test.mjs`'s own SOR-vs-Jacobi
 * block reads both), just no longer what actually ships.
 *
 * ⚠️ WHY: plain Jacobi's own convergence rate for the LOW-FREQUENCY error
 * component — "route flow around an obstacle," a large-scale, whole-field
 * correction — scales as `O(1/N^2)` in iteration count for an N-wide grid.
 * This was measured, not assumed: on the real river, in the shader-lab bench,
 * bumping the iteration budget 10× (20→200 per level) barely moved the
 * result (a bend's own deflection went from −0.5° to −1.7°, nowhere near the
 * ~16° a genuinely converged solve should show at that distance from an
 * obstacle) — the classic signature of a solver that has already reached
 * ITS OWN ceiling, not one that merely needs more time
 * (`docs/planning/Water-Simulation-Turn.md`'s own S3-continued entry has the
 * full account). Red-black SOR's own rate scales `O(1/N)` — an order better.
 *
 * HOW, without losing GPU parallelism: split the grid into a checkerboard
 * (`(i+j) % 2`). In a 5-point stencil, every cell's four neighbours are
 * ALWAYS the OPPOSITE colour from itself — so updating one whole colour has
 * zero read/write conflicts (exactly as parallel as plain Jacobi), and
 * because the OTHER colour was just refreshed on the PREVIOUS call, each
 * colour reads fresher neighbour data than plain Jacobi ever does — the same
 * mechanism that makes Gauss-Seidel converge roughly 2× faster than Jacobi
 * on its own, before `omega` extrapolates further past it.
 *
 * `omega` EXTRAPOLATES the checkerboard Gauss-Seidel-style update in the
 * same direction it was already moving: `next = centre + omega*(average −
 * centre)`. See {@link WATER_FLOW_SOLVE_OMEGA}'s own doc for why 1.7 and not
 * a per-grid analytically-derived value.
 *
 * @param {Float64Array} p @param {Float64Array} div @param {Float64Array} solid
 * @param {number} w @param {number} h @param {number} omega
 * @param {0|1} parity - which checkerboard colour to update THIS call — the
 *   caller alternates 0 then 1 every iteration ({@link solveVelocityLevel}'s
 *   own loop), so one "iteration" is still one full pass over the WHOLE
 *   grid, matching {@link WATER_FLOW_SOLVE_ITERATIONS_PER_LEVEL}'s own
 *   existing meaning — nothing downstream needs to know the pass happened
 *   in two colour-restricted halves rather than one.
 * @returns {Float64Array} a NEW array — cells of the INACTIVE parity are
 *   copied through unchanged (this call has nothing new to say about them).
 */
export function sorPressureStep(p, div, solid, w, h, omega, parity) {
  const next = new Float64Array(p);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (((i + j) & 1) !== parity) continue;
      const n = idx(i, j, w);
      const centerP = p[n];
      const pL = neighborPressureEffective(p, solid, w, h, i - 1, j, centerP);
      const pR = neighborPressureEffective(p, solid, w, h, i + 1, j, centerP);
      const pU = neighborPressureEffective(p, solid, w, h, i, j - 1, centerP);
      const pD = neighborPressureEffective(p, solid, w, h, i, j + 1, centerP);
      const jacobiAvg = 0.25 * (pL + pR + pU + pD - div[n]);
      next[n] = centerP + omega * (jacobiAvg - centerP);
    }
  }
  return next;
}

/**
 * B3 line 3 — the projection. `v -= grad(p)`, then re-masked by `(1 - solid)`
 * — the SAME zeroing {@link seedVelocity} applies, reapplied here because the
 * pressure gradient alone has no reason to land exactly on zero inside a
 * solid cell (its neighbors' real pressures still leak in through the
 * Neumann blend), and a non-zero velocity "inside a rock" would be a silent,
 * physically meaningless leftover.
 *
 * ⚠️ THE GRADIENT ITSELF GOES THROUGH {@link neighborPressureForGradient} +
 * {@link axisGradient}, NOT the plain `0.5 * (pR - pL)` the plan's own
 * pseudocode literally writes — see {@link blendedNeighbor}'s own doc (this
 * module's header) for the live, numbered bug (a sealed-box fixture stuck at
 * `0.525×` residual speed instead of the continuum's exact zero) that using
 * the naive fixed divisor here actually shipped, caught by this file's own
 * Node test before ever reaching a shader.
 * @param {Float64Array} vx @param {Float64Array} vy @param {Float64Array} p
 * @param {Float64Array} solid @param {number} w @param {number} h
 * @returns {{vx: Float64Array, vy: Float64Array}}
 */
export function subtractPressureGradient(vx, vy, p, solid, w, h) {
  const outVx = new Float64Array(w * h);
  const outVy = new Float64Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const n = idx(i, j, w);
      const centerP = p[n];
      const L = neighborPressureForGradient(p, solid, w, h, i - 1, j, centerP);
      const R = neighborPressureForGradient(p, solid, w, h, i + 1, j, centerP);
      const U = neighborPressureForGradient(p, solid, w, h, i, j - 1, centerP);
      const D = neighborPressureForGradient(p, solid, w, h, i, j + 1, centerP);
      const gradX = axisGradient(L, R);
      const gradY = axisGradient(U, D);
      const open = 1 - solid[n];
      outVx[n] = (vx[n] - gradX) * open;
      outVy[n] = (vy[n] - gradY) * open;
    }
  }
  return { vx: outVx, vy: outVy };
}

/** Mean absolute value — the single number `solveWaterFlowVelocity`'s own
 * `levels[].meanAbsDivergenceBefore/After` trace is built from, and what a
 * future debug report's "did the projection actually do anything" line reads.
 * @param {Float64Array} field
 * @returns {number}
 */
export function meanAbsDivergence(field) {
  if (field.length === 0) return 0;
  let sum = 0;
  for (let n = 0; n < field.length; n++) sum += Math.abs(field[n]);
  return sum / field.length;
}

/**
 * ONE level's own solve: seed → divergence (once) → red-black SOR
 * ×`iterations` → project (once) — Water-Simulation-Turn.md §3's own
 * pseudocode, un-cascaded, with {@link sorPressureStep} standing in for the
 * plan's own literal "Jacobi" since 2026-08-19 (see that function's own doc
 * for why). `initialPressure` is the upsampled result of the previous
 * (coarser) level, or `null` at the coarsest level (a zero field — no prior
 * information exists).
 * @param {object} args
 * @param {Float64Array} args.solid @param {number} args.width @param {number} args.height
 * @param {number} args.dirX @param {number} args.dirY
 * @param {Float64Array|null} args.initialPressure @param {number} args.iterations
 * @param {number} [args.omega] - defaults to {@link WATER_FLOW_SOLVE_OMEGA}.
 * @returns {{vx: Float64Array, vy: Float64Array, p: Float64Array, divergenceBefore: Float64Array}}
 */
export function solveVelocityLevel({
  solid,
  width: w,
  height: h,
  dirX,
  dirY,
  initialPressure,
  iterations,
  omega = WATER_FLOW_SOLVE_OMEGA,
}) {
  const { vx: vx0, vy: vy0 } = seedVelocity(solid, w, h, dirX, dirY);
  const divergenceBefore = computeDivergence(vx0, vy0, w, h);
  let p = initialPressure ?? new Float64Array(w * h);
  const n = Math.max(1, iterations | 0);
  for (let it = 0; it < n; it++) {
    // ONE "iteration" is still one full pass over the WHOLE grid — red half,
    // then black half — matching WATER_FLOW_SOLVE_ITERATIONS_PER_LEVEL's own
    // existing meaning (`sorPressureStep`'s own doc).
    p = sorPressureStep(p, divergenceBefore, solid, w, h, omega, 0);
    p = sorPressureStep(p, divergenceBefore, solid, w, h, omega, 1);
  }
  const { vx, vy } = subtractPressureGradient(vx0, vy0, p, solid, w, h);
  return { vx, vy, p, divergenceBefore };
}

/**
 * THE CASCADE — B3's own "must be coarse-to-fine, not flat Jacobi", run as a
 * sequence of {@link solveVelocityLevel} calls, each level's PRESSURE
 * upsampled ({@link upsampleBilinear}) into the next as its initial guess.
 * `solid` is downsampled fresh from the ORIGINAL finest field at every level
 * ({@link downsampleBoxAverage}) rather than cascaded level-to-level, so a
 * coarse level's own blur never compounds into the next.
 *
 * @param {object} args
 * @param {Float64Array} args.solid - the FINEST level's own solidity field
 *   (S2's own area-averaged bake), row-major, `width*height` long.
 * @param {number} args.width @param {number} args.height - the finest level's
 *   own dimensions — `solid.length` must equal `width*height`.
 * @param {number} args.bearingDeg - compass degrees, `waterFlowVector`'s own
 *   convention (the direction the current travels TO, kinematic not
 *   meteorological — see that function's own doc).
 * @param {ReadonlyArray<number>} [args.levelFractions] - defaults to
 *   {@link WATER_FLOW_SOLVE_LEVEL_FRACTIONS}.
 * @param {number} [args.iterationsPerLevel] - defaults to
 *   {@link WATER_FLOW_SOLVE_ITERATIONS_PER_LEVEL}.
 * @param {number} [args.omega] - the SOR over-relaxation factor, defaults to
 *   {@link WATER_FLOW_SOLVE_OMEGA}. Exposed mainly for tests that need to
 *   compare against `omega=1` (plain checkerboard Gauss-Seidel, no
 *   extrapolation) — production callers should leave this at its default.
 * @returns {{
 *   vx: Float64Array, vy: Float64Array, solid: Float64Array,
 *   width: number, height: number, dirX: number, dirY: number,
 *   levels: Array<{width:number, height:number, meanAbsDivergenceBefore:number, meanAbsDivergenceAfter:number}>,
 * }}
 */
export function solveWaterFlowVelocity({
  solid,
  width,
  height,
  bearingDeg,
  levelFractions = WATER_FLOW_SOLVE_LEVEL_FRACTIONS,
  iterationsPerLevel = WATER_FLOW_SOLVE_ITERATIONS_PER_LEVEL,
  omega = WATER_FLOW_SOLVE_OMEGA,
}) {
  const [dirX, dirY] = waterFlowVector(bearingDeg);
  let prevPressure = null;
  let prevW = 0;
  let prevH = 0;
  let result = null;
  let levelSolid = solid;
  let lw = width;
  let lh = height;
  const levels = [];

  for (const frac of levelFractions) {
    lw = Math.max(WATER_FLOW_SOLVE_MIN_LEVEL_DIM, Math.round(width * frac));
    lh = Math.max(WATER_FLOW_SOLVE_MIN_LEVEL_DIM, Math.round(height * frac));
    levelSolid = lw === width && lh === height ? solid : downsampleBoxAverage(solid, width, height, lw, lh);
    const initialPressure = prevPressure ? upsampleBilinear(prevPressure, prevW, prevH, lw, lh) : null;
    result = solveVelocityLevel({
      solid: levelSolid,
      width: lw,
      height: lh,
      dirX,
      dirY,
      initialPressure,
      iterations: iterationsPerLevel,
      omega,
    });
    levels.push({
      width: lw,
      height: lh,
      meanAbsDivergenceBefore: meanAbsDivergence(result.divergenceBefore),
      meanAbsDivergenceAfter: meanAbsDivergence(computeDivergence(result.vx, result.vy, lw, lh)),
    });
    prevPressure = result.p;
    prevW = lw;
    prevH = lh;
  }

  return { vx: result.vx, vy: result.vy, solid: levelSolid, width: lw, height: lh, dirX, dirY, levels };
}
