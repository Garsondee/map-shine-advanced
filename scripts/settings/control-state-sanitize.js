/**
 * @fileoverview Sanitize Map Shine `controlState` scene flag for Tweakpane safety and clipboard transfer.
 * Tweakpane option bindings throw when values are outside their option maps — invalid flags brick the GM panel.
 *
 * @module settings/control-state-sanitize
 */

import { canPersistSceneDocument } from '../core/gm-parity.js';
import { createLogger } from '../core/log.js';
import { normalizePlayerLightOverride } from '../core/player-light-allowance.js';

const log = createLogger('ControlStateSanitize');

export const CP_VALID_DYNAMIC_PRESET = new Set([
  'Temperate Plains',
  'Desert',
  'Tropical Jungle',
  'Tundra',
  'Arctic Blizzard'
]);

export const CP_VALID_DIRECTED_PRESET = new Set([
  'Custom',
  'Clear (Dry)',
  'Clear (Breezy)',
  'Partly Cloudy',
  'Overcast (Light)',
  'Overcast (Heavy)',
  'Mist',
  'Fog (Dense)',
  'Drizzle',
  'Light Rain',
  'Rain',
  'Heavy Rain',
  'Thunderstorm',
  'Snow Flurries',
  'Snow',
  'Blizzard'
]);

export const CP_VALID_GUSTINESS = new Set(['calm', 'light', 'moderate', 'strong', 'extreme']);

/**
 * Default GM control panel state (matches ControlPanelManager constructor).
 * @returns {object}
 */
export function createDefaultControlState() {
  return {
    timeOfDay: 12.0,
    timeTransitionMinutes: 0.0,
    linkTimeToFoundry: false,
    weatherMode: 'dynamic',
    dynamicEnabled: false,
    dynamicPresetId: 'Temperate Plains',
    dynamicEvolutionSpeed: 60.0,
    dynamicPaused: false,
    directedPresetId: 'Clear (Dry)',
    directedTransitionMinutes: 5.0,
    directedCustomPreset: {
      precipitation: 0.0,
      cloudCover: 0.15,
      windSpeed: 39.0 / 78.0,
      windDirection: 180.0,
      fogDensity: 0.0,
      freezeLevel: 0.0
    },
    windSpeedMS: 39.0,
    windDirection: 180.0,
    gustiness: 'moderate',
    tileMotionSpeedPercent: 100,
    tileMotionAutoPlayEnabled: true,
    tileMotionTimeFactorPercent: 100,
    tileMotionPaused: false,
    playerLightAllowance: {
      torch: 'global',
      flashlight: 'global',
      nightVision: 'global'
    }
  };
}

/**
 * Clamp directed custom preset scalars (same semantics as ControlPanelManager).
 * @param {object} preset
 * @private
 */
function _sanitizeDirectedCustomPresetNumbers(preset) {
  if (!preset || typeof preset !== 'object') return;
  const finite01 = (v, fb) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fb;
    return Math.max(0.0, Math.min(1.0, n));
  };
  const finiteDeg = (v, fb) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fb;
    const out = ((n % 360) + 360) % 360;
    return Number.isFinite(out) ? out : fb;
  };
  const d = createDefaultControlState().directedCustomPreset;
  preset.precipitation = finite01(preset.precipitation, d.precipitation);
  preset.cloudCover = finite01(preset.cloudCover, d.cloudCover);
  preset.windSpeed = finite01(preset.windSpeed, d.windSpeed);
  preset.fogDensity = finite01(preset.fogDensity, d.fogDensity);
  preset.freezeLevel = finite01(preset.freezeLevel, d.freezeLevel);
  preset.windDirection = finiteDeg(preset.windDirection, d.windDirection);
}

/**
 * Coerce controlState fields in place so Tweakpane bindings do not throw.
 * @param {object} cs
 * @param {{ silent?: boolean }} [options] - if silent, no warn logs (e.g. clipboard export)
 */
