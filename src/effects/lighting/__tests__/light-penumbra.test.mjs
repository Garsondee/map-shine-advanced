/**
 * light-penumbra.test.mjs — SOFT WALL EDGES (2026-11-01): a light's edge where it meets a wall is
 * a little soft, and a wall's shadow edge blurs wider the further it runs from the wall corner
 * that casts it (the author: "A bit blurred where light meets a wall and very blurred where light
 * cut but going further away from the wall that caused it to be occluded").
 * NO SEAMS: the author then saw "strange shapes from the light near those nodes" — a crease at
 * wall bends and a stepped bulge at wall ends. Every fan triangle computes its own term, so two
 * neighbours must agree on the ray they share; the seam checks below sample exactly that.
 * Pure-JS twins + the per-vertex data + the batched buffer layout; the TSL node is built with the
 * real vendored TSL so the port is proven to construct.
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import {
  classifyLightEdges,
  writeLightPenumbraVertices,
  readPenumbraVertex,
  lightPenumbraAt,
  shadowEdgeVisibility,
  wallTravel,
  buildLightPenumbraNode,
  penumbraAttributeInputs,
  setLightPenumbra,
  getLightPenumbra,
  EDGE_ARC,
  EDGE_SHADOW,
  EDGE_WALL,
  NO_CORNER,
  PENUMBRA_FLOATS,
  DEFAULT_WALL_SOFT_PX,
  DEFAULT_SHADOW_SPREAD,
} from '../light-penumbra.js';
import { writeLightSpanGeometry, LOCAL_STRIDE } from '../point-light-batch-mesh.js';
import { GRADE_LOOK_PARAMS } from '../../grade/grade.js';

const R = 400; // px
const DIALS = { wallPx: 8, spread: 0.35 };

/** A minimal Foundry-like sweep (local unit space) of the unit circle against wall segments. */
function sweep(walls) {
  const hit = (dx, dy) => {
    let best = 1;
    for (const [x1, y1, x2, y2] of walls) {
      const ex = x2 - x1;
      const ey = y2 - y1;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = (x1 * ey - y1 * ex) / den;
      const u = (x1 * dy - y1 * dx) / den;
      if (t > 1e-9 && u >= 0 && u <= 1) best = Math.min(best, t);
    }
    return best;
  };
  const rays = [];
  for (let k = 0; k < 96; k++) rays.push({ a: (k / 96) * Math.PI * 2 - Math.PI });
  for (const [x1, y1, x2, y2] of walls) {
    rays.push({ a: Math.atan2(y1, x1), end: Math.hypot(x1, y1) }, { a: Math.atan2(y2, x2), end: Math.hypot(x2, y2) });
  }
  rays.sort((p, q) => p.a - q.a);
  const pts = [];
  for (const { a, end } of rays) {
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const far = hit(dx, dy);
    if (end !== undefined && end <= far + 1e-9 && end < 1) {
      const before = hit(Math.cos(a - 1e-7), Math.sin(a - 1e-7));
      const after = hit(Math.cos(a + 1e-7), Math.sin(a + 1e-7));
      const r1 = before > end + 1e-6 ? before : end;
      const r2 = after > end + 1e-6 ? after : end;
      pts.push([dx * r1, dy * r1]);
      if (Math.abs(r2 - r1) > 1e-9) pts.push([dx * r2, dy * r2]);
    } else {
      pts.push([dx * far, dy * far]);
    }
  }
  const n = pts.length;
  return { lx: Float64Array.from(pts, (p) => p[0]), ly: Float64Array.from(pts, (p) => p[1]), n };
}

/** smoothstep(0, w, px) — what the wall side gives at `px` still to travel. */
const wallTravelVis = (px, w) => {
  const t = Math.min(1, Math.max(0, px / w));
  return t * t * (3 - 2 * t);
};

const triangleAt = (array, i) => readPenumbraVertex(array, i * 3 * PENUMBRA_FLOATS);

/**
 * The largest disagreement between the two DRAWN triangles either side of each node, on the ray
 * they share, sampled from just inside the node out to it (the region a seam would show in).
 * Zero-area fan triangles (a shadow edge's own, or a zero-length wall piece) are never
 * rasterized, so the neighbours across a node are the nearest triangles with area.
 */
