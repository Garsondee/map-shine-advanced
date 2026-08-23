/**
 * THE FLOW PACK — `res:waterFlow` (`docs/planning/Water-Simulation-Turn.md` §3
 * Layer B), water's SOLVED velocity field. S2 (this file, first landing) is
 * SOLIDITY only: for each flow texel, how much of it is land, sampled from
 * the full-resolution mask at 16 sub-positions so a rock smaller than one
 * texel still writes a FRACTION instead of vanishing between point samples.
 * S3 adds the pressure-projection velocity solve on top of this same grid.
 *
 * ============================================================================
 * WHY AREA-AVERAGED, AND WHY THIS IS THE ACTUAL SMALL-ROCK FIX
 * ============================================================================
 * Every earlier attempt this session (`WATER_GRID_MAX_DIM` 512→2048, two
 * proximity rings) worked AROUND the same root limitation: a POINT sample at
 * a texel centre either lands on a small feature or it doesn't, at ANY
 * resolution — there is always some rock small enough to fall between two
 * sample points. An AREA average cannot miss a feature that overlaps its
 * sample footprint at all; it can only under- or over-represent it, and 16
 * sub-samples (a 4×4 grid inside the texel) keeps that error small. A rock
 * covering 30% of a texel writes `0.3`, not a coin-flip between `0` and `1`.
 *
 * ============================================================================
 * WHY THIS IS ONE PASS, NOT A FLOOD
 * ============================================================================
 * Solidity is a LOCAL question — "how much land overlaps THIS texel" needs no
 * information from any other texel, unlike the body-pack's distance field
 * (`water-body.js`), which needs the WHOLE flood to answer "how far is the
 * nearest shore". One direct read, no ping-pong.
 *
 * NO RenderTarget, Texture, or renderer-state call lives here — those are
 * walled to `graph/`/`vt/` (`gpu/allocator-only`, `gpu/textures-in-vt-only`,
 * `renderer-state/graph-only`), exactly as `water-body.js`'s own header
 * explains. This module only BUILDS NodeMaterial + QuadMesh objects and hands
 * back the nodes the caller drives. THREE is INJECTED, never imported.
 *
 * @module effects/water/water-flow
 */

import { WATER_PRESENCE_EPS } from './water-body.js';
import { WATER_FLOW_SOLVE_OMEGA } from './water-flow-solve.js';

/** Sub-samples per texel side — 4×4 = 16 total. Matches `docs/planning/Water-
 * Simulation-Turn.md` §3 Layer B1's own worked example exactly; a change here
 * changes what "how much land overlaps this texel" actually measures, so it
 * is named, not a magic loop bound. */
export const WATER_FLOW_SOLIDITY_SUBSAMPLES = 4;

/**
 * Longest side of the flow grid, in texels.
 *
 * ⚠️ RAISED 1024 → 1536, 2026-08-19 — live-reported: "Still lots of examples
 * of horrible texels... sawtooth edges." The author was right and the
 * presence-edge fix from the same round answered a different, already-fixed
 * texture: the water/land BOUNDARY is the full-resolution mask (`mask-
 * image.js`, `MASK_IMAGE_SCALE = 1`, a real, deliberate, dated fix for this
 * EXACT symptom on that texture, 2026-07-26) and was never the bottleneck.
 * This grid is. The reasoning that shipped 1024 — "velocity is a smooth,
 * low-frequency field... no sharp edges except at obstacle boundaries" — was
 * true of its ORIGINAL job (a gentle bend's own foam orientation) and is no
 * longer the whole story now that this same field drives `flowWarp` and the
 * foam flow-nudge (this same day, earlier), both explicitly meant to bend
 * SHARPLY right at an obstacle edge — precisely the frequency this grid was
 * deliberately under-built for. The exact shape of a bug this project has
 * already paid for once, on a DIFFERENT texture (`water-body-subsystem.js`'s
 * own §3: "an extremely pixelated mask which has been blurred... the
 * shoreline looks like a square wave," fixed 2026-07-26 by moving the edge
 * off a coarse derivation grid onto the real one) — the same lesson, one
 * grid over, arriving a few weeks later once THIS grid became load-bearing
 * for the same class of sharp detail.
 *
 * 1536, not full resolution — the author's own explicit instruction ("I'm
 * not suggesting we make the texels full resolution... consider if maybe
 * the current resolution is far too low"). Matches `WATER_BODY_SUPERSAMPLE`'s
 * own already-shipped, already-safe operating point (`water-body.js`,
 * 512×3=1,536) — comfortably under the Keyhole allocator's 2,048px cap with
 * the same margin that grid already runs at, not a fresh, unprecedented
 * number. 1,536 on a 10,650px-wide map is ~6.9 world-px/texel, down from
 * ~10.4 — real cost, stated honestly in `docs/planning/Water-Simulation-
 * Turn.md` §5's own updated budget table, not hidden.
 */
