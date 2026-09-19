/**
 * prism-render.test.mjs — THE TSL GRAPH IS ACTUALLY CONSTRUCTED, IN NODE, AT
 * EVERY TIER.
 *
 * Same reasoning `lens-render.test.mjs`'s/`fluid-sim-render.test.mjs`'s own
 * headers give: a pure-maths suite never once CALLS the builder, so a
 * temporal-dead-zone error, a TSL export that moved, or a swizzle that does
 * not exist on a node can ship behind thousands of green assertions. This
 * proves the graph SURVIVES BEING BUILT at every tier — nothing about the
 * emitted WGSL, nothing about what it looks like on screen (this project's
 * own standing rule: only a live human check confirms a visual effect).
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import { buildPrismSurfaceMaterial, PRISM_REFRACT_WORLD_PX_PER_INTENSITY } from '../prism-render.js';
import { PRISM_DEFAULT_TIER, PRISM_MAX_TIER } from '../prism-motion.js';

/** A 1×1 texture — enough for a node to reference; never sampled here. */
function stubTexture() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
}

export function run(t) {
  const { ok } = t;

  ok('PRISM_REFRACT_WORLD_PX_PER_INTENSITY is a real, positive constant', PRISM_REFRACT_WORLD_PX_PER_INTENSITY > 0);

  // ── EVERY RUNG CONSTRUCTS — with no depth/view rect (the unwired-caller case) ──
  const built = {};
  for (const tier of [0, 1, 2, 3]) {
    let result = null;
    let err = null;
    try {
      result = buildPrismSurfaceMaterial({
        THREE,
        maskTexture: stubTexture(),
        behindTexture: stubTexture(),
        tier,
      });
    } catch (e) {
      err = e;
    }
    ok(`tier ${tier}: the TSL graph CONSTRUCTS without throwing (${err ? err.message : 'clean'})`, err === null);
    built[tier] = result;
  }
  if (!built[3]) return; // everything below would cascade meaninglessly

  for (const tier of [0, 1, 2, 3]) {
    const b = built[tier];
    ok(`tier ${tier}: returns a real NodeMaterial`, b.material?.isNodeMaterial);
    ok(`tier ${tier}: carries a colorNode — an empty material renders nothing, silently`, !!b.material.colorNode);
    ok(
      `tier ${tier}: carries an opacityNode — a translucent surface with no opacity term never fades`,
      !!b.material.opacityNode
    );
    ok(`tier ${tier}: reports the tier it was actually built at`, b.tier === tier);
    ok(
      `tier ${tier}: never depth-tests/writes — drawn additively into the shared scene, same posture fluid's own tile surfaces take`,
      b.material.depthTest === false && b.material.depthWrite === false
    );
    ok(
      `tier ${tier}: is transparent — this is a translucent glass surface, not an opaque one`,
      b.material.transparent === true
    );
  }

  // ── EVERY DECLARED UNIFORM IS PRESENT AT EVERY TIER ─────────────────────
  const expectedKeys = [
    'uMaskThreshold',
    'uOpacity',
    'uBrightness',
    'uMaskTintStrength',
    'uFacetScale',
    'uFacetSpeed',
    'uFacetSoftness',
    'uParallaxStrength',
    'uGlintStrength',
    'uGlintThreshold',
    'uIntensity',
    'uSpread',
    'uTimeSec',
    'uCameraOffsetPx',
    'uExpectedDepth',
    'uCapturedRect',
    'uCapturedTexelUv',
  ];
  for (const tier of [0, 1, 2, 3]) {
    const keys = Object.keys(built[tier].uniforms);
    ok(
      `tier ${tier}: every expected uniform is present`,
      expectedKeys.every((k) => keys.includes(k))
    );
    ok(
      `tier ${tier}: no unexpected extra uniform`,
      keys.every((k) => expectedKeys.includes(k))
    );
  }

  // ── THE RE-POINTABLE TEXTURE NODES ───────────────────────────────────────
  for (const tier of [0, 1, 2, 3]) {
    const b = built[tier];
    ok(`tier ${tier}: returns maskTexNode — proof there is a real re-pointable mask input`, !!b.maskTexNode);
    ok(
      `tier ${tier}: maskTexNode.value is a genuinely mutable reference (re-pointing works)`,
      (() => {
        const t2 = stubTexture();
        b.maskTexNode.value = t2;
        return b.maskTexNode.value === t2;
      })()
    );
  }
  ok(
    'behindTexNodes is empty below tier 3 — nothing to re-point yet',
    [0, 1, 2].every((tier) => built[tier].behindTexNodes.length === 0)
  );
  ok('behindTexNodes carries exactly 3 nodes at tier 3 — one per R/G/B tap', built[3].behindTexNodes.length === 3);
  ok(
    'the three tier-3 behind-texture nodes re-point independently of each other',
    (() => {
      const [r, g, b] = built[3].behindTexNodes;
      const tr = stubTexture();
      r.value = tr;
      return r.value === tr && g.value !== tr && b.value !== tr;
    })()
  );

  // ── A LIVE UNIFORM PUSH IS A PLAIN MUTABLE VALUE WRITE ──────────────────
  ok(
    'uIntensity.value is a genuinely mutable uniform, not frozen',
    (() => {
      const u = built[3].uniforms;
      u.uIntensity.value = 1.2;
      return u.uIntensity.value === 1.2;
    })()
  );
  ok(
    'uCameraOffsetPx is a vec2 uniform whose .value.set() works (the per-frame push shape a real pass would use)',
    (() => {
      const u = built[1].uniforms;
      u.uCameraOffsetPx.value.set(3, -4);
      return u.uCameraOffsetPx.value.x === 3 && u.uCameraOffsetPx.value.y === -4;
    })()
  );

  // ── TIER OMITTED FALLS BACK TO PRISM_DEFAULT_TIER, CONSTRUCTS CLEANLY ────
  {
    let err = null;
    try {
      buildPrismSurfaceMaterial({ THREE, maskTexture: stubTexture(), behindTexture: stubTexture() });
    } catch (e) {
      err = e;
    }
    ok(
      `a caller that omits tier (falls back to PRISM_DEFAULT_TIER=${PRISM_DEFAULT_TIER}) constructs cleanly`,
      err === null
    );
  }

  // ── facetAnimate:false constructs cleanly too (the JS-time branch, not a uniform) ──
  {
    let err = null;
    try {
      buildPrismSurfaceMaterial({
        THREE,
        maskTexture: stubTexture(),
        behindTexture: stubTexture(),
        facetAnimate: false,
        tier: PRISM_MAX_TIER,
      });
    } catch (e) {
      err = e;
    }
    ok('facetAnimate:false still constructs a full-tier material cleanly', err === null);
  }

  // ── WITH A DEPTH TEXTURE + VIEW RECT WIRED — the occlusion/tap-validation branch ──
  {
    let withDepth = null;
    let err = null;
    try {
      withDepth = buildPrismSurfaceMaterial({
        THREE,
        maskTexture: stubTexture(),
        behindTexture: stubTexture(),
        depthTexture: stubTexture(),
        // A real, pre-built uniform NODE — the same shared-`envLight.uViewRect`
        // shape `specular-render.js`/`water-render.js` accept, never a plain
        // rect (see `buildPrismSurfaceMaterial`'s own `uViewRect` doc).
        uViewRect: THREE.TSL.uniform(THREE.TSL.vec4(0, 0, 1000, 1000)),
        capturedRect: { minX: 0, minY: 0, maxX: 1000, maxY: 1000 },
        capturedTexSize: { width: 512, height: 512 },
        expectedDepth: 0.5,
        tier: PRISM_MAX_TIER,
      });
    } catch (e) {
      err = e;
    }
    ok(
      `the occlusion-gated + tap-validated graph CONSTRUCTS without throwing (${err ? err.message : 'clean'})`,
      err === null
    );
    if (withDepth) {
      ok('a depthTexNode is returned once a depth texture is wired', !!withDepth.depthTexNode);
      ok('uExpectedDepth carries the constructor value', withDepth.uniforms.uExpectedDepth.value === 0.5);
    }
  }
  ok(
    'with NO depth texture, depthTexNode is null — nothing to re-point, matching the established "empty below its own gating input" contract',
    built[3].depthTexNode === null
  );
}
