/**
 * @fileoverview World-space streaming grid math for tile streaming and particle buckets.
 * @module streaming/streaming-grid
 */

/** Default cell size in world pixels (Foundry/Three units). */
export const DEFAULT_CELL_SIZE = 2048;

/** Minimum cell size (never go below 512). */
export const MIN_CELL_SIZE = 512;

/** Maximum cell size. */
export const MAX_CELL_SIZE = 4096;

/** Reference cell size used when tuning resident caps and LOD-0 budgets. */
export const REFERENCE_CELL_SIZE = 2048;

/**
 * @typedef {'resident-hi'|'resident-lo'|'fallback-only'|'loading'|'culled'|'unknown'} StreamingCellState
 */

/**
 * Choose cell size from GPU max texture size and scene dimensions.
 *
 * @param {number} maxTextureSize
 * @param {number} sceneWidth
 * @param {number} sceneHeight
 * @param {number} [budgetCellSize]
 * @returns {number}
 */
export function resolveCellSize(maxTextureSize = 8192, sceneWidth = 4096, sceneHeight = 4096, budgetCellSize = 0) {
  if (budgetCellSize >= MIN_CELL_SIZE) {
    return Math.min(MAX_CELL_SIZE, budgetCellSize);
  }
  const maxDim = Math.max(sceneWidth, sceneHeight, 1);
  const texCap = Math.max(MIN_CELL_SIZE, Math.floor(maxTextureSize / 2));
  if (maxDim <= 4096) return Math.min(1024, texCap);
  if (maxDim <= 8192) return Math.min(2048, texCap);
  return Math.min(MAX_CELL_SIZE, texCap);
}

/**
 * Scale a resident-cell cap when cell size is smaller than the 2048 px reference.
 * Halving cell size roughly doubles cells in the same view frustum.
 *
 * @param {number} baseCap
 * @param {number} cellSize
 * @param {number} [referenceCellSize=REFERENCE_CELL_SIZE]
 * @returns {number}
 */
export function scaleStreamingResidentCap(baseCap, cellSize, referenceCellSize = REFERENCE_CELL_SIZE) {
  const base = Math.max(1, Math.floor(Number(baseCap) || 1));
  const cs = Math.max(MIN_CELL_SIZE, Math.floor(Number(cellSize) || referenceCellSize));
  const ref = Math.max(MIN_CELL_SIZE, Math.floor(referenceCellSize));
  if (cs >= ref) return base;
  return Math.min(base * 4, Math.ceil(base * (ref / cs)));
}

/**
 * @param {number} worldCoord
 * @param {number} cellSize
 * @returns {number}
 */
export function worldToCellIndex(worldCoord, cellSize) {
  const cs = Math.max(1, cellSize);
  return Math.floor(worldCoord / cs);
}

/**
 * World-space AABB for a grid cell.
 *
 * @param {number} cellX
 * @param {number} cellY
 * @param {number} cellSize
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number, cellX: number, cellY: number }}
 */
export function cellToWorldBounds(cellX, cellY, cellSize) {
  const cs = Math.max(1, cellSize);
  const minX = cellX * cs;
  const minY = cellY * cs;
  return {
    cellX,
    cellY,
    minX,
    minY,
    maxX: minX + cs,
    maxY: minY + cs,
  };
}

/**
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }} a
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }} b
 * @returns {boolean}
 */
export function rectsIntersect(a, b) {
  if (!a || !b) return true;
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

/**
 * Intersection of two axis-aligned rects (null when disjoint).
 *
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }} a
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }} b
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number }|null}
 */
export function intersectRects(a, b) {
  if (!a || !b) return null;
  const minX = Math.max(a.minX, b.minX);
  const minY = Math.max(a.minY, b.minY);
  const maxX = Math.min(a.maxX, b.maxX);
  const maxY = Math.min(a.maxY, b.maxY);
  if (maxX <= minX || maxY <= minY) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * List grid cells overlapping a world rect (inclusive indices).
 *
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }} worldRect
 * @param {number} cellSize
 * @returns {Array<{ cellX: number, cellY: number, key: string }>}
 */
export function getCellsInWorldRect(worldRect, cellSize) {
  if (!worldRect) return [];
  const cs = Math.max(1, cellSize);
  const minCX = worldToCellIndex(worldRect.minX, cs);
  const maxCX = worldToCellIndex(Math.max(worldRect.minX, worldRect.maxX - 1e-6), cs);
  const minCY = worldToCellIndex(worldRect.minY, cs);
  const maxCY = worldToCellIndex(Math.max(worldRect.minY, worldRect.maxY - 1e-6), cs);
  /** @type {Array<{ cellX: number, cellY: number, key: string }>} */
  const out = [];
  for (let cy = minCY; cy <= maxCY; cy += 1) {
    for (let cx = minCX; cx <= maxCX; cx += 1) {
      out.push({ cellX: cx, cellY: cy, key: `${cx},${cy}` });
    }
  }
  return out;
}

/**
 * Stable cell key string.
 * @param {number} cellX
 * @param {number} cellY
 * @returns {string}
 */
export function cellKey(cellX, cellY) {
  return `${cellX},${cellY}`;
}

