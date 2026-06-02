/**
 * Shared rim / falloff math for point-light meshes (`LightMesh`, `ThreeLightSource`).
 * Falloff is strictly within the dim/outer photometric radius (d=0..1).
 *
 * Uses Foundry-style smoothstep zone falloff (bright + dim rings). Tweakpane
 * “halving distance” sliders map to smoothstep hardness per lamp. Attenuation
 * still lerps endpoints geometrically (0.5 = sqrt(att0 × att1)).
 */

/** Default power-law modifier paired with half-life (legacy uniform name). */
export const DEFAULT_POINT_LIGHT_FALLOFF_EXPONENT = 2.0;

/** Minimum fade band when attenuation is zero (Foundry uses ~0.001). */
export const POINT_LIGHT_FADE_WIDTH_MIN = 0.004;

/** ln(2) for GLSL exp(-LN2 * d / halfStep) halving falloff. */
export const POINT_LIGHT_HALVING_LN2 = 0.6931471805599453;

/**
 * Tiny mesh pad beyond outer radius for anti-aliasing only (shader output is 0 at d>=1).
 * @deprecated Use {@link POINT_LIGHT_GEOM_PAD_NORM}
 */
export const POINT_LIGHT_RIM_FADE_OVERSHOOT = 0;

/** Normalized geometry pad beyond outer photometric radius (mesh only, not light reach). */
export const POINT_LIGHT_GEOM_PAD_NORM = 0.035;

/** Fraction of fade width used to expand glow/point mesh beyond photometric radius. */
export const POINT_LIGHT_GEOM_FADE_WIDTH_SCALE = 0.52;

/**
 * @deprecated Geometry no longer scales with fade width; see {@link POINT_LIGHT_GEOM_PAD_NORM}.
 */
export const POINT_LIGHT_GEOM_RIM_MARGIN = 0;

/** Wall-clipped vertices below this normalized radius skip radial expansion (avoids bleed). */
export const POINT_LIGHT_WALL_VERTEX_EDGE_MIN = 0.92;

/**
 * Clamp Foundry document attenuation [0..1]. Preserves 0 (do not use `||` fallback).
 * @param {number} value
 * @param {number} [fallback=0.5]
 * @returns {number}
 */
export function clampFoundryAttenuation(value, fallback = 0.5) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

/**
 * Read Foundry AmbientLight attenuation from config/doc (preserves 0).
 * @param {object|null|undefined} config
 * @param {object|null|undefined} doc
 * @param {number} [fallback=0.5]
 * @returns {number}
 */
export function getFoundryLightAttenuation(config, doc, fallback = 0.5) {
  const candidates = [
    config?.attenuation,
    doc?.config?.attenuation,
    doc?.attenuation,
  ];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c !== undefined && c !== null) {
      const n = Number(c);
      if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
    }
  }
  return fallback;
}

/**
 * Map Foundry attenuation 0..1 → falloff lerp factor for half-distance endpoints.
 * @param {number} foundryAtt
 * @param {number} [attCurvePower=1]
 * @returns {number}
 */
export function computeFalloffAttBlendT(foundryAtt, attCurvePower = 1) {
  const a = clampFoundryAttenuation(foundryAtt);
  const p = Math.max(0.05, Number(attCurvePower) || 1);
  const blend = Math.max(0, Math.min(1, p - 1));
  return a + (Math.pow(a, p) - a) * blend;
}

/**
 * Push per-light Foundry attenuation + precomputed falloff blend into shader uniforms.
 * @param {Record<string, { value?: unknown }>|null|undefined} uniforms
 * @param {number} foundryAtt
 * @param {number} [attCurvePower=1]
 */
/**
 * @param {Record<string, { value?: unknown }>|null|undefined} uniforms
 * @returns {number}
 */
export function brightNormFromLightUniforms(uniforms) {
  const outer = Number(uniforms?.uRadius?.value ?? uniforms?.uOuterRadius?.value) || 1;
  const bright = Number(uniforms?.uBrightRadius?.value ?? uniforms?.uInnerRadius?.value ?? outer);
  return outer > 1e-6 ? Math.max(0, Math.min(1, bright / outer)) : 1;
}

/**
 * @param {Record<string, { value?: unknown }>|null|undefined} uniforms
 * @returns {typeof DEFAULT_POINT_LIGHT_FALLOFF_TUNING}
 */
