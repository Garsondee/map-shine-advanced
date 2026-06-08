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
import { sceneWindField } from '../../core/SceneWindField.js';
import { LightingDirector } from '../../core/LightingDirector.js';
import { CurlNoiseField, Vector3 } from '../../libs/quarks.core.module.js';

// ═══════════════════════════════════════════════════════════════════════════════
// FixedCurlNoiseField — corrects three.quarks CurlNoiseField time integration
// ═══════════════════════════════════════════════════════════════════════════════
//
// Upstream CurlNoiseField advances `this.time` inside update(), but ParticleSystem
// calls update() once per alive particle per frame. That multiplies the noise
// animation speed (and effective turbulence) by particle count and makes the field
// unstable as density changes. Advance time once per frame in frameUpdate instead.

export class FixedCurlNoiseField extends CurlNoiseField {
  constructor(scale, strength, timeScale) {
    super(scale, strength, timeScale);
    this.type = 'FixedCurlNoiseField';
    this._tempV = new Vector3();
  }

  frameUpdate(delta) {
    let dt = delta;
    if (!Number.isFinite(dt)) return;
    dt = Math.min(Math.max(dt, 0), 0.1);
    this.time += dt * this.timeScale;
  }

  update(particle, delta) {
    if (!particle || !particle.position) return;
    if (readFlameMotionScale(particle) <= 0) return;

    const px = particle.position.x / this.scale.x;
    const py = particle.position.y / this.scale.y;
    const t = this.time;

    // FAST FAKE CURL: Replaces 4 expensive Simplex noise3D calls with layered trig.
    // Provides chaotic, swirly turbulence for a fraction of the CPU cost.
    const vx = (Math.sin(py * 2.13 + t) + Math.cos(py * 3.71 - t)) * 0.5 * this.strength.x;
    const vy = (Math.cos(px * 2.27 + t) + Math.sin(px * 3.43 - t)) * 0.5 * this.strength.y;
    const vz = Math.sin((px + py) * 1.77 + t) * this.strength.z;

    this._tempV.set(vx, vy, vz);

    let dt = delta > 0.1 ? 0.1 : (delta < 0 ? 0 : delta);
    particle.velocity.addScaledVector(this._tempV, dt);
  }

  reset() {
    this.time = 0;
  }

