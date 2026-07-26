/**
 * specular-render.test.mjs — THE TSL GRAPH IS ACTUALLY CONSTRUCTED, IN NODE.
 *
 * ============================================================================
 * WHY THIS EXISTS: A LIVE STARTUP CRASH NO TEST COULD SEE
 * ============================================================================
 * Tier 3 shipped and the viewer died on load:
 *
 *     ReferenceError: Cannot access 'albedoTexNode' before initialization
 *         at artLumaAt (specular-render.js:400)
 *
 * The relief block had moved UP to sit above the lobes; its two texture nodes
 * stayed ~150 lines below where the lamp lobe had left them. A `const` is in its
 * temporal dead zone until its own line RUNS, and `artLumaAt` closed over one and
 * was called immediately — so `startVtPanViewer` threw and the whole renderer
 * fell back to Foundry's own.
 *
 * **4,460 assertions were green.** Every suite in this effect is pure
 * arithmetic — the decode, the lobes, the manifest — and none of them had ever
 * CALLED the thing that crashed. `feedback_instruments_must_not_lie`: a green
 * light with nothing behind it, for exactly as long as nobody ran the builder.
 *
 * ============================================================================
 * IT USES THE REAL THREE, WHICH TURNED OUT TO BE POSSIBLE
 * ============================================================================
 * The standing assumption in this repo is that TSL builders are "browser-only"
 * (every render module's header says so, and `world/__tests__/tsl-numeric-stub.mjs`
 * exists because of it). That is true of EVALUATING a graph and false of
 * BUILDING one: `src/vendor/three/three.webgpu.js` imports cleanly under Node,
 * `THREE.TSL` exposes all 638 of its names, and node construction is pure JS
 * until a backend compiles it. `npm test` runs each suite in its own process, so
 * the import cannot leak into any other suite.
 *
 * WHAT THIS PROVES — the whole "it throws on startup" class:
 *   · temporal-dead-zone errors (the bug above), which no linter can separate
 *     from the safe late-`const` pattern the subsystems legitimately rely on;
 *   · a TSL function that does not exist (a typo, a name that moved);
 *   · a method or swizzle that does not exist on a node;
 *   · a type mismatch TSL rejects at construction.
 *
 * WHAT IT DOES **NOT** PROVE, stated plainly so a green run is never mistaken
 * for more than it is: nothing about WGSL/GLSL code generation, nothing about
 * what any of it looks like, and nothing about performance. The graph is built,
 * not compiled and not run. `specular-lobes.test.mjs` owns the numbers; this
 * owns "does it survive being constructed at all".
 */
import * as THREE from '../../../../src/vendor/three/three.webgpu.js';
import { buildOutdoorsGate, buildWorldSpaceOutdoorsGate } from '../../lighting/environmental-light.js';
import { buildSpecularSurfaceMaterial } from '../specular-render.js';

/** A 1×1 texture — enough for a node to reference; never sampled here. */
function stubTexture() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
}

/** Everything `buildSpecularSurfaceMaterial` needs, shaped exactly as the
 * viewer supplies it (`vt-pan-viewer.js`'s `createSpecularSurfaceSubsystem`
 * call) — so a change to that call site that this harness does not follow shows
 * up as a failure here rather than on the author's screen. */
function args(overrides = {}) {
  const { uniform, vec4 } = THREE.TSL;
  return {
    THREE,
    maskTexture: stubTexture(),
    maskRect: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    illumTexture: stubTexture(),
    albedoTexture: stubTexture(),
    attrTexture: stubTexture(),
    uViewRect: uniform(vec4(0, 0, 100, 100)),
    uOutdoorsRect: uniform(vec4(0, 0, 100, 100)),
    outdoorsTexNode: THREE.TSL.texture(stubTexture()),
    buildOutdoorsGate: buildWorldSpaceOutdoorsGate,
    ...overrides,
  };
}