/**
 * Parse cell key back to indices.
 * @param {string} key
 * @returns {{ cellX: number, cellY: number }|null}
 */
export function parseCellKey(key) {
  const parts = String(key ?? '').split(',');
  if (parts.length !== 2) return null;
  const cellX = Number(parts[0]);
  const cellY = Number(parts[1]);
  if (!Number.isFinite(cellX) || !Number.isFinite(cellY)) return null;
  return { cellX, cellY };
}

/**
 * Device pixel ratio for streaming LOD (drawing buffer px / CSS px).
 * High-DPI displays need finer pyramid levels at the same Foundry zoom.
 *
 * @returns {number}
 */
export function resolveStreamingPixelRatio() {
  const canvas = globalThis.canvas;
  const renderer = canvas?.app?.renderer;
  if (renderer?.getDrawingBufferSize) {
    const buf = { x: 0, y: 0, width: 0, height: 0 };
    renderer.getDrawingBufferSize(buf);
    const view = renderer.domElement ?? canvas?.app?.view;
    const cssW = Number(view?.clientWidth) || 0;
    if (cssW > 0 && buf.width > 0) {
      return Math.min(3, Math.max(1, buf.width / cssW));
    }
  }
  const dpr = Number(globalThis.window?.devicePixelRatio);
  return Number.isFinite(dpr) && dpr > 0 ? Math.min(3, Math.max(1, dpr)) : 1;
}

/**
 * Zoom scaled for streaming LOD — includes display pixel density.
 *
 * @param {number} zoom - sceneComposer.currentZoom (Foundry / PIXI scale)
 * @returns {number}
 */
export function resolveStreamingZoom(zoom) {
  const z = Math.max(0.05, Number(zoom) || 1);
  return z * resolveStreamingPixelRatio();
}

/**
 * Select LOD level from zoom (higher zoom = finer LOD).
 * LOD 0 = full cell resolution; higher = coarser (half size per level).
 *
 * @param {number} zoom - sceneComposer.currentZoom
 * @param {number} [maxLod=4]
 * @param {number} [sceneMegapixels=0] When set, caps coarse LOD on huge scenes at typical play zoom.
 * @returns {number}
 */
export function selectLodFromZoom(zoom, maxLod = 4, sceneMegapixels = 0) {
  const z = resolveStreamingZoom(zoom);
  let lod;
  if (z >= 2.2) lod = 0;
  else if (z >= 1.0) lod = 1;
  else if (z >= 0.50) lod = 2;
  else if (z >= 0.25) lod = 3;
  else lod = Math.min(maxLod, 4);

  const mp = Number(sceneMegapixels) || 0;
  if (mp >= 130) {
    if (z >= 1.0) lod = Math.min(lod, 0);
    else if (z >= 0.50) lod = Math.min(lod, 1);
    else if (z >= 0.25) lod = Math.min(lod, 2);
    else if (z >= 0.12) lod = Math.min(lod, 3);
  }

  return Math.min(lod, maxLod);
}

/**
 * Pixel size of a cell at a given LOD (power-of-two downscale).
 * @param {number} cellSize
 * @param {number} lod
 * @returns {number}
 */
export function lodPixelSize(cellSize, lod) {
  const shift = Math.max(0, Math.min(6, Math.floor(lod)));
  return Math.max(64, Math.floor(cellSize / (2 ** shift)));
}

/**
 * Partition flat point array (stride 3: x,y,strength OR x,y,z) into cell buckets.
 *
 * @param {Float32Array|number[]} points
 * @param {number} cellSize
 * @param {number} [stride=3]
 * @returns {Map<string, Float32Array>}
 */
export function partitionPointsIntoCells(points, cellSize, stride = 3) {
  /** @type {Map<string, number[]>} */
  const buckets = new Map();
  const len = points?.length ?? 0;
  for (let i = 0; i + stride - 1 < len; i += stride) {
    const x = points[i];
    const y = points[i + 1];
    const cx = worldToCellIndex(x, cellSize);
    const cy = worldToCellIndex(y, cellSize);
    const key = cellKey(cx, cy);
    let arr = buckets.get(key);
    if (!arr) {
      arr = [];
      buckets.set(key, arr);
    }
    for (let j = 0; j < stride; j += 1) arr.push(points[i + j]);
  }
  /** @type {Map<string, Float32Array>} */
  const out = new Map();
  for (const [key, arr] of buckets) {
    out.set(key, new Float32Array(arr));
  }
  return out;
}

/**
 * Filter scene-UV points (u,v in [0..1]) to those inside a UV rect.
 *
 * @param {Float32Array} points - stride 3 (u, v, strength)
 * @param {{ uMin: number, vMin: number, uMax: number, vMax: number }} uvRect
 * @returns {Float32Array}
 */
export function filterSceneUvPointsByRect(points, uvRect) {
  if (!points?.length || !uvRect) return points ?? new Float32Array(0);
  const tmp = [];
  for (let i = 0; i + 2 < points.length; i += 3) {
    const u = points[i];
    const v = points[i + 1];
    if (u < uvRect.uMin || u > uvRect.uMax || v < uvRect.vMin || v > uvRect.vMax) continue;
    tmp.push(points[i], points[i + 1], points[i + 2]);
  }
  return new Float32Array(tmp);
}
