/**
 * @fileoverview Effect composition and layering orchestrator
 * Manages effect dependencies, render order, and shared render targets
 * @module effects/EffectComposer
 */

import { createLogger } from '../core/log.js';
import { TimeManager } from '../core/time.js';

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
    
    /** @type {GPUCapabilities} */
    this.capabilities = null;
    
    /** @type {TimeManager} - Centralized time management */
    this.timeManager = new TimeManager();
    
    log.info('EffectComposer created');
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
   */
  registerEffect(effect) {
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
    effect.initialize(this.renderer, this.scene, this.camera);
    
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
   * Resolve effect dependencies and determine render order
   * @returns {EffectBase[]} Sorted effects ready for rendering
   * @private
   */
  resolveRenderOrder() {
    const enabledEffects = Array.from(this.effects.values())
      .filter(effect => effect.enabled);

    // Sort by layer order, then by effect priority
    enabledEffects.sort((a, b) => {
      if (a.layer.order !== b.layer.order) {
        return a.layer.order - b.layer.order;
      }
      return (a.priority || 0) - (b.priority || 0);
    });

    return enabledEffects;
  }

  /**
   * Render all effects in proper order
   * @param {number} deltaTime - Time since last frame in seconds (from RenderLoop, informational only)
   */
  render(deltaTime) {
    const effects = this.resolveRenderOrder();

    // Update centralized time (single source of truth)
    const timeInfo = this.timeManager.update();

    // Render each effect in order
    for (const effect of effects) {
      try {
        // Check if effect should render this frame (for performance gating)
        if (!this.shouldRenderThisFrame(effect, timeInfo)) {
          continue;
        }

        // Update effect state with time info
        effect.update(timeInfo);

        // Render effect
        effect.render(this.renderer, this.scene, this.camera);

      } catch (error) {
        log.error(`Effect render error (${effect.id}):`, error);
        // Disable problematic effect
        effect.enabled = false;
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
    for (const [name, target] of this.renderTargets.entries()) {
      target.setSize(width, height);
      log.debug(`Resized render target: ${name} (${width}x${height})`);
    }

    // Notify all effects of resize
    for (const effect of this.effects.values()) {
      if (effect.onResize) {
        effect.onResize(width, height);
      }
    }
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

    // Dispose render targets
    for (const target of this.renderTargets.values()) {
      target.dispose();
    }
    this.renderTargets.clear();
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
   * @param {number} width - New width
   * @param {number} height - New height
   */
  onResize(width, height) {
    // Override in subclass if needed
  }

  /**
   * Dispose effect resources
   */
  dispose() {
    // Override in subclass
  }
}
