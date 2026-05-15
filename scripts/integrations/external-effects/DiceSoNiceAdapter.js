/**
 * @fileoverview DiceSoNiceAdapter — bridges Dice So Nice's own Three.js
 * canvas into MSA's compositor by sampling its `<canvas>` as a
 * `THREE.CanvasTexture` (handed to {@link ExternalDsnPass} for fullscreen
 * compositing).
 *
 * Approach (cannot share WebGL contexts across Three versions r184/r170):
 *   1. Wait for `diceSoNiceReady` and grab `game.dice3d.box.diceScene.renderer.domElement`.
 *   2. Wrap that DOM canvas with a `CanvasTexture`. Each frame DSN renders to
 *      it, we mark the texture dirty (`needsUpdate = true`) via a small
 *      monkey-patch on the DSN renderer's `.render(scene, camera)`.
 *   3. Hide the DSN canvas (`display:none`) so it does not paint directly on
 *      top of MSA's WebGL canvas.
 *   4. Enable/disable {@link ExternalDsnPass} on `diceSoNiceRollStart` /
 *      `diceSoNiceRollComplete` plus a `hideAfterRoll` grace window.
 *
 * On `dispose()` (scene teardown, adapter disable, or DSN re-init) all
 * monkey-patches are reverted and the DSN canvas's original `display`
 * style is restored, so disabling MSA fully restores DSN's stock behaviour.
 *
 * @module integrations/external-effects/DiceSoNiceAdapter
 */

import { createLogger } from '../../core/log.js';

const log = createLogger('DiceSoNiceAdapter');

/** Default grace period after a roll completes before disabling the pass. */
const DEFAULT_GRACE_MS = 4000;
const PREWARM_POLL_INTERVAL_MS = 250;
const PREWARM_MAX_MS = 15000;

const DSN_PERFORMANCE_PRESETS = Object.freeze({
  native:   { mode: 'native',   maxPixelRatio: Infinity, maxUploadFps: 0 },
  balanced: { mode: 'balanced', maxPixelRatio: 1.0,      maxUploadFps: 24 },
  quality:  { mode: 'quality',  maxPixelRatio: 1.5,      maxUploadFps: 30 },
});

export class DiceSoNiceAdapter {
  /**
   * @param {{
   *   compositor: any,
   *   dsnPass: import('./ExternalDsnPass.js').ExternalDsnPass|null,
   *   renderLoop: any,
   * }} refs
   */
  constructor(refs) {
    this._compositor = refs.compositor;
    this._dsnPass = refs.dsnPass;
    this._renderLoop = refs.renderLoop;

    /** @type {boolean} */
    this._enabled = true;

    /** @type {boolean} */
    this._initialized = false;

    /** @type {boolean} */
    this._disposed = false;

    /** @type {boolean} */
    this._wired = false;

    /** @type {HTMLCanvasElement|null} */
    this._dsnCanvas = null;

    /** @type {string|null} */
    this._dsnOriginalDisplay = null;

    /** @type {any|null} */
    this._dsnRenderer = null;

    /** @type {Function|null} */
    this._origRenderFn = null;

    /** @type {Function|null} */
    this._origSetPixelRatioFn = null;

    /** @type {any|null} */
    this._canvasTexture = null;

    /** @type {Array<{name:string,id:number}>} */
    this._hookIds = [];

    /** @type {number|null} */
    this._graceTimerId = null;

    /** @type {number} */
    this._graceMs = DEFAULT_GRACE_MS;

    /** @type {number|null} */
    this._prewarmIntervalId = null;

    /** @type {number} */
    this._prewarmStartMs = 0;

    /** @type {{ mode: string, maxPixelRatio: number, maxUploadFps: number }} */
    this._performance = { ...DSN_PERFORMANCE_PRESETS.balanced };

    /** @type {number} */
    this._lastTextureDirtyAtMs = 0;

    /** @type {number} */
    this._lastRenderRequestAtMs = 0;
  }

