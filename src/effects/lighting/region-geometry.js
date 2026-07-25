/**
 * REGION GEOMETRY — the pure CPU/analytic half of the region-darkness
 * behavior: point-in-shape containment (rectangle / ellipse / polygon / cone /
 * ring / line / emanation), union-minus-holes shape resolution, boundary
 * distances, elevation-band overlap, and the darkness mode/modifier math.
 *
 * All Node-testable — no THREE, no TSL — which is exactly why it lives apart
 * from the TSL material builders in ./region-darkness.js, which reimplement
 * the SAME containment logic per-fragment on the GPU. Split out of
 * region-darkness.js on 2026-07-25 (the size-ratchet god-object reversal, when
 * that file was a 1,416-line mix of CPU math and shader code); see that file's
 * header for the full behavior, scope, and the discard()-in-Fn() history.
 *
 * @module effects/lighting/region-geometry
 */

const DEG2RAD = Math.PI / 180;

/** @param {number} v @param {number} fallback @returns {number} */
function num(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

/**
 * `RectangleShapeData`: origin `(x,y)`, an anchor (0..1 fraction of
 * width/height) locating the box relative to that origin, rotated around the
 * origin. Un-rotate the query point into the rectangle's own local space,
 * then test the anchor-offset axis-aligned box.
 *
 * @param {number} px @param {number} py
 * @param {{x:number,y:number,width:number,height:number,anchorX?:number,anchorY?:number,rotation?:number}} rect
 * @returns {boolean}
 */
export function pointInRectangle(px, py, rect) {
  const width = num(rect?.width, 0);
  const height = num(rect?.height, 0);
  if (!(width > 0) || !(height > 0)) return false;
  const x = num(rect.x, 0);
  const y = num(rect.y, 0);
  const anchorX = num(rect.anchorX, 0);
  const anchorY = num(rect.anchorY, 0);
  const rad = -num(rect.rotation, 0) * DEG2RAD;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = px - x;
  const dy = py - y;
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;
  const left = -anchorX * width;
  const top = -anchorY * height;
  return lx >= left && lx <= left + width && ly >= top && ly <= top + height;
}

/**
 * `EllipseShapeData`: center `(x,y)`, `radiusX`/`radiusY`, rotated around the
 * center. A `CircleShapeData` is the special case `radiusX === radiusY === radius`.
 *
 * @param {number} px @param {number} py
 * @param {{x:number,y:number,radiusX:number,radiusY:number,rotation?:number}} ellipse
 * @returns {boolean}
 */
export function pointInEllipse(px, py, ellipse) {
  const radiusX = num(ellipse?.radiusX, 0);
  const radiusY = num(ellipse?.radiusY, 0);
  if (!(radiusX > 0) || !(radiusY > 0)) return false;
  const x = num(ellipse.x, 0);
  const y = num(ellipse.y, 0);
  const rad = -num(ellipse.rotation, 0) * DEG2RAD;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = px - x;
  const dy = py - y;
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;
  const nx = lx / radiusX;
  const ny = ly / radiusY;
  return nx * nx + ny * ny <= 1;
}

/**
 * `PolygonShapeData`: a flat `[x0,y0,x1,y1,...]` WORLD-space point list — the
 * same standard ray-casting point-in-polygon test this module's sibling
 * (`point-light-illumination.js#makeSdPolygonEdgeDistance`) uses on the GPU
 * side, here on the CPU for a query point.
 *
 * @param {number} px @param {number} py @param {number[]} points
 * @returns {boolean}
 */
export function pointInPolygon(px, py, points) {
  if (!Array.isArray(points) || points.length < 6 || points.length % 2 !== 0) return false;
  const n = points.length / 2;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = points[i * 2];
    const yi = points[i * 2 + 1];
    const xj = points[j * 2];
    const yj = points[j * 2 + 1];
    if (![xi, yi, xj, yj].every(Number.isFinite)) continue;
    const crosses = yi > py !== yj > py;
    if (crosses) {
      const xIntersect = ((xj - xi) * (py - yi)) / (yj - yi) + xi;
      if (px < xIntersect) inside = !inside;
    }
  }
  return inside;
}

