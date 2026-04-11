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

  // ── UI schema (moved from V1 SharpenEffect) ───────────────────────────────

  static getControlSchema() {
    return {
      enabled: false,
      help: {
        title: 'Sharpen (unsharp mask)',
        summary: [
          'Adds local contrast on edges by blending a high-pass (detail) signal back into the image. Useful for soft maps or slight post-scale blur.',
          'No masks or tile data required — full-screen post-processing on the composited frame.',
          'Performance: one extra fullscreen pass with a few taps; cost is modest. Very high radius samples a wider neighborhood (still cheap vs bloom).',
          'Persistence: settings save with the scene (not World Based).',
        ].join('\n\n'),
        glossary: {
          Amount: 'How strongly detail is boosted. 0 disables the filter in the shader.',
          'Radius (px)': 'Edge detection neighborhood in screen pixels (larger = coarser detail).',
          Threshold: 'Minimum edge strength before sharpening applies; reduces grain and noise halos.',
        },
      },
      groups: [
        {
          name: 'look',
          label: 'Look',
          type: 'folder',
          expanded: true,
          parameters: ['amount', 'radiusPx', 'threshold'],
        },
      ],
      parameters: {
        enabled: { type: 'boolean', default: false, hidden: true },
        amount: {
          type: 'slider',
          label: 'Amount',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 0.5,
          tooltip: 'Strength of the sharpen blend (0 = no effect).',
        },
        radiusPx: {
          type: 'slider',
          label: 'Radius (px)',
          min: 0.0,
          max: 6.0,
          step: 0.1,
          default: 3.5,
          tooltip: 'Blur radius in pixels used for the unsharp mask.',
        },
        threshold: {
          type: 'slider',
          label: 'Threshold',
          min: 0.0,
          max: 0.25,
          step: 0.005,
          default: 0.045,
          tooltip: 'Ignore weak edges below this luma delta to limit noise sharpening.',
        },
      },
      presets: {
        Subtle: { amount: 0.25, radiusPx: 1.0, threshold: 0.02 },
        Crisp: { amount: 0.55, radiusPx: 1.2, threshold: 0.015 },
        Strong: { amount: 1.0, radiusPx: 1.5, threshold: 0.02 },
      },
    };
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
