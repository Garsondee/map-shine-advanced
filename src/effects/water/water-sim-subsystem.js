/**
 * THE SIM-PACK SUBSYSTEM — owns `res:waterSim`'s ping-pong pair, runs ONE
 * step of it every frame (`docs/planning/Water-Simulation-Turn.md` §3 Layer
 * C / §4 S5). `water-sim.js` builds the single per-frame material; this
 * drives it.
 *
 * Unlike EVERY other subsystem in this family (body, flow, surface — all
 * "bake once when inputs change"), this one does real work on every call:
 * the whole point of a ping-pong buffer is that it advances every frame,
 * whether or not its inputs changed. Three different things move on three
 * different schedules, not one:
 *
 *  1. THE PING-PONG TARGETS — allocated ONCE per `(width, height)`, and
 *     survive everything except an actual regrid. This IS the buffer's own
 *     memory; reallocating it on every flow-param tweak would reset foam to
 *     nothing on every slider drag, defeating the entire point of S5.
 *  2. THE STEP MATERIALS (two of them — see below) — rebuilt whenever the
 *     flow or body pack's own texture OBJECT changes identity, which
 *     includes every flow bake (`water-flow-subsystem.js` rebuilds its
 *     levels wholesale on ANY change, per that file's own header) even when
 *     dimensions do not change. Cheap (a shader graph + a QuadMesh, no GPU
 *     allocation) and frequent enough that "just rebuild" beats re-pointing
 *     up to fifteen separate texture nodes correctly every time — the same
 *     tradeoff `water-flow-subsystem.js`'s own header already made, for the
 *     same reason.
 *  3. THE PER-FRAME STEP ITSELF — unconditional, every `tick()` call. Named
 *     `tick`, not `maybeBake`, on purpose: there is no "nothing changed,
 *     skip" case for this one once inputs exist — matching
 *     `world/day-clock.js#tick(dtSec)`'s own naming for the same reason.
 *
 * ============================================================================
 * WHY TWO MATERIALS, NOT ONE RE-POINTED EVERY FRAME
 * ============================================================================
 * A ping-pong buffer only ever runs in one of two configurations: ping→pong
 * or pong→ping. `water-body.js`'s own JFA flood re-points a SINGLE material
 * because its round count is dynamic (grid-dependent, decided at bake time);
 * this buffer's cycle is always exactly 2, known at build time. Building
 * both directions once and choosing which quad to render each frame means
 * the nine `simPrevTexNodes` a single re-pointed material would need touched
 * correctly, every single frame, forever, are simply never touched again
 * after construction — nothing left to get half-right under a future
 * refactor, and no per-frame re-point cost either.
 *
 * ============================================================================
 * WHY `uReachPx` IS PUSHED, NOT PULLED LIKE `flowSpeedPx`/`foam`
 * ============================================================================
 * `flowSpeedPx` and `foam` are plain `water.js` schema values — read the same
 * way `water-flow-subsystem.js` already reads `flowAngleDeg`, through
 * `getWaterRenderState()?.params`. The foam band's own reach is NOT a plain
 * param: `water-render.js` derives `uFoamReachPx` from the water body's own
 * size (`waterFoamReachPx(depthScalePx)`) and pushes it through a setter
 * (`setDepthScalePx`) specifically "so the two can never disagree about the
 * body's size" (that file's own comment). Re-deriving that same function
 * here from a second, independently-tracked `depthScalePx` would be exactly
 * the two-registries risk that comment is already avoiding — so this
 * subsystem accepts the SAME already-derived number through `setReachPx`
 * instead, leaving whoever wires this subsystem in (`vt-pan-viewer.js`) free
 * to forward the identical value `water-render.js` already computed.
 *
 * ============================================================================
 * WHY THE GPU CALLS ARE INJECTED
 * ============================================================================
 * Same reasoning as `water-flow-subsystem.js` §2 — `renderer-state/graph-only`
 * and `gpu/textures-in-vt-only` allow the literal calls only inside `vt/`.
 *
 * @module effects/water/water-sim-subsystem
 */

