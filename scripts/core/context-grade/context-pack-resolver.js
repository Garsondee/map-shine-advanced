/**
 * @fileoverview Composes base + env + token modifier packs into target overlays.
 * @module core/context-grade/context-pack-resolver
 */

import {
  addContextGradeOverlays,
  createNeutralContextGrade,
  finiteOr,
  lerpContextGrade,
  readModifierPack,
  readNamedContextPack,
  scaleContextGrade,
} from './context-grade-spec.js';

/**
 * @param {import('./context-env-resolver.js').ContextEnvResolver} envState
 * @param {Record<string, *>} params
 * @returns {import('./context-grade-spec.js').ContextGradeOverlay}
 */
export function resolveEnvModifierOverlay(envState, params) {
  if (params?.envModifiersEnabled === false) return createNeutralContextGrade();

  let overlay = createNeutralContextGrade();

  if (envState.skyCondition === 'storm') {
    overlay = addContextGradeOverlays(overlay, readModifierPack(params, 'envStorm'));
  } else if (envState.skyCondition === 'overcast') {
    overlay = addContextGradeOverlays(overlay, readModifierPack(params, 'envOvercast'));
  }

  if (envState.dayPhase === 'night') {
    overlay = addContextGradeOverlays(overlay, readModifierPack(params, 'envNight'));
  } else if (envState.dayPhase === 'twilight') {
    overlay = addContextGradeOverlays(overlay, readModifierPack(params, 'envTwilight'));
  }

  if (envState.darknessMood === 'heavy') {
    overlay = addContextGradeOverlays(overlay, readModifierPack(params, 'envDarkness'));
  }

  return overlay;
}

/**
 * @param {'outdoor'|'indoor'|'neutral'} baseState
 * @param {import('./context-dimensions.js').ContextDimensionSnapshot} dims
 * @param {Record<string, *>} params
 * @returns {import('./context-grade-spec.js').ContextGradeOverlay}
 */
export function resolveTokenContextOverlay(baseState, dims, params) {
  if (baseState === 'neutral') return createNeutralContextGrade();

  let overlay = readNamedContextPack(params, baseState);

  if (baseState === 'outdoor') {
    if (dims.outdoorSky === 'overcast' || dims.outdoorSky === 'storm') {
      const w = finiteOr(params?.modOutdoorOvercastWeight, 1);
      overlay = addContextGradeOverlays(
        overlay,
        scaleContextGrade(readModifierPack(params, 'modOutdoorOvercast'), w),
      );
    }
    if (dims.cloudShadow === 'shadowed') {
      const w = finiteOr(params?.modCloudShadowWeight, 1);
      overlay = addContextGradeOverlays(
        overlay,
        scaleContextGrade(readModifierPack(params, 'modCloudShadow'), w),
      );
    }
    if (dims.canopy === 'shaded') {
      const w = finiteOr(params?.modCanopyWeight, 1);
      overlay = addContextGradeOverlays(
        overlay,
        scaleContextGrade(readModifierPack(params, 'modCanopy'), w),
      );
    }
  }

  if (baseState === 'indoor' && dims.interiorLight === 'windowLit') {
    const blend = Math.max(0, Math.min(1, finiteOr(params?.modWindowLitBlend, 0.65)));
    const windowPack = readModifierPack(params, 'modWindowLit');
    overlay = lerpContextGrade(overlay, addContextGradeOverlays(overlay, windowPack), blend);
  }

  if (dims.coverShadow === 'buildingShadow') {
    const w = finiteOr(params?.modBuildingShadowWeight, 1);
    overlay = addContextGradeOverlays(
      overlay,
      scaleContextGrade(readModifierPack(params, 'modBuildingShadow'), w),
    );
  } else if (dims.coverShadow === 'paintedShadow') {
    const w = finiteOr(params?.modPaintedShadowWeight, 1);
    overlay = addContextGradeOverlays(
      overlay,
      scaleContextGrade(readModifierPack(params, 'modPaintedShadow'), w),
    );
  } else if (dims.coverShadow === 'treeDapple') {
    const w = finiteOr(params?.modTreeDappleWeight, 1);
    overlay = addContextGradeOverlays(
      overlay,
      scaleContextGrade(readModifierPack(params, 'modTreeDapple'), w),
    );
  }

  return overlay;
}

/**
 * Tree-dapple shader uniforms derived from params + dimensions.
 *
 * @param {import('./context-dimensions.js').ContextDimensionSnapshot} dims
 * @param {Record<string, *>} params
 * @returns {{ enabled: boolean, strength: number, scale: number, green: { r: number, g: number, b: number } }}
 */
export function resolveTreeDappleShaderState(dims, params) {
  const active = dims.coverShadow === 'treeDapple';
  return {
    enabled: active,
    strength: active ? finiteOr(params?.modTreeDappleStrength, 0.72) : 0,
    scale: finiteOr(params?.modTreeDappleScale, 42),
    green: {
      r: finiteOr(params?.modTreeDappleGreenR, 0.86),
      g: finiteOr(params?.modTreeDappleGreenG, 1.06),
      b: finiteOr(params?.modTreeDappleGreenB, 0.82),
    },
  };
}

/**
 * @param {'outdoor'|'indoor'|'neutral'} baseState
 * @param {import('./context-dimensions.js').ContextDimensionSnapshot} dims
 * @param {import('./context-env-resolver.js').ContextEnvResolver} envState
 * @param {Record<string, *>} params
 * @returns {import('./context-grade-spec.js').ContextGradeOverlay}
 */
export function resolveFullContextOverlay(baseState, dims, envState, params) {
  let overlay = resolveTokenContextOverlay(baseState, dims, params);
  overlay = addContextGradeOverlays(overlay, resolveEnvModifierOverlay(envState, params));
  return overlay;
}

/**
 * Token outdoor bias for Tier 3 spatial blend (0 indoor, 1 outdoor).
 *
 * @param {import('./context-dimensions.js').ContextDimensionSnapshot} dims
 * @param {number|null} outdoorsSample
 * @param {Record<string, *>} params
 * @returns {number}
 */
export function resolveTokenOutdoorBias(dims, outdoorsSample, params) {
  if (dims.indoorOutdoor === 'outdoor') return 1;
  if (dims.indoorOutdoor === 'indoor') return 0;
  const s = Number(outdoorsSample);
  if (!Number.isFinite(s)) return 0.5;
  const high = finiteOr(params?.outdoorThresholdHigh, 0.82);
  const low = finiteOr(params?.indoorThresholdLow, 0.18);
  if (s >= high) return 1;
  if (s <= low) return 0;
  return (s - low) / Math.max(0.001, high - low);
}
