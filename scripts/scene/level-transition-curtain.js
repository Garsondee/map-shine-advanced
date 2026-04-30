/**
 * @fileoverview Level transition curtain — fade-to-black overlay during floor/level changes.
 *
 * Patches CameraFollower._emitLevelContextChanged to defer Hooks.callAll until the
 * overlay is fully black, then fades back in after a lightweight settle heuristic.
 *
 * @module scene/level-transition-curtain
 */

import { createLogger } from '../core/log.js';
import { getShaderCompileMonitor } from '../core/diagnostics/ShaderCompileMonitor.js';
import { loadingOverlay } from '../ui/loading-overlay.js';

const log = createLogger('LevelTransitionCurtain');

const FADE_OUT_MS = 380;
const FADE_IN_MS = 480;
const MIN_BLACK_HOLD_MS = 7200;
const QUIET_DEBOUNCE_MS = 650;
const SETTLED_FRAMES_REQUIRED = 8;
const CONTINUOUS_RENDER_SETTLE_MS = 1400;
const HARD_CAP_BLACK_MS = 14000;

/**
 * Coordinates loading overlay around mapShineLevelContextChanged emissions.
 */
export class LevelTransitionCurtain {
  constructor() {
    /** @type {object|null} */
    this._cameraFollower = null;
    /** @type {((reason?: string) => void)|null} */
    this._rawEmit = null;
    /** @type {'idle'|'fadingOut'|'black'|'fadingIn'} */
    this._state = 'idle';
    /** @type {object|null} */
    this._pendingPayload = null;
    /** @type {string} */
    this._transitionSubtitle = '';
    /** @type {string} */
    this._transitionFromLabel = '';
    /** @type {string} */
    this._transitionToLabel = '';
    /** @type {string} */
    this._pendingReason = 'unknown';
    /** @type {number} */
    this._lastEmitAt = 0;
    /** @type {number} */
    this._blackStartedAt = 0;
    /** @type {number} */
    this._minBlackUntilMs = 0;
    /** @type {number} */
    this._quietRafCount = 0;
    /** @type {number} */
    this._settleRafId = 0;
    /** @type {boolean} */
    this._dirtyFlush = false;
    /** @type {boolean} */
    this._disposed = false;
    /** @type {(reason?: string) => void} */
    this._boundPatch = (reason) => this._handleEmit(reason);
  }

  /**
   * @param {object} cameraFollower - CameraFollower instance
   */
  register(cameraFollower) {
    this._teardownPatch();
    this._disposed = false;
    if (!cameraFollower || typeof cameraFollower._emitLevelContextChanged !== 'function') {
      log.warn('register: invalid cameraFollower');
      return;
    }
    this._cameraFollower = cameraFollower;
    this._rawEmit = cameraFollower._emitLevelContextChanged.bind(cameraFollower);
    cameraFollower._emitLevelContextChangedRaw = this._rawEmit;
    cameraFollower._emitLevelContextChanged = this._boundPatch;
    log.info('Level transition curtain registered');
  }

  dispose() {
    this._disposed = true;
    this._teardownPatch();
  }

  _teardownPatch() {
    this._cancelSettleLoop();
    if (this._cameraFollower && this._rawEmit) {
      try {
        this._cameraFollower._emitLevelContextChanged = this._rawEmit;
      } catch (_) {}
      try {
        delete this._cameraFollower._emitLevelContextChangedRaw;
      } catch (_) {}
    }
    this._cameraFollower = null;
    this._rawEmit = null;
    this._state = 'idle';
    this._pendingPayload = null;
    this._transitionSubtitle = '';
    this._transitionFromLabel = '';
    this._transitionToLabel = '';
  }

