/**
 * Node verification for effects/vision/door-leaf-occlusion.js — treating a
 * swinging door leaf's current geometry as a real-time vision occluder.
 *
 * Player-facing information gating (Law 7) — every case here is either a
 * hand-worked geometric result (verified independently by hand against the
 * ray/segment-intersection formula this module's own header documents, not
 * just "the code agrees with itself") or an explicit contract property
 * (reference preservation, no mutation, a documented safe-fallback firing).
 */
import { clipPolygonBySegmentShadow, clipPolygonByDoorLeaves, applyDoorLeafOcclusion } from '../door-leaf-occlusion.js';

/** A regular octagon, radius 100, centered on the origin — vertices at
 * every 45°, so it has real vertices exactly at 0° and 180°, useful for
 * pinning both a normal clamp and the wraparound (±180°) case against the
 * SAME shape, just rotated. */
function octagon() {
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    pts.push(100 * Math.cos(a), 100 * Math.sin(a));
  }
  return pts;
}

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const pointsNear = (actual, expected) =>
  actual.length === expected.length && actual.every((v, i) => near(v, expected[i], 1e-3));

/** The same leaf segment used throughout: matches the worked example's own
 * A=(10,-2) B=(10,2) — hinge and free endpoint are interchangeable for a
 * plain segment shadow, this is just a fixed door position to test against. */
const nearSeg = [{ hingeX: 10, hingeY: -2, freeX: 10, freeY: 2 }];

