/**
 * @fileoverview Level transition curtain — fade-to-black around floor/level
 * changes.
 *
 * The curtain is invoked at the caller side (CameraFollower) BEFORE
 * `canvas.scene.view({ level })` is fired so the screen is fully black
 * before any visible Foundry tear-down can occur. After the switch is
 * performed it waits on real readiness signals (canvasReady, our own
 * mapShineLevelContextChanged, FloorCompositor populate, shader compiles
 * idle, two render frames) and only then fades back in.
 *
 * @module scene/level-transition-curtain
 */

import { createLogger } from '../core/log.js';
import { getShaderCompileMonitor } from '../core/diagnostics/ShaderCompileMonitor.js';
import { loadingOverlay } from '../ui/loading-overlay.js';

const log = createLogger('LevelTransitionCurtain');

const FADE_OUT_MS = 280;
const FADE_IN_MS = 520;

// Safety stopper: if every readiness signal somehow stalls, force fade-in so
// the user never gets stuck looking at a black screen.
const HARD_CAP_BLACK_MS = 15000;

// Per-step timeouts inside _waitForLevelReady. These are upper bounds, not
// guesses — each helper resolves the moment its hook fires.
const CANVAS_READY_TIMEOUT_MS = 8000;
const CONTEXT_TIMEOUT_MS = 5000;
const POPULATE_TIMEOUT_MS = 10000;
const SHADERS_IDLE_TIMEOUT_MS = 6000;

/**
 * Coordinates the loading overlay around Map Shine level switches.
 *
 * The curtain is intentionally a passive helper: it does NOT patch
 * `CameraFollower`. Callers route their level-switch work through
 * {@link LevelTransitionCurtain#runLevelSwitch} which handles the entire
 * fade-out / perform / await-ready / fade-in pipeline.
 */
export class LevelTransitionCurtain {
  constructor() {
    /** @type {Promise<void>|null} In-flight pipeline promise (for coalescing). */
    this._inFlightPromise = null;
    /** @type {string|null} Most-recently-requested target level id. */
    this._currentTargetLevelId = null;
    /** @type {(() => (void|Promise<void>))|null} Latest perform callback;
     * processed by the pipeline once we are fully black. Replaced when
     * subsequent `runLevelSwitch` calls arrive while the pipeline is in
     * flight so only the FINAL desired state is applied. */
    this._latestPerform = null;
    /** @type {string} Subtitle "from" label for the currently-displayed overlay. */
    this._fromLabel = '';
    /** @type {string} Subtitle "to" label for the currently-displayed overlay. */
    this._toLabel = '';
    /** @type {boolean} */
    this._disposed = false;
  }

  /**
   * Backwards-compatible no-op. The curtain used to monkey-patch
   * `cameraFollower._emitLevelContextChanged`; that responsibility has moved
   * to the caller (CameraFollower routes through {@link #runLevelSwitch}).
   * Kept so existing wiring code keeps working without changes.
   * @param {object} _cameraFollower
   */
  register(_cameraFollower) {
    this._disposed = false;
    log.info('Level transition curtain ready (caller-driven)');
  }

  dispose() {
    this._disposed = true;
    this._inFlightPromise = null;
    this._currentTargetLevelId = null;
    this._latestPerform = null;
    this._fromLabel = '';
    this._toLabel = '';
  }