  /**
   * @param {string} [reason]
   */
  _handleEmit(reason = 'unknown') {
    try {
      const cf = this._cameraFollower;
      if (!cf || !this._rawEmit) {
        return;
      }

      const payload = {
        context: cf.getActiveLevelContext(),
        levels: cf.getAvailableLevels(),
        diagnostics: cf.getLevelDiagnostics(),
        reason,
        lockMode: cf._lockMode,
      };
      const previousContext = window.MapShine?.activeLevelContext ?? null;
      const fromLabel = this._labelForContext(previousContext, 'Current level');
      const toLabel = this._labelForContext(payload.context, 'Next level');

      if (window.MapShine) {
        window.MapShine.activeLevelContext = payload.context;
        window.MapShine.availableLevels = payload.levels;
        window.MapShine.levelNavigationDiagnostics = payload.diagnostics;
      }

      if (this._shouldBypass()) {
        this._rawEmit(reason);
        return;
      }

      this._pendingPayload = payload;
      if (this._state === 'idle') {
        this._transitionFromLabel = fromLabel;
        this._transitionToLabel = toLabel;
      } else {
        // Keep the original source level for the whole transition burst and
        // only advance destination as additional requests are coalesced.
        this._transitionToLabel = toLabel;
      }
      this._transitionSubtitle = this._buildTransitionSubtitle(
        this._transitionFromLabel || fromLabel,
        this._transitionToLabel || toLabel,
      );
      this._pendingReason = reason;
      this._lastEmitAt = performance.now();
      this._dirtyFlush = true;

      if (this._state === 'idle') {
        void this._beginCurtain();
      } else if (this._state === 'black') {
        // settle loop will observe _dirtyFlush
      } else if (this._state === 'fadingOut') {
        // latest payload kept; flush happens once fade completes
      } else if (this._state === 'fadingIn') {
        void this._snapBackToBlackAndContinue();
      }
    } catch (err) {
      log.warn('Curtain handler failed; falling back to raw emit', err);
      try {
        this._rawEmit?.(reason);
      } catch (_) {}
    }
  }

  /**
   * @returns {boolean}
   */
  _shouldBypass() {
    try {
      const ms = window.MapShine;
      if (!ms) return true;
      if (ms.__sceneTransitionActive) return true;
      const rl = ms.renderLoop;
      if (!rl || typeof rl.running !== 'function' || !rl.running()) return true;
      if (!loadingOverlay) return true;
    } catch (_) {
      return true;
    }
    return false;
  }

  async _beginCurtain() {
    if (this._disposed || this._state !== 'idle') return;

    this._state = 'fadingOut';
    this._quietRafCount = 0;

    try {
      loadingOverlay.ensure();
      loadingOverlay.setMessage('Changing floor…');
      loadingOverlay.configureStages([
        { id: 'apply', label: 'Applying…', weight: 1 },
        { id: 'settle', label: 'Settling…', weight: 1 },
      ]);
      loadingOverlay.startStages();
      loadingOverlay.startAutoProgress(0.6, 0.05);
      loadingOverlay.setStage('apply', 0.1);

      await loadingOverlay.fadeToBlack(FADE_OUT_MS, 140);
    } catch (err) {
      log.warn('fadeToBlack failed; raw emit', err);
      this._state = 'idle';
      try {
        this._rawEmit?.(this._pendingReason || 'unknown');
      } catch (_) {}
      return;
    }

    if (this._disposed || this._state !== 'fadingOut') return;

    this._state = 'black';
    const now = performance.now();
    this._blackStartedAt = now;
    this._minBlackUntilMs = now + MIN_BLACK_HOLD_MS;

    try {
      // fadeToBlack hides content by design; restore the loading UI while
      // keeping the screen black so users can actually see progress.
      this._showBlackOverlayUi();
      loadingOverlay.setStage('apply', 0.5);
      this._flushPendingHook();
      this._dirtyFlush = false;
    } catch (err) {
      log.warn('flush after fade failed', err);
    }

    this._startSettleLoop();
  }

  async _snapBackToBlackAndContinue() {
    try {
      // If a new level-change burst starts while we were fading back in,
      // re-enter black with a real transition instead of snapping abruptly.
      await loadingOverlay.fadeToBlack(220, 80);
    } catch (_) {}

    try {
      this._showBlackOverlayUi();
    } catch (_) {}

    this._cancelSettleLoop();
    this._state = 'black';
    const now = performance.now();
    this._blackStartedAt = now;
    this._minBlackUntilMs = now + MIN_BLACK_HOLD_MS;
    this._quietRafCount = 0;

    try {
      this._flushPendingHook();
      this._dirtyFlush = false;
    } catch (err) {
      log.warn('snapBack flush failed', err);
    }

    this._startSettleLoop();
  }

  _flushPendingHook() {
    const payload = this._pendingPayload;
    if (!payload) return;

    try {
      Hooks.callAll('mapShineLevelContextChanged', payload);
    } catch (_) {}

    try {
      const ms = window.MapShine;
      ms?.depthPassManager?.invalidate?.();
      ms?.renderLoop?.requestRender?.();
      ms?.renderLoop?.requestContinuousRender?.(CONTINUOUS_RENDER_SETTLE_MS);
    } catch (_) {}

    log.debug('Flushed mapShineLevelContextChanged behind curtain', payload?.reason);
  }

  _cancelSettleLoop() {
    if (this._settleRafId) {
      try {
        cancelAnimationFrame(this._settleRafId);
      } catch (_) {}
    }
    this._settleRafId = 0;
  }

