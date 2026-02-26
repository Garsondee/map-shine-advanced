/**
 * @fileoverview Effect composition and layering orchestrator
 * Manages effect dependencies, render order, and shared render targets
 * @module effects/EffectComposer
 */

import { createLogger } from '../core/log.js';
import { TimeManager } from '../core/time.js';
import { globalProfiler } from '../core/profiler.js';
import { globalLoadingProfiler } from '../core/loading-profiler.js';
import { getCacheStats as getAssetCacheStats } from '../assets/loader.js';
import { frameCoordinator } from '../core/frame-coordinator.js';
import { getGlobalFrameState } from '../core/frame-state.js';
import { FloorCompositor } from '../compositor-v2/FloorCompositor.js';

const log = createLogger('EffectComposer');

/**
 * Effect render layers (ordered by render sequence)
 */
export const RenderLayers = {
  BASE: { order: 0, name: 'Base', requiresDepth: false },
  MATERIAL: { order: 100, name: 'Material', requiresDepth: true },
  SURFACE_EFFECTS: { order: 200, name: 'SurfaceEffects', requiresDepth: true },
  PARTICLES: { order: 300, name: 'Particles', requiresDepth: true },
  ENVIRONMENTAL: { order: 400, name: 'Environmental', requiresDepth: false },
  POST_PROCESSING: { order: 500, name: 'PostProcessing', requiresDepth: false }
};

export const BLOOM_HOTSPOT_LAYER = 30;
export const OVERLAY_THREE_LAYER = 31;

/**
 * Layer for scene objects that must render exactly once per frame, in the
 * global scene pass that runs after the per-floor render loop completes.
 * Use this for world-space objects that are floor-agnostic (drawings, notes)
 * and must not be multi-composited (rendered once per floor) during the
 * floor loop. Objects on this layer are excluded from per-floor scene
 * renders and depth captures via camera.layers.disable(GLOBAL_SCENE_LAYER).
 */
export const GLOBAL_SCENE_LAYER = 29;

export const ROPE_MASK_LAYER = 25;

export const TILE_FEATURE_LAYERS = {
  CLOUD_SHADOW_BLOCKER: 23,
  CLOUD_TOP_BLOCKER: 24
};

/**
 * Effect Composer - orchestrates layered effect rendering
 */
export class EffectComposer {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    
    /** @type {Map<string, EffectBase>} */
    this.effects = new Map();
    
    /** @type {Map<string, THREE.RenderTarget>} */
    this.renderTargets = new Map();

    /** @type {Set<Object>} - Objects that need update(timeInfo) called every frame */
    this.updatables = new Set();

    /**
     * Sub-rate updatable lane tracking.
     * Maps each updatable with an `updateHz` property to its accumulated delta (seconds).
     * Updatables without `updateHz` (or updateHz <= 0) run every rendered frame.
     * @type {Map<Object, number>}
     */
    this._updatableAccum = new Map();

    // ── T2-B: Adaptive effect decimation ──────────────────────────────────
    // Track rolling average frame time and dynamically skip non-critical
    // effects when budget is exceeded. Hysteresis prevents oscillation.
    /** @type {number} Rolling exponential average of frame time (ms) */
    this._avgFrameTimeMs = 0;
    /** @type {boolean} Currently in degraded (decimation) mode */
    this._decimationActive = false;
    /** @type {number} Frame time threshold to enter decimation (ms) */
    this._decimationEnterMs = 20; // ~50 fps
    /** @type {number} Frame time threshold to exit decimation (ms) */
    this._decimationExitMs = 14; // ~71 fps — hysteresis band
    /** @type {number} EMA smoothing factor (0..1, higher = faster response) */
    this._decimationAlpha = 0.1;
    
    /** @type {GPUCapabilities} */
    this.capabilities = null;
    
    /** @type {THREE.RenderTarget} */
    this.sceneRenderTarget = null;

    // ── Per-Floor Rendering Pipeline (Phase 2) ──────────────────────────────
    // Lazily created by _ensureFloorRenderTargets() when the per-floor loop
    // is active. Enable isolated per-floor rendering with floor-scoped
    // post-processing and alpha compositing between floors.
    /** @type {THREE.WebGLRenderTarget|null} Per-floor geometry + scene effects */
    this._floorRT = null;
    /** @type {THREE.WebGLRenderTarget|null} Floor post-processing ping-pong A */
    this._floorPostA = null;
    /** @type {THREE.WebGLRenderTarget|null} Floor post-processing ping-pong B */
    this._floorPostB = null;
    /** @type {THREE.WebGLRenderTarget|null} Accumulated composited floor stack */
    this._accumulationRT = null;
    /** @type {THREE.Scene|null} Dedicated scene for floor compositing fullscreen quad */
    this._compositeScene = null;
    /** @type {THREE.OrthographicCamera|null} Camera for compositor renders */
    this._compositeCamera = null;
    /** @type {THREE.ShaderMaterial|null} Alpha-over compositing material */
    this._compositeMaterial = null;
    /** @type {THREE.Mesh|null} Fullscreen quad for floor compositing */
    this._compositeQuad = null;

    /** @type {TimeManager} - Centralized time management */
    this.timeManager = new TimeManager();

    /** @type {import('../scene/depth-pass-manager.js').DepthPassManager|null} */
    this._depthPassManager = null;

    // ── Compositor V2 ─────────────────────────────────────────────────────────
    // When the 'useCompositorV2' setting is enabled, the floor render loop is
    // delegated to FloorCompositor instead of the legacy floor loop below.
    // FloorCompositor uses Three.js layers for floor isolation (no per-frame
    // visibility toggling). Created lazily on first use.
    /** @type {FloorCompositor|null} */
    this._floorCompositorV2 = null;

    // PERFORMANCE: Cache for resolved render order to avoid per-frame allocations
    this._cachedRenderOrder = [];
    this._renderOrderDirty = true;
    
    // PERFORMANCE: Reusable arrays for scene/post effect splitting
    this._sceneEffects = [];
    this._postEffects = [];
    
    // Explicitly enable EXT_float_blend if available to suppress warnings
    try {
      if (renderer.extensions) {
        renderer.extensions.get('EXT_float_blend');
      }
    } catch (e) {
      // Ignore if extension not supported
    }
    
