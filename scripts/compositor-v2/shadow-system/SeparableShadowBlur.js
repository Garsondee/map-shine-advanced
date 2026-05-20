/**
 * @fileoverview Shared separable blur pass for shadow strength textures.
 */

export class SeparableShadowBlur {
  constructor() {
    this._scene = null;
    this._camera = null;
    this._quad = null;
    this._material = null;
  }

  initialize() {
    const THREE = window.THREE;
    if (!THREE || this._scene) return;
    this._scene = new THREE.Scene();
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._material = new THREE.ShaderMaterial({
      uniforms: {
        tInput: { value: null },
        uTexelSize: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
        uDirection: { value: new THREE.Vector2(1, 0) },
        uRadius: { value: 0.0 },
        uSampleAlpha: { value: 0.0 },
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
        uniform float uSampleAlpha;
        varying vec2 vUv;
        float readStrength(vec2 uv) {
          vec4 t = texture2D(tInput, uv);
          return mix(t.r, t.a, clamp(uSampleAlpha, 0.0, 1.0));
        }
        void main() {
          float r = clamp(uRadius, 0.0, 4.0);
          vec2 stepUv = uDirection * uTexelSize * r;
          float w0 = 0.227027;
          float w1 = 0.1945946;
          float w2 = 0.1216216;
          float w3 = 0.054054;
          float w4 = 0.016216;
          float s = readStrength(vUv) * w0;
          s += readStrength(vUv + stepUv * 1.0) * w1;
          s += readStrength(vUv - stepUv * 1.0) * w1;
          s += readStrength(vUv + stepUv * 2.0) * w2;
          s += readStrength(vUv - stepUv * 2.0) * w2;
          s += readStrength(vUv + stepUv * 3.0) * w3;
          s += readStrength(vUv - stepUv * 3.0) * w3;
          s += readStrength(vUv + stepUv * 4.0) * w4;
          s += readStrength(vUv - stepUv * 4.0) * w4;
          s = clamp(s, 0.0, 1.0);
          if (uSampleAlpha > 0.5) {
            gl_FragColor = vec4(0.0, 0.0, 0.0, s);
          } else {
            gl_FragColor = vec4(vec3(s), 1.0);
          }
        }
      `,
      depthWrite: false,
      depthTest: false,
    });
    this._material.toneMapped = false;
    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._material);
    this._quad.frustumCulled = false;
    this._scene.add(this._quad);
  }

  /**
   * @param {import('three').WebGLRenderer} renderer
   * @param {import('three').Texture} inputTexture
   * @param {import('three').WebGLRenderTarget} tempTarget
   * @param {import('three').WebGLRenderTarget} outputTarget
   * @param {number} [radius=0]
   * @param {{ sampleAlpha?: boolean }} [opts]
   * @returns {import('three').Texture|null}
   */
  render(renderer, inputTexture, tempTarget, outputTarget, radius = 0, opts = {}) {
    if (!renderer || !inputTexture || !tempTarget || !outputTarget) return inputTexture;
    const r = Math.max(0, Number(radius) || 0);
    if (r <= 0.0001) return inputTexture;
    this.initialize();
    if (!this._material) return inputTexture;
    const prev = renderer.getRenderTarget();
    try {
      this._material.uniforms.uSampleAlpha.value = opts.sampleAlpha ? 1.0 : 0.0;
      this._material.uniforms.uRadius.value = r;
      this._material.uniforms.uTexelSize.value.set(1 / Math.max(1, outputTarget.width), 1 / Math.max(1, outputTarget.height));
      this._material.uniforms.tInput.value = inputTexture;
      this._material.uniforms.uDirection.value.set(1, 0);
      renderer.setRenderTarget(tempTarget);
      renderer.clear();
      renderer.render(this._scene, this._camera);
      this._material.uniforms.tInput.value = tempTarget.texture;
      this._material.uniforms.uDirection.value.set(0, 1);
      renderer.setRenderTarget(outputTarget);
      renderer.clear();
      renderer.render(this._scene, this._camera);
      return outputTarget.texture;
    } finally {
      renderer.setRenderTarget(prev);
    }
  }

  dispose() {
    try { this._material?.dispose?.(); } catch (_) {}
    try { this._quad?.geometry?.dispose?.(); } catch (_) {}
    this._material = null;
    this._quad = null;
    this._scene = null;
    this._camera = null;
  }
}
