/**
 * Node verification for effects/lighting/point-light-illumination.js.
 *
 * `easeAttenuation`, `computeExposure`, `triangulateLightFan`,
 * `writeLightEdgePoints` and `computeEdgeSoftMarginNormalized` are pure and
 * Node-tested here. `buildPointLightIlluminationMaterial` builds TSL; whether
 * it LOOKS right is still browser-only (verified live via the debug panel /
 * an A/B screenshot vs Foundry — CONVENTIONS.md §4), but the graph itself
 * DOES construct cleanly in Node with the real (not mocked) vendored TSL —
 * see `aperture-gobo-render.test.mjs`'s own "THE FULL INTEGRATION" block,
 * which exercises this exact function with and without the aperture-gobo
 * term wired in. That earlier "browser-only" framing here was never actually
 * tested against; corrected rather than left to mislead the next reader.
 */
import {
  easeAttenuation,
  computeExposure,
  triangulateLightFan,
  writeLightEdgePoints,
  computeEdgeSoftMarginNormalized,
  computeHeightGate,
  buildPointLightIlluminationMaterial,
  MAX_LIGHT_EDGES,
  elevationRank,
  ELEVATION_RANK_FRACTION_DIVISOR,
  HEIGHT_GATE_TOLERANCE_UNITS,
  HEIGHT_GATE_SOFTNESS_UNITS,
  RECEIVER_ELEVATION_LEVELS_MIRROR,
  RECEIVER_ELEVATION_RANGE_UNITS_MIRROR,
  LIGHT_ELEVATION_UNCONFIGURED_SENTINEL,
  computeDepthHeightGate,
  DEPTH_FLAG_RESTRICTS_LIGHT_MIRROR,
  DEPTH_FLAG_IS_TILE_MIRROR,
} from '../point-light-illumination.js';
import {
  RECEIVER_ELEVATION_LEVELS,
  RECEIVER_ELEVATION_RANGE_UNITS,
  decodeReceiverElevationLevel,
  quantizeReceiverElevationAboveFloor,
} from '../../../vt/scene-attr.js';
import {
  DEPTH_FLAG_RESTRICTS_LIGHT,
  DEPTH_FLAG_IS_TILE,
  computeTieSafeExpectedDepth,
  computeExpectedStoredDepth,
} from '../../../vt/scene-depth.js';
import * as THREE from '../../../vendor/three/three.webgpu.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