    log.info('EffectComposer created');
  }

  /**
   * Query whether the renderer should bypass idle throttling and render every RAF.
   * This is used for effects that animate continuously (e.g. particle systems)
   * so they don't appear "choppy" at the idle render rate.
   *
   * NOTE: This is intentionally cheap; it runs once per RAF in RenderLoop.
   *
   * @returns {boolean}
   */
  wantsContinuousRender() {
    // Compositor V2 path: effects are suppressed, but the V2 FloorCompositor
    // may still drive continuously-animated systems (e.g. quarks particles).
    // If it requests continuous rendering, honor it so animation doesn't
    // degrade to the idle FPS cap.
    try {
      if (this._checkCompositorV2Enabled && this._checkCompositorV2Enabled()) {
        const fc = this._floorCompositorV2;
        if (fc && typeof fc.wantsContinuousRender === 'function') {
          if (fc.wantsContinuousRender()) return true;
        }
      }
    } catch (_) {
      // Fail safe: if the probe throws, keep rendering continuously.
      return true;
    }

    for (const effect of this.effects.values()) {
      if (!effect || !effect.enabled) continue;
      if (!effect.requiresContinuousRender) continue;
      try {
        if (typeof effect.isActive === 'function') {
          if (!effect.isActive()) continue;
        }
      } catch (_) {
        // If an effect's isActive() throws, fail safe by treating it as active.
      }
      return true;
    }
    return false;
  }

  _renderOverlayToScreen() {
    const THREE = window.THREE;
    if (!THREE || !this.scene || !this.camera) return;

    const prevTarget = this.renderer.getRenderTarget();
    const prevAutoClear = this.renderer.autoClear;
    const prevMask = this.camera.layers.mask;

    try {
      this.renderer.setRenderTarget(null);
      this.renderer.autoClear = false;
      this.camera.layers.set(OVERLAY_THREE_LAYER);
      this.renderer.render(this.scene, this.camera);
    } finally {
      this.camera.layers.mask = prevMask;
      this.renderer.autoClear = prevAutoClear;
      this.renderer.setRenderTarget(prevTarget);
    }
  }

  /**
   * Initialize the composer with GPU capabilities
   * @param {GPUCapabilities} capabilities - GPU capability info
   */
  initialize(capabilities) {
    this.capabilities = capabilities;
    log.info(`EffectComposer initialized (GPU tier: ${capabilities.tier})`);
  }

  /**
   * Ensure scene render target exists and is sized correctly
   * @private
   */
  ensureSceneRenderTarget() {
    // PERFORMANCE: Reuse Vector2 instead of allocating every frame
    if (!this._sizeVec2) this._sizeVec2 = new window.THREE.Vector2();
    const size = this._sizeVec2;
    this.renderer.getDrawingBufferSize(size);
    
    if (!this.sceneRenderTarget) {
      this.sceneRenderTarget = new window.THREE.WebGLRenderTarget(size.width, size.height, {
        minFilter: window.THREE.LinearFilter,
        magFilter: window.THREE.LinearFilter,
        format: window.THREE.RGBAFormat,
        type: window.THREE.FloatType, // Use FloatType for HDR if possible
        depthBuffer: true
      });
      log.debug(`Created scene render target: ${size.width}x${size.height}`);
    } else if (this.sceneRenderTarget.width !== size.width || this.sceneRenderTarget.height !== size.height) {
      this.sceneRenderTarget.setSize(size.width, size.height);
      log.debug(`Resized scene render target to: ${size.width}x${size.height}`);
    }
  }

  /**
   * Ensure per-floor render targets exist and are sized correctly.
   * Called lazily when the per-floor render loop is active. Each floor renders
   * into _floorRT in isolation, floor-scoped post effects ping-pong between
   * _floorPostA/_floorPostB, and the final floor image is alpha-composited
   * into _accumulationRT.
   * @private
   */
  _ensureFloorRenderTargets() {
    if (!this._sizeVec2) this._sizeVec2 = new window.THREE.Vector2();
    const size = this._sizeVec2;
    this.renderer.getDrawingBufferSize(size);
    const w = size.width;
    const h = size.height;
    const THREE = window.THREE;

    const _ensureRT = (existing, label, depth) => {
      if (!existing) {
        const rt = new THREE.WebGLRenderTarget(w, h, {
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          format: THREE.RGBAFormat,
          type: THREE.FloatType,
          depthBuffer: !!depth,
          stencilBuffer: false,
        });
        log.debug(`Created floor RT: ${label} (${w}x${h})`);
        return rt;
      }
      if (existing.width !== w || existing.height !== h) {
        existing.setSize(w, h);
      }
      return existing;
    };

    // Floor geometry RT needs a depth buffer for Z-tested scene rendering.
    this._floorRT = _ensureRT(this._floorRT, '_floorRT', true);
    // Post-processing ping-pong buffers don't need depth.
    this._floorPostA = _ensureRT(this._floorPostA, '_floorPostA', false);
    this._floorPostB = _ensureRT(this._floorPostB, '_floorPostB', false);
    // Accumulation RT receives alpha-composited floor images.
    this._accumulationRT = _ensureRT(this._accumulationRT, '_accumulationRT', false);
  }

  /**
   * Alpha-composite a floor's completed image over the accumulation RT.
   *
   * Uses standard alpha-over blending (non-premultiplied):
   *   result.rgb = floor.rgb * floor.a + accum.rgb * (1 - floor.a)
   *   result.a   = floor.a + accum.a * (1 - floor.a)
   *
   * The compositor quad, scene, and camera are lazily created on first call
   * and reused for all subsequent compositing operations.
   *
   * @param {THREE.WebGLRenderTarget} floorInputRT - The completed floor image
   * @private
   */
  _compositeFloorToAccumulation(floorInputRT) {
    const THREE = window.THREE;

    // Lazily build the compositor infrastructure.
    if (!this._compositeMaterial) {
      this._compositeMaterial = new THREE.ShaderMaterial({
        uniforms: { tFloor: { value: null } },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = vec4(position.xy, 0.0, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform sampler2D tFloor;
          varying vec2 vUv;
          void main() {
            vec4 c = texture2D(tFloor, vUv);
            // Enforce premultiplied-alpha invariant: RGB must be 0 when alpha is 0.
            // The lighting shader adds ambient/darkness to ALL pixels including those
            // with alpha=0 (transparent tile regions). Without this clamp, the non-zero
            // RGB leaks through One/OneMinusSrcAlpha compositing and brightens the
            // ground floor beneath upper floors.
            c.rgb *= step(0.004, c.a);
            gl_FragColor = c;
          }
        `,
        depthTest: false,
        depthWrite: false,
        // Premultiplied alpha-over compositing:
        //   result.rgb = src.rgb + dst.rgb * (1 - src.a)
        //   result.a   = src.a   + dst.a   * (1 - src.a)
        // _floorRT content is premultiplied: SpriteMaterial uses NormalBlending
        // (SrcAlpha/OneMinusSrcAlpha) into a cleared (0,0,0,0) RT, which produces
        // premultiplied RGBA. LightingEffect preserves this. So the compositor
        // must use One (not SrcAlpha) to avoid double-premultiplying.
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.OneFactor,
        blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
        blendEquation: THREE.AddEquation,
      });
      const geom = new THREE.PlaneGeometry(2, 2);
      this._compositeQuad = new THREE.Mesh(geom, this._compositeMaterial);
      this._compositeQuad.frustumCulled = false;
      this._compositeScene = new THREE.Scene();
      this._compositeScene.add(this._compositeQuad);
      this._compositeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    }

    this._compositeMaterial.uniforms.tFloor.value = floorInputRT.texture;

    const prevAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.setRenderTarget(this._accumulationRT);
    this.renderer.render(this._compositeScene, this._compositeCamera);
    this.renderer.autoClear = prevAutoClear;
  }

  /**
   * Clip upper-floor alpha using the outdoors mask from LightingEffect.
   *
   * Upper-floor tile images span the full scene rect but only contain room
   * artwork in parts — the remainder is an opaque grey/grid fill (alpha 1.0).
   * LightingEffect's outdoorsTarget is a screen-space RT whose R channel is
   * 1.0 for outdoor pixels (no roof at this elevation) and 0.0 for indoor.
   * Multiplying the floor RT's alpha by (1.0 − outdoors) zeroes out outdoor
   * areas so lower floors show through during alpha compositing.
   *
   * Only called for floor index > 0 (the ground floor keeps its full opacity).
   *
   * @param {THREE.WebGLRenderTarget} floorInputRT - The floor's post-processed image
   * @returns {THREE.WebGLRenderTarget} RT containing the clipped image (may differ from input)
   * @private
   */
  _applyFloorAlphaClip(floorInputRT) {
    const THREE = window.THREE;

    // Find LightingEffect's screen-space outdoors projection.
    const lightingEffect = this.effects.get('lighting');
    const outdoorsRT = lightingEffect?.outdoorsTarget;
    if (!outdoorsRT?.texture) return floorInputRT; // No outdoors data — skip clip

    // Lazily create the alpha-clip shader material.
    if (!this._floorAlphaClipMaterial) {
      this._floorAlphaClipMaterial = new THREE.ShaderMaterial({
        uniforms: {
          tFloor: { value: null },
          tOutdoors: { value: null },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = vec4(position.xy, 0.0, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform sampler2D tFloor;
          uniform sampler2D tOutdoors;
          varying vec2 vUv;
          void main() {
            vec4 color = texture2D(tFloor, vUv);
            // Sample the alpha channel of the outdoors mask, NOT the red channel.
            // The outdoors WebP has transparent areas where the floor tile doesn't
            // exist (alpha=0) and opaque areas where it does (alpha=1). The RGB is
            // all-black for an all-indoors floor, so .r was always 0 and the clip
            // never fired. Alpha is the correct channel for floor boundary clipping.
            float floorCoverage = texture2D(tOutdoors, vUv).a;
            floorCoverage = smoothstep(0.05, 0.5, floorCoverage);
            color.a *= floorCoverage;
            gl_FragColor = color;
          }
        `,
        depthTest: false,
        depthWrite: false,
      });
    }

    // Ensure compositor quad exists (created by _compositeFloorToAccumulation).
    if (!this._compositeQuad) return floorInputRT;

    // Pick an output RT that isn't the input (ping-pong).
    const clipOut = (floorInputRT === this._floorPostA) ? this._floorPostB
                  : (floorInputRT === this._floorPostB) ? this._floorPostA
                  : this._floorPostA;

    this._floorAlphaClipMaterial.uniforms.tFloor.value = floorInputRT.texture;
    this._floorAlphaClipMaterial.uniforms.tOutdoors.value = outdoorsRT.texture;

    // Swap material on the compositor quad, render, restore.
    const prevMaterial = this._compositeQuad.material;
    this._compositeQuad.material = this._floorAlphaClipMaterial;

    this.renderer.setRenderTarget(clipOut);
    this.renderer.clear();
    this.renderer.render(this._compositeScene, this._compositeCamera);

    this._compositeQuad.material = prevMaterial;
    return clipOut;
  }

  /**
   * Blit (copy) a render target to the screen without any blending.
   * Used when the floor loop completes and no global post effects need to run.
   * @param {THREE.WebGLRenderTarget} sourceRT
   * @private
   */
  _blitToScreen(sourceRT) {
    const THREE = window.THREE;

    // Ensure compositor infrastructure exists (normally already created by
    // _compositeFloorToAccumulation, but guard against edge cases).
    if (!this._compositeMaterial) {
      this._compositeFloorToAccumulation(sourceRT);
      return;
    }

    // The accumulation RT contains premultiplied-alpha content. Use the same
    // One/OneMinusSrcAlpha blend to composite over the Foundry canvas so that
    // transparent areas (scene padding) let the Foundry background show through,
    // while opaque areas overwrite it correctly.
    this._compositeMaterial.uniforms.tFloor.value = sourceRT.texture;

    this.renderer.setRenderTarget(null);
    this.renderer.render(this._compositeScene, this._compositeCamera);
  }

  /**
   * Register an effect for rendering
   * @param {EffectBase} effect - Effect instance
   * @returns {Promise<void>} Resolves when effect is fully initialized
   */
  async registerEffect(effect) {
    if (this.effects.has(effect.id)) {
      log.warn(`Effect already registered: ${effect.id}`);
      return;
    }

    // Check GPU tier requirements
    if (!this.meetsRequirements(effect)) {
      log.warn(`Effect ${effect.id} requires higher GPU tier, skipping`);
      return;
    }

    this.effects.set(effect.id, effect);
    const lp = globalLoadingProfiler;
    const doLoadProfile = !!lp?.enabled;
    if (doLoadProfile) {
      try {
        lp.begin(`effect:${effect.id}:initialize`, { layer: effect?.layer?.name ?? null, requiredTier: effect?.requiredTier ?? null });
      } catch (e) {
      }
    }
    try {
      await effect.initialize(this.renderer, this.scene, this.camera);
    } finally {
      if (doLoadProfile) {
        try {
          lp.end(`effect:${effect.id}:initialize`);
        } catch (e) {
        }
      }
    }
    this.invalidateRenderOrder();
    
    log.info(`Effect registered: ${effect.id} (layer: ${effect.layer.name})`);
  }

  /**
   * P1.2: Register multiple effects in parallel with concurrency control.
   *
   * Preserves deterministic render order by inserting all effects into the Map
   * synchronously (in array order) before any initialization begins. Then
   * initializes them concurrently, limited to `concurrency` simultaneous
   * `initialize()` calls to avoid overwhelming the GPU with shader compilations.
   *
   * @param {EffectBase[]} effects - Array of effect instances to register
   * @param {object} [opts] - Options
   * @param {number} [opts.concurrency=4] - Max simultaneous initializations
   * @param {function} [opts.onProgress] - Called after each effect finishes: (completedCount, totalCount, effectId)
   * @param {Set<string>} [opts.skipIds] - Effect IDs to defer initialization for (P2.1 lazy init). These effects are added to the Map but not initialized; they get enabled=false and _lazyInitPending=true.
   * @returns {Promise<{registered: string[], skipped: string[], deferred: string[], timings: Array<{id: string, durationMs: number}>}>}
   */
  async registerEffectBatch(effects, opts = {}) {
    const concurrency = Math.max(1, opts?.concurrency ?? 4);
    const onProgress = typeof opts?.onProgress === 'function' ? opts.onProgress : null;
    const skipIds = opts?.skipIds instanceof Set ? opts.skipIds : null;

    const toInit = [];
    const skipped = [];
    const deferred = [];

    // Phase 1: Synchronous insertion — preserves deterministic Map order
    for (const effect of effects) {
      if (this.effects.has(effect.id)) {
        log.warn(`Effect already registered (batch): ${effect.id}`);
        skipped.push(effect.id);
        continue;
      }
      if (!this.meetsRequirements(effect)) {
        log.warn(`Effect ${effect.id} requires higher GPU tier, skipping (batch)`);
        skipped.push(effect.id);
        continue;
      }
      this.effects.set(effect.id, effect);

      // P2.1: Defer initialization for effects the user has disabled via Graphics Settings.
      // They remain in the Map (preserving render order) but won't compile shaders until
      // the user re-enables them via ensureEffectInitialized().
      if (skipIds && skipIds.has(effect.id)) {
        effect.enabled = false;
        effect._lazyInitPending = true;
        deferred.push(effect.id);
        log.debug(`Effect deferred (lazy init): ${effect.id}`);
        continue;
      }

      toInit.push(effect);
    }

    // Phase 2: Parallel initialization with concurrency limit
    const lp = globalLoadingProfiler;
    const doLoadProfile = !!lp?.enabled;
    const timings = [];
    let completed = 0;
    const total = toInit.length;

    // Simple semaphore for concurrency control
    let running = 0;
    const queue = [];
    const acquire = () => {
      if (running < concurrency) { running++; return Promise.resolve(); }
      return new Promise(resolve => queue.push(resolve));
    };
    const release = () => {
      running--;
      const next = queue.shift();
      if (next) { running++; next(); }
    };

    const initPromises = toInit.map(async (effect) => {
      await acquire();
      const t0 = performance.now();
      const spanId = doLoadProfile ? `effect:${effect.id}:initialize` : null;
      if (doLoadProfile) {
        try { lp.begin(spanId, { layer: effect?.layer?.name ?? null, requiredTier: effect?.requiredTier ?? null, batch: true }); } catch (_) {}
      }
      try {
        await effect.initialize(this.renderer, this.scene, this.camera);
      } finally {
        if (doLoadProfile) {
          try { lp.end(spanId); } catch (_) {}
        }
        release();
      }
      const dt = performance.now() - t0;
      timings.push({ id: effect.id, durationMs: dt });
      completed++;
      if (onProgress) {
        try { onProgress(completed, total, effect.id); } catch (_) {}
      }
      log.debug(`Effect initialized (batch): ${effect.id} (${dt.toFixed(1)}ms)`);
    });

    await Promise.all(initPromises);
    this.invalidateRenderOrder();

    const registered = toInit.map(e => e.id);
    if (deferred.length > 0) {
      log.info(`Batch registered ${registered.length} effects, deferred ${deferred.length} (lazy), ${skipped.length} skipped, concurrency=${concurrency}`);
    } else {
      log.info(`Batch registered ${registered.length} effects (${skipped.length} skipped), concurrency=${concurrency}`);
    }
    return { registered, skipped, deferred, timings };
  }

  /**
   * P2.1: Lazily initialize an effect that was deferred during batch registration.
   * Call this when the user re-enables a previously-disabled effect via Graphics Settings.
   *
   * @param {string} effectId - The effect ID to initialize
   * @returns {Promise<boolean>} true if initialization succeeded, false if not needed or failed
   */
  async ensureEffectInitialized(effectId) {
    const effect = this.effects.get(effectId);
    if (!effect) return false;
    if (!effect._lazyInitPending) return true; // Already initialized

    const t0 = performance.now();
    try {
      await effect.initialize(this.renderer, this.scene, this.camera);
      effect._lazyInitPending = false;
      this.invalidateRenderOrder();
      const dt = performance.now() - t0;
      log.info(`Lazy-initialized effect: ${effectId} (${dt.toFixed(1)}ms)`);
      return true;
    } catch (e) {
      log.error(`Failed to lazy-initialize effect: ${effectId}`, e);
      return false;
    }
  }

  /**
   * Unregister an effect
   * @param {string} effectId - Effect ID to remove
   */
  unregisterEffect(effectId) {
    const effect = this.effects.get(effectId);
    if (!effect) {
      log.warn(`Effect not found: ${effectId}`);
      return;
    }

    effect.dispose();
    this.effects.delete(effectId);
    this.invalidateRenderOrder();
    log.info(`Effect unregistered: ${effectId}`);
  }

  /**
   * Check if effect meets GPU tier requirements
   * @param {EffectBase} effect - Effect to check
   * @returns {boolean} Whether requirements are met
   * @private
   */
  meetsRequirements(effect) {
    if (!this.capabilities) return true;

    const tierLevels = { low: 1, medium: 2, high: 3 };
    const requiredLevel = tierLevels[effect.requiredTier] || 1;
    const currentLevel = tierLevels[this.capabilities.tier] || 1;

    return currentLevel >= requiredLevel;
  }

  /**
   * Register an object to be updated every frame
   * @param {Object} updatable - Object with update(timeInfo) method
   */
  addUpdatable(updatable) {
    if (this.updatables.has(updatable)) return;
    
    if (typeof updatable.update !== 'function') {
      log.error('Updatable object must have an update(timeInfo) method');
      return;
    }
    
    this.updatables.add(updatable);
    log.debug('Updatable registered');
  }

  /**
   * Remove an updatable object
   * @param {Object} updatable - Object to remove
   */
  removeUpdatable(updatable) {
    this.updatables.delete(updatable);
    this._updatableAccum.delete(updatable);
  }

  /**
   * Mark render order as needing recalculation (call when effects change)
   */
  invalidateRenderOrder() {
    this._renderOrderDirty = true;
  }

  /**
   * Resolve effect dependencies and determine render order
   * PERFORMANCE: Caches result to avoid per-frame array allocations
   * @returns {EffectBase[]} Sorted effects ready for rendering
   * @private
   */
  resolveRenderOrder() {
    // PERFORMANCE: Only rebuild if dirty
    // Note: We always rebuild to catch enabled state changes - the cost is minimal
    // compared to the bugs from stale caches. The main savings is reusing the array.
    
    // Rebuild the cached order (reuse array to avoid allocation)
    this._cachedRenderOrder.length = 0;
    for (const effect of this.effects.values()) {
      if (effect.enabled) {
        this._cachedRenderOrder.push(effect);
      }
    }

    // Sort by layer order, then by effect priority
    this._cachedRenderOrder.sort((a, b) => {
      if (a.layer.order !== b.layer.order) {
        return a.layer.order - b.layer.order;
      }
      return (a.priority || 0) - (b.priority || 0);
    });

    return this._cachedRenderOrder;
  }

  /**
   * Render all effects in proper order
   * @param {number} deltaTime - Time since last frame in seconds (from RenderLoop, informational only)
   */
  render(deltaTime) {
    const _frameStartMs = performance.now(); // T2-B: measure frame time for decimation
    const effects = this.resolveRenderOrder();

    // Update centralized time (single source of truth)
    const timeInfo = this.timeManager.update();

    // P3.2: Update frame-consistent camera state
    // All screen-space effects should use this snapshot for consistent sampling
    try {
      const frameState = getGlobalFrameState();
      const sceneComposer = window.MapShine?.sceneComposer;
      frameState.update(this.camera, sceneComposer, canvas, timeInfo.frameCount, timeInfo.delta);
    } catch (e) {
      // Frame state update is non-critical; ignore errors
    }

    const profiler = globalProfiler;
    const doProfile = !!profiler?.enabled;
    if (doProfile) profiler.beginFrame(timeInfo);

    if (doProfile) {
      try {
        const now = performance.now();
        if (profiler.shouldRecordResourceSample(now)) {
          const info = this.renderer?.info;
          const cache = (() => {
            try {
              return getAssetCacheStats();
            } catch (e) {
              return null;
            }
          })();
          const fc = (() => {
            try {
              return frameCoordinator?.getMetrics?.() ?? null;
            } catch (e) {
              return null;
            }
          })();

          const mem = (() => {
            try {
              const m = performance?.memory;
              if (!m) return null;
              return {
                jsHeapSizeLimit: m.jsHeapSizeLimit,
                totalJSHeapSize: m.totalJSHeapSize,
                usedJSHeapSize: m.usedJSHeapSize
              };
            } catch (e) {
              return null;
            }
          })();

          profiler.maybeRecordResourceSample({
            renderer: info ? {
              render: info.render ? {
                calls: info.render.calls,
                triangles: info.render.triangles,
                lines: info.render.lines,
                points: info.render.points
              } : null,
              memory: info.memory ? {
                geometries: info.memory.geometries,
                textures: info.memory.textures
              } : null,
              programs: Array.isArray(info.programs) ? info.programs.length : null
            } : null,
            assetCache: cache,
            frameCoordinator: fc,
            perfMemory: mem,
            effectCount: this.effects?.size ?? null,
            renderTargets: this.renderTargets?.size ?? null
          }, now);
        }
      } catch (e) {
      }
    }

    // ── COMPOSITOR V2 BREAKER FUSE ─────────────────────────────────────────
    // When V2 is active, it is the SOLE renderer. Visual effects are suppressed:
    //   - No effect.prepareFrame()
    //   - No effect sorting or rendering
    //   - No _renderOverlayToScreen()
    //   - No _renderDepthDebugOverlay()
    // Updatables DO still run — but only ESSENTIAL ones are registered when V2
    // is active (CameraFollower, InteractionManager, TileManager, GridRenderer,
    // DoorMeshManager). Effect-related updatables (WeatherController, DepthPass,
    // TileMotion, PhysicsRopes, DynamicExposure, DetectionFilter) are gated out
    // during createThreeCanvas() via the _v2Active flag.
    // See docs/planning/V2-MILESTONE-1-ALBEDO-ONLY.md for full rationale.
    {
      const _floorStackEarly = window.MapShine?.floorStack ?? null;
      if (this._checkCompositorV2Enabled() && _floorStackEarly !== null) {
        // ── Run updatables (camera, interaction, movement, etc.) ──────────
        for (const updatable of this.updatables) {
          try {
            const hz = updatable.updateHz;
            if (hz > 0) {
              const accum = (this._updatableAccum.get(updatable) || 0) + timeInfo.delta;
              const interval = 1.0 / hz;
              if (accum < interval) {
                this._updatableAccum.set(updatable, accum);
                continue;
              }
              this._updatableAccum.set(updatable, accum % interval);
            }
            let t0 = 0;
            if (doProfile) t0 = performance.now();
            updatable.update(timeInfo);
            if (doProfile) {
              const dt = performance.now() - t0;
              const name = updatable?.constructor?.name || updatable?.id || 'updatable';
              profiler.recordUpdatable(name, dt);
            }
          } catch (error) {
            log.error('Error updating updatable (V2 path):', error);
          }
        }

        // ── Render: FloorCompositor only (no effects, no overlay) ─────────
        const _compositorV2 = this._getFloorCompositorV2();
        _compositorV2.render({
          floorStack: _floorStackEarly,
          timeInfo,
          doProfile,
          profiler,
        });
        if (doProfile) profiler.endFrame();
        this._updateDecimationState(performance.now() - _frameStartMs);
        return;
      }
    }

    // ── Legacy render path below ─────────────────────────────────────────────
    // Everything below this point only runs when V2 is DISABLED.

    // Update registered updatables (managers, etc.)
    // Sub-rate lanes: updatables with an `updateHz` property only run when their
    // accumulated delta exceeds the interval (1/updateHz). This avoids running
    // slow-changing systems at the full render rate.
    for (const updatable of this.updatables) {
      try {
        const hz = updatable.updateHz;
        if (hz > 0) {
          const accum = (this._updatableAccum.get(updatable) || 0) + timeInfo.delta;
          const interval = 1.0 / hz;
          if (accum < interval) {
            this._updatableAccum.set(updatable, accum);
            continue; // skip this frame — not enough time has accumulated
          }
          // Reset accumulator (keep remainder for smooth pacing)
          this._updatableAccum.set(updatable, accum % interval);
        }

        let t0 = 0;
        if (doProfile) t0 = performance.now();
        updatable.update(timeInfo);
        if (doProfile) {
          const dt = performance.now() - t0;
          const name = updatable?.constructor?.name || updatable?.id || 'updatable';
          profiler.recordUpdatable(name, dt);
        }
      } catch (error) {
        log.error('Error updating updatable:', error);
      }
    }

    // Split effects into scene (in-world) and post-processing
    // PERFORMANCE: Reuse arrays instead of allocating new ones every frame
    const sceneEffects = this._sceneEffects;
    const postEffects = this._postEffects;
    sceneEffects.length = 0;
    postEffects.length = 0;

    for (const effect of effects) {
      // Check if effect should render this frame (for performance gating)
      if (!this.shouldRenderThisFrame(effect, timeInfo)) continue;

      if (effect.layer && effect.layer.order >= RenderLayers.POST_PROCESSING.order) {
        postEffects.push(effect);
      } else {
        sceneEffects.push(effect);
      }
    }

    // PRE-FRAME: Advance time-based simulations once per frame, before any
    // per-floor work begins. This ensures simulation state (wave phase, cloud
    // drift, particle lifetimes, etc.) advances at 1× speed even when the
    // floor loop calls update() multiple times per frame in Phase 2.
    // Effects that have no independent simulation leave prepareFrame() as a no-op.
    for (const effect of effects) {
      if (!effect.enabled) continue;
      try {
        effect.prepareFrame(timeInfo);
      } catch (error) {
        log.error(`Effect prepareFrame error (${effect.id}):`, error);
      }
    }

    // ── SCENE RENDER PATH ────────────────────────────────────────────────────
    // Per-floor rendering (experimentalFloorRendering setting): each visible
    // floor renders into an isolated RT, receives floor-scoped post-processing
    // (water, distortion, fog, lighting), then alpha-composites bottom→top into
    // an accumulation buffer. Global post effects run once on the final composite.
    // Legacy path: single depth capture + PASS 0 + one scene render + PASS 2.
    const _floorStack = window.MapShine?.floorStack ?? null;
    const _useFloorLoop = this._checkFloorLoopEnabled() && _floorStack !== null;
    const usePostProcessing = postEffects.length > 0;
    if (usePostProcessing && Math.random() < 0.005) {
      log.debug('Rendering with Post-Processing', { postEffects: postEffects.map(e => e.id), sceneEffects: sceneEffects.length });
    }

    // ── Compositor V2 delegation (MOVED) ──────────────────────────────────────
    // V2 early-exit is now at the TOP of render() (the "breaker fuse").
    // If V2 is active, execution never reaches this point — it returned above
    // before updatables, effects, or any other system could run.
    // This block is kept as documentation; the old code has been removed.

    if (_useFloorLoop) {
      // ── Per-Floor Isolated Rendering ──────────────────────────────────────────
      // Each visible floor renders into an isolated RT, receives floor-scoped
      // post-processing (water, distortion, fog, lighting), then alpha-composites
      // into an accumulation buffer. This isolates floor-specific effects so they
      // cannot bleed across floor boundaries. Global post effects (bloom, color
      // correction, etc.) run once on the final composite.
      this._ensureFloorRenderTargets();

      // Split scene effects and post effects into floor-scoped and global-scoped.
      const _floorSceneEffects = sceneEffects.filter(e => e.floorScope !== 'global');
      const _globalSceneEffects = sceneEffects.filter(e => e.floorScope === 'global');
      const _floorPostEffects = postEffects.filter(e => e.floorScope !== 'global');
      const _globalPostEffects = postEffects.filter(e => e.floorScope === 'global');

      const _floors = _floorStack.getVisibleFloors();
      const _maskCompositor = window.MapShine?.sceneComposer?._sceneMaskCompositor ?? null;

      // ALL floor-scoped effects that implement bindFloorMasks — including
      // POST_PROCESSING effects (water, distortion, fog, lighting). Per-floor RT
      // isolation means each floor's post effects operate on that floor's image
      // exclusively, so cross-floor bleed is impossible by construction.
      const _allBindableFloorEffects = [];
      for (const _e of this.effects.values()) {
        if (_e.floorScope !== 'global' && typeof _e.bindFloorMasks === 'function') {
          _allBindableFloorEffects.push(_e);
        }
      }

      // Clear accumulation RT to transparent black before compositing floors.
      const _prevClearColor = this.renderer.getClearColor(new window.THREE.Color());
      const _prevClearAlpha = this.renderer.getClearAlpha();
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.setRenderTarget(this._accumulationRT);
      this.renderer.clear();

      if (_floors.length > 0) {
        for (let _fi = 0; _fi < _floors.length; _fi++) {
          const _floor = _floors[_fi];
          const _floorBundle = _maskCompositor?._floorMeta?.get(_floor.compositorKey) ?? null;

          // 1. Isolate this floor's geometry.
          _floorStack.setFloorVisible(_floor.index);

          // 2. Per-floor depth capture (GLOBAL_SCENE_LAYER disabled).
          const _depthPrevMask = this.camera.layers.mask;
          this.camera.layers.disable(GLOBAL_SCENE_LAYER);
          if (this._depthPassManager) {
            try { this._depthPassManager.captureForFloor(); }
            catch (_e) { log.error('Per-floor depth capture failed:', _e); }
          }
          this.camera.layers.mask = _depthPrevMask;

          // 3. Bind floor-specific masks for ALL floor-scoped effects (scene + post).
          for (const _eff of _allBindableFloorEffects) {
            try { _eff.bindFloorMasks(_floorBundle, _floor.compositorKey); }
            catch (_e) { log.error(`bindFloorMasks error (${_eff.id}):`, _e); }
          }

          // 4. Floor-scoped scene effects update + render.
          for (const _eff of _floorSceneEffects) {
            try {
              let _t = 0; if (doProfile) _t = performance.now();
              _eff.update(timeInfo); if (doProfile) profiler.recordEffectUpdate(_eff.id, performance.now() - _t);
              if (doProfile) _t = performance.now();
              _eff.render(this.renderer, this.scene, this.camera); if (doProfile) profiler.recordEffectRender(_eff.id, performance.now() - _t);
            } catch (_e) { log.error(`Floor scene effect error (${_eff.id}):`, _e); this.handleEffectError(_eff, _e); }
          }

          // 5. Render floor geometry into _floorRT (cleared to transparent black).
          this.renderer.setRenderTarget(this._floorRT);
          this.renderer.clear();
          const _scenePrevMask = this.camera.layers.mask;
          try {
            this.camera.layers.disable(OVERLAY_THREE_LAYER);
            this.camera.layers.disable(GLOBAL_SCENE_LAYER);
            this.renderer.render(this.scene, this.camera);
          } finally { this.camera.layers.mask = _scenePrevMask; }

          // 6. Floor-scoped post effects ping-pong on the floor's isolated image.
          //    Each effect reads from _fpIn and writes to _fpOut. The final output
          //    is tracked by _floorFinalRT for compositing.
          let _floorFinalRT = this._floorRT;
          if (_floorPostEffects.length > 0) {
            let _fpIn = this._floorRT;
            let _fpOut = this._floorPostA;
            for (let _pi = 0; _pi < _floorPostEffects.length; _pi++) {
              const _pe = _floorPostEffects[_pi];
              try {
                let _t = 0; if (doProfile) _t = performance.now();
                _pe.update(timeInfo); if (doProfile) profiler.recordEffectUpdate(_pe.id, performance.now() - _t);
                if (typeof _pe.setInputTexture === 'function') _pe.setInputTexture(_fpIn.texture);
                if (typeof _pe.setRenderToScreen === 'function') _pe.setRenderToScreen(false);
                if (typeof _pe.setBuffers === 'function') _pe.setBuffers(_fpIn, _fpOut);
                this.renderer.setRenderTarget(_fpOut);
                this.renderer.clear();
                if (doProfile) _t = performance.now();
                _pe.render(this.renderer, this.scene, this.camera); if (doProfile) profiler.recordEffectRender(_pe.id, performance.now() - _t);
              } catch (_e) { log.error(`Floor post effect error (${_pe.id}):`, _e); this.handleEffectError(_pe, _e); }
              _floorFinalRT = _fpOut;
              if (_pi < _floorPostEffects.length - 1) {
                _fpIn = _fpOut;
                _fpOut = (_fpIn === this._floorPostA) ? this._floorPostB : this._floorPostA;
              }
            }
          }

          // 6b. Alpha-clip upper floors using the floorAlpha mask.
          //     The floorAlpha mask (from GpuSceneMaskCompositor) encodes where the
          //     upper floor tile has opaque coverage (R=1) vs transparent gaps (R=0).
          //     Multiplying the floor RT alpha by this mask zeroes out transparent
          //     regions so the ground floor shows through during compositing.
          //     We use floorAlpha rather than the outdoors mask because upper floors
          //     typically have no _Outdoors companion file — the outdoors mask would
          //     be null/all-black and fail to clip anything.
          if (_floor.index > 0) {
            _floorFinalRT = this._applyFloorAlphaClip(_floorFinalRT);
          }

          // 7. Alpha-composite this floor's completed image into the accumulation buffer.
          this._compositeFloorToAccumulation(_floorFinalRT);
        }
        // Restore Levels-driven visibility after all floors.
        _floorStack.restoreVisibility();
      } else {
        // No floors — single full-scene render into accumulation as fallback.
        this.renderer.setRenderTarget(this._accumulationRT);
        const _fbPrevMask = this.camera.layers.mask;
        try { this.camera.layers.disable(OVERLAY_THREE_LAYER); this.renderer.render(this.scene, this.camera); }
        finally { this.camera.layers.mask = _fbPrevMask; }
      }

      // Restore renderer clear color.
      this.renderer.setClearColor(_prevClearColor, _prevClearAlpha);

      // Global-scoped scene effects run once on the accumulated image.
      for (const _eff of _globalSceneEffects) {
        try {
          let _t = 0; if (doProfile) _t = performance.now();
          _eff.update(timeInfo); if (doProfile) profiler.recordEffectUpdate(_eff.id, performance.now() - _t);
          if (doProfile) _t = performance.now();
          _eff.render(this.renderer, this.scene, this.camera); if (doProfile) profiler.recordEffectRender(_eff.id, performance.now() - _t);
        } catch (_e) { log.error(`Global scene effect error (${_eff.id}):`, _e); this.handleEffectError(_eff, _e); }
      }

      // Global post-processing on the accumulated image → screen.
      if (_globalPostEffects.length > 0) {
        let _gpIn = this._accumulationRT;
        let _gpOut = this.getRenderTarget('post_1', _gpIn.width, _gpIn.height, false);
        const _gpPing = this.getRenderTarget('post_2', _gpIn.width, _gpIn.height, false);
        for (let _gi = 0; _gi < _globalPostEffects.length; _gi++) {
          const _ge = _globalPostEffects[_gi];
          const _isLast = _gi === _globalPostEffects.length - 1;
          const _target = _isLast ? null : _gpOut;
          try {
            let _t = 0; if (doProfile) _t = performance.now();
            _ge.update(timeInfo); if (doProfile) profiler.recordEffectUpdate(_ge.id, performance.now() - _t);
            if (typeof _ge.setInputTexture === 'function') _ge.setInputTexture(_gpIn.texture);
            if (typeof _ge.setRenderToScreen === 'function') _ge.setRenderToScreen(_isLast);
            if (typeof _ge.setBuffers === 'function') _ge.setBuffers(_gpIn, _target);
            this.renderer.setRenderTarget(_target);
            if (_target) this.renderer.clear();
            if (doProfile) _t = performance.now();
            _ge.render(this.renderer, this.scene, this.camera); if (doProfile) profiler.recordEffectRender(_ge.id, performance.now() - _t);
          } catch (_e) { log.error(`Global post effect error (${_ge.id}):`, _e); this.handleEffectError(_ge, _e); }
          if (!_isLast) {
            _gpIn = _gpOut;
            _gpOut = (_gpIn === this.getRenderTarget('post_1')) ? _gpPing : this.getRenderTarget('post_1');
          }
        }
      } else {
        // No global post effects — blit accumulation to screen.
        this._blitToScreen(this._accumulationRT);
      }

      this._renderOverlayToScreen();
      this._renderDepthDebugOverlay();
      if (doProfile) profiler.endFrame();
      this._updateDecimationState(performance.now() - _frameStartMs);
      return;
    }

    // ── Legacy single-pass path (floor loop disabled) ──────────────────────────
    // Capture depth for active floor only, restore before scene render.
    if (_floorStack && this._depthPassManager) {
      const _activeFloor = _floorStack.getActiveFloor();
      if (_activeFloor !== null) {
        const _prevMask = this.camera.layers.mask;
        try {
          _floorStack.setFloorVisible(_activeFloor.index);
          this.camera.layers.disable(GLOBAL_SCENE_LAYER);
          this._depthPassManager.captureForFloor();
        } catch (_err) { log.error('Floor-aware depth capture failed:', _err); }
        finally { this.camera.layers.mask = _prevMask; _floorStack.restoreVisibility(); }
      }
    }

    // PASS 0: UPDATE & OPTIONAL RENDER FOR SCENE EFFECTS
    for (const effect of sceneEffects) {
      try {
        let t0 = 0; if (doProfile) t0 = performance.now();
        effect.update(timeInfo); if (doProfile) profiler.recordEffectUpdate(effect.id, performance.now() - t0);
        if (doProfile) t0 = performance.now();
        effect.render(this.renderer, this.scene, this.camera); if (doProfile) profiler.recordEffectRender(effect.id, performance.now() - t0);
      } catch (error) { log.error(`Scene effect update/render error (${effect.id}):`, error); this.handleEffectError(effect, error); }
    }

    if (usePostProcessing) { this.ensureSceneRenderTarget(); this.renderer.setRenderTarget(this.sceneRenderTarget); this.renderer.clear(); }
    else { this.renderer.setRenderTarget(null); }

    const prevSceneLayersMask = this.camera.layers.mask;
    try { this.camera.layers.disable(OVERLAY_THREE_LAYER); this.renderer.render(this.scene, this.camera); }
    finally { this.camera.layers.mask = prevSceneLayersMask; }

    if (!usePostProcessing) {
      this._renderOverlayToScreen(); this._renderDepthDebugOverlay();
      if (doProfile) profiler.endFrame();
      this._updateDecimationState(performance.now() - _frameStartMs);
      return;
    }

    // PASS 2: POST-PROCESSING ON SCENE TEXTURE
    // We use a ping-pong approach:
    // Input starts as sceneRenderTarget.
    // We flip between post_1 and post_2 buffers.
    // The last effect renders to screen (null).

    let inputBuffer = this.sceneRenderTarget;
    let outputBuffer = this.getRenderTarget('post_1', inputBuffer.width, inputBuffer.height, false);
    
    // Ensure secondary buffer exists if we have multiple effects
    const pingPongBuffer = this.getRenderTarget('post_2', inputBuffer.width, inputBuffer.height, false);

    for (let i = 0; i < postEffects.length; i++) {
      const effect = postEffects[i];
      const isLast = i === postEffects.length - 1;
      
      // Determine output target
      const currentOutput = isLast ? null : outputBuffer;
      
      try {
        // Update effect state with time info
        let t0 = 0;
        if (doProfile) t0 = performance.now();
        effect.update(timeInfo);
        if (doProfile) profiler.recordEffectUpdate(effect.id, performance.now() - t0);

        // Configure effect inputs/outputs
        if (typeof effect.setInputTexture === 'function') {
          effect.setInputTexture(inputBuffer.texture);
        }
        
        if (typeof effect.setRenderToScreen === 'function') {
          effect.setRenderToScreen(isLast);
        }
        
        // Some complex passes (like Bloom) need explicit buffer references
        if (typeof effect.setBuffers === 'function') {
          effect.setBuffers(inputBuffer, currentOutput);
        }

        // Set the render target for standard effects
        // (Complex effects might override this internally, which is fine)
        this.renderer.setRenderTarget(currentOutput);
        // Clear if not rendering to screen (screen clearing is handled by Foundry/browser usually, or we overwrite)
        if (currentOutput) {
          this.renderer.clear();
        }

        // Let the effect render its full-screen pass
        if (doProfile) t0 = performance.now();
        effect.render(this.renderer, this.scene, this.camera);
        if (doProfile) profiler.recordEffectRender(effect.id, performance.now() - t0);

        // Ping-pong swap for next iteration
        if (!isLast) {
          inputBuffer = outputBuffer;
          outputBuffer = (inputBuffer === this.getRenderTarget('post_1')) 
            ? pingPongBuffer 
            : this.getRenderTarget('post_1');
        }

      } catch (error) {
        log.error(`Post-processing effect error (${effect.id}):`, error);
        this.handleEffectError(effect, error);
      }
    }

    this._renderOverlayToScreen();
    // Depth pass debug overlay — renders depth visualization to screen when enabled
    this._renderDepthDebugOverlay();
    if (doProfile) profiler.endFrame();
    this._updateDecimationState(performance.now() - _frameStartMs); // T2-B
  }

  /**
   * Check whether the per-floor render loop is enabled.
   * Reads the 'experimentalFloorRendering' game setting (default: true).
   * Fails silently (returns false) if settings are unavailable (e.g., during warmup).
   * @returns {boolean}
   * @private
   */
  _checkFloorLoopEnabled() {
    try {
      return !!game?.settings?.get('map-shine-advanced', 'experimentalFloorRendering');
    } catch (_) {
      return false;
    }
  }

  /**
   * Check whether the Compositor V2 (layer-based floor isolation) is enabled.
   * Reads the 'useCompositorV2' game setting.
   * @returns {boolean}
   * @private
   */
  _checkCompositorV2Enabled() {
    try {
      return !!game?.settings?.get('map-shine-advanced', 'useCompositorV2');
    } catch (_) {
      return false;
    }
  }

  /**
   * Get or lazily create the FloorCompositor V2 instance.
   * Created on first use so the constructor doesn't run during module init.
   * @returns {FloorCompositor}
   * @private
   */
  _getFloorCompositorV2() {
    if (!this._floorCompositorV2) {
      this._floorCompositorV2 = new FloorCompositor(this.renderer, this.scene, this.camera);
      this._floorCompositorV2.initialize();
      log.info('FloorCompositor V2 created and initialized');

      // Expose WaterEffectV2 on window.MapShine.waterEffect so V1
      // WeatherParticles foam systems can read water mask/data textures
      // and params. Without this, foam.webp particles are entirely disabled
      // because WeatherParticles.update() gates on waterEffect.enabled.
      try {
        if (window.MapShine && this._floorCompositorV2._waterEffect) {
          window.MapShine.waterEffect = this._floorCompositorV2._waterEffect;
        }
      } catch (_) {}

      // ── Replay saved params ─────────────────────────────────────────────
      // The Tweakpane UI fires its initial callbacks (loadEffectParameters →
      // _propagateToV2) during initializeUI, which runs BEFORE the first
      // render frame that lazily creates this FloorCompositor. Those callbacks
      // find _floorCompositorV2 === null and silently drop every saved value,
      // leaving all effects at their hardcoded constructor defaults.
      //
      // Fix: immediately after creation, pull the current params from each
      // registered effect folder in uiManager and push them into the effects.
      // This is the same data the initial callbacks would have pushed if the
      // FloorCompositor had existed at that time.
      //
      // effectId → FloorCompositor property name mapping must match the
      // _makeV2Callback() calls in canvas-replacement.js.
      // NOTE: 'water' is intentionally omitted from this replay map.
      // uiManager.effectFolders['water'].params is seeded with V1 schema defaults
      // for params not present in scene flags. Those V1 defaults differ substantially
      // from V2 WaterEffectV2 constructor defaults (sand, murk, foam, etc.), so
      // replaying them would corrupt the V2 effect's appearance.
      // Water params that were actually saved to scene flags are replayed below
      // via a separate flags-only path. V2 constructor defaults are used for all others.
      const EFFECT_KEY_MAP = {
        'lighting':         '_lightingEffect',
        'specular':         '_specularEffect',
        'sky-color':        '_skyColorEffect',
        'windowLight':      '_windowLightEffect',
        'fire-sparks':      '_fireEffect',
        'water-splashes':   '_waterSplashesEffect',
        'underwater-bubbles':'_underwaterBubblesEffect',
        'bloom':            '_bloomEffect',
        'colorCorrection':  '_colorCorrectionEffect',
        'filmGrain':        '_filmGrainEffect',
        'sharpen':          '_sharpenEffect',
        'cloud':            '_cloudEffect',
      };

      try {
        const uiManager = window.MapShine?.uiManager;
        if (uiManager?.effectFolders) {
          for (const [effectId, effectKey] of Object.entries(EFFECT_KEY_MAP)) {
            const effectData = uiManager.effectFolders[effectId];
            if (!effectData?.params) continue;
            for (const [paramId, value] of Object.entries(effectData.params)) {
              this._floorCompositorV2.applyParam(effectKey, paramId, value);
            }
          }
          log.info('FloorCompositor V2: replayed saved params from uiManager');
        }

        // ── Replay water params from scene flags only (not schema defaults) ──
        // Reads directly from scene flags so we never push V1 schema defaults
        // into the V2 WaterEffectV2 instance.
        try {
          const scene = globalThis.canvas?.scene;
          const allSettings = scene?.getFlag('map-shine-advanced', 'settings') || {};
          const waterFlags = allSettings?.mapMaker?.effects?.water || {};
          const waterEffect = this._floorCompositorV2._waterEffect;
          if (waterEffect?.params) {
            for (const [k, v] of Object.entries(waterFlags)) {
              if (Object.prototype.hasOwnProperty.call(waterEffect.params, k)) {
                waterEffect.params[k] = v;
              }
            }
            if (Object.keys(waterFlags).length > 0) {
              log.info(`FloorCompositor V2: replayed ${Object.keys(waterFlags).length} water params from scene flags`);
            }
          }
        } catch (err) {
          log.warn('FloorCompositor V2: water flag replay failed:', err);
        }
      } catch (err) {
        log.warn('FloorCompositor V2: param replay failed:', err);
      }
    }
    return this._floorCompositorV2;
  }

  /**
   * Progressive shader warmup — compiles all effect materials one effect at a
   * time, yielding to the event loop between each so the loading UI stays
   * responsive.  Mirrors the logic of render() but inserts gl.finish() + yield
   * after every effect to force synchronous compilation and allow progress
   * updates.
   *
   * @param {function} [onProgress] - Called after each step with
   *   { step, totalSteps, effectId, type, timeMs, newPrograms, totalPrograms }
   * @returns {Promise<{totalMs: number, programsCompiled: number}>}
   */
  async progressiveWarmup(onProgress) {
    const gl = this.renderer.getContext();
    const programCount = () =>
      Array.isArray(this.renderer.info?.programs)
        ? this.renderer.info.programs.length
        : 0;

    const effects = this.resolveRenderOrder();
    const timeInfo = this.timeManager.update();

    // Update frame state (same as render)
    try {
      const frameState = getGlobalFrameState();
      const sceneComposer = window.MapShine?.sceneComposer;
      const canvas = this.renderer?.domElement;
      frameState.update(this.camera, sceneComposer, canvas, timeInfo.frameCount, timeInfo.delta);
    } catch (_) { /* non-critical */ }

    // Split effects into scene vs post-processing (same as render())
    const sceneEffects = [];
    const postEffects = [];
    for (const effect of effects) {
      if (!this.shouldRenderThisFrame(effect, timeInfo)) continue;
      if (effect.layer && effect.layer.order >= RenderLayers.POST_PROCESSING.order) {
        postEffects.push(effect);
      } else {
        sceneEffects.push(effect);
      }
    }

    // +1 for the main scene render pass, +1 for the overlay pass
    const totalSteps = sceneEffects.length + 1 + postEffects.length + 1;
    let step = 0;
    const startPrograms = programCount();
    const warmupT0 = performance.now();

    const _yield = () => new Promise(r => setTimeout(r, 0));
    const _finish = () => { if (gl?.finish) gl.finish(); };

    // Helper to report progress and yield
    const _progress = async (effectId, type, t0, progBefore) => {
      _finish();
      const elapsed = performance.now() - t0;
      const nowProgs = programCount();
      step++;
      try {
        onProgress?.({
          step, totalSteps, effectId, type,
          timeMs: elapsed,
          newPrograms: nowProgs - progBefore,
          totalPrograms: nowProgs
        });
      } catch (_) { /* callback errors are non-critical */ }
      await _yield();
    };

    // ── Scene effects: update + render ──────────────────────────────────
    for (const effect of sceneEffects) {
      const t0 = performance.now();
      const progBefore = programCount();
      try {
        effect.update(timeInfo);
        effect.render(this.renderer, this.scene, this.camera);
      } catch (e) {
        log.error(`Warmup scene-effect error (${effect.id}):`, e);
      }
      await _progress(effect.id, 'scene', t0, progBefore);
    }

    // ── Main scene render (compiles remaining scene-graph materials) ────
    {
      const t0 = performance.now();
      const progBefore = programCount();
      try {
        this.ensureSceneRenderTarget();
        this.renderer.setRenderTarget(this.sceneRenderTarget);
        this.renderer.clear();
        const prevMask = this.camera.layers.mask;
        try {
          this.camera.layers.disable(OVERLAY_THREE_LAYER);
          this.renderer.render(this.scene, this.camera);
        } finally {
          this.camera.layers.mask = prevMask;
        }
      } catch (e) {
        log.error('Warmup main-scene render error:', e);
      }
      await _progress('_mainScene', 'scene-render', t0, progBefore);
    }

    // ── Post-processing effects (ping-pong chain, same as render()) ─────
    if (postEffects.length > 0) {
      let inputBuffer = this.sceneRenderTarget;
      let outputBuffer = this.getRenderTarget(
        'post_1', inputBuffer.width, inputBuffer.height, false
      );
      const pingPongBuffer = this.getRenderTarget(
        'post_2', inputBuffer.width, inputBuffer.height, false
      );

      for (let i = 0; i < postEffects.length; i++) {
        const effect = postEffects[i];
        const isLast = i === postEffects.length - 1;
        const currentOutput = isLast ? null : outputBuffer;

        const t0 = performance.now();
        const progBefore = programCount();
        try {
          effect.update(timeInfo);
          if (typeof effect.setInputTexture === 'function') {
            effect.setInputTexture(inputBuffer.texture);
          }
          if (typeof effect.setRenderToScreen === 'function') {
            effect.setRenderToScreen(isLast);
          }
          if (typeof effect.setBuffers === 'function') {
            effect.setBuffers(inputBuffer, currentOutput);
          }
          this.renderer.setRenderTarget(currentOutput);
          if (currentOutput) this.renderer.clear();
          effect.render(this.renderer, this.scene, this.camera);
        } catch (e) {
          log.error(`Warmup post-effect error (${effect.id}):`, e);
        }
        await _progress(effect.id, 'post', t0, progBefore);

        // Water shader variant compilation test — disabled by default because it adds
        // ~170s of extra compilations. Set window.MAPSHINE_SHADER_VARIANT_TEST = true
        // in the browser console BEFORE loading a scene to re-enable.
        if (window.MAPSHINE_SHADER_VARIANT_TEST && effect.id === 'water' && typeof effect.diagnosticVariantCompile === 'function') {
          try {
            await effect.diagnosticVariantCompile(this.renderer);
          } catch (e) {
            log.warn('Water variant compile test failed:', e);
          }
        }

        // Ping-pong swap
        if (!isLast) {
          inputBuffer = outputBuffer;
          outputBuffer = (inputBuffer === this.getRenderTarget('post_1'))
            ? pingPongBuffer
            : this.getRenderTarget('post_1');
        }
      }
    }

    // ── Overlay pass ────────────────────────────────────────────────────
    {
      const t0 = performance.now();
      const progBefore = programCount();
      try { this._renderOverlayToScreen(); } catch (_) {}
      await _progress('_overlay', 'overlay', t0, progBefore);
    }

    // Restore render target
    this.renderer.setRenderTarget(null);

    const totalMs = performance.now() - warmupT0;
    const programsCompiled = programCount() - startPrograms;
    return { totalMs, programsCompiled, totalPrograms: programCount() };
  }

  /**
   * Handle effect error with user notification
   * @param {EffectBase} effect - The effect that errored
   * @param {Error} error - The error that occurred
   * @private
   */
  handleEffectError(effect, error) {
    // Disable the effect to prevent repeated errors
    effect.enabled = false;
    
    // Store error state for debugging
    effect.errorState = error.message || 'Unknown error';
    effect.errorTime = Date.now();
    
    // Notify user once per effect (don't spam notifications)
    if (!effect._userNotified) {
      effect._userNotified = true;
      
      // Use Foundry's notification system if available
      if (typeof ui !== 'undefined' && ui.notifications) {
        ui.notifications.warn(`Map Shine: "${effect.id}" effect disabled due to error. Check console for details.`);
      }
    }
  }

  /**
   * Determine if effect should render this frame (performance gating).
   * Combines static GPU-tier gating with dynamic frame-time decimation (T2-B).
   *
   * When the rolling average frame time exceeds _decimationEnterMs, non-critical
   * effects are skipped on alternating frames. The system exits decimation when
   * the average drops below _decimationExitMs (hysteresis prevents oscillation).
   *
   * Disable via: window.MapShine.renderAdaptiveDecimation = false
   *
   * @param {EffectBase} effect - Effect to check
   * @param {TimeInfo} timeInfo - Current time information
   * @returns {boolean} Whether to render
   * @private
   */
  shouldRenderThisFrame(effect, timeInfo) {
    // Always render critical effects
    if (effect.alwaysRender || effect.noFrameSkip) return true;

    // Static GPU-tier gating (unchanged)
    if (this.capabilities && this.capabilities.tier === 'low') {
      if (effect.requiredTier === 'high') return false;
      if (effect.requiredTier === 'medium' && timeInfo.frameCount % 2 !== 0) {
        return false; // Render every other frame
      }
    }

    // T2-B: Dynamic frame-time decimation
    const adaptiveEnabled = window.MapShine?.renderAdaptiveDecimation !== false;
    if (adaptiveEnabled && this._decimationActive) {
      // In decimation mode: skip medium-tier effects every other frame
      if (effect.requiredTier === 'medium' && timeInfo.frameCount % 2 !== 0) {
        return false;
      }
      // Skip high-tier effects every other frame too
      if (effect.requiredTier === 'high' && timeInfo.frameCount % 2 !== 0) {
        return false;
      }
    }

    return true;
  }

  /**
   * Update the rolling frame time average and decimation state.
   * Called once per rendered frame from render().
   * @param {number} frameTimeMs - Total frame time in milliseconds
   * @private
   */
  _updateDecimationState(frameTimeMs) {
    if (window.MapShine?.renderAdaptiveDecimation === false) {
      this._decimationActive = false;
      return;
    }

    // Exponential moving average
    const alpha = this._decimationAlpha;
    this._avgFrameTimeMs = this._avgFrameTimeMs * (1 - alpha) + frameTimeMs * alpha;

    // Hysteresis: enter at high threshold, exit at low threshold
    if (!this._decimationActive && this._avgFrameTimeMs > this._decimationEnterMs) {
      this._decimationActive = true;
    } else if (this._decimationActive && this._avgFrameTimeMs < this._decimationExitMs) {
      this._decimationActive = false;
    }
  }

  /**
   * Create or get a shared render target
   * @param {string} name - Render target name
   * @param {number} width - Target width
   * @param {number} height - Target height
   * @param {boolean} [depthBuffer=false] - Whether to include depth buffer
   * @returns {THREE.RenderTarget} Render target
   */
  getRenderTarget(name, width, height, depthBuffer = false) {
    if (this.renderTargets.has(name)) {
      return this.renderTargets.get(name);
    }

    const THREE = window.THREE;
    const target = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.FloatType, // Maintain high precision for post-processing chain
      depthBuffer: depthBuffer,
      stencilBuffer: false
    });

    this.renderTargets.set(name, target);
    log.debug(`Created render target: ${name} (${width}x${height})`);

    return target;
  }

  /**
   * Resize all render targets
   * @param {number} width - New width
   * @param {number} height - New height
   */
  resize(width, height) {
    // IMPORTANT:
    // The canvas has a CSS size (width/height) but the renderer has an internal drawing
    // buffer size which is affected by renderer pixelRatio.
    // All render targets and resolution uniforms MUST track drawing-buffer pixels.
    let renderW = Math.max(1, Math.floor(width || 1));
    let renderH = Math.max(1, Math.floor(height || 1));

    try {
      if (this.renderer?.getDrawingBufferSize) {
        if (!this._sizeVec2) this._sizeVec2 = new window.THREE.Vector2();
        const size = this._sizeVec2;
        this.renderer.getDrawingBufferSize(size);
        renderW = Math.max(1, Math.floor(size.width || size.x || renderW));
        renderH = Math.max(1, Math.floor(size.height || size.y || renderH));
      }
    } catch (e) {
      // Fall back to provided values.
    }

    // Resize scene render target
    if (this.sceneRenderTarget) {
      this.sceneRenderTarget.setSize(renderW, renderH);
      log.debug(`Resized scene render target: ${renderW}x${renderH}`);
    }

    // Resize per-floor render targets (lazily created — only resize if they exist)
    if (this._floorRT) this._floorRT.setSize(renderW, renderH);
    if (this._floorPostA) this._floorPostA.setSize(renderW, renderH);
    if (this._floorPostB) this._floorPostB.setSize(renderW, renderH);
    if (this._accumulationRT) this._accumulationRT.setSize(renderW, renderH);

    // Resize Compositor V2 render targets
    if (this._floorCompositorV2) {
      this._floorCompositorV2.onResize(renderW, renderH);
    }

    // Resize all named render targets
    for (const [name, target] of this.renderTargets.entries()) {
      target.setSize(renderW, renderH);
      log.debug(`Resized render target: ${name} (${renderW}x${renderH})`);
    }

    // Resize depth pass manager render target
    if (this._depthPassManager) {
      try {
        this._depthPassManager.resize(renderW, renderH);
      } catch (e) {
        // Non-critical; depth pass will auto-resize on next render
      }
    }

    // Notify all effects of resize
    for (const effect of this.effects.values()) {
      if (effect.onResize) {
        effect.onResize(renderW, renderH);
      }
    }

    log.info(`EffectComposer resized to ${renderW}x${renderH}`);
  }

  /**
   * Dispose all resources
   */
  dispose() {
    log.info('Disposing EffectComposer');

    // Dispose all effects
    for (const effect of this.effects.values()) {
      effect.dispose();
    }
    this.effects.clear();

    // Clear updatables (managers, controllers, etc.)
    try {
      this.updatables.clear();
    } catch (e) {
    }

    // Dispose render targets
    for (const target of this.renderTargets.values()) {
      target.dispose();
    }
    this.renderTargets.clear();

    // Dispose scene render target
    try {
      if (this.sceneRenderTarget) {
        this.sceneRenderTarget.dispose();
        this.sceneRenderTarget = null;
      }
    } catch (e) {
    }

    // Dispose per-floor render targets and compositor resources
    try {
      if (this._floorRT) { this._floorRT.dispose(); this._floorRT = null; }
      if (this._floorPostA) { this._floorPostA.dispose(); this._floorPostA = null; }
      if (this._floorPostB) { this._floorPostB.dispose(); this._floorPostB = null; }
      if (this._accumulationRT) { this._accumulationRT.dispose(); this._accumulationRT = null; }
      if (this._compositeMaterial) { this._compositeMaterial.dispose(); this._compositeMaterial = null; }
      if (this._floorAlphaClipMaterial) { this._floorAlphaClipMaterial.dispose(); this._floorAlphaClipMaterial = null; }
      if (this._compositeQuad?.geometry) { this._compositeQuad.geometry.dispose(); }
      this._compositeQuad = null;
      this._compositeScene = null;
      this._compositeCamera = null;
    } catch (e) {
    }

    // Dispose Compositor V2 resources
    try {
      if (this._floorCompositorV2) { this._floorCompositorV2.dispose(); this._floorCompositorV2 = null; }
    } catch (e) {
    }
  }

  /**
   * Get time manager (for external control)
   * @returns {TimeManager} Time manager instance
   */
  getTimeManager() {
    return this.timeManager;
  }

  /**
   * Set the depth pass manager reference for debug overlay rendering.
   * @param {import('../scene/depth-pass-manager.js').DepthPassManager|null} manager
   */
  setDepthPassManager(manager) {
    this._depthPassManager = manager;
  }

  /**
   * Get the depth pass manager.
   * @returns {import('../scene/depth-pass-manager.js').DepthPassManager|null}
   */
  getDepthPassManager() {
    return this._depthPassManager;
  }

  /**
   * Render depth debug overlay to screen if enabled.
   * Called at the very end of the render loop (after post-processing and overlays).
   * @private
   */
  _renderDepthDebugOverlay() {
    if (!this._depthPassManager) return;
    try {
      this._depthPassManager.renderDebugOverlay();
    } catch (e) {
      // Debug overlay is non-critical; swallow errors
    }
  }

  /**
   * Get composer statistics for debugging
   * @returns {Object} Stats object
   */
  getStats() {
    const enabledCount = Array.from(this.effects.values())
      .filter(e => e.enabled).length;

    return {
      totalEffects: this.effects.size,
      enabledEffects: enabledCount,
      renderTargets: this.renderTargets.size,
      frameCount: this.timeManager.frameCount,
      fps: this.timeManager.fps,
      timeElapsed: this.timeManager.elapsed.toFixed(2),
      timeScale: this.timeManager.scale
    };
  }
}

