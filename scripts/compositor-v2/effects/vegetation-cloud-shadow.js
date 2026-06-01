/**
 * @fileoverview Cloud shadow darkening for post-lighting vegetation overlays (bush/tree).
 * @module compositor-v2/effects/vegetation-cloud-shadow
 */

import { resolveEffectEnabled } from '../../effects/resolve-effect-enabled.js';

/** @type {import('three').DataTexture|null} */
let _fallbackWhiteTex = null;

export const VEGETATION_CLOUD_SHADOW_DEFAULTS = {
  cloudShadowEnabled: true,
  cloudShadowDarkenStrength: 1.25,
  cloudShadowDarkenCurve: 1.5,
};

/** GLSL uniform declarations (inject into vegetation fragment shaders). */
export const VEGETATION_CLOUD_SHADOW_UNIFORM_GLSL = `
        uniform sampler2D tCloudShadow;
        uniform float uHasCloudShadow;
        uniform float uCloudShadowEnabled;
        uniform float uCloudShadowDarkenStrength;
        uniform float uCloudShadowDarkenCurve;
`;

/**
 * Darken canopy RGB from CloudEffectV2 ground shadow map (R = lit, 0 = shadowed).
 * Expects `c` (vec3) and `uScreenSize` in scope.
 */
export const VEGETATION_CLOUD_SHADOW_APPLY_GLSL = `
          if (uCloudShadowEnabled > 0.5 && uHasCloudShadow > 0.5
              && (uLightningVegetationEnabled < 0.5 || uLightningFlash01 < 0.01)) {
            vec2 msCloudUv = gl_FragCoord.xy / max(uScreenSize, vec2(1.0));
            float cloudLit = clamp(texture2D(tCloudShadow, msCloudUv).r, 0.0, 1.0);
            float cloudShade = 1.0 - cloudLit;
            float dStrength = clamp(uCloudShadowDarkenStrength, 0.0, 3.0);
            float dCurve = max(0.01, uCloudShadowDarkenCurve);
            float cloudDarken = min(1.0, dStrength * pow(cloudShade, dCurve));
            c *= (1.0 - cloudDarken);
          }
`;

/**
 * @param {typeof import('three')} THREE
 * @returns {import('three').DataTexture}
 */
function ensureFallbackWhiteTexture(THREE) {
  if (_fallbackWhiteTex) return _fallbackWhiteTex;
  const data = new Uint8Array([255, 255, 255, 255]);
  _fallbackWhiteTex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  _fallbackWhiteTex.needsUpdate = true;
  return _fallbackWhiteTex;
}

/**
 * @param {typeof import('three')} THREE
 * @param {object} [params]
 * @returns {Record<string, { value: unknown }>}
 */
export function createVegetationCloudShadowUniforms(THREE, params = {}) {
  const p = { ...VEGETATION_CLOUD_SHADOW_DEFAULTS, ...params };
  return {
    tCloudShadow: { value: ensureFallbackWhiteTexture(THREE) },
    uHasCloudShadow: { value: 0.0 },
    uCloudShadowEnabled: { value: p.cloudShadowEnabled ? 1.0 : 0.0 },
    uCloudShadowDarkenStrength: { value: Number(p.cloudShadowDarkenStrength) || 1.25 },
    uCloudShadowDarkenCurve: { value: Number(p.cloudShadowDarkenCurve) || 1.5 },
  };
}

/**
 * @param {Record<string, { value: unknown }>|null|undefined} uniforms
 * @param {object} params
 */
export function applyVegetationCloudShadowParamsToUniforms(uniforms, params = {}) {
  if (!uniforms) return;
  const p = { ...VEGETATION_CLOUD_SHADOW_DEFAULTS, ...params };
  if (uniforms.uCloudShadowEnabled) {
    uniforms.uCloudShadowEnabled.value = p.cloudShadowEnabled !== false ? 1.0 : 0.0;
  }
  if (uniforms.uCloudShadowDarkenStrength) {
    uniforms.uCloudShadowDarkenStrength.value = Number(p.cloudShadowDarkenStrength) || 1.25;
  }
  if (uniforms.uCloudShadowDarkenCurve) {
    uniforms.uCloudShadowDarkenCurve.value = Number(p.cloudShadowDarkenCurve) || 1.5;
  }
}

/**
 * Bind live cloud shadow RT + screen size (call after CloudEffectV2 each frame).
 * @param {Record<string, { value: unknown }>|null|undefined} sharedUniforms
 * @param {{ cloudShadowEnabled?: boolean }} [params]
 */
export function syncVegetationCloudShadowUniforms(sharedUniforms, params = {}) {
  if (!sharedUniforms) return;

  applyVegetationCloudShadowParamsToUniforms(sharedUniforms, params);

  let fc = null;
  try { fc = window.MapShine?.effectComposer?._floorCompositorV2 ?? null; } catch (_) {}

  const cloudFx = fc?._cloudEffect ?? null;
  const cloudTex = (resolveEffectEnabled(cloudFx) && cloudFx?.cloudShadowTexture)
    ? cloudFx.cloudShadowTexture
    : null;

  const THREE = window.THREE;
  if (sharedUniforms.tCloudShadow) {
    sharedUniforms.tCloudShadow.value = cloudTex
      ?? (THREE ? ensureFallbackWhiteTexture(THREE) : null);
  }
  if (sharedUniforms.uHasCloudShadow) {
    sharedUniforms.uHasCloudShadow.value = cloudTex ? 1.0 : 0.0;
  }

  const renderer = fc?.renderer ?? null;
  const screenSize = sharedUniforms.uScreenSize?.value;
  if (screenSize && typeof screenSize.set === 'function' && renderer?.getDrawingBufferSize) {
    try {
      renderer.getDrawingBufferSize(screenSize);
    } catch (_) {}
  }
}

/** Control schema fragment for BushEffectV2 / TreeEffectV2. */
export const VEGETATION_CLOUD_SHADOW_CONTROL_SCHEMA = {
  cloudShadowEnabled: {
    type: 'boolean',
    label: 'Cloud shadows',
    default: true,
    tooltip: 'Darken canopy pixels where the cloud shadow map is shaded (matches ground tiles).',
  },
  cloudShadowDarkenStrength: {
    type: 'slider',
    label: 'Shadow strength',
    min: 0,
    max: 3,
    step: 0.01,
    default: 1.25,
    tooltip: 'How strongly cloud shade darkens the foliage.',
  },
  cloudShadowDarkenCurve: {
    type: 'slider',
    label: 'Shadow curve',
    min: 0.1,
    max: 8,
    step: 0.01,
    default: 1.5,
    tooltip: 'Higher = softer penumbra, lower = harder cloud edges on leaves.',
  },
};
