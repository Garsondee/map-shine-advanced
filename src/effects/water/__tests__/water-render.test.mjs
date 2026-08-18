/**
 * water-render.test.mjs — WATER'S TSL GRAPH IS ACTUALLY CONSTRUCTED, IN NODE,
 * AT EVERY TIER.
 *
 * ============================================================================
 * WHY THIS EXISTS, AND WHY IT ARRIVED WITH THE TIER GATE
 * ============================================================================
 * `specular-render.test.mjs`'s header tells the story this file exists to
 * prevent repeating: a `const` in its temporal dead zone made the whole
 * renderer throw on load while 4,460 assertions stayed green, because every
 * suite in that effect was pure arithmetic and none had ever CALLED the
 * builder. Water was in exactly that position — `water.test.mjs`,
 * `water-floor`, `water-body` and `water-light` are all pure maths, and
 * `buildWaterSurfaceMaterial` had never once been invoked by a test.
 *
 * ⚠️ **AND THE TIER GATE MULTIPLIED THE RISK BY FOUR.** Before it, this module
 * built ONE graph, so a live scene exercised the only shape there was. It now
 * builds FOUR structurally different graphs behind JS `if`s (Effects.md Law 4):
 *
 *   tier 0 — no body-pack fetch at all; `bodyTexNode` is null
 *   tier 1 — + the SDF fetch, depth ramp, wet band
 *   tier 2 — + the fractal-noise surface field (foam / turbidity / slope)
 *   tier 3 — + the GGX sun-and-sky lobe fed by the wave normal
 *
 * A developer's machine resolves ONE of those. The other three can throw on a
 * player's machine — a `null` dereference in the tier-0 path, a TSL name only
 * the tier-2 branch uses — and nothing would catch it, because the rung that
 * breaks is by definition the rung nobody local is running. That is the
 * `feedback_mode_forks_silently_drop_features` shape wearing a performance
 * profile, and a per-tier construction test is the cheap wall against it.
 *
 * WHAT THIS PROVES: the whole "it throws on startup" class — temporal-dead-zone
 * errors, a TSL export that moved, a swizzle that does not exist on a node, a
 * type mismatch TSL rejects at construction, and a null that only one tier's
 * branch can reach.
 *
 * WHAT IT DOES **NOT** PROVE, stated plainly so a green run is never mistaken
 * for more: nothing about the emitted WGSL, nothing about what any of it looks
 * like, nothing about performance. The graph is built, not compiled and not
 * run. `water-light.test.mjs` owns the NUMBERS (what reaches the screen); this
 * owns "does it survive being constructed at all".
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import { buildWorldSpaceOutdoorsGate } from '../../lighting/environmental-light.js';
import { buildWaterSurfaceMaterial, WATER_DEFAULT_TIER } from '../water-render.js';
import { WATER_DEBUG_CHANNELS } from '../water.js';

/** A 1×1 texture — enough for a node to reference; never sampled here. */
function stubTexture() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
}

const RECT = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };

/** Everything `buildWaterSurfaceMaterial` needs, shaped exactly as
 * `water-surface-subsystem.js#buildSurfaceForTier` supplies it — so a change
 * to that call site this harness does not follow shows up here rather than on
 * the author's screen. */
function args(overrides = {}) {
  const { uniform, vec4, float } = THREE.TSL;
  return {
    THREE,
    maskTexture: stubTexture(),
    maskRect: RECT,
    bodyTexture: stubTexture(),
    bodyRect: RECT,
    timeMsNode: uniform(float(0)),
    uViewRect: uniform(vec4(0, 0, 1000, 1000)),
    uOutdoorsRect: uniform(vec4(0, 0, 1000, 1000)),
    outdoorsTexNode: THREE.TSL.texture(stubTexture()),
    buildOutdoorsGate: buildWorldSpaceOutdoorsGate,
    ...overrides,
  };
}

