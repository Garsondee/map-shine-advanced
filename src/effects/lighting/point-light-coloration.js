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
 *   - CONTRAST/SATURATION/SHADOW adjustments (`ADJUSTMENTS`, audit §8) —
 *     these gate on non-default values Foundry itself skips by default (a
 *     per-fragment runtime check, NOT the layer-level `isRequired` above),
 *     so a light left at defaults is unaffected; a light with them tuned
 *     would currently show no effect from that tuning.
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
 * @module effects/lighting/point-light-coloration
 */

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
 * Build ONE point light's coloration material (technique 1 only — see this
 * module's header). Fresh per-light uniforms (mirrors point-light-
 * illumination.js's own per-light pattern) — `uAttenuationEased` is a SMALL,
 * deliberate duplication of the illumination material's own (same light,
 * same value) rather than threading a shared node across two independently-
 * built materials; the extra per-frame uniform set is negligible and keeps
 * each material builder self-contained.
 *
 * Samples `albedoTexture` (this project's own `buf:scene.color`, the RAW
 * map — NOT the illuminated result: Foundry's illumination and coloration
 * channels both read the SAME base map independently, never each other's
 * output) via `screenUV` — this project's own already-proven technique for
 * a world-space-camera mesh sampling a same-camera fullscreen target (the
 * masks.occlusion producer's own `maskUV` fix uses the identical primitive).
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.albedoTexture - `buf:scene.color`'s texture.
 * @returns {{material: *, uAttenuationEased: *, uColorationAlpha: *, uLightColor: *}}
 */
export function buildPointLightColorationMaterial({ THREE, albedoTexture }) {
  const {
    uniform,
    vec3,
    vec4,
    float,
    texture,
    screenUV,
    smoothstep,
    length,
    positionLocal,
    dot,
    sqrt,
    sRGBTransferOETF,
  } = THREE.TSL;

  const uAttenuationEased = uniform(float(0.5));
  const uColorationAlpha = uniform(float(1));
  const uLightColor = uniform(vec3(1, 1, 1));

  // dist/FALLOFF — identical formula to point-light-illumination.js's own
  // (Foundry shares this term across illumination AND coloration verbatim).
  // No `uRatio` here — technique 1 ("Adaptive Luminance") never reads ratio;
  // that's an illumination-channel-only (switchColor bright/dim) concept.
  const dist = length(positionLocal.xy);
  const attenForFalloff = uAttenuationEased.max(float(0.0001));
  const falloff = smoothstep(float(1), float(1).sub(attenForFalloff), dist);

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

  const finalColor = uLightColor.mul(uColorationAlpha).mul(reflection);
  const outputColor = finalColor.mul(falloff);

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
  material.fragmentNode = vec4(outputColor, float(1));

  return { material, uAttenuationEased, uColorationAlpha, uLightColor };
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
