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
  buildWaterSolidityDownsampleMaterial,
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
  WATER_FLOW_SOLVE_OMEGA,
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
 * Every coarser level's own DIMENSIONS are a FRACTION of the finest level's.
 * ⚠️ Its SOLIDITY is a different question, and the two must not be confused
 * — see `water-flow.js#buildWaterSolidityDownsampleMaterial`'s own header
 * for a real, live-reported bug that came from conflating them: dimensions
 * are computed independently per level (there is nothing to cascade, it is
 * just arithmetic), but solidity IS cascaded — averaged down from the next
 * finer level's own result — never independently re-sampled from the raw
 * mask at a coarse level's own low resolution.
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
 * How much of a flow bake runs per frame, in texel-passes (2026-10-25,
 * Water-Performance-Audit W-04). A bake is ~2,000 full-grid passes (5 levels
 * × [solidity + seed + divergence + 2×iterations SOR half-steps + pack]); run
 * in one frame that was a stall of hundreds of ms on scene load, every mask
 * repaint and every compass or solve-slider release. 48 M texel-passes is
 * ~45 finest-level passes of a 1536×714 grid per frame, so a default bake
 * lands in roughly a dozen frames instead of one long one. The result is
 * bit-identical either way — only when it lands moves.
 */
export const WATER_FLOW_BAKE_TEXEL_BUDGET_PER_FRAME = 48_000_000;

/** How long the full-float bake scratch outlives its bake before it is freed
 * (W-05) — long enough that a burst of slider releases reuses it. */
export const WATER_FLOW_SCRATCH_IDLE_RELEASE_MS = 10_000;

