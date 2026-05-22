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
 * @property {boolean} [transient=false] Lightweight per-frame apply (Camera Path ramp); skips scene I/O
 */

export class EnvironmentControlApi {
  constructor() {
    /** @type {Set<string>} */
    this._driveTokens = new Set();

    /** @type {EnvironmentSnapshot|null} */
    this._preDriveSnapshot = null;

    /** @type {boolean|null} */
    this._preDriveDynamicPaused = null;

    /** @type {boolean|undefined} */
    this._preDriveWeatherEnabled = undefined;

    /** @type {number} */
    this._lastTransientDarknessMs = 0;
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
   * Ensure WeatherController is ready before Camera Path / remote environment drives.
   * @private
   */
  async _ensureWeatherControllerReady() {
    const wc = resolveWeatherController();
    if (!wc || wc.initialized === true) return;
    if (typeof wc.initialize !== 'function') return;
    try {
      await wc.initialize();
    } catch (err) {
      log.warn('WeatherController initialize failed during external drive', err);
    }
  }

  /**
   * @param {string} token
   */
  async beginExternalDrive(token) {
    if (!token) return;
    if (this._driveTokens.size === 0) {
      await this._ensureWeatherControllerReady();
      this._preDriveSnapshot = this.captureSnapshot();
      const wc = resolveWeatherController();
      this._preDriveDynamicPaused = wc?.dynamicPaused === true;
      this._preDriveWeatherEnabled = wc?.enabled;
      try {
        wc?.setDynamicPaused?.(true);
      } catch (_) {}
      if (wc && wc.enabled === false) {
        wc.enabled = true;
      }
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
    if (wc && this._preDriveWeatherEnabled !== undefined) {
      wc.enabled = this._preDriveWeatherEnabled;
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
    this._preDriveWeatherEnabled = undefined;
  }

  /**
   * Throttled darkness push during transient ramps (no scene flag writes).
   * @private
   * @param {number} hour
   */
  _scheduleTransientDarkness(hour) {
    const now = performance.now();
    if (now - this._lastTransientDarknessMs < 180) return;
    this._lastTransientDarknessMs = now;
    const sa = window.MapShine?.stateApplier;
    if (!sa || typeof sa.applyTimeOfDay !== 'function') return;
    void sa.applyTimeOfDay(hour, false, true, false).catch((err) => {
      log.warn('Transient darkness apply failed', err);
    });
  }

  /**
   * Apply a fully-resolved snapshot without merging capture() (hot path).
   * @param {import('./environment-control-api.js').EnvironmentSnapshot} snap
   * @param {EnvironmentApplyOptions} [options]
   * @returns {import('./environment-control-api.js').EnvironmentSnapshot}
   */
  applySnapshotDirect(snap, options = {}) {
    refreshMsaSameSceneRedrawPredict();
    const normalized = normalizeEnvironmentSnapshot(snap);
    this._applySnapshotCore(normalized, options);
    return normalized;
  }

  /**
   * @param {import('./environment-control-api.js').EnvironmentSnapshot} snap
   * @param {EnvironmentApplyOptions} [options]
   * @private
   */
  _applySnapshotCore(snap, options = {}) {
    const {
      syncUi = false,
      applyDarkness = true,
      syncFoundryTime = false,
      persist = false,
      transient = false,
    } = options;
    const syncMainTweakpane = options.syncMainTweakpane ?? syncUi;

    const wc = resolveWeatherController();
    if (wc) {
      applyDirectedCustomPresetToWeather(wc, snap.weather, { syncMainTweakpane: !transient && syncMainTweakpane });
      this._syncCloudEffectFromWeatherSnapshot(snap.weather);
    }

    applyManualFogDensityToEffect(snap.manualFogDensity);
    applyLightningIntensityToEffect(snap.lightning);

    if (transient) {
      wc?.setTime?.(snap.timeOfDay);
      if (applyDarkness) this._scheduleTransientDarkness(snap.timeOfDay);
    }
  }

  /**
   * Mirror ramped cloud cover into the sprite effect param bucket.
   * @private
   * @param {import('./environment-control-api.js').EnvironmentWeatherSnapshot} weather
   */
  _syncCloudEffectFromWeatherSnapshot(weather) {
    if (!weather || typeof weather !== 'object') return;
    const cover = Number(weather.cloudCover);
    if (!Number.isFinite(cover)) return;
    const cloudFx = window.MapShine?.effectComposer?._floorCompositorV2?._cloudEffect
      ?? window.MapShine?.floorCompositorV2?._cloudEffect;
    if (!cloudFx?.params) return;
    cloudFx.params.cloudCover = Math.max(0, Math.min(1, cover));
  }

  /**
   * @param {Partial<EnvironmentSnapshot>|Record<string, unknown>} patch
   * @param {EnvironmentApplyOptions} [options]
   * @returns {Promise<void>}
   */
  async applySnapshot(patch, options = {}) {
    if (options.transient === true) {
      const snap = normalizeEnvironmentSnapshot(
        patch && typeof patch === 'object' && 'timeOfDay' in patch
          ? patch
          : { ...this.captureSnapshot(), ...patch },
      );
      this._applySnapshotCore(snap, options);
      if (options.syncUi) this.syncControlPanelDomFromSnapshot(snap);
      return;
    }

    await this._ensureWeatherControllerReady();

    const snap = normalizeEnvironmentSnapshot({ ...this.captureSnapshot(), ...patch });
    const {
      persist = false,
      syncUi = true,
      applyDarkness = true,
      syncFoundryTime = false,
    } = options;

    this._applySnapshotCore(snap, { ...options, syncUi, applyDarkness, syncFoundryTime, persist, transient: false });

    const wc = resolveWeatherController();
    const sa = window.MapShine?.stateApplier;
    if (sa && typeof sa.applyTimeOfDay === 'function') {
      await sa.applyTimeOfDay(snap.timeOfDay, persist, applyDarkness, syncFoundryTime);
    } else {
      wc?.setTime?.(snap.timeOfDay);
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
    if (options.transient === true) {
      return this.applySnapshotDirect(snap, {
        persist: false,
        syncUi: false,
        applyDarkness: true,
        syncFoundryTime: false,
        transient: true,
        ...options,
      });
    }
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
