/**
 * LENS's SURFACE — the TSL fullscreen post material. THREE is INJECTED, never
 * imported (mythica-machina-press#57).
 *
 * ============================================================================
 * WHY THIS READS A SNAPSHOT AND HANDS BACK A NEW TEXTURE, NEVER scene.lit ITSELF
 * ============================================================================
 * Distortion and chromatic aberration RE-SAMPLE every pixel of the composited
 * frame at a SHIFTED coordinate — every output pixel can need any input pixel,
 * which a GPU cannot do by reading and writing the same texture in one draw
 * (undefined at best). The established fix already exists in this codebase:
 * `post.taaResolve` builds its OWN output texture and hands it to
 * `grade-present.js#setLitSource` — present reads whichever texture was named
 * last, a bare value swap, never a second write into `scene.lit`. This module
 * mirrors that shape exactly: `runPostLensPass` (vt-pan-viewer.js) reads
 * `gradePresent.getLitSource()` as this material's own input texture, renders
 * into a fresh scratch target, and re-points present at THAT.
 *
 * ============================================================================
 * WHAT EACH TERM IS, PORTED FROM V2's OWN SHADER
 * ============================================================================
 * `legacy/compositor-v2/effects/lens-shader.js` (recovered from git history,
 * `c328c9bd~1`) is the source of record for every formula below — not the
 * design doc's aspirational prose. Execution order, preserved from V2's own
 * file header:
 *
 *   1. Estimate scene luma (sparse 9-tap grid) — feeds the grain/noise
 *      adaptive boost below.
 *   2. Distort the sample UV (radial warp) and sample with chromatic
 *      aberration.
 *   3. Autofocus defocus — mixes in a 9-tap Kawase blur by `uAutoFocusAmount`.
 *   4. Camera motion blur — a 2-tap directional sample either side of centre.
 *   5. Vignette (screen-space, unaffected by the distortion above).
 *   6. Grain + optional digital sensor noise (luma-adaptive cell hash).
 *
 * The OVERLAY/light-leak CATALOG layer (`sampleOverlay`/`sampleOverlayCrossfade`
 * in V2's own shader) is NOT here — see `effects/lens.js`'s own header for why
 * that is an honest, recorded omission (a missing artist-authored texture
 * library, not a code gap) rather than a silently dropped feature.
 *
 * @module effects/lens-render
 */

/** Tier 0 (`optics`) default constants — every one is V2's OWN shipped
 * default (`LensEffectV2.js`'s own `this.params`), never a guess. */
export const LENS_TIER0_DISTORTION = -0.08;
export const LENS_TIER0_CHROMATIC_AMOUNT_PX = 4.22;
export const LENS_TIER0_CHROMATIC_EDGE_POWER = 2.11;
export const LENS_TIER0_VIGNETTE_INTENSITY = 1;
export const LENS_TIER0_VIGNETTE_SOFTNESS = 0.34;
export const LENS_TIER0_GRAIN_AMOUNT = 0.01;
export const LENS_TIER0_GRAIN_SPEED = 1;
export const LENS_TIER0_GRAIN_LOW_LIGHT_BOOST = 0.25;
export const LENS_TIER0_GRAIN_CELL_SIZE_BRIGHT = 1.4;
export const LENS_TIER0_GRAIN_CELL_SIZE_DARK = 3;
export const LENS_TIER0_DIGITAL_NOISE_AMOUNT = 0.066;
export const LENS_TIER0_DIGITAL_NOISE_CHANCE = 0.004;
export const LENS_TIER0_DIGITAL_NOISE_GREEN_BIAS = 1;
export const LENS_TIER0_DIGITAL_NOISE_LOW_LIGHT_BOOST = 3.37;

/** The distortion centre — V2's own default (screen centre) and, per
 * `effects/lens.js`'s own header, deliberately NOT promoted to an authored
 * param: nobody plausibly wants a camera lens whose own optical centre sits
 * somewhere other than the middle of the frame. A `vec2` literal, not a
 * uniform — Law 4: nothing here can change without a rebuild anyway. */
const LENS_DISTORTION_CENTER = [0.5, 0.5];

/** How many performance-cascade rungs this effect declares (0..2, `lens.js#LENS.tiers`). */
export const LENS_MAX_TIER = 2;

