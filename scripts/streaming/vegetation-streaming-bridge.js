/**
 * @fileoverview Bridge tile streaming cell visibility to vegetation overlays (Tree/Bush).
 * @module streaming/vegetation-streaming-bridge
 */

import { getTextureBudgetTracker } from '../assets/TextureBudgetTracker.js';
import { estimateSceneMegapixels } from './texture-budget-policy.js';
import { getSceneRegionFromFoundryData, resolveStreamingViewRect } from './view-projection-service.js';
import { getTileStreamingManager } from './tile-streaming-manager.js';
import { overlayWorldBounds, tileBoundsIntersectView } from '../compositor-v2/effects/vegetation-overlay-runtime.js';
import { tileAlbedoOrder } from '../compositor-v2/LayerOrderPolicy.js';
import { imageCellToWorldBounds } from './streamed-background-grid.js';

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
 * Image-space bleed for stream-cell vegetation planes (matches bulk wind cap ~0.13 UV).
 * @param {number} cellSize
 * @returns {number}
 */
export function resolveVegetationStreamCellBleedPx(cellSize) {
  const cs = Math.max(1, Number(cellSize) || 1);
  return Math.max(48, Math.ceil(cs * 0.15));
}

/**
 * @param {number} cellX
 * @param {number} cellY
 * @param {number} cellSize
 * @param {number} sourceW
 * @param {number} sourceH
 * @param {number} [bleedPx=0]
 * @returns {{ pxMin: number, pyMin: number, pxMax: number, pyMax: number }}
 */
export function imageCellPixelRect(cellX, cellY, cellSize, sourceW, sourceH, bleedPx = 0) {
  const cs = Math.max(1, cellSize);
  const bp = Math.max(0, Math.floor(Number(bleedPx) || 0));
  return {
    pxMin: Math.max(0, cellX * cs - bp),
    pyMin: Math.max(0, cellY * cs - bp),
    pxMax: Math.min(Math.max(1, sourceW), cellX * cs + cs + bp),
    pyMax: Math.min(Math.max(1, sourceH), cellY * cs + cs + bp),
  };
}

/**
 * @param {number} cellX
 * @param {number} cellY
 * @param {number} cellSize
 * @param {number} sourceW
 * @param {number} sourceH
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }} region
 * @param {number} [bleedPx=0]
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number }}
 */
export function imageCellToWorldBoundsBleed(
  cellX,
  cellY,
  cellSize,
  sourceW,
  sourceH,
  region,
  bleedPx = 0,
) {
  const { pxMin, pyMin, pxMax, pyMax } = imageCellPixelRect(
    cellX, cellY, cellSize, sourceW, sourceH, bleedPx,
  );
  const rw = Math.max(1, region.maxX - region.minX);
  const rh = Math.max(1, region.maxY - region.minY);
  const sw = Math.max(1, sourceW);
  const sh = Math.max(1, sourceH);
  return {
    minX: region.minX + (pxMin / sw) * rw,
    maxX: region.minX + (pxMax / sw) * rw,
    minY: region.minY + (1 - pyMax / sh) * rh,
    maxY: region.minY + (1 - pyMin / sh) * rh,
  };
}

/**
 * @param {number} cellX
 * @param {number} cellY
 * @param {number} cellSize
 * @param {number} sourceW
 * @param {number} sourceH
 * @returns {{ u0: number, v0: number, u1: number, v1: number }}
 */
