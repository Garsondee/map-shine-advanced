/**
 * @fileoverview Control clusters for map-point effect GM toggles.
 * @module scene/map-point-control-clusters
 */

import {
  CONTROL_CLUSTER_DISTANCE_GRIDS,
  computeClusterDistanceThreshold,
  clusterPointSamplesWithWalls,
  resolveClusteringElevation,
} from './map-point-wall-clustering.js';

/** Default proximity radius in grid units for point clusters inside a group. */
export const DEFAULT_CLUSTER_DISTANCE_GRIDS = CONTROL_CLUSTER_DISTANCE_GRIDS;

/** Minimum overlap ratio to inherit `enabled` from a previous cluster on rebuild. */
const ENABLED_INHERIT_OVERLAP_RATIO = 0.5;

/**
 * @typedef {Object} MapPointControlCluster
 * @property {string} id
 * @property {string} effectTarget
 * @property {boolean} enabled
 * @property {string[]} memberGroupIds
 * @property {number[]} [memberPointIndices]
 * @property {{floorIndex:number,bucketKey:string,bucketSizePx?:number,memberCellKeys?:string[]}} [maskBucket]
 * @property {{x:number,y:number}} centroid
 * @property {'auto'|'group'|'mask'} source
 */

/**
 * @typedef {Object} SpatialControlBucket
 * @property {number} floorIndex
 * @property {string} bucketKey
 * @property {number} [bucketSizePx]
 * @property {{x:number,y:number}} centroid
 */

/**
 * @param {import('./map-points-manager.js').MapPointGroup|object} group
 * @returns {{x:number,y:number}|null}
 */
