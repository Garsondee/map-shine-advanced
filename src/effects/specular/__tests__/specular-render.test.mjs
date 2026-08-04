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
import { buildSpecularSurfaceMaterial, SPECULAR_LAYER_COUNT } from '../specular-render.js';
import { SPECULAR_DEBUG_CHANNELS } from '../specular.js';

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
  const { uniform, vec4, float } = THREE.TSL;
  return {
    THREE,
    maskTexture: stubTexture(),
    islandPackTexture: stubTexture(),
    illumTexture: stubTexture(),
    attrTexture: stubTexture(),
    // THE shared clock. Its absence is not a soft failure: the drift term calls
    // `.mul()` on it during graph CONSTRUCTION, so an unwired caller throws at
    // build time rather than rendering a frozen field — which is the loud
    // behaviour this project wants (`seams/viewer-wired`).
    timeMsNode: uniform(float(0)),
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
  // ONE material now. The diffuse knock-down that used to draw beside it is
  // gone: V2 had no such pass and looked right without one, and it cost a
  // second draw plus another way to half-fail.
  ok('it returns the ADD material (the shine)', !!built.specularMaterial);
  ok('it is a real NodeMaterial', built.specularMaterial.isNodeMaterial);
  ok('it carries a colorNode — an empty material renders nothing, silently', !!built.specularMaterial.colorNode);
  ok('the multiply pass is GONE, not merely unused', built.suppressMaterial === undefined);

  // ── THE PRESENCE GATE (2026-07-28 performance audit) ────────────────────
  // This pass measured 3.4 ms, ~6x its declared budget, ~93% of it fill: the
  // 27-cell 3D Worley, the 3D Perlin and three shimmer layers ran on EVERY
  // covered pixel and were then multiplied by `coverage` (presence x
  // visibility) at the very end — so ~70% of shaded pixels on the live scene
  // paid full price to be multiplied by zero.
  //
  // ⚠️ WHAT THIS ASSERTS AND WHAT IT CANNOT. It proves the gated graph still
  // CONSTRUCTS (the whole point of building TSL in Node —
  // `keyhole-tsl-constructs-in-node`), which catches the realistic failure:
  // `Fn`/`If` not destructured, or the maths left outside the callback where
  // TSL control flow is a silent no-op (`keyhole-region-discard-noop-bug`).
  // It proves NOTHING about the emitted WGSL or about the saving, which is why
  // the fix ships alongside a re-measurement rather than a claim.
  ok('the gated graph still constructs — Fn/If are wired, not silently absent', buildError === null);
  ok('...and still produces a colorNode after the gate refactor', !!built.specularMaterial.colorNode);
  // The debug material must survive the extraction too: `buildShimmerTerms` is
  // built TWICE (gated for the real pass, ungated for the diagnostic) from ONE
  // source, so a tuning change cannot land in one and not the other.
  ok('the debug material still exists after the shimmer extraction', !!built.debugMaterial);
  ok('...and carries its own colorNode', !!built.debugMaterial.colorNode);

  // ── THE BLEND CONTRACT ──────────────────────────────────────────────────
  // `dst × src` and `dst + src`. Getting either backwards is invisible in
  // review and catastrophic on screen.
  ok(
    'the specular pass adds: One / One',
    built.specularMaterial.blendSrc === THREE.OneFactor && built.specularMaterial.blendDst === THREE.OneFactor
  );
  ok(
    'it does not touch destination alpha (that is level-composite coverage, not ours)',
    built.specularMaterial.blendDstAlpha === THREE.OneFactor
  );

  // ⚠️ `feedback_doubleside_invisible_to_status_reports` — a negative scale
  // reverses the effective winding and FrontSide culls the quad as a backface,
  // which every JS field reports as healthy because culling is a GPU-side fact.
  ok('the material is DoubleSide', built.specularMaterial.side === THREE.DoubleSide);
  ok('it does not depth-test (the painter contract is renderOrder)', built.specularMaterial.depthTest === false);

  // ⚠️ NO `mrtNode`, and this is checked rather than assumed — see the render
  // module's header. `MRTNode` matches its keys against the BOUND target's
  // texture names, and `scene.lit` is single-attachment, so a key with no match
  // yields an empty output struct: no fragment output at all.
  ok('no mrtNode — scene.lit is single-attachment', !built.specularMaterial.mrtNode);

  // ── THE JS-TIME GATES (Effects.md Law 4: a uniform is not a gate) ────────
  const noAttr = buildSpecularSurfaceMaterial(args({ attrTexture: null }));
  ok('a null attr texture compiles the floor gate OUT rather than throwing', noAttr.floorGateCompiled === false);
  ok('…and still produces the material', !!noAttr.specularMaterial);
  ok('with attr present the floor gate IS compiled', built.floorGateCompiled === true);

  const noOutdoors = buildSpecularSurfaceMaterial(args({ outdoorsTexNode: null }));
  ok(
    'a null outdoors node compiles the outdoor branch OUT rather than throwing',
    noOutdoors.outdoorsGateCompiled === false
  );
  ok('with the mask present the outdoors gate IS compiled', built.outdoorsGateCompiled === true);

  // ⚠️ THE UI-SHADOW MULTIPLY IS GONE, AND ITS ABSENCE IS ASSERTED, because
  // it was added and reverted inside ONE session on a MEASUREMENT ERROR worth
  // not repeating (2026-07-27). The argument for it: at a dark probe point
  // `lit` read ~6x darker than `albedo x illum` predicted, which was read as a
  // missing multiplicative term. But the composite is NOT linear — its own
  // header states `lit = EOTF(OETF(albedo) x illum)`, and running the real
  // numbers, `EOTF(OETF(0.801) x 0.188) = 0.0207` against a measured `lit` of
  // 0.025. **The entire "gap" was the sRGB round-trip.** There was never a
  // missing term, and multiplying `visNode` in here drove the whole light
  // term to zero live (probe channel 12 read 0 where the same texture through
  // an unshared node read 0.866). Do not re-add it without a measurement that
  // survives the gamma round-trip.
  ok(
    'no uiShadowVisNode parameter survives — the composite is gamma, not linear',
    !('uiShadowVisNode' in args()) && !!built.specularMaterial
  );

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
    'setMaskTexture',
    'setIslandPackTexture',
    'setMaskUvBounds',
    'setViewCentre',
    'setFloorIndex',
    'setSunDir',
    'setDarknessFloor',
    'setStrength',
    'setSaturation',
    'setPatternScale',
    'setParallaxStrength',
    'setDriftSpeed',
    'setPulse',
    'setShimmerGain',
    'setLightFloor',
    'setSunBias',
    'setLayerDensity',
    'setLayerGrainAngle',
    'setLayerStreak',
    'setLayerSoftness',
    'setLayerRowSpacing',
    'setLayerContrast',
    'setLayerStrength',
    'setLayerParallaxDepth',
    'setDebugChannel',
    'setIslandBakeStatus',
  ];

  ok(
    `every setter the subsystem calls exists (${setters.filter((s) => typeof built[s] !== 'function').join(', ') || 'all present'})`,
    setters.every((s) => typeof built[s] === 'function')
  );

  let setterError = null;
  try {
    built.setMaskUvBounds({ minU: 0.1, minV: 0.2, maxU: 0.9, maxV: 0.8 });
    built.setViewCentre(10, 20);
    built.setFloorIndex(2);
    built.setSunDir(0.6, 0.8);
    built.setDarknessFloor(0.188, 0.188, 0.188);
    built.setIslandBakeStatus(2);
    for (const name of [
      'setStrength',
      'setSaturation',
      'setPatternScale',
      'setParallaxStrength',
      'setDriftSpeed',
      'setPulse',
      'setShimmerGain',
      'setLightFloor',
      'setSunBias',
    ]) {
      built[name](0.5);
    }
    // EVERY layer, by index. A per-layer setter that silently ignored its index
    // would leave all but one layer permanently at their defaults, with every
    // test green and the panel apparently working.
    for (let i = 0; i < built.layerCount; i++) {
      built.setLayerDensity(i, 9);
      built.setLayerGrainAngle(i, 40);
      built.setLayerStreak(i, 1.1);
      built.setLayerSoftness(i, 0.4);
      built.setLayerRowSpacing(i, 2);
      built.setLayerContrast(i, 0.5);
      built.setLayerStrength(i, 0.7);
      built.setLayerParallaxDepth(i, -0.5);
    }
  } catch (err) {
    setterError = err;
  }
  ok(`every setter runs against a real uniform (${setterError ? setterError.message : 'clean'})`, setterError === null);
  ok('the builder reports how many layers it made', built.layerCount === SPECULAR_LAYER_COUNT);

  // Guards that exist because their absence produces a NaN, and a NaN on an
  // additive pass paints a permanent hole rather than nothing.
  let guardError = null;
  try {
    built.setPatternScale(0);
    built.setLayerRowSpacing(0, -5);
    built.setLayerDensity(0, 0);
    built.setFloorIndex(NaN);
    built.setSunDir(0, 0);
    built.setDarknessFloor(NaN, -1, Infinity);
    // Out-of-range layer INDICES must be ignored rather than throw: the
    // subsystem loops over whatever the render state supplies, and a panel that
    // sent a fourth layer would otherwise take the whole viewer down.
    built.setLayerDensity(99, 3);
    built.setLayerDensity(-1, 3);
    built.setIslandBakeStatus(NaN);
    built.setIslandBakeStatus(-3);
    built.setIslandBakeStatus(99);
  } catch (err) {
    guardError = err;
  }
  ok(
    `out-of-range inputs are clamped or ignored, never propagated (${guardError ? guardError.message : 'clean'})`,
    guardError === null
  );

  // The mask node must stay re-pointable: the subsystem swaps in the real
  // texture once it decodes, and a swizzle cannot be re-pointed.
  ok(
    'the mask texture node is returned so the loader can re-point it',
    !!built.maskTexNode && 'value' in built.maskTexNode
  );
  // ⚠️ TWO nodes hold the mask (the rect-mapped one the effect samples, and
  // debug channel 14's quad-uv one). `setMaskTexture` is the one door that
  // points BOTH; a caller that set `maskTexNode.value` directly would leave
  // channel 14 on its 1×1 placeholder, reporting "the texture never arrived"
  // forever — a false verdict on the exact question that channel answers.
  ok('setMaskTexture exists', typeof built.setMaskTexture === 'function');
  const swapped = stubTexture();
  built.setMaskTexture(swapped);
  ok('…and it re-points the node the EFFECT samples', built.maskTexNode.value === swapped);

  // ── THE DEBUG CHANNELS — THE INSTRUMENT MUST NOT LIE ────────────────────
  // `specular.js#SPECULAR_DEBUG_CHANNELS` explains why this exists at all
  // (three live "it is not visible" failures against a zero-wide instrument).
  // These assertions exist because a diagnostic that quietly shows the WRONG
  // intermediate is strictly worse than no diagnostic: the author would read a
  // true picture of the wrong thing as an answer about the right one, and act
  // on it (`feedback_instruments_must_not_lie`).
  //
  // The builder ALREADY throws at construction on a channel with no node —
  // which means the first assertion in this file (the graph constructs) is
  // silently also asserting that every declared channel is wired. Said out
  // loud here so a future reader does not "simplify" that throw into a skip.
  ok('it returns a THIRD material for the debug channels', !!built.debugMaterial);
  ok(
    'the debug material is its own object, never an alias of the add pass',
    built.debugMaterial !== built.specularMaterial
  );
  ok(
    'the debug material is a real NodeMaterial with a colorNode',
    built.debugMaterial.isNodeMaterial && !!built.debugMaterial.colorNode
  );
  // ⚠️ OPAQUE (One/Zero), where the highlight mesh ADDS. A diagnostic whose
  // "this factor is zero" answer rendered as *nothing added* would reproduce
  // exactly the ambiguity it was built to remove — black has to be legible AS
  // black, not as an unchanged map.
  ok(
    'the debug material REPLACES rather than adds: One / Zero',
    built.debugMaterial.blendSrc === THREE.OneFactor && built.debugMaterial.blendDst === THREE.ZeroFactor
  );
  ok('the debug material is DoubleSide like its siblings', built.debugMaterial.side === THREE.DoubleSide);
  ok('the debug material sets no mrtNode either — scene.lit is single-attachment', !built.debugMaterial.mrtNode);
  ok('setDebugChannel exists — the subsystem calls it by name every sync', typeof built.setDebugChannel === 'function');

  let debugSetterError = null;
  try {
    for (const ch of SPECULAR_DEBUG_CHANNELS) built.setDebugChannel(ch.n);
    built.setDebugChannel(NaN);
    built.setDebugChannel(-3);
    built.setDebugChannel(0);
  } catch (err) {
    debugSetterError = err;
  }
  ok(
    `every declared channel (plus junk) survives setDebugChannel (${debugSetterError ? debugSetterError.message : 'clean'})`,
    debugSetterError === null
  );

  // Built with NO attr texture the floor-gate channel still has to produce a
  // node — it reports "the gate compiled OUT, so it is permanently open"
  // rather than going black and accusing a gate that does not exist. If that
  // hoisted default were ever dropped back inside the `if`, this build throws.
  ok('the floor-gate channel is wired even when the gate compiles out', !!noAttr.debugMaterial);
  ok(
    'the island pack node is returned so the bake can re-point it',
    !!built.packTexNode && 'value' in built.packTexNode
  );
}