/**
 * Base class for all effects
 * Effects should extend this class and implement required methods
 */
export class EffectBase {
  /**
   * @param {string} id - Unique effect identifier
   * @param {EffectLayer} layer - Render layer
   * @param {string} [requiredTier='low'] - Required GPU tier (low/medium/high)
   */
  constructor(id, layer, requiredTier = 'low') {
    this.id = id;
    this.layer = layer;
    this.requiredTier = requiredTier;
    this.enabled = true;
    this.priority = 0;
    this.alwaysRender = false;

    // When true, RenderLoop will bypass idle FPS throttling while this effect is active.
    // Use this for continuous animations like particle systems.
    this.requiresContinuousRender = false;

    /**
     * Controls when this effect participates in the per-floor render loop.
     *
     * - `'floor'` (default): The effect runs once per visible floor. Its
     *   update() receives per-floor mask bindings and contributes to that
     *   floor's render target. Most scene effects use this scope.
     *
     * - `'global'`: The effect runs exactly once per frame, after the floor
     *   loop completes, on the fully-composited accumulated image. Use for
     *   floor-agnostic effects whose output should not be multiplied across
     *   floors (ParticleSystem, WorldSpaceFogEffect, PlayerLightEffect,
     *   all POST_PROCESSING effects that don't need per-floor depth).
     *
     * @type {'floor'|'global'}
     */
    this.floorScope = 'floor';
  }