import {
  buildWaterSimStepMaterial,
  WATER_SIM_TAU_FOAM_SEC,
  WATER_SIM_DIFFUSE,
  WATER_SIM_SHEAR_GAIN,
  WATER_SIM_NEAR_SOLID_GAIN,
} from './water-sim.js';

/** Fallback foam-band reach, world px, used only until a caller calls
 * `setReachPx` at least once (e.g. before the surface material's own first
 * `setDepthScalePx` has run). Matches `water-shore.js`'s own `uReachPx`
 * default order of magnitude — small relative to a real river, never zero
 * (a zero reach would divide-by-near-zero in `water-sim.js#d01`, clamped
 * there but meaningless as a band width). */
const WATER_SIM_DEFAULT_REACH_PX = 64;

/**
 * @param {object} args
 * @param {*} args.THREE
 * @param {{create: Function, dispose: Function}} args.allocator - `graph/three-allocator.js`.
 * @param {{texture: *|null, width: number|null, height: number|null}} args.waterFlow -
 *   THIS floor's own `createWaterFlowSubsystem()` handle. `width`/`height`
 *   are read so this grid matches the flow pack's finest level exactly,
 *   rather than re-deriving the same size independently (that module's own
 *   citation on its `width`/`height` getters).
 * @param {{texture: *|null, getRect: () => {minX:number,minY:number,maxX:number,maxY:number}|null}} args.waterBody -
 *   THIS floor's own `createWaterBodySubsystem()` handle.
 * @param {(target: *, quad: *) => void} args.renderWaterPass - the literal
 *   save/bind/render/restore triplet, defined in `vt/` (this module's own
 *   header).
 * @param {() => {params?: object}} [args.getWaterRenderState] - the SAME
 *   seam `water-flow-subsystem.js` already receives, read here for
 *   `params.flowSpeedPx` and `params.foam`.
 * @param {*|null} [args.timeMsNode] - the viewer's shared clock, handed in
 *   ONCE at construction (`water-render.js`'s own convention — see
 *   `water-sim.js`'s own doc for why this is build-time, not per-frame).
 * @returns {{
 *   texture: *,
 *   tick: (dtSec: number) => void,
 *   setReachPx: (v: number) => void,
 *   getStatus: () => object,
 *   dispose: () => void,
 * }}
 */
