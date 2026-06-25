/**
 * Building + painted lit-factor sampling for water splash/bubble particles.
 * Lite path: one building + one painted sampler per system (floor-bound at sync).
 *
 * @module compositor-v2/effects/water-splash-structural-shadow
 */

import { resolveEffectEnabled } from '../../effects/resolve-effect-enabled.js';
import {
  ensureVegetationShadowFallbackWhiteTexture,
  resolveBuildingShadowTextureForFloor,
  resolveFloorCompositorV2,
} from './vegetation-building-shadow.js';
import { resolvePaintedShadowTextureForFloor } from './vegetation-painted-shadow.js';

const SPLASH_STRUCTURAL_SHADOW_LEGACY_MARKER = '/* MS_WATER_SPLASH_STRUCTURAL_SHADOW_V1 */';
/** Bump when GLSL changes — triggers hot-upgrade in WaterSplashesEffectV2. */
export const SPLASH_STRUCTURAL_SHADOW_SHADER_MARKER = '/* MS_WATER_SPLASH_STRUCTURAL_SHADOW_V2 */';

export const SPLASH_STRUCTURAL_SHADOW_GLSL =
  `${SPLASH_STRUCTURAL_SHADOW_SHADER_MARKER}\n` +
  'uniform sampler2D tBuildingShadow0;\n' +
  'uniform float uHasBuildingShadow0;\n' +
  'uniform float uBuildingShadowEnabled;\n' +
  'uniform sampler2D tPaintedShadow0;\n' +
  'uniform float uHasPaintedShadow0;\n' +
  'uniform float uPaintedShadowEnabled;\n' +
  'uniform float uSplashStructuralInCombined;\n' +
  'uniform float uPaintedShadowOpacity;\n' +
  'float msaSplashBuildingShadowLit(vec2 sceneUv) {\n' +
  '  if (uHasBuildingShadow0 < 0.5) return 1.0;\n' +
  '  vec2 bldUv = vec2(sceneUv.x, 1.0 - sceneUv.y);\n' +
  '  return clamp(texture2D(tBuildingShadow0, bldUv).r, 0.0, 1.0);\n' +
  '}\n' +
  'float msaSplashPaintedShadowLit(vec2 sceneUv) {\n' +
  '  if (uHasPaintedShadow0 < 0.5) return 1.0;\n' +
  '  vec2 pntUv = vec2(sceneUv.x, 1.0 - sceneUv.y);\n' +
  '  float lit = clamp(texture2D(tPaintedShadow0, pntUv).r, 0.0, 1.0);\n' +
  '  float edgeDist = min(min(sceneUv.x, 1.0 - sceneUv.x), min(sceneUv.y, 1.0 - sceneUv.y));\n' +
  '  float borderGate = smoothstep(0.0, 0.0025, edgeDist);\n' +
  '  return mix(1.0, lit, borderGate);\n' +
  '}\n' +
  'float msaVegetationBuildingShadowLit(vec2 sceneUv) {\n' +
  '  return msaSplashBuildingShadowLit(sceneUv);\n' +
  '}\n' +
  'float msaVegetationPaintedShadowLit(vec2 sceneUv) {\n' +
  '  return msaSplashPaintedShadowLit(sceneUv);\n' +
  '}\n';

export const SPLASH_STRUCTURAL_SHADOW_SHARED_UNIFORM_KEYS = Object.freeze([
  'tBuildingShadow0',
  'uHasBuildingShadow0',
  'uBuildingShadowEnabled',
  'tPaintedShadow0',
  'uHasPaintedShadow0',
  'uPaintedShadowEnabled',
  'uSplashStructuralInCombined',
  'uPaintedShadowOpacity',
  'uBuildingShadowFloorIndex',
]);

/**
 * @param {typeof import('three')} THREE
 * @returns {Record<string, { value: unknown }>}
 */