export const WATER_FLOW_GRID_MAX_DIM = 1536;

/**
 * PASS — SOLIDITY. Samples the FULL-RESOLUTION mask (never the coarse
 * derivation grid `WATER_GRID_MAX_DIM` governs — that grid is exactly what a
 * small rock can fall between point-samples of) at a 4×4 sub-grid inside
 * each flow texel's own footprint, and averages presence into a fraction.
 *
 * The flow grid and the mask image cover the IDENTICAL world rect (both are
 * keyed to `waterBody.getRect()` — the same fact `water-render.js`'s own
 * header already verified live: "the mask file is placed exactly like the
 * level background it rides with, which is the same rect the derivation
 * grid covers"). That means flow-grid UV and mask-image UV are the SAME
 * coordinate, so no rect transform is needed here — a real simplification,
 * not an oversight; if the two rects ever diverge this pass breaks loudly
 * (solidity would read shifted relative to the visible water), not silently.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.maskTexture - the FULL-RESOLUTION mask image texture
 *   (`water-surface-subsystem.js`'s own `loadMaskImage` result — NOT
 *   `water-body-subsystem.js`'s coarse derived-grid texture).
 * @param {number} args.width @param {number} args.height - the FLOW grid's
 *   own texel dimensions (`WATER_FLOW_GRID_MAX_DIM`-derived), used only to
 *   size one texel's sub-sample footprint in mask UV.
 * @returns {{material:*, quad:*}}
 */
export function buildWaterSoliditySeedMaterial({ THREE, maskTexture, width, height }) {
  const { texture, uv, vec2, vec4, float, step } = THREE.TSL;

  const texelU = 1 / Math.max(1, width);
  const texelV = 1 / Math.max(1, height);
  const sub = WATER_FLOW_SOLIDITY_SUBSAMPLES;
  const uv0 = uv();

  let solid = float(0);
  for (let sy = 0; sy < sub; sy++) {
    for (let sx = 0; sx < sub; sx++) {
      // Sub-sample centres, evenly spaced across THIS texel's own footprint —
      // (sx+0.5)/sub runs 0..1 across the texel, minus 0.5 to centre the
      // whole 4×4 grid on the texel centre, times the texel's own UV size.
      const offsetU = ((sx + 0.5) / sub - 0.5) * texelU;
      const offsetV = ((sy + 0.5) / sub - 0.5) * texelV;
      const sampleUv = uv0.add(vec2(offsetU, offsetV));
      const maskR = texture(maskTexture, sampleUv).r;
      // Same presence floor the body-pack's own seed pass uses
      // (`WATER_PRESENCE_EPS`, reused rather than a second copy) — any real
      // painted depth at all counts as water; below it is land.
      const isLand = float(1).sub(step(float(WATER_PRESENCE_EPS), maskR));
      solid = solid.add(isLand);
    }
  }
  solid = solid.div(float(sub * sub));

  const material = new THREE.NodeMaterial();
  // R = solidity (0 open water .. 1 fully solid); GBA reserved for S3's
  // velocity (RG) and speed01 (B) — declared here so the channel LAYOUT is
  // fixed from solidity's own first landing and S3 does not have to
  // renegotiate what R already means.
  material.fragmentNode = vec4(solid, 0, 0, 1);
  const quad = new THREE.QuadMesh(material);
  return { material, quad };
}

