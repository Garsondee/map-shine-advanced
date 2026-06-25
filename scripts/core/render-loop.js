/**
 * @fileoverview Render loop manager for three.js animation
 * Handles requestAnimationFrame loop with presentation-first pacing
 * @module core/render-loop
 */

import { createLogger } from './log.js';
import { isCameraNavigationActive } from '../foundry/camera-navigation-state.js';

const log = createLogger('RenderLoop');

/**
 * Maximum time (ms) the RenderLoop will suppress the compositor while the
 * strict-sync hold flag is active. After this window we force the compositor
 * to run so it can re-validate inputs and clear the flag. Without this cap,
 * a stale flag would starve the compositor and freeze the scene indefinitely.
 */
const STRICT_HOLD_MAX_MS = 250;

/** Max PIXI tokens to drain per present frame when strict sync + pacing coexist. */
const STRICT_TOKEN_DRAIN_CAP = 8;

/**
 * Render loop manager
 */
export class RenderLoop {
  constructor(renderer, scene, camera, effectComposer = null) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.effectComposer = effectComposer;

    this._forceNextRender = true;
    this._presentationDueImmediately = true;
    this._lastComposerRenderTime = 0;
    this._lastPresentationMs = 0;
    this._idleFps = 15;
    this._activeFps = 60;
    this._continuousFps = 30;
    this._presentationFps = 30;

    this._cachedEffectWantsContinuous = false;
    this._lastEffectContinuousCheckMs = -Infinity;

    this._lastCamX = null;
    this._lastCamY = null;
    this._lastCamZ = null;
    this._lastCamZoom = null;

    this._lastPixiPivotX = null;
    this._lastPixiPivotY = null;
    this._lastPixiZoom = null;

    this._continuousRenderUntilMs = 0;
    this._cinematicModeUntilMs = 0;
    this._cameraActiveUntilMs = 0;
    this._cameraActiveHoldMs = 150;

    this.animationFrameId = null;
    this.isRunning = false;
    this.lastFrameTime = performance.now();
    this.frameCount = 0;
    this.fps = 0;
    this.fpsUpdateInterval = 1000;
    this.lastFpsUpdate = performance.now();
    this.framesThisSecond = 0;
    this._presentedFramesThisSecond = 0;
    this._lastPresentedFpsUpdate = performance.now();
    this.presentationFps = 0;

    this._firstFrameLogged = false;
    this._lastContextLostLogMs = -Infinity;
    this._loadPumpFrameCount = 0;
    this._glContext = null;
    this._strictHoldState = { active: false, reason: null, updatedAtMs: 0 };
    this._cameraState = {
      cameraChanged: false,
      pixiPivotX: null,
      pixiPivotY: null,
      pixiZoom: null,
      x: null,
      y: null,
      zoom: null,
    };
    this._fpsConfig = { idleFps: 15, activeFps: 60, presentationFps: 30, continuousFps: 30 };
    this._targetFpsState = { targetFps: 0, tier: 'none' };
    this._gateState = {
      shouldPresent: false,
      skipReason: 'none',
      targetFps: 0,
      tier: 'none',
      sinceLastPresentMs: 0,
      cameraChanged: false,
      effectWantsContinuous: false,
      inContinuousWindow: false,
      navigationActive: false,
      pixiPivotX: null,
      pixiPivotY: null,
      pixiZoom: null,
      presentationDeltaSec: 0,
    };
    this._presentationState = {};