export function maskUvRectForImageCell(cellX, cellY, cellSize, sourceW, sourceH, bleedPx = 0) {
  const { pxMin, pyMin, pxMax, pyMax } = imageCellPixelRect(
    cellX, cellY, cellSize, sourceW, sourceH, bleedPx,
  );
  const sw = Math.max(1, sourceW);
  const sh = Math.max(1, sourceH);
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
 * Per-cell vegetation planes stay disabled: cell-sized quads still show opaque white
 * mask backdrops despite derive-alpha (sub-rect UV + clump wind geometry). Streaming
 * benefit comes from gating visibility and half-res shadows instead.
 * @param {number} _sceneW
 * @param {number} _sceneH
 * @returns {boolean}
 */
export function shouldSplitBackgroundVegetation(_sceneW, _sceneH) {
  return false;
}

/**
 * True when the camera view rect intersects any resident streaming cell.
 * @param {string} gridKey
 * @param {Set<string>} visibleCells
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }|null} viewRect
 * @returns {boolean}
 */
export function viewIntersectsAnyStreamingCell(gridKey, visibleCells, viewRect) {
  if (!visibleCells?.size) return false;
  if (!viewRect) return true;
  try {
    const manager = getTileStreamingManager();
    const grid = manager.getGrids?.()?.get?.(gridKey)
      ?? manager.getRegionGrids?.()?.get?.(gridKey)
      ?? null;
    const manifest = grid?._manifest;
    const fd = window.MapShine?.sceneComposer?.foundrySceneData ?? {};
    const region = getSceneRegionFromFoundryData(fd);
    const sourceW = Number(manifest?.sourceWidth ?? fd.sceneWidth ?? fd.width ?? 0);
    const sourceH = Number(manifest?.sourceHeight ?? fd.sceneHeight ?? fd.height ?? 0);
    if (!(region && sourceW > 0 && sourceH > 0)) return true;

    const cellSize = getTextureBudgetTracker().getRecommendedTileSize();
    for (const cellKey of visibleCells) {
      const parts = String(cellKey).split(',');
      if (parts.length !== 2) continue;
      const cx = Number(parts[0]);
      const cy = Number(parts[1]);
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
      const bounds = imageCellToWorldBounds(cx, cy, cellSize, sourceW, sourceH, region);
      if (tileBoundsIntersectView(bounds, viewRect)) return true;
    }
    return false;
  } catch (_) {
    return visibleCells.size > 0;
  }
}

/**
 * View padding aligned with {@link TileStreamingManager} cell hysteresis.
 * @returns {import('./view-projection-service.js').StreamingViewPadding}
 */
export function resolveVegetationStreamingViewPadding() {
  try {
    const manager = getTileStreamingManager();
    if (manager?.getViewPaddingOptions) {
      return manager.getViewPaddingOptions();
    }
  } catch (_) {}

  const budget = getTextureBudgetTracker();
  const cs = budget.getRecommendedTileSize();
  const mp = estimateSceneMegapixels();
  const cellPad = Math.max(256, Math.floor(cs * 0.5));
  if (mp >= 144) return { uniform: cellPad };
  if (mp > 64) return { uniform: Math.max(cellPad, 384) };
  return { uniform: Math.max(cellPad, 128) };
}

/**
 * Ground-plane view rect shared with tile streaming (raycast ∪ stable FOV).
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number }|null}
 */
export function resolveVegetationStreamingViewRect() {
  return resolveStreamingViewRect(resolveVegetationStreamingViewPadding());
}

/**
 * @param {Iterable<string>} keys
 * @returns {string}
 */
export function streamingCellKeysSignature(keys) {
  return [...keys].sort().join(',');
}

/**
 * Change-detection signature across one or more bus grid keys (`__bg_image__`, …).
 * @param {Iterable<string>} gridKeys
 * @returns {string}
 */
export function streamingCellKeysSignatureForGrids(gridKeys) {
  const parts = [];
  for (const gridKey of gridKeys) {
    const cells = getVisibleStreamingCellKeys(gridKey);
    parts.push(`${gridKey}:${streamingCellKeysSignature(cells)}`);
  }
  parts.sort();
  return parts.join('|');
}

/**
 * Render order of a resident streamed background cell mesh (for vegetation stacking).
 * @param {string} streamingGridKey
 * @param {string} streamingCellKey
 * @param {number} [floorIndex=0]
 * @returns {number|null}
 */
export function resolveStreamingCellAlbedoRenderOrder(
  streamingGridKey,
  streamingCellKey,
  floorIndex = 0,
) {
  if (!streamingGridKey || !streamingCellKey) return null;
  try {
    const manager = getTileStreamingManager();
    const grid = manager.getGrids?.()?.get?.(streamingGridKey)
      ?? manager.getRegionGrids?.()?.get?.(streamingGridKey)
      ?? null;
    const entry = grid?._cells?.get?.(streamingCellKey);
    const ro = Number(entry?.mesh?.renderOrder);
    if (Number.isFinite(ro)) return ro;
  } catch (_) {}
  return tileAlbedoOrder(floorIndex, 0);
}

/**
 * @typedef {object} BackgroundVegetationSpawnSpec
 * @property {string} tileId
 * @property {number} centerX
 * @property {number} centerY
 * @property {number} tileW
 * @property {number} tileH
 * @property {{ minX: number, minY: number, maxX: number, maxY: number }} bounds
 * @property {string|null} streamingGridKey
 * @property {string|null} streamingCellKey
 * @property {{ u0: number, v0: number, u1: number, v1: number }|null} maskUv
 * @property {{ centerX: number, centerY: number, tileW: number, tileH: number, rotationRad: number }|null} clumpPlacement
 */

/**
 * Spawn one full-scene or per-streaming-cell overlay plan for a background layer.
 *
 * @param {string} bgKey
 * @param {object|null|undefined} foundrySceneData
 * @param {number} worldH
 * @param {number} sceneX
 * @param {number} sceneY
 * @param {number} sceneW
 * @param {number} sceneH
 * @param {boolean} gateStreaming
 * @returns {BackgroundVegetationSpawnSpec[]}
 */
export function buildBackgroundVegetationSpawnPlan(
  bgKey,
  foundrySceneData,
  worldH,
  sceneX,
  sceneY,
  sceneW,
  sceneH,
  gateStreaming,
) {
  const centerX = sceneX + sceneW / 2;
  const centerY = worldH - (sceneY + sceneH / 2);
  const fullClumpPlacement = {
    centerX,
    centerY,
    tileW: sceneW,
    tileH: sceneH,
    rotationRad: 0,
  };
  if (!gateStreaming || !shouldSplitBackgroundVegetation(sceneW, sceneH)) {
    return [{
      tileId: bgKey,
      centerX,
      centerY,
      tileW: sceneW,
      tileH: sceneH,
      bounds: overlayWorldBounds(centerX, centerY, sceneW, sceneH),
      streamingGridKey: gateStreaming ? bgKey : null,
      streamingCellKey: null,
      maskUv: null,
      clumpPlacement: null,
    }];
  }

  const specs = buildBackgroundVegetationCellSpecs(foundrySceneData, worldH);
  return specs.map((spec) => ({
    tileId: `${bgKey}__stream_${spec.cellKey}`,
    centerX: spec.centerX,
    centerY: spec.centerY,
    tileW: spec.tileW,
    tileH: spec.tileH,
    bounds: spec.bounds,
    streamingGridKey: bgKey,
    streamingCellKey: spec.cellKey,
    maskUv: spec.maskUv,
    clumpPlacement: fullClumpPlacement,
  }));
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
  const bleedPx = resolveVegetationStreamCellBleedPx(cellSize);
  const cols = Math.ceil(sourceW / cellSize);
  const rows = Math.ceil(sourceH / cellSize);
  /** @type {Array<{ cellKey: string, cellX: number, cellY: number, centerX: number, centerY: number, tileW: number, tileH: number, bounds: object, maskUv: object }>} */
  const specs = [];

  for (let cy = 0; cy < rows; cy += 1) {
    for (let cx = 0; cx < cols; cx += 1) {
      const bounds = imageCellToWorldBoundsBleed(
        cx, cy, cellSize, sourceW, sourceH, region, bleedPx,
      );
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
        maskUv: maskUvRectForImageCell(cx, cy, cellSize, sourceW, sourceH, bleedPx),
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
  const view = resolveVegetationStreamingViewRect();
  return viewIntersectsAnyStreamingCell(gridKey, cells, view);
}

/**
 * @typedef {object} StreamVegetationBgPlan
 * @property {string} url
 * @property {number} floorIndex
 * @property {number} z
 * @property {Map<string, BackgroundVegetationSpawnSpec>} specsByCellKey
 */

/**
 * Create overlays for newly resident stream cells; evict overlays for cells that left residency.
 * @param {{
 *   streamPlans: Map<string, StreamVegetationBgPlan>,
 *   overlays: Map<string, object>,
 *   createOverlay: (spec: BackgroundVegetationSpawnSpec, plan: StreamVegetationBgPlan) => void,
 *   destroyOverlay: (tileId: string) => void,
 *   createBudget?: number,
 * }} ctx
 * @returns {boolean} True when overlay membership changed.
 */
export function syncStreamVegetationOverlays(ctx) {
  const {
    streamPlans,
    overlays,
    createOverlay,
    destroyOverlay,
    createBudget = 4,
  } = ctx;
  if (!streamPlans?.size) return false;

  /** @type {Set<string>} */
  const keepTileIds = new Set();
  let changed = false;
  let created = 0;

  for (const [gridKey, plan] of streamPlans) {
    const streamCells = getVisibleStreamingCellKeys(gridKey);
    for (const cellKey of streamCells) {
      const spec = plan.specsByCellKey?.get?.(cellKey);
      if (!spec) continue;
      keepTileIds.add(spec.tileId);
      if (!overlays.has(spec.tileId)) {
        if (created >= createBudget) continue;
        createOverlay(spec, plan);
        created += 1;
        changed = true;
      }
    }
  }

  for (const [tileId, entry] of overlays) {
    if (!entry?.streamingCellKey) continue;
    if (keepTileIds.has(tileId)) continue;
    destroyOverlay(tileId);
    changed = true;
  }

  return changed;
}

