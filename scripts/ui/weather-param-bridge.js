/**
 * @fileoverview Weather manual scalars — shared between main Tweakpane and the GM control panel.
 *
 * **Authority model (runtime):**
 * - `WeatherController.targetState` is the single source of truth for simulation values.
 * - **Live Weather Overrides** (control panel) apply by writing `targetState` / `currentState`
 *   (`applyDirectedCustomPresetToWeather` / `applyWeatherManualParam`), then mirror into the
 *   main Weather folder for display (`syncWeatherEffectFolderParam`). That is one-way UI→WC→main Tweakpane.
 * - **Main Tweakpane** edits call `applyWeatherManualParam` → WC, then
 *   `syncDirectedCustomPresetFromWeatherController` updates `directedCustomPreset` and
 *   `ControlPanelManager.syncLiveWeatherOverrideDomFromDirectedPreset()` (native range/number UI).
 *
 * On Weather effect registration, `hydrateMainWeatherTweakpaneFromController` runs **before** the initial
 * callback so schema defaults (often 0) do not clobber WC that was already loaded from snapshots.
 *
 * @module ui/weather-param-bridge
 */

import { PrecipitationType, weatherController as coreWeatherController } from '../core/WeatherController.js';
import { refreshMsaSameSceneRedrawPredict } from '../utils/msa-local-flag-guard.js';

/** @type {ReadonlySet<string>} */
export const MANUAL_WEATHER_PARAM_IDS = new Set([
  'precipitation',
  'cloudCover',
  'fogDensity',
  'wetness',
  'freezeLevel',
  'ashIntensity',
  'windSpeed',
  'windDirection'
]);

/** Subset shown as Live Weather Overrides on the compact GM control panel. */
export const LIVE_WEATHER_OVERRIDE_PARAM_IDS = [
  'precipitation',
  'cloudCover',
  'freezeLevel',
  'windSpeed',
  'windDirection'
];

const MAX_WIND_MS = 78.0;

/**
 * Copy runtime weather into main Tweakpane `weather` params and refresh bindings only (no WC callbacks).
 * Call once when the Weather effect is registered, before `registerEffect`'s initial callback runs.
 *
 * @param {import('../core/WeatherController.js').WeatherController|null|undefined} wc
 * @param {*} uiManager - TweakpaneManager instance (`window.MapShine.uiManager`)
 */
export function hydrateMainWeatherTweakpaneFromController(wc, uiManager) {
  if (!wc?.targetState || !uiManager?.effectFolders?.weather?.params) return;
  const eff = uiManager.effectFolders.weather;
  const st = wc.targetState;

  const clamp01 = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  };

  const has = (id) => Object.prototype.hasOwnProperty.call(eff.params, id);
  const refresh = (id) => {
    try {
      eff.bindings[id]?.refresh?.();
    } catch (_) {}
  };

  if (has('dynamicEnabled')) {
    eff.params.dynamicEnabled = wc.dynamicEnabled === true;
    refresh('dynamicEnabled');
  }
  if (has('dynamicPresetId') && typeof wc.dynamicPresetId === 'string' && wc.dynamicPresetId) {
    eff.params.dynamicPresetId = wc.dynamicPresetId;
    refresh('dynamicPresetId');
  }
  if (has('dynamicEvolutionSpeed') && Number.isFinite(Number(wc.dynamicEvolutionSpeed))) {
    eff.params.dynamicEvolutionSpeed = Number(wc.dynamicEvolutionSpeed);
    refresh('dynamicEvolutionSpeed');
  }
  if (has('dynamicPaused')) {
    eff.params.dynamicPaused = wc.dynamicPaused === true;
    refresh('dynamicPaused');
  }
  if (has('variability') && Number.isFinite(Number(wc.variability))) {
    eff.params.variability = Number(wc.variability);
    refresh('variability');
  }
  if (has('simulationSpeed') && Number.isFinite(Number(wc.simulationSpeed))) {
    eff.params.simulationSpeed = Number(wc.simulationSpeed);
    refresh('simulationSpeed');
  }
  if (has('transitionDuration') && Number.isFinite(Number(wc.transitionDuration))) {
    eff.params.transitionDuration = Number(wc.transitionDuration);
    refresh('transitionDuration');
  }
  if (has('dynamicPlanDurationMinutes') && Number.isFinite(Number(wc.dynamicPlanDurationSeconds))) {
    eff.params.dynamicPlanDurationMinutes = Math.max(0.1, Number(wc.dynamicPlanDurationSeconds) / 60.0);
    refresh('dynamicPlanDurationMinutes');
  }

  for (const paramId of MANUAL_WEATHER_PARAM_IDS) {
    if (!has(paramId)) continue;
    let v;
    switch (paramId) {
      case 'precipitation':
        v = clamp01(st.precipitation);
        break;
      case 'cloudCover':
        v = clamp01(st.cloudCover);
        break;
      case 'fogDensity':
        v = clamp01(st.fogDensity);
        break;
      case 'wetness':
        v = clamp01(st.wetness);
        break;
      case 'freezeLevel':
        v = clamp01(st.freezeLevel);
        break;
      case 'ashIntensity':
        v = clamp01(st.ashIntensity);
        break;
      case 'windSpeed': {
        const ws = Number(st.windSpeed);
        v = Number.isFinite(ws) ? clamp01(ws) : clamp01(Number(st.windSpeedMS) / MAX_WIND_MS);
        break;
      }
      case 'windDirection': {
        let deg = 0;
        if (typeof wc._windAngleDegFromDir === 'function') {
          deg = wc._windAngleDegFromDir(st.windDirection);
        } else {
          const x = Number(st.windDirection?.x) || 1;
          const y = Number(st.windDirection?.y) || 0;
          deg = Math.atan2(-y, x) * (180 / Math.PI);
          if (deg < 0) deg += 360;
        }
        if (!Number.isFinite(deg)) deg = 0;
        v = ((deg % 360) + 360) % 360;
        if (!Number.isFinite(v)) v = 0;
        break;
      }
      default:
        continue;
    }
    eff.params[paramId] = v;
    refresh(paramId);
  }

  try {
    uiManager.updateControlStates?.('weather');
  } catch (_) {}
}

