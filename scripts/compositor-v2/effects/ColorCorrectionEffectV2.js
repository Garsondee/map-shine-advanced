/**
 * @fileoverview ColorCorrectionEffectV2 — V2 screen-space color correction post-processing pass.
 *
 * Applies the final camera grade to the merged HDR scene:
 *   - Exposure (with dynamic exposure multiplier from DynamicExposureManager)
 *   - White balance (temperature + tint)
 *   - Brightness, contrast, saturation, vibrance
 *   - Lift/Gamma/Gain color grading
 *   - Optional tone mapping (ACES Filmic, Reinhard)
 *   - Vignette + film grain
 *
 * Runs after LevelCompositePass, AtmosphericFogEffectV2, and BloomEffectV2 in
 * {@link FloorCompositor}. This is the single HDR → LDR boundary. Outdoor
 * weather/golden-hour atmosphere ({@link SkyEnvironmentModel}) is applied here
 * on sky-eligible pixels after the time-of-day timeline and before tone mapping.
 *
 * Ported from V1 ColorCorrectionEffect with identical shader logic and defaults.
 *
 * @module compositor-v2/effects/ColorCorrectionEffectV2
 */

import { createLogger } from '../../core/log.js';
import { weatherController } from '../../core/WeatherController.js';
import { LightingDirector } from '../../core/LightingDirector.js';
import { migrateAtmosphereParams } from '../SkyEnvironmentModel.js';

const log = createLogger('ColorCorrectionEffectV2');

const TOD_ANCHOR_COUNT = 8;
/** Per-channel RGB multiply for timeline tints (1 = neutral). */
const TOD_TINT_MIN = 0;
const TOD_TINT_MAX = 3;
const TOD_TINT_NEUTRAL = 1;

const clamp = (value, min, max) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
};

const wrapHour24 = (hour) => {
  const n = Number(hour);
  const h = Number.isFinite(n) ? n : 0;
  return ((h % 24) + 24) % 24;
};

const smooth01 = (t) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

const lerp = (a, b, t) => a + (b - a) * t;

const lerpColor = (a, b, t) => ({
  r: lerp(Number(a?.r) || 0, Number(b?.r) || 0, t),
  g: lerp(Number(a?.g) || 0, Number(b?.g) || 0, t),
  b: lerp(Number(a?.b) || 0, Number(b?.b) || 0, t),
});

const makeTodGrade = (overrides = {}) => ({
  exposure: 0.0,
  saturation: 1.0,
  tintColor: { r: 1.0, g: 1.0, b: 1.0 },
  ...overrides,
});

const makeTodAnchor = (hour, global = {}, interior = {}) => ({
  hour,
  global: makeTodGrade(global),
  interior: makeTodGrade(interior),
});

/**
 * Default hour per anchor index (tod0..tod7).
 * Authored day/night camera timeline: cool noon, blue midnight, warm dawn/dusk bridges.
 */
const DEFAULT_TOD_ANCHORS = [
  makeTodAnchor(0, {
    exposure: -2,
    saturation: 1.05,
    tintColor: { r: 0, g: 0, b: 3 },
  }, {
    exposure: -1,
    saturation: 0.97,
    tintColor: { r: 0.55, g: 0.71, b: 2.29 },
  }),
  makeTodAnchor(3, {
    exposure: -2,
    saturation: 2,
    tintColor: { r: 0, g: 0, b: 3 },
  }, {
    exposure: -1,
    saturation: 0.98,
    tintColor: { r: 0.55, g: 0.71, b: 3 },
  }),
  makeTodAnchor(6, {
    exposure: -0.4,
    saturation: 2,
    tintColor: { r: 3, g: 1.3, b: 1 },
  }, {
    exposure: -3,
    saturation: 1,
    tintColor: { r: 1.82, g: 1.39, b: 1 },
  }),
  makeTodAnchor(9, {
    exposure: 0.9,
    saturation: 1,
    tintColor: { r: 1.2, g: 1.02, b: 1.06 },
  }, {
    exposure: -2,
    saturation: 1,
    tintColor: { r: 1, g: 1, b: 1 },
  }),
  makeTodAnchor(12, {
    exposure: 0.7,
    saturation: 1.2,
    tintColor: { r: 0.9, g: 0.9, b: 1.13 },
  }, {
    exposure: -1.75,
    saturation: 1,
    tintColor: { r: 1, g: 1, b: 1 },
  }),
  makeTodAnchor(15, {
    exposure: 0.9,
    saturation: 1.08,
    tintColor: { r: 1.15, g: 0.98, b: 1.04 },
  }, {
    exposure: -2.25,
    saturation: 1,
    tintColor: { r: 1, g: 1, b: 1 },
  }),
  makeTodAnchor(18, {
    exposure: -0.4,
    saturation: 2,
    tintColor: { r: 3, g: 1.36, b: 1 },
  }, {
    exposure: -3,
    saturation: 1,
    tintColor: { r: 1.82, g: 1.39, b: 1 },
  }),
  makeTodAnchor(21, {
    exposure: -2,
    saturation: 2,
    tintColor: { r: 0, g: 0, b: 3 },
  }, {
    exposure: -1,
    saturation: 1,
    tintColor: { r: 0.55, g: 0.71, b: 3 },
  }),
];

/** Baseline camera-grade params (HDR → LDR owner). Timeline on by default. */
const COLOR_CORRECTION_CORE_DEFAULTS = Object.freeze({
  exposure: 0.9,
  temperature: 0,
  tint: 0,
  brightness: 0,
  contrast: 1,
  saturation: 1,
  vibrance: 0,
  liftColor: { r: 0, g: 0, b: 0 },
  gammaColor: { r: 0.5, g: 0.5, b: 0.5 },
  gainColor: { r: 1, g: 1, b: 1 },
  masterGamma: 2,
  toneMapping: 0,
  vignetteStrength: 0,
  vignetteSoftness: 0,
  grainStrength: 0,
  todTimelineEnabled: true,
  localWarmLightPreserve: 1,
  localTodOverrideExposure: 1,
  localTodOverrideSaturation: 1,
  localWarmEmissiveAdd: 0.1,
});

/** Baseline camera-grade atmosphere defaults (neutral; atmosphere off by default). */
const COLOR_CORRECTION_ATMOSPHERE_DEFAULTS = Object.freeze({
  intensity: 1,
  saturationBoost: 0,
  vibranceBoost: 0,
  sunriseHour: 6,
  sunsetHour: 18,
  goldenHourWidth: 1.3,
  goldenStrength: 1,
  goldenPower: 1,
  nightFloor: 0,
  analyticStrength: 0.85,
  turbidity: 0.22,
  rayleighStrength: 0.63,
  mieStrength: 0.35,
  forwardScatter: 0.3,
  weatherInfluence: 0.67,
  cloudToTurbidity: 0.25,
  precipToTurbidity: 0.72,
  overcastDesaturate: 0,
  overcastContrastReduce: 0,
  tempWarmAtHorizon: 0,
  tempCoolAtNoon: 0,
  nightCoolBoost: 0,
  goldenSaturationBoost: 0,
  nightSaturationFloor: 0,
  hazeLift: 0,
  hazeContrastLoss: 0,
  autoIntensityEnabled: false,
  autoIntensityStrength: 1,
  goldenOutdoorRecolorStrength: 0,
  goldenOutdoorRecolorColor: { r: 1, g: 1, b: 1 },
  shadowGradePreserve: 0.35,
  calendarDarknessBlend: 1,
  dayNightGradePull: 1,
  nightExtraDarkness: 0,
});

/**
 * UI order and labels: noon → afternoon → dusk → night → midnight → pre-dawn → dawn → morning.
 * `index` is the persisted tod{N} slot; order is display-only.
 */
const TOD_ANCHOR_META = [
  { index: 4, label: 'Noon', clockHint: '12:00' },
  { index: 5, label: 'Afternoon', clockHint: '15:00' },
  { index: 6, label: 'Dusk', clockHint: '18:00' },
  { index: 7, label: 'Night', clockHint: '21:00' },
  { index: 0, label: 'Midnight', clockHint: '00:00' },
  { index: 1, label: 'Pre-dawn', clockHint: '03:00' },
  { index: 2, label: 'Dawn', clockHint: '06:00' },
  { index: 3, label: 'Morning', clockHint: '09:00' },
];

const todTintSliderKeys = (index, track) => ({
  r: `tod${index}${track}TintR`,
  g: `tod${index}${track}TintG`,
  b: `tod${index}${track}TintB`,
  color: `tod${index}${track}TintColor`,
});

const normalizeTintMultiplier = (value) => {
  if (value == null || typeof value !== 'object') {
    return { r: TOD_TINT_NEUTRAL, g: TOD_TINT_NEUTRAL, b: TOD_TINT_NEUTRAL };
  }
  let r = Number(value.r);
  let g = Number(value.g);
  let b = Number(value.b);
  if (!Number.isFinite(r)) r = TOD_TINT_NEUTRAL;
  if (!Number.isFinite(g)) g = TOD_TINT_NEUTRAL;
  if (!Number.isFinite(b)) b = TOD_TINT_NEUTRAL;

  const maxc = Math.max(r, g, b);
  // Legacy colour-picker saves (0–255) mistaken for multipliers.
  if (maxc > TOD_TINT_MAX && maxc <= 255) {
    r /= 255;
    g /= 255;
    b /= 255;
  }

  return {
    r: clamp(r, TOD_TINT_MIN, TOD_TINT_MAX),
    g: clamp(g, TOD_TINT_MIN, TOD_TINT_MAX),
    b: clamp(b, TOD_TINT_MIN, TOD_TINT_MAX),
  };
};

