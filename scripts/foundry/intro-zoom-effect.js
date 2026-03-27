/**
 * @fileoverview Intro Zoom Effect
 *
 * An optional post-loading-screen cinematic sequence that plays after the scene
 * finishes loading. Rather than simply fading the loading screen out, this
 * intercepts the transition and performs:
 *
 *   1. Instantly positions the camera at the player's owned token(s), zoomed far out.
 *   2. Fades the screen to pure white (covering the loading screen).
 *   3. Removes the loading screen behind the white flash.
 *   4. Simultaneously fades out the white and animates the camera zooming in to
 *      frame the player's token(s) at normal viewing distance.
 *   5. Releases the input lock when both animations complete.
 *
 * Enabled via the 'introZoomEnabled' client setting (default: true).
 * Falls back to a standard fade-in if: the setting is off, no owned tokens
 * are present, or any step fails.
 *
 * @module foundry/intro-zoom-effect
 */
import { isGmLike } from '../core/gm-parity.js';

import { createLogger } from '../core/log.js';

const log = createLogger('IntroZoomEffect');
const MODULE_ID = 'map-shine-advanced';

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function asNumber(v, fallback) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * @typedef {Object} IntroZoomOptions
 * @property {number} [framingPadding=320]  - Padding (px) around token group bounding box when computing framing scale.
 * @property {number} [flashFadeInMs=350]   - Duration (ms) for the white flash to fade in.
 * @property {number} [flashFadeOutMs=650]  - Duration (ms) for the white flash to fade out.
 * @property {number} [zoomDurationMs=19200] - Duration (ms) for the camera zoom-in animation.
 * @property {number} [zoomDelayMs=0]       - Extra delay (ms) before the zoom starts (after white peaks).
 * @property {number} [zoomedOutScale]      - Override for the starting (wide) zoom level.
 * @property {number} [finalScaleMultiplier=0.84] - Multiplier applied to computed framing scale to avoid over-zooming in.
 * @property {number} [sceneCoverageFactor=3.0] - Start zoom target framing factor for whole scene.
 * @property {number} [renderSettleMaxWaitMs=2500] - Max wait for the renderer to stabilize before the transition starts.
 * @property {Function} [onBlockInput]      - Called to acquire the input lock.
 * @property {Function} [onUnblockInput]    - Called to release the input lock.
 */

/**
 * Post-loading cinematic: white flash + camera zoom-in to the player's tokens.
 *
 * Usage from canvas-replacement.js (non-debug path):
 * ```js
 * await introZoomEffect.run(loadingOverlay, {
 *   onBlockInput:   () => pixiInputBridge?.setInputBlocker(() => true),
 *   onUnblockInput: () => { pixiInputBridge?.setInputBlocker(null); cinematicCameraManager?._bindInputBridge?.(); },
 * });
 * ```
 */
export class IntroZoomEffect {
  constructor() {
    /** @type {HTMLElement|null} */
    this._overlayEl = null;

    /** @type {boolean} */
    this._active = false;
  }