export function getFalloffTuningFromUniforms(uniforms) {
  const d = DEFAULT_POINT_LIGHT_FALLOFF_TUNING;
  if (!uniforms?.uFalloffHalfInRange) return { ...d };
  const inR = uniforms.uFalloffHalfInRange.value;
  const outR = uniforms.uFalloffHalfOutRange.value;
  return {
    halfInAtAtt0: inR?.x ?? d.halfInAtAtt0,
    halfInAtAtt1: inR?.y ?? d.halfInAtAtt1,
    halfOutAtAtt0: outR?.x ?? d.halfOutAtAtt0,
    halfOutAtAtt1: outR?.y ?? d.halfOutAtAtt1,
    halfMin: uniforms.uFalloffHalfMin?.value ?? d.halfMin,
    edgeSoftBoostIn: uniforms.uFalloffEdgeSoftBoost?.value?.x ?? d.edgeSoftBoostIn,
    edgeSoftBoostOut: uniforms.uFalloffEdgeSoftBoost?.value?.y ?? d.edgeSoftBoostOut,
    brightNormInfluence: uniforms.uFalloffBrightNormInfluence?.value ?? d.brightNormInfluence,
    dimRingWeight: uniforms.uFalloffDimRingWeight?.value ?? d.dimRingWeight,
    rimAAScale: uniforms.uFalloffRimAAScale?.value ?? d.rimAAScale,
    attCurvePower: uniforms.uFalloffAttCurvePower?.value ?? d.attCurvePower,
    rimBandAtAtt0: uniforms.uFalloffRimBandRange?.value?.x ?? d.rimBandAtAtt0,
    rimBandAtAtt1: uniforms.uFalloffRimBandRange?.value?.y ?? d.rimBandAtAtt1,
  };
}

/**
 * Per-light halving distances from Foundry attenuation + global Tweakpane endpoints.
 * @param {number} foundryAtt
 * @param {number} brightNorm
 * @param {Partial<typeof DEFAULT_POINT_LIGHT_FALLOFF_TUNING>} tuning
 * @param {number} [attCurvePower=1]
 * @returns {{ halfIn: number, halfOut: number, attT: number }}
 */
export function computeLightFalloffHalfDistances(
  foundryAtt,
  brightNorm,
  tuning,
  attCurvePower = 1,
) {
  const t = { ...DEFAULT_POINT_LIGHT_FALLOFF_TUNING, ...tuning };
  const attT = computeFalloffAttBlendT(foundryAtt, attCurvePower);
  const b = Math.max(0, Math.min(1, Number(brightNorm) || 0));
  let halfIn = lerpHalfDistanceForFalloff(t.halfInAtAtt0, t.halfInAtAtt1, attT, t.halfMin);
  halfIn *= mixNum(1.0, t.brightNormInfluence, b);
  const halfOut = lerpHalfDistanceForFalloff(t.halfOutAtAtt0, t.halfOutAtAtt1, attT, t.halfMin);
  return { halfIn, halfOut, attT };
}

/**
 * CPU-authored half distances for this lamp (shader must not re-lerp by att).
 * @param {Record<string, { value?: unknown }>|null|undefined} uniforms
 * @param {number} foundryAtt
 * @param {number} [brightNorm=1]
 * @param {number} [attCurvePower]
 */
export function applyPerLightFalloffHalfDistances(uniforms, foundryAtt, brightNorm = 1, attCurvePower) {
  if (!uniforms?.uFalloffHalfIn) return;
  const tuning = getFalloffTuningFromUniforms(uniforms);
  const p = Number.isFinite(attCurvePower)
    ? attCurvePower
    : (Number(uniforms.uFalloffAttCurvePower?.value) || 1);
  const { halfIn, halfOut } = computeLightFalloffHalfDistances(foundryAtt, brightNorm, tuning, p);
  uniforms.uFalloffHalfIn.value = halfIn;
  uniforms.uFalloffHalfOut.value = halfOut;
  const { hBright, hDim } = computeLightFalloffHardnessValues(
    foundryAtt,
    halfIn,
    halfOut,
    tuning,
    p,
  );
  if (uniforms.uFalloffHardnessBright) uniforms.uFalloffHardnessBright.value = hBright;
  if (uniforms.uFalloffHardnessDim) uniforms.uFalloffHardnessDim.value = hDim;
}

