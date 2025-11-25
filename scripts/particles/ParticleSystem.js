import { EffectBase, RenderLayers } from '../effects/EffectComposer.js';
import { createLogger } from '../core/log.js';
import { weatherController } from '../core/WeatherController.js';
import { BatchedRenderer } from '../libs/three.quarks.module.js';
import { WeatherParticles } from './WeatherParticles.js';

const log = createLogger('ParticleSystem');

/**
 * GPU-resident particle system effect (Phase 2)
 * Designed for renderer backends that support compute-style simulation and TSL NodeMaterial.
 * Now integrating three.quarks for Phase 3 migration.
 */
export class ParticleSystem extends EffectBase {
  constructor(capacity = 60000) {
    // Temporarily use 'low' tier so the particle system always registers,
    // even on GPUs where advanced compute features are limited.
    super('particles', RenderLayers.PARTICLES, 'low');

    this.priority = 0;
    this.alwaysRender = false;

    /** @type {BatchedRenderer|null} three.quarks renderer */
    this.batchRenderer = null;
    
    /** @type {WeatherParticles|null} */
    this.weatherParticles = null;

    /** Renderer / scene references */
    this.weatherEmitterId = null;

    /** Renderer / scene references */
    this.renderer = null;
    this.scene = null;
    this.camera = null;

    /** @type {THREE.Points|null} */
    // this.particles = null; // Removed legacy particles

    /** @type {Object} */
    // this.uniforms = ... // Removed legacy uniforms
  }

  /**
   * Initialize effect (called once on registration)
   * @param {THREE.Renderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  async initialize(renderer, scene, camera) {
    log.info('ParticleSystem.initialize called');
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    const THREE = window.THREE;
    if (!THREE) {
      log.error('three.js not available; ParticleSystem not initialized');
      this.enabled = false;
      return;
    }

    try {
      // 1. Initialize three.quarks BatchedRenderer
      this.batchRenderer = new BatchedRenderer();
      this.scene.add(this.batchRenderer);
      log.info('Initialized three.quarks BatchedRenderer');

      // 2. Initialize Weather Particles (Rain/Snow)
      this.weatherParticles = new WeatherParticles(this.batchRenderer, this.scene);

      log.info('ParticleSystem initialized (Quarks: Weather support)');

      // Expose for debugging
      window.MapShineParticles = this;
      log.info('Debug: ParticleSystem exposed as window.MapShineParticles');

    } catch (e) {
      log.error('Failed to initialize ParticleSystem:', e);
      this.enabled = false;
    }
  }

  /**
   * Attach an emitter manager (Deprecated/Removed)
   * @param {any} manager
   */
  setEmitterManager(manager) {
    // No-op or warn
    log.warn('setEmitterManager is deprecated.');
  }

  /**
   * Update per frame
   * @param {TimeInfo} timeInfo
   */
  update(timeInfo) {
    if (!this.enabled) return;
    // 0. Step WeatherController so currentState reflects UI-driven targetState
    if (weatherController) {
      // Initialize once (no-op on subsequent calls)
      if (!weatherController.initialized && typeof weatherController.initialize === 'function') {
        weatherController.initialize();
      }

      if (typeof weatherController.update === 'function') {
        weatherController.update(timeInfo);
      }
    }

    // 1. Compute scene bounds vector for rain/snow clipping
    let boundsVec4 = null;
    if (typeof canvas !== 'undefined' && canvas.dimensions) {
      const d = canvas.dimensions;
      const sx = d.sceneX ?? 0;
      const sy = d.sceneY ?? 0;
      const sw = d.sceneWidth ?? d.width ?? 1000;
      const sh = d.sceneHeight ?? d.height ?? 1000;
      const THREE = window.THREE;
      if (THREE) {
        if (!this._sceneBounds) this._sceneBounds = new THREE.Vector4(sx, sy, sw, sh);
        this._sceneBounds.set(sx, sy, sw, sh);
        boundsVec4 = this._sceneBounds;
      }
    }

    // 5. Update Quarks Renderer
    if (this.batchRenderer) {
      const dtMs = typeof timeInfo.delta === 'number' ? timeInfo.delta : 16.0;
      const dt = dtMs * 0.001 * 500;

      // Update weather systems
      if (this.weatherParticles) {
        this.weatherParticles.update(dt);
      }

      this.batchRenderer.update(dt); // Quarks expects seconds
    }
  }

  /**
   * Render pass (standard render handles the scene)
   */
  render(renderer, scene, camera) {
    // No manual render needed; particles are in the scene graph
  }

  /**
   * Cleanup
   */
  dispose() {
    if (this.weatherParticles) {
      this.weatherParticles.dispose();
      this.weatherParticles = null;
    }
    
    if (this.batchRenderer) {
      this.scene.remove(this.batchRenderer);
      // batchRenderer doesn't strictly need dispose() but it helps if implemented
      this.batchRenderer = null;
    }

    log.info('ParticleSystem disposed');
  }
}
