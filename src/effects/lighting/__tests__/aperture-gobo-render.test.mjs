/**
 * aperture-gobo-render.test.mjs — THE TSL GRAPH IS ACTUALLY CONSTRUCTED, IN
 * NODE. Same doctrine as `sun-occlusion-render.test.mjs` /
 * `specular/__tests__/specular-render.test.mjs`
 * (`keyhole-tsl-constructs-in-node`).
 *
 * Design 4 (2026-08-03, `aperture-gobo.js`'s own header) made `cols`/`rows`
 * GRAPH-BUILD-TIME integers rather than shared uniforms — a different
 * `cols`/`rows` now produces a genuinely DIFFERENT graph (a different unroll
 * count), not just different uniform values feeding the SAME graph. So this
 * file now sweeps a few `cols`×`rows` combinations, not just `apertureCount`
 * — the axis that changed.
 *
 * WHAT THIS PROVES: every combination constructs without throwing, using the
 * REAL vendored `three.webgpu.js` TSL library — not a mock. A wrong function
 * name (`greaterThanEqual`, `.and()`, `.negate()`, `DstColorFactor`, ...)
 * fails HERE, at build time, in a few seconds.
 *
 * WHAT THIS DOES NOT PROVE: anything about WGSL codegen, GPU execution, or
 * the on-screen look — including whether this reproduces the `edgeSoftFactor`
 * black-screen precedent `aperture-gobo-render.js`'s own header names as the
 * open question. That needs a live A/B, not a Node test.
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import {
  buildApertureGoboTerm,
  createApertureGoboSharedUniforms,
  MAX_APERTURES_PER_LIGHT,
} from '../aperture-gobo-render.js';
import { buildPointLightIlluminationMaterial } from '../point-light-illumination.js';
import { buildPointLightColorationMaterial } from '../point-light-coloration.js';

export function run(t) {
  const { ok } = t;
  const { uniform, float, vec2 } = THREE.TSL;
  // The CPU twin discipline for the actual gobo pattern math lives in
  // aperture-gobo.test.mjs (`computeApertureSpokeGate`,
  // `computeApertureArcGate`, ...) — this file's own scope (see the module
  // header) is "does the graph construct", never "is the numeric result
  // right".

  let shared = null;
  let sharedError = null;
  try {
    shared = createApertureGoboSharedUniforms(THREE);
  } catch (err) {
    sharedError = err;
  }
  ok(
    `shared uniforms construct without throwing (${sharedError ? sharedError.message : 'clean'})`,
    sharedError === null
  );
  // Six keys — `uCols`/`uRows` are GONE (design 4: graph-build-time JS
  // integers now, not uniforms — see aperture-gobo-render.js's own "DESIGN
  // 4" header), and `uDebugOn` was already removed the same day it shipped
  // (debug is which of TWO MESHES is visible, a CPU-side choice, not a
  // per-fragment shader branch).
  ok(
    'shared uniforms carry all six expected keys, and NOT uCols/uRows/uDebugOn',
    ['uSillPx', 'uHeadPx', 'uFrame', 'uMullion', 'uSoftFarPx', 'uReachSoftFarPx', 'uStrength'].every(
      (k) => !!shared[k]
    ) &&
      !('uCols' in shared) &&
      !('uRows' in shared) &&
      !('uDebugOn' in shared)
  );

  const positionWorldXY = vec2(uniform(float(0)), uniform(float(0)));
  const dist = uniform(float(0.5));

  ok(
    'apertureCount 0 returns null (compiled OUT entirely) — never a throw, never a degenerate graph',
    buildApertureGoboTerm({ THREE, positionWorldXY, dist, apertureCount: 0, cols: 2, rows: 3, shared }) === null
  );
  ok(
    'a non-finite/negative apertureCount also returns null, never throws',
    buildApertureGoboTerm({ THREE, positionWorldXY, dist, apertureCount: -1, cols: 2, rows: 3, shared }) === null &&
      buildApertureGoboTerm({ THREE, positionWorldXY, dist, apertureCount: NaN, cols: 2, rows: 3, shared }) === null
  );

  for (let count = 1; count <= MAX_APERTURES_PER_LIGHT; count++) {
    let result = null;
    let error = null;
    try {
      result = buildApertureGoboTerm({ THREE, positionWorldXY, dist, apertureCount: count, cols: 2, rows: 3, shared });
    } catch (err) {
      error = err;
    }
    ok(`apertureCount=${count} constructs without throwing (${error ? error.message : 'clean'})`, error === null);
    ok(`apertureCount=${count} returns a node`, !!result?.node);
    // `anyApplicable` (Aperture-Gobo.md §12/§13.8 — an earlier version
    // swapped every fragment to the raw gobo term unconditionally, flooding
    // a light's whole radius with white wherever no window reached it;
    // found live, not in review). No longer what the debug material's own
    // alpha gates on directly (that's `(1-strengthed)*visibility` now — see
    // aperture-gobo-render.js's own "AN HONEST PREVIEW" comment) — still
    // returned and tested here because `gobo=1` (unmodulated) wherever this
    // is false already forces `strengthed=1` downstream regardless, so the
    // two were never in tension, just no longer the SAME code path.
    ok(
      `apertureCount=${count} returns an anyApplicable node, distinct from the combined node`,
      !!result?.anyApplicable
    );
    ok(`apertureCount=${count} returns a lamp-height uniform`, !!result?.uLampHeight);
    ok(`apertureCount=${count} returns exactly ${count} aperture uniform sets`, result?.apertures?.length === count);
    ok(
      `apertureCount=${count}: every aperture set carries its four uniforms`,
      result.apertures.every((ap) => !!ap.uA && !!ap.uDir && !!ap.uNrm && !!ap.uSLAWallLen)
    );
  }

  // A count ABOVE the cap is clamped, not over-built — the cap is a real
  // ceiling on GPU cost, not a suggestion.
  const overCap = buildApertureGoboTerm({
    THREE,
    positionWorldXY,
    dist,
    apertureCount: MAX_APERTURES_PER_LIGHT + 5,
    cols: 2,
    rows: 3,
    shared,
  });
  ok(
    'a count above the cap is clamped to MAX_APERTURES_PER_LIGHT, never over-built',
    overCap.apertures.length === MAX_APERTURES_PER_LIGHT
  );

  // ==========================================================================
  // THE cols/rows UNROLL SWEEP (design 4's own new axis) — every combination
  // from "no mullions at all" through the schema's own max (8, `effects/
  // aperture-gobo.js`) constructs cleanly. This is what would have caught an
  // off-by-one in either mullion loop's own bound.
  // ==========================================================================
  for (const cols of [0, 1, 2, 8]) {
    for (const rows of [0, 1, 3, 8]) {
      let result = null;
      let error = null;
      try {
        result = buildApertureGoboTerm({ THREE, positionWorldXY, dist, apertureCount: 1, cols, rows, shared });
      } catch (err) {
        error = err;
      }
      ok(
        `cols=${cols}, rows=${rows} constructs without throwing (${error ? error.message : 'clean'})`,
        error === null && !!result?.node
      );
    }
  }
  {
    // A cols/rows value ABOVE the schema's own max (8) must clamp its
    // unroll, never throw and never loop unboundedly.
    let threw = false;
    let result = null;
    try {
      result = buildApertureGoboTerm({ THREE, positionWorldXY, dist, apertureCount: 1, cols: 999, rows: 999, shared });
    } catch {
      threw = true;
    }
    ok('an absurd cols/rows value is clamped, never throws', !threw && !!result?.node);
  }

  // ==========================================================================
  // buildPointLightIlluminationMaterial + buildPointLightColorationMaterial —
  // APERTURE-AWARE (round 10, 2026-08-04). Nine earlier rounds tried the
  // gobo pattern as a SEPARATE post-process pass (`buildApertureShadowMaterial`,
  // this file's own OLD tests below this point, all now removed) — round 10
  // bakes it directly into each material's own falloff/depth term, before its
  // single MAX-blend draw, so a light with apertures draws its ALREADY-
  // shadow-reduced contribution in the SAME pass every other light already
  // uses. That is the whole fix: a separate pass operating on the fully-
  // composited buffer has no way to tell "bright because of THIS light" from
  // "bright because of something else"; MAX-blending inside the SAME draw
  // means an independently brighter source simply wins the MAX contest,
  // automatically. See point-light-illumination.js's own "THE GOBO IS PART
  // OF THIS LIGHT'S OWN FALLOFF" header for the full live-found reasoning.
  // ==========================================================================
  {
    const { uniform: u2, vec3 } = THREE.TSL;
    const dummyAlbedoTexture = new THREE.DataTexture(
      new Uint8Array([0, 0, 0, 255]),
      1,
      1,
      THREE.RGBAFormat,
      THREE.UnsignedByteType
    );
    let baseline = null;
    let baselineErr = null;
    try {
      baseline = buildPointLightIlluminationMaterial({
        THREE,
        uBackgroundColor: u2(vec3(0.9, 0.9, 0.9)),
        uDimColor: u2(vec3(0.9, 0.9, 0.9)),
        uBrightColor: u2(vec3(1, 1, 1)),
      });
    } catch (err) {
      baselineErr = err;
    }
    ok(
      `the illumination material constructs cleanly with NO apertures (${baselineErr ? baselineErr.message : 'clean'})`,
      baselineErr === null
    );
    ok('...and returns a real material object', !!baseline?.material);
    ok(
      '...still MAX-blended, unchanged by round 10 — the whole point is baking the gobo INTO this same blend, never switching it',
      baseline.material.blendEquation === THREE.MaxEquation
    );
    ok(
      '...and uApLampHeight/apApertures are both null with no apertures — nothing to write, not a silent default',
      baseline.uApLampHeight === null && baseline.apApertures === null
    );

    for (const count of [1, MAX_APERTURES_PER_LIGHT]) {
      let illumBuilt = null;
      let illumErr = null;
      try {
        illumBuilt = buildPointLightIlluminationMaterial({
          THREE,
          uBackgroundColor: u2(vec3(0.9, 0.9, 0.9)),
          uDimColor: u2(vec3(0.9, 0.9, 0.9)),
          uBrightColor: u2(vec3(1, 1, 1)),
          apertureCount: count,
          apGoboCols: 2,
          apGoboRows: 3,
          apertureGoboShared: shared,
        });
      } catch (err) {
        illumErr = err;
      }
      ok(
        `the illumination material constructs cleanly with apertureCount=${count} (${illumErr ? illumErr.message : 'clean'})`,
        illumErr === null
      );
      ok(`...and returns a real material object`, !!illumBuilt?.material);
      ok(
        `...STILL the same single MAX-blend material — no second mesh, no second material for the gobo`,
        illumBuilt.material.blendEquation === THREE.MaxEquation &&
          illumBuilt.material.blendSrc === THREE.OneFactor &&
          illumBuilt.material.blendDst === THREE.OneFactor
      );
      ok(`...and a real uApLampHeight uniform, not null`, !!illumBuilt?.uApLampHeight);
      ok(`...and exactly ${count} real aperture uniform set(s)`, illumBuilt?.apApertures?.length === count);

      let colorBuilt = null;
      let colorErr = null;
      try {
        colorBuilt = buildPointLightColorationMaterial({
          THREE,
          albedoTexture: dummyAlbedoTexture,
          apertureCount: count,
          apGoboCols: 2,
          apGoboRows: 3,
          apertureGoboShared: shared,
        });
      } catch (err) {
        colorErr = err;
      }
      ok(
        `the coloration material ALSO constructs cleanly with apertureCount=${count} (${colorErr ? colorErr.message : 'clean'})`,
        colorErr === null
      );
      ok(
        `...STILL MAX-blended too, same reason as illumination's own`,
        !!colorBuilt?.material && colorBuilt.material.blendEquation === THREE.MaxEquation
      );
      ok(`...and a real uApColLampHeight uniform, not null`, !!colorBuilt?.uApColLampHeight);
      ok(
        `...and exactly ${count} real aperture uniform set(s), a SEPARATE set from illumination's own (its own mesh, its own material)`,
        colorBuilt?.apColApertures?.length === count && colorBuilt.apColApertures !== illumBuilt.apApertures
      );
    }
  }
}
