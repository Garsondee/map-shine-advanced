import { EffectBase, RenderLayers } from '../effects/EffectComposer.js';
import { createLogger } from '../core/log.js';
import { ParticleBuffers } from './ParticleBuffers.js';
import { createSimulationNode } from './shaders/simulation.js';
import { createParticleMaterial } from './shaders/rendering.js';
import { weatherController } from '../core/WeatherController.js';
import { RainStreakGeometry } from './RainStreakGeometry.js';
import { SnowGeometry } from './SnowGeometry.js';
import { EmitterManager } from './EmitterManager.js';

const log = createLogger('ParticleSystem');

/**
 * GPU-resident particle system effect (Phase 2)
 * Designed for renderer backends that support compute-style simulation and TSL NodeMaterial.
 */
export class ParticleSystem extends EffectBase {
  constructor(capacity = 60000) {
    // Temporarily use 'low' tier so the particle system always registers,
    // even on GPUs where advanced compute features are limited.
    super('particles', RenderLayers.PARTICLES, 'low');

    this.priority = 0;
    this.alwaysRender = false;

    /** @type {ParticleBuffers} */
    this.buffers = new ParticleBuffers(capacity);

    /** @type {RainStreakGeometry|null} */
    this.rainGeometry = null;
    /** @type {SnowGeometry|null} */
    this.snowGeometry = null;

    /** @type {import('./EmitterManager.js').EmitterManager|null} */
    this.emitterManager = new EmitterManager();

    /** @type {string|null} ID of the main weather emitter */
    this.weatherEmitterId = null;

    /** Renderer / scene references */
    this.renderer = null;
    this.scene = null;
    this.camera = null;

    /** @type {THREE.Points|null} */
    this.particles = null;

    /** @type {Function|null} */
    this.computeNode = null;

    /** @type {Object} */
    this.uniforms = {
      deltaTime: null,
      time: null,
      sceneBounds: null,
      roofMap: null,
      roofMaskEnabled: null,
      firePositionMap: null,
      globalWindInfluence: null,
      rainAngle: null
    };
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
      // 8. Initialize 3D Rain Streak Geometry
      this.rainGeometry = new RainStreakGeometry(20000);
      this.rainGeometry.initialize(THREE);
      if (this.rainGeometry.mesh) {
        this.scene.add(this.rainGeometry.mesh);
      }

      // 9. Initialize 3D Snow Geometry
      this.snowGeometry = new SnowGeometry(12000);
      this.snowGeometry.initialize(THREE);
      if (this.snowGeometry.mesh) {
        this.scene.add(this.snowGeometry.mesh);
      }

      // 10. Initialize Generic Stateless Particle Mesh (for Fire, Smoke, etc.)
      this.buffers.initialize(THREE);
      
      // We only need a per-particle index; the vertex shader computes positions procedurally
      const geometry = new THREE.BufferGeometry();
      const indexArray = new Float32Array(this.buffers.capacity);
      for (let i = 0; i < this.buffers.capacity; i++) {
        indexArray[i] = i;
      }
      geometry.setAttribute('index', new THREE.BufferAttribute(indexArray, 1));

      // Provide a dummy position attribute (all zeros). THREE.Points expects a position
      // attribute even if the shader completely overrides particle positions.
      const positionArray = new Float32Array(this.buffers.capacity * 3);
      geometry.setAttribute('position', new THREE.BufferAttribute(positionArray, 3));
      
      // Create a default white texture
      const defaultTex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
      defaultTex.needsUpdate = true;

      const material = createParticleMaterial(THREE, this.buffers, defaultTex, this.uniforms);
      
      this.particles = new THREE.Points(geometry, material);
      this.particles.frustumCulled = false; // Particles can be anywhere
      this.scene.add(this.particles);

      log.info('ParticleSystem initialized (Rain, Snow, and Generic Stateless Particles)');

      // Expose for debugging
      window.MapShineParticles = this;
      log.info('Debug: ParticleSystem exposed as window.MapShineParticles');

    } catch (e) {
      log.error('Failed to initialize ParticleSystem:', e);
      this.enabled = false;
    }
  }

  /**
   * Attach an emitter manager used to feed GPU buffers
   * @param {import('./EmitterManager.js').EmitterManager} manager
   */
  setEmitterManager(manager) {
    this.emitterManager = manager;
  }

  /**
   * Update per frame
   * @param {TimeInfo} timeInfo
   */
  update(timeInfo) {
    if (!this.enabled) return;
    // 0. Get current weather state
    let weather = weatherController.getCurrentState();

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

    const precip = (weather && typeof weather.precipitation === 'number') ? weather.precipitation : 0;
    const freeze = (weather && typeof weather.freezeLevel === 'number')
      ? Math.max(0, Math.min(1, weather.freezeLevel))
      : 0;

    const rainPrecip = precip * (1.0 - freeze);
    const snowPrecip = precip * freeze;

    if (this.rainGeometry) {
      const rainWeather = { ...weather, precipitation: rainPrecip };
      this.rainGeometry.update(timeInfo, rainWeather, boundsVec4);
    }

    if (this.snowGeometry) {
      const snowWeather = { ...weather, precipitation: snowPrecip };
      this.snowGeometry.update(timeInfo, snowWeather, boundsVec4);
    }

    // 4. Update emitter buffer for generic GPU particles (fire, sparks, etc.)
    if (this.emitterManager && this.buffers) {
      const emitList = this.emitterManager.buildFrameEmitList();
      this.buffers.updateEmitters(emitList);
    }

    // 5. Drive shader uniforms for time and scene bounds
    if (this.uniforms) {
      const dt = typeof timeInfo.delta === 'number' ? timeInfo.delta : 0.016;
      const t = typeof timeInfo.elapsed === 'number' ? timeInfo.elapsed : 0;

      if (this.uniforms.time && this.uniforms.time.value !== undefined) {
        this.uniforms.time.value = t;
      }
      if (this.uniforms.deltaTime && this.uniforms.deltaTime.value !== undefined) {
        this.uniforms.deltaTime.value = dt;
      }
      if (boundsVec4 && this.uniforms.sceneBounds && this.uniforms.sceneBounds.value) {
        this.uniforms.sceneBounds.value.copy(boundsVec4);
      }
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
    this.buffers.dispose();
    
    if (this.particles) {
      this.scene.remove(this.particles);
      if (this.particles.geometry) this.particles.geometry.dispose();
      if (this.particles.material) this.particles.material.dispose();
      this.particles = null;
    }
    
    if (this.rainGeometry) {
      if (this.rainGeometry.mesh && this.scene) {
        this.scene.remove(this.rainGeometry.mesh);
      }
      this.rainGeometry.dispose();
      this.rainGeometry = null;
    }

    if (this.snowGeometry) {
      if (this.snowGeometry.mesh && this.scene) {
        this.scene.remove(this.snowGeometry.mesh);
      }
      this.snowGeometry.dispose();
      this.snowGeometry = null;
    }
    
    this.computeNode = null;
    log.info('ParticleSystem disposed');
  }
}
