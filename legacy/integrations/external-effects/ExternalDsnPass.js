/**
 * @fileoverview ExternalDsnPass — fullscreen composite pass that samples the
 * Dice So Nice `<canvas>` texture and blends it on top of the current scene
 * RT. Inserted inside `FloorCompositor.render()` between the per-level
 * composite and the late post-FX overlays (fog/lens), so dice receive bloom
 * and color-grade from the per-level pipeline but are not darkened by the
 * lighting compose step.
 *
 * The pass is fully self-contained: it owns its scene/camera/material/mesh
 * and accepts an externally managed `CanvasTexture` via {@link setTexture}.
 *
 * @module integrations/external-effects/ExternalDsnPass
 */

import { createLogger } from '../../core/log.js';

const log = createLogger('ExternalDsnPass');

export class ExternalDsnPass {
  /**
   * @param {any} THREE  window.THREE (passed explicitly for testability)
   */
  constructor(THREE) {
    this._THREE = THREE;

    /** When true, {@link render} composites the DSN texture; otherwise a no-op. */
    this.enabled = false;

    /** @type {boolean} */
    this._initialized = false;

    /** @type {boolean} */
    this._disposed = false;

    /** @type {any|null} */
    this._scene = null;
    /** @type {any|null} */
    this._camera = null;
    /** @type {any|null} */
    this._mesh = null;
    /** @type {any|null} */
    this._material = null;
    /** @type {any|null} */
    this._copyMaterial = null;
    /** @type {any|null} */
    this._copyMesh = null;
    /** @type {any|null} */
    this._geometry = null;
    /** @type {any|null} */
    this._texture = null;
  }

