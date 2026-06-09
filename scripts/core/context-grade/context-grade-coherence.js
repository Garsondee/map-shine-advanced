/**
 * @fileoverview Coordinates context grade with atmosphere, spatial CC, and Dynamic Exposure.
 * @module core/context-grade/context-grade-coherence
 */

import { addContextGradeOverlays, cloneContextGrade, computeDramaPulse, finiteOr } from './context-grade-spec.js';

/**
 * @param {import('./context-grade-spec.js').ContextGradeOverlay} overlay
 * @param {Record<string, *>} params
 * @param {{ transitionProgress?: number, targetState?: string, dramaActive?: boolean }} runtime
 * @returns {import('./context-grade-spec.js').ContextGradeOverlay}
 */
export function applyCoherenceClamp(overlay, params, runtime = {}) {
  const out = cloneContextGrade(overlay);
  const maxExp = finiteOr(params?.coherenceMaxExposure, 1.35);
  const maxVig = finiteOr(params?.coherenceMaxVignette, 0.55);
  out.exposure = Math.max(-1.5, Math.min(maxExp, out.exposure));
  out.vignetteStrength = Math.max(-0.25, Math.min(maxVig, out.vignetteStrength));
  return out;
}

/**
 * @param {Record<string, *>} params
 * @param {import('./context-env-resolver.js').ContextEnvResolver} envState
 * @param {import('./context-dimensions.js').ContextDimensionSnapshot} dims
 * @returns {{ atmosphereScale: number, dazzleGate: number }}
 */
export function computeCoherenceScalars(params, envState, dims) {
  let atmosphereScale = 1;

  if (params?.coherenceEnabled !== false) {
    const base = finiteOr(params?.coherenceAtmosphereScale, 0.6);
    if (envState.skyCondition === 'overcast' || envState.skyCondition === 'storm') {
      atmosphereScale = base;
    }
    if (dims.outdoorSky === 'overcast' || dims.outdoorSky === 'storm') {
      atmosphereScale = Math.min(atmosphereScale, base);
    }
  }

  let dazzleGate = 1;
  if (params?.coherenceEnabled !== false) {
    dazzleGate = finiteOr(params?.dazzleContextGradeGate, 0.45);
  }

  return { atmosphereScale, dazzleGate };
}

/**
 * Drama peak amount 0..1 for dazzle gating.
 *
 * @param {number} rawT
 * @param {Record<string, *>} params
 * @param {'outdoor'|'indoor'|'neutral'} targetState
 */
export function estimateDramaPeak(rawT, params, targetState) {
  if (params?.dramaEnabled === false) return 0;
  const pulse = computeDramaPulse(rawT, params, targetState);
  return Math.max(0, Math.min(1, Math.abs(pulse.exposure) / Math.max(0.01, finiteOr(params?.dramaPeakExposure, 0.75))));
}

/**
 * @param {import('./context-grade-spec.js').ContextGradeOverlay} baseOverlay
 * @param {import('./context-grade-spec.js').ContextGradeOverlay} envOverlay
 * @returns {import('./context-grade-spec.js').ContextGradeOverlay}
 */
export function combineOverlaysWithEnv(baseOverlay, envOverlay) {
  return addContextGradeOverlays(baseOverlay, envOverlay);
}
