/**
 * @fileoverview Scene transition curtain — orchestrates the visual sequence
 * around full Foundry scene switches.
 *
 * Presentation timings come from loading screen config (`presentation` block)
 * via {@link loadingScreenService.getPresentationTimings}.
 *
 * Sequence:
 *   cover()       → fade to solid black (content hidden)
 *   revealPanel() → after assets presentable, fade loading UI in
 *   (load runs, progress updates)
 *   reveal()      → min visible + progress settle + hold → full compositor ready → panel out → scene in
 *
 * @module scene/scene-transition-curtain
 */

import { createLogger } from '../core/log.js';
import { getShaderCompileMonitor } from '../core/diagnostics/ShaderCompileMonitor.js';
import { loadingScreenService as loadingOverlay } from '../ui/loading-screen/loading-screen-service.js';
import { getTileStreamingManager } from '../streaming/tile-streaming-manager.js';
import { isV3PipelineEnabled } from '../compositor-v3/v3-flags.js';

const log = createLogger('SceneTransitionCurtain');

const SCENE_READY_TIMEOUT_MS = 20000;
const SCENE_READY_POLL_MS = 50;
const SCENE_READY_STABLE_POLLS = 6;
const SCENE_STREAMING_PREFETCH_MS = 2500;
const SCENE_COMPILED_PROGRAMS_STABLE_POLLS = 6;

/**
 * Coordinates the loading overlay around full Foundry scene switches.
 */
export class SceneTransitionCurtain {
  constructor() {
    /** @type {'idle'|'covering'|'covered'|'revealing'} */
    this._phase = 'idle';
    /** @type {Promise<void>|null} */
    this._coverPromise = null;
    /** @type {Promise<void>|null} */
    this._revealPromise = null;
    /** @type {Promise<void>|null} */
    this._panelRevealPromise = null;
    /** @type {number} */
    this._token = 0;
    /** @type {number|null} */
    this._coverStartedAt = null;
    /** @type {number|null} */
    this._panelShownAt = null;
    /** @type {boolean} */
    this._panelVisible = false;
  }

  get phase() {
    return this._phase;
  }

  isActive() {
    return this._phase === 'covering' || this._phase === 'covered';
  }

  /**
   * Instantly hide the canvas behind an opaque black curtain (no fade). Call
   * synchronously at {@link Canvas#draw} entry before Foundry can paint the
   * destination scene; {@link #cover} may follow with an opacity fade.
   *
   * @param {object} [options]
   * @param {string} [options.message='Loading…']
   */
  armCoverSync(options = undefined) {
    const message = options?.message ?? 'Loading…';
    this._markSceneTransitionActive(true);
    if (this._phase === 'idle' || this._phase === 'revealing') {
      this._phase = 'covering';
      this._panelVisible = false;
      this._panelShownAt = null;
      if (this._coverStartedAt == null) {
        this._coverStartedAt = performance.now();
      }
    }
    try {
      loadingOverlay.prepareForCover?.(message);
    } catch (_) {}
  }

  /**
   * Fade the current scene out to solid black. Panel reveal is deferred to
   * {@link #revealPanel} once assets are presentable.
   *
   * @param {object} [options]
   * @param {string} [options.message='Loading…']
   * @param {string} [options.sceneName]
   * @param {number} [options.coverMs]
   * @param {boolean} [options.resetProgress=true]
   * @returns {Promise<void>}
   */
  async cover(options = undefined) {
    const timings = loadingOverlay.getPresentationTimings?.() ?? {};
    const message = options?.message ?? 'Loading…';
    const sceneName = options?.sceneName ?? null;
    const coverMs = Number.isFinite(options?.coverMs) ? options.coverMs : timings.coverFadeMs ?? 4000;
    const resetProgress = options?.resetProgress !== false;

    if (this._coverPromise) {
      try {
        loadingOverlay.setMessage?.(message);
        if (sceneName != null) loadingOverlay.setSceneName?.(sceneName);
      } catch (_) {}
      try { await this._coverPromise; } catch (_) {}
      return;
    }

    const token = ++this._token;
    this._markSceneTransitionActive(true);
    this._phase = 'covering';
    this._panelVisible = false;
    this._panelShownAt = null;
    this._coverStartedAt = performance.now();

    const promise = (async () => {
      try {
        try { loadingOverlay.ensure?.(); } catch (_) {}
        try { loadingOverlay.setMessage?.(message); } catch (_) {}
        if (sceneName != null) {
          try { loadingOverlay.setSceneName?.(sceneName); } catch (_) {}
        }
        if (resetProgress) {
          try { loadingOverlay.setProgress?.(0, { immediate: true }); } catch (_) {}
        }

        try { loadingOverlay.prepareForCover?.(message); } catch (_) {}
        await loadingOverlay.fadeBlack(coverMs, { contentVisible: false });
        if (token !== this._token) return;
      } catch (err) {
        log.warn('cover() pipeline error (continuing covered)', err);
      } finally {
        if (token === this._token) this._phase = 'covered';
      }
    })();

    this._coverPromise = promise;
    try {
      await promise;
    } finally {
      if (this._coverPromise === promise) this._coverPromise = null;
    }
  }

