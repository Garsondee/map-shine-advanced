/**
 * @fileoverview SharpenEffectV2 — V2 screen-space unsharp mask post-processing pass.
 *
 * Applies a simple sharpening filter to the final image.
 * Disabled by default — optional artistic effect.
 *
 * @module compositor-v2/effects/SharpenEffectV2
 */

import { createLogger } from '../../core/log.js';

const log = createLogger('SharpenEffectV2');

export class SharpenEffectV2 {
  constructor() {
    this._initialized = false;

    this.params = {
      enabled: false,
      amount: 0.5,
      radiusPx: 3.5,
      threshold: 0.045,
    };

    /** @type {THREE.Scene|null} */
    this._composeScene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._composeCamera = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._composeMaterial = null;
    /** @type {THREE.Mesh|null} */
    this._composeQuad = null;
  }

  initialize() {
    const THREE = window.THREE;
    if (!THREE) return;

    this._composeScene = new THREE.Scene();
    this._composeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._composeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse:    { value: null },
        uTexelSize:  { value: new THREE.Vector2(1, 1) },
        uAmount:     { value: 0.5 },
        uRadiusPx:   { value: 3.5 },
        uThreshold:  { value: 0.045 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform vec2 uTexelSize;
        uniform float uAmount;
        uniform float uRadiusPx;
        uniform float uThreshold;
        varying vec2 vUv;

        float luma(vec3 c) {
          return dot(c, vec3(0.2126, 0.7152, 0.0722));
        }

        void main() {
          vec4 base = texture2D(tDiffuse, vUv);
          vec3 c = base.rgb;

          // Radius is specified in pixels and converted to UV via texel size.
          vec2 off = uTexelSize * max(uRadiusPx, 0.0);

          vec3 l = texture2D(tDiffuse, vUv + vec2(-off.x, 0.0)).rgb;
          vec3 r = texture2D(tDiffuse, vUv + vec2(off.x, 0.0)).rgb;
          vec3 d = texture2D(tDiffuse, vUv + vec2(0.0, -off.y)).rgb;
          vec3 u = texture2D(tDiffuse, vUv + vec2(0.0, off.y)).rgb;

          vec3 blur = (c + l + r + d + u) / 5.0;
          vec3 high = c - blur;

          // Threshold to avoid sharpening noise.
          float hi = abs(luma(high));
          float m = step(uThreshold, hi);

          vec3 outColor = c + high * uAmount * m;
          outColor = max(outColor, vec3(0.0));

          gl_FragColor = vec4(outColor, base.a);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    this._composeMaterial.toneMapped = false;

    this._composeQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this._composeMaterial
    );
    this._composeQuad.frustumCulled = false;
    this._composeScene.add(this._composeQuad);

    this._initialized = true;
    log.info('SharpenEffectV2 initialized');
  }

  update(_timeInfo) {
    if (!this._initialized || !this._composeMaterial) return;
    if (!this.params.enabled) return;

    const u = this._composeMaterial.uniforms;
    u.uAmount.value = this.params.amount;
    u.uRadiusPx.value = this.params.radiusPx;
    u.uThreshold.value = this.params.threshold;
  }

  render(renderer, inputRT, outputRT) {
    if (!this._initialized || !this._composeMaterial || !inputRT) return;
    if (!this.params.enabled) return;

    const u = this._composeMaterial.uniforms;
    u.tDiffuse.value = inputRT.texture;
    u.uTexelSize.value.set(1 / Math.max(1, inputRT.width), 1 / Math.max(1, inputRT.height));

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.setRenderTarget(outputRT);
    renderer.autoClear = true;
    renderer.render(this._composeScene, this._composeCamera);
    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
  }

  dispose() {
    try { this._composeMaterial?.dispose(); } catch (_) {}
    try { this._composeQuad?.geometry?.dispose(); } catch (_) {}
    this._composeScene = null;
    this._composeCamera = null;
    this._composeMaterial = null;
    this._composeQuad = null;
    this._initialized = false;
    log.info('SharpenEffectV2 disposed');
  }
}
