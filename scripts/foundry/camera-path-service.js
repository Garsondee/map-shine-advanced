/**
 * @fileoverview Camera path persistence, playback, and presentation orchestration.
 *
 * @module foundry/camera-path-service
 */
import { createLogger } from '../core/log.js';
import { CameraAnimator } from './camera-animator.js';
import {
  CAMERA_PATH_POINT_KEYS,
  CAMERA_PATH_LETTERBOX_BAR_HEIGHT_PCT,
  generateCameraPathPreset,
  resolveCameraPathViewport,
} from './camera-path-generator.js';
import { environmentControlApi } from '../ui/environment-control-api.js';
import {
  environmentPlaybackDriver,
  computeCameraPathMotionDurationMs,
} from './environment-playback-driver.js';
import {
  createDefaultEnvironmentSnapshot,
  normalizeEnvironmentSnapshot,
  clampEnvironmentTimeScale,
} from '../ui/environment-override-specs.js';
import { buildCameraTimeline, getCameraPathPlacementOptions } from './camera-path-timeline.js';
import {
  createSignificantLocationId,
  normalizeSignificantLocations,
  SIG_LOC_FADE_CUT_MS,
} from './camera-path-types.js';

const log = createLogger('CameraPathService');
const MODULE_ID = 'map-shine-advanced';
const FLAG_KEY = 'cameraPath';
const CAMERA_PATH_PRE_HOLD_MS = 800;
const CAMERA_PATH_SEGMENT_HOLD_MS = 800;
const ENV_DRIVE_TOKEN = 'camera-path';

/** @typedef {import('./camera-animator.js').CameraEasingId} CameraEasingId */

/**
 * @typedef {Object} CameraPathSettings
 * @property {number} [duration]
 * @property {CameraEasingId} [easing]
 * @property {boolean} [hideUi]
 * @property {boolean} [hideMapLayers]
 * @property {boolean} [letterbox]
 * @property {boolean} [syncToPlayers]
 * @property {boolean} [framedForLetterbox]
 * @property {boolean} [fadeFromBlack]
 * @property {boolean} [fadeToBlack]
 * @property {number} [fadeDurationMs]
 * @property {number} [fadeHoldMs]
 * @property {import('../ui/environment-control-api.js').EnvironmentRampConfig} [environmentRamp]
 * @property {number} [defaultSigHoldSec]
 * @property {number} [sigTransitionSec]
 * @property {number} [playbackTimeScale]
 */

/**
 * @typedef {Object} CameraPathData
 * @property {Record<string, {x?: number|null, y?: number|null, scale?: number|null}>} [points]
 * @property {import('./camera-path-types.js').SignificantLocation[]} [significantLocations]
 * @property {CameraPathSettings} [settings]
 */

function asNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function defaultEnvironmentRamp() {
  const snap = createDefaultEnvironmentSnapshot();
  return {
    enabled: false,
    start: { ...snap, weather: { ...snap.weather } },
    end: { ...snap, weather: { ...snap.weather } },
  };
}

function normalizeEnvironmentRamp(raw) {
  const base = defaultEnvironmentRamp();
  if (!raw || typeof raw !== 'object') return base;
  return {
    enabled: raw.enabled === true,
    start: normalizeEnvironmentSnapshot(raw.start ?? base.start),
    end: normalizeEnvironmentSnapshot(raw.end ?? base.end),
  };
}

/**
 * @param {unknown} raw
 * @returns {import('./camera-path-service.js').CameraPathSettings}
 */
function normalizeSettings(raw) {
  const base = defaultSettings();
  const src = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  const ramp = normalizeEnvironmentRamp(src.environmentRamp);

  let playbackTimeScale = clampEnvironmentTimeScale(src.playbackTimeScale);
  if (src.playbackTimeScale === undefined || src.playbackTimeScale === null) {
    const legacyRamp = src.environmentRamp && typeof src.environmentRamp === 'object'
      ? /** @type {Record<string, unknown>} */ (src.environmentRamp)
      : null;
    if (legacyRamp?.timeScale !== undefined) {
      playbackTimeScale = clampEnvironmentTimeScale(legacyRamp.timeScale);
    }
  }

  return {
    duration: asNumber(src.duration, base.duration),
    easing: src.easing === 'easeInOutCosine' ? 'easeInOutCosine' : 'trapezoidal',
    hideUi: src.hideUi !== false,
    hideMapLayers: src.hideMapLayers !== false,
    letterbox: src.letterbox === true,
    syncToPlayers: src.syncToPlayers === true,
    fadeFromBlack: src.fadeFromBlack !== false,
    fadeToBlack: src.fadeToBlack !== false,
    fadeDurationMs: Math.max(0, asNumber(src.fadeDurationMs, base.fadeDurationMs)),
    fadeHoldMs: Math.max(0, asNumber(src.fadeHoldMs, base.fadeHoldMs)),
    defaultSigHoldSec: Math.max(0.5, asNumber(src.defaultSigHoldSec, base.defaultSigHoldSec)),
    sigTransitionSec: Math.max(0, asNumber(src.sigTransitionSec, base.sigTransitionSec)),
    playbackTimeScale,
    environmentRamp: ramp,
  };
}