/**
 * `ConeShapeData` (`common/data/data.mjs:352-389`, verified): apex `(x,y)`,
 * `radius`, `angle` (the wedge's opening angle, degrees), `rotation` (the
 * direction of the wedge's own center axis, degrees). Foundry's angle
 * convention (`AngleField`, `common/data/fields.mjs`, and confirmed via
 * `getCone`/`getTranslatedPoint` in `common/grid/`): 0° = +x (east),
 * increasing angle sweeps CLOCKWISE on screen (Y is down, so this is the
 * same `atan2(dy,dx)` convention already used below — no sign flip needed,
 * unlike the rectangle/ellipse/line rotation transforms, which un-rotate a
 * POINT into local space rather than compare two angles directly).
 *
 * `curvature:"round"` (the schema default, and the ONLY variant implemented
 * here) is a true circular sector — apex, radius, bounded by two rays at
 * `rotation ± angle/2`. `"flat"`/`"semicircle"` (verbatim `curvature`
 * values, `client/data/shapes.mjs`) produce a straight-fronted wedge or an
 * inscribed semicircle respectively, both cosmetically different from round
 * — NOT implemented; this function treats every cone as round regardless of
 * its own `curvature` field. A documented gap, not a silent one.
 *
 * @param {number} px @param {number} py
 * @param {{x:number,y:number,radius:number,angle:number,rotation?:number}} cone
 * @returns {boolean}
 */
export function pointInCone(px, py, cone) {
  const radius = num(cone?.radius, 0);
  if (!(radius > 0)) return false;
  const x = num(cone.x, 0);
  const y = num(cone.y, 0);
  const dx = px - x;
  const dy = py - y;
  const distSq = dx * dx + dy * dy;
  if (distSq > radius * radius) return false;
  // The apex itself belongs to every cone regardless of its own angle/
  // rotation (atan2(0,0) is arbitrary — 0 — which would wrongly exclude the
  // apex for a wedge not centered on 0°; guard it explicitly).
  if (distSq < 1e-9) return true;
  const angle = num(cone.angle, 0);
  if (!(angle > 0)) return false; // a zero/negative-degree wedge covers nothing but its own apex
  if (angle >= 360) return true; // a full circle — already passed the radius test above
  const rotation = num(cone.rotation, 0);
  const angleToPointDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  // Minimal signed angular difference, normalized to (-180, 180] — handles
  // the 0°/360° wraparound correctly (e.g. rotation=350, angle=60 spans
  // [320,360)∪[0,20), which a naive min/max range check would miss).
  const diff = ((((angleToPointDeg - rotation + 180) % 360) + 360) % 360) - 180;
  return Math.abs(diff) <= angle / 2;
}

/**
 * `RingShapeData` (`common/data/data.mjs:405-425`, verified): center
 * `(x,y)`, `radius` (the ring's own "seam" radius), `innerWidth`,
 * `outerWidth`. Ring NEVER defines a `rotation` field and overrides
 * `_rotate()` as a no-op in Foundry's own source (`client/data/
 * shapes.mjs:1444`) — it is always a full annulus (donut), never an angular
 * segment. `innerRadius = radius - innerWidth`, `outerRadius = radius +
 * outerWidth` (`common/grid/base.mjs:680-684`, verified).
 *
 * @param {number} px @param {number} py
 * @param {{x:number,y:number,radius:number,innerWidth?:number,outerWidth?:number}} ring
 * @returns {boolean}
 */
export function pointInRing(px, py, ring) {
  const radius = num(ring?.radius, 0);
  if (!(radius > 0)) return false;
  const innerWidth = num(ring.innerWidth, 0);
  const outerWidth = num(ring.outerWidth, 0);
  const innerRadius = Math.max(0, radius - innerWidth);
  const outerRadius = radius + outerWidth;
  if (!(outerRadius > innerRadius)) return false; // a degenerate (zero-thickness, or inverted) ring covers nothing
  const x = num(ring.x, 0);
  const y = num(ring.y, 0);
  const dx = px - x;
  const dy = py - y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  return dist >= innerRadius && dist <= outerRadius;
}

