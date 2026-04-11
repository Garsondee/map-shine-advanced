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
      // WaterEffectV2 writes a linear specular mask; injected here before UnrealBloom threshold.
      waterSpecularBloomEnabled: true,
      waterSpecularBloomStrength: 1.25,
      waterSpecularBloomGamma: 1.0,
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

    /** @type {THREE.Texture|null} Second target from WaterEffectV2 MRT (linear RGB mask). */
    this._waterSpecBloomTexture = null;

    /** @type {THREE.Scene|null} */
    this._waterBloomCompositeScene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._waterBloomCompositeCamera = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._waterBloomCompositeMaterial = null;
    /** @type {THREE.DataTexture|null} */
    this._black1x1Texture = null;
  }

  // ── UI schema (moved from V1 BloomEffect) ────────────────────────────────

  static getControlSchema() {
    const white = { r: 1, g: 1, b: 1 };
    const warm = { r: 1, g: 0.96, b: 0.88 };
    const neon = { r: 0.75, g: 0.92, b: 1 };

    return {
      enabled: true,
      help: {
        title: 'Bloom (glow)',
        summary: [
          'Adds screen-space glow around bright pixels (highlights, lamps, sky, specular) using a multi-pass blur.',
          'No tile masks required. Runs after the main scene is composited (post-processing).',
          'Water specular can feed a dedicated linear mask (see Water → Bloom link) so sun glints bloom strongly without over-brightening the base image.',
          'Performance: extra full-screen passes and mip blur — lower radius and blend on large maps or weak GPUs if needed.',
          'Persistence: these controls save with the scene (not World Based).',
        ].join('\n\n'),
        glossary: {
          Strength: 'How much glow is added on top of the image.',
          Radius: 'Spread of the glow (blur footprint). Higher = wider halos.',
          Threshold: 'Brightness cutoff (linear). Only pixels above this contribute to bloom.',
          'Glow tint': 'Multiplies bloom color per mip (warm candlelight vs cool moonlight).',
          'Blend opacity': 'Master mix for the entire bloom composite (0 = off).',
          'Water bloom (specular)': 'Adds linear HDR from water specular/highlight mask before threshold — strong glints without crushing the beauty pass.',
          'Water bloom strength': 'How much of the water mask is added into the bloom input (linear).',
          'Water bloom gamma': 'Curve on the injected mask (<1 = punchier peaks, >1 = softer).',
        },
      },
      groups: [
        {
          name: 'look',
          label: 'Look',
          type: 'folder',
          expanded: true,
          parameters: ['strength', 'radius', 'threshold'],
        },
        {
          name: 'water-spec-bloom',
          label: 'Water specular (bloom)',
          type: 'folder',
          expanded: false,
          parameters: ['waterSpecularBloomEnabled', 'waterSpecularBloomStrength', 'waterSpecularBloomGamma'],
        },
        {
          name: 'grade',
          label: 'Grade',
          type: 'folder',
          expanded: true,
          parameters: ['tintColor', 'blendOpacity'],
        },
      ],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true },
        strength: {
          type: 'slider',
          label: 'Strength',
          min: 0,
          max: 3,
          step: 0.01,
          default: 0.63,
          tooltip: 'Intensity of the glow added on top of the scene.',
        },
        radius: {
          type: 'slider',
          label: 'Radius',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.82,
          tooltip: 'How far the glow spreads (blur size).',
        },
        threshold: {
          type: 'slider',
          label: 'Threshold',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.86,
          tooltip: 'Linear brightness floor; only brighter pixels bloom.',
        },
        tintColor: {
          type: 'color',
          colorType: 'float',
          label: 'Glow tint',
          default: { r: 1, g: 1, b: 1 },
          tooltip: 'Tint applied to bloom (white = neutral).',
        },
        blendOpacity: {
          type: 'slider',
          label: 'Blend opacity',
          min: 0,
          max: 1,
          step: 0.01,
          default: 1.0,
          tooltip: 'Overall bloom mix. Use 0 to disable without turning the effect off.',
        },
        waterSpecularBloomEnabled: {
          type: 'boolean',
          default: true,
          label: 'Link water specular',
          tooltip: 'When on (and water renders a mask), add water specular energy into the bloom input before threshold.',
        },
        waterSpecularBloomStrength: {
          type: 'slider',
          label: 'Water bloom strength',
          min: 0,
          max: 8,
          step: 0.01,
          default: 1.25,
          tooltip: 'Linear HDR added from the water specular mask. Push high for aggressive sun glints.',
        },
        waterSpecularBloomGamma: {
          type: 'slider',
          label: 'Water bloom gamma',
          min: 0.35,
          max: 3,
          step: 0.01,
          default: 1.0,
          tooltip: 'Shapes the injected mask before bloom (1 = linear). Lower emphasizes peaks.',
        },
      },
      presets: {
        Subtle: {
          strength: 0.8,
          radius: 0.2,
          threshold: 0.9,
          tintColor: { ...white },
          blendOpacity: 1.0,
        },
        Strong: {
          strength: 2.0,
          radius: 0.8,
          threshold: 0.7,
          tintColor: { ...white },
          blendOpacity: 1.0,
        },
        Dreamy: {
          strength: 1.5,
          radius: 1.0,
          threshold: 0.6,
          tintColor: { ...warm },
          blendOpacity: 1.0,
        },
        Neon: {
          strength: 2.5,
          radius: 0.3,
          threshold: 0.2,
          tintColor: { ...neon },
          blendOpacity: 1.0,
        },
      },
    };
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

    const blackPx = new Uint8Array([0, 0, 0, 255]);
    this._black1x1Texture = new THREE.DataTexture(blackPx, 1, 1, THREE.RGBAFormat);
    this._black1x1Texture.needsUpdate = true;

    this._waterBloomCompositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tWaterSpecBloom: { value: this._black1x1Texture },
        uWaterBloomMix: { value: 0 },
        uWaterBloomGamma: { value: 1.0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform sampler2D tWaterSpecBloom;
        uniform float uWaterBloomMix;
        uniform float uWaterBloomGamma;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tDiffuse, vUv);
          vec3 h0 = texture2D(tWaterSpecBloom, vUv).rgb * uWaterBloomMix;
          float g = max(0.05, uWaterBloomGamma);
          vec3 h = pow(max(h0, vec3(0.0)), vec3(g));
          gl_FragColor = vec4(c.rgb + h, c.a);
        }
      `,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const wbQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this._waterBloomCompositeMaterial
    );
    wbQuad.frustumCulled = false;
    this._waterBloomCompositeScene = new THREE.Scene();
    this._waterBloomCompositeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._waterBloomCompositeScene.add(wbQuad);

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
  /**
   * @param {THREE.Texture|null} tex - RGB linear mask from WaterEffectV2, or null to disable.
   */
  setWaterSpecularBloomTexture(tex) {
    this._waterSpecBloomTexture = tex || null;
  }

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
      // Step 1: Copy inputRT → _bloomInputRT (optionally add water specular mask in linear)
      const p0 = this.params;
      const useWaterBloom = this._waterSpecBloomTexture
        && p0.waterSpecularBloomEnabled !== false
        && (Number(p0.waterSpecularBloomStrength) > 1e-6);
      if (useWaterBloom && this._waterBloomCompositeMaterial && this._waterBloomCompositeScene) {
        const wm = this._waterBloomCompositeMaterial.uniforms;
        wm.tDiffuse.value = inputRT.texture;
        wm.tWaterSpecBloom.value = this._waterSpecBloomTexture;
        wm.uWaterBloomMix.value = Number(p0.waterSpecularBloomStrength) || 0;
        wm.uWaterBloomGamma.value = Math.max(0.05, Number(p0.waterSpecularBloomGamma) || 1.0);
        renderer.setRenderTarget(this._bloomInputRT);
        renderer.autoClear = true;
        renderer.render(this._waterBloomCompositeScene, this._waterBloomCompositeCamera);
      } else {
        this._copyMaterial.map = inputRT.texture;
        renderer.setRenderTarget(this._bloomInputRT);
        renderer.autoClear = true;
        renderer.render(this._copyScene, this._copyCamera);
      }

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
    try {
      const q = this._waterBloomCompositeScene?.children?.[0];
      if (q?.geometry) q.geometry.dispose();
    } catch (_) {}
    try { this._waterBloomCompositeMaterial?.dispose(); } catch (_) {}
    try { this._black1x1Texture?.dispose(); } catch (_) {}
    this._waterBloomCompositeScene = null;
    this._waterBloomCompositeCamera = null;
    this._waterBloomCompositeMaterial = null;
    this._black1x1Texture = null;
    this._waterSpecBloomTexture = null;
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
