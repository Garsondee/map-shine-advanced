/**
 * iridescence-render.test.mjs — THE TSL GRAPH IS ACTUALLY CONSTRUCTED, IN
 * NODE, AT EVERY TIER, IN BOTH NOISE FLAVOURS.
 *
 * Same reasoning `prism-render.test.mjs`'s own header gives: a pure-maths
 * suite never once CALLS the builder, so a temporal-dead-zone error, a TSL
 * export that moved, or a swizzle that does not exist on a node can ship
 * behind thousands of green assertions. This proves the graph SURVIVES BEING
 * BUILT at every tier and both `noiseType` branches — nothing about the
 * emitted WGSL, nothing about what it looks like on screen (this project's
 * own standing rule: only a live human check confirms a visual effect).
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import { buildIridescenceSurfaceMaterial } from '../iridescence-render.js';
import { IRIDESCENCE_DEFAULT_TIER, IRIDESCENCE_MAX_TIER } from '../iridescence-motion.js';

/** A 1×1 texture — enough for a node to reference; never sampled here. */
function stubTexture() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
}

export function run(t) {
  const { ok } = t;

  // ── EVERY RUNG CONSTRUCTS, BOTH NOISE FLAVOURS — with no depth/view rect
  // (the unwired-caller case) ──────────────────────────────────────────────
  const built = {};
  for (const tier of [0, 1, 2]) {
    for (const noiseType of [0, 1]) {
      let result = null;
      let err = null;
      try {
        result = buildIridescenceSurfaceMaterial({
          THREE,
          maskTexture: stubTexture(),
          tier,
          noiseType,
        });
      } catch (e) {
        err = e;
      }
      ok(
        `tier ${tier}, noiseType ${noiseType}: the TSL graph CONSTRUCTS without throwing (${err ? err.message : 'clean'})`,
        err === null
      );
      built[`${tier}:${noiseType}`] = result;
    }
  }
  if (!built['2:0']) return; // everything below would cascade meaninglessly

  for (const tier of [0, 1, 2]) {
    for (const noiseType of [0, 1]) {
      const b = built[`${tier}:${noiseType}`];
      ok(`tier ${tier}/${noiseType}: returns a real NodeMaterial`, b.material?.isNodeMaterial);
      ok(
        `tier ${tier}/${noiseType}: carries a colorNode — an empty material renders nothing, silently`,
        !!b.material.colorNode
      );
      ok(
        `tier ${tier}/${noiseType}: carries an opacityNode — a translucent surface with no opacity term never fades`,
        !!b.material.opacityNode
      );
      ok(`tier ${tier}/${noiseType}: reports the tier it was actually built at`, b.tier === tier);
      ok(
        `tier ${tier}/${noiseType}: never depth-tests/writes — drawn additively into the shared scene`,
        b.material.depthTest === false && b.material.depthWrite === false
      );
      ok(`tier ${tier}/${noiseType}: is transparent`, b.material.transparent === true);
      ok(
        `tier ${tier}/${noiseType}: is additively blended — a deliberate divergence from Prism (this module's own header)`,
        b.material.blending === THREE.AdditiveBlending
      );
    }
  }

  // ── EVERY DECLARED UNIFORM IS PRESENT AT EVERY TIER ─────────────────────
  const expectedKeys = [
    'uMaskThreshold',
    'uInvertMask',
    'uAlpha',
    'uIntensity',
    'uDistortionStrength',
    'uNoiseScale',
    'uFlowSpeed',
    'uPhaseMult',
    'uColorCycleSpeed',
    'uAngle',
    'uParallaxStrength',
    'uIgnoreDarkness',
    'uTimeSec',
    'uCameraOffset',
    'uExpectedDepth',
  ];
  for (const tier of [0, 1, 2]) {
    const keys = Object.keys(built[`${tier}:0`].uniforms);
    ok(
      `tier ${tier}: every expected uniform is present`,
      expectedKeys.every((k) => keys.includes(k))
    );
    ok(
      `tier ${tier}: no unexpected extra uniform`,
      keys.every((k) => expectedKeys.includes(k))
    );
  }

  // ── THE RE-POINTABLE MASK TEXTURE NODE ───────────────────────────────────
  for (const tier of [0, 1, 2]) {
    const b = built[`${tier}:0`];
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

  // ── illumTexNode — only present when both the tier gates it AND a texture
  // is actually wired ──────────────────────────────────────────────────────
  ok(
    'tier 0/1 (no light reactivity): illumTexNode is null — nothing to re-point yet',
    built['0:0'].illumTexNode === null && built['1:0'].illumTexNode === null
  );
  ok(
    'tier 2 with NO illumTexture wired: illumTexNode is still null (fails open, never throws)',
    built['2:0'].illumTexNode === null
  );
  {
    let withIllum = null;
    let err = null;
    try {
      withIllum = buildIridescenceSurfaceMaterial({
        THREE,
        maskTexture: stubTexture(),
        illumTexture: stubTexture(),
        tier: IRIDESCENCE_MAX_TIER,
      });
    } catch (e) {
      err = e;
    }
    ok(`tier 2 WITH an illumTexture constructs cleanly (${err ? err.message : 'clean'})`, err === null);
    ok('tier 2 with an illumTexture wired: illumTexNode is a real re-pointable node', !!withIllum?.illumTexNode);
  }

  // ── A LIVE UNIFORM PUSH IS A PLAIN MUTABLE VALUE WRITE ──────────────────
  ok(
    'uIntensity.value is a genuinely mutable uniform, not frozen',
    (() => {
      const u = built['2:0'].uniforms;
      u.uIntensity.value = 1.2;
      return u.uIntensity.value === 1.2;
    })()
  );
  ok(
    'uCameraOffset is a vec2 uniform whose .value.set() works (the per-frame push shape a real pass would use)',
    (() => {
      const u = built['1:0'].uniforms;
      u.uCameraOffset.value.set(3000, -4000);
      return u.uCameraOffset.value.x === 3000 && u.uCameraOffset.value.y === -4000;
    })()
  );

  // ── TIER OMITTED FALLS BACK TO IRIDESCENCE_DEFAULT_TIER, CONSTRUCTS CLEANLY ──
  {
    let err = null;
    try {
      buildIridescenceSurfaceMaterial({ THREE, maskTexture: stubTexture() });
    } catch (e) {
      err = e;
    }
    ok(
      `a caller that omits tier (falls back to IRIDESCENCE_DEFAULT_TIER=${IRIDESCENCE_DEFAULT_TIER}) constructs cleanly`,
      err === null
    );
  }

  // ── WITH A DEPTH TEXTURE + VIEW RECT WIRED — the occlusion branch ────────
  {
    let withDepth = null;
    let err = null;
    try {
      withDepth = buildIridescenceSurfaceMaterial({
        THREE,
        maskTexture: stubTexture(),
        illumTexture: stubTexture(),
        depthTexture: stubTexture(),
        uViewRect: THREE.TSL.uniform(THREE.TSL.vec4(0, 0, 1000, 1000)),
        expectedDepth: 0.5,
        tier: IRIDESCENCE_MAX_TIER,
      });
    } catch (e) {
      err = e;
    }
    ok(`the occlusion-gated graph CONSTRUCTS without throwing (${err ? err.message : 'clean'})`, err === null);
    if (withDepth) {
      ok('a depthTexNode is returned once a depth texture is wired', !!withDepth.depthTexNode);
      ok('uExpectedDepth carries the constructor value', withDepth.uniforms.uExpectedDepth.value === 0.5);
    }
  }
  ok(
    'with NO depth texture, depthTexNode is null — nothing to re-point, matching the established "empty below its own gating input" contract',
    built['2:0'].depthTexNode === null
  );
}
