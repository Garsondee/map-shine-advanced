/**
 * LIGHT PENUMBRA (2026-11-01) — soft wall edges on point lights, softer the further the
 * light has travelled past the wall that cut it.
 *
 * Author, verbatim: "Currently when a light interacts with a wall we get this hard pixel
 * sharp line. Could we soften the line and make it get more blurry as it moves away from the
 * wall that causes the line? A bit blurred where light meets a wall and very blurred where
 * light cut but going further away from the wall that caused it to be occluded."
 *
 * A light's mesh is a fan over Foundry's wall-clipped polygon (`triangulateLightFan`): one
 * triangle (origin, v_i, v_i+1) per polygon edge, and the polygon is star-shaped from the
 * origin. Its edges are of three kinds:
 *
 *   - ARC: both ends on the light's own radius. The radial falloff already fades there.
 *   - WALL: the light landing on a wall face. Faded over a small, constant width
 *     (`wallPx`): "a bit blurred where light meets a wall".
 *   - SHADOW: a radial edge, collinear with the origin, that starts at a wall's END (the
 *     corner nearer the light) and runs outward. The hard line in the author's screenshot.
 *     Faded over a width that starts small at the corner ({@link CORNER_TIP_FRACTION} of
 *     `wallPx`) and grows by `spread` per pixel travelled past it — a real penumbra: an area
 *     light's shadow edge widens with distance from the occluder that casts it.
 *
 * INSIDE ONLY, ON PURPOSE. The fade darkens the light inside its own polygon; it never adds
 * light outside it. A centred penumbra needs mesh outside the polygon, and that mesh would
 * cross any wall lying within the penumbra wedge — light leaking into the next room, the bug
 * this codebase has fought most. Inside-only cannot leak by construction.
 *
 * NO SEAMS AT WALL NODES (the author, same day: "strange shapes from the light near those
 * nodes … Look carefully at top left bottom right corners"). Every term is computed per fan
 * triangle, and two neighbouring triangles meet on the ray from the light through a polygon
 * vertex. A term that differs across that ray draws a line down it. The first cut measured the
 * wall fade as the perpendicular distance to the triangle's own wall line: at a bend the two
 * walls' lines give different distances on the shared ray (a crease), and at a wall's end the
 * wall triangle stacked its wall fade on the corner fade while the triangle across the ray had
 * the corner fade alone (a stepped dark bulge round the corner). So now:
 *   - the wall fade is the distance the light still has to TRAVEL, along its own ray, before
 *     it hits the wall. On the shared ray through a node both triangles hit the same node at
 *     the same distance, so the fade is continuous across every node;
 *   - a wall triangle ignores a shadow corner lying on its own wall line: its wall fade
 *     already reaches that corner, and on the shared ray it equals the far side's distance
 *     to the corner (both are |corner| − r), so the two sides agree there too.
 *
 * HOW THE SHADER KNOWS (no uniform arrays — those are live-broken here, see the disabled
 * `edgeSoftFactor` in point-light-illumination.js): every fan vertex carries the same
 * {@link PENUMBRA_FLOATS} floats for its whole triangle, {@link writeLightPenumbraVertices}:
 *
 *   aPenEdge   = (radiusPx, isWall)
 *   aPenCorner = (Ax, Ay, Bx, By)   nearest shadow corner on each angular side
 *   aPenWall   = (W0x, W0y, W1x, W1y) this triangle's own wall edge (when isWall)
 *
 * all in local unit space. A side with no shadow edge carries a corner nothing can be near
 * ({@link NO_CORNER}). Only the nearest shadow edge on each side matters: a farther one on
 * the same side faces the other way (its lit side is the region between), so it cannot reach
 * this triangle.
 *
 * @module effects/lighting/light-penumbra
 */

