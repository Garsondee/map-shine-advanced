/**
 * @fileoverview Cinematic and advanced camera manager.
 *
 * This manager owns optional improved camera mode runtime behavior:
 * - cinematic session state
 * - player follow lock + local opt-out/rejoin
 * - letterbox + UI fade
 * - player fog-bounded pan/zoom constraints
 * - focus tools
 * - group cohesion force (soft camera attraction)
 * - future camera impulse API foundation
 *
 * @module foundry/cinematic-camera-manager
 */
import { canPersistSceneDocument, isUserGM } from '../core/gm-parity.js';
import { extendMsaLocalFlagWriteGuard } from '../utils/msa-local-flag-guard.js';

import { createLogger } from '../core/log.js';

const log = createLogger('CinematicCamera');

const MODULE_ID = 'map-shine-advanced';
const SCENE_FLAG_KEY = 'advancedCameraState';
const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const CAMERA_SOCKET_TYPE = 'advanced-camera-pan';
const ENVIRONMENT_SOCKET_TYPE = 'advanced-camera-environment';
const ENVIRONMENT_RELEASE_SOCKET_TYPE = 'advanced-camera-environment-release';

/** Hold after player UI hide before letterbox bars rise. */
const CINEMATIC_UI_HOLD_MS = 2000;
/** Fade-to-black and letterbox motion duration (minimum transition length). */
const CINEMATIC_CURTAIN_MS = 5000;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function asNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** @param {number} value */
function normalizeBarHeightPct(value) {
  let n = asNumber(value, 0.12);
  // Legacy scene flags sometimes stored whole percent (12) instead of fraction (0.12).
  if (n > 1) n = n / 100;
  return clamp(n, 0.03, 0.35);
}

function getChangedFlag(changed, scope, key) {
  try {
    const path = `flags.${scope}.${key}`;
    if (foundry?.utils?.getProperty) return foundry.utils.getProperty(changed, path);
  } catch (_) {
  }

  try {
    return changed?.flags?.[scope]?.[key];
  } catch (_) {
    return undefined;
  }
}

export class CinematicCameraManager {
  constructor({ pixiInputBridge = null, sceneComposer = null } = {}) {
    this.pixiInputBridge = pixiInputBridge;
    this.sceneComposer = sceneComposer;

    this.sceneState = this._createDefaultSceneState();

    this.playerOptOut = false;

    this._initialized = false;
    this._listeners = new Set();

    this._overlayRoot = null;
    this._topBar = null;
    this._bottomBar = null;
    this._playerToggleButton = null;
    this._gmBanner = null;
    this._gmToggleButton = null;
    this._gmToggleDefaultLabel = 'Cinematic Mode';
    this._gmToggleHoverLabel = 'End Cinematic Mode';
    this._letterboxAnimToken = 0;
    this._fadeOverlay = null;
    /** @type {'idle'|'entering'|'active'|'exiting'} */
    this._presentationPhase = 'idle';
    this._presentationToken = 0;
    /** @type {number[]} */
    this._presentationTimers = [];
    /** While true, remote follow and camera broadcasts stay behind the black curtain. */
    this._cameraCurtainClosed = false;
    this._suppressPresentation = false;

    this._hookIds = [];

    this._lastManualInputAt = 0;
    this._lastBroadcastAt = 0;
    this._broadcastMinIntervalMs = 75;
    this._broadcastDeadbandWorld = 2;
    this._broadcastDeadbandScale = 0.002;
    this._lastBroadcastView = null;
    this._remoteSeq = 0;
    this._lastRemoteSeqApplied = -1;
    this._lastRemotePacketAt = 0;
    this._remoteSenderId = null;
    this._isApplyingRemotePan = false;
    this._isApplyingConstraintPan = false;
    this._isApplyingCohesionPan = false;
    this._remotePanTarget = null;
    this._remotePanSmoothingHz = 18;
    this._remotePanEpsilonWorld = 0.15;
    this._remotePanEpsilonScale = 0.0005;

    /** @type {number} */
    this._envRemoteSeq = 0;

    /** @type {import('../ui/environment-control-api.js').EnvironmentSnapshot|null} */
    this._playerPreEnvSnapshot = null;

    /** @type {string|null} */
    this._envRemoteSenderId = null;

    /** @type {number} */
    this._lastEnvRemoteSeqApplied = -1;

    this._boundsCache = null;
    this._boundsCacheMs = 500;
    this._persistTimeout = null;
    this._lastImpulse = null;

    this._lastExternalUpdateAt = 0;

    /** @type {number} */
    this._temporaryRuntimeSuspendCount = 0;

    /** EffectComposer camera pipeline: remote follow / cohesion before CameraFollower. */
    this.updatePhase = 'camera';
    this.cameraPipelineOrder = 2;
  }

  _createDefaultSceneState() {
    return {
      improvedModeEnabled: false,
      cinematicActive: false,
      lockPlayers: false,
      strictFollow: false,
      letterboxEnabled: false,
      uiFade: 0.92,
      barHeightPct: 0.12,
      transitionMs: CINEMATIC_CURTAIN_MS,

      playerBoundsEnabled: false,
      playerBoundsPadding: 220,
      playerBoundsSampleDivisions: 16,

      cohesionEnabled: false,
      cohesionStrength: 0.08,
      cohesionAutoFit: true,
      cohesionPadding: 220,

      localInputSmoothingEnabled: true,
      localPanSmoothingHz: 14,
      localZoomSmoothingHz: 10,
    };
  }

  setDependencies({ pixiInputBridge = null, sceneComposer = null } = {}) {
    const previousBridge = this.pixiInputBridge;
    if (this._initialized && previousBridge && previousBridge !== pixiInputBridge) {
      this._unbindInputBridgeFrom(previousBridge);
    }

    this.pixiInputBridge = pixiInputBridge;
    this.sceneComposer = sceneComposer;

    if (this._initialized) {
      this._bindInputBridge();
    }
  }

  initialize(parentElement = document.body) {
    if (this._initialized) return;

    this._loadPlayerLocalState();
    this._ensureOverlayDom(parentElement);
    this._registerHooks();
    this._bindInputBridge();
    this._hydrateFromSceneFlag();

    this._initialized = true;
    this._applyVisualState();
    this._emitStateChanged();

    log.info('CinematicCameraManager initialized');
  }

  dispose() {
    if (!this._initialized) return;

    this._unbindInputBridge();

    for (const [name, id] of this._hookIds) {
      try {
        Hooks.off(name, id);
      } catch (_) {
      }
    }
    this._hookIds.length = 0;

    if (this._persistTimeout !== null) {
      clearTimeout(this._persistTimeout);
      this._persistTimeout = null;
    }

    this._cancelPresentation();

    try {
      this._fadeOverlay?.remove();
    } catch (_) {
    }
    this._fadeOverlay = null;

    try {
      this._overlayRoot?.remove();
    } catch (_) {
    }

    this._overlayRoot = null;
    this._topBar = null;
    this._bottomBar = null;
    this._playerToggleButton = null;
    this._gmBanner = null;
    this._gmToggleButton = null;
    this._listeners.clear();

    try {
      document.body.classList.remove('map-shine-cinematic-player-hide-ui');
    } catch (_) {}

    this._lastBroadcastView = null;
    this._isApplyingRemotePan = false;
    this._isApplyingConstraintPan = false;
    this._isApplyingCohesionPan = false;
    this._resetRemoteFollowState({ clearTarget: true });

    const uiRoot = document.getElementById('ui');
    if (uiRoot) {
      uiRoot.classList.remove('map-shine-cinematic-ui-fade-active');
      uiRoot.style.removeProperty('--map-shine-cinematic-ui-opacity');
      uiRoot.style.removeProperty('--map-shine-cinematic-transition-ms');
    }

    this._initialized = false;

    log.info('CinematicCameraManager disposed');
  }

