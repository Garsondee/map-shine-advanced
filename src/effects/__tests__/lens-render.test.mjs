/**
 * lens-render.test.mjs — THE TSL GRAPH IS ACTUALLY CONSTRUCTED, IN NODE, AT
 * EVERY TIER.
 *
 * Same reasoning `fluid-sim-render.test.mjs`/`water-render.test.mjs`'s own
 * headers give: pure-maths test suites never once CALL the builder, so a
 * temporal-dead-zone error, a TSL export that moved, or a swizzle that does
 * not exist on a node can ship behind thousands of green assertions. This
 * proves the graph SURVIVES BEING BUILT at every tier — nothing about the
 * emitted WGSL, nothing about what it looks like on screen.
 */
import * as THREE from '../../vendor/three/three.webgpu.js';
import {
  buildLensCompositeMaterial,
  buildLightBurnAccumulateMaterial,
  lensTierPlan,
  LENS_MAX_TIER,
  LENS_DEFAULT_TIER,
} from '../lens-render.js';

/** A 1×1 texture — enough for a node to reference; never sampled here. */
function stubTexture() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
}

export function run(t) {
  const { ok } = t;

  // ── EVERY RUNG CONSTRUCTS ──────────────────────────────────────────────
  const built = {};
  for (const tier of [0, 1, 2, 3]) {
    let result = null;
    let err = null;
    try {
      result = buildLensCompositeMaterial({
        THREE,
        sceneTexture: stubTexture(),
        lightBurnTexture: stubTexture(),
        overlayTexture: stubTexture(),
        overlayNextTexture: stubTexture(),
        resolutionWidth: 1024,
        resolutionHeight: 768,
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
    ok(`tier ${tier}: reports the tier it was actually built at`, b.tier === tier);
    ok(
      `tier ${tier}: never depth-tests/writes — a fullscreen post quad has no depth story`,
      b.material.depthTest === false && b.material.depthWrite === false
    );
  }

  // ── EVERY DECLARED UNIFORM IS PRESENT AT EVERY TIER ─────────────────────
  // The uniforms object shape does not itself change per tier (Law 4 governs
  // the GRAPH structure, not which keys the JS return value has) — a caller
  // (`runPostLensPass`) can push into any of them unconditionally without a
  // tier check of its own.
  const expectedKeys = [
    'uDistortion',
    'uChromaticAmountPx',
    'uChromaticEdgePower',
    'uVignetteIntensity',
    'uVignetteSoftness',
    'uGrainAmount',
    'uGrainSpeed',
    'uAdaptiveGrainEnabled',
    'uGrainLowLightBoost',
    'uGrainCellSizeBright',
    'uGrainCellSizeDark',
    'uDigitalNoiseEnabled',
    'uDigitalNoiseAmount',
    'uDigitalNoiseChance',
    'uDigitalNoiseGreenBias',
    'uDigitalNoiseLowLightBoost',
    'uTimeSec',
    'uAutoFocusAmount',
    'uAutoFocusBlurPx',
    'uAutoFocusShiftPx',
    'uCameraMotionBlurPx',
    'uZoomMotionBlurPx',
    'uLightBurnIntensity',
    'uLightBurnBlurPx',
    'uOverlayIntensity',
    'uOverlayLumaReactivity',
    'uOverlayClearRadius',
    'uOverlayClearSoftness',
    'uOverlayDriftSpeed',
    'uOverlayCrossfade',
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

  // ── THE RE-POINTABLE TEXTURE NODES — the whole reason this file exists
  // rather than being folded into a one-liner. `sceneTexNode.sample()`
  // (used dozens of times inside the shader) must all derive from ONE base
  // node so a single `.value` re-point reaches every one of them. ────────
  for (const tier of [0, 1, 2, 3]) {
    const b = built[tier];
    ok(`tier ${tier}: returns sceneTexNode — proof there is a real re-pointable input`, !!b.sceneTexNode);
    ok(
      `tier ${tier}: sceneTexNode.value is a genuinely mutable reference (re-pointing works)`,
      (() => {
        const t2 = stubTexture();
        b.sceneTexNode.value = t2;
        return b.sceneTexNode.value === t2;
      })()
    );
  }
  ok(
    'lightBurnTexNode is null below tier 2 — nothing to re-point, not a built-then-ignored node',
    built[0].lightBurnTexNode === null && built[1].lightBurnTexNode === null
  );
  ok(
    'lightBurnTexNode is a real node at tier 2 and at tier 3',
    !!built[2].lightBurnTexNode && !!built[3].lightBurnTexNode
  );
  ok(
    'lightBurnTexNode.value re-points independently of sceneTexNode',
    (() => {
      const t2 = stubTexture();
      built[2].lightBurnTexNode.value = t2;
      return built[2].lightBurnTexNode.value === t2 && built[2].sceneTexNode.value !== t2;
    })()
  );

  // ── OVERLAY TEXTURE NODES (tier 3) — same "null below its own gating
  // tier" contract as lightBurnTexNode above. ─────────────────────────────
  ok(
    'overlayCurrentTexNode/overlayNextTexNode are null below tier 3',
    [0, 1, 2].every((tier) => built[tier].overlayCurrentTexNode === null && built[tier].overlayNextTexNode === null)
  );
  ok('both overlay nodes are real at tier 3', !!built[3].overlayCurrentTexNode && !!built[3].overlayNextTexNode);
  ok(
    'the two overlay nodes re-point independently of each other and of sceneTexNode',
    (() => {
      const tCurrent = stubTexture();
      const tNext = stubTexture();
      built[3].overlayCurrentTexNode.value = tCurrent;
      built[3].overlayNextTexNode.value = tNext;
      return (
        built[3].overlayCurrentTexNode.value === tCurrent &&
        built[3].overlayNextTexNode.value === tNext &&
        built[3].overlayCurrentTexNode.value !== built[3].overlayNextTexNode.value &&
        built[3].sceneTexNode.value !== tCurrent
      );
    })()
  );

  // ── A LIVE UNIFORM PUSH IS A PLAIN MUTABLE VALUE WRITE ──────────────────
  ok(
    'uDistortion.value is a genuinely mutable uniform, not frozen',
    (() => {
      const u = built[0].uniforms;
      u.uDistortion.value = 0.2;
      return u.uDistortion.value === 0.2;
    })()
  );
  ok(
    'uAutoFocusShiftPx is a vec2 uniform whose .value.set() works (the per-frame push shape runPostLensPass uses)',
    (() => {
      const u = built[1].uniforms;
      u.uAutoFocusShiftPx.value.set(3, -4);
      return u.uAutoFocusShiftPx.value.x === 3 && u.uAutoFocusShiftPx.value.y === -4;
    })()
  );

  // ── TIER 0 STILL CONSTRUCTS WITH DEFAULT (STUB) INPUTS — the "unwired
  // caller renders exactly as before" contract, same posture every other
  // effect's own tier-0 floor takes. ───────────────────────────────────────
  {
    let err = null;
    try {
      buildLensCompositeMaterial({
        THREE,
        sceneTexture: stubTexture(),
        lightBurnTexture: stubTexture(),
        resolutionWidth: 1,
        resolutionHeight: 1,
      });
    } catch (e) {
      err = e;
    }
    ok(
      `a caller that omits tier (falls back to LENS_DEFAULT_TIER=${LENS_DEFAULT_TIER}) constructs cleanly`,
      err === null
    );
  }

  // ── lensTierPlan — the gate a live profile change actually branches on ──
  {
    const p0 = lensTierPlan(0);
    ok(
      'tier 0: neither motion, light-burn nor overlay is enabled',
      !p0.motionEnabled && !p0.lightBurnEnabled && !p0.overlayEnabled
    );
    const p1 = lensTierPlan(1);
    ok('tier 1: motion on, light-burn/overlay not yet', p1.motionEnabled && !p1.lightBurnEnabled && !p1.overlayEnabled);
    const p2 = lensTierPlan(2);
    ok(
      'tier 2: motion + light-burn on, overlay not yet',
      p2.motionEnabled && p2.lightBurnEnabled && !p2.overlayEnabled
    );
    const p3 = lensTierPlan(LENS_MAX_TIER);
    ok('tier 3 (max): all three on', p3.motionEnabled && p3.lightBurnEnabled && p3.overlayEnabled);
    ok('non-finite input falls back to LENS_DEFAULT_TIER, not NaN', lensTierPlan(undefined).tier === LENS_DEFAULT_TIER);
    ok('clamps above the max', lensTierPlan(99).tier === LENS_MAX_TIER);
    ok('clamps below zero', lensTierPlan(-3).tier === 0);
  }

  // ── LIGHT-BURN ACCUMULATE MATERIAL — its own small graph ────────────────
  {
    let burnBuilt = null;
    let err = null;
    try {
      burnBuilt = buildLightBurnAccumulateMaterial({
        THREE,
        sceneTexture: stubTexture(),
        prevBurnTexture: stubTexture(),
      });
    } catch (e) {
      err = e;
    }
    ok(`light-burn accumulate material CONSTRUCTS without throwing (${err ? err.message : 'clean'})`, err === null);
    if (burnBuilt) {
      ok('returns a real NodeMaterial', burnBuilt.material?.isNodeMaterial);
      ok('carries a colorNode', !!burnBuilt.material.colorNode);
      ok(
        'returns BOTH re-pointable input nodes — a rebuilt caller re-pointing only one would leave the other stale forever',
        !!burnBuilt.sceneTexNode && !!burnBuilt.prevBurnTexNode
      );
      ok(
        'the two nodes re-point independently (never accidentally aliased to the same node)',
        (() => {
          const t2 = stubTexture();
          burnBuilt.prevBurnTexNode.value = t2;
          return burnBuilt.prevBurnTexNode.value === t2 && burnBuilt.sceneTexNode.value !== t2;
        })()
      );
      const keys = Object.keys(burnBuilt.uniforms);
      ok(
        'every expected light-burn uniform is present',
        ['uThreshold', 'uSoftness', 'uResponse', 'uDecayFactor', 'uBurnWriteGain'].every((k) => keys.includes(k))
      );
    }
  }
}
