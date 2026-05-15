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
        varying vec2 vUv;
        void main() {
          vec4 scene = texture2D(tScene, vUv);
          // DSN canvas is rendered with a top-left origin; flip V for sampling.
          vec4 dice = texture2D(tDice, vec2(vUv.x, 1.0 - vUv.y));
          dice.rgb *= uDiceTint;
          float a = clamp(dice.a * uDiceOpacity, 0.0, 1.0);
          // Straight-alpha over compositing.
          vec3 outRgb = mix(scene.rgb, dice.rgb, a);
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
