/**

 * @fileoverview Shared wind tuning param IDs + uniform sync for Tree/Bush effects.

 * @module compositor-v2/effects/vegetation-wind-params

 */



import { bindVegetationSceneWindUniforms } from './vegetation-scene-wind.js';



/** Default bulk sway params for trees. */

export const TREE_WIND_LAYER_DEFAULTS = Object.freeze({

  bulkSway: 0.029,

  bulkSwayScale: 0.68,

  bulkSwaySpeed: 2.36,

  bulkSwaySpread: 0.48,

  // Legacy keys — kept for preset import; mapped into bulk on sync.

  canopySway: 0.085,

  canopySwayScale: 1.0,

  canopySwaySpeed: 1.0,

  branchBend: 0.082,

  branchBendScale: 1.0,

});



/** Default bulk sway params for bushes. */

export const BUSH_WIND_LAYER_DEFAULTS = Object.freeze({

  bulkSway: 0.013,

  bulkSwayScale: 1.31,

  bulkSwaySpeed: 1.69,

  bulkSwaySpread: 0.32,

  canopySway: 0.055,

  canopySwayScale: 1.0,

  canopySwaySpeed: 0.85,

  branchBend: 0.055,

  branchBendScale: 1.0,

});



/** Shared uniform keys for vertex bulk sway (may be missing on older overlay materials). */

export const VEGETATION_WIND_LAYER_UNIFORM_KEYS = Object.freeze([

  'uBulkSway',

  'uBulkSwayScale',

  'uBulkSwaySpeed',

  'uBulkSwaySpread',

]);



/**

 * Derive bulk sway amplitude from legacy canopy + branch params when bulkSway is unset.

 * @param {object|null|undefined} params

 * @returns {number}

 */

export function deriveBulkSwayFromLegacyParams(params) {

  if (!params) return TREE_WIND_LAYER_DEFAULTS.bulkSway;

  if (params.bulkSway != null) return Number(params.bulkSway) || 0;

  const canopy = (Number(params.canopySway) || 0) * (Number(params.canopySwayScale) || 1);

  const branch = (Number(params.branchBend) || 0) * (Number(params.branchBendScale) || 1);

  return Math.min((canopy + branch) * 0.52, 0.14);

}



/**

 * Ensure live overlay materials reference shared wind-layer uniforms.

 * @param {Record<string, { value: unknown }>|null|undefined} materialUniforms

 * @param {Record<string, { value: unknown }>|null|undefined} sharedUniforms

 */

export function linkVegetationWindLayerUniforms(materialUniforms, sharedUniforms) {

  if (!materialUniforms || !sharedUniforms) return;

  for (const key of VEGETATION_WIND_LAYER_UNIFORM_KEYS) {

    if (sharedUniforms[key]) materialUniforms[key] = sharedUniforms[key];

  }

}



/**

 * Backfill wind-layer params missing from older presets/scenes.

 * @param {object|null|undefined} params

 * @param {typeof TREE_WIND_LAYER_DEFAULTS} [defaults]

 */

export function ensureVegetationWindLayerParams(params, defaults = TREE_WIND_LAYER_DEFAULTS) {

  if (!params || !defaults) return;

  for (const [key, value] of Object.entries(defaults)) {

    if (params[key] == null) params[key] = value;

  }

  if (params.bulkSway == null) {

    params.bulkSway = deriveBulkSwayFromLegacyParams(params);

  }

  if (params.bulkSwaySpeed == null && params.canopySwaySpeed != null) {

    params.bulkSwaySpeed = params.canopySwaySpeed;

  }

}



/** Params that should push straight to vegetation wind uniforms when tweaked in Tweakpane. */

