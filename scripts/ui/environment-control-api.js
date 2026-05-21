/**
 * @fileoverview Shared runtime API for manual environment overrides (weather, fog,
 * lightning, time). Used by Map Shine Control, Camera Path ramps, and player sync.
 *
 * @module ui/environment-control-api
 */
import { createLogger } from '../core/log.js';
import {
  applyWeatherManualParam,
  applyDirectedCustomPresetToWeather,
  resolveWeatherController,
} from './weather-param-bridge.js';
import { applyManualFogDensityToEffect } from './atmospheric-fog-bridge.js';
import { applyLightningIntensityToEffect } from './landscape-lightning-bridge.js';
import {
  clampEnvironmentValue,
  lerpEnvironmentSnapshots,
  normalizeEnvironmentSnapshot,
} from './environment-override-specs.js';
import { refreshMsaSameSceneRedrawPredict } from '../utils/msa-local-flag-guard.js';

const log = createLogger('EnvironmentControlApi');

/**
 * @typedef {Object} EnvironmentWeatherSnapshot
 * @property {number} precipitation
 * @property {number} cloudCover
 * @property {number} freezeLevel
 * @property {number} windSpeed
 * @property {number} windDirection
 */

/**
 * @typedef {Object} EnvironmentSnapshot
 * @property {number} timeOfDay
 * @property {number} manualFogDensity
 * @property {number} lightning
 * @property {EnvironmentWeatherSnapshot} weather
 */

/**
 * @typedef {Object} EnvironmentRampConfig
 * @property {boolean} enabled
 * @property {EnvironmentSnapshot} start
 * @property {EnvironmentSnapshot} end
 */

/**
 * @typedef {Object} EnvironmentApplyOptions
 * @property {boolean} [persist=false]
 * @property {boolean} [syncUi=true]
 * @property {boolean} [applyDarkness=true]
 * @property {boolean} [syncFoundryTime=false]
 * @property {boolean} [syncMainTweakpane] Mirror weather scalars into the main Weather Tweakpane folder
 */

export class EnvironmentControlApi {
  constructor() {
    /** @type {Set<string>} */
    this._driveTokens = new Set();

    /** @type {EnvironmentSnapshot|null} */
    this._preDriveSnapshot = null;

    /** @type {boolean|null} */
    this._preDriveDynamicPaused = null;
  }

  /** @returns {boolean} */
  isExternallyDriven() {
    return this._driveTokens.size > 0;
  }

  /**
   * @returns {EnvironmentSnapshot}
   */
  captureSnapshot() {
    const wc = resolveWeatherController();
    const st = wc?.targetState || wc?.currentState;
    const cp = window.MapShine?.controlPanel?.controlState;

    let windDirection = 0;
    if (wc && typeof wc._windAngleDegFromDir === 'function' && st?.windDirection) {
      windDirection = wc._windAngleDegFromDir(st.windDirection);
    } else if (Number.isFinite(Number(cp?.windDirection))) {
      windDirection = Number(cp.windDirection);
    }

    let windSpeed = 0;
    if (Number.isFinite(Number(st?.windSpeed))) {
      windSpeed = Number(st.windSpeed);
    } else if (Number.isFinite(Number(st?.windSpeedMS))) {
      windSpeed = Number(st.windSpeedMS) / 78;
    }

    const fogEffect = window.MapShine?.effectComposer?._floorCompositorV2?._atmosphericFogEffect;
    const ltnEffect = window.MapShine?.effectComposer?._floorCompositorV2?._weatherLightningEffect;

    const manualFogDensity = Number.isFinite(Number(fogEffect?.params?.manualFogDensity))
      ? Number(fogEffect.params.manualFogDensity)
      : Number(cp?.manualFogDensity ?? 0);

    const lightning = Number.isFinite(Number(ltnEffect?.params?.stormIntensity))
      ? Number(ltnEffect.params.stormIntensity)
      : Number(cp?.landscapeLightning?.lightning ?? 0);

    const hour = Number.isFinite(Number(wc?.timeOfDay))
      ? Number(wc.timeOfDay)
      : Number(cp?.timeOfDay ?? 12);

    return normalizeEnvironmentSnapshot({
      timeOfDay: hour,
      manualFogDensity,
      lightning,
      weather: {
        precipitation: st?.precipitation ?? cp?.directedCustomPreset?.precipitation ?? 0,
        cloudCover: st?.cloudCover ?? cp?.directedCustomPreset?.cloudCover ?? 0,
        freezeLevel: st?.freezeLevel ?? cp?.directedCustomPreset?.freezeLevel ?? 0,
        windSpeed,
        windDirection,
      },
    });
  }

  /**
   * @param {string} token
   */
  beginExternalDrive(token) {
    if (!token) return;
    if (this._driveTokens.size === 0) {
      this._preDriveSnapshot = this.captureSnapshot();
      const wc = resolveWeatherController();
      this._preDriveDynamicPaused = wc?.dynamicPaused === true;
      try {
        wc?.setDynamicPaused?.(true);
      } catch (_) {}
    }
    this._driveTokens.add(token);
  }