/**
 * Refresh compact panel Live Weather Overrides from WeatherController (no WC write).
 * @param {import('../core/WeatherController.js').WeatherController|null|undefined} wc
 */
export function hydrateControlPanelLiveOverridesFromController(wc) {
  const cp = window.MapShine?.controlPanel;
  if (!wc || !cp) return;
  try {
    if (typeof cp._ensureDirectedCustomPreset === 'function') cp._ensureDirectedCustomPreset();
  } catch (_) {}
  syncDirectedCustomPresetFromWeatherController(wc);
}

/**
 * @param {number} precipitation
 * @param {number} freezeLevel
 * @returns {number} PrecipitationType enum value
 */
export function computePrecipType(precipitation, freezeLevel) {
  const p = Number(precipitation);
  const f = Number(freezeLevel);
  if (!Number.isFinite(p) || p < 0.05) return PrecipitationType.NONE;
  if (Number.isFinite(f) && f > 0.55) return PrecipitationType.SNOW;
  return PrecipitationType.RAIN;
}

/**
 * @param {{ precipitation?: number, freezeLevel?: number }} state
 */
function _applyPrecipTypeForState(state) {
  if (!state) return;
  state.precipType = computePrecipType(state.precipitation, state.freezeLevel);
}

/**
 * Apply one manual weather parameter to target + current state (same semantics as main Tweakpane).
 * Updates precipType when precipitation or freezeLevel change; syncs wind MS when windSpeed changes.
 *
 * @param {import('../core/WeatherController.js').WeatherController|null|undefined} wc
 * @param {string} paramId
 * @param {*} value
 * @param {{ syncMainTweakpane?: boolean }} [options]
 * @returns {boolean} True if handled as a manual scalar
 */
