/**
 * @fileoverview GM → player live weather/control sync over Foundry socket (flags remain authoritative).
 * @module foundry/weather-sync-bridge
 */

import { createLogger } from '../core/log.js';
import { canPersistSceneDocument, isUserGM } from '../core/gm-parity.js';
import { cloneAndSanitizeControlState, inferWeatherPanelView } from '../settings/control-state-sanitize.js';
import { weatherController as coreWeatherController } from '../core/WeatherController.js';
import { applyDirectedCustomPresetToWeather } from '../ui/weather-param-bridge.js';
import {
  applyManualFogDensityToEffect,
  readManualFogDensityFromControlState,
  syncAtmosphericFogEffectFromControlState,
} from '../ui/atmospheric-fog-bridge.js';
import { syncWeatherLightningEffectFromControlState } from '../ui/landscape-lightning-bridge.js';
import { applyAshMasterIntensity } from '../ui/ash-weather-bridge.js';
import { environmentControlApi } from '../ui/environment-control-api.js';
import { environmentFadeController } from '../ui/environment-fade-controller.js';

const log = createLogger('WeatherSyncBridge');

const MODULE_ID = 'map-shine-advanced';
const SOCKET_CHANNEL = `module.${MODULE_ID}`;

export const WEATHER_SYNC_MODE = 'weather-sync-mode';
export const WEATHER_SYNC_SNAPSHOT = 'weather-sync-snapshot';
export const WEATHER_SYNC_TRANSITION = 'weather-sync-transition';
export const WEATHER_SYNC_DYNAMIC = 'weather-sync-dynamic';
export const WEATHER_SYNC_ENVIRONMENT = 'weather-sync-environment';

const THROTTLE_MS = 90;
const ENVIRONMENT_REMOTE_DRIVE = 'weather-sync-environment';

function resolveWeatherController() {
  return window.MapShine?.weatherController ?? coreWeatherController ?? null;
}

export class WeatherSyncBridge {
  constructor() {
    /** @type {boolean} */
    this._initialized = false;
    /** @type {number} */
    this._seq = 0;
    /** @type {number} */
    this._lastSnapshotEmitAt = 0;
    /** @type {number} */
    this._lastRemoteSeqApplied = -1;
  }

  initialize() {
    if (this._initialized) return;
    this._initialized = true;
  }

  destroy() {
    this._initialized = false;
  }

  /**
   * Entry point for module socket relay (registered in module.js during init).
   * @param {object} payload
   */
  handleSocketMessage(payload) {
    this._onSocketMessage(payload);
  }

  /**
   * Apply GM control-panel state on player clients (no Control Panel UI required).
   * @param {object|null|undefined} rawControlState
   */
  applyRemoteControlState(rawControlState) {
    this._applyControlStateToPlayerRuntime(rawControlState);
  }

  /**
   * @param {object|null|undefined} controlState
   * @private
   */
  _applyControlStateToPlayerRuntime(rawControlState) {
    if (isUserGM()) return;
    if (!rawControlState || typeof rawControlState !== 'object') return;

    const controlState = cloneAndSanitizeControlState(rawControlState, { silent: true });
    if (!window.MapShine) window.MapShine = {};
    window.MapShine.remoteControlState = controlState;

    const wc = resolveWeatherController();
    if (
      wc
      && controlState.weatherMode === 'directed'
      && controlState.directedPresetId === 'Custom'
      && controlState.directedCustomPreset
    ) {
      applyDirectedCustomPresetToWeather(wc, controlState.directedCustomPreset, { syncMainTweakpane: false });
    }

    syncAtmosphericFogEffectFromControlState(controlState);
    syncWeatherLightningEffectFromControlState(controlState);
    applyManualFogDensityToEffect(readManualFogDensityFromControlState(controlState));

    try {
      wc?._updateEnvironmentOutputs?.();
    } catch (_) {}
  }

  /**
   * @param {object|null|undefined} controlState
   * @param {{ immediate?: boolean }} [opts]
   */
  emitMode(controlState, opts = {}) {
    if (!canPersistSceneDocument() || !controlState) return;
    const cs = { ...controlState };
    inferWeatherPanelView(cs);
    this._emit({
      type: WEATHER_SYNC_MODE,
      payload: {
        weatherPanelView: cs.weatherPanelView,
        weatherMode: cs.weatherMode,
        dynamicEnabled: cs.dynamicEnabled === true,
        dynamicPresetId: cs.dynamicPresetId,
        dynamicEvolutionSpeed: cs.dynamicEvolutionSpeed,
        dynamicPaused: cs.dynamicPaused === true,
      },
    }, { immediate: opts.immediate !== false });
  }

