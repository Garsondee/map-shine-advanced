/**
 * Node verification for effects/lighting/point-light-illumination.js.
 *
 * `easeAttenuation`, `computeExposure`, `triangulateLightFan`,
 * `writeLightEdgePoints` and `computeEdgeSoftMarginNormalized` are pure and
 * Node-tested here. `buildPointLightIlluminationMaterial` builds TSL and is
 * browser-only (verified live via the debug panel / an A/B screenshot vs
 * Foundry, not a mocked THREE — CONVENTIONS.md §4).
 */
import {
  easeAttenuation,
  computeExposure,
  triangulateLightFan,
  writeLightEdgePoints,
  computeEdgeSoftMarginNormalized,
  MAX_LIGHT_EDGES,
} from '../point-light-illumination.js';

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
}
