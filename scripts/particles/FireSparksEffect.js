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
  SizeOverLife,
  PiecewiseBezier,
  Bezier,
  CurlNoiseField
} from '../libs/three.quarks.module.js';
import { weatherController } from '../core/WeatherController.js';
import { SmartWindBehavior } from './SmartWindBehavior.js';
import { BLOOM_HOTSPOT_LAYER } from '../effects/EffectComposer.js';

const log = createLogger('FireSparksEffect');

// Legacy palette constants removed — lifecycle behaviors (FlameLifecycleBehavior,
// EmberLifecycleBehavior) now use their own internal multi-stop gradient tables
// for temperature-based color blending.

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
        
        // Weather guttering now only affects count (via life) and size.
        // Alpha is no longer reduced here — the lifecycle behavior controls
        // the full opacity curve without external multiplicative stages.
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

    // Store brightness for lifecycle behaviors to read. Brightness now only
    // affects size and life (above), not alpha directly. This prevents the
    // compounding opacity kill where brightness² made mid-range pixels invisible.
    p._flameBrightness = brightness;

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

// ============================================================================
// FlameLifecycleBehavior — physically-inspired flame color/emission/alpha
// ============================================================================
// Replaces the stock ColorOverLife + startColor pipeline with a single behavior
// that writes particle.color directly each frame. This bypasses the quarks
// engine's startColor × ColorOverLife multiplication, giving us full control
// over HDR emission, multi-stop blackbody gradients, and per-particle variation.
//
// Follows the DustFadeOverLifeBehavior pattern (DustMotesEffect.js): store
// per-particle base values at spawn, read per-frame params in frameUpdate(),
// and write particle.color directly in update().
// ============================================================================

// Pre-baked gradient tables for three temperature tiers (cold / standard / hot).
// Each stop: { t, r, g, b } where t is particle life fraction [0..1].
const _FLAME_GRADIENT_COLD = [
  { t: 0.00, r: 0.90, g: 0.50, b: 0.15 },  // Dull orange core
  { t: 0.12, r: 0.80, g: 0.25, b: 0.03 },  // Dark orange inner
  { t: 0.40, r: 0.50, g: 0.10, b: 0.02 },  // Dark red body
  { t: 0.65, r: 0.30, g: 0.05, b: 0.01 },  // Near-black tip
  { t: 1.00, r: 0.15, g: 0.03, b: 0.01 },  // Extinction
];

const _FLAME_GRADIENT_STANDARD = [
  { t: 0.00, r: 1.00, g: 0.95, b: 0.85 },  // White-yellow core (~1900K)
  { t: 0.12, r: 1.00, g: 0.72, b: 0.20 },  // Rich amber inner (~1500K)
  { t: 0.40, r: 1.00, g: 0.38, b: 0.05 },  // Deep orange body (~1300K)
  { t: 0.65, r: 0.60, g: 0.12, b: 0.02 },  // Dark crimson tip (~1000K)
  { t: 1.00, r: 0.15, g: 0.04, b: 0.01 },  // Near-black extinction (~800K)
];

const _FLAME_GRADIENT_HOT = [
  { t: 0.00, r: 0.85, g: 0.92, b: 1.00 },  // Blue-white core
  { t: 0.12, r: 1.00, g: 0.95, b: 0.85 },  // White inner
  { t: 0.40, r: 1.00, g: 0.78, b: 0.28 },  // Yellow body
  { t: 0.65, r: 1.00, g: 0.38, b: 0.05 },  // Orange tip
  { t: 1.00, r: 0.60, g: 0.12, b: 0.02 },  // Crimson extinction
];

// HDR emission multiplier curve — drives bloom via BLOOM_HOTSPOT_LAYER.
// Higher values at core mean overlapping young particles produce genuine HDR.
const _FLAME_EMISSION_STOPS = [
  { t: 0.00, v: 2.50 },  // Blazing core
  { t: 0.12, v: 2.00 },  // Inner flame
  { t: 0.35, v: 1.20 },  // Body — moderate glow
  { t: 0.55, v: 0.60 },  // Outer body — dimming
  { t: 0.70, v: 0.15 },  // Tip — barely emissive
  { t: 1.00, v: 0.00 },  // Dead
];

// Alpha envelope — clean, predictable, no external multiplicative stages.
const _FLAME_ALPHA_STOPS = [
  { t: 0.00, v: 0.00 },  // Invisible at spawn — prevents pop
  { t: 0.04, v: 0.85 },  // Rapid fade-in
  { t: 0.15, v: 1.00 },  // Full opacity core + inner
  { t: 0.50, v: 0.90 },  // Slight fade through body
  { t: 0.70, v: 0.50 },  // Noticeable fade at tip
  { t: 0.90, v: 0.15 },  // Mostly gone
  { t: 1.00, v: 0.00 },  // Dead
];

class FlameLifecycleBehavior {
  /**
   * @param {FireSparksEffect} ownerEffect - Parent effect for reading params
   */
  constructor(ownerEffect) {
    this.type = 'FlameLifecycle';
    this.ownerEffect = ownerEffect;

    // Active gradient (lerped between cold/standard/hot each frame by temperature).
    // 5 stops matching the gradient tables above.
    this._colorStops = _FLAME_GRADIENT_STANDARD.map(s => ({ ...s }));

    // Cached per-frame values from params (avoid property lookups per particle)
    this._peakOpacity = 1.0;
    this._emissionScale = 2.5;
    this._temperature = 0.5;
  }

  /**
   * Called once when a particle spawns. Stores per-particle random heat
   * variation so each flame tongue is slightly hotter or cooler.
   */
  initialize(particle) {
    // ±15% random heat variation around base temperature
    particle._flameHeat = 0.85 + Math.random() * 0.30;
    // _flameBrightness is set by FireMaskShape.initialize() before behaviors run
    if (particle._flameBrightness === undefined) {
      particle._flameBrightness = 1.0;
    }
  }

  /**
   * Called every frame for every living particle. Writes particle.color directly,
   * bypassing the quarks startColor × ColorOverLife multiplication.
   */
  update(particle, delta) {
    const life = particle.life;
    const age = particle.age;
    if (life <= 0) return;
    const t = age / Math.max(0.001, life); // 0 → 1

    const heat = particle._flameHeat ?? 1.0;
    // Clamp brightness to [0.3, 1.0] — even dim mask pixels produce visible flames
    const brightness = Math.max(0.3, particle._flameBrightness ?? 1.0);

    // 1. Sample multi-stop color gradient at time t
    const color = this._lerpColorStops(t);

    // 2. Sample emission multiplier (HDR for bloom)
    const emission = this._lerpScalarStops(_FLAME_EMISSION_STOPS, t) * heat * this._emissionScale;

    // 3. Sample alpha envelope
    const alpha = this._lerpScalarStops(_FLAME_ALPHA_STOPS, t) * this._peakOpacity;

    // 4. Write directly to particle.color (bypasses startColor multiplication)
    particle.color.x = color.r * emission * brightness;
    particle.color.y = color.g * emission * brightness;
    particle.color.z = color.b * emission * brightness;
    particle.color.w = alpha * brightness;
  }

  /**
   * Called once per frame (before per-particle updates). Reads ownerEffect.params
   * and pre-computes the active gradient for the current temperature.
   */
  frameUpdate(delta) {
    const p = this.ownerEffect?.params;
    this._peakOpacity = p?.flamePeakOpacity ?? 0.95;
    this._emissionScale = p?.coreEmission ?? 2.5;
    this._temperature = p?.fireTemperature ?? 0.5;
    this._updateGradientsForTemperature(this._temperature);
  }

