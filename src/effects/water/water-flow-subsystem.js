/**
 * THE FLOW-PACK SUBSYSTEM — owns `res:waterFlow`'s render targets (one FULL
 * SET per cascade level), decides WHEN the solve reruns, reports what it did
 * (`docs/planning/Water-Simulation-Turn.md` §3 Layer B / §4 S2–S3).
 *
 * `water-flow.js` builds the five per-level materials (solidity seed,
 * velocity seed, divergence, Jacobi step, project+pack); this drives them
 * through the coarse-to-fine cascade `water-flow-solve.js`'s own CPU
 * reference proved out FIRST. The split is `water-body.js` ↔
 * `water-body-subsystem.js`, exactly.
 *
 * ============================================================================
 * WHY THIS REBUILDS INSTEAD OF RE-POINTING — LEARNED THE EXPENSIVE WAY, ONCE
 * ============================================================================
 * `water-surface-subsystem.js` builds its material against a 1×1 placeholder
 * and re-points ONE node when the real mask loads — and a second, forgotten
 * node sampling that same placeholder forever is exactly what turned the
 * author's river white the same day this file was written
 * (`feedback_texture_nodes_must_be_repointed_together`). `maybeBake` never
 * builds a single level's materials until `waterSurface.getFullResMaskTexture()`
 * already returns a REAL texture, and — S3's own addition — EVERY level's
 * FULL material set is rebuilt fresh, together, on ANY bake trigger (mask
 * identity, bulk flow direction, or a regrid) rather than re-pointed
 * piecemeal. The one exception, and it is a re-point rather than a rebuild
 * on purpose: the Jacobi step's own pressure ping-pong, and the project pass's
 * one-time "which target did the loop finish on" resolve — both documented
 * at their own call sites below, because a ping-pong is what re-pointing was
 * always meant for (`water-body.js#runFlood`'s own JFA loop is the precedent).
 *
 * ============================================================================
 * WHY THE GPU CALLS ARE INJECTED
 * ============================================================================
 * Same reasoning as `water-body-subsystem.js` §2 — `renderer-state/graph-only`
 * and `gpu/textures-in-vt-only` allow the literal calls only inside `vt/`.
 * `renderWaterPass` here is the SAME generic save/bind/render/restore
 * triplet the body pack already uses, reused rather than duplicated: it was
 * never body-pack-specific, only body-pack-first.
 *
 * ============================================================================
 * WHY THIS TAKES SIBLING HANDLES, NOT A FLOORINDEX
 * ============================================================================
 * `waterBodiesByFloor`/`waterSurfacesByFloor` in `vt-pan-viewer.js` fixed
 * `feedback_single_floor_bake_vs_multi_floor_render` by giving each floor its
 * OWN subsystem instance rather than one shared instance re-pointed at
 * whichever floor is "current" — a single instance juggling floors is the
 * exact shape of the bug that fix retired. This subsystem follows the SAME
 * rule from its first line: one instance per floor (wired into a matching
 * `waterFlowsByFloor` map), constructed with THAT floor's own `waterSurface`
 * and `waterBody` handles already resolved — mirroring how
 * `createWaterSurfaceSubsystem` itself takes `waterBody` wholesale rather
 * than a `getRect`/`getTexture` callback pair. `maybeBake()` therefore takes
 * no floor argument: there is nothing left to ask "which floor" about, and
 * the flow pack inherits whatever cross-floor borrow decision `waterSurface`
 * already made for this slot, by construction, rather than re-resolving it.
 *
 * ============================================================================
 * WHY THE SOLVE HAS NO NOTION OF `flowSpeedPx`
 * ============================================================================
 * B2's seed reads `waterFlowVector(bearingDeg)` — a UNIT vector, magnitude
 * always 1, matching `water-flow-solve.js#solveWaterFlowVelocity`'s own
 * `bearingDeg`-only signature exactly (that file's Node tests are what this
 * port is checked against; giving the shader a DIFFERENT input shape than
 * the tests exercised would make the tests prove nothing about the port).
 * The whole cascade therefore solves in NORMALISED units — free-stream
 * speed = 1.0 — and `res:waterFlow`'s own B4 pack doc names the consequence:
 * a real-world px/sec scale is a CONSUMER-side multiply by the author's own
 * `flowSpeedPx`, applied wherever a future term (S4+) reads this pack, never
 * baked in here. Bulk DIRECTION (`bearingDeg`) genuinely changes the
 * SOLVE's own routing and is therefore a bake trigger, tracked by
 * `boundBearingDeg`; bulk SPEED changes nothing about routing and is
 * therefore NOT tracked here at all.
 *
 * @module effects/water/water-flow-subsystem
 */

