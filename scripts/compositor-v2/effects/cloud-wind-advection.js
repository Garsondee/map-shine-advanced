/**
 * @fileoverview Shared cloud sprite wind advection — min drift, fast accel, slow decel.
 * Scene wind gust fronts boost speed above the baseline; they never zero out motion.
 * @module compositor-v2/effects/cloud-wind-advection
 */

import { sceneWindField as _sceneWindFieldSingleton } from '../../core/SceneWindField.js';
import { CLOUD_CONFIG } from './cloud-math.js';

/** @type {import('../../core/SceneWindField.js').SceneWindField|null} */
let cachedWindField = null;

/** @returns {import('../../core/SceneWindField.js').SceneWindField|null} */
function getWindField() {
  if (cachedWindField) return cachedWindField;
  cachedWindField = window.MapShine?.sceneWindField ?? _sceneWindFieldSingleton ?? null;
  return cachedWindField;
}

/** Invalidate cached wind field (e.g. after hot reload). */
export function resetCloudWindFieldCache() {
  cachedWindField = null;
}

/**
 * Advance smoothed cloud drift velocity toward weather + optional gust boost.
 * Direction blends via angle+magnitude separation; gusts inject slight orthogonal curl.
 * @param {import('three').Vector2} velocity Mutated in place.
 * @param {import('three').Vector2} tempDir Scratch vec2 (mutated).
 * @param {number} delta Seconds.
 * @param {number} windDirX Foundry Y-down weather direction X.
 * @param {number} windDirY Foundry Y-down weather direction Y.
 * @param {number} windSpeed Normalized 0..1 weather speed.
 * @param {object} params Cloud drift params (sanitized floats preferred).
 * @param {{ centerX?: number, centerY?: number }} [opts]
 */
export function advanceCloudWindAdvection(velocity, tempDir, delta, windDirX, windDirY, windSpeed, params, opts = {}) {
  const dt = Math.max(0, delta);
  if (dt <= 0) return;

  const minSpd = Math.max(0, params.minDriftSpeed ?? 0);
  const influence = Math.max(0, params.windInfluence ?? 0);
  const driftGain = Math.max(0, params.driftSpeed ?? 0);
  let weatherSpd = Math.max(0, windSpeed) * influence * driftGain;
  weatherSpd = Math.max(weatherSpd, minSpd);

  let targetSpd = weatherSpd;
  let gust = 0;
  const windField = getWindField();

  if (windField?.params?.enabled !== false) {
    const cx = opts.centerX ?? 0;
    const cy = opts.centerY ?? 0;
    const sample = windField.getSampleWorld(cx, cy);
    gust = Math.max(0, Math.min(1, sample?.spatial01 ?? 0));
    const surplus = Math.max(0, weatherSpd - minSpd);
    const lullSurplus = Math.max(0.35, Math.min(0.95, windField._runtime?.cloudLullSurplus ?? 0.55));
    targetSpd = minSpd + surplus * (lullSurplus + (1.0 - lullSurplus) * gust);
  }

  tempDir.set(windDirX, -windDirY);
  if (tempDir.lengthSq() < CLOUD_CONFIG.EPS_LEN_SQ) tempDir.set(1, 0);
  else tempDir.normalize();

  const accelResp = Math.max(0.01, params.driftResponsiveness ?? 0.75);
  const decelFactor = Math.max(0.02, Math.min(1, params.driftDecelFactor ?? 0.14));
  const decelResp = Math.max(0.01, accelResp * decelFactor);

  const currentSpd = velocity.length();
  const accelerating = targetSpd > currentSpd + CLOUD_CONFIG.EPS_LEN;
  const resp = accelerating ? accelResp : decelResp;
  const alpha = 1 - Math.exp(-resp * dt);

  // Blend angle and magnitude separately for curved flight paths (not axis-aligned lerp).
  const curAng = currentSpd > CLOUD_CONFIG.EPS_LEN
    ? Math.atan2(velocity.y, velocity.x)
    : Math.atan2(tempDir.y, tempDir.x);
  const tgtAng = Math.atan2(tempDir.y, tempDir.x);
  let angDiff = tgtAng - curAng;
  if (angDiff > Math.PI) angDiff -= Math.PI * 2;
  else if (angDiff < -Math.PI) angDiff += Math.PI * 2;

  const newAng = curAng + angDiff * alpha;
  const newSpd = currentSpd + (targetSpd - currentSpd) * alpha;
  velocity.set(Math.cos(newAng) * newSpd, Math.sin(newAng) * newSpd);

  // Gust curl — slight orthogonal swirl when gust fronts hit.
  if (gust > 0.02) {
    const curl = gust * CLOUD_CONFIG.WIND_CURL_GUST_SCALE * weatherSpd * alpha;
    velocity.x += -tempDir.y * curl;
    velocity.y += tempDir.x * curl;
  }

  const minSq = minSpd * minSpd;
  const maxSpd = Math.max(minSpd, params.driftMaxSpeed ?? 0.5);
  const maxSq = maxSpd * maxSpd;
  const spdSq = velocity.lengthSq();

  if (spdSq < minSq && minSq > CLOUD_CONFIG.EPS_LEN_SQ) {
    velocity.copy(tempDir).multiplyScalar(minSpd);
  } else if (spdSq > maxSq) {
    velocity.multiplyScalar(maxSpd / Math.sqrt(spdSq));
  }
}
