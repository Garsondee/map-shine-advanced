/**
 * @fileoverview V2 Window Light Effect — per-tile additive window glow overlays.
 *
 * HEALTH-WIRING BADGE (Map Shine Breaker Box):
 * If you change this effect's lifecycle, floor visibility logic, shader inputs,
 * or cross-effect texture dependencies, you MUST update HealthEvaluator
 * contracts/wiring for `WindowLightEffectV2` to prevent silent failures.
 *
 * Architecture:
 *   - For each tile that has a `_Windows` (or legacy `_Structural`) mask, create
 *     an additive overlay mesh in an ISOLATED scene (NOT the FloorRenderBus scene).
 *   - FloorCompositor passes `_scene` directly into `LightingEffectV2.render()` as
 *     the `windowLightScene` argument. LightingEffectV2 renders it into
 *     `_windowLightRT`, then the compose pass merges that with Foundry lights
 *     from `_lightRT` into total illumination.
 *
 * Shadow lift: {@link FloorCompositor#_buildDynamicLightOverridePayload} passes
 * the previous frame's `_windowLightRT` alongside Foundry `_lightRT` into source
 * shadow effects (overhead / building / sky-reach / painted) so window glow
 * clears baked shadow strength the same way gameplay lights do.
 *
 * Why this is correct:
 *   The lighting compose shader does `litColor = albedo * totalIllumination`.
 *   By contributing to `totalIllumination` (via `_windowLightRT` merged at compose),
 *   window light naturally
 *   tints itself by the surface albedo — a red surface stays red under warm light.
 *   Pure additive post-lighting would add white light uniformly, desaturating colours.
 *
 * Floor isolation is handled by manually toggling mesh visibility in
 * onFloorChange() since the overlays are not in the bus scene.
 *
 * Roof / ceiling occlusion for window glow uses the same half-res transmittance
 * texture as `LightingEffectV2` when available (`setCeilingTransmittanceTexture`),
 * else falls back to `uOverheadRoofAlphaTex`. `syncFrameOcclusion` applies
 * `LightingPerspectiveContext.getRoofScreenOcclusionScaleForFloor` for the per-level
 * lit slice (falls back to `getRoofScreenOcclusionScale` when needed) so multi-floor
 * "lower floor" behavior matches the slice being drawn, not only the UI active floor.
 *
 * Environment tint: {@link #setSkyState} receives sky tint from SkyColor and,
 * when Color Correction time-of-day camera timeline is enabled, {@link #setTimelineGradeState}
 * plus live {@link ColorCorrectionEffectV2#getTimelineGradeState} supply global/interior
 * tint multipliers blended by destination indoors weight (window spill is indoor-gated).
 *
 * Indoor-only: {@link #setOutdoorsMask} gates overlays with the active-floor
 * `_Outdoors` mask (white = outdoor, no window glow). After the overlay draw,
 * {@link #applyOutdoorsClip} runs a fullscreen post-pass on `_windowLightRT`
 * that zeroes any surviving light on outdoor (white) mask pixels.
 *
 * @module compositor-v2/effects/WindowLightEffectV2
 */

import { createLogger } from '../../core/log.js';
import { probeMaskFile } from '../../assets/loader.js';
import {
  tileHasLevelsRange,
  readTileLevelsFlags,
  getVisibleLevelBackgroundLayers,
  resolveV14NativeDocFloorIndexMin,
  resolveV14BackgroundFloorIndexForSrc,
} from '../../foundry/levels-scene-flags.js';
import { isTileOverhead } from '../../scene/tile-manager.js';
import { weatherController, PrecipitationType } from '../../core/WeatherController.js';
import { LightingDirector } from '../../core/LightingDirector.js';
import { resolveEffectShadowSun2D } from '../shadow-system/ShadowSunDirection.js';
import { GROUND_Z } from '../LayerOrderPolicy.js';
import {
  GLSL_DECODE_OUTDOORS_MASK,
  GLSL_SCREEN_TO_SCENE_UV,
  applySceneViewProjectionToUniforms,
  createSceneViewProjectionCache,
  updateSceneViewProjectionFromCamera,
} from '../scene-view-projection.js';

const log = createLogger('WindowLightEffectV2');

