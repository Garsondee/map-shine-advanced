/**
 * @fileoverview LevelCompositePass — alpha-based level compositing for V2 compositor.
 *
 * Composites per-level final RTs bottom→top using Porter–Duff "source over"
 * for straight-alpha textures (same as premultiply → add → unpremultiply).
 *
 * @module compositor-v2/LevelCompositePass
 */

import { createLogger } from '../core/log.js';

const log = createLogger('LevelCompositePass');

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const COMPOSITE_FRAGMENT = /* glsl */ `
  uniform sampler2D tBase;
  uniform sampler2D tUpper;
  varying vec2 vUv;
  void main() {
    vec4 base  = texture2D(tBase,  vUv);
    vec4 upper = texture2D(tUpper, vUv);
    // Source-over (straight alpha): avoids leaking base.rgb when upper.a is 0
    // (e.g. transparent bus clears) — mix(base.rgb, upper.rgb, upper.a) is wrong.
    float outA = upper.a + base.a * (1.0 - upper.a);
    vec3 premul = upper.rgb * upper.a + base.rgb * base.a * (1.0 - upper.a);
    float invA = 1.0 / max(outA, 1.0e-4);
    // Clamp unpremultiplied RGB: half-float slice inputs can spike when upstream
    // passes mis-sample; without clamp, composite output flickers and reads like
    // broken stylistic filters (ASCII / noise) even when those effects are off.
    vec3 rgb = clamp(premul * invA, vec3(0.0), vec3(65504.0));
    gl_FragColor = vec4(rgb, outA);
  }
`;

const BLIT_FRAGMENT = /* glsl */ `
  uniform sampler2D tBase;
  varying vec2 vUv;
  void main() {
    gl_FragColor = texture2D(tBase, vUv);
  }
`;

export class LevelCompositePass {
  constructor() {
    /** @type {THREE.Scene|null} */
    this._scene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._camera = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._compositeMaterial = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._blitMaterial = null;
    /** @type {THREE.Mesh|null} */
    this._quad = null;
    this._initialized = false;
  }

  initialize() {
    const THREE = window.THREE;
    if (!THREE) return;

    this._scene = new THREE.Scene();
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tBase:  { value: null },
        tUpper: { value: null },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: COMPOSITE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: THREE.NoBlending,
    });
    this._compositeMaterial.toneMapped = false;

    this._blitMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tBase: { value: null },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: BLIT_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: THREE.NoBlending,
    });
    this._blitMaterial.toneMapped = false;

    this._quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this._compositeMaterial,
    );
    this._quad.frustumCulled = false;
    this._scene.add(this._quad);

    this._initialized = true;
    log.debug('LevelCompositePass initialized');
  }

  /**
   * Composite level final RTs bottom→top into outputRT.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {Array<THREE.WebGLRenderTarget>} levelFinalRTs - ordered bottom→top
   * @param {THREE.WebGLRenderTarget} outputRT - destination for final composite
   * @param {THREE.WebGLRenderTarget} scratchRT - temp RT for intermediate compositing
   */
  composite(renderer, levelFinalRTs, outputRT, scratchRT) {
    if (!this._initialized || !renderer || !levelFinalRTs?.length) return;

    if (levelFinalRTs.length === 1) {
      this._blit(renderer, levelFinalRTs[0], outputRT);
      return;
    }

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    try {
      // Two levels: composite directly to outputRT
      if (levelFinalRTs.length === 2) {
        this._compositeTwo(renderer, levelFinalRTs[0], levelFinalRTs[1], outputRT);
        return;
      }

      // 3+ levels: iterative ping-pong compositing
      // First pair → scratchRT, then accumulate into outputRT/scratchRT alternately
      let currentBase = levelFinalRTs[0];
      let writeTarget = scratchRT;

      for (let i = 1; i < levelFinalRTs.length; i++) {
        const isLast = (i === levelFinalRTs.length - 1);
        writeTarget = isLast ? outputRT : scratchRT;

        this._compositeTwo(renderer, currentBase, levelFinalRTs[i], writeTarget);
        currentBase = writeTarget;
      }
    } finally {
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} baseRT
   * @param {THREE.WebGLRenderTarget} upperRT
   * @param {THREE.WebGLRenderTarget} target
   * @private
   */
  _compositeTwo(renderer, baseRT, upperRT, target) {
    const mat = this._compositeMaterial;
    this._quad.material = mat;
    mat.uniforms.tBase.value = baseRT.texture;
    mat.uniforms.tUpper.value = upperRT.texture;
    renderer.setRenderTarget(target);
    renderer.autoClear = true;
    renderer.render(this._scene, this._camera);
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} sourceRT
   * @param {THREE.WebGLRenderTarget} target
   * @private
   */
  _blit(renderer, sourceRT, target) {
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    this._quad.material = this._blitMaterial;
    this._blitMaterial.uniforms.tBase.value = sourceRT.texture;
    renderer.setRenderTarget(target);
    renderer.autoClear = true;
    renderer.render(this._scene, this._camera);

    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
  }

  dispose() {
    try { this._compositeMaterial?.dispose(); } catch (_) {}
    try { this._blitMaterial?.dispose(); } catch (_) {}
    try { this._quad?.geometry?.dispose(); } catch (_) {}
    this._scene = null;
    this._camera = null;
    this._compositeMaterial = null;
    this._blitMaterial = null;
    this._quad = null;
    this._initialized = false;
    log.debug('LevelCompositePass disposed');
  }
}