  /**
   * Whether to bypass the curtain entirely. True during full scene
   * transitions, before the render loop is running, or any other time we
   * cannot safely show the overlay.
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

  /**
   * Run a level switch under a fade-to-black curtain.
   *
   * Pipeline:
   *   1. Fade the loading overlay to fully opaque black (opacity only).
   *   2. Run the caller-supplied `perform` callback — this is where
   *      `canvas.scene.view({ level })` and the matching
   *      `_emitLevelContextChanged` call happen so all heavy listener work
   *      runs while the screen is covered.
   *   3. Await real readiness signals (Foundry canvasReady, our own level
   *      context hook, FloorCompositor populate, shaders idle, render frames).
   *   4. Fade back in.
   *
   * Concurrent calls are coalesced: a second `runLevelSwitch` while the
   * pipeline is already in flight simply runs its `perform` callback under
   * the existing curtain and updates the readiness target. The fade-to-black
   * is not restarted.
   *
   * @param {object} options
   * @param {string} options.targetLevelId - Level id we expect to be active
   *   when the switch completes. Used to identify the matching
   *   `mapShineLevelContextChanged` hook.
   * @param {string} [options.fromLabel] - Display name of the level we are
   *   leaving. Shown in the subtitle.
   * @param {string} [options.toLabel] - Display name of the level we are
   *   arriving at. Shown in the subtitle.
   * @param {string} [options.reason] - Diagnostic reason tag.
   * @param {() => (void|Promise<void>)} options.perform - Callback executed
   *   AFTER fade-to-black completes. Must trigger the actual level switch
   *   (e.g. call `canvas.scene.view({ level })` and emit the hook).
   * @returns {Promise<void>}
   */
  async runLevelSwitch(options = {}) {
    const {
      targetLevelId = null,
      fromLabel = 'Current level',
      toLabel = 'Next level',
      reason = 'unknown',
      perform,
    } = options;

    if (this._disposed) {
      if (perform) await perform();
      return;
    }

    if (this._shouldBypass()) {
      if (perform) await perform();
      return;
    }

    // Always record the latest desired state. The pipeline drains
    // `_latestPerform` after fade-to-black so only the most recent perform
    // actually runs — earlier ones queued by rapid clicks are discarded.
    // This avoids the race where an in-flight pipeline's originally-captured
    // perform would overwrite the state set by a coalesced perform.
    this._currentTargetLevelId = targetLevelId;
    this._toLabel = toLabel || this._toLabel;
    this._latestPerform = perform || null;

    if (this._inFlightPromise) {
      this._refreshOverlaySubtitle();
      try {
        await this._inFlightPromise;
      } catch (_) {}
      return;
    }

    this._fromLabel = fromLabel;
    this._inFlightPromise = this._runPipeline({ reason });

    try {
      await this._inFlightPromise;
    } catch (_) {}

    this._inFlightPromise = null;

    // Late-arrival rescue: if a coalesced `runLevelSwitch` was called
    // between the pipeline's drain loop and us clearing state, the new
    // `_latestPerform` has not yet been processed. Kick off a fresh
    // pipeline so the user's request is honored rather than silently
    // dropped. Without this, a click landing in the `fadeClear` window
    // would have no visible effect.
    if (this._latestPerform) {
      const lateTarget = this._currentTargetLevelId;
      const lateTo = this._toLabel;
      const latePerform = this._latestPerform;
      this._latestPerform = null;
      this._currentTargetLevelId = null;
      this._fromLabel = '';
      this._toLabel = '';
      // Re-enter via microtask so we are not synchronously chained to the
      // caller's await frame.
      queueMicrotask(() => {
        try {
          void this.runLevelSwitch({
            targetLevelId: lateTarget,
            fromLabel: lateTo || 'Current level',
            toLabel: lateTo || 'Next level',
            reason: 'late-coalesce',
            perform: latePerform,
          });
        } catch (err) {
          log.warn('late-coalesce restart failed', err);
        }
      });
      return;
    }

    this._currentTargetLevelId = null;
    this._fromLabel = '';
    this._toLabel = '';
  }