export function applyFalloffAttenuationUniforms(
  uniforms,
  foundryAtt,
  attCurvePower = 1,
  brightNorm = 1,
) {
  if (!uniforms) return;
  const raw = clampFoundryAttenuation(foundryAtt);
  const attT = computeFalloffAttBlendT(raw, attCurvePower);
  if (uniforms.uFoundryAttenuation) uniforms.uFoundryAttenuation.value = raw;
  if (uniforms.uFalloffAttBlend) uniforms.uFalloffAttBlend.value = attT;
  if (uniforms.uAttenuation) {
    uniforms.uAttenuation.value = foundryShaderAttenuationFromData(raw);
  }
  applyPerLightFalloffHalfDistances(uniforms, raw, brightNorm, attCurvePower);
}

/**
 * Foundry AmbientLight config attenuation [0..1] → shader softness [0..1].
 * Matches Foundry `BaseLightSource._updateCommonUniforms` / V3 host.
 * @param {number} dataAttenuation
 * @returns {number}
 */
export function foundryShaderAttenuationFromData(dataAttenuation) {
  const a = clampFoundryAttenuation(dataAttenuation);
  return (Math.cos(Math.PI * Math.pow(a, 1.5)) - 1) / -2;
}

/**
 * Foundry luminosity 0..1 → illumination multiplier (0.5 = neutral / full, not half).
 * Matches V3 `exposure = luminosity * 2 - 1` with uniform +exposure boost.
 * @param {number} luminosity01
 * @returns {number}
 */
export function foundryLuminosityIllumMultiplier(luminosity01) {
  const lum = clampFoundryAttenuation(luminosity01);
  const exposure = lum * 2.0 - 1.0;
  if (exposure <= 0) return Math.max(0, 1.0 + exposure);
  return 1.0 + exposure * 0.5;
}

/**
 * Foundry Color Intensity (0..1) from an AmbientLight `config`.
 * V14 UI writes `config.alpha`; some worlds/macros use `colorIntensity` or `saturation`.
 * Do not use Math.max across fields — `alpha` may be emission opacity on some docs.
 * @param {object|null|undefined} config
 * @returns {number}
 */
export function foundryColorIntensity01FromConfig(config) {
  if (!config || typeof config !== 'object') return 0.5;
  // V14 Color Intensity UI → `config.alpha` (see V3ThreeSceneHost / Foundry LightData).
  const alpha = Number(config.alpha);
  if (Number.isFinite(alpha)) return Math.max(0, Math.min(1, alpha));
  const ci = Number(config.colorIntensity ?? config.colourIntensity);
  if (Number.isFinite(ci)) return Math.max(0, Math.min(1, ci));
  // Macros (e.g. theatre) sometimes map “Color Intensity” to background saturation -1..1.
  const sat = Number(config.saturation);
  if (Number.isFinite(sat)) return Math.max(0, Math.min(1, sat * 0.5 + 0.5));
  return 0.5;
}

/**
 * Mirrors `BaseLightSource._updateColorationUniforms` colorationAlpha from Color Intensity.
 * @param {number} colorIntensity01 Foundry `config.colorIntensity` 0..1
 * @param {number} [colorationTechnique=1] Foundry `config.coloration` technique id
 * @returns {number}
 */
export function foundryColorationAlphaFromIntensity(colorIntensity01, colorationTechnique = 1) {
  const ci = Number.isFinite(Number(colorIntensity01))
    ? Math.max(0, Math.min(1, Number(colorIntensity01)))
    : 0.5;
  const tech = Math.max(0, Math.min(9, Math.round(Number(colorationTechnique) || 1)));
  if (tech === 0) return ci * ci;
  if (tech === 4 || tech === 5 || tech === 6 || tech === 9) return ci;
  return ci * 2.0;
}

/**
 * Map Foundry colorationAlpha → compose gel mix [0..1] (matches ThreeLightSource shader).
 * @param {number} colorationAlpha
 * @returns {number}
 */
export function foundryColorMixFromColorationAlpha(colorationAlpha) {
  const a = Math.max(0, Number(colorationAlpha) || 0);
  return Math.min(1, a * 0.55);
}

