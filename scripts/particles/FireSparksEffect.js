import { EffectBase, RenderLayers } from '../effects/EffectComposer.js';
import { DistortionLayer } from '../effects/DistortionManager.js';
import { createLogger } from '../core/log.js';
import { 
  ParticleSystem, 
  IntervalValue,
  ColorRange,
  Vector4,
  PointEmitter,
  RenderMode,
  ApplyForce,
  ConstantValue,
  ColorOverLife,
  SizeOverLife,
  PiecewiseBezier,
  Bezier,
  CurlNoiseField,
  FrameOverLife
} from '../libs/three.quarks.module.js';
import { weatherController } from '../core/WeatherController.js';
import { SmartWindBehavior } from './SmartWindBehavior.js';

const log = createLogger('FireSparksEffect');

/**
 * Emitter shape that spawns particles from a precomputed list of valid
 * coordinates sampled from the _Fire mask.
 *
 * MASK AUTHORING CONTRACT (baked into this shape):
 * - The `_Fire` image must have the **same pixel resolution** as the main
 *   battlemap albedo texture (e.g. 2250x2250 in this scene).
 * - Fire authoring happens in the **same UV space** as the base texture:
 *     * u in [0,1] runs left → right across the scene.
 *     * v in [0,1] runs top  → bottom in image space.
 * - Bright pixels (red channel) in `_Fire` mark where fire should spawn.
 * - The loader (assets/loader.js) exposes this as `type: 'fire'` with
 *   `suffix: '_Fire'` in the MapAssetBundle.
 *
 * CPU SAMPLING CONTRACT:
 * - `_generatePoints` walks the `_Fire` image once on the CPU and collects
 *   (u, v, brightness) triples for all pixels above a luminance threshold.
 * - `width/height` and `offsetX/offsetY` passed to this shape define the
 *   **scene rectangle in world units** that the UVs are mapped onto.
 *   For Map Shine this is:
 *     width  = canvas.dimensions.sceneWidth
 *     height = canvas.dimensions.sceneHeight
 *     offsetX = canvas.dimensions.sceneX
 *     offsetY = H - sceneY - sceneHeight  (Y-inverted world coords)
 */
/**
 * Emitter shape that spawns particles from a list of discrete world-space
 * points (from MapPointsManager). Used for v1.x backwards compatibility
 * where fire sources are defined as explicit coordinates rather than masks.
 *
 * This aggregates ALL map points into a single emitter shape so we only
 * need 1-2 particle systems total instead of N systems per point.
 */
class MultiPointEmitterShape {
  /**
   * @param {Float32Array} points - Packed [x, y, intensity, x, y, intensity, ...] in world coords
   * @param {Object} ownerEffect - Reference to FireSparksEffect for weather queries
   */
  constructor(points, ownerEffect) {
    this.points = points; // Float32Array: [x, y, intensity, ...]
    this.ownerEffect = ownerEffect;
    this.type = 'multi_point';
  }

  initialize(p) {
    const count = this.points.length / 3;
    if (count === 0) return;

    // Pick a random point from the list
    const idx = Math.floor(Math.random() * count) * 3;
    const worldX = this.points[idx];
    const worldY = this.points[idx + 1];
    const intensity = this.points[idx + 2];

    // Defensive: if data is bad, kill this particle immediately
    if (!Number.isFinite(worldX) || !Number.isFinite(worldY) || !Number.isFinite(intensity) || intensity <= 0) {
      if (typeof p.life === 'number') p.life = 0;
      if (p.color && typeof p.color.w === 'number') p.color.w = 0;
      if (typeof p.size === 'number') p.size = 0;
      return;
    }

    // Position directly in world space (already converted by setMapPointsSources)
    // Fire particles must spawn at the ground plane Z level to align with the map.
    const sceneComposer = window.MapShine?.sceneComposer;
    const groundZ = (sceneComposer && typeof sceneComposer.groundZ === 'number')
      ? sceneComposer.groundZ
      : 1000;

    p.position.x = worldX;
    p.position.y = worldY;
    p.position.z = groundZ;

    // Apply intensity-based modifiers
    if (typeof p.life === 'number') {
      p.life *= (0.5 + 0.5 * intensity);
    }
    if (typeof p.size === 'number') {
      p.size *= (0.6 + 0.4 * intensity);
    }

    // Reset velocity
    if (p.velocity) {
      p.velocity.set(0, 0, 0);
    }
  }

  update(system, delta) {
    // Static point list, no per-frame evolution
  }
}

class FireMaskShape {
  constructor(points, width, height, offsetX, offsetY, ownerEffect) {
    this.points = points;
    this.width = width;
    this.height = height;
    this.offsetX = offsetX;
    this.offsetY = offsetY;
    this.ownerEffect = ownerEffect;
    this.type = 'fire_mask'; 
  }
  
  initialize(p) {
    const count = this.points.length / 3;
    if (count === 0) return;

    // 1. Pick a random point in the precomputed (u, v, brightness) list
    const idx = Math.floor(Math.random() * count) * 3;
    const u = this.points[idx];
    const v = this.points[idx + 1];
    const brightness = this.points[idx + 2]; // 0.0 to 1.0 luminance from the _Fire mask

    // Defensive: if mask data is bad, kill this particle immediately.
    if (!Number.isFinite(u) || !Number.isFinite(v) || !Number.isFinite(brightness) || brightness <= 0.0) {
      if (typeof p.life === 'number') p.life = 0;
      if (p.color && typeof p.color.w === 'number') p.color.w = 0;
      if (typeof p.size === 'number') p.size = 0;
      return;
    }

    // 2. Direct UV mapping onto the scene rectangle. The _Fire mask has the
    // same pixel dimensions as the base albedo for the scene, so we treat
    // (u, v) exactly like the base texture UVs.
    //
    // IMPORTANT ORIENTATION DETAIL:
    // - Image v=0 is the **top** of the bitmap; v=1 is the bottom.
    // - World Y grows upward, while Foundry / PIXI images treat 0 as top.
    // - SceneComposer positions the base plane and then flips it with
    //   `scale.y = -1`, so visually the image looks correct in world space.
    // - To place particles back onto that same plane we must therefore use
    //   (1 - v) when mapping into world Y.
    //
    // GROUND PLANE ALIGNMENT:
    // - SceneComposer.createBasePlane() positions the base plane mesh at a
    //   canonical groundZ (1000 by default) so that with the camera at Z=2000
    //   we get a clean 1:1 pixel mapping at zoom=1.
    // - When that groundZ changes, particles spawning at z=0 will appear
    //   offset from the visible map. To keep fire visually glued to the
    //   ground we spawn at the same groundZ used by SceneComposer.
    const sceneComposer = window.MapShine?.sceneComposer;
    const groundZ = (sceneComposer && typeof sceneComposer.groundZ === 'number')
      ? sceneComposer.groundZ
      : 1000;

    p.position.x = this.offsetX + u * this.width;
    p.position.y = this.offsetY + (1.0 - v) * this.height;
    p.position.z = groundZ;

    // 3. TAGGING: Check "Outdoors" mask to determine wind susceptibility.
    // We query the WeatherController using the same (u, 1-v) logic? 
    // Wait, getRoofMaskIntensity expects normalized UVs where 0,0 is top-left of image?
    // The helper in WeatherController takes standard UVs (0-1).
    // Let's assume it matches the texture space (u, v) we just read.
    // NOTE: WeatherController.getRoofMaskIntensity reads (u,v) directly from the mask data array.
    // The _Outdoors texture matches the _Fire texture in orientation.
    let outdoorFactor = weatherController.getRoofMaskIntensity(u, v);
    if (!Number.isFinite(outdoorFactor) || outdoorFactor < 0) outdoorFactor = 0;
    if (outdoorFactor > 1) outdoorFactor = 1;
    p._windSusceptibility = outdoorFactor;

    // Indoor vs Outdoor behavior tweak:
    // - outdoorFactor ~= 1.0  -> fully exposed fire (legacy behavior)
    // - outdoorFactor ~= 0.0  -> fully indoors (under solid roof)
    // For indoor fire "sparks", shorten their lifetime so they appear
    // tighter and less buoyant than outdoor sparks. We leave outdoor
    // particles unchanged. The scale factor is configurable per-effect
    // via FireSparksEffect.params.indoorLifeScale.
    if (outdoorFactor <= 0.01 && typeof p.life === 'number') {
      const params = this.ownerEffect && this.ownerEffect.params ? this.ownerEffect.params : null;
      const indoorLifeScale = params && typeof params.indoorLifeScale === 'number'
        ? params.indoorLifeScale
        : 0.2;
      p.life *= indoorLifeScale;
    }

    // 4. Weather Guttering: Rain + Wind kills exposed fire
    // "High wind speed plus high precipitation should mean the fire is almost out"
    const weather = weatherController.getCurrentState ? weatherController.getCurrentState() : {};
    let precip = weather && typeof weather.precipitation === 'number' ? weather.precipitation : 0;
    let wind = weather && typeof weather.windSpeed === 'number' ? weather.windSpeed : 0;
    if (!Number.isFinite(precip)) precip = 0;
    if (!Number.isFinite(wind)) wind = 0;
    
    // Only affect particles that are somewhat outdoors and weather is bad
    if (outdoorFactor > 0.01 && (precip > 0.05 || wind > 0.1)) {
        const params = this.ownerEffect && this.ownerEffect.params ? this.ownerEffect.params : null;
        const precipKill = params && typeof params.weatherPrecipKill === 'number' ? params.weatherPrecipKill : 0.8;
        const windKill = params && typeof params.weatherWindKill === 'number' ? params.weatherWindKill : 0.4;

        // Calculate weather stress (0.0 = None, 1.0+ = Heavy)
        // UI controls scale the impact of precipitation and wind.
        const weatherStress = 0.5 * (precip * precipKill + wind * windKill) * outdoorFactor;
        
        // Survival factor: 1.0 (Healthy) -> 0.1 (Dying)
        const survival = Math.max(0.1, 1.0 - weatherStress);
        
        if (typeof p.life === 'number') {
            p.life *= survival;
        }
        
        // Dying flames are smaller
        if (typeof p.size === 'number') {
            p.size *= (0.6 + 0.4 * survival);
        }
        
        // Dying flames are more transparent (fizzle out)
        if (p.color && typeof p.color.w === 'number') {
            p.color.w *= (0.5 + 0.5 * survival);
        }
    }

    // 5. Apply brightness-based modifiers. The particle system has already
    // assigned random life/size/opacity; we now scale them by mask luminance.

    // Lifetime: Darker pixels die faster.
    // At 0 brightness, keep 30% life; at 1.0 brightness, keep 100%.
    if (typeof p.life === 'number') {
      p.life *= (0.3 + 0.7 * brightness);
    }

    // Size: Darker pixels spawn smaller flames.
    // At 0 brightness, 40% size; at 1.0 brightness, 100%.
    if (typeof p.size === 'number') {
      p.size *= (0.4 + 0.6 * brightness);
    }

    // Opacity (Alpha): Darker pixels are much more transparent.
    // Using brightness^2 gives a sharper falloff so grey pixels look ghostly.
    if (p.color && typeof p.color.w === 'number') {
      p.color.w *= (brightness * brightness);
    }

    // 5. Reset velocity to prevent accumulation across particle reuse
    if (p.velocity) {
      p.velocity.set(0, 0, 0);
    }

    // Final sanity check: if any core properties are invalid or extreme, kill the particle.
    const tooBig = (val) => !Number.isFinite(val) || Math.abs(val) > 1e6;

    const posBad = p.position && (tooBig(p.position.x) || tooBig(p.position.y) || tooBig(p.position.z));
    const lifeBad = typeof p.life === 'number' && tooBig(p.life);
    const sizeBad = typeof p.size === 'number' && tooBig(p.size);
    const alphaBad = p.color && typeof p.color.w === 'number' && tooBig(p.color.w);

    if (posBad || lifeBad || sizeBad || alphaBad) {
      if (typeof p.life === 'number') p.life = 0;
      if (typeof p.size === 'number') p.size = 0;
      if (p.color && typeof p.color.w === 'number') p.color.w = 0;
    }
  }

