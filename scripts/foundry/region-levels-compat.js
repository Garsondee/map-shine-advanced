/**
 * @fileoverview Levels region behavior compatibility patch.
 *
 * Supports imported Levels executeScript region behaviors when the Levels
 * runtime is not active by intercepting known RegionHandler scripts:
 * - stair
 * - stairUp
 * - stairDown
 * - elevator
 *
 * @module foundry/region-levels-compat
 */

import { createLogger } from '../core/log.js';
import { moveTrace } from '../core/movement-trace-log.js';
import * as sceneSettings from '../settings/scene-settings.js';
import { getLevelsCompatibilityMode, LEVELS_COMPATIBILITY_MODES } from './levels-compatibility.js';
import { isLevelsEnabledForScene } from './levels-scene-flags.js';
import { switchToLevelForElevation } from '../scene/level-interaction-service.js';

const log = createLogger('RegionLevelsCompat');

const REGION_BEHAVIOR_KINDS = Object.freeze({
  STAIR: 'stair',
  STAIR_UP: 'stairUp',
  STAIR_DOWN: 'stairDown',
  ELEVATOR: 'elevator',
});

let patchInstalled = false;
const elevatorDialogsByTokenId = new Map();
const STAIR_TRANSITION_PAUSE_MS = 220;
const STAIR_FLOOR_FOLLOW_SUPPRESSION_BUFFER_MS = 800;

let _pendingRetryHookId = null;

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function _isTokenControlled(tokenDocument) {
  const tokenId = String(tokenDocument?.id || tokenDocument?._id || '');
  if (!tokenId) return false;
  const controlled = Array.isArray(canvas?.tokens?.controlled) ? canvas.tokens.controlled : [];
  return controlled.some((token) => String(token?.document?.id || token?.id || '') === tokenId);
}

function _beginStairFloorFollowSuppression(tokenDocument, reason = 'stair-transition') {
  const tokenId = String(tokenDocument?.id || tokenDocument?._id || '');
  if (!tokenId) return false;
  try {
    window.MapShine?.cameraFollower?.beginFloorFollowSuppression?.(tokenId, {
      durationMs: STAIR_TRANSITION_PAUSE_MS + STAIR_FLOOR_FOLLOW_SUPPRESSION_BUFFER_MS,
      reason,
    });
    return true;
  } catch (_) {
    return false;
  }
}

function _endStairFloorFollowSuppression(tokenDocument) {
  const tokenId = String(tokenDocument?.id || tokenDocument?._id || '');
  if (!tokenId) return;
  try {
    window.MapShine?.cameraFollower?.endFloorFollowSuppression?.(tokenId);
  } catch (_) {
  }
}

function _followControlledTokenFloorAfterStair(tokenDocument, elevation, reason = 'region-levels-stair-follow') {
  if (!_isTokenControlled(tokenDocument)) return;
  const target = Number(elevation);
  if (!Number.isFinite(target)) return;
  switchToLevelForElevation(target + 0.001, reason);
}

function _getExecuteScriptRegionBehaviorProto() {
  try {
    const ExecuteScriptType = foundry?.data?.regionBehaviors?.ExecuteScriptRegionBehaviorType
      ?? foundry?.data?.regionBehaviors?.ExecuteScriptRegionBehavior
      ?? globalThis?.foundry?.data?.regionBehaviors?.ExecuteScriptRegionBehaviorType;
    const proto = ExecuteScriptType?.prototype;
    if (!proto) return null;
    if (typeof proto._handleRegionEvent !== 'function') return null;
    return proto;
  } catch (_) {
    return null;
  }
}

function _getBehaviorSourceText(behaviorInstance) {
  try {
    // Foundry/region behavior internals have shifted between versions.
    // Levels writes scripts that reference RegionHandler.*; we only need
    // the source text to pattern-match those calls.
    return String(
      behaviorInstance?.source
        ?? behaviorInstance?.script
        ?? behaviorInstance?.data?.source
        ?? behaviorInstance?.data?.script
        ?? ''
    );
  } catch (_) {
    return '';
  }
}