export function sanitizeControlStateInPlace(cs, options = {}) {
  const silent = options.silent === true;
  const warn = (msg, detail) => {
    if (!silent) log.warn(msg, detail);
  };

  if (!cs || typeof cs !== 'object') return;

  if (cs.weatherMode !== 'dynamic' && cs.weatherMode !== 'directed') {
    if (cs.weatherMode != null) warn('Invalid weatherMode; resetting to directed', cs.weatherMode);
    cs.weatherMode = 'directed';
  }

  if (typeof cs.dynamicPresetId !== 'string' || !CP_VALID_DYNAMIC_PRESET.has(cs.dynamicPresetId)) {
    if (cs.dynamicPresetId != null) warn('Invalid dynamicPresetId; resetting', cs.dynamicPresetId);
    cs.dynamicPresetId = 'Temperate Plains';
  }

  if (typeof cs.directedPresetId !== 'string' || !CP_VALID_DIRECTED_PRESET.has(cs.directedPresetId)) {
    if (cs.directedPresetId != null) warn('Invalid directedPresetId; resetting', cs.directedPresetId);
    cs.directedPresetId = 'Clear (Dry)';
  }

  if (typeof cs.gustiness !== 'string' || !CP_VALID_GUSTINESS.has(cs.gustiness)) {
    if (cs.gustiness != null) warn('Invalid gustiness; resetting to moderate', cs.gustiness);
    cs.gustiness = 'moderate';
  }

  const t = Number(cs.timeOfDay);
  cs.timeOfDay = Number.isFinite(t) ? (((t % 24) + 24) % 24) : 12;

  const tm = Number(cs.timeTransitionMinutes);
  cs.timeTransitionMinutes = Number.isFinite(tm) ? Math.max(0, Math.min(60, tm)) : 0;

  const des = Number(cs.dynamicEvolutionSpeed);
  cs.dynamicEvolutionSpeed = Number.isFinite(des) ? Math.max(0, Math.min(600, des)) : 60;

  const dtm = Number(cs.directedTransitionMinutes);
  cs.directedTransitionMinutes = Number.isFinite(dtm) ? Math.max(0.1, Math.min(60, dtm)) : 5;

  const wms = Number(cs.windSpeedMS);
  cs.windSpeedMS = Number.isFinite(wms) ? Math.max(0, Math.min(78, wms)) : 39;

  const wdir = Number(cs.windDirection);
  cs.windDirection = Number.isFinite(wdir) ? ((wdir % 360) + 360) % 360 : 180;

  const tmsp = Number(cs.tileMotionSpeedPercent);
  cs.tileMotionSpeedPercent = Number.isFinite(tmsp) ? Math.max(0, Math.min(400, tmsp)) : 100;

  const tmtf = Number(cs.tileMotionTimeFactorPercent);
  cs.tileMotionTimeFactorPercent = Number.isFinite(tmtf) ? Math.max(0, Math.min(200, tmtf)) : 100;

  if (typeof cs.tileMotionAutoPlayEnabled !== 'boolean') cs.tileMotionAutoPlayEnabled = true;
  if (typeof cs.tileMotionPaused !== 'boolean') cs.tileMotionPaused = false;
  if (typeof cs.dynamicEnabled !== 'boolean') cs.dynamicEnabled = false;
  if (typeof cs.dynamicPaused !== 'boolean') cs.dynamicPaused = false;
  if (typeof cs.linkTimeToFoundry !== 'boolean') cs.linkTimeToFoundry = false;

  if (!cs.directedCustomPreset || typeof cs.directedCustomPreset !== 'object') {
    cs.directedCustomPreset = { ...createDefaultControlState().directedCustomPreset };
  } else {
    _sanitizeDirectedCustomPresetNumbers(cs.directedCustomPreset);
  }

  const defPL = createDefaultControlState().playerLightAllowance;
  if (!cs.playerLightAllowance || typeof cs.playerLightAllowance !== 'object') {
    cs.playerLightAllowance = { ...defPL };
  } else {
    cs.playerLightAllowance.torch = normalizePlayerLightOverride(cs.playerLightAllowance.torch);
    cs.playerLightAllowance.flashlight = normalizePlayerLightOverride(cs.playerLightAllowance.flashlight);
    cs.playerLightAllowance.nightVision = normalizePlayerLightOverride(cs.playerLightAllowance.nightVision);
  }
}

/**
 * Deep-merge defaults + raw flag payload, apply legacy windSpeed, sanitize. Returns a new object.
 * @param {*} raw
 * @param {{ silent?: boolean }} [options]
 * @returns {object}
 */
export function cloneAndSanitizeControlState(raw, options = {}) {
  const next = createDefaultControlState();
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    Object.assign(next, raw);
    if (raw.directedCustomPreset && typeof raw.directedCustomPreset === 'object') {
      Object.assign(next.directedCustomPreset, raw.directedCustomPreset);
    }
    if (raw.playerLightAllowance && typeof raw.playerLightAllowance === 'object') {
      Object.assign(next.playerLightAllowance, raw.playerLightAllowance);
    }
    if (!Number.isFinite(next.windSpeedMS)) {
      const legacy01 = Number(raw.windSpeed);
      if (Number.isFinite(legacy01)) {
        next.windSpeedMS = Math.max(0.0, Math.min(78.0, legacy01 * 78.0));
      }
    }
  }
  sanitizeControlStateInPlace(next, options);
  return next;
}

/**
 * Read `controlState` from scene flags and return a sanitized plain object for export (clipboard).
 * @param {object|null} scene
 * @returns {object|undefined}
 */
export function getSanitizedControlStateForExport(scene) {
  try {
    const raw = scene?.getFlag?.('map-shine-advanced', 'controlState');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    return cloneAndSanitizeControlState(raw, { silent: true });
  } catch (_) {
    return undefined;
  }
}

/**
 * If the scene has a `controlState` flag, replace it with a sanitized copy when anything was invalid.
 * @param {object|null} scene
 * @returns {Promise<boolean>} true when a write was attempted
 */
export async function repairSceneControlStateFlag(scene) {
  if (!canPersistSceneDocument()) return false;
  if (!scene || typeof scene.setFlag !== 'function') return false;
  try {
    const raw = scene.getFlag('map-shine-advanced', 'controlState');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const next = cloneAndSanitizeControlState(raw, { silent: false });
    await scene.setFlag('map-shine-advanced', 'controlState', next);
    return true;
  } catch (e) {
    log.warn('repairSceneControlStateFlag failed', e);
    return false;
  }
}
