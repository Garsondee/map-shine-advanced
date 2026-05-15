/**
 * @fileoverview Computes 2D visibility polygons using raycasting
 * Based on Red Blob Games visibility algorithm
 * @see https://www.redblobgames.com/articles/visibility/
 * @module vision/VisionPolygonComputer
 */

import { createLogger } from '../core/log.js';
import { readTileLevelsFlags, tileHasLevelsRange, hasV14NativeLevels, readWallHeightFlags } from '../foundry/levels-scene-flags.js';
import { tileDocRestrictsLight } from '../scene/tile-manager.js';

const log = createLogger('VisionPolygonComputer');

/**
 * True when a wall is a door that is open for LOS purposes.
 * Coerces `ds` — some Foundry / sync payloads use string door states.
 * @param {object|null|undefined} doc
 * @returns {boolean}
 */
function wallDocDoorIsOpenForVision(doc) {
  const open = (typeof CONST !== 'undefined' && CONST.WALL_DOOR_STATES)
    ? CONST.WALL_DOOR_STATES.OPEN
    : 1;
  return Number(doc?.door) > 0 && Number(doc?.ds) === open;
}

/**
 * Computes line-of-sight visibility polygons from wall data
 */
export class VisionPolygonComputer {
  constructor() {
    /** @type {number} Number of segments for boundary circle when no walls nearby */
    this.circleSegments = 32;
    
    /** @type {number} Small offset for casting rays past endpoints */
    this.epsilon = 0.0001;

    // PERFORMANCE: Reusable object pools to avoid per-frame allocations
    // These are cleared and reused each compute() call instead of creating new arrays/objects.
    this._segmentsPool = [];
    this._endpointsPool = [];
    this._intersectionsPool = [];
    this._pointsPool = [];
    this._seenAnglesSet = new Set();
    this._endpointMap = new Map();
    
    // PERFORMANCE: Typed array for blistering fast angle sorting
    this._anglesArray = new Float64Array(4096);
    
    // Reusable temp objects for closestPointOnSegment
    this._tempClosest = { x: 0, y: 0 };
    this._tempRayEnd = { x: 0, y: 0 };
    this._tempHit = { x: 0, y: 0 };
    this._tempSegA = { x: 0, y: 0 };
    this._tempSegB = { x: 0, y: 0 };
    this._tempThresholdTarget = { x: 0, y: 0 };

    /** @type {{x:number,y:number}[]} Reused quad corners for restrict-light tiles */
    this._restrictLightTileCorners = [
      { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 },
    ];
  }

  /**
   * Compute visibility polygon for a point
   * @param {{x: number, y: number}} center - Token center in Foundry coordinates
   * @param {number} radius - Vision radius in pixels
   * @param {Wall[]} walls - Array of wall placeables (optional, defaults to canvas.walls.placeables)
   * @param {{x: number, y: number, width: number, height: number}} [sceneBounds] - Optional scene bounds to clip vision
   * @param {{sense?: 'sight'|'light', elevation?: number, forceClosedDoorWallIds?: Set<string>, skipDoorWallIds?: Set<string>, additionalSegments?: Array<{x0:number,y0:number,x1:number,y1:number}>}|null} [options] - Optional compute mode, viewer elevation, and door walls to treat as closed or replaced by animated blocker segments.
   * @returns {number[]} Flat array [x0, y0, x1, y1, ...] in Foundry coordinates
   */
  compute(center, radius, walls = null, sceneBounds = null, options = null) {
    if (!center || radius <= 0) {
      log.debug(`compute() early return: center=${JSON.stringify(center)}, radius=${radius}`);
      return [];
    }

    // Get walls from canvas if not provided
    const allWalls = walls ?? canvas?.walls?.placeables ?? [];

    const sense = (options && options.sense === 'light') ? 'light' : 'sight';
    const elevation = (options && typeof options.elevation === 'number' && Number.isFinite(options.elevation))
      ? options.elevation : undefined;
    const forceClosedDoorWallIds = (options && options.forceClosedDoorWallIds instanceof Set
      && options.forceClosedDoorWallIds.size > 0)
      ? options.forceClosedDoorWallIds
      : null;
    const skipDoorWallIds = (options && options.skipDoorWallIds instanceof Set
      && options.skipDoorWallIds.size > 0)
      ? options.skipDoorWallIds
      : null;
    const additionalSegments = Array.isArray(options?.additionalSegments)
      ? options.additionalSegments
      : null;

    // Convert walls to segments (filtering inline to avoid allocations).
    // When an elevation is provided, walls whose wall-height bounds don't
    // include that elevation are skipped (MS-LVL-072).
    const segments = this._segmentsPool;
    segments.length = 0;
    this.wallsToSegments(allWalls, center, radius, sense, segments, elevation, forceClosedDoorWallIds, skipDoorWallIds);
    if (additionalSegments?.length) {
      this.appendAdditionalSegments(additionalSegments, center, radius, segments);
    }
    if (sense === 'light') {
      this.restrictLightTilesToSegments(center, radius, segments, elevation);
    }

    // Add scene boundary segments if provided (clips vision to scene interior)
    if (sceneBounds) {
      this.createRectangleBoundary(sceneBounds, center, radius, segments);
    }
    
    // Add boundary circle segments
    this.createBoundaryCircle(center, radius, this.circleSegments, segments);
    
    if (Math.random() < 0.01) {
      log.debug(`compute(): center=(${center.x.toFixed(0)}, ${center.y.toFixed(0)}), radius=${radius.toFixed(0)}, walls=${allWalls.length}, segments=${segments.length}`);
    }
    
    // If no segments at all, return a simple circle
    if (segments.length === 0) {
      return this.createCirclePolygon(center, radius, this.circleSegments, this._pointsPool);
    }
    
    // Collect unique endpoints within radius
    const endpoints = this.collectEndpoints(segments, center, radius);
    
    // OPTIMIZATION: Extract, sort, and deduplicate angles before casting rays
    const sortedAngles = this._extractAndSortAngles(endpoints);
    
    // Cast rays in angular order and build polygon
    const points = this._pointsPool;
    points.length = 0;
    
    let prevAngle = -999;
    for (let i = 0; i < sortedAngles.length; i++) {
      const angle = sortedAngles[i];
      
      // Deduplicate on the fly (replaces the need for a Hash Set)
      if (Math.abs(angle - prevAngle) < 1e-6) continue;
      prevAngle = angle;
      
      // Points are pushed in perfect angular order!
      const hit = this.castRay(center, angle, segments, radius, this._tempHit);
      points.push(hit.x, hit.y);
    }
    
    // Validate polygon
    if (points.length < 6) {
      // Fallback to circle if polygon is degenerate
      return this.createCirclePolygon(center, radius, this.circleSegments, points);
    }
    
    return points;
  }

