/**
 * @fileoverview Wall-aware spatial clustering for map-point GM effect toggles.
 * @module scene/map-point-wall-clustering
 */

import Coordinates from '../utils/coordinates.js';
import { readWallHeightFlags } from '../foundry/levels-scene-flags.js';
import { getPerspectiveElevation } from '../foundry/elevation-context.js';

/** Proximity radius for point clusters inside a group (grid units). */
export const CONTROL_CLUSTER_DISTANCE_GRIDS = 1.5;

/** Fine grid cell size for mask-fire control buckets (world px). */
export const CONTROL_FIRE_BUCKET_SIZE_PX = 600;

/** Max mask-fire control buckets per floor before coarsening cell size. */
export const CONTROL_FIRE_MAX_BUCKETS = 64;

/** Upper bound when coarsening mask-fire cells. */
export const CONTROL_FIRE_MAX_BUCKET_SIZE_PX = 4096;

/**
 * @typedef {{ax:number,ay:number,bx:number,by:number}} WallSegmentWorld
 */

let _wallSegmentCacheKey = '';
/** @type {WallSegmentWorld[]} */
let _wallSegmentCache = [];

class UnionFind {
  constructor(n) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }

  find(i) {
    let p = this.parent[i];
    while (p !== this.parent[p]) {
      this.parent[p] = this.parent[this.parent[p]];
      p = this.parent[p];
    }
    return p;
  }

  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

/**
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @param {number} cx
 * @param {number} cy
 * @param {number} dx
 * @param {number} dy
 * @returns {boolean}
 */
function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const denom = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  if (Math.abs(denom) < 1e-10) return false;
  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / denom;
  const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/**
 * @param {number} elevation
 * @returns {string}
 */
function wallCacheKey(elevation) {
  const sceneId = canvas?.scene?.id ?? 'none';
  const wallCount = canvas?.walls?.placeables?.length ?? 0;
  return `${sceneId}:${wallCount}:${Number(elevation).toFixed(2)}`;
}

/**
 * @param {object|null|undefined} doc
 * @returns {boolean}
 */
function wallDocDoorIsOpen(doc) {
  const open = (typeof CONST !== 'undefined' && CONST.WALL_DOOR_STATES)
    ? CONST.WALL_DOOR_STATES.OPEN
    : 1;
  return Number(doc?.door) > 0 && Number(doc?.ds) === open;
}

/**
 * @param {object} wallDoc
 * @param {number} elevation
 * @returns {boolean}
 */
function wallBlocksAtElevation(wallDoc, elevation) {
  if (!Number.isFinite(elevation)) return true;
  const bounds = readWallHeightFlags(wallDoc);
  let bottom = Number(bounds?.bottom);
  let top = Number(bounds?.top);
  if (!Number.isFinite(bottom)) bottom = -Infinity;
  if (!Number.isFinite(top)) top = Infinity;
  if (top < bottom) {
    const swap = bottom;
    bottom = top;
    top = swap;
  }
  return elevation >= bottom && (top === Infinity || elevation < top);
}

/**
 * @param {number} [elevation]
 * @returns {WallSegmentWorld[]}
 */
export function collectBlockingWallSegmentsWorld(elevation = resolveClusteringElevation()) {
  const key = wallCacheKey(elevation);
  if (key === _wallSegmentCacheKey && _wallSegmentCache.length > 0) {
    return _wallSegmentCache;
  }

  const placeables = Array.isArray(canvas?.walls?.placeables) ? canvas.walls.placeables : [];
  const out = [];

  for (const wall of placeables) {
    const doc = wall?.document ?? wall;
    const c = doc?.c;
    if (!Array.isArray(c) || c.length < 4) continue;
    if (wallDocDoorIsOpen(doc)) continue;
    if (!wallBlocksAtElevation(doc, elevation)) continue;

    const wa = Coordinates.toWorld(c[0], c[1]);
    const wb = Coordinates.toWorld(c[2], c[3]);
    out.push({
      ax: wa.x,
      ay: wa.y,
      bx: wb.x,
      by: wb.y,
    });
  }

  _wallSegmentCacheKey = key;
  _wallSegmentCache = out;
  return out;
}

/**
 * @param {number|null} [floorIndex]
 * @returns {number}
 */
export function resolveClusteringElevation(floorIndex = null) {
  if (floorIndex != null && Number.isFinite(Number(floorIndex))) {
    const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    const f = floors[Number(floorIndex)];
    if (f && Number.isFinite(Number(f.elevationMin))) {
      return Number(f.elevationMin);
    }
  }

  const ctx = window.MapShine?.activeLevelContext;
  if (ctx) {
    const b = Number(ctx.bottom);
    const t = Number(ctx.top);
    if (Number.isFinite(b) && Number.isFinite(t)) {
      return (b + t) * 0.5;
    }
  }

  try {
    const elev = getPerspectiveElevation();
    if (Number.isFinite(elev)) return elev;
  } catch (_) {
  }

  return 0;
}

