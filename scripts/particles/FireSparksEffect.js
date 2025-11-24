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
      globalFireRate: 0.25
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
          label: 'Fire Debug',
          type: 'inline',
          parameters: ['globalFireRate']
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
   * Generates a DataTexture containing only the valid coordinates where fire should exist.
   *
   * This is the canonical pattern for turning a painted luminance mask texture
   * (e.g. Battlemap_Fire.png) into GPU-friendly spawn positions:
   * - CPU (load time):
   *   - Sample the mask once.
   *   - For every pixel whose brightness is above a threshold, record its
   *     normalized UV (0-1) and brightness.
   *   - Pack that list into a floating-point DataTexture (our "position map").
   * - GPU (render time):
   *   - The vertex shader draws a random UV into this position map.
   *   - Each particle reads back a pre-vetted UV and never sees black/empty
   *     regions of the original mask.
   *
   * Compared to per-frame rejection sampling against the mask, this lookup
   * approach is:
   * - Deterministic (every stored pixel is a guaranteed hit).
   * - Cheap on the GPU (just one texture read instead of repeated retries).
   * - Faithful to the authored luminance in the source image.
   *
   * @param {THREE.Texture} maskTexture - The source _Fire mask
   * @param {number} threshold - 0.0 to 1.0
   * @returns {THREE.DataTexture|null}
   */
  generatePositionMap(maskTexture, threshold = 0.1) {
    const THREE = window.THREE;
    if (!THREE) return null;

    // 1. Draw mask to a canvas to read pixel data
    const image = maskTexture.image;
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imgData.data; // RGBA array
    
    // 2. Collect valid coordinates
    const validCoords = [];
    for (let i = 0; i < data.length; i += 4) {
      // Simple luminance check (r+g+b)/3 or just use Red channel
      // Use Red channel since masks are typically R or grayscale
      const brightness = data[i] / 255.0; 
      
      if (brightness > threshold) {
        // Store normalized coordinates (0.0 to 1.0)
        const pixelIndex = i / 4;
        const x = (pixelIndex % canvas.width) / canvas.width;
        const y = Math.floor(pixelIndex / canvas.width) / canvas.height;
        
        // Push X, Y, and Brightness (for particle intensity)
        validCoords.push(x, y, brightness); 
      }
    }

    if (validCoords.length === 0) {
      log.warn("FireSparks: No valid spawn points found in mask!");
      return null;
    }

    // 3. Create a DataTexture big enough to hold these coords
    // We make a square texture to fit the data
    const count = validCoords.length / 3;
    const size = Math.ceil(Math.sqrt(count));
    const dataArray = new Float32Array(size * size * 4); // RGBA float texture

    for (let i = 0; i < count; i++) {
      const stride = i * 3;
      const texStride = i * 4;
      
      dataArray[texStride] = validCoords[stride];     // X
      dataArray[texStride + 1] = 1.0 - validCoords[stride + 1]; // Y (Flip Y for Three.js)
      dataArray[texStride + 2] = validCoords[stride + 2]; // Density/Brightness
      dataArray[texStride + 3] = 1.0; // Padding
    }

    const positionMap = new THREE.DataTexture(
      dataArray, 
      size, 
      size, 
      THREE.RGBAFormat, 
      THREE.FloatType
    );
    positionMap.needsUpdate = true;
    
    // Store how many valid points we have so the shader knows the range
    positionMap.userData = { validPoints: count };
    
    log.info(`Generated Fire Position Map: ${count} points, texture size ${size}x${size}`);
    return positionMap;
  }

  /**
   * Set asset bundle to check for _Fire mask
   * @param {Object} bundle 
   */
  setAssetBundle(bundle) {
    if (!bundle || !bundle.masks) return;

    const fireMask = bundle.masks.find(m => m.type === 'fire');
    if (fireMask) {
       // GENERATE THE LOOKUP MAP
       this.firePositionMap = this.generatePositionMap(fireMask.texture);
       
       if (this.particleSystem && this.particleSystem.uniforms) {
          // Pass the new map to uniforms
          if (this.particleSystem.uniforms.firePositionMap) {
             this.particleSystem.uniforms.firePositionMap.value = this.firePositionMap;
             log.info('Bound Fire Position Map to ParticleSystem');
          } else {
             log.warn('ParticleSystem uniforms exist but firePositionMap is missing');
          }
       }
       
       // 2. Create Global Fire Emitter if a particle backend is available
       if (this.particleSystem && this.particleSystem.emitterManager && typeof canvas !== 'undefined' && canvas.dimensions) {
         const dim = canvas.dimensions;
         const width = dim.sceneWidth || dim.width;
         const height = dim.sceneHeight || dim.height;
         const cx = (dim.sceneX || 0) + width / 2;
         const cy = (dim.sceneY || 0) + height / 2;

         const fireEmitter = this.particleSystem.emitterManager.addEmitter({
           type: 0, // Fire
           x: cx, y: cy, z: 0,
           rate: this.params.globalFireRate,
           param1: width,
           param2: height
         });
         this.globalFireEmitterId = fireEmitter.id;

         log.info(`Created Global Fire Emitter at (${cx}, ${cy}) size=${width}x${height}`);
       } else {
         log.warn('Fire mask found but ParticleSystem/EmitterManager not available; skipping global fire emitters');
       }
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

    // Deferred wiring: if setAssetBundle ran first and generated the map,
    // bind it now.
    if (this.firePositionMap && this.particleSystem && this.particleSystem.uniforms) {
      if (this.particleSystem.uniforms.firePositionMap) {
        this.particleSystem.uniforms.firePositionMap.value = this.firePositionMap;
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