function worstSeam(poly, array, dials) {
  const { lx, ly, n } = poly;
  const area = (i) => Math.abs(lx[i] * ly[(i + 1) % n] - ly[i] * lx[(i + 1) % n]);
  let worst = 0;
  for (let i = 0; i < n; i++) {
    if (area(i) < 1e-9) continue;
    let k = (i + 1) % n;
    while (area(k) < 1e-9 && k !== i) k = (k + 1) % n;
    const j = (i + 1) % n; // the node where triangle i ends
    const vx = lx[j];
    const vy = ly[j];
    const rv = Math.hypot(vx, vy);
    if (rv > 0.97) continue; // the rim: the radial falloff owns it
    const a = triangleAt(array, i);
    const b = triangleAt(array, k);
    for (let s = 1; s <= 30; s++) {
      const r = rv - (s * 0.5) / R; // 0.5 px steps, 15 px in from the node
      if (r <= 0) break;
      const x = (vx / rv) * r;
      const y = (vy / rv) * r;
      worst = Math.max(worst, Math.abs(lightPenumbraAt(x, y, a, dials) - lightPenumbraAt(x, y, b, dials)));
    }
  }
  return worst;
}

export function run(t) {
  // ── A light with no walls is untouched. ──
  const circle = sweep([]);
  t.ok(
    'an open light is all arc',
    classifyLightEdges(circle.lx, circle.ly, circle.n).every((k) => k === EDGE_ARC)
  );
  const open = writeLightPenumbraVertices(circle, R).array;
  let untouched = true;
  for (let i = 0; i < circle.n; i++) {
    for (const [x, y] of [
      [0, 0],
      [0.5, 0.1],
      [-0.9, 0.2],
    ]) {
      if (Math.abs(lightPenumbraAt(x, y, triangleAt(open, i), DIALS) - 1) > 1e-9) untouched = false;
    }
  }
  t.ok('...and fades nothing anywhere, the lamp centre included', untouched);

  // ── One straight wall: two shadow edges, wall edges along it. ──
  const poly = sweep([[0.3, 0.5, -0.3, 0.5]]);
  const kinds = classifyLightEdges(poly.lx, poly.ly, poly.n);
  t.ok('a wall cut makes exactly two shadow edges', kinds.filter((k) => k === EDGE_SHADOW).length === 2);
  t.ok('...and at least one wall edge', kinds.includes(EDGE_WALL));
  const { array, vertexCount } = writeLightPenumbraVertices(poly, R);
  t.ok('three vertices per edge, fan order', vertexCount === poly.n * 3);

  // Wall fade: the distance the light still travels to the wall, along its own ray.
  t.ok('straight at a face-on wall, travel = the gap', Math.abs(wallTravel(0, 0.3, -0.3, 0.5, 0.3, 0.5) - 0.2) < 1e-9);
  t.ok('obliquely, travel is longer than the gap', wallTravel(0.12, 0.3, -0.3, 0.5, 0.3, 0.5) > 0.2);
  const wallTri = triangleAt(array, kinds.indexOf(EDGE_WALL));
  t.ok('at the wall the light is gone', lightPenumbraAt(0, 0.5, wallTri, DIALS) < 1e-6);
  t.ok(
    'half the softness short of it: part-lit',
    Math.abs(lightPenumbraAt(0, 0.5 - 4 / R, wallTri, DIALS) - 0.5) < 1e-4 // Float32 storage
  );
  t.ok('a full softness short of it: full', Math.abs(lightPenumbraAt(0, 0.5 - 8 / R, wallTri, DIALS) - 1) < 1e-9);
  t.ok(
    'a wall triangle drops the shadow corners on its own wall line (no double fade)',
    wallTri.ax === NO_CORNER && wallTri.bx === NO_CORNER
  );
  // The shadow edge's own sliver triangle: a pixel it rasterizes on the shadow line must be dark,
  // like its neighbours (it was a lone bright dot at each wall end on the GPU before).
  const shadowEdge = kinds.indexOf(EDGE_SHADOW);
  const sliver = triangleAt(array, shadowEdge);
  const sx = poly.lx[shadowEdge] + poly.lx[(shadowEdge + 1) % poly.n];
  const sy = poly.ly[shadowEdge] + poly.ly[(shadowEdge + 1) % poly.n];
  t.ok('a shadow edge’s own sliver is dark on its own line', lightPenumbraAt(sx / 2, sy / 2, sliver, DIALS) < 1e-3);
  // NO BUMP: in front of the wall's end, beside the corner on the open side, nothing blocks the
  // light. The first cut faded a disc round the corner there ("a bump of shadow that makes no sense").
  {
    const rcB = Math.hypot(0.3, 0.5);
    const d = [0.3 / rcB, 0.5 / rcB];
    const open = [d[1], -d[0]]; // away from the wall, the lit side of the shadow edge
    const p = (shortPx, sidePx) => [
      d[0] * (rcB - shortPx / R) + (open[0] * sidePx) / R,
      d[1] * (rcB - shortPx / R) + (open[1] * sidePx) / R,
    ];
    const [bx1, by1] = p(4, 6);
    t.ok(
      'beside the corner, short of it: no bump (strong dials)',
      shadowEdgeVisibility(bx1, by1, 0.3, 0.5, R, 16, 0.8) > 0.99
    );
    const [bx2, by2] = p(4, 0);
    t.ok(
      '...yet on the ray itself it matches the wall side (travel left = 4 px)',
      Math.abs(shadowEdgeVisibility(bx2, by2, 0.3, 0.5, R, 16, 0.8) - wallTravelVis(4, 16)) < 1e-6
    );
  }

  // The shadow edge from corner (0.3, 0.5), runs straight out from the light.
  const rc = Math.hypot(0.3, 0.5);
  const dir = [0.3 / rc, 0.5 / rc];
  const side = [dir[1], -dir[0]]; // toward the lit side
  const at = (alongPx, sidePx) => {
    const s = rc + alongPx / R;
    return shadowEdgeVisibility(
      dir[0] * s + (side[0] * sidePx) / R,
      dir[1] * s + (side[1] * sidePx) / R,
      0.3,
      0.5,
      R,
      DIALS.wallPx,
      DIALS.spread
    );
  };
  t.ok('right on the shadow line the light is gone', at(100, 0) < 1e-6);
  t.ok('10 px off the line next to the wall: a little soft, already full', at(2, 10) > 0.99);
  t.ok('10 px off the line far from the wall: still deep in the blur', at(150, 10) < 0.2);
  let grows = true;
  for (let a = 10; a < 160; a += 10) if (at(a + 10, 20) > at(a, 20) + 1e-12) grows = false;
  t.ok('at a fixed offset the blur only deepens with distance from the wall', grows);
  t.ok(
    'with spread 0 the edge stays a thin even fade the whole way',
    at(150, 10) < at(150, 10) + 1 &&
      shadowEdgeVisibility(
        dir[0] * (rc + 0.4) + (side[0] * 10) / R,
        dir[1] * (rc + 0.4) + (side[1] * 10) / R,
        0.3,
        0.5,
        R,
        8,
        0
      ) > 0.99
  );
  const rimHasCorner = [...Array(poly.n).keys()].some((i) => {
    const v = triangleAt(array, i);
    return (
      kinds[i] === EDGE_ARC && (Math.hypot(v.ax - 0.3, v.ay - 0.5) < 1e-6 || Math.hypot(v.bx - 0.3, v.by - 0.5) < 1e-6)
    );
  });
  t.ok('the rim beside a shadow edge knows its corner', rimHasCorner);

  // ── NO SEAMS at nodes: a bent wall, a pillar, a door gap (the author's lab scene). ──
  const scene = [
    [-0.34, -0.13, -0.03, 0.06],
    [-0.03, 0.06, 0.45, 0.13],
    [0.34, -0.47, 0.45, -0.47],
    [0.45, -0.47, 0.45, -0.37],
    [0.45, -0.37, 0.34, -0.37],
    [0.34, -0.37, 0.34, -0.47],
    [-0.6, -0.55, -0.26, -0.55],
    [-0.13, -0.55, 0.24, -0.55],
  ];
  const lab = sweep(scene);
  const labPen = writeLightPenumbraVertices(lab, 380).array;
  t.ok(
    'lab scene: shadow edges found',
    classifyLightEdges(lab.lx, lab.ly, lab.n).filter((k) => k === EDGE_SHADOW).length >= 6
  );
  const seam = worstSeam(lab, labPen, DIALS);
  t.ok(`no seam on any node's ray: neighbours agree within 2% (worst ${seam.toFixed(4)})`, seam < 0.02);
  const seamStrong = worstSeam(lab, labPen, { wallPx: 16, spread: 0.8 });
  t.ok(`...and at strong dials (worst ${seamStrong.toFixed(4)})`, seamStrong < 0.02);

  let bounded = true;
  for (let i = 0; i < lab.n; i++) {
    for (let k = 0; k < 40; k++) {
      const v = lightPenumbraAt(Math.cos(k) * 0.7 * (k / 40), Math.sin(k) * 0.4, triangleAt(labPen, i), DIALS);
      if (!(v >= 0 && v <= 1)) bounded = false;
    }
  }
  t.ok('the factor stays within 0..1 (it only ever takes light away)', bounded);

  // A limited-angle (cone) light: its sides start at the origin and count as shadow edges.
  const cone = { lx: Float64Array.from([0, 1, Math.cos(0.5)]), ly: Float64Array.from([0, 0, Math.sin(0.5)]), n: 3 };
  const coneKinds = classifyLightEdges(cone.lx, cone.ly, 3);
  t.ok('a cone light’s sides are shadow edges', coneKinds[0] === EDGE_SHADOW && coneKinds[2] === EDGE_SHADOW);

  // ── Reuse: a big-enough buffer is written in place. ──
  const scratch = new Float32Array(poly.n * 3 * PENUMBRA_FLOATS);
  t.ok('a big-enough buffer is reused', writeLightPenumbraVertices(poly, R, scratch).array === scratch);
  t.ok(
    'a small one is replaced',
    writeLightPenumbraVertices(poly, R, new Float32Array(6)).array.length >= scratch.length
  );

  // ── The batched geometry buffer: local xy + penumbra, one stride. ──
  const raw = new Float32Array(3 * LOCAL_STRIDE).fill(-1);
  const arrays = { aLocalUnit: raw, aPenEdge: raw, aPenCorner: raw };
  const fan = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const pen = Float32Array.from({ length: 3 * PENUMBRA_FLOATS }, (_, i) => 100 + i);
  writeLightSpanGeometry(arrays, 0, 3, fan, 0, 0, R, pen);
  t.ok(
    'batched: each vertex is local xy then its penumbra floats',
    LOCAL_STRIDE === 2 + PENUMBRA_FLOATS &&
      raw[LOCAL_STRIDE + 0] === 1 &&
      raw[LOCAL_STRIDE + 2] === 100 + PENUMBRA_FLOATS &&
      raw[2 * LOCAL_STRIDE + 2 + PENUMBRA_FLOATS - 1] === 100 + 3 * PENUMBRA_FLOATS - 1
  );
  const plain = { aLocalUnit: new Float32Array(6) };
  writeLightSpanGeometry(plain, 0, 3, fan, 0, 0, R, pen);
  t.ok(
    'a plain (un-interleaved) local buffer keeps its stride of 2',
    plain.aLocalUnit[2] === 1 && plain.aLocalUnit[5] === 1
  );
  writeLightSpanGeometry(arrays, 0, 3, fan, 0, 0, R, null);
  t.ok('batched without penumbra data: neutral (not a wall, no corner)', raw[3] === 0 && raw[4] === NO_CORNER);

  // ── Defaults, dials, TSL. ──
  t.ok(
    'wall softness default matches the Colour Grade default',
    GRADE_LOOK_PARAMS.lightWallSoftness.default === DEFAULT_WALL_SOFT_PX
  );
  t.ok(
    'shadow spread default matches the Colour Grade default',
    GRADE_LOOK_PARAMS.lightShadowSpread.default === DEFAULT_SHADOW_SPREAD
  );
  setLightPenumbra({ wallPx: 999, spread: -3 });
  t.ok('dials are clamped', getLightPenumbra().wallPx === 64 && getLightPenumbra().spread === 0);
  setLightPenumbra({ wallPx: Number.NaN, spread: undefined });
  t.ok('junk leaves the dials alone', getLightPenumbra().wallPx === 64);
  setLightPenumbra({ wallPx: DEFAULT_WALL_SOFT_PX, spread: DEFAULT_SHADOW_SPREAD });
  let built = false;
  try {
    built = !!buildLightPenumbraNode(THREE.TSL, {
      localUnitXY: THREE.TSL.vec2(0.2, 0.1),
      ...penumbraAttributeInputs(THREE.TSL),
    });
  } catch (_) {
    built = false;
  }
  t.ok('the TSL node constructs', built);
}