  /**
   * Fade the loading panel in after assets are presentable (called from
   * onCanvasReady once stages are configured).
   *
   * @param {object} [options]
   * @param {number} [options.panelInMs]
   * @returns {Promise<void>}
   */
  async revealPanel(options = undefined) {
    if (this._panelRevealPromise) {
      try { await this._panelRevealPromise; } catch (_) {}
      return;
    }

    const timings = loadingOverlay.getPresentationTimings?.() ?? {};
    const panelInMs = Number.isFinite(options?.panelInMs) ? options.panelInMs : timings.panelInFadeMs ?? 4000;
    const minBlackHoldMs = timings.minBlackHoldMs ?? 250;
    const deferPresentable = timings.deferPanelUntilPresentable !== false;

    const token = this._token;

    const promise = (async () => {
      if (this._panelVisible) return;

      // prepareForCover() can show the black shell before the curtain's cover()
      // runs (first world load). Treat that as covered so revealPanel still runs.
      if (this._phase === 'idle') {
        this._phase = 'covered';
        this._markSceneTransitionActive(true);
        if (this._coverStartedAt == null) {
          this._coverStartedAt = performance.now();
        }
      }

      try {
        if (this._coverStartedAt != null && minBlackHoldMs > 0) {
          const elapsed = performance.now() - this._coverStartedAt;
          const remaining = minBlackHoldMs - elapsed;
          if (remaining > 0) {
            await this._sleep(remaining);
            if (token !== this._token) return;
          }
        }

        if (deferPresentable) {
          try { await loadingOverlay.whenPresentable?.(); } catch (_) {}
          if (token !== this._token) return;
        }

        try { await loadingOverlay.whenStagePillsReady?.(); } catch (_) {}
        if (token !== this._token) return;

        await loadingOverlay.showPanel(panelInMs);
        if (token !== this._token) return;

        this._panelVisible = true;
        this._panelShownAt = performance.now();
        try { loadingOverlay.restartTimer?.(); } catch (_) {}
      } catch (err) {
        log.warn('revealPanel() error (continuing)', err);
        try {
          await loadingOverlay.showPanel(0);
          this._panelVisible = true;
          this._panelShownAt = performance.now();
        } catch (_) {}
      }
    })();

    this._panelRevealPromise = promise;
    try {
      await promise;
    } finally {
      if (this._panelRevealPromise === promise) this._panelRevealPromise = null;
    }
  }