export function createSplashStructuralShadowUniforms(THREE) {
  const white = ensureVegetationShadowFallbackWhiteTexture(THREE);
  return {
    tBuildingShadow0: { value: white },
    uHasBuildingShadow0: { value: 0.0 },
    uBuildingShadowEnabled: { value: 0.0 },
    tPaintedShadow0: { value: white },
    uHasPaintedShadow0: { value: 0.0 },
    uPaintedShadowEnabled: { value: 0.0 },
    uSplashStructuralInCombined: { value: 1.0 },
    uPaintedShadowOpacity: { value: 1.0 },
    uBuildingShadowFloorIndex: { value: 0.0 },
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
 * Bind per-floor lit-factor RTs for splash darken (scene UV).
 * @param {Record<string, { value: unknown }>|null|undefined} sharedUniforms
 * @param {{ combinedShadowReady?: boolean, floorIndex?: number }} [opts]
 */
export function syncSplashStructuralShadowUniforms(sharedUniforms, opts = {}) {
  if (!sharedUniforms) return;

  const fc = resolveFloorCompositorV2();
  const floorCount = Number(window.MapShine?.floorStack?.getFloors?.()?.length ?? 0);
  const combinedShadowReady = opts.combinedShadowReady === true;
  const structuralInCombined = floorCount <= 1 && combinedShadowReady;
  const floorIndex = Number.isFinite(Number(opts.floorIndex)) ? Math.floor(Number(opts.floorIndex)) : 0;

  const THREE = window.THREE;
  const white = THREE ? ensureVegetationShadowFallbackWhiteTexture(THREE) : null;

  if (sharedUniforms.uSplashStructuralInCombined) {
    sharedUniforms.uSplashStructuralInCombined.value = structuralInCombined ? 1.0 : 0.0;
  }

  const buildingFx = fc?._buildingShadowEffect ?? null;
  const paintedFx = fc?._paintedShadowEffect ?? null;
  const buildingOn = !!(resolveEffectEnabled(buildingFx) && buildingFx?.params?.enabled);
  const paintedOn = !!(resolveEffectEnabled(paintedFx) && paintedFx?.params?.enabled);
  const buildingActive = buildingOn && !structuralInCombined;
  const paintedActive = paintedOn && !structuralInCombined;

  if (sharedUniforms.uBuildingShadowEnabled) {
    sharedUniforms.uBuildingShadowEnabled.value = buildingActive ? 1.0 : 0.0;
  }
  if (sharedUniforms.uPaintedShadowEnabled) {
    sharedUniforms.uPaintedShadowEnabled.value = paintedActive ? 1.0 : 0.0;
  }

  const sm = fc?._shadowManagerEffect ?? null;
  const po = Number(sm?.params?.paintedOpacity);
  if (sharedUniforms.uPaintedShadowOpacity) {
    sharedUniforms.uPaintedShadowOpacity.value = Number.isFinite(po)
      ? Math.max(0, Math.min(1, po))
      : 1.0;
  }

  const renderer = fc?.renderer ?? null;
  const bldTex = buildingActive
    ? resolveBuildingShadowTextureForFloor(buildingFx, renderer, floorIndex)
    : null;
  if (sharedUniforms.tBuildingShadow0) {
    sharedUniforms.tBuildingShadow0.value = bldTex ?? white;
  }
  if (sharedUniforms.uHasBuildingShadow0) {
    sharedUniforms.uHasBuildingShadow0.value = bldTex ? 1.0 : 0.0;
  }

  const pntTex = paintedActive
    ? resolvePaintedShadowTextureForFloor(paintedFx, renderer, floorIndex)
    : null;
  if (sharedUniforms.tPaintedShadow0) {
    sharedUniforms.tPaintedShadow0.value = pntTex ?? white;
  }
  if (sharedUniforms.uHasPaintedShadow0) {
    sharedUniforms.uHasPaintedShadow0.value = pntTex ? 1.0 : 0.0;
  }
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
  return typeof fs === 'string'
    && fs.includes(SPLASH_STRUCTURAL_SHADOW_SHADER_MARKER)
    && fs.includes('msaSplashBuildingShadowLit');
}

/**
 * Strip V1 eight-sampler structural block.
 * @param {string} fs
 * @returns {string}
 */
function stripLegacyStructuralShadowGlsl(fs) {
  if (typeof fs !== 'string') return fs;
  if (!fs.includes(SPLASH_STRUCTURAL_SHADOW_LEGACY_MARKER)
    && !fs.includes('uniform sampler2D tBuildingShadow1')) {
    return fs;
  }
  let out = fs;
  const markerIdx = out.indexOf(SPLASH_STRUCTURAL_SHADOW_LEGACY_MARKER);
  if (markerIdx >= 0) {
    const nextMarker = out.indexOf('/* MS_', markerIdx + 1);
    const end = nextMarker > markerIdx ? nextMarker : out.length;
    out = out.slice(0, markerIdx) + out.slice(end);
  }
  out = out.replace(/uniform sampler2D tBuildingShadow[1-3];\s*\n/g, '');
  out = out.replace(/uniform float uHasBuildingShadow[1-3];\s*\n/g, '');
  out = out.replace(/uniform float uBuildingShadowMultiFloor;\s*\n/g, '');
  out = out.replace(/uniform float uBuildingShadowDarkenStrength;\s*\n/g, '');
  out = out.replace(/uniform float uBuildingShadowDarkenCurve;\s*\n/g, '');
  out = out.replace(/uniform sampler2D tPaintedShadow[1-3];\s*\n/g, '');
  out = out.replace(/uniform float uHasPaintedShadow[1-3];\s*\n/g, '');
  out = out.replace(/uniform float uPaintedShadowMultiFloor;\s*\n/g, '');
  out = out.replace(/uniform float uPaintedShadowDarkenStrength;\s*\n/g, '');
  out = out.replace(/uniform float uPaintedShadowDarkenCurve;\s*\n/g, '');
  return out;
}

/**
 * @param {string} fs
 * @returns {string}
 */
export function injectSplashStructuralShadowGlsl(fs) {
  if (typeof fs !== 'string') return fs;
  let out = stripLegacyStructuralShadowGlsl(fs);
  if (splashShaderHasStructuralShadow(out)) return out;
  const marker = '/* MS_WATER_SPLASHES_MASKING_V2 */';
  if (out.includes(marker)) {
    return out.replace(marker + '\n', `${marker}\n${SPLASH_STRUCTURAL_SHADOW_GLSL}\n`);
  }
  return `${SPLASH_STRUCTURAL_SHADOW_GLSL}\n${out}`;
}
