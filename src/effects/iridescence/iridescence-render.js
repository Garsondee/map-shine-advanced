/**
 * IRIDESCENCE's SURFACE — the TSL per-item material. THREE is INJECTED, never
 * imported (mythica-machina-press#136).
 *
 * ============================================================================
 * WHAT EACH TIER SHOWS
 * ============================================================================
 * Tier 0 (sheen) is the mask gate alone — a flat, unmoving pastel tint inside
 * whatever the author painted `_Iridescence` onto (`phase` pinned at 0, so
 * `computeRainbowColor(0, …)` reads a fixed colour). Tier 1 (flow) turns on
 * the REAL procedural phase field — the screen-space sweep, one of the two
 * noise flavours, the mask's own distortion contribution, the flowing clock
 * term and camera parallax (`iridescence-motion.js#computePhase`) — which is
 * what actually makes the surface read as a shifting oil-slick/soap-bubble
 * sheen rather than a static tinted patch. Tier 2 (spectral) turns on REAL
 * light reactivity: a `buf:scene.illum` sample at this fragment's own screen
 * position dims the rainbow in the dark unless `ignoreDarkness` overrides it
 * (`iridescence-motion.js`'s own header has the full `buf:scene.illum`
 * decision).
 *
 * ============================================================================
 * WHAT V2 DID, AND WHAT IS DELIBERATELY DIFFERENT HERE
 * ============================================================================
 * `legacy/compositor-v2/effects/IridescenceEffectV2.js` (recovered from git
 * history, `c328c9bd~1`) ran its own `MAX_LIGHTS = 64` per-light loop
 * (position/colour/radius/falloff uniform arrays, refreshed on every Foundry
 * light hook) to answer "how lit is this fragment" — because V2 had no shared
 * illumination buffer of its own. This engine already has one
 * (`buf:scene.illum`, `graph/passes.js#light.accumulate`), the SAME buffer
 * `surface.response`'s (Specular's) own note describes reading for its own
 * light-reactive direction trick. One `texture(illumTexture)` sample replaces
 * V2's whole per-light-array mechanism — real light reactivity for a fraction
 * of the code and no new light-feeding infrastructure. A genuine per-light
 * system (V2's own loop, reproduced faithfully) is a real, separate, bigger
 * undertaking, noted as a follow-up rather than attempted here.
 *
 * Unlike `prism-render.js`'s own tier 3 (a genuine dependent read of a
 * PREVIOUS-frame CAPTURE of `buf:scene.color`, because that buffer is still
 * being written when Prism's own tier 3 would need it), `buf:scene.illum` is
 * a plain, already-finished target by the time the `surface` stage runs
 * (`light.accumulate` runs earlier in the SAME frame) — so this tier needs no
 * capture subsystem at all, just an ordinary texture sample, the identical
 * shape `specular-render.js`'s own `illumSample` read already uses.
 *
 * ============================================================================
 * BLEND MODE — A DELIBERATE DIVERGENCE FROM PRISM
 * ============================================================================
 * V2 shipped this effect as a pure ADD (`THREE.AdditiveBlending`, no depth
 * test — `IridescenceEffectV2.js#_createOverlay`), never a replace: a
 * soap-bubble sheen ADDS spectral colour onto whatever is beneath it, unlike
 * Prism's glass which REPLACES the view through it with a refracted one. Kept
 * exactly that blend mode here (`fluid-render.js`'s own emissive half is the
 * established precedent for an additive TSL surface material in this
 * codebase) rather than Prism's own plain alpha blend.
 *
 * @module effects/iridescence/iridescence-render
 */

import { iridescenceTierPlan, IRIDESCENCE_DEFAULT_TIER, IRIDESCENCE_MAX_TIER } from './iridescence-motion.js';

export { iridescenceTierPlan, IRIDESCENCE_DEFAULT_TIER, IRIDESCENCE_MAX_TIER };

