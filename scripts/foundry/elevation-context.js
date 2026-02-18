/**
 * @fileoverview Canonical Elevation Context Service (MS-LVL-020).
 *
 * Provides a single source of truth for the "perspective elevation" used by
 * visibility, tile visibility, fog masking, LOS, and audibility systems.
 *
 * Resolution order (matches Levels' `currentToken` pattern):
 * 1. Currently controlled token's elevation + LOS height.
 * 2. Active level context center (from level navigation).
 * 3. Scene background elevation fallback.
 *
 * This service is stateless — it reads live state from Foundry and Map Shine
 * globals on each call. No caching or subscription is needed.
 */

import { getSceneBackgroundElevation, getSceneWeatherElevation, readTileLevelsFlags, tileHasLevelsRange, readDocLevelsRange, getSceneLightMasking } from './levels-scene-flags.js';
import { getLevelsCompatibilityMode, LEVELS_COMPATIBILITY_MODES } from './levels-compatibility.js';

// ---------------------------------------------------------------------------
//  Controlled token helpers
// ---------------------------------------------------------------------------

/**
 * Get the first controlled token placeable (PIXI Token object).
 * Returns null if no token is controlled or canvas isn't ready.
 *
 * @returns {Token|null}
 */
function _getControlledToken() {
  try {
    const controlled = canvas?.tokens?.controlled;
    if (!controlled?.length) return null;
    return controlled[0] ?? null;
  } catch (_) {
    return null;
  }
}

/**
 * Read the elevation of a token, accounting for in-progress movement
 * destination elevation (matches Levels' movementDelta pattern).
 *
 * @param {Token} token - Foundry PIXI token
 * @returns {number}
 */
function _getTokenElevation(token) {
  const doc = token?.document;
  if (!doc) return 0;

  const baseElevation = Number(doc.elevation ?? 0);
  if (!Number.isFinite(baseElevation)) return 0;

  // Levels accounts for in-progress movement destination elevation.
  // Foundry v12+ stores this on document.movement.destination.elevation.
  try {
    const destElev = doc.movement?.destination?.elevation;
    if (destElev !== undefined && destElev !== null) {
      const dest = Number(destElev);
      if (Number.isFinite(dest)) {
        return baseElevation + (dest - baseElevation);
      }
    }
  } catch (_) {
    // movement data not available — use base elevation
  }

  return baseElevation;
}

/**
 * Read the LOS (Line of Sight) height of a token.
 *
 * Levels uses `token.losHeight` which is typically elevation + token height.
 * Foundry v12 uses the token's elevation as the vision source height.
 *
 * @param {Token} token - Foundry PIXI token
 * @returns {number}
 */
function _getTokenLOSHeight(token) {
  // Levels-specific losHeight (if Levels has patched the token)
  if (typeof token?.losHeight === 'number' && Number.isFinite(token.losHeight)) {
    // Account for movement delta like Levels does
    const doc = token.document;
    const baseElevation = Number(doc?.elevation ?? 0);
    let movementDelta = 0;
    try {
      const destElev = doc?.movement?.destination?.elevation;
      if (destElev !== undefined && destElev !== null) {
        const dest = Number(destElev);
        if (Number.isFinite(dest) && Number.isFinite(baseElevation)) {
          movementDelta = dest - baseElevation;
        }
      }
    } catch (_) {}

    return token.losHeight + movementDelta;
  }

  // Fallback: use token elevation (standard Foundry behavior)
  return _getTokenElevation(token);
}

// ---------------------------------------------------------------------------
//  Public API
// ---------------------------------------------------------------------------

/**
 * Get the current perspective elevation for visibility/rendering decisions.
 *
 * This is the canonical elevation that tile visibility, fog masking, and
 * other elevation-dependent systems should use.
 *
 * @returns {{
 *   elevation: number,
 *   losHeight: number,
 *   source: 'controlled-token'|'active-level'|'background',
 *   tokenId: string|null,
 *   backgroundElevation: number
 * }}
 */
