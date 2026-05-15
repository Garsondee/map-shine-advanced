/**
 * @fileoverview Scene transition curtain — orchestrates the visual sequence
 * around full Foundry scene switches.
 *
 * The legacy flow ({@link LoadingOverlay#fadeToBlack} +
 * {@link LoadingOverlay#fadeIn}) cross-faded the background colour and the
 * panel content at the same time. The panel was invisible by the time the
 * screen was fully black, so the user never saw the "Loading…" UI during the
 * costly Canvas.draw/createThreeCanvas phase, and the reveal showed a panel
 * popping back to opacity 1 for a single frame before disappearing.
 *
 * This curtain replaces that with a four-phase sequence:
 *
 *   cover()
 *     1. Outer overlay fades to opaque black (opacity only). Panel kept at
 *        content-opacity 0 so the screen reaches solid-black with no UI.
 *     2. Panel fades in (content-opacity 0 → 1) so the loading screen
 *        gracefully appears over the black backdrop.
 *
 *   (Foundry tears down, draws the new scene, createThreeCanvas runs, etc.
 *   Progress / stage / scene-name updates remain visible the whole time.)
 *
 *   reveal()
 *     3. Brief hold so 100% / "Ready!" is visible to the user.
 *     4. Panel fades out (content-opacity 1 → 0) back to solid-black.
 *     5. Outer overlay fades to transparent revealing the fully-drawn scene.
 *
 * Concurrent calls are coalesced — a second `cover()` while the curtain is
 * already covered is a no-op; a `reveal()` cancels any pending reveal and
 * starts a fresh one.
 *
 * The curtain marks `window.MapShine.__sceneTransitionActive` while a
 * transition is in flight so the level-transition curtain bypasses itself
 * cleanly during scene switches.
 *
 * @module scene/scene-transition-curtain
 */

import { createLogger } from '../core/log.js';
import { loadingScreenService as loadingOverlay } from '../ui/loading-screen/loading-screen-service.js';

const log = createLogger('SceneTransitionCurtain');

// Phase durations — kept short enough that fast scene loads still feel snappy,
// long enough that the transitions read as deliberate rather than as glitches.
const COVER_MS = 420;       // outer overlay 0 → solid black
const PANEL_IN_MS = 320;    // loading screen content 0 → 1
const HOLD_AT_FULL_MS = 220;// "Ready!" pause after load completes
const PANEL_OUT_MS = 280;   // loading screen content 1 → 0
const REVEAL_MS = 640;      // outer overlay solid black → transparent

/**
 * Coordinates the loading overlay around full Foundry scene switches.
 *
 * Usage:
 *   await sceneTransitionCurtain.cover({ message: 'Switching scenes…' });
 *   // Foundry tearDown / draw runs while the curtain is in place.
 *   // createThreeCanvas updates the panel (stages, progress, scene name).
 *   await sceneTransitionCurtain.reveal();
 */
export class SceneTransitionCurtain {
  constructor() {
    /** @type {'idle'|'covering'|'covered'|'revealing'} */
    this._phase = 'idle';
    /** @type {Promise<void>|null} */
    this._coverPromise = null;
    /** @type {Promise<void>|null} */
    this._revealPromise = null;
    /** @type {number} Monotonic token so a fresh cover() invalidates an
     *  in-flight reveal() (and vice-versa). */
    this._token = 0;
  }

  /**
   * Phase tag — exposed for diagnostics.
   * @returns {'idle'|'covering'|'covered'|'revealing'}
   */
  get phase() {
    return this._phase;
  }

  /**
   * Whether the curtain is currently covering the scene (either mid-fade or
   * fully black). Callers can check this to decide whether to skip extra
   * fade animations.
   * @returns {boolean}
   */
  isActive() {
    return this._phase === 'covering' || this._phase === 'covered';
  }

  // ---------------------------------------------------------------------------
  // Phase 1+2: cover the scene with black, then bring up the loading panel.
  // ---------------------------------------------------------------------------