/** @param {*} value */
const isTimelineEnabledParam = (value) =>
  value !== false && value !== 0 && value !== '0' && value !== 'false';

const cloneTodAnchors = () => DEFAULT_TOD_ANCHORS.map((anchor) => ({
  hour: anchor.hour,
  global: {
    exposure: anchor.global.exposure,
    saturation: anchor.global.saturation,
    tintColor: { ...anchor.global.tintColor },
  },
  interior: {
    exposure: anchor.interior.exposure,
    saturation: anchor.interior.saturation,
    tintColor: { ...anchor.interior.tintColor },
  },
}));

export class ColorCorrectionEffectV2 {
  constructor() {
    /** @type {{ elapsed: number, delta: number }|null} */
    this._lastTimeInfo = null;
    /**
     * Last input RT handed to {@link render}. Used by {@link DynamicExposureManager}
     * to probe the pre-grade scene luminance via {@link getInputTexture}.
     * @type {THREE.WebGLRenderTarget|null}
     */
    this._lastInputRT = null;

    /** @type {boolean} */
    this._initialized = false;

    /** @type {boolean} Whether the last post-merge render wrote an output RT. */
    this._lastPostMergeWrote = false;
    /** @type {boolean} Whether the last post-merge render pushed an active ToD timeline. */
    this._lastPostMergeTodApplied = false;

    // Authored HDR → LDR camera grade; tone mapping off unless scene needs legacy linear.
    this.params = {
      enabled: true,

      // Dynamic Exposure (eye adaptation). Driven by DynamicExposureManager, not user-authored.
      dynamicExposure: 1.0,

      ...COLOR_CORRECTION_CORE_DEFAULTS,
      todAnchors: cloneTodAnchors(),

      // Outdoor atmosphere (weather / golden hour) — evaluated by SkyEnvironmentModel.
      atmosphereEnabled: false,
      ...COLOR_CORRECTION_ATMOSPHERE_DEFAULTS,
    };

    for (let i = 0; i < TOD_ANCHOR_COUNT; i++) {
      const anchor = DEFAULT_TOD_ANCHORS[i];
      this.params[`tod${i}Hour`] = anchor.hour;
      this.params[`tod${i}GlobalExposure`] = anchor.global.exposure;
      this.params[`tod${i}GlobalSaturation`] = anchor.global.saturation;
      const gTint = normalizeTintMultiplier(anchor.global.tintColor);
      this.params[`tod${i}GlobalTintR`] = gTint.r;
      this.params[`tod${i}GlobalTintG`] = gTint.g;
      this.params[`tod${i}GlobalTintB`] = gTint.b;
      this.params[`tod${i}GlobalTintColor`] = { ...gTint };
      this.params[`tod${i}InteriorExposure`] = anchor.interior.exposure;
      this.params[`tod${i}InteriorSaturation`] = anchor.interior.saturation;
      const iTint = normalizeTintMultiplier(anchor.interior.tintColor);
      this.params[`tod${i}InteriorTintR`] = iTint.r;
      this.params[`tod${i}InteriorTintG`] = iTint.g;
      this.params[`tod${i}InteriorTintB`] = iTint.b;
      this.params[`tod${i}InteriorTintColor`] = { ...iTint };
    }

    // ── GPU resources ───────────────────────────────────────────────────
    /** @type {THREE.Scene|null} */
    this._composeScene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._composeCamera = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._composeMaterial = null;
    /** @type {THREE.Mesh|null} */
    this._composeQuad = null;

    /** @type {THREE.DataTexture|null} */
    this._fallbackWhite = null;
    /** @type {THREE.DataTexture|null} */
    this._fallbackBlack = null;

    /** @type {import('../SkyEnvironmentModel.js').SkyEnvironmentState|null} */
    this._atmosphereState = null;
    /** @type {number} */
    this._combinedShadowEffectStrength = 1.0;
  }

  // ── UI schema (moved from V1 ColorCorrectionEffect) ──────────────────────