  /**
   * Filter walls that block vision
   * @param {Wall[]} walls - Array of wall placeables
   * @returns {Wall[]} Walls that block sight
   */
  filterVisionBlockingWalls(walls) {
    return walls.filter(wall => {
      const doc = wall.document;
      if (!doc) return false;
      
      // CONST.WALL_SENSE_TYPES: 0=None, 10=Limited, 20=Normal
      // Skip walls that don't block sight at all
      if (doc.sight === 0) return false;
      
      // Skip open doors.
      if (wallDocDoorIsOpenForVision(doc)) return false;
      
      // TODO: Handle one-way walls (doc.dir)
      // TODO: Handle limited sight walls (doc.sight === 10) with partial transparency
      
      return true;
    });
  }

  /**
   * Filter walls that block light
   * @param {Wall[]} walls - Array of wall placeables
   * @returns {Wall[]} Walls that block light
   */
  filterLightBlockingWalls(walls) {
    return walls.filter(wall => {
      const doc = wall.document;
      if (!doc) return false;

      // CONST.WALL_SENSE_TYPES: 0=None, 10=Limited, 20=Normal
      if (doc.light === 0) return false;

      // Skip open doors.
      if (wallDocDoorIsOpenForVision(doc)) return false;

      // TODO: Handle one-way walls (doc.dir)
      // TODO: Handle limited light walls (doc.light === 10) with partial transmission
      return true;
    });
  }