/**
 * PASS — SOLIDITY, COARSER LEVELS. A 2×2 box average of the NEXT-FINER
 * level's own solidity — never a second independent re-sample of the raw
 * mask at this level's own (coarser) resolution.
 *
 * ============================================================================
 * ⚠️ WHY THIS EXISTS — A REAL BUG, LIVE-REPORTED 2026-08-18
 * ============================================================================
 * The FIRST version of the cascade re-ran {@link buildWaterSoliditySeedMaterial}
 * independently at EVERY level's own resolution, each sampling the RAW mask
 * image directly with the SAME fixed 16 sub-samples
 * (`WATER_FLOW_SOLIDITY_SUBSAMPLES`). That sample count was sized for the
 * FINEST level, where one flow texel covers a small patch of the mask. At
 * the COARSEST level (1/16 the finest — e.g. 64px wide against a 1024px
 * finest and a mask that may be several times finer STILL), one flow texel
 * can cover a MUCH larger patch of the source mask, and 16 sparse samples
 * across that much bigger footprint is a real undersampling — exactly the
 * kind of thing that produces a coherent, repeating alias pattern rather
 * than random noise, because the sample OFFSETS are locked to the texel
 * grid itself. Author-reported: a faint but consistent directional tint on
 * the `flowVelocity` debug channel, present broadly (not local to any
 * painted obstacle) and unchanged at a different point on the same river —
 * a signature that does not fit "responding to real geometry" (which should
 * vary with position) and does not fit floating-point noise (unaffected by
 * a half→full float precision change, tested live). It DOES fit a
 * structural bias baked into the COARSEST level (which the whole cascade's
 * pressure solve starts from as its initial guess, `water-flow-subsystem.js`'s
 * own header) from undersampling that level's own, much larger, footprint.
 *
 * The fix matches `water-flow-solve.js#downsampleBoxAverage` — the CPU
 * reference's OWN, already-proven approach — exactly: never re-sample the
 * raw source at a coarse level's own low resolution; average DOWN from the
 * next-finer level's own (properly-sampled) result instead. Because every
 * cascade fraction is exactly half the next (`WATER_FLOW_SOLVE_LEVEL_
 * FRACTIONS`), one destination texel's footprint in the finer source is
 * EXACTLY a 2×2 block — an exhaustive, not sparse, average.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.sourceTexture - the NEXT-FINER level's own solidity (R).
 * @param {number} args.sourceWidth @param {number} args.sourceHeight - the
 *   SOURCE's own texel dimensions (i.e. the finer level's, not this one's).
 * @returns {{material:*, quad:*}}
 */
export function buildWaterSolidityDownsampleMaterial({ THREE, sourceTexture, sourceWidth, sourceHeight }) {
  const { texture, uv, vec2, vec4, float } = THREE.TSL;
  const texelU = 1 / Math.max(1, sourceWidth);
  const texelV = 1 / Math.max(1, sourceHeight);
  const uv0 = uv();

  // The four SOURCE texel centres inside this (coarser) texel's own
  // footprint — ±0.5 source-texels either side of this fragment's own UV,
  // which is exactly right because the source is precisely 2× finer.
  let sum = float(0);
  for (const [ox, oy] of [
    [-0.5, -0.5],
    [0.5, -0.5],
    [-0.5, 0.5],
    [0.5, 0.5],
  ]) {
    const sampleUv = uv0.add(vec2(ox * texelU, oy * texelV));
    sum = sum.add(texture(sourceTexture, sampleUv).r);
  }
  const solid = sum.div(float(4));

  const material = new THREE.NodeMaterial();
  material.fragmentNode = vec4(solid, 0, 0, 1);
  const quad = new THREE.QuadMesh(material);
  return { material, quad };
}

// ============================================================================
// S3 — THE VELOCITY SOLVE (B2–B4). Ported from `water-flow-solve.js`'s own
// CPU reference, function-for-function, AFTER that file's own Node tests
// caught and fixed a real bug (see its header) — porting BEFORE that would
// have shipped the bug in a shader instead of catching it in Node.
// ============================================================================