import {
  buildWaterSoliditySeedMaterial,
  buildWaterVelocitySeedMaterial,
  buildWaterDivergenceMaterial,
  buildWaterJacobiStepMaterial,
  buildWaterProjectPackMaterial,
  WATER_FLOW_GRID_MAX_DIM,
} from './water-flow.js';
import {
  WATER_FLOW_SOLVE_LEVEL_FRACTIONS,
  WATER_FLOW_SOLVE_ITERATIONS_PER_LEVEL,
  WATER_FLOW_SOLVE_MIN_LEVEL_DIM,
} from './water-flow-solve.js';
import { waterFlowVector } from './water-field.js';

/**
 * Size the FINEST level's own grid over a world rect — the SAME trivial,
 * aspect-preserving formula `scene/mask-derive.js#computeMaskGridSpec` uses,
 * duplicated rather than imported: effects-zone subsystems do not reach into
 * `scene/` directly (`water-body-subsystem.js` does not either — grep its
 * own imports), and this is four lines, not a shared algorithm worth a new
 * cross-zone dependency over.
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} rect
 * @returns {{w:number,h:number}}
 */
function sizeFlowGrid(rect) {
  const width = Math.max(1, rect.maxX - rect.minX);
  const height = Math.max(1, rect.maxY - rect.minY);
  const scale = WATER_FLOW_GRID_MAX_DIM / Math.max(width, height);
  return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) };
}

/**
 * Every coarser level's own dimensions are a FRACTION of the finest level's
 * — never cascaded level-to-level (each level's solidity is re-derived fresh
 * from the ORIGINAL mask, `water-flow-solve.js`'s own CPU reference doc
 * explains why: "a coarse level's own blur never compounds into the next").
 * @param {number} finestW @param {number} finestH @param {number} fraction
 * @returns {{w:number,h:number}}
 */
function levelDims(finestW, finestH, fraction) {
  return {
    w: Math.max(WATER_FLOW_SOLVE_MIN_LEVEL_DIM, Math.round(finestW * fraction)),
    h: Math.max(WATER_FLOW_SOLVE_MIN_LEVEL_DIM, Math.round(finestH * fraction)),
  };
}

/**
 * @param {object} args
 * @param {*} args.THREE
 * @param {{create: Function, dispose: Function}} args.allocator - `graph/three-allocator.js`.
 * @param {{getFullResMaskTexture: () => *|null}} args.waterSurface - THIS
 *   floor's own `createWaterSurfaceSubsystem()` handle. `getFullResMaskTexture()`
 *   returns `null` until a real image has loaded — never a placeholder, by
 *   that function's own contract.
 * @param {{getRect: () => {minX:number,minY:number,maxX:number,maxY:number}}} args.waterBody -
 *   THIS floor's own `createWaterBodySubsystem()` handle, read only for
 *   `getRect()` — the SAME world rect the mask image and the body-pack SDF
 *   both already align to.
 * @param {(target: *, quad: *) => void} args.renderWaterPass - the literal
 *   save/bind/render/restore triplet, defined in `vt/` (see this module's
 *   own header).
 * @param {(data: Uint8Array, w: number, h: number, filter: string) => *} args.createFlowTexture -
 *   the literal `new THREE.DataTexture(...)`, defined in `vt/` (trap #5,
 *   `water-body-subsystem.js`'s own citation) — used ONLY to build the
 *   1×1 all-zero pressure placeholder the coarsest level's first Jacobi
 *   iteration reads as "no prior information exists yet".
 * @param {() => {params?: object}} [args.getWaterRenderState] - the SAME seam
 *   `water-surface-subsystem.js` already receives, read here only for
 *   `params.flowAngleDeg` — the bulk direction the whole cascade seeds from.
 * @returns {{
 *   texture: *,
 *   maybeBake: () => void,
 *   getStatus: () => object,
 *   dispose: () => void,
 * }}
 */