/** `resolveEffectTier(LENS, {profile: DEFAULT_PERFORMANCE_PROFILE})` resolves to —
 * `standard` reaches tier 0 only (motion needs `performance`... wait, `performance`
 * is BELOW `standard` in `PERFORMANCE_PROFILES`, so `standard` already includes
 * tier 1); light-burn (tier 2) needs `quality`. Used as the pass's own
 * pre-resolve fallback, mirroring every other effect's identical constant. */
export const LENS_DEFAULT_TIER = 1;

/**
 * The tier ladder, as a plan a builder can branch on — mirrors
 * `fluidTierPlan`/`specularTierPlan`'s own shape exactly.
 * @param {number} tier
 * @returns {{tier: number, motionEnabled: boolean, lightBurnEnabled: boolean}}
 */
export function lensTierPlan(tier) {
  const t = Number.isFinite(tier) ? Math.max(0, Math.min(LENS_MAX_TIER, Math.floor(tier))) : LENS_DEFAULT_TIER;
  return {
    tier: t,
    motionEnabled: t >= 1,
    lightBurnEnabled: t >= 2,
  };
}

/**
 * Build the light-burn accumulator material — a tiny fullscreen quad drawn
 * into ITS OWN ping-ponged pair (`vt-pan-viewer.js#runPostLensPass` owns the
 * two render targets and the swap), never into `scene.lit`. V2's own EXACT
 * formula (`lens-shader.js`'s inline light-burn fragment shader, embedded
 * directly in `LensEffectV2.js` — there is no separate file for it in V2
 * either): `max(previous · decay, freshBrightPass)`, a max-blend so a
 * lingering burn is never re-brightened past what its own decay allows, only
 * ever topped back up by a fresh bright source.
 *
 * @param {object} args
 * @param {*} args.THREE - injected.
 * @param {*} args.sceneTexture - THIS frame's composited scene (the same
 *   snapshot the main composite material reads, before distortion — light
 *   burn measures the UNDISTORTED frame, matching V2's own `tCurrentScene`).
 * @param {*} args.prevBurnTexture - last frame's written half of the
 *   ping-pong pair. ALWAYS a real texture — a 1×1 black stub before the
 *   first tick, never `null` (the established "no dead-null uniform"
 *   contract every ping-ponged texture in this codebase follows).
 * @returns {{material: *, sceneTexNode: *, prevBurnTexNode: *, uniforms:
 *   {uThreshold: *, uSoftness: *, uResponse: *, uDecayFactor: *,
 *   uBurnWriteGain: *}}} `sceneTexNode`/`prevBurnTexNode` — re-point BOTH
 *   every tick (`runPostLensPass`): `sceneTexNode` to the chain's current
 *   lit texture (same reason `buildLensCompositeMaterial`'s own
 *   `sceneTexNode` needs it), `prevBurnTexNode` to whichever half of the
 *   ping-pong pair is this tick's READ half — the identical "re-point, never
 *   rebuild" discipline `post.taaResolve`'s own history buffers already use.
 */
export function buildLightBurnAccumulateMaterial({ THREE, sceneTexture, prevBurnTexture }) {
  const { texture, uv, vec3, vec4, float, uniform, dot, max: maxNode, clamp, smoothstep } = THREE.TSL;

  const uThreshold = uniform(float(0.98));
  const uSoftness = uniform(float(0.5));
  const uResponse = uniform(float(1.15));
  const uDecayFactor = uniform(float(1.0));
  const uBurnWriteGain = uniform(float(1.0));

  const sceneTexNode = texture(sceneTexture, uv());
  const prevBurnTexNode = texture(prevBurnTexture, uv());
  const src = sceneTexNode.rgb;
  const prev = prevBurnTexNode.rgb.mul(clamp(uDecayFactor, 0, 1));
  // Rec. 709 luma, the SAME weights `lens-shader.js#estimateSceneLuma` and
  // every other luma read in this codebase already use.
  const luma = dot(src, vec3(0.2126, 0.7152, 0.0722));
  const gate = smoothstep(uThreshold.sub(uSoftness), uThreshold.add(uSoftness), luma);
  const fresh = src
    .mul(gate)
    .mul(maxNode(uResponse, float(0)))
    .mul(clamp(uBurnWriteGain, 0, 1));

  const material = new THREE.NodeMaterial();
  material.colorNode = vec4(maxNode(prev, fresh), 1);
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.toneMapped = false;

  return {
    material,
    sceneTexNode,
    prevBurnTexNode,
    uniforms: { uThreshold, uSoftness, uResponse, uDecayFactor, uBurnWriteGain },
  };
}

