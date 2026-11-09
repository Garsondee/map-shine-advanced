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
 * Edge slack (world units) the rectangle region SHADER adds on every side,
 * so two rectangles that share an edge never leave a gap pixel between them.
 * Each shape is its own mesh and each mesh interpolates `positionWorld`
 * separately in float32, so for a fragment sitting on the shared edge (grid-
 * aligned edges land on pixel centres at common zooms) mesh A can compute a
 * local coordinate a few ULP beyond its edge while mesh B computes one a few
 * ULP short of its own: both reject, the ambient (bright) fill shows through
 * as a hairline across the whole seam. ULP at scene coordinates (<= ~16k) is
 * ~1e-3, so 0.02 is ~10x the error and ~0.0004 of a 50-unit grid square.
 */
export const REGION_EDGE_TOLERANCE = 0.02;

/**
 * Local-space rectangle containment with edge slack — the exact test the
 * rectangle material evaluates per fragment (`tolerance` 0 is the plain
 * inclusive test `pointInRectangle` uses).
 * @param {number} lx @param {number} ly local (un-rotated, origin-relative) point
 * @param {number} left @param {number} top @param {number} width @param {number} height
 * @param {number} [tolerance]
 * @returns {boolean}
 */
export function localRectangleContains(lx, ly, left, top, width, height, tolerance = 0) {
  return (
    lx >= left - tolerance && lx <= left + width + tolerance && ly >= top - tolerance && ly <= top + height + tolerance
  );
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
 * The lowest darkness value any active OVERRIDE/DARKEN region can EVER read,
 * at the scene's own brightest possible moment (`darkness01=0`) — i.e. "how
 * dark does this region insist on staying even at high noon." Built
 * 2026-08-15 to answer a Foundry-vision question, not a rendering one: see
 * `foundry/scene-environment.js#deriveGlobalLightWindow`'s own header for why
 * a Global Illumination window needs this number.
 *
 * Reuses `applyDarknessAdjustment` at `darkness01=0` rather than re-deriving
 * the arithmetic — both OVERRIDE and DARKEN collapse to exactly `modifier` at
 * that point (`OVERRIDE` is base-independent by construction; `DARKEN`'s
 * `1-(1-0)*(1-m) = m`), so this is the SAME formula this file already proved
 * against Foundry's own source, not a second copy that could quietly drift
 * from it (the class of bug named in `feedback_read_the_producer_never_
 * invent_its_shape`).
 *
 * `BRIGHTEN` regions are deliberately EXCLUDED, not folded in as "floor=0":
 * a brighten region (e.g. a skylight) is authored to let outdoor light IN,
 * so it must never be the region that drags the scene-wide minimum down to
 * zero and silently cancels every genuine DARKEN/OVERRIDE room's protection.
 *
 * ⚠️ AND SO IS ANY REGION WHOSE FLOOR COMES OUT AT ZERO, WHATEVER ITS MODE —
 * A BUG FOUND 2026-08-15, THE SAME DAY THIS FUNCTION SHIPPED, AFTER THE
 * AUTHOR RE-REPORTED THE ORIGINAL SYMPTOM AS STILL BROKEN. Excluding
 * `BRIGHTEN` by MODE was only half the idea: an `OVERRIDE` region with
 * `modifier: 0` (a courtyard authored as "always full daylight here") is
 * semantically just as bright, and it collapsed this minimum to 0 — which
 * `deriveGlobalLightWindow` then turned into a `<= 0` window and refused to
 * open at all, silently disabling outdoor daylight vision for the WHOLE
 * scene. A `DARKEN` with `modifier: 0` (an authored no-op) did the same. The
 * question this function is really asking is "how dark does this region
 * INSIST on staying", so a region that insists on nothing (floor 0) has no
 * claim on the answer, regardless of which mode expressed it.
 *
 * @param {Array<{mode: number, modifier: number}>} regions - active
 *   darkness-adjusting regions, e.g. `readActiveDarknessRegions().regions`
 *   (unfiltered by elevation/floor — a Global Illumination window is scene-
 *   wide, so it must stay safe for a region on ANY floor, not just the one
 *   currently rendered).
 * @returns {number|null} the minimum floor across every genuinely-darkening
 *   region, or `null` if there are none. `null` means "no region makes a
 *   darkness claim" — NOT "disable the feature"; see
 *   `deriveGlobalLightWindow`, which treats it as "nothing to clamp against".
 */
export function computeMinimumDarknessFloor(regions) {
  let minFloor = null;
  for (const region of Array.isArray(regions) ? regions : []) {
    if (!region) continue;
    if (region.mode !== DARKNESS_ADJUST_MODES.OVERRIDE && region.mode !== DARKNESS_ADJUST_MODES.DARKEN) continue;
    const floor = applyDarknessAdjustment(0, region.mode, region.modifier);
    // floor <= 0 ⇒ this region is BRIGHT, not protective — see the header.
    if (!(floor > 0)) continue;
    if (minFloor === null || floor < minFloor) minFloor = floor;
  }
  return minFloor;
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
 * ⚠️ BOTH RANGES ARE HALF-OPEN AT THE TOP — `[bottom, top)`. This was a CLOSED
 * test (`rBottom <= fTop && fBottom <= rTop`) until 2026-07-26, and its own
 * comment claimed "half-open" while the code was not. The bug that exposed it,
 * author-reported: on the bridge map's GROUND floor (band `[0,10]`), a darkness
 * Region belonging to the MIDDLE floor (band `[10,20]`) stayed active and painted
 * five building-shaped rectangles of lighter ground onto the river below —
 * indistinguishable, by eye, from holes punched in the new sky-reach shadow.
 *
 * Adjacent floors SHARE a boundary by construction: floor N's `top` IS floor
 * N+1's `bottom`. A closed test therefore says every region touching that
 * boundary belongs to BOTH floors, so any region authored to span exactly one
 * floor's band leaks into its neighbour. Half-open makes the shared boundary
 * belong to the UPPER floor alone, which is the same convention
 * `scene/mask-derive.js` uses for level art and for exactly the same reason
 * (memory: feedback_membership_beats_derived_threshold — this is that bug class
 * a third time, in a third subsystem).
 *
 * A ZERO-HEIGHT region (`bottom === top`, a GM pinning one elevation) is a POINT,
 * not an interval, and a half-open test would reject it against its own floor's
 * ground. It gets `fBottom <= p < fTop` instead — the same rule, applied to a
 * degenerate range rather than silently dropping it.
 *
 * `null` on either side still reads as Foundry's own convention
 * (`common/documents/region.mjs`'s `elevation` field comment, verified): a null
 * bottom is -Infinity, a null top is +Infinity. So an ordinary region — the
 * overwhelming common case, elevation left untouched by the GM — is `(-∞, +∞)`
 * and still overlaps every floor, exactly as before. Likewise an unresolvable
 * floor band stays fail-open.
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
  if (rBottom === rTop) return rBottom >= fBottom && rBottom < fTop;
  return rBottom < fTop && rTop > fBottom;
}

/**
 * Is a Region with these `levels` viewed on the Level `viewedLevelId`?
 * Foundry's own rule (`client/documents/abstract/canvas-document.mjs#includedInLevel`):
 * an EMPTY list means every Level; otherwise only the listed ones. A darkness
 * behaviour is only drawn while its Region is viewed
 * (`client/canvas/board.mjs#handleRegionBehaviorViewedEvents`), so a Region
 * scoped to Ground does nothing while the Basement or Upper is viewed, whatever
 * its elevation (lab IR-22/IR-23, mmp-78u.19).
 *
 * No viewed Level identified (`viewedLevelId` null) fails OPEN, the same
 * posture as the elevation gate: never darkness-mute a scene on a lookup miss.
 *
 * @param {string[]|undefined} levels @param {string|null} viewedLevelId
 * @returns {boolean}
 */
export function regionIncludedInLevel(levels, viewedLevelId) {
  if (!Array.isArray(levels) || levels.length === 0) return true;
  if (typeof viewedLevelId !== 'string' || viewedLevelId.length === 0) return true;
  return levels.includes(viewedLevelId);
}

/**
 * THE VIEWER'S REGION GATE, ONE PLACE (2026-11-09): the darkness Regions that
 * apply while a floor is viewed. Two tests, both Foundry's:
 *   1. LEVELS — `regionIncludedInLevel` against the VIEWED Level (Foundry scopes
 *      a behaviour by the viewed Level, not by the pixel's floor).
 *   2. ELEVATION — `regionOverlapsElevationBand` against the viewed floor's band.
 *      Foundry depth-tests elevation PER PIXEL, so a lower floor seen through a
 *      hole gets the Regions of ITS elevation; MSA still tests the VIEWED
 *      floor's band for every pixel (the open half of mmp-78u.19: an
 *      elevation-only Region over a stairwell, seen from above, is missed).
 *
 * @param {Array<{levels?: string[], elevationBottom: number|null, elevationTop: number|null}>} regions
 * @param {{floorBottom?: number|null, floorTop?: number|null, viewedLevelId?: string|null}} view
 * @returns {Array<object>} a new array (the input is never mutated)
 */
export function selectRegionsForViewedFloor(
  regions,
  { floorBottom = null, floorTop = null, viewedLevelId = null } = {}
) {
  if (!Array.isArray(regions)) return [];
  return regions.filter(
    (region) =>
      regionIncludedInLevel(region?.levels, viewedLevelId) &&
      regionOverlapsElevationBand(region?.elevationBottom, region?.elevationTop, floorBottom, floorTop)
  );
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

/* -------------------------------------------- */
/*  THE SOFT EDGE (2026-11-04)                   */
/* -------------------------------------------- */

/**
 * THE SOFT EDGE (2026-11-04, author request: darkness regions drew "pixel
 * perfect lines across the map"; fade them over about 30 px, and never leave a
 * bright seam where two region shapes touch).
 *
 * Why a FIELD, not a per-shape fade. Fading each shape on its own fails the
 * second half of the request: two rectangles that share an edge would each be
 * half-faded at that edge, and the seam between them would read brighter than
 * either. So the regions are first drawn HARD, exactly as before (same shapes,
 * same holes, same brightest-wins order), into one small WORLD-space texture,
 * the "region field". Only then is that finished field blurred. A seam between
 * two touching shapes no longer exists by the time the blur sees it, so it
 * cannot open; only the field's outer edge, and the step between two regions
 * of different darkness, are softened.
 *
 * What a field texel holds. Every Foundry mode is AFFINE in the scene's base
 * darkness (see `regionFieldCoefficients`), so a texel stores `(a, b, c)`:
 * coverage `c` (1 inside a region, 0 outside or in a hole) and the region's
 * `a`, `b` premultiplied by it. Blurring is linear, so the blurred texel still
 * means "this much coverage, at this darkness": the composite rebuilds
 * `a + b * base` per pixel. The field therefore only changes when the regions
 * or their draw order change, not every time the darkness slider moves, and is
 * re-baked only then.
 */

/** The width, in scene pixels, across which a region's darkness fades in. */
export const REGION_EDGE_FADE_PX = 30;
/** World pixels per field texel when the regions are small enough to afford it. */
export const REGION_FIELD_TEXEL_PX = 4;
/**
 * The field's largest side, in texels. 1536 (as the water-body grid) sits under
 * the Keyhole law's plain 2048 cap, so no world-scale exception is claimed:
 * regions spanning more than 1536 x 4 = 6144 px just get coarser texels.
 */
export const REGION_FIELD_MAX_DIM = 1536;
/** Field sides round up to this many texels, so a small edit to a region rarely reallocates. */
export const REGION_FIELD_DIM_STEP = 64;
/** Gaussian taps EACH SIDE of the centre in each blur pass (13 per pass). */
export const REGION_FIELD_BLUR_TAPS = 6;

/**
 * The blur's sigma for a fade band `fadePx` wide. A Gaussian step climbs from
 * 2.3% to 97.7% across four sigmas, so the band is four sigmas wide and
 * centred on the authored edge: half the fade lies inside the region, half
 * outside it.
 * @param {number} [fadePx]
 * @returns {number}
 */
export function regionFadeSigmaPx(fadePx = REGION_EDGE_FADE_PX) {
  return Math.max(0, num(fadePx, REGION_EDGE_FADE_PX)) / 4;
}

/**
 * The darkness a region computes, written as `a + b * base`. Every mode is
 * affine in the base darkness (the three formulas in `applyDarknessAdjustment`):
 *   OVERRIDE: m                      -> a = m, b = 0
 *   BRIGHTEN: base * (1 - m)         -> a = 0, b = 1 - m
 *   DARKEN:   1 - (1 - base)(1 - m)  -> a = m, b = 1 - m
 * An unknown mode changes nothing (a = 0, b = 1), as `applyDarknessAdjustment` does.
 * @param {number} mode @param {number} modifier
 * @returns {{a:number, b:number}}
 */
export function regionFieldCoefficients(mode, modifier) {
  const m = Math.min(1, Math.max(0, num(modifier, 0)));
  switch (mode) {
    case DARKNESS_ADJUST_MODES.OVERRIDE:
      return { a: m, b: 0 };
    case DARKNESS_ADJUST_MODES.BRIGHTEN:
      return { a: 0, b: 1 - m };
    case DARKNESS_ADJUST_MODES.DARKEN:
      return { a: m, b: 1 - m };
    default:
      return { a: 0, b: 1 };
  }
}

/**
 * The world corners of a box held in a rotated local frame (origin + R(rotation) * local).
 * @returns {{minX:number, minY:number, maxX:number, maxY:number}}
 */
function rotatedBoxAabb(ox, oy, rotationDeg, left, top, right, bottom) {
  const c = Math.cos(rotationDeg * DEG2RAD);
  const s = Math.sin(rotationDeg * DEG2RAD);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [lx, ly] of [
    [left, top],
    [right, top],
    [left, bottom],
    [right, bottom],
  ]) {
    const x = ox + lx * c - ly * s;
    const y = oy + lx * s + ly * c;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * A TIGHT world-space box around one shape's true footprint — what the region
 * field is sized from. `computeShapeMeshBounds` stays the mesh-positioning
 * hint it always was (a rectangle there is its full diagonal in every
 * direction from its origin corner, nearly three times its own area: fine for
 * a quad that discards, wasteful for a texture). Rectangles and lines are
 * bounded by their rotated corners; every other shape by
 * `computeShapeMeshBounds`, which is already tight for them.
 * @param {object} shape
 * @returns {{minX:number, minY:number, maxX:number, maxY:number}|null}
 */
export function computeShapeWorldAabb(shape) {
  if (!shape) return null;
  if (shape.type === 'rectangle') {
    const width = num(shape.width, 0);
    const height = num(shape.height, 0);
    if (!(width > 0) || !(height > 0)) return null;
    const left = -num(shape.anchorX, 0) * width;
    const top = -num(shape.anchorY, 0) * height;
    return rotatedBoxAabb(
      num(shape.x, 0),
      num(shape.y, 0),
      num(shape.rotation, 0),
      left,
      top,
      left + width,
      top + height
    );
  }
  if (shape.type === 'line') {
    const length = num(shape.length, 0);
    const width = num(shape.width, 0);
    if (!(length > 0) || !(width > 0)) return null;
    return rotatedBoxAabb(num(shape.x, 0), num(shape.y, 0), num(shape.rotation, 0), 0, -width / 2, length, width / 2);
  }
  if (shape.type === 'emanation' && shape.base?.type === 'rectangle') {
    const base = computeShapeWorldAabb(shape.base);
    if (!base) return null;
    const r = Math.max(0, num(shape.radius, 0));
    return { minX: base.minX - r, minY: base.minY - r, maxX: base.maxX + r, maxY: base.maxY + r };
  }
  const b = computeShapeMeshBounds(shape);
  if (!b) return null;
  return { minX: b.cx - b.halfWidth, minY: b.cy - b.halfHeight, maxX: b.cx + b.halfWidth, maxY: b.cy + b.halfHeight };
}

/**
 * Size and place the region field for this frame's shapes.
 *
 * The union of the shapes' boxes is clipped to `clipRect` (the canvas: nothing
 * past it is ever seen, and a region drawn huge must not size a huge texture),
 * then grown by one fade width so the field's own border is always empty and
 * the overlay never shows a rectangle where the field ends. Texels are square;
 * sides round up to `REGION_FIELD_DIM_STEP` (the extra lands as margin on the
 * max side) and stop at `REGION_FIELD_MAX_DIM`, past which texels grow instead.
 *
 * @param {Array<{minX:number,minY:number,maxX:number,maxY:number}|null>} boxes
 * @param {{minX:number,minY:number,maxX:number,maxY:number}|null} clipRect
 * @param {number} [fadePx]
 * @returns {{rect:{minX:number,minY:number,maxX:number,maxY:number}, width:number, height:number,
 *   texelPx:number, sigmaTexels:number}|null} null when nothing visible remains.
 */
export function planRegionField(boxes, clipRect, fadePx = REGION_EDGE_FADE_PX) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of Array.isArray(boxes) ? boxes : []) {
    if (!b || !Number.isFinite(b.minX) || !Number.isFinite(b.maxX)) continue;
    if (!Number.isFinite(b.minY) || !Number.isFinite(b.maxY)) continue;
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
  }
  if (clipRect) {
    minX = Math.max(minX, clipRect.minX);
    minY = Math.max(minY, clipRect.minY);
    maxX = Math.min(maxX, clipRect.maxX);
    maxY = Math.min(maxY, clipRect.maxY);
  }
  if (!(maxX > minX) || !(maxY > minY)) return null;
  const margin = Math.max(0, num(fadePx, REGION_EDGE_FADE_PX)) + 2 * REGION_FIELD_TEXEL_PX;
  minX -= margin;
  minY -= margin;
  maxX += margin;
  maxY += margin;
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const texelPx = Math.max(REGION_FIELD_TEXEL_PX, Math.max(spanX, spanY) / REGION_FIELD_MAX_DIM);
  const roundUp = (n) =>
    Math.min(REGION_FIELD_MAX_DIM, Math.max(1, Math.ceil(n / REGION_FIELD_DIM_STEP)) * REGION_FIELD_DIM_STEP);
  const width = roundUp(Math.ceil(spanX / texelPx));
  const height = roundUp(Math.ceil(spanY / texelPx));
  return {
    rect: { minX, minY, maxX: minX + width * texelPx, maxY: minY + height * texelPx },
    width,
    height,
    texelPx,
    sigmaTexels: regionFadeSigmaPx(fadePx) / texelPx,
  };
}

/** Folds one number into a 32-bit FNV-1a style hash (quantised to 1/1000 of a unit). */
function hashNumber(h, v) {
  const q = Number.isFinite(v) ? Math.round(v * 1000) : 0x7fffffff;
  h = Math.imul(h ^ (q & 0xffff), 16777619);
  return Math.imul(h ^ ((q >>> 16) & 0xffff), 16777619);
}

/** @returns {number} */
function hashString(h, s) {
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return Math.imul(h ^ 0xff, 16777619);
}

const SHAPE_HASH_FIELDS = [
  'x',
  'y',
  'width',
  'height',
  'anchorX',
  'anchorY',
  'rotation',
  'radius',
  'radiusX',
  'radiusY',
  'angle',
  'innerWidth',
  'outerWidth',
  'length',
];

/** @returns {number} */
function hashShape(h, shape) {
  if (!shape) return hashNumber(h, -1);
  h = hashString(h, shape.type);
  h = hashNumber(h, shape.hole ? 1 : 0);
  for (const key of SHAPE_HASH_FIELDS) h = hashNumber(h, shape[key]);
  const points = Array.isArray(shape.points) ? shape.points : null;
  h = hashNumber(h, points ? points.length : -1);
  if (points) for (let i = 0; i < points.length; i++) h = hashNumber(h, points[i]);
  if (shape.base) h = hashShape(h, shape.base);
  return h;
}

/**
 * Everything the baked region field depends on, folded into one number: the
 * regions in DRAW order (order decides who wins an overlap, and it can flip as
 * the base darkness moves), each one's mode and modifier, every shape's
 * geometry, and the field's own placement. Equal hashes mean the last bake is
 * still exact; the base darkness itself is deliberately NOT included (the field
 * stores coefficients, see the section header).
 * @param {Array<object>} regionsInDrawOrder - regions `{regionId, mode, modifier,
 *   shapes}`, or sort slots `{region}` wrapping them (the viewer's reused sort scratch).
 * @param {{rect:object, width:number, height:number}|null} plan
 * @returns {number}
 */
export function hashRegionFieldInputs(regionsInDrawOrder, plan) {
  let h = 2166136261;
  for (const item of Array.isArray(regionsInDrawOrder) ? regionsInDrawOrder : []) {
    const region = item?.region ?? item;
    if (!region) continue;
    h = hashString(h, region.regionId);
    h = hashNumber(h, region.mode);
    h = hashNumber(h, region.modifier);
    const shapes = Array.isArray(region.shapes) ? region.shapes : [];
    h = hashNumber(h, shapes.length);
    for (const shape of shapes) h = hashShape(h, shape);
  }
  if (plan) {
    h = hashNumber(h, plan.rect.minX);
    h = hashNumber(h, plan.rect.minY);
    h = hashNumber(h, plan.rect.maxX);
    h = hashNumber(h, plan.rect.maxY);
    h = hashNumber(h, plan.width);
    h = hashNumber(h, plan.height);
  }
  return h >>> 0;
}