/** Local-unit x of a "no shadow edge on this side" corner: no fragment is within reach. */
export const NO_CORNER = 1e3;
/** Floats per fan vertex: (radiusPx, isWall, Ax, Ay, Bx, By, W0x, W0y, W1x, W1y). */
export const PENUMBRA_FLOATS = 10;
/** One vertex's floats when nothing is faded (no wall, no corner in reach). */
export const NEUTRAL_PENUMBRA = Object.freeze([1, 0, NO_CORNER, 0, NO_CORNER, 0, 0, 2, 1, 2]);

/** An edge whose two ends both sit at least this far out (fraction of radius) is the arc. */
const ARC_MIN = 0.985;
/** |sin| of the angle between the two ends, below which an edge is radial (collinear with the origin). */
const RADIAL_SIN = 2e-3;
/** A radial edge must actually run outward this far (fraction of radius), not be a sliver. */
const RADIAL_MIN_RUN = 1e-3;
/** A corner this close (fraction of radius) to a wall triangle's own wall line lies on it. */
const ON_WALL_LINE = 1e-4;

/**
 * A shadow edge's blur at the very corner that casts it, as a fraction of the wall softness (never
 * under {@link CORNER_TIP_MIN_PX}). A real penumbra starts at nothing at the occluder and widens; the
 * first cuts started it at the full wall softness, which drew a disc of shadow round the corner and
 * then a notch where the band began ("a bump of shadow that makes no sense" — the author, 2026-11-01).
 */
export const CORNER_TIP_FRACTION = 0.25;
export const CORNER_TIP_MIN_PX = 0.75;

export const EDGE_WALL = 0;
export const EDGE_SHADOW = 1;
export const EDGE_ARC = 2;

/** Shipped defaults — kept equal to `grade.js`'s `lightWallSoftness`/`lightShadowSpread` (a test pins it). */
export const DEFAULT_WALL_SOFT_PX = 8;
export const DEFAULT_SHADOW_SPREAD = 0.35;

/**
 * Classify every edge of a normalized (local unit-radius, origin at 0,0) light polygon.
 * Edge i runs from vertex i to vertex (i+1)%n.
 *
 * @param {ArrayLike<number>} lx @param {ArrayLike<number>} ly @param {number} n
 * @returns {Uint8Array} EDGE_WALL / EDGE_SHADOW / EDGE_ARC per edge.
 */
export function classifyLightEdges(lx, ly, n) {
  const kinds = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = lx[i];
    const ay = ly[i];
    const bx = lx[j];
    const by = ly[j];
    const ra = Math.hypot(ax, ay);
    const rb = Math.hypot(bx, by);
    if (ra >= ARC_MIN && rb >= ARC_MIN) {
      kinds[i] = EDGE_ARC;
      continue;
    }
    const cross = ax * by - ay * bx;
    const dot = ax * bx + ay * by;
    const radial =
      Math.abs(ra - rb) > RADIAL_MIN_RUN &&
      (ra < 1e-9 || rb < 1e-9 || (dot > 0 && Math.abs(cross) <= RADIAL_SIN * ra * rb));
    kinds[i] = radial ? EDGE_SHADOW : EDGE_WALL;
  }
  return kinds;
}

/**
 * Write the per-vertex penumbra data for a light's fan, in `triangulateLightFan`'s vertex
 * order (3 vertices per polygon edge: origin, v_i, v_i+1).
 *
 * @param {{lx: ArrayLike<number>, ly: ArrayLike<number>, n: number}} normalized - the
 *   `normalized` that `triangulateLightFan` returns (never re-derived here).
 * @param {number} radius - the light's radius in scene px.
 * @param {Float32Array|null} [out] - reused when big enough; a new one otherwise.
 * @returns {{array: Float32Array, vertexCount: number}} PENUMBRA_FLOATS per vertex.
 */
