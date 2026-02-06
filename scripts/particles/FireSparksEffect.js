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
  CurlNoiseField
} from '../libs/three.quarks.module.js';
import { weatherController } from '../core/WeatherController.js';
import { SmartWindBehavior } from './SmartWindBehavior.js';
import { BLOOM_HOTSPOT_LAYER } from '../effects/EffectComposer.js';

const log = createLogger('FireSparksEffect');

const _FIRE_PALETTE_COLD_START = { r: 0.8, g: 0.3, b: 0.1 };
const _FIRE_PALETTE_COLD_END = { r: 0.2, g: 0.0, b: 0.0 };
const _FIRE_PALETTE_HOT_START = { r: 0.2, g: 0.6, b: 1.0 };
const _FIRE_PALETTE_HOT_END = { r: 0.0, g: 0.1, b: 0.8 };

const _FIRE_STD_START_DEFAULT = { r: 1.0, g: 1.0, b: 1.0 };
const _FIRE_STD_END_DEFAULT = { r: 0.8, g: 0.2, b: 0.05 };
const _EMBER_STD_START_DEFAULT = { r: 1.0, g: 0.8, b: 0.4 };
const _EMBER_STD_END_DEFAULT = { r: 1.0, g: 0.2, b: 0.0 };

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

    {
      const params = this.ownerEffect && this.ownerEffect.params ? this.ownerEffect.params : null;
      const indoorTimeScale = params && typeof params.indoorTimeScale === 'number'
        ? params.indoorTimeScale
        : 0.6;
      const clampedIndoor = Math.max(0.05, Math.min(1.0, indoorTimeScale));
      p._msTimeScaleFactor = clampedIndoor + (1.0 - clampedIndoor) * outdoorFactor;
    }

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
    if (typeof particle._msTimeScaleFactor === 'number' && Number.isFinite(particle._msTimeScaleFactor)) {
      dt *= Math.max(0.0, particle._msTimeScaleFactor);
    }
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

class ParticleTimeScaledBehavior {
  constructor(inner) {
    this.type = 'ParticleTimeScaled';
    this.inner = inner;
  }

  initialize(particle, system) {
    if (this.inner && typeof this.inner.initialize === 'function') {
      this.inner.initialize(particle, system);
    }
  }

  update(particle, delta, system) {
    if (!this.inner || typeof delta !== 'number') return;

    let dt = delta;
    if (!Number.isFinite(dt)) return;
    dt = Math.min(Math.max(dt, 0), 0.1);

    if (particle && typeof particle._msTimeScaleFactor === 'number' && Number.isFinite(particle._msTimeScaleFactor)) {
      dt *= Math.max(0.0, particle._msTimeScaleFactor);
    }

    if (dt <= 0.0001) return;

    if (typeof this.inner.update === 'function') {
      if (this.inner.update.length >= 3) {
        this.inner.update(particle, dt, system);
      } else {
        this.inner.update(particle, dt);
      }
    }
  }

  frameUpdate(delta) {
    if (this.inner && typeof this.inner.frameUpdate === 'function') {
      this.inner.frameUpdate(delta);
    }
  }

  reset() {
    if (this.inner && typeof this.inner.reset === 'function') {
      this.inner.reset();
    }
  }

  clone() {
    const innerClone = this.inner && typeof this.inner.clone === 'function' ? this.inner.clone() : this.inner;
    return new ParticleTimeScaledBehavior(innerClone);
  }
}

export class FireSparksEffect extends EffectBase {
  constructor() {
    super('fire-sparks', RenderLayers.PARTICLES, 'low');

    // This effect is a continuous animation (particle atlas + simulation). When active,
    // we must render every RAF; otherwise it will look "choppy" under idle throttling.
    // We gate *actual* activation via isActive().
    this.requiresContinuousRender = true;

    this.fires = [];
    this.particleSystemRef = null; 
    this.globalSystem = null;
    this.globalEmbers = null;
    this.globalSystems = [];
    this.globalEmberSystems = [];
    this._lastAssetBundle = null;
    this._lastMapPointsManager = null;
    this.emberTexture = null;
    
    // PERFORMANCE: Reusable objects to avoid per-frame allocations in update()
    // These are cleared/reused each frame instead of creating new instances.
    this._tempVec2 = null; // Lazy init when THREE is available
    this._reusableIntervalValue = null;
    this._reusableConstantValue = null;
    this._tempSystems = [];

    this._tempTargetFireStart = { r: 1.0, g: 1.0, b: 1.0 };
    this._tempTargetFireEnd = { r: 1.0, g: 0.2, b: 0.0 };
    this._tempTargetEmberStart = { r: 1.0, g: 0.8, b: 0.4 };
    this._tempTargetEmberEnd = { r: 1.0, g: 0.2, b: 0.0 };
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

      // Fire fine controls (defaults)
      fireSizeMin: 23,
      fireSizeMax: 80,
      fireLifeMin: 2.95,
      fireLifeMax: 3.7,
      fireOpacityMin: 0.54,
      fireOpacityMax: 0.97,
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
      emberColorBoostMin: 0.7,
      emberColorBoostMax: 1.95,

      // New color controls
      fireStartColor: { r: 1.0, g: 1.0, b: 1.0 },
      fireEndColor: { r: 0.8, g: 0.2, b: 0.05 },
      emberStartColor: { r: 1.0, g: 0.8, b: 0.4 },
      emberEndColor: { r: 1.0, g: 0.2, b: 0.0 },

      // Physics controls (match Mad Scientist scene where provided)
      fireUpdraft: 0.15,
      emberUpdraft: 6.05,
      fireCurlStrength: 0.7,
      emberCurlStrength: 0.55,

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

      // ========== ZOOM-BASED PARTICLE LOD ==========
      // Rendering lots of fire can get expensive when zoomed out because many
      // emitters remain visible at once. This LOD scales emission down as the
      // camera zoom decreases (zoomed-out).
      //
      // IMPORTANT: This only reduces density; it never increases emission when
      // zoomed-in. (Multiplier clamps to 1.0 at zoom >= 1.0.)
      zoomLodEnabled: true,
      // Zoom level at which LOD reaches the minimum multiplier.
      // Example: 0.5 means "at half zoom and below, emit at min multiplier".
      zoomLodMinZoom: 0.5,
      // Minimum emission multiplier when zoomed out.
      zoomLodMinMultiplier: 0.25,
      // Curve exponent for the blend between minMultiplier and 1.0.
      // Higher = more aggressive reduction as you zoom out.
      zoomLodCurve: 2.0,

      // ========== HEAT DISTORTION CONTROLS ==========
      // Heat distortion creates a rippling heat haze effect around fire sources
      heatDistortionEnabled: false,
      heatDistortionIntensity: 0.011, // Strength of UV offset (0.0 - 0.05)
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

      indoorTimeScale: 1,

      // ========== FLAME TEXTURE CONTROLS ==========
      // Controls for the flame.webp sprite appearance and UV transforms.
      flameTextureOpacity: 0.85,
      flameTextureBrightness: 1.0,
      flameTextureScaleX: 1.0,
      flameTextureScaleY: 1.0,
      flameTextureOffsetX: 0.0,
      flameTextureOffsetY: 0.0,
      flameTextureRotation: 0.0,
      flameTextureFlipX: false,
      flameTextureFlipY: false
    };