export const VEGETATION_WIND_TUNING_PARAM_IDS = new Set([

  'windSpeedGlobal',

  'windRampSpeed',

  'windAttackRamp',

  'windDecayRamp',

  'gustFrequency',

  'gustSpeed',

  'waveSpatialFrequency',

  'waveTravelSpeed',

  'waveSharpness',

  'waveInfluence',

  'ambientMotion',

  'rustleFloorScale',

  'flutterBaseDrive',

  'flutterWindStart',

  'flutterWindFull',

  'flutterLowWindBoost',

  'flutterLowWindFadeEnd',

  'flutterGustFloor',

  'bendMinStrength',

  'bendWindStart',

  'bendWindFull',

  'turbulence',

  'turbulenceScale',

  'minRustleSpeed',

  'edgeFadeStart',

  'edgeFadeEnd',

  'bulkSway',

  'bulkSwayScale',

  'bulkSwaySpeed',

  'bulkSwaySpread',

  'canopySway',

  'canopySwayScale',

  'canopySwaySpeed',

  'branchBend',

  'branchBendScale',

  'elasticity',

  'flutterIntensity',

  'flutterSpeed',

  'flutterScale',

  'clumpWaveEnabled',

  'clumpWaveMix',

  'clumpIdDebug',

]);



/**

 * @param {string} paramId

 * @returns {boolean}

 */

export function isVegetationWindTuningParam(paramId) {

  return VEGETATION_WIND_TUNING_PARAM_IDS.has(paramId);

}



/**

 * Push Tree/Bush wind tuning params into shared shader uniforms.

 * @param {Record<string, { value: unknown }>|null|undefined} uniforms

 * @param {object|null|undefined} params

 * @param {{

 *   sceneWindField?: import('../../core/SceneWindField.js').SceneWindField|null,

 *   windLayerDefaults?: typeof TREE_WIND_LAYER_DEFAULTS,

 * }} [opts]

 */

export function syncVegetationWindParamsToUniforms(uniforms, params, opts = {}) {

  if (!uniforms || !params) return;



  ensureVegetationWindLayerParams(params, opts.windLayerDefaults ?? TREE_WIND_LAYER_DEFAULTS);



  const p = params;

  const set = (key, value) => {

    if (uniforms[key]) uniforms[key].value = value;

  };



  set('uWindSpeedGlobal', p.windSpeedGlobal);

  set('uGustFrequency', p.gustFrequency);

  set('uGustSpeed', p.gustSpeed);

  set('uWaveSpatialFrequency', p.waveSpatialFrequency);

  set('uWaveTravelSpeed', p.waveTravelSpeed);

  set('uWaveSharpness', p.waveSharpness);

  set('uWaveInfluence', p.waveInfluence);

  set('uAmbientMotion', p.ambientMotion);

  set('uRustleFloorScale', p.rustleFloorScale);

  set('uFlutterBaseDrive', p.flutterBaseDrive);

  set('uFlutterWindStart', p.flutterWindStart);

  set('uFlutterWindFull', p.flutterWindFull);

  set('uFlutterLowWindBoost', p.flutterLowWindBoost);

  set('uFlutterLowWindFadeEnd', p.flutterLowWindFadeEnd);

  set('uFlutterGustFloor', p.flutterGustFloor);

  set('uBendMinStrength', p.bendMinStrength);

  set('uBendWindStart', p.bendWindStart);

  set('uBendWindFull', p.bendWindFull);

  set('uTurbulence', p.turbulence);

  set('uTurbulenceScale', p.turbulenceScale);

  set('uMinRustleSpeed', p.minRustleSpeed);

  set('uEdgeFadeStart', p.edgeFadeStart);

  set('uEdgeFadeEnd', p.edgeFadeEnd);

  set('uBulkSway', Math.min(Math.max(0, deriveBulkSwayFromLegacyParams(p)), 0.14));

  set('uBulkSwayScale', Math.min(Math.max(0, Number(p.bulkSwayScale ?? p.canopySwayScale) || 1), 2.5));

  set('uBulkSwaySpeed', Number(p.bulkSwaySpeed ?? p.canopySwaySpeed) || 1);

  set('uBulkSwaySpread', Math.min(Math.max(0.08, Number(p.bulkSwaySpread) || 0.35), 0.75));

  set('uElasticity', p.elasticity);

  set('uFlutterIntensity', p.flutterIntensity);

  set('uFlutterSpeed', p.flutterSpeed);

  set('uFlutterScale', p.flutterScale);



  bindVegetationSceneWindUniforms(uniforms, opts.sceneWindField ?? null);

}


