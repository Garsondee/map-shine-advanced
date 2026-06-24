/**
 * @fileoverview Pure math helpers for cloud sprite orchestration.
 * @module compositor-v2/effects/cloud-math
 */

/** Shared tuning constants for cloud rendering and simulation. */
export const CLOUD_CONFIG = {
  /** Norm-space margin beyond 0..1 before a sprite is recycled off the downwind edge. */
  OFF_STAGE_MARGIN: 0.28,
  /** Extra norm-space depth for upwind spawns (fully off-stage before drifting in). */
  UPWIND_SPAWN_DEPTH: 0.2,
  /** Scene-span padding for wrap/roam bounds (fraction of scene width/height). */
  WRAP_BOUNDS_PAD: 0.24,
  /** Extra norm-space padding beyond sprite half-extent on the spawn arc. */
  SPAWN_ARC_SPRITE_PAD: 0.06,
  /** Default cloud-top zoom fade range. */
  CLOUD_TOP_FADE_START: 0.24,
  CLOUD_TOP_FADE_END: 0.39,
  /** Epsilon guards for division and length checks. */
  EPS_LEN: 1e-6,
  EPS_LEN_SQ: 1e-8,
  EPS_DIV: 1e-8,
  EPS_BUCKET: 1e-9,
  /** Wind norm scale for layer UV offset (tanh input). */
  WIND_NORM_SCALE: 0.08,
  /** Orthogonal curl strength applied during gust advection. */
  WIND_CURL_GUST_SCALE: 0.018,
};

/**
 * @param {number} edge0
 * @param {number} edge1
 * @param {number} x
 * @returns {number}
 */
export function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0 + CLOUD_CONFIG.EPS_DIV)));
  return t * t * (3 - 2 * t);
}

/**
 * @param {number} value
 * @param {number} step
 * @returns {number}
 */
export function quantizeShadowBucket(value, step) {
  const s = Math.max(CLOUD_CONFIG.EPS_BUCKET, Number(step) || 1);
  const v = Number(value);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v / s);
}

/**
 * @param {number} c sRGB component 0..1
 * @returns {number} linear component
 */
export function srgbChannelToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * @param {number} c linear component
 * @returns {number} sRGB component 0..1
 */
export function linearChannelToSrgb(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * (c ** (1 / 2.4)) - 0.055;
}

/**
 * Lerp two Vector3 tints in linear light space (vibrant sunset transitions).
 * @param {import('three').Vector3} out
 * @param {import('three').Vector3} a
 * @param {import('three').Vector3} b
 * @param {number} t
 */
export function lerpTintLinear(out, a, b, t) {
  const u = Math.max(0, Math.min(1, t));
  out.x = linearChannelToSrgb(
    srgbChannelToLinear(a.x) * (1 - u) + srgbChannelToLinear(b.x) * u,
  );
  out.y = linearChannelToSrgb(
    srgbChannelToLinear(a.y) * (1 - u) + srgbChannelToLinear(b.y) * u,
  );
  out.z = linearChannelToSrgb(
    srgbChannelToLinear(a.z) * (1 - u) + srgbChannelToLinear(b.z) * u,
  );
}

/** @param {number} x @returns {number} 0..1 */
function hash1D(x) {
  const s = Math.sin(x * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Smooth 1D value noise for organic spawn-front clustering.
 * @param {number} x
 * @returns {number} 0..1
 */
export function noise1D(x) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash1D(i) * (1 - u) + hash1D(i + 1) * u;
}

/**
 * Compare two Float32Array motion states up to activeLength.
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @param {number} activeLength
 * @returns {boolean}
 */
export function motionStatesEqual(a, b, activeLength) {
  for (let i = 0; i < activeLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Copy motion state slice.
 * @param {Float32Array} dst
 * @param {Float32Array} src
 * @param {number} activeLength
 */
export function copyMotionState(dst, src, activeLength) {
  for (let i = 0; i < activeLength; i++) dst[i] = src[i];
}

/**
 * Diagnose why shadow motion cache missed (debug stats).
 * @param {Float32Array} prev
 * @param {Float32Array} next
 * @param {number} activeLength
 * @returns {'spriteFade'|'spriteDrift'|'spriteMotion'}
 */
export function shadowMotionDeltaReason(prev, next, activeLength) {
  let fadeBuckets = 0;
  let uvBuckets = 0;
  for (let i = 0; i < activeLength; i += 3) {
    if (prev[i] !== next[i] || prev[i + 1] !== next[i + 1]) uvBuckets++;
    if (prev[i + 2] !== next[i + 2]) fadeBuckets++;
  }
  if (fadeBuckets > 0 && uvBuckets === 0) return 'spriteFade';
  if (uvBuckets > 0) return 'spriteDrift';
  return 'spriteMotion';
}

/**
 * Sanitize a numeric param — finite number or fallback.
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
export function sanitizeParamNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