  /**
   * Optional hook used by EffectComposer.wantsContinuousRender().
   * Effects with dynamic activation (e.g. particles only when sources exist)
   * can override this.
   *
   * @returns {boolean}
   */
  isActive() {
    return !!this.enabled;
  }

  /**
   * Initialize effect (called once on registration)
   * @param {THREE.Renderer} renderer - three.js renderer
   * @param {THREE.Scene} scene - three.js scene
   * @param {THREE.Camera} camera - three.js camera
   */
  initialize(renderer, scene, camera) {
    // Override in subclass
  }

  /**
   * P1.1: Get a promise that resolves when the effect is fully ready
   * Effects that load textures or perform async GPU operations should override this
   * to return a promise that resolves when all resources are loaded and ready.
   * 
   * Default implementation returns an immediately resolved promise.
   * 
   * @returns {Promise<void>} Promise that resolves when effect is ready
   */
  getReadinessPromise() {
    return Promise.resolve();
  }

  /**
   * Advance time-based simulations for this effect.
   *
   * Called ONCE per render frame, before the floor loop begins. Override to
   * step simulations whose rate must not depend on floor count (e.g. wave SDF,
   * cloud density, heat haze, spark lifetimes). Do NOT bind floor-specific
   * masks or uniforms here — floor masks are not yet active when this runs.
   *
   * Default: no-op. Safe to leave unimplemented for effects with no
   * independent simulation (specular, fluid overlays, post effects, etc.).
   *
   * @param {TimeInfo} timeInfo - Centralized time information
   */
  prepareFrame(timeInfo) {
    // Override in subclass to advance time-based simulations.
  }