  /**
   * Build the fullscreen scene/camera and shader materials. Idempotent.
   */
  initialize() {
    if (this._initialized || this._disposed) return;
    const THREE = this._THREE;
    if (!THREE) {
      log.warn('initialize: THREE not provided');
      return;
    }

    this._scene = new THREE.Scene();
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._geometry = new THREE.PlaneGeometry(2, 2);

    // Pass 1: copy scene RT → output RT, then overlay DSN texture.
    // To avoid two passes, we sample both `tScene` and `tDice` in one shader.
    this._material = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null },
        tDice: { value: null },
        uDiceOpacity: { value: 1.0 },
        uDiceTint: { value: new THREE.Vector3(1.0, 1.0, 1.0) },
        uDiceBrightness: { value: 1.0 },
        uDiceSaturation: { value: 1.0 },
        uDiceContrast: { value: 1.0 },
        uDiceGamma: { value: 1.0 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tScene;
        uniform sampler2D tDice;
        uniform float uDiceOpacity;
        uniform vec3 uDiceTint;
        uniform float uDiceBrightness;
        uniform float uDiceSaturation;
        uniform float uDiceContrast;
        uniform float uDiceGamma;
        varying vec2 vUv;

        // Rec. 709 luma weights — matches scene compositor convention.
        const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

        void main() {
          vec4 scene = texture2D(tScene, vUv);
          // DSN canvas is rendered with a top-left origin; flip V for sampling.
          vec4 dice = texture2D(tDice, vec2(vUv.x, 1.0 - vUv.y));

          vec3 rgb = dice.rgb * uDiceTint * max(uDiceBrightness, 0.0);
          rgb = (rgb - vec3(0.5)) * uDiceContrast + vec3(0.5);
          float l = dot(rgb, LUMA);
          rgb = mix(vec3(l), rgb, uDiceSaturation);
          float invG = 1.0 / max(uDiceGamma, 1e-3);
          rgb = pow(max(rgb, vec3(0.0)), vec3(invG));

          float a = clamp(dice.a * uDiceOpacity, 0.0, 1.0);
          vec3 outRgb = mix(scene.rgb, rgb, a);
          float outA = clamp(scene.a + a * (1.0 - scene.a), 0.0, 1.0);
          gl_FragColor = vec4(outRgb, outA);
        }
      `,
      depthTest: false,
      depthWrite: false,
      transparent: false,
    });
    this._mesh = new THREE.Mesh(this._geometry, this._material);
    this._mesh.frustumCulled = false;
    this._scene.add(this._mesh);

    this._initialized = true;
  }

  /**
   * Set (or clear) the DSN CanvasTexture sampled by the fragment shader.
   * Passing null disables sampling without disposing the pass.
   * @param {any|null} texture
   */
  setTexture(texture) {
    this._texture = texture ?? null;
    if (!this._material) return;
    this._material.uniforms.tDice.value = this._texture;
  }

  /**
   * Pre-composite alpha multiplier for the dice layer. Clamped to [0, 1].
   * @param {number} value
   */
  setOpacity(value) {
    const v = Math.max(0, Math.min(1, Number(value)));
    if (!Number.isFinite(v) || !this._material) return;
    this._material.uniforms.uDiceOpacity.value = v;
  }

  /**
   * Per-channel multiplier applied to dice RGB before tone shaping.
   * @param {number} r
   * @param {number} g
   * @param {number} b
   */
  setTint(r, g, b) {
    if (!this._material) return;
    const rr = Math.max(0, Number(r));
    const gg = Math.max(0, Number(g));
    const bb = Math.max(0, Number(b));
    if (![rr, gg, bb].every(Number.isFinite)) return;
    const t = this._material.uniforms.uDiceTint.value;
    if (t && typeof t.set === 'function') t.set(rr, gg, bb);
  }

  /**
   * Scalar multiplier applied after tint and before contrast.
   * @param {number} value Non-negative.
   */
  setBrightness(value) {
    const v = Math.max(0, Number(value));
    if (!Number.isFinite(v) || !this._material) return;
    this._material.uniforms.uDiceBrightness.value = v;
  }

  /**
   * 1 = identity. 0 = grayscale; >1 = boost. Pivot is Rec. 709 luma.
   * @param {number} value
   */
  setSaturation(value) {
    const v = Math.max(0, Number(value));
    if (!Number.isFinite(v) || !this._material) return;
    this._material.uniforms.uDiceSaturation.value = v;
  }

  /**
   * 1 = identity. Pivot is mid-grey (0.5).
   * @param {number} value
   */
  setContrast(value) {
    const v = Math.max(0, Number(value));
    if (!Number.isFinite(v) || !this._material) return;
    this._material.uniforms.uDiceContrast.value = v;
  }

  /**
   * Gamma applied after contrast/saturation; the shader uses 1/gamma so values
   * above 1 brighten midtones. Clamped to keep `pow` stable.
   * @param {number} value
   */
  setGamma(value) {
    const v = Math.max(0.05, Math.min(8, Number(value)));
    if (!Number.isFinite(v) || !this._material) return;
    this._material.uniforms.uDiceGamma.value = v;
  }

  /**
   * Composite `inputRT` (scene) + DSN texture into `outputRT`.
   *
   * @param {any} renderer  THREE.WebGLRenderer
   * @param {any} inputRT
   * @param {any} outputRT
   * @returns {boolean} true if a write occurred (caller should swap inputs); false otherwise.
   */
  render(renderer, inputRT, outputRT) {
    if (!this._initialized || this._disposed) return false;
    if (!this.enabled) return false;
    if (!renderer || !inputRT || !outputRT) return false;
    if (!this._texture) return false;

    try {
      this._material.uniforms.tScene.value = inputRT.texture;
      this._material.uniforms.tDice.value = this._texture;

      const prevTarget = renderer.getRenderTarget();
      const prevAutoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setRenderTarget(outputRT);
      renderer.clear(true, true, false);
      renderer.render(this._scene, this._camera);
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAutoClear;
      return true;
    } catch (e) {
      log.warn('render failed:', e);
      return false;
    }
  }

  /** Free GL resources. Safe to call multiple times. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    try { this._material?.dispose?.(); } catch (_) {}
    try { this._copyMaterial?.dispose?.(); } catch (_) {}
    try { this._geometry?.dispose?.(); } catch (_) {}
    if (this._scene && this._mesh) {
      try { this._scene.remove(this._mesh); } catch (_) {}
    }
    this._material = null;
    this._copyMaterial = null;
    this._mesh = null;
    this._copyMesh = null;
    this._geometry = null;
    this._scene = null;
    this._camera = null;
    this._texture = null;
    this._initialized = false;
  }
}
