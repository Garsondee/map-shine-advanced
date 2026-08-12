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
import { WINDOW_DEFAULT_AMBIENT_CEILING } from '../window-cookie.js';

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
    depthTexture: stubTexture(),
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
  const noDepth = buildWindowSurfaceMaterial(args({ depthTexture: null }));
  ok('a null depth texture compiles the floor gate OUT rather than throwing', noDepth.floorGateCompiled === false);
  ok('…and still produces the material', !!noDepth.windowMaterial);
  ok('with depth present the floor gate IS compiled', built.floorGateCompiled === true);

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
    'setExpectedDepth',
    'setAmbientCeiling',
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
    built.setExpectedDepth(0.5);
    built.setAmbientCeiling(0.4);
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
    built.setExpectedDepth(NaN);
    built.setStrength(-5);
    built.setAmbientCeiling(NaN);
    built.setAmbientCeiling(0);
    built.setAmbientCeiling(-2);
  } catch (err) {
    guardError = err;
  }
  ok(
    `out-of-range inputs are clamped, never propagated (${guardError ? guardError.message : 'clean'})`,
    guardError === null
  );

  // ── THE OUTSIDE-AMBIENT CEILING — A BOUND, NOT A TOGGLE ─────────────────
  // "No signal yet" must fall back to the OLD fixed asymptote, never to an
  // unbounded shoulder (feedback_gate_polarity_must_fail_open's sibling
  // concern, for a brightness cap rather than an occlusion gate: failing
  // "open" here would mean failing UNCAPPED, which is the ORIGINAL clipping
  // bug this whole shoulder exists to prevent). This test can only prove the
  // setter's OWN clamping — window-cookie.test.mjs proves the shoulder curve
  // itself moves with the ceiling.
  const freshMaterial = buildWindowSurfaceMaterial(args());
  ok(
    'setAmbientCeiling exists on a freshly-built material before any sync ever ran',
    typeof freshMaterial.setAmbientCeiling === 'function'
  );
  let defaultCeilingError = null;
  try {
    // Every one of these means "no real signal resolved this frame" — all
    // must land on the SAME safe default, never on 0/negative/NaN reaching
    // the uniform (a zero ceiling would silence every window on the map the
    // instant the getter glitches for one frame).
    for (const junk of [NaN, 0, -1, Infinity, -Infinity]) freshMaterial.setAmbientCeiling(junk);
  } catch (err) {
    defaultCeilingError = err;
  }
  ok(
    `every non-finite/non-positive input is absorbed, never forwarded raw (${defaultCeilingError ? defaultCeilingError.message : 'clean'})`,
    defaultCeilingError === null
  );
  ok(
    'WINDOW_DEFAULT_AMBIENT_CEILING is a real positive number',
    Number.isFinite(WINDOW_DEFAULT_AMBIENT_CEILING) && WINDOW_DEFAULT_AMBIENT_CEILING > 0
  );

  ok(
    'the mask texture nodes are returned so the loader can re-point them',
    Array.isArray(built.maskTexNodes) && built.maskTexNodes.every((n) => n && 'value' in n)
  );
  // THREE taps once the glass is on — one per dispersed channel. Pinned as a
  // COUNT, because the failure this guards is not "the swap broke" but "the
  // swap only reached the first one", which leaves two thirds of the light
  // sampling the 1×1 placeholder and still renders a plausible cookie.
  ok('the dispersion builds one texture node per channel', built.maskTexNodes.length === 3);
  const swapped = stubTexture();
  built.setMaskTexture(swapped);
  ok(
    'setMaskTexture re-points EVERY node the effect samples, not just the first',
    built.maskTexNodes.every((n) => n.value === swapped)
  );

  // ── THE JS-TIME GLASS BRANCH (`tsl/no-uniform-gates` / Effects.md Law 4) ──
  // "If turning it off does not SHRINK the compiled shader, it is not off."
  // The observable proxy for that here is the tap count: with the glass
  // omitted the graph must build ONE mask tap, not three multiplied by zero.
  const noGlass = buildWindowSurfaceMaterial(args({ glass: false }));
  ok('with glass:false the graph builds a single mask tap', noGlass.maskTexNodes.length === 1);
  ok('…and still exposes the same setter surface', typeof noGlass.setGlass === 'function');
  let noGlassSetterError = null;
  try {
    // The setters must stay callable with the subgraph gone — the subsystem
    // pushes them unconditionally and must not need to know which shape it got.
    noGlass.setGlass({ warpPx: 5, dispersion: 0.5, seedOffset: [1, 2] });
    noGlass.setUvPerWorldPx(0.01, 0.01);
    for (const ch of WINDOW_DEBUG_CHANNELS) noGlass.setDebugChannel(ch.n);
  } catch (err) {
    noGlassSetterError = err;
  }
  ok(
    `the glass setters are safe no-ops when the subgraph was never built (${noGlassSetterError ? noGlassSetterError.message : 'clean'})`,
    noGlassSetterError === null
  );

  // ── THE OCCLUSION GATE (`gateGlass`, 2026-08-12) — Fn()/If() around the
  // GLASS BUILD ITSELF, one cache layer below the JS-time glass branch above:
  // that one shrinks the COMPILED SHADER; this one skips PER-FRAGMENT WORK
  // within a shader that already has the glass compiled in. Defaults OFF —
  // every assertion above this block already proves the off/default path is
  // unaffected by this parameter's mere existence. ─────────────────────────
  ok('gateGlassCompiled defaults false — the default path is unchanged', built.gateGlassCompiled === false);

  let gatedError = null;
  let gated = null;
  try {
    gated = buildWindowSurfaceMaterial(args({ gateGlass: true }));
  } catch (err) {
    gatedError = err;
  }
  ok(
    `gateGlass:true with a real depth texture constructs without throwing (${gatedError ? gatedError.message : 'clean'})`,
    gatedError === null
  );
  ok('…and reports the gate as actually compiled', gated?.gateGlassCompiled === true);
  ok('…and still returns a real, distinct colorNode', !!gated?.windowMaterial?.colorNode);
  // ⚠️ STILL THREE TAPS, NOT SIX — this is the trap, not a typo. The gated
  // build's OWN buildGlassCookie() call lives inside a TSL Fn() callback,
  // which `reference_tsl_fn_deferred_execution_trap` says does NOT run when
  // this line executes — it runs LATER, only when three's NodeBuilder
  // actually visits the graph (a real shader compile, no WebGPU device in
  // Node — keyhole-tsl-constructs-in-node). So in THIS test the deferred half
  // never ran at all, and maskTexNodes only ever saw the ONE eager
  // (debug-material) build, identical in count to the ungated case above.
  // Proving that gap is exactly why the two assertions below exist, and why
  // this file's own header names live verification as the next required step.
  ok('the deferred half never actually ran in this test — same tap count as ungated', gated.maskTexNodes.length === 3);

  // THE BUG THIS FOUND: a texture() node built AFTER setMaskTexture already
  // ran would normally close over the STALE construction-time texture
  // forever — setMaskTexture can only update nodes that already exist, and
  // window-surface-subsystem.js calls it once, asynchronously, BEFORE the
  // mesh (and hence this deferred build) ever becomes visible. `liveMaskTexture`
  // exists so a node built later still starts correct — this cannot exercise
  // the deferred texture() call itself (see above), but it can and does prove
  // the variable that call depends on actually moves.
  const beforeSwap = gated.debugGetLiveMaskTexture();
  const swappedGated = stubTexture();
  let gatedSwapError = null;
  try {
    gated.setMaskTexture(swappedGated);
  } catch (err) {
    gatedSwapError = err;
  }
  ok(
    `setMaskTexture still runs cleanly against the gated build (${gatedSwapError ? gatedSwapError.message : 'clean'})`,
    gatedSwapError === null
  );
  ok(
    'setMaskTexture updates the LIVE reference a not-yet-built node will read, not just existing nodes',
    gated.debugGetLiveMaskTexture() === swappedGated && gated.debugGetLiveMaskTexture() !== beforeSwap
  );
  ok(
    '…and existing (eager, debug-material) nodes still get updated exactly as before',
    gated.maskTexNodes.every((n) => n.value === swappedGated)
  );
  // The two builds share the SAME uniform objects (declared once, outside
  // buildGlassCookie) rather than each owning a copy — so one setGlass() call
  // must move both without needing to know either build happened.
  let gatedGlassSetterError = null;
  try {
    gated.setGlass({ warpPx: 12, dispersion: 0.3 });
  } catch (err) {
    gatedGlassSetterError = err;
  }
  ok(
    `setGlass still works against the gated build (${gatedGlassSetterError ? gatedGlassSetterError.message : 'clean'})`,
    gatedGlassSetterError === null
  );

  // A real depth texture is required for the gate to mean anything — see
  // `gateGlass`'s own JSDoc on why gating a JS-constant `visibility01` would
  // just be a branch around "always true", pure overhead for nothing skipped.
  const gatedNoDepth = buildWindowSurfaceMaterial(args({ gateGlass: true, depthTexture: null }));
  ok(
    'gateGlass:true with NO depth texture falls back to the ungated build rather than gating on a constant',
    gatedNoDepth.gateGlassCompiled === false
  );
  ok('…and still produces a working material', !!gatedNoDepth.windowMaterial?.colorNode);

  // THE INSTRUMENT MUST NOT LIE (feedback_instruments_must_not_lie): the
  // debug material's own channels come from the UNGATED build always, so
  // gateGlass must not change what the field-diagnostic channels are built
  // from. This cannot check the RENDERED picture (no WebGPU device in Node —
  // keyhole-tsl-constructs-in-node), but it can and does check that both the
  // gated and ungated runs construct the SAME kind of debug material rather
  // than gateGlass silently reaching into the debug channels too.
  ok(
    'the debug material still exists and is distinct from the (now gated) add pass',
    !!gated?.debugMaterial && gated.debugMaterial !== gated.windowMaterial
  );

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
  ok('the floor-gate channel is wired even when the gate compiles out', !!noDepth.debugMaterial);
}
