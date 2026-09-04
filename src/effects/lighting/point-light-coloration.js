/**
 * POINT-LIGHT COLORATION — increment 3 of Type-A parity (2026-07-19,
 * docs/planning/Light-Parity.md §5, docs/reference/foundry-v14-lighting-
 * audit.md §6). The SEPARATE channel from illumination
 * (point-light-illumination.js): illumination is ambient-derived luminance,
 * MULTIPLIED onto the map (colour-agnostic — a red torch and a white torch
 * illuminate identically); coloration is the light's OWN authored `color`,
 * ADDED on top (brightness-agnostic — it never darkens anything). That
 * split is what lets a light be fully bright AND fully coloured at once
 * (audit's own "why bright AND colourful, stated plainly").
 *
 * DEFAULT TECHNIQUE ONLY (technique id 1, "Adaptive Luminance" — LightData's
 * own default, `common/data/data.mjs`), verbatim from source
 * (`base-lighting.mjs`'s technique table, this project's own audit §6):
 *
 *   finalColor = color * colorationAlpha        (FRAGMENT_BEGIN)
 *   finalColor *= reflection                    (technique 1's own line)
 *   reflection  = perceivedBrightness(mapColor)  (BT.709 luminance)
 *   outputColor = finalColor * falloff           (FALLOFF, then FRAGMENT_END)
 *
 * `colorationAlpha` is `alpha` remapped PER TECHNIQUE
 * (`computeColorationAlpha` below) — technique 1 falls in the "everything
 * else" bucket (`alpha*2`), verified against source, NOT guessed.
 *
 * VISIBILITY GATE — CORRECTED (2026-07-19, the "lights read monochrome"
 * bug): this module's own earlier note here conflated two different
 * `isRequired`-shaped things and, in doing so, mis-scoped the more important
 * one. Foundry's `AdaptiveColorationShader#isRequired` (coloration-
 * lighting.mjs) is a CPU-side check on the WHOLE layer — `forceDefaultColor
 * || hasColor`, `hasColor = data.color !== null` (rendered-effect-
 * source.mjs) — deciding whether this light's coloration MESH renders AT
 * ALL. Technique 1 ("Adaptive Luminance", built here) never sets
 * `forceDefaultColor` (only the other 12 "effect" techniques do), so a
 * colourless light's coloration layer never draws in real Foundry — full
 * stop, not "draws a neutral tint". That is SEPARATE from the CONTRAST/
 * SATURATION/SHADOW adjustments' own per-fragment runtime branch (`if
 * (shadows != 0.0)` etc., inside `ADJUSTMENTS`/`SHADOW` below `FALLOFF`),
 * which only ever gates those three specific tuned values, not the layer.
 * The layer-level gate is BUILT via the UNIFORM, not mesh visibility
 * (vt-pan-viewer.js's updatePointLightMeshes sets `uColorationAlpha = 0` for
 * a colourless light, so `finalColor` below is exactly 0 — no contribution;
 * `colorationMesh.visible` stays `true` always, after a mesh-visibility
 * toggle here was found to blank the whole scene live). It is fed by
 * foundry/scene-lights.js#deriveLightSnapshot's `hasColor` field — which only
 * became meaningful once the light COLOUR was read correctly (`source.colorRGB`,
 * not `source.data.color?.rgb` which was `undefined` for every light). See
 * [[keyhole-coloration-hascolor-fix]] for the full saga.
 *
 * NOT YET BUILT, this rung — documented, not silent:
 *   - the other 12 coloration techniques (burns/halos/absorption/natural
 *     light) — only the LightData default is reproduced.
 *   - CONTRAST/SATURATION adjustments (`ADJUSTMENTS`, audit §8) — these gate
 *     on non-default values Foundry itself skips by default (a per-fragment
 *     runtime check, NOT the layer-level `isRequired` above), so a light
 *     left at defaults is unaffected; a light with them tuned would
 *     currently show no effect from that tuning.
 *   - SHADOW is now BUILT (2026-07-21 — "coloured light bleaches black line
 *     art" author report). `coloration-lighting.mjs`'s own override (NOT the
 *     base 0.50–0.80 one background/illumination inherit — coloration's is
 *     its own, gated on `baseColor` = the raw MAP sample, not the light's
 *     own result): `mix(1, smoothstep(0.25, 0.35, perceivedBrightness(
 *     baseColor.rgb)), shadows)`. `baseColor` here is exactly this file's own
 *     `mapColor` (same texture, same sample); `perceivedBrightness(baseColor)`
 *     is exactly this file's own `reflection` — so the whole SHADOW term
 *     reuses values already computed below, no new texture read. `shadows`
 *     defaults to 0 (Foundry's own LightData default), so an un-tuned light
 *     is bit-for-bit unchanged; a GM raising a light's real "Shadows" field
 *     (already a native Light Config slider — MSA just wasn't reading it)
 *     now genuinely protects sub-0.25-brightness map pixels — e.g. ink-dark
 *     line art — from being additively tinted, same knob Foundry itself
 *     ships for this exact problem.
 *   - the analytic SDF soft edge (point-light-illumination.js's own) — the
 *     attenuation-based `falloff` alone still softens the visible edge, just
 *     without the extra silhouette antialiasing; a smaller, cosmetic gap.
 *   - the global light's OWN coloration (`GlobalLightData.color`/`coloration`
 *     ARE real scene-schema fields) — deferred; a rare, mostly-colourless-
 *     in-practice case, and the infrastructure below is reusable for it.
 *
 * BLEND MODE — a DOCUMENTED APPROXIMATION, not a verified match: real
 * Foundry SCREENs overlapping coloration meshes together (`result = src +
 * dst - src*dst`, strictly brighter than MAX for two positive overlapping
 * colours) before ADDing the accumulated result onto the scene. Reproducing
 * a true GPU screen-blend needs a custom `ONE_MINUS_DST_COLOR` blend factor
 * this session did not verify exists in this project's THREE build; MAX
 * (this module's own choice, mirroring illumination's own MAX-blend
 * precedent) is IDENTICAL to screen wherever at most one light's coloration
 * reaches a given pixel — the common case — and only under-brightens where
 * two OR MORE lights' coloration genuinely overlaps.
 *
 * ============================================================================
 * S2.1 (2026-08-11) — SPLIT INTO A SHARED CORE + A PER-LIGHT WRAPPER
 * ============================================================================
 * `docs/planning/Point-Light-Batching-Design.md` §3.2: `buildColorationShadingCore`
 * takes every per-light VALUE as an already-built NODE (`inputs`), the
 * pool-wide resources as-is (`shared`), and the graph-BUILD-time choices
 * that pick which terms even get constructed (`flags`) — it contains 100%
 * of the ARITHMETIC this module has ever had, unchanged, just no longer
 * responsible for deciding what kind of node backs each input. This is the
 * ONLY thing that makes a later BATCHED caller (S2.4: `inputs.*` are packed
 * per-vertex attributes instead of per-light uniforms) safe to add without a
 * second, hand-copied shading formula — the exact bug class named in the
 * design doc's §0 (`feedback_mode_forks_silently_drop_features`).
 *
 * `buildPointLightColorationMaterial` is now a THIN WRAPPER: it creates
 * every uniform this function has always created, in the exact same
 * conditions, then calls the core with those uniforms as `inputs` and
 * returns the exact same handle shape callers already destructure. Its own
 * behaviour — what gets built, in what order, under what condition — did
 * not change; only where each line lives did. `point-light-pool.js` is
 * completely unaware of this split: same import, same call, same return
 * shape, same per-frame `.value` writes.
 *
 * @module effects/lighting/point-light-coloration
 */

