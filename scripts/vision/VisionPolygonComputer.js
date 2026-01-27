/**
 * @fileoverview Computes 2D visibility polygons using raycasting
 * Based on Red Blob Games visibility algorithm
 * @see https://www.redblobgames.com/articles/visibility/
 * @module vision/VisionPolygonComputer
 */

import { createLogger } from '../core/log.js';

const log = createLogger('VisionPolygonComputer');

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
    
    // Reusable temp objects for closestPointOnSegment
    this._tempClosest = { x: 0, y: 0 };
    this._tempRayEnd = { x: 0, y: 0 };
    this._tempHit = { x: 0, y: 0 };
    this._tempSegA = { x: 0, y: 0 };
    this._tempSegB = { x: 0, y: 0 };
  }

  /**
   * Compute visibility polygon for a point
   * @param {{x: number, y: number}} center - Token center in Foundry coordinates
   * @param {number} radius - Vision radius in pixels
   * @param {Wall[]} walls - Array of wall placeables (optional, defaults to canvas.walls.placeables)
   * @param {{x: number, y: number, width: number, height: number}} [sceneBounds] - Optional scene bounds to clip vision
   * @param {{sense?: 'sight'|'light'}|null} [options] - Optional compute mode (defaults to 'sight')
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

    // Convert walls to segments (filtering inline to avoid allocations).
    const segments = this._segmentsPool;
    segments.length = 0;
    this.wallsToSegments(allWalls, center, radius, sense, segments);
    
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
    
    // Cast rays and find intersections
    const intersections = this.castRays(center, endpoints, segments, radius);
    
    // Sort by angle and build polygon
    intersections.sort((a, b) => a.angle - b.angle);
    
    // Flatten to point array
    const points = this._pointsPool;
    points.length = 0;
    for (const intersection of intersections) {
      points.push(intersection.x, intersection.y);
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
      
      // Skip open doors (ds=1 means open)
      // CONST.WALL_DOOR_TYPES: 0=None, 1=Door, 2=Secret
      // CONST.WALL_DOOR_STATES: 0=Closed, 1=Open, 2=Locked
      if (doc.door > 0 && doc.ds === 1) return false;
      
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
      if (doc.door > 0 && doc.ds === 1) return false;

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
   * @returns {Array<{a: {x: number, y: number}, b: {x: number, y: number}}>}
   */
  wallsToSegments(walls, center, radius, sense = 'sight', outSegments = null) {
    const segments = outSegments ?? [];
    let writeIndex = segments.length;
    const radiusSq = radius * radius;
    
    for (const wall of walls) {
      const doc = wall?.document;
      if (!doc) continue;

      // Inline filtering to avoid allocating a filtered walls array.
      if (sense === 'light') {
        if (doc.light === 0) continue;
      } else {
        if (doc.sight === 0) continue;
      }
      // Skip open doors.
      if (doc.door > 0 && doc.ds === 1) continue;

      const c = doc.c;
      if (!c || c.length < 4) continue;

      const ax = c[0];
      const ay = c[1];
      const bx = c[2];
      const by = c[3];
      
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
        this._tempSegA.x = ax;
        this._tempSegA.y = ay;
        this._tempSegB.x = bx;
        this._tempSegB.y = by;
        const closest = this.closestPointOnSegment(center, this._tempSegA, this._tempSegB);
        const distClosestSq = (closest.x - center.x) ** 2 + (closest.y - center.y) ** 2;
        if (distClosestSq > radiusSq) continue;
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
        this._tempSegA.x = ax;
        this._tempSegA.y = ay;
        this._tempSegB.x = bx;
        this._tempSegB.y = by;
        const closest = this.closestPointOnSegment(center, this._tempSegA, this._tempSegB);
        const distClosestSq = (closest.x - center.x) ** 2 + (closest.y - center.y) ** 2;
        include = distClosestSq <= radiusSq;
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
          const keyX = Math.round(point.x * 100);
          const keyY = Math.round(point.y * 100);
          const key = keyX * 1000000 + keyY;
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
          const keyX = Math.round(point.x * 100);
          const keyY = Math.round(point.y * 100);
          const key = keyX * 1000000 + keyY;
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
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    
    // Ray endpoint (at max radius)
    const rayEnd = this._tempRayEnd;
    rayEnd.x = origin.x + dx * radius;
    rayEnd.y = origin.y + dy * radius;

    let closestX = rayEnd.x;
    let closestY = rayEnd.y;
    let closestDistSq = Infinity;
    
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (this.raySegmentIntersection(origin, rayEnd, seg.a, seg.b, this._tempHit)) {
        const hx = this._tempHit.x;
        const hy = this._tempHit.y;
        const dxh = hx - origin.x;
        const dyh = hy - origin.y;
        const distSq = dxh * dxh + dyh * dyh;
        if (distSq < closestDistSq) {
          closestDistSq = distSq;
          closestX = hx;
          closestY = hy;
        }
      }
    }

    const out = outHit ?? { x: 0, y: 0 };
    out.x = closestX;
    out.y = closestY;
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
