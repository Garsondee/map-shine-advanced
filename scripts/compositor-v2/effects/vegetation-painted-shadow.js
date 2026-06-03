/**
 * @fileoverview Painted shadow darkening for post-lighting vegetation overlays (bush/tree).
 * @module compositor-v2/effects/vegetation-painted-shadow
 */

import { resolveEffectEnabled } from '../../effects/resolve-effect-enabled.js';
import {
  ensureVegetationShadowFallbackWhiteTexture,
  resolveFloorCompositorV2,
} from './vegetation-building-shadow.js';

export const VEGETATION_PAINTED_SHADOW_DEFAULTS = {
  paintedShadowEnabled: true,
  paintedShadowDarkenStrength: 1.0,
  paintedShadowDarkenCurve: 1.15,
};

/** GLSL uniform declarations (uses uBuildingShadowFloorIndex from building-shadow uniforms). */
export const VEGETATION_PAINTED_SHADOW_UNIFORM_GLSL = `
        uniform sampler2D tPaintedShadow0;
        uniform sampler2D tPaintedShadow1;
        uniform sampler2D tPaintedShadow2;
        uniform sampler2D tPaintedShadow3;
        uniform float uHasPaintedShadow0;
        uniform float uHasPaintedShadow1;
        uniform float uHasPaintedShadow2;
        uniform float uHasPaintedShadow3;
        uniform float uPaintedShadowMultiFloor;
        uniform float uPaintedShadowEnabled;
        uniform float uPaintedShadowDarkenStrength;
        uniform float uPaintedShadowDarkenCurve;
`;

export const VEGETATION_PAINTED_SHADOW_SHARED_UNIFORM_KEYS = Object.freeze([
  'tPaintedShadow0',
  'tPaintedShadow1',
  'tPaintedShadow2',
  'tPaintedShadow3',
  'uHasPaintedShadow0',
  'uHasPaintedShadow1',
  'uHasPaintedShadow2',
  'uHasPaintedShadow3',
  'uPaintedShadowMultiFloor',
  'uPaintedShadowEnabled',
  'uPaintedShadowDarkenStrength',
  'uPaintedShadowDarkenCurve',
]);

/**
 * Sample painted lit factor (R = lit, 0 = shadowed) in scene UV.
 * Requires `sceneUv` and `uBuildingShadowFloorIndex` in scope (same Y flip as building).
 */
export const VEGETATION_PAINTED_SHADOW_SAMPLE_GLSL = `
        float msaVegetationPaintedShadowLit(vec2 sceneUv) {
          vec2 pntUv = vec2(sceneUv.x, 1.0 - sceneUv.y);
          float fi = clamp(uBuildingShadowFloorIndex, 0.0, 3.0);
          if (uPaintedShadowMultiFloor > 0.5) {
            if (fi < 0.5 && uHasPaintedShadow0 > 0.5) {
              return clamp(texture2D(tPaintedShadow0, pntUv).r, 0.0, 1.0);
            }
            if (fi < 1.5 && uHasPaintedShadow1 > 0.5) {
              return clamp(texture2D(tPaintedShadow1, pntUv).r, 0.0, 1.0);
            }
            if (fi < 2.5 && uHasPaintedShadow2 > 0.5) {
              return clamp(texture2D(tPaintedShadow2, pntUv).r, 0.0, 1.0);
            }
            if (uHasPaintedShadow3 > 0.5) {
              return clamp(texture2D(tPaintedShadow3, pntUv).r, 0.0, 1.0);
            }
            return 1.0;
          }
          if (uHasPaintedShadow0 > 0.5) {
            return clamp(texture2D(tPaintedShadow0, pntUv).r, 0.0, 1.0);
          }
          return 1.0;
        }
`;

/** Expects `c` (vec3) and `sceneUv` in scope. */
export const VEGETATION_PAINTED_SHADOW_APPLY_GLSL = `
          if (uPaintedShadowEnabled > 0.5
              && (uLightningVegetationEnabled < 0.5 || uLightningFlash01 < 0.01)) {
            float pntLit = msaVegetationPaintedShadowLit(sceneUv);
            float pntShade = 1.0 - pntLit;
            float pStrength = clamp(uPaintedShadowDarkenStrength, 0.0, 3.0);
            float pCurve = max(0.01, uPaintedShadowDarkenCurve);
            float pntDarken = min(1.0, pStrength * pow(pntShade, pCurve));
            c *= (1.0 - pntDarken);
          }
`;

/**
 * @param {object|null|undefined} paintedFx
 * @param {import('three').WebGLRenderer|null|undefined} renderer
 * @param {number} floorIndex
 * @returns {import('three').Texture|null}
 */
function resolvePaintedShadowTextureForFloor(paintedFx, renderer, floorIndex) {
  if (!paintedFx?.params?.enabled) return null;
  const idx = Math.max(0, Math.min(3, Math.floor(Number(floorIndex))));
  const floorCount = Number(window.MapShine?.floorStack?.getFloors?.()?.length ?? 0);
  if (floorCount <= 1) {
    return paintedFx.shadowFactorTexture ?? null;
  }
  if (idx <= 0) {
    return paintedFx.groundOnlyLitTexture ?? paintedFx.shadowFactorTexture ?? null;
  }
  if (typeof paintedFx.renderLitForSingleFloor === 'function' && renderer) {
    try {
      return paintedFx.renderLitForSingleFloor(renderer, idx)
        ?? paintedFx.groundOnlyLitTexture
        ?? null;
    } catch (_) {}
  }
  return paintedFx.groundOnlyLitTexture ?? null;
}

