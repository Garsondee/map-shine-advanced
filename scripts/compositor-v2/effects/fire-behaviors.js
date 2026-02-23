/**
 * @fileoverview Shared fire particle behavior classes for V2 Fire Effect.
 *
 * Extracted from V1 FireSparksEffect for clean reuse. These classes plug into
 * the three.quarks particle system update loop and control per-particle
 * color, alpha, emission, spin, size, and spawn position.
 *
 * All behavior classes follow the three.quarks behavior interface:
 *   - initialize(particle, system) — called once when particle spawns
 *   - update(particle, delta, system) — called each frame
 *   - frameUpdate(delta) — called once per frame (global state sync)
 *   - reset() / clone() — lifecycle helpers
 *
 * @module compositor-v2/effects/fire-behaviors
 */

import { weatherController } from '../../core/WeatherController.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Gradient Data Constants
// ═══════════════════════════════════════════════════════════════════════════════

// Flame color gradients for three temperature tiers.
// Each stop: { t, r, g, b } where t is particle life fraction [0..1].

export const FLAME_GRADIENT_COLD = [
  { t: 0.00, r: 0.90, g: 0.50, b: 0.15 },
  { t: 0.12, r: 0.80, g: 0.25, b: 0.03 },
  { t: 0.40, r: 0.50, g: 0.10, b: 0.02 },
  { t: 0.65, r: 0.30, g: 0.05, b: 0.01 },
  { t: 1.00, r: 0.15, g: 0.03, b: 0.01 },
];

export const FLAME_GRADIENT_STANDARD = [
  { t: 0.00, r: 1.00, g: 0.95, b: 0.85 },
  { t: 0.12, r: 1.00, g: 0.72, b: 0.20 },
  { t: 0.40, r: 1.00, g: 0.38, b: 0.05 },
  { t: 0.65, r: 0.60, g: 0.12, b: 0.02 },
  { t: 1.00, r: 0.15, g: 0.04, b: 0.01 },
];

export const FLAME_GRADIENT_HOT = [
  { t: 0.00, r: 0.85, g: 0.92, b: 1.00 },
  { t: 0.12, r: 1.00, g: 0.95, b: 0.85 },
  { t: 0.40, r: 1.00, g: 0.78, b: 0.28 },
  { t: 0.65, r: 1.00, g: 0.38, b: 0.05 },
  { t: 1.00, r: 0.60, g: 0.12, b: 0.02 },
];

// HDR emission multiplier curve — drives bloom.
export const FLAME_EMISSION_STOPS = [
  { t: 0.00, v: 2.50 },
  { t: 0.12, v: 2.00 },
  { t: 0.35, v: 1.20 },
  { t: 0.55, v: 0.60 },
  { t: 0.70, v: 0.15 },
  { t: 1.00, v: 0.00 },
];

// Alpha envelope for flames.
export const FLAME_ALPHA_STOPS = [
  { t: 0.00, v: 0.00 },
  { t: 0.04, v: 0.85 },
  { t: 0.15, v: 1.00 },
  { t: 0.50, v: 0.90 },
  { t: 0.70, v: 0.50 },
  { t: 0.90, v: 0.15 },
  { t: 1.00, v: 0.00 },
];

// Ember color gradient (hot yellow-white → dark red → black).
export const EMBER_COLOR_STOPS = [
  { t: 0.00, r: 1.0, g: 0.9, b: 0.5 },
  { t: 0.15, r: 1.0, g: 0.6, b: 0.1 },
  { t: 0.40, r: 0.9, g: 0.3, b: 0.02 },
  { t: 0.70, r: 0.5, g: 0.1, b: 0.01 },
  { t: 1.00, r: 0.2, g: 0.02, b: 0.0 },
];

export const EMBER_EMISSION_STOPS = [
  { t: 0.00, v: 3.0 },
  { t: 0.10, v: 2.0 },
  { t: 0.30, v: 1.0 },
  { t: 0.60, v: 0.3 },
  { t: 1.00, v: 0.0 },
];

export const EMBER_ALPHA_STOPS = [
  { t: 0.00, v: 0.0 },
  { t: 0.03, v: 0.90 },
  { t: 0.20, v: 1.0 },
  { t: 0.60, v: 0.80 },
  { t: 0.85, v: 0.30 },
  { t: 1.00, v: 0.0 },
];