/**
 * A neighbour sample for a DISTANCE-AWARE central difference — the TSL twin
 * of `water-flow-solve.js#blendedNeighbor`/`neighborPressureForGradient`, and
 * the reason this exists at all is the SAME bug that file's own header names
 * in full: a Neumann-mirrored (solid) ghost sits at effective distance ZERO,
 * not one cell, so a fixed `/2` central-difference divisor silently HALVES
 * the result near any obstacle. Reused for THREE different callers below —
 * divergence, the Jacobi update, and the final pressure-gradient projection
 * — each parameterising the two axes that actually differ between them:
 *
 *   `solidityTex` — `null` for {@link buildWaterDivergenceMaterial} (raw
 *   velocity, deliberately NOT solid-aware — see that function's own doc for
 *   the live experiment that proved blending it away makes obstacles
 *   invisible to the solver); the level's own solidity texture for the
 *   Jacobi and projection passes (Neumann blend toward the centre).
 *
 *   `offGridIsGhost` — `true` for divergence (an off-grid neighbour mirrors
 *   the CENTRE's own value at distance 0, which is what reproduces
 *   `computeDivergence`'s one-sided edge formula exactly — verified by hand
 *   in the CPU reference before this port); `false` for pressure (an
 *   off-grid neighbour is the REAL Dirichlet value `0` at a REAL distance of
 *   1 — `water-flow-solve.js#neighborPressureForGradient`'s own doc).
 *
 * The off-grid test itself is `water-body.js#buildWaterJfaStepMaterial`'s own
 * idiom (clamp the sample UV, then measure the clamp's own delta scaled hard
 * into a crisp 0/1) — reused rather than reinvented, because it is already
 * this codebase's proven-safe way to ask "was this sample off the grid"
 * without a comparison operator on a TSL node.
 *
 * @param {object} TSL @param {*} uv0 @param {number} texelU @param {number} texelV
 * @param {number} dx @param {number} dy @param {*} tex @param {'r'|'g'} channel
 * @param {*} centerValue @param {*|null} solidityTex @param {boolean} offGridIsGhost
 * @returns {{value: *, distance: *, texNode: *}} `texNode` is the raw sampled
 *   node — a PING-PONGING caller (the Jacobi step) must collect it into its
 *   own `prevTexNodes` array; a fixed-input caller (divergence, projection)
 *   does not need to.
 */
function neighborForAxisGradient(
  TSL,
  uv0,
  texelU,
  texelV,
  dx,
  dy,
  tex,
  channel,
  centerValue,
  solidityTex,
  offGridIsGhost
) {
  const { texture, vec2, clamp, length, float, mix } = TSL;
  const rawUv = uv0.add(vec2(dx * texelU, dy * texelV));
  const clampedUv = clamp(rawUv, vec2(0, 0), vec2(1, 1));
  const offGrid = clamp(length(rawUv.sub(clampedUv)).mul(float(1e6)), float(0), float(1));
  const texNode = texture(tex, clampedUv);
  const raw = channel === 'g' ? texNode.g : texNode.r;

  let value = raw;
  let distance = float(1);
  if (solidityTex) {
    const s = texture(solidityTex, clampedUv).r;
    value = mix(raw, centerValue, s);
    distance = float(1).sub(s);
  }

  if (offGridIsGhost) {
    value = mix(value, centerValue, offGrid);
    distance = mix(distance, float(0), offGrid);
  } else {
    value = mix(value, float(0), offGrid);
    distance = mix(distance, float(1), offGrid);
  }
  return { value, distance, texNode };
}

/**
 * One axis of a central difference: `(posSide.value - negSide.value) / span`,
 * `span` being the two sides' own EFFECTIVE distances added together — never
 * a hardcoded 2. The TSL twin of `water-flow-solve.js#axisGradient`; see that
 * function's own doc for why a fixed divisor is the bug this avoids, and
 * `neighborForAxisGradient`'s own doc for where `.distance` comes from.
 * `max(span, eps)` keeps the divide finite even when both sides are ghosts
 * (span≈0); `step(eps, span)` then zeroes the whole result in that case —
 * there is no real sample on EITHER side to estimate a slope from, and this
 * is a divide-by-zero GUARD, not an approximation of a real answer.
 * @param {object} TSL @param {{value:*, distance:*}} negSide @param {{value:*, distance:*}} posSide
 * @returns {*}
 */