/**
 * Build the main lens composite material — reads one snapshot texture, writes
 * a full-frame transformed copy.
 *
 * @param {object} args
 * @param {*} args.THREE - injected.
 * @param {*} args.sceneTexture - the frame to process (`gradePresent.
 *   getLitSource()`'s current value at the moment this tick runs).
 * @param {*} args.lightBurnTexture - tier 2's own accumulator texture. A 1×1
 *   black stub below tier 2 or before light burn's first tick — ALWAYS real,
 *   the gate is `plan.lightBurnEnabled`, never a null check.
 * @param {number} args.resolutionWidth @param {number} args.resolutionHeight -
 *   the render target's own px size, for the texel-size math CA/grain/Kawase
 *   all need. Re-supplied by the caller on every resize (this builder does
 *   not itself watch for one).
 * @param {*} [args.tier] - `LENS_DEFAULT_TIER` default.
 * @returns {{material: *, sceneTexNode: *, lightBurnTexNode: (*|null),
 *   uniforms: object}} `sceneTexNode`/`lightBurnTexNode` — re-point every
 *   frame (`runPostLensPass`); see `sceneTexNode`'s own declaration comment,
 *   inside this function, for why there are exactly these two re-pointable
 *   nodes and not one per texture-read call site. `uniforms` — every live-tunable
 *   knob, keyed by `LENS_PARAMS` name (`u` + PascalCase), PLUS the four
 *   per-frame motion uniforms (`uAutoFocusAmount`, `uAutoFocusShiftPx`,
 *   `uCameraMotionBlurPx`, `uZoomMotionBlurPx`) tier 1 pushes fresh every
 *   frame and tier 0 never reads.
 */
