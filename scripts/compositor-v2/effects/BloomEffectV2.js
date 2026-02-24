/**
 * @fileoverview BloomEffectV2 — V2 screen-space bloom post-processing pass.
 *
 * Wraps THREE.UnrealBloomPass to produce high-quality multi-mip bloom glow.
 * Pipeline: threshold bright pixels → progressive mip-chain blur → additive composite.
 *
 * Simplifications vs V1:
 *   - No vision masking via FoundryFogBridge (deferred)
 *   - No scene-rect padding exclusion (V2 compositor handles this)
 *   - No ember hotspot layer injection (deferred)
 *   - No V1 readBuffer/writeBuffer pattern — uses inputRT/outputRT directly
 *
 * Features retained:
 *   - Strength, radius, threshold controls
 *   - Bloom tint color (warm/cool glow)
 *   - Blend opacity
 *
 * @module compositor-v2/effects/BloomEffectV2
 */

import { createLogger } from '../../core/log.js';

const log = createLogger('BloomEffectV2');

export class BloomEffectV2 {
  constructor() {
    /** @type {boolean} */
    this._initialized = false;

    this.params = {
      enabled: true,
      strength: 0.63,
      radius: 0.82,
      threshold: 0.86,
      tintColor: { r: 1, g: 1, b: 1 },
      blendOpacity: 1.0,
    };

    // ── GPU resources ───────────────────────────────────────────────────
    /** @type {THREE.UnrealBloomPass|null} */
    this._pass = null;

    /**
     * Internal RT used as the "readBuffer" for UnrealBloomPass.
     * We copy inputRT → this RT, run the pass (which writes back into it),
     * then copy the result → outputRT.
     * @type {THREE.WebGLRenderTarget|null}
     */
    this._bloomInputRT = null;

    // Copy/blit resources for RT-to-RT transfers
    /** @type {THREE.Scene|null} */
    this._copyScene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._copyCamera = null;
    /** @type {THREE.MeshBasicMaterial|null} */
    this._copyMaterial = null;
    /** @type {THREE.Mesh|null} */
    this._copyQuad = null;

    /** @type {THREE.Vector3|null} */
    this._tintVec = null;
    this._lastTintR = null;
    this._lastTintG = null;
    this._lastTintB = null;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * @param {number} w - Render target width
   * @param {number} h - Render target height
   */
  initialize(w, h) {
    const THREE = window.THREE;
    if (!THREE || !THREE.UnrealBloomPass) {
      log.warn('THREE.UnrealBloomPass not available — bloom disabled');
      return;
    }

    const size = new THREE.Vector2(w, h);

    // Create the UnrealBloomPass with default params
    this._pass = new THREE.UnrealBloomPass(
      size,
      this.params.strength,
      this.params.radius,
      this.params.threshold
    );

    // Internal RT for the pass to read from and write back to.
    // LinearSRGBColorSpace: bloom operates in linear space so the threshold
    // and additive composite are physically correct.
    this._bloomInputRT = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this._bloomInputRT.texture.colorSpace = THREE.LinearSRGBColorSpace;

    // Copy scene for RT-to-RT blits
    this._copyScene = new THREE.Scene();
    this._copyCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._copyMaterial = new THREE.MeshBasicMaterial({ map: null });
    this._copyMaterial.toneMapped = false;
    this._copyQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this._copyMaterial
    );
    this._copyQuad.frustumCulled = false;
    this._copyScene.add(this._copyQuad);

    this._tintVec = new THREE.Vector3(1, 1, 1);
    this._updateTintColor();

    this._initialized = true;
    log.info(`BloomEffectV2 initialized (${w}x${h})`);
  }

  // ── Per-frame update ──────────────────────────────────────────────────

