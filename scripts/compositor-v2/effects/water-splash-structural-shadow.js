/**
 * Building + painted shadow lit-factor sampling for water splash/bubble particles.
 * Mirrors WaterEffectV2 `waterCombinedShadowLit` and vegetation overlay paths:
 * on multi-floor maps structural shadows are omitted from ShadowManager combined RT,
 * so splashes sample scene-space lit textures per receiver floor.
 *
 * @module compositor-v2/effects/water-splash-structural-shadow
 */

import { resolveEffectEnabled } from '../../effects/resolve-effect-enabled.js';
import {
  VEGETATION_BUILDING_SHADOW_UNIFORM_GLSL,
  VEGETATION_BUILDING_SHADOW_SAMPLE_GLSL,
  VEGETATION_BUILDING_SHADOW_SHARED_UNIFORM_KEYS,
  ensureVegetationShadowFallbackWhiteTexture,
  resolveFloorCompositorV2,
  syncVegetationBuildingShadowUniforms,
} from './vegetation-building-shadow.js';
import {
  VEGETATION_PAINTED_SHADOW_UNIFORM_GLSL,
  VEGETATION_PAINTED_SHADOW_SAMPLE_GLSL,
  VEGETATION_PAINTED_SHADOW_SHARED_UNIFORM_KEYS,
  syncVegetationPaintedShadowUniforms,
} from './vegetation-painted-shadow.js';

/** GLSL marker — bump {@link SPLASH_STRUCTURAL_SHADOW_SHADER_MARKER} when GLSL changes. */
export const SPLASH_STRUCTURAL_SHADOW_SHADER_MARKER = '/* MS_WATER_SPLASH_STRUCTURAL_SHADOW_V1 */';

/** Uniform + sample helpers injected ahead of splash fragment darken blocks. */
export const SPLASH_STRUCTURAL_SHADOW_GLSL =
  `${SPLASH_STRUCTURAL_SHADOW_SHADER_MARKER}\n` +
  VEGETATION_BUILDING_SHADOW_UNIFORM_GLSL +
  VEGETATION_PAINTED_SHADOW_UNIFORM_GLSL +
  'uniform float uSplashStructuralInCombined;\n' +
  'uniform float uPaintedShadowOpacity;\n' +
  VEGETATION_BUILDING_SHADOW_SAMPLE_GLSL +
  VEGETATION_PAINTED_SHADOW_SAMPLE_GLSL;

export const SPLASH_STRUCTURAL_SHADOW_SHARED_UNIFORM_KEYS = Object.freeze([
  ...VEGETATION_BUILDING_SHADOW_SHARED_UNIFORM_KEYS,
  ...VEGETATION_PAINTED_SHADOW_SHARED_UNIFORM_KEYS,
  'uSplashStructuralInCombined',
  'uPaintedShadowOpacity',
]);

/**
 * @param {typeof import('three')} THREE
 * @returns {Record<string, { value: unknown }>}
 */
export function createSplashStructuralShadowUniforms(THREE) {
  const white = ensureVegetationShadowFallbackWhiteTexture(THREE);
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
    uBuildingShadowEnabled: { value: 0.0 },
    uBuildingShadowDarkenStrength: { value: 1.0 },
    uBuildingShadowDarkenCurve: { value: 1.15 },
    tPaintedShadow0: { value: white },
    tPaintedShadow1: { value: white },
    tPaintedShadow2: { value: white },
    tPaintedShadow3: { value: white },
    uHasPaintedShadow0: { value: 0.0 },
    uHasPaintedShadow1: { value: 0.0 },
    uHasPaintedShadow2: { value: 0.0 },
    uHasPaintedShadow3: { value: 0.0 },
    uPaintedShadowMultiFloor: { value: 0.0 },
    uPaintedShadowEnabled: { value: 0.0 },
    uPaintedShadowDarkenStrength: { value: 1.0 },
    uPaintedShadowDarkenCurve: { value: 1.15 },
    uSplashStructuralInCombined: { value: 1.0 },
    uPaintedShadowOpacity: { value: 1.0 },
  };
}

