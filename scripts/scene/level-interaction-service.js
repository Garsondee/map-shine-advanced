/**
 * @fileoverview Level Interaction Service — stateless utility functions for
 * multi-level interaction filtering.
 *
 * Provides helpers that InteractionManager uses to decide which tokens are
 * eligible for drag-select and when to auto-switch the viewed floor.
 *
 * Design rationale (see docs/planning/MULTI-LEVEL-INTERACTION-ISSUES.md §8-10):
 * - Point interactions (click, hover, target) need NO filtering — Three.js
 *   raycaster already skips invisible sprites and Z-sorts correctly.
 * - Drag-select needs tile-occlusion filtering so tokens hidden under solid
 *   floor graphics are excluded, while tokens visible through transparent
 *   areas (holes, balconies, stairwells) remain selectable.
 * - When all selected tokens end up on a single different floor, the view
 *   auto-switches to that floor for convenience.
 *
 * @module scene/level-interaction-service
 */

import { readTileLevelsFlags, tileHasLevelsRange } from '../foundry/levels-scene-flags.js';

const _tokenLevelSwitchState = new Map();

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

// ---------------------------------------------------------------------------
//  Active-level membership helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a token belongs to the currently active level band.
 *
 * Returns true (token is on this floor) when:
 *   - There is no multi-level context (single-floor scene)
 *   - The token's elevation falls within [bottom, top) of the active band
 *
 * Shared-boundary semantics: elevation == top belongs to the UPPER level,
 * matching VisibilityController._isTokenAboveCurrentLevel.
 *
 * @param {TokenDocument|object} tokenDoc
 * @returns {boolean}
 */
export function isTokenOnActiveLevel(tokenDoc) {
  const levelCtx = window.MapShine?.activeLevelContext;
  if (!levelCtx || (levelCtx.count ?? 0) <= 1) return true;

  const tokenElev = Number(tokenDoc?.elevation ?? 0);
  if (!Number.isFinite(tokenElev)) return true;

  const bottom = Number(levelCtx.bottom);
  const top = Number(levelCtx.top);

  // Token above active level top (shared-boundary: == top is upper floor)
  if (Number.isFinite(top) && tokenElev >= top - 0.01) return false;
  // Token below active level bottom
  if (Number.isFinite(bottom) && tokenElev < bottom) return false;

  return true;
}

/**
 * Check whether a token is below the currently active level band.
 *
 * @param {TokenDocument|object} tokenDoc
 * @returns {boolean}
 */
export function isTokenBelowActiveLevel(tokenDoc) {
  const levelCtx = window.MapShine?.activeLevelContext;
  if (!levelCtx || (levelCtx.count ?? 0) <= 1) return false;

  const tokenElev = Number(tokenDoc?.elevation ?? 0);
  if (!Number.isFinite(tokenElev)) return false;

  const bottom = Number(levelCtx.bottom);
  if (!Number.isFinite(bottom)) return false;

  return tokenElev < bottom;
}

/**
 * Determine whether marquee selection should be restricted to active-level
 * tokens only.
 *
 * Current behavior: when the user is on any upper floor (index > 0), marquee
 * selection is limited to the active floor to avoid selecting hidden/off-floor
 * tokens.
 *
 * @returns {boolean}
 */
export function shouldRestrictMarqueeToActiveLevel() {
  const levelCtx = window.MapShine?.activeLevelContext;
  if (!levelCtx || (levelCtx.count ?? 0) <= 1) return false;

  const levelIndex = Number(levelCtx.index);
  if (Number.isFinite(levelIndex)) return levelIndex > 0;

  const bottom = Number(levelCtx.bottom);
  return Number.isFinite(bottom) && bottom > 0;
}

/**
 * Find which level index a given elevation belongs to, using the camera
 * follower's level bands. Returns -1 if no levels are configured.
 *
 * @param {number} elevation
 * @returns {number} Level index, or -1
 */
export function getLevelIndexForElevation(elevation) {
  const cf = window.MapShine?.cameraFollower;
  if (!cf || typeof cf._findBestLevelIndexForElevation !== 'function') return -1;
  return cf._findBestLevelIndexForElevation(elevation);
}

/**
 * Switch the active level view to the floor that contains the given elevation.
 * Sets lock mode to 'manual' (the user is explicitly choosing a floor).
 *
 * @param {number} elevation
 * @param {string} [reason='level-interaction-auto-switch']
 * @returns {object|null} The new active level context, or null on failure
 */
