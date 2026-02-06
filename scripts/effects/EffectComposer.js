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
    
    /** @type {GPUCapabilities} */
    this.capabilities = null;
    
    /** @type {THREE.RenderTarget} */
    this.sceneRenderTarget = null;

    /** @type {TimeManager} - Centralized time management */
    this.timeManager = new TimeManager();

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

    // Update registered updatables (managers, etc.)
    for (const updatable of this.updatables) {
      try {
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

    // PASS 0: UPDATE & OPTIONAL RENDER FOR SCENE EFFECTS
    for (const effect of sceneEffects) {
      try {
        // Allow scene effects to update internal state/uniforms
        let t0 = 0;
        if (doProfile) t0 = performance.now();
        effect.update(timeInfo);
        if (doProfile) profiler.recordEffectUpdate(effect.id, performance.now() - t0);

        // Most scene effects rely on the main scene render, but render is
        // still available for those that need it (e.g., to sync materials)
        if (doProfile) t0 = performance.now();
        effect.render(this.renderer, this.scene, this.camera);
        if (doProfile) profiler.recordEffectRender(effect.id, performance.now() - t0);
      } catch (error) {
        log.error(`Scene effect update/render error (${effect.id}):`, error);
        this.handleEffectError(effect, error);
      }
    }

    const usePostProcessing = postEffects.length > 0;

    // Debug log for post-processing path (throttled)
    if (usePostProcessing && Math.random() < 0.005) {
      log.debug('Rendering with Post-Processing', {
        postEffects: postEffects.map(e => e.id),
        sceneEffects: sceneEffects.length
      });
    }

    if (usePostProcessing) {
      // Render scene into HDR-capable off-screen target
      this.ensureSceneRenderTarget();
      this.renderer.setRenderTarget(this.sceneRenderTarget);
      this.renderer.clear();
    } else {
      // Default path: render directly to screen
      this.renderer.setRenderTarget(null);
    }

    // Single authoritative scene render (background, tiles, tokens, surface effects, etc.)
    // Ensure overlay-only objects (layer 31) are NEVER included in post-processing inputs.
    // They are rendered separately to screen in _renderOverlayToScreen().
    const prevSceneLayersMask = this.camera.layers.mask;
    try {
      this.camera.layers.disable(OVERLAY_THREE_LAYER);
      this.renderer.render(this.scene, this.camera);
    } finally {
      this.camera.layers.mask = prevSceneLayersMask;
    }

    // If no post-processing effects are active, we're done
    if (!usePostProcessing) {
      this._renderOverlayToScreen();
      if (doProfile) profiler.endFrame();
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
    if (doProfile) profiler.endFrame();
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
   * Determine if effect should render this frame (performance gating)
   * @param {EffectBase} effect - Effect to check
   * @param {TimeInfo} timeInfo - Current time information
   * @returns {boolean} Whether to render
   * @private
   */
  shouldRenderThisFrame(effect, timeInfo) {
    // Always render critical effects
    if (effect.alwaysRender) return true;

    // Skip expensive effects on low-tier GPUs if framerate is struggling
    if (this.capabilities && this.capabilities.tier === 'low') {
      if (effect.requiredTier === 'high') return false;
      if (effect.requiredTier === 'medium' && timeInfo.frameCount % 2 !== 0) {
        return false; // Render every other frame
      }
    }

    return true;
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

    // Resize all named render targets
    for (const [name, target] of this.renderTargets.entries()) {
      target.setSize(renderW, renderH);
      log.debug(`Resized render target: ${name} (${renderW}x${renderH})`);
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
  }

  /**
   * Get time manager (for external control)
   * @returns {TimeManager} Time manager instance
   */
  getTimeManager() {
    return this.timeManager;
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
   * Update effect state (called every frame before render)
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
