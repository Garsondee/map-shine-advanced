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
  }

  /**
   * Compute visibility polygon for a point
   * @param {{x: number, y: number}} center - Token center in Foundry coordinates
   * @param {number} radius - Vision radius in pixels
   * @param {Wall[]} walls - Array of wall placeables (optional, defaults to canvas.walls.placeables)
   * @param {{x: number, y: number, width: number, height: number}} [sceneBounds] - Optional scene bounds to clip vision
   * @returns {number[]} Flat array [x0, y0, x1, y1, ...] in Foundry coordinates
   */
  compute(center, radius, walls = null, sceneBounds = null) {
    if (!center || radius <= 0) {
      log.debug(`compute() early return: center=${JSON.stringify(center)}, radius=${radius}`);
      return [];
    }

    // Get walls from canvas if not provided
    const allWalls = walls ?? canvas?.walls?.placeables ?? [];
    
    // Filter to vision-blocking walls only
    const blockingWalls = this.filterVisionBlockingWalls(allWalls);
    
    // Convert walls to segments
    const segments = this.wallsToSegments(blockingWalls, center, radius);
    
    // Add scene boundary segments if provided (clips vision to scene interior)
    if (sceneBounds) {
      const boundarySegs = this.createRectangleBoundary(sceneBounds, center, radius);
      segments.push(...boundarySegs);
    }
    
    // Add boundary circle segments
    const boundarySegments = this.createBoundaryCircle(center, radius, this.circleSegments);
    segments.push(...boundarySegments);
    
    if (Math.random() < 0.01) {
      log.debug(`compute(): center=(${center.x.toFixed(0)}, ${center.y.toFixed(0)}), radius=${radius.toFixed(0)}, walls=${allWalls.length}, blocking=${blockingWalls.length}, segments=${segments.length}`);
    }
    
    // If no segments at all, return a simple circle
    if (segments.length === 0) {
      return this.createCirclePolygon(center, radius, this.circleSegments);
    }
    
    // Collect unique endpoints within radius
    const endpoints = this.collectEndpoints(segments, center, radius);
    
    // Cast rays and find intersections
    const intersections = this.castRays(center, endpoints, segments, radius);
    
    // Sort by angle and build polygon
    intersections.sort((a, b) => a.angle - b.angle);
    
    // Flatten to point array
    const points = [];
    for (const intersection of intersections) {
      points.push(intersection.x, intersection.y);
    }
    
    // Validate polygon
    if (points.length < 6) {
      // Fallback to circle if polygon is degenerate
      return this.createCirclePolygon(center, radius, this.circleSegments);
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
   * Convert wall placeables to segment objects
   * @param {Wall[]} walls - Filtered walls
   * @param {{x: number, y: number}} center - Vision origin
   * @param {number} radius - Vision radius
   * @returns {Array<{a: {x: number, y: number}, b: {x: number, y: number}}>}
   */
  wallsToSegments(walls, center, radius) {
    const segments = [];
    const radiusSq = radius * radius;
    
    for (const wall of walls) {
      const c = wall.document.c;
      if (!c || c.length < 4) continue;
      
      const a = { x: c[0], y: c[1] };
      const b = { x: c[2], y: c[3] };
      
      // Quick rejection: skip segments entirely outside vision radius
      // Check if either endpoint is within radius, or if segment intersects radius circle
      const distASq = (a.x - center.x) ** 2 + (a.y - center.y) ** 2;
      const distBSq = (b.x - center.x) ** 2 + (b.y - center.y) ** 2;
      
      if (distASq > radiusSq && distBSq > radiusSq) {
        // Both endpoints outside - check if segment passes through circle
        const closest = this.closestPointOnSegment(center, a, b);
        const distClosestSq = (closest.x - center.x) ** 2 + (closest.y - center.y) ** 2;
        if (distClosestSq > radiusSq) continue;
      }
      
      segments.push({ a, b });
    }
    
    return segments;
  }

  /**
   * Create boundary circle as segments
   * @param {{x: number, y: number}} center
   * @param {number} radius
   * @param {number} numSegments
   * @returns {Array<{a: {x: number, y: number}, b: {x: number, y: number}}>}
   */
  createBoundaryCircle(center, radius, numSegments) {
    const segments = [];
    const angleStep = (Math.PI * 2) / numSegments;
    
    for (let i = 0; i < numSegments; i++) {
      const angle1 = i * angleStep;
      const angle2 = (i + 1) * angleStep;
      
      segments.push({
        a: {
          x: center.x + Math.cos(angle1) * radius,
          y: center.y + Math.sin(angle1) * radius
        },
        b: {
          x: center.x + Math.cos(angle2) * radius,
          y: center.y + Math.sin(angle2) * radius
        }
      });
    }
    
    return segments;
  }

  /**
   * Create rectangle boundary segments (for clipping vision to scene bounds)
   * @param {{x: number, y: number, width: number, height: number}} bounds - Rectangle bounds
   * @param {{x: number, y: number}} center - Vision origin
   * @param {number} radius - Vision radius
   * @returns {Array<{a: {x: number, y: number}, b: {x: number, y: number}}>}
   */
  createRectangleBoundary(bounds, center, radius) {
    const segments = [];
    const { x, y, width, height } = bounds;
    
    // Four corners of the rectangle
    const corners = [
      { x: x, y: y },                    // Top-left
      { x: x + width, y: y },            // Top-right
      { x: x + width, y: y + height },   // Bottom-right
      { x: x, y: y + height }            // Bottom-left
    ];
    
    // Four edges
    const edges = [
      { a: corners[0], b: corners[1] }, // Top
      { a: corners[1], b: corners[2] }, // Right
      { a: corners[2], b: corners[3] }, // Bottom
      { a: corners[3], b: corners[0] }  // Left
    ];
    
    const radiusSq = radius * radius;
    
    // Only include edges that are within or intersect the vision radius
    for (const edge of edges) {
      const distASq = (edge.a.x - center.x) ** 2 + (edge.a.y - center.y) ** 2;
      const distBSq = (edge.b.x - center.x) ** 2 + (edge.b.y - center.y) ** 2;
      
      if (distASq <= radiusSq || distBSq <= radiusSq) {
        segments.push(edge);
      } else {
        // Check if segment passes through circle
        const closest = this.closestPointOnSegment(center, edge.a, edge.b);
        const distClosestSq = (closest.x - center.x) ** 2 + (closest.y - center.y) ** 2;
        if (distClosestSq <= radiusSq) {
          segments.push(edge);
        }
      }
    }
    
    return segments;
  }

  /**
   * Create a simple circle polygon (for fallback)
   * @param {{x: number, y: number}} center
   * @param {number} radius
   * @param {number} numPoints
   * @returns {number[]} Flat point array
   */
  createCirclePolygon(center, radius, numPoints) {
    const points = [];
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
    const endpointMap = new Map();
    const radiusSq = radius * radius;
    
    for (const seg of segments) {
      for (const point of [seg.a, seg.b]) {
        const distSq = (point.x - center.x) ** 2 + (point.y - center.y) ** 2;
        if (distSq <= radiusSq * 1.01) { // Small tolerance
          const key = `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
          if (!endpointMap.has(key)) {
            const angle = Math.atan2(point.y - center.y, point.x - center.x);
            endpointMap.set(key, { x: point.x, y: point.y, angle });
          }
        }
      }
    }
    
    return Array.from(endpointMap.values());
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
    const intersections = [];
    const seenAngles = new Set();
    
    for (const endpoint of endpoints) {
      // Cast 3 rays: slightly before, at, and slightly after the endpoint
      // This ensures we catch corners correctly
      for (const offset of [-this.epsilon, 0, this.epsilon]) {
        const angle = endpoint.angle + offset;
        
        // Avoid duplicate angles
        const angleKey = angle.toFixed(6);
        if (seenAngles.has(angleKey)) continue;
        seenAngles.add(angleKey);
        
        const hit = this.castRay(origin, angle, segments, radius);
        if (hit) {
          intersections.push({ x: hit.x, y: hit.y, angle });
        }
      }
    }
    
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
  castRay(origin, angle, segments, radius) {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    
    // Ray endpoint (at max radius)
    const rayEnd = {
      x: origin.x + dx * radius,
      y: origin.y + dy * radius
    };
    
    let closestHit = null;
    let closestDistSq = Infinity;
    
    for (const seg of segments) {
      const hit = this.raySegmentIntersection(origin, rayEnd, seg.a, seg.b);
      if (hit) {
        const distSq = (hit.x - origin.x) ** 2 + (hit.y - origin.y) ** 2;
        if (distSq < closestDistSq) {
          closestDistSq = distSq;
          closestHit = hit;
        }
      }
    }
    
    // If no hit, return point at radius
    if (!closestHit) {
      return rayEnd;
    }
    
    return closestHit;
  }

  /**
   * Ray-segment intersection
   * @param {{x: number, y: number}} rayOrigin
   * @param {{x: number, y: number}} rayEnd
   * @param {{x: number, y: number}} segA
   * @param {{x: number, y: number}} segB
   * @returns {{x: number, y: number}|null}
   */
  raySegmentIntersection(rayOrigin, rayEnd, segA, segB) {
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
    if (Math.abs(denom) < 1e-10) return null;
    
    const t = ((s_px - r_px) * s_dy - (s_py - r_py) * s_dx) / denom;
    const u = ((s_px - r_px) * r_dy - (s_py - r_py) * r_dx) / denom;
    
    // Check if intersection is within ray (t >= 0 and t <= 1) and segment (0 <= u <= 1)
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      return {
        x: r_px + t * r_dx,
        y: r_py + t * r_dy
      };
    }
    
    return null;
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
    
    if (lenSq === 0) return segA;
    
    let t = ((point.x - segA.x) * dx + (point.y - segA.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    
    return {
      x: segA.x + t * dx,
      y: segA.y + t * dy
    };
  }
}