/**
 * `LineShapeData` (`common/data/data.mjs:441-461`, verified): `(x,y)` is
 * ONE ENDPOINT (the origin, not the center), `length`, `width`, `rotation`
 * (the direction FROM the origin TOWARD the far endpoint, degrees) — a
 * "thick line segment", exactly a rectangle anchored at its own start edge
 * and centered across its width (`common/grid/base.mjs:555-566`, `getLine`,
 * verified: destination = origin translated by `(rotation, length)`, the
 * rectangle offsets both endpoints perpendicular by `±width/2`). Same
 * un-rotate-the-query-point technique as `pointInRectangle`/`pointInEllipse`
 * above (negate rotation to un-rotate INTO local space, not TO it).
 *
 * @param {number} px @param {number} py
 * @param {{x:number,y:number,length:number,width:number,rotation?:number}} line
 * @returns {boolean}
 */
export function pointInLine(px, py, line) {
  const length = num(line?.length, 0);
  const width = num(line?.width, 0);
  if (!(length > 0) || !(width > 0)) return false;
  const x = num(line.x, 0);
  const y = num(line.y, 0);
  const rad = -num(line.rotation, 0) * DEG2RAD;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = px - x;
  const dy = py - y;
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;
  return lx >= 0 && lx <= length && ly >= -width / 2 && ly <= width / 2;
}

/**
 * The nearest-point-on-a-rotated-rectangle distance — the CPU building block
 * `pointInEmanation`'s own rectangle-base case needs (a rect's true
 * Minkowski sum with a disk of radius `r` is exactly "inside the rect, OR
 * within `r` of the rect's boundary" — this computes that boundary
 * distance). Same local-space transform as `pointInRectangle` (distances
 * are preserved under rotation, so computing in the un-rotated local frame
 * gives the identical answer to computing in world space).
 *
 * @param {number} px @param {number} py @param {object} rect - see `pointInRectangle`.
 * @returns {number} always >= 0.
 */
function distanceToRectangleBoundary(px, py, rect) {
  const width = num(rect?.width, 0);
  const height = num(rect?.height, 0);
  const x = num(rect.x, 0);
  const y = num(rect.y, 0);
  const anchorX = num(rect.anchorX, 0);
  const anchorY = num(rect.anchorY, 0);
  const rad = -num(rect.rotation, 0) * DEG2RAD;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = px - x;
  const dy = py - y;
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;
  const left = -anchorX * width;
  const top = -anchorY * height;
  const nx = Math.min(Math.max(lx, left), left + width);
  const ny = Math.min(Math.max(ly, top), top + height);
  const ddx = lx - nx;
  const ddy = ly - ny;
  return Math.sqrt(ddx * ddx + ddy * ddy);
}

/**
 * The nearest-point-on-a-polygon-boundary distance — the same building
 * block, for `pointInEmanation`'s polygon-base case. The CPU twin of
 * `point-light-illumination.js#makeSdPolygonEdgeDistance`'s own TSL
 * unsigned-distance term (same point-to-segment-clamp technique, here on
 * the CPU for a single query point instead of per-fragment on the GPU).
 *
 * @param {number} px @param {number} py @param {number[]} points - flat
 *   `[x0,y0,x1,y1,...]`, already validated by the caller.
 * @returns {number} always >= 0.
 */
function distanceToPolygonBoundary(px, py, points) {
  const n = points.length / 2;
  let minDistSq = Infinity;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = points[i * 2];
    const yi = points[i * 2 + 1];
    const xj = points[j * 2];
    const yj = points[j * 2 + 1];
    const ex = xj - xi;
    const ey = yj - yi;
    const wx = px - xi;
    const wy = py - yi;
    const eDotE = Math.max(ex * ex + ey * ey, 1e-12); // guard a zero-length edge, same as the TSL twin
    const t = Math.min(1, Math.max(0, (wx * ex + wy * ey) / eDotE));
    const cx = xi + ex * t;
    const cy = yi + ey * t;
    const ddx = px - cx;
    const ddy = py - cy;
    const distSq = ddx * ddx + ddy * ddy;
    if (distSq < minDistSq) minDistSq = distSq;
  }
  return Math.sqrt(minDistSq);
}

