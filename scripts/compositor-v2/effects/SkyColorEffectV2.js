/**
 * @fileoverview SkyColorEffectV2 — V2 screen-space color grading post-processing pass.
 *
 * HEALTH-WIRING BADGE (Map Shine Breaker Box):
 * If you change init/render, `_composeMaterial`, or consumers (water / dust / window
 * light sky buffers), you MUST update HealthEvaluator contracts for `SkyColorEffectV2`
 * and dependency edges to prevent silent failures.
 *
 * Applies time-of-day atmospheric color grading to the lit scene:
 *   - Exposure, white balance (temperature + tint)
 *   - Brightness, contrast, saturation, vibrance
 *   - Lift/Gamma/Gain color grading
 *   - Optional tone mapping (ACES Filmic, Reinhard)
 *   - Vignette + film grain
 *
 * Automation mode:
 *   - **Analytic**: Sunrise/sunset-aware sun model + weather integration
 *     (turbidity, Rayleigh, Mie, overcast desaturation, etc.)
 *
 * Exposes `currentSkyTintColor` for downstream systems (e.g., Darkness Response
 * lights adopt the sky hue during golden hour / blue hour).
 *
 * Simplifications vs V1:
 *   - No rope mask or token mask
 *   - No cloud top mask
 *   - Outdoors gating is currently limited to the final grade blend
 *     (full V1-style multi-mask layering remains out of scope for now)
 *
 * @module compositor-v2/effects/SkyColorEffectV2
 */

import { createLogger } from '../../core/log.js';
import { weatherController } from '../../core/WeatherController.js';
import { getFoundryTimePhaseHours } from '../../core/foundry-time-phases.js';

const log = createLogger('SkyColorEffectV2');

// ── Utility helpers (ported from V1) ────────────────────────────────────────

const clamp01 = (n) => Math.max(0, Math.min(1, n));

const wrapHour24 = (h) => {
  const hour = Number.isFinite(h) ? h : 0;
  return ((hour % 24) + 24) % 24;
};

const smooth01 = (x) => x * x * (3 - 2 * x);

const wrapDistHours = (a, b) => {
  const d = Math.abs(a - b);
  return Math.min(d, 24 - d);
};

const peakHour = (hour, center, widthHours) => {
  const d = wrapDistHours(hour, center);
  const t = clamp01(1 - d / Math.max(0.0001, widthHours));
  return smooth01(t);
};

const lerp = (a, b, t) => a + (b - a) * t;

const readSceneDarkness01 = () => {
  try {
    const sceneLevel = canvas?.scene?.environment?.darknessLevel;
    if (Number.isFinite(sceneLevel)) return clamp01(sceneLevel);
  } catch (_) {}
  try {
    const envLevel = canvas?.environment?.darknessLevel;
    if (Number.isFinite(envLevel)) return clamp01(envLevel);
  } catch (_) {}
  return 0.0;
};

// ── SkyColorEffectV2 ────────────────────────────────────────────────────────

export class SkyColorEffectV2 {
  constructor() {
    /** @type {boolean} */
    this._initialized = false;

    // ── Tuning parameters (match V1 defaults) ──────────────────────────
    this.params = {
      enabled: true,
      intensity: 0.8,
      saturationBoost: 0.35,
      vibranceBoost: 0.0,

      sunriseHour: 6.0,
      sunsetHour: 18.0,
      goldenHourWidth: 6.0,
      goldenStrength: 2.9,
      goldenPower: 2.01,
      nightFloor: 0.5,

      analyticStrength: 0.85,
      turbidity: 0.22,
      rayleighStrength: 0.63,
      mieStrength: 0.35,
      forwardScatter: 0.3,

      weatherInfluence: 0.67,
      cloudToTurbidity: 0.25,
      precipToTurbidity: 0.72,
      overcastDesaturate: 0.3,
      overcastContrastReduce: 0.38,

      tempWarmAtHorizon: 0.85,
      tempCoolAtNoon: -0.45,
      nightCoolBoost: -0.25,
      goldenSaturationBoost: 0.18,
      nightSaturationFloor: 0.33,
      hazeLift: 0.08,
      hazeContrastLoss: 0.0,

      autoIntensityEnabled: true,
      autoIntensityStrength: 1.0,
      goldenOutdoorRecolorStrength: 2.2,
      goldenOutdoorRecolorColor: { r: 1.35, g: 0.80, b: 0.50 },

      skyTintDarknessLightsEnabled: true,
      skyTintDarknessLightsIntensity: 1.01,

      dayVignetteStrength: 0.0, dayVignetteSoftness: 0.5, dayGrainStrength: 0.0,
      nightVignetteStrength: 0.25, nightVignetteSoftness: 1.00, nightGrainStrength: 0.0,

      debugOverride: true,
      exposure: 0.51,
      saturation: 0.21,
      contrast: 0.98,
    };

    /**
     * Exposed sky tint color for downstream systems (e.g., Darkness Response lights).
     * Updated each frame in update(). RGB multiplier representing the current sky hue.
     */
    this.currentSkyTintColor = { r: 1.0, g: 1.0, b: 1.0 };

    /**
     * Current sun azimuth in degrees (0=North, 90=East, 180=South, 270=West).
     * Derived from time-of-day: sun rises in the East (~90°) and sets in the West (~270°).
     * Updated each frame. Downstream systems (water specular) should read this.
     */
    this.currentSunAzimuthDeg = 180.0;

    /**
     * Current sun elevation in degrees above the horizon (0=horizon, 90=zenith).
     * Derived from time-of-day: peaks at solar noon, 0 at sunrise/sunset.
     * Updated each frame.
     */
    this.currentSunElevationDeg = 45.0;

    // ── GPU resources (created in initialize) ───────────────────────────
    /** @type {THREE.Scene|null} */
    this._composeScene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._composeCamera = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._composeMaterial = null;
    /** @type {THREE.Mesh|null} */
    this._composeQuad = null;

    // Cached dayFactor for auto-intensity computation
    this._lastDayFactor = 0.5;

    /** @type {THREE.DataTexture|null} */
    this._fallbackWhite = null;
  }

