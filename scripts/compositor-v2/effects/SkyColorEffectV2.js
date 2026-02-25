/**
 * @fileoverview SkyColorEffectV2 — V2 screen-space color grading post-processing pass.
 *
 * Applies time-of-day atmospheric color grading to the lit scene:
 *   - Exposure, white balance (temperature + tint)
 *   - Brightness, contrast, saturation, vibrance
 *   - Lift/Gamma/Gain color grading
 *   - Optional tone mapping (ACES Filmic, Reinhard)
 *   - Vignette + film grain
 *
 * Two automation modes:
 *   - **Analytic** (mode 1): Sunrise/sunset-aware sun model + weather integration
 *     (turbidity, Rayleigh, Mie, overcast desaturation, etc.)
 *   - **Preset Blend** (mode 0): Weighted blend of dawn/day/dusk/night presets.
 *
 * Exposes `currentSkyTintColor` for downstream systems (e.g., Darkness Response
 * lights adopt the sky hue during golden hour / blue hour).
 *
 * Simplifications vs V1:
 *   - No outdoors mask gating (grading applied globally for now)
 *   - No roof alpha, rope mask, or token mask
 *   - No cloud top mask
 *   These will be layered in as the corresponding V2 effects come online.
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

// ── SkyColorEffectV2 ────────────────────────────────────────────────────────

export class SkyColorEffectV2 {
  constructor() {
    /** @type {boolean} */
    this._initialized = false;

    // ── Tuning parameters (match V1 defaults) ──────────────────────────
    this.params = {
      enabled: true,
      intensity: 1.0,
      saturationBoost: 0.35,
      vibranceBoost: 0.0,

      automationMode: 1,
      sunriseHour: 6.0,
      sunsetHour: 18.0,
      goldenHourWidth: 2.5,
      goldenStrength: 2.0,
      goldenPower: 1.35,
      nightFloor: 0.0,

      analyticStrength: 1.75,
      turbidity: 0.22,
      rayleighStrength: 0.63,
      mieStrength: 0.35,
      forwardScatter: 0.3,

      weatherInfluence: 0.7,
      cloudToTurbidity: 0.25,
      precipToTurbidity: 0.72,
      overcastDesaturate: 0.2,
      overcastContrastReduce: 0.22,

      tempWarmAtHorizon: 0.85,
      tempCoolAtNoon: -0.45,
      nightCoolBoost: -0.25,
      goldenSaturationBoost: 0.18,
      nightSaturationFloor: 0.33,
      hazeLift: 0.12,
      hazeContrastLoss: 0.0,

      autoIntensityEnabled: true,
      autoIntensityStrength: 1.0,

      skyTintDarknessLightsEnabled: true,
      skyTintDarknessLightsIntensity: 1.0,

      // Dawn preset
      dawnExposure: 0.70, dawnTemperature: 1.00, dawnTint: 0.00,
      dawnBrightness: -0.05, dawnContrast: 0.90, dawnSaturation: 1.15, dawnVibrance: 0.00,
      dawnLiftColor: { r: 0, g: 0, b: 0 },
      dawnGammaColor: { r: 1, g: 1, b: 1 },
      dawnGainColor: { r: 1, g: 1, b: 1 },
      dawnMasterGamma: 1.00, dawnToneMapping: 0,
      dawnVignetteStrength: 0.72, dawnVignetteSoftness: 1.00, dawnGrainStrength: 0.0,

      // Day preset
      dayExposure: 0.5, dayTemperature: 0.0, dayTint: 0.0,
      dayBrightness: 0.0, dayContrast: 1.02, daySaturation: 1.02, dayVibrance: 0.0,
      dayLiftColor: { r: 0, g: 0, b: 0 },
      dayGammaColor: { r: 0.50, g: 0.50, b: 0.50 },
      dayGainColor: { r: 1, g: 1, b: 1 },
      dayMasterGamma: 2.0, dayToneMapping: 0,
      dayVignetteStrength: 0.0, dayVignetteSoftness: 0.5, dayGrainStrength: 0.0,

      // Dusk preset
      duskExposure: 0.7, duskTemperature: 1.0, duskTint: 0.05,
      duskBrightness: -0.05, duskContrast: 0.9, duskSaturation: 1.15, duskVibrance: 0.15,
      duskLiftColor: { r: 0, g: 0, b: 0 },
      duskGammaColor: { r: 0.54, g: 0.52, b: 0.50 },
      duskGainColor: { r: 1.08, g: 1.02, b: 0.95 },
      duskMasterGamma: 1.00, duskToneMapping: 0,
      duskVignetteStrength: 0.72, duskVignetteSoftness: 1.0, duskGrainStrength: 0.0,

      // Night preset
      nightExposure: 0.0, nightTemperature: -0.5, nightTint: 0.0,
      nightBrightness: 0.0, nightContrast: 1.00, nightSaturation: 0.33, nightVibrance: -0.58,
      nightLiftColor: { r: 0, g: 0, b: 0 },
      nightGammaColor: { r: 1, g: 1, b: 1 },
      nightGainColor: { r: 1, g: 1, b: 1 },
      nightMasterGamma: 1.0, nightToneMapping: 0,
      nightVignetteStrength: 0.25, nightVignetteSoftness: 1.00, nightGrainStrength: 0.0,

      debugOverride: false,
      exposure: 0.0,
      saturation: 1.0,
      contrast: 1.0,
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
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  initialize() {
    const THREE = window.THREE;
    if (!THREE) return;

    this._composeScene = new THREE.Scene();
    this._composeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._composeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse:    { value: null },
        uTime:       { value: 0.0 },
        uResolution: { value: new THREE.Vector2(1, 1) },

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
        uniform vec2 uResolution;
        uniform float uTime;

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

        void main() {
          vec4 sceneColor = texture2D(tDiffuse, vUv);
          vec3 base = sceneColor.rgb;

          // V2 simplified: no outdoors/roof/rope/token masks yet.
          // Grading applied globally, gated only by uIntensity.
          if (uIntensity <= 0.0) {
            gl_FragColor = sceneColor;
            return;
          }

          vec3 color = base;

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

          // Blend graded result with original based on intensity.
          float mask = clamp(uIntensity, 0.0, 1.0);
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
      let toneMapping = this.params.dayToneMapping;
      let vignetteStrength = 0.0;
      let vignetteSoftness = 0.5;
      let grainStrength = 0.0;

      if (this.params.automationMode === 1) {
        // ── Analytic automation ──────────────────────────────────────
        const isFoundryLinked = window.MapShine?.controlPanel?.controlState?.linkTimeToFoundry === true;
        const foundryPhases = isFoundryLinked ? getFoundryTimePhaseHours() : null;
        const sunrise = wrapHour24(Number.isFinite(foundryPhases?.sunrise) ? foundryPhases.sunrise : this.params.sunriseHour);
        const sunset = wrapHour24(Number.isFinite(foundryPhases?.sunset) ? foundryPhases.sunset : this.params.sunsetHour);

        // Day progress: 0→1 from sunrise to sunset, -1 at night
        let dayProgress = 0.0;
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

        let sceneDarkness = 0.0;
        try { sceneDarkness = clamp01(canvas?.environment?.darknessLevel ?? 0.0); } catch (_) {}
        if (env && Number.isFinite(env.sceneDarkness)) sceneDarkness = clamp01(env.sceneDarkness);

        const weatherInfluence = clamp01(this.params.weatherInfluence);
        const turbidityBase = clamp01(this.params.turbidity);
        const turbidityWeather = weatherInfluence * (
          (this.params.cloudToTurbidity ?? 0.0) * cloudCover +
          (this.params.precipToTurbidity ?? 0.0) * precipitation
        );
        const turbidityEff = clamp01(turbidityBase + turbidityWeather);

        const effectiveDarkness = clamp01(
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
        const satFloor = clamp01(this.params.nightSaturationFloor);
        saturation = Math.max(satFloor, lerp(saturation, satFloor, effectiveDarkness * 0.75));

        contrast = 1.0;
        contrast *= 1.0 - overcastContrast * overcast * weatherInfluence;
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
      } else {
        // ── Preset blend automation ─────────────────────────────────
        const wDawn = peakHour(hour, 6.0, 3.0);
        const wDay = peakHour(hour, 12.0, 5.5);
        const wDusk = peakHour(hour, 18.0, 3.0);
        const wNight = peakHour(hour, 0.0, 6.5);
        const wSum = Math.max(0.0001, wDawn + wDay + wDusk + wNight);
        const wd = wDawn / wSum;
        const wday = wDay / wSum;
        const wdu = wDusk / wSum;
        const wn = wNight / wSum;

        const p = this.params;

        exposure = p.dawnExposure * wd + p.dayExposure * wday + p.duskExposure * wdu + p.nightExposure * wn;
        temperature = p.dawnTemperature * wd + p.dayTemperature * wday + p.duskTemperature * wdu + p.nightTemperature * wn;
        tint = p.dawnTint * wd + p.dayTint * wday + p.duskTint * wdu + p.nightTint * wn;
        brightness = p.dawnBrightness * wd + p.dayBrightness * wday + p.duskBrightness * wdu + p.nightBrightness * wn;
        contrast = p.dawnContrast * wd + p.dayContrast * wday + p.duskContrast * wdu + p.nightContrast * wn;
        saturation = p.dawnSaturation * wd + p.daySaturation * wday + p.duskSaturation * wdu + p.nightSaturation * wn;
        vibrance = p.dawnVibrance * wd + p.dayVibrance * wday + p.duskVibrance * wdu + p.nightVibrance * wn;

        const blend3 = (dawn, day, dusk, night) => ({
          r: dawn.r * wd + day.r * wday + dusk.r * wdu + night.r * wn,
          g: dawn.g * wd + day.g * wday + dusk.g * wdu + night.g * wn,
          b: dawn.b * wd + day.b * wday + dusk.b * wdu + night.b * wn,
        });

        const lift = blend3(p.dawnLiftColor, p.dayLiftColor, p.duskLiftColor, p.nightLiftColor);
        liftR = lift.r; liftG = lift.g; liftB = lift.b;
        const gamma = blend3(p.dawnGammaColor, p.dayGammaColor, p.duskGammaColor, p.nightGammaColor);
        gammaR = gamma.r; gammaG = gamma.g; gammaB = gamma.b;
        const gain = blend3(p.dawnGainColor, p.dayGainColor, p.duskGainColor, p.nightGainColor);
        gainR = gain.r; gainG = gain.g; gainB = gain.b;

        masterGamma = p.dawnMasterGamma * wd + p.dayMasterGamma * wday + p.duskMasterGamma * wdu + p.nightMasterGamma * wn;
        vignetteStrength = p.dawnVignetteStrength * wd + p.dayVignetteStrength * wday + p.duskVignetteStrength * wdu + p.nightVignetteStrength * wn;
        vignetteSoftness = p.dawnVignetteSoftness * wd + p.dayVignetteSoftness * wday + p.duskVignetteSoftness * wdu + p.nightVignetteSoftness * wn;
        grainStrength = p.dawnGrainStrength * wd + p.dayGrainStrength * wday + p.duskGrainStrength * wdu + p.nightGrainStrength * wn;

        // Dominant tone mapping
        let wMax = wday;
        toneMapping = p.dayToneMapping;
        if (wd > wMax) { wMax = wd; toneMapping = p.dawnToneMapping; }
        if (wdu > wMax) { wMax = wdu; toneMapping = p.duskToneMapping; }
        if (wn > wMax) { wMax = wn; toneMapping = p.nightToneMapping; }
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
        this.currentSkyTintColor.r = Math.max(0.01, tr);
        this.currentSkyTintColor.g = Math.max(0.01, tg * tintShiftG);
        this.currentSkyTintColor.b = Math.max(0.01, tb);
      }

      // ── Push to shader uniforms ─────────────────────────────────────
      const u = this._composeMaterial.uniforms;
      u.uTime.value = timeInfo.elapsed;

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

      // Auto-intensity
      let effectiveIntensity = this.params.intensity;
      if (this.params.automationMode === 1 && this.params.autoIntensityEnabled) {
        const localDayFactor = clamp01(this._lastDayFactor ?? 0.5);
        const envFallback = weatherController?.getEnvironment?.();
        const overcastMul = 1.0 - clamp01(envFallback?.overcastFactor ?? 0) * 0.55;
        const stormMul = 1.0 - clamp01(envFallback?.stormFactor ?? 0) * 0.25;
        let localSceneDarkness = 0.0;
        try { localSceneDarkness = clamp01(canvas?.environment?.darknessLevel ?? 0.0); } catch (_) {}
        const darkMul = 1.0 - localSceneDarkness * 0.85;
        const localSkyIntensity = clamp01((0.15 + 0.85 * localDayFactor) * overcastMul * stormMul * darkMul);
        const strength = clamp01(this.params.autoIntensityStrength);
        effectiveIntensity *= lerp(1.0, localSkyIntensity, strength);
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
    this._composeScene = null;
    this._composeCamera = null;
    this._composeMaterial = null;
    this._composeQuad = null;
    this._initialized = false;
    log.info('SkyColorEffectV2 disposed');
  }
}
