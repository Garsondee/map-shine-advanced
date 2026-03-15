import { createLogger } from '../core/log.js';

const log = createLogger('NavMeshPathfinder');

/**
 * NavMeshPathfinder (foundation)
 *
 * Current phase responsibilities:
 * - Consume NavMeshBuilder snapshots.
 * - Warm full-scene nav graph cache for common token size classes.
 * - Provide diagnostics describing navmesh readiness.
 *
 * Actual cross-floor/portal routing is added in later phases.
 */
export class NavMeshPathfinder {
  constructor() {
    this._snapshot = null;
    this._readyBySize = new Map();
    this._lastWarmupMs = 0;
  }

  /** @returns {object|null} */
  get snapshot() {
    return this._snapshot;
  }

  /** @returns {boolean} */
  get initialized() {
    return !!this._snapshot;
  }

  /**
   * @param {object|null} snapshot
   */
  setSnapshot(snapshot) {
    this._snapshot = snapshot || null;
    this._readyBySize.clear();
  }

  /**
   * Warm precomputed scene nav graphs for common size classes.
   *
   * @param {object} deps
   * @param {(tokenDoc: object, options?: object) => any} deps.getOrBuildSceneNavGraph
   * @param {Array<{width:number,height:number,key:string}>} [deps.sizeClasses]
   * @returns {{warmed:number, classes:Array<{key:string,nodeCount:number,edgeCount:number,buildMs:number}>}}
   */
  warmCommonSizeClasses({ getOrBuildSceneNavGraph, sizeClasses = null } = {}) {
    if (typeof getOrBuildSceneNavGraph !== 'function') {
      return { warmed: 0, classes: [] };
    }

    const defaults = Array.isArray(sizeClasses) && sizeClasses.length > 0
      ? sizeClasses
      : [
          { width: 1, height: 1, key: '1x1' },
          { width: 2, height: 2, key: '2x2' },
          { width: 3, height: 3, key: '3x3' }
        ];

    const classes = [];
    for (const cls of defaults) {
      const width = Math.max(1, Number(cls?.width || 1));
      const height = Math.max(1, Number(cls?.height || 1));
      const key = String(cls?.key || `${width}x${height}`);

      const graph = getOrBuildSceneNavGraph({ width, height }, { collisionMode: 'closest' });
      if (!graph) continue;

      this._readyBySize.set(key, {
        nodeCount: Number(graph?.nodes?.size || 0),
        edgeCount: Number(graph?.edgeCount || 0),
        buildMs: Number(graph?.buildMs || 0),
        sceneId: String(graph?.sceneId || '')
      });

      classes.push({
        key,
        nodeCount: Number(graph?.nodes?.size || 0),
        edgeCount: Number(graph?.edgeCount || 0),
        buildMs: Number(graph?.buildMs || 0)
      });
    }

    this._lastWarmupMs = Date.now();
    return { warmed: classes.length, classes };
  }

  /**
   * @param {string} sizeKey
   * @returns {boolean}
   */
  isReadyForSize(sizeKey) {
    return this._readyBySize.has(String(sizeKey || ''));
  }

  /**
   * @returns {object}
   */
  getDiagnostics() {
    const bySize = {};
    for (const [key, value] of this._readyBySize.entries()) {
      bySize[key] = { ...value };
    }

    return {
      hasSnapshot: !!this._snapshot,
      sceneId: String(this._snapshot?.sceneId || ''),
      wallSegmentCount: Array.isArray(this._snapshot?.wallSegments) ? this._snapshot.wallSegments.length : 0,
      portalCandidateCount: Array.isArray(this._snapshot?.portalCandidates) ? this._snapshot.portalCandidates.length : 0,
      warmSizeCount: this._readyBySize.size,
      warmBySize: bySize,
      lastWarmupMs: this._lastWarmupMs
    };
  }

  logDiagnostics() {
    log.debug('navmesh diagnostics', this.getDiagnostics());
  }
}
