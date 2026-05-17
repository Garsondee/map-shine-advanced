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
          float s = texture2D(tInput, vUv).r * w0;
          s += texture2D(tInput, vUv + stepUv * 1.0).r * w1;
          s += texture2D(tInput, vUv - stepUv * 1.0).r * w1;
          s += texture2D(tInput, vUv + stepUv * 2.0).r * w2;
          s += texture2D(tInput, vUv - stepUv * 2.0).r * w2;
          s += texture2D(tInput, vUv + stepUv * 3.0).r * w3;
          s += texture2D(tInput, vUv - stepUv * 3.0).r * w3;
          s += texture2D(tInput, vUv + stepUv * 4.0).r * w4;
          s += texture2D(tInput, vUv - stepUv * 4.0).r * w4;
          gl_FragColor = vec4(vec3(clamp(s, 0.0, 1.0)), 1.0);
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

  render(renderer, inputTexture, tempTarget, outputTarget, radius = 0) {
    if (!renderer || !inputTexture || !tempTarget || !outputTarget) return inputTexture;
    this.initialize();
    if (!this._material) return inputTexture;
    const prev = renderer.getRenderTarget();
    try {
      this._material.uniforms.uRadius.value = Math.max(0, Number(radius) || 0);
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