  _startSettleLoop() {
    this._cancelSettleLoop();

    const loop = () => {
      if (this._disposed || this._state !== 'black') return;

      // Other systems can trigger their own overlay transitions; keep ours visible
      // throughout the level curtain so we do not flash/hide unexpectedly.
      this._ensureOverlayVisibleDuringBlack();

      if (this._dirtyFlush) {
        try {
          this._flushPendingHook();
        } catch (_) {}
        this._dirtyFlush = false;
      }

      const t = performance.now();

      if (t - this._blackStartedAt > HARD_CAP_BLACK_MS) {
        log.warn('LevelTransitionCurtain: hard cap black duration — forcing fade-in');
        this._completeFadeIn();
        return;
      }

      if (t - this._lastEmitAt < QUIET_DEBOUNCE_MS) {
        this._quietRafCount = 0;
      } else {
        const ms = window.MapShine;
        const rl = ms?.renderLoop;
        const continuousDone = !rl || t > (rl._continuousRenderUntilMs ?? 0);

        let shadersIdle = true;
        try {
          shadersIdle = getShaderCompileMonitor().getStats().activeCompiles === 0;
        } catch (_) {}

        const floorCompositorSettled = this._isFloorCompositorSettled(ms);

        if (continuousDone && shadersIdle && floorCompositorSettled) {
          this._quietRafCount += 1;
        } else {
          this._quietRafCount = 0;
        }
      }

      try {
        const p = Math.min(
          1,
          SETTLED_FRAMES_REQUIRED <= 0 ? 1 : this._quietRafCount / SETTLED_FRAMES_REQUIRED,
        );
        loadingOverlay.setStage('settle', p);
      } catch (_) {}

      if (this._quietRafCount >= SETTLED_FRAMES_REQUIRED && t >= this._minBlackUntilMs) {
        try {
          loadingOverlay.setProgress(1, { immediate: true });
          loadingOverlay.setStage('settle', 1.0);
        } catch (_) {}
        this._completeFadeIn();
        return;
      }

      this._settleRafId = requestAnimationFrame(loop);
    };

    this._settleRafId = requestAnimationFrame(loop);
  }

  _showBlackOverlayUi() {
    loadingOverlay.showBlack('Changing floor…');
    loadingOverlay.setSubtitle?.(this._transitionSubtitle || 'Changing level');
    loadingOverlay.configureStages([
      { id: 'apply', label: 'Applying…', weight: 1 },
      { id: 'settle', label: 'Settling…', weight: 1 },
    ]);
    loadingOverlay.startStages();
    loadingOverlay.startAutoProgress(0.6, 0.05);
  }

  _ensureOverlayVisibleDuringBlack() {
    try {
      const el = loadingOverlay?.el;
      if (!el || el.style.display === 'none') {
        this._showBlackOverlayUi();
      }
    } catch (_) {}
  }

  _completeFadeIn() {
    this._cancelSettleLoop();
    if (this._disposed) return;

    this._state = 'fadingIn';

    try {
      loadingOverlay.stopAutoProgress?.();
    } catch (_) {}

    loadingOverlay.fadeIn(FADE_IN_MS, 180).then(() => {
      if (!this._disposed) this._state = 'idle';
    }).catch(() => {
      if (!this._disposed) this._state = 'idle';
    });
  }

  /**
   * Require compositor populate/repopulate work to settle before fade-in.
   * @param {object|null|undefined} mapShine
   * @returns {boolean}
   */
  _isFloorCompositorSettled(mapShine) {
    const fc = mapShine?.floorCompositorV2 ?? mapShine?.effectComposer?._floorCompositorV2 ?? null;
    if (!fc) return true;
    if (fc._populatePromise && fc._populateComplete !== true) return false;
    if (fc._populateComplete === false) return false;
    if (fc._busPopulated === false) return false;
    return true;
  }

  /**
   * @param {string} fromLabel
   * @param {string} toLabel
   * @returns {string}
   */
  _buildTransitionSubtitle(fromLabel, toLabel) {
    const from = String(fromLabel || '').trim() || 'Current level';
    const to = String(toLabel || '').trim() || 'Next level';
    return `Changing from ${from} to ${to}`;
  }

  /**
   * @param {object|null} context
   * @param {string} fallback
   * @returns {string}
   */
  _labelForContext(context, fallback) {
    const label = String(context?.label || '').trim();
    if (label) return label;
    const idx = Number(context?.index);
    if (Number.isFinite(idx)) return `Level ${idx + 1}`;
    return fallback;
  }
}