/**
 * `EmanationShapeData` (`common/data/data.mjs:317-335`, verified): a STATIC
 * authored shape, NOT live token tracking — it wraps a `base` shape (any
 * `BaseShapeData` subtype EXCEPT `emanation`/`ring`, per Foundry's own
 * schema) and grows it outward by `radius` pixels, a true Minkowski sum with
 * a disk (`client/data/shapes.mjs:1722+`; e.g. a circular base becomes
 * `getCircle(center, base.radius + this.radius)`, `shapes.mjs:1739`). Even
 * `RegionDocument.createTokenEmanation` (`client/documents/region.mjs:
 * 1268-1286`) BAKES the token's position into `base.x/y` at creation time —
 * later token movement re-writes the region's own shape data via a real
 * document update (`client/documents/token.mjs#computeAttachedRegionUpdates`),
 * it does not bind live to a moving transform at render time. So an
 * emanation shape read here is always a plain, static geometric definition.
 *
 * Exact per base type: circle/ellipse growth is exact (Minkowski sum of a
 * disk with a disk, or — for ellipse — an APPROXIMATION: true ellipse+disk
 * Minkowski sum has no simple closed form, so this widens both radii by
 * `radius` directly, which is exact only for a circular base and a close
 * approximation otherwise, most accurate at modest `radius` relative to the
 * base ellipse's own size). Rectangle/polygon growth is EXACT (inside the
 * base shape, OR within `radius` of its boundary — genuinely the Minkowski
 * sum with a disk for any convex-or-not polygon/rect). `cone`/`line`/
 * `token` bases are NOT implemented (never matches, never throws) — a
 * documented gap: these combinations are rare, and cone/line growth has no
 * equally simple boundary-distance shortcut without porting real offset-
 * polygon geometry. `ring`/`emanation` bases can't occur (excluded by
 * Foundry's own schema) and fall through the same `default`.
 *
 * @param {number} px @param {number} py
 * @param {{radius:number, base:object}} emanation
 * @returns {boolean}
 */
export function pointInEmanation(px, py, emanation) {
  const base = emanation?.base;
  if (!base) return false;
  const radius = Math.max(0, num(emanation.radius, 0));
  switch (base.type) {
    case 'circle': {
      const r = num(base.radius, 0) + radius;
      return pointInEllipse(px, py, { x: base.x, y: base.y, radiusX: r, radiusY: r });
    }
    case 'ellipse':
      return pointInEllipse(px, py, {
        x: base.x,
        y: base.y,
        radiusX: num(base.radiusX, 0) + radius,
        radiusY: num(base.radiusY, 0) + radius,
        rotation: base.rotation,
      });
    case 'rectangle':
      if (pointInRectangle(px, py, base)) return true;
      return radius > 0 && distanceToRectangleBoundary(px, py, base) <= radius;
    case 'polygon': {
      const points = base.points;
      if (!Array.isArray(points) || points.length < 6 || points.length % 2 !== 0) return false;
      if (pointInPolygon(px, py, points)) return true;
      return radius > 0 && distanceToPolygonBoundary(px, py, points) <= radius;
    }
    default:
      // cone/line/token bases (this function's own doc) — never matches.
      return false;
  }
}

/**
 * Dispatch ONE shape's own containment test by its `type` — the single
 * per-shape building block both the non-hole UNION pass and the HOLE
 * SUBTRACTION pass in `pointInRegionShapes` below share, so the type switch
 * itself is written exactly once.
 *
 * @param {number} px @param {number} py @param {object} shape
 * @returns {boolean}
 */
function pointInOneShape(px, py, shape) {
  switch (shape.type) {
    case 'rectangle':
      return pointInRectangle(px, py, shape);
    case 'ellipse':
      return pointInEllipse(px, py, shape);
    case 'circle':
      return pointInEllipse(px, py, { x: shape.x, y: shape.y, radiusX: shape.radius, radiusY: shape.radius });
    case 'polygon':
      return pointInPolygon(px, py, shape.points);
    case 'cone':
      return pointInCone(px, py, shape);
    case 'ring':
      return pointInRing(px, py, shape);
    case 'line':
      return pointInLine(px, py, shape);
    case 'emanation':
      return pointInEmanation(px, py, shape);
    default:
      // token/grid, or an unrecognized future type — never matches, never throws.
      return false;
  }
}

