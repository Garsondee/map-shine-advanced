/**
 * @fileoverview Landscape lightning brightening for bush/tree canopy passes.
 * @module compositor-v2/effects/vegetation-landscape-lightning
 */

import { resolveCompositorLightningFlash } from '../lightning/resolve-compositor-lightning-flash.js';

export const VEGETATION_LANDSCAPE_LIGHTNING_DEFAULTS = {
  lightningVegetationEnabled: true,
  lightningVegetationBrightnessBoost: 2.5,
  lightningVegetationContrastBoost: 0.0,
  lightningVegetationTintStrength: 0.5,
};

/** Scales how much of the ground outdoor flash reaches billboard foliage. */
const VEGETATION_OUTDOOR_GAIN_SCALE = 0.9;

/** Uniform keys shared between {@link BushEffectV2} / {@link TreeEffectV2} and the canopy shader. */
export const VEGETATION_LANDSCAPE_LIGHTNING_UNIFORM_KEYS = Object.freeze([
  'uLightningVegetationEnabled',
  'uLightningFlash01',
  'uLightningFlashColor',
  'uLightningOutdoorGain',
  'uLightningBrightnessBoost',
  'uLightningContrastBoost',
  'uLightningTintStrength',
]);

/**
 * Masked lightning for billboard foliage.
 * No mid-tone contrast curve (dark green leaves sit well below 0.5 and get crushed to black).
 */
export const VEGETATION_LANDSCAPE_LIGHTNING_FLASH_GLSL = /* glsl */`
  vec3 applyVegetationLandscapeLightningFlash(
    vec3 premulRgb,
    float foliageAlpha,
    float flash01,
    vec3 flashColor,
    float brightnessBoost,
    float contrastBoost,
    float tintStrength,
    float outdoorGain
  ) {
    float f = clamp(flash01, 0.0, 1.0);
    float a = clamp(foliageAlpha, 0.0, 1.0);
    if (f <= 0.0005 || a <= 0.0005) return premulRgb;

    vec3 straight = premulRgb / max(a, 1e-4);
    float lift = max(brightnessBoost, 0.0) * f;
    vec3 flashCol = max(flashColor, vec3(0.01));

    if (max(contrastBoost, 0.0) > 0.001) {
      float contrast = 1.0 + contrastBoost * f;
      straight = mix(straight, (straight - 0.5) * contrast + 0.5, smoothstep(0.38, 0.72, max(max(straight.r, straight.g), straight.b)));
    }

    // Multiplicative lift on leaf albedo (slider).
    straight *= 1.0 + lift * 2.5;

    // HDR wash — billboards skip the lighting pass, so match its outdoor flash add.
    straight += flashCol * f * outdoorGain;

    // Extra emission from the brightness slider (sprite overlay, not surface albedo).
    straight += flashCol * f * lift * 0.5;

    straight = mix(straight, straight * flashCol, clamp(tintStrength, 0.0, 1.0) * f * 0.5);
    straight = max(straight, vec3(0.0));

    return straight * a;
  }
`;

/** GLSL uniforms + helper (inject before canopy `main` body helpers). */
export const VEGETATION_LANDSCAPE_LIGHTNING_UNIFORM_GLSL = `
        uniform float uLightningVegetationEnabled;
        uniform float uLightningFlash01;
        uniform vec3  uLightningFlashColor;
        uniform float uLightningOutdoorGain;
        uniform float uLightningBrightnessBoost;
        uniform float uLightningContrastBoost;
        uniform float uLightningTintStrength;
${VEGETATION_LANDSCAPE_LIGHTNING_FLASH_GLSL}
`;

/**
 * Brighten canopy only (uVegetationPass > 1.5). Ground-shadow pass returns earlier.
 * Expects premultiplied `c` (rgb * texA), `texA`, and `uIntensity` in scope.
 */
export const VEGETATION_LANDSCAPE_LIGHTNING_APPLY_GLSL = `
          if (uVegetationPass > 1.5) {
            vec3 canopyRgb = c * uIntensity;
            float llF = (uLightningVegetationEnabled > 0.5)
              ? clamp(uLightningFlash01, 0.0, 1.0)
              : 0.0;
            if (llF > 0.0005) {
              canopyRgb = applyVegetationLandscapeLightningFlash(
                canopyRgb,
                texA,
                llF,
                uLightningFlashColor,
                uLightningBrightnessBoost,
                uLightningContrastBoost,
                uLightningTintStrength,
                uLightningOutdoorGain
              );
            } else {
              canopyRgb = c * uIntensity;
            }
            c = canopyRgb;
          }
`;

/**
 * @param {typeof import('three')} THREE
 * @param {object} [params]
 * @returns {Record<string, { value: unknown }>}
 */
export function createVegetationLandscapeLightningUniforms(THREE, params = {}) {
  const p = { ...VEGETATION_LANDSCAPE_LIGHTNING_DEFAULTS, ...params };
  return {
    uLightningVegetationEnabled: { value: p.lightningVegetationEnabled !== false ? 1.0 : 0.0 },
    uLightningFlash01: { value: 0.0 },
    uLightningFlashColor: { value: new THREE.Vector3(0.43, 0.5, 0.67) },
    uLightningOutdoorGain: { value: 1.2 },
    uLightningBrightnessBoost: { value: Number(p.lightningVegetationBrightnessBoost) || 2.5 },
    uLightningContrastBoost: { value: Number(p.lightningVegetationContrastBoost) || 0.0 },
    uLightningTintStrength: { value: Number(p.lightningVegetationTintStrength) || 0.5 },
  };
}