/**
 * @param {typeof import('three')} THREE
 * @param {object} [params]
 * @returns {Record<string, { value: unknown }>}
 */
export function createVegetationPaintedShadowUniforms(THREE, params = {}) {
  const p = { ...VEGETATION_PAINTED_SHADOW_DEFAULTS, ...params };
  const white = ensureVegetationShadowFallbackWhiteTexture(THREE);
  return {
    tPaintedShadow0: { value: white },
    tPaintedShadow1: { value: white },
    tPaintedShadow2: { value: white },
    tPaintedShadow3: { value: white },
    uHasPaintedShadow0: { value: 0.0 },
    uHasPaintedShadow1: { value: 0.0 },
    uHasPaintedShadow2: { value: 0.0 },
    uHasPaintedShadow3: { value: 0.0 },
    uPaintedShadowMultiFloor: { value: 0.0 },
    uPaintedShadowEnabled: { value: p.paintedShadowEnabled ? 1.0 : 0.0 },
    uPaintedShadowDarkenStrength: { value: Number(p.paintedShadowDarkenStrength) || 1.0 },
    uPaintedShadowDarkenCurve: { value: Number(p.paintedShadowDarkenCurve) || 1.15 },
  };
}

/**
 * @param {Record<string, { value: unknown }>|null|undefined} uniforms
 * @param {object} params
 */
export function applyVegetationPaintedShadowParamsToUniforms(uniforms, params = {}) {
  if (!uniforms) return;
  const p = { ...VEGETATION_PAINTED_SHADOW_DEFAULTS, ...params };
  if (uniforms.uPaintedShadowEnabled) {
    uniforms.uPaintedShadowEnabled.value = p.paintedShadowEnabled !== false ? 1.0 : 0.0;
  }
  if (uniforms.uPaintedShadowDarkenStrength) {
    uniforms.uPaintedShadowDarkenStrength.value = Number(p.paintedShadowDarkenStrength) || 1.0;
  }
  if (uniforms.uPaintedShadowDarkenCurve) {
    uniforms.uPaintedShadowDarkenCurve.value = Number(p.paintedShadowDarkenCurve) || 1.15;
  }
}

/**
 * @param {Record<string, { value: unknown }>|null|undefined} materialUniforms
 * @param {Record<string, { value: unknown }>|null|undefined} sharedUniforms
 */
export function linkVegetationPaintedShadowUniforms(materialUniforms, sharedUniforms) {
  if (!materialUniforms || !sharedUniforms) return;
  for (const key of VEGETATION_PAINTED_SHADOW_SHARED_UNIFORM_KEYS) {
    if (sharedUniforms[key]) materialUniforms[key] = sharedUniforms[key];
  }
}

export function syncVegetationPaintedShadowUniforms(sharedUniforms, params = {}) {
  if (!sharedUniforms) return;

  applyVegetationPaintedShadowParamsToUniforms(sharedUniforms, params);

  const fc = resolveFloorCompositorV2();
  const paintedFx = fc?._paintedShadowEffect ?? null;
  const paintedOn = !!(resolveEffectEnabled(paintedFx) && paintedFx?.params?.enabled);
  const renderer = fc?.renderer ?? null;
  const THREE = window.THREE;
  const white = THREE ? ensureVegetationShadowFallbackWhiteTexture(THREE) : null;

  const floorCount = Number(window.MapShine?.floorStack?.getFloors?.()?.length ?? 0);
  const multiFloor = paintedOn && floorCount > 1;

  if (sharedUniforms.uPaintedShadowMultiFloor) {
    sharedUniforms.uPaintedShadowMultiFloor.value = multiFloor ? 1.0 : 0.0;
  }

  for (let i = 0; i < 4; i++) {
    const texKey = `tPaintedShadow${i}`;
    const hasKey = `uHasPaintedShadow${i}`;
    let tex = null;
    if (paintedOn) {
      tex = resolvePaintedShadowTextureForFloor(paintedFx, renderer, i);
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
export function syncVegetationPaintedShadowForEffect(effect) {
  const sharedUniforms = effect?._sharedUniforms;
  if (!sharedUniforms) return;
  syncVegetationPaintedShadowUniforms(sharedUniforms, effect?.params ?? {});
  const overlays = effect?._overlays;
  if (!overlays?.values) return;
  for (const entry of overlays.values()) {
    linkVegetationPaintedShadowUniforms(entry?.material?.uniforms, sharedUniforms);
    linkVegetationPaintedShadowUniforms(entry?.shadowMaterial?.uniforms, sharedUniforms);
  }
}

export const VEGETATION_PAINTED_SHADOW_CONTROL_SCHEMA = {
  paintedShadowEnabled: {
    type: 'boolean',
    label: 'Painted shadows',
    default: true,
    tooltip: 'Darken canopy pixels where PaintedShadowEffectV2 is shaded (scene UV, matches ground).',
  },
  paintedShadowDarkenStrength: {
    type: 'slider',
    label: 'Shadow strength',
    min: 0,
    max: 3,
    step: 0.01,
    default: 1.0,
    tooltip: 'How strongly painted shadow shade darkens the foliage.',
  },
  paintedShadowDarkenCurve: {
    type: 'slider',
    label: 'Shadow curve',
    min: 0.1,
    max: 8,
    step: 0.01,
    default: 1.15,
    tooltip: 'Higher = softer penumbra, lower = harder painted edges on leaves.',
  },
};
