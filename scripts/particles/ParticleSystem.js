import { EffectBase, RenderLayers } from '../effects/EffectComposer.js';
import { createLogger } from '../core/log.js';
import { ParticleBuffers } from './ParticleBuffers.js';
import { createSimulationNode } from './shaders/simulation.js';
import { createParticleMaterial } from './shaders/rendering.js';
import { weatherController } from '../core/WeatherController.js';

const log = createLogger('ParticleSystem');

/**
 * GPU-resident particle system effect (Phase 2)
 * Designed for renderer backends that support compute-style simulation and TSL NodeMaterial.
 */
export class ParticleSystem extends EffectBase {
  constructor(capacity = 100000) {
    // Temporarily use 'low' tier so the particle system always registers,
    // even on GPUs where advanced compute features are limited.
    super('particles', RenderLayers.PARTICLES, 'low');

    this.priority = 0;
    this.alwaysRender = false;

    /** @type {ParticleBuffers} */
    this.buffers = new ParticleBuffers(capacity);

    /** @type {import('./EmitterManager.js').EmitterManager|null} */
    this.emitterManager = null;

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
      sceneBounds: null
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
      // 1. Initialize Buffers
      this.buffers.initialize(THREE);
      log.info('ParticleSystem buffers initialized');

      // 2. Load Texture
      const textureLoader = new THREE.TextureLoader();
      const texture = textureLoader.load('modules/map-shine-advanced/assets/particle.webp');

      // 3. Create Rendering Material (WebGL2 ShaderMaterial)
      const material = createParticleMaterial(THREE, this.buffers, texture, this.uniforms);
      
      // 4. Create Geometry
      // For Points, we just need 'count' vertices. 
      // Storage Buffers are accessed via instanceIndex, so we need 'count' instances or vertices.
      // For Points, 'position' attribute is usually needed, but we use storage buffer for position.
      // We can provide a dummy buffer or use setDrawRange.
      const geometry = new THREE.BufferGeometry();
      geometry.setDrawRange(0, this.buffers.capacity);
      
      // Attach particle attributes
      geometry.setAttribute('position', this.buffers.positionBuffer);
      geometry.setAttribute('velocity', this.buffers.velocityBuffer);
      geometry.setAttribute('color', this.buffers.colorBuffer);
      geometry.setAttribute('ageLife', this.buffers.ageLifeBuffer);
      geometry.setAttribute('scaleType', this.buffers.scaleTypeBuffer);
      geometry.setAttribute('seed', this.buffers.seedBuffer);

      // Add explicit index attribute for TSL 'vertexIndex' (safety for WebGL2 fallback)
      const indices = new Float32Array(this.buffers.capacity);
      for (let i = 0; i < this.buffers.capacity; i++) indices[i] = i;
      geometry.setAttribute('index', new THREE.BufferAttribute(indices, 1));

      // PointsNodeMaterial expects a 'uv' vertex attribute. Provide a trivial one
      // so the attribute node can bind without errors.
      const dummyUv = new Float32Array(2);
      geometry.setAttribute('uv', new THREE.BufferAttribute(dummyUv, 2));

      // 5. Create Mesh (Points)
      this.particles = new THREE.Points(geometry, material);
      this.particles.frustumCulled = false; // Always render (bounds are dynamic)
      this.scene.add(this.particles);

      // 6. Ensure uniform objects exist
      // createParticleMaterial wires its internal ShaderMaterial uniforms into
      // this.uniforms.{time, deltaTime}, but we defensively initialize them
      // in case the implementation changes.
      if (!this.uniforms.deltaTime) this.uniforms.deltaTime = { value: 0.016 };
      if (!this.uniforms.time) this.uniforms.time = { value: 0.0 };
      
      // Simulation is handled directly in the vertex shader via createParticleMaterial
      
      // 7. Set initial scene bounds for clipping
      if (this.uniforms.sceneBounds && typeof canvas !== 'undefined' && canvas.dimensions) {
          const { sceneX, sceneY, sceneWidth, sceneHeight } = canvas.dimensions;
          this.uniforms.sceneBounds.value.set(sceneX, sceneY, sceneWidth, sceneHeight);
          log.info(`Set particle clipping bounds: x=${sceneX}, y=${sceneY}, w=${sceneWidth}, h=${sceneHeight}`);
      }

      log.info('ParticleSystem GPU initialized successfully');

      // Expose for debugging
      window.MapShineParticles = this;
      log.info('Debug: ParticleSystem exposed as window.MapShineParticles');

      // Initialize EmitterManager and Weather Emitter
      if (!this.emitterManager) {
        const { EmitterManager } = await import('./EmitterManager.js');
        this.emitterManager = new EmitterManager();
        
        // Add a persistent weather emitter covering the scene
        // Initial state is inactive (rate 0) until weather system updates it
        const handle = this.emitterManager.addEmitter({
          type: 2, // Rain type default
          x: 0, y: 0, z: 3000, // High ceiling
          rate: 0, // Start disabled
          param1: 1000, // Width (dynamic)
          param2: 1000  // Height (dynamic)
        });
        this.weatherEmitterId = handle.id;
        log.info(`Initialized Weather Emitter (ID: ${handle.id})`);
      }

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

    // 0. Sync with Weather Controller
    if (this.emitterManager && this.weatherEmitterId) {
      const weather = weatherController.getCurrentState();
      const emitter = this.emitterManager.emitters.find(e => e.id === this.weatherEmitterId);
      
      // Ensure scene bounds are up to date
      if (this.uniforms.sceneBounds && typeof canvas !== 'undefined' && canvas.dimensions) {
          const d = canvas.dimensions;
          const sx = d.sceneX ?? 0;
          const sy = d.sceneY ?? 0;
          const sw = d.sceneWidth ?? d.width ?? 1000;
          const sh = d.sceneHeight ?? d.height ?? 1000;
          
          this.uniforms.sceneBounds.value.set(sx, sy, sw, sh);
      }

      if (emitter) {
        // Update Rate (Precipitation)
        // Interpret precipitation 0..1 as density probability
        emitter.rate = weather.precipitation;

        // Update Type
        // 1=Rain -> Shader 2.0
        // 2=Snow -> Shader 3.0
        if (weather.precipType === 2) {
          emitter.type = 3.0; // Snow/Magic slot
        } else {
          emitter.type = 2.0; // Rain slot
        }

        // Update Area (Scene Bounds)
        if (this.uniforms.sceneBounds) {
          const b = this.uniforms.sceneBounds.value; // x, y, w, h
          emitter.x = b.x + b.z / 2;
          emitter.y = b.y + b.w / 2;
          emitter.param1 = b.z; // Width
          emitter.param2 = b.w; // Height
        }

        // Update Wind Uniform
        if (this.uniforms.windVector) {
          // Scale factor: wind speed 1.0 -> 1000 units/sec drift
          const speed = weather.windSpeed * 1000.0;
          const dir = weather.windDirection;
          if (dir && dir.x !== undefined) {
             this.uniforms.windVector.value.set(dir.x * speed, dir.y * speed, 0);
          }
        }
      }
    }

    // 1. Update Emitters (CPU -> GPU Buffer)
    if (this.emitterManager && this.buffers && this.buffers.updateEmitters) {
      const frameEmitters = this.emitterManager.buildFrameEmitList();
      if (frameEmitters.length > 0) {
        log.debug(`Dispatching ${frameEmitters.length} emitters to GPU`);
      }
      this.buffers.updateEmitters(frameEmitters);
    }

    // 2. Update Uniforms
    this.uniforms.deltaTime.value = timeInfo.delta;
    this.uniforms.time.value = timeInfo.elapsed;
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
    
    this.computeNode = null;
    log.info('ParticleSystem disposed');
  }
}
