import { createLogger } from '../../core/log.js';

const log = createLogger('DazzleOverlayEffectV2');

/**
 * DazzleOverlayEffectV2 - Bright light exposure overlay
 * 
 * Archetype: C (Post-Processing Effect)
 * Full-screen overlay that simulates retinal flare from bright light exposure.
 * Disabled by default - DynamicExposureManager enables it when intensity > 0.
 */
export class DazzleOverlayEffectV2 {
  constructor() {
    this._enabled = false;
    this._initialized = false;

    this._quadScene = null;
    this._quadCamera = null;
    this._mesh = null;
    this._material = null;

    this._tempResolution = null;

    this.params = {
      enabled: false,
      intensity: 0.0,
      exposureLift: 0.9,
      whiteAdd: 0.65,
      desaturate: 0.35,
      glareStrength: 0.55,
      glarePower: 2.0,
      rgbShiftPx: 1.35
    };
  }

  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
    if (this.params) this.params.enabled = this._enabled;
  }

  /**
   * Tweakpane schema (DynamicExposureManager still drives intensity at runtime).
   */
  static getControlSchema() {
    return {
      enabled: false,
      groups: [
        {
          name: 'dazzle',
          label: 'Look',
          type: 'inline',
          parameters: [
            'intensity',
            'exposureLift',
            'whiteAdd',
            'desaturate',
            'glareStrength',
            'glarePower',
            'rgbShiftPx',
          ],
        },
      ],
      parameters: {
        enabled: { type: 'boolean', default: false, hidden: true },
        intensity: { type: 'slider', label: 'Intensity', min: 0, max: 2, step: 0.01, default: 0 },
        exposureLift: { type: 'slider', label: 'Exposure Lift', min: 0, max: 3, step: 0.01, default: 0.9 },
        whiteAdd: { type: 'slider', label: 'White Add', min: 0, max: 2, step: 0.01, default: 0.65 },
        desaturate: { type: 'slider', label: 'Desaturate', min: 0, max: 1, step: 0.01, default: 0.35 },
        glareStrength: { type: 'slider', label: 'Glare Strength', min: 0, max: 2, step: 0.01, default: 0.55 },
        glarePower: { type: 'slider', label: 'Glare Power', min: 0.1, max: 8, step: 0.05, default: 2 },
        rgbShiftPx: { type: 'slider', label: 'RGB Shift (px)', min: 0, max: 8, step: 0.05, default: 1.35 },
      },
    };
  }

  initialize() {
    const THREE = window.THREE;
    if (!THREE) {
      log.error('THREE not available');
      return;
    }

    this._quadScene = new THREE.Scene();
    this._quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._tempResolution = new THREE.Vector2(1, 1);

    this._material = new THREE.ShaderMaterial({
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
      depthTest: false,
      toneMapped: false
    });

    const geometry = new THREE.PlaneGeometry(2, 2);
    this._mesh = new THREE.Mesh(geometry, this._material);
    this._quadScene.add(this._mesh);

    this._initialized = true;
  }

  update(timeInfo) {
    if (!this._initialized || !this._material) return;

    const u = this._material.uniforms;
    const p = this.params;

    u.uIntensity.value = Number.isFinite(p.intensity) ? p.intensity : 0.0;
    u.uExposureLift.value = Number.isFinite(p.exposureLift) ? p.exposureLift : 0.9;
    u.uWhiteAdd.value = Number.isFinite(p.whiteAdd) ? p.whiteAdd : 0.65;
    u.uDesaturate.value = Number.isFinite(p.desaturate) ? p.desaturate : 0.35;
    u.uGlareStrength.value = Number.isFinite(p.glareStrength) ? p.glareStrength : 0.55;
    u.uGlarePower.value = Number.isFinite(p.glarePower) ? p.glarePower : 2.0;
    u.uRgbShiftPx.value = Number.isFinite(p.rgbShiftPx) ? p.rgbShiftPx : 1.35;
  }

  render(renderer, camera, inputRT, outputRT) {
    if (!this._enabled || !this._initialized || !this._material) return false;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    this._material.uniforms.tDiffuse.value = inputRT.texture;

    if (this._tempResolution) {
      renderer.getDrawingBufferSize(this._tempResolution);
      const w = Math.max(1, this._tempResolution.x);
      const h = Math.max(1, this._tempResolution.y);
      if (this._material.uniforms.uResolution) {
        this._material.uniforms.uResolution.value.set(w, h);
      }
    }

    renderer.setRenderTarget(outputRT);
    renderer.autoClear = false;
    renderer.render(this._quadScene, this._quadCamera);

    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);

    return true;
  }

  onResize(width, height) {
    // No internal RTs to resize
  }

  dispose() {
    if (this._material) {
      this._material.dispose();
      this._material = null;
    }
    if (this._mesh) {
      if (this._mesh.geometry) this._mesh.geometry.dispose();
      this._mesh = null;
    }
    this._quadScene = null;
    this._quadCamera = null;
    this._tempResolution = null;
    this._initialized = false;
  }
}
