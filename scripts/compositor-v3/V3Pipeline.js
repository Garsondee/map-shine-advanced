/**
 * @fileoverview V3Pipeline — the unified-forward pipeline orchestrator.
 *
 * Thin coordinator (Forward+ B0-2 §5 #1: "must not grow methods"). It owns a
 * {@link FrameGraph} + {@link ThreeAllocator}, declares the B0-1 resources,
 * registers the B0-2 pass list, imports per-frame external resources, and calls
 * `graph.execute`. All real rendering lives in the individual pass modules under
 * `passes/`; this file is wiring.
 *
 * ## Integration contract (fail-safe by design)
 * The pipeline is consulted at the single V2 render seam
 * (`EffectComposer._getFloorCompositorV2().render(...)`, EffectComposer.js:800):
 *
 *   const v3 = getV3Pipeline();               // null unless the flag is on
 *   if (v3 && v3.isReady()) v3.render(ctx);    // V3 owns the frame
 *   else compositorV2.render(ctx);             // untouched V2 path
 *
 * {@link V3Pipeline#isReady} returns **false** until the unified geometry pass
 * can actually produce a scene frame. While any required pass is a stub, V3
 * never takes the frame — so enabling the flag today is safe and simply prepares
 * the machinery. Reliability first (Forward+ §14.1 principle 7): V3 only renders
 * when it can render correctly; otherwise the proven V2 path runs.
 *
 * @module compositor-v3/V3Pipeline
 */

import { createLogger } from '../core/log.js';
import { FrameGraph } from './FrameGraph.js';
import { ThreeAllocator } from './ThreeAllocator.js';
import { FullscreenPresent } from './FullscreenPresent.js';
import { ForwardLightingPass } from './ForwardLightingPass.js';
import { V3EffectsBridge } from './V3EffectsBridge.js';
import { isV3TonemapEnabled, getV3HdrKnee } from './v3-flags.js';

const log = createLogger('V3Pipeline');

/**
 * Capability flags for each pass that must be *real* before V3 can own a frame.
 * {@link V3Pipeline#isReady} ANDs the required ones. First-plunge milestone:
 * both are real (albedo-only — all floors, Z-unified, straight to an sRGB RT and
 * blitted to screen). Lighting/effects/attribute-buffer are added as later
 * passes and their own capability flags.
 * @type {Record<string, boolean>}
 */
const PASS_IMPLEMENTED = {
  unifiedGeometry: true, // B1: albedo from FloorRenderBus.renderTo (all floors, Z-sorted)
  present: true,         // B1: raw blit of scene.color to the framebuffer
};

export class V3Pipeline {
  /**
   * @param {object} options
   * @param {any} options.renderer - THREE.WebGLRenderer (or a mock in tests).
   * @param {any} [options.scene]
   * @param {any} [options.camera]
   * @param {any} [options.THREE] - defaults to `window.THREE`.
   */
  constructor(options = {}) {
    this.renderer = options.renderer ?? null;
    this.scene = options.scene ?? null;
    this.camera = options.camera ?? null;
    this._THREE = options.THREE ?? (typeof window !== 'undefined' ? window.THREE : null);

    this._allocator = new ThreeAllocator({ THREE: this._THREE });
    this._graph = new FrameGraph({
      allocator: this._allocator,
      logWarn: (msg, err) => log.warn(msg, err),
    });
    this._present = new FullscreenPresent({ THREE: this._THREE });
    this._lighting = new ForwardLightingPass({ THREE: this._THREE });
    this._effects = new V3EffectsBridge();
    this._initialized = false;
    /** @type {Record<string, boolean>} live copy so tests can flip caps. */
    this._impl = { ...PASS_IMPLEMENTED };
    this._lastError = null;
  }

