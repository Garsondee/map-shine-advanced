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
 * Read the currently selected Levels UI range when the Levels range UI is active.
 *
 * This keeps create-default seeding aligned with users who are navigating floors
 * through the Levels module UI instead of MapShine's level navigator.
 *
 * @returns {{bottom:number, top:number, center:number}|null}
 */
function _getLevelsUiActiveBand() {
  const levelsUi = globalThis.CONFIG?.Levels?.UI;
  if (!levelsUi || levelsUi.rangeEnabled !== true) return null;

  const range = levelsUi.range;
  if (!Array.isArray(range) || range.length < 2) return null;

  let bottom = Number(range[0]);
  let top = Number(range[1]);
  if (!Number.isFinite(bottom) || !Number.isFinite(top)) return null;

  if (top < bottom) {
    const swap = bottom;
    bottom = top;
    top = swap;
  }

  return {
    bottom,
    top,
    center: (bottom + top) * 0.5,
  };
}

/**
 * Read a finite active level band from runtime context.
 * @returns {{bottom:number, top:number, center:number}|null}
 */
export function getFiniteActiveLevelBand() {
  // Prefer Levels UI range when active, then fall back to MapShine context.
  // This ensures floor-scoped wall defaults work regardless of which floor UI
  // the user is currently driving.
  const levelsUiBand = _getLevelsUiActiveBand();
  if (levelsUiBand) return levelsUiBand;

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
 * @param {{allowWhenModeOff?: boolean}} [options]
 * @returns {boolean}
 */
export function shouldApplyLevelCreateDefaults(scene = canvas?.scene, options = {}) {
  const { allowWhenModeOff = false } = options;
  if (!allowWhenModeOff && getLevelsCompatibilityMode() === LEVELS_COMPATIBILITY_MODES.OFF) return false;

  // If Levels' own range UI is active, respect it regardless of scene-flag
  // completeness. This matches the user's explicit floor-selection intent.
  if (_getLevelsUiActiveBand()) return true;

  // If MapShine has an active multi-level context, allow default seeding even
  // when a scene's Levels flags are sparse or inferred at runtime.
  const mapShineCtx = window.MapShine?.activeLevelContext;
  const mapShineLevelCount = Number(mapShineCtx?.count ?? 0);
  if (Number.isFinite(mapShineLevelCount) && mapShineLevelCount > 1) return true;

  // Fallback: if an explicit finite active band exists, honor it even when
  // count metadata is unavailable.
  if (getFiniteActiveLevelBand()) return true;

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
  // Wall-height scoping should keep working even when compatibility mode is
  // OFF, as long as we have an explicit active floor context.
  if (!shouldApplyLevelCreateDefaults(scene, { allowWhenModeOff: true })) return data;

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
 * Seed missing tile elevation/range defaults from the active level band.
 *
 * This keeps newly created tiles (including drag/drop creates) scoped to the
 * currently selected floor in the Levels mini UI / MapShine level context.
 *
 * @param {object} data
 * @param {{scene?: Scene|null|undefined}} [options]
 * @returns {object}
 */
export function applyTileLevelDefaults(data, options = {}) {
  if (!data || typeof data !== 'object') return data;

  const scene = options.scene ?? canvas?.scene;
  // Tile floor scoping should keep working when we have explicit active-floor
  // context, even if compatibility mode is set to OFF.
  if (!shouldApplyLevelCreateDefaults(scene, { allowWhenModeOff: true })) return data;

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
