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
  for (const tier of [0, 1, 2, 3]) {
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
  if (!built[3]) return; // everything below would cascade meaninglessly

  // ── WATER IS TWO MESHES AT EVERY TIER ──────────────────────────────────
  // Half a water surface (absorption with no in-scatter, or the reverse) is a
  // far worse failure than none and reads as a shader bug — the subsystem's
  // own `refreshVisibility` says so. A tier that dropped one would be exactly
  // that, silently.
  for (const tier of [0, 1, 2, 3]) {
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
  for (const tier of [0, 1, 2, 3]) {
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
    built[3].floorGateCompiled === false
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
  ];
  for (const tier of [0, 1, 2, 3]) {
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
    } catch (e) {
      err = e;
    }
    ok(`tier 0 tolerates every tier-3 setter being called on it (${err ? err.message : 'clean'})`, err === null);
  }
}
