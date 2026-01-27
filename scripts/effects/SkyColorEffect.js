import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import { weatherController } from '../core/WeatherController.js';

const log = createLogger('SkyColorEffect');

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

export class SkyColorEffect extends EffectBase {
  constructor() {
    super('sky-color', RenderLayers.POST_PROCESSING, 'low');

    // Must run AFTER LightingEffect (priority=1) or it will be overwritten by
    // the lighting composite.
    // Also run well before ColorCorrectionEffect (priority=100).
    this.priority = 5;
    
    this.enabled = true;

    // NOTE: Defaults tuned to avoid stacking color correction with ColorCorrectionEffect.
    // Set intensity to 0.2 to enable subtle atmospheric grading by default.
    // See docs/CONTRAST-DARKNESS-ANALYSIS.md for rationale.
    this.params = {
      enabled: true,

      // Master blend of sky grading vs base scene
      // Default 0.2 to provide subtle atmospheric grading - users can increase/decrease as desired
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

      // --- Time-of-day grading presets (blended by timeOfDay) ---
      // Note: These are applied only to outdoors (masked) and then blended by intensity.
      // All values are tuned to be subtle by default; raise intensity for stronger look.

      // Dawn
      dawnExposure: 0.70,
      dawnTemperature: 1.00,
      dawnTint: 0.00,
      dawnBrightness: -0.05,
      dawnContrast: 0.90,
      dawnSaturation: 1.15,
      dawnVibrance: 0.00,
      dawnLiftColor: { r: 0.00, g: 0.00, b: 0.00 },
      dawnGammaColor: { r: 1.00, g: 1.00, b: 1.00 },
      dawnGainColor: { r: 1.00, g: 1.00, b: 1.00 },
      dawnMasterGamma: 1.00,
      dawnToneMapping: 0,
      dawnVignetteStrength: 0.72,
      dawnVignetteSoftness: 1.00,
      dawnGrainStrength: 0.0,

      // Day
      dayExposure: 0.5,
      dayTemperature: 0.0,
      dayTint: 0.0,
      dayBrightness: 0.0,
      dayContrast: 1.02,
      daySaturation: 1.02,
      dayVibrance: 0.0,
      dayLiftColor: { r: 0.00, g: 0.00, b: 0.00 },
      dayGammaColor: { r: 0.50, g: 0.50, b: 0.50 },
      dayGainColor: { r: 1.00, g: 1.00, b: 1.00 },
      dayMasterGamma: 2.0,
      dayToneMapping: 0,
      dayVignetteStrength: 0.0,
      dayVignetteSoftness: 0.5,
      dayGrainStrength: 0.0,

      // Dusk
      duskExposure: 0.7,
      duskTemperature: 1.0,
      duskTint: 0.05,
      duskBrightness: -0.05,
      duskContrast: 0.9,
      duskSaturation: 1.15,
      duskVibrance: 0.15,
      duskLiftColor: { r: 0.00, g: 0.00, b: 0.00 },
      duskGammaColor: { r: 0.54, g: 0.52, b: 0.50 },
      duskGainColor: { r: 1.08, g: 1.02, b: 0.95 },
      duskMasterGamma: 1.00,
      duskToneMapping: 0,
      duskVignetteStrength: 0.72,
      duskVignetteSoftness: 1.0,
      duskGrainStrength: 0.0,

      // Night
      nightExposure: 0.0,
      nightTemperature: -0.5,
      nightTint: 0.0,
      nightBrightness: 0.0,
      nightContrast: 1.00,
      nightSaturation: 0.33,
      nightVibrance: -0.58,
      nightLiftColor: { r: 0.00, g: 0.00, b: 0.00 },
      nightGammaColor: { r: 1.00, g: 1.00, b: 1.00 },
      nightGainColor: { r: 1.00, g: 1.00, b: 1.00 },
      nightMasterGamma: 1.0,
      nightToneMapping: 0,
      nightVignetteStrength: 0.25,
      nightVignetteSoftness: 1.00,
      nightGrainStrength: 0.0,

      // Automation vs manual override
      debugOverride: false,

      // Manually editable exposure/saturation/contrast when debugOverride is true
      exposure: 0.0,
      saturation: 1.0,
      contrast: 1.0
    };

    this.material = null;
    this.quadScene = null;
    this.quadCamera = null;

    this.readBuffer = null;
    this.writeBuffer = null;
  }

