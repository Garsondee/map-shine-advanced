/**
 * @fileoverview Camera Grade + Time-of-Day timeline for pre-merge vegetation overlays.
 *
 * Bush/tree render before ColorCorrectionEffectV2; this module mirrors the CC shader
 * path (exposure through LGG, then global ToD tint) so foliage matches the ground composite.
 *
 * @module compositor-v2/effects/vegetation-camera-grade
 */

/** GLSL uniform declarations (inject into vegetation fragment shaders). */
export const VEGETATION_CAMERA_GRADE_UNIFORM_GLSL = `
        uniform float uCcGradeEnabled;
        uniform float uCcExposure;
        uniform float uCcDynamicExposure;
        uniform float uCcBrightness;
        uniform float uCcContrast;
        uniform float uCcSaturation;
        uniform float uCcVibrance;
        uniform float uCcTemperature;
        uniform float uCcTint;
        uniform vec3 uCcLift;
        uniform vec3 uCcGamma;
        uniform vec3 uCcGain;
        uniform float uCcMasterGamma;
        uniform float uTodEnabled;
        uniform float uTodGlobalExposure;
        uniform float uTodGlobalSaturation;
        uniform vec3 uTodGlobalTintColor;
`;

/** GLSL helpers + combined grade (Camera Grade then optional local bush/tree tweaks). */
export const VEGETATION_CAMERA_GRADE_FUNCTION_GLSL = `
        vec3 vegApplyWhiteBalance(vec3 color, float temp, float tintVal) {
          vec3 tempShift = vec3(1.0 + temp, 1.0, 1.0 - temp);
          if (temp < 0.0) tempShift = vec3(1.0, 1.0, 1.0 - temp * 0.5);
          else tempShift = vec3(1.0 + temp * 0.5, 1.0, 1.0);
          vec3 tintShift = vec3(1.0, 1.0 + tintVal, 1.0);
          return color * tempShift * tintShift;
        }

        vec3 vegApplyTimelineGrade(vec3 inputColor, float exposureStops, float saturationMul, vec3 tintColor) {
          vec3 graded = inputColor * exp2(clamp(exposureStops, -10.0, 10.0));
          graded *= clamp(tintColor, vec3(0.0), vec3(10.0));
          float luma = dot(graded, vec3(0.2126, 0.7152, 0.0722));
          graded = mix(vec3(luma), graded, clamp(saturationMul, 0.0, 4.0));
          return graded;
        }

        vec3 applyVegetationLocalColorTweak(vec3 color) {
          color *= pow(2.0, uExposure);
          float t = uTemperature;
          float g = uTint;
          color.r += t * 0.1; color.b -= t * 0.1; color.g += g * 0.1;
          color += vec3(uBrightness);
          color = (color - 0.5) * uContrast + 0.5;
          float l = dot(color, vec3(0.2126, 0.7152, 0.0722));
          color = mix(vec3(l), color, uSaturation);
          return color;
        }

        vec3 applyVegetationColorGrade(vec3 color) {
          if (uCcGradeEnabled > 0.5) {
            color *= (uCcExposure * max(uCcDynamicExposure, 0.0));
            color = vegApplyWhiteBalance(color, uCcTemperature, uCcTint);
            color += uCcBrightness;
            color = (color - 0.5) * uCcContrast + 0.5;

            float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
            vec3 gray = vec3(luma);
            float sat = max(color.r, max(color.g, color.b)) - min(color.r, min(color.g, color.b));
            vec3 satColor = mix(gray, color, uCcSaturation);
            if (uCcVibrance != 0.0) {
              satColor = mix(satColor, mix(gray, satColor, 1.0 + uCcVibrance), (1.0 - sat));
            }
            color = satColor;

            color = color + (uCcLift * 0.1);
            color = color * uCcGain;
            color = max(color, vec3(0.0));
            color = pow(color, 1.0 / uCcGamma);
            if (uCcMasterGamma != 1.0) {
              color = pow(color, vec3(1.0 / max(uCcMasterGamma, 0.0001)));
            }

            if (uTodEnabled > 0.5) {
              color = vegApplyTimelineGrade(
                color,
                uTodGlobalExposure,
                uTodGlobalSaturation,
                uTodGlobalTintColor
              );
            }
          }

          float localDelta = abs(uExposure) + abs(uBrightness) + abs(uContrast - 1.0)
                           + abs(uSaturation - 1.0) + abs(uTemperature) + abs(uTint);
          if (localDelta > 0.0001) {
            color = applyVegetationLocalColorTweak(color);
          }
          return color;
        }
`;

/**
 * @param {typeof import('three')} THREE
 * @returns {Record<string, { value: unknown }>}
 */
export function createVegetationCameraGradeUniforms(THREE) {
  return {
    uCcGradeEnabled: { value: 0.0 },
    uCcExposure: { value: 1.0 },
    uCcDynamicExposure: { value: 1.0 },
    uCcBrightness: { value: 0.0 },
    uCcContrast: { value: 1.0 },
    uCcSaturation: { value: 1.0 },
    uCcVibrance: { value: 0.0 },
    uCcTemperature: { value: 0.0 },
    uCcTint: { value: 0.0 },
    uCcLift: { value: new THREE.Vector3(0, 0, 0) },
    uCcGamma: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
    uCcGain: { value: new THREE.Vector3(1, 1, 1) },
    uCcMasterGamma: { value: 1.0 },
    uTodEnabled: { value: 0.0 },
    uTodGlobalExposure: { value: 0.0 },
    uTodGlobalSaturation: { value: 1.0 },
    uTodGlobalTintColor: { value: new THREE.Vector3(1, 1, 1) },
  };
}