  /**
   * Lerp between cold/standard/hot gradient tables based on temperature.
   * Writes result into this._colorStops (no allocation).
   */
  _updateGradientsForTemperature(temp) {
    const stops = this._colorStops;
    let srcA, srcB, f;

    if (temp <= 0.5) {
      srcA = _FLAME_GRADIENT_COLD;
      srcB = _FLAME_GRADIENT_STANDARD;
      f = temp * 2.0; // 0→1 over [0.0, 0.5]
    } else {
      srcA = _FLAME_GRADIENT_STANDARD;
      srcB = _FLAME_GRADIENT_HOT;
      f = (temp - 0.5) * 2.0; // 0→1 over [0.5, 1.0]
    }

    for (let i = 0; i < stops.length; i++) {
      const a = srcA[i];
      const b = srcB[i];
      stops[i].r = a.r + (b.r - a.r) * f;
      stops[i].g = a.g + (b.g - a.g) * f;
      stops[i].b = a.b + (b.b - a.b) * f;
    }
  }

  /**
   * Linear interpolation across the multi-stop color gradient.
   * Returns {r, g, b} for the given life fraction t.
   * @param {number} t - Life fraction [0..1]
   * @returns {{r: number, g: number, b: number}}
   */
  _lerpColorStops(t) {
    const stops = this._colorStops;
    let i = 0;
    while (i < stops.length - 1 && stops[i + 1].t <= t) i++;
    if (i >= stops.length - 1) return stops[stops.length - 1];

    const a = stops[i];
    const b = stops[i + 1];
    const f = (t - a.t) / Math.max(0.0001, b.t - a.t);
    // Reuse a temp object to avoid per-particle allocation
    return _flameColorTemp.r = a.r + (b.r - a.r) * f,
           _flameColorTemp.g = a.g + (b.g - a.g) * f,
           _flameColorTemp.b = a.b + (b.b - a.b) * f,
           _flameColorTemp;
  }

  /**
   * Linear interpolation across a scalar stop array [{t, v}, ...].
   * @param {Array<{t: number, v: number}>} stops
   * @param {number} t - Life fraction [0..1]
   * @returns {number}
   */
  _lerpScalarStops(stops, t) {
    let i = 0;
    while (i < stops.length - 1 && stops[i + 1].t <= t) i++;
    if (i >= stops.length - 1) return stops[stops.length - 1].v;

    const a = stops[i];
    const b = stops[i + 1];
    const f = (t - a.t) / Math.max(0.0001, b.t - a.t);
    return a.v + (b.v - a.v) * f;
  }

  reset() {}

  clone() {
    return new FlameLifecycleBehavior(this.ownerEffect);
  }
}

// Reusable temp object for _lerpColorStops to avoid per-particle allocation
const _flameColorTemp = { r: 0, g: 0, b: 0 };

// ============================================================================
// SmokeLifecycleBehavior — NormalBlending smoke color/alpha over life
// ============================================================================
// Smoke uses NormalBlending (dark grey must occlude, not add). This behavior
// writes particle.color directly, matching the FlameLifecycleBehavior pattern.
// Smoke is born inside the flame zone (invisible), emerges as a warm grey
// plume, and dissipates over its longer lifetime.
// ============================================================================

// Smoke color gradient: warm brownish grey → neutral grey → thinning
// Two gradient sets for the warmth slider: cool (grey) and warm (brown)
const _SMOKE_COLOR_COOL = [
  { t: 0.00, r: 0.35, g: 0.35, b: 0.35 },  // Neutral grey (born inside flame)
  { t: 0.10, r: 0.40, g: 0.40, b: 0.40 },  // Light grey (emerging)
  { t: 0.25, r: 0.45, g: 0.45, b: 0.45 },  // Peak grey
  { t: 0.50, r: 0.40, g: 0.40, b: 0.40 },  // Cooling
  { t: 0.75, r: 0.32, g: 0.32, b: 0.32 },  // Thinning
  { t: 1.00, r: 0.25, g: 0.25, b: 0.25 },  // Dissipated
];
const _SMOKE_COLOR_WARM = [
  { t: 0.00, r: 0.40, g: 0.30, b: 0.20 },  // Warm brown (born inside flame)
  { t: 0.10, r: 0.48, g: 0.38, b: 0.28 },  // Lighter brownish (emerging)
  { t: 0.25, r: 0.50, g: 0.42, b: 0.32 },  // Warm grey (peak)
  { t: 0.50, r: 0.42, g: 0.38, b: 0.32 },  // Cooling
  { t: 0.75, r: 0.33, g: 0.30, b: 0.28 },  // Thinning
  { t: 1.00, r: 0.25, g: 0.24, b: 0.22 },  // Dissipated
];


class SmokeLifecycleBehavior {
  /**
   * @param {FireSparksEffect} ownerEffect - Parent effect for reading params
   */
  constructor(ownerEffect) {
    this.type = 'SmokeLifecycle';
    this.ownerEffect = ownerEffect;

    // Cached per-frame values (updated in frameUpdate)
    this._smokeOpacity = 0.6;
    this._colorWarmth = 0.4;
    this._colorBrightness = 0.45;
    this._darknessFactor = 1.0;  // 1.0 = full brightness, 0.15 = very dark
    this._sizeGrowth = 4.0;
    this._precipMult = 1.0;

    // Alpha envelope curve control points (normalized lifetime 0-1)
    this._alphaStart = 0.0;   // t where alpha begins ramping up from 0
    this._alphaPeak = 0.75;   // t where alpha reaches maximum
    this._alphaEnd = 1.0;     // t where alpha returns to 0
  }

  initialize(particle) {
    // Per-particle smoke density from mask brightness (set by FireMaskShape).
    // Dim areas = more smoke (smoldering edges), bright areas = less smoke.
    const brightness = particle._flameBrightness ?? 1.0;
    particle._smokeDensity = 1.0 - (brightness * 0.5);

    // Store initial size for param-driven size growth (replaces SizeOverLife)
    particle._smokeStartSize = particle.size;
  }

  update(particle, delta) {
    const life = particle.life;
    const age = particle.age;
    if (life <= 0) return;
    const t = age / Math.max(0.001, life);

    const density = particle._smokeDensity ?? 0.75;

    // --- Color: blend between cool grey and warm brown based on warmth param ---
    const coolColor = _lerpStops(_SMOKE_COLOR_COOL, t);
    const warmColor = _lerpStops(_SMOKE_COLOR_WARM, t);
    const w = this._colorWarmth;
    const baseR = coolColor.r + (warmColor.r - coolColor.r) * w;
    const baseG = coolColor.g + (warmColor.g - coolColor.g) * w;
    const baseB = coolColor.b + (warmColor.b - coolColor.b) * w;

    // Apply brightness and darkness factor
    const brightDark = this._colorBrightness * this._darknessFactor;
    particle.color.x = baseR * brightDark;
    particle.color.y = baseG * brightDark;
    particle.color.z = baseB * brightDark;

    // --- Alpha: param-driven 3-point envelope (start → peak → end) ---
    // Smoothstep ramp up from _alphaStart to _alphaPeak, then down to _alphaEnd.
    let alphaEnv = 0.0;
    const aStart = this._alphaStart;
    const aPeak = this._alphaPeak;
    const aEnd = this._alphaEnd;
    if (t <= aStart) {
      alphaEnv = 0.0;
    } else if (t <= aPeak) {
      // Ramp up: smoothstep from 0 to 1
      const rampT = (t - aStart) / Math.max(0.0001, aPeak - aStart);
      alphaEnv = rampT * rampT * (3.0 - 2.0 * rampT);
    } else if (t <= aEnd) {
      // Ramp down: smoothstep from 1 to 0
      const fadeT = (t - aPeak) / Math.max(0.0001, aEnd - aPeak);
      const s = fadeT * fadeT * (3.0 - 2.0 * fadeT);
      alphaEnv = 1.0 - s;
    }
    particle.color.w = alphaEnv * density * this._smokeOpacity * this._precipMult;

    // --- Size growth: billow from startSize to startSize * sizeGrowth ---
    // Use smoothstep for natural-looking expansion
    const startSize = particle._smokeStartSize;
    if (startSize > 0) {
      const st = t * t * (3.0 - 2.0 * t); // smoothstep
      particle.size = startSize * (1.0 + (this._sizeGrowth - 1.0) * st);
    }
  }

