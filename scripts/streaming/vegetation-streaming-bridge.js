/**
 * @fileoverview Bridge tile streaming cell visibility to vegetation overlays (Tree/Bush).
 * @module streaming/vegetation-streaming-bridge
 */

import { getTextureBudgetTracker } from '../assets/TextureBudgetTracker.js';
import { estimateSceneMegapixels } from './texture-budget-policy.js';
import { getSceneRegionFromFoundryData } from './view-projection-service.js';
import { imageCellToWorldBounds } from './streamed-background-grid.js';
import { getTileStreamingManager } from './tile-streaming-manager.js';

/**
 * True when background tree/bush overlays should wait for streamed tiles.
 * @param {number} sceneW
 * @param {number} sceneH
 * @returns {boolean}
 */
export function shouldGateBackgroundVegetationOnStreaming(sceneW, sceneH) {
  const mp = estimateSceneMegapixels();
  if (mp >= 64) return true;
  return Math.max(Number(sceneW) || 0, Number(sceneH) || 0) > 4096;
}

/**
 * @param {number} cellX
 * @param {number} cellY
 * @param {number} cellSize
 * @param {number} sourceW
 * @param {number} sourceH
 * @returns {{ u0: number, v0: number, u1: number, v1: number }}
 */
export function maskUvRectForImageCell(cellX, cellY, cellSize, sourceW, sourceH) {
  const cs = Math.max(1, cellSize);
  const sw = Math.max(1, sourceW);
  const sh = Math.max(1, sourceH);
  const pxMin = cellX * cs;
  const pyMin = cellY * cs;
  const pxMax = Math.min(sw, pxMin + cs);
  const pyMax = Math.min(sh, pyMin + cs);
  return {
    u0: pxMin / sw,
    u1: pxMax / sw,
    v0: 1 - pyMax / sh,
    v1: 1 - pyMin / sh,
  };
}

/**
 * Remap plane UVs to a sub-rect of a full-scene mask texture (all vertices).
 * @param {import('three').BufferGeometry} geometry
 * @param {{ u0: number, v0: number, u1: number, v1: number }} rect
 */
export function remapPlaneMaskUvs(geometry, rect) {
  const uv = geometry?.attributes?.uv;
  if (!uv || uv.count < 1) return;
  const du = rect.u1 - rect.u0;
  const dv = rect.v1 - rect.v0;
  for (let i = 0; i < uv.count; i += 1) {
    const u = uv.getX(i);
    const v = uv.getY(i);
    uv.setXY(i, rect.u0 + u * du, rect.v0 + v * dv);
  }
  uv.needsUpdate = true;
}

/**
 * Background vegetation uses a single full-scene overlay gated by streaming residency.
 * Per-cell mesh splits were removed — clump/wind geometry rebuild reset UVs to 0–1
 * against the full mask, duplicating the canopy on every streaming cell.
 * @returns {boolean}
 */
export function shouldSplitBackgroundVegetation() {
  return false;
}

/**
 * Build per-cell vegetation overlay specs for a full-scene background.
 * @param {object} foundrySceneData
 * @param {number} [worldH]
 * @returns {Array<{ cellKey: string, cellX: number, cellY: number, centerX: number, centerY: number, tileW: number, tileH: number, bounds: object, maskUv: object }>}
 */
export function buildBackgroundVegetationCellSpecs(foundrySceneData, worldH = 0) {
  const fd = foundrySceneData ?? window.MapShine?.sceneComposer?.foundrySceneData ?? {};
  const region = getSceneRegionFromFoundryData(fd);
  if (!region) return [];

  const sourceW = Number(fd.sceneWidth ?? fd.width ?? 0);
  const sourceH = Number(fd.sceneHeight ?? fd.height ?? 0);
  if (!(sourceW > 0 && sourceH > 0)) return [];

  const cellSize = getTextureBudgetTracker().getRecommendedTileSize();
  const cols = Math.ceil(sourceW / cellSize);
  const rows = Math.ceil(sourceH / cellSize);
  /** @type {Array<{ cellKey: string, cellX: number, cellY: number, centerX: number, centerY: number, tileW: number, tileH: number, bounds: object, maskUv: object }>} */
  const specs = [];

  for (let cy = 0; cy < rows; cy += 1) {
    for (let cx = 0; cx < cols; cx += 1) {
      const bounds = imageCellToWorldBounds(cx, cy, cellSize, sourceW, sourceH, region);
      const tileW = bounds.maxX - bounds.minX;
      const tileH = bounds.maxY - bounds.minY;
      if (!(tileW > 0 && tileH > 0)) continue;
      specs.push({
        cellKey: `${cx},${cy}`,
        cellX: cx,
        cellY: cy,
        centerX: bounds.minX + tileW * 0.5,
        centerY: bounds.minY + tileH * 0.5,
        tileW,
        tileH,
        bounds,
        maskUv: maskUvRectForImageCell(cx, cy, cellSize, sourceW, sourceH),
      });
    }
  }
  return specs;
}

/**
 * Visible textured streaming cells for a bus grid key (e.g. __bg_image__).
 * @param {string} gridKey
 * @returns {Set<string>}
 */
export function getVisibleStreamingCellKeys(gridKey) {
  /** @type {Set<string>} */
  const keys = new Set();
  try {
    const manager = getTileStreamingManager();
    const grid = manager.getGrids?.()?.get?.(gridKey)
      ?? manager.getRegionGrids?.()?.get?.(gridKey)
      ?? null;
    if (!grid?._cells) return keys;
    for (const [key, entry] of grid._cells) {
      const img = entry?.mesh?.material?.map?.image;
      const hasTex = !!(img && (img.width > 0 || img.height > 0));
      if (entry?.mesh?.visible && hasTex) keys.add(key);
    }
  } catch (_) {}
  return keys;
}

/**
 * Whether a vegetation overlay entry should draw given streaming residency.
 * @param {{ streamingGridKey?: string, streamingCellKey?: string, bounds?: object }} entry
 * @param {Set<string>} [visibleCells]
 * @returns {boolean}
 */
export function isVegetationStreamingCellVisible(entry, visibleCells = null) {
  if (!entry?.streamingGridKey) return true;
  const gridKey = entry.streamingGridKey;
  const cells = visibleCells ?? getVisibleStreamingCellKeys(gridKey);
  if (entry.streamingCellKey) {
    return cells.has(entry.streamingCellKey);
  }
  // Full-scene overlay: show when any streamed background cell is resident.
  return cells.size > 0;
}
