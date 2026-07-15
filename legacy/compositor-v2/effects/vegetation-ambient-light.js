/**
 * @fileoverview Linear HDR ambient for post-lighting bush/tree overlays.
 *
 * Vegetation draws after LightingEffectV2 compose; this mirrors the outdoor ambient
 * term so canopy colour tracks Ambient light (linear HDR) day/night controls.
 *
 * @module compositor-v2/effects/vegetation-ambient-light
 */

import { computeOutdoorAmbientIllumRgb } from './ambient-compose-cpu.js';

/** GLSL uniform declarations (inject into vegetation fragment shaders). */
export const VEGETATION_AMBIENT_LIGHT_UNIFORM_GLSL = `
        uniform vec3 uVegetationAmbientIllum;
`;

/** Multiply canopy RGB by the outdoor ambient illumination vector. */
export const VEGETATION_AMBIENT_LIGHT_APPLY_GLSL = `
          c *= max(uVegetationAmbientIllum, vec3(0.0));
`;

/**
 * @param {typeof import('three')} THREE
 * @returns {Record<string, { value: unknown }>}
 */
export function createVegetationAmbientLightUniforms(THREE) {
  return {
    uVegetationAmbientIllum: { value: new THREE.Vector3(1, 1, 1) },
  };
}

/**
 * @param {Record<string, { value: unknown }>|null|undefined} sharedUniforms
 * @param {import('./LightingEffectV2.js').LightingEffectV2|null|undefined} [lightingEffect]
 */
export function syncVegetationAmbientLightUniforms(sharedUniforms, lightingEffect = null) {
  if (!sharedUniforms?.uVegetationAmbientIllum?.value) return;

  let fx = lightingEffect;
  if (!fx) {
    try {
      fx = globalThis.window?.MapShine?.effectComposer?._floorCompositorV2?._lightingEffect ?? null;
    } catch (_) {}
  }

  const rgb = computeOutdoorAmbientIllumRgb({ lightingEffect: fx });
  sharedUniforms.uVegetationAmbientIllum.value.set(rgb[0], rgb[1], rgb[2]);
}

/**
 * @param {{ _sharedUniforms?: Record<string, { value: unknown }> }|null|undefined} effect
 */
export function syncVegetationAmbientLightForEffect(effect) {
  syncVegetationAmbientLightUniforms(effect?._sharedUniforms);
}
