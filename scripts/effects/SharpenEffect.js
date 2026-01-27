/**
 * @fileoverview Sharpen Post-Processing Effect
 * Simple unsharp mask style sharpen for the final scene.
 * @module effects/SharpenEffect
 */

import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';

const log = createLogger('SharpenEffect');

export class SharpenEffect extends EffectBase {
  constructor() {
    super('sharpen', RenderLayers.POST_PROCESSING, 'low');

    // Run late in the post chain, but before ASCII (which is priority 200).
    this.priority = 150;
    this.alwaysRender = false;

    this.quadScene = null;
    this.quadCamera = null;
    this.mesh = null;
    this.material = null;

    this._readBuffer = null;
    this._writeBuffer = null;
    this._inputTexture = null;
    this._tempResolution = null;

    this.params = {
      enabled: false,
      amount: 0.5,
      radiusPx: 3.5,
      threshold: 0.045
    };
  }

  static getControlSchema() {
    return {
      enabled: false,
      groups: [
        {
          name: 'sharpen',
          label: 'Sharpen',
          type: 'inline',
          parameters: ['amount', 'radiusPx', 'threshold']
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: false, hidden: true },
        amount: { type: 'slider', min: 0.0, max: 2.0, step: 0.01, default: 0.5 },
        radiusPx: { type: 'slider', min: 0.0, max: 6.0, step: 0.1, default: 3.5 },
        threshold: { type: 'slider', min: 0.0, max: 0.25, step: 0.005, default: 0.045 }
      },
      presets: {
        'Off': { amount: 0.0, radiusPx: 1.0, threshold: 0.0 },
        'Subtle': { amount: 0.25, radiusPx: 1.0, threshold: 0.02 },
        'Crisp': { amount: 0.55, radiusPx: 1.2, threshold: 0.015 },
        'Strong': { amount: 1.0, radiusPx: 1.5, threshold: 0.02 }
      }
    };
  }

  initialize(renderer, scene, camera) {
    log.info('Initializing SharpenEffect');

    const THREE = window.THREE;

    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._tempResolution = new THREE.Vector2(1, 1);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uResolution: { value: this._tempResolution },
        uTexelSize: { value: new THREE.Vector2(1, 1) },
        uAmount: { value: this.params.amount },
        uRadiusPx: { value: this.params.radiusPx },
        uThreshold: { value: this.params.threshold }
      },
      vertexShader: this.getVertexShader(),
      fragmentShader: this.getFragmentShader(),
      depthWrite: false,
      depthTest: false
    });

    const geometry = new THREE.PlaneGeometry(2, 2);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.quadScene.add(this.mesh);
  }

  setInputTexture(texture) {
    this._inputTexture = texture;
    if (this.material?.uniforms?.tDiffuse) {
      this.material.uniforms.tDiffuse.value = texture;
    }
  }

  setBuffers(readBuffer, writeBuffer) {
    this._readBuffer = readBuffer;
    this._writeBuffer = writeBuffer;
  }

  update(timeInfo) {
    if (!this.material) return;

    const u = this.material.uniforms;
    const p = this.params;

    u.uAmount.value = p.amount;
    u.uRadiusPx.value = p.radiusPx;
    u.uThreshold.value = p.threshold;
  }

  render(renderer, scene, camera) {
    if (!this.material) return;

    const inputTexture =
      this.material.uniforms?.tDiffuse?.value ||
      this._readBuffer?.texture ||
      this._inputTexture;

    // IMPORTANT: Always draw something to avoid breaking the post chain.
    if (inputTexture) {
      this.material.uniforms.tDiffuse.value = inputTexture;
    }

    const THREE = window.THREE;

    if (this._tempResolution) {
      renderer.getDrawingBufferSize(this._tempResolution);
      const w = Math.max(1, this._tempResolution.x);
      const h = Math.max(1, this._tempResolution.y);

      if (this.material.uniforms.uResolution) {
        this.material.uniforms.uResolution.value.set(w, h);
      }
      if (this.material.uniforms.uTexelSize) {
        this.material.uniforms.uTexelSize.value.set(1 / w, 1 / h);
      }
    }

    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.quadScene, this.quadCamera);
    renderer.autoClear = prevAutoClear;
  }

  onResize(width, height) {
    if (!this.material) return;

    if (this.material.uniforms.uResolution) {
      this.material.uniforms.uResolution.value.set(width, height);
    }
    if (this.material.uniforms.uTexelSize) {
      this.material.uniforms.uTexelSize.value.set(1 / Math.max(1, width), 1 / Math.max(1, height));
    }
  }

  getVertexShader() {
    return `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position, 1.0);
      }
    `;
  }

  getFragmentShader() {
    return `
      uniform sampler2D tDiffuse;
      uniform vec2 uResolution;
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
    `;
  }
}