/**
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @param {WallSegmentWorld[]} walls
 * @returns {boolean}
 */
export function segmentBlockedByWalls(ax, ay, bx, by, walls) {
  if (!walls || walls.length === 0) return false;
  for (const w of walls) {
    if (segmentsIntersect(ax, ay, bx, by, w.ax, w.ay, w.bx, w.by)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {number} clusterDistanceGrids
 * @returns {number}
 */
export function computeClusterDistanceThreshold(clusterDistanceGrids = CONTROL_CLUSTER_DISTANCE_GRIDS) {
  const gridSize = Number(canvas?.dimensions?.size) || 100;
  const grids = Number.isFinite(clusterDistanceGrids) ? clusterDistanceGrids : CONTROL_CLUSTER_DISTANCE_GRIDS;
  return Math.max(48, gridSize * grids);
}

/**
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @param {number} thresholdSq
 * @param {WallSegmentWorld[]} walls
 * @returns {boolean}
 */
export function pointsConnectForClustering(a, b, thresholdSq, walls) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  if (dx * dx + dy * dy > thresholdSq) return false;
  return !segmentBlockedByWalls(a.x, a.y, b.x, b.y, walls);
}

/**
 * @param {Array<{pointIndex:number,x:number,y:number}>} samples
 * @param {number} thresholdPx
 * @param {number} [elevation]
 * @returns {Array<{pointIndices:number[],centroid:{x:number,y:number}}>}
 */
export function clusterPointSamplesWithWalls(samples, thresholdPx, elevation = resolveClusteringElevation()) {
  if (!samples || samples.length === 0) return [];
  if (samples.length === 1) {
    return [{
      pointIndices: [samples[0].pointIndex],
      centroid: { x: samples[0].x, y: samples[0].y },
    }];
  }

  const walls = collectBlockingWallSegmentsWorld(elevation);
  const thresholdSq = thresholdPx * thresholdPx;
  const uf = new UnionFind(samples.length);

  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      if (pointsConnectForClustering(samples[i], samples[j], thresholdSq, walls)) {
        uf.union(i, j);
      }
    }
  }

  /** @type {Map<number, number[]>} */
  const components = new Map();
  for (let i = 0; i < samples.length; i++) {
    const root = uf.find(i);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(i);
  }

  const result = [];
  for (const indices of components.values()) {
    const pointIndices = indices.map((idx) => samples[idx].pointIndex).sort((a, b) => a - b);
    let sumX = 0;
    let sumY = 0;
    for (const idx of indices) {
      sumX += samples[idx].x;
      sumY += samples[idx].y;
    }
    const n = indices.length;
    result.push({
      pointIndices,
      centroid: { x: sumX / n, y: sumY / n },
    });
  }

  return result;
}

/**
 * @param {number} bx
 * @param {number} by
 * @param {number} cellSize
 * @returns {{x:number,y:number}}
 */
function cellCentroidWorld(bx, by, cellSize) {
  return {
    x: (bx + 0.5) * cellSize,
    y: (by + 0.5) * cellSize,
  };
}

/**
 * Wall-aware clustering of packed fire-mask points into control/particle buckets.
 *
 * @param {Float32Array} points - (u, v, brightness) in scene UV space
 * @param {number} sceneW
 * @param {number} sceneH
 * @param {number} sceneX
 * @param {number} sceneY
 * @param {number} [cellSizePx]
 * @param {number} [maxBuckets]
 * @param {number} [elevation]
 * @returns {{ buckets: Map<string, {points:number[], memberCellKeys:string[]}>, bucketSizePx: number }}
 */