export function getPerspectiveElevation() {
  const scene = canvas?.scene ?? null;
  const bgElevation = getSceneBackgroundElevation(scene);

  const levelContext = window.MapShine?.activeLevelContext;
  const hasActiveLevelCenter = levelContext && Number.isFinite(levelContext.center);

  // Manual level navigation must take precedence over controlled-token elevation,
  // otherwise users can switch levels in UI but still evaluate visibility from
  // the selected token's elevation.
  if (hasActiveLevelCenter && levelContext.lockMode === 'manual') {
    return {
      elevation: levelContext.center,
      losHeight: levelContext.center,
      source: 'active-level',
      tokenId: null,
      backgroundElevation: bgElevation,
    };
  }

  // Source 1: Controlled token
  const token = _getControlledToken();
  if (token) {
    const elevation = _getTokenElevation(token);
    const losHeight = _getTokenLOSHeight(token);
    return {
      elevation,
      losHeight,
      source: 'controlled-token',
      tokenId: token.document?.id ?? null,
      backgroundElevation: bgElevation,
    };
  }

  // Source 2: Active level context from level navigation
  if (hasActiveLevelCenter) {
    return {
      elevation: levelContext.center,
      losHeight: levelContext.center,
      source: 'active-level',
      tokenId: null,
      backgroundElevation: bgElevation,
    };
  }

  // Source 3: Scene background elevation fallback
  return {
    elevation: bgElevation,
    losHeight: bgElevation,
    source: 'background',
    tokenId: null,
    backgroundElevation: bgElevation,
  };
}

/**
 * Determine whether a given elevation range is visible from the current
 * perspective, using Levels' tile visibility logic.
 *
 * This implements the full tile visibility algorithm from Levels'
 * TileHandler.isTileVisible, ported to work with imported flag data.
 *
 * @param {object} params
 * @param {number} params.rangeBottom - Bottom of the range (tile elevation)
 * @param {number} params.rangeTop - Top of the range
 * @param {boolean} [params.showIfAbove=false] - Show tile when viewer is above range
 * @param {number} [params.showAboveRange=Infinity] - Max distance above rangeBottom for showIfAbove
 * @param {boolean} [params.isBasement=false] - Basement behavior (only visible in range)
 * @param {number} [params.backgroundElevation] - Scene background elevation override
 * @param {{elevation: number, losHeight: number}} [params.perspective] - Override perspective (default: current)
 * @returns {boolean} Whether the range is visible
 */
export function isElevationRangeVisible(params) {
  const {
    rangeBottom,
    rangeTop,
    showIfAbove = false,
    showAboveRange = Infinity,
    isBasement = false,
    perspective: perspectiveOverride,
  } = params;

  // If Levels compatibility is off, everything is visible
  if (getLevelsCompatibilityMode() === LEVELS_COMPATIBILITY_MODES.OFF) return true;

  const perspective = perspectiveOverride || getPerspectiveElevation();
  const bgElevation = params.backgroundElevation ?? perspective.backgroundElevation ?? 0;
  const tokenLOS = perspective.losHeight;
  const tokenElevation = perspective.elevation;

  // No controlled token: everything visible (GM range UI not implemented yet).
  // This matches Levels' behavior: if !currentToken, return true.
  if (perspective.source === 'background' && !perspectiveOverride) {
    return true;
  }

  // Tile at background elevation: visible if LOS >= background
  if (rangeBottom === bgElevation && rangeTop === Infinity) {
    return tokenLOS >= bgElevation;
  }

  // No Levels range flags (both at default): visible if LOS >= background
  if (rangeTop === Infinity && rangeBottom === -Infinity) {
    return tokenLOS >= bgElevation;
  }

  const inRange = tokenLOS < rangeTop && tokenLOS >= rangeBottom;

  // Basement: only visible when viewer is in range
  if (!inRange && isBasement) return false;

  // Non-roof tiles below the viewer: hidden unless showIfAbove is set
  if (tokenLOS < rangeBottom && !showIfAbove && rangeTop !== Infinity) return false;

  // showIfAbove tiles: hidden if viewer exceeds the showAboveRange distance
  if (tokenLOS < rangeBottom && showIfAbove && Math.abs(tokenElevation - rangeBottom) > showAboveRange) return false;

  // Roof or showIfAbove tile above background: hidden if viewer is below background
  if ((showIfAbove || rangeTop === Infinity) && rangeBottom > bgElevation && tokenLOS < bgElevation) return false;

  return true;
}

/**
 * Check if a tile document should be visible based on its Levels flags
 * and the current perspective elevation.
 *
 * Convenience wrapper that reads tile flags and calls isElevationRangeVisible.
 *
 * @param {TileDocument|object} tileDoc
 * @param {LevelsTileFlags} [tileFlags] - Pre-read flags (avoids re-reading)
 * @returns {boolean}
 */
