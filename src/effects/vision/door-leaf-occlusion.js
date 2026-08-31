/**
 * DOOR-LEAF-OCCLUSION — a swinging door leaf's CURRENT physical position as
 * a real-time vision occluder. The author's own words for the ask: "turn
 * the geometry/texture of the doors into vision blockers and then as the
 * doors swing open they partially reveal what lies beyond them" — a
 * genuinely different mechanism from the existing timer-based cross-fade
 * (`vision-mask-render.js`'s `buildVisionFloorMaterial`/`syncFloor`), which
 * this is ADDITIVE to, not a replacement for: this module decides WHICH
 * pixels can be revealed at all, this frame; the timer fade still decides
 * how bright a pixel is the instant it newly enters that set.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A BOUNDED, LOCAL REFINEMENT AND NOT A SECOND LOS SYSTEM
 * ─────────────────────────────────────────────────────────────────────────
 * [[keyhole-vision-fog-direction]]'s locked doctrine is "consume Foundry's
 * vision compute, never reimplement it" — this module never re-derives a
 * vision polygon from scratch. It only ever REMOVES area from a polygon
 * Foundry already computed and authorized, never adds any. The key
 * geometric fact that makes this tractable rather than a general (and
 * genuinely hard) polygon-boolean-difference problem: Foundry's own
 * `losPoints`/`lightPoints` are ALREADY star-shaped around the vision
 * source's own origin (they come from a radial sweep). The region a single
 * segment shadows, as seen from that SAME origin, is the intersection of
 * three half-planes — convex, hence ALSO star-shaped from that point.
 * Subtracting one region that's star-shaped-from-S from another that's
 * star-shaped-from-S reduces to a per-angle MINIMUM of their two radial
 * functions: at every angle there is still exactly one contiguous
 * `[0, r(θ)]` run, so the result can never fragment into disconnected
 * pieces and stays valid input for `point-light-illumination.js#
 * triangulateLightFan`'s fan-triangulation assumption. This is why a
 * general polygon-clipping library was never needed here.
 *
 * Everything below is pure geometry — cross products only, deliberately no
 * `atan2`/trig anywhere. A finite segment viewed from an external point
 * always subtends an angle <π (a real triangle-interior-angle fact, not an
 * assumption), so there is no long-arc/short-arc wraparound ambiguity for
 * `atan2`'s own ±π branch cut to create in the first place — the
 * cross-product sign tests below sidestep that whole bug class rather than
 * handling it.
 *
 * @module effects/vision/door-leaf-occlusion
 */

// "Is this vector essentially the zero vector" — absolute, because a
// near-zero LENGTH is a scale-independent concept (two points 1e-6 world
// units apart are the same point on a 500px scene or a 12000px one).
const EPS_ABS = 1e-6;
// Wedge-sign collinearity — deliberately RELATIVE, not absolute. A cross
// product's magnitude scales with the product of the two vectors' lengths,
// and this project's scenes range from ~500px to ~12000px; an absolute
// threshold would be far too loose on a small scene and far too tight on a
// large one. Scaled by |dA|*|dB| so the threshold tracks the actual
// magnitudes being compared.
const EPS_REL = 1e-9;

/** 2D cross product of (ux,uy) and (vx,vy). */
function cross(ux, uy, vx, vy) {
  return ux * vy - uy * vx;
}

/**
 * Ray `S + t·(dx,dy)`, `t>0`, intersected against segment `A→B`. Standard
 * two-line-parametrization solve (Cramer's rule on the 2×2 system) — see
 * this module's own tests for a hand-verified worked example.
 * @returns {{t: number, x: number, y: number}|null} null when parallel, or
 *   the intersection falls behind S (`t<=0`) or outside the segment's own
 *   span (`u` outside `[0,1]`).
 */