  /**
   * @param {object|null|undefined} snapshot
   * @param {{ immediate?: boolean, force?: boolean }} [opts]
   */
  emitSnapshot(snapshot, opts = {}) {
    if (!canPersistSceneDocument() || !snapshot || typeof snapshot !== 'object') return;
    const now = Date.now();
    if (!opts.force && !opts.immediate && (now - this._lastSnapshotEmitAt) < THROTTLE_MS) return;
    this._lastSnapshotEmitAt = now;
    this._emit({
      type: WEATHER_SYNC_SNAPSHOT,
      payload: snapshot,
    }, { immediate: opts.immediate === true || opts.force === true });
  }

  /**
   * @param {object|null|undefined} cmd
   */
  emitTransition(cmd) {
    if (!canPersistSceneDocument() || !cmd || typeof cmd !== 'object') return;
    this._emit({
      type: WEATHER_SYNC_TRANSITION,
      payload: cmd,
    }, { immediate: true });
  }

  /**
   * @param {object|null|undefined} dynamicState
   */
  emitDynamic(dynamicState) {
    if (!canPersistSceneDocument() || !dynamicState || typeof dynamicState !== 'object') return;
    this._emit({
      type: WEATHER_SYNC_DYNAMIC,
      payload: dynamicState,
    }, { immediate: true });
  }

  /**
   * Broadcast the start of a GM control-panel environment fade so players run the same ramp.
   * @param {object} payload
   * @param {import('../ui/environment-control-api.js').EnvironmentSnapshot} payload.startSnap
   * @param {import('../ui/environment-control-api.js').EnvironmentSnapshot} payload.endSnap
   * @param {import('../ui/environment-fade-controller.js').FadeExtras} payload.startExtras
   * @param {import('../ui/environment-fade-controller.js').FadeExtras} payload.endExtras
   * @param {number} payload.transitionMinutes
   */
  emitEnvironmentFadeStart(payload) {
    if (!canPersistSceneDocument() || !payload || typeof payload !== 'object') return;
    if (!payload.startSnap || !payload.endSnap) return;
    this._emit({
      type: WEATHER_SYNC_ENVIRONMENT,
      payload: {
        phase: 'start',
        ...payload,
      },
    }, { immediate: true });
  }

  /**
   * Broadcast the authoritative end of a GM environment fade (corrects drift / late joiners).
   * @param {object} payload
   * @param {import('../ui/environment-control-api.js').EnvironmentSnapshot} payload.endSnap
   * @param {import('../ui/environment-fade-controller.js').FadeExtras} [payload.endExtras]
   */
  emitEnvironmentFadeEnd(payload) {
    if (!canPersistSceneDocument() || !payload || typeof payload !== 'object') return;
    if (!payload.endSnap) return;
    this._emit({
      type: WEATHER_SYNC_ENVIRONMENT,
      payload: {
        phase: 'end',
        ...payload,
      },
    }, { immediate: true });
  }

  /**
   * @param {object} packet
   * @param {{ immediate?: boolean }} [opts]
   * @private
   */
  _emit(packet, opts = {}) {
    if (!canPersistSceneDocument()) return;
    try {
      this._seq += 1;
      game.socket.emit(SOCKET_CHANNEL, {
        ...packet,
        sceneId: canvas?.scene?.id ?? null,
        senderId: game?.user?.id ?? null,
        seq: this._seq,
        issuedAt: Date.now(),
        immediate: opts.immediate === true,
      });
    } catch (e) {
      log.warn('Weather sync emit failed', e);
    }
  }

  /**
   * @param {object} payload
   * @private
   */
  _onSocketMessage(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (isUserGM()) return;

    const type = payload.type;
    if (
      type !== WEATHER_SYNC_MODE
      && type !== WEATHER_SYNC_SNAPSHOT
      && type !== WEATHER_SYNC_TRANSITION
      && type !== WEATHER_SYNC_DYNAMIC
      && type !== WEATHER_SYNC_ENVIRONMENT
    ) {
      return;
    }

    const sceneId = canvas?.scene?.id;
    if (payload.sceneId != null && sceneId != null && payload.sceneId !== sceneId) return;

    const senderId = typeof payload.senderId === 'string' ? payload.senderId : null;
    if (senderId && senderId === game?.user?.id) return;

    const seq = Number(payload.seq);
    if (Number.isFinite(seq) && seq <= this._lastRemoteSeqApplied) return;
    if (Number.isFinite(seq)) this._lastRemoteSeqApplied = seq;

    try {
      if (type === WEATHER_SYNC_MODE) {
        this._applyModePacket(payload.payload);
      } else if (type === WEATHER_SYNC_SNAPSHOT) {
        void this._applySnapshotPacket(payload.payload);
      } else if (type === WEATHER_SYNC_TRANSITION) {
        this._applyTransitionPacket(payload.payload);
      } else if (type === WEATHER_SYNC_DYNAMIC) {
        this._applyDynamicPacket(payload.payload);
      } else if (type === WEATHER_SYNC_ENVIRONMENT) {
        void this._applyEnvironmentFadePacket(payload.payload);
      }
    } catch (e) {
      log.warn('Weather sync apply failed', e);
    }
  }