export function isTileVisibleForPerspective(tileDoc, tileFlags) {
  const flags = tileFlags || readTileLevelsFlags(tileDoc);

  // If tile has no Levels range, it's always visible (standard Foundry tile)
  if (!tileFlags && !tileHasLevelsRange(tileDoc)) return true;

  return isElevationRangeVisible({
    rangeBottom: flags.rangeBottom,
    rangeTop: flags.rangeTop,
    showIfAbove: flags.showIfAbove,
    showAboveRange: flags.showAboveRange,
    isBasement: flags.isBasement,
  });
}

// ---------------------------------------------------------------------------
//  Light visibility (MS-LVL-040)
// ---------------------------------------------------------------------------

/**
 * Check if an ambient light should be visible based on its elevation range
 * and the current perspective elevation.
 *
 * Ports the algorithm from Levels' `LightHandler.isLightVisibleWrapper`:
 * - `lightMasking=true` (default): light visible if `rangeBottom <= viewerLOS`
 * - `lightMasking=false`: light visible only if viewer is within `[rangeBottom, rangeTop]`
 * - Lights below background elevation are hidden when viewer is above background
 *
 * @param {AmbientLightDocument|object} lightDoc - The light document
 * @returns {boolean} Whether the light should be visible
 */
export function isLightVisibleForPerspective(lightDoc) {
  if (getLevelsCompatibilityMode() === LEVELS_COMPATIBILITY_MODES.OFF) return true;
  if (!lightDoc) return true;

  const perspective = getPerspectiveElevation();

  // No controlled token and no active level: everything visible (matches Levels)
  if (perspective.source === 'background') return true;

  const scene = canvas?.scene ?? null;
  const bgElevation = getSceneBackgroundElevation(scene);
  const lightMasking = getSceneLightMasking(scene);
  const viewerLOS = perspective.losHeight;
  const viewerElevation = perspective.elevation;

  // Read elevation range from the light doc
  const rangeBottom = Number(lightDoc.elevation ?? -Infinity);
  const range = readDocLevelsRange(lightDoc);
  const rangeTop = range.rangeTop;

  // Light below background elevation: hidden if viewer is above background
  // (matches Levels: underBackground check)
  if (viewerLOS >= bgElevation && rangeTop < bgElevation) return false;

  // lightMasking=true (default): light visible if rangeBottom <= viewerLOS
  // This is the simpler mode — lights on the viewer's level or below are visible.
  if (lightMasking) {
    return rangeBottom <= viewerLOS;
  }

  // lightMasking=false: light visible only if viewer is within [rangeBottom, rangeTop]
  return (rangeBottom <= viewerLOS && viewerLOS <= rangeTop);
}

// ---------------------------------------------------------------------------
//  Background elevation visibility (MS-LVL-050)
// ---------------------------------------------------------------------------

/**
 * Check if the scene background should be visible based on the current
 * perspective elevation and the scene's `backgroundElevation` flag.
 *
 * Ports the algorithm from Levels' `BackgroundHandler`:
 * background is visible if the viewer's LOS height >= backgroundElevation.
 * When no controlled token / no active level context, background is always visible.
 *
 * @param {Scene} [scene] - The current scene (defaults to canvas.scene)
 * @returns {boolean} Whether the background should be visible
 */
export function isBackgroundVisibleForPerspective(scene) {
  if (getLevelsCompatibilityMode() === LEVELS_COMPATIBILITY_MODES.OFF) return true;

  const s = scene ?? canvas?.scene;
  if (!s) return true;

  const bgElevation = getSceneBackgroundElevation(s);
  // If background elevation is 0 (default / no flag), background is always visible
  if (bgElevation === 0) return true;

  const perspective = getPerspectiveElevation();
  // No controlled token and no active level: background always visible
  if (perspective.source === 'background') return true;

  return perspective.losHeight >= bgElevation;
}

// ---------------------------------------------------------------------------
//  Weather elevation visibility (MS-LVL-051)
// ---------------------------------------------------------------------------

/**
 * Check if weather effects should be visible based on the current
 * perspective elevation and the scene's `weatherElevation` flag.
 *
 * Weather is visible when the viewer is at or above the weather elevation.
 * When no weatherElevation is set, weather is always visible.
 *
 * @param {Scene} [scene] - The current scene (defaults to canvas.scene)
 * @returns {boolean} Whether weather effects should be visible
 */