  /**
   * @param {object} args
   * @param {string} args.reason
   * @private
   */
  async _runPipeline({ reason }) {
    const pipelineStartMs = performance.now();
    const MAX_PERFORM_ITERATIONS = 8;

    // 1. Prepare overlay chrome (subtitle, panel) BEFORE the fade so the
    // panel content is correct from the first visible frame of black.
    this._prepareOverlay();

    // 2. Fade overlay to fully-opaque black (opacity only).
    try {
      await loadingOverlay.fadeBlack(FADE_OUT_MS);
    } catch (err) {
      log.warn('fadeBlack failed', err);
    }

    // 3. Ask the render loop to keep ticking while we wait for readiness so
    // populate / shader work makes progress instead of pausing when the
    // canvas is fully covered.
    this._keepRendering();

    // 4. Drain the latest perform queue. Each loop iteration grabs the
    // most-recently-requested perform and runs it; rapid coalesced calls
    // are collapsed so only the FINAL desired state is applied.
    let iterations = 0;
    while (this._latestPerform && iterations < MAX_PERFORM_ITERATIONS && !this._disposed) {
      const p = this._latestPerform;
      this._latestPerform = null;
      try {
        await p();
      } catch (err) {
        log.warn('perform threw', err);
      }
      iterations += 1;
    }

    // 5. Wait for real readiness signals (NOT a fixed timer).
    try {
      await this._waitForLevelReady(pipelineStartMs);
    } catch (err) {
      log.warn('_waitForLevelReady failed', err);
    }

    // 6. Handle any performs that arrived during the readiness wait — each
    // is the user requesting another switch while we were already black.
    // We re-wait after each so we never fade in on a stale state.
    while (this._latestPerform && iterations < MAX_PERFORM_ITERATIONS && !this._disposed) {
      const p = this._latestPerform;
      this._latestPerform = null;
      try {
        await p();
      } catch (err) {
        log.warn('late perform threw', err);
      }
      try {
        await this._waitForLevelReady(performance.now());
      } catch (err) {
        log.warn('late _waitForLevelReady failed', err);
      }
      iterations += 1;
    }

    // 7. Final render kick so the first frame after fade-in is current.
    this._keepRendering();
    await this._awaitRenderFrames(1);

    // 8. Fade out the overlay — unless a full scene transition has begun in
    // the meantime, in which case the scene-transition flow owns the
    // overlay and we must not interfere with its fade sequence.
    if (this._shouldBypass()) {
      log.info('Skipping curtain fade-in; scene transition took over the overlay');
    } else {
      try {
        await loadingOverlay.fadeClear(FADE_IN_MS);
      } catch (err) {
        log.warn('fadeClear failed', err);
      }
    }

    log.debug('Level switch complete', {
      targetLevelId: this._currentTargetLevelId,
      reason,
      iterations,
      elapsedMs: Math.round(performance.now() - pipelineStartMs),
    });
  }

  /**
   * Configure the overlay panel's subtitle + stages for a level switch. The
   * stage row is rendered with friendly labels and updated as each readiness
   * step completes.
   * @private
   */
  _prepareOverlay() {
    try {
      loadingOverlay.ensure();
      loadingOverlay.setMessage('Changing floor…');
      loadingOverlay.configureStages([
        { id: 'fade', label: 'Covering', weight: 1 },
        { id: 'apply', label: 'Switching', weight: 1 },
        { id: 'compositor', label: 'Compositing', weight: 1 },
        { id: 'shaders', label: 'Shaders', weight: 1 },
        { id: 'finalize', label: 'Finalizing', weight: 1 },
      ]);
      loadingOverlay.startStages();
      loadingOverlay.setStage('fade', 0.4);
      this._refreshOverlaySubtitle();
    } catch (err) {
      log.warn('prepareOverlay failed', err);
    }
  }

  /** @private */
  _refreshOverlaySubtitle() {
    try {
      const from = String(this._fromLabel || '').trim() || 'Current level';
      const to = String(this._toLabel || '').trim() || 'Next level';
      loadingOverlay.setSubtitle?.(`Changing from ${from} to ${to}`);
    } catch (_) {}
  }

  /** @private */
  _setStage(stageId, progress01) {
    try {
      loadingOverlay.setStage(stageId, progress01);
    } catch (_) {}
  }