  // ── UI schema (moved from V1 SkyColorEffect) ─────────────────────────────

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        { name: 'sky-color', label: 'Sky Color', type: 'inline', parameters: ['intensity', 'saturationBoost', 'vibranceBoost', 'skyTintDarknessLightsEnabled', 'skyTintDarknessLightsIntensity'] },
        { name: 'sky-automation', label: 'Sky Automation', type: 'folder', expanded: false, parameters: ['sunriseHour', 'sunsetHour', 'goldenHourWidth', 'goldenStrength', 'goldenPower', 'goldenOutdoorRecolorStrength', 'goldenOutdoorRecolorColor', 'nightFloor', 'analyticStrength', 'turbidity', 'rayleighStrength', 'mieStrength', 'forwardScatter', 'weatherInfluence', 'cloudToTurbidity', 'precipToTurbidity', 'overcastDesaturate', 'overcastContrastReduce', 'tempWarmAtHorizon', 'tempCoolAtNoon', 'nightCoolBoost', 'goldenSaturationBoost', 'nightSaturationFloor', 'hazeLift', 'hazeContrastLoss', 'autoIntensityEnabled', 'autoIntensityStrength'] },
        { name: 'automation', label: 'Automation vs Manual', type: 'inline', separator: true, parameters: ['debugOverride', 'exposure', 'saturation', 'contrast'] }
      ],
      parameters: {
        enabled: { type: 'boolean', default: true },
        intensity: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.8, label: 'Intensity', throttle: 50 },
        saturationBoost: { type: 'slider', min: -0.5, max: 0.5, step: 0.01, default: 0.35, label: 'Sat Boost', throttle: 50 },
        vibranceBoost: { type: 'slider', min: -0.5, max: 0.5, step: 0.01, default: 0.0, label: 'Vibrance', throttle: 50 },
        sunriseHour: { type: 'slider', min: 0, max: 24, step: 0.05, default: 6.0, label: 'Sunrise', throttle: 50 },
        sunsetHour: { type: 'slider', min: 0, max: 24, step: 0.05, default: 18.0, label: 'Sunset', throttle: 50 },
        goldenHourWidth: { type: 'slider', min: 0.25, max: 6.0, step: 0.05, default: 6.0, label: 'Golden Width', throttle: 50 },
        goldenStrength: { type: 'slider', min: 0.0, max: 4.0, step: 0.01, default: 2.9, label: 'Golden Strength', throttle: 50 },
        goldenPower: { type: 'slider', min: 0.5, max: 3.0, step: 0.01, default: 2.01, label: 'Golden Power', throttle: 50 },
        goldenOutdoorRecolorStrength: { type: 'slider', min: 0.0, max: 6.0, step: 0.05, default: 3.25, label: 'Golden Recolor', throttle: 50 },
        goldenOutdoorRecolorColor: { type: 'color', default: { r: 1.35, g: 0.80, b: 0.50 }, label: 'Golden Recolor Color' },
        nightFloor: { type: 'slider', min: 0.0, max: 0.5, step: 0.01, default: 0.5, label: 'Night Floor', throttle: 50 },
        analyticStrength: { type: 'slider', min: 0.0, max: 4.0, step: 0.01, default: 0.85, label: 'Analytic Strength', throttle: 50 },
        turbidity: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.22, label: 'Turbidity', throttle: 50 },
        rayleighStrength: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.63, label: 'Rayleigh', throttle: 50 },
        mieStrength: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.35, label: 'Mie', throttle: 50 },
        forwardScatter: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.3, label: 'Forward Scatter', throttle: 50 },
        weatherInfluence: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.67, label: 'Weather Influence', throttle: 50 },
        cloudToTurbidity: { type: 'slider', min: 0.0, max: 2.0, step: 0.01, default: 0.25, label: 'Cloud→Turbidity', throttle: 50 },
        precipToTurbidity: { type: 'slider', min: 0.0, max: 2.0, step: 0.01, default: 0.72, label: 'Precip→Turbidity', throttle: 50 },
        overcastDesaturate: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.3, label: 'Overcast Desat', throttle: 50 },
        overcastContrastReduce: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.38, label: 'Overcast Contrast', throttle: 50 },
        tempWarmAtHorizon: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.85, label: 'Warm Horizon', throttle: 50 },
        tempCoolAtNoon: { type: 'slider', min: -1.0, max: 0.0, step: 0.01, default: -0.45, label: 'Cool Noon', throttle: 50 },
        nightCoolBoost: { type: 'slider', min: -1.0, max: 0.0, step: 0.01, default: -0.25, label: 'Night Cool', throttle: 50 },
        goldenSaturationBoost: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.18, label: 'Golden Sat', throttle: 50 },
        nightSaturationFloor: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.33, label: 'Night Sat Floor', throttle: 50 },
        hazeLift: { type: 'slider', min: 0.0, max: 0.5, step: 0.01, default: 0.08, label: 'Haze Lift', throttle: 50 },
        hazeContrastLoss: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.0, label: 'Haze Contrast', throttle: 50 },
        autoIntensityEnabled: { type: 'boolean', default: true, label: 'Auto Intensity' },
        autoIntensityStrength: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 1.0, label: 'Auto Strength', throttle: 50 },
        skyTintDarknessLightsEnabled: { type: 'boolean', default: true, label: 'Tint Sun Lights' },
        skyTintDarknessLightsIntensity: { type: 'slider', min: 0.0, max: 5.0, step: 0.01, default: 1.01, label: 'Sun Light Tint Intensity', throttle: 50 },
        debugOverride: { type: 'boolean', default: true, label: 'Manual Override' },
        exposure: { type: 'slider', min: -1, max: 1, step: 0.01, default: 0.51, label: 'Exposure (Manual)', throttle: 50 },
        saturation: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.21, label: 'Saturation (Manual)', throttle: 50 },
        contrast: { type: 'slider', min: 0.5, max: 1.5, step: 0.01, default: 0.98, label: 'Contrast (Manual)', throttle: 50 }
      }
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  initialize() {
    const THREE = window.THREE;
    if (!THREE) return;

    this._ensureFallbackWhite();

    this._composeScene = new THREE.Scene();
    this._composeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._composeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse:    { value: null },
        tOutdoorsMask: { value: this._fallbackWhite },
        tOverheadRoofAlpha: { value: this._fallbackWhite },
        uTime:       { value: 0.0 },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uHasOutdoorsMask: { value: 0.0 },
        uHasOverheadRoofAlpha: { value: 0.0 },
        uOutdoorsMaskFlipY: { value: 0.0 },
        uActiveFloorIndex: { value: 0.0 },
        uViewBoundsMin: { value: new THREE.Vector2(0, 0) },
        uViewBoundsMax: { value: new THREE.Vector2(1, 1) },
        uSceneBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
        uSceneDimensions: { value: new THREE.Vector2(1, 1) },

        // Grading params (blended per time-of-day)
        uExposure:    { value: 0.0 },
        uTemperature: { value: 0.0 },
        uTint:        { value: 0.0 },
        uBrightness:  { value: 0.0 },
        uContrast:    { value: 1.0 },
        uSaturation:  { value: 1.0 },
        uVibrance:    { value: 0.0 },

        uLift:        { value: new THREE.Vector3(0, 0, 0) },
        uGamma:       { value: new THREE.Vector3(1, 1, 1) },
        uGain:        { value: new THREE.Vector3(1, 1, 1) },
        uMasterGamma: { value: 1.0 },
        uToneMapping: { value: 0 },

        uVignetteStrength: { value: 0.0 },
        uVignetteSoftness: { value: 0.5 },
        uGrainStrength:    { value: 0.0 },
        uGoldenRecolorStrength: { value: 0.0 },
        uGoldenRecolorColor: { value: new THREE.Vector3(1.35, 0.80, 0.50) },

        uIntensity: { value: 1.0 },
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
        uniform sampler2D tOutdoorsMask;
        uniform sampler2D tOverheadRoofAlpha;
        uniform vec2 uResolution;
        uniform float uTime;
        uniform float uHasOutdoorsMask;
        uniform float uHasOverheadRoofAlpha;
        uniform float uOutdoorsMaskFlipY;
        uniform float uActiveFloorIndex;
        uniform vec2 uViewBoundsMin;
        uniform vec2 uViewBoundsMax;
        uniform vec4 uSceneBounds;
        uniform vec2 uSceneDimensions;

        uniform float uExposure;
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
        uniform float uGoldenRecolorStrength;
        uniform vec3 uGoldenRecolorColor;
        uniform float uIntensity;

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

        float sampleOutdoorsMask(vec2 screenUv) {
          if (uHasOutdoorsMask < 0.5) return 1.0;
          vec2 worldXY = mix(uViewBoundsMin, uViewBoundsMax, screenUv);
          vec2 sceneUv = vec2(
            (worldXY.x - uSceneBounds.x) / max(1e-5, uSceneBounds.z),
            1.0 - ((worldXY.y - uSceneBounds.y) / max(1e-5, uSceneBounds.w))
          );
          if (uOutdoorsMaskFlipY > 0.5) sceneUv.y = 1.0 - sceneUv.y;
          sceneUv = clamp(sceneUv, vec2(0.0), vec2(1.0));
          // Why this is correct:
          // Per-floor _Outdoors masks are not guaranteed to have valid RGB everywhere.
          // On upper floors, "unwritten" regions are commonly RGBA=(0,0,0,0):
          //   - RGB black does NOT mean "indoors"
          //   - alpha=0 means "no authored data at this pixel"
          //
          // If we read only m.r, those no-data pixels are misclassified as indoors,
          // producing the exact artifact we saw: a bloated, blocky indoor silhouette
          // that expands around upper-floor geometry when SkyColor gating is enabled.
          //
          // Treat alpha as validity and RGB as value:
          //   alpha=0 -> default outdoors (1.0)
          //   alpha=1 -> trust m.r
          // This matches OverheadShadowsEffectV2 behavior and keeps sparse floor masks
          // from contaminating sky gating.
          vec4 m = texture2D(tOutdoorsMask, sceneUv);
          float outdoors = mix(1.0, m.r, m.a);
          return step(0.5, clamp(outdoors, 0.0, 1.0));
        }

        float sampleOverheadRoofAlpha(vec2 screenUv) {
          if (uHasOverheadRoofAlpha < 0.5) return 0.0;
          vec4 roof = texture2D(tOverheadRoofAlpha, screenUv);
          return clamp(max(roof.a, max(roof.r, max(roof.g, roof.b))), 0.0, 1.0);
        }

        void main() {
          vec4 sceneColor = texture2D(tDiffuse, vUv);
          vec3 base = sceneColor.rgb;

          // Fast early-out: nothing to blend.
          if (uIntensity <= 0.0) {
            gl_FragColor = sceneColor;
            return;
          }

          vec3 color = base;
          float roofAlpha = sampleOverheadRoofAlpha(vUv);
          // Hard roof gate: any meaningful roof coverage suppresses sky grade.
          float roofOcclusion = step(0.05, roofAlpha);
          float roofOutdoorVis = 1.0 - roofOcclusion;

          float outdoorVis = clamp(sampleOutdoorsMask(vUv), 0.0, 1.0);
          // Levels-aware mask policy:
          // - Ground floor: world-space _Outdoors + roof gate (normal behavior).
          // - Upper floors: still apply _Outdoors (for indoor/outdoor correctness),
          //   but pair it with screen-space roof visibility to stabilize edge behavior
          //   in the same sampling space as this fullscreen pass.
          float skyEligible = (uActiveFloorIndex > 0.5)
            ? min(outdoorVis, roofOutdoorVis)
            : (outdoorVis * roofOutdoorVis);

          // 1) Exposure (stops)
          color *= exp2(uExposure);

          // 2) White balance
          color = applyWhiteBalance(color, uTemperature, uTint);

          // 3) Basic adjustments
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

          // 4) Lift/Gamma/Gain
          color = color + (uLift * 0.1);
          color = color * uGain;
          color = max(color, vec3(0.0));
          color = pow(color, 1.0 / uGamma);
          if (uMasterGamma != 1.0) {
            color = pow(color, vec3(1.0 / max(uMasterGamma, 0.0001)));
          }

          // 5) Tone mapping (optional)
          if (uToneMapping == 1) {
            color = ACESFilmicToneMapping(color);
          } else if (uToneMapping == 2) {
            color = ReinhardToneMapping(color);
          }

          // 6) VFX — vignette
          vec2 dist = (vUv - 0.5) * 2.0;
          float len = length(dist);
          if (uVignetteStrength > 0.0) {
            float soft = clamp(uVignetteSoftness, 0.0, 1.0);
            float inner = mix(0.85, 0.35, soft);
            float outer = mix(1.25, 0.85, soft);
            float vig = 1.0 - smoothstep(inner, outer, len);
            color *= mix(1.0, vig, uVignetteStrength);
          }

          // Film grain
          if (uGrainStrength > 0.0) {
            float noise = random(vUv + uTime);
            color += (noise - 0.5) * uGrainStrength;
          }

          // Dramatic golden-hour recolor for outdoors.
          if (uGoldenRecolorStrength > 0.0001) {
            float recolorAmt = clamp(uGoldenRecolorStrength * skyEligible, 0.0, 1.0);
            vec3 warmShift = color * uGoldenRecolorColor;
            color = mix(color, warmShift, recolorAmt);
          }

          // Blend grade only where outdoor visibility says the sky should apply.
          // This keeps interiors neutral when a valid _Outdoors mask is present.
          float mask = clamp(uIntensity * skyEligible, 0.0, 1.0);
          vec3 finalColor = mix(base, color, mask);

          gl_FragColor = vec4(finalColor, sceneColor.a);
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
    log.info('SkyColorEffectV2 initialized');
  }

  /** @private */
  _ensureFallbackWhite() {
    const THREE = window.THREE;
    if (!THREE || this._fallbackWhite) return;
    const data = new Uint8Array([255, 255, 255, 255]);
    this._fallbackWhite = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    this._fallbackWhite.needsUpdate = true;
    this._fallbackWhite.flipY = false;
    this._fallbackWhite.generateMipmaps = false;
    this._fallbackWhite.minFilter = THREE.NearestFilter;
    this._fallbackWhite.magFilter = THREE.NearestFilter;
  }

  /**
   * Feed the active-floor outdoors mask into sky grading.
   * Outdoors pixels receive sky grading; indoors remain ungraded.
   * @param {THREE.Texture|null} outdoorsTex
   */
  setOutdoorsMask(outdoorsTex) {
    const u = this._composeMaterial?.uniforms;
    if (!u) return;
    u.tOutdoorsMask.value = outdoorsTex ?? this._fallbackWhite;
    u.uHasOutdoorsMask.value = outdoorsTex ? 1.0 : 0.0;
    u.uOutdoorsMaskFlipY.value = outdoorsTex?.flipY ? 1.0 : 0.0;
  }

  /**
   * Feed screen-space overhead roof visibility alpha for occluding outdoors-only
   * grading on overhead-covered pixels.
   * @param {THREE.Texture|null} roofAlphaTex
   */
  setOverheadRoofAlphaTexture(roofAlphaTex) {
    const u = this._composeMaterial?.uniforms;
    if (!u) return;
    u.tOverheadRoofAlpha.value = roofAlphaTex ?? this._fallbackWhite;
    u.uHasOverheadRoofAlpha.value = roofAlphaTex ? 1.0 : 0.0;
  }

  // ── Per-frame update ──────────────────────────────────────────────────

  /**
   * Compute time-of-day grading parameters and push them to shader uniforms.
   * All the CPU-side automation logic is ported directly from V1 SkyColorEffect.
   * @param {{ elapsed: number, delta: number }} timeInfo
   */
  update(timeInfo) {
    if (!this._initialized || !this._composeMaterial) return;
    if (!this.params.enabled) return;

    try {
      const hourRaw = weatherController?.timeOfDay ?? 12.0;
      const hour = wrapHour24(hourRaw);

      let exposure = 0.0;
      let temperature = 0.0;
      let tint = 0.0;
      let brightness = 0.0;
      let contrast = 1.0;
      let saturation = 1.0;
      let vibrance = 0.0;
      let liftR = 0.0, liftG = 0.0, liftB = 0.0;
      let gammaR = 1.0, gammaG = 1.0, gammaB = 1.0;
      let gainR = 1.0, gainG = 1.0, gainB = 1.0;
      let masterGamma = 1.0;
      let toneMapping = 0;
      let vignetteStrength = 0.0;
      let vignetteSoftness = 0.5;
      let grainStrength = 0.0;
      let goldenEnergy = 0.0;
      let nightSatFloor = clamp01(this.params.nightSaturationFloor);
      let dayProgress = -1.0;
      let effectiveDarkness = 0.0;

      {
        // ── Analytic automation ──────────────────────────────────────
        const isFoundryLinked = window.MapShine?.controlPanel?.controlState?.linkTimeToFoundry === true;
        const foundryPhases = isFoundryLinked ? getFoundryTimePhaseHours() : null;
        const sunrise = wrapHour24(Number.isFinite(foundryPhases?.sunrise) ? foundryPhases.sunrise : this.params.sunriseHour);
        const sunset = wrapHour24(Number.isFinite(foundryPhases?.sunset) ? foundryPhases.sunset : this.params.sunsetHour);

        // Day progress: 0→1 from sunrise to sunset, -1 at night
        dayProgress = 0.0;
        if (sunrise < sunset) {
          if (hour >= sunrise && hour <= sunset) {
            dayProgress = (hour - sunrise) / Math.max(0.0001, sunset - sunrise);
          } else {
            dayProgress = -1.0;
          }
        } else {
          const span = (24 - sunrise) + sunset;
          if (hour >= sunrise) {
            dayProgress = (hour - sunrise) / Math.max(0.0001, span);
          } else if (hour <= sunset) {
            dayProgress = (24 - sunrise + hour) / Math.max(0.0001, span);
          } else {
            dayProgress = -1.0;
          }
        }

        const sunFactorRaw = dayProgress >= 0.0 ? Math.sin(Math.PI * clamp01(dayProgress)) : 0.0;
        const dayFactorBase = Math.max(clamp01(this.params.nightFloor), clamp01(sunFactorRaw));

        const goldenWidth = Math.max(0.0001, this.params.goldenHourWidth);
        const goldenBase = clamp01(peakHour(hour, sunrise, goldenWidth) + peakHour(hour, sunset, goldenWidth));
        const goldenPow = Math.pow(goldenBase, Math.max(0.0001, this.params.goldenPower ?? 1.0));
        const golden = clamp01(goldenPow * Math.max(0.0, this.params.goldenStrength ?? 1.0));
        goldenEnergy = Math.max(0.0, Math.min(3.0, goldenPow * Math.max(0.0, this.params.goldenStrength ?? 1.0)));

        // Extend dayFactor into golden hour transition zones
        const dayFactor = Math.max(dayFactorBase, golden * 0.45);

        // Weather state
        const state = weatherController?.getCurrentState ? weatherController.getCurrentState() : null;
        const cloudCover = clamp01(state?.cloudCover ?? 0.0);
        const precipitation = clamp01(state?.precipitation ?? 0.0);
        let overcast = clamp01(cloudCover * 0.8 + precipitation * 0.6);
        let storm = precipitation;

        const env = weatherController?.getEnvironment ? weatherController.getEnvironment() : null;
        if (env) {
          if (Number.isFinite(env.overcastFactor)) overcast = clamp01(env.overcastFactor);
          if (Number.isFinite(env.stormFactor)) storm = clamp01(env.stormFactor);
        }

        let sceneDarkness = readSceneDarkness01();
        if (env && Number.isFinite(env.sceneDarkness)) sceneDarkness = clamp01(env.sceneDarkness);

        const weatherInfluence = clamp01(this.params.weatherInfluence);
        const turbidityBase = clamp01(this.params.turbidity);
        const turbidityWeather = weatherInfluence * (
          (this.params.cloudToTurbidity ?? 0.0) * cloudCover +
          (this.params.precipToTurbidity ?? 0.0) * precipitation
        );
        const turbidityEff = clamp01(turbidityBase + turbidityWeather);

        effectiveDarkness = clamp01(
          sceneDarkness +
          (1.0 - dayFactor) * 0.25 +
          overcast * 0.15 +
          storm * 0.1
        );

        const rayleigh = clamp01(this.params.rayleighStrength);
        const mie = clamp01(this.params.mieStrength);
        const forward = clamp01(this.params.forwardScatter);

        temperature =
          (this.params.tempWarmAtHorizon ?? 0.0) * golden * (0.5 + 0.5 * mie) +
          (this.params.tempCoolAtNoon ?? 0.0) * dayFactor * rayleigh +
          (this.params.nightCoolBoost ?? 0.0) * effectiveDarkness;

        const overcastDesat = clamp01(this.params.overcastDesaturate);
        const overcastContrast = clamp01(this.params.overcastContrastReduce);
        const hazeLoss = clamp01(this.params.hazeContrastLoss);

        saturation = 1.0;
        saturation += (this.params.goldenSaturationBoost ?? 0.0) * golden;
        saturation *= 1.0 - overcastDesat * overcast * weatherInfluence;
        saturation *= 1.0 - (turbidityEff * mie) * 0.35;
        nightSatFloor = clamp01(this.params.nightSaturationFloor);
        // NOTE: apply the night saturation floor *after* analyticStrength scaling.
        // Otherwise, scaling can drive saturation below zero at night, clamp it,
        // and wash the whole frame toward gray.

        contrast = 1.0;
        // Overcast haze should flatten contrast mostly during daytime.
        // At night, applying full overcast contrast loss produces a broad gray wash.
        const overcastContrastNightWeight = 0.2;
        const overcastContrastWeight = lerp(overcastContrastNightWeight, 1.0, dayFactor);
        contrast *= 1.0 - overcastContrast * overcast * weatherInfluence * overcastContrastWeight;
        contrast *= 1.0 - turbidityEff * mie * hazeLoss;
        contrast *= 1.0 - effectiveDarkness * 0.2;
        contrast = Math.max(0.5, Math.min(1.5, contrast));

        const hazeLiftVal = clamp01(this.params.hazeLift);
        brightness = turbidityEff * mie * hazeLiftVal;

        exposure = 0.25 * dayFactor - 0.35 * effectiveDarkness - 0.10 * turbidityEff;
        exposure += forward * golden * 0.05;
        exposure = Math.max(-1.0, Math.min(1.0, exposure));

        vibrance = (golden * 0.25 - overcast * 0.2) * (1.0 - effectiveDarkness);

        const analyticStrength = Math.max(0.0, this.params.analyticStrength ?? 1.0);
        temperature = Math.max(-1.0, Math.min(1.0, temperature * analyticStrength));
        exposure = Math.max(-1.0, Math.min(1.0, exposure * analyticStrength));
        brightness = Math.max(-0.5, Math.min(0.5, brightness * analyticStrength));
        saturation = Math.max(0.0, Math.min(2.0, 1.0 + (saturation - 1.0) * analyticStrength));
        contrast = Math.max(0.5, Math.min(1.5, 1.0 + (contrast - 1.0) * analyticStrength));
        vibrance = Math.max(-1.0, Math.min(1.0, vibrance * analyticStrength));

        // Now enforce the night saturation floor with darkness weighting.
        // Keeps nights from becoming unintentionally grayscale under strong analyticStrength.
        const satFloor = nightSatFloor;
        saturation = Math.max(satFloor, lerp(saturation, satFloor, effectiveDarkness * 0.75));

        this._lastDayFactor = dayFactor;

        // Update sun position for downstream systems (water specular, etc.).
        // Azimuth: sun rises East (90°) travels through South (180°) and sets West (270°).
        // dayProgress 0→1 maps sunrise→sunset: 0→East, 0.5→South, 1→West.
        if (dayProgress >= 0.0) {
          this.currentSunAzimuthDeg = 90.0 + dayProgress * 180.0;
          // Elevation: sin curve peaks at noon (dayProgress=0.5).
          this.currentSunElevationDeg = Math.max(2.0, Math.sin(Math.PI * clamp01(dayProgress)) * 85.0);
        } else {
          // Night: sun is below horizon; use a low angle from the opposite side.
          this.currentSunAzimuthDeg = 270.0;
          this.currentSunElevationDeg = 2.0;
        }

        const tNight = clamp01(effectiveDarkness);
        vignetteStrength = lerp(this.params.dayVignetteStrength ?? 0.0, this.params.nightVignetteStrength ?? 0.0, tNight);
        vignetteSoftness = lerp(this.params.dayVignetteSoftness ?? 0.5, this.params.nightVignetteSoftness ?? 0.5, tNight);
        grainStrength = lerp(this.params.dayGrainStrength ?? 0.0, this.params.nightGrainStrength ?? 0.0, tNight);
      }

      // Manual override
      if (this.params.debugOverride) {
        exposure = this.params.exposure;
        saturation = this.params.saturation;
        contrast = this.params.contrast;
      } else {
        this.params.exposure = exposure;
        this.params.saturation = saturation;
        this.params.contrast = contrast;
      }

      saturation = Math.max(0.0, Math.min(2.0, saturation + (this.params.saturationBoost ?? 0.0)));
      vibrance = Math.max(-1.0, Math.min(1.0, vibrance + (this.params.vibranceBoost ?? 0.0)));

      // ── Sky tint color for Darkness Response lights ─────────────────
      {
        const t = temperature;
        let tr, tg, tb;
        if (t >= 0) {
          tr = 1.0 + t * 0.4;
          tg = 1.0 - t * 0.15;
          tb = 1.0 - t * 0.55;
        } else {
          const at = -t;
          tr = 1.0 - at * 0.45;
          tg = 1.0 - at * 0.1;
          tb = 1.0 + at * 0.4;
        }
        const tintShiftG = 1.0 + tint;
        tr = Math.max(0.01, tr);
        tg = Math.max(0.01, tg * tintShiftG);
        tb = Math.max(0.01, tb);
        // Deep blue night sky for downstream lights (window glow, dust, etc.).
        const deepR = 0.22;
        const deepG = 0.34;
        const deepB = 0.92;
        const calNightBoost = dayProgress < 0 ? 0.38 : 0.0;
        const nightSkyMix = clamp01(effectiveDarkness * 0.82 + calNightBoost);
        this.currentSkyTintColor.r = lerp(tr, deepR, nightSkyMix);
        this.currentSkyTintColor.g = lerp(tg, deepG, nightSkyMix);
        this.currentSkyTintColor.b = lerp(tb, deepB, nightSkyMix);
      }

      // ── Push to shader uniforms ─────────────────────────────────────
      const u = this._composeMaterial.uniforms;
      u.uTime.value = timeInfo.elapsed;

      // Keep post-pass screen UV -> world -> scene UV mapping in sync for outdoors masking.
      const sc = window.MapShine?.sceneComposer;
      const activeFloorIndex = Number(window.MapShine?.floorStack?.getActiveFloor?.()?.index);
      const sceneRect = canvas?.dimensions?.sceneRect;
      const sceneX = sceneRect?.x ?? 0;
      const sceneY = sceneRect?.y ?? 0;
      const sceneW = sceneRect?.width ?? 1;
      const sceneH = sceneRect?.height ?? 1;
      let vMinX = 0, vMinY = 0, vMaxX = sceneW, vMaxY = sceneH;
      const cam = sc?.camera;
      if (cam) {
        if (cam.isOrthographicCamera) {
          const camPos = cam.position;
          vMinX = camPos.x + cam.left / cam.zoom;
          vMinY = camPos.y + cam.bottom / cam.zoom;
          vMaxX = camPos.x + cam.right / cam.zoom;
          vMaxY = camPos.y + cam.top / cam.zoom;
        } else {
          const groundZ = sc?.groundZ ?? 0;
          const dist = Math.max(1e-3, Math.abs((cam.position?.z ?? 0) - groundZ));
          const fovRad = (Number(cam.fov) || 60) * Math.PI / 180;
          const halfH = dist * Math.tan(fovRad * 0.5);
          const aspect = Number(cam.aspect) || ((sc?.baseViewportWidth || 1) / Math.max(1, (sc?.baseViewportHeight || 1)));
          const halfW = halfH * aspect;
          vMinX = cam.position.x - halfW;
          vMaxX = cam.position.x + halfW;
          vMinY = cam.position.y - halfH;
          vMaxY = cam.position.y + halfH;
        }
      }
      u.uViewBoundsMin.value.set(vMinX, vMinY);
      u.uViewBoundsMax.value.set(vMaxX, vMaxY);
      u.uSceneBounds.value.set(sceneX, sceneY, sceneW, sceneH);
      u.uSceneDimensions.value.set(canvas?.dimensions?.width ?? sceneW, canvas?.dimensions?.height ?? sceneH);
      u.uActiveFloorIndex.value = Number.isFinite(activeFloorIndex) ? Math.max(0, activeFloorIndex) : 0.0;

      u.uExposure.value = exposure;
      u.uTemperature.value = temperature;
      u.uTint.value = tint;
      u.uBrightness.value = brightness;
      u.uContrast.value = contrast;
      u.uSaturation.value = saturation;
      u.uVibrance.value = vibrance;

      u.uLift.value.set(liftR, liftG, liftB);
      u.uGamma.value.set(Math.max(0.0001, gammaR), Math.max(0.0001, gammaG), Math.max(0.0001, gammaB));
      u.uGain.value.set(gainR, gainG, gainB);
      u.uMasterGamma.value = masterGamma ?? 1.0;
      u.uToneMapping.value = toneMapping;
      u.uVignetteStrength.value = vignetteStrength;
      u.uVignetteSoftness.value = vignetteSoftness;
      u.uGrainStrength.value = grainStrength;
      const rc = this.params.goldenOutdoorRecolorColor ?? { r: 1.35, g: 0.80, b: 0.50 };
      u.uGoldenRecolorStrength.value = clamp01(
        goldenEnergy * Math.max(0.0, Number(this.params.goldenOutdoorRecolorStrength ?? 0.0))
      );
      u.uGoldenRecolorColor.value.set(
        Math.max(0.01, Number(rc.r) || 1.35),
        Math.max(0.01, Number(rc.g) || 0.80),
        Math.max(0.01, Number(rc.b) || 0.50)
      );

      // Auto-intensity
      let effectiveIntensity = this.params.intensity;
      if (this.params.autoIntensityEnabled) {
        const localDayFactor = clamp01(this._lastDayFactor ?? 0.5);
        const localSceneDarkness = readSceneDarkness01();
        // Auto-intensity should NOT behave like “sky brightness”.
        // We want the grade to stay strong at night (to actually darken),
        // and be gentler at noon.
        //
        // localDayFactor: 0 at night → 1 at noon
        // localGradeIntensity: 1 at night → ~0.35 at noon
        //
        // Also keep a small responsiveness to Foundry scene darkness so that
        // explicit darkness changes still read as stronger grading.
        const localGradeIntensity = clamp01(
          (0.35 + 0.65 * (1.0 - localDayFactor)) *
          (0.85 + 0.15 * (1.0 - localSceneDarkness))
        );
        const strength = clamp01(this.params.autoIntensityStrength);
        effectiveIntensity *= lerp(1.0, localGradeIntensity, strength);
      }

      u.uIntensity.value = effectiveIntensity;
    } catch (e) {
      if (Math.random() < 0.01) {
        log.warn('SkyColorEffectV2 update failed:', e);
      }
    }
  }

  // ── Render ────────────────────────────────────────────────────────────

  /**
   * Execute the sky color grading post-processing pass.
   * Reads inputRT, writes to outputRT.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} inputRT  - Scene after lighting
   * @param {THREE.WebGLRenderTarget} outputRT - Where to write the graded result
   */
  render(renderer, inputRT, outputRT) {
    if (!this._initialized || !this._composeMaterial || !inputRT) return;
    if (!this.params.enabled) {
      // When disabled, we need to pass through — copy input to output.
      // If they're the same RT, nothing to do. Otherwise we'd need a blit.
      // For now, the FloorCompositor should skip this pass when disabled.
      return;
    }

    this._composeMaterial.uniforms.tDiffuse.value = inputRT.texture;

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
    try { this._fallbackWhite?.dispose?.(); } catch (_) {}
    this._composeScene = null;
    this._composeCamera = null;
    this._composeMaterial = null;
    this._composeQuad = null;
    this._fallbackWhite = null;
    this._initialized = false;
    log.info('SkyColorEffectV2 disposed');
  }
}