  static getControlSchema() {
    const stageParams = (prefix, labelPrefix) => {
      const p = (name) => `${prefix}${name}`;
      return {
        groups: [
          {
            name: `${prefix.toLowerCase()}-exposure-wb`,
            label: `${labelPrefix} Exposure & WB`,
            type: 'inline',
            parameters: [p('Exposure'), p('Temperature'), p('Tint')]
          },
          {
            name: `${prefix.toLowerCase()}-basics`,
            label: `${labelPrefix} Basic Adjustments`,
            type: 'inline',
            parameters: [p('Contrast'), p('Brightness'), p('Saturation'), p('Vibrance')]
          },
          {
            name: `${prefix.toLowerCase()}-grading`,
            label: `${labelPrefix} Color Grading`,
            type: 'folder',
            expanded: false,
            parameters: [p('ToneMapping'), p('LiftColor'), p('GammaColor'), p('GainColor'), p('MasterGamma')]
          },
          {
            name: `${prefix.toLowerCase()}-artistic`,
            label: `${labelPrefix} Effects (Vignette/Grain)`,
            type: 'folder',
            expanded: false,
            parameters: [p('VignetteStrength'), p('VignetteSoftness'), p('GrainStrength')]
          }
        ],
        parameters: {
          [p('Exposure')]: { type: 'slider', min: -1, max: 1, step: 0.01, default: 0.0 },
          [p('Temperature')]: { type: 'slider', min: -1, max: 1, step: 0.01, default: 0.0 },
          [p('Tint')]: { type: 'slider', min: -1, max: 1, step: 0.01, default: 0.0 },
          [p('Brightness')]: { type: 'slider', min: -0.5, max: 0.5, step: 0.01, default: 0.0 },
          [p('Contrast')]: { type: 'slider', min: 0, max: 2, step: 0.01, default: 1.0 },
          [p('Saturation')]: { type: 'slider', min: 0, max: 2, step: 0.01, default: 1.0 },
          [p('Vibrance')]: { type: 'slider', min: -1, max: 1, step: 0.01, default: 0.0 },
          [p('LiftColor')]: { type: 'color', default: { r: 0, g: 0, b: 0 } },
          [p('GammaColor')]: { type: 'color', default: { r: 0.5, g: 0.5, b: 0.5 } },
          [p('GainColor')]: { type: 'color', default: { r: 1, g: 1, b: 1 } },
          [p('MasterGamma')]: { type: 'slider', min: 0.1, max: 3, step: 0.01, default: 1.0 },
          [p('ToneMapping')]: {
            type: 'list',
            options: { 'None': 0, 'ACES Filmic': 1, 'Reinhard': 2 },
            default: 0
          },
          [p('VignetteStrength')]: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.0 },
          [p('VignetteSoftness')]: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.5 },
          [p('GrainStrength')]: { type: 'slider', min: 0, max: 0.5, step: 0.01, default: 0.0 }
        }
      };
    };

    const dawn = stageParams('dawn', 'Dawn');
    const day = stageParams('day', 'Day');
    const dusk = stageParams('dusk', 'Dusk');
    const night = stageParams('night', 'Night');

    // Override Dawn UI defaults to match the tuned SkyColorEffect defaults
    // (so reset/new scenes align with the desired Dawn look)
    dawn.parameters.dawnExposure.default = 0.70;
    dawn.parameters.dawnTemperature.default = 1.00;
    dawn.parameters.dawnTint.default = 0.00;
    dawn.parameters.dawnBrightness.default = -0.05;
    dawn.parameters.dawnContrast.default = 0.90;
    dawn.parameters.dawnSaturation.default = 1.15;
    dawn.parameters.dawnVibrance.default = 0.00;
    dawn.parameters.dawnLiftColor.default = { r: 0.00, g: 0.00, b: 0.00 };
    dawn.parameters.dawnGammaColor.default = { r: 1.00, g: 1.00, b: 1.00 };
    dawn.parameters.dawnGainColor.default = { r: 1.00, g: 1.00, b: 1.00 };
    dawn.parameters.dawnMasterGamma.default = 1.00;
    dawn.parameters.dawnToneMapping.default = 0;
    dawn.parameters.dawnVignetteStrength.default = 0.72;
    dawn.parameters.dawnVignetteSoftness.default = 1.00;
    dawn.parameters.dawnGrainStrength.default = 0.00;

    // Override Day UI defaults to match the current tuned scene values
    day.parameters.dayExposure.default = 0.50;
    day.parameters.dayMasterGamma.default = 2.00;

    // Override Dusk UI defaults to match the current tuned scene values
    dusk.parameters.duskExposure.default = 0.70;
    dusk.parameters.duskTemperature.default = 1.00;
    dusk.parameters.duskBrightness.default = -0.05;
    dusk.parameters.duskContrast.default = 0.90;
    dusk.parameters.duskSaturation.default = 1.15;
    dusk.parameters.duskVignetteStrength.default = 0.72;
    dusk.parameters.duskVignetteSoftness.default = 1.00;

    // Override Night UI defaults to match the current tuned scene values
    night.parameters.nightExposure.default = 0.00;
    night.parameters.nightTemperature.default = -0.50;
    night.parameters.nightTint.default = 0.00;
    night.parameters.nightBrightness.default = 0.00;
    night.parameters.nightSaturation.default = 0.33;
    night.parameters.nightVibrance.default = -0.58;
    night.parameters.nightGammaColor.default = { r: 1.00, g: 1.00, b: 1.00 };
    night.parameters.nightMasterGamma.default = 1.00;
    night.parameters.nightVignetteStrength.default = 0.25;
    night.parameters.nightVignetteSoftness.default = 1.00;

    return {
      enabled: true,
      groups: [
        {
          name: 'sky-color',
          label: 'Sky Color',
          type: 'inline',
          parameters: ['intensity', 'saturationBoost', 'vibranceBoost']
        },
        {
          name: 'sky-automation',
          label: 'Automation (Analytic)',
          type: 'folder',
          expanded: false,
          parameters: [
            'automationMode',
            'sunriseHour',
            'sunsetHour',
            'goldenHourWidth',
            'goldenStrength',
            'goldenPower',
            'nightFloor',
            'analyticStrength',
            'turbidity',
            'rayleighStrength',
            'mieStrength',
            'forwardScatter',
            'weatherInfluence',
            'cloudToTurbidity',
            'precipToTurbidity',
            'overcastDesaturate',
            'overcastContrastReduce',
            'tempWarmAtHorizon',
            'tempCoolAtNoon',
            'nightCoolBoost',
            'goldenSaturationBoost',
            'nightSaturationFloor',
            'hazeLift',
            'hazeContrastLoss',
            'autoIntensityEnabled',
            'autoIntensityStrength'
          ]
        },
        {
          name: 'time-of-day',
          label: 'Time of Day Grading',
          type: 'folder',
          expanded: false,
          parameters: []
        },
        {
          name: 'dawn',
          label: 'Dawn',
          type: 'folder',
          expanded: false,
          parameters: []
        },
        ...dawn.groups,
        {
          name: 'day',
          label: 'Day',
          type: 'folder',
          expanded: false,
          parameters: []
        },
        ...day.groups,
        {
          name: 'dusk',
          label: 'Dusk',
          type: 'folder',
          expanded: false,
          parameters: []
        },
        ...dusk.groups,
        {
          name: 'night',
          label: 'Night',
          type: 'folder',
          expanded: false,
          parameters: []
        },
        ...night.groups,
        {
          name: 'automation',
          label: 'Automation vs Manual',
          type: 'inline',
          separator: true,
          parameters: ['debugOverride', 'exposure', 'saturation', 'contrast']
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: true },
        intensity: {
          type: 'slider',
          min: 0,
          max: 1,
          step: 0.01,
          default: 1.0,
          label: 'Intensity',
          throttle: 50
        },
        saturationBoost: {
          type: 'slider',
          min: -0.5,
          max: 0.5,
          step: 0.01,
          default: 0.35,
          label: 'Sat Boost',
          throttle: 50
        },
        vibranceBoost: {
          type: 'slider',
          min: -0.5,
          max: 0.5,
          step: 0.01,
          default: 0.0,
          label: 'Vibrance',
          throttle: 50
        },
        automationMode: {
          type: 'list',
          options: { 'Preset Blend (Legacy)': 0, 'Analytic (Sun + Weather)': 1 },
          default: 1,
          label: 'Automation Mode'
        },
        sunriseHour: { type: 'slider', min: 0, max: 24, step: 0.05, default: 6.0, label: 'Sunrise', throttle: 50 },
        sunsetHour: { type: 'slider', min: 0, max: 24, step: 0.05, default: 18.0, label: 'Sunset', throttle: 50 },
        goldenHourWidth: { type: 'slider', min: 0.25, max: 6.0, step: 0.05, default: 2.5, label: 'Golden Width', throttle: 50 },
        goldenStrength: { type: 'slider', min: 0.0, max: 4.0, step: 0.01, default: 2.0, label: 'Golden Strength', throttle: 50 },
        goldenPower: { type: 'slider', min: 0.5, max: 3.0, step: 0.01, default: 1.35, label: 'Golden Power', throttle: 50 },
        nightFloor: { type: 'slider', min: 0.0, max: 0.5, step: 0.01, default: 0.0, label: 'Night Floor', throttle: 50 },
        analyticStrength: { type: 'slider', min: 0.0, max: 4.0, step: 0.01, default: 1.75, label: 'Analytic Strength', throttle: 50 },
        turbidity: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.22, label: 'Turbidity', throttle: 50 },
        rayleighStrength: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.63, label: 'Rayleigh', throttle: 50 },
        mieStrength: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.35, label: 'Mie', throttle: 50 },
        forwardScatter: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.3, label: 'Forward Scatter', throttle: 50 },
        weatherInfluence: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.7, label: 'Weather Influence', throttle: 50 },
        cloudToTurbidity: { type: 'slider', min: 0.0, max: 2.0, step: 0.01, default: 0.25, label: 'Cloud→Turbidity', throttle: 50 },
        precipToTurbidity: { type: 'slider', min: 0.0, max: 2.0, step: 0.01, default: 0.72, label: 'Precip→Turbidity', throttle: 50 },
        overcastDesaturate: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.2, label: 'Overcast Desat', throttle: 50 },
        overcastContrastReduce: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.22, label: 'Overcast Contrast', throttle: 50 },
        tempWarmAtHorizon: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.85, label: 'Warm Horizon', throttle: 50 },
        tempCoolAtNoon: { type: 'slider', min: -1.0, max: 0.0, step: 0.01, default: -0.45, label: 'Cool Noon', throttle: 50 },
        nightCoolBoost: { type: 'slider', min: -1.0, max: 0.0, step: 0.01, default: -0.25, label: 'Night Cool', throttle: 50 },
        goldenSaturationBoost: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.18, label: 'Golden Sat', throttle: 50 },
        nightSaturationFloor: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.33, label: 'Night Sat Floor', throttle: 50 },
        hazeLift: { type: 'slider', min: 0.0, max: 0.5, step: 0.01, default: 0.12, label: 'Haze Lift', throttle: 50 },
        hazeContrastLoss: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.0, label: 'Haze Contrast', throttle: 50 },
        autoIntensityEnabled: { type: 'boolean', default: true, label: 'Auto Intensity' },
        autoIntensityStrength: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 1.0, label: 'Auto Strength', throttle: 50 },
        ...dawn.parameters,
        ...day.parameters,
        ...dusk.parameters,
        ...night.parameters,
        debugOverride: {
          type: 'boolean',
          default: false,
          label: 'Manual Override'
        },
        exposure: {
          type: 'slider',
          min: -1,
          max: 1,
          step: 0.01,
          default: 0.0,
          label: 'Exposure (Manual)',
          throttle: 50
        },
        saturation: {
          type: 'slider',
          min: 0,
          max: 2,
          step: 0.01,
          default: 1.0,
          label: 'Saturation (Manual)',
          throttle: 50
        },
        contrast: {
          type: 'slider',
          min: 0.5,
          max: 1.5,
          step: 0.01,
          default: 1.0,
          label: 'Contrast (Manual)',
          throttle: 50
        }
      }
    };
  }

  initialize(renderer, scene, camera) {
    const THREE = window.THREE;

    this.renderer = renderer;

    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tOutdoorsMask: { value: null },
        uHasOutdoorsMask: { value: 0.0 },
        tRoofAlpha: { value: null },
        uHasRoofAlpha: { value: 0.0 },
        tRopeMask: { value: null },
        uHasRopeMask: { value: 0.0 },
        tTokenMask: { value: null },
        uHasTokenMask: { value: 0.0 },
        tCloudTop: { value: null },
        uHasCloudTop: { value: 0.0 },
        uTime: { value: 0.0 },
        uResolution: { value: new THREE.Vector2(1, 1) },

        // Grading params (blended per time-of-day)
        uExposure: { value: 0.0 },
        uTemperature: { value: 0.0 },
        uTint: { value: 0.0 },
        uBrightness: { value: 0.0 },
        uContrast: { value: 1.0 },
        uSaturation: { value: 1.0 },
        uVibrance: { value: 0.0 },

        uLift: { value: new THREE.Vector3(0, 0, 0) },
        uGamma: { value: new THREE.Vector3(1, 1, 1) },
        uGain: { value: new THREE.Vector3(1, 1, 1) },
        uMasterGamma: { value: 1.0 },
        uToneMapping: { value: 0 },

        uVignetteStrength: { value: 0.0 },
        uVignetteSoftness: { value: 0.5 },
        uGrainStrength: { value: 0.0 },

        uIntensity: { value: 1.0 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform sampler2D tOutdoorsMask;
        uniform float uHasOutdoorsMask;
        uniform sampler2D tRoofAlpha;
        uniform float uHasRoofAlpha;
        uniform sampler2D tRopeMask;
        uniform float uHasRopeMask;
        uniform sampler2D tTokenMask;
        uniform float uHasTokenMask;
        uniform sampler2D tCloudTop;
        uniform float uHasCloudTop;
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

        vec3 applyWhiteBalance(vec3 color, float temp, float tint) {
          vec3 tempShift = vec3(1.0 + temp, 1.0, 1.0 - temp);
          if (temp < 0.0) tempShift = vec3(1.0, 1.0, 1.0 - temp * 0.5);
          else tempShift = vec3(1.0 + temp * 0.5, 1.0, 1.0);

          vec3 tintShift = vec3(1.0, 1.0 + tint, 1.0);
          return color * tempShift * tintShift;
        }

        float random(vec2 p) {
          return fract(sin(dot(p.xy, vec2(12.9898, 78.233))) * 43758.5453);
        }

        void main() {
          vec4 sceneColor = texture2D(tDiffuse, vUv);
          vec3 base = sceneColor.rgb;

          float outdoors = 1.0;
          if (uHasOutdoorsMask > 0.5) {
            outdoors = texture2D(tOutdoorsMask, vUv).r;
          }

          float roofAlpha = 0.0;
          if (uHasRoofAlpha > 0.5) {
            roofAlpha = texture2D(tRoofAlpha, vUv).a;
          }

          float ropeMask = 0.0;
          if (uHasRopeMask > 0.5) {
            ropeMask = texture2D(tRopeMask, vUv).a;
          }

          float tokenMask = 0.0;
          if (uHasTokenMask > 0.5) {
            tokenMask = texture2D(tTokenMask, vUv).a;
          }

          float cloudTopAlpha = 0.0;
          if (uHasCloudTop > 0.5) {
            cloudTopAlpha = texture2D(tCloudTop, vUv).a;
          }

          float outdoorLike = max(outdoors, cloudTopAlpha);
          float gradeMask = clamp(max(outdoorLike, tokenMask), 0.0, 1.0);

          if (uIntensity <= 0.0 || gradeMask <= 0.0) {
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

          // 6) VFX
          vec2 dist = (vUv - 0.5) * 2.0;
          float len = length(dist);
          if (uVignetteStrength > 0.0) {
            float soft = clamp(uVignetteSoftness, 0.0, 1.0);
            float inner = mix(0.85, 0.35, soft);
            float outer = mix(1.25, 0.85, soft);
            float vig = 1.0 - smoothstep(inner, outer, len);
            color *= mix(1.0, vig, uVignetteStrength);
          }

          if (uGrainStrength > 0.0) {
            float noise = random(vUv + uTime);
            color += (noise - 0.5) * uGrainStrength;
          }

          float mask = clamp(gradeMask * uIntensity, 0.0, 1.0);
          vec3 finalColor = mix(base, color, mask);

          gl_FragColor = vec4(finalColor, sceneColor.a);
        }
      `,
      depthWrite: false,
      depthTest: false
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quadScene.add(quad);
  }

  setBuffers(readBuffer, writeBuffer) {
    this.readBuffer = readBuffer;
    this.writeBuffer = writeBuffer;
  }

  setInputTexture(texture) {
    if (this.material) {
      this.material.uniforms.tDiffuse.value = texture;
    }
  }

  update(timeInfo) {
    if (!this.material) return;

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
      let liftR = 0.0;
      let liftG = 0.0;
      let liftB = 0.0;
      let gammaR = 1.0;
      let gammaG = 1.0;
      let gammaB = 1.0;
      let gainR = 1.0;
      let gainG = 1.0;
      let gainB = 1.0;
      let masterGamma = 1.0;
      let toneMapping = this.params.dayToneMapping;
      let vignetteStrength = 0.0;
      let vignetteSoftness = 0.5;
      let grainStrength = 0.0;

      if (this.params.automationMode === 1) {
        const sunrise = wrapHour24(this.params.sunriseHour);
        const sunset = wrapHour24(this.params.sunsetHour);

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
        const dayFactor = Math.max(clamp01(this.params.nightFloor), clamp01(sunFactorRaw));

        const goldenWidth = Math.max(0.0001, this.params.goldenHourWidth);
        const goldenBase = clamp01(peakHour(hour, sunrise, goldenWidth) + peakHour(hour, sunset, goldenWidth));
        const goldenPow = Math.pow(goldenBase, Math.max(0.0001, this.params.goldenPower ?? 1.0));
        const golden = clamp01(goldenPow * Math.max(0.0, this.params.goldenStrength ?? 1.0));

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
        try {
          sceneDarkness = clamp01(canvas?.environment?.darknessLevel ?? 0.0);
        } catch (e) {
          sceneDarkness = 0.0;
        }

        if (env && Number.isFinite(env.sceneDarkness)) {
          sceneDarkness = clamp01(env.sceneDarkness);
        }

        const weatherInfluence = clamp01(this.params.weatherInfluence);
        const turbidityBase = clamp01(this.params.turbidity);
        const turbidityWeather = weatherInfluence * (
          (this.params.cloudToTurbidity ?? 0.0) * cloudCover +
          (this.params.precipToTurbidity ?? 0.0) * precipitation
        );
        const turbidityEff = clamp01(turbidityBase + turbidityWeather);

        let effectiveDarkness = clamp01(
          sceneDarkness +
          (1.0 - dayFactor) * 0.25 +
          overcast * 0.15 +
          storm * 0.1
        );

        if (env && Number.isFinite(env.effectiveDarkness)) {
          effectiveDarkness = clamp01(env.effectiveDarkness);
        }

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

        const hazeLift = clamp01(this.params.hazeLift);
        brightness = turbidityEff * mie * hazeLift;

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

        const tNight = clamp01(effectiveDarkness);
        vignetteStrength = lerp(this.params.dayVignetteStrength ?? 0.0, this.params.nightVignetteStrength ?? 0.0, tNight);
        vignetteSoftness = lerp(this.params.dayVignetteSoftness ?? 0.5, this.params.nightVignetteSoftness ?? 0.5, tNight);
        grainStrength = lerp(this.params.dayGrainStrength ?? 0.0, this.params.nightGrainStrength ?? 0.0, tNight);
      } else {
        const wDawn = peakHour(hour, 6.0, 3.0);
        const wDay = peakHour(hour, 12.0, 5.5);
        const wDusk = peakHour(hour, 18.0, 3.0);
        const wNight = peakHour(hour, 0.0, 6.5);
        const wSum = Math.max(0.0001, wDawn + wDay + wDusk + wNight);
        const wd = wDawn / wSum;
        const wday = wDay / wSum;
        const wdu = wDusk / wSum;
        const wn = wNight / wSum;

        const dawnLift = this.params.dawnLiftColor;
        const dawnGamma = this.params.dawnGammaColor;
        const dawnGain = this.params.dawnGainColor;
        const dayLift = this.params.dayLiftColor;
        const dayGamma = this.params.dayGammaColor;
        const dayGain = this.params.dayGainColor;
        const duskLift = this.params.duskLiftColor;
        const duskGamma = this.params.duskGammaColor;
        const duskGain = this.params.duskGainColor;
        const nightLift = this.params.nightLiftColor;
        const nightGamma = this.params.nightGammaColor;
        const nightGain = this.params.nightGainColor;

        exposure = this.params.dawnExposure * wd + this.params.dayExposure * wday + this.params.duskExposure * wdu + this.params.nightExposure * wn;
        temperature = this.params.dawnTemperature * wd + this.params.dayTemperature * wday + this.params.duskTemperature * wdu + this.params.nightTemperature * wn;
        tint = this.params.dawnTint * wd + this.params.dayTint * wday + this.params.duskTint * wdu + this.params.nightTint * wn;
        brightness = this.params.dawnBrightness * wd + this.params.dayBrightness * wday + this.params.duskBrightness * wdu + this.params.nightBrightness * wn;
        contrast = this.params.dawnContrast * wd + this.params.dayContrast * wday + this.params.duskContrast * wdu + this.params.nightContrast * wn;
        saturation = this.params.dawnSaturation * wd + this.params.daySaturation * wday + this.params.duskSaturation * wdu + this.params.nightSaturation * wn;
        vibrance = this.params.dawnVibrance * wd + this.params.dayVibrance * wday + this.params.duskVibrance * wdu + this.params.nightVibrance * wn;
        liftR = dawnLift.r * wd + dayLift.r * wday + duskLift.r * wdu + nightLift.r * wn;
        liftG = dawnLift.g * wd + dayLift.g * wday + duskLift.g * wdu + nightLift.g * wn;
        liftB = dawnLift.b * wd + dayLift.b * wday + duskLift.b * wdu + nightLift.b * wn;
        gammaR = dawnGamma.r * wd + dayGamma.r * wday + duskGamma.r * wdu + nightGamma.r * wn;
        gammaG = dawnGamma.g * wd + dayGamma.g * wday + duskGamma.g * wdu + nightGamma.g * wn;
        gammaB = dawnGamma.b * wd + dayGamma.b * wday + duskGamma.b * wdu + nightGamma.b * wn;
        gainR = dawnGain.r * wd + dayGain.r * wday + duskGain.r * wdu + nightGain.r * wn;
        gainG = dawnGain.g * wd + dayGain.g * wday + duskGain.g * wdu + nightGain.g * wn;
        gainB = dawnGain.b * wd + dayGain.b * wday + duskGain.b * wdu + nightGain.b * wn;
        masterGamma = this.params.dawnMasterGamma * wd + this.params.dayMasterGamma * wday + this.params.duskMasterGamma * wdu + this.params.nightMasterGamma * wn;
        vignetteStrength = this.params.dawnVignetteStrength * wd + this.params.dayVignetteStrength * wday + this.params.duskVignetteStrength * wdu + this.params.nightVignetteStrength * wn;
        vignetteSoftness = this.params.dawnVignetteSoftness * wd + this.params.dayVignetteSoftness * wday + this.params.duskVignetteSoftness * wdu + this.params.nightVignetteSoftness * wn;
        grainStrength = this.params.dawnGrainStrength * wd + this.params.dayGrainStrength * wday + this.params.duskGrainStrength * wdu + this.params.nightGrainStrength * wn;

        let wMax = wday;
        toneMapping = this.params.dayToneMapping;
        if (wd > wMax) { wMax = wd; toneMapping = this.params.dawnToneMapping; }
        if (wdu > wMax) { wMax = wdu; toneMapping = this.params.duskToneMapping; }
        if (wn > wMax) { wMax = wn; toneMapping = this.params.nightToneMapping; }
      }

      if (this.params.debugOverride) {
        // Manual override for core values (kept for compatibility)
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

      const u = this.material.uniforms;
      u.uTime.value = timeInfo.elapsed;
      u.uResolution.value.set(this.renderer?.domElement?.width ?? 1, this.renderer?.domElement?.height ?? 1);

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
      let effectiveIntensity = this.params.intensity;
      if (this.params.automationMode === 1 && this.params.autoIntensityEnabled) {
        const env = weatherController?.getEnvironment ? weatherController.getEnvironment() : null;
        const skyIntensity = clamp01(env?.skyIntensity ?? 1.0);
        const strength = clamp01(this.params.autoIntensityStrength);
        effectiveIntensity *= lerp(1.0, skyIntensity, strength);
      }

      u.uIntensity.value = effectiveIntensity;

      const cloudEffect = window.MapShine?.cloudEffect;
      const cloudTopTex = cloudEffect?.cloudTopTarget?.texture ?? null;
      if (cloudTopTex) {
        u.tCloudTop.value = cloudTopTex;
        u.uHasCloudTop.value = 1.0;
      } else {
        u.uHasCloudTop.value = 0.0;
      }

      const mm = window.MapShine?.maskManager;
      const outdoorsTex = mm ? mm.getTexture('outdoors.screen') : null;
      if (outdoorsTex) {
        u.tOutdoorsMask.value = outdoorsTex;
        u.uHasOutdoorsMask.value = 1.0;
      } else {
        const le = window.MapShine?.lightingEffect;
        if (le && le.outdoorsTarget) {
          u.tOutdoorsMask.value = le.outdoorsTarget.texture;
          u.uHasOutdoorsMask.value = 1.0;
        } else {
          u.uHasOutdoorsMask.value = 0.0;
        }
      }

      const roofTex = mm ? mm.getTexture('roofAlpha.screen') : null;
      if (roofTex) {
        u.tRoofAlpha.value = roofTex;
        u.uHasRoofAlpha.value = 1.0;
      } else {
        const le2 = window.MapShine?.lightingEffect;
        if (le2 && le2.roofAlphaTarget) {
          u.tRoofAlpha.value = le2.roofAlphaTarget.texture;
          u.uHasRoofAlpha.value = 1.0;
        } else {
          u.uHasRoofAlpha.value = 0.0;
        }
      }

      const ropeMaskTex = mm ? mm.getTexture('ropeMask.screen') : null;
      if (ropeMaskTex) {
        u.tRopeMask.value = ropeMaskTex;
        u.uHasRopeMask.value = 1.0;
      } else {
        const le3 = window.MapShine?.lightingEffect;
        if (le3 && le3.ropeMaskTarget) {
          u.tRopeMask.value = le3.ropeMaskTarget.texture;
          u.uHasRopeMask.value = 1.0;
        } else {
          u.uHasRopeMask.value = 0.0;
        }
      }

      const tokenMaskTex = mm ? mm.getTexture('tokenMask.screen') : null;
      if (tokenMaskTex) {
        u.tTokenMask.value = tokenMaskTex;
        u.uHasTokenMask.value = 1.0;
      } else {
        const le4 = window.MapShine?.lightingEffect;
        if (le4 && le4.tokenMaskTarget) {
          u.tTokenMask.value = le4.tokenMaskTarget.texture;
          u.uHasTokenMask.value = 1.0;
        } else {
          u.uHasTokenMask.value = 0.0;
        }
      }
    } catch (e) {
      if (Math.random() < 0.01) {
        log.warn('SkyColorEffect update failed', e);
      }
    }
  }

  render(renderer, scene, camera) {
    if (!this.material) return;

    const inputTexture = this.readBuffer ? this.readBuffer.texture : this.material.uniforms.tDiffuse.value;
    if (!inputTexture) return;

    this.material.uniforms.tDiffuse.value = inputTexture;

    const prevIntensity = this.material.uniforms?.uIntensity?.value;
    if (!this.enabled && this.material.uniforms?.uIntensity) {
      this.material.uniforms.uIntensity.value = 0.0;
    }

    if (this.writeBuffer) {
      renderer.setRenderTarget(this.writeBuffer);
      renderer.clear();
    } else {
      renderer.setRenderTarget(null);
    }

    renderer.render(this.quadScene, this.quadCamera);

    if (!this.enabled && this.material.uniforms?.uIntensity) {
      this.material.uniforms.uIntensity.value = prevIntensity;
    }
  }
}
