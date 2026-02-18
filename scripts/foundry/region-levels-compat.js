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
import * as sceneSettings from '../settings/scene-settings.js';
import { getLevelsCompatibilityMode, LEVELS_COMPATIBILITY_MODES } from './levels-compatibility.js';
import { isLevelsEnabledForScene } from './levels-scene-flags.js';

const log = createLogger('RegionLevelsCompat');

const REGION_BEHAVIOR_KINDS = Object.freeze({
  STAIR: 'stair',
  STAIR_UP: 'stairUp',
  STAIR_DOWN: 'stairDown',
  ELEVATOR: 'elevator',
});

let patchInstalled = false;
const elevatorDialogsByTokenId = new Map();

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

async function _applyRegionMovement(tokenDocument, elevation, movement) {
  if (!tokenDocument) return false;

  const targetElevation = Number(elevation);
  if (!Number.isFinite(targetElevation)) return false;

  try {
    const pending = movement?.pending?.waypoints;
    const hasPending = Array.isArray(pending) && pending.length > 0 && (typeof tokenDocument.move === 'function');

    if (hasPending) {
      tokenDocument.stopMovement?.();
      if (tokenDocument.rendered && tokenDocument.object?.movementAnimationPromise) {
        await tokenDocument.object.movementAnimationPromise;
      }

      const adjustedWaypoints = pending
        .filter((w) => !w?.intermediate)
        .map((w) => ({ ...w, elevation: targetElevation, action: 'displace' }));

      if (adjustedWaypoints.length > 0) {
        await tokenDocument.move(adjustedWaypoints, {
          ...(movement?.updateOptions || {}),
          constrainOptions: movement?.constrainOptions,
          autoRotate: movement?.autoRotate,
          showRuler: movement?.showRuler,
        });
        return true;
      }
    }

    if (typeof tokenDocument.update === 'function') {
      await tokenDocument.update({ elevation: targetElevation });
      return true;
    }
  } catch (err) {
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

  const tokenDocument = event?.data?.token || null;
  if (!tokenDocument) return;

  const movement = event?.data?.movement || null;

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
    await _applyRegionMovement(tokenDocument, elevation === top ? bottom : top, movement);
    return;
  }

  if (parsed.kind === REGION_BEHAVIOR_KINDS.STAIR_DOWN) {
    if ((elevation > top) || (elevation <= bottom)) return;
    await _applyRegionMovement(tokenDocument, bottom, movement);
    return;
  }

  if (parsed.kind === REGION_BEHAVIOR_KINDS.STAIR_UP) {
    if ((elevation < bottom) || (elevation >= top)) return;
    await _applyRegionMovement(tokenDocument, top, movement);
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
      const doUpdate = () => {
        updatedDoc.update?.({
          elevation: newElevation,
          flags: { levels: { stairUpdate: true } },
        });
      };
      if (animation) {
        animation.then(doUpdate).catch(doUpdate);
      } else {
        doUpdate();
      }
    });
  }
}

export function installLevelsRegionBehaviorCompatPatch() {
  if (patchInstalled) return;

  const ExecuteScriptType = foundry?.data?.regionBehaviors?.ExecuteScriptRegionBehaviorType;
  const proto = ExecuteScriptType?.prototype;
  const original = proto?._handleRegionEvent;
  if (!proto || (typeof original !== 'function')) {
    log.warn('ExecuteScript region behavior class not available; region compat patch not installed yet');
    return;
  }

  if (original.__mapShineRegionCompatWrapped) {
    patchInstalled = true;
    return;
  }

  const wrapped = async function(event) {
    const source = String(this?.source || '');
    const parsed = _parseLevelsRegionBehaviorSource(source);

    if (!parsed) {
      return original.call(this, event);
    }

    const scene = this?.scene || this?.region?.parent || canvas?.scene || null;
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