/**
 * Rim AA band width for mesh coverage (not the photometric half-life).
 * @param {object} opts
 * @param {number} [opts.attenuation=0]
 * @param {number} [opts.edgeSoftness=0]
 * @param {number} [opts.falloffExponent=2]
 * @returns {number}
 */
export function computePointLightFadeWidth({
  attenuation = 0,
  edgeSoftness = 0,
  falloffExponent = DEFAULT_POINT_LIGHT_FALLOFF_EXPONENT,
} = {}) {
  const att = Math.max(0, Math.min(1, Number(attenuation) || 0));
  const attT = Math.pow(att, 0.85);
  const edge = Math.max(0, Math.min(1.0, Number(edgeSoftness) || 0));
  const exp = Math.max(0.5, Number(falloffExponent) || DEFAULT_POINT_LIGHT_FALLOFF_EXPONENT);
  const rimBand = Math.max(POINT_LIGHT_FADE_WIDTH_MIN, mixNum(0.14, 0.05, attT));
  const edgeBand = edge * mixNum(0.22, 0.08, attT);
  const expBand = edge * Math.max(Math.sqrt(2 / exp), 0.5) * 0.12;
  return Math.max(POINT_LIGHT_FADE_WIDTH_MIN, Math.min(1, Math.max(rimBand, edgeBand, expBand)));
}

/** @param {number} a @param {number} b @param {number} t */
function mixNum(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Geometric lerp for halving distances — att 0.5 is the perceptual midpoint of exp falloff.
 * (Linear lerp on half-step makes 0.5 look almost like 0.)
 * @param {number} att0 endpoint at Foundry attenuation 0
 * @param {number} att1 endpoint at Foundry attenuation 1
 * @param {number} t blend 0..1
 * @param {number} [halfMin=0.04]
 * @returns {number}
 */
export function lerpHalfDistanceForFalloff(att0, att1, t, halfMin = 0.04) {
  const floor = Math.max(1e-4, Number(halfMin) || 0.04);
  const a = Math.max(floor, Number(att0) || floor);
  const b = Math.max(floor, Number(att1) || floor);
  const u = Math.max(0, Math.min(1, Number(t) || 0));
  if (Math.abs(a - b) < 1e-6) return a;
  return Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * u);
}

/**
 * Normalized half-distance (0..1 radius) per halving for shader tuning / tests.
 * @param {number} shaderAttenuation
 * @param {number} [brightNorm=0.5]
 * @returns {{ halfIn: number, halfOut: number }}
 */
export function computePointLightHalfStep(foundryAttenuation, brightNorm = 0.5, attCurvePower = 1.0) {
  const { halfIn, halfOut } = computeLightFalloffHalfDistances(
    foundryAttenuation,
    brightNorm,
    DEFAULT_POINT_LIGHT_FALLOFF_TUNING,
    attCurvePower,
  );
  return { halfIn, halfOut };
}

/**
 * Map candle/fire glow edge-softness slider → shader attenuation.
 * @param {number} edgeSoftness
 * @returns {number}
 */
export function glowShaderAttenuationFromEdgeSoftness(edgeSoftness) {
  const edge = Math.max(0, Math.min(1.0, Number(edgeSoftness) || 0));
  return Math.max(0.08, Math.min(0.96, edge * 1.12 + 0.08));
}

/**
 * Normalized geometry scale relative to outer photometric radius.
 * @param {number} [fadeWidth]
 * @returns {number}
 */
export function computePointLightGeomScale(fadeWidth = 0) {
  const fw = Math.max(0, Math.min(1, Number(fadeWidth) || 0));
  return 1 + Math.max(POINT_LIGHT_GEOM_PAD_NORM, fw * POINT_LIGHT_GEOM_FADE_WIDTH_SCALE + 0.03);
}

/**
 * Photometric outer radius + small AA pad for mesh coverage.
 * @param {number} outerRadiusPx
 * @param {object} [_softnessOpts]
 * @returns {number}
 */
export function computePointLightGeomRadiusPx(outerRadiusPx, softnessOpts = {}) {
  const outerR = Math.max(Number(outerRadiusPx) || 0, 1e-4);
  const fadeWidth = computePointLightFadeWidth(softnessOpts);
  return outerR * computePointLightGeomScale(fadeWidth);
}