  /**
   * Hide the loading panel and fade the curtain out, revealing the scene.
   *
   * @param {object} [options]
   * @param {number} [options.holdMs] Override ready hold (0 = skip gates for recovery)
   * @param {number} [options.panelOutMs]
   * @param {number} [options.revealMs]
   * @param {string} [options.finalMessage]
   * @param {boolean} [options.fast=false] Skip min-visible, progress-settle, and scene-ready gates
   * @param {boolean} [options.sceneReady=false] Skip scene-ready wait when caller already ran {@link #awaitSceneReady}
   * @returns {Promise<void>}
   */
  async reveal(options = undefined) {
    const timings = loadingOverlay.getPresentationTimings?.() ?? {};
    const fast = options?.fast === true;
    const sceneReady = options?.sceneReady === true;
    const holdMs = Number.isFinite(options?.holdMs)
      ? options.holdMs
      : (fast ? 0 : timings.readyHoldMs ?? 800);
    const panelOutMs = Number.isFinite(options?.panelOutMs) ? options.panelOutMs : timings.panelOutFadeMs ?? 4000;
    const revealMs = Number.isFinite(options?.revealMs) ? options.revealMs : timings.sceneRevealFadeMs ?? 4000;
    const finalMessage = options?.finalMessage ?? null;

    if (this._coverPromise) {
      try { await this._coverPromise; } catch (_) {}
    }
    if (this._panelRevealPromise) {
      try { await this._panelRevealPromise; } catch (_) {}
    }

    const wasCovered = this._phase === 'covered' || this._phase === 'covering' || this._panelVisible;

    const token = ++this._token;
    this._phase = 'revealing';

    const promise = (async () => {
      try {
        if (finalMessage != null) {
          try { loadingOverlay.setMessage(finalMessage); } catch (_) {}
        }

        if (!fast && wasCovered && this._panelShownAt != null) {
          const minVisibleMs = timings.minVisibleMs ?? 1500;
          const elapsed = performance.now() - this._panelShownAt;
          const remaining = minVisibleMs - elapsed;
          if (remaining > 0) {
            await this._sleep(remaining);
            if (token !== this._token) return;
          }
        }

        if (!fast) {
          try {
            await loadingOverlay.whenProgressSettled?.(timings.progressSettleMs ?? 500);
          } catch (_) {}
          if (token !== this._token) return;
        }

        if (holdMs > 0) {
          await this._sleep(holdMs);
          if (token !== this._token) return;
        }

        if (!fast && !sceneReady) {
          try {
            await this._waitForSceneReady();
          } catch (err) {
            log.warn('reveal() scene-ready wait error (continuing)', err);
          }
          if (token !== this._token) return;
        }

        if (wasCovered && this._panelVisible) {
          await loadingOverlay.hidePanel(panelOutMs);
          if (token !== this._token) return;
          this._panelVisible = false;
        }

        await loadingOverlay.fadeClear(revealMs);
        if (token !== this._token) return;
      } catch (err) {
        log.warn('reveal() pipeline error (forcing hide)', err);
        try { loadingOverlay.hide?.(); } catch (_) {}
      } finally {
        if (token === this._token) {
          this._phase = 'idle';
          this._panelVisible = false;
          this._panelShownAt = null;
          this._coverStartedAt = null;
          this._markSceneTransitionActive(false);
          try {
            if (window.MapShine) window.MapShine.__loadingOverlayConfiguredSceneId = null;
          } catch (_) {}
        }
      }
    })();

    this._revealPromise = promise;
    try {
      await promise;
    } finally {
      if (this._revealPromise === promise) this._revealPromise = null;
    }
  }

  forceClear() {
    this._token++;
    this._phase = 'idle';
    this._coverPromise = null;
    this._revealPromise = null;
    this._panelRevealPromise = null;
    this._panelVisible = false;
    this._panelShownAt = null;
    this._coverStartedAt = null;
    try { loadingOverlay.hide?.(); } catch (_) {}
    try {
      if (window.MapShine) window.MapShine.__loadingOverlayConfiguredSceneId = null;
    } catch (_) {}
    this._markSceneTransitionActive(false);
  }

  _markSceneTransitionActive(active) {
    try {
      if (!window.MapShine) window.MapShine = {};
      window.MapShine.__sceneTransitionActive = !!active;
    } catch (_) {}
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }

  /**
   * Wait until the compositor can produce full (non-slim) frames behind the
   * curtain. Public entry for callers (e.g. intro zoom) that dismiss UI before
   * {@link #reveal}.
   *
   * @returns {Promise<void>}
   */
  async awaitSceneReady() {
    return this._waitForSceneReady();
  }