function raySegmentIntersect(sx, sy, dx, dy, ax, ay, bx, by) {
  const ex = bx - ax;
  const ey = by - ay;
  const denom = cross(ex, ey, dx, dy);
  if (Math.abs(denom) < EPS_ABS) return null; // ray parallel to the segment
  const asx = ax - sx;
  const asy = ay - sy;
  const t = cross(ex, ey, asx, asy) / denom;
  const u = cross(dx, dy, asx, asy) / denom;
  if (t <= EPS_ABS || u < -EPS_ABS || u > 1 + EPS_ABS) return null;
  return { t, x: sx + t * dx, y: sy + t * dy };
}

/**
 * The NEAREST point where a ray from `(sx,sy)` in direction `(dx,dy)`
 * crosses the polygon's own boundary (walks every edge; a star-shaped
 * polygon crosses any ray from its own center exactly once in the generic
 * case, but the nearest-hit search is robust to float noise regardless).
 * @returns {{t: number, x: number, y: number}|null} null if no edge is hit
 *   (degenerate input) — callers must treat this as "nothing to insert
 *   here" and continue safely, never throw.
 */
function raycastPolygonBoundary(points, sx, sy, dx, dy) {
  const n = points.length / 2;
  let best = null;
  for (let i = 0; i < n; i++) {
    const ax = points[i * 2];
    const ay = points[i * 2 + 1];
    const j = (i + 1) % n;
    const bx = points[j * 2];
    const by = points[j * 2 + 1];
    const hit = raySegmentIntersect(sx, sy, dx, dy, ax, ay, bx, by);
    if (hit && (!best || hit.t < best.t)) best = hit;
  }
  return best;
}

/**
 * Clip ONE polygon by the shadow of ONE segment `A→B`, as seen from `(sx,sy)`
 * (the SAME origin the polygon is already star-shaped around — see this
 * module's own header). Returns `points` itself, UNCHANGED (same
 * reference), whenever the segment casts no shadow onto this polygon —
 * never mutates the input either way.
 *
 * @param {number[]} points - flat `[x0,y0,x1,y1,...]`, `losPoints` or
 *   `lightPoints` shape (`foundry/scene-vision.js`).
 * @param {number} sx @param {number} sy - the vision source's own origin.
 * @param {number} ax @param {number} ay @param {number} bx @param {number} by
 *   - the occluding segment's two endpoints (a door leaf's current
 *   hinge/free-edge points — order doesn't matter, verified symmetric).
 * @returns {number[]}
 */
