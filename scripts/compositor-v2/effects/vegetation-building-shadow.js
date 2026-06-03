/**
 * @fileoverview Building shadow darkening for post-lighting vegetation overlays (bush/tree).
 * @module compositor-v2/effects/vegetation-building-shadow
 */

import { resolveEffectEnabled } from '../../effects/resolve-effect-enabled.js';

/** @type {import('three').DataTexture|null} */
let _fallbackWhiteTex = null;

export const VEGETATION_BUILDING_SHADOW_DEFAULTS = {
  buildingShadowEnabled: true,
  buildingShadowDarkenStrength: 1.0,
  buildingShadowDarkenCurve: 1.15,
};

/** GLSL uniform declarations (inject into vegetation fragment shaders). */
export const VEGETATION_BUILDING_SHADOW_UNIFORM_GLSL = `
        uniform sampler2D tBuildingShadow0;
        uniform sampler2D tBuildingShadow1;
        uniform sampler2D tBuildingShadow2;
        uniform sampler2D tBuildingShadow3;
        uniform float uHasBuildingShadow0;
        uniform float uHasBuildingShadow1;
        uniform float uHasBuildingShadow2;
        uniform float uHasBuildingShadow3;
        uniform float uBuildingShadowMultiFloor;
        uniform float uBuildingShadowFloorIndex;
        uniform float uBuildingShadowEnabled;
        uniform float uBuildingShadowDarkenStrength;
        uniform float uBuildingShadowDarkenCurve;
`;

/** Shared keys (per-material floor index is not linked). */
export const VEGETATION_BUILDING_SHADOW_SHARED_UNIFORM_KEYS = Object.freeze([
  'tBuildingShadow0',
  'tBuildingShadow1',
  'tBuildingShadow2',
  'tBuildingShadow3',
  'uHasBuildingShadow0',
  'uHasBuildingShadow1',
  'uHasBuildingShadow2',
  'uHasBuildingShadow3',
  'uBuildingShadowMultiFloor',
  'uBuildingShadowEnabled',
  'uBuildingShadowDarkenStrength',
  'uBuildingShadowDarkenCurve',
]);

/**
 * Sample building lit factor (R = lit, 0 = shadowed) in scene UV.
 * Requires `sceneUv` (vec2) in scope — bush/tree edge-safety UV (Three world / scene rect).
 * BuildingShadowsEffectV2 RTs match SpecularEffectV2: flip Y vs that UV (see specular-shader bsUv).
 */
export const VEGETATION_BUILDING_SHADOW_SAMPLE_GLSL = `
        float msaVegetationBuildingShadowLit(vec2 sceneUv) {
          vec2 bldUv = vec2(sceneUv.x, 1.0 - sceneUv.y);
          float fi = clamp(uBuildingShadowFloorIndex, 0.0, 3.0);
          if (uBuildingShadowMultiFloor > 0.5) {
            if (fi < 0.5 && uHasBuildingShadow0 > 0.5) {
              return clamp(texture2D(tBuildingShadow0, bldUv).r, 0.0, 1.0);
            }
            if (fi < 1.5 && uHasBuildingShadow1 > 0.5) {
              return clamp(texture2D(tBuildingShadow1, bldUv).r, 0.0, 1.0);
            }
            if (fi < 2.5 && uHasBuildingShadow2 > 0.5) {
              return clamp(texture2D(tBuildingShadow2, bldUv).r, 0.0, 1.0);
            }
            if (uHasBuildingShadow3 > 0.5) {
              return clamp(texture2D(tBuildingShadow3, bldUv).r, 0.0, 1.0);
            }
            return 1.0;
          }
          if (uHasBuildingShadow0 > 0.5) {
            return clamp(texture2D(tBuildingShadow0, bldUv).r, 0.0, 1.0);
          }
          return 1.0;
        }
`;

/**
 * Darken canopy RGB from BuildingShadowsEffectV2 (scene UV, R = lit).
 * Expects `c` (vec3) and `sceneUv` in scope.
 */
