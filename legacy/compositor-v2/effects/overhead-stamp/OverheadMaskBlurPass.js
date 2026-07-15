/**
 * @fileoverview Separable blur for overhead stamp mask textures (alpha / RGBA).
 */

import { SeparableShadowBlur } from '../../shadow-system/SeparableShadowBlur.js';

export class OverheadMaskBlurPass {
  constructor() {
    this._blur = new SeparableShadowBlur();
    this._rgbaBlurScene = null;
    this._rgbaBlurCamera = null;
    this._rgbaBlurQuad = null;
    this._rgbaBlurMaterial = null;
    this._tempA = null;
    this._tempB = null;
  }

  /**
   * @param {number} width
   * @param {number} height
   */
  ensureTargets(width, height) {
    const THREE = window.THREE;
    if (!THREE || !width || !height) return;
    const opts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    };
    if (!this._tempA) this._tempA = new THREE.WebGLRenderTarget(width, height, opts);
    else this._tempA.setSize(width, height);
    if (!this._tempB) this._tempB = new THREE.WebGLRenderTarget(width, height, opts);
    else this._tempB.setSize(width, height);
  }

  /**
   * Blur red/alpha channel of input into output (strength masks).
   * @param {import('three').WebGLRenderer} renderer
   * @param {import('three').Texture} inputTexture
   * @param {import('three').WebGLRenderTarget} outputTarget
   * @param {number} radius
   * @returns {import('three').Texture|null}
   */
  blurAlpha(renderer, inputTexture, outputTarget, radius = 0) {
    if (!renderer || !inputTexture || !outputTarget || !this._tempA) return inputTexture;
    const r = Math.max(0, Number(radius) || 0);
    if (r <= 0.0001) return inputTexture;
    return this._blur.render(renderer, inputTexture, this._tempA, outputTarget, r, { sampleAlpha: true });
  }

  /**
   * Full RGBA separable blur (fluid tint path).
   * @param {import('three').WebGLRenderer} renderer
   * @param {import('three').Texture} inputTexture
   * @param {import('three').WebGLRenderTarget} outputTarget
   * @param {number} radius
   * @returns {import('three').Texture|null}
   */
  blurRGBA(renderer, inputTexture, outputTarget, radius = 0) {
    const THREE = window.THREE;
    if (!THREE || !renderer || !inputTexture || !outputTarget || !this._tempA || !this._tempB) {
      return inputTexture;
    }
    const r = Math.max(0, Number(radius) || 0);
    if (r <= 0.0001) return inputTexture;
    this._initRgbaBlur();
    const w = outputTarget.width;
    const h = outputTarget.height;
    const prev = renderer.getRenderTarget();
    try {
      this._rgbaBlurMaterial.uniforms.uRadius.value = r;
      this._rgbaBlurMaterial.uniforms.uTexelSize.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
      this._rgbaBlurMaterial.uniforms.tInput.value = inputTexture;
      this._rgbaBlurMaterial.uniforms.uDirection.value.set(1, 0);
      renderer.setRenderTarget(this._tempA);
      renderer.clear();
      renderer.render(this._rgbaBlurScene, this._rgbaBlurCamera);
      this._rgbaBlurMaterial.uniforms.tInput.value = this._tempA.texture;
      this._rgbaBlurMaterial.uniforms.uDirection.value.set(0, 1);
      renderer.setRenderTarget(outputTarget);
      renderer.clear();
      renderer.render(this._rgbaBlurScene, this._rgbaBlurCamera);
      return outputTarget.texture;
    } finally {
      renderer.setRenderTarget(prev);
    }
  }

  _initRgbaBlur() {
    const THREE = window.THREE;
    if (!THREE || this._rgbaBlurScene) return;
    this._rgbaBlurScene = new THREE.Scene();
    this._rgbaBlurCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._rgbaBlurMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tInput: { value: null },
        uTexelSize: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
        uDirection: { value: new THREE.Vector2(1, 0) },
        uRadius: { value: 0.0 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tInput;
        uniform vec2 uTexelSize;
        uniform vec2 uDirection;
        uniform float uRadius;
        varying vec2 vUv;
        void main() {
          float r = clamp(uRadius, 0.0, 4.0);
          vec2 stepUv = uDirection * uTexelSize * r;
          float w0 = 0.227027;
          float w1 = 0.1945946;
          float w2 = 0.1216216;
          float w3 = 0.054054;
          float w4 = 0.016216;
          vec4 s = texture2D(tInput, vUv) * w0;
          s += texture2D(tInput, vUv + stepUv * 1.0) * w1;
          s += texture2D(tInput, vUv - stepUv * 1.0) * w1;
          s += texture2D(tInput, vUv + stepUv * 2.0) * w2;
          s += texture2D(tInput, vUv - stepUv * 2.0) * w2;
          s += texture2D(tInput, vUv + stepUv * 3.0) * w3;
          s += texture2D(tInput, vUv - stepUv * 3.0) * w3;
          s += texture2D(tInput, vUv + stepUv * 4.0) * w4;
          s += texture2D(tInput, vUv - stepUv * 4.0) * w4;
          gl_FragColor = clamp(s, 0.0, 1.0);
        }
      `,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NoBlending,
    });
    this._rgbaBlurMaterial.toneMapped = false;
    this._rgbaBlurQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._rgbaBlurMaterial);
    this._rgbaBlurQuad.frustumCulled = false;
    this._rgbaBlurScene.add(this._rgbaBlurQuad);
  }

  dispose() {
    this._blur.dispose();
    try { this._tempA?.dispose?.(); } catch (_) { /* dispose */ }
    try { this._tempB?.dispose?.(); } catch (_) { /* dispose */ }
    try { this._rgbaBlurMaterial?.dispose?.(); } catch (_) { /* dispose */ }
    try { this._rgbaBlurQuad?.geometry?.dispose?.(); } catch (_) { /* dispose */ }
    this._tempA = null;
    this._tempB = null;
    this._rgbaBlurMaterial = null;
    this._rgbaBlurQuad = null;
    this._rgbaBlurScene = null;
    this._rgbaBlurCamera = null;
  }
}