export function computeGroupCentroid(group) {
  const points = group?.points;
  if (!Array.isArray(points) || points.length === 0) return null;

  let sumX = 0;
  let sumY = 0;
  let n = 0;
  for (const p of points) {
    const x = Number(p?.x);
    const y = Number(p?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    sumX += x;
    sumY += y;
    n += 1;
  }
  if (n === 0) return null;
  return { x: sumX / n, y: sumY / n };
}

export { computeClusterDistanceThreshold };

/**
 * @param {string[]} memberGroupIds
 * @param {number[]} [memberPointIndices]
 * @returns {string}
 */
function shortHash(memberGroupIds, memberPointIndices = []) {
  const sorted = [...memberGroupIds].sort();
  let h = 2166136261;
  for (const id of sorted) {
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  if (memberPointIndices.length > 0) {
    const pts = [...memberPointIndices].sort((a, b) => a - b);
    for (const idx of pts) {
      h ^= idx;
      h = Math.imul(h, 16777619);
    }
  }
  return (h >>> 0).toString(36);
}

/**
 * @param {string[]} newMemberIds
 * @param {Record<string, MapPointControlCluster>|Map<string, MapPointControlCluster>} previousClusters
 * @returns {boolean}
 */
function inheritEnabledFromPrevious(newMemberIds, previousClusters) {
  const newSet = new Set(newMemberIds);
  let bestRatio = 0;
  let inherited = true;

  const entries = previousClusters instanceof Map
    ? previousClusters.values()
    : Object.values(previousClusters || {});

  for (const old of entries) {
    const oldIds = Array.isArray(old?.memberGroupIds) ? old.memberGroupIds : [];
    if (oldIds.length === 0) continue;

    let overlap = 0;
    for (const id of oldIds) {
      if (newSet.has(id)) overlap += 1;
    }
    const denom = Math.max(oldIds.length, newMemberIds.length);
    const ratio = overlap / denom;
    if (ratio >= ENABLED_INHERIT_OVERLAP_RATIO && ratio > bestRatio) {
      bestRatio = ratio;
      inherited = old.enabled !== false;
    }
  }

  return inherited;
}

/**
 * @param {string} groupId
 * @param {number[]} newPointIndices
 * @param {Record<string, MapPointControlCluster>|Map<string, MapPointControlCluster>} previousClusters
 * @returns {boolean}
 */
function inheritEnabledFromPointCluster(groupId, newPointIndices, previousClusters) {
  const newSet = new Set(newPointIndices);
  let bestRatio = 0;
  let inherited = true;

  const entries = previousClusters instanceof Map
    ? previousClusters.values()
    : Object.values(previousClusters || {});

  for (const old of entries) {
    if (old?.source === 'mask') continue;
    const oldGroupIds = Array.isArray(old?.memberGroupIds) ? old.memberGroupIds : [];
    if (!oldGroupIds.includes(groupId)) continue;
    const oldPts = Array.isArray(old?.memberPointIndices) ? old.memberPointIndices : [];
    if (oldPts.length === 0) continue;

    let overlap = 0;
    for (const idx of oldPts) {
      if (newSet.has(idx)) overlap += 1;
    }
    const denom = Math.max(oldPts.length, newPointIndices.length);
    const ratio = overlap / denom;
    if (ratio >= ENABLED_INHERIT_OVERLAP_RATIO && ratio > bestRatio) {
      bestRatio = ratio;
      inherited = old.enabled !== false;
    }
  }

  if (bestRatio > 0) return inherited;
  return inheritEnabledFromPrevious([groupId], previousClusters);
}

/**
 * @param {number} floorIndex
 * @param {string} bucketKey
 * @param {Record<string, MapPointControlCluster>|Map<string, MapPointControlCluster>} previousClusters
 * @returns {boolean}
 */
function inheritMaskBucketEnabled(floorIndex, bucketKey, previousClusters) {
  const entries = previousClusters instanceof Map
    ? previousClusters.values()
    : Object.values(previousClusters || {});

  for (const old of entries) {
    const mb = old?.maskBucket;
    if (!mb) continue;
    if (Number(mb.floorIndex) === Number(floorIndex) && mb.bucketKey === bucketKey) {
      return old.enabled !== false;
    }
  }
  return true;
}

/**
 * @param {object} group
 * @returns {boolean}
 */
function isGroupEffectSource(group) {
  if (!group || typeof group !== 'object') return false;
  if (group.isEffectSource === false) return false;
  const effectTarget = typeof group.effectTarget === 'string' ? group.effectTarget.trim() : '';
  return effectTarget.length > 0;
}

/**
 * Recompute control clusters from map point groups.
 * - Point groups: proximity buckets within the group (room-scale toggles).
 * - Line/area/rope: one toggle per authored group.
 *
 * @param {Iterable<[string, object]>|Map<string, object>} groups
 * @param {Record<string, MapPointControlCluster>|Map<string, MapPointControlCluster>} [previousClusters={}]
 * @param {{ clusterDistanceGrids?: number }} [options]
 * @returns {Map<string, MapPointControlCluster>}
 */
export function recomputeControlClusters(groups, previousClusters = {}, options = {}) {
  const threshold = computeClusterDistanceThreshold(options.clusterDistanceGrids);
  const elevation = Number.isFinite(Number(options.elevation))
    ? Number(options.elevation)
    : resolveClusteringElevation(options.floorIndex ?? null);
  const result = new Map();

  const groupEntries = groups instanceof Map ? groups.entries() : groups;

  for (const [id, group] of groupEntries) {
    if (!isGroupEffectSource(group)) continue;

    const effectTarget = typeof group.effectTarget === 'string' ? group.effectTarget.trim() : '';
    if (!effectTarget) continue;

    const type = group.type;
    const isShapeGroup = type === 'line' || type === 'area' || type === 'rope';

    if (isShapeGroup) {
      const centroid = computeGroupCentroid(group);
      if (!centroid) continue;
      const memberGroupIds = [id];
      const clusterId = `cluster_${effectTarget}_${shortHash(memberGroupIds)}`;
      result.set(clusterId, {
        id: clusterId,
        effectTarget,
        enabled: inheritEnabledFromPrevious(memberGroupIds, previousClusters),
        memberGroupIds,
        centroid: { ...centroid },
        source: 'group',
      });
      continue;
    }

    const pts = Array.isArray(group.points) ? group.points : [];
    /** @type {Array<{pointIndex:number,x:number,y:number}>} */
    const samples = [];
    for (let pointIndex = 0; pointIndex < pts.length; pointIndex++) {
      const p = pts[pointIndex];
      const x = Number(p?.x);
      const y = Number(p?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      samples.push({ pointIndex, x, y });
    }

    if (samples.length === 0) continue;

    const components = clusterPointSamplesWithWalls(samples, threshold, elevation);

    for (const comp of components) {
      const memberPointIndices = comp.pointIndices;
      const memberGroupIds = [id];
      const clusterId = `cluster_${effectTarget}_${shortHash(memberGroupIds, memberPointIndices)}`;
      result.set(clusterId, {
        id: clusterId,
        effectTarget,
        enabled: inheritEnabledFromPointCluster(id, memberPointIndices, previousClusters),
        memberGroupIds,
        memberPointIndices,
        centroid: { ...comp.centroid },
        source: 'auto',
      });
    }
  }

  return result;
}

/**
 * Build GM toggles for tile-mask fire spatial buckets (one per particle bucket per floor).
 *
 * @param {SpatialControlBucket[]} spatialBuckets
 * @param {Record<string, MapPointControlCluster>|Map<string, MapPointControlCluster>} [previousClusters={}]
 * @returns {Map<string, MapPointControlCluster>}
 */
export function recomputeMaskFireClusters(spatialBuckets, previousClusters = {}) {
  const result = new Map();
  if (!Array.isArray(spatialBuckets) || spatialBuckets.length === 0) return result;

  for (const bucket of spatialBuckets) {
    if (!bucket || typeof bucket !== 'object') continue;
    const floorIndex = Number(bucket.floorIndex);
    const bucketKey = typeof bucket.bucketKey === 'string' ? bucket.bucketKey : '';
    const centroid = bucket.centroid;
    const cx = Number(centroid?.x);
    const cy = Number(centroid?.y);
    if (!bucketKey || !Number.isFinite(floorIndex) || !Number.isFinite(cx) || !Number.isFinite(cy)) continue;

    const safeKey = bucketKey.replace(/,/g, '_');
    const clusterId = `cluster_fire_mask_f${floorIndex}_${safeKey}`;
    result.set(clusterId, {
      id: clusterId,
      effectTarget: 'fire',
      enabled: inheritMaskBucketEnabled(floorIndex, bucketKey, previousClusters),
      memberGroupIds: [],
      maskBucket: {
        floorIndex,
        bucketKey,
        bucketSizePx: Number.isFinite(Number(bucket.bucketSizePx)) ? Number(bucket.bucketSizePx) : undefined,
        memberCellKeys: Array.isArray(bucket.memberCellKeys) ? [...bucket.memberCellKeys] : [bucketKey],
      },
      centroid: { x: cx, y: cy },
      source: 'mask',
    });
  }

  return result;
}

/**
 * @param {Map<string, MapPointControlCluster>} clusters
 * @returns {Map<string, string>}
 */
export function buildGroupIdToClusterIdMap(clusters) {
  const map = new Map();
  for (const cluster of clusters.values()) {
    if (cluster?.source === 'mask') continue;
    const hasPointIndices = Array.isArray(cluster?.memberPointIndices) && cluster.memberPointIndices.length > 0;
    if (hasPointIndices) continue;
    const ids = cluster?.memberGroupIds;
    if (!Array.isArray(ids)) continue;
    for (const groupId of ids) {
      if (typeof groupId === 'string' && groupId.length > 0) {
        map.set(groupId, cluster.id);
      }
    }
  }
  return map;
}

/**
 * @param {Map<string, MapPointControlCluster>} clusters
 * @returns {Map<string, string>}
 */
export function buildPointKeyToClusterIdMap(clusters) {
  const map = new Map();
  for (const cluster of clusters.values()) {
    if (cluster?.source === 'mask') continue;
    const groupIds = cluster?.memberGroupIds;
    const pointIndices = cluster?.memberPointIndices;
    if (!Array.isArray(groupIds) || groupIds.length !== 1) continue;
    if (!Array.isArray(pointIndices) || pointIndices.length === 0) continue;
    const groupId = groupIds[0];
    for (const pointIndex of pointIndices) {
      if (Number.isFinite(pointIndex)) {
        map.set(`${groupId}:${pointIndex}`, cluster.id);
      }
    }
  }
  return map;
}

/**
 * @param {Map<string, MapPointControlCluster>} clusters
 * @returns {Map<string, string>}
 */
export function buildMaskBucketToClusterIdMap(clusters) {
  const map = new Map();
  for (const cluster of clusters.values()) {
    const mb = cluster?.maskBucket;
    if (!mb || typeof mb.bucketKey !== 'string') continue;
    const fi = Number(mb.floorIndex);
    if (!Number.isFinite(fi)) continue;
    const cellKeys = Array.isArray(mb.memberCellKeys) && mb.memberCellKeys.length > 0
      ? mb.memberCellKeys
      : [mb.bucketKey];
    for (const cellKey of cellKeys) {
      if (typeof cellKey === 'string' && cellKey.length > 0) {
        map.set(`${fi}:${cellKey}`, cluster.id);
      }
    }
  }
  return map;
}