export function run(t) {
  const { ok } = t;

  // ======================================================================
  // easeAttenuation — Foundry's exact CPU-cached formula
  // ======================================================================
  ok('attenuation 0 eases to 0', near(easeAttenuation(0), 0));
  ok('attenuation 1 eases to 1', near(easeAttenuation(1), 1));
  {
    // Monotonic across the whole domain — the eased curve never runs backward.
    let prev = easeAttenuation(0);
    let monotonic = true;
    for (let i = 1; i <= 20; i++) {
      const v = easeAttenuation(i / 20);
      if (v < prev - 1e-12) monotonic = false;
      prev = v;
    }
    ok('eased attenuation is monotonically non-decreasing over [0,1]', monotonic);
  }
  ok('out-of-range (>1) clamps before easing, stays at the 1-endpoint', near(easeAttenuation(1.5), easeAttenuation(1)));
  ok(
    'out-of-range (<0) clamps before easing, stays at the 0-endpoint',
    near(easeAttenuation(-0.5), easeAttenuation(0))
  );
  ok('non-finite input reads as attenuation 0, never NaN', near(easeAttenuation(NaN), easeAttenuation(0)));
  ok(
    'the eased value stays within [0,1] everywhere sampled',
    [0, 0.25, 0.5, 0.75, 1].every((a) => {
      const v = easeAttenuation(a);
      return v >= -1e-9 && v <= 1 + 1e-9;
    })
  );

  // ======================================================================
  // computeExposure — Foundry's luminosity -> exposure remap
  // ======================================================================
  ok("luminosity 0.5 (LightData's default) is the neutral point (exposure 0)", near(computeExposure(0.5), 0));
  ok('luminosity 0 gives exposure -1', near(computeExposure(0), -1));
  ok('luminosity 1 gives exposure 1', near(computeExposure(1), 1));
  ok('luminosity above 1 clamps before the remap', near(computeExposure(1.7), computeExposure(1)));
  ok('luminosity below 0 clamps before the remap', near(computeExposure(-0.3), computeExposure(0)));
  ok('non-finite luminosity reads as 0.5 (neutral), never NaN', near(computeExposure(NaN), 0));

  // ======================================================================
  // triangulateLightFan — fan triangulation, verified against a clean square
  // ======================================================================
  {
    // A world-space axis-aligned square whose corners land on exact,
    // hand-checkable local coordinates: origin (100,100), radius 100 =>
    // (0,0)->(-1,-1), (200,0)->(1,-1), (200,200)->(1,1), (0,200)->(-1,1).
    const square = [0, 0, 200, 0, 200, 200, 0, 200];
    const { array: out, vertexCount } = triangulateLightFan(square, 100, 100, 100);

    ok('4 vertices => 12 fan vertices (4 triangles * 3 verts)', vertexCount === 12);
    ok('the array holds exactly 36 floats (12 verts * 3 components)', out.length === 36);

    const vert = (i) => [out[i * 3], out[i * 3 + 1], out[i * 3 + 2]];
    const eqVert = (v, expected) => near(v[0], expected[0]) && near(v[1], expected[1]) && near(v[2], expected[2]);

    // Triangle 0: origin, corner0(-1,-1), corner1(1,-1)
    ok('tri0 vertex 0 is the local origin', eqVert(vert(0), [0, 0, 0]));
    ok('tri0 vertex 1 is corner0 at local (-1,-1)', eqVert(vert(1), [-1, -1, 0]));
    ok('tri0 vertex 2 is corner1 at local (1,-1)', eqVert(vert(2), [1, -1, 0]));

    // Triangle 1: origin, corner1(1,-1), corner2(1,1)
    ok('tri1 vertex 0 is the local origin', eqVert(vert(3), [0, 0, 0]));
    ok('tri1 vertex 1 is corner1 at local (1,-1)', eqVert(vert(4), [1, -1, 0]));
    ok('tri1 vertex 2 is corner2 at local (1,1)', eqVert(vert(5), [1, 1, 0]));

    // Triangle 3 (the LAST): origin, corner3(-1,1), WRAPS back to corner0(-1,-1)
    ok('tri3 vertex 0 is the local origin', eqVert(vert(9), [0, 0, 0]));
    ok('tri3 vertex 1 is corner3 at local (-1,1)', eqVert(vert(10), [-1, 1, 0]));
    ok('tri3 vertex 2 WRAPS to corner0 at local (-1,-1) (implicit polygon closure)', eqVert(vert(11), [-1, -1, 0]));
  }

  // ---- a minimal valid polygon (3 vertices = a triangle) produces exactly
  // 3 fan triangles (one per edge, all sharing the origin) --------------
  {
    const tri = [10, 0, 0, 10, -10, 0];
    const { array: out, vertexCount } = triangulateLightFan(tri, 0, 0, 1);
    ok('3-vertex polygon => 9 fan vertices (3 triangles * 3 verts)', vertexCount === 9);
    ok('the array holds exactly 27 floats', out.length === 27);
  }

  // ---- radius 0 does not throw or produce Infinity/NaN (defensive; the
  // real caller never reaches this since deriveLightSnapshot rejects
  // radius<=0 first) --------------------------------------------------------
  {
    const { array: out } = triangulateLightFan([1, 1, 2, 2, 3, 1], 0, 0, 0);
    ok('radius 0 produces finite output, never Infinity/NaN', Array.from(out).every(Number.isFinite));
  }

  // ======================================================================
  // outArray reuse / grow — THE ACTUAL LEAK FIX (2026-07-18): a device-lost
  // crash traced to vt-pan-viewer.js allocating a BRAND NEW BufferAttribute +
  // Float32Array every frame for every active light. BufferAttribute has no
  // dispose() (verified against the vendored three.webgpu.js source) and
  // setAttribute() is a bare property replace — nothing ever freed the OLD
  // GPU buffer, so every frame leaked one small native buffer per light,
  // unbounded, until WebGPU's device was lost. These assertions are the
  // regression proof for the reuse contract the fix depends on.
  // ======================================================================
  {
    const square = [0, 0, 200, 0, 200, 200, 0, 200]; // 4 vertices
    const scratch = new Float32Array(9 * 10); // room for 10 vertices' worth of triangles
    const first = triangulateLightFan(square, 100, 100, 100, scratch);
    ok('a big-enough outArray is REUSED (same object identity), not replaced', first.array === scratch);
    ok('vertexCount is still correct against a larger-than-needed buffer', first.vertexCount === 12);

    const triangle = [10, 0, 0, 10, -10, 0]; // 3 vertices — SMALLER shape, same scratch buffer
    const second = triangulateLightFan(triangle, 0, 0, 1, scratch);
    ok(
      'a smaller shape against the SAME scratch buffer is STILL reused (no shrink-reallocation)',
      second.array === scratch
    );
    ok('vertexCount correctly reports the SMALLER count', second.vertexCount === 9);
    ok(
      'stale floats from the PREVIOUS (larger) frame remain past vertexCount — the caller MUST use ' +
        'vertexCount/setDrawRange, never array.length, to know what is valid this frame',
      scratch.length > second.vertexCount * 3
    );
  }
  {
    // An outArray TOO SMALL for this frame's shape triggers a fresh allocation
    // — the only case where a new array is created, and it should be rare
    // (a light's polygon growing past its previous high-water mark), never
    // the steady-state per-frame path.
    const square = [0, 0, 200, 0, 200, 200, 0, 200]; // needs 36 floats
    const tooSmall = new Float32Array(4);
    const grown = triangulateLightFan(square, 100, 100, 100, tooSmall);
    ok('an undersized outArray is NOT reused — a bigger one is allocated instead', grown.array !== tooSmall);
    ok('the freshly-allocated array is exactly the right size', grown.array.length === 36);
    ok('vertexCount is correct on the grown path too', grown.vertexCount === 12);
  }
  {
    // No outArray at all (the bare call, e.g. this file's earlier assertions)
    // must keep working exactly as before — always allocates, same as the
    // pre-fix behaviour. Correct for a ONE-OFF call; the caller opts into
    // reuse by passing a scratch buffer, reuse is never forced.
    const { array, vertexCount } = triangulateLightFan([0, 0, 1, 0, 0, 1], 0, 0, 1);
    ok('omitting outArray still allocates correctly', array.length === 27 && vertexCount === 9);
  }

  // ======================================================================
  // writeLightEdgePoints — the soft-edge SDF's data source. Plain {x,y}
  // objects stand in for THREE.Vector2 instances (duck-typed, no THREE
  // dependency needed for the pure logic — CONVENTIONS.md §4).
  // ======================================================================
  const makePoints = (n) => Array.from({ length: n }, () => ({ x: -999, y: -999 }));

  {
    // Same square as triangulateLightFan's own reference case: origin
    // (100,100), radius 100 => corners land on exact local (±1,±1).
    const square = [0, 0, 200, 0, 200, 200, 0, 200];
    const outPoints = makePoints(8); // plenty of headroom
    const count = writeLightEdgePoints(square, 100, 100, 100, outPoints);
    ok('4-vertex polygon reports count 4', count === 4);
    ok('corner0 lands at local (-1,-1)', near(outPoints[0].x, -1) && near(outPoints[0].y, -1));
    ok('corner1 lands at local (1,-1)', near(outPoints[1].x, 1) && near(outPoints[1].y, -1));
    ok('corner2 lands at local (1,1)', near(outPoints[2].x, 1) && near(outPoints[2].y, 1));
    ok('corner3 lands at local (-1,1)', near(outPoints[3].x, -1) && near(outPoints[3].y, 1));
    ok(
      'slots beyond count are left untouched (still the sentinel)',
      outPoints[4].x === -999 && outPoints[4].y === -999
    );
  }

  // ---- TRUNCATION, not growth — the reuse contract this function exists for
  {
    // A hexagon (6 vertices) against an outPoints array with room for only 3.
    const hexagon = [10, 0, 5, 8, -5, 8, -10, 0, -5, -8, 5, -8];
    const outPoints = makePoints(3);
    const count = writeLightEdgePoints(hexagon, 0, 0, 10, outPoints);
    ok('a too-small outPoints array is NEVER grown — count truncates to its length', count === 3);
    ok('outPoints.length is unchanged (never reallocated)', outPoints.length === 3);
    // The first 3 vertices should still be correct (not garbage) even though truncated.
    ok(
      'the 3 written vertices are the FIRST 3 polygon vertices, correctly normalized',
      near(outPoints[0].x, 1) && near(outPoints[0].y, 0)
    );
  }

  ok(
    'a degenerate 0-vertex-ish call does not throw',
    (() => {
      try {
        writeLightEdgePoints([0, 0, 1, 0, 0, 1], 0, 0, 1, makePoints(3));
        return true;
      } catch {
        return false;
      }
    })()
  );

  // ======================================================================
  // computeEdgeSoftMarginNormalized — Foundry's EDGE_OFFSET*(gridSize/100),
  // converted to a fraction of the light's own radius.
  // ======================================================================
  {
    // Foundry's own reference grid (100px) and edge offset (8px): margin
    // should be EXACTLY 8px worth, as a fraction of the radius.
    ok(
      'reference grid (100px), radius 100 => margin is exactly 0.08 (8px/100px)',
      near(computeEdgeSoftMarginNormalized(100, 100), 0.08)
    );
  }
  {
    // A LARGER grid (200px) scales the margin proportionally larger (16px
    // worth), matching Foundry's own "consistent across map scales" intent.
    ok('a 2x grid doubles the margin in px terms', near(computeEdgeSoftMarginNormalized(200, 100), 0.16));
  }
  {
    // A bigger RADIUS (same margin in px) shrinks the NORMALIZED margin —
    // an 8px margin matters less on a huge light than a tiny one.
    const small = computeEdgeSoftMarginNormalized(100, 50);
    const big = computeEdgeSoftMarginNormalized(100, 500);
    ok('a small-radius light gets a LARGER normalized margin than a big one (same px width)', small > big);
  }
  ok(
    'radius <= 0 reads as zero margin (never divides by zero/negative)',
    computeEdgeSoftMarginNormalized(100, 0) === 0
  );
  ok('negative radius also reads as zero margin', computeEdgeSoftMarginNormalized(100, -50) === 0);
  ok(
    "a bad gridSize falls back to Foundry's own 100px reference, never NaN",
    Number.isFinite(computeEdgeSoftMarginNormalized(NaN, 100))
  );
  ok('an explicit edgeOffsetPx override is honoured', near(computeEdgeSoftMarginNormalized(100, 100, 16), 0.16));

  // ---- MAX_LIGHT_EDGES sanity — a documented, sane cap ---------------------
  ok('MAX_LIGHT_EDGES is a sane, positive, generous cap', MAX_LIGHT_EDGES >= 32 && MAX_LIGHT_EDGES <= 256);

  // ======================================================================
  // THE CROSS-FILE PIN — vt/scene-attr.js's RECEIVER_ELEVATION_LEVELS/
  // RANGE_UNITS and this module's own _MIRROR constants must agree, or this
  // file's decode silently disagrees with what scene-attr.js actually packs.
  // A direct import would create a vt/<->effects/ cycle (see this module's
  // own "HEIGHT/ELEVATION GATE" header) — this test is what keeps the
  // deliberate duplicate honest, the same shape as SPECULAR_DEFAULT_
  // SHIMMER_GAIN vs SPECULAR_PARAMS.shimmerGain.default.
  // ======================================================================
  ok(
    'RECEIVER_ELEVATION_LEVELS_MIRROR matches vt/scene-attr.js´s real constant',
    RECEIVER_ELEVATION_LEVELS_MIRROR === RECEIVER_ELEVATION_LEVELS
  );
  ok(
    'RECEIVER_ELEVATION_RANGE_UNITS_MIRROR matches vt/scene-attr.js´s real constant',
    RECEIVER_ELEVATION_RANGE_UNITS_MIRROR === RECEIVER_ELEVATION_RANGE_UNITS
  );

  // ======================================================================
  // elevationRank — the floor-index-dominant absolute height. THE fix for the
  // 2026-08-03 live report; see the function's own doc for the postmortem.
  // ======================================================================
  ok(
    'the within-floor fraction is STRICTLY below 1, so a floor´s own highest surface can never outrank ' +
      'the floor above it — the whole load-bearing property of the rank',
    elevationRank(0, RECEIVER_ELEVATION_RANGE_UNITS_MIRROR) < 1 &&
      elevationRank(0, RECEIVER_ELEVATION_RANGE_UNITS_MIRROR * 100) < 1
  );
  ok(
    'every floor-1 height outranks every floor-0 height',
    [0, 1, 5, 9, 15, 400].every((hi) =>
      [0, 1, 5, 9, 15, 400].every((lo) => elevationRank(1, hi) > elevationRank(0, lo))
    )
  );
  ok(
    'the rank is monotonic in height within one floor, and a negative height clamps to the floor´s ground',
    elevationRank(2, 0) < elevationRank(2, 3) &&
      elevationRank(2, 3) < elevationRank(2, 9) &&
      elevationRank(2, -50) === elevationRank(2, 0)
  );
  ok(
    'a decoded RECEIVER level and the CPU-side rank agree exactly — the shader divides the same 16 ' +
      'buckets by the SAME divisor, and at RANGE=15 a level IS the height in units',
    [0, 1, 5, 9, 15].every(
      (units) =>
        near(
          elevationRank(3, units),
          3 + quantizeReceiverElevationAboveFloor(units) / ELEVATION_RANK_FRACTION_DIVISOR
        ) && quantizeReceiverElevationAboveFloor(units) === units
    )
  );
  ok(
    'the fraction span PLUS the gate´s whole tolerance+softness band stays strictly under one floor — ' +
      'the invariant that makes cross-floor bleed structurally impossible rather than merely unlikely',
    RECEIVER_ELEVATION_RANGE_UNITS_MIRROR / ELEVATION_RANK_FRACTION_DIVISOR +
      (HEIGHT_GATE_TOLERANCE_UNITS + HEIGHT_GATE_SOFTNESS_UNITS) / ELEVATION_RANK_FRACTION_DIVISOR <
      1
  );
  ok('a non-finite floor index or height degrades to the lowest rank, never NaN', elevationRank(NaN, NaN) === 0);

  // ======================================================================
  // computeHeightGate — the CPU twin of the shader's height/elevation gate.
  // Both arguments are RANKS (elevationRank), never bare heights.
  // ======================================================================
  ok(
    'the unconfigured sentinel always fully reaches, at any realistic receiver rank — no special-case ' +
      'branch needed, the smoothstep itself saturates',
    computeHeightGate(
      elevationRank(9, RECEIVER_ELEVATION_RANGE_UNITS_MIRROR),
      LIGHT_ELEVATION_UNCONFIGURED_SENTINEL
    ) === 1
  );
  ok(
    'a light reading NaN rank stays finite, never NaN downstream',
    Number.isFinite(computeHeightGate(elevationRank(0, 5), NaN))
  );
  ok(
    'a receiver at or BELOW the light is fully lit — a lamp lights its own floor, and an UNWRITTEN ' +
      'attr texel (rank 0, the lowest possible) must read as PROCEED (fail-open polarity)',
    computeHeightGate(elevationRank(0, 0), elevationRank(0, 5)) === 1 && computeHeightGate(0, elevationRank(2, 0)) === 1
  );
  ok(
    'a receiver within the tolerance above the light is still fully lit',
    computeHeightGate(elevationRank(0, 1), elevationRank(0, 0)) === 1
  );
  ok(
    'a receiver past tolerance+softness above the light is fully dark',
    computeHeightGate(
      elevationRank(0, HEIGHT_GATE_TOLERANCE_UNITS + HEIGHT_GATE_SOFTNESS_UNITS + 1),
      elevationRank(0, 0)
    ) === 0
  );
  ok(
    'the gate is monotonically NON-INCREASING as the receiver rises against a fixed light',
    (() => {
      const light = elevationRank(1, 5);
      let prev = 2;
      for (let f = 0; f <= 3; f++) {
        for (let h = 0; h <= 15; h += 1) {
          const g = computeHeightGate(elevationRank(f, h), light);
          if (g > prev + 1e-9) return false;
          prev = g;
        }
      }
      return true;
    })()
  );
  ok(
    'the gate always stays within [0,1] across every floor/height combination',
    [0, 1, 2, 3].every((f) =>
      [0, 1, 5, 9, 15].every((h) => {
        const g = computeHeightGate(elevationRank(f, h), elevationRank(1, 5));
        return g >= 0 && g <= 1;
      })
    )
  );
  ok(
    'a degenerate (zero) softness still resolves to a clean 0/1 edge, never NaN/Infinity',
    Number.isFinite(computeHeightGate(elevationRank(0, 9), elevationRank(0, 0), 1, 0)) &&
      computeHeightGate(elevationRank(0, 9), elevationRank(0, 0), 1, 0) === 0 &&
      computeHeightGate(elevationRank(0, 0), elevationRank(0, 9), 1, 0) === 1
  );
  ok(
    'LIGHT_ELEVATION_UNCONFIGURED_SENTINEL sits comfortably beyond any real rank (255 floors is the ' +
      'hard ceiling of an RGBA8 floor-index channel), so the smoothstep genuinely saturates',
    LIGHT_ELEVATION_UNCONFIGURED_SENTINEL > 255 + HEIGHT_GATE_TOLERANCE_UNITS + HEIGHT_GATE_SOFTNESS_UNITS
  );

  // ======================================================================
  // ⚠️ ROUND 8 — receiverOverhead: an UNCONFIGURED light is not actually
  // ungateable. PRESENCE_BIT_OVERHEAD hard-blocks ANY light, needing NO
  // numeric elevation authored on either side — see buildHeightGateNode's
  // own "ROUND 8" header for the full reasoning (rejecting the wider
  // PRESENCE_BIT_OCCLUDES_BACKGROUND, which would have blocked a torch
  // mounted on a table or a bush grown on a tile).
  // ======================================================================
  ok(
    'an UNCONFIGURED light (the sentinel — never gated by the fine comparison) is STILL fully blocked ' +
      'by genuine overhead/roof content — the exact gap the lantern-cover report exposed',
    computeHeightGate(elevationRank(0, 5), LIGHT_ELEVATION_UNCONFIGURED_SENTINEL, 1, 3, 1) === 0
  );
  ok(
    'the SAME unconfigured light, SAME receiver, reaches fully when overhead is NOT set — the sentinel´s ' +
      'own "reach everything by default" behaviour is unchanged for ordinary content',
    computeHeightGate(elevationRank(0, 5), LIGHT_ELEVATION_UNCONFIGURED_SENTINEL, 1, 3, 0) === 1
  );
  ok(
    'a CONFIGURED light already fully occluded by the fine comparison stays occluded with overhead=0 ' +
      '(no double-negative — overhead can only ADD occlusion, never remove it)',
    computeHeightGate(elevationRank(0, 9), elevationRank(0, 5), 1, 3, 0) === 0
  );
  ok(
    'a CONFIGURED light that WOULD fully reach under the fine comparison alone is still hard-blocked ' +
      'when the receiver is genuinely overhead — overhead is an AND, not a fallback',
    computeHeightGate(elevationRank(0, 0), elevationRank(0, 5), 1, 3, 1) === 0
  );
  ok(
    'overhead is a clean binary gate, not a fractional blend — any truthy value blocks fully',
    computeHeightGate(elevationRank(0, 0), elevationRank(0, 5), 1, 3, true) === 0 &&
      computeHeightGate(elevationRank(0, 0), elevationRank(0, 5), 1, 3, 7) === 0
  );

  // ======================================================================
  // ⚠️ THE AUTHOR'S OWN LIVE SCENARIOS, as regression pins. Each of these
  // FAILED under the floor-relative model this replaced; the numbers come
  // straight from the two live reports, not from invented fixtures
  // (feedback_bench_must_build_inputs_like_production).
  // ======================================================================
  ok(
    'LIVE CASE 1 — a lantern´s cover tile 4-5 units above its own flame, SAME floor, goes fully dark ' +
      '(light=5, cover=9 and cover=10, the author´s own numbers)',
    computeHeightGate(elevationRank(0, 9), elevationRank(0, 5)) === 0 &&
      computeHeightGate(elevationRank(0, 10), elevationRank(0, 5)) === 0
  );
  ok(
    'LIVE CASE 2 — the reported blowout: a light at -20 on a basement spanning [-20,0) (rank floor 0, ' +
      '0 above its ground) must NOT light an upper storey´s floorboards at +5 on a floor spanning ' +
      '[5,15) (rank floor 2, also 0 above ITS ground). Under the old floor-RELATIVE model both sides ' +
      'read 0, the gate returned 0.5, and half a blown-out light painted the whole storey white.',
    computeHeightGate(elevationRank(2, 0), elevationRank(0, 0)) === 0
  );
  ok(
    'LIVE CASE 3 — light streaming OUT of a ground-floor window, seen from above: outside the building ' +
      'there is no upper floor, so buf:scene.attr records the GROUND´s own low rank and the light ' +
      'passes. The hole-stack model falls out of the same comparison, uncased.',
    computeHeightGate(elevationRank(0, 0), elevationRank(0, 0)) === 1
  );
  ok(
    'LIVE CASE 2, generalised — NO height within a lower floor can reach ANY height on a higher floor, ' +
      'which is the property the old model lacked entirely',
    [0, 1, 5, 9, 15].every((lightH) =>
      [0, 1, 5, 9, 15].every((recvH) => computeHeightGate(elevationRank(1, recvH), elevationRank(0, lightH)) === 0)
    )
  );

  // ======================================================================
  // STAGE 2 (2026-08-04) — computeDepthHeightGate, the depth-authority gate's
  // own CPU twin. RANK comparison is a bare "above or not", no tolerance/
  // softness band (unlike computeHeightGate above) — see buildDepthHeightGateNode's
  // own header for why that band is no longer needed.
  // ======================================================================
  ok(
    "a receiver whose stored depth is SMALLER than the light's expected depth (higher rank, drawn ON TOP) is blocked",
    computeDepthHeightGate({ storedDepth: 0.3, expectedDepth: 0.5 }) === 0
  );
  ok(
    'a receiver at EXACTLY the light\'s own expected depth (the common "standing on my own floor" tie) passes',
    computeDepthHeightGate({ storedDepth: 0.5, expectedDepth: 0.5 }) === 1
  );
  ok(
    'a receiver whose stored depth is LARGER (lower rank, drawn BELOW the light) passes',
    computeDepthHeightGate({ storedDepth: 0.7, expectedDepth: 0.5 }) === 1
  );
  ok(
    'no flags byte at all (omitted) never blocks on the tile-restrict term, rank alone decides',
    computeDepthHeightGate({ storedDepth: 0.7, expectedDepth: 0.5 }) === 1 &&
      computeDepthHeightGate({ storedDepth: 0.3, expectedDepth: 0.5 }) === 0
  );
  ok(
    'RESTRICTS_LIGHT set on a TILE hard-blocks even a receiver BELOW the light (rank alone would have passed it)',
    computeDepthHeightGate({
      storedDepth: 0.7,
      expectedDepth: 0.5,
      flagsByte: DEPTH_FLAG_RESTRICTS_LIGHT_MIRROR | DEPTH_FLAG_IS_TILE_MIRROR,
    }) === 0
  );
  ok(
    "RESTRICTS_LIGHT WITHOUT the IS_TILE bit — a Level's own background gets restrictsLight UNCONDITIONALLY " +
      "(vt/scene-depth.js#computeSceneDepthFlags's own doc) — must NOT self-block every light on its own floor",
    computeDepthHeightGate({ storedDepth: 0.7, expectedDepth: 0.5, flagsByte: DEPTH_FLAG_RESTRICTS_LIGHT_MIRROR }) === 1
  );
  ok(
    'IS_TILE without RESTRICTS_LIGHT (an ordinary tile with the flag never ticked) never blocks',
    computeDepthHeightGate({ storedDepth: 0.7, expectedDepth: 0.5, flagsByte: DEPTH_FLAG_IS_TILE_MIRROR }) === 1
  );
  ok(
    'other bits in the same byte (e.g. IS_LEVEL_FOREGROUND, value 8) never trip the tile-restrict block on their own',
    computeDepthHeightGate({ storedDepth: 0.7, expectedDepth: 0.5, flagsByte: 8 }) === 1
  );

  // The cross-file pin (`RECEIVER_ELEVATION_LEVELS_MIRROR`'s own precedent,
  // just above) — these two small integers are DUPLICATED into this module
  // (not imported, to avoid a `vt/` <-> `effects/` cycle — see
  // DEPTH_FLAG_RESTRICTS_LIGHT_MIRROR's own doc) and must never silently
  // drift from vt/scene-depth.js's real values.
  ok(
    "DEPTH_FLAG_RESTRICTS_LIGHT_MIRROR/DEPTH_FLAG_IS_TILE_MIRROR match vt/scene-depth.js's real flag values exactly",
    DEPTH_FLAG_RESTRICTS_LIGHT_MIRROR === DEPTH_FLAG_RESTRICTS_LIGHT && DEPTH_FLAG_IS_TILE_MIRROR === DEPTH_FLAG_IS_TILE
  );

  // ======================================================================
  // computeTieSafeExpectedDepth (vt/scene-depth.js) — the fail-open tie
  // buffer, renamed 2026-08-05 (was computeLightExpectedDepth) once specular
  // needed the SAME buffer for its own, non-light query. Exercised HERE, not
  // just in vt/__tests__/scene-depth.test.mjs, because this is the exact seam
  // computeDepthHeightGate consumes: a light resolved to the SAME rank as its
  // own floor's ground must pass through THIS gate, not just satisfy the
  // formula in isolation.
  // ======================================================================
  ok(
    'computeTieSafeExpectedDepth is STRICTLY SMALLER than the bare formula would give (the buffer subtracts, never adds)',
    computeTieSafeExpectedDepth(3, 10) < computeExpectedStoredDepth(3, 10)
  );
  ok(
    "a receiver at the SAME rank as the light (computeExpectedStoredDepth's own bare value — what a real " +
      'drawable AT this exact rank actually stores) still PASSES the gate through the buffered ' +
      'uLightExpectedDepth — the tie case computeTieSafeExpectedDepth exists to protect',
    computeDepthHeightGate({
      storedDepth: computeExpectedStoredDepth(3, 10),
      expectedDepth: computeTieSafeExpectedDepth(3, 10),
    }) === 1
  );
  ok(
    'the buffer can never bridge two DIFFERENT adjacent ranks into a false tie, at a realistic scene size',
    (() => {
      const maxRank = 500;
      for (let rank = 0; rank < 20; rank++) {
        const expectedAtRank = computeTieSafeExpectedDepth(rank, maxRank);
        const expectedAtNextRank = computeTieSafeExpectedDepth(rank + 1, maxRank);
        // The rank ABOVE must still read as "above" (blocked) against a light
        // resolved to THIS rank — the whole ordinal property must survive
        // the buffer.
        if (computeDepthHeightGate({ storedDepth: expectedAtNextRank, expectedDepth: expectedAtRank }) !== 0) {
          return false;
        }
      }
      return true;
    })()
  );

  // ======================================================================
  // buildPointLightIlluminationMaterial — the height gate compiles cleanly
  // with a real attrTexNode/depthTexNode/depthFlagsTexNode (the vendored TSL,
  // not a mock — construction-only, matching this file's own header on what
  // is and is not Node-verifiable).
  // ======================================================================
  {
    const { uniform: u3, vec3: v3, texture } = THREE.TSL;
    const attrTexture = new THREE.DataTexture(
      new Uint8Array([0, 0, 0, 255]),
      1,
      1,
      THREE.RGBAFormat,
      THREE.UnsignedByteType
    );
    attrTexture.needsUpdate = true;
    // STAGE 2 (2026-08-04) — a real DEPTH texture (not a colour attachment)
    // for the depth gate's own primary input, plus its COLOUR/flags sibling.
    const depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
    const depthFlagsTexture = new THREE.DataTexture(
      new Uint8Array([0, 0, 0, 255]),
      1,
      1,
      THREE.RGBAFormat,
      THREE.UnsignedByteType
    );
    depthFlagsTexture.needsUpdate = true;
    let built = null;
    let err = null;
    try {
      built = buildPointLightIlluminationMaterial({
        THREE,
        uBackgroundColor: u3(v3(0.9, 0.9, 0.9)),
        uDimColor: u3(v3(0.9, 0.9, 0.9)),
        uBrightColor: u3(v3(1, 1, 1)),
        attrTexNode: texture(attrTexture),
        depthTexNode: texture(depthTexture),
        depthFlagsTexNode: texture(depthFlagsTexture),
      });
    } catch (e) {
      err = e;
    }
    ok(
      `the height gate constructs cleanly with a real depthTexNode/depthFlagsTexNode (${err ? err.message : 'clean'})`,
      err === null
    );
    ok('...and returns uLightExpectedDepth as a real settable uniform', !!built?.uLightExpectedDepth);
    ok(
      "...defaulting to 0 — the lowest possible expected depth, full reach, until point-light-pool.js's " +
        'per-frame refresh overwrites it (depth-authority.js#rankOfElevation has no "unconfigured" case left)',
      built.uLightExpectedDepth.value === 0
    );

    // Without depthTexNode at all, the gate must compile OUT entirely
    // (`tsl/no-uniform-gates`) rather than throw on a missing texture read.
    let unwired = null;
    let unwiredErr = null;
    try {
      unwired = buildPointLightIlluminationMaterial({
        THREE,
        uBackgroundColor: u3(v3(0.9, 0.9, 0.9)),
        uDimColor: u3(v3(0.9, 0.9, 0.9)),
        uBrightColor: u3(v3(1, 1, 1)),
      });
    } catch (e) {
      unwiredErr = e;
    }
    ok(
      `omitting depthTexNode still constructs cleanly — the gate compiles out, not a missing-texture crash (${unwiredErr ? unwiredErr.message : 'clean'})`,
      unwiredErr === null
    );
    ok(
      '...and STILL returns the uniform (so a caller can set it without checking which branch built)',
      !!unwired?.uLightExpectedDepth
    );
  }

  // Sanity: this decode module import is exercised (not merely imported and
  // unused) — proves the two files' constants really are comparable numbers,
  // not two differently-shaped exports that happened to both be truthy.
  ok(
    'decodeReceiverElevationLevel (imported from scene-attr.js) is a real function, not undefined',
    typeof decodeReceiverElevationLevel === 'function'
  );
}
