import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';

const log = createLogger('DazzleOverlayEffect');

export class DazzleOverlayEffect extends EffectBase {
  constructor() {
    super('dazzle-overlay', RenderLayers.POST_PROCESSING, 'low');

    // Must run last. This effect is a full-screen overlay/grade on top of the final scene.
    this.priority = 1000;

    // Disabled by default; DynamicExposureManager enables it only while intensity > 0.
    this.enabled = false;

    this.quadScene = null;
    this.quadCamera = null;
    this.mesh = null;
    this.material = null;

    this._inputTexture = null;

    this._tempResolution = null;

    this.params = {
      intensity: 0.0,

      // Overall exposure-like lift. 0 disables.
      exposureLift: 0.9,

      // Additive white washout (simulates retinal flare).
      whiteAdd: 0.65,

      // Desaturate toward grayscale as intensity rises.
      desaturate: 0.35,

      // Radial glare / bloom-ish center weighting.
      glareStrength: 0.55,
      glarePower: 2.0,

      // Chromatic separation in pixels.
      rgbShiftPx: 1.35
    };
  }

  initialize(renderer, scene, camera) {
    const THREE = window.THREE;
    if (!THREE) {
      log.error('THREE not available');
      return;
    }

    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._tempResolution = new THREE.Vector2(1, 1);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uResolution: { value: this._tempResolution },

        uIntensity: { value: this.params.intensity },
        uExposureLift: { value: this.params.exposureLift },
        uWhiteAdd: { value: this.params.whiteAdd },
        uDesaturate: { value: this.params.desaturate },
        uGlareStrength: { value: this.params.glareStrength },
        uGlarePower: { value: this.params.glarePower },
        uRgbShiftPx: { value: this.params.rgbShiftPx }
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform vec2 uResolution;

        uniform float uIntensity;
        uniform float uExposureLift;
        uniform float uWhiteAdd;
        uniform float uDesaturate;
        uniform float uGlareStrength;
        uniform float uGlarePower;
        uniform float uRgbShiftPx;

        varying vec2 vUv;

        float ms_luma(vec3 c) {
          return dot(c, vec3(0.2126, 0.7152, 0.0722));
        }

        vec2 aspectCorrect(vec2 p, vec2 res) {
          float a = (res.x / max(1.0, res.y));
          return vec2(p.x * a, p.y);
        }

        void main() {
          vec4 base = texture2D(tDiffuse, vUv);
          float k = clamp(uIntensity, 0.0, 1.0);

          if (k < 0.0005) {
            gl_FragColor = base;
            return;
          }

          vec2 texel = 1.0 / max(uResolution, vec2(1.0));

          // Radial direction (aspect corrected) for chroma + glare shaping.
          vec2 p = aspectCorrect(vUv - 0.5, uResolution);
          float r = length(p) * 2.0;
          vec2 dir = (r > 1e-6) ? (p / length(p)) : vec2(0.0, 0.0);

          // Chromatic shift in pixel units -> UV.
          float px = clamp(uRgbShiftPx, 0.0, 12.0);
          vec2 shiftUv = dir * (px * texel) * k;

          vec2 uvR = clamp(vUv + shiftUv, vec2(0.001), vec2(0.999));
          vec2 uvB = clamp(vUv - shiftUv, vec2(0.001), vec2(0.999));

          vec3 col = base.rgb;
          col.r = texture2D(tDiffuse, uvR).r;
          col.b = texture2D(tDiffuse, uvB).b;

          // Exposure lift (multiplicative). Keep stable and bounded.
          float lift = 1.0 + clamp(uExposureLift, 0.0, 4.0) * k;
          col *= lift;

          // White washout (additive), stronger near the center.
          float glare = pow(clamp(1.0 - r, 0.0, 1.0), max(0.01, uGlarePower));
          float g = clamp(uGlareStrength, 0.0, 4.0) * glare;

          float whiteAmt = clamp(uWhiteAdd, 0.0, 4.0) * (k * k) * (0.55 + 0.45 * g);
          col = mix(col, vec3(1.0), clamp(whiteAmt, 0.0, 1.0));

          // Slight desaturation to mimic blown highlights.
          float ds = clamp(uDesaturate, 0.0, 1.0) * k;
          float l = ms_luma(col);
          col = mix(col, vec3(l), ds);

          gl_FragColor = vec4(col, base.a);
        }
      `,
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

  update(timeInfo) {
    if (!this.material) return;

    const u = this.material.uniforms;
    const p = this.params;

    u.uIntensity.value = Number.isFinite(p.intensity) ? p.intensity : 0.0;
    u.uExposureLift.value = Number.isFinite(p.exposureLift) ? p.exposureLift : 0.9;
    u.uWhiteAdd.value = Number.isFinite(p.whiteAdd) ? p.whiteAdd : 0.65;
    u.uDesaturate.value = Number.isFinite(p.desaturate) ? p.desaturate : 0.35;
    u.uGlareStrength.value = Number.isFinite(p.glareStrength) ? p.glareStrength : 0.55;
    u.uGlarePower.value = Number.isFinite(p.glarePower) ? p.glarePower : 2.0;
    u.uRgbShiftPx.value = Number.isFinite(p.rgbShiftPx) ? p.rgbShiftPx : 1.35;
  }

  render(renderer, scene, camera) {
    if (!this.material) return;

    const inputTexture =
      this.material.uniforms?.tDiffuse?.value ||
      this._inputTexture;

    if (inputTexture) {
      this.material.uniforms.tDiffuse.value = inputTexture;
    }

    if (this._tempResolution) {
      renderer.getDrawingBufferSize(this._tempResolution);
      const w = Math.max(1, this._tempResolution.x);
      const h = Math.max(1, this._tempResolution.y);
      if (this.material.uniforms.uResolution) {
        this.material.uniforms.uResolution.value.set(w, h);
      }
    }

    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.quadScene, this.quadCamera);
    renderer.autoClear = prevAutoClear;
  }
}
