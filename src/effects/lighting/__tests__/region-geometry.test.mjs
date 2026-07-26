/**
 * Node verification for effects/lighting/region-geometry.js. All pure —
 * every function here is CPU geometry/arithmetic, fully Node-testable. (Split
 * out of region-darkness.js 2026-07-25; the TSL material builders that stayed
 * behind are not Node-testable and have no suite, as before.)
 */
import {
  pointInRectangle,
  pointInEllipse,
  pointInPolygon,
  pointInCone,
  pointInRing,
  pointInLine,
  pointInEmanation,
  pointInRegionShapes,
  computeShapeMeshBounds,
  writeRegionPolygonPoints,
  applyDarknessAdjustment,
  computeRegionAdjustedDarkness,
  regionOverlapsElevationBand,
  DARKNESS_ADJUST_MODES,
} from '../region-geometry.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

export function run(t) {
  const { ok } = t;

  // ======================================================================
  // pointInRectangle
  // ======================================================================
  {
    const rect = { x: 100, y: 100, width: 200, height: 100 };
    ok('center of an unrotated, un-anchored rect is inside', pointInRectangle(150, 130, rect));
    ok('exactly at the origin corner is inside (inclusive)', pointInRectangle(100, 100, rect));
    ok('just past the far corner is outside', !pointInRectangle(301, 201, rect));
    ok('far away is outside', !pointInRectangle(-500, -500, rect));
  }
  {
    // anchorX/anchorY = 0.5 centers the box ON (x,y) instead of it being the top-left.
    const rect = { x: 0, y: 0, width: 100, height: 100, anchorX: 0.5, anchorY: 0.5 };
    ok('anchor 0.5,0.5 centers the box on the origin', pointInRectangle(0, 0, rect));
    ok('anchor 0.5,0.5: the OLD top-left (before anchoring) is now outside', !pointInRectangle(60, 60, rect));
    ok('anchor 0.5,0.5: a corner of the re-centered box is inside', pointInRectangle(-49, -49, rect));
  }
  {
    // A 90-degree rotation around the origin swaps the effective width/height footprint.
    const rect = { x: 0, y: 0, width: 200, height: 50, rotation: 90 };
    ok('rotated 90deg: a point along the (now-rotated) long axis is inside', pointInRectangle(0, 150, rect));
    ok('rotated 90deg: the SAME point on the un-rotated long axis is now outside', !pointInRectangle(150, 0, rect));
  }
  ok(
    'zero width is never inside anything (degenerate rect)',
    !pointInRectangle(0, 0, { x: 0, y: 0, width: 0, height: 10 })
  );
  ok('a malformed rect (missing fields) never throws, just reads false', pointInRectangle(0, 0, {}) === false);

  // ======================================================================
  // pointInEllipse
  // ======================================================================
  {
    const circle = { x: 0, y: 0, radiusX: 50, radiusY: 50 };
    ok('center is inside', pointInEllipse(0, 0, circle));
    ok('exactly on the boundary is inside (inclusive)', pointInEllipse(50, 0, circle));
    ok('just past the boundary is outside', !pointInEllipse(50.5, 0, circle));
  }
  {
    const ellipse = { x: 0, y: 0, radiusX: 100, radiusY: 20 };
    ok('inside the long axis, past the short-axis radius', pointInEllipse(80, 0, ellipse));
    ok('outside the short axis at the same offset', !pointInEllipse(0, 21, ellipse));
  }
  {
    // A 90-degree rotation swaps which axis is "long".
    const ellipse = { x: 0, y: 0, radiusX: 100, radiusY: 20, rotation: 90 };
    ok('rotated 90deg: the long axis now runs along Y', pointInEllipse(0, 80, ellipse));
    ok('rotated 90deg: the same offset along X is now outside', !pointInEllipse(80, 0, ellipse));
  }
  ok('zero radius is never inside anything', !pointInEllipse(0, 0, { x: 0, y: 0, radiusX: 0, radiusY: 10 }));

  // ======================================================================
  // pointInPolygon — a clean square, same convention as the SDF's own test
  // ======================================================================
  const SQUARE = [-50, -50, 50, -50, 50, 50, -50, 50];
  ok('polygon center is inside', pointInPolygon(0, 0, SQUARE));
  ok('polygon corner-adjacent interior point is inside', pointInPolygon(40, 40, SQUARE));
  ok('well outside the polygon is outside', !pointInPolygon(1000, 1000, SQUARE));
  ok('malformed (odd-length) points array never throws, reads false', pointInPolygon(0, 0, [0, 0, 1]) === false);
  ok('too few points never throws, reads false', pointInPolygon(0, 0, [0, 0, 1, 1]) === false);

  // ======================================================================
  // pointInCone — a circular sector (round curvature only), 2026-07-19
  // ======================================================================
  {
    // apex (0,0), radius 100, a 90-degree wedge facing EAST (rotation 0 —
    // Foundry's own convention: 0deg=+x, increasing angle sweeps clockwise
    // since Y is down) — spans -45deg to +45deg.
    const cone = { x: 0, y: 0, radius: 100, angle: 90, rotation: 0 };
    ok('a point along the wedge center axis is inside', pointInCone(50, 0, cone));
    ok('a point exactly ON the +45deg edge (inclusive boundary) is inside', pointInCone(70, 70, cone));
    {
      const past45 = { x: 100 * Math.cos((46 * Math.PI) / 180), y: 100 * Math.sin((46 * Math.PI) / 180) };
      ok(
        'a point at 46deg (just past the +45deg edge), still within radius, is outside — the ANGLE test excludes it',
        !pointInCone(past45.x, past45.y, cone)
      );
    }
    ok('a point at 90deg (perpendicular to the wedge axis, within radius) is outside', !pointInCone(0, 90, cone));
    ok('a point beyond the radius, even on-axis, is outside', !pointInCone(200, 0, cone));
    ok('the apex itself is ALWAYS inside, regardless of angle/rotation', pointInCone(0, 0, cone));
  }
  {
    // Wraparound: rotation=350, angle=60 spans [320,360) union [0,20).
    const wrapCone = { x: 0, y: 0, radius: 100, angle: 60, rotation: 350 };
    const at10deg = { x: 100 * Math.cos((10 * Math.PI) / 180), y: 100 * Math.sin((10 * Math.PI) / 180) };
    const at25deg = { x: 100 * Math.cos((25 * Math.PI) / 180), y: 100 * Math.sin((25 * Math.PI) / 180) };
    ok('10deg is INSIDE the wrapped wedge (within the 0-20deg half)', pointInCone(at10deg.x, at10deg.y, wrapCone));
    ok(
      '25deg is OUTSIDE the wrapped wedge — proves this handles the 360/0 seam',
      !pointInCone(at25deg.x, at25deg.y, wrapCone)
    );
  }
  ok('angle >= 360 is a full circle (radius test only)', pointInCone(0, 90, { x: 0, y: 0, radius: 100, angle: 360 }));
  ok(
    'a zero-degree wedge covers nothing beyond its own apex',
    !pointInCone(1, 0, { x: 0, y: 0, radius: 100, angle: 0 })
  );
  ok('zero radius is never inside anything', !pointInCone(0, 0, { x: 0, y: 0, radius: 0, angle: 90 }));

  // ======================================================================
  // pointInRing — a full annulus, NEVER angle-gated (Ring has no rotation)
  // ======================================================================
  {
    const ring = { x: 0, y: 0, radius: 100, innerWidth: 20, outerWidth: 10 }; // inner=80, outer=110
    ok('a point at distance 90 (between 80 and 110) is inside', pointInRing(90, 0, ring));
    ok('a point at distance 50 (inside the hole) is outside', !pointInRing(50, 0, ring));
    ok('a point at distance 150 (beyond the outer edge) is outside', !pointInRing(150, 0, ring));
    ok('exactly at the inner radius (inclusive boundary)', pointInRing(80, 0, ring));
    ok('exactly at the outer radius (inclusive boundary)', pointInRing(110, 0, ring));
    ok('the CENTER (distance 0) is always outside a real ring — that IS the hole', !pointInRing(0, 0, ring));
  }
  ok(
    'an innerWidth larger than radius floors the inner radius at 0 (a full disk, NOT degenerate)',
    pointInRing(100, 0, { x: 0, y: 0, radius: 100, innerWidth: 200, outerWidth: 0 })
  );
  ok('zero radius ring covers nothing', !pointInRing(0, 0, { x: 0, y: 0, radius: 0, innerWidth: 0, outerWidth: 10 }));
  ok(
    'a genuinely inverted band (outer <= inner after floors) covers nothing, never throws',
    !pointInRing(50, 0, { x: 0, y: 0, radius: 50, innerWidth: 0, outerWidth: -60 })
  );

  // ======================================================================
  // pointInLine — a thick line segment, origin at ONE endpoint (not center)
  // ======================================================================
  {
    const line = { x: 0, y: 0, length: 100, width: 20, rotation: 0 }; // pointing +x (east)
    ok('a point along the line, centered across its width', pointInLine(50, 0, line));
    ok('the same X, but past the half-width, is outside', !pointInLine(50, 15, line));
    ok('before the origin endpoint is outside', !pointInLine(-5, 0, line));
    ok('exactly at the far endpoint is inside (inclusive)', pointInLine(100, 0, line));
    ok('past the far endpoint is outside', !pointInLine(101, 0, line));
  }
  ok(
    'a line rotated 90deg (pointing south, since Y is down) matches a point along ITS new axis',
    pointInLine(0, 50, { x: 0, y: 0, length: 100, width: 20, rotation: 90 })
  );
  ok(
    'the SAME rotated line does NOT match the un-rotated (east) axis anymore',
    !pointInLine(50, 0, { x: 0, y: 0, length: 100, width: 20, rotation: 90 })
  );
  ok('zero length is never inside anything', !pointInLine(0, 0, { x: 0, y: 0, length: 0, width: 20 }));

  // ======================================================================
  // pointInEmanation — Minkowski-sum growth of a base shape, 2026-07-19
  // ======================================================================
  {
    // circle base — EXACT (grow the radius directly).
    const em = { radius: 20, base: { type: 'circle', x: 0, y: 0, radius: 50 } }; // effective radius 70
    ok('inside the grown circle (dist 60 <= 70)', pointInEmanation(60, 0, em));
    ok('outside the grown circle (dist 80 > 70)', !pointInEmanation(80, 0, em));
  }
  {
    // rectangle base — EXACT (inside the rect, OR within `radius` of its boundary).
    const em = { radius: 20, base: { type: 'rectangle', x: 0, y: 0, width: 100, height: 50 } }; // box (0,0)-(100,50)
    ok('inside the UNGROWN base rect', pointInEmanation(50, 25, em));
    ok('10px past the right edge (within the 20px growth) is inside', pointInEmanation(110, 25, em));
    ok('exactly 20px past the right edge (inclusive boundary) is inside', pointInEmanation(120, 25, em));
    ok('50px past the right edge (beyond the 20px growth) is outside', !pointInEmanation(150, 25, em));
  }
  {
    // polygon base — EXACT (same boundary-distance logic as rectangle).
    const em = { radius: 15, base: { type: 'polygon', points: [0, 0, 100, 0, 100, 100, 0, 100] } };
    ok('inside the ungrown base polygon', pointInEmanation(50, 50, em));
    ok('10px past an edge (within the 15px growth) is inside', pointInEmanation(110, 50, em));
    ok('50px past an edge (beyond the 15px growth) is outside', !pointInEmanation(150, 50, em));
  }
  ok(
    'an unsupported base type (e.g. cone) never matches, never throws',
    pointInEmanation(0, 0, { radius: 20, base: { type: 'cone', x: 0, y: 0, radius: 10, angle: 90 } }) === false
  );
  ok('a missing base never matches, never throws', pointInEmanation(0, 0, { radius: 20 }) === false);

  // ======================================================================
  // pointInRegionShapes — union across shapes, unsupported types skipped
  // ======================================================================
  {
    const shapes = [
      { type: 'rectangle', x: -1000, y: -1000, width: 10, height: 10 }, // far away
      { type: 'circle', x: 0, y: 0, radius: 30 },
    ];
    ok('matches the SECOND shape when the first misses (union)', pointInRegionShapes(10, 10, shapes));
    ok('misses when outside every shape', !pointInRegionShapes(500, 500, shapes));
  }
  ok(
    'cone/ring/line/emanation are ALL supported now (2026-07-19) — a cone genuinely matches',
    pointInRegionShapes(0, 0, [{ type: 'cone', x: 0, y: 0, radius: 100, angle: 90 }]) === true
  );
  ok(
    'a genuinely unsupported shape type (e.g. "token") never matches, never throws',
    pointInRegionShapes(0, 0, [{ type: 'token', x: 0, y: 0 }]) === false
  );
  ok('non-array shapes reads as no match, never throws', pointInRegionShapes(0, 0, null) === false);
  ok(
    'a null entry inside the shapes array is skipped, not a throw',
    pointInRegionShapes(0, 0, [null, { type: 'circle', x: 0, y: 0, radius: 10 }]) === true
  );

  // ======================================================================
  // pointInRegionShapes — HOLE subtraction, 2026-07-19
  // ======================================================================
  {
    // A 200x200 room, with a 50-radius circular hole cut into its center —
    // "darken this whole room except this alcove".
    const shapes = [
      { type: 'rectangle', x: -100, y: -100, width: 200, height: 200 },
      { type: 'circle', x: 0, y: 0, radius: 50, hole: true },
    ];
    ok('inside the room, outside the hole, is inside the region', pointInRegionShapes(-80, -80, shapes));
    ok('inside the hole is OUTSIDE the region — that IS the hole', !pointInRegionShapes(0, 0, shapes));
    ok('exactly on the hole boundary reads as excluded (inclusive hole)', !pointInRegionShapes(50, 0, shapes));
    ok('outside the room entirely is outside the region', !pointInRegionShapes(500, 500, shapes));
  }
  ok(
    'a region with ONLY hole shapes (no non-hole footprint) matches nowhere — nothing to subtract FROM',
    pointInRegionShapes(0, 0, [{ type: 'circle', x: 0, y: 0, radius: 50, hole: true }]) === false
  );
  {
    // Two holes — a point inside EITHER is excluded.
    const shapes = [
      { type: 'rectangle', x: -100, y: -100, width: 200, height: 200 },
      { type: 'circle', x: -50, y: 0, radius: 20, hole: true },
      { type: 'circle', x: 50, y: 0, radius: 20, hole: true },
    ];
    ok('inside the FIRST hole is excluded', !pointInRegionShapes(-50, 0, shapes));
    ok('inside the SECOND hole is excluded', !pointInRegionShapes(50, 0, shapes));
    ok('between the two holes, still inside the room, is included', pointInRegionShapes(0, 0, shapes));
  }
  ok(
    'holes do not affect a region with NO holes at all — ordinary union, unaffected',
    pointInRegionShapes(10, 10, [
      { type: 'rectangle', x: -1000, y: -1000, width: 10, height: 10 },
      { type: 'circle', x: 0, y: 0, radius: 30 },
    ]) === true
  );

  // ======================================================================
  // applyDarknessAdjustment — the three verbatim Foundry formulas
  // ======================================================================
  ok(
    'OVERRIDE replaces darkness with the modifier, ignoring the base entirely',
    near(applyDarknessAdjustment(0.9, DARKNESS_ADJUST_MODES.OVERRIDE, 0.2), 0.2)
  );
  ok('BRIGHTEN: darkness * (1-modifier)', near(applyDarknessAdjustment(0.8, DARKNESS_ADJUST_MODES.BRIGHTEN, 0.5), 0.4));
  ok(
    'BRIGHTEN at modifier=1 fully clears darkness to 0',
    near(applyDarknessAdjustment(0.8, DARKNESS_ADJUST_MODES.BRIGHTEN, 1), 0)
  );
  ok(
    'DARKEN: 1 - (1-darkness)*(1-modifier)',
    near(applyDarknessAdjustment(0.2, DARKNESS_ADJUST_MODES.DARKEN, 0.5), 1 - (1 - 0.2) * (1 - 0.5))
  );
  ok(
    'DARKEN at modifier=1 fully pins darkness to 1',
    near(applyDarknessAdjustment(0.2, DARKNESS_ADJUST_MODES.DARKEN, 1), 1)
  );
  ok(
    'DARKEN/BRIGHTEN at modifier=0 changes nothing (identity)',
    near(applyDarknessAdjustment(0.37, DARKNESS_ADJUST_MODES.DARKEN, 0), 0.37) &&
      near(applyDarknessAdjustment(0.37, DARKNESS_ADJUST_MODES.BRIGHTEN, 0), 0.37)
  );
  ok('an unrecognized mode changes nothing, never throws/NaNs', near(applyDarknessAdjustment(0.6, 99, 0.5), 0.6));
  ok(
    'non-finite darkness01 floors to 0 before the formula runs',
    near(applyDarknessAdjustment(NaN, DARKNESS_ADJUST_MODES.BRIGHTEN, 0.5), 0)
  );
  ok(
    'modifier clamps into [0,1] rather than propagating',
    near(applyDarknessAdjustment(0.5, DARKNESS_ADJUST_MODES.OVERRIDE, 1.7), 1)
  );

  // ======================================================================
  // computeRegionAdjustedDarkness — the end-to-end query
  // ======================================================================
  ok('no regions => darkness01 passes through unchanged', computeRegionAdjustedDarkness(0, 0, 0.6, []) === 0.6);
  ok('non-array regions => passthrough, never throws', computeRegionAdjustedDarkness(0, 0, 0.6, null) === 0.6);
  {
    const regions = [
      { mode: DARKNESS_ADJUST_MODES.OVERRIDE, modifier: 0.1, shapes: [{ type: 'circle', x: 0, y: 0, radius: 50 }] },
    ];
    ok(
      'a point inside the region gets the adjusted darkness',
      near(computeRegionAdjustedDarkness(0, 0, 0.9, regions), 0.1)
    );
    ok(
      'a point outside every region gets the UN-adjusted darkness',
      near(computeRegionAdjustedDarkness(1000, 1000, 0.9, regions), 0.9)
    );
  }
  {
    // Overlap resolution — CORRECTED 2026-07-19 (was a wrong "last matching
    // region in array order wins" assumption, checked against source and
    // found false): the result is the MINIMUM (brightest) of every matching
    // region's own INDEPENDENTLY-computed adjusted value (each reads the
    // ORIGINAL darkness01, never a compounding cascade through a running
    // result) — verified against `illumination-effects.mjs`'s real
    // sort-by-value-descending + opaque-overwrite mechanism
    // (`computeRegionAdjustedDarkness`'s own doc has the full citation).
    const darkRegion = {
      mode: DARKNESS_ADJUST_MODES.DARKEN,
      modifier: 1,
      shapes: [{ type: 'circle', x: 0, y: 0, radius: 100 }],
    }; // adjusted = 1 - (1-0.5)*(1-1) = 1 (fully dark) at base darkness01=0.5
    const brightRegion = {
      mode: DARKNESS_ADJUST_MODES.OVERRIDE,
      modifier: 0.3,
      shapes: [{ type: 'circle', x: 0, y: 0, radius: 100 }],
    }; // adjusted = 0.3 (fixed, OVERRIDE ignores the base darkness01)
    ok(
      'two overlapping regions: the BRIGHTER (lower) adjusted value wins, not the last-drawn one',
      near(computeRegionAdjustedDarkness(0, 0, 0.5, [darkRegion, brightRegion]), 0.3)
    );
    ok(
      'SAME result with array order REVERSED — proves this is value-based (min), not array-order-based',
      near(computeRegionAdjustedDarkness(0, 0, 0.5, [brightRegion, darkRegion]), 0.3)
    );
  }

  // ======================================================================
  // regionOverlapsElevationBand — the multi-floor darkness fix, 2026-07-19
  // ======================================================================
  ok(
    'a fully unrestricted region (null/null) overlaps every floor band',
    regionOverlapsElevationBand(null, null, 0, 10) && regionOverlapsElevationBand(null, null, -50, -40)
  );
  ok(
    'a fully unrestricted FLOOR (null/null) is overlapped by every region band',
    regionOverlapsElevationBand(0, 10, null, null) && regionOverlapsElevationBand(-50, -40, null, null)
  );
  ok('identical bands overlap', regionOverlapsElevationBand(0, 10, 0, 10));
  ok('a region band strictly inside a floor band overlaps', regionOverlapsElevationBand(2, 8, 0, 10));
  ok(
    'partially overlapping bands overlap (region straddles the floor boundary)',
    regionOverlapsElevationBand(5, 15, 0, 10)
  );
  // ⚠️ THIS ASSERTION IS INVERTED FROM WHAT IT SAID BEFORE 2026-07-26. It used to
  // read "touching at exactly one point counts as overlapping (inclusive
  // boundary)" and pin `regionOverlapsElevationBand(10, 20, 0, 10) === true`.
  // That was wrong, and the author's bridge map is the proof: adjacent floors
  // SHARE a boundary by construction (floor 0 is [0,10], floor 1 is [10,20]), so
  // an inclusive test put every boundary-touching region on BOTH floors. A
  // Middle-floor darkness Region painted five building-shaped rectangles of
  // lighter ground onto the river below, looking exactly like holes punched in
  // the sky-reach shadow. Half-open gives the shared boundary to the UPPER floor
  // alone — the same convention mask-derive.js uses for level art.
  ok(
    'a region on the floor ABOVE, touching only at the shared boundary, does NOT overlap',
    !regionOverlapsElevationBand(10, 20, 0, 10)
  );
  ok('and that same region DOES belong to the floor it actually sits on', regionOverlapsElevationBand(10, 20, 10, 20));
  ok(
    'a region spanning exactly one floor band does not leak UP into the next',
    regionOverlapsElevationBand(0, 10, 0, 10) && !regionOverlapsElevationBand(0, 10, 10, 20)
  );
  // A GM pinning ONE elevation authors a zero-height range. That is a POINT, and
  // a half-open interval test would reject it against its own floor's ground —
  // so it gets `fBottom <= p < fTop` rather than being silently dropped.
  ok(
    'a ZERO-HEIGHT region at the floor’s own ground still applies to that floor',
    regionOverlapsElevationBand(0, 0, 0, 10)
  );
  ok(
    'a ZERO-HEIGHT region mid-band applies; one at the shared boundary belongs upstairs',
    regionOverlapsElevationBand(5, 5, 0, 10) &&
      !regionOverlapsElevationBand(10, 10, 0, 10) &&
      regionOverlapsElevationBand(10, 10, 10, 20)
  );
  ok('a region entirely ABOVE the floor band does not overlap', !regionOverlapsElevationBand(11, 20, 0, 10));
  ok('a region entirely BELOW the floor band does not overlap', !regionOverlapsElevationBand(-20, -1, 0, 10));
  ok(
    'a negative-elevation region (a basement) overlaps a negative-elevation floor',
    regionOverlapsElevationBand(-30, -10, -40, -20)
  );
  ok(
    'a non-finite/malformed bound reads as unrestricted on that side, never throws or NaNs',
    regionOverlapsElevationBand(NaN, 'nope', 0, 10) === true
  );

  // ======================================================================
  // computeShapeMeshBounds — conservative mesh sizing, per shape kind
  // ======================================================================
  {
    const b = computeShapeMeshBounds({ type: 'rectangle', x: 100, y: 200, width: 60, height: 80 });
    ok('rectangle bounds are centered on the shape origin', b.cx === 100 && b.cy === 200);
    ok(
      'rectangle bounds use the diagonal (conservative for any rotation/anchor)',
      near(b.halfWidth, Math.sqrt(60 * 60 + 80 * 80))
    );
  }
  {
    const b = computeShapeMeshBounds({ type: 'ellipse', x: 0, y: 0, radiusX: 30, radiusY: 90 });
    ok(
      'ellipse bounds use the LARGER radius, conservative for any rotation',
      b.halfWidth === 90 && b.halfHeight === 90
    );
  }
  {
    const b = computeShapeMeshBounds({ type: 'circle', x: 5, y: 5, radius: 40 });
    ok(
      'circle bounds are centered on the shape origin with its own radius',
      b.cx === 5 && b.cy === 5 && b.halfWidth === 40
    );
  }
  {
    const b = computeShapeMeshBounds({ type: 'polygon', points: [-10, -10, 10, -10, 10, 30, -10, 30] });
    ok('polygon bounds are the true AABB center', b.cx === 0 && b.cy === 10);
    ok('polygon bounds are the true AABB half-extents', near(b.halfWidth, 10) && near(b.halfHeight, 20));
  }
  {
    const b = computeShapeMeshBounds({ type: 'cone', x: 10, y: 20, radius: 50, angle: 90 });
    ok(
      'cone bounds are the WHOLE disk (generous — not just the wedge)',
      b.cx === 10 && b.cy === 20 && b.halfWidth === 50
    );
  }
  {
    const b = computeShapeMeshBounds({ type: 'ring', x: 0, y: 0, radius: 100, outerWidth: 10 });
    ok('ring bounds use the OUTER radius (radius + outerWidth)', b.halfWidth === 110);
  }
  {
    const b = computeShapeMeshBounds({ type: 'line', x: 0, y: 0, length: 100, width: 20 });
    ok('line bounds use the diagonal from its origin endpoint', near(b.halfWidth, Math.sqrt(100 * 100 + 20 * 20)));
  }
  {
    const b = computeShapeMeshBounds({
      type: 'emanation',
      radius: 20,
      base: { type: 'circle', x: 0, y: 0, radius: 50 },
    });
    ok('emanation bounds are the base shape bounds PADDED by radius', b.cx === 0 && b.cy === 0 && b.halfWidth === 70);
  }
  ok(
    'an emanation with an unsupported base (e.g. cone) has no bounds — the mesh is skipped, not built-and-wasted',
    computeShapeMeshBounds({ type: 'emanation', radius: 20, base: { type: 'cone', radius: 10 } }) === null
  );
  ok(
    'a degenerate cone (zero radius) has no bounds',
    computeShapeMeshBounds({ type: 'cone', radius: 0, angle: 90 }) === null
  );
  ok(
    'a genuinely unsupported shape type has no bounds (mesh is skipped, not guessed)',
    computeShapeMeshBounds({ type: 'token' }) === null
  );
  ok('null shape has no bounds, never throws', computeShapeMeshBounds(null) === null);
  ok(
    'a degenerate (zero-size) rectangle has no bounds',
    computeShapeMeshBounds({ type: 'rectangle', x: 0, y: 0, width: 0, height: 10 }) === null
  );

  // ======================================================================
  // writeRegionPolygonPoints — reuse/truncation contract, world-space (no normalize)
  // ======================================================================
  {
    const points = [1, 2, 3, 4, 5, 6];
    const out = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 99, y: 99 },
    ];
    const count = writeRegionPolygonPoints(points, out);
    ok('writes exactly the number of vertices present', count === 3);
    ok('world-space passthrough — NOT normalized to local/unit space', out[0].x === 1 && out[0].y === 2);
    ok('second vertex correct', out[1].x === 3 && out[1].y === 4);
    ok('third vertex correct', out[2].x === 5 && out[2].y === 6);
    ok(
      'a slot beyond the written count is left untouched (stale data, bounded by the returned count)',
      out[3].x === 99 && out[3].y === 99
    );
  }
  ok(
    'truncates (never grows/throws) when outPoints is smaller than the polygon',
    writeRegionPolygonPoints([1, 2, 3, 4, 5, 6, 7, 8], [{ x: 0, y: 0 }]) === 1
  );
  ok(
    'a non-finite coordinate reads as 0, never NaN',
    (() => {
      const out = [{ x: 9, y: 9 }];
      writeRegionPolygonPoints([NaN, 2], out);
      return out[0].x === 0 && out[0].y === 2;
    })()
  );
  ok('missing/non-array points writes nothing and returns 0', writeRegionPolygonPoints(null, [{ x: 9, y: 9 }]) === 0);
}