/**
 * @param {Record<string, { value: unknown }>|null|undefined} materialUniforms
 * @param {Record<string, { value: unknown }>|null|undefined} sharedUniforms
 */
export function linkSplashStructuralShadowUniforms(materialUniforms, sharedUniforms) {
  if (!materialUniforms || !sharedUniforms) return;
  for (const key of SPLASH_STRUCTURAL_SHADOW_SHARED_UNIFORM_KEYS) {
    if (sharedUniforms[key]) materialUniforms[key] = sharedUniforms[key];
  }
}

/**
 * Bind live building/painted lit-factor RTs for splash darken (scene UV).
 * @param {Record<string, { value: unknown }>|null|undefined} sharedUniforms
 * @param {{ combinedShadowReady?: boolean }} [opts]
 */
export function syncSplashStructuralShadowUniforms(sharedUniforms, opts = {}) {
  if (!sharedUniforms) return;

  const fc = resolveFloorCompositorV2();
  const floorCount = Number(window.MapShine?.floorStack?.getFloors?.()?.length ?? 0);
  const combinedShadowReady = opts.combinedShadowReady === true;
  const structuralInCombined = floorCount <= 1 && combinedShadowReady;

  if (sharedUniforms.uSplashStructuralInCombined) {
    sharedUniforms.uSplashStructuralInCombined.value = structuralInCombined ? 1.0 : 0.0;
  }

  const buildingFx = fc?._buildingShadowEffect ?? null;
  const paintedFx = fc?._paintedShadowEffect ?? null;
  const buildingOn = !!(resolveEffectEnabled(buildingFx) && buildingFx?.params?.enabled);
  const paintedOn = !!(resolveEffectEnabled(paintedFx) && paintedFx?.params?.enabled);

  if (sharedUniforms.uBuildingShadowEnabled) {
    sharedUniforms.uBuildingShadowEnabled.value = (buildingOn && !structuralInCombined) ? 1.0 : 0.0;
  }
  if (sharedUniforms.uPaintedShadowEnabled) {
    sharedUniforms.uPaintedShadowEnabled.value = (paintedOn && !structuralInCombined) ? 1.0 : 0.0;
  }

  const sm = fc?._shadowManagerEffect ?? null;
  const po = Number(sm?.params?.paintedOpacity);
  if (sharedUniforms.uPaintedShadowOpacity) {
    sharedUniforms.uPaintedShadowOpacity.value = Number.isFinite(po)
      ? Math.max(0, Math.min(1, po))
      : 1.0;
  }

  syncVegetationBuildingShadowUniforms(sharedUniforms, {
    buildingShadowEnabled: buildingOn && !structuralInCombined,
  });
  syncVegetationPaintedShadowUniforms(sharedUniforms, {
    paintedShadowEnabled: paintedOn && !structuralInCombined,
  });
}

/**
 * @param {Record<string, { value: unknown }>|null|undefined} sharedUniforms
 * @param {number} floorIndex
 */
export function applySplashStructuralShadowFloorIndex(sharedUniforms, floorIndex) {
  if (!sharedUniforms?.uBuildingShadowFloorIndex) return;
  const fi = Number.isFinite(Number(floorIndex)) ? Math.max(0, Math.min(3, Math.floor(Number(floorIndex)))) : 0;
  sharedUniforms.uBuildingShadowFloorIndex.value = fi;
}

/** @param {string} fs @returns {boolean} */
export function splashShaderHasStructuralShadow(fs) {
  return typeof fs === 'string' && fs.includes(SPLASH_STRUCTURAL_SHADOW_SHADER_MARKER);
}

/**
 * @param {string} fs
 * @returns {string}
 */
export function injectSplashStructuralShadowGlsl(fs) {
  if (typeof fs !== 'string' || splashShaderHasStructuralShadow(fs)) return fs;
  const marker = '/* MS_WATER_SPLASHES_MASKING_V2 */';
  if (fs.includes(marker)) {
    return fs.replace(marker + '\n', `${marker}\n${SPLASH_STRUCTURAL_SHADOW_GLSL}\n`);
  }
  return `${SPLASH_STRUCTURAL_SHADOW_GLSL}\n${fs}`;
}