/**
 * Shared GLSL for `_lightRT`: RGB = chroma signal only; alpha = illumination (mag).
 * Color Intensity must not multiply into white/brightness — compose tints in luma-preserving mix.
 */
export const MSA_LIGHT_RADIANCE_GLSL = `
  const vec3 MSA_LUMA_W = vec3(0.2126, 0.7152, 0.0722);

  // hue × CI gel × spatial mag (falloff shape). No colorationAlpha>1 clamp toward white.
  vec3 msaLightChromaSignal(vec3 lampCol, float gel01, float mag) {
    float g = clamp(gel01, 0.0, 1.0);
    vec3 hue = clamp(lampCol, 0.0, 1.0);
    return hue * g * max(mag, 0.0);
  }

  float msaLightRadianceLuma(vec3 rgb) {
    return dot(max(rgb, vec3(0.0)), MSA_LUMA_W);
  }

  float msaLightRadianceChroma(vec3 rgb) {
    float mx = max(max(rgb.r, rgb.g), rgb.b);
    if (mx < 1e-5) return 0.0;
    float mn = min(min(rgb.r, rgb.g), rgb.b);
    return clamp((mx - mn) / mx, 0.0, 1.0);
  }

  // Tint weight: chroma magnitude × penumbra envelope (never length/mag — that is flat until the rim).
  float msaLightTintWeight(vec3 chromaSig, float mag) {
    float chromaMag = length(max(chromaSig, vec3(0.0)));
    float tintEnvelope = smoothstep(0.06, 0.42, max(mag, 0.0));
    return chromaMag * tintEnvelope;
  }

  // CI crossfade: replace neutral white illumination with luma-matched coloured light.
  // Additive white + hue always reads salmon; multiply toward hue as CI rises.
  vec3 msaLightDirectIllumination(vec3 neutralIllum, vec3 hue, float colorWeight) {
    float w = clamp(colorWeight, 0.0, 1.0);
    if (w <= 0.0001) return neutralIllum;
    vec3 hueN = clamp(hue, 0.0, 1.0);
    float hLen = length(hueN);
    if (hLen > 1e-5) hueN /= hLen;
    float hueL = dot(hueN, MSA_LUMA_W);
    vec3 hueIllum = (hueL > 1e-5) ? (hueN / hueL) : vec3(1.0);
    return neutralIllum * mix(vec3(1.0), hueIllum, w);
  }

  // Luma-preserving hue tint (CI changes colour, not scene brightness).
  vec3 msaLightLumaPreserveTint(vec3 litColor, vec3 hue, float tintWeight) {
    float w = clamp(tintWeight, 0.0, 1.0);
    if (w <= 0.0001) return litColor;
    vec3 hueN = clamp(hue, 0.0, 1.0);
    float hLen = length(hueN);
    if (hLen > 1e-5) hueN /= hLen;
    vec3 tinted = litColor * hueN;
    float origL = dot(litColor, MSA_LUMA_W);
    float newL = dot(tinted, MSA_LUMA_W);
    if (newL > 1e-5 && origL > 1e-5) tinted *= (origL / newL);
    return mix(litColor, tinted, w);
  }

  // vividness 0 = luma-preserving; 1 = multiply toward lamp hue (stronger saturation at highlights).
  vec3 msaLightApplyColoration(vec3 litColor, vec3 hue, float tintWeight, float vividness) {
    float w = clamp(tintWeight, 0.0, 1.0);
    float v = clamp(vividness, 0.0, 1.0);
    if (w <= 0.0001) return litColor;
    vec3 preserved = msaLightLumaPreserveTint(litColor, hue, w);
    if (v <= 0.0001) return preserved;
    vec3 hueN = clamp(hue, 0.0, 1.0);
    float hLen = length(hueN);
    if (hLen > 1e-5) hueN /= hLen;
    vec3 multiplied = litColor * hueN;
    return mix(preserved, multiplied, v);
  }
`;

/**
 * Max blend into `_lightRT` (cleared to 0). Overlap takes the brighter lamp sample,
 * not the sum — prevents midpoint hotspots brighter than either core.
 * @param {THREE.Material|null|undefined} material
 */
export function applyPointLightBufferBlending(material) {
  const THREE = window.THREE;
  if (!THREE || !material) return;
  // RGB = Foundry tinted radiance; alpha = illumination envelope (mag).
  material.premultipliedAlpha = false;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.MaxEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneFactor;
}