export function writeLightPenumbraVertices(normalized, radius, out = null) {
  const { lx, ly, n } = normalized;
  const vertexCount = n * 3;
  const needed = vertexCount * PENUMBRA_FLOATS;
  const array = out && out.length >= needed ? out : new Float32Array(needed);
  const r = Number(radius) > 0 ? Number(radius) : 1;
  const kinds = classifyLightEdges(lx, ly, n);

  // Nearest shadow edge on each angular side of every edge, by index (angular order IS index
  // order on a star-shaped polygon). Two circular sweeps.
  const prevShadow = new Int32Array(n).fill(-1);
  const nextShadow = new Int32Array(n).fill(-1);
  let last = -1;
  for (let k = 0; k < 2 * n; k++) {
    const i = k % n;
    if (k >= n) prevShadow[i] = last === i ? -1 : last;
    if (kinds[i] === EDGE_SHADOW) last = i;
  }
  last = -1;
  for (let k = 2 * n - 1; k >= 0; k--) {
    const i = k % n;
    if (k < n) nextShadow[i] = last === i ? -1 : last;
    if (kinds[i] === EDGE_SHADOW) last = i;
  }
  const cornerOf = (e) => {
    if (e < 0) return [NO_CORNER, 0];
    const j = (e + 1) % n;
    const ra = Math.hypot(lx[e], ly[e]);
    const rb = Math.hypot(lx[j], ly[j]);
    return ra <= rb ? [lx[e], ly[e]] : [lx[j], ly[j]];
  };

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const isWall = kinds[i] === EDGE_WALL;
    let [ax, ay] = cornerOf(prevShadow[i]);
    let [bx, by] = cornerOf(nextShadow[i]);
    // A shadow edge's own fan triangle is a sliver along the shadow line, but the GPU still
    // rasterizes the odd pixel of it (a lone bright dot at the wall end, seen in the lab): it fades
    // by its own edge, like the pixels either side of it.
    if (kinds[i] === EDGE_SHADOW) [ax, ay] = cornerOf(i);
    if (isWall) {
      // A corner on this triangle's own wall line is already reached by its wall fade (see header).
      const ex = lx[j] - lx[i];
      const ey = ly[j] - ly[i];
      const len = Math.hypot(ex, ey);
      const onLine = (cx, cy) => len > 1e-12 && Math.abs(ex * (cy - ly[i]) - ey * (cx - lx[i])) / len < ON_WALL_LINE;
      if (onLine(ax, ay)) [ax, ay] = [NO_CORNER, 0];
      if (onLine(bx, by)) [bx, by] = [NO_CORNER, 0];
    }
    const vals = isWall
      ? [r, 1, ax, ay, bx, by, lx[i], ly[i], lx[j], ly[j]]
      : [r, 0, ax, ay, bx, by, NEUTRAL_PENUMBRA[6], NEUTRAL_PENUMBRA[7], NEUTRAL_PENUMBRA[8], NEUTRAL_PENUMBRA[9]];
    for (let v = 0; v < 3; v++) {
      const o = (i * 3 + v) * PENUMBRA_FLOATS;
      for (let k = 0; k < PENUMBRA_FLOATS; k++) array[o + k] = vals[k];
    }
  }
  return { array, vertexCount };
}