import { buildAnimationTimeNode } from './animations/light-animation-clock.js';
import { buildPointLightSharedTerms } from './point-light-illumination.js';
import { createWindHandle } from '../../world/index.js';

/** A bake-less handle so an un-wired caller still gets Tier-0 organic wind
 * rather than a wind-inert light — see candle-flame-render.js's own identical
 * constant for the full reasoning. */
const TIER0_WIND_HANDLE = createWindHandle();

/**
 * Foundry's per-technique `colorationAlpha` derivation, verbatim
 * (`base-light-source.mjs`, `_updateColorationUniforms`):
 *   technique 0 (Legacy):            alpha^2  (needs to be weak, washes out otherwise)
 *   techniques 4,5,6,9 (burns/invert): alpha
 *   everything else (default, 1):    alpha*2  (adaptive techniques read well in [0,2])
 *
 * @param {number} alpha01 - raw LightData.alpha, 0..1 (default 0.5).
 * @param {number} technique - the light's coloration technique id.
 * @returns {number}
 */
export function computeColorationAlpha(alpha01, technique) {
  const a = Math.min(1, Math.max(0, Number.isFinite(alpha01) ? alpha01 : 0.5));
  if (technique === 0) return a * a;
  if (technique === 4 || technique === 5 || technique === 6 || technique === 9) return a;
  return a * 2;
}