/**
 * Independent lightning uniforms for the ground-shadow pass (pass 1).
 * Must not alias {@link _sharedUniforms} — sync used to zero shadow flash and cleared canopy too.
 */
export function createVegetationShadowLightningUniforms(THREE) {
  const u = createVegetationLandscapeLightningUniforms(THREE, { lightningVegetationEnabled: false });
  u.uLightningFlash01.value = 0.0;
  u.uLightningVegetationEnabled.value = 0.0;
  return u;
}

/**
 * @param {Record<string, { value: unknown }>|null|undefined} uniforms
 * @param {object} params
 */
export function applyVegetationLandscapeLightningParamsToUniforms(uniforms, params = {}) {
  if (!uniforms) return;
  const p = { ...VEGETATION_LANDSCAPE_LIGHTNING_DEFAULTS, ...params };
  if (uniforms.uLightningVegetationEnabled) {
    uniforms.uLightningVegetationEnabled.value = p.lightningVegetationEnabled !== false ? 1.0 : 0.0;
  }
  if (uniforms.uLightningBrightnessBoost) {
    uniforms.uLightningBrightnessBoost.value = Math.max(0, Number(p.lightningVegetationBrightnessBoost) ?? 2.5);
  }
  if (uniforms.uLightningContrastBoost) {
    uniforms.uLightningContrastBoost.value = Math.max(0, Number(p.lightningVegetationContrastBoost) ?? 0);
  }
  if (uniforms.uLightningTintStrength) {
    uniforms.uLightningTintStrength.value = Math.max(0, Math.min(1, Number(p.lightningVegetationTintStrength) ?? 0.5));
  }
}

/**
 * @param {Record<string, { value: unknown }>|null|undefined} materialUniforms
 * @param {Record<string, { value: unknown }>|null|undefined} sharedUniforms
 */
export function linkVegetationLandscapeLightningUniforms(materialUniforms, sharedUniforms) {
  if (!materialUniforms || !sharedUniforms) return;
  for (const key of VEGETATION_LANDSCAPE_LIGHTNING_UNIFORM_KEYS) {
    if (sharedUniforms[key]) materialUniforms[key] = sharedUniforms[key];
  }
}

/**
 * @param {Record<string, { value: unknown }>|null|undefined} sharedUniforms
 * @param {object} params
 */
export function syncVegetationLandscapeLightningUniforms(sharedUniforms, params = {}) {
  if (!sharedUniforms) return;

  applyVegetationLandscapeLightningParamsToUniforms(sharedUniforms, params);

  const flash = resolveCompositorLightningFlash();
  const disabled = params.lightningVegetationEnabled === false;
  let outdoorGain = 1.2;
  try {
    const env = window.MapShine?.environment;
    const outdoorStr = Math.max(0, Number(env?.landscapeLightningOutdoorStrength) || 0);
    const dayMul = Math.max(0, Number(env?.landscapeLightningDayNightMul) || 1);
    outdoorGain = Math.max(0.35, Math.min(14, outdoorStr * dayMul * VEGETATION_OUTDOOR_GAIN_SCALE));
  } catch (_) {}

  if (sharedUniforms.uLightningFlash01) {
    sharedUniforms.uLightningFlash01.value = disabled ? 0 : flash.flash01;
  }
  if (sharedUniforms.uLightningOutdoorGain) {
    sharedUniforms.uLightningOutdoorGain.value = disabled ? 0 : outdoorGain;
  }
  if (sharedUniforms.uLightningFlashColor?.value) {
    const col = sharedUniforms.uLightningFlashColor.value;
    if (Array.isArray(col)) {
      col[0] = flash.colorR;
      col[1] = flash.colorG;
      col[2] = flash.colorB;
    } else if (col && typeof col.set === 'function') {
      col.set(flash.colorR, flash.colorG, flash.colorB);
    }
  }
}

/**
 * @param {{ _sharedUniforms?: Record<string, { value: unknown }>, _overlays?: Map, params?: object }|null|undefined} effect
 */
export function syncVegetationLandscapeLightningForEffect(effect) {
  const sharedUniforms = effect?._sharedUniforms;
  if (!sharedUniforms) return;
  const params = effect?.params ?? {};
  syncVegetationLandscapeLightningUniforms(sharedUniforms, params);
  const overlays = effect?._overlays;
  if (!overlays?.values) return;
  for (const entry of overlays.values()) {
    linkVegetationLandscapeLightningUniforms(entry?.material?.uniforms, sharedUniforms);
  }
}

/** Control schema fragment for BushEffectV2 / TreeEffectV2. */
export const VEGETATION_LANDSCAPE_LIGHTNING_CONTROL_SCHEMA = {
  lightningVegetationEnabled: {
    type: 'boolean',
    label: 'Landscape lightning',
    default: true,
    tooltip: 'Brighten canopy sprites during distant landscape lightning and map-point strikes.',
  },
  lightningVegetationBrightnessBoost: {
    type: 'slider',
    label: 'Flash brightness',
    min: 0,
    max: 10,
    step: 0.05,
    default: 2.5,
    tooltip: 'Multiplicative lift plus extra HDR emission on sprites. Outdoor flash from weather is added automatically.',
  },
  lightningVegetationContrastBoost: {
    type: 'slider',
    label: 'Flash contrast',
    min: 0,
    max: 4,
    step: 0.05,
    default: 0.0,
    tooltip: 'Optional mid-tone punch — only affects brighter leaf pixels; leave at 0 for dark canopies.',
  },
  lightningVegetationTintStrength: {
    type: 'slider',
    label: 'Flash tint',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.5,
    tooltip: 'How much the strike color tints the canopy.',
  },
};
