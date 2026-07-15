/**
 * @fileoverview Bridge Map Shine Control landscape lightning ↔ WeatherLightningEffectV2.
 *
 * WeatherLightningEffectV2 publishes `landscapeLightningFlash01` (and related keys) on
 * `MapShine.environment` each frame. Window, bush, tree, cloud, and bloom effects read
 * that signal (via {@link ../compositor-v2/lightning/resolve-compositor-lightning-flash.js})
 * — this bridge only drives storm intensity and manual strike triggers on the effect.
 *
 * @module ui/landscape-lightning-bridge
 */

/** @type {ReadonlyArray<string>} */
export const LANDSCAPE_LIGHTNING_PARAM_IDS = Object.freeze(['lightning']);

/** FloorCompositor property — matches `_makeV2Callback` in canvas-replacement.js */
const WEATHER_LIGHTNING_FC_KEY = '_weatherLightningEffect';

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
      ?? ms?.floorCompositorV2
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
    controlState.landscapeLightning = { lightning: 0.0 };
  }
  if (!Number.isFinite(Number(controlState.landscapeLightning.lightning))) {
    const legacy = Number(controlState.landscapeLightning.stormIntensity);
    controlState.landscapeLightning.lightning = Number.isFinite(legacy)
      ? clampScalar01(legacy, 0.0)
      : 0.0;
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
 * Queue storm intensity until FloorCompositorV2 exists (same pattern as `_propagateToV2`).
 * @param {number} value 0..1
 */
function queuePendingStormIntensity(value) {
  const v = clampScalar01(value, 0);
  try {
    const ms = window.MapShine;
    if (!ms) return;
    if (!ms.__pendingV2EffectParams) ms.__pendingV2EffectParams = {};
    if (!ms.__pendingV2EffectParams[WEATHER_LIGHTNING_FC_KEY]) {
      ms.__pendingV2EffectParams[WEATHER_LIGHTNING_FC_KEY] = {};
    }
    ms.__pendingV2EffectParams[WEATHER_LIGHTNING_FC_KEY].stormIntensity = v;
  } catch (_) {}
}

function clearPendingStormIntensity() {
  try {
    const pend = window.MapShine?.__pendingV2EffectParams?.[WEATHER_LIGHTNING_FC_KEY];
    if (pend && typeof pend === 'object') delete pend.stormIntensity;
  } catch (_) {}
}

/**
 * Push live lightning intensity into the compositor (maps to effect stormIntensity).
 * @param {number} value 0..1
 */
export function applyLightningIntensityToEffect(value) {
  const v = clampScalar01(value, 0);
  queuePendingStormIntensity(v);
  const effect = resolveWeatherLightningEffect();
  if (!effect?.applyParamChange) return;
  effect.applyParamChange('stormIntensity', v);
  clearPendingStormIntensity();
}

/**
 * Apply saved control-panel lightning after FloorCompositorV2 is created.
 */
export function flushLandscapeLightningWhenCompositorReady() {
  const effect = resolveWeatherLightningEffect();
  if (!effect?.applyParamChange) return;

  // Map Shine Control is authoritative for live storm intensity.
  const cp = window.MapShine?.controlPanel?.controlState;
  if (cp) {
    syncWeatherLightningEffectFromControlState(cp);
    return;
  }

  const pend = window.MapShine?.__pendingV2EffectParams?.[WEATHER_LIGHTNING_FC_KEY];
  const pending = Number(pend?.stormIntensity);
  if (Number.isFinite(pending)) {
    applyLightningIntensityToEffect(pending);
  }
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