  /**
   * Push current params to the UnrealBloomPass.
   * @param {{ elapsed: number, delta: number }} _timeInfo
   */
  update(_timeInfo) {
    if (!this._initialized || !this._pass) return;
    if (!this.params.enabled) return;

    const p = this.params;
    this._pass.strength = p.strength;
    this._pass.radius = p.radius;
    this._pass.threshold = p.threshold;

    // Update blend opacity on the pass's internal blend material
    try {
      const u = this._pass.copyUniforms || this._pass.blendMaterial?.uniforms;
      if (u?.opacity?.value !== undefined) {
        u.opacity.value = p.blendOpacity;
      }
    } catch (_) {}

    // Update tint color if changed
    const tc = p.tintColor;
    if (tc.r !== this._lastTintR || tc.g !== this._lastTintG || tc.b !== this._lastTintB) {
      this._updateTintColor();
    }
  }

  /**
   * Apply the current tint color to all bloom mip levels.
   * @private
   */
  _updateTintColor() {
    if (!this._pass || !this._tintVec) return;

    const tc = this.params.tintColor;
    this._tintVec.set(tc.r, tc.g, tc.b);

    const tintColors = this._pass.bloomTintColors;
    if (tintColors) {
      for (let i = 0; i < tintColors.length; i++) {
        tintColors[i].copy(this._tintVec);
      }
    }

    this._lastTintR = tc.r;
    this._lastTintG = tc.g;
    this._lastTintB = tc.b;
  }

  // ── Render ────────────────────────────────────────────────────────────

  /**
   * Execute the bloom post-processing pass.
   *
   * Flow:
   * 1. Copy inputRT → _bloomInputRT
   * 2. UnrealBloomPass reads _bloomInputRT, writes bloom blend back into it
   * 3. Copy _bloomInputRT → outputRT
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} inputRT
   * @param {THREE.WebGLRenderTarget} outputRT
   */
  render(renderer, inputRT, outputRT) {
    if (!this._initialized || !this._pass || !inputRT) return;
    if (!this.params.enabled) return;

    // Skip if bloom is effectively invisible
    const p = this.params;
    if (!(p.strength > 1e-6) || !(p.blendOpacity > 1e-6)) return;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    try {
      // Step 1: Copy inputRT → _bloomInputRT
      this._copyMaterial.map = inputRT.texture;
      renderer.setRenderTarget(this._bloomInputRT);
      renderer.autoClear = true;
      renderer.render(this._copyScene, this._copyCamera);

      // Step 2: Run UnrealBloomPass (reads + writes _bloomInputRT)
      // UnrealBloomPass.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive)
      // It writes its final blend result back into the readBuffer.
      this._pass.render(renderer, null, this._bloomInputRT, 0.016, false);

      // Step 3: Copy _bloomInputRT (now contains scene + bloom) → outputRT
      this._copyMaterial.map = this._bloomInputRT.texture;
      renderer.setRenderTarget(outputRT);
      renderer.autoClear = true;
      renderer.render(this._copyScene, this._copyCamera);
    } catch (e) {
      // Fallback: pass through input → output on error
      try {
        this._copyMaterial.map = inputRT.texture;
        renderer.setRenderTarget(outputRT);
        renderer.autoClear = true;
        renderer.render(this._copyScene, this._copyCamera);
      } catch (_) {}

      if (Math.random() < 0.01) {
        log.warn('BloomEffectV2 render error:', e);
      }
    } finally {
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }
  }

  // ── Resize ────────────────────────────────────────────────────────────

  /**
   * Resize internal render targets and the UnrealBloomPass.
   * @param {number} w
   * @param {number} h
   */
  onResize(w, h) {
    if (this._pass) {
      this._pass.setSize(w, h);
    }
    if (this._bloomInputRT) {
      this._bloomInputRT.setSize(w, h);
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  dispose() {
    try { this._pass?.dispose(); } catch (_) {}
    try { this._bloomInputRT?.dispose(); } catch (_) {}
    try { this._copyMaterial?.dispose(); } catch (_) {}
    try { this._copyQuad?.geometry?.dispose(); } catch (_) {}
    this._pass = null;
    this._bloomInputRT = null;
    this._copyScene = null;
    this._copyCamera = null;
    this._copyMaterial = null;
    this._copyQuad = null;
    this._tintVec = null;
    this._initialized = false;
    log.info('BloomEffectV2 disposed');
  }
}