    // Fire texture is loaded lazily via _ensureFireTexture.
    this.fireTexture = null;
  }

  isActive() {
    if (!this.settings?.enabled) return false;
    if (this.globalSystem || this.globalEmbers) return true;
    if (this.globalSystems && this.globalSystems.length) return true;
    if (this.globalEmberSystems && this.globalEmberSystems.length) return true;
    if (this.fires && this.fires.length) return true;
    return false;
  }

  _polygonAreaAbs(points) {
    if (!points || points.length < 3) return 0;
    let sum = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const xi = points[i].x;
      const yi = points[i].y;
      const xj = points[j].x;
      const yj = points[j].y;
      if (![xi, yi, xj, yj].every(Number.isFinite)) continue;
      sum += (xj * yi) - (xi * yj);
    }
    return Math.abs(sum) * 0.5;
  }

  _isPointInPolygon(x, y, polygon) {
    let inside = false;
    const n = polygon.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = polygon[i].x;
      const yi = polygon[i].y;
      const xj = polygon[j].x;
      const yj = polygon[j].y;
      if (!Number.isFinite(xi) || !Number.isFinite(yi) || !Number.isFinite(xj) || !Number.isFinite(yj)) continue;
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  _getRandomPointInPolygon(polygon, bounds, maxAttempts = 25) {
    if (!polygon || polygon.length < 3 || !bounds) return null;
    const minX = bounds.minX;
    const minY = bounds.minY;
    const w = bounds.width;
    const h = bounds.height;
    if (![minX, minY, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
    for (let i = 0; i < maxAttempts; i++) {
      const x = minX + Math.random() * w;
      const y = minY + Math.random() * h;
      if (this._isPointInPolygon(x, y, polygon)) return { x, y };
    }
    return { x: bounds.centerX, y: bounds.centerY };
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

  _ensureFireTexture() {
    const THREE = window.THREE;
    if (!THREE) return null;

    if (!this.fireTexture) {
      const texture = new THREE.TextureLoader().load('modules/map-shine-advanced/assets/flame.webp', (loaded) => {
        let finalTexture = loaded;
        const spriteTexture = this._createFireSpriteTexture(loaded.image);
        if (spriteTexture) {
          finalTexture = spriteTexture;
          if (typeof loaded.dispose === 'function') {
            loaded.dispose();
          }
        }
        finalTexture.minFilter = THREE.LinearMipmapLinearFilter;
        finalTexture.magFilter = THREE.LinearFilter;
        finalTexture.generateMipmaps = true;
        finalTexture.needsUpdate = true;
        this.fireTexture = finalTexture;
        this._applyFireTextureSettings(finalTexture);
        this._updateFireTextureSettings();
      });
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = true;
      this.fireTexture = texture;
      this._applyFireTextureSettings(texture);
    }

    return this.fireTexture;
  }

  _createFireSpriteTexture(image) {
    const THREE = window.THREE;
    if (!THREE || !image) return null;

    const width = image.width;
    const height = image.height;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(image, 0, 0, width, height);
    const imgData = ctx.getImageData(0, 0, width, height);
    const data = imgData.data;

    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      if (alpha === 0) {
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
      } else {
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);

    const texture = new THREE.CanvasTexture(canvas);
    texture.premultiplyAlpha = true;
    return texture;
  }

  _applyFireTextureSettings(texture) {
    const THREE = window.THREE;
    if (!texture || !THREE) return;

    const p = this.params || {};
    const scaleX = Math.max(0.01, p.flameTextureScaleX ?? 1.0);
    const scaleY = Math.max(0.01, p.flameTextureScaleY ?? 1.0);
    const flipX = !!p.flameTextureFlipX;
    const flipY = !!p.flameTextureFlipY;

    // Keep rotation centered so offsets behave predictably with flips and tiling.
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.center.set(0.5, 0.5);
    texture.rotation = p.flameTextureRotation ?? 0.0;

    const repeatX = (flipX ? -1 : 1) * scaleX;
    const repeatY = (flipY ? -1 : 1) * scaleY;
    texture.repeat.set(repeatX, repeatY);

    const offsetX = p.flameTextureOffsetX ?? 0.0;
    const offsetY = p.flameTextureOffsetY ?? 0.0;
    texture.offset.set(flipX ? 1.0 - offsetX : offsetX, flipY ? 1.0 - offsetY : offsetY);
    texture.needsUpdate = true;
  }

  _updateFireTextureSettings() {
    if (!this.fireTexture) return;
    this._applyFireTextureSettings(this.fireTexture);

    const brightness = Math.max(0.0, this.params?.flameTextureBrightness ?? 1.0);
    const opacity = Math.max(0.0, Math.min(1.0, this.params?.flameTextureOpacity ?? 1.0));

    const systems = this._tempSystems;
    systems.length = 0;
    if (this.globalSystem) systems.push(this.globalSystem);
    if (this.globalSystems && this.globalSystems.length) systems.push(...this.globalSystems);
    if (this.fires && this.fires.length) systems.push(...this.fires.map((f) => f?.system).filter(Boolean));

    for (const sys of systems) {
      const mat = sys?.material;
      if (!mat) continue;
      if (this.fireTexture) {
        mat.map = this.fireTexture;
        mat.alphaMap = null;
      }
      mat.opacity = opacity;
      if (mat.color) mat.color.setScalar(brightness);
      mat.needsUpdate = true;
    }
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
        {
          name: 'flame-texture',
          label: 'Flame Texture (Sprite)',
          type: 'inline',
          parameters: [
            'flameTextureOpacity',
            'flameTextureBrightness',
            'flameTextureScaleX',
            'flameTextureScaleY',
            'flameTextureOffsetX',
            'flameTextureOffsetY',
            'flameTextureRotation',
            'flameTextureFlipX',
            'flameTextureFlipY'
          ]
        },
        { name: 'embers-main', label: 'Embers - Main', type: 'inline', parameters: ['emberRate'] },
        { name: 'embers-shape', label: 'Embers - Shape', type: 'inline', parameters: ['emberSizeMin', 'emberSizeMax', 'emberLifeMin', 'emberLifeMax'] },
        { name: 'embers-look', label: 'Embers - Look', type: 'inline', parameters: ['emberOpacityMin', 'emberOpacityMax', 'emberColorBoostMin', 'emberColorBoostMax', 'emberStartColor', 'emberEndColor'] },
        { name: 'embers-physics', label: 'Embers - Physics', type: 'inline', parameters: ['emberUpdraft', 'emberCurlStrength'] },
        { name: 'env', label: 'Environment', type: 'inline', parameters: ['windInfluence', 'lightIntensity', 'timeScale', 'indoorLifeScale', 'indoorTimeScale', 'weatherPrecipKill', 'weatherWindKill'] },
        { name: 'heat-distortion', label: 'Heat Distortion', type: 'inline', parameters: ['heatDistortionEnabled', 'heatDistortionIntensity', 'heatDistortionFrequency', 'heatDistortionSpeed'] }
      ],
      parameters: {
        enabled: { type: 'checkbox', label: 'Fire Enabled', default: true },
        // Tuned default from scene: Global Intensity
        globalFireRate: { type: 'slider', label: 'Global Intensity', min: 0.0, max: 20.0, step: 0.1, default: 2.5 },
        // Tuned default: low height for floor-level glyph fires
        fireHeight: { type: 'slider', label: 'Height', min: 1.0, max: 600.0, step: 1.0, default: 10.0 },

        // Temperature (0.0 = Arctic/Chilled, 1.0 = Blue Bunsen)
        fireTemperature: { type: 'slider', label: 'Temperature', min: 0.0, max: 1.0, step: 0.05, default: 0.5 },
        fireSizeMin: { type: 'slider', label: 'Size Min', min: 1.0, max: 150.0, step: 1.0, default: 23 },
        fireSizeMax: { type: 'slider', label: 'Size Max', min: 1.0, max: 200.0, step: 1.0, default: 80 },
        fireLifeMin: { type: 'slider', label: 'Life Min (s)', min: 0.1, max: 6.0, step: 0.05, default: 2.95 },
        fireLifeMax: { type: 'slider', label: 'Life Max (s)', min: 0.1, max: 6.0, step: 0.05, default: 3.7 },
        fireOpacityMin: { type: 'slider', label: 'Opacity Min', min: 0.0, max: 1.0, step: 0.01, default: 0.54 },
        fireOpacityMax: { type: 'slider', label: 'Opacity Max', min: 0.0, max: 1.0, step: 0.01, default: 0.97 },
        fireColorBoostMin: { type: 'slider', label: 'Color Boost Min', min: 0.0, max: 4.0, step: 0.05, default: 0.0 },
        fireColorBoostMax: { type: 'slider', label: 'Color Boost Max', min: 0.0, max: 12.0, step: 0.05, default: 2.15 },
        fireStartColor: { type: 'color', default: { r: 1.0, g: 1.0, b: 1.0 } },
        fireEndColor: { type: 'color', default: { r: 0.8, g: 0.2, b: 0.05 } },
        fireSpinEnabled: { type: 'checkbox', label: 'Spin Enabled', default: true },
        fireSpinSpeedMin: { type: 'slider', label: 'Spin Speed Min (rad/s)', min: 0.0, max: 50.0, step: 0.1, default: 0.2 },
        fireSpinSpeedMax: { type: 'slider', label: 'Spin Speed Max (rad/s)', min: 0.0, max: 50.0, step: 0.1, default: 0.7 },

        // ========== FLAME TEXTURE CONTROLS ==========
        flameTextureOpacity: { type: 'slider', label: 'Opacity', min: 0.0, max: 1.0, step: 0.01, default: 0.85 },
        flameTextureBrightness: { type: 'slider', label: 'Brightness', min: 0.0, max: 3.0, step: 0.01, default: 1.0 },
        flameTextureScaleX: { type: 'slider', label: 'Scale X', min: 0.05, max: 4.0, step: 0.05, default: 1.0 },
        flameTextureScaleY: { type: 'slider', label: 'Scale Y', min: 0.05, max: 4.0, step: 0.05, default: 1.0 },
        flameTextureOffsetX: { type: 'slider', label: 'Offset X', min: -1.0, max: 1.0, step: 0.01, default: 0.0 },
        flameTextureOffsetY: { type: 'slider', label: 'Offset Y', min: -1.0, max: 1.0, step: 0.01, default: 0.0 },
        flameTextureRotation: { type: 'slider', label: 'Rotation (rad)', min: -3.14, max: 3.14, step: 0.01, default: 0.0 },
        flameTextureFlipX: { type: 'checkbox', label: 'Flip X', default: false },
        flameTextureFlipY: { type: 'checkbox', label: 'Flip Y', default: false },

        emberRate: { type: 'slider', label: 'Ember Density', min: 0.0, max: 5.0, step: 0.1, default: 2.5 },
        emberSizeMin: { type: 'slider', label: 'Ember Size Min', min: 1.0, max: 40.0, step: 1.0, default: 5.0 },
        emberSizeMax: { type: 'slider', label: 'Ember Size Max', min: 1.0, max: 60.0, step: 1.0, default: 17.0 },
        emberLifeMin: { type: 'slider', label: 'Ember Life Min (s)', min: 0.1, max: 8.0, step: 0.1, default: 1.0 },
        emberLifeMax: { type: 'slider', label: 'Ember Life Max (s)', min: 0.1, max: 12.0, step: 0.1, default: 12.0 },
        emberOpacityMin: { type: 'slider', label: 'Ember Opacity Min', min: 0.0, max: 1.0, step: 0.01, default: 0.5 },
        emberOpacityMax: { type: 'slider', label: 'Ember Opacity Max', min: 0.0, max: 1.0, step: 0.01, default: 1.0 },
        emberColorBoostMin: { type: 'slider', label: 'Ember Color Boost Min', min: 0.0, max: 2.0, step: 0.05, default: 0.7 },
        emberColorBoostMax: { type: 'slider', label: 'Ember Color Boost Max', min: 0.0, max: 3.0, step: 0.05, default: 1.95 },
        emberStartColor: { type: 'color', default: { r: 1.0, g: 0.8, b: 0.4 } },
        emberEndColor: { type: 'color', default: { r: 1.0, g: 0.2, b: 0.0 } },
        fireUpdraft: { type: 'slider', label: 'Updraft', min: 0.0, max: 12.0, step: 0.05, default: 0.15 },
        emberUpdraft: { type: 'slider', label: 'Updraft', min: 0.0, max: 12.0, step: 0.05, default: 6.05 },
        fireCurlStrength: { type: 'slider', label: 'Curl Strength', min: 0.0, max: 12.0, step: 0.05, default: 0.7 },
        emberCurlStrength: { type: 'slider', label: 'Curl Strength', min: 0.0, max: 12.0, step: 0.05, default: 0.55 },
        // Wind Influence remains generic; Light Intensity and Time Scale match scene
        windInfluence: { type: 'slider', label: 'Wind Influence', min: 0.0, max: 5.0, step: 0.1, default: 4.5 },
        lightIntensity: { type: 'slider', label: 'Light Intensity', min: 0.0, max: 5.0, step: 0.1, default: 5.0 },
        timeScale: { type: 'slider', label: 'Time Scale', min: 0.1, max: 3.0, step: 0.05, default: 3.0 },

        // Indoor vs outdoor lifetime scaling (applied only when particles are fully indoors)
        indoorLifeScale: { type: 'slider', label: 'Indoor Life Scale', min: 0.05, max: 1.0, step: 0.05, default: 0.75 },

        indoorTimeScale: { type: 'slider', label: 'Indoor Time Scale', min: 0.05, max: 1.0, step: 0.05, default: 1.0 },

        // Weather guttering strength (spawn-time kill) for outdoor flames
        weatherPrecipKill: { type: 'slider', label: 'Rain Kill Strength', min: 0.0, max: 5.0, step: 0.05, default: 0.5 },
        weatherWindKill: { type: 'slider', label: 'Wind Kill Strength', min: 0.0, max: 5.0, step: 0.05, default: 0.5 },

        // Heat Distortion Controls
        heatDistortionEnabled: { type: 'checkbox', label: 'Enable Heat Haze', default: true },
        heatDistortionIntensity: { type: 'slider', label: 'Intensity', min: 0.0, max: 0.05, step: 0.001, default: 0.011 },
        heatDistortionFrequency: { type: 'slider', label: 'Frequency', min: 1.0, max: 20.0, step: 0.5, default: 20.0 },
        heatDistortionSpeed: { type: 'slider', label: 'Speed', min: 0.1, max: 3.0, step: 0.1, default: 3.0 }
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

  _rebuildFromMapPoints() {
    const mgr = this._lastMapPointsManager;
    if (!mgr || !this.particleSystemRef?.batchRenderer) return;
    this._rebuildMapPointSystems(mgr);
  }

  _rebuildMapPointSystems(mapPointsManager) {
    if (!mapPointsManager || !this.particleSystemRef?.batchRenderer) return;

    const batch = this.particleSystemRef.batchRenderer;
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      if (!f || typeof f.id !== 'string') continue;
      if (!f.id.startsWith('mappoints_')) continue;
      try {
        if (batch && f.system) batch.deleteSystem(f.system);
        if (this.scene && f.system?.emitter) this.scene.remove(f.system.emitter);
      } catch (e) {
      }
      this.fires.splice(i, 1);
    }

    // Map points integration: only the 'fire' effect target should drive the
    // heavy particle-based flames. Candle flames are handled by CandleFlamesEffect.
    const fireGroups = mapPointsManager.getGroupsByEffect('fire');
    const fireAreas = mapPointsManager.getAreasForEffect ? (mapPointsManager.getAreasForEffect('fire') || []) : [];
    const fireAreasById = new Map();
    for (const a of fireAreas) {
      if (a && typeof a.groupId === 'string') fireAreasById.set(a.groupId, a);
    }
    
    if (fireGroups.length === 0) {
      log.debug('No map point fire sources found');
      return;
    }

    const BUCKET_SIZE = 2000;
    const fireBuckets = new Map();
    
    const d = canvas?.dimensions;
    const gridSize = (d && Number.isFinite(d.size)) ? d.size : 100;

    for (const group of fireGroups) {
      if (!group || group.isBroken) continue;
      if (!group.points || group.points.length === 0) continue;
      
      const intensity = group.emission?.intensity ?? 1.0;
      if (!Number.isFinite(intensity) || intensity <= 0) continue;

      const isArea = group.type === 'area';
      if (isArea) {
        const area = fireAreasById.get(group.id);
        const polygon = area?.points;
        const bounds = area?.bounds;
        if (!polygon || polygon.length < 3 || !bounds) continue;

        const areaPx = this._polygonAreaAbs(polygon);
        const cellArea = Math.max(1, gridSize * gridSize);
        const areaCells = areaPx / cellArea;
        const effectiveSources = Math.max(1, Math.min(5000, Math.round(areaCells)));
        const sampleCount = Math.max(30, Math.min(3000, Math.round(effectiveSources * 40)));

        const scalePerSample = effectiveSources / Math.max(1, sampleCount);
        for (let i = 0; i < sampleCount; i++) {
          const pt = this._getRandomPointInPolygon(polygon, bounds);
          if (!pt) continue;
          const worldX = pt.x;
          const worldY = pt.y;
          if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) continue;
          const bx = Math.floor(worldX / BUCKET_SIZE);
          const by = Math.floor(worldY / BUCKET_SIZE);
          const key = `${bx},${by}`;
          let bucket = fireBuckets.get(key);
          if (!bucket) {
            bucket = { coords: [], scale: 0 };
            fireBuckets.set(key, bucket);
          }
          bucket.coords.push(worldX, worldY, intensity);
          bucket.scale += scalePerSample;
        }

        continue;
      }

      for (const point of group.points) {
        const worldX = point?.x;
        const worldY = point?.y;

        if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) continue;
        
        const bx = Math.floor(worldX / BUCKET_SIZE);
        const by = Math.floor(worldY / BUCKET_SIZE);
        const key = `${bx},${by}`;
        let bucket = fireBuckets.get(key);
        if (!bucket) {
          bucket = { coords: [], scale: 0 };
          fireBuckets.set(key, bucket);
        }
        bucket.coords.push(worldX, worldY, intensity);
        bucket.scale += 1;
      }
    }

    let totalScale = 0;
    let totalSamples = 0;
    fireBuckets.forEach((bucket) => {
      totalScale += bucket?.scale ?? 0;
      totalSamples += (bucket?.coords?.length ?? 0) / 3;
    });
    log.info(`Aggregating ${totalScale.toFixed(2)} effective fire sources (${totalSamples} samples) into combined fire systems`);

    if (fireBuckets.size > 0) {
      fireBuckets.forEach((bucket, key) => {
        const arr = bucket?.coords;
        if (!arr || arr.length < 3) return;
        const pointsArray = new Float32Array(arr);
        const shape = new MultiPointEmitterShape(pointsArray, this);
        const sourceScale = Math.max(0.01, bucket?.scale ?? (arr.length / 3));

        const baseRate = this.params.globalFireRate ?? 4.0;
        const rate = new IntervalValue(
          baseRate * sourceScale * 0.5,
          baseRate * sourceScale * 1.0
        );

        const fireSystem = this._createFireSystem({
          shape,
          rate,
          size: this.params.fireSize,
          height: this.params.fireHeight
        });

        if (fireSystem && fireSystem.userData) {
          fireSystem.userData._msEmissionScale = sourceScale;
          fireSystem.userData._msHeightSource = 'global';
        }

        batch.addSystem(fireSystem);
        this.scene.add(fireSystem.emitter);

        this.fires.push({
          id: `mappoints_fire_${key}`,
          system: fireSystem,
          position: { x: 0, y: 0 },
          isCandle: false,
          pointCount: sourceScale
        });

        const emberRate = new IntervalValue(
          (this.params.emberRate ?? 5.0) * sourceScale * 0.3,
          (this.params.emberRate ?? 5.0) * sourceScale * 0.6
        );

        const emberSystem = this._createEmberSystem({
          shape,
          rate: emberRate,
          height: this.params.fireHeight
        });

        if (emberSystem && emberSystem.userData) {
          emberSystem.userData._msEmissionScale = sourceScale;
          emberSystem.userData._msHeightSource = 'global';
        }

        batch.addSystem(emberSystem);
        this.scene.add(emberSystem.emitter);

        this.fires.push({
          id: `mappoints_fire_embers_${key}`,
          system: emberSystem,
          position: { x: 0, y: 0 },
          isCandle: false,
          pointCount: sourceScale,
          isEmber: true
        });
      });
    }
  }

  _detachMapPointsListener() {
    const mgr = this._lastMapPointsManager;
    if (mgr && this._mapPointsChangeListener) {
      try {
        mgr.removeChangeListener(this._mapPointsChangeListener);
      } catch (_) {
      }
    }
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
    const prevManager = this._lastMapPointsManager;
    if (prevManager !== mapPointsManager) {
      this._detachMapPointsListener();
    }

    this._lastMapPointsManager = mapPointsManager || null;

    if (!this._mapPointsChangeListener) {
      this._mapPointsChangeListener = () => {
        // Never call setMapPointsSources() here; that would mutate the
        // listeners array during MapPointsManager.notifyListeners().
        this._rebuildFromMapPoints();
      };
    }

    if (prevManager !== mapPointsManager && this._lastMapPointsManager) {
      try {
        this._lastMapPointsManager.addChangeListener(this._mapPointsChangeListener);
      } catch (_) {
      }
    }

    if (!mapPointsManager || !this.particleSystemRef?.batchRenderer) {
      return;
    }

    this._rebuildMapPointSystems(mapPointsManager);
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
      const batch = this.particleSystemRef.batchRenderer;
      const scene = this.scene;

      if (batch && this.globalSystem) batch.deleteSystem(this.globalSystem);
      if (scene && this.globalSystem?.emitter) scene.remove(this.globalSystem.emitter);
      if (batch && this.globalEmbers) batch.deleteSystem(this.globalEmbers);
      if (scene && this.globalEmbers?.emitter) scene.remove(this.globalEmbers.emitter);
      this.globalSystem = null;
      this.globalEmbers = null;

      if (batch || scene) {
        for (const sys of this.globalSystems) {
          if (batch && sys) batch.deleteSystem(sys);
          if (scene && sys?.emitter) scene.remove(sys.emitter);
        }
        for (const sys of this.globalEmberSystems) {
          if (batch && sys) batch.deleteSystem(sys);
          if (scene && sys?.emitter) scene.remove(sys.emitter);
        }
      }
      this.globalSystems.length = 0;
      this.globalEmberSystems.length = 0;

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
      const BUCKET_SIZE = 2000;
      const buckets = new Map();
      const totalCount = points.length / 3;
      for (let i = 0; i < points.length; i += 3) {
        const u = points[i];
        const v = points[i + 1];
        const b = points[i + 2];
        if (!Number.isFinite(u) || !Number.isFinite(v) || !Number.isFinite(b) || b <= 0) continue;
        const worldX = sx + u * width;
        const worldY = sy + (1.0 - v) * height;
        const bx = Math.floor(worldX / BUCKET_SIZE);
        const by = Math.floor(worldY / BUCKET_SIZE);
        const key = `${bx},${by}`;
        let arr = buckets.get(key);
        if (!arr) {
          arr = [];
          buckets.set(key, arr);
        }
        arr.push(u, v, b);
      }

      buckets.forEach((arr, key) => {
        if (!arr || arr.length < 3) return;
        const bucketPoints = new Float32Array(arr);
        const bucketCount = bucketPoints.length / 3;
        const weight = totalCount > 0 ? (bucketCount / totalCount) : 1.0;
        const shape = new FireMaskShape(bucketPoints, width, height, sx, sy, this);

        const fireSystem = this._createFireSystem({
          shape: shape,
          rate: new IntervalValue(10.0 * weight, 20.0 * weight),
          size: this.params.fireSize,
          height: this.params.fireHeight
        });
        if (fireSystem && fireSystem.userData) {
          fireSystem.userData._msMaskWeight = weight;
          fireSystem.userData._msMaskKey = key;
          fireSystem.userData._msEmissionScale = weight;
          fireSystem.userData._msHeightSource = 'global';
        }
        batch.addSystem(fireSystem);
        if (this.scene) this.scene.add(fireSystem.emitter);
        this.globalSystems.push(fireSystem);

        const emberSystem = this._createEmberSystem({
          shape: shape,
          rate: new IntervalValue(
            (5.0 * this.params.emberRate) * weight,
            (10.0 * this.params.emberRate) * weight
          ),
          height: this.params.fireHeight
        });
        if (emberSystem && emberSystem.userData) {
          emberSystem.userData._msMaskWeight = weight;
          emberSystem.userData._msMaskKey = key;
          emberSystem.userData.isEmber = true;
          emberSystem.userData._msEmissionScale = weight;
          emberSystem.userData._msHeightSource = 'global';
        }
        batch.addSystem(emberSystem);
        if (this.scene) this.scene.add(emberSystem.emitter);
        this.globalEmberSystems.push(emberSystem);
      });

      log.info('Created Global Fire Systems from mask (' + (points.length/3) + ' points, ' + buckets.size + ' buckets)');

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

    let heatMask = null;
    try {
      const mm = window.MapShine?.maskManager;
      if (mm && typeof mm.getOrCreateBlurredMask === 'function') {
        heatMask = mm.getOrCreateBlurredMask('fire.heatExpanded.scene', 'fire.scene', {
          boost: this.params.heatDistortionBoost,
          threshold: 0.05,
          blurRadius: this.params.heatDistortionBlurRadius,
          blurPasses: this.params.heatDistortionBlurPasses,
          scale: 1.0
        });
      }
    } catch (e) {
    }

    if (!heatMask) {
      heatMask = this._createBoostedHeatMask(fireMaskTexture);
      if (!heatMask) return;
      this._heatDistortionMask = heatMask;
    } else {
      this._heatDistortionMask = null;
    }

    distortionManager.registerSource('heat', DistortionLayer.ABOVE_GROUND, heatMask, {
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
    
    const fireTexture = this._ensureFireTexture();
    const material = new THREE.MeshBasicMaterial({
      map: fireTexture,
      alphaMap: null,
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

    const colorBoostMin = Math.max(0.01, 1.0 + (p.fireColorBoostMin ?? 0.0));
    const colorBoostMax = Math.max(colorBoostMin, 1.0 + (p.fireColorBoostMax ?? 0.0));

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
      // Single-frame flame texture
      uTileCount: 1,
      vTileCount: 1,
      // Start at frame 0
      startTileIndex: new ConstantValue(0),
      startRotation: new IntervalValue(0, Math.PI * 2),
      behaviors: [
        windForce,
        buoyancy,
        turbulence,
        new FireSpinBehavior(),
        colorOverLife
      ]
    });

    this._updateFireTextureSettings();
    
    // Patch the material to support roof/outdoors masking
    this._patchRoofMaskMaterial(material);

    system.userData = {
      windForce,
      ownerEffect: this,
      updraftForce: buoyancy,
      baseUpdraftMag: height * 0.125,
      turbulence,
      baseCurlStrength: fireCurlStrengthBase.clone(),
      _msColorOverLife: colorOverLife,
      _msEmissionScale: 1.0,
      _msHeight: height
    };

    if (system.emitter) {
      system.emitter.userData = system.emitter.userData || {};
      const b = this._computeCullBoundsForShape(shape, height);
      if (b) {
        system.emitter.userData.msCullCenter = b.center;
        system.emitter.userData.msCullRadius = b.radius;
      }
    }
    
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

    const buoyancy = new ApplyForce(new THREE.Vector3(0, 0, 1), new ConstantValue(height * 0.4));
    const windForce = new SmartWindBehavior();
    const turbulence = new CurlNoiseField(
      emberCurlScale,
      emberCurlStrengthBase.clone(),
      4.0
    );

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
        new ParticleTimeScaledBehavior(buoyancy),
        windForce,
        new ParticleTimeScaledBehavior(turbulence),
        new SizeOverLife(new PiecewiseBezier([[new Bezier(1, 0.9, 0.5, 0), 0]]))
      ]
    });

    try {
      if (system?.emitter?.layers?.enable) {
        system.emitter.layers.enable(BLOOM_HOTSPOT_LAYER);
      }
    } catch (_) {
    }

    // Patch the material to support roof/outdoors masking
    this._patchRoofMaskMaterial(material);

    system.userData = {
      windForce,
      updraftForce: buoyancy,
      baseUpdraftMag: height * 0.4,
      turbulence,
      baseCurlStrength: emberCurlStrengthBase.clone(),
      isEmber: true,
      ownerEffect: this,
      _msEmissionScale: 1.0,
      _msHeight: height
    };

    if (system.emitter) {
      system.emitter.userData = system.emitter.userData || {};
      const b = this._computeCullBoundsForShape(shape, height);
      if (b) {
        system.emitter.userData.msCullCenter = b.center;
        system.emitter.userData.msCullRadius = b.radius;
      }
    }

    return system;
  }

  _computeCullBoundsForShape(shape, height) {
    if (!shape) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    if (shape.type === 'multi_point' && shape.points && shape.points.length >= 3) {
      const pts = shape.points;
      for (let i = 0; i < pts.length; i += 3) {
        const x = pts[i];
        const y = pts[i + 1];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    } else if (shape.type === 'fire_mask' && shape.points && shape.points.length >= 3) {
      const pts = shape.points;
      const w = shape.width;
      const h = shape.height;
      const ox = shape.offsetX;
      const oy = shape.offsetY;
      if (![w, h, ox, oy].every(Number.isFinite)) return null;
      for (let i = 0; i < pts.length; i += 3) {
        const u = pts[i];
        const v = pts[i + 1];
        if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
        const x = ox + u * w;
        const y = oy + (1.0 - v) * h;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    } else {
      return null;
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return null;
    }

    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const dx = Math.max(0, maxX - minX);
    const dy = Math.max(0, maxY - minY);
    const r2d = 0.5 * Math.sqrt(dx * dx + dy * dy);

    const sceneComposer = window.MapShine?.sceneComposer;
    const groundZ = (sceneComposer && typeof sceneComposer.groundZ === 'number') ? sceneComposer.groundZ : 1000;
    const h = (typeof height === 'number' && Number.isFinite(height)) ? height : 0;
    const vz = Math.max(200, h * 10);
    const cz = groundZ + vz * 0.5;
    const radius = Math.sqrt(r2d * r2d + (vz * 0.5) * (vz * 0.5));

    return { center: { x: cx, y: cy, z: cz }, radius };
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

     if (system && system.userData) {
       system.userData._msEmissionScale = intensity;
       system.userData._msHeightSource = 'manual';
     }
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
          if (this.scene && system?.emitter) {
              this.scene.remove(system.emitter);
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

      // Ensure heat distortion does not remain stuck on when the effect is disabled.
      // update() early-returns when disabled, so we must explicitly toggle the
      // DistortionManager source here.
      const distortionManager = window.MapShine?.distortionManager;
      if (distortionManager) {
        if (!value) {
          distortionManager.setSourceEnabled('heat', false);
        } else {
          distortionManager.setSourceEnabled('heat', !!this.params?.heatDistortionEnabled);
        }
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

    if (paramId.startsWith('flameTexture')) {
      this._updateFireTextureSettings();
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
    // Avoid per-frame object allocation by writing into cached temp objects.
    const stdStart = p.fireStartColor || _FIRE_STD_START_DEFAULT;
    const stdEnd = p.fireEndColor || _FIRE_STD_END_DEFAULT;

    const targetFireStart = this._tempTargetFireStart;
    const targetFireEnd = this._tempTargetFireEnd;

    if (temp <= 0.5) {
      const f = temp * 2.0;
      targetFireStart.r = _FIRE_PALETTE_COLD_START.r + (stdStart.r - _FIRE_PALETTE_COLD_START.r) * f;
      targetFireStart.g = _FIRE_PALETTE_COLD_START.g + (stdStart.g - _FIRE_PALETTE_COLD_START.g) * f;
      targetFireStart.b = _FIRE_PALETTE_COLD_START.b + (stdStart.b - _FIRE_PALETTE_COLD_START.b) * f;

      targetFireEnd.r = _FIRE_PALETTE_COLD_END.r + (stdEnd.r - _FIRE_PALETTE_COLD_END.r) * f;
      targetFireEnd.g = _FIRE_PALETTE_COLD_END.g + (stdEnd.g - _FIRE_PALETTE_COLD_END.g) * f;
      targetFireEnd.b = _FIRE_PALETTE_COLD_END.b + (stdEnd.b - _FIRE_PALETTE_COLD_END.b) * f;
    } else {
      const f = (temp - 0.5) * 2.0;
      targetFireStart.r = stdStart.r + (_FIRE_PALETTE_HOT_START.r - stdStart.r) * f;
      targetFireStart.g = stdStart.g + (_FIRE_PALETTE_HOT_START.g - stdStart.g) * f;
      targetFireStart.b = stdStart.b + (_FIRE_PALETTE_HOT_START.b - stdStart.b) * f;

      targetFireEnd.r = stdEnd.r + (_FIRE_PALETTE_HOT_END.r - stdEnd.r) * f;
      targetFireEnd.g = stdEnd.g + (_FIRE_PALETTE_HOT_END.g - stdEnd.g) * f;
      targetFireEnd.b = stdEnd.b + (_FIRE_PALETTE_HOT_END.b - stdEnd.b) * f;
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

    // 2. Update emission/physics scaling
    // Scale by timeScale AND Temperature (Hotter = slightly faster burn)
    const timeScale = Math.max(0.1, p?.timeScale ?? 1.0);
    const effectiveTimeScale = timeScale * (0.8 + 0.4 * temp);

    // Zoom-based particle LOD (reduce emission as we zoom out).
    // Uses SceneComposer's authoritative zoom value.
    const sceneZoom = (window.MapShine?.sceneComposer && typeof window.MapShine.sceneComposer.currentZoom === 'number')
      ? window.MapShine.sceneComposer.currentZoom
      : 1.0;

    let zoomEmissionMult = 1.0;
    if (p?.zoomLodEnabled) {
      const minZoom = Math.max(0.01, Math.min(1.0, p.zoomLodMinZoom ?? 0.5));
      const minMult = Math.max(0.0, Math.min(1.0, p.zoomLodMinMultiplier ?? 0.25));
      const curve = Math.max(0.01, p.zoomLodCurve ?? 2.0);

      // Clamp to [minZoom, 1.0] so we never *increase* emission beyond baseline.
      const z = Math.max(minZoom, Math.min(1.0, Number.isFinite(sceneZoom) ? sceneZoom : 1.0));
      const t = (z - minZoom) / Math.max(0.0001, (1.0 - minZoom));
      zoomEmissionMult = minMult + (1.0 - minMult) * Math.pow(Math.max(0.0, Math.min(1.0, t)), curve);
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

    // Collect systems (reuse array to avoid per-frame allocations)
    const systems = this._tempSystems;
    systems.length = 0;
    if (this.globalSystem) systems.push(this.globalSystem);
    if (this.globalEmbers) systems.push(this.globalEmbers);
    if (this.globalSystems && this.globalSystems.length) systems.push(...this.globalSystems);
    if (this.globalEmberSystems && this.globalEmberSystems.length) systems.push(...this.globalEmberSystems);
    for (const f of this.fires) {
      if (f && f.system) systems.push(f.system);
    }

    const p2 = this.params;
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
            const desiredMap = (sys.userData && sys.userData.isEmber) ? this.emberTexture : this.fireTexture;
            if (desiredMap) {
              try {
                if (batchMat.uniforms?.map) batchMat.uniforms.map.value = desiredMap;
                if (batchMat.uniforms?.tMap) batchMat.uniforms.tMap.value = desiredMap;
                if (batchMat.uniforms?.uMap) batchMat.uniforms.uMap.value = desiredMap;
                batchMat.map = desiredMap;
              } catch (_) {
              }
            }
          }
        }
      }

      const isEmber = !!(sys.userData && sys.userData.isEmber);

      // Emission rate
      // Use a unified model where each system has an emission scale representing:
      // - mask systems: bucket weight
      // - map-point systems: pointCount
      // - manual fires: intensity
      const emissionScale = (sys.userData && Number.isFinite(sys.userData._msEmissionScale))
        ? sys.userData._msEmissionScale
        : 1.0;
      const baseRate = 200.0 * (p2.globalFireRate ?? 0) * effectiveTimeScale * zoomEmissionMult;
      if (sys.emissionOverTime && typeof sys.emissionOverTime.a === 'number') {
        const r = baseRate * Math.max(0.0, emissionScale);
        sys.emissionOverTime.a = r * 0.8;
        sys.emissionOverTime.b = r * 1.2;
      }

      // Ember density is separate from fire density.
      if (isEmber && sys.emissionOverTime && typeof sys.emissionOverTime.a === 'number') {
        const emberBase = 40.0 * (p2.emberRate ?? 0) * effectiveTimeScale * zoomEmissionMult;
        const r = emberBase * Math.max(0.0, emissionScale);
        sys.emissionOverTime.a = r * 0.6;
        sys.emissionOverTime.b = r * 1.0;
      }

      // Wind Influence
      if (sys.userData) {
        const multiplier = isEmber ? 1.5 : 1.0;
        sys.userData.windInfluence = influence * multiplier;
      }

      // Apply Temperature Modifier to Physics (Updraft & Turbulence)
      const updraftParam = isEmber ? (p2.emberUpdraft ?? 1.0) : (p2.fireUpdraft ?? 1.0);
      const curlParam = isEmber ? (p2.emberCurlStrength ?? 1.0) : (p2.fireCurlStrength ?? 1.0);

      // Height slider affects the baseline updraft magnitude for systems that follow
      // global height. Manual fires keep their creation-time height.
      if (sys.userData && sys.userData._msHeightSource === 'global') {
        const h = Math.max(0.0, p2.fireHeight ?? 0);
        if (isEmber) {
          sys.userData.baseUpdraftMag = h * 0.4;
        } else {
          sys.userData.baseUpdraftMag = h * 0.125;
        }
      }

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

        const opacityMin = Math.max(0.0, Math.min(1.0, p2.emberOpacityMin ?? 0.4));
        const opacityMax = Math.max(opacityMin, Math.max(0.0, Math.min(1.0, p2.emberOpacityMax ?? 1.0)));
        const colorBoostMin = Math.max(0.01, 1.0 + (p2.emberColorBoostMin ?? 0.0));
        const colorBoostMax = Math.max(colorBoostMin, 1.0 + (p2.emberColorBoostMax ?? 0.0));

        const emberStdStart = p2.emberStartColor || _EMBER_STD_START_DEFAULT;
        const emberStdEnd = p2.emberEndColor || _EMBER_STD_END_DEFAULT;
        const targetEmberStart = this._tempTargetEmberStart;
        const targetEmberEnd = this._tempTargetEmberEnd;
        if (temp <= 0.5) {
          const f = temp * 2.0;
          targetEmberStart.r = _FIRE_PALETTE_COLD_START.r + (emberStdStart.r - _FIRE_PALETTE_COLD_START.r) * f;
          targetEmberStart.g = _FIRE_PALETTE_COLD_START.g + (emberStdStart.g - _FIRE_PALETTE_COLD_START.g) * f;
          targetEmberStart.b = _FIRE_PALETTE_COLD_START.b + (emberStdStart.b - _FIRE_PALETTE_COLD_START.b) * f;

          targetEmberEnd.r = _FIRE_PALETTE_COLD_END.r + (emberStdEnd.r - _FIRE_PALETTE_COLD_END.r) * f;
          targetEmberEnd.g = _FIRE_PALETTE_COLD_END.g + (emberStdEnd.g - _FIRE_PALETTE_COLD_END.g) * f;
          targetEmberEnd.b = _FIRE_PALETTE_COLD_END.b + (emberStdEnd.b - _FIRE_PALETTE_COLD_END.b) * f;
        } else {
          const f = (temp - 0.5) * 2.0;
          targetEmberStart.r = emberStdStart.r + (_FIRE_PALETTE_HOT_START.r - emberStdStart.r) * f;
          targetEmberStart.g = emberStdStart.g + (_FIRE_PALETTE_HOT_START.g - emberStdStart.g) * f;
          targetEmberStart.b = emberStdStart.b + (_FIRE_PALETTE_HOT_START.b - emberStdStart.b) * f;

          targetEmberEnd.r = emberStdEnd.r + (_FIRE_PALETTE_HOT_END.r - emberStdEnd.r) * f;
          targetEmberEnd.g = emberStdEnd.g + (_FIRE_PALETTE_HOT_END.g - emberStdEnd.g) * f;
          targetEmberEnd.b = emberStdEnd.b + (_FIRE_PALETTE_HOT_END.b - emberStdEnd.b) * f;
        }

        if (sys.startLife && typeof sys.startLife.a === 'number') {
          sys.startLife.a = lifeMin;
          sys.startLife.b = lifeMax;
        }

        if (sys.startSize && typeof sys.startSize.a === 'number') {
          const baseSizeMin = Math.max(0.1, p2.emberSizeMin ?? 1.0);
          const baseSizeMax = Math.max(baseSizeMin, p2.emberSizeMax ?? baseSizeMin);
          sys.startSize.a = baseSizeMin;
          sys.startSize.b = baseSizeMax;
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
        const opacityMin = Math.max(0.0, Math.min(1.0, rawOpMin * 0.4));
        const opacityMax = Math.max(opacityMin, Math.max(0.0, Math.min(1.0, rawOpMax * 0.5)));
        const colorBoostMin = Math.max(0.01, 1.0 + (p2.fireColorBoostMin ?? 0.0));
        const colorBoostMax = Math.max(colorBoostMin, 1.0 + (p2.fireColorBoostMax ?? 0.0));

        if (sys.startLife && typeof sys.startLife.a === 'number') {
          sys.startLife.a = lifeMin;
          sys.startLife.b = lifeMax;
        }

        if (sys.startSize && typeof sys.startSize.a === 'number') {
          const baseSizeMin = Math.max(0.1, p2.fireSizeMin ?? 1.0);
          const baseSizeMax = Math.max(baseSizeMin, p2.fireSizeMax ?? baseSizeMin);
          sys.startSize.a = baseSizeMin;
          sys.startSize.b = baseSizeMax;
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

        const col = sys.userData?._msColorOverLife;
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
      this._detachMapPointsListener();
      this._lastAssetBundle = null;
      this._lastMapPointsManager = null;
      
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

    if (batch || scene) {
      for (const sys of this.globalSystems) {
        if (batch && sys) batch.deleteSystem(sys);
        if (scene && sys?.emitter) scene.remove(sys.emitter);
      }
      for (const sys of this.globalEmberSystems) {
        if (batch && sys) batch.deleteSystem(sys);
        if (scene && sys?.emitter) scene.remove(sys.emitter);
      }
    }
    this.globalSystems.length = 0;
    this.globalEmberSystems.length = 0;

    // Remove any per-fire systems and lights created via createFire or
    // aggregated map-point paths. We avoid calling removeFire here because
    // some entries (aggregated systems) may not have a light.
    if (batch || scene) {
      for (const f of this.fires) {
        if (batch && f.system) {
          batch.deleteSystem(f.system);
        }
        if (scene && f.system?.emitter) {
          scene.remove(f.system.emitter);
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