  // three.quarks emitter shapes are expected to expose an update(system, delta)
  // method. Our fire mask is static in time, so this is a no-op.
  update(system, delta) {
    // No per-frame evolution of the spawn mask.
  }
}

// Simple sprite spin behavior for fire quads. Each particle gets a random
// angular velocity (both magnitude and direction) on spawn, then rotates in
// place over its lifetime. Parameters are read from the owning
// FireSparksEffect via system.userData.ownerEffect.
class FireSpinBehavior {
  constructor() {
    this.type = 'FireSpin';
  }

  initialize(particle, system) {
    // System is available here
    if (!particle || !system || !system.userData || !system.userData.ownerEffect) return;

    const effect = system.userData.ownerEffect;
    const params = effect?.params || {};

    // Check if enabled immediately
    if (params.fireSpinEnabled === false) {
      particle._spinSpeed = 0;
      return;
    }

    // Calculate speeds from params
    const min = typeof params.fireSpinSpeedMin === 'number' ? params.fireSpinSpeedMin : 0.5;
    const maxBase = typeof params.fireSpinSpeedMax === 'number' ? params.fireSpinSpeedMax : 2.5;
    const max = Math.max(min, maxBase);

    const base = min + Math.random() * (max - min);
    const dir = Math.random() < 0.5 ? -1 : 1;
    const spinBoost = 3.0;

    // Store final spin speed directly on particle for fast per-frame update
    particle._spinSpeed = base * dir * spinBoost;
  }

  update(particle, delta) {
    if (!particle || typeof delta !== 'number') return;

    // Clamp delta to avoid huge jumps after stalls
    let dt = delta;
    if (!Number.isFinite(dt)) return;
    dt = Math.min(Math.max(dt, 0), 0.1);
    if (dt <= 0.0001) return;

    // If speed is 0 or undefined, do nothing
    if (!Number.isFinite(particle._spinSpeed) || particle._spinSpeed === 0) return;

    const dAngle = particle._spinSpeed * dt;
    if (!Number.isFinite(dAngle)) return;

    // three.quarks usually uses a number for billboard rotation,
    // but some configurations use an object with .z
    if (typeof particle.rotation === 'number') {
      const next = particle.rotation + dAngle;
      if (Number.isFinite(next)) particle.rotation = next;
    } else if (particle.rotation && typeof particle.rotation.z === 'number') {
      const nextZ = particle.rotation.z + dAngle;
      if (Number.isFinite(nextZ)) particle.rotation.z = nextZ;
    }
  }

  frameUpdate(delta) { /* no-op */ }

  reset() { /* no-op, required by behavior interface */ }

  clone() {
    return new FireSpinBehavior();
  }
}

export class FireSparksEffect extends EffectBase {
  constructor() {
    super('fire-sparks', RenderLayers.PARTICLES, 'low');
    this.fires = [];
    this.particleSystemRef = null; 
    this.globalSystem = null;
    this.globalEmbers = null;
    this._lastAssetBundle = null;
    this._lastMapPointsManager = null;
    this.emberTexture = null;
    
    // PERFORMANCE: Reusable objects to avoid per-frame allocations in update()
    // These are cleared/reused each frame instead of creating new instances.
    this._tempVec2 = null; // Lazy init when THREE is available
    this._reusableIntervalValue = null;
    this._reusableConstantValue = null;
    // Per-system reusable color objects (keyed by system reference)
    this._systemColorCache = new WeakMap();
    
    this.settings = {
      enabled: true,
      windInfluence: 1.0,
      lightIntensity: 1.0,
      maxLights: 10
    };
    this.params = {
      enabled: true,
      // Tuned default from scene: Global Intensity
      globalFireRate: 4.0,
      // Tuned default: very low flame height for floor-level glyphs
      fireHeight: 10.0,
      fireSize: 18.0,
      emberRate: 5.0,
      // Wind Influence is controlled by WeatherController; keep existing default
      windInfluence: 5.0,
      // Updated default from scene
      lightIntensity: 5.0,

      // Fire fine controls (defaults from Mad Scientist scene)
      fireSizeMin: 60.0,
      fireSizeMax: 95.0,
      fireLifeMin: 2.3,
      fireLifeMax: 2.55,
      fireOpacityMin: 0.2,
      fireOpacityMax: 0.8,
      fireColorBoostMin: 0.0,
      fireColorBoostMax: 1.35,
      fireSpinEnabled: true,
      fireSpinSpeedMin: 0.2,
      fireSpinSpeedMax: 0.7,

      // Temperature Control
      // 0.0 = Chilled/Dying (Red/Grey), 0.5 = Standard (Orange), 1.0 = Bunsen (Blue)
      fireTemperature: 0.5,

      // Ember fine controls (keep most previous tuning, update sizes from scene)
      emberSizeMin: 13.0,
      emberSizeMax: 22.0,
      emberLifeMin: 0.7,
      emberLifeMax: 3.6,
      emberOpacityMin: 0.67,
      emberOpacityMax: 0.89,
      emberColorBoostMin: 1.70,
      emberColorBoostMax: 2.85,

      // New color controls
      fireStartColor: { r: 1.0, g: 1.0, b: 1.0 },
      fireEndColor: { r: 0.8, g: 0.2, b: 0.05 },
      emberStartColor: { r: 1.0, g: 0.8, b: 0.4 },
      emberEndColor: { r: 1.0, g: 0.2, b: 0.0 },

      // Physics controls (match Mad Scientist scene where provided)
      fireUpdraft: 0.95,
      emberUpdraft: 1.6,
      fireCurlStrength: 0.7,
      emberCurlStrength: 6.05,

      // Weather guttering controls (outdoor fire kill strength)
      // These scale how strongly precipitation and wind reduce fire lifetime
      // and size during spawn-time guttering in FireMaskShape.initialize.
      // Defaults preserve existing tuned behavior: precip 0.8, wind 0.4.
      weatherPrecipKill: 0.8,
      weatherWindKill: 0.4,

      // Per-effect time scaling (independent of global Simulation Speed)
      // 1.0 = baseline, >1.0 = faster (shorter lifetimes), <1.0 = slower.
      // Updated default from scene: Time Scale = 3.0
      timeScale: 3.0,

      // ========== HEAT DISTORTION CONTROLS ==========
      // Heat distortion creates a rippling heat haze effect around fire sources
      heatDistortionEnabled: false,
      heatDistortionIntensity: 0.015, // Strength of UV offset (0.0 - 0.05)
      heatDistortionFrequency: 8.0,   // Noise frequency for shimmer pattern
      heatDistortionSpeed: 1.0,       // Animation speed multiplier
      heatDistortionBlurRadius: 4.0,  // Blur radius for mask expansion
      heatDistortionBlurPasses: 3,    // Number of blur passes (more = wider area)
      heatDistortionBoost: 2.0,       // Brightness boost before blur (expands effective area)

      // Indoor vs outdoor lifetime scaling.
      // 1.0 = indoor flames live as long as outdoor flames.
      // <1.0 = indoor flames are shorter-lived (tighter, less buoyant).
      // This is applied in FireMaskShape.initialize when outdoorFactor ~ 0.
      indoorLifeScale: 0.75,

      // ========== FLAME SHAPE ATLAS CONTROLS ==========
      // Global flame shape parameters (affect all animation frames)
      flameNoiseScale: 1.1,         // Frequency of noise distortion
      flameNoiseStrength: 1.0,      // How much noise distorts the shape
      flameTaper: 0.0,              // Vertical taper (0=no taper, 1=full taper to point)
      flameWidth: 0.5,              // Horizontal scale of flame shape
      flameHeight: 0.5,             // Vertical scale of flame shape
      flameEdgeSoftness: 1.0,       // Edge falloff softness
      flameCoreBrightness: 4.0,     // Core intensity multiplier
      flameCoreSize: 0.16,          // Size of hot core relative to flame
      // Master intensity for all flame sprites
      flameAtlasIntensity: 2.0,
      // Global opacity multiplier for all sprites
      flameAtlasOpacity: 0.46,
      // Non-linear alpha response for the atlas. 1.0 = linear, >1.0 = tighter
      // cores with softer edges, <1.0 = broader, softer flames.
      flameAlphaGamma: 1.0
    };

    // Create procedural flame atlas texture after params are initialized so
    // _drawFlameInCell can safely read this.params during atlas generation.
    this.fireTexture = this._createFireTexture();
  }
  
