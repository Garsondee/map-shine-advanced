/**
 * @fileoverview Shared helpers to seed Levels-compatible defaults for newly created placeables.
 *
 * These helpers are intentionally conservative:
 * - they only apply when Levels compatibility is active for the current scene,
 * - they only fill missing fields,
 * - they never overwrite explicit user-provided values.
 */

import { getLevelsCompatibilityMode, LEVELS_COMPATIBILITY_MODES } from './levels-compatibility.js';
import { isLevelsEnabledForScene } from './levels-scene-flags.js';

function _isMissing(value) {
  return value === undefined || value === null;
}

/**
 * Read a finite active level band from runtime context.
 * @returns {{bottom:number, top:number, center:number}|null}
 */
export function getFiniteActiveLevelBand() {
  const ctx = window.MapShine?.activeLevelContext;
  let bottom = Number(ctx?.bottom);
  let top = Number(ctx?.top);

  if (!Number.isFinite(bottom) || !Number.isFinite(top)) return null;
  if (top < bottom) {
    const swap = bottom;
    bottom = top;
    top = swap;
  }

  let center = Number(ctx?.center);
  if (!Number.isFinite(center)) center = (bottom + top) * 0.5;
  if (!Number.isFinite(center)) center = bottom;

  return { bottom, top, center };
}

/**
 * Should active-level create defaults be applied for this scene?
 * @param {Scene|null|undefined} [scene]
 * @returns {boolean}
 */
export function shouldApplyLevelCreateDefaults(scene = canvas?.scene) {
  if (getLevelsCompatibilityMode() === LEVELS_COMPATIBILITY_MODES.OFF) return false;
  if (!scene) return false;
  return isLevelsEnabledForScene(scene);
}

/**
 * Seed missing wall-height bounds from the active level band.
 *
 * @param {object} data
 * @param {{scene?: Scene|null|undefined}} [options]
 * @returns {object}
 */
export function applyWallLevelDefaults(data, options = {}) {
  if (!data || typeof data !== 'object') return data;

  const scene = options.scene ?? canvas?.scene;
  if (!shouldApplyLevelCreateDefaults(scene)) return data;

  const band = getFiniteActiveLevelBand();
  if (!band) return data;

  const wallHeight = data.flags?.['wall-height'];
  const hasBottom = !_isMissing(wallHeight?.bottom);
  const hasTop = !_isMissing(wallHeight?.top);
  if (hasBottom && hasTop) return data;

  data.flags = (data.flags && typeof data.flags === 'object') ? data.flags : {};
  const nextWallHeight = (data.flags['wall-height'] && typeof data.flags['wall-height'] === 'object')
    ? data.flags['wall-height']
    : {};

  if (!hasBottom) nextWallHeight.bottom = band.bottom;
  if (!hasTop) nextWallHeight.top = band.top;

  data.flags['wall-height'] = nextWallHeight;
  return data;
}

/**
 * Seed missing ambient-light elevation/range defaults from the active level band.
 *
 * @param {object} data
 * @param {{scene?: Scene|null|undefined}} [options]
 * @returns {object}
 */
export function applyAmbientLightLevelDefaults(data, options = {}) {
  if (!data || typeof data !== 'object') return data;

  const scene = options.scene ?? canvas?.scene;
  if (!shouldApplyLevelCreateDefaults(scene)) return data;

  const band = getFiniteActiveLevelBand();
  if (!band) return data;

  const hasElevation = !_isMissing(data.elevation);
  const hasRangeTop = !_isMissing(data.flags?.levels?.rangeTop);
  if (hasElevation && hasRangeTop) return data;

  if (!hasElevation) {
    data.elevation = band.center;
  }

  if (!hasRangeTop) {
    data.flags = (data.flags && typeof data.flags === 'object') ? data.flags : {};
    data.flags.levels = (data.flags.levels && typeof data.flags.levels === 'object')
      ? data.flags.levels
      : {};
    data.flags.levels.rangeTop = band.top;
  }

  return data;
}