export function switchToLevelForElevation(elevation, reason = 'level-interaction-auto-switch') {
  const cf = window.MapShine?.cameraFollower;
  if (!cf || typeof cf.setActiveLevel !== 'function') return null;

  const idx = getLevelIndexForElevation(elevation);
  if (idx < 0) return null;

  // Avoid switching if we're already on this level
  const current = cf._activeLevelIndex;
  if (current === idx) return cf._activeLevelContext;

  return cf.setActiveLevel(idx, { reason });
}

/**
 * Schedule a token-scoped level switch and coalesce competing callers.
 *
 * Single-source behavior:
 * - Per token, only the latest requested switch may execute (older requests drop).
 * - Recent duplicate target elevations are ignored (de-jitter).
 * - Optional dwell delay allows visual settle before switching level/camera.
 *
 * @param {TokenDocument|object} tokenDoc
 * @param {number} elevation
 * @param {{
 *  reason?: string,
 *  dwellMs?: number,
 *  dedupeMs?: number,
 *  requireControlled?: boolean
 * }} [options]
 * @returns {Promise<object|null>}
 */
export async function scheduleTokenLevelSwitch(tokenDoc, elevation, options = {}) {
  const tokenId = String(tokenDoc?.id || tokenDoc?._id || '');
  if (!tokenId) return null;

  const target = Number(elevation);
  if (!Number.isFinite(target)) return null;

  const reason = String(options?.reason || 'token-level-switch');
  const dwellMs = Math.max(0, Math.min(5000, Math.round(Number(options?.dwellMs ?? 0) || 0)));
  const dedupeMs = Math.max(0, Math.min(5000, Math.round(Number(options?.dedupeMs ?? 600) || 600)));
  const requireControlled = options?.requireControlled !== false;

  const controlled = Array.isArray(canvas?.tokens?.controlled) ? canvas.tokens.controlled : [];
  if (requireControlled) {
    const isControlled = controlled.some((t) => String(t?.document?.id || t?.id || '') === tokenId);
    if (!isControlled) return null;
  }

  const existing = _tokenLevelSwitchState.get(tokenId) || {
    seq: 0,
    lastAppliedAt: 0,
    lastElevation: NaN
  };
  const seq = Number(existing.seq || 0) + 1;
  _tokenLevelSwitchState.set(tokenId, { ...existing, seq });

  if (dwellMs > 0) await _sleep(dwellMs);

  const latest = _tokenLevelSwitchState.get(tokenId);
  if (!latest || Number(latest.seq || 0) !== seq) return null;

  if (requireControlled) {
    const controlledNow = Array.isArray(canvas?.tokens?.controlled) ? canvas.tokens.controlled : [];
    const stillControlled = controlledNow.some((t) => String(t?.document?.id || t?.id || '') === tokenId);
    if (!stillControlled) return null;
  }

  const now = Date.now();
  const sameTarget = Number.isFinite(Number(latest.lastElevation))
    && Math.abs(Number(latest.lastElevation) - target) <= 0.001;
  const recent = (now - Number(latest.lastAppliedAt || 0)) < dedupeMs;
  if (sameTarget && recent) return null;

  const switched = switchToLevelForElevation(target, reason);
  _tokenLevelSwitchState.set(tokenId, {
    ...latest,
    lastAppliedAt: now,
    lastElevation: target
  });
  return switched;
}

// ---------------------------------------------------------------------------
//  Tile occlusion — is a token hidden under a solid floor graphic?
// ---------------------------------------------------------------------------

/**
 * Check whether a token at the given world position is visually occluded by
 * a floor tile between the token's elevation and the viewer (active level).
 *
 * Used by drag-select to exclude tokens that are hidden under solid floor
 * graphics, while allowing tokens visible through transparent areas (holes,
 * stairwells, balconies) to remain selectable.
 *
 * @param {TokenDocument|object} tokenDoc - Token document (needs .elevation)
 * @param {number} worldX - Three.js world X coordinate of the token center
 * @param {number} worldY - Three.js world Y coordinate of the token center
 * @param {import('./tile-manager.js').TileManager} tileManager
 * @returns {boolean} True if the token is covered by an opaque tile (should be excluded)
 */