  static getControlSchema() {
    const timelineGroups = [];
    const timelineParams = {
      todTimelineEnabled: {
        type: 'boolean',
        default: COLOR_CORRECTION_CORE_DEFAULTS.todTimelineEnabled,
        label: 'Enable time-of-day timeline',
        tooltip: 'Blends eight clock anchors (global + interior grades) as Map Shine time advances. This is the camera-grade owner for visible time-of-day exposure.',
      },
      localWarmLightPreserve: {
        type: 'slider',
        label: 'Local ToD Override Strength',
        min: 0,
        max: 1,
        step: 0.01,
        default: COLOR_CORRECTION_CORE_DEFAULTS.localWarmLightPreserve,
        tooltip: 'Blends from the scene timeline grade toward a bright neutral local grade under gameplay lights (HDR light-buffer alpha). 0 = full midnight/global tint everywhere; 1 = full local override inside lit pools only.',
      },
      localTodOverrideExposure: {
        type: 'slider',
        label: 'Local Override Exposure',
        min: -2,
        max: 5,
        step: 0.05,
        default: COLOR_CORRECTION_CORE_DEFAULTS.localTodOverrideExposure,
        tooltip: 'Base exposure stops added inside local-light pools on top of the timeline grade. Stronger lights gain extra stops automatically — counters midnight darkness and blue tint.',
      },
      localTodOverrideSaturation: {
        type: 'slider',
        label: 'Local Override Saturation',
        min: 0.5,
        max: 2,
        step: 0.01,
        default: COLOR_CORRECTION_CORE_DEFAULTS.localTodOverrideSaturation,
        tooltip: 'Minimum saturation multiplier inside local-light pools when overriding toward neutral tint. Brighter pool cores push slightly higher.',
      },
      localWarmEmissiveAdd: {
        type: 'slider',
        label: 'Local Emissive Add',
        min: 0,
        max: 1.5,
        step: 0.01,
        default: COLOR_CORRECTION_CORE_DEFAULTS.localWarmEmissiveAdd,
        tooltip: 'Restores ToD grade loss on HDR flame cores (light-buffer core × emissive luminance). Does not touch normal map albedo — keeps scene-wide time-of-day tint visible.',
      },
    };

    const addTintMultiplierSliders = (index, track, channelDefaults, scopeLabel) => {
      const keys = todTintSliderKeys(index, track);
      const tintTooltip = `${scopeLabel} per-channel multiply (1 = neutral, 0–3). Not a 0–255 colour.`;
      for (const ch of ['R', 'G', 'B']) {
        const key = keys[ch.toLowerCase()];
        timelineParams[key] = {
          type: 'slider',
          label: `${scopeLabel} tint ${ch}`,
          min: TOD_TINT_MIN,
          max: TOD_TINT_MAX,
          step: 0.01,
          default: channelDefaults[ch.toLowerCase()],
          throttle: 50,
          tooltip: tintTooltip,
        };
      }
      return [keys.r, keys.g, keys.b];
    };

    for (const meta of TOD_ANCHOR_META) {
      const i = meta.index;
      const anchor = DEFAULT_TOD_ANCHORS[i];
      const sectionLabel = `${meta.label} (~${meta.clockHint})`;
      const globalTintKeys = addTintMultiplierSliders(
        i,
        'Global',
        anchor.global.tintColor,
        'Global'
      );
      const interiorTintKeys = addTintMultiplierSliders(
        i,
        'Interior',
        anchor.interior.tintColor,
        'Interior'
      );
      const params = [
        `tod${i}Hour`,
        `tod${i}GlobalExposure`,
        `tod${i}GlobalSaturation`,
        ...globalTintKeys,
        `tod${i}InteriorExposure`,
        `tod${i}InteriorSaturation`,
        ...interiorTintKeys,
      ];
      timelineGroups.push({
        name: `tod-anchor-${i}`,
        label: sectionLabel,
        type: 'folder',
        advanced: true,
        expanded: false,
        parameters: params,
      });
      timelineParams[`tod${i}Hour`] = {
        type: 'slider',
        label: 'Clock hour',
        min: 0,
        max: 24,
        step: 0.05,
        default: anchor.hour,
        throttle: 50,
        tooltip: `When the scene clock is near this anchor (${meta.clockHint} by default). Anchors blend smoothly around the 24h cycle, including across midnight.`,
      };
      timelineParams[`tod${i}GlobalExposure`] = {
        type: 'slider',
        label: 'Global exposure',
        min: -3,
        max: 3,
        step: 0.01,
        default: anchor.global.exposure,
        throttle: 50,
        tooltip: 'Exposure in stops for outdoor and as the base for indoor pixels. Keep within +/-1 for natural looks; +/-3 is extreme.',
      };
      timelineParams[`tod${i}GlobalSaturation`] = {
        type: 'slider',
        label: 'Global saturation',
        min: 0,
        max: 2,
        step: 0.01,
        default: anchor.global.saturation,
        throttle: 50,
        tooltip: 'Global saturation multiplier for this time anchor.',
      };
      timelineParams[`tod${i}InteriorExposure`] = {
        type: 'slider',
        label: 'Interior exposure offset',
        min: -3,
        max: 3,
        step: 0.01,
        default: anchor.interior.exposure,
        throttle: 50,
        tooltip: 'Extra exposure stops added to the global value on indoor pixels only. Use small positive values to keep interiors playable at night.',
      };
      timelineParams[`tod${i}InteriorSaturation`] = {
        type: 'slider',
        label: 'Interior saturation',
        min: 0,
        max: 2,
        step: 0.01,
        default: anchor.interior.saturation,
        throttle: 50,
        tooltip: 'Interior-only saturation multiplier for this time anchor.',
      };
    }

    return {
      enabled: true,
      help: {
        title: 'Camera Grade (HDR to LDR)',
        summary: [
          'Final camera grade after the HDR scene composite: exposure, white balance, basic adjustments, lift/gamma/gain, tone mapping, vignette, and film grain.',
          '**Dynamic exposure:** when token Dynamic Exposure is enabled, its multiplier is applied on top of the Exposure slider (`DynamicExposureManager` writes `params.dynamicExposure` each frame — not a Tweakpane control).',
          '**Persistence:** this effect supports **World Based** in the GM panel (shared across scenes) or per-scene storage when World Based is off.',
          'Fullscreen post; cost is modest (single pass).',
          '**Time-of-day timeline:** eight clock anchors each with global and interior exposure, saturation, and RGB tint multipliers (1 = neutral, 0–3 per channel); blends as scene time changes.',
          '**Outdoor atmosphere:** procedural weather/golden-hour offsets on sky-eligible outdoor pixels (after timeline, before tone map).',
          '**Local ToD override:** under gameplay lights (HDR light buffer), blends from the timeline grade toward a bright neutral local grade — cancels midnight tint/exposure in lit pools without a circular cutout.',
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
          label: 'Camera exposure & white balance',
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
          label: 'HDR tone map & LGG',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: ['toneMapping', 'liftColor', 'gammaColor', 'gainColor', 'masterGamma'],
        },
        {
          name: 'artistic',
          label: 'Vignette & grain',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: ['vignetteStrength', 'vignetteSoftness', 'grainStrength'],
        },
        {
          name: 'tod-timeline',
          label: 'Time-of-day camera timeline',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: ['todTimelineEnabled', 'localWarmLightPreserve', 'localTodOverrideExposure', 'localTodOverrideSaturation', 'localWarmEmissiveAdd'],
        },
        {
          name: 'outdoor-atmosphere',
          label: 'Outdoor atmosphere',
          type: 'folder',
          expanded: true,
          parameters: [
            'atmosphereEnabled',
            'intensity',
            'saturationBoost',
            'vibranceBoost',
            'shadowGradePreserve',
            'calendarDarknessBlend',
            'dayNightGradePull',
            'nightExtraDarkness',
            'autoIntensityEnabled',
            'autoIntensityStrength',
            'sunriseHour',
            'sunsetHour',
            'goldenHourWidth',
            'goldenStrength',
            'goldenPower',
            'goldenOutdoorRecolorStrength',
            'goldenOutdoorRecolorColor',
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
          ],
        },
        ...timelineGroups,
      ],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true },
        ...timelineParams,
        exposure: {
          type: 'slider',
          label: 'Exposure',
          min: 0.25,
          max: 2,
          step: 0.01,
          default: COLOR_CORRECTION_CORE_DEFAULTS.exposure,
          tooltip: 'Final camera exposure multiplier before tone mapping. Dynamic exposure multiplies this at runtime.',
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
          min: -0.25,
          max: 0.25,
          step: 0.01,
          default: 0.0,
          tooltip: 'Small constant offset after exposure and white balance. Prefer Exposure for physical brightness.',
        },
        contrast: {
          type: 'slider',
          label: 'Contrast',
          min: 0.5,
          max: 1.6,
          step: 0.01,
          default: 1.0,
          tooltip: 'Scales distance from 0.5 luma (1 = unchanged).',
        },
        saturation: {
          type: 'slider',
          label: 'Saturation',
          min: 0,
          max: 1.6,
          step: 0.01,
          default: 1,
          tooltip: '0 = grayscale, 1 ≈ natural, above 1 boosts color.',
        },
        vibrance: {
          type: 'slider',
          label: 'Vibrance',
          min: -1,
          max: 1,
          step: 0.01,
          default: 0,
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
          default: { ...COLOR_CORRECTION_CORE_DEFAULTS.gammaColor },
          tooltip: 'Per-channel gamma exponent (shader uses pow(rgb, 1/gamma); 1 = neutral).',
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
          max: 6,
          step: 0.01,
          default: COLOR_CORRECTION_CORE_DEFAULTS.masterGamma,
          tooltip: 'Overall gamma after lift/gamma/gain (1 = neutral).',
        },
        toneMapping: {
          type: 'list',
          label: 'Tone mapping',
          options: { 'None': 0, 'ACES Filmic': 1, 'Reinhard': 2 },
          default: 0,
          tooltip: 'HDR → LDR curve. With the Linear HDR pipeline (Lighting/Sky output unclamped linear values), ACES is recommended. "None" leaves the merged HDR scene unmapped, which clips highlights on display.',
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
          label: 'Vignette softness (reserved)',
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
        atmosphereEnabled: {
          type: 'boolean',
          default: false,
          label: 'Enable outdoor atmosphere',
          tooltip: 'Weather-aware golden hour / overcast offsets on sky-eligible outdoor pixels.',
        },
        intensity: {
          type: 'slider',
          min: 0,
          max: 1,
          step: 0.01,
          default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.intensity,
          label: 'Outdoor atmosphere strength',
          throttle: 50,
          tooltip: 'Blend of procedural outdoor atmosphere on sky-visible pixels. Also exported as environment strength for water and weather-aware lighting.',
        },
        saturationBoost: { type: 'slider', min: -0.5, max: 0.5, step: 0.01, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.saturationBoost, label: 'Sky color saturation', throttle: 50 },
        vibranceBoost: { type: 'slider', min: -0.5, max: 0.5, step: 0.01, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.vibranceBoost, label: 'Sky color vibrance', throttle: 50 },
        shadowGradePreserve: { type: 'slider', min: 0, max: 1, step: 0.01, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.shadowGradePreserve, label: 'Shadow preserve', throttle: 50, tooltip: 'Keeps shadowed outdoor pixels from full atmospheric recolor.' },
        sunriseHour: { type: 'slider', min: 0, max: 24, step: 0.05, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.sunriseHour, label: 'Sunrise', throttle: 50 },
        sunsetHour: { type: 'slider', min: 0, max: 24, step: 0.05, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.sunsetHour, label: 'Sunset', throttle: 50 },
        goldenHourWidth: { type: 'slider', min: 0.25, max: 6.0, step: 0.05, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.goldenHourWidth, label: 'Golden Width', throttle: 50 },
        goldenStrength: { type: 'slider', min: 0.0, max: 4.0, step: 0.01, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.goldenStrength, label: 'Golden Strength', throttle: 50 },
        goldenPower: { type: 'slider', min: 0.5, max: 3.0, step: 0.01, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.goldenPower, label: 'Golden Power', throttle: 50 },
        goldenOutdoorRecolorStrength: { type: 'slider', min: 0.0, max: 4.0, step: 0.05, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.goldenOutdoorRecolorStrength, label: 'Golden Recolor', throttle: 50 },
        goldenOutdoorRecolorColor: { type: 'color', default: { ...COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.goldenOutdoorRecolorColor }, label: 'Golden Recolor Color' },
        nightFloor: { type: 'slider', min: 0.0, max: 0.5, step: 0.01, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.nightFloor, label: 'Night Floor', throttle: 50 },
        analyticStrength: { type: 'slider', min: 0.0, max: 4.0, step: 0.01, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.analyticStrength, label: 'Analytic Strength', throttle: 50 },
        turbidity: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.turbidity, label: 'Turbidity', throttle: 50 },
        rayleighStrength: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.rayleighStrength, label: 'Rayleigh', throttle: 50 },
        mieStrength: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.mieStrength, label: 'Mie', throttle: 50 },
        forwardScatter: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.forwardScatter, label: 'Forward Scatter', throttle: 50 },
        weatherInfluence: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.weatherInfluence, label: 'Weather Influence', throttle: 50 },
        cloudToTurbidity: { type: 'slider', min: 0.0, max: 2.0, step: 0.01, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.cloudToTurbidity, label: 'Cloud→Turbidity', throttle: 50 },
        precipToTurbidity: { type: 'slider', min: 0.0, max: 2.0, step: 0.01, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.precipToTurbidity, label: 'Precip→Turbidity', throttle: 50 },
        overcastDesaturate: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.overcastDesaturate, label: 'Overcast Desat', throttle: 50 },
        overcastContrastReduce: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.overcastContrastReduce, label: 'Overcast Contrast', throttle: 50 },
        tempWarmAtHorizon: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.tempWarmAtHorizon, label: 'Warm Horizon', throttle: 50 },
        tempCoolAtNoon: { type: 'slider', min: -1.0, max: 0.0, step: 0.01, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.tempCoolAtNoon, label: 'Cool Noon', throttle: 50 },
        nightCoolBoost: { type: 'slider', min: -1.0, max: 0.0, step: 0.01, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.nightCoolBoost, label: 'Night Cool', throttle: 50 },
        goldenSaturationBoost: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.goldenSaturationBoost, label: 'Golden Sat', throttle: 50 },
        nightSaturationFloor: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.nightSaturationFloor, label: 'Night Sat Floor', throttle: 50 },
        hazeLift: { type: 'slider', min: 0.0, max: 0.5, step: 0.01, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.hazeLift, label: 'Haze Lift', throttle: 50 },
        hazeContrastLoss: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.hazeContrastLoss, label: 'Haze Contrast', throttle: 50 },
        autoIntensityEnabled: { type: 'boolean', default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.autoIntensityEnabled, label: 'Auto Intensity' },
        autoIntensityStrength: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.autoIntensityStrength, label: 'Auto Strength', throttle: 50 },
        calendarDarknessBlend: { type: 'slider', min: 0, max: 1, step: 0.05, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.calendarDarknessBlend, label: 'Master darkness blend', throttle: 50 },
        dayNightGradePull: { type: 'slider', min: 0, max: 2.5, step: 0.05, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.dayNightGradePull, label: 'Day/night color separation', throttle: 50 },
        nightExtraDarkness: { type: 'slider', min: 0, max: 0.45, step: 0.01, default: COLOR_CORRECTION_ATMOSPHERE_DEFAULTS.nightExtraDarkness, label: 'Night color depth', throttle: 50 },
      },
      presets: {
        'Clear Noon': {
          toneMapping: 1,
          exposure: 0.95,
          temperature: 0.02,
          contrast: 1.04,
          saturation: 1.02,
          vibrance: -0.05,
          intensity: 0.9,
          weatherInfluence: 0.45,
          goldenOutdoorRecolorStrength: 1.4,
          overcastDesaturate: 0.22,
          overcastContrastReduce: 0.28,
        },
        'Golden Hour': {
          toneMapping: 1,
          exposure: 0.92,
          temperature: 0.18,
          contrast: 1.02,
          saturation: 1.06,
          vibrance: 0.05,
          vignetteStrength: 0.08,
          intensity: 0.82,
          goldenStrength: 3.2,
          goldenOutdoorRecolorStrength: 2.8,
          goldenSaturationBoost: 0.28,
          tempWarmAtHorizon: 0.95,
          weatherInfluence: 0.55,
        },
        'Overcast Day': {
          toneMapping: 1,
          exposure: 0.88,
          temperature: -0.08,
          contrast: 0.94,
          saturation: 0.88,
          vibrance: -0.1,
          intensity: 0.68,
          weatherInfluence: 0.85,
          overcastDesaturate: 0.42,
          overcastContrastReduce: 0.48,
          tempCoolAtNoon: -0.55,
          hazeLift: 0.12,
        },
        Storm: {
          toneMapping: 1,
          exposure: 0.8,
          temperature: -0.18,
          contrast: 0.9,
          saturation: 0.78,
          vibrance: -0.18,
          vignetteStrength: 0.12,
          intensity: 0.55,
          weatherInfluence: 1.0,
          cloudToTurbidity: 0.45,
          precipToTurbidity: 0.85,
          overcastDesaturate: 0.5,
          overcastContrastReduce: 0.58,
          nightExtraDarkness: 0.06,
        },
        'Moonlit Night': {
          toneMapping: 1,
          exposure: 0.72,
          temperature: -0.28,
          contrast: 1.08,
          saturation: 0.62,
          vibrance: -0.2,
          vignetteStrength: 0.16,
          intensity: 0.42,
          nightCoolBoost: -0.45,
          nightSaturationFloor: 0.25,
          nightExtraDarkness: 0.04,
        },
        'Interior Night': {
          toneMapping: 1,
          exposure: 0.82,
          temperature: -0.12,
          contrast: 1.02,
          saturation: 0.72,
          vibrance: -0.1,
          vignetteStrength: 0.08,
          todTimelineEnabled: true,
          tod0InteriorExposure: 0.35,
          tod7InteriorExposure: 0.25,
          tod0InteriorSaturation: 0.95,
          tod7InteriorSaturation: 0.95,
          intensity: 0.35,
          nightCoolBoost: -0.35,
          nightSaturationFloor: 0.3,
          nightExtraDarkness: 0.03,
        },
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

    this._ensureFallbackTextures();

    this._composeScene = new THREE.Scene();
    this._composeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._composeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse:         { value: null },
        tOutdoorsMask:    { value: this._fallbackWhite },
        uTime:            { value: 0.0 },
        uResolution:      { value: new THREE.Vector2(1, 1) },
        uHasOutdoorsMask: { value: 0.0 },
        uOutdoorsMaskFlipY: { value: 0.0 },
        uViewBoundsMin:   { value: new THREE.Vector2(0, 0) },
        uViewBoundsMax:   { value: new THREE.Vector2(1, 1) },
        uSceneBounds:     { value: new THREE.Vector4(0, 0, 1, 1) },

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

        uTodEnabled: { value: 0.0 },
        uTodGlobalExposure: { value: 0.0 },
        uTodGlobalSaturation: { value: 1.0 },
        uTodGlobalTintColor: { value: new THREE.Vector3(1, 1, 1) },
        uTodInteriorExposure: { value: 0.0 },
        uTodInteriorSaturation: { value: 1.0 },
        uTodInteriorTintColor: { value: new THREE.Vector3(1, 1, 1) },

        uLocalEmissiveAdd: { value: 0.55 },
        uLocalOverrideStrength: { value: 1.0 },
        uLocalOverrideExposureOffset: { value: 2.75 },
        uLocalOverrideSaturationMin: { value: 1.25 },
        tLocalLightBuffer: { value: null },
        uHasLocalLightBuffer: { value: 0.0 },
        uLocalLightAlphaBaseline: { value: 0.0 },
        uLocalLightTexelSize: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
        uGradeEnabled: { value: 1.0 },

        uAtmosphereEnabled: { value: 1.0 },
        uAtmosphereStrength: { value: 1.0 },
        uAtmosphereExposure: { value: 0.0 },
        uAtmosphereSaturation: { value: 1.0 },
        uAtmosphereContrast: { value: 1.0 },
        uAtmosphereTintColor: { value: new THREE.Vector3(1, 1, 1) },
        uGoldenRecolorStrength: { value: 0.0 },
        uGoldenRecolorColor: { value: new THREE.Vector3(1.35, 0.80, 0.50) },
        uShadowGradePreserve: { value: 0.35 },
        uCombinedShadowEffectStrength: { value: 1.0 },

        tSkyReachMask: { value: this._fallbackWhite },
        tSkyOcclusion: { value: this._fallbackWhite },
        tCombinedShadow: { value: this._fallbackWhite },
        uHasSkyReachMask: { value: 0.0 },
        uHasSkyOcclusion: { value: 0.0 },
        uHasCombinedShadow: { value: 0.0 },
        uSkyReachMaskFlipY: { value: 0.0 },
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
        uniform vec2 uResolution;
        uniform float uTime;
        uniform float uHasOutdoorsMask;
        uniform float uOutdoorsMaskFlipY;
        uniform vec2 uViewBoundsMin;
        uniform vec2 uViewBoundsMax;
        uniform vec4 uSceneBounds;

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

        uniform float uTodEnabled;
        uniform float uTodGlobalExposure;
        uniform float uTodGlobalSaturation;
        uniform vec3 uTodGlobalTintColor;
        uniform float uTodInteriorExposure;
        uniform float uTodInteriorSaturation;
        uniform vec3 uTodInteriorTintColor;

        uniform float uLocalEmissiveAdd;
        uniform float uLocalOverrideStrength;
        uniform float uLocalOverrideExposureOffset;
        uniform float uLocalOverrideSaturationMin;
        uniform sampler2D tLocalLightBuffer;
        uniform float uHasLocalLightBuffer;
        uniform float uLocalLightAlphaBaseline;
        uniform vec2 uLocalLightTexelSize;
        uniform float uGradeEnabled;

        uniform float uAtmosphereEnabled;
        uniform float uAtmosphereStrength;
        uniform float uAtmosphereExposure;
        uniform float uAtmosphereSaturation;
        uniform float uAtmosphereContrast;
        uniform vec3 uAtmosphereTintColor;
        uniform float uGoldenRecolorStrength;
        uniform vec3 uGoldenRecolorColor;
        uniform float uShadowGradePreserve;
        uniform float uCombinedShadowEffectStrength;

        uniform sampler2D tSkyReachMask;
        uniform sampler2D tSkyOcclusion;
        uniform sampler2D tCombinedShadow;
        uniform float uHasSkyReachMask;
        uniform float uHasSkyOcclusion;
        uniform float uHasCombinedShadow;
        uniform float uSkyReachMaskFlipY;

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

        float decodeOutdoorsMaskSample(vec4 od) {
          float outdoorRaw = clamp(max(od.r, max(od.g, od.b)), 0.0, 1.0);
          float outdoorMid = smoothstep(0.18, 0.82, outdoorRaw);
          float outdoorClass = (outdoorRaw <= 0.10) ? 0.0 : ((outdoorRaw >= 0.90) ? 1.0 : outdoorMid);
          float outdoorsAlphaValid = step(0.5, clamp(od.a, 0.0, 1.0));
          return mix(1.0, outdoorClass, outdoorsAlphaValid);
        }

        float sampleIndoorWeight(vec2 screenUv) {
          if (uHasOutdoorsMask < 0.5) return 0.0;
          vec2 worldXY = mix(uViewBoundsMin, uViewBoundsMax, screenUv);
          vec2 sceneUvRaw = vec2(
            (worldXY.x - uSceneBounds.x) / max(1e-5, uSceneBounds.z),
            1.0 - ((worldXY.y - uSceneBounds.y) / max(1e-5, uSceneBounds.w))
          );
          float inScene =
            step(0.0, sceneUvRaw.x) * step(sceneUvRaw.x, 1.0) *
            step(0.0, sceneUvRaw.y) * step(sceneUvRaw.y, 1.0);
          vec2 sceneUv = sceneUvRaw;
          if (uOutdoorsMaskFlipY > 0.5) sceneUv.y = 1.0 - sceneUv.y;
          sceneUv = clamp(sceneUv, vec2(0.0), vec2(1.0));

          // Canonical outdoors decode (matches Lighting/Water/Fog paths).
          vec4 od = texture2D(tOutdoorsMask, sceneUv);
          float outdoorStrength = decodeOutdoorsMaskSample(od);
          float indoorSignal = clamp(1.0 - outdoorStrength, 0.0, 1.0);
          return mix(0.0, smoothstep(0.20, 0.75, indoorSignal), inScene);
        }

        vec2 sceneUvFromScreen(vec2 screenUv) {
          vec2 worldXY = mix(uViewBoundsMin, uViewBoundsMax, screenUv);
          return vec2(
            (worldXY.x - uSceneBounds.x) / max(1e-5, uSceneBounds.z),
            1.0 - ((worldXY.y - uSceneBounds.y) / max(1e-5, uSceneBounds.w))
          );
        }

        float sampleSkyReachAt(vec2 sceneUvRaw) {
          if (uHasSkyReachMask < 0.5) return 1.0;
          vec2 sceneUv = sceneUvRaw;
          if (uSkyReachMaskFlipY > 0.5) sceneUv.y = 1.0 - sceneUv.y;
          sceneUv = clamp(sceneUv, vec2(0.0), vec2(1.0));
          vec4 sr = texture2D(tSkyReachMask, sceneUv);
          return mix(1.0, clamp(sr.r, 0.0, 1.0), clamp(sr.a, 0.0, 1.0));
        }

        float sampleSkyOcclusionAt(vec2 sceneUvRaw, float inScene) {
          if (uHasSkyOcclusion < 0.5) return 1.0;
          vec2 sceneUv = clamp(sceneUvRaw, vec2(0.0), vec2(1.0));
          return mix(1.0, clamp(texture2D(tSkyOcclusion, sceneUv).r, 0.0, 1.0), inScene);
        }

        float amplifyCombinedShadowLit(float lit01, float strength) {
          float s = max(strength, 1.0);
          float dark = 1.0 - clamp(lit01, 0.0, 1.0);
          return 1.0 - min(1.0, dark * s);
        }

        float sampleOutdoorAtmosphereWeight(vec2 screenUv) {
          if (uHasOutdoorsMask < 0.5) return 1.0;
          vec2 sceneUvRaw = sceneUvFromScreen(screenUv);
          float inScene =
            step(0.0, sceneUvRaw.x) * step(sceneUvRaw.x, 1.0) *
            step(0.0, sceneUvRaw.y) * step(sceneUvRaw.y, 1.0);
          vec2 sceneUv = sceneUvRaw;
          if (uOutdoorsMaskFlipY > 0.5) sceneUv.y = 1.0 - sceneUv.y;
          sceneUv = clamp(sceneUv, vec2(0.0), vec2(1.0));
          vec4 od = texture2D(tOutdoorsMask, sceneUv);
          float outdoorStrength = decodeOutdoorsMaskSample(od);
          float outdoorVis = mix(1.0, outdoorStrength, inScene);
          float skyReach = sampleSkyReachAt(sceneUvRaw);
          float skyOcc = sampleSkyOcclusionAt(sceneUvRaw, inScene);
          return clamp(outdoorVis * skyReach * skyOcc, 0.0, 1.0);
        }

        float sampleAtmosphereShadowDamp(vec2 screenUv) {
          if (uHasCombinedShadow < 0.5) return 1.0;
          float combinedShadowR = clamp(texture2D(tCombinedShadow, screenUv).r, 0.0, 1.0);
          combinedShadowR = amplifyCombinedShadowLit(combinedShadowR, uCombinedShadowEffectStrength);
          float gradeBlend = smoothstep(0.74, 1.0, combinedShadowR);
          return mix(clamp(uShadowGradePreserve, 0.0, 1.0), 1.0, gradeBlend);
        }

        vec3 applyTimelineGrade(vec3 inputColor, float exposureStops, float saturationMul, vec3 tintColor) {
          vec3 graded = inputColor * exp2(clamp(exposureStops, -10.0, 10.0));
          graded *= clamp(tintColor, vec3(0.0), vec3(10.0));

          float luma = dot(graded, vec3(0.2126, 0.7152, 0.0722));
          graded = mix(vec3(luma), graded, clamp(saturationMul, 0.0, 4.0));
          return graded;
        }

        // True HDR emissive art in the merged composite (flame sprites, etc.).
        float sampleSceneEmissiveWeight(vec3 hdrColor) {
          float mx = max(max(hdrColor.r, hdrColor.g), hdrColor.b);
          if (mx < 1.6) return 0.0;
          float sat = mx - min(min(hdrColor.r, hdrColor.g), hdrColor.b);
          return smoothstep(1.6, 3.5, mx) * smoothstep(0.18, 0.55, sat);
        }

        // Scalar punch from _lightRT alpha (cleared to 0; additive compose, no 1.0 baseline).
        float sampleLightBufferAlphaAt(vec2 uv) {
          if (uHasLocalLightBuffer < 0.5) return 0.0;
          vec4 L = texture2D(tLocalLightBuffer, uv);
          return max(L.a - uLocalLightAlphaBaseline, 0.0);
        }

        float sampleBlurredLightAlpha(vec2 uv, float blurScale) {
          // Wide multi-scale gather for CC influence only — soft ToD-cancel rims must
          // extend well beyond the geometric light-buffer edge (avoid perfect circles).
          vec2 t = uLocalLightTexelSize * max(blurScale, 1.0);
          float s = sampleLightBufferAlphaAt(uv) * 0.14;
          s += sampleLightBufferAlphaAt(uv + t * vec2( 1.0,  0.0)) * 0.07;
          s += sampleLightBufferAlphaAt(uv + t * vec2(-1.0,  0.0)) * 0.07;
          s += sampleLightBufferAlphaAt(uv + t * vec2( 0.0,  1.0)) * 0.07;
          s += sampleLightBufferAlphaAt(uv + t * vec2( 0.0, -1.0)) * 0.07;
          vec2 t6 = t * 6.0;
          s += sampleLightBufferAlphaAt(uv + t6 * vec2( 0.707,  0.707)) * 0.045;
          s += sampleLightBufferAlphaAt(uv + t6 * vec2(-0.707,  0.707)) * 0.045;
          s += sampleLightBufferAlphaAt(uv + t6 * vec2( 0.707, -0.707)) * 0.045;
          s += sampleLightBufferAlphaAt(uv + t6 * vec2(-0.707, -0.707)) * 0.045;
          vec2 t14 = t * 14.0;
          s += sampleLightBufferAlphaAt(uv + t14 * vec2( 1.0,  0.0)) * 0.035;
          s += sampleLightBufferAlphaAt(uv + t14 * vec2(-1.0,  0.0)) * 0.035;
          s += sampleLightBufferAlphaAt(uv + t14 * vec2( 0.0,  1.0)) * 0.035;
          s += sampleLightBufferAlphaAt(uv + t14 * vec2( 0.0, -1.0)) * 0.035;
          vec2 t28 = t * 28.0;
          s += sampleLightBufferAlphaAt(uv + t28 * vec2( 0.707,  0.707)) * 0.028;
          s += sampleLightBufferAlphaAt(uv + t28 * vec2(-0.707,  0.707)) * 0.028;
          s += sampleLightBufferAlphaAt(uv + t28 * vec2( 0.707, -0.707)) * 0.028;
          s += sampleLightBufferAlphaAt(uv + t28 * vec2(-0.707, -0.707)) * 0.028;
          vec2 t56 = t * 56.0;
          s += sampleLightBufferAlphaAt(uv + t56 * vec2( 1.0,  0.0)) * 0.018;
          s += sampleLightBufferAlphaAt(uv + t56 * vec2(-1.0,  0.0)) * 0.018;
          s += sampleLightBufferAlphaAt(uv + t56 * vec2( 0.0,  1.0)) * 0.018;
          s += sampleLightBufferAlphaAt(uv + t56 * vec2( 0.0, -1.0)) * 0.018;
          return s;
        }

        float localInfluenceFromBlur(float illumCenter, float illumBlur, float outdoorW) {
          // No hard zero outside the buffer rim — follow the wide blur envelope only.
          // Outdoors: lower thresholds + gentler curve so campfires shed global midnight tint.
          float presenceLo = mix(0.0015, 0.0008, outdoorW);
          float presenceHi = mix(0.028, 0.016, outdoorW);
          float envLo = mix(0.003, 0.0012, outdoorW);
          float envHi = mix(0.92, 0.96, outdoorW);
          float presence = smoothstep(
            presenceLo,
            presenceHi,
            max(illumCenter, illumBlur * mix(0.12, 0.20, outdoorW))
          );
          float envelope = smoothstep(envLo, envHi, illumBlur);
          return presence * pow(envelope, mix(0.92, 0.82, outdoorW));
        }

        float sampleLocalInfluence(vec2 uv, float outdoorW) {
          if (uHasLocalLightBuffer < 0.5) return 0.0;
          float blurScale = mix(1.0, 1.85, clamp(outdoorW, 0.0, 1.0));
          float illumCenter = sampleLightBufferAlphaAt(uv);
          float illumBlur = sampleBlurredLightAlpha(uv, blurScale);
          return localInfluenceFromBlur(illumCenter, illumBlur, outdoorW);
        }

        void main() {
          vec4 texel = texture2D(tDiffuse, vUv);
          if (uGradeEnabled < 0.5) {
            gl_FragColor = vec4(texel.rgb, texel.a);
            return;
          }
          vec3 color = texel.rgb;

          // Phase 2: ColorCorrectionEffectV2 is the sole grade owner and runs once
          // on the merged HDR composite, so the legacy timeline-only early-out
          // (uTimelineOnly) is gone. The full pipeline below — exposure, WB,
          // brightness, LGG, ToD timeline, tone map, vignette, grain — is the
          // HDR → LDR boundary.

          // 1. Exposure (with dynamic eye adaptation multiplier)
          color *= (uExposure * max(uDynamicExposure, 0.0));

          // 2. White Balance (same path for all pixels — tint skip happens in ToD only)
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

          // Snapshot before ToD — used to restore emissive art without undoing the grade.
          vec3 preTodColor = color;

          // 5. Time-of-day CC timeline (before tone mapping so exposure stops stay strong).
          // Global grade everywhere; interior uses global + interior exposure in stops,
          // with separate interior saturation/tint, blended by _Outdoors mask.
          if (uTodEnabled > 0.5) {
            float indoorW = clamp(sampleIndoorWeight(vUv), 0.0, 1.0);
            float outdoorW = 1.0 - indoorW;

            vec3 globalSceneGrade = applyTimelineGrade(
              color,
              uTodGlobalExposure,
              uTodGlobalSaturation,
              uTodGlobalTintColor
            );
            float interiorExposureTotal = uTodGlobalExposure + uTodInteriorExposure;
            vec3 interiorSceneGrade = applyTimelineGrade(
              color,
              interiorExposureTotal,
              uTodInteriorSaturation,
              uTodInteriorTintColor
            );
            vec3 sceneGrade = mix(globalSceneGrade, interiorSceneGrade, indoorW);

            float lightPunch = 0.0;
            float localInfluence = 0.0;
            if (uHasLocalLightBuffer > 0.5) {
              float illumCenter = sampleLightBufferAlphaAt(vUv);
              float blurScale = mix(1.0, 1.85, outdoorW);
              lightPunch = sampleBlurredLightAlpha(vUv, blurScale);
              localInfluence = localInfluenceFromBlur(illumCenter, lightPunch, outdoorW)
                * clamp(uLocalOverrideStrength, 0.0, 1.0);
              // Outdoors: stronger cancel of global midnight tint under campfires/torches.
              localInfluence = min(1.0, localInfluence * mix(1.0, 1.38, outdoorW));
            }

            // Stronger lights pull harder toward neutral HDR (extra stops scale with punch).
            float punchNorm = smoothstep(0.06, 0.72, lightPunch);
            float expBoost = uLocalOverrideExposureOffset + punchNorm * 2.35;
            // Keep exposure boost under the blurred influence rim (low rimFloor caused dark halos around lamps).
            expBoost *= mix(0.92, 1.0, pow(clamp(localInfluence, 0.0, 1.0), 1.1));
            float localGlobalExp = uTodGlobalExposure + expBoost;
            float localInteriorExp = interiorExposureTotal + expBoost;
            float satFloor = uLocalOverrideSaturationMin + punchNorm * 0.42;
            float localGlobalSat = max(uTodGlobalSaturation, satFloor);
            float localInteriorSat = max(uTodInteriorSaturation, satFloor);

            vec3 localGlobalGrade = applyTimelineGrade(
              color,
              localGlobalExp,
              localGlobalSat,
              vec3(1.0)
            );
            vec3 localInteriorGrade = applyTimelineGrade(
              color,
              localInteriorExp,
              localInteriorSat,
              vec3(1.0)
            );
            vec3 localGrade = mix(localGlobalGrade, localInteriorGrade, indoorW);

            // Smooth grade blend — avoid pow<1 disks that read as perfect circles at pool edges.
            float blendRaw = clamp(localInfluence, 0.0, 1.0);
            float blendW = blendRaw * blendRaw * (3.0 - 2.0 * blendRaw);
            color = mix(sceneGrade, localGrade, blendW);
          }

          // 5b. Outdoor atmosphere (weather / golden hour) on sky-eligible pixels.
          if (uAtmosphereEnabled > 0.5 && uAtmosphereStrength > 0.0001) {
            float skyEligible = sampleOutdoorAtmosphereWeight(vUv);
            float shadowDamp = sampleAtmosphereShadowDamp(vUv);
            float atmWeight = clamp(uAtmosphereStrength * skyEligible * shadowDamp, 0.0, 1.0);
            if (atmWeight > 0.0001) {
              vec3 atmGrade = applyTimelineGrade(
                color,
                uAtmosphereExposure,
                uAtmosphereSaturation,
                uAtmosphereTintColor
              );
              if (abs(uAtmosphereContrast - 1.0) > 0.0001) {
                atmGrade = (atmGrade - 0.5) * uAtmosphereContrast + 0.5;
              }
              if (uGoldenRecolorStrength > 0.0001) {
                float recolorAmt = clamp(uGoldenRecolorStrength * atmWeight, 0.0, 1.0);
                vec3 warmShift = atmGrade * uGoldenRecolorColor;
                atmGrade = mix(atmGrade, warmShift, recolorAmt);
              }
              color = mix(color, atmGrade, atmWeight);
            }
          }

          // Restore exposure loss on HDR emissive art without undoing preserved hue.
          float emissiveW = sampleSceneEmissiveWeight(preTodColor);
          float emissiveRestore = emissiveW * max(uLocalEmissiveAdd, 0.0);
          if (emissiveRestore > 0.0001) {
            float preLuma = dot(preTodColor, vec3(0.2126, 0.7152, 0.0722));
            float postLuma = dot(color, vec3(0.2126, 0.7152, 0.0722));
            float lumaLoss = max(0.0, preLuma - postLuma);
            vec3 dir = color / max(postLuma, 1e-5);
            color += dir * lumaLoss * emissiveRestore;
          }

          // 6. Tone Mapping
          if (uToneMapping == 1) {
            color = ACESFilmicToneMapping(color);
          } else if (uToneMapping == 2) {
            color = ReinhardToneMapping(color);
          }

          // 7. Vignette
          vec2 dist = (vUv - 0.5) * 2.0;
          float len = length(dist);
          if (uVignetteStrength > 0.0) {
            color *= mix(1.0, smoothstep(1.5, 0.5, len), uVignetteStrength);
          }

          // 8. Film Grain
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

  /** @private */
  _ensureFallbackTextures() {
    const THREE = window.THREE;
    if (!THREE) return;
    if (!this._fallbackWhite) {
      const white = new Uint8Array([255, 255, 255, 255]);
      this._fallbackWhite = new THREE.DataTexture(white, 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
      this._fallbackWhite.needsUpdate = true;
      this._fallbackWhite.flipY = false;
      this._fallbackWhite.generateMipmaps = false;
      this._fallbackWhite.minFilter = THREE.NearestFilter;
      this._fallbackWhite.magFilter = THREE.NearestFilter;
    }
    if (!this._fallbackBlack) {
      const black = new Uint8Array([0, 0, 0, 0]);
      this._fallbackBlack = new THREE.DataTexture(black, 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
      this._fallbackBlack.needsUpdate = true;
      this._fallbackBlack.flipY = false;
      this._fallbackBlack.generateMipmaps = false;
      this._fallbackBlack.minFilter = THREE.NearestFilter;
      this._fallbackBlack.magFilter = THREE.NearestFilter;
    }
  }

  /**
   * Feed the active-floor outdoors mask for interior-only timeline grading.
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
   * Stacked or per-floor skyReach mask for outdoor atmosphere gating.
   * @param {THREE.Texture|null} skyReachTex
   */
  setSkyReachMask(skyReachTex) {
    const u = this._composeMaterial?.uniforms;
    if (!u) return;
    u.tSkyReachMask.value = skyReachTex ?? this._fallbackWhite;
    u.uHasSkyReachMask.value = skyReachTex ? 1.0 : 0.0;
    u.uSkyReachMaskFlipY.value = skyReachTex?.flipY ? 1.0 : 0.0;
  }

  /** @param {THREE.Texture|null} texture */
  setSkyOcclusionTexture(texture) {
    const u = this._composeMaterial?.uniforms;
    if (!u) return;
    u.tSkyOcclusion.value = texture ?? this._fallbackWhite;
    u.uHasSkyOcclusion.value = texture ? 1.0 : 0.0;
  }

  /** @param {THREE.Texture|null} texture */
  setCombinedShadowTexture(texture) {
    const u = this._composeMaterial?.uniforms;
    if (!u) return;
    u.tCombinedShadow.value = texture ?? this._fallbackWhite;
    u.uHasCombinedShadow.value = texture ? 1.0 : 0.0;
  }

  /** @param {number} strength */
  setCombinedShadowEffectStrength(strength) {
    this._combinedShadowEffectStrength = strength;
    const u = this._composeMaterial?.uniforms;
    if (!u?.uCombinedShadowEffectStrength) return;
    const s = Number(strength);
    u.uCombinedShadowEffectStrength.value = Number.isFinite(s) ? Math.max(1.0, Math.min(10.0, s)) : 1.0;
  }

  /**
   * Push evaluated sky environment state from {@link SkyEnvironmentModel}.
   * @param {import('../SkyEnvironmentModel.js').SkyEnvironmentState|null} state
   */
  setAtmosphereState(state) {
    this._atmosphereState = state;
    this._pushAtmosphereUniforms();
  }

  /**
   * Migrate legacy Sky Color params into Camera Grade on first init.
   * @param {Record<string, *>|null} legacySkyParams
   */
  migrateAtmosphereFromSky(legacySkyParams) {
    if (legacySkyParams) migrateAtmosphereParams(this.params, legacySkyParams);
  }

  /** @private */
  _pushAtmosphereUniforms() {
    const u = this._composeMaterial?.uniforms;
    if (!u) return;

    const p = this.params;
    const enabled = p.atmosphereEnabled !== false && p.enabled !== false;
    u.uAtmosphereEnabled.value = enabled ? 1.0 : 0.0;

    const grade = this._atmosphereState?.atmosphereGrade;
    if (!enabled || !grade) {
      u.uAtmosphereStrength.value = 0.0;
      return;
    }

    u.uAtmosphereStrength.value = Math.max(0, Math.min(1, Number(grade.strength) || 0));
    u.uAtmosphereExposure.value = Number(grade.exposureStops) || 0;
    u.uAtmosphereSaturation.value = Math.max(0, Math.min(4, Number(grade.saturationMul) || 1));
    u.uAtmosphereContrast.value = Math.max(0.5, Math.min(1.5, Number(grade.contrastMul) || 1));
    u.uAtmosphereTintColor.value.set(
      grade.tintMul?.r ?? 1,
      grade.tintMul?.g ?? 1,
      grade.tintMul?.b ?? 1,
    );
    u.uGoldenRecolorStrength.value = Math.max(0, Number(grade.goldenRecolorStrength) || 0);
    u.uGoldenRecolorColor.value.set(
      grade.goldenRecolorColor?.r ?? 1.35,
      grade.goldenRecolorColor?.g ?? 0.80,
      grade.goldenRecolorColor?.b ?? 0.50,
    );
    u.uShadowGradePreserve.value = Math.max(0, Math.min(1, Number(grade.shadowGradePreserve) ?? 0.35));
    u.uCombinedShadowEffectStrength.value = Math.max(1, Math.min(10, Number(this._combinedShadowEffectStrength) || 1));
  }

  /**
   * HDR light buffer from {@link LightingEffectV2} — stacked gameplay-light alpha for
   * local ToD override (torches, lamps, fire/candle glow).
   * @param {THREE.Texture|null} lightTex
   * @param {number} [alphaBaseline=1] - Subtract from alpha (1 for raw _lightRT, 0 for stacked normalize)
   */
  setLocalLightTexture(lightTex, alphaBaseline = 1.0) {
    const u = this._composeMaterial?.uniforms;
    if (!u) return;
    u.tLocalLightBuffer.value = lightTex ?? this._fallbackWhite;
    u.uHasLocalLightBuffer.value = lightTex ? 1.0 : 0.0;
    u.uLocalLightAlphaBaseline.value = lightTex
      ? Math.max(0.0, Number(alphaBaseline) || 0.0)
      : 1.0;
    const tw = Math.max(1, lightTex?.image?.width ?? 1024);
    const th = Math.max(1, lightTex?.image?.height ?? 1024);
    u.uLocalLightTexelSize.value.set(1 / tw, 1 / th);
  }

  /**
   * The most recent input render target's texture, i.e. the pre-CC scene.
   *
   * After the Linear HDR refactor (Phase 2), CC runs once on the merged
   * composite, so this is the post-Bloom HDR scene — the correct probe
   * source for {@link DynamicExposureManager} eye adaptation.
   *
   * @returns {THREE.Texture|null}
   */
  getInputTexture() {
    return this._lastInputRT?.texture ?? null;
  }

  /** @private */
  _syncViewBoundsUniforms() {
    const u = this._composeMaterial?.uniforms;
    if (!u) return;

    const sc = window.MapShine?.sceneComposer;
    const sceneRect = canvas?.dimensions?.sceneRect;
    const sceneX = sceneRect?.x ?? 0;
    const sceneY = sceneRect?.y ?? 0;
    const sceneW = sceneRect?.width ?? 1;
    const sceneH = sceneRect?.height ?? 1;
    let vMinX = 0;
    let vMinY = 0;
    let vMaxX = sceneW;
    let vMaxY = sceneH;
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
  }

  /** @private */
  _readTodTint(index, track) {
    const p = this.params;
    const keys = todTintSliderKeys(index, track);
    const fallback = DEFAULT_TOD_ANCHORS[index] ?? DEFAULT_TOD_ANCHORS[0];
    const nested = Array.isArray(p.todAnchors) ? p.todAnchors[index] : null;
    const nestedTint = track === 'Global' ? nested?.global?.tintColor : nested?.interior?.tintColor;
    const fallbackTint = track === 'Global' ? fallback.global.tintColor : fallback.interior.tintColor;

    const readChannel = (key, fb) => {
      if (!Object.prototype.hasOwnProperty.call(p, key)) return fb;
      const v = Number(p[key]);
      return Number.isFinite(v) ? v : fb;
    };

    const hasSlider = [keys.r, keys.g, keys.b].some((k) => Object.prototype.hasOwnProperty.call(p, k));
    const rgb = hasSlider
      ? normalizeTintMultiplier({
        r: readChannel(keys.r, fallbackTint.r),
        g: readChannel(keys.g, fallbackTint.g),
        b: readChannel(keys.b, fallbackTint.b),
      })
      : normalizeTintMultiplier(
        p[keys.color] ?? nestedTint ?? fallbackTint
      );

    p[keys.r] = rgb.r;
    p[keys.g] = rgb.g;
    p[keys.b] = rgb.b;
    p[keys.color] = { ...rgb };
    return rgb;
  }

  /** @private */
  _readTodAnchor(index) {
    const p = this.params;
    const fallback = DEFAULT_TOD_ANCHORS[index] ?? DEFAULT_TOD_ANCHORS[0];
    const nested = Array.isArray(p.todAnchors) ? p.todAnchors[index] : null;
    return {
      hour: wrapHour24(p[`tod${index}Hour`] ?? nested?.hour ?? fallback.hour),
      global: {
        exposure: clamp(p[`tod${index}GlobalExposure`] ?? nested?.global?.exposure ?? fallback.global.exposure, -10, 10),
        saturation: clamp(p[`tod${index}GlobalSaturation`] ?? nested?.global?.saturation ?? fallback.global.saturation, 0, 4),
        tintColor: this._readTodTint(index, 'Global'),
      },
      interior: {
        exposure: clamp(p[`tod${index}InteriorExposure`] ?? nested?.interior?.exposure ?? fallback.interior.exposure, -10, 10),
        saturation: clamp(p[`tod${index}InteriorSaturation`] ?? nested?.interior?.saturation ?? fallback.interior.saturation, 0, 4),
        tintColor: this._readTodTint(index, 'Interior'),
      },
    };
  }

  /** @private */
  _evaluateTodTimeline(hourRaw) {
    const hour = wrapHour24(hourRaw);
    const anchors = [];
    for (let i = 0; i < TOD_ANCHOR_COUNT; i++) anchors.push(this._readTodAnchor(i));
    this.params.todAnchors = anchors.map((anchor) => ({
      hour: anchor.hour,
      global: {
        exposure: anchor.global.exposure,
        saturation: anchor.global.saturation,
        tintColor: { ...anchor.global.tintColor },
      },
      interior: {
        exposure: anchor.interior.exposure,
        saturation: anchor.interior.saturation,
        tintColor: { ...anchor.interior.tintColor },
      },
    }));
    anchors.sort((a, b) => a.hour - b.hour);

    let prev = anchors[anchors.length - 1];
    let next = anchors[0];
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      const b = anchors[(i + 1) % anchors.length];
      const bHour = i === anchors.length - 1 ? b.hour + 24 : b.hour;
      const h = hour < a.hour ? hour + 24 : hour;
      if (h >= a.hour && h <= bHour) {
        prev = a;
        next = b;
        break;
      }
    }

    const prevHour = prev.hour;
    const nextHour = next.hour <= prevHour ? next.hour + 24 : next.hour;
    const sampleHour = hour < prevHour ? hour + 24 : hour;
    const span = Math.max(0.0001, nextHour - prevHour);
    const t = smooth01((sampleHour - prevHour) / span);

    const mixGrade = (track) => ({
      exposure: lerp(prev[track].exposure, next[track].exposure, t),
      saturation: lerp(prev[track].saturation, next[track].saturation, t),
      tintColor: lerpColor(prev[track].tintColor, next[track].tintColor, t),
    });

    return {
      global: mixGrade('global'),
      interior: mixGrade('interior'),
    };
  }

  /** @private @returns {number} */
  _resolveTimelineHour() {
    const externalDriveActive = window.MapShine?.environmentControlApi?.isExternallyDriven?.() === true;
    const wcHour = Number(weatherController?.timeOfDay);
    if (externalDriveActive && Number.isFinite(wcHour)) return wrapHour24(wcHour);
    try {
      const panelHour = Number(window.MapShine?.controlPanel?.controlState?.timeOfDay);
      if (externalDriveActive && Number.isFinite(panelHour)) return wrapHour24(panelHour);
    } catch (_) {}

    try {
      const hour = Number(LightingDirector.get()?.hour);
      if (Number.isFinite(hour)) return wrapHour24(hour);
    } catch (_) {}
    if (Number.isFinite(wcHour)) return wrapHour24(wcHour);
    try {
      const panelHour = Number(window.MapShine?.controlPanel?.controlState?.timeOfDay);
      if (Number.isFinite(panelHour)) return wrapHour24(panelHour);
    } catch (_) {}
    return 12.0;
  }

  /** @returns {boolean} */
  isTimelineEnabled() {
    return this._isTimelineEnabled();
  }

  /**
   * Live post-merge diagnostics for console inspection.
   * @returns {object}
   */
  getDebugState() {
    const u = this._composeMaterial?.uniforms;
    const grade = (this._isTimelineEnabled() && this.params.enabled !== false)
      ? this._evaluateTodTimeline(this._resolveTimelineHour())
      : null;
    return {
      initialized: this._initialized,
      paramsEnabled: this.params.enabled !== false,
      timelineEnabled: this._isTimelineEnabled(),
      lastPostMergeWrote: this._lastPostMergeWrote,
      lastPostMergeTodApplied: this._lastPostMergeTodApplied,
      hour: this._resolveTimelineHour(),
      gradeEnabled: u?.uGradeEnabled?.value ?? null,
      todEnabled: u?.uTodEnabled?.value ?? null,
      todGlobalExposure: u?.uTodGlobalExposure?.value ?? null,
      todGlobalTint: u?.uTodGlobalTintColor
        ? { r: u.uTodGlobalTintColor.value.x, g: u.uTodGlobalTintColor.value.y, b: u.uTodGlobalTintColor.value.z }
        : null,
      evaluatedGrade: grade,
    };
  }

  /**
   * @param {string} paramId
   * @param {*} _value
   */
  applyParamChange(paramId, _value) {
    if (!this._initialized || !this._composeMaterial) return;
    if (
      paramId === 'todTimelineEnabled'
      || paramId.startsWith('tod')
      ||       paramId === 'localWarmLightPreserve'
      || paramId === 'localTodOverrideExposure'
      || paramId === 'localTodOverrideSaturation'
      ||       paramId === 'localWarmEmissiveAdd'
      || paramId === 'atmosphereEnabled'
      || paramId === 'intensity'
      || paramId === 'shadowGradePreserve'
      || paramId === 'goldenOutdoorRecolorStrength'
      || paramId === 'goldenOutdoorRecolorColor'
      || paramId === 'analyticStrength'
    ) {
      this._pushTodUniforms();
      this._pushAtmosphereUniforms();
    }
  }

  /** @private @returns {boolean} */
  _isTimelineEnabled() {
    return isTimelineEnabledParam(this.params?.todTimelineEnabled);
  }

  /** @private */
  _pushTodUniforms() {
    const u = this._composeMaterial?.uniforms;
    if (!u) return;

    const p = this.params;
    const applyTimeline = this._isTimelineEnabled() && p.enabled !== false;
    u.uGradeEnabled.value = p.enabled !== false ? 1.0 : 0.0;
    u.uTodEnabled.value = applyTimeline ? 1.0 : 0.0;
    u.uLocalOverrideStrength.value = Math.max(0, Math.min(1, Number(p.localWarmLightPreserve) ?? 1.0));
    u.uLocalOverrideExposureOffset.value = Number.isFinite(Number(p.localTodOverrideExposure))
      ? Number(p.localTodOverrideExposure)
      : 2.75;
    u.uLocalOverrideSaturationMin.value = Math.max(0.5, Math.min(2, Number(p.localTodOverrideSaturation) ?? 1.25));
    u.uLocalEmissiveAdd.value = Math.max(0, Math.min(1.5, Number(p.localWarmEmissiveAdd) ?? 0.55));
    if (!applyTimeline) return;

    const grade = this._evaluateTodTimeline(this._resolveTimelineHour());
    u.uTodGlobalExposure.value = grade.global.exposure;
    u.uTodGlobalSaturation.value = grade.global.saturation;
    u.uTodGlobalTintColor.value.set(
      grade.global.tintColor.r,
      grade.global.tintColor.g,
      grade.global.tintColor.b
    );
    u.uTodInteriorExposure.value = grade.interior.exposure;
    u.uTodInteriorSaturation.value = grade.interior.saturation;
    u.uTodInteriorTintColor.value.set(
      grade.interior.tintColor.r,
      grade.interior.tintColor.g,
      grade.interior.tintColor.b
    );
  }

  // ── Per-frame update ──────────────────────────────────────────────────

  /**
   * Push current params to shader uniforms.
   * @param {{ elapsed: number, delta: number }} timeInfo
   */
  update(timeInfo) {
    if (!this._initialized || !this._composeMaterial) return;
    if (this.params.enabled === false) {
      this._composeMaterial.uniforms.uGradeEnabled.value = 0.0;
      return;
    }

    this._lastTimeInfo = timeInfo;

    const u = this._composeMaterial.uniforms;
    const p = this.params;

    u.uTime.value = timeInfo.elapsed;
    this._syncViewBoundsUniforms();

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
    u.uGradeEnabled.value = 1.0;

    // Phase 2: ColorCorrection is always the post-composite owner of ToD grading.
    this._pushTodUniforms();
    this._pushAtmosphereUniforms();
  }

  /**
   * Combined timeline + atmosphere grade for downstream effects.
   * @returns {{ enabled: boolean, global?: object, interior?: object, atmosphere?: object }}
   */
  getEnvironmentGradeState() {
    const timeline = this.getTimelineGradeState();
    const atmosphere = this._atmosphereState?.atmosphereGrade ?? null;
    return {
      ...timeline,
      atmosphere,
      skyTintColor: this._atmosphereState?.skyTintColor ?? null,
    };
  }

  /**
   * Current timeline grade for downstream effects (e.g. post-merge water).
   * @returns {{ enabled: boolean, global?: object, interior?: object }}
   */
  getTimelineGradeState() {
    if (this.params.enabled === false || !this._isTimelineEnabled()) {
      return { enabled: false };
    }
    const grade = this._evaluateTodTimeline(this._resolveTimelineHour());
    return { enabled: true, global: grade.global, interior: grade.interior };
  }

  // ── Render ────────────────────────────────────────────────────────────

  /**
   * Execute the color correction post-processing pass.
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} inputRT
   * @param {THREE.WebGLRenderTarget} outputRT
   */
  render(renderer, inputRT, outputRT) {
    this._lastPostMergeWrote = false;
    this._lastPostMergeTodApplied = false;
    if (!this._initialized || !this._composeMaterial || !inputRT || !outputRT) return false;

    // Track the last input RT so DynamicExposureManager can probe the pre-grade
    // (linear-HDR after Phase 1+) scene via getInputTexture().
    this._lastInputRT = inputRT;
    this._composeMaterial.uniforms.tDiffuse.value = inputRT.texture;
    this._composeMaterial.uniforms.uResolution.value.set(
      inputRT.width, inputRT.height
    );
    this._syncViewBoundsUniforms();
    this._pushTodUniforms();
    this._pushAtmosphereUniforms();
    this._lastPostMergeTodApplied =
      this._isTimelineEnabled()
      && this.params.enabled !== false
      && (this._composeMaterial.uniforms.uTodEnabled?.value ?? 0) > 0.5;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    renderer.setRenderTarget(outputRT);
    renderer.autoClear = true;
    renderer.render(this._composeScene, this._composeCamera);

    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
    this._lastPostMergeWrote = true;
    return true;
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
