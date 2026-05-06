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
 * In {@link FloorCompositor} per-level order it runs **after** WaterEffectV2 when
 * water renders in the slice, so foam/spec/tint are graded without a second pass.
 * Together: SkyColor (atmospheric) → … water … → ColorCorrection (user look).
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

  // ── UI schema (moved from V1 ColorCorrectionEffect) ──────────────────────

  static getControlSchema() {
    return {
      enabled: true,
      help: {
        title: 'Color correction & grade',
        summary: [
          'Author-facing grade after the scene composite (and after time-of-day sky grading): exposure, white balance, basic adjustments, lift/gamma/gain, optional tone mapping, vignette, and film grain.',
          '**Dynamic exposure:** when token Dynamic Exposure is enabled, its multiplier is applied on top of the Exposure slider (`DynamicExposureManager` writes `params.dynamicExposure` each frame — not a Tweakpane control).',
          '**Persistence:** this effect supports **World Based** in the GM panel (shared across scenes) or per-scene storage when World Based is off.',
          'Fullscreen post; cost is modest (single pass).',
          '**Note:** Vignette **softness** is written to a uniform but the current fragment shader uses a fixed falloff — the slider is reserved for a future shader hook.',
        ].join('\n\n'),
        glossary: {
          Exposure: 'Linear intensity before white balance (also multiplied by dynamic exposure when active).',
          Temperature: 'Warm vs cool white balance.',
          Tint: 'Green–magenta balance.',
          Contrast: 'Scales color around mid gray.',
          Saturation: 'Overall chroma.',
          Vibrance: 'Boosts low-saturation colors more than already-saturated ones.',
          Lift: 'Shadows lift (added before gain/gamma).',
          Gamma: 'Per-channel gamma pivot (shader uses as pow curve).',
          Gain: 'Per-channel multiply after lift.',
          'Master gamma': 'Global gamma after LGG.',
          'Tone mapping': 'HDR-style curve (ACES or Reinhard) after the grade.',
          Vignette: 'Edge darkening strength.',
          Grain: 'Animated film noise amplitude.',
        },
      },
      presetApplyDefaults: true,
      groups: [
        {
          name: 'exposure',
          label: 'Exposure & white balance',
          type: 'folder',
          expanded: true,
          parameters: ['exposure', 'temperature', 'tint'],
        },
        {
          name: 'basics',
          label: 'Basic adjustments',
          type: 'folder',
          expanded: true,
          parameters: ['contrast', 'brightness', 'saturation', 'vibrance'],
        },
        {
          name: 'grading',
          label: 'Color grading',
          type: 'folder',
          expanded: false,
          parameters: ['toneMapping', 'liftColor', 'gammaColor', 'gainColor', 'masterGamma'],
        },
        {
          name: 'artistic',
          label: 'Vignette & grain',
          type: 'folder',
          expanded: false,
          parameters: ['vignetteStrength', 'vignetteSoftness', 'grainStrength'],
        },
      ],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true },
        exposure: {
          type: 'slider',
          label: 'Exposure',
          min: 0,
          max: 5,
          step: 0.01,
          default: 0.9,
          tooltip: 'Scene brightness multiplier (also stacks with dynamic exposure when enabled).',
        },
        temperature: {
          type: 'slider',
          label: 'Temperature',
          min: -1,
          max: 1,
          step: 0.01,
          default: 0.0,
          tooltip: 'Warm (positive) vs cool (negative) white balance.',
        },
        tint: {
          type: 'slider',
          label: 'Tint',
          min: -1,
          max: 1,
          step: 0.01,
          default: 0.0,
          tooltip: 'Green vs magenta cast.',
        },
        brightness: {
          type: 'slider',
          label: 'Brightness',
          min: -0.5,
          max: 0.5,
          step: 0.01,
          default: 0.0,
          tooltip: 'Adds a constant offset after exposure and white balance.',
        },
        contrast: {
          type: 'slider',
          label: 'Contrast',
          min: 0,
          max: 2,
          step: 0.01,
          default: 1.0,
          tooltip: 'Scales distance from 0.5 luma (1 = unchanged).',
        },
        saturation: {
          type: 'slider',
          label: 'Saturation',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.9,
          tooltip: '0 = grayscale, 1 ≈ natural, above 1 boosts color.',
        },
        vibrance: {
          type: 'slider',
          label: 'Vibrance',
          min: -1,
          max: 1,
          step: 0.01,
          default: -0.15,
          tooltip: 'Selective saturation boost (affects muted colors more).',
        },
        liftColor: {
          type: 'color',
          colorType: 'float',
          label: 'Lift',
          default: { r: 0, g: 0, b: 0 },
          tooltip: 'Shadow tint added before gain (scaled in shader).',
        },
        gammaColor: {
          type: 'color',
          colorType: 'float',
          label: 'Gamma',
          default: { r: 0.5, g: 0.5, b: 0.5 },
          tooltip: 'Per-channel gamma pivot values (drive pow curve; keep above zero).',
        },
        gainColor: {
          type: 'color',
          colorType: 'float',
          label: 'Gain',
          default: { r: 1, g: 1, b: 1 },
          tooltip: 'Per-channel multiply after lift.',
        },
        masterGamma: {
          type: 'slider',
          label: 'Master gamma',
          min: 0.1,
          max: 3,
          step: 0.01,
          default: 2.0,
          tooltip: 'Overall gamma after lift/gamma/gain (1 = neutral).',
        },
        toneMapping: {
          type: 'list',
          label: 'Tone mapping',
          options: { 'None': 0, 'ACES Filmic': 1, 'Reinhard': 2 },
          default: 0,
          tooltip: 'HDR-style curve applied after grading (None leaves linear in-shader).',
        },
        vignetteStrength: {
          type: 'slider',
          label: 'Vignette strength',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.0,
          tooltip: 'How much edges darken (0 = off).',
        },
        vignetteSoftness: {
          type: 'slider',
          label: 'Vignette softness',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.0,
          tooltip: 'Reserved: uniform is updated but shader falloff is fixed today.',
        },
        grainStrength: {
          type: 'slider',
          label: 'Grain strength',
          min: 0,
          max: 0.5,
          step: 0.01,
          default: 0.0,
          tooltip: 'Animated film grain amplitude (0 = off).',
        },
      },
      presets: {
        Cinematic: {
          toneMapping: 1,
          contrast: 1.1,
          saturation: 1.1,
          vignetteStrength: 0.4,
          temperature: 0.1,
        },
        Noir: {
          toneMapping: 1,
          saturation: 0.0,
          contrast: 1.4,
          grainStrength: 0.15,
          vignetteStrength: 0.6,
        },
        'Warm & Cozy': {
          toneMapping: 1,
          temperature: 0.3,
          tint: 0.1,
          saturation: 1.1,
          gammaColor: { r: 1.0, g: 0.95, b: 0.9 },
        },
        'Cold Horror': {
          toneMapping: 2,
          temperature: -0.4,
          saturation: 0.6,
          contrast: 1.2,
          grainStrength: 0.1,
          gainColor: { r: 0.9, g: 0.95, b: 1.0 },
        },
      },
    };
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

          // Preserve input alpha so V14 per-level slices (authored map/background
          // transparency) survive into LevelCompositePass; forcing 1.0 made upper
          // floors fully opaque and hid lower-slice water through deck holes.
          gl_FragColor = vec4(color, texel.a);
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