  frameUpdate(delta) {
    const p = this.ownerEffect?.params;

    // Read smoke params (with sensible defaults)
    this._smokeOpacity = Math.max(0.0, Math.min(1.0, p?.smokeOpacity ?? 0.6));
    this._colorWarmth = Math.max(0.0, Math.min(1.0, p?.smokeColorWarmth ?? 0.4));
    this._colorBrightness = Math.max(0.01, p?.smokeColorBrightness ?? 0.45);
    this._sizeGrowth = Math.max(1.0, p?.smokeSizeGrowth ?? 4.0);

    // Alpha envelope curve: 3-point control (start/peak/end as normalized lifetime)
    this._alphaStart = Math.max(0.0, Math.min(1.0, p?.smokeAlphaStart ?? 0.0));
    this._alphaPeak = Math.max(this._alphaStart, Math.min(1.0, p?.smokeAlphaPeak ?? 0.75));
    this._alphaEnd = Math.max(this._alphaPeak, Math.min(1.0, p?.smokeAlphaEnd ?? 1.0));

    // Scene darkness modulation: smoke shouldn't glow at night
    const darknessResponse = Math.max(0.0, Math.min(1.0, p?.smokeDarknessResponse ?? 0.8));
    const envState = weatherController._environmentState;
    const sceneDarkness = envState?.sceneDarkness ?? 0.0;
    // At darkness=0: factor=1.0 (full bright); at darkness=1, response=1: factor=0.15 (very dark but not invisible)
    this._darknessFactor = 1.0 - sceneDarkness * darknessResponse * 0.85;

    // Precipitation suppresses smoke for outdoor particles (rain condenses it)
    const precip = weatherController.currentState?.precipitation || 0;
    this._precipMult = Math.max(0.2, 1.0 - precip * 0.5);
  }

  reset() {}

  clone() {
    return new SmokeLifecycleBehavior(this.ownerEffect);
  }
}

// Reusable temp objects for smoke color lerp
const _smokeColorTemp = { r: 0, g: 0, b: 0 };
const _smokeColorTemp2 = { r: 0, g: 0, b: 0 };

/** Lerp a color stop array, writing to _smokeColorTemp (or _smokeColorTemp2). */
function _lerpStops(stops, t) {
  let i = 0;
  while (i < stops.length - 1 && stops[i + 1].t <= t) i++;
  if (i >= stops.length - 1) {
    const last = stops[stops.length - 1];
    // Return using the temp that matches the stops array
    const out = (stops === _SMOKE_COLOR_COOL) ? _smokeColorTemp : _smokeColorTemp2;
    out.r = last.r; out.g = last.g; out.b = last.b;
    return out;
  }
  const a = stops[i];
  const b = stops[i + 1];
  const f = (t - a.t) / Math.max(0.0001, b.t - a.t);
  const out = (stops === _SMOKE_COLOR_COOL) ? _smokeColorTemp : _smokeColorTemp2;
  out.r = a.r + (b.r - a.r) * f;
  out.g = a.g + (b.g - a.g) * f;
  out.b = a.b + (b.b - a.b) * f;
  return out;
}


// ============================================================================
// EmberLifecycleBehavior — cooling ember color/emission over life
// ============================================================================
// Embers start blazing hot (yellow-white) and cool to dark red/black.
// Uses HDR emission for bloom, same pattern as FlameLifecycleBehavior.
// ============================================================================

const _EMBER_COLOR_STOPS = [
  { t: 0.00, r: 1.0, g: 0.9, b: 0.5 },   // Hot yellow-white (just broke off)
  { t: 0.15, r: 1.0, g: 0.6, b: 0.1 },   // Bright orange (still very hot)
  { t: 0.40, r: 0.9, g: 0.3, b: 0.02 },  // Orange-red (cooling)
  { t: 0.70, r: 0.5, g: 0.1, b: 0.01 },  // Dark red (nearly cooled)
  { t: 1.00, r: 0.2, g: 0.02, b: 0.0 },  // Almost black (dead ember)
];

const _EMBER_EMISSION_STOPS = [
  { t: 0.00, v: 3.0 },   // Blazing hot, strong bloom
  { t: 0.10, v: 2.0 },   // Still very bright
  { t: 0.30, v: 1.0 },   // Moderate glow
  { t: 0.60, v: 0.3 },   // Dim
  { t: 1.00, v: 0.0 },   // Dead
];

const _EMBER_ALPHA_STOPS = [
  { t: 0.00, v: 0.0 },   // Invisible at spawn
  { t: 0.03, v: 0.90 },  // Rapid fade-in
  { t: 0.20, v: 1.0 },   // Full
  { t: 0.60, v: 0.80 },  // Slow fade
  { t: 0.85, v: 0.30 },  // Dimming
  { t: 1.00, v: 0.0 },   // Dead
];

class EmberLifecycleBehavior {
  constructor(ownerEffect) {
    this.type = 'EmberLifecycle';
    this.ownerEffect = ownerEffect;

    // Active gradient lerped by temperature
    this._colorStops = _EMBER_COLOR_STOPS.map(s => ({ ...s }));
    this._emissionScale = 1.0;
    this._peakOpacity = 1.0;
    this._temperature = 0.5;
  }

  initialize(particle) {
    particle._emberHeat = 0.85 + Math.random() * 0.30;
    if (particle._flameBrightness === undefined) {
      particle._flameBrightness = 1.0;
    }
  }

  update(particle, delta) {
    const life = particle.life;
    const age = particle.age;
    if (life <= 0) return;
    const t = age / Math.max(0.001, life);

    const heat = particle._emberHeat ?? 1.0;
    const brightness = Math.max(0.3, particle._flameBrightness ?? 1.0);

    const color = this._lerpColorStops(t);
    const emission = this._lerpScalarStops(_EMBER_EMISSION_STOPS, t) * heat * this._emissionScale;
    const alpha = this._lerpScalarStops(_EMBER_ALPHA_STOPS, t) * this._peakOpacity;

    particle.color.x = color.r * emission * brightness;
    particle.color.y = color.g * emission * brightness;
    particle.color.z = color.b * emission * brightness;
    particle.color.w = alpha * brightness;
  }

  frameUpdate(delta) {
    const p = this.ownerEffect?.params;
    this._emissionScale = p?.emberEmission ?? 2.0;
    this._peakOpacity = p?.emberPeakOpacity ?? 0.9;
    this._temperature = p?.fireTemperature ?? 0.5;
    // Temperature shifts ember colors similar to flame
    this._updateGradientsForTemperature(this._temperature);
  }