  /**
   * Wait until the compositor can produce full (non-slim) frames behind the
   * curtain. While `__msaSceneLoading` is true the FloorCompositor stays on the
   * load-slim path and `_validateFrameInputs()` reports valid too early — that
   * is the main reason the curtain was lifting before the scene looked ready.
   *
   * @returns {Promise<void>}
   * @private
   */
  async _waitForSceneReady() {
    const deadline = performance.now() + SCENE_READY_TIMEOUT_MS;
    const fc = window.MapShine?.floorCompositorV2
      ?? window.MapShine?.effectComposer?._floorCompositorV2
      ?? null;
    const renderer = window.MapShine?.renderer ?? null;
    const canValidate = fc && typeof fc._validateFrameInputs === 'function';

    // V3 readiness (Forward+ §16): when the V3 pipeline owns the frame,
    // the V2-shaped conditions below (full V2 render path, V2 frame-input
    // validation) can NEVER become true — V2.render() is skipped — so waiting
    // on them burned the full SCENE_READY_TIMEOUT_MS on every V3 load before
    // "revealing anyway" (hardware-confirmed 2026-07-14: the Native "won't
    // load" stall). Under V3, readiness = the graph producing real content
    // frames, plus the same path-agnostic renderer-level program/draw checks.
    const v3 = window.MapShine?.__v3PipelineInstance ?? null;
    const v3OwnsFrame = () => {
      try {
        if (window.MapShine?.__v3OwnsFrame === true) return true;
        // Fallback until the render seam has stamped the signal this session.
        return !!(v3 && typeof v3.isReady === 'function' && v3.isReady() && isV3PipelineEnabled());
      } catch (_) { return false; }
    };

    // Release the load-slim render gate so full compositor frames can run
    // behind the black curtain before we fade clear.
    try {
      if (window.MapShine) window.MapShine.__msaSceneLoading = false;
    } catch (_) {}

    let populateStable = 0;
    let fullPathStable = 0;
    let inputsStable = 0;
    let programsStable = 0;
    let programsReadyTotal = -1;
    let renderCallsStable = 0;
    let lastInputReason = null;
    let v3Owns = false;
    let v3NewContentFrames = 0;
    let v3LastContentFrames = (() => {
      try { return v3?.getFrameCounters?.()?.contentFrames ?? 0; } catch (_) { return 0; }
    })();
    const startRenderFrame = renderer?.info?.render?.frame;
    const startRenderCalls = renderer?.info?.render?.calls;

    while (performance.now() < deadline) {
      this._keepRendering(4000);
      await this._pumpCompositorFrames(1);

      v3Owns = v3OwnsFrame();

      if (fc?._populateComplete === true) {
        populateStable += 1;
      } else {
        populateStable = 0;
      }

      // Cumulative NEW content frames since the wait began (not consecutive
      // polls — frame pacing under load-tail stalls is legitimately slower
      // than the poll interval; the evidence we need is "V3 produced ≥N real
      // scene frames", not "one per poll").
      if (v3Owns && v3) {
        let cf = v3LastContentFrames;
        try { cf = v3.getFrameCounters?.()?.contentFrames ?? cf; } catch (_) {}
        if (cf > v3LastContentFrames) v3NewContentFrames += (cf - v3LastContentFrames);
        v3LastContentFrames = cf;
      }

      if (!v3Owns && this._isFullCompositorFrameReady(fc)) {
        fullPathStable += 1;
      } else {
        fullPathStable = 0;
      }

      if (!v3Owns && canValidate && fullPathStable >= 2) {
        let valid = false;
        let reason = null;
        try {
          const probe = fc._validateFrameInputs();
          valid = probe?.valid === true;
          reason = probe?.reason ?? null;
        } catch (_) {}

        if (valid) {
          inputsStable += 1;
        } else {
          inputsStable = 0;
          lastInputReason = reason;
        }
      } else {
        inputsStable = 0;
      }

      const programs = renderer?.info?.programs ?? [];
      const totalPrograms = programs.length;
      let readyPrograms = 0;
      for (const p of programs) {
        try {
          readyPrograms += (typeof p?.isReady === 'function') ? (p.isReady() ? 1 : 0) : 1;
        } catch (_) {
          readyPrograms += 1;
        }
      }
      const allProgramsReady = totalPrograms <= 0 ? true : (readyPrograms >= totalPrograms);
      if (allProgramsReady) {
        if (programsReadyTotal === totalPrograms) programsStable += 1;
        else {
          programsReadyTotal = totalPrograms;
          programsStable = 1;
        }
      } else {
        programsStable = 0;
        programsReadyTotal = -1;
      }

      let shaderIdle = true;
      try {
        shaderIdle = (Number(getShaderCompileMonitor().getStats().activeCompiles) || 0) <= 0;
      } catch (_) {}

      const calls = renderer?.info?.render?.calls;
      const frame = renderer?.info?.render?.frame;
      const drewFrame = Number.isFinite(startRenderFrame) && Number.isFinite(frame)
        ? (frame > startRenderFrame)
        : true;
      const drewCalls = Number.isFinite(startRenderCalls) && Number.isFinite(calls)
        ? (calls > startRenderCalls)
        : Number.isFinite(calls) && calls > 0;
      if (drewFrame && drewCalls && shaderIdle) {
        renderCallsStable += 1;
      } else {
        renderCallsStable = 0;
      }

      const ready = v3Owns
        ? (
          // V3 branch: bus populate done (when the V2 compositor object exists —
          // V3 still reuses its FloorRenderBus), ≥3 real V3 content frames, and
          // the path-agnostic program/draw stability.
          (!fc || populateStable >= 2)
          && v3NewContentFrames >= 3
          && programsStable >= SCENE_COMPILED_PROGRAMS_STABLE_POLLS
          && renderCallsStable >= 2
        )
        : (!fc
          ? (renderCallsStable >= 3)
          : (
            populateStable >= 2
            && fullPathStable >= 2
            && (!canValidate || inputsStable >= SCENE_READY_STABLE_POLLS)
            && programsStable >= SCENE_COMPILED_PROGRAMS_STABLE_POLLS
            && renderCallsStable >= 2
          ));

      if (ready) {
        log.debug('Scene ready for curtain reveal', {
          v3Owns,
          v3NewContentFrames,
          populateStable,
          fullPathStable,
          inputsStable,
          programsStable,
          renderCallsStable,
        });
        break;
      }

      await this._sleep(SCENE_READY_POLL_MS);
    }

    if (performance.now() >= deadline) {
      log.warn('Scene-ready wait timed out before full compositor frames — revealing anyway', {
        v3Owns,
        v3NewContentFrames,
        populateComplete: fc?._populateComplete === true,
        renderPath: window.MapShine?.__v2CompositorRenderPath ?? null,
        lastInputReason,
        inputsStable,
        programsStable,
        renderCallsStable,
      });
    }

    const streaming = getTileStreamingManager?.();
    if (streaming?.hasActiveStreaming?.()) {
      const remainingMs = Math.max(50, Math.min(
        SCENE_STREAMING_PREFETCH_MS,
        deadline - performance.now(),
      ));
      if (remainingMs > 50) {
        try {
          await streaming.prefetchDuringLevelTransitionAsync({
            timeoutMs: remainingMs,
            minSteps: 4,
          });
        } catch (err) {
          log.debug('Streaming prefetch during scene reveal failed', err);
        }
      }
    }

    this._keepRendering(2000);
    await this._pumpCompositorFrames(4);
    await this._awaitRenderFrames(3);
  }