  /**
   * Update effect state for the current floor pass (called once per floor).
   *
   * In the floor loop architecture this is called once per visible floor with
   * that floor's mask bundle already bound. Perform floor-specific uniform
   * updates and mask sampling here. Time-advancing simulation should live in
   * prepareFrame() instead so it runs at 1× speed regardless of floor count.
   *
   * **IMPORTANT: Use timeInfo for all time-based calculations**
   * - timeInfo.elapsed: Total elapsed time (for absolute animations)
   * - timeInfo.delta: Frame delta time (for frame-independent movement)
   * - timeInfo.frameCount: Current frame number
   *
   * @param {TimeInfo} timeInfo - Centralized time information
   */
  update(timeInfo) {
    // Override in subclass
  }

  /**
   * Render effect
   * @param {THREE.Renderer} renderer - three.js renderer
   * @param {THREE.Scene} scene - three.js scene
   * @param {THREE.Camera} camera - three.js camera
   */
  render(renderer, scene, camera) {
    // Override in subclass
  }

  /**
   * Handle resize event
   * Default implementation updates common resources (render targets, resolution uniforms)
   * Override in subclass for custom resize behavior
   * @param {number} width - New width
   * @param {number} height - New height
   */
  onResize(width, height) {
    // Update any render targets owned by this effect
    if (this.renderTarget) {
      this.renderTarget.setSize(width, height);
    }
    
    // Update resolution uniforms if present
    if (this.material?.uniforms?.uResolution) {
      this.material.uniforms.uResolution.value.set(width, height);
    }
    if (this.material?.uniforms?.uTexelSize) {
      this.material.uniforms.uTexelSize.value.set(1 / width, 1 / height);
    }
  }