  /**
   * Declare resources + register the pass graph. Idempotent.
   * @returns {this}
   */
  initialize() {
    if (this._initialized) return this;
    const THREE = this._THREE;
    if (!THREE) {
      // Deferred: allocator/passes need THREE. Safe to construct without it and
      // initialize later once the global is present.
      log.warn('initialize() deferred: window.THREE not yet available');
      return this;
    }
    this._allocator.setTHREE(THREE);

    this._declareResources(THREE);
    this._registerPasses();

    // Compile once up front so a malformed graph throws loudly at init, not
    // mid-frame (Forward+ §14.1 principle 4).
    try {
      const order = this._graph.getExecutionOrder();
      log.info(`V3 graph compiled: ${order.join(' → ')}`);
      this._initialized = true;
    } catch (err) {
      this._lastError = err;
      log.warn('V3 graph failed to compile; V3 will stay inactive', err);
    }
    return this;
  }

  /**
   * @param {any} THREE
   * @private
   */
  _declareResources(THREE) {
    // Linear HDR working buffer, depth-backed — the same shape as V2's per-level
    // sceneRT (HalfFloat, LinearSRGBColorSpace; see LevelRenderTargetPool). The
    // bus renders straight-alpha albedo here in LINEAR space, which is what
    // lighting needs to add radiance into (you cannot add light to already-
    // display-encoded pixels). The present pass does the linear→sRGB encode.
    //
    // When the attribute buffer lands this gains a second MRT attachment
    // (B0-1 §2.1); for now it is single-attachment color.
    this._graph.declareResource('scene.color', {
      size: 'screen',
      depth: true,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
    });
    // Illumination buffer (ambient bg + Foundry lights MAX + glow additive).
    // Illumination only — the lighting pass multiplies it by albedo into
    // scene.lit. Linear HDR so additive glow can exceed 1.
    this._graph.declareResource('scene.illum', {
      size: 'screen',
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
    });
    // Lit HDR output (albedo × illumination + screen coloration). Same linear
    // HDR format; no depth (a fullscreen composite, not geometry).
    this._graph.declareResource('scene.lit', {
      size: 'screen',
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
    });
  }

  /**
   * Register the first-plunge pass list: unified albedo → present. Later passes
   * (lighting, post, stylization) insert between these two as they land; the
   * frame graph derives the new order from their reads/writes.
   * @private
   */
  _registerPasses() {
    // ── Unified geometry: all floors at real Z (FloorRenderBus.renderTo) ──────
    this._graph.addPass({
      name: 'unifiedGeometry',
      reads: [],
      writes: ['scene.color'],
      execute: (ctx) => {
        const rt = ctx.target('scene.color');
        const bus = ctx.frame?.renderBus ?? null;
        const camera = ctx.camera ?? this.camera;
        const renderer = ctx.renderer ?? this.renderer;
        if (!renderer) return;

        if (!bus || typeof bus.renderTo !== 'function' || !camera) {
          // Bus not ready (early frames / no scene): show black, never garbage.
          this._clear(ctx, rt);
          return;
        }
        // Tick effect sims (candle flames attach to the bus scene and render in
        // this pass once ticked; vegetation sims advance for the effects pass).
        try { this._effects.tickSims(ctx.frame?.timeInfo ?? null, bus._scene ?? null); } catch (_) {}
        // Keep streamed tile textures fresh even though V2.render() is skipped.
        try { bus.syncStreaming?.(); } catch (_) {}
        // renderTo handles its own clear + camera-layer + state save/restore.
        bus.renderTo(renderer, camera, rt);
      },
    });

    // ── Lighting: illumination buffer → composite albedo×illum → scene.lit ────
    // Foundry-model illumination (MAX-blended, wall-clipped) plus additive glow
    // from light-emitting effects (candle glow), then lit = albedo × illum with
    // screen coloration on top.
    this._graph.addPass({
      name: 'lighting',
      reads: ['scene.color'],
      writes: ['scene.illum', 'scene.lit'],
      execute: (ctx) => {
        const colorRT = ctx.get('scene.color');
        const illumRT = ctx.target('scene.illum');
        const litRT = ctx.target('scene.lit');
        const renderer = ctx.renderer ?? this.renderer;
        const camera = ctx.camera ?? this.camera;
        const tex = colorRT?.texture ?? null;
        if (!renderer || !tex || !litRT || !illumRT) { this._clear(ctx, litRT); return; }
        let glowGroups = null;
        try { glowGroups = this._effects.getGlowGroups(); } catch (_) {}
        const ok = this._lighting.render(
          renderer, camera, tex, illumRT, litRT, { width: ctx.width, height: ctx.height }, glowGroups,
        );
        if (!ok) this._clear(ctx, litRT);
      },
    });

    // ── Effects: composite vegetation (bush/tree) onto the lit scene ──────────
    // Writes scene.lit (after lighting, WAW-ordered) by rendering overlay roots
    // into it. Candle flames are handled in the geometry pass (bus-scene meshes).
    this._graph.addPass({
      name: 'effects',
      reads: [],
      writes: ['scene.lit'],
      execute: (ctx) => {
        const litRT = ctx.target('scene.lit');
        const renderer = ctx.renderer ?? this.renderer;
        const camera = ctx.camera ?? this.camera;
        if (renderer && camera && litRT) {
          // Candle glow now lights the map inside the lighting pass (illumination
          // buffer). This pass composites content overlays that sit on top.
          try { this._effects.compositeVegetation(renderer, camera, litRT); } catch (_) {}
        }
      },
    });

    // ── Present: ACES tone map + linear→sRGB, scene.lit → framebuffer ─────────
    this._graph.addPass({
      name: 'present',
      reads: ['scene.lit'],
      writes: [],
      execute: (ctx) => {
        const rt = ctx.get('scene.lit');
        const renderer = ctx.renderer ?? this.renderer;
        const tex = rt?.texture ?? null;
        if (renderer && tex) this._present.present(renderer, tex, { tonemap: isV3TonemapEnabled(), knee: getV3HdrKnee() });
      },
    });
  }