/**
 * Is `(px,py)` inside a region's own shapes — UNION of the non-hole shapes,
 * minus (subtracting) the union of the `hole` shapes? See this module's
 * header for the union-not-real-CSG simplification this represents
 * (a GLOBAL hole subtraction across the whole region, not Foundry's exact
 * consecutive-shape-run/ClipperLib ordering — a documented approximation,
 * exact for the common case of a region with ONE hole cut into it, and for
 * any region where the non-hole and hole shapes don't themselves overlap in
 * a way that depends on authoring order).
 *
 * @param {number} px @param {number} py @param {object[]} shapes - each a raw
 *   `BaseShapeData`-shaped object carrying its own `type` discriminator
 *   (`'rectangle'|'circle'|'ellipse'|'polygon'|'cone'|'ring'|'line'|
 *   'emanation'|...` — Foundry's own `TypedSchemaField` injects this field
 *   onto every shape instance, verified against source, `common/data/
 *   fields.mjs`) and its own `hole` boolean (`BaseShapeData.hole`, verified
 *   real and applying uniformly to every shape type, `common/data/data.mjs`).
 * @returns {boolean}
 */
export function pointInRegionShapes(px, py, shapes) {
  if (!Array.isArray(shapes)) return false;
  let insideNonHole = false;
  for (const shape of shapes) {
    if (!shape || shape.hole) continue;
    if (pointInOneShape(px, py, shape)) {
      insideNonHole = true;
      break;
    }
  }
  if (!insideNonHole) return false;
  for (const shape of shapes) {
    if (!shape || !shape.hole) continue;
    if (pointInOneShape(px, py, shape)) return false; // a hole subtracts, regardless of authoring order
  }
  return true;
}

/**
 * A CONSERVATIVE world-space bounding box for one shape — for sizing/
 * positioning its mesh, NOT for the containment test itself (that's the
 * analytic per-fragment test in TSL below; a generous bound here only costs
 * a few extra discarded fragments, never a correctness issue — this
 * module's own TSL-section header explains why). Returns `null` for an
 * unsupported/malformed shape (the caller skips building a mesh for it,
 * matching `pointInRegionShapes`'s own "never matches" treatment).
 *
 * @param {object} shape
 * @returns {{cx:number, cy:number, halfWidth:number, halfHeight:number}|null}
 */
export function computeShapeMeshBounds(shape) {
  if (!shape) return null;
  switch (shape.type) {
    case 'rectangle': {
      const width = num(shape.width, 0);
      const height = num(shape.height, 0);
      if (!(width > 0) || !(height > 0)) return null;
      // The diagonal safely bounds the box regardless of rotation/anchor
      // (anchor is a 0..1 fraction of width/height, so the shifted box never
      // reaches beyond one full width/height past the origin either way).
      const diag = Math.sqrt(width * width + height * height);
      return { cx: num(shape.x, 0), cy: num(shape.y, 0), halfWidth: diag, halfHeight: diag };
    }
    case 'ellipse': {
      const radiusX = num(shape.radiusX, 0);
      const radiusY = num(shape.radiusY, 0);
      if (!(radiusX > 0) || !(radiusY > 0)) return null;
      const r = Math.max(radiusX, radiusY);
      return { cx: num(shape.x, 0), cy: num(shape.y, 0), halfWidth: r, halfHeight: r };
    }
    case 'circle': {
      const radius = num(shape.radius, 0);
      if (!(radius > 0)) return null;
      return { cx: num(shape.x, 0), cy: num(shape.y, 0), halfWidth: radius, halfHeight: radius };
    }
    case 'polygon': {
      const points = shape.points;
      if (!Array.isArray(points) || points.length < 6 || points.length % 2 !== 0) return null;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < points.length; i += 2) {
        const x = points[i];
        const y = points[i + 1];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
      return {
        cx: (minX + maxX) / 2,
        cy: (minY + maxY) / 2,
        halfWidth: (maxX - minX) / 2,
        halfHeight: (maxY - minY) / 2,
      };
    }
    case 'cone': {
      // The whole disk, not just the wedge — generous, same "a few extra
      // discarded fragments, never a correctness issue" philosophy as every
      // other bound here (a true wedge-only bound would need the rotation/
      // angle to size tightly, not worth it for a bounding-quad hint).
      const radius = num(shape.radius, 0);
      if (!(radius > 0)) return null;
      return { cx: num(shape.x, 0), cy: num(shape.y, 0), halfWidth: radius, halfHeight: radius };
    }
    case 'ring': {
      const radius = num(shape.radius, 0);
      const outerRadius = radius + num(shape.outerWidth, 0);
      if (!(outerRadius > 0)) return null;
      return { cx: num(shape.x, 0), cy: num(shape.y, 0), halfWidth: outerRadius, halfHeight: outerRadius };
    }
    case 'line': {
      const length = num(shape.length, 0);
      const width = num(shape.width, 0);
      if (!(length > 0) || !(width > 0)) return null;
      // Same "diagonal from the origin corner" reasoning as rectangle above
      // — the line's own true worst-case extent from its origin endpoint is
      // sqrt(length² + (width/2)²) (origin is centered across width, not a
      // true corner); sqrt(length²+width²) is a safe, slightly more
      // generous bound, kept for consistency with this file's own style.
      const diag = Math.sqrt(length * length + width * width);
      return { cx: num(shape.x, 0), cy: num(shape.y, 0), halfWidth: diag, halfHeight: diag };
    }
    case 'emanation': {
      // Only for base types pointInEmanation actually implements — building
      // a mesh for an unsupported base (cone/line/token) would just be a
      // mesh that always discards; skip it at the source instead, matching
      // this function's own "unsupported shape has no bounds" contract.
      const base = shape.base;
      if (!base || !['circle', 'ellipse', 'rectangle', 'polygon'].includes(base.type)) return null;
      const baseBounds = computeShapeMeshBounds(base);
      if (!baseBounds) return null;
      const radius = Math.max(0, num(shape.radius, 0));
      return {
        cx: baseBounds.cx,
        cy: baseBounds.cy,
        halfWidth: baseBounds.halfWidth + radius,
        halfHeight: baseBounds.halfHeight + radius,
      };
    }
    default:
      return null;
  }
}