  /**
   * Convert wall placeables to segment objects
   * @param {Wall[]} walls - Filtered walls
   * @param {{x: number, y: number}} center - Vision origin
   * @param {number} radius - Vision radius
   * @param {string} sense - 'sight' or 'light'
   * @param {Array|null} outSegments - Output array (reused for perf)
   * @param {number|undefined} elevation - Viewer elevation for wall-height filtering (MS-LVL-072)
   * @param {Set<string>|null} [forceClosedDoorWallIds] - Wall document ids whose OPEN doors still emit LOS segments (door-fog seam base pass).
   * @param {Set<string>|null} [skipDoorWallIds] - Door wall document ids whose original wall segment is replaced by caller-supplied animated segments.
   * @returns {Array<{a: {x: number, y: number}, b: {x: number, y: number}}>}
   */
  wallsToSegments(walls, center, radius, sense = 'sight', outSegments = null, elevation = undefined, forceClosedDoorWallIds = null, skipDoorWallIds = null) {
    const segments = outSegments ?? [];
    let writeIndex = segments.length;
    const radiusSq = radius * radius;
    const WALL_DIRECTION_BOTH = 0;
    const WALL_DIRECTION_LEFT = 1;
    const WALL_DIRECTION_RIGHT = 2;
    const hasElevation = (elevation !== undefined);

    // MS-LVL-035: Pre-collect bounds of tiles with allWallBlockSight=true.
    // Walls whose midpoint falls within any such tile are forced to block
    // sight regardless of their wall type (overriding sight=0).
    let allBlockTileBounds = null;
    if (sense === 'sight'
        && hasV14NativeLevels(canvas?.scene)) {
      const tiles = canvas?.scene?.tiles;
      if (tiles) {
        for (const tileDoc of tiles) {
          if (!tileDoc || !tileHasLevelsRange(tileDoc)) continue;
          const flags = readTileLevelsFlags(tileDoc);
          if (!flags.allWallBlockSight) continue;

          // Only consider tiles visible at the viewer's elevation
          if (hasElevation) {
            const inRange = elevation >= flags.rangeBottom
              && (flags.rangeTop === Infinity || elevation < flags.rangeTop);
            if (!inRange) continue;
          }

          if (!allBlockTileBounds) allBlockTileBounds = [];
          allBlockTileBounds.push({
            x: Number(tileDoc.x ?? 0),
            y: Number(tileDoc.y ?? 0),
            w: Number(tileDoc.width ?? 0),
            h: Number(tileDoc.height ?? 0),
          });
        }
      }
    }
    
    for (const wall of walls) {
      const doc = wall?.document;
      if (!doc) continue;
      const wid = String(doc?.id ?? '');
      if (wid && Number(doc.door ?? 0) > 0 && skipDoorWallIds?.has(wid)) continue;

      // Inline filtering to avoid allocating a filtered walls array.
      // MS-LVL-035: If a wall's midpoint falls within an allWallBlockSight
      // tile, skip the sight=0 check and force it to block.
      if (sense === 'light') {
        if (doc.light === 0) continue;
      } else {
        if (doc.sight === 0) {
          // Check if this wall is overridden by allWallBlockSight tiles
          if (allBlockTileBounds) {
            const c = doc.c;
            if (c && c.length >= 4) {
              const mx = (c[0] + c[2]) * 0.5;
              const my = (c[1] + c[3]) * 0.5;
              let forced = false;
              for (const b of allBlockTileBounds) {
                if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) {
                  forced = true;
                  break;
                }
              }
              if (!forced) continue;
            } else {
              continue;
            }
          } else {
            continue;
          }
        }
      }
      // Skip open doors unless this wall id is forced closed for a door-fog seam pass.
      if (wallDocDoorIsOpenForVision(doc)) {
        if (!wid || !forceClosedDoorWallIds?.has(wid)) continue;
      }

      // MS-LVL-072: Wall-height filtering. Skip walls whose vertical
      // bounds don't include the viewer's elevation. This allows tokens
      // on one floor to see past walls that only exist on other floors.
      //
      // IMPORTANT: Use Levels-style top-exclusive ranges:
      //   inRange = elevation >= bottom && elevation < top
      // This avoids cross-floor blocking at shared floor boundaries
      // (e.g. lower wall top=10 should not block viewer elevation=10).
      if (hasElevation) {
        const { bottom: whBottomRaw, top: whTopRaw } = readWallHeightFlags(doc);
        let whBottom = whBottomRaw;
        let whTop = whTopRaw;
        // Swap if inverted
        if (whTop < whBottom) { const s = whBottom; whBottom = whTop; whTop = s; }
        const inWallRange = elevation >= whBottom && (whTop === Infinity || elevation < whTop);
        if (!inWallRange) continue;
      }

      const c = doc.c;
      if (!c || c.length < 4) continue;

      // MS-LVL-073: Respect Foundry threshold wall semantics (proximity/distance)
      // for custom LOS paths so non-normal wall senses don't become unconditional.
      if (!this._wallBlocksSenseWithThreshold(doc, sense, center, elevation)) continue;

      const ax = c[0];
      const ay = c[1];
      const bx = c[2];
      const by = c[3];

      // Directional walls only block rays from one side. Match Foundry's orient2dFast
      // convention where a negative orientation means LEFT, positive means RIGHT.
      const dir = doc.dir ?? WALL_DIRECTION_BOTH;
      if (dir !== WALL_DIRECTION_BOTH) {
        // orient2dFast(a, b, c) = (a.y - c.y) * (b.x - c.x) - (a.x - c.x) * (b.y - c.y)
        const orient = (ay - center.y) * (bx - center.x) - (ax - center.x) * (by - center.y);
        if (orient !== 0) {
          const side = orient < 0 ? WALL_DIRECTION_LEFT : WALL_DIRECTION_RIGHT;
          if (side !== dir) continue;
        }
      }
      
      // Quick rejection: skip segments entirely outside vision radius
      // Check if either endpoint is within radius, or if segment intersects radius circle
      const dxA = ax - center.x;
      const dyA = ay - center.y;
      const dxB = bx - center.x;
      const dyB = by - center.y;
      const distASq = dxA * dxA + dyA * dyA;
      const distBSq = dxB * dxB + dyB * dyB;
      
      if (distASq > radiusSq && distBSq > radiusSq) {
        // Both endpoints outside - check if segment passes through circle
        // OPTIMIZATION: Use scalar distance check instead of object method
        if (this._distToSegmentSq(center.x, center.y, ax, ay, bx, by) > radiusSq) continue;
      }

      let seg = segments[writeIndex];
      if (!seg || typeof seg !== 'object') {
        seg = { a: { x: 0, y: 0 }, b: { x: 0, y: 0 } };
        segments[writeIndex] = seg;
      } else {
        if (!seg.a) seg.a = { x: 0, y: 0 };
        if (!seg.b) seg.b = { x: 0, y: 0 };
      }

      seg.a.x = ax;
      seg.a.y = ay;
      seg.b.x = bx;
      seg.b.y = by;
      writeIndex++;
    }

