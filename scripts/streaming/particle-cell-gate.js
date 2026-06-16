/**
 * @fileoverview Particle spawn gating by streaming grid cells + camera view rect.
 * @module streaming/particle-cell-gate
 */

import { getVisibleWorldRect, getVisibleSceneUvRect } from './view-projection-service.js';
import {
  partitionPointsIntoCells,
  getCellsInWorldRect,
  filterSceneUvPointsByRect,
  worldToCellIndex,
  cellKey,
} from './streaming-grid.js';
import { getTextureBudgetTracker } from '../assets/TextureBudgetTracker.js';

/**
 * @typedef {object} ParticleCellGate
 * @property {Map<string, Float32Array>} allCells
 * @property {Set<string>} activeCellKeys
 * @property {number} cellSize
 */

/**
 * Build cell partition from world-space points (stride 3).
 *
 * @param {Float32Array} pointsWorld
 * @param {number} [cellSize]
 * @returns {ParticleCellGate}
 */
export function buildWorldPointCellGate(pointsWorld, cellSize = 0) {
  const cs = cellSize || getTextureBudgetTracker().getRecommendedTileSize();
  const allCells = partitionPointsIntoCells(pointsWorld, cs, 3);
  return {
    allCells,
    activeCellKeys: new Set(allCells.keys()),
    cellSize: cs,
  };
}

/**
 * Build cell partition from scene-UV points (stride 3: u,v,strength).
 *
 * @param {Float32Array} pointsUv
 * @param {number} sceneW
 * @param {number} sceneH
 * @param {number} sceneX
 * @param {number} sceneY
 * @param {number} [cellSize]
 * @returns {ParticleCellGate}
 */
export function buildSceneUvPointCellGate(pointsUv, sceneW, sceneH, sceneX, sceneY, cellSize = 0) {
  const world = new Float32Array(pointsUv.length);
  for (let i = 0; i + 2 < pointsUv.length; i += 3) {
    const u = pointsUv[i];
    const v = pointsUv[i + 1];
    world[i] = sceneX + u * sceneW;
    world[i + 1] = sceneY + (1 - v) * sceneH;
    world[i + 2] = pointsUv[i + 2];
  }
  return buildWorldPointCellGate(world, cellSize);
}

/**
 * Update active cells from camera view rect.
 *
 * @param {ParticleCellGate} gate
 * @param {number} [padding=512]
 * @returns {Set<string>}
 */
export function updateActiveCellsFromView(gate, padding = 512) {
  const view = getVisibleWorldRect(padding);
  if (!view || !gate) return gate?.activeCellKeys ?? new Set();
  const cells = getCellsInWorldRect(view, gate.cellSize);
  gate.activeCellKeys = new Set(cells.map((c) => c.key));
  return gate.activeCellKeys;
}

/**
 * Merge active cell points into one Float32Array (world or UV depending on input gate build).
 *
 * @param {ParticleCellGate} gate
 * @returns {Float32Array}
 */
export function mergeActiveCellPoints(gate) {
  if (!gate?.allCells?.size) return new Float32Array(0);
  const tmp = [];
  for (const key of gate.activeCellKeys) {
    const pts = gate.allCells.get(key);
    if (!pts?.length) continue;
    for (let i = 0; i < pts.length; i += 1) tmp.push(pts[i]);
  }
  return new Float32Array(tmp);
}

/**
 * Filter scene-UV fire/dust points to visible rect (fail-open if empty).
 *
 * @param {Float32Array} pointsUv
 * @param {number} [padding=512]
 * @returns {Float32Array}
 */
export function filterUvPointsToVisibleView(pointsUv, padding = 512) {
  const uvRect = getVisibleSceneUvRect(padding);
  if (!uvRect || !pointsUv?.length) return pointsUv ?? new Float32Array(0);
  const filtered = filterSceneUvPointsByRect(pointsUv, {
    uMin: Math.max(0, uvRect.uMin - 0.05),
    vMin: Math.max(0, uvRect.vMin - 0.05),
    uMax: Math.min(1, uvRect.uMax + 0.05),
    vMax: Math.min(1, uvRect.vMax + 0.05),
  });
  if (filtered.length >= 9) return filtered;
  return pointsUv;
}

/**
 * Apply view-bounds filter to a Quarks emitter shape supporting setViewBoundsUv.
 *
 * @param {{ setViewBoundsUv?: function, points?: Float32Array }} shape
 * @param {number} [padding=512]
 */
export function applyViewBoundsToUvShape(shape, padding = 512) {
  if (!shape || typeof shape.setViewBoundsUv !== 'function') return;
  const uv = getVisibleSceneUvRect(padding);
  if (!uv) return;
  shape.setViewBoundsUv(
    Math.max(0, uv.uMin - 0.02),
    Math.min(1, uv.uMax + 0.02),
    Math.max(0, uv.vMin - 0.02),
    Math.min(1, uv.vMax + 0.02),
  );
}

/**
 * Pause/resume quarks systems by cell activation.
 *
 * @param {Map<string, { system: object, cellKey: string }>} systemsByCell
 * @param {Set<string>} activeKeys
 */
export function gateQuarkSystemsByActiveCells(systemsByCell, activeKeys) {
  if (!systemsByCell) return;
  for (const [key, entry] of systemsByCell) {
    const sys = entry?.system;
    if (!sys) continue;
    const active = activeKeys.has(entry.cellKey ?? key);
    try {
      if (active) sys.play?.();
      else sys.pause?.();
    } catch (_) {}
  }
}

export { worldToCellIndex, cellKey };
