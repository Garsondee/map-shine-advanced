/**
 * @fileoverview Bridge Map Shine Control landscape lightning ↔ WeatherLightningEffectV2.
 * @module ui/landscape-lightning-bridge
 */

/** @type {ReadonlyArray<string>} */
export const LANDSCAPE_LIGHTNING_PARAM_IDS = Object.freeze(['lightning']);

/**
 * @param {*} v
 * @param {number} [fb]
 * @returns {number}
 */
export function clampScalar01(v, fb = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fb;
}

/**
 * @returns {import('../compositor-v2/effects/WeatherLightningEffectV2.js').WeatherLightningEffectV2|null}
 */
export function resolveWeatherLightningEffect() {
  try {
    const ms = window.MapShine;
    const fc = ms?.effectComposer?._floorCompositorV2
      ?? ms?.sceneComposer?.effectComposer?._floorCompositorV2
      ?? null;
    return fc?._weatherLightningEffect ?? null;
  } catch (_) {
    return null;
  }
}

/**
 * @param {object} controlState
 * @returns {object}
 */
export function ensureLandscapeLightningState(controlState) {
  if (!controlState.landscapeLightning || typeof controlState.landscapeLightning !== 'object') {
    controlState.landscapeLightning = { lightning: 1.0 };
  }
  if (!Number.isFinite(Number(controlState.landscapeLightning.lightning))) {
    const legacy = Number(controlState.landscapeLightning.stormIntensity);
    controlState.landscapeLightning.lightning = Number.isFinite(legacy)
      ? clampScalar01(legacy, 1.0)
      : 1.0;
  }
  return controlState.landscapeLightning;
}

/**
 * @param {object} controlState
 * @returns {number}
 */
export function readLightningIntensityFromControlState(controlState) {
  return clampScalar01(ensureLandscapeLightningState(controlState).lightning, 0);
}

/**
 * @param {object} controlState
 * @param {*} value
 */
export function writeLightningIntensityToControlState(controlState, value) {
  ensureLandscapeLightningState(controlState).lightning = clampScalar01(value, 0);
}

/**
 * Push live lightning intensity into the compositor (maps to effect stormIntensity).
 * @param {number} value 0..1
 */
export function applyLightningIntensityToEffect(value) {
  const effect = resolveWeatherLightningEffect();
  if (!effect?.applyParamChange) return;
  effect.applyParamChange('stormIntensity', clampScalar01(value, 0));
}

/**
 * @param {string} paramId
 * @param {*} value
 */
export function applyLandscapeLightningParam(paramId, value) {
  if (paramId === 'lightning') {
    applyLightningIntensityToEffect(value);
    return;
  }
  const effect = resolveWeatherLightningEffect();
  if (!effect?.applyParamChange) return;
  effect.applyParamChange(paramId, value);
}

/**
 * Mirror runtime effect storm intensity into control panel state (display only).
 * @param {object} controlState
 */
export function syncControlStateFromWeatherLightningEffect(controlState) {
  const effect = resolveWeatherLightningEffect();
  const bag = ensureLandscapeLightningState(controlState);
  if (!effect?.params) return;
  bag.lightning = clampScalar01(effect.params.stormIntensity, bag.lightning ?? 1.0);
}

/**
 * Push control panel lightning scalar into the compositor effect.
 * @param {object} controlState
 */
export function syncWeatherLightningEffectFromControlState(controlState) {
  applyLightningIntensityToEffect(readLightningIntensityFromControlState(controlState));
}

/**
 * @param {'small'|'big'|'series'} actionId
 */
export function triggerLandscapeLightningAction(actionId) {
  const effect = resolveWeatherLightningEffect();
  if (!effect) return;
  if (actionId === 'small') effect.triggerSmallStrike();
  else if (actionId === 'big') effect.triggerBigStrike();
  else if (actionId === 'series') effect.triggerStrikeSeries(30000);
}
