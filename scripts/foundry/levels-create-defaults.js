/**
 * @fileoverview Shared helpers to seed level defaults for newly created placeables.
 *
 * V14-native path: uses the viewed Level document id to populate the native
 * `levels` SetField on new walls/tiles/etc. Legacy wall-height/flag helpers
 * are retained as fallbacks only.
 */

import { hasV14NativeLevels } from './levels-scene-flags.js';

function _isMissing(value) {
  return value === undefined || value === null;
}

/**
 * Get the currently viewed V14 Level document ID.
 * @returns {string|null}
 */
function _getViewedV14LevelId() {
  const scene = globalThis.canvas?.scene;
  if (!hasV14NativeLevels(scene)) return null;
  return scene._view ?? null;
}

/**
 * Seed the V14 native `levels` array field on new wall creation data when
 * the scene uses native levels. This assigns the wall to the currently
 * viewed level. Does nothing if levels are already specified.
 *
 * @param {object} data - The pending wall create data
 * @param {{scene?: Scene|null|undefined}} [options]
 * @returns {object} The mutated data
 */
export function applyWallV14LevelDefaults(data, options = {}) {
  if (!data || typeof data !== 'object') return data;
  const scene = options.scene ?? globalThis.canvas?.scene;
  if (!hasV14NativeLevels(scene)) return data;

  // Only seed when the data doesn't already have levels assigned
  if (data.levels && (Array.isArray(data.levels) ? data.levels.length : data.levels.size)) return data;

  const levelId = _getViewedV14LevelId();
  if (!levelId) return data;

  data.levels = [levelId];
  return data;
}

/**
 * Seed the V14 native `levels` array field on new tile creation data.
 * @param {object} data
 * @param {{scene?: Scene|null|undefined}} [options]
 * @returns {object}
 */
export function applyTileV14LevelDefaults(data, options = {}) {
  if (!data || typeof data !== 'object') return data;
  const scene = options.scene ?? globalThis.canvas?.scene;
  if (!hasV14NativeLevels(scene)) return data;
  if (data.levels && (Array.isArray(data.levels) ? data.levels.length : data.levels.size)) return data;
  const levelId = _getViewedV14LevelId();
  if (!levelId) return data;
  data.levels = [levelId];
  return data;
}

/**
 * Seed V14 native token `level` field with the currently viewed level.
 * @param {object} data
 * @param {{scene?: Scene|null|undefined}} [options]
 * @returns {object}
 */
export function applyTokenV14LevelDefaults(data, options = {}) {
  if (!data || typeof data !== 'object') return data;
  const scene = options.scene ?? globalThis.canvas?.scene;
  if (!hasV14NativeLevels(scene)) return data;
  if (data.level) return data;
  const levelId = _getViewedV14LevelId();
  if (!levelId) return data;
  data.level = levelId;
  return data;
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
 * Get wall-height bounds for the active level.
 *
 * Wall-height uses half-open ranges [bottom, top) for filtering. To ensure
 * walls block the entire floor including the top seam, we use the NEXT
 * floor's bottom as the wall top (or Infinity if this is the top floor).
 *
 * Example:
 *   Floor 0: band [0, 9]  -> wall-height [0, 10)  (uses floor 1's bottom)
 *   Floor 1: band [10, 20] -> wall-height [10, 20) (or Infinity)
 *
 * @returns {{bottom:number, top:number}|null}
 */
export function getWallHeightBandForActiveLevel() {
  const ctx = window.MapShine?.activeLevelContext;
  if (!ctx) return null;

  let bottom = Number(ctx?.bottom);
  if (!Number.isFinite(bottom)) return null;

  // Find the next floor's bottom to use as our top
  const levels = window.MapShine?.availableLevels || [];
  const currentIndex = Number(ctx?.index);

  let top;
  if (Number.isFinite(currentIndex) && levels.length > currentIndex + 1) {
    const nextLevel = levels[currentIndex + 1];
    top = Number(nextLevel?.bottom);
  }

  // If no next level, use the context top (top floor extends to Infinity)
  if (!Number.isFinite(top)) {
    top = Number(ctx?.top);
    // If the floor's natural top is finite, extend it by 1 unit to ensure
    // the seam elevation is included in the wall-height range
    if (Number.isFinite(top)) {
      top += 1;
    } else {
      top = Infinity;
    }
  }

  return { bottom, top };
}

/**
 * Should active-level create defaults be applied for this scene?
 * @param {Scene|null|undefined} [scene]
 * @param {{allowWhenModeOff?: boolean}} [options]
 * @returns {boolean}
 */
export function shouldApplyLevelCreateDefaults(scene = canvas?.scene, options = {}) {
  void options;
  if (!hasV14NativeLevels(scene)) return false;
  const mapShineCtx = window.MapShine?.activeLevelContext;
  const mapShineLevelCount = Number(mapShineCtx?.count ?? 0);
  if (Number.isFinite(mapShineLevelCount) && mapShineLevelCount > 1) return true;
  if (getFiniteActiveLevelBand()) return true;
  return false;
}

/**
 * Seed wall level defaults. V14-native scenes use the `levels` document field;
 * legacy scenes fall back to `wall-height` flag bounds.
 *
 * @param {object} data
 * @param {{scene?: Scene|null|undefined}} [options]
 * @returns {object}
 */
export function applyWallLevelDefaults(data, options = {}) {
  if (!data || typeof data !== 'object') return data;
  return applyWallV14LevelDefaults(data, options);
}

/**
 * Seed missing ambient-sound elevation/range defaults from the active level band.
 *
 * @param {object} data
 * @param {{scene?: Scene|null|undefined}} [options]
 * @returns {object}
 */
export function applyAmbientSoundLevelDefaults(data, options = {}) {
  if (!data || typeof data !== 'object') return data;

  const scene = options.scene ?? canvas?.scene;
  if (!shouldApplyLevelCreateDefaults(scene)) return data;

  const band = getFiniteActiveLevelBand();
  if (!band) return data;

  const hasElevation = !_isMissing(data.elevation);
  const hasLevels = Array.isArray(data.levels) ? data.levels.length > 0 : !!data.levels?.size;
  if (hasElevation && hasLevels) return data;

  if (!hasElevation) {
    data.elevation = band.center;
  }

  if (!hasLevels) data.levels = [_getViewedV14LevelId()].filter(Boolean);

  return data;
}

/**
 * Seed missing tile level defaults. V14-native: sets `levels` field.
 * Legacy: sets elevation and range flags.
 *
 * @param {object} data
 * @param {{scene?: Scene|null|undefined}} [options]
 * @returns {object}
 */
export function applyTileLevelDefaults(data, options = {}) {
  if (!data || typeof data !== 'object') return data;
  return applyTileV14LevelDefaults(data, options);
}

/**
 * Seed missing token level defaults. V14-native: sets `level` field.
 * Legacy: sets elevation from active band.
 *
 * @param {object} data
 * @param {{scene?: Scene|null|undefined}} [options]
 * @returns {object}
 */
export function applyTokenLevelDefaults(data, options = {}) {
  if (!data || typeof data !== 'object') return data;
  return applyTokenV14LevelDefaults(data, options);
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
  const hasLevels = Array.isArray(data.levels) ? data.levels.length > 0 : !!data.levels?.size;
  if (hasElevation && hasLevels) return data;

  if (!hasElevation) {
    data.elevation = band.center;
  }

  if (!hasLevels) data.levels = [_getViewedV14LevelId()].filter(Boolean);

  return data;
}