export function createWaterSimSubsystem({
  THREE,
  allocator,
  waterFlow,
  waterBody,
  renderWaterPass,
  getWaterRenderState,
  timeMsNode = null,
}) {
  getWaterRenderState ??= () => ({ params: {} });

  const { uniform, vec4, float } = THREE.TSL;
  /** Written every `tick()` — the only per-frame-varying uniform. */
  const uDtSec = uniform(float(0));
  /** Written from schema params every `tick()` — see this module's header
   * on why these two are pulled and `uReachPx` below is pushed instead. */
  const uFlowSpeedPx = uniform(float(0));
  const uFoamAmount = uniform(float(1));
  const uReachPx = uniform(float(WATER_SIM_DEFAULT_REACH_PX));
  /** 2026-08-19 ROH controls — same pull pattern as `uFlowSpeedPx`/
   * `uFoamAmount` above: read from schema params every `tick()`, no rebuild
   * required, since `water-sim.js` reads them fresh every frame already. */
  const uTauFoamSec = uniform(float(WATER_SIM_TAU_FOAM_SEC));
  const uDiffuse = uniform(float(WATER_SIM_DIFFUSE));
  const uShearGain = uniform(float(WATER_SIM_SHEAR_GAIN));
  const uNearSolidGain = uniform(float(WATER_SIM_NEAR_SOLID_GAIN));

  const zeroMaterial = new THREE.NodeMaterial();
  zeroMaterial.fragmentNode = vec4(0, 0, 0, 0);
  const zeroQuad = new THREE.QuadMesh(zeroMaterial);

  let simPingRt = null;
  let simPongRt = null;
  let gridKey = '';
  /** `true`: the NEXT step reads ping, writes pong. Flips every step. */
  let writingPong = true;

  let stepPingToPong = null; // built against simPingRt.texture, renders into pong
  let stepPongToPing = null; // built against simPongRt.texture, renders into ping
  let boundFlowTexture = null;
  let boundBodyTexture = null;

  let ticks = 0;
  let steps = 0;
  let rebuilds = 0;
  let stepsSinceLastRebuild = 0;
  let lastStatus = 'never ticked';

  function disposeTargets() {
    allocator.dispose(simPingRt);
    allocator.dispose(simPongRt);
    simPingRt = null;
    simPongRt = null;
    gridKey = '';
  }

  function disposeMaterials() {
    stepPingToPong?.material?.dispose?.();
    stepPongToPing?.material?.dispose?.();
    stepPingToPong = null;
    stepPongToPing = null;
    boundFlowTexture = null;
    boundBodyTexture = null;
  }

  /** @returns {boolean} true if a (re)allocation happened. */
  function ensureTargets(width, height) {
    const key = `${width}x${height}`;
    if (key === gridKey) return false;
    disposeTargets();
    const describe = () => ({
      resolvedW: width,
      resolvedH: height,
      screenSized: false, // O(1) in map size, exactly like the flow pack's own six targets
      // HALF float, not full — unlike the flow pack's own iterative pressure
      // solve (a hundred-odd read/round/write passes accumulating error
      // BEFORE anything clamps it), this buffer's own foam channel is
      // `smoothstep`-clamped to [0,1] on EVERY single frame
      // (`water-sim.js`'s own §4 CLUMP step) — there is no unbounded
      // cross-frame error to accumulate, so half float is the DEFAULT this
      // family already uses everywhere else, and nothing here needs the
      // flow pack's own exception.
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
      // LINEAR: the advected sample (`water-sim.js#advectedUv`) lands at a
      // genuinely sub-texel position most frames — bilinear interpolation
      // there is standard, correct semi-Lagrangian advection, not a
      // convenience; NEAREST would alias every frame's own transport step.
      filter: 'linear',
      depth: false,
    });
    simPingRt = allocator.create('water.sim.ping', describe());
    simPongRt = allocator.create('water.sim.pong', describe());
    gridKey = key;
    // Explicit clear, not an assumed zero-init — `water-flow-subsystem.js`'s
    // own separate, explicit `zeroPressureTexture` makes the same choice for
    // a different reason (that one CPU-uploaded, this one rendered, because
    // an RT — unlike a 1×1 DataTexture — has no plain-bytes upload path).
    // Skipping this would let a fresh regrid render whatever garbage the
    // allocator handed back as "foam" until enough frames of decay washed
    // it out — a flash of noise on every scene load or resolution change.
    renderWaterPass(simPingRt, zeroQuad);
    renderWaterPass(simPongRt, zeroQuad);
    writingPong = true;
    return true;
  }

  function rebuildMaterials(flowTexture, bodyTexture, width, height, rect) {
    disposeMaterials();
    const common = {
      THREE,
      flowTexture,
      bodyTexture,
      width,
      height,
      rectWidthPx: Math.max(1, rect.maxX - rect.minX),
      rectHeightPx: Math.max(1, rect.maxY - rect.minY),
      uDtSec,
      uFlowSpeedPx,
      uReachPx,
      uFoamAmount,
      timeMsNode,
      uTauFoamSec,
      uDiffuse,
      uShearGain,
      uNearSolidGain,
    };
    stepPingToPong = buildWaterSimStepMaterial({ ...common, simPrevTexture: simPingRt.texture });
    stepPongToPing = buildWaterSimStepMaterial({ ...common, simPrevTexture: simPongRt.texture });
    boundFlowTexture = flowTexture;
    boundBodyTexture = bodyTexture;
    rebuilds++;
    stepsSinceLastRebuild = 0;
  }

  /**
   * THE PER-FRAME ENTRY POINT — cheap only in the sense that "no water on
   * this floor yet" is cheap; once flow+body are both baked, every call
   * does a real render. No floor argument — same one-instance-per-floor
   * rule `water-flow-subsystem.js`'s own header explains.
   * @param {number} dtSec - THIS frame's own sim seconds (`core/frame-
   *   clock.js`'s own `dtSec`), the caller's responsibility to supply.
   */
  function tick(dtSec) {
    ticks++;
    uDtSec.value = Number.isFinite(dtSec) && dtSec > 0 ? dtSec : 0;

    const flowTexture = waterFlow.texture;
    const bodyTexture = waterBody.texture;
    const flowW = waterFlow.width;
    const flowH = waterFlow.height;
    if (!flowTexture || !bodyTexture || !flowW || !flowH) {
      lastStatus = !flowTexture || !flowW || !flowH ? 'waiting on the flow pack' : 'waiting on the body pack';
      return;
    }
    const rect = waterBody.getRect?.();
    if (!rect) {
      lastStatus = 'no water body rect for this floor';
      return;
    }

    const params = getWaterRenderState()?.params ?? {};
    uFlowSpeedPx.value = Number.isFinite(params.flowSpeedPx) ? params.flowSpeedPx : 0;
    uFoamAmount.value = Number.isFinite(params.foam) ? params.foam : 1;
    uTauFoamSec.value = Number.isFinite(params.simFoamDecaySec) ? params.simFoamDecaySec : WATER_SIM_TAU_FOAM_SEC;
    uDiffuse.value = Number.isFinite(params.simDiffuse) ? params.simDiffuse : WATER_SIM_DIFFUSE;
    uShearGain.value = Number.isFinite(params.simShearGain) ? params.simShearGain : WATER_SIM_SHEAR_GAIN;
    uNearSolidGain.value = Number.isFinite(params.simNearSolidGain)
      ? params.simNearSolidGain
      : WATER_SIM_NEAR_SOLID_GAIN;

    ensureTargets(flowW, flowH);
    if (!stepPingToPong || flowTexture !== boundFlowTexture || bodyTexture !== boundBodyTexture) {
      rebuildMaterials(flowTexture, bodyTexture, flowW, flowH, rect);
    }

    if (writingPong) {
      renderWaterPass(simPongRt, stepPingToPong.quad);
    } else {
      renderWaterPass(simPingRt, stepPongToPing.quad);
    }
    writingPong = !writingPong;
    steps++;
    stepsSinceLastRebuild++;
    lastStatus = 'ok';
  }

  return {
    /** THE FINISHED pack from the MOST RECENTLY completed step — R foam, G
     * sediment (reserved), B turbulence (reserved), A spare. `null` until
     * flow+body are both baked and the first `tick()` has actually run. */
    get texture() {
      if (!simPingRt || !simPongRt) return null;
      // `writingPong` has already flipped for NEXT time by the point a
      // caller can observe it — `false` means "just wrote pong".
      return writingPong ? simPingRt.texture : simPongRt.texture;
    },
    /** The sim grid's own texel dimensions — `null` until the first tick
     * allocates it, same contract as `texture` above. Exists so a display
     * CONSUMER (`water-render.js`'s own smooth-texel reconstruction) can
     * read the real, already-resolved size instead of re-deriving it —
     * same reasoning as `water-flow-subsystem.js`'s own `width`/`height`
     * getters, which this subsystem's own grid is sized to match exactly. */
    get width() {
      return simPingRt ? simPingRt.width : null;
    },
    get height() {
      return simPingRt ? simPingRt.height : null;
    },
    tick,
    /** Push the SAME body-derived reach `water-render.js#setDepthScalePx`
     * already computes — see this module's header on why this is pushed
     * rather than re-derived here. */
    setReachPx(v) {
      if (Number.isFinite(v) && v > 0) uReachPx.value = v;
    },
    /** The debug-panel report. `steps` tracking `ticks` 1:1 (once inputs
     * exist) is EXPECTED here, unlike `bakes` vs `polls` everywhere else in
     * this family — this module's own header explains why. */
    getStatus() {
      return {
        ticks,
        steps,
        rebuilds,
        stepsSinceLastRebuild,
        grid: gridKey || 'not allocated',
        lastStatus,
      };
    },
    dispose() {
      disposeMaterials();
      disposeTargets();
      ticks = 0;
      steps = 0;
      rebuilds = 0;
      stepsSinceLastRebuild = 0;
      lastStatus = 'disposed';
    },
  };
}
