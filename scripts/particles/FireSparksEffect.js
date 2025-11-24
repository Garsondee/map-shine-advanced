import { EffectBase, RenderLayers } from '../effects/EffectComposer.js';
import { createLogger } from '../core/log.js';
import { weatherController } from '../core/WeatherController.js';

const log = createLogger('FireSparksEffect');

/**
 * Fire & Sparks Effect
 * Manages CPU-side fire logic:
 * 1. Creates/Destroys Particle Emitters (via EmitterManager)
 * 2. Manages Dynamic Lights for fires
 * 3. Provides Tweakpane UI for placing/editing fires
 */
export class FireSparksEffect extends EffectBase {
  constructor() {
    super('fire-sparks', RenderLayers.PARTICLES, 'low');
    
    /** @type {Array<{id: string, emitterId: string, light: THREE.PointLight, baseParams: Object}>} */
    this.fires = [];
    
    /** @type {import('./ParticleSystem.js').ParticleSystem|null} */
    this.particleSystem = null;

    // Cached _Fire mask texture so we can wire uniforms even if the asset
    // bundle loads before the ParticleSystem has finished initializing.
    /** @type {THREE.Texture|null} Cached _Fire mask texture for deferred wiring */
    this.fireMaskTexture = null;

    // Handles for the scene-wide emitters created from the _Fire mask
    /** @type {string|null} */
    this.globalFireEmitterId = null;
    /** @type {string|null} */
    this.globalSparksEmitterId = null;

    // Global settings
    this.settings = {
      enabled: true,
      windInfluence: 1.0,
      lightIntensity: 1.0,
      maxLights: 10
    };

    // UI-exposed parameters for debugging and tuning
    this.params = {
      enabled: true,
      globalFireRate: 0.25,
      globalSparksRate: 0.1,
      fireMaskEnabled: true,
      fireMaskThreshold: 0.05
    };
  }