// Smoke color gradients (cool grey vs warm brown).
export const SMOKE_COLOR_COOL = [
  { t: 0.00, r: 0.35, g: 0.35, b: 0.35 },
  { t: 0.10, r: 0.40, g: 0.40, b: 0.40 },
  { t: 0.25, r: 0.45, g: 0.45, b: 0.45 },
  { t: 0.50, r: 0.40, g: 0.40, b: 0.40 },
  { t: 0.75, r: 0.32, g: 0.32, b: 0.32 },
  { t: 1.00, r: 0.25, g: 0.25, b: 0.25 },
];

export const SMOKE_COLOR_WARM = [
  { t: 0.00, r: 0.40, g: 0.30, b: 0.20 },
  { t: 0.10, r: 0.48, g: 0.38, b: 0.28 },
  { t: 0.25, r: 0.50, g: 0.42, b: 0.32 },
  { t: 0.50, r: 0.42, g: 0.38, b: 0.32 },
  { t: 0.75, r: 0.33, g: 0.30, b: 0.28 },
  { t: 1.00, r: 0.25, g: 0.24, b: 0.22 },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Utility: Multi-stop Gradient Interpolation
// ═══════════════════════════════════════════════════════════════════════════════

// Reusable temp objects to avoid per-particle allocation.
const _flameColorTemp = { r: 0, g: 0, b: 0 };
const _emberColorTemp = { r: 0, g: 0, b: 0 };
const _smokeColorTemp = { r: 0, g: 0, b: 0 };
const _smokeColorTemp2 = { r: 0, g: 0, b: 0 };

/**
 * Lerp a color stop array [{t,r,g,b}, ...] returning {r,g,b}.
 * Uses the provided temp object to avoid allocation.
 */
function lerpColorStops(stops, t, temp) {
  let i = 0;
  while (i < stops.length - 1 && stops[i + 1].t <= t) i++;
  if (i >= stops.length - 1) {
    const last = stops[stops.length - 1];
    temp.r = last.r; temp.g = last.g; temp.b = last.b;
    return temp;
  }
  const a = stops[i];
  const b = stops[i + 1];
  const f = (t - a.t) / Math.max(0.0001, b.t - a.t);
  temp.r = a.r + (b.r - a.r) * f;
  temp.g = a.g + (b.g - a.g) * f;
  temp.b = a.b + (b.b - a.b) * f;
  return temp;
}

/** Lerp a scalar stop array [{t, v}, ...] returning a number. */
function lerpScalarStops(stops, t) {
  let i = 0;
  while (i < stops.length - 1 && stops[i + 1].t <= t) i++;
  if (i >= stops.length - 1) return stops[stops.length - 1].v;
  const a = stops[i];
  const b = stops[i + 1];
  const f = (t - a.t) / Math.max(0.0001, b.t - a.t);
  return a.v + (b.v - a.v) * f;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FireMaskShape — Emitter shape that spawns from precomputed _Fire mask pixels
// ═══════════════════════════════════════════════════════════════════════════════

export class FireMaskShape {
  /**
   * @param {Float32Array} points - Packed (u, v, brightness) triples
   * @param {number} width - Scene width in world units
   * @param {number} height - Scene height in world units
   * @param {number} offsetX - Scene X origin in world units
   * @param {number} offsetY - Scene Y origin in world units
   * @param {object} ownerEffect - Effect instance for reading params/weather
   * @param {number} [groundZ=1000] - Z position for ground plane
   * @param {number} [floorElevation=0] - Z offset above groundZ for this floor
   */
  constructor(points, width, height, offsetX, offsetY, ownerEffect, groundZ = 1000, floorElevation = 0) {
    this.points = points;
    this.width = width;
    this.height = height;
    this.offsetX = offsetX;
    this.offsetY = offsetY;
    this.ownerEffect = ownerEffect;
    this.groundZ = groundZ;
    this.floorElevation = Number.isFinite(floorElevation) ? floorElevation : 0;
    this.type = 'fire_mask';
  }

  initialize(p) {
    const count = this.points.length / 3;
    if (count === 0) return;

    // Pick a random point from the precomputed (u, v, brightness) list.
    const idx = Math.floor(Math.random() * count) * 3;
    const u = this.points[idx];
    const v = this.points[idx + 1];
    const brightness = this.points[idx + 2];

    // Kill invalid particles.
    if (!Number.isFinite(u) || !Number.isFinite(v) || !Number.isFinite(brightness) || brightness <= 0) {
      if (typeof p.life === 'number') p.life = 0;
      if (p.color && typeof p.color.w === 'number') p.color.w = 0;
      if (typeof p.size === 'number') p.size = 0;
      return;
    }

    // Map UV to world-space position. v=0 is image top, world Y grows upward,
    // so we use (1-v) for the Y mapping.
    p.position.x = this.offsetX + u * this.width;
    p.position.y = this.offsetY + (1.0 - v) * this.height;
    p.position.z = this.groundZ + this.floorElevation;

    // Query outdoor mask for wind susceptibility.
    let outdoorFactor = 1.0;
    try {
      if (weatherController && typeof weatherController.getRoofMaskIntensity === 'function') {
        outdoorFactor = weatherController.getRoofMaskIntensity(u, v);
      }
    } catch (_) {
      outdoorFactor = 1.0;
    }
    if (!Number.isFinite(outdoorFactor) || outdoorFactor < 0) outdoorFactor = 0;
    if (outdoorFactor > 1) outdoorFactor = 1;
    p._windSusceptibility = outdoorFactor;

    // Indoor time scaling.
    const params = this.ownerEffect?.params;
    const indoorTimeScale = Math.max(0.05, Math.min(1.0, params?.indoorTimeScale ?? 0.6));
    p._msTimeScaleFactor = indoorTimeScale + (1.0 - indoorTimeScale) * outdoorFactor;

    // Indoor life shortening.
    if (outdoorFactor <= 0.01 && typeof p.life === 'number') {
      const indoorLifeScale = params?.indoorLifeScale ?? 0.2;
      p.life *= indoorLifeScale;
    }

    // Weather guttering: rain + wind kills exposed fire.
    let weather = {};
    try {
      weather = (weatherController && typeof weatherController.getCurrentState === 'function')
        ? weatherController.getCurrentState()
        : {};
    } catch (_) {
      weather = {};
    }
    let precip = weather?.precipitation ?? 0;
    let wind = weather?.windSpeed ?? 0;
    if (!Number.isFinite(precip)) precip = 0;
    if (!Number.isFinite(wind)) wind = 0;

    if (outdoorFactor > 0.01 && (precip > 0.05 || wind > 0.1)) {
      const precipKill = params?.weatherPrecipKill ?? 0.8;
      const windKill = params?.weatherWindKill ?? 0.4;
      const weatherStress = 0.5 * (precip * precipKill + wind * windKill) * outdoorFactor;
      const survival = Math.max(0.1, 1.0 - weatherStress);
      if (typeof p.life === 'number') p.life *= survival;
      if (typeof p.size === 'number') p.size *= (0.6 + 0.4 * survival);
    }

    // Brightness-based modifiers.
    if (typeof p.life === 'number') p.life *= (0.3 + 0.7 * brightness);
    if (typeof p.size === 'number') p.size *= (0.4 + 0.6 * brightness);
    p._flameBrightness = brightness;

    // Reset velocity.
    if (p.velocity) p.velocity.set(0, 0, 0);

    // Final sanity check.
    const tooBig = (val) => !Number.isFinite(val) || Math.abs(val) > 1e6;
    if ((p.position && (tooBig(p.position.x) || tooBig(p.position.y) || tooBig(p.position.z))) ||
        (typeof p.life === 'number' && tooBig(p.life)) ||
        (typeof p.size === 'number' && tooBig(p.size))) {
      if (typeof p.life === 'number') p.life = 0;
      if (typeof p.size === 'number') p.size = 0;
      if (p.color && typeof p.color.w === 'number') p.color.w = 0;
    }
  }

  update(system, delta) { /* static mask — no per-frame evolution */ }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FlameLifecycleBehavior — Blackbody color, HDR emission, alpha envelope
// ═══════════════════════════════════════════════════════════════════════════════

export class FlameLifecycleBehavior {
  constructor(ownerEffect) {
    this.type = 'FlameLifecycle';
    this.ownerEffect = ownerEffect;
    this._colorStops = FLAME_GRADIENT_STANDARD.map(s => ({ ...s }));
    this._peakOpacity = 1.0;
    this._emissionScale = 2.5;
    this._temperature = 0.5;
  }

  initialize(particle) {
    particle._flameHeat = 0.7 + Math.random() * 0.5;
    if (particle._flameBrightness === undefined) particle._flameBrightness = 1.0;
  }

  update(particle, delta) {
    const life = particle.life;
    const age = particle.age;
    if (life <= 0) return;
    const t = age / Math.max(0.001, life);

    const heat = particle._flameHeat ?? 1.0;
    const brightness = Math.max(0.3, particle._flameBrightness ?? 1.0);

    const color = lerpColorStops(this._colorStops, t, _flameColorTemp);
    const emission = lerpScalarStops(FLAME_EMISSION_STOPS, t) * heat * this._emissionScale;
    const alpha = lerpScalarStops(FLAME_ALPHA_STOPS, t) * this._peakOpacity;

    particle.color.x = color.r * emission * brightness;
    particle.color.y = color.g * emission * brightness;
    particle.color.z = color.b * emission * brightness;
    particle.color.w = alpha * brightness;
  }

  frameUpdate(delta) {
    const p = this.ownerEffect?.params;
    this._emissionScale = p?.coreEmission ?? 2.5;
    this._peakOpacity = p?.flamePeakOpacity ?? 0.9;
    this._temperature = p?.fireTemperature ?? 0.5;
    this._updateGradientsForTemperature(this._temperature);
  }

  _updateGradientsForTemperature(temp) {
    const stops = this._colorStops;
    // Blend between cold/standard/hot gradients based on temperature.
    let srcA, srcB, blend;
    if (temp <= 0.5) {
      srcA = FLAME_GRADIENT_COLD;
      srcB = FLAME_GRADIENT_STANDARD;
      blend = temp / 0.5;
    } else {
      srcA = FLAME_GRADIENT_STANDARD;
      srcB = FLAME_GRADIENT_HOT;
      blend = (temp - 0.5) / 0.5;
    }
    for (let i = 0; i < stops.length && i < srcA.length && i < srcB.length; i++) {
      stops[i].r = srcA[i].r + (srcB[i].r - srcA[i].r) * blend;
      stops[i].g = srcA[i].g + (srcB[i].g - srcA[i].g) * blend;
      stops[i].b = srcA[i].b + (srcB[i].b - srcA[i].b) * blend;
    }
  }

  reset() {}
  clone() { return new FlameLifecycleBehavior(this.ownerEffect); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EmberLifecycleBehavior — Cooling ember color/emission over life
// ═══════════════════════════════════════════════════════════════════════════════

export class EmberLifecycleBehavior {
  constructor(ownerEffect) {
    this.type = 'EmberLifecycle';
    this.ownerEffect = ownerEffect;
    this._colorStops = EMBER_COLOR_STOPS.map(s => ({ ...s }));
    this._emissionScale = 1.0;
    this._peakOpacity = 1.0;
    this._temperature = 0.5;
  }

  initialize(particle) {
    particle._emberHeat = 0.85 + Math.random() * 0.30;
    if (particle._flameBrightness === undefined) particle._flameBrightness = 1.0;
  }

  update(particle, delta) {
    const life = particle.life;
    const age = particle.age;
    if (life <= 0) return;
    const t = age / Math.max(0.001, life);

    const heat = particle._emberHeat ?? 1.0;
    const brightness = Math.max(0.3, particle._flameBrightness ?? 1.0);

    const color = lerpColorStops(this._colorStops, t, _emberColorTemp);
    const emission = lerpScalarStops(EMBER_EMISSION_STOPS, t) * heat * this._emissionScale;
    const alpha = lerpScalarStops(EMBER_ALPHA_STOPS, t) * this._peakOpacity;

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
    this._updateGradientsForTemperature(this._temperature);
  }

  _updateGradientsForTemperature(temp) {
    const stops = this._colorStops;
    const base = EMBER_COLOR_STOPS;
    const heatShift = (temp - 0.5) * 0.3;
    for (let i = 0; i < stops.length; i++) {
      stops[i].r = Math.min(1.0, Math.max(0.0, base[i].r + heatShift * 0.2));
      stops[i].g = Math.min(1.0, Math.max(0.0, base[i].g + heatShift * 0.5));
      stops[i].b = Math.min(1.0, Math.max(0.0, base[i].b + heatShift * 0.8));
    }
  }

  reset() {}
  clone() { return new EmberLifecycleBehavior(this.ownerEffect); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SmokeLifecycleBehavior — NormalBlending smoke color/alpha/size over life
// ═══════════════════════════════════════════════════════════════════════════════

export class SmokeLifecycleBehavior {
  constructor(ownerEffect) {
    this.type = 'SmokeLifecycle';
    this.ownerEffect = ownerEffect;
    this._smokeOpacity = 0.6;
    this._colorWarmth = 0.4;
    this._colorBrightness = 0.45;
    this._darknessFactor = 1.0;
    this._sizeGrowth = 4.0;
    this._precipMult = 1.0;
    this._alphaStart = 0.0;
    this._alphaPeak = 0.75;
    this._alphaEnd = 1.0;
  }

  initialize(particle) {
    const brightness = particle._flameBrightness ?? 1.0;
    particle._smokeDensity = 1.0 - (brightness * 0.5);
    particle._smokeStartSize = particle.size;
  }

  update(particle, delta) {
    const life = particle.life;
    const age = particle.age;
    if (life <= 0) return;
    const t = age / Math.max(0.001, life);

    const density = particle._smokeDensity ?? 0.75;

    // Color: blend cool grey and warm brown.
    const coolColor = lerpColorStops(SMOKE_COLOR_COOL, t, _smokeColorTemp);
    const warmColor = lerpColorStops(SMOKE_COLOR_WARM, t, _smokeColorTemp2);
    const w = this._colorWarmth;
    const baseR = coolColor.r + (warmColor.r - coolColor.r) * w;
    const baseG = coolColor.g + (warmColor.g - coolColor.g) * w;
    const baseB = coolColor.b + (warmColor.b - coolColor.b) * w;

    const brightDark = this._colorBrightness * this._darknessFactor;
    particle.color.x = baseR * brightDark;
    particle.color.y = baseG * brightDark;
    particle.color.z = baseB * brightDark;

    // Alpha: 3-point smoothstep envelope.
    let alphaEnv = 0.0;
    const aStart = this._alphaStart;
    const aPeak = this._alphaPeak;
    const aEnd = this._alphaEnd;
    if (t <= aStart) {
      alphaEnv = 0.0;
    } else if (t <= aPeak) {
      const rampT = (t - aStart) / Math.max(0.0001, aPeak - aStart);
      alphaEnv = rampT * rampT * (3.0 - 2.0 * rampT);
    } else if (t <= aEnd) {
      const fadeT = (t - aPeak) / Math.max(0.0001, aEnd - aPeak);
      const s = fadeT * fadeT * (3.0 - 2.0 * fadeT);
      alphaEnv = 1.0 - s;
    }
    particle.color.w = alphaEnv * density * this._smokeOpacity * this._precipMult;

    // Size growth: billow from startSize to startSize * sizeGrowth.
    const startSize = particle._smokeStartSize;
    if (startSize > 0) {
      const st = t * t * (3.0 - 2.0 * t);
      particle.size = startSize * (1.0 + (this._sizeGrowth - 1.0) * st);
    }
  }

  frameUpdate(delta) {
    const p = this.ownerEffect?.params;
    this._smokeOpacity = Math.max(0.0, Math.min(1.0, p?.smokeOpacity ?? 0.6));
    this._colorWarmth = Math.max(0.0, Math.min(1.0, p?.smokeColorWarmth ?? 0.4));
    this._colorBrightness = Math.max(0.01, p?.smokeColorBrightness ?? 0.45);
    this._sizeGrowth = Math.max(1.0, p?.smokeSizeGrowth ?? 4.0);
    this._alphaStart = Math.max(0.0, Math.min(1.0, p?.smokeAlphaStart ?? 0.0));
    this._alphaPeak = Math.max(this._alphaStart, Math.min(1.0, p?.smokeAlphaPeak ?? 0.75));
    this._alphaEnd = Math.max(this._alphaPeak, Math.min(1.0, p?.smokeAlphaEnd ?? 1.0));

    const darknessResponse = Math.max(0.0, Math.min(1.0, p?.smokeDarknessResponse ?? 0.8));
    const envState = weatherController._environmentState;
    const sceneDarkness = envState?.sceneDarkness ?? 0.0;
    this._darknessFactor = 1.0 - sceneDarkness * darknessResponse * 0.85;

    const precip = weatherController.currentState?.precipitation || 0;
    this._precipMult = Math.max(0.2, 1.0 - precip * 0.5);
  }

  reset() {}
  clone() { return new SmokeLifecycleBehavior(this.ownerEffect); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FireSpinBehavior — Random per-particle sprite rotation
// ═══════════════════════════════════════════════════════════════════════════════

export class FireSpinBehavior {
  constructor() { this.type = 'FireSpin'; }

  initialize(particle, system) {
    if (!particle || !system?.userData?.ownerEffect) return;
    const params = system.userData.ownerEffect?.params || {};
    if (params.fireSpinEnabled === false) {
      particle._spinSpeed = 0;
      return;
    }
    const min = typeof params.fireSpinSpeedMin === 'number' ? params.fireSpinSpeedMin : 0.5;
    const maxBase = typeof params.fireSpinSpeedMax === 'number' ? params.fireSpinSpeedMax : 2.5;
    const max = Math.max(min, maxBase);
    const base = min + Math.random() * (max - min);
    const dir = Math.random() < 0.5 ? -1 : 1;
    particle._spinSpeed = base * dir * 3.0;
  }

  update(particle, delta) {
    if (!particle || typeof delta !== 'number') return;
    let dt = delta;
    if (!Number.isFinite(dt)) return;
    dt = Math.min(Math.max(dt, 0), 0.1);
    if (typeof particle._msTimeScaleFactor === 'number' && Number.isFinite(particle._msTimeScaleFactor)) {
      dt *= Math.max(0.0, particle._msTimeScaleFactor);
    }
    if (dt <= 0.0001) return;
    if (!Number.isFinite(particle._spinSpeed) || particle._spinSpeed === 0) return;
    const dAngle = particle._spinSpeed * dt;
    if (!Number.isFinite(dAngle)) return;
    if (typeof particle.rotation === 'number') {
      const next = particle.rotation + dAngle;
      if (Number.isFinite(next)) particle.rotation = next;
    } else if (particle.rotation && typeof particle.rotation.z === 'number') {
      const nextZ = particle.rotation.z + dAngle;
      if (Number.isFinite(nextZ)) particle.rotation.z = nextZ;
    }
  }

  frameUpdate(delta) {}
  reset() {}
  clone() { return new FireSpinBehavior(); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ParticleTimeScaledBehavior — Wraps another behavior with per-particle time scaling
// ═══════════════════════════════════════════════════════════════════════════════

export class ParticleTimeScaledBehavior {
  constructor(inner) {
    this.type = 'ParticleTimeScaled';
    this.inner = inner;
  }

  initialize(particle, system) {
    if (this.inner?.initialize) this.inner.initialize(particle, system);
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
      this.inner.update.length >= 3
        ? this.inner.update(particle, dt, system)
        : this.inner.update(particle, dt);
    }
  }

  frameUpdate(delta) { if (this.inner?.frameUpdate) this.inner.frameUpdate(delta); }
  reset() { if (this.inner?.reset) this.inner.reset(); }
  clone() {
    const innerClone = this.inner?.clone ? this.inner.clone() : this.inner;
    return new ParticleTimeScaledBehavior(innerClone);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// generateFirePoints — CPU mask scanning to build spawn point lists
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Scan a fire mask image on the CPU and collect bright pixels as (u, v, brightness)
 * triples packed into a Float32Array. This is the core "Lookup Map" technique.
 *
 * @param {HTMLImageElement|ImageBitmap} image - The _Fire mask image
 * @param {number} [threshold=0.1] - Minimum brightness to include
 * @returns {Float32Array|null} Packed (u, v, brightness) triples, or null if empty
 */
export function generateFirePoints(image, threshold = 0.1) {
  if (!image) return null;

  const c = document.createElement('canvas');
  c.width = image.width;
  c.height = image.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  const imgW = c.width;
  const imgH = c.height;

  const coords = [];
  for (let i = 0; i < data.length; i += 4) {
    const lum = Math.max(data[i], data[i + 1], data[i + 2]) / 255.0;
    const b = lum * (data[i + 3] / 255.0);
    if (b > threshold) {
      const idx = i / 4;
      const x = (idx % imgW) / imgW;
      const y = Math.floor(idx / imgW) / imgH;
      coords.push(x, y, b);
    }
  }

  if (coords.length === 0) return null;
  return new Float32Array(coords);
}