function axisGradientTSL(TSL, negSide, posSide) {
  const { float, max, step } = TSL;
  const span = negSide.distance.add(posSide.distance);
  const safeSpan = max(span, float(1e-6));
  const raw = posSide.value.sub(negSide.value).div(safeSpan);
  const validSpan = step(float(1e-6), span);
  return raw.mul(validSpan);
}

/**
 * B2 — THE SEED. `v = current × (1 − solid)` — full bulk speed in open
 * water, zero inside a fully solid texel, a FRACTION for a partially
 * obstructed one (S2's own continuous solidity carried straight through,
 * never re-thresholded — `water-flow-solve.js#seedVelocity`'s own doc).
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.solidityTexture - THIS level's own solidity pack (S2).
 * @param {*} args.uDir - a SHARED `uniform(vec2(dirX,dirY))` node, built ONCE
 *   by the caller (`waterFlowVector(bearingDeg)`'s own CPU output — never
 *   `cos`/`sin` in the shader, this project's own five-times-bitten Y-flip
 *   rule) and passed into every level's own seed material, so ONE `.value`
 *   write updates every level's seed at once on a bulk-direction param change.
 * @returns {{material:*, quad:*, solidTexNode:*}} `solidTexNode` is re-pointed
 *   by the caller only if the SAME level's solidity texture object changes
 *   identity (a regrid) — never on a param-only change, which only touches
 *   `uDir.value`.
 */
export function buildWaterVelocitySeedMaterial({ THREE, solidityTexture, uDir }) {
  const { texture, uv, vec4, float } = THREE.TSL;
  const solidTexNode = texture(solidityTexture, uv());
  const open = float(1).sub(solidTexNode.r);
  const velocity = uDir.mul(open);

  const material = new THREE.NodeMaterial();
  material.fragmentNode = vec4(velocity.x, velocity.y, 0, 1);
  const quad = new THREE.QuadMesh(material);
  return { material, quad, solidTexNode };
}

/**
 * B3 line 1 — DIVERGENCE. The TSL twin of
 * `water-flow-solve.js#computeDivergence`, via {@link neighborForAxisGradient}
 * with `solidityTex: null` (raw velocity — see that function's own doc for
 * why) and `offGridIsGhost: true` (reproduces the CPU reference's own
 * one-sided edge formula exactly, verified there before this port).
 *
 * @param {object} args
 * @param {*} args.THREE @param {*} args.velocityTexture - THIS level's own seed
 *   velocity (RG). Fixed for the whole level's Jacobi loop — read once here,
 *   never re-sampled per iteration.
 * @param {number} args.width @param {number} args.height - THIS level's own
 *   texel dimensions, baked in at build time (the grid regrids, never the
 *   material — `ensureTarget`'s own discipline, mirrored one level up).
 * @returns {{material:*, quad:*}}
 */