/**
 * THE SHADING CORE — every term this material has ever computed, taking
 * already-built per-light NODES rather than creating any itself. See this
 * module's own "S2.1" header for why the split exists and what it does and
 * does not change.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {object} args.inputs - per-light values, as NODES:
 *   `localUnitXY` (replaces every `positionLocal.xy` read — the per-light
 *   wrapper passes `positionLocal.xy` itself; a future batched caller passes
 *   a packed attribute instead), `attenuationEased`, `colorationAlpha`,
 *   `lightColor`, `expectedDepth`, `ratio` (the illumination twin's own base
 *   ratio — see the wrapper's own param doc), `anim`
 *   (`{speedRaw, reverseSign, seed, intensityRaw}` or `null` — null means
 *   this bucket/light has no animation seed, matching `animation?.
 *   buildColorationSeed` being absent), `wind`
 *   (`{center, exposure, response}` or `null`, opt-in, present only when
 *   BOTH `flags.animation` builds a seed AND wind was supplied — mirrors
 *   the original nested condition exactly).
 * @param {object} args.shared - pool-wide resources: `albedoTexture`,
 *   `depthTexNode`, `depthFlagsTexNode`, `apertureGoboShared`,
 *   `uGlobalTimeMs`, `windHandle`.
 * @param {object} args.flags - graph-BUILD-time choices: `animation` (the
 *   matched registry entry or null), `animationQuality`, `falloffModel`,
 *   `apertureCount`, `apGoboCols`, `apGoboRows`.
 * @returns {{finalNode: *, alphaNode: *, uApColLampHeight: (*|null), apColApertures: (Array|null)}}
 */