  /**
   * Capture the current camera view so we can restore it if intro sequence fails.
   *
   * @returns {{x:number,y:number,scale:number}|null}
   */
  _captureCurrentView() {
    const x = asNumber(canvas?.stage?.pivot?.x, NaN);
    const y = asNumber(canvas?.stage?.pivot?.y, NaN);
    const scale = this._sanitizeScale(asNumber(canvas?.stage?.scale?.x, NaN));
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale)) return null;
    return { x, y, scale };
  }

  /**
   * Restore a previously captured camera view.
   *
   * @param {{x:number,y:number,scale:number}|null} view
   */
  _restoreView(view) {
    if (!view) return;
    try {
      canvas?.pan?.({ x: view.x, y: view.y, scale: view.scale, duration: 0 });
    } catch (_) {
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Returns true if the intro zoom is enabled via game settings.
   * Defaults to true when the setting cannot be read yet.
   * @returns {boolean}
   */
  isEnabled() {
    try {
      return game?.settings?.get(MODULE_ID, 'introZoomEnabled') !== false;
    } catch (_) {
      return true;
    }
  }

  /**
   * Run the full intro zoom sequence, intercepting the normal loading screen fade-out.
   *
   * When disabled or no owned tokens are found, falls back to a standard
   * `loadingOverlay.fadeIn()` call identical to the non-intro-zoom path.
   *
   * @param {object}           loadingOverlay - The loading screen service (LoadingScreenService).
   * @param {IntroZoomOptions} [options]
   * @returns {Promise<void>}
   */
  async run(loadingOverlay, options = {}) {
    if (this._active) {
      log.warn('IntroZoom: prior run still active; forcing cleanup before starting a new sequence');
      this.dispose();
    }

    if (!this.isEnabled()) {
      await this._fallback(loadingOverlay);
      return;
    }

    const tokens = this._getTargetTokens();
    if (!tokens.length) {
      log.info('IntroZoom: no target tokens — falling back to standard fade-in');
      await this._fallback(loadingOverlay);
      return;
    }

    // Keep level context aligned with intro targets so upper-floor single-token
    // intros do not begin on the wrong floor.
    await this._syncLevelForIntroTargets(tokens);

    const {
      framingPadding = 320,
      flashFadeInMs  = 350,
      flashFadeOutMs = 650,
      zoomDurationMs = 19200,
      zoomDelayMs    = 0,
      finalScaleMultiplier = 0.84,
      sceneCoverageFactor = 3.0,
      renderSettleMaxWaitMs = 2500,
      onBlockInput   = null,
      onUnblockInput = null,
    } = options;

    const center = this._computeCenter(tokens);
    if (!center) {
      log.warn('IntroZoom: could not compute token center — falling back');
      await this._fallback(loadingOverlay);
      return;
    }

    // Hold the loading screen until frame pacing is reasonably stable so the
    // flash and first zoom frames are less likely to hitch or skip.
    await this._waitForSmoothRendering({ maxWaitMs: renderSettleMaxWaitMs });

    const framingScaleRaw = this._computeFramingScale(tokens, framingPadding);
    const framingScale    = this._sanitizeScale(this._computeFinalScale(framingScaleRaw, finalScaleMultiplier));

    const sceneWideScale = this._computeSceneWideScale(sceneCoverageFactor);
    const startScaleBase = asNumber(options.zoomedOutScale, this._computeZoomedOutScale(framingScale ?? 1));
    const startScaleWide = Number.isFinite(sceneWideScale) ? Math.min(startScaleBase, sceneWideScale) : startScaleBase;
    const startScale     = this._sanitizeScale(this._ensureDistinctStartScale(startScaleWide, framingScale ?? 1));

    if (!Number.isFinite(framingScale) || !Number.isFinite(startScale)) {
      log.warn('IntroZoom: invalid computed scale values — falling back', { framingScaleRaw, framingScale, startScale });
      await this._fallback(loadingOverlay);
      return;
    }

    log.info('IntroZoom: starting sequence', {
      center,
      startScale: startScale.toFixed(3),
      sceneWideScale: Number.isFinite(sceneWideScale) ? sceneWideScale.toFixed(3) : 'n/a',
      framingScale: framingScale.toFixed(3),
      flashFadeInMs,
      flashFadeOutMs,
      zoomDurationMs,
    });

    this._active = true;
    const previousView = this._captureCurrentView();

    try {
      if (typeof onBlockInput === 'function') onBlockInput();

      // Step 1: Instantly position the camera at the token centre, wide-zoomed-out.
      // This happens silently behind the still-visible loading screen.
      this._instantCameraPosition(center.x, center.y, startScale);
      await this._waitForAnimationFrames(2);

      // Step 2: Build the white flash overlay (starts fully transparent).
      this._createWhiteOverlay();
      await this._waitForAnimationFrames(1);

      // Step 3: Fade the white overlay in, covering the loading screen.
      await this._setWhiteOverlayOpacity(1, flashFadeInMs);

      // Step 4: Now the screen is white — dismiss the loading screen behind it.
      try { loadingOverlay.hide(); } catch (_) {}

      // Step 5: Optional hold before the camera begins moving.
      if (zoomDelayMs > 0) await sleep(zoomDelayMs);
      await this._waitForAnimationFrames(1);

      // Step 6: Simultaneously fade the white away AND zoom the camera in.
      // The zoom ends slightly after the white clears for a clean reveal.
      await Promise.all([
        this._fadeOutWhiteOverlay(flashFadeOutMs),
        this._animateCameraZoom(center.x, center.y, framingScale, zoomDurationMs),
      ]);

    } catch (err) {
      log.error('IntroZoom: sequence failed, cleaning up', err);
      // Ensure the loading screen is dismissed even on error.
      try { loadingOverlay.hide(); } catch (_) {}
      this._restoreView(previousView);
    } finally {
      this._active = false;
      this._destroyWhiteOverlay();
      if (typeof onUnblockInput === 'function') onUnblockInput();
    }
  }

  /**
   * Immediately abort any running sequence and clean up.
   * Safe to call multiple times.
   */
  dispose() {
    this._active = false;
    this._destroyWhiteOverlay();
  }

  // ---------------------------------------------------------------------------
  // Token discovery
  // ---------------------------------------------------------------------------

  /**
   * Returns the set of tokens to frame:
   * - Controlled tokens always take priority for both players and GMs.
   * - Players: fallback to all owned tokens on the scene.
   * - GMs: fallback to all visible scene tokens so the sequence still plays.
   *
   * @returns {Token[]}
   */
  _getTargetTokens() {
    try {
      const placeables = canvas?.tokens?.placeables;
      if (!Array.isArray(placeables) || !placeables.length) return [];

      // Controlled tokens always take priority for both GMs and players.
      const controlled = canvas.tokens.controlled || [];
      if (controlled.length) return controlled;

      if (isGmLike()) {
        const visible = placeables.filter((t) => t?.document?.hidden !== true);
        return visible.length ? visible : placeables;
      }

      // Players fall back to all tokens their actor owns.
      return placeables.filter(
        (t) => t?.document?.actor?.isOwner === true
      );
    } catch (_) {
      return [];
    }
  }

  /**
   * Ensure active floor context matches intro target elevations.
   *
   * Rules:
   * - Single target token: switch to that token's floor.
   * - Multiple target tokens spanning floors: use the lowest floor.
   *
   * @param {Token[]} tokens
   * @returns {Promise<void>}
   */
  async _syncLevelForIntroTargets(tokens) {
    try {
      const controller = window.MapShine?.levelNavigationController ?? window.MapShine?.cameraFollower;
      if (!controller || typeof controller.getAvailableLevels !== 'function' || typeof controller.setActiveLevel !== 'function') {
        return;
      }

      const levels = controller.getAvailableLevels?.() || [];
      if (!Array.isArray(levels) || levels.length <= 1) return;

      const elevations = [];
      for (const token of tokens) {
        const elev = Number(token?.document?.elevation);
        if (Number.isFinite(elev)) elevations.push(elev);
      }
      if (!elevations.length) return;

      const targetElevation = elevations.length === 1
        ? elevations[0]
        : Math.min(...elevations);

      const findIndex = (elevation) => {
        if (typeof controller._findBestLevelIndexForElevation === 'function') {
          return controller._findBestLevelIndexForElevation(elevation);
        }
        let bestIdx = 0;
        let bestDist = Infinity;
        for (let i = 0; i < levels.length; i += 1) {
          const lvl = levels[i] || {};
          const bottom = Number(lvl.bottom);
          const top = Number(lvl.top);
          const center = Number(lvl.center);
          if (Number.isFinite(bottom) && Number.isFinite(top) && elevation >= bottom && elevation <= top) {
            return i;
          }
          const d = Number.isFinite(center) ? Math.abs(center - elevation) : Infinity;
          if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
          }
        }
        return bestIdx;
      };

      const nextIndex = findIndex(targetElevation);
      const current = controller.getActiveLevelContext?.();
      const currentIndex = Number(current?.index);
      if (Number.isFinite(currentIndex) && currentIndex === nextIndex) return;

      controller.setActiveLevel(nextIndex, { reason: 'intro-zoom-target-floor' });
      await this._waitForAnimationFrames(1);

      log.debug('IntroZoom: synced level context before zoom', {
        tokenCount: elevations.length,
        targetElevation,
        targetLevelIndex: nextIndex,
      });
    } catch (err) {
      log.warn('IntroZoom: failed to sync level before zoom', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Camera mathematics
  // ---------------------------------------------------------------------------

  /**
   * Computes the center-of-mass of the provided tokens in world space.
   *
   * @param {Token[]} tokens
   * @returns {{x: number, y: number}|null}
   */
  _computeCenter(tokens) {
    if (!tokens.length) return null;

    let sumX = 0;
    let sumY = 0;
    let count = 0;
    const gridSize = asNumber(canvas?.grid?.size, 1);

    for (const token of tokens) {
      const doc = token?.document;
      if (!doc) continue;

      const x = asNumber(doc.x, NaN);
      const y = asNumber(doc.y, NaN);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

      const w = asNumber(doc.width, 1) * gridSize;
      const h = asNumber(doc.height, 1) * gridSize;

      sumX += x + w * 0.5;
      sumY += y + h * 0.5;
      count++;
    }

    return count ? { x: sumX / count, y: sumY / count } : null;
  }

  /**
   * Computes the zoom scale that fits the token group's bounding box in the
   * viewport with the given padding on each side.
   *
   * @param {Token[]} tokens
   * @param {number}  padding - Extra pixels added to each side of the group bounds.
   * @returns {number}
   */
  _computeFramingScale(tokens, padding) {
    const gridSize = asNumber(canvas?.grid?.size, 1);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const token of tokens) {
      const doc = token?.document;
      if (!doc) continue;

      const x = asNumber(doc.x, NaN);
      const y = asNumber(doc.y, NaN);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

      const w = asNumber(doc.width, 1) * gridSize;
      const h = asNumber(doc.height, 1) * gridSize;

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + Math.max(1, w));
      maxY = Math.max(maxY, y + Math.max(1, h));
    }

    if (!Number.isFinite(minX)) {
      // Degenerate: fall back to current view scale or a sensible default.
      return clamp(asNumber(canvas?.stage?.scale?.x, 1), 0.5, 1.5);
    }

    const groupW = Math.max(1, maxX - minX) + padding * 2;
    const groupH = Math.max(1, maxY - minY) + padding * 2;
    const { vpW, vpH } = this._getViewportSize();

    const fitScale = Math.min(vpW / groupW, vpH / groupH);
    const minScale = asNumber(CONFIG?.Canvas?.minZoom, 0.1);
    const maxScale = asNumber(CONFIG?.Canvas?.maxZoom, 3.0);

    return clamp(fitScale, minScale, maxScale);
  }

  /**
   * Returns the initial wide-zoom scale: roughly 20–30% of the framing scale,
   * clamped to the canvas minimum zoom so it is always a valid view.
   *
   * @param {number} framingScale
   * @returns {number}
   */
  _computeZoomedOutScale(framingScale) {
    const minScale = asNumber(CONFIG?.Canvas?.minZoom, 0.1);
    const maxStart = Math.max(minScale, framingScale * 0.65);
    return clamp(framingScale * 0.22, minScale, maxStart);
  }

  /**
   * Compute final zoom scale from framing scale while preventing over-zoom-in.
   *
   * @param {number} framingScale
   * @param {number} multiplier
   * @returns {number}
   */
  _computeFinalScale(framingScale, multiplier) {
    const minScale = asNumber(CONFIG?.Canvas?.minZoom, 0.1);
    const maxScale = asNumber(CONFIG?.Canvas?.maxZoom, 3.0);
    const m = clamp(asNumber(multiplier, 0.84), 0.5, 1.0);
    return clamp(framingScale * m, minScale, maxScale);
  }

  /**
   * Clamp and validate scale values before applying camera moves.
   *
   * @param {number} scale
   * @returns {number}
   */
  _sanitizeScale(scale) {
    if (!Number.isFinite(scale)) return NaN;
    const minScale = asNumber(CONFIG?.Canvas?.minZoom, 0.1);
    const maxScale = asNumber(CONFIG?.Canvas?.maxZoom, 3.0);
    // Avoid pathological ultra-wide values that can destabilize downstream effects.
    const rendererSafeMin = Math.max(minScale, 0.15);
    return clamp(scale, rendererSafeMin, maxScale);
  }

  /**
   * Compute a wide starting scale that fits the full scene with extra margin.
   *
   * @param {number} coverageFactor - 1.5 ~= whole map +50% framing.
   * @returns {number}
   */
  _computeSceneWideScale(coverageFactor = 3.0) {
    const sr = canvas?.dimensions?.sceneRect;
    if (!sr) return NaN;

    const { vpW, vpH } = this._getViewportSize();
    const factor = Math.max(1, asNumber(coverageFactor, 3.0));
    const wideW = Math.max(1, asNumber(sr.width, 1) * factor);
    const wideH = Math.max(1, asNumber(sr.height, 1) * factor);

    const fitScale = Math.min(vpW / wideW, vpH / wideH);
    const minScale = asNumber(CONFIG?.Canvas?.minZoom, 0.1);
    const maxScale = asNumber(CONFIG?.Canvas?.maxZoom, 3.0);
    return clamp(fitScale, minScale, maxScale);
  }

  /**
   * Resolve safe viewport dimensions for scale calculations.
   *
   * @returns {{vpW:number, vpH:number}}
   */
  _getViewportSize() {
    const vpW = Math.max(1, this._firstFinite(
      asNumber(canvas?.app?.renderer?.screen?.width, NaN),
      asNumber(canvas?.app?.renderer?.width, NaN),
      asNumber(window.innerWidth, NaN),
      1
    ));
    const vpH = Math.max(1, this._firstFinite(
      asNumber(canvas?.app?.renderer?.screen?.height, NaN),
      asNumber(canvas?.app?.renderer?.height, NaN),
      asNumber(window.innerHeight, NaN),
      1
    ));
    return { vpW, vpH };
  }

  /**
   * Return first finite value from args, or fallback 1.
   *
   * @param {...number} values
   * @returns {number}
   */
  _firstFinite(...values) {
    for (const v of values) {
      if (Number.isFinite(v)) return v;
    }
    return 1;
  }

  /**
   * Enforce a meaningful gap between intro start scale and final framing scale.
   * This avoids the "no zoom-out" look when zoom limits collapse both values.
   *
   * @param {number} startScale
   * @param {number} framingScale
   * @returns {number}
   */
  _ensureDistinctStartScale(startScale, framingScale) {
    const minScale = asNumber(CONFIG?.Canvas?.minZoom, 0.1);
    const requiredGap = Math.max(0.06, framingScale * 0.15);
    const maxStart = Math.max(minScale, framingScale - requiredGap);
    const candidate = Math.min(startScale, maxStart);
    // If limits force us too close to framing scale, force as wide as possible.
    // This keeps a visible zoom movement in tight zoom-limit scenes.
    if (Math.abs(framingScale - candidate) < 0.04) {
      return minScale;
    }
    return candidate;
  }

  /**
   * Instantly moves the PIXI stage to the given world position and scale.
   * Uses canvas.pan() which has no animation duration.
   *
   * @param {number} x     - Foundry world X (PIXI pivot X).
   * @param {number} y     - Foundry world Y (PIXI pivot Y).
   * @param {number} scale - Canvas stage scale.
   */
  _instantCameraPosition(x, y, scale) {
    try {
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale)) {
        throw new Error('Invalid camera position arguments');
      }
      if (typeof canvas?.pan === 'function') {
        canvas.pan({ x, y, scale });
      }
    } catch (err) {
      log.warn('IntroZoom: failed to set instant camera position', err);
    }
  }

  /**
   * Animates the camera from its current position to the target over the given duration.
   *
   * Uses a custom rAF-driven loop rather than canvas.animatePan() to eliminate the
   * phase-mismatch stutter that occurs when PIXI ticker and MapShine's RenderLoop
   * fire requestAnimationFrame callbacks in arbitrary order within a display cycle.
   * By calling canvas.pan() inside our own rAF, the camera position is always
   * current before MapShine samples canvas.stage.pivot on the same frame.
   *
   * @param {number} x          - Target world X.
   * @param {number} y          - Target world Y.
   * @param {number} scale      - Target scale.
   * @param {number} durationMs - Animation duration in milliseconds.
   * @returns {Promise<void>}
   */
  async _animateCameraZoom(x, y, scale, durationMs) {
    try {
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale)) {
        throw new Error('Invalid camera zoom arguments');
      }

      // Arm the render loop into cinematic mode for the zoom duration so that
      // every rAF fires a full Three.js render with no adaptive throttling.
      try {
        window.MapShine?.renderLoop?.startCinematicMode?.(durationMs + 1000);
      } catch (_) {}

      const startX     = asNumber(canvas?.stage?.pivot?.x, x);
      const startY     = asNumber(canvas?.stage?.pivot?.y, y);
      const startScale = asNumber(canvas?.stage?.scale?.x, scale);
      const startMs    = performance.now();

      await new Promise((resolve) => {
        const tick = () => {
          // Abort cleanly if sequence was cancelled mid-animation.
          if (!this._active) { resolve(); return; }

          const nowMs  = performance.now();
          const rawT   = (nowMs - startMs) / durationMs;
          const t      = Math.min(1, rawT);
          const te     = this._easeInOutCosine(t);

          const cx = startX + (x - startX) * te;
          const cy = startY + (y - startY) * te;
          const cs = startScale + (scale - startScale) * te;

          try { canvas.pan({ x: cx, y: cy, scale: cs }); } catch (_) {}

          if (t < 1) {
            requestAnimationFrame(tick);
          } else {
            try { canvas.pan({ x, y, scale }); } catch (_) {}
            resolve();
          }
        };

        requestAnimationFrame(tick);
      });

    } catch (err) {
      log.warn('IntroZoom: camera zoom animation failed', err);
    } finally {
      // Ensure cinematic mode is released even if animation is cut short.
      try { window.MapShine?.renderLoop?.stopCinematicMode?.(); } catch (_) {}
    }
  }

  /**
   * Ease-in-out cosine: same curve Foundry uses for canvas.animatePan.
   *
   * @param {number} t - 0..1 normalized time.
   * @returns {number}
   */
  _easeInOutCosine(t) {
    return (1 - Math.cos(Math.PI * t)) / 2;
  }

  // ---------------------------------------------------------------------------
  // White flash overlay
  // ---------------------------------------------------------------------------

  /**
   * Fade the white overlay out, then destroy it.
   *
   * @param {number} durationMs
   */
  async _fadeOutWhiteOverlay(durationMs) {
    await this._setWhiteOverlayOpacity(0, durationMs);
    this._destroyWhiteOverlay();
  }

  /**
   * Create the full-screen white overlay DOM element at opacity 0.
   * It sits on top of all Foundry UI (z-index 2 000 000) including the loading overlay.
   * @private
   */
  _createWhiteOverlay() {
    this._destroyWhiteOverlay();

    const el = document.createElement('div');
    el.id = 'map-shine-intro-zoom-flash';

    // Style as a fixed full-screen layer above everything.
    // pointer-events: none so it does not intercept any game interaction.
    Object.assign(el.style, {
      position:   'fixed',
      top:        '0px',
      right:      '0px',
      bottom:     '0px',
      left:       '0px',
      width:      '100vw',
      height:     '100vh',
      background: '#ffffff',
      zIndex:     '2147483647',
      opacity:    '0',
      transition: 'opacity 0ms linear',
      pointerEvents: 'none',
      willChange: 'opacity',
      mixBlendMode: 'normal',
      transform: 'translateZ(0)',
    });

    (document.body || document.documentElement).appendChild(el);
    this._overlayEl = el;
  }

  /**
   * Animate the white overlay opacity using a CSS transition.
   * Resolves when the transition ends (or the safety timeout fires).
   *
   * @param {number} target    - Target opacity (0 = transparent, 1 = opaque white).
   * @param {number} durationMs
   * @returns {Promise<void>}
   */
  _setWhiteOverlayOpacity(target, durationMs) {
    return new Promise((resolve) => {
      const el = this._overlayEl;
      if (!el) { resolve(); return; }

      const ms = Math.max(0, durationMs);
      let safetyId = null;

      const cleanup = () => {
        el.removeEventListener('transitionend', cleanup);
        el.removeEventListener('transitioncancel', cleanup);
        if (safetyId !== null) clearTimeout(safetyId);
        resolve();
      };

      // Force a reflow before changing opacity so the browser picks up the
      // initial state. Without this, a same-frame opacity change may be skipped.
      el.style.transition = 'none';
      void el.offsetHeight; // trigger layout

      const applyTransition = () => {
        if (!this._overlayEl || this._overlayEl !== el) {
          cleanup();
          return;
        }

        el.style.transition = `opacity ${ms}ms ease-in-out`;
        el.style.opacity = String(target);

        if (ms <= 0) {
          cleanup();
          return;
        }

        el.addEventListener('transitionend', cleanup, { once: true });
        el.addEventListener('transitioncancel', cleanup, { once: true });
        safetyId = setTimeout(cleanup, ms + 350);
      };

      // Two RAFs make the start state deterministic across browsers/compositor timing.
      requestAnimationFrame(() => requestAnimationFrame(applyTransition));
    });
  }

  /**
   * Await N animation frames.
   *
   * @param {number} frameCount
   * @returns {Promise<void>}
   */
  async _waitForAnimationFrames(frameCount = 1) {
    let remaining = Math.max(0, frameCount | 0);
    while (remaining-- > 0) {
      await new Promise((resolve) => {
        if (!globalThis.requestAnimationFrame) {
          setTimeout(resolve, 16);
          return;
        }
        requestAnimationFrame(() => resolve());
      });
    }
  }

  /**
   * Wait briefly for stable frame pacing before starting the visual transition.
   * This reduces cases where fade/zoom appears to jump under heavy startup load.
   *
   * @param {{maxWaitMs?: number, targetFrameMs?: number, requiredStableFrames?: number}} [opts]
   * @returns {Promise<void>}
   */
  async _waitForSmoothRendering(opts = {}) {
    const maxWaitMs = Math.max(0, asNumber(opts.maxWaitMs, 2500));
    const targetFrameMs = Math.max(8, asNumber(opts.targetFrameMs, 40));
    const requiredStableFrames = Math.max(2, asNumber(opts.requiredStableFrames, 8));

    if (!globalThis.requestAnimationFrame || maxWaitMs <= 0) return;

    const startTime = performance.now();
    let stable = 0;
    let lastTs = startTime;

    while ((performance.now() - startTime) < maxWaitMs && stable < requiredStableFrames) {
      const ts = await new Promise((resolve) => requestAnimationFrame(resolve));
      const dt = ts - lastTs;
      lastTs = ts;

      if (dt > 0 && dt <= targetFrameMs) stable += 1;
      else stable = 0;
    }
  }

  /**
   * Remove the white overlay element from the DOM.
   * @private
   */
  _destroyWhiteOverlay() {
    if (this._overlayEl) {
      try { this._overlayEl.remove(); } catch (_) {}
      this._overlayEl = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Fallback path
  // ---------------------------------------------------------------------------

  /**
   * Standard loading screen fade-in with no intro zoom.
   * Mirrors the existing behaviour in canvas-replacement.js.
   *
   * @param {object} loadingOverlay
   */
  async _fallback(loadingOverlay) {
    try {
      await Promise.race([
        loadingOverlay.fadeIn(2000, 800),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    } catch (_) {
      try { loadingOverlay.hide(); } catch (_) {}
    }
  }
}