export function buildWaterDivergenceMaterial({ THREE, velocityTexture, width, height }) {
  const { texture, uv, vec4 } = THREE.TSL;
  const texelU = 1 / Math.max(1, width);
  const texelV = 1 / Math.max(1, height);
  const uv0 = uv();

  // The ghost value for an OFF-GRID neighbour is THIS FRAGMENT's own velocity
  // component (`neighborForAxisGradient`'s `offGridIsGhost: true` path) — a
  // literal zero would silently drop every edge texel's `-v[i]` term instead
  // of reproducing the one-sided formula.
  const center = texture(velocityTexture, uv0);
  const negX = neighborForAxisGradient(
    THREE.TSL,
    uv0,
    texelU,
    texelV,
    -1,
    0,
    velocityTexture,
    'r',
    center.r,
    null,
    true
  );
  const posX = neighborForAxisGradient(
    THREE.TSL,
    uv0,
    texelU,
    texelV,
    1,
    0,
    velocityTexture,
    'r',
    center.r,
    null,
    true
  );
  const negY = neighborForAxisGradient(
    THREE.TSL,
    uv0,
    texelU,
    texelV,
    0,
    -1,
    velocityTexture,
    'g',
    center.g,
    null,
    true
  );
  const posY = neighborForAxisGradient(
    THREE.TSL,
    uv0,
    texelU,
    texelV,
    0,
    1,
    velocityTexture,
    'g',
    center.g,
    null,
    true
  );

  const dvx = axisGradientTSL(THREE.TSL, negX, posX);
  const dvy = axisGradientTSL(THREE.TSL, negY, posY);
  const divergence = dvx.add(dvy);

  const material = new THREE.NodeMaterial();
  material.fragmentNode = vec4(divergence, 0, 0, 1);
  const quad = new THREE.QuadMesh(material);
  return { material, quad };
}

/**
 * B3 line 2, SOR VARIANT (2026-08-19) — ONE CHECKERBOARD HALF-STEP, run
 * TWICE per "iteration" (`uParity` 0 then 1) — the TSL twin of
 * `water-flow-solve.js#sorPressureStep`. See that function's own doc for the
 * full account of WHY (plain Jacobi's own convergence rate for large-scale,
 * whole-field routing corrections scales `O(1/N^2)` — measured, not
 * assumed, as the live-reported "10× more iterations, almost no change"
 * symptom `docs/planning/Water-Simulation-Turn.md`'s S3-continued entry
 * documents) and HOW (a 5-point stencil's own structure means every cell's
 * four neighbours are ALWAYS the opposite checkerboard colour, so updating
 * one whole colour per render has zero read/write conflicts — exactly as
 * parallel as plain Jacobi, with the fresh-neighbour-data benefit
 * checkerboard Gauss-Seidel has, before `uOmega` extrapolates further).
 *
 * ⚠️ NO `select()`, NO `.mix()` — this codebase's own named traps
 * (`feedback_tsl_select_chain_strands_vars`,
 * `reference_tsl_method_chaining_trap` — `a.mix(b,t)` computes `mix(b,t,a)`,
 * backwards from what the receiver syntax suggests at a glance). The
 * checkerboard mask is plain arithmetic instead: `isActive = 1 −
 * |parity − uParity|` is exactly 1 when this texel's own `(x+y)%2` matches
 * `uParity` and exactly 0 otherwise (both operands are always 0 or 1, so
 * their difference is always 0 or ±1) — then `centre + (sorValue − centre) ×
 * isActive` is `sorValue` when active and `centre` (copied through
 * unchanged — this pass has nothing new to say about the OTHER colour) when
 * not, with nothing to misremember about argument order.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.prevPressureTexture - the ping-pong source for this
 *   half-step: THIS level's own other ping-pong target for later half-steps,
 *   or the PREVIOUS (coarser) level's finished pack for the very first one —
 *   sampled here by plain bilinear `texture()`, which is the entire
 *   multigrid "prolongation" step (no dedicated upsample pass exists or is
 *   needed: a GPU sampler upsamples for free when its source is smaller than
 *   the render target it is being read into).
 * @param {*} args.divergenceTexture - fixed for the whole level (computed
 *   once, before the SOR loop starts).
 * @param {*} args.solidityTexture - THIS level's own solidity pack (S2), also
 *   fixed for the whole level.
 * @param {number} args.width @param {number} args.height - THIS level's own
 *   texel dimensions.
 * @returns {{material:*, quad:*, prevTexNodes:Array<*>, uParity:*, uOmega:*}}
 *   EVERY node in `prevTexNodes` (the centre read PLUS all 4 neighbour reads)
 *   must be re-pointed together before each render — `water-body.js`'s own
 *   `prevTexNodes` doc has the full citation for why a single `.uv()` chain
 *   method does not exist on a TextureNode in this vendored build.
 *   `uParity` MUST be set (0 then 1) before each of the two half-step
 *   renders that make up one caller-visible "iteration"
 *   (`water-flow-subsystem.js#runLevel`'s own loop) — unlike `prevTexNodes`,
 *   it does not need re-pointing every render, only toggling.
 */