/**
 * Build the Iridescence surface material for ONE item's own mesh (mirrors
 * `buildPrismSurfaceMaterial`'s own per-item shape — Iridescence v1 is
 * TILE-only, `iridescence-seams.js`'s own header has the full account of why).
 *
 * @param {object} args
 * @param {*} args.THREE - injected.
 * @param {*} args.maskTexture - this item's own authored `_Iridescence` file
 *   (`scene/mask-catalog.js`'s `iridescence` kind), loaded `channels: 'rgb'`
 *   the identical way Prism's own mask is — real RGBA data despite the name
 *   (`vt/mask-image.js`'s own header), which is why `.a` below is genuine.
 * @param {*} [args.illumTexture] - `buf:scene.illum`. Optional: a JS-time
 *   branch compiles the whole light-reactivity gate OUT when absent
 *   (`tsl/no-uniform-gates`), mirroring `depthTexture`'s own contract below —
 *   an unwired caller renders at full, unshadowed brightness rather than
 *   crashing.
 * @param {*} [args.depthTexture] - `buf:scene.depth`, for the SAME
 *   rank-gate occlusion window every other depth-authority consumer uses
 *   (`prism-render.js`'s own identical block) — this IS the "token occlusion
 *   cutout" V2 needed a dedicated token mask for: a token standing on top of
 *   the painted sheen is drawn into `buf:scene.depth` at a higher rank and
 *   correctly occludes it, no separate mask required.
 * @param {*} [args.uViewRect] - the SHARED view-rect uniform NODE
 *   (`envLight.uViewRect`), passed BY REFERENCE — see `buildPrismSurfaceMaterial`'s
 *   own identical doc for why this is never a private uniform rebuilt here.
 *   Needed for the screen-space UV the occlusion gate, the illum sample AND
 *   the phase field's own diagonal sweep all share (this module's own header).
 * @param {number} [args.expectedDepth] - this item's own depth-authority rank.
 * @param {number} [args.noiseType] - `IRIDESCENCE_PARAMS.noiseType`'s own
 *   build-time value (0 Liquid, 1 Glitter). A genuine JS-time branch
 *   (`tsl/no-uniform-gates`), not a uniform — mirrors `prism-render.js`'s own
 *   `facetAnimate` reasoning exactly: the two flavours are genuinely
 *   different formulas (`iridescence-motion.js#computeNoiseOffset`'s own
 *   doc), so selecting between them changes the GRAPH, not a per-frame
 *   amount. Defaults `0` (Liquid, V2's own shipped default).
 * @param {number} [args.tier] - `IRIDESCENCE_DEFAULT_TIER` default.
 * @returns {{material: *, tier: number, maskTexNode: *, illumTexNode: (*|null),
 *   depthTexNode: (*|null), uniforms: object}} `maskTexNode`/`illumTexNode`/
 *   `depthTexNode` — re-point every frame the caller has a fresh texture
 *   identity for, mirroring `buildPrismSurfaceMaterial`'s own contract.
 */
