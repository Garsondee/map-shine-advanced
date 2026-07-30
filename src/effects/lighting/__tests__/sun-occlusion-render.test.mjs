/**
 * sun-occlusion-render.test.mjs — THE TSL GRAPH IS ACTUALLY CONSTRUCTED, IN NODE.
 *
 * Same doctrine as `specular/__tests__/specular-render.test.mjs`
 * (`keyhole-tsl-constructs-in-node`): every OTHER suite in this effect is pure
 * arithmetic over `sun-occlusion.js`'s CPU twin and never once calls the
 * builder this file wraps. Round Seven rewrote the whole per-station loop
 * (a new uniform, three renamed packing functions, a dual column/band test) —
 * exactly the kind of edit that can typo a TSL export name, reference a
 * variable before its `const` runs, or call a swizzle that does not exist,
 * none of which any arithmetic-only suite would ever see.
 *
 * WHAT THIS PROVES: the graph constructs without throwing. WHAT IT DOES NOT
 * PROVE: anything about WGSL codegen or the on-screen look — that is what the
 * author's own live verification is for.
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import { buildSunShadowBakeMaterial, buildSunVisibilityNode } from '../sun-occlusion-render.js';

/** A 1×1 RGBA texture — enough for a node to reference; never sampled here. */
function stubCasterTexture() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
}

export function run(t) {
  const { ok } = t;

  // ── THE BAKE MATERIAL — the regression this file exists to catch ────────
  let built = null;
  let buildError = null;
  try {
    built = buildSunShadowBakeMaterial({ THREE, casterTexture: stubCasterTexture(), steps: 24, lateralTaps: 3 });
  } catch (err) {
    buildError = err;
  }
  ok(
    `the bake material CONSTRUCTS without throwing (${buildError ? buildError.message : 'clean'})`,
    buildError === null
  );
  if (!built) return; // everything below would cascade meaninglessly

  ok('it returns a real NodeMaterial', built.material?.isNodeMaterial === true);
  ok('it carries a fragmentNode — an empty material renders nothing, silently', !!built.material.fragmentNode);
  ok('it exposes the caster texture node', !!built.casterTexNode);

  // ── EVERY SETTER, CALLED — none of these run during construction, so a
  // typo inside one (the new `uBuildingHeightPx` path included) would pass
  // the check above and still be dead code with no test ever calling it.
  let setterError = null;
  try {
    built.setSun(197.575, 57.199, { dirX: -0.302, dirY: 0.953, tanElev: 3.1033, stepPx: 10.59 });
    built.setField({ heightScalePx: 2048, casterGridDimPx: 768, buildingHeightPx: 600 });
    built.setLook({ strength01: 0.55, softnessMul: 1, basePx: 2 });
    built.setRect({ minX: 3000, minY: 3000, maxX: 15000, maxY: 15000 });
    built.setEdgeBandPx(256);
  } catch (err) {
    setterError = err;
  }
  ok(
    `every setter runs clean (${setterError ? setterError.message : 'clean'}), incl. the ROUND SEVEN buildingHeightPx path`,
    setterError === null
  );

  // `setField` omitting `buildingHeightPx`/`casterGridDimPx` (an older caller)
  // must not throw or write NaN over either uniform.
  let omittedError = null;
  try {
    built.setField({ heightScalePx: 2048 });
  } catch (err) {
    omittedError = err;
  }
  ok('setField without buildingHeightPx/casterGridDimPx is a no-op, not a throw', omittedError === null);

  // 🔒 THE REGRESSION THIS FILE WAS EXTENDED FOR (2026-07-30, live: Quality-tier
  // banding, Extreme-tier a mispositioned shadow — traced to `uCasterGridDim`
  // being fed from the bake's OUTPUT resolution instead of the CASTER
  // TEXTURE's own one). A caller still passing the OLD, wrong `fieldDim` key
  // must not throw either — it is simply an unrecognised destructured key now,
  // which this only proves is harmless, not that the uniform holds the right
  // value (this suite cannot read a live uniform back out; that is exactly why
  // the real regression was only ever caught on a real scene, not in Node).
  let staleKeyError = null;
  try {
    built.setField({ heightScalePx: 2048, fieldDim: 99999, buildingHeightPx: 600 });
  } catch (err) {
    staleKeyError = err;
  }
  ok('a caller still passing the OLD `fieldDim` key is ignored harmlessly, not a throw', staleKeyError === null);

  // ── A SECOND MATERIAL, WITH A DEGENERATE RUNG — tier 0's `lateralTaps: 1`
  // divides `TAP_SPACING_DIVISOR` by a clamped denominator; confirm that
  // path (not exercised by the tier-3-shaped build above) also constructs.
  let degenerateError = null;
  try {
    buildSunShadowBakeMaterial({ THREE, casterTexture: stubCasterTexture(), steps: 16, lateralTaps: 1 });
  } catch (err) {
    degenerateError = err;
  }
  ok(
    `a single-tap (lateralTaps=1) rung also constructs (${degenerateError ? degenerateError.message : 'clean'})`,
    degenerateError === null
  );

  // ── THE READ — the ambient-fill's own fetch, built independently ────────
  let readNode = null;
  let readError = null;
  try {
    const { uniform, vec4 } = THREE.TSL;
    readNode = buildSunVisibilityNode(THREE.TSL, {
      uViewRect: uniform(vec4(0, 0, 100, 100)),
      uShadowRect: uniform(vec4(0, 0, 100, 100)),
      shadowTexNode: built.casterTexNode,
    });
  } catch (err) {
    readError = err;
  }
  ok(
    `the visibility READ node constructs without throwing (${readError ? readError.message : 'clean'})`,
    readError === null
  );
  ok('it returns a node (not null) when a shadow texture is supplied', !!readNode);
  ok(
    'it returns null (compiled OUT) when no shadow texture is supplied — never a throw, never a bad fetch',
    buildSunVisibilityNode(THREE.TSL, { uViewRect: null, uShadowRect: null, shadowTexNode: null }) === null
  );
}
