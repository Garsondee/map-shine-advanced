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
 *   reveal()      → min visible + progress settle + hold → panel out → scene in
 *
 * @module scene/scene-transition-curtain
 */

import { createLogger } from '../core/log.js';
import { loadingScreenService as loadingOverlay } from '../ui/loading-screen/loading-screen-service.js';

const log = createLogger('SceneTransitionCurtain');

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
   * @param {boolean} [options.fast=false] Skip min-visible and progress-settle gates
   * @returns {Promise<void>}
   */
  async reveal(options = undefined) {
    const timings = loadingOverlay.getPresentationTimings?.() ?? {};
    const fast = options?.fast === true;
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
}

export const sceneTransitionCurtain = new SceneTransitionCurtain();