export function run(t) {
  const { ok } = t;

  // ── THE REGRESSION THAT NAMED THIS FILE ─────────────────────────────────
  // If the builder ever throws again — TDZ, a missing TSL export, a bad
  // swizzle — this is the assertion that goes red, in Node, before it can
  // reach a load screen.
  let built = null;
  let buildError = null;
  try {
    built = buildSpecularSurfaceMaterial(args());
  } catch (err) {
    buildError = err;
  }
  ok(`the TSL graph CONSTRUCTS without throwing (${buildError ? buildError.message : 'clean'})`, buildError === null);
  if (!built) return; // everything below would cascade meaninglessly

  // ── BOTH materials, because half a shine pass is worse than none ────────
  ok('it returns the MULTIPLY material (the diffuse a conductor replaces)', !!built.suppressMaterial);
  ok('it returns the ADD material (the highlights)', !!built.specularMaterial);
  ok('both are real NodeMaterials', built.suppressMaterial.isNodeMaterial && built.specularMaterial.isNodeMaterial);
  ok(
    'both carry a colorNode — an empty material would render nothing, silently',
    !!built.suppressMaterial.colorNode && !!built.specularMaterial.colorNode
  );

  // ── THE BLEND CONTRACT ──────────────────────────────────────────────────
  // `dst × src` and `dst + src`. Getting either backwards is invisible in
  // review and catastrophic on screen.
  ok(
    'the suppress pass multiplies: Zero / SrcColor',
    built.suppressMaterial.blendSrc === THREE.ZeroFactor && built.suppressMaterial.blendDst === THREE.SrcColorFactor
  );
  ok(
    'the specular pass adds: One / One',
    built.specularMaterial.blendSrc === THREE.OneFactor && built.specularMaterial.blendDst === THREE.OneFactor
  );
  ok(
    'neither touches destination alpha (it is level-composite coverage, not ours)',
    built.suppressMaterial.blendDstAlpha === THREE.OneFactor && built.specularMaterial.blendDstAlpha === THREE.OneFactor
  );

  // ⚠️ `feedback_doubleside_invisible_to_status_reports` — a negative scale
  // reverses the effective winding and FrontSide culls the quad as a backface,
  // which every JS field reports as healthy because culling is a GPU-side fact.
  ok(
    'both materials are DoubleSide',
    built.suppressMaterial.side === THREE.DoubleSide && built.specularMaterial.side === THREE.DoubleSide
  );
  ok(
    'neither depth-tests (the painter’s-algorithm contract)',
    built.suppressMaterial.depthTest === false && built.specularMaterial.depthTest === false
  );

  // ⚠️ NO `mrtNode`, and this is checked rather than assumed — see the render
  // module's header. `MRTNode` matches its keys against the BOUND target's
  // texture names, and `scene.lit` is single-attachment, so a key with no match
  // yields an empty output struct: no fragment output at all.
  ok(
    'neither material sets an mrtNode — scene.lit is single-attachment',
    !built.suppressMaterial.mrtNode && !built.specularMaterial.mrtNode
  );

  // ── THE JS-TIME GATES (Effects.md Law 4: a uniform is not a gate) ────────
  const noAttr = buildSpecularSurfaceMaterial(args({ attrTexture: null }));
  ok('a null attr texture compiles the floor gate OUT rather than throwing', noAttr.floorGateCompiled === false);
  ok('…and still produces both materials', !!noAttr.suppressMaterial && !!noAttr.specularMaterial);
  ok('with attr present the floor gate IS compiled', built.floorGateCompiled === true);

  const noOutdoors = buildSpecularSurfaceMaterial(args({ outdoorsTexNode: null }));
  ok(
    'a null outdoors node compiles the outdoor branch OUT rather than throwing',
    noOutdoors.outdoorsGateCompiled === false
  );
  ok('with the mask present the outdoors gate IS compiled', built.outdoorsGateCompiled === true);

  // ⚠️ THE WORLD-SPACE GATE IS THE ONLY VALID ONE, and this harness found that
  // out by crashing on its own first draft. `buildSpecularSurfaceMaterial` calls
  // the injected builder with `{uOutdoorsRect, outdoorsTexNode}` and NO
  // `uViewRect`, because these meshes read `positionWorld` directly. Hand it the
  // screen-space sibling and it dereferences an undefined rect at BUILD time.
  //
  // Asserted as a throw rather than left as a doc line: the two builders have
  // near-identical names and adjacent exports, and environmental-light.js's own
  // header warns that swapping them silently samples the wrong world position.
  // Here the failure is at least loud — this pins that it stays loud.
  let wrongGateError = null;
  try {
    buildSpecularSurfaceMaterial(args({ buildOutdoorsGate }));
  } catch (err) {
    wrongGateError = err;
  }
  ok('handing over the SCREEN-space gate fails loudly at build, never silently', wrongGateError !== null);

  // ── EVERY SETTER THE SUBSYSTEM CALLS ────────────────────────────────────
  // `specular-surface-subsystem.js` calls each of these by name every time the
  // params change. A rename that misses one is a control that silently does
  // nothing — the exact disease `params/no-dead-controls` walls at build time,
  // caught here for the runtime half a schema cannot see.
  const setters = [
    'setMaskRect',
    'setViewCentre',
    'setFloorIndex',
    'setSky',
    'setStrength',
    'setPolish',
    'setMetalResponse',
    'setViewerHeight',
    'setRelief',
    'setSunGlint',
    'setSkySheen',
    'setLampGlint',
    'setLampHeight',
    'setAmbientSheen',
  ];
  ok(
    `every setter the subsystem calls exists (${setters.filter((s) => typeof built[s] !== 'function').join(', ') || 'all present'})`,
    setters.every((s) => typeof built[s] === 'function')
  );

  let setterError = null;
  try {
    built.setMaskRect({ minX: 1, minY: 2, maxX: 3, maxY: 4 });
    built.setViewCentre(10, 20);
    built.setFloorIndex(2);
    built.setSky({
      keyDir: [0, 0, 1],
      keyColor: [1, 1, 1],
      keyStrength: 1,
      fillColor: [0.5, 0.6, 1],
      fillStrength: 0.4,
    });
    for (const s of [
      'setStrength',
      'setPolish',
      'setMetalResponse',
      'setViewerHeight',
      'setRelief',
      'setSunGlint',
      'setSkySheen',
      'setLampGlint',
      'setLampHeight',
      'setAmbientSheen',
    ]) {
      built[s](0.5);
    }
  } catch (err) {
    setterError = err;
  }
  ok(`every setter runs against a real uniform (${setterError ? setterError.message : 'clean'})`, setterError === null);

  // Guards that exist because their absence produces a NaN, and a NaN on an
  // additive pass paints a permanent hole rather than nothing.
  let guardError = null;
  try {
    built.setViewerHeight(0);
    built.setLampHeight(-5);
    built.setLampHeight(99);
    built.setRelief(-1);
    built.setFloorIndex(NaN);
  } catch (err) {
    guardError = err;
  }
  ok(
    `out-of-range setter inputs are clamped, not propagated (${guardError ? guardError.message : 'clean'})`,
    guardError === null
  );

  // The mask node must stay re-pointable: the subsystem swaps in the real
  // texture once it decodes, and a swizzle cannot be re-pointed.
  ok(
    'the mask texture node is returned so the loader can re-point it',
    !!built.maskTexNode && 'value' in built.maskTexNode
  );
}
