/**
 * @fileoverview Shared cloud sprite wind advection — min drift, fast accel, slow decel.
 * Scene wind gust fronts boost speed above the baseline; they never zero out motion.
 * @module compositor-v2/effects/cloud-wind-advection
 */

import { sceneWindField as _sceneWindFieldSingleton } from '../../core/SceneWindField.js';

/** @returns {import('../../core/SceneWindField.js').SceneWindField|null} */
function resolveSceneWindField() {
  try {
    return window.MapShine?.sceneWindField ?? _sceneWindFieldSingleton ?? null;
  } catch (_) {
    return _sceneWindFieldSingleton ?? null;
  }
}

/**
 * Advance smoothed cloud drift velocity toward weather + optional gust boost.
 * @param {import('three').Vector2} velocity Mutated in place.
 * @param {import('three').Vector2} tempDir Scratch vec2 (mutated).
 * @param {number} delta Seconds.
 * @param {number} windDirX Foundry Y-down weather direction X.
 * @param {number} windDirY Foundry Y-down weather direction Y.
 * @param {number} windSpeed Normalized 0..1 weather speed.
 * @param {object} params Cloud drift params.
 * @param {{ centerX?: number, centerY?: number }} [opts]
 */
export function advanceCloudWindAdvection(velocity, tempDir, delta, windDirX, windDirY, windSpeed, params, opts = {}) {
  const dt = Math.max(0, Number(delta) || 0);
  const minSpd = Math.max(0, Number(params?.minDriftSpeed) || 0);
  const influence = Math.max(0, Number(params?.windInfluence) || 0);
  const driftGain = Math.max(0, Number(params?.driftSpeed) || 0);
  let weatherSpd = Math.max(0, Number(windSpeed) || 0) * influence * driftGain;
  weatherSpd = Math.max(weatherSpd, minSpd);

  let targetSpd = weatherSpd;
  const sceneWindField = resolveSceneWindField();
  if (sceneWindField?.params?.enabled !== false) {
    const cx = Number(opts.centerX);
    const cy = Number(opts.centerY);
    const sample = sceneWindField.getSampleWorld(
      Number.isFinite(cx) ? cx : 0,
      Number.isFinite(cy) ? cy : 0,
    );
    const gust = Math.max(0, Math.min(1, Number(sample?.spatial01) || 0));
    const surplus = Math.max(0, weatherSpd - minSpd);
    const lullSurplus = Math.max(0.35, Math.min(0.95,
      Number(sceneWindField?._runtime?.cloudLullSurplus) || 0.55));
    // Lulls retain a tier-dependent surplus fraction; storm tier keeps clouds moving.
    targetSpd = minSpd + surplus * (lullSurplus + (1.0 - lullSurplus) * gust);
  }

  tempDir.set(windDirX, -windDirY);
  if (tempDir.lengthSq() < 1e-8) tempDir.set(1, 0);
  tempDir.normalize();

  const targetX = tempDir.x * targetSpd;
  const targetY = tempDir.y * targetSpd;

  const accelResp = Math.max(0.01, Number(params?.driftResponsiveness) ?? 0.75);
  const decelFactor = Math.max(0.02, Math.min(1, Number(params?.driftDecelFactor) ?? 0.14));
  const decelResp = Math.max(0.01, accelResp * decelFactor);

  const currentSpd = velocity.length();
  const accelerating = targetSpd > currentSpd + 1e-6;
  const resp = accelerating ? accelResp : decelResp;
  const alpha = 1 - Math.exp(-resp * dt);

  velocity.x += (targetX - velocity.x) * alpha;
  velocity.y += (targetY - velocity.y) * alpha;

  if (minSpd > 1e-6) {
    const spd = velocity.length();
    if (spd < minSpd) {
      velocity.set(tempDir.x * minSpd, tempDir.y * minSpd);
    }
  }

  const maxSpd = Math.max(minSpd, Number(params?.driftMaxSpeed) ?? 0.5);
  const vl = velocity.length();
  if (vl > maxSpd && vl > 1e-6) velocity.multiplyScalar(maxSpd / vl);
}
