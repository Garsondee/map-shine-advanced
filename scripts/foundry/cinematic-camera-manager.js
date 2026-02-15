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

import { createLogger } from '../core/log.js';

const log = createLogger('CinematicCamera');

const MODULE_ID = 'map-shine-advanced';
const SCENE_FLAG_KEY = 'advancedCameraState';
const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const CAMERA_SOCKET_TYPE = 'advanced-camera-pan';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function asNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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

    this._hookIds = [];
    this._socketHandlerBound = this._onSocketMessage.bind(this);

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

    this._boundsCache = null;
    this._boundsCacheMs = 500;
    this._persistTimeout = null;
    this._lastImpulse = null;

    this._lastExternalUpdateAt = 0;
    this._selfUpdateRafId = null;
    this._selfUpdateLastAt = 0;
    this._selfUpdateBound = this._selfUpdateTick.bind(this);
  }

  _createDefaultSceneState() {
    return {
      improvedModeEnabled: false,
      cinematicActive: false,
      lockPlayers: false,
      strictFollow: false,
      uiFade: 0.92,
      barHeightPct: 0.12,
      transitionMs: 450,

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
    this._startSelfUpdateLoop();
    this._applyVisualState();
    this._emitStateChanged();

    log.info('CinematicCameraManager initialized');
  }

  dispose() {
    if (!this._initialized) return;

    this._unbindInputBridge();
    this._stopSelfUpdateLoop();

    for (const [name, id] of this._hookIds) {
      try {
        Hooks.off(name, id);
      } catch (_) {
      }
    }
    this._hookIds.length = 0;

    try {
      game?.socket?.off?.(SOCKET_CHANNEL, this._socketHandlerBound);
    } catch (_) {
    }

    if (this._persistTimeout !== null) {
      clearTimeout(this._persistTimeout);
      this._persistTimeout = null;
    }

    try {
      this._overlayRoot?.remove();
    } catch (_) {
    }

    this._overlayRoot = null;
    this._topBar = null;
    this._bottomBar = null;
    this._playerToggleButton = null;
    this._listeners.clear();

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
      if (this.sceneState.strictFollow && !game.user?.isGM) {
        ui.notifications?.warn?.('GM has enabled strict cinematic follow.');
        return;
      }
      this.toggleLocalCinematicView();
    });

    root.appendChild(topBar);
    root.appendChild(bottomBar);
    root.appendChild(playerToggle);

    parentElement.appendChild(root);

    this._overlayRoot = root;
    this._topBar = topBar;
    this._bottomBar = bottomBar;
    this._playerToggleButton = playerToggle;
  }

  _registerHooks() {
    const addHook = (name, fn) => {
      const id = Hooks.on(name, fn);
      this._hookIds.push([name, id]);
    };

    addHook('canvasPan', (_canvas, position) => {
      const isInternalPan = this._isApplyingRemotePan || this._isApplyingConstraintPan || this._isApplyingCohesionPan;
      if (!game.user?.isGM && !isInternalPan) {
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

    try {
      game?.socket?.on?.(SOCKET_CHANNEL, this._socketHandlerBound);
    } catch (e) {
      log.warn('Failed to register camera socket listener', e);
    }
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

  _startSelfUpdateLoop() {
    if (this._selfUpdateRafId !== null) return;
    this._selfUpdateLastAt = 0;
    this._selfUpdateRafId = requestAnimationFrame(this._selfUpdateBound);
  }

  _stopSelfUpdateLoop() {
    if (this._selfUpdateRafId === null) return;
    cancelAnimationFrame(this._selfUpdateRafId);
    this._selfUpdateRafId = null;
    this._selfUpdateLastAt = 0;
  }

  _selfUpdateTick(nowMs) {
    if (!this._initialized) {
      this._selfUpdateRafId = null;
      return;
    }

    const last = this._selfUpdateLastAt || nowMs;
    this._selfUpdateLastAt = nowMs;

    // Fallback update path for scenarios where external updatable loops are
    // not driving this manager (e.g. temporarily missing effect composer link).
    if ((Date.now() - this._lastExternalUpdateAt) > 250) {
      const dt = clamp((nowMs - last) / 1000, 1 / 240, 0.1);
      const fallbackTimeInfo = { delta: dt };
      this._tickRemoteFollow(fallbackTimeInfo);
      this._tickGroupCohesion();
    }

    this._selfUpdateRafId = requestAnimationFrame(this._selfUpdateBound);
  }

  _hasMeaningfulViewDelta(a, b) {
    if (!a || !b) return false;
    return Math.abs(asNumber(a.x, 0) - asNumber(b.x, 0)) > 0.1
      || Math.abs(asNumber(a.y, 0) - asNumber(b.y, 0)) > 0.1
      || Math.abs(asNumber(a.scale, 1) - asNumber(b.scale, 1)) > 0.0005;
  }

  _enforcePanBounds(position) {
    if (!this.sceneState.improvedModeEnabled) return;
    if (!this.sceneState.playerBoundsEnabled) return;
    if (game.user?.isGM) return;
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
    const flag = canvas?.scene?.getFlag?.(MODULE_ID, SCENE_FLAG_KEY);
    if (flag && typeof flag === 'object') {
      this._applySceneStatePatch(flag, { persist: false });
    } else {
      this._applyVisualState();
      this._emitStateChanged();
    }
  }

  _schedulePersistSceneState() {
    if (!game.user?.isGM) return;

    if (this._persistTimeout !== null) clearTimeout(this._persistTimeout);
    this._persistTimeout = setTimeout(async () => {
      this._persistTimeout = null;
      try {
        const scene = canvas?.scene;
        if (!scene) return;
        await scene.setFlag(MODULE_ID, SCENE_FLAG_KEY, { ...this.sceneState });
      } catch (e) {
        log.warn('Failed to persist camera scene state', e);
      }
    }, 120);
  }

  _applySceneStatePatch(patch, { persist = true } = {}) {
    if (!patch || typeof patch !== 'object') return;

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
    this.sceneState.playerBoundsEnabled = this.sceneState.playerBoundsEnabled === true;
    this.sceneState.cohesionEnabled = this.sceneState.cohesionEnabled === true;
    this.sceneState.cohesionAutoFit = this.sceneState.cohesionAutoFit === true;
    this.sceneState.localInputSmoothingEnabled = this.sceneState.localInputSmoothingEnabled !== false;

    this.sceneState.uiFade = clamp(asNumber(this.sceneState.uiFade, 0.92), 0, 1);
    this.sceneState.barHeightPct = clamp(asNumber(this.sceneState.barHeightPct, 0.12), 0.03, 0.35);
    this.sceneState.transitionMs = clamp(asNumber(this.sceneState.transitionMs, 450), 50, 3000);
    this.sceneState.playerBoundsPadding = clamp(asNumber(this.sceneState.playerBoundsPadding, 220), 0, 2000);
    this.sceneState.playerBoundsSampleDivisions = clamp(Math.round(asNumber(this.sceneState.playerBoundsSampleDivisions, 16)), 6, 80);
    this.sceneState.cohesionStrength = clamp(asNumber(this.sceneState.cohesionStrength, 0.08), 0, 1);
    this.sceneState.cohesionPadding = clamp(asNumber(this.sceneState.cohesionPadding, 220), 0, 2000);
    this.sceneState.localPanSmoothingHz = clamp(asNumber(this.sceneState.localPanSmoothingHz, 14), 1, 80);
    this.sceneState.localZoomSmoothingHz = clamp(asNumber(this.sceneState.localZoomSmoothingHz, 10), 1, 80);

    this._invalidatePlayerBounds();
    this._applyVisualState();
    this._emitStateChanged();

    const isFollowing = this._isPlayerFollowLocked();
    const isBroadcasting = this._shouldBroadcastCameraState();

    if (!isFollowing) {
      this._resetRemoteFollowState({ clearTarget: true });
    } else if (!wasFollowing && isFollowing) {
      this._resetRemoteFollowState({ clearTarget: true });
    }

    if (!wasBroadcasting && isBroadcasting) {
      // Emit an immediate authoritative snapshot so newly-locked players do not
      // need to wait for the next camera pan event.
      this._broadcastCameraState(null, { force: true });
    } else if (wasBroadcasting && !isBroadcasting) {
      this._lastBroadcastView = null;
    }

    if (persist) this._schedulePersistSceneState();
  }

  _applyVisualState() {
    if (!this._overlayRoot) return;

    this._overlayRoot.style.setProperty('--map-shine-cinematic-transition-ms', `${this.sceneState.transitionMs}ms`);
    this._overlayRoot.style.setProperty('--map-shine-cinematic-bar-height', `${this.sceneState.barHeightPct * 100}%`);

    const cinematicActive = this.sceneState.cinematicActive === true;

    const strictLockedLocally = !game.user?.isGM
      && cinematicActive
      && this.sceneState.lockPlayers
      && this.sceneState.strictFollow;

    const localCinematicActive = cinematicActive && (strictLockedLocally || !this.playerOptOut);
    this._overlayRoot.classList.toggle('map-shine-cinematic-active', localCinematicActive);

    const showToggle = cinematicActive;
    if (this._playerToggleButton) {
      this._playerToggleButton.style.display = showToggle ? 'inline-flex' : 'none';
      this._playerToggleButton.classList.toggle('map-shine-cinematic-toggle--locked', strictLockedLocally);
      this._playerToggleButton.disabled = strictLockedLocally;
      this._playerToggleButton.title = strictLockedLocally
        ? 'GM has enabled strict cinematic follow.'
        : '';
    }

    if (this._playerToggleButton) {
      if (strictLockedLocally) {
        this._playerToggleButton.textContent = 'Cinematic Locked';
      } else {
        this._playerToggleButton.textContent = localCinematicActive ? 'Exit Cinematic View' : 'Rejoin Cinematic View';
      }
    }

    const shouldFadeUi = localCinematicActive;
    const uiRoot = document.getElementById('ui');
    if (uiRoot) {
      uiRoot.classList.toggle('map-shine-cinematic-ui-fade-active', shouldFadeUi);
      uiRoot.style.setProperty('--map-shine-cinematic-ui-opacity', String(1 - this.sceneState.uiFade));
      uiRoot.style.setProperty('--map-shine-cinematic-transition-ms', `${this.sceneState.transitionMs}ms`);
    }
  }

  _isPlayerFollowLocked() {
    if (game.user?.isGM) return false;
    if (!this.sceneState.cinematicActive) return false;
    if (!this.sceneState.lockPlayers) return false;
    if (this.sceneState.strictFollow) return true;
    return !this.playerOptOut;
  }

  shouldBlockLocalCameraInput() {
    if (this._isApplyingRemotePan) return true;
    return this._isPlayerFollowLocked();
  }

  toggleLocalOptOut() {
    if (!game.user?.isGM && this.sceneState.strictFollow && this.sceneState.cinematicActive && this.sceneState.lockPlayers) {
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
    this._applySceneStatePatch({
      improvedModeEnabled: true,
      cinematicActive: true,
      lockPlayers: true,
    });
  }

  endCinematic() {
    this._applySceneStatePatch({
      cinematicActive: false,
      lockPlayers: false,
      strictFollow: false,
    });
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

    void canvas.animatePan({
      x: token.center.x,
      y: token.center.y,
      duration: clamp(asNumber(duration, 350), 50, 5000),
    });
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

    void canvas.animatePan({
      x: bounds.centerX,
      y: bounds.centerY,
      scale: targetScale,
      duration: clamp(asNumber(duration, 420), 50, 5000),
    });
  }

  _shouldBroadcastCameraState() {
    return game.user?.isGM
      && this.sceneState.cinematicActive
      && this.sceneState.lockPlayers;
  }

  _broadcastCameraState(position, { force = false } = {}) {
    if (!force && !this._shouldBroadcastCameraState()) return;

    const now = Date.now();
    if (!force && (now - this._lastBroadcastAt) < this._broadcastMinIntervalMs) return;

    const pos = position || canvas?.scene?._viewPosition || {
      x: canvas?.stage?.pivot?.x,
      y: canvas?.stage?.pivot?.y,
      scale: canvas?.stage?.scale?.x,
    };

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
    if (!payload || payload.type !== CAMERA_SOCKET_TYPE) return;
    if (!payload.sceneId || payload.sceneId !== canvas?.scene?.id) return;
    if (game.user?.isGM) return;

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
  }

  _tickRemoteFollow(timeInfo = null) {
    if (game.user?.isGM) return;
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

    this._isApplyingRemotePan = true;
    try {
      // Use duration=0 so this manager's own interpolation controls smoothing.
      canvas.pan({ x: finalX, y: finalY, scale: finalScale, duration: 0 });
    } catch (e) {
      log.warn('Failed to apply remote cinematic pan', e);
    } finally {
      this._isApplyingRemotePan = false;
    }

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
    if (!this.sceneState.improvedModeEnabled) return view;
    if (!this.sceneState.playerBoundsEnabled) return view;
    if (game.user?.isGM) return view;
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

    if (game.user?.isGM) return [];

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
    this._tickRemoteFollow(timeInfo);
    this._tickGroupCohesion();
  }
}
