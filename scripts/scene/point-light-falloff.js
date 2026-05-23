/**
 * Shared rim / falloff math for point-light meshes (`LightMesh`, `ThreeLightSource`).
 * Falloff is strictly within the dim/outer photometric radius (d=0..1).
 */

/** Default power-law exponent (2 ≈ inverse-square feel). */
export const DEFAULT_POINT_LIGHT_FALLOFF_EXPONENT = 2.0;

/** Minimum fade band when attenuation is zero (Foundry uses ~0.001). */
export const POINT_LIGHT_FADE_WIDTH_MIN = 0.004;

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
 * Foundry AmbientLight config attenuation [0..1] → shader softness [0..1].
 * Matches Foundry `BaseLightSource._updateCommonUniforms` / V3 host.
 * @param {number} dataAttenuation
 * @returns {number}
 */
export function foundryShaderAttenuationFromData(dataAttenuation) {
  const a = Math.max(0, Math.min(1, Number(dataAttenuation) || 0.5));
  return (Math.cos(Math.PI * Math.pow(a, 1.5)) - 1) / -2;
}

/**
 * Effective shader fade width [0..1] from softness controls.
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
  const edge = Math.max(0, Math.min(1.0, Number(edgeSoftness) || 0));
  const exp = Math.max(0.5, Number(falloffExponent) || DEFAULT_POINT_LIGHT_FALLOFF_EXPONENT);
  const edgeDirect = edge * 0.92;
  const edgeScaled = edge * Math.max(Math.sqrt(2 / exp), 0.68);
  return Math.max(POINT_LIGHT_FADE_WIDTH_MIN, Math.min(1, Math.max(att, edgeDirect, edgeScaled)));
}

/**
 * Map candle/fire glow edge-softness slider → shader attenuation.
 * Stays below 1.0 so {@link msaPointLightFadeWidth} edgeSoft term remains effective.
 * @param {number} edgeSoftness
 * @returns {number}
 */
export function glowShaderAttenuationFromEdgeSoftness(edgeSoftness) {
  const edge = Math.max(0, Math.min(1.0, Number(edgeSoftness) || 0));
  // Track the edge-softness slider directly (stay below 1.0 so the rim band keeps width).
  return Math.max(0.08, Math.min(0.96, edge * 1.12 + 0.08));
}

/**
 * Normalized geometry scale relative to outer photometric radius.
 * Scales with fade width so rim fragments exist through the full soft band.
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
 * Split-channel additive blend into `_lightRT`:
 * - RGB and alpha each use ONE, ONE (not SRC_ALPHA) so premultiplied rgbOut is not
 *   multiplied by alpha again during the blend.
 * - Fragment shaders write scalar illumination to alpha and hue * same mag to RGB.
 * - When color intensity is active, RGB and alpha share one attenuation envelope.
 * @param {THREE.Material|null|undefined} material
 */
export function applyPointLightBufferBlending(material) {
  const THREE = window.THREE;
  if (!THREE || !material) return;
  material.premultipliedAlpha = true;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneFactor;
}

/** GLSL chunk: Foundry-style dual-circle falloff within dim radius (shared by LightMesh / ThreeLightSource). */
export const POINT_LIGHT_FALLOFF_GLSL = `
  float msaPointLightFadeWidth(float att, float edgeSoft, float expVal) {
    float expV = max(expVal, 0.5);
    // High falloff exponents must not shrink the authored outer rim (glow sliders).
    float edgeDirect = edgeSoft * 0.92;
    float edgeScaled = edgeSoft * max(sqrt(2.0 / expV), 0.68);
    float softness = clamp(max(max(att, edgeDirect), edgeScaled), 0.0, 1.0);
    return max(softness, ${POINT_LIGHT_FADE_WIDTH_MIN.toFixed(4)});
  }

  // Foundry illumination model: inner (bright) + outer (dim) smoothsteps.
  // att / edgeSoft control fadeWidth; at att=1 the whole pool is a smooth gradient.
  float msaPointLightFalloff(
    float d,
    float brightNorm,
    float att,
    float edgeSoft,
    float expVal,
    float outerW,
    float innerW
  ) {
    float fadeWidth = msaPointLightFadeWidth(att, edgeSoft, expVal);
    float b = clamp(brightNorm, 0.0, 1.0);
    float edgeAA = max(fwidth(d), 0.0008);

    float outerStart = max(0.0, 1.0 - fadeWidth);
    float rimReach = 1.0 + edgeAA * 5.0 + edgeSoft * 0.36 + fadeWidth * 0.10;
    float outerAlpha = 1.0 - smoothstep(outerStart, rimReach, d);

    float dn = clamp(d, 0.0, 1.0);
    float innerStart = b * (1.0 - fadeWidth);
    float innerEnd = max(b + fadeWidth * (1.0 - b), innerStart + 0.001);
    float innerAlpha = 1.0 - smoothstep(innerStart, innerEnd, dn);

    float wOut = max(outerW, 0.0);
    float wIn = max(innerW, 0.0);
    float wSum = max(0.0001, wOut + wIn);
    float body = (wOut * outerAlpha + wIn * innerAlpha) / wSum;

    body *= 1.0 - smoothstep(rimReach - edgeAA * 3.5 - fadeWidth * 0.06, rimReach + edgeAA * 1.2, d);

    return max(body, 0.0);
  }
`;