  /**
   * Tell the render loop to keep producing frames so populate / shader work
   * can run while the canvas is hidden behind the curtain.
   * @private
   */
  _keepRendering() {
    try {
      const ms = window.MapShine;
      ms?.depthPassManager?.invalidate?.();
      ms?.renderLoop?.requestRender?.();
      ms?.renderLoop?.requestContinuousRender?.(2000);
    } catch (_) {}
  }

  /**
   * Wait on real readiness signals for the current target level — NOT a
   * fixed timer. Each helper subscribes to the relevant hook, resolves the
   * moment that hook fires, and falls back to a per-step timeout so a
   * missing signal cannot deadlock the curtain.
   *
   * Returns early when `_currentTargetLevelId` is updated mid-wait (e.g. by
   * a coalesced second switch). The pipeline's outer loop is responsible
   * for draining the new perform and calling `_waitForLevelReady` again.
   *
   * @param {number} pipelineStartMs
   * @returns {Promise<{ready: boolean, targetChanged: boolean}>}
   * @private
   */
  async _waitForLevelReady(pipelineStartMs) {
    const deadline = pipelineStartMs + HARD_CAP_BLACK_MS;
    const target = this._currentTargetLevelId;

    this._setStage('fade', 1);
    this._setStage('apply', 0.3);

    const targetChanged = () =>
      this._latestPerform !== null || this._currentTargetLevelId !== target;

    const remaining = () => Math.max(50, deadline - performance.now());

    const canvasOk = await this._awaitCanvasReady(
      Math.min(CANVAS_READY_TIMEOUT_MS, remaining()),
    );
    if (targetChanged()) return { ready: false, targetChanged: true };
    this._setStage('apply', 0.7);

    const contextOk = await this._awaitMapShineContext(
      target,
      Math.min(CONTEXT_TIMEOUT_MS, remaining()),
    );
    if (targetChanged()) return { ready: false, targetChanged: true };
    this._setStage('apply', 1);

    this._setStage('compositor', 0.3);
    await this._awaitFloorCompositorPopulate(
      Math.min(POPULATE_TIMEOUT_MS, remaining()),
    );
    if (targetChanged()) return { ready: false, targetChanged: true };
    this._setStage('compositor', 1);

    this._setStage('shaders', 0.3);
    await this._awaitShadersIdle(
      Math.min(SHADERS_IDLE_TIMEOUT_MS, remaining()),
    );
    if (targetChanged()) return { ready: false, targetChanged: true };
    this._setStage('shaders', 1);

    this._setStage('finalize', 0.4);
    await this._awaitRenderFrames(2);
    this._setStage('finalize', 1);

    if (targetChanged()) return { ready: false, targetChanged: true };

    if (performance.now() >= deadline) {
      log.warn('Hard cap reached during _waitForLevelReady — forcing fade-in', {
        elapsedMs: Math.round(performance.now() - pipelineStartMs),
        target,
      });
    } else {
      log.debug('Level ready', {
        target,
        elapsedMs: Math.round(performance.now() - pipelineStartMs),
        canvasReadyObserved: canvasOk,
        contextMatched: contextOk,
      });
    }

    return { ready: true, targetChanged: false };
  }