export function buildIridescenceSurfaceMaterial({
  THREE,
  maskTexture,
  illumTexture,
  depthTexture,
  uViewRect,
  expectedDepth = 0,
  noiseType = 0,
  tier = IRIDESCENCE_DEFAULT_TIER,
}) {
  const plan = iridescenceTierPlan(tier);
  const {
    texture,
    uv,
    vec2,
    vec3,
    float,
    uniform,
    clamp,
    smoothstep,
    mix,
    max: maxNode,
    dot,
    floor,
    sin,
    cos,
    step,
    positionWorld,
  } = THREE.TSL;

  // ── UNIFORMS — every IRIDESCENCE_PARAMS knob this material actually reads ──
  const uMaskThreshold = uniform(float(0.4));
  const uInvertMask = uniform(float(0));
  const uAlpha = uniform(float(0.9));
  const uIntensity = uniform(float(0.5));
  const uDistortionStrength = uniform(float(0.13));
  const uNoiseScale = uniform(float(0.44));
  const uFlowSpeed = uniform(float(0.15));
  const uPhaseMult = uniform(float(6));
  const uColorCycleSpeed = uniform(float(0.25));
  const uAngle = uniform(float(0));
  const uParallaxStrength = uniform(float(4.31));
  const uIgnoreDarkness = uniform(float(0.6));

  // Per-frame values, pushed fresh once the real pass ticks — 0 by
  // construction until then, the same "safe to leave unwired" contract
  // `prism-render.js`'s own `uTimeSec`/`uCameraOffsetPx` document.
  const uTimeSec = uniform(float(0));
  // The camera's OWN absolute world-space centre, NOT a delta — see this
  // module's own header / `iridescence-motion.js#computePhase`'s own doc for
  // why Iridescence's parallax term wants the absolute position V2 itself fed.
  const uCameraOffset = uniform(vec2(0, 0));

  const uExpectedDepth = uniform(float(expectedDepth));

  // ── THE MASK — this item's OWN uv(), a tile's `_Iridescence` file mounted
  // 1:1 on its own mesh, the identical convention `prism-render.js`'s own
  // `maskTexNode` uses. ─────────────────────────────────────────────────────
  const maskTexNode = texture(maskTexture, uv());
  const maskRgb = maskTexNode.rgb;
  const maskAlpha = maskTexNode.a;
  // `max(luminance, peak-channel) * alpha` — V2's own deliberate formula,
  // never alpha-only (`iridescence-motion.js#computeMaskPresence`'s own doc
  // has the full "opaque black padding" trap this avoids).
  const maskLuma = clamp(dot(maskRgb, vec3(0.299, 0.587, 0.114)), 0, 1);
  const maskPeak = maxNode(maxNode(maskRgb.r, maskRgb.g), maskRgb.b);
  const rgbBright = maxNode(maskLuma, maskPeak);
  const invertedBright = float(1).sub(rgbBright);
  const maskT = mix(rgbBright, invertedBright, clamp(uInvertMask, 0, 1));
  const rawMask = maskT.mul(clamp(maskAlpha, 0, 1));
  const maskVal = smoothstep(uMaskThreshold, float(1), rawMask).toVar('iridMaskVal');

  // ── THE SHARED SCREEN-SPACE UV — the depth-occlusion gate, the illum
  // sample AND the phase field's own diagonal sweep all read the SAME
  // world-position-derived screen UV, byte-for-byte `prism-render.js`'s own
  // occlusion-gate formula (this module's own header explains why this
  // substitutes for V2's own `gl_FragCoord/uResolution`). ────────────────────
  let screenUv = vec2(0.5, 0.5);
  let notOccluded = float(1);
  if (uViewRect) {
    const viewSpanX = maxNode(uViewRect.z.sub(uViewRect.x), float(1));
    const viewSpanY = maxNode(uViewRect.w.sub(uViewRect.y), float(1));
    const screenU = positionWorld.x.sub(uViewRect.x).div(viewSpanX);
    const screenV = positionWorld.y.sub(uViewRect.y).div(viewSpanY);
    screenUv = vec2(clamp(screenU, 0, 1), clamp(screenV, 0, 1));
  }
  if (depthTexture && uViewRect) {
    const depthHere = texture(depthTexture, screenUv);
    // `step(edge,x) = x>=edge ? 1:0` — "is the stored depth at this pixel AT
    // OR ABOVE my own rank" — 1 unless a token/upper floor is drawn over it.
    // THIS is the "token occlusion cutout" the effect brief asks for,
    // identical in shape to Prism's own — see this function's own `depthTexture` doc.
    notOccluded = step(uExpectedDepth, depthHere);
  }

  let baseColor = vec3(0.5, 0.5, 0.5).toVar('iridBaseColor');

  if (plan.flowEnabled) {
    // ── THE NOISE FLAVOUR — a JS-time branch, a genuinely different formula
    // per flavour (this function's own `noiseType` doc). ───────────────────
    const worldXY = vec2(positionWorld.x, positionWorld.y).mul(uNoiseScale);
    let randomOffset;
    if (Number(noiseType) === 0) {
      // "Liquid" — V2's own two-octave sine field, rotated by the golden
      // angle (`iridescence-motion.js#computeLiquidNoise`'s own doc).
      const PHI = 1.61803398875;
      const cosPhi = Math.cos(PHI);
      const sinPhi = Math.sin(PHI);
      const rx = worldXY.x.mul(cosPhi).sub(worldXY.y.mul(sinPhi));
      const ry = worldXY.x.mul(sinPhi).add(worldXY.y.mul(cosPhi));
      const n1 = sin(rx).mul(cos(ry));
      const n2 = sin(rx.mul(2.7).add(1.3)).mul(cos(ry.mul(2.7).sub(0.7)));
      randomOffset = n1.add(n2.mul(0.5)).mul(1.5);
    } else {
      // "Glitter" — V2's own per-grid-cell hash jitter
      // (`iridescence-motion.js#computeGlitterNoise`'s own doc).
      const hash1 = (p) => {
        const s = sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453);
        return s.sub(floor(s));
      };
      const gridPos = floor(worldXY);
      const jitter = vec2(hash1(gridPos.add(vec2(13.1, 13.1))), hash1(gridPos.add(vec2(91.7, 91.7))));
      randomOffset = hash1(gridPos.add(jitter));
    }

    // ── THE PHASE FIELD — `iridescence-motion.js#computePhase`'s own five
    // terms, transcribed into TSL. `uAngle` is authored in DEGREES (V2's own
    // 0-360 UI convention, `IRIDESCENCE_PARAMS.angleDeg`) and converted to
    // radians right here — the same "keep the uniform in the authored unit,
    // convert inside the graph" convention `window-render.js#
    // uGlassStriationAngle` already uses, rather than a second converted
    // uniform. ───────────────────────────────────────────────────────────
    const angleRad = uAngle.mul(Math.PI / 180);
    const diagonalSweep = screenUv.x.mul(cos(angleRad)).add(screenUv.y.mul(sin(angleRad)));
    const parallaxTerm = uCameraOffset.x.add(uCameraOffset.y).mul(0.001).mul(uParallaxStrength);
    const phase = diagonalSweep
      .add(randomOffset)
      .add(maskVal.mul(uDistortionStrength))
      .add(uTimeSec.mul(uFlowSpeed))
      .add(parallaxTerm);

    // ── THE RAINBOW — V2's own Inigo-Quilez-style cosine palette
    // (`iridescence-motion.js#computeRainbowColor`'s own doc). ─────────────
    const colorPhase = phase.mul(uColorCycleSpeed);
    const k = colorPhase.mul(6.28).mul(uPhaseMult);
    baseColor = vec3(
      float(0.5).add(float(0.5).mul(cos(k))),
      float(0.5).add(float(0.5).mul(cos(k.add(2.0)))),
      float(0.5).add(float(0.5).mul(cos(k.add(4.0))))
    ).toVar('iridBaseColor');
  }

  let litFactor = float(1);
  let illumTexNode = null;
  if (plan.lightReactiveEnabled && illumTexture) {
    // `buf:scene.illum` at this fragment's own screen position — see this
    // module's own header for the full `buf:scene.illum` decision.
    illumTexNode = texture(illumTexture);
    const illumSample = illumTexNode.sample(screenUv).rgb;
    const illumLuma = dot(illumSample, vec3(0.299, 0.587, 0.114));
    // V2's own `mix(lightLuma, 1.0, ignoreDarkness)` — `iridescence-motion.js
    // #computeLitFactor`'s own doc.
    litFactor = mix(illumLuma, float(1), clamp(uIgnoreDarkness, 0, 1));
  }

  const finalColor = baseColor.mul(litFactor);
  const opacityTerm = maskVal
    .mul(clamp(uAlpha, 0, 1))
    .mul(clamp(uIntensity, 0, 1))
    .mul(notOccluded)
    .toVar('iridOpacity');

  const material = new THREE.NodeMaterial();
  material.colorNode = finalColor;
  material.opacityNode = opacityTerm;
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.toneMapped = false;
  // A pure ADD, never a replace — this module's own "BLEND MODE" header.
  material.blending = THREE.AdditiveBlending;

  return {
    material,
    tier: plan.tier,
    maskTexNode,
    illumTexNode,
    depthTexNode: depthTexture ? texture(depthTexture, uv()) : null,
    uniforms: {
      uMaskThreshold,
      uInvertMask,
      uAlpha,
      uIntensity,
      uDistortionStrength,
      uNoiseScale,
      uFlowSpeed,
      uPhaseMult,
      uColorCycleSpeed,
      uAngle,
      uParallaxStrength,
      uIgnoreDarkness,
      uTimeSec,
      uCameraOffset,
      uExpectedDepth,
    },
  };
}