  /**
   * @param {object|null|undefined} payload
   * @private
   */
  async _applyEnvironmentFadePacket(payload) {
    if (!payload || typeof payload !== 'object') return;

    if (payload.phase === 'start') {
      await this._applyEnvironmentFadeStart(payload);
      return;
    }

    if (payload.phase === 'end') {
      await this._applyEnvironmentFadeEnd(payload);
    }
  }

  /**
   * @param {object} payload
   * @private
   */
  async _applyEnvironmentFadeStart(payload) {
    const startSnap = payload.startSnap;
    const endSnap = payload.endSnap;
    const startExtras = payload.startExtras ?? { ashIntensity: 0, gustinessIndex: 2 };
    const endExtras = payload.endExtras ?? startExtras;
    const transitionMinutes = Number(payload.transitionMinutes) || 0;

    if (!startSnap || !endSnap) return;

    try {
      environmentFadeController.cancel();
      await environmentControlApi.beginExternalDrive(ENVIRONMENT_REMOTE_DRIVE);

      await environmentFadeController.start(
        startSnap,
        endSnap,
        startExtras,
        endExtras,
        transitionMinutes,
        {
          applyExtras: async (extras) => {
            if (Number.isFinite(extras?.ashIntensity)) {
              applyAshMasterIntensity(extras.ashIntensity, { syncMainTweakpane: false });
            }
          },
        },
      );
    } catch (e) {
      log.warn('Remote environment fade start failed', e);
      try {
        environmentControlApi.endExternalDrive(ENVIRONMENT_REMOTE_DRIVE, { restore: true });
      } catch (_) {}
    }
  }

  /**
   * @param {object} payload
   * @private
   */
  async _applyEnvironmentFadeEnd(payload) {
    const endSnap = payload.endSnap;
    const endExtras = payload.endExtras ?? { ashIntensity: 0, gustinessIndex: 2 };
    if (!endSnap) return;

    try {
      environmentFadeController.cancel();
      await environmentControlApi.applySnapshot(endSnap, {
        persist: false,
        syncUi: false,
        applyDarkness: true,
        syncFoundryTime: false,
      });
      if (Number.isFinite(endExtras?.ashIntensity)) {
        applyAshMasterIntensity(endExtras.ashIntensity, { syncMainTweakpane: false });
      }
      if (Number.isFinite(endSnap.timeOfDay)) {
        this._mirrorRemoteTimeOfDay(endSnap.timeOfDay);
      }
      try {
        resolveWeatherController()?._updateEnvironmentOutputs?.();
      } catch (_) {}
    } catch (e) {
      log.warn('Remote environment fade end failed', e);
    } finally {
      try {
        environmentControlApi.endExternalDrive(ENVIRONMENT_REMOTE_DRIVE, { restore: false });
      } catch (_) {}
    }
  }

  /**
   * @param {number} hour
   * @private
   */
  _mirrorRemoteTimeOfDay(hour) {
    if (!Number.isFinite(Number(hour))) return;
    const clamped = ((Number(hour) % 24) + 24) % 24;
    if (!window.MapShine) window.MapShine = {};
    if (!window.MapShine.remoteControlState || typeof window.MapShine.remoteControlState !== 'object') {
      window.MapShine.remoteControlState = {};
    }
    window.MapShine.remoteControlState.timeOfDay = clamped;
  }