  /**
   * Fade the current scene out and bring the loading panel up.
   *
   * Coalesces with an in-flight cover; calling it a second time while the
   * curtain is already covering simply awaits the existing animation.
   *
   * @param {object} [options]
   * @param {string} [options.message='Loading…'] Message text to show on the
   *   panel as it fades in. Caller can update it later via
   *   `loadingOverlay.setMessage(...)`.
   * @param {string} [options.sceneName] Optional scene name displayed in the
   *   subtitle / breadcrumb area of the panel.
   * @param {number} [options.coverMs=COVER_MS] Duration of the black fade.
   * @param {number} [options.panelInMs=PANEL_IN_MS] Duration of the panel
   *   fade-in.
   * @param {boolean} [options.resetProgress=true] When true (the default),
   *   the panel's progress / timer / stage state is reset before the panel
   *   fades in so the new transition starts clean.
   * @returns {Promise<void>}
   */
  async cover(options = undefined) {
    const message = options?.message ?? 'Loading…';
    const sceneName = options?.sceneName ?? null;
    const coverMs = Number.isFinite(options?.coverMs) ? options.coverMs : COVER_MS;
    const panelInMs = Number.isFinite(options?.panelInMs) ? options.panelInMs : PANEL_IN_MS;
    const resetProgress = options?.resetProgress !== false;

    // If a cover is already in flight, await it instead of starting a second
    // one (label-only update). When phase is "covered" but no in-flight
    // promise exists, the previous reveal/error path may have bypassed the
    // curtain — fall through and re-cover so state is consistent.
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
        await loadingOverlay.showPanel(panelInMs);
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

  // ---------------------------------------------------------------------------
  // Phase 3+4+5: hold at full, fade the panel out, then reveal the new scene.
  // ---------------------------------------------------------------------------

  /**
   * Hide the loading panel and fade the curtain out, revealing the freshly
   * drawn scene.
   *
   * Safe to call when the curtain is already idle — it will be a no-op that
   * still ensures the overlay is hidden (cleanup-on-completion).
   *
   * @param {object} [options]
   * @param {number} [options.holdMs=HOLD_AT_FULL_MS] How long to keep the
   *   "100% / Ready!" state visible before starting the fade-out.
   * @param {number} [options.panelOutMs=PANEL_OUT_MS] Duration of the
   *   panel fade-out.
   * @param {number} [options.revealMs=REVEAL_MS] Duration of the overlay
   *   fade-to-transparent.
   * @param {string} [options.finalMessage] Optional message to display
   *   during the hold (e.g. `Ready! (3.2s)`).
   * @returns {Promise<void>}
   */
  async reveal(options = undefined) {
    const holdMs = Number.isFinite(options?.holdMs) ? options.holdMs : HOLD_AT_FULL_MS;
    const panelOutMs = Number.isFinite(options?.panelOutMs) ? options.panelOutMs : PANEL_OUT_MS;
    const revealMs = Number.isFinite(options?.revealMs) ? options.revealMs : REVEAL_MS;
    const finalMessage = options?.finalMessage ?? null;

    if (this._coverPromise) {
      try { await this._coverPromise; } catch (_) {}
    }

    // When the curtain was driven through `cover()` we know the panel is at
    // content-opacity 1 and the overlay is at opacity 1 — we can animate the
    // full panel-out → bg-out sequence. When the caller arrives here without
    // a prior `cover()` (initial loads, recovery paths, debug auto-dismiss
    // before any tear-down was wrapped) we skip the panel-out step and just
    // fade the overlay out, which is also a no-op when it is already hidden.
    const wasCovered = this._phase === 'covered' || this._phase === 'covering';

    const token = ++this._token;
    this._phase = 'revealing';

    const promise = (async () => {
      try {
        if (finalMessage != null) {
          try { loadingOverlay.setMessage(finalMessage); } catch (_) {}
        }
        if (holdMs > 0) {
          await this._sleep(holdMs);
          if (token !== this._token) return;
        }
        if (wasCovered) {
          await loadingOverlay.hidePanel(panelOutMs);
          if (token !== this._token) return;
        }
        await loadingOverlay.fadeClear(revealMs);
        if (token !== this._token) return;
      } catch (err) {
        log.warn('reveal() pipeline error (forcing hide)', err);
        try { loadingOverlay.hide?.(); } catch (_) {}
      } finally {
        if (token === this._token) {
          this._phase = 'idle';
          this._markSceneTransitionActive(false);
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

  /**
   * Cancel any in-flight transition and force the overlay hidden. Intended
   * for error-recovery paths (e.g. Canvas.draw() throws and never reaches a
   * reveal site).
   */
  forceClear() {
    this._token++;
    this._phase = 'idle';
    this._coverPromise = null;
    this._revealPromise = null;
    try { loadingOverlay.hide?.(); } catch (_) {}
    this._markSceneTransitionActive(false);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * @param {boolean} active
   * @private
   */
  _markSceneTransitionActive(active) {
    try {
      if (!window.MapShine) window.MapShine = {};
      window.MapShine.__sceneTransitionActive = !!active;
    } catch (_) {}
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

/**
 * Process-wide singleton. The curtain owns no per-scene state, so a single
 * instance can safely service every scene switch. Mirrors the {@link
 * loadingOverlay} singleton it composes with.
 */
export const sceneTransitionCurtain = new SceneTransitionCurtain();
