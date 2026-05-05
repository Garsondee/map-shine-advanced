import { createLogger } from '../core/log.js';
import { readWallHeightFlags } from '../foundry/levels-scene-flags.js';

const log = createLogger('NavMeshBuilder');

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function readFloorRange(obj, bottomKeys, topKeys) {
  if (!obj || typeof obj !== 'object') return null;
  let bottom = NaN;
  let top = NaN;

  for (const key of bottomKeys) {
    bottom = asNumber(obj?.[key], NaN);
    if (Number.isFinite(bottom)) break;
  }
  for (const key of topKeys) {
    top = asNumber(obj?.[key], NaN);
    if (Number.isFinite(top)) break;
  }

  if (!Number.isFinite(bottom) || !Number.isFinite(top)) return null;
  return { bottom, top };
}

function readPoint(obj, xKeys, yKeys) {
  if (!obj || typeof obj !== 'object') return null;
  let x = NaN;
  let y = NaN;
  for (const key of xKeys) {
    x = asNumber(obj?.[key], NaN);
    if (Number.isFinite(x)) break;
  }
  for (const key of yKeys) {
    y = asNumber(obj?.[key], NaN);
    if (Number.isFinite(y)) break;
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/**
 * NavMeshBuilder (foundation)
 *
 * Phase-1 implementation builds a scene navigation snapshot:
 * - blocking wall segments (closed doors included, open doors excluded)
 * - scene rect and floor metadata
 * - staircase/portal candidates from Levels regions and MapShine mask tags (best-effort)
 *
 * This snapshot is intentionally lightweight and can be built during loading.
 * Pathfinding integration can incrementally consume this snapshot in later phases.
 */
export class NavMeshBuilder {
  constructor() {
    this._lastSnapshot = null;
  }

  /** @returns {object|null} */
  get lastSnapshot() {
    return this._lastSnapshot;
  }

  /**
   * @param {object} [options]
   * @param {boolean} [options.force=false]
   * @returns {object|null}
   */
  buildSnapshot({ force = false } = {}) {
    const sceneId = String(canvas?.scene?.id || '');
    if (!sceneId) return null;

    const sceneRect = canvas?.dimensions?.sceneRect
      ? {
          x: asNumber(canvas.dimensions.sceneRect.x, 0),
          y: asNumber(canvas.dimensions.sceneRect.y, 0),
          width: asNumber(canvas.dimensions.sceneRect.width, 0),
          height: asNumber(canvas.dimensions.sceneRect.height, 0)
        }
      : {
          x: 0,
          y: 0,
          width: asNumber(canvas?.dimensions?.width, 0),
          height: asNumber(canvas?.dimensions?.height, 0)
        };

    const wallSegments = this._collectBlockingWallSegments();
    const portalCandidates = this._collectPortalCandidates();
    const revisionToken = this._computeRevisionToken(sceneId, wallSegments);

    if (!force && this._lastSnapshot?.sceneId === sceneId && this._lastSnapshot?.revisionToken === revisionToken) {
      return this._lastSnapshot;
    }

    const snapshot = {
      sceneId,
      builtAtMs: Date.now(),
      revisionToken,
      sceneRect,
      wallSegments,
      portalCandidates
    };

    this._lastSnapshot = snapshot;
    return snapshot;
  }

  _collectBlockingWallSegments() {
    const placeables = Array.isArray(canvas?.walls?.placeables) ? canvas.walls.placeables : [];
    const out = [];

    for (const wall of placeables) {
      const doc = wall?.document ?? wall;
      const c = doc?.c;
      if (!Array.isArray(c) || c.length < 4) continue;

      const doorType = asNumber(doc?.door, 0);
      const doorState = asNumber(doc?.ds, 0);
      const isDoor = doorType > 0;
      const isOpenDoor = isDoor && doorState === 1;
      if (isOpenDoor) continue;
      const wallBounds = readWallHeightFlags(doc);

      out.push({
        wallId: String(doc?.id || ''),
        ax: asNumber(c[0], 0),
        ay: asNumber(c[1], 0),
        bx: asNumber(c[2], 0),
        by: asNumber(c[3], 0),
        bottom: asNumber(wallBounds?.bottom, -Infinity),
        top: asNumber(wallBounds?.top, Infinity),
        doorType,
        doorState
      });
    }

    return out;
  }

  _collectPortalCandidates() {
    const portals = [];

    // Best-effort Levels region based detection.
    const regions = Array.isArray(canvas?.scene?.regions) ? canvas.scene.regions : [];
    for (const region of regions) {
      const behaviors = Array.isArray(region?.behaviors) ? region.behaviors : [];
      for (const behavior of behaviors) {
        const type = String(behavior?.type || behavior?.system?.type || '').toLowerCase();
        if (!type.includes('stair') && !type.includes('teleport') && !type.includes('portal')) continue;

        const behaviorSystem = behavior?.system && typeof behavior.system === 'object'
          ? behavior.system
          : {};
        const fromFloor = readFloorRange(
          behaviorSystem,
          ['fromBottom', 'sourceBottom', 'entryBottom', 'bottom', 'fromElevation', 'sourceElevation'],
          ['fromTop', 'sourceTop', 'entryTop', 'top', 'fromElevationMax', 'sourceElevationMax']
        );
        const toFloor = readFloorRange(
          behaviorSystem,
          ['toBottom', 'targetBottom', 'exitBottom', 'destBottom', 'toElevation', 'targetElevation'],
          ['toTop', 'targetTop', 'exitTop', 'destTop', 'toElevationMax', 'targetElevationMax']
        );

        const shape = region?.shape ?? null;
        const center = shape && Number.isFinite(shape?.x) && Number.isFinite(shape?.y)
          ? { x: asNumber(shape.x, 0), y: asNumber(shape.y, 0) }
          : null;
        const entry = readPoint(
          behaviorSystem,
          ['entryX', 'fromX', 'sourceX', 'startX'],
          ['entryY', 'fromY', 'sourceY', 'startY']
        );
        const exit = readPoint(
          behaviorSystem,
          ['exitX', 'toX', 'targetX', 'destX', 'endX'],
          ['exitY', 'toY', 'targetY', 'destY', 'endY']
        );

        portals.push({
          portalId: String(region?.id || behavior?.id || ''),
          source: 'levels-region',
          center,
          entry,
          exit,
          fromFloor,
          toFloor,
          travelTimeMs: asNumber(behaviorSystem?.travelTimeMs, 400),
          bidirectional: behaviorSystem?.bidirectional !== false
        });
      }
    }

    // Best-effort mask/tile tags (future-ready hook point).
    const tileManager = window.MapShine?.tileManager;
    const tileSprites = tileManager?.tileSprites instanceof Map ? tileManager.tileSprites : null;
    if (tileSprites) {
      for (const [tileId, data] of tileSprites.entries()) {
        const doc = data?.tileDoc;
        const tags = doc?.flags?.['map-shine-advanced']?.tags;
        if (!Array.isArray(tags)) continue;
        const hasPortalTag = tags.some((t) => /stairs|portal/i.test(String(t || '')));
        if (!hasPortalTag) continue;

        const x = asNumber(doc?.x, 0);
        const y = asNumber(doc?.y, 0);
        const w = asNumber(doc?.width, 0);
        const h = asNumber(doc?.height, 0);
        const msFlags = doc?.flags?.['map-shine-advanced'] || {};
        const fromFloor = readFloorRange(
          msFlags,
          ['portalFromBottom', 'fromBottom', 'stairsFromBottom'],
          ['portalFromTop', 'fromTop', 'stairsFromTop']
        );
        const toFloor = readFloorRange(
          msFlags,
          ['portalToBottom', 'toBottom', 'stairsToBottom'],
          ['portalToTop', 'toTop', 'stairsToTop']
        );

        portals.push({
          portalId: String(tileId || ''),
          source: 'tile-tag',
          center: { x: x + (w * 0.5), y: y + (h * 0.5) },
          entry: readPoint(
            msFlags,
            ['portalEntryX', 'entryX', 'stairsEntryX', 'fromX', 'portalFromX'],
            ['portalEntryY', 'entryY', 'stairsEntryY', 'fromY', 'portalFromY']
          ),
          exit: readPoint(
            msFlags,
            ['portalExitX', 'exitX', 'stairsExitX', 'toX', 'portalToX'],
            ['portalExitY', 'exitY', 'stairsExitY', 'toY', 'portalToY']
          ),
          fromFloor,
          toFloor,
          travelTimeMs: asNumber(msFlags?.portalTravelTimeMs, 400),
          bidirectional: msFlags?.portalBidirectional !== false
        });
      }
    }

    return portals;
  }

  _computeRevisionToken(sceneId, wallSegments) {
    const segmentHash = wallSegments
      .map((s) => `${s.wallId}|${Math.round(s.ax)}:${Math.round(s.ay)}:${Math.round(s.bx)}:${Math.round(s.by)}|${s.bottom}:${s.top}|${s.doorType}:${s.doorState}`)
      .join(';');
    return `${sceneId}|${segmentHash.length}|${segmentHash}`;
  }

  logSnapshotSummary(snapshot = this._lastSnapshot) {
    if (!snapshot) return;
    log.debug('navmesh snapshot ready', {
      sceneId: snapshot.sceneId,
      revisionTokenLength: String(snapshot.revisionToken || '').length,
      wallSegmentCount: Array.isArray(snapshot.wallSegments) ? snapshot.wallSegments.length : 0,
      portalCandidateCount: Array.isArray(snapshot.portalCandidates) ? snapshot.portalCandidates.length : 0,
      sceneRect: snapshot.sceneRect
    });
  }
}