  /**
   * Register Dice-So-Nice lifecycle hooks. If DSN is already running, wire
   * up immediately; otherwise wait for `diceSoNiceReady`.
   */
  initialize() {
    if (this._initialized || this._disposed) return;
    this._initialized = true;

    const reg = (name, fn, once = false) => {
      try {
        const id = once ? Hooks.once(name, fn) : Hooks.on(name, fn);
        this._hookIds.push({ name, id });
      } catch (e) {
        log.warn(`Hooks.${once ? 'once' : 'on'}(${name}) failed:`, e);
      }
    };

    // Wire when ready. Some DSN builds lazily create the board renderer on the
    // first roll, so we listen to both init + ready and also run a short
    // prewarm polling window to catch late/lazy construction.
    reg('diceSoNiceInit', () => this._attemptWireFromGame('diceSoNiceInit'));
    reg('diceSoNiceReady', (dice3d) => this._wireRenderer(dice3d));
    this._attemptWireFromGame('initialize');
    this._startPrewarmPolling();

    reg('diceSoNiceRollStart', () => this._onRollStart());
    reg('diceSoNiceRollComplete', () => this._onRollComplete());

    log.info('DiceSoNiceAdapter initialized');
  }

  /** @returns {boolean} */
  get isWired() { return this._wired; }

  /**
   * Enable/disable the adapter. When disabled, restores the DSN canvas to
   * its original display style so DSN keeps rolling visibly on top.
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    const next = !!enabled;
    if (this._enabled === next) return;
    this._enabled = next;
    if (!next) {
      // Disable pass and reveal DSN canvas so the user still sees dice.
      try { if (this._dsnPass) this._dsnPass.enabled = false; } catch (_) {}
      this._showDsnCanvas();
    } else if (this._wired) {
      this._hideDsnCanvas();
    }
  }

  /**
   * Switch Dice So Nice integration performance mode at runtime.
   *
   * - `native`: restore DSN's DOM overlay and skip MSA compositing (fastest)
   * - `balanced`: DPR 1 + 24fps canvas uploads (default)
   * - `quality`: DPR 1.5 + 30fps canvas uploads
   *
   * @param {'native'|'balanced'|'quality'} mode
   */
  setPerformanceMode(mode) {
    const preset = DSN_PERFORMANCE_PRESETS[mode] ?? DSN_PERFORMANCE_PRESETS.balanced;
    this._performance = { ...preset };

    try {
      if (this._dsnPass) this._dsnPass.enabled = false;
      if (preset.mode === 'native') this._showDsnCanvas();
      else if (this._enabled && this._wired) this._hideDsnCanvas();
    } catch (_) {}

    this._applyPixelRatioCap();
  }

  /** @returns {{ mode: string, maxPixelRatio: number, maxUploadFps: number }} */
  getPerformanceOptions() {
    return { ...this._performance };
  }