    this.render = this.render.bind(this);
  }

  _isStrictSyncEnabled(ms = window.MapShine) {
    return ms?.renderStrictSyncEnabled === true;
  }

  _isPresentationPacingEnabled(ms = window.MapShine) {
    return ms?.renderPresentationPacingEnabled !== false;
  }

  _getStrictHoldState(ms = window.MapShine) {
    const flag = ms?.renderStrictHoldFrame;
    if (flag && flag.active === true) {
      this._strictHoldState.active = true;
      this._strictHoldState.reason = flag.reason ? String(flag.reason) : 'unspecified';
      this._strictHoldState.updatedAtMs = +(flag.updatedAtMs) || 0;
    } else {
      this._strictHoldState.active = false;
    }
    return this._strictHoldState;
  }

  _pixiCameraFromCoordinator(fcState, stage) {
    const out = this._cameraState;
    const sx = Number(stage?.pivot?.x);
    const sy = Number(stage?.pivot?.y);
    const sz = Number(stage?.scale?.x);
    // Live stage pivot is authoritative during bridge pan — FrameCoordinator
    // snapshots lag direct pointer writes by up to one PIXI tick.
    if (Number.isFinite(sx) && Number.isFinite(sy) && Number.isFinite(sz)) {
      out.x = sx;
      out.y = sy;
      out.zoom = sz;
      return out;
    }
    const fx = fcState?.cameraX;
    const fy = fcState?.cameraY;
    const fz = fcState?.zoom;
    out.x = Number.isFinite(fx) ? fx : sx;
    out.y = Number.isFinite(fy) ? fy : sy;
    out.zoom = Number.isFinite(fz) ? fz : sz;
    return out;
  }

  _clampFps(value, fallback, min = 5, max = 120) {
    let n = +value;
    if (n !== n) return fallback;
    n = n | 0;
    return n < min ? min : (n > max ? max : n);
  }

  _readRuntimeFps(ms = window.MapShine) {
    const presentation = this._clampFps(
      ms?.renderPresentationFps ?? ms?.renderContinuousFps,
      this._presentationFps,
      5,
      60,
    );
    const out = this._fpsConfig;
    out.idleFps = this._clampFps(ms?.renderIdleFps, this._idleFps, 5, 60);
    out.activeFps = this._clampFps(ms?.renderActiveFps, this._activeFps, 5, 120);
    out.presentationFps = presentation;
    out.continuousFps = this._clampFps(ms?.renderContinuousFps, this._continuousFps, 5, 120);
    return out;
  }

  _getEffectWantsContinuous(nowMs) {
    if (!this.effectComposer?.wantsContinuousRender) return false;
    const now = Number.isFinite(nowMs) ? nowMs : performance.now();
    const pollIntervalMs = this._cachedEffectWantsContinuous ? 120 : 33;
    if ((now - this._lastEffectContinuousCheckMs) < pollIntervalMs) {
      return this._cachedEffectWantsContinuous;
    }
    this._lastEffectContinuousCheckMs = now;
    try {
      this._cachedEffectWantsContinuous = !!this.effectComposer.wantsContinuousRender();
    } catch (_) {}
    return this._cachedEffectWantsContinuous;
  }

  /**
   * Camera Path / environment ramps must keep the compositor presenting every tick.
   * Skipped presents freeze TimeManager delta and all animated effects.
   * @private
   */
  _isTimeCriticalPlaybackActive(ms = window.MapShine) {
    if (ms?.environmentControlApi?.isExternallyDriven?.()) return true;
    const cps = ms?.cameraPathService;
    return cps?.isPlaying === true || cps?.animator?.isActive === true;
  }

  /** @private */
  _isCinematicPresentationActive(nowMs = performance.now(), ms = window.MapShine) {
    return nowMs < (this._cinematicModeUntilMs || 0) || this._isTimeCriticalPlaybackActive(ms);
  }

  /**
   * Cheap camera motion probe (PIXI pivot/scale preferred).
   * @private
   */
  _detectCameraChanged(ms = window.MapShine) {
    const stage = canvas?.stage;
    let fcState = null;
    const fc = ms?.frameCoordinator;
    if (fc?.initialized && fc.getFrameState) fcState = fc.getFrameState();

    const pixi = this._pixiCameraFromCoordinator(fcState, stage);
    const pixiPivotX = pixi.x;
    const pixiPivotY = pixi.y;
    const pixiZoom = pixi.zoom;

    let cameraChanged = false;
    if (typeof pixiPivotX === 'number' && typeof pixiPivotY === 'number' && typeof pixiZoom === 'number') {
      cameraChanged = (
        pixiPivotX !== this._lastPixiPivotX ||
        pixiPivotY !== this._lastPixiPivotY ||
        pixiZoom !== this._lastPixiZoom
      );
    } else {
      const cam = this.camera;
      cameraChanged = (
        cam?.position?.x !== this._lastCamX ||
        cam?.position?.y !== this._lastCamY ||
        cam?.position?.z !== this._lastCamZ ||
        cam?.zoom !== this._lastCamZoom
      );
    }

    const out = this._cameraState;
    out.cameraChanged = cameraChanged;
    out.pixiPivotX = pixiPivotX;
    out.pixiPivotY = pixiPivotY;
    out.pixiZoom = pixiZoom;
    return out;
  }

  _cacheCameraState(pixiPivotX, pixiPivotY, pixiZoom) {
    if (typeof pixiPivotX === 'number') this._lastPixiPivotX = pixiPivotX;
    if (typeof pixiPivotY === 'number') this._lastPixiPivotY = pixiPivotY;
    if (typeof pixiZoom === 'number') this._lastPixiZoom = pixiZoom;
    const cam = this.camera;
    if (cam) {
      this._lastCamX = cam.position.x;
      this._lastCamY = cam.position.y;
      this._lastCamZ = cam.position.z;
      this._lastCamZoom = cam.zoom;
    }
  }

  /**
   * Resolve target presentation FPS for this tick.
   * @private
   */
  _resolveTargetPresentationFps(
    now,
    cameraChanged = false,
    inContinuousWindow = false,
    effectWantsContinuous = false,
    ms = window.MapShine,
  ) {
    const fps = this._readRuntimeFps(ms);
    const out = this._targetFpsState;
    const inCinematicMode = this._isCinematicPresentationActive(now, ms);
    const cameraActive = cameraChanged || now < (this._cameraActiveUntilMs || 0);

    if (inCinematicMode) {
      out.targetFps = 120;
      out.tier = 'cinematic';
      return out;
    }

    // Pan/zoom: cap full compositor presents at active FPS; camera-only ticks run
    // every rAF via tickCameraPipeline so Three matrices stay current between presents.
    if (isCameraNavigationActive()) {
      out.targetFps = fps.activeFps;
      out.tier = 'navigation';
      return out;
    }

    if (cameraActive || this._forceNextRender || this._presentationDueImmediately) {
      out.targetFps = fps.activeFps;
      out.tier = 'active';
      return out;
    }

    if (inContinuousWindow || effectWantsContinuous) {
      const preferred = this._clampFps(
        this.effectComposer?.getPreferredContinuousFps?.(),
        0,
        0,
        120,
      );
      const target = Math.max(fps.presentationFps, preferred > 0 ? preferred : 0);
      out.targetFps = target;
      out.tier = 'presentation';
      return out;
    }

    out.targetFps = fps.idleFps;
    out.tier = 'idle';
    return out;
  }

  /**
   * @returns {boolean} True if a compositor present is due this rAF (for postPixi hook).
   */
  isPresentationDueNow(nowMs = performance.now()) {
    const ms = window.MapShine;
    if (!this.isRunning || !this.effectComposer) return false;
    if (!this._isPresentationPacingEnabled(ms)) return true;
    if (this._isCinematicPresentationActive(nowMs, ms)) return true;
    if (this._presentationDueImmediately || this._forceNextRender) return true;

    const effectWantsContinuous = this._getEffectWantsContinuous(nowMs);
    const inContinuousWindow = nowMs < (this._continuousRenderUntilMs || 0);
    const { cameraChanged } = this._detectCameraChanged(ms);
    const { targetFps } = this._resolveTargetPresentationFps(
      nowMs,
      cameraChanged,
      inContinuousWindow,
      effectWantsContinuous,
      ms,
    );
    const intervalMs = 1000 / Math.max(1, targetFps);
    return (nowMs - (this._lastPresentationMs || 0)) >= intervalMs;
  }

  /**
   * @returns {number} Last resolved target presentation FPS.
   */
  getTargetPresentationFps() {
    return Number(window.MapShine?.__presentationState?.targetFps) || 0;
  }

  _publishPresentationState(
    presented,
    skipReason,
    targetFps,
    tier,
    sinceLastPresentMs,
    cameraChanged = false,
    effectWantsContinuous = false,
    renderPath = 'full',
    continuousReason = 'none',
    holdReason = null,
    ms = window.MapShine,
  ) {
    if (!ms) return;
    const state = this._presentationState;
    state.presented = presented;
    state.skipReason = skipReason;
    state.targetFps = targetFps;
    state.tier = tier;
    state.sinceLastPresentMs = sinceLastPresentMs;
    state.cameraChanged = cameraChanged;
    state.effectWantsContinuous = effectWantsContinuous;
    state.renderPath = renderPath;
    state.continuousReason = continuousReason;
    state.holdReason = holdReason;
    ms.__presentationState = state;
  }

  /**
   * Navigation-lite flags must be set before tickParticleSystems(). FloorCompositor
   * previously published them only during update(), which runs after the particle
   * tick — so fire/dust still simulated every rAF while panning at navigation tier.
   * @private
   */
  _syncV2NavigationLiteFlags(now, ms = window.MapShine) {
    if (!ms) return;

    const { cameraChanged } = this._detectCameraChanged(ms);
    if (cameraChanged) {
      this._cameraActiveUntilMs = now + this._cameraActiveHoldMs;
    }

    const navigationLite = isCameraNavigationActive();
    ms.__v2NavigationLiteUpdates = navigationLite;
    ms.__v2NavigationRenderLite = navigationLite;
  }

  /**
   * Presentation-first gate. Returns whether to run the compositor this rAF.
   * @private
   */
  _evaluatePresentationGate(now, ms = window.MapShine) {
    const sinceLastPresentMs = now - (this._lastPresentationMs || 0);
    const inContinuousWindow = now < (this._continuousRenderUntilMs || 0);
    const effectWantsContinuous = this._getEffectWantsContinuous(now);
    const { cameraChanged, pixiPivotX, pixiPivotY, pixiZoom } = this._detectCameraChanged(ms);

    if (cameraChanged) {
      this._cameraActiveUntilMs = now + this._cameraActiveHoldMs;
    }

    const { targetFps, tier } = this._resolveTargetPresentationFps(
      now,
      cameraChanged,
      inContinuousWindow,
      effectWantsContinuous,
      ms,
    );
    const intervalMs = 1000 / Math.max(1, targetFps);
    const dueByTime = sinceLastPresentMs >= intervalMs;
    const navigationActive = isCameraNavigationActive();
    const shouldPresent = dueByTime
      || this._presentationDueImmediately
      || this._forceNextRender;

    const out = this._gateState;
    out.shouldPresent = shouldPresent;
    out.skipReason = shouldPresent ? 'none' : 'presentation_gate';
    out.targetFps = targetFps;
    out.tier = tier;
    out.sinceLastPresentMs = sinceLastPresentMs;
    out.cameraChanged = cameraChanged;
    out.effectWantsContinuous = effectWantsContinuous;
    out.inContinuousWindow = inContinuousWindow;
    out.navigationActive = navigationActive;
    out.pixiPivotX = pixiPivotX;
    out.pixiPivotY = pixiPivotY;
    out.pixiZoom = pixiZoom;
    out.presentationDeltaSec = 1 / Math.max(1, targetFps);
    return out;
  }

  _drainStrictPixiTokens(fc) {
    if (!this._isStrictSyncEnabled()) return;
    let drained = 0;
    while (drained < STRICT_TOKEN_DRAIN_CAP && fc?.hasPendingPixiToken?.() === true) {
      try { fc.consumePendingPixiToken?.(); } catch (_) {}
      drained++;
    }
  }

  start() {
    if (this.isRunning) {
      log.warn('Render loop already running');
      return;
    }

    log.info('Starting render loop');
    this.isRunning = true;
    const t = performance.now();
    this.lastFrameTime = t;
    this.lastFpsUpdate = t;
    this._lastPresentedFpsUpdate = t;
    this.frameCount = 0;
    this.framesThisSecond = 0;
    this._presentedFramesThisSecond = 0;

    this._forceNextRender = true;
    this._presentationDueImmediately = true;
    this._firstFrameLogged = false;
    this._lastComposerRenderTime = 0;
    this._lastPresentationMs = 0;
    this._lastCamX = null;
    this._lastCamY = null;
    this._lastCamZ = null;
    this._lastCamZoom = null;
    this._lastPixiPivotX = null;
    this._lastPixiPivotY = null;
    this._lastPixiZoom = null;
    this._cachedEffectWantsContinuous = false;
    this._lastEffectContinuousCheckMs = -Infinity;
    this._continuousRenderUntilMs = 0;
    this._cinematicModeUntilMs = 0;
    this._cameraActiveUntilMs = 0;
    this._loadPumpFrameCount = 0;
    this._glContext = this.renderer?.getContext?.() || null;
    this.animationFrameId = requestAnimationFrame(this.render);
  }

  pumpBackgroundLoadFrame() {
    if (!this.isRunning || !this.effectComposer) return;

    if (!this._glContext) this._glContext = this.renderer?.getContext?.();
    if (this._glContext?.isContextLost?.()) return;

    const now = performance.now();
    const ms = window.MapShine;
    const { targetFps } = this._resolveTargetPresentationFps(
      now,
      false,
      false,
      this._getEffectWantsContinuous(now),
      ms,
    );
    const deltaTime = 1 / Math.max(1, targetFps);

    try {
      this.effectComposer.render(deltaTime);
      this._lastComposerRenderTime = now;
      this._lastPresentationMs = now;
      this._forceNextRender = false;
      this._presentationDueImmediately = false;
    } catch (err) {
      log.warn('pumpBackgroundLoadFrame: effectComposer.render failed', err);
      return;
    }

    const fc = ms?.frameCoordinator;
    if (this._isStrictSyncEnabled(ms) && fc?.hasPendingPixiToken?.()) {
      this._drainStrictPixiTokens(fc);
    }

    const { pixiPivotX, pixiPivotY, pixiZoom } = this._detectCameraChanged(ms);
    this._cacheCameraState(pixiPivotX, pixiPivotY, pixiZoom);

    this._loadPumpFrameCount++;
  }

  getLoadPumpFrameCount() {
    return this._loadPumpFrameCount || 0;
  }

  startCinematicMode(durationMs) {
    const d = Math.max(0, Number(durationMs) || 0);
    this._cinematicModeUntilMs = performance.now() + d;
    this._forceNextRender = true;
    this._presentationDueImmediately = true;
  }

  /**
   * Extend cinematic presentation (never shortens an active window).
   * @param {number} durationMs
   */
  extendCinematicMode(durationMs) {
    const d = Math.max(0, Number(durationMs) || 0);
    if (d <= 0) return;
    const until = performance.now() + d;
    if (until > (this._cinematicModeUntilMs || 0)) {
      this._cinematicModeUntilMs = until;
    }
    this._forceNextRender = true;
    this._presentationDueImmediately = true;
  }

  stopCinematicMode() {
    this._cinematicModeUntilMs = 0;
  }

  /**
   * Extend the continuous-render window without forcing an immediate present.
   * Use during drag pointermove so presentation stays capped at active FPS.
   * @param {number} durationMs
   */
  extendContinuousRender(durationMs) {
    const d = Number(durationMs);
    if (!Number.isFinite(d) || d <= 0) return;

    const until = performance.now() + Math.max(0, d);
    if (!this._continuousRenderUntilMs || until > this._continuousRenderUntilMs) {
      this._continuousRenderUntilMs = until;
    }
  }

  requestContinuousRender(durationMs) {
    const d = Number(durationMs);
    if (!Number.isFinite(d) || d <= 0) {
      this._presentationDueImmediately = true;
      this._forceNextRender = true;
      return;
    }

    this.extendContinuousRender(d);
    this._presentationDueImmediately = true;
    this._forceNextRender = true;
  }

  clearContinuousRender() {
    this._continuousRenderUntilMs = 0;
  }

  stop() {
    if (!this.isRunning) return;
    log.info('Stopping render loop');
    this.isRunning = false;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  render() {
    if (!this.isRunning) return;

    this.animationFrameId = requestAnimationFrame(this.render);

    const now = performance.now();
    const ms = window.MapShine;

    const remaining = Number(ms?.__msaDeferredPumpRemaining) || 0;
    if (remaining > 0 && typeof this.pumpBackgroundLoadFrame === 'function') {
      this.pumpBackgroundLoadFrame();
      ms.__msaDeferredPumpRemaining = Math.max(0, remaining - 1);
    }

    const perfRecorder = ms?.performanceRecorder ?? null;
    const tickToken = (perfRecorder?.enabled === true && typeof perfRecorder.beginTick === 'function')
      ? perfRecorder.beginTick(now)
      : null;

    if (!this._glContext) this._glContext = this.renderer?.getContext?.();
    if (this._glContext?.isContextLost?.()) {
      if ((now - this._lastContextLostLogMs) > 2000) {
        this._lastContextLostLogMs = now;
        log.warn('WebGL context is lost — skipping render this frame (rAF loop continues)');
      }
      this._publishPresentationState(
        false,
        'context_lost',
        0,
        'none',
        now - (this._lastPresentationMs || 0),
        false,
        false,
        'full',
        'none',
        null,
        ms,
      );
      if (tickToken != null) perfRecorder.endTick(tickToken, { presented: false, skipReason: 'context_lost' });
      return;
    }

    this.frameCount++;
    this.framesThisSecond++;

    if (now - this.lastFpsUpdate >= this.fpsUpdateInterval) {
      this.fps = this.framesThisSecond;
      this.presentationFps = this._presentedFramesThisSecond;
      this.framesThisSecond = 0;
      this._presentedFramesThisSecond = 0;
      this.lastFpsUpdate = now;
      this._lastPresentedFpsUpdate = now;
    }

    if (this.effectComposer) {
      try {
        const pacingEnabled = this._isPresentationPacingEnabled(ms);
        const timeCriticalPlayback = this._isTimeCriticalPlaybackActive(ms);
        const inCinematicMode = this._isCinematicPresentationActive(now, ms);
        const forcePresent = inCinematicMode;
        const strictSync = this._isStrictSyncEnabled(ms);
        const fc = ms?.frameCoordinator;
        const pendingPixiToken = strictSync && fc?.hasPendingPixiToken?.() === true;

        // Advance sim time once per rAF even if a downstream gate skips the present.
        let timeInfo = null;
        try {
          timeInfo = this.effectComposer.getTimeManager?.()?.update(this.frameCount) ?? null;
        } catch (_) {}

        // Resolve presentation tier before Quarks tick so fire/dust can cap CPU sim Hz.
        let gate = null;
        try {
          gate = this._evaluatePresentationGate(now, ms);
        } catch (_) {
          gate = null;
        }
        if (timeInfo && gate) {
          timeInfo.targetFps = gate.targetFps;
          timeInfo.presentationTier = gate.tier;
        }

        // Quarks weather/ash/fire/etc. must sim every rAF — not only when the compositor presents.
        this._syncV2NavigationLiteFlags(now, ms);
        try {
          this.effectComposer.tickParticleSystems?.(this.frameCount);
        } catch (_) {}

        if (forcePresent) {
          if (!gate) gate = this._evaluatePresentationGate(now, ms);
          gate.shouldPresent = true;
          gate.skipReason = 'none';
        } else if (pacingEnabled) {
          if (!gate) gate = this._evaluatePresentationGate(now, ms);
          this._publishPresentationState(
            false,
            gate.skipReason,
            gate.targetFps,
            gate.tier,
            gate.sinceLastPresentMs,
            gate.cameraChanged,
            gate.effectWantsContinuous,
            'full',
            'none',
            null,
            ms,
          );

          if (!gate.shouldPresent && !pendingPixiToken) {
            // Keep PIXI→Three camera sync current when the heavy compositor present
            // is gated — especially during navigation pan (active FPS cap).
            if (gate.cameraChanged || gate.navigationActive || isCameraNavigationActive()) {
              try {
                const wallDelta = Math.max(0, Math.min((now - this.lastFrameTime) / 1000, 0.1));
                this.effectComposer.tickCameraPipeline?.(wallDelta, timeInfo);
                const { pixiPivotX, pixiPivotY, pixiZoom } = this._detectCameraChanged(ms);
                this._cacheCameraState(pixiPivotX, pixiPivotY, pixiZoom);
              } catch (_) {}
            }
            if (tickToken != null) {
              perfRecorder.endTick(tickToken, {
                presented: false,
                skipReason: 'presentation_gate',
                targetFps: gate.targetFps,
                tier: gate.tier,
                sinceLastPresentMs: gate.sinceLastPresentMs,
                renderPath: null,
              });
            }
            return;
          }
        } else {
          gate = this._evaluateLegacyAdaptivePath(now, ms, strictSync, fc, pendingPixiToken);
          if (!gate.shouldPresent) {
            if (tickToken != null) {
              perfRecorder.endTick(tickToken, {
                presented: false,
                skipReason: gate.skipReason,
                targetFps: gate.targetFps,
                tier: gate.tier,
                sinceLastPresentMs: gate.sinceLastPresentMs,
                renderPath: null,
              });
            }
            return;
          }
        }

        if (!gate) {
          gate = this._evaluatePresentationGate(now, ms);
          gate.shouldPresent = true;
        }

        const presentationDelta = gate.presentationDeltaSec ?? ((now - this.lastFrameTime) / 1000);
        this.lastFrameTime = now;

        if (!strictSync) this._strictHoldState.active = false;
        const holdFrame = strictSync ? this._getStrictHoldState(ms) : this._strictHoldState;
        const holdAgeMs = holdFrame.active ? (now - holdFrame.updatedAtMs) : 0;
        const holdExpired = holdFrame.active && holdAgeMs > STRICT_HOLD_MAX_MS;
        if (holdFrame.active && !holdExpired && !timeCriticalPlayback) {
          this._publishPresentationState(
            false,
            'strict_hold',
            gate.targetFps,
            gate.tier,
            gate.sinceLastPresentMs,
            false,
            false,
            'full',
            'none',
            holdFrame.reason,
            ms,
          );
          try {
            const counters = ms.__renderStrictCounters ?? (ms.__renderStrictCounters = {});
            counters.holdFrames = (counters.holdFrames || 0) + 1;
            counters.lastHoldReason = holdFrame.reason;
            counters.lastHoldAtMs = now;
          } catch (_) {}
          try { fc?.consumePendingPixiToken?.(); } catch (_) {}
          if (tickToken != null) {
            perfRecorder.endTick(tickToken, {
              presented: false,
              skipReason: 'strict_hold',
              targetFps: gate.targetFps,
              tier: gate.tier,
              sinceLastPresentMs: gate.sinceLastPresentMs,
              renderPath: 'strict-hold',
            });
          }
          return;
        }

        const _isFirstFrame = !this._firstFrameLogged;
        const _t0 = _isFirstFrame ? performance.now() : 0;
        const _tComposer0 = tickToken != null ? performance.now() : 0;

        this.effectComposer.render(presentationDelta);
        const compositorMs = tickToken != null ? (performance.now() - _tComposer0) : 0;
        this._lastComposerRenderTime = now;
        this._lastPresentationMs = now;
        this._forceNextRender = false;
        this._presentationDueImmediately = false;
        this._presentedFramesThisSecond++;

        const renderPath = ms?.__v2CompositorRenderPath ?? 'full';
        const continuousReason = ms?.__v2ContinuousRenderReason ?? 'none';

        this._publishPresentationState(
          true,
          'none',
          gate.targetFps,
          gate.tier,
          0,
          gate.cameraChanged,
          gate.effectWantsContinuous,
          renderPath,
          continuousReason,
          null,
          ms,
        );

        if (strictSync) {
          this._drainStrictPixiTokens(fc);
          try {
            const counters = ms.__renderStrictCounters ?? (ms.__renderStrictCounters = {});
            counters.compositorRenders = (counters.compositorRenders || 0) + 1;
          } catch (_) {}
        }

        this._cacheCameraState(gate.pixiPivotX, gate.pixiPivotY, gate.pixiZoom);

        if (tickToken != null) {
          perfRecorder.endTick(tickToken, {
            presented: true,
            skipReason: 'none',
            targetFps: gate.targetFps,
            tier: gate.tier,
            sinceLastPresentMs: gate.sinceLastPresentMs,
            renderPath,
            continuousReason,
            compositorMs,
          });
        }

        if (ms?.__v2StartupTraceEnabled === true && this.frameCount <= 8) {
          try {
            const entry = {
              phase: 'renderLoop.postComposer',
              rafFrame: Number(this.frameCount ?? -1),
              targetFps: gate.targetFps,
              tier: gate.tier,
              compositorPath: renderPath,
            };
            if (!Array.isArray(ms.__v2StartupTrace)) ms.__v2StartupTrace = [];
            ms.__v2StartupTrace.push(entry);
            if (ms.__v2StartupTrace.length > 128) ms.__v2StartupTrace.shift();
          } catch (_) {}
        }

        if (_isFirstFrame) {
          this._firstFrameLogged = true;
          const _renderMs = performance.now() - _t0;
          if (_renderMs > 100) {
            log.warn(`First frame took ${_renderMs.toFixed(0)}ms — possible residual shader compilation`);
          } else {
            log.info(`First frame rendered in ${_renderMs.toFixed(0)}ms (target ${gate.targetFps}fps)`);
          }
        }
      } catch (error) {
        log.error('Effect composer render error:', error);
        if (tickToken != null) {
          try { perfRecorder.endTick(tickToken, { presented: false, skipReason: 'composer_error' }); } catch (_) {}
        }
      }
      return;
    }

    const deltaTime = (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;

    try {
      if (this.renderer.setClearColor) this.renderer.setClearColor(0x000000, 1);
      if (this.renderer.autoClear === false) this.renderer.autoClear = true;
      this.renderer.render(this.scene, this.camera);
    } catch (error) {
      log.error('Renderer error:', error);
      this.stop();
    }
  }

  /**
   * Legacy adaptive path when presentation pacing is explicitly disabled.
   * @private
   */
  _evaluateLegacyAdaptivePath(now, ms, strictSync, fc, pendingPixiToken) {
    if (this._isTimeCriticalPlaybackActive(ms)) {
      const gate = this._evaluatePresentationGate(now, ms);
      gate.shouldPresent = true;
      gate.skipReason = 'none';
      gate.tier = 'cinematic';
      return gate;
    }

    const { cameraChanged, pixiPivotX, pixiPivotY, pixiZoom } = this._detectCameraChanged(ms);
    const adaptiveFpsEnabled = strictSync ? false : (ms?.renderAdaptiveFpsEnabled !== false);
    const inContinuousWindow = now < (this._continuousRenderUntilMs || 0);
    const effectWantsContinuous = inContinuousWindow || this._getEffectWantsContinuous(now);
    const fps = this._readRuntimeFps(ms);
    const preferredContinuousFps = this._clampFps(
      this.effectComposer?.getPreferredContinuousFps?.(),
      0,
      0,
      120,
    );
    const effectiveContinuousFps = Math.max(fps.continuousFps, preferredContinuousFps);

    let shouldRender = this._forceNextRender || cameraChanged || effectWantsContinuous || pendingPixiToken;
    let targetFps = fps.idleFps;
    let skipReason = 'none';

    if (!shouldRender) {
      const since = now - (this._lastComposerRenderTime || 0);
      if (since >= 1000 / Math.max(1, fps.idleFps)) shouldRender = true;
    }

    if (shouldRender && adaptiveFpsEnabled) {
      if (this._forceNextRender || cameraChanged) targetFps = fps.activeFps;
      else if (effectWantsContinuous) targetFps = effectiveContinuousFps;
      const since = now - (this._lastComposerRenderTime || 0);
      if (since < 1000 / Math.max(1, targetFps)) {
        shouldRender = false;
        skipReason = 'legacy_adaptive_cap';
      }
    }

    if (strictSync && pendingPixiToken) shouldRender = true;

    const out = this._gateState;
    out.shouldPresent = shouldRender;
    out.skipReason = shouldRender ? 'none' : skipReason;
    out.targetFps = targetFps;
    out.tier = 'legacy';
    out.sinceLastPresentMs = now - (this._lastPresentationMs || 0);
    out.cameraChanged = cameraChanged;
    out.effectWantsContinuous = effectWantsContinuous;
    out.inContinuousWindow = inContinuousWindow;
    out.navigationActive = isCameraNavigationActive();
    out.pixiPivotX = pixiPivotX;
    out.pixiPivotY = pixiPivotY;
    out.pixiZoom = pixiZoom;
    out.presentationDeltaSec = shouldRender ? (1 / Math.max(1, targetFps)) : 0;
    return out;
  }

  getFPS() {
    return this.fps;
  }

  getPresentationFPS() {
    return this.presentationFps;
  }

  getFrameCount() {
    return this.frameCount;
  }

  running() {
    return this.isRunning;
  }

  setEffectComposer(composer) {
    this.effectComposer = composer;
    this._forceNextRender = true;
    this._presentationDueImmediately = true;
    this._cachedEffectWantsContinuous = false;
    this._lastEffectContinuousCheckMs = -Infinity;
    log.debug('Effect composer set');
  }

  requestRender() {
    this._presentationDueImmediately = true;
    this._forceNextRender = true;
  }
}