export function clusterFireMaskPointsWithWalls(
  points,
  sceneW,
  sceneH,
  sceneX,
  sceneY,
  cellSizePx = CONTROL_FIRE_BUCKET_SIZE_PX,
  maxBuckets = CONTROL_FIRE_MAX_BUCKETS,
  elevation = resolveClusteringElevation(),
) {
  const empty = { buckets: new Map(), bucketSizePx: cellSizePx };
  if (!points || points.length < 3) return empty;

  let cellSize = Math.max(96, Number(cellSizePx) || CONTROL_FIRE_BUCKET_SIZE_PX);
  const maxCount = Math.max(4, Number(maxBuckets) || CONTROL_FIRE_MAX_BUCKETS);
  const walls = collectBlockingWallSegmentsWorld(elevation);

  while (cellSize <= CONTROL_FIRE_MAX_BUCKET_SIZE_PX) {
    /** @type {Map<string, number[]>} */
    const cellPoints = new Map();

    for (let i = 0; i < points.length; i += 3) {
      const u = points[i];
      const v = points[i + 1];
      const b = points[i + 2];
      if (!Number.isFinite(u) || !Number.isFinite(v) || !Number.isFinite(b) || b <= 0) continue;

      const wx = sceneX + u * sceneW;
      const wy = sceneY + (1.0 - v) * sceneH;
      const bx = Math.floor(wx / cellSize);
      const by = Math.floor(wy / cellSize);
      const key = `${bx},${by}`;
      if (!cellPoints.has(key)) cellPoints.set(key, []);
      cellPoints.get(key).push(u, v, b);
    }

    const cellKeys = [...cellPoints.keys()];
    if (cellKeys.length === 0) {
      return empty;
    }

    if (cellKeys.length <= maxCount) {
      const uf = new UnionFind(cellKeys.length);
      const keyIndex = new Map(cellKeys.map((k, i) => [k, i]));

      for (let i = 0; i < cellKeys.length; i++) {
        const [bx, by] = cellKeys[i].split(',').map(Number);
        const ca = cellCentroidWorld(bx, by, cellSize);

        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const nk = `${bx + dx},${by + dy}`;
            const j = keyIndex.get(nk);
            if (j == null || j <= i) continue;
            const cb = cellCentroidWorld(bx + dx, by + dy, cellSize);
            if (!segmentBlockedByWalls(ca.x, ca.y, cb.x, cb.y, walls)) {
              uf.union(i, j);
            }
          }
        }
      }

      /** @type {Map<number, string[]>} */
      const components = new Map();
      for (let i = 0; i < cellKeys.length; i++) {
        const root = uf.find(i);
        if (!components.has(root)) components.set(root, []);
        components.get(root).push(cellKeys[i]);
      }

      /** @type {Map<string, {points:number[], memberCellKeys:string[]}>} */
      const buckets = new Map();
      for (const memberKeys of components.values()) {
        let minBx = Infinity;
        let minBy = Infinity;
        const merged = [];
        for (const k of memberKeys) {
          const [bx, by] = k.split(',').map(Number);
          if (bx < minBx || (bx === minBx && by < minBy)) {
            minBx = bx;
            minBy = by;
          }
          const arr = cellPoints.get(k);
          if (arr) merged.push(...arr);
        }
        if (merged.length >= 3) {
          buckets.set(`${minBx},${minBy}`, {
            points: merged,
            memberCellKeys: [...memberKeys],
          });
        }
      }

      return { buckets, bucketSizePx: cellSize };
    }

    cellSize = Math.min(CONTROL_FIRE_MAX_BUCKET_SIZE_PX, Math.ceil(cellSize * 1.5));
  }

  // Fallback: single bucket if coarsening exhausted
  const fallback = [];
  for (let i = 0; i < points.length; i += 3) {
    fallback.push(points[i], points[i + 1], points[i + 2]);
  }
  return {
    buckets: new Map([['0,0', { points: fallback, memberCellKeys: ['0,0'] }]]),
    bucketSizePx: cellSize,
  };
}

/**
 * @param {Map<string, {points:number[], memberCellKeys:string[]}>} buckets
 * @param {number} sceneW
 * @param {number} sceneH
 * @param {number} sceneX
 * @param {number} sceneY
 * @returns {import('./map-point-control-clusters.js').SpatialControlBucket[]}
 */
export function fireBucketsToSpatialControls(buckets, sceneW, sceneH, sceneX, sceneY, floorIndex, bucketSizePx) {
  /** @type {import('./map-point-control-clusters.js').SpatialControlBucket[]} */
  const list = [];
  for (const [bucketKey, entry] of buckets) {
    const arr = entry?.points;
    const memberCellKeys = Array.isArray(entry?.memberCellKeys) ? entry.memberCellKeys : [bucketKey];
    if (!arr || arr.length < 3) continue;
    let sumX = 0;
    let sumY = 0;
    let n = 0;
    for (let i = 0; i < arr.length; i += 3) {
      sumX += sceneX + arr[i] * sceneW;
      sumY += sceneY + (1.0 - arr[i + 1]) * sceneH;
      n += 1;
    }
    if (n === 0) continue;
    list.push({
      floorIndex,
      bucketKey,
      bucketSizePx,
      memberCellKeys,
      centroid: { x: sumX / n, y: sumY / n },
    });
  }
  return list;
}

/**
 * Invalidate cached wall segments (call after wall edits if needed).
 */
export function invalidateWallSegmentCache() {
  _wallSegmentCacheKey = '';
  _wallSegmentCache = [];
}