export function run(t) {
  const { ok } = t;

  // ── EVERY RUNG CONSTRUCTS — the reason this file exists ─────────────────
  const built = {};
  for (const tier of [0, 1, 2, 3, 4]) {
    let result = null;
    let err = null;
    try {
      result = buildWaterSurfaceMaterial(args({ tier }));
    } catch (e) {
      err = e;
    }
    ok(`tier ${tier}: the TSL graph CONSTRUCTS without throwing (${err ? err.message : 'clean'})`, err === null);
    built[tier] = result;
  }
  if (!built[4]) return; // everything below would cascade meaninglessly

  // ── WATER IS TWO MESHES AT EVERY TIER ──────────────────────────────────
  // Half a water surface (absorption with no in-scatter, or the reverse) is a
  // far worse failure than none and reads as a shader bug — the subsystem's
  // own `refreshVisibility` says so. A tier that dropped one would be exactly
  // that, silently.
  for (const tier of [0, 1, 2, 3, 4]) {
    const b = built[tier];
    ok(`tier ${tier}: returns BOTH materials`, !!b.absorbMaterial && !!b.inscatterMaterial);
    ok(
      `tier ${tier}: both are real NodeMaterials`,
      b.absorbMaterial.isNodeMaterial && b.inscatterMaterial.isNodeMaterial
    );
    ok(
      `tier ${tier}: both carry a colorNode — an empty material renders nothing, silently`,
      !!b.absorbMaterial.colorNode && !!b.inscatterMaterial.colorNode
    );
    ok(
      `tier ${tier}: the multiply pass overrides its attr MRT (blend neutrality is per-blend)`,
      !!b.absorbMaterial.mrtNode
    );
    ok(`tier ${tier}: reports the tier it was actually built at`, b.tier === tier);
  }

  // ── THE GATE ACTUALLY GATES (Effects.md Law 4's own test) ──────────────
  // "If turning a feature off does not SHRINK the compiled shader, it is not
  // off." This cannot measure WGSL length in Node, but it can prove the one
  // structural consequence that is visible here: below tier 1 the body-pack
  // texture node is never CREATED, so there is nothing to sample and nothing
  // to bind. A uniform-based "gate" could not produce a null here.
  ok('tier 0 never creates the body-pack fetch at all — the gate is structural', built[0].bodyTexNode === null);
  ok('tier 1 does create it', built[1].bodyTexNode !== null);
  ok(
    '...and so do the tiers above it (rungs are cumulative)',
    built[2].bodyTexNode !== null && built[3].bodyTexNode !== null
  );

  // ── THE WAVE NORMAL REACHES TIER 3, AND ONLY TIER 3 ────────────────────
  // `normalCompiled` false is the measured-invisible configuration
  // (`water-light.js`'s header): it does not fail, it renders a flat 0.0084
  // wash. It went unnoticed for three days precisely because every other
  // status field reads healthy in that state, so it is asserted rather than
  // trusted.
  ok('tier 3 compiles a REAL wave normal, not the flat fallback', built[3].normalCompiled === true);
  ok(
    'tiers below 3 report no normal — they have no lobe to feed',
    built[0].normalCompiled === false && built[1].normalCompiled === false && built[2].normalCompiled === false
  );

  // ── THE DEPTH-AUTHORITY GATE (2026-08-15) ──────────────────────────────
  // Mirrors "THE GATE ACTUALLY GATES" above for the SECOND JS-time branch
  // this file now has: `floorGateCompiled` is the one structural consequence
  // Node can observe (same reasoning as `bodyTexNode === null` above — a
  // uniform-based "gate" could not produce a JS-visible false here).
  for (const tier of [0, 1, 2, 3, 4]) {
    let err = null;
    let withDepth = null;
    try {
      withDepth = buildWaterSurfaceMaterial(args({ tier, depthTexture: stubTexture() }));
    } catch (e) {
      err = e;
    }
    ok(`tier ${tier}: constructs with a depth texture present (${err ? err.message : 'clean'})`, err === null);
    if (withDepth) {
      ok(`tier ${tier}: depthTexture + uViewRect together compile the gate IN`, withDepth.floorGateCompiled === true);
      ok(
        `tier ${tier}: still returns both meshes with the gate compiled in`,
        !!withDepth.absorbMaterial && !!withDepth.inscatterMaterial
      );
    }
  }
  ok(
    'no depthTexture at all (the pre-migration / unwired shape) compiles the gate OUT, not merely open',
    built[4].floorGateCompiled === false
  );
  {
    // depthTexture present but uViewRect absent must ALSO compile the gate
    // out: it has no screen position to sample at without it. Tier 0, not 3
    // — tier 3's OWN synthesised eye (`water-light.js`) is independently
    // documented as "Required for tier 3" and was never defended against a
    // missing uViewRect either; conflating the two here would test a
    // combination this file never promised to support and misattribute a
    // pre-existing, unrelated gap to this gate.
    let err = null;
    let b = null;
    try {
      b = buildWaterSurfaceMaterial(args({ tier: 0, depthTexture: stubTexture(), uViewRect: undefined }));
    } catch (e) {
      err = e;
    }
    ok(`depthTexture with no uViewRect constructs rather than throwing (${err ? err.message : 'clean'})`, err === null);
    if (b) ok('...and reports the gate as compiled-out, not silently open', b.floorGateCompiled === false);
  }

  // ── THE UNWIRED-CALLER PATHS, which are the ones that rot ──────────────
  {
    let err = null;
    try {
      // No tier at all: the WATER_DEFAULT_TIER fallback path.
      const b = buildWaterSurfaceMaterial(args({ tier: undefined }));
      ok('an absent tier falls back to the default rung, not to 0', b.tier === WATER_DEFAULT_TIER);
    } catch (e) {
      err = e;
    }
    ok(`an absent tier constructs (${err ? err.message : 'clean'})`, err === null);
  }
  {
    let err = null;
    try {
      const b = buildWaterSurfaceMaterial(args({ tier: 99 }));
      ok('a tier above the ladder still constructs and reports itself honestly', b.tier === 99);
    } catch (e) {
      err = e;
    }
    ok(
      `an out-of-range tier constructs rather than throwing into a frame (${err ? err.message : 'clean'})`,
      err === null
    );
  }
  {
    // The torture-fixture / un-wired shape: no outdoors gate, no clock. Both
    // are real states a caller can be in (`seams/viewer-wired`), and tier 3's
    // reflection is supposed to compile to a safe zero rather than throw.
    let err = null;
    let b = null;
    try {
      b = buildWaterSurfaceMaterial(args({ tier: 3, buildOutdoorsGate: undefined, timeMsNode: null }));
    } catch (e) {
      err = e;
    }
    ok(`tier 3 with NO outdoors gate and NO clock constructs (${err ? err.message : 'clean'})`, err === null);
    if (b) ok('...and reports the gate as compiled-out rather than pretending', b.outdoorsGateCompiled === false);
  }

  // ── THE SETTERS EXIST AT EVERY TIER ────────────────────────────────────
  // Below tier 3 the lobe is a stub object; its setters must still be callable
  // so the subsystem never needs an "is tier 3 live" branch just to push a
  // slider value. A missing one would throw on the first param change, which
  // is a runtime crash a construction test can pre-empt for free.
  const SETTERS = [
    'setMaskRect',
    'setBodyRect',
    'setAbsorption',
    'setDepthScalePx',
    'setInscatter',
    'setWaveScalePx',
    'setFlowSpeedPx',
    'setFlowAngleDeg',
    'setFoam',
    'setChop',
    'setWetBandPx',
    'setWetStrength',
    'setViewCentre',
    'setSky',
    'setSunGlint',
    'setSkySheen',
    'setGlossiness',
    'setViewerHeight',
    'setTint',
    'setOpacity',
    'setShorelineDepth',
    'setExpectedDepth',
    'setBodyTexSize',
    'setShadowResponse',
    'setSunShadowRect',
    'setSunShadowMix',
    'setSwashFoam',
    'setBreakFoam',
    'setCaustics',
    'setDebugChannel',
  ];
  for (const tier of [0, 1, 2, 3, 4]) {
    const b = built[tier];
    const missing = SETTERS.filter((k) => typeof b[k] !== 'function');
    ok(
      `tier ${tier}: every setter the subsystem calls exists${missing.length ? ` (missing: ${missing})` : ''}`,
      missing.length === 0
    );
  }
  // And they must be SAFE to call at a tier that ignores them — the subsystem
  // pushes every param every time the key changes, without asking the tier.
  {
    let err = null;
    try {
      const b = built[0];
      b.setSky({ keyDir: [0, 0, 1], keyColor: [1, 1, 1], keyStrength: 1, fillColor: [1, 1, 1], fillStrength: 0.4 });
      b.setSunGlint(1);
      b.setGlossiness(0.5);
      b.setViewerHeight(1.5);
      b.setViewCentre(10, 20);
      b.setChop(0.4);
      b.setShadowResponse(1);
      b.setSunShadowRect({ minX: 0, minY: 0, maxX: 1, maxY: 1 });
      b.setSunShadowMix(1);
      b.setBodyTexSize(512, 238);
      b.setSwashFoam(0.3);
      b.setBreakFoam(0.7);
      b.setCaustics(1);
    } catch (e) {
      err = e;
    }
    ok(`tier 0 tolerates every tier-3 setter being called on it (${err ? err.message : 'clean'})`, err === null);
  }

  // ══ THE CAST-SHADOW GATE (2026-08-16) ══════════════════════════════════
  // Author: *"Sun glint needs to be defeated by shadows."* The gate is a
  // JS-time branch on the field texture (Law 4), which means it creates a
  // FIFTH structurally different graph — exactly the multiplication this
  // file's own header says is the reason it exists. A shadow field only
  // reaches water on a scene that bakes one, so on any other scene this
  // branch would never be constructed at all until a player opened the wrong
  // map.
  {
    let err = null;
    let b = null;
    try {
      b = buildWaterSurfaceMaterial(args({ tier: 3, sunShadowTexture: stubTexture() }));
    } catch (e) {
      err = e;
    }
    ok(`tier 3 WITH a sun-shadow field constructs (${err ? err.message : 'clean'})`, err === null);
    if (b) {
      ok('...and reports the shadow gate as compiled', b.sunShadowCompiled === true);
      ok(
        '...and hands back the texture node, so the caller can re-point it at whichever per-floor slot matches',
        !!b.sunShadowTexNode
      );
      let setErr = null;
      try {
        b.setSunShadowRect({ minX: 2700, minY: 1350, maxX: 13350, maxY: 6300 });
        b.setSunShadowMix(1);
        b.setShadowResponse(0.5);
      } catch (e) {
        setErr = e;
      }
      ok(`...and every shadow setter is callable (${setErr ? setErr.message : 'clean'})`, setErr === null);
    }
  }
  // WITHOUT a field the whole lookup must be compiled OUT, not multiplied by a
  // one (`tsl/no-uniform-gates`) — and it must SAY so, because the failure is
  // silent on screen: the water simply keeps glinting inside buildings while
  // every other status field reads healthy.
  ok(
    'tier 3 with NO shadow field reports the gate compiled-out rather than pretending',
    built[3].sunShadowCompiled === false
  );
  ok(
    '...and hands back a null texture node, so a caller cannot re-point a gate that is not there',
    built[3].sunShadowTexNode === null
  );
  // Below tier 3 the stub must answer the same way — a subsystem that believed
  // a tier-1 material had a shadow node would push into `undefined.value`.
  ok(
    'tier 1 (no lobe at all) also reports no shadow gate',
    built[1].sunShadowCompiled === false && built[1].sunShadowTexNode === null
  );

  // ══ TIER 4 — SHORE (2026-08-16) ═════════════════════════════════════════
  // Filament foam is a genuinely new fetch built INSIDE `if (activeTier >= 4)`
  // in this file; shoaling and caustics ride tier 2's own fetch (see
  // `water-field.js`'s header on why) and are proven structurally instead —
  // there is no separate JS branch for them to point at here, so the proof is
  // that tier 4's graph constructs AT ALL with `sunShadowTexture` present too
  // (the FIFTH distinct graph shape this file now builds) and that turning the
  // tier down removes the ONE piece that IS its own branch.
  ok('tier 4 reports the tier it was built at', built[4].tier === 4);
  ok(
    'tier 4 still returns both meshes — filaments/shoaling/caustics only ADD (Law 2), never replace one',
    !!built[4].absorbMaterial && !!built[4].inscatterMaterial
  );
  ok(
    'tier 4 still carries a real wave normal — shoaling amplifies slope, it does not remove it',
    built[4].normalCompiled === true
  );
  {
    // The SAME construction proof "THE GATE ACTUALLY GATES" ran for the
    // body-pack fetch at tier 1 — filament foam's OWN fetch needs the same
    // proof. `buildWaterFilamentFoam` is called only inside `if (activeTier >=
    // 4)`, so there is no direct field on the returned object to read (unlike
    // `bodyTexNode`) — the honest structural check available in Node is that
    // tier 4 constructs cleanly with every optional input present AND absent,
    // which is what the loops above and below already establish; recorded
    // here as the section that groups tier 4's own assertions rather than
    // scattering them through tier 3's.
    let err = null;
    let b = null;
    try {
      b = buildWaterSurfaceMaterial(args({ tier: 4, sunShadowTexture: stubTexture(), depthTexture: stubTexture() }));
    } catch (e) {
      err = e;
    }
    ok(`tier 4 constructs with EVERY optional input present (${err ? err.message : 'clean'})`, err === null);
    if (b) {
      ok('...and the shadow gate compiles alongside filaments/shoaling/caustics', b.sunShadowCompiled === true);
      ok('...and the depth-authority gate does too', b.floorGateCompiled === true);
    }
  }
  {
    // A caller with the pre-tier-4 shape (no `filamentFoam`/`caustics` in its
    // args) must still get tier 4's defaults, not a throw — `water-surface-
    // subsystem.js#buildSurfaceForTier` predates this rung by weeks and does
    // not know these keys exist.
    let err = null;
    let b = null;
    try {
      b = buildWaterSurfaceMaterial(args({ tier: 4 }));
    } catch (e) {
      err = e;
    }
    ok(
      `tier 4 with NO filament/caustics args supplied still constructs (${err ? err.message : 'clean'})`,
      err === null
    );
    if (b) {
      let setErr = null;
      try {
        b.setSwashFoam(0.5);
        b.setBreakFoam(0.6);
        b.setCaustics(0.7);
      } catch (e) {
        setErr = e;
      }
      ok(`...and both tier-4 setters are callable (${setErr ? setErr.message : 'clean'})`, setErr === null);
    }
  }

  // ══ `maskTexNodes` MUST CONTAIN EVERY `texture(maskTexture, …)` NODE
  // (2026-08-17, `feedback_texture_nodes_must_be_repointed_together`) ═══════
  // The live incident this guards: the material is built against a 1×1
  // placeholder, the real image re-points exactly the nodes in THIS array,
  // and the mask-proximity ring (tier 4) once created 8 nodes that were
  // never added to it — they sampled the placeholder forever and turned the
  // author's whole river white. This does not catch every possible future
  // instance of the mistake (a ninth tap someone forgets to push would still
  // slip past a length check), but it does pin the two facts that make the
  // CURRENT fix real: the array exists and grows with the ring that needs it.
  {
    const belowRing = buildWaterSurfaceMaterial(args({ tier: 3 }));
    ok('maskTexNodes is an array', Array.isArray(belowRing.maskTexNodes));
    ok(
      "maskTexNodes[0] IS maskTexNode (same node, not a copy) — the subsystem's re-point loop must reach the exact object the shader reads",
      belowRing.maskTexNodes[0] === belowRing.maskTexNode
    );
    ok('below tier 4, only the base sample exists — the ring has not built yet', belowRing.maskTexNodes.length === 1);

    const atRing = buildWaterSurfaceMaterial(args({ tier: 4 }));
    ok(
      `at tier 4, the base sample PLUS all 8 ring taps are present (got ${atRing.maskTexNodes.length})`,
      atRing.maskTexNodes.length === 9
    );
  }

  // ══ `flowPackTexNode` IS NEVER NULL, UNLIKE `bodyTexNode` (2026-08-17,
  // S2/S3) — the debug channels it feeds have no bake-generation to gate
  // mesh visibility on, so a null-valued node here could actually be sampled
  // on the GPU rather than merely existing-but-unreached. ══════════════════
  {
    const noFlowArg = buildWaterSurfaceMaterial(args({ tier: 0 }));
    ok('flowPackTexNode exists even at tier 0 (unconditional, not tier-gated)', !!noFlowArg.flowPackTexNode);
    ok(
      'flowPackTexNode still constructs cleanly with no flowPackTexture argument at all',
      !!noFlowArg.flowPackTexNode.isTextureNode || !!noFlowArg.flowPackTexNode
    );

    const withFlowArg = buildWaterSurfaceMaterial(args({ tier: 4, flowPackTexture: stubTexture() }));
    ok('flowPackTexNode exists at tier 4 too', !!withFlowArg.flowPackTexNode);
  }

  // ══ THE DEBUG CHANNELS (2026-08-16, Water-Testament W0) — THE INSTRUMENT
  // MUST NOT LIE ══════════════════════════════════════════════════════════
  // `water.js#WATER_DEBUG_CHANNELS` explains why this exists at all (two live
  // "it is not visible" bugs against a zero-wide instrument, the same week).
  // Mirrors `specular-render.test.mjs`'s own copy of this block.
  //
  // The builder ALREADY throws at construction on a channel with no node —
  // which means tier 4's own construction, in the very first loop of this
  // file, is silently also asserting that every declared channel is wired.
  // Said out loud here so a future reader does not "simplify" that throw
  // into a skip.
  ok('it returns a THIRD material for the debug channels', !!built[4].debugMaterial);
  ok(
    'the debug material is its own object, never an alias of either real mesh',
    built[4].debugMaterial !== built[4].absorbMaterial && built[4].debugMaterial !== built[4].inscatterMaterial
  );
  ok(
    'the debug material is a real NodeMaterial with a colorNode',
    built[4].debugMaterial.isNodeMaterial && !!built[4].debugMaterial.colorNode
  );
  // ⚠️ OPAQUE (One/Zero), where BOTH real meshes blend against the bed. A
  // diagnostic whose "this factor is zero" answer rendered as *nothing
  // touched* would reproduce exactly the ambiguity it was built to remove —
  // black has to be legible AS black, not as an unchanged bed showing through.
  ok(
    'the debug material REPLACES rather than blends: One / Zero',
    built[4].debugMaterial.blendSrc === THREE.OneFactor && built[4].debugMaterial.blendDst === THREE.ZeroFactor
  );
  ok('the debug material is DoubleSide like its siblings', built[4].debugMaterial.side === THREE.DoubleSide);
  // ⚠️ UNLIKE specular's single-attachment target, water's real meshes DO
  // override `attr` (see `absorbMaterial`'s own comment on why a multiply
  // blend would otherwise erase it) — so the debug material needs its OWN
  // explicit override too, not an absence. A REPLACE blend has no neutral
  // value on `attr` either, so this pins the deliberate, documented choice
  // (explicit zero) rather than an unexamined renderer-global default.
  ok(
    'the debug material ALSO overrides its attr MRT — REPLACE has no neutral value to fall back on',
    !!built[4].debugMaterial.mrtNode
  );
  ok(
    'setDebugChannel exists — the subsystem calls it by name every sync',
    typeof built[4].setDebugChannel === 'function'
  );

  for (const tier of [0, 1, 2, 3, 4]) {
    let debugSetterError = null;
    try {
      for (const ch of WATER_DEBUG_CHANNELS) built[tier].setDebugChannel(ch.n);
      built[tier].setDebugChannel(NaN);
      built[tier].setDebugChannel(-3);
      built[tier].setDebugChannel(0);
    } catch (err) {
      debugSetterError = err;
    }
    ok(
      `tier ${tier}: every declared channel (plus junk) survives setDebugChannel (${debugSetterError ? debugSetterError.message : 'clean'})`,
      debugSetterError === null
    );
    // Every tier builds a debug material — the instrument has to work at
    // whichever rung the cascade actually resolved, not just at the top of
    // the ladder (tiers 0-3's own neutral stubs feed it the same way they
    // feed the two real meshes).
    ok(`tier ${tier}: still returns a debug material`, !!built[tier].debugMaterial);
  }
}