export function clipPolygonBySegmentShadow(points, sx, sy, ax, ay, bx, by) {
  if (!Array.isArray(points)) return points;
  const n = points.length / 2;
  if (n < 3 || points.length % 2 !== 0) return points;

  const dAx = ax - sx;
  const dAy = ay - sy;
  const dBx = bx - sx;
  const dBy = by - sy;

  // Degenerate: S sits essentially AT one of the leaf's own endpoints (a
  // token standing right in the doorway as it swings) — no meaningful
  // wedge from here. Safe fallback: cast no shadow at all.
  if (dAx * dAx + dAy * dAy < EPS_ABS * EPS_ABS) return points;
  if (dBx * dBx + dBy * dBy < EPS_ABS * EPS_ABS) return points;

  const wedgeSign = cross(dAx, dAy, dBx, dBy);
  // Degenerate: S collinear with A and B (the leaf viewed exactly edge-on)
  // — relative threshold, see EPS_REL's own header.
  const lenA = Math.sqrt(dAx * dAx + dAy * dAy);
  const lenB = Math.sqrt(dBx * dBx + dBy * dBy);
  if (Math.abs(wedgeSign) < EPS_REL * lenA * lenB) return points;
  const wSign = wedgeSign > 0 ? 1 : -1;

  // Per-vertex ANGULAR wedge membership (not yet distance-clamped) — a
  // point P is between rays S→A and S→B (the shorter arc, which a segment
  // always subtends — see this module's header) iff cross(dA,dP) and
  // cross(dP,dB) both carry the SAME sign as cross(dA,dB) itself.
  const inWedge = new Array(n);
  for (let i = 0; i < n; i++) {
    const px = points[i * 2] - sx;
    const py = points[i * 2 + 1] - sy;
    const sideA = cross(dAx, dAy, px, py);
    const sideB = cross(px, py, dBx, dBy);
    inWedge[i] = (sideA > 0 ? 1 : sideA < 0 ? -1 : 0) === wSign && (sideB > 0 ? 1 : sideB < 0 ? -1 : 0) === wSign;
  }
  if (!inWedge.some(Boolean)) return points; // wedge doesn't touch this polygon at all

  // ⚠️ THE PATHOLOGICAL CASE, CAUGHT BEFORE IT CAN PRODUCE WRONG GEOMETRY —
  // a single edge whose BOTH endpoints individually read as outside the
  // wedge (neither vertex's own inWedge flag is set) can still DIP THROUGH
  // it, if the doorway opens onto a room whose nearest real polygon
  // vertices are angularly far apart. A per-vertex inWedge check alone
  // misses this; testing each RAY's side independently, per edge, catches
  // it (both sides flip across such an edge even though the combined flag
  // never does). When found: do NOT attempt to splice it — the honest,
  // safe fallback is to skip clipping for this leaf/polygon pair entirely
  // (this frame keeps the existing timer-fade-only look here, nothing
  // more). Cost: at most one frame, for one source against one leaf, in a
  // rare layout — never wrong geometry, never a reveal Foundry didn't
  // already authorize.
  for (let i = 0; i < n; i++) {
    if (inWedge[i]) continue;
    const j = (i + 1) % n;
    if (inWedge[j]) continue;
    const p1x = points[i * 2] - sx;
    const p1y = points[i * 2 + 1] - sy;
    const p2x = points[j * 2] - sx;
    const p2y = points[j * 2 + 1] - sy;
    const sideA1 = Math.sign(cross(dAx, dAy, p1x, p1y));
    const sideA2 = Math.sign(cross(dAx, dAy, p2x, p2y));
    const sideB1 = Math.sign(cross(p1x, p1y, dBx, dBy));
    const sideB2 = Math.sign(cross(p2x, p2y, dBx, dBy));
    if (sideA1 !== sideA2 && sideB1 !== sideB2) return points;
  }

  // Clamp an in-wedge vertex to the leaf segment, ONLY if the leaf is
  // nearer than the vertex itself along that exact ray (t<1 — the vertex's
  // own ray-parameter, since the ray direction here IS px,py = P-S).
  const clampVertex = (px, py) => {
    const hit = raySegmentIntersect(sx, sy, px - sx, py - sy, ax, ay, bx, by);
    return hit && hit.t < 1 - EPS_ABS ? [hit.x, hit.y] : [px, py];
  };
  // Insert a wedge-boundary vertex (at exactly angle A or angle B) ONLY if
  // the ORIGINAL (unclipped) polygon boundary reaches at least as far as
  // that endpoint at this exact angle — otherwise the polygon was already
  // nearer than the leaf there and there is nothing to clip at that angle.
  const boundaryInsertion = (dirX, dirY, epX, epY) => {
    const boundary = raycastPolygonBoundary(points, sx, sy, dirX, dirY);
    if (!boundary || boundary.t < 1 - EPS_ABS) return null;
    return [epX, epY];
  };

  const out = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const vix = points[i * 2];
    const viy = points[i * 2 + 1];

    if (inWedge[i]) {
      const [cx, cy] = clampVertex(vix, viy);
      out.push(cx, cy);
    } else {
      out.push(vix, viy);
    }

    if (inWedge[i] !== inWedge[j]) {
      // The sweep transitions across edge i->j. A straight edge crossing
      // from inside a convex angular wedge to outside (or vice versa)
      // crosses exactly ONE of the two bounding rays — never both — so at
      // most one of these two fires per transition edge.
      const p1x = vix - sx;
      const p1y = viy - sy;
      const p2x = points[j * 2] - sx;
      const p2y = points[j * 2 + 1] - sy;
      const sideA1 = Math.sign(cross(dAx, dAy, p1x, p1y));
      const sideA2 = Math.sign(cross(dAx, dAy, p2x, p2y));
      if (sideA1 !== sideA2) {
        const ins = boundaryInsertion(dAx, dAy, ax, ay);
        if (ins) out.push(ins[0], ins[1]);
      }
      const sideB1 = Math.sign(cross(p1x, p1y, dBx, dBy));
      const sideB2 = Math.sign(cross(p2x, p2y, dBx, dBy));
      if (sideB1 !== sideB2) {
        const ins = boundaryInsertion(dBx, dBy, bx, by);
        if (ins) out.push(ins[0], ins[1]);
      }
    }
  }

  return out.length >= 6 ? out : points; // guard against a degenerate collapse
}