  /**
   * @param {object|null|undefined} modePayload
   * @private
   */
  _applyModePacket(modePayload) {
    if (!modePayload || typeof modePayload !== 'object') return;

    const wc = resolveWeatherController();
    const cp = window.MapShine?.controlPanel;

    if (cp?.controlState && typeof cp.controlState === 'object') {
      Object.assign(cp.controlState, modePayload);
      inferWeatherPanelView(cp.controlState);
      cp._ensureDirectedCustomPreset?.();
    }

    const merged = {
      ...(window.MapShine?.remoteControlState ?? {}),
      ...(cp?.controlState ?? {}),
      ...modePayload,
    };
    this._applyControlStateToPlayerRuntime(merged);

    if (wc) {
      if (typeof modePayload.dynamicEnabled === 'boolean') {
        if (typeof wc.setDynamicEnabled === 'function') wc.setDynamicEnabled(modePayload.dynamicEnabled);
        else wc.dynamicEnabled = modePayload.dynamicEnabled;
      }
      if (typeof modePayload.dynamicPresetId === 'string' && modePayload.dynamicPresetId) {
        if (typeof wc.setDynamicPreset === 'function') wc.setDynamicPreset(modePayload.dynamicPresetId);
        else wc.dynamicPresetId = modePayload.dynamicPresetId;
      }
      if (Number.isFinite(modePayload.dynamicEvolutionSpeed)) {
        if (typeof wc.setDynamicEvolutionSpeed === 'function') {
          wc.setDynamicEvolutionSpeed(modePayload.dynamicEvolutionSpeed);
        } else {
          wc.dynamicEvolutionSpeed = modePayload.dynamicEvolutionSpeed;
        }
      }
      if (typeof modePayload.dynamicPaused === 'boolean') {
        if (typeof wc.setDynamicPaused === 'function') wc.setDynamicPaused(modePayload.dynamicPaused);
        else wc.dynamicPaused = modePayload.dynamicPaused;
      }
    }

    this._refreshControlPanelFromRemote();
  }

  /**
   * @param {object|null|undefined} snapshot
   * @private
   */
  async _applySnapshotPacket(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;

    const wc = resolveWeatherController();
    if (!wc) return;

    if (snapshot.controlState && typeof snapshot.controlState === 'object') {
      const cp = window.MapShine?.controlPanel;
      if (cp?.controlState) {
        Object.assign(cp.controlState, snapshot.controlState);
        inferWeatherPanelView(cp.controlState);
        cp._ensureDirectedCustomPreset?.();
      }
      this._applyControlStateToPlayerRuntime(snapshot.controlState);
    }

    if (typeof snapshot.enabled === 'boolean') wc.enabled = snapshot.enabled;
    if (typeof snapshot.dynamicEnabled === 'boolean') {
      if (typeof wc.setDynamicEnabled === 'function') wc.setDynamicEnabled(snapshot.dynamicEnabled);
      else wc.dynamicEnabled = snapshot.dynamicEnabled;
    }
    if (typeof snapshot.dynamicPresetId === 'string' && snapshot.dynamicPresetId) {
      if (typeof wc.setDynamicPreset === 'function') wc.setDynamicPreset(snapshot.dynamicPresetId);
      else wc.dynamicPresetId = snapshot.dynamicPresetId;
    }
    if (Number.isFinite(snapshot.dynamicEvolutionSpeed)) {
      if (typeof wc.setDynamicEvolutionSpeed === 'function') {
        wc.setDynamicEvolutionSpeed(snapshot.dynamicEvolutionSpeed);
      } else {
        wc.dynamicEvolutionSpeed = snapshot.dynamicEvolutionSpeed;
      }
    }
    if (typeof snapshot.dynamicPaused === 'boolean') {
      if (typeof wc.setDynamicPaused === 'function') wc.setDynamicPaused(snapshot.dynamicPaused);
      else wc.dynamicPaused = snapshot.dynamicPaused;
    }

    if (snapshot.start && snapshot.current && snapshot.target) {
      wc._applySerializedWeatherState?.(snapshot.start, wc.startState);
      wc._applySerializedWeatherState?.(snapshot.current, wc.currentState);
      wc._applySerializedWeatherState?.(snapshot.target, wc.targetState);
    }

    wc.isTransitioning = snapshot.isTransitioning === true;
    wc.transitionDuration = Number(snapshot.transitionDuration) || 0;
    wc.transitionElapsed = Number(snapshot.transitionElapsed) || 0;

    if (Number.isFinite(snapshot.timeOfDay)) {
      const mins = Number(snapshot.timeTransitionMinutes) || 0;
      const instant = snapshot.syncTimeInstant === true
        || snapshot.environmentFadeComplete === true
        || mins <= 0;
      const wcHour = wc?.getCurrentTime?.() ?? wc?.timeOfDay;
      const targetHour = ((Number(snapshot.timeOfDay) % 24) + 24) % 24;
      const currentHour = Number.isFinite(Number(wcHour))
        ? ((Number(wcHour) % 24) + 24) % 24
        : Number.NaN;
      const atTarget = Number.isFinite(currentHour)
        && Math.abs(currentHour - targetHour) < 0.05;
      const stateApplier = window.MapShine?.stateApplier;
      if (stateApplier) {
        if (!instant && mins > 0 && !environmentFadeController.isRunning && !atTarget) {
          await stateApplier.startTimeOfDayTransition(snapshot.timeOfDay, mins, false, true);
        } else {
          await stateApplier.applyTimeOfDay(snapshot.timeOfDay, false, true);
        }
      } else if (typeof wc.setTime === 'function') {
        wc.setTime(snapshot.timeOfDay);
      } else if (typeof wc.setTimeOfDay === 'function') {
        wc.setTimeOfDay(snapshot.timeOfDay);
      }
      this._mirrorRemoteTimeOfDay(snapshot.timeOfDay);
    }

    try {
      wc?._updateEnvironmentOutputs?.();
    } catch (_) {}

    this._refreshControlPanelFromRemote();
  }