export function applyWeatherManualParam(wc, paramId, value, options = {}) {
  if (!wc || typeof paramId !== 'string') return false;
  if (!MANUAL_WEATHER_PARAM_IDS.has(paramId)) return false;

  const st = wc.targetState;
  const cur = wc.currentState;
  if (!st || !cur) return false;

  const syncUi = options.syncMainTweakpane !== false;

  // Same-scene flag persist is debounced; Foundry may redraw before tearDown skip guards refresh.
  refreshMsaSameSceneRedrawPredict();

  const clamp01 = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  };

  try {
    switch (paramId) {
      case 'precipitation': {
        const v = clamp01(value);
        st.precipitation = v;
        cur.precipitation = v;
        _applyPrecipTypeForState(st);
        _applyPrecipTypeForState(cur);
        break;
      }
      case 'cloudCover': {
        const v = clamp01(value);
        st.cloudCover = v;
        cur.cloudCover = v;
        break;
      }
      case 'fogDensity': {
        const v = clamp01(value);
        st.fogDensity = v;
        cur.fogDensity = v;
        break;
      }
      case 'wetness': {
        const v = clamp01(value);
        st.wetness = v;
        cur.wetness = v;
        break;
      }
      case 'freezeLevel': {
        const v = clamp01(value);
        st.freezeLevel = v;
        cur.freezeLevel = v;
        _applyPrecipTypeForState(st);
        _applyPrecipTypeForState(cur);
        break;
      }
      case 'ashIntensity': {
        const v = clamp01(value);
        st.ashIntensity = v;
        cur.ashIntensity = v;
        break;
      }
      case 'windSpeed': {
        const v = clamp01(value);
        st.windSpeed = v;
        cur.windSpeed = v;
        if (typeof wc._syncWindUnits === 'function') {
          wc._syncWindUnits(st);
          wc._syncWindUnits(cur);
        } else {
          const ms = v * MAX_WIND_MS;
          st.windSpeedMS = ms;
          cur.windSpeedMS = ms;
        }
        if (syncUi) syncWeatherEffectFolderParam('windSpeed', v);
        return true;
      }
      case 'windDirection': {
        const raw = Number(value) || 0;
        const deg = ((raw % 360) + 360) % 360;
        const rad = (deg * Math.PI) / 180;
        const x = Math.cos(rad);
        const y = -Math.sin(rad);
        if (st.windDirection?.set) st.windDirection.set(x, y);
        else st.windDirection = { x, y };
        if (cur.windDirection?.set) cur.windDirection.set(x, y);
        else cur.windDirection = { x, y };
        if (typeof st.windDirection?.normalize === 'function') st.windDirection.normalize();
        if (typeof cur.windDirection?.normalize === 'function') cur.windDirection.normalize();
        if (syncUi) {
          syncWeatherEffectFolderParam('windDirection', deg);
          try {
            window.MapShine?.uiManager?.updateControlStates?.('weather');
          } catch (_) {}
        }
        return true;
      }
      default:
        return false;
    }

    if (syncUi) {
      const outVal = paramId === 'precipitation' || paramId === 'cloudCover' || paramId === 'fogDensity'
        || paramId === 'wetness' || paramId === 'freezeLevel' || paramId === 'ashIntensity'
        ? clamp01(value)
        : value;
      syncWeatherEffectFolderParam(paramId, outVal);
    }
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Mirror a value into the main Tweakpane Weather effect so the compact panel and config panel stay aligned.
 *
 * @param {string} paramId
 * @param {*} value
 */
export function syncWeatherEffectFolderParam(paramId, value) {
  try {
    const ui = window.MapShine?.uiManager;
    const eff = ui?.effectFolders?.weather;
    if (!eff?.params || !Object.prototype.hasOwnProperty.call(eff.params, paramId)) return;
    eff.params[paramId] = value;
    eff.bindings?.[paramId]?.refresh?.();
  } catch (_) {}
}

/**
 * Full directed-Custom payload (Live Weather Overrides): applies all scalars + precipType + wind.
 * Call after `directedCustomPreset` object is clamped/normalized.
 *
 * @param {import('../core/WeatherController.js').WeatherController|null|undefined} wc
 * @param {object} custom
 * @param {{ syncMainTweakpane?: boolean }} [options]
 */
export function applyDirectedCustomPresetToWeather(wc, custom, options = {}) {
  if (!wc || !custom || typeof custom !== 'object') return;

  const clamp01 = (v, fallback = 0) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1, n));
  };

  const precipitation = clamp01(custom.precipitation);
  const cloudCover = clamp01(custom.cloudCover);
  const freezeLevel = clamp01(custom.freezeLevel);
  const windSpeed = clamp01(custom.windSpeed);
  const windDirRaw = Number(custom.windDirection);
  const windDir = Number.isFinite(windDirRaw)
    ? ((windDirRaw % 360) + 360) % 360
    : 0;

  const windSpeedMS = windSpeed * MAX_WIND_MS;
  const precipType = computePrecipType(precipitation, freezeLevel);

  const windDirVec = typeof wc._windDirFromAngleDeg === 'function'
    ? wc._windDirFromAngleDeg(windDir)
    : (() => {
        const rad = (windDir * Math.PI) / 180.0;
        return { x: Math.cos(rad), y: -Math.sin(rad) };
      })();

  const applyToState = (state) => {
    if (!state) return;
    state.precipitation = precipitation;
    state.precipType = precipType;
    state.cloudCover = cloudCover;
    state.freezeLevel = freezeLevel;
    state.windSpeedMS = windSpeedMS;
    state.windSpeed = windSpeed;
    const wx = Number(windDirVec?.x);
    const wy = Number(windDirVec?.y);
    if (state.windDirection && typeof state.windDirection.set === 'function') {
      state.windDirection.set(Number.isFinite(wx) ? wx : 1, Number.isFinite(wy) ? wy : 0);
      if (typeof state.windDirection.normalize === 'function') state.windDirection.normalize();
    } else {
      state.windDirection = { x: Number.isFinite(wx) ? wx : 1, y: Number.isFinite(wy) ? wy : 0 };
    }
  };

  applyToState(wc.targetState);
  applyToState(wc.currentState);

  const syncUi = options.syncMainTweakpane !== false;
  if (syncUi) {
    const keys = ['precipitation', 'cloudCover', 'freezeLevel', 'windSpeed', 'windDirection'];
    for (const k of keys) {
      const v = k === 'windDirection' ? windDir : (
        k === 'precipitation' ? precipitation
          : k === 'cloudCover' ? cloudCover
            : k === 'freezeLevel' ? freezeLevel
              : windSpeed
      );
      syncWeatherEffectFolderParam(k, v);
    }
  }
}