  /**
   * @param {string} token
   * @param {{ restore?: boolean }} [options]
   */
  endExternalDrive(token, options = {}) {
    const restore = options.restore !== false;
    if (token) this._driveTokens.delete(token);
    if (this._driveTokens.size > 0) return;

    const wc = resolveWeatherController();
    if (wc && this._preDriveDynamicPaused !== null) {
      try {
        wc.setDynamicPaused(this._preDriveDynamicPaused);
      } catch (_) {}
    }

    if (restore && this._preDriveSnapshot) {
      void this.applySnapshot(this._preDriveSnapshot, {
        persist: false,
        syncUi: true,
        applyDarkness: true,
        syncFoundryTime: false,
      });
    }

    this._preDriveSnapshot = null;
    this._preDriveDynamicPaused = null;
  }

  /**
   * @param {Partial<EnvironmentSnapshot>|Record<string, unknown>} patch
   * @param {EnvironmentApplyOptions} [options]
   * @returns {Promise<void>}
   */
  async applySnapshot(patch, options = {}) {
    refreshMsaSameSceneRedrawPredict();

    const snap = normalizeEnvironmentSnapshot({ ...this.captureSnapshot(), ...patch });
    const {
      persist = false,
      syncUi = true,
      applyDarkness = true,
      syncFoundryTime = false,
    } = options;
    const syncMainTweakpane = options.syncMainTweakpane ?? syncUi;

    const wc = resolveWeatherController();
    if (wc) {
      applyDirectedCustomPresetToWeather(wc, snap.weather, { syncMainTweakpane });
    }

    applyManualFogDensityToEffect(snap.manualFogDensity);
    applyLightningIntensityToEffect(snap.lightning);

    const sa = window.MapShine?.stateApplier;
    if (sa && typeof sa.applyTimeOfDay === 'function') {
      await sa.applyTimeOfDay(snap.timeOfDay, persist, applyDarkness, syncFoundryTime);
    } else if (wc?.setTime) {
      wc.setTime(snap.timeOfDay);
    }

    if (syncUi) {
      this.syncControlPanelDomFromSnapshot(snap);
    }
  }

  /**
   * @param {EnvironmentSnapshot} start
   * @param {EnvironmentSnapshot} end
   * @param {number} t
   * @param {EnvironmentApplyOptions} [options]
   * @returns {Promise<void>}
   */
  async applyInterpolated(start, end, t, options = {}) {
    const snap = lerpEnvironmentSnapshots(start, end, t);
    await this.applySnapshot(snap, {
      persist: false,
      syncUi: false,
      applyDarkness: true,
      syncFoundryTime: false,
      ...options,
    });
    return snap;
  }

  /**
   * @param {string} fieldId
   * @param {number} value
   * @param {EnvironmentApplyOptions} [options]
   * @returns {Promise<void>}
   */
  async applyField(fieldId, value, options = {}) {
    const snap = this.captureSnapshot();
    const v = clampEnvironmentValue(fieldId, value, 0);

    switch (fieldId) {
      case 'timeOfDay':
        snap.timeOfDay = v;
        break;
      case 'manualFogDensity':
        snap.manualFogDensity = v;
        break;
      case 'lightning':
        snap.lightning = v;
        break;
      default:
        if (snap.weather && fieldId in snap.weather) {
          snap.weather[/** @type {keyof EnvironmentWeatherSnapshot} */ (fieldId)] = v;
        }
        break;
    }

    await this.applySnapshot(snap, options);
  }

  /**
   * @param {EnvironmentSnapshot} snapshot
   */
  syncControlPanelDomFromSnapshot(snapshot) {
    const snap = normalizeEnvironmentSnapshot(snapshot);
    const cp = window.MapShine?.controlPanel;
    if (!cp) return;

    try {
      if (cp.controlState) {
        cp.controlState.timeOfDay = snap.timeOfDay;
        cp.controlState.manualFogDensity = snap.manualFogDensity;
        if (!cp.controlState.landscapeLightning) cp.controlState.landscapeLightning = {};
        cp.controlState.landscapeLightning.lightning = snap.lightning;
        if (cp.controlState.directedCustomPreset) {
          Object.assign(cp.controlState.directedCustomPreset, snap.weather);
        }
        cp.controlState.windSpeedMS = snap.weather.windSpeed * 78;
        cp.controlState.windDirection = snap.weather.windDirection;
      }
      cp.syncLiveWeatherOverrideDomFromDirectedPreset?.();
      cp.syncManualFogDomFromControlState?.();
      cp.syncLiveLightningDomFromControlState?.();
      cp._updateClock?.(snap.timeOfDay);
    } catch (err) {
      log.warn('Failed to sync control panel DOM from snapshot', err);
    }
  }
}

/** @type {EnvironmentControlApi} */
export const environmentControlApi = new EnvironmentControlApi();