export function buildColorationShadingCore({ THREE, inputs, shared, flags }) {
  const { vec3, texture, screenUV, dot, sqrt, sRGBTransferOETF } = THREE.TSL;

  const { albedoTexture, depthTexNode, depthFlagsTexNode, apertureGoboShared, uGlobalTimeMs, windHandle } = shared;
  const {
    animation,
    animationQuality = 0,
    falloffModel = 'foundry',
    apertureCount = 0,
    apGoboCols,
    apGoboRows,
  } = flags;
  const {
    localUnitXY,
    attenuationEased: uAttenuationEased,
    colorationAlpha: uColorationAlpha,
    lightColor: uLightColor,
    expectedDepth: uLightExpectedDepth,
    ratio: uRatio,
    anim,
    wind: windInputs,
  } = inputs;

  // dist / FALLOFF / THE HEIGHT-ELEVATION GATE / APERTURE GOBO — S2.13
  // (Performance-Audit-2026-08.md §3.1): identical formula to point-light-
  // illumination.js's own (Foundry shares these terms across illumination
  // AND coloration verbatim — a point light is drawn by TWO meshes sharing
  // ONE geometry, and gating only the illumination half was the exact live
  // bug the author reported: "You are now correctly occluding the light
  // polygon. But you aren't correctly occluding the animated light source."
  // The gobo term lives the same way, for the same
  // `feedback_blend_neutral_element_is_per_blend` reason — see
  // `buildPointLightSharedTerms`'s own header, in point-light-
  // illumination.js, for the full account of all four terms now computed
  // there once for both channels). No `uRatio` feeds any of this — technique
  // 1 ("Adaptive Luminance") never reads ratio, that's an
  // illumination-channel-only (switchColor bright/dim) concept.
  const {
    dist,
    falloffGoboed: falloff,
    uApLampHeight: uApColLampHeight,
    apApertures: apColApertures,
  } = buildPointLightSharedTerms({
    THREE,
    localUnitXY,
    attenuationEased: uAttenuationEased,
    expectedDepth: uLightExpectedDepth,
    falloffModel,
    depthTexNode,
    depthFlagsTexNode,
    apertureCount,
    apGoboCols,
    apGoboRows,
    apertureGoboShared,
  });

  // Technique 1 ("Adaptive Luminance", the LightData default): the tint is
  // scaled by the underlying MAP pixel's own perceived brightness — BT.709
  // luminance, verbatim (`base-shader-mixin.mjs#PERCEIVED_BRIGHTNESS`:
  // sqrt(dot(BT709, c*c))).
  //
  // COLOUR SPACE (2026-07-19, part of the "single-hue wash" fix): Foundry
  // computes this on its PRIMARY texture, which is sRGB (its canvas has no
  // colour management). MSA's `buf:scene.color` is LINEAR (srgbDecode'd on
  // upload), so the raw sample here is linear — perceivedBrightness of a
  // linear value is systematically LOWER than of the same pixel in sRGB,
  // which would make the coloration weaker than Foundry's. OETF the sample
  // back to sRGB first so `reflection` matches Foundry's number exactly. This
  // is the coloration-side half of the gamma-space correction whose other
  // half is the gamma-space ADD in environmental-light.js's composite.
  const mapColor = sRGBTransferOETF(texture(albedoTexture, screenUV).rgb);
  const BT709 = vec3(0.2126, 0.7152, 0.0722);
  const reflection = sqrt(dot(BT709, mapColor.mul(mapColor)));

  // ANIMATION SEED INJECTION — see this function's own header. Absent
  // `animation`/`buildColorationSeed`: seedColor === defaultSeed, output is
  // unchanged from before this param existed.
  const defaultSeed = uLightColor.mul(uColorationAlpha);
  let seedColor = defaultSeed;
  if (animation?.buildColorationSeed) {
    const { speedRaw: uSpeedRaw, reverseSign: uReverseSign, seed: uSeed, intensityRaw: uIntensityRaw } = anim;
    const time = buildAnimationTimeNode(THREE.TSL, { uSpeedRaw, uReverseSign, uSeed, uGlobalTimeMs });
    // SHARED WIND (Wind.md Tier 0) — see point-light-illumination.js's own
    // identical block for the full "why"; OPT-IN on the same two params.
    let wind;
    let uWindResponse;
    if (windInputs) {
      uWindResponse = windInputs.response;
      wind = windHandle.node(THREE.TSL, {
        centerXY: windInputs.center,
        time: uGlobalTimeMs,
      });
    }
    const seeded = animation.buildColorationSeed({
      THREE,
      uLightColor,
      uColorationAlpha,
      dist,
      // THE FIX (2026-08-11) — see point-light-illumination.js's own
      // identical comment on this same param for the full account
      // (docs/planning/Point-Light-Batching-Design.md §3.6). NEVER
      // `positionLocal.xy` inside a seed builder — read this instead.
      localPosition: localUnitXY,
      defaultSeed,
      time,
      uIntensityRaw,
      uRatio,
      quality: animationQuality,
      wind,
      windResponse: uWindResponse,
    });
    seedColor = seeded.finalColor;
  }

  const techniqueColor = seedColor.mul(reflection);

  // TEMPORARY DIAGNOSTIC REVERT (2026-07-21) — the SHADOW term below is
  // suspected of causing a live "THREE.NodeBuilder: Uniform "null" not
  // implemented" build-time failure on EVERY point light (75 identical
  // errors, one per light, in a real mansion scene — `getForRender` catches
  // it and silently falls back to a blank material per light, which is what
  // "broke the lighting"). Isolating: this bypasses the shadow multiply
  // entirely so the author can confirm whether the error clears. If it does,
  // the bug is confirmed inside the block below and gets root-caused before
  // re-enabling, not re-added blindly. See keyhole-coloration-shadow-fix.md.
  // const shadowing = mix(float(1), smoothstep(float(0.25), float(0.35), reflection), uShadows);
  const finalColor = techniqueColor;
  const outputColor = finalColor.mul(falloff);

  return { finalNode: outputColor, alphaNode: falloff, uApColLampHeight, apColApertures };
}