  /**
   * Tweakpane control schema for Fire & Sparks debug settings
   * @returns {Object}
   */
  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'debug',
          label: 'Fire / Sparks Debug',
          type: 'inline',
          parameters: ['globalFireRate', 'globalSparksRate', 'fireMaskEnabled', 'fireMaskThreshold']
        }
      ],
      parameters: {
        globalFireRate: {
          type: 'slider',
          label: 'Global Fire Rate',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.25
        },
        globalSparksRate: {
          type: 'slider',
          label: 'Global Sparks Rate',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.1
        },
        fireMaskEnabled: {
          type: 'boolean',
          label: 'Use _Fire Mask',
          default: true
        },
        fireMaskThreshold: {
          type: 'slider',
          label: 'Mask Threshold',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.9
        }
      },
      presets: {}
    };
  }

  /**
   * Initialize the effect
   * @param {THREE.Renderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  initialize(renderer, scene, camera) {
    this.scene = scene;
    log.info('FireSparksEffect initialized');
  }

  /**
   * Set asset bundle to check for _Fire mask
   * @param {Object} bundle 
   */
  setAssetBundle(bundle) {
    if (!bundle || !bundle.masks) return;

    const fireMask = bundle.masks.find(m => m.type === 'fire');
    if (fireMask) {
       // Cache texture so we can apply it once the ParticleSystem is fully
       // initialized. SceneComposer may finish loading masks before
       // ParticleSystem.initialize has created its ShaderMaterial and
       // uniforms, so we cannot assume fireMap exists yet.
       this.fireMaskTexture = fireMask.texture;

       // If the ParticleSystem is already present and uniforms are live,
       // immediately bind the mask texture and related uniforms.
       if (this.particleSystem && this.particleSystem.uniforms) {
         log.info('Found _Fire mask, enabling Global Fire Mode');

         if (this.particleSystem.uniforms.fireMap) {
           this.particleSystem.uniforms.fireMap.value = this.fireMaskTexture;
           this.particleSystem.uniforms.fireMaskEnabled.value = this.params.fireMaskEnabled ? 1.0 : 0.0;
           if (this.particleSystem.uniforms.fireMaskThreshold) {
             this.particleSystem.uniforms.fireMaskThreshold.value = this.params.fireMaskThreshold;
           }
         }
       }
       
       // 2. Create Global Fire Emitter
       // We need scene bounds
       const dim = canvas.dimensions;
       const width = dim.sceneWidth || dim.width;
       const height = dim.sceneHeight || dim.height;
       const cx = (dim.sceneX || 0) + width / 2;
       const cy = (dim.sceneY || 0) + height / 2;
       
       // Fire Emitter covering scene
       const fireEmitter = this.particleSystem.emitterManager.addEmitter({
          type: 0, // Fire
          x: cx, y: cy, z: 0,
          // Rate is controlled by debug params so user can tune density
          rate: this.params.globalFireRate,
          param1: width,
          param2: height
       });
       this.globalFireEmitterId = fireEmitter.id;
       
       log.info(`Created Global Fire Emitter at (${cx}, ${cy}) size=${width}x${height} (sparks disabled for debug)`);
    }
  }

  /**
   * Connect to the ParticleSystem to access EmitterManager
   * Called by EffectComposer or manually after registration
   * @param {import('./ParticleSystem.js').ParticleSystem} particleSystem 
   */
  setParticleSystem(particleSystem) {
    this.particleSystem = particleSystem;
    log.info('Connected to ParticleSystem');

    // Deferred wiring: if setAssetBundle ran first and discovered a _Fire mask
    // before ParticleSystem.initialize created the ShaderMaterial, we bind the
    // cached texture and mask uniforms here once the uniforms object is ready.
    if (this.fireMaskTexture && this.particleSystem && this.particleSystem.uniforms && this.particleSystem.uniforms.fireMap) {
      this.particleSystem.uniforms.fireMap.value = this.fireMaskTexture;
      this.particleSystem.uniforms.fireMaskEnabled.value = this.params.fireMaskEnabled ? 1.0 : 0.0;
      if (this.particleSystem.uniforms.fireMaskThreshold) {
        this.particleSystem.uniforms.fireMaskThreshold.value = this.params.fireMaskThreshold;
      }
    }
  }

  /**
   * Create a new fire instance
   * @param {number} x - World X
   * @param {number} y - World Y
   * @param {number} radius - Radius of the fire base
   * @param {number} height - Height scale of the fire
   * @param {number} intensity - 0.0 to 1.0
   */
  createFire(x, y, radius = 50, height = 1.0, intensity = 1.0) {
    if (!this.particleSystem || !this.particleSystem.emitterManager) {
      log.warn('Cannot create fire: ParticleSystem or EmitterManager not ready');
      return null;
    }

    // 1. Create Particle Emitter
    const emitter = this.particleSystem.emitterManager.addEmitter({
      type: 0, // FIRE type
      x: x,
      y: y,
      z: 0, // Ground level
      rate: intensity,
      param1: radius,
      param2: height
    });

    // 2. Create Dynamic Light
    const light = new window.THREE.PointLight(0xff6600, 1.0, radius * 10.0);
    light.position.set(x, y, 50); // Slightly raised
    this.scene.add(light);

    const fireObj = {
      id: crypto.randomUUID(),
      emitterId: emitter.id,
      light: light,
      baseParams: { x, y, radius, height, intensity },
      noiseOffset: Math.random() * 100.0
    };

    this.fires.push(fireObj);
    log.info(`Created fire at (${x}, ${y}) radius=${radius}`);
    return fireObj.id;
  }

  /**
   * Remove a fire instance
   * @param {string} id 
   */
  removeFire(id) {
    const index = this.fires.findIndex(f => f.id === id);
    if (index !== -1) {
      const fire = this.fires[index];
      
      // Remove Emitter
      if (this.particleSystem && this.particleSystem.emitterManager) {
        this.particleSystem.emitterManager.removeEmitter(fire.emitterId);
        if (fire.sparksEmitterId) {
          this.particleSystem.emitterManager.removeEmitter(fire.sparksEmitterId);
        }
      }
      
      // Remove Light
      if (fire.light) {
        this.scene.remove(fire.light);
        fire.light.dispose();
      }
      
      this.fires.splice(index, 1);
      log.info(`Removed fire ${id}`);
    }
  }

  /**
   * Update loop (Light flickering)
   * @param {Object} timeInfo 
   */
  update(timeInfo) {
    if (!this.settings.enabled) return;

    const time = timeInfo.elapsed;

    for (const fire of this.fires) {
      // Simple flicker noise
      const n1 = Math.sin(time * 10.0 + fire.noiseOffset);
      const n2 = Math.cos(time * 23.0 + fire.noiseOffset * 2.0);
      const flicker = 1.0 + (n1 * 0.1 + n2 * 0.05);

      // Target intensity
      const targetInt = fire.baseParams.intensity * this.settings.lightIntensity * 2.0;
      
      if (fire.light) {
        fire.light.intensity = targetInt * flicker;
        // Optional: Modulate radius slightly?
        // fire.light.distance = fire.baseParams.radius * 10.0 * flicker;
      }
    }
  }
  
  /**
   * Clear all fires
   */
  clear() {
    // Copy array to avoid modification issues during iteration
    const ids = this.fires.map(f => f.id);
    ids.forEach(id => this.removeFire(id));
  }
  
  dispose() {
    this.clear();
    super.dispose();
  }
}