  /**
   * P5-08/09: Called by EffectMaskRegistry when a mask of a subscribed type arrives
   * for the first time (texture transitions from null → non-null) and the effect
   * has `_lazyInitPending === true`. The default implementation triggers lazy
   * initialization via `EffectComposer.ensureEffectInitialized()`.
   *
   * Effects that need custom behaviour on first-mask arrival can override this,
   * but should call `super.onMaskArrived(maskType, texture)` to preserve lazy init.
   *
   * @param {string} maskType - The mask type that arrived (e.g. 'outdoors', 'tree')
   * @param {THREE.Texture|null} texture - The new mask texture
   */
  onMaskArrived(maskType, texture) {
    if (!this._lazyInitPending) return;
    // Resolve the EffectComposer from window.MapShine to avoid a circular import.
    const composer = window.MapShine?.effectComposer;
    if (composer && typeof composer.ensureEffectInitialized === 'function') {
      composer.ensureEffectInitialized(this.id).catch(() => {});
    }
  }

  /**
   * Dispose effect resources
   * Default implementation cleans up common resources
   * Override in subclass for additional cleanup
   */
  dispose() {
    // Dispose materials
    if (this.material) {
      if (this.material.map) {
        this.material.map.dispose();
      }
      this.material.dispose();
      this.material = null;
    }
    
    // Dispose geometries
    if (this.geometry) {
      this.geometry.dispose();
      this.geometry = null;
    }
    
    // Dispose render targets
    if (this.renderTarget) {
      this.renderTarget.dispose();
      this.renderTarget = null;
    }
    
    // Remove mesh from scene if present
    if (this.mesh && this.mesh.parent) {
      this.mesh.parent.remove(this.mesh);
      this.mesh = null;
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Formalized Effect Hierarchy
//
// These intermediate classes sit between EffectBase and concrete effects.
// They codify the three dominant patterns observed across all effects:
//
//   EffectBase
//     ├── SceneMeshEffect   — World-space mesh overlays (trees, water, fog, etc.)
//     ├── PostProcessEffect  — Screen-space shader passes (lighting, bloom, etc.)
//     └── ParticleEffect     — Particle system wrappers (fire, dust, flies, etc.)
//
// Concrete effects can extend these instead of EffectBase to get standardized
// lifecycle hooks, shared resource management, and a clearer contract.
// Migration is opt-in — existing effects that extend EffectBase directly
// will continue to work unchanged.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Base class for effects that create meshes in the Three.js scene.
 * 
 * Provides a standardized lifecycle:
 * 1. `initialize(renderer, scene, camera)` — stores refs, calls `onInitialize()`
 * 2. `setBaseMesh(baseMesh, assetBundle)` — receives the scene's base plane + asset data
 * 3. `createMesh()` — builds the effect mesh (override required)
 * 4. `update(timeInfo)` — per-frame logic, calls `onUpdate(timeInfo)`
 * 5. `dispose()` — cleans up mesh, material, shadow resources
 * 
 * Subclasses MUST override:
 * - `createMesh()` — build and add the mesh to `this.scene`
 * 
 * Subclasses MAY override:
 * - `onInitialize()` — extra init after renderer/scene/camera are stored
 * - `onUpdate(timeInfo)` — per-frame update logic
 * - `onBaseMeshSet(baseMesh, assetBundle)` — extract masks/textures from the asset bundle
 * - `createShadowResources()` — build shadow meshes/targets
 * 
 * @extends EffectBase
 */
export class SceneMeshEffect extends EffectBase {
  /**
   * @param {string} id
   * @param {EffectLayer} layer
   * @param {string} [requiredTier='low']
   */
  constructor(id, layer, requiredTier = 'low') {
    super(id, layer, requiredTier);

    /** @type {THREE.Renderer|null} */
    this.renderer = null;

    /** @type {THREE.Scene|null} */
    this.scene = null;

    /** @type {THREE.Camera|null} */
    this.camera = null;

    /** @type {THREE.Mesh|null} - The base plane mesh (shared geometry source) */
    this.baseMesh = null;

    /** @type {THREE.Mesh|null} - This effect's primary overlay mesh */
    this.mesh = null;

    /** @type {THREE.ShaderMaterial|null} */
    this.material = null;

    // Shadow casting support (optional — subclasses populate these)
    /** @type {THREE.Scene|null} */
    this.shadowScene = null;

    /** @type {THREE.Mesh|null} */
    this.shadowMesh = null;

    /** @type {THREE.ShaderMaterial|null} */
    this.shadowMaterial = null;

    /** @type {THREE.WebGLRenderTarget|null} */
    this.shadowTarget = null;

    /** @type {boolean} - Backing field for enabled getter/setter */
    this._enabled = true;
  }

  get enabled() {
    return this._enabled;
  }

  set enabled(value) {
    this._enabled = !!value;
    if (this.mesh) this.mesh.visible = this._enabled;
  }

  /**
   * Standard initialize — stores renderer/scene/camera, then delegates to onInitialize().
   * @param {THREE.Renderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  initialize(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.onInitialize();
  }

  /**
   * Hook for subclass-specific initialization after renderer/scene/camera are set.
   * Override this instead of initialize() to avoid forgetting the super call.
   * @protected
   */
  onInitialize() {
    // Override in subclass
  }

  /**
   * Receive the base plane mesh and asset bundle.
   * Extracts masks/textures via onBaseMeshSet(), then calls createMesh().
   * @param {THREE.Mesh} baseMesh - The scene's ground plane mesh
   * @param {Object} assetBundle - Contains masks, textures, and metadata
   */
  setBaseMesh(baseMesh, assetBundle) {
    this.baseMesh = baseMesh;
    this.onBaseMeshSet(baseMesh, assetBundle);
    if (this.scene && this.baseMesh) {
      this.createMesh();
      this.createShadowResources();
    }
  }

  /**
   * Extract masks/textures from the asset bundle.
   * Override to pull effect-specific data (e.g., tree mask, window mask).
   * @param {THREE.Mesh} baseMesh
   * @param {Object} assetBundle
   * @protected
   */
  onBaseMeshSet(baseMesh, assetBundle) {
    // Override in subclass
  }

  /**
   * Build the primary overlay mesh and add it to `this.scene`.
   * MUST be overridden by subclasses.
   * @abstract
   * @protected
   */
  createMesh() {
    // Override in subclass — REQUIRED
  }

  /**
   * Build shadow-casting resources (mesh, material, render target).
   * Override only if this effect casts shadows onto the scene.
   * @protected
   */
  createShadowResources() {
    // Override in subclass — optional
  }

  /**
   * Per-frame update. Calls onUpdate() for subclass logic.
   * @param {TimeInfo} timeInfo
   */
  update(timeInfo) {
    if (!this._enabled || !this.mesh) return;
    this.onUpdate(timeInfo);
  }

  /**
   * Subclass per-frame update logic (uniform updates, animation, etc.).
   * @param {TimeInfo} timeInfo
   * @protected
   */
  onUpdate(timeInfo) {
    // Override in subclass
  }

  /**
   * Dispose all resources: mesh, material, shadow resources, and references.
   */
  dispose() {
    // Remove primary mesh
    if (this.mesh && this.scene) {
      try { this.scene.remove(this.mesh); } catch (_) {}
    }
    this.mesh = null;

    // Remove shadow mesh
    if (this.shadowMesh && this.shadowScene) {
      try { this.shadowScene.remove(this.shadowMesh); } catch (_) {}
    }
    this.shadowMesh = null;

    // Dispose materials
    if (this.material) {
      try { this.material.dispose(); } catch (_) {}
      this.material = null;
    }
    if (this.shadowMaterial) {
      try { this.shadowMaterial.dispose(); } catch (_) {}
      this.shadowMaterial = null;
    }

    // Dispose shadow render target
    if (this.shadowTarget) {
      try { this.shadowTarget.dispose(); } catch (_) {}
      this.shadowTarget = null;
    }

    // Clear references
    this.shadowScene = null;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.baseMesh = null;
  }
}

/**
 * Base class for screen-space post-processing effects.
 * 
 * These effects operate on the rendered scene texture via fullscreen quad passes.
 * They typically use `setBuffers()` or `setInputTexture()` to receive the
 * EffectComposer's ping-pong buffers, then render a modified result.
 * 
 * Provides a standardized lifecycle:
 * 1. `initialize(renderer, scene, camera)` — stores refs, creates quad scene, calls `onInitialize()`
 * 2. `setBuffers(readBuffer, writeBuffer)` — receive ping-pong targets from EffectComposer
 * 3. `render(renderer, scene, camera)` — renders the post-process pass
 * 4. `onResize(width, height)` — updates resolution uniforms and render targets
 * 5. `dispose()` — cleans up quad scene, materials, render targets
 * 
 * Subclasses MUST override:
 * - `createMaterial()` — return the ShaderMaterial for the fullscreen quad
 * 
 * Subclasses MAY override:
 * - `onInitialize()` — extra init (additional render targets, hook registration)
 * - `onUpdate(timeInfo)` — per-frame uniform updates
 * - `onRender(renderer)` — custom render logic (multi-pass effects)
 * 
 * @extends EffectBase
 */
export class PostProcessEffect extends EffectBase {
  /**
   * @param {string} id
   * @param {string} [requiredTier='low']
   */
  constructor(id, requiredTier = 'low') {
    super(id, RenderLayers.POST_PROCESSING, requiredTier);

    /** @type {THREE.Renderer|null} */
    this.renderer = null;

    /** @type {THREE.Scene|null} - The main scene (for reading scene state) */
    this.mainScene = null;

    /** @type {THREE.Camera|null} */
    this.mainCamera = null;

    /** @type {THREE.Scene|null} - Fullscreen quad scene for this pass */
    this.quadScene = null;

    /** @type {THREE.OrthographicCamera|null} - Ortho camera for quad rendering */
    this.quadCamera = null;

    /** @type {THREE.Mesh|null} - The fullscreen quad mesh */
    this.quadMesh = null;

    /** @type {THREE.ShaderMaterial|null} */
    this.material = null;

    /** @type {THREE.WebGLRenderTarget|null} - Read buffer from EffectComposer */
    this.readBuffer = null;

    /** @type {THREE.WebGLRenderTarget|null} - Write buffer from EffectComposer */
    this.writeBuffer = null;
  }

  /**
   * Standard initialize — stores refs, creates the quad scene, delegates to onInitialize().
   * @param {THREE.Renderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  initialize(renderer, scene, camera) {
    this.renderer = renderer;
    this.mainScene = scene;
    this.mainCamera = camera;
    this._createQuadScene();
    this.onInitialize();
  }

  /**
   * Hook for subclass-specific initialization.
   * @protected
   */
  onInitialize() {
    // Override in subclass
  }

  /**
   * Receive ping-pong buffers from the EffectComposer.
   * @param {THREE.WebGLRenderTarget} readBuffer - Contains the current scene render
   * @param {THREE.WebGLRenderTarget} writeBuffer - Target for this effect's output
   */
  setBuffers(readBuffer, writeBuffer) {
    this.readBuffer = readBuffer;
    this.writeBuffer = writeBuffer;
    if (this.material?.uniforms?.tDiffuse) {
      this.material.uniforms.tDiffuse.value = readBuffer?.texture ?? null;
    }
  }

  /**
   * Convenience for effects that only need the input texture.
   * @param {THREE.Texture} texture
   */
  setInputTexture(texture) {
    if (this.material?.uniforms?.tDiffuse) {
      this.material.uniforms.tDiffuse.value = texture;
    }
  }

  /**
   * Per-frame update. Calls onUpdate() for subclass logic.
   * @param {TimeInfo} timeInfo
   */
  update(timeInfo) {
    if (!this.enabled) return;
    this.onUpdate(timeInfo);
  }

  /**
   * Subclass per-frame update logic (uniform updates).
   * @param {TimeInfo} timeInfo
   * @protected
   */
  onUpdate(timeInfo) {
    // Override in subclass
  }

  /**
   * Handle resize — updates resolution uniforms on the material.
   * @param {number} width
   * @param {number} height
   */
  onResize(width, height) {
    super.onResize(width, height);
    // Additional render targets owned by the subclass should be resized in an override
  }

  /**
   * Create the ShaderMaterial for the fullscreen quad.
   * MUST be overridden by subclasses. Called during _createQuadScene().
   * @abstract
   * @protected
   * @returns {THREE.ShaderMaterial|null}
   */
  createMaterial() {
    // Override in subclass — REQUIRED
    return null;
  }

  /**
   * Dispose all resources.
   */
  dispose() {
    if (this.quadMesh && this.quadScene) {
      try { this.quadScene.remove(this.quadMesh); } catch (_) {}
    }
    this.quadMesh = null;

    if (this.material) {
      try { this.material.dispose(); } catch (_) {}
      this.material = null;
    }

    // Dispose any render targets from the base class
    if (this.renderTarget) {
      try { this.renderTarget.dispose(); } catch (_) {}
      this.renderTarget = null;
    }

    this.quadScene = null;
    this.quadCamera = null;
    this.renderer = null;
    this.mainScene = null;
    this.mainCamera = null;
    this.readBuffer = null;
    this.writeBuffer = null;
  }

  /**
   * Create the fullscreen quad scene used for rendering this post-process pass.
   * @private
   */
  _createQuadScene() {
    const THREE = window.THREE;
    if (!THREE) return;

    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.material = this.createMaterial();

    if (this.material) {
      const geometry = new THREE.PlaneGeometry(2, 2);
      this.quadMesh = new THREE.Mesh(geometry, this.material);
      this.quadScene.add(this.quadMesh);
    }
  }
}

/**
 * Base class for particle-system effects.
 * 
 * These effects manage three-quarks ParticleSystem instances, position maps,
 * and batch renderer integration. They typically:
 * - Build a "position map" from a luminance mask (lookup map technique)
 * - Create particle systems that sample the position map in the vertex shader
 * - Register with the global BatchRenderer for efficient rendering
 * 
 * Provides a standardized lifecycle:
 * 1. `initialize(renderer, scene, camera)` — stores refs, calls `onInitialize()`
 * 2. `setBaseMesh(baseMesh, assetBundle)` — extract position data from masks
 * 3. `update(timeInfo)` — tick particle systems
 * 4. `dispose()` — unregister from batch renderer, dispose systems
 * 
 * Subclasses MUST override:
 * - `createParticleSystems()` — build and register particle system(s)
 * 
 * Subclasses MAY override:
 * - `onInitialize()` — extra init
 * - `onBaseMeshSet(baseMesh, assetBundle)` — extract masks, build position maps
 * - `onUpdate(timeInfo)` — per-frame logic beyond particle system ticking
 * 
 * @extends EffectBase
 */
export class ParticleEffect extends EffectBase {
  /**
   * @param {string} id
   * @param {string} [requiredTier='low']
   */
  constructor(id, requiredTier = 'low') {
    super(id, RenderLayers.PARTICLES, requiredTier);

    this.requiresContinuousRender = true;

    /** @type {THREE.Renderer|null} */
    this.renderer = null;

    /** @type {THREE.Scene|null} */
    this.scene = null;

    /** @type {THREE.Camera|null} */
    this.camera = null;

    /** @type {THREE.Mesh|null} */
    this.baseMesh = null;

    /** @type {Array} - Particle systems managed by this effect */
    this.particleSystems = [];

    /** @type {boolean} */
    this._enabled = true;
  }

  get enabled() {
    return this._enabled;
  }

  set enabled(value) {
    this._enabled = !!value;
    // Toggle emitter visibility for all particle systems
    for (const sys of this.particleSystems) {
      if (sys?.emitter) sys.emitter.visible = this._enabled;
    }
  }

  /**
   * Standard initialize — stores refs, delegates to onInitialize().
   * @param {THREE.Renderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  initialize(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.onInitialize();
  }

  /**
   * Hook for subclass-specific initialization.
   * @protected
   */
  onInitialize() {
    // Override in subclass
  }

  /**
   * Receive the base plane mesh and asset bundle.
   * @param {THREE.Mesh} baseMesh
   * @param {Object} assetBundle
   */
  setBaseMesh(baseMesh, assetBundle) {
    this.baseMesh = baseMesh;
    this.onBaseMeshSet(baseMesh, assetBundle);
    if (this.scene) {
      this.createParticleSystems();
    }
  }

  /**
   * Extract masks/position data from the asset bundle.
   * @param {THREE.Mesh} baseMesh
   * @param {Object} assetBundle
   * @protected
   */
  onBaseMeshSet(baseMesh, assetBundle) {
    // Override in subclass
  }

  /**
   * Build and register particle system(s) with the batch renderer.
   * MUST be overridden by subclasses.
   * @abstract
   * @protected
   */
  createParticleSystems() {
    // Override in subclass — REQUIRED
  }

  /**
   * Per-frame update. Calls onUpdate() for subclass logic.
   * @param {TimeInfo} timeInfo
   */
  update(timeInfo) {
    if (!this._enabled) return;
    this.onUpdate(timeInfo);
  }

  /**
   * Subclass per-frame update logic.
   * @param {TimeInfo} timeInfo
   * @protected
   */
  onUpdate(timeInfo) {
    // Override in subclass
  }

  /**
   * Check if this particle effect is actively emitting.
   * Override for dynamic activation (e.g., only when fire sources exist).
   * @returns {boolean}
   */
  isActive() {
    if (!this._enabled) return false;
    return this.particleSystems.some(sys => sys?.emitter?.visible);
  }

  /**
   * Dispose all particle systems and references.
   */
  dispose() {
    // Unregister from batch renderer
    const batch = window.MapShineParticles?.batchRenderer;
    for (const sys of this.particleSystems) {
      if (!sys) continue;
      try {
        if (batch && typeof batch.deleteSystem === 'function') {
          batch.deleteSystem(sys);
        }
      } catch (_) {}
      try {
        if (sys.emitter && sys.emitter.parent) {
          sys.emitter.parent.remove(sys.emitter);
        }
      } catch (_) {}
      try {
        if (typeof sys.dispose === 'function') sys.dispose();
      } catch (_) {}
    }
    this.particleSystems = [];

    // Dispose materials/geometry via parent
    super.dispose();

    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.baseMesh = null;
  }
}