  /**
   * Resolve when Foundry fires `canvasReady` (i.e. the canvas redraw
   * triggered by `canvas.scene.view({ level })` has completed) or when the
   * per-step timeout elapses.
   *
   * @param {number} timeoutMs
   * @returns {Promise<boolean>} `true` if a `canvasReady` hook fired,
   *   `false` if we fell through on the timeout.
   * @private
   */
  _awaitCanvasReady(timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      let hookId = 0;
      const finish = (observed) => {
        if (settled) return;
        settled = true;
        try {
          if (hookId) Hooks.off('canvasReady', hookId);
        } catch (_) {}
        clearTimeout(timer);
        resolve(observed);
      };
      try {
        hookId = Hooks.once('canvasReady', () => finish(true));
      } catch (_) {
        finish(false);
        return;
      }
      const timer = setTimeout(() => finish(false), Math.max(50, timeoutMs));
    });
  }

  /**
   * Resolve when `mapShineLevelContextChanged` fires with a context whose
   * `levelId` matches `targetLevelId`. If the active context already matches,
   * resolves on the next microtask.
   *
   * @param {string|null} targetLevelId
   * @param {number} timeoutMs
   * @returns {Promise<boolean>} `true` if we observed a matching context.
   * @private
   */
  _awaitMapShineContext(targetLevelId, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const matches = (ctx) => {
        if (!ctx) return false;
        if (!targetLevelId) return true;
        return ctx.levelId === targetLevelId;
      };
      if (matches(window.MapShine?.activeLevelContext)) {
        resolve(true);
        return;
      }
      let hookId = 0;
      const finish = (observed) => {
        if (settled) return;
        settled = true;
        try {
          if (hookId) Hooks.off('mapShineLevelContextChanged', hookId);
        } catch (_) {}
        clearTimeout(timer);
        resolve(observed);
      };
      try {
        hookId = Hooks.on('mapShineLevelContextChanged', (payload) => {
          if (matches(payload?.context)) {
            finish(true);
          }
        });
      } catch (_) {
        finish(false);
        return;
      }
      const timer = setTimeout(() => finish(false), Math.max(50, timeoutMs));
    });
  }

  /**
   * Await the FloorCompositor's populate promise so per-floor effect masks
   * (fire, water, specular, etc.) are fully rebuilt for the new level before
   * we expose the canvas again.
   *
   * @param {number} timeoutMs
   * @private
   */
  async _awaitFloorCompositorPopulate(timeoutMs) {
    const fc = window.MapShine?.floorCompositorV2
      ?? window.MapShine?.effectComposer?._floorCompositorV2
      ?? null;
    if (!fc) return;

    const deadline = performance.now() + Math.max(50, timeoutMs);
    while (performance.now() < deadline && !this._disposed) {
      const settled = fc._populateComplete === true && fc._busPopulated !== false;
      if (settled) return;
      if (fc._populatePromise) {
        try {
          await Promise.race([
            fc._populatePromise,
            this._sleep(Math.max(50, Math.min(500, deadline - performance.now()))),
          ]);
        } catch (_) {}
      } else {
        await this._sleep(60);
      }
    }
  }

  /**
   * Await shader compile queue going idle. We require 2 consecutive idle
   * frames so a transient zero count between two adjacent compiles does not
   * release the curtain prematurely.
   *
   * @param {number} timeoutMs
   * @private
   */
  async _awaitShadersIdle(timeoutMs) {
    const deadline = performance.now() + Math.max(50, timeoutMs);
    let idleFrames = 0;
    while (performance.now() < deadline && !this._disposed) {
      let active = 0;
      try {
        active = Number(getShaderCompileMonitor().getStats().activeCompiles) || 0;
      } catch (_) {
        active = 0;
      }
      if (active <= 0) {
        idleFrames += 1;
        if (idleFrames >= 2) return;
      } else {
        idleFrames = 0;
      }
      await this._awaitRenderFrames(1);
    }
  }

  /**
   * @param {number} [count=1]
   * @returns {Promise<void>}
   * @private
   */
  _awaitRenderFrames(count = 1) {
    const n = Math.max(1, Math.floor(count));
    return new Promise((resolve) => {
      let remaining = n;
      const tick = () => {
        remaining -= 1;
        if (remaining <= 0 || this._disposed) {
          resolve();
          return;
        }
        try {
          requestAnimationFrame(tick);
        } catch (_) {
          setTimeout(tick, 16);
        }
      };
      try {
        requestAnimationFrame(tick);
      } catch (_) {
        setTimeout(tick, 16);
      }
    });
  }

  /**
   * @param {number} ms
   * @returns {Promise<void>}
   * @private
   */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }
}
