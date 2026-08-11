/**
 * Node verification for effects/lighting/point-light-batch-mesh.js — S2.4's
 * own gate for its PURE half (`docs/holy/V4-Testament.md`). The THREE-
 * touching `createBatchedLightMesh` factory needs a real device and is
 * verified through the shader lab instead (`tools/shader-lab/bench-point-
 * lights.js`'s `production-shaped-packed-batch` scenario) — everything
 * checkable without one lives here: the exact byte offsets design doc §3.3
 * specifies, which is also the single easiest place to get an off-by-one
 * wrong and have it survive as a plausible-looking pixel.
 */
import {
  writeLightSpanGeometry,
  writeIlluminationValueSpan,
  writeColorationValueSpan,
  shapePointsUnchanged,
} from '../point-light-batch-mesh.js';

export function run(t) {
  const { ok } = t;

  // ==========================================================================
  // shapePointsUnchanged — the primitive `reconcile`'s per-member placement
  // dirty-check is built on (a light that MOVES without changing its
  // vertexCount does not trip `createBucket`'s own `rebuilt` flag — this is
  // the OTHER half of that check).
  // ==========================================================================
  ok('same reference (including both null) is unchanged', shapePointsUnchanged(null, null) === true);
  ok('same content, different array identity is unchanged', shapePointsUnchanged([1, 2, 3], [1, 2, 3]) === true);
  ok('different content is changed', shapePointsUnchanged([1, 2, 3], [1, 2, 4]) === false);
  ok('different length is changed', shapePointsUnchanged([1, 2], [1, 2, 3]) === false);
  ok(
    'one-sided null is changed',
    shapePointsUnchanged(null, [1, 2]) === false && shapePointsUnchanged([1, 2], null) === false
  );

  // ==========================================================================
  // writeLightSpanGeometry — world-bake + local-unit copy, at an offset
  // ==========================================================================
  {
    // One triangle (origin + two rim points), matching triangulateLightFan's
    // own per-triangle layout: [cx,cy,cz, rim0x,rim0y,rim0z, rim1x,rim1y,rim1z].
    const localFan = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const arrays = { position: new Float32Array(3 * 3), aLocalUnit: new Float32Array(3 * 2) };
    writeLightSpanGeometry(arrays, 0, 3, localFan, 100, 200, 10);
    ok(
      'the centre vertex bakes to the light´s own origin',
      arrays.position[0] === 100 && arrays.position[1] === 200 && arrays.position[2] === 0
    );
    ok(
      'a rim vertex at local (1,0) bakes to origin + radius along X',
      arrays.position[3] === 110 && arrays.position[4] === 200
    );
    ok(
      'a rim vertex at local (0,1) bakes to origin + radius along Y',
      arrays.position[6] === 100 && arrays.position[7] === 210
    );
    ok(
      'aLocalUnit carries the RAW unit-circle coords, untranslated and unscaled',
      arrays.aLocalUnit[2] === 1 &&
        arrays.aLocalUnit[3] === 0 &&
        arrays.aLocalUnit[4] === 0 &&
        arrays.aLocalUnit[5] === 1
    );
  }
  {
    // A non-zero START must not touch anything before it — the exact class
    // of bug a second light's span writing over the first light's data would be.
    const localFan = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const arrays = { position: new Float32Array(6 * 3).fill(-999), aLocalUnit: new Float32Array(6 * 2).fill(-999) };
    writeLightSpanGeometry(arrays, 3, 3, localFan, 500, 500, 1);
    ok(
      'vertices before `start` are untouched',
      arrays.position[0] === -999 && arrays.position[1] === -999 && arrays.aLocalUnit[0] === -999
    );
    ok(
      'the write lands exactly at `start`, not `start-1` or `start+1`',
      arrays.position[3 * 3 + 0] === 500 && arrays.position[3 * 3 + 1] === 500
    );
  }
  {
    // A caller that only allocated SOME of the layout's buffers (e.g. testing
    // aLocalUnit in isolation) must not crash on the absent one.
    const arrays = { aLocalUnit: new Float32Array(2) };
    let threw = false;
    try {
      writeLightSpanGeometry(arrays, 0, 1, new Float32Array([0, 0, 0]), 1, 2, 3);
    } catch {
      threw = true;
    }
    ok('a missing `position` buffer is guarded, not a crash', threw === false);
  }

  // ==========================================================================
  // writeIlluminationValueSpan — design doc §3.3's illumination byte layout
  // ==========================================================================
  {
    const arrays = {
      aParams: new Float32Array(2 * 4),
      aColorA: new Float32Array(2 * 4),
      aColorB: new Float32Array(2 * 4),
      aColorC: new Float32Array(2 * 4),
      aAnim: new Float32Array(2 * 4),
      aWind: new Float32Array(2 * 4),
    };
    // Every field a DISTINCT INTEGER, deliberately never a decimal fraction:
    // `arrays.*` are Float32Array — `0.1`/`0.6`/`0.9`-style JS-double literals
    // are NOT exactly representable in float32, so writing one and reading it
    // back with `===` against the ORIGINAL double fails on a rounding
    // difference that has nothing to do with this function's own offset
    // logic (caught live: every check below false-failed on exactly that
    // until these values were swapped to integers — a test bug, not a
    // production one). Integers up to 2^24 round-trip through float32 exactly.
    const values = {
      ratio: 25,
      attenuationEased: 50,
      exposure: 10,
      expectedDepth: 75,
      bg: [1, 2, 3],
      dim: [4, 5, 6],
      bright: [7, 8, 9],
      speedRaw: 5,
      reverseSign: -1,
      seed: 42,
      intensityRaw: 3,
      x: 111,
      y: 222,
      windExposure: 60,
      windResponse: 1,
    };
    writeIlluminationValueSpan(arrays, 0, 2, values);
    ok(
      'aParams = (ratio, attenuationEased, exposure, expectedDepth)',
      arrays.aParams[0] === 25 && arrays.aParams[1] === 50 && arrays.aParams[2] === 10 && arrays.aParams[3] === 75
    );
    ok(
      'aColorA = (bg.r, bg.g, bg.b, dim.r)',
      arrays.aColorA[0] === 1 && arrays.aColorA[1] === 2 && arrays.aColorA[2] === 3 && arrays.aColorA[3] === 4
    );
    ok(
      'aColorB = (dim.g, dim.b, bright.r, bright.g)',
      arrays.aColorB[0] === 5 && arrays.aColorB[1] === 6 && arrays.aColorB[2] === 7 && arrays.aColorB[3] === 8
    );
    ok(
      'aColorC = (bright.b, 0, 0, 0) — three spares',
      arrays.aColorC[0] === 9 && arrays.aColorC[1] === 0 && arrays.aColorC[2] === 0 && arrays.aColorC[3] === 0
    );
    ok(
      'aAnim = (speedRaw, reverseSign, seed, intensityRaw)',
      arrays.aAnim[0] === 5 && arrays.aAnim[1] === -1 && arrays.aAnim[2] === 42 && arrays.aAnim[3] === 3
    );
    ok(
      "aWind = (origin.x, origin.y, windExposure, windResponse) — wind centre IS the light's own (x,y), no separate field",
      arrays.aWind[0] === 111 && arrays.aWind[1] === 222 && arrays.aWind[2] === 60 && arrays.aWind[3] === 1
    );
    ok(
      'the SAME values are broadcast to vertex 1 (count=2) — every vertex of one light shares its value',
      arrays.aParams[4] === 25 && arrays.aColorA[4] === 1 && arrays.aAnim[4] === 5 && arrays.aWind[4] === 111
    );
  }
  {
    // A plain (no anim, no wind) bucket's caller only allocates the 6
    // always-present buffers — aAnim/aWind absent from `arrays` must not be
    // read (values would be `undefined`, and a guard-less write would stamp
    // NaN into a buffer that does not exist — this proves it never tries).
    const arrays = {
      aParams: new Float32Array(4),
      aColorA: new Float32Array(4),
      aColorB: new Float32Array(4),
      aColorC: new Float32Array(4),
    };
    let threw = false;
    try {
      writeIlluminationValueSpan(arrays, 0, 1, {
        ratio: 1,
        attenuationEased: 1,
        exposure: 1,
        expectedDepth: 1,
        bg: [0, 0, 0],
        dim: [0, 0, 0],
        bright: [0, 0, 0],
      });
    } catch {
      threw = true;
    }
    ok('a plain bucket with no aAnim/aWind buffers writes cleanly', threw === false);
  }

  // ==========================================================================
  // writeColorationValueSpan — design doc §3.3's coloration byte layout
  // ==========================================================================
  {
    const arrays = { aParams: new Float32Array(4), aLightColor: new Float32Array(4) };
    // Integers, not decimals — see the illumination block's own comment
    // above for why (float32 round-trip vs. `===` against a JS double).
    writeColorationValueSpan(arrays, 0, 1, {
      attenuationEased: 33,
      colorationAlpha: 66,
      expectedDepth: 99,
      ratio: 12, // present on the value object (illumination shares this shape) but must NOT land in aParams.w
      lightColor: [5, 6, 7],
    });
    ok(
      'aParams = (attenuationEased, colorationAlpha, expectedDepth, SPARE) — never ratio',
      arrays.aParams[0] === 33 && arrays.aParams[1] === 66 && arrays.aParams[2] === 99 && arrays.aParams[3] === 0
    );
    ok(
      'aLightColor = (r, g, b, spare)',
      arrays.aLightColor[0] === 5 &&
        arrays.aLightColor[1] === 6 &&
        arrays.aLightColor[2] === 7 &&
        arrays.aLightColor[3] === 0
    );
  }
  {
    // Two lights packed back-to-back (start=0 count=1, then start=1 count=1)
    // must not bleed into each other — the exact multi-light span scenario
    // production actually exercises.
    const arrays = { aParams: new Float32Array(2 * 4), aLightColor: new Float32Array(2 * 4) };
    writeColorationValueSpan(arrays, 0, 1, {
      attenuationEased: 1,
      colorationAlpha: 1,
      expectedDepth: 1,
      ratio: 0,
      lightColor: [1, 0, 0],
    });
    writeColorationValueSpan(arrays, 1, 1, {
      attenuationEased: 2,
      colorationAlpha: 2,
      expectedDepth: 2,
      ratio: 0,
      lightColor: [0, 1, 0],
    });
    ok(
      'light 0´s span is untouched by light 1´s write',
      arrays.aParams[0] === 1 && arrays.aLightColor[0] === 1 && arrays.aLightColor[1] === 0
    );
    ok(
      'light 1´s span landed at its own offset, not overwriting light 0',
      arrays.aParams[4] === 2 && arrays.aLightColor[4] === 0 && arrays.aLightColor[5] === 1
    );
  }
}