  onStateChange(callback) {
    if (typeof callback !== 'function') return () => {};
    this._listeners.add(callback);
    return () => this._listeners.delete(callback);
  }

  _emitStateChanged() {
    const snapshot = this.getState();
    for (const cb of this._listeners) {
      try {
        cb(snapshot);
      } catch (e) {
        log.warn('State listener failed', e);
      }
    }
  }

  getState() {
    return {
      ...this.sceneState,
      playerOptOut: this.playerOptOut,
      isPlayerFollowLocked: this._isPlayerFollowLocked(),
      lastImpulse: this._lastImpulse,
    };
  }

  _getLocalStorageKey() {
    const sceneId = canvas?.scene?.id || 'no-scene';
    const userId = game?.user?.id || 'no-user';
    return `${MODULE_ID}.camera.local.${sceneId}.${userId}`;
  }

  _loadPlayerLocalState() {
    try {
      const raw = localStorage.getItem(this._getLocalStorageKey());
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.playerOptOut = parsed.playerOptOut === true;
      }
    } catch (_) {
    }
  }

  _savePlayerLocalState() {
    try {
      localStorage.setItem(this._getLocalStorageKey(), JSON.stringify({
        playerOptOut: this.playerOptOut === true,
      }));
    } catch (_) {
    }
  }

  _ensureOverlayDom(parentElement) {
    if (this._overlayRoot) return;

    const root = document.createElement('div');
    root.id = 'map-shine-cinematic-root';
    root.className = 'map-shine-cinematic-root';
    root.style.setProperty('--map-shine-cinematic-transition-ms', `${this.sceneState.transitionMs}ms`);
    root.style.setProperty('--map-shine-cinematic-bar-height', `${this.sceneState.barHeightPct * 100}%`);

    const topBar = document.createElement('div');
    topBar.className = 'map-shine-cinematic-bar map-shine-cinematic-bar--top';

    const bottomBar = document.createElement('div');
    bottomBar.className = 'map-shine-cinematic-bar map-shine-cinematic-bar--bottom';

    const playerToggle = document.createElement('button');
    playerToggle.type = 'button';
    playerToggle.className = 'map-shine-cinematic-toggle map-shine-overlay-ui';
    playerToggle.textContent = 'Exit Cinematic View';
    playerToggle.addEventListener('click', () => {
      if (this.sceneState.strictFollow && !isUserGM()) {
        ui.notifications?.warn?.('GM has enabled strict cinematic follow.');
        return;
      }
      this.toggleLocalCinematicView();
    });

    const gmBanner = document.createElement('div');
    gmBanner.className = 'map-shine-cinematic-gm-banner map-shine-overlay-ui';
    gmBanner.innerHTML = `
      <strong>Cinematic mode is active for players.</strong>
      <span>Their UI is hidden and cameras follow yours.</span>
      <span>End cinematic mode to return control.</span>
    `;

    const gmToggle = document.createElement('button');
    gmToggle.type = 'button';
    gmToggle.className = 'map-shine-cinematic-gm-toggle map-shine-overlay-ui';
    gmToggle.textContent = this._gmToggleDefaultLabel;
    gmToggle.addEventListener('click', () => {
      if (!isUserGM()) return;
      this.endCinematic();
    });
    gmToggle.addEventListener('mouseenter', () => {
      if (this.sceneState.cinematicActive) {
        gmToggle.textContent = this._gmToggleHoverLabel;
      }
    });
    gmToggle.addEventListener('mouseleave', () => {
      if (this.sceneState.cinematicActive) {
        gmToggle.textContent = this._gmToggleDefaultLabel;
      }
    });

    root.appendChild(topBar);
    root.appendChild(bottomBar);
    root.appendChild(playerToggle);
    root.appendChild(gmBanner);
    root.appendChild(gmToggle);

    const fade = document.createElement('div');
    fade.className = 'map-shine-cinematic-fade map-shine-overlay-ui';
    fade.style.opacity = '0';

    parentElement.appendChild(root);
    parentElement.appendChild(fade);

    this._overlayRoot = root;
    this._fadeOverlay = fade;
    this._topBar = topBar;
    this._bottomBar = bottomBar;
    this._playerToggleButton = playerToggle;
    this._gmBanner = gmBanner;
    this._gmToggleButton = gmToggle;
  }

  _registerHooks() {
    const addHook = (name, fn) => {
      const id = Hooks.on(name, fn);
      this._hookIds.push([name, id]);
    };

    addHook('canvasPan', (_canvas, position) => {
      const isInternalPan = this._isApplyingRemotePan || this._isApplyingConstraintPan || this._isApplyingCohesionPan;
      if (!isUserGM() && !isInternalPan) {
        this._lastManualInputAt = Date.now();
      }

      if (this._shouldBroadcastCameraState()) {
        this._broadcastCameraState(position);
      }

      if (!isInternalPan) {
        this._enforcePanBounds(position);
      }
    });

    addHook('updateScene', (scene, changed) => {
      if (scene?.id !== canvas?.scene?.id) return;
      const next = getChangedFlag(changed, MODULE_ID, SCENE_FLAG_KEY);
      if (!next || typeof next !== 'object') return;
      this._applySceneStatePatch(next, { persist: false });
    });

    addHook('canvasReady', () => {
      this._loadPlayerLocalState();
      this._hydrateFromSceneFlag();
      this._invalidatePlayerBounds();
      this._resetRemoteFollowState({ clearTarget: true });
      this._lastBroadcastView = null;
    });

    addHook('controlToken', () => {
      this._invalidatePlayerBounds();
    });

    addHook('updateToken', () => {
      this._invalidatePlayerBounds();
    });

    addHook('createToken', () => {
      this._invalidatePlayerBounds();
    });

    addHook('deleteToken', () => {
      this._invalidatePlayerBounds();
    });
  }

  /**
   * Entry point for module socket relay (registered in module.js during init).
   * @param {object} payload
   */
  handleSocketMessage(payload) {
    this._onSocketMessage(payload);
  }

  _bindInputBridge() {
    if (!this.pixiInputBridge) return;

    this.pixiInputBridge.setInputBlocker(() => this.shouldBlockLocalCameraInput());
    this.pixiInputBridge.setViewConstraintProvider((view) => this.constrainView(view));
    this.pixiInputBridge.setMotionSmoothingProvider(() => this._getLocalInputSmoothingConfig());
    this.pixiInputBridge.setUserInputCallback(() => {
      this._lastManualInputAt = Date.now();
    });
  }

  _unbindInputBridgeFrom(bridge) {
    if (!bridge) return;
    bridge.setInputBlocker(null);
    bridge.setViewConstraintProvider(null);
    bridge.setMotionSmoothingProvider?.(null);
    bridge.setUserInputCallback(null);
  }

  _getLocalInputSmoothingConfig() {
    const enabledByMode = this.sceneState.improvedModeEnabled === true;
    const enabledBySetting = this.sceneState.localInputSmoothingEnabled !== false;
    const enabled = enabledByMode && enabledBySetting && !this.shouldBlockLocalCameraInput();

    return {
      enabled,
      panHz: clamp(asNumber(this.sceneState.localPanSmoothingHz, 14), 1, 80),
      zoomHz: clamp(asNumber(this.sceneState.localZoomSmoothingHz, 10), 1, 80),
    };
  }

  _unbindInputBridge() {
    if (!this.pixiInputBridge) return;
    this._unbindInputBridgeFrom(this.pixiInputBridge);
  }

  _resetRemoteFollowState({ clearTarget = true } = {}) {
    this._lastRemoteSeqApplied = -1;
    this._lastRemotePacketAt = 0;
    this._remoteSenderId = null;
    if (clearTarget) this._remotePanTarget = null;
  }

  /**
   * @returns {import('./camera-animator.js').CameraAnimator|null}
   * @private
   */
  _getCameraAnimator() {
    const animator = window.MapShine?.cameraPathService?.animator;
    return animator && typeof animator.animateTo === 'function' ? animator : null;
  }

  /**
   * Pan/zoom via compositor-driven CameraAnimator (stays in phase with Three render).
   *
   * @param {{x:number, y:number, scale?:number}} view
   * @param {number} durationMs
   * @returns {Promise<void>}
   * @private
   */
  async _animateViewTo(view, durationMs) {
    const dur = clamp(asNumber(durationMs, 350), 50, 5000);
    const animator = this._getCameraAnimator();
    const current = animator?.captureCurrentView?.()
      || {
        x: asNumber(canvas?.stage?.pivot?.x, 0),
        y: asNumber(canvas?.stage?.pivot?.y, 0),
        scale: asNumber(canvas?.stage?.scale?.x, 1),
      };

    const target = {
      x: asNumber(view.x, current.x),
      y: asNumber(view.y, current.y),
      scale: Number.isFinite(view.scale) ? view.scale : current.scale,
    };

    try {
      window.MapShine?.renderLoop?.requestContinuousRender?.(dur + 250);
    } catch (_) {}

    if (!animator) {
      try {
        canvas?.pan?.({ x: target.x, y: target.y, scale: target.scale, duration: 0 });
      } catch (_) {}
      return;
    }

    await animator.animateTo({
      x: target.x,
      y: target.y,
      scale: target.scale,
      durationMs: dur,
      easing: 'easeInOutCosine',
    });
  }

  _hasMeaningfulViewDelta(a, b) {
    if (!a || !b) return false;
    return Math.abs(asNumber(a.x, 0) - asNumber(b.x, 0)) > 0.1
      || Math.abs(asNumber(a.y, 0) - asNumber(b.y, 0)) > 0.1
      || Math.abs(asNumber(a.scale, 1) - asNumber(b.scale, 1)) > 0.0005;
  }

  _enforcePanBounds(position) {
    if (this.isRuntimeTemporarilySuspended()) return;
    if (!this.sceneState.improvedModeEnabled) return;
    if (!this.sceneState.playerBoundsEnabled) return;
    if (isUserGM()) return;
    if (this._isPlayerFollowLocked()) return;
    if (this._isApplyingConstraintPan) return;

    const currentView = {
      x: asNumber(position?.x, canvas?.stage?.pivot?.x),
      y: asNumber(position?.y, canvas?.stage?.pivot?.y),
      scale: asNumber(position?.scale, canvas?.stage?.scale?.x),
    };

    if (!Number.isFinite(currentView.x) || !Number.isFinite(currentView.y) || !Number.isFinite(currentView.scale)) return;

    const constrained = this.constrainView(currentView);
    if (!constrained || !this._hasMeaningfulViewDelta(currentView, constrained)) return;

    this._isApplyingConstraintPan = true;
    try {
      canvas?.pan?.({ x: constrained.x, y: constrained.y, scale: constrained.scale, duration: 0 });
    } catch (e) {
      log.warn('Failed to enforce constrained camera bounds', e);
    } finally {
      this._isApplyingConstraintPan = false;
    }
  }

  _hydrateFromSceneFlag() {
    this._suppressPresentation = true;
    try {
      const flag = canvas?.scene?.getFlag?.(MODULE_ID, SCENE_FLAG_KEY);
      if (flag && typeof flag === 'object') {
        this._applySceneStatePatch(flag, { persist: false });
        if (this.sceneState.cinematicActive) {
          this._presentationPhase = 'active';
          this._cameraCurtainClosed = false;
          this._applyVisualState();
        }
      } else {
        this._applyVisualState();
        this._emitStateChanged();
      }
    } finally {
      this._suppressPresentation = false;
    }
  }

  _schedulePersistSceneState() {
    if (!canPersistSceneDocument()) return;

    if (this._persistTimeout !== null) clearTimeout(this._persistTimeout);
    this._persistTimeout = setTimeout(async () => {
      this._persistTimeout = null;
      try {
        const scene = canvas?.scene;
        if (!scene) return;
        extendMsaLocalFlagWriteGuard();
        await scene.setFlag(MODULE_ID, SCENE_FLAG_KEY, { ...this.sceneState });
      } catch (e) {
        log.warn('Failed to persist camera scene state', e);
      }
    }, 120);
  }

  _applySceneStatePatch(patch, { persist = true } = {}) {
    if (!patch || typeof patch !== 'object') return;

    const wasCinematicActive = this.sceneState.cinematicActive === true;
    const wasFollowing = this._isPlayerFollowLocked();
    const wasBroadcasting = this._shouldBroadcastCameraState();

    this.sceneState = {
      ...this.sceneState,
      ...patch,
    };

    this.sceneState.improvedModeEnabled = this.sceneState.improvedModeEnabled === true;
    this.sceneState.cinematicActive = this.sceneState.cinematicActive === true;
    this.sceneState.lockPlayers = this.sceneState.lockPlayers === true;
    this.sceneState.strictFollow = this.sceneState.strictFollow === true;
    this.sceneState.letterboxEnabled = this.sceneState.letterboxEnabled === true;
    if (!this.sceneState.cinematicActive) {
      this.sceneState.letterboxEnabled = false;
    }
    this.sceneState.playerBoundsEnabled = this.sceneState.playerBoundsEnabled === true;
    this.sceneState.cohesionEnabled = this.sceneState.cohesionEnabled === true;
    this.sceneState.cohesionAutoFit = this.sceneState.cohesionAutoFit === true;
    this.sceneState.localInputSmoothingEnabled = this.sceneState.localInputSmoothingEnabled !== false;

    this.sceneState.uiFade = clamp(asNumber(this.sceneState.uiFade, 0.92), 0, 1);
    this.sceneState.barHeightPct = normalizeBarHeightPct(this.sceneState.barHeightPct);
    this.sceneState.transitionMs = clamp(asNumber(this.sceneState.transitionMs, CINEMATIC_CURTAIN_MS), CINEMATIC_CURTAIN_MS, 10000);
    this.sceneState.playerBoundsPadding = clamp(asNumber(this.sceneState.playerBoundsPadding, 220), 0, 2000);
    this.sceneState.playerBoundsSampleDivisions = clamp(Math.round(asNumber(this.sceneState.playerBoundsSampleDivisions, 16)), 6, 80);
    this.sceneState.cohesionStrength = clamp(asNumber(this.sceneState.cohesionStrength, 0.08), 0, 1);
    this.sceneState.cohesionPadding = clamp(asNumber(this.sceneState.cohesionPadding, 220), 0, 2000);
    this.sceneState.localPanSmoothingHz = clamp(asNumber(this.sceneState.localPanSmoothingHz, 14), 1, 80);
    this.sceneState.localZoomSmoothingHz = clamp(asNumber(this.sceneState.localZoomSmoothingHz, 10), 1, 80);

    const nowCinematicActive = this.sceneState.cinematicActive === true;
    const cinematicToggledOn = !wasCinematicActive && nowCinematicActive;
    const cinematicToggledOff = wasCinematicActive && !nowCinematicActive;

    if (cinematicToggledOn && !isUserGM()) {
      this.playerOptOut = false;
      this._savePlayerLocalState();
    }

    this._invalidatePlayerBounds();

    if (this._suppressPresentation) {
      this._applyVisualState();
    } else if (cinematicToggledOn) {
      this._runEnterPresentation();
    } else if (cinematicToggledOff) {
      this._runExitPresentation();
    } else if (this._presentationPhase === 'idle' || this._presentationPhase === 'active') {
      this._applyVisualState();
    }

    this._emitStateChanged();

    const isFollowing = this._isPlayerFollowLocked();
    const isBroadcasting = this._shouldBroadcastCameraState();

    if (!isFollowing) {
      const keepPendingGmView = this.sceneState.cinematicActive === true && this.sceneState.lockPlayers === true;
      if (!keepPendingGmView) {
        this._resetRemoteFollowState({ clearTarget: true });
      }
    } else if (!wasFollowing && isFollowing && this._remotePanTarget) {
      this._tickRemoteFollow();
    }

    if (isUserGM() && !this._cameraCurtainClosed) {
      const shouldForceSnap = (!wasBroadcasting && isBroadcasting) || (!wasFollowing && isFollowing);
      if (shouldForceSnap) {
        this._broadcastCameraState(null, { force: true });
      }
    }
    if (wasBroadcasting && !isBroadcasting) {
      this._lastBroadcastView = null;
    }

    if (persist) this._schedulePersistSceneState();
  }

  _cancelPresentation() {
    this._presentationToken += 1;
    for (const id of this._presentationTimers) {
      clearTimeout(id);
    }
    this._presentationTimers.length = 0;
  }

  _schedulePresentation(delayMs, fn) {
    const id = setTimeout(fn, Math.max(0, delayMs));
    this._presentationTimers.push(id);
    return id;
  }

  _syncBarCssVars(barTransitionMs = null) {
    if (!this._overlayRoot) return;
    const barHeightPct = normalizeBarHeightPct(this.sceneState.barHeightPct);
    const transitionMs = clamp(
      asNumber(barTransitionMs ?? this.sceneState.transitionMs, CINEMATIC_CURTAIN_MS),
      CINEMATIC_CURTAIN_MS,
      10000,
    );
    this._overlayRoot.style.setProperty('--map-shine-cinematic-transition-ms', `${transitionMs}ms`);
    this._overlayRoot.style.setProperty('--map-shine-cinematic-bar-height', `${barHeightPct * 100}%`);
  }

  _setBarTransitionMs(ms) {
    if (!this._overlayRoot) return;
    const duration = clamp(asNumber(ms, CINEMATIC_CURTAIN_MS), CINEMATIC_CURTAIN_MS, 10000);
    this._overlayRoot.style.setProperty('--map-shine-cinematic-transition-ms', `${duration}ms`);
  }

  _setFadeOpacity(opacity, durationMs = CINEMATIC_CURTAIN_MS) {
    if (!this._fadeOverlay || isUserGM()) return;
    const target = clamp(asNumber(opacity, 0), 0, 1);
    const duration = clamp(asNumber(durationMs, CINEMATIC_CURTAIN_MS), CINEMATIC_CURTAIN_MS, 10000);
    this._fadeOverlay.style.transition = `opacity ${duration}ms ease`;
    void this._fadeOverlay.offsetWidth;
    this._fadeOverlay.style.opacity = String(target);
  }

  _setPlayerUiHidden(hidden) {
    if (isUserGM()) return;
    try {
      document.body.classList.toggle('map-shine-cinematic-player-hide-ui', hidden === true);
    } catch (_) {}
  }

  _runEnterPresentation() {
    this._cancelPresentation();
    const token = this._presentationToken;
    this._presentationPhase = 'entering';
    this._cameraCurtainClosed = true;

    const gm = isUserGM();
    this._syncBarCssVars(CINEMATIC_CURTAIN_MS);
    this._setLetterboxActive(false);
    this._overlayRoot?.classList.remove('map-shine-cinematic-root--gm-preview');

    if (!gm) {
      this._setPlayerUiHidden(true);
      this._setFadeOpacity(0, 0);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (token !== this._presentationToken) return;
          this._setFadeOpacity(1, CINEMATIC_CURTAIN_MS);
        });
      });
    }

    this._schedulePresentation(CINEMATIC_UI_HOLD_MS, () => {
      if (token !== this._presentationToken) return;
      this._setBarTransitionMs(CINEMATIC_CURTAIN_MS);
      this._setLetterboxActive(true);
      if (gm) {
        this._overlayRoot?.classList.add('map-shine-cinematic-root--gm-preview');
      }
    });

    this._schedulePresentation(CINEMATIC_CURTAIN_MS, () => {
      if (token !== this._presentationToken) return;
      this._cameraCurtainClosed = false;
      if (isUserGM()) {
        this._broadcastCameraState(null, { force: true });
      } else if (this._remotePanTarget) {
        this._tickRemoteFollow();
      }
      this._emitStateChanged();
    });

    this._schedulePresentation(CINEMATIC_UI_HOLD_MS + CINEMATIC_CURTAIN_MS, () => {
      if (token !== this._presentationToken) return;
      if (!gm) {
        this._setFadeOpacity(0, CINEMATIC_CURTAIN_MS);
      }
      this._presentationPhase = 'active';
      this._applyVisualState();
      this._emitStateChanged();
    });
  }

  _runExitPresentation() {
    this._cancelPresentation();
    const token = this._presentationToken;
    this._presentationPhase = 'exiting';
    this._cameraCurtainClosed = true;

    const gm = isUserGM();

    if (!gm) {
      this._setFadeOpacity(0, 0);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (token !== this._presentationToken) return;
          this._setFadeOpacity(1, CINEMATIC_CURTAIN_MS);
        });
      });
    }

    this._schedulePresentation(CINEMATIC_CURTAIN_MS, () => {
      if (token !== this._presentationToken) return;
      this._cameraCurtainClosed = false;
      this._resetRemoteFollowState({ clearTarget: true });
      this._lastBroadcastView = null;
      this._setBarTransitionMs(CINEMATIC_CURTAIN_MS);
      this._setLetterboxActive(false);
      this._overlayRoot?.classList.remove('map-shine-cinematic-root--gm-preview');
    });

    this._schedulePresentation(CINEMATIC_CURTAIN_MS + CINEMATIC_CURTAIN_MS, () => {
      if (token !== this._presentationToken) return;
      if (!gm) {
        this._setPlayerUiHidden(false);
        this._setFadeOpacity(0, CINEMATIC_CURTAIN_MS);
      }
      this._presentationPhase = 'idle';
      this._applyVisualState();
      this._emitStateChanged();
    });
  }

  _setLetterboxActive(showLetterbox) {
    if (!this._overlayRoot) return;

    const token = ++this._letterboxAnimToken;
    const apply = (active) => {
      if (token !== this._letterboxAnimToken || !this._overlayRoot) return;
      this._overlayRoot.classList.toggle('map-shine-cinematic-active', active);
    };

    if (showLetterbox && !this._overlayRoot.classList.contains('map-shine-cinematic-active')) {
      apply(false);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => apply(true));
      });
      return;
    }

    apply(showLetterbox);
  }

  _applyVisualState() {
    if (!this._overlayRoot) return;

    const gm = isUserGM();
    const cinematicActive = this.sceneState.cinematicActive === true;
    const letterboxEnabled = this.sceneState.letterboxEnabled === true;
    const inTransition = this._presentationPhase === 'entering' || this._presentationPhase === 'exiting';

    this._syncBarCssVars();

    if (!inTransition) {
      const strictLockedLocally = !gm
        && cinematicActive
        && this.sceneState.lockPlayers
        && this.sceneState.strictFollow;

      const localCinematicActive = cinematicActive && (strictLockedLocally || !this.playerOptOut);

      const showPlayerLetterbox = !gm && localCinematicActive && letterboxEnabled;
      const showGmPreviewLetterbox = gm && cinematicActive && letterboxEnabled;
      const showLetterbox = showPlayerLetterbox || showGmPreviewLetterbox;

      this._setLetterboxActive(showLetterbox);
      this._overlayRoot.classList.toggle('map-shine-cinematic-root--gm-preview', showGmPreviewLetterbox);

      const shouldHidePlayerUi = !gm
        && localCinematicActive
        && this.sceneState.lockPlayers === true
        && this._presentationPhase === 'active';

      this._setPlayerUiHidden(shouldHidePlayerUi);
    }

    const showPlayerToggle = !gm && cinematicActive && this._presentationPhase === 'active';
    const strictLockedLocally = !gm
      && cinematicActive
      && this.sceneState.lockPlayers
      && this.sceneState.strictFollow;
    const localCinematicActive = cinematicActive && (strictLockedLocally || !this.playerOptOut);

    if (this._playerToggleButton) {
      this._playerToggleButton.style.display = showPlayerToggle ? 'inline-flex' : 'none';
      this._playerToggleButton.classList.toggle('map-shine-cinematic-toggle--locked', strictLockedLocally);
      this._playerToggleButton.disabled = strictLockedLocally;
      this._playerToggleButton.title = strictLockedLocally
        ? 'GM has enabled strict cinematic follow.'
        : '';
      if (strictLockedLocally) {
        this._playerToggleButton.textContent = 'Cinematic Locked';
      } else {
        this._playerToggleButton.textContent = localCinematicActive ? 'Exit Cinematic View' : 'Rejoin Cinematic View';
      }
    }

    const showGmChrome = gm && (
      this._presentationPhase === 'entering'
      || this._presentationPhase === 'active'
      || this._presentationPhase === 'exiting'
    );
    if (this._gmBanner) {
      this._gmBanner.style.display = (showGmChrome && this._presentationPhase === 'active') ? 'flex' : 'none';
    }
    if (this._gmToggleButton) {
      this._gmToggleButton.style.display = showGmChrome ? 'inline-flex' : 'none';
      this._gmToggleButton.classList.toggle('is-active', this._presentationPhase === 'active' || this._presentationPhase === 'entering');
      if (showGmChrome) {
        this._gmToggleButton.textContent = this._gmToggleDefaultLabel;
      }
    }

    const uiRoot = document.getElementById('ui');
    if (uiRoot) {
      uiRoot.classList.remove('map-shine-cinematic-ui-fade-active');
      uiRoot.style.removeProperty('--map-shine-cinematic-ui-opacity');
      uiRoot.style.removeProperty('--map-shine-cinematic-transition-ms');
    }
  }

  _isPlayerFollowLocked() {
    if (this.isRuntimeTemporarilySuspended()) return false;
    if (this._cameraCurtainClosed) return false;
    if (this._presentationPhase === 'idle' || this._presentationPhase === 'exiting') return false;
    if (isUserGM()) return false;
    if (!this.sceneState.cinematicActive) return false;
    if (!this.sceneState.lockPlayers) return false;
    if (this.sceneState.strictFollow) return true;
    return !this.playerOptOut;
  }

  shouldBlockLocalCameraInput() {
    if (this.isRuntimeTemporarilySuspended()) return false;
    if (this._isApplyingRemotePan) return true;
    return this._isPlayerFollowLocked();
  }

  /**
   * Temporarily suspend runtime camera control systems (follow, cohesion, bounds,
   * and input blocking logic) so short cinematic transitions can run without
   * being counter-steered. Uses a refcount and must be paired with
   * resumeTemporaryRuntimeControl().
   */
  suspendTemporaryRuntimeControl() {
    this._temporaryRuntimeSuspendCount = Math.max(0, this._temporaryRuntimeSuspendCount) + 1;
    if (this._temporaryRuntimeSuspendCount === 1) {
      this._resetRemoteFollowState({ clearTarget: true });
    }
  }

  /**
   * Releases one temporary runtime suspension lease acquired by
   * suspendTemporaryRuntimeControl().
   */
  resumeTemporaryRuntimeControl() {
    this._temporaryRuntimeSuspendCount = Math.max(0, this._temporaryRuntimeSuspendCount - 1);
    if (this._temporaryRuntimeSuspendCount === 0) {
      this._resetRemoteFollowState({ clearTarget: true });
    }
  }

  /** @returns {boolean} */
  isRuntimeTemporarilySuspended() {
    return this._temporaryRuntimeSuspendCount > 0;
  }

  toggleLocalOptOut() {
    if (!isUserGM() && this.sceneState.strictFollow && this.sceneState.cinematicActive && this.sceneState.lockPlayers) {
      return false;
    }

    this.playerOptOut = !this.playerOptOut;
    this._savePlayerLocalState();
    this._applyVisualState();
    this._emitStateChanged();
    return true;
  }

  toggleLocalCinematicView() {
    return this.toggleLocalOptOut();
  }

  setImprovedModeEnabled(enabled) {
    this._applySceneStatePatch({ improvedModeEnabled: enabled === true });
  }

  startCinematic() {
    if (this.sceneState.cinematicActive || this._presentationPhase === 'entering') return;
    extendMsaLocalFlagWriteGuard();
    this._applySceneStatePatch({
      improvedModeEnabled: true,
      cinematicActive: true,
      lockPlayers: true,
      strictFollow: true,
      letterboxEnabled: true,
      transitionMs: CINEMATIC_CURTAIN_MS,
    });
  }

  endCinematic() {
    if (!this.sceneState.cinematicActive && this._presentationPhase !== 'entering') return;
    extendMsaLocalFlagWriteGuard();
    if (isUserGM()) {
      this.broadcastEnvironmentRelease();
    }
    this._applySceneStatePatch({
      cinematicActive: false,
      lockPlayers: false,
      strictFollow: false,
    });
  }

  /**
   * Apply presentation/runtime camera state without writing to the scene document.
   * Use for short-lived tooling (camera path playback) so scene.setFlag does not
   * trigger a Foundry canvas redraw / Map Shine full reinit.
   *
   * @param {object} patch
   */
  applyTransientState(patch) {
    this._applySceneStatePatch(patch, { persist: false });
  }

  setLockPlayers(locked) {
    this._applySceneStatePatch({ lockPlayers: locked === true });
  }

  setStrictFollow(strict) {
    this._applySceneStatePatch({ strictFollow: strict === true });
  }

  setUiFade(uiFade) {
    this._applySceneStatePatch({ uiFade: asNumber(uiFade, this.sceneState.uiFade) });
  }

  setBarHeightPct(value) {
    this._applySceneStatePatch({ barHeightPct: asNumber(value, this.sceneState.barHeightPct) });
  }

  setTransitionMs(value) {
    this._applySceneStatePatch({ transitionMs: asNumber(value, this.sceneState.transitionMs) });
  }

  setPlayerBoundsEnabled(enabled) {
    this._applySceneStatePatch({ playerBoundsEnabled: enabled === true });
  }

  setPlayerBoundsPadding(padding) {
    this._applySceneStatePatch({ playerBoundsPadding: asNumber(padding, this.sceneState.playerBoundsPadding) });
  }

  setPlayerBoundsSampleDivisions(divisions) {
    this._applySceneStatePatch({ playerBoundsSampleDivisions: asNumber(divisions, this.sceneState.playerBoundsSampleDivisions) });
  }

  setGroupCohesionEnabled(enabled) {
    this._applySceneStatePatch({ cohesionEnabled: enabled === true });
  }

  setGroupCohesionStrength(strength) {
    this._applySceneStatePatch({ cohesionStrength: asNumber(strength, this.sceneState.cohesionStrength) });
  }

  setGroupCohesionAutoFit(enabled) {
    this._applySceneStatePatch({ cohesionAutoFit: enabled === true });
  }

  setGroupCohesionPadding(padding) {
    this._applySceneStatePatch({ cohesionPadding: asNumber(padding, this.sceneState.cohesionPadding) });
  }

  emergencyUnlockPlayers() {
    this._applySceneStatePatch({
      lockPlayers: false,
      strictFollow: false,
    });
  }

  triggerImpulse({ x = 0, y = 0, zoom = 0, durationMs = 160 } = {}) {
    this._lastImpulse = {
      x: asNumber(x, 0),
      y: asNumber(y, 0),
      zoom: asNumber(zoom, 0),
      durationMs: clamp(asNumber(durationMs, 160), 16, 1500),
      t: Date.now(),
    };

    // Foundation only: public API exists for future gameplay-triggered integrations.
    // Runtime integration can layer this onto camera smoothing in a later pass.
    log.debug('Camera impulse registered', this._lastImpulse);
    this._emitStateChanged();
  }

  focusSelectedToken(duration = 350) {
    const token = canvas?.tokens?.controlled?.[0];
    if (!token?.center) {
      ui.notifications?.warn?.('Select a token first.');
      return;
    }

    void this._animateViewTo({
      x: token.center.x,
      y: token.center.y,
    }, duration);
  }

  focusControlledGroup(duration = 420) {
    const tokens = this._getUserControlledTokens();
    if (!tokens.length) {
      ui.notifications?.warn?.('No controlled/owned tokens found.');
      return;
    }

    const bounds = this._computeTokenBounds(tokens);
    if (!bounds) return;

    const padding = clamp(asNumber(this.sceneState.cohesionPadding, 220), 40, 2000);
    const paddedWidth = Math.max(1, bounds.width + (padding * 2));
    const paddedHeight = Math.max(1, bounds.height + (padding * 2));

    const viewportW = Math.max(1, window.innerWidth);
    const viewportH = Math.max(1, window.innerHeight);

    const fitScale = Math.min(viewportW / paddedWidth, viewportH / paddedHeight);
    const minScale = canvas?.dimensions?.scale?.min ?? 0.1;
    const maxScale = canvas?.dimensions?.scale?.max ?? 3.0;
    const targetScale = clamp(fitScale, minScale, maxScale);

    void this._animateViewTo({
      x: bounds.centerX,
      y: bounds.centerY,
      scale: targetScale,
    }, duration);
  }

  _shouldBroadcastCameraState() {
    if (this._cameraCurtainClosed) return false;
    if (this._presentationPhase !== 'active' && this._presentationPhase !== 'entering') return false;
    return isUserGM()
      && this.sceneState.cinematicActive
      && this.sceneState.lockPlayers;
  }

  _shouldBroadcastEnvironmentState() {
    return this._shouldBroadcastCameraState();
  }

  /**
   * @param {import('../ui/environment-control-api.js').EnvironmentSnapshot} snapshot
   * @param {number} [t=0]
   */
  broadcastEnvironmentSnapshot(snapshot, t = 0) {
    if (!this._shouldBroadcastEnvironmentState()) return;
    if (!snapshot || typeof snapshot !== 'object') return;

    try {
      this._envRemoteSeq += 1;
      game.socket.emit(SOCKET_CHANNEL, {
        type: ENVIRONMENT_SOCKET_TYPE,
        sceneId: canvas?.scene?.id,
        snapshot,
        t: Math.max(0, Math.min(1, Number(t) || 0)),
        seq: this._envRemoteSeq,
        senderId: game?.user?.id,
      });
    } catch (e) {
      log.warn('Failed to broadcast environment snapshot', e);
    }
  }

  broadcastEnvironmentRelease() {
    if (!isUserGM()) return;
    try {
      game.socket.emit(SOCKET_CHANNEL, {
        type: ENVIRONMENT_RELEASE_SOCKET_TYPE,
        sceneId: canvas?.scene?.id,
        senderId: game?.user?.id,
      });
    } catch (e) {
      log.warn('Failed to broadcast environment release', e);
    }
  }

  _captureCurrentView() {
    const x = asNumber(canvas?.stage?.pivot?.x, NaN);
    const y = asNumber(canvas?.stage?.pivot?.y, NaN);
    const scale = asNumber(canvas?.stage?.scale?.x, NaN);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(scale)) {
      return { x, y, scale };
    }

    const fromScene = canvas?.scene?._viewPosition;
    const sx = asNumber(fromScene?.x, NaN);
    const sy = asNumber(fromScene?.y, NaN);
    const ss = asNumber(fromScene?.scale, NaN);
    if (Number.isFinite(sx) && Number.isFinite(sy) && Number.isFinite(ss)) {
      return { x: sx, y: sy, scale: ss };
    }

    return null;
  }

  _pollGmCameraBroadcast() {
    if (!this._shouldBroadcastCameraState()) return;
    const view = this._captureCurrentView();
    if (!view) return;
    this._broadcastCameraState(view);
  }

  _broadcastCameraState(position, { force = false } = {}) {
    if (!force && !this._shouldBroadcastCameraState()) return;

    const now = Date.now();
    if (!force && (now - this._lastBroadcastAt) < this._broadcastMinIntervalMs) return;

    const pos = position || this._captureCurrentView();

    if (!Number.isFinite(pos?.x) || !Number.isFinite(pos?.y) || !Number.isFinite(pos?.scale)) return;

    if (!force && this._lastBroadcastView) {
      const dx = Math.abs(pos.x - this._lastBroadcastView.x);
      const dy = Math.abs(pos.y - this._lastBroadcastView.y);
      const ds = Math.abs(pos.scale - this._lastBroadcastView.scale);
      if (dx < this._broadcastDeadbandWorld && dy < this._broadcastDeadbandWorld && ds < this._broadcastDeadbandScale) {
        return;
      }
    }

    this._lastBroadcastAt = now;
    this._remoteSeq += 1;

    try {
      game.socket.emit(SOCKET_CHANNEL, {
        type: CAMERA_SOCKET_TYPE,
        sceneId: canvas?.scene?.id,
        x: pos.x,
        y: pos.y,
        scale: pos.scale,
        t: now,
        seq: this._remoteSeq,
        senderId: game?.user?.id,
      });
      this._lastBroadcastView = { x: pos.x, y: pos.y, scale: pos.scale };
    } catch (e) {
      log.warn('Failed to broadcast cinematic camera state', e);
    }
  }

  _onSocketMessage(payload) {
    if (!payload?.sceneId || payload.sceneId !== canvas?.scene?.id) return;

    if (payload.type === ENVIRONMENT_SOCKET_TYPE) {
      this._onEnvironmentSocketMessage(payload);
      return;
    }
    if (payload.type === ENVIRONMENT_RELEASE_SOCKET_TYPE) {
      this._onEnvironmentReleaseSocketMessage(payload);
      return;
    }
    if (payload.type !== CAMERA_SOCKET_TYPE) return;
    if (isUserGM()) return;

    const senderId = typeof payload.senderId === 'string' ? payload.senderId : null;
    if (senderId && senderId === game.user?.id) return;
    if (senderId && this._remoteSenderId && senderId !== this._remoteSenderId) {
      this._resetRemoteFollowState({ clearTarget: true });
    }
    if (senderId) this._remoteSenderId = senderId;

    const seq = Number(payload.seq);
    const packetTime = asNumber(payload.t, 0);
    const likelyStreamReset = Number.isFinite(seq)
      && seq < 100
      && packetTime > (this._lastRemotePacketAt + 5000);

    const lowSeqRestart = Number.isFinite(seq)
      && seq <= 2
      && this._lastRemoteSeqApplied >= 200;

    const regressedAfterGap = Number.isFinite(seq)
      && seq < this._lastRemoteSeqApplied
      && packetTime > (this._lastRemotePacketAt + 750);

    if (likelyStreamReset || lowSeqRestart || regressedAfterGap) {
      this._lastRemoteSeqApplied = -1;
    }

    if (Number.isFinite(seq) && seq <= this._lastRemoteSeqApplied) return;
    if (Number.isFinite(seq)) this._lastRemoteSeqApplied = seq;
    this._lastRemotePacketAt = Math.max(this._lastRemotePacketAt, packetTime || Date.now());

    this._applyRemotePan(payload);
  }

  _onEnvironmentSocketMessage(payload) {
    if (isUserGM()) return;

    const senderId = typeof payload.senderId === 'string' ? payload.senderId : null;
    if (senderId && senderId === game.user?.id) return;

    const api = window.MapShine?.environmentControlApi;
    if (!api) return;

    if (senderId && this._envRemoteSenderId && senderId !== this._envRemoteSenderId) {
      api.endExternalDrive('camera-path-remote', { restore: true });
      this._playerPreEnvSnapshot = null;
      this._lastEnvRemoteSeqApplied = -1;
    }
    if (senderId) this._envRemoteSenderId = senderId;

    const seq = Number(payload.seq);
    if (Number.isFinite(seq) && seq <= this._lastEnvRemoteSeqApplied) return;
    if (Number.isFinite(seq)) this._lastEnvRemoteSeqApplied = seq;

    if (!this._playerPreEnvSnapshot) {
      this._playerPreEnvSnapshot = api.captureSnapshot();
      api.beginExternalDrive('camera-path-remote');
    }

    if (payload.snapshot && typeof payload.snapshot === 'object') {
      void api.applySnapshot(payload.snapshot, {
        persist: false,
        syncUi: false,
        applyDarkness: true,
        syncFoundryTime: false,
      });
    }
  }

  _onEnvironmentReleaseSocketMessage(payload) {
    if (isUserGM()) return;

    const senderId = typeof payload.senderId === 'string' ? payload.senderId : null;
    if (senderId && senderId === game.user?.id) return;
    if (senderId && this._envRemoteSenderId && senderId !== this._envRemoteSenderId) return;

    const api = window.MapShine?.environmentControlApi;
    if (!api) return;

    api.endExternalDrive('camera-path-remote', { restore: true });
    this._playerPreEnvSnapshot = null;
    this._envRemoteSenderId = null;
    this._lastEnvRemoteSeqApplied = -1;
  }

  _applyRemotePan(payload) {
    if (!canvas?.stage?.pivot || !canvas?.stage?.scale) return;

    const x = asNumber(payload.x, NaN);
    const y = asNumber(payload.y, NaN);
    const scale = asNumber(payload.scale, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale)) return;

    this._remotePanTarget = {
      x,
      y,
      scale,
      t: Date.now(),
    };

    if (this._isPlayerFollowLocked()) {
      this._applyRemotePanView(x, y, scale);
    }
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} scale
   */
  _applyRemotePanView(x, y, scale) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale)) return;
    if (!canvas?.stage?.pivot || !canvas?.stage?.scale) return;

    this._isApplyingRemotePan = true;
    try {
      canvas.pan({ x, y, scale, duration: 0 });
    } catch (e) {
      log.warn('Failed to apply remote cinematic pan', e);
    } finally {
      this._isApplyingRemotePan = false;
    }
  }

  _tickRemoteFollow(timeInfo = null) {
    if (this.isRuntimeTemporarilySuspended()) return;
    if (this._cameraCurtainClosed) return;
    if (isUserGM()) return;
    if (!this._isPlayerFollowLocked()) return;
    if (!this._remotePanTarget) return;
    if (!canvas?.stage?.pivot || !canvas?.stage?.scale || !canvas?.pan) return;

    const currentX = asNumber(canvas.stage.pivot.x, 0);
    const currentY = asNumber(canvas.stage.pivot.y, 0);
    const currentScale = asNumber(canvas.stage.scale.x, 1);
    const target = this._remotePanTarget;

    const dx = target.x - currentX;
    const dy = target.y - currentY;
    const ds = target.scale - currentScale;

    // Delta-time driven smoothing keeps follow behavior consistent across frame rates.
    const dt = clamp(asNumber(timeInfo?.delta, 1 / 60), 1 / 240, 0.1);
    const smoothingHz = clamp(asNumber(this._remotePanSmoothingHz, 18), 1, 60);
    const alpha = clamp(1 - Math.exp(-smoothingHz * dt), 0.05, 1);
    const nextX = currentX + (dx * alpha);
    const nextY = currentY + (dy * alpha);
    const nextScale = currentScale + (ds * alpha);

    const closeEnough = Math.abs(dx) < this._remotePanEpsilonWorld
      && Math.abs(dy) < this._remotePanEpsilonWorld
      && Math.abs(ds) < this._remotePanEpsilonScale;

    const finalX = closeEnough ? target.x : nextX;
    const finalY = closeEnough ? target.y : nextY;
    const finalScale = closeEnough ? target.scale : nextScale;

    this._applyRemotePanView(finalX, finalY, finalScale);

    if (closeEnough) {
      this._remotePanTarget = null;
    }
  }

  _invalidatePlayerBounds() {
    this._boundsCache = null;
  }

  _getCachedPlayerBounds() {
    if (!this._boundsCache) return null;
    if ((Date.now() - this._boundsCache.t) > this._boundsCacheMs) return null;
    return this._boundsCache.bounds;
  }

  _getOrComputePlayerBounds() {
    const cached = this._getCachedPlayerBounds();
    if (cached) return cached;

    const bounds = this._computePlayerFogBounds();
    this._boundsCache = { t: Date.now(), bounds };
    return bounds;
  }

  _computePlayerFogBounds() {
    const sr = canvas?.dimensions?.sceneRect;
    if (!sr) return null;

    const divisions = clamp(Math.round(asNumber(this.sceneState.playerBoundsSampleDivisions, 16)), 6, 80);
    const stepX = sr.width / divisions;
    const stepY = sr.height / divisions;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let yi = 0; yi <= divisions; yi++) {
      const y = sr.y + (yi * stepY);
      for (let xi = 0; xi <= divisions; xi++) {
        const x = sr.x + (xi * stepX);

        let explored = false;
        let visible = false;

        try {
          explored = canvas?.fog?.isPointExplored?.({ x, y }) === true;
        } catch (_) {
        }

        try {
          visible = canvas?.visibility?.testVisibility?.({ x, y }, { tolerance: 1 }) === true;
        } catch (_) {
        }

        if (!explored && !visible) continue;

        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      const tokenBounds = this._computeTokenBounds(this._getUserControlledTokens());
      if (!tokenBounds) return null;

      const fallbackPad = clamp(asNumber(this.sceneState.playerBoundsPadding, 220), 0, 2000);
      return {
        minX: tokenBounds.minX - fallbackPad,
        minY: tokenBounds.minY - fallbackPad,
        maxX: tokenBounds.maxX + fallbackPad,
        maxY: tokenBounds.maxY + fallbackPad,
        width: tokenBounds.width + (fallbackPad * 2),
        height: tokenBounds.height + (fallbackPad * 2),
      };
    }

    const pad = clamp(asNumber(this.sceneState.playerBoundsPadding, 220), 0, 2000);

    minX = clamp(minX - pad, sr.x, sr.x + sr.width);
    minY = clamp(minY - pad, sr.y, sr.y + sr.height);
    maxX = clamp(maxX + pad, sr.x, sr.x + sr.width);
    maxY = clamp(maxY + pad, sr.y, sr.y + sr.height);

    return {
      minX,
      minY,
      maxX,
      maxY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
    };
  }

  constrainView(view) {
    if (!view || typeof view !== 'object') return view;
    if (this.isRuntimeTemporarilySuspended()) return view;
    if (!this.sceneState.improvedModeEnabled) return view;
    if (!this.sceneState.playerBoundsEnabled) return view;
    if (isUserGM()) return view;
    if (this._isPlayerFollowLocked()) return view;

    const bounds = this._getOrComputePlayerBounds();
    if (!bounds) return view;

    const currentScale = asNumber(view.scale, canvas?.stage?.scale?.x || 1);
    const minScaleScene = canvas?.dimensions?.scale?.min ?? 0.1;
    const maxScaleScene = canvas?.dimensions?.scale?.max ?? 3.0;
    const minScaleBounds = Math.max(window.innerWidth / bounds.width, window.innerHeight / bounds.height, minScaleScene);

    const scale = clamp(currentScale, minScaleBounds, maxScaleScene);

    const halfW = window.innerWidth / (2 * scale);
    const halfH = window.innerHeight / (2 * scale);

    const minCenterX = bounds.minX + halfW;
    const maxCenterX = bounds.maxX - halfW;
    const minCenterY = bounds.minY + halfH;
    const maxCenterY = bounds.maxY - halfH;

    let x = asNumber(view.x, canvas?.stage?.pivot?.x || 0);
    let y = asNumber(view.y, canvas?.stage?.pivot?.y || 0);

    if (minCenterX <= maxCenterX) {
      x = clamp(x, minCenterX, maxCenterX);
    } else {
      x = (bounds.minX + bounds.maxX) * 0.5;
    }

    if (minCenterY <= maxCenterY) {
      y = clamp(y, minCenterY, maxCenterY);
    } else {
      y = (bounds.minY + bounds.maxY) * 0.5;
    }

    return { ...view, x, y, scale };
  }

  _getUserControlledTokens() {
    const controlled = canvas?.tokens?.controlled;
    if (Array.isArray(controlled) && controlled.length) return controlled;

    const placeables = canvas?.tokens?.placeables;
    if (!Array.isArray(placeables) || !placeables.length) return [];

    if (isUserGM()) {
      return placeables.filter((t) => t?.visible !== false);
    }

    return placeables.filter((t) => t?.document?.actor?.isOwner === true);
  }

  _computeTokenBounds(tokens) {
    if (!Array.isArray(tokens) || !tokens.length) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const token of tokens) {
      const doc = token?.document;
      if (!doc) continue;

      const x = asNumber(doc.x, token?.x);
      const y = asNumber(doc.y, token?.y);
      const w = asNumber(doc.width, token?.w || 1) * (canvas?.grid?.size || 1);
      const h = asNumber(doc.height, token?.h || 1) * (canvas?.grid?.size || 1);

      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + Math.max(1, w));
      maxY = Math.max(maxY, y + Math.max(1, h));
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return null;
    }

    return {
      minX,
      minY,
      maxX,
      maxY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
      centerX: (minX + maxX) * 0.5,
      centerY: (minY + maxY) * 0.5,
    };
  }

  _tickGroupCohesion() {
    if (this.isRuntimeTemporarilySuspended()) return;
    if (!this.sceneState.improvedModeEnabled) return;
    if (!this.sceneState.cohesionEnabled) return;
    if (this._isPlayerFollowLocked()) return;
    if (this._isApplyingRemotePan || this._isApplyingConstraintPan) return;
    if (!canvas?.stage?.pivot || !canvas?.stage?.scale) return;

    const now = Date.now();
    if ((now - this._lastManualInputAt) < 900) return;

    const tokens = this._getUserControlledTokens();
    if (!tokens.length) return;

    const bounds = this._computeTokenBounds(tokens);
    if (!bounds) return;

    const strength = clamp(asNumber(this.sceneState.cohesionStrength, 0.08), 0.001, 1);
    const currentX = canvas.stage.pivot.x;
    const currentY = canvas.stage.pivot.y;
    const targetX = bounds.centerX;
    const targetY = bounds.centerY;

    let nextX = currentX + ((targetX - currentX) * strength);
    let nextY = currentY + ((targetY - currentY) * strength);
    let nextScale = canvas.stage.scale.x;

    if (this.sceneState.cohesionAutoFit) {
      const padding = clamp(asNumber(this.sceneState.cohesionPadding, 220), 20, 3000);
      const paddedW = bounds.width + (padding * 2);
      const paddedH = bounds.height + (padding * 2);
      const fitScale = Math.min(window.innerWidth / paddedW, window.innerHeight / paddedH);
      const minScaleScene = canvas?.dimensions?.scale?.min ?? 0.1;
      const maxScaleScene = canvas?.dimensions?.scale?.max ?? 3.0;
      const clampedFit = clamp(fitScale, minScaleScene, maxScaleScene);

      // If too zoomed in to keep the group visible, ease out toward fit scale.
      if (nextScale > clampedFit) {
        nextScale = nextScale + ((clampedFit - nextScale) * strength);
      }
    }

    if (Math.abs(nextX - currentX) < 0.05 && Math.abs(nextY - currentY) < 0.05 && Math.abs(nextScale - canvas.stage.scale.x) < 0.0005) {
      return;
    }

    const constrained = this.constrainView({ x: nextX, y: nextY, scale: nextScale });

    this._isApplyingCohesionPan = true;
    try {
      canvas.pan({
        x: constrained?.x ?? nextX,
        y: constrained?.y ?? nextY,
        scale: constrained?.scale ?? nextScale,
        duration: 0,
      });
    } catch (_) {
    } finally {
      this._isApplyingCohesionPan = false;
    }
  }

  update(timeInfo) {
    this._lastExternalUpdateAt = Date.now();
    this._pollGmCameraBroadcast();
    this._tickRemoteFollow(timeInfo);
    this._tickGroupCohesion();
  }
}