function _resolveEventTokenDocument(event) {
  try {
    const maybe = event?.data?.token
      ?? event?.data?.tokenDocument
      ?? event?.token
      ?? event?.tokenDocument
      ?? null;
    return maybe?.document ?? maybe;
  } catch (_) {
    return null;
  }
}

function _parseEscapedString(value, quote) {
  let text = String(value);
  const escapedQuote = `\\${quote}`;
  text = text.replaceAll(escapedQuote, quote);
  text = text.replaceAll('\\n', '\n');
  text = text.replaceAll('\\r', '\r');
  text = text.replaceAll('\\t', '\t');
  text = text.replaceAll('\\\\', '\\');
  return text;
}

function _parseStringLiteral(argSource) {
  const raw = String(argSource || '').trim();
  if (raw.length < 2) return null;

  const quote = raw[0];
  if ((quote !== '"') && (quote !== "'") && (quote !== '`')) return null;
  if (raw[raw.length - 1] !== quote) return null;

  return _parseEscapedString(raw.slice(1, -1), quote);
}

function _parseElevatorFloors(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];

  const out = [];
  const seen = new Set();

  for (const floorPart of text.split('|')) {
    const part = String(floorPart || '').trim();
    if (!part) continue;

    const chunks = part.split(',');
    const elevation = Number(chunks[0]);
    if (!Number.isFinite(elevation)) continue;

    const label = String(chunks.slice(1).join(',') || `Floor ${elevation}`)
      .trim() || `Floor ${elevation}`;

    const key = `${elevation}:${label}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ elevation, label });
  }

  return out;
}

function _parseLevelsRegionBehaviorSource(source) {
  const text = String(source || '');
  if (!text) return null;
  if (!text.includes('RegionHandler.')) return null;

  if (/\bRegionHandler\.stairDown\s*\(/i.test(text)) {
    return { kind: REGION_BEHAVIOR_KINDS.STAIR_DOWN, elevatorFloors: [] };
  }
  if (/\bRegionHandler\.stairUp\s*\(/i.test(text)) {
    return { kind: REGION_BEHAVIOR_KINDS.STAIR_UP, elevatorFloors: [] };
  }
  if (/\bRegionHandler\.stair\s*\(/i.test(text)) {
    return { kind: REGION_BEHAVIOR_KINDS.STAIR, elevatorFloors: [] };
  }

  const elevatorMatch = text.match(/\bRegionHandler\.elevator\s*\(\s*region\s*,\s*event\s*,\s*([^)]+)\)/i);
  if (elevatorMatch) {
    const floorLiteral = _parseStringLiteral(elevatorMatch[1]);
    return {
      kind: REGION_BEHAVIOR_KINDS.ELEVATOR,
      elevatorFloors: _parseElevatorFloors(floorLiteral),
    };
  }

  return null;
}

function _sameUser(event) {
  const currentId = game?.user?.id;
  const eventId = event?.user?.id;
  if (!currentId || !eventId) return true;
  return currentId === eventId;
}

function _closeElevatorDialog(tokenId) {
  const key = String(tokenId || '');
  if (!key) return;

  const dialog = elevatorDialogsByTokenId.get(key);
  if (!dialog) return;

  try {
    dialog.close?.();
  } catch (_) {
  }
  elevatorDialogsByTokenId.delete(key);
}

function _normalizeStairElevation(raw, region) {
  let n = Number(raw);
  if (!Number.isFinite(n)) return raw;

  try {
    const b = Number(region?.elevation?.bottom);
    const t = Number(region?.elevation?.top);
    if (Number.isFinite(b) && Math.abs(n - b) < 0.02) n = b;
    if (Number.isFinite(t) && Math.abs(n - t) < 0.02) n = t;
  } catch (_) {
  }

  const r = Math.round(n);
  if (Math.abs(n - r) < 0.02) n = r;
  return n;
}

function _syncMapShineTokenAfterDocElevation(tokenDocument, elevation) {
  try {
    const tm = window.MapShine?.tokenManager;
    if (tm?.updateTokenSprite && tokenDocument) {
      tm.updateTokenSprite(tokenDocument, { elevation }, { animate: false });
    }
  } catch (_) {
  }
  try {
    const t = canvas?.tokens?.get?.(tokenDocument?.id);
    t?.refresh?.();
  } catch (_) {
  }
}

function _resyncMapShineMovementSprite(tokenDocument, reason = 'region-levels-compat') {
  const tokenId = String(tokenDocument?.id || tokenDocument?._id || '');
  if (!tokenId) return;
  try {
    window.MapShine?.tokenManager?.movementManager?.resyncSpriteToDocument?.(
      tokenId,
      tokenDocument,
      { reason }
    );
  } catch (_) {
  }
}

async function _awaitTokenMovementAnimation(tokenDocument) {
  const obj = tokenDocument?.object;
  if (!tokenDocument?.rendered || !obj?.movementAnimationPromise) return;
  try {
    await obj.movementAnimationPromise;
  } catch (_) {
  }
}

/**
 * @param {object|null} movement - Foundry region event movement payload (optional)
 * @param {object|null} region - Region document (optional, for elevation snapping)
 */
async function _applyRegionMovement(tokenDocument, elevation, movement, region = null) {
  if (!tokenDocument) return false;

  const targetElevation = _normalizeStairElevation(Number(elevation), region);
  if (!Number.isFinite(Number(targetElevation))) return false;

  try {
    const hasMovementContext = !!movement;
    const pendingWaypointsRaw = movement?.pending?.waypoints;
    const pendingSnapshot = Array.isArray(pendingWaypointsRaw)
      ? pendingWaypointsRaw.filter((w) => !w?.intermediate).map((w) => ({ ...w }))
      : [];

    moveTrace('regionStair.apply.start', {
      tokenId: String(tokenDocument?.id || ''),
      targetElevation,
      hasMovementContext,
      docXYE: {
        x: tokenDocument?.x,
        y: tokenDocument?.y,
        elevation: tokenDocument?.elevation
      },
      pendingCount: pendingSnapshot.length,
      passedCount: Array.isArray(movement?.passed?.waypoints) ? movement.passed.waypoints.length : -1,
      regionId: region?.id ?? region?._id ?? null
    });

    // Mirror Levels `RegionHandler.updateMovement`: waiving this path and only calling
    // `update({ elevation })` during an active checkpointed `move()` leaves pending
    // horizontal waypoints evaluated at the wrong elevation (lower-floor walls, route
    // truncation). Snapshot `pending` from the region event, stop the in-flight route,
    // pause for UX, then re-issue `move()` with displace waypoints at the stair elevation
    // and Foundry's original constrain options.
    if (hasMovementContext) {
      await _awaitTokenMovementAnimation(tokenDocument);

      if (typeof tokenDocument.stopMovement === 'function') {
        tokenDocument.stopMovement();
      }

      await _awaitTokenMovementAnimation(tokenDocument);
      moveTrace('regionStair.afterStopMovement', {
        tokenId: String(tokenDocument?.id || ''),
        pendingSnapshotCount: pendingSnapshot.length
      });
      _resyncMapShineMovementSprite(tokenDocument, 'region-stair-after-stopMovement');

      await _sleep(STAIR_TRANSITION_PAUSE_MS);

      const hasSuppression = _beginStairFloorFollowSuppression(tokenDocument, 'region-stair-transition');
      try {
        if (pendingSnapshot.length > 0 && typeof tokenDocument.move === 'function') {
          const adjustedWaypoints = pendingSnapshot.map((w) => ({
            ...w,
            elevation: targetElevation,
            action: 'displace',
          }));

          moveTrace('regionStair.foundryMove.pending', {
            tokenId: String(tokenDocument?.id || ''),
            adjustedCount: adjustedWaypoints.length,
            firstAdj: adjustedWaypoints[0],
            lastAdj: adjustedWaypoints[adjustedWaypoints.length - 1]
          });
          await tokenDocument.move(adjustedWaypoints, {
            ...(movement?.updateOptions || {}),
            constrainOptions: movement?.constrainOptions ?? {},
            autoRotate: movement?.autoRotate,
            showRuler: movement?.showRuler,
          });
        } else if (typeof tokenDocument.update === 'function') {
          moveTrace('regionStair.updateElevationOnly', {
            tokenId: String(tokenDocument?.id || ''),
            targetElevation
          });
          await tokenDocument.update({ elevation: targetElevation });
        } else {
          moveTrace('regionStair.apply.abort', { reason: 'no-move-no-update' });
          return false;
        }

        _syncMapShineTokenAfterDocElevation(tokenDocument, targetElevation);
        _resyncMapShineMovementSprite(tokenDocument, 'region-stair-after-transition');
        moveTrace('regionStair.apply.done', {
          tokenId: String(tokenDocument?.id || ''),
          targetElevation,
          docXYE: {
            x: tokenDocument?.x,
            y: tokenDocument?.y,
            elevation: tokenDocument?.elevation
          }
        });
        _followControlledTokenFloorAfterStair(tokenDocument, targetElevation, 'region-stair-floor-follow');
        return true;
      } finally {
        if (hasSuppression) _endStairFloorFollowSuppression(tokenDocument);
      }
    }

    if (typeof tokenDocument.update === 'function') {
      await _sleep(STAIR_TRANSITION_PAUSE_MS);
      const hasSuppression = _beginStairFloorFollowSuppression(tokenDocument, 'region-direct-transition');
      try {
        await tokenDocument.update({ elevation: targetElevation });
        _syncMapShineTokenAfterDocElevation(tokenDocument, targetElevation);
        _resyncMapShineMovementSprite(tokenDocument, 'region-direct-after-elevation');
        _followControlledTokenFloorAfterStair(tokenDocument, targetElevation, 'region-direct-floor-follow');
        return true;
      } finally {
        if (hasSuppression) _endStairFloorFollowSuppression(tokenDocument);
      }
    }
  } catch (err) {
    moveTrace('regionStair.apply.error', {
      tokenId: String(tokenDocument?.id || ''),
      message: err?.message || String(err)
    });
    log.warn('Failed to apply region elevation movement', err);
  }

  return false;
}

function _renderElevatorDialog(tokenDocument, floors, movement) {
  if (!tokenDocument || !Array.isArray(floors) || floors.length === 0) return;

  const tokenId = String(tokenDocument.id || '');
  _closeElevatorDialog(tokenId);

  const buttons = {};
  for (let i = 0; i < floors.length; i += 1) {
    const floor = floors[i];
    if (!floor || !Number.isFinite(floor.elevation)) continue;

    buttons[`floor_${i}`] = {
      label: `${floor.label} (${floor.elevation})`,
      callback: async () => {
        await _applyRegionMovement(tokenDocument, floor.elevation, movement);
      },
    };
  }

  buttons.cancel = {
    label: 'Cancel',
    callback: () => {},
  };

  const dialog = new Dialog({
    title: 'Elevator',
    content: '<p>Select destination floor:</p>',
    buttons,
    default: 'cancel',
    close: () => {
      elevatorDialogsByTokenId.delete(tokenId);
    },
  });

  elevatorDialogsByTokenId.set(tokenId, dialog);
  dialog.render(true);
}

async function _handleLevelsRegionBehavior(parsed, region, event) {
  if (!parsed || !region || !event) return;
  if (!_sameUser(event)) return;

  const tokenDocument = _resolveEventTokenDocument(event);
  if (!tokenDocument) return;

  const movement = event?.data?.movement || null;
  moveTrace('regionCompat.event', {
    kind: parsed?.kind,
    regionId: region?.id ?? region?._id,
    tokenId: String(tokenDocument?.id || ''),
    eventName: event?.name || event?.type || '(unknown)',
    hasMovement: !!movement
  });

  let bottom = Number(region?.elevation?.bottom);
  let top = Number(region?.elevation?.top);
  if (!Number.isFinite(bottom)) bottom = -Infinity;
  if (!Number.isFinite(top)) top = Infinity;
  if (top < bottom) {
    const swap = bottom;
    bottom = top;
    top = swap;
  }

  const elevation = Number(tokenDocument?.elevation);
  if (!Number.isFinite(elevation)) return;

  if (parsed.kind === REGION_BEHAVIOR_KINDS.STAIR) {
    if ((elevation !== bottom) && (elevation !== top)) return;
    await _applyRegionMovement(tokenDocument, elevation === top ? bottom : top, movement, region);
    return;
  }

  if (parsed.kind === REGION_BEHAVIOR_KINDS.STAIR_DOWN) {
    if ((elevation > top) || (elevation <= bottom)) return;
    await _applyRegionMovement(tokenDocument, bottom, movement, region);
    return;
  }

  if (parsed.kind === REGION_BEHAVIOR_KINDS.STAIR_UP) {
    if ((elevation < bottom) || (elevation >= top)) return;
    await _applyRegionMovement(tokenDocument, top, movement, region);
    return;
  }

  if (parsed.kind === REGION_BEHAVIOR_KINDS.ELEVATOR) {
    if ((elevation > top) || (elevation < bottom)) return;
    _renderElevatorDialog(tokenDocument, parsed.elevatorFloors, movement);
  }
}

// ---------------------------------------------------------------------------
//  MS-LVL-083: Legacy drawing-based stairs
// ---------------------------------------------------------------------------

// Levels drawing mode constants (from drawingHandler.js)
const DRAWING_MODE_STAIR = 2;
const DRAWING_MODE_STAIR_DOWN = 21;
const DRAWING_MODE_STAIR_UP = 22;
const DRAWING_MODE_ELEVATOR = 3;

let drawingStairHookId = null;

/**
 * Track which stair drawing each token is currently inside, so we don't
 * re-trigger the stair on every sub-movement within the same drawing.
 * @type {Map<string, string>}
 */
const tokenInStairMap = new Map();

/**
 * Collect all legacy stair drawings in the current scene.
 * Returns an array of {drawingDoc, polygon, range, drawingMode} objects.
 *
 * @returns {Array<{drawingDoc: object, range: [number, number], drawingMode: number, bounds: {x:number,y:number,w:number,h:number}}>}
 */
function _getLegacyStairDrawings() {
  const stairs = [];
  const drawings = canvas?.scene?.drawings;
  if (!drawings) return stairs;

  for (const drawingDoc of drawings) {
    if (!drawingDoc) continue;
    const drawingMode = Number(drawingDoc.flags?.levels?.drawingMode ?? 0);
    if (drawingMode !== DRAWING_MODE_STAIR && drawingMode !== DRAWING_MODE_STAIR_DOWN
        && drawingMode !== DRAWING_MODE_STAIR_UP && drawingMode !== DRAWING_MODE_ELEVATOR) {
      continue;
    }

    const stairLocked = drawingDoc.flags?.levels?.stairLocked === true;
    if (stairLocked) continue;

    const rangeBottom = Number(drawingDoc.elevation ?? -Infinity);
    const rangeTop = Number(drawingDoc.flags?.levels?.rangeTop ?? Infinity);
    if (!Number.isFinite(rangeBottom) || !Number.isFinite(rangeTop)) continue;

    const shape = drawingDoc.shape || {};
    const x = Number(drawingDoc.x ?? 0);
    const y = Number(drawingDoc.y ?? 0);
    const w = Number(shape.width ?? drawingDoc.width ?? 0);
    const h = Number(shape.height ?? drawingDoc.height ?? 0);
    if (w <= 0 || h <= 0) continue;

    stairs.push({
      drawingDoc,
      range: [Math.min(rangeBottom, rangeTop), Math.max(rangeBottom, rangeTop) + 1],
      drawingMode,
      bounds: { x, y, w, h },
    });
  }

  return stairs;
}

/**
 * Check if a point is inside a drawing's bounds (simple AABB test).
 * Levels uses PIXI.Polygon with adjustPolygonPoints — we use a simpler
 * bounding box test since most stair drawings are rectangles.
 *
 * @param {number} px - Token center X
 * @param {number} py - Token center Y
 * @param {{x:number,y:number,w:number,h:number}} bounds
 * @returns {boolean}
 */
function _pointInDrawingBounds(px, py, bounds) {
  return px >= bounds.x && px <= bounds.x + bounds.w
      && py >= bounds.y && py <= bounds.y + bounds.h;
}

/**
 * Handle legacy drawing-based stair transitions on token update.
 * Called from an `updateToken` hook when the token's position changes.
 *
 * @param {TokenDocument} tokenDoc
 * @param {object} changes
 */
async function _handleLegacyDrawingStairs(tokenDoc, changes) {
  // Only respond to position changes
  if (!('x' in changes) && !('y' in changes)) return;
  // Skip if this is itself a stair update (avoid recursion)
  if (changes?.flags?.levels?.stairUpdate) return;

  if (getLevelsCompatibilityMode() === LEVELS_COMPATIBILITY_MODES.OFF) return;
  if (!isLevelsEnabledForScene(canvas?.scene)) return;

  const stairs = _getLegacyStairDrawings();
  if (!stairs.length) return;

  const tokenId = String(tokenDoc.id || '');
  const gridSize = Number(canvas?.scene?.grid?.size ?? canvas?.scene?.dimensions?.size ?? 100);
  const tokenWidth = Number(tokenDoc.width ?? 1);
  const tokenHeight = Number(tokenDoc.height ?? 1);

  // Compute the token center at its new position
  const tokenX = Number(changes.x ?? tokenDoc.x ?? 0);
  const tokenY = Number(changes.y ?? tokenDoc.y ?? 0);
  const centerX = tokenX + (gridSize * tokenWidth) / 2;
  const centerY = tokenY + (gridSize * tokenHeight) / 2;

  const tokenElev = Number(changes.elevation ?? tokenDoc.elevation ?? 0);

  let inStairId = null;
  let newElevation = null;

  for (const stair of stairs) {
    if (!_pointInDrawingBounds(centerX, centerY, stair.bounds)) continue;

    const stairId = String(stair.drawingDoc.id || '');

    // Already in this stair — don't re-trigger
    if (tokenInStairMap.get(tokenId) === stairId) {
      inStairId = stairId;
      continue;
    }

    const [lo, hi] = stair.range;

    if (stair.drawingMode === DRAWING_MODE_STAIR) {
      // Toggle: if at top, go to bottom; if at bottom, go to top
      if (tokenElev >= lo && tokenElev <= hi) {
        if (tokenElev === hi - 1) { // rangeTop+1 offset
          newElevation = lo;
          inStairId = stairId;
        } else if (tokenElev === lo) {
          newElevation = hi - 1;
          inStairId = stairId;
        }
      }
    } else if (stair.drawingMode === DRAWING_MODE_STAIR_DOWN) {
      // Go to bottom when at top
      if (tokenElev >= lo && tokenElev <= hi && tokenElev === hi - 1) {
        newElevation = lo;
        inStairId = stairId;
      }
    } else if (stair.drawingMode === DRAWING_MODE_STAIR_UP) {
      // Go to top when at bottom
      if (tokenElev >= lo && tokenElev <= hi && tokenElev === lo) {
        newElevation = hi - 1;
        inStairId = stairId;
      }
    } else if (stair.drawingMode === DRAWING_MODE_ELEVATOR) {
      // Show elevator dialog
      if (tokenElev >= lo && tokenElev <= hi) {
        inStairId = stairId;
        const floorsStr = stair.drawingDoc.flags?.levels?.elevatorFloors || '';
        const floors = _parseElevatorFloors(floorsStr);
        if (floors.length > 0) {
          _renderElevatorDialog(tokenDoc, floors, null);
        }
      }
    }

    if (newElevation !== null || inStairId) break;
  }

  // Update the tracking map
  if (inStairId) {
    tokenInStairMap.set(tokenId, inStairId);
  } else {
    tokenInStairMap.delete(tokenId);
    _closeElevatorDialog(tokenId);
  }

  // Apply the elevation change after the current update completes
  if (newElevation !== null && Number.isFinite(newElevation)) {
    log.info(`[MS-LVL-083] Legacy drawing stair: token ${tokenId} → elevation ${newElevation}`);
    // Wait for the current animation to finish, then apply
    Hooks.once('updateToken', (updatedDoc) => {
      if (String(updatedDoc.id) !== tokenId) return;
      const animation = canvas?.tokens?.get?.(tokenId)?._animation;
      const doUpdate = async () => {
        await _sleep(STAIR_TRANSITION_PAUSE_MS);
        const hasSuppression = _beginStairFloorFollowSuppression(updatedDoc, 'legacy-drawing-stair-transition');
        try {
          await updatedDoc.update?.({
            elevation: newElevation,
            flags: { levels: { stairUpdate: true } },
          });
          _syncMapShineTokenAfterDocElevation(updatedDoc, newElevation);
          _resyncMapShineMovementSprite(updatedDoc, 'legacy-drawing-stair-after-elevation');
          _followControlledTokenFloorAfterStair(updatedDoc, newElevation, 'legacy-drawing-stair-floor-follow');
        } finally {
          if (hasSuppression) _endStairFloorFollowSuppression(updatedDoc);
        }
      };
      if (animation) {
        animation.then(() => doUpdate()).catch(() => doUpdate());
      } else {
        void doUpdate();
      }
    });
  }
}

export function installLevelsRegionBehaviorCompatPatch() {
  if (patchInstalled) return;

  const proto = _getExecuteScriptRegionBehaviorProto();
  const original = proto?._handleRegionEvent;
  if (!proto || (typeof original !== 'function')) {
    // This can run before Foundry has fully initialized region behavior classes.
    // If we fail to install here and never retry, Levels stair Regions become inert.
    if (!_pendingRetryHookId) {
      _pendingRetryHookId = Hooks.once('ready', () => {
        _pendingRetryHookId = null;
        installLevelsRegionBehaviorCompatPatch();
      });
    }
    log.warn('ExecuteScript region behavior class not available; will retry install at ready');
    return;
  }

  if (original.__mapShineRegionCompatWrapped) {
    patchInstalled = true;
    return;
  }

  const wrapped = async function(event) {
    const source = _getBehaviorSourceText(this);
    const parsed = _parseLevelsRegionBehaviorSource(source);

    if (!parsed) {
      return original.call(this, event);
    }

    const scene = this?.scene || this?.region?.parent || this?.region?.scene || canvas?.scene || null;
    if (!sceneSettings.isEnabled(scene)) return;
    if (getLevelsCompatibilityMode() === LEVELS_COMPATIBILITY_MODES.OFF) return;
    if (!isLevelsEnabledForScene(scene)) return;

    try {
      await _handleLevelsRegionBehavior(parsed, this?.region, event);
    } catch (err) {
      log.warn('Levels region behavior compatibility handler failed', err);
    }
  };

  wrapped.__mapShineRegionCompatWrapped = true;
  proto._handleRegionEvent = wrapped;

  // MS-LVL-083: Install updateToken hook for legacy drawing-based stairs.
  // This runs alongside the region-based stair patch so both old (drawing)
  // and new (region) Levels stair formats work in Map Shine gameplay mode.
  if (!drawingStairHookId) {
    drawingStairHookId = Hooks.on('updateToken', (tokenDoc, changes) => {
      _handleLegacyDrawingStairs(tokenDoc, changes).catch((err) => {
        log.warn('[MS-LVL-083] Legacy drawing stair handler error', err);
      });
    });
  }

  patchInstalled = true;
  log.info('Installed ExecuteScript region behavior compatibility patch for Levels stair/elevator scripts');
  log.info('Installed legacy drawing-based stair hook (MS-LVL-083)');
}