/**
 * Copy a flat WORLD-space `[x0,y0,x1,y1,...]` polygon into a caller-owned,
 * FIXED-CAPACITY array of mutable `{x,y}` points — the polygon material's
 * own `uniformArray` backing store. Same reuse/truncation contract as
 * `point-light-illumination.js#writeLightEdgePoints` (mutate in place, never
 * grow, truncate gracefully past capacity) — deliberately NOT normalized to
 * local/unit space (unlike that function): this shape's shader tests
 * directly against `positionWorld`, so the points stay in world space as-is.
 *
 * @param {number[]} points @param {Array<{x:number,y:number}>} outPoints
 * @returns {number} how many of `outPoints` were written (<= outPoints.length).
 */
export function writeRegionPolygonPoints(points, outPoints) {
  const n = Array.isArray(points) ? Math.floor(points.length / 2) : 0;
  const count = Math.min(n, outPoints.length);
  for (let i = 0; i < count; i++) {
    const x = points[i * 2];
    const y = points[i * 2 + 1];
    outPoints[i].x = Number.isFinite(x) ? x : 0;
    outPoints[i].y = Number.isFinite(y) ? y : 0;
  }
  return count;
}

/**
 * `AdjustDarknessLevelRegionBehaviorType.MODES` — verbatim from source
 * (`client/data/region-behaviors/adjust-darkness-level.mjs`).
 */
export const DARKNESS_ADJUST_MODES = Object.freeze({ OVERRIDE: 0, BRIGHTEN: 1, DARKEN: 2 });

/**
 * The three darkness-adjustment formulas, verbatim from source:
 *   OVERRIDE(0): darknessLevel = modifier
 *   BRIGHTEN(1): darknessLevel * (1 - modifier)
 *   DARKEN(2):   1 - (1 - darknessLevel) * (1 - modifier)
 * An unrecognized `mode` changes nothing (returns `darkness01` unmodified) —
 * never throws, never NaNs.
 *
 * @param {number} darkness01 @param {number} mode @param {number} modifier
 * @returns {number} the adjusted darkness, 0..1.
 */
export function applyDarknessAdjustment(darkness01, mode, modifier) {
  const base = Math.min(1, Math.max(0, num(darkness01, 0)));
  const m = Math.min(1, Math.max(0, num(modifier, 0)));
  switch (mode) {
    case DARKNESS_ADJUST_MODES.OVERRIDE:
      return m;
    case DARKNESS_ADJUST_MODES.BRIGHTEN:
      return base * (1 - m);
    case DARKNESS_ADJUST_MODES.DARKEN:
      return 1 - (1 - base) * (1 - m);
    default:
      return base;
  }
}