/** smoothstep over plain numbers. */
function smooth01(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / Math.max(1e-9, e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * How far (local units) the light at local (x, y) still travels, along its own ray from the
 * origin, before it meets the line through (w0x, w0y)-(w1x, w1y). JS twin of the node's term.
 */
export function wallTravel(x, y, w0x, w0y, w1x, w1y) {
  const r = Math.hypot(x, y);
  const dx = r > 1e-9 ? x / r : 0;
  const dy = r > 1e-9 ? y / r : 0;
  const ex = w1x - w0x;
  const ey = w1y - w0y;
  const num = w0x * ey - w0y * ex; // cross(w0, e)
  let den = dx * ey - dy * ex; // cross(dir, e)
  den += den >= 0 ? 1e-9 : -1e-9;
  return Math.max(0, num / den - r);
}

/**
 * JS twin of one corner's term in {@link buildLightPenumbraNode}: how much light survives at
 * local (x, y) beside the shadow edge that starts at corner (cx, cy) and runs straight out
 * from the light.
 */
export function shadowEdgeVisibility(x, y, cx, cy, radiusPx, cornerPx, spread) {
  const rc = Math.max(1e-9, Math.hypot(cx, cy));
  const dx = cx / rc;
  const dy = cy / rc;
  const proj = x * dx + y * dy;
  const past = Math.max(0, proj - rc);
  const perpPx = Math.hypot(x - dx * proj, y - dy * proj) * radiusPx;
  const beforePx = Math.max(0, rc - proj) * radiusPx;
  const wallW = Math.max(1e-3, cornerPx);
  const tipPx = Math.max(CORNER_TIP_MIN_PX, wallW * CORNER_TIP_FRACTION);
  // Past the corner: across to the shadow line, over a band that starts at tipPx and widens.
  // Short of it: the distance still to travel to the corner over the WALL softness (what the wall
  // triangle across the ray measures, so no seam) plus the sideways offset over tipPx (so at the
  // corner line the two halves agree, and in front of the corner the dark is a thin point, not a disc).
  return smooth01(0, 1, beforePx / wallW + perpPx / (tipPx + spread * past * radiusPx));
}

/** Unpack one vertex's floats (as written by {@link writeLightPenumbraVertices}) at `o`. */
export function readPenumbraVertex(array, o) {
  return {
    radiusPx: array[o],
    isWall: array[o + 1],
    ax: array[o + 2],
    ay: array[o + 3],
    bx: array[o + 4],
    by: array[o + 5],
    w0x: array[o + 6],
    w0y: array[o + 7],
    w1x: array[o + 8],
    w1y: array[o + 9],
  };
}

/**
 * JS twin of {@link buildLightPenumbraNode}: the whole factor at one fragment.
 * @param {number} x @param {number} y - local unit coordinates.
 * @param {ReturnType<typeof readPenumbraVertex>} v
 * @param {{wallPx:number, spread:number}} dials
 */
export function lightPenumbraAt(x, y, v, dials) {
  const w = Math.max(1e-3, dials.wallPx);
  const travelPx = wallTravel(x, y, v.w0x, v.w0y, v.w1x, v.w1y) * v.radiusPx;
  const wall = 1 + (smooth01(0, w, travelPx) - 1) * v.isWall;
  const a = shadowEdgeVisibility(x, y, v.ax, v.ay, v.radiusPx, w, dials.spread);
  const b = shadowEdgeVisibility(x, y, v.bx, v.by, v.radiusPx, w, dials.spread);
  return wall * a * b;
}

// ── The shared dials: uniforms every point-light material reads (no rebuild to change them). ──
const dialValues = {
  wallPx: DEFAULT_WALL_SOFT_PX,
  spread: DEFAULT_SHADOW_SPREAD,
};
let dialUniforms = null;
function getDialUniforms(TSL) {
  if (!dialUniforms) {
    dialUniforms = {
      wallPx: TSL.uniform(dialValues.wallPx),
      spread: TSL.uniform(dialValues.spread),
    };
  }
  return dialUniforms;
}

/**
 * Set the wall-edge softness. Safe before any light is built.
 * @param {{wallPx?: number, spread?: number}} dials - `wallPx` (scene px) softens where light
 *   meets a wall and where a shadow edge starts; `spread` is how much wider a shadow edge's
 *   blur gets per pixel past the wall corner that casts it.
 */
export function setLightPenumbra({ wallPx, spread } = {}) {
  const w = Number(wallPx);
  const s = Number(spread);
  if (Number.isFinite(w)) dialValues.wallPx = Math.min(64, Math.max(0, w));
  if (Number.isFinite(s)) dialValues.spread = Math.min(2, Math.max(0, s));
  if (dialUniforms) {
    dialUniforms.wallPx.value = dialValues.wallPx;
    dialUniforms.spread.value = dialValues.spread;
  }
}

/** The current dial values (for tests and diagnostics). */
export function getLightPenumbra() {
  return { ...dialValues };
}

/** The vertex attributes a light mesh must carry for {@link buildLightPenumbraNode}. */
export const PENUMBRA_EDGE_ATTRIBUTE = 'aPenEdge';
export const PENUMBRA_CORNER_ATTRIBUTE = 'aPenCorner';
export const PENUMBRA_WALL_ATTRIBUTE = 'aPenWall';

/**
 * Bind the three penumbra views onto `geometry` from an interleaved buffer whose vertices hold
 * the PENUMBRA_FLOATS floats starting at `offset`. One binding, three attributes.
 */
export function bindPenumbraAttributes(THREE, geometry, interleaved, offset = 0) {
  geometry.setAttribute(PENUMBRA_EDGE_ATTRIBUTE, new THREE.InterleavedBufferAttribute(interleaved, 2, offset));
  geometry.setAttribute(PENUMBRA_CORNER_ATTRIBUTE, new THREE.InterleavedBufferAttribute(interleaved, 4, offset + 2));
  geometry.setAttribute(PENUMBRA_WALL_ATTRIBUTE, new THREE.InterleavedBufferAttribute(interleaved, 4, offset + 6));
}

/** The attribute nodes, ready for a shading core's `inputs.penumbra`. @param {object} TSL */
export function penumbraAttributeInputs(TSL) {
  return {
    edge: TSL.attribute(PENUMBRA_EDGE_ATTRIBUTE, 'vec2'),
    corners: TSL.attribute(PENUMBRA_CORNER_ATTRIBUTE, 'vec4'),
    wall: TSL.attribute(PENUMBRA_WALL_ATTRIBUTE, 'vec4'),
  };
}

/**
 * The penumbra factor as a node: 1 where the light is untouched, easing to 0 at a wall or a
 * shadow edge. Multiplied into a light's output.
 *
 * @param {object} TSL
 * @param {{localUnitXY: *, edge: *, corners: *, wall: *}} args - the attribute nodes from
 *   {@link penumbraAttributeInputs}.
 */
export function buildLightPenumbraNode(TSL, { localUnitXY, edge, corners, wall }) {
  const { float, vec2, smoothstep, length, dot, max, mix, step } = TSL;
  const dials = getDialUniforms(TSL);
  const radiusPx = edge.x;
  const widthPx = max(dials.wallPx, float(1e-3));
  const tipPx = max(widthPx.mul(CORNER_TIP_FRACTION), float(CORNER_TIP_MIN_PX));

  // Wall: distance still to travel along this fragment's own ray before the wall line.
  const r = length(localUnitXY);
  const dir = localUnitXY.div(max(r, float(1e-9)));
  const w0 = vec2(wall.x, wall.y);
  const e = vec2(wall.z, wall.w).sub(w0);
  const num = w0.x.mul(e.y).sub(w0.y.mul(e.x));
  const den0 = dir.x.mul(e.y).sub(dir.y.mul(e.x));
  const den = den0.add(step(float(0), den0).mul(2).sub(1).mul(1e-9));
  const travelPx = max(num.div(den).sub(r), float(0)).mul(radiusPx);
  const wallVis = mix(float(1), smoothstep(float(0), widthPx, travelPx), edge.y);

  const cornerTerm = (c) => {
    const rc = max(length(c), float(1e-9));
    const cdir = c.div(rc);
    const proj = dot(localUnitXY, cdir);
    const past = max(proj.sub(rc), float(0));
    // shadowEdgeVisibility's twin (its comment has the why).
    const perpPx = length(localUnitXY.sub(cdir.mul(proj))).mul(radiusPx);
    const beforePx = max(rc.sub(proj), float(0)).mul(radiusPx);
    const band = tipPx.add(dials.spread.mul(past).mul(radiusPx));
    return smoothstep(float(0), float(1), beforePx.div(widthPx).add(perpPx.div(band)));
  };
  const a = cornerTerm(vec2(corners.x, corners.y));
  const b = cornerTerm(vec2(corners.z, corners.w));
  return wallVis.mul(a).mul(b);
}