export function isTokenOccludedByFloorAbove(tokenDoc, worldX, worldY, tileManager) {
  // No tile manager or no alpha-testing capability → fail-open (not occluded)
  if (!tileManager || typeof tileManager.isWorldPointOpaque !== 'function') return false;

  const levelCtx = window.MapShine?.activeLevelContext;
  if (!levelCtx || (levelCtx.count ?? 0) <= 1) return false;

  const tokenElev = Number(tokenDoc?.elevation ?? 0);
  if (!Number.isFinite(tokenElev)) return false;

  const bandTop = Number(levelCtx.top);
  if (!Number.isFinite(bandTop)) return false;

  // Iterate all tiles and check if any tile between the token and the viewer
  // covers this position with an opaque pixel.
  for (const [_tileId, data] of tileManager.tileSprites) {
    if (!data?.sprite || !data?.tileDoc) continue;

    // Skip invisible tiles (already hidden by level filtering or GM hidden)
    if (!data.sprite.visible) continue;

    // Determine the tile's elevation range
    let tileBottom;
    if (tileHasLevelsRange(data.tileDoc)) {
      const flags = readTileLevelsFlags(data.tileDoc);
      tileBottom = Number(flags.rangeBottom);
    } else {
      tileBottom = Number(data.tileDoc?.elevation ?? 0);
    }
    if (!Number.isFinite(tileBottom)) continue;

    // The tile must be ABOVE the token's elevation to occlude it.
    // It must also be AT or BELOW the active level top to be part of the
    // visible scene (tiles above the active band are already hidden).
    if (tileBottom <= tokenElev) continue;
    if (tileBottom > bandTop) continue;

    // Alpha test: is this tile opaque at the token's world position?
    try {
      if (tileManager.isWorldPointOpaque(data, worldX, worldY)) {
        return true; // Solid floor covers this token
      }
    } catch (_) {
      // Alpha test failed — fail-open (not occluded by this tile)
    }
  }

  // No tile covers this position → token is visible (e.g., through a gap)
  return false;
}

// ---------------------------------------------------------------------------
//  Drag-select filtering
// ---------------------------------------------------------------------------

/**
 * Determine whether a token sprite should be included in a drag-select action.
 *
 * Rules:
 * 1. Invisible sprites are always excluded.
 * 2. Tokens on the active level are always included.
 * 3. Optionally, selection can be restricted to active-level tokens only.
 * 4. Optionally, off-floor selection can be limited to lower-floor tokens.
 * 5. Otherwise, off-floor tokens are included only when NOT occluded by a
 *    floor tile above them (i.e., visible through a transparent area).
 *
 * @param {THREE.Sprite} sprite - Token sprite with userData.tokenDoc
 * @param {import('./tile-manager.js').TileManager} tileManager
 * @param {{ activeLevelOnly?: boolean, allowBelowOnly?: boolean }} [options]
 * @returns {boolean}
 */
export function isTokenDragSelectable(sprite, tileManager, options = {}) {
  if (!sprite?.visible) return false;

  const tokenDoc = sprite.userData?.tokenDoc;
  if (!tokenDoc) return false;

  const activeLevelOnly = !!options.activeLevelOnly;
  const allowBelowOnly = !!options.allowBelowOnly;

  // Tokens on the active level are always selectable
  if (isTokenOnActiveLevel(tokenDoc)) return true;

  if (activeLevelOnly) return false;
  if (allowBelowOnly && !isTokenBelowActiveLevel(tokenDoc)) return false;

  // Token is on a different floor — check if it's hidden under a tile
  return !isTokenOccludedByFloorAbove(
    tokenDoc,
    sprite.position.x,
    sprite.position.y,
    tileManager
  );
}

/**
 * After drag-select completes, determine if ALL selected tokens are on a single
 * floor that is different from the current floor. If so, returns that floor's
 * elevation so the caller can auto-switch.
 *
 * Returns null if:
 * - No tokens selected
 * - Tokens span multiple floors
 * - All tokens are already on the active floor
 *
 * @param {Array<TokenDocument|object>} tokenDocs - Selected token documents
 * @returns {number|null} The common elevation to switch to, or null
 */
export function getAutoSwitchElevation(tokenDocs) {
  if (!tokenDocs || tokenDocs.length === 0) return null;

  const levelCtx = window.MapShine?.activeLevelContext;
  if (!levelCtx || (levelCtx.count ?? 0) <= 1) return null;

  let commonLevelIndex = null;
  let anyOnActiveLevel = false;

  for (const doc of tokenDocs) {
    const elev = Number(doc?.elevation ?? 0);
    if (!Number.isFinite(elev)) return null; // Can't determine floor → no switch

    if (isTokenOnActiveLevel(doc)) {
      anyOnActiveLevel = true;
      break; // Mixed selection (some on active floor) → don't switch
    }

    const idx = getLevelIndexForElevation(elev);
    if (idx < 0) return null;

    if (commonLevelIndex === null) {
      commonLevelIndex = idx;
    } else if (commonLevelIndex !== idx) {
      return null; // Tokens on different non-active floors → don't switch
    }
  }

  // If any token is on the active level, don't switch
  if (anyOnActiveLevel) return null;

  // All tokens are on the same non-active floor
  if (commonLevelIndex !== null) {
    // Return the elevation of the first token as the switch target
    return Number(tokenDocs[0]?.elevation ?? 0);
  }

  return null;
}