function defaultSettings() {
  return {
    duration: 15,
    easing: /** @type {CameraEasingId} */ ('trapezoidal'),
    hideUi: true,
    hideMapLayers: true,
    letterbox: false,
    syncToPlayers: false,
    fadeFromBlack: true,
    fadeToBlack: true,
    fadeDurationMs: 8000,
    fadeHoldMs: 4000,
    defaultSigHoldSec: 8,
    sigTransitionSec: 2,
    playbackTimeScale: 1,
    environmentRamp: defaultEnvironmentRamp(),
  };
}

/**
 * @param {unknown} pt
 * @returns {boolean}
 */
function isValidPoint(pt) {
  return pt
    && typeof pt === 'object'
    && pt.x !== undefined
    && pt.x !== null
    && pt.x !== '';
}

export class CameraPathService {
  constructor() {
    /** @type {CameraAnimator} */
    this.animator = new CameraAnimator();

    /** @type {import('./environment-playback-driver.js').EnvironmentPlaybackDriver} */
    this.environmentDriver = environmentPlaybackDriver;

    /** @type {boolean} */
    this._playing = false;

    /** @type {Map<string, { layer: object, state: boolean }>} */
    this._layerStates = new Map();

    /** @type {object|null} */
    this._cinematicSnapshot = null;

    /** @type {number|null} */
    this._hideUiTimeoutId = null;

    /** @type {(() => void)|null} */
    this._hideUiEscapeListener = null;

    /** @type {HTMLElement|null} */
    this._letterboxRoot = null;

    /** @type {HTMLElement|null} */
    this._fadeOverlayEl = null;

    /** @type {number} */
    this._fadeToken = 0;

    /** @type {number|null} */
    this._canvasTearDownHookId = null;

    /** @type {((event: KeyboardEvent) => void)|null} */
    this._playbackEscapeListener = null;

    /** @type {number} Monotonic id so stale playback finally blocks cannot clobber a new run. */
    this._playbackSession = 0;

    /** @type {CameraPathSettings|null} */
    this._activePlaybackSettings = null;

    /** @type {boolean} */
    this._playbackScaleActive = false;

    this._purgeOrphanLetterboxDom();
    this._purgeOrphanFadeDom();
    this._registerCanvasHooks();
  }

  /** @private */
  _registerCanvasHooks() {
    if (this._canvasTearDownHookId != null) return;
    try {
      this._canvasTearDownHookId = Hooks.on('canvasTearDown', () => {
        const wasPlaying = this._playing;
        this._playing = false;
        if (wasPlaying || environmentControlApi.isExternallyDriven()) {
          this._cleanupEnvironmentPlayback({ broadcastRelease: true, settings: this._activePlaybackSettings });
        }
        this._clearPlaybackTimeScale();
        this._forceReleasePlaybackPresentation();
        this._purgeOrphanLetterboxDom();
        this._purgeOrphanFadeDom();
        this._cinematicSnapshot = null;
        this._activePlaybackSettings = null;
      });
      Hooks.on('canvasReady', () => {
        this._purgeOrphanLetterboxDom();
        this._purgeOrphanFadeDom();
        this._clearPlaybackTimeScale();
        if (!this._playing) {
          document.body.classList.remove('map-shine-camera-path-hide-ui');
          if (environmentControlApi.isExternallyDriven()) {
            try {
              environmentControlApi.endExternalDrive(ENV_DRIVE_TOKEN, { restore: true });
            } catch (_) {}
            try { environmentPlaybackDriver.stop(); } catch (_) {}
          }
          const ccm = window.MapShine?.cinematicCameraManager;
          const state = ccm?.getState?.();
          // Clear stale sync state left by an interrupted camera-path playback.
          if (state?.cinematicActive && !state?.lockPlayers) {
            ccm.applyTransientState({
              cinematicActive: false,
              lockPlayers: false,
              letterboxEnabled: false,
            });
          }
        }
      });
    } catch (_) {}
  }

  /** @private */
  _purgeOrphanLetterboxDom() {
    try {
      document.querySelectorAll('#map-shine-camera-path-letterbox').forEach((el) => {
        try { el.remove(); } catch (_) {}
      });
    } catch (_) {}
    this._letterboxRoot = null;
  }

  /** @returns {boolean} */
  get isPlaying() {
    return this._playing;
  }

  /**
   * @returns {CameraPathData}
   */
  getDefaultData() {
    /** @type {Record<string, {x: null, y: null, scale: null}>} */
    const points = {};
    for (const key of CAMERA_PATH_POINT_KEYS) {
      points[key] = { x: null, y: null, scale: null };
    }
    return { points, settings: defaultSettings(), significantLocations: [] };
  }

  /**
   * @returns {CameraPathData}
   */
  loadData() {
    try {
      const raw = game?.user?.getFlag?.(MODULE_ID, FLAG_KEY);
      if (!raw || typeof raw !== 'object') return this.getDefaultData();
      return {
        points: { ...this.getDefaultData().points, ...(raw.points || {}) },
        significantLocations: normalizeSignificantLocations(raw.significantLocations),
        settings: normalizeSettings(raw.settings),
      };
    } catch (_) {
      return this.getDefaultData();
    }
  }

