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
import * as sceneSettings from '../settings/scene-settings.js';
import {
  BLOOM_HOTSPOT_LAYER,
  OVERLAY_THREE_LAYER,
  GLOBAL_SCENE_LAYER,
  ROPE_MASK_LAYER,
  TILE_FEATURE_LAYERS,
} from '../core/render-layers.js';
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

export {
  BLOOM_HOTSPOT_LAYER,
  OVERLAY_THREE_LAYER,
  GLOBAL_SCENE_LAYER,
  ROPE_MASK_LAYER,
  TILE_FEATURE_LAYERS,
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
    
    /** @type {TimeManager} - Centralized time management */
    this.timeManager = new TimeManager();

    /** @type {import('../scene/depth-pass-manager.js').DepthPassManager|null} */
    this._depthPassManager = null;

    // ── Compositor V2 ─────────────────────────────────────────────────────────
    // V2-only runtime: floor rendering is delegated to FloorCompositor.
    // FloorCompositor uses Three.js layers for floor isolation (no per-frame
    // visibility toggling). Created lazily on first use.
    /** @type {FloorCompositor|null} */
    this._floorCompositorV2 = null;

    // PERFORMANCE: Cache for resolved render order to avoid per-frame allocations
    this._cachedRenderOrder = [];
    this._renderOrderDirty = true;
    
    /**
     * Per-effect health telemetry for diagnostics.
     * This is intentionally lightweight: timestamps and last error only.
     * @type {Map<string, {id: string, enabled: boolean, lazyInitPending: boolean, lastPrepareFrameAtMs: number|null, lastUpdateAtMs: number|null, lastRenderAtMs: number|null, lastUpdateDurationMs: number|null, lastRenderDurationMs: number|null, lastErrorAtMs: number|null, lastErrorMessage: string|null}>}
     */
    this._effectHealth = new Map();
    
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

  _getOrCreateEffectHealth(effect) {
    const id = String(effect?.id || '');
    if (!id) return null;
    let entry = this._effectHealth.get(id);
    if (!entry) {
      entry = {
        id,
        enabled: false,
        lazyInitPending: false,
        lastPrepareFrameAtMs: null,
        lastUpdateAtMs: null,
        lastRenderAtMs: null,
        lastUpdateDurationMs: null,
        lastRenderDurationMs: null,
        lastErrorAtMs: null,
        lastErrorMessage: null,
      };
      this._effectHealth.set(id, entry);
    }
    entry.enabled = Boolean(effect?.enabled);
    entry.lazyInitPending = Boolean(effect?._lazyInitPending);
    return entry;
  }

  _recordEffectError(effect, error) {
    const entry = this._getOrCreateEffectHealth(effect);
    if (!entry) return;
    entry.lastErrorAtMs = Date.now();
    entry.lastErrorMessage = String(error?.message || error);
  }

  /**
   * Snapshot of effect health for the Diagnostic Center.
   * @returns {{generatedAtMs: number, effects: Array<object>}}
   */
  getEffectHealthSnapshot() {
    const out = [];
    for (const effect of (this.effects?.values?.() || [])) {
      if (!effect?.id) continue;
      const entry = this._getOrCreateEffectHealth(effect);
      if (!entry) continue;
      out.push({ ...entry });
    }
    out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return { generatedAtMs: Date.now(), effects: out };
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
    // Compositor V2 path: delegate continuous-render intent to FloorCompositor.
    try {
      const fc = this._floorCompositorV2;
      if (fc && typeof fc.wantsContinuousRender === 'function') {
        if (fc.wantsContinuousRender()) return true;
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

  /**
   * Optional adaptive-FPS hint for the render loop when continuous rendering is active.
   * Returns 0 when no override is needed.
   *
   * @returns {number}
   */
  getPreferredContinuousFps() {
    try {
      const fc = this._floorCompositorV2;
      if (fc && typeof fc.getPreferredContinuousFps === 'function') {
        const preferred = Number(fc.getPreferredContinuousFps());
        return Number.isFinite(preferred) && preferred > 0 ? preferred : 0;
      }
    } catch (_) {
    }
    return 0;
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
    // DIAGNOSTIC: Force sequential (concurrency=1) so loading logs are linear
    const concurrency = 1;
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
      this._getOrCreateEffectHealth(effect);

      // P2.1: Defer initialization for effects the user has disabled via Graphics Settings.
      // They remain in the Map (preserving render order) but won't compile shaders until
      // the user re-enables them via ensureEffectInitialized().
      if (skipIds && skipIds.has(effect.id)) {
        effect.enabled = false;
        effect._lazyInitPending = true;
        this._getOrCreateEffectHealth(effect);
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
      log.debug(`Effect init start: ${effect.id}`);
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
      log.debug(`Effect init done: ${effect.id} (${dt.toFixed(1)}ms) [${completed}/${total}]`);
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
    const _floorStackEarly = window.MapShine?.floorStack ?? null;
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
      // floorStack can be transiently null during early Foundry boot or
      // recovery init paths. V2 must still be the sole renderer in that
      // case; FloorCompositor will treat missing floor info as floor 0.
      floorStack: _floorStackEarly,
      timeInfo,
      doProfile,
      profiler,
    });
    if (doProfile) profiler.endFrame();
    this._updateDecimationState(performance.now() - _frameStartMs);
    return;
  }

  /**
   * Get or lazily create the FloorCompositor V2 instance.
   * Created on first use so the constructor doesn't run during module init.
   * @param {object} [options]
   * @param {(label: string, index: number, total: number) => void} [options.onProgress]
   *   Forwarded to FloorCompositor.initialize() for loading-screen progress updates.
   *   Only used on the first call (when the compositor is actually created).
   * @param {{maskIds?: string[]|Set<string>}|null} [options.effectHints]
   *   Optional scene-level hints (e.g. discovered mask IDs) used by V2 warmup
   *   to avoid compiling mask-driven shaders that the scene cannot use.
   * @returns {FloorCompositor}
   * @private
   */
  _getFloorCompositorV2(options = {}) {
    if (!this._floorCompositorV2) {
      this._floorCompositorV2 = new FloorCompositor(this.renderer, this.scene, this.camera);
      this._floorCompositorV2.initialize({
        onProgress: options?.onProgress,
        effectHints: options?.effectHints ?? null,
      });
      log.info('FloorCompositor V2 created and initialized');

      // Expose FloorCompositor V2 and its effects for runtime diagnostics and
      // console debugging. In V2 mode, effects are not registered in the legacy
      // EffectComposer.effects map, so without this it's hard to inspect state.
      try {
        if (window.MapShine) {
          window.MapShine.floorCompositorV2 = this._floorCompositorV2;
          window.MapShine.fireEffectV2 = this._floorCompositorV2._fireEffect;
          window.MapShine.specularEffectV2 = this._floorCompositorV2._specularEffect;
          window.MapShine.prismEffectV2 = this._floorCompositorV2._prismEffect;
          window.MapShine.windowLightEffectV2 = this._floorCompositorV2._windowLightEffect;
          window.MapShine.cloudEffectV2 = this._floorCompositorV2._cloudEffect;
          window.MapShine.waterSplashesEffectV2 = this._floorCompositorV2._waterSplashesEffect;
          window.MapShine.candleFlamesEffectV2 = this._floorCompositorV2._candleFlamesEffect;
          window.MapShine.playerLightEffectV2 = this._floorCompositorV2._playerLightEffect;
          // Back-compat alias for call sites not yet migrated.
          window.MapShine.playerLightEffect = this._floorCompositorV2._playerLightEffect;
          // Movement UI overlay (path lines, tile highlights, ghost tokens, drag ghosts).
          window.MapShine.movementPreviewEffectV2 = this._floorCompositorV2._movementPreviewEffect;
          // Bus scene reference — used by non-effect code to place overlays.
          window.MapShine.floorRenderBus = this._floorCompositorV2._renderBus;
        }
      } catch (_) {}

      try {
        const he = window.MapShine?.healthEvaluator;
        if (he) {
          he.floorCompositor = this._floorCompositorV2;
          he.refreshInstrumentation?.();
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
        'prism':            '_prismEffect',
        'sky-color':        '_skyColorEffect',
        'windowLight':      '_windowLightEffect',
        'fire-sparks':      '_fireEffect',
        'bush':             '_bushEffect',
        'tree':             '_treeEffect',
        'water-splashes':   '_waterSplashesEffect',
        'underwater-bubbles':'_underwaterBubblesEffect',
        'candle-flames':    '_candleFlamesEffect',
        'player-light':     '_playerLightEffect',
        'bloom':            '_bloomEffect',
        'colorCorrection':  '_colorCorrectionEffect',
        'filter':           '_filterEffect',
        'sharpen':          '_sharpenEffect',
        'cloud':            '_cloudEffect',
        'dotScreen':        '_dotScreenEffect',
        'halftone':         '_halftoneEffect',
        'ascii':            '_asciiEffect',
        'dazzleOverlay':    '_dazzleOverlayEffect',
        'visionMode':       '_visionModeEffect',
        'invert':           '_invertEffect',
        'sepia':            '_sepiaEffect',
        'lens':             '_lensEffect',
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
          const allSettings = sceneSettings.getSceneSettings(scene);
          const waterFlags = allSettings?.mapMaker?.effects?.water || {};
          const waterEffect = this._floorCompositorV2._waterEffect;
          if (waterEffect?.params) {
            for (const [k, v] of Object.entries(waterFlags)) {
              if (Object.prototype.hasOwnProperty.call(waterEffect.params, k)) {
                // Reject NaN/Infinity — corrupted scene flags must not poison params.
                if (typeof v === 'number' && !Number.isFinite(v)) continue;
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

      // NOTE: Do not force-enable effects here by default. Persisted params are
      // replayed as-is from UI/scene settings.
    }
    return this._floorCompositorV2;
  }

  /**
   * V2 warmup path.
   * Executes a single FloorCompositor V2 render to trigger lazy initialization.
   * @param {function} [onProgress]
   * @returns {Promise<{totalMs: number, programsCompiled: number, totalPrograms: number}>}
   */
  async progressiveWarmup(onProgress) {
    const t0 = performance.now();
    const programCount = () => Array.isArray(this.renderer.info?.programs) ? this.renderer.info.programs.length : 0;
    const startPrograms = programCount();
    const timeInfo = this.timeManager.update();
    const compositor = this._getFloorCompositorV2();
    compositor.render({
      floorStack: window.MapShine?.floorStack ?? null,
      timeInfo,
      doProfile: false,
      profiler: null,
    });
    const totalMs = performance.now() - t0;
    const totalPrograms = programCount();
    const programsCompiled = totalPrograms - startPrograms;
    try {
      onProgress?.({
        step: 1,
        totalSteps: 1,
        effectId: 'floorCompositorV2',
        type: 'v2-warmup',
        timeMs: totalMs,
        newPrograms: programsCompiled,
        totalPrograms,
      });
    } catch (_) {}
    return { totalMs, programsCompiled, totalPrograms };
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
     *   floors (ParticleSystem, FogOfWarEffectV2, PlayerLightEffect,
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