export function isWeatherVisibleForPerspective(scene) {
  if (getLevelsCompatibilityMode() === LEVELS_COMPATIBILITY_MODES.OFF) return true;

  const s = scene ?? canvas?.scene;
  if (!s) return true;

  const weatherElev = getSceneWeatherElevation(s);
  // No weather elevation set — weather always visible
  if (weatherElev === null) return true;

  const perspective = getPerspectiveElevation();
  // No controlled token and no active level: weather always visible
  if (perspective.source === 'background') return true;

  return perspective.elevation >= weatherElev;
}

// ---------------------------------------------------------------------------
//  Tile elevation-plane collision (MS-LVL-033)
// ---------------------------------------------------------------------------

/**
 * Check whether a tile's elevation plane blocks vertical movement between
 * two elevations.
 *
 * In Levels, each tile with a finite range acts as a horizontal collision
 * plane at its `rangeBottom` (tile elevation). Movement from elevation A
 * to elevation B is blocked if the tile's plane intersects the [A,B] range
 * AND the tile does not have `noCollision=true`.
 *
 * @param {TileDocument|object} tileDoc - The tile document
 * @param {number} fromElevation - Starting elevation
 * @param {number} toElevation - Target elevation
 * @returns {boolean} True if the tile blocks this vertical movement
 */
export function doesTileBlockElevationMovement(tileDoc, fromElevation, toElevation) {
  if (getLevelsCompatibilityMode() === LEVELS_COMPATIBILITY_MODES.OFF) return false;
  if (!tileDoc) return false;
  if (!tileHasLevelsRange(tileDoc)) return false;

  const flags = readTileLevelsFlags(tileDoc);

  // Tiles with noCollision bypass elevation-plane collision entirely
  if (flags.noCollision) return false;

  const planeElev = flags.rangeBottom;
  if (!Number.isFinite(planeElev)) return false;

  // Check if the tile's elevation plane sits between the two elevations
  const lo = Math.min(fromElevation, toElevation);
  const hi = Math.max(fromElevation, toElevation);

  // Plane must be strictly between the two elevations to block passage
  // (being exactly at one endpoint means you're already on that plane)
  return (planeElev > lo && planeElev < hi);
}

/**
 * Check whether ANY tile in the current scene blocks vertical movement
 * between two elevations at a given XY position.
 *
 * This checks all scene tiles that have Levels range flags and overlap
 * the given Foundry-coordinate position.
 *
 * @param {number} foundryX - Foundry X coordinate (world pixels)
 * @param {number} foundryY - Foundry Y coordinate (world pixels)
 * @param {number} fromElevation - Starting elevation
 * @param {number} toElevation - Target elevation
 * @returns {boolean} True if any tile blocks this movement
 */
export function isElevationMovementBlockedByTiles(foundryX, foundryY, fromElevation, toElevation) {
  if (getLevelsCompatibilityMode() === LEVELS_COMPATIBILITY_MODES.OFF) return false;

  const tiles = canvas?.scene?.tiles;
  if (!tiles) return false;

  for (const tileDoc of tiles) {
    if (!tileDoc) continue;
    if (!tileHasLevelsRange(tileDoc)) continue;

    // Check if the XY position falls within this tile's bounds
    const tx = Number(tileDoc.x ?? 0);
    const ty = Number(tileDoc.y ?? 0);
    const tw = Number(tileDoc.width ?? 0);
    const th = Number(tileDoc.height ?? 0);

    if (foundryX < tx || foundryX > tx + tw) continue;
    if (foundryY < ty || foundryY > ty + th) continue;

    if (doesTileBlockElevationMovement(tileDoc, fromElevation, toElevation)) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
//  Sound audibility (MS-LVL-042)
// ---------------------------------------------------------------------------

/**
 * Check if an ambient sound should be audible based on its elevation range
 * and the current perspective elevation.
 *
 * Ports the algorithm from Levels' `SoundHandler.isAudible`:
 * sound is audible if the viewer elevation is within [rangeBottom, rangeTop].
 *
 * @param {AmbientSoundDocument|object} soundDoc - The sound document
 * @returns {boolean} Whether the sound should be audible
 */
export function isSoundAudibleForPerspective(soundDoc) {
  if (getLevelsCompatibilityMode() === LEVELS_COMPATIBILITY_MODES.OFF) return true;
  if (!soundDoc) return true;

  const perspective = getPerspectiveElevation();

  // No controlled token and no active level: everything audible (matches Levels)
  if (perspective.source === 'background') return true;

  const range = readDocLevelsRange(soundDoc);
  const viewerElevation = perspective.elevation;

  // Sound is audible if viewer elevation is within range
  return (range.rangeBottom <= viewerElevation && viewerElevation <= range.rangeTop);
}
