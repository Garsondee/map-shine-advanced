/**

 * @fileoverview Ash master intensity — shared between Manual Weather panel and ash effect UIs.

 *

 * The Manual Weather Ash slider drives `WeatherController.ashIntensity` only.

 * It does not toggle scene effect `enabled` flags; at zero, runtime systems idle via intensity.

 *

 * @module ui/ash-weather-bridge

 */



import * as sceneSettings from '../settings/scene-settings.js';

import { applyWeatherManualParam, resolveWeatherController } from './weather-param-bridge.js';



/** @type {ReadonlyArray<string>} */

export const ASH_EFFECT_IDS = Object.freeze(['ash-weather', 'ash-clouds', 'ash-disturbance']);



/** @type {Readonly<Record<string, string>>} */

const ASH_FC_KEYS = Object.freeze({

  'ash-disturbance': '_ashDisturbanceEffect',

  'ash-clouds': '_ashCloudEffect',

});



/**

 * @param {string} effectId

 * @returns {object|null}

 */

function readSceneAshEffectBlob(effectId) {

  try {

    const scene = canvas?.scene;

    if (!scene) return null;

    const all = sceneSettings.getSceneSettings(scene);

    for (const tier of [all?.mapMaker, all?.gm]) {

      const blob = tier?.effects?.[effectId];

      if (blob && typeof blob === 'object') return blob;

    }

  } catch (_) {}

  return null;

}



/**

 * @param {string} effectId

 * @returns {boolean|null} true/false when known, null when no compositor instance

 */

function isCompositorAshEffectEnabled(effectId) {

  const fcKey = ASH_FC_KEYS[effectId];

  if (!fcKey) return null;

  try {

    const fc = window.MapShine?.effectComposer?._floorCompositorV2;

    const inst = fc?.[fcKey];

    if (!inst) return null;

    if (inst.enabled === true || inst.params?.enabled === true) return true;

    if (inst.enabled === false || inst.params?.enabled === false) return false;

    return null;

  } catch (_) {}

  return null;

}



/**

 * @param {string} effectId

 * @returns {boolean|null}

 */

function isUiAshEffectEnabled(effectId) {

  try {

    const data = window.MapShine?.uiManager?.effectFolders?.[effectId];

    if (!data?.params) return null;

    if (data.params.enabled === true) return true;

    if (data.params.enabled === false) return false;

    const def = data.schema?.parameters?.enabled?.default ?? data.schema?.enabled;

    if (def === true) return true;

    if (def === false) return false;

    return null;

  } catch (_) {}

  return null;

}



/**

 * True when a single ash-related effect is enabled for this scene.

 * Checks compositor runtime, scene flags, then UI folders (in that order).

 * @param {string} effectId

 * @returns {boolean}

 */

export function isAshEffectEnabledInScene(effectId) {
  const ui = isUiAshEffectEnabled(effectId);
  if (ui === false) return false;

  const compositor = isCompositorAshEffectEnabled(effectId);
  if (compositor === true) return true;

  const blob = readSceneAshEffectBlob(effectId);
  if (blob?.enabled === true) return true;

  if (ui === true) return true;

  return false;
}

/**
 * True when the Ash (Weather) particle effect is enabled in the Tweakpane UI.
 * Used to gate fall/ember emission without blocking other ash channels (clouds, manual weather).
 * @returns {boolean}
 */
export function isAshWeatherParticleEffectEnabled() {
  const intensity = readAshIntensityFromController();
  if (intensity <= 0.001) return false;

  try {
    const data = window.MapShine?.uiManager?.effectFolders?.['ash-weather'];
    if (data?.params && typeof data.params.enabled === 'boolean') {
      return data.params.enabled === true;
    }
  } catch (_) {}
  return isAshEffectEnabledInScene('ash-weather');
}



/**

 * True when at least one ash-related effect is enabled in the scene effect stack.

 * @returns {boolean}

 */

export function isAnyAshSystemEnabledInScene() {

  try {

    return ASH_EFFECT_IDS.some((id) => isAshEffectEnabledInScene(id));

  } catch (_) {

    return false;

  }

}



/**

 * @param {number} value

 * @returns {number}

 */

export function clampAshIntensity(value) {

  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  return Math.max(0, Math.min(1, n));

}



/**

 * Remember last non-zero intensity for restore when sliding back up from zero.

 * @param {number} value

 */

export function rememberAshIntensityIfNonZero(value) {

  const v = clampAshIntensity(value);

  if (v <= 0) return;

  try {

    const ms = window.MapShine;

    if (!ms) return;

    if (!ms.__v2AshWeatherState) ms.__v2AshWeatherState = {};

    ms.__v2AshWeatherState.lastIntensity = v;

  } catch (_) {}

}



/**

 * Apply ash master intensity to WeatherController (no effect enabled toggles).

 * @param {number} value

 * @param {{ syncMainTweakpane?: boolean }} [options]

 * @returns {number} clamped value applied

 */

export function applyAshMasterIntensity(value, options = {}) {

  const v = clampAshIntensity(value);

  if (v > 0) rememberAshIntensityIfNonZero(v);



  const wc = resolveWeatherController();

  applyWeatherManualParam(wc, 'ashIntensity', v, {

    syncMainTweakpane: options.syncMainTweakpane !== false,

  });



  try {

    if (window.MapShine) window.MapShine.__v2AshIntensity = v;

  } catch (_) {}



  syncAshWeatherEffectFolderIntensity(v);

  return v;

}



/**

 * Mirror ash intensity into the ash-weather Tweakpane folder (display only).

 * @param {number} value

 */

export function syncAshWeatherEffectFolderIntensity(value) {

  try {

    const data = window.MapShine?.uiManager?.effectFolders?.['ash-weather'];

    if (!data?.params) return;

    const v = isAshWeatherParticleEffectEnabled()
      ? clampAshIntensity(value)
      : 0;

    data.params.ashIntensity = v;

    data.bindings?.ashIntensity?.refresh?.();

  } catch (_) {}

}



/**

 * Read current ash intensity from WeatherController.

 * @returns {number}

 */

export function readAshIntensityFromController() {

  const wc = resolveWeatherController();

  const st = wc?.targetState ?? wc?.currentState ?? null;

  const raw = st?.ashIntensity ?? window.MapShine?.__v2AshIntensity ?? 0;

  return clampAshIntensity(raw);

}


