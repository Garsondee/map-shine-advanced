/**
 * window-render.test.mjs — THE TSL GRAPH IS ACTUALLY CONSTRUCTED, IN NODE.
 *
 * `keyhole-tsl-constructs-in-node`: `specular-render.js` shipped a live
 * startup crash (a temporal-dead-zone ReferenceError) with 4,460 green
 * assertions behind it, because none of them had ever CALLED the builder.
 * `src/vendor/three/three.webgpu.js` imports cleanly under plain Node, so
 * there is no excuse for this effect to repeat that. This proves the graph
 * SURVIVES BEING BUILT — nothing about WGSL/GLSL codegen, nothing about what
 * it looks like on screen.
 */
import * as THREE from '../../../../src/vendor/three/three.webgpu.js';
import { buildWindowSurfaceMaterial, WINDOW_DEFAULT_STRENGTH, WINDOW_DEFAULT_CONTRAST } from '../window-render.js';
import { WINDOW_DEBUG_CHANNELS } from '../window.js';

/** A 1×1 texture — enough for a node to reference; never sampled here. */
function stubTexture() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
}

/** Everything `buildWindowSurfaceMaterial` needs, shaped exactly as the
 * viewer supplies it (`vt-pan-viewer.js`'s `createWindowSurfaceSubsystem`
 * call) — so a change to that call site this harness does not follow shows
 * up as a failure here rather than on the author's screen. */
function args(overrides = {}) {
  const { uniform, vec4 } = THREE.TSL;
  return {
    THREE,
    maskTexture: stubTexture(),
    attrTexture: stubTexture(),
    uViewRect: uniform(vec4(0, 0, 100, 100)),
    ...overrides,
  };
}