  /**
   * @param {CameraPathData} data
   * @returns {Promise<void>}
   */
  async saveData(data) {
    try {
      await game.user.setFlag(MODULE_ID, FLAG_KEY, data);
    } catch (err) {
      log.warn('Failed to save camera path data', err);
      throw err;
    }
  }

  /**
   * @returns {{ x: number, y: number, scale: number }}
   */
  getCurrentView() {
    const view = this.animator.captureCurrentView();
    if (view) {
      return {
        x: Math.round(view.x),
        y: Math.round(view.y),
        scale: Number(view.scale.toFixed(4)),
      };
    }

    const pos = canvas?.scene?._viewPosition;
    return {
      x: Math.round(asNumber(pos?.x, 0)),
      y: Math.round(asNumber(pos?.y, 0)),
      scale: Number(asNumber(pos?.scale, 1).toFixed(4)),
    };
  }

  /**
   * @param {string} pointKey
   * @returns {Promise<void>}
   */
  async recordPoint(pointKey) {
    const data = this.loadData();
    if (!data.points) data.points = {};
    data.points[pointKey] = this.getCurrentView();
    await this.saveData(data);
  }

  /**
   * @param {string} pointKey
   * @returns {boolean}
   */
  goToPoint(pointKey) {
    const data = this.loadData();
    const point = data.points?.[pointKey];
    if (!isValidPoint(point)) return false;
    this.animator.instantPan({
      x: asNumber(point.x, 0),
      y: asNumber(point.y, 0),
      scale: asNumber(point.scale, 1),
    });
    return true;
  }

  /**
   * @param {number} scaleMul
   * @returns {{ scaleMul: number, mapWidth?: number, mapHeight?: number, sigLocFadeCutMs: number }}
   * @private
   */
  _getTimelineBuildOptions(scaleMul) {
    const dims = canvas?.dimensions;
    return {
      scaleMul,
      mapWidth: dims?.width,
      mapHeight: dims?.height,
      sigLocFadeCutMs: SIG_LOC_FADE_CUT_MS,
    };
  }

  /**
   * @param {import('./camera-path-types.js').CameraView} toView
   * @param {number} fadeMs
   * @param {() => boolean} [getIsCancelled]
   * @returns {Promise<void>}
   * @private
   */
  async _runSigLocFadeCut(toView, fadeMs, getIsCancelled = null) {
    if (!this._fadeOverlayEl) this._showFadeOverlay(0);
    await this._animateFadeOverlayOpacity(1, fadeMs, getIsCancelled);
    if (getIsCancelled?.()) return;
    this.animator.instantPan(toView);
    await this._animateFadeOverlayOpacity(0, fadeMs, getIsCancelled);
  }

  /**
   * @param {CameraPathData} [data]
   * @returns {import('./camera-path-types.js').CameraTimelineBuildResult}
   */
  getTimelinePreview(data = null) {
    const pathData = data || this.loadData();
    const settings = normalizeSettings(pathData.settings);
    const scaleMul = this._getLetterboxScaleMultiplier(settings);
    return buildCameraTimeline(
      { ...pathData, settings },
      this._getTimelineBuildOptions(scaleMul),
    );
  }

  /**
   * @param {CameraPathData} [data]
   * @returns {{ interstitial: Array<{ value: string, label: string }>, split: Array<{ value: string, label: string }> }}
   */
  getPlacementOptions(data = null) {
    const pathData = data || this.loadData();
    const settings = normalizeSettings(pathData.settings);
    const scaleMul = this._getLetterboxScaleMultiplier(settings);
    return getCameraPathPlacementOptions(
      { ...pathData, settings },
      { scaleMul },
    );
  }

  /**
   * @param {string[]} orderedIds
   * @returns {Promise<boolean>}
   */
  async reorderSignificantLocations(orderedIds) {
    if (!Array.isArray(orderedIds) || !orderedIds.length) return false;
    const data = this.loadData();
    const list = data.significantLocations || [];
    const byId = new Map(list.map((loc) => [loc.id, loc]));
    const reordered = [];
    for (const id of orderedIds) {
      const loc = byId.get(id);
      if (loc) {
        reordered.push(loc);
        byId.delete(id);
      }
    }
    for (const loc of byId.values()) reordered.push(loc);
    data.significantLocations = reordered;
    await this.saveData(data);
    return true;
  }

  /**
   * @param {string} name
   * @param {number} [holdSec]
   * @returns {Promise<import('./camera-path-types.js').SignificantLocation|null>}
   */
  async recordSignificantLocation(name, holdSec = undefined) {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) return null;

    const view = this.getCurrentView();
    const data = this.loadData();
    if (!Array.isArray(data.significantLocations)) data.significantLocations = [];

    /** @type {import('./camera-path-types.js').SignificantLocation} */
    const loc = {
      id: createSignificantLocationId(),
      name: trimmed,
      x: view.x,
      y: view.y,
      scale: view.scale,
    };
    if (Number.isFinite(Number(holdSec)) && Number(holdSec) > 0) {
      loc.holdSec = Number(holdSec);
    }