/**
 * Maps Tweakpane “halving distance” → Foundry smoothstep hardness (larger half dist = softer).
 * @type {number}
 */
export const FALLOFF_HARDNESS_FROM_HALF_SCALE = 1.12;

/**
 * @param {number} halfDist normalized halving distance from sliders
 * @returns {number} Foundry hardness 0..1 for smoothstep(1-h, 1, d)
 */
export function halfDistanceToFoundryHardness(halfDist) {
  const h = 1.0 - Math.max(0, Number(halfDist) || 0) * FALLOFF_HARDNESS_FROM_HALF_SCALE;
  return Math.max(0.08, Math.min(0.96, h));
}

/**
 * Foundry V3: hardness = mix(0.05, 1.0, attenuation) — linear bright→dim at att=1.
 * @param {number} attBlend 0..1 (Foundry attenuation blend)
 * @returns {number}
 */
export function foundryHardnessFromAttBlend(attBlend) {
  const t = Math.max(0, Math.min(1, Number(attBlend) || 0));
  return 0.08 + 0.90 * t;
}

/**
 * @param {number} foundryAtt
 * @param {number} halfIn lerped slider half-distance (bright)
 * @param {number} halfOut lerped slider half-distance (dim)
 * @param {Partial<typeof DEFAULT_POINT_LIGHT_FALLOFF_TUNING>} tuning
 * @param {number} [attCurvePower=1]
 * @returns {{ hBright: number, hDim: number }}
 */
export function computeLightFalloffHardnessValues(
  foundryAtt,
  halfIn,
  halfOut,
  tuning,
  attCurvePower = 1,
) {
  const t = { ...DEFAULT_POINT_LIGHT_FALLOFF_TUNING, ...tuning };
  const attT = computeFalloffAttBlendT(foundryAtt, attCurvePower);
  const base = foundryHardnessFromAttBlend(attT);
  const refIn = lerpHalfDistanceForFalloff(t.halfInAtAtt0, t.halfInAtAtt1, attT, t.halfMin);
  const refOut = lerpHalfDistanceForFalloff(t.halfOutAtAtt0, t.halfOutAtAtt1, attT, t.halfMin);
  const scaleIn = Math.max(0.35, Math.min(2.2, halfIn / Math.max(refIn, 0.03)));
  const scaleOut = Math.max(0.35, Math.min(2.2, halfOut / Math.max(refOut, 0.03)));
  return {
    hBright: Math.max(0.06, Math.min(0.99, base / scaleIn)),
    hDim: Math.max(0.08, Math.min(0.99, base / scaleOut)),
  };
}

/** Default tuning (matches pre-uniform shader). Overridden by LightingEffectV2 Tweakpane. */
export const DEFAULT_POINT_LIGHT_FALLOFF_TUNING = {
  /** Soft att=0: wide bright + dim (maps to low hardness ≈0.42). */
  halfInAtAtt0: 0.52,
  /** Att=1 reference; hardness comes from Foundry mix(0.08, 0.98, att). */
  halfInAtAtt1: 0.22,
  halfOutAtAtt0: 0.38,
  halfOutAtAtt1: 0.22,
  halfMin: 0.02,
  edgeSoftBoostIn: 0.08,
  edgeSoftBoostOut: 0.06,
  brightNormInfluence: 0.92,
  dimRingWeight: 1.0,
  rimAAScale: 0.38,
  attCurvePower: 1.0,
  rimBandAtAtt0: 0.14,
  rimBandAtAtt1: 0.08,
};

/** Param keys wired to Tweakpane (LightingEffectV2). */
export const POINT_LIGHT_FALLOFF_PARAM_KEYS = [
  'falloffHalfInAtAtt0',
  'falloffHalfInAtAtt1',
  'falloffHalfOutAtAtt0',
  'falloffHalfOutAtAtt1',
  'falloffHalfMin',
  'falloffEdgeSoftBoostIn',
  'falloffEdgeSoftBoostOut',
  'falloffBrightNormInfluence',
  'falloffDimRingWeight',
  'falloffRimAAScale',
  'falloffAttCurvePower',
  'falloffRimBandAtAtt0',
  'falloffRimBandAtAtt1',
  'falloffExponent',
];