/**
 * Does a darkness-adjusting region's own elevation range overlap a floor's
 * elevation band? The elevation-gating half of the 2026-07-19 multi-floor
 * fix (see this module's own header SCOPE section for the full mechanism —
 * this is the pure, Node-testable overlap test; `vt-pan-viewer.js#update
 * RegionDarknessMeshes` calls it once per active region per frame against
 * the CURRENTLY VIEWED floor's own band, read via
 * `foundry/active-scene-source.js#getActiveSceneFloors`).
 *
 * `null` on either side of either range reads as Foundry's own convention
 * (`common/documents/region.mjs`'s `elevation` field comment, verified):
 * a `null` bottom is -Infinity, a `null` top is +Infinity — i.e. a region
 * (or a floor) with no elevation restriction authored overlaps everything.
 * This is why an ordinary region — the overwhelming common case, elevation
 * left untouched by the GM — is unaffected by this gate at all: both its
 * own bottom/top read as ±Infinity, so the overlap test is trivially true
 * for every floor, exactly matching the pre-this-fix (unconditional)
 * behaviour for every region that doesn't explicitly restrict elevation.
 *
 * Standard half-open-interval overlap (`aBottom <= bTop && bBottom <= aTop`)
 * — two ranges overlap unless one ends entirely before the other begins.
 *
 * @param {number|null} regionBottom @param {number|null} regionTop
 * @param {number|null} floorBottom @param {number|null} floorTop
 * @returns {boolean}
 */
export function regionOverlapsElevationBand(regionBottom, regionTop, floorBottom, floorTop) {
  const rBottom = Number.isFinite(regionBottom) ? regionBottom : -Infinity;
  const rTop = Number.isFinite(regionTop) ? regionTop : Infinity;
  const fBottom = Number.isFinite(floorBottom) ? floorBottom : -Infinity;
  const fTop = Number.isFinite(floorTop) ? floorTop : Infinity;
  return rBottom <= fTop && fBottom <= rTop;
}

/**
 * The scene darkness a query point ACTUALLY sees, after every darkness-
 * adjusting region it falls inside — the CPU/TSL-side stand-in for Foundry's
 * own per-pixel `darknessLevelTexture` sample (this module's header). No
 * matching region: `darkness01` passes through unchanged.
 *
 * OVERLAP RULE — CORRECTED (2026-07-19), verified against source (was a
 * guess, documented as one, and was wrong): a prior version of this function
 * used "last matching region in array order wins" — a bare overwrite. Real
 * Foundry does not compose regions by array/creation order at all.
 * `illumination-effects.mjs#invalidateDarknessLevelContainer` sorts region
 * meshes by their OWN adjusted darkness level, DESCENDING, with its own
 * comment stating the reason explicitly: "the final darkness level at a
 * point is the MINIMUM of the adjusted darkness levels" — then draws them
 * with a plain (non-additive) opaque overwrite, so the region computing the
 * LOWEST (brightest) adjusted value ends up drawn last and wins. This
 * function reproduces that OUTCOME directly (evaluate every matching
 * region's own adjusted value independently from the SAME base `darkness01`
 * — never chained/compounding through a running result — then take the
 * minimum), which is mathematically identical to Foundry's sort-then-
 * overwrite mechanism without needing to replicate the sort itself here.
 *
 * @param {number} px @param {number} py @param {number} darkness01
 * @param {Array<{mode:number, modifier:number, shapes:object[]}>} regions -
 *   `foundry/scene-regions.js#readActiveDarknessRegions`'s own `.regions`.
 * @returns {number}
 */
export function computeRegionAdjustedDarkness(px, py, darkness01, regions) {
  if (!Array.isArray(regions) || regions.length === 0) return darkness01;
  let result = null;
  for (const region of regions) {
    if (!region) continue;
    if (pointInRegionShapes(px, py, region.shapes)) {
      // Every match reads the ORIGINAL darkness01, never the running
      // `result` — each region's adjustment is independent, not a cascade.
      const adjusted = applyDarknessAdjustment(darkness01, region.mode, region.modifier);
      result = result === null ? adjusted : Math.min(result, adjusted);
    }
  }
  return result === null ? darkness01 : result;
}