export function buildLensCompositeMaterial({
  THREE,
  sceneTexture,
  lightBurnTexture,
  resolutionWidth,
  resolutionHeight,
  tier = LENS_DEFAULT_TIER,
}) {
  const plan = lensTierPlan(tier);
  const {
    texture,
    uv,
    vec2,
    vec3,
    vec4,
    float,
    uniform,
    clamp,
    smoothstep,
    mix,
    max: maxNode,
    length,
    dot,
    floor,
    fract,
    Fn,
  } = THREE.TSL;

  // ── UNIFORMS — every LENS_PARAMS knob this material actually reads ───────
  const uDistortion = uniform(float(LENS_TIER0_DISTORTION));
  const uChromaticAmountPx = uniform(float(LENS_TIER0_CHROMATIC_AMOUNT_PX));
  const uChromaticEdgePower = uniform(float(LENS_TIER0_CHROMATIC_EDGE_POWER));
  const uVignetteIntensity = uniform(float(LENS_TIER0_VIGNETTE_INTENSITY));
  const uVignetteSoftness = uniform(float(LENS_TIER0_VIGNETTE_SOFTNESS));
  const uGrainAmount = uniform(float(LENS_TIER0_GRAIN_AMOUNT));
  const uGrainSpeed = uniform(float(LENS_TIER0_GRAIN_SPEED));
  const uAdaptiveGrainEnabled = uniform(float(1));
  const uGrainLowLightBoost = uniform(float(LENS_TIER0_GRAIN_LOW_LIGHT_BOOST));
  const uGrainCellSizeBright = uniform(float(LENS_TIER0_GRAIN_CELL_SIZE_BRIGHT));
  const uGrainCellSizeDark = uniform(float(LENS_TIER0_GRAIN_CELL_SIZE_DARK));
  const uDigitalNoiseEnabled = uniform(float(0));
  const uDigitalNoiseAmount = uniform(float(LENS_TIER0_DIGITAL_NOISE_AMOUNT));
  const uDigitalNoiseChance = uniform(float(LENS_TIER0_DIGITAL_NOISE_CHANCE));
  const uDigitalNoiseGreenBias = uniform(float(LENS_TIER0_DIGITAL_NOISE_GREEN_BIAS));
  const uDigitalNoiseLowLightBoost = uniform(float(LENS_TIER0_DIGITAL_NOISE_LOW_LIGHT_BOOST));
  const uTimeSec = uniform(float(0));

  // Tier 1 — pushed FRESH every frame by `runPostLensPass` from
  // `lens-motion.js`'s own pure functions; 0/identity by construction until
  // the first real tick, which is what makes these safe to leave unwired.
  const uAutoFocusAmount = uniform(float(0));
  const uAutoFocusBlurPx = uniform(float(0));
  const uAutoFocusShiftPx = uniform(vec2(0, 0));
  const uCameraMotionBlurPx = uniform(vec2(0, 0));
  const uZoomMotionBlurPx = uniform(float(0));

  // Tier 2 — light burn's own live strength/softness (the ACCUMULATE material
  // above owns threshold/softness/response/decay; this is the read side).
  const uLightBurnIntensity = uniform(float(0.1));
  const uLightBurnBlurPx = uniform(float(8));

  const resolution = vec2(Math.max(1, resolutionWidth || 1), Math.max(1, resolutionHeight || 1));
  const texelSize = vec2(1, 1).div(resolution);
  // ⚠️ THE ONE REAL TEXTURE READ — every OTHER sample below (the luma grid,
  // every chromatic-aberration channel tap, the Kawase blur, motion blur)
  // derives from THIS node via `.sample(uv)`, never a fresh `texture(
  // sceneTexture, …)` call of its own. `TextureNode#sample` (three.webgpu.js)
  // clones with a `referenceNode` pointing back at THIS node's own base
  // rather than holding an independent `.value` — so re-pointing
  // `sceneTexNode.value` ONCE, every frame (`runPostLensPass`, vt-pan-
  // viewer.js), correctly re-points every one of the dozens of derived
  // samples below with it. Getting this wrong would mean tracking every
  // individual sample site by hand, the same trap `fluid-render.js`'s own
  // header names for its ping-ponged state texture ("a second UV needs a
  // genuinely second node the caller must track") — here multiplied by
  // every tap this shader takes, which is exactly why there is only ONE
  // real `texture(sceneTexture, …)` call in this entire file.
  const sceneTexNode = texture(sceneTexture, uv());

  // ── LUMA ESTIMATE — 9-tap sparse grid, V2's OWN exact sample points ──────
  // Cheap on purpose (V2's own comment: "zero CPU overhead") — a proper
  // downsampled luma buffer would be more accurate and is not worth it for
  // an adaptive-grain nicety.
  const LUM = vec3(0.2126, 0.7152, 0.0722);
  function sampleLuma(uvNode) {
    return dot(sceneTexNode.sample(uvNode).rgb, LUM);
  }
  const sceneLuma = sampleLuma(vec2(0.2, 0.2))
    .add(sampleLuma(vec2(0.5, 0.2)))
    .add(sampleLuma(vec2(0.8, 0.2)))
    .add(sampleLuma(vec2(0.2, 0.5)))
    .add(sampleLuma(vec2(0.5, 0.5)))
    .add(sampleLuma(vec2(0.8, 0.5)))
    .add(sampleLuma(vec2(0.2, 0.8)))
    .add(sampleLuma(vec2(0.5, 0.8)))
    .add(sampleLuma(vec2(0.8, 0.8)))
    .div(float(9))
    .toVar();

  // ── DISTORTION + CHROMATIC ABERRATION ─────────────────────────────────────
  // `radialDistort`: p offset from centre, scaled by (1 + k·|p|²) — V2's own
  // simple barrel/pincushion warp, exactly transcribed.
  const distortCenter = vec2(LENS_DISTORTION_CENTER[0], LENS_DISTORTION_CENTER[1]);
  const p = uv().sub(distortCenter);
  const distortedUv = distortCenter.add(p.mul(float(1).add(uDistortion.mul(dot(p, p))))).toVar();

  /** `sampleSceneWithCA` — red/blue split along the radial direction from
   * distortion centre, blue and red offset OPPOSITE ways, green stays the
   * untouched reference channel. Edge-weighted so the centre of frame stays
   * clean (V2's own `caEdge = pow(clamp(edgeR·1.9, 0, 1), edgePower)`). */
  function sampleSceneWithCA(sampleUv) {
    const clampedUv = clamp(sampleUv, vec2(0, 0), vec2(1, 1));
    const toCenter = clampedUv.sub(distortCenter);
    const edgeR = length(toCenter);
    const caDir = toCenter.div(maxNode(edgeR, float(1e-5)));
    const caEdge = clamp(edgeR.mul(1.9), 0, 1).pow(maxNode(uChromaticEdgePower, float(0.01)));
    const caDelta = caDir.mul(uChromaticAmountPx).mul(caEdge).mul(texelSize);
    const r = sceneTexNode.sample(clamp(clampedUv.add(caDelta), vec2(0, 0), vec2(1, 1))).r;
    const g = sceneTexNode.sample(clampedUv).g;
    const b = sceneTexNode.sample(clamp(clampedUv.sub(caDelta), vec2(0, 0), vec2(1, 1))).b;
    return vec3(r, g, b);
  }

  let focusUv = distortedUv;
  let sceneColor;
  /** `null` below tier 2 — nothing was built to re-point (see the return
   * value's own doc for why the caller needs this at all). */
  let lightBurnTexNode = null;

  if (plan.motionEnabled) {
    // ── AUTOFOCUS DEFOCUS — a Kawase-style 9-tap blur, mixed in by
    // `uAutoFocusAmount` (0 on the overwhelming majority of frames — see
    // `lens.js`'s own tier-1 doc for why the TAPS still only compile in
    // from this tier, even though the AMOUNT is a per-frame value, not a
    // per-tier one). ──────────────────────────────────────────────────────
    const focusShiftUv = uAutoFocusShiftPx.mul(texelSize).mul(clamp(uAutoFocusAmount, 0, 1));
    focusUv = clamp(distortedUv.add(focusShiftUv), vec2(0, 0), vec2(1, 1)).toVar();
    const kawaseBlur = Fn(() => {
      const r1 = maxNode(uAutoFocusBlurPx, float(0.001));
      const r2 = r1.mul(2);
      const d1 = texelSize.mul(r1);
      const d2 = texelSize.mul(r2);
      let accum = sampleSceneWithCA(focusUv).mul(0.2);
      accum = accum.add(sampleSceneWithCA(focusUv.add(vec2(d1.x, d1.y))).mul(0.12));
      accum = accum.add(sampleSceneWithCA(focusUv.add(vec2(d1.x.negate(), d1.y))).mul(0.12));
      accum = accum.add(sampleSceneWithCA(focusUv.add(vec2(d1.x, d1.y.negate()))).mul(0.12));
      accum = accum.add(sampleSceneWithCA(focusUv.add(vec2(d1.x.negate(), d1.y.negate()))).mul(0.12));
      accum = accum.add(sampleSceneWithCA(focusUv.add(vec2(d2.x, 0))).mul(0.08));
      accum = accum.add(sampleSceneWithCA(focusUv.add(vec2(d2.x.negate(), 0))).mul(0.08));
      accum = accum.add(sampleSceneWithCA(focusUv.add(vec2(0, d2.y))).mul(0.08));
      accum = accum.add(sampleSceneWithCA(focusUv.add(vec2(0, d2.y.negate()))).mul(0.08));
      return accum;
    })();
    const sharp = sampleSceneWithCA(focusUv);
    const focusAmount = clamp(uAutoFocusAmount, 0, 1);
    sceneColor = mix(sharp, kawaseBlur, focusAmount).toVar();

    // ── CAMERA MOTION BLUR — 2-tap directional sample either side of the
    // pan/zoom-driven offset (V2's own cheap approximation, not a real
    // multi-sample streak) — a genuine no-op at (0,0), which is what every
    // frame the camera is not moving reads. ──────────────────────────────
    const radialDir = uv().sub(vec2(0.5, 0.5));
    const radialDirSafe = radialDir.add(vec2(1e-5, 1e-5)).normalize();
    const motionUv = uCameraMotionBlurPx.add(radialDirSafe.mul(uZoomMotionBlurPx)).mul(texelSize);
    const mLen = length(motionUv);
    const mA = sampleSceneWithCA(focusUv.add(motionUv));
    const mB = sampleSceneWithCA(focusUv.sub(motionUv));
    const motionBlend = clamp(mLen.mul(2.2), 0, 0.65);
    sceneColor = mix(sceneColor, mA.add(mB).mul(0.5), motionBlend);
  } else {
    sceneColor = sampleSceneWithCA(distortedUv);
  }
  sceneColor = sceneColor.toVar();

  // ── LIGHT BURN (tier 2) — read at the UNDISTORTED uv (V2's own choice:
  // the burn is a property of the SENSOR, not the glass in front of it, so
  // it never shifts with the lens warp above), with a cheap 4-tap box blur
  // softening its own hard mask edge. ─────────────────────────────────────
  if (plan.lightBurnEnabled) {
    // Same `.sample()`-off-one-base-node discipline as `sceneTexNode` above
    // — 5 taps here (centre + 4 box-blur offsets), one real texture read.
    // Declared with `let` ABOVE this block (not `const` here) so the
    // RETURN value below can hand it back for re-pointing — `null` when
    // this tier never ran is the same "empty below tier N" contract
    // `fluid-render.js`'s own `stateTexNodes` uses.
    lightBurnTexNode = texture(lightBurnTexture, uv());
    const burnStep = texelSize.mul(uLightBurnBlurPx);
    const centreUv = uv();
    const blurred = lightBurnTexNode
      .sample(clamp(centreUv.add(vec2(burnStep.x, 0)), vec2(0, 0), vec2(1, 1)))
      .rgb.mul(0.25)
      .add(lightBurnTexNode.sample(clamp(centreUv.sub(vec2(burnStep.x, 0)), vec2(0, 0), vec2(1, 1))).rgb.mul(0.25))
      .add(lightBurnTexNode.sample(clamp(centreUv.add(vec2(0, burnStep.y)), vec2(0, 0), vec2(1, 1))).rgb.mul(0.25))
      .add(lightBurnTexNode.sample(clamp(centreUv.sub(vec2(0, burnStep.y)), vec2(0, 0), vec2(1, 1))).rgb.mul(0.25));
    const burn = mix(lightBurnTexNode.sample(centreUv).rgb, blurred, 0.75);
    sceneColor = sceneColor.add(burn.mul(uLightBurnIntensity));
  }

  // ── VIGNETTE — screen-space, unaffected by the distortion above (V2's
  // own choice: the vignette is the LENS BARREL's own shadow, which stays
  // fixed to the frame edge regardless of what the glass does to the image
  // inside it). ──────────────────────────────────────────────────────────
  const vDist = length(uv().sub(vec2(0.5, 0.5)));
  const vig = smoothstep(maxNode(uVignetteSoftness, float(0.01)), float(0.95), vDist);
  sceneColor = sceneColor.mul(mix(float(1), float(1).sub(uVignetteIntensity), vig));

  // ── GRAIN + DIGITAL NOISE — V2's OWN exact hash (`hash12`), transcribed
  // rather than swapped for a library primitive: this is a per-pixel PRNG
  // dither, not a noise FIELD (Law 8 governs the latter, not the former —
  // there is no vendored MaterialX "cheap per-pixel hash" this would be
  // duplicating). ────────────────────────────────────────────────────────
  const hash12 = Fn(([pIn]) => {
    let p3 = fract(vec3(pIn.x, pIn.y, pIn.x).mul(0.1031));
    p3 = p3.add(dot(p3, vec3(p3.y, p3.z, p3.x).add(33.33)));
    return fract(p3.x.add(p3.y).mul(p3.z));
  });

  const lowLight = clamp(float(1).sub(sceneLuma), 0, 1);
  const adaptiveMix = mix(float(0), lowLight, uAdaptiveGrainEnabled);
  const grainBoost = float(1).add(adaptiveMix.mul(maxNode(uGrainLowLightBoost, float(0))));
  const cellPx = mix(maxNode(uGrainCellSizeBright, float(1)), maxNode(uGrainCellSizeDark, float(1)), adaptiveMix);
  const pixelCoord = floor(uv().mul(resolution).div(cellPx));
  const grainT = floor(uTimeSec.mul(maxNode(uGrainSpeed, float(0))).mul(24));
  const n = hash12(pixelCoord.add(vec2(grainT, grainT.mul(1.618033))));
  // No extra `uGrainAmount > 0.0001` gate here, unlike V2's own GLSL `if` —
  // that guarded WORK (skip the hash entirely below threshold), not the
  // MATH; `grainTerm` already carries `uGrainAmount` as a factor, so it is
  // already ~0 there. A shader graph has no per-pixel branch to skip work
  // with in the first place (Effects.md Law 4 governs the GRAPH-BUILD gate,
  // tier 0 vs no tier 0 — not a runtime amount).
  const grainTerm = n.sub(0.5).mul(2).mul(uGrainAmount).mul(grainBoost);
  sceneColor = sceneColor.add(grainTerm);

  const chance = clamp(
    uDigitalNoiseChance.mul(float(1).add(lowLight.mul(maxNode(uDigitalNoiseLowLightBoost, float(0))))),
    0,
    1
  );
  const glitchGate = float(1)
    .sub(chance)
    .step(hash12(pixelCoord.add(vec2(grainT.mul(0.37), 11.17))));
  const signMix = mix(float(-1), float(1), hash12(pixelCoord.add(vec2(7.1, grainT.mul(0.13)))));
  const chromaR = mix(float(0.25), float(1), hash12(pixelCoord.add(vec2(13.7, 1.1))));
  const chromaGRaw = mix(float(0.35), float(1), hash12(pixelCoord.add(vec2(3.2, 9.4))));
  const chromaB = mix(float(0.25), float(1), hash12(pixelCoord.add(vec2(8.8, 5.6))));
  const greenBias = clamp(uDigitalNoiseGreenBias, 0, 1);
  const chromaG = mix(chromaGRaw, maxNode(chromaR, chromaB).mul(1.2).add(0.2), greenBias);
  const chroma = maxNode(vec3(chromaR, chromaG, chromaB), vec3(0.0001, 0.0001, 0.0001)).normalize();
  const glitchAmp = uDigitalNoiseAmount.mul(float(0.35).add(lowLight.mul(0.65)));
  const digitalTerm = chroma.mul(signMix).mul(glitchAmp).mul(glitchGate).mul(uDigitalNoiseEnabled);
  sceneColor = sceneColor.add(digitalTerm);

  const material = new THREE.NodeMaterial();
  material.colorNode = vec4(sceneColor, 1);
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.toneMapped = false;

  return {
    material,
    tier: plan.tier,
    // THE RE-POINTABLE INPUT NODES — see `sceneTexNode`'s own declaration
    // comment for why there are only these two, not dozens. The caller
    // (`runPostLensPass`) re-points BOTH every frame:
    // `sceneTexNode.value = gradePresent.getLitSource()` (the chain's
    // current lit texture, which changes IDENTITY whenever TAA is active)
    // and, when tier 2 built it, `lightBurnTexNode.value = <this tick's
    // READ half of the ping-pong pair>`. `lightBurnTexNode` is `null` below
    // tier 2 — nothing to re-point, mirroring `fluid-render.js`'s own
    // `stateTexNodes` contract exactly.
    sceneTexNode,
    lightBurnTexNode,
    uniforms: {
      uDistortion,
      uChromaticAmountPx,
      uChromaticEdgePower,
      uVignetteIntensity,
      uVignetteSoftness,
      uGrainAmount,
      uGrainSpeed,
      uAdaptiveGrainEnabled,
      uGrainLowLightBoost,
      uGrainCellSizeBright,
      uGrainCellSizeDark,
      uDigitalNoiseEnabled,
      uDigitalNoiseAmount,
      uDigitalNoiseChance,
      uDigitalNoiseGreenBias,
      uDigitalNoiseLowLightBoost,
      uTimeSec,
      uAutoFocusAmount,
      uAutoFocusBlurPx,
      uAutoFocusShiftPx,
      uCameraMotionBlurPx,
      uZoomMotionBlurPx,
      uLightBurnIntensity,
      uLightBurnBlurPx,
    },
  };
}