export function buildWaterJacobiStepMaterial({
  THREE,
  prevPressureTexture,
  divergenceTexture,
  solidityTexture,
  width,
  height,
}) {
  const { texture, uv, vec4, float, uniform, floor, abs } = THREE.TSL;
  const texelU = 1 / Math.max(1, width);
  const texelV = 1 / Math.max(1, height);
  const uv0 = uv();
  const uOmega = uniform(float(WATER_FLOW_SOLVE_OMEGA));
  const uParity = uniform(float(0));

  const centerNode = texture(prevPressureTexture, uv0);
  const prevTexNodes = [centerNode];
  const centerP = centerNode.r;
  const divergence = texture(divergenceTexture, uv0).r;

  function neighbor(dx, dy) {
    const result = neighborForAxisGradient(
      THREE.TSL,
      uv0,
      texelU,
      texelV,
      dx,
      dy,
      prevPressureTexture,
      'r',
      centerP,
      solidityTexture,
      false
    );
    prevTexNodes.push(result.texNode);
    return result.value;
  }

  const pL = neighbor(-1, 0);
  const pR = neighbor(1, 0);
  const pU = neighbor(0, -1);
  const pD = neighbor(0, 1);
  const jacobiAvg = pL.add(pR).add(pU).add(pD).sub(divergence).mul(float(0.25));
  const sorValue = centerP.add(jacobiAvg.sub(centerP).mul(uOmega));

  // Pixel-centre sampling (`(x+0.5)/width`) means `uv0.x * width` never sits
  // exactly on an integer boundary — `floor` recovers the true integer texel
  // coordinate with no rounding hazard, the same trick this file's own
  // neighbour-offset math already relies on via `texelU`/`texelV` steps.
  const texelX = floor(uv0.x.mul(float(width)));
  const texelY = floor(uv0.y.mul(float(height)));
  const parity = texelX.add(texelY).mod(float(2));
  const isActive = float(1).sub(abs(uParity.sub(parity)));
  const nextPressure = centerP.add(sorValue.sub(centerP).mul(isActive));

  const material = new THREE.NodeMaterial();
  material.fragmentNode = vec4(nextPressure, 0, 0, 1);
  const quad = new THREE.QuadMesh(material);
  return { material, quad, prevTexNodes, uParity, uOmega };
}

/** Ceiling `speed01` (B4's own packed channel) normalises against, as a
 * multiple of the bulk free-stream speed — NOT 1.0, because flow genuinely
 * ACCELERATES beside an obstacle (potential-flow theory: up to 2× at a
 * cylinder's own "equator"; this project's own CPU-reference tests measured
 * >1.05× on a modest fixture). A ceiling of exactly 1 would clip every
 * accelerated texel to flat white; 2.5 leaves real headroom without wasting
 * most of the 0..1 range on values a real river rarely reaches. A named
 * constant, not a live per-scene uniform — `speed01` is a ROUTING signal for
 * future foam/swash consumers (S4+), not a display remap, so it does not need
 * to be author-tunable to be correct. */
export const WATER_FLOW_SPEED01_HEADROOM = 2.5;