/**
 * Fold {@link clipPolygonBySegmentShadow} over every currently-animating
 * door leaf, with a cheap circle-vs-circle broad-phase reject per leaf so a
 * door nowhere near this source costs one `Math.hypot` call, not a polygon
 * walk.
 *
 * @param {number[]|null} points
 * @param {number} sx @param {number} sy
 * @param {number} sourceRadius - `source.radius` for LOS, `source.lightRadius`
 *   for light — may be `Infinity` (never rejects, always proceeds to the
 *   real clip).
 * @param {Array<{hingeX: number, hingeY: number, freeX: number, freeY: number}>} segments
 * @returns {number[]|null}
 */
export function clipPolygonByDoorLeaves(points, sx, sy, sourceRadius, segments) {
  if (!points || !Array.isArray(segments) || segments.length === 0) return points;
  let result = points;
  for (const seg of segments) {
    if (!seg) continue;
    if (Number.isFinite(sourceRadius)) {
      const distToHinge = Math.hypot(seg.hingeX - sx, seg.hingeY - sy);
      const leafReach = Math.hypot(seg.freeX - seg.hingeX, seg.freeY - seg.hingeY);
      if (distToHinge - leafReach > sourceRadius) continue; // door provably out of range
    }
    result = clipPolygonBySegmentShadow(result, sx, sy, seg.hingeX, seg.hingeY, seg.freeX, seg.freeY);
  }
  return result;
}

/**
 * The one thing `vt-pan-viewer.js` calls: clip every active vision source's
 * `losPoints`/`lightPoints` against every currently-animating door leaf,
 * BEFORE handing the sources to `vision-mask-render.js#sync()`. Returns
 * `sources` itself, unchanged, when `segments` is empty (steady state —
 * zero allocation, the overwhelming majority of frames). A blinded source
 * is skipped (it already contributes nothing downstream —
 * `vision-mask-render.js#sync()`'s own `if (src.blinded) continue`).
 * Never mutates a source's original point arrays; untouched sources keep
 * their original object reference, only affected ones are cloned.
 *
 * @param {Array<object>} sources - `readActiveVisionSources().sources` shape.
 * @param {Array<{hingeX: number, hingeY: number, freeX: number, freeY: number}>} segments
 * @returns {Array<object>}
 */
export function applyDoorLeafOcclusion(sources, segments) {
  if (!Array.isArray(sources) || sources.length === 0) return sources;
  if (!Array.isArray(segments) || segments.length === 0) return sources;

  let changed = false;
  const next = sources.map((src) => {
    if (!src || src.blinded) return src;
    const losPoints = src.losPoints
      ? clipPolygonByDoorLeaves(src.losPoints, src.x, src.y, src.radius, segments)
      : src.losPoints;
    const lightPoints = src.lightPoints
      ? clipPolygonByDoorLeaves(src.lightPoints, src.x, src.y, src.lightRadius, segments)
      : src.lightPoints;
    if (losPoints === src.losPoints && lightPoints === src.lightPoints) return src;
    changed = true;
    return { ...src, losPoints, lightPoints };
  });
  return changed ? next : sources;
}
