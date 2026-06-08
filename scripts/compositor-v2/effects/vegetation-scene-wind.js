/**
 * @fileoverview Shared scene wind spatial field for vegetation shaders.
 * @module compositor-v2/effects/vegetation-scene-wind
 */

/** GLSL uniform declarations (inject into vegetation fragment shaders). */
export const VEGETATION_SCENE_WIND_UNIFORM_GLSL = `
        uniform float uSceneWindEnabled;
        uniform float uSceneWindSpatialFreq;
        uniform float uSceneWindWavePhase;
        uniform float uSceneWindSharpness;
        uniform float uSceneWindGapRatio;
        uniform float uSceneWindGapSoftness;
        uniform float uSceneWindStrengthFloor;
        uniform float uBendRiseSoftness;
`;

/** Expects VEGETATION_SCENE_WIND uniforms in scope. Returns 0..1 gust-front strength. */
export const VEGETATION_SCENE_WIND_STRENGTH_GLSL = `
        float sceneWindStrength(vec2 worldPos, vec2 windDir) {
          if (uSceneWindEnabled < 0.5) return 1.0;
          vec2 dir = normalize(windDir);
          if (length(dir) < 0.01) dir = vec2(1.0, 0.0);
          float along = dot(worldPos, dir);
          float carrier = 0.5 + 0.5 * sin(along * uSceneWindSpatialFreq - uSceneWindWavePhase);
          float peak = pow(clamp(carrier, 0.0, 1.0), max(0.1, uSceneWindSharpness));
          float gap = clamp(uSceneWindGapRatio, 0.0, 0.95);
          float threshold = 1.0 - gap;
          float softness = max(0.001, uSceneWindGapSoftness) * (0.35 + 0.65 * gap);
          float spatial = smoothstep(threshold, threshold + softness, peak);
          float floorVal = clamp(uSceneWindStrengthFloor, 0.0, 0.95);
          return mix(floorVal, 1.0, spatial);
        }

        vec2 clumpWindDir(vec2 baseDir, float clumpId01, float spreadRad) {
          vec2 dir = normalize(baseDir);
          if (length(dir) < 0.01) dir = vec2(1.0, 0.0);
          float id = fract(clumpId01 + 1e-4);
          float a = (id - 0.5) * 2.0 * spreadRad;
          a += sin(id * 6.2831853 * 2.41) * spreadRad * 0.55;
          a += cos(id * 6.2831853 * 5.17) * spreadRad * 0.28;
          float c = cos(a);
          float s = sin(a);
          return vec2(dir.x * c - dir.y * s, dir.x * s + dir.y * c);
        }
`;

/**
 * @param {object} [params]
 * @returns {Record<string, { value: unknown }>}
 */
export function createVegetationSceneWindSharedUniforms(params = {}) {
  return {
    uSceneWindEnabled: { value: params.enabled !== false ? 1.0 : 0.0 },
    uSceneWindSpatialFreq: { value: Number(params.waveSpatialFrequency) || 0.0014 },
    uSceneWindWavePhase: { value: 0.0 },
    uSceneWindSharpness: { value: Number(params.waveSharpness) || 2.5 },
    uSceneWindGapRatio: { value: Number(params.gapRatio) ?? 0.4 },
    uSceneWindGapSoftness: { value: Number(params.gapSoftness) ?? 0.12 },
    uSceneWindStrengthFloor: { value: Number(params.spatialFloor) || 0.0 },
    uBendRiseSoftness: { value: Number(params.bendRiseSoftness) ?? 0.35 },
  };
}

/**
 * Push live scene-wind field values into vegetation shared uniforms.
 * @param {Record<string, { value: unknown }>|null|undefined} uniforms
 * @param {import('../../core/SceneWindField.js').SceneWindField|null|undefined} field
 */
export function bindVegetationSceneWindUniforms(uniforms, field) {
  if (!uniforms || !field) return;
  const u = field.getUniforms();
  if (uniforms.uSceneWindEnabled) uniforms.uSceneWindEnabled.value = u.uSceneWindEnabled;
  if (uniforms.uSceneWindSpatialFreq) uniforms.uSceneWindSpatialFreq.value = u.uSceneWindSpatialFreq;
  if (uniforms.uSceneWindWavePhase) uniforms.uSceneWindWavePhase.value = u.uSceneWindWavePhase;
  if (uniforms.uSceneWindSharpness) uniforms.uSceneWindSharpness.value = u.uSceneWindSharpness;
  if (uniforms.uSceneWindGapRatio) uniforms.uSceneWindGapRatio.value = u.uSceneWindGapRatio;
  if (uniforms.uSceneWindGapSoftness) uniforms.uSceneWindGapSoftness.value = u.uSceneWindGapSoftness;
  if (uniforms.uSceneWindStrengthFloor) uniforms.uSceneWindStrengthFloor.value = u.uSceneWindStrengthFloor;
  if (uniforms.uBendRiseSoftness) uniforms.uBendRiseSoftness.value = u.uBendRiseSoftness;
}