/** The two per-poll skip reports, allocated once (W-18: no per-frame garbage). */
const SKIP_NO_MASK = Object.freeze({ skipped: true, reason: 'no full-resolution mask loaded for this floor yet' });
const SKIP_NO_RECT = Object.freeze({ skipped: true, reason: 'no water body rect for this floor' });

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
 * @param {number} [args.texelBudgetPerFrame] - see
 *   {@link WATER_FLOW_BAKE_TEXEL_BUDGET_PER_FRAME}; `Infinity` bakes in one call.
 * @returns {{
 *   texture: *,
 *   maybeBake: (nowMs?: number) => void,
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
  texelBudgetPerFrame = WATER_FLOW_BAKE_TEXEL_BUDGET_PER_FRAME,
}) {
  getWaterRenderState ??= () => ({ params: {} });

  const { uniform, vec2, texture, uv } = THREE.TSL;
  /** Shared across EVERY level's own velocity-seed material — one `.value`
   * write updates all five at once on a bulk-direction change. */
  const uDir = uniform(vec2(0, -1));

  /** The coarsest level's own Jacobi seed — "no prior information exists" —
   * built ONCE, disposed only in this subsystem's own `dispose()`. */
  const zeroPressureTexture = createFlowTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, 'linear');

  /** `WxH` of the FINEST level the bake inputs ask for — '' = never asked. */
  let gridKey = '';
  /** THE SCRATCH — one entry per `WATER_FLOW_SOLVE_LEVEL_FRACTIONS`, coarsest
   * first. Empty before the first bake AND after an idle release (see
   * `WATER_FLOW_SCRATCH_IDLE_RELEASE_MS`): only the PUBLISHED pack below is
   * read between bakes. */
  let levels = [];
  /** What the current `levels`' solidity was rendered from — a later bake
   * with the same grid and mask reuses targets, materials AND solidity. */
  let levelsGridKey = '';
  let levelsMaskTexture = null;

  /**
   * THE PUBLISHED PACK (2026-10-25, Water-Performance-Audit W-05) — the ONLY
   * thing a consumer reads: `texture`/`width`/`height` below. RGBA16F, one
   * target per grid size, written by a copy pass at the END of each bake and
   * never replaced by a bake on the same grid, so its identity is stable: the
   * sim (`water-sim-subsystem.js`, which rebuilds on a new flow texture) and
   * the surface keep their bindings across every rebake. Half float is ample
   * for what it holds — normalised velocity (≤ ~2.5, error ≤ ~1e-3), speed01
   * and solidity (multiples of 1/16 at the finest level, exact in half float).
   * The full-float scratch the SOLVE needs (§ `buildLevel`) is freed once idle.
   * @type {{rt: *, w: number, h: number, key: string}|null}
   */
  let published = null;
  /** The copy pass levels[last].packRt → published.rt, and what it binds. */
  let publishCopy = null;

  let boundMaskTexture = null;
  let boundBearingDeg = null;
  let boundOmega = null;
  let boundIterationsPerLevel = null;

  /** The bake in flight — a generator that renders ONE pass per `next()` and
   * yields that pass's texel count (see `bakeSteps`). `null` when idle. */
  let job = null;
  let jobInfo = null;
  let lastBakeDoneMs = null;

  let bakes = 0;
  let polls = 0;
  let pollsSinceLastBake = 0;
  let lastBake = null;
  let scratchReleases = 0;

  function disposeLevels() {
    for (const level of levels) {
      allocator.dispose(level.solidityRt);
      allocator.dispose(level.velocitySeedRt);
      allocator.dispose(level.divergenceRt);
      allocator.dispose(level.pressurePingRt);
      allocator.dispose(level.pressurePongRt);
      allocator.dispose(level.packRt);
      level.soliditySource?.material?.dispose?.();
      level.velocitySeed.material?.dispose?.();
      level.divergence.material?.dispose?.();
      level.jacobiFromInitial.material?.dispose?.();
      level.jacobiFromPing.material?.dispose?.();
      level.jacobiFromPong.material?.dispose?.();
      level.pack.material?.dispose?.();
    }
    levels = [];
    levelsGridKey = '';
    levelsMaskTexture = null;
    publishCopy?.material?.dispose?.();
    publishCopy = null;
  }

  function disposePublished() {
    if (published) allocator.dispose(published.rt);
    published = null;
  }

  /**
   * Allocate this level's six targets and build its solidity-independent
   * materials (velocity seed, divergence, three SOR steps, project+pack) —
   * called once per level on every full rebuild (never re-pointed; see this
   * module's own header for why). Solidity is deliberately NOT built here —
   * see `buildSolidityForLevel`'s own doc for why it needs every level's
   * `w`/`h` already known and must run in a SEPARATE, fine-to-coarse pass.
   * @param {number} index @param {number} w @param {number} h
   * @param {*} initialPressureTexture - what this level's FIRST SOR half-step
   *   reads: the zero placeholder (coarsest) or the previous level's own
   *   finished pressure (always its pong target — see `bakeSteps`).
   * @returns {object}
   */
  function buildLevel(index, w, h, initialPressureTexture) {
    const name = (suffix) => `water.flow.L${index}.${suffix}`;
    // LINEAR throughout — every one of these six is a smoothly-varying
    // scalar/vector field (solidity, velocity, divergence, pressure, the
    // final pack), nothing like the body pack's own NEAREST JFA ping-pong
    // pair, which stores mid-flood offset VECTORS that must never blend.
    //
    // FULL `FloatType`, NOT `HalfFloatType` — every other bake in this
    // codebase uses half float and that is right for THEM (one pass, or a
    // handful of JFA rounds); this pack is different in a way that matters:
    // the pressure ping-pong reads-and-writes itself
    // `WATER_FLOW_SOLVE_ITERATIONS_PER_LEVEL` times PER LEVEL, and the
    // 5-level cascade then feeds each level's result into the next as an
    // initial guess — a hundred-odd read/round/write passes total, per bake.
    //
    // ⚠️ NOT THE FIX FOR THE 2026-08-18 DIRECTIONAL-TINT BUG — kept anyway,
    // because more precision on an iterative solve is never wrong, just
    // recorded honestly: a live A/B test (forced rebake, same scene, half
    // vs full float) came back PIXEL-IDENTICAL, which is itself informative
    // — a genuine rounding-noise artifact should have shifted at least
    // slightly between the two, and it did not. That ruled precision out and
    // pointed at something DETERMINISTIC instead — see
    // `water-flow.js#buildWaterSolidityDownsampleMaterial`'s own header for
    // what it actually was (undersampling the raw mask independently at
    // each coarse level, rather than cascading solidity down from the
    // finest level the way `water-flow-solve.js`'s own proven CPU reference
    // already did).
    //
    // ⚠️ ONLY THE CHANNELS EACH TARGET HOLDS (2026-10-25, Water-Performance-
    // Audit W-04/W-05). Solidity, divergence and pressure are scalars (every
    // material writes `vec4(x, 0, 0, 1)` and every reader takes `.r`), the
    // velocity seed is RG, only the pack is RGBA. Same float32 values, same
    // filtering (r32float/rg32float are filterable exactly when rgba32float
    // is — the `float32-filterable` feature), so the solve is bit-identical —
    // at a quarter of the bytes per SOR fetch and of the scratch VRAM.
    const describe = (format) => ({
      resolvedW: w,
      resolvedH: h,
      screenSized: false, // O(1) in map size — five tiny levels + one full-res level, never a per-map-size cost
      type: THREE.FloatType,
      format,
      colorSpace: THREE.NoColorSpace,
      filter: 'linear',
      depth: false,
    });

    const solidityRt = allocator.create(name('solidity'), describe(THREE.RedFormat));
    const velocitySeedRt = allocator.create(name('velocitySeed'), describe(THREE.RGFormat));
    const divergenceRt = allocator.create(name('divergence'), describe(THREE.RedFormat));
    const pressurePingRt = allocator.create(name('pressurePing'), describe(THREE.RedFormat));
    const pressurePongRt = allocator.create(name('pressurePong'), describe(THREE.RedFormat));
    const packRt = allocator.create(name('pack'), describe(THREE.RGBAFormat));

    const velocitySeed = buildWaterVelocitySeedMaterial({ THREE, solidityTexture: solidityRt.texture, uDir });
    const divergence = buildWaterDivergenceMaterial({
      THREE,
      velocityTexture: velocitySeedRt.texture,
      width: w,
      height: h,
    });
    // ⚠️ THREE SOR MATERIALS, EACH BOUND TO ONE FIXED SOURCE (2026-10-25,
    // W-04) — instead of ONE material whose five `prevTexNodes` were
    // re-pointed before every half-step (a fresh bind group per pass, ~2,000
    // times a bake). Half-step 0 reads the initial guess and writes ping;
    // every odd half-step reads ping and writes pong; every later even one
    // reads pong and writes ping — exactly the old ping-pong sequence, so the
    // loop's arithmetic and order are unchanged. The three compile to the
    // same WGSL, so they share one pipeline.
    const jacobiArgs = {
      THREE,
      divergenceTexture: divergenceRt.texture,
      solidityTexture: solidityRt.texture,
      width: w,
      height: h,
    };
    const jacobiFromInitial = buildWaterJacobiStepMaterial({
      ...jacobiArgs,
      prevPressureTexture: initialPressureTexture,
    });
    const jacobiFromPing = buildWaterJacobiStepMaterial({ ...jacobiArgs, prevPressureTexture: pressurePingRt.texture });
    const jacobiFromPong = buildWaterJacobiStepMaterial({ ...jacobiArgs, prevPressureTexture: pressurePongRt.texture });
    // An even number of half-steps always finishes on PONG (see above), so
    // the pack binds pong outright — no "which target did the loop finish on"
    // re-point any more.
    const pack = buildWaterProjectPackMaterial({
      THREE,
      seedVelocityTexture: velocitySeedRt.texture,
      pressureTexture: pressurePongRt.texture,
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
      // Filled in by `buildSolidityForLevel`, in the separate fine-to-coarse
      // pass `bakeSteps` runs AFTER every level's targets exist.
      soliditySource: null,
      velocitySeed,
      divergence,
      jacobiFromInitial,
      jacobiFromPing,
      jacobiFromPong,
      pack,
    };
  }

  /**
   * Build THIS level's own solidity material — the fine-to-coarse pass
   * `water-flow.js#buildWaterSolidityDownsampleMaterial`'s own header
   * documents in full. The FINEST level (`finerLevel: null`) seeds directly
   * from the raw mask (S2's own, already-correct area average); every
   * coarser level averages DOWN from the next-finer level's own
   * already-rendered `solidityRt`, never re-sampling the raw mask itself.
   * @param {object} level @param {*} maskTexture @param {object|null} finerLevel
   */
  function buildSolidityForLevel(level, maskTexture, finerLevel) {
    level.soliditySource = finerLevel
      ? buildWaterSolidityDownsampleMaterial({
          THREE,
          sourceTexture: finerLevel.solidityRt.texture,
          sourceWidth: finerLevel.w,
          sourceHeight: finerLevel.h,
        })
      : buildWaterSoliditySeedMaterial({ THREE, maskTexture, width: level.w, height: level.h });
  }

  /**
   * THE BAKE, ONE RENDER PASS PER `next()` (2026-10-25, Water-Performance-
   * Audit W-04). Each `yield` hands back the texel count of the pass it just
   * rendered, so `maybeBake` can spread a bake over several frames by a
   * texel budget instead of running ~2,000 passes inside one frame. The
   * passes, their order and their inputs are exactly the old single-call
   * cascade's, so the finished pack is bit-identical; only WHEN it lands
   * moves (and the previous pack stays published until then).
   *
   *  1. Allocate every level's targets + build its materials — SKIPPED when
   *     the grid and mask match the scratch still alive from the last bake
   *     (a compass, SOR-strength or iteration change touches only uniforms
   *     and a loop count, never a texture).
   *  2. Solidity, FINEST TO COARSEST — skipped with step 1 (it depends only
   *     on the mask and the grid).
   *  3. The pressure solve, COARSEST TO FINEST — each finer level starts from
   *     the previous COARSER level's own converged pressure.
   *  4. Publish: copy the finest pack into the RGBA16F published target.
   * @param {*} maskTexture @param {number} bearingDeg @param {{w:number,h:number}} finestDims
   * @param {number} omega @param {number} iterationsPerLevel
   */
  function* bakeSteps(maskTexture, bearingDeg, finestDims, omega, iterationsPerLevel) {
    const [dirX, dirY] = waterFlowVector(bearingDeg);
    uDir.value.set(dirX, dirY);
    const key = `${finestDims.w}x${finestDims.h}`;

    if (!(levels.length > 0 && levelsGridKey === key && levelsMaskTexture === maskTexture)) {
      disposeLevels();
      const built = [];
      for (const fraction of WATER_FLOW_SOLVE_LEVEL_FRACTIONS) {
        const { w, h } = levelDims(finestDims.w, finestDims.h, fraction);
        const initial = built.length === 0 ? zeroPressureTexture : built[built.length - 1].pressurePongRt.texture;
        built.push(buildLevel(built.length, w, h, initial));
      }
      levels = built;
      levelsGridKey = key;
      levelsMaskTexture = maskTexture;
      for (let i = levels.length - 1; i >= 0; i--) {
        const finerLevel = i === levels.length - 1 ? null : levels[i + 1];
        buildSolidityForLevel(levels[i], maskTexture, finerLevel);
        renderWaterPass(levels[i].solidityRt, levels[i].soliditySource.quad);
        yield levels[i].w * levels[i].h;
      }
    }

    const halfSteps = 2 * Math.max(1, Math.round(iterationsPerLevel));
    for (const level of levels) {
      renderWaterPass(level.velocitySeedRt, level.velocitySeed.quad);
      yield level.w * level.h;
      renderWaterPass(level.divergenceRt, level.divergence.quad);
      yield level.w * level.h;
      // ROH TUNING (2026-08-19) — `uOmega` is a live uniform
      // (`buildWaterJacobiStepMaterial`'s own doc), set on all three.
      for (const step of [level.jacobiFromInitial, level.jacobiFromPing, level.jacobiFromPong]) {
        step.uOmega.value = omega;
      }
      // SOR (2026-08-19) — each caller-visible "iteration" is TWO renders,
      // checkerboard parity 0 then 1, matching `water-flow-solve.js#
      // solveVelocityLevel`'s own loop shape exactly.
      for (let k = 0; k < halfSteps; k++) {
        const step = k === 0 ? level.jacobiFromInitial : k % 2 === 1 ? level.jacobiFromPing : level.jacobiFromPong;
        step.uParity.value = k % 2;
        renderWaterPass(k % 2 === 0 ? level.pressurePingRt : level.pressurePongRt, step.quad);
        yield level.w * level.h;
      }
      renderWaterPass(level.packRt, level.pack.quad);
      yield level.w * level.h;
    }

    // PUBLISH. A new grid size gets a new target, allocated HERE (at the end,
    // not the start) so consumers keep reading the old pack for the whole bake.
    const finest = levels[levels.length - 1];
    if (!published || published.key !== key) {
      disposePublished();
      published = {
        rt: allocator.create('water.flow.published', {
          resolvedW: finest.w,
          resolvedH: finest.h,
          screenSized: false,
          type: THREE.HalfFloatType,
          format: THREE.RGBAFormat,
          colorSpace: THREE.NoColorSpace,
          filter: 'linear',
          depth: false,
        }),
        w: finest.w,
        h: finest.h,
        key,
      };
    }
    if (!publishCopy || publishCopy.source !== finest.packRt.texture) {
      publishCopy?.material?.dispose?.();
      const material = new THREE.NodeMaterial();
      material.fragmentNode = texture(finest.packRt.texture, uv());
      publishCopy = { material, quad: new THREE.QuadMesh(material), source: finest.packRt.texture };
    }
    renderWaterPass(published.rt, publishCopy.quad);
    yield finest.w * finest.h;
  }

  /**
   * THE PER-FRAME QUESTION — cheap to call, expensive to run. Same §1
   * discipline as the body pack: bake count must not track frame count. No
   * floor argument — this instance already belongs to exactly one floor
   * (see this module's own header on why).
   * @param {number} [nowMs] - the frame clock's wall time (`env.time.realMs`),
   *   for the bake's own duration report and the scratch idle release. A
   *   caller that never passes it simply never releases the scratch.
   */
  function maybeBake(nowMs) {
    polls++;
    pollsSinceLastBake++;

    const maskTexture = waterSurface.getFullResMaskTexture();
    if (!maskTexture) {
      // Honest, not stuck: reported every poll until a real texture exists,
      // never silently skipped once and forgotten.
      lastBake = SKIP_NO_MASK; // a shared frozen object: this branch runs every frame on a waterless floor
      return;
    }

    const rect = waterBody.getRect();
    if (!rect) {
      lastBake = SKIP_NO_RECT;
      return;
    }
    const finestDims = sizeFlowGrid(rect);
    const newGridKey = `${finestDims.w}x${finestDims.h}`;
    const params = getWaterRenderState()?.params;
    const bearingDeg = params?.flowAngleDeg ?? 0;
    const omega = params?.flowSolveOmega ?? WATER_FLOW_SOLVE_OMEGA;
    const iterationsPerLevel = params?.flowSolveIterations ?? WATER_FLOW_SOLVE_ITERATIONS_PER_LEVEL;

    const unchanged =
      maskTexture === boundMaskTexture &&
      bearingDeg === boundBearingDeg &&
      newGridKey === gridKey &&
      omega === boundOmega &&
      iterationsPerLevel === boundIterationsPerLevel;
    if (!unchanged) {
      // (Re)start. A change landing MID-bake simply restarts it: the
      // half-finished job is dropped, the published pack is untouched.
      boundMaskTexture = maskTexture;
      boundBearingDeg = bearingDeg;
      boundOmega = omega;
      boundIterationsPerLevel = iterationsPerLevel;
      gridKey = newGridKey;
      job = bakeSteps(maskTexture, bearingDeg, finestDims, omega, iterationsPerLevel);
      jobInfo = { startPoll: polls, startMs: nowMs, frames: 0, passes: 0, bearingDeg, omega, iterationsPerLevel };
    }

    if (job) {
      let spent = 0;
      try {
        while (spent < texelBudgetPerFrame) {
          const step = job.next();
          if (step.done) {
            finishBake(nowMs);
            break;
          }
          spent += step.value;
          jobInfo.passes++;
        }
        if (job) jobInfo.frames++;
      } catch (err) {
        job = null;
        // Forget the inputs so the next poll retries, exactly as the old
        // single-call bake did on a throw (it stamped nothing).
        boundMaskTexture = null;
        lastBake = { skipped: true, reason: String(err?.message ?? err) };
      }
      return;
    }

    // THE SCRATCH IS ONLY NEEDED WHILE BAKING (2026-10-25, W-05) — five
    // levels of full-float targets, ~120 MB on a 2:1 map. Kept for a short
    // while after a bake so a burst of slider releases reuses it, then freed.
    if (
      levels.length > 0 &&
      Number.isFinite(nowMs) &&
      Number.isFinite(lastBakeDoneMs) &&
      nowMs - lastBakeDoneMs > WATER_FLOW_SCRATCH_IDLE_RELEASE_MS
    ) {
      disposeLevels();
      scratchReleases++;
    }
  }

  function finishBake(nowMs) {
    job = null;
    bakes++;
    pollsSinceLastBake = 0;
    lastBakeDoneMs = Number.isFinite(nowMs) ? nowMs : null;
    jobInfo.frames++;
    lastBake = {
      grid: gridKey,
      levels: levels.map((l) => `${l.w}x${l.h}`),
      bearingDeg: jobInfo.bearingDeg,
      omega: jobInfo.omega,
      iterationsPerLevel: jobInfo.iterationsPerLevel,
      atPoll: jobInfo.startPoll,
      // W-21 — what the bake really cost, which a per-frame median hides.
      passes: jobInfo.passes,
      frames: jobInfo.frames,
      wallMs: Number.isFinite(nowMs) && Number.isFinite(jobInfo.startMs) ? nowMs - jobInfo.startMs : null,
      ok: true,
    };
  }

  return {
    /** THE PUBLISHED pack — RG velocity (normalised, free-stream = 1.0), B
     * speed01, A solidity, RGBA16F. `null` until the first bake completes;
     * from then on always the last COMPLETED bake (a bake in flight never
     * shows half-done). */
    get texture() {
      return published ? published.rt.texture : null;
    },
    /** The published pack's own texel dimensions — `null` until the first
     * bake, exactly like `texture` above. Exists so a consumer that must match
     * this grid EXACTLY (`water-sim-subsystem.js`'s own sim grid, S5) can read
     * the real, already-resolved dimensions rather than re-running
     * `sizeFlowGrid` independently — two independent computations of "the
     * same" grid size risk landing one texel apart on a rounding edge case,
     * which two differently-sized textures sampled together would not fail
     * loudly. */
    get width() {
      return published ? published.w : null;
    },
    get height() {
      return published ? published.h : null;
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
        published: published ? `${published.w}x${published.h}` : 'none',
        baking: job ? { passes: jobInfo.passes, frames: jobInfo.frames } : false,
        scratchReleases,
        lastBake: lastBake ?? 'never baked',
      };
    },
    dispose() {
      job = null;
      disposeLevels();
      disposePublished();
      zeroPressureTexture?.dispose?.();
      gridKey = '';
      boundMaskTexture = null;
      boundBearingDeg = null;
    },
  };
}