/**
 * @returns {import('../core/WeatherController.js').WeatherController|null}
 */
export function resolveWeatherController() {
  return coreWeatherController || window.MapShine?.weatherController || window.weatherController || null;
}

/**
 * Keep Map Shine Control `directedCustomPreset` aligned when the main Tweakpane Weather sliders change.
 * Skips while the control panel is applying rapid overrides (avoids feedback loops).
 *
 * @param {import('../core/WeatherController.js').WeatherController|null|undefined} wc
 */
export function syncDirectedCustomPresetFromWeatherController(wc) {
  try {
    const cp = window.MapShine?.controlPanel;
    if (!wc || !cp?.controlState?.directedCustomPreset || cp._applyingRapidOverrides) return;

    try {
      if (typeof cp._ensureDirectedCustomPreset === 'function') cp._ensureDirectedCustomPreset();
    } catch (_) {}

    const st = wc.targetState;
    if (!st) return;

    const preset = cp.controlState.directedCustomPreset;
    const clamp01 = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return 0;
      return Math.max(0, Math.min(1, n));
    };

    preset.precipitation = clamp01(st.precipitation);
    preset.cloudCover = clamp01(st.cloudCover);
    preset.freezeLevel = clamp01(st.freezeLevel);
    preset.fogDensity = clamp01(st.fogDensity);

    const ws = Number.isFinite(st.windSpeed) ? clamp01(st.windSpeed) : 0;
    preset.windSpeed = ws;

    let deg = 0;
    if (typeof wc._windAngleDegFromDir === 'function') {
      deg = wc._windAngleDegFromDir(st.windDirection);
    } else {
      const x = Number(st.windDirection?.x) || 1;
      const y = Number(st.windDirection?.y) || 0;
      deg = Math.atan2(-y, x) * (180 / Math.PI);
      if (deg < 0) deg += 360;
    }
    if (!Number.isFinite(deg)) deg = 0;
    preset.windDirection = ((deg % 360) + 360) % 360;
    if (!Number.isFinite(preset.windDirection)) preset.windDirection = 0;

    try {
      if (typeof cp._sanitizeDirectedCustomPresetNumbers === 'function') {
        cp._sanitizeDirectedCustomPresetNumbers(preset);
      }
    } catch (_) {}

    // Live overrides use native range/number DOM, not Tweakpane bindings — sync from preset only.
    try {
      if (typeof cp.syncLiveWeatherOverrideDomFromDirectedPreset === 'function') {
        cp.syncLiveWeatherOverrideDomFromDirectedPreset();
      }
    } catch (_) {}

    // If DOM not built yet, optional full pane refresh (legacy / other blades only).
    if (!cp._liveWeatherOverrideDomBuilt) {
      try {
        cp.pane?.refresh?.();
      } catch (_) {}
    }
  } catch (_) {}
}
