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
 * Tier 5 (refraction, 2026-08-23) joined the ladder as a FIFTH structurally
 * different graph, same reasoning as tiers 0-3 above: it is the first rung
 * whose own unconditional `texture()` fetch reads a caller-supplied texture
 * that is genuinely `null` on a real session's opening frames
 * (`water-refraction-subsystem.js`'s own capture-not-ready state) — exactly
 * the `bodyTexture` race this file already guards below, one rung narrower.
 *
 * WHAT IT DOES **NOT** PROVE, stated plainly so a green run is never mistaken
 * for more: nothing about the emitted WGSL, nothing about what any of it looks
 * like, nothing about performance. The graph is built, not compiled and not
 * run. `water-light.test.mjs` owns the NUMBERS (what reaches the screen); this
 * owns "does it survive being constructed at all".
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import { buildWorldSpaceOutdoorsGate } from '../../lighting/environmental-light.js';
import {
  buildWaterSurfaceMaterial,
  WATER_DEFAULT_TIER,
  WATER_PRESENCE_EDGE0,
  WATER_PRESENCE_EDGE1,
  WATER_PRESENCE_EDGE_AA_PX,
} from '../water-render.js';
import { WATER_DEBUG_CHANNELS } from '../water.js';
import { buildFoamCellularStructure } from '../water-shore.js';

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
    capturedTexture: stubTexture(),
    capturedRect: RECT,
    capturedTexSize: { width: 512, height: 512 },
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
  for (const tier of [0, 1, 2, 3, 4, 5]) {
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
  if (!built[5]) return; // everything below would cascade meaninglessly

  // ── WATER IS TWO MESHES AT EVERY TIER ──────────────────────────────────
  // Half a water surface (absorption with no in-scatter, or the reverse) is a
  // far worse failure than none and reads as a shader bug — the subsystem's
  // own `refreshVisibility` says so. A tier that dropped one would be exactly
  // that, silently.
  for (const tier of [0, 1, 2, 3, 4, 5]) {
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

  // ── A NULL bodyTexture CLAMPS THE ACTUAL TIER TO 0 (2026-08-18) ─────────
  // The loop above never catches this: it always passes a real stub
  // texture, so `tier === tier` trivially held even before this fix existed.
  // The regression this guards against: `water-surface-subsystem.js#sync`
  // stores THIS return value as `builtForTier`, documented as reflecting
  // what actually compiled, not what was merely requested. `bodyTexture` is
  // genuinely null on the very first sync() of a session, before the body
  // pack's own first bake completes, and every tier ≥1 rung reads it
  // unconditionally. Without this clamp, a build racing ahead of that first
  // bake either throws (`texture(null, …)`, live-reported the same day) or,
  // worse, silently compiles at tier 0 while claiming a higher tier — which
  // permanently starves every later sync() of the "resolved tier differs
  // from built tier" mismatch it needs to ever retry. Live-reported as "MSA
  // breaks entirely, no error, no warning" the same day this shipped without
  // the assertions below.
  {
    const noBody = buildWaterSurfaceMaterial(args({ tier: 4, bodyTexture: null }));
    ok('a null bodyTexture clamps the ACTUAL tier to 0, whatever tier was requested', noBody.tier === 0);
    ok('…and therefore never creates the body-pack fetch either', noBody.bodyTexNode === null);
    const withBody = buildWaterSurfaceMaterial(args({ tier: 4 }));
    ok('a real bodyTexture reaches the actually-requested tier', withBody.tier === 4);
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
  for (const tier of [0, 1, 2, 3, 4, 5]) {
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
    'setCapturedRect',
    'setCapturedTexSize',
    'setDebugChannel',
  ];
  for (const tier of [0, 1, 2, 3, 4, 5]) {
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

  // ══ TIER 5 — REFRACTION (2026-08-23, Water-Testament.md §2.5) ═══════════
  // Same "THE GATE ACTUALLY GATES" proof tier 1's `bodyTexNode` got: below
  // tier 5 there is no third mesh to draw, and it is JS-absent, not merely
  // hidden, because a uniform-based "gate" could not produce a null here
  // (`tsl/no-uniform-gates`).
  ok('tier 5 builds the third mesh', built[5].refractMaterial !== null);
  ok(
    'tiers below 5 build no refraction mesh at all — nothing to draw, nothing to bind',
    built[0].refractMaterial === null &&
      built[1].refractMaterial === null &&
      built[2].refractMaterial === null &&
      built[3].refractMaterial === null &&
      built[4].refractMaterial === null
  );
  ok(
    'the refraction mesh is a real NodeMaterial with a colorNode',
    built[5].refractMaterial.isNodeMaterial && !!built[5].refractMaterial.colorNode
  );
  ok(
    'the refraction mesh blends via SrcAlpha/OneMinusSrcAlpha — a real sample, not a multiplicative tint',
    built[5].refractMaterial.blendSrc === THREE.SrcAlphaFactor &&
      built[5].refractMaterial.blendDst === THREE.OneMinusSrcAlphaFactor
  );
  ok(
    'the refraction mesh ALSO overrides its attr MRT — same reasoning as absorbMaterial/debugMaterial',
    !!built[5].refractMaterial.mrtNode
  );

  // ── `capturedTexNodes` MUST CONTAIN EVERY `texture(capturedTexture, …)`
  // NODE, same discipline `maskTexNodes` enforces below and for the same
  // reason: three DIFFERENT UVs (the chromatic fringe's R/B split) means
  // three DIFFERENT nodes, and a caller re-pointing only the first would
  // leave two channels sampling the 1×1 placeholder forever
  // (`feedback_texture_nodes_must_be_repointed_together`). ──────────────────
  ok('capturedTexNodes is an array', Array.isArray(built[5].capturedTexNodes));
  ok('below tier 5, no captured-texture node exists yet', built[4].capturedTexNodes.length === 0);
  ok(
    `tier 5 builds exactly the three chromatic-fringe taps (got ${built[5].capturedTexNodes.length})`,
    built[5].capturedTexNodes.length === 3
  );
  ok(
    'every captured-texture node is a genuine re-pointable TextureNode, not a derived expression',
    built[5].capturedTexNodes.every((n) => n.isTextureNode === true)
  );

  // ── A MISSING `capturedTexture` CLAMPS THE ACTUAL TIER TO 4, MIRRORING
  // `bodyTexture`'s OWN CLAMP TO 0 ABOVE — the same startup race
  // (`water-refraction-subsystem.js` returns `texture: null` before its
  // first successful capture), one rung narrower. ──────────────────────────
  {
    const noCapture = buildWaterSurfaceMaterial(args({ tier: 5, capturedTexture: null }));
    ok('a null capturedTexture clamps the ACTUAL tier to 4, whatever tier was requested', noCapture.tier === 4);
    ok('…and therefore never creates the refraction mesh either', noCapture.refractMaterial === null);
    ok('…nor any of the chromatic-fringe taps', noCapture.capturedTexNodes.length === 0);
    ok(
      'tiers 1-4 are UNAFFECTED by the missing capture — they read nothing from this subsystem',
      !!noCapture.bodyTexNode && noCapture.normalCompiled === true
    );
    const withCapture = buildWaterSurfaceMaterial(args({ tier: 5 }));
    ok('a real capturedTexture reaches the actually-requested tier', withCapture.tier === 5);
  }

  // ── THE TWO NEW SETTERS ARE CALLABLE AT EVERY TIER, INCLUDING BELOW 5 —
  // same reasoning as the tier-3 lobe's own setters: the subsystem pushes
  // every param every time the key changes, without asking the tier first.
  {
    let err = null;
    try {
      built[0].setCapturedRect({ minX: 100, minY: 200, maxX: 900, maxY: 800 });
      built[0].setCapturedTexSize(256, 128);
    } catch (e) {
      err = e;
    }
    ok(`tier 0 tolerates both tier-5 setters being called on it (${err ? err.message : 'clean'})`, err === null);
  }

  // ══ `maskTexNodes` MUST CONTAIN EVERY `texture(maskTexture, …)` NODE
  // (2026-08-17, `feedback_texture_nodes_must_be_repointed_together`) ═══════
  // The live incident this guards: the material is built against a 1×1
  // placeholder, and the real image re-points exactly the nodes in THIS
  // array. The mask-proximity 8-tap ring (tier 4) is what originally exposed
  // the gap — it once created 8 nodes that were never added here, so they
  // sampled the placeholder forever and turned the author's whole river
  // white — but that ring itself was removed 2026-08-18 (author's explicit
  // repeated request; see water-render.js's own removal note). The
  // underlying discipline this test guards outlives the ring: `maskTexNodes`
  // must still contain the exact node the shader reads, for whatever gets
  // added to tier 4 next. Re-checking the count at tier 4 (not just below
  // it) now doubles as a removal guard — if it ever drifts off 1 again,
  // something is sampling the mask without registering for re-pointing.
  {
    const belowRing = buildWaterSurfaceMaterial(args({ tier: 3 }));
    ok('maskTexNodes is an array', Array.isArray(belowRing.maskTexNodes));
    ok(
      "maskTexNodes[0] IS maskTexNode (same node, not a copy) — the subsystem's re-point loop must reach the exact object the shader reads",
      belowRing.maskTexNodes[0] === belowRing.maskTexNode
    );
    ok('below tier 4, only the base sample exists', belowRing.maskTexNodes.length === 1);

    const atTier4 = buildWaterSurfaceMaterial(args({ tier: 4 }));
    ok(
      `at tier 4, still only the base sample — the 8-tap ring is gone (got ${atTier4.maskTexNodes.length})`,
      atTier4.maskTexNodes.length === 1
    );
  }

  // ══ `flowPackTexNode` IS NEVER NULL, UNLIKE `bodyTexNode` (2026-08-17,
  // S2/S3) — the debug channels it feeds have no bake-generation to gate
  // mesh visibility on, so a null-valued node here could actually be sampled
  // on the GPU rather than merely existing-but-unreached. ══════════════════
  {
    const noFlowArg = buildWaterSurfaceMaterial(args({ tier: 0 }));
    ok('flowPackTexNode exists even at tier 0 (unconditional, not tier-gated)', !!noFlowArg.flowPackTexNode);
    // ⚠️ `isTextureNode === true`, HARD requirement, NOT `|| !!node` — LIVE
    // REGRESSION, 2026-08-18, SAME DAY THE `inRect` GATE SHIPPED. This
    // assertion USED TO read `!!node.isTextureNode || !!node` — which passes
    // for ANY truthy node, texture or not, and so passed even after the gate
    // was written as `texture(...).mul(inRect)` and assigned back to
    // `flowPackTexNode` — a `.mul()` result is a plain arithmetic node (a
    // `VarNode` in the vendored three.webgpu.js, confirmed empirically), NOT
    // a `TextureNode`, and critically: assigning `.value = someTexture` on it
    // SUCCEEDS as an ordinary JS property write and reads back correctly —
    // it just has ZERO effect on the compiled shader, because a `VarNode`'s
    // `.value` property is not consulted by anything. That is precisely why
    // `water-surface-subsystem.js#setFlowPackTexture`'s own
    // `surface.flowPackTexNode.value = t` went from a real re-point to a
    // silent no-op: production kept sampling the 1×1 placeholder forever,
    // which reads as solid black (this channel's own "value=0 is black
    // regardless of hue" property). Author's live report: "The flow pack
    // velocity debug layer is black for me." `isTextureNode` is the cheapest
    // available Node-level (no GPU) discriminator between "a real, re-
    // pointable texture reference" and "a derived expression that merely
    // LOOKS like one from the outside" — any future gate/derived term
    // applied to a re-pointed node MUST land on a SEPARATE variable, never
    // reassign the re-pointed name itself, and this test is what catches it
    // if that discipline slips again.
    ok(
      'flowPackTexNode is a genuine re-pointable TextureNode, not a derived expression',
      noFlowArg.flowPackTexNode.isTextureNode === true
    );

    const withFlowArg = buildWaterSurfaceMaterial(args({ tier: 4, flowPackTexture: stubTexture() }));
    ok('flowPackTexNode exists at tier 4 too', !!withFlowArg.flowPackTexNode);
    ok(
      'flowPackTexNode stays a genuine TextureNode at tier 4 too, with a real texture supplied',
      withFlowArg.flowPackTexNode.isTextureNode === true
    );
    // ⚠️ DELIBERATELY NOT TESTED HERE: whether `.value = x` re-pointing
    // actually changes what gets SAMPLED. A `.value` round-trip
    // (`node.value = x; assert node.value === x`) was tried and REJECTED —
    // it passes identically on a broken `VarNode` (confirmed empirically:
    // plain JS property assignment always round-trips, texture node or not)
    // and would have been exactly the kind of test that LOOKS like it proves
    // the wiring while proving nothing (`feedback_instruments_must_not_lie`).
    // `isTextureNode === true`, above, is the strongest claim Node can make
    // honestly. Whether a re-point actually reaches the GPU sampler is a
    // render+readback question — `bench-water.js`'s own re-point scenario is
    // where that gets proven, not here.
  }

  // ══ THE PRESENCE EDGE'S OWN AA FLOOR (2026-08-19) — third independent
  // fix for a symptom this exact edge has now had twice before (ramp width,
  // then mask resolution) — see `WATER_PRESENCE_EDGE_AA_PX`'s own doc ═════
  ok('the presence edge AA width is a real, positive screen-pixel count', WATER_PRESENCE_EDGE_AA_PX > 0);
  ok(
    'the presence edge band is still a real band, not inverted or collapsed',
    WATER_PRESENCE_EDGE0 < WATER_PRESENCE_EDGE1
  );

  // ══ `buildFoamCellularStructure` — THE SPIRAL FIX (2026-08-19) ══════════
  // The bug: `WATER_FOAM_STREAK`'s rotation used to be fed a per-pixel
  // direction directly as `flowDir`, which warped it into a spiral near
  // obstacles. The fix separates "what rotates" (must stay global) from
  // "what nudges" (the real per-pixel signal, bounded and additive) into
  // two distinct parameters — this only constructs cleanly if that
  // separation is real, not just documented.
  {
    const { uniform, vec2, float } = THREE.TSL;
    const worldXY = uniform(vec2(400, 250));
    const domainOffset = uniform(vec2(0, 0));
    const globalDir = uniform(vec2(0, 1)); // due south, same as the shipped default
    const uReachPx = uniform(float(180));

    const noLocal = buildFoamCellularStructure({ TSL: THREE.TSL, worldXY, domainOffset, flowDir: globalDir, uReachPx });
    ok('constructs with no localFlowDir at all (the null-safe default)', !!noLocal.structure && !!noLocal.cell);

    // A DIFFERENT node than `flowDir` — this is the case that used to matter:
    // a genuinely per-pixel-varying direction, distinct from the global one.
    const localDir = uniform(vec2(0.6, 0.8));
    const withLocal = buildFoamCellularStructure({
      TSL: THREE.TSL,
      worldXY,
      domainOffset,
      flowDir: globalDir,
      localFlowDir: localDir,
      uReachPx,
    });
    ok('constructs with a real, different localFlowDir supplied too', !!withLocal.structure && !!withLocal.cell);
    ok(
      'the two builds are independent objects, not the same node reused (a real second construction ran, not a cached no-op)',
      withLocal.structure !== noLocal.structure
    );
  }

  // ══ `waterSimTexNode` IS NEVER NULL EITHER (2026-08-18, S5) — SAME rule,
  // SAME live-regression scar, as `flowPackTexNode` immediately above: the
  // clump-threshold gate (`waterSimFoam`) MUST land on a separate variable,
  // never get assigned back onto `waterSimTexNode` itself. ══════════════════
  {
    const noSimArg = buildWaterSurfaceMaterial(args({ tier: 0 }));
    ok('waterSimTexNode exists even at tier 0 (unconditional, not tier-gated)', !!noSimArg.waterSimTexNode);
    ok(
      'waterSimTexNode is a genuine re-pointable TextureNode, not a derived expression',
      noSimArg.waterSimTexNode.isTextureNode === true
    );

    const withSimArg = buildWaterSurfaceMaterial(args({ tier: 4, waterSimTexture: stubTexture() }));
    ok('waterSimTexNode exists at tier 4 too', !!withSimArg.waterSimTexNode);
    ok(
      'waterSimTexNode stays a genuine TextureNode at tier 4 too, with a real texture supplied',
      withSimArg.waterSimTexNode.isTextureNode === true
    );
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

  for (const tier of [0, 1, 2, 3, 4, 5]) {
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