  /**
   * Create a procedural 8x8 flame atlas texture with 64 animation frames.
   * Increased from 4x4 to 8x8 for 60fps-equivalent smoothness.
   * @returns {THREE.CanvasTexture}
   */
  _createFireTexture() {
    const THREE = window.THREE;
    if (!THREE) return null;

    // Build an 8x8 atlas of flame animation frames (64 frames)
    const cellSize = 128;  // Keep 128px for crisp detail
    const grid = 8;        // Total size: 1024x1024

    // IMPORTANT: Store grid size immediately so _drawFlameInCell knows we are in 8x8 mode
    this._flameAtlasGrid = grid;
    this._flameAtlasCellSize = cellSize;

    const totalSize = cellSize * grid; 

    const canvas = document.createElement('canvas');
    canvas.width = totalSize;
    canvas.height = totalSize;
    const ctx = canvas.getContext('2d');

    // Store canvas reference/context for later atlas regeneration.
    this._flameAtlasCanvas = canvas;
    this._flameAtlasCtx = ctx;

    // Generate all 64 flame tiles procedurally
    for (let row = 0; row < grid; row++) {
      for (let col = 0; col < grid; col++) {
        this._drawFlameInCell(ctx, col, row, cellSize);
      }
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;

    return texture;
  }


  /**
   * Simplex-like 2D noise function for procedural flame shapes.
   * Uses a combination of sine waves to approximate organic noise.
   * @param {number} x - X coordinate
   * @param {number} y - Y coordinate
   * @param {number} seed - Per-tile seed for variation
   * @returns {number} Noise value in range [-1, 1]
   */
  _flameNoise(x, y, seed = 0) {
    // Multi-octave sine-based noise approximation
    
    // CHANGE: Removed "* 127.1". 
    // The 'seed' passed from _drawFlameInCell is already calculated as a 
    // continuous phase (0 to 2PI). Multiplying it destroys the continuity.
    const s = seed; 

    let n = 0;
    n += Math.sin(x * 1.0 + y * 1.7 + s) * 0.5;
    n += Math.sin(x * 2.3 - y * 1.9 + s * 1.3) * 0.25;
    n += Math.sin(x * 4.1 + y * 3.7 + s * 0.7) * 0.125;
    n += Math.sin(x * 7.9 - y * 6.3 + s * 2.1) * 0.0625;
    return n;
  }

  /**
   * Draw a single flame shape into a cell of the atlas.
   * For an 8x8 atlas, tileIndex 0-63 represents animation frames with evolving noise phase.
   * @param {CanvasRenderingContext2D} ctx - Canvas context
   * @param {number} cellX - Cell X index (0-7)
   * @param {number} cellY - Cell Y index (0-7)
   * @param {number} cellSize - Size of each cell in pixels
   */
  _drawFlameInCell(ctx, cellX, cellY, cellSize) {
    const p = this.params || {};
    // Ensure we default to 8 if not set, though _createFireTexture sets it now.
    const grid = this._flameAtlasGrid || 8; 
    const tileIndex = cellY * grid + cellX; // 0-63 for 8x8 grid

    // For animation: use tileIndex as a time phase offset (0 to 1 over 64 frames)
    const timePhase = tileIndex / (grid * grid); // 0.0 to ~0.98

    // Get per-tile parameters (fall back to globals)
    // For animation frames, we use global params since all frames share the same base shape
    const getTileParam = (baseName, globalName) => {
      const globalKey = `flame${globalName}`;
      return p[globalKey] !== undefined ? p[globalKey] : 1.0;
    };

    const noiseScale = getTileParam('NoiseScale', 'NoiseScale');
    const noiseStrength = getTileParam('NoiseStrength', 'NoiseStrength');
    const taper = getTileParam('Taper', 'Taper');
    const widthScale = getTileParam('Width', 'Width') || 1.0;
    const heightScale = getTileParam('Height', 'Height') || 1.0;
    const edgeSoftness = getTileParam('EdgeSoftness', 'EdgeSoftness');
    const coreBrightness = p.flameCoreBrightness !== undefined ? p.flameCoreBrightness : 1.0;
    const coreSize = p.flameCoreSize !== undefined ? p.flameCoreSize : 0.3;

    // Global atlas intensity controls
    const atlasIntensity = (typeof p.flameAtlasIntensity === 'number') ? p.flameAtlasIntensity : 1.0;
    const atlasOpacity = (typeof p.flameAtlasOpacity === 'number') ? p.flameAtlasOpacity : 1.0;
    const alphaGamma = (typeof p.flameAlphaGamma === 'number') ? p.flameAlphaGamma : 1.0;

    // Animation seed: base seed + time phase offset for smooth evolution
    // The timePhase creates a continuous animation loop across all 64 frames
    const baseSeed = 42.0; // Fixed base seed for consistent flame shape
    const animationSpeed = 2.0 * Math.PI; // One full cycle over 64 frames
    const seed = baseSeed + timePhase * animationSpeed;

    const imgData = ctx.createImageData(cellSize, cellSize);
    const data = imgData.data;

    const cx = cellSize / 2;
    const cy = cellSize / 2;

    for (let py = 0; py < cellSize; py++) {
      for (let px = 0; px < cellSize; px++) {
        // Normalized coordinates centered on cell (-1 to 1)
        const nx = ((px - cx) / (cellSize * 0.5)) / widthScale;
        const ny = ((py - cy) / (cellSize * 0.5)) / heightScale;

        // Vertical position (0 = bottom, 1 = top of flame)
        // Flame grows upward, so invert Y
        const vPos = 1.0 - (ny + 1.0) * 0.5; // 0 at bottom, 1 at top

        let flameMask;
        let verticalMask;

        // All animation frames use the same tapered ellipse with noisy edge
        // The noise phase evolves with tileIndex to create animation

        // Base flame shape: ellipse that tapers toward the top
        // Width narrows as we go up based on taper parameter
        const taperFactor = 1.0 - taper * vPos;
        const effectiveWidth = Math.max(0.1, taperFactor);

        // Distance from center axis (horizontal)
        const hDist = Math.abs(nx) / effectiveWidth;

        // Add noise distortion to the edge - seed evolves with timePhase for animation
        const noiseX = px * noiseScale * 0.05;
        const noiseY = py * noiseScale * 0.05;
        const noise = this._flameNoise(noiseX, noiseY, seed) * noiseStrength;

        // Flame mask: 1.0 inside, 0.0 outside
        // Use smoothstep for soft edges
        const edgeThreshold = 0.8 + noise;
        const innerEdge = Math.max(0, edgeThreshold - edgeSoftness);
        flameMask = 1.0 - this._smoothstep(innerEdge, edgeThreshold, hDist);

        // Vertical falloff: fade out at top and bottom
        const topFade = 1.0 - this._smoothstep(0.7, 1.0, vPos);
        const bottomFade = this._smoothstep(0.0, 0.15, vPos);
        verticalMask = topFade * bottomFade;

        // Core brightness: hotter in the center
        const coreDist = Math.sqrt(nx * nx + (ny + 0.3) * (ny + 0.3)); // Core offset downward
        const coreIntensity = (1.0 - this._smoothstep(0, coreSize * 2, coreDist)) * coreBrightness;

        // Shape alpha before global/persprite opacity controls
        let shapeAlpha = flameMask * verticalMask;
        shapeAlpha = Math.max(0, Math.min(1, shapeAlpha));

        // Apply non-linear shaping and global alpha multipliers
        const shapedAlpha = Math.pow(shapeAlpha, alphaGamma);
        let alpha = shapedAlpha * atlasIntensity * atlasOpacity;
        alpha = Math.max(0, Math.min(1, alpha));

        // Color: white core fading to orange/red at edges
        // Use the underlying shape alpha to drive color temperature so opacity
        // controls do not desaturate or cool the flame, only its visibility.
        const temp = shapeAlpha * (0.5 + 0.5 * coreIntensity);
        const r = Math.min(1.0, 0.3 + temp * 0.7 + coreIntensity * 0.3);
        const g = Math.min(1.0, 0.1 + temp * 0.6 + coreIntensity * 0.4);
        const b = Math.min(1.0, temp * 0.2 + coreIntensity * 0.6);

        const idx = (py * cellSize + px) * 4;
        data[idx] = Math.floor(r * 255);
        data[idx + 1] = Math.floor(g * 255);
        data[idx + 2] = Math.floor(b * 255);
        data[idx + 3] = Math.floor(alpha * 255);
      }
    }

    ctx.putImageData(imgData, cellX * cellSize, cellY * cellSize);
  }

  /**
   * Smoothstep interpolation function.
   * @param {number} edge0 - Lower edge
   * @param {number} edge1 - Upper edge
   * @param {number} x - Input value
   * @returns {number} Smoothly interpolated value
   */
  _smoothstep(edge0, edge1, x) {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  /**
   * Regenerate the flame atlas texture when shape parameters change.
   * Call this after modifying any flame shape params.
   */
  regenerateFlameAtlas() {
    if (!this._flameAtlasCanvas || !this._flameAtlasCtx || !this.fireTexture) {
      return;
    }

    const ctx = this._flameAtlasCtx;
    const cellSize = this._flameAtlasCellSize;

    // Clear and redraw all tiles in the current atlas grid (8x8 animation frames by default)
    const grid = this._flameAtlasGrid || 8;
    ctx.clearRect(0, 0, this._flameAtlasCanvas.width, this._flameAtlasCanvas.height);
    for (let row = 0; row < grid; row++) {
      for (let col = 0; col < grid; col++) {
        this._drawFlameInCell(ctx, col, row, cellSize);
      }
    }

    // Mark texture for update
    this.fireTexture.needsUpdate = true;
    log.debug('Flame atlas regenerated');
  }

  _ensureEmberTexture() {
    const THREE = window.THREE;
    if (!THREE) return null;

    if (!this.emberTexture) {
      const texture = new THREE.TextureLoader().load('modules/map-shine-advanced/assets/particle.webp');
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = true;
      this.emberTexture = texture;
    }

    return this.emberTexture;
  }
  
  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        { name: 'fire-main', label: 'Fire - Main', type: 'inline', parameters: ['globalFireRate', 'fireHeight', 'fireTemperature'] },
        { name: 'fire-shape', label: 'Fire - Shape', type: 'inline', parameters: ['fireSizeMin', 'fireSizeMax', 'fireLifeMin', 'fireLifeMax'] },
        { name: 'fire-look', label: 'Fire - Look', type: 'inline', parameters: ['fireOpacityMin', 'fireOpacityMax', 'fireColorBoostMin', 'fireColorBoostMax', 'fireStartColor', 'fireEndColor'] },
        { name: 'fire-spin', label: 'Fire - Spin', type: 'inline', parameters: ['fireSpinEnabled', 'fireSpinSpeedMin', 'fireSpinSpeedMax'] },
        { name: 'fire-physics', label: 'Fire - Physics', type: 'inline', parameters: ['fireUpdraft', 'fireCurlStrength'] },
        // Flame Shape Atlas Controls (Global) - all 16 animation frames share these parameters
        {
          name: 'flame-atlas-global',
          label: 'Flame Atlas (Animation)',
          type: 'inline',
          parameters: ['flameAtlasIntensity', 'flameAtlasOpacity', 'flameAlphaGamma', 'flameNoiseScale', 'flameNoiseStrength', 'flameTaper', 'flameWidth', 'flameHeight', 'flameEdgeSoftness', 'flameCoreBrightness', 'flameCoreSize']
        },
        { name: 'embers-main', label: 'Embers - Main', type: 'inline', parameters: ['emberRate'] },
        { name: 'embers-shape', label: 'Embers - Shape', type: 'inline', parameters: ['emberSizeMin', 'emberSizeMax', 'emberLifeMin', 'emberLifeMax'] },
        { name: 'embers-look', label: 'Embers - Look', type: 'inline', parameters: ['emberOpacityMin', 'emberOpacityMax', 'emberColorBoostMin', 'emberColorBoostMax', 'emberStartColor', 'emberEndColor'] },
        { name: 'embers-physics', label: 'Embers - Physics', type: 'inline', parameters: ['emberUpdraft', 'emberCurlStrength'] },
        { name: 'env', label: 'Environment', type: 'inline', parameters: ['windInfluence', 'lightIntensity', 'timeScale', 'indoorLifeScale', 'weatherPrecipKill', 'weatherWindKill'] },
        { name: 'heat-distortion', label: 'Heat Distortion', type: 'inline', parameters: ['heatDistortionEnabled', 'heatDistortionIntensity', 'heatDistortionFrequency', 'heatDistortionSpeed'] }
      ],
      parameters: {
        enabled: { type: 'checkbox', label: 'Fire Enabled', default: true },
        // Tuned default from scene: Global Intensity
        globalFireRate: { type: 'slider', label: 'Global Intensity', min: 0.0, max: 20.0, step: 0.1, default: 4.0 },
        // Tuned default: low height for floor-level glyph fires
        fireHeight: { type: 'slider', label: 'Height', min: 1.0, max: 600.0, step: 1.0, default: 10.0 },

        // Temperature (0.0 = Arctic/Chilled, 1.0 = Blue Bunsen)
        fireTemperature: { type: 'slider', label: 'Temperature', min: 0.0, max: 1.0, step: 0.05, default: 0.5 },
        fireSizeMin: { type: 'slider', label: 'Size Min', min: 1.0, max: 150.0, step: 1.0, default: 60.0 },
        fireSizeMax: { type: 'slider', label: 'Size Max', min: 1.0, max: 200.0, step: 1.0, default: 95.0 },
        fireLifeMin: { type: 'slider', label: 'Life Min (s)', min: 0.1, max: 6.0, step: 0.05, default: 2.3 },
        fireLifeMax: { type: 'slider', label: 'Life Max (s)', min: 0.1, max: 6.0, step: 0.05, default: 2.55 },
        // Defaults from Mad Scientist scene
        fireOpacityMin: { type: 'slider', label: 'Opacity Min', min: 0.0, max: 1.0, step: 0.01, default: 0.12 },
        fireOpacityMax: { type: 'slider', label: 'Opacity Max', min: 0.0, max: 1.0, step: 0.01, default: 0.35 },
        fireColorBoostMin: { type: 'slider', label: 'Color Boost Min', min: 0.0, max: 4.0, step: 0.05, default: 0.0 },
        fireColorBoostMax: { type: 'slider', label: 'Color Boost Max', min: 0.0, max: 12.0, step: 0.05, default: 1.75 },
        fireStartColor: { type: 'color', default: { r: 1.0, g: 1.0, b: 1.0 } },
        fireEndColor: { type: 'color', default: { r: 0.8, g: 0.2, b: 0.05 } },
        fireSpinEnabled: { type: 'checkbox', label: 'Spin Enabled', default: true },
        fireSpinSpeedMin: { type: 'slider', label: 'Spin Speed Min (rad/s)', min: 0.0, max: 50.0, step: 0.1, default: 0.2 },
        fireSpinSpeedMax: { type: 'slider', label: 'Spin Speed Max (rad/s)', min: 0.0, max: 50.0, step: 0.1, default: 0.7 },

        // ========== FLAME SHAPE ATLAS CONTROLS ==========
        // Global flame shape parameters - all animation frames share these
        flameAtlasIntensity: { type: 'slider', label: 'Intensity', min: 0.0, max: 4.0, step: 0.01, default: 2.0 },
        flameAtlasOpacity: { type: 'slider', label: 'Opacity', min: 0.0, max: 1.0, step: 0.01, default: 0.46 },
        flameAlphaGamma: { type: 'slider', label: 'Alpha Gamma', min: 0.1, max: 4.0, step: 0.05, default: 1.0 },
        flameNoiseScale: { type: 'slider', label: 'Noise Scale', min: 0.5, max: 10.0, step: 0.1, default: 1.1 },
        flameNoiseStrength: { type: 'slider', label: 'Noise Strength', min: 0.0, max: 2.0, step: 0.01, default: 1.0 },
        flameTaper: { type: 'slider', label: 'Taper', min: 0.0, max: 1.0, step: 0.01, default: 0.0 },
        flameWidth: { type: 'slider', label: 'Width', min: 0.2, max: 3.0, step: 0.05, default: 0.5 },
        flameHeight: { type: 'slider', label: 'Height', min: 0.2, max: 3.0, step: 0.05, default: 0.5 },
        flameEdgeSoftness: { type: 'slider', label: 'Edge Softness', min: 0.0, max: 1.0, step: 0.01, default: 1.0 },
        flameCoreBrightness: { type: 'slider', label: 'Core Brightness', min: 0.0, max: 4.0, step: 0.05, default: 4.0 },
        flameCoreSize: { type: 'slider', label: 'Core Size', min: 0.01, max: 1.0, step: 0.01, default: 0.16 },

        emberRate: { type: 'slider', label: 'Ember Density', min: 0.0, max: 5.0, step: 0.1, default: 5.0 },
        emberSizeMin: { type: 'slider', label: 'Ember Size Min', min: 1.0, max: 40.0, step: 1.0, default: 13.0 },
        emberSizeMax: { type: 'slider', label: 'Ember Size Max', min: 1.0, max: 60.0, step: 1.0, default: 22.0 },
        emberLifeMin: { type: 'slider', label: 'Ember Life Min (s)', min: 0.1, max: 8.0, step: 0.1, default: 0.7 },
        emberLifeMax: { type: 'slider', label: 'Ember Life Max (s)', min: 0.1, max: 12.0, step: 0.1, default: 3.6 },
        emberOpacityMin: { type: 'slider', label: 'Ember Opacity Min', min: 0.0, max: 1.0, step: 0.01, default: 0.67 },
        emberOpacityMax: { type: 'slider', label: 'Ember Opacity Max', min: 0.0, max: 1.0, step: 0.01, default: 0.89 },
        emberColorBoostMin: { type: 'slider', label: 'Ember Color Boost Min', min: 0.0, max: 2.0, step: 0.05, default: 1.70 },
        emberColorBoostMax: { type: 'slider', label: 'Ember Color Boost Max', min: 0.0, max: 3.0, step: 0.05, default: 2.85 },
        emberStartColor: { type: 'color', default: { r: 1.0, g: 0.8, b: 0.4 } },
        emberEndColor: { type: 'color', default: { r: 1.0, g: 0.2, b: 0.0 } },
        fireUpdraft: { type: 'slider', label: 'Updraft', min: 0.0, max: 12.0, step: 0.05, default: 0.95 },
        emberUpdraft: { type: 'slider', label: 'Updraft', min: 0.0, max: 12.0, step: 0.05, default: 1.6 },
        fireCurlStrength: { type: 'slider', label: 'Curl Strength', min: 0.0, max: 12.0, step: 0.05, default: 0.7 },
        emberCurlStrength: { type: 'slider', label: 'Curl Strength', min: 0.0, max: 12.0, step: 0.05, default: 6.05 },
        // Wind Influence remains generic; Light Intensity and Time Scale match scene
        windInfluence: { type: 'slider', label: 'Wind Influence', min: 0.0, max: 5.0, step: 0.1, default: 5.0 },
        lightIntensity: { type: 'slider', label: 'Light Intensity', min: 0.0, max: 5.0, step: 0.1, default: 5.0 },
        timeScale: { type: 'slider', label: 'Time Scale', min: 0.1, max: 3.0, step: 0.05, default: 3.0 },

        // Indoor vs outdoor lifetime scaling (applied only when particles are fully indoors)
        indoorLifeScale: { type: 'slider', label: 'Indoor Life Scale', min: 0.05, max: 1.0, step: 0.05, default: 0.75 },

        // Weather guttering strength (spawn-time kill) for outdoor flames
        weatherPrecipKill: { type: 'slider', label: 'Rain Kill Strength', min: 0.0, max: 5.0, step: 0.05, default: 1.55 },
        weatherWindKill: { type: 'slider', label: 'Wind Kill Strength', min: 0.0, max: 5.0, step: 0.05, default: 1.15 },

        // Heat Distortion Controls
        heatDistortionEnabled: { type: 'checkbox', label: 'Enable Heat Haze', default: false },
        heatDistortionIntensity: { type: 'slider', label: 'Intensity', min: 0.0, max: 0.05, step: 0.001, default: 0.015 },
        heatDistortionFrequency: { type: 'slider', label: 'Frequency', min: 1.0, max: 20.0, step: 0.5, default: 8.0 },
        heatDistortionSpeed: { type: 'slider', label: 'Speed', min: 0.1, max: 3.0, step: 0.1, default: 1.0 }
      }
    };
  }
  
  initialize(renderer, scene, camera) {
    this.scene = scene;
    log.info('FireSparksEffect initialized (Quarks)');
  }
  
  setParticleSystem(ps) {
    this.particleSystemRef = ps;
    log.info('Connected to ParticleSystem');
  }
  
  /**
   * Set up fire sources from MapPointsManager (v1.x backwards compatibility)
   * Creates AGGREGATED fire particle systems from all map point locations.
   * 
   * PERFORMANCE FIX: Instead of creating one ParticleSystem per point (which
   * caused multi-second freezes on zoom-out with many fire sources), we now
   * aggregate all points into a single MultiPointEmitterShape and create
   * just 1-2 systems total (fire + embers).
   * 
   * @param {MapPointsManager} mapPointsManager - The map points manager instance
   */
  setMapPointsSources(mapPointsManager) {
    this._lastMapPointsManager = mapPointsManager || null;

    if (!mapPointsManager || !this.particleSystemRef?.batchRenderer) {
      return;
    }

    // Get all point groups targeting 'fire' or 'candleFlame'
    const fireGroups = mapPointsManager.getGroupsByEffect('fire');
    const candleGroups = mapPointsManager.getGroupsByEffect('candleFlame');
    
    const allGroups = [...fireGroups, ...candleGroups];
    
    if (allGroups.length === 0) {
      log.debug('No map point fire sources found');
      return;
    }

    // Aggregate all points into arrays for fire and candle separately
    const firePoints = [];   // Regular fire points
    const candlePoints = []; // Candle flame points (smaller, gentler)
    
    const d = canvas?.dimensions;
    const worldHeight = d?.height || 1000;

    for (const group of allGroups) {
      if (!group.points || group.points.length === 0) continue;
      
      const isCandle = group.effectTarget === 'candleFlame';
      const intensity = group.emission?.intensity ?? 1.0;
      const targetArray = isCandle ? candlePoints : firePoints;
      
      for (const point of group.points) {
        // Convert to world coordinates (Foundry Y is inverted)
        const worldX = point.x;
        const worldY = worldHeight - point.y;
        
        // Pack as [x, y, intensity]
        targetArray.push(worldX, worldY, intensity);
      }
    }

    const totalPoints = (firePoints.length + candlePoints.length) / 3;
    log.info(`Aggregating ${totalPoints} map points into combined fire systems`);

    // Create a single fire system for all regular fire points
    if (firePoints.length > 0) {
      const firePointsArray = new Float32Array(firePoints);
      const fireShape = new MultiPointEmitterShape(firePointsArray, this);
      const pointCount = firePoints.length / 3;
      
      // Scale emission rate by number of points
      const baseRate = this.params.globalFireRate ?? 4.0;
      const rate = new IntervalValue(
        baseRate * pointCount * 0.5,
        baseRate * pointCount * 1.0
      );
      
      const fireSystem = this._createFireSystem({
        shape: fireShape,
        rate,
        size: this.params.fireSize,
        height: this.params.fireHeight
      });
      
      this.particleSystemRef.batchRenderer.addSystem(fireSystem);
      this.scene.add(fireSystem.emitter);
      
      // Track as a single aggregated fire source
      this.fires.push({
        id: 'mappoints_fire_aggregated',
        system: fireSystem,
        position: { x: 0, y: 0 }, // Centroid not meaningful for aggregated
        isCandle: false,
        pointCount
      });
      
      // Create matching ember system
      const emberRate = new IntervalValue(
        (this.params.emberRate ?? 5.0) * pointCount * 0.3,
        (this.params.emberRate ?? 5.0) * pointCount * 0.6
      );
      
      const emberSystem = this._createEmberSystem({
        shape: fireShape, // Reuse same shape
        rate: emberRate,
        height: this.params.fireHeight
      });
      
      this.particleSystemRef.batchRenderer.addSystem(emberSystem);
      this.scene.add(emberSystem.emitter);
      
      // Track the aggregated ember system as well so it is fully torn down
      // when the Fire effect is disabled from the UI.
      this.fires.push({
        id: 'mappoints_fire_embers_aggregated',
        system: emberSystem,
        position: { x: 0, y: 0 },
        isCandle: false,
        pointCount,
        isEmber: true
      });

      log.info(`Created aggregated fire + ember systems for ${pointCount} fire points`);
    }

    // Create a single candle system for all candle points
    if (candlePoints.length > 0) {
      const candlePointsArray = new Float32Array(candlePoints);
      const candleShape = new MultiPointEmitterShape(candlePointsArray, this);
      const pointCount = candlePoints.length / 3;
      
      // Candles are smaller and gentler
      const scale = 0.3;
      const baseRate = this.params.globalFireRate ?? 4.0;
      const rate = new IntervalValue(
        baseRate * pointCount * 0.3 * scale,
        baseRate * pointCount * 0.6 * scale
      );
      
      const candleSystem = this._createFireSystem({
        shape: candleShape,
        rate,
        size: this.params.fireSize * scale,
        height: this.params.fireHeight * scale
      });
      
      this.particleSystemRef.batchRenderer.addSystem(candleSystem);
      this.scene.add(candleSystem.emitter);
      
      this.fires.push({
        id: 'mappoints_candle_aggregated',
        system: candleSystem,
        position: { x: 0, y: 0 },
        isCandle: true,
        pointCount
      });
      
      log.info(`Created aggregated candle system for ${pointCount} candle points`);
    }
  }

  setAssetBundle(bundle) {
    this._lastAssetBundle = bundle || null;
    if (!bundle || !bundle.masks) {
      log.info('FireSparksEffect: No bundle or masks provided');
      return;
    }
    // The asset loader (assets/loader.js) exposes any `<Base>_Fire.*` image
    // as a mask entry with `type: 'fire'`. We treat that as an author-painted
    // spawn mask for global fire: bright pixels mark where fire should exist.
    const fireMask = bundle.masks.find(m => m.type === 'fire');
    log.info('FireSparksEffect: Looking for fire mask', { 
      foundMask: !!fireMask, 
      hasParticleSystem: !!this.particleSystemRef,
      hasBatchRenderer: !!this.particleSystemRef?.batchRenderer,
      hasScene: !!this.scene,
      maskTypes: bundle.masks.map(m => m.type)
    });
    if (fireMask && this.particleSystemRef && this.particleSystemRef.batchRenderer) {
      try {
        const d = canvas.dimensions;
        const baseTex = bundle.baseTexture;
        log.info('Fire debug: base vs fire vs dims', {
          baseW: baseTex?.image?.width,
          baseH: baseTex?.image?.height,
          fireW: fireMask.texture?.image?.width,
          fireH: fireMask.texture?.image?.height,
          dims: {
            width: d?.width,
            height: d?.height,
            sceneWidth: d?.sceneWidth,
            sceneHeight: d?.sceneHeight,
            sceneX: d?.sceneX,
            sceneY: d?.sceneY,
            padding: d?.padding
          }
        });
      } catch (e) {
        log.warn('Fire debug logging failed', e);
      }
      // 1. Convert the `_Fire` bitmap into a compact list of UVs. This is a
      //    one-time CPU pass that builds a static lookup table; all per-frame
      //    spawning is then O(1) by randomly indexing into this array.
      const points = this._generatePoints(fireMask.texture);
      if (!points) return;
      const d = canvas.dimensions;
      // 2. Map mask UVs across the **scene rectangle**. The `_Fire` mask is
      //    authored 1:1 with the base battlemap albedo and is intended to
      //    cover only the playable scene area, not the padded world.
      //    This mirrors the world volume used by WeatherParticles and the
      //    base plane geometry in SceneComposer.
      const width = d.sceneWidth || d.width;
      const height = d.sceneHeight || d.height;
      const sx = d.sceneX || 0;
      // Invert Y so that mask v=0 is the **visual top** of the scene and
      // v=1 is the bottom, matching the base plane and token/tile transforms.
      const sy = (d.height || height) - (d.sceneY || 0) - height;
      const shape = new FireMaskShape(points, width, height, sx, sy, this);
      this.globalSystem = this._createFireSystem({
        shape: shape,
        rate: new IntervalValue(10.0, 20.0), 
        size: this.params.fireSize,
        height: this.params.fireHeight
      });
      this.particleSystemRef.batchRenderer.addSystem(this.globalSystem);

      this.globalEmbers = this._createEmberSystem({
        shape: shape,
        rate: new IntervalValue(5.0 * this.params.emberRate, 10.0 * this.params.emberRate),
        height: this.params.fireHeight
      });
      this.particleSystemRef.batchRenderer.addSystem(this.globalEmbers);

      this.scene.add(this.globalSystem.emitter);
      this.scene.add(this.globalEmbers.emitter);
      log.info('Created Global Fire System from mask (' + (points.length/3) + ' points)');

      // Register heat distortion with DistortionManager if available
      this._registerHeatDistortion(fireMask.texture);
    }
  }

  /**
   * Register heat distortion source with the centralized DistortionManager.
   * Creates a boosted/blurred version of the _Fire mask for a wider heat haze area.
   * @param {THREE.Texture} fireMaskTexture - The _Fire mask texture
   * @private
   */
  _registerHeatDistortion(fireMaskTexture) {
    const distortionManager = window.MapShine?.distortionManager;
    if (!distortionManager) {
      log.debug('DistortionManager not available, skipping heat distortion registration');
      return;
    }

    if (!fireMaskTexture || !fireMaskTexture.image) {
      log.debug('No valid fire mask texture for heat distortion');
      return;
    }

    const THREE = window.THREE;
    
    // Create a boosted version of the fire mask for heat distortion
    // This expands the effective area beyond the actual fire pixels
    const boostedMask = this._createBoostedHeatMask(fireMaskTexture);
    if (!boostedMask) return;

    // Store reference for cleanup
    this._heatDistortionMask = boostedMask;

    // Register with DistortionManager (DistortionLayer imported at top of file)
    distortionManager.registerSource('heat', DistortionLayer.ABOVE_GROUND, boostedMask, {
      intensity: this.params.heatDistortionIntensity,
      frequency: this.params.heatDistortionFrequency,
      speed: this.params.heatDistortionSpeed,
      blurRadius: this.params.heatDistortionBlurRadius,
      blurPasses: this.params.heatDistortionBlurPasses
    });

    // Set initial enabled state
    distortionManager.setSourceEnabled('heat', this.params.heatDistortionEnabled);

    log.info('Heat distortion registered with DistortionManager');
  }

  /**
   * Create a boosted/expanded version of the fire mask for heat distortion.
   * The boost increases brightness so that after blur, the heat area extends
   * well beyond the visible flames.
   * @param {THREE.Texture} fireMaskTexture - Original _Fire mask
   * @returns {THREE.Texture|null} Boosted mask texture
   * @private
   */
  _createBoostedHeatMask(fireMaskTexture) {
    const THREE = window.THREE;
    const image = fireMaskTexture.image;
    if (!image) return null;

    // Create a canvas to process the mask
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    
    // Draw original mask
    ctx.drawImage(image, 0, 0);
    
    // Get pixel data and boost brightness
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    const boost = this.params.heatDistortionBoost || 2.0;
    
    for (let i = 0; i < data.length; i += 4) {
      // Boost and clamp to 255
      data[i] = Math.min(255, data[i] * boost);     // R
      data[i + 1] = Math.min(255, data[i + 1] * boost); // G
      data[i + 2] = Math.min(255, data[i + 2] * boost); // B
      // Alpha stays the same
    }
    
    ctx.putImageData(imageData, 0, 0);
    
    // Apply a simple box blur to expand the mask (CPU-side preprocessing)
    // This complements the GPU blur in DistortionManager
    this._applyBoxBlur(ctx, canvas.width, canvas.height, 3);
    
    // Create THREE texture from processed canvas
    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    
    return texture;
  }

  /**
   * Apply a simple box blur to a canvas context
   * @param {CanvasRenderingContext2D} ctx - Canvas context
   * @param {number} width - Canvas width
   * @param {number} height - Canvas height
   * @param {number} radius - Blur radius in pixels
   * @private
   */
  _applyBoxBlur(ctx, width, height, radius) {
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    const temp = new Uint8ClampedArray(data.length);
    
    // Horizontal pass
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = 0, g = 0, b = 0, a = 0, count = 0;
        
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = Math.max(0, Math.min(width - 1, x + dx));
          const idx = (y * width + nx) * 4;
          r += data[idx];
          g += data[idx + 1];
          b += data[idx + 2];
          a += data[idx + 3];
          count++;
        }
        
        const outIdx = (y * width + x) * 4;
        temp[outIdx] = r / count;
        temp[outIdx + 1] = g / count;
        temp[outIdx + 2] = b / count;
        temp[outIdx + 3] = a / count;
      }
    }
    
    // Vertical pass
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = 0, g = 0, b = 0, a = 0, count = 0;
        
        for (let dy = -radius; dy <= radius; dy++) {
          const ny = Math.max(0, Math.min(height - 1, y + dy));
          const idx = (ny * width + x) * 4;
          r += temp[idx];
          g += temp[idx + 1];
          b += temp[idx + 2];
          a += temp[idx + 3];
          count++;
        }
        
        const outIdx = (y * width + x) * 4;
        data[outIdx] = r / count;
        data[outIdx + 1] = g / count;
        data[outIdx + 2] = b / count;
        data[outIdx + 3] = a / count;
      }
    }
    
    ctx.putImageData(imageData, 0, 0);
  }
  
  _generatePoints(maskTexture, threshold = 0.1) {
    const image = maskTexture.image;
    if (!image) {
      log.warn('FireSparksEffect: No image in mask texture');
      return null;
    }
    const c = document.createElement('canvas');
    c.width = image.width;
    c.height = image.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    const coords = [];
    for (let i = 0; i < data.length; i += 4) {
        const b = data[i] / 255.0;
        if (b > threshold) {
            const idx = i / 4;
            const x = (idx % c.width) / c.width;
            const y = Math.floor(idx / c.width) / c.height;
            coords.push(x, y, b);
        }
    }
    if (coords.length === 0) {
      log.warn('FireSparksEffect: No fire points found in mask (all pixels below threshold)');
      return null;
    }
    log.info(`FireSparksEffect: Generated ${coords.length / 3} fire spawn points from mask`);
    return new Float32Array(coords);
  }
  
  _createFireSystem(opts) {
    const { shape, rate, size, height } = opts;
    const THREE = window.THREE;
    
    const material = new THREE.MeshBasicMaterial({
      // Use the procedural flame atlas as the particle texture. This mirrors
      // WeatherParticles' splash atlas usage and ensures point sprites sample
      // our 2x2 flame tiles instead of a legacy generic sprite.
      map: this.fireTexture,
      transparent: true,
      depthWrite: false, // Essential for fire to not occlude itself
      depthTest: true,   // Allow it to sit behind tokens/walls
      blending: THREE.AdditiveBlending,
      color: 0xffffff,
      side: THREE.DoubleSide
    });

    const colorOverLife = new ColorOverLife(
        new ColorRange(
            new Vector4(1.2, 1.0, 0.6, 0.2),
            new Vector4(0.8, 0.2, 0.05, 0.0)
        )
    );

    const sizeOverLife = new SizeOverLife(
        new PiecewiseBezier([
            [new Bezier(0.5, 1.2, 1.0, 0.0), 0]
        ])
    );
    
    // Vertical Lift: base magnitude was tuned before the camera change and is now ~20x too strong.
    // Scale it down so that with fireUpdraft ~= 2.25 the apparent rise speed matches the old look.
    const buoyancy = new ApplyForce(new THREE.Vector3(0, 0, 1), new ConstantValue(height * 0.125));
    
    // Replaced standard ApplyForce with SmartWindBehavior for indoor/outdoor masking
    const windForce = new SmartWindBehavior();
    
    // Increased turbulence to break up uniform sprite look
    const fireCurlScale = new THREE.Vector3(150, 150, 50);
    const fireCurlStrengthBase = new THREE.Vector3(80, 80, 30);
    const turbulence = new CurlNoiseField(
        fireCurlScale,
        fireCurlStrengthBase.clone(),
        1.5
    );

    const p = this.params;
    const timeScale = Math.max(0.1, p.timeScale ?? 1.0);

    const baseLifeMin = p.fireLifeMin ?? 0.6;
    const baseLifeMax = p.fireLifeMax ?? 1.2;
    const lifeMin = Math.max(0.01, baseLifeMin / timeScale);
    const lifeMax = Math.max(lifeMin, baseLifeMax / timeScale);
    const sizeMin = Math.max(0.1, p.fireSizeMin ?? (size * 0.8));
    const sizeMax = Math.max(sizeMin, p.fireSizeMax ?? (size * 1.5));

    const opacityMin = Math.max(0.0, Math.min(1.0, p.fireOpacityMin ?? 0.3));
    const opacityMax = Math.max(opacityMin, Math.min(1.0, p.fireOpacityMax ?? 1.0));

    const colorBoostMin = p.fireColorBoostMin ?? 0.8;
    const colorBoostMax = Math.max(colorBoostMin, p.fireColorBoostMax ?? 1.2);

    const fireStart = p.fireStartColor || { r: 1.2, g: 1.0, b: 0.6 };
    const fireEnd = p.fireEndColor || { r: 0.8, g: 0.2, b: 0.05 };

    const system = new ParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(lifeMin, lifeMax),
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(sizeMin, sizeMax),
      startColor: new ColorRange(
        new Vector4(
          fireStart.r * colorBoostMin,
          fireStart.g * colorBoostMin,
          fireStart.b * colorBoostMin,
          opacityMin
        ),
        new Vector4(
          fireEnd.r * colorBoostMax,
          fireEnd.g * colorBoostMax,
          fireEnd.b * colorBoostMax,
          opacityMax
        )
      ),
      worldSpace: true,
      maxParticles: 10000,
      emissionOverTime: rate,
      shape: shape,
      material: material,
      renderMode: RenderMode.BillBoard,
      renderOrder: 50,
      // 4x4 flame atlas: 16 animation frames
      uTileCount: 8,
      vTileCount: 8,
      // Start at frame 0 - FrameOverLife will animate through all 16 frames
      startTileIndex: new ConstantValue(0),
      startRotation: new IntervalValue(0, Math.PI * 2),
      behaviors: [
          colorOverLife,
          sizeOverLife,
          buoyancy,
          windForce,
          turbulence,
          new FireSpinBehavior(),
          
          // CHANGE: Animate from frame 0 to 63 over the particle's life.
          // Using Bezier control points (0, 21, 42, 63) for linear interpolation.
          new FrameOverLife(new PiecewiseBezier([[new Bezier(0, 21, 42, 63), 0]]))
      ]
    });
    
    // Patch the material to support roof/outdoors masking
    this._patchRoofMaskMaterial(material);

    system.userData = {
      windForce,
      ownerEffect: this,
      updraftForce: buoyancy,
      baseUpdraftMag: height * 2.5,
      turbulence,
      baseCurlStrength: fireCurlStrengthBase.clone()
    };
    
    return system;
  }

  _createEmberSystem(opts) {
    const { shape, rate, height } = opts;
    const THREE = window.THREE;

    const material = new THREE.MeshBasicMaterial({
      map: this._ensureEmberTexture(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      color: 0xffaa00,
      depthWrite: false,
      depthTest: true
    });

    const p = this.params;
    const timeScale = Math.max(0.1, p.timeScale ?? 1.0);

    const baseLifeMin = p.emberLifeMin ?? 1.5;
    const baseLifeMax = p.emberLifeMax ?? 3.0;
    const lifeMin = Math.max(0.01, baseLifeMin / timeScale);
    const lifeMax = Math.max(lifeMin, baseLifeMax / timeScale);
    const sizeMin = Math.max(0.1, p.emberSizeMin ?? 4.0);
    const sizeMax = Math.max(sizeMin, p.emberSizeMax ?? 10.0);

    const opacityMin = Math.max(0.0, Math.min(1.0, p.emberOpacityMin ?? 0.4));
    const opacityMax = Math.max(opacityMin, Math.min(1.0, p.emberOpacityMax ?? 1.0));

    const colorBoostMin = p.emberColorBoostMin ?? 0.9;
    const colorBoostMax = Math.max(colorBoostMin, p.emberColorBoostMax ?? 1.5);

    const emberStart = p.emberStartColor || { r: 1.0, g: 0.8, b: 0.4 };
    const emberEnd = p.emberEndColor || { r: 1.0, g: 0.2, b: 0.0 };

    const emberCurlScale = new THREE.Vector3(30, 30, 30);
    const emberCurlStrengthBase = new THREE.Vector3(150, 150, 50);

    const system = new ParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(lifeMin, lifeMax),
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(sizeMin, sizeMax),
      startColor: new ColorRange(
        new Vector4(
          emberStart.r * colorBoostMin,
          emberStart.g * colorBoostMin,
          emberStart.b * colorBoostMin,
          opacityMin
        ),
        new Vector4(
          emberEnd.r * colorBoostMax,
          emberEnd.g * colorBoostMax,
          emberEnd.b * colorBoostMax,
          opacityMax
        )
      ),
      worldSpace: true,
      maxParticles: 2000,
      emissionOverTime: rate,
      shape: shape,
      material: material,
      renderMode: RenderMode.BillBoard,
      renderOrder: 51,
      behaviors: [
        // Updraft: likewise reduce the base magnitude so emberUpdraft stays in a sensible range
        // after the camera height/scale change.
        new ApplyForce(new THREE.Vector3(0, 0, 1), new ConstantValue(height * 0.4)),
        new SmartWindBehavior(),
        new CurlNoiseField(
          emberCurlScale,
          emberCurlStrengthBase.clone(),
          4.0
        ),
        new SizeOverLife(new PiecewiseBezier([[new Bezier(1, 0.9, 0.5, 0), 0]]))
      ]
    });

    // Patch the material to support roof/outdoors masking
    this._patchRoofMaskMaterial(material);

    system.userData = {
      windForce: system.behaviors.find(b => b instanceof SmartWindBehavior),
      updraftForce: system.behaviors.find(b => b instanceof ApplyForce && b.direction.z === 1),
      baseUpdraftMag: height * 0.4,
      turbulence: system.behaviors.find(b => b instanceof CurlNoiseField),
      baseCurlStrength: emberCurlStrengthBase.clone(),
      isEmber: true,
      ownerEffect: this
    };

    return system;
  }
  
  /**
   * Patch a MeshBasicMaterial to support sampling the roof/_Outdoors mask.
   *
   * PREFERRED PATTERN (for all future quarks-based particle systems that need
   * roof/indoor awareness):
   * - Keep simulation stateless / GPU-driven (three.quarks).
   * - Use WeatherController.roofMap (_Outdoors) as a shared indoor/outdoor mask.
   * - Project world-space XY into scene-rect UVs (uSceneBounds) and sample
   *   that mask in the fragment shader.
   * - Drive a simple 0/1 uniform from JS to decide when the mask is active
   *   (e.g. for Fire we enable occlusion when roofs are solid; WeatherParticles
   *   enables masking while roofs are hover-hidden).
   * - Always patch BOTH the source MeshBasicMaterial and the SpriteBatch
   *   ShaderMaterial created by three.quarks' BatchedRenderer, then update
   *   uniforms every frame from the owning effect.
   *
   * This mirrors WeatherParticles.js and should be treated as the canonical
   * approach for integrating new particle effects with roof/overhead tiles.
   */
  _patchRoofMaskMaterial(material) {
    const THREE = window.THREE;
    if (!material || !THREE) return;

    if (material.userData && material.userData.roofUniforms) return;

    const uniforms = {
      uRoofMap: { value: null },
      // Screen-space roof alpha map from LightingEffect's Roof Alpha Pass.
      // PREFERRED PATTERN (matching LightingEffect):
      // - uRoofMap + uSceneBounds classify pixels or emitters as indoor vs
      //   outdoor using the shared _Outdoors mask.
      // - uRoofAlphaMap provides the actual per-pixel opacity of overhead
      //   tiles in screen space (Layer 20 pre-pass).
      // - Particles only consult uRoofAlphaMap when the _Outdoors sample says
      //   "indoors", so transparent roof cutouts and semi-transparent tiles
      //   can still leak fire/embers visually.
      uRoofAlphaMap: { value: null },
      // Renderer resolution in *drawing buffer* pixels so we can derive
      // screen UVs from gl_FragCoord.xy when sampling the roof alpha texture.
      // IMPORTANT: gl_FragCoord is in physical pixels; using logical canvas
      // size here would break on High-DPR displays (UVs > 1.0).
      uResolution: { value: new THREE.Vector2(1, 1) },
      uSceneBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
      uRoofMaskEnabled: { value: 0.0 }
    };

    material.userData = material.userData || {};
    material.userData.roofUniforms = uniforms;

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uRoofMap = uniforms.uRoofMap;
      shader.uniforms.uRoofAlphaMap = uniforms.uRoofAlphaMap;
      shader.uniforms.uResolution = uniforms.uResolution;
      shader.uniforms.uSceneBounds = uniforms.uSceneBounds;
      shader.uniforms.uRoofMaskEnabled = uniforms.uRoofMaskEnabled;

      shader.vertexShader = shader.vertexShader
        .replace(
          'void main() {',
          'varying vec3 vRoofWorldPos;\nvoid main() {'
        )
        .replace(
          '#include <soft_vertex>',
          '#include <soft_vertex>\n  vRoofWorldPos = (modelMatrix * vec4(offset, 1.0)).xyz;'
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          'void main() {',
          'varying vec3 vRoofWorldPos;\nuniform sampler2D uRoofMap;\nuniform sampler2D uRoofAlphaMap;\nuniform vec2 uResolution;\nuniform vec4 uSceneBounds;\nuniform float uRoofMaskEnabled;\nvoid main() {'
        )
        .replace(
          '#include <soft_fragment>',
          '  if (uRoofMaskEnabled > 0.5) {\n' +
          '    vec2 uvMask = vec2(\n' +
          '      (vRoofWorldPos.x - uSceneBounds.x) / uSceneBounds.z,\n' +
          '      1.0 - (vRoofWorldPos.y - uSceneBounds.y) / uSceneBounds.w\n' +
          '    );\n' +
          '    if (uvMask.x >= 0.0 && uvMask.x <= 1.0 && uvMask.y >= 0.0 && uvMask.y <= 1.0) {\n' +
          '      float m = texture2D(uRoofMap, uvMask).r;\n' +
          '      // Dark (Indoors) pixels become subject to roof alpha occlusion when mask is active\n' +
          '      if (m < 0.5) {\n' +
          '        // Sample actual roof opacity from the LightingEffect Roof Alpha Pass.\n' +
          '        // This uses screen-space UVs so semi-transparent roofs only partially\n' +
          '        // attenuate fire, matching the lighting occlusion behavior.\n' +
          '        vec2 screenUV = gl_FragCoord.xy / uResolution;\n' +
          '        float roofAlpha = texture2D(uRoofAlphaMap, screenUV).a;\n' +
          '        // 1.0 roofAlpha  -> fully occluded (no fire visible)\n' +
          '        // 0.5 roofAlpha  -> half visible (semi-transparent roof)\n' +
          '        // 0.0 roofAlpha  -> fully visible (no roof / hidden)\n' +
          '        gl_FragColor.a *= (1.0 - roofAlpha);\n' +
          '      }\n' +
          '    }\n' +
          '  }\n' +
          '#include <soft_fragment>'
        );
    };
    
    material.needsUpdate = true;
  }

  createFire(x, y, radius = 50, height = 1.0, intensity = 1.0) {
     if (!this.particleSystemRef || !this.particleSystemRef.batchRenderer) return null;
     
     // Get ground plane Z from SceneComposer for proper alignment
     const sceneComposer = window.MapShine?.sceneComposer;
     const groundZ = (sceneComposer && typeof sceneComposer.groundZ === 'number')
       ? sceneComposer.groundZ
       : 1000;
     
     const system = this._createFireSystem({
        shape: new PointEmitter(),
        rate: new IntervalValue(intensity * 15, intensity * 25),
        size: radius * 0.8,
        height: height * 50.0
     });
     // Position emitter at ground plane level
     system.emitter.position.set(x, y, groundZ);
     this.particleSystemRef.batchRenderer.addSystem(system);
     // Position light slightly above ground plane for proper illumination
     const light = new window.THREE.PointLight(0xff6600, 1.0, radius * 8.0);
     light.position.set(x, y, groundZ + 50);
     this.scene.add(light);
     const id = crypto.randomUUID();
     this.fires.push({ id, system, light });
     return id;
  }
  
  removeFire(id) {
      const idx = this.fires.findIndex(f => f.id === id);
      if (idx !== -1) {
          const { system, light } = this.fires[idx];
          if (this.particleSystemRef?.batchRenderer) {
              this.particleSystemRef.batchRenderer.deleteSystem(system);
          }
          this.scene.remove(light);
          light.dispose();
          this.fires.splice(idx, 1);
      }
  }
  
  applyParamChange(paramId, value) {
    if (this.params && Object.prototype.hasOwnProperty.call(this.params, paramId)) {
      this.params[paramId] = value;
    }
    if (paramId === 'enabled' || paramId === 'masterEnabled') {
      this.settings.enabled = value;
      if (this.params) {
        this.params.enabled = value;
      }
      // When disabled from UI, completely tear down fire systems so we can
      // profile hitching without any Quarks fire overhead. When re-enabled,
      // lazily rebuild from the last known asset bundle and map-points
      // sources if available.
      if (!value) {
        this._destroyParticleSystems();
      } else {
        this._rebuildParticleSystemsIfNeeded();
      }
    }

    // Regenerate flame atlas when any flame shape parameter changes
    if (paramId.startsWith('flame') || paramId.startsWith('flame1') || 
        paramId.startsWith('flame2') || paramId.startsWith('flame3') || 
        paramId.startsWith('flame4')) {
      // Debounce regeneration to avoid excessive redraws during slider drags
      if (this._flameAtlasRegenerateTimeout) {
        clearTimeout(this._flameAtlasRegenerateTimeout);
      }
      this._flameAtlasRegenerateTimeout = setTimeout(() => {
        this.regenerateFlameAtlas();
        this._flameAtlasRegenerateTimeout = null;
      }, 50);
      }
  }

  update(timeInfo) {
    if (!this.settings.enabled) return;

    const t = timeInfo.elapsed;
    const THREE = window.THREE;
    const p = this.params;

    // --- TEMPERATURE LOGIC START ---
    // 0.0 = Chilled (Red/Deep Orange/Smoky), 0.5 = Standard, 1.0 = Bunsen (Blue/White)
    const temp = (typeof p.fireTemperature === 'number') ? p.fireTemperature : 0.5;

    // 1. Calculate Temperature Modifier for Physics (Range: 0.75 to 1.25)
    // Low Temp = Slower, sluggish (0.75x)
    // High Temp = Faster, energetic (1.25x)
    const tempPhysMod = 0.75 + (temp * 0.5);

    // 2. Calculate Color Targets
    // We define 3 palettes and lerp between them based on 'temp' slider
    const lerpRGB = (c1, c2, f) => ({
      r: c1.r + (c2.r - c1.r) * f,
      g: c1.g + (c2.g - c1.g) * f,
      b: c1.b + (c2.b - c1.b) * f
    });

    // Palette Definitions
    // Cold: Deep reds, struggling flame
    const coldStart = { r: 0.8, g: 0.3, b: 0.1 };
    const coldEnd   = { r: 0.2, g: 0.0, b: 0.0 };

    // Standard: The user's specific inputs from params (Orange/Yellow default)
    const stdStart  = p.fireStartColor || { r: 1.0, g: 1.0, b: 1.0 };
    const stdEnd    = p.fireEndColor || { r: 0.8, g: 0.2, b: 0.05 };

    // Hot: Bunsen Blue/White
    const hotStart  = { r: 0.2, g: 0.6, b: 1.0 }; // Bright Cyan/Blue core
    const hotEnd    = { r: 0.0, g: 0.1, b: 0.8 }; // Deep Blue edges

    let targetFireStart, targetFireEnd;

    if (temp <= 0.5) {
      // Lerp Cold -> Standard
      const f = temp * 2.0; // 0..1
      targetFireStart = lerpRGB(coldStart, stdStart, f);
      targetFireEnd   = lerpRGB(coldEnd, stdEnd, f);
    } else {
      // Lerp Standard -> Hot
      const f = (temp - 0.5) * 2.0; // 0..1
      targetFireStart = lerpRGB(stdStart, hotStart, f);
      targetFireEnd   = lerpRGB(stdEnd, hotEnd, f);
    }
    // --- TEMPERATURE LOGIC END ---

    // 1. Animate Lights (Flicker)
    const baseLightIntensity = (p && typeof p.lightIntensity === 'number')
      ? p.lightIntensity
      : (this.settings.lightIntensity || 1.0);

    const flicker =
      Math.sin(t * 10.0) * 0.1 +
      Math.sin(t * 22.0) * 0.1 +
      Math.sin(t * 43.0) * 0.1;

    for (const f of this.fires) {
      const phase = f.id ? f.id.charCodeAt(0) : 0;
      const phaseFlicker = flicker + Math.sin(t * 17.0 + phase * 0.01) * 0.05;
      if (f.light) {
        f.light.intensity = baseLightIntensity * (1.0 + phaseFlicker);
      }
    }

    // 2. Update Global Fire Rate
    // Scale by timeScale AND Temperature (Hotter = slightly faster burn)
    const timeScale = Math.max(0.1, p?.timeScale ?? 1.0);
    const effectiveTimeScale = timeScale * (0.8 + 0.4 * temp);

    if (this.globalSystem) {
      const baseRate = 200.0 * p.globalFireRate * effectiveTimeScale;
      const emission = this.globalSystem.emissionOverTime;
      if (emission && typeof emission.a === 'number') {
        emission.a = baseRate * 0.8;
        emission.b = baseRate * 1.2;
      }
    }

    // 3. Environment & Bounds Logic
    const influence = (p && typeof p.windInfluence === 'number')
      ? p.windInfluence
      : (this.settings.windInfluence || 1.0);
    const windSpeed = weatherController.currentState?.windSpeed || 0;
    const roofTex = weatherController.roofMap || null;
    const roofMaskEnabled = !!roofTex && !weatherController.roofMaskActive;

    let roofAlphaTex = null;
    const lighting = window.MapShine?.lightingEffect;
    if (lighting && lighting.roofAlphaTarget) {
      roofAlphaTex = lighting.roofAlphaTarget.texture;
    }

    const renderer = window.MapShine?.renderer || window.canvas?.app?.renderer;
    let resX = 1, resY = 1;
    if (renderer && THREE) {
      if (!this._tempVec2) this._tempVec2 = new THREE.Vector2();
      const size = this._tempVec2;
      if (typeof renderer.getDrawingBufferSize === 'function') {
        renderer.getDrawingBufferSize(size);
      } else if (typeof renderer.getSize === 'function') {
        renderer.getSize(size);
        const dpr = typeof renderer.getPixelRatio === 'function' ? renderer.getPixelRatio() : (window.devicePixelRatio || 1);
        size.multiplyScalar(dpr);
      }
      resX = size.x || 1;
      resY = size.y || 1;
    }

    const d = typeof canvas !== 'undefined' ? canvas?.dimensions : null;
    if (d && window.THREE) {
      if (!this._sceneBounds) this._sceneBounds = new window.THREE.Vector4();
      const sw = d.sceneWidth || d.width;
      const sh = d.sceneHeight || d.height;
      const sx = d.sceneX || 0;
      const sy = (d.height || sh) - (d.sceneY || 0) - sh;
      this._sceneBounds.set(sx, sy, sw, sh);
    }

    // Collect systems
    const systems = [];
    if (this.globalSystem) systems.push(this.globalSystem);
    if (this.globalEmbers) systems.push(this.globalEmbers);
    for (const f of this.fires) {
      if (f && f.system) systems.push(f.system);
    }

    const p2 = this.params;
    const clamp01 = x => Math.max(0.0, Math.min(1.0, x));

    for (const sys of systems) {
      if (!sys) continue;

      // Update Uniforms (roof / occlusion)
      if (sys.material && sys.material.userData && sys.material.userData.roofUniforms) {
        const u = sys.material.userData.roofUniforms;
        u.uRoofMaskEnabled.value = roofMaskEnabled ? 1.0 : 0.0;
        u.uRoofMap.value = roofTex;
        u.uRoofAlphaMap.value = roofAlphaTex;
        u.uResolution.value.set(resX, resY);
        if (this._sceneBounds) u.uSceneBounds.value.copy(this._sceneBounds);
      }
      if (this.particleSystemRef && this.particleSystemRef.batchRenderer) {
        const renderer = this.particleSystemRef.batchRenderer;
        const batchIdx = renderer.systemToBatchIndex ? renderer.systemToBatchIndex.get(sys) : undefined;
        if (batchIdx !== undefined && renderer.batches && renderer.batches[batchIdx]) {
          const batchMat = renderer.batches[batchIdx].material;
          if (batchMat) {
            if (!batchMat.userData || !batchMat.userData.roofUniforms) this._patchRoofMaskMaterial(batchMat);
            if (batchMat.userData && batchMat.userData.roofUniforms) {
              const u = batchMat.userData.roofUniforms;
              u.uRoofMaskEnabled.value = roofMaskEnabled ? 1.0 : 0.0;
              u.uRoofMap.value = roofTex;
              u.uRoofAlphaMap.value = roofAlphaTex;
              u.uResolution.value.set(resX, resY);
              if (this._sceneBounds) u.uSceneBounds.value.copy(this._sceneBounds);
            }
          }
        }
      }

      const isEmber = !!(sys.userData && sys.userData.isEmber);

      // Wind Influence
      if (sys.userData) {
        const multiplier = isEmber ? 1.5 : 1.0;
        sys.userData.windInfluence = influence * multiplier;
      }

      // Apply Temperature Modifier to Physics (Updraft & Turbulence)
      const updraftParam = isEmber ? (p2.emberUpdraft ?? 1.0) : (p2.fireUpdraft ?? 1.0);
      const curlParam = isEmber ? (p2.emberCurlStrength ?? 1.0) : (p2.fireCurlStrength ?? 1.0);

      if (sys.userData && sys.userData.updraftForce && typeof sys.userData.baseUpdraftMag === 'number') {
        const uf = sys.userData.updraftForce;
        const baseMag = sys.userData.baseUpdraftMag;
        if (uf.magnitude && typeof uf.magnitude.value === 'number') {
          uf.magnitude.value = baseMag * Math.max(0.0, updraftParam) * effectiveTimeScale * tempPhysMod;
        }
      }

      if (sys.userData && sys.userData.turbulence && sys.userData.baseCurlStrength && THREE && sys.userData.turbulence.strength) {
        const baseStrength = sys.userData.baseCurlStrength;
        sys.userData.turbulence.strength
          .copy(baseStrength)
          .multiplyScalar(Math.max(0.0, curlParam) * effectiveTimeScale * tempPhysMod);
      }

      // --- APPLY COLORS & LIFETIME ---
      if (isEmber) {
        const baseEmberLifeMin = p2.emberLifeMin ?? 1.5;
        const baseEmberLifeMax = p2.emberLifeMax ?? 3.0;
        const lifeMin = Math.max(0.01, baseEmberLifeMin / effectiveTimeScale);
        const lifeMax = Math.max(lifeMin, baseEmberLifeMax / effectiveTimeScale);

        const opacityMin = clamp01(p2.emberOpacityMin ?? 0.4);
        const opacityMax = Math.max(opacityMin, clamp01(p2.emberOpacityMax ?? 1.0));
        const colorBoostMin = p2.emberColorBoostMin ?? 0.9;
        const colorBoostMax = Math.max(colorBoostMin, p2.emberColorBoostMax ?? 1.5);

        const emberStdStart = p2.emberStartColor || { r: 1.0, g: 0.8, b: 0.4 };
        const emberStdEnd   = p2.emberEndColor || { r: 1.0, g: 0.2, b: 0.0 };

        let targetEmberStart, targetEmberEnd;
        if (temp <= 0.5) {
          const f = temp * 2.0;
          targetEmberStart = lerpRGB(coldStart, emberStdStart, f);
          targetEmberEnd   = lerpRGB(coldEnd, emberStdEnd, f);
        } else {
          const f = (temp - 0.5) * 2.0;
          targetEmberStart = lerpRGB(emberStdStart, hotStart, f);
          targetEmberEnd   = lerpRGB(emberStdEnd, hotEnd, f);
        }

        if (sys.startLife && typeof sys.startLife.a === 'number') {
          sys.startLife.a = lifeMin;
          sys.startLife.b = lifeMax;
        }
        if (sys.startColor && sys.startColor.a && sys.startColor.b) {
          sys.startColor.a.set(
            targetEmberStart.r * colorBoostMin,
            targetEmberStart.g * colorBoostMin,
            targetEmberStart.b * colorBoostMin,
            opacityMin
          );
          sys.startColor.b.set(
            targetEmberEnd.r * colorBoostMax,
            targetEmberEnd.g * colorBoostMax,
            targetEmberEnd.b * colorBoostMax,
            opacityMax
          );
        }
      } else {
        // Fire system
        // Lifetime is affected by Temperature (Hot = Burns faster/Shorter life)
        const lifeTempMod = 1.25 - (temp * 0.5);

        const baseFireLifeMin = p2.fireLifeMin ?? 0.4;
        const baseFireLifeMax = p2.fireLifeMax ?? 1.6;
        const lifeMin = Math.max(0.01, (baseFireLifeMin / effectiveTimeScale) * lifeTempMod);
        const lifeMax = Math.max(lifeMin, (baseFireLifeMax / effectiveTimeScale) * lifeTempMod);

        const rawOpMin = p2.fireOpacityMin ?? 0.25;
        const rawOpMax = p2.fireOpacityMax ?? 0.68;
        const opacityMin = clamp01(rawOpMin * 0.4);
        const opacityMax = Math.max(opacityMin, clamp01(rawOpMax * 0.5));
        const colorBoostMin = p2.fireColorBoostMin ?? 0.8;
        const colorBoostMax = Math.max(colorBoostMin, p2.fireColorBoostMax ?? 1.2);

        if (sys.startLife && typeof sys.startLife.a === 'number') {
          sys.startLife.a = lifeMin;
          sys.startLife.b = lifeMax;
        }
        if (sys.startColor && sys.startColor.a && sys.startColor.b) {
          sys.startColor.a.set(
            targetFireStart.r * colorBoostMin,
            targetFireStart.g * colorBoostMin,
            targetFireStart.b * colorBoostMin,
            opacityMin
          );
          sys.startColor.b.set(
            targetFireEnd.r * colorBoostMax,
            targetFireEnd.g * colorBoostMax,
            targetFireEnd.b * colorBoostMax,
            opacityMax
          );
        }

        if (Array.isArray(sys.behaviors)) {
          const col = sys.behaviors.find(b => b && (b.type === 'ColorOverLife' || b.constructor?.name === 'ColorOverLife'));
          if (col && col.color && col.color.a && col.color.b) {
            col.color.a.set(
              targetFireStart.r * colorBoostMax,
              targetFireStart.g * colorBoostMax,
              targetFireStart.b * colorBoostMax,
              1.0
            );
            col.color.b.set(
              targetFireEnd.r * colorBoostMax,
              targetFireEnd.g * colorBoostMax,
              targetFireEnd.b * colorBoostMax,
              0.0
            );
          }
        }
      }

      // Wind-based lifetime reduction
      if (windSpeed > 0.1 && sys.startLife && typeof sys.startLife.a === 'number') {
        const factor = 1.0 - (windSpeed * 0.6);
        sys.startLife.a *= factor;
        sys.startLife.b *= factor;
      }
    }

    // Sync heat distortion params to DistortionManager
    this._updateHeatDistortion();
  }

  /**
   * Sync heat distortion parameters to the DistortionManager each frame.
   * @private
   */
  _updateHeatDistortion() {
    const distortionManager = window.MapShine?.distortionManager;
    if (!distortionManager) return;

    const heatSource = distortionManager.getSource('heat');
    if (!heatSource) return;

    const p = this.params;

    // Update enabled state
    distortionManager.setSourceEnabled('heat', p.heatDistortionEnabled);

    // Update parameters
    distortionManager.updateSourceParams('heat', {
      intensity: p.heatDistortionIntensity,
      frequency: p.heatDistortionFrequency,
      speed: p.heatDistortionSpeed
    });
  }
  
  clear() {
      [...this.fires].forEach(f => this.removeFire(f.id));
  }
  
  dispose() {
      this._destroyParticleSystems();
      this._lastAssetBundle = null;
      this._lastMapPointsManager = null;
      
      // Cleanup heat distortion
      const distortionManager = window.MapShine?.distortionManager;
      if (distortionManager) {
        distortionManager.unregisterSource('heat');
      }
      if (this._heatDistortionMask) {
        this._heatDistortionMask.dispose();
        this._heatDistortionMask = null;
      }
      
      super.dispose();
  }

  /**
   * Completely remove all fire-related particle systems and lights from the
   * batch renderer and scene. This is used when the effect is disabled from
   * the UI and during dispose(). It does not touch the underlying
   * ParticleSystem backend; only the systems created by this effect.
   */
  _destroyParticleSystems() {
    const batch = this.particleSystemRef?.batchRenderer;
    const scene = this.scene;

    // Remove global mask-based systems
    if (batch && this.globalSystem) {
      batch.deleteSystem(this.globalSystem);
    }
    if (scene && this.globalSystem?.emitter) {
      scene.remove(this.globalSystem.emitter);
    }
    if (batch && this.globalEmbers) {
      batch.deleteSystem(this.globalEmbers);
    }
    if (scene && this.globalEmbers?.emitter) {
      scene.remove(this.globalEmbers.emitter);
    }
    this.globalSystem = null;
    this.globalEmbers = null;

    // Remove any per-fire systems and lights created via createFire or
    // aggregated map-point paths. We avoid calling removeFire here because
    // some entries (aggregated systems) may not have a light.
    if (batch || scene) {
      for (const f of this.fires) {
        if (batch && f.system) {
          batch.deleteSystem(f.system);
        }
        if (scene && f.light) {
          scene.remove(f.light);
          if (typeof f.light.dispose === 'function') {
            f.light.dispose();
          }
        }
      }
    }
    this.fires.length = 0;
  }

  /**
   * Rebuild fire systems after a full teardown when the effect is re-enabled
   * from the UI. This uses the last asset bundle and map-points manager if
   * they were provided earlier in the scene lifecycle.
   */
  _rebuildParticleSystemsIfNeeded() {
    // Don't rebuild if we have no particle backend yet
    if (!this.particleSystemRef?.batchRenderer || !this.scene) return;

    // If we have a stored asset bundle, recreate the global mask-based
    // systems. setAssetBundle will update _lastAssetBundle again, which is
    // fine.
    if (this._lastAssetBundle) {
      this.setAssetBundle(this._lastAssetBundle);
    }

    // If we have stored map-points, recreate aggregated systems.
    if (this._lastMapPointsManager) {
      this.setMapPointsSources(this._lastMapPointsManager);
    }
  }
}
