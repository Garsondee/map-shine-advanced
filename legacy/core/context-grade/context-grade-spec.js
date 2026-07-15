/**
 * @fileoverview Field definitions and lerp helpers for Contextual Scene Grade overlays.
 * @module core/context-grade/context-grade-spec
 */

/** @typedef {'linear'|'smooth'|'easeIn'|'easeOut'|'easeInOut'|'exp'|'overshoot'} ContextGradeEasingId */

/** @typedef {Object} ContextGradeOverlay
 * @property {number} exposure - Additive stops (pow2 applied in shader)
 * @property {number} saturation - Additive delta from 1.0 multiplier
 * @property {number} brightness
 * @property {number} contrast - Additive delta from 1.0
 * @property {number} vibrance
 * @property {number} temperature
 * @property {number} tint
 * @property {number} vignetteStrength
 * @property {number} masterGamma - Additive delta from 1.0
 */

/** @type {ReadonlyArray<{ id: keyof ContextGradeOverlay, default: number }>} */
export const CONTEXT_GRADE_FIELD_SPECS = Object.freeze([
  { id: 'exposure', default: 0 },
  { id: 'saturation', default: 0 },
  { id: 'brightness', default: 0 },
  { id: 'contrast', default: 0 },
  { id: 'vibrance', default: 0 },
  { id: 'temperature', default: 0 },
  { id: 'tint', default: 0 },
  { id: 'vignetteStrength', default: 0 },
  { id: 'masterGamma', default: 0 },
]);

/** @type {ReadonlyArray<ContextGradeEasingId>} */
export const CONTEXT_GRADE_EASING_IDS = Object.freeze([
  'linear',
  'smooth',
  'easeIn',
  'easeOut',
  'easeInOut',
  'exp',
  'overshoot',
]);

/**
 * @returns {ContextGradeOverlay}
 */
export function createNeutralContextGrade() {
  return {
    exposure: 0,
    saturation: 0,
    brightness: 0,
    contrast: 0,
    vibrance: 0,
    temperature: 0,
    tint: 0,
    vignetteStrength: 0,
    masterGamma: 0,
  };
}

/**
 * @param {Partial<ContextGradeOverlay>|null|undefined} src
 * @returns {ContextGradeOverlay}
 */
export function cloneContextGrade(src) {
  const base = createNeutralContextGrade();
  if (!src || typeof src !== 'object') return base;
  for (const spec of CONTEXT_GRADE_FIELD_SPECS) {
    const n = Number(src[spec.id]);
    base[spec.id] = Number.isFinite(n) ? n : spec.default;
  }
  return base;
}

/**
 * @param {ContextGradeOverlay|null|undefined} a
 * @param {ContextGradeOverlay|null|undefined} b
 * @param {number} [epsilon=0.0005]
 * @returns {boolean}
 */
export function overlaysEqual(a, b, epsilon = 0.0005) {
  const eps = Math.abs(Number(epsilon)) || 0.0005;
  for (const spec of CONTEXT_GRADE_FIELD_SPECS) {
    const va = finiteOr(a?.[spec.id], spec.default);
    const vb = finiteOr(b?.[spec.id], spec.default);
    if (Math.abs(va - vb) > eps) return false;
  }
  return true;
}

/**
 * @param {*} value
 * @param {number} [fallback=0]
 * @returns {number}
 */