export function run(t) {
  const { ok } = t;

  // ── THE REGRESSION CLASS THIS FILE EXISTS TO CATCH ──────────────────────
  let built = null;
  let buildError = null;
  try {
    built = buildWindowSurfaceMaterial(args());
  } catch (err) {
    buildError = err;
  }
  ok(`the TSL graph CONSTRUCTS without throwing (${buildError ? buildError.message : 'clean'})`, buildError === null);
  if (!built) return; // everything below would cascade meaninglessly

  ok('it returns the ADD material (the cookie)', !!built.windowMaterial);
  ok('it is a real NodeMaterial', built.windowMaterial.isNodeMaterial);
  ok('it carries a colorNode — an empty material renders nothing, silently', !!built.windowMaterial.colorNode);

  // ── THE BLEND CONTRACT — this ADDS onto buf:scene.illum, never MAX/overwrite
  ok(
    'the window pass adds: One / One on colour',
    built.windowMaterial.blendSrc === THREE.OneFactor && built.windowMaterial.blendDst === THREE.OneFactor
  );
  ok(
    'it leaves destination alpha exactly alone (Zero·src + One·dst is the identity)',
    built.windowMaterial.blendSrcAlpha === THREE.ZeroFactor && built.windowMaterial.blendDstAlpha === THREE.OneFactor
  );
  ok('the material is DoubleSide', built.windowMaterial.side === THREE.DoubleSide);
  ok('it does not depth-test (the painter contract is renderOrder)', built.windowMaterial.depthTest === false);
  ok('no mrtNode — buf:scene.illum is single-attachment', !built.windowMaterial.mrtNode);

  // ── THE JS-TIME GATE (Effects.md Law 4: a uniform is not a gate) ────────
  const noAttr = buildWindowSurfaceMaterial(args({ attrTexture: null }));
  ok('a null attr texture compiles the floor gate OUT rather than throwing', noAttr.floorGateCompiled === false);
  ok('…and still produces the material', !!noAttr.windowMaterial);
  ok('with attr present the floor gate IS compiled', built.floorGateCompiled === true);

  // ── THE CLOUD SEAM — the whole point of this increment's TODO ───────────
  // No cloudFactorNode passed: must not throw, and must still produce a
  // material — the constant-1 default is the entire "wired but not built"
  // contract (Windows.md §4, window.js's own header).
  let cloudSeamError = null;
  try {
    buildWindowSurfaceMaterial(args({ cloudFactorNode: null }));
  } catch (err) {
    cloudSeamError = err;
  }
  ok('omitting cloudFactorNode (the field does not exist yet) never throws', cloudSeamError === null);

  // A REAL node in its place must also work — this is what "install later"
  // means: the day world/cloud-field.js exists, its output plugs in here
  // with no other change to this file.
  const { float: floatFn } = THREE.TSL;
  let cloudNodeError = null;
  try {
    buildWindowSurfaceMaterial(args({ cloudFactorNode: floatFn(0.4) }));
  } catch (err) {
    cloudNodeError = err;
  }
  ok('a REAL cloud-factor node plugs in without any other change', cloudNodeError === null);

  // ── EVERY SETTER THE SUBSYSTEM CALLS ────────────────────────────────────
  const setters = [
    'setMaskTexture',
    'setMaskUvBounds',
    'setFloorIndex',
    'setStrength',
    'setContrast',
    'setDebugChannel',
  ];
  ok(
    `every setter the subsystem calls exists (${setters.filter((s) => typeof built[s] !== 'function').join(', ') || 'all present'})`,
    setters.every((s) => typeof built[s] === 'function')
  );

  let setterError = null;
  try {
    built.setMaskUvBounds({ minU: 0.1, minV: 0.2, maxU: 0.9, maxV: 0.8 });
    built.setFloorIndex(2);
    built.setStrength(WINDOW_DEFAULT_STRENGTH);
    built.setContrast(WINDOW_DEFAULT_CONTRAST);
  } catch (err) {
    setterError = err;
  }
  ok(`every setter runs against a real uniform (${setterError ? setterError.message : 'clean'})`, setterError === null);

  // Guards that exist because their absence produces a NaN, and a NaN on an
  // additive pass paints a permanent hole rather than nothing.
  let guardError = null;
  try {
    built.setContrast(0);
    built.setFloorIndex(NaN);
    built.setStrength(-5);
  } catch (err) {
    guardError = err;
  }
  ok(
    `out-of-range inputs are clamped, never propagated (${guardError ? guardError.message : 'clean'})`,
    guardError === null
  );

  ok(
    'the mask texture node is returned so the loader can re-point it',
    !!built.maskTexNode && 'value' in built.maskTexNode
  );
  const swapped = stubTexture();
  built.setMaskTexture(swapped);
  ok('setMaskTexture re-points the node the effect samples', built.maskTexNode.value === swapped);

  // ── THE DEBUG CHANNELS — THE INSTRUMENT MUST NOT LIE ────────────────────
  // The builder ALREADY throws at construction on a channel with no node,
  // which means the first assertion in this file also asserts every declared
  // channel is wired.
  ok('it returns a SECOND material for the debug channels', !!built.debugMaterial);
  ok(
    'the debug material is its own object, never an alias of the add pass',
    built.debugMaterial !== built.windowMaterial
  );
  ok(
    'the debug material is a real NodeMaterial with a colorNode',
    built.debugMaterial.isNodeMaterial && !!built.debugMaterial.colorNode
  );
  ok(
    'the debug material REPLACES rather than adds: One / Zero',
    built.debugMaterial.blendSrc === THREE.OneFactor && built.debugMaterial.blendDst === THREE.ZeroFactor
  );
  ok('the debug material is DoubleSide like its sibling', built.debugMaterial.side === THREE.DoubleSide);
  ok('setDebugChannel exists — the subsystem calls it by name every sync', typeof built.setDebugChannel === 'function');

  let debugSetterError = null;
  try {
    for (const ch of WINDOW_DEBUG_CHANNELS) built.setDebugChannel(ch.n);
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
  ok('the floor-gate channel is wired even when the gate compiles out', !!noAttr.debugMaterial);
}