export function createWaterFlowSubsystem({
  THREE,
  allocator,
  waterSurface,
  waterBody,
  renderWaterPass,
  createFlowTexture,
  getWaterRenderState,
}) {
  getWaterRenderState ??= () => ({ params: {} });

  const { uniform, vec2 } = THREE.TSL;
  /** Shared across EVERY level's own velocity-seed material — one `.value`
   * write updates all five at once on a bulk-direction change. */
  const uDir = uniform(vec2(0, -1));

  /** The coarsest level's own Jacobi seed — "no prior information exists" —
   * built ONCE, disposed only in this subsystem's own `dispose()`. */
  const zeroPressureTexture = createFlowTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, 'linear');

  /** `WxH` of the FINEST level — '' = never baked. */
  let gridKey = '';
  /** One entry per `WATER_FLOW_SOLVE_LEVEL_FRACTIONS`, coarsest first. Empty
   * until the first successful bake. */
  let levels = [];

  let boundMaskTexture = null;
  let boundBearingDeg = null;

  let bakes = 0;
  let polls = 0;
  let pollsSinceLastBake = 0;
  let lastBake = null;

  function disposeLevels() {
    for (const level of levels) {
      allocator.dispose(level.solidityRt);
      allocator.dispose(level.velocitySeedRt);
      allocator.dispose(level.divergenceRt);
      allocator.dispose(level.pressurePingRt);
      allocator.dispose(level.pressurePongRt);
      allocator.dispose(level.packRt);
      level.soliditySeed.material?.dispose?.();
      level.velocitySeed.material?.dispose?.();
      level.divergence.material?.dispose?.();
      level.jacobi.material?.dispose?.();
      level.pack.material?.dispose?.();
    }
    levels = [];
  }

  /**
   * Allocate this level's six targets and build its five materials, fresh —
   * called once per level on every full rebuild (never re-pointed; see this
   * module's own header for why).
   * @param {number} index @param {number} w @param {number} h @param {*} maskTexture
   * @returns {object}
   */
  function buildLevel(index, w, h, maskTexture) {
    const name = (suffix) => `water.flow.L${index}.${suffix}`;
    // LINEAR throughout — every one of these six is a smoothly-varying
    // scalar/vector field (solidity, velocity, divergence, pressure, the
    // final pack), nothing like the body pack's own NEAREST JFA ping-pong
    // pair, which stores mid-flood offset VECTORS that must never blend.
    //
    // ⚠️ FULL `FloatType`, NOT `HalfFloatType` — every other bake in this
    // codebase uses half float and that is right for THEM (one pass, or a
    // handful of JFA rounds); this pack is different in a way that matters:
    // the pressure ping-pong reads-and-writes itself
    // `WATER_FLOW_SOLVE_ITERATIONS_PER_LEVEL` times PER LEVEL, and the
    // 5-level cascade then feeds each level's result into the next as an
    // initial guess — a hundred-odd read/round/write passes total, per bake.
    // Live-suspected 2026-08-18: the author reported a faint but CONSISTENT
    // directional tint on the `flowVelocity` debug channel, unrelated to any
    // painted obstacle and unchanged at a different point on the same river
    // — exactly the fingerprint of a numerical artifact baked into the solve
    // itself rather than a local, geometry-driven one. The standard 5-point
    // Jacobi stencil this solve uses has a well-known CHECKERBOARD null
    // space (an alternating +/-δ pattern that the operator itself cannot
    // see, so nothing damps it once seeded) — half float's own ~3-decimal-
    // digit precision is a plausible seed for exactly that, repeated across
    // ~100 passes. The CPU reference (`water-flow-solve.js`, full float64)
    // was re-run at PRODUCTION scale (1024×476, a real obstacle) as part of
    // diagnosing this and stayed completely clean — symmetric routing, zero
    // drift far from the obstacle — which rules out the ALGORITHM and points
    // at PRECISION specifically. Not yet confirmed live; this is the
    // hypothesis this precision bump exists to test, not a proven fix.
    const describe = () => ({
      resolvedW: w,
      resolvedH: h,
      screenSized: false, // O(1) in map size — five tiny levels + one full-res level, never a per-map-size cost
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
      filter: 'linear',
      depth: false,
    });

    const solidityRt = allocator.create(name('solidity'), describe());
    const velocitySeedRt = allocator.create(name('velocitySeed'), describe());
    const divergenceRt = allocator.create(name('divergence'), describe());
    const pressurePingRt = allocator.create(name('pressurePing'), describe());
    const pressurePongRt = allocator.create(name('pressurePong'), describe());
    const packRt = allocator.create(name('pack'), describe());

    const soliditySeed = buildWaterSoliditySeedMaterial({ THREE, maskTexture, width: w, height: h });
    const velocitySeed = buildWaterVelocitySeedMaterial({ THREE, solidityTexture: solidityRt.texture, uDir });
    const divergence = buildWaterDivergenceMaterial({
      THREE,
      velocityTexture: velocitySeedRt.texture,
      width: w,
      height: h,
    });
    // `prevPressureTexture` here is a PLACEHOLDER-ish initial value
    // (pressurePingRt's own, still-empty texture) — `runLevel` re-points
    // `jacobi.prevTexNodes` before EVERY iteration regardless, the same
    // discipline `water-body.js#buildWaterJfaStepMaterial` already
    // documents for its own ping-pong loop.
    const jacobi = buildWaterJacobiStepMaterial({
      THREE,
      prevPressureTexture: pressurePingRt.texture,
      divergenceTexture: divergenceRt.texture,
      solidityTexture: solidityRt.texture,
      width: w,
      height: h,
    });
    // Same placeholder-initial-value reasoning as `jacobi` above — `runLevel`
    // re-points `pack.pressureTexNodes` ONCE, after the Jacobi loop finishes.
    const pack = buildWaterProjectPackMaterial({
      THREE,
      seedVelocityTexture: velocitySeedRt.texture,
      pressureTexture: pressurePingRt.texture,
      solidityTexture: solidityRt.texture,
      width: w,
      height: h,
    });

    return {
      w,
      h,
      solidityRt,
      velocitySeedRt,
      divergenceRt,
      pressurePingRt,
      pressurePongRt,
      packRt,
      soliditySeed,
      velocitySeed,
      divergence,
      jacobi,
      pack,
    };
  }

  /**
   * Run ONE level end to end: solidity seed → velocity seed → divergence →
   * `WATER_FLOW_SOLVE_ITERATIONS_PER_LEVEL` Jacobi iterations (ping-ponged,
   * `water-body.js#runFlood`'s own loop shape) → project+pack.
   *
   * `initialPressureTexture` is either {@link zeroPressureTexture} (the
   * coarsest level) or the PREVIOUS level's own finished pack pressure — read
   * here via plain bilinear `texture()`, which IS the multigrid
   * "prolongation" (upsample) step: no dedicated pass exists because a GPU
   * sampler upsamples for free when its source is smaller than the target it
   * is rendering into.
   * @param {object} level @param {*} initialPressureTexture
   * @returns {*} the texture this level's Jacobi loop actually finished on —
   *   the next level's own `initialPressureTexture`.
   */
  function runLevel(level, initialPressureTexture) {
    renderWaterPass(level.solidityRt, level.soliditySeed.quad);
    renderWaterPass(level.velocitySeedRt, level.velocitySeed.quad);
    renderWaterPass(level.divergenceRt, level.divergence.quad);

    let srcTexture = initialPressureTexture;
    let writeToPing = true;
    for (let i = 0; i < WATER_FLOW_SOLVE_ITERATIONS_PER_LEVEL; i++) {
      const dst = writeToPing ? level.pressurePingRt : level.pressurePongRt;
      for (const node of level.jacobi.prevTexNodes) node.value = srcTexture;
      renderWaterPass(dst, level.jacobi.quad);
      srcTexture = dst.texture;
      writeToPing = !writeToPing;
    }

    // ONE re-point, not a ping-pong: the pack pass never writes to the
    // texture it reads, it just needed to be TOLD which of ping/pong the
    // loop above actually finished on (parity depends on the iteration
    // count, which this function does not hardcode an assumption about).
    for (const node of level.pack.pressureTexNodes) node.value = srcTexture;
    renderWaterPass(level.packRt, level.pack.quad);

    return srcTexture;
  }

  /**
   * THE FULL CASCADE — every level, coarsest to finest, each seeding the
   * next's Jacobi initial guess with its own converged pressure.
   * @param {*} maskTexture @param {number} bearingDeg @param {{w:number,h:number}} finestDims
   */
  function runFullBake(maskTexture, bearingDeg, finestDims) {
    disposeLevels();
    const [dirX, dirY] = waterFlowVector(bearingDeg);
    uDir.value.set(dirX, dirY);

    let prevFinalPressure = zeroPressureTexture;
    const builtLevels = [];
    for (const fraction of WATER_FLOW_SOLVE_LEVEL_FRACTIONS) {
      const { w, h } = levelDims(finestDims.w, finestDims.h, fraction);
      const level = buildLevel(builtLevels.length, w, h, maskTexture);
      prevFinalPressure = runLevel(level, prevFinalPressure);
      builtLevels.push(level);
    }
    levels = builtLevels;

    bakes++;
    pollsSinceLastBake = 0;
    boundMaskTexture = maskTexture;
    boundBearingDeg = bearingDeg;
    gridKey = `${finestDims.w}x${finestDims.h}`;
    lastBake = {
      grid: gridKey,
      levels: levels.map((l) => `${l.w}x${l.h}`),
      bearingDeg,
      atPoll: polls,
      ok: true,
    };
  }

  /**
   * THE PER-FRAME QUESTION — cheap to call, expensive to run. Same §1
   * discipline as the body pack: bake count must not track frame count. No
   * floor argument — this instance already belongs to exactly one floor
   * (see this module's own header on why).
   */
  function maybeBake() {
    polls++;
    pollsSinceLastBake++;

    const maskTexture = waterSurface.getFullResMaskTexture();
    if (!maskTexture) {
      // Honest, not stuck: reported every poll until a real texture exists,
      // never silently skipped once and forgotten.
      lastBake = { skipped: true, reason: 'no full-resolution mask loaded for this floor yet' };
      return;
    }

    const rect = waterBody.getRect();
    if (!rect) {
      lastBake = { skipped: true, reason: 'no water body rect for this floor' };
      return;
    }
    const finestDims = sizeFlowGrid(rect);
    const newGridKey = `${finestDims.w}x${finestDims.h}`;
    const bearingDeg = getWaterRenderState()?.params?.flowAngleDeg ?? 0;

    const unchanged = maskTexture === boundMaskTexture && bearingDeg === boundBearingDeg && newGridKey === gridKey;
    if (unchanged) return;

    try {
      runFullBake(maskTexture, bearingDeg, finestDims);
    } catch (err) {
      lastBake = { skipped: true, reason: String(err?.message ?? err) };
    }
  }

  return {
    /** THE FINEST level's own finished pack — RG velocity (normalised,
     * free-stream = 1.0), B speed01, A solidity. `null` until the first
     * successful bake. */
    get texture() {
      return levels.length > 0 ? levels[levels.length - 1].packRt.texture : null;
    },
    maybeBake,
    /** The debug-panel report. Same `bakes` vs `polls` exit criterion as
     * every other bake in this codebase — see `water-body-subsystem.js`'s
     * own doc for why that comparison is the one that matters. */
    getStatus() {
      return {
        bakes,
        polls,
        pollsSinceLastBake,
        grid: gridKey || 'not allocated',
        levelCount: levels.length,
        lastBake: lastBake ?? 'never baked',
      };
    },
    dispose() {
      disposeLevels();
      zeroPressureTexture?.dispose?.();
      gridKey = '';
      boundMaskTexture = null;
      boundBearingDeg = null;
    },
  };
}