// Tile overlays: slightly above bus tile plane (`GROUND_Z + floorIndex`).
// Background overlays: sit on the bg stack (`GROUND_Z - 1 + ε`), matching
// FloorRenderBus `_addBackgroundImage` + SpecularEffectV2 (`GROUND_Z + fi - 1 + offset`).
const WINDOW_Z_OFFSET = 0.2;
const TOD_ANCHOR_COUNT = 8;
/** Clock hours for tod0..tod7 — matches ColorCorrectionEffectV2 defaults. */
const DEFAULT_TOD_ANCHOR_HOURS = [0.0, 3.0, 6.0, 9.0, 12.0, 15.0, 18.0, 21.0];
/**
 * UI order and labels (display-only). `index` is the persisted tod{N} slot.
 * Same ordering as ColorCorrectionEffectV2.
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

const clamp01 = (n) => Math.max(0.0, Math.min(1.0, Number(n) || 0.0));
const stripUrlQueryHash = (s) => String(s || '').split('#')[0].split('?')[0];

const wrapHour24 = (hour) => {
  const n = Number(hour);
  const h = Number.isFinite(n) ? n : 0;
  return ((h % 24) + 24) % 24;
};

const smooth01 = (t) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
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

export class WindowLightEffectV2 {
  constructor() {
    /** @type {boolean} */
    this._enabled = true;

    /** @type {boolean} */
    this._initialized = false;

    /**
     * Isolated Three.js scene — overlays live here, NOT in the FloorRenderBus
     * scene, so they are rendered after the lighting pass.
     * @type {THREE.Scene|null}
     */
    this._scene = null;

    /** @type {number} Active floor index for visibility gating. */
    this._activeFloorIndex = 0;
    /** @type {number|null} Per-pass render floor override (set by FloorCompositor). */
    this._renderFloorIndex = null;
    /**
     * When {@link #setRenderFloorIndex} passes a finite floor index:
     * - false (stack): show overlays for this floor and every floor below — used for shadow-light
     *   prepasses so lower-storey windows still participate in lift masks.
     * - true (slice): show overlays only for exactly that floor — matches {@link FloorCompositor}'s
     *   per-level scene RT so downstairs windows do not illuminate upstairs albedo.
     * @type {boolean}
     */
    this._renderFloorSliceStrict = false;

    /**
     * Per-tile overlay entries.
     * @type {Map<string, {mesh: THREE.Mesh, material: THREE.ShaderMaterial, floorIndex: number, isOverhead: boolean}>}
     */
    this._overlays = new Map();

    /** @type {object|null} */
    this._sharedUniforms = null;

    /** @type {THREE.Texture|null} Active-floor `_Outdoors` mask (white = outdoor). */
    this._outdoorsMask = null;

    /** @type {WeakSet<object>} Tracks normalized outdoors mask textures. */
    this._normalizedOutdoorsTextures = new WeakSet();

    /** Fullscreen post-pass: zero window light wherever _Outdoors reads outdoor (white). */
    this._outdoorsClipScene = null;
    this._outdoorsClipCamera = null;
    this._outdoorsClipMaterial = null;
    this._outdoorsClipScratchRT = null;
    this._outdoorsClipScratchSize = { w: 0, h: 0 };
    this._viewProjectionCache = createSceneViewProjectionCache();
    this._clipTmpNdcVec = null;
    this._clipTmpWorldVec = null;
    this._clipTmpDirVec = null;

    /** @type {{ enabled: boolean, global?: object, interior?: object }} */
    this._timelineGradeState = { enabled: false };

    /** @type {{ skyTintColor: {r:number,g:number,b:number}, sunAzimuthDeg: number, skyIntensity01: number, sceneDarkness01: (number|null), effectiveDarkness01: (number|null), skyTintDarknessLightsEnabled: (boolean|null), skyTintDarknessLightsIntensity: (number|null), todCameraTimelineActive: boolean, todCameraTintColor: {r:number,g:number,b:number} }} */
    this._driverSunDir = null;
    this._driverShadowLengthScale = 1.0;

    this._skyState = {
      skyTintColor: { r: 1.0, g: 1.0, b: 1.0 },
      sunAzimuthDeg: 180.0,
      skyIntensity01: 1.0,
      sceneDarkness01: null,
      effectiveDarkness01: null,
      skyTintDarknessLightsEnabled: null,
      skyTintDarknessLightsIntensity: null,
      todCameraTimelineActive: false,
      todCameraTintColor: { r: 1.0, g: 1.0, b: 1.0 },
    };

    this.params = {
      hasWindowMask: false,
      enabled: true,
      intensity: 2.0,
      falloff: 1.5,
      color: { r: 1.0, g: 0.96, b: 0.85 },
      lightOverheadTiles: true,
      overheadLightIntensity: 1.0,
      specularBoost: 2.0,
      flickerEnabled: false,
      flickerSpeed: 0.35,
      flickerAmount: 0.15,
      cloudInfluence: 1.0,
      cloudShadowContrast: 1.0,
      cloudShadowBias: 0.05,
      cloudShadowGamma: 2.28,
      cloudShadowMinLight: 0.0,
      useSkyTint: true,
      skyTintStrength: 0.05,
      useTodCameraTint: true,
      todCameraTintStrength: 5.0,
      nightDimming: 0.1,
      sunLightEnabled: true,
      sunLightLength: 0.0,
      rainOnGlassEnabled: true,
      rainOnGlassIntensity: 1.0,
      rainOnGlassPrecipStart: 0.15,
      rainOnGlassPrecipFull: 0.7,
      rainOnGlassSpeed: 0.35,
      rainOnGlassDirectionDeg: 270.0,
      rainOnGlassMaxOffsetPx: 1.25,
      rainOnGlassDarken: 0.25,
      // RGB shift (chromatic dispersion / refraction)
      rgbShiftAmount: 3.75,  // pixels
      rgbShiftAngle: 120.0,  // degrees
    };

    for (let i = 0; i < TOD_ANCHOR_COUNT; i++) {
      this.params[`tod${i}IntensityPercent`] = 100.0;
    }

    /**
     * Last foundrySceneData passed into populate(). Used for one-time
     * repopulation if floor bands were not available during initial populate.
     * @type {object|null}
     */
    this._lastFoundrySceneData = null;

    /**
     * Floor band count used by the most recent populate().
     * If this was <= 1 and later FloorStack provides > 1 bands, upper-floor
     * overlays would have been assigned to floor 0. We repopulate in that case.
     * @type {number}
     */
    this._lastPopulatedFloorBandCount = 0;

    /** @type {Promise<void>|null} One-time repopulation in-flight. */
    this._repopulatePromise = null;

    /**
     * Incremented each populate() call; async texture callbacks from older
     * populates are ignored if the generation no longer matches.
     * @type {number}
     */
    this._populateGeneration = 0;

    /** @type {import('../../core/diagnostics/PerformanceRecorder.js').PerformanceRecorder|null} */
    this._activePerfRecorder = null;

    log.debug('WindowLightEffectV2 created');
  }

  // ── Performance Recorder ───────────────────────────────────────────────────

  /** @private */
  _bindPerfRecorder() {
    try {
      const recorder = window.MapShine?.performanceRecorder;
      this._activePerfRecorder = recorder?.enabled ? recorder : null;
    } catch (_) {
      this._activePerfRecorder = null;
    }
  }

  /**
   * @param {string} name
   * @param {'update'|'render'} [phase='update']
   * @param {{ cpuOnly?: boolean }} [options={}]
   * @returns {object|null}
   * @private
   */
  _beginPerfSpan(name, phase = 'update', options = {}) {
    try {
      const recorder = this._activePerfRecorder;
      if (!recorder?.enabled || typeof recorder.beginEffectCall !== 'function') return null;
      return recorder.beginEffectCall(`windowLight.${phase}.${name}`, phase, options);
    } catch (_) {
      return null;
    }
  }

  /** @param {object|null} token @private */
  _endPerfSpan(token) {
    if (!token) return;
    try {
      const recorder = this._activePerfRecorder ?? window.MapShine?.performanceRecorder;
      recorder?.endEffectCall?.(token);
    } catch (_) {}
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Master intensity × blended time-of-day percentage (0–200% anchors).
   * @param {number} [hourRaw] Scene clock hour; defaults to WeatherController time.
   * @returns {number}
   */
  getEffectiveIntensity(hourRaw) {
    const master = Math.max(0.0, Number(this.params.intensity) || 0);
    const hour = hourRaw !== undefined
      ? hourRaw
      : (Number(weatherController?.timeOfDay) ?? 12.0);
    const todMul = this._evaluateTodIntensityMultiplier(hour);
    return master * todMul;
  }

  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
    this.params.enabled = this._enabled;
    if (this._sharedUniforms?.uEffectEnabled) this._sharedUniforms.uEffectEnabled.value = this._enabled;
  }

  // ── UI schema (moved from V1 WindowLightEffect) ───────────────────────────

  static getControlSchema() {
    const todIntensityParams = {};
    const todIntensityParamKeys = [];
    for (const meta of TOD_ANCHOR_META) {
      const i = meta.index;
      const key = `tod${i}IntensityPercent`;
      todIntensityParamKeys.push(key);
      todIntensityParams[key] = {
        type: 'slider',
        label: `${meta.label} strength (%)`,
        min: 0.0,
        max: 200.0,
        step: 1.0,
        default: 100.0,
        throttle: 50,
        tooltip: `Window light at ~${meta.clockHint} as a percentage of master intensity. Blends smoothly between anchors as scene time advances.`,
      };
    }

    return {
      enabled: true,
      help: {
        title: 'Window Light',
        summary: [
          'Adds warm window glow and weather-aware glass effects. This is a light source / emissive surface, not a camera exposure control.',
          'Sky tint and cloud dimming make windows feel connected to day, night, and weather. Keep those moderate so Color Correction remains the final grade owner.'
        ].join('\n\n'),
        glossary: {
          'Master intensity': 'Overall window glow scale. Time-of-day percentages multiply this value.',
          'Time of day %': 'Per-anchor strength as a percentage of master intensity. Anchors blend smoothly around the 24h clock (same eight slots as Color Correction).',
          'Sky tint': 'How much computed sky color warms/cools window light.',
          'ToD camera tint': 'Multiplies window light by the Color Correction time-of-day camera timeline tint (global + interior tracks, blended like the CC grade on indoor destinations).',
          'Night dimming': 'How strongly LightingDirector darkness reduces windows at night.'
        },
      },
      groups: [
        { name: 'status', label: 'Effect Status', type: 'inline', parameters: ['textureStatus'] },
        { name: 'lighting', label: 'Window Light', type: 'folder', expanded: true, parameters: ['intensity', 'falloff', 'color'] },
        {
          name: 'todIntensity',
          label: 'Time of Day Intensity',
          type: 'folder',
          expanded: false,
          parameters: todIntensityParamKeys,
        },
        { name: 'sunTracking', label: 'Sun Tracking', type: 'folder', expanded: false, parameters: ['sunLightEnabled', 'sunLightLength'] },
        { name: 'environment', label: 'Environment', type: 'folder', expanded: false, parameters: ['cloudInfluence', 'nightDimming', 'useSkyTint', 'skyTintStrength', 'useTodCameraTint', 'todCameraTintStrength'] },
        { name: 'cloudShadows', label: 'Cloud Shadows', type: 'folder', expanded: false, parameters: ['cloudShadowContrast', 'cloudShadowBias', 'cloudShadowGamma', 'cloudShadowMinLight'] },
        { name: 'refraction', label: 'Refraction (RGB)', type: 'folder', expanded: false, parameters: ['rgbShiftAmount', 'rgbShiftAngle'] },
        { name: 'overheads', label: 'Overhead Tile Lighting', type: 'folder', expanded: false, parameters: ['lightOverheadTiles', 'overheadLightIntensity'] },
        { name: 'specular', label: 'Specular Coupling', type: 'folder', expanded: false, parameters: ['specularBoost'] },
        { name: 'rainCore', label: 'Rain On Glass (Core)', type: 'folder', expanded: true, parameters: ['rainOnGlassEnabled', 'rainOnGlassIntensity', 'rainOnGlassPrecipStart', 'rainOnGlassPrecipFull', 'rainOnGlassSpeed', 'rainOnGlassDirectionDeg'] },
        { name: 'rainNoise', label: 'Rain On Glass (Noise & Rivulets)', type: 'folder', expanded: true, parameters: ['rainNoiseScale', 'rainNoiseDetail', 'rainNoiseEvolution', 'rainRivuletAspect', 'rainRivuletGain', 'rainRivuletStrength', 'rainRivuletThreshold', 'rainRivuletFeather', 'rainRivuletGamma', 'rainRivuletSoftness', 'rainRivuletRidgeMix', 'rainRivuletRidgeGain'] },
        { name: 'rainDistortion', label: 'Rain On Glass (Distortion & Darken)', type: 'folder', expanded: false, parameters: ['rainOnGlassMaxOffsetPx', 'rainOnGlassBlurPx', 'rainOnGlassDistortionFeatherPx', 'rainOnGlassDistortionMasking', 'rainOnGlassDarken', 'rainOnGlassDarkenGamma', 'rainOnGlassBrightThreshold', 'rainOnGlassBrightFeather'] },
        { name: 'rainBoundaryFlow', label: 'Rain On Glass (Boundary Flow)', type: 'folder', expanded: false, parameters: ['rainOnGlassBoundaryFlowStrength', 'rainFlowWidth', 'rainRoofPlateauStrength', 'rainRoofPlateauStart', 'rainRoofPlateauFeather', 'rainRivuletDistanceMasking', 'rainRivuletDistanceStart', 'rainRivuletDistanceEnd', 'rainRivuletDistanceFeather'] },
        { name: 'rainSplashesCore', label: 'Rain Splashes (Core)', type: 'folder', expanded: false, parameters: ['rainSplashIntensity', 'rainSplashSpawnRate', 'rainSplashSpeed', 'rainSplashLayers'] },
        { name: 'rainSplashesShape', label: 'Rain Splashes (Shape)', type: 'folder', expanded: false, parameters: ['rainSplashScale', 'rainSplashThreshold', 'rainSplashMaskScale', 'rainSplashMaskThreshold', 'rainSplashMaskFeather', 'rainSplashRadiusPx', 'rainSplashExpand', 'rainSplashFadePow', 'rainSplashMaxOffsetPx'] },
        { name: 'rainSplashesDrift', label: 'Rain Splashes (Drift & Streaks)', type: 'folder', expanded: false, parameters: ['rainSplashDriftPx', 'rainSplashSizeJitter', 'rainSplashBlob', 'rainSplashStreakStrength', 'rainSplashStreakLengthPx', 'rainSplashAtlasTile0', 'rainSplashAtlasTile1', 'rainSplashAtlasTile2', 'rainSplashAtlasTile3'] },
        { name: 'rainFlowDirection', label: 'Flow Map (Direction & Motion)', type: 'folder', expanded: false, parameters: ['rainFlowFlipDeadzone', 'rainFlowMaxTurnDeg', 'rainFlowInvertTangent', 'rainFlowInvertNormal', 'rainFlowSwapAxes', 'rainFlowAdvectScale', 'rainFlowEvoScale', 'rainFlowPerpScale', 'rainFlowGlobalInfluence', 'rainFlowAngleOffset'] },
        { name: 'rainFlowMapGen', label: 'Flow Map (Generation)', type: 'folder', expanded: false, parameters: ['rebuildRainFlowMap', 'rainFlowMapMaxDim', 'rainFlowMapMinDim', 'rainFlowMapObstacleThreshold', 'rainFlowMapObstacleInvert', 'rainFlowMapBoundaryMaxPx', 'rainFlowMapDistanceGamma', 'rainFlowMapDistanceScale', 'rainFlowMapRelaxIterations', 'rainFlowMapRelaxKernel', 'rainFlowMapRelaxMix', 'rainFlowMapDefaultX', 'rainFlowMapDefaultY'] },
        { name: 'rainDebug', label: 'Rain Debug', type: 'folder', expanded: false, parameters: ['rainDebugRoofPlateau', 'rainDebugFlowMap'] },
        { name: 'lightning', label: 'Lightning Flash (Window)', type: 'folder', expanded: false, parameters: ['lightningWindowEnabled', 'lightningWindowIntensityBoost', 'lightningWindowContrastBoost', 'lightningWindowRgbBoost'] }
      ],
      parameters: {
        hasWindowMask: { type: 'boolean', default: true, hidden: true },
        textureStatus: { type: 'string', label: 'Mask Status', default: 'Checking...', readonly: true },
        intensity: {
          type: 'slider',
          label: 'Master Intensity',
          min: 0.0,
          max: 4.0,
          step: 0.05,
          default: 2.0,
          tooltip: 'Overall linear window glow energy. Each time-of-day anchor applies a percentage of this value.',
        },
        ...todIntensityParams,
        falloff: { type: 'slider', label: 'Falloff (Gamma)', min: 0.5, max: 5.0, step: 0.05, default: 1.5 },
        color: { type: 'color', label: 'Light Color', default: { r: 1.0, g: 0.96, b: 0.85 } },
        cloudInfluence: { type: 'slider', label: 'Cloud Dimming', min: 0.0, max: 1.0, step: 0.01, default: 1.0 },
        nightDimming: { type: 'slider', label: 'Night Dimming', min: 0.0, max: 2.0, step: 0.01, default: 0.1 },
        useSkyTint: { type: 'boolean', label: 'Use Sky Tint', default: true },
        skyTintStrength: { type: 'slider', label: 'Sky Tint Strength', min: 0.0, max: 5.0, step: 0.01, default: 0.05, tooltip: 'Moderate sky color coupling for weather/night ambience without replacing Camera Grade.' },
        useTodCameraTint: { type: 'boolean', label: 'Use ToD Camera Tint', default: true, tooltip: 'When Color Correction time-of-day camera timeline is on, multiply window light by the timeline tint multipliers (global + interior, blended on indoor spill pixels).' },
        todCameraTintStrength: { type: 'slider', label: 'ToD Camera Tint Strength', min: 0.0, max: 5.0, step: 0.01, default: 5.0, throttle: 50, tooltip: 'Intensity of the timeline tint on window light (0 = no effect). Independent from Sky Tint Strength.' },
        cloudShadowContrast: { type: 'slider', label: 'Shadow Contrast', min: 0.0, max: 4.0, step: 0.01, default: 1.0 },
        cloudShadowBias: { type: 'slider', label: 'Shadow Bias', min: -1.0, max: 1.0, step: 0.01, default: 0.05 },
        cloudShadowGamma: { type: 'slider', label: 'Shadow Gamma', min: 0.1, max: 4.0, step: 0.01, default: 2.28 },
        cloudShadowMinLight: { type: 'slider', label: 'Min Light', min: 0.0, max: 1.0, step: 0.01, default: 0.0 },
        rgbShiftAmount: { type: 'slider', label: 'RGB Shift', min: 0.0, max: 12.0, step: 0.01, default: 3.75 },
        rgbShiftAngle: { type: 'slider', label: 'Angle (deg)', min: 0.0, max: 360.0, step: 1.0, default: 120.0 },
        specularBoost: { type: 'slider', label: 'Specular Boost', min: 0.0, max: 2.0, step: 0.05, default: 2.0 },
        lightOverheadTiles: { type: 'boolean', label: 'Light Overheads', default: true },
        overheadLightIntensity: { type: 'slider', label: 'Overhead Intensity', min: 0.0, max: 1.0, step: 0.05, default: 1.0 },
        rainOnGlassEnabled: { type: 'boolean', label: 'Enabled', default: true },
        rainOnGlassIntensity: { type: 'slider', label: 'Intensity', min: 0.0, max: 2.0, step: 0.01, default: 1.0 },
        rainOnGlassPrecipStart: { type: 'slider', label: 'Precip Start', min: 0.0, max: 1.0, step: 0.01, default: 0.15 },
        rainOnGlassPrecipFull: { type: 'slider', label: 'Precip Full', min: 0.0, max: 1.0, step: 0.01, default: 0.7 },
        rainOnGlassSpeed: { type: 'slider', label: 'Downflow Speed', min: 0.0, max: 15.0, step: 0.01, default: 0.35 },
        rainOnGlassDirectionDeg: { type: 'slider', label: 'Direction (deg)', min: 0.0, max: 360.0, step: 1.0, default: 270.0 },
        rainNoiseScale: { type: 'slider', label: 'Noise Scale', min: 0.1, max: 10.0, step: 0.05, default: 2.0 },
        rainNoiseDetail: { type: 'slider', label: 'Noise Detail', min: 0.0, max: 6.0, step: 0.1, default: 2.0 },
        rainNoiseEvolution: { type: 'slider', label: 'Noise Evolution', min: 0.0, max: 15.0, step: 0.01, default: 0.35 },
        rainRivuletAspect: { type: 'slider', label: 'Rivulet Aspect', min: 1.0, max: 50.0, step: 0.05, default: 3.0 },
        rainRivuletGain: { type: 'slider', label: 'Rivulet Gain', min: 0.0, max: 4.0, step: 0.01, default: 1.0 },
        rainRivuletStrength: { type: 'slider', label: 'Rivulet Strength', min: 0.0, max: 2.0, step: 0.01, default: 1.0 },
        rainRivuletThreshold: { type: 'slider', label: 'Rivulet Threshold', min: 0.0, max: 1.0, step: 0.001, default: 0.5 },
        rainRivuletFeather: { type: 'slider', label: 'Rivulet Feather', min: 0.0, max: 1.0, step: 0.001, default: 0.25 },
        rainRivuletGamma: { type: 'slider', label: 'Rivulet Gamma', min: 0.1, max: 4.0, step: 0.01, default: 1.0 },
        rainRivuletSoftness: { type: 'slider', label: 'Rivulet Softness', min: 0.0, max: 15.0, step: 0.001, default: 0.0 },
        rainRivuletRidgeMix: { type: 'slider', label: 'Ridge Mix', min: 0.0, max: 1.0, step: 0.001, default: 0.0 },
        rainRivuletRidgeGain: { type: 'slider', label: 'Ridge Gain', min: 0.0, max: 8.0, step: 0.01, default: 1.0 },
        rainSplashAtlasTile0: { type: 'boolean', label: 'Splash Tile 0', default: true },
        rainSplashAtlasTile1: { type: 'boolean', label: 'Splash Tile 1', default: true },
        rainSplashAtlasTile2: { type: 'boolean', label: 'Splash Tile 2', default: true },
        rainSplashAtlasTile3: { type: 'boolean', label: 'Splash Tile 3', default: true },
        rainFlowFlipDeadzone: { type: 'slider', label: 'Flip Deadzone', min: 0.0, max: 0.5, step: 0.001, default: 0.15 },
        rainFlowMaxTurnDeg: { type: 'slider', label: 'Max Turn (deg)', min: 0.0, max: 180.0, step: 1.0, default: 180.0 },
        rainOnGlassBoundaryFlowStrength: { type: 'slider', label: 'Boundary Flow Strength', min: 0.0, max: 25.0, step: 0.01, default: 1.0 },
        rainFlowWidth: { type: 'slider', label: 'Flow Width', min: 0.0, max: 5.0, step: 0.01, default: 0.25 },
        rainRoofPlateauStrength: { type: 'slider', label: 'Roof Plateau Strength', min: 0.0, max: 1.0, step: 0.01, default: 0.0 },
        rainRoofPlateauStart: { type: 'slider', label: 'Roof Plateau Start', min: 0.0, max: 1.0, step: 0.01, default: 0.4 },
        rainRoofPlateauFeather: { type: 'slider', label: 'Roof Plateau Feather', min: 0.0, max: 1.0, step: 0.001, default: 0.1 },
        rainRivuletDistanceMasking: { type: 'slider', label: 'Rivulet Distance Masking', min: 0.0, max: 1.0, step: 0.001, default: 0.0 },
        rainRivuletDistanceStart: { type: 'slider', label: 'Rivulet Distance Start', min: 0.0, max: 1.0, step: 0.001, default: 0.0 },
        rainRivuletDistanceEnd: { type: 'slider', label: 'Rivulet Distance End', min: 0.0, max: 1.0, step: 0.001, default: 1.0 },
        rainRivuletDistanceFeather: { type: 'slider', label: 'Rivulet Distance Feather', min: 0.0, max: 0.5, step: 0.001, default: 0.1 },
        rainDebugRoofPlateau: { type: 'boolean', label: 'Debug Roof Plateau', default: false },
        rainFlowMapMaxDim: { type: 'slider', label: 'Max Dim', min: 32, max: 2048, step: 1, default: 512 },
        rainFlowMapMinDim: { type: 'slider', label: 'Min Dim', min: 8, max: 1024, step: 1, default: 64 },
        rainFlowMapObstacleThreshold: { type: 'slider', label: 'Obstacle Threshold', min: 0.0, max: 1.0, step: 0.001, default: 0.5 },
        rebuildRainFlowMap: { type: 'button', title: 'Rebuild Flow Map', label: 'Rebuild' },
        rainFlowMapObstacleInvert: { type: 'boolean', label: 'Invert Obstacles', default: false },
        rainFlowMapBoundaryMaxPx: { type: 'slider', label: 'Boundary Max (px)', min: 1, max: 4096, step: 1, default: 256 },
        rainFlowMapDistanceGamma: { type: 'slider', label: 'Distance Gamma', min: 0.01, max: 10.0, step: 0.01, default: 1.0 },
        rainFlowMapDistanceScale: { type: 'slider', label: 'Distance Scale', min: 0.0, max: 10.0, step: 0.01, default: 1.0 },
        rainFlowMapRelaxIterations: { type: 'slider', label: 'Relax Iterations', min: 0, max: 100, step: 1, default: 4 },
        rainFlowMapRelaxKernel: { type: 'slider', label: 'Relax Kernel', min: 0, max: 8, step: 1, default: 1 },
        rainFlowMapRelaxMix: { type: 'slider', label: 'Relax Mix', min: 0.0, max: 2.0, step: 0.01, default: 1.0 },
        rainFlowMapDefaultX: { type: 'slider', label: 'Default Flow X', min: -1.0, max: 1.0, step: 0.01, default: 0.0 },
        rainFlowMapDefaultY: { type: 'slider', label: 'Default Flow Y', min: -1.0, max: 1.0, step: 0.01, default: 1.0 },
        rainDebugFlowMap: { type: 'boolean', label: 'Debug Flow Map', default: false },
        rainOnGlassMaxOffsetPx: { type: 'slider', label: 'Max Offset (px)', min: 0.0, max: 8.0, step: 0.05, default: 1.25 },
        rainOnGlassBlurPx: { type: 'slider', label: 'Blur (px)', min: 0.0, max: 80.0, step: 0.05, default: 0.0 },
        rainOnGlassDistortionFeatherPx: { type: 'slider', label: 'Distortion Feather (px)', min: 0.0, max: 32.0, step: 0.25, default: 0.0 },
        rainOnGlassDistortionMasking: { type: 'slider', label: 'Distortion Masking', min: 0.0, max: 1.0, step: 0.001, default: 1.0 },
        rainOnGlassDarken: { type: 'slider', label: 'Darken', min: 0.0, max: 1.0, step: 0.01, default: 0.25 },
        rainOnGlassDarkenGamma: { type: 'slider', label: 'Darken Gamma', min: 0.1, max: 4.0, step: 0.01, default: 1.25 },
        rainSplashIntensity: { type: 'slider', label: 'Intensity', min: 0.0, max: 2.0, step: 0.01, default: 0.0 },
        rainSplashMaxOffsetPx: { type: 'slider', label: 'Max Offset (px)', min: 0.0, max: 10.0, step: 0.01, default: 0.75 },
        rainSplashScale: { type: 'slider', label: 'Sharp Noise Scale', min: 0.1, max: 250.0, step: 0.1, default: 40.0 },
        rainSplashMaskScale: { type: 'slider', label: 'Mask Noise Scale', min: 0.1, max: 100.0, step: 0.1, default: 6.0 },
        rainSplashThreshold: { type: 'slider', label: 'Sharp Threshold', min: 0.0, max: 1.0, step: 0.001, default: 0.75 },
        rainSplashMaskThreshold: { type: 'slider', label: 'Mask Threshold', min: 0.0, max: 1.0, step: 0.001, default: 0.5 },
        rainSplashMaskFeather: { type: 'slider', label: 'Mask Feather', min: 0.0, max: 1.0, step: 0.001, default: 0.15 },
        rainSplashSpeed: { type: 'slider', label: 'Speed', min: 0.0, max: 10.0, step: 0.01, default: 0.5 },
        rainSplashSpawnRate: { type: 'slider', label: 'Spawn Rate', min: 0.1, max: 50.0, step: 0.1, default: 1.0 },
        rainSplashRadiusPx: { type: 'slider', label: 'Radius (px)', min: 0.0, max: 64.0, step: 0.1, default: 6.0 },
        rainSplashExpand: { type: 'slider', label: 'Expand', min: 1.0, max: 8.0, step: 0.01, default: 2.0 },
        rainSplashFadePow: { type: 'slider', label: 'Fade Power', min: 0.25, max: 8.0, step: 0.01, default: 2.0 },
        rainSplashLayers: { type: 'slider', label: 'Layers', min: 1.0, max: 3.0, step: 1.0, default: 1.0 },
        rainSplashDriftPx: { type: 'slider', label: 'Drift (px)', min: 0.0, max: 128.0, step: 0.5, default: 18.0 },
        rainSplashSizeJitter: { type: 'slider', label: 'Size Jitter', min: 0.0, max: 1.0, step: 0.01, default: 0.5 },
        rainSplashBlob: { type: 'slider', label: 'Blob', min: 0.0, max: 1.0, step: 0.01, default: 0.5 },
        rainSplashStreakStrength: { type: 'slider', label: 'Streak Strength', min: 0.0, max: 2.0, step: 0.01, default: 0.35 },
        rainSplashStreakLengthPx: { type: 'slider', label: 'Streak Length (px)', min: 0.0, max: 96.0, step: 0.5, default: 24.0 },
        rainOnGlassBrightThreshold: { type: 'slider', label: 'Bright Mask Threshold', min: 0.0, max: 1.0, step: 0.01, default: 0.5 },
        rainOnGlassBrightFeather: { type: 'slider', label: 'Bright Mask Feather', min: 0.0, max: 1.0, step: 0.01, default: 0.1 },
        rainFlowInvertTangent: { type: 'boolean', label: 'Invert Tangent', default: false },
        rainFlowInvertNormal: { type: 'boolean', label: 'Invert Normal', default: false },
        rainFlowSwapAxes: { type: 'boolean', label: 'Swap XY Axes', default: false },
        rainFlowAdvectScale: { type: 'slider', label: 'Advect Scale', min: -2.0, max: 2.0, step: 0.01, default: 1.0 },
        rainFlowEvoScale: { type: 'slider', label: 'Evolution Scale', min: -2.0, max: 2.0, step: 0.01, default: 1.0 },
        rainFlowPerpScale: { type: 'slider', label: 'Perpendicular Scale', min: -2.0, max: 2.0, step: 0.01, default: 1.0 },
        rainFlowGlobalInfluence: { type: 'slider', label: 'Global Influence', min: 0.0, max: 2.0, step: 0.01, default: 1.0 },
        rainFlowAngleOffset: { type: 'slider', label: 'Angle Offset', min: -180.0, max: 180.0, step: 1.0, default: 0.0 },
        sunLightEnabled: { type: 'boolean', label: 'Enable Sun Tracking', default: true },
        sunLightLength: { type: 'slider', label: 'Light Shift Length', min: 0.0, max: 0.3, step: 0.005, default: 0.0 },
        lightningWindowEnabled: { type: 'boolean', label: 'Enabled', default: true },
        lightningWindowIntensityBoost: { type: 'slider', label: 'Intensity Boost', min: 0.0, max: 5.0, step: 0.05, default: 1.0 },
        lightningWindowContrastBoost: { type: 'slider', label: 'Contrast Boost', min: 0.0, max: 5.0, step: 0.05, default: 1.75 },
        lightningWindowRgbBoost: { type: 'slider', label: 'RGB Boost', min: 0.0, max: 3.0, step: 0.05, default: 0.35 }
      }
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  initialize() {
    if (this._initialized) return;
    const THREE = window.THREE;
    if (!THREE) { log.warn('initialize: THREE not available'); return; }

    this._scene = new THREE.Scene();
    this._scene.name = 'WindowLightScene';
    // Transparent additive quads: if sortObjects stays true, Three.js may reorder
    // draws every frame by camera distance. That can make stacked floor overlays
    // (same footprint, different Z) appear to "lose" upper-floor light when the
    // active floor / camera changes. Use explicit renderOrder per floor instead.
    this._scene.sortObjects = false;

    this._buildSharedUniforms();
    this._buildOutdoorsClipPass();

    this._scene.userData.onBindWindowLightPass = (rw, rh, renderCamera) => {
      this._bindPerfRecorder();
      const _perfToken = this._beginPerfSpan('bindPass', 'render', { cpuOnly: true });
      try {
        const u = this._sharedUniforms;
        if (!u?.uScreenSize) return;
        const w = Math.max(1, Math.floor(Number(rw) || 1));
        const h = Math.max(1, Math.floor(Number(rh) || 1));
        u.uScreenSize.value.set(w, h);
        // Combined/cloud shadow RTs are authored for this same buffer; keep the divisor
        // identical to gl_FragCoord space for Pass 1b (avoids texel drift vs texture.image).
        if (u.uCloudShadowBufferSize) u.uCloudShadowBufferSize.value.set(w, h);
        this._syncViewProjectionUniforms(renderCamera ?? null);
        this._updateSceneBounds();
      } finally {
        this._endPerfSpan(_perfToken);
      }
    };

    this._scene.userData.onAfterWindowLightPass = (renderer, camera, targetRT, outdoorsMask) => {
      this.applyOutdoorsClip(renderer, camera, targetRT, outdoorsMask);
    };

    this._initialized = true;
    log.info('WindowLightEffectV2 initialized');
  }

  clear() {
    for (const [, entry] of this._overlays) {
      try { this._scene?.remove(entry.mesh); } catch (_) {}
      try { entry.material?.dispose(); } catch (_) {}
      try { entry.mesh?.geometry?.dispose(); } catch (_) {}
    }
    this._overlays.clear();
  }

  dispose() {
    this.clear();
    if (this._scene?.userData) {
      delete this._scene.userData.onBindWindowLightPass;
      delete this._scene.userData.onAfterWindowLightPass;
    }
    try { this._outdoorsClipScratchRT?.dispose(); } catch (_) {}
    try { this._outdoorsClipMaterial?.dispose(); } catch (_) {}
    try { this._outdoorsClipScene?.children?.[0]?.geometry?.dispose(); } catch (_) {}
    this._outdoorsClipScene = null;
    this._outdoorsClipCamera = null;
    this._outdoorsClipMaterial = null;
    this._outdoorsClipScratchRT = null;
    this._scene = null;
    this._initialized = false;
    this._sharedUniforms = null;
  }

  /**
   * Update overlay visibility when the active floor changes.
   * Mirrors the FloorRenderBus.setVisibleFloors() logic.
   * @param {number} maxFloorIndex
   */
  onFloorChange(maxFloorIndex) {
    const prev = this._activeFloorIndex;
    this._activeFloorIndex = Number.isFinite(Number(maxFloorIndex)) ? Number(maxFloorIndex) : 0;
    for (const entry of this._overlays.values()) {
      entry.mesh.visible = this._isFloorVisible(entry.floorIndex);
    }
    if (prev !== this._activeFloorIndex) {
      log.info(`WindowLightEffectV2 floor visibility switched: ${prev} -> ${this._activeFloorIndex}`);
    }
  }

  /**
   * Set/clear the current render floor index for lighting/shadow passes.
   *
   * @param {number|null} floorIndex
   * @param {boolean} [sliceStrict=false] When true with a finite index, only window overlays on that
   *   floor are visible (per-level lighting slice). When false, overlays on this floor and all lower
   *   floors are visible (stack semantics — shadow prepass).
   */
  setRenderFloorIndex(floorIndex = null, sliceStrict = false) {
    const next = Number(floorIndex);
    this._renderFloorIndex = Number.isFinite(next) ? next : null;
    this._renderFloorSliceStrict = Number.isFinite(next) ? !!sliceStrict : false;
    for (const entry of this._overlays.values()) {
      entry.mesh.visible = this._isFloorVisible(entry.floorIndex);
    }
  }

  /**
   * Populate window overlays for all tiles in the scene.
   *
   * @param {object} foundrySceneData
   */
  async populate(foundrySceneData) {
    if (!this._initialized) { log.warn('populate: not initialized'); return; }
    this._lastFoundrySceneData = foundrySceneData;
    this._populateGeneration += 1;
    const gen = this._populateGeneration;
    this.clear();
    this.params.hasWindowMask = false;

    const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    this._lastPopulatedFloorBandCount = floors.length;
    // worldH must match FloorRenderBus and SpecularEffectV2: use foundrySceneData.height
    // (full canvas height including padding), NOT canvas.scene.height (scene rect only).
    const worldH = foundrySceneData?.height ?? canvas?.dimensions?.height ?? 0;

    let overlayCount = 0;
    const perFloorCounts = new Map();

    // ── Process scene background image ────────────────────────────────────
    // Build background _Windows overlays for every authored floor. Per-slice
    // visibility plus roof/ceiling transmittance decide whether lower-floor
    // window glow is visible from the current floor.
    const scene = canvas?.scene ?? null;
    const bgEntries = [];
    const floorIndexByLevelId = new Map();
    try {
      for (const f of floors) {
        const levelId = (f?.levelId != null) ? String(f.levelId) : '';
        const idx = Number(f?.index);
        if (!levelId || !Number.isFinite(idx)) continue;
        floorIndexByLevelId.set(levelId, idx);
      }
    } catch (_) {}
    try {
      const sortedLevels = scene?.levels?.sorted ?? [];
      if (Array.isArray(sortedLevels) && sortedLevels.length > 0) {
        for (let i = 0; i < sortedLevels.length; i += 1) {
          const level = sortedLevels[i];
          const src = String(level?.background?.src || '').trim();
          if (!src) continue;
          const levelId = (level?.id != null) ? String(level.id) : '';
          const mappedFloorIndex = levelId ? floorIndexByLevelId.get(levelId) : undefined;
          const docIdx = Number(level?.index);
          const keyIndex = Number.isFinite(docIdx)
            ? Math.max(0, Math.floor(docIdx))
            : Math.max(0, Math.floor(Number(mappedFloorIndex) || 0));
          const key = (keyIndex === 0) ? '__bg_image__' : `__bg_image__${keyIndex}`;
          // Same band index as PaintedShadow `_resolveBasePathForFloorIndex` / bus keys — Foundry level.index,
          // not the loop ordinal (indices may be non-contiguous).
          let floorIndex;
          if (Number.isFinite(docIdx)) {
            floorIndex = Math.max(0, Math.floor(docIdx));
          } else if (Number.isFinite(Number(mappedFloorIndex))) {
            floorIndex = Number(mappedFloorIndex);
          } else {
            floorIndex = i;
          }
          bgEntries.push({ src, floorIndex, key });
        }
      }
    } catch (_) {}
    if (bgEntries.length === 0) {
      const bgLayers = getVisibleLevelBackgroundLayers(scene);
      for (let i = 0; i < bgLayers.length; i += 1) {
        const src = String(bgLayers[i]?.src || '').trim();
        if (!src) continue;
        const floorIndex = resolveV14BackgroundFloorIndexForSrc(scene, src);
        const key = floorIndex === 0 ? '__bg_image__' : `__bg_image__${floorIndex}`;
        bgEntries.push({ src, floorIndex, key });
      }
    }

    for (let bi = 0; bi < bgEntries.length; bi += 1) {
      const bg = bgEntries[bi];
      const bgSrc = bg.src;
      const bgFloorIndex = Number.isFinite(Number(bg.floorIndex)) ? Number(bg.floorIndex) : bi;
      const bgId = bg.key;
      if (!bgSrc) continue;
      const bgSrcClean = stripUrlQueryHash(bgSrc);
      const dotIdx = bgSrcClean.lastIndexOf('.');
      const bgBasePath = dotIdx > 0 ? bgSrcClean.substring(0, dotIdx) : bgSrcClean;
      const bgWinResult = await probeMaskFile(bgBasePath, '_Windows');
      const bgStructResult = bgWinResult?.path ? null : await probeMaskFile(bgBasePath, '_Structural');
      const bgMaskPath = bgWinResult?.path ?? bgStructResult?.path;
      if (!bgMaskPath) continue;

      // Background geometry: scene rect in world space.
      const sceneW = foundrySceneData?.sceneWidth ?? foundrySceneData?.width ?? 0;
      const sceneH = foundrySceneData?.sceneHeight ?? foundrySceneData?.height ?? 0;
      const sceneX = foundrySceneData?.sceneX ?? 0;
      const sceneY = foundrySceneData?.sceneY ?? 0;
      const centerX = sceneX + sceneW / 2;
      const centerY = worldH - (sceneY + sceneH / 2);

      const z = GROUND_Z + bgFloorIndex - 1 + WINDOW_Z_OFFSET;

      this._createOverlay(bgId, bgFloorIndex, {
        maskUrl: bgMaskPath,
        centerX, centerY,
        w: sceneW,
        h: sceneH,
        z,
        rotation: 0,
        intensityMultiplier: 1.0,
        isOverhead: false,
        gen,
      });

      overlayCount++;
      perFloorCounts.set(bgFloorIndex, (perFloorCounts.get(bgFloorIndex) ?? 0) + 1);
      this.params.hasWindowMask = true;
    }

    // ── Process placed tiles ──────────────────────────────────────────────
    const tileDocs = canvas?.scene?.tiles?.contents ?? [];

    for (const tileDoc of tileDocs) {
      const tileId = tileDoc.id ?? tileDoc._id;
      if (!tileId) continue;
      const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
      if (!src) continue;

      const srcClean = stripUrlQueryHash(src);
      const dotIdx = srcClean.lastIndexOf('.');
      const basePath = dotIdx > 0 ? srcClean.substring(0, dotIdx) : srcClean;

      // _Windows is preferred; _Structural is a legacy equivalent — both are
      // colour luminance masks with alpha defining where light hits the floor.
      const winResult = await probeMaskFile(basePath, '_Windows');
      const structResult = winResult?.path ? null : await probeMaskFile(basePath, '_Structural');
      const maskPath = winResult?.path ?? structResult?.path;
      if (!maskPath) continue;

      const floorIndex = this._resolveFloorIndex(tileDoc, floors);
      // Use canonical overhead classification (persisted source flags + elevation fallback).
      // TileDocument#overhead is deprecated in PF2e v12+ and can misclassify overlays.
      const isOverheadTile = isTileOverhead(tileDoc);
      if (isOverheadTile && !this.params.lightOverheadTiles) {
        continue;
      }

      const tileW = tileDoc.width ?? 0;
      const tileH = tileDoc.height ?? 0;
      // World-space center: same Y-flip as SpecularEffectV2 and FloorRenderBus.
      const centerX = (tileDoc.x ?? 0) + tileW / 2;
      const centerY = worldH - ((tileDoc.y ?? 0) + tileH / 2);
      const rotation = typeof tileDoc.rotation === 'number'
        ? (tileDoc.rotation * Math.PI) / 180 : 0;

      // Z in bus coordinates.
      const z = GROUND_Z + floorIndex + WINDOW_Z_OFFSET;
      // Apply overhead intensity uniformly to overhead overlays so the UI slider
      // has an immediate visible effect regardless of floor semantics.
      const overheadIntensity = Math.max(0.0, Math.min(1.0, Number(this.params.overheadLightIntensity) || 0.0));
      const intensityMultiplier = isOverheadTile ? overheadIntensity : 1.0;

      this._createOverlay(tileId, floorIndex, {
        maskUrl: maskPath,
        centerX, centerY,
        w: tileW,
        h: tileH,
        z,
        rotation,
        intensityMultiplier,
        isOverhead: isOverheadTile,
        gen,
      });

      overlayCount++;
      perFloorCounts.set(floorIndex, (perFloorCounts.get(floorIndex) ?? 0) + 1);
      this.params.hasWindowMask = true;
    }

    // Re-apply visibility after repopulate so overlays created while on an
    // upper floor do not flash lower-floor window light for a frame.
    const activeFloor = window.MapShine?.floorStack?.getActiveFloor?.();
    const busVisibleFloor = Number(window.MapShine?.floorCompositorV2?._renderBus?._visibleMaxFloorIndex);
    const activeIdx = Number.isFinite(Number(activeFloor?.index))
      ? Number(activeFloor.index)
      : (Number.isFinite(busVisibleFloor) ? busVisibleFloor : this._activeFloorIndex);
    this.onFloorChange(activeIdx);
    const floorBreakdown = Array.from(perFloorCounts.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([fi, count]) => `f${fi}:${count}`)
      .join(', ');
    log.info(`WindowLightEffectV2 floor assignment: active=${activeIdx}, overlays=[${floorBreakdown || 'none'}]`);

    const bgCount = bgEntries.length;
    log.info(`WindowLightEffectV2 populated: ${overlayCount} overlay(s) (${bgCount > 0 ? `${bgCount} bg + ` : ''}${Math.max(0, overlayCount - bgCount)} tiles)`);
  }

  /**
   * Update per-frame uniforms.
   * @param {{ elapsed: number, delta: number }} timeInfo
   */
  update(timeInfo) {
    if (!this._initialized || !this._enabled) return;
    this._bindPerfRecorder();

    let _perfToken = this._beginPerfSpan('floorPoll', 'update', { cpuOnly: true });
    if (this._sharedUniforms?.uTime) {
      this._sharedUniforms.uTime.value = typeof timeInfo?.elapsed === 'number' ? timeInfo.elapsed : 0;
    }

    // This effect uses an isolated scene (not FloorRenderBus), so rely on a
    // per-frame floor poll as a safety net in case floor-change events arrive
    // out of order or are skipped during context transitions.
    const polledActiveFloor = Number(window.MapShine?.floorStack?.getActiveFloor?.()?.index);
    if (Number.isFinite(polledActiveFloor) && polledActiveFloor !== this._activeFloorIndex) {
      this.onFloorChange(polledActiveFloor);
    }

    // Auto-heal: if initial populate ran while FloorStack had only the fallback
    // single band (so all overlays were assigned to floor 0), repopulate once
    // real multi-floor bands appear.
    try {
      const floorCount = Number(window.MapShine?.floorStack?.getFloors?.()?.length ?? 0);
      if (floorCount > 1
        && this._lastPopulatedFloorBandCount <= 1
        && !this._repopulatePromise
        && this._lastFoundrySceneData) {
        this._repopulatePromise = this.populate(this._lastFoundrySceneData)
          .catch((err) => log.warn('WindowLightEffectV2 repopulate after floor bands failed:', err))
          .finally(() => { this._repopulatePromise = null; });
      }
    } catch (_) {}
    this._endPerfSpan(_perfToken);

    // Sync params → uniforms (cheap; shared uniforms update all overlays).
    const u = this._sharedUniforms;
    if (!u) return;

    _perfToken = this._beginPerfSpan('uniforms', 'update', { cpuOnly: true });
    u.uEffectEnabled.value = !!this._enabled;
    let landscapeWindowMul = 1.0;
    let landscapeFlash01 = 0;
    let llR = 0.68;
    let llG = 0.82;
    let llB = 1.0;
    try {
      const env = window.MapShine?.environment;
      landscapeWindowMul = Number(env?.landscapeLightningWindowMul) || 1.0;
      landscapeFlash01 = Math.max(0, Math.min(1, Number(env?.landscapeLightningFlash01) || 0));
      llR = Number(env?.landscapeLightningFlashColorR);
      llG = Number(env?.landscapeLightningFlashColorG);
      llB = Number(env?.landscapeLightningFlashColorB);
      if (!Number.isFinite(llR)) llR = 0.68;
      if (!Number.isFinite(llG)) llG = 0.82;
      if (!Number.isFinite(llB)) llB = 1.0;
    } catch (_) {}
    u.uIntensity.value = this.getEffectiveIntensity() * Math.max(0.0, landscapeWindowMul);
    u.uFalloff.value = Math.max(0.01, Number(this.params.falloff) || 1);

    const c = this.params.color;
    if (c && typeof c === 'object') {
      const baseR = Number(c.r) || 0;
      const baseG = Number(c.g) || 0;
      const baseB = Number(c.b) || 0;
      const tintW = landscapeFlash01 * 0.92;
      u.uColor.value.setRGB(
        baseR + (llR - baseR) * tintW,
        baseG + (llG - baseG) * tintW,
        baseB + (llB - baseB) * tintW,
      );
    }

    u.uFlickerEnabled.value = this.params.flickerEnabled ? 1.0 : 0.0;
    u.uFlickerSpeed.value = Math.max(0.0, Number(this.params.flickerSpeed) || 0);
    u.uFlickerAmount.value = Math.max(0.0, Number(this.params.flickerAmount) || 0);

    const skyTint = this._skyState.skyTintColor;
    const tintR = Number(skyTint.r);
    const tintG = Number(skyTint.g);
    const tintB = Number(skyTint.b);
    u.uSkyTintColor.value.setRGB(
      Math.max(0.01, Number.isFinite(tintR) ? tintR : 1.0),
      Math.max(0.01, Number.isFinite(tintG) ? tintG : 1.0),
      Math.max(0.01, Number.isFinite(tintB) ? tintB : 1.0)
    );
    const skyTintBySkyColorEnabled = this._skyState.skyTintDarknessLightsEnabled !== false;
    const skyTintBySkyColorIntensity = Number(this._skyState.skyTintDarknessLightsIntensity);
    const skyTintBySkyColorMul = Number.isFinite(skyTintBySkyColorIntensity)
      ? Math.max(0.0, skyTintBySkyColorIntensity)
      : 1.0;
    u.uUseSkyTint.value = (this.params.useSkyTint && skyTintBySkyColorEnabled) ? 1.0 : 0.0;
    const skyIntensity01 = clamp01(this._skyState.skyIntensity01);
    u.uSkyTintStrength.value = Math.max(0.0, Number(this.params.skyTintStrength) || 0.0) * skyIntensity01 * skyTintBySkyColorMul;

    this._syncTodCameraTintUniforms();

    // Phase 3: prefer the externally-injected sky state when available so a
    // single orchestrator can override per-frame, otherwise fall through to
    // LightingDirector so window light dimming matches lighting/sky exactly.
    const stateDarkness = Number(this._skyState.sceneDarkness01);
    const stateEffectiveDarkness = Number(this._skyState.effectiveDarkness01);
    let darkness;
    if (Number.isFinite(stateDarkness) || Number.isFinite(stateEffectiveDarkness)) {
      const sceneDarkness01 = Number.isFinite(stateDarkness) ? clamp01(stateDarkness) : 0.0;
      const effectiveDarkness01 = Number.isFinite(stateEffectiveDarkness) ? clamp01(stateEffectiveDarkness) : 0.0;
      darkness = Math.max(sceneDarkness01, effectiveDarkness01);
    } else {
      darkness = clamp01(LightingDirector.get().masterDarkness);
    }
    const nightDimming = Math.max(0.0, Math.min(2.0, Number(this.params.nightDimming) || 0.0));
    // Curve + up-to-2× slider so mid-range darkness and defaults read clearly “night”.
    const nightDimAmount = Math.min(1.0, darkness * nightDimming * 2.15);
    u.uNightFactor.value = Math.max(0.0, 1.0 - nightDimAmount);

    if (this._driverSunDir) {
      u.uSunDir.value.set(this._driverSunDir.x, this._driverSunDir.y);
    } else {
      const sun2d = resolveEffectShadowSun2D({
        azimuthDeg: Number(this._skyState.sunAzimuthDeg) || 180.0,
        elevationDeg: null,
      });
      u.uSunDir.value.set(sun2d.x, sun2d.y);
    }
    u.uSunTrackEnabled.value = this.params.sunLightEnabled ? 1.0 : 0.0;
    u.uSunLightLength.value = Math.max(0.0, Number(this.params.sunLightLength) || 0.0)
      * Math.max(0.05, Number(this._driverShadowLengthScale) || 1.0);

    const env = weatherController?.getEnvironment?.() ?? {};
    const overcastFactor = Math.max(0.0, Math.min(1.0, Number(env?.overcastFactor) || 0.0));
    const stormFactor = Math.max(0.0, Math.min(1.0, Number(env?.stormFactor) || 0.0));
    const cloudFactor = Math.max(0.0, Math.min(1.0, (1.0 - overcastFactor * 0.55) * (1.0 - stormFactor * 0.25)));
    u.uCloudFactor.value = cloudFactor;
    u.uCloudInfluence.value = Math.max(0.0, Math.min(1.0, Number(this.params.cloudInfluence) || 0.0));

    const weatherState = weatherController?.getCurrentState?.() ?? weatherController?.currentState ?? {};
    const precipTypeRaw = Number(weatherState?.precipType);
    const precipType = Number.isFinite(precipTypeRaw) ? precipTypeRaw : PrecipitationType.NONE;
    const precipAmount = Math.max(0.0, Math.min(1.0, Number(weatherState?.precipitation) || 0.0));
    const freezeLevel = Math.max(0.0, Math.min(1.0, Number(weatherState?.freezeLevel) || 0.0));
    const hasExplicitPrecipType = Number.isFinite(precipTypeRaw) && precipType !== PrecipitationType.NONE;
    const isLiquidByType = precipType === PrecipitationType.RAIN || precipType === PrecipitationType.HAIL;
    // Fallback: during some transitions precipType can temporarily lag while
    // precipitation is already rising. Treat low-freeze precipitation as rain.
    const isLikelyLiquid = freezeLevel < 0.65;
    const rainEnabled = !!this.params.rainOnGlassEnabled
      && precipAmount > 0.001
      && (isLiquidByType || (!hasExplicitPrecipType && isLikelyLiquid));
    const pStart = Math.max(0.0, Math.min(1.0, Number(this.params.rainOnGlassPrecipStart) || 0.0));
    const pFull = Math.max(pStart + 0.001, Math.min(1.0, Number(this.params.rainOnGlassPrecipFull) || 1.0));
    const rainRamp = Math.max(0.0, Math.min(1.0, (precipAmount - pStart) / Math.max(0.001, pFull - pStart)));
    u.uRainAmount.value = rainEnabled ? rainRamp * Math.max(0.0, Number(this.params.rainOnGlassIntensity) || 0.0) : 0.0;
    u.uRainSpeed.value = Math.max(0.0, Number(this.params.rainOnGlassSpeed) || 0.0);
    const rainDirRad = (Number(this.params.rainOnGlassDirectionDeg) || 270.0) * (Math.PI / 180.0);
    u.uRainDir.value.set(Math.cos(rainDirRad), Math.sin(rainDirRad));
    u.uRainMaxOffsetPx.value = Math.max(0.0, Number(this.params.rainOnGlassMaxOffsetPx) || 0.0);
    u.uRainDarken.value = Math.max(0.0, Math.min(1.0, Number(this.params.rainOnGlassDarken) || 0.0));
    u.uCloudShadowContrast.value = Math.max(0.0, Number(this.params.cloudShadowContrast) || 1.0);
    u.uCloudShadowBias.value = Number(this.params.cloudShadowBias) || 0.0;
    u.uCloudShadowGamma.value = Math.max(0.01, Number(this.params.cloudShadowGamma) || 1.0);
    u.uCloudShadowMinLight.value = Math.max(0.0, Math.min(1.0, Number(this.params.cloudShadowMinLight) || 0.0));

    // RGB shift — convert angle from degrees to radians each frame so live
    // tweaks take effect without requiring a repopulate.
    u.uRgbShiftAmount.value = Math.max(0.0, Number(this.params.rgbShiftAmount) || 0);
    u.uRgbShiftAngle.value = (Number(this.params.rgbShiftAngle) || 0) * (Math.PI / 180.0);
    this._endPerfSpan(_perfToken);

    _perfToken = this._beginPerfSpan('overlayIntensity', 'update', { cpuOnly: true });
    // Keep overhead controls live without requiring repopulate/rebuild.
    const overheadEnabled = !!this.params.lightOverheadTiles;
    const overheadIntensity = Math.max(0.0, Math.min(1.0, Number(this.params.overheadLightIntensity) || 0.0));
    u.uLightOverheadTiles.value = overheadEnabled ? 1.0 : 0.0;
    u.uOverheadLightIntensity.value = overheadIntensity;
    for (const entry of this._overlays.values()) {
      const overlayIntensity = entry.isOverhead
        ? (overheadEnabled ? overheadIntensity : 0.0)
        : 1.0;
      const overlayUniform = entry.material?.uniforms?.uOverlayIntensity;
      if (overlayUniform) overlayUniform.value = overlayIntensity;
    }
    this._endPerfSpan(_perfToken);

    _perfToken = this._beginPerfSpan('bounds', 'update', { cpuOnly: true });
    this._updateViewBounds();
    this._updateSceneBounds();
    this._endPerfSpan(_perfToken);
  }

  /**
   * API parity with other V2 effects.
   * Overlay draws are handled by LightingEffectV2; this effect's render() is unused.
   *
   * @param {THREE.WebGLRenderer} _renderer
   * @param {THREE.Camera} _camera
   */
  render(_renderer, _camera) {
  }

  /**
   * Final authoritative gate: multiply the window-light RT by (1 - outdoors).
   * Uses the same view→scene UV mapping as {@link LightingEffectV2} compose so
   * alignment matches the rest of the lighting stack.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera} camera
   * @param {THREE.WebGLRenderTarget|null} targetRT
   * @param {THREE.Texture|null} [outdoorsMaskOverride] - Same mask as lighting compose when provided.
   */
  applyOutdoorsClip(renderer, camera, targetRT, outdoorsMaskOverride = null) {
    if (!this._enabled || !renderer || !camera || !targetRT?.texture) return;
    const mask = outdoorsMaskOverride ?? this._outdoorsMask;
    if (!mask || !this._outdoorsClipMaterial || !this._outdoorsClipScene) return;

    this._bindPerfRecorder();
    let _perfToken = this._beginPerfSpan('outdoorsClipPrep', 'render', { cpuOnly: true });
    const w = Math.max(1, Math.floor(Number(targetRT.width) || 1));
    const h = Math.max(1, Math.floor(Number(targetRT.height) || 1));
    this._ensureOutdoorsClipScratchRT(w, h, targetRT.texture?.type);

    const u = this._outdoorsClipMaterial.uniforms;
    if (mask !== this._outdoorsMask) this._normalizeOutdoorsMaskTexture(mask);
    u.uOutdoorsMask.value = mask;
    u.uHasOutdoorsMask.value = 1.0;
    u.uOutdoorsMaskFlipY.value = mask.flipY ? 1.0 : 0.0;
    this._syncViewProjectionUniforms(camera);
    this._endPerfSpan(_perfToken);

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    _perfToken = this._beginPerfSpan('outdoorsClipDraw', 'render');
    try {
      renderer.autoClear = false;

      // Pass A: clip source RT → scratch.
      u.tWindowLight.value = targetRT.texture;
      renderer.setRenderTarget(this._outdoorsClipScratchRT);
      renderer.clear();
      renderer.render(this._outdoorsClipScene, this._outdoorsClipCamera);

      // Pass B: copy clipped scratch → source RT.
      u.tWindowLight.value = this._outdoorsClipScratchRT.texture;
      renderer.setRenderTarget(targetRT);
      renderer.clear();
      renderer.render(this._outdoorsClipScene, this._outdoorsClipCamera);
    } finally {
      this._endPerfSpan(_perfToken);
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }
  }

  /**
   * Receives environment data from FloorCompositor (SkyColor + Color Correction ToD).
   * @param {{
   *   skyTintColor?: {r:number,g:number,b:number},
   *   sunAzimuthDeg?: number,
   *   skyIntensity01?: number,
   *   sceneDarkness01?: number,
   *   effectiveDarkness01?: number,
   *   todCameraTimelineActive?: boolean,
   *   todCameraTintColor?: {r:number,g:number,b:number},
   * }} state
   */
  setDriver(driverState = null) {
    if (!driverState) return;
    const dir = driverState.sun?.dir;
    const x = Number(dir?.x);
    const y = Number(dir?.y);
    this._driverSunDir = (Number.isFinite(x) && Number.isFinite(y)) ? { x, y } : null;
    if (Number.isFinite(Number(driverState.tuning?.shadowLengthScale))) {
      this._driverShadowLengthScale = Number(driverState.tuning.shadowLengthScale);
    }
    if (Number.isFinite(Number(driverState.sun?.azimuthDeg))) {
      this._skyState.sunAzimuthDeg = Number(driverState.sun.azimuthDeg);
    }
  }

  /**
   * Timeline grade from ColorCorrectionEffectV2 (same evaluation as post-merge CC).
   * @param {{ enabled: boolean, global?: object, interior?: object }} state
   */
  setTimelineGradeState(state) {
    this._timelineGradeState = state ?? { enabled: false };
  }

  /**
   * Push CC timeline tint multipliers to shared uniforms (global + interior tracks).
   * Window glow is gated to indoor destinations, so interior tint must participate.
   * @private
   */
  _syncTodCameraTintUniforms() {
    const u = this._sharedUniforms;
    if (!u) return;

    let grade = this._timelineGradeState ?? { enabled: false };
    try {
      const cc = window.MapShine?.effectComposer?._floorCompositorV2?._colorCorrectionEffect ?? null;
      const live = cc?.getTimelineGradeState?.();
      if (live && typeof live === 'object') grade = live;
    } catch (_) {}

    const legacyActive = this._skyState.todCameraTimelineActive === true;
    const active = (grade.enabled === true || legacyActive) && this.params.useTodCameraTint !== false;
    u.uTodCameraTintActive.value = active ? 1.0 : 0.0;
    u.uTodCameraTintStrength.value = Math.max(0.0, Number(this.params.todCameraTintStrength) || 0.0);
    if (!active) return;

    const readTint = (primary, fallback) => {
      const src = (primary && typeof primary === 'object') ? primary : fallback;
      const r = Number(src?.r);
      const g = Number(src?.g);
      const b = Number(src?.b);
      return {
        r: Number.isFinite(r) ? r : 1.0,
        g: Number.isFinite(g) ? g : 1.0,
        b: Number.isFinite(b) ? b : 1.0,
      };
    };

    const globalTint = readTint(grade.global?.tintColor, this._skyState.todCameraTintColor);
    const interiorTint = readTint(grade.interior?.tintColor, globalTint);
    u.uTodCameraTintColor.value.setRGB(globalTint.r, globalTint.g, globalTint.b);
    u.uTodCameraTintInterior.value.setRGB(interiorTint.r, interiorTint.g, interiorTint.b);
  }

  setSkyState(state = {}) {
    if (!state || typeof state !== 'object') return;

    if (state.skyTintColor && typeof state.skyTintColor === 'object') {
      const sr = Number(state.skyTintColor.r);
      const sg = Number(state.skyTintColor.g);
      const sb = Number(state.skyTintColor.b);
      this._skyState.skyTintColor = {
        r: Number.isFinite(sr) ? sr : 1.0,
        g: Number.isFinite(sg) ? sg : 1.0,
        b: Number.isFinite(sb) ? sb : 1.0,
      };
    }
    if (Number.isFinite(Number(state.sunAzimuthDeg))) {
      this._skyState.sunAzimuthDeg = Number(state.sunAzimuthDeg);
    }
    if (Number.isFinite(Number(state.skyIntensity01))) {
      this._skyState.skyIntensity01 = clamp01(state.skyIntensity01);
    }
    this._skyState.sceneDarkness01 = Number.isFinite(Number(state.sceneDarkness01))
      ? clamp01(state.sceneDarkness01)
      : null;
    this._skyState.effectiveDarkness01 = Number.isFinite(Number(state.effectiveDarkness01))
      ? clamp01(state.effectiveDarkness01)
      : null;
    this._skyState.skyTintDarknessLightsEnabled = (typeof state.skyTintDarknessLightsEnabled === 'boolean')
      ? state.skyTintDarknessLightsEnabled
      : null;
    this._skyState.skyTintDarknessLightsIntensity = Number.isFinite(Number(state.skyTintDarknessLightsIntensity))
      ? Number(state.skyTintDarknessLightsIntensity)
      : null;

    if (typeof state.todCameraTimelineActive === 'boolean') {
      this._skyState.todCameraTimelineActive = state.todCameraTimelineActive;
    }
    if (state.todCameraTintColor && typeof state.todCameraTintColor === 'object') {
      const tr = Number(state.todCameraTintColor.r);
      const tg = Number(state.todCameraTintColor.g);
      const tb = Number(state.todCameraTintColor.b);
      this._skyState.todCameraTintColor = {
        r: Number.isFinite(tr) ? tr : 1.0,
        g: Number.isFinite(tg) ? tg : 1.0,
        b: Number.isFinite(tb) ? tb : 1.0,
      };
    }
  }

  /**
   * Bind cloud shadow factor texture for screen-space window-light dimming.
   * Uses the cloud-only masked RT (no indoors/outdoors gate). Textures are laid out
   * per drawing-buffer pixel; UVs use `gl_FragCoord` / `uCloudShadowBufferSize`.
   * @param {THREE.Texture|null} texture
   * @param {number} screenW
   * @param {number} screenH
   * @param {{minX:number,minY:number,maxX:number,maxY:number}|null} [_viewBounds] - Ignored (kept for call-site compatibility).
   */
  setCloudShadowTexture(texture, screenW, screenH, _viewBounds = null) {
    const u = this._sharedUniforms;
    if (!u) return;
    u.uCloudShadowTex.value = texture ?? null;
    u.uHasCloudShadowTex.value = texture ? 1.0 : 0.0;
    const w = Math.max(1, Number(screenW) || 1);
    const h = Math.max(1, Number(screenH) || 1);
    if (u.uCloudShadowBufferSize) u.uCloudShadowBufferSize.value.set(w, h);
  }

  /**
   * Bind overhead roof alpha texture for screen-space gating of window light.
   * This prevents non-overhead window overlays (e.g. background windows) from
   * leaking light onto pixels currently covered by visible overhead tiles.
   * Roof/ceiling screen UVs use `uScreenSize`, which is set only in
 * Sky tint comes from {@link FloorCompositor} via {@link #setSkyState} (SkyColor).
 * When Color Correction time-of-day camera timeline is enabled, the same frame also
 * injects the timeline global tint multiplier so window glow tracks graded day/night.
 *
 * {@link LightingEffectV2}'s `onBindWindowLightPass` (actual `_windowLightRT` size)
 * so `gl_FragCoord` always matches the bound RT. This method binds the texture only.
   * @param {THREE.Texture|null} texture
   * @param {number} screenW - Reserved for API compatibility (ignored).
   * @param {number} screenH - Reserved for API compatibility (ignored).
   */
  setOverheadRoofAlphaTexture(texture, _screenW, _screenH) {
    const u = this._sharedUniforms;
    if (!u) return;
    u.uOverheadRoofAlphaTex.value = texture ?? null;
    u.uHasOverheadRoofAlphaTex.value = texture ? 1.0 : 0.0;
  }

  /**
   * Half-res R = ceiling light transmittance (same RT as LightingEffectV2).
   * When bound, the window shader prefers this over raw roof alpha for gating.
   * @param {THREE.Texture|null} texture
   */
  setCeilingTransmittanceTexture(texture) {
    const u = this._sharedUniforms;
    if (!u) return;
    if (u.uCeilingTransmittance) u.uCeilingTransmittance.value = texture ?? null;
    if (u.uHasCeilingTransmittance) u.uHasCeilingTransmittance.value = texture ? 1.0 : 0.0;
  }

  /**
   * Bind the active-floor `_Outdoors` mask so window glow is limited to indoor pixels.
   * White/outdoor regions are discarded in the overlay shader.
   * @param {THREE.Texture|null} texture
   */
  setOutdoorsMask(texture) {
    this._outdoorsMask = texture ?? null;
    const u = this._sharedUniforms;
    if (texture) this._normalizeOutdoorsMaskTexture(texture);
    if (!u) return;
    u.uOutdoorsMask.value = texture ?? null;
    u.uHasOutdoorsMask.value = texture ? 1.0 : 0.0;
    u.uOutdoorsMaskFlipY.value = texture?.flipY ? 1.0 : 0.0;
  }

  /**
   * Call once per frame after `FloorCompositor` builds `_lightingPerspectiveContext`
   * so window roof gating matches lighting’s multi-floor scale.
   * @param {{ _lightingPerspectiveContext?: object|null, _lightingEffect?: { params?: object }|null }} floorCompositor
   */
  syncFrameOcclusion(floorCompositor) {
    const u = this._sharedUniforms;
    if (!u?.uWindowRoofScreenOcclusionScale) return;
    try {
      const lp = floorCompositor?._lightingPerspectiveContext ?? null;
      const restrict = floorCompositor?._lightingEffect?.params?.restrictRoofScreenLightOcclusionToTopFloor === true;
      const renderFloor = Number.isFinite(this._renderFloorIndex)
        ? Number(this._renderFloorIndex)
        : (lp?.activeFloorIndex ?? 0);
      const scale = lp && typeof lp.getRoofScreenOcclusionScaleForFloor === 'function'
        ? lp.getRoofScreenOcclusionScaleForFloor(renderFloor, restrict)
        : lp && typeof lp.getRoofScreenOcclusionScale === 'function'
          ? lp.getRoofScreenOcclusionScale(restrict)
          : 1.0;
      u.uWindowRoofScreenOcclusionScale.value = scale;
    } catch (_) {
      u.uWindowRoofScreenOcclusionScale.value = 1.0;
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * @private
   * @param {THREE.Texture|null|undefined} texture
   */
  _normalizeOutdoorsMaskTexture(texture) {
    const tex = texture;
    if (!tex || this._normalizedOutdoorsTextures.has(tex)) return;
    const THREE = window.THREE;
    if (!THREE) return;
    let texChanged = false;
    if (tex.wrapS !== THREE.ClampToEdgeWrapping) { tex.wrapS = THREE.ClampToEdgeWrapping; texChanged = true; }
    if (tex.wrapT !== THREE.ClampToEdgeWrapping) { tex.wrapT = THREE.ClampToEdgeWrapping; texChanged = true; }
    if (tex.minFilter !== THREE.LinearFilter) { tex.minFilter = THREE.LinearFilter; texChanged = true; }
    if (tex.magFilter !== THREE.LinearFilter) { tex.magFilter = THREE.LinearFilter; texChanged = true; }
    if (tex.generateMipmaps !== false) { tex.generateMipmaps = false; texChanged = true; }
    if (texChanged) tex.needsUpdate = true;
    this._normalizedOutdoorsTextures.add(tex);
  }

  /** @private */
  _buildOutdoorsClipPass() {
    const THREE = window.THREE;
    if (!THREE) return;

    this._clipTmpNdcVec = new THREE.Vector3();
    this._clipTmpWorldVec = new THREE.Vector3();
    this._clipTmpDirVec = new THREE.Vector3();

    this._outdoorsClipMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tWindowLight: { value: null },
        uOutdoorsMask: { value: null },
        uHasOutdoorsMask: { value: 0.0 },
        uOutdoorsMaskFlipY: { value: 0.0 },
        uViewCorner00: { value: new THREE.Vector2(0, 0) },
        uViewCorner10: { value: new THREE.Vector2(1, 0) },
        uViewCorner01: { value: new THREE.Vector2(0, 1) },
        uViewCorner11: { value: new THREE.Vector2(1, 1) },
        uSceneOrigin: { value: new THREE.Vector2(0, 0) },
        uSceneSize: { value: new THREE.Vector2(1, 1) },
        uSceneDimensions: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tWindowLight;
        uniform sampler2D uOutdoorsMask;
        uniform float uHasOutdoorsMask;
        uniform float uOutdoorsMaskFlipY;
        uniform vec2 uViewCorner00;
        uniform vec2 uViewCorner10;
        uniform vec2 uViewCorner01;
        uniform vec2 uViewCorner11;
        uniform vec2 uSceneOrigin;
        uniform vec2 uSceneSize;
        uniform vec2 uSceneDimensions;
        varying vec2 vUv;

        ${GLSL_SCREEN_TO_SCENE_UV}
        ${GLSL_DECODE_OUTDOORS_MASK}

        void main() {
          vec4 light = texture2D(tWindowLight, vUv);
          if (uHasOutdoorsMask < 0.5) {
            gl_FragColor = light;
            return;
          }

          vec2 sceneUvRaw = msScreenUvToSceneUvRaw(
            vUv, uViewCorner00, uViewCorner10, uViewCorner01, uViewCorner11,
            uSceneOrigin, uSceneSize, uSceneDimensions
          );
          float inScene = msInSceneBounds(sceneUvRaw);
          vec2 maskUv = clamp(sceneUvRaw, 0.0, 1.0);
          if (uOutdoorsMaskFlipY > 0.5) maskUv.y = 1.0 - maskUv.y;

          vec4 od = texture2D(uOutdoorsMask, maskUv);
          float isOutdoor = msDecodeOutdoorsMaskSample(od) * inScene;
          float keepIndoor = 1.0 - isOutdoor;
          gl_FragColor = vec4(light.rgb * keepIndoor, light.a * keepIndoor);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });

    this._outdoorsClipScene = new THREE.Scene();
    this._outdoorsClipCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._outdoorsClipMaterial);
    this._outdoorsClipScene.add(quad);
  }

  /**
   * @private
   * @param {number} w
   * @param {number} h
   * @param {number} [pixelType]
   */
  _ensureOutdoorsClipScratchRT(w, h, pixelType) {
    const THREE = window.THREE;
    if (!THREE) return;
    const type = pixelType ?? THREE.UnsignedByteType;
    const size = this._outdoorsClipScratchSize;
    if (this._outdoorsClipScratchRT
      && size.w === w
      && size.h === h
      && this._outdoorsClipScratchRT.texture?.type === type) {
      return;
    }
    try { this._outdoorsClipScratchRT?.dispose(); } catch (_) {}
    this._outdoorsClipScratchRT = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this._outdoorsClipScratchRT.texture.colorSpace = THREE.LinearSRGBColorSpace;
    size.w = w;
    size.h = h;
  }

  /** @private Match LightingEffectV2 compose: bilinear view corners + scene rect. */
  _syncViewProjectionUniforms(camera) {
    const dims = canvas?.dimensions;
    if (!dims) return;

    const sc = window.MapShine?.sceneComposer;
    const cam = camera ?? sc?.camera;
    if (!cam) return;

    const groundZ = sc?.basePlaneMesh?.position?.z ?? (sc?.groundZ ?? 0);
    const THREE = window.THREE;
    if (!this._clipTmpNdcVec && THREE) {
      this._clipTmpNdcVec = new THREE.Vector3();
      this._clipTmpWorldVec = new THREE.Vector3();
      this._clipTmpDirVec = new THREE.Vector3();
    }

    updateSceneViewProjectionFromCamera(
      cam,
      groundZ,
      this._viewProjectionCache,
      {
        ndc: this._clipTmpNdcVec,
        world: this._clipTmpWorldVec,
        dir: this._clipTmpDirVec,
      },
    );

    applySceneViewProjectionToUniforms(this._viewProjectionCache, this._sharedUniforms);
    applySceneViewProjectionToUniforms(this._viewProjectionCache, this._outdoorsClipMaterial?.uniforms);

    const fd = this._lastFoundrySceneData
      ?? sc?.foundrySceneData
      ?? null;
    const sr = dims.sceneRect ?? dims;
    const sceneX = Number(fd?.sceneX ?? sr?.x ?? 0);
    const sceneY = Number(fd?.sceneY ?? sr?.y ?? 0);
    const sceneW = Number(fd?.sceneWidth ?? fd?.width ?? sr?.width ?? dims.width ?? 1);
    const sceneH = Number(fd?.sceneHeight ?? fd?.height ?? sr?.height ?? dims.height ?? 1);
    const canvasW = Number(fd?.width ?? dims.width ?? 1);
    const canvasH = Number(fd?.height ?? dims.height ?? 1);

    const sceneTargets = [this._sharedUniforms, this._outdoorsClipMaterial?.uniforms];
    for (const u of sceneTargets) {
      if (!u) continue;
      u.uSceneOrigin?.value?.set(sceneX, sceneY);
      u.uSceneSize?.value?.set(sceneW, sceneH);
      u.uSceneDimensions?.value?.set(canvasW, canvasH);
    }
  }

  /** @private */
  _updateViewBounds() {
    this._syncViewProjectionUniforms(null);
  }

  /** @private */
  _updateSceneBounds() {
    const u = this._sharedUniforms;
    if (!u?.uSceneBounds || !u?.uSceneDimensions) return;

    const fd = this._lastFoundrySceneData
      ?? window.MapShine?.sceneComposer?.foundrySceneData
      ?? null;
    const dims = canvas?.dimensions;
    const sr = dims?.sceneRect ?? dims;
    const sceneX = Number(fd?.sceneX ?? sr?.x ?? 0);
    const sceneY = Number(fd?.sceneY ?? sr?.y ?? 0);
    const sceneW = Number(fd?.sceneWidth ?? fd?.width ?? sr?.width ?? dims?.width ?? 1);
    const sceneH = Number(fd?.sceneHeight ?? fd?.height ?? sr?.height ?? dims?.height ?? 1);
    const canvasW = Number(fd?.width ?? dims?.width ?? 1);
    const canvasH = Number(fd?.height ?? dims?.height ?? 1);

    if (fd && Number(fd.height) > 0 && Number(fd.width) > 0) {
      u.uSceneBounds.value.set(sceneX, sceneY, sceneW, sceneH);
      u.uSceneDimensions.value.set(canvasW, canvasH);
    } else if (dims) {
      u.uSceneBounds.value.set(
        sr?.x ?? 0,
        sr?.y ?? 0,
        sr?.width ?? dims.width ?? 1,
        sr?.height ?? dims.height ?? 1,
      );
      u.uSceneDimensions.value.set(dims.width ?? 1, dims.height ?? 1);
    }

    u.uSceneOrigin?.value?.set(sceneX, sceneY);
    u.uSceneSize?.value?.set(sceneW, sceneH);
  }

  /** @private */
  _readTodIntensityPercent(index) {
    const key = `tod${index}IntensityPercent`;
    const raw = Number(this.params[key]);
    if (!Number.isFinite(raw)) return 100.0;
    return Math.max(0.0, Math.min(200.0, raw));
  }

  /**
   * Smooth 24h blend of per-anchor intensity percentages (returns 0–2 for 0–200%).
   * @private
   */
  _evaluateTodIntensityMultiplier(hourRaw) {
    const hour = wrapHour24(hourRaw);
    const anchors = DEFAULT_TOD_ANCHOR_HOURS.map((anchorHour, index) => ({
      hour: anchorHour,
      percent: this._readTodIntensityPercent(index),
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
    const blendedPercent = lerp(prev.percent, next.percent, t);
    return blendedPercent / 100.0;
  }

  _buildSharedUniforms() {
    const THREE = window.THREE;
    if (!THREE) return;

    const c = this.params.color;
    const cr = (c && typeof c === 'object') ? (Number(c.r) || 0) : 1.0;
    const cg = (c && typeof c === 'object') ? (Number(c.g) || 0) : 0.96;
    const cb = (c && typeof c === 'object') ? (Number(c.b) || 0) : 0.85;

    if (this._outdoorsMask) this._normalizeOutdoorsMaskTexture(this._outdoorsMask);

    this._sharedUniforms = {
      uEffectEnabled: { value: this._enabled ? 1.0 : 0.0 },
      uTime: { value: 0.0 },
      uIntensity: { value: Math.max(0.0, Number(this.params.intensity) || 0) },
      uFalloff: { value: Math.max(0.01, Number(this.params.falloff) || 1) },
      uColor: { value: new THREE.Color(cr, cg, cb) },
      uFlickerEnabled: { value: 0.0 },
      uFlickerSpeed: { value: 0.35 },
      uFlickerAmount: { value: 0.15 },
      uSkyTintColor: { value: new THREE.Color(1, 1, 1) },
      uUseSkyTint: { value: this.params.useSkyTint ? 1.0 : 0.0 },
      uSkyTintStrength: { value: Math.max(0.0, Number(this.params.skyTintStrength) || 0.0) },
      uTodCameraTintColor: { value: new THREE.Color(1, 1, 1) },
      uTodCameraTintInterior: { value: new THREE.Color(1, 1, 1) },
      uTodCameraTintActive: { value: 0.0 },
      uTodCameraTintStrength: { value: Math.max(0.0, Number(this.params.todCameraTintStrength) || 0.0) },
      uNightFactor: { value: 1.0 },
      uSunDir: { value: new THREE.Vector2(0, -1) },
      uSunTrackEnabled: { value: this.params.sunLightEnabled ? 1.0 : 0.0 },
      uSunLightLength: { value: Math.max(0.0, Number(this.params.sunLightLength) || 0.0) },
      uCloudFactor: { value: 1.0 },
      uCloudInfluence: { value: Math.max(0.0, Math.min(1.0, Number(this.params.cloudInfluence) || 0.0)) },
      uCloudShadowTex: { value: null },
      uHasCloudShadowTex: { value: 0.0 },
      uScreenSize: { value: new THREE.Vector2(1, 1) },
      uCloudShadowBufferSize: { value: new THREE.Vector2(1, 1) },
      uCloudShadowContrast: { value: Math.max(0.0, Number(this.params.cloudShadowContrast) || 1.0) },
      uCloudShadowBias: { value: Number(this.params.cloudShadowBias) || 0.0 },
      uCloudShadowGamma: { value: Math.max(0.01, Number(this.params.cloudShadowGamma) || 1.0) },
      uCloudShadowMinLight: { value: Math.max(0.0, Math.min(1.0, Number(this.params.cloudShadowMinLight) || 0.0)) },
      uOverheadRoofAlphaTex: { value: null },
      uHasOverheadRoofAlphaTex: { value: 0.0 },
      uCeilingTransmittance: { value: null },
      uHasCeilingTransmittance: { value: 0.0 },
      uWindowRoofScreenOcclusionScale: { value: 1.0 },
      uLightOverheadTiles: { value: this.params.lightOverheadTiles ? 1.0 : 0.0 },
      uOverheadLightIntensity: { value: Math.max(0.0, Math.min(1.0, Number(this.params.overheadLightIntensity) || 0.0)) },
      uRainAmount: { value: 0.0 },
      uRainSpeed: { value: Math.max(0.0, Number(this.params.rainOnGlassSpeed) || 0.0) },
      uRainDir: { value: new THREE.Vector2(0, -1) },
      uRainMaxOffsetPx: { value: Math.max(0.0, Number(this.params.rainOnGlassMaxOffsetPx) || 0.0) },
      uRainDarken: { value: Math.max(0.0, Math.min(1.0, Number(this.params.rainOnGlassDarken) || 0.0)) },
      // RGB shift (chromatic dispersion) — pixel offset split into R/B channels.
      uRgbShiftAmount: { value: Math.max(0.0, Number(this.params.rgbShiftAmount) || 0) },
      uRgbShiftAngle: { value: (Number(this.params.rgbShiftAngle) || 0) * (Math.PI / 180.0) },
      uOutdoorsMask: { value: this._outdoorsMask },
      uHasOutdoorsMask: { value: this._outdoorsMask ? 1.0 : 0.0 },
      uOutdoorsMaskFlipY: { value: 0.0 },
      uViewBoundsMin: { value: new THREE.Vector2(0, 0) },
      uViewBoundsMax: { value: new THREE.Vector2(1, 1) },
      uViewCorner00: { value: new THREE.Vector2(0, 0) },
      uViewCorner10: { value: new THREE.Vector2(1, 0) },
      uViewCorner01: { value: new THREE.Vector2(0, 1) },
      uViewCorner11: { value: new THREE.Vector2(1, 1) },
      uSceneOrigin: { value: new THREE.Vector2(0, 0) },
      uSceneSize: { value: new THREE.Vector2(1, 1) },
      uSceneBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
      uSceneDimensions: { value: new THREE.Vector2(1, 1) },
      // uWindowTexelSize and uMask are per-overlay only (set in _createOverlay).
    };
  }

  _createOverlay(tileId, floorIndex, { maskUrl, centerX, centerY, w, h, z, rotation, intensityMultiplier = 1.0, isOverhead = false, gen = null }) {
    const THREE = window.THREE;
    if (!THREE || !this._sharedUniforms) return;

    const geo = new THREE.PlaneGeometry(w, h);

    // uWindowTexelSize is per-overlay because each tile has its own pixel dimensions.
    // It is updated once the texture loads (actual texel size from tex.image).
    // uMask and uMaskReady are also per-overlay.
    // All other uniforms reference the shared objects so param changes propagate
    // to every overlay without iterating them.
    const uniforms = {
      ...this._sharedUniforms,
      uMask: { value: null },
      uMaskReady: { value: 0.0 },
      uOverlayIntensity: { value: Math.max(0.0, Number(intensityMultiplier) || 0.0) },
      // Overhead roof gating is only intended for non-overhead overlays
      // (e.g. background windows), not overhead-tile window overlays.
      uIsOverheadOverlay: { value: isOverhead ? 1.0 : 0.0 },
      // All non-overhead window glow on the active floor must respect roof/ceiling
      // (see syncFrameOcclusion + ceiling transmittance). Legacy ground-only gate
      // left upper floors with uAllowRoofGate=0 so glow leaked through slabs.
      uAllowRoofGate: { value: isOverhead ? 0.0 : 1.0 },
      // 1/texWidth, 1/texHeight — set once texture loads.
      uWindowTexelSize: { value: new THREE.Vector2(1.0 / w, 1.0 / h) },
      // World-space delta per +1.0 in overlay UV (accounts for tile size + rotation).
      uWorldPerUvX: { value: new THREE.Vector2(w, 0) },
      uWorldPerUvY: { value: new THREE.Vector2(0, h) },
    };

    const cosR = Math.cos(rotation);
    const sinR = Math.sin(rotation);
    uniforms.uWorldPerUvX.value.set(cosR * w, sinR * w);
    uniforms.uWorldPerUvY.value.set(-sinR * h, cosR * h);

    const material = new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        varying vec2 vUv;
        varying vec2 vWorldXY;
        void main() {
          vUv = uv;
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldXY = worldPos.xy;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform float uEffectEnabled;
        uniform float uTime;
        uniform float uIntensity;
        uniform float uFalloff;
        uniform vec3  uColor;
        uniform float uFlickerEnabled;
        uniform float uFlickerSpeed;
        uniform float uFlickerAmount;
        uniform vec3  uSkyTintColor;
        uniform float uUseSkyTint;
        uniform float uSkyTintStrength;
        uniform vec3  uTodCameraTintColor;
        uniform vec3  uTodCameraTintInterior;
        uniform float uTodCameraTintActive;
        uniform float uTodCameraTintStrength;
        uniform float uNightFactor;
        uniform vec2  uSunDir;
        uniform float uSunTrackEnabled;
        uniform float uSunLightLength;
        uniform float uCloudFactor;
        uniform float uCloudInfluence;
        uniform sampler2D uCloudShadowTex;
        uniform float uHasCloudShadowTex;
        uniform vec2  uScreenSize;
        uniform vec2  uCloudShadowBufferSize;
        uniform float uCloudShadowContrast;
        uniform float uCloudShadowBias;
        uniform float uCloudShadowGamma;
        uniform float uCloudShadowMinLight;
        uniform sampler2D uOverheadRoofAlphaTex;
        uniform float uHasOverheadRoofAlphaTex;
        uniform sampler2D uCeilingTransmittance;
        uniform float uHasCeilingTransmittance;
        uniform float uWindowRoofScreenOcclusionScale;
        uniform float uLightOverheadTiles;
        uniform float uOverheadLightIntensity;
        uniform float uRainAmount;
        uniform float uRainSpeed;
        uniform vec2  uRainDir;
        uniform float uRainMaxOffsetPx;
        uniform float uRainDarken;
        uniform float uRgbShiftAmount;
        uniform float uRgbShiftAngle;
        uniform float uOverlayIntensity;
        uniform float uIsOverheadOverlay;
        uniform float uAllowRoofGate;
        uniform vec2  uWindowTexelSize;
        uniform vec2  uWorldPerUvX;
        uniform vec2  uWorldPerUvY;
        uniform sampler2D uMask;
        uniform float uMaskReady;
        uniform sampler2D uOutdoorsMask;
        uniform float uHasOutdoorsMask;
        uniform float uOutdoorsMaskFlipY;
        uniform vec2 uViewBoundsMin;
        uniform vec2 uViewBoundsMax;
        uniform vec2 uViewCorner00;
        uniform vec2 uViewCorner10;
        uniform vec2 uViewCorner01;
        uniform vec2 uViewCorner11;
        uniform vec2 uSceneOrigin;
        uniform vec2 uSceneSize;
        uniform vec4 uSceneBounds;
        uniform vec2 uSceneDimensions;
        varying vec2 vUv;
        varying vec2 vWorldXY;

        ${GLSL_SCREEN_TO_SCENE_UV}
        ${GLSL_DECODE_OUTDOORS_MASK}

        float msLuminance(vec3 c) {
          return dot(c, vec3(0.2126, 0.7152, 0.0722));
        }

        vec2 worldToSceneUv(vec2 worldXY) {
          return msWorldToSceneUvRaw(worldXY, uSceneOrigin, uSceneSize, uSceneDimensions);
        }

        float sampleOutdoorStrength(vec2 sceneUvRaw) {
          if (uHasOutdoorsMask < 0.5) return 0.0;
          float inScene = msInSceneBounds(sceneUvRaw);
          if (inScene < 0.5) return 1.0;
          vec2 maskUv = clamp(sceneUvRaw, 0.0, 1.0);
          if (uOutdoorsMaskFlipY > 0.5) maskUv.y = 1.0 - maskUv.y;
          return msDecodeOutdoorsMaskSample(texture2D(uOutdoorsMask, maskUv));
        }

        vec2 uvOffsetToWorld(vec2 uvDelta) {
          return uWorldPerUvX * uvDelta.x + uWorldPerUvY * uvDelta.y;
        }

        float outdoorStrengthAtWorld(vec2 worldXY) {
          return sampleOutdoorStrength(worldToSceneUv(worldXY));
        }

        float outdoorStrengthAtScreen(vec2 screenUv) {
          vec2 sceneUvRaw = msScreenUvToSceneUvRaw(
            screenUv, uViewCorner00, uViewCorner10, uViewCorner01, uViewCorner11,
            uSceneOrigin, uSceneSize, uSceneDimensions
          );
          return sampleOutdoorStrength(sceneUvRaw);
        }

        float msHash12(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }

        void main() {
          // Discard until the mask texture has finished loading to avoid
          // white-tile flash caused by sampling a null/uninitialized sampler.
          if (uEffectEnabled < 0.5 || uMaskReady < 0.5) discard;

          vec2 sunOffset = (uSunTrackEnabled > 0.5) ? (uSunDir * uSunLightLength) : vec2(0.0);
          vec2 rainDir = normalize((length(uRainDir) > 0.001) ? uRainDir : vec2(0.0, -1.0));
          float rainPhase = uTime * max(uRainSpeed, 0.001);
          vec2 rainNoiseUv = vec2(vUv.x * 110.0, vUv.y * 180.0 - rainPhase * 7.5);
          float rainNoise = msHash12(floor(rainNoiseUv));
          float rainStrand = smoothstep(0.78, 0.98, rainNoise) * clamp(uRainAmount, 0.0, 1.0);
          vec2 rainOffset = rainDir * (uRainMaxOffsetPx * rainStrand) * uWindowTexelSize;
          vec2 maskOffsetUv = sunOffset + rainOffset;

          // _Outdoors: gate destination screen pixel (bilinear ground projection)
          // and the world position that owns the shifted mask sample.
          vec2 screenUv = gl_FragCoord.xy / max(uScreenSize, vec2(1.0));
          float outdoorAtDest = outdoorStrengthAtScreen(screenUv);
          float indoorW = clamp(1.0 - outdoorAtDest, 0.0, 1.0);
          float outdoorAtSrc = outdoorStrengthAtWorld(vWorldXY + uvOffsetToWorld(maskOffsetUv));
          if (max(outdoorAtDest, outdoorAtSrc) > 0.45) discard;

          // Boundary alpha check at the shifted UV — cuts out areas outside
          // the map tile footprint.
          vec2 baseUv = clamp(vUv + maskOffsetUv, 0.001, 0.999);
          vec4 mCenter = texture2D(uMask, baseUv);
          // Strict alpha coverage: transparent mask pixels emit no light.
          // This prevents full-tile leakage when RGB contains residual values
          // outside intended window bounds.
          float boundaryCoverage = mCenter.a;
          if (boundaryCoverage < 0.01) discard;

          // RGB Shift (chromatic dispersion / refraction):
          // Sample the mask three times — R channel offset forward along the
          // shift direction, G channel unshifted, B channel offset backward.
          // This replicates the V1 WindowLightEffect refraction behaviour.
          vec2 shiftDir = vec2(cos(uRgbShiftAngle), sin(uRgbShiftAngle));
          vec2 rOffset  = shiftDir * uRgbShiftAmount * uWindowTexelSize;
          vec2 bOffset  = -rOffset;

          vec4 tapR = texture2D(uMask, clamp(baseUv + rOffset, 0.001, 0.999));
          vec4 tapC = mCenter;
          vec4 tapB = texture2D(uMask, clamp(baseUv + bOffset, 0.001, 0.999));
          vec3 sampleR = tapR.rgb;
          vec3 sampleC = tapC.rgb;
          vec3 sampleB = tapB.rgb;
          // Preserve mask chroma when available (_Windows/_Structural can be tinted).
          // Keep RGB shift behaviour by taking channel-aligned taps.
          vec3 maskRgb = vec3(sampleR.r, sampleC.g, sampleB.b);

          // Luminance still drives cheap reject and overall energy.
          float maskScalar = msLuminance(maskRgb);
          if (maskScalar <= 0.001) discard;

          // Shift taps must also obey strict alpha to prevent fringe leakage.
          float alphaCovR = tapR.a;
          float alphaCovC = tapC.a;
          float alphaCovB = tapB.a;
          vec3 alphaGate = vec3(alphaCovR, alphaCovC, alphaCovB);

          // Shape with gamma-like falloff — matches V1 uFalloff usage.
          // Apply falloff per-channel so mask tint and RGB split remain visible.
          vec3 shaped = pow(clamp(maskRgb, 0.0, 1.0), vec3(uFalloff)) * clamp(alphaGate, 0.0, 1.0);

          // Per-channel outdoors at each mask tap (RGB shift uses extra UV offsets).
          vec3 indoorGate = vec3(
            1.0 - step(0.45, outdoorStrengthAtWorld(vWorldXY + uvOffsetToWorld(maskOffsetUv + rOffset))),
            1.0 - step(0.45, outdoorStrengthAtWorld(vWorldXY + uvOffsetToWorld(maskOffsetUv))),
            1.0 - step(0.45, outdoorStrengthAtWorld(vWorldXY + uvOffsetToWorld(maskOffsetUv + bOffset)))
          );
          shaped *= indoorGate;

          // Optional subtle flicker.
          float flicker = 1.0;
          if (uFlickerEnabled > 0.5) {
            // Use two sine frequencies for a less mechanical flicker.
            float s = sin(uTime * 6.28318 * uFlickerSpeed)
                    * 0.7 + sin(uTime * 6.28318 * uFlickerSpeed * 2.73) * 0.3;
            flicker = 1.0 + s * uFlickerAmount;
          }

          // The _Windows mask is a greyscale luminance/shape map — its RGB
          // channels are all equal and carry no color information. Use the
          // per-channel shaped luminance directly and tint with uColor only.
          // This matches V1 behaviour: mask drives shape, uColor drives tint.
          // Keep midday light warmer by reducing cool-sky tint bias when darkness is low.
          float dayWarmth = clamp((uNightFactor - 0.55) / 0.45, 0.0, 1.0);
          vec3 skyTint = max(uSkyTintColor, vec3(0.01));
          skyTint.b = mix(skyTint.b, min(skyTint.b, 1.0), dayWarmth * 0.6);
          float skyMix = (uUseSkyTint > 0.5) ? (1.0 - exp(-max(uSkyTintStrength, 0.0) * 0.42)) : 0.0;
          vec3 tintColor = mix(vec3(1.0), skyTint, clamp(skyMix, 0.0, 1.0));
          // Keep daytime windows from drifting too cool under strong sky tint.
          float warmDayFactor = clamp((uNightFactor - 0.45) / 0.55, 0.0, 1.0);
          vec3 daylightWarmTint = vec3(1.05, 1.0, 0.94);
          vec3 envTintColor = mix(tintColor, tintColor * daylightWarmTint, 0.16 * warmDayFactor);

          vec3 todTintGlobal = clamp(uTodCameraTintColor, vec3(0.0), vec3(10.0));
          vec3 todTintInterior = clamp(uTodCameraTintInterior, vec3(0.0), vec3(10.0));
          vec3 todTint = mix(todTintGlobal, todTintInterior, indoorW);
          float todMix = (uTodCameraTintActive > 0.5)
            ? (1.0 - exp(-max(uTodCameraTintStrength, 0.0) * 0.42))
            : 0.0;
          vec3 todMul = mix(vec3(1.0), todTint, clamp(todMix, 0.0, 1.0));
          envTintColor *= todMul;

          float cloudDimming = mix(1.0, clamp(uCloudFactor, 0.0, 1.0), clamp(uCloudInfluence, 0.0, 1.0));
          float cloudShadow = 1.0;
          if (uHasCloudShadowTex > 0.5) {
            // Always sample in drawing-buffer / RT pixel space. ShadowManager + cloud
            // targets are filled per screen texel; world-XY remap via view bounds can
            // disagree with gl_FragCoord by epsilon under pan/zoom (projection vs float),
            // which high-contrast shadow curves turn into visible flicker.
            vec2 shadowUv = gl_FragCoord.xy / max(uCloudShadowBufferSize, vec2(1.0));
            float s = clamp(texture2D(uCloudShadowTex, clamp(shadowUv, 0.0, 1.0)).r, 0.0, 1.0);
            s = clamp((s - 0.5) * max(uCloudShadowContrast, 0.0) + 0.5 + uCloudShadowBias, 0.0, 1.0);
            s = pow(s, max(uCloudShadowGamma, 0.01));
            cloudShadow = max(s, clamp(uCloudShadowMinLight, 0.0, 1.0));
          }
          float rainDarkenMul = 1.0 - clamp(uRainDarken, 0.0, 1.0) * clamp(uRainAmount, 0.0, 1.0) * 0.35;

          float ceilingMul = 1.0;
          // Apply roof / ceiling gating only to non-overhead overlays.
          if (uAllowRoofGate > 0.5 && uIsOverheadOverlay < 0.5) {
            vec2 roofUv = gl_FragCoord.xy / max(uScreenSize, vec2(1.0));
            if (uHasCeilingTransmittance > 0.5) {
              // Same transmittance T as LightingEffectV2 (1 = light passes).
              // When "Light Overheads" is enabled, visible roof/overhead pixels are
              // receivers too, not just blockers. The raw transmittance texture is near
              // zero there, so mix it open by roof alpha using the overhead controls.
              ceilingMul = clamp(texture2D(uCeilingTransmittance, clamp(roofUv, 0.0, 1.0)).r, 0.0, 1.0);
              if (uHasOverheadRoofAlphaTex > 0.5 && uLightOverheadTiles > 0.5) {
                vec4 roofSample = texture2D(uOverheadRoofAlphaTex, clamp(roofUv, 0.0, 1.0));
                float roofAlpha = clamp(max(roofSample.r, roofSample.a), 0.0, 1.0);
                float overheadAllow = clamp(uOverheadLightIntensity, 0.0, 1.0) * roofAlpha;
                ceilingMul = mix(ceilingMul, 1.0, overheadAllow);
              }
            } else if (uHasOverheadRoofAlphaTex > 0.5) {
              vec4 roofSample = texture2D(uOverheadRoofAlphaTex, clamp(roofUv, 0.0, 1.0));
              float roofAlpha = clamp(max(roofSample.r, roofSample.a), 0.0, 1.0);
              if (uLightOverheadTiles < 0.5) {
                ceilingMul = 1.0 - roofAlpha;
              } else {
                float overheadAllow = clamp(uOverheadLightIntensity, 0.0, 1.0);
                ceilingMul = mix(1.0 - roofAlpha, 1.0, overheadAllow);
              }
            }
            float gateScale = clamp(uWindowRoofScreenOcclusionScale, 0.0, 1.0);
            ceilingMul = mix(1.0, ceilingMul, gateScale);
          }

          vec3 lightOut = shaped * (uColor * envTintColor) * uIntensity * flicker * max(uNightFactor, 0.0) * cloudDimming * cloudShadow * rainDarkenMul * max(uOverlayIntensity, 0.0) * ceilingMul;

          // Output raw linear light — no tone mapping on additive overlays.
          // AdditiveBlending: dst += src.rgb * src.a. Alpha=1 so the full
          // light value is added; intensity is baked into RGB.
          gl_FragColor = vec4(lightOut, 1.0);
        }
      `,
    });

    // Prevent tone mapping from dimming additive glow.
    material.toneMapped = false;

    const mesh = new THREE.Mesh(geo, material);
    mesh.frustumCulled = false;
    mesh.position.set(centerX, centerY, z);
    mesh.rotation.z = rotation;
    mesh.userData.floorIndex = Math.max(0, Number(floorIndex) || 0);
    // Background sits under per-tile overlays; higher floors draw after lower so
    // stacked buildings don't lose upper-floor window light to sort instability.
    const fi = mesh.userData.floorIndex;
    const isBgKey = typeof tileId === 'string' && tileId.startsWith('__bg_image__');
    mesh.renderOrder = (isBgKey ? 30 : 40) + fi * 100;

    // Add to the isolated window light scene (not the bus scene).
    // Floor visibility is managed by onFloorChange() instead of the bus.
    mesh.visible = this._isFloorVisible(floorIndex);
    this._scene.add(mesh);
    this._overlays.set(tileId, { mesh, material, floorIndex, isOverhead: !!isOverhead });

    // Load texture asynchronously.
    const loader = new THREE.TextureLoader();
    loader.load(maskUrl, (tex) => {
      if (gen != null && this._populateGeneration !== gen) return;
      // Window masks are greyscale luminance/shape data — treat as linear.
      // Setting SRGBColorSpace would gamma-decode the mask values, making the
      // shape brighter than intended and breaking the luminance-driven falloff.
      tex.colorSpace = THREE.NoColorSpace;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;

      // Update texel size from actual image dimensions so the RGB shift is
      // expressed in true pixels regardless of tile display size.
      const imgW = tex.image?.width ?? w;
      const imgH = tex.image?.height ?? h;
      material.uniforms.uWindowTexelSize.value.set(1.0 / imgW, 1.0 / imgH);

      material.uniforms.uMask.value = tex;
      material.uniforms.uMaskReady.value = 1.0;
      material.needsUpdate = true;
    }, undefined, () => {
      if (gen != null && this._populateGeneration !== gen) return;
      log.warn(`Failed to load window mask for tile ${tileId}: ${maskUrl}`);
    });
  }

  // Exact copy of SpecularEffectV2._resolveFloorIndex — must stay in sync.
  _resolveFloorIndex(tileDoc, floors) {
    if (!floors || floors.length <= 1) return 0;

    if (tileHasLevelsRange(tileDoc)) {
      const flags = readTileLevelsFlags(tileDoc);
      const tileBottom = Number(flags.rangeBottom);
      const tileTop = Number(flags.rangeTop);
      const topFinite = Number.isFinite(tileTop);
      const tileMid = topFinite ? ((tileBottom + tileTop) / 2) : tileBottom;

      // Prefer anchoring by rangeBottom (Levels semantics), then midpoint.
      // This prevents open-ended or boundary-aligned upper-floor ranges from
      // being classified into lower floor bands.
      if (Number.isFinite(tileBottom)) {
        for (let i = 0; i < floors.length; i++) {
          const f = floors[i];
          const isLast = i === floors.length - 1;
          if (tileBottom >= f.elevationMin && (tileBottom < f.elevationMax || (isLast && tileBottom <= f.elevationMax))) return i;
        }
      }

      if (Number.isFinite(tileMid)) {
        for (let i = 0; i < floors.length; i++) {
          const f = floors[i];
          const isLast = i === floors.length - 1;
          if (tileMid >= f.elevationMin && (tileMid < f.elevationMax || (isLast && tileMid <= f.elevationMax))) return i;
        }
      }
      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        if (tileBottom <= f.elevationMax && f.elevationMin <= tileTop) return i;
      }
    }

    const v14Idx = resolveV14NativeDocFloorIndexMin(tileDoc, globalThis.canvas?.scene);
    if (v14Idx !== null) return v14Idx;

    const elev = Number.isFinite(Number(tileDoc?.elevation)) ? Number(tileDoc.elevation) : 0;
    for (let i = 0; i < floors.length; i++) {
      const f = floors[i];
      if (elev >= f.elevationMin && elev <= f.elevationMax) return i;
    }
    return 0;
  }

  _isFloorVisible(floorIndex) {
    const renderFloor = Number(this._renderFloorIndex);
    if (Number.isFinite(renderFloor)) {
      if (this._renderFloorSliceStrict) return Number(floorIndex) === renderFloor;
      return Number(floorIndex) <= renderFloor;
    }
    const active = Number.isFinite(this._activeFloorIndex) ? this._activeFloorIndex : 0;
    // Mirror FloorRenderBus.setVisibleFloors(): show all floors up to the
    // currently visible max floor in normal (non per-slice) mode.
    return Number(floorIndex) <= active;
  }
}