/**
 * Build ONE point light's coloration material — the per-light WRAPPER. See
 * this module's own "S2.1" header: this function's job is now ONLY to
 * create the uniforms it has always created (unchanged conditions, unchanged
 * defaults) and hand them to {@link buildColorationShadingCore}; the shading
 * arithmetic itself lives there, not here.
 *
 * Fresh per-light uniforms (mirrors point-light-illumination.js's own
 * per-light pattern) — `uAttenuationEased` is a SMALL, deliberate duplication
 * of the illumination material's own (same light, same value) rather than
 * threading a shared node across two independently-built materials; the
 * extra per-frame uniform set is negligible and keeps each material builder
 * self-contained.
 *
 * Samples `albedoTexture` (this project's own `buf:scene.color`, the RAW
 * map — NOT the illuminated result: Foundry's illumination and coloration
 * channels both read the SAME base map independently, never each other's
 * output) via `screenUV` — this project's own already-proven technique for
 * a world-space-camera mesh sampling a same-camera fullscreen target (the
 * masks.occlusion producer's own `maskUV` fix uses the identical primitive).
 *
 * ANIMATION SEED INJECTION (2026-07-20) — mirrors point-light-illumination.js's
 * own seam, and its own header explains the general shape; the coloration-
 * specific wrinkle (verified against Foundry source, docs/reference/foundry-
 * v14-light-animations-audit.md) is that an animation's seed replaces ONLY
 * `color * colorationAlpha` (the `uLightColor.mul(uColorationAlpha)` below)
 * — the technique-1 `reflection` multiply (this file's own `finalColor`,
 * unchanged) STILL applies AFTER it, unconditionally, exactly like a
 * non-animated light. Foundry's own animated coloration shaders confirm
 * this: `${COLORATION_TECHNIQUES}` runs immediately after every animation's
 * seed line, never bypassed by it.
 *
 * GPU-ONLY ANIMATION (2026-07-20 rewrite — see point-light-illumination.js's
 * own header for the full "why", same reasoning applies here): `time` is
 * computed in-shader from small per-light raw uniforms
 * (`uSpeedRaw`/`uReverseSign`/`uSeed`) plus the ONE shared `uGlobalTimeMs`.
 * `uRatio` here is the light's own BASE (unjittered) ratio — Foundry hands
 * flicker-driven coloration shaders (torch/siren/flame/candleFlicker) the
 * SAME jittered ratio illumination gets, but since coloration has no
 * switchColor band to rebuild, those animations jitter it themselves
 * in-shader from this base value (a small, deliberate per-material
 * duplication of the same formula, matching this file's own existing
 * `uAttenuationEased` precedent).
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.albedoTexture - `buf:scene.color`'s texture.
 * @param {{buildColorationSeed: (function(object): {finalColor: *})}} [args.animation] -
 *   from effects/lighting/animations/registry.js's matched entry. When its
 *   `buildColorationSeed` is present it's called with `{THREE, uLightColor,
 *   uColorationAlpha, dist, defaultSeed, time, uIntensityRaw, uRatio}`
 *   (`defaultSeed` is the un-animated `uLightColor * uColorationAlpha`
 *   seed; `uRatio` is the light's own base ratio) and must return
 *   `{finalColor}`.
 * @param {*} [args.uGlobalTimeMs] - the ONE shared time uniform — REQUIRED
 *   when `animation` is present, unused otherwise.
 * @param {*} [args.uRatio] - the light's own base ratio uniform (from the
 *   illumination material's own `uRatio` — the caller's job to pass the
 *   SAME one through, so both channels agree on the light's true ratio).
 * @param {number} [args.animationQuality=0] - a graph-BUILD-time quality tier
 *   forwarded to the seed builder as `quality` (see point-light-
 *   illumination.js's own header for the no-uniform-gates rationale).
 * @param {'foundry'|'inverseSquare'|'inverseSquareWide'} [args.falloffModel='foundry'] - the radial
 *   falloff curve (see point-light-illumination.js's own param). Must match
 *   the illumination material's so both channels of a light fade together.
 * @param {{x:number,y:number}} [args.windCenter] - see point-light-
 *   illumination.js's own param of the same name (Wind.md Tier 0) — a SEPARATE
 *   `sampleWind` call from that module's (two independent shader graphs, the
 *   same small per-light duplication this file's own `uAttenuationEased`
 *   already takes), same inputs, so both channels lean together.
 * @param {number} [args.windExposure] - see point-light-illumination.js's own
 *   param of the same name. OPT-IN, paired with `windCenter`.
 * @param {object} [args.windHandle] - the wind handle (`world/wind-access.js`,
 *   Wind.md §5.1) — the ambient bias, Tier 1's baked openness, the
 *   wall-avoidance field and Tier 2's transient, as ONE object. Replaces the
 *   four separate arguments this used to forward by hand into `sampleWind`;
 *   this file and point-light-illumination.js are two of the four sites that
 *   carried that block verbatim. Omit → Tier-0 organic wind only.
 * @param {number} [args.windResponse] - see point-light-illumination.js's
 *   own identical param — the SAME value both channels should receive.
 * @param {*} [args.depthTexNode] - see point-light-illumination.js's own
 *   identical param (`buf:scene.depth`'s DEPTH attachment) — the height/
 *   elevation gate's primary input, STAGE 2 (2026-08-04). Omitted → that gate
 *   compiles out entirely, byte-identical to before it existed.
 * @param {*} [args.depthFlagsTexNode] - see point-light-illumination.js's own
 *   identical param (`buf:scene.depth`'s COLOUR attachment) — the gate's
 *   Tile-"Restrict Lighting" hard block. Omitted → that ONE block compiles
 *   out; the rank comparison alone still applies.
 * @returns {{material: *, uAttenuationEased: *, uColorationAlpha: *,
 *   uLightColor: *, uShadows: *, uLightExpectedDepth: *, uSpeedRaw: (*|null),
 *   uReverseSign: (*|null), uSeed: (*|null), uIntensityRaw: (*|null),
 *   uWindCenter: (*|null), uWindExposure: (*|null), uWindResponse: (*|null)}}
 */