export const VEGETATION_BUILDING_SHADOW_APPLY_GLSL = `
          if (uBuildingShadowEnabled > 0.5
              && (uLightningVegetationEnabled < 0.5 || uLightningFlash01 < 0.01)) {
            float bldLit = msaVegetationBuildingShadowLit(sceneUv);
            float bldShade = 1.0 - bldLit;
            float bStrength = clamp(uBuildingShadowDarkenStrength, 0.0, 3.0);
            float bCurve = max(0.01, uBuildingShadowDarkenCurve);
            float bldDarken = min(1.0, bStrength * pow(bldShade, bCurve));
            c *= (1.0 - bldDarken);
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
 * @param {object|null|undefined} buildingFx
 * @param {import('three').WebGLRenderer|null|undefined} renderer
 * @param {number} floorIndex
 * @returns {import('three').Texture|null}
 */
/** @returns {object|null} */
function resolveFloorCompositorV2() {
  try {
    return window.MapShine?.effectComposer?._floorCompositorV2
      ?? window.MapShine?.floorCompositorV2
      ?? null;
  } catch (_) {
    return null;
  }
}

function resolveBuildingShadowTextureForFloor(buildingFx, renderer, floorIndex) {
  if (!buildingFx?.params?.enabled) return null;
  const idx = Math.max(0, Math.min(3, Math.floor(Number(floorIndex))));
  const floorCount = Number(window.MapShine?.floorStack?.getFloors?.()?.length ?? 0);
  if (floorCount <= 1) {
    return buildingFx.shadowFactorTexture ?? null;
  }
  if (idx <= 0) {
    return buildingFx.groundOnlyLitTexture ?? buildingFx.shadowFactorTexture ?? null;
  }
  if (typeof buildingFx.renderLitForSingleFloor === 'function' && renderer) {
    try {
      return buildingFx.renderLitForSingleFloor(renderer, idx)
        ?? buildingFx.groundOnlyLitTexture
        ?? null;
    } catch (_) {}
  }
  return buildingFx.groundOnlyLitTexture ?? null;
}

/**
 * @param {typeof import('three')} THREE
 * @param {object} [params]
 * @returns {Record<string, { value: unknown }>}
 */
export function createVegetationBuildingShadowUniforms(THREE, params = {}) {
  const p = { ...VEGETATION_BUILDING_SHADOW_DEFAULTS, ...params };
  const white = ensureFallbackWhiteTexture(THREE);
  return {
    tBuildingShadow0: { value: white },
    tBuildingShadow1: { value: white },
    tBuildingShadow2: { value: white },
    tBuildingShadow3: { value: white },
    uHasBuildingShadow0: { value: 0.0 },
    uHasBuildingShadow1: { value: 0.0 },
    uHasBuildingShadow2: { value: 0.0 },
    uHasBuildingShadow3: { value: 0.0 },
    uBuildingShadowMultiFloor: { value: 0.0 },
    uBuildingShadowFloorIndex: { value: 0.0 },
    uBuildingShadowEnabled: { value: p.buildingShadowEnabled ? 1.0 : 0.0 },
    uBuildingShadowDarkenStrength: { value: Number(p.buildingShadowDarkenStrength) || 1.0 },
    uBuildingShadowDarkenCurve: { value: Number(p.buildingShadowDarkenCurve) || 1.15 },
  };
}

/**
 * @param {Record<string, { value: unknown }>|null|undefined} uniforms
 * @param {object} params
 */
export function applyVegetationBuildingShadowParamsToUniforms(uniforms, params = {}) {
  if (!uniforms) return;
  const p = { ...VEGETATION_BUILDING_SHADOW_DEFAULTS, ...params };
  if (uniforms.uBuildingShadowEnabled) {
    uniforms.uBuildingShadowEnabled.value = p.buildingShadowEnabled !== false ? 1.0 : 0.0;
  }
  if (uniforms.uBuildingShadowDarkenStrength) {
    uniforms.uBuildingShadowDarkenStrength.value = Number(p.buildingShadowDarkenStrength) || 1.0;
  }
  if (uniforms.uBuildingShadowDarkenCurve) {
    uniforms.uBuildingShadowDarkenCurve.value = Number(p.buildingShadowDarkenCurve) || 1.15;
  }
}

/**
 * Bind live building shadow lit-factor RTs (call after BuildingShadowsEffectV2 each frame).
 * @param {Record<string, { value: unknown }>|null|undefined} sharedUniforms
 * @param {{ buildingShadowEnabled?: boolean }} [params]
 */
/**
 * @param {Record<string, { value: unknown }>|null|undefined} materialUniforms
 * @param {Record<string, { value: unknown }>|null|undefined} sharedUniforms
 */
export function linkVegetationBuildingShadowUniforms(materialUniforms, sharedUniforms) {
  if (!materialUniforms || !sharedUniforms) return;
  for (const key of VEGETATION_BUILDING_SHADOW_SHARED_UNIFORM_KEYS) {
    if (sharedUniforms[key]) materialUniforms[key] = sharedUniforms[key];
  }
}

export function syncVegetationBuildingShadowUniforms(sharedUniforms, params = {}) {
  if (!sharedUniforms) return;

  applyVegetationBuildingShadowParamsToUniforms(sharedUniforms, params);

  const fc = resolveFloorCompositorV2();
  const buildingFx = fc?._buildingShadowEffect ?? null;
  const buildingOn = !!(resolveEffectEnabled(buildingFx) && buildingFx?.params?.enabled);
  const renderer = fc?.renderer ?? null;
  const THREE = window.THREE;
  const white = THREE ? ensureFallbackWhiteTexture(THREE) : null;

  const floorCount = Number(window.MapShine?.floorStack?.getFloors?.()?.length ?? 0);
  const multiFloor = buildingOn && floorCount > 1;

  if (sharedUniforms.uBuildingShadowMultiFloor) {
    sharedUniforms.uBuildingShadowMultiFloor.value = multiFloor ? 1.0 : 0.0;
  }

  for (let i = 0; i < 4; i++) {
    const texKey = `tBuildingShadow${i}`;
    const hasKey = `uHasBuildingShadow${i}`;
    let tex = null;
    if (buildingOn) {
      tex = resolveBuildingShadowTextureForFloor(buildingFx, renderer, i);
    }
    if (sharedUniforms[texKey]) {
      sharedUniforms[texKey].value = tex ?? white;
    }
    if (sharedUniforms[hasKey]) {
      sharedUniforms[hasKey].value = tex ? 1.0 : 0.0;
    }
  }
}

/**
 * @param {{ _sharedUniforms?: Record<string, { value: unknown }>, _overlays?: Map, params?: object }|null|undefined} effect
 */
export function syncVegetationBuildingShadowForEffect(effect) {
  const sharedUniforms = effect?._sharedUniforms;
  if (!sharedUniforms) return;
  syncVegetationBuildingShadowUniforms(sharedUniforms, effect?.params ?? {});
  const overlays = effect?._overlays;
  if (!overlays?.values) return;
  for (const entry of overlays.values()) {
    linkVegetationBuildingShadowUniforms(entry?.material?.uniforms, sharedUniforms);
    linkVegetationBuildingShadowUniforms(entry?.shadowMaterial?.uniforms, sharedUniforms);
  }
}

/** Control schema fragment for BushEffectV2 / TreeEffectV2. */
export const VEGETATION_BUILDING_SHADOW_CONTROL_SCHEMA = {
  buildingShadowEnabled: {
    type: 'boolean',
    label: 'Building shadows',
    default: true,
    tooltip: 'Darken canopy pixels where the building shadow map is shaded (scene UV, matches ground).',
  },
  buildingShadowDarkenStrength: {
    type: 'slider',
    label: 'Shadow strength',
    min: 0,
    max: 3,
    step: 0.01,
    default: 1.0,
    tooltip: 'How strongly structural building shade darkens the foliage.',
  },
  buildingShadowDarkenCurve: {
    type: 'slider',
    label: 'Shadow curve',
    min: 0.1,
    max: 8,
    step: 0.01,
    default: 1.15,
    tooltip: 'Higher = softer penumbra, lower = harder building edges on leaves.',
  },
};