  /**
   * Clear a render target to transparent black. Guarded so a mock renderer (no
   * setRenderTarget/clear) is a no-op during tests.
   * @param {import('./FrameGraph.js').PassContext} ctx
   * @param {any} rt
   * @private
   */
  _clear(ctx, rt) {
    const r = ctx.renderer ?? this.renderer;
    if (!r || typeof r.setRenderTarget !== 'function') return;
    try {
      const prev = r.getRenderTarget?.();
      r.setRenderTarget(rt);
      if (typeof r.clear === 'function') r.clear(true, true, true);
      r.setRenderTarget(prev ?? null);
    } catch (_) {}
  }

  /**
   * Whether V3 may own the frame. False until every required pass is a real
   * implementation — the fail-safe gate for the integration seam.
   * @returns {boolean}
   */
  isReady() {
    if (!this._initialized) return false;
    return this._impl.unifiedGeometry === true && this._impl.present === true;
  }

  /**
   * Mark a pass capability as implemented (called by pass modules as they land;
   * exposed for tests). Unknown keys are ignored.
   * @param {string} key
   * @param {boolean} value
   */
  setPassImplemented(key, value) {
    if (Object.prototype.hasOwnProperty.call(this._impl, key)) {
      this._impl[key] = !!value;
    }
  }

  /**
   * Render one frame through the graph. The caller must only invoke this when
   * {@link V3Pipeline#isReady} is true.
   *
   * @param {object} frameCtx
   * @param {any} [frameCtx.floorStack]
   * @param {object} [frameCtx.timeInfo]
   * @param {any} [frameCtx.renderBus] - the FloorRenderBus to render (V2's bus,
   *   reused: it holds the Z-unified floor geometry).
   * @param {any} [frameCtx.camera] - per-frame camera override (defaults to the
   *   constructor camera).
   * @param {object} [frameCtx.imports] - name → handle external resources to
   *   import for this frame (masks, sim RTs, vision RT).
   * @returns {{ order: string[], skipped: string[] }|null}
   */
  render(frameCtx = {}) {
    if (!this._initialized) return null;

    // Refresh the canonical day/night/sun state once per frame. V3 bypasses the
    // V2 render path where FloorCompositor calls this, so without it the lighting
    // pass would see only Foundry's raw darknessLevel — not MSA's merged
    // masterDarkness (calendar time-of-day + weather + priority policy). B2 GAP-A.
    // Runtime handle (not a static import) — see LightingDirector.js exposure note.
    try { globalThis.window?.MapShine?.lightingDirector?.update?.(); } catch (_) {}

    const size = this._resolveDrawingBufferSize();

    // Re-import per-frame external resources (mask products, sim RTs, vision).
    // clearImports() invalidates the compiled order; re-importing the same names
    // each frame keeps the graph stable (import set shape is constant).
    if (frameCtx.imports && typeof frameCtx.imports === 'object') {
      this._graph.clearImports();
      for (const [name, handle] of Object.entries(frameCtx.imports)) {
        this._graph.importResource(name, handle);
      }
    }

    try {
      return this._graph.execute({
        renderer: this.renderer,
        camera: frameCtx.camera ?? this.camera,
        width: size.width,
        height: size.height,
        floorStack: frameCtx.floorStack ?? null,
        timeInfo: frameCtx.timeInfo ?? null,
        renderBus: frameCtx.renderBus ?? null,
      });
    } catch (err) {
      this._lastError = err;
      log.warn('V3 frame execute threw', err);
      return null;
    }
  }