/**
 * B3 line 3 — THE PROJECTION — AND B4 — THE PACK, in one pass: this level's
 * FINAL, consumer-facing texture. The TSL twin of
 * `water-flow-solve.js#subtractPressureGradient`, via
 * {@link neighborForAxisGradient} + {@link axisGradientTSL} (the SAME
 * distance-aware gradient the Jacobi step deliberately does NOT use — see
 * that function's own doc for why the two callers differ) — this is the
 * actual site of the halving bug the CPU reference caught before it ever
 * reached a shader.
 *
 * Output layout (`docs/planning/Water-Simulation-Turn.md` §3 B4, RECONCILED
 * here with S2's own solidity-in-R intermediate — that texture stays exactly
 * as S2 built it, an internal per-level input to this pass, never the
 * consumer-facing product; THIS pass's own output is what `res:waterFlow`
 * actually means from S3 onward):
 *
 *   RG  velocity, NORMALISED (bulk free-stream speed = 1.0 — this solve has
 *       no notion of world px/sec at all, matching
 *       `water-flow-solve.js#solveWaterFlowVelocity`'s own `bearingDeg`-only
 *       signature; a real-world scale is a CONSUMER-side multiply by the
 *       author's own `flowSpeedPx` param, applied at read time, never baked
 *       in here)
 *   B   speed01 — `clamp(length(velocity) / WATER_FLOW_SPEED01_HEADROOM, 0, 1)`
 *   A   solidity, copied straight through from this level's own S2 pack —
 *       so a single texture fetch downstream gets velocity AND "is this
 *       texel land" together, without a second bind.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.seedVelocityTexture - THIS level's own B2 seed (RG), fixed.
 * @param {*} args.pressureTexture - THIS level's own FINAL, converged
 *   pressure (the Jacobi loop's last output) — read, never ping-ponged
 *   WITHIN this pass, but see `pressureTexNodes` below for why the CALLER
 *   still has a one-time re-point to do.
 * @param {*} args.solidityTexture - THIS level's own solidity pack (S2).
 * @param {number} args.width @param {number} args.height
 * @returns {{material:*, quad:*, pressureTexNodes:Array<*>}}
 *   ⚠️ `pressureTexNodes` (the centre read PLUS all 4 neighbour reads, five
 *   total) MUST be re-pointed together, ONCE, after the Jacobi loop finishes
 *   — this material is built BEFORE that loop runs (so its constructor
 *   argument is necessarily a placeholder-ish initial texture, same as the
 *   Jacobi material's own `prevPressureTexture`), and the loop's actual
 *   FINAL target (ping or pong) is not knowable until the last iteration has
 *   run. A single re-point, not a ping-pong — this pass itself never writes
 *   to the texture it reads, unlike the Jacobi step.
 */
export function buildWaterProjectPackMaterial({
  THREE,
  seedVelocityTexture,
  pressureTexture,
  solidityTexture,
  width,
  height,
}) {
  const { texture, uv, vec2, vec4, float, length, clamp } = THREE.TSL;
  const texelU = 1 / Math.max(1, width);
  const texelV = 1 / Math.max(1, height);
  const uv0 = uv();

  const seedNode = texture(seedVelocityTexture, uv0);
  const solidNode = texture(solidityTexture, uv0);
  const centerNode = texture(pressureTexture, uv0);
  const pressureTexNodes = [centerNode];
  const centerP = centerNode.r;

  function neighbor(dx, dy) {
    const result = neighborForAxisGradient(
      THREE.TSL,
      uv0,
      texelU,
      texelV,
      dx,
      dy,
      pressureTexture,
      'r',
      centerP,
      solidityTexture,
      false
    );
    pressureTexNodes.push(result.texNode);
    return result;
  }

  const gradX = axisGradientTSL(THREE.TSL, neighbor(-1, 0), neighbor(1, 0));
  const gradY = axisGradientTSL(THREE.TSL, neighbor(0, -1), neighbor(0, 1));

  // Re-masked by `(1 - solid)` — the SAME zeroing B2 applies, reapplied here
  // because the pressure gradient alone has no reason to land exactly on
  // zero inside a solid texel (its neighbours' real pressures still leak in
  // through the Neumann blend) — `water-flow-solve.js#subtractPressureGradient`'s
  // own doc names this explicitly.
  const open = float(1).sub(solidNode.r);
  const vx = seedNode.r.sub(gradX).mul(open);
  const vy = seedNode.g.sub(gradY).mul(open);
  const speed01 = clamp(length(vec2(vx, vy)).div(float(WATER_FLOW_SPEED01_HEADROOM)), float(0), float(1));

  const material = new THREE.NodeMaterial();
  material.fragmentNode = vec4(vx, vy, speed01, solidNode.r);
  const quad = new THREE.QuadMesh(material);
  return { material, quad, pressureTexNodes };
}
