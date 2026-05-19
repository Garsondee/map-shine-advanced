/**
 * @fileoverview Proximity clustering for map-point effect GM toggles.
 * @module scene/map-point-control-clusters
 */

/** Default proximity radius in grid units for autoclustering single-point groups. */
export const DEFAULT_CLUSTER_DISTANCE_GRIDS = 4;

/** Minimum overlap ratio to inherit `enabled` from a previous cluster on rebuild. */
const ENABLED_INHERIT_OVERLAP_RATIO = 0.5;

/**
 * @typedef {Object} MapPointControlCluster
 * @property {string} id
 * @property {string} effectTarget
 * @property {boolean} enabled
 * @property {string[]} memberGroupIds
 * @property {{x:number,y:number}} centroid
 * @property {'auto'|'group'} source
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

/**
 * @param {number} [clusterDistanceGrids]
 * @returns {number}
 */
export function computeClusterDistanceThreshold(clusterDistanceGrids = DEFAULT_CLUSTER_DISTANCE_GRIDS) {
  const gridSize = Number(canvas?.dimensions?.size) || 100;
  const grids = Number.isFinite(clusterDistanceGrids) ? clusterDistanceGrids : DEFAULT_CLUSTER_DISTANCE_GRIDS;
  return Math.max(64, gridSize * grids);
}

/**
 * @param {string[]} memberGroupIds
 * @returns {string}
 */
function shortHash(memberGroupIds) {
  const sorted = [...memberGroupIds].sort();
  let h = 2166136261;
  for (const id of sorted) {
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
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
 * Recompute control clusters from map point groups.
 *
 * @param {Iterable<[string, object]>|Map<string, object>} groups
 * @param {Record<string, MapPointControlCluster>|Map<string, MapPointControlCluster>} [previousClusters={}]
 * @param {{ clusterDistanceGrids?: number }} [options]
 * @returns {Map<string, MapPointControlCluster>}
 */
export function recomputeControlClusters(groups, previousClusters = {}, options = {}) {
  const threshold = computeClusterDistanceThreshold(options.clusterDistanceGrids);
  const thresholdSq = threshold * threshold;
  const result = new Map();

  /** @type {Map<string, Array<{id:string, group:object, centroid:{x:number,y:number}}>>} */
  const byEffect = new Map();

  const groupEntries = groups instanceof Map ? groups.entries() : groups;

  for (const [id, group] of groupEntries) {
    if (!group || typeof group !== 'object') continue;
    if (!group.isEffectSource) continue;
    const effectTarget = typeof group.effectTarget === 'string' ? group.effectTarget.trim() : '';
    if (!effectTarget) continue;

    const centroid = computeGroupCentroid(group);
    if (!centroid) continue;

    if (!byEffect.has(effectTarget)) byEffect.set(effectTarget, []);
    byEffect.get(effectTarget).push({ id, group, centroid });
  }

  for (const [effectTarget, entries] of byEffect) {
    /** @type {Array<{id:string, group:object, centroid:{x:number,y:number}}>} */
    const shapeGroups = [];
    /** @type {Array<{groupId:string, x:number, y:number}>} */
    const pointSamples = [];

    for (const entry of entries) {
      const g = entry.group;
      const type = g.type;
      const isLineOrArea = type === 'line' || type === 'area' || type === 'rope';

      if (isLineOrArea) {
        shapeGroups.push(entry);
        continue;
      }

      // Point-type (and unknown): cluster by individual point proximity so a single
      // authored group with many candles still splits into room-scale toggles.
      const pts = Array.isArray(g.points) ? g.points : [];
      for (const p of pts) {
        const x = Number(p?.x);
        const y = Number(p?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        pointSamples.push({ groupId: entry.id, x, y });
      }
    }

    for (const entry of shapeGroups) {
      const memberGroupIds = [entry.id];
      const clusterId = `cluster_${effectTarget}_${shortHash(memberGroupIds)}`;
      result.set(clusterId, {
        id: clusterId,
        effectTarget,
        enabled: inheritEnabledFromPrevious(memberGroupIds, previousClusters),
        memberGroupIds,
        centroid: { ...entry.centroid },
        source: 'group',
      });
    }

    if (pointSamples.length > 0) {
      const uf = new UnionFind(pointSamples.length);
      for (let i = 0; i < pointSamples.length; i++) {
        for (let j = i + 1; j < pointSamples.length; j++) {
          const dx = pointSamples[i].x - pointSamples[j].x;
          const dy = pointSamples[i].y - pointSamples[j].y;
          if (dx * dx + dy * dy <= thresholdSq) {
            uf.union(i, j);
          }
        }
      }

      /** @type {Map<number, number[]>} */
      const components = new Map();
      for (let i = 0; i < pointSamples.length; i++) {
        const root = uf.find(i);
        if (!components.has(root)) components.set(root, []);
        components.get(root).push(i);
      }

      for (const indices of components.values()) {
        const memberSet = new Set();
        let sumX = 0;
        let sumY = 0;
        for (const idx of indices) {
          const sample = pointSamples[idx];
          memberSet.add(sample.groupId);
          sumX += sample.x;
          sumY += sample.y;
        }
        const memberGroupIds = [...memberSet].sort();
        const n = indices.length;
        const clusterId = `cluster_${effectTarget}_${shortHash(memberGroupIds)}`;
        result.set(clusterId, {
          id: clusterId,
          effectTarget,
          enabled: inheritEnabledFromPrevious(memberGroupIds, previousClusters),
          memberGroupIds,
          centroid: { x: sumX / n, y: sumY / n },
          source: 'auto',
        });
      }
    }
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