  /** @returns {number} Preferred compositor FPS while DSN is active. */
  getPreferredContinuousFps() {
    const fps = Number(this._performance.maxUploadFps);
    return Number.isFinite(fps) && fps > 0 ? fps : 0;
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  _wireRenderer(dice3d) {
    if (this._wired || this._disposed) return;
    if (!dice3d) return;

    let diceScene = null;
    let renderer = null;
    try {
      diceScene = dice3d?.box?.diceScene ?? null;
      renderer = diceScene?.renderer ?? null;
    } catch (_) {}
    if (!renderer || !renderer.domElement) {
      log.debug('DSN renderer not yet available, deferring');
      return;
    }

    const THREE = window.THREE;
    if (!THREE) {
      log.warn('window.THREE missing — cannot wrap DSN canvas');
      return;
    }

    this._dsnRenderer = renderer;
    this._dsnCanvas = renderer.domElement;
    this._installPixelRatioCap(renderer);

    // Create CanvasTexture wrapping DSN's canvas. flipY=true since the canvas
    // is rendered top-down by WebGL.
    try {
      const tex = new THREE.CanvasTexture(this._dsnCanvas);
      tex.colorSpace = THREE.SRGBColorSpace ?? tex.colorSpace;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.flipY = false; // DSN canvas already has top-left origin; we sample directly.
      tex.needsUpdate = true;
      this._canvasTexture = tex;
      this._dsnPass?.setTexture(tex);
    } catch (e) {
      log.warn('Failed to wrap DSN canvas as CanvasTexture:', e);
      this._dsnRenderer = null;
      this._dsnCanvas = null;
      return;
    }

    // Monkey-patch DSN renderer .render() to mark texture dirty and request a
    // continuous render window while dice are animating.
    try {
      const origRender = renderer.render?.bind?.(renderer);
      if (typeof origRender === 'function') {
        this._origRenderFn = origRender;
        renderer.render = (s, c) => {
          origRender(s, c);
          this._markTextureDirtyThrottled();
          this._requestRenderThrottled();
        };
      }
    } catch (e) {
      log.warn('Failed to monkey-patch DSN renderer.render:', e);
    }

    if (this._enabled && this._performance.mode !== 'native') this._hideDsnCanvas();
    else this._showDsnCanvas();
    this._wired = true;
    this._stopPrewarmPolling();
    log.info('DSN renderer wired into MSA compositor', {
      canvas: { w: this._dsnCanvas.width, h: this._dsnCanvas.height },
    });
  }

  _onRollStart() {
    if (!this._enabled) return;
    if (!this._wired) {
      this._attemptWireFromGame('rollStart');
    }
    if (!this._wired) return;
    if (!this._dsnPass) return;
    this._clearGraceTimer();
    if (this._performance.mode === 'native') {
      try { this._dsnPass.enabled = false; } catch (_) {}
      this._showDsnCanvas();
      return;
    }
    try { this._dsnPass.enabled = true; } catch (_) {}
    this._forceTextureDirty();
    try { this._renderLoop?.requestContinuousRender?.(2000); } catch (_) {}
  }

  _onRollComplete() {
    if (!this._enabled || !this._wired) return;
    if (!this._dsnPass) return;
    this._clearGraceTimer();
    // Read DSN's hideAfterRoll timing for a sensible grace window.
    try {
      const cfg = globalThis.game?.dice3d?.config ?? null;
      const after = Number(cfg?.timeBeforeHide);
      if (Number.isFinite(after) && after > 0) {
        this._graceMs = Math.max(500, Math.min(15000, after));
      }
    } catch (_) {}
    this._graceTimerId = setTimeout(() => {
      this._graceTimerId = null;
      if (this._dsnPass) this._dsnPass.enabled = false;
    }, this._graceMs);
  }

  _clearGraceTimer() {
    if (this._graceTimerId != null) {
      try { clearTimeout(this._graceTimerId); } catch (_) {}
      this._graceTimerId = null;
    }
  }

  _attemptWireFromGame(reason = 'unknown') {
    try {
      const dice3d = globalThis.game?.dice3d ?? null;
      if (!dice3d) return;
      this._wireRenderer(dice3d);
      if (this._wired) {
        log.debug(`DSN renderer wired via ${reason}`);
      }
    } catch (_) {}
  }

  _startPrewarmPolling() {
    if (this._prewarmIntervalId != null || this._wired || this._disposed) return;
    this._prewarmStartMs = performance.now();
    this._prewarmIntervalId = setInterval(() => {
      if (this._disposed || this._wired) {
        this._stopPrewarmPolling();
        return;
      }
      if ((performance.now() - this._prewarmStartMs) > PREWARM_MAX_MS) {
        this._stopPrewarmPolling();
        return;
      }
      this._attemptWireFromGame('prewarmPoll');
    }, PREWARM_POLL_INTERVAL_MS);
  }

  _stopPrewarmPolling() {
    if (this._prewarmIntervalId != null) {
      try { clearInterval(this._prewarmIntervalId); } catch (_) {}
      this._prewarmIntervalId = null;
    }
    this._prewarmStartMs = 0;
  }

  _installPixelRatioCap(renderer) {
    if (!renderer || this._origSetPixelRatioFn) {
      this._applyPixelRatioCap();
      return;
    }
    const orig = renderer.setPixelRatio?.bind?.(renderer);
    if (typeof orig !== 'function') return;
    this._origSetPixelRatioFn = orig;
    renderer.setPixelRatio = (value) => {
      const cap = Number(this._performance.maxPixelRatio);
      const requested = Number(value);
      const next = Number.isFinite(cap) && cap > 0
        ? Math.min(Number.isFinite(requested) ? requested : cap, cap)
        : requested;
      return orig(next);
    };
    this._applyPixelRatioCap();
  }

  _applyPixelRatioCap() {
    const renderer = this._dsnRenderer;
    if (!renderer || typeof renderer.setPixelRatio !== 'function') return;
    const cap = Number(this._performance.maxPixelRatio);
    if (!Number.isFinite(cap) || cap <= 0) return;
    try {
      const current = Number(renderer.getPixelRatio?.());
      const target = Number.isFinite(current) ? Math.min(current, cap) : cap;
      renderer.setPixelRatio(target);
    } catch (_) {}
  }

  _forceTextureDirty() {
    this._lastTextureDirtyAtMs = performance.now();
    try { if (this._canvasTexture) this._canvasTexture.needsUpdate = true; } catch (_) {}
  }

  _markTextureDirtyThrottled() {
    if (!this._canvasTexture || this._performance.mode === 'native') return;
    const fps = Number(this._performance.maxUploadFps);
    if (!Number.isFinite(fps) || fps <= 0) return;
    const now = performance.now();
    const minIntervalMs = 1000 / fps;
    if ((now - this._lastTextureDirtyAtMs) < minIntervalMs) return;
    this._lastTextureDirtyAtMs = now;
    try { this._canvasTexture.needsUpdate = true; } catch (_) {}
  }

  _requestRenderThrottled() {
    if (this._performance.mode === 'native') return;
    const now = performance.now();
    if ((now - this._lastRenderRequestAtMs) < 250) return;
    this._lastRenderRequestAtMs = now;
    try { this._renderLoop?.requestContinuousRender?.(400); } catch (_) {}
  }

  _hideDsnCanvas() {
    const c = this._dsnCanvas;
    if (!c) return;
    if (this._dsnOriginalDisplay == null) {
      this._dsnOriginalDisplay = c.style.display || '';
    }
    try { c.style.display = 'none'; } catch (_) {}
  }

  _showDsnCanvas() {
    const c = this._dsnCanvas;
    if (!c) return;
    try {
      c.style.display = this._dsnOriginalDisplay ?? '';
    } catch (_) {}
  }

  // ── Disposal ──────────────────────────────────────────────────────────────

  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    for (const { name, id } of this._hookIds) {
      try { Hooks.off(name, id); } catch (_) {}
    }
    this._hookIds.length = 0;
    this._clearGraceTimer();
    this._stopPrewarmPolling();

    // Unpatch DSN renderer.
    try {
      if (this._dsnRenderer && this._origRenderFn) {
        this._dsnRenderer.render = this._origRenderFn;
      }
      if (this._dsnRenderer && this._origSetPixelRatioFn) {
        this._dsnRenderer.setPixelRatio = this._origSetPixelRatioFn;
      }
    } catch (_) {}
    this._origRenderFn = null;
    this._origSetPixelRatioFn = null;
    this._dsnRenderer = null;

    // Restore DSN canvas display.
    this._showDsnCanvas();
    this._dsnCanvas = null;
    this._dsnOriginalDisplay = null;

    // Dispose CanvasTexture.
    try { this._canvasTexture?.dispose?.(); } catch (_) {}
    try { this._dsnPass?.setTexture?.(null); } catch (_) {}
    this._canvasTexture = null;

    this._wired = false;
    log.info('DiceSoNiceAdapter disposed');
  }
}