/**
 * @param {Record<string, unknown>|null|undefined} params
 * @returns {typeof DEFAULT_POINT_LIGHT_FALLOFF_TUNING}
 */
export function getPointLightFalloffTuningFromParams(params) {
  const d = DEFAULT_POINT_LIGHT_FALLOFF_TUNING;
  const p = params ?? {};
  const num = (k, def) => {
    const v = Number(p[k]);
    return Number.isFinite(v) ? v : def;
  };
  return {
    halfInAtAtt0: num('falloffHalfInAtAtt0', d.halfInAtAtt0),
    halfInAtAtt1: num('falloffHalfInAtAtt1', d.halfInAtAtt1),
    halfOutAtAtt0: num('falloffHalfOutAtAtt0', d.halfOutAtAtt0),
    halfOutAtAtt1: num('falloffHalfOutAtAtt1', d.halfOutAtAtt1),
    halfMin: num('falloffHalfMin', d.halfMin),
    edgeSoftBoostIn: num('falloffEdgeSoftBoostIn', d.edgeSoftBoostIn),
    edgeSoftBoostOut: num('falloffEdgeSoftBoostOut', d.edgeSoftBoostOut),
    brightNormInfluence: num('falloffBrightNormInfluence', d.brightNormInfluence),
    dimRingWeight: num('falloffDimRingWeight', d.dimRingWeight),
    rimAAScale: num('falloffRimAAScale', d.rimAAScale),
    attCurvePower: num('falloffAttCurvePower', d.attCurvePower),
    rimBandAtAtt0: num('falloffRimBandAtAtt0', d.rimBandAtAtt0),
    rimBandAtAtt1: num('falloffRimBandAtAtt1', d.rimBandAtAtt1),
  };
}

/**
 * Create Three.js uniform slots for falloff tuning (call from ShaderMaterial ctor).
 * @param {typeof window.THREE} THREE
 * @returns {object}
 */
export function createPointLightFalloffUniforms(THREE) {
  const t = DEFAULT_POINT_LIGHT_FALLOFF_TUNING;
  return {
    uFalloffHalfInRange: { value: new THREE.Vector2(t.halfInAtAtt0, t.halfInAtAtt1) },
    uFalloffHalfOutRange: { value: new THREE.Vector2(t.halfOutAtAtt0, t.halfOutAtAtt1) },
    uFalloffHalfMin: { value: t.halfMin },
    uFalloffEdgeSoftBoost: { value: new THREE.Vector2(t.edgeSoftBoostIn, t.edgeSoftBoostOut) },
    uFalloffBrightNormInfluence: { value: t.brightNormInfluence },
    uFalloffDimRingWeight: { value: t.dimRingWeight },
    uFalloffRimAAScale: { value: t.rimAAScale },
    uFalloffAttCurvePower: { value: t.attCurvePower },
    uFalloffRimBandRange: { value: new THREE.Vector2(t.rimBandAtAtt0, t.rimBandAtAtt1) },
    /** Per-lamp halving distances (CPU from Foundry attenuation + range endpoints). */
    uFalloffHalfIn: { value: t.halfInAtAtt0 },
    uFalloffHalfOut: { value: t.halfOutAtAtt0 },
    uFalloffHardnessBright: { value: foundryHardnessFromAttBlend(0) },
    uFalloffHardnessDim: { value: foundryHardnessFromAttBlend(0) },
  };
}

/**
 * Push tuning into an existing ShaderMaterial.uniforms bag.
 * @param {Record<string, { value?: unknown }>|null|undefined} uniforms
 * @param {Partial<typeof DEFAULT_POINT_LIGHT_FALLOFF_TUNING>} [tuning]
 */
export function applyPointLightFalloffUniforms(uniforms, tuning) {
  if (!uniforms?.uFalloffHalfInRange) return;
  const t = { ...DEFAULT_POINT_LIGHT_FALLOFF_TUNING, ...tuning };
  uniforms.uFalloffHalfInRange.value.set(t.halfInAtAtt0, t.halfInAtAtt1);
  uniforms.uFalloffHalfOutRange.value.set(t.halfOutAtAtt0, t.halfOutAtAtt1);
  uniforms.uFalloffHalfMin.value = t.halfMin;
  uniforms.uFalloffEdgeSoftBoost.value.set(t.edgeSoftBoostIn, t.edgeSoftBoostOut);
  uniforms.uFalloffBrightNormInfluence.value = t.brightNormInfluence;
  uniforms.uFalloffDimRingWeight.value = t.dimRingWeight;
  uniforms.uFalloffRimAAScale.value = t.rimAAScale;
  uniforms.uFalloffAttCurvePower.value = t.attCurvePower;
  uniforms.uFalloffRimBandRange.value.set(t.rimBandAtAtt0, t.rimBandAtAtt1);
}