  _updateGradientsForTemperature(temp) {
    // Embers share the same hot/cold shift idea but with a simpler blend:
    // Cold → redder/dimmer, Hot → yellower/brighter.
    // We only shift the first 2 stops (birth colors) noticeably.
    const stops = this._colorStops;
    const base = _EMBER_COLOR_STOPS;
    const heatShift = (temp - 0.5) * 0.3; // ±0.15 max

    for (let i = 0; i < stops.length; i++) {
      stops[i].r = Math.min(1.0, Math.max(0.0, base[i].r + heatShift * 0.2));
      stops[i].g = Math.min(1.0, Math.max(0.0, base[i].g + heatShift * 0.5));
      stops[i].b = Math.min(1.0, Math.max(0.0, base[i].b + heatShift * 0.8));
    }
  }

  _lerpColorStops(t) {
    const stops = this._colorStops;
    let i = 0;
    while (i < stops.length - 1 && stops[i + 1].t <= t) i++;
    if (i >= stops.length - 1) return stops[stops.length - 1];

    const a = stops[i];
    const b = stops[i + 1];
    const f = (t - a.t) / Math.max(0.0001, b.t - a.t);
    return _emberColorTemp.r = a.r + (b.r - a.r) * f,
           _emberColorTemp.g = a.g + (b.g - a.g) * f,
           _emberColorTemp.b = a.b + (b.b - a.b) * f,
           _emberColorTemp;
  }

  _lerpScalarStops(stops, t) {
    let i = 0;
    while (i < stops.length - 1 && stops[i + 1].t <= t) i++;
    if (i >= stops.length - 1) return stops[stops.length - 1].v;

    const a = stops[i];
    const b = stops[i + 1];
    const f = (t - a.t) / Math.max(0.0001, b.t - a.t);
    return a.v + (b.v - a.v) * f;
  }

  reset() {}

  clone() {
    return new EmberLifecycleBehavior(this.ownerEffect);
  }
}

