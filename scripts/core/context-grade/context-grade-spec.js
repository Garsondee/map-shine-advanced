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
 * Gaussian-ish brightness punch during transitions (doorway dazzle).
 *
 * @param {number} rawT - 0..1 transition time
 * @param {Record<string, *>} params
 * @param {'outdoor'|'indoor'|'neutral'} targetState
 * @returns {ContextGradeOverlay}
 */
export function computeDramaPulse(rawT, params, targetState) {
  if (params?.dramaEnabled === false) return createNeutralContextGrade();

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