export function buildPointLightColorationMaterial({
  THREE,
  albedoTexture,
  depthTexNode,
  depthFlagsTexNode,
  animation,
  uGlobalTimeMs,
  uRatio,
  animationQuality = 0,
  falloffModel = 'foundry',
  windCenter,
  windExposure,
  windResponse,
  windHandle = TIER0_WIND_HANDLE,
  apertureCount = 0,
  apGoboCols,
  apGoboRows,
  apertureGoboShared,
}) {
  const { uniform, vec2, vec3, vec4, float, positionLocal } = THREE.TSL;

  const uAttenuationEased = uniform(float(0.5));
  const uColorationAlpha = uniform(float(1));
  const uLightColor = uniform(vec3(1, 1, 1));
  const uShadows = uniform(float(0));
  const uLightExpectedDepth = uniform(float(0));

  let uSpeedRaw = null;
  let uReverseSign = null;
  let uSeed = null;
  let uIntensityRaw = null;
  let uWindCenter = null;
  let uWindExposure = null;
  let uWindResponse = null;
  if (animation?.buildColorationSeed) {
    uSpeedRaw = uniform(float(5));
    uReverseSign = uniform(float(1));
    uSeed = uniform(float(0));
    uIntensityRaw = uniform(float(5));
    // SHARED WIND (Wind.md Tier 0) — see point-light-illumination.js's own
    // identical block for the full "why"; OPT-IN on the same two params.
    if (Number.isFinite(windExposure)) {
      uWindCenter = uniform(vec2(windCenter?.x ?? 0, windCenter?.y ?? 0));
      uWindExposure = uniform(float(windExposure));
      // A THIRD wind uniform, same opt-in gate — see point-light-
      // illumination.js's own identical `windResponse` param doc.
      uWindResponse = uniform(float(Number.isFinite(windResponse) ? windResponse : 1));
    }
  }

  const { finalNode, alphaNode, uApColLampHeight, apColApertures } = buildColorationShadingCore({
    THREE,
    inputs: {
      localUnitXY: positionLocal.xy,
      attenuationEased: uAttenuationEased,
      colorationAlpha: uColorationAlpha,
      lightColor: uLightColor,
      expectedDepth: uLightExpectedDepth,
      ratio: uRatio,
      anim: uSpeedRaw
        ? { speedRaw: uSpeedRaw, reverseSign: uReverseSign, seed: uSeed, intensityRaw: uIntensityRaw }
        : null,
      wind: uWindCenter ? { center: uWindCenter, exposure: uWindExposure, response: uWindResponse } : null,
    },
    shared: { albedoTexture, depthTexNode, depthFlagsTexNode, apertureGoboShared, uGlobalTimeMs, windHandle },
    flags: { animation, animationQuality, falloffModel, apertureCount, apGoboCols, apGoboRows },
  });

  const material = new THREE.NodeMaterial();
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  // MAX-blend across overlapping lights — see this module's header for why
  // this is a documented approximation of Foundry's own SCREEN blend.
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.MaxEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  material.blendEquationAlpha = THREE.MaxEquation;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneFactor;
  // ALPHA = falloff, NOT a hardcoded 1 (fixed 2026-07-20 — docs/reference/
  // foundry-v14-light-animations-audit.md §3.2, found while researching
  // animated lights, unrelated to that feature itself). Real Foundry's
  // coloration FRAGMENT_END is `vec4(finalColor,1.0) * depth` — i.e. alpha
  // IS depth-after-falloff, fading to 0 at the light's edge exactly like the
  // RGB channels do, not a constant. Illumination's alpha (point-light-
  // illumination.js) is CORRECTLY hardcoded to 1 — that channel's own
  // FRAGMENT_END really is `vec4(mix(...), 1.0)`, verified against the same
  // source; the two channels are NOT symmetric here, don't "fix" both.
  // CONFIRMED INERT TODAY, fixed anyway: traced every reader of buf:scene.
  // coloration in this codebase (grep across src/) — the only consumer,
  // environmental-light.js's composite (`finalSrgb = litSrgb.add(
  // colorationTexNode.rgb)`), samples `.rgb` only, never `.a`/`.w`. So this
  // was real, stored, spec-wrong data with zero current visible effect —
  // worth correcting before a future alpha-aware consumer (a debug view, a
  // masking step) silently inherits the wrong contract.
  material.fragmentNode = vec4(finalNode, alphaNode);

  return {
    material,
    uAttenuationEased,
    uColorationAlpha,
    // The height gate's ONE per-light input — the SAME uniform name the
    // illumination twin exposes, so `point-light-pool.js` can push the one
    // resolved expected-depth into both materials without knowing which is
    // which.
    uLightExpectedDepth,
    uLightColor,
    uShadows,
    uSpeedRaw,
    uReverseSign,
    uSeed,
    uIntensityRaw,
    uWindCenter,
    uWindExposure,
    uWindResponse,
    // APERTURE GOBO (round 10) — `null` when this light has no apertures.
    // A SEPARATE uniform set from illumination's own `uApLampHeight`/
    // `apApertures` (this mesh's own material, own uniforms) — `point-
    // light-pool.js` writes the SAME per-frame aperture geometry into both,
    // the same duplication-across-the-mesh-pair pattern `uAttenuationEased`/
    // `uColorationAttenuationEased` already use.
    uApColLampHeight,
    apColApertures,
  };
}

/*
 * `buildColorationAddMaterial` (a fullscreen additive quad that blended the
 * coloration buffer onto buf:scene.lit) was REMOVED 2026-07-19. It added in
 * LINEAR space (the target buffer's space), which disproportionately lifted
 * the map's dark channels on display and washed the scene toward the light's
 * single hue. The coloration ADD now lives INSIDE environmental-light.js's
 * composite, in GAMMA space before the final EOTF — Foundry parity (Foundry's
 * coloration layer is an sRGB-space ADD). See that file's composite essay.
 */