  clone() {
    return new FixedCurlNoiseField(this.scale.clone(), this.strength.clone(), this.timeScale);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FireForcesBehavior — single-pass wind + updraft + buoyancy + turbulence
// ═══════════════════════════════════════════════════════════════════════════════

/** @param {object|null|undefined} force */
function readApplyForceMagnitude(force) {
  if (!force?.magnitude) return 0;
  if (typeof force.magnitude.value === 'number' && Number.isFinite(force.magnitude.value)) {
    return force.magnitude.value;
  }
  if (typeof force.magnitudeValue === 'number' && Number.isFinite(force.magnitudeValue)) {
    return force.magnitudeValue;
  }
  return 0;
}

/**
 * Applies all motion forces in one particle pass (replaces SmartWind +
 * SmartUpdraft + ApplyForce + FixedCurlNoiseField behavior loops).
 *
 * @param {'flame'|'ember'|'smoke'} profile
 */
export class FireForcesBehavior {
  constructor(profile = 'flame') {
    this.type = 'FireForces';
    this.profile = profile;
    this._frameWind = { windSpeed: 0, windDirX: 0, windDirY: 0, hasWind: false };
    this._framePrecip = 0;
    this._tempV = new Vector3();
    /** @type {FixedCurlNoiseField|null} */
    this._turbulence = null;
  }

  /** @param {FixedCurlNoiseField|null} turb */
  bindTurbulence(turb) {
    this._turbulence = turb ?? null;
  }

  initialize(particle, system) {
    if (typeof particle._windSusceptibility !== 'number') {
      particle._windSusceptibility = 1.0;
    }
  }

  /** @private */
  _refreshFrameWind() {
    const cache = this._frameWind;
    cache.windSpeed = 0;
    cache.windDirX = 0;
    cache.windDirY = 0;
    cache.hasWind = false;

    let state;
    try {
      state = weatherController.getCurrentState();
    } catch (_) {
      return;
    }

    let windSpeed = 0;
    if (state && typeof state.windSpeedMS === 'number' && Number.isFinite(state.windSpeedMS)) {
      windSpeed = Math.max(0.0, Math.min(1.0, state.windSpeedMS / 78.0));
    } else if (state && typeof state.windSpeed === 'number' && Number.isFinite(state.windSpeed)) {
      windSpeed = Math.max(0.0, Math.min(1.0, state.windSpeed));
    }
    if (!Number.isFinite(windSpeed) || windSpeed <= 0.001) return;

    const windDir = state?.windDirection;
    if (!windDir || !Number.isFinite(windDir.x) || !Number.isFinite(windDir.y)) return;

    cache.windSpeed = windSpeed;
    cache.windDirX = windDir.x;
    // WeatherController wind is Foundry Y-down; particle sim uses THREE Y-up (matches wind sock).
    cache.windDirY = -windDir.y;
    cache.hasWind = true;
  }

  /** @private */
  _refreshFramePrecip() {
    let precip = 0;
    try {
      const state = (typeof weatherController?.getCurrentState === 'function')
        ? weatherController.getCurrentState()
        : (weatherController?.currentState ?? {});
      precip = state?.precipitation ?? 0;
    } catch (_) {
      precip = 0;
    }
    this._framePrecip = Number.isFinite(precip) ? precip : 0;
  }

  frameUpdate(delta) {
    let dt = delta;
    if (!Number.isFinite(dt)) return;
    dt = Math.min(Math.max(dt, 0), 0.1);
    this._refreshFrameWind();
    this._refreshFramePrecip();
    const turb = this._turbulence;
    if (turb) {
      turb.time += dt * (turb.timeScale ?? 1);
    }
  }

  /** @private */
  _rainUpdraftScale(particle, system) {
    const outdoor = Math.max(0, Math.min(1, particle._windSusceptibility ?? 1.0));
    if (outdoor <= 0.001) return 1.0;

    const precip = this._framePrecip;
    if (!Number.isFinite(precip) || precip <= 0.001) return 1.0;

    const owner = system?.userData?.ownerEffect;
    const precipKill = owner?.params?.weatherPrecipKill ?? 0.5;
    const damp = Math.min(1.0, outdoor * precip * precipKill * 1.75);
    return Math.max(0.05, 1.0 - damp);
  }

  /** @private */
  _applyWind(particle, dt, system) {
    if (!particle?.velocity) return;

    const isSmoke = this.profile === 'smoke' || !!(system?.userData?.isSmoke);
    let susceptibility = typeof particle._windSusceptibility === 'number'
      ? particle._windSusceptibility
      : 1.0;
    if (typeof particle._flameMotionScale === 'number' && Number.isFinite(particle._flameMotionScale)) {
      susceptibility *= Math.max(0, Math.min(1, particle._flameMotionScale));
    }
    if (!Number.isFinite(susceptibility) || susceptibility <= 0.001) return;

    const frameWind = this._frameWind;
    if (!frameWind.hasWind) {
      const decay = isSmoke ? 0.992 : 0.85;
      particle.velocity.x *= decay;
      particle.velocity.y *= decay;
      return;
    }

    let influence = 1.0;
    if (system?.userData && typeof system.userData.windInfluence === 'number') {
      influence = system.userData.windInfluence;
    }
    if (!Number.isFinite(influence)) influence = 1.0;

    if (influence <= 0.001) {
      particle.velocity.x *= 0.85;
      particle.velocity.y *= 0.85;
      return;
    }

    const smokeWindMul = isSmoke ? 0.42 : 1.0;
    const forceMag = frameWind.windSpeed * 300.0 * influence * susceptibility * smokeWindMul;
    if (!Number.isFinite(forceMag)) return;

    const dvx = frameWind.windDirX * forceMag * dt;
    const dvy = frameWind.windDirY * forceMag * dt;
    if (Number.isFinite(dvx) && Number.isFinite(dvy)) {
      particle.velocity.x += dvx;
      particle.velocity.y += dvy;
    }
  }

  /** @private */
  _applyUpdraft(particle, dt, system) {
    if (!particle?.velocity) return;

    const force = system?.userData?.updraftForce;
    const mag = readApplyForceMagnitude(force);
    if (!Number.isFinite(mag) || mag <= 0) return;

    let timeScale = 1.0;
    if (typeof particle._msTimeScaleFactor === 'number' && Number.isFinite(particle._msTimeScaleFactor)) {
      timeScale = Math.max(0.0, particle._msTimeScaleFactor);
    }

    const motionScale = (typeof particle._flameMotionScale === 'number' && Number.isFinite(particle._flameMotionScale))
      ? Math.max(0, Math.min(1, particle._flameMotionScale))
      : 1;
    const rainScale = this._rainUpdraftScale(particle, system);
    const scale = timeScale * rainScale * motionScale;
    if (scale <= 0.0001) return;

    const dir = force?.direction;
    if (dir) {
      particle.velocity.x += dir.x * mag * scale * dt;
      particle.velocity.y += dir.y * mag * scale * dt;
      particle.velocity.z += dir.z * mag * scale * dt;
    } else {
      particle.velocity.z += mag * scale * dt;
    }
  }

  /** @private */
  _applyRawBuoyancy(particle, dt, system) {
    if (this.profile === 'smoke') return;
    if (!particle?.velocity) return;

    const motionScale = readFlameMotionScale(particle);
    if (this.profile === 'flame' && motionScale <= 0) return;

    const force = system?.userData?.updraftForce;
    const mag = readApplyForceMagnitude(force);
    if (!Number.isFinite(mag) || mag <= 0) return;

    const dir = force?.direction;
    if (dir) {
      particle.velocity.x += dir.x * mag * dt;
      particle.velocity.y += dir.y * mag * dt;
      particle.velocity.z += dir.z * mag * dt;
    } else {
      particle.velocity.z += mag * dt;
    }
  }

  /** @private */
  _applyTurbulence(particle, dt, system) {
    if (!particle?.position || !particle?.velocity) return;

    const motionScale = readFlameMotionScale(particle);
    if (this.profile === 'flame' && motionScale <= 0) return;

    let turbDt = dt;
    if (this.profile !== 'flame') {
      const ts = particle._msTimeScaleFactor;
      if (ts !== undefined) turbDt *= (ts > 0 ? ts : 0);
      if (turbDt <= 0.0001) return;
    }

    const turb = system?.userData?.turbulence ?? this._turbulence;
    if (!turb?.scale || !turb?.strength) return;

    const px = particle.position.x / turb.scale.x;
    const py = particle.position.y / turb.scale.y;
    const t = turb.time;

    const vx = (Math.sin(py * 2.13 + t) + Math.cos(py * 3.71 - t)) * 0.5 * turb.strength.x;
    const vy = (Math.cos(px * 2.27 + t) + Math.sin(px * 3.43 - t)) * 0.5 * turb.strength.y;
    const vz = Math.sin((px + py) * 1.77 + t) * turb.strength.z;

    this._tempV.set(vx, vy, vz);
    particle.velocity.addScaledVector(this._tempV, turbDt);
  }

  update(particle, delta, system) {
    if (!particle || typeof delta !== 'number') return;

    let dt = delta;
    if (!Number.isFinite(dt)) return;
    dt = Math.min(Math.max(dt, 0), 0.1);
    if (dt <= 0.0001) return;

    this._applyWind(particle, dt, system);
    if (this.profile !== 'smoke') {
      this._applyRawBuoyancy(particle, dt, system);
    }
    this._applyUpdraft(particle, dt, system);
    this._applyTurbulence(particle, dt, system);
  }

  reset() {
    if (this._turbulence) this._turbulence.time = 0;
  }

  clone() {
    const next = new FireForcesBehavior(this.profile);
    if (this._turbulence) {
      next.bindTurbulence(this._turbulence.clone());
    }
    return next;
  }
}

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

/**
 * Linear-HDR pipeline compensation (Lighting Phase 0). Scene light is unclamped now;
 * fire vertex RGB must sit above night ambient to bloom and read as hot flame.
 */
export const FIRE_HDR_LINEAR_GAIN = 2.75;

/** Smoke emission tint scale vs flame (diffuse body stays subdued). */
export const FIRE_SMOKE_HDR_EMISSION_GAIN = 1.35;

/** @returns {number} HDR multiplier from pipeline gain × day/night HDR brightness (0–5 UI → 0–1). */
function resolveFireHdrMultiplier(ownerEffect) {
  const p = ownerEffect?.params;
  const dayRaw = Number(p?.lightIntensity);
  const nightRaw = Number(p?.nightHdrBrightness);
  const dayGain = Number.isFinite(dayRaw) && dayRaw > 0 ? dayRaw / 5.0 : 1.0;
  const nightGain = Number.isFinite(nightRaw) && nightRaw > 0 ? nightRaw / 5.0 : dayGain;

  let darkness = 0;
  try {
    darkness = clamp01(LightingDirector.get().masterDarkness);
  } catch (_) {}

  const userGain = dayGain + (nightGain - dayGain) * darkness;
  return FIRE_HDR_LINEAR_GAIN * userGain;
}

// HDR emission multiplier curve — drives bloom.
export const FLAME_EMISSION_STOPS = [
  { t: 0.00, v: 0.0 },
  { t: 0.12, v: 4.0 },
  { t: 0.15, v: 3.2 },
  { t: 0.35, v: 2.0 },
  { t: 0.55, v: 1.0 },
  { t: 0.70, v: 0.35 },
  { t: 1.00, v: 0.00 },
];

// Alpha envelope for flames.
export const FLAME_ALPHA_STOPS = [
  { t: 0.00, v: 1.00 },
  { t: 0.50, v: 0.92 },
  { t: 0.70, v: 0.55 },
  { t: 1.00, v: 0.85 },
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
  { t: 0.00, v: 0.0 },
  { t: 0.12, v: 5.0 },
  { t: 0.15, v: 3.5 },
  { t: 0.30, v: 1.8 },
  { t: 0.60, v: 0.55 },
  { t: 1.00, v: 0.0 },
];

export const EMBER_ALPHA_STOPS = [
  { t: 0.00, v: 1.00 },
  { t: 0.55, v: 0.88 },
  { t: 0.80, v: 0.45 },
  { t: 1.00, v: 0.70 },
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
const _smokeEmissionTemp = { r: 0, g: 0, b: 0 };

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Compact signature for gradient stop arrays (LUT dirty detection). */
function gradientStopSignature(stops) {
  if (!stops || stops.length === 0) return '';
  let sig = '';
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    sig += `${s.t}|${s.r}|${s.g}|${s.b};`;
  }
  return sig;
}

/**
 * Age used for flipbook / colour envelopes. Between physics steps FireEffectV2
 * extrapolates `_msDisplayAge` so sprite animation stays smooth at low fireSimHz.
 * @param {object|null|undefined} particle
 * @returns {number}
 */
export function resolveParticleDisplayAge(particle) {
  return particle._msDisplayAge !== undefined ? particle._msDisplayAge : particle.age;
}

function smoothstep01(x) {
  const u = x < 0 ? 0 : x > 1 ? 1 : x;
  return u * u * (3.0 - 2.0 * u);
}

/** @returns {number} 0→1→0 fade over normalized life; fractions are span at birth/death. */
function particleSpawnDeathFade(t, fadeIn = 0.14, fadeOut = 0.16) {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  if (u <= 0) return 0;
  if (u >= 1) return 0;
  const inSpan = Math.max(1e-4, fadeIn);
  const outSpan = Math.max(1e-4, fadeOut);
  if (u < inSpan) return smoothstep01(u / inSpan);
  if (u > 1 - outSpan) return smoothstep01((1 - u) / outSpan);
  return 1;
}

/** Hide particle until lifecycle/size behaviors run on the first frame. */
function zeroParticleVisual(particle) {
  if (!particle) return;
  if (particle.color) {
    particle.color.x = 0;
    particle.color.y = 0;
    particle.color.z = 0;
    particle.color.w = 0;
  }
  if (typeof particle.size === 'number') {
    particle.size = 0;
  } else if (particle.size?.set) {
    particle.size.set(0, 0, 0);
  }
}

function finiteOr(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Normalize arbitrary stop arrays into safe color stops [{t,r,g,b}, ...].
 * Supports legacy scalar stops {t,v} by converting to grayscale {r:g:b=v}.
 */
function normalizeColorStops(stops) {
  if (!Array.isArray(stops) || stops.length < 2) return null;

  const total = stops.length;
  const normalized = [];
  for (let i = 0; i < total; i++) {
    const s = stops[i];
    if (!s || typeof s !== 'object') continue;
    const fallbackT = total <= 1 ? 0 : i / Math.max(1, total - 1);
    const t = clamp01(finiteOr(s.t, fallbackT));

    if (Number.isFinite(s.r) || Number.isFinite(s.g) || Number.isFinite(s.b)) {
      normalized.push({
        t,
        r: clamp01(finiteOr(s.r, 0)),
        g: clamp01(finiteOr(s.g, 0)),
        b: clamp01(finiteOr(s.b, 0)),
      });
      continue;
    }

    if (Number.isFinite(s.v)) {
      const v = clamp01(s.v);
      normalized.push({ t, r: v, g: v, b: v });
    }
  }

  if (normalized.length < 2) return null;
  normalized.sort((a, b) => a.t - b.t);
  return normalized;
}

/**
 * Lerp a color stop array [{t,r,g,b}, ...] returning {r,g,b}.
 * Uses the provided temp object to avoid allocation.
 */
function lerpColorStops(stops, t, temp) {
  if (!stops || stops.length === 0) {
    temp.r = 1; temp.g = 1; temp.b = 1;
    return temp;
  }
  if (t <= stops[0].t) {
    temp.r = stops[0].r; temp.g = stops[0].g; temp.b = stops[0].b;
    return temp;
  }
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

    const params = this.ownerEffect?.params;

    // Indoor smoke / ember density scales (re-read each frame in lifecycle behaviors too).
    p._indoorSmokeScale = computeIndoorSuppressionScale(params?.indoorSmokeSuppression, outdoorFactor);
    p._indoorEmberScale = computeIndoorSuppressionScale(params?.indoorEmberSuppression, outdoorFactor);

    // Indoor time scaling.
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
      let spatialWind = wind;
      try {
        if (sceneWindField?.params?.enabled !== false) {
          spatialWind *= sceneWindField.getSampleWorld(0, 0).spatial01;
        }
      } catch (_) {}
      const weatherStress = 0.5 * (precip * precipKill + spatialWind * windKill) * outdoorFactor;
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

    zeroParticleVisual(p);

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
    this._hdrGain = FIRE_HDR_LINEAR_GAIN;
    this._temperature = 0.5;
    this._minBrightness = 0.75;
    this._colorLUT = new Float32Array(256 * 3);
    this._emissionLUT = new Float32Array(256);
    this._alphaLUT = new Float32Array(256);
    this._lutDirty = true;
  }

  initialize(particle) {
    particle._flameHeat = 0.7 + Math.random() * 0.5;
    if (particle._flameBrightness === undefined) particle._flameBrightness = 1.0;
    const stationaryFrac = Math.max(
      0,
      Math.min(1, Number(this.ownerEffect?.params?.flameStationaryFraction ?? 0.5))
    );
    particle._flameMotionScale = Math.random() < stationaryFrac ? 0 : 1;
    zeroParticleVisual(particle);
  }

  update(particle, delta) {
    const life = particle.life;
    if (life <= 0) return;
    let age = particle._msDisplayAge;
    if (age === undefined) age = particle.age;
    let t = age / (life > 0.001 ? life : 0.001);
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const idx = (t * 255) | 0;

    const heat = particle._flameHeat ?? 1.0;
    const fb = particle._flameBrightness;
    const brightness = fb !== undefined
      ? (fb < this._minBrightness ? this._minBrightness : fb)
      : this._minBrightness;

    const emission = this._emissionLUT[idx] * heat * brightness;
    const alpha = this._alphaLUT[idx] * brightness;
    const ci = idx * 3;
    particle.color.x = this._colorLUT[ci] * emission;
    particle.color.y = this._colorLUT[ci + 1] * emission;
    particle.color.z = this._colorLUT[ci + 2] * emission;
    particle.color.w = alpha;
  }

  frameUpdate(delta) {
    const p = this.ownerEffect?.params;
    const nextEmission = p?.coreEmission ?? 4.5;
    const nextHdr = resolveFireHdrMultiplier(this.ownerEffect);
    const nextPeak = p?.flamePeakOpacity ?? 0.9;
    const nextTemp = p?.fireTemperature ?? 0.5;
    this._minBrightness = Math.max(0.0, p?.flameBrightnessFloor ?? 0.75);

    if (nextEmission !== this._emissionScale ||
        nextHdr !== this._hdrGain ||
        nextPeak !== this._peakOpacity ||
        nextTemp !== this._temperature) {
      this._lutDirty = true;
    }

    this._emissionScale = nextEmission;
    this._hdrGain = nextHdr;
    this._peakOpacity = nextPeak;
    if (nextTemp !== this._temperature) {
      this._updateGradientsForTemperature(nextTemp);
    }
    this._temperature = nextTemp;

    if (this._lutDirty) {
      this._rebuildLUTs();
      this._lutDirty = false;
    }
  }

  _rebuildLUTs() {
    const colorLUT = this._colorLUT;
    const emissionLUT = this._emissionLUT;
    const alphaLUT = this._alphaLUT;
    const emissionScale = this._emissionScale;
    const hdrGain = this._hdrGain;
    const peakOpacity = this._peakOpacity;

    for (let idx = 0; idx < 256; idx++) {
      const t = idx / 255;
      const lifeFade = particleSpawnDeathFade(t, 0.14, 0.16);
      const color = lerpColorStops(this._colorStops, t, _flameColorTemp);
      const ci = idx * 3;
      colorLUT[ci] = color.r;
      colorLUT[ci + 1] = color.g;
      colorLUT[ci + 2] = color.b;
      emissionLUT[idx] = lerpScalarStops(FLAME_EMISSION_STOPS, t) * emissionScale * hdrGain * lifeFade;
      alphaLUT[idx] = lerpScalarStops(FLAME_ALPHA_STOPS, t) * peakOpacity * lifeFade;
    }
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
    this._hdrGain = FIRE_HDR_LINEAR_GAIN;
    this._peakOpacity = 1.0;
    this._temperature = 0.5;
    this._colorLUT = new Float32Array(256 * 3);
    this._emissionLUT = new Float32Array(256);
    this._alphaLUT = new Float32Array(256);
    this._lutDirty = true;
  }

  initialize(particle) {
    particle._emberHeat = 0.85 + Math.random() * 0.30;
    if (particle._flameBrightness === undefined) particle._flameBrightness = 1.0;

    const params = this.ownerEffect?.params;
    let outdoorFactor = particle._windSusceptibility;
    if (!Number.isFinite(outdoorFactor)) outdoorFactor = 1.0;
    outdoorFactor = clamp01(outdoorFactor);

    const indoorScale = computeIndoorSuppressionScale(params?.indoorEmberSuppression, outdoorFactor);
    if (indoorScale <= 0.001) {
      if (typeof particle.life === 'number') particle.life = 0;
      zeroParticleVisual(particle);
      return;
    }

    if (typeof particle.life === 'number') {
      const lifeScale = Math.max(0.05, Math.min(1.0, params?.indoorEmberLifeScale ?? 1.0));
      particle.life *= lifeScale + (1.0 - lifeScale) * outdoorFactor;
    }

    zeroParticleVisual(particle);
  }

  update(particle, delta) {
    const life = particle.life;
    if (life <= 0) return;
    let age = particle._msDisplayAge;
    if (age === undefined) age = particle.age;
    let t = age / (life > 0.001 ? life : 0.001);
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const idx = (t * 255) | 0;

    const heat = particle._emberHeat ?? 1.0;
    const fb = particle._flameBrightness;
    const brightness = fb !== undefined ? (fb < 0.3 ? 0.3 : fb) : 1.0;

    const params = this.ownerEffect?.params;
    let outdoorFactor = particle._windSusceptibility;
    if (!Number.isFinite(outdoorFactor)) outdoorFactor = 1.0;
    const indoorScale = computeIndoorSuppressionScale(params?.indoorEmberSuppression, outdoorFactor);

    const emission = this._emissionLUT[idx] * heat * brightness * indoorScale;
    const alpha = this._alphaLUT[idx] * brightness * indoorScale;
    const ci = idx * 3;
    particle.color.x = this._colorLUT[ci] * emission;
    particle.color.y = this._colorLUT[ci + 1] * emission;
    particle.color.z = this._colorLUT[ci + 2] * emission;
    particle.color.w = alpha;
  }

  frameUpdate(delta) {
    const p = this.ownerEffect?.params;
    const nextEmission = p?.emberEmission ?? 5.0;
    const nextHdr = resolveFireHdrMultiplier(this.ownerEffect);
    const nextPeak = p?.emberPeakOpacity ?? 0.9;
    const nextTemp = p?.fireTemperature ?? 0.5;

    if (nextEmission !== this._emissionScale ||
        nextHdr !== this._hdrGain ||
        nextPeak !== this._peakOpacity ||
        nextTemp !== this._temperature) {
      this._lutDirty = true;
    }

    this._emissionScale = nextEmission;
    this._hdrGain = nextHdr;
    this._peakOpacity = nextPeak;
    if (nextTemp !== this._temperature) {
      this._updateGradientsForTemperature(nextTemp);
    }
    this._temperature = nextTemp;

    if (this._lutDirty) {
      this._rebuildLUTs();
      this._lutDirty = false;
    }
  }

  _rebuildLUTs() {
    const colorLUT = this._colorLUT;
    const emissionLUT = this._emissionLUT;
    const alphaLUT = this._alphaLUT;
    const emissionScale = this._emissionScale;
    const hdrGain = this._hdrGain;
    const peakOpacity = this._peakOpacity;

    for (let idx = 0; idx < 256; idx++) {
      const t = idx / 255;
      const lifeFade = particleSpawnDeathFade(t, 0.16, 0.20);
      const color = lerpColorStops(this._colorStops, t, _emberColorTemp);
      const ci = idx * 3;
      colorLUT[ci] = color.r;
      colorLUT[ci + 1] = color.g;
      colorLUT[ci + 2] = color.b;
      emissionLUT[idx] = lerpScalarStops(EMBER_EMISSION_STOPS, t) * emissionScale * hdrGain * lifeFade;
      alphaLUT[idx] = lerpScalarStops(EMBER_ALPHA_STOPS, t) * peakOpacity * lifeFade;
    }
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
// SmokeLifecycleBehavior — smoke color/alpha/size over life (material uses NormalBlending;
// diffuse RGB stays ≤1; emission tint is linear HDR so hot smoke can bloom at night).
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
    // Cached gradient references (color stops {t,r,g,b}) updated each frameUpdate.
    // When null the legacy COOL/WARM warmth blend is used.
    // Emission uses same format: black = no glow, any colour = additive emission.
    this._colorGradient = null;
    this._emissionGradient = null;
    this._smokeEmissionHdr = FIRE_SMOKE_HDR_EMISSION_GAIN * FIRE_HDR_LINEAR_GAIN;
    this._colorLUT = new Float32Array(256 * 3);
    this._alphaLUT = new Float32Array(256);
    this._sizeLUT = new Float32Array(256);
    this._lutSignature = '';
    this._lutDirty = true;
  }

  initialize(particle) {
    const brightness = particle._flameBrightness ?? 1.0;
    // Softer than 0.5× so bright-mask spawns stay readable as smoke, not paper-thin.
    particle._smokeDensity = Math.max(0.65, 1.0 - brightness * 0.28);
    particle._smokeStartSize = particle.size;
    // Lift slightly above the fire plane so smoke reads above ground art (top-down view).
    if (particle.position && typeof particle.position.z === 'number') {
      particle.position.z += 12 + Math.random() * 18;
    }
  }

  update(particle, delta) {
    const life = particle.life;
    if (life <= 0) return;
    let age = particle._msDisplayAge;
    if (age === undefined) age = particle.age;
    let t = age / (life > 0.001 ? life : 0.001);
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const idx = (t * 255) | 0;

    const density = particle._smokeDensity ?? 0.75;
    const params = this.ownerEffect?.params;
    let outdoorFactor = particle._windSusceptibility;
    if (!Number.isFinite(outdoorFactor)) outdoorFactor = 1.0;
    const indoorSmoke = computeIndoorSuppressionScale(params?.indoorSmokeSuppression, outdoorFactor);

    const ci = idx * 3;
    particle.color.x = this._colorLUT[ci];
    particle.color.y = this._colorLUT[ci + 1];
    particle.color.z = this._colorLUT[ci + 2];
    particle.color.w = this._alphaLUT[idx] * density * indoorSmoke;

    const startSize = particle._smokeStartSize;
    if (startSize > 0) {
      particle.size = startSize * this._sizeLUT[idx];
    }
  }

  frameUpdate(delta) {
    const p = this.ownerEffect?.params;
    this._smokeOpacity = Math.max(0.0, Math.min(1.0, p?.smokeOpacity ?? 0.6));
    this._colorWarmth = Math.max(0.0, Math.min(1.0, p?.smokeColorWarmth ?? 0.4));
    this._colorBrightness = Math.max(0.01, p?.smokeColorBrightness ?? 0.45);
    this._sizeGrowth = Math.max(1.0, p?.smokeSizeOverLife ?? p?.smokeSizeGrowth ?? 4.0);
    this._alphaStart = Math.max(0.0, Math.min(1.0, p?.smokeAlphaStart ?? 0.0));
    let peak = Math.max(0.0, Math.min(1.0, p?.smokeAlphaPeak ?? 0.75));
    let end = Math.max(0.0, Math.min(1.0, p?.smokeAlphaEnd ?? 1.0));
    peak = Math.max(this._alphaStart, peak);
    // If "fade end" is left of peak on the timeline, treat end as the opacity cutoff
    // and pull peak back instead of silently bumping end upward.
    if (end < peak) peak = end;
    this._alphaPeak = peak;
    this._alphaEnd = Math.max(peak, end);

    const darknessResponse = Math.max(0.0, Math.min(1.0, p?.smokeDarknessResponse ?? 0.8));
    const envState = weatherController._environmentState;
    const sceneDarkness = envState?.sceneDarkness ?? 0.0;
    this._darknessFactor = 1.0 - sceneDarkness * darknessResponse * 0.85;

    const precip = weatherController.currentState?.precipitation || 0;
    this._precipMult = Math.max(0.2, 1.0 - precip * 0.5);

    this._colorGradient = normalizeColorStops(p?.smokeColorGradient);
    this._emissionGradient = normalizeColorStops(p?.smokeEmissionGradient);
    this._smokeEmissionHdr = FIRE_SMOKE_HDR_EMISSION_GAIN * resolveFireHdrMultiplier(this.ownerEffect);

    const nextSig = [
      this._smokeOpacity,
      this._colorWarmth,
      this._colorBrightness,
      this._darknessFactor,
      this._sizeGrowth,
      this._alphaStart,
      this._alphaPeak,
      this._alphaEnd,
      this._precipMult,
      this._smokeEmissionHdr,
      gradientStopSignature(this._colorGradient),
      gradientStopSignature(this._emissionGradient),
    ].join('\x00');

    if (nextSig !== this._lutSignature) {
      this._lutSignature = nextSig;
      this._lutDirty = true;
    }

    if (this._lutDirty) {
      this._rebuildLUTs();
      this._lutDirty = false;
    }
  }

  _rebuildLUTs() {
    const colorLUT = this._colorLUT;
    const alphaLUT = this._alphaLUT;
    const sizeLUT = this._sizeLUT;
    const brightDark = this._colorBrightness * this._darknessFactor;
    const emHdr = this._smokeEmissionHdr;
    const aStart = this._alphaStart;
    const aPeak = this._alphaPeak;
    const aEnd = this._alphaEnd;
    const sizeGrowth = this._sizeGrowth;
    const colorWarmth = this._colorWarmth;
    const colorGradient = this._colorGradient;
    const emissionGradient = this._emissionGradient;
    const smokeOpacity = this._smokeOpacity;
    const precipMult = this._precipMult;

    for (let idx = 0; idx < 256; idx++) {
      const t = idx / 255;

      let baseR, baseG, baseB;
      if (colorGradient) {
        const gc = lerpColorStops(colorGradient, t, _smokeColorTemp);
        baseR = gc.r;
        baseG = gc.g;
        baseB = gc.b;
      } else {
        const coolColor = lerpColorStops(SMOKE_COLOR_COOL, t, _smokeColorTemp);
        const warmColor = lerpColorStops(SMOKE_COLOR_WARM, t, _smokeColorTemp2);
        const w = colorWarmth;
        baseR = coolColor.r + (warmColor.r - coolColor.r) * w;
        baseG = coolColor.g + (warmColor.g - coolColor.g) * w;
        baseB = coolColor.b + (warmColor.b - coolColor.b) * w;
      }

      let emissionR = 0, emissionG = 0, emissionB = 0;
      if (emissionGradient) {
        const em = lerpColorStops(emissionGradient, t, _smokeEmissionTemp);
        emissionR = em.r * emHdr;
        emissionG = em.g * emHdr;
        emissionB = em.b * emHdr;
      }

      const ci = idx * 3;
      colorLUT[ci] = clamp01(baseR * brightDark) + emissionR;
      colorLUT[ci + 1] = clamp01(baseG * brightDark) + emissionG;
      colorLUT[ci + 2] = clamp01(baseB * brightDark) + emissionB;

      let alphaEnv = 0.0;
      if (t > aStart && t < aEnd) {
        if (t < aPeak) {
          const rampT = (t - aStart) / Math.max(1e-5, aPeak - aStart);
          alphaEnv = smoothstep01(rampT);
        } else {
          const fadeT = (t - aPeak) / Math.max(1e-5, aEnd - aPeak);
          alphaEnv = 1.0 - smoothstep01(fadeT);
        }
      }
      alphaLUT[idx] = alphaEnv * smokeOpacity * precipMult;

      const st = t * t * (3.0 - 2.0 * t);
      sizeLUT[idx] = 1.0 + (sizeGrowth - 1.0) * st;
    }
  }

  reset() {}
  clone() { return new SmokeLifecycleBehavior(this.ownerEffect); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FlameShapeFrameBehavior — random shape row + animate within that row only
// ═══════════════════════════════════════════════════════════════════════════════
//
// Fire atlas layout: rows = shape archetypes, cols = animation frames.
// FrameOverLife drives absolute tile 0..N and ignores startTileIndex, so every
// particle cycled the full atlas. This behavior picks one shape row at spawn and
// advances only across that row's animation frames.

export class FlameShapeFrameBehavior {
  /**
   * @param {number} [shapeCount=4] Atlas rows — distinct silhouette families.
   * @param {number} [animFrames=4] Atlas cols — flicker frames per shape.
   * @param {{ ownerEffect?: object, cyclesParamKey?: string, defaultCycles?: number }} [options]
   */
  constructor(shapeCount = 4, animFrames = 4, options = {}) {
    this.shapeCount = Math.max(1, shapeCount | 0);
    this.animFrames = Math.max(1, animFrames | 0);
    this.ownerEffect = options.ownerEffect ?? null;
    this.cyclesParamKey = options.cyclesParamKey ?? 'flameFlipbookCycles';
    this.defaultCycles = Math.max(0.1, Number(options.defaultCycles) || 2);
    this.type = 'FlameShapeFrameBehavior';
    this._cachedCycles = this.defaultCycles;
  }

  /** @private */
  _resolveCycles() {
    const raw = this.ownerEffect?.params?.[this.cyclesParamKey];
    const cycles = typeof raw === 'number' && Number.isFinite(raw) ? raw : this.defaultCycles;
    return Math.max(0.1, cycles);
  }

  initialize(particle) {
    if (!particle) return;
    particle._flameShapeRow = Math.floor(Math.random() * this.shapeCount);
    particle._flameAnimOffset = Math.floor(Math.random() * this.animFrames);
    this._applyTile(particle, particle._flameAnimOffset);
  }

  update(particle, delta) {
    if (!particle) return;
    const life = particle.life;
    if (!Number.isFinite(life) || life <= 0) return;
    let age = particle._msDisplayAge;
    if (age === undefined) age = particle.age;
    const t = age < 0 ? 0 : age > life ? 1 : age / life;
    const cycles = this._cachedCycles;
    const offset = particle._flameAnimOffset ?? 0;
    const loopT = ((t * cycles * this.animFrames) + offset) % this.animFrames;
    this._applyTile(particle, loopT);
  }

  /**
   * Set fractional uvTile within one atlas row for tile blending.
   * @param {object} particle
   * @param {number} loopT Continuous column index in [0, animFrames).
   * @private
   */
  _applyTile(particle, loopT) {
    const row = particle._flameShapeRow ?? 0;
    let colBase = loopT | 0;
    let frac = loopT - colBase;
    if (colBase >= this.animFrames - 1) {
      colBase = this.animFrames - 1;
      frac = 0;
    }
    particle.uvTile = row * this.animFrames + colBase + frac;
  }

  frameUpdate() {
    this._cachedCycles = this._resolveCycles();
  }
  reset() {}
  clone() {
    return new FlameShapeFrameBehavior(this.shapeCount, this.animFrames, {
      ownerEffect: this.ownerEffect,
      cyclesParamKey: this.cyclesParamKey,
      defaultCycles: this.defaultCycles,
    });
  }
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
    if (!particle) return;
    let dt = delta > 0.1 ? 0.1 : (delta < 0 ? 0 : delta);
    const ts = particle._msTimeScaleFactor;
    if (ts !== undefined) dt *= (ts > 0 ? ts : 0);
    if (dt <= 0.0001) return;
    const spinSpeed = particle._spinSpeed;
    if (!spinSpeed) return;
    const dAngle = spinSpeed * dt;
    if (typeof particle.rotation === 'number') {
      particle.rotation += dAngle;
    } else if (particle.rotation && typeof particle.rotation.z === 'number') {
      particle.rotation.z += dAngle;
    }
  }

  frameUpdate(delta) {}
  reset() {}
  clone() { return new FireSpinBehavior(); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DeferredVisualBehavior — skip cosmetic updates during the physics step
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Wraps a visual-only behavior so `update()` no-ops while `system._msDeferVisualToRefresh`
 * is true (during ParticleSystem.update). FireEffectV2 re-applies visuals in
 * `_refreshFireVisuals()` with defer cleared.
 */
export class DeferredVisualBehavior {
  constructor(inner) {
    this.inner = inner;
    this.type = inner?.type ?? 'DeferredVisual';
  }

  initialize(particle, system) {
    if (this.inner?.initialize) this.inner.initialize(particle, system);
  }

  update(particle, delta, system) {
    if (system?._msDeferVisualToRefresh) return;
    if (!this.inner || typeof this.inner.update !== 'function') return;
    if (this.inner.update.length >= 3) {
      this.inner.update(particle, delta, system);
    } else if (this.inner.update.length >= 2) {
      this.inner.update(particle, delta);
    } else {
      this.inner.update(particle);
    }
  }

  frameUpdate(delta) {
    if (this.inner?.frameUpdate) this.inner.frameUpdate(delta);
  }

  reset() {
    if (this.inner?.reset) this.inner.reset();
  }

  clone() {
    const innerClone = this.inner?.clone ? this.inner.clone() : this.inner;
    return new DeferredVisualBehavior(innerClone);
  }
}

/**
 * Wrap behaviors whose types appear in `visualTypes` with {@link DeferredVisualBehavior}.
 * @param {object|null|undefined} system
 * @param {Set<string>} visualTypes
 */
export function deferVisualBehaviorsOnSystem(system, visualTypes) {
  if (!system?.behaviors?.length || !visualTypes?.size) return;
  for (let j = 0; j < system.behaviors.length; j++) {
    const beh = system.behaviors[j];
    if (visualTypes.has(beh.type)) {
      system.behaviors[j] = new DeferredVisualBehavior(beh);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Per-particle flame motion — anchored flames skip drift forces
// ═══════════════════════════════════════════════════════════════════════════════

/** @param {object|null|undefined} particle */
export function readFlameMotionScale(particle) {
  const s = particle?._flameMotionScale;
  return s !== undefined ? (s < 0 ? 0 : s > 1 ? 1 : s) : 1;
}

export class ParticleMotionGatedBehavior {
  constructor(inner) {
    this.type = 'ParticleMotionGated';
    this.inner = inner;
  }

  initialize(particle, system) {
    if (this.inner?.initialize) this.inner.initialize(particle, system);
  }

  update(particle, delta, system) {
    if (readFlameMotionScale(particle) <= 0) return;
    if (!this.inner || typeof delta !== 'number') return;
    if (typeof this.inner.update === 'function') {
      this.inner.update.length >= 3
        ? this.inner.update(particle, delta, system)
        : this.inner.update(particle, delta);
    }
  }

  frameUpdate(delta) {
    if (this.inner?.frameUpdate) this.inner.frameUpdate(delta);
  }

  reset() {
    if (this.inner?.reset) this.inner.reset();
  }

  clone() {
    const innerClone = this.inner?.clone ? this.inner.clone() : this.inner;
    return new ParticleMotionGatedBehavior(innerClone);
  }
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
    if (!this.inner) return;
    let dt = delta > 0.1 ? 0.1 : (delta < 0 ? 0 : delta);
    const ts = particle._msTimeScaleFactor;
    if (ts !== undefined) dt *= (ts > 0 ? ts : 0);
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
 * @param {HTMLImageElement|ImageBitmap} image
 * @returns {{ data: Uint8ClampedArray, width: number, height: number }|null}
 */
function readImageRgba(image) {
  if (!image?.width || !image?.height) return null;
  const c = document.createElement('canvas');
  c.width = image.width;
  c.height = image.height;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  return { data: img.data, width: c.width, height: c.height };
}

/**
 * @typedef {object} FireMaskScanOptions
 * @property {number} [threshold=0.1] - Minimum premultiplied brightness (lum × alpha)
 * @property {number} [minMaskAlpha=0.35] - Drop mask texels below this alpha
 * @property {number} [minMaskBrightness=0] - Require max(R,G,B) luminance in the _Fire mask
 */

/**
 * Scan a fire mask image on the CPU and collect bright pixels as (u, v, brightness)
 * triples packed into a Float32Array. This is the core "Lookup Map" technique.
 *
 * @param {HTMLImageElement|ImageBitmap} image - The _Fire mask image
 * @param {number|FireMaskScanOptions} [thresholdOrOptions=0.1]
 * @param {number} [minMaskAlpha=0.35] - Legacy positional min alpha when 2nd arg is numeric
 * @returns {Float32Array|null} Packed (u, v, brightness) triples, or null if empty
 */
export function generateFirePoints(image, thresholdOrOptions = 0.1, minMaskAlpha = 0.35) {
  if (!image) return null;

  /** @type {FireMaskScanOptions} */
  let opts = {
    threshold: 0.1,
    minMaskAlpha: 0.35,
    minMaskBrightness: 0,
  };
  if (thresholdOrOptions && typeof thresholdOrOptions === 'object') {
    opts = {
      threshold: Number(thresholdOrOptions.threshold ?? 0.1),
      minMaskAlpha: Number(thresholdOrOptions.minMaskAlpha ?? 0.35),
      minMaskBrightness: Number(thresholdOrOptions.minMaskBrightness ?? 0),
    };
  } else {
    opts.threshold = Number(thresholdOrOptions ?? 0.1);
    opts.minMaskAlpha = Number(minMaskAlpha ?? 0.35);
  }

  const rgba = readImageRgba(image);
  if (!rgba) return null;
  const { data, width: imgW, height: imgH } = rgba;
  const minAlpha255 = Math.max(0, Math.min(255, Math.round(clamp01(opts.minMaskAlpha) * 255)));
  const minLum = clamp01(Number(opts.minMaskBrightness) || 0);
  const premulThreshold = Math.max(0, Number(opts.threshold) || 0);

  const coords = [];
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < minAlpha255) continue;
    const lum = Math.max(data[i], data[i + 1], data[i + 2]) / 255.0;
    if (lum < minLum) continue;
    const b = lum * (a / 255.0);
    if (b > premulThreshold) {
      const idx = i / 4;
      const x = (idx % imgW) / imgW;
      const y = Math.floor(idx / imgW) / imgH;
      coords.push(x, y, b);
    }
  }

  if (coords.length === 0) return null;
  return new Float32Array(coords);
}

/**
 * Drop fire spawn points where the companion albedo image is transparent.
 * Prevents glow/particles on WebP hole edges and upper-floor alpha fringes.
 *
 * @param {Float32Array|null} points - Packed (u, v, brightness) in albedo image UV space
 * @param {HTMLImageElement|ImageBitmap|null} albedoImage - Tile or background colour texture
 * @param {number} [minAlbedoAlpha=0.5] - Minimum authored alpha required to keep a point
 * @returns {Float32Array|null}
 */
export function filterFirePointsByAlbedoAlpha(points, albedoImage, minAlbedoAlpha = 0.5) {
  if (!points || points.length < 3) return points ?? null;
  if (!albedoImage) return points;

  const rgba = readImageRgba(albedoImage);
  if (!rgba) return points;

  const { data, width: w, height: h } = rgba;
  const minAlpha255 = Math.max(0, Math.min(255, Math.round(clamp01(minAlbedoAlpha) * 255)));
  const out = [];

  for (let i = 0; i < points.length; i += 3) {
    const u = points[i];
    const v = points[i + 1];
    if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
    const px = Math.min(w - 1, Math.max(0, Math.floor(u * w)));
    const py = Math.min(h - 1, Math.max(0, Math.floor(v * h)));
    const o = (py * w + px) * 4;
    if (data[o + 3] >= minAlpha255) {
      out.push(points[i], points[i + 1], points[i + 2]);
    }
  }

  return out.length >= 3 ? new Float32Array(out) : null;
}

/**
 * Drop isolated fire-mask specks with no neighbour within `minDistPx` (mask pixels).
 * @param {Float32Array|null} points
 * @param {number} imgW
 * @param {number} imgH
 * @param {number} [minDistPx=0] - 0 disables
 * @returns {Float32Array|null}
 */
export function filterFirePointsRequireNeighbor(points, imgW, imgH, minDistPx = 0) {
  if (!points || points.length < 3) return points ?? null;
  const distPx = Math.max(0, Number(minDistPx) || 0);
  if (distPx <= 0) return points;

  const w = Math.max(1, Number(imgW) || 1);
  const h = Math.max(1, Number(imgH) || 1);
  const dist2 = distPx * distPx;
  const cell = Math.max(1, distPx);
  const grid = new Map();

  for (let i = 0; i < points.length; i += 3) {
    const px = points[i] * w;
    const py = points[i + 1] * h;
    const key = `${Math.floor(px / cell)},${Math.floor(py / cell)}`;
    let arr = grid.get(key);
    if (!arr) { arr = []; grid.set(key, arr); }
    arr.push(i);
  }

  const out = [];
  for (let i = 0; i < points.length; i += 3) {
    const px = points[i] * w;
    const py = points[i + 1] * h;
    const bx = Math.floor(px / cell);
    const by = Math.floor(py / cell);
    let hasNeighbor = false;
    for (let ox = -1; ox <= 1 && !hasNeighbor; ox++) {
      for (let oy = -1; oy <= 1 && !hasNeighbor; oy++) {
        const arr = grid.get(`${bx + ox},${by + oy}`);
        if (!arr) continue;
        for (const j of arr) {
          if (j === i) continue;
          const dx = px - points[j] * w;
          const dy = py - points[j + 1] * h;
          if ((dx * dx + dy * dy) <= dist2) {
            hasNeighbor = true;
            break;
          }
        }
      }
    }
    if (hasNeighbor) out.push(points[i], points[i + 1], points[i + 2]);
  }

  return out.length >= 3 ? new Float32Array(out) : null;
}

const OUTDOOR_SMOKE_POINT_THRESHOLD = 0.5;

/** @param {number} outdoorFactor 0 = fully under roof, 1 = open sky */
export function computeIndoorBlend(outdoorFactor) {
  return clamp01(1.0 - clamp01(outdoorFactor));
}

/**
 * Shared indoor density curve for smoke + embers (0 = no suppression, 1 = fully under roof).
 * @param {number} suppression 0–1 param value
 * @param {number} outdoorFactor roof mask outdoors strength
 */
export function computeIndoorSuppressionScale(suppression, outdoorFactor) {
  const sup = clamp01(Number.isFinite(suppression) ? suppression : 0);
  return clamp01(1.0 - sup * computeIndoorBlend(outdoorFactor));
}

/**
 * Apply Flame Texture folder transforms to the ember sprite map (not the flame flipbook atlas).
 * @param {THREE.Texture|null|undefined} texture
 * @param {object|null|undefined} params
 */
export function applyEmberSpriteTextureTransform(texture, params) {
  if (!texture || !params) return;
  const sx = Math.max(0.05, Number(params.flameTextureScaleX) || 1);
  const sy = Math.max(0.05, Number(params.flameTextureScaleY) || 1);
  const flipX = params.flameTextureFlipX !== false;
  const flipY = params.flameTextureFlipY !== false;
  const ox = Number(params.flameTextureOffsetX) || 0;
  const oy = Number(params.flameTextureOffsetY) || 0;
  texture.repeat.set(flipX ? -sx : sx, flipY ? -sy : sy);
  texture.offset.set(flipX ? ox + 1 : ox, flipY ? oy + 1 : oy);
  texture.rotation = Number(params.flameTextureRotation) || 0;
  texture.center.set(0.5, 0.5);
  texture.needsUpdate = true;
}

/**
 * Split packed fire-mask spawn points by roof/outdoor mask intensity.
 *
 * @param {Float32Array} points - Packed (u, v, brightness) triples
 * @param {'outdoor'|'indoor'} mode
 * @returns {Float32Array|null}
 */
export function filterFirePointsByOutdoor(points, mode = 'outdoor') {
  if (!points || points.length < 3) return null;

  const out = [];
  for (let i = 0; i < points.length; i += 3) {
    const u = points[i];
    const v = points[i + 1];
    const brightness = points[i + 2];
    if (!Number.isFinite(u) || !Number.isFinite(v) || !Number.isFinite(brightness) || brightness <= 0) {
      continue;
    }

    let outdoorFactor = 1.0;
    try {
      if (weatherController && typeof weatherController.getRoofMaskIntensity === 'function') {
        outdoorFactor = weatherController.getRoofMaskIntensity(u, v);
      }
    } catch (_) {
      outdoorFactor = 1.0;
    }
    outdoorFactor = clamp01(outdoorFactor);
    const isOutdoor = outdoorFactor > OUTDOOR_SMOKE_POINT_THRESHOLD;

    if (mode === 'outdoor' && isOutdoor) out.push(u, v, brightness);
    else if (mode === 'indoor' && !isOutdoor) out.push(u, v, brightness);
  }

  return out.length >= 3 ? new Float32Array(out) : null;
}
