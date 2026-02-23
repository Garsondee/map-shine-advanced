/**
 * @fileoverview ColorCorrectionEffectV2 — V2 screen-space color correction post-processing pass.
 *
 * Applies a static (user-authored) color grade to the scene:
 *   - Exposure (with dynamic exposure multiplier from DynamicExposureManager)
 *   - White balance (temperature + tint)
 *   - Brightness, contrast, saturation, vibrance
 *   - Lift/Gamma/Gain color grading
 *   - Optional tone mapping (ACES Filmic, Reinhard)
 *   - Vignette + film grain
 *
 * Runs AFTER SkyColorEffectV2 (which provides time-of-day atmospheric grading).
 * Together they form the complete color pipeline:
 *   SkyColor (automated, atmospheric) → ColorCorrection (static, user look)
 *
 * Ported from V1 ColorCorrectionEffect with identical shader logic and defaults.
 *
 * @module compositor-v2/effects/ColorCorrectionEffectV2
 */

import { createLogger } from '../../core/log.js';

const log = createLogger('ColorCorrectionEffectV2');

export class ColorCorrectionEffectV2 {
  constructor() {
    /** @type {boolean} */
    this._initialized = false;

    // Defaults tuned to match Foundry PIXI brightness.
    // Tone mapping is OFF by default to avoid darkening the scene.
    this.params = {
      enabled: true,

      // 1. Input
      exposure: 0.9,

      // Dynamic Exposure (eye adaptation). Driven by DynamicExposureManager, not user-authored.
      dynamicExposure: 1.0,

      // 2. White Balance
      temperature: 0.0,
      tint: 0.0,

      // 3. Basic Adjustments
      brightness: 0.0,
      contrast: 1.0,
      saturation: 0.9,
      vibrance: -0.15,

      // 4. Color Grading (Lift/Gamma/Gain)
      liftColor: { r: 0, g: 0, b: 0 },
      gammaColor: { r: 0.5, g: 0.5, b: 0.5 },
      gainColor: { r: 1, g: 1, b: 1 },
      masterGamma: 2.0,

      // 5. Tone Mapping
      toneMapping: 0,

      // 6. Artistic
      vignetteStrength: 0.0,
      vignetteSoftness: 0.0,
      grainStrength: 0.0,
    };

    // ── GPU resources ───────────────────────────────────────────────────
    /** @type {THREE.Scene|null} */
    this._composeScene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._composeCamera = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._composeMaterial = null;
    /** @type {THREE.Mesh|null} */
    this._composeQuad = null;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  initialize() {
    const THREE = window.THREE;
    if (!THREE) return;

    this._composeScene = new THREE.Scene();
    this._composeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._composeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse:         { value: null },
        uTime:            { value: 0.0 },
        uResolution:      { value: new THREE.Vector2(1, 1) },

        uExposure:        { value: 1.0 },
        uDynamicExposure: { value: 1.0 },
        uTemperature:     { value: 0.0 },
        uTint:            { value: 0.0 },
        uBrightness:      { value: 0.0 },
        uContrast:        { value: 1.0 },
        uSaturation:      { value: 1.0 },
        uVibrance:        { value: 0.0 },

        uLift:            { value: new THREE.Vector3(0, 0, 0) },
        uGamma:           { value: new THREE.Vector3(1, 1, 1) },
        uGain:            { value: new THREE.Vector3(1, 1, 1) },
        uMasterGamma:     { value: 1.0 },
        uToneMapping:     { value: 0 },

        uVignetteStrength: { value: 0.0 },
        uVignetteSoftness: { value: 0.5 },
        uGrainStrength:    { value: 0.0 },
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
        uniform vec2 uResolution;
        uniform float uTime;

        uniform float uExposure;
        uniform float uDynamicExposure;
        uniform float uTemperature;
        uniform float uTint;
        uniform float uBrightness;
        uniform float uContrast;
        uniform float uSaturation;
        uniform float uVibrance;

        uniform vec3 uLift;
        uniform vec3 uGamma;
        uniform vec3 uGain;
        uniform float uMasterGamma;
        uniform int uToneMapping;

        uniform float uVignetteStrength;
        uniform float uVignetteSoftness;
        uniform float uGrainStrength;

        varying vec2 vUv;

        vec3 ACESFilmicToneMapping(vec3 x) {
          float a = 2.51;
          float b = 0.03;
          float c = 2.43;
          float d = 0.59;
          float e = 0.14;
          return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
        }

        vec3 ReinhardToneMapping(vec3 x) {
          return x / (x + vec3(1.0));
        }

        vec3 applyWhiteBalance(vec3 color, float temp, float tintVal) {
          vec3 tempShift = vec3(1.0 + temp, 1.0, 1.0 - temp);
          if (temp < 0.0) tempShift = vec3(1.0, 1.0, 1.0 - temp * 0.5);
          else tempShift = vec3(1.0 + temp * 0.5, 1.0, 1.0);
          vec3 tintShift = vec3(1.0, 1.0 + tintVal, 1.0);
          return color * tempShift * tintShift;
        }

        float random(vec2 p) {
          return fract(sin(dot(p.xy, vec2(12.9898, 78.233))) * 43758.5453);
        }

        void main() {
          vec4 texel = texture2D(tDiffuse, vUv);
          vec3 color = texel.rgb;

          // 1. Exposure (with dynamic eye adaptation multiplier)
          color *= (uExposure * max(uDynamicExposure, 0.0));

          // 2. White Balance
          color = applyWhiteBalance(color, uTemperature, uTint);

          // 3. Basic Adjustments
          color += uBrightness;
          color = (color - 0.5) * uContrast + 0.5;

          float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
          vec3 gray = vec3(luma);
          float sat = max(color.r, max(color.g, color.b)) - min(color.r, min(color.g, color.b));
          vec3 satColor = mix(gray, color, uSaturation);
          if (uVibrance != 0.0) {
            satColor = mix(satColor, mix(gray, satColor, 1.0 + uVibrance), (1.0 - sat));
          }
          color = satColor;

          // 4. Lift/Gamma/Gain
          color = color + (uLift * 0.1);
          color = color * uGain;
          color = max(color, vec3(0.0));
          color = pow(color, 1.0 / uGamma);
          if (uMasterGamma != 1.0) {
            color = pow(color, vec3(1.0 / max(uMasterGamma, 0.0001)));
          }

          // 5. Tone Mapping
          if (uToneMapping == 1) {
            color = ACESFilmicToneMapping(color);
          } else if (uToneMapping == 2) {
            color = ReinhardToneMapping(color);
          }

          // 6. Vignette
          vec2 dist = (vUv - 0.5) * 2.0;
          float len = length(dist);
          if (uVignetteStrength > 0.0) {
            color *= mix(1.0, smoothstep(1.5, 0.5, len), uVignetteStrength);
          }

          // 7. Film Grain
          if (uGrainStrength > 0.0) {
            float noise = random(vUv + uTime);
            color += (noise - 0.5) * uGrainStrength;
          }

          gl_FragColor = vec4(color, 1.0);
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
    log.info('ColorCorrectionEffectV2 initialized');
  }

  // ── Per-frame update ──────────────────────────────────────────────────

  /**
   * Push current params to shader uniforms.
   * @param {{ elapsed: number, delta: number }} timeInfo
   */
  update(timeInfo) {
    if (!this._initialized || !this._composeMaterial) return;
    if (!this.params.enabled) return;

    const u = this._composeMaterial.uniforms;
    const p = this.params;

    u.uTime.value = timeInfo.elapsed;

    u.uExposure.value = p.exposure;
    u.uDynamicExposure.value = p.dynamicExposure ?? 1.0;
    u.uTemperature.value = p.temperature;
    u.uTint.value = p.tint;
    u.uBrightness.value = p.brightness;
    u.uContrast.value = p.contrast;
    u.uSaturation.value = p.saturation;
    u.uVibrance.value = p.vibrance;
    u.uMasterGamma.value = p.masterGamma ?? 1.0;

    if (p.liftColor) u.uLift.value.set(p.liftColor.r, p.liftColor.g, p.liftColor.b);
    if (p.gammaColor) u.uGamma.value.set(
      Math.max(0.0001, p.gammaColor.r),
      Math.max(0.0001, p.gammaColor.g),
      Math.max(0.0001, p.gammaColor.b)
    );
    if (p.gainColor) u.uGain.value.set(p.gainColor.r, p.gainColor.g, p.gainColor.b);

    u.uToneMapping.value = p.toneMapping;
    u.uVignetteStrength.value = p.vignetteStrength ?? 0.0;
    u.uVignetteSoftness.value = p.vignetteSoftness ?? 0.0;
    u.uGrainStrength.value = p.grainStrength ?? 0.0;
  }

  // ── Render ────────────────────────────────────────────────────────────

  /**
   * Execute the color correction post-processing pass.
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} inputRT
   * @param {THREE.WebGLRenderTarget} outputRT
   */
  render(renderer, inputRT, outputRT) {
    if (!this._initialized || !this._composeMaterial || !inputRT) return;
    if (!this.params.enabled) return;

    this._composeMaterial.uniforms.tDiffuse.value = inputRT.texture;
    this._composeMaterial.uniforms.uResolution.value.set(
      inputRT.width, inputRT.height
    );

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    renderer.setRenderTarget(outputRT);
    renderer.autoClear = true;
    renderer.render(this._composeScene, this._composeCamera);

    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  dispose() {
    try { this._composeMaterial?.dispose(); } catch (_) {}
    try { this._composeQuad?.geometry?.dispose(); } catch (_) {}
    this._composeScene = null;
    this._composeCamera = null;
    this._composeMaterial = null;
    this._composeQuad = null;
    this._initialized = false;
    log.info('ColorCorrectionEffectV2 disposed');
  }
}