    segments.length = writeIndex;
    return segments;
  }

  /**
   * Append caller-provided blocking segments, using the same pooled segment shape
   * and radius culling as wall segments.
   *
   * @param {Array<{x0:number,y0:number,x1:number,y1:number}>} sourceSegments
   * @param {{x: number, y: number}} center
   * @param {number} radius
   * @param {Array<{a:{x:number,y:number},b:{x:number,y:number}}>} segments
   * @returns {Array<{a:{x:number,y:number},b:{x:number,y:number}}>}
   */
  appendAdditionalSegments(sourceSegments, center, radius, segments) {
    if (!Array.isArray(sourceSegments) || !center || !(radius > 0) || !segments) return segments;

    const radiusSq = radius * radius;
    let writeIndex = segments.length;

    for (const source of sourceSegments) {
      const ax = Number(source?.x0);
      const ay = Number(source?.y0);
      const bx = Number(source?.x1);
      const by = Number(source?.y1);
      if (![ax, ay, bx, by].every(Number.isFinite)) continue;
      if (Math.hypot(bx - ax, by - ay) <= 0.001) continue;

      const dxA = ax - center.x;
      const dyA = ay - center.y;
      const dxB = bx - center.x;
      const dyB = by - center.y;
      const distASq = dxA * dxA + dyA * dyA;
      const distBSq = dxB * dxB + dyB * dyB;
      if (distASq > radiusSq && distBSq > radiusSq) {
        if (this._distToSegmentSq(center.x, center.y, ax, ay, bx, by) > radiusSq) continue;
      }

      let seg = segments[writeIndex];
      if (!seg || typeof seg !== 'object') {
        seg = { a: { x: 0, y: 0 }, b: { x: 0, y: 0 } };
        segments[writeIndex] = seg;
      } else {
        if (!seg.a) seg.a = { x: 0, y: 0 };
        if (!seg.b) seg.b = { x: 0, y: 0 };
      }

      seg.a.x = ax;
      seg.a.y = ay;
      seg.b.x = bx;
      seg.b.y = by;
      writeIndex++;
    }

    segments.length = writeIndex;
    return segments;
  }

  /**
   * Append quad edges for tiles with Foundry "Restrict light" into the segment list.
   * Matches wall radius culling and Levels-style tile elevation bands.
   *
   * @param {{x: number, y: number}} center - Light center (Foundry px)
   * @param {number} radius
   * @param {Array<{a:{x:number,y:number},b:{x:number,y:number}}>} segments
   * @param {number|undefined} elevation - Light / LOS height for band test
   */
  restrictLightTilesToSegments(center, radius, segments, elevation) {
    if (!center || !(radius > 0) || !segments) return;

    const radiusSq = radius * radius;
    const hasElevation = typeof elevation === 'number' && Number.isFinite(elevation);
    let writeIndex = segments.length;

    const considerDoc = (tileDoc) => {
      if (!tileDoc) return;
      if (!tileDocRestrictsLight(tileDoc)) return;

      if (hasElevation) {
        const flags = readTileLevelsFlags(tileDoc);
        const bottom = flags.rangeBottom;
        const top = flags.rangeTop;
        const inBand = elevation >= bottom && (top === Infinity || elevation < top);
        if (!inBand) return;
      }

      if (!this._fillRestrictLightTileCornersFoundry(tileDoc)) return;

      const corners = this._restrictLightTileCorners;
      for (let i = 0; i < 4; i++) {
        const a = corners[i];
        const b = corners[(i + 1) % 4];
        this._tempSegA.x = a.x;
        this._tempSegA.y = a.y;
        this._tempSegB.x = b.x;
        this._tempSegB.y = b.y;

        const ax = a.x;
        const ay = a.y;
        const bx = b.x;
        const by = b.y;
        const dxA = ax - center.x;
        const dyA = ay - center.y;
        const dxB = bx - center.x;
        const dyB = by - center.y;
        const distASq = dxA * dxA + dyA * dyA;
        const distBSq = dxB * dxB + dyB * dyB;

        if (distASq > radiusSq && distBSq > radiusSq) {
          // OPTIMIZATION: Use scalar distance check instead of object method
          if (this._distToSegmentSq(center.x, center.y, ax, ay, bx, by) > radiusSq) continue;
        }

        let seg = segments[writeIndex];
        if (!seg || typeof seg !== 'object') {
          seg = { a: { x: 0, y: 0 }, b: { x: 0, y: 0 } };
          segments[writeIndex] = seg;
        } else {
          if (!seg.a) seg.a = { x: 0, y: 0 };
          if (!seg.b) seg.b = { x: 0, y: 0 };
        }
        seg.a.x = ax;
        seg.a.y = ay;
        seg.b.x = bx;
        seg.b.y = by;
        writeIndex++;
      }
    };

    try {
      const placeables = canvas?.tiles?.placeables;
      if (Array.isArray(placeables) && placeables.length > 0) {
        for (const p of placeables) {
          const doc = p?.document ?? null;
          if (!doc) continue;
          let restricts = false;
          try {
            restricts = !!p.restrictsLight;
          } catch (_) {
            restricts = false;
          }
          if (!restricts && !tileDocRestrictsLight(doc)) continue;
          considerDoc(doc);
        }
      } else {
        try {
          const st = canvas?.scene?.tiles;
          const docs = st?.contents
            ?? (typeof st?.[Symbol.iterator] === 'function' ? Array.from(st) : []);
          for (const d of docs) considerDoc(d);
        } catch (_) {}
      }
    } catch (_) {
    }

    segments.length = writeIndex;
  }

  /**
   * Fills {@link VisionPolygonComputer#_restrictLightTileCorners} with Foundry-space quad corners.
   * @param {object} tileDoc
   * @returns {boolean} false if degenerate
   * @private
   */
  _fillRestrictLightTileCornersFoundry(tileDoc) {
    const shape = tileDoc?.shape && typeof tileDoc.shape === 'object' ? tileDoc.shape : null;
    const sx = Number(shape?.x ?? tileDoc?.x) || 0;
    const sy = Number(shape?.y ?? tileDoc?.y) || 0;
    const w = Number(shape?.width ?? tileDoc?.width) || 0;
    const h = Number(shape?.height ?? tileDoc?.height) || 0;
    const ax = Number(shape?.anchorX ?? 0);
    const ay = Number(shape?.anchorY ?? 0);
    const scRawX = tileDoc?.texture?.scaleX;
    const scRawY = tileDoc?.texture?.scaleY;
    const scX = Number.isFinite(Number(scRawX)) ? Number(scRawX) : 1;
    const scY = Number.isFinite(Number(scRawY)) ? Number(scRawY) : 1;
    const dispW = Math.abs(w) * Math.abs(scX || 1);
    const dispH = Math.abs(h) * Math.abs(scY || 1);
    if (dispW <= 1e-6 || dispH <= 1e-6) return false;

    const rotDeg = Number(shape?.rotation ?? tileDoc?.rotation) || 0;
    const rad = (rotDeg * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);

    const x0 = -ax * dispW;
    const y0 = -ay * dispH;
    const x1 = (1 - ax) * dispW;
    const y1 = -ay * dispH;
    const x2 = (1 - ax) * dispW;
    const y2 = (1 - ay) * dispH;
    const x3 = -ax * dispW;
    const y3 = (1 - ay) * dispH;

    const corners = this._restrictLightTileCorners;
    const lx0 = x0; const ly0 = y0;
    const lx1 = x1; const ly1 = y1;
    const lx2 = x2; const ly2 = y2;
    const lx3 = x3; const ly3 = y3;
    const pxs = [lx0, lx1, lx2, lx3];
    const pys = [ly0, ly1, ly2, ly3];
    for (let i = 0; i < 4; i++) {
      const px = pxs[i];
      const py = pys[i];
      corners[i].x = sx + (px * c - py * s);
      corners[i].y = sy + (px * s + py * c);
    }
    return true;
  }

  /**
   * Determine whether a wall blocks a sense from this source, including threshold rules.
   * @param {object} doc - Wall document-like object with `c`, `sight`, `light`.
   * @param {'sight'|'light'} sense
   * @param {{x:number, y:number}} source
   * @param {number|undefined} elevation
   * @returns {boolean}
   * @private
   */
  _wallBlocksSenseWithThreshold(doc, sense, source, elevation) {
    const value = Number(sense === 'light' ? doc?.light : doc?.sight);
    if (!Number.isFinite(value) || value <= 0) return false;

    // Normal walls are unconditional blockers after existing door/dir/elevation checks.
    const normal = Number(CONST?.WALL_SENSE_TYPES?.NORMAL ?? 20);
    if (value === normal) return true;

    const c = doc?.c;
    if (!Array.isArray(c) || c.length < 4) return value > 0;

    const backend = CONFIG?.Canvas?.polygonBackends?.[sense];
    if (!backend || typeof backend.testCollision !== 'function') return value > 0;

    this._tempThresholdTarget.x = (Number(c[0]) + Number(c[2])) * 0.5;
    this._tempThresholdTarget.y = (Number(c[1]) + Number(c[3])) * 0.5;
    const target = this._tempThresholdTarget;

    let hits = null;
    try {
      hits = backend.testCollision(source, target, {
        mode: 'all',
        type: sense,
        edgeDirectionMode: CONST?.EDGE_DIRECTION_MODES?.NORMAL,
        useThreshold: true
      });
    } catch (_) {
      return value > 0;
    }
    if (!Array.isArray(hits) || hits.length === 0) return false;
    return this._collisionHitsIncludeWall(hits, doc, elevation);
  }

  /**
   * Check collision hits for a specific wall, including elevation filtering.
   * @param {Array} hits
   * @param {object} wallDoc
   * @param {number|undefined} elevation
   * @returns {boolean}
   * @private
   */
  _collisionHitsIncludeWall(hits, wallDoc, elevation) {
    const wallId = String(wallDoc?.id ?? '');
    if (!wallId) {
      for (const hit of hits) {
        const edges = hit?.edges;
        if (!(edges instanceof Set) || edges.size === 0) continue;
        for (const edge of edges) {
          const edgeDoc = edge?.object?.document ?? edge?.object ?? null;
          if (!edgeDoc) continue;
          if (!this._wallBlocksAtElevation(edgeDoc, elevation)) continue;
          return true;
        }
      }
      return false;
    }

    for (const hit of hits) {
      const edges = hit?.edges;
      if (!(edges instanceof Set)) continue;
      for (const edge of edges) {
        const edgeDoc = edge?.object?.document ?? edge?.object ?? null;
        if (!edgeDoc) continue;
        const edgeId = String(edgeDoc?.id ?? '');
        if (wallId && edgeId && edgeId !== wallId) continue;
        if (!this._wallBlocksAtElevation(edgeDoc, elevation)) continue;
        return true;
      }
    }
    return false;
  }

  /**
   * Elevation gate using Levels-style bottom-inclusive/top-exclusive semantics.
   * @param {object} wallDoc
   * @param {number|undefined} elevation
   * @returns {boolean}
   * @private
   */
  _wallBlocksAtElevation(wallDoc, elevation) {
    if (!(typeof elevation === 'number' && Number.isFinite(elevation))) return true;
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
   * Create boundary circle as segments
   * @param {{x: number, y: number}} center
   * @param {number} radius
   * @param {number} numSegments
   * @returns {Array<{a: {x: number, y: number}, b: {x: number, y: number}}>}
   */
  createBoundaryCircle(center, radius, numSegments, outSegments = null) {
    const segments = outSegments ?? [];
    let writeIndex = segments.length;
    const angleStep = (Math.PI * 2) / numSegments;
    
    for (let i = 0; i < numSegments; i++) {
      const angle1 = i * angleStep;
      const angle2 = (i + 1) * angleStep;

      let seg = segments[writeIndex];
      if (!seg || typeof seg !== 'object') {
        seg = { a: { x: 0, y: 0 }, b: { x: 0, y: 0 } };
        segments[writeIndex] = seg;
      } else {
        if (!seg.a) seg.a = { x: 0, y: 0 };
        if (!seg.b) seg.b = { x: 0, y: 0 };
      }

      seg.a.x = center.x + Math.cos(angle1) * radius;
      seg.a.y = center.y + Math.sin(angle1) * radius;
      seg.b.x = center.x + Math.cos(angle2) * radius;
      seg.b.y = center.y + Math.sin(angle2) * radius;
      writeIndex++;
    }

    segments.length = writeIndex;
    return segments;
  }

  /**
   * Create rectangle boundary segments (for clipping vision to scene bounds)
   * @param {{x: number, y: number, width: number, height: number}} bounds - Rectangle bounds
   * @param {{x: number, y: number}} center - Vision origin
   * @param {number} radius - Vision radius
   * @returns {Array<{a: {x: number, y: number}, b: {x: number, y: number}}>}
   */
  createRectangleBoundary(bounds, center, radius, outSegments = null) {
    const segments = outSegments ?? [];
    let writeIndex = segments.length;
    const { x, y, width, height } = bounds;

    // Rectangle corners (as scalars to avoid temporary objects)
    const x0 = x;
    const y0 = y;
    const x1 = x + width;
    const y1 = y + height;

    // Four edges as scalar endpoints
    const edges = [
      x0, y0, x1, y0,
      x1, y0, x1, y1,
      x1, y1, x0, y1,
      x0, y1, x0, y0
    ];
    
    const radiusSq = radius * radius;
    
    // Only include edges that are within or intersect the vision radius
    for (let i = 0; i < edges.length; i += 4) {
      const ax = edges[i];
      const ay = edges[i + 1];
      const bx = edges[i + 2];
      const by = edges[i + 3];

      const dxA = ax - center.x;
      const dyA = ay - center.y;
      const dxB = bx - center.x;
      const dyB = by - center.y;
      const distASq = dxA * dxA + dyA * dyA;
      const distBSq = dxB * dxB + dyB * dyB;

      let include = (distASq <= radiusSq || distBSq <= radiusSq);
      if (!include) {
        // Check if segment passes through circle
        // OPTIMIZATION: Use scalar distance check instead of object method
        include = this._distToSegmentSq(center.x, center.y, ax, ay, bx, by) <= radiusSq;
      }

      if (!include) continue;

      let seg = segments[writeIndex];
      if (!seg || typeof seg !== 'object') {
        seg = { a: { x: 0, y: 0 }, b: { x: 0, y: 0 } };
        segments[writeIndex] = seg;
      } else {
        if (!seg.a) seg.a = { x: 0, y: 0 };
        if (!seg.b) seg.b = { x: 0, y: 0 };
      }

      seg.a.x = ax;
      seg.a.y = ay;
      seg.b.x = bx;
      seg.b.y = by;
      writeIndex++;
    }

    segments.length = writeIndex;
    return segments;
  }

  /**
   * Create a simple circle polygon (for fallback)
   * @param {{x: number, y: number}} center
   * @param {number} radius
   * @param {number} numPoints
   * @returns {number[]} Flat point array
   */
  createCirclePolygon(center, radius, numPoints, outPoints = null) {
    const points = outPoints ?? [];
    points.length = 0;
    const angleStep = (Math.PI * 2) / numPoints;
    
    for (let i = 0; i < numPoints; i++) {
      const angle = i * angleStep;
      points.push(
        center.x + Math.cos(angle) * radius,
        center.y + Math.sin(angle) * radius
      );
    }
    
    return points;
  }

  /**
   * Collect unique endpoints from segments within radius
   * @param {Array} segments
   * @param {{x: number, y: number}} center
   * @param {number} radius
   * @returns {Array<{x: number, y: number, angle: number}>}
   */
  collectEndpoints(segments, center, radius) {
    // PERFORMANCE: Reuse map and array instead of allocating new ones
    this._endpointMap.clear();

    const endpoints = this._endpointsPool;
    let epCount = 0;
    
    const radiusSq = radius * radius;
    const radiusSqTol = radiusSq * 1.01; // Small tolerance
    
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];

      // Endpoint A
      {
        const point = seg.a;
        const dx = point.x - center.x;
        const dy = point.y - center.y;
        const distSq = dx * dx + dy * dy;
        if (distSq <= radiusSqTol) {
          // FIX: Shift to positive to prevent negative collision bugs
          const safeX = Math.round(point.x * 10) + 1000000;
          const safeY = Math.round(point.y * 10) + 1000000;
          const key = safeX * 100000000 + safeY;
          if (!this._endpointMap.has(key)) {
            const angle = Math.atan2(dy, dx);
            let ep = endpoints[epCount];
            if (!ep || typeof ep !== 'object') {
              ep = { x: 0, y: 0, angle: 0 };
              endpoints[epCount] = ep;
            }
            ep.x = point.x;
            ep.y = point.y;
            ep.angle = angle;
            epCount++;
            this._endpointMap.set(key, ep);
          }
        }
      }

      // Endpoint B
      {
        const point = seg.b;
        const dx = point.x - center.x;
        const dy = point.y - center.y;
        const distSq = dx * dx + dy * dy;
        if (distSq <= radiusSqTol) {
          // FIX: Shift to positive to prevent negative collision bugs
          const safeX = Math.round(point.x * 10) + 1000000;
          const safeY = Math.round(point.y * 10) + 1000000;
          const key = safeX * 100000000 + safeY;
          if (!this._endpointMap.has(key)) {
            const angle = Math.atan2(dy, dx);
            let ep = endpoints[epCount];
            if (!ep || typeof ep !== 'object') {
              ep = { x: 0, y: 0, angle: 0 };
              endpoints[epCount] = ep;
            }
            ep.x = point.x;
            ep.y = point.y;
            ep.angle = angle;
            epCount++;
            this._endpointMap.set(key, ep);
          }
        }
      }
    }

    endpoints.length = epCount;
    return endpoints;
  }

  /**
   * Cast rays to endpoints and find visibility polygon vertices
   * @param {{x: number, y: number}} origin
   * @param {Array<{x: number, y: number, angle: number}>} endpoints
   * @param {Array} segments
   * @param {number} radius
   * @returns {Array<{x: number, y: number, angle: number}>}
   */
  castRays(origin, endpoints, segments, radius) {
    // PERFORMANCE: Reuse arrays and sets instead of allocating
    this._seenAnglesSet.clear();

    const intersections = this._intersectionsPool;
    let hitCount = 0;

    const eps = this.epsilon;
    
    for (let i = 0; i < endpoints.length; i++) {
      const endpoint = endpoints[i];
      // Cast 3 rays: slightly before, at, and slightly after the endpoint
      // This ensures we catch corners correctly
      for (let j = 0; j < 3; j++) {
        const angle = endpoint.angle + (j === 0 ? -eps : (j === 2 ? eps : 0));
        
        // Avoid duplicate angles - use integer key to avoid string allocation
        const angleKey = Math.round(angle * 1000000);
        if (this._seenAnglesSet.has(angleKey)) continue;
        this._seenAnglesSet.add(angleKey);

        const hit = this.castRay(origin, angle, segments, radius, this._tempHit);
        let out = intersections[hitCount];
        if (!out || typeof out !== 'object') {
          out = { x: 0, y: 0, angle: 0 };
          intersections[hitCount] = out;
        }
        out.x = hit.x;
        out.y = hit.y;
        out.angle = angle;
        hitCount++;
      }
    }

    intersections.length = hitCount;
    return intersections;
  }

  /**
   * Cast a single ray and find the closest intersection
   * @param {{x: number, y: number}} origin
   * @param {number} angle - Ray angle in radians
   * @param {Array} segments
   * @param {number} radius
   * @returns {{x: number, y: number}|null}
   */
  castRay(origin, angle, segments, radius, outHit = null) {
    const r_px = origin.x;
    const r_py = origin.y;
    
    // Scale ray vector to exact radius bounds
    const r_dx = Math.cos(angle) * radius;
    const r_dy = Math.sin(angle) * radius;

    // OPTIMIZATION: Track parametric 't' instead of Euclidean coordinates/distances
    let closestT = 1.0; 
    
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const s_px = seg.a.x;
      const s_py = seg.a.y;
      const s_dx = seg.b.x - s_px;
      const s_dy = seg.b.y - s_py;
      
      const denom = r_dx * s_dy - r_dy * s_dx;
      if (denom > -1e-10 && denom < 1e-10) continue; // Parallel
      
      const t = ((s_px - r_px) * s_dy - (s_py - r_py) * s_dx) / denom;
      
      // OPTIMIZATION: If 't' is behind ray (t < 0) or further than closest hit (t >= closestT), early exit!
      if (t < 0 || t >= closestT) continue; 
      
      const u = ((s_px - r_px) * r_dy - (s_py - r_py) * r_dx) / denom;
      if (u >= 0 && u <= 1) {
        closestT = t; // New closest parametric distance
      }
    }

    const out = outHit ?? { x: 0, y: 0 };
    // Final coordinate evaluated only ONCE at the very end
    out.x = r_px + closestT * r_dx;
    out.y = r_py + closestT * r_dy;
    return out;
  }

  /**
   * Ray-segment intersection
   * @param {{x: number, y: number}} rayOrigin
   * @param {{x: number, y: number}} rayEnd
   * @param {{x: number, y: number}} segA
   * @param {{x: number, y: number}} segB
   * @returns {{x: number, y: number}|null}
   */
  raySegmentIntersection(rayOrigin, rayEnd, segA, segB, outHit = null) {
    const r_px = rayOrigin.x;
    const r_py = rayOrigin.y;
    const r_dx = rayEnd.x - rayOrigin.x;
    const r_dy = rayEnd.y - rayOrigin.y;
    
    const s_px = segA.x;
    const s_py = segA.y;
    const s_dx = segB.x - segA.x;
    const s_dy = segB.y - segA.y;
    
    const denom = r_dx * s_dy - r_dy * s_dx;
    
    // Parallel lines
    if (Math.abs(denom) < 1e-10) return false;
    
    const t = ((s_px - r_px) * s_dy - (s_py - r_py) * s_dx) / denom;
    const u = ((s_px - r_px) * r_dy - (s_py - r_py) * r_dx) / denom;
    
    // Check if intersection is within ray (t >= 0 and t <= 1) and segment (0 <= u <= 1)
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      const out = outHit ?? { x: 0, y: 0 };
      out.x = r_px + t * r_dx;
      out.y = r_py + t * r_dy;
      return out;
    }
    
    return false;
  }

  /**
   * Extremely fast scalar distance check. Avoids allocating temp segment objects.
   * @private
   */
  _distToSegmentSq(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    
    if (lenSq === 0) {
      const dpx = px - ax;
      const dpy = py - ay;
      return dpx * dpx + dpy * dpy;
    }
    
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const dpx = px - cx;
    const dpy = py - cy;
    
    return dpx * dpx + dpy * dpy;
  }

  /**
   * Extracts endpoint angles, adds +- epsilon, and sorts them via TypedArray
   * @private
   */
  _extractAndSortAngles(endpoints) {
    const needed = endpoints.length * 3;
    if (this._anglesArray.length < needed) {
      this._anglesArray = new Float64Array(Math.max(this._anglesArray.length * 2, needed));
    }
    
    const eps = this.epsilon;
    let idx = 0;
    
    for (let i = 0; i < endpoints.length; i++) {
      const baseAngle = endpoints[i].angle;
      this._anglesArray[idx++] = baseAngle - eps;
      this._anglesArray[idx++] = baseAngle;
      this._anglesArray[idx++] = baseAngle + eps;
    }
    
    const validAngles = this._anglesArray.subarray(0, needed);
    validAngles.sort(); // V8 sorts flat Float64 arrays incredibly fast
    return validAngles;
  }

  /**
   * Find closest point on a segment to a given point
   * @param {{x: number, y: number}} point
   * @param {{x: number, y: number}} segA
   * @param {{x: number, y: number}} segB
   * @returns {{x: number, y: number}}
   */
  closestPointOnSegment(point, segA, segB) {
    const dx = segB.x - segA.x;
    const dy = segB.y - segA.y;
    const lenSq = dx * dx + dy * dy;
    
    if (lenSq === 0) {
      this._tempClosest.x = segA.x;
      this._tempClosest.y = segA.y;
      return this._tempClosest;
    }
    
    let t = ((point.x - segA.x) * dx + (point.y - segA.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    
    // PERFORMANCE: Reuse temp object instead of allocating
    this._tempClosest.x = segA.x + t * dx;
    this._tempClosest.y = segA.y + t * dy;
    return this._tempClosest;
  }
}