/**
 * Push Camera Grade + ToD timeline uniforms from ColorCorrectionEffectV2.
 * @param {Record<string, { value: unknown }>|null|undefined} sharedUniforms
 * @param {import('./ColorCorrectionEffectV2.js').ColorCorrectionEffectV2|null|undefined} ccEffect
 * @param {{ enabled?: boolean, global?: object }|null|undefined} timelineState
 */
export function syncVegetationCameraGradeUniforms(sharedUniforms, ccEffect, timelineState) {
  if (!sharedUniforms) return;

  const p = ccEffect?.params;
  const ccActive = ccEffect?._initialized === true && p?.enabled !== false;
  if (sharedUniforms.uCcGradeEnabled) {
    sharedUniforms.uCcGradeEnabled.value = ccActive ? 1.0 : 0.0;
  }
  if (!ccActive) {
    if (sharedUniforms.uTodEnabled) sharedUniforms.uTodEnabled.value = 0.0;
    return;
  }

  if (sharedUniforms.uCcExposure) {
    sharedUniforms.uCcExposure.value = Number(p.exposure) || 1;
  }
  if (sharedUniforms.uCcDynamicExposure) {
    sharedUniforms.uCcDynamicExposure.value = Number(p.dynamicExposure ?? 1) || 1;
  }
  if (sharedUniforms.uCcBrightness) {
    sharedUniforms.uCcBrightness.value = Number(p.brightness) || 0;
  }
  if (sharedUniforms.uCcContrast) {
    sharedUniforms.uCcContrast.value = Number(p.contrast) || 1;
  }
  if (sharedUniforms.uCcSaturation) {
    sharedUniforms.uCcSaturation.value = Number(p.saturation) ?? 1;
  }
  if (sharedUniforms.uCcVibrance) {
    sharedUniforms.uCcVibrance.value = Number(p.vibrance) || 0;
  }
  if (sharedUniforms.uCcTemperature) {
    sharedUniforms.uCcTemperature.value = Number(p.temperature) || 0;
  }
  if (sharedUniforms.uCcTint) {
    sharedUniforms.uCcTint.value = Number(p.tint) || 0;
  }
  if (sharedUniforms.uCcMasterGamma) {
    sharedUniforms.uCcMasterGamma.value = Number(p.masterGamma ?? 1) || 1;
  }

  if (p.liftColor && sharedUniforms.uCcLift?.value?.set) {
    sharedUniforms.uCcLift.value.set(p.liftColor.r ?? 0, p.liftColor.g ?? 0, p.liftColor.b ?? 0);
  }
  if (p.gammaColor && sharedUniforms.uCcGamma?.value?.set) {
    sharedUniforms.uCcGamma.value.set(
      Math.max(0.0001, p.gammaColor.r ?? 0.5),
      Math.max(0.0001, p.gammaColor.g ?? 0.5),
      Math.max(0.0001, p.gammaColor.b ?? 0.5),
    );
  }
  if (p.gainColor && sharedUniforms.uCcGain?.value?.set) {
    sharedUniforms.uCcGain.value.set(p.gainColor.r ?? 1, p.gainColor.g ?? 1, p.gainColor.b ?? 1);
  }

  const st = timelineState ?? { enabled: false };
  const todEnabled = st.enabled === true;
  if (sharedUniforms.uTodEnabled) {
    sharedUniforms.uTodEnabled.value = todEnabled ? 1.0 : 0.0;
  }
  if (!todEnabled) return;

  const g = st.global ?? {};
  if (sharedUniforms.uTodGlobalExposure) {
    sharedUniforms.uTodGlobalExposure.value = Number(g.exposure) || 0;
  }
  if (sharedUniforms.uTodGlobalSaturation) {
    sharedUniforms.uTodGlobalSaturation.value = Number(g.saturation) ?? 1;
  }
  if (g.tintColor && sharedUniforms.uTodGlobalTintColor?.value?.set) {
    sharedUniforms.uTodGlobalTintColor.value.set(
      g.tintColor.r ?? 1,
      g.tintColor.g ?? 1,
      g.tintColor.b ?? 1,
    );
  }
}

/**
 * @param {{ _sharedUniforms?: Record<string, { value: unknown }>, _timelineGradeState?: object }|null|undefined} effect
 */
export function syncVegetationCameraGradeForEffect(effect) {
  const sharedUniforms = effect?._sharedUniforms;
  if (!sharedUniforms) return;

  let ccEffect = null;
  try {
    const fc = window.MapShine?.effectComposer?._floorCompositorV2 ?? null;
    ccEffect = fc?._colorCorrectionEffect ?? null;
  } catch (_) {}

  syncVegetationCameraGradeUniforms(
    sharedUniforms,
    ccEffect,
    effect?._timelineGradeState ?? { enabled: false },
  );
}