  /**
   * True when the compositor has left load/populate-slim mode and can run the
   * full effect + post chain for the next on-screen frame.
   *
   * @param {object|null} fc
   * @returns {boolean}
   * @private
   */
  _isFullCompositorFrameReady(fc) {
    if (!fc) return false;
    if (fc._populateComplete !== true) return false;
    if (fc._shaderWarmupGateOpen !== true) return false;
    if (typeof fc._populateSlimRenderActive === 'function' && fc._populateSlimRenderActive()) {
      return false;
    }
    return window.MapShine?.__v2CompositorRenderPath === 'full';
  }

  /** @private */
  _keepRendering(continuousMs = 2000) {
    try {
      const ms = window.MapShine;
      ms?.depthPassManager?.invalidate?.();
      ms?.renderLoop?.requestRender?.();
      ms?.renderLoop?.requestContinuousRender?.(Math.max(500, continuousMs));
    } catch (_) {}
  }

  /**
   * @param {number} [count=1]
   * @returns {Promise<void>}
   * @private
   */
  async _pumpCompositorFrames(count = 1) {
    const n = Math.max(1, Math.min(8, Math.floor(Number(count) || 1)));
    const rl = window.MapShine?.renderLoop;
    if (!rl) return;

    const streaming = getTileStreamingManager?.();

    for (let i = 0; i < n; i++) {
      try {
        streaming?.pumpStreamingSync?.();
      } catch (_) {}
      try {
        if (typeof rl.pumpBackgroundLoadFrame === 'function') {
          rl.pumpBackgroundLoadFrame();
        } else {
          rl.requestRender?.();
        }
      } catch (_) {}
      await this._sleep(0);
    }
    try {
      rl.requestContinuousRender?.(Math.max(1200, n * 400));
      rl.requestRender?.();
    } catch (_) {}
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
        if (remaining <= 0) {
          resolve();
          return;
        }
        scheduleNext();
      };
      const scheduleNext = () => {
        let advanced = false;
        const advance = () => {
          if (advanced) return;
          advanced = true;
          tick();
        };
        try {
          requestAnimationFrame(advance);
        } catch (_) {}
        const hidden = (() => {
          try {
            return typeof document !== 'undefined' && document.hidden === true;
          } catch (_) {
            return false;
          }
        })();
        setTimeout(advance, hidden ? 100 : 250);
      };
      scheduleNext();
    });
  }
}

export const sceneTransitionCurtain = new SceneTransitionCurtain();