/** GLSL uniforms + half-life falloff (shared by LightMesh / ThreeLightSource). */
export const POINT_LIGHT_FALLOFF_GLSL = `
  uniform vec2 uFalloffHalfInRange;
  uniform vec2 uFalloffHalfOutRange;
  uniform float uFalloffHalfMin;
  uniform vec2 uFalloffEdgeSoftBoost;
  uniform float uFalloffBrightNormInfluence;
  uniform float uFalloffDimRingWeight;
  uniform float uFalloffRimAAScale;
  uniform float uFalloffAttCurvePower;
  uniform vec2 uFalloffRimBandRange;
  // Per-lamp halving distances (set on CPU from Foundry attenuation).
  uniform float uFalloffHalfIn;
  uniform float uFalloffHalfOut;
  uniform float uFalloffHardnessBright;
  uniform float uFalloffHardnessDim;
  uniform float uFoundryAttenuation;
  uniform float uFalloffAttBlend;

  float msaPointLightAttT() {
    return clamp(uFalloffAttBlend, 0.0, 1.0);
  }

  float msaPointLightFadeWidth(float edgeSoft, float expVal) {
    float attT = msaPointLightAttT();
    float rimBand = mix(uFalloffRimBandRange.x, uFalloffRimBandRange.y, attT);
    float edgeBand = edgeSoft * mix(0.22, 0.08, attT);
    float expV = max(expVal, 0.5);
    float expBand = edgeSoft * max(sqrt(2.0 / expV), 0.5) * 0.12;
    float softness = clamp(max(rimBand, max(edgeBand, expBand)), 0.0, 1.0);
    return max(softness, ${POINT_LIGHT_FADE_WIDTH_MIN.toFixed(4)});
  }

  float msaPointLightFalloff(
    float d,
    float brightNorm,
    float att,
    float edgeSoft,
    float expVal,
    float outerW,
    float innerW
  ) {
    float attT = msaPointLightAttT();
    float b = clamp(brightNorm, 0.0, 1.0);
    float dn = clamp(d, 0.0, 1.0);
    float edgeAA = max(fwidth(dn), 0.0008);
    float fadeWidth = msaPointLightFadeWidth(edgeSoft, expVal);

    float wOut = max(outerW, 0.0);
    float wIn = max(innerW, 0.0);

    float hFoundry = mix(0.10, 0.98, attT);
    float h = clamp(mix(hFoundry, uFalloffHardnessDim, 0.45), 0.08, 0.99);
    h += edgeSoft * uFalloffEdgeSoftBoost.y * 0.18;

    // One continuous smoothstep to the photometric edge (no cliff at bright/dim boundary).
    float body = 1.0 - smoothstep(1.0 - h, 1.0, dn);

    // Gentle core lift inside Foundry bright radius (multiplicative, fades to 1.0 at dn = b).
    if (b > 0.02) {
      float coreT = 1.0 - smoothstep(0.0, b, dn);
      float coreBoost = mix(1.0, 1.22, coreT * clamp(uFalloffHardnessBright / max(h, 0.1), 0.85, 1.35));
      body *= mix(1.0, coreBoost, smoothstep(0.0, 1.0, wIn / max(wIn + wOut, 0.001)));
    }

    // Mild highlight compression (avoids flat white disk without killing mid-radius gradient).
    body = body / (1.0 + body * 0.32);

    // Rim AA only on the outer fraction so the dim ring keeps a smooth roll-off.
    float rimReach = 1.0 + edgeAA * 3.5;
    float rimStart = max(0.72, 1.0 - fadeWidth * uFalloffRimAAScale * mix(1.0, 0.45, attT));
    float rimFade = smoothstep(rimStart - edgeAA * 2.0, rimReach, dn);
    body *= 1.0 - rimFade * 0.42;

    return max(body, 0.0);
  }
`;
