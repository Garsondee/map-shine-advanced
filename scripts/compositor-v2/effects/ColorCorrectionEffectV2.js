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
 * {@link FloorCompositor}. This is the single HDR → LDR boundary: Lighting and
 * SkyColor produce linear environment values, while this pass owns exposure,
 * ToD timeline grading, vignette, grain, and tone mapping.
 *
 * Ported from V1 ColorCorrectionEffect with identical shader logic and defaults.
 *
 * @module compositor-v2/effects/ColorCorrectionEffectV2
 */

import { createLogger } from '../../core/log.js';
import { weatherController } from '../../core/WeatherController.js';

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

/** Default hour per anchor index (tod0..tod7). */
const DEFAULT_TOD_ANCHORS = [
  makeTodAnchor(0.0,
    { exposure: 0, saturation: 0.5, tintColor: { r: 0.45, g: 0.55, b: 2.4 } },
    { exposure: -3, saturation: 1, tintColor: { r: 0.55, g: 0.71, b: 1.2 } }),
  makeTodAnchor(3.0,
    { exposure: -1, saturation: 0.4, tintColor: { r: 1, g: 1, b: 1 } },
    { exposure: -3, saturation: 1, tintColor: { r: 1, g: 1, b: 1 } }),
  makeTodAnchor(6.0,
    { exposure: 0, saturation: 1, tintColor: { r: 2, g: 1.3, b: 1 } },
    { exposure: -3, saturation: 1, tintColor: { r: 1, g: 1, b: 1 } }),
  makeTodAnchor(9.0,
    { exposure: 0, saturation: 1, tintColor: { r: 1, g: 1, b: 1 } },
    { exposure: -2, saturation: 1, tintColor: { r: 1, g: 1, b: 1 } }),
  makeTodAnchor(12.0,
    { exposure: 0.7, saturation: 1, tintColor: { r: 1, g: 1, b: 1 } },
    { exposure: -1, saturation: 0.5, tintColor: { r: 1, g: 1, b: 1 } }),
  makeTodAnchor(15.0,
    { exposure: 0, saturation: 1, tintColor: { r: 3, g: 1.3, b: 1 } },
    { exposure: -2, saturation: 1, tintColor: { r: 1, g: 1, b: 1 } }),
  makeTodAnchor(18.0,
    { exposure: 0, saturation: 1, tintColor: { r: 2, g: 1.4, b: 1 } },
    { exposure: -3, saturation: 1, tintColor: { r: 1, g: 1, b: 1 } }),
  makeTodAnchor(21.0,
    { exposure: -1, saturation: 0.4, tintColor: { r: 1, g: 1, b: 1 } },
    { exposure: -3, saturation: 1, tintColor: { r: 1, g: 1, b: 1 } }),
];

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

    // Defaults tuned to match Foundry PIXI brightness.
    // Tone mapping is OFF by default to avoid darkening the scene.
    this.params = {
      enabled: true,

      // 1. Input
      exposure: 1,

      // Dynamic Exposure (eye adaptation). Driven by DynamicExposureManager, not user-authored.
      dynamicExposure: 1.0,

      // 2. White Balance
      temperature: 0.0,
      tint: 0.0,

      // 3. Basic Adjustments
      brightness: 0.0,
      contrast: 1.0,
      saturation: 1,
      vibrance: 0,

      // 4. Color Grading (Lift/Gamma/Gain)
      liftColor: { r: 0, g: 0, b: 0 },
      gammaColor: { r: 0.5, g: 0.5, b: 0.5 },
      gainColor: { r: 1, g: 1, b: 1 },
      masterGamma: 1.5,

      // 5. Tone Mapping.
      // ACES is the HDR → LDR boundary now that the per-level chain emits true
      // linear HDR (lighting tone map / sky grade removed). Override to 0 for
      // legacy linear output if you author scenes against the pre-HDR pipeline.
      toneMapping: 0,

      // 6. Artistic
      vignetteStrength: 0.0,
      vignetteSoftness: 0.0,
      grainStrength: 0.0,

      // 7. Time-of-day CC timeline. These controls are additive on top of the
      // base CC grade; defaults are neutral so enabling the tool is predictable.
      todTimelineEnabled: true,
      todAnchors: cloneTodAnchors(),
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
  }

  // ── UI schema (moved from V1 ColorCorrectionEffect) ──────────────────────

  static getControlSchema() {
    const timelineGroups = [];
    const timelineParams = {
      todTimelineEnabled: {
        type: 'boolean',
        default: true,
        label: 'Enable time-of-day timeline',
        tooltip: 'Blends eight clock anchors (global + interior grades) as Map Shine time advances. This is the camera-grade owner for visible time-of-day exposure.',
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
        {
          name: 'tod-timeline',
          label: 'Time-of-day camera timeline',
          type: 'folder',
          expanded: false,
          parameters: ['todTimelineEnabled'],
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
          default: 1,
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
          default: 1.5,
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
      },
      presets: {
        'Clear Noon': {
          toneMapping: 1,
          exposure: 0.95,
          temperature: 0.02,
          tint: 0.0,
          contrast: 1.04,
          saturation: 1.02,
          vibrance: -0.05,
          vignetteStrength: 0.0,
          grainStrength: 0.0,
        },
        'Golden Hour': {
          toneMapping: 1,
          exposure: 0.92,
          temperature: 0.18,
          tint: 0.03,
          contrast: 1.02,
          saturation: 1.06,
          vibrance: 0.05,
          vignetteStrength: 0.08,
        },
        'Overcast Day': {
          toneMapping: 1,
          exposure: 0.88,
          temperature: -0.08,
          contrast: 0.94,
          saturation: 0.88,
          vibrance: -0.1,
          vignetteStrength: 0.0,
        },
        Storm: {
          toneMapping: 1,
          exposure: 0.8,
          temperature: -0.18,
          contrast: 0.9,
          saturation: 0.78,
          vibrance: -0.18,
          vignetteStrength: 0.12,
        },
        'Moonlit Night': {
          toneMapping: 1,
          exposure: 0.72,
          temperature: -0.28,
          contrast: 1.08,
          saturation: 0.62,
          vibrance: -0.2,
          vignetteStrength: 0.16,
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

          // Match LightingEffectV2 / SkyColor: alpha=0 is "no authored data", not indoors.
          // RGB black without alpha must not expand interior grading on sparse upper-floor masks.
          vec4 od = texture2D(tOutdoorsMask, sceneUv);
          float outdoorRaw = clamp(max(od.r, max(od.g, od.b)), 0.0, 1.0);
          float outdoorMid = smoothstep(0.18, 0.82, outdoorRaw);
          float outdoorClass = (outdoorRaw <= 0.10) ? 0.0 : ((outdoorRaw >= 0.90) ? 1.0 : outdoorMid);
          float outdoorsAlphaValid = step(0.5, clamp(od.a, 0.0, 1.0));
          float isOutdoor = mix(1.0, outdoorClass, outdoorsAlphaValid);
          float indoorSignal = clamp(1.0 - isOutdoor, 0.0, 1.0);
          return mix(0.0, smoothstep(0.20, 0.75, indoorSignal), inScene);
        }

        vec3 applyTimelineGrade(vec3 inputColor, float exposureStops, float saturationMul, vec3 tintColor) {
          vec3 graded = inputColor * exp2(clamp(exposureStops, -10.0, 10.0));
          graded *= clamp(tintColor, vec3(0.0), vec3(10.0));

          float luma = dot(graded, vec3(0.2126, 0.7152, 0.0722));
          graded = mix(vec3(luma), graded, clamp(saturationMul, 0.0, 4.0));
          return graded;
        }

        void main() {
          vec4 texel = texture2D(tDiffuse, vUv);
          vec3 color = texel.rgb;

          // Phase 2: ColorCorrectionEffectV2 is the sole grade owner and runs once
          // on the merged HDR composite, so the legacy timeline-only early-out
          // (uTimelineOnly) is gone. The full pipeline below — exposure, WB,
          // brightness, LGG, ToD timeline, tone map, vignette, grain — is the
          // HDR → LDR boundary.

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

          // 5. Time-of-day CC timeline (before tone mapping so exposure stops stay strong).
          // Global grade everywhere; interior uses global + interior exposure in stops,
          // with separate interior saturation/tint, blended by _Outdoors mask.
          if (uTodEnabled > 0.5) {
            float indoorW = clamp(sampleIndoorWeight(vUv), 0.0, 1.0);
            vec3 globalColor = applyTimelineGrade(
              color,
              uTodGlobalExposure,
              uTodGlobalSaturation,
              uTodGlobalTintColor
            );
            float interiorExposureTotal = uTodGlobalExposure + uTodInteriorExposure;
            vec3 interiorColor = applyTimelineGrade(
              color,
              interiorExposureTotal,
              uTodInteriorSaturation,
              uTodInteriorTintColor
            );
            color = mix(globalColor, interiorColor, indoorW);
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
    if (!THREE || this._fallbackWhite) return;
    const white = new Uint8Array([255, 255, 255, 255]);
    this._fallbackWhite = new THREE.DataTexture(white, 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    this._fallbackWhite.needsUpdate = true;
    this._fallbackWhite.flipY = false;
    this._fallbackWhite.generateMipmaps = false;
    this._fallbackWhite.minFilter = THREE.NearestFilter;
    this._fallbackWhite.magFilter = THREE.NearestFilter;
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

    const hasSlider = [keys.r, keys.g, keys.b].some((k) => p[k] !== undefined);
    const rgb = hasSlider
      ? normalizeTintMultiplier({
        r: p[keys.r],
        g: p[keys.g],
        b: p[keys.b],
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

  // ── Per-frame update ──────────────────────────────────────────────────

  /**
   * Push current params to shader uniforms.
   * @param {{ elapsed: number, delta: number }} timeInfo
   */
  update(timeInfo) {
    if (!this._initialized || !this._composeMaterial) return;
    if (!this.params.enabled) return;

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

    // Phase 2: ColorCorrection is always the post-composite owner of ToD grading;
    // the legacy suppress/timeline-only toggles are gone.
    const applyTimeline = p.todTimelineEnabled === true;
    u.uTodEnabled.value = applyTimeline ? 1.0 : 0.0;
    if (applyTimeline) {
      const grade = this._evaluateTodTimeline(weatherController?.timeOfDay ?? 12.0);
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
  }

  /**
   * Current timeline grade for downstream effects (e.g. post-merge water).
   * @returns {{ enabled: boolean, global?: object, interior?: object }}
   */
  getTimelineGradeState() {
    if (!this.params.enabled || this.params.todTimelineEnabled !== true) {
      return { enabled: false };
    }
    const grade = this._evaluateTodTimeline(weatherController?.timeOfDay ?? 12.0);
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
    if (!this._initialized || !this._composeMaterial || !inputRT) return;
    if (!this.params.enabled) return;

    // Track the last input RT so DynamicExposureManager can probe the pre-grade
    // (linear-HDR after Phase 1+) scene via getInputTexture().
    this._lastInputRT = inputRT;
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