  /**
   * @returns {{width: number, height: number}}
   * @private
   */
  _resolveDrawingBufferSize() {
    const r = this.renderer;
    try {
      if (r && typeof r.getDrawingBufferSize === 'function') {
        const v = r.getDrawingBufferSize(this._THREE ? new this._THREE.Vector2() : { x: 0, y: 0 });
        return { width: Math.max(1, v.x | 0), height: Math.max(1, v.y | 0) };
      }
      if (r && typeof r.getSize === 'function') {
        const v = r.getSize(this._THREE ? new this._THREE.Vector2() : { x: 0, y: 0 });
        return { width: Math.max(1, v.x | 0), height: Math.max(1, v.y | 0) };
      }
    } catch (_) {}
    return { width: 1, height: 1 };
  }

  /**
   * Diagnostics for the crash/perf reports (Forward+ §14.1 principle 6).
   * @returns {{ ready: boolean, order: string[], timings: Array<[string, number]>, stats: object, impl: object, lastError: string|null }}
   */
  getDiagnostics() {
    let order = [];
    try { order = this._graph.getExecutionOrder(); } catch (_) {}
    return {
      ready: this.isReady(),
      order,
      timings: Array.from(this._graph.getLastTimings().entries()),
      stats: this._graph.getStats(),
      impl: { ...this._impl },
      lastError: this._lastError ? String(this._lastError.message ?? this._lastError) : null,
    };
  }

  dispose() {
    try { this._graph.dispose(); } catch (_) {}
    try { this._present.dispose(); } catch (_) {}
    try { this._lighting.dispose(); } catch (_) {}
    this._initialized = false;
  }
}

/** @type {V3Pipeline|null} Process-wide singleton (mirrors V2's global access). */
let _instance = null;

/**
 * Get (or lazily create) the V3 pipeline singleton. If a prior creation
 * deferred initialization (window.THREE not yet present), this retries it, so a
 * pipeline created before THREE loaded still comes online on a later frame.
 * @param {ConstructorParameters<typeof V3Pipeline>[0]} [options]
 * @returns {V3Pipeline|null}
 */
export function getV3Pipeline(options) {
  if (!_instance) {
    if (!options) return null;
    _instance = new V3Pipeline(options);
  }
  if (!_instance._initialized) {
    // Refresh THREE + renderer/camera from the latest options in case they were
    // absent at construction, then retry init (idempotent once initialized).
    if (options) {
      if (options.renderer) _instance.renderer = options.renderer;
      if (options.scene) _instance.scene = options.scene;
      if (options.camera) _instance.camera = options.camera;
      if (!_instance._THREE && (options.THREE ?? (typeof window !== 'undefined' ? window.THREE : null))) {
        _instance._THREE = options.THREE ?? window.THREE;
      }
    }
    _instance.initialize();
  }
  return _instance;
}

/** Tear down + clear the singleton (scene teardown). */
export function disposeV3Pipeline() {
  try { _instance?.dispose(); } catch (_) {}
  _instance = null;
}