export function run(t) {
  const { ok } = t;

  // ======================================================================
  // clipPolygonBySegmentShadow — the core primitive
  // ======================================================================

  // THE WORKED EXAMPLE (hand-derived via the ray/segment-intersection
  // formula this module's header cites): S=(0,0), leaf A=(10,-2) B=(10,2).
  // An octagon's vertex at exactly 0° is (100,0) — the ray from S through
  // it crosses AB at t=0.1, i.e. exactly (10,0). The two neighboring
  // vertices (45° and 315°) are angularly outside the ±11.31° wedge, so the
  // sweep transitions in/out of the wedge on the edges either side of the
  // 0° vertex — inserting the leaf's own endpoints (10,2) then (10,-2) at
  // those exact transitions.
  {
    const out = clipPolygonBySegmentShadow(octagon(), 0, 0, 10, -2, 10, 2);
    const expected = [
      10, 0, 10, 2, 70.710678, 70.710678, 0, 100, -70.710678, 70.710678, -100, 0, -70.710678, -70.710678, 0, -100,
      70.710678, -70.710678, 10, -2,
    ];
    ok('worked example: the 0° vertex clamps to exactly (10,0)', near(out[0], 10) && near(out[1], 0));
    ok(
      'worked example: full sequence matches the hand-derived clamp + two boundary insertions',
      pointsNear(out, expected)
    );
  }

  // WRAPAROUND — the identical shape, mirrored to x<0 so the wedge sits
  // around 180° instead of 0°, straddling where atan2's own branch cut
  // would sit. Deliberately proves the cross-product design has no
  // wraparound bug to handle in the first place, rather than asserting it
  // was "handled correctly" — the result is byte-for-byte the 0° case with
  // every x negated, computed by a totally trig-free code path.
  {
    const out = clipPolygonBySegmentShadow(octagon(), 0, 0, -10, -2, -10, 2);
    const expected = [
      100, 0, 70.710678, 70.710678, 0, 100, -70.710678, 70.710678, -10, 2, -10, 0, -10, -2, -70.710678, -70.710678, 0,
      -100, 70.710678, -70.710678,
    ];
    ok('wraparound: the 180° vertex clamps to exactly (-10,0), mirroring the 0° case', pointsNear(out, expected));
  }

  // NO OVERLAP AT ALL — a small triangle entirely on the far side from a
  // leaf near the +X axis (vertices at 100°/120°/140°, nowhere near the
  // wedge OR either ray's infinite line). Same reference back, not just
  // equal values (the "wedge doesn't touch this polygon" zero-copy path).
  {
    const farTri = [];
    for (const deg of [100, 120, 140]) {
      const a = (deg * Math.PI) / 180;
      farTri.push(100 * Math.cos(a), 100 * Math.sin(a));
    }
    const out = clipPolygonBySegmentShadow(farTri, 0, 0, 10, -2, 10, 2);
    ok('no angular overlap: returns the SAME array reference (zero-copy fast path)', out === farTri);
  }

  // THE FAST-EXIT'S OWN DOCUMENTED IMPRECISION, PINNED — a triangle
  // (vertices at 60°/120°/180°) that touches neither ray's actual FORWARD
  // direction, but whose closing edge (180°→60°) crosses ray A's INFINITE
  // LINE behind the source. The fast exit (a cheap sign check, not a full
  // `raySegmentIntersect` call) conservatively treats that as "might
  // touch," so this does NOT take the zero-copy path — but the main loop's
  // real ray/segment intersection then correctly finds no forward crossing
  // and emits the original coordinates anyway. Pins the module's own
  // documented tradeoff: occasionally over-cautious, never wrong.
  {
    const farTri2 = [];
    for (const deg of [60, 120, 180]) {
      const a = (deg * Math.PI) / 180;
      farTri2.push(100 * Math.cos(a), 100 * Math.sin(a));
    }
    const out = clipPolygonBySegmentShadow(farTri2, 0, 0, 10, -2, 10, 2);
    ok('fast-exit over-triggers on this shape (not the same reference)...', out !== farTri2);
    ok('...but the values it returns are still exactly correct (unclipped)', pointsNear(out, farTri2));
  }

  // LEAF FARTHER THAN THE POLYGON EVERYWHERE IN ITS OWN (narrow) WEDGE —
  // the polygon's own vertex reads as angularly "in wedge" (so the fast
  // path above doesn't fire), but nothing actually needs to move: the leaf
  // sits beyond the polygon's own extent at every angle it touches.
  {
    const oct = octagon();
    const out = clipPolygonBySegmentShadow(oct, 0, 0, 200, -2, 200, 2);
    ok('leaf beyond the polygon: values are unchanged even though a new array is returned', pointsNear(out, oct));
  }

  // DEGENERATE: S essentially at one of the leaf's own endpoints (a token
  // standing right in the doorway as it swings) — no meaningful wedge.
  {
    const tri = [100, 0, 0, 100, -100, 0];
    const out = clipPolygonBySegmentShadow(tri, 10, -2, 10, -2, 10, 2);
    ok('S coincident with leaf endpoint A: no-op, same reference', out === tri);
  }

  // DEGENERATE: S collinear with A and B (the leaf viewed exactly edge-on).
  {
    const tri = [100, 0, 0, 100, -100, 0];
    const out = clipPolygonBySegmentShadow(tri, 0, 0, 5, 0, 20, 0);
    ok('S collinear with the leaf: no-op, same reference', out === tri);
  }

  // ⚠️ THE FORMERLY-PATHOLOGICAL CASE, NOW ACTUALLY CLIPPED — a polygon
  // sparse enough near the doorway that one edge dips through the wedge
  // without either endpoint individually reading as "in wedge". This used
  // to be a bail-out fallback (an ordinary room shape, not a rare one —
  // the whole reason this file exists in its current form); now it's
  // handled the same way any transition edge is: both ray crossings are
  // located ALONG THE ONE EDGE that spans the wedge and inserted in the
  // order they actually occur, cutting a clean notch into that edge.
  //
  // wideEdgeQuad (vertices at -60°/60°/150°/240°), hand-derived: edge
  // V0→V1 (the x=50 line) is the sole crossed edge. Ray A (dir (10,-2))
  // hits it at t=5, (50,-10), u=(-10+86.60254)/173.20508≈0.4424; ray B
  // (dir (10,2)) hits at t=5, (50,10), u≈0.5578. Both t≥1 (edge farther
  // than the leaf), both insert, A before B (smaller u first).
  {
    const wideEdgeQuad = [50, -86.60254, 50, 86.60254, -86.60254, 50, -50, -86.60254];
    const out = clipPolygonBySegmentShadow(wideEdgeQuad, 0, 0, 10, -2, 10, 2);
    const expected = [50, -86.60254, 10, -2, 10, 2, 50, 86.60254, -86.60254, 50, -50, -86.60254];
    ok('a single wide edge spanning the wedge gets a clean notch cut into it, in order', pointsNear(out, expected));
  }
  // hexShift15 (vertices at 15°/75°/135°/195°/255°/315°): the wedge
  // (±11.31° around 0°) falls entirely between V5 (315°=-45°) and V0
  // (15°) — neither individually in-wedge — so that one edge (the LAST
  // edge in traversal order, wrapping back to V0) is where both crossings
  // land, same A-before-B ordering (sweeping from -45° toward +15° passes
  // ray A's -11.31° before ray B's +11.31°).
  {
    const hexShift15 = [];
    for (let i = 0; i < 6; i++) {
      const a = ((i * 60 + 15) * Math.PI) / 180;
      hexShift15.push(100 * Math.cos(a), 100 * Math.sin(a));
    }
    const out = clipPolygonBySegmentShadow(hexShift15, 0, 0, 10, -2, 10, 2);
    const expected = [
      96.592583, 25.881905, 25.881905, 96.592583, -70.710678, 70.710678, -96.592583, -25.881905, -25.881905, -96.592583,
      70.710678, -70.710678, 10, -2, 10, 2,
    ];
    ok('the sparse-hexagon case also gets a clean notch, appended after the last vertex', pointsNear(out, expected));
  }

  // ORDER INDEPENDENCE — two perpendicular leaves clipped in either order
  // must agree (folded via clipPolygonByDoorLeaves below, but the
  // primitive itself must compose consistently either way).
  {
    const a = clipPolygonBySegmentShadow(
      clipPolygonBySegmentShadow(octagon(), 0, 0, 10, -2, 10, 2),
      0,
      0,
      -2,
      10,
      2,
      10
    );
    const b = clipPolygonBySegmentShadow(
      clipPolygonBySegmentShadow(octagon(), 0, 0, -2, 10, 2, 10),
      0,
      0,
      10,
      -2,
      10,
      2
    );
    ok('two leaves compose the same result regardless of application order', pointsNear(a, b));
  }

  // NEVER MUTATES THE INPUT.
  {
    const oct = octagon();
    const before = oct.slice();
    clipPolygonBySegmentShadow(oct, 0, 0, 10, -2, 10, 2);
    ok('never mutates the input points array', JSON.stringify(oct) === JSON.stringify(before));
  }

  // ======================================================================
  // clipPolygonByDoorLeaves — folds the primitive over every leaf, with a
  // broad-phase reject
  // ======================================================================

  {
    const oct = octagon();
    const farDoor = [{ hingeX: 1000, hingeY: 0, freeX: 1010, freeY: 0 }];
    const rejected = clipPolygonByDoorLeaves(oct, 0, 0, 50, farDoor);
    ok(
      'broad-phase reject: a finite source radius that cannot reach the door skips it entirely (same reference)',
      rejected === oct
    );
  }
  // A door leaf close enough to genuinely clip the octagon (same geometry
  // as the worked example above: distToHinge≈10.198, leafReach=4, so the
  // broad-phase margin is ≈6.198) — a radius BELOW that margin must reject
  // (same reference, nothing attempted); a radius above it, or Infinity,
  // must NOT reject and must produce the real clip.
  {
    const oct = octagon();
    const rejected = clipPolygonByDoorLeaves(oct, 0, 0, 5, nearSeg);
    ok('broad-phase reject: radius smaller than the reach margin skips the leaf entirely', rejected === oct);
  }
  {
    const clippedFinite = clipPolygonByDoorLeaves(octagon(), 0, 0, 100, nearSeg);
    const clippedInfinite = clipPolygonByDoorLeaves(octagon(), 0, 0, Infinity, nearSeg);
    ok(
      'a sufficient finite radius is not rejected and the leaf actually clips',
      JSON.stringify(clippedFinite) !== JSON.stringify(octagon())
    );
    ok(
      'Infinity is never broad-phase-rejected and produces the identical clip',
      pointsNear(clippedInfinite, clippedFinite)
    );
  }
  {
    const out = clipPolygonByDoorLeaves(null, 0, 0, 100, [{ hingeX: 10, hingeY: -2, freeX: 10, freeY: 2 }]);
    ok('null points passed through unchanged, no throw', out === null);
  }
  {
    const oct = octagon();
    ok('empty segment list: same reference, zero work', clipPolygonByDoorLeaves(oct, 0, 0, 100, []) === oct);
  }

  // ======================================================================
  // applyDoorLeafOcclusion — the vt-pan-viewer.js entry point
  // ======================================================================

  {
    const sources = [
      {
        sourceId: 'a',
        x: 0,
        y: 0,
        radius: 100,
        lightRadius: 100,
        blinded: false,
        losPoints: octagon(),
        lightPoints: octagon(),
      },
    ];
    ok(
      'zero segments: returns the exact same sources reference (no allocation)',
      applyDoorLeafOcclusion(sources, []) === sources
    );
  }
  {
    const empty = [];
    ok('empty sources array: same reference back', applyDoorLeafOcclusion(empty, nearSeg) === empty);
  }
  {
    const sources = [
      {
        sourceId: 'a',
        x: 0,
        y: 0,
        radius: 100,
        lightRadius: 100,
        blinded: false,
        losPoints: octagon(),
        lightPoints: octagon(),
      },
    ];
    const originalLos = sources[0].losPoints;
    const originalLosSnapshot = originalLos.slice();
    const result = applyDoorLeafOcclusion(sources, nearSeg);
    ok(
      "never mutates a source's original losPoints array",
      JSON.stringify(originalLos) === JSON.stringify(originalLosSnapshot)
    );
    ok('an affected source is a NEW object', result[0] !== sources[0]);
    ok(
      'its losPoints actually changed (the clip took effect)',
      JSON.stringify(result[0].losPoints) !== JSON.stringify(originalLosSnapshot)
    );
  }
  {
    const nearSource = {
      sourceId: 'a',
      x: 0,
      y: 0,
      radius: 100,
      lightRadius: 100,
      blinded: false,
      losPoints: octagon(),
      lightPoints: octagon(),
    };
    const farSource = {
      sourceId: 'b',
      x: 5000,
      y: 5000,
      radius: 100,
      lightRadius: 100,
      blinded: false,
      losPoints: octagon(),
      lightPoints: octagon(),
    };
    const sources = [nearSource, farSource];
    const result = applyDoorLeafOcclusion(sources, nearSeg);
    ok('an untouched (far) source keeps its ORIGINAL object reference', result[1] === farSource);
    ok('the affected (near) source does not', result[0] !== nearSource);
  }
  {
    const sources = [
      {
        sourceId: 'a',
        x: 0,
        y: 0,
        radius: 100,
        lightRadius: 100,
        blinded: true,
        losPoints: octagon(),
        lightPoints: octagon(),
      },
    ];
    ok(
      'a blinded source is skipped entirely (same object reference)',
      applyDoorLeafOcclusion(sources, nearSeg)[0] === sources[0]
    );
  }
  {
    const sources = [
      {
        sourceId: 'a',
        x: 0,
        y: 0,
        radius: 100,
        lightRadius: 100,
        blinded: false,
        losPoints: octagon(),
        lightPoints: null,
      },
    ];
    const result = applyDoorLeafOcclusion(sources, nearSeg);
    ok('a null lightPoints stays null, no throw', result[0].lightPoints === null);
    ok(
      'losPoints on the same source still gets clipped independently',
      JSON.stringify(result[0].losPoints) !== JSON.stringify(sources[0].losPoints)
    );
  }
}