export function finiteOr(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Smooth 0..1 outdoor weight from authored _Outdoors sample (matches spatial blend band).
 *
 * @param {number|null|undefined} sample
 * @param {Record<string, *>} params
 * @returns {number}
 */
export function computeOutdoorBlendWeight(sample, params) {
  const high = finiteOr(params?.outdoorThresholdHigh, 0.82);
  const low = finiteOr(params?.indoorThresholdLow, 0.18);
  const s = Number(sample);
  if (!Number.isFinite(s)) return 0.5;
  if (s <= low) return 0;
  if (s >= high) return 1;
  const t = (s - low) / Math.max(0.001, high - low);
  return t * t * (3 - 2 * t);
}

/**
 * How far overlay `current` has converged toward `target` (0..1).
 *
 * @param {ContextGradeOverlay|null|undefined} current
 * @param {ContextGradeOverlay|null|undefined} target
 * @returns {number}
 */
export function overlayConvergenceProgress(current, target) {
  let maxDelta = 0;
  for (const spec of CONTEXT_GRADE_FIELD_SPECS) {
    const va = finiteOr(current?.[spec.id], spec.default);
    const vb = finiteOr(target?.[spec.id], spec.default);
    maxDelta = Math.max(maxDelta, Math.abs(va - vb));
  }
  if (maxDelta <= 0.0005) return 1;
  const refSpan = 1.25;
  return Math.max(0, Math.min(1, 1 - maxDelta / refSpan));
}

/**
 * @param {number} t
 * @param {ContextGradeEasingId|string} [easingId='smooth']
 * @returns {number}
 */
export function applyContextGradeEasing(t, easingId = 'smooth') {
  const x = Math.max(0, Math.min(1, finiteOr(t, 0)));
  switch (String(easingId || 'smooth')) {
    case 'linear':
      return x;
    case 'easeIn':
      return x * x;
    case 'easeOut':
      return 1 - (1 - x) * (1 - x);
    case 'easeInOut':
      return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    case 'exp':
      return x <= 0 ? 0 : 1 - Math.pow(2, -8 * x);
    case 'overshoot': {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
    }
    case 'smooth':
    default:
      return x * x * (3 - 2 * x);
  }
}

/**
 * @param {ContextGradeOverlay} a
 * @param {ContextGradeOverlay} b
 * @param {number} t
 * @returns {ContextGradeOverlay}
 */
export function lerpContextGrade(a, b, t) {
  const u = Math.max(0, Math.min(1, finiteOr(t, 0)));
  const out = createNeutralContextGrade();
  for (const spec of CONTEXT_GRADE_FIELD_SPECS) {
    const va = finiteOr(a?.[spec.id], spec.default);
    const vb = finiteOr(b?.[spec.id], spec.default);
    out[spec.id] = va + (vb - va) * u;
  }
  return out;
}

/**
 * Add overlay fields (used for transition pulse on top of base lerp).
 *
 * @param {ContextGradeOverlay} base
 * @param {Partial<ContextGradeOverlay>|null|undefined} delta
 * @returns {ContextGradeOverlay}
 */
export function addContextGradeOverlays(base, delta) {
  const out = cloneContextGrade(base);
  if (!delta || typeof delta !== 'object') return out;
  for (const spec of CONTEXT_GRADE_FIELD_SPECS) {
    out[spec.id] += finiteOr(delta[spec.id], 0);
  }
  return out;
}

/**
 * Progress toward the target pack — delayed until after the dazzle peak.
 *
 * @param {number} rawT - 0..1 transition time
 * @param {Record<string, *>} params
 * @returns {number}
 */
export function computeDramaSettleProgress(rawT, params) {
  const delay = Math.max(0, Math.min(0.88, finiteOr(params?.dramaSettleDelay, 0.38)));
  const t = Math.max(0, Math.min(1, finiteOr(rawT, 0)));
  if (t <= delay) return 0;
  const u = (t - delay) / Math.max(0.001, 1 - delay);
  return applyContextGradeEasing(u, params?.dramaSettleEasing || 'easeOut');
}

/**
 * Doorway dazzle is only appropriate in bright daytime — not night/twilight selection or transitions.
 *
 * @param {Record<string, *>} params
 * @param {{ dayPhase?: string, calendarDayWeight?: number|null }} [env]
 * @returns {boolean}
 */
export function isDoorwayDramaAllowed(params = {}, env = {}) {
  if (params?.dramaEnabled === false) return false;
  if (params?.dramaRequireDaylight === false) return true;
  const phase = String(env?.dayPhase ?? 'day');
  if (phase !== 'day') return false;
  const dayWeight = finiteOr(env?.calendarDayWeight, 1);
  const dayHigh = finiteOr(params?.dramaDayThreshold, finiteOr(params?.envDayThreshold, 0.62));
  return dayWeight >= dayHigh;
}

/**
 * Gaussian-ish brightness punch during transitions (doorway dazzle).
 *
 * @param {number} rawT - 0..1 transition time
 * @param {Record<string, *>} params
 * @param {'outdoor'|'indoor'|'neutral'} targetState
 * @param {{ dayPhase?: string, calendarDayWeight?: number|null }} [env]
 * @returns {ContextGradeOverlay}
 */
export function computeDramaPulse(rawT, params, targetState, env = {}) {
  if (!isDoorwayDramaAllowed(params, env)) return createNeutralContextGrade();

  const strength = Math.max(0, finiteOr(params?.dramaStrength, 1));
  if (strength <= 0) return createNeutralContextGrade();

  // Doorway dazzle only when stepping out into daylight — not when entering interior.
  if (targetState !== 'outdoor') return createNeutralContextGrade();

  const dirScale = 1;

  const peakAt = Math.max(0.06, Math.min(0.78, finiteOr(params?.dramaPeakAt, 0.3)));
  const peakWidth = Math.max(0.06, finiteOr(params?.dramaPeakWidth, 0.26));
  const dist = (Math.max(0, Math.min(1, finiteOr(rawT, 0))) - peakAt) / peakWidth;
  const bump = Math.exp(-dist * dist * 1.65) * strength * dirScale;

  return {
    exposure: finiteOr(params?.dramaPeakExposure, 0.85) * bump,
    saturation: finiteOr(params?.dramaPeakSaturation, 0.12) * bump,
    brightness: finiteOr(params?.dramaPeakBrightness, 0.04) * bump,
    contrast: finiteOr(params?.dramaPeakContrast, 0.05) * bump,
    vibrance: finiteOr(params?.dramaPeakVibrance, 0.14) * bump,
    temperature: finiteOr(params?.dramaPeakTemperature, 0.1) * bump,
    tint: 0,
    vignetteStrength: -finiteOr(params?.dramaPeakVignetteLift, 0.1) * bump,
    masterGamma: -finiteOr(params?.dramaPeakGammaLift, 0.05) * bump,
  };
}

/**
 * Extract overlay pack fields from flat effect params using a prefix.
 *
 * @param {Record<string, *>} params
 * @param {string} prefix - e.g. 'outdoor' or 'indoor'
 * @returns {ContextGradeOverlay}
 */
export function readContextGradePackFromParams(params, prefix) {
  const out = createNeutralContextGrade();
  if (!params || typeof params !== 'object') return out;
  const cap = prefix.charAt(0).toUpperCase() + prefix.slice(1);
  for (const spec of CONTEXT_GRADE_FIELD_SPECS) {
    const key = `${prefix}${cap}${spec.id.charAt(0).toUpperCase()}${spec.id.slice(1)}`;
    const altKey = `${prefix}${spec.id.charAt(0).toUpperCase()}${spec.id.slice(1)}`;
    const raw = params[key] ?? params[altKey];
    const n = Number(raw);
    out[spec.id] = Number.isFinite(n) ? n : spec.default;
  }
  return out;
}

/** @type {ReadonlyArray<string>} Tier 1 global env modifier param prefixes. */
export const ENV_MODIFIER_PREFIXES = Object.freeze([
  'envOvercast',
  'envStorm',
  'envNight',
  'envTwilight',
  'envDarkness',
]);

/** @type {ReadonlyArray<string>} Tier 2 token modifier param prefixes. */
export const TOKEN_MODIFIER_PREFIXES = Object.freeze([
  'modOutdoorOvercast',
  'modCloudShadow',
  'modCanopy',
  'modWindowLit',
  'modBuildingShadow',
  'modPaintedShadow',
  'modTreeDapple',
]);

/**
 * @param {Record<string, *>} params
 * @param {string} prefix - e.g. envOvercast, modCanopy
 * @returns {ContextGradeOverlay}
 */
export function readModifierPack(params, prefix) {
  const out = createNeutralContextGrade();
  if (!params || typeof params !== 'object' || !prefix) return out;
  for (const spec of CONTEXT_GRADE_FIELD_SPECS) {
    const capField = spec.id.charAt(0).toUpperCase() + spec.id.slice(1);
    const key = `${prefix}${capField}`;
    out[spec.id] = finiteOr(params[key], spec.default);
  }
  return out;
}

/**
 * @param {ContextGradeOverlay} pack
 * @param {number} weight
 * @returns {ContextGradeOverlay}
 */
export function scaleContextGrade(pack, weight) {
  const w = Math.max(0, Math.min(1, finiteOr(weight, 0)));
  const out = createNeutralContextGrade();
  for (const spec of CONTEXT_GRADE_FIELD_SPECS) {
    out[spec.id] = finiteOr(pack?.[spec.id], 0) * w;
  }
  return out;
}

/**
 * Eye-adaptation weight: 1 = full contextual offset, 0 = fully adapted (neutral).
 *
 * @param {number} elapsedMs
 * @param {number} durationMs
 * @param {ContextGradeEasingId|string} [easingId='easeOut']
 * @returns {number}
 */
export function computeEyeAdaptationWeight(elapsedMs, durationMs, easingId = 'easeOut') {
  const dur = Math.max(1, finiteOr(durationMs, 60000));
  const t = Math.max(0, Math.min(1, finiteOr(elapsedMs, 0) / dur));
  if (t >= 1) return 0;
  return 1 - applyContextGradeEasing(t, easingId);
}

/**
 * @param {Record<string, *>} params
 * @param {'outdoor'|'indoor'} packId
 * @returns {ContextGradeOverlay}
 */
export function readNamedContextPack(params, packId) {
  if (packId === 'outdoor') {
    return {
      exposure: finiteOr(params?.outdoorExposure),
      saturation: finiteOr(params?.outdoorSaturation),
      brightness: finiteOr(params?.outdoorBrightness),
      contrast: finiteOr(params?.outdoorContrast),
      vibrance: finiteOr(params?.outdoorVibrance),
      temperature: finiteOr(params?.outdoorTemperature),
      tint: finiteOr(params?.outdoorTint),
      vignetteStrength: finiteOr(params?.outdoorVignetteStrength),
      masterGamma: finiteOr(params?.outdoorMasterGamma),
    };
  }
  return {
    exposure: finiteOr(params?.indoorExposure),
    saturation: finiteOr(params?.indoorSaturation),
    brightness: finiteOr(params?.indoorBrightness),
    contrast: finiteOr(params?.indoorContrast),
    vibrance: finiteOr(params?.indoorVibrance),
    temperature: finiteOr(params?.indoorTemperature),
    tint: finiteOr(params?.indoorTint),
    vignetteStrength: finiteOr(params?.indoorVignetteStrength),
    masterGamma: finiteOr(params?.indoorMasterGamma),
  };
}

/**
 * Fast exponential lerp for env overlays (frame-rate independent).
 *
 * @param {ContextGradeOverlay} current
 * @param {ContextGradeOverlay} target
 * @param {number} dt
 * @param {number} tauMs
 * @returns {ContextGradeOverlay}
 */
export function lerpContextGradeFast(current, target, dt, tauMs = 250) {
  const tau = Math.max(16, finiteOr(tauMs, 250)) / 1000;
  const t = 1 - Math.exp(-Math.max(0, dt) / tau);
  return lerpContextGrade(current, target, t);
}

/**
 * Frame-rate independent scalar lerp (outdoor weight, spatial bias, etc.).
 *
 * @param {number} current
 * @param {number} target
 * @param {number} dt
 * @param {number} tauMs
 * @returns {number}
 */
export function lerpScalarFast(current, target, dt, tauMs = 250) {
  const tau = Math.max(16, finiteOr(tauMs, 250)) / 1000;
  const t = 1 - Math.exp(-Math.max(0, dt) / tau);
  const c = finiteOr(current, 0);
  const g = finiteOr(target, 0);
  return c + (g - c) * t;
}

/**
 * Building shadow lit thresholds from sensitivity slider or manual overrides.
 *
 * @param {Record<string, *>} params
 * @returns {{ buildLow: number, buildHigh: number, partialDetect: boolean }}
 */
export function resolveBuildingShadowThresholds(params = {}) {
  const partialDetect = params?.buildingShadowPartialDetect !== false;
  if (params?.buildingShadowUseAdvancedThresholds === true) {
    return {
      buildLow: finiteOr(params?.buildingShadowLitLow, 0.88),
      buildHigh: finiteOr(params?.buildingShadowLitHigh, 0.94),
      partialDetect,
    };
  }
  const sens = Math.max(0, Math.min(100, finiteOr(params?.buildingShadowSensitivity, 75)));
  const t = sens / 100;
  const buildHigh = 0.68 + t * 0.31;
  const buildLow = Math.max(0.15, buildHigh - (0.04 + (1 - t) * 0.14));
  return { buildLow, buildHigh, partialDetect };
}

/**
 * @param {number|null|undefined} lit - 1 sunlit, 0 full shadow
 * @param {{ buildLow: number, buildHigh: number, partialDetect: boolean }} thresholds
 * @param {boolean} [wasActive]
 * @returns {boolean}
 */
export function classifyBuildingShadowLit(lit, thresholds, wasActive = false) {
  const { buildLow, buildHigh, partialDetect } = thresholds ?? resolveBuildingShadowThresholds();
  const s = Number(lit);
  if (!Number.isFinite(s)) return false;
  if (s >= buildHigh) return false;
  if (s <= buildLow) return true;
  if (partialDetect) return true;
  return wasActive;
}