    data.significantLocations.push(loc);
    await this.saveData(data);
    return loc;
  }

  /**
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async removeSignificantLocation(id) {
    if (!id) return false;
    const data = this.loadData();
    const before = data.significantLocations?.length ?? 0;
    data.significantLocations = (data.significantLocations || []).filter((loc) => loc.id !== id);
    if (data.significantLocations.length === before) return false;
    await this.saveData(data);
    return true;
  }

  /**
   * @param {string} id
   * @param {Partial<import('./camera-path-types.js').SignificantLocation>} patch
   * @returns {Promise<boolean>}
   */
  async updateSignificantLocation(id, patch) {
    if (!id || !patch || typeof patch !== 'object') return false;
    const data = this.loadData();
    const list = data.significantLocations || [];
    const index = list.findIndex((loc) => loc.id === id);
    if (index < 0) return false;

    const current = list[index];
    list[index] = {
      ...current,
      ...patch,
      id: current.id,
    };
    data.significantLocations = list;
    await this.saveData(data);
    return true;
  }

  /**
   * @param {string} id
   * @returns {boolean}
   */
  goToSignificantLocation(id) {
    const data = this.loadData();
    const loc = (data.significantLocations || []).find((item) => item.id === id);
    if (!loc) return false;
    const scaleMul = this._getLetterboxScaleMultiplier(data.settings || {});
    this.animator.instantPan({
      x: asNumber(loc.x, 0),
      y: asNumber(loc.y, 0),
      scale: asNumber(loc.scale, 1) * scaleMul,
    });
    return true;
  }

  /**
   * @param {string} pointKey
   * @param {{ x: number, y: number, scale: number }} view
   * @returns {Promise<void>}
   */
  async updatePoint(pointKey, view) {
    const data = this.loadData();
    if (!data.points) data.points = {};
    data.points[pointKey] = {
      x: view.x,
      y: view.y,
      scale: view.scale,
    };
    await this.saveData(data);
    this.animator.instantPan(view);
  }

  /**
   * @param {import('./camera-path-generator.js').CameraPathPresetId} type
   * @returns {Promise<CameraPathData|null>}
   */
  async generatePreset(type) {
    const data = this.loadData();
    const letterboxEnabled = data.settings?.letterbox === true;
    const generated = generateCameraPathPreset(type, { letterboxEnabled });
    if (!generated) return null;

    data.points = generated.points;
    data.settings = {
      ...data.settings,
      ...generated.settings,
      framedForLetterbox: letterboxEnabled,
    };
    await this.saveData(data);
    return data;
  }

  /**
   * @param {CameraPathData} data
   * @returns {number}
   */
  countSweeps(data) {
    const points = data.points || {};
    let totalSweeps = 1;
    if (isValidPoint(points.C) && isValidPoint(points.D)) totalSweeps = 2;
    if (isValidPoint(points.E) && isValidPoint(points.F)) totalSweeps = 3;
    if (isValidPoint(points.G) && isValidPoint(points.H)) totalSweeps = 4;
    return totalSweeps;
  }

  /**
   * Zoom multiplier when playback uses letterbox but path points were not framed for it.
   *
   * @param {CameraPathSettings} settings
   * @returns {number}
   * @private
   */
  _getLetterboxScaleMultiplier(settings) {
    if (settings?.letterbox !== true || settings?.framedForLetterbox === true) return 1;
    const vp = resolveCameraPathViewport(window.innerWidth, window.innerHeight, true);
    return window.innerHeight / vp.height;
  }

  /**
   * @param {CameraPathData} data
   * @returns {import('./camera-animator.js').CameraPathSegment[]}
   */
  buildSegments(data) {
    const points = data.points || {};
    const settings = data.settings || {};
    const totalSweeps = this.countSweeps(data);
    const totalDurationSec = asNumber(settings.duration, 15);
    const durationPerSweepMs = (totalDurationSec / totalSweeps) * 1000;
    const scaleMul = this._getLetterboxScaleMultiplier(settings);

    /** @type {Array<[string, string]>} */
    const pairs = [['A', 'B']];
    if (totalSweeps >= 2) pairs.push(['C', 'D']);
    if (totalSweeps >= 3) pairs.push(['E', 'F']);
    if (totalSweeps >= 4) pairs.push(['G', 'H']);

    return pairs.map(([fromKey, toKey]) => {
      const from = points[fromKey];
      const to = points[toKey];
      return {
        from: {
          x: asNumber(from.x, 0),
          y: asNumber(from.y, 0),
          scale: asNumber(from.scale, 1) * scaleMul,
        },
        to: {
          x: asNumber(to.x, 0),
          y: asNumber(to.y, 0),
          scale: asNumber(to.scale, 1) * scaleMul,
        },
        durationMs: durationPerSweepMs,
      };
    });
  }

  /**
   * Force-clear presentation state (UI hide, letterbox, input block, render loop).
   * Safe to call multiple times.
   * @private
   */
  _forceReleasePlaybackPresentation() {
    this._fadeToken += 1;
    this._hideLetterboxOverlay();
    this._destroyFadeOverlay();
    this._showMapLayers();
    this._showUiElements();
    this._showDoorControls();

    try { window.MapShine?.renderLoop?.stopCinematicMode?.(); } catch (_) {}
    try {
      window.MapShine?.pixiInputBridge?.setInputBlocker?.(null);
      window.MapShine?.cinematicCameraManager?._bindInputBridge?.();
    } catch (_) {}
    try {
      window.MapShine?.cinematicCameraManager?.resumeTemporaryRuntimeControl?.();
    } catch (_) {}
  }

  /**
   * @param {CameraPathSettings} settings
   * @private
   */
  _applyPresentation(settings) {
    this._hideLetterboxOverlay();

    const ccm = window.MapShine?.cinematicCameraManager;
    if (ccm) {
      const state = ccm.getState();
      this._cinematicSnapshot = {
        cinematicActive: state.cinematicActive === true,
        lockPlayers: state.lockPlayers === true,
        strictFollow: state.strictFollow === true,
        letterboxEnabled: state.letterboxEnabled === true,
        uiFade: asNumber(state.uiFade, 0.92),
        barHeightPct: asNumber(state.barHeightPct, 0.12),
        improvedModeEnabled: state.improvedModeEnabled === true,
      };
    }

    if (settings.hideUi) {
      this._hideUiElements();
    }

    if (this._playing) {
      this._hideDoorControls();
    }

    if (settings.letterbox === true && this._playing) {
      this._showLetterboxOverlay();
    }

    if (settings.syncToPlayers && ccm) {
      ccm.applyTransientState({
        improvedModeEnabled: true,
        cinematicActive: true,
        lockPlayers: true,
        letterboxEnabled: false,
      });
    }

    if (settings.hideMapLayers) {
      this._hideMapLayers();
    }
  }

  /** @private */
  _restorePresentation() {
    this._forceReleasePlaybackPresentation();

    const ccm = window.MapShine?.cinematicCameraManager;
    const snap = this._cinematicSnapshot;
    this._cinematicSnapshot = null;

    if (!ccm || !snap) return;

    ccm.applyTransientState({
      improvedModeEnabled: snap.improvedModeEnabled,
      cinematicActive: snap.cinematicActive,
      lockPlayers: snap.lockPlayers,
      strictFollow: snap.strictFollow,
      letterboxEnabled: snap.cinematicActive ? snap.letterboxEnabled : false,
      uiFade: snap.uiFade,
      barHeightPct: snap.barHeightPct,
    });
  }

  /**
   * Immediate abort: stop animation and restore UI without waiting for rAF unwind.
   */
  abortPlayback() {
    const wasRunning = this._playing || this.animator.isActive;
    this._playbackSession += 1;
    this.animator.cancel();
    this._playing = false;
    this._removePlaybackEscapeListener();
    this._clearPlaybackTimeScale();
    this._forceReleasePlaybackPresentation();
    this._cleanupEnvironmentPlayback({
      broadcastRelease: true,
      settings: this._activePlaybackSettings,
    });
    this._restorePresentation();
    this._activePlaybackSettings = null;
    this.animator.resetCancellationState();
    return wasRunning;
  }

  /**
   * @param {{ broadcastRelease?: boolean, settings?: import('./camera-path-service.js').CameraPathSettings|null }} [options]
   * @private
   */
  _cleanupEnvironmentPlayback(options = {}) {
    const broadcastRelease = options.broadcastRelease !== false;
    const sync = options.settings?.syncToPlayers === true;

    try {
      environmentPlaybackDriver.stop();
    } catch (_) {}

    try {
      environmentControlApi.endExternalDrive(ENV_DRIVE_TOKEN, { restore: true });
    } catch (_) {}

    if (broadcastRelease && sync) {
      try {
        window.MapShine?.cinematicCameraManager?.broadcastEnvironmentRelease?.();
      } catch (_) {}
    }

    try {
      const restored = environmentControlApi.captureSnapshot();
      environmentControlApi.syncControlPanelDomFromSnapshot(restored);
    } catch (_) {}
  }

  /**
   * @param {() => void} onCancel
   * @private
   */
  _installPlaybackEscapeListener(onCancel) {
    this._removePlaybackEscapeListener();
    this._playbackEscapeListener = (event) => {
      if (event.key !== 'Escape') return;
      onCancel();
    };
    document.addEventListener('keydown', this._playbackEscapeListener);
  }

  /** @private */
  _removePlaybackEscapeListener() {
    if (this._playbackEscapeListener) {
      document.removeEventListener('keydown', this._playbackEscapeListener);
      this._playbackEscapeListener = null;
    }
  }

  /**
   * @returns {import('../core/time.js').TimeManager|null}
   * @private
   */
  _getTimeManager() {
    try {
      return window.MapShine?.timeManager
        ?? window.MapShine?.effectComposer?.getTimeManager?.()
        ?? null;
    } catch (_) {
      return null;
    }
  }

  /**
   * @param {number} scale
   * @private
   */
  _applyPlaybackTimeScale(scale) {
    const tm = this._getTimeManager();
    if (!tm || typeof tm.setPlaybackScale !== 'function') return;
    tm.setPlaybackScale(clampEnvironmentTimeScale(scale));
    this._playbackScaleActive = true;
  }

  /** @private */
  _clearPlaybackTimeScale() {
    if (!this._playbackScaleActive) {
      try {
        this._getTimeManager()?.clearPlaybackScale?.();
      } catch (_) {}
      return;
    }
    try {
      this._getTimeManager()?.clearPlaybackScale?.();
    } catch (_) {}
    this._playbackScaleActive = false;
  }

  /**
   * @param {number} ms
   * @param {() => boolean} [getIsCancelled]
   * @param {number} [playbackTimeScale=1]
   * @returns {Promise<void>}
   * @private
   */
  async _sleepMs(ms, getIsCancelled = null, playbackTimeScale = 1) {
    const scale = Math.max(0.1, Number(playbackTimeScale) || 1);
    const duration = Math.max(0, scale >= 0.999 ? ms : ms / scale);
    if (duration <= 0) return;

    const start = performance.now();
    while (performance.now() - start < duration) {
      if (getIsCancelled?.()) return;
      const remaining = duration - (performance.now() - start);
      await new Promise((resolve) => {
        window.setTimeout(resolve, Math.min(50, remaining));
      });
    }
  }

  /** @private */
  _showLetterboxOverlay() {
    if (!this._playing) return;

    this._destroyLetterboxOverlay();

    const root = document.createElement('div');
    root.id = 'map-shine-camera-path-letterbox';
    root.className = 'map-shine-camera-path-letterbox map-shine-camera-path-letterbox--active';
    root.setAttribute('aria-hidden', 'true');

    const top = document.createElement('div');
    top.className = 'map-shine-camera-path-bar map-shine-camera-path-bar--top';

    const bottom = document.createElement('div');
    bottom.className = 'map-shine-camera-path-bar map-shine-camera-path-bar--bottom';

    root.appendChild(top);
    root.appendChild(bottom);
    root.style.setProperty(
      '--map-shine-camera-path-bar-height',
      `${CAMERA_PATH_LETTERBOX_BAR_HEIGHT_PCT * 100}%`,
    );
    document.body.appendChild(root);
    this._letterboxRoot = root;
  }

  /** @private */
  _hideLetterboxOverlay() {
    this._destroyLetterboxOverlay();
  }

  /** @private */
  _destroyLetterboxOverlay() {
    if (this._letterboxRoot) {
      try { this._letterboxRoot.remove(); } catch (_) {}
      this._letterboxRoot = null;
    }
    // Catch orphaned nodes (e.g. after scene reload interrupted playback).
    try {
      const orphan = document.getElementById('map-shine-camera-path-letterbox');
      if (orphan) orphan.remove();
    } catch (_) {}
  }

  /** @private */
  _purgeOrphanFadeDom() {
    try {
      document.querySelectorAll('#map-shine-camera-path-fade').forEach((el) => {
        try { el.remove(); } catch (_) {}
      });
    } catch (_) {}
    this._fadeOverlayEl = null;
  }

  /**
   * @param {number} [initialOpacity=1]
   * @private
   */
  _showFadeOverlay(initialOpacity = 1) {
    this._destroyFadeOverlay();

    const el = document.createElement('div');
    el.id = 'map-shine-camera-path-fade';
    el.className = 'map-shine-camera-path-fade';
    el.setAttribute('aria-hidden', 'true');
    el.style.opacity = String(Math.max(0, Math.min(1, initialOpacity)));
    document.body.appendChild(el);
    this._fadeOverlayEl = el;
  }

  /** @private */
  _destroyFadeOverlay() {
    this._fadeToken += 1;
    if (this._fadeOverlayEl) {
      try { this._fadeOverlayEl.remove(); } catch (_) {}
      this._fadeOverlayEl = null;
    }
    try {
      const orphan = document.getElementById('map-shine-camera-path-fade');
      if (orphan) orphan.remove();
    } catch (_) {}
  }

  /**
   * @param {number} targetOpacity
   * @param {number} durationMs
   * @param {() => boolean} [getIsCancelled]
   * @returns {Promise<void>}
   * @private
   */
  _animateFadeOverlayOpacity(targetOpacity, durationMs, getIsCancelled = null) {
    return new Promise((resolve) => {
      const el = this._fadeOverlayEl;
      if (!el) {
        resolve();
        return;
      }

      const token = ++this._fadeToken;
      const ms = Math.max(0, durationMs);
      const target = Math.max(0, Math.min(1, targetOpacity));
      let safetyId = null;

      const isCancelled = () => token !== this._fadeToken
        || !this._fadeOverlayEl
        || this._fadeOverlayEl !== el
        || getIsCancelled?.() === true;

      const cleanup = () => {
        el.removeEventListener('transitionend', onTransitionEnd);
        el.removeEventListener('transitioncancel', onTransitionEnd);
        if (safetyId !== null) clearTimeout(safetyId);
        resolve();
      };

      const onTransitionEnd = () => {
        if (isCancelled()) {
          cleanup();
          return;
        }
        cleanup();
      };

      if (isCancelled()) {
        resolve();
        return;
      }

      el.style.transition = 'none';
      void el.offsetHeight;

      const applyTransition = () => {
        if (isCancelled()) {
          resolve();
          return;
        }

        el.style.transition = `opacity ${ms}ms ease-in-out`;
        el.style.opacity = String(target);

        if (ms <= 0) {
          cleanup();
          return;
        }

        el.addEventListener('transitionend', onTransitionEnd, { once: true });
        el.addEventListener('transitioncancel', onTransitionEnd, { once: true });
        safetyId = window.setTimeout(onTransitionEnd, ms + 350);
      };

      requestAnimationFrame(() => requestAnimationFrame(applyTransition));
    });
  }

  /** @private */
  _hideMapLayers() {
    const layersToHide = [
      { name: 'grid', layer: canvas.interface?.grid || canvas.grid },
      { name: 'drawings', layer: canvas.drawings },
      { name: 'notes', layer: canvas.notes },
      { name: 'sounds', layer: canvas.sounds },
      { name: 'templates', layer: canvas.templates },
      { name: 'controls', layer: canvas.controls },
    ];

    this._layerStates.clear();
    for (const item of layersToHide) {
      if (item.layer?.renderable) {
        this._layerStates.set(item.name, { layer: item.layer, state: item.layer.renderable });
        item.layer.renderable = false;
      }
    }
  }

  /** @private */
  _showMapLayers() {
    for (const [, data] of this._layerStates) {
      if (data.layer) data.layer.renderable = data.state;
    }
    this._layerStates.clear();
  }

  /** @private */
  _hideUiElements() {
    document.body.classList.add('map-shine-camera-path-hide-ui');
  }

  /** @private */
  _showUiElements() {
    document.body.classList.remove('map-shine-camera-path-hide-ui');
    // Legacy inline hide from earlier builds — restore if any remain.
    document.querySelectorAll('[data-msa-camera-path-prev-display]').forEach((el) => {
      el.style.display = el.dataset.msaCameraPathPrevDisplay ?? '';
      delete el.dataset.msaCameraPathPrevDisplay;
    });
  }

  /** @private */
  _resolveWallManager() {
    return window.MapShine?.wallManager
      ?? window.MapShine?.interactionManager?.wallManager
      ?? null;
  }

  /** @private */
  _hideDoorControls() {
    try {
      this._resolveWallManager()?.setDoorControlsSuppressed?.(true);
    } catch (_) {}
  }

  /** @private */
  _showDoorControls() {
    try {
      this._resolveWallManager()?.setDoorControlsSuppressed?.(false);
    } catch (_) {}
  }

  /**
   * @param {number} [durationMs=30000]
   * @returns {Promise<void>}
   */
  async hideUiTemporary(durationMs = 30000) {
    this.cancelHideUiTemporary();

    return new Promise((resolve) => {
      this._hideUiElements();

      const cleanup = () => {
        if (this._hideUiTimeoutId !== null) {
          clearTimeout(this._hideUiTimeoutId);
          this._hideUiTimeoutId = null;
        }
        if (this._hideUiEscapeListener) {
          document.removeEventListener('keydown', this._hideUiEscapeListener);
          this._hideUiEscapeListener = null;
        }
        this._showUiElements();
        resolve();
      };

      this._hideUiEscapeListener = (event) => {
        if (event.key === 'Escape') {
          ui.notifications?.info?.('UI restored.');
          cleanup();
        }
      };
      document.addEventListener('keydown', this._hideUiEscapeListener);

      this._hideUiTimeoutId = window.setTimeout(() => {
        ui.notifications?.info?.('UI restored after 30 seconds.');
        cleanup();
      }, durationMs);
    });
  }

  cancelHideUiTemporary() {
    if (this._hideUiTimeoutId !== null) {
      clearTimeout(this._hideUiTimeoutId);
      this._hideUiTimeoutId = null;
    }
    if (this._hideUiEscapeListener) {
      document.removeEventListener('keydown', this._hideUiEscapeListener);
      this._hideUiEscapeListener = null;
    }
    this._showUiElements();
  }

  /**
   * @param {CameraPathData} [data]
   * @returns {Promise<{ cancelled: boolean }>}
   */
  async startPlayback(data = null) {
    if (this._playing) {
      ui.notifications?.warn?.('Camera path playback is already running.');
      return { cancelled: false };
    }

    if (!canvas?.scene) {
      ui.notifications?.error?.('No active scene found.');
      return { cancelled: false };
    }

    const pathData = data || this.loadData();
    const points = pathData.points || {};

    if (!isValidPoint(points.A) || !isValidPoint(points.B)) {
      ui.notifications?.error?.('Cannot start animation. Points A and B are required.');
      return { cancelled: false };
    }

    const settings = normalizeSettings(pathData.settings);
    const scaleMul = this._getLetterboxScaleMultiplier(settings);
    const timeline = buildCameraTimeline(pathData, this._getTimelineBuildOptions(scaleMul));
    const timelineClips = timeline.clips;
    const easing = settings.easing === 'easeInOutCosine' ? 'easeInOutCosine' : 'trapezoidal';
    const fadeMs = Math.max(0, asNumber(settings.fadeDurationMs, 8000));
    const fadeHoldMs = Math.max(0, asNumber(settings.fadeHoldMs, 4000));
    const fadeFromBlack = settings.fadeFromBlack === true;
    const fadeToBlack = settings.fadeToBlack === true;
    const useFadeOverlay = fadeFromBlack || fadeToBlack;
    const envRamp = normalizeEnvironmentRamp(settings.environmentRamp);
    const playbackTimeScale = clampEnvironmentTimeScale(settings.playbackTimeScale ?? 1);
    const pathMotionMs = timeline.visibleMotionMs > 0
      ? timeline.visibleMotionMs
      : computeCameraPathMotionDurationMs(
        this.countSweeps(pathData),
        settings.duration,
        CAMERA_PATH_PRE_HOLD_MS,
        CAMERA_PATH_SEGMENT_HOLD_MS,
      );
    let envDriveActive = false;

    this.animator.resetCancellationState();
    const session = ++this._playbackSession;
    this._playing = true;
    this._activePlaybackSettings = settings;
    let cancelled = false;
    let endedOnBlack = false;

    const requestAbort = () => {
      cancelled = true;
      this.animator.cancel();
      this._clearPlaybackTimeScale();
      this._forceReleasePlaybackPresentation();
    };
    const isCancelled = () => cancelled || this.animator.wasCancelled;

    this._installPlaybackEscapeListener(requestAbort);

    try {
      if (useFadeOverlay) {
        this._showFadeOverlay(fadeFromBlack ? 1 : 0);
      }

      this._applyPresentation(settings);
      this._applyPlaybackTimeScale(playbackTimeScale);

      if (envRamp.enabled && !isCancelled()) {
        environmentControlApi.beginExternalDrive(ENV_DRIVE_TOKEN);
        envDriveActive = true;
        await environmentPlaybackDriver.armStart(envRamp.start);
      }

      if (fadeFromBlack && timelineClips[0] && !isCancelled()) {
        const first = timelineClips[0];
        if (first.type === 'sweep' && first.from) {
          this.animator.instantPan(first.from);
        } else if (first.view) {
          this.animator.instantPan(first.view);
        } else if (first.from) {
          this.animator.instantPan(first.from);
        }
        await this._sleepMs(fadeHoldMs, isCancelled, playbackTimeScale);
        if (!isCancelled()) {
          await this._animateFadeOverlayOpacity(0, fadeMs, isCancelled);
        }
      }

      if (envRamp.enabled && !isCancelled()) {
        environmentPlaybackDriver.startRamp(
          envRamp.start,
          envRamp.end,
          pathMotionMs,
          settings.syncToPlayers === true,
        );
      }

      if (!isCancelled()) {
        await this.animator.animateTimeline(timelineClips, {
          easing,
          preHoldMs: CAMERA_PATH_PRE_HOLD_MS,
          segmentHoldMs: CAMERA_PATH_SEGMENT_HOLD_MS,
          skipInitialPan: fadeFromBlack,
          getIsCancelled: isCancelled,
          onCancel: requestAbort,
          runFadeCutTransition: (toView, fadeMs, getClipCancelled) => (
            this._runSigLocFadeCut(toView, fadeMs, getClipCancelled)
          ),
          playbackTimeScale,
        });
      }

      cancelled = isCancelled();

      if (!cancelled && envRamp.enabled) {
        await environmentPlaybackDriver.holdEnd(envRamp.end);
      }

      if (!cancelled && fadeToBlack) {
        if (!this._fadeOverlayEl) this._showFadeOverlay(0);
        await this._animateFadeOverlayOpacity(1, fadeMs, isCancelled);
        if (!isCancelled()) {
          await this._sleepMs(fadeHoldMs, isCancelled, playbackTimeScale);
          endedOnBlack = !isCancelled();
        }
      }

      if (cancelled) {
        ui.notifications?.warn?.('Camera animation cancelled.');
      }
    } catch (err) {
      log.error('Camera path playback failed', err);
      ui.notifications?.error?.('Camera path playback failed.');
    } finally {
      this._removePlaybackEscapeListener();
      this.animator.resetCancellationState();
      this._clearPlaybackTimeScale();

      if (session !== this._playbackSession) return { cancelled };

      this._playing = false;
      this._restorePresentation();

      if (envDriveActive || envRamp.enabled) {
        this._cleanupEnvironmentPlayback({ broadcastRelease: true, settings });
      }

      this._activePlaybackSettings = null;

      if (endedOnBlack && this._fadeOverlayEl) {
        await this._animateFadeOverlayOpacity(0, fadeMs, () => false);
      }

      this._destroyFadeOverlay();
    }

    return { cancelled };
  }

  stopPlayback() {
    this.abortPlayback();
  }

  dispose() {
    this._removePlaybackEscapeListener();
    this.stopPlayback();
    this.cancelHideUiTemporary();
    this._clearPlaybackTimeScale();
    this._cleanupEnvironmentPlayback({ broadcastRelease: false });
    this._restorePresentation();
    this._purgeOrphanLetterboxDom();
    this._purgeOrphanFadeDom();
    this.animator.dispose();
  }
}
