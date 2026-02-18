/**
 * @fileoverview Token movement manager.
 *
 * Centralizes movement-style orchestration for token sprite transitions while
 * preserving Foundry's authoritative token document updates.
 *
 * Initial implementation scope:
 * - Style registry and per-token style selection
 * - Custom Pick Up and Drop track animation
 * - Door/fog policy contracts and helper APIs for upcoming phases
 *
 * @module scene/token-movement-manager
 */

import { createLogger } from '../core/log.js';
import { readWallHeightFlags } from '../foundry/levels-scene-flags.js';

const log = createLogger('TokenMovementManager');

const MODULE_ID = 'map-shine-advanced';
const DEFAULT_STYLE = 'walk';
const WALK_STYLE_IDS = new Set([
  'walk',
  'walk-heavy-stomp',
  'walk-sneak-glide',
  'walk-swagger-stride',
  'walk-skitter-step',
  'walk-limping-advance',
  'walk-wobble-totter',
  'walk-drunken-drift',
  'walk-clockwork-tick',
  'walk-chaos-skip'
]);

const FLYING_STYLE_IDS = new Set([
  'flying-glide',
  'flying-hover-bob',
  'flying-bank-swoop',
  'flying-flutter-dart',
  'flying-chaos-drift'
]);

const DOOR_TYPES = {
  NONE: 0,
  DOOR: 1,
  SECRET: 2
};

const DOOR_STATES = {
  CLOSED: 0,
  OPEN: 1,
  LOCKED: 2
};

const FOG_PATH_POLICIES = new Set([
  'strictNoFogPath',
  'allowButRedact',
  'gmUnrestricted'
]);

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hashStringToUnit(value) {
  const source = String(value || '');
  let hash = 2166136261;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

/**
 * Binary min-heap keyed by a numeric score. Used to replace the O(n) linear
 * scan in A* open-set extraction with O(log n) insert/extract-min.
 *
 * Each entry is { key: string, score: number }. The heap also maintains a
 * Set of keys currently in the heap so `has()` is O(1).
 */
class BinaryMinHeap {
  constructor() {
    /** @type {Array<{key:string, score:number}>} */
    this._data = [];
    /** @type {Set<string>} */
    this._keys = new Set();
  }

  get size() {
    return this._data.length;
  }

  has(key) {
    return this._keys.has(key);
  }

  /**
   * Insert or update an entry. If the key already exists with a higher score,
   * we push a duplicate (lazy deletion) — the stale copy is skipped in pop().
   */
  push(key, score) {
    this._data.push({ key, score });
    this._keys.add(key);
    this._bubbleUp(this._data.length - 1);
  }

  /**
   * Extract the entry with the lowest score, skipping stale duplicates
   * that were superseded by a later push with a lower score.
   * @returns {{key:string, score:number}|null}
   */
  pop() {
    while (this._data.length > 0) {
      const top = this._data[0];
      const last = this._data.pop();
      if (this._data.length > 0 && last) {
        this._data[0] = last;
        this._sinkDown(0);
      }
      // Skip stale entries (key was already removed or superseded).
      if (this._keys.has(top.key)) {
        this._keys.delete(top.key);
        return top;
      }
    }
    return null;
  }

  /**
   * Remove a key from the live set so it is skipped by future pop() calls.
   */
  remove(key) {
    this._keys.delete(key);
  }

  /** @private */
  _bubbleUp(i) {
    const data = this._data;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (data[i].score >= data[parent].score) break;
      [data[i], data[parent]] = [data[parent], data[i]];
      i = parent;
    }
  }

  /** @private */
  _sinkDown(i) {
    const data = this._data;
    const n = data.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && data[left].score < data[smallest].score) smallest = left;
      if (right < n && data[right].score < data[smallest].score) smallest = right;
      if (smallest === i) break;
      [data[i], data[smallest]] = [data[smallest], data[i]];
      i = smallest;
    }
  }
}

function shortestAngleDelta(from, to) {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class TokenMovementManager {
  /**
   * @param {object} [deps]
   * @param {import('./token-manager.js').TokenManager|null} [deps.tokenManager]
   * @param {import('./wall-manager.js').WallManager|null} [deps.wallManager]
   */
  constructor({ tokenManager = null, wallManager = null } = {}) {
    this.tokenManager = tokenManager;
    this.wallManager = wallManager;

    this.initialized = false;

    /** @type {Map<string, {id: string, label: string, mode: string}>} */
    this.styles = new Map();
    this._registerDefaultStyles();

    /** @type {Map<string, string>} */
    this.tokenStyleOverrides = new Map();

    /** @type {Map<string, any>} */
    this.activeTracks = new Map();

    /** @type {Array<[string, number]>} */
    this._hookIds = [];

    /**
     * Per-token move locks prevent overlapping async move sequences from
     * racing on the same token (e.g. rapid double-clicks or latent hooks).
     * Key = tokenId, Value = lock entry containing a Promise resolved when
     * the current move ends.
     * @type {Map<string, {promise: Promise<void>, _resolve?: Function, ownerId: string, createdAtMs: number}>}
     */
    this._activeMoveLocks = new Map();

    /**
     * Global group-move lock prevents concurrent group operations from
     * interleaving and causing deadlocks.
     * @type {{promise: Promise<void>, _resolve?: Function, ownerId: string, createdAtMs: number}|null}
     */
    this._groupMoveLock = null;

    /**
     * Cancel token for the currently executing group move timeline. When a
     * new movement order arrives, the previous token's `.cancelled` flag is
     * set to `true`, causing the in-flight timeline to abort at the next
     * step boundary so the new order can proceed immediately instead of
     * waiting for the full previous animation to finish.
     * @type {{cancelled:boolean}|null}
     */
    this._activeGroupCancelToken = null;

    this._doorStateRevision = 0;
    this._inCombat = false;
    this._pathSearchGeneration = 0;

    /**
     * Ephemeral cache of group plans built during preview and reused during
     * confirm/execute to avoid duplicate expensive planning on the same target.
     * @type {Map<string, {createdAtMs:number, signatureJson:string, planResult:any}>}
     */
    this._groupPlanCache = new Map();
    this._groupPlanCacheTtlMs = 8000;
    this._groupPlanCacheMaxEntries = 12;

    /** @type {{sceneId:string, revision:number, doorEntries:Array<object>, buckets:Map<string, Array<object>>, bucketSize:number, builtAtMs:number}|null} */
    this._doorSpatialIndex = null;
    /** @type {{sceneId:string, revision:number, sectorSize:number, cols:number, rows:number, sceneRect:{x:number,y:number,width:number,height:number}, sectors:Array<object>, sectorsById:Map<string, object>, builtAtMs:number}|null} */
    this._hpaSectorIndex = null;
    /** @type {Map<string, {sceneId:string, revision:number, sectorSize:number, adjacency:Map<string, Array<object>>, builtAtMs:number}>} */
    this._hpaAdjacencyCache = new Map();

    /**
     * Full-scene precomputed navigation graphs keyed by token collision size
     * class (e.g. "1x1", "2x2"). Each entry contains all reachable grid cell
     * nodes and their collision-tested adjacency so `findWeightedPath` can skip
     * the expensive per-call `generateMovementGraph` entirely.
     * Built during pathfinding prewarm (scene load) and invalidated when wall
     * topology changes.
     * @type {Map<string, {sceneId:string, revision:number, sizeKey:string, nodes:Map<string,{x:number,y:number,key:string}>, adjacency:Map<string,Array<{toKey:string,cost:number}>>, edgeCount:number, gridType:number, gridSizeX:number, gridSizeY:number, latticeStep:number, builtAtMs:number, buildMs:number}>}
     */
    this._sceneNavGraphCache = new Map();

    this._pathPrewarmTimer = null;
    this._pathPrewarmLastSceneId = '';
    this._pathPrewarmLastRevision = -1;

    this.settings = {
      defaultStyle: DEFAULT_STYLE,
      weightedAStarWeight: 1.15,
      fogPathPolicy: 'strictNoFogPath',
      doorPolicy: {
        autoOpen: true,
        autoClose: 'outOfCombatOnly',
        closeDelayMs: 0,
        playerAutoDoorEnabled: false,
        requireDoorPermission: true
      }
    };
  }

  /**
   * Decide whether a sequenced movement step should include Foundry's movement payload.
   * For path-walk mode, we intentionally suppress payload so Foundry does not render
   * per-step ruler/blue-grid overlays while our own path-walk choreography is running.
   *
   * @param {object} options
   * @param {object} context
   * @returns {boolean}
   */
  _shouldIncludeMovementPayloadForStep(options = {}, context = {}) {
    if (optionsBoolean(options?.suppressFoundryMovementUI, false)) return false;

    const method = String(options?.method || '').toLowerCase();
    if (method === 'path-walk' || method === 'walk') return false;

    // If caller explicitly sets includeMovementPayload, honor that override.
    if (Object.prototype.hasOwnProperty.call(options, 'includeMovementPayload')) {
      return optionsBoolean(options?.includeMovementPayload, false);
    }

    // Default behavior for legacy call sites.
    return optionsBoolean(options?.ignoreWalls, false)
      || optionsBoolean(options?.ignoreCost, false);
  }

  /**
   * Unified diagnostics logger for pathfinding-related flows.
   * Every entry includes a "[Pathfinding]" marker for easy filtering.
   *
   * @param {'debug'|'info'|'warn'|'error'} level
   * @param {string} message
   * @param {object|null} [details]
   * @param {any} [error]
   */
  _pathfindingLog(level, message, details = null, error = null) {
    const method = (typeof log?.[level] === 'function') ? log[level].bind(log) : log.info.bind(log);
    const taggedMessage = `[Pathfinding] ${message}`;
    if (details && error) {
      method(taggedMessage, details, error);
      return;
    }
    if (error) {
      method(taggedMessage, error);
      return;
    }
    if (details) {
      method(taggedMessage, details);
      return;
    }
    method(taggedMessage);
  }

  /**
   * Build compact token metadata for diagnostics payloads.
   *
   * @param {TokenDocument|object|null} tokenDoc
   * @returns {{tokenId:string, tokenName:string, x:number, y:number, width:number, height:number}}
   */
  _pathfindingTokenMeta(tokenDoc) {
    return {
      tokenId: String(tokenDoc?.id || ''),
      tokenName: String(tokenDoc?.name || ''),
      x: asNumber(tokenDoc?.x, NaN),
      y: asNumber(tokenDoc?.y, NaN),
      width: asNumber(tokenDoc?.width, NaN),
      height: asNumber(tokenDoc?.height, NaN)
    };
  }

  /**
   * @returns {number}
   */
  _nowMs() {
    if (globalThis?.performance && typeof globalThis.performance.now === 'function') {
      return globalThis.performance.now();
    }
    return Date.now();
  }

  /**
   * @param {object} signature
   * @returns {string}
   */
  _serializeGroupPlanSignature(signature) {
    try {
      return JSON.stringify(signature || {});
    } catch (_) {
      return '';
    }
  }

  /**
   * @returns {{weightedPath:{calls:number,success:number,fail:number,iterationsTotal:number,graphNodeTotal:number,graphEdgeTotal:number,graphTruncatedCount:number,reasonCounts:Record<string,number>}}}
   */
  _createPathfindingStatsCollector() {
    return {
      weightedPath: {
        calls: 0,
        success: 0,
        fail: 0,
        iterationsTotal: 0,
        graphNodeTotal: 0,
        graphEdgeTotal: 0,
        graphTruncatedCount: 0,
        doorSegmentCallsTotal: 0,
        doorSegmentCacheHitsTotal: 0,
        reasonCounts: {}
      }
    };
  }

  /**
   * @param {object|null} statsCollector
   * @param {{ok:boolean, reason?:string, iterations?:number, graphDiagnostics?:object|null}} result
   */
  _recordWeightedPathStats(statsCollector, result = {}) {
    if (!statsCollector || typeof statsCollector !== 'object') return;
    if (!statsCollector.weightedPath || typeof statsCollector.weightedPath !== 'object') {
      statsCollector.weightedPath = this._createPathfindingStatsCollector().weightedPath;
    }

    const stats = statsCollector.weightedPath;
    stats.calls += 1;
    if (result.ok) stats.success += 1;
    else stats.fail += 1;

    stats.iterationsTotal += Math.max(0, asNumber(result.iterations, 0));

    const graphDiagnostics = result.graphDiagnostics && typeof result.graphDiagnostics === 'object'
      ? result.graphDiagnostics
      : null;
    if (graphDiagnostics) {
      stats.graphNodeTotal += Math.max(0, asNumber(graphDiagnostics.nodeCount, 0));
      stats.graphEdgeTotal += Math.max(0, asNumber(graphDiagnostics.edgeCount, 0));
      if (graphDiagnostics.truncated) stats.graphTruncatedCount += 1;
      stats.doorSegmentCallsTotal += Math.max(0, asNumber(graphDiagnostics.doorSegmentCalls, 0));
      stats.doorSegmentCacheHitsTotal += Math.max(0, asNumber(graphDiagnostics.doorSegmentCacheHits, 0));
    }

    const reasonKey = String(result.reason || (result.ok ? 'ok' : 'unknown'));
    stats.reasonCounts[reasonKey] = asNumber(stats.reasonCounts[reasonKey], 0) + 1;
  }

  /**
   * @param {object|null} statsCollector
   * @returns {object|null}
   */
  _summarizePathfindingStats(statsCollector) {
    const stats = statsCollector?.weightedPath;
    if (!stats) return null;

    const calls = Math.max(0, asNumber(stats.calls, 0));
    return {
      calls,
      success: Math.max(0, asNumber(stats.success, 0)),
      fail: Math.max(0, asNumber(stats.fail, 0)),
      avgIterations: calls > 0 ? (asNumber(stats.iterationsTotal, 0) / calls) : 0,
      avgGraphNodes: calls > 0 ? (asNumber(stats.graphNodeTotal, 0) / calls) : 0,
      avgGraphEdges: calls > 0 ? (asNumber(stats.graphEdgeTotal, 0) / calls) : 0,
      truncatedGraphs: Math.max(0, asNumber(stats.graphTruncatedCount, 0)),
      doorSegmentCalls: Math.max(0, asNumber(stats.doorSegmentCallsTotal, 0)),
      doorSegmentCacheHits: Math.max(0, asNumber(stats.doorSegmentCacheHitsTotal, 0)),
      doorSegmentCacheHitRate: asNumber(stats.doorSegmentCallsTotal, 0) > 0
        ? (asNumber(stats.doorSegmentCacheHitsTotal, 0) / asNumber(stats.doorSegmentCallsTotal, 0))
        : 0,
      reasonCounts: { ...(stats.reasonCounts || {}) }
    };
  }

  /**
   * @param {number} groupSize
   * @returns {{maxRadiusCells:number, maxCandidatesPerToken:number, pathEvalCandidates:number}}
   */
  _getAdaptiveGroupCandidateDefaults(groupSize) {
    const size = Math.max(1, Math.round(asNumber(groupSize, 1)));
    if (size <= 3) return { maxRadiusCells: 8, maxCandidatesPerToken: 14, pathEvalCandidates: 8 };
    if (size <= 5) return { maxRadiusCells: 9, maxCandidatesPerToken: 16, pathEvalCandidates: 10 };
    if (size <= 8) return { maxRadiusCells: 10, maxCandidatesPerToken: 20, pathEvalCandidates: 12 };
    return { maxRadiusCells: 12, maxCandidatesPerToken: 24, pathEvalCandidates: 14 };
  }

  /**
   * @param {{startMs:number,budgetMs:number,triggered?:boolean,overrunMs?:number}|null} planBudget
   * @returns {boolean}
   */
  _isGroupPlanningBudgetExceeded(planBudget) {
    if (!planBudget || !Number.isFinite(asNumber(planBudget.budgetMs, NaN)) || asNumber(planBudget.budgetMs, 0) <= 0) {
      return false;
    }
    const elapsedMs = this._nowMs() - asNumber(planBudget.startMs, 0);
    if (elapsedMs <= asNumber(planBudget.budgetMs, 0)) return false;
    planBudget.triggered = true;
    planBudget.overrunMs = Math.max(asNumber(planBudget.overrunMs, 0), elapsedMs - asNumber(planBudget.budgetMs, 0));
    return true;
  }

  /**
   * Build one-shot expanded planning options after a failed group plan.
   *
   * @param {object} options
   * @param {{reason?:string}|null} planResult
   * @returns {object|null}
   */
  _buildGroupPlanRetryOptions(options = {}, planResult = null) {
    if (optionsBoolean(options?.groupPlanRetryDisabled, false)) return null;
    if (optionsBoolean(options?.__groupPlanRetried, false)) return null;

    const reason = String(planResult?.reason || '');
    const retryableReasons = [
      'group-assignment-failed',
      'no-non-overlap-assignment',
      'backtrack-budget-exceeded',
      'no-group-candidate-'
    ];
    const isRetryable = retryableReasons.some((needle) => reason.includes(needle));
    if (!isRetryable) return null;

    const baseMaxNodes = Math.max(256, asNumber(options?.maxGraphNodes, 6000));
    const baseIterations = Math.max(256, asNumber(options?.maxSearchIterations, 12000));
    const baseSearchMargin = Math.max(0, asNumber(options?.searchMarginPx, 260));
    const baseGroupCandidates = Math.max(4, asNumber(options?.groupMaxCandidatesPerToken, 16));
    const basePathEvalCandidates = Math.max(4, asNumber(options?.groupPathEvalCandidatesPerToken, 10));

    return {
      ...options,
      __groupPlanRetried: true,
      searchMarginPx: clamp(baseSearchMargin + 180, 120, 1800),
      maxGraphNodes: clamp(Math.round(baseMaxNodes * 1.5), 1000, 18000),
      maxSearchIterations: clamp(Math.round(baseIterations * 1.35), 1000, 26000),
      groupMaxCandidatesPerToken: clamp(Math.round(baseGroupCandidates + 4), 6, 48),
      groupPathEvalCandidatesPerToken: clamp(Math.round(basePathEvalCandidates + 4), 4, 30),
      groupPlanningBudgetMs: clamp(asNumber(options?.groupPlanningBudgetMs, 280) + 120, 40, 1600),
      groupBacktrackBudgetMs: clamp(asNumber(options?.groupBacktrackBudgetMs, 45) + 25, 5, 2500),
      groupBacktrackNodeLimit: clamp(Math.round(asNumber(options?.groupBacktrackNodeLimit, 30000) * 1.5), 5000, 600000),
      // For clustered right-click moves this can over-constrain dense scenes.
      // Retry once with relaxed side-enforcement to recover valid plans.
      enforceAnchorSide: options?.enforceAnchorSide ? false : optionsBoolean(options?.enforceAnchorSide, false)
    };
  }

  /**
   * Run weighted path search with a single bounded expansion retry when initial
   * search likely failed due constrained bounds/budgets.
   *
   * @param {object} params
   * @param {{x:number,y:number}} params.start
   * @param {{x:number,y:number}} params.end
   * @param {TokenDocument|object|null} [params.tokenDoc]
   * @param {object} [params.options]
   * @param {{cancelled:boolean}|null} [params.cancelToken]
   * @param {boolean} [params.preferLongRange]
   * @returns {{ok:boolean,pathNodes:Array<{x:number,y:number}>,reason?:string,diagnostics?:object,adaptiveExpansionUsed?:boolean,initialReason?:string}}
   */
  _findWeightedPathWithAdaptiveExpansion({
    start,
    end,
    tokenDoc = null,
    options = {},
    cancelToken = null,
    preferLongRange = false
  } = {}) {
    const baseOptions = options && typeof options === 'object'
      ? { ...options }
      : {};

    const firstResult = this.findWeightedPath({
      start,
      end,
      tokenDoc,
      options: baseOptions,
      cancelToken
    });

    if (firstResult?.ok || optionsBoolean(baseOptions?.ignoreWalls, false)) {
      return {
        ...(firstResult || { ok: false, pathNodes: [], reason: 'weighted-path-failed' }),
        adaptiveExpansionUsed: false
      };
    }

    if (optionsBoolean(baseOptions?.disableAdaptivePathExpansion, false)
      || optionsBoolean(baseOptions?.__adaptivePathExpansionApplied, false)) {
      return {
        ...(firstResult || { ok: false, pathNodes: [], reason: 'weighted-path-failed' }),
        adaptiveExpansionUsed: false
      };
    }

    const reason = String(firstResult?.reason || '');
    const graphDiagnostics = firstResult?.diagnostics?.graphDiagnostics || null;
    const retryableReason = reason === 'no-path' || reason === 'max-iterations';
    const graphTruncated = optionsBoolean(graphDiagnostics?.truncated, false);
    const lowConnectivity = asNumber(graphDiagnostics?.nodeCount, 0) <= 28;
    const shouldRetry = retryableReason
      && (graphTruncated || lowConnectivity || preferLongRange || reason === 'max-iterations');

    if (!shouldRetry) {
      return {
        ...(firstResult || { ok: false, pathNodes: [], reason: 'weighted-path-failed' }),
        adaptiveExpansionUsed: false
      };
    }

    const startX = asNumber(start?.x, 0);
    const startY = asNumber(start?.y, 0);
    const endX = asNumber(end?.x, 0);
    const endY = asNumber(end?.y, 0);
    const directDistance = Math.hypot(endX - startX, endY - startY);

    const baseMargin = Math.max(0, asNumber(baseOptions?.searchMarginPx, 260));
    const expandedMargin = preferLongRange
      ? Math.max(baseMargin + 260, (directDistance * 0.9) + 240)
      : Math.max(baseMargin + 180, (directDistance * 0.6) + 180);

    const baseGraphNodes = Math.max(128, asNumber(baseOptions?.maxGraphNodes, 6000));
    const baseIterations = Math.max(64, asNumber(baseOptions?.maxSearchIterations, 12000));

    const retryOptions = {
      ...baseOptions,
      __adaptivePathExpansionApplied: true,
      suppressNoPathLog: true,
      searchMarginPx: clamp(Math.round(expandedMargin), 120, 2800),
      maxGraphNodes: clamp(Math.round(baseGraphNodes * 1.8), 1000, 24000),
      maxSearchIterations: clamp(Math.round(baseIterations * 1.6), 1000, 38000)
    };

    const retryResult = this.findWeightedPath({
      start,
      end,
      tokenDoc,
      options: retryOptions,
      cancelToken
    });

    return {
      ...(retryResult || { ok: false, pathNodes: [], reason: 'weighted-path-failed' }),
      adaptiveExpansionUsed: true,
      initialReason: reason || null
    };
  }

  /**
   * Build per-token destination slots around the anchor to reduce endpoint
   * overlap pressure in dense group arrivals.
   *
   * @param {Array<{tokenId:string,startCenter:{x:number,y:number}}>} entries
   * @param {{x:number,y:number}} anchorCenter
   * @param {object} [options]
   * @returns {Map<string, {x:number,y:number,ring:number,angle:number}>}
   */
  _buildGroupFormationSlots(entries = [], anchorCenter = { x: 0, y: 0 }, options = {}) {
    const list = Array.isArray(entries) ? entries.filter((e) => !!e?.tokenId) : [];
    const slots = new Map();
    if (list.length <= 1) return slots;

    const anchorX = asNumber(anchorCenter?.x, 0);
    const anchorY = asNumber(anchorCenter?.y, 0);

    // Compute centroid of all starting positions.
    const centroid = list.reduce((acc, entry) => {
      acc.x += asNumber(entry?.startCenter?.x, 0);
      acc.y += asNumber(entry?.startCenter?.y, 0);
      return acc;
    }, { x: 0, y: 0 });
    centroid.x /= Math.max(1, list.length);
    centroid.y /= Math.max(1, list.length);

    // Preserve the original formation: each token's slot is its starting
    // offset from the group centroid, re-applied around the anchor center.
    // This keeps the same spatial arrangement (e.g. a 2×3 grid stays 2×3)
    // instead of rearranging tokens into a circular ring.
    for (const entry of list) {
      const startX = asNumber(entry?.startCenter?.x, 0);
      const startY = asNumber(entry?.startCenter?.y, 0);
      const offsetX = startX - centroid.x;
      const offsetY = startY - centroid.y;
      const angle = Math.atan2(offsetY, offsetX);

      slots.set(entry.tokenId, {
        x: anchorX + offsetX,
        y: anchorY + offsetY,
        ring: 0,
        angle
      });
    }

    return slots;
  }

  /**
   * @param {object} params
   * @param {Array<{tokenDoc: TokenDocument|object, destinationTopLeft: {x:number,y:number}}>} params.tokenMoves
   * @param {object} params.options
   * @returns {object}
   */
  _buildGroupPlanSignature({ tokenMoves = [], options = {} } = {}) {
    const moves = Array.isArray(tokenMoves) ? tokenMoves : [];
    const normalizedMoves = [];

    for (const move of moves) {
      const tokenId = String(move?.tokenDoc?.id || move?._id || '');
      if (!tokenId) continue;

      const liveDoc = this._resolveTokenDocumentById(tokenId, move?.tokenDoc);
      if (!liveDoc) continue;

      const destX = asNumber(move?.destinationTopLeft?.x, NaN);
      const destY = asNumber(move?.destinationTopLeft?.y, NaN);
      if (!Number.isFinite(destX) || !Number.isFinite(destY)) continue;

      const snappedDestination = this._snapTokenTopLeftToGrid({ x: destX, y: destY }, liveDoc);
      normalizedMoves.push({
        tokenId,
        startX: Math.round(asNumber(liveDoc?.x, 0)),
        startY: Math.round(asNumber(liveDoc?.y, 0)),
        destinationX: Math.round(asNumber(snappedDestination?.x, 0)),
        destinationY: Math.round(asNumber(snappedDestination?.y, 0))
      });
    }

    normalizedMoves.sort((a, b) => a.tokenId.localeCompare(b.tokenId));

    const signatureOptions = {
      ignoreWalls: optionsBoolean(options?.ignoreWalls, false),
      ignoreCost: optionsBoolean(options?.ignoreCost, false),
      allowDiagonal: optionsBoolean(options?.allowDiagonal, true),
      fogPathPolicy: String(options?.fogPathPolicy || this.settings.fogPathPolicy || 'strictNoFogPath'),
      enforceAnchorSide: optionsBoolean(options?.enforceAnchorSide, false),
      groupAnchorTokenId: String(options?.groupAnchorTokenId || ''),
      groupAnchorTopLeftX: Math.round(asNumber(options?.groupAnchorTopLeft?.x, NaN)),
      groupAnchorTopLeftY: Math.round(asNumber(options?.groupAnchorTopLeft?.y, NaN)),
      groupMaxRadiusCells: Math.round(asNumber(options?.groupMaxRadiusCells, NaN)),
      groupMaxCandidatesPerToken: Math.round(asNumber(options?.groupMaxCandidatesPerToken, NaN)),
      groupPathEvalCandidatesPerToken: Math.round(asNumber(options?.groupPathEvalCandidatesPerToken, NaN)),
      groupBudgetMinCandidatesPerToken: Math.round(asNumber(options?.groupBudgetMinCandidatesPerToken, NaN)),
      groupBacktrackTokenLimit: Math.round(asNumber(options?.groupBacktrackTokenLimit, NaN)),
      groupBacktrackBudgetMs: Math.round(asNumber(options?.groupBacktrackBudgetMs, NaN)),
      groupBacktrackNodeLimit: Math.round(asNumber(options?.groupBacktrackNodeLimit, NaN)),
      maxSearchIterations: Math.round(asNumber(options?.maxSearchIterations, NaN)),
      maxGraphNodes: Math.round(asNumber(options?.maxGraphNodes, NaN)),
      searchMarginPx: Math.round(asNumber(options?.searchMarginPx, NaN)),
      latticeStepPx: Math.round(asNumber(options?.latticeStepPx, NaN)),
      groupPlanningBudgetMs: Math.round(asNumber(options?.groupPlanningBudgetMs, NaN))
    };

    return {
      doorStateRevision: this._doorStateRevision,
      inCombat: this._inCombat,
      moves: normalizedMoves,
      options: signatureOptions
    };
  }

  /**
   * @param {object} params
   * @param {Array<{tokenDoc: TokenDocument|object, destinationTopLeft: {x:number,y:number}}>} params.tokenMoves
   * @param {object} params.options
   * @param {object} params.planResult
   * @returns {string}
   */
  _storeGroupPlanCacheEntry({ tokenMoves = [], options = {}, planResult = null } = {}) {
    if (!planResult?.ok) return '';

    this._purgeExpiredGroupPlanCache();

    const signatureJson = this._serializeGroupPlanSignature(this._buildGroupPlanSignature({ tokenMoves, options }));
    if (!signatureJson) return '';

    const cacheKey = `group-plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this._groupPlanCache.set(cacheKey, {
      createdAtMs: this._nowMs(),
      signatureJson,
      planResult
    });

    // Keep cache bounded by dropping oldest entries.
    if (this._groupPlanCache.size > this._groupPlanCacheMaxEntries) {
      const entries = [...this._groupPlanCache.entries()]
        .sort((a, b) => asNumber(a[1]?.createdAtMs, 0) - asNumber(b[1]?.createdAtMs, 0));
      const dropCount = this._groupPlanCache.size - this._groupPlanCacheMaxEntries;
      for (let i = 0; i < dropCount; i++) {
        this._groupPlanCache.delete(entries[i][0]);
      }
    }

    return cacheKey;
  }

  /**
   * @param {string} cacheKey
   * @param {object} params
   * @param {Array<{tokenDoc: TokenDocument|object, destinationTopLeft: {x:number,y:number}}>} params.tokenMoves
   * @param {object} params.options
   * @returns {object|null}
   */
  _consumeGroupPlanCacheEntry(cacheKey, { tokenMoves = [], options = {} } = {}) {
    const key = String(cacheKey || '');
    if (!key) return null;

    this._purgeExpiredGroupPlanCache();

    const cached = this._groupPlanCache.get(key);
    if (!cached) return null;

    // One-shot consumption keeps the cache fresh and avoids stale reuse.
    this._groupPlanCache.delete(key);

    const expectedSignatureJson = this._serializeGroupPlanSignature(this._buildGroupPlanSignature({ tokenMoves, options }));
    if (!expectedSignatureJson || cached.signatureJson !== expectedSignatureJson) {
      return null;
    }

    return cached.planResult || null;
  }

  _purgeExpiredGroupPlanCache() {
    if (!this._groupPlanCache || this._groupPlanCache.size === 0) return;
    const nowMs = this._nowMs();
    const ttlMs = Math.max(1, asNumber(this._groupPlanCacheTtlMs, 8000));
    for (const [key, entry] of this._groupPlanCache.entries()) {
      const ageMs = nowMs - asNumber(entry?.createdAtMs, 0);
      if (ageMs > ttlMs) {
        this._groupPlanCache.delete(key);
      }
    }
  }

  initialize() {
    if (this.initialized) return;

    this._evaluateCombatState();
    this._setupHooks();

    this.initialized = true;
    this._schedulePathfindingPrewarm('initialize', 220);
    log.info('TokenMovementManager initialized');
  }

  dispose() {
    for (const [name, id] of this._hookIds) {
      try {
        Hooks.off(name, id);
      } catch (_) {
      }
    }
    this._hookIds.length = 0;

    for (const track of this.activeTracks.values()) {
      this._cancelTrack(track);
    }
    this.activeTracks.clear();

    // Clean up all flying hover states and their Three.js objects
    if (this._flyingTokens) {
      for (const tokenId of [...this._flyingTokens.keys()]) {
        this.clearFlyingState(tokenId);
      }
    }

    this._activeMoveLocks.clear();
    this._groupMoveLock = null;
    if (this._activeGroupCancelToken) {
      this._activeGroupCancelToken.cancelled = true;
      this._activeGroupCancelToken = null;
    }
    this._groupPlanCache.clear();

    if (this._pathPrewarmTimer) {
      clearTimeout(this._pathPrewarmTimer);
      this._pathPrewarmTimer = null;
    }
    this._doorSpatialIndex = null;
    this._hpaSectorIndex = null;
    this._hpaAdjacencyCache.clear();
    this._sceneNavGraphCache.clear();
    this._pathPrewarmLastSceneId = '';
    this._pathPrewarmLastRevision = -1;

    this.tokenStyleOverrides.clear();
    this.initialized = false;

    log.info('TokenMovementManager disposed');
  }

  /**
   * @param {object} deps
   * @param {import('./token-manager.js').TokenManager|null} [deps.tokenManager]
   * @param {import('./wall-manager.js').WallManager|null} [deps.wallManager]
   */
  setDependencies({ tokenManager = null, wallManager = null } = {}) {
    if (tokenManager !== null) this.tokenManager = tokenManager;
    if (wallManager !== null) {
      this.wallManager = wallManager;
      this._doorSpatialIndex = null;
      this._hpaSectorIndex = null;
      this._hpaAdjacencyCache.clear();
      this._sceneNavGraphCache.clear();
      this._pathPrewarmLastRevision = -1;
    }
  }

  /**
   * @param {string} [reason]
   */
  _markPathfindingTopologyDirty(reason = '') {
    this._doorStateRevision += 1;
    this._doorSpatialIndex = null;
    this._hpaSectorIndex = null;
    this._hpaAdjacencyCache.clear();
    this._sceneNavGraphCache.clear();
    this._pathPrewarmLastRevision = -1;
    this._schedulePathfindingPrewarm(reason || 'topology-dirty', 180);
  }

  /**
   * @param {string} [reason]
   * @param {number} [delayMs]
   */
  _schedulePathfindingPrewarm(reason = '', delayMs = 140) {
    if (!this.initialized) return;

    if (this._pathPrewarmTimer) {
      clearTimeout(this._pathPrewarmTimer);
      this._pathPrewarmTimer = null;
    }

    const delay = Math.max(0, Math.round(asNumber(delayMs, 140)));
    this._pathPrewarmTimer = setTimeout(() => {
      this._pathPrewarmTimer = null;

      const run = () => {
        try {
          this._runPathfindingPrewarm(reason || 'scheduled');
        } catch (_) {
        }
      };

      if (typeof globalThis?.requestIdleCallback === 'function') {
        try {
          globalThis.requestIdleCallback(() => run(), { timeout: 300 });
          return;
        } catch (_) {
        }
      }

      run();
    }, delay);
  }

  /**
   * @param {string} [reason]
   */
  _runPathfindingPrewarm(reason = '') {
    if (!this.initialized) return;

    const sceneId = String(canvas?.scene?.id || '');
    if (!sceneId) return;

    if (this._pathPrewarmLastSceneId === sceneId && this._pathPrewarmLastRevision === this._doorStateRevision) {
      return;
    }

    const startMs = this._nowMs();
    const doorIndex = this._buildDoorSpatialIndex({ force: true });
    const hpaIndex = this._buildHpaSectorIndex({ force: true });
    if (!doorIndex && !hpaIndex) return;

    // Pre-build the HPA adjacency graph for the most common token size (1×1)
    // so the first pathfinding request doesn't pay the gateway scan cost.
    // Uses a synthetic 1×1 tokenDoc stub since adjacency is keyed by token
    // dimensions and collision mode.
    let hpaAdjacencyEdgeCount = 0;
    const stubTokenDoc = { width: 1, height: 1 };
    if (hpaIndex) {
      const adjacencyResult = this._buildHpaAdjacency({
        tokenDoc: stubTokenDoc,
        options: { allowDiagonal: true, collisionMode: 'closest' },
        index: hpaIndex
      });
      if (adjacencyResult?.adjacency instanceof Map) {
        for (const edges of adjacencyResult.adjacency.values()) {
          hpaAdjacencyEdgeCount += Array.isArray(edges) ? edges.length : 0;
        }
      }
    }

    // Pre-build the full-scene navigation graph for 1×1 tokens so that the
    // first group preview or pathfinding request runs A* directly on the
    // cached adjacency without paying per-call graph generation costs.
    let sceneNavGraphNodeCount = 0;
    let sceneNavGraphEdgeCount = 0;
    let sceneNavGraphBuildMs = 0;
    const navGraph = this._getOrBuildSceneNavGraph(stubTokenDoc, {
      collisionMode: 'closest'
    });
    if (navGraph) {
      sceneNavGraphNodeCount = navGraph.nodes?.size || 0;
      sceneNavGraphEdgeCount = navGraph.edgeCount || 0;
      sceneNavGraphBuildMs = navGraph.buildMs || 0;
    }

    this._pathPrewarmLastSceneId = sceneId;
    this._pathPrewarmLastRevision = this._doorStateRevision;

    this._pathfindingLog('debug', 'pathfinding prewarm complete', {
      reason: String(reason || ''),
      sceneId,
      doorCount: Array.isArray(doorIndex?.doorEntries) ? doorIndex.doorEntries.length : 0,
      bucketCount: doorIndex?.buckets instanceof Map ? doorIndex.buckets.size : 0,
      hpaSectorCount: Array.isArray(hpaIndex?.sectors) ? hpaIndex.sectors.length : 0,
      hpaAdjacencyEdgeCount,
      sceneNavGraphNodeCount,
      sceneNavGraphEdgeCount,
      sceneNavGraphBuildMs: Math.round(sceneNavGraphBuildMs * 10) / 10,
      prewarmMs: this._nowMs() - startMs
    });
  }

  /**
   * Retrieve or build a precomputed full-scene navigation graph for the given
   * token collision size. The graph contains every grid cell center in the
   * scene as a node and every wall-collision-tested edge as adjacency, so
   * `findWeightedPath` can skip `generateMovementGraph` entirely and run A*
   * directly on this cached structure.
   *
   * The graph is keyed by a token size string (e.g. "1x1") and invalidated
   * when `_doorStateRevision` changes (wall/door topology update).
   *
   * @param {TokenDocument|object|null} tokenDoc
   * @param {object} [options]
   * @returns {{sceneId:string, revision:number, sizeKey:string, nodes:Map<string,{x:number,y:number,key:string}>, adjacency:Map<string,Array<{toKey:string,cost:number}>>, edgeCount:number, gridType:number, gridSizeX:number, gridSizeY:number, latticeStep:number, builtAtMs:number, buildMs:number}|null}
   */
  _getOrBuildSceneNavGraph(tokenDoc, options = {}) {
    const sceneId = String(canvas?.scene?.id || '');
    if (!sceneId) return null;

    const w = Math.max(1, Math.round(asNumber(tokenDoc?.width, 1)));
    const h = Math.max(1, Math.round(asNumber(tokenDoc?.height, 1)));
    const sizeKey = `${w}x${h}`;
    const revision = this._doorStateRevision;

    const cached = this._sceneNavGraphCache.get(sizeKey);
    if (cached && cached.sceneId === sceneId && cached.revision === revision) {
      return cached;
    }

    const buildStartMs = this._nowMs();
    const graph = this._buildFullSceneNavGraph(tokenDoc, options);
    if (!graph) return null;
    const buildMs = this._nowMs() - buildStartMs;

    const entry = {
      sceneId,
      revision,
      sizeKey,
      ...graph,
      builtAtMs: this._nowMs(),
      buildMs
    };
    this._sceneNavGraphCache.set(sizeKey, entry);

    this._pathfindingLog('debug', 'scene nav graph built', {
      sizeKey,
      sceneId,
      revision,
      nodeCount: graph.nodes.size,
      edgeCount: graph.edgeCount,
      buildMs: Math.round(buildMs * 10) / 10
    });

    return entry;
  }

  /**
   * Build a complete navigation graph covering every grid cell center in the
   * current scene. For each cell, all 8 neighbor directions (4 cardinal +
   * 4 diagonal) are tested for wall collisions using the same
   * `_validatePathSegmentCollision` path as dynamic graph generation. The
   * resulting adjacency list is identical in shape to what
   * `generateMovementGraph` produces, so A* can run on it directly.
   *
   * @param {TokenDocument|object|null} tokenDoc
   * @param {object} [options]
   * @returns {{nodes:Map<string,{x:number,y:number,key:string}>, adjacency:Map<string,Array<{toKey:string,cost:number}>>, edgeCount:number, gridType:number, gridSizeX:number, gridSizeY:number, latticeStep:number}|null}
   */
  _buildFullSceneNavGraph(tokenDoc, options = {}) {
    const grid = canvas?.grid;
    const dimensions = canvas?.dimensions;
    if (!grid || !dimensions) return null;

    const sceneRect = dimensions?.sceneRect || {
      x: 0,
      y: 0,
      width: asNumber(dimensions?.width, 0),
      height: asNumber(dimensions?.height, 0)
    };
    if (sceneRect.width <= 0 || sceneRect.height <= 0) return null;

    const gridSize = Math.max(1, asNumber(grid?.size, 100));
    const gridSizeX = Math.max(1, asNumber(grid?.sizeX, gridSize));
    const gridSizeY = Math.max(1, asNumber(grid?.sizeY, gridSize));
    const gridType = asNumber(grid?.type, 1);
    const latticeStep = Math.max(8, Math.max(24, gridSize * 0.5));

    const snapContext = { gridType, grid, latticeStep };

    // Build a collision-testing context that covers the full scene.
    const fullContext = {
      tokenDoc,
      options: {
        ignoreWalls: false,
        collisionMode: options?.collisionMode || 'closest',
        allowDiagonal: true,
        ignoreCost: false
      },
      grid,
      gridType,
      gridSize,
      gridSizeX,
      gridSizeY,
      latticeStep,
      bounds: {
        minX: sceneRect.x,
        maxX: sceneRect.x + sceneRect.width,
        minY: sceneRect.y,
        maxY: sceneRect.y + sceneRect.height
      },
      sceneRect,
      doorSegmentCache: new Map(),
      doorSegmentCacheStats: { calls: 0, hits: 0 },
      // Dummy start/end — not used during full-scene build.
      startNode: { x: 0, y: 0, key: '0:0' },
      endNode: { x: 0, y: 0, key: '0:0' }
    };

    // Enumerate all grid cell centers within the scene rect.
    // Iterate at grid-size steps and snap each point to ensure alignment
    // with the traversal grid that _getCandidateNeighbors produces.
    const nodes = new Map();
    const pad = Math.max(gridSizeX, gridSizeY) * 0.5;
    for (let y = sceneRect.y - pad; y <= sceneRect.y + sceneRect.height + pad; y += gridSizeY) {
      for (let x = sceneRect.x - pad; x <= sceneRect.x + sceneRect.width + pad; x += gridSizeX) {
        const snapped = this._snapPointToTraversalGrid({ x, y }, snapContext);
        const key = this._pointKey(snapped.x, snapped.y);
        if (nodes.has(key)) continue;

        // Only include nodes within the scene rect.
        if (snapped.x < sceneRect.x || snapped.x > sceneRect.x + sceneRect.width) continue;
        if (snapped.y < sceneRect.y || snapped.y > sceneRect.y + sceneRect.height) continue;

        nodes.set(key, { x: snapped.x, y: snapped.y, key });
      }
    }

    // Test all edges: for each node, get its candidate neighbors and validate
    // wall collisions + traversal cost — identical to generateMovementGraph.
    const adjacency = new Map();
    let edgeCount = 0;
    for (const [key, node] of nodes) {
      const neighborNodes = this._getCandidateNeighbors(node, fullContext);
      if (!neighborNodes || neighborNodes.length === 0) continue;

      const edges = [];
      for (const neighbor of neighborNodes) {
        if (!nodes.has(neighbor.key)) continue;

        const collision = this._validatePathSegmentCollision(node, neighbor, fullContext);
        if (!collision.ok) continue;

        const cost = this._computeTraversalCost(node, neighbor, fullContext);
        if (!Number.isFinite(cost) || cost <= 0) continue;

        edges.push({ toKey: neighbor.key, cost });
        edgeCount += 1;
      }

      if (edges.length > 0) {
        adjacency.set(key, edges);
      }
    }

    return {
      nodes,
      adjacency,
      edgeCount,
      gridType,
      gridSizeX,
      gridSizeY,
      latticeStep
    };
  }

  /**
   * @param {{force?:boolean, sectorSize?:number}} [options]
   * @returns {{sceneId:string, revision:number, sectorSize:number, cols:number, rows:number, sceneRect:{x:number,y:number,width:number,height:number}, sectors:Array<object>, sectorsById:Map<string, object>, builtAtMs:number}|null}
   */
  _buildHpaSectorIndex({ force = false, sectorSize = NaN } = {}) {
    const sceneId = String(canvas?.scene?.id || '');
    if (!sceneId) return null;

    const dimensions = canvas?.dimensions;
    const sceneRect = dimensions?.sceneRect || {
      x: 0,
      y: 0,
      width: asNumber(dimensions?.width, 0),
      height: asNumber(dimensions?.height, 0)
    };

    const gridSize = Math.max(1, asNumber(canvas?.grid?.size, asNumber(dimensions?.size, 100)));
    const resolvedSectorSize = clamp(
      Math.round(asNumber(sectorSize, asNumber(this.settings?.hpaSectorSizePx, gridSize * 8))),
      Math.max(64, gridSize * 2),
      2048
    );

    const revision = this._doorStateRevision;
    const cached = this._hpaSectorIndex;
    if (
      !force
      && cached
      && cached.sceneId === sceneId
      && cached.revision === revision
      && cached.sectorSize === resolvedSectorSize
    ) {
      return cached;
    }

    const cols = Math.max(1, Math.ceil(asNumber(sceneRect?.width, 0) / resolvedSectorSize));
    const rows = Math.max(1, Math.ceil(asNumber(sceneRect?.height, 0) / resolvedSectorSize));
    const sectors = [];
    const sectorsById = new Map();

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const minX = asNumber(sceneRect?.x, 0) + (col * resolvedSectorSize);
        const minY = asNumber(sceneRect?.y, 0) + (row * resolvedSectorSize);
        const maxX = Math.min(asNumber(sceneRect?.x, 0) + asNumber(sceneRect?.width, 0), minX + resolvedSectorSize);
        const maxY = Math.min(asNumber(sceneRect?.y, 0) + asNumber(sceneRect?.height, 0), minY + resolvedSectorSize);
        const id = `${col}:${row}`;
        const sector = {
          id,
          col,
          row,
          bounds: { minX, minY, maxX, maxY },
          center: {
            x: (minX + maxX) * 0.5,
            y: (minY + maxY) * 0.5
          }
        };
        sectors.push(sector);
        sectorsById.set(id, sector);
      }
    }

    const index = {
      sceneId,
      revision,
      sectorSize: resolvedSectorSize,
      cols,
      rows,
      sceneRect,
      sectors,
      sectorsById,
      builtAtMs: this._nowMs()
    };

    this._hpaSectorIndex = index;
    return index;
  }

  /**
   * @param {{x:number,y:number}} point
   * @param {{sceneRect:{x:number,y:number,width:number,height:number}, sectorSize:number, cols:number, rows:number}} index
   * @returns {string}
   */
  _getHpaSectorIdForPoint(point, index) {
    const x = asNumber(point?.x, 0);
    const y = asNumber(point?.y, 0);
    const sx = asNumber(index?.sceneRect?.x, 0);
    const sy = asNumber(index?.sceneRect?.y, 0);
    const sectorSize = Math.max(1, asNumber(index?.sectorSize, 1));
    const col = clamp(Math.floor((x - sx) / sectorSize), 0, Math.max(0, asNumber(index?.cols, 1) - 1));
    const row = clamp(Math.floor((y - sy) / sectorSize), 0, Math.max(0, asNumber(index?.rows, 1) - 1));
    return `${col}:${row}`;
  }

  /**
   * @param {object} params
   * @param {object} params.a
   * @param {object} params.b
   * @param {TokenDocument|object|null} params.tokenDoc
   * @param {object} params.options
   * @param {number} params.gridSize
   * @returns {{a:{x:number,y:number}, b:{x:number,y:number}, cost:number}|null}
   */
  _buildHpaGatewayBetweenSectors({ a, b, tokenDoc = null, options = {}, gridSize = 100 } = {}) {
    const dx = asNumber(b?.col, 0) - asNumber(a?.col, 0);
    const dy = asNumber(b?.row, 0) - asNumber(a?.row, 0);
    const manhattan = Math.abs(dx) + Math.abs(dy);
    // Support cardinal (manhattan=1) and diagonal (manhattan=2) adjacency.
    if (manhattan < 1 || manhattan > 2) return null;

    const aBounds = a?.bounds;
    const bBounds = b?.bounds;
    if (!aBounds || !bBounds) return null;

    const sampleStep = Math.max(16, Math.round(gridSize * 0.5));
    const samplePad = Math.max(6, Math.round(gridSize * 0.18));

    const collisionCtx = {
      tokenDoc,
      options: {
        ...options,
        ignoreWalls: false,
        collisionMode: options?.collisionMode || 'closest'
      }
    };
    const segmentCheck = (pA, pB) => {
      return !!this._validatePathSegmentCollision(pA, pB, collisionCtx)?.ok;
    };

    const centerCost = Math.hypot(
      asNumber(b?.center?.x, 0) - asNumber(a?.center?.x, 0),
      asNumber(b?.center?.y, 0) - asNumber(a?.center?.y, 0)
    );

    // For diagonal adjacency, test a direct center-to-center crossing at the
    // shared corner point. If passable, create a gateway there.
    if (manhattan === 2) {
      const cornerX = dx > 0 ? asNumber(aBounds?.maxX, 0) : asNumber(aBounds?.minX, 0);
      const cornerY = dy > 0 ? asNumber(aBounds?.maxY, 0) : asNumber(aBounds?.minY, 0);
      const pA = {
        x: cornerX - (dx > 0 ? samplePad : -samplePad),
        y: cornerY - (dy > 0 ? samplePad : -samplePad)
      };
      const pB = {
        x: cornerX + (dx > 0 ? samplePad : -samplePad),
        y: cornerY + (dy > 0 ? samplePad : -samplePad)
      };
      if (segmentCheck(pA, pB)) {
        return { a: pA, b: pB, cost: centerCost };
      }
      return null;
    }

    // Cardinal adjacency — scan all sample points along the shared border and
    // pick the most central passable one (best gateway quality).
    /**
     * @param {number} borderFixed - The fixed coordinate on the border axis
     * @param {number} rangeMin - Start of the shared range on the sweep axis
     * @param {number} rangeMax - End of the shared range on the sweep axis
     * @param {boolean} horizontal - true if border is vertical (dx≠0), sweep is Y
     * @returns {{a:{x:number,y:number}, b:{x:number,y:number}, cost:number}|null}
     */
    const scanBorder = (borderFixed, rangeMin, rangeMax, horizontal) => {
      if (rangeMax <= rangeMin) return null;
      const rangeMid = (rangeMin + rangeMax) * 0.5;

      // Collect all passable sample points along the border.
      /** @type {Array<{coord:number, pA:{x:number,y:number}, pB:{x:number,y:number}}>} */
      const passable = [];
      for (let coord = rangeMin + sampleStep * 0.5; coord < rangeMax; coord += sampleStep) {
        let pA, pB;
        if (horizontal) {
          const sign = dx > 0 ? 1 : -1;
          pA = { x: borderFixed - sign * samplePad, y: coord };
          pB = { x: borderFixed + sign * samplePad, y: coord };
        } else {
          const sign = dy > 0 ? 1 : -1;
          pA = { x: coord, y: borderFixed - sign * samplePad };
          pB = { x: coord, y: borderFixed + sign * samplePad };
        }
        if (segmentCheck(pA, pB)) {
          passable.push({ coord, pA, pB });
        }
      }

      if (passable.length === 0) return null;

      // Pick the sample closest to the midpoint of the shared border — this
      // produces the most useful gateway for routing through sector centers.
      let bestIdx = 0;
      let bestDist = Math.abs(passable[0].coord - rangeMid);
      for (let i = 1; i < passable.length; i++) {
        const dist = Math.abs(passable[i].coord - rangeMid);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }

      return {
        a: passable[bestIdx].pA,
        b: passable[bestIdx].pB,
        cost: centerCost
      };
    };

    if (dx !== 0) {
      const borderX = dx > 0 ? asNumber(aBounds?.maxX, 0) : asNumber(aBounds?.minX, 0);
      const minY = Math.max(asNumber(aBounds?.minY, 0), asNumber(bBounds?.minY, 0));
      const maxY = Math.min(asNumber(aBounds?.maxY, 0), asNumber(bBounds?.maxY, 0));
      return scanBorder(borderX, minY, maxY, true);
    }

    const borderY = dy > 0 ? asNumber(aBounds?.maxY, 0) : asNumber(aBounds?.minY, 0);
    const minX = Math.max(asNumber(aBounds?.minX, 0), asNumber(bBounds?.minX, 0));
    const maxX = Math.min(asNumber(aBounds?.maxX, 0), asNumber(bBounds?.maxX, 0));
    return scanBorder(borderY, minX, maxX, false);
  }

  /**
   * @param {{tokenDoc?:TokenDocument|object|null, options?:object, index?:object}} params
   * @returns {{adjacency:Map<string, Array<object>>, index:object}|null}
   */
  _buildHpaAdjacency({ tokenDoc = null, options = {}, index = null } = {}) {
    const sectorIndex = index || this._buildHpaSectorIndex();
    if (!sectorIndex) return null;

    const widthCells = Math.max(1, Math.round(asNumber(tokenDoc?.width, 1)));
    const heightCells = Math.max(1, Math.round(asNumber(tokenDoc?.height, 1)));
    const cacheKey = [
      sectorIndex.sceneId,
      sectorIndex.revision,
      sectorIndex.sectorSize,
      widthCells,
      heightCells,
      optionsBoolean(options?.allowDiagonal, true) ? 1 : 0,
      String(options?.collisionMode || 'closest')
    ].join('|');

    const cached = this._hpaAdjacencyCache.get(cacheKey);
    if (cached && cached.sceneId === sectorIndex.sceneId && cached.revision === sectorIndex.revision) {
      return { adjacency: cached.adjacency, index: sectorIndex };
    }

    const adjacency = new Map();
    const gridSize = Math.max(1, asNumber(canvas?.grid?.size, asNumber(canvas?.dimensions?.size, 100)));
    // Cardinal + diagonal neighbors for richer sector connectivity.
    // Diagonal edges let HPA route around large wall complexes that block
    // all cardinal crossings between two sectors.
    const neighbors = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1]
    ];

    const addEdge = (fromId, edge) => {
      let list = adjacency.get(fromId);
      if (!list) {
        list = [];
        adjacency.set(fromId, list);
      }
      list.push(edge);
    };

    for (const sector of sectorIndex.sectors) {
      for (const [dx, dy] of neighbors) {
        const nCol = asNumber(sector?.col, 0) + dx;
        const nRow = asNumber(sector?.row, 0) + dy;
        if (nCol < 0 || nRow < 0 || nCol >= sectorIndex.cols || nRow >= sectorIndex.rows) continue;

        const neighborId = `${nCol}:${nRow}`;
        if (String(sector?.id || '') >= neighborId) continue;

        const neighbor = sectorIndex.sectorsById.get(neighborId);
        if (!neighbor) continue;

        const gateway = this._buildHpaGatewayBetweenSectors({
          a: sector,
          b: neighbor,
          tokenDoc,
          options,
          gridSize
        });
        if (!gateway) continue;

        addEdge(sector.id, {
          toId: neighbor.id,
          cost: asNumber(gateway?.cost, gridSize),
          fromGateway: gateway.a,
          toGateway: gateway.b
        });
        addEdge(neighbor.id, {
          toId: sector.id,
          cost: asNumber(gateway?.cost, gridSize),
          fromGateway: gateway.b,
          toGateway: gateway.a
        });
      }
    }

    this._hpaAdjacencyCache.set(cacheKey, {
      sceneId: sectorIndex.sceneId,
      revision: sectorIndex.revision,
      sectorSize: sectorIndex.sectorSize,
      adjacency,
      builtAtMs: this._nowMs()
    });

    return { adjacency, index: sectorIndex };
  }

  /**
   * @param {object} params
   * @param {{x:number,y:number}} params.start
   * @param {{x:number,y:number}} params.end
   * @param {TokenDocument|object|null} [params.tokenDoc]
   * @param {object} [params.options]
   * @param {{cancelled:boolean}|null} [params.cancelToken]
   * @returns {{ok:boolean,pathNodes:Array<{x:number,y:number}>,diagnostics?:object,reason?:string}}
   */
  _findHpaPath({ start, end, tokenDoc = null, options = {}, cancelToken = null } = {}) {
    const setup = this._buildHpaAdjacency({ tokenDoc, options });
    if (!setup) return { ok: false, pathNodes: [], reason: 'hpa-unavailable' };

    const { adjacency, index } = setup;
    const startSectorId = this._getHpaSectorIdForPoint(start, index);
    const endSectorId = this._getHpaSectorIdForPoint(end, index);
    if (!startSectorId || !endSectorId) {
      return { ok: false, pathNodes: [], reason: 'hpa-invalid-sector' };
    }

    if (startSectorId === endSectorId) {
      return { ok: false, pathNodes: [], reason: 'hpa-same-sector' };
    }

    const gScore = new Map([[startSectorId, 0]]);
    const cameFrom = new Map();
    const closedSectors = new Set();
    const getCenter = (id) => index.sectorsById.get(id)?.center || { x: 0, y: 0 };
    const heuristic = (fromId) => {
      const a = getCenter(fromId);
      const b = getCenter(endSectorId);
      return Math.hypot(asNumber(b?.x, 0) - asNumber(a?.x, 0), asNumber(b?.y, 0) - asNumber(a?.y, 0));
    };

    // Use BinaryMinHeap for sector-level A* as well.
    const sectorHeap = new BinaryMinHeap();
    sectorHeap.push(startSectorId, heuristic(startSectorId));

    let safety = 0;
    const maxExpand = Math.max(32, index.sectors.length * 4);
    while (sectorHeap.size > 0 && safety < maxExpand) {
      safety += 1;
      if ((safety & 15) === 0 && this._isPathSearchCancelled(cancelToken, this._pathSearchGeneration, options?.shouldCancel)) {
        return { ok: false, pathNodes: [], reason: 'cancelled' };
      }

      const bestEntry = sectorHeap.pop();
      if (!bestEntry) break;
      const current = bestEntry.key;

      if (closedSectors.has(current)) continue;
      closedSectors.add(current);

      if (current === endSectorId) {
        const sectorPath = [current];
        while (cameFrom.has(sectorPath[0])) {
          sectorPath.unshift(cameFrom.get(sectorPath[0]).fromId);
        }

        const waypoints = [{ x: asNumber(start?.x, 0), y: asNumber(start?.y, 0) }];
        for (let i = 0; i < sectorPath.length - 1; i++) {
          const fromId = sectorPath[i];
          const toId = sectorPath[i + 1];
          const edges = adjacency.get(fromId) || [];
          const edge = edges.find((e) => String(e?.toId || '') === toId);
          if (!edge) continue;
          waypoints.push({ x: asNumber(edge?.fromGateway?.x, 0), y: asNumber(edge?.fromGateway?.y, 0) });
          waypoints.push({ x: asNumber(edge?.toGateway?.x, 0), y: asNumber(edge?.toGateway?.y, 0) });
        }
        waypoints.push({ x: asNumber(end?.x, 0), y: asNumber(end?.y, 0) });

        const refined = [];
        const localMargin = Math.max(
          asNumber(options?.searchMarginPx, 260),
          Math.round(asNumber(index?.sectorSize, 400) * 0.85)
        );
        for (let i = 1; i < waypoints.length; i++) {
          const segment = this.findWeightedPath({
            start: waypoints[i - 1],
            end: waypoints[i],
            tokenDoc,
            options: {
              ...options,
              disableHpa: true,
              suppressNoPathLog: true,
              searchMarginPx: localMargin
            },
            cancelToken
          });
          if (!segment?.ok || !Array.isArray(segment.pathNodes) || segment.pathNodes.length < 2) {
            return {
              ok: false,
              pathNodes: [],
              reason: 'hpa-refine-failed',
              diagnostics: {
                failedSegmentIndex: i,
                sectorCount: sectorPath.length
              }
            };
          }

          if (refined.length === 0) refined.push(...segment.pathNodes);
          else refined.push(...segment.pathNodes.slice(1));
        }

        return {
          ok: refined.length >= 2,
          pathNodes: refined,
          diagnostics: {
            sectorCount: sectorPath.length,
            waypointCount: waypoints.length
          }
        };
      }

      const neighbors = adjacency.get(current) || [];
      const currentG = asNumber(gScore.get(current), Number.POSITIVE_INFINITY);
      for (const edge of neighbors) {
        const toId = String(edge?.toId || '');
        if (!toId || closedSectors.has(toId)) continue;

        const tentative = currentG + Math.max(1, asNumber(edge?.cost, 1));
        if (tentative >= asNumber(gScore.get(toId), Number.POSITIVE_INFINITY)) continue;

        cameFrom.set(toId, { fromId: current, edge });
        gScore.set(toId, tentative);
        sectorHeap.push(toId, tentative + heuristic(toId));
      }
    }

    return { ok: false, pathNodes: [], reason: 'hpa-no-path' };
  }

  /**
   * @param {{force?:boolean}} [options]
   * @returns {{sceneId:string, revision:number, doorEntries:Array<object>, buckets:Map<string, Array<object>>, bucketSize:number, builtAtMs:number}|null}
   */
  _buildDoorSpatialIndex({ force = false } = {}) {
    const sceneId = String(canvas?.scene?.id || '');
    if (!sceneId) return null;

    const revision = this._doorStateRevision;
    const cached = this._doorSpatialIndex;
    if (!force && cached && cached.sceneId === sceneId && cached.revision === revision) {
      return cached;
    }

    const walls = canvas?.walls?.placeables;
    const doorEntries = [];
    const buckets = new Map();
    const bucketSize = Math.max(64, Math.round(asNumber(canvas?.grid?.size, 100) * 2));

    const addToBucket = (ix, iy, entry) => {
      const key = `${ix}:${iy}`;
      let list = buckets.get(key);
      if (!list) {
        list = [];
        buckets.set(key, list);
      }
      list.push(entry);
    };

    if (Array.isArray(walls)) {
      for (const wall of walls) {
        const doc = wall?.document;
        if (!doc) continue;

        const doorType = asNumber(doc.door, DOOR_TYPES.NONE);
        if (doorType <= DOOR_TYPES.NONE) continue;

        const c = doc.c;
        if (!Array.isArray(c) || c.length < 4) continue;

        const minX = Math.min(asNumber(c[0], 0), asNumber(c[2], 0));
        const maxX = Math.max(asNumber(c[0], 0), asNumber(c[2], 0));
        const minY = Math.min(asNumber(c[1], 0), asNumber(c[3], 0));
        const maxY = Math.max(asNumber(c[1], 0), asNumber(c[3], 0));

        const entry = {
          wall,
          doc,
          wallId: String(doc.id || doc._id || ''),
          c: [asNumber(c[0], 0), asNumber(c[1], 0), asNumber(c[2], 0), asNumber(c[3], 0)],
          minX,
          minY,
          maxX,
          maxY
        };
        doorEntries.push(entry);

        const ix0 = Math.floor(minX / bucketSize);
        const iy0 = Math.floor(minY / bucketSize);
        const ix1 = Math.floor(maxX / bucketSize);
        const iy1 = Math.floor(maxY / bucketSize);

        for (let ix = ix0; ix <= ix1; ix++) {
          for (let iy = iy0; iy <= iy1; iy++) {
            addToBucket(ix, iy, entry);
          }
        }
      }
    }

    const index = {
      sceneId,
      revision,
      doorEntries,
      buckets,
      bucketSize,
      builtAtMs: this._nowMs()
    };
    this._doorSpatialIndex = index;
    return index;
  }

  /**
   * @param {{x:number,y:number}} start
   * @param {{x:number,y:number}} end
   * @param {{doorEntries:Array<object>, buckets:Map<string, Array<object>>, bucketSize:number}|null} index
   * @returns {Array<object>}
   */
  _getDoorWallCandidatesForSegment(start, end, index) {
    if (!index || !Array.isArray(index?.doorEntries)) return [];
    if (index.doorEntries.length === 0) return [];

    const bucketSize = Math.max(1, asNumber(index?.bucketSize, 200));
    const sx = asNumber(start?.x, 0);
    const sy = asNumber(start?.y, 0);
    const ex = asNumber(end?.x, 0);
    const ey = asNumber(end?.y, 0);

    const minX = Math.min(sx, ex);
    const minY = Math.min(sy, ey);
    const maxX = Math.max(sx, ex);
    const maxY = Math.max(sy, ey);

    const ix0 = Math.floor(minX / bucketSize);
    const iy0 = Math.floor(minY / bucketSize);
    const ix1 = Math.floor(maxX / bucketSize);
    const iy1 = Math.floor(maxY / bucketSize);

    const cellSpan = (Math.max(0, ix1 - ix0) + 1) * (Math.max(0, iy1 - iy0) + 1);
    if (cellSpan > 400) {
      return index.doorEntries;
    }

    if (!(index.buckets instanceof Map) || index.buckets.size === 0) {
      return index.doorEntries;
    }

    const unique = new Map();
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        const bucket = index.buckets.get(`${ix}:${iy}`);
        if (!Array.isArray(bucket)) continue;
        for (const entry of bucket) {
          const key = String(entry?.wallId || '');
          if (!key || unique.has(key)) continue;
          unique.set(key, entry);
        }
      }
    }

    if (unique.size === 0) {
      return index.doorEntries;
    }
    return [...unique.values()];
  }

  _setupHooks() {
    if (this._hookIds.length > 0) return;

    this._hookIds.push(['updateWall', Hooks.on('updateWall', () => {
      this._markPathfindingTopologyDirty('update-wall');
    })]);

    this._hookIds.push(['createWall', Hooks.on('createWall', () => {
      this._markPathfindingTopologyDirty('create-wall');
    })]);

    this._hookIds.push(['deleteWall', Hooks.on('deleteWall', () => {
      this._markPathfindingTopologyDirty('delete-wall');
    })]);

    this._hookIds.push(['canvasReady', Hooks.on('canvasReady', () => {
      this._doorSpatialIndex = null;
      this._pathPrewarmLastSceneId = '';
      this._pathPrewarmLastRevision = -1;
      this._schedulePathfindingPrewarm('canvas-ready', 260);
    })]);

    this._hookIds.push(['createCombat', Hooks.on('createCombat', () => {
      this._evaluateCombatState();
    })]);

    this._hookIds.push(['updateCombat', Hooks.on('updateCombat', () => {
      this._evaluateCombatState();
    })]);

    this._hookIds.push(['deleteCombat', Hooks.on('deleteCombat', () => {
      this._evaluateCombatState();
    })]);
  }

  _evaluateCombatState() {
    this._inCombat = !!(game?.combat?.started);
  }

  _registerDefaultStyles() {
    const walkStyles = [
      ['walk', 'Walk - Steady March'],
      ['walk-heavy-stomp', 'Walk - Heavy Stomp'],
      ['walk-sneak-glide', 'Walk - Sneak Glide'],
      ['walk-swagger-stride', 'Walk - Swagger Stride'],
      ['walk-skitter-step', 'Walk - Skitter Step'],
      ['walk-limping-advance', 'Walk - Limping Advance'],
      ['walk-wobble-totter', 'Walk - Wobble Totter'],
      ['walk-drunken-drift', 'Walk - Drunken Drift'],
      ['walk-clockwork-tick', 'Walk - Clockwork Tick-Walk'],
      ['walk-chaos-skip', 'Walk - Chaos Skip']
    ];
    for (const [id, label] of walkStyles) {
      this.styles.set(id, {
        id,
        label,
        mode: 'custom'
      });
    }

    this.styles.set('pick-up-drop', {
      id: 'pick-up-drop',
      label: 'Pick Up and Drop',
      mode: 'custom'
    });

    const flyingStyles = [
      ['flying-glide', 'Flying - Glide'],
      ['flying-hover-bob', 'Flying - Hover Bob'],
      ['flying-bank-swoop', 'Flying - Bank Swoop'],
      ['flying-flutter-dart', 'Flying - Flutter Dart'],
      ['flying-chaos-drift', 'Flying - Chaos Drift']
    ];
    for (const [id, label] of flyingStyles) {
      this.styles.set(id, {
        id,
        label,
        mode: 'custom'
      });
    }
  }

  /**
   * @param {string} styleId
   * @returns {boolean}
   */
  _isWalkStyle(styleId) {
    return WALK_STYLE_IDS.has(styleId);
  }

  /**
   * @param {string} styleId
   * @returns {boolean}
   */
  _isFlyingStyle(styleId) {
    return FLYING_STYLE_IDS.has(styleId);
  }

  /**
   * @param {string} styleId
   * @param {{id: string, label: string, mode?: string}} styleDef
   */
  registerStyle(styleId, styleDef) {
    if (!styleId || !styleDef || typeof styleDef !== 'object') return;
    this.styles.set(styleId, {
      id: styleDef.id || styleId,
      label: styleDef.label || styleId,
      mode: styleDef.mode || 'custom'
    });
  }

  /**
   * @param {string} styleId
   */
  setDefaultStyle(styleId) {
    if (!this.styles.has(styleId)) return;
    this.settings.defaultStyle = styleId;
  }

  /**
   * @param {string} tokenId
   * @param {string|null} styleId
   */
  setTokenStyleOverride(tokenId, styleId) {
    if (!tokenId) return;
    if (!styleId) {
      this.tokenStyleOverrides.delete(tokenId);
      return;
    }
    if (!this.styles.has(styleId)) return;
    this.tokenStyleOverrides.set(tokenId, styleId);
  }

  /**
   * @param {TokenDocument} tokenDoc
   * @param {object} [options]
   * @returns {string}
   */
  getStyleForToken(tokenDoc, options = {}) {
    const explicit = options?.mapShineMovementStyle;
    if (explicit && this.styles.has(explicit)) return explicit;

    const tokenId = tokenDoc?.id;
    if (tokenId && this.tokenStyleOverrides.has(tokenId)) {
      return this.tokenStyleOverrides.get(tokenId);
    }

    try {
      const flagged = tokenDoc?.getFlag?.(MODULE_ID, 'movementStyle');
      if (flagged && this.styles.has(flagged)) return flagged;
    } catch (_) {
    }

    const fallback = this.settings.defaultStyle;
    return this.styles.has(fallback) ? fallback : DEFAULT_STYLE;
  }

  /**
   * Called by TokenManager when an authoritative token transform update arrives.
   *
   * @param {object} payload
   * @param {THREE.Sprite} payload.sprite
   * @param {TokenDocument} payload.tokenDoc
   * @param {object} payload.targetDoc
   * @param {object} [payload.changes]
   * @param {object} [payload.options]
   * @param {boolean} [payload.animate]
   * @param {() => void} payload.fallback
   * @returns {boolean} true if handled (including delegated fallback), false if caller should fallback itself
   */
  handleTokenSpriteUpdate(payload) {
    const {
      sprite,
      tokenDoc,
      targetDoc,
      options = {},
      animate = true,
      fallback
    } = payload || {};

    if (!sprite || !tokenDoc || !targetDoc || typeof fallback !== 'function') return false;

    const styleId = this.getStyleForToken(tokenDoc, options);
    const tokenId = tokenDoc.id;
    let existingTrack = this.activeTracks.get(tokenId);
    const shouldAnimate = animate || optionsBoolean(options?.mapShineMovement?.animated, false);

    // If movement style changed, clear stale track state before applying the
    // next behavior so two animation systems never fight over the same sprite.
    if (existingTrack && existingTrack.styleId !== styleId) {
      this._cancelTrack(existingTrack);
      this.activeTracks.delete(tokenId);
      existingTrack = null;
    }

    // If style changed away from flying, clear any lingering hover state.
    if (!this._isFlyingStyle(styleId) && this.isFlying(tokenId)) {
      this.clearFlyingState(tokenId);
    }

    // Unknown styles keep existing fallback animation behavior for compatibility.
    if (!this._isWalkStyle(styleId) && styleId !== 'pick-up-drop' && !this._isFlyingStyle(styleId)) {
      if (existingTrack) {
        this._cancelTrack(existingTrack);
        this.activeTracks.delete(tokenId);
      }
      fallback();
      return true;
    }

    if (!shouldAnimate) {
      if (existingTrack) {
        this._cancelTrack(existingTrack);
        this.activeTracks.delete(tokenId);
      }

      if (this._isFlyingStyle(styleId)) {
        const target = this._computeTargetTransform(targetDoc);
        if (!target) {
          fallback();
          return true;
        }

        const hoverHeight = asNumber(options?.mapShineHoverHeight, target.gridSize * 0.35);
        const rockAmplitudeDeg = asNumber(options?.mapShineRockAmplitudeDeg, 3);
        const rockSpeedHz = asNumber(options?.mapShineRockSpeedHz, 0.4);

        if (!this.isFlying(tokenId)) {
          this.setFlyingState(tokenId, { hoverHeight, rockAmplitudeDeg, rockSpeedHz });
        }

        const state = this.flyingTokens.get(tokenId);
        if (state) {
          state.hoverHeight = hoverHeight;
          state.baseZ = target.z;
          state.baseRotation = target.rotation;
        }

        sprite.position.set(target.x, target.y, target.z + hoverHeight);
        sprite.scale.set(target.scaleX, target.scaleY, 1);
        if (sprite.material && !state) sprite.material.rotation = target.rotation;
        if (sprite.matrixAutoUpdate === false) sprite.updateMatrix();
        return true;
      }

      if (this._isWalkStyle(styleId) || styleId === 'pick-up-drop') {
        const target = this._computeTargetTransform(targetDoc);
        if (!target) {
          fallback();
          return true;
        }
        sprite.position.set(target.x, target.y, target.z);
        sprite.scale.set(target.scaleX, target.scaleY, 1);
        if (sprite.material) sprite.material.rotation = target.rotation;
        if (sprite.matrixAutoUpdate === false) sprite.updateMatrix();
        return true;
      }

      fallback();
      return true;
    }

    const target = this._computeTargetTransform(targetDoc);
    if (!target) {
      fallback();
      return true;
    }

    // Keep scale updates immediate to avoid one-frame stretching artifacts.
    sprite.scale.set(target.scaleX, target.scaleY, 1);
    if (sprite.matrixAutoUpdate === false) sprite.updateMatrix();

    if (this._isFlyingStyle(styleId)) {
      this._startFlyingGlideTrack({
        tokenId,
        sprite,
        target,
        styleId,
        options
      });
      return true;
    }

    if (this._isWalkStyle(styleId)) {
      this._startWalkTrack({
        tokenId,
        sprite,
        target,
        styleId,
        options
      });
      return true;
    }

    const dx = target.x - sprite.position.x;
    const dy = target.y - sprite.position.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) {
      fallback();
      return true;
    }

    this._startPickUpDropTrack({
      tokenId,
      sprite,
      target,
      options
    });

    return true;
  }

  /**
   * @param {object} input
   * @param {string} input.tokenId
   * @param {THREE.Sprite} input.sprite
   * @param {{x:number,y:number,z:number,scaleX:number,scaleY:number,rotation:number,gridSize:number}} input.target
   * @param {object} [input.options]
   */
  _startPickUpDropTrack({ tokenId, sprite, target, options = {} }) {
    if (!tokenId || !sprite || !target) return;

    const existing = this.activeTracks.get(tokenId);
    if (existing) this._cancelTrack(existing);

    const startX = asNumber(sprite.position.x, target.x);
    const startY = asNumber(sprite.position.y, target.y);
    const startZ = asNumber(sprite.position.z, target.z);
    const startRotation = asNumber(sprite.material?.rotation, target.rotation);

    const distance = Math.hypot(target.x - startX, target.y - startY);
    const gridSize = Math.max(1, asNumber(target.gridSize, 100));

    const durationMs = clamp(
      asNumber(options?.mapShineDurationMs, (distance / gridSize) * 300 + 260),
      250,
      2200
    );

    const arcHeight = clamp(
      asNumber(options?.mapShineArcHeight, Math.max(gridSize * 0.45, distance * 0.22)),
      8,
      gridSize * 4
    );

    try {
      this.tokenManager?.emitTokenMovementStart?.(tokenId);
    } catch (_) {
    }

    try {
      const rl = window.MapShine?.renderLoop;
      if (rl?.requestContinuousRender) rl.requestContinuousRender(durationMs + 80);
      else rl?.requestRender?.();
    } catch (_) {
    }

    this.activeTracks.set(tokenId, {
      tokenId,
      styleId: 'pick-up-drop',
      sprite,
      startX,
      startY,
      startZ,
      startRotation,
      target,
      durationSec: durationMs / 1000,
      elapsedSec: 0,
      arcHeight
    });
  }

  /**
   * @param {object} input
   * @param {string} input.tokenId
   * @param {THREE.Sprite} input.sprite
   * @param {{x:number,y:number,z:number,scaleX:number,scaleY:number,rotation:number,gridSize:number}} input.target
   * @param {object} [input.options]
   */
  _startWalkTrack({ tokenId, sprite, target, styleId = 'walk', options = {} }) {
    if (!tokenId || !sprite || !target) return;

    const existing = this.activeTracks.get(tokenId);
    if (existing) this._cancelTrack(existing);

    const startX = asNumber(sprite.position.x, target.x);
    const startY = asNumber(sprite.position.y, target.y);
    const startZ = asNumber(sprite.position.z, target.z);
    const startRotation = asNumber(sprite.material?.rotation, target.rotation);

    const distance = Math.hypot(target.x - startX, target.y - startY);
    const gridSize = Math.max(1, asNumber(target.gridSize, 100));

    const requestedStyleId = String(
      styleId
      || options?.mapShineWalkStyle
      || options?.mapShineMovementStyle
      || options?.styleId
      || ''
    );
    const walkStyleId = this._isWalkStyle(requestedStyleId)
      ? requestedStyleId
      : (this._isWalkStyle(options?.styleId) ? options.styleId : 'walk');

    const profile = this._getWalkStyleProfile(walkStyleId, distance, gridSize);

    const durationMs = clamp(
      asNumber(options?.mapShineWalkDurationMs, profile.durationMs),
      120,
      1800
    );
    const bobAmplitude = clamp(
      asNumber(options?.mapShineWalkBobAmplitude, profile.bobAmplitude),
      0,
      12
    );
    const bobCycles = clamp(
      asNumber(options?.mapShineWalkBobCycles, profile.bobCycles),
      0,
      14
    );
    const lateralAmplitude = clamp(
      asNumber(options?.mapShineWalkLateralAmplitude, profile.lateralAmplitude),
      0,
      Math.max(2, gridSize * 0.2)
    );
    const lateralCycles = clamp(
      asNumber(options?.mapShineWalkLateralCycles, profile.lateralCycles),
      0,
      12
    );
    const settleAmplitude = clamp(
      asNumber(options?.mapShineWalkSettleAmplitude, profile.settleAmplitude),
      0,
      Math.max(3, gridSize * 0.25)
    );
    const strideAmplitude = clamp(
      asNumber(options?.mapShineWalkStrideAmplitude, profile.strideAmplitude),
      0,
      Math.max(8, gridSize * 0.35)
    );
    const rotationSwayFactor = clamp(
      asNumber(options?.mapShineWalkRotationSway, profile.rotationSwayFactor),
      0,
      2
    );
    const chipTiltStrength = clamp(
      asNumber(options?.mapShineWalkChipTilt, profile.chipTiltStrength),
      0,
      2
    );
    const chaosAmplitude = clamp(
      asNumber(options?.mapShineWalkChaosAmplitude, profile.chaosAmplitude),
      0,
      Math.max(10, gridSize * 0.45)
    );
    const chaosCycles = clamp(
      asNumber(options?.mapShineWalkChaosCycles, profile.chaosCycles),
      0,
      16
    );
    const routeBendFactor = clamp(
      asNumber(options?.mapShineWalkRouteBendFactor, profile.routeBendFactor),
      0,
      1
    );

    const randomness = clamp(
      asNumber(options?.mapShineWalkRandomness, profile.randomness),
      0,
      1
    );
    const seedRoot = `${tokenId}|${walkStyleId}|${Math.round(startX)}|${Math.round(startY)}|${Math.round(target.x)}|${Math.round(target.y)}`;
    const bobRandom = ((hashStringToUnit(`${seedRoot}|bob`) * 2) - 1) * randomness;
    const lateralRandom = ((hashStringToUnit(`${seedRoot}|lat`) * 2) - 1) * randomness;
    const strideRandom = ((hashStringToUnit(`${seedRoot}|stride`) * 2) - 1) * randomness;
    const chaosPhase = hashStringToUnit(`${seedRoot}|chaos-phase`) * Math.PI * 2;
    const routeBendSeed = ((hashStringToUnit(`${seedRoot}|route-bend`) * 2) - 1);
    const routeBendPhase = hashStringToUnit(`${seedRoot}|route-bend-phase`) * Math.PI * 2;

    const maxRouteBend = Math.min(
      Math.max(2, gridSize * 0.14),
      Math.max(2.5, distance * 0.28)
    );
    const routeBendAmplitude = routeBendSeed * maxRouteBend * routeBendFactor;

    const randomizedBobAmplitude = Math.max(0, bobAmplitude * (1 + (bobRandom * profile.randomBobJitter)));
    const randomizedLateralAmplitude = Math.max(0, lateralAmplitude * (1 + (lateralRandom * profile.randomLateralJitter)));
    const randomizedStrideAmplitude = Math.max(0, strideAmplitude * (1 + (strideRandom * profile.randomStrideJitter)));

    try {
      this.tokenManager?.emitTokenMovementStart?.(tokenId);
    } catch (_) {
    }

    try {
      const rl = window.MapShine?.renderLoop;
      if (rl?.requestContinuousRender) rl.requestContinuousRender(durationMs + 80);
      else rl?.requestRender?.();
    } catch (_) {
    }

    this.activeTracks.set(tokenId, {
      tokenId,
      styleId: walkStyleId,
      sprite,
      startX,
      startY,
      startZ,
      startRotation,
      target,
      durationSec: durationMs / 1000,
      elapsedSec: 0,
      bobAmplitude: randomizedBobAmplitude,
      bobCycles,
      lateralAmplitude: randomizedLateralAmplitude,
      lateralCycles,
      settleAmplitude,
      strideAmplitude: randomizedStrideAmplitude,
      rotationSwayFactor,
      chipTiltStrength,
      chaosAmplitude,
      chaosCycles,
      chaosPhase,
      routeBendAmplitude,
      routeBendPhase
    });
  }

  /**
   * @param {string} styleId
   * @param {number} distance
   * @param {number} gridSize
   * @returns {{durationMs:number,bobAmplitude:number,bobCycles:number,lateralAmplitude:number,lateralCycles:number,settleAmplitude:number,strideAmplitude:number,rotationSwayFactor:number,chipTiltStrength:number,chaosAmplitude:number,chaosCycles:number,routeBendFactor:number,randomness:number,randomBobJitter:number,randomLateralJitter:number,randomStrideJitter:number}}
   */
  _getWalkStyleProfile(styleId, distance, gridSize) {
    const cells = distance / Math.max(1, gridSize);

    if (styleId === 'walk-heavy-stomp') {
      return {
        durationMs: (cells * 430) + 220,
        bobAmplitude: Math.max(1.2, gridSize * 0.026),
        bobCycles: Math.max(0.8, cells * 0.85),
        lateralAmplitude: Math.max(2.2, gridSize * 0.06),
        lateralCycles: Math.max(0.6, cells * 0.75),
        settleAmplitude: Math.max(1.4, gridSize * 0.03),
        strideAmplitude: Math.max(0.9, gridSize * 0.022),
        rotationSwayFactor: 0.78,
        chipTiltStrength: 0.55,
        chaosAmplitude: Math.max(0.2, gridSize * 0.006),
        chaosCycles: Math.max(0.5, cells * 0.5),
        routeBendFactor: 0.2,
        randomness: 0.22,
        randomBobJitter: 0.22,
        randomLateralJitter: 0.25,
        randomStrideJitter: 0.22
      };
    }

    if (styleId === 'walk-sneak-glide') {
      return {
        durationMs: (cells * 320) + 170,
        bobAmplitude: Math.max(0.12, gridSize * 0.003),
        bobCycles: Math.max(0.5, cells * 0.55),
        lateralAmplitude: Math.max(0.3, gridSize * 0.01),
        lateralCycles: Math.max(0.5, cells * 0.42),
        settleAmplitude: Math.max(0.06, gridSize * 0.0015),
        strideAmplitude: Math.max(0.08, gridSize * 0.002),
        rotationSwayFactor: 0.12,
        chipTiltStrength: 0.2,
        chaosAmplitude: Math.max(0.06, gridSize * 0.0015),
        chaosCycles: Math.max(0.35, cells * 0.35),
        routeBendFactor: 0.08,
        randomness: 0.15,
        randomBobJitter: 0.14,
        randomLateralJitter: 0.15,
        randomStrideJitter: 0.14
      };
    }

    if (styleId === 'walk-swagger-stride') {
      return {
        durationMs: (cells * 300) + 145,
        bobAmplitude: Math.max(0.62, gridSize * 0.013),
        bobCycles: Math.max(0.95, cells * 0.95),
        lateralAmplitude: Math.max(2.8, gridSize * 0.076),
        lateralCycles: Math.max(0.85, cells * 0.9),
        settleAmplitude: Math.max(0.35, gridSize * 0.01),
        strideAmplitude: Math.max(0.48, gridSize * 0.012),
        rotationSwayFactor: 1.05,
        chipTiltStrength: 0.82,
        chaosAmplitude: Math.max(0.16, gridSize * 0.004),
        chaosCycles: Math.max(0.55, cells * 0.55),
        routeBendFactor: 0.3,
        randomness: 0.28,
        randomBobJitter: 0.24,
        randomLateralJitter: 0.35,
        randomStrideJitter: 0.28
      };
    }

    if (styleId === 'walk-skitter-step') {
      return {
        durationMs: (cells * 245) + 115,
        bobAmplitude: Math.max(0.32, gridSize * 0.008),
        bobCycles: Math.max(1.8, cells * 2.3),
        lateralAmplitude: Math.max(1.9, gridSize * 0.05),
        lateralCycles: Math.max(1.7, cells * 1.8),
        settleAmplitude: Math.max(0.18, gridSize * 0.004),
        strideAmplitude: Math.max(0.26, gridSize * 0.007),
        rotationSwayFactor: 0.5,
        chipTiltStrength: 0.38,
        chaosAmplitude: Math.max(0.4, gridSize * 0.011),
        chaosCycles: Math.max(2.2, cells * 2.4),
        routeBendFactor: 0.42,
        randomness: 0.55,
        randomBobJitter: 0.42,
        randomLateralJitter: 0.5,
        randomStrideJitter: 0.38
      };
    }

    if (styleId === 'walk-limping-advance') {
      return {
        durationMs: (cells * 395) + 220,
        bobAmplitude: Math.max(0.92, gridSize * 0.02),
        bobCycles: Math.max(0.65, cells * 0.72),
        lateralAmplitude: Math.max(1.25, gridSize * 0.034),
        lateralCycles: Math.max(0.5, cells * 0.58),
        settleAmplitude: Math.max(1.1, gridSize * 0.028),
        strideAmplitude: Math.max(0.62, gridSize * 0.015),
        rotationSwayFactor: 0.42,
        chipTiltStrength: 0.6,
        chaosAmplitude: Math.max(0.26, gridSize * 0.007),
        chaosCycles: Math.max(0.7, cells * 0.7),
        routeBendFactor: 0.26,
        randomness: 0.34,
        randomBobJitter: 0.35,
        randomLateralJitter: 0.3,
        randomStrideJitter: 0.5
      };
    }

    if (styleId === 'walk-wobble-totter') {
      return {
        durationMs: (cells * 325) + 180,
        bobAmplitude: Math.max(0.85, gridSize * 0.018),
        bobCycles: Math.max(1, cells * 1.05),
        lateralAmplitude: Math.max(2.5, gridSize * 0.068),
        lateralCycles: Math.max(1.1, cells * 1.15),
        settleAmplitude: Math.max(0.7, gridSize * 0.017),
        strideAmplitude: Math.max(0.44, gridSize * 0.011),
        rotationSwayFactor: 1.25,
        chipTiltStrength: 0.94,
        chaosAmplitude: Math.max(0.34, gridSize * 0.009),
        chaosCycles: Math.max(1.15, cells * 1.2),
        routeBendFactor: 0.38,
        randomness: 0.46,
        randomBobJitter: 0.32,
        randomLateralJitter: 0.48,
        randomStrideJitter: 0.28
      };
    }

    if (styleId === 'walk-drunken-drift') {
      return {
        durationMs: (cells * 335) + 175,
        bobAmplitude: Math.max(0.56, gridSize * 0.012),
        bobCycles: Math.max(0.8, cells * 0.86),
        lateralAmplitude: Math.max(3.2, gridSize * 0.086),
        lateralCycles: Math.max(0.8, cells * 0.82),
        settleAmplitude: Math.max(0.48, gridSize * 0.013),
        strideAmplitude: Math.max(0.4, gridSize * 0.01),
        rotationSwayFactor: 1.32,
        chipTiltStrength: 1.05,
        chaosAmplitude: Math.max(0.75, gridSize * 0.019),
        chaosCycles: Math.max(1.2, cells * 1.3),
        routeBendFactor: 0.52,
        randomness: 0.62,
        randomBobJitter: 0.36,
        randomLateralJitter: 0.62,
        randomStrideJitter: 0.3
      };
    }

    if (styleId === 'walk-clockwork-tick') {
      return {
        durationMs: (cells * 360) + 155,
        bobAmplitude: Math.max(0.42, gridSize * 0.009),
        bobCycles: Math.max(1.1, cells * 1.1),
        lateralAmplitude: Math.max(0.7, gridSize * 0.019),
        lateralCycles: Math.max(0.95, cells),
        settleAmplitude: Math.max(0.22, gridSize * 0.006),
        strideAmplitude: Math.max(0.32, gridSize * 0.008),
        rotationSwayFactor: 0.2,
        chipTiltStrength: 0.26,
        chaosAmplitude: Math.max(0.05, gridSize * 0.0015),
        chaosCycles: Math.max(2.2, cells * 2.3),
        routeBendFactor: 0.06,
        randomness: 0.08,
        randomBobJitter: 0.08,
        randomLateralJitter: 0.08,
        randomStrideJitter: 0.08
      };
    }

    if (styleId === 'walk-chaos-skip') {
      return {
        durationMs: (cells * 260) + 130,
        bobAmplitude: Math.max(0.78, gridSize * 0.018),
        bobCycles: Math.max(1.7, cells * 1.95),
        lateralAmplitude: Math.max(3.7, gridSize * 0.1),
        lateralCycles: Math.max(1.7, cells * 1.9),
        settleAmplitude: Math.max(0.85, gridSize * 0.022),
        strideAmplitude: Math.max(0.75, gridSize * 0.019),
        rotationSwayFactor: 1.7,
        chipTiltStrength: 1.12,
        chaosAmplitude: Math.max(1.3, gridSize * 0.034),
        chaosCycles: Math.max(2.8, cells * 3),
        routeBendFactor: 0.68,
        randomness: 0.88,
        randomBobJitter: 0.62,
        randomLateralJitter: 0.85,
        randomStrideJitter: 0.58
      };
    }

    return {
      durationMs: (cells * 290) + 130,
      bobAmplitude: Math.max(0.5, gridSize * 0.01),
      bobCycles: Math.max(1, cells),
      lateralAmplitude: Math.max(1.0, gridSize * 0.028),
      lateralCycles: Math.max(0.75, cells * 0.95),
      settleAmplitude: Math.max(0.35, gridSize * 0.009),
      strideAmplitude: Math.max(0.32, gridSize * 0.008),
      rotationSwayFactor: 0.34,
      chipTiltStrength: 0.35,
      chaosAmplitude: Math.max(0.12, gridSize * 0.003),
      chaosCycles: Math.max(0.6, cells * 0.7),
      routeBendFactor: 0.2,
      randomness: 0.2,
      randomBobJitter: 0.18,
      randomLateralJitter: 0.22,
      randomStrideJitter: 0.18
    };
  }

  /**
   * @param {string} styleId
   * @param {number} tNorm
   * @returns {number}
   */
  _resolveWalkEasedProgress(styleId, tNorm) {
    const t = clamp(tNorm, 0, 1);

    if (styleId === 'walk-heavy-stomp') {
      // Heavy stomp starts with force and slows into a planted finish.
      return 1 - Math.pow(1 - t, 1.95);
    }

    if (styleId === 'walk-sneak-glide') {
      // Sneak glide keeps a gentler, near-constant progress.
      return 0.5 - (0.5 * Math.cos(Math.PI * t));
    }

    if (styleId === 'walk-skitter-step' || styleId === 'walk-chaos-skip') {
      return Math.pow(t, 0.72);
    }

    if (styleId === 'walk-clockwork-tick') {
      // Quantize progress into coarse ticks while preserving full completion.
      const steps = 8;
      return Math.floor(t * steps) / steps;
    }

    if (styleId === 'walk-limping-advance') {
      // Bias toward uneven cadence so one "step" visibly lingers.
      const limpPhase = Math.sin(t * Math.PI * 2);
      return clamp(t + (limpPhase * 0.05 * (1 - t)), 0, 1);
    }

    return (t * t) * (3 - (2 * t));
  }

  /**
   * @param {string} styleId
   * @param {number} distance
   * @param {number} gridSize
   * @returns {{durationMs:number,hoverHeight:number,rockAmplitudeDeg:number,rockSpeedHz:number,bobAmplitude:number,bobCycles:number,lateralAmplitude:number,lateralCycles:number,bankFactor:number,routeBendFactor:number,chaosAmplitude:number,chaosCycles:number,scaleTiltStrength:number,randomness:number}}
   */
  _getFlyingStyleProfile(styleId, distance, gridSize) {
    const cells = distance / Math.max(1, gridSize);

    if (styleId === 'flying-hover-bob') {
      return {
        durationMs: (cells * 280) + 260,
        hoverHeight: Math.max(12, gridSize * 0.34),
        rockAmplitudeDeg: 2.8,
        rockSpeedHz: 0.5,
        bobAmplitude: Math.max(0.7, gridSize * 0.018),
        bobCycles: Math.max(1.2, cells * 1.1),
        lateralAmplitude: Math.max(1.2, gridSize * 0.03),
        lateralCycles: Math.max(0.9, cells * 0.95),
        bankFactor: 0.38,
        routeBendFactor: 0.22,
        chaosAmplitude: Math.max(0.3, gridSize * 0.008),
        chaosCycles: Math.max(0.9, cells * 0.9),
        scaleTiltStrength: 0.28,
        randomness: 0.22
      };
    }

    if (styleId === 'flying-bank-swoop') {
      return {
        durationMs: (cells * 230) + 190,
        hoverHeight: Math.max(14, gridSize * 0.4),
        rockAmplitudeDeg: 1.8,
        rockSpeedHz: 0.32,
        bobAmplitude: Math.max(0.4, gridSize * 0.011),
        bobCycles: Math.max(0.9, cells * 0.85),
        lateralAmplitude: Math.max(3.1, gridSize * 0.08),
        lateralCycles: Math.max(1, cells * 1.15),
        bankFactor: 1.1,
        routeBendFactor: 0.62,
        chaosAmplitude: Math.max(0.36, gridSize * 0.01),
        chaosCycles: Math.max(1.1, cells * 1.1),
        scaleTiltStrength: 0.62,
        randomness: 0.3
      };
    }

    if (styleId === 'flying-flutter-dart') {
      return {
        durationMs: (cells * 200) + 150,
        hoverHeight: Math.max(10, gridSize * 0.32),
        rockAmplitudeDeg: 2.2,
        rockSpeedHz: 0.72,
        bobAmplitude: Math.max(1.1, gridSize * 0.028),
        bobCycles: Math.max(2.8, cells * 3.2),
        lateralAmplitude: Math.max(1.8, gridSize * 0.046),
        lateralCycles: Math.max(2.4, cells * 2.6),
        bankFactor: 0.72,
        routeBendFactor: 0.35,
        chaosAmplitude: Math.max(0.75, gridSize * 0.02),
        chaosCycles: Math.max(2.5, cells * 2.9),
        scaleTiltStrength: 0.46,
        randomness: 0.55
      };
    }

    if (styleId === 'flying-chaos-drift') {
      return {
        durationMs: (cells * 250) + 170,
        hoverHeight: Math.max(16, gridSize * 0.44),
        rockAmplitudeDeg: 4.2,
        rockSpeedHz: 0.62,
        bobAmplitude: Math.max(1.4, gridSize * 0.034),
        bobCycles: Math.max(2.2, cells * 2.4),
        lateralAmplitude: Math.max(4.1, gridSize * 0.108),
        lateralCycles: Math.max(2, cells * 2.25),
        bankFactor: 1.5,
        routeBendFactor: 0.8,
        chaosAmplitude: Math.max(1.6, gridSize * 0.04),
        chaosCycles: Math.max(3, cells * 3.25),
        scaleTiltStrength: 0.86,
        randomness: 0.88
      };
    }

    return {
      durationMs: (cells * 250) + 220,
      hoverHeight: Math.max(12, gridSize * 0.35),
      rockAmplitudeDeg: 3,
      rockSpeedHz: 0.4,
      bobAmplitude: Math.max(0.5, gridSize * 0.014),
      bobCycles: Math.max(1, cells * 0.95),
      lateralAmplitude: Math.max(1.4, gridSize * 0.036),
      lateralCycles: Math.max(0.95, cells),
      bankFactor: 0.5,
      routeBendFactor: 0.28,
      chaosAmplitude: Math.max(0.45, gridSize * 0.012),
      chaosCycles: Math.max(1.1, cells * 1.1),
      scaleTiltStrength: 0.34,
      randomness: 0.24
    };
  }

  /**
   * @param {string} styleId
   * @param {number} tNorm
   * @returns {number}
   */
  _resolveFlyingEasedProgress(styleId, tNorm) {
    const t = clamp(tNorm, 0, 1);

    if (styleId === 'flying-bank-swoop') {
      return 1 - Math.pow(1 - t, 1.72);
    }

    if (styleId === 'flying-flutter-dart') {
      return clamp(t + (Math.sin(t * Math.PI * 6) * 0.018 * (1 - t)), 0, 1);
    }

    if (styleId === 'flying-chaos-drift') {
      return clamp(t + (Math.sin((t * Math.PI * 2.2) + Math.PI * 0.15) * 0.04 * (1 - t)), 0, 1);
    }

    if (styleId === 'flying-hover-bob') {
      return 0.5 - (0.5 * Math.cos(Math.PI * t));
    }

    return (t * t) * (3 - (2 * t));
  }

  /**
   * @param {object} input
   * @param {string} input.tokenId
   * @param {THREE.Sprite} input.sprite
   * @param {{x:number,y:number,z:number,scaleX:number,scaleY:number,rotation:number,gridSize:number}} input.target
   * @param {object} [input.options]
   */
  _startFlyingGlideTrack({ tokenId, sprite, target, styleId = 'flying-glide', options = {} }) {
    if (!tokenId || !sprite || !target) return;

    const existing = this.activeTracks.get(tokenId);
    if (existing) this._cancelTrack(existing);

    const flyingStyleId = this._isFlyingStyle(styleId) ? styleId : 'flying-glide';
    const distance = Math.hypot(target.x - asNumber(sprite.position.x, target.x), target.y - asNumber(sprite.position.y, target.y));
    const gridSize = Math.max(1, asNumber(target.gridSize, 100));
    const profile = this._getFlyingStyleProfile(flyingStyleId, distance, gridSize);

    const hoverHeight = asNumber(options?.mapShineHoverHeight, profile.hoverHeight);
    const rockAmplitudeDeg = asNumber(options?.mapShineRockAmplitudeDeg, profile.rockAmplitudeDeg);
    const rockSpeedHz = asNumber(options?.mapShineRockSpeedHz, profile.rockSpeedHz);
    const bobAmplitude = clamp(
      asNumber(options?.mapShineFlyingBobAmplitude, profile.bobAmplitude),
      0,
      Math.max(5, gridSize * 0.2)
    );
    const bobCycles = clamp(
      asNumber(options?.mapShineFlyingBobCycles, profile.bobCycles),
      0,
      12
    );
    const lateralAmplitude = clamp(
      asNumber(options?.mapShineFlyingLateralAmplitude, profile.lateralAmplitude),
      0,
      Math.max(8, gridSize * 0.22)
    );
    const lateralCycles = clamp(
      asNumber(options?.mapShineFlyingLateralCycles, profile.lateralCycles),
      0,
      10
    );
    const bankFactor = clamp(
      asNumber(options?.mapShineFlyingBankFactor, profile.bankFactor),
      0,
      2
    );
    const routeBendFactor = clamp(
      asNumber(options?.mapShineFlyingRouteBendFactor, profile.routeBendFactor),
      0,
      1
    );
    const chaosAmplitude = clamp(
      asNumber(options?.mapShineFlyingChaosAmplitude, profile.chaosAmplitude),
      0,
      Math.max(10, gridSize * 0.28)
    );
    const chaosCycles = clamp(
      asNumber(options?.mapShineFlyingChaosCycles, profile.chaosCycles),
      0,
      16
    );
    const scaleTiltStrength = clamp(
      asNumber(options?.mapShineFlyingScaleTiltStrength, profile.scaleTiltStrength),
      0,
      1.4
    );

    const randomness = clamp(
      asNumber(options?.mapShineFlyingRandomness, profile.randomness),
      0,
      1
    );

    const startX = asNumber(sprite.position.x, target.x);
    const startY = asNumber(sprite.position.y, target.y);

    const seedRoot = `${tokenId}|${flyingStyleId}|${Math.round(startX)}|${Math.round(startY)}|${Math.round(target.x)}|${Math.round(target.y)}`;
    const bobRandom = ((hashStringToUnit(`${seedRoot}|f-bob`) * 2) - 1) * randomness;
    const lateralRandom = ((hashStringToUnit(`${seedRoot}|f-lat`) * 2) - 1) * randomness;
    const chaosPhase = hashStringToUnit(`${seedRoot}|f-chaos-phase`) * Math.PI * 2;
    const routeBendPhase = hashStringToUnit(`${seedRoot}|f-route-bend-phase`) * Math.PI * 2;
    const routeBendSeed = ((hashStringToUnit(`${seedRoot}|f-route-bend`) * 2) - 1);

    const randomizedBobAmplitude = Math.max(0, bobAmplitude * (1 + (bobRandom * 0.32)));
    const randomizedLateralAmplitude = Math.max(0, lateralAmplitude * (1 + (lateralRandom * 0.38)));
    const maxRouteBend = Math.min(Math.max(2, gridSize * 0.18), Math.max(2, distance * 0.34));
    const routeBendAmplitude = routeBendSeed * maxRouteBend * routeBendFactor;

    if (!this.isFlying(tokenId)) {
      this.setFlyingState(tokenId, { hoverHeight, rockAmplitudeDeg, rockSpeedHz });
    }

    const flyingState = this.flyingTokens.get(tokenId);
    const startHoverHeight = asNumber(flyingState?.hoverHeight, hoverHeight);
    if (flyingState) {
      flyingState.styleId = flyingStyleId;
      flyingState.hoverHeight = hoverHeight;
      flyingState.rockAmplitudeRad = (rockAmplitudeDeg * Math.PI) / 180;
      flyingState.rockSpeedHz = rockSpeedHz;
    }

    const startGroundZ = asNumber(sprite.position.z - startHoverHeight, target.z);
    const startRotation = asNumber(flyingState?.baseRotation, asNumber(sprite.material?.rotation, target.rotation));

    const durationMs = clamp(
      asNumber(options?.mapShineDurationMs, profile.durationMs),
      180,
      2400
    );

    try {
      this.tokenManager?.emitTokenMovementStart?.(tokenId);
    } catch (_) {
    }

    try {
      const rl = window.MapShine?.renderLoop;
      if (rl?.requestContinuousRender) rl.requestContinuousRender(durationMs + 60);
      else rl?.requestRender?.();
    } catch (_) {
    }

    this.activeTracks.set(tokenId, {
      tokenId,
      styleId: flyingStyleId,
      sprite,
      startX,
      startY,
      startGroundZ,
      startRotation,
      target,
      startHoverHeight,
      hoverHeight,
      bobAmplitude: randomizedBobAmplitude,
      bobCycles,
      lateralAmplitude: randomizedLateralAmplitude,
      lateralCycles,
      bankFactor,
      routeBendAmplitude,
      routeBendPhase,
      chaosAmplitude,
      chaosCycles,
      chaosPhase,
      scaleTiltStrength,
      durationSec: durationMs / 1000,
      elapsedSec: 0
    });
  }

  /**
   * @param {any} track
   * @param {number} tNorm
   */
  _sampleFlyingGlideTrack(track, tNorm) {
    const sprite = track?.sprite;
    if (!sprite) return;

    const easedT = this._resolveFlyingEasedProgress(track.styleId, tNorm);
    const dx = track.target.x - track.startX;
    const dy = track.target.y - track.startY;
    const dist = Math.hypot(dx, dy);
    const invDist = dist > 0.0001 ? (1 / dist) : 0;
    const perpX = -dy * invDist;
    const perpY = dx * invDist;

    const lateral = Math.sin(easedT * Math.PI * 2 * asNumber(track.lateralCycles, 0))
      * asNumber(track.lateralAmplitude, 0)
      * (1 - (0.72 * tNorm));
    const bob = Math.sin(easedT * Math.PI * 2 * asNumber(track.bobCycles, 0))
      * asNumber(track.bobAmplitude, 0)
      * (1 - (0.65 * tNorm));
    const chaos = Math.sin((easedT * Math.PI * 2 * asNumber(track.chaosCycles, 0)) + asNumber(track.chaosPhase, 0))
      * asNumber(track.chaosAmplitude, 0)
      * (1 - (0.55 * tNorm));
    const routeBend = Math.sin((easedT * Math.PI) + asNumber(track.routeBendPhase, 0))
      * Math.sin(easedT * Math.PI)
      * asNumber(track.routeBendAmplitude, 0);

    const x = track.startX + (dx * easedT) + (perpX * (lateral + routeBend + (chaos * 0.4)));
    const y = track.startY + (dy * easedT) + (perpY * (lateral + routeBend + (chaos * 0.4)));
    const baseZ = track.startGroundZ + (track.target.z - track.startGroundZ) * easedT;
    const currentHoverHeight = asNumber(track.startHoverHeight, asNumber(track.hoverHeight, 0))
      + ((asNumber(track.hoverHeight, 0) - asNumber(track.startHoverHeight, asNumber(track.hoverHeight, 0))) * easedT);
    const z = baseZ + bob + (chaos * 0.12);

    const rotDelta = shortestAngleDelta(track.startRotation, track.target.rotation);
    const gridScale = Math.max(1, asNumber(track.target?.gridSize, 100));
    const baseRotation = track.startRotation
      + (rotDelta * easedT)
      + (((lateral + routeBend) / gridScale) * asNumber(track.bankFactor, 0.5))
      + ((chaos / gridScale) * 0.35);

    const tilt = ((lateral + routeBend + (chaos * 0.22)) / gridScale) * asNumber(track.scaleTiltStrength, 0);
    const scalePulse = Math.abs(tilt);
    const scaleX = track.target.scaleX * (1 + (scalePulse * 0.09));
    const scaleY = track.target.scaleY * (1 - (scalePulse * 0.07));

    const state = this.flyingTokens.get(track.tokenId);
    if (state) {
      state.baseZ = z;
      state.baseRotation = baseRotation;
      state.hoverHeight = currentHoverHeight;
    } else if (sprite.material) {
      // Fallback if hover state was externally cleared mid-track.
      sprite.material.rotation = baseRotation;
    }

    sprite.position.set(x, y, z + currentHoverHeight);
    sprite.scale.set(scaleX, scaleY, 1);
    if (sprite.material) sprite.material.rotation = baseRotation;
    if (sprite.matrixAutoUpdate === false) sprite.updateMatrix();
  }

  /**
   * @param {object} timeInfo
   */
  update(timeInfo) {
    const deltaSec = Math.max(0, asNumber(timeInfo?.delta, 0));
    if (deltaSec <= 0) return;

    if (this.activeTracks.size > 0) {
      for (const [tokenId, track] of this.activeTracks) {
        const sprite = track?.sprite;
        if (!sprite || sprite.userData?._removed) {
          this.activeTracks.delete(tokenId);
          continue;
        }

        track.elapsedSec += deltaSec;
        const tNorm = clamp(track.elapsedSec / Math.max(track.durationSec, 0.0001), 0, 1);

        if (this._isFlyingStyle(track.styleId)) {
          this._sampleFlyingGlideTrack(track, tNorm);
        } else if (this._isWalkStyle(track.styleId)) {
          const easedT = this._resolveWalkEasedProgress(track.styleId, tNorm);
          const dx = track.target.x - track.startX;
          const dy = track.target.y - track.startY;
          const dist = Math.hypot(dx, dy);
          const invDist = dist > 0.0001 ? (1 / dist) : 0;
          const dirX = dx * invDist;
          const dirY = dy * invDist;
          const perpX = -dy * invDist;
          const perpY = dx * invDist;

          const lateral = Math.sin(easedT * Math.PI * 2 * asNumber(track.lateralCycles, 0))
            * asNumber(track.lateralAmplitude, 0)
            * (1 - (0.7 * tNorm));

          const stride = Math.sin(easedT * Math.PI * 2 * asNumber(track.bobCycles, 0))
            * asNumber(track.strideAmplitude, 0)
            * (1 - (0.85 * tNorm));

          const bob = Math.sin(easedT * Math.PI * 2 * asNumber(track.bobCycles, 0))
            * asNumber(track.bobAmplitude, 0)
            * (1 - tNorm);

          const chaos = Math.sin((easedT * Math.PI * 2 * asNumber(track.chaosCycles, 0)) + asNumber(track.chaosPhase, 0))
            * asNumber(track.chaosAmplitude, 0)
            * (1 - (0.6 * tNorm));

          const routeBend = Math.sin((easedT * Math.PI) + asNumber(track.routeBendPhase, 0))
            * Math.sin(easedT * Math.PI)
            * asNumber(track.routeBendAmplitude, 0);

          let settle = 0;
          const settleAmplitude = asNumber(track.settleAmplitude, 0);
          if (settleAmplitude > 0) {
            const settleT = clamp((tNorm - 0.82) / 0.18, 0, 1);
            if (settleT > 0) {
              settle = Math.sin(settleT * Math.PI) * (1 - settleT) * settleAmplitude;
            }
          }

          const x = track.startX + (dx * easedT) + (perpX * (lateral + chaos + routeBend)) + (dirX * stride);
          const y = track.startY + (dy * easedT) + (perpY * (lateral + chaos + routeBend)) + (dirY * stride);
          const z = track.startZ + (track.target.z - track.startZ) * easedT + bob - settle;

          const rotDelta = shortestAngleDelta(track.startRotation, track.target.rotation);
          let rotation = track.startRotation + (rotDelta * easedT);
          const gridScale = Math.max(1, asNumber(track.target?.gridSize, 100));
          rotation += (lateral / gridScale) * asNumber(track.rotationSwayFactor, 0.18);
          rotation += (chaos / gridScale) * 0.4;

          // Sprite tokens are billboarded, so we fake chip-like pitch/roll by
          // modulating X/Y scale during movement.
          const tiltStrength = asNumber(track.chipTiltStrength, 0);
          const tilt = ((lateral + chaos) / gridScale) * tiltStrength;
          const scalePulse = Math.abs(tilt);
          const scaleX = track.target.scaleX * (1 + (scalePulse * 0.11));
          const scaleY = track.target.scaleY * (1 - (scalePulse * 0.08));

          sprite.position.set(x, y, z);
          sprite.scale.set(scaleX, scaleY, 1);
          if (sprite.material) sprite.material.rotation = rotation;
          if (sprite.matrixAutoUpdate === false) sprite.updateMatrix();
        } else {
          const x = track.startX + (track.target.x - track.startX) * tNorm;
          const y = track.startY + (track.target.y - track.startY) * tNorm;
          const baseZ = track.startZ + (track.target.z - track.startZ) * tNorm;
          const z = baseZ + (Math.sin(Math.PI * tNorm) * track.arcHeight);

          const rotDelta = shortestAngleDelta(track.startRotation, track.target.rotation);
          const rotation = track.startRotation + (rotDelta * tNorm);

          sprite.position.set(x, y, z);
          if (sprite.material) sprite.material.rotation = rotation;
          if (sprite.matrixAutoUpdate === false) sprite.updateMatrix();
        }

        if (tNorm >= 1) {
          this._finalizeTrack(track);
          this.activeTracks.delete(tokenId);
        }
      }
    }

    // Apply hover rocking after track interpolation so each frame settles to
    // the latest base pose before adding the rocking offset.
    this._updateFlyingTokens(deltaSec);
  }

  /**
   * @param {any} track
   */
  _cancelTrack(track) {
    if (!track?.sprite) return;
    // Intentionally no snap on cancel; next movement update will drive pose.
  }

  /**
   * @param {any} track
   */
  _finalizeTrack(track) {
    const sprite = track?.sprite;
    if (!sprite) return;

    if (this._isFlyingStyle(track.styleId)) {
      const hoverHeight = asNumber(track.hoverHeight, 0);
      const baseZ = asNumber(track.target?.z, sprite.position.z - hoverHeight);
      const baseRotation = asNumber(track.target?.rotation, asNumber(sprite.material?.rotation, 0));

      const flyingState = this.flyingTokens.get(track.tokenId);
      if (flyingState) {
        flyingState.baseZ = baseZ;
        flyingState.baseRotation = baseRotation;
        flyingState.hoverHeight = hoverHeight;
      } else if (sprite.material) {
        sprite.material.rotation = baseRotation;
      }

      sprite.position.set(track.target.x, track.target.y, baseZ + hoverHeight);
      sprite.scale.set(track.target.scaleX, track.target.scaleY, 1);
      if (sprite.matrixAutoUpdate === false) sprite.updateMatrix();
      return;
    }

    sprite.position.set(track.target.x, track.target.y, track.target.z);
    sprite.scale.set(track.target.scaleX, track.target.scaleY, 1);
    if (sprite.material) sprite.material.rotation = track.target.rotation;
    if (sprite.matrixAutoUpdate === false) sprite.updateMatrix();
  }

  /**
   * @param {TokenDocument|object} tokenDoc
   * @returns {{x:number,y:number,z:number,scaleX:number,scaleY:number,rotation:number,gridSize:number}|null}
   */
  _computeTargetTransform(tokenDoc) {
    const grid = canvas?.grid;
    const gridSizeX = (grid && typeof grid.sizeX === 'number' && grid.sizeX > 0)
      ? grid.sizeX
      : ((grid && typeof grid.size === 'number' && grid.size > 0) ? grid.size : 100);
    const gridSizeY = (grid && typeof grid.sizeY === 'number' && grid.sizeY > 0)
      ? grid.sizeY
      : ((grid && typeof grid.size === 'number' && grid.size > 0) ? grid.size : 100);
    const gridSize = Math.max(gridSizeX, gridSizeY);

    const width = asNumber(tokenDoc?.width, 1);
    const height = asNumber(tokenDoc?.height, 1);

    const scaleX = asNumber(tokenDoc?.texture?.scaleX, 1);
    const scaleY = asNumber(tokenDoc?.texture?.scaleY, 1);

    const widthPx = width * gridSizeX * scaleX;
    const heightPx = height * gridSizeY * scaleY;

    const rectWidth = width * gridSizeX;
    const rectHeight = height * gridSizeY;

    const x = asNumber(tokenDoc?.x, 0) + rectWidth / 2;
    const sceneHeight = canvas?.dimensions?.height || 10000;
    const y = sceneHeight - (asNumber(tokenDoc?.y, 0) + rectHeight / 2);

    const elevation = asNumber(tokenDoc?.elevation, 0);
    const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
    const z = groundZ + 3.0 + elevation;

    const THREE = window.THREE;
    const rotationDeg = asNumber(tokenDoc?.rotation, 0);
    const rotation = THREE ? THREE.MathUtils.degToRad(rotationDeg) : (rotationDeg * (Math.PI / 180));

    return {
      x,
      y,
      z,
      scaleX: widthPx,
      scaleY: heightPx,
      rotation,
      gridSize
    };
  }

  // ── TM-2: Weighted A* Pathfinding Core ───────────────────────────────────

  /**
   * Create a cancellable token for long-running path generation/search.
   *
   * @returns {{cancelled: boolean, cancel: () => void}}
   */
  createPathCancelToken() {
    const token = {
      cancelled: false,
      cancel: () => {
        token.cancelled = true;
      }
    };
    return token;
  }

  /**
   * Invalidate active searches so subsequent cancellation checks abort quickly.
   */
  cancelActivePathSearches() {
    this._pathSearchGeneration += 1;
  }

  /**
   * Build a traversable movement graph for weighted A* search.
   *
   * Coordinate space: Foundry/world (top-left origin, Y-down).
   *
   * @param {object} params
   * @param {{x:number,y:number}} params.start
   * @param {{x:number,y:number}} params.end
   * @param {TokenDocument|object|null} [params.tokenDoc]
   * @param {object} [params.options]
   * @param {{cancelled:boolean}|null} [params.cancelToken]
   * @returns {{ok:boolean, nodes: Map<string, {x:number,y:number,key:string}>, adjacency: Map<string, Array<{toKey:string,cost:number}>>, startKey:string, endKey:string, reason?:string, diagnostics?:object}}
   */
  generateMovementGraph({ start, end, tokenDoc = null, options = {}, cancelToken = null } = {}) {
    try {
      const generation = ++this._pathSearchGeneration;
      const context = this._buildPathContext(start, end, tokenDoc, options);
      if (!context) {
        this._pathfindingLog('warn', 'generateMovementGraph blocked: invalid path context input', {
          token: this._pathfindingTokenMeta(tokenDoc),
          start,
          end,
          options
        });
        return {
          ok: false,
          nodes: new Map(),
          adjacency: new Map(),
          startKey: '',
          endKey: '',
          reason: 'invalid-input'
        };
      }

      const nodes = new Map();
      const adjacency = new Map();
      const queue = [];

      const startNode = context.startNode;
      const endNode = context.endNode;
      const startKey = startNode.key;
      const endKey = endNode.key;

      nodes.set(startKey, startNode);
      queue.push(startNode);

      const maxNodes = Math.max(128, asNumber(options?.maxGraphNodes, 6000));
      let truncated = false;
      let edgesAccepted = 0;

      for (let i = 0; i < queue.length; i++) {
        if ((i & 31) === 0 && this._isPathSearchCancelled(cancelToken, generation, options?.shouldCancel)) {
          this._pathfindingLog('warn', 'generateMovementGraph cancelled', {
            token: this._pathfindingTokenMeta(tokenDoc),
            expanded: i,
            nodeCount: nodes.size,
            edgeCount: edgesAccepted,
            start,
            end
          });
          return {
            ok: false,
            nodes,
            adjacency,
            startKey,
            endKey,
            reason: 'cancelled',
            diagnostics: {
              expanded: i,
              nodeCount: nodes.size,
              edgeCount: edgesAccepted
            }
          };
        }

        if (nodes.size >= maxNodes) {
          truncated = true;
          break;
        }

        const node = queue[i];
        const neighbors = this._getCandidateNeighbors(node, context);
        if (!neighbors || neighbors.length === 0) continue;

        let edges = adjacency.get(node.key);
        if (!edges) {
          edges = [];
          adjacency.set(node.key, edges);
        }

        for (const neighbor of neighbors) {
          if (!this._isWithinSearchBounds(neighbor, context.bounds)) continue;
          if (!this._isNodeTraversable(neighbor, context)) continue;

          const collision = this._validatePathSegmentCollision(node, neighbor, context);
          if (!collision.ok) continue;

          const stepCost = this._computeTraversalCost(node, neighbor, context);
          if (!Number.isFinite(stepCost) || stepCost <= 0) continue;

          edges.push({ toKey: neighbor.key, cost: stepCost });
          edgesAccepted += 1;

          if (!nodes.has(neighbor.key)) {
            nodes.set(neighbor.key, neighbor);
            queue.push(neighbor);
          }
        }
      }

      // Ensure end node exists so A* can terminate when discovered by an edge.
      if (!nodes.has(endKey)) {
        nodes.set(endKey, endNode);
      }

      if (truncated) {
        this._pathfindingLog('warn', 'generateMovementGraph reached max node budget (truncated)', {
          token: this._pathfindingTokenMeta(tokenDoc),
          start,
          end,
          nodeCount: nodes.size,
          edgeCount: edgesAccepted,
          maxNodes
        });
      }

      if (edgesAccepted === 0) {
        this._pathfindingLog('warn', 'generateMovementGraph produced zero traversable edges', {
          token: this._pathfindingTokenMeta(tokenDoc),
          start,
          end,
          nodeCount: nodes.size,
          options
        });
      }

      return {
        ok: true,
        nodes,
        adjacency,
        startKey,
        endKey,
        diagnostics: {
          truncated,
          nodeCount: nodes.size,
          edgeCount: edgesAccepted,
          maxNodes,
          doorSegmentCalls: asNumber(context?.doorSegmentCacheStats?.calls, 0),
          doorSegmentCacheHits: asNumber(context?.doorSegmentCacheStats?.hits, 0)
        }
      };
    } catch (error) {
      this._pathfindingLog('error', 'generateMovementGraph threw unexpectedly', {
        token: this._pathfindingTokenMeta(tokenDoc),
        start,
        end,
        options
      }, error);
      return {
        ok: false,
        nodes: new Map(),
        adjacency: new Map(),
        startKey: '',
        endKey: '',
        reason: 'graph-generation-exception'
      };
    }
  }

  /**
   * Find a weighted A* path in Foundry coordinate space.
   *
   * @param {object} params
   * @param {{x:number,y:number}} params.start
   * @param {{x:number,y:number}} params.end
   * @param {TokenDocument|object|null} [params.tokenDoc]
   * @param {object} [params.options]
   * @param {{cancelled:boolean}|null} [params.cancelToken]
   * @returns {{ok:boolean, pathNodes:Array<{x:number,y:number}>, reason?:string, diagnostics?:object}}
   */
  findWeightedPath({ start, end, tokenDoc = null, options = {}, cancelToken = null } = {}) {
    const statsCollector = options?.statsCollector && typeof options.statsCollector === 'object'
      ? options.statsCollector
      : null;

    try {
      const startX = asNumber(start?.x, 0);
      const startY = asNumber(start?.y, 0);
      const endX = asNumber(end?.x, 0);
      const endY = asNumber(end?.y, 0);
      const directDistance = Math.hypot(endX - startX, endY - startY);
      const gridSize = Math.max(1, asNumber(canvas?.grid?.size, asNumber(canvas?.dimensions?.size, 100)));
      const hpaDistanceThreshold = Math.max(gridSize * 8, asNumber(options?.hpaDistanceThresholdPx, gridSize * 12));
      const allowHpa = !optionsBoolean(options?.disableHpa, false)
        && !optionsBoolean(options?.ignoreWalls, false)
        && directDistance >= hpaDistanceThreshold;

      if (allowHpa) {
        const hpaResult = this._findHpaPath({ start, end, tokenDoc, options, cancelToken });
        if (hpaResult?.ok && Array.isArray(hpaResult.pathNodes) && hpaResult.pathNodes.length >= 2) {
          const hpaClipped = this._clipPathBacktrackDetours(hpaResult.pathNodes);
          const hpaSmoothed = this._smoothPathStringPull(hpaClipped, tokenDoc, options);
          // Safety net: verify no HPA-stitched segment crosses a wall.
          const hpaValidated = optionsBoolean(options?.ignoreWalls, false)
            ? hpaSmoothed
            : this._validatePathWallIntegrity(hpaSmoothed, tokenDoc, options);
          if (hpaValidated.length >= 2) {
            const hpaInterpolated = (typeof this._interpolatePathForWalking === 'function')
              ? this._interpolatePathForWalking(hpaValidated)
              : hpaValidated;
            this._recordWeightedPathStats(statsCollector, {
              ok: true,
              reason: 'hpa-ok',
              iterations: Math.max(1, hpaInterpolated.length - 1),
              graphDiagnostics: null
            });
            return {
              ok: true,
              pathNodes: hpaInterpolated,
              diagnostics: {
                iterations: Math.max(1, hpaResult.pathNodes.length - 1),
                weight: clamp(asNumber(options?.weight, this.settings.weightedAStarWeight), 1, 4),
                hpa: hpaResult?.diagnostics || null
              }
            };
          }
          // HPA path crosses a wall — fall through to scene nav graph / dynamic graph.
        }
      }

      // Try precomputed full-scene navigation graph first. This avoids the
      // expensive per-call generateMovementGraph (BFS + collision tests) and
      // runs A* directly on the cached adjacency structure. Falls back to
      // dynamic graph generation if the cache isn't ready or start/end keys
      // aren't in the cached graph.
      let graph = null;
      let useFogFilterInAStar = false;
      if (!optionsBoolean(options?.ignoreWalls, false)
        && !optionsBoolean(options?.disableSceneNavCache, false)) {
        const cachedNav = this._getOrBuildSceneNavGraph(tokenDoc, options);
        if (cachedNav) {
          const snappedStart = this._snapPointToTraversalGrid(
            { x: startX, y: startY },
            { gridType: cachedNav.gridType, grid: canvas?.grid, latticeStep: cachedNav.latticeStep }
          );
          const snappedEnd = this._snapPointToTraversalGrid(
            { x: endX, y: endY },
            { gridType: cachedNav.gridType, grid: canvas?.grid, latticeStep: cachedNav.latticeStep }
          );
          const sk = this._pointKey(snappedStart.x, snappedStart.y);
          const ek = this._pointKey(snappedEnd.x, snappedEnd.y);

          if (cachedNav.nodes.has(sk) && cachedNav.nodes.has(ek)) {
            graph = {
              ok: true,
              nodes: cachedNav.nodes,
              adjacency: cachedNav.adjacency,
              startKey: sk,
              endKey: ek,
              diagnostics: {
                cached: true,
                nodeCount: cachedNav.nodes.size,
                edgeCount: cachedNav.edgeCount
              }
            };

            // Fog filtering must be applied at A* time when using the
            // precomputed graph since it includes all cells regardless of
            // fog/exploration state.
            const fogPolicy = options?.fogPathPolicy || this.settings.fogPathPolicy;
            if (fogPolicy === 'strictNoFogPath' && !game?.user?.isGM) {
              useFogFilterInAStar = true;
            }
          }
        }
      }

      if (!graph) {
        graph = this.generateMovementGraph({
          start,
          end,
          tokenDoc,
          options,
          cancelToken
        });
      }

      if (!graph.ok) {
        this._pathfindingLog('warn', 'findWeightedPath aborted: graph generation failed', {
          token: this._pathfindingTokenMeta(tokenDoc),
          start,
          end,
          reason: graph.reason || 'graph-generation-failed',
          diagnostics: graph.diagnostics || null,
          options
        });
        this._recordWeightedPathStats(statsCollector, {
          ok: false,
          reason: graph.reason || 'graph-generation-failed',
          iterations: 0,
          graphDiagnostics: graph.diagnostics
        });
        return {
          ok: false,
          pathNodes: [],
          reason: graph.reason || 'graph-generation-failed',
          diagnostics: graph.diagnostics
        };
      }

      const weight = clamp(asNumber(options?.weight, this.settings.weightedAStarWeight), 1, 4);
      const maxIterations = Math.max(64, asNumber(options?.maxSearchIterations, 12000));
      const generation = this._pathSearchGeneration;

      // Use a binary min-heap for the open set — O(log n) insert/extract-min
      // instead of the previous O(n) linear scan per iteration.
      const openHeap = new BinaryMinHeap();
      const closedSet = new Set();
      const cameFrom = new Map();
      const gScore = new Map([[graph.startKey, 0]]);
      const startF = this._heuristicScore(graph.startKey, graph.endKey, graph.nodes, options) * weight;
      openHeap.push(graph.startKey, startF);

      let iterations = 0;

      while (openHeap.size > 0) {
        if ((iterations & 31) === 0 && this._isPathSearchCancelled(cancelToken, generation, options?.shouldCancel)) {
          this._pathfindingLog('warn', 'findWeightedPath cancelled', {
            token: this._pathfindingTokenMeta(tokenDoc),
            start,
            end,
            iterations,
            openSetSize: openHeap.size,
            options
          });
          this._recordWeightedPathStats(statsCollector, {
            ok: false,
            reason: 'cancelled',
            iterations,
            graphDiagnostics: graph.diagnostics
          });
          return {
            ok: false,
            pathNodes: [],
            reason: 'cancelled',
            diagnostics: {
              iterations,
              openSetSize: openHeap.size,
              graphDiagnostics: graph.diagnostics
            }
          };
        }

        if (iterations >= maxIterations) {
          this._pathfindingLog('warn', 'findWeightedPath reached max iterations', {
            token: this._pathfindingTokenMeta(tokenDoc),
            start,
            end,
            iterations,
            maxIterations,
            openSetSize: openHeap.size,
            options
          });
          this._recordWeightedPathStats(statsCollector, {
            ok: false,
            reason: 'max-iterations',
            iterations,
            graphDiagnostics: graph.diagnostics
          });
          return {
            ok: false,
            pathNodes: [],
            reason: 'max-iterations',
            diagnostics: {
              iterations,
              maxIterations,
              openSetSize: openHeap.size,
              graphDiagnostics: graph.diagnostics
            }
          };
        }
        iterations += 1;

        const best = openHeap.pop();
        if (!best) break;
        const currentKey = best.key;

        // Skip nodes already expanded (lazy-deletion duplicates from re-push).
        if (closedSet.has(currentKey)) continue;
        closedSet.add(currentKey);

        if (currentKey === graph.endKey) {
          const rawPathNodes = this._reconstructPathNodes(cameFrom, currentKey, graph.nodes);
          const clippedPath = this._clipPathBacktrackDetours(rawPathNodes);
          // String-pull: skip unnecessary intermediate waypoints wherever
          // a direct line-of-sight exists between non-adjacent nodes.
          const smoothedPath = this._smoothPathStringPull(clippedPath, tokenDoc, options);
          // Final safety net: verify no segment crosses a wall.
          const ignoreWalls = optionsBoolean(options?.ignoreWalls, false);
          const finalValidatedPath = ignoreWalls
            ? smoothedPath
            : this._validatePathWallIntegrity(smoothedPath, tokenDoc, options);
          // Re-densify for smooth walk animation: insert intermediate
          // waypoints at grid-cell intervals along each segment.
          const pathNodes = (typeof this._interpolatePathForWalking === 'function')
            ? this._interpolatePathForWalking(finalValidatedPath)
            : finalValidatedPath;
          this._recordWeightedPathStats(statsCollector, {
            ok: true,
            reason: 'ok',
            iterations,
            graphDiagnostics: graph.diagnostics
          });
          return {
            ok: pathNodes.length >= 2,
            pathNodes,
            diagnostics: {
              iterations,
              weight,
              backtrackClipped: rawPathNodes.length !== clippedPath.length,
              nodesClipped: rawPathNodes.length - clippedPath.length,
              smoothed: clippedPath.length !== smoothedPath.length,
              nodesSmoothed: clippedPath.length - smoothedPath.length,
              wallTruncated: smoothedPath.length !== finalValidatedPath.length,
              graphDiagnostics: graph.diagnostics
            }
          };
        }

        const neighbors = graph.adjacency.get(currentKey) || [];
        if (neighbors.length === 0) continue;

        const currentG = gScore.get(currentKey) ?? Number.POSITIVE_INFINITY;
        for (const edge of neighbors) {
          if (closedSet.has(edge.toKey)) continue;

          // When using the precomputed scene nav graph, fog filtering is
          // deferred to A* time because the cached graph includes all cells.
          if (useFogFilterInAStar && edge.toKey !== graph.startKey && edge.toKey !== graph.endKey) {
            const neighborNode = graph.nodes.get(edge.toKey);
            if (neighborNode && !this.isPointVisibleToPlayer(neighborNode)) continue;
          }

          const tentativeG = currentG + asNumber(edge.cost, Number.POSITIVE_INFINITY);
          const neighborG = gScore.get(edge.toKey) ?? Number.POSITIVE_INFINITY;
          if (tentativeG >= neighborG) continue;

          cameFrom.set(edge.toKey, currentKey);
          gScore.set(edge.toKey, tentativeG);

          const h = this._heuristicScore(edge.toKey, graph.endKey, graph.nodes, options);
          const f = tentativeG + (weight * h);
          openHeap.push(edge.toKey, f);
        }
      }

      if (!optionsBoolean(options?.suppressNoPathLog, false)) {
        this._pathfindingLog('warn', 'findWeightedPath ended with no path', {
          token: this._pathfindingTokenMeta(tokenDoc),
          start,
          end,
          diagnostics: {
            iterations,
            weight,
            graphDiagnostics: graph.diagnostics
          },
          options
        });
      }

      this._recordWeightedPathStats(statsCollector, {
        ok: false,
        reason: 'no-path',
        iterations,
        graphDiagnostics: graph.diagnostics
      });

      return {
        ok: false,
        pathNodes: [],
        reason: 'no-path',
        diagnostics: {
          iterations,
          weight,
          graphDiagnostics: graph.diagnostics
        }
      };
    } catch (error) {
      this._pathfindingLog('error', 'findWeightedPath threw unexpectedly', {
        token: this._pathfindingTokenMeta(tokenDoc),
        start,
        end,
        options
      }, error);
      this._recordWeightedPathStats(statsCollector, {
        ok: false,
        reason: 'weighted-path-exception',
        iterations: 0,
        graphDiagnostics: null
      });
      return {
        ok: false,
        pathNodes: [],
        reason: 'weighted-path-exception'
      };
    }
  }

  /**
   * @param {{x:number,y:number}} start
   * @param {{x:number,y:number}} end
   * @param {TokenDocument|object|null} tokenDoc
   * @param {object} options
   * @returns {object|null}
   */
  _buildPathContext(start, end, tokenDoc, options) {
    const startX = asNumber(start?.x, NaN);
    const startY = asNumber(start?.y, NaN);
    const endX = asNumber(end?.x, NaN);
    const endY = asNumber(end?.y, NaN);
    if (!Number.isFinite(startX) || !Number.isFinite(startY) || !Number.isFinite(endX) || !Number.isFinite(endY)) {
      return null;
    }

    const grid = canvas?.grid;
    const dimensions = canvas?.dimensions;
    const sceneRect = dimensions?.sceneRect || {
      x: 0,
      y: 0,
      width: asNumber(dimensions?.width, 0),
      height: asNumber(dimensions?.height, 0)
    };

    const gridSize = Math.max(1, asNumber(grid?.size, 100));
    const gridSizeX = Math.max(1, asNumber(grid?.sizeX, gridSize));
    const gridSizeY = Math.max(1, asNumber(grid?.sizeY, gridSize));
    const gridType = asNumber(grid?.type, 1);

    const marginPx = Math.max(gridSize * 3, asNumber(options?.searchMarginPx, 260));
    const bounds = {
      minX: Math.max(sceneRect.x, Math.min(startX, endX) - marginPx),
      maxX: Math.min(sceneRect.x + sceneRect.width, Math.max(startX, endX) + marginPx),
      minY: Math.max(sceneRect.y, Math.min(startY, endY) - marginPx),
      maxY: Math.min(sceneRect.y + sceneRect.height, Math.max(startY, endY) + marginPx)
    };

    const latticeStep = Math.max(8, asNumber(options?.latticeStepPx, Math.max(24, gridSize * 0.5)));

    const snappedStart = this._snapPointToTraversalGrid({ x: startX, y: startY }, { gridType, grid, latticeStep });
    const snappedEnd = this._snapPointToTraversalGrid({ x: endX, y: endY }, { gridType, grid, latticeStep });

    const makeNode = (point) => {
      const x = asNumber(point?.x, 0);
      const y = asNumber(point?.y, 0);
      return {
        x,
        y,
        key: this._pointKey(x, y)
      };
    };

    return {
      tokenDoc,
      options,
      grid,
      gridType,
      gridSize,
      gridSizeX,
      gridSizeY,
      latticeStep,
      bounds,
      sceneRect,
      doorSegmentCache: new Map(),
      doorSegmentCacheStats: {
        calls: 0,
        hits: 0
      },
      startNode: makeNode(snappedStart),
      endNode: makeNode(snappedEnd)
    };
  }

  /**
   * @param {number} x
   * @param {number} y
   * @returns {string}
   */
  _pointKey(x, y) {
    return `${Math.round(x)}:${Math.round(y)}`;
  }

  /**
   * @param {{x:number,y:number}} point
   * @param {{gridType:number,grid:any,latticeStep:number}} options
   * @returns {{x:number,y:number}}
   */
  _snapPointToTraversalGrid(point, { gridType, grid, latticeStep }) {
    const p = {
      x: asNumber(point?.x, 0),
      y: asNumber(point?.y, 0)
    };

    const gridTypes = globalThis.CONST?.GRID_TYPES || {};
    const isGridless = gridType === gridTypes.GRIDLESS;
    if (isGridless) {
      return {
        x: Math.round(p.x / latticeStep) * latticeStep,
        y: Math.round(p.y / latticeStep) * latticeStep
      };
    }

    try {
      if (grid && typeof grid.getSnappedPoint === 'function') {
        const snapMode = globalThis.CONST?.GRID_SNAPPING_MODES?.CENTER;
        return grid.getSnappedPoint(p, snapMode !== undefined ? { mode: snapMode } : undefined);
      }
    } catch (_) {
    }

    return {
      x: Math.round(p.x),
      y: Math.round(p.y)
    };
  }

  /**
   * @param {{x:number,y:number,key:string}} node
   * @param {object} context
   * @returns {Array<{x:number,y:number,key:string}>}
   */
  _getCandidateNeighbors(node, context) {
    const gridType = context.gridType;
    const gridTypes = globalThis.CONST?.GRID_TYPES || {};
    const gridless = gridType === gridTypes.GRIDLESS;

    if (gridless) {
      const step = context.latticeStep;
      const offsets = [
        [step, 0],
        [-step, 0],
        [0, step],
        [0, -step],
        [step, step],
        [step, -step],
        [-step, step],
        [-step, -step]
      ];
      return this._buildNeighborNodesFromOffsets(node, offsets, context);
    }

    const isHex = gridType === gridTypes.HEXODDR
      || gridType === gridTypes.HEXEVENR
      || gridType === gridTypes.HEXODDQ
      || gridType === gridTypes.HEXEVENQ;

    if (isHex) {
      const radius = Math.max(context.gridSizeX, context.gridSizeY);
      const dedupe = new Map();
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i;
        const raw = {
          x: node.x + Math.cos(angle) * radius,
          y: node.y + Math.sin(angle) * radius
        };
        const snapped = this._snapPointToTraversalGrid(raw, {
          gridType: context.gridType,
          grid: context.grid,
          latticeStep: context.latticeStep
        });
        const key = this._pointKey(snapped.x, snapped.y);
        if (key === node.key) continue;
        dedupe.set(key, {
          x: snapped.x,
          y: snapped.y,
          key
        });
      }
      return [...dedupe.values()];
    }

    const allowDiagonal = optionsBoolean(context.options?.allowDiagonal, true);
    const sx = context.gridSizeX;
    const sy = context.gridSizeY;
    const offsets = [
      [sx, 0],
      [-sx, 0],
      [0, sy],
      [0, -sy]
    ];
    if (allowDiagonal) {
      offsets.push([sx, sy], [sx, -sy], [-sx, sy], [-sx, -sy]);
    }

    return this._buildNeighborNodesFromOffsets(node, offsets, context);
  }

  /**
   * @param {{x:number,y:number,key:string}} node
   * @param {Array<[number, number]>} offsets
   * @param {object} context
   * @returns {Array<{x:number,y:number,key:string}>}
   */
  _buildNeighborNodesFromOffsets(node, offsets, context) {
    const out = [];
    const seen = new Set();
    for (const [dx, dy] of offsets) {
      const raw = { x: node.x + dx, y: node.y + dy };
      const snapped = this._snapPointToTraversalGrid(raw, {
        gridType: context.gridType,
        grid: context.grid,
        latticeStep: context.latticeStep
      });
      const key = this._pointKey(snapped.x, snapped.y);
      if (key === node.key || seen.has(key)) continue;
      seen.add(key);
      out.push({ x: snapped.x, y: snapped.y, key });
    }
    return out;
  }

  /**
   * @param {{x:number,y:number}} point
   * @param {{minX:number,maxX:number,minY:number,maxY:number}} bounds
   * @returns {boolean}
   */
  _isWithinSearchBounds(point, bounds) {
    const x = asNumber(point?.x, NaN);
    const y = asNumber(point?.y, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    return x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
  }

  /**
   * @param {{x:number,y:number,key:string}} node
   * @param {object} context
   * @returns {boolean}
   */
  _isNodeTraversable(node, context) {
    if (!this._isWithinSearchBounds(node, context.bounds)) return false;

    const fogPolicy = context.options?.fogPathPolicy || this.settings.fogPathPolicy;
    if (fogPolicy === 'strictNoFogPath') {
      if (!game?.user?.isGM && !this.isPointVisibleToPlayer(node)) {
        const isStart = node.key === context.startNode.key;
        const isEnd = node.key === context.endNode.key;
        if (!isStart && !isEnd) return false;
      }
    }

    return true;
  }

  /**
   * Validate a movement edge against Foundry collision checks.
   *
   * For tokens larger than 1×1 grid cells, we test parallel rays at the
   * token's corners (Minkowski sum) so fat tokens cannot pathfind through
   * gaps narrower than their footprint.
   *
   * @param {{x:number,y:number}} from
   * @param {{x:number,y:number}} to
   * @param {object} context
   * @returns {{ok:boolean, reason?:string}}
   */
  _validatePathSegmentCollision(from, to, context) {
    if (optionsBoolean(context.options?.ignoreWalls, false)) return { ok: true };

    const tokenObj = context.tokenDoc?.object || canvas?.tokens?.get?.(context.tokenDoc?.id) || null;
    const polygonBackends = CONFIG?.Canvas?.polygonBackends;
    const collisionElevation = asNumber(context.tokenDoc?.elevation, asNumber(tokenObj?.document?.elevation, 0));
    const rayA = { x: asNumber(from?.x, 0), y: asNumber(from?.y, 0), elevation: collisionElevation };
    const rayB = { x: asNumber(to?.x, 0), y: asNumber(to?.y, 0), elevation: collisionElevation };

    // Build corner offsets for fat-token Minkowski expansion.
    // For 1×1 tokens the only ray is center→center (offsets = [[0,0]]).
    // For larger tokens we also test at each corner of the bounding box
    // so the full footprint is checked against walls.
    const halfW = this._getTokenCollisionHalfSize(context.tokenDoc);
    const cornerOffsets = [[0, 0]];
    if (halfW.x > 1 || halfW.y > 1) {
      cornerOffsets.push(
        [-halfW.x, -halfW.y],
        [halfW.x, -halfW.y],
        [-halfW.x, halfW.y],
        [halfW.x, halfW.y]
      );
    }

    // Critical: collision must be tested per candidate graph segment (rayA -> rayB).
    // token.checkCollision(target) is origin-implicit (token's live document position),
    // which collapses A* expansion at the first wall and prevents routing around it.
    //
    // MS-LVL-073: useThreshold enables proximity/distance wall evaluation so
    //   WALL_SENSE_TYPES.PROXIMITY (30) and DISTANCE (40) walls are conditionally
    //   bypassed based on source-to-wall distance instead of always blocking.
    // MS-LVL-074: wallDirectionMode uses numeric 0 (NORMAL) so one-way walls
    //   are respected during pathfinding. Only 'move' type is tested for physical
    //   movement collision — sight/light are for vision, not movement. Terrain
    //   walls (LIMITED sense type) are handled natively by Foundry's move backend.
    if (polygonBackends) {
      const moveBackend = polygonBackends?.['move'];
      if (!moveBackend || typeof moveBackend.testCollision !== 'function') {
        return { ok: true };
      }

      for (const [ox, oy] of cornerOffsets) {
        const a = { x: rayA.x + ox, y: rayA.y + oy, elevation: rayA.elevation };
        const b = { x: rayB.x + ox, y: rayB.y + oy, elevation: rayB.elevation };

        try {
          const hit = moveBackend.testCollision(a, b, {
            mode: context.options?.collisionMode || 'closest',
            type: 'move',
            source: tokenObj,
            token: tokenObj,
            wallDirectionMode: 0,   // NORMAL — respect one-way wall direction
            useThreshold: true      // MS-LVL-073: evaluate proximity/distance walls
          });
          if (!hit) continue;

          if (typeof hit === 'object' && this._collisionResultBlocksAtElevation(hit, collisionElevation)) {
            return { ok: false, reason: 'collision-move' };
          }

          // If the nearest hit is out of wall-height bounds, re-check all hits
          // so farther valid-height walls still block movement.
          const allHits = moveBackend.testCollision(a, b, {
            mode: 'all',
            type: 'move',
            source: tokenObj,
            token: tokenObj,
            wallDirectionMode: 0,
            useThreshold: true
          });
          if (this._collisionResultBlocksAtElevation(allHits, collisionElevation)) {
            return { ok: false, reason: 'collision-move' };
          }
        } catch (_) {
        }
      }
      return { ok: true };
    }

    // Fallback only when polygon backends are unavailable.
    // Test center ray only (no Minkowski) since checkCollision is origin-implicit.
    const target = { x: rayB.x, y: rayB.y, elevation: rayB.elevation };
    try {
      if (tokenObj && typeof tokenObj.checkCollision === 'function') {
        const mode = context.options?.collisionMode || 'closest';
        const hit = tokenObj.checkCollision(target, {
          mode,
          type: 'move',
          origin: { x: rayA.x, y: rayA.y, elevation: rayA.elevation }
        });
        if (hit) return { ok: false, reason: 'collision-move' };
      }
    } catch (_) {
    }

    return { ok: true };
  }

  /**
   * @param {boolean|object|Array<object>|null|undefined} hit
   * @param {number} elevation
   * @returns {boolean}
   */
  _collisionResultBlocksAtElevation(hit, elevation) {
    if (!hit) return false;
    if (!Number.isFinite(elevation)) return true;

    if (Array.isArray(hit)) {
      for (const entry of hit) {
        if (this._collisionVertexBlocksAtElevation(entry, elevation)) return true;
      }
      return false;
    }

    if (typeof hit === 'object') {
      return this._collisionVertexBlocksAtElevation(hit, elevation);
    }

    return !!hit;
  }

  /**
   * @param {object|null|undefined} vertex
   * @param {number} elevation
   * @returns {boolean}
   */
  _collisionVertexBlocksAtElevation(vertex, elevation) {
    const edges = vertex?.edges;
    if (!(edges instanceof Set) || edges.size === 0) return true;

    for (const edge of edges) {
      if (!edge) continue;

      // Non-wall edges are treated as blocking to preserve baseline safety.
      if (edge.type && edge.type !== 'wall') return true;

      const wallLike = edge.object;
      const wallDoc = wallLike?.document ?? wallLike ?? null;
      if (!wallDoc) return true;

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

      if (bottom <= elevation && elevation <= top) return true;
    }

    // No wall edge matched this elevation, so this collision does not block.
    return false;
  }

  /**
   * Compute the half-size of a token's collision footprint in pixels,
   * shrunk by a small margin to allow passage through openings that are
   * exactly the token's width.
   *
   * @param {TokenDocument|object|null} tokenDoc
   * @returns {{x:number, y:number}}
   */
  _getTokenCollisionHalfSize(tokenDoc) {
    const size = this._getTokenPixelSize(tokenDoc);
    // Shrink by 2px so a 2×2 token can fit through a 2-grid-wide gap.
    const margin = 2;
    return {
      x: Math.max(0, (size.widthPx / 2) - margin),
      y: Math.max(0, (size.heightPx / 2) - margin)
    };
  }

  /**
   * Ensure each group token reaches its assigned destination, even if the
   * synchronized timeline encountered transient contention and ended short.
   *
   * @param {Array<{tokenId:string, tokenDoc:any, destinationTopLeft:{x:number,y:number}}>} planEntries
   * @param {object} options
   * @returns {Promise<{ok:boolean, reason?:string, correctedCount:number}>}
   */
  async _reconcileGroupFinalPositions(planEntries, options = {}) {
    const plans = Array.isArray(planEntries) ? planEntries : [];
    if (plans.length === 0) return { ok: true, correctedCount: 0 };

    const unresolved = [];
    for (const entry of plans) {
      const liveDoc = this._resolveTokenDocumentById(entry?.tokenId, entry?.tokenDoc);
      if (!liveDoc || !entry?.destinationTopLeft) continue;
      const dx = Math.abs(asNumber(liveDoc?.x, 0) - asNumber(entry.destinationTopLeft?.x, 0));
      const dy = Math.abs(asNumber(liveDoc?.y, 0) - asNumber(entry.destinationTopLeft?.y, 0));
      if (dx >= 0.5 || dy >= 0.5) unresolved.push({ entry, liveDoc });
    }

    if (unresolved.length === 0) {
      return { ok: true, correctedCount: 0 };
    }

    this._pathfindingLog('warn', '_reconcileGroupFinalPositions detected unresolved token endpoints', {
      unresolvedTokenIds: unresolved.map((item) => String(item?.entry?.tokenId || '')).filter(Boolean),
      unresolvedCount: unresolved.length,
      planCount: plans.length,
      options
    });

    const unresolvedById = new Map(unresolved.map((item) => [String(item?.entry?.tokenId || ''), item.entry]));
    const lastFailureReasonById = new Map();
    const maxPasses = Math.max(1, Math.min(12, unresolved.length * 2));
    let correctedCount = 0;

    for (let pass = 1; pass <= maxPasses; pass++) {
      if (unresolvedById.size === 0) {
        return { ok: true, correctedCount };
      }

      let passProgress = 0;
      for (const [tokenId, entry] of [...unresolvedById.entries()]) {
        const liveDoc = this._resolveTokenDocumentById(tokenId, entry?.tokenDoc);
        if (!liveDoc || !entry?.destinationTopLeft) {
          lastFailureReasonById.set(tokenId, 'missing-token-doc');
          continue;
        }

        const beforeDx = Math.abs(asNumber(liveDoc?.x, 0) - asNumber(entry.destinationTopLeft?.x, 0));
        const beforeDy = Math.abs(asNumber(liveDoc?.y, 0) - asNumber(entry.destinationTopLeft?.y, 0));
        if (beforeDx < 0.5 && beforeDy < 0.5) {
          unresolvedById.delete(tokenId);
          continue;
        }

        const repair = await this.executeDoorAwareTokenMove({
          tokenDoc: liveDoc,
          destinationTopLeft: entry.destinationTopLeft,
          options: {
            ...options,
            method: options?.method || 'path-walk'
          }
        });

        if (!repair?.ok) {
          lastFailureReasonById.set(tokenId, repair?.reason || 'group-final-reconcile-failed');
          this._pathfindingLog('warn', '_reconcileGroupFinalPositions repair move failed', {
            tokenId,
            reason: repair?.reason || 'group-final-reconcile-failed',
            destinationTopLeft: entry?.destinationTopLeft,
            pass,
            maxPasses,
            options
          });
          continue;
        }

        const afterDoc = this._resolveTokenDocumentById(tokenId, entry?.tokenDoc);
        const afterDx = Math.abs(asNumber(afterDoc?.x, 0) - asNumber(entry.destinationTopLeft?.x, 0));
        const afterDy = Math.abs(asNumber(afterDoc?.y, 0) - asNumber(entry.destinationTopLeft?.y, 0));
        if (afterDx < 0.5 && afterDy < 0.5) {
          unresolvedById.delete(tokenId);
          passProgress += 1;
          correctedCount += 1;
          lastFailureReasonById.delete(tokenId);
        } else {
          lastFailureReasonById.set(tokenId, 'repair-no-position-change');
        }
      }

      if (unresolvedById.size === 0) {
        return { ok: true, correctedCount };
      }

      if (passProgress === 0) {
        break;
      }
    }

    const remainingDetails = [...unresolvedById.keys()].map((tokenId) => ({
      tokenId,
      reason: lastFailureReasonById.get(tokenId) || 'unknown'
    }));

    this._pathfindingLog('warn', '_reconcileGroupFinalPositions incomplete after repair attempts', {
      remaining: unresolvedById.size,
      correctedCount,
      attemptedRepairs: unresolved.length,
      remainingDetails,
      options
    });

    return {
      ok: false,
      reason: 'group-final-reconcile-incomplete',
      correctedCount,
      remainingCount: unresolvedById.size,
      remainingDetails
    };
  }

  /**
   * @param {{x:number,y:number}} from
   * @param {{x:number,y:number}} to
   * @param {object} context
   * @returns {number}
   */
  _computeTraversalCost(from, to, context) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    if (!Number.isFinite(distance) || distance <= 0) return Number.POSITIVE_INFINITY;

    if (optionsBoolean(context.options?.ignoreCost, false)) {
      return distance;
    }

    let multiplier = 1;

    const terrainCostProvider = context.options?.terrainCostProvider;
    if (typeof terrainCostProvider === 'function') {
      try {
        const terrainMultiplier = asNumber(terrainCostProvider(from, to, context.tokenDoc), 1);
        if (Number.isFinite(terrainMultiplier) && terrainMultiplier > 0) {
          multiplier *= terrainMultiplier;
        }
      } catch (_) {
      }
    }

    let doorPenalty = 0;
    const doorHits = this._findDoorsAlongSegmentCached(from, to, context);
    for (const hit of doorHits) {
      if (hit.ds === DOOR_STATES.OPEN) continue;

      // Locked door is a hard blocker unless user is GM.
      if (hit.ds === DOOR_STATES.LOCKED && !game?.user?.isGM) {
        return Number.POSITIVE_INFINITY;
      }

      // Closed/secret-but-known doors add a finite interaction penalty.
      doorPenalty += context.gridSize * 0.25;
    }

    const occupancyPenaltyProvider = context.options?.occupancyPenaltyProvider;
    if (typeof occupancyPenaltyProvider === 'function') {
      try {
        const occupancyPenalty = asNumber(occupancyPenaltyProvider(from, to, context.tokenDoc), 0);
        if (Number.isFinite(occupancyPenalty) && occupancyPenalty > 0) {
          doorPenalty += occupancyPenalty;
        }
      } catch (_) {
      }
    }

    return (distance * multiplier) + doorPenalty;
  }

  /**
   * @param {{x:number,y:number}} from
   * @param {{x:number,y:number}} to
   * @param {object} context
   * @returns {Array<any>}
   */
  _findDoorsAlongSegmentCached(from, to, context) {
    const cache = context?.doorSegmentCache;
    const stats = context?.doorSegmentCacheStats;
    if (stats && typeof stats === 'object') {
      stats.calls = asNumber(stats.calls, 0) + 1;
    }

    const ax = Math.round(asNumber(from?.x, 0));
    const ay = Math.round(asNumber(from?.y, 0));
    const bx = Math.round(asNumber(to?.x, 0));
    const by = Math.round(asNumber(to?.y, 0));

    const forwardKey = `${ax}:${ay}|${bx}:${by}`;
    const reverseKey = `${bx}:${by}|${ax}:${ay}`;
    const key = forwardKey < reverseKey ? forwardKey : reverseKey;

    if (cache instanceof Map && cache.has(key)) {
      if (stats && typeof stats === 'object') {
        stats.hits = asNumber(stats.hits, 0) + 1;
      }
      return cache.get(key) || [];
    }

    const hits = this.findDoorsAlongSegment(from, to);
    if (cache instanceof Map) {
      cache.set(key, hits);
    }
    return hits;
  }

  /**
   * @param {string} fromKey
   * @param {string} toKey
   * @param {Map<string, {x:number,y:number}>} nodes
   * @param {object} options
   * @returns {number}
   */
  _heuristicScore(fromKey, toKey, nodes, options) {
    const a = nodes.get(fromKey);
    const b = nodes.get(toKey);
    if (!a || !b) return Number.POSITIVE_INFINITY;

    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    const allowDiagonal = optionsBoolean(options?.allowDiagonal, true);

    // Octile heuristic for square+diagonal, Manhattan for cardinal-only, and
    // Euclidean fallback for gridless/hex approximations.
    if (allowDiagonal) {
      const minD = Math.min(dx, dy);
      const maxD = Math.max(dx, dy);
      return (Math.SQRT2 * minD) + (maxD - minD);
    }
    return dx + dy;
  }

  /**
   * @param {Set<string>} openSet
   * @param {Map<string, number>} fScore
   * @returns {string}
   */
  _selectOpenSetBestNode(openSet, fScore) {
    let bestKey = '';
    let bestScore = Number.POSITIVE_INFINITY;
    for (const key of openSet) {
      const score = fScore.get(key) ?? Number.POSITIVE_INFINITY;
      if (score < bestScore) {
        bestScore = score;
        bestKey = key;
      }
    }
    return bestKey;
  }

  /**
   * @param {Map<string, string>} cameFrom
   * @param {string} currentKey
   * @param {Map<string, {x:number,y:number}>} nodes
   * @returns {Array<{x:number,y:number}>}
   */
  _reconstructPathNodes(cameFrom, currentKey, nodes) {
    const path = [];
    let key = currentKey;
    while (key) {
      const node = nodes.get(key);
      if (node) {
        path.push({ x: node.x, y: node.y });
      }
      key = cameFrom.get(key) || '';
    }
    path.reverse();
    return path;
  }

  /**
   * Post-process a path to remove unnecessary backtrack detours where the
   * path enters a dead-end area (e.g. a room) and then exits through the
   * same doorway. This happens because weighted A* (weight > 1) produces
   * slightly suboptimal paths — the heuristic pulls the search toward the
   * goal, causing it to explore dead ends that are geographically closer.
   *
   * The algorithm scans for pairs of path nodes (i, j) that are very close
   * to each other but separated by many intermediate nodes. The segment
   * between them is a U-turn detour that can be safely clipped.
   *
   * Two complementary passes are applied:
   * 1. **Proximity loop clipping**: Remove segments where the path returns
   *    to within ~1 grid cell of a previously visited point.
   * 2. **Progress-stall clipping**: Remove segments where the path stops
   *    making net progress toward the goal (distance-to-goal at the end of
   *    the segment ≈ distance-to-goal at the start).
   *
   * @param {Array<{x:number,y:number}>} pathNodes
   * @returns {Array<{x:number,y:number}>}
   */
  _clipPathBacktrackDetours(pathNodes) {
    if (!Array.isArray(pathNodes) || pathNodes.length < 4) return pathNodes;

    const gridSize = Math.max(1, asNumber(canvas?.grid?.size, 100));
    let path = pathNodes;

    // Helper: verify that a shortcut from path[i] to path[j] doesn't cross
    // any walls. Without this check, clipping a legitimate detour through a
    // doorway would create a shortcut straight through a wall.
    const isShortcutWallFree = (a, b) => {
      const check = this._validatePathSegmentCollision(a, b, {
        tokenDoc: null,
        options: { ignoreWalls: false, collisionMode: 'closest' }
      });
      return check?.ok === true;
    };

    // --- Pass 1: Proximity loop clipping ---
    // If the path visits two nodes that are within ~1 grid cell of each other
    // but separated by 3+ intermediate nodes, the segment between them is a
    // backtrack loop. Clip it by jumping from the earlier node to the later one,
    // but ONLY if the shortcut doesn't cross a wall.
    const proximityThreshold = gridSize * 1.0;
    const proximityThresholdSq = proximityThreshold * proximityThreshold;
    const maxProximityPasses = 8;

    for (let pass = 0; pass < maxProximityPasses; pass++) {
      let clipped = false;

      for (let i = 0; i < path.length - 3 && !clipped; i++) {
        // Search backwards from the end to find the FURTHEST matching node,
        // removing the largest possible detour first.
        for (let j = path.length - 1; j >= i + 3; j--) {
          const dx = asNumber(path[j].x, 0) - asNumber(path[i].x, 0);
          const dy = asNumber(path[j].y, 0) - asNumber(path[i].y, 0);
          if (dx * dx + dy * dy <= proximityThresholdSq) {
            // Verify the shortcut doesn't cross a wall before clipping.
            if (!isShortcutWallFree(path[i], path[j])) continue;
            path = [...path.slice(0, i + 1), ...path.slice(j)];
            clipped = true;
            break;
          }
        }
      }

      if (!clipped) break;
    }

    // --- Pass 2: Progress-stall clipping ---
    // Detect segments where the path stops making net progress toward the
    // goal. A "stall" is where the path wanders into a dead end and comes
    // back, ending up at roughly the same distance-to-goal as it started.
    // We check for contiguous sequences of nodes where d(node, goal) first
    // increases (moving away) then decreases back to the entry value.
    if (path.length >= 5) {
      const goal = path[path.length - 1];
      const distToGoal = (pt) => Math.hypot(
        asNumber(pt.x, 0) - asNumber(goal.x, 0),
        asNumber(pt.y, 0) - asNumber(goal.y, 0)
      );

      // Minimum detour length to consider clipping (in grid cells of path
      // distance). Short diversions around small obstacles are acceptable.
      const minDetourNodes = 4;
      const progressTolerance = gridSize * 1.5;
      const maxProgressPasses = 6;

      for (let pass = 0; pass < maxProgressPasses; pass++) {
        let clipped = false;

        for (let i = 0; i < path.length - minDetourNodes && !clipped; i++) {
          const baseDist = distToGoal(path[i]);

          // Walk forward looking for the path to diverge (move away from
          // goal) then return to approximately the same distance-to-goal.
          let peakDist = baseDist;

          for (let j = i + 1; j < path.length; j++) {
            const d = distToGoal(path[j]);

            if (d > peakDist) {
              peakDist = d;
            }

            // Check if the path has returned to ≈ the same distance-to-goal
            // (or closer) after having diverged significantly.
            const divergedEnough = (peakDist - baseDist) > gridSize * 2;
            const returnedClose = d <= baseDist + progressTolerance;
            const detourLongEnough = (j - i) >= minDetourNodes;

            if (divergedEnough && returnedClose && detourLongEnough) {
              const directDist = Math.hypot(
                asNumber(path[j].x, 0) - asNumber(path[i].x, 0),
                asNumber(path[j].y, 0) - asNumber(path[i].y, 0)
              );
              const detourPathLen = this._measurePathLength(path.slice(i, j + 1));

              // Only clip if the detour path is significantly longer than
              // the direct connection, the shortcut is short-range, AND the
              // shortcut doesn't cross any walls.
              if (detourPathLen > directDist * 2.0
                && directDist < gridSize * 4
                && isShortcutWallFree(path[i], path[j])) {
                path = [...path.slice(0, i + 1), ...path.slice(j)];
                clipped = true;
                break;
              }
            }
          }
        }

        if (!clipped) break;
      }
    }

    return path;
  }

  /**
   * String-pulling path smoother: greedily skip intermediate waypoints
   * wherever a direct line-of-sight exists between non-adjacent nodes.
   *
   * Grid-based A* produces staircase patterns (e.g. right-right-down-right-down)
   * even when a smooth diagonal would be wall-free. Weighted A* (weight > 1)
   * makes this worse by accepting suboptimal zigzags. This pass straightens
   * the path by checking, for each anchor node, the furthest reachable node
   * via a wall-free direct line, then jumping there and repeating.
   *
   * @param {Array<{x:number,y:number}>} pathNodes
   * @param {TokenDocument|object|null} tokenDoc
   * @param {object} [options]
   * @returns {Array<{x:number,y:number}>}
   */
  _smoothPathStringPull(pathNodes, tokenDoc = null, options = {}) {
    if (!Array.isArray(pathNodes) || pathNodes.length < 3) return pathNodes;
    if (optionsBoolean(options?.ignoreWalls, false)) return pathNodes;

    const collisionContext = {
      tokenDoc,
      options: {
        ignoreWalls: false,
        collisionMode: options?.collisionMode || 'closest'
      }
    };

    const smoothed = [pathNodes[0]];
    let anchor = 0;

    while (anchor < pathNodes.length - 1) {
      // From the current anchor, look as far ahead as possible to find
      // the furthest node reachable via a wall-free direct line.
      let furthest = anchor + 1;

      for (let probe = pathNodes.length - 1; probe > anchor + 1; probe--) {
        const check = this._validatePathSegmentCollision(
          pathNodes[anchor],
          pathNodes[probe],
          collisionContext
        );
        if (check?.ok) {
          furthest = probe;
          break;
        }
      }

      smoothed.push(pathNodes[furthest]);
      anchor = furthest;
    }

    return smoothed;
  }

  /**
   * Re-densify a smoothed path by inserting intermediate waypoints at
   * approximately grid-cell intervals along each segment. After string-
   * pulling, paths may have only 3–4 nodes with long straight segments.
   * The group timeline steps through nodes one at a time, so sparse paths
   * cause tokens to "teleport" instead of walking smoothly. This method
   * adds evenly-spaced intermediate points so the walk animation has
   * enough steps for fluid movement.
   *
   * @param {Array<{x:number,y:number}>} pathNodes
   * @returns {Array<{x:number,y:number}>}
   */
  _interpolatePathForWalking(pathNodes) {
    if (!Array.isArray(pathNodes) || pathNodes.length < 2) return pathNodes;

    const gridSize = Math.max(1, asNumber(canvas?.grid?.size, 100));
    // Step size: one grid cell — gives a smooth walk cadence.
    const stepSize = gridSize;

    const result = [pathNodes[0]];

    for (let i = 1; i < pathNodes.length; i++) {
      const prev = pathNodes[i - 1];
      const curr = pathNodes[i];
      const dx = asNumber(curr.x, 0) - asNumber(prev.x, 0);
      const dy = asNumber(curr.y, 0) - asNumber(prev.y, 0);
      const segLen = Math.hypot(dx, dy);

      if (segLen <= stepSize * 1.5) {
        // Segment is short enough — keep as-is.
        result.push(curr);
        continue;
      }

      // Insert intermediate points at stepSize intervals.
      const steps = Math.max(1, Math.round(segLen / stepSize));
      const nx = dx / segLen;
      const ny = dy / segLen;
      const actualStep = segLen / steps;

      for (let s = 1; s < steps; s++) {
        result.push({
          x: asNumber(prev.x, 0) + nx * actualStep * s,
          y: asNumber(prev.y, 0) + ny * actualStep * s
        });
      }

      // Always end with the exact endpoint.
      result.push(curr);
    }

    return result;
  }

  /**
   * Safety-net validation: walk every segment of a path and verify none
   * cross a wall. If a wall-crossing segment is found, the path is
   * truncated just before the offending segment. This catches any
   * wall-violating paths regardless of how they were produced (clipper
   * bugs, HPA stitching errors, graph cache staleness, etc.).
   *
   * @param {Array<{x:number,y:number}>} pathNodes
   * @param {TokenDocument|object|null} tokenDoc
   * @param {object} [options]
   * @returns {Array<{x:number,y:number}>}
   */
  _validatePathWallIntegrity(pathNodes, tokenDoc = null, options = {}) {
    if (!Array.isArray(pathNodes) || pathNodes.length < 2) return pathNodes;
    if (optionsBoolean(options?.ignoreWalls, false)) return pathNodes;

    const collisionContext = {
      tokenDoc,
      options: {
        ignoreWalls: false,
        collisionMode: options?.collisionMode || 'closest'
      }
    };

    for (let i = 0; i < pathNodes.length - 1; i++) {
      const check = this._validatePathSegmentCollision(pathNodes[i], pathNodes[i + 1], collisionContext);
      if (!check?.ok) {
        // Truncate the path at the last valid node. The token will stop
        // just before the wall rather than attempting to pass through it.
        this._pathfindingLog('warn', '_validatePathWallIntegrity found wall-crossing segment — truncating path', {
          segmentIndex: i,
          from: pathNodes[i],
          to: pathNodes[i + 1],
          originalLength: pathNodes.length,
          truncatedLength: i + 1,
          reason: check?.reason || 'collision'
        });
        return pathNodes.slice(0, i + 1);
      }
    }

    return pathNodes;
  }

  /**
   * @param {{cancelled:boolean}|null} cancelToken
   * @param {number} generation
   * @param {Function|undefined} shouldCancel
   * @returns {boolean}
   */
  _isPathSearchCancelled(cancelToken, generation, shouldCancel) {
    if (cancelToken?.cancelled) return true;
    if (generation !== this._pathSearchGeneration) return true;
    if (typeof shouldCancel === 'function') {
      try {
        return !!shouldCancel();
      } catch (_) {
      }
    }
    return false;
  }

  // ── Flying Movement + Elevation Indicators ─────────────────────────────────

  /**
   * Map of tokenId → flying state objects. Tracks which tokens are currently
   * in "flying" hover mode with visual indicators.
   * @type {Map<string, FlyingState>}
   */
  get flyingTokens() {
    if (!this._flyingTokens) this._flyingTokens = new Map();
    return this._flyingTokens;
  }

  /**
   * @param {TokenDocument|object|null} tokenDoc
   * @param {number} worldX
   * @param {number} worldY
   * @returns {{type:'ground'|'tile', tileId:string, tileDoc:any, elevation:number, sortKey:number, label:string}}
   */
  _resolveFlyingSupportSurface(tokenDoc, worldX, worldY) {
    const tokenElevation = asNumber(tokenDoc?.elevation, 0);
    const tileManager = window.MapShine?.tileManager;
    const tileEntries = tileManager?.tileSprites;
    let best = null;

    if (tileEntries instanceof Map && tileEntries.size > 0) {
      for (const [tileId, data] of tileEntries.entries()) {
        const tileDoc = data?.tileDoc;
        const sprite = data?.sprite;
        if (!tileDoc || !sprite || sprite.userData?._removed) continue;
        if (sprite.visible === false) continue;

        const tileElevation = asNumber(tileDoc?.elevation, 0);
        if (tileElevation > (tokenElevation + 0.15)) continue;

        let inBounds = false;
        try {
          inBounds = !!tileManager?.isWorldPointInTileBounds?.(data, worldX, worldY);
        } catch (_) {
          inBounds = false;
        }
        if (!inBounds) continue;

        let opaque = true;
        if (typeof tileManager?.isWorldPointOpaque === 'function') {
          try {
            opaque = !!tileManager.isWorldPointOpaque(data, worldX, worldY);
          } catch (_) {
            opaque = true;
          }
        }
        if (!opaque) continue;

        const sortKey = asNumber(tileDoc?.sort ?? tileDoc?.z, 0);
        const tileSrc = String(tileDoc?.texture?.src || '');
        const fileName = tileSrc
          ? (tileSrc.split('/').pop() || '').split('?')[0]
          : '';
        const label = fileName || `Tile ${String(tileId || '')}`;

        if (!best
          || tileElevation > (best.elevation + 0.01)
          || (Math.abs(tileElevation - best.elevation) <= 0.01 && sortKey > best.sortKey)) {
          best = {
            type: 'tile',
            tileId: String(tileId || ''),
            tileDoc,
            elevation: tileElevation,
            sortKey,
            label
          };
        }
      }
    }

    if (best) return best;

    return {
      type: 'ground',
      tileId: '',
      tileDoc: null,
      elevation: 0,
      sortKey: Number.NEGATIVE_INFINITY,
      label: 'Ground'
    };
  }

  /**
   * @param {any} supportSurface
   * @returns {string}
   */
  _getFlyingSupportLabel(supportSurface) {
    if (!supportSurface || supportSurface.type !== 'tile') return 'Ground';
    const raw = String(supportSurface.label || supportSurface.tileId || 'Tile');
    return raw.length > 20 ? `${raw.slice(0, 17)}...` : raw;
  }

  /**
   * @param {any} state
   */
  _ensureFlyingIndicatorBadge(state) {
    if (!state?.groundGroup || state?.elevationBadgeSprite) return;

    const THREE = window.THREE;
    if (!THREE) return;

    const canvas = document.createElement('canvas');
    canvas.width = 768;
    canvas.height = 192;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    if (THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false
    });
    const badge = new THREE.Sprite(material);
    badge.name = `FlyingElevationBadge_${state.tokenId}`;
    badge.scale.set(120, 30, 1);
    badge.position.set(0, 0, 12);

    state.groundGroup.add(badge);
    state.elevationBadgeSprite = badge;
    state.elevationBadgeCanvas = canvas;
    state.elevationBadgeCtx = ctx;
    state.elevationBadgeTexture = texture;
  }

  /**
   * @param {any} state
   * @param {string} text
   */
  _drawFlyingIndicatorBadge(state, text) {
    if (!state) return;
    this._ensureFlyingIndicatorBadge(state);

    const canvas = state.elevationBadgeCanvas;
    const ctx = state.elevationBadgeCtx;
    const texture = state.elevationBadgeTexture;
    if (!canvas || !ctx || !texture) return;

    const safeText = String(text || '').trim();
    if (safeText === state.elevationBadgeText) return;
    state.elevationBadgeText = safeText;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = 'rgba(10, 11, 18, 0.72)';
    ctx.strokeStyle = 'rgba(170, 212, 255, 0.68)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.rect(12, 12, canvas.width - 24, canvas.height - 24);
    ctx.fill();
    ctx.stroke();

    ctx.font = 'bold 58px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.97)';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.lineWidth = 10;
    const x = canvas.width / 2;
    const y = canvas.height / 2;
    ctx.strokeText(safeText, x, y);
    ctx.fillText(safeText, x, y);

    texture.needsUpdate = true;
  }

  /**
   * @param {any} state
   * @param {number} tetherHeight
   */
  _updateFlyingTetherHeight(state, tetherHeight) {
    if (!state) return;

    const height = Math.max(2, asNumber(tetherHeight, 2));
    const line = state.tetherLine;

    if (line?.userData?.isFlyingTetherStick) {
      line.scale.z = height;
      line.position.z = height * 0.5;
      if (line.matrixAutoUpdate === false) line.updateMatrix();
    }

    const position = line?.geometry?.attributes?.position;
    if (position && position.count >= 2) {
      position.setXYZ(0, 0, 0, 0);
      position.setXYZ(1, 0, 0, height);
      position.needsUpdate = true;
      try {
        line.computeLineDistances?.();
      } catch (_) {
      }
    }

    if (state.elevationBadgeSprite) {
      state.elevationBadgeSprite.position.set(0, 0, height + 12);
    }
  }

  /**
   * Enter flying hover mode for a token. Creates ground indicator visuals
   * and begins the gentle rock animation in the update loop.
   *
   * @param {string} tokenId
   * @param {object} [opts]
   * @param {number} [opts.hoverHeight] - World-unit height above ground Z (default: ~0.35 grid)
   * @param {number} [opts.rockAmplitudeDeg] - Side-to-side rock in degrees (default: 3)
   * @param {number} [opts.rockSpeedHz] - Rock oscillation speed (default: 0.4)
   * @returns {boolean} true if entered, false if already flying or no sprite
   */
  setFlyingState(tokenId, opts = {}) {
    if (!tokenId) return false;
    if (this.flyingTokens.has(tokenId)) return false;

    const spriteData = this.tokenManager?.tokenSprites?.get(tokenId);
    const sprite = spriteData?.sprite;
    if (!sprite) return false;

    const grid = canvas?.grid;
    const gridSize = (grid?.size > 0) ? grid.size : 100;

    const hoverHeight = asNumber(opts.hoverHeight, gridSize * 0.35);
    const rockAmplitudeDeg = asNumber(opts.rockAmplitudeDeg, 3);
    const rockSpeedHz = asNumber(opts.rockSpeedHz, 0.4);

    // Create ground indicator group (line + circle under the token).
    const THREE = window.THREE;
    let groundGroup = null;
    let tetherLine = null;
    if (THREE) {
      groundGroup = new THREE.Group();
      groundGroup.name = `FlyingIndicator_${tokenId}`;

      // Shadow circle on ground plane
      const circleRadius = gridSize * 0.35;
      const circleGeo = new THREE.RingGeometry(circleRadius * 0.85, circleRadius, 32);
      const circleMat = new THREE.MeshBasicMaterial({
        color: 0x222222,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      const circle = new THREE.Mesh(circleGeo, circleMat);
      groundGroup.add(circle);

      // Vertical tether stick from ground to token. Use a mesh instead of
      // LineDashedMaterial so thickness is consistent across platforms.
      const tetherThickness = Math.max(2.5, circleRadius * 0.15);
      const lineGeo = new THREE.BoxGeometry(tetherThickness, tetherThickness, 1);
      const lineMat = new THREE.MeshBasicMaterial({
        color: 0x222222,
        transparent: true,
        opacity: 0.28,
        depthWrite: false
      });
      tetherLine = new THREE.Mesh(lineGeo, lineMat);
      tetherLine.userData = {
        ...(tetherLine.userData || {}),
        isFlyingTetherStick: true
      };
      tetherLine.scale.set(1, 1, Math.max(2, hoverHeight));
      tetherLine.position.set(0, 0, Math.max(2, hoverHeight) * 0.5);
      groundGroup.add(tetherLine);

      // Position at token base. We read the sprite's current XY and place
      // the indicator on the ground Z.
      const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
      groundGroup.position.set(sprite.position.x, sprite.position.y, groundZ + 0.5);
      groundGroup.matrixAutoUpdate = false;
      groundGroup.updateMatrix();

      // Add to scene
      const scene = this.tokenManager?.scene;
      if (scene) scene.add(groundGroup);
    }

    const state = {
      tokenId,
      sprite,
      groundGroup,
      tetherLine,
      styleId: 'flying-glide',
      hoverHeight,
      rockAmplitudeRad: (rockAmplitudeDeg * Math.PI) / 180,
      rockSpeedHz,
      baseZ: sprite.position.z,
      baseRotation: asNumber(sprite.material?.rotation, 0),
      elapsedSec: 0,
      supportSampleElapsed: 0,
      supportSurface: null,
      elevationBadgeSprite: null,
      elevationBadgeCanvas: null,
      elevationBadgeCtx: null,
      elevationBadgeTexture: null,
      elevationBadgeText: '',
      active: true
    };

    this.flyingTokens.set(tokenId, state);

    // Offset sprite upward immediately
    sprite.position.z = state.baseZ + hoverHeight;
    if (sprite.matrixAutoUpdate === false) sprite.updateMatrix();

    log.info(`Token ${tokenId} entered flying hover (height=${hoverHeight.toFixed(1)})`);
    return true;
  }

  /**
   * Exit flying hover mode for a token, removing indicators and snapping
   * the sprite back to its ground position.
   *
   * @param {string} tokenId
   * @returns {boolean} true if was flying and now cleared
   */
  clearFlyingState(tokenId) {
    const state = this.flyingTokens.get(tokenId);
    if (!state) return false;

    state.active = false;

    // Remove ground indicator
    if (state.groundGroup) {
      const scene = this.tokenManager?.scene;
      if (scene) scene.remove(state.groundGroup);
      state.groundGroup.traverse(child => {
        child.material?.map?.dispose?.();
        child.geometry?.dispose();
        child.material?.dispose();
      });
      state.groundGroup = null;
      state.tetherLine = null;
    }

    state.elevationBadgeSprite = null;
    state.elevationBadgeCanvas = null;
    state.elevationBadgeCtx = null;
    state.elevationBadgeTexture = null;
    state.elevationBadgeText = '';

    // Snap sprite back to base Z and rotation
    if (state.sprite && !state.sprite.userData?._removed) {
      state.sprite.position.z = state.baseZ;
      if (state.sprite.material) {
        state.sprite.material.rotation = state.baseRotation;
      }
      if (state.sprite.matrixAutoUpdate === false) state.sprite.updateMatrix();
    }

    this.flyingTokens.delete(tokenId);
    log.info(`Token ${tokenId} exited flying hover`);
    return true;
  }

  /**
   * Check if a token is currently in flying hover mode.
   * @param {string} tokenId
   * @returns {boolean}
   */
  isFlying(tokenId) {
    return this.flyingTokens.has(tokenId);
  }

  /**
   * Per-frame update for flying tokens: gentle rock animation, dynamic tether,
   * and elevation/support indicators.
   * @param {number} deltaSec
   * @private
   */
  _updateFlyingTokens(deltaSec) {
    if (this.flyingTokens.size === 0) return;

    for (const [tokenId, state] of this.flyingTokens) {
      if (!state.active) continue;
      const sprite = state.sprite;
      if (!sprite || sprite.userData?._removed) {
        this.clearFlyingState(tokenId);
        continue;
      }

      state.elapsedSec += deltaSec;

      // Gentle side-to-side rock using sine wave
      const rockAngle = Math.sin(state.elapsedSec * state.rockSpeedHz * Math.PI * 2) * state.rockAmplitudeRad;
      if (sprite.material) {
        sprite.material.rotation = state.baseRotation + rockAngle;
      }

      // Sync ground indicator position to follow token XY
      if (state.groundGroup) {
        const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
        const groundAnchorZ = groundZ + 0.5;
        state.groundGroup.position.set(sprite.position.x, sprite.position.y, groundAnchorZ);

        const tetherHeight = Math.max(2, sprite.position.z - groundAnchorZ);
        this._updateFlyingTetherHeight(state, tetherHeight);

        state.groundGroup.updateMatrix();
      }

      if (sprite.matrixAutoUpdate === false) sprite.updateMatrix();
    }
  }

  /**
   * @param {string} wallId
   * @returns {WallDocument|null}
   */
  _resolveWallDocument(wallId) {
    if (!wallId) return null;
    return canvas?.walls?.get?.(wallId)?.document
      ?? canvas?.scene?.walls?.get?.(wallId)
      ?? null;
  }

  /**
   * @param {WallDocument|null} wallDoc
   * @param {number} targetDoorState
   * @returns {boolean}
   */
  _canCurrentUserSetDoorState(wallDoc, targetDoorState) {
    if (!wallDoc) return false;

    const doorType = asNumber(wallDoc.door, DOOR_TYPES.NONE);
    if (doorType <= DOOR_TYPES.NONE) return false;

    if (game?.user?.isGM) return true;

    try {
      if (typeof wallDoc.canUserModify === 'function' && game?.user) {
        return !!wallDoc.canUserModify(game.user, 'update', {
          _id: wallDoc.id,
          ds: targetDoorState
        });
      }
    } catch (_) {
    }

    // Conservative fallback: players may only toggle unlocked normal doors.
    return _canPlayerOpenDoor(asNumber(wallDoc.ds, DOOR_STATES.CLOSED), doorType);
  }

  /**
   * Permission-safe door state update helper for movement choreography.
   *
   * @param {string} wallId
   * @param {number} targetDoorState
   * @param {object} [options]
   * @param {boolean} [options.silent=true]
   * @returns {Promise<{ok: boolean, wallId: string, requestedState: number, currentState: number|null, reason?: string}>}
   */
  async requestDoorStateByWallId(wallId, targetDoorState, { silent = true } = {}) {
    const wallDoc = this._resolveWallDocument(wallId);
    if (!wallDoc) {
      return {
        ok: false,
        wallId,
        requestedState: targetDoorState,
        currentState: null,
        reason: 'missing-door'
      };
    }

    const doorType = asNumber(wallDoc.door, DOOR_TYPES.NONE);
    const currentState = asNumber(wallDoc.ds, DOOR_STATES.CLOSED);

    if (doorType <= DOOR_TYPES.NONE) {
      return {
        ok: false,
        wallId: wallDoc.id,
        requestedState: targetDoorState,
        currentState,
        reason: 'not-a-door'
      };
    }

    if (currentState === targetDoorState) {
      return {
        ok: true,
        wallId: wallDoc.id,
        requestedState: targetDoorState,
        currentState
      };
    }

    if (targetDoorState === DOOR_STATES.OPEN && currentState === DOOR_STATES.LOCKED && !game?.user?.isGM) {
      return {
        ok: false,
        wallId: wallDoc.id,
        requestedState: targetDoorState,
        currentState,
        reason: 'locked'
      };
    }

    // When autoOpen + playerAutoDoorEnabled are both true, the movement system
    // acts as a "key" for players — bypass the core permission check so players
    // don't get stuck at unlocked doors simply because Foundry's WALL_DOOR
    // permission configuration would otherwise block them.
    const autoOpenBypassesPermission = this.settings.doorPolicy.autoOpen
      && this.settings.doorPolicy.playerAutoDoorEnabled;

    if (this.settings.doorPolicy.requireDoorPermission
      && !autoOpenBypassesPermission
      && !this._canCurrentUserSetDoorState(wallDoc, targetDoorState)) {
      return {
        ok: false,
        wallId: wallDoc.id,
        requestedState: targetDoorState,
        currentState,
        reason: 'permission-denied'
      };
    }

    try {
      await wallDoc.update({ ds: targetDoorState });
      return {
        ok: true,
        wallId: wallDoc.id,
        requestedState: targetDoorState,
        currentState: targetDoorState
      };
    } catch (error) {
      if (!silent) {
        this._pathfindingLog('warn', 'Door update failed for wall', {
          wallId: String(wallDoc?.id || ''),
          requestedState: targetDoorState,
          currentState,
          reason: 'update-failed'
        }, error);
      }
      return {
        ok: false,
        wallId: wallDoc.id,
        requestedState: targetDoorState,
        currentState,
        reason: 'update-failed'
      };
    }
  }

  /**
   * @param {string} wallId
   * @param {object} [options]
   */
  async requestDoorOpen(wallId, options = {}) {
    return this.requestDoorStateByWallId(wallId, DOOR_STATES.OPEN, options);
  }

  /**
   * @param {string} wallId
   * @param {object} [options]
   */
  async requestDoorClose(wallId, options = {}) {
    return this.requestDoorStateByWallId(wallId, DOOR_STATES.CLOSED, options);
  }

  /**
   * Wait until a wall reaches a target door state, or timeout.
   *
   * @param {string} wallId
   * @param {number} targetDoorState
   * @param {object} [options]
   * @param {number} [options.timeoutMs=1200]
   * @param {number} [options.pollIntervalMs=50]
   */
  async awaitDoorState(wallId, targetDoorState, { timeoutMs = 1200, pollIntervalMs = 50 } = {}) {
    const timeout = Math.max(0, asNumber(timeoutMs, 1200));
    const interval = clamp(asNumber(pollIntervalMs, 50), 10, 250);
    const endAt = Date.now() + timeout;

    while (Date.now() <= endAt) {
      const wallDoc = this._resolveWallDocument(wallId);
      if (!wallDoc) {
        return { ok: false, wallId, currentState: null, reason: 'missing-door' };
      }

      const ds = asNumber(wallDoc.ds, DOOR_STATES.CLOSED);
      if (ds === targetDoorState) {
        return { ok: true, wallId, currentState: ds };
      }

      await _sleep(interval);
    }

    const wallDoc = this._resolveWallDocument(wallId);
    return {
      ok: false,
      wallId,
      currentState: asNumber(wallDoc?.ds, DOOR_STATES.CLOSED),
      reason: 'timeout'
    };
  }

  /**
   * Execute only the OPEN half of a planned door step.
   * The movement sequencer can call this during PRE_DOOR_HOLD / REQUEST_DOOR_OPEN.
   *
   * @param {object} doorStep
   * @param {object} [options]
   * @param {boolean} [options.silent=true]
   * @param {number} [options.waitForOpenMs=1200]
   */
  async executeDoorStepOpen(doorStep, { silent = true, waitForOpenMs = 1200 } = {}) {
    const wallId = doorStep?.wallId;
    if (!wallId) return { ok: false, reason: 'missing-door-step' };
    if (!doorStep?.requiresOpen) return { ok: true, skipped: true, reason: 'no-open-required' };
    if (!this.settings.doorPolicy.autoOpen) return { ok: false, reason: 'auto-open-disabled' };

    const isGM = !!game?.user?.isGM;
    if (!isGM && !this.settings.doorPolicy.playerAutoDoorEnabled) {
      return { ok: false, reason: 'player-auto-door-disabled' };
    }

    if (doorStep?.canOpen === false) {
      return { ok: false, reason: doorStep?.blockedReason || 'permission-denied' };
    }

    const openResult = await this.requestDoorOpen(wallId, { silent });
    if (!openResult.ok) return openResult;

    return this.awaitDoorState(wallId, DOOR_STATES.OPEN, { timeoutMs: waitForOpenMs });
  }

  /**
   * Execute only the CLOSE half of a planned door step.
   * The movement sequencer can call this after CROSS_DOOR when policy allows.
   *
   * @param {object} doorStep
   * @param {object} [options]
   * @param {boolean} [options.silent=true]
   * @param {number} [options.waitForCloseMs=1200]
   */
  async executeDoorStepClose(doorStep, { silent = true, waitForCloseMs = 1200 } = {}) {
    const wallId = doorStep?.wallId;
    if (!wallId) return { ok: false, reason: 'missing-door-step' };
    if (!doorStep?.closeAfterCrossing) return { ok: true, skipped: true, reason: 'close-not-required' };

    const delayMs = Math.max(0, asNumber(this.settings.doorPolicy.closeDelayMs, 0));
    if (delayMs > 0) {
      await _sleep(delayMs);
    }

    const closeResult = await this.requestDoorClose(wallId, { silent });
    if (!closeResult.ok) return closeResult;

    return this.awaitDoorState(wallId, DOOR_STATES.CLOSED, { timeoutMs: waitForCloseMs });
  }

  /**
   * Build a door-aware plan and execute the door choreography runner against it.
   *
   * This is the first wiring contract for movement sequencing: callers provide
   * an optional moveToPoint callback which performs actual token movement to
   * hold/entry points while this manager handles door open/close sequencing.
   *
   * @param {object} params
   * @param {string} params.tokenId
   * @param {Array<{x:number,y:number}>} params.pathNodes
   * @param {(point: {x:number,y:number}, context: object) => Promise<object|boolean>|object|boolean} [params.moveToPoint]
   * @param {object} [params.options]
   * @returns {Promise<{ok: boolean, tokenId: string, transitions: Array<object>, failedStepIndex: number, reason?: string, plan: object}>}
   */
  async runDoorAwareMovementSequence({ tokenId, pathNodes, moveToPoint = null, options = {} } = {}) {
    const plan = this.buildDoorAwarePlan(pathNodes || []);
    const result = await this.runDoorStateMachineForPlan({
      tokenId,
      plan,
      moveToPoint,
      options
    });
    return {
      ...result,
      plan
    };
  }

  /**
   * Execute a full token movement with door choreography and real token-position
   * updates via Foundry document writes.
   *
   * Coordinate contract:
   * - destinationTopLeft is TokenDocument-space top-left x/y.
   * - internal door/path planning runs in Foundry center-point space.
   *
   * @param {object} params
   * @param {TokenDocument|object} params.tokenDoc
   * @param {{x:number,y:number}} params.destinationTopLeft
   * @param {object} [params.options]
   * @param {boolean} [params.options.ignoreWalls=false]
   * @param {boolean} [params.options.ignoreCost=false]
   * @param {string} [params.options.method='dragging']
   * @param {number} [params.options.perStepDelayMs=0]
   * @param {object} [params.options.updateOptions]
   * @returns {Promise<{ok:boolean, tokenId:string, reason?:string, transitions:Array<object>, plan?:object, pathNodes:Array<{x:number,y:number}>}>}
   */
  async executeDoorAwareTokenMove({ tokenDoc, destinationTopLeft, options = {} } = {}) {
    let tokenMoveLock = null;
    let tokenId = '';
    try {
      tokenId = String(tokenDoc?.id || '');
      if (!tokenId) {
        this._pathfindingLog('warn', 'executeDoorAwareTokenMove blocked: missing token id', {
          destinationTopLeft,
          options
        });
        return {
          ok: false,
          tokenId: '',
          reason: 'missing-token-id',
          transitions: [],
          pathNodes: []
        };
      }

      // Serialize per-token: wait for any in-flight move on this token to finish
      // before starting a new one. Safety timeout prevents infinite waits.
      tokenMoveLock = await this._acquireTokenMoveLock(tokenId);

      const destX = asNumber(destinationTopLeft?.x, NaN);
      const destY = asNumber(destinationTopLeft?.y, NaN);
      if (!Number.isFinite(destX) || !Number.isFinite(destY)) {
        this._pathfindingLog('warn', 'executeDoorAwareTokenMove blocked: invalid destination', {
          tokenId,
          destinationTopLeft,
          options
        });
        return {
          ok: false,
          tokenId,
          reason: 'invalid-destination',
          transitions: [],
          pathNodes: []
        };
      }

      const currentDoc = this._resolveTokenDocumentById(tokenId, tokenDoc);
      if (!currentDoc) {
        this._pathfindingLog('warn', 'executeDoorAwareTokenMove blocked: missing token document', {
          tokenId,
          destinationTopLeft,
          options
        });
        return {
          ok: false,
          tokenId,
          reason: 'missing-token-doc',
          transitions: [],
          pathNodes: []
        };
      }

      const ignoreWalls = optionsBoolean(options?.ignoreWalls, false);
      const ignoreCost = optionsBoolean(options?.ignoreCost, false);

      const targetTopLeft = this._snapTokenTopLeftToGrid({ x: destX, y: destY }, currentDoc);
      const startCenter = this._tokenTopLeftToCenter({ x: currentDoc.x, y: currentDoc.y }, currentDoc);
      const endCenter = this._tokenTopLeftToCenter(targetTopLeft, currentDoc);

      let pathNodes = [startCenter, endCenter];
      if (!ignoreWalls) {
        const pathResult = this.findWeightedPath({
          start: startCenter,
          end: endCenter,
          tokenDoc: currentDoc,
          options: {
            ignoreWalls,
            ignoreCost,
            fogPathPolicy: this.settings.fogPathPolicy,
            allowDiagonal: optionsBoolean(options?.allowDiagonal, true),
            maxSearchIterations: asNumber(options?.maxSearchIterations, 12000)
          }
        });

        const foundryPathResult = await this._computeFoundryParityPath({
          tokenDoc: currentDoc,
          startTopLeft: { x: currentDoc.x, y: currentDoc.y },
          endTopLeft: targetTopLeft,
          ignoreWalls,
          ignoreCost
        });

        const paritySelection = this._selectPathWithFoundryParity({
          customPathResult: pathResult,
          foundryPathResult,
          startCenter,
          endCenter,
          gridSize: asNumber(canvas?.grid?.size, 100),
          forceFoundryParity: optionsBoolean(options?.forceFoundryParity, false)
        });

        if (!paritySelection?.ok) {
          this._pathfindingLog('warn', 'executeDoorAwareTokenMove path selection failed', {
            token: this._pathfindingTokenMeta(currentDoc),
            destinationTopLeft: targetTopLeft,
            pathReason: pathResult?.reason || null,
            foundryPathReason: foundryPathResult?.reason || null,
            parityReason: paritySelection?.reason || 'no-path',
            pathDiagnostics: pathResult?.diagnostics || null,
            options
          });
          return {
            ok: false,
            tokenId,
            reason: paritySelection?.reason || 'no-path',
            transitions: [],
            pathNodes: []
          };
        }

        if (Array.isArray(paritySelection.pathNodes) && paritySelection.pathNodes.length >= 2) {
          pathNodes = paritySelection.pathNodes;
        }
      }

      const moveToPoint = async (point, context = {}) => {
        return this._moveTokenToFoundryPoint(tokenId, point, currentDoc, {
          ...options,
          ignoreWalls,
          ignoreCost
        }, context);
      };

      if (ignoreWalls) {
        const direct = await moveToPoint(endCenter, {
          tokenId,
          stepIndex: -1,
          phase: 'DIRECT_MOVE',
          plan: null
        });

        if (!direct?.ok) {
          this._pathfindingLog('warn', 'executeDoorAwareTokenMove direct move failed', {
            token: this._pathfindingTokenMeta(currentDoc),
            destinationTopLeft: targetTopLeft,
            reason: direct?.reason || 'direct-move-failed',
            options
          });
        }

        return {
          ok: !!direct?.ok,
          tokenId,
          reason: direct?.reason || null,
          transitions: [],
          plan: {
            pathNodes,
            doorSteps: [],
            doorRevision: this._doorStateRevision,
            inCombat: this._inCombat
          },
          pathNodes
        };
      }

      const sequenceResult = await this.runDoorAwareMovementSequence({
        tokenId,
        pathNodes,
        moveToPoint,
        options
      });

      if (!sequenceResult?.ok) {
        this._pathfindingLog('warn', 'executeDoorAwareTokenMove sequence failed', {
          token: this._pathfindingTokenMeta(currentDoc),
          destinationTopLeft: targetTopLeft,
          reason: sequenceResult?.reason || 'door-sequence-failed',
          transitionCount: Array.isArray(sequenceResult?.transitions) ? sequenceResult.transitions.length : 0,
          options
        });
        return {
          ok: false,
          tokenId,
          reason: sequenceResult?.reason || 'door-sequence-failed',
          transitions: sequenceResult?.transitions || [],
          plan: sequenceResult?.plan,
          pathNodes
        };
      }

      return {
        ok: true,
        tokenId,
        reason: null,
        transitions: sequenceResult.transitions || [],
        plan: sequenceResult.plan,
        pathNodes
      };
    } catch (error) {
      this._pathfindingLog('error', 'executeDoorAwareTokenMove threw unexpectedly', {
        tokenId,
        destinationTopLeft,
        options
      }, error);
      return {
        ok: false,
        tokenId,
        reason: 'token-move-exception',
        transitions: [],
        pathNodes: []
      };
    } finally {
      if (tokenId) this._releaseTokenMoveLock(tokenId, tokenMoveLock);
    }
  }

  /**
   * Compute a non-committing preview plan for coordinated group movement.
   *
   * This uses the same candidate generation and destination assignment logic as
   * executeDoorAwareGroupMove, but does not animate or update documents.
   *
   * @param {object} params
   * @param {Array<{tokenDoc: TokenDocument|object, destinationTopLeft: {x:number,y:number}}>} params.tokenMoves
   * @param {object} [params.options]
   * @returns {{ok:boolean, reason?:string, tokenCount:number, assignments?:Array<{tokenId:string,destinationTopLeft:{x:number,y:number},pathNodes:Array<{x:number,y:number}>,cost:number}>, stepCount?:number}}
   */
  computeDoorAwareGroupMovePreview({ tokenMoves = [], options = {} } = {}) {
    try {
      const moves = Array.isArray(tokenMoves) ? tokenMoves : [];
      if (moves.length === 0) {
        this._pathfindingLog('warn', 'computeDoorAwareGroupMovePreview blocked: missing group moves', {
          tokenMoves,
          options
        });
        return { ok: false, reason: 'missing-group-moves', tokenCount: 0 };
      }

      if (moves.length === 1) {
        const single = moves[0];
        const preview = this.computeTokenPathPreview({
          tokenDoc: single?.tokenDoc,
          destinationTopLeft: single?.destinationTopLeft,
          options
        });
        if (!preview?.ok) {
          this._pathfindingLog('warn', 'computeDoorAwareGroupMovePreview single-token preview failed', {
            tokenId: preview?.tokenId || String(single?.tokenDoc?.id || ''),
            reason: preview?.reason || 'single-group-preview-failed',
            destinationTopLeft: single?.destinationTopLeft,
            options
          });
          return {
            ok: false,
            reason: preview?.reason || 'single-group-preview-failed',
            tokenCount: 0,
            assignments: []
          };
        }

        const liveDoc = this._resolveTokenDocumentById(preview.tokenId, single?.tokenDoc);
        const snappedTopLeft = this._snapTokenTopLeftToGrid(single?.destinationTopLeft || { x: 0, y: 0 }, liveDoc || single?.tokenDoc);
        return {
          ok: true,
          tokenCount: 1,
          assignments: [{
            tokenId: preview.tokenId,
            destinationTopLeft: snappedTopLeft,
            pathNodes: preview.pathNodes.slice(),
            cost: asNumber(preview.distance, 0)
          }],
          stepCount: Math.max(0, (preview.pathNodes?.length || 1) - 1),
          groupPlanCacheKey: ''
        };
      }

      let planSource = 'computed';
      let planResult = this._planDoorAwareGroupMove({ tokenMoves: moves, options });
      let retryDiagnostics = null;

      if (!planResult?.ok) {
        const retryOptions = this._buildGroupPlanRetryOptions(options, planResult);
        if (retryOptions) {
          const retryStartMs = this._nowMs();
          const retryPlanResult = this._planDoorAwareGroupMove({ tokenMoves: moves, options: retryOptions });
          retryDiagnostics = {
            attempted: true,
            reason: planResult?.reason || 'group-plan-failed',
            retryMs: this._nowMs() - retryStartMs,
            options: {
              searchMarginPx: asNumber(retryOptions?.searchMarginPx, NaN),
              maxGraphNodes: asNumber(retryOptions?.maxGraphNodes, NaN),
              maxSearchIterations: asNumber(retryOptions?.maxSearchIterations, NaN),
              groupMaxCandidatesPerToken: asNumber(retryOptions?.groupMaxCandidatesPerToken, NaN),
              groupPathEvalCandidatesPerToken: asNumber(retryOptions?.groupPathEvalCandidatesPerToken, NaN),
              groupPlanningBudgetMs: asNumber(retryOptions?.groupPlanningBudgetMs, NaN),
              enforceAnchorSide: optionsBoolean(retryOptions?.enforceAnchorSide, false)
            },
            result: {
              ok: !!retryPlanResult?.ok,
              reason: retryPlanResult?.reason || null,
              metrics: retryPlanResult?.metrics || null
            }
          };

          if (retryPlanResult?.ok) {
            planResult = retryPlanResult;
            planSource = 'computed-retry-expanded';
          } else if (retryPlanResult) {
            planResult = retryPlanResult;
            planSource = 'computed-retry-failed';
          }
        }
      }

      if (!planResult.ok) {
        this._pathfindingLog('warn', 'computeDoorAwareGroupMovePreview plan failed', {
          reason: planResult.reason || 'group-plan-failed',
          tokenCount: planResult.tokenCount || 0,
          planSource,
          retryDiagnostics,
          requestedMoves: moves.length,
          options
        });
        return {
          ok: false,
          reason: planResult.reason || 'group-plan-failed',
          tokenCount: planResult.tokenCount || 0,
          assignments: [],
          diagnostics: {
            planSource,
            planning: planResult?.metrics || null,
            retry: retryDiagnostics
          }
        };
      }

      // If preview succeeded only after retrying with expanded options, avoid
      // caching the plan under the original signature; execute will compute and
      // retry as needed with full diagnostics.
      const groupPlanCacheKey = planSource === 'computed'
        ? this._storeGroupPlanCacheEntry({
          tokenMoves: moves,
          options,
          planResult
        })
        : '';

      return {
        ok: true,
        tokenCount: planResult.tokenCount,
        assignments: planResult.planEntries.map((entry) => ({
          tokenId: entry.tokenId,
          destinationTopLeft: entry.destinationTopLeft,
          pathNodes: Array.isArray(entry.pathNodes) ? entry.pathNodes.slice() : [],
          cost: asNumber(entry.cost, 0)
        })),
        stepCount: planResult.stepCount,
        groupPlanCacheKey,
        diagnostics: {
          planSource,
          planning: planResult?.metrics || null,
          retry: retryDiagnostics
        }
      };
    } catch (error) {
      this._pathfindingLog('error', 'computeDoorAwareGroupMovePreview threw unexpectedly', {
        tokenMoveCount: Array.isArray(tokenMoves) ? tokenMoves.length : 0,
        options
      }, error);
      return {
        ok: false,
        reason: 'group-preview-exception',
        tokenCount: 0,
        assignments: [],
        groupPlanCacheKey: ''
      };
    }
  }

  /**
   * Execute a coordinated group movement for multiple tokens.
   *
   * Behavior goals:
   * 1) Assign unique, nearby destination cells that minimize total travel cost.
   * 2) Respect wall/path constraints for each token path.
   * 3) Move tokens in synchronized steps while avoiding overlap and edge swaps.
   *
   * @param {object} params
   * @param {Array<{tokenDoc: TokenDocument|object, destinationTopLeft: {x:number,y:number}}>} params.tokenMoves
   * @param {object} [params.options]
   * @returns {Promise<{ok:boolean, reason?:string, tokenCount:number, assignments?:Array<object>, stepCount?:number}>}
   */
  async executeDoorAwareGroupMove({ tokenMoves = [], options = {} } = {}) {
    let groupMoveLock = null;

    // Signal any in-flight group move to stop at the next step boundary so
    // this new movement order can take over quickly instead of waiting for
    // the full previous animation to finish.
    if (this._activeGroupCancelToken) {
      this._activeGroupCancelToken.cancelled = true;
    }

    // Serialize group moves globally so two concurrent group operations
    // cannot interleave timeline steps and cause deadlocks.
    groupMoveLock = await this._acquireGroupMoveLock();

    // Create a fresh cancel token for this move. Any subsequent move call
    // will set .cancelled = true to interrupt our timeline.
    const groupCancelToken = { cancelled: false };
    this._activeGroupCancelToken = groupCancelToken;

    try {
      const totalStartMs = this._nowMs();
      const moves = Array.isArray(tokenMoves) ? tokenMoves : [];
      if (moves.length === 0) {
        this._pathfindingLog('warn', 'executeDoorAwareGroupMove blocked: missing group moves', {
          tokenMoves,
          options
        });
        return { ok: false, reason: 'missing-group-moves', tokenCount: 0 };
      }

      if (moves.length === 1) {
        const single = moves[0];
        const res = await this.executeDoorAwareTokenMove({
          tokenDoc: single?.tokenDoc,
          destinationTopLeft: single?.destinationTopLeft,
          options
        });
        if (!res?.ok) {
          this._pathfindingLog('warn', 'executeDoorAwareGroupMove single-token fallback failed', {
            tokenId: res?.tokenId || String(single?.tokenDoc?.id || ''),
            reason: res?.reason || 'single-group-move-failed',
            destinationTopLeft: single?.destinationTopLeft,
            options
          });
        }
        return {
          ok: !!res?.ok,
          reason: res?.reason || null,
          tokenCount: res?.tokenId ? 1 : 0,
          assignments: res?.tokenId ? [{ tokenId: res.tokenId, destinationTopLeft: single?.destinationTopLeft }] : [],
          stepCount: Array.isArray(res?.pathNodes) ? Math.max(0, res.pathNodes.length - 1) : 0
        };
      }
      let planSource = 'computed';
      let planResult = null;
      let retryDiagnostics = null;
      const cachedPlanKey = String(options?.groupPlanCacheKey || '');
      if (cachedPlanKey) {
        const cached = this._consumeGroupPlanCacheEntry(cachedPlanKey, {
          tokenMoves: moves,
          options
        });
        if (cached?.ok) {
          planResult = cached;
          planSource = 'preview-cache';
        }
      }

      if (!planResult) {
        planResult = this._planDoorAwareGroupMove({ tokenMoves: moves, options });
      }

      if (!planResult?.ok) {
        const retryOptions = this._buildGroupPlanRetryOptions(options, planResult);
        if (retryOptions) {
          const retryStartMs = this._nowMs();
          const retryPlanResult = this._planDoorAwareGroupMove({ tokenMoves: moves, options: retryOptions });
          retryDiagnostics = {
            attempted: true,
            reason: planResult?.reason || 'group-plan-failed',
            retryMs: this._nowMs() - retryStartMs,
            options: {
              searchMarginPx: asNumber(retryOptions?.searchMarginPx, NaN),
              maxGraphNodes: asNumber(retryOptions?.maxGraphNodes, NaN),
              maxSearchIterations: asNumber(retryOptions?.maxSearchIterations, NaN),
              groupMaxCandidatesPerToken: asNumber(retryOptions?.groupMaxCandidatesPerToken, NaN),
              groupPathEvalCandidatesPerToken: asNumber(retryOptions?.groupPathEvalCandidatesPerToken, NaN),
              groupPlanningBudgetMs: asNumber(retryOptions?.groupPlanningBudgetMs, NaN),
              enforceAnchorSide: optionsBoolean(retryOptions?.enforceAnchorSide, false)
            },
            result: {
              ok: !!retryPlanResult?.ok,
              reason: retryPlanResult?.reason || null,
              metrics: retryPlanResult?.metrics || null
            }
          };

          if (retryPlanResult?.ok) {
            planResult = retryPlanResult;
            planSource = `${planSource}-retry-expanded`;
          } else if (retryPlanResult) {
            planResult = retryPlanResult;
            planSource = `${planSource}-retry-failed`;
          }
        }
      }

      if (!planResult.ok) {
        this._pathfindingLog('warn', 'executeDoorAwareGroupMove planning failed', {
          reason: planResult.reason || 'group-plan-failed',
          tokenCount: planResult.tokenCount || 0,
          planSource,
          retryDiagnostics,
          requestedMoves: moves.length,
          options
        });
        return {
          ok: false,
          reason: planResult.reason || 'group-plan-failed',
          tokenCount: planResult.tokenCount || 0,
          diagnostics: {
            planSource,
            planning: planResult?.metrics || null,
            retry: retryDiagnostics,
            totalMs: this._nowMs() - totalStartMs
          }
        };
      }

      const planEntries = planResult.planEntries;
      const ignoreWalls = planResult.ignoreWalls;
      const ignoreCost = planResult.ignoreCost;

      const timelineBuildStartMs = this._nowMs();
      const timelineResult = this._buildGroupMovementTimeline(planEntries, options);
      const timelineBuildMs = this._nowMs() - timelineBuildStartMs;

      const baseDiagnostics = {
        planSource,
        planning: planResult?.metrics || null,
        retry: retryDiagnostics,
        timelineBuildMs,
        totalMs: this._nowMs() - totalStartMs
      };

      if (!timelineResult.ok) {
        this._pathfindingLog('warn', 'executeDoorAwareGroupMove timeline build failed', {
          reason: timelineResult.reason || 'group-timeline-failed',
          tokenCount: planResult.tokenCount,
          planSource,
          timelineDiagnostics: timelineResult?.diagnostics || null,
          options
        });

        // Recovery path: if synchronized scheduling deadlocks, attempt to
        // finish tokens sequentially to their assigned endpoints.
        const reconciledAfterTimelineBuildFailure = await this._reconcileGroupFinalPositions(planEntries, {
          ...options,
          ignoreWalls,
          ignoreCost,
          method: options?.method || 'path-walk'
        });
        if (reconciledAfterTimelineBuildFailure.ok) {
          this._pathfindingLog('warn', 'executeDoorAwareGroupMove recovered after timeline build failure via final reconciliation', {
            reason: timelineResult.reason || 'group-timeline-failed',
            tokenCount: planResult.tokenCount,
            timelineDiagnostics: timelineResult?.diagnostics || null,
            correctedCount: reconciledAfterTimelineBuildFailure.correctedCount,
            options
          });
          return {
            ok: true,
            tokenCount: planResult.tokenCount,
            assignments: planEntries.map((p) => ({ tokenId: p.tokenId, destinationTopLeft: p.destinationTopLeft })),
            stepCount: 0,
            reconciled: true,
            correctedCount: reconciledAfterTimelineBuildFailure.correctedCount,
            deadlockRecovered: true,
            diagnostics: {
              ...baseDiagnostics,
              timeline: timelineResult?.diagnostics || null,
              reconciliation: {
                correctedCount: asNumber(reconciledAfterTimelineBuildFailure.correctedCount, 0)
              }
            }
          };
        }

        return {
          ok: false,
          reason: timelineResult.reason || 'group-timeline-failed',
          tokenCount: planResult.tokenCount,
          diagnostics: {
            ...baseDiagnostics,
            timeline: timelineResult?.diagnostics || null,
            reconciliation: {
              reason: reconciledAfterTimelineBuildFailure?.reason || 'group-final-reconcile-failed',
              correctedCount: asNumber(reconciledAfterTimelineBuildFailure?.correctedCount, 0),
              remainingCount: asNumber(reconciledAfterTimelineBuildFailure?.remainingCount, NaN),
              remainingDetails: Array.isArray(reconciledAfterTimelineBuildFailure?.remainingDetails)
                ? reconciledAfterTimelineBuildFailure.remainingDetails
                : []
            }
          }
        };
      }

      const timelineExecuteStartMs = this._nowMs();
      const execution = await this._executeGroupTimeline(planEntries, timelineResult.timelineByTokenId, {
        ...options,
        ignoreWalls,
        ignoreCost,
        method: options?.method || 'path-walk',
        suppressFoundryMovementUI: options?.suppressFoundryMovementUI !== false,
        _groupCancelToken: groupCancelToken
      });
      const timelineExecuteMs = this._nowMs() - timelineExecuteStartMs;

      if (!execution.ok) {
        // If interrupted by a new movement order, skip reconciliation —
        // tokens are at valid intermediate positions and the new move will
        // re-plan from their current locations.
        if (execution.reason === 'interrupted-by-new-move') {
          this._pathfindingLog('info', 'executeDoorAwareGroupMove interrupted — skipping reconciliation', {
            tokenCount: planResult.tokenCount,
            planSource,
            timelineExecuteMs
          });
          return {
            ok: false,
            reason: 'interrupted-by-new-move',
            tokenCount: planResult.tokenCount,
            assignments: planEntries.map((p) => ({ tokenId: p.tokenId, destinationTopLeft: p.destinationTopLeft })),
            diagnostics: {
              ...baseDiagnostics,
              timelineExecuteMs,
              totalMs: this._nowMs() - totalStartMs
            }
          };
        }

        this._pathfindingLog('warn', 'executeDoorAwareGroupMove timeline execution failed', {
          reason: execution.reason || 'group-execution-failed',
          tokenCount: planResult.tokenCount,
          planSource,
          options
        });

        const reconciledAfterFailure = await this._reconcileGroupFinalPositions(planEntries, {
          ...options,
          ignoreWalls,
          ignoreCost
        });
        if (reconciledAfterFailure.ok) {
          this._pathfindingLog('warn', 'executeDoorAwareGroupMove recovered by final reconciliation after execution failure', {
            tokenCount: planResult.tokenCount,
            stepCount: timelineResult.stepCount,
            options
          });
          return {
            ok: true,
            tokenCount: planResult.tokenCount,
            assignments: planEntries.map((p) => ({ tokenId: p.tokenId, destinationTopLeft: p.destinationTopLeft })),
            stepCount: timelineResult.stepCount,
            reconciled: true,
            diagnostics: {
              ...baseDiagnostics,
              timelineExecuteMs,
              totalMs: this._nowMs() - totalStartMs
            }
          };
        }

        return {
          ok: false,
          reason: execution.reason || 'group-execution-failed',
          tokenCount: planResult.tokenCount,
          assignments: planEntries.map((p) => ({ tokenId: p.tokenId, destinationTopLeft: p.destinationTopLeft })),
          diagnostics: {
            ...baseDiagnostics,
            timelineExecuteMs,
            totalMs: this._nowMs() - totalStartMs
          }
        };
      }

      const reconcileStartMs = this._nowMs();
      const reconciliation = await this._reconcileGroupFinalPositions(planEntries, {
        ...options,
        ignoreWalls,
        ignoreCost
      });
      const reconcileMs = this._nowMs() - reconcileStartMs;
      if (!reconciliation.ok) {
        this._pathfindingLog('warn', 'executeDoorAwareGroupMove final reconciliation failed', {
          reason: reconciliation.reason || 'group-final-reconcile-failed',
          tokenCount: planResult.tokenCount,
          planSource,
          options
        });
        return {
          ok: false,
          reason: reconciliation.reason || 'group-final-reconcile-failed',
          tokenCount: planResult.tokenCount,
          assignments: planEntries.map((p) => ({ tokenId: p.tokenId, destinationTopLeft: p.destinationTopLeft })),
          diagnostics: {
            ...baseDiagnostics,
            timelineExecuteMs,
            reconcileMs,
            totalMs: this._nowMs() - totalStartMs
          }
        };
      }

      return {
        ok: true,
        tokenCount: planResult.tokenCount,
        assignments: planEntries.map((p) => ({ tokenId: p.tokenId, destinationTopLeft: p.destinationTopLeft })),
        stepCount: timelineResult.stepCount,
        reconciled: reconciliation.correctedCount > 0,
        correctedCount: reconciliation.correctedCount,
        diagnostics: {
          ...baseDiagnostics,
          timelineExecuteMs,
          reconcileMs,
          totalMs: this._nowMs() - totalStartMs
        }
      };
    } catch (error) {
      this._pathfindingLog('error', 'executeDoorAwareGroupMove threw unexpectedly', {
        requestedMoveCount: Array.isArray(tokenMoves) ? tokenMoves.length : 0,
        options
      }, error);
      return {
        ok: false,
        reason: 'group-move-exception',
        tokenCount: 0,
        assignments: []
      };
    } finally {
      // Only clear if this is still the active token (not already superseded
      // by another move that set a new cancel token).
      if (this._activeGroupCancelToken === groupCancelToken) {
        this._activeGroupCancelToken = null;
      }
      this._releaseGroupMoveLock(groupMoveLock);
    }
  }

  /**
   * Build coordinated destination/path plans for group movement.
   *
   * @param {object} params
   * @param {Array<{tokenDoc: TokenDocument|object, destinationTopLeft: {x:number,y:number}}>} params.tokenMoves
   * @param {object} [params.options]
   * @returns {{ok:boolean, reason?:string, tokenCount:number, planEntries?:Array<{tokenId:string, tokenDoc:any, pathNodes:Array<{x:number,y:number}>, destinationTopLeft:{x:number,y:number}, cost:number}>, ignoreWalls?:boolean, ignoreCost?:boolean, stepCount?:number}}
   */
  _planDoorAwareGroupMove({ tokenMoves = [], options = {} } = {}) {
    const planningStartMs = this._nowMs();
    const moves = Array.isArray(tokenMoves) ? tokenMoves : [];
    if (moves.length === 0) {
      this._pathfindingLog('warn', '_planDoorAwareGroupMove blocked: missing group moves', {
        tokenMoves,
        options
      });
      return {
        ok: false,
        reason: 'missing-group-moves',
        tokenCount: 0,
        metrics: {
          planningMs: this._nowMs() - planningStartMs,
          tokenCount: 0
        }
      };
    }

    const ignoreWalls = optionsBoolean(options?.ignoreWalls, false);
    const ignoreCost = optionsBoolean(options?.ignoreCost, false);

    /** @type {Array<{tokenId:string, tokenDoc:any, startTopLeft:{x:number,y:number}, desiredTopLeft:{x:number,y:number}, startCenter:{x:number,y:number}, desiredCenter:{x:number,y:number}, size:{widthPx:number,heightPx:number}}>} */
    const entries = [];
    for (const move of moves) {
      const inputDoc = move?.tokenDoc;
      const tokenId = String(inputDoc?.id || move?._id || '');
      if (!tokenId) continue;

      const liveDoc = this._resolveTokenDocumentById(tokenId, inputDoc);
      if (!liveDoc) continue;

      const destX = asNumber(move?.destinationTopLeft?.x, NaN);
      const destY = asNumber(move?.destinationTopLeft?.y, NaN);
      if (!Number.isFinite(destX) || !Number.isFinite(destY)) continue;

      const startTopLeft = {
        x: asNumber(liveDoc?.x, 0),
        y: asNumber(liveDoc?.y, 0)
      };
      const desiredTopLeft = this._snapTokenTopLeftToGrid({ x: destX, y: destY }, liveDoc);
      const startCenter = this._tokenTopLeftToCenter(startTopLeft, liveDoc);
      const desiredCenter = this._tokenTopLeftToCenter(desiredTopLeft, liveDoc);

      entries.push({
        tokenId,
        tokenDoc: liveDoc,
        startTopLeft,
        desiredTopLeft,
        startCenter,
        desiredCenter,
        size: this._getTokenPixelSize(liveDoc)
      });
    }

    if (entries.length < 2) {
      this._pathfindingLog('warn', '_planDoorAwareGroupMove blocked: insufficient live token entries', {
        requestedMoves: moves.length,
        resolvedEntries: entries.length,
        options
      });
      return {
        ok: false,
        reason: 'insufficient-group-tokens',
        tokenCount: entries.length,
        metrics: {
          planningMs: this._nowMs() - planningStartMs,
          tokenCount: entries.length
        }
      };
    }

    const pathfindingStatsCollector = this._createPathfindingStatsCollector();
    const candidateGenerationMsByToken = {};
    const candidateCountByToken = {};

    // Eagerly warm caches so every findWeightedPath call during candidate
    // evaluation hits precomputed data instead of rebuilding from scratch.
    if (!ignoreWalls) {
      this._buildHpaSectorIndex();
      // Build HPA adjacency and full-scene nav graphs for each unique token
      // size in the group. The scene nav graph is the primary acceleration —
      // it lets findWeightedPath skip generateMovementGraph entirely and run
      // A* directly on the cached adjacency.
      const seenSizeKeys = new Set();
      for (const entry of entries) {
        const w = Math.max(1, Math.round(asNumber(entry.tokenDoc?.width, 1)));
        const h = Math.max(1, Math.round(asNumber(entry.tokenDoc?.height, 1)));
        const sizeKey = `${w}x${h}`;
        if (seenSizeKeys.has(sizeKey)) continue;
        seenSizeKeys.add(sizeKey);
        this._buildHpaAdjacency({
          tokenDoc: entry.tokenDoc,
          options: { allowDiagonal: true, collisionMode: options?.collisionMode || 'closest' }
        });
        this._getOrBuildSceneNavGraph(entry.tokenDoc, {
          collisionMode: options?.collisionMode || 'closest'
        });
      }
    }

    const adaptiveDefaults = this._getAdaptiveGroupCandidateDefaults(entries.length);
    const candidateOptions = {
      ...options,
      groupMaxRadiusCells: Number.isFinite(Number(options?.groupMaxRadiusCells))
        ? Math.round(asNumber(options?.groupMaxRadiusCells, adaptiveDefaults.maxRadiusCells))
        : adaptiveDefaults.maxRadiusCells,
      groupMaxCandidatesPerToken: Number.isFinite(Number(options?.groupMaxCandidatesPerToken))
        ? Math.round(asNumber(options?.groupMaxCandidatesPerToken, adaptiveDefaults.maxCandidatesPerToken))
        : adaptiveDefaults.maxCandidatesPerToken,
      groupPathEvalCandidatesPerToken: Number.isFinite(Number(options?.groupPathEvalCandidatesPerToken))
        ? Math.round(asNumber(options?.groupPathEvalCandidatesPerToken, adaptiveDefaults.pathEvalCandidates))
        : adaptiveDefaults.pathEvalCandidates,
      groupBudgetMinCandidatesPerToken: Number.isFinite(Number(options?.groupBudgetMinCandidatesPerToken))
        ? Math.round(asNumber(options?.groupBudgetMinCandidatesPerToken, Math.min(adaptiveDefaults.maxCandidatesPerToken, adaptiveDefaults.pathEvalCandidates)))
        : Math.min(adaptiveDefaults.maxCandidatesPerToken, adaptiveDefaults.pathEvalCandidates)
    };

    // Use a larger planning budget for long-distance group moves where HPA
    // coarse routing is likely to trigger multi-segment local refinement.
    const anchorEntryTemp = entries.find((entry) => entry.tokenId === String(options?.groupAnchorTokenId || '')) || entries[0];
    const groupTravelDistance = Math.hypot(
      asNumber(anchorEntryTemp?.desiredCenter?.x, 0) - asNumber(anchorEntryTemp?.startCenter?.x, 0),
      asNumber(anchorEntryTemp?.desiredCenter?.y, 0) - asNumber(anchorEntryTemp?.startCenter?.y, 0)
    );
    const gridSize = Math.max(1, asNumber(canvas?.grid?.size, asNumber(canvas?.dimensions?.size, 100)));
    const isLongDistance = groupTravelDistance >= gridSize * 10;
    const baseBudgetMs = asNumber(options?.groupPlanningBudgetMs, 280);
    const effectiveBudgetMs = isLongDistance
      ? clamp(Math.max(baseBudgetMs, baseBudgetMs * 1.6), 0, 5000)
      : clamp(baseBudgetMs, 0, 5000);

    const planBudget = {
      startMs: planningStartMs,
      budgetMs: effectiveBudgetMs,
      triggered: false,
      overrunMs: 0
    };

    const requestedAnchorId = String(options?.groupAnchorTokenId || '');
    const anchorEntry = entries.find((entry) => entry.tokenId === requestedAnchorId) || entries[0];
    const rawAnchorTopLeft = {
      x: asNumber(options?.groupAnchorTopLeft?.x, anchorEntry?.desiredTopLeft?.x),
      y: asNumber(options?.groupAnchorTopLeft?.y, anchorEntry?.desiredTopLeft?.y)
    };
    const anchorTopLeft = this._snapTokenTopLeftToGrid(rawAnchorTopLeft, anchorEntry.tokenDoc);
    const anchorCenter = this._tokenTopLeftToCenter(anchorTopLeft, anchorEntry.tokenDoc);
    const anchor = {
      tokenDoc: anchorEntry.tokenDoc,
      topLeft: anchorTopLeft,
      center: anchorCenter,
      enforceAnchorSide: optionsBoolean(options?.enforceAnchorSide, false)
    };

    const relaxedAnchorTokenIds = new Set();
    if (anchor.enforceAnchorSide && !ignoreWalls) {
      for (const entry of entries) {
        if (entry.tokenId === anchorEntry.tokenId) continue;

        const anchorProbe = this.findWeightedPath({
          start: entry.startCenter,
          end: anchor.center,
          tokenDoc: entry.tokenDoc,
          options: {
            ignoreWalls: false,
            ignoreCost,
            allowDiagonal: optionsBoolean(candidateOptions?.allowDiagonal, true),
            fogPathPolicy: candidateOptions?.fogPathPolicy || this.settings.fogPathPolicy,
            maxSearchIterations: Math.min(4000, Math.max(256, asNumber(candidateOptions?.maxSearchIterations, 12000))),
            suppressNoPathLog: true,
            statsCollector: pathfindingStatsCollector
          }
        });

        if (!anchorProbe?.ok) {
          const graphDiagnostics = anchorProbe?.diagnostics?.graphDiagnostics || null;
          const looksDisconnected = String(anchorProbe?.reason || '') === 'no-path'
            && graphDiagnostics
            && !optionsBoolean(graphDiagnostics?.truncated, false)
            && asNumber(graphDiagnostics?.nodeCount, 0) <= 28;

          if (looksDisconnected) {
            relaxedAnchorTokenIds.add(entry.tokenId);
          }
        }
      }
    }

    let sharedCorridorPath = [];
    let sharedCorridorAdaptiveExpansionUsed = false;
    if (!ignoreWalls) {
      const sharedCorridorResult = this._findWeightedPathWithAdaptiveExpansion({
        start: anchorEntry.startCenter,
        end: anchor.center,
        tokenDoc: anchorEntry.tokenDoc,
        options: {
          ignoreWalls: false,
          ignoreCost,
          allowDiagonal: optionsBoolean(candidateOptions?.allowDiagonal, true),
          fogPathPolicy: candidateOptions?.fogPathPolicy || this.settings.fogPathPolicy,
          maxSearchIterations: asNumber(candidateOptions?.maxSearchIterations, 12000),
          suppressNoPathLog: true,
          statsCollector: pathfindingStatsCollector
        },
        preferLongRange: true
      });

      if (sharedCorridorResult?.ok && Array.isArray(sharedCorridorResult.pathNodes) && sharedCorridorResult.pathNodes.length >= 2) {
        sharedCorridorPath = sharedCorridorResult.pathNodes.slice();
        sharedCorridorAdaptiveExpansionUsed = !!sharedCorridorResult?.adaptiveExpansionUsed;
      }
    }

    const formationSlotsByTokenId = this._buildGroupFormationSlots(entries, anchor.center, candidateOptions);

    const movingIds = new Set(entries.map((e) => e.tokenId));
    const staticRects = this._collectStaticTokenOccupancyRects(movingIds);

    /** @type {Map<string, Array<{topLeft:{x:number,y:number}, center:{x:number,y:number}, rect:{x:number,y:number,w:number,h:number}, key:string, pathNodes:Array<{x:number,y:number}>, cost:number}>>} */
    const candidateMap = new Map();
    for (const entry of entries) {
      const candidateStartMs = this._nowMs();
      const candidates = this._buildGroupMoveCandidates(entry, {
        entries,
        staticRects,
        anchor,
        ignoreWalls,
        ignoreCost,
        options: candidateOptions,
        planBudget,
        relaxedAnchorTokenIds,
        formationSlotsByTokenId,
        sharedCorridorPath,
        sharedCorridorTokenId: anchorEntry.tokenId,
        statsCollector: pathfindingStatsCollector
      });
      candidateGenerationMsByToken[entry.tokenId] = this._nowMs() - candidateStartMs;
      candidateCountByToken[entry.tokenId] = candidates.length;
      candidateMap.set(entry.tokenId, candidates);
      if (candidates.length === 0) {
        this._pathfindingLog('warn', '_planDoorAwareGroupMove found no candidates for token', {
          tokenId: entry.tokenId,
          token: this._pathfindingTokenMeta(entry.tokenDoc),
          desiredTopLeft: entry.desiredTopLeft,
          anchorTopLeft: anchor.topLeft,
          anchorSideRelaxed: relaxedAnchorTokenIds.has(entry.tokenId),
          sharedCorridorNodes: Array.isArray(sharedCorridorPath) ? sharedCorridorPath.length : 0,
          ignoreWalls,
          ignoreCost,
          options
        });
        return {
          ok: false,
          reason: `no-group-candidate-${entry.tokenId}`,
          tokenCount: entries.length,
          metrics: {
            planningMs: this._nowMs() - planningStartMs,
            tokenCount: entries.length,
            budgetMs: planBudget.budgetMs,
            budgetTriggered: !!planBudget.triggered,
            budgetOverrunMs: asNumber(planBudget.overrunMs, 0),
            candidateGenerationMsByToken,
            candidateCountByToken,
            anchorSideRelaxedTokenIds: Array.from(relaxedAnchorTokenIds),
            formationSlotCount: formationSlotsByTokenId.size,
            sharedCorridor: {
              used: Array.isArray(sharedCorridorPath) && sharedCorridorPath.length >= 2,
              nodeCount: Array.isArray(sharedCorridorPath) ? sharedCorridorPath.length : 0,
              adaptiveExpansionUsed: !!sharedCorridorAdaptiveExpansionUsed
            },
            totalCandidates: Object.values(candidateCountByToken).reduce((sum, count) => sum + asNumber(count, 0), 0),
            pathfinding: this._summarizePathfindingStats(pathfindingStatsCollector)
          }
        };
      }
    }

    const assignmentStartMs = this._nowMs();
    const assignmentResult = this._assignGroupDestinations(entries, candidateMap, candidateOptions);
    const assignmentMs = this._nowMs() - assignmentStartMs;
    if (!assignmentResult.ok) {
      this._pathfindingLog('warn', '_planDoorAwareGroupMove assignment failed', {
        reason: assignmentResult.reason || 'group-assignment-failed',
        tokenCount: entries.length,
        options: candidateOptions
      });
      return {
        ok: false,
        reason: assignmentResult.reason || 'group-assignment-failed',
        tokenCount: entries.length,
        metrics: {
          planningMs: this._nowMs() - planningStartMs,
          tokenCount: entries.length,
          assignmentMs,
          budgetMs: planBudget.budgetMs,
          budgetTriggered: !!planBudget.triggered,
          budgetOverrunMs: asNumber(planBudget.overrunMs, 0),
          candidateGenerationMsByToken,
          candidateCountByToken,
          anchorSideRelaxedTokenIds: Array.from(relaxedAnchorTokenIds),
          formationSlotCount: formationSlotsByTokenId.size,
          sharedCorridor: {
            used: Array.isArray(sharedCorridorPath) && sharedCorridorPath.length >= 2,
            nodeCount: Array.isArray(sharedCorridorPath) ? sharedCorridorPath.length : 0,
            adaptiveExpansionUsed: !!sharedCorridorAdaptiveExpansionUsed
          },
          totalCandidates: Object.values(candidateCountByToken).reduce((sum, count) => sum + asNumber(count, 0), 0),
          pathfinding: this._summarizePathfindingStats(pathfindingStatsCollector)
        }
      };
    }

    const planEntries = entries.map((entry) => {
      const assigned = assignmentResult.assignments.get(entry.tokenId);
      return {
        tokenId: entry.tokenId,
        tokenDoc: entry.tokenDoc,
        pathNodes: Array.isArray(assigned?.pathNodes) ? assigned.pathNodes.slice() : [entry.startCenter, entry.desiredCenter],
        destinationTopLeft: assigned?.topLeft || entry.desiredTopLeft,
        cost: asNumber(assigned?.cost, 0)
      };
    });

    // Post-assignment coherence pass: detect tokens whose paths significantly
    // diverge from the group's shared corridor (e.g. 4 tokens go left around
    // a wall but 1 goes right) and re-route outliers through the corridor
    // so the entire group travels together.
    let outlierFixDiagnostics = null;
    if (!ignoreWalls && sharedCorridorPath.length >= 3 && planEntries.length >= 3) {
      const outlierResult = this._fixGroupPathOutliers(planEntries, sharedCorridorPath, {
        ignoreWalls,
        ignoreCost,
        allowDiagonal: optionsBoolean(candidateOptions?.allowDiagonal, true),
        fogPathPolicy: candidateOptions?.fogPathPolicy || this.settings.fogPathPolicy
      });
      outlierFixDiagnostics = {
        fixedCount: outlierResult.fixedCount,
        outlierTokenIds: outlierResult.diagnostics?.outlierTokenIds || [],
        fixedTokenIds: outlierResult.diagnostics?.fixedTokenIds || []
      };
    }

    return {
      ok: true,
      tokenCount: entries.length,
      planEntries,
      ignoreWalls,
      ignoreCost,
      stepCount: Math.max(0, ...planEntries.map((entry) => Math.max(0, (entry.pathNodes?.length || 1) - 1))),
      metrics: {
        planningMs: this._nowMs() - planningStartMs,
        tokenCount: entries.length,
        assignmentMs,
        budgetMs: planBudget.budgetMs,
        budgetTriggered: !!planBudget.triggered,
        budgetOverrunMs: asNumber(planBudget.overrunMs, 0),
        candidateGenerationMsByToken,
        candidateCountByToken,
        anchorSideRelaxedTokenIds: Array.from(relaxedAnchorTokenIds),
        formationSlotCount: formationSlotsByTokenId.size,
        sharedCorridor: {
          used: Array.isArray(sharedCorridorPath) && sharedCorridorPath.length >= 2,
          nodeCount: Array.isArray(sharedCorridorPath) ? sharedCorridorPath.length : 0,
          adaptiveExpansionUsed: !!sharedCorridorAdaptiveExpansionUsed
        },
        outlierFix: outlierFixDiagnostics,
        totalCandidates: Object.values(candidateCountByToken).reduce((sum, count) => sum + asNumber(count, 0), 0),
        pathfinding: this._summarizePathfindingStats(pathfindingStatsCollector)
      }
    };
  }

  /**
   * @param {{tokenId:string, tokenDoc:any, startTopLeft:{x:number,y:number}, desiredTopLeft:{x:number,y:number}, startCenter:{x:number,y:number}, desiredCenter:{x:number,y:number}, size:{widthPx:number,heightPx:number}}} entry
   * @param {{entries:Array<object>, staticRects:Array<{x:number,y:number,w:number,h:number}>, anchor?:{tokenDoc:any, topLeft:{x:number,y:number}, center:{x:number,y:number}, enforceAnchorSide:boolean}, ignoreWalls:boolean, ignoreCost:boolean, options:object, relaxedAnchorTokenIds?:Set<string>, formationSlotsByTokenId?:Map<string,{x:number,y:number,ring:number,angle:number}>, sharedCorridorPath?:Array<{x:number,y:number}>, sharedCorridorTokenId?:string}} context
   * @returns {Array<{topLeft:{x:number,y:number}, center:{x:number,y:number}, rect:{x:number,y:number,w:number,h:number}, key:string, pathNodes:Array<{x:number,y:number}>, cost:number}>}
   */
  _buildGroupMoveCandidates(entry, context) {
    const grid = canvas?.grid;
    const gridSize = Math.max(1, asNumber(grid?.size, asNumber(canvas?.dimensions?.size, 100)));
    const stepX = Math.max(1, asNumber(grid?.sizeX, gridSize));
    const stepY = Math.max(1, asNumber(grid?.sizeY, gridSize));

    const adaptiveDefaults = this._getAdaptiveGroupCandidateDefaults(context?.entries?.length || 1);
    const maxRadiusCells = clamp(
      Math.round(asNumber(context?.options?.groupMaxRadiusCells, adaptiveDefaults.maxRadiusCells)),
      0,
      16
    );
    const maxCandidates = clamp(
      Math.round(asNumber(context?.options?.groupMaxCandidatesPerToken, adaptiveDefaults.maxCandidatesPerToken)),
      4,
      60
    );

    // When an anchor point exists (right-click group move), generate candidates
    // centered on the anchor rather than each token's individual desired position.
    // This produces much tighter clustering near the click point.
    const hasAnchor = !!(context?.anchor?.topLeft);
    const searchOriginTopLeft = hasAnchor
      ? context.anchor.topLeft
      : entry.desiredTopLeft;

    const seen = new Set();
    const coarseCandidates = [];
    const candidates = [];
    const budgetCandidateFloor = clamp(
      Math.round(asNumber(context?.options?.groupBudgetMinCandidatesPerToken, 8)),
      4,
      maxCandidates
    );

    const pathEvalCandidatesLimit = clamp(
      Math.round(asNumber(context?.options?.groupPathEvalCandidatesPerToken, Math.min(maxCandidates, adaptiveDefaults.pathEvalCandidates))),
      4,
      maxCandidates
    );

    const formationSlots = context?.formationSlotsByTokenId instanceof Map
      ? context.formationSlotsByTokenId
      : null;
    const formationSlot = formationSlots?.get?.(entry.tokenId) || null;

    const pushCoarseCandidate = (rawTopLeft, meta = {}) => {
      if (coarseCandidates.length >= maxCandidates) return;

      const snappedTopLeft = this._snapTokenTopLeftToGrid(rawTopLeft, entry.tokenDoc);
      const key = this._pointKey(snappedTopLeft.x, snappedTopLeft.y);
      if (seen.has(key)) return;
      seen.add(key);

      if (!this._isTokenTopLeftWithinScene(snappedTopLeft, entry.tokenDoc)) return;

      const rect = this._buildTokenRect(snappedTopLeft, entry.tokenDoc);
      if (this._rectOverlapsAny(rect, context.staticRects)) return;

      const center = this._tokenTopLeftToCenter(snappedTopLeft, entry.tokenDoc);

      const anchorSideRelaxed = context?.relaxedAnchorTokenIds instanceof Set && context.relaxedAnchorTokenIds.has(entry.tokenId);
      if (context?.anchor?.enforceAnchorSide && !context.ignoreWalls && !anchorSideRelaxed) {
        const anchorDoc = context.anchor.tokenDoc || entry.tokenDoc;
        const anchorCheck = this._validatePathSegmentCollision(context.anchor.center, center, {
          tokenDoc: anchorDoc,
          options: {
            ignoreWalls: false,
            collisionMode: context?.options?.collisionMode || 'closest'
          }
        });
        if (!anchorCheck?.ok) return;
      }

      // Distance from this candidate cell to the anchor point (click target).
      // This is weighted more heavily than path length so tokens compress
      // tightly around the click point rather than spreading out.
      const anchorCenter = hasAnchor ? context.anchor.center : entry.desiredCenter;
      const anchorOffset = Math.hypot(
        center.x - anchorCenter.x,
        center.y - anchorCenter.y
      );

      const directDistance = Math.hypot(center.x - entry.startCenter.x, center.y - entry.startCenter.y);
      const formationOffset = formationSlot
        ? Math.hypot(center.x - asNumber(formationSlot?.x, center.x), center.y - asNumber(formationSlot?.y, center.y))
        : 0;
      // Formation offset is weighted heavily so that when there's enough room
      // the group arrives in the same spatial arrangement it started in.
      // Anchor offset still matters to keep the group near the click point.
      const coarseCost = formationSlot
        ? (anchorOffset * 0.30) + (directDistance * 0.15) + (formationOffset * 0.55)
        : (anchorOffset * 0.65) + (directDistance * 0.35);

      coarseCandidates.push({
        topLeft: snappedTopLeft,
        center,
        rect,
        key,
        anchorOffset,
        coarseCost,
        formationSeed: !!meta?.formationSeed,
        sharedPathIndex: Number.isFinite(asNumber(meta?.sharedPathIndex, NaN))
          ? Math.max(0, Math.round(asNumber(meta?.sharedPathIndex, 0)))
          : -1
      });
    };

    if (formationSlot) {
      const formationTopLeft = this._tokenCenterToTopLeft({
        x: asNumber(formationSlot?.x, 0),
        y: asNumber(formationSlot?.y, 0)
      }, entry.tokenDoc);

      pushCoarseCandidate(formationTopLeft, { formationSeed: true });

      // Seed a small ring around the slot so assignment has nearby non-overlap
      // alternatives before broad radial expansion.
      const ringStep = Math.max(stepX, stepY);
      const ring = [
        [ringStep, 0],
        [-ringStep, 0],
        [0, ringStep],
        [0, -ringStep],
        [ringStep, ringStep],
        [ringStep, -ringStep],
        [-ringStep, ringStep],
        [-ringStep, -ringStep]
      ];
      for (const [dx, dy] of ring) {
        pushCoarseCandidate({ x: formationTopLeft.x + dx, y: formationTopLeft.y + dy }, { formationSeed: true });
      }
    }

    const sharedCorridorPath = Array.isArray(context?.sharedCorridorPath)
      ? context.sharedCorridorPath
      : [];
    if (!context.ignoreWalls && sharedCorridorPath.length >= 2) {
      const corridorTailSteps = clamp(
        Math.round(asNumber(context?.options?.groupSharedPathTailSteps, 20)),
        4,
        80
      );
      const corridorStride = clamp(
        Math.round(asNumber(context?.options?.groupSharedPathStride, 2)),
        1,
        8
      );
      const startIndex = Math.max(0, sharedCorridorPath.length - corridorTailSteps);

      for (let idx = sharedCorridorPath.length - 1; idx >= startIndex && coarseCandidates.length < maxCandidates; idx -= corridorStride) {
        const node = sharedCorridorPath[idx];
        if (!node || !Number.isFinite(asNumber(node?.x, NaN)) || !Number.isFinite(asNumber(node?.y, NaN))) continue;
        const corridorTopLeft = this._tokenCenterToTopLeft(node, entry.tokenDoc);
        pushCoarseCandidate(corridorTopLeft, { sharedPathIndex: idx });
      }
    }

    for (let radius = 0; radius <= maxRadiusCells && coarseCandidates.length < maxCandidates; radius++) {
      if (this._isGroupPlanningBudgetExceeded(context?.planBudget) && coarseCandidates.length >= budgetCandidateFloor) {
        break;
      }
      for (let ox = -radius; ox <= radius && coarseCandidates.length < maxCandidates; ox++) {
        if (this._isGroupPlanningBudgetExceeded(context?.planBudget) && coarseCandidates.length >= budgetCandidateFloor) {
          break;
        }
        for (let oy = -radius; oy <= radius && coarseCandidates.length < maxCandidates; oy++) {
          if (this._isGroupPlanningBudgetExceeded(context?.planBudget) && coarseCandidates.length >= budgetCandidateFloor) {
            break;
          }
          if (Math.max(Math.abs(ox), Math.abs(oy)) !== radius) continue;
          pushCoarseCandidate({
            x: searchOriginTopLeft.x + (ox * stepX),
            y: searchOriginTopLeft.y + (oy * stepY)
          });
        }
      }
    }

    if (coarseCandidates.length === 0) return [];

    coarseCandidates.sort((a, b) => a.coarseCost - b.coarseCost);

    const evaluateCandidate = (coarse, index = 0) => {
      let pathNodes = [entry.startCenter, coarse.center];
      if (!context.ignoreWalls) {
        const pathOptions = {
          ignoreWalls: false,
          ignoreCost: context.ignoreCost,
          allowDiagonal: optionsBoolean(context?.options?.allowDiagonal, true),
          fogPathPolicy: context?.options?.fogPathPolicy || this.settings.fogPathPolicy,
          maxSearchIterations: asNumber(context?.options?.maxSearchIterations, 12000),
          suppressNoPathLog: true,
          statsCollector: context?.statsCollector || null
        };

        const useAdaptiveExpansion = index < 2
          || !!coarse?.formationSeed
          || (asNumber(coarse?.sharedPathIndex, -1) >= 0 && index < 6);
        const pathResult = useAdaptiveExpansion
          ? this._findWeightedPathWithAdaptiveExpansion({
            start: entry.startCenter,
            end: coarse.center,
            tokenDoc: entry.tokenDoc,
            options: pathOptions,
            preferLongRange: asNumber(coarse?.anchorOffset, 0) <= Math.max(stepX, stepY)
          })
          : this.findWeightedPath({
            start: entry.startCenter,
            end: coarse.center,
            tokenDoc: entry.tokenDoc,
            options: pathOptions
          });

        if (!pathResult?.ok || !Array.isArray(pathResult.pathNodes) || pathResult.pathNodes.length < 2) {
          return {
            accepted: false,
            reason: String(pathResult?.reason || 'path-search-failed'),
            diagnostics: pathResult?.diagnostics || null
          };
        }

        pathNodes = pathResult.pathNodes.slice();
        pathNodes[0] = entry.startCenter;
        pathNodes[pathNodes.length - 1] = coarse.center;
      }

      if (this._pathOverlapsStaticOccupancy(pathNodes, entry.tokenDoc, context.staticRects)) {
        return {
          accepted: false,
          reason: 'path-overlaps-static-occupancy',
          diagnostics: null
        };
      }

      const pathLength = this._measurePathLength(pathNodes);
      // When a formation slot exists, factor formation offset into the
      // assignment cost so the branch-and-bound solver strongly prefers
      // candidates that preserve the original spatial arrangement.
      const formationSlotRef = formationSlots?.get?.(entry.tokenId) || null;
      const fOffset = formationSlotRef
        ? Math.hypot(coarse.center.x - asNumber(formationSlotRef.x, coarse.center.x),
          coarse.center.y - asNumber(formationSlotRef.y, coarse.center.y))
        : 0;
      const cost = formationSlotRef
        ? (coarse.anchorOffset * 0.25) + (pathLength * 0.25) + (fOffset * 0.50)
        : (coarse.anchorOffset * 0.7) + (pathLength * 0.3);
      candidates.push({
        topLeft: coarse.topLeft,
        center: coarse.center,
        rect: coarse.rect,
        key: coarse.key,
        pathNodes,
        cost
      });
      return {
        accepted: true,
        reason: 'ok',
        diagnostics: null
      };
    };

    const targetEvalCount = context.ignoreWalls
      ? coarseCandidates.length
      : Math.min(coarseCandidates.length, pathEvalCandidatesLimit);

    let evaluatedCount = 0;
    let lowConnectivityNoPathStreak = 0;
    for (let i = 0; i < coarseCandidates.length; i++) {
      if (this._isGroupPlanningBudgetExceeded(context?.planBudget) && candidates.length >= budgetCandidateFloor) {
        break;
      }

      // Two-phase behavior:
      // - evaluate only the top coarse candidates first (fast path)
      // - continue beyond that only when we still don't have enough viable endpoints.
      if (i >= targetEvalCount && candidates.length >= budgetCandidateFloor) {
        break;
      }

      const evalResult = evaluateCandidate(coarseCandidates[i], i);
      evaluatedCount += 1;

      const graphDiagnostics = evalResult?.diagnostics?.graphDiagnostics || null;
      const noPathLikelyDisconnected = evalResult?.reason === 'no-path'
        && graphDiagnostics
        && !optionsBoolean(graphDiagnostics?.truncated, false)
        && asNumber(graphDiagnostics?.nodeCount, 0) <= 24;

      lowConnectivityNoPathStreak = noPathLikelyDisconnected
        ? (lowConnectivityNoPathStreak + 1)
        : 0;

      // If early probes repeatedly show tiny non-truncated graphs with no-path,
      // remaining probes are typically wasted for this token in this preview.
      if (!context.ignoreWalls && candidates.length === 0 && lowConnectivityNoPathStreak >= 4) {
        break;
      }
    }

    if (!context.ignoreWalls && candidates.length < budgetCandidateFloor && evaluatedCount < coarseCandidates.length) {
      for (let i = evaluatedCount; i < coarseCandidates.length; i++) {
        if (this._isGroupPlanningBudgetExceeded(context?.planBudget) && candidates.length >= budgetCandidateFloor) {
          break;
        }
        evaluateCandidate(coarseCandidates[i], i);
      }
    }

    candidates.sort((a, b) => a.cost - b.cost);
    return candidates.slice(0, maxCandidates);
  }

  /**
   * @param {Array<{tokenId:string, tokenDoc:any}>} entries
   * @param {Map<string, Array<object>>} candidateMap
   * @param {object} options
   * @returns {{ok:boolean, reason?:string, assignments?:Map<string, any>}}
   */
  _assignGroupDestinations(entries, candidateMap, options = {}) {
    const tokens = entries.slice().sort((a, b) => {
      const ca = candidateMap.get(a.tokenId)?.length || 0;
      const cb = candidateMap.get(b.tokenId)?.length || 0;
      return ca - cb;
    });

    const buildGreedyAssignments = () => {
      const greedy = new Map();
      const usedRects = [];

      for (const token of tokens) {
        const candidates = candidateMap.get(token.tokenId) || [];
        let selected = null;
        for (const candidate of candidates) {
          if (!this._rectOverlapsAny(candidate.rect, usedRects)) {
            selected = candidate;
            break;
          }
        }
        if (!selected) {
          return { ok: false, reason: 'greedy-assignment-failed', assignments: null };
        }
        greedy.set(token.tokenId, selected);
        usedRects.push(selected.rect);
      }

      return { ok: true, assignments: greedy };
    };

    const maxBacktrackTokens = clamp(Math.round(asNumber(options?.groupBacktrackTokenLimit, 8)), 2, 12);
    if (tokens.length > maxBacktrackTokens) {
      // Fallback greedy assignment for very large groups.
      return buildGreedyAssignments();
    }

    let bestCost = Number.POSITIVE_INFINITY;
    /** @type {Map<string, any>|null} */
    let bestAssignments = null;

    const backtrackBudgetMs = clamp(asNumber(options?.groupBacktrackBudgetMs, 45), 1, 2000);
    const backtrackNodeLimit = clamp(Math.round(asNumber(options?.groupBacktrackNodeLimit, 30000)), 1000, 500000);
    const backtrackStartMs = this._nowMs();
    let exploredNodes = 0;
    let budgetExceeded = false;

    const recurse = (index, runningCost, currentAssignments, usedRects) => {
      if (budgetExceeded) return;

      exploredNodes += 1;
      if (
        exploredNodes >= backtrackNodeLimit
        || (this._nowMs() - backtrackStartMs) >= backtrackBudgetMs
      ) {
        budgetExceeded = true;
        return;
      }

      if (runningCost >= bestCost) return;

      if (index >= tokens.length) {
        bestCost = runningCost;
        bestAssignments = new Map(currentAssignments);
        return;
      }

      const token = tokens[index];
      const candidates = candidateMap.get(token.tokenId) || [];
      for (const candidate of candidates) {
        if (this._rectOverlapsAny(candidate.rect, usedRects)) continue;

        currentAssignments.set(token.tokenId, candidate);
        usedRects.push(candidate.rect);

        recurse(index + 1, runningCost + asNumber(candidate.cost, Number.POSITIVE_INFINITY), currentAssignments, usedRects);

        usedRects.pop();
        currentAssignments.delete(token.tokenId);
      }
    };

    recurse(0, 0, new Map(), []);

    if ((!bestAssignments || bestAssignments.size !== tokens.length) && budgetExceeded) {
      const greedyFallback = buildGreedyAssignments();
      if (greedyFallback.ok) {
        return {
          ok: true,
          assignments: greedyFallback.assignments,
          degraded: true,
          diagnostics: {
            reason: 'backtrack-budget-exceeded-greedy-fallback',
            exploredNodes,
            backtrackNodeLimit,
            backtrackBudgetMs
          }
        };
      }
      return {
        ok: false,
        reason: 'backtrack-budget-exceeded',
        diagnostics: {
          exploredNodes,
          backtrackNodeLimit,
          backtrackBudgetMs
        }
      };
    }

    if (!bestAssignments || bestAssignments.size !== tokens.length) {
      return { ok: false, reason: 'no-non-overlap-assignment' };
    }

    return {
      ok: true,
      assignments: bestAssignments
    };
  }

  /**
   * Compute how much a token's path diverges from the group's shared corridor.
   * Returns the average distance of sampled path points to their nearest
   * corridor point. High values indicate the path takes a significantly
   * different route (e.g. going around the opposite side of a wall).
   *
   * @param {Array<{x:number,y:number}>} pathNodes
   * @param {Array<{x:number,y:number}>} corridorNodes
   * @returns {number}
   */
  _computePathCorridorDivergence(pathNodes, corridorNodes) {
    if (!Array.isArray(pathNodes) || pathNodes.length < 2) return 0;
    if (!Array.isArray(corridorNodes) || corridorNodes.length < 2) return 0;

    // Sample the path at evenly spaced points and measure distance to the
    // nearest corridor node. Sampling avoids O(n*m) full cross-product.
    const sampleCount = Math.min(10, pathNodes.length);
    let totalDistance = 0;

    for (let i = 0; i < sampleCount; i++) {
      const idx = Math.round(i * (pathNodes.length - 1) / Math.max(1, sampleCount - 1));
      const point = pathNodes[idx];
      if (!point) continue;

      let minDist = Number.POSITIVE_INFINITY;
      for (const cp of corridorNodes) {
        const d = Math.hypot(
          asNumber(point.x, 0) - asNumber(cp.x, 0),
          asNumber(point.y, 0) - asNumber(cp.y, 0)
        );
        if (d < minDist) minDist = d;
      }

      totalDistance += minDist;
    }

    return totalDistance / Math.max(1, sampleCount);
  }

  /**
   * After assignment, detect tokens whose paths significantly diverge from
   * the group's shared corridor (e.g. 4 tokens go left around a wall but
   * 1 goes right) and re-route them through corridor waypoints so the
   * group travels together.
   *
   * @param {Array<{tokenId:string, tokenDoc:any, pathNodes:Array<{x:number,y:number}>, destinationTopLeft:{x:number,y:number}, cost:number}>} planEntries
   * @param {Array<{x:number,y:number}>} sharedCorridorPath
   * @param {object} [options]
   * @returns {{planEntries:Array<object>, fixedCount:number, diagnostics:object}}
   */
  _fixGroupPathOutliers(planEntries, sharedCorridorPath, options = {}) {
    const diagnostics = {
      checked: 0,
      outlierTokenIds: [],
      fixedTokenIds: [],
      divergences: {}
    };

    if (!Array.isArray(sharedCorridorPath) || sharedCorridorPath.length < 3) {
      return { planEntries, fixedCount: 0, diagnostics };
    }
    if (!Array.isArray(planEntries) || planEntries.length < 3) {
      return { planEntries, fixedCount: 0, diagnostics };
    }

    const gridSize = Math.max(1, asNumber(canvas?.grid?.size, 100));

    // Compute divergence for each token's assigned path.
    const divergenceByTokenId = new Map();
    for (const entry of planEntries) {
      const div = this._computePathCorridorDivergence(entry.pathNodes, sharedCorridorPath);
      divergenceByTokenId.set(entry.tokenId, div);
      diagnostics.divergences[entry.tokenId] = Math.round(div * 10) / 10;
    }
    diagnostics.checked = planEntries.length;

    // Compute median divergence to establish what "normal" looks like.
    const sortedDivs = [...divergenceByTokenId.values()].sort((a, b) => a - b);
    const median = sortedDivs[Math.floor(sortedDivs.length / 2)];

    // Outlier threshold: must be both significantly above median AND above
    // an absolute minimum distance to avoid false positives on compact moves.
    const outlierThreshold = Math.max(median * 2.5, gridSize * 4);

    let fixedCount = 0;
    for (const entry of planEntries) {
      const div = divergenceByTokenId.get(entry.tokenId) || 0;
      if (div <= outlierThreshold) continue;
      if (!Array.isArray(entry.pathNodes) || entry.pathNodes.length < 2) continue;

      diagnostics.outlierTokenIds.push(entry.tokenId);

      const startCenter = entry.pathNodes[0];
      const endCenter = entry.pathNodes[entry.pathNodes.length - 1];

      // Find the corridor node closest to this token's start position.
      let startCorridorIdx = 0;
      let minStartDist = Number.POSITIVE_INFINITY;
      for (let i = 0; i < sharedCorridorPath.length; i++) {
        const d = Math.hypot(
          asNumber(startCenter.x, 0) - asNumber(sharedCorridorPath[i].x, 0),
          asNumber(startCenter.y, 0) - asNumber(sharedCorridorPath[i].y, 0)
        );
        if (d < minStartDist) { minStartDist = d; startCorridorIdx = i; }
      }

      // Find the corridor node closest to this token's destination.
      let endCorridorIdx = sharedCorridorPath.length - 1;
      let minEndDist = Number.POSITIVE_INFINITY;
      for (let i = 0; i < sharedCorridorPath.length; i++) {
        const d = Math.hypot(
          asNumber(endCenter.x, 0) - asNumber(sharedCorridorPath[i].x, 0),
          asNumber(endCenter.y, 0) - asNumber(sharedCorridorPath[i].y, 0)
        );
        if (d < minEndDist) { minEndDist = d; endCorridorIdx = i; }
      }

      // Build a corridor-guided path: start → corridor entry → ... → corridor exit → destination.
      // Use findWeightedPath for the local segments (start→entry, exit→dest) and
      // interpolate through corridor nodes for the middle segment.
      const corridorEntry = sharedCorridorPath[startCorridorIdx];
      const corridorExit = sharedCorridorPath[endCorridorIdx];

      const pathOptions = {
        ignoreWalls: optionsBoolean(options?.ignoreWalls, false),
        ignoreCost: optionsBoolean(options?.ignoreCost, false),
        allowDiagonal: optionsBoolean(options?.allowDiagonal, true),
        fogPathPolicy: options?.fogPathPolicy || this.settings.fogPathPolicy,
        maxSearchIterations: 6000,
        suppressNoPathLog: true
      };

      // Segment A: start → corridor entry point
      const segA = this.findWeightedPath({
        start: startCenter,
        end: corridorEntry,
        tokenDoc: entry.tokenDoc,
        options: pathOptions
      });

      // Corridor middle: walk through corridor nodes in order
      const corridorSlice = startCorridorIdx <= endCorridorIdx
        ? sharedCorridorPath.slice(startCorridorIdx, endCorridorIdx + 1)
        : sharedCorridorPath.slice(endCorridorIdx, startCorridorIdx + 1).reverse();

      // Segment B: corridor exit → destination
      const segB = this.findWeightedPath({
        start: corridorExit,
        end: endCenter,
        tokenDoc: entry.tokenDoc,
        options: pathOptions
      });

      // Stitch segments together, deduplicating junction points.
      const newPath = [];
      if (segA?.ok && Array.isArray(segA.pathNodes) && segA.pathNodes.length >= 2) {
        newPath.push(...segA.pathNodes);
      } else {
        newPath.push(startCenter, corridorEntry);
      }

      // Add corridor middle (skip first node since it overlaps with segA end)
      for (let i = 1; i < corridorSlice.length - 1; i++) {
        newPath.push(corridorSlice[i]);
      }

      if (segB?.ok && Array.isArray(segB.pathNodes) && segB.pathNodes.length >= 2) {
        newPath.push(...segB.pathNodes);
      } else {
        newPath.push(corridorExit, endCenter);
      }

      // Only accept the new path if it isn't dramatically longer than the
      // original — we want route coherence, not a worse path.
      const oldLength = this._measurePathLength(entry.pathNodes);
      const newLength = this._measurePathLength(newPath);
      if (newLength <= oldLength * 1.8 && newPath.length >= 2) {
        entry.pathNodes = newPath;
        entry.cost = newLength;
        fixedCount += 1;
        diagnostics.fixedTokenIds.push(entry.tokenId);
      }
    }

    if (fixedCount > 0) {
      this._pathfindingLog('debug', '_fixGroupPathOutliers corrected divergent paths', {
        fixedCount,
        outlierCount: diagnostics.outlierTokenIds.length,
        threshold: Math.round(outlierThreshold * 10) / 10,
        median: Math.round(median * 10) / 10,
        divergences: diagnostics.divergences
      });
    }

    return { planEntries, fixedCount, diagnostics };
  }

  /**
   * Build synchronized timelines that avoid same-cell overlap and edge swaps.
   *
   * @param {Array<{tokenId:string, tokenDoc:any, pathNodes:Array<{x:number,y:number}>}>} planEntries
   * @returns {{ok:boolean, reason?:string, timelineByTokenId?:Map<string, Array<{x:number,y:number}>>, stepCount?:number, diagnostics?:object}}
   */
  _buildGroupMovementTimeline(planEntries) {
    const stateById = new Map();
    for (const entry of planEntries) {
      const path = Array.isArray(entry?.pathNodes) && entry.pathNodes.length >= 2
        ? entry.pathNodes.slice()
        : null;
      if (!path) {
        return { ok: false, reason: `invalid-path-${entry?.tokenId || 'unknown'}` };
      }
      stateById.set(entry.tokenId, {
        tokenId: entry.tokenId,
        tokenDoc: entry.tokenDoc,
        pathNodes: path,
        pathIndex: 0,
        timeline: [path[0]]
      });
    }

    const allStates = () => [...stateById.values()];
    const isFinished = () => allStates().every((s) => s.pathIndex >= (s.pathNodes.length - 1));
    const maxTicks = Math.max(24, planEntries.reduce((sum, p) => sum + Math.max(0, (p.pathNodes?.length || 1) - 1), 0) * 4);

    let ticks = 0;
    let consecutiveStalls = 0;
    while (!isFinished()) {
      ticks += 1;
      if (ticks > maxTicks) {
        const diagnostics = {
          tick: ticks,
          maxTicks,
          tokenCount: planEntries.length
        };
        this._pathfindingLog('warn', '_buildGroupMovementTimeline exceeded max ticks', diagnostics);
        return { ok: false, reason: 'group-timeline-max-ticks', diagnostics };
      }

      const proposals = [];
      const proposalById = new Map();
      for (const state of allStates()) {
        if (state.pathIndex >= state.pathNodes.length - 1) continue;
        const from = state.pathNodes[state.pathIndex];
        const to = state.pathNodes[state.pathIndex + 1];
        const proposal = {
          tokenId: state.tokenId,
          tokenDoc: state.tokenDoc,
          from,
          to,
          remaining: (state.pathNodes.length - 1) - state.pathIndex
        };
        proposals.push(proposal);
        proposalById.set(proposal.tokenId, proposal);
      }

      if (proposals.length === 0) break;

      // Longer remaining paths move first to reduce corridor deadlocks.
      proposals.sort((a, b) => b.remaining - a.remaining);

      const accepted = [];
      const acceptedIdSet = new Set();
      const rejectedProposals = [];

      // Build a set of all tokens that are proposing to move this tick.
      // If a token has a proposal, it intends to vacate its current cell,
      // so other tokens can move into that cell simultaneously.
      const proposingToMoveIds = new Set(proposals.map((p) => p.tokenId));

      for (const proposal of proposals) {
        const tokenId = proposal.tokenId;

        // Prevent edge swaps (A->B while B->A).
        let blocked = false;
        let blockedByTokenId = '';
        let blockedReason = '';
        for (const a of accepted) {
          if (
            Math.abs(a.from.x - proposal.to.x) < 0.5
            && Math.abs(a.from.y - proposal.to.y) < 0.5
            && Math.abs(a.to.x - proposal.from.x) < 0.5
            && Math.abs(a.to.y - proposal.from.y) < 0.5
          ) {
            blocked = true;
            blockedByTokenId = a.tokenId;
            blockedReason = 'edge-swap';
            break;
          }
        }
        if (blocked) {
          rejectedProposals.push({ tokenId, blockedByTokenId, blockedReason });
          continue;
        }

        const proposalRect = this._buildTokenRect(this._tokenCenterToTopLeft(proposal.to, proposal.tokenDoc), proposal.tokenDoc);

        // Check overlap against accepted target positions.
        for (const a of accepted) {
          const otherRect = this._buildTokenRect(this._tokenCenterToTopLeft(a.to, a.tokenDoc), a.tokenDoc);
          if (this._rectsOverlap(proposalRect, otherRect)) {
            blocked = true;
            blockedByTokenId = a.tokenId;
            blockedReason = 'target-overlap';
            break;
          }
        }
        if (blocked) {
          rejectedProposals.push({ tokenId, blockedByTokenId, blockedReason });
          continue;
        }

        // Check overlap against current positions of other tokens.
        // Allow the move if the occupier is:
        //   (a) already accepted to move this tick (guaranteed vacating), OR
        //   (b) has a pending proposal to move (intends to vacate), OR
        //   (c) is at its final node and the mover is just passing through.
        // This allows simultaneous movement: token A moves into B's cell
        // while B moves into C's cell in the same tick.
        for (const state of allStates()) {
          if (state.tokenId === tokenId) continue;
          if (acceptedIdSet.has(state.tokenId)) continue;

          const currentNode = state.pathNodes[state.pathIndex];
          const currentRect = this._buildTokenRect(this._tokenCenterToTopLeft(currentNode, state.tokenDoc), state.tokenDoc);
          if (this._rectsOverlap(proposalRect, currentRect)) {
            // Occupier is also proposing to move away — allow concurrent movement.
            if (proposingToMoveIds.has(state.tokenId)) {
              continue;
            }

            const blockerAtFinalNode = state.pathIndex >= (state.pathNodes.length - 1);
            const moverHasMoreStepsAfterThis = proposal.remaining > 1;
            if (blockerAtFinalNode && moverHasMoreStepsAfterThis) {
              // Allow transient pass-through overlap when only a corridor-through
              // step is blocked by a token that is already parked at its final
              // destination. Final landing overlap is still disallowed.
              continue;
            }

            blocked = true;
            blockedByTokenId = state.tokenId;
            blockedReason = 'occupied-current';
            break;
          }
        }
        if (blocked) {
          rejectedProposals.push({ tokenId, blockedByTokenId, blockedReason });
          continue;
        }

        accepted.push(proposal);
        acceptedIdSet.add(tokenId);
      }

      // Prune any accepted moves that overlap the current position of a
      // token that is truly stationary — has no proposal to move at all.
      // Tokens with proposals (even if not yet accepted) are expected to
      // vacate, so they don't block.
      let changed = true;
      while (changed) {
        changed = false;
        const acceptedNow = new Set(accepted.map((a) => a.tokenId));

        for (let idx = accepted.length - 1; idx >= 0; idx--) {
          const proposal = accepted[idx];
          const proposalRect = this._buildTokenRect(this._tokenCenterToTopLeft(proposal.to, proposal.tokenDoc), proposal.tokenDoc);

          let invalid = false;
          let blockedByTokenId = '';
          for (const state of allStates()) {
            if (state.tokenId === proposal.tokenId) continue;
            // Skip tokens that are accepted (moving away) or proposing to move.
            if (acceptedNow.has(state.tokenId)) continue;
            if (proposingToMoveIds.has(state.tokenId)) continue;

            const currentNode = state.pathNodes[state.pathIndex];
            const currentRect = this._buildTokenRect(this._tokenCenterToTopLeft(currentNode, state.tokenDoc), state.tokenDoc);
            if (this._rectsOverlap(proposalRect, currentRect)) {
              invalid = true;
              blockedByTokenId = state.tokenId;
              break;
            }
          }

          if (invalid) {
            rejectedProposals.push({
              tokenId: proposal.tokenId,
              blockedByTokenId,
              blockedReason: 'occupied-by-stationary-after-prune'
            });
            accepted.splice(idx, 1);
            changed = true;
          }
        }
      }

      if (accepted.length === 0) {
        consecutiveStalls += 1;

        // Deadlock breaker: after 3 consecutive zero-progress ticks,
        // force-accept the proposal with the longest remaining path
        // to break the impasse. This sacrifices anti-overlap safety for
        // one step but prevents infinite lockup.
        if (consecutiveStalls >= 3 && proposals.length > 0) {
          const forced = proposals[0]; // already sorted longest-remaining first
          accepted.push(forced);
          acceptedIdSet.add(forced.tokenId);
          this._pathfindingLog('warn', '_buildGroupMovementTimeline deadlock breaker: force-accepting proposal', {
            tick: ticks,
            forcedTokenId: forced.tokenId,
            consecutiveStalls
          });
          consecutiveStalls = 0;
        } else if (consecutiveStalls >= 6) {
          // Hard bail after extended deadlock even with breaker attempts
          const diagnostics = {
            tick: ticks,
            tokenCount: planEntries.length,
            proposalCount: proposals.length,
            proposalSample: proposals.slice(0, 12).map((p) => ({
              tokenId: p.tokenId,
              from: { x: asNumber(p.from?.x, 0), y: asNumber(p.from?.y, 0) },
              to: { x: asNumber(p.to?.x, 0), y: asNumber(p.to?.y, 0) },
              remaining: p.remaining
            })),
            rejectedCount: rejectedProposals.length,
            rejectedSample: rejectedProposals.slice(0, 20),
            consecutiveStalls
          };
          this._pathfindingLog('warn', '_buildGroupMovementTimeline deadlock detected after breaker attempts', diagnostics);
          return { ok: false, reason: 'group-timeline-deadlock', diagnostics };
        }
      } else {
        consecutiveStalls = 0;
      }

      for (const step of accepted) {
        const state = stateById.get(step.tokenId);
        if (!state) continue;
        state.pathIndex += 1;
      }

      for (const state of allStates()) {
        state.timeline.push(state.pathNodes[state.pathIndex]);
      }
    }

    const timelineByTokenId = new Map();
    let maxTimelineLen = 0;
    for (const state of allStates()) {
      timelineByTokenId.set(state.tokenId, state.timeline.slice());
      maxTimelineLen = Math.max(maxTimelineLen, state.timeline.length);
    }

    return {
      ok: true,
      timelineByTokenId,
      stepCount: Math.max(0, maxTimelineLen - 1)
    };
  }

  /**
   * Execute one synchronized step wave at a time so tokens move in parallel.
   *
   * @param {Array<{tokenId:string, tokenDoc:any}>} planEntries
   * @param {Map<string, Array<{x:number,y:number}>>} timelineByTokenId
   * @param {object} options
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async _executeGroupTimeline(planEntries, timelineByTokenId, options = {}) {
    try {
      const groupCancelToken = options?._groupCancelToken || null;
      const maxTimelineLen = planEntries.reduce((maxLen, p) => {
        const tl = timelineByTokenId.get(p.tokenId) || [];
        return Math.max(maxLen, tl.length);
      }, 0);

      for (let stepIndex = 1; stepIndex < maxTimelineLen; stepIndex++) {
        // Check for cancellation from a new movement order. Tokens stay at
        // their current (last-confirmed) Foundry positions — each completed
        // step already called updateEmbeddedDocuments, so no rollback needed.
        if (groupCancelToken?.cancelled) {
          this._pathfindingLog('info', '_executeGroupTimeline interrupted by new movement order', {
            stepIndex,
            maxTimelineLen,
            tokenCount: planEntries.length,
            completedSteps: stepIndex - 1
          });
          return { ok: false, reason: 'interrupted-by-new-move' };
        }

        const stepMoves = [];

        for (const entry of planEntries) {
          const tokenId = entry.tokenId;
          const timeline = timelineByTokenId.get(tokenId) || [];
          if (timeline.length < 2) continue;

          const prev = timeline[Math.min(stepIndex - 1, timeline.length - 1)];
          const next = timeline[Math.min(stepIndex, timeline.length - 1)];
          if (!prev || !next) continue;

          const moved = Math.hypot(
            asNumber(next.x, 0) - asNumber(prev.x, 0),
            asNumber(next.y, 0) - asNumber(prev.y, 0)
          ) >= 0.5;
          if (!moved) continue;

          stepMoves.push(
            this._moveTokenToFoundryPoint(tokenId, next, entry.tokenDoc, options, {
              tokenId,
              phase: 'GROUP_PATH_SEGMENT',
              groupStepIndex: stepIndex,
              groupStepCount: maxTimelineLen - 1,
              _groupCancelToken: groupCancelToken
            })
          );
        }

        if (stepMoves.length === 0) continue;

        // Use allSettled so one token's transient failure doesn't abort the
        // entire group. The final reconciliation pass will repair stragglers.
        const settled = await Promise.allSettled(stepMoves);
        let stepFailCount = 0;
        for (const result of settled) {
          const value = result.status === 'fulfilled' ? result.value : null;
          if (!value?.ok) stepFailCount += 1;
        }
        if (stepFailCount > 0) {
          this._pathfindingLog('warn', '_executeGroupTimeline step had partial failures (continuing)', {
            stepIndex,
            failCount: stepFailCount,
            totalMoves: stepMoves.length
          });
          // Don't abort — reconciliation will handle stragglers.
        }

        // Keep render loop warm during synchronized group movement.
        try {
          const rl = window.MapShine?.renderLoop;
          rl?.requestContinuousRender?.(100);
        } catch (_) {
        }

        if (groupCancelToken?.cancelled) {
          return { ok: false, reason: 'interrupted-by-new-move' };
        }

        const wavePauseMs = this._estimateGroupWavePauseMs(stepIndex, Math.max(1, maxTimelineLen - 1), planEntries.length, options);
        if (wavePauseMs > 0) {
          const pauseDeadline = Date.now() + wavePauseMs;
          while (!groupCancelToken?.cancelled && Date.now() < pauseDeadline) {
            await _sleep(Math.min(20, Math.max(4, pauseDeadline - Date.now())));
          }
          if (groupCancelToken?.cancelled) {
            return { ok: false, reason: 'interrupted-by-new-move' };
          }
        }
      }

      return { ok: true };
    } catch (error) {
      this._pathfindingLog('error', '_executeGroupTimeline threw unexpectedly', {
        tokenCount: Array.isArray(planEntries) ? planEntries.length : 0,
        options
      }, error);
      return { ok: false, reason: 'group-timeline-exception' };
    }
  }

  /**
   * Compute a small variable pause between synchronized group-move waves.
   * This prevents groups from looking perfectly metronomic while preserving
   * deterministic choreography on the same plan.
   *
   * @param {number} stepIndex
   * @param {number} stepCount
   * @param {number} tokenCount
   * @param {object} options
   * @returns {number}
   */
  _estimateGroupWavePauseMs(stepIndex, stepCount, tokenCount, options = {}) {
    if (Number.isFinite(Number(options?.groupStepPauseMs))) {
      return Math.max(0, asNumber(options?.groupStepPauseMs, 0));
    }

    const baseMs = clamp(asNumber(options?.groupStepPauseBaseMs, 18), 0, 240);
    const varianceMs = clamp(asNumber(options?.groupStepPauseVarianceMs, 46), 0, 180);

    const sceneId = String(canvas?.scene?.id || 'scene');
    const seed = hashStringToUnit(`${sceneId}|group-wave|${Math.round(stepIndex)}|${Math.round(stepCount)}|${Math.round(tokenCount)}|${this._doorStateRevision}`);
    const jitter = ((seed * 2) - 1) * (varianceMs * 0.5);
    const pauseMs = baseMs + jitter;

    return clamp(pauseMs, 0, 260);
  }

  /**
   * @param {{x:number,y:number}} topLeft
   * @param {TokenDocument|object} tokenDoc
   * @returns {{x:number,y:number,w:number,h:number}}
   */
  _buildTokenRect(topLeft, tokenDoc) {
    const size = this._getTokenPixelSize(tokenDoc);
    return {
      x: asNumber(topLeft?.x, 0),
      y: asNumber(topLeft?.y, 0),
      w: size.widthPx,
      h: size.heightPx
    };
  }

  /**
   * @param {{x:number,y:number,w:number,h:number}} a
   * @param {{x:number,y:number,w:number,h:number}} b
   * @returns {boolean}
   */
  _rectsOverlap(a, b) {
    const eps = 0.1;
    return (
      a.x < (b.x + b.w - eps)
      && (a.x + a.w) > (b.x + eps)
      && a.y < (b.y + b.h - eps)
      && (a.y + a.h) > (b.y + eps)
    );
  }

  /**
   * @param {{x:number,y:number,w:number,h:number}} rect
   * @param {Array<{x:number,y:number,w:number,h:number}>} rects
   * @returns {boolean}
   */
  _rectOverlapsAny(rect, rects) {
    if (!Array.isArray(rects) || rects.length === 0) return false;
    for (const other of rects) {
      if (this._rectsOverlap(rect, other)) return true;
    }
    return false;
  }

  /**
   * @param {{x:number,y:number}} topLeft
   * @param {TokenDocument|object} tokenDoc
   * @returns {boolean}
   */
  _isTokenTopLeftWithinScene(topLeft, tokenDoc) {
    const dims = canvas?.dimensions;
    const sceneRect = dims?.sceneRect || {
      x: 0,
      y: 0,
      width: asNumber(dims?.width, 0),
      height: asNumber(dims?.height, 0)
    };

    const rect = this._buildTokenRect(topLeft, tokenDoc);
    return (
      rect.x >= sceneRect.x
      && rect.y >= sceneRect.y
      && (rect.x + rect.w) <= (sceneRect.x + sceneRect.width)
      && (rect.y + rect.h) <= (sceneRect.y + sceneRect.height)
    );
  }

  /**
   * @param {Set<string>} movingIds
   * @returns {Array<{x:number,y:number,w:number,h:number}>}
   */
  _collectStaticTokenOccupancyRects(movingIds) {
    const out = [];
    const tokenDocs = canvas?.scene?.tokens;
    if (!tokenDocs || typeof tokenDocs.values !== 'function') return out;

    for (const doc of tokenDocs.values()) {
      const id = String(doc?.id || '');
      if (!id) continue;
      if (movingIds?.has?.(id)) continue;

      const topLeft = { x: asNumber(doc?.x, 0), y: asNumber(doc?.y, 0) };
      out.push(this._buildTokenRect(topLeft, doc));
    }
    return out;
  }

  /**
   * @param {Array<{x:number,y:number}>} pathNodes
   * @param {TokenDocument|object} tokenDoc
   * @param {Array<{x:number,y:number,w:number,h:number}>} staticRects
   * @returns {boolean}
   */
  _pathOverlapsStaticOccupancy(pathNodes, tokenDoc, staticRects) {
    if (!Array.isArray(pathNodes) || pathNodes.length === 0) return false;
    if (!Array.isArray(staticRects) || staticRects.length === 0) return false;

    for (let i = 1; i < pathNodes.length; i++) {
      const node = pathNodes[i];
      const topLeft = this._tokenCenterToTopLeft(node, tokenDoc);
      const rect = this._buildTokenRect(topLeft, tokenDoc);
      if (this._rectOverlapsAny(rect, staticRects)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Compute a movement path preview without committing any document updates.
   *
   * @param {object} params
   * @param {TokenDocument|object} params.tokenDoc
   * @param {{x:number,y:number}} params.destinationTopLeft
   * @param {object} [params.options]
   * @param {boolean} [params.options.ignoreWalls=false]
   * @param {boolean} [params.options.ignoreCost=false]
   * @returns {{ok:boolean, tokenId:string, pathNodes:Array<{x:number,y:number}>, distance:number, reason?:string}}
   */
  computeTokenPathPreview({ tokenDoc, destinationTopLeft, options = {} } = {}) {
    try {
      const tokenId = String(tokenDoc?.id || '');
      if (!tokenId) {
        this._pathfindingLog('warn', 'computeTokenPathPreview blocked: missing token id', {
          destinationTopLeft,
          options
        });
        return { ok: false, tokenId: '', pathNodes: [], distance: 0, reason: 'missing-token-id' };
      }

      const liveDoc = this._resolveTokenDocumentById(tokenId, tokenDoc);
      if (!liveDoc) {
        this._pathfindingLog('warn', 'computeTokenPathPreview blocked: missing token document', {
          tokenId,
          destinationTopLeft,
          options
        });
        return { ok: false, tokenId, pathNodes: [], distance: 0, reason: 'missing-token-doc' };
      }

      const destX = asNumber(destinationTopLeft?.x, NaN);
      const destY = asNumber(destinationTopLeft?.y, NaN);
      if (!Number.isFinite(destX) || !Number.isFinite(destY)) {
        this._pathfindingLog('warn', 'computeTokenPathPreview blocked: invalid destination', {
          token: this._pathfindingTokenMeta(liveDoc),
          destinationTopLeft,
          options
        });
        return { ok: false, tokenId, pathNodes: [], distance: 0, reason: 'invalid-destination' };
      }

      const ignoreWalls = optionsBoolean(options?.ignoreWalls, false);
      const ignoreCost = optionsBoolean(options?.ignoreCost, false);

      const startTopLeft = { x: asNumber(liveDoc.x, 0), y: asNumber(liveDoc.y, 0) };
      const targetTopLeft = this._snapTokenTopLeftToGrid({ x: destX, y: destY }, liveDoc);

      const startCenter = this._tokenTopLeftToCenter(startTopLeft, liveDoc);
      const endCenter = this._tokenTopLeftToCenter(targetTopLeft, liveDoc);

      let pathNodes = [startCenter, endCenter];
      if (!ignoreWalls) {
        const pathResult = this.findWeightedPath({
          start: startCenter,
          end: endCenter,
          tokenDoc: liveDoc,
          options: {
            ignoreWalls,
            ignoreCost,
            fogPathPolicy: this.settings.fogPathPolicy,
            allowDiagonal: optionsBoolean(options?.allowDiagonal, true),
            maxSearchIterations: asNumber(options?.maxSearchIterations, 12000)
          }
        });

        if (!pathResult?.ok || !Array.isArray(pathResult.pathNodes) || pathResult.pathNodes.length < 2) {
          this._pathfindingLog('warn', 'computeTokenPathPreview failed to find a valid path', {
            token: this._pathfindingTokenMeta(liveDoc),
            destinationTopLeft: targetTopLeft,
            reason: pathResult?.reason || 'no-path',
            diagnostics: pathResult?.diagnostics || null,
            options
          });
          return {
            ok: false,
            tokenId,
            pathNodes: [],
            distance: 0,
            reason: pathResult?.reason || 'no-path'
          };
        }

        pathNodes = pathResult.pathNodes.slice();
        pathNodes[0] = startCenter;
        pathNodes[pathNodes.length - 1] = endCenter;
      }

      return {
        ok: true,
        tokenId,
        pathNodes,
        distance: this._measurePathLength(pathNodes)
      };
    } catch (error) {
      const tokenId = String(tokenDoc?.id || '');
      this._pathfindingLog('error', 'computeTokenPathPreview threw unexpectedly', {
        tokenId,
        destinationTopLeft,
        options
      }, error);
      return {
        ok: false,
        tokenId,
        pathNodes: [],
        distance: 0,
        reason: 'preview-exception'
      };
    }
  }

  /**
   * Execute the planned door choreography state machine for a full path plan,
   * including movement coupling through path nodes and door hold/entry points.
   *
   * @param {object} params
   * @param {string} params.tokenId
   * @param {{doorSteps?: Array<object>, pathNodes?: Array<{x:number,y:number}>, doorRevision?: number, inCombat?: boolean}} params.plan
   * @param {(point: {x:number,y:number}, context: object) => Promise<object|boolean>|object|boolean} [params.moveToPoint]
   * @param {object} [params.options]
   * @param {boolean} [params.options.silent=true]
   * @param {number} [params.options.waitForOpenMs=1200]
   * @param {number} [params.options.waitForCloseMs=1200]
   * @returns {Promise<{ok: boolean, tokenId: string, transitions: Array<object>, failedStepIndex: number, reason?: string}>}
   */
  async runDoorStateMachineForPlan({ tokenId, plan, moveToPoint = null, options = {} } = {}) {
    const transitions = [];
    const doorSteps = Array.isArray(plan?.doorSteps) ? plan.doorSteps.slice() : [];
    const pathNodes = Array.isArray(plan?.pathNodes) ? plan.pathNodes : [];

    if (!tokenId) {
      return {
        ok: false,
        tokenId: '',
        transitions,
        failedStepIndex: -1,
        reason: 'missing-token-id'
      };
    }

    const waitForOpenMs = asNumber(options?.waitForOpenMs, 1200);
    const waitForCloseMs = asNumber(options?.waitForCloseMs, 1200);
    const silent = options?.silent !== false;
    const hasMoveCallback = typeof moveToPoint === 'function';

    // Door-state revision guard: if the wall graph changed since plan build,
    // callers should replan to avoid race-condition desync.
    const plannedRevision = asNumber(plan?.doorRevision, this._doorStateRevision);
    if (plannedRevision !== this._doorStateRevision) {
      return {
        ok: false,
        tokenId,
        transitions,
        failedStepIndex: -1,
        reason: 'door-revision-mismatch'
      };
    }

    const sortedDoorSteps = doorSteps.sort((a, b) => asNumber(a?.segmentIndex, 0) - asNumber(b?.segmentIndex, 0));
    let pathCursorIndex = 0;

    /** @type {(node: {x:number,y:number}, context: object, transitionState: string, stepIndex: number, doorStep?: object) => Promise<{ok:boolean, reason?:string}>} */
    const runMove = async (node, context, transitionState, stepIndex, doorStep = null) => {
      if (!node || !hasMoveCallback) {
        const skipResult = { ok: true, reason: null };
        transitions.push(this._buildDoorTransition(transitionState, stepIndex, doorStep, skipResult));
        return skipResult;
      }

      const result = await this._invokeMoveToPoint(moveToPoint, node, context);
      transitions.push(this._buildDoorTransition(transitionState, stepIndex, doorStep, result));
      return result;
    };

    if (sortedDoorSteps.length === 0) {
      if (pathNodes.length >= 2 && hasMoveCallback) {
        for (let nodeIndex = 1; nodeIndex < pathNodes.length; nodeIndex++) {
          const moveResult = await runMove(pathNodes[nodeIndex], {
            tokenId,
            stepIndex: -1,
            phase: 'PATH_SEGMENT',
            pathNodeIndex: nodeIndex,
            plan
          }, 'MOVE_PATH_NODE', -1, null);

          if (!moveResult.ok) {
            return {
              ok: false,
              tokenId,
              transitions,
              failedStepIndex: -1,
              reason: moveResult.reason || 'path-node-move-failed'
            };
          }
        }
      }

      return {
        ok: true,
        tokenId,
        transitions,
        failedStepIndex: -1
      };
    }

    for (let i = 0; i < sortedDoorSteps.length; i++) {
      const step = sortedDoorSteps[i];

      // Move along regular path nodes up to this door's segment start.
      if (hasMoveCallback && pathNodes.length > 1) {
        const segmentIndex = clamp(
          Math.trunc(asNumber(step?.segmentIndex, pathCursorIndex)),
          0,
          Math.max(0, pathNodes.length - 1)
        );

        for (let nodeIndex = pathCursorIndex + 1; nodeIndex <= segmentIndex && nodeIndex < pathNodes.length; nodeIndex++) {
          const pathMoveResult = await runMove(pathNodes[nodeIndex], {
            tokenId,
            stepIndex: i,
            phase: 'PATH_TO_DOOR',
            pathNodeIndex: nodeIndex,
            doorStep: step,
            plan
          }, 'MOVE_PATH_NODE', i, step);

          if (!pathMoveResult.ok) {
            return {
              ok: false,
              tokenId,
              transitions,
              failedStepIndex: i,
              reason: pathMoveResult.reason || 'path-to-door-move-failed'
            };
          }
        }
      }

      // 1) APPROACH_DOOR / PRE_DOOR_HOLD
      transitions.push(this._buildDoorTransition('APPROACH_DOOR', i, step, { ok: true }));
      if (step?.holdPoint && typeof moveToPoint === 'function') {
        const holdResult = await this._invokeMoveToPoint(moveToPoint, step.holdPoint, {
          tokenId,
          stepIndex: i,
          phase: 'PRE_DOOR_HOLD',
          doorStep: step,
          plan
        });
        transitions.push(this._buildDoorTransition('PRE_DOOR_HOLD', i, step, holdResult));
        if (!holdResult.ok) {
          return {
            ok: false,
            tokenId,
            transitions,
            failedStepIndex: i,
            reason: holdResult.reason || 'pre-door-hold-move-failed'
          };
        }
      } else {
        transitions.push(this._buildDoorTransition('PRE_DOOR_HOLD', i, step, { ok: true }));
      }

      // 2) REQUEST_DOOR_OPEN
      transitions.push(this._buildDoorTransition('REQUEST_DOOR_OPEN', i, step, { ok: true }));
      const openResult = await this.executeDoorStepOpen(step, {
        silent,
        waitForOpenMs
      });
      transitions.push(this._buildDoorTransition('WAIT_FOR_DOOR_OPEN', i, step, openResult));
      if (!openResult?.ok) {
        return {
          ok: false,
          tokenId,
          transitions,
          failedStepIndex: i,
          reason: openResult?.reason || 'door-open-failed'
        };
      }

      // 3) CROSS_DOOR
      if (step?.entryPoint && typeof moveToPoint === 'function') {
        const crossResult = await this._invokeMoveToPoint(moveToPoint, step.entryPoint, {
          tokenId,
          stepIndex: i,
          phase: 'CROSS_DOOR',
          doorStep: step,
          plan
        });
        transitions.push(this._buildDoorTransition('CROSS_DOOR', i, step, crossResult));
        if (!crossResult.ok) {
          return {
            ok: false,
            tokenId,
            transitions,
            failedStepIndex: i,
            reason: crossResult.reason || 'cross-door-move-failed'
          };
        }
      } else {
        transitions.push(this._buildDoorTransition('CROSS_DOOR', i, step, { ok: true }));
      }

      transitions.push(this._buildDoorTransition('POST_DOOR_POLICY_EVAL', i, step, { ok: true }));

      // 4) REQUEST_DOOR_CLOSE (optional by policy)
      const closeResult = await this.executeDoorStepClose(step, {
        silent,
        waitForCloseMs
      });
      transitions.push(this._buildDoorTransition('REQUEST_DOOR_CLOSE', i, step, closeResult));
      if (!closeResult?.ok) {
        return {
          ok: false,
          tokenId,
          transitions,
          failedStepIndex: i,
          reason: closeResult?.reason || 'door-close-failed'
        };
      }

      // Rejoin the original path after crossing this doorway.
      if (hasMoveCallback && pathNodes.length > 1) {
        const rejoinIndex = clamp(
          Math.trunc(asNumber(step?.segmentIndex, pathCursorIndex)) + 1,
          0,
          Math.max(0, pathNodes.length - 1)
        );
        pathCursorIndex = Math.max(pathCursorIndex, rejoinIndex);

        const rejoinNode = pathNodes[rejoinIndex];
        const rejoinResult = await runMove(rejoinNode, {
          tokenId,
          stepIndex: i,
          phase: 'RESUME_PATH',
          pathNodeIndex: rejoinIndex,
          doorStep: step,
          plan
        }, 'RESUME_PATH', i, step);

        if (!rejoinResult.ok) {
          return {
            ok: false,
            tokenId,
            transitions,
            failedStepIndex: i,
            reason: rejoinResult.reason || 'resume-path-move-failed'
          };
        }
      }

      transitions.push(this._buildDoorTransition('RESUME_PATH', i, step, { ok: true }));
    }

    // Finish any remaining non-door path nodes after the last door.
    if (hasMoveCallback && pathNodes.length > 1) {
      for (let nodeIndex = pathCursorIndex + 1; nodeIndex < pathNodes.length; nodeIndex++) {
        const tailMoveResult = await runMove(pathNodes[nodeIndex], {
          tokenId,
          stepIndex: sortedDoorSteps.length - 1,
          phase: 'PATH_SEGMENT',
          pathNodeIndex: nodeIndex,
          plan
        }, 'MOVE_PATH_NODE', sortedDoorSteps.length - 1, null);

        if (!tailMoveResult.ok) {
          return {
            ok: false,
            tokenId,
            transitions,
            failedStepIndex: sortedDoorSteps.length - 1,
            reason: tailMoveResult.reason || 'path-tail-move-failed'
          };
        }
      }
    }

    return {
      ok: true,
      tokenId,
      transitions,
      failedStepIndex: -1
    };
  }

  /**
   * Internal helper to build uniform state-machine transition records.
   *
   * @param {string} state
   * @param {number} stepIndex
   * @param {object} doorStep
   * @param {object} result
   * @returns {{state: string, stepIndex: number, wallId: string, ok: boolean, reason: string|null, timestampMs: number}}
   */
  _buildDoorTransition(state, stepIndex, doorStep, result) {
    return {
      state,
      stepIndex,
      wallId: doorStep?.wallId || '',
      ok: !!result?.ok,
      reason: result?.reason || null,
      timestampMs: Date.now()
    };
  }

  /**
   * Normalize movement-sequencer callback responses into a common shape.
   *
   * @param {Function} moveToPoint
   * @param {{x:number,y:number}} point
   * @param {object} context
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async _invokeMoveToPoint(moveToPoint, point, context) {
    try {
      const raw = await moveToPoint(point, context);
      if (raw === false) return { ok: false, reason: 'move-callback-false' };
      if (!raw || typeof raw !== 'object') return { ok: true };
      return {
        ok: raw.ok !== false,
        reason: raw.reason || null
      };
    } catch (error) {
      this._pathfindingLog('warn', 'Door sequencer moveToPoint callback failed', {
        tokenId: String(context?.tokenId || ''),
        phase: String(context?.phase || ''),
        point
      }, error);
      return { ok: false, reason: 'move-callback-error' };
    }
  }

  /**
   * Resolve a token document from canvas by id with fallback object support.
   * @param {string} tokenId
   * @param {TokenDocument|object|null} fallbackDoc
   * @returns {TokenDocument|object|null}
   */
  _resolveTokenDocumentById(tokenId, fallbackDoc = null) {
    if (!tokenId) return fallbackDoc || null;
    return canvas?.scene?.tokens?.get?.(tokenId)
      || canvas?.tokens?.get?.(tokenId)?.document
      || fallbackDoc
      || null;
  }

  /**
   * @param {{x:number,y:number}} topLeft
   * @param {TokenDocument|object} tokenDoc
   * @returns {{x:number,y:number}}
   */
  _tokenTopLeftToCenter(topLeft, tokenDoc) {
    const size = this._getTokenPixelSize(tokenDoc);
    return {
      x: asNumber(topLeft?.x, 0) + (size.widthPx / 2),
      y: asNumber(topLeft?.y, 0) + (size.heightPx / 2)
    };
  }

  /**
   * @param {{x:number,y:number}} center
   * @param {TokenDocument|object} tokenDoc
   * @returns {{x:number,y:number}}
   */
  _tokenCenterToTopLeft(center, tokenDoc) {
    const size = this._getTokenPixelSize(tokenDoc);
    return {
      x: asNumber(center?.x, 0) - (size.widthPx / 2),
      y: asNumber(center?.y, 0) - (size.heightPx / 2)
    };
  }

  /**
   * @param {TokenDocument|object} tokenDoc
   * @returns {{widthPx:number,heightPx:number}}
   */
  _getTokenPixelSize(tokenDoc) {
    const gridSize = asNumber(canvas?.grid?.size, asNumber(canvas?.dimensions?.size, 100));
    const width = asNumber(tokenDoc?.width, 1);
    const height = asNumber(tokenDoc?.height, 1);
    return {
      widthPx: width * gridSize,
      heightPx: height * gridSize
    };
  }

  /**
   * Snap a token top-left position to the active grid center (when grid is enabled).
   * Keeps movement endpoints stable between preview/path and authoritative updates.
   *
   * @param {{x:number,y:number}} topLeft
   * @param {TokenDocument|object} tokenDoc
   * @returns {{x:number,y:number}}
   */
  _snapTokenTopLeftToGrid(topLeft, tokenDoc) {
    const x = asNumber(topLeft?.x, 0);
    const y = asNumber(topLeft?.y, 0);

    const grid = canvas?.grid;
    const gridless = !!(grid && grid.type === CONST?.GRID_TYPES?.GRIDLESS);
    if (!grid || gridless || typeof grid.getSnappedPoint !== 'function') {
      return { x, y };
    }

    const center = this._tokenTopLeftToCenter({ x, y }, tokenDoc);
    try {
      const snappedCenter = grid.getSnappedPoint(center, { mode: CONST?.GRID_SNAPPING_MODES?.CENTER });
      return this._tokenCenterToTopLeft(snappedCenter, tokenDoc);
    } catch (_) {
      return { x, y };
    }
  }

  /**
   * @param {string} tokenId
   * @param {{x:number,y:number}} point
   * @param {TokenDocument|object} tokenDoc
   * @param {object} options
   * @param {object} context
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async _moveTokenToFoundryPoint(tokenId, point, tokenDoc, options = {}, context = {}) {
    const groupCancelToken = context?._groupCancelToken || options?._groupCancelToken || null;

    if (groupCancelToken?.cancelled) {
      return { ok: false, reason: 'interrupted-by-new-move' };
    }

    if (!tokenId || !point) {
      this._pathfindingLog('warn', '_moveTokenToFoundryPoint blocked: missing move target', {
        tokenId,
        point,
        context,
        options
      });
      return { ok: false, reason: 'missing-move-target' };
    }

    const liveDoc = this._resolveTokenDocumentById(tokenId, tokenDoc);
    if (!liveDoc) {
      this._pathfindingLog('warn', '_moveTokenToFoundryPoint blocked: missing token document', {
        tokenId,
        context,
        options
      });
      return { ok: false, reason: 'missing-token-doc' };
    }

    const targetTopLeftRaw = this._tokenCenterToTopLeft(point, liveDoc);
    const targetTopLeft = this._snapTokenTopLeftToGrid(targetTopLeftRaw, liveDoc);
    const currentX = asNumber(liveDoc?.x, NaN);
    const currentY = asNumber(liveDoc?.y, NaN);

    if (Number.isFinite(currentX) && Number.isFinite(currentY)) {
      const dx = Math.abs(targetTopLeft.x - currentX);
      const dy = Math.abs(targetTopLeft.y - currentY);
      if (dx < 0.5 && dy < 0.5) {
        return { ok: true, reason: 'no-op' };
      }
    }

    const stepDistancePx = (Number.isFinite(currentX) && Number.isFinite(currentY))
      ? Math.hypot(targetTopLeft.x - currentX, targetTopLeft.y - currentY)
      : 0;
    const fallbackDelayMs = this._estimateSequencedStepDelayMs(stepDistancePx, options);
    const stepPauseMs = this._estimateSequencedStepPauseMs(stepDistancePx, tokenId, context, options);

    const update = {
      _id: tokenId,
      x: targetTopLeft.x,
      y: targetTopLeft.y
    };

    const includeMovementPayload = this._shouldIncludeMovementPayloadForStep(options, context);
    const updateOptions = this._buildTokenMoveUpdateOptions(liveDoc, update, {
      ...options,
      includeMovementPayload
    }, context);

    try {
      await canvas.scene.updateEmbeddedDocuments('Token', [update], updateOptions);
      if (groupCancelToken?.cancelled) {
        return { ok: false, reason: 'interrupted-by-new-move' };
      }

      await this._awaitSequencedStepSettle(tokenId, fallbackDelayMs, options, context);

      if (groupCancelToken?.cancelled) {
        return { ok: false, reason: 'interrupted-by-new-move' };
      }

      if (stepPauseMs > 0) {
        const pauseDeadline = Date.now() + stepPauseMs;
        while (!groupCancelToken?.cancelled && Date.now() < pauseDeadline) {
          await _sleep(Math.min(20, Math.max(4, pauseDeadline - Date.now())));
        }
        if (groupCancelToken?.cancelled) {
          return { ok: false, reason: 'interrupted-by-new-move' };
        }
      }
      return { ok: true };
    } catch (error) {
      this._pathfindingLog('warn', 'Door-aware move update failed for token', {
        tokenId,
        update,
        context,
        options,
        updateOptions
      }, error);
      return { ok: false, reason: 'token-update-failed' };
    }
  }

  /**
   * Estimate a delay budget for one sequenced movement node when a movement
   * track is unavailable (e.g., non-animated updates).
   *
   * @param {number} stepDistancePx
   * @param {object} options
   * @returns {number}
   */
  _estimateSequencedStepDelayMs(stepDistancePx, options = {}) {
    if (Number.isFinite(Number(options?.perStepDelayMs))) {
      return Math.max(0, asNumber(options?.perStepDelayMs, 0));
    }

    const gridSize = Math.max(1, asNumber(canvas?.grid?.size, asNumber(canvas?.dimensions?.size, 100)));
    const gridSteps = Math.max(0, asNumber(stepDistancePx, 0) / gridSize);
    const estMs = (gridSteps * 290) + 140;
    return clamp(estMs, 90, 1800);
  }

  /**
   * Add a small randomized post-step pause so synchronized movement has more
   * organic cadence while still respecting deterministic path planning.
   *
   * @param {number} stepDistancePx
   * @param {string} tokenId
   * @param {object} context
   * @param {object} options
   * @returns {number}
   */
  _estimateSequencedStepPauseMs(stepDistancePx, tokenId, context = {}, options = {}) {
    if (optionsBoolean(options?.disableStepPauseJitter, false)) return 0;
    if (Number.isFinite(Number(options?.perStepPauseMs))) {
      return Math.max(0, asNumber(options?.perStepPauseMs, 0));
    }

    const phase = String(context?.phase || options?.method || 'PATH_SEGMENT');
    const isGroupPhase = phase === 'GROUP_PATH_SEGMENT';
    const baseMs = clamp(asNumber(options?.stepPauseBaseMs, isGroupPhase ? 12 : 7), 0, 220);
    const varianceMs = clamp(asNumber(options?.stepPauseVarianceMs, isGroupPhase ? 34 : 18), 0, 220);

    const stepIndex = Math.round(asNumber(context?.groupStepIndex, asNumber(context?.stepIndex, -1)));
    const sceneId = String(canvas?.scene?.id || 'scene');
    const distanceKey = Math.round(asNumber(stepDistancePx, 0));
    const seed = hashStringToUnit(`${sceneId}|${tokenId}|${phase}|${stepIndex}|${distanceKey}`);
    const jitter = ((seed * 2) - 1) * (varianceMs * 0.5);

    return clamp(baseMs + jitter, 0, 260);
  }

  /**
   * Wait for the token's movement animation track to complete before issuing
   * the next sequenced path node update.
   *
   * @param {string} tokenId
   * @param {number} fallbackDelayMs
   * @param {object} options
   * @param {object} context
   */
  async _awaitSequencedStepSettle(tokenId, fallbackDelayMs, options = {}, context = {}) {
    const groupCancelToken = context?._groupCancelToken || options?._groupCancelToken || null;
    const cancelled = () => !!groupCancelToken?.cancelled;

    if (cancelled()) return;

    const waitForTrackStartMs = clamp(asNumber(options?.waitForTrackStartMs, 220), 0, 2000);
    const waitForTrackFinishMs = clamp(asNumber(options?.waitForTrackFinishMs, 2400), 100, 10000);
    const pollMs = clamp(asNumber(options?.trackPollIntervalMs, 16), 8, 100);

    const hasTrack = () => this.activeTracks?.has?.(tokenId) === true;

    const startDeadline = Date.now() + waitForTrackStartMs;
    let sawTrack = hasTrack();
    while (!sawTrack && Date.now() < startDeadline && !cancelled()) {
      await _sleep(pollMs);
      sawTrack = hasTrack();
    }

    if (cancelled()) return;

    if (sawTrack) {
      const finishDeadline = Date.now() + waitForTrackFinishMs;
      while (hasTrack() && Date.now() < finishDeadline && !cancelled()) {
        await _sleep(pollMs);
      }
      if (hasTrack() && !cancelled()) {
        this._pathfindingLog('debug', '_awaitSequencedStepSettle timed out waiting for track to finish', {
          tokenId,
          waitForTrackFinishMs,
          pollMs
        });
      }
      return;
    }

    if (fallbackDelayMs > 0 && !cancelled()) {
      const fallbackDeadline = Date.now() + fallbackDelayMs;
      while (Date.now() < fallbackDeadline && !cancelled()) {
        await _sleep(Math.min(pollMs, Math.max(4, fallbackDeadline - Date.now())));
      }
    }
  }

  // ── Move Lock Helpers ──────────────────────────────────────────────────────

  /**
   * Wait for any in-flight move on `tokenId` to finish, then register our
   * own lock. Safety timeout (8s) prevents infinite waits from leaked locks.
   * @param {string} tokenId
   * @returns {Promise<{promise: Promise<void>, _resolve?: Function, ownerId: string, createdAtMs: number}>}
   */
  async _acquireTokenMoveLock(tokenId) {
    const MAX_WAIT_MS = 8000;
    const existing = this._activeMoveLocks.get(tokenId);
    if (existing) {
      const existingPromise = existing?.promise || existing;
      let timedOut = false;
      try {
        await Promise.race([
          existingPromise,
          _sleep(MAX_WAIT_MS).then(() => {
            timedOut = true;
          })
        ]);
      } catch (_) {
        // Swallow — the previous move may have rejected.
      }

      if (timedOut && this._activeMoveLocks.get(tokenId) === existing) {
        this._pathfindingLog('warn', '_acquireTokenMoveLock wait timed out; overriding stale lock', {
          tokenId,
          maxWaitMs: MAX_WAIT_MS,
          ownerId: String(existing?.ownerId || 'unknown')
        });
      }
    }

    // Create a new deferred that will be resolved when we release.
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const lockEntry = {
      promise,
      _resolve: resolve,
      ownerId: `token:${tokenId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
      createdAtMs: Date.now()
    };
    this._activeMoveLocks.set(tokenId, lockEntry);
    return lockEntry;
  }

  /**
   * Release the per-token move lock.
   * @param {string} tokenId
   * @param {{promise: Promise<void>, _resolve?: Function, ownerId: string, createdAtMs: number}|null} lockEntry
   */
  _releaseTokenMoveLock(tokenId, lockEntry = null) {
    const lock = this._activeMoveLocks.get(tokenId);
    if (!lock) return;

    // If a newer move already replaced this lock, do not clear it.
    if (lockEntry && lock !== lockEntry) return;

    this._activeMoveLocks.delete(tokenId);
    if (lock && typeof lock._resolve === 'function') {
      lock._resolve();
    }
  }

  /**
   * Wait for any in-flight group move to finish, then register our lock.
   * Safety timeout (15s) prevents infinite waits from leaked locks.
   * @returns {Promise<{promise: Promise<void>, _resolve?: Function, ownerId: string, createdAtMs: number}>}
   */
  async _acquireGroupMoveLock() {
    const MAX_WAIT_MS = 15000;
    const existing = this._groupMoveLock;
    if (existing) {
      const existingPromise = existing?.promise || existing;
      let timedOut = false;
      try {
        await Promise.race([
          existingPromise,
          _sleep(MAX_WAIT_MS).then(() => {
            timedOut = true;
          })
        ]);
      } catch (_) {
      }

      if (timedOut && this._groupMoveLock === existing) {
        this._pathfindingLog('warn', '_acquireGroupMoveLock wait timed out; overriding stale group lock', {
          maxWaitMs: MAX_WAIT_MS,
          ownerId: String(existing?.ownerId || 'unknown')
        });
      }
    }

    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const lockEntry = {
      promise,
      _resolve: resolve,
      ownerId: `group:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
      createdAtMs: Date.now()
    };
    this._groupMoveLock = lockEntry;
    return lockEntry;
  }

  /**
   * Release the global group move lock.
   * @param {{promise: Promise<void>, _resolve?: Function, ownerId: string, createdAtMs: number}|null} lockEntry
   */
  _releaseGroupMoveLock(lockEntry = null) {
    const lock = this._groupMoveLock;
    if (!lock) return;

    // If a newer group move already replaced this lock, do not clear it.
    if (lockEntry && lock !== lockEntry) return;

    this._groupMoveLock = null;
    if (lock && typeof lock._resolve === 'function') {
      lock._resolve();
    }
  }

  /**
   * @param {TokenDocument|object} tokenDoc
   * @param {{_id:string,x:number,y:number}} update
   * @param {object} options
   * @param {object} context
   * @returns {object}
   */
  _buildTokenMoveUpdateOptions(tokenDoc, update, options = {}, context = {}) {
    const updateOptions = (options?.updateOptions && typeof options.updateOptions === 'object')
      ? { ...options.updateOptions }
      : {};

    // Always include an animation hint so other modules (FX, combat trackers)
    // can distinguish animated path-walk updates from teleports, even when the
    // full Foundry movement payload is suppressed for our choreography.
    if (updateOptions.animation === undefined) {
      updateOptions.animation = { duration: 0 };
    }
    if (!updateOptions.mapShineMovement) {
      updateOptions.mapShineMovement = {
        animated: true,
        method: String(options?.method || context?.phase || 'path-walk'),
        phase: String(context?.phase || '')
      };
    }

    const includeMovement = optionsBoolean(options?.includeMovementPayload, false)
      || optionsBoolean(options?.ignoreWalls, false)
      || optionsBoolean(options?.ignoreCost, false);
    if (!includeMovement) return updateOptions;

    const waypoint = {
      x: asNumber(update?.x, asNumber(tokenDoc?.x, 0)),
      y: asNumber(update?.y, asNumber(tokenDoc?.y, 0)),
      explicit: true,
      checkpoint: true
    };

    if (typeof tokenDoc?.elevation === 'number') waypoint.elevation = tokenDoc.elevation;
    if (typeof tokenDoc?.width === 'number') waypoint.width = tokenDoc.width;
    if (typeof tokenDoc?.height === 'number') waypoint.height = tokenDoc.height;
    if (tokenDoc?.shape != null) waypoint.shape = tokenDoc.shape;
    if (typeof tokenDoc?.movementAction === 'string') waypoint.action = tokenDoc.movementAction;
    if (typeof context?.phase === 'string') waypoint.phase = context.phase;

    const movementEntry = {
      waypoints: [waypoint],
      method: options?.method || 'dragging'
    };

    const constrainOptions = this._getFoundryConstrainOptions(options);
    if (Object.keys(constrainOptions).length > 0) {
      movementEntry.constrainOptions = constrainOptions;
    }

    const id = String(update?._id || tokenDoc?.id || '');
    if (!id) return updateOptions;

    updateOptions.movement = {
      ...(updateOptions.movement || {}),
      [id]: movementEntry
    };

    return updateOptions;
  }

  /**
   * @param {object} options
   * @returns {{ignoreWalls?:boolean, ignoreCost?:boolean}}
   */
  _getFoundryConstrainOptions(options = {}) {
    /** @type {{ignoreWalls?:boolean, ignoreCost?:boolean}} */
    const constrainOptions = {};
    if (optionsBoolean(options?.ignoreWalls, false)) constrainOptions.ignoreWalls = true;
    if (optionsBoolean(options?.ignoreCost, false)) constrainOptions.ignoreCost = true;
    return constrainOptions;
  }

  /**
   * Ask Foundry for a constrained movement path for parity fallback checks.
   * @param {object} params
   * @param {TokenDocument|object} params.tokenDoc
   * @param {{x:number,y:number}} params.startTopLeft
   * @param {{x:number,y:number}} params.endTopLeft
   * @param {boolean} params.ignoreWalls
   * @param {boolean} params.ignoreCost
   * @returns {Promise<{ok:boolean,pathNodes:Array<{x:number,y:number}>,reason?:string}>}
   */
  async _computeFoundryParityPath({ tokenDoc, startTopLeft, endTopLeft, ignoreWalls, ignoreCost }) {
    const tokenObj = tokenDoc?.object || canvas?.tokens?.get?.(tokenDoc?.id) || null;
    if (!tokenObj || typeof tokenObj.findMovementPath !== 'function') {
      this._pathfindingLog('warn', '_computeFoundryParityPath unavailable: token object has no findMovementPath', {
        token: this._pathfindingTokenMeta(tokenDoc),
        startTopLeft,
        endTopLeft,
        ignoreWalls,
        ignoreCost
      });
      return { ok: false, pathNodes: [], reason: 'no-find-movement-path' };
    }

    const waypoints = [
      {
        x: asNumber(startTopLeft?.x, asNumber(tokenDoc?.x, 0)),
        y: asNumber(startTopLeft?.y, asNumber(tokenDoc?.y, 0)),
        elevation: asNumber(tokenDoc?.elevation, 0),
        width: asNumber(tokenDoc?.width, 1),
        height: asNumber(tokenDoc?.height, 1),
        shape: tokenDoc?.shape,
        action: tokenDoc?.movementAction,
        explicit: true,
        checkpoint: true
      },
      {
        x: asNumber(endTopLeft?.x, asNumber(startTopLeft?.x, 0)),
        y: asNumber(endTopLeft?.y, asNumber(startTopLeft?.y, 0)),
        elevation: asNumber(tokenDoc?.elevation, 0),
        width: asNumber(tokenDoc?.width, 1),
        height: asNumber(tokenDoc?.height, 1),
        shape: tokenDoc?.shape,
        action: tokenDoc?.movementAction,
        explicit: true,
        checkpoint: true
      }
    ];

    const searchOptions = {
      preview: false,
      history: false,
      delay: 0,
      ...this._getFoundryConstrainOptions({ ignoreWalls, ignoreCost })
    };

    try {
      const job = tokenObj.findMovementPath(waypoints, searchOptions);
      let result = Array.isArray(job?.result) ? job.result : [];
      if ((!Array.isArray(result) || result.length === 0) && job?.promise && typeof job.promise.then === 'function') {
        result = await job.promise;
      }
      if (!Array.isArray(result) || result.length < 2) {
        this._pathfindingLog('warn', '_computeFoundryParityPath returned empty/short path', {
          token: this._pathfindingTokenMeta(tokenDoc),
          startTopLeft,
          endTopLeft,
          ignoreWalls,
          ignoreCost,
          resultLength: Array.isArray(result) ? result.length : -1
        });
        return { ok: false, pathNodes: [], reason: 'empty-foundry-path' };
      }

      const pathNodes = result.map((wp) => this._tokenTopLeftToCenter({ x: wp?.x, y: wp?.y }, {
        ...tokenDoc,
        width: wp?.width ?? tokenDoc?.width,
        height: wp?.height ?? tokenDoc?.height
      }));

      return { ok: true, pathNodes };
    } catch (error) {
      this._pathfindingLog('warn', 'Foundry parity path query failed', {
        token: this._pathfindingTokenMeta(tokenDoc),
        startTopLeft,
        endTopLeft,
        ignoreWalls,
        ignoreCost
      }, error);
      return { ok: false, pathNodes: [], reason: 'find-movement-path-error' };
    }
  }

  /**
   * @param {object} params
   * @param {{ok?:boolean,pathNodes?:Array<{x:number,y:number}>}} params.customPathResult
   * @param {{ok?:boolean,pathNodes?:Array<{x:number,y:number}>}} params.foundryPathResult
   * @param {{x:number,y:number}} params.startCenter
   * @param {{x:number,y:number}} params.endCenter
   * @param {number} params.gridSize
   * @param {boolean} params.forceFoundryParity
   * @returns {{ok:boolean,pathNodes:Array<{x:number,y:number}>,reason?:string}}
   */
  _selectPathWithFoundryParity({ customPathResult, foundryPathResult, startCenter, endCenter, gridSize, forceFoundryParity }) {
    const customPath = Array.isArray(customPathResult?.pathNodes) ? customPathResult.pathNodes.slice() : [];
    const foundryPath = Array.isArray(foundryPathResult?.pathNodes) ? foundryPathResult.pathNodes.slice() : [];

    const normalizePath = (nodes) => {
      if (!Array.isArray(nodes) || nodes.length < 2) {
        return [startCenter, endCenter];
      }
      const out = nodes.slice();
      out[0] = startCenter;
      out[out.length - 1] = endCenter;
      return out;
    };

    const normalizedCustom = normalizePath(customPath);
    const normalizedFoundry = normalizePath(foundryPath);

    if (forceFoundryParity && foundryPathResult?.ok) {
      return { ok: true, pathNodes: normalizedFoundry };
    }

    if (!customPathResult?.ok && !foundryPathResult?.ok) {
      return { ok: false, pathNodes: [], reason: 'no-path' };
    }

    if (!customPathResult?.ok && foundryPathResult?.ok) {
      return { ok: true, pathNodes: normalizedFoundry };
    }

    if (!foundryPathResult?.ok) {
      return { ok: true, pathNodes: normalizedCustom };
    }

    const eps = Math.max(1, asNumber(gridSize, 100) * 0.45);
    const customEnd = normalizedCustom[normalizedCustom.length - 1];
    const endDelta = Math.hypot(customEnd.x - endCenter.x, customEnd.y - endCenter.y);
    if (endDelta > eps) {
      return { ok: true, pathNodes: normalizedFoundry };
    }

    const customLen = this._measurePathLength(normalizedCustom);
    const foundryLen = this._measurePathLength(normalizedFoundry);
    const lenDelta = Math.abs(customLen - foundryLen);
    const lenRel = lenDelta / Math.max(1, foundryLen);
    if (lenDelta > (asNumber(gridSize, 100) * 2) && lenRel > 0.35) {
      return { ok: true, pathNodes: normalizedFoundry };
    }

    return { ok: true, pathNodes: normalizedCustom };
  }

  /**
   * @param {Array<{x:number,y:number}>} nodes
   * @returns {number}
   */
  _measurePathLength(nodes) {
    if (!Array.isArray(nodes) || nodes.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < nodes.length; i++) {
      const a = nodes[i - 1];
      const b = nodes[i];
      total += Math.hypot(asNumber(b?.x, 0) - asNumber(a?.x, 0), asNumber(b?.y, 0) - asNumber(a?.y, 0));
    }
    return total;
  }

  // ── Door Detection Helpers ────────────────────────────────────────────────

  /**
   * Scan Foundry walls for door segments that intersect a straight-line
   * path between two Foundry-coordinate points. Returns metadata about
   * each door encountered, ordered by distance from the start point.
   *
   * Uses Foundry-coordinate space (top-left origin, Y-down). Callers must
   * convert to/from Three world coords externally.
   *
   * @param {{x: number, y: number}} start - Foundry-space start point
   * @param {{x: number, y: number}} end - Foundry-space end point
   * @returns {Array<DoorHit>} Sorted by distance from start
   *
   * @typedef {object} DoorHit
   * @property {string} wallId - Foundry wall document ID
   * @property {number} door - CONST.WALL_DOOR_TYPES value (1=DOOR, 2=SECRET)
   * @property {number} ds - CONST.WALL_DOOR_STATES value (0=CLOSED, 1=OPEN, 2=LOCKED)
   * @property {boolean} isOpen
   * @property {boolean} isLocked
   * @property {boolean} isSecret
   * @property {{x: number, y: number}} intersection - Intersection point in Foundry coords
   * @property {{x: number, y: number}} midpoint - Wall midpoint (approx door location)
   * @property {number} distance - Distance from start to intersection
   * @property {boolean} canPlayerOpen - Whether a non-GM player can open this door
   * @property {boolean} canUserOpen - Whether current user can request OPEN on this door
   */
  findDoorsAlongSegment(start, end) {
    const results = [];

    const sx = asNumber(start?.x, 0);
    const sy = asNumber(start?.y, 0);
    const ex = asNumber(end?.x, 0);
    const ey = asNumber(end?.y, 0);

    const doorIndex = this._buildDoorSpatialIndex();
    const candidates = this._getDoorWallCandidatesForSegment(start, end, doorIndex);
    if (!Array.isArray(candidates) || candidates.length === 0) return results;

    for (const candidate of candidates) {
      const doc = candidate?.doc || candidate?.wall?.document;
      if (!doc) continue;

      // Skip non-door walls
      const doorType = asNumber(doc.door, DOOR_TYPES.NONE);
      if (doorType <= DOOR_TYPES.NONE) continue;

      // Wall segment coordinates [x0, y0, x1, y1]
      const c = Array.isArray(candidate?.c) ? candidate.c : doc.c;
      if (!c || c.length < 4) continue;

      // Line-line intersection test
      const hit = _segmentIntersection(
        sx, sy, ex, ey,
        c[0], c[1], c[2], c[3]
      );
      if (!hit) continue;

      const ds = asNumber(doc.ds, DOOR_STATES.CLOSED);
      const canUserOpen = this._canCurrentUserSetDoorState(doc, DOOR_STATES.OPEN);

      results.push({
        wallId: doc.id || doc._id || '',
        door: doorType,
        ds,
        isOpen: ds === DOOR_STATES.OPEN,
        isLocked: ds === DOOR_STATES.LOCKED,
        isSecret: doorType === DOOR_TYPES.SECRET,
        intersection: { x: hit.x, y: hit.y },
        midpoint: { x: (c[0] + c[2]) / 2, y: (c[1] + c[3]) / 2 },
        distance: Math.hypot(hit.x - sx, hit.y - sy),
        canPlayerOpen: _canPlayerOpenDoor(ds, doorType),
        canUserOpen
      });
    }

    // Sort by distance from start
    results.sort((a, b) => a.distance - b.distance);
    return results;
  }

  /**
   * Given a sequence of Foundry-space path nodes, find all doors along the
   * entire path. Each segment between consecutive nodes is tested.
   *
   * @param {Array<{x: number, y: number}>} pathNodes
   * @returns {Array<DoorHit & {segmentIndex: number}>}
   */
  findDoorsAlongPath(pathNodes) {
    if (!Array.isArray(pathNodes) || pathNodes.length < 2) return [];

    const allHits = [];
    for (let i = 0; i < pathNodes.length - 1; i++) {
      const hits = this.findDoorsAlongSegment(pathNodes[i], pathNodes[i + 1]);
      for (const hit of hits) {
        allHits.push({ ...hit, segmentIndex: i });
      }
    }
    return allHits;
  }

  /**
   * Build a door-aware movement plan from a path. Inserts synthetic
   * preDoorHold and postDoorEntry nodes around each closed door.
   *
   * @param {Array<{x: number, y: number}>} pathNodes
   * @returns {{
   *   pathNodes: Array<object>,
   *   doorSteps: Array<DoorStep>,
   *   doorRevision: number,
   *   inCombat: boolean
   * }}
   *
   * @typedef {object} DoorStep
   * @property {string} wallId
   * @property {number} door
   * @property {number} ds
   * @property {boolean} requiresOpen - True if door is closed/locked and must be opened
   * @property {boolean} canOpen - True if current user has permission to open
   * @property {boolean} autoOpen - Policy flag indicating whether automation is enabled
   * @property {string|null} blockedReason - Null when openable, otherwise a non-sensitive block reason
   * @property {{x: number, y: number}} holdPoint - Where token pauses before door
   * @property {{x: number, y: number}} entryPoint - First valid point after crossing
   * @property {boolean} closeAfterCrossing - Policy-derived close recommendation
   * @property {number} segmentIndex
   */
  buildDoorAwarePlan(pathNodes = []) {
    const nodes = Array.isArray(pathNodes) ? pathNodes : [];
    const doorSteps = [];

    if (nodes.length >= 2) {
      const doorHits = this.findDoorsAlongPath(nodes);
      const holdOffset = 8; // pixels before door

      for (const hit of doorHits) {
        const requiresOpen = hit.ds !== DOOR_STATES.OPEN;
        if (!requiresOpen) continue;

        const isGM = !!game?.user?.isGM;
        const autoOpen = !!this.settings.doorPolicy.autoOpen;
        const autoDoorAllowedForUser = isGM || !!this.settings.doorPolicy.playerAutoDoorEnabled;

        const wallDoc = this._resolveWallDocument(hit.wallId);
        const permissionOk = this.settings.doorPolicy.requireDoorPermission
          ? this._canCurrentUserSetDoorState(wallDoc, DOOR_STATES.OPEN)
          : true;

        let blockedReason = null;
        if (!autoOpen) blockedReason = 'auto-open-disabled';
        else if (!autoDoorAllowedForUser) blockedReason = 'player-auto-door-disabled';
        else if (hit.ds === DOOR_STATES.LOCKED && !isGM) blockedReason = 'locked';
        else if (!permissionOk) blockedReason = 'permission-denied';

        const canOpen = blockedReason === null;

        // Compute hold point: offset back from intersection along path direction
        const seg = nodes[hit.segmentIndex];
        const segNext = nodes[hit.segmentIndex + 1];
        if (!seg || !segNext) continue;

        const dx = segNext.x - seg.x;
        const dy = segNext.y - seg.y;
        const segLen = Math.hypot(dx, dy);
        if (segLen < 1) continue;

        const nx = dx / segLen;
        const ny = dy / segLen;

        const holdPoint = {
          x: hit.intersection.x - nx * holdOffset,
          y: hit.intersection.y - ny * holdOffset
        };
        const entryPoint = {
          x: hit.intersection.x + nx * holdOffset,
          y: hit.intersection.y + ny * holdOffset
        };

        // Evaluate close policy
        let closeAfterCrossing = false;
        const policy = this.settings.doorPolicy.autoClose;
        if (policy === 'always') {
          closeAfterCrossing = true;
        } else if (policy === 'outOfCombatOnly') {
          closeAfterCrossing = !this._inCombat;
        } else if (policy === 'combatOnly') {
          closeAfterCrossing = this._inCombat;
        }
        // 'never' → false (default)

        doorSteps.push({
          wallId: hit.wallId,
          door: hit.door,
          ds: hit.ds,
          requiresOpen,
          canOpen,
          autoOpen,
          blockedReason,
          holdPoint,
          entryPoint,
          closeAfterCrossing,
          segmentIndex: hit.segmentIndex
        });
      }
    }

    return {
      pathNodes: nodes,
      doorSteps,
      doorRevision: this._doorStateRevision,
      inCombat: this._inCombat
    };
  }

  // ── Fog-Safe Path Visibility ──────────────────────────────────────────────

  /**
   * Test whether a Foundry-space point is visible or explored for the current
   * player. Uses Foundry's native fog and visibility APIs.
   *
   * @param {{x: number, y: number}} point - Foundry-coordinate point
   * @returns {boolean}
   */
  isPointVisibleToPlayer(point) {
    // GM always sees everything
    if (game?.user?.isGM) return true;

    const px = asNumber(point?.x, 0);
    const py = asNumber(point?.y, 0);

    // Check explored fog first (cheaper)
    try {
      if (canvas?.fog?.isPointExplored?.({ x: px, y: py })) return true;
    } catch (_) {
    }

    // Then check active visibility (token vision LOS)
    try {
      if (canvas?.visibility?.testVisibility?.({ x: px, y: py }, { tolerance: 1 })) return true;
    } catch (_) {
    }

    return false;
  }

  /**
   * Apply fog-safe redaction policy to a path for player-facing preview.
   * When no custom visibility function is provided, uses Foundry's native
   * fog/visibility APIs via isPointVisibleToPlayer().
   *
   * @param {Array<object>} pathNodes - Path nodes with {x, y} in Foundry coords
   * @param {(node: object, index: number) => boolean} [isNodeVisible] - Override visibility test
   * @returns {{visiblePath: Array<object>, hasHiddenTail: boolean, hiddenStartIndex: number}}
   */
  redactPathForPlayer(pathNodes = [], isNodeVisible = null) {
    if (!Array.isArray(pathNodes) || pathNodes.length === 0) {
      return { visiblePath: [], hasHiddenTail: false, hiddenStartIndex: -1 };
    }

    // GM bypass — no redaction needed
    if (this.settings.fogPathPolicy === 'gmUnrestricted' || game?.user?.isGM) {
      return {
        visiblePath: pathNodes.slice(),
        hasHiddenTail: false,
        hiddenStartIndex: -1
      };
    }

    // Use provided visibility function or fall back to native fog/visibility check
    const visibleFn = (typeof isNodeVisible === 'function')
      ? isNodeVisible
      : (node) => this.isPointVisibleToPlayer(node);

    let hiddenStartIndex = -1;
    const visiblePath = [];

    for (let i = 0; i < pathNodes.length; i++) {
      const node = pathNodes[i];
      const visible = !!visibleFn(node, i);
      if (!visible) {
        hiddenStartIndex = i;
        break;
      }
      visiblePath.push(node);
    }

    const hasHiddenTail = hiddenStartIndex >= 0;

    // Both strictNoFogPath and allowButRedact avoid revealing hidden geometry.
    // The difference is in planner search scope (implemented in A* phase later):
    // - strictNoFogPath: planner treats hidden nodes as blocked
    // - allowButRedact: planner may search beyond, but preview is truncated
    return {
      visiblePath,
      hasHiddenTail,
      hiddenStartIndex
    };
  }

  // ── Settings & Policy ─────────────────────────────────────────────────────

  /**
   * Merge partial door policy updates.
   * @param {object} patch
   */
  setDoorPolicy(patch) {
    if (!patch || typeof patch !== 'object') return;
    this.settings.doorPolicy = {
      ...this.settings.doorPolicy,
      ...patch
    };
  }

  /**
   * @param {'strictNoFogPath'|'allowButRedact'|'gmUnrestricted'} policy
   */
  setFogPathPolicy(policy) {
    if (!FOG_PATH_POLICIES.has(policy)) return;
    this.settings.fogPathPolicy = policy;
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────

  /**
   * Snapshot helper for implementation progress diagnostics.
   */
  getImplementationStatus() {
    return {
      initialized: this.initialized,
      styleCount: this.styles.size,
      activeTrackCount: this.activeTracks.size,
      flyingTokenCount: this.flyingTokens.size,
      pathSearchGeneration: this._pathSearchGeneration,
      weightedAStarWeight: this.settings.weightedAStarWeight,
      doorPolicy: { ...this.settings.doorPolicy },
      fogPathPolicy: this.settings.fogPathPolicy,
      inCombat: this._inCombat,
      doorStateRevision: this._doorStateRevision
    };
  }
}

// ── Module-level helpers (not exported) ───────────────────────────────────────

/**
 * Segment-segment intersection test. Returns intersection point or null.
 * Segments are (ax,ay)→(bx,by) and (cx,cy)→(dx,dy).
 * @returns {{x: number, y: number, t: number, u: number}|null}
 */
function _segmentIntersection(ax, ay, bx, by, cx, cy, dx, dy) {
  const denom = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  if (Math.abs(denom) < 1e-10) return null; // Parallel or collinear

  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / denom;
  const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / denom;

  if (t < 0 || t > 1 || u < 0 || u > 1) return null; // No intersection within segments

  return {
    x: ax + t * (bx - ax),
    y: ay + t * (by - ay),
    t,
    u
  };
}

/**
 * Determine if a non-GM player can open a door based on its current state
 * and type. Mirrors Foundry's BaseWall.#canUpdate permission logic.
 *
 * @param {number} ds - Current door state (CONST.WALL_DOOR_STATES)
 * @param {number} doorType - Door type (CONST.WALL_DOOR_TYPES)
 * @returns {boolean}
 */
function _canPlayerOpenDoor(ds, doorType) {
  // Secret doors are invisible to players (no door control shown)
  if (doorType === DOOR_TYPES.SECRET) return false;

  // Locked doors cannot be opened by players
  if (ds === DOOR_STATES.LOCKED) return false;

  // Players can toggle between CLOSED and OPEN for normal unlocked doors
  return true;
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, asNumber(ms, 0))));
}

/**
 * @param {any} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function optionsBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  return fallback;
}
