/**
 * @fileoverview Bridge Map Shine Control manual fog ↔ AtmosphericFogEffectV2.
 * @module ui/atmospheric-fog-bridge
 */

const clamp01 = (v, fb = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fb;
};

/**
 * @returns {import('../compositor-v2/effects/AtmosphericFogEffectV2.js').AtmosphericFogEffectV2|null}
 */
export function resolveAtmosphericFogEffect() {
  try {
    return window.MapShine?.effectComposer?._floorCompositorV2?._atmosphericFogEffect ?? null;
  } catch (_) {
    return null;
  }
}

/**
 * @param {object} controlState
 * @returns {number}
 */
export function readManualFogDensityFromControlState(controlState) {
  return clamp01(controlState?.manualFogDensity, 0);
}

/**
 * @param {object} controlState
 * @param {number} value
 */
export function writeManualFogDensityToControlState(controlState, value) {
  if (!controlState || typeof controlState !== 'object') return;
  controlState.manualFogDensity = clamp01(value, 0);
}

/**
 * @param {number} value
 */
export function applyManualFogDensityToEffect(value) {
  const effect = resolveAtmosphericFogEffect();
  if (!effect?.params) return;
  effect.params.manualFogDensity = clamp01(value, effect.params.manualFogDensity ?? 0);
}

/**
 * Mirror runtime effect manual fog into control panel state (e.g. legacy scene flags).
 * @param {object} controlState
 */
export function syncControlStateFromAtmosphericFogEffect(controlState) {
  const effect = resolveAtmosphericFogEffect();
  if (!effect?.params) return;
  if (!Number.isFinite(Number(controlState?.manualFogDensity))) {
    writeManualFogDensityToControlState(controlState, effect.params.manualFogDensity ?? 0);
  }
}

/**
 * Push control panel manual fog into the compositor effect.
 * @param {object} controlState
 */
export function syncAtmosphericFogEffectFromControlState(controlState) {
  applyManualFogDensityToEffect(readManualFogDensityFromControlState(controlState));
}
