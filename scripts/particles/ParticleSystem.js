import { EffectBase, RenderLayers } from '../effects/EffectComposer.js';
import { createLogger } from '../core/log.js';
import { weatherController } from '../core/WeatherController.js';
import { BatchedRenderer } from '../libs/three.quarks.module.js';
import { WeatherParticles } from './WeatherParticles.js';

const log = createLogger('ParticleSystem');

// TEMPORARY GLOBAL KILL-SWITCH:
// When true, completely disables all Quarks-based particle systems (weather, fire, splashes)
// so we can profile map pan/zoom performance without any particle overhead.
// Currently FALSE - particles are re-enabled after vision/fog optimization.
const DISABLE_ALL_PARTICLES = false;

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

    this._cullFrustum = null;
    this._cullProjScreenMatrix = null;
    this._cullSphere = null;
    this._cullCenter = null;
  }

  /**
   * Initialize effect (called once on registration)
   * @param {THREE.Renderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  async initialize(renderer, scene, camera) {
    log.info('ParticleSystem.initialize called');

    if (DISABLE_ALL_PARTICLES) {
      log.warn('ParticleSystem disabled by DISABLE_ALL_PARTICLES flag (perf testing).');
      this.enabled = false;
      return;
    }
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
      // LAYERING CONTRACT:
      // - All quarks SpriteBatches created from this renderer share its
      //   Object3D.renderOrder.
      // - Overhead tiles use renderOrder=10 and depthWrite=false so they do
      //   not dominate the depth buffer.
      // - WeatherParticles configures individual ParticleSystems with
      //   renderOrder=50 and MeshBasicMaterials that have depthWrite=false
      //   and depthTest=false.
      // - With this.batchRenderer.renderOrder=50, the resulting SpriteBatches
      //   render after tiles and, because they ignore depth, appear as an
      //   overlay above overhead geometry.
      this.batchRenderer.renderOrder = 50;
      try {
        const { OVERLAY_THREE_LAYER } = await import('../effects/EffectComposer.js');
        if (this.batchRenderer.layers && typeof this.batchRenderer.layers.enable === 'function') {
          this.batchRenderer.layers.enable(OVERLAY_THREE_LAYER);
        }
      } catch (_) {
      }
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
    if (DISABLE_ALL_PARTICLES) return;
    if (!this.enabled) return;
    // 0. Step WeatherController so currentState reflects UI-driven targetState
    if (weatherController) {
      // Initialize once (no-op on subsequent calls)
      if (!weatherController.initialized && typeof weatherController.initialize === 'function') {
        void weatherController.initialize();
      }

      if (typeof weatherController.update === 'function') {
        weatherController.update(timeInfo);
      }
    }

    // 1. Compute scene bounds vector for rain/snow clipping and masking
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
      // timeInfo.delta is in SECONDS (from TimeManager), not milliseconds.
      // We apply a simulation speed multiplier to control particle animation rate.
      const deltaSec = typeof timeInfo.delta === 'number' ? timeInfo.delta : 0.016;
      
      // CRITICAL: Clamp delta to prevent runaway particle spawning after frame stalls.
      // Without this clamp, a 1-second stall would try to spawn 1 second worth of
      // particles in a single frame, causing a feedback loop where:
      //   large delta → spawn many particles → frame takes longer → larger delta → freeze
      // We cap at 100ms (0.1s) of simulation per frame to break this cycle.
      const clampedDelta = Math.min(deltaSec, 0.1);
      
      // Global simulation speed control for Quarks-based systems (weather, fire, etc.).
      // A value of 2.0 with baseScale 750 reproduces the previous 1500x multiplier.
      const simSpeed = (weatherController && typeof weatherController.simulationSpeed === 'number')
        ? weatherController.simulationSpeed
        : 2.0;
      const baseScale = 750;
      // NOTE: The * 0.001 factor was historically used because the code assumed
      // delta was in milliseconds. Since TimeManager provides seconds, this
      // effectively scales simulation time by 0.001 * 750 * 2 = 1.5x real-time.
      // We preserve this for backwards compatibility with tuned particle parameters.
      const dt = clampedDelta * 0.001 * baseScale * simSpeed;

      // Update weather systems (pass dt and scene bounds if available)
      if (this.weatherParticles) {
        this.weatherParticles.update(dt, boundsVec4);
      }

      this._applyQuarksCulling();

      this.batchRenderer.update(dt); // Quarks expects seconds
    }
  }

  _applyQuarksCulling() {
    const THREE = window.THREE;
    if (!THREE) return;
    const sceneComposer = window.MapShine?.sceneComposer;
    const camera = sceneComposer?.camera || this.camera;
    if (!camera) return;
    const systemMap = this.batchRenderer?.systemToBatchIndex;
    if (!systemMap || typeof systemMap.forEach !== 'function') return;

    if (!this._cullFrustum) this._cullFrustum = new THREE.Frustum();
    if (!this._cullProjScreenMatrix) this._cullProjScreenMatrix = new THREE.Matrix4();
    if (!this._cullSphere) this._cullSphere = new THREE.Sphere();
    if (!this._cullCenter) this._cullCenter = new THREE.Vector3();

    if (typeof camera.updateProjectionMatrix === 'function') camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    this._cullProjScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._cullFrustum.setFromProjectionMatrix(this._cullProjScreenMatrix);
    const groundZ = (sceneComposer && typeof sceneComposer.groundZ === 'number') ? sceneComposer.groundZ : null;

    systemMap.forEach((_, ps) => {
      if (!ps || !ps.emitter) return;
      const emitter = ps.emitter;
      const ud = emitter.userData || (emitter.userData = {});
      if (ud.msAutoCull === false) return;

      const pos = emitter.position;
      const c = ud.msCullCenter;
      if (c && typeof c === 'object') {
        if (typeof c.x === 'number' && typeof c.y === 'number' && typeof c.z === 'number') {
          this._cullCenter.set(c.x, c.y, c.z);
        } else if (Array.isArray(c) && c.length >= 3) {
          this._cullCenter.set(c[0], c[1], c[2]);
        } else {
          this._cullCenter.set(pos.x, pos.y, pos.z);
        }
      } else {
        this._cullCenter.set(pos.x, pos.y, pos.z);
      }

      let radius = 500;
      const shape = ps.emitterShape;
      if (shape && typeof shape.width === 'number' && typeof shape.height === 'number') {
        const w = Math.max(0, shape.width);
        const h = Math.max(0, shape.height);
        radius = 0.5 * Math.sqrt(w * w + h * h);
      }

      if (groundZ !== null) {
        radius += Math.max(0, Math.abs(this._cullCenter.z - groundZ)) * 0.5;
      }

      if (typeof ud.msCullRadius === 'number' && Number.isFinite(ud.msCullRadius) && ud.msCullRadius > 0) {
        radius = ud.msCullRadius;
      }

      this._cullSphere.center.copy(this._cullCenter);
      this._cullSphere.radius = radius;

      const visible = this._cullFrustum.intersectsSphere(this._cullSphere);
      ud._msLastCullVisible = visible;
      ud._msLastCullRadius = radius;
      ud._msLastCullCenter = { x: this._cullCenter.x, y: this._cullCenter.y, z: this._cullCenter.z };
      const wasCulled = !!ud._msCulled;
      emitter.visible = visible;
      if (visible) {
        if (wasCulled) {
          if (typeof ps.play === 'function') ps.play();
          ud._msCulled = false;
        }
      } else {
        if (!wasCulled) {
          if (typeof ps.pause === 'function') ps.pause();
          ud._msCulled = true;
        }
      }
    });
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
