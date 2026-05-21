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

    this.render = this.render.bind(this);
  }

  _isStrictSyncEnabled() {
    return window?.MapShine?.renderStrictSyncEnabled === true;
  }

  _isPresentationPacingEnabled() {
    return window?.MapShine?.renderPresentationPacingEnabled !== false;
  }

  _getStrictHoldState() {
    const flag = window?.MapShine?.renderStrictHoldFrame;
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
    const sx = stage?.pivot?.x;
    const sy = stage?.pivot?.y;
    const sz = stage?.scale?.x;
    const fx = fcState?.cameraX;
    const fy = fcState?.cameraY;
    const fz = fcState?.zoom;
    return {
      x: Number.isFinite(fx) ? fx : sx,
      y: Number.isFinite(fy) ? fy : sy,
      zoom: Number.isFinite(fz) ? fz : sz,
    };
  }

  _clampFps(value, fallback, min = 5, max = 120) {
    let n = +value;
    if (n !== n) return fallback;
    n = n | 0;
    return n < min ? min : (n > max ? max : n);
  }

  _readRuntimeFps() {
    const ms = window.MapShine;
    const presentation = this._clampFps(
      ms?.renderPresentationFps ?? ms?.renderContinuousFps,
      this._presentationFps,
      5,
      60,
    );
    return {
      idleFps: this._clampFps(ms?.renderIdleFps, this._idleFps, 5, 60),
      activeFps: this._clampFps(ms?.renderActiveFps, this._activeFps, 5, 120),
      presentationFps: presentation,
      continuousFps: this._clampFps(ms?.renderContinuousFps, this._continuousFps, 5, 120),
    };
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
   * Cheap camera motion probe (PIXI pivot/scale preferred).
   * @private
   */
  _detectCameraChanged() {
    const stage = canvas?.stage;
    let fcState = null;
    try {
      const fc = window.MapShine?.frameCoordinator;
      if (fc?.initialized && fc.getFrameState) fcState = fc.getFrameState();
    } catch (_) {}

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

    return { cameraChanged, pixiPivotX, pixiPivotY, pixiZoom };
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
  _resolveTargetPresentationFps(now, opts = {}) {
    const { cameraChanged = false, inContinuousWindow = false, effectWantsContinuous = false } = opts;
    const fps = this._readRuntimeFps();
    const ms = window.MapShine;
    const inCinematicMode = now < (this._cinematicModeUntilMs || 0);
    const cameraActive = cameraChanged || now < (this._cameraActiveUntilMs || 0);

    if (inCinematicMode) return { targetFps: 120, tier: 'cinematic' };

    if (cameraActive || this._forceNextRender || this._presentationDueImmediately) {
      // Rapid pan at 60 Active FPS often exceeds 16.6ms GPU budget (~18ms presents).
      // Cap to Presentation FPS during navigation for steady spacing (e.g. 30Hz / 33ms).
      if (isCameraNavigationActive()) {
        const navCap = Math.min(fps.activeFps, fps.presentationFps);
        return { targetFps: navCap, tier: 'navigation' };
      }
      return { targetFps: fps.activeFps, tier: 'active' };
    }

    if (inContinuousWindow || effectWantsContinuous) {
      const preferred = this._clampFps(
        this.effectComposer?.getPreferredContinuousFps?.(),
        0,
        0,
        120,
      );
      const target = Math.max(fps.presentationFps, preferred > 0 ? preferred : 0);
      return { targetFps: target, tier: 'presentation' };
    }

    return { targetFps: fps.idleFps, tier: 'idle' };
  }

  /**
   * @returns {boolean} True if a compositor present is due this rAF (for postPixi hook).
   */
  isPresentationDueNow(nowMs = performance.now()) {
    if (!this.isRunning || !this.effectComposer) return false;
    if (!this._isPresentationPacingEnabled()) return true;
    if (nowMs < (this._cinematicModeUntilMs || 0)) return true;
    if (this._presentationDueImmediately || this._forceNextRender) return true;

    const effectWantsContinuous = this._getEffectWantsContinuous(nowMs);
    const inContinuousWindow = nowMs < (this._continuousRenderUntilMs || 0);
    const { targetFps } = this._resolveTargetPresentationFps(nowMs, {
      cameraChanged: false,
      inContinuousWindow,
      effectWantsContinuous,
    });
    const intervalMs = 1000 / Math.max(1, targetFps);
    return (nowMs - (this._lastPresentationMs || 0)) >= intervalMs;
  }

  /**
   * @returns {number} Last resolved target presentation FPS.
   */
  getTargetPresentationFps() {
    return Number(window.MapShine?.__presentationState?.targetFps) || 0;
  }

  _publishPresentationState(state) {
    try {
      const ms = window.MapShine;
      if (!ms) return;
      ms.__presentationState = state;
    } catch (_) {}
  }

  /**
   * Presentation-first gate. Returns whether to run the compositor this rAF.
   * @private
   */
  _evaluatePresentationGate(now) {
    const sinceLastPresentMs = now - (this._lastPresentationMs || 0);
    const inContinuousWindow = now < (this._continuousRenderUntilMs || 0);
    const effectWantsContinuous = this._getEffectWantsContinuous(now);
    const { cameraChanged, pixiPivotX, pixiPivotY, pixiZoom } = this._detectCameraChanged();

    if (cameraChanged) {
      this._cameraActiveUntilMs = now + this._cameraActiveHoldMs;
    }

    const { targetFps, tier } = this._resolveTargetPresentationFps(now, {
      cameraChanged,
      inContinuousWindow,
      effectWantsContinuous,
    });
    const intervalMs = 1000 / Math.max(1, targetFps);
    const dueByTime = sinceLastPresentMs >= intervalMs;
    const shouldPresent = dueByTime || this._presentationDueImmediately || this._forceNextRender;

    return {
      shouldPresent,
      skipReason: shouldPresent ? 'none' : 'presentation_gate',
      targetFps,
      tier,
      sinceLastPresentMs,
      cameraChanged,
      effectWantsContinuous,
      inContinuousWindow,
      pixiPivotX,
      pixiPivotY,
      pixiZoom,
      presentationDeltaSec: 1 / Math.max(1, targetFps),
    };
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
    const { targetFps } = this._resolveTargetPresentationFps(now, {
      effectWantsContinuous: this._getEffectWantsContinuous(now),
    });
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

    const ms = window.MapShine;
    const fc = ms?.frameCoordinator;
    if (this._isStrictSyncEnabled() && fc?.hasPendingPixiToken?.()) {
      this._drainStrictPixiTokens(fc);
    }

    try {
      const { pixiPivotX, pixiPivotY, pixiZoom } = this._detectCameraChanged();
      this._cacheCameraState(pixiPivotX, pixiPivotY, pixiZoom);
    } catch (_) {}

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

  stopCinematicMode() {
    this._cinematicModeUntilMs = 0;
  }

  requestContinuousRender(durationMs) {
    const d = Number(durationMs);
    if (!Number.isFinite(d) || d <= 0) {
      this._presentationDueImmediately = true;
      this._forceNextRender = true;
      return;
    }

    const until = performance.now() + Math.max(0, d);
    if (!this._continuousRenderUntilMs || until > this._continuousRenderUntilMs) {
      this._continuousRenderUntilMs = until;
    }
    this._presentationDueImmediately = true;
    this._forceNextRender = true;
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

    try {
      const ms = window.MapShine;
      const remaining = Number(ms?.__msaDeferredPumpRemaining) || 0;
      if (remaining > 0 && typeof this.pumpBackgroundLoadFrame === 'function') {
        this.pumpBackgroundLoadFrame();
        ms.__msaDeferredPumpRemaining = Math.max(0, remaining - 1);
      }
    } catch (_) {}

    const perfRecorder = (typeof window !== 'undefined') ? window?.MapShine?.performanceRecorder : null;
    const tickToken = (perfRecorder?.enabled === true && typeof perfRecorder.beginTick === 'function')
      ? perfRecorder.beginTick(now)
      : null;

    if (!this._glContext) this._glContext = this.renderer?.getContext?.();
    if (this._glContext?.isContextLost?.()) {
      if ((now - this._lastContextLostLogMs) > 2000) {
        this._lastContextLostLogMs = now;
        log.warn('WebGL context is lost — skipping render this frame (rAF loop continues)');
      }
      this._publishPresentationState({
        presented: false,
        skipReason: 'context_lost',
        targetFps: 0,
        tier: 'none',
        sinceLastPresentMs: now - (this._lastPresentationMs || 0),
      });
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
        const ms = window.MapShine;
        const pacingEnabled = this._isPresentationPacingEnabled();
        const inCinematicMode = now < (this._cinematicModeUntilMs || 0);
        const strictSync = this._isStrictSyncEnabled();
        const fc = ms?.frameCoordinator;
        const pendingPixiToken = strictSync && fc?.hasPendingPixiToken?.() === true;

        let gate = null;
        if (pacingEnabled && !inCinematicMode) {
          gate = this._evaluatePresentationGate(now);
          this._publishPresentationState({
            presented: false,
            skipReason: gate.skipReason,
            targetFps: gate.targetFps,
            tier: gate.tier,
            sinceLastPresentMs: gate.sinceLastPresentMs,
            cameraChanged: gate.cameraChanged,
            effectWantsContinuous: gate.effectWantsContinuous,
          });

          if (!gate.shouldPresent && !pendingPixiToken) {
            if (tickToken != null) {
              perfRecorder.endTick(tickToken, {
                presented: false,
                skipReason: 'presentation_gate',
                targetFps: gate.targetFps,
                sinceLastPresentMs: gate.sinceLastPresentMs,
                renderPath: null,
              });
            }
            return;
          }
        } else if (!pacingEnabled) {
          gate = this._evaluateLegacyAdaptivePath(now, ms, strictSync, fc, pendingPixiToken);
          if (!gate.shouldPresent) {
            if (tickToken != null) {
              perfRecorder.endTick(tickToken, {
                presented: false,
                skipReason: gate.skipReason,
                targetFps: gate.targetFps,
                sinceLastPresentMs: gate.sinceLastPresentMs,
                renderPath: null,
              });
            }
            return;
          }
        } else {
          gate = this._evaluatePresentationGate(now);
          gate.shouldPresent = true;
          gate.skipReason = 'none';
        }

        if (!gate) {
          gate = this._evaluatePresentationGate(now);
          gate.shouldPresent = true;
        }

        const presentationDelta = gate.presentationDeltaSec ?? ((now - this.lastFrameTime) / 1000);
        this.lastFrameTime = now;

        if (!strictSync) this._strictHoldState.active = false;
        const holdFrame = strictSync ? this._getStrictHoldState() : this._strictHoldState;
        const holdAgeMs = holdFrame.active ? (now - holdFrame.updatedAtMs) : 0;
        const holdExpired = holdFrame.active && holdAgeMs > STRICT_HOLD_MAX_MS;
        if (holdFrame.active && !holdExpired) {
          this._publishPresentationState({
            presented: false,
            skipReason: 'strict_hold',
            targetFps: gate.targetFps,
            tier: gate.tier,
            sinceLastPresentMs: gate.sinceLastPresentMs,
            holdReason: holdFrame.reason,
          });
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
              sinceLastPresentMs: gate.sinceLastPresentMs,
              renderPath: 'strict-hold',
            });
          }
          return;
        }

        const _isFirstFrame = !this._firstFrameLogged;
        const _t0 = _isFirstFrame ? performance.now() : 0;

        this.effectComposer.render(presentationDelta);
        this._lastComposerRenderTime = now;
        this._lastPresentationMs = now;
        this._forceNextRender = false;
        this._presentationDueImmediately = false;
        this._presentedFramesThisSecond++;

        const renderPath = ms?.__v2CompositorRenderPath ?? 'full';
        const continuousReason = ms?.__v2ContinuousRenderReason ?? 'none';

        this._publishPresentationState({
          presented: true,
          skipReason: 'none',
          targetFps: gate.targetFps,
          tier: gate.tier,
          sinceLastPresentMs: 0,
          cameraChanged: gate.cameraChanged,
          effectWantsContinuous: gate.effectWantsContinuous,
          renderPath,
          continuousReason,
        });

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
            sinceLastPresentMs: gate.sinceLastPresentMs,
            renderPath,
            continuousReason,
          });
        }

        if (window.MapShine?.__v2StartupTraceEnabled === true && this.frameCount <= 8) {
          try {
            const entry = {
              phase: 'renderLoop.postComposer',
              rafFrame: Number(this.frameCount ?? -1),
              targetFps: gate.targetFps,
              tier: gate.tier,
              compositorPath: renderPath,
            };
            if (!Array.isArray(window.MapShine.__v2StartupTrace)) window.MapShine.__v2StartupTrace = [];
            window.MapShine.__v2StartupTrace.push(entry);
            if (window.MapShine.__v2StartupTrace.length > 128) window.MapShine.__v2StartupTrace.shift();
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
    const { cameraChanged, pixiPivotX, pixiPivotY, pixiZoom } = this._detectCameraChanged();
    const adaptiveFpsEnabled = strictSync ? false : (ms?.renderAdaptiveFpsEnabled !== false);
    const inContinuousWindow = now < (this._continuousRenderUntilMs || 0);
    const effectWantsContinuous = inContinuousWindow || this._getEffectWantsContinuous(now);
    const fps = this._readRuntimeFps();
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

    return {
      shouldPresent: shouldRender,
      skipReason: shouldRender ? 'none' : skipReason,
      targetFps,
      tier: 'legacy',
      sinceLastPresentMs: now - (this._lastPresentationMs || 0),
      cameraChanged,
      effectWantsContinuous,
      inContinuousWindow,
      pixiPivotX,
      pixiPivotY,
      pixiZoom,
      presentationDeltaSec: shouldRender ? (1 / Math.max(1, targetFps)) : 0,
    };
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
