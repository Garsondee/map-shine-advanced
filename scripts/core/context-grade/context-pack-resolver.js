/**
 * @fileoverview Composes base + env + token modifier packs into target overlays.
 * @module core/context-grade/context-pack-resolver
 */

import {
  addContextGradeOverlays,
  computeOutdoorBlendWeight,
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
 * Token modifiers excluding cover shadow (cloud, canopy, outdoor overcast).
 *
 * @param {'outdoor'|'indoor'|'neutral'} baseState
 * @param {import('./context-dimensions.js').ContextDimensionSnapshot} dims
 * @param {Record<string, *>} params
 * @returns {import('./context-grade-spec.js').ContextGradeOverlay}
 */
export function resolveTokenAmbientModifierOverlay(baseState, dims, params) {
  if (baseState !== 'outdoor') return createNeutralContextGrade();

  let overlay = createNeutralContextGrade();

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

  return overlay;
}

/**
 * Building / painted / tree cover shadow modifier only.
 *
 * @param {'outdoor'|'indoor'|'neutral'} baseState
 * @param {import('./context-dimensions.js').ContextDimensionSnapshot} dims
 * @param {Record<string, *>} params
 * @returns {import('./context-grade-spec.js').ContextGradeOverlay}
 */
export function resolveTokenCoverShadowOverlay(baseState, dims, params) {
  if (baseState !== 'outdoor') return createNeutralContextGrade();

  if (dims.coverShadow === 'buildingShadow') {
    const w = finiteOr(params?.modBuildingShadowWeight, 1);
    return scaleContextGrade(readModifierPack(params, 'modBuildingShadow'), w);
  }
  if (dims.coverShadow === 'paintedShadow') {
    const w = finiteOr(params?.modPaintedShadowWeight, 1);
    return scaleContextGrade(readModifierPack(params, 'modPaintedShadow'), w);
  }
  if (dims.coverShadow === 'treeDapple') {
    const w = finiteOr(params?.modTreeDappleWeight, 1);
    return scaleContextGrade(readModifierPack(params, 'modTreeDapple'), w);
  }

  return createNeutralContextGrade();
}

/**
 * Indoor/outdoor base pack + window-lit (no ambient or cover modifiers).
 *
 * @param {'outdoor'|'indoor'|'neutral'} baseState
 * @param {import('./context-dimensions.js').ContextDimensionSnapshot} dims
 * @param {Record<string, *>} params
 * @returns {import('./context-grade-spec.js').ContextGradeOverlay}
 */
export function resolveTokenBaseOverlay(baseState, dims, params) {
  if (baseState === 'neutral') return createNeutralContextGrade();

  let overlay = readNamedContextPack(params, baseState);

  if (baseState === 'indoor' && dims.interiorLight === 'windowLit') {
    const blend = Math.max(0, Math.min(1, finiteOr(params?.modWindowLitBlend, 0.65)));
    const windowPack = readModifierPack(params, 'modWindowLit');
    overlay = lerpContextGrade(overlay, addContextGradeOverlays(overlay, windowPack), blend);
  }

  return overlay;
}

/**
 * Indoor↔outdoor base pack blended by smooth outdoor weight (no discrete flip).
 *
 * @param {number|null|undefined} outdoorsSample
 * @param {import('./context-dimensions.js').ContextDimensionSnapshot} dims
 * @param {Record<string, *>} params
 * @returns {import('./context-grade-spec.js').ContextGradeOverlay}
 */
export function resolveTokenBaseOverlaySoft(outdoorsSample, dims, params) {
  const w = computeOutdoorBlendWeight(outdoorsSample, params);
  const indoor = resolveTokenBaseOverlay('indoor', dims, params);
  const outdoor = resolveTokenBaseOverlay('outdoor', dims, params);
  return lerpContextGrade(indoor, outdoor, w);
}

/**
 * All token modifiers (ambient + cover shadow) — combined modifier layer target.
 *
 * @param {'outdoor'|'indoor'|'neutral'} baseState
 * @param {import('./context-dimensions.js').ContextDimensionSnapshot} dims
 * @param {Record<string, *>} params
 * @returns {import('./context-grade-spec.js').ContextGradeOverlay}
 */
export function resolveTokenModifierOverlay(baseState, dims, params) {
  return addContextGradeOverlays(
    resolveTokenAmbientModifierOverlay(baseState, dims, params),
    resolveTokenCoverShadowOverlay(baseState, dims, params),
  );
}

/**
 * Ambient token modifiers blended by outdoor weight (cloud, canopy, overcast).
 *
 * @param {number} outdoorWeight 0..1
 * @param {import('./context-dimensions.js').ContextDimensionSnapshot} dims
 * @param {Record<string, *>} params
 * @returns {import('./context-grade-spec.js').ContextGradeOverlay}
 */
export function resolveTokenAmbientModifierOverlaySoft(outdoorWeight, dims, params) {
  const w = Math.max(0, Math.min(1, finiteOr(outdoorWeight, 0)));
  const indoor = resolveTokenAmbientModifierOverlay('indoor', dims, params);
  const outdoor = resolveTokenAmbientModifierOverlay('outdoor', dims, params);
  return lerpContextGrade(indoor, outdoor, w);
}

/**
 * Cover shadow modifier blended by outdoor weight (building / painted / tree dapple).
 *
 * @param {number} outdoorWeight 0..1
 * @param {import('./context-dimensions.js').ContextDimensionSnapshot} dims
 * @param {Record<string, *>} params
 * @returns {import('./context-grade-spec.js').ContextGradeOverlay}
 */
export function resolveTokenCoverShadowOverlaySoft(outdoorWeight, dims, params) {
  const w = Math.max(0, Math.min(1, finiteOr(outdoorWeight, 0)));
  const coverOutdoor = resolveTokenCoverShadowOverlay('outdoor', dims, params);
  return lerpContextGrade(createNeutralContextGrade(), coverOutdoor, w);
}

/**
 * Modifier stack blended by outdoor weight so doorway steps morph rather than retrigger.
 *
 * @param {number} outdoorWeight 0..1
 * @param {import('./context-dimensions.js').ContextDimensionSnapshot} dims
 * @param {Record<string, *>} params
 * @returns {import('./context-grade-spec.js').ContextGradeOverlay}
 */
export function resolveTokenModifierOverlaySoft(outdoorWeight, dims, params) {
  return addContextGradeOverlays(
    resolveTokenAmbientModifierOverlaySoft(outdoorWeight, dims, params),
    resolveTokenCoverShadowOverlaySoft(outdoorWeight, dims, params),
  );
}

/**
 * @param {'outdoor'|'indoor'|'neutral'} baseState
 * @param {import('./context-dimensions.js').ContextDimensionSnapshot} dims
 * @param {Record<string, *>} params
 * @returns {import('./context-grade-spec.js').ContextGradeOverlay}
 */
export function resolveTokenContextOverlay(baseState, dims, params) {
  if (baseState === 'neutral') return createNeutralContextGrade();

  return addContextGradeOverlays(
    resolveTokenBaseOverlay(baseState, dims, params),
    resolveTokenModifierOverlay(baseState, dims, params),
  );
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
  const s = Number(outdoorsSample);
  if (Number.isFinite(s)) {
    return computeOutdoorBlendWeight(s, params);
  }
  if (dims.indoorOutdoor === 'outdoor') return 1;
  if (dims.indoorOutdoor === 'indoor') return 0;
  return 0.5;
}