  /**
   * @param {object|null|undefined} cmd
   * @private
   */
  _applyTransitionPacket(cmd) {
    const wc = resolveWeatherController();
    wc?.applyTransitionCommand?.(cmd);
    this._refreshControlPanelFromRemote();
  }

  /**
   * @param {object|null|undefined} dynamicState
   * @private
   */
  _applyDynamicPacket(dynamicState) {
    const wc = resolveWeatherController();
    if (!wc || !dynamicState || typeof dynamicState !== 'object') return;

    if (typeof dynamicState.enabled === 'boolean') {
      if (typeof wc.setDynamicEnabled === 'function') wc.setDynamicEnabled(dynamicState.enabled);
      else wc.dynamicEnabled = dynamicState.enabled;
    }
    if (typeof dynamicState.presetId === 'string' && dynamicState.presetId) {
      if (typeof wc.setDynamicPreset === 'function') wc.setDynamicPreset(dynamicState.presetId);
      else wc.dynamicPresetId = dynamicState.presetId;
    }
    if (Number.isFinite(dynamicState.evolutionSpeed)) {
      if (typeof wc.setDynamicEvolutionSpeed === 'function') {
        wc.setDynamicEvolutionSpeed(dynamicState.evolutionSpeed);
      } else {
        wc.dynamicEvolutionSpeed = dynamicState.evolutionSpeed;
      }
    }
    if (typeof dynamicState.paused === 'boolean') {
      if (typeof wc.setDynamicPaused === 'function') wc.setDynamicPaused(dynamicState.paused);
      else wc.dynamicPaused = dynamicState.paused;
    }
    if (Number.isFinite(dynamicState.planDurationSeconds)) {
      wc.dynamicPlanDurationSeconds = dynamicState.planDurationSeconds;
    }
    if (typeof dynamicState.boundsEnabled === 'boolean') {
      wc.dynamicBoundsEnabled = dynamicState.boundsEnabled;
    }
    if (dynamicState.bounds && typeof dynamicState.bounds === 'object') {
      wc._dynamicBounds = { ...dynamicState.bounds };
    }
    if (Number.isFinite(dynamicState.seed)) {
      wc._dynamicSeed = dynamicState.seed >>> 0;
    }
    if (Number.isFinite(dynamicState.rngState)) {
      wc._dynamicRngState = dynamicState.rngState >>> 0;
    }
    if (dynamicState.latent && typeof dynamicState.latent === 'object') {
      wc._dynamicLatent = { ...wc._dynamicLatent, ...dynamicState.latent };
    }

    this._refreshControlPanelFromRemote();
  }

  /** @private */
  _refreshControlPanelFromRemote() {
    const cp = window.MapShine?.controlPanel;
    if (!cp) return;
    safeCall(() => {
      inferWeatherPanelView(cp.controlState);
      cp._applyWeatherPanelViewVisibility?.();
      cp._mirrorAllDomFromState?.();
      cp.syncManualFogDomFromControlState?.();
      cp.pane?.refresh?.();
    });
  }
}

function safeCall(fn) {
  try { fn(); } catch (_) {}
}

/** @type {WeatherSyncBridge|null} */
let _bridge = null;

/**
 * @returns {WeatherSyncBridge}
 */
export function getWeatherSyncBridge() {
  if (!_bridge) {
    _bridge = new WeatherSyncBridge();
  }
  return _bridge;
}