const _emberColorTemp = { r: 0, g: 0, b: 0 };

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
    this.globalSmokeSystems = [];
    this._lastAssetBundle = null;
    this._lastMapPointsManager = null;
    this.emberTexture = null;
    
    // PERFORMANCE: Reusable objects to avoid per-frame allocations in update()
    // These are cleared/reused each frame instead of creating new instances.
    this._tempVec2 = null; // Lazy init when THREE is available
    this._reusableIntervalValue = null;
    this._reusableConstantValue = null;
    this._tempSystems = [];

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
      globalFireRate: 5.2,
      // Tuned default: very low flame height for floor-level glyphs
      fireHeight: 10.0,
      fireSize: 18.0,
      emberRate: 3.1,
      // Wind Influence is controlled by WeatherController; keep existing default
      windInfluence: 4.5,
      // Updated default from scene
      lightIntensity: 5.0,

      // Fire fine controls (defaults)
      fireSizeMin: 19,
      fireSizeMax: 170,
      fireLifeMin: 1.35,
      fireLifeMax: 6,
      fireSpinEnabled: true,
      fireSpinSpeedMin: 0.2,
      fireSpinSpeedMax: 0.7,

      // Temperature Control
      // 0.0 = Chilled/Dying (Red/Grey), 0.5 = Standard (Orange), 1.0 = Bunsen (Blue)
      fireTemperature: 0.5,

      // Ember fine controls (keep most previous tuning, update sizes from scene)
      emberSizeMin: 5,
      emberSizeMax: 17,
      emberLifeMin: 6.6,
      emberLifeMax: 12,
      // Physics controls (match Mad Scientist scene where provided)
      fireUpdraft: 0.3,
      emberUpdraft: 3.3,
      fireCurlStrength: 0.7,
      emberCurlStrength: 0.3,

      // Weather guttering controls (outdoor fire kill strength)
      // These scale how strongly precipitation and wind reduce fire lifetime
      // and size during spawn-time guttering in FireMaskShape.initialize.
      // Defaults preserve existing tuned behavior: precip 0.8, wind 0.4.
      weatherPrecipKill: 0.5,
      weatherWindKill: 0.5,

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
      heatDistortionEnabled: true,
      heatDistortionIntensity: 0.05, // Strength of UV offset (0.0 - 0.05)
      heatDistortionFrequency: 20,   // Noise frequency for shimmer pattern
      heatDistortionSpeed: 3,        // Animation speed multiplier
      heatDistortionBlurRadius: 4.0,  // Blur radius for mask expansion
      heatDistortionBlurPasses: 3,    // Number of blur passes (more = wider area)
      heatDistortionBoost: 2.0,       // Brightness boost before blur (expands effective area)

      // Indoor vs outdoor lifetime scaling.
      // 1.0 = indoor flames live as long as outdoor flames.
      // <1.0 = indoor flames are shorter-lived (tighter, less buoyant).
      // This is applied in FireMaskShape.initialize when outdoorFactor ~ 0.
      indoorLifeScale: 0.7,

      indoorTimeScale: 0.2,

      // ========== FLAME LIFECYCLE CONTROLS ==========
      // These drive the FlameLifecycleBehavior's multi-stop gradients.
      flamePeakOpacity: 0.9,   // Maximum alpha at peak life (0.0-1.0)
      coreEmission: 0.7,       // HDR emission multiplier for flame core (drives bloom)

      // ========== EMBER LIFECYCLE CONTROLS ==========
      emberEmission: 2.0,       // HDR emission multiplier for ember core
      emberPeakOpacity: 0.9,    // Maximum alpha for embers

      // ========== SMOKE CONTROLS ==========
      smokeEnabled: true,           // Enable/disable smoke system
      smokeRatio: 0.5,              // Smoke emission relative to fire rate
      smokeOpacity: 0.2,            // Peak smoke alpha (0-1)
      smokeColorWarmth: 0.59,       // 0 = cool grey, 1 = warm brown
      smokeColorBrightness: 0.9,    // Base brightness multiplier
      smokeDarknessResponse: 0.8,   // How much scene darkness darkens smoke (0-1)
      smokeSizeMin: 183,            // Start size minimum
      smokeSizeMax: 400,            // Start size maximum
      smokeSizeGrowth: 10,          // Smoothstep expansion factor over lifetime
      smokeLifeMin: 7,              // Minimum lifetime (seconds)
      smokeLifeMax: 15,             // Maximum lifetime (seconds)
      smokeUpdraft: 8.8,            // Upward force strength
      smokeTurbulence: 0.05,        // Curl noise strength multiplier
      smokeWindInfluence: 3.1,      // Wind response multiplier (relative to base windInfluence)
      smokeAlphaStart: 0.7,         // Normalized life (0-1) where alpha starts ramping up
      smokeAlphaPeak: 0.8,          // Normalized life where alpha reaches peak
      smokeAlphaEnd: 1,             // Normalized life where alpha fades back to 0

      // ========== FLAME TEXTURE CONTROLS ==========
      // Controls for the flame.webp sprite appearance and UV transforms.
      flameTextureOpacity: 0.78,
      flameTextureBrightness: 1.22,
      flameTextureScaleX: 1,
      flameTextureScaleY: 1,
      flameTextureOffsetX: 0,
      flameTextureOffsetY: 0,
      flameTextureRotation: 0,
      flameTextureFlipX: true,
      flameTextureFlipY: true
    };

    // Fire texture is loaded lazily via _ensureFireTexture.
    this.fireTexture = null;
  }

  isActive() {
    if (!this.settings?.enabled) return false;
    if (this.globalSystem || this.globalEmbers) return true;
    if (this.globalSystems && this.globalSystems.length) return true;
    if (this.globalEmberSystems && this.globalEmberSystems.length) return true;
    if (this.globalSmokeSystems && this.globalSmokeSystems.length) return true;
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
        // ── Flames ──────────────────────────────────────────────────────
        {
          name: 'flames', label: '🔥 Flames', type: 'folder', expanded: false,
          parameters: [
            'globalFireRate', 'fireHeight', 'fireTemperature',
            'flamePeakOpacity', 'coreEmission',
            'fireSizeMin', 'fireSizeMax',
            'fireLifeMin', 'fireLifeMax',
            'fireSpinEnabled', 'fireSpinSpeedMin', 'fireSpinSpeedMax',
            'fireUpdraft', 'fireCurlStrength'
          ]
        },
        // ── Flame Texture ───────────────────────────────────────────────
        {
          name: 'flame-texture', label: '🎨 Flame Texture', type: 'folder', expanded: false,
          parameters: [
            'flameTextureOpacity', 'flameTextureBrightness',
            'flameTextureScaleX', 'flameTextureScaleY',
            'flameTextureOffsetX', 'flameTextureOffsetY',
            'flameTextureRotation',
            'flameTextureFlipX', 'flameTextureFlipY'
          ]
        },
        // ── Embers ──────────────────────────────────────────────────────
        {
          name: 'embers', label: '✨ Embers', type: 'folder', expanded: false,
          parameters: [
            'emberRate', 'emberEmission', 'emberPeakOpacity',
            'emberSizeMin', 'emberSizeMax',
            'emberLifeMin', 'emberLifeMax',
            'emberUpdraft', 'emberCurlStrength'
          ]
        },
        // ── Smoke ───────────────────────────────────────────────────────
        {
          name: 'smoke', label: '💨 Smoke', type: 'folder', expanded: true,
          parameters: [
            'smokeEnabled', 'smokeRatio',
            'smokeOpacity', 'smokeColorWarmth', 'smokeColorBrightness',
            'smokeDarknessResponse',
            'smokeAlphaStart', 'smokeAlphaPeak', 'smokeAlphaEnd',
            'smokeSizeMin', 'smokeSizeMax', 'smokeSizeGrowth',
            'smokeLifeMin', 'smokeLifeMax',
            'smokeUpdraft', 'smokeTurbulence', 'smokeWindInfluence'
          ]
        },
        // ── Environment ─────────────────────────────────────────────────
        {
          name: 'environment', label: '🌍 Environment', type: 'folder', expanded: false,
          parameters: [
            'windInfluence', 'timeScale', 'lightIntensity',
            'indoorLifeScale', 'indoorTimeScale',
            'weatherPrecipKill', 'weatherWindKill'
          ]
        },
        // ── Heat Distortion ─────────────────────────────────────────────
        {
          name: 'heat-distortion', label: '🌀 Heat Distortion', type: 'folder', expanded: false,
          parameters: [
            'heatDistortionEnabled',
            'heatDistortionIntensity', 'heatDistortionFrequency', 'heatDistortionSpeed'
          ]
        }
      ],
      parameters: {
        enabled: { type: 'checkbox', label: 'Fire Enabled', default: true },

        // ── Flames ──────────────────────────────────────────────────────
        globalFireRate: { type: 'slider', label: 'Global Intensity', min: 0.0, max: 20.0, step: 0.1, default: 5.2 },
        fireHeight: { type: 'slider', label: 'Height', min: 1.0, max: 600.0, step: 1.0, default: 10.0 },
        fireTemperature: { type: 'slider', label: 'Temperature', min: 0.0, max: 1.0, step: 0.05, default: 0.5 },
        flamePeakOpacity: { type: 'slider', label: 'Peak Opacity', min: 0.0, max: 1.0, step: 0.01, default: 0.9 },
        coreEmission: { type: 'slider', label: 'Core Emission (HDR)', min: 0.5, max: 5.0, step: 0.1, default: 0.7 },
        fireSizeMin: { type: 'slider', label: 'Size Min', min: 1.0, max: 150.0, step: 1.0, default: 19 },
        fireSizeMax: { type: 'slider', label: 'Size Max', min: 1.0, max: 200.0, step: 1.0, default: 170 },
        fireLifeMin: { type: 'slider', label: 'Life Min (s)', min: 0.1, max: 6.0, step: 0.05, default: 1.35 },
        fireLifeMax: { type: 'slider', label: 'Life Max (s)', min: 0.1, max: 6.0, step: 0.05, default: 6 },
        fireSpinEnabled: { type: 'checkbox', label: 'Spin Enabled', default: true },
        fireSpinSpeedMin: { type: 'slider', label: 'Spin Speed Min', min: 0.0, max: 50.0, step: 0.1, default: 0.2 },
        fireSpinSpeedMax: { type: 'slider', label: 'Spin Speed Max', min: 0.0, max: 50.0, step: 0.1, default: 0.7 },
        fireUpdraft: { type: 'slider', label: 'Updraft', min: 0.0, max: 12.0, step: 0.05, default: 0.3 },
        fireCurlStrength: { type: 'slider', label: 'Curl Strength', min: 0.0, max: 12.0, step: 0.05, default: 0.7 },

        // ── Flame Texture ───────────────────────────────────────────────
        flameTextureOpacity: { type: 'slider', label: 'Opacity', min: 0.0, max: 1.0, step: 0.01, default: 0.78 },
        flameTextureBrightness: { type: 'slider', label: 'Brightness', min: 0.0, max: 3.0, step: 0.01, default: 1.22 },
        flameTextureScaleX: { type: 'slider', label: 'Scale X', min: 0.05, max: 4.0, step: 0.05, default: 1.0 },
        flameTextureScaleY: { type: 'slider', label: 'Scale Y', min: 0.05, max: 4.0, step: 0.05, default: 1.0 },
        flameTextureOffsetX: { type: 'slider', label: 'Offset X', min: -1.0, max: 1.0, step: 0.01, default: 0.0 },
        flameTextureOffsetY: { type: 'slider', label: 'Offset Y', min: -1.0, max: 1.0, step: 0.01, default: 0.0 },
        flameTextureRotation: { type: 'slider', label: 'Rotation (rad)', min: -3.14, max: 3.14, step: 0.01, default: 0.0 },
        flameTextureFlipX: { type: 'checkbox', label: 'Flip X', default: true },
        flameTextureFlipY: { type: 'checkbox', label: 'Flip Y', default: true },

        // ── Embers ──────────────────────────────────────────────────────
        emberRate: { type: 'slider', label: 'Density', min: 0.0, max: 5.0, step: 0.1, default: 3.1 },
        emberEmission: { type: 'slider', label: 'Emission (HDR)', min: 0.5, max: 5.0, step: 0.1, default: 2 },
        emberPeakOpacity: { type: 'slider', label: 'Peak Opacity', min: 0.0, max: 1.0, step: 0.01, default: 0.9 },
        emberSizeMin: { type: 'slider', label: 'Size Min', min: 1.0, max: 40.0, step: 1.0, default: 5 },
        emberSizeMax: { type: 'slider', label: 'Size Max', min: 1.0, max: 60.0, step: 1.0, default: 17 },
        emberLifeMin: { type: 'slider', label: 'Life Min (s)', min: 0.1, max: 8.0, step: 0.1, default: 6.6 },
        emberLifeMax: { type: 'slider', label: 'Life Max (s)', min: 0.1, max: 12.0, step: 0.1, default: 12.0 },
        emberUpdraft: { type: 'slider', label: 'Updraft', min: 0.0, max: 12.0, step: 0.05, default: 3.3 },
        emberCurlStrength: { type: 'slider', label: 'Curl Strength', min: 0.0, max: 12.0, step: 0.05, default: 0.3 },

        // ── Smoke ───────────────────────────────────────────────────────
        smokeEnabled: { type: 'checkbox', label: 'Enable Smoke', default: true },
        smokeRatio: { type: 'slider', label: 'Emission Density', min: 0.0, max: 3.0, step: 0.05, default: 0.5 },
        smokeOpacity: { type: 'slider', label: 'Peak Opacity', min: 0.0, max: 1.0, step: 0.01, default: 0.2 },
        smokeColorWarmth: { type: 'slider', label: 'Color Warmth', min: 0.0, max: 1.0, step: 0.01, default: 0.59 },
        smokeColorBrightness: { type: 'slider', label: 'Brightness', min: 0.05, max: 2.0, step: 0.01, default: 0.9 },
        smokeDarknessResponse: { type: 'slider', label: 'Darkness Response', min: 0.0, max: 1.0, step: 0.01, default: 0.8 },
        smokeSizeMin: { type: 'slider', label: 'Size Min', min: 1.0, max: 200.0, step: 1.0, default: 183 },
        smokeSizeMax: { type: 'slider', label: 'Size Max', min: 1.0, max: 400.0, step: 1.0, default: 400 },
        smokeSizeGrowth: { type: 'slider', label: 'Size Growth', min: 1.0, max: 10.0, step: 0.1, default: 10 },
        smokeLifeMin: { type: 'slider', label: 'Life Min (s)', min: 0.1, max: 10.0, step: 0.1, default: 7 },
        smokeLifeMax: { type: 'slider', label: 'Life Max (s)', min: 0.1, max: 15.0, step: 0.1, default: 15 },
        smokeUpdraft: { type: 'slider', label: 'Updraft', min: 0.0, max: 20.0, step: 0.1, default: 8.8 },
        smokeTurbulence: { type: 'slider', label: 'Turbulence', min: 0.0, max: 5.0, step: 0.05, default: 0.05 },
        smokeWindInfluence: { type: 'slider', label: 'Wind Response', min: 0.0, max: 10.0, step: 0.1, default: 3.1 },
        smokeAlphaStart: { type: 'slider', label: 'Alpha Ramp Start', min: 0.0, max: 1.0, step: 0.01, default: 0.7 },
        smokeAlphaPeak: { type: 'slider', label: 'Alpha Peak', min: 0.0, max: 1.0, step: 0.01, default: 0.8 },
        smokeAlphaEnd: { type: 'slider', label: 'Alpha Fade End', min: 0.0, max: 1.0, step: 0.01, default: 1.0 },

        // ── Environment ─────────────────────────────────────────────────
        windInfluence: { type: 'slider', label: 'Wind Influence', min: 0.0, max: 5.0, step: 0.1, default: 4.5 },
        timeScale: { type: 'slider', label: 'Time Scale', min: 0.1, max: 3.0, step: 0.05, default: 3.0 },
        lightIntensity: { type: 'slider', label: 'Light Intensity', min: 0.0, max: 5.0, step: 0.1, default: 5.0 },
        indoorLifeScale: { type: 'slider', label: 'Indoor Life Scale', min: 0.05, max: 1.0, step: 0.05, default: 0.7 },
        indoorTimeScale: { type: 'slider', label: 'Indoor Time Scale', min: 0.05, max: 1.0, step: 0.05, default: 0.2 },
        weatherPrecipKill: { type: 'slider', label: 'Rain Kill Strength', min: 0.0, max: 5.0, step: 0.05, default: 0.5 },
        weatherWindKill: { type: 'slider', label: 'Wind Kill Strength', min: 0.0, max: 5.0, step: 0.05, default: 0.5 },

        // ── Heat Distortion ─────────────────────────────────────────────
        heatDistortionEnabled: { type: 'checkbox', label: 'Enable Heat Haze', default: true },
        heatDistortionIntensity: { type: 'slider', label: 'Intensity', min: 0.0, max: 0.05, step: 0.001, default: 0.05 },
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

        // Create smoke system alongside fire (if enabled)
        if (this.params.smokeEnabled) {
          const smokeRatio = Math.max(0.0, this.params.smokeRatio ?? 0.3);
          const smokeRate = new IntervalValue(
            baseRate * sourceScale * smokeRatio * 0.3,
            baseRate * sourceScale * smokeRatio * 0.6
          );

          const smokeSystem = this._createSmokeSystem({
            shape,
            rate: smokeRate,
            height: this.params.fireHeight
          });

          if (smokeSystem && smokeSystem.userData) {
            smokeSystem.userData._msEmissionScale = sourceScale;
            smokeSystem.userData._msHeightSource = 'global';
          }

          batch.addSystem(smokeSystem);
          this.scene.add(smokeSystem.emitter);
          // Patch the quarks batch material for smoke to use NormalBlending
          this._patchSmokeBatchBlending(smokeSystem);

          this.fires.push({
            id: `mappoints_fire_smoke_${key}`,
            system: smokeSystem,
            position: { x: 0, y: 0 },
            isCandle: false,
            pointCount: sourceScale,
            isSmoke: true
          });
        }
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
        for (const sys of this.globalSmokeSystems) {
          if (batch && sys) batch.deleteSystem(sys);
          if (scene && sys?.emitter) scene.remove(sys.emitter);
        }
      }
      this.globalSystems.length = 0;
      this.globalEmberSystems.length = 0;
      this.globalSmokeSystems.length = 0;

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

        // Create smoke system alongside fire (if enabled)
        if (this.params.smokeEnabled) {
          const smokeRatio = Math.max(0.0, this.params.smokeRatio ?? 0.3);
          const smokeSystem = this._createSmokeSystem({
            shape: shape,
            rate: new IntervalValue(
              10.0 * weight * smokeRatio * 0.5,
              20.0 * weight * smokeRatio * 0.8
            ),
            height: this.params.fireHeight
          });
          if (smokeSystem && smokeSystem.userData) {
            smokeSystem.userData._msMaskWeight = weight;
            smokeSystem.userData._msMaskKey = key;
            smokeSystem.userData._msEmissionScale = weight;
            smokeSystem.userData._msHeightSource = 'global';
          }
          batch.addSystem(smokeSystem);
          if (this.scene) this.scene.add(smokeSystem.emitter);
          // Patch the quarks batch material for smoke to use NormalBlending
          // (quarks defaults to AdditiveBlending which makes dark grey invisible)
          this._patchSmokeBatchBlending(smokeSystem);
          this.globalSmokeSystems.push(smokeSystem);
        }
      });

      log.info('Created Global Fire + Smoke Systems from mask (' + (points.length/3) + ' points, ' + buckets.size + ' buckets)');

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

    // FlameLifecycleBehavior replaces ColorOverLife — it writes particle.color
    // directly each frame with multi-stop blackbody gradients, HDR emission,
    // and a clean alpha envelope. No more startColor × ColorOverLife double-mult.
    const flameLifecycle = new FlameLifecycleBehavior(this);

    // Two-segment size curve: rapid grow to peak then gentle shrink.
    // This models the flame expanding as it rises, then dissipating at the tip.
    const sizeOverLife = new SizeOverLife(
        new PiecewiseBezier([
            [new Bezier(0.3, 0.9, 1.0, 1.1), 0],     // 0–50%: rapid grow to peak
            [new Bezier(1.1, 1.0, 0.7, 0.4), 0.5]    // 50–100%: gentle shrink
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

    // startColor is neutral (1,1,1,1) — FlameLifecycleBehavior writes particle.color
    // directly each frame with multi-stop blackbody gradients and HDR emission.
    const system = new ParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(lifeMin, lifeMax),
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(sizeMin, sizeMax),
      startColor: new ColorRange(
        new Vector4(1, 1, 1, 1),
        new Vector4(1, 1, 1, 1)
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
        sizeOverLife,
        flameLifecycle
      ]
    });

    this._updateFireTextureSettings();
    
    // Patch the material to support roof/outdoors masking
    this._patchRoofMaskMaterial(material);

    // Enable BLOOM_HOTSPOT_LAYER on fire emitters so the HDR emission values
    // from FlameLifecycleBehavior (2.0-2.5 at core) drive bloom automatically.
    try {
      if (system?.emitter?.layers?.enable) {
        system.emitter.layers.enable(BLOOM_HOTSPOT_LAYER);
      }
    } catch (_) {
    }

    system.userData = {
      windForce,
      ownerEffect: this,
      updraftForce: buoyancy,
      baseUpdraftMag: height * 0.125,
      turbulence,
      baseCurlStrength: fireCurlStrengthBase.clone(),
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
      color: 0xffffff,
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

    // EmberLifecycleBehavior handles all color/emission/alpha directly
    const emberLifecycle = new EmberLifecycleBehavior(this);

    const emberCurlScale = new THREE.Vector3(30, 30, 30);
    const emberCurlStrengthBase = new THREE.Vector3(150, 150, 50);

    const buoyancy = new ApplyForce(new THREE.Vector3(0, 0, 1), new ConstantValue(height * 0.4));
    const windForce = new SmartWindBehavior();
    const turbulence = new CurlNoiseField(
      emberCurlScale,
      emberCurlStrengthBase.clone(),
      4.0
    );

    // Ember-specific size curve: shrink as they cool and burn away
    const emberSizeOverLife = new SizeOverLife(new PiecewiseBezier([
      [new Bezier(1.0, 0.85, 0.5, 0.2), 0]
    ]));

    const system = new ParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(lifeMin, lifeMax),
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(sizeMin, sizeMax),
      // Neutral startColor — EmberLifecycleBehavior writes particle.color directly
      startColor: new ColorRange(
        new Vector4(1, 1, 1, 1),
        new Vector4(1, 1, 1, 1)
      ),
      worldSpace: true,
      maxParticles: 2000,
      emissionOverTime: rate,
      shape: shape,
      material: material,
      renderMode: RenderMode.BillBoard,
      renderOrder: 51,
      behaviors: [
        new ParticleTimeScaledBehavior(buoyancy),
        windForce,
        new ParticleTimeScaledBehavior(turbulence),
        emberSizeOverLife,
        emberLifecycle
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

  /**
   * Create a smoke particle system for a given emitter shape.
   * Smoke uses NormalBlending (dark grey must occlude, not add), spawns from
   * the same shape as fire. Size growth is handled by SmokeLifecycleBehavior
   * (param-driven smoothstep expansion) rather than a fixed SizeOverLife curve.
   *
   * @param {Object} opts
   * @param {Object} opts.shape - Emitter shape (FireMaskShape or MultiPointEmitterShape)
   * @param {IntervalValue} opts.rate - Emission rate
   * @param {number} opts.height - Base fire height for updraft scaling
   * @returns {ParticleSystem}
   */
  _createSmokeSystem(opts) {
    const { shape, rate, height } = opts;
    const THREE = window.THREE;
    log.info('Creating smoke system', { rateA: rate?.a, rateB: rate?.b, height });

    // Smoke uses a soft round sprite — reuse particle.webp (the ember texture)
    const material = new THREE.MeshBasicMaterial({
      map: this._ensureEmberTexture(),
      transparent: true,
      blending: THREE.NormalBlending, // Critical: dark colors must occlude, not add
      color: 0xffffff,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide
    });

    const p = this.params;
    const timeScale = Math.max(0.1, p.timeScale ?? 1.0);

    // Use dedicated smoke params for lifetime
    const baseLifeMin = p.smokeLifeMin ?? 0.9;
    const baseLifeMax = p.smokeLifeMax ?? 3.0;
    const lifeMin = Math.max(0.01, baseLifeMin / timeScale);
    const lifeMax = Math.max(lifeMin, baseLifeMax / timeScale);

    // Use dedicated smoke params for start size
    const sizeMin = Math.max(1.0, p.smokeSizeMin ?? 18);
    const sizeMax = Math.max(sizeMin, p.smokeSizeMax ?? 96);

    const smokeLifecycle = new SmokeLifecycleBehavior(this);

    // Smoke rises (hot air). Updraft strength is param-driven via update().
    const smokeUpdraftMag = Math.max(0.0, p.smokeUpdraft ?? 2.5);
    const smokeUpdraft = new ApplyForce(
      new THREE.Vector3(0, 0, 1),
      new ConstantValue(smokeUpdraftMag)
    );

    // Smart wind with higher susceptibility for smoke
    const windForce = new SmartWindBehavior();

    // Turbulence — smoke billows and curls. Strength is param-driven via update().
    const smokeTurbMult = Math.max(0.0, p.smokeTurbulence ?? 1.0);
    const smokeCurlScale = new THREE.Vector3(100, 100, 40);
    const smokeCurlStrengthBase = new THREE.Vector3(
      200 * smokeTurbMult,
      200 * smokeTurbMult,
      80 * smokeTurbMult
    );
    const turbulence = new CurlNoiseField(
      smokeCurlScale,
      smokeCurlStrengthBase.clone(),
      2.0
    );

    // SmokeLifecycleBehavior handles size growth (replaces SizeOverLife for
    // param-driven control). It must be the LAST behavior so it can override
    // particle.size after any other behaviors run.
    const system = new ParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(lifeMin, lifeMax),
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(sizeMin, sizeMax),
      // Neutral startColor — SmokeLifecycleBehavior writes particle.color directly
      startColor: new ColorRange(
        new Vector4(1, 1, 1, 1),
        new Vector4(1, 1, 1, 1)
      ),
      worldSpace: true,
      maxParticles: 3000,
      emissionOverTime: rate,
      shape: shape,
      material: material,
      renderMode: RenderMode.BillBoard,
      renderOrder: 52, // Above flames (50) and embers (51) — smoke rises above fire
      startRotation: new IntervalValue(0, Math.PI * 2),
      behaviors: [
        windForce,
        smokeUpdraft,
        turbulence,
        new FireSpinBehavior(), // Reuse spin for organic look
        smokeLifecycle          // Must be last — writes color, alpha, and size
      ]
    });

    // Smoke does NOT go on BLOOM_HOTSPOT_LAYER (dark grey shouldn't glow)

    // Patch roof mask for indoor/outdoor awareness
    this._patchRoofMaskMaterial(material);

    system.userData = {
      windForce,
      ownerEffect: this,
      updraftForce: smokeUpdraft,
      baseUpdraftMag: smokeUpdraftMag,
      turbulence,
      baseCurlStrength: new THREE.Vector3(200, 200, 80), // unscaled base for update()
      isSmoke: true,
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
   * Patch the quarks batch material for a smoke system to use NormalBlending.
   * The quarks BatchedRenderer creates its own ShaderMaterial per batch, and
   * by default it inherits AdditiveBlending. Dark grey smoke is invisible
   * under additive blending, so we must override it to NormalBlending.
   * @param {ParticleSystem} smokeSystem - The smoke particle system
   */
  _patchSmokeBatchBlending(smokeSystem) {
    const THREE = window.THREE;
    const br = this.particleSystemRef?.batchRenderer;
    if (!smokeSystem || !br || !THREE) return;

    try {
      const idx = br.systemToBatchIndex?.get(smokeSystem);
      if (idx !== undefined && br.batches && br.batches[idx]) {
        const batchMat = br.batches[idx].material;
        if (batchMat) {
          batchMat.blending = THREE.NormalBlending;
          batchMat.depthWrite = false;
          batchMat.needsUpdate = true;
          log.info('Patched smoke batch material to NormalBlending (batch idx=' + idx + ')');
        }
      }
    } catch (e) {
      log.warn('Failed to patch smoke batch blending', e);
    }
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

    // Temperature Modifier for Physics (Range: 0.75 to 1.25)
    // Low Temp = Slower, sluggish (0.75x); High Temp = Faster, energetic (1.25x)
    // Color/alpha temperature blending is now handled inside each lifecycle behavior
    // (FlameLifecycleBehavior, EmberLifecycleBehavior) via their own gradient tables.
    const tempPhysMod = 0.75 + (temp * 0.5);
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
    if (this.globalSmokeSystems && this.globalSmokeSystems.length) systems.push(...this.globalSmokeSystems);
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
            // Smoke uses NormalBlending — must override the batch material's default
            // (quarks batch renderer inherits AdditiveBlending from fire systems).
            const isSmokeSystem = !!(sys.userData && sys.userData.isSmoke);
            if (THREE) {
              const desiredBlending = isSmokeSystem ? THREE.NormalBlending : THREE.AdditiveBlending;
              if (batchMat.blending !== desiredBlending) {
                batchMat.blending = desiredBlending;
                batchMat.needsUpdate = true;
              }
            }

            // Set the correct texture for each system type:
            // - Smoke and embers use the soft round particle texture
            // - Fire uses the flame sprite texture
            const desiredMap = (isSmokeSystem || (sys.userData && sys.userData.isEmber))
              ? this.emberTexture
              : this.fireTexture;
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
      const isSmoke = !!(sys.userData && sys.userData.isSmoke);
      const baseRate = 200.0 * (p2.globalFireRate ?? 0) * effectiveTimeScale * zoomEmissionMult;
      // Fire emission (smoke gets its own emission in the lifecycle branch below)
      if (!isSmoke && sys.emissionOverTime && typeof sys.emissionOverTime.a === 'number') {
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

      // Wind Influence — smoke uses its own param, embers 1.5×, fire 1×
      if (sys.userData && !isSmoke) {
        const multiplier = isEmber ? 1.5 : 1.0;
        sys.userData.windInfluence = influence * multiplier;
      }

      // Apply Temperature Modifier to Physics (Updraft & Turbulence)
      const updraftParam = isSmoke ? (p2.smokeUpdraft ?? 2.5) : isEmber ? (p2.emberUpdraft ?? 1.0) : (p2.fireUpdraft ?? 1.0);
      const curlParam = isSmoke ? (p2.smokeTurbulence ?? 1.0) : isEmber ? (p2.emberCurlStrength ?? 1.0) : (p2.fireCurlStrength ?? 1.0);

      // Height slider affects the baseline updraft magnitude for systems that follow
      // global height. Manual fires keep their creation-time height.
      if (sys.userData && sys.userData._msHeightSource === 'global') {
        const h = Math.max(0.0, p2.fireHeight ?? 0);
        if (isSmoke) {
          sys.userData.baseUpdraftMag = h * 0.25; // Smoke rises faster than fire
        } else if (isEmber) {
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

      // --- APPLY LIFETIME & SIZE ---
      // Color/alpha is now handled by lifecycle behaviors (FlameLifecycleBehavior,
      // EmberLifecycleBehavior, SmokeLifecycleBehavior). We only update spawn
      // parameters (lifetime, size) and physics here.
      if (isSmoke) {
        // Smoke emission scales with fire rate × smokeRatio
        const smokeRatio = Math.max(0.0, p2.smokeRatio ?? 0.3);
        if (sys.emissionOverTime && typeof sys.emissionOverTime.a === 'number') {
          const smokeBase = baseRate * smokeRatio;
          const r = smokeBase * Math.max(0.0, emissionScale);
          sys.emissionOverTime.a = r * 0.8;
          sys.emissionOverTime.b = r * 1.2;
        }

        // Reset startLife each frame from dedicated smoke params.
        // Without this reset, the wind-based lifetime reduction below compounds
        // every frame, collapsing startLife to zero within seconds.
        const baseSmokeLifeMin = p2.smokeLifeMin ?? 0.9;
        const baseSmokeLifeMax = p2.smokeLifeMax ?? 3.0;
        const smokeLifeMin = Math.max(0.01, baseSmokeLifeMin / effectiveTimeScale);
        const smokeLifeMax = Math.max(smokeLifeMin, baseSmokeLifeMax / effectiveTimeScale);

        if (sys.startLife && typeof sys.startLife.a === 'number') {
          sys.startLife.a = smokeLifeMin;
          sys.startLife.b = smokeLifeMax;
        }

        // Reset startSize from dedicated smoke params
        if (sys.startSize && typeof sys.startSize.a === 'number') {
          const baseSizeMin = Math.max(1.0, p2.smokeSizeMin ?? 18);
          const baseSizeMax = Math.max(baseSizeMin, p2.smokeSizeMax ?? 96);
          sys.startSize.a = baseSizeMin;
          sys.startSize.b = baseSizeMax;
        }

        // Smoke wind susceptibility is controlled by smokeWindInfluence
        if (sys.userData) {
          sys.userData.windInfluence = influence * Math.max(0.0, p2.smokeWindInfluence ?? 3.0);
        }
      } else if (isEmber) {
        // Ember system — lifecycle behavior handles color/alpha.
        // Update spawn lifetime and size only.
        const baseEmberLifeMin = p2.emberLifeMin ?? 1.5;
        const baseEmberLifeMax = p2.emberLifeMax ?? 3.0;
        const lifeMin = Math.max(0.01, baseEmberLifeMin / effectiveTimeScale);
        const lifeMax = Math.max(lifeMin, baseEmberLifeMax / effectiveTimeScale);

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
      } else {
        // Fire system — color/alpha is now fully handled by FlameLifecycleBehavior.
        // We still update lifetime and size spawn parameters here.
        const lifeTempMod = 1.25 - (temp * 0.5);

        const baseFireLifeMin = p2.fireLifeMin ?? 0.4;
        const baseFireLifeMax = p2.fireLifeMax ?? 1.6;
        const lifeMin = Math.max(0.01, (baseFireLifeMin / effectiveTimeScale) * lifeTempMod);
        const lifeMax = Math.max(lifeMin, (baseFireLifeMax / effectiveTimeScale) * lifeTempMod);

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
      for (const sys of this.globalSmokeSystems) {
        if (batch && sys) batch.deleteSystem(sys);
        if (scene && sys?.emitter) scene.remove(sys.emitter);
      }
    }
    this.globalSystems.length = 0;
    this.globalEmberSystems.length = 0;
    this.globalSmokeSystems.length = 0;

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
