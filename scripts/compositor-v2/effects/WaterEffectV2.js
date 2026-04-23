/**
 * @fileoverview WaterEffectV2 — V2 water post-processing pass.
 *
 * HEALTH-WIRING BADGE (Map Shine Breaker Box):
 * If you change this effect's lifecycle, core resources, floor behavior, or
 * dependency bindings, you MUST update HealthEvaluator contracts/wiring for
 * `WaterEffectV2` to prevent silent failures.
 *
 * Applies water tint, wave distortion, caustics, specular (GGX), foam, murk,
 * rain ripples, and chromatic aberration to water areas defined by
 * `_Water` mask textures.
 *
 * Architecture:
 *   1. `populate()` discovers per-tile `_Water` masks via `probeMaskFile()`.
 *   2. Per-floor masks are composited into a single RT by rendering white quads
 *      masked by the water texture into a scene-sized render target.
 *   3. An internal water-data builder converts the composited mask into
 *      composited mask (R=SDF, G=exposure, BA=normals).
 *   4. The fullscreen water shader reads tWaterData + scene RT to produce the
 *      refracted/tinted/specular output as a post-processing pass.
 *
 * Simplifications vs V1 (layered in as V2 systems come online):
 *   - No EffectMaskRegistry / GpuSceneMaskCompositor
 *   - No DistortionManager integration
 *   - No token mask / cloud shadow / outdoors mask
 *   - No floor transition locks (bus visibility handles floor isolation)
 *
 * Multi-floor: slices without local `_Water` may **borrow** the nearest lower
 * floor's packed mask for that slice's post pass (`uCrossSliceWaterData`). The
 * water shader punches opaque deck/tiles over **borrowed** water using
 * per-slice `tSliceAlpha` at the same vUv as `tDiffuse` (camera RT), with a softer
 * smoothstep than the original 0.05–0.96 ramp. Native water is not slice-punched
 * (levelSceneRT alpha is not reliable vs river holes on many maps).
 *
 * @module compositor-v2/effects/WaterEffectV2
 */

import { createLogger } from '../../core/log.js';
import { weatherController } from '../../core/WeatherController.js';
import { probeMaskFile } from '../../assets/loader.js';
import {
  tileHasLevelsRange,
  readTileLevelsFlags,
  getViewedLevelBackgroundSrc,
  getVisibleLevelBackgroundLayers,
} from '../../foundry/levels-scene-flags.js';
import { DepthShaderChunks } from '../../effects/DepthShaderChunks.js';
import { VisionSDF } from '../../vision/VisionSDF.js';
import { getVertexShader, getFragmentShader, getFragmentShaderSafe } from './water-shader.js';
import { safeBuildShaderMaterial } from '../../core/diagnostics/SafeShaderBuilder.js';

const log = createLogger('WaterEffectV2');

const WATER_MASK_FORMATS = ['webp', 'png', 'jpg', 'jpeg'];

// Heavy fragment shader: short timeouts yield false "failures" under GPU load.
const WATER_SHADER_COMPILE_TIMEOUT_MS = 30000;
const WATER_SHADER_COMPILE_MAX_ATTEMPTS = 4;

// Bitmask flags for conditional shader defines.
const DEF_FOAM_FLECKS = 1 << 0;
const DEF_MULTITAP    = 1 << 1;

/**
 * Return v when it is a finite number, otherwise return fallback.
 * Unlike the ?? operator this also catches NaN and Infinity which can
 * leak in from corrupted scene flags or stale preset data.
 * @param {*} v
 * @param {number} fallback
 * @returns {number}
 */
function safeNum(v, fallback) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v : fallback;
}

/**
 * Accept either 0..1 or 0..255 color channels and normalize to 0..1.
 * This keeps V2 tolerant of legacy V1 preset values.
 * @param {{r:number,g:number,b:number}|null|undefined} c
 * @param {{r:number,g:number,b:number}} fallback
 * @returns {{r:number,g:number,b:number}}
 */
function normalizeRgb01(c, fallback = { r: 0, g: 0, b: 0 }) {
  if (!c || typeof c !== 'object') return fallback;
  let r = typeof c.r === 'number' ? c.r : fallback.r;
  let g = typeof c.g === 'number' ? c.g : fallback.g;
  let b = typeof c.b === 'number' ? c.b : fallback.b;
  const maxv = Math.max(r, g, b);
  if (maxv > 1.0) {
    r /= 255.0;
    g /= 255.0;
    b /= 255.0;
  }
  return {
    r: Math.max(0.0, Math.min(1.0, r)),
    g: Math.max(0.0, Math.min(1.0, g)),
    b: Math.max(0.0, Math.min(1.0, b)),
  };
}

// ─── WaterEffectV2 ──────────────────────────────────────────────────────────

export class WaterEffectV2 {
  constructor() {
    /** @type {boolean} */
    this._initialized = false;
    /** @type {boolean} */
    this.enabled = true;
    /** @type {boolean} */
    this._hasAnyWaterData = false;

    /** @type {string} */
    this._instanceId = `we2_${Math.random().toString(16).slice(2, 8)}`;

    // Cache for direct mask probing so we don't repeatedly 404-spam hosted setups.
    // Key: basePathWithSuffix + formats. Value: { url, image } or null when missing.
    this._directMaskCache = new Map();

    // Cache for specular highlights sun direction
    this._cachedHlSunAzDeg = null;
    this._cachedHlSunElDeg = null;
    this._cachedHlSunDirX = 0.5;
    this._cachedHlSunDirY = 0.5;
    this._cachedHlSunDirZ = 0.707;

    /** @type {THREE.WebGLMultipleRenderTargets|null} */
    this._waterMrt = null;
    /** @type {THREE.Scene|null} */
    this._blitCopyScene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._blitCopyCamera = null;
    /** @type {THREE.MeshBasicMaterial|null} */
    this._blitCopyMaterial = null;
    /** @type {THREE.Mesh|null} */
    this._blitCopyQuad = null;
    /** @type {number} Cached 0/1 for USE_WATER_SPEC_BLOOM_RT define */
    this._lastBloomMrtModeKey = -1;

    // Deferred shader compilation state
    /** @type {boolean} True when heavy shader has been compiled */
    this._realShaderCompiled = false;
    /** @type {boolean} True when real shader compilation is in progress */
    this._shaderCompilePending = false;
    /** @type {Promise<void>|null} Promise tracking async shader readiness */
    this._shaderReadyPromise = null;
    /** @type {number} `performance.now()` — delay starting another compile after a timeout. */
    this._waterCompileRetryAfterMs = 0;
    /** @type {number} Consecutive timeout/fallback builds (reset on real success). */
    this._waterShaderCompileFailures = 0;

    // ── Effect parameters ────────────────────────────────────────────────
    this.params = {
      // Tint
      tintColor: { r: 0.02, g: 0.18, b: 0.28 },
      tintStrength: 0.36,

      // Waves
      waveScale: 16.0,
      // Global multiplier on wind-mapped wave speed (see waveSpeedWind* factors).
      waveSpeed: 1.0,
      waveStrength: 2.0,
      distortionStrengthPx: 24.0,
      waveWarpLargeStrength: 0.15,
      waveWarpSmallStrength: 0.08,
      waveWarpMicroStrength: 0.04,
      waveWarpTimeSpeed: 0.15,

      waveBreakupStrength: 1.0,
      waveBreakupScale: 218.5,
      waveBreakupSpeed: 0.86,
      waveBreakupWarp: 2.0,
      waveBreakupDistortionStrength: 0.12,
      waveBreakupSpecularStrength: 0.34,

      waveMicroNormalStrength: 0.22,
      waveMicroNormalScale: 300.0,
      waveMicroNormalSpeed: 1.5,
      waveMicroNormalWarp: 0.54,
      waveMicroNormalDistortionStrength: 0.23,
      waveMicroNormalSpecularStrength: 1.0,

      waveEvolutionEnabled: false,
      waveEvolutionSpeed: 0.15,
      waveEvolutionAmount: 0.3,
      waveEvolutionScale: 0.5,
      // Wind drives wave speed between these values (× waveSpeed). Guide: ~0.10 calm, ~0.55 gust.
      waveSpeedWindMinFactor: 0.10,
      waveSpeedWindMaxFactor: 0.55,
      waveStrengthWindMinFactor: 0.39,
      waveIndoorDampingEnabled: false,
      waveIndoorDampingStrength: 1.0,
      waveIndoorMinFactor: 0.05,
      windDirResponsiveness: 1.0,

      // Chromatic aberration
      chromaticAberrationEnabled: true,
      chromaticAberrationStrengthPx: 8.0,
      chromaticAberrationThreshold: 0.18,
      chromaticAberrationThresholdSoftness: 0.47,
      chromaticAberrationKawaseBlurPx: 8.0,
      chromaticAberrationSampleSpread: 0.54,
      chromaticAberrationEdgeCenter: 0.39,
      chromaticAberrationEdgeFeather: 0.27,
      chromaticAberrationEdgeGamma: 0.85,
      chromaticAberrationEdgeMin: 0.0,
      chromaticAberrationDeadzone: 0.02,
      chromaticAberrationDeadzoneSoftness: 0.02,

      // Distortion edge masking
      distortionEdgeCenter: 1.0,
      distortionEdgeFeather: 0.26,
      distortionEdgeGamma: 1.0,
      distortionShoreRemapLo: 0.0,
      distortionShoreRemapHi: 1.0,
      distortionShorePow: 1.29,
      distortionShoreMin: 0.31,

      // Refraction
      refractionMultiTapEnabled: false,

      // Precipitation distortion — simple noise-based surface agitation
      rainPrecipitation: 0.0,
      rainDistortionEnabled: true,
      rainDistortionUseWeather: true,
      rainDistortionPrecipitationOverride: 0.0,
      rainDistortionStrengthPx: 6.0,
      rainDistortionScale: 8.0,
      rainDistortionSpeed: 1.2,
      rainIndoorDampingEnabled: true,
      rainIndoorDampingStrength: 1.0,

      // Wind coupling
      lockWaveTravelToWind: true,
      waveDirOffsetDeg: 0.0,
      waveAppearanceRotDeg: 0.0,
      waveTriBlendAngleDeg: 35.0,
      waveTriSideWeight: 0.35,
      waveAppearanceOffsetDeg: 0.0,
      // Wave direction field (patchwise crisscrossing)
      waveDirFieldEnabled: true,
      waveDirFieldMaxDeg: 45.0,
      waveDirFieldScale: 0.65,
      waveDirFieldSpeed: 0.35,
      advectionDirOffsetDeg: 0.0,
      advectionSpeed01: 1.4,
      advectionSpeed: 1.5,

      // Specular (GGX)
      specStrength: 120.0,
      specPower: 48.0,
      specModel: 1,
      specClamp: 0.8,
      specSunAzimuthDeg: 135.0,
      specSunElevationDeg: 45.0,
      specSunIntensity: 6.0,
      specNormalStrength: 4.0,
      specNormalScale: 8.0,
      specNormalMode: 3,
      specMicroStrength: 0.5,
      specMicroScale: 1.12,
      specAAStrength: 0.0,
      specWaveStepMul: 1.24,
      specForceFlatNormal: false,
      specDisableMasking: false,
      specDisableRainSlope: false,
      specRoughnessMin: 0.0,
      specRoughnessMax: 1.0,
      specSurfaceChaos: 0.5,
      specF0: 0.249,
      specMaskGamma: 0.52,
      specSkyTint: 1.0,
      skyIntensity: 1.0,
      specShoreBias: -1.0,
      specDistortionNormalStrength: 1.32,
      specAnisotropy: -0.31,
      specAnisoRatio: 2.0,

      // Specular Highlights (additive sharp highlights)
      specHighlightsEnabled: true,
      specHighlightsStrength: 80.0,
      specHighlightsPower: 128.0,
      specHighlightsClamp: 1.2,
      specHighlightsSunAzimuthDeg: 135.0,
      specHighlightsSunElevationDeg: 45.0,
      specHighlightsSunIntensity: 8.0,
      specHighlightsNormalStrength: 6.0,
      specHighlightsNormalScale: 12.0,
      specHighlightsRoughnessMin: 0.0,
      specHighlightsRoughnessMax: 0.2,
      specHighlightsF0: 0.3,
      specHighlightsSkyTint: 0.8,
      specHighlightsMaskGamma: 0.8,
      specHighlightsShoreBias: -0.5,

      // Sun angle specular suppression
      specUseSunAngle: true,
      specSunElevationFalloffEnabled: true,
      specSunElevationFalloffStart: 35.0,
      specSunElevationFalloffEnd: 10.0,
      specSunElevationFalloffCurve: 2.5,

      // Cloud shadow modulation
      cloudShadowEnabled: true,
      cloudShadowDarkenStrength: 1.13,
      cloudShadowDarkenCurve: 8.0,
      cloudShadowSpecularKill: 3.0,
      cloudShadowSpecularCurve: 12.0,

      // Bloom (specular): extra linear energy into BloomEffectV2 mask RT only (beauty unchanged)
      bloomSpecularEmit: 1.5,

      // Cloud Reflection
      cloudReflectionEnabled: true,
      cloudReflectionStrength: 0.3,

      // Caustics — dual-layer ridged FBM for underwater light filaments
      causticsEnabled: true,
      causticsIntensity: 5.86,
      causticsScale: 88.6,
      causticsSpeed: 4.0,
      causticsSharpness: 0.13,
      causticsEdgeLo: 0.0,
      causticsEdgeHi: 1.0,

      // Caustics brightness thresholding: gate caustics to lit scene areas
      causticsBrightnessMaskEnabled: true,
      causticsBrightnessThreshold: 0.09,
      causticsBrightnessSoftness: 0.2,
      causticsBrightnessGamma: 1.0,

      // Foam (base/flecks)
      foamColor: { r: 0.85, g: 0.90, b: 0.88 },
      foamStrength: 0.6,
      foamThreshold: 0.28,
      foamShoreCorePower: 4.5,
      foamShoreCoreStrength: 1.0,
      foamShoreTailPower: 0.6,
      foamShoreTailStrength: 0.2,
      foamScale: 20.0,
      foamSpeed: 0.1,
      foamCurlStrength: 0.35,
      foamCurlScale: 2.0,
      foamCurlSpeed: 0.05,
      foamBreakupStrength1: 0.5,
      foamBreakupScale1: 3.0,
      foamBreakupSpeed1: 0.04,
      foamBreakupStrength2: 0.3,
      foamBreakupScale2: 7.0,
      foamBreakupSpeed2: 0.02,
      foamBlackPoint: 0.0,
      foamWhitePoint: 1.0,
      foamGamma: 1.0,
      foamContrast: 1.0,
      foamBrightness: 0.0,

      // Shore Foam (Advanced)
      shoreFoamEnabled: true,
      shoreFoamStrength: 0.19,
      shoreFoamThreshold: 0.45,
      shoreFoamScale: 20.5,
      shoreFoamSpeed: 0.1,

      // Shore Foam Appearance
      shoreFoamColor: { r: 1.0, g: 1.0, b: 1.0 },
      shoreFoamOpacity: 1.0,
      shoreFoamBrightness: 2.0,
      shoreFoamContrast: 1.98,
      shoreFoamGamma: 0.8,
      shoreFoamTint: { r: 0.95, g: 0.97, b: 0.9 },
      shoreFoamTintStrength: 1.0,
      shoreFoamColorVariation: 1.0,

      // Shore Foam Lighting
      shoreFoamLightingEnabled: true,
      shoreFoamAmbientLight: 0.18,
      shoreFoamSceneLightInfluence: 0.8,
      shoreFoamDarknessResponse: 0.78,

      // Shore Foam Complexity
      shoreFoamFilamentsEnabled: true,
      shoreFoamFilamentsStrength: 0.74,
      shoreFoamFilamentsScale: 5.0,
      shoreFoamFilamentsLength: 4.3,
      shoreFoamFilamentsWidth: 0.2,
      shoreFoamThicknessVariation: 0.64,
      shoreFoamThicknessScale: 4.0,
      shoreFoamEdgeDetail: 0.52,
      shoreFoamEdgeDetailScale: 19.8,

      // Shore Foam Distortion & Evolution
      shoreFoamWaveDistortionStrength: 10.0,
      shoreFoamNoiseDistortionEnabled: true,
      shoreFoamNoiseDistortionStrength: 3.0,
      shoreFoamNoiseDistortionScale: 7.4,
      shoreFoamNoiseDistortionSpeed: 0.75,
      shoreFoamEvolutionEnabled: true,
      shoreFoamEvolutionSpeed: 0.46,
      shoreFoamEvolutionAmount: 1.0,
      shoreFoamEvolutionScale: 4.4,

      // Shore Foam Coverage
      shoreFoamCoreWidth: 0.04,
      shoreFoamCoreFalloff: 1.0,
      shoreFoamTailWidth: 0.6,
      shoreFoamTailFalloff: 0.3,

      floatingFoamStrength: 0.57,
      floatingFoamCoverage: 0.57,
      floatingFoamScale: 200.0,
      floatingFoamWaveDistortion: 2.0,

      // Floating Foam Advanced (Phase 1)
      floatingFoamColor: { r: 1.0, g: 1.0, b: 1.0 },
      floatingFoamOpacity: 0.78,
      floatingFoamBrightness: 0.0,
      floatingFoamContrast: 1.87,
      floatingFoamGamma: 4.0,
      floatingFoamTint: { r: 0.9, g: 0.95, b: 0.85 },
      floatingFoamTintStrength: 1.0,
      floatingFoamColorVariation: 1.0,

      // Floating Foam Lighting
      floatingFoamLightingEnabled: true,
      floatingFoamAmbientLight: 1.0,
      floatingFoamSceneLightInfluence: 1.0,
      floatingFoamDarknessResponse: 0.7,

      // Floating Foam Shadow Casting
      floatingFoamShadowEnabled: true,
      floatingFoamShadowStrength: 1.0,
      floatingFoamShadowSoftness: 0.09,
      floatingFoamShadowDepth: 0.11,

      // Floating Foam Complexity (Phase 2)
      floatingFoamFilamentsEnabled: true,
      floatingFoamFilamentsStrength: 0.81,
      floatingFoamFilamentsScale: 3.6,
      floatingFoamFilamentsLength: 3.0,
      floatingFoamFilamentsWidth: 0.12,
      floatingFoamThicknessVariation: 0.71,
      floatingFoamThicknessScale: 2.7,
      floatingFoamEdgeDetail: 0.6,
      floatingFoamEdgeDetailScale: 8.0,
      floatingFoamLayerCount: 2.0,
      floatingFoamLayerOffset: 0.3,

      // Floating Foam Distortion & Evolution
      floatingFoamWaveDistortionStrength: 10.0,
      floatingFoamNoiseDistortionEnabled: true,
      floatingFoamNoiseDistortionStrength: 2.46,
      floatingFoamNoiseDistortionScale: 3.1,
      floatingFoamNoiseDistortionSpeed: 0.64,
      floatingFoamEvolutionEnabled: true,
      floatingFoamEvolutionSpeed: 0.46,
      floatingFoamEvolutionAmount: 0.6,
      floatingFoamEvolutionScale: 1.5,

      foamFlecksEnabled: true,
      foamFlecksIntensity: 0.0,

      // Murk
      murkEnabled: true,
      murkIntensity: 0.76,
      murkColor: { r: 0.15, g: 0.22, b: 0.12 },
      murkScale: 5.66,
      murkSpeed: 0.45,
      murkDepthLo: 0.0,
      murkDepthHi: 0.8,
      murkGrainScale: 2600.0,
      murkGrainSpeed: 0.6,
      murkGrainStrength: 0.8,
      murkDepthFade: 1.8,

      // Murk Shadow Integration
      murkShadowEnabled: true,
      murkShadowStrength: 1.0,

      // Faux bathymetry (Beer-Lambert volumetric absorption/scatter)
      bathymetryEnabled: true,
      bathymetryDepthCurve: 1.53,
      bathymetryMaxDepth: 3.3,
      bathymetryStrength: 1.01,
      bathymetryAbsorptionCoeff: { r: 4.0, g: 1.5, b: 0.1 },
      bathymetryDeepScatterColor: { r: 0.02, g: 0.10, b: 0.20 },

      // Mask composite + packed water-data resolution. GPU JFA path scales well;
      // CPU SDF fallback is heavier at 2048+ if JFA is unavailable.
      buildResolution: 2048,
      maskThreshold: 0.15,
      maskChannel: 'auto',
      maskInvert: false,
      maskBlurRadius: 0.0,
      maskBlurPasses: 0,
      maskExpandPx: 0.0,
      sdfRangePx: 64,
      shoreWidthPx: 24,

      useSdfMask: true,

      // Debug
      debugView: 0,
      debugWindArrow: false,
      
      // Water depth enhancement
      waterDepthShadowEnabled: true,
      waterDepthShadowStrength: 0.15,
      waterDepthShadowMinBrightness: 0.7,
      
      // Micro-chop enhancement
      microChopIntensity: 0.5,
      microChopScale: 1.0,
      microChopSpeed: 1.0,

      
      // Uniforms
      uWaterDepthShadowEnabled: true,
      uWaterDepthShadowStrength: 0.15,
      uWaterDepthShadowMinBrightness: 0.7,
      uMicroChopIntensity: 0.5,
      uMicroChopScale: 1.0,
      uMicroChopSpeed: 1.0,
      uUseSdfMask: true,
    };

    // ── Per-floor water state ────────────────────────────────────────────
    // Keyed by floorIndex → { maskRT, waterData, rawMask }
    /** @type {Map<number, object>} */
    this._floorWater = new Map();

    /** @type {number} */
    this._activeFloorIndex = 0;

    /**
     * Per-level pipeline override: when set (>= 0), render() uses this floor
     * index for water data lookup instead of `_activeFloorIndex`.
     * @type {number}
     */
    this._perLevelOverride = -1;

    // ── Discovered water tiles (populated in populate()) ─────────────────
    /** @type {Array<{tileId: string, basePath: string, floorIndex: number, maskPath: string}>} */
    this._waterTiles = [];

    /** @type {VisionSDF|null} */
    this._visionSDF = null;

    // ── GPU resources (created in initialize()) ──────────────────────────
    /** @type {THREE.Scene|null} */
    this._composeScene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._composeCamera = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._composeMaterial = null;
    /** @type {THREE.Mesh|null} */
    this._composeQuad = null;
    /** @type {THREE.DataTexture|null} */
    this._noiseTexture = null;

    // ── Fallback 1x1 textures for optional samplers ──────────────────────
    // WebGL requires all declared sampler2D uniforms to be bound to a valid
    // texture at all times. These are used when the real texture is unavailable.
    /** @type {THREE.DataTexture|null} */
    this._fallbackBlack = null;
    /** @type {THREE.DataTexture|null} */
    this._fallbackWhite = null;

    // ── Wind / time state ────────────────────────────────────────────────
    this._windTime = 0;
    this._waveTime = 0;
    this._windOffsetUvX = 0;
    this._windOffsetUvY = 0;
    this._smoothedWindDirX = 1.0;
    this._smoothedWindDirY = 0.0;
    this._smoothedWindSpeed01 = 0.0;
    this._smoothedWaveShapeWind01 = 0.0;

    // Smoothed wave wind motion: always ≥ 0, rate-limited to prevent advection reversal.
    // Rises faster than it falls so gusts are felt but calm spells don't snap waves backward.
    this._waveWindMotion01 = 0.0;

    // Dual-spectrum wind-direction blending.
    // We keep a "previous" direction and "target" direction and blend between
    // the two in the shader so the wavefield doesn't snap when wind rotates.
    this._prevWindDirX = 1.0;
    this._prevWindDirY = 0.0;
    this._targetWindDirX = 1.0;
    this._targetWindDirY = 0.0;
    this._windDirBlend01 = 1.0;
    this._waveDirX = 1.0;
    this._waveDirY = 0.0;

    // ── Debug arrow DOM overlay ──────────────────────────────────────────
    /** @type {HTMLElement|null} */
    this._windDebugArrow = null;

    log.info(`WaterEffectV2 constructed (${this._instanceId})`);

    // Cached trigonometry for advection angle offset (avoids per-frame sin/cos).
    this._cachedAdvectionDirOffsetDeg = null;
    this._cachedAdvectionDirCos = 1.0;
    this._cachedAdvectionDirSin = 0.0;
    // _lastTimeValue removed: update() now uses TimeManager timeInfo directly.
    /** @type {number|null} Last elapsed value used to derive motion dt. */
    this._lastAnimElapsed = null;
    this._shaderTime = 0.0;

    // ── Cached sun direction ─────────────────────────────────────────────
    this._cachedSunAzDeg = null;
    this._cachedSunElDeg = null;
    this._cachedSunDirX = 0;
    this._cachedSunDirY = 0;
    this._cachedSunDirZ = 1;

    // ── Defines tracking ─────────────────────────────────────────────────
    this._lastDefinesKey = -1;

    // ── First-render diagnostic flag ─────────────────────────────────────
    this._firstRenderDone = false;

    // ── Reusable vectors ─────────────────────────────────────────────────
    this._sizeVec = null;

    // ── Sky state (fed by SkyColorEffectV2; used by water specular) ───────
    this._skyColorR = 1.0;
    this._skyColorG = 1.0;
    this._skyColorB = 1.0;

    // One-time runtime signatures for debugging whether this exact file is executing.
    // These are intentionally low-noise (log once) so they can be left in during
    // investigation without spamming the console.
    this._debugSignatureLogged = false;
    this._debugSignatureUpdateLogged = false;

    log.debug('WaterEffectV2 created');
  }

  /**
   * Returns a boot-safe water shader that removes expensive rain ripple/storm
   * nested loops which cause GPU driver compilation hangs on some systems.
   * Preserves core water features: tint, waves, distortion, specular, caustics, foam, murk.
   * @returns {string} GLSL fragment shader source
   * @private
   */
  _getSafeWaterShader() {
    // Use the structured safe shader export from water-shader.js instead of
    // fragile regex replacement. This cleanly removes the expensive rain ripple
    // and storm 3x3 nested loops that trigger GPU compilation TDR on some systems.
    log.info('WaterEffectV2: using safe shader (rain loops disabled to prevent GPU hang)');
    return getFragmentShaderSafe();
  }

  /**
   * Creates a minimal passthrough shader material for deferred compilation.
   * This ~10-line shader compiles instantly vs the ~2400-line real shader.
   * @param {object} THREE
   * @returns {THREE.ShaderMaterial}
   * @private
   */
  _createMinimalPassthroughMaterial(THREE) {
    const passthroughVert = /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position, 1.0);
      }
    `;
    const passthroughFrag = /* glsl */`
      uniform sampler2D tDiffuse;
      uniform float uWaterEnabled;
      varying vec2 vUv;
      void main() {
        // Minimal passthrough: just copy input when water disabled
        // Real shader compilation happens on first render() via _compileRealShaderNow
        gl_FragColor = texture2D(tDiffuse, vUv);
      }
    `;
    const uniforms = {
      tDiffuse: { value: null },
      uWaterEnabled: { value: 0.0 },
    };
    return new THREE.ShaderMaterial({
      uniforms,
      vertexShader: passthroughVert,
      fragmentShader: passthroughFrag,
      depthTest: false,
      depthWrite: false,
      transparent: false,
    });
  }

  /**
   * Compile the real heavy water shader on first render frame.
   * This is where the ~2400-line GLSL compilation happens, not during init.
   * 
   * Uses SafeShaderBuilder with a long wall clock (see WATER_SHADER_COMPILE_TIMEOUT_MS).
   * On timeout the passthrough material is kept and compile is retried with backoff
   * instead of swapping in a minimal fallback that cannot run the water pass.
   *
   * @param {object} THREE
   * @param {THREE.WebGLRenderer} renderer
   * @private
   */
  async _compileRealShaderNow(THREE, renderer) {
    if (this._realShaderCompiled || this._shaderCompilePending) return;
    this._shaderCompilePending = true;

    const _compileStart = performance?.now?.() ?? Date.now();
    const attempt = this._waterShaderCompileFailures + 1;
    const timeoutMs = Math.min(
      90000,
      WATER_SHADER_COMPILE_TIMEOUT_MS + (attempt - 1) * 15000,
    );
    log.warn(
      `WaterEffectV2: compiling real shader (attempt ${attempt}/${WATER_SHADER_COMPILE_MAX_ATTEMPTS}, timeoutMs=${timeoutMs})...`,
    );

    try {
      const fragSrc = this._getSafeWaterShader();
      const defines = this._pendingDefines || {};

      // Build full uniforms for real shader
      const realUniforms = this._buildUniforms(THREE);

      const result = await safeBuildShaderMaterial(
        THREE,
        'WaterEffectV2',
        {
          uniforms: realUniforms,
          vertexShader: getVertexShader(),
          fragmentShader: fragSrc,
          defines,
          depthTest: false,
          depthWrite: false,
          transparent: false,
          extensions: { shaderTextureLOD: true },
        },
        {
          timeoutMs,
          fallbackParams: {
            uniforms: { tDiffuse: { value: null } },
            vertexShader: `
              varying vec2 vUv;
              void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
            `,
            fragmentShader: `
              uniform sampler2D tDiffuse;
              varying vec2 vUv;
              void main() { gl_FragColor = texture2D(tDiffuse, vUv); }
            `,
            depthTest: false,
            depthWrite: false,
            transparent: false,
          },
        }
      );

      const _compileEnd = performance?.now?.() ?? Date.now();
      const duration = _compileEnd - _compileStart;

      if (result.usedFallback) {
        try { result.material?.dispose?.(); } catch (_) {}
        this._shaderCompilePending = false;
        this._shaderReadyPromise = null;
        this._realShaderCompiled = false;
        this._waterShaderCompileFailures += 1;
        const now = performance?.now?.() ?? Date.now();
        const backoff = Math.min(4000, 250 + this._waterShaderCompileFailures * 350);
        this._waterCompileRetryAfterMs = now + backoff;
        if (this._waterShaderCompileFailures >= WATER_SHADER_COMPILE_MAX_ATTEMPTS) {
          log.error(
            `[${duration.toFixed(1)}ms] WaterEffectV2: shader compile failed after ${WATER_SHADER_COMPILE_MAX_ATTEMPTS} attempts — disabling water pass`,
          );
          this.setEnabled(false);
        } else {
          log.warn(
            `[${duration.toFixed(1)}ms] WaterEffectV2: compile timeout/error — retry in ${backoff.toFixed(0)}ms (failure ${this._waterShaderCompileFailures}/${WATER_SHADER_COMPILE_MAX_ATTEMPTS})`,
          );
        }
        return;
      }

      const oldMaterial = this._composeMaterial;
      this._composeMaterial = result.material;
      this._composeQuad.material = result.material;

      if (oldMaterial?.uniforms?.tDiffuse?.value) {
        result.material.uniforms.tDiffuse.value = oldMaterial.uniforms.tDiffuse.value;
      }

      result.material.toneMapped = false;
      oldMaterial?.dispose?.();

      this._realShaderCompiled = true;
      this._shaderCompilePending = false;
      this._shaderReadyPromise = null;
      this._waterShaderCompileFailures = 0;
      this._waterCompileRetryAfterMs = 0;

      try {
        this._syncGlobalWaterBindingsFromViewedFloor();
      } catch (_) {}

      log.warn(`[${duration.toFixed(1)}ms] WaterEffectV2: real shader compiled successfully`);
    } catch (err) {
      this._shaderCompilePending = false;
      this._shaderReadyPromise = null;
      this._realShaderCompiled = false;
      this._waterShaderCompileFailures += 1;
      const now = performance?.now?.() ?? Date.now();
      const backoff = Math.min(4000, 250 + this._waterShaderCompileFailures * 350);
      this._waterCompileRetryAfterMs = now + backoff;
      log.error('WaterEffectV2: unexpected error during shader compilation:', err);
      if (this._waterShaderCompileFailures >= WATER_SHADER_COMPILE_MAX_ATTEMPTS) {
        this.setEnabled(false);
      }
    }
  }

  _buildUniforms(THREE) {
    return WaterEffectV2._buildUniforms(
      THREE,
      this.params,
      this._noiseTexture,
      null,
      null,
      null,
      {
        black: this._fallbackBlack,
        white: this._fallbackWhite,
      }
    );
  }

  setSkyColor(r, g, b) {
    if (Number.isFinite(r)) this._skyColorR = r;
    if (Number.isFinite(g)) this._skyColorG = g;
    if (Number.isFinite(b)) this._skyColorB = b;
    try {
      const u = this._composeMaterial?.uniforms;
      if (u?.uSkyColor?.value?.set) {
        u.uSkyColor.value.set(this._skyColorR, this._skyColorG, this._skyColorB);
      }
    } catch (_) {}
  }

  setSkyIntensity01(v) {
    const vv = Math.max(0, Math.min(1, Number(v) || 0));
    this.params.skyIntensity = vv;
    try {
      const u = this._composeMaterial?.uniforms;
      if (u?.uSkyIntensity) u.uSkyIntensity.value = vv;
    } catch (_) {}
  }

  /**
   * When floor depth blur is on, tiles below the viewed top floor are Kawase-blurred
   * into the scene RT before lighting. Water still adds sharp procedural specular and
   * foam in a later pass — set uFloorDepthBlurWaterSoft so those layers match the bus.
   *
   * @param {boolean} blurEnabled - same gate as FloorCompositor bus blur (effect on + max floor > 0)
   * @param {number} visibleMaxFloorIndex - FloorRenderBus._visibleMaxFloorIndex
   */
  syncFloorDepthBlurContext(blurEnabled, visibleMaxFloorIndex) {
    try {
      const u = this._composeMaterial?.uniforms;
      if (!u?.uFloorDepthBlurWaterSoft) return;
      const wf = Number(this._activeFloorIndex);
      const vm = Number(visibleMaxFloorIndex);
      const useSoft = blurEnabled === true
        && Number.isFinite(vm) && vm > 0
        && Number.isFinite(wf) && wf < vm;
      u.uFloorDepthBlurWaterSoft.value = useSoft ? 1.0 : 0.0;
    } catch (_) {}
  }

  /**
   * Feed the live _Outdoors mask texture into the water shader.
   * Called by OutdoorsMaskProviderV2 subscriber whenever the active floor mask changes.
   * When tex is null (no _Outdoors tiles on this floor), indoor damping is disabled.
   *
   * The canvas composite is Foundry Y-down (flipY=false), matching the scene UV
   * convention used in sampleOutdoorsMask(). uOutdoorsMaskFlipY stays 0.0.
   *
   * @param {THREE.Texture|null} outdoorsTex
   */
  setOutdoorsMask(outdoorsTex) {
    try {
      const u = this._composeMaterial?.uniforms;
      if (!u) return;
      if (u.tOutdoorsMask)    u.tOutdoorsMask.value    = outdoorsTex ?? this._fallbackWhite;
      if (u.uHasOutdoorsMask) u.uHasOutdoorsMask.value = outdoorsTex ? 1.0 : 0.0;
      // Canvas composite is already Foundry Y-down — no flip needed in the shader.
      if (u.uOutdoorsMaskFlipY) u.uOutdoorsMaskFlipY.value = 0.0;
    } catch (_) {}
  }

  /**
   * Feed the live cloud shadow texture into the water shader.
   * Called by FloorCompositor each frame after CloudEffectV2 renders its shadow.
   * Pass `CloudEffectV2.cloudShadowTexture` (a THREE.Texture) directly.
   * When tex is null (clouds disabled), the uniform is bound to the white fallback
   * so specular/caustics are unaffected (shadow factor = 1.0).
   * @param {THREE.Texture|null} shadowTex
   */
  setCloudShadowTexture(shadowTex) {
    try {
      const u = this._composeMaterial?.uniforms;
      if (!u) return;
      if (u.tCloudShadow) u.tCloudShadow.value = shadowTex ?? this._fallbackWhite;
      if (u.uHasCloudShadow) u.uHasCloudShadow.value = shadowTex ? 1.0 : 0.0;
    } catch (_) {}
  }

  /**
   * Feed the live building shadow texture into the water shader.
   * Called by FloorCompositor each frame after BuildingShadowsEffectV2 renders.
   * When tex is null (building shadows disabled), the uniform is bound to the white fallback
   * so specular is unaffected (shadow factor = 1.0).
   * @param {THREE.Texture|null} shadowTex
   */
  setBuildingShadowTexture(shadowTex) {
    try {
      const u = this._composeMaterial?.uniforms;
      if (!u) return;
      if (u.tBuildingShadow) u.tBuildingShadow.value = shadowTex ?? this._fallbackWhite;
      if (u.uHasBuildingShadow) u.uHasBuildingShadow.value = shadowTex ? 1.0 : 0.0;
    } catch (_) {}
  }

  /**
   * Feed the live overhead shadow texture into the water shader.
   * Called by FloorCompositor each frame after OverheadShadowsEffectV2 renders.
   * When tex is null (overhead shadows disabled), the uniform is bound to the white fallback
   * so specular is unaffected (shadow factor = 1.0).
   * @param {THREE.Texture|null} shadowTex
   */
  setOverheadShadowTexture(shadowTex) {
    try {
      const u = this._composeMaterial?.uniforms;
      if (!u) return;
      if (u.tOverheadShadow) u.tOverheadShadow.value = shadowTex ?? this._fallbackWhite;
      if (u.uHasOverheadShadow) u.uHasOverheadShadow.value = shadowTex ? 1.0 : 0.0;
    } catch (_) {}
  }

  /**
   * Feed unified shadow factor texture (cloud + overhead composition).
   * Keeps legacy uniforms backward-compatible by binding combined shadow as cloud
   * input and disabling dedicated overhead-shadow factor in this path.
   * @param {THREE.Texture|null} shadowTex
   */
  setCombinedShadowTexture(shadowTex) {
    try {
      const u = this._composeMaterial?.uniforms;
      if (!u) return;
      if (u.tCloudShadow) u.tCloudShadow.value = shadowTex ?? this._fallbackWhite;
      if (u.uHasCloudShadow) u.uHasCloudShadow.value = shadowTex ? 1.0 : 0.0;
      if (u.tOverheadShadow) u.tOverheadShadow.value = this._fallbackWhite;
      if (u.uHasOverheadShadow) u.uHasOverheadShadow.value = 0.0;
    } catch (_) {}
  }

  /**
   * Feed ShadowManagerV2 combined shadow texture for murk darkening.
   * This texture combines cloud and overhead shadows into a single factor
   * that is used specifically to darken the murk effect.
   * @param {THREE.Texture|null} shadowTex
   */
  setShadowManagerCombinedTexture(shadowTex) {
    try {
      const u = this._composeMaterial?.uniforms;
      if (!u) return;
      if (u.tCombinedShadow) u.tCombinedShadow.value = shadowTex ?? this._fallbackWhite;
      if (u.uHasCombinedShadow) u.uHasCombinedShadow.value = shadowTex ? 1.0 : 0.0;
    } catch (_) {}
  }

  /**
   * Set the specular sun direction from live time-of-day azimuth and elevation.
   * Called by FloorCompositor each frame after SkyColorEffectV2 updates.
   * @param {number} azimuthDeg - Degrees: 0=North, 90=East, 180=South, 270=West
   * @param {number} elevationDeg - Degrees above horizon (0=horizon, 90=zenith)
   */
  setSunAngles(azimuthDeg, elevationDeg) {
    if (!Number.isFinite(azimuthDeg) || !Number.isFinite(elevationDeg)) return;
    this.params.specSunAzimuthDeg = azimuthDeg;
    this.params.specSunElevationDeg = elevationDeg;
    // Reset the cache so update() recomputes the direction vector this frame.
    this._cachedSunAzDeg = null;
  }

  /**
   * Tweakpane control schema for WaterEffectV2.
   * Keep this schema aligned with the live params consumed in update().
   */
static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'water-core',
          label: 'Core',
          type: 'folder',
          expanded: true,
          parameters: [
            'tintColor', 'tintStrength',
            'useSdfMask', 'distortionStrengthPx',
            'debugView', 'debugWindArrow'
          ]
        },
        {
          name: 'water-depth-enhancement',
          label: 'Water Depth Enhancement',
          type: 'folder',
          expanded: false,
          parameters: [
            'waterDepthShadowEnabled',
            'waterDepthShadowStrength',
            'waterDepthShadowMinBrightness'
          ]
        },
        {
          name: 'water-micro-chop',
          label: 'Micro-Chop',
          type: 'folder',
          expanded: false,
          parameters: [
            'microChopIntensity',
            'microChopScale',
            'microChopSpeed'
          ]
        },
        {
          name: 'water-waves',
          label: 'Waves',
          type: 'folder',
          expanded: false,
          parameters: [
            'waveScale', 'waveSpeed', 'waveStrength', 'waveMotion01',
            'lockWaveTravelToWind', 'waveDirOffsetDeg', 'waveAppearanceRotDeg',
            'waveWarpLargeStrength', 'waveWarpSmallStrength', 'waveWarpMicroStrength', 'waveWarpTimeSpeed',
            'waveBreakupStrength', 'waveBreakupScale', 'waveBreakupSpeed', 'waveBreakupWarp',
            'waveBreakupDistortionStrength', 'waveBreakupSpecularStrength',
            'waveMicroNormalStrength', 'waveMicroNormalScale', 'waveMicroNormalSpeed', 'waveMicroNormalWarp',
            'waveMicroNormalDistortionStrength', 'waveMicroNormalSpecularStrength',
            'waveEvolutionEnabled', 'waveEvolutionSpeed', 'waveEvolutionAmount', 'waveEvolutionScale'
          ]
        },
        {
          name: 'water-wind-coupling',
          label: 'Wind Coupling',
          type: 'folder',
          expanded: false,
          parameters: [
            'waveSpeedWindMinFactor', 'waveSpeedWindMaxFactor', 'waveStrengthWindMinFactor',
            'waveIndoorDampingEnabled', 'waveIndoorDampingStrength', 'waveIndoorMinFactor',
            'windDirResponsiveness',
            'waveTriBlendAngleDeg', 'waveTriSideWeight',
            'advectionDirOffsetDeg', 'advectionSpeed01'
          ]
        },
        {
          name: 'water-refraction',
          label: 'Refraction',
          type: 'folder',
          expanded: false,
          parameters: [
            'refractionMultiTapEnabled',
            'distortionEdgeCenter', 'distortionEdgeFeather', 'distortionEdgeGamma',
            'distortionShoreRemapLo', 'distortionShoreRemapHi', 'distortionShorePow', 'distortionShoreMin'
          ]
        },
        {
          name: 'water-chromatic-aberration',
          label: 'Chromatic Aberration',
          type: 'folder',
          expanded: false,
          parameters: [
            'chromaticAberrationEnabled',
            'chromaticAberrationStrengthPx',
            'chromaticAberrationThreshold', 'chromaticAberrationThresholdSoftness',
            'chromaticAberrationKawaseBlurPx', 'chromaticAberrationSampleSpread',
            'chromaticAberrationEdgeCenter', 'chromaticAberrationEdgeFeather',
            'chromaticAberrationEdgeGamma', 'chromaticAberrationEdgeMin',
            'chromaticAberrationDeadzone', 'chromaticAberrationDeadzoneSoftness'
          ]
        },
        {
          name: 'water-rain',
          label: 'Precipitation Distortion',
          type: 'folder',
          expanded: false,
          parameters: [
            'rainDistortionEnabled',
            'rainDistortionUseWeather',
            'rainDistortionPrecipitationOverride',
            'rainDistortionStrengthPx', 'rainDistortionScale', 'rainDistortionSpeed',
            'rainIndoorDampingEnabled', 'rainIndoorDampingStrength'
          ]
        },
        {
          name: 'water-specular',
          label: 'Specular',
          type: 'folder',
          expanded: false,
          parameters: [
            'specStrength', 'specPower', 'specModel', 'specClamp',
            'specSunAzimuthDeg', 'specSunElevationDeg', 'specSunIntensity',
            'specNormalStrength', 'specNormalScale', 'specNormalMode',
            'specMicroStrength', 'specMicroScale', 'specAAStrength', 'specWaveStepMul',
            'specForceFlatNormal', 'specDisableMasking', 'specDisableRainSlope',
            'specRoughnessMin', 'specRoughnessMax', 'specSurfaceChaos', 'specF0', 'specMaskGamma',
            'specSkyTint', 'skyIntensity', 'specShoreBias',
            'specDistortionNormalStrength', 'specAnisotropy', 'specAnisoRatio'
          ]
        },
        {
          name: 'water-specular-highlights',
          label: 'Specular Highlights',
          type: 'folder',
          expanded: false,
          parameters: [
            'specHighlightsEnabled', 'specHighlightsStrength', 'specHighlightsPower', 'specHighlightsClamp',
            'specHighlightsSunAzimuthDeg', 'specHighlightsSunElevationDeg', 'specHighlightsSunIntensity',
            'specHighlightsNormalStrength', 'specHighlightsNormalScale',
            'specHighlightsRoughnessMin', 'specHighlightsRoughnessMax',
            'specHighlightsF0', 'specHighlightsSkyTint', 'specHighlightsMaskGamma', 'specHighlightsShoreBias'
          ]
        },
        {
          name: 'water-bloom-spec',
          label: 'Bloom link (specular)',
          type: 'folder',
          expanded: false,
          parameters: ['bloomSpecularEmit'],
        },
        {
          name: 'water-cloud-shadow',
          label: 'Cloud Shadow Modulation',
          type: 'folder',
          expanded: false,
          parameters: [
            'cloudShadowEnabled',
            'cloudShadowDarkenStrength', 'cloudShadowDarkenCurve',
            'cloudShadowSpecularKill', 'cloudShadowSpecularCurve'
          ]
        },
        {
          name: 'water-cloud-reflection',
          label: 'Cloud Reflection',
          type: 'folder',
          expanded: false,
          parameters: [
            'cloudReflectionEnabled',
            'cloudReflectionStrength'
          ]
        },
        {
          name: 'water-caustics',
          label: 'Caustics',
          type: 'folder',
          expanded: false,
          parameters: [
            'causticsEnabled',
            'causticsBrightnessMaskEnabled',
            'causticsIntensity', 'causticsScale', 'causticsSpeed', 'causticsSharpness',
            'causticsEdgeLo', 'causticsEdgeHi',
            'causticsBrightnessThreshold', 'causticsBrightnessSoftness', 'causticsBrightnessGamma'
          ]
        },
        {
          name: 'water-shore-foam-advanced',
          label: 'Shore Foam (Advanced)',
          type: 'folder',
          expanded: false,
          parameters: [
            'shoreFoamEnabled',
            'shoreFoamStrength', 'shoreFoamThreshold', 'shoreFoamScale', 'shoreFoamSpeed',
            'shoreFoamColor', 'shoreFoamTint', 'shoreFoamTintStrength',
            'shoreFoamColorVariation', 'shoreFoamOpacity',
            'shoreFoamBrightness', 'shoreFoamContrast', 'shoreFoamGamma',
            'shoreFoamLightingEnabled',
            'shoreFoamAmbientLight', 'shoreFoamSceneLightInfluence',
            'shoreFoamDarknessResponse',
            'shoreFoamFilamentsEnabled',
            'shoreFoamFilamentsStrength', 'shoreFoamFilamentsScale',
            'shoreFoamFilamentsLength', 'shoreFoamFilamentsWidth',
            'shoreFoamThicknessVariation', 'shoreFoamThicknessScale',
            'shoreFoamEdgeDetail', 'shoreFoamEdgeDetailScale',
            'shoreFoamWaveDistortionStrength',
            'shoreFoamNoiseDistortionEnabled',
            'shoreFoamNoiseDistortionStrength', 'shoreFoamNoiseDistortionScale',
            'shoreFoamNoiseDistortionSpeed',
            'shoreFoamEvolutionEnabled',
            'shoreFoamEvolutionSpeed', 'shoreFoamEvolutionAmount',
            'shoreFoamEvolutionScale',
            'shoreFoamCoreWidth', 'shoreFoamCoreFalloff',
            'shoreFoamTailWidth', 'shoreFoamTailFalloff',
            'floatingFoamStrength', 'floatingFoamCoverage', 'floatingFoamScale', 'floatingFoamWaveDistortion',
            'foamFlecksEnabled', 'foamFlecksIntensity'
          ]
        },
        {
          name: 'water-floating-foam-advanced',
          label: 'Floating Foam (Advanced)',
          type: 'folder',
          expanded: false,
          parameters: [
            'floatingFoamColor', 'floatingFoamTint', 'floatingFoamTintStrength',
            'floatingFoamColorVariation', 'floatingFoamOpacity',
            'floatingFoamBrightness', 'floatingFoamContrast', 'floatingFoamGamma',
            'floatingFoamLightingEnabled',
            'floatingFoamAmbientLight', 'floatingFoamSceneLightInfluence',
            'floatingFoamDarknessResponse',
            'floatingFoamShadowEnabled',
            'floatingFoamShadowStrength', 'floatingFoamShadowSoftness',
            'floatingFoamShadowDepth',
            'floatingFoamFilamentsEnabled',
            'floatingFoamFilamentsStrength', 'floatingFoamFilamentsScale',
            'floatingFoamFilamentsLength', 'floatingFoamFilamentsWidth',
            'floatingFoamThicknessVariation', 'floatingFoamThicknessScale',
            'floatingFoamEdgeDetail', 'floatingFoamEdgeDetailScale',
            'floatingFoamLayerCount', 'floatingFoamLayerOffset',
            'floatingFoamWaveDistortionStrength',
            'floatingFoamNoiseDistortionEnabled',
            'floatingFoamNoiseDistortionStrength', 'floatingFoamNoiseDistortionScale',
            'floatingFoamNoiseDistortionSpeed',
            'floatingFoamEvolutionEnabled',
            'floatingFoamEvolutionSpeed', 'floatingFoamEvolutionAmount',
            'floatingFoamEvolutionScale'
          ]
        },
        {
          name: 'water-murk',
          label: 'Murk',
          type: 'folder',
          expanded: false,
          parameters: [
            'murkEnabled',
            'murkIntensity', 'murkColor', 'murkScale', 'murkSpeed',
            'murkDepthLo', 'murkDepthHi', 'murkDepthFade',
            'murkGrainScale', 'murkGrainSpeed', 'murkGrainStrength',
            'murkShadowEnabled', 'murkShadowStrength'
          ]
        },
        {
          name: 'water-bathymetry',
          label: 'Bathymetry (Volumetric)',
          type: 'folder',
          expanded: false,
          parameters: [
            'bathymetryEnabled',
            'bathymetryDepthCurve', 'bathymetryMaxDepth', 'bathymetryStrength',
            'bathymetryAbsorptionCoeff', 'bathymetryDeepScatterColor'
          ]
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: true, label: 'Enabled' },

        tintColor: { type: 'color', default: { r: 0.02, g: 0.18, b: 0.28 }, label: 'Tint Color' },
        tintStrength: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.36, label: 'Tint Strength' },
        useSdfMask: { type: 'boolean', default: true, label: 'Use SDF Mask' },
        distortionStrengthPx: { type: 'slider', min: 0, max: 24, step: 0.1, default: 6.0, label: 'Distortion (px)' },
        debugView: {
          type: 'dropdown',
          default: 0,
          label: 'Debug View',
          options: {
            Final: 0,
            'Water Mask': 1,
            'SDF Shore': 2,
            'Water Data (RGBA)': 3,
            Distortion: 4,
            Specular: 5,
            'Sky Reflection': 9,
            Foam: 7,
            Murk: 8,
          }
        },
        debugWindArrow: { type: 'boolean', default: false, label: 'Debug Wind Arrow' },

        waterDepthShadowEnabled: { type: 'boolean', default: true, label: 'Enable Depth Shadow' },
        waterDepthShadowStrength: { type: 'slider', min: 0, max: 0.5, step: 0.01, default: 0.15, label: 'Shadow Strength' },
        waterDepthShadowMinBrightness: { type: 'slider', min: 0.3, max: 1, step: 0.01, default: 0.7, label: 'Min Brightness' },
        microChopIntensity: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.5, label: 'Micro-Chop Intensity' },
        microChopScale: { type: 'slider', min: 0.1, max: 3, step: 0.1, default: 1.0, label: 'Micro-Chop Scale' },
        microChopSpeed: { type: 'slider', min: 0.1, max: 3, step: 0.1, default: 1.0, label: 'Micro-Chop Speed' },

        waveScale: { type: 'slider', min: 0.1, max: 16, step: 0.05, default: 4.0, label: 'Wave Scale' },
        waveSpeed: {
          type: 'slider',
          min: 0,
          max: 4,
          step: 0.01,
          default: 1.0,
          label: 'Wave speed scale',
          tooltip: 'Multiplies wind-driven Gerstner phase speed (between calm and gust values below).',
        },
        waveStrength: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.6, label: 'Wave Strength' },
        waveMotion01: { type: 'slider', min: 0, max: 1, step: 0.01, default: 1.0, label: 'Wave Motion Blend' },
        waveWarpLargeStrength: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.15, label: 'Warp Large Strength' },
        waveWarpSmallStrength: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.08, label: 'Warp Small Strength' },
        waveWarpMicroStrength: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.04, label: 'Warp Micro Strength' },
        waveWarpTimeSpeed: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.15, label: 'Warp Time Speed' },
        waveBreakupStrength: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.22, label: 'Breakup Strength' },
        waveBreakupScale: { type: 'slider', min: 1, max: 300, step: 0.1, default: 80.0, label: 'Breakup Scale' },
        waveBreakupSpeed: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.18, label: 'Breakup Speed' },
        waveBreakupWarp: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.85, label: 'Breakup Warp' },
        waveBreakupDistortionStrength: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.28, label: 'Breakup Distortion' },
        waveBreakupSpecularStrength: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.35, label: 'Breakup Specular' },
        waveMicroNormalStrength: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.32, label: 'Micro Normal Strength' },
        waveMicroNormalScale: { type: 'slider', min: 1, max: 300, step: 0.1, default: 80.0, label: 'Micro Normal Scale' },
        waveMicroNormalSpeed: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.18, label: 'Micro Normal Speed' },
        waveMicroNormalWarp: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.85, label: 'Micro Normal Warp' },
        waveMicroNormalDistortionStrength: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.24, label: 'Micro Distortion' },
        waveMicroNormalSpecularStrength: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.35, label: 'Micro Specular' },
        waveEvolutionEnabled: { type: 'boolean', default: true, label: 'Wave Evolution Enabled' },
        waveEvolutionSpeed: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.15, label: 'Evolution Speed' },
        waveEvolutionAmount: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.3, label: 'Evolution Amount' },
        waveEvolutionScale: { type: 'slider', min: 0.05, max: 4, step: 0.01, default: 0.5, label: 'Evolution Scale' },

        waveSpeedWindMinFactor: {
          type: 'slider',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.1,
          label: 'Wave speed at calm wind',
          tooltip: 'Gerstner phase speed when wind is still (before × Wave speed scale). Typical ~0.10.',
        },
        waveSpeedWindMaxFactor: {
          type: 'slider',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.55,
          label: 'Wave speed at full wind',
          tooltip: 'Phase speed at strong gusts (before × Wave speed scale). Typical ~0.55.',
        },
        waveStrengthWindMinFactor: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.55, label: 'Strength Calm Baseline' },
        waveIndoorDampingEnabled: { type: 'boolean', default: false, label: 'Indoor Damping Enabled' },
        waveIndoorDampingStrength: { type: 'slider', min: 0, max: 2, step: 0.01, default: 1.0, label: 'Indoor Damping Strength' },
        waveIndoorMinFactor: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.05, label: 'Indoor Min Factor' },
        windDirResponsiveness: { type: 'slider', min: 0.05, max: 30, step: 0.05, default: 10.0, label: 'Wind Responsiveness' },
        lockWaveTravelToWind: {
          type: 'boolean',
          default: true,
          label: 'Lock wave travel to wind',
          tooltip:
            'When enabled, Gerstner propagation follows live weather wind (plus travel heading below). When disabled, waves use scene +X as their baseline axis (heading offset still applies).',
        },
        waveDirOffsetDeg: {
          type: 'slider',
          min: -180,
          max: 180,
          step: 1,
          default: 0.0,
          label: 'Wave travel heading (deg)',
          tooltip:
            'Rotates the direction waves advance along the surface, relative to coupled wind. Does not rotate foam/murk UV drift (see Advection in Wind Coupling).',
        },
        waveAppearanceRotDeg: {
          type: 'slider',
          min: -180,
          max: 180,
          step: 1,
          default: 0.0,
          label: 'Normals vs travel (deg)',
          tooltip:
            'Rotates refraction and specular wave slopes after the simulation, without changing the travel axis. Use when crests and glints look ~90° off from motion.',
        },
        waveTriBlendAngleDeg: { type: 'slider', min: 0, max: 90, step: 1, default: 35.0, label: 'Tri Blend Angle (deg)' },
        waveTriSideWeight: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.35, label: 'Tri Blend Side Weight' },
        advectionDirOffsetDeg: { type: 'slider', min: -180, max: 180, step: 1, default: 0.0, label: 'Advection Dir Offset (deg)' },
        advectionSpeed01: { type: 'slider', min: 0, max: 3, step: 0.01, default: 0.15, label: 'Advection Speed' },

        refractionMultiTapEnabled: { type: 'boolean', default: true, label: 'Multi-Tap Refraction' },
        chromaticAberrationEnabled: { type: 'boolean', default: true, label: 'Chromatic Aberration Enabled' },
        chromaticAberrationStrengthPx: { type: 'slider', min: 0, max: 8, step: 0.05, default: 2.5, label: 'Chromatic Strength (px)' },
        chromaticAberrationThreshold: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.20, label: 'Chromatic Luma Threshold' },
        chromaticAberrationThresholdSoftness: { type: 'slider', min: 0.001, max: 1, step: 0.01, default: 0.35, label: 'Chromatic Threshold Softness' },
        chromaticAberrationKawaseBlurPx: { type: 'slider', min: 0, max: 8, step: 0.05, default: 1.75, label: 'Chromatic Kawase Blur (px)' },
        chromaticAberrationSampleSpread: { type: 'slider', min: 0.25, max: 3, step: 0.01, default: 1.0, label: 'Chromatic Sample Spread' },
        chromaticAberrationEdgeCenter: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.50, label: 'Chromatic Edge Center' },
        chromaticAberrationEdgeFeather: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.10, label: 'Chromatic Edge Feather' },
        chromaticAberrationEdgeGamma: { type: 'slider', min: 0.1, max: 4, step: 0.01, default: 1.0, label: 'Chromatic Edge Gamma' },
        chromaticAberrationEdgeMin: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.0, label: 'Chromatic Edge Min' },
        chromaticAberrationDeadzone: { type: 'slider', min: 0, max: 0.25, step: 0.001, default: 0.02, label: 'Chromatic Deadzone' },
        chromaticAberrationDeadzoneSoftness: { type: 'slider', min: 0.001, max: 0.25, step: 0.001, default: 0.02, label: 'Deadzone Softness' },
        distortionEdgeCenter: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.50, label: 'Distortion Edge Center' },
        distortionEdgeFeather: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.06, label: 'Distortion Edge Feather' },
        distortionEdgeGamma: { type: 'slider', min: 0.1, max: 4, step: 0.01, default: 1.0, label: 'Distortion Edge Gamma' },
        distortionShoreRemapLo: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.0, label: 'Shore Remap Low' },
        distortionShoreRemapHi: { type: 'slider', min: 0, max: 1, step: 0.01, default: 1.0, label: 'Shore Remap High' },
        distortionShorePow: { type: 'slider', min: 0.1, max: 4, step: 0.01, default: 1.0, label: 'Shore Power' },
        distortionShoreMin: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.0, label: 'Shore Min' },

        rainDistortionEnabled: { type: 'boolean', default: true, label: 'Precip Distortion Enabled' },
        rainDistortionUseWeather: { type: 'boolean', default: true, label: 'Use Weather Precipitation' },
        rainDistortionPrecipitationOverride: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.0, label: 'Precip Override' },
        rainDistortionStrengthPx: { type: 'slider', min: 0, max: 24, step: 0.1, default: 6.0, label: 'Distortion Strength (px)' },
        rainDistortionScale: { type: 'slider', min: 0.5, max: 40, step: 0.1, default: 8.0, label: 'Distortion Scale' },
        rainDistortionSpeed: { type: 'slider', min: 0, max: 4, step: 0.01, default: 1.2, label: 'Distortion Speed' },
        rainIndoorDampingEnabled: { type: 'boolean', default: true, label: 'Indoor Damping' },
        rainIndoorDampingStrength: { type: 'slider', min: 0, max: 2, step: 0.01, default: 1.0, label: 'Indoor Damping Strength' },

        specStrength: { type: 'slider', min: 0, max: 200, step: 0.1, default: 80.0, label: 'Spec Strength' },
        specPower: { type: 'slider', min: 0.1, max: 64, step: 0.1, default: 8.0, label: 'Spec Power' },
        specModel: {
          type: 'dropdown',
          default: 1,
          label: 'Spec Model',
          options: {
            Legacy: 0,
            GGX: 1
          }
        },
        specClamp: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.65, label: 'Spec Clamp' },
        specSunAzimuthDeg: { type: 'slider', min: 0, max: 360, step: 1, default: 135.0, label: 'Sun Azimuth (deg)' },
        specSunElevationDeg: { type: 'slider', min: 0, max: 90, step: 1, default: 45.0, label: 'Sun Elevation (deg)' },
        specSunIntensity: { type: 'slider', min: 0, max: 8, step: 0.01, default: 2.5, label: 'Sun Intensity' },
        specNormalStrength: { type: 'slider', min: 0, max: 4, step: 0.01, default: 1.2, label: 'Normal Strength' },
        specNormalScale: { type: 'slider', min: 0.1, max: 8, step: 0.01, default: 0.6, label: 'Normal Scale' },
        specNormalMode: {
          type: 'dropdown',
          default: 3,
          label: 'Normal Mode',
          options: {
            Default: 0,
            'Variant 1': 1,
            'Variant 2': 2,
            'Variant 3': 3
          }
        },
        specMicroStrength: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.6, label: 'Micro Strength' },
        specMicroScale: { type: 'slider', min: 0.1, max: 8, step: 0.01, default: 1.8, label: 'Micro Scale' },
        specAAStrength: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.0, label: 'Spec AA Strength' },
        specWaveStepMul: { type: 'slider', min: 0.1, max: 6, step: 0.01, default: 2.0, label: 'Wave Step Multiplier' },
        specForceFlatNormal: { type: 'boolean', default: false, label: 'Force Flat Normal' },
        specDisableMasking: { type: 'boolean', default: false, label: 'Disable Spec Masking' },
        specDisableRainSlope: { type: 'boolean', default: false, label: 'Disable Rain Slope' },
        specRoughnessMin: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.05, label: 'Roughness Min' },
        specRoughnessMax: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.30, label: 'Roughness Max' },
        specSurfaceChaos: {
          type: 'slider', min: 0, max: 1, step: 0.01, default: 0.5,
          label: 'Surface chaos',
          tooltip: 'Breaks smooth specular: 0 = legacy glassy pool look.'
        },
        specF0: { type: 'slider', min: 0, max: 1, step: 0.001, default: 0.04, label: 'F0' },
        specMaskGamma: { type: 'slider', min: 0.1, max: 4, step: 0.01, default: 0.5, label: 'Mask Gamma' },
        specSkyTint: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.3, label: 'Sky Tint' },
        skyIntensity: { type: 'slider', min: 0, max: 1, step: 0.01, default: 1.0, label: 'Sky Intensity' },
        specShoreBias: { type: 'slider', min: -1, max: 1, step: 0.01, default: 0.3, label: 'Shore Bias' },
        specDistortionNormalStrength: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.5, label: 'Distortion Normal Strength' },
        specAnisotropy: { type: 'slider', min: -1, max: 1, step: 0.01, default: 0.0, label: 'Anisotropy' },
        specAnisoRatio: { type: 'slider', min: 0.1, max: 8, step: 0.01, default: 2.0, label: 'Aniso Ratio' },

        specHighlightsEnabled: { type: 'boolean', default: true, label: 'Enabled' },
        specHighlightsStrength: { type: 'slider', min: 0, max: 2000, step: 0.1, default: 80.0, label: 'Strength' },
        specHighlightsPower: { type: 'slider', min: 0.1, max: 256, step: 0.1, default: 128.0, label: 'Power (Sharpness)' },
        specHighlightsClamp: { type: 'slider', min: 0, max: 4, step: 0.01, default: 1.2, label: 'Clamp' },
        specHighlightsSunAzimuthDeg: { type: 'slider', min: 0, max: 360, step: 1, default: 135.0, label: 'Sun Azimuth' },
        specHighlightsSunElevationDeg: { type: 'slider', min: 0, max: 90, step: 1, default: 45.0, label: 'Sun Elevation' },
        specHighlightsSunIntensity: { type: 'slider', min: 0, max: 200, step: 0.1, default: 8.0, label: 'Intensity' },
        specHighlightsNormalStrength: { type: 'slider', min: 0, max: 10, step: 0.1, default: 6.0, label: 'Wave Response' },
        specHighlightsNormalScale: { type: 'slider', min: 0.1, max: 20, step: 0.1, default: 12.0, label: 'Normal Scale' },
        specHighlightsRoughnessMin: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.0, label: 'Roughness Min' },
        specHighlightsRoughnessMax: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.2, label: 'Roughness Max' },
        specHighlightsF0: { type: 'slider', min: 0, max: 1, step: 0.001, default: 0.3, label: 'F0' },
        specHighlightsSkyTint: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.8, label: 'Sky Tint' },
        specHighlightsMaskGamma: { type: 'slider', min: 0.1, max: 12, step: 0.1, default: 0.8, label: 'Mask Gamma' },
        specHighlightsShoreBias: { type: 'slider', min: -1, max: 1, step: 0.01, default: -0.5, label: 'Shore Bias' },

        bloomSpecularEmit: {
          type: 'slider',
          min: 0,
          max: 4,
          step: 0.01,
          default: 1.5,
          label: 'Bloom emit',
          tooltip: 'Scales linear energy written to the bloom specular mask (not the beauty pass). Use with Bloom → Water specular sliders for strong glints.',
        },

        specUseSunAngle: { type: 'boolean', default: true, label: 'Use Sun Angle' },
        specSunElevationFalloffEnabled: { type: 'boolean', default: true, label: 'Sun Elevation Falloff' },
        specSunElevationFalloffStart: { type: 'slider', min: 0, max: 90, step: 0.5, default: 35.0, label: 'Falloff Start (deg)' },
        specSunElevationFalloffEnd: { type: 'slider', min: 0, max: 90, step: 0.5, default: 10.0, label: 'Falloff End (deg)' },
        specSunElevationFalloffCurve: { type: 'slider', min: 0.1, max: 8, step: 0.1, default: 2.5, label: 'Falloff Curve' },

        cloudShadowEnabled: { type: 'boolean', default: true, label: 'Cloud Shadow Enabled' },
        cloudShadowDarkenStrength: { type: 'slider', min: 0, max: 3, step: 0.01, default: 1.25, label: 'Darken Strength' },
        cloudShadowDarkenCurve: { type: 'slider', min: 0.1, max: 8, step: 0.01, default: 1.5, label: 'Darken Curve' },
        cloudShadowSpecularKill: { type: 'slider', min: 0, max: 3, step: 0.01, default: 1.0, label: 'Specular Kill' },
        cloudShadowSpecularCurve: { type: 'slider', min: 0.1, max: 12, step: 0.01, default: 6.0, label: 'Specular Curve' },
        
        cloudReflectionEnabled: { type: 'boolean', default: true, label: 'Enabled' },
        cloudReflectionStrength: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.3, label: 'Strength' },

        causticsEnabled: { type: 'boolean', default: true, label: 'Caustics Enabled' },
        causticsBrightnessMaskEnabled: { type: 'boolean', default: true, label: 'Brightness Masking' },
        causticsIntensity: { type: 'slider', min: 0, max: 20, step: 0.1, default: 5.86, label: 'Intensity' },
        causticsScale: { type: 'slider', min: 1, max: 200, step: 0.1, default: 88.6, label: 'Scale' },
        causticsSpeed: { type: 'slider', min: 0, max: 10, step: 0.01, default: 4.0, label: 'Speed' },
        causticsSharpness: { type: 'slider', min: 0.01, max: 1, step: 0.01, default: 0.13, label: 'Sharpness' },
        causticsEdgeLo: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.0, label: 'Edge Low' },
        causticsEdgeHi: { type: 'slider', min: 0, max: 1, step: 0.01, default: 1.0, label: 'Edge High' },
        causticsBrightnessThreshold: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.09, label: 'Brightness Threshold' },
        causticsBrightnessSoftness: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.2, label: 'Brightness Softness' },
        causticsBrightnessGamma: { type: 'slider', min: 0.1, max: 4, step: 0.01, default: 1.0, label: 'Brightness Gamma' },

        shoreFoamEnabled: { type: 'boolean', default: true, label: 'Shore Foam Enabled' },
        shoreFoamStrength: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.19, label: 'Strength' },
        shoreFoamThreshold: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.45, label: 'Threshold' },
        shoreFoamScale: { type: 'slider', min: 1, max: 100, step: 0.1, default: 20.5, label: 'Scale' },
        shoreFoamSpeed: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.1, label: 'Speed' },
        shoreFoamColor: { type: 'color', default: { r: 1.0, g: 1.0, b: 1.0 }, label: 'Color' },
        shoreFoamTint: { type: 'color', default: { r: 0.95, g: 0.97, b: 0.9 }, label: 'Tint' },
        shoreFoamTintStrength: { type: 'slider', min: 0, max: 1, step: 0.01, default: 1.0, label: 'Tint Strength' },
        shoreFoamColorVariation: { type: 'slider', min: 0, max: 1, step: 0.01, default: 1.0, label: 'Variation' },
        shoreFoamOpacity: { type: 'slider', min: 0, max: 1, step: 0.01, default: 1.0, label: 'Opacity' },
        shoreFoamBrightness: { type: 'slider', min: 0, max: 4, step: 0.01, default: 2.0, label: 'Brightness' },
        shoreFoamContrast: { type: 'slider', min: 0, max: 4, step: 0.01, default: 1.98, label: 'Contrast' },
        shoreFoamGamma: { type: 'slider', min: 0.1, max: 4, step: 0.01, default: 0.8, label: 'Gamma' },
        shoreFoamLightingEnabled: { type: 'boolean', default: true, label: 'Enable Lighting' },
        shoreFoamAmbientLight: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.18, label: 'Ambient' },
        shoreFoamSceneLightInfluence: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.8, label: 'Scene Influence' },
        shoreFoamDarknessResponse: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.78, label: 'Darkness Response' },
        shoreFoamFilamentsEnabled: { type: 'boolean', default: true, label: 'Filaments Enabled' },
        shoreFoamFilamentsStrength: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.74, label: 'Filaments Strength' },
        shoreFoamFilamentsScale: { type: 'slider', min: 0.1, max: 20, step: 0.1, default: 5.0, label: 'Filaments Scale' },
        shoreFoamFilamentsLength: { type: 'slider', min: 0.1, max: 10, step: 0.1, default: 4.3, label: 'Filaments Length' },
        shoreFoamFilamentsWidth: { type: 'slider', min: 0.01, max: 1, step: 0.01, default: 0.2, label: 'Filaments Width' },
        shoreFoamThicknessVariation: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.64, label: 'Thickness Var' },
        shoreFoamThicknessScale: { type: 'slider', min: 0.1, max: 20, step: 0.1, default: 4.0, label: 'Thickness Scale' },
        shoreFoamEdgeDetail: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.52, label: 'Edge Detail' },
        shoreFoamEdgeDetailScale: { type: 'slider', min: 0.1, max: 40, step: 0.1, default: 19.8, label: 'Edge Scale' },
        shoreFoamWaveDistortionStrength: { type: 'slider', min: 0, max: 10, step: 0.1, default: 10.0, label: 'Wave Distortion' },
        shoreFoamNoiseDistortionEnabled: { type: 'boolean', default: true, label: 'Noise Dist Enabled' },
        shoreFoamNoiseDistortionStrength: { type: 'slider', min: 0, max: 5, step: 0.01, default: 3.0, label: 'Noise Dist Strength' },
        shoreFoamNoiseDistortionScale: { type: 'slider', min: 0.1, max: 20, step: 0.1, default: 7.4, label: 'Noise Dist Scale' },
        shoreFoamNoiseDistortionSpeed: { type: 'slider', min: 0, max: 5, step: 0.01, default: 0.75, label: 'Noise Dist Speed' },
        shoreFoamEvolutionEnabled: { type: 'boolean', default: true, label: 'Evolution Enabled' },
        shoreFoamEvolutionSpeed: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.46, label: 'Evol Speed' },
        shoreFoamEvolutionAmount: { type: 'slider', min: 0, max: 1, step: 0.01, default: 1.0, label: 'Evol Amount' },
        shoreFoamEvolutionScale: { type: 'slider', min: 0.1, max: 10, step: 0.1, default: 4.4, label: 'Evol Scale' },
        shoreFoamCoreWidth: { type: 'slider', min: 0.01, max: 1, step: 0.01, default: 0.04, label: 'Core Width' },
        shoreFoamCoreFalloff: { type: 'slider', min: 0.01, max: 1, step: 0.01, default: 1.0, label: 'Core Falloff' },
        shoreFoamTailWidth: { type: 'slider', min: 0.01, max: 1, step: 0.01, default: 0.6, label: 'Tail Width' },
        shoreFoamTailFalloff: { type: 'slider', min: 0.01, max: 1, step: 0.01, default: 0.3, label: 'Tail Falloff' },

        floatingFoamStrength: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.57, label: 'Strength' },
        floatingFoamCoverage: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.57, label: 'Coverage' },
        floatingFoamScale: { type: 'slider', min: 1, max: 500, step: 1.0, default: 200.0, label: 'Scale' },
        floatingFoamWaveDistortion: { type: 'slider', min: 0, max: 10, step: 0.01, default: 2.0, label: 'Wave Distortion' },

        floatingFoamColor: { type: 'color', default: { r: 1.0, g: 1.0, b: 1.0 }, label: 'Color' },
        floatingFoamTint: { type: 'color', default: { r: 0.9, g: 0.95, b: 0.85 }, label: 'Tint' },
        floatingFoamTintStrength: { type: 'slider', min: 0, max: 1, step: 0.01, default: 1.0, label: 'Tint Strength' },
        floatingFoamColorVariation: { type: 'slider', min: 0, max: 1, step: 0.01, default: 1.0, label: 'Variation' },
        floatingFoamOpacity: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.78, label: 'Opacity' },
        floatingFoamBrightness: { type: 'slider', min: -1, max: 1, step: 0.01, default: 0.0, label: 'Brightness' },
        floatingFoamContrast: { type: 'slider', min: 0, max: 4, step: 0.01, default: 1.87, label: 'Contrast' },
        floatingFoamGamma: { type: 'slider', min: 0.1, max: 10, step: 0.01, default: 4.0, label: 'Gamma' },
        floatingFoamLightingEnabled: { type: 'boolean', default: true, label: 'Enable Lighting' },
        floatingFoamAmbientLight: { type: 'slider', min: 0, max: 1, step: 0.01, default: 1.0, label: 'Ambient' },
        floatingFoamSceneLightInfluence: { type: 'slider', min: 0, max: 1, step: 0.01, default: 1.0, label: 'Scene Influence' },
        floatingFoamDarknessResponse: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.7, label: 'Darkness Response' },
        floatingFoamShadowEnabled: { type: 'boolean', default: true, label: 'Shadow Enabled' },
        floatingFoamShadowStrength: { type: 'slider', min: 0, max: 1, step: 0.01, default: 1.0, label: 'Shadow Strength' },
        floatingFoamShadowSoftness: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.09, label: 'Shadow Softness' },
        floatingFoamShadowDepth: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.11, label: 'Shadow Depth' },
        floatingFoamFilamentsEnabled: { type: 'boolean', default: true, label: 'Filaments Enabled' },
        floatingFoamFilamentsStrength: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.81, label: 'Filaments Strength' },
        floatingFoamFilamentsScale: { type: 'slider', min: 0.1, max: 20, step: 0.1, default: 3.6, label: 'Filaments Scale' },
        floatingFoamFilamentsLength: { type: 'slider', min: 0.1, max: 10, step: 0.1, default: 3.0, label: 'Filaments Length' },
        floatingFoamFilamentsWidth: { type: 'slider', min: 0.01, max: 1, step: 0.01, default: 0.12, label: 'Filaments Width' },
        floatingFoamThicknessVariation: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.71, label: 'Thickness Var' },
        floatingFoamThicknessScale: { type: 'slider', min: 0.1, max: 20, step: 0.1, default: 2.7, label: 'Thickness Scale' },
        floatingFoamEdgeDetail: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.6, label: 'Edge Detail' },
        floatingFoamEdgeDetailScale: { type: 'slider', min: 0.1, max: 40, step: 0.1, default: 8.0, label: 'Edge Scale' },
        floatingFoamLayerCount: { type: 'slider', min: 1, max: 4, step: 1, default: 2.0, label: 'Layer Count' },
        floatingFoamLayerOffset: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.3, label: 'Layer Offset' },
        floatingFoamWaveDistortionStrength: { type: 'slider', min: 0, max: 20, step: 0.1, default: 10.0, label: 'Wave Distortion' },
        floatingFoamNoiseDistortionEnabled: { type: 'boolean', default: true, label: 'Noise Dist Enabled' },
        floatingFoamNoiseDistortionStrength: { type: 'slider', min: 0, max: 5, step: 0.01, default: 2.46, label: 'Noise Dist Strength' },
        floatingFoamNoiseDistortionScale: { type: 'slider', min: 0.1, max: 20, step: 0.1, default: 3.1, label: 'Noise Dist Scale' },
        floatingFoamNoiseDistortionSpeed: { type: 'slider', min: 0, max: 5, step: 0.01, default: 0.64, label: 'Noise Dist Speed' },
        floatingFoamEvolutionEnabled: { type: 'boolean', default: true, label: 'Evolution Enabled' },
        floatingFoamEvolutionSpeed: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.46, label: 'Evol Speed' },
        floatingFoamEvolutionAmount: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.6, label: 'Evol Amount' },
        floatingFoamEvolutionScale: { type: 'slider', min: 0.1, max: 10, step: 0.1, default: 1.5, label: 'Evol Scale' },

        foamFlecksEnabled: { type: 'boolean', default: true, label: 'Flecks Enabled' },
        foamFlecksIntensity: { type: 'slider', min: 0, max: 5, step: 0.01, default: 0.0, label: 'Flecks Intensity' },

        murkEnabled: { type: 'boolean', default: true, label: 'Murk Enabled' },
        murkIntensity: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.76, label: 'Intensity' },
        murkColor: { type: 'color', default: { r: 0.15, g: 0.22, b: 0.12 }, label: 'Color' },
        murkScale: { type: 'slider', min: 0.1, max: 20, step: 0.1, default: 5.66, label: 'Scale' },
        murkSpeed: { type: 'slider', min: 0, max: 5, step: 0.01, default: 0.45, label: 'Speed' },
        murkDepthLo: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.0, label: 'Depth Low' },
        murkDepthHi: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.8, label: 'Depth High' },
        murkGrainScale: { type: 'slider', min: 10, max: 6000, step: 10, default: 2600.0, label: 'Grain Scale' },
        murkGrainSpeed: { type: 'slider', min: 0, max: 5, step: 0.01, default: 0.6, label: 'Grain Speed' },
        murkGrainStrength: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.8, label: 'Grain Strength' },
        murkDepthFade: { type: 'slider', min: 0, max: 5, step: 0.01, default: 1.8, label: 'Depth Fade' },
        murkShadowEnabled: { type: 'boolean', default: true, label: 'Shadow Enabled' },
        murkShadowStrength: { type: 'slider', min: 0, max: 2, step: 0.01, default: 1.0, label: 'Shadow Strength' },

        bathymetryEnabled: { type: 'boolean', default: true, label: 'Bathymetry Enabled' },
        bathymetryDepthCurve: { type: 'slider', min: 0.05, max: 6, step: 0.01, default: 1.53, label: 'Depth Curve' },
        bathymetryMaxDepth: { type: 'slider', min: 0, max: 10, step: 0.1, default: 3.3, label: 'Max Depth' },
        bathymetryStrength: { type: 'slider', min: 0, max: 3, step: 0.01, default: 1.01, label: 'Strength' },
        bathymetryAbsorptionCoeff: { type: 'color', default: { r: 4.0, g: 1.5, b: 0.1 }, label: 'Absorption' },
        bathymetryDeepScatterColor: { type: 'color', default: { r: 0.02, g: 0.10, b: 0.20 }, label: 'Deep Scatter' },
      }
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Resolve advection speed with backward compatibility.
   * V2 uses advectionSpeed01; legacy V1 presets may set advectionSpeed.
   * @param {object} p
   * @returns {number}
   * @private
   */
  _resolveAdvectionSpeed01(p) {
    const direct = Number(p.advectionSpeed01);
    const legacy = Number(p.advectionSpeed);
    // If V2 value is left at the stock default and a legacy value exists,
    // prefer the legacy value for backwards-compatible preset loading.
    if (Number.isFinite(legacy) && (!Number.isFinite(direct) || Math.abs(direct - 0.15) < 1e-6)) {
      return Math.max(0, legacy * 0.1);
    }
    if (Number.isFinite(direct)) return Math.max(0, direct);
    return 0.15;
  }

  /**
   * Resolve wave appearance rotation in degrees with V1 alias compatibility.
   * V2 name: waveAppearanceRotDeg
   * V1 name: waveAppearanceOffsetDeg
   * @param {object} p
   * @returns {number}
   * @private
   */
  _resolveWaveAppearanceDeg(p) {
    const rot = Number(p.waveAppearanceRotDeg);
    const legacy = Number(p.waveAppearanceOffsetDeg);
    if (Number.isFinite(legacy) && (!Number.isFinite(rot) || Math.abs(rot) < 1e-6)) {
      return legacy;
    }
    if (Number.isFinite(rot)) return rot;
    if (Number.isFinite(legacy)) return legacy;
    return 0;
  }

  /**
   * Create GPU resources: fullscreen quad, shader material, noise texture.
   * Call once after FloorCompositor is ready.
   */
  initialize() {
    if (this._initialized) return;
    const THREE = window.THREE;
    if (!THREE) { log.warn('initialize: THREE not available'); return; }

    this._sizeVec = new THREE.Vector2();

    // Fallback textures for optional samplers (must exist before _buildUniforms)
    this._fallbackBlack = this._make1x1(THREE, 0, 0, 0, 255);
    this._fallbackWhite = this._make1x1(THREE, 255, 255, 255, 255);

    // Noise texture (512x512 RGBA, deterministic seeded LCG)
    this._noiseTexture = WaterEffectV2._createNoiseTexture(THREE);

    // Build initial defines based on default params
    const defines = {};
    if (this.params.foamFlecksEnabled) defines.USE_FOAM_FLECKS = 1;
    if (this.params.refractionMultiTapEnabled) defines.USE_WATER_REFRACTION_MULTITAP = 1;
    // DEFERRED: Create a minimal passthrough material now; heavy shader compiles on first render.
    // This prevents loading hangs caused by ~2400-line GLSL compilation during init.
    this._composeMaterial = this._createMinimalPassthroughMaterial(THREE);
    this._realShaderCompiled = false;
    this._pendingDefines = defines; // Store for real shader creation

    log.info('WaterEffectV2: using minimal passthrough shader (deferred heavy shader compilation)');

    // Fullscreen quad
    this._composeScene = new THREE.Scene();
    this._composeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._composeQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this._composeMaterial
    );
    this._composeQuad.frustumCulled = false;
    this._composeScene.add(this._composeQuad);

    this._blitCopyScene = new THREE.Scene();
    this._blitCopyCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._blitCopyMaterial = new THREE.MeshBasicMaterial({ map: null, toneMapped: false });
    this._blitCopyQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this._blitCopyMaterial
    );
    this._blitCopyQuad.frustumCulled = false;
    this._blitCopyScene.add(this._blitCopyQuad);

    this._initialized = true;
    log.info('WaterEffectV2 initialized');

    // Runtime signature: proves this compositor-v2 WaterEffectV2 is the one executing.
    try {
      if (!this._debugSignatureLogged) {
        this._debugSignatureLogged = true;
        const sig = 'MSA_SIGNATURE: compositor-v2 WaterEffectV2 initialized';
        // Expose a global marker so you can verify from the devtools console.
        if (window.MapShine) window.MapShine.__waterEffectV2Signature = sig;
        log.warn(sig);
      }
    } catch (_) {}
  }

  /**
   * Enable or disable the pass gate used by FloorCompositor.
   * Keeps params.enabled in sync for UI/state consistency.
   *
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    const next = enabled === true;
    this.enabled = next;
    if (this.params && Object.prototype.hasOwnProperty.call(this.params, 'enabled')) {
      this.params.enabled = next;
    }
  }

  /**
   * Returns true when this scene has any discovered water data that can render.
   * @returns {boolean}
   */
  hasRenderableWater() {
    return this._hasAnyWaterData === true;
  }

  /**
   * Discover _Water masks for all tiles, composite per-floor, build SDF.
   * Call after FloorRenderBus.populate() so tile geometry is already built.
   * @param {object} foundrySceneData - Scene geometry data from SceneComposer
   */
  async populate(foundrySceneData) {
    if (!this._initialized) { log.warn('populate: not initialized'); return; }
    const THREE = window.THREE;
    if (!THREE) return;

    // Clear previous state
    this._disposeFloorWater();
    this._waterTiles = [];
    this._hasAnyWaterData = false;

    const tileDocs = canvas?.scene?.tiles?.contents ?? [];

    const floors = window.MapShine?.floorStack?.getFloors() ?? [];
    const worldH = foundrySceneData?.height ?? canvas?.dimensions?.height ?? 0;

    // Scene rect in Foundry coords (top-left origin, Y-down)
    const sceneRect = canvas?.dimensions?.sceneRect ?? canvas?.dimensions;
    const sceneX = sceneRect?.x ?? 0;
    const sceneY = sceneRect?.y ?? 0;
    const sceneW = sceneRect?.width ?? sceneRect?.sceneWidth ?? 1;
    const sceneH = sceneRect?.height ?? sceneRect?.sceneHeight ?? 1;

    // ── Step 0: Discover background _Water mask(s) (if present) ──────────
    // IMPORTANT: do not only check the currently viewed level background.
    // Upper-floor views still need lower-floor background water (fallback render).
    const bgLayers = getVisibleLevelBackgroundLayers(canvas?.scene);
    const bgLayerRows = bgLayers.length
      ? bgLayers
          .map((l, i) => ({
            src: String(l?.src || '').trim(),
            // Background stack order is bottom->top and is routed into the bus
            // with this same index; keep water floor ownership aligned.
            floorIndex: i,
          }))
          .filter((r) => !!r.src)
      : [{
          src: String(getViewedLevelBackgroundSrc(canvas?.scene) ?? canvas?.scene?.background?.src ?? '').trim(),
          floorIndex: Number.isFinite(Number(window.MapShine?.floorStack?.getActiveFloor?.()?.index))
            ? Number(window.MapShine.floorStack.getActiveFloor().index)
            : 0,
        }].filter((r) => !!r.src);
    const seenBgBasePaths = new Set();
    for (const row of bgLayerRows) {
      const bgSrc = row.src;
      const dotIdx = bgSrc.lastIndexOf('.');
      const bgBasePath = dotIdx > 0 ? bgSrc.substring(0, dotIdx) : bgSrc;
      const bgFloorIndex = Number.isFinite(Number(row.floorIndex)) ? Number(row.floorIndex) : 0;
      const bgKey = `${bgFloorIndex}|${bgBasePath}`;
      if (!bgBasePath || seenBgBasePaths.has(bgKey)) continue;
      seenBgBasePaths.add(bgKey);

      let maskPath = null;
      const waterResult = await probeMaskFile(bgBasePath, '_Water');
      if (waterResult?.path) {
        maskPath = waterResult.path;
      }
      // probeMaskFile already checked all formats and cached the result.
      // No need for fallback GET probing - it just causes 404 spam.

      if (maskPath) {
        this._waterTiles.push({
          tileId: '__bg_image__',
          basePath: bgBasePath,
          // Keep scene-wide background water bound to the same floor stack slot
          // as this background layer (bottom->top).
          floorIndex: bgFloorIndex,
          maskPath,
          // Synthetic tileDoc so _compositeFloorMask can treat background like a tile.
          tileDoc: { x: sceneX, y: sceneY, width: sceneW, height: sceneH, rotation: 0 },
        });
      }
    }

    // ── Step 1: Discover _Water masks per tile ───────────────────────────
    for (const tileDoc of tileDocs) {
      const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
      if (!src) continue;
      const tileId = tileDoc.id ?? tileDoc._id;
      if (!tileId) continue;

      const dotIdx = src.lastIndexOf('.');
      const basePath = dotIdx > 0 ? src.substring(0, dotIdx) : src;

      let maskPath = null;
      const waterResult = await probeMaskFile(basePath, '_Water');
      if (waterResult?.path) {
        maskPath = waterResult.path;
      }
      // probeMaskFile already checked all formats and cached the result.
      // No need for fallback GET probing - it just causes 404 spam.
      if (!maskPath) continue;

      const floorIndex = this._resolveFloorIndex(tileDoc, floors);
      this._waterTiles.push({
        tileId, basePath, floorIndex,
        maskPath,
        tileDoc,
      });
    }

    if (this._waterTiles.length === 0) {
      log.warn('WaterEffectV2 populate: no _Water masks found in any tile. Checked', tileDocs.length, 'tiles.');
      // Do not auto-disable runtime gate on a no-data pass.
      // Discovery can be transient during load races; disabling here leaves the
      // effect stuck OFF even when data appears later.
      this._hasAnyWaterData = false;
      return;
    }
    log.info(`WaterEffectV2 populate: found ${this._waterTiles.length} _Water mask(s)`, this._waterTiles.map(t => t.maskPath));

    // ── Step 2: Group tiles by floor ─────────────────────────────────────
    /** @type {Map<number, Array>} */
    const byFloor = new Map();
    for (const entry of this._waterTiles) {
      let arr = byFloor.get(entry.floorIndex);
      if (!arr) { arr = []; byFloor.set(entry.floorIndex, arr); }
      arr.push(entry);
    }

    // ── Step 3: Composite per-floor masks + build SDF ────────────────────
    // Reuse a single canvas across all floors to avoid allocating multiple
    // large (e.g. 1024×1024 × 4 bytes = 4MB) canvas buffers in rapid succession,
    // which can trigger aggressive GC on low-RAM systems.
    let sharedCanvas = null;
    for (const [floorIndex, entries] of byFloor) {
      try {
        const floorData = await this._compositeFloorMask(
          THREE, entries, { sceneX, sceneY, sceneW, sceneH }, sharedCanvas
        );
        // Capture the canvas from the first floor for reuse
        if (!sharedCanvas && floorData?._canvas) {
          sharedCanvas = floorData._canvas;
        }
        if (floorData) {
          delete floorData._canvas; // Don't store the canvas reference in floor data
          this._floorWater.set(floorIndex, floorData);
        }
      } catch (err) {
        log.error(`populate: floor ${floorIndex} mask compositing failed:`, err);
      }
    }
    // Let the shared canvas be GC'd after all floors are processed
    sharedCanvas = null;

    // ── Step 4: Activate water data for the viewed floor (with fallback) ─
    // If the viewed floor has no water, keep rendering the nearest lower floor
    // that does. This preserves ground-floor water when the user moves upstairs.
    const activeFloor = window.MapShine?.floorStack?.getActiveFloor();
    const viewedFloorIndex = Number.isFinite(Number(activeFloor?.index))
      ? Number(activeFloor.index)
      : 0;
    const resolvedWaterFloor = this._resolveWaterFloorForView(viewedFloorIndex);
    this._activeFloorIndex = resolvedWaterFloor >= 0 ? resolvedWaterFloor : viewedFloorIndex;
    if (resolvedWaterFloor >= 0) this._applyFloorWaterData(resolvedWaterFloor);
    else if (this._composeMaterial?.uniforms?.uHasWaterData && this._composeMaterial?.uniforms?.uHasWaterRawMask) {
      this._composeMaterial.uniforms.uHasWaterData.value = 0.0;
      this._composeMaterial.uniforms.uHasWaterRawMask.value = 0.0;
    }
    this._hasAnyWaterData = this._floorWater.size > 0;
    // Keep runtime enabled state stable; render path already checks uniforms/data.

    log.info(`WaterEffectV2 populated: ${this._waterTiles.length} tile(s), ${this._floorWater.size} floor(s)`);
  }

  /**
   * Composite all water mask images for one floor into a single scene-UV canvas,
   * then build the packed water-data texture.
   *
   * Uses canvas 2D compositing so the CPU fallback can work directly from RGBA
   * pixels without needing any separate legacy helper.
   *
   * @param {object} THREE
   * @param {Array} entries - Water tile entries for this floor
   * @param {object} sceneGeo - { sceneX, sceneY, sceneW, sceneH }
   * @returns {Promise<{waterData: object, rawMask: THREE.Texture|null}|null>}
   * @private
   */
  async _compositeFloorMask(THREE, entries, sceneGeo, reuseCanvas = null) {
    const { sceneX, sceneY, sceneW, sceneH } = sceneGeo;

    // Load all mask images in parallel via HTMLImageElement (gives us CPU pixels)
    const loadImg = (url) => this._loadImageInternal(url, { suppressWarn: true });

    const imgPromises = entries.map(e => loadImg(e.maskPath));
    const images = await Promise.all(imgPromises);

    // Filter out failed loads
    const validPairs = [];
    for (let i = 0; i < entries.length; i++) {
      if (images[i]) validPairs.push({ entry: entries[i], img: images[i] });
    }
    if (validPairs.length === 0) {
      log.warn('_compositeFloorMask: all mask images failed to load');
      return null;
    }

    // Determine canvas resolution (proportional to scene, capped at buildResolution)
    const maxRes = this.params.buildResolution || 2048;
    const aspect = sceneW / Math.max(1, sceneH);
    let cvW, cvH;
    if (aspect >= 1) {
      cvW = Math.min(maxRes, maxRes);
      cvH = Math.max(1, Math.round(cvW / aspect));
    } else {
      cvH = Math.min(maxRes, maxRes);
      cvW = Math.max(1, Math.round(cvH * aspect));
    }
    cvW = Math.max(8, Math.min(maxRes, cvW));
    cvH = Math.max(8, Math.min(maxRes, cvH));

    // Reuse provided canvas to avoid allocating multiple large buffers across floors.
    // If the reusable canvas is a different size, resize it (cheap — just updates dimensions).
    let canvas = reuseCanvas;
    if (!canvas || canvas.width !== cvW || canvas.height !== cvH) {
      canvas = reuseCanvas ?? document.createElement('canvas');
      canvas.width = cvW;
      canvas.height = cvH;
    }
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      log.warn('_compositeFloorMask: failed to get 2D context');
      return null;
    }
    ctx.clearRect(0, 0, cvW, cvH);

    for (const { entry, img } of validPairs) {
      const td = entry.tileDoc;
      const tileW = td.width ?? 0;
      const tileH = td.height ?? 0;
      if (tileW <= 0 || tileH <= 0) continue;

      const tileX = td.x ?? 0;
      const tileY = td.y ?? 0;

      // Map tile Foundry rect → canvas pixel rect
      const px = ((tileX - sceneX) / sceneW) * cvW;
      const py = ((tileY - sceneY) / sceneH) * cvH;
      const pw = (tileW / sceneW) * cvW;
      const ph = (tileH / sceneH) * cvH;

      if (typeof td.rotation === 'number' && td.rotation !== 0) {
        // Rotate around tile center
        const cx = px + pw / 2;
        const cy = py + ph / 2;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate((td.rotation * Math.PI) / 180);
        ctx.drawImage(img, -pw / 2, -ph / 2, pw, ph);
        ctx.restore();
      } else {
        ctx.drawImage(img, px, py, pw, ph);
      }
    }

    const imageData = ctx.getImageData(0, 0, cvW, cvH).data;

    // Prefer GPU JFA path (near-instant mask->SDF), with CPU fallback.
    let waterData = null;
    try {
      waterData = this._buildWaterDataGpuJfa(THREE, imageData, cvW, cvH);
    } catch (err) {
      log.warn('_compositeFloorMask: GPU JFA SDF build failed, falling back to CPU path.', err);
    }

    if (!waterData) {
      // Fallback: CPU water-data build from the already composited RGBA pixels.
      try {
        waterData = this._buildWaterDataCpu(THREE, imageData, cvW, cvH);
      } catch (err) {
        log.error('_compositeFloorMask: CPU SDF build failed:', err);
        return null;
      }
    }

    if (!waterData?.hasWater) {
      log.info('_compositeFloorMask: mask found but no water pixels above threshold');
      return null;
    }

    const rawMask = waterData?.rawMaskTexture ?? null;
    // Return the canvas reference so the caller can reuse it for the next floor
    return { waterData, rawMask, _canvas: canvas };
  }

  _detectMaskUseAlpha(rgba) {
    let rMin = 255;
    let rMax = 0;
    let aMin = 255;
    let aMax = 0;
    for (let i = 0; i < rgba.length; i += 16) {
      const r = rgba[i];
      const a = rgba[i + 3];
      if (r < rMin) rMin = r;
      if (r > rMax) rMax = r;
      if (a < aMin) aMin = a;
      if (a > aMax) aMax = a;
    }
    return (aMax - aMin) > ((rMax - rMin) + 8);
  }

  _ensureWaterDataPackResources(THREE) {
    if (this._waterDataPackScene && this._waterDataPackMaterial && this._waterDataPackQuad && this._waterDataPackCamera) return;
    this._waterDataPackScene = new THREE.Scene();
    this._waterDataPackCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._waterDataPackMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tSdf: { value: null },
        uSdfMaxDistancePx: { value: 32.0 },
        uSdfRangePx: { value: 64.0 },
        uExposureWidthPx: { value: 24.0 },
        uMaskExpandPx: { value: 0.0 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tSdf;
        uniform float uSdfMaxDistancePx;
        uniform float uSdfRangePx;
        uniform float uExposureWidthPx;
        uniform float uMaskExpandPx;
        varying vec2 vUv;

        void main() {
          float sdfNorm = texture2D(tSdf, vUv).r;
          float signedPx = (0.5 - sdfNorm) * (2.0 * max(1e-4, uSdfMaxDistancePx)) - uMaskExpandPx;
          float sdf01 = clamp(0.5 + (signedPx / (2.0 * max(1e-4, uSdfRangePx))), 0.0, 1.0);
          float exposure01 = clamp(max(0.0, -signedPx) / max(1e-4, uExposureWidthPx), 0.0, 1.0);
          gl_FragColor = vec4(sdf01, exposure01, 0.5, 0.5);
        }
      `,
      depthWrite: false,
      depthTest: false,
    });
    this._waterDataPackQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._waterDataPackMaterial);
    this._waterDataPackQuad.frustumCulled = false;
    this._waterDataPackScene.add(this._waterDataPackQuad);
  }

  _buildWaterDataGpuJfa(THREE, rgbaPixels, width, height) {
    const renderer = window.MapShine?.renderer;
    if (!renderer) return null;
    if (!this._visionSDF) {
      this._visionSDF = new VisionSDF(renderer, width, height);
      this._visionSDF.initialize();
    } else {
      this._visionSDF.resize(width, height);
    }

    const channel = this.params.maskChannel ?? 'auto';
    const useAlpha = (channel === 'a') ? true : (channel === 'r' ? false : this._detectMaskUseAlpha(rgbaPixels));
    const invert = !!this.params.maskInvert;
    const threshold255 = Math.max(0, Math.min(255, Math.round((this.params.maskThreshold ?? 0.15) * 255)));

    const rawRgba = new Uint8Array(width * height * 4);
    const binRgba = new Uint8Array(width * height * 4);
    let hasWater = false;
    for (let i = 0; i < width * height; i++) {
      const o = i * 4;
      const r = rgbaPixels[o];
      const g = rgbaPixels[o + 1];
      const b = rgbaPixels[o + 2];
      const a = rgbaPixels[o + 3];
      let v;
      if (channel === 'luma') v = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
      else v = useAlpha ? a : r;
      if (invert) v = 255 - v;
      const on = v >= threshold255;
      if (on) hasWater = true;
      const bv = on ? 255 : 0;

      rawRgba[o] = v; rawRgba[o + 1] = v; rawRgba[o + 2] = v; rawRgba[o + 3] = 255;
      binRgba[o] = bv; binRgba[o + 1] = bv; binRgba[o + 2] = bv; binRgba[o + 3] = 255;
    }

    if (!hasWater) {
      return {
        texture: null,
        rawMaskTexture: null,
        transform: null,
        resolution: Math.max(width, height),
        threshold: this.params.maskThreshold ?? 0.15,
        hasWater: false,
      };
    }

    const rawMaskTexture = new THREE.DataTexture(rawRgba, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
    // Linear upscaling: nearest made mask-texel stair-steps obvious at screen res >> composited mask.
    rawMaskTexture.minFilter = THREE.LinearFilter;
    rawMaskTexture.magFilter = THREE.LinearFilter;
    rawMaskTexture.wrapS = THREE.ClampToEdgeWrapping;
    rawMaskTexture.wrapT = THREE.ClampToEdgeWrapping;
    rawMaskTexture.generateMipmaps = false;
    rawMaskTexture.flipY = false;
    if ('colorSpace' in rawMaskTexture && THREE.NoColorSpace) rawMaskTexture.colorSpace = THREE.NoColorSpace;
    rawMaskTexture.needsUpdate = true;

    const binaryMaskTexture = new THREE.DataTexture(binRgba, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
    binaryMaskTexture.minFilter = THREE.NearestFilter;
    binaryMaskTexture.magFilter = THREE.NearestFilter;
    binaryMaskTexture.wrapS = THREE.ClampToEdgeWrapping;
    binaryMaskTexture.wrapT = THREE.ClampToEdgeWrapping;
    binaryMaskTexture.generateMipmaps = false;
    binaryMaskTexture.flipY = false;
    if ('colorSpace' in binaryMaskTexture && THREE.NoColorSpace) binaryMaskTexture.colorSpace = THREE.NoColorSpace;
    binaryMaskTexture.needsUpdate = true;

    const sdfRange = Math.max(1.0, Number(this.params.sdfRangePx ?? 64));
    try {
      // Keep JFA distance normalization aligned with the requested water SDF range.
      this._visionSDF._maxDistance = sdfRange;
      if (this._visionSDF._distanceMaterial?.uniforms?.uMaxDistance) {
        this._visionSDF._distanceMaterial.uniforms.uMaxDistance.value = sdfRange;
      }
    } catch (_) {}

    const sdfTex = this._visionSDF.update(binaryMaskTexture);
    binaryMaskTexture.dispose();
    if (!sdfTex) {
      rawMaskTexture.dispose();
      return null;
    }

    this._ensureWaterDataPackResources(THREE);
    const packTarget = new THREE.WebGLRenderTarget(width, height, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    this._waterDataPackMaterial.uniforms.tSdf.value = sdfTex;
    this._waterDataPackMaterial.uniforms.uSdfMaxDistancePx.value = sdfRange;
    this._waterDataPackMaterial.uniforms.uSdfRangePx.value = sdfRange;
    this._waterDataPackMaterial.uniforms.uExposureWidthPx.value = Math.max(1.0, Number(this.params.shoreWidthPx ?? 24));
    this._waterDataPackMaterial.uniforms.uMaskExpandPx.value = Number(this.params.maskExpandPx ?? 0.0);
    renderer.autoClear = true;
    renderer.setRenderTarget(packTarget);
    renderer.clear();
    renderer.render(this._waterDataPackScene, this._waterDataPackCamera);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;

    return {
      texture: packTarget.texture,
      rawMaskTexture,
      transform: new THREE.Vector4(0, 0, 1, 1),
      resolution: Math.max(width, height),
      threshold: this.params.maskThreshold ?? 0.15,
      hasWater: true,
      _packedTarget: packTarget,
    };
  }

  _buildWaterDataCpu(THREE, rgbaPixels, width, height) {
    const channel = this.params.maskChannel ?? 'auto';
    const useAlpha = (channel === 'a') ? true : (channel === 'r' ? false : this._detectMaskUseAlpha(rgbaPixels));
    const invert = !!this.params.maskInvert;
    const threshold255 = Math.max(0, Math.min(255, Math.round((this.params.maskThreshold ?? 0.15) * 255)));
    const blurRadius = Math.max(0.0, Number(this.params.maskBlurRadius ?? 0.0));
    const blurPasses = Math.max(0, Math.floor(Number(this.params.maskBlurPasses ?? 0)));
    const expandPx = Number.isFinite(this.params.maskExpandPx) ? Number(this.params.maskExpandPx) : 0.0;
    const sdfRangePx = Math.max(1e-3, Number(this.params.sdfRangePx ?? 64));
    const exposureWidthPx = Math.max(1e-3, Number(this.params.shoreWidthPx ?? 24));

    const raw = new Uint8Array(width * height);
    const rawRgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const o = i * 4;
      const r = rgbaPixels[o];
      const g = rgbaPixels[o + 1];
      const b = rgbaPixels[o + 2];
      const a = rgbaPixels[o + 3];
      let v;
      if (channel === 'luma') v = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
      else v = useAlpha ? a : r;
      if (invert) v = 255 - v;
      raw[i] = v;
      rawRgba[o] = v;
      rawRgba[o + 1] = v;
      rawRgba[o + 2] = v;
      rawRgba[o + 3] = 255;
    }

    const rawMaskTexture = new THREE.DataTexture(rawRgba, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
    rawMaskTexture.minFilter = THREE.LinearFilter;
    rawMaskTexture.magFilter = THREE.LinearFilter;
    rawMaskTexture.wrapS = THREE.ClampToEdgeWrapping;
    rawMaskTexture.wrapT = THREE.ClampToEdgeWrapping;
    rawMaskTexture.generateMipmaps = false;
    rawMaskTexture.flipY = false;
    if ('colorSpace' in rawMaskTexture && THREE.NoColorSpace) rawMaskTexture.colorSpace = THREE.NoColorSpace;
    rawMaskTexture.needsUpdate = true;

    const working = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) working[i] = raw[i] / 255.0;

    if (blurPasses > 0 && blurRadius > 1e-4) {
      const tmp = new Float32Array(width * height);
      const rr = Math.max(0.5, blurRadius);
      const radius = Math.min(16, Math.ceil(rr * 3.0));
      const weights = new Float32Array(radius * 2 + 1);
      let wsum = 0.0;
      for (let j = -radius; j <= radius; j++) {
        const weight = Math.exp(-0.5 * (j * j) / (rr * rr));
        weights[j + radius] = weight;
        wsum += weight;
      }
      for (let j = 0; j < weights.length; j++) weights[j] /= Math.max(1e-6, wsum);

      const blur1D = (src, dst, dx, dy) => {
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            let acc = 0.0;
            for (let k = -radius; k <= radius; k++) {
              const xx = Math.max(0, Math.min(width - 1, x + k * dx));
              const yy = Math.max(0, Math.min(height - 1, y + k * dy));
              acc += src[yy * width + xx] * weights[k + radius];
            }
            dst[y * width + x] = acc;
          }
        }
      };

      for (let p = 0; p < blurPasses; p++) {
        blur1D(working, tmp, 1, 0);
        blur1D(tmp, working, 0, 1);
      }
    }

    const threshold = Math.max(0.0, Math.min(1.0, Number(this.params.maskThreshold ?? 0.15)));
    const mask = new Uint8Array(width * height);
    let hasWater = false;
    for (let i = 0; i < width * height; i++) {
      const on = working[i] >= threshold ? 1 : 0;
      mask[i] = on;
      if (on) hasWater = true;
    }

    if (!hasWater) {
      return {
        texture: null,
        rawMaskTexture,
        transform: new THREE.Vector4(0, 0, 1, 1),
        resolution: Math.max(width, height),
        threshold: this.params.maskThreshold ?? 0.15,
        hasWater: false,
      };
    }

    const distToLand = this._distanceTransform(mask, width, height, false);
    const distToWater = this._distanceTransform(mask, width, height, true);
    const packed = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const isWater = mask[i] === 1;
      const sdfPx0 = isWater ? -distToLand[i] : distToWater[i];
      const sdfPx = sdfPx0 - expandPx;
      const sdf01 = this._clamp01(0.5 + (sdfPx / (2.0 * sdfRangePx)));
      const exposure01 = this._clamp01(Math.max(0.0, -sdfPx) / exposureWidthPx);
      const o = i * 4;
      packed[o] = Math.round(sdf01 * 255);
      packed[o + 1] = Math.round(exposure01 * 255);
      packed[o + 2] = 128;
      packed[o + 3] = 128;
    }

    const texture = new THREE.DataTexture(packed, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.flipY = false;
    if ('colorSpace' in texture && THREE.NoColorSpace) texture.colorSpace = THREE.NoColorSpace;
    texture.needsUpdate = true;

    return {
      texture,
      rawMaskTexture,
      transform: new THREE.Vector4(0, 0, 1, 1),
      resolution: Math.max(width, height),
      threshold: this.params.maskThreshold ?? 0.15,
      hasWater: true,
    };
  }

  _distanceTransform(mask01, width, height, toWater) {
    const INF = 1e9;
    const SQRT2 = 1.41421356237;
    const dist = new Float32Array(width * height);

    for (let i = 0; i < width * height; i++) {
      const isWater = mask01[i] === 1;
      const feature = toWater ? isWater : !isWater;
      dist[i] = feature ? 0.0 : INF;
    }

    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const idx = row + x;
        let d = dist[idx];
        if (x > 0) d = Math.min(d, dist[idx - 1] + 1.0);
        if (y > 0) d = Math.min(d, dist[idx - width] + 1.0);
        if (x > 0 && y > 0) d = Math.min(d, dist[idx - width - 1] + SQRT2);
        if (x < width - 1 && y > 0) d = Math.min(d, dist[idx - width + 1] + SQRT2);
        dist[idx] = d;
      }
    }

    for (let y = height - 1; y >= 0; y--) {
      const row = y * width;
      for (let x = width - 1; x >= 0; x--) {
        const idx = row + x;
        let d = dist[idx];
        if (x < width - 1) d = Math.min(d, dist[idx + 1] + 1.0);
        if (y < height - 1) d = Math.min(d, dist[idx + width] + 1.0);
        if (x < width - 1 && y < height - 1) d = Math.min(d, dist[idx + width + 1] + SQRT2);
        if (x > 0 && y < height - 1) d = Math.min(d, dist[idx + width - 1] + SQRT2);
        dist[idx] = d;
      }
    }

    return dist;
  }

  _clamp01(v) {
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  }

  /**
   * @param {string} url
   * @param {{ suppressWarn?: boolean }} [opts]
   * @returns {Promise<HTMLImageElement|null>}
   * @private
   */
  _loadImageInternal(url, opts = {}) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => {
        if (!opts?.suppressWarn) log.warn(`Failed to load water mask image: ${url}`);
        resolve(null);
      };
      img.src = url;
    });
  }

  /**
   * Try loading a mask image by probing common formats via Image() GET.
   * This intentionally avoids FilePicker and HEAD probing, which can fail on
   * some hosted setups even when GET succeeds.
   *
   * @param {string} basePathWithSuffix - e.g. "modules/foo/bar_Map_Water" (no extension)
   * @param {{ formats?: string[] }} [opts]
   * @returns {Promise<{ url: string, image: HTMLImageElement } | null>}
   * @private
   */
  async _tryLoadMaskImage(basePathWithSuffix, opts = {}) {
    if (!basePathWithSuffix) return null;
    const formats = Array.isArray(opts?.formats) && opts.formats.length ? opts.formats : WATER_MASK_FORMATS;
    const cacheKey = `${basePathWithSuffix}::${formats.join(',')}`;

    if (this._directMaskCache?.has(cacheKey)) {
      return this._directMaskCache.get(cacheKey);
    }

    for (const ext of formats) {
      const url = `${basePathWithSuffix}.${ext}`;
      const img = await this._loadImageInternal(url, { suppressWarn: true });
      if (img) {
        const hit = { url, image: img };
        this._directMaskCache.set(cacheKey, hit);
        return hit;
      }
    }

    this._directMaskCache.set(cacheKey, null);
    return null;
  }

  /**
   * Return the active floor's raw water mask texture (used by V1 WeatherParticles
   * for foam point-cloud generation). Returns null when no water data is loaded.
   * @returns {THREE.Texture|null}
   */
  getWaterMaskTexture() {
    const floorData = this._floorWater.get(this._activeFloorIndex);
    return floorData?.rawMask ?? null;
  }

  /**
   * Return the active floor's SDF/water-data texture (used by V1 WeatherParticles
   * foam behaviors for spawn gating and flow-field sampling).
   * Returns null when no water data is loaded.
   * @returns {THREE.Texture|null}
   */
  getWaterDataTexture() {
    const floorData = this._floorWater.get(this._activeFloorIndex);
    return floorData?.waterData?.texture ?? null;
  }

  /**
   * Apply a floor's water data textures to the shader uniforms.
   * @param {number} floorIndex
   * @private
   */
  _applyFloorWaterData(floorIndex) {
    if (!this._composeMaterial) return;
    const u = this._composeMaterial.uniforms;
    if (!u?.tWaterData || !u?.uHasWaterData || !u?.tWaterRawMask || !u?.uHasWaterRawMask) {
      return;
    }
    const floorData = this._floorWater.get(floorIndex);

    // floorData = { waterData: { texture, rawMaskTexture, hasWater, ... }, rawMask }
    const sdfTex = floorData?.waterData?.texture ?? null;
    if (sdfTex) {
      u.tWaterData.value = sdfTex;
      u.uHasWaterData.value = 1.0;

      // Update texel size based on actual SDF texture dimensions
      if (sdfTex.image) {
        const w = sdfTex.image.width || 2048;
        const h = sdfTex.image.height || 2048;
        u.uWaterDataTexelSize.value.set(1.0 / w, 1.0 / h);
      }
    } else {
      u.uHasWaterData.value = 0.0;
    }

    const rawMaskTex = floorData?.rawMask ?? null;
    if (rawMaskTex) {
      u.tWaterRawMask.value = rawMaskTex;
      u.uHasWaterRawMask.value = 1.0;
      if (u.uWaterRawMaskTexelSize) {
        const rw = rawMaskTex.image?.width || rawMaskTex.image?.videoWidth || 2048;
        const rh = rawMaskTex.image?.height || rawMaskTex.image?.videoHeight || 2048;
        u.uWaterRawMaskTexelSize.value.set(1.0 / Math.max(1, rw), 1.0 / Math.max(1, rh));
      }
    } else {
      u.uHasWaterRawMask.value = 0.0;
    }
  }

  /**
   * Feed active-floor water data to legacy WeatherParticles foam systems.
   * @param {number} elapsedSeconds
   * @private
   */
  _syncLegacyFoamParticles(elapsedSeconds) {
    try {
      const wpV2 = window.MapShine?.effectComposer?._floorCompositorV2?._weatherParticles;
      const wp = wpV2?.getWeatherParticles?.() || window.MapShine?.weatherParticles || window.MapShineParticles?.weatherParticles;
      if (!wp) return;

      const floorData = this._floorWater.get(this._activeFloorIndex);
      const waterDataTex = floorData?.waterData?.texture ?? null;

      // Optional scene bounds for world->scene UV mapping on particle behaviors.
      let sceneBounds = null;
      const THREE = window.THREE;
      const dims = canvas?.dimensions;
      if (THREE && dims) {
        const rect = dims.sceneRect ?? dims;
        const sx = rect?.x ?? dims.sceneX ?? 0;
        const sy = rect?.y ?? dims.sceneY ?? 0;
        const sw = rect?.width ?? dims.sceneWidth ?? dims.width ?? 1;
        const sh = rect?.height ?? dims.sceneHeight ?? dims.height ?? 1;
        sceneBounds = new THREE.Vector4(sx, sy, sw, sh);
      }

      if (typeof wp.setWaterDataTexture === 'function') {
        wp.setWaterDataTexture(waterDataTex, sceneBounds);
      }
      if (typeof wp.setFoamParams === 'function') {
        wp.setFoamParams(this.params, elapsedSeconds);
      }
    } catch (_) {}
  }

  /**
   * Dispose all per-floor water data.
   * @private
   */
  _disposeFloorWater() {
    for (const [, data] of this._floorWater) {
      // waterData holds the SDF texture + rawMaskTexture (DataTextures)
      try { data.waterData?.texture?.dispose(); } catch (_) {}
      try { data.waterData?.rawMaskTexture?.dispose(); } catch (_) {}
      try { data.waterData?._packedTarget?.dispose(); } catch (_) {}
      // rawMask is a reference to waterData.rawMaskTexture — already disposed above
    }
    this._floorWater.clear();
  }

  /**
   * Per-frame update. Syncs all time-varying uniforms from params.
   * @param {{ elapsed: number, delta: number }} timeInfo
   */
  update(timeInfo) {
    if (!this._initialized || !this._composeMaterial) return;
    const u = this._composeMaterial.uniforms;
    if (!this._realShaderCompiled || !u?.uTime) return;
    const p = this.params;
    // Derive pause from both TimeManager and Foundry global state.
    // This keeps water frozen even if pause propagation to TimeManager is delayed.
    const foundryPaused = (globalThis.game?.paused === true);
    const scale = Number(timeInfo?.scale);
    const timeManagerPaused = (timeInfo?.paused === true) || (Number.isFinite(scale) && scale <= 1e-6);
    const paused = foundryPaused || timeManagerPaused;

    // Use TimeManager elapsed for active playback, but freeze shader time while paused.
    // Floating foam/specular shaders sample uTime directly, so this must stop changing.
    const rawElapsed = Number(timeInfo?.elapsed);
    if (!paused && Number.isFinite(rawElapsed)) {
      this._shaderTime = rawElapsed;
    }
    const elapsed = this._shaderTime;

    // Derive motion dt from elapsed time (authoritative clock) instead of relying
    // purely on frame delta. This avoids a class of failures where elapsed/uTime
    // advances (caustics animate) but delta is throttled/near-zero so wave/foam
    // advection appears frozen.
    let dt = 0.0;
    if (!paused) {
      const prevElapsed = Number(this._lastAnimElapsed);
      if (Number.isFinite(prevElapsed)) {
        dt = Math.max(0.0, elapsed - prevElapsed);
      } else {
        dt = Math.max(0.0, Number(timeInfo?.motionDelta ?? timeInfo?.delta) || 0.0);
      }
      // Clamp to avoid huge jumps after tab stall/context hiccup.
      dt = Math.min(dt, 1.0 / 20.0);
    }
    this._lastAnimElapsed = elapsed;

    // Runtime signature: log once on first update with key Wind & Flow params.
    try {
      if (!this._debugSignatureUpdateLogged) {
        this._debugSignatureUpdateLogged = true;
        log.warn('MSA_SIGNATURE: WaterEffectV2.update live', {
          waveSpeedWindMinFactor: p.waveSpeedWindMinFactor,
          waveSpeedWindMaxFactor: p.waveSpeedWindMaxFactor,
          waveStrengthWindMinFactor: p.waveStrengthWindMinFactor,
          advectionSpeed01: p.advectionSpeed01,
        });
      }
    } catch (_) {}

    // ── Time ──────────────────────────────────────────────────────────────
    u.uTime.value = elapsed;

    // ── Wind state (WeatherController-coupled with deterministic fallback) ──
    // Keep fallback values stable so the effect behaves consistently when weather
    // is disabled/unavailable.
    let windDirX = 1.0;
    let windDirY = 0.0;
    let windSpeed01 = 0.15;
    try {
      // V2 mode does not always initialize WeatherController.
      // Match CloudEffectV2 behavior: only read WC when initialized; otherwise
      // fall back to the V2 cloud effect's own resolved weather state.
      const wcInitialized = weatherController?.initialized === true;
      const ws = wcInitialized ? weatherController?.getCurrentState?.() : null;
      if (ws) {
        const wx = Number(ws.windDirection?.x);
        const wy = Number(ws.windDirection?.y);
        const wvMS = Number(ws.windSpeedMS);
        const wv01 = Number(ws.windSpeed);
        if (Number.isFinite(wx) && Number.isFinite(wy)) {
          const len = Math.hypot(wx, wy);
          if (len > 1e-5) {
            windDirX = wx / len;
            windDirY = wy / len;
          }
        }
        if (Number.isFinite(wvMS)) {
          windSpeed01 = Math.max(0.0, Math.min(1.0, wvMS / 78.0));
        } else if (Number.isFinite(wv01)) {
          windSpeed01 = Math.max(0.0, Math.min(1.0, wv01));
        }
      } else {
        // CloudEffectV2 maintains its own deterministic fallback wind state.
        // Pull from it so water matches clouds in V2 mode.
        const cloud = window.MapShine?.effectComposer?._floorCompositorV2?._cloudEffect;
        const cs = cloud?._getWeatherState?.();
        if (cs) {
          const wx = Number(cs.windDirX);
          const wy = Number(cs.windDirY);
          const wv = Number(cs.windSpeed);
          if (Number.isFinite(wx) && Number.isFinite(wy)) {
            const len = Math.hypot(wx, wy);
            if (len > 1e-5) {
              windDirX = wx / len;
              windDirY = wy / len;
            }
          }
          if (Number.isFinite(wv)) windSpeed01 = Math.max(0, Math.min(1, wv));
        }
      }
    } catch (_) {}

    // Freeze wind-driving inputs while paused. This prevents paused-frame drift
    // when external weather fallbacks (e.g. cloud fallback state) continue to
    // update off wall-clock time.
    if (paused) {
      const stableLen = Math.hypot(this._waveDirX, this._waveDirY);
      if (stableLen > 1e-6) {
        windDirX = this._waveDirX / stableLen;
        windDirY = this._waveDirY / stableLen;
      }
      windSpeed01 = Number.isFinite(this._smoothedWindSpeed01)
        ? Math.max(0.0, Math.min(1.0, this._smoothedWindSpeed01))
        : 0.0;
    }

    // At very low wind speeds, weather direction can wander/noise rapidly.
    // Freeze to the last stable direction to prevent low-speed wave jitter.
    if (windSpeed01 < 0.06) {
      const stableLen = Math.hypot(this._waveDirX, this._waveDirY);
      if (stableLen > 1e-6) {
        windDirX = this._waveDirX / stableLen;
        windDirY = this._waveDirY / stableLen;
      } else {
        windDirX = 1.0;
        windDirY = 0.0;
      }
    }

    // Wind-direction smoothing: low-pass filter gated by wind speed so
    // calm water remains stable while gusts smoothly steer the wavefield.
    {
      const responsiveness = Math.max(0, Number(p.windDirResponsiveness) || 10.0);
      const speedGate = Math.max(0.05, Math.min(1.0, windSpeed01));
      const dirTrack = responsiveness * (0.20 + 0.80 * speedGate);
      const lerpT = 1.0 - Math.exp(-dirTrack * dt);
      this._smoothedWindDirX += (windDirX - this._smoothedWindDirX) * lerpT;
      this._smoothedWindDirY += (windDirY - this._smoothedWindDirY) * lerpT;
      const smoothLen = Math.hypot(this._smoothedWindDirX, this._smoothedWindDirY);
      if (smoothLen > 1e-5) {
        windDirX = this._smoothedWindDirX / smoothLen;
        windDirY = this._smoothedWindDirY / smoothLen;
      }
    }

    // Wave-direction driving for wave shape.
    // Use a discrete dual-spectrum state to handle wind rotation.
    // Instead of continuously turning the waves (which causes huge sweeping movement far from the UV origin),
    // we snap to a new target direction when the wind rotates enough, and use uWindDirBlend to cross-fade 
    // the wave normals in the shader.
    {
      const len = Math.hypot(windDirX, windDirY);
      const nx = len > 1e-6 ? (windDirX / len) : 1.0;
      const ny = len > 1e-6 ? (windDirY / len) : 0.0;

      const resp = Math.max(0.05, Number(p.windDirResponsiveness) || 2.5);
      const speedGate = Math.max(0.05, Math.min(1.0, windSpeed01));
      const blendRate = resp * (0.12 + 0.52 * speedGate);

      // Advance blend
      this._windDirBlend01 = Math.min(1.0, this._windDirBlend01 + dt * blendRate * 0.5);

      // Calculate angle diff between current tracked wind and target
      const dot = nx * this._targetWindDirX + ny * this._targetWindDirY;
      const angleDiff = Math.acos(Math.max(-1.0, Math.min(1.0, dot)));

      // If blend is complete and wind has rotated > 15 degrees, start a new blend
      if (!paused && this._windDirBlend01 >= 1.0 && angleDiff > 0.26) {
        this._prevWindDirX = this._targetWindDirX;
        this._prevWindDirY = this._targetWindDirY;
        this._targetWindDirX = nx;
        this._targetWindDirY = ny;
        this._windDirBlend01 = 0.0;
      }

      // To keep advection and downstream continuous effects smooth, we still provide a continuously
      // smoothed vector as the main windDir.
      const dirTrack = resp * (0.12 + 0.52 * speedGate);
      const k = 1.0 - Math.exp(-dirTrack * dt);
      this._waveDirX += (nx - this._waveDirX) * k;
      this._waveDirY += (ny - this._waveDirY) * k;

      const dlen = Math.hypot(this._waveDirX, this._waveDirY);
      const wdx = dlen > 1e-6 ? (this._waveDirX / dlen) : 1.0;
      const wdy = dlen > 1e-6 ? (this._waveDirY / dlen) : 0.0;

      // Use this single smoothed direction for all downstream wind-coupled
      // motion (waves/specular/foam/advection) so systems cannot fight.
      windDirX = wdx;
      windDirY = wdy;

      // Apply smoothstep easing to the blend factor
      const sBlend = this._windDirBlend01 * this._windDirBlend01 * (3.0 - 2.0 * this._windDirBlend01);

      // Water shader operates in scene UV (Y-down). Weather/controller wind vectors
      // are Y-up in world space, so convert only the shader-facing uniforms.
      if (u.uPrevWindDir) u.uPrevWindDir.value.set(this._prevWindDirX, -this._prevWindDirY);
      if (u.uTargetWindDir) u.uTargetWindDir.value.set(this._targetWindDirX, -this._targetWindDirY);
      if (u.uWindDirBlend) u.uWindDirBlend.value = sBlend;
    }

    // Wind speed smoothing (V1): asymmetric (fast gain, slow loss).
    // Desired behavior: wind-driven speed-ups should decay at ~half the rate
    // they build up. This prevents advection reversal/ping-pong.
    {
      const resp = Math.max(0.05, Number(p.windDirResponsiveness) || 2.5);
      const respUp = resp;
      const respDown = resp * 0.5;
      const current = Number.isFinite(this._smoothedWindSpeed01) ? this._smoothedWindSpeed01 : 0.0;
      const target = Math.max(0.0, Math.min(1.0, windSpeed01));
      const useResp = target > current ? respUp : respDown;
      const kSpeed = 1.0 - Math.exp(-dt * useResp);
      this._smoothedWindSpeed01 = current + (target - current) * Math.min(1.0, Math.max(0.0, kSpeed));
      windSpeed01 = this._smoothedWindSpeed01;
    }

    // Single wind-motion state used by all movement + strength couplings.
    // This smooths gust response (faster ramp-up, slower decay) while keeping
    // every wind-driven subsystem coherent.
    let windMotion01 = windSpeed01;
    {
      const resp = Math.max(0.05, Number(p.windDirResponsiveness) || 2.5);
      const up = resp * 0.35;
      const down = resp * 0.20;
      const current = Number.isFinite(this._smoothedWaveShapeWind01) ? this._smoothedWaveShapeWind01 : windMotion01;
      const target = Math.max(0.0, Math.min(1.0, windMotion01));
      const rate = target > current ? up : down;
      const k = 1.0 - Math.exp(-dt * rate);
      const filtered = current + (target - current) * Math.min(1.0, Math.max(0.0, k));
      // Mild high-end compression keeps gusts smooth without flattening motion.
      windMotion01 = Math.min(1.0, Math.max(0.0, Math.pow(filtered, 0.90)));
      this._smoothedWaveShapeWind01 = windMotion01;
    }

    // Smoothed wave wind motion — always non-negative, asymmetrically rate-limited.
    // Rise rate is responsive to gusts; fall rate is very slow so wave advection
    // never reverses direction or jerks backward when wind drops.
    {
      const resp = Math.max(0.05, Number(p.windDirResponsiveness) || 2.5);
      const riseRate = resp * 0.50;  // responsive on gusts
      const fallRate = resp * 0.06;  // ~8x slower decay — waves persist through calm spells
      const current = Number.isFinite(this._waveWindMotion01) ? this._waveWindMotion01 : 0.0;
      const target = Math.max(0.0, Math.min(1.0, windMotion01));
      const rate = target > current ? riseRate : fallRate;
      const k = 1.0 - Math.exp(-dt * rate);
      this._waveWindMotion01 = Math.max(0.0, Math.min(1.0, current + (target - current) * k));
    }

    // ── Waves (compute early: used to advance uWindTime) ─────────────────
    // Wave speed: linear in gust energy between calm and full-wind endpoints (× waveSpeed).
    const speedLo = Math.max(0.0, Number(p.waveSpeedWindMinFactor ?? 0.1));
    const speedHiRaw = Number(p.waveSpeedWindMaxFactor ?? 0.55);
    const speedHi = Math.max(speedLo, speedHiRaw);
    const strengthMin = Math.max(0.0, p.waveStrengthWindMinFactor ?? 0.55);
    // Non-linear gust curve:
    // - low/mod wind stays close to the calm baseline
    // - high wind quickly ramps wave energy (faster + taller waves)
    // Map windMotion into a "gust energy" curve that ramps more strongly
    // as wind increases, while preserving calm=0 and gust=1.
    const gust01 = 1.0 - Math.pow(1.0 - this._waveWindMotion01, 1.35);
    const waveSpeed = (speedLo + (speedHi - speedLo) * gust01) * (p.waveSpeed ?? 1.0);
    const waveStrength = (strengthMin + (1.0 - strengthMin) * gust01) * (p.waveStrength ?? 0.6);

    // Wind time: monotonic integration driven by the smoothed wave wind (never reverses).
    this._windTime += dt * (0.1 + gust01 * 0.9);
    this._waveTime += dt * waveSpeed;
    u.uWindTime.value = this._windTime;
    if (u.uWaveTime) u.uWaveTime.value = this._waveTime;

    // Water shader samples scene UV in Y-down space, while weather/controller
    // wind direction is world-space Y-up. Flip Y for shader-facing wind vectors.
    const waterWindDirX = windDirX;
    const waterWindDirY = -windDirY;
    u.uWindDir.value.set(waterWindDirX, waterWindDirY);
    u.uWindSpeed.value = gust01;

    // Debug arrow: visualize the wind direction vector actually used by water.
    this._updateWindDebugArrow(waterWindDirX, waterWindDirY, windMotion01, !!p.debugWindArrow);

    // Advection offset (UV drift from wind) — monotonic integration.
    // Compute drift in scene pixels/sec, normalize by scene dimensions.
    // This produces coherent, non-oscillating pattern travel.
    if (dt > 0.0 && u.uWindOffsetUv) {
      const rect = canvas?.dimensions?.sceneRect;
      const sceneW = rect?.width || 1;
      const sceneH = rect?.height || 1;

      const advSpeed01 = this._resolveAdvectionSpeed01(p);
      const advMulLegacy = Number.isFinite(p.advectionSpeed) ? Math.max(0.0, Number(p.advectionSpeed)) : null;
      const advMul = (advMulLegacy != null) ? advMulLegacy : (advSpeed01 * 4.0);

      // Drive advection strictly by smoothed wave wind speed (no constant base drift, no reversal).
      const pxPerSec = (220.0 * gust01) * advMul;

      const adDeg = Number.isFinite(p.advectionDirOffsetDeg) ? p.advectionDirOffsetDeg : 0.0;
      if (this._cachedAdvectionDirOffsetDeg !== adDeg) {
        const adRad = (adDeg * Math.PI) / 180.0;
        this._cachedAdvectionDirCos = Math.cos(adRad);
        this._cachedAdvectionDirSin = Math.sin(adRad);
        this._cachedAdvectionDirOffsetDeg = adDeg;
      }

      const cs = this._cachedAdvectionDirCos;
      const sn = this._cachedAdvectionDirSin;
      // Integrate advection using the same wind vector sent to the shader.
      const dx = cs * waterWindDirX - sn * waterWindDirY;
      const dy = sn * waterWindDirX + cs * waterWindDirY;

      const du = dx * (pxPerSec * dt) / Math.max(1.0, sceneW);
      const dv = dy * (pxPerSec * dt) / Math.max(1.0, sceneH);

      // Shader sampling uses `sceneUv - uWindOffsetUv`, so increasing the offset
      // moves the visible pattern along +offset. Accumulate forward along the
      // wind direction so waves/foam drift with the wind.
      this._windOffsetUvX += du;
      this._windOffsetUvY += dv;
      u.uWindOffsetUv.value.set(this._windOffsetUvX, this._windOffsetUvY);
    }

    // ── Enable ────────────────────────────────────────────────────────────
    u.uWaterEnabled.value = this.enabled ? 1.0 : 0.0;
    if (u.uUseSdfMask) u.uUseSdfMask.value = p.useSdfMask === false ? 0.0 : 1.0;
    if (u.uWaterRawMaskThreshold) {
      u.uWaterRawMaskThreshold.value = Math.max(0.0, Math.min(1.0, Number(p.maskThreshold ?? 0.15)));
    }

    // ── Tint ──────────────────────────────────────────────────────────────
    const tint = normalizeRgb01(p.tintColor, { r: 0.02, g: 0.18, b: 0.28 });
    u.uTintColor.value.set(tint.r, tint.g, tint.b);
    u.uTintStrength.value = safeNum(p.tintStrength, 0.36);

    // ── Waves ─────────────────────────────────────────────────────────────
    u.uWaveScale.value = safeNum(p.waveScale, 16.0);
    u.uWaveSpeed.value = waveSpeed;
    u.uWaveStrength.value = waveStrength;
    if (u.uWaveMotion01) u.uWaveMotion01.value = gust01;
    u.uDistortionStrengthPx.value = safeNum(p.distortionStrengthPx, 24.0);

    // Wave breakup noise (new). If unset, fall back to legacy waveMicroNormal* params.
    const breakupStrength = safeNum(p.waveBreakupStrength, safeNum(p.waveMicroNormalStrength, 0.0));
    const breakupScale = safeNum(p.waveBreakupScale, safeNum(p.waveMicroNormalScale, 1.0));
    const breakupSpeed = safeNum(p.waveBreakupSpeed, safeNum(p.waveMicroNormalSpeed, 0.0));
    const breakupWarp = safeNum(p.waveBreakupWarp, safeNum(p.waveMicroNormalWarp, 0.0));
    const breakupDist = safeNum(p.waveBreakupDistortionStrength, safeNum(p.waveMicroNormalDistortionStrength, 0.0));
    const breakupSpec = safeNum(p.waveBreakupSpecularStrength, safeNum(p.waveMicroNormalSpecularStrength, 0.0));
    // Extra turbulence coupling: faster/high-wind gusts should add more
    // breakup energy without changing the authored "frequency" feel.
    const turbStrengthMul = 0.85 + 0.65 * gust01; // up to ~1.5x at full gust
    const turbSpeedMul = 0.90 + 0.80 * gust01;    // up to ~1.7x at full gust
    const breakupStrengthEff = breakupStrength * turbStrengthMul;
    const breakupSpeedEff = breakupSpeed * turbSpeedMul;
    const breakupDistEff = breakupDist * turbStrengthMul;
    const breakupSpecEff = breakupSpec * turbStrengthMul;
    if (u.uWaveBreakupStrength) u.uWaveBreakupStrength.value = breakupStrength;
    if (u.uWaveBreakupScale) u.uWaveBreakupScale.value = breakupScale;
    if (u.uWaveBreakupSpeed) u.uWaveBreakupSpeed.value = breakupSpeedEff;
    if (u.uWaveBreakupWarp) u.uWaveBreakupWarp.value = breakupWarp;
    if (u.uWaveBreakupStrength) u.uWaveBreakupStrength.value = breakupStrengthEff;
    if (u.uWaveBreakupDistortionStrength) u.uWaveBreakupDistortionStrength.value = breakupDistEff;
    if (u.uWaveBreakupSpecularStrength) u.uWaveBreakupSpecularStrength.value = breakupSpecEff;

    if (u.uWaveMicroNormalStrength) u.uWaveMicroNormalStrength.value = safeNum(p.waveMicroNormalStrength, 0.0) * turbStrengthMul;
    if (u.uWaveMicroNormalScale) u.uWaveMicroNormalScale.value = safeNum(p.waveMicroNormalScale, 1.0);
    if (u.uWaveMicroNormalSpeed) u.uWaveMicroNormalSpeed.value = safeNum(p.waveMicroNormalSpeed, 0.0) * turbSpeedMul;
    if (u.uWaveMicroNormalWarp) u.uWaveMicroNormalWarp.value = safeNum(p.waveMicroNormalWarp, 0.0);
    if (u.uWaveMicroNormalDistortionStrength) u.uWaveMicroNormalDistortionStrength.value = safeNum(p.waveMicroNormalDistortionStrength, 0.0) * turbStrengthMul;
    if (u.uWaveMicroNormalSpecularStrength) u.uWaveMicroNormalSpecularStrength.value = safeNum(p.waveMicroNormalSpecularStrength, 0.0) * turbStrengthMul;

    u.uWaveWarpLargeStrength.value = safeNum(p.waveWarpLargeStrength, 0.15);
    u.uWaveWarpSmallStrength.value = safeNum(p.waveWarpSmallStrength, 0.08);
    u.uWaveWarpMicroStrength.value = safeNum(p.waveWarpMicroStrength, 0.04);
    u.uWaveWarpTimeSpeed.value = safeNum(p.waveWarpTimeSpeed, 0.15);
    u.uWaveEvolutionEnabled.value = p.waveEvolutionEnabled ? 1.0 : 0.0;
    u.uWaveEvolutionSpeed.value = safeNum(p.waveEvolutionSpeed, 0.15);
    u.uWaveEvolutionAmount.value = safeNum(p.waveEvolutionAmount, 0.3);
    u.uWaveEvolutionScale.value = safeNum(p.waveEvolutionScale, 0.5);
    u.uWaveIndoorDampingEnabled.value = p.waveIndoorDampingEnabled ? 1.0 : 0.0;
    u.uWaveIndoorDampingStrength.value = safeNum(p.waveIndoorDampingStrength, 1.0);
    u.uWaveIndoorMinFactor.value = safeNum(p.waveIndoorMinFactor, 0.05);

    // ── Wave direction ────────────────────────────────────────────────────
    u.uLockWaveTravelToWind.value = p.lockWaveTravelToWind ? 1.0 : 0.0;
    u.uWaveDirOffsetRad.value = (p.waveDirOffsetDeg ?? 0) * (Math.PI / 180);
    const waveAppearanceDeg = this._resolveWaveAppearanceDeg(p);
    u.uWaveAppearanceRotRad.value = waveAppearanceDeg * (Math.PI / 180);
    if (u.uWaveTriBlendAngleRad) u.uWaveTriBlendAngleRad.value = Math.abs((p.waveTriBlendAngleDeg ?? 35.0) * (Math.PI / 180));
    if (u.uWaveTriSideWeight) u.uWaveTriSideWeight.value = Math.max(0.0, Number(p.waveTriSideWeight ?? 0.35));

    // Patchwise wave direction field
    u.uWaveDirFieldEnabled.value = (p.waveDirFieldEnabled === false) ? 0.0 : 1.0;
    u.uWaveDirFieldMaxRad.value = (Number(p.waveDirFieldMaxDeg ?? 45.0) * (Math.PI / 180));
    u.uWaveDirFieldScale.value = Number(p.waveDirFieldScale ?? 0.65);
    u.uWaveDirFieldSpeed.value = Number(p.waveDirFieldSpeed ?? 0.35);

    // ── Distortion edge ───────────────────────────────────────────────────
    u.uDistortionEdgeCenter.value = safeNum(p.distortionEdgeCenter, 1.0);
    u.uDistortionEdgeFeather.value = safeNum(p.distortionEdgeFeather, 0.26);
    u.uDistortionEdgeGamma.value = safeNum(p.distortionEdgeGamma, 1.0);
    u.uDistortionShoreRemapLo.value = safeNum(p.distortionShoreRemapLo, 0.0);
    u.uDistortionShoreRemapHi.value = safeNum(p.distortionShoreRemapHi, 1.0);
    u.uDistortionShorePow.value = safeNum(p.distortionShorePow, 1.29);
    u.uDistortionShoreMin.value = safeNum(p.distortionShoreMin, 0.31);

    // ── Chromatic aberration ──────────────────────────────────────────────
    u.uChromaticAberrationEnabled.value = p.chromaticAberrationEnabled ? 1.0 : 0.0;
    u.uChromaticAberrationStrengthPx.value = safeNum(p.chromaticAberrationStrengthPx, 8.0);
    u.uChromaticAberrationThreshold.value = safeNum(p.chromaticAberrationThreshold, 0.18);
    u.uChromaticAberrationThresholdSoftness.value = safeNum(p.chromaticAberrationThresholdSoftness, 0.47);
    u.uChromaticAberrationKawaseBlurPx.value = safeNum(p.chromaticAberrationKawaseBlurPx, 8.0);
    u.uChromaticAberrationSampleSpread.value = safeNum(p.chromaticAberrationSampleSpread, 0.54);
    u.uChromaticAberrationEdgeCenter.value = safeNum(p.chromaticAberrationEdgeCenter, 0.39);
    u.uChromaticAberrationEdgeFeather.value = safeNum(p.chromaticAberrationEdgeFeather, 0.27);
    u.uChromaticAberrationEdgeGamma.value = safeNum(p.chromaticAberrationEdgeGamma, 0.85);
    u.uChromaticAberrationEdgeMin.value = safeNum(p.chromaticAberrationEdgeMin, 0.0);
    u.uChromaticAberrationDeadzone.value = safeNum(p.chromaticAberrationDeadzone, 0.02);
    u.uChromaticAberrationDeadzoneSoftness.value = safeNum(p.chromaticAberrationDeadzoneSoftness, 0.02);

    // ── Precipitation distortion (WeatherController coupling) ──────────────
    // Resolve precipitation: manual param, override, or live weather.
    let precip = p.rainPrecipitation ?? 0;
    const rainDistortionEnabled = (p.rainDistortionEnabled ?? true) !== false;
    if (!rainDistortionEnabled) {
      precip = 0;
    } else {
      const rainUseWeather = (p.rainDistortionUseWeather ?? true) !== false;
      if (!rainUseWeather) {
        precip = Math.max(0, Math.min(1, Number(p.rainDistortionPrecipitationOverride ?? precip) || 0));
      } else {
        try {
          const ws = weatherController?.getCurrentState?.();
          const weatherPrecip = Number(ws?.precipitation);
          const precipType = Number(ws?.precipType);
          // Treat type=1 (RAIN) and type=3 (HAIL) as liquid precipitation.
          const isLiquid = (precipType === 1 || precipType === 3);
          if (isLiquid && Number.isFinite(weatherPrecip)) {
            precip = Math.max(precip, Math.max(0, Math.min(1, weatherPrecip)));
          }
        } catch (_) {}
      }
    }
    u.uRainEnabled.value = precip > 0.001 ? 1.0 : 0.0;
    u.uRainPrecipitation.value = precip;
    u.uRainDistortionStrengthPx.value = safeNum(p.rainDistortionStrengthPx, 6.0);
    u.uRainDistortionScale.value = safeNum(p.rainDistortionScale, 8.0);
    u.uRainDistortionSpeed.value = safeNum(p.rainDistortionSpeed, 1.2);
    u.uRainIndoorDampingEnabled.value = p.rainIndoorDampingEnabled ? 1.0 : 0.0;
    u.uRainIndoorDampingStrength.value = safeNum(p.rainIndoorDampingStrength, 1.0);

    // ── Specular (GGX) ───────────────────────────────────────────────────
    u.uSpecStrength.value = safeNum(p.specStrength, 200.0);
    u.uSpecPower.value = safeNum(p.specPower, 64.0);
    if (u.uSpecModel) u.uSpecModel.value = (p.specModel ?? 0) ? 1.0 : 0.0;
    if (u.uSpecClamp) u.uSpecClamp.value = safeNum(p.specClamp, 0.0);
    u.uSpecSunIntensity.value = safeNum(p.specSunIntensity, 8.0);
    u.uSpecNormalStrength.value = safeNum(p.specNormalStrength, 4.0);
    u.uSpecNormalScale.value = safeNum(p.specNormalScale, 8.0);
    u.uSpecNormalMode.value = Number.isFinite(Number(p.specNormalMode)) ? Number(p.specNormalMode) : 0.0;
    u.uSpecMicroStrength.value = safeNum(p.specMicroStrength, 0.0);
    u.uSpecMicroScale.value = safeNum(p.specMicroScale, 1.0);
    u.uSpecAAStrength.value = safeNum(p.specAAStrength, 0.0);
    u.uSpecWaveStepMul.value = safeNum(p.specWaveStepMul, 1.0);
    if (u.uSpecForceFlatNormal) u.uSpecForceFlatNormal.value = p.specForceFlatNormal ? 1.0 : 0.0;
    if (u.uSpecDisableMasking) u.uSpecDisableMasking.value = p.specDisableMasking ? 1.0 : 0.0;
    if (u.uSpecDisableRainSlope) u.uSpecDisableRainSlope.value = p.specDisableRainSlope ? 1.0 : 0.0;
    u.uSpecRoughnessMin.value = safeNum(p.specRoughnessMin, 0.0);
    u.uSpecRoughnessMax.value = safeNum(p.specRoughnessMax, 1.0);
    u.uSpecSurfaceChaos.value = safeNum(p.specSurfaceChaos, 0.5);
    u.uSpecF0.value = safeNum(p.specF0, 0.249);
    u.uSpecMaskGamma.value = safeNum(p.specMaskGamma, 0.52);
    u.uSpecSkyTint.value = safeNum(p.specSkyTint, 1.0);
    u.uSpecShoreBias.value = safeNum(p.specShoreBias, -1.0);
    u.uSpecDistortionNormalStrength.value = safeNum(p.specDistortionNormalStrength, 1.32);
    u.uSpecAnisotropy.value = safeNum(p.specAnisotropy, -0.31);
    u.uSpecAnisoRatio.value = safeNum(p.specAnisoRatio, 2.0);

    // ── Specular Highlights (additive sharp highlights) ─────────────────────
    u.uSpecHighlightsEnabled.value = p.specHighlightsEnabled ? 1.0 : 0.0;
    u.uSpecHighlightsStrength.value = safeNum(p.specHighlightsStrength, 80.0);
    u.uSpecHighlightsPower.value = safeNum(p.specHighlightsPower, 128.0);
    u.uSpecHighlightsClamp.value = safeNum(p.specHighlightsClamp, 1.2);
    u.uSpecHighlightsSunIntensity.value = safeNum(p.specHighlightsSunIntensity, 8.0);
    u.uSpecHighlightsNormalStrength.value = safeNum(p.specHighlightsNormalStrength, 6.0);
    u.uSpecHighlightsNormalScale.value = safeNum(p.specHighlightsNormalScale, 12.0);
    u.uSpecHighlightsRoughnessMin.value = safeNum(p.specHighlightsRoughnessMin, 0.0);
    u.uSpecHighlightsRoughnessMax.value = safeNum(p.specHighlightsRoughnessMax, 0.2);
    u.uSpecHighlightsF0.value = safeNum(p.specHighlightsF0, 0.3);
    u.uSpecHighlightsSkyTint.value = safeNum(p.specHighlightsSkyTint, 0.8);
    u.uSpecHighlightsMaskGamma.value = safeNum(p.specHighlightsMaskGamma, 0.8);
    u.uSpecHighlightsShoreBias.value = safeNum(p.specHighlightsShoreBias, -0.5);
    if (u.uBloomSpecularEmitMul) {
      u.uBloomSpecularEmitMul.value = safeNum(p.bloomSpecularEmit, 1.5);
    }

    u.uCloudShadowEnabled.value = p.cloudShadowEnabled ? 1.0 : 0.0;
    u.uCloudShadowDarkenStrength.value = safeNum(p.cloudShadowDarkenStrength, 1.25);
    u.uCloudShadowDarkenCurve.value = safeNum(p.cloudShadowDarkenCurve, 1.5);
    u.uCloudShadowSpecularKill.value = safeNum(p.cloudShadowSpecularKill, 1.0);
    u.uCloudShadowSpecularCurve.value = safeNum(p.cloudShadowSpecularCurve, 6.0);

    // Cloud Reflection
    u.uCloudReflectionEnabled.value = p.cloudReflectionEnabled ? 1.0 : 0.0;
    u.uCloudReflectionStrength.value = safeNum(p.cloudReflectionStrength, 0.3);
    
    // Set cloud top texture from CloudEffectV2
    if (u.uHasCloudTopTexture) {
      const cloudTopTexture = window.MapShine?.effectComposer?._floorCompositorV2?._cloudEffect?.cloudTopTexture;
      
      // Debug: Log if texture is found
      if (!cloudTopTexture) {
        console.warn('[WaterEffectV2] Cloud top texture not found - checking path:', {
          hasMapShine: !!window.MapShine,
          hasEffectComposer: !!window.MapShine?.effectComposer,
          hasFloorCompositor: !!window.MapShine?.effectComposer?._floorCompositorV2,
          hasCloudEffect: !!window.MapShine?.effectComposer?._floorCompositorV2?._cloudEffect,
          hasCloudTopTexture: !!window.MapShine?.effectComposer?._floorCompositorV2?._cloudEffect?.cloudTopTexture
        });
      }
      
      u.tCloudTopTexture.value = cloudTopTexture ?? this._fallbackWhite;
      u.uHasCloudTopTexture.value = cloudTopTexture ? 1.0 : 0.0;
    }

    // Caustics
    u.uCausticsEnabled.value = p.causticsEnabled ? 1.0 : 0.0;
    u.uCausticsIntensity.value = safeNum(p.causticsIntensity, 4.0);
    u.uCausticsScale.value = safeNum(p.causticsScale, 33.4);
    u.uCausticsSpeed.value = safeNum(p.causticsSpeed, 1.05);
    u.uCausticsSharpness.value = safeNum(p.causticsSharpness, 0.15);
    u.uCausticsEdgeLo.value = safeNum(p.causticsEdgeLo, 0.11);
    u.uCausticsEdgeHi.value = safeNum(p.causticsEdgeHi, 1.0);
    if (u.uCausticsBrightnessMaskEnabled) u.uCausticsBrightnessMaskEnabled.value = p.causticsBrightnessMaskEnabled ? 1.0 : 0.0;
    if (u.uCausticsBrightnessThreshold) u.uCausticsBrightnessThreshold.value = Number.isFinite(p.causticsBrightnessThreshold) ? Math.max(0.0, p.causticsBrightnessThreshold) : 0.55;
    if (u.uCausticsBrightnessSoftness) u.uCausticsBrightnessSoftness.value = Number.isFinite(p.causticsBrightnessSoftness) ? Math.max(0.0, p.causticsBrightnessSoftness) : 0.20;
    if (u.uCausticsBrightnessGamma) u.uCausticsBrightnessGamma.value = Number.isFinite(p.causticsBrightnessGamma) ? Math.max(0.01, p.causticsBrightnessGamma) : 1.0;

    // Shore Foam (Advanced)
    const sceneDarkness = globalThis.canvas?.environment?.darknessLevel ?? 0;
    u.uShoreFoamEnabled.value = (p.shoreFoamEnabled ?? true) ? 1.0 : 0.0;
    u.uShoreFoamStrength.value = safeNum(p.shoreFoamStrength, 0.8);
    u.uShoreFoamThreshold.value = safeNum(p.shoreFoamThreshold, 0.28);
    u.uShoreFoamScale.value = safeNum(p.shoreFoamScale, 20.0);
    u.uShoreFoamSpeed.value = safeNum(p.shoreFoamSpeed, 0.1);
    
    // Modulate foam brightness by scene darkness so it doesn't "glow" at night
    const shoreBrightnessBase = safeNum(p.shoreFoamBrightness, 0.6);
    u.uShoreFoamBrightness.value = shoreBrightnessBase * Math.max(0.1, 1.0 - (sceneDarkness * safeNum(p.shoreFoamDarknessResponse, 0.78)));

    const shoreFoamColor = normalizeRgb01(p.shoreFoamColor, { r: 1.0, g: 1.0, b: 1.0 });
    u.uShoreFoamColor.value.set(shoreFoamColor.r, shoreFoamColor.g, shoreFoamColor.b);
    const shoreFoamTint = normalizeRgb01(p.shoreFoamTint, { r: 0.95, g: 0.97, b: 0.9 });
    u.uShoreFoamTint.value.set(shoreFoamTint.r, shoreFoamTint.g, shoreFoamTint.b);
    u.uShoreFoamTintStrength.value = safeNum(p.shoreFoamTintStrength, 0.2);
    u.uShoreFoamColorVariation.value = safeNum(p.shoreFoamColorVariation, 0.15);
    u.uShoreFoamOpacity.value = safeNum(p.shoreFoamOpacity, 1.0);
    u.uShoreFoamContrast.value = safeNum(p.shoreFoamContrast, 1.5);
    u.uShoreFoamGamma.value = safeNum(p.shoreFoamGamma, 0.8);
    u.uShoreFoamLightingEnabled.value = (p.shoreFoamLightingEnabled ?? true) ? 1.0 : 0.0;
    u.uShoreFoamAmbientLight.value = safeNum(p.shoreFoamAmbientLight, 0.5);
    u.uShoreFoamSceneLightInfluence.value = safeNum(p.shoreFoamSceneLightInfluence, 0.8);
    u.uShoreFoamDarknessResponse.value = safeNum(p.shoreFoamDarknessResponse, 0.78);



    u.uShoreFoamFilamentsEnabled.value = (p.shoreFoamFilamentsEnabled ?? true) ? 1.0 : 0.0;
    u.uShoreFoamFilamentsStrength.value = safeNum(p.shoreFoamFilamentsStrength, 0.5);
    u.uShoreFoamFilamentsScale.value = safeNum(p.shoreFoamFilamentsScale, 5.0);
    u.uShoreFoamFilamentsLength.value = safeNum(p.shoreFoamFilamentsLength, 2.0);
    u.uShoreFoamFilamentsWidth.value = safeNum(p.shoreFoamFilamentsWidth, 0.2);
    u.uShoreFoamThicknessVariation.value = safeNum(p.shoreFoamThicknessVariation, 0.4);
    u.uShoreFoamThicknessScale.value = safeNum(p.shoreFoamThicknessScale, 4.0);
    u.uShoreFoamEdgeDetail.value = safeNum(p.shoreFoamEdgeDetail, 0.5);
    u.uShoreFoamEdgeDetailScale.value = safeNum(p.shoreFoamEdgeDetailScale, 10.0);
    u.uShoreFoamWaveDistortionStrength.value = safeNum(p.shoreFoamWaveDistortionStrength, 3.0);
    u.uShoreFoamNoiseDistortionEnabled.value = (p.shoreFoamNoiseDistortionEnabled ?? true) ? 1.0 : 0.0;
    u.uShoreFoamNoiseDistortionStrength.value = safeNum(p.shoreFoamNoiseDistortionStrength, 1.0);
    u.uShoreFoamNoiseDistortionScale.value = safeNum(p.shoreFoamNoiseDistortionScale, 2.5);
    u.uShoreFoamNoiseDistortionSpeed.value = safeNum(p.shoreFoamNoiseDistortionSpeed, 0.4);
    u.uShoreFoamEvolutionEnabled.value = (p.shoreFoamEvolutionEnabled ?? true) ? 1.0 : 0.0;
    u.uShoreFoamEvolutionSpeed.value = safeNum(p.shoreFoamEvolutionSpeed, 0.2);
    u.uShoreFoamEvolutionAmount.value = safeNum(p.shoreFoamEvolutionAmount, 0.5);
    u.uShoreFoamEvolutionScale.value = safeNum(p.shoreFoamEvolutionScale, 2.0);
    u.uShoreFoamCoreWidth.value = safeNum(p.shoreFoamCoreWidth, 0.15);
    u.uShoreFoamCoreFalloff.value = safeNum(p.shoreFoamCoreFalloff, 0.1);
    u.uShoreFoamTailWidth.value = safeNum(p.shoreFoamTailWidth, 0.6);
    u.uShoreFoamTailFalloff.value = safeNum(p.shoreFoamTailFalloff, 0.3);

    // Sun direction from azimuth + elevation (cached to avoid per-frame trig)
    const az = safeNum(p.specSunAzimuthDeg, 135);
    const el = safeNum(p.specSunElevationDeg, 45);
    if (!paused && (az !== this._cachedSunAzDeg || el !== this._cachedSunElDeg)) {
      const azRad = az * (Math.PI / 180);
      const elRad = el * (Math.PI / 180);
      this._cachedSunDirX = Math.cos(elRad) * Math.sin(azRad);
      this._cachedSunDirY = Math.cos(elRad) * Math.cos(azRad);
      this._cachedSunDirZ = Math.sin(elRad);
      this._cachedSunAzDeg = az;
      this._cachedSunElDeg = el;
    }
    u.uSpecSunDir.value.set(this._cachedSunDirX, this._cachedSunDirY, this._cachedSunDirZ);

    // Sun direction for specular highlights (separate azimuth/elevation)
    const hlAz = safeNum(p.specHighlightsSunAzimuthDeg, 135);
    const hlEl = safeNum(p.specHighlightsSunElevationDeg, 45);
    if (!paused && (hlAz !== this._cachedHlSunAzDeg || hlEl !== this._cachedHlSunElDeg)) {
      const hlAzRad = hlAz * (Math.PI / 180);
      const hlElRad = hlEl * (Math.PI / 180);
      const hlCosEl = Math.cos(hlElRad);
      // Same convention as uSpecSunDir (must match shader lighting frame).
      this._cachedHlSunDirX = hlCosEl * Math.sin(hlAzRad);
      this._cachedHlSunDirY = hlCosEl * Math.cos(hlAzRad);
      this._cachedHlSunDirZ = Math.sin(hlElRad);
      this._cachedHlSunAzDeg = hlAz;
      this._cachedHlSunElDeg = hlEl;
    }
    u.uSpecHighlightsSunDir.value.set(this._cachedHlSunDirX, this._cachedHlSunDirY, this._cachedHlSunDirZ);
    u.uSpecHighlightsSunAzimuthDeg.value = hlAz;
    u.uSpecHighlightsSunElevationDeg.value = hlEl;

    // ── Foam ──────────────────────────────────────────────────────────────
    const foamColor = normalizeRgb01(p.foamColor, { r: 0.85, g: 0.9, b: 0.88 });
    u.uFoamColor.value.set(foamColor.r, foamColor.g, foamColor.b);
    u.uFoamStrength.value = safeNum(p.foamStrength, 0.6);
    u.uFoamThreshold.value = safeNum(p.foamThreshold, 0.28);
    u.uFoamShoreCorePower.value = safeNum(p.foamShoreCorePower, 4.5);
    u.uFoamShoreCoreStrength.value = safeNum(p.foamShoreCoreStrength, 1.0);
    u.uFoamShoreTailPower.value = safeNum(p.foamShoreTailPower, 0.6);
    u.uFoamShoreTailStrength.value = safeNum(p.foamShoreTailStrength, 0.2);
    u.uFoamScale.value = safeNum(p.foamScale, 20.0);
    u.uFoamSpeed.value = safeNum(p.foamSpeed, 0.1);
    u.uFoamCurlStrength.value = safeNum(p.foamCurlStrength, 0.35);
    u.uFoamCurlScale.value = safeNum(p.foamCurlScale, 2.0);
    u.uFoamCurlSpeed.value = safeNum(p.foamCurlSpeed, 0.05);
    u.uFoamBreakupStrength1.value = safeNum(p.foamBreakupStrength1, 0.5);
    u.uFoamBreakupScale1.value = safeNum(p.foamBreakupScale1, 3.0);
    u.uFoamBreakupSpeed1.value = safeNum(p.foamBreakupSpeed1, 0.04);
    u.uFoamBreakupStrength2.value = safeNum(p.foamBreakupStrength2, 0.3);
    u.uFoamBreakupScale2.value = safeNum(p.foamBreakupScale2, 7.0);
    u.uFoamBreakupSpeed2.value = safeNum(p.foamBreakupSpeed2, 0.02);
    u.uFoamBlackPoint.value = safeNum(p.foamBlackPoint, 0.0);
    u.uFoamWhitePoint.value = safeNum(p.foamWhitePoint, 1.0);
    u.uFoamGamma.value = safeNum(p.foamGamma, 1.0);
    u.uFoamContrast.value = safeNum(p.foamContrast, 1.0);
    u.uFoamBrightness.value = safeNum(p.foamBrightness, 0.0);
    u.uFloatingFoamStrength.value = safeNum(p.floatingFoamStrength, 0.57);
    u.uFloatingFoamCoverage.value = safeNum(p.floatingFoamCoverage, 0.57);
    u.uFloatingFoamScale.value = safeNum(p.floatingFoamScale, 200.0);
    u.uFloatingFoamWaveDistortion.value = safeNum(p.floatingFoamWaveDistortion, 2.0);
    
    // Floating Foam Advanced (Phase 1)
    const sceneDarknessFloat = globalThis.canvas?.environment?.darknessLevel ?? 0;
    const floatingFoamColor = normalizeRgb01(p.floatingFoamColor, { r: 1.0, g: 1.0, b: 1.0 });
    u.uFloatingFoamColor.value.set(floatingFoamColor.r, floatingFoamColor.g, floatingFoamColor.b);
    const floatingFoamTint = normalizeRgb01(p.floatingFoamTint, { r: 0.9, g: 0.95, b: 0.85 });
    u.uFloatingFoamTint.value.set(floatingFoamTint.r, floatingFoamTint.g, floatingFoamTint.b);
    u.uFloatingFoamTintStrength.value = safeNum(p.floatingFoamTintStrength, 0.3);
    u.uFloatingFoamColorVariation.value = safeNum(p.floatingFoamColorVariation, 0.2);
    u.uFloatingFoamOpacity.value = safeNum(p.floatingFoamOpacity, 1.0);
    
    // Modulate floating foam brightness by scene darkness and response params
    const floatBrightnessBase = safeNum(p.floatingFoamBrightness, 0.5);
    u.uFloatingFoamBrightness.value = floatBrightnessBase * Math.max(0.05, 1.0 - (sceneDarknessFloat * safeNum(p.floatingFoamDarknessResponse, 0.7)));

    u.uFloatingFoamContrast.value = safeNum(p.floatingFoamContrast, 1.8);
    u.uFloatingFoamGamma.value = safeNum(p.floatingFoamGamma, 0.7);
    
    u.uFloatingFoamLightingEnabled.value = (p.floatingFoamLightingEnabled ?? true) ? 1.0 : 0.0;
    u.uFloatingFoamAmbientLight.value = safeNum(p.floatingFoamAmbientLight, 0.4);
    u.uFloatingFoamSceneLightInfluence.value = safeNum(p.floatingFoamSceneLightInfluence, 0.7);
    u.uFloatingFoamDarknessResponse.value = safeNum(p.floatingFoamDarknessResponse, 0.7);
    
    u.uFloatingFoamShadowEnabled.value = (p.floatingFoamShadowEnabled ?? true) ? 1.0 : 0.0;
    u.uFloatingFoamShadowStrength.value = safeNum(p.floatingFoamShadowStrength, 0.35);
    u.uFloatingFoamShadowSoftness.value = safeNum(p.floatingFoamShadowSoftness, 0.5);
    u.uFloatingFoamShadowDepth.value = safeNum(p.floatingFoamShadowDepth, 0.8);
    
    // Floating Foam Complexity (Phase 2)
    u.uFloatingFoamFilamentsEnabled.value = (p.floatingFoamFilamentsEnabled ?? true) ? 1.0 : 0.0;
    u.uFloatingFoamFilamentsStrength.value = safeNum(p.floatingFoamFilamentsStrength, 0.6);
    u.uFloatingFoamFilamentsScale.value = safeNum(p.floatingFoamFilamentsScale, 4.0);
    u.uFloatingFoamFilamentsLength.value = safeNum(p.floatingFoamFilamentsLength, 2.5);
    u.uFloatingFoamFilamentsWidth.value = safeNum(p.floatingFoamFilamentsWidth, 0.15);
    u.uFloatingFoamThicknessVariation.value = safeNum(p.floatingFoamThicknessVariation, 0.5);
    u.uFloatingFoamThicknessScale.value = safeNum(p.floatingFoamThicknessScale, 3.0);
    u.uFloatingFoamEdgeDetail.value = safeNum(p.floatingFoamEdgeDetail, 0.4);
    u.uFloatingFoamEdgeDetailScale.value = safeNum(p.floatingFoamEdgeDetailScale, 8.0);
    u.uFloatingFoamLayerCount.value = safeNum(p.floatingFoamLayerCount, 2.0);
    u.uFloatingFoamLayerOffset.value = safeNum(p.floatingFoamLayerOffset, 0.3);
    
    // Floating Foam Distortion & Evolution
    u.uFloatingFoamWaveDistortionStrength.value = safeNum(p.floatingFoamWaveDistortionStrength, 2.5);
    u.uFloatingFoamNoiseDistortionEnabled.value = (p.floatingFoamNoiseDistortionEnabled ?? true) ? 1.0 : 0.0;
    u.uFloatingFoamNoiseDistortionStrength.value = safeNum(p.floatingFoamNoiseDistortionStrength, 0.8);
    u.uFloatingFoamNoiseDistortionScale.value = safeNum(p.floatingFoamNoiseDistortionScale, 2.0);
    u.uFloatingFoamNoiseDistortionSpeed.value = safeNum(p.floatingFoamNoiseDistortionSpeed, 0.3);
    u.uFloatingFoamEvolutionEnabled.value = (p.floatingFoamEvolutionEnabled ?? true) ? 1.0 : 0.0;
    u.uFloatingFoamEvolutionSpeed.value = safeNum(p.floatingFoamEvolutionSpeed, 0.15);
    u.uFloatingFoamEvolutionAmount.value = safeNum(p.floatingFoamEvolutionAmount, 0.6);
    u.uFloatingFoamEvolutionScale.value = safeNum(p.floatingFoamEvolutionScale, 1.5);
    
    u.uFoamFlecksIntensity.value = safeNum(p.foamFlecksIntensity, 0.0);

    
    // Murk ──────────────────────────────────────────────────────────────
    u.uMurkEnabled.value = p.murkEnabled ? 1.0 : 0.0;
    u.uMurkIntensity.value = safeNum(p.murkIntensity, 0.76);
    const murkColor = normalizeRgb01(p.murkColor, { r: 0.15, g: 0.22, b: 0.12 });
    u.uMurkColor.value.set(murkColor.r, murkColor.g, murkColor.b);
    u.uMurkScale.value = safeNum(p.murkScale, 5.66);
    u.uMurkSpeed.value = safeNum(p.murkSpeed, 0.45);
    u.uMurkDepthLo.value = safeNum(p.murkDepthLo, 0.0);
    u.uMurkDepthHi.value = safeNum(p.murkDepthHi, 0.8);
    u.uMurkGrainScale.value = safeNum(p.murkGrainScale, 2600.0);
    u.uMurkGrainSpeed.value = safeNum(p.murkGrainSpeed, 0.6);
    u.uMurkGrainStrength.value = safeNum(p.murkGrainStrength, 0.8);
    u.uMurkDepthFade.value = safeNum(p.murkDepthFade, 1.8);
    
    // Murk Shadow Integration
    u.uMurkShadowEnabled.value = p.murkShadowEnabled ? 1.0 : 0.0;
    u.uMurkShadowStrength.value = safeNum(p.murkShadowStrength, 1.0);

    // ── Faux bathymetry (Beer-Lambert) ───────────────────────────────────
    if (u.uBathymetryEnabled) u.uBathymetryEnabled.value = p.bathymetryEnabled ? 1.0 : 0.0;
    if (u.uBathymetryDepthCurve) u.uBathymetryDepthCurve.value = Number.isFinite(p.bathymetryDepthCurve) ? Math.max(0.05, p.bathymetryDepthCurve) : 2.0;
    if (u.uBathymetryMaxDepth) u.uBathymetryMaxDepth.value = Number.isFinite(p.bathymetryMaxDepth) ? Math.max(0.0, p.bathymetryMaxDepth) : 2.0;
    if (u.uBathymetryStrength) u.uBathymetryStrength.value = Number.isFinite(p.bathymetryStrength) ? Math.max(0.0, p.bathymetryStrength) : 1.0;
    if (u.uBathymetryAbsorptionCoeff?.value?.set) {
      const a = normalizeRgb01(p.bathymetryAbsorptionCoeff, { r: 4.0, g: 1.5, b: 0.1 });
      u.uBathymetryAbsorptionCoeff.value.set(a.r, a.g, a.b);
    }
    if (u.uBathymetryDeepScatterColor?.value?.set) {
      const c = normalizeRgb01(p.bathymetryDeepScatterColor, { r: 0.02, g: 0.10, b: 0.20 });
      u.uBathymetryDeepScatterColor.value.set(c.r, c.g, c.b);
    }

    // ── Sky / environment ─────────────────────────────────────────────────
    // uSkyIntensity feeds skySpecI = mix(0.08, 1.0, skyI) in the shader.
    // Default 0.5 in _buildUniforms cuts specular by half — bind from params.
    u.uSkyIntensity.value = Math.max(0, Math.min(1, p.skyIntensity ?? 1.0));

    // ── Debug ─────────────────────────────────────────────────────────────
    u.uDebugView.value = p.debugView ?? 0;

    // ── Foundry environment ───────────────────────────────────────────────
    try {
      u.uSceneDarkness.value = globalThis.canvas?.environment?.darknessLevel ?? 0;
    } catch (_) {}

    // ── Shader defines (conditional compilation) ──────────────────────────
    const flecksEnabled = !!p.foamFlecksEnabled;
    const multiTapEnabled = !!p.refractionMultiTapEnabled;
    const definesKey = (flecksEnabled ? DEF_FOAM_FLECKS : 0)
      | (multiTapEnabled ? DEF_MULTITAP : 0);

    if (definesKey !== this._lastDefinesKey) {
      const d = this._composeMaterial.defines || {};
      if (flecksEnabled) d.USE_FOAM_FLECKS = 1; else delete d.USE_FOAM_FLECKS;
      if (multiTapEnabled) d.USE_WATER_REFRACTION_MULTITAP = 1; else delete d.USE_WATER_REFRACTION_MULTITAP;
      this._composeMaterial.defines = d;
      this._composeMaterial.needsUpdate = true;
      this._lastDefinesKey = definesKey;
    }
  }

  _wantsSpecularBloomMrt() {
    try {
      const emit = Number(this.params?.bloomSpecularEmit);
      if (!Number.isFinite(emit) || emit <= 1e-5) return false;
      return !!(window.THREE && window.THREE.WebGLMultipleRenderTargets);
    } catch (_) {
      return false;
    }
  }

  _syncBloomMrtShaderMode() {
    if (!this._composeMaterial) return;
    const want = this._wantsSpecularBloomMrt();
    const key = want ? 1 : 0;
    if (key === this._lastBloomMrtModeKey) return;
    this._lastBloomMrtModeKey = key;
    const d = this._composeMaterial.defines || {};
    if (want) d.USE_WATER_SPEC_BLOOM_RT = 1;
    else delete d.USE_WATER_SPEC_BLOOM_RT;
    this._composeMaterial.defines = d;
    // WebGL2 MRT does not need GL_EXT_draw_buffers on ShaderMaterial (avoids bad #extension in GLSL 300 es).
    this._composeMaterial.extensions = { shaderTextureLOD: true };
    this._composeMaterial.needsUpdate = true;
  }

  /**
   * @param {object} THREE
   * @param {number} w
   * @param {number} h
   */
  _ensureWaterMrt(THREE, w, h) {
    if (!THREE.WebGLMultipleRenderTargets) return null;
    const ww = Math.max(1, w | 0);
    const hh = Math.max(1, h | 0);
    if (this._waterMrt && this._waterMrt.width === ww && this._waterMrt.height === hh) {
      return this._waterMrt;
    }
    try { this._waterMrt?.dispose?.(); } catch (_) {}
    this._waterMrt = new THREE.WebGLMultipleRenderTargets(ww, hh, 2, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    });
    const texArr = this._waterMrt.texture;
    for (let i = 0; i < texArr.length; i++) {
      texArr[i].colorSpace = THREE.LinearSRGBColorSpace;
    }
    return this._waterMrt;
  }

  disposeWaterMrt() {
    try { this._waterMrt?.dispose?.(); } catch (_) {}
    this._waterMrt = null;
  }

  /**
   * Linear specular + highlight mask for {@link BloomEffectV2} (second MRT target).
   * @returns {THREE.Texture|null}
   */
  getWaterSpecularBloomTexture() {
    if (!this._wantsSpecularBloomMrt() || !this._waterMrt) return null;
    const t = this._waterMrt.texture;
    return Array.isArray(t) ? t[1] : null;
  }

  /**
   * Minimal post-processing render pass.
   * For bisection: this is an unconditional passthrough blit (inputRT -> outputRT).
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera} camera
   * @param {THREE.WebGLRenderTarget} inputRT
   * @param {THREE.WebGLRenderTarget} outputRT
   * @param {THREE.WebGLRenderTarget|null} [occluderRT=null]
   * @param {THREE.Texture|null} [sliceAlphaTex=null] Authoritative slice alpha texture.
   * @returns {boolean} true when the pass wrote to outputRT
   */
  render(renderer, camera, inputRT, outputRT, occluderRT = null, sliceAlphaTex = null) {
    if (!this._initialized || !this._composeMaterial || !this._composeScene || !this._composeCamera) return false;
    if (!renderer || !inputRT || !outputRT) return false;
    if (!this.enabled) return false;
    const debugPassRequested = window.MapShine?.__waterDebugForceOccluderMagenta === true;

    // LAZY: start compiling on first actual render frame, but never await it on
    // the live render path. While pending, keep skipping the water pass instead
    // of blocking the frame loop or touching incomplete uniform blocks.
    if (!this._realShaderCompiled && !this._shaderCompilePending) {
      const THREE = window.THREE;
      const now = (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now();
      if (THREE && now >= (this._waterCompileRetryAfterMs || 0)) {
        this._shaderReadyPromise = this._compileRealShaderNow(THREE, renderer).finally(() => {
          try {
            window.MapShine?.renderLoop?.requestRender?.();
            window.MapShine?.renderLoop?.requestContinuousRender?.(250);
          } catch (_) {}
        });
      }
    }
    if (!this._realShaderCompiled) return false;

    const u = this._composeMaterial.uniforms;
    u.tDiffuse.value = inputRT.texture;
    u.uWaterEnabled.value = this.enabled ? 1.0 : 0.0;

    try {
      const fc = window.MapShine?.effectComposer?._floorCompositorV2;
      const bus = fc?._renderBus;
      const vm = Number.isFinite(Number(bus?._visibleMaxFloorIndex))
        ? bus._visibleMaxFloorIndex
        : 0;
      const blurOn = !!(fc?._floorDepthBlurEffect?.params?.enabled && vm > 0);
      this.syncFloorDepthBlurContext(blurOn, vm);
    } catch (_) {}

    // Bind screen-space occluder alpha (upper-floor coverage mask).
    // FloorCompositor._renderPerLevelPipeline renders the alpha union of every
    // floor above `levelIndex` (tiles + __bg_image__ backgrounds) into the
    // compositor's `_waterOccluderRT` just before each per-level water pass,
    // then passes that RT here. Where the mask is 1 (upper-floor geometry
    // covers this pixel), the shader suppresses water shading / alpha-widening
    // — belt-and-braces with LevelCompositePass which also hides the ground
    // water under opaque upper tiles through straight-alpha source-over.
    // `null` is only passed for the topmost visible floor, which has nothing
    // above it to occlude its water.
    try {
      if (u.tWaterOccluderAlpha && u.uHasWaterOccluderAlpha) {
        if (occluderRT?.texture) {
          u.tWaterOccluderAlpha.value = occluderRT.texture;
          u.uHasWaterOccluderAlpha.value = 1.0;
        } else {
          u.uHasWaterOccluderAlpha.value = 0.0;
        }
      }
    } catch (_) {}
    try {
      if (u.tSliceAlpha && u.uHasSliceAlpha) {
        if (sliceAlphaTex) {
          u.tSliceAlpha.value = sliceAlphaTex;
          u.uHasSliceAlpha.value = 1.0;
        } else {
          u.uHasSliceAlpha.value = 0.0;
        }
      }
    } catch (_) {}

    try {
      if (u.uDebugWaterPassTint) {
        if (!debugPassRequested) {
          u.uDebugWaterPassTint.value = 0.0;
        } else {
          const occOn = (Number(u?.uHasWaterOccluderAlpha?.value) || 0) > 0.5;
          const waterGateOk = !!this._hasAnyWaterData
            && ((Number(u?.uHasWaterData?.value) || 0) > 0
              || (Number(u?.uHasWaterRawMask?.value) || 0) > 0);
          if (!waterGateOk) {
            u.uDebugWaterPassTint.value = 3.0;
          } else if (occOn) {
            u.uDebugWaterPassTint.value = 1.0;
          } else {
            u.uDebugWaterPassTint.value = 2.0;
          }
        }
      }
    } catch (_) {}

    if (!this._hasAnyWaterData) {
      if (!debugPassRequested) return false;
    }
    if ((Number(u?.uHasWaterData?.value) || 0) <= 0 && (Number(u?.uHasWaterRawMask?.value) || 0) <= 0) {
      if (!debugPassRequested) return false;
    }

    // Bind resolution and zoom — required by the wave distortion formula.
    // uZoom scales pixel offsets so distortion magnitude is visually consistent
    // at all zoom levels, matching the full water shader's behaviour exactly.
    try {
      if (u.uResolution && this._sizeVec) {
        renderer.getDrawingBufferSize(this._sizeVec);
        u.uResolution.value.set(Math.max(1, this._sizeVec.x), Math.max(1, this._sizeVec.y));
      }
      if (u.uZoom && camera) {
        // Orthographic: camera.zoom is the actual zoom factor.
        // Perspective: use sceneComposer.currentZoom (FOV-based).
        const zoom = camera.isOrthographicCamera
          ? (camera.zoom ?? 1.0)
          : (window.MapShine?.sceneComposer?.currentZoom ?? 1.0);
        u.uZoom.value = Math.max(0.001, zoom);
      }
    } catch (_) {}

    // Bind coordinate conversion uniforms so the debug shader can map
    // screen UV → Foundry world → scene UV to correctly sample the water mask.
    try {
      const dims = globalThis.canvas?.dimensions;
      if (dims && u.uSceneDimensions && u.uSceneRect && u.uHasSceneRect) {
        const totalW = dims.width ?? 1;
        const totalH = dims.height ?? 1;
        u.uSceneDimensions.value.set(totalW, totalH);
        const rect = dims.sceneRect ?? null;
        const sx = rect?.x ?? dims.sceneX ?? 0;
        const sy = rect?.y ?? dims.sceneY ?? 0;
        const sw = rect?.width ?? dims.sceneWidth ?? totalW;
        const sh = rect?.height ?? dims.sceneHeight ?? totalH;
        u.uSceneRect.value.set(sx, sy, sw, sh);
        u.uHasSceneRect.value = 1.0;
      }
    } catch (_) {}

    // Bind view bounds (Three.js world-space frustum corners at ground plane).
    try {
      const THREE = window.THREE;
      if (camera && THREE && u.uViewBounds) {
        if (camera.isOrthographicCamera) {
          const camPos = camera.position;
          u.uViewBounds.value.set(
            camPos.x + camera.left / camera.zoom,
            camPos.y + camera.bottom / camera.zoom,
            camPos.x + camera.right / camera.zoom,
            camPos.y + camera.top / camera.zoom
          );
        } else if (camera.isPerspectiveCamera) {
          const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
          const ndc = new THREE.Vector3();
          const world = new THREE.Vector3();
          const dir = new THREE.Vector3();
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const c of [[-1,-1],[1,-1],[-1,1],[1,1]]) {
            ndc.set(c[0], c[1], 0.5);
            world.copy(ndc).unproject(camera);
            dir.copy(world).sub(camera.position);
            const dz = dir.z;
            if (Math.abs(dz) < 1e-6) continue;
            const t = (groundZ - camera.position.z) / dz;
            if (!Number.isFinite(t) || t <= 0) continue;
            const ix = camera.position.x + dir.x * t;
            const iy = camera.position.y + dir.y * t;
            if (ix < minX) minX = ix; if (iy < minY) minY = iy;
            if (ix > maxX) maxX = ix; if (iy > maxY) maxY = iy;
          }
          if (minX !== Infinity) u.uViewBounds.value.set(minX, minY, maxX, maxY);
        }
      }
    } catch (_) {}

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const THREE = window.THREE;

    this._syncBloomMrtShaderMode();
    const useMrt = !!(THREE?.WebGLMultipleRenderTargets && this._wantsSpecularBloomMrt());

    try {
      if (useMrt && this._blitCopyScene && this._blitCopyCamera && this._blitCopyMaterial) {
        const mrt = this._ensureWaterMrt(THREE, inputRT.width, inputRT.height);
        if (mrt) {
          renderer.setRenderTarget(mrt);
          renderer.autoClear = true;
          renderer.setClearColor(0x000000, 0);
          renderer.render(this._composeScene, this._composeCamera);
          this._blitCopyMaterial.map = mrt.texture[0];
          renderer.setRenderTarget(outputRT);
          renderer.autoClear = true;
          renderer.setClearColor(0x000000, 0);
          renderer.render(this._blitCopyScene, this._blitCopyCamera);
        } else {
          this.disposeWaterMrt();
          renderer.setRenderTarget(outputRT);
          renderer.autoClear = true;
          renderer.setClearColor(0x000000, 0);
          renderer.render(this._composeScene, this._composeCamera);
        }
      } else {
        this.disposeWaterMrt();
        renderer.setRenderTarget(outputRT);
        renderer.autoClear = true;
        renderer.setClearColor(0x000000, 0);
        renderer.render(this._composeScene, this._composeCamera);
      }
    } finally {
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }
    return true;
  }
  /**
   * Handle floor change — swap active water SDF data.
   * @param {number} maxFloorIndex
   */
  onFloorChange(maxFloorIndex) {
    if (!this._initialized) return;
    this._setCrossSliceWaterDataUniform(0);
    const bestFloor = this._resolveWaterFloorForView(maxFloorIndex);

    if (bestFloor >= 0) {
      // Always re-apply uniforms when a valid water floor is resolved.
      // Floor-change events can transiently clear uniforms (bestFloor < 0);
      // if the next valid resolution lands on the same floor index, a strict
      // "index changed" guard would leave water disabled upstairs.
      this._activeFloorIndex = bestFloor;
      this._applyFloorWaterData(bestFloor);
    } else if (bestFloor < 0) {
      // No water on any visible floor — disable water data
      if (this._composeMaterial?.uniforms?.uHasWaterData && this._composeMaterial?.uniforms?.uHasWaterRawMask) {
        this._composeMaterial.uniforms.uHasWaterData.value = 0.0;
        this._composeMaterial.uniforms.uHasWaterRawMask.value = 0.0;
      }
    }
    this._hasAnyWaterData = this._floorWater.size > 0;
  }

  /**
   * Set per-level pipeline context: which floor's packed `_floorWater` textures
   * bind for the upcoming `render()` call.
   *
   * When this slice has no local masks but a lower visible floor does, we bind
   * that floor's pack and set `uCrossSliceWaterData` so the shader only paints
   * water where the **slice RT** is punched out (low `base.a`), and dampens
   * refraction — avoiding the old “SDF over opaque deck” HDR blow-ups while
   * giving the upper post chain a valid water pass over holes.
   *
   * @param {number} levelIndex
   */
  setLevelContext(levelIndex) {
    this.setActiveLevelBackgroundImageTex(null);
    const idx = Number(levelIndex);
    if (!Number.isFinite(idx) || idx < 0) {
      this._perLevelOverride = -1;
      this._setCrossSliceWaterDataUniform(0);
      return -1;
    }
    this._perLevelOverride = idx;
    let dataFloor = idx;
    let crossSlice = false;
    // When this level has no _Water pack, borrow the nearest lower floor's
    // pack so the water surface visible through holes/bridges still renders
    // correctly (composite + shader occluder will still suppress it under
    // upper opaque geometry).
    if (!this._floorWater.has(idx)) {
      const resolved = this._resolveWaterFloorForView(idx);
      if (resolved >= 0 && resolved !== idx) {
        dataFloor = resolved;
        crossSlice = true;
      }
    }
    this._applyFloorWaterData(dataFloor);
    this._setCrossSliceWaterDataUniform(crossSlice ? 1 : 0);
    return dataFloor;
  }

  /**
   * @param {number} v 0 or 1
   * @private
   */
  _setCrossSliceWaterDataUniform(v) {
    try {
      const u = this._composeMaterial?.uniforms?.uCrossSliceWaterData;
      if (u) u.value = v ? 1.0 : 0.0;
    } catch (_) {}
  }

  /**
   * Clear per-level override and restore the global active floor's water data.
   */
  clearLevelContext() {
    this._perLevelOverride = -1;
    this._syncGlobalWaterBindingsFromViewedFloor();
    this._setCrossSliceWaterDataUniform(0);
    this.setActiveLevelBackgroundImageTex(null);
  }

  /**
   * Bind the bus background image map for the **active** scene floor (alpha only
   * used in shader when enabled). Pass null to disable.
   * @param {import('three').Texture|null} tex
   */
  setActiveLevelBackgroundImageTex(tex) {
    try {
      const u = this._composeMaterial?.uniforms;
      if (u?.tWaterActiveBgImage) {
        u.tWaterActiveBgImage.value = tex ?? this._fallbackBlack;
      }
      if (u?.uHasWaterActiveBgImage) {
        u.uHasWaterActiveBgImage.value = tex ? 1.0 : 0.0;
      }
    } catch (_) {}
  }

  /**
   * Fullscreen water over the **merged** multi-floor composite (`tDiffuse` already
   * stacks levels with straight-alpha). Holes and deck occlusion are encoded in
   * that image — do not use cross-slice punch (`tSliceAlpha` / borrowed-slice
   * heuristics), which targeted per-slice RTs and fought the merge.
   *
   * @param {number} viewedFloorIndex - FloorStack active floor index (top of stack).
   * @returns {number} Packed-water data floor bound for outdoors/mask, or -1.
   */
  setPostMergeWaterContext(viewedFloorIndex) {
    const v = Number(viewedFloorIndex);
    this._perLevelOverride = -1;
    if (!Number.isFinite(v) || v < 0) {
      this._setCrossSliceWaterDataUniform(0);
      return -1;
    }
    const dataFloor = this._resolveWaterFloorForView(v);
    if (dataFloor >= 0) {
      this._activeFloorIndex = dataFloor;
      this._applyFloorWaterData(dataFloor);
    }
    this._setCrossSliceWaterDataUniform(0);
    return dataFloor;
  }

  /**
   * Re-bind packed water textures for **global** shader state after per-level passes
   * or async shader swap. Uses the same “nearest floor ≤ viewed floor with water”
   * rule as `populate()` / `onFloorChange()`, so we never leave `uHasWaterData` stuck
   * at 0 after `setLevelContext(upper)` when water only exists downstairs.
   * @private
   */
  _syncGlobalWaterBindingsFromViewedFloor() {
    let viewedIdx = NaN;
    try {
      const n = Number(window.MapShine?.floorStack?.getActiveFloor?.()?.index);
      if (Number.isFinite(n)) viewedIdx = n;
    } catch (_) {}

    const resolved = Number.isFinite(viewedIdx)
      ? this._resolveWaterFloorForView(viewedIdx)
      : -1;

    if (resolved >= 0) {
      this._activeFloorIndex = resolved;
      this._applyFloorWaterData(resolved);
      return;
    }

    if (this._activeFloorIndex >= 0 && this._floorWater.has(this._activeFloorIndex)) {
      this._applyFloorWaterData(this._activeFloorIndex);
      return;
    }

    const u = this._composeMaterial?.uniforms;
    if (u?.uHasWaterData) u.uHasWaterData.value = 0.0;
    if (u?.uHasWaterRawMask) u.uHasWaterRawMask.value = 0.0;
  }

  /**
   * Returns whether water data exists for an exact floor index.
   * Useful for deciding whether floor-specific occlusion should apply.
   *
   * @param {number} floorIndex
   * @returns {boolean}
   */
  hasFloorWaterData(floorIndex) {
    const idx = Number(floorIndex);
    if (!Number.isFinite(idx)) return false;
    return this._floorWater.has(idx);
  }

  /**
   * Resolve which floor's water data should drive rendering for a viewed floor.
   * Returns the highest floor index with water where index <= viewed floor.
   *
   * @param {number} viewedFloorIndex
   * @returns {number} resolved floor index, or -1 if none
   * @private
   */
  _resolveWaterFloorForView(viewedFloorIndex) {
    const viewedIdx = Number(viewedFloorIndex);
    const upperBound = Number.isFinite(viewedIdx)
      ? viewedIdx
      : Number.isFinite(Number(this._activeFloorIndex))
        ? Number(this._activeFloorIndex)
        : 0;
    let bestFloor = -1;
    for (const floorIndex of this._floorWater.keys()) {
      const idx = Number(floorIndex);
      if (!Number.isFinite(idx)) continue;
      if (idx <= upperBound && idx > bestFloor) bestFloor = idx;
    }
    return bestFloor;
  }

  /**
   * Resize handler (no internal RTs to resize for the compose pass itself,
   * but mask RTs may need rebuilding if we ever tie them to screen resolution).
   */
  onResize(w, h) {
    // No-op for now. Mask RTs are scene-resolution, not screen-resolution.
  }

  /**
   * Full dispose — call on scene teardown.
   */
  dispose() {
    // Dispose per-floor water data (mask RTs, SDF textures, raw masks)
    this._disposeFloorWater();
    this._waterTiles = [];
    this._hasAnyWaterData = false;

    // Dispose compose quad resources
    try { this._composeMaterial?.dispose(); } catch (_) {}
    try { this._composeQuad?.geometry?.dispose(); } catch (_) {}
    this._composeScene = null;
    this._composeCamera = null;
    this._composeMaterial = null;
    this._composeQuad = null;

    try { this._blitCopyMaterial?.dispose(); } catch (_) {}
    try { this._blitCopyQuad?.geometry?.dispose(); } catch (_) {}
    this._blitCopyScene = null;
    this._blitCopyCamera = null;
    this._blitCopyMaterial = null;
    this._blitCopyQuad = null;
    this.disposeWaterMrt();
    this._lastBloomMrtModeKey = -1;

    // Dispose noise texture
    try { this._noiseTexture?.dispose(); } catch (_) {}
    this._noiseTexture = null;

    // Dispose GPU JFA / water-data packing resources
    try { this._visionSDF?.dispose?.(); } catch (_) {}
    this._visionSDF = null;
    try { this._waterDataPackMaterial?.dispose?.(); } catch (_) {}
    try { this._waterDataPackQuad?.geometry?.dispose?.(); } catch (_) {}
    this._waterDataPackScene = null;
    this._waterDataPackCamera = null;
    this._waterDataPackMaterial = null;
    this._waterDataPackQuad = null;

    // Dispose fallback textures
    try { this._fallbackBlack?.dispose(); } catch (_) {}
    try { this._fallbackWhite?.dispose(); } catch (_) {}
    this._fallbackBlack = null;
    this._fallbackWhite = null;

    // Remove debug arrow DOM element if present
    if (this._windDebugArrow) {
      try { document.body.removeChild(this._windDebugArrow); } catch (_) {}
      this._windDebugArrow = null;
    }

    // Reset state
    this._windTime = 0;
    this._windOffsetUvX = 0;
    this._windOffsetUvY = 0;
    this._smoothedWaveShapeWind01 = 0;
    this._lastDefinesKey = -1;
    this._firstRenderDone = false;
    this._activeFloorIndex = 0;

    this._initialized = false;
    log.info(`WaterEffectV2 disposed (${this._instanceId})`);
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  /**
   * Creates (lazily) and updates the wind direction debug arrow DOM overlay.
   * The arrow points in the direction the wind is blowing toward in screen space,
   * using the same (windDirX, windDirY) vector that is sent to the shader as uWindDir.
   * This lets us visually verify the coordinate-space convention before adjusting shaders.
   *
   * windDirX/Y are in Foundry Y-down space. Screen Y is also down, so the mapping is direct:
   *   angle = atan2(x, -y)  →  degrees clockwise from screen-up (north).
   *
   * @param {number} windDirX - Normalized wind X (Foundry Y-down space)
   * @param {number} windDirY - Normalized wind Y (Foundry Y-down space)
   * @param {number} speed01  - Wind speed 0-1
   * @param {boolean} visible - Whether the overlay should be shown
   * @private
   */
  _updateWindDebugArrow(windDirX, windDirY, speed01, visible) {
    if (!visible) {
      if (this._windDebugArrow) this._windDebugArrow.style.display = 'none';
      return;
    }

    // Lazy creation — only build the DOM element when first needed.
    if (!this._windDebugArrow) {
      const el = document.createElement('div');
      el.id = 'ms-wind-debug-arrow';
      el.style.cssText = [
        'position:fixed',
        'top:20px',
        'left:50%',
        'transform:translateX(-50%)',
        'width:90px',
        'height:90px',
        'pointer-events:none',
        'z-index:99999',
        'display:flex',
        'flex-direction:column',
        'align-items:center',
        'justify-content:center',
        'background:rgba(0,0,0,0.60)',
        'border-radius:50%',
        'border:2px solid #f00',
        'box-sizing:border-box',
      ].join(';');
      // SVG arrow — rotated each frame via transform on the <svg> element.
      // Arrow points UP by default; CSS rotation turns it toward the wind direction.
      // The label sits below the circle via absolute positioning.
      el.innerHTML = `
        <div style="position:relative;width:58px;height:58px;flex-shrink:0">
          <svg id="ms-wind-svg-raw" width="58" height="58" viewBox="-1 -1 2 2"
               style="position:absolute;left:0;top:0;display:block;overflow:visible">
            <line x1="0" y1="0.55" x2="0" y2="-0.45"
                  stroke="#ff2222" stroke-width="0.13" stroke-linecap="round"/>
            <polygon points="0,-0.90 -0.22,-0.42 0.22,-0.42" fill="#ff2222"/>
            <circle cx="0" cy="0" r="0.10" fill="#ff2222"/>
          </svg>
          <svg id="ms-wind-svg-yflip" width="58" height="58" viewBox="-1 -1 2 2"
               style="position:absolute;left:0;top:0;display:block;overflow:visible">
            <line x1="0" y1="0.55" x2="0" y2="-0.45"
                  stroke="#22aaff" stroke-width="0.11" stroke-linecap="round"/>
            <polygon points="0,-0.90 -0.20,-0.44 0.20,-0.44" fill="#22aaff"/>
          </svg>
        </div>
        <div id="ms-wind-label"
             style="position:absolute;bottom:-18px;font:10px/1 monospace;
                    color:#ff2222;text-align:center;white-space:nowrap;
                    text-shadow:0 1px 2px #000"></div>
      `;
      document.body.appendChild(el);
      this._windDebugArrow = el;
    }

    this._windDebugArrow.style.display = 'flex';

    // Two-arrow display:
    // - RAW (red): what the water effect is currently using.
    // - Y-FLIP (blue): same vector but with Y negated, for diagnosing the common
    //   "everything is Y-flipped" mismatch between Foundry (Y-down) and Three (Y-up).
    //
    // Both are rendered as clockwise degrees from screen-up.
    const angleRawDeg  = Math.atan2(windDirX,  windDirY) * (180 / Math.PI);
    const angleFlipDeg = Math.atan2(windDirX, -windDirY) * (180 / Math.PI);

    const svgRaw = this._windDebugArrow.querySelector('#ms-wind-svg-raw');
    if (svgRaw) svgRaw.style.transform = `rotate(${angleRawDeg.toFixed(1)}deg)`;
    const svgFlip = this._windDebugArrow.querySelector('#ms-wind-svg-yflip');
    if (svgFlip) svgFlip.style.transform = `rotate(${angleFlipDeg.toFixed(1)}deg)`;

    const lbl = this._windDebugArrow.querySelector('#ms-wind-label');
    if (lbl) {
      lbl.textContent = `${this._instanceId} | raw ${Math.round(angleRawDeg)}° | yflip ${Math.round(angleFlipDeg)}° | spd ${speed01.toFixed(2)}`;
    }
  }

  /**
   * Build the uniforms object for the water shader material.
   * @param {object} THREE
   * @returns {object} Uniforms dict
   * @private
   */
  static _buildUniforms(THREE, p, noiseTex, waterData, waterRawMask, waterOccluderAlpha, fallbacks) {
    const tintColor = normalizeRgb01(p.tintColor, { r: 0.02, g: 0.18, b: 0.28 });
    const foamColor = normalizeRgb01(p.foamColor, { r: 0.85, g: 0.9, b: 0.88 });
    const shoreFoamColor = normalizeRgb01(p.shoreFoamColor, { r: 1.0, g: 1.0, b: 1.0 });
    const shoreFoamTint = normalizeRgb01(p.shoreFoamTint, { r: 0.95, g: 0.97, b: 0.9 });
    const murkColor = normalizeRgb01(p.murkColor, { r: 0.15, g: 0.22, b: 0.12 });
    const bathAbsorb = normalizeRgb01(p.bathymetryAbsorptionCoeff, { r: 4.0, g: 1.5, b: 0.1 });
    const bathScatter = normalizeRgb01(p.bathymetryDeepScatterColor, { r: 0.02, g: 0.10, b: 0.20 });
    return {
      tDiffuse:            { value: fallbacks.black },
      tNoiseMap:           { value: noiseTex ?? fallbacks.black },
      tWaterData:          { value: waterData ?? fallbacks.black },
      uHasWaterData:       { value: waterData ? 1.0 : 0.0 },
      uWaterEnabled:       { value: this.enabled ? 1.0 : 0.0 },
      uCrossSliceWaterData: { value: 0.0 },
      uUseSdfMask:         { value: p.useSdfMask === false ? 0.0 : 1.0 },
      tWaterRawMask:       { value: waterRawMask ?? fallbacks.black },
      uHasWaterRawMask:    { value: waterRawMask ? 1.0 : 0.0 },
      uWaterRawMaskThreshold: {
        value: Math.max(0.0, Math.min(1.0, Number(p.maskThreshold ?? 0.15))),
      },
      uWaterRawMaskTexelSize: { value: new THREE.Vector2(1 / 2048, 1 / 2048) },
      tWaterOccluderAlpha: { value: waterOccluderAlpha ?? fallbacks.black },
      uHasWaterOccluderAlpha: { value: waterOccluderAlpha ? 1.0 : 0.0 },
      tWaterActiveBgImage: { value: fallbacks.black },
      uHasWaterActiveBgImage: { value: 0.0 },
      uDebugWaterPassTint: { value: 0.0 },
      tSliceAlpha:        { value: fallbacks.black },
      uHasSliceAlpha:     { value: 0.0 },
      uWaterDataTexelSize: { value: new THREE.Vector2(1 / 2048, 1 / 2048) },

      // Tint
      uTintColor:    { value: new THREE.Vector3(tintColor.r, tintColor.g, tintColor.b) },
      uTintStrength: { value: p.tintStrength },

      // Waves
      uWaveScale:              { value: p.waveScale },
      uWaveSpeed:              { value: p.waveSpeed },
      uWaveStrength:           { value: p.waveStrength },
      uWaveMotion01:           { value: 1.0 },
      uDistortionStrengthPx:   { value: p.distortionStrengthPx },

      uWaveBreakupStrength: { value: (p.waveBreakupStrength ?? p.waveMicroNormalStrength) ?? 0.0 },
      uWaveBreakupScale:    { value: (p.waveBreakupScale ?? p.waveMicroNormalScale) ?? 1.0 },
      uWaveBreakupSpeed:    { value: (p.waveBreakupSpeed ?? p.waveMicroNormalSpeed) ?? 0.0 },
      uWaveBreakupWarp:     { value: (p.waveBreakupWarp ?? p.waveMicroNormalWarp) ?? 0.0 },
      uWaveBreakupDistortionStrength: { value: (p.waveBreakupDistortionStrength ?? p.waveMicroNormalDistortionStrength) ?? 0.0 },
      uWaveBreakupSpecularStrength:   { value: (p.waveBreakupSpecularStrength ?? p.waveMicroNormalSpecularStrength) ?? 0.0 },

      uWaveMicroNormalStrength: { value: p.waveMicroNormalStrength ?? 0.0 },
      uWaveMicroNormalScale:    { value: p.waveMicroNormalScale ?? 1.0 },
      uWaveMicroNormalSpeed:    { value: p.waveMicroNormalSpeed ?? 0.0 },
      uWaveMicroNormalWarp:     { value: p.waveMicroNormalWarp ?? 0.0 },
      uWaveMicroNormalDistortionStrength: { value: p.waveMicroNormalDistortionStrength ?? 0.0 },
      uWaveMicroNormalSpecularStrength:   { value: p.waveMicroNormalSpecularStrength ?? 0.0 },
      uWaveWarpLargeStrength:  { value: p.waveWarpLargeStrength },
      uWaveWarpSmallStrength:  { value: p.waveWarpSmallStrength },
      uWaveWarpMicroStrength:  { value: p.waveWarpMicroStrength },
      uWaveWarpTimeSpeed:      { value: p.waveWarpTimeSpeed },
      uWaveEvolutionEnabled:   { value: p.waveEvolutionEnabled ? 1.0 : 0.0 },
      uWaveEvolutionSpeed:     { value: p.waveEvolutionSpeed },
      uWaveEvolutionAmount:    { value: p.waveEvolutionAmount },
      uWaveEvolutionScale:     { value: p.waveEvolutionScale },
      uWaveIndoorDampingEnabled: { value: p.waveIndoorDampingEnabled ? 1.0 : 0.0 },
      uWaveIndoorDampingStrength: { value: p.waveIndoorDampingStrength ?? 1.0 },
      uWaveIndoorMinFactor: { value: p.waveIndoorMinFactor ?? 0.05 },

      // Chromatic aberration
      uChromaticAberrationEnabled: { value: p.chromaticAberrationEnabled ? 1.0 : 0.0 },
      uChromaticAberrationStrengthPx:  { value: p.chromaticAberrationStrengthPx },
      uChromaticAberrationThreshold: { value: p.chromaticAberrationThreshold ?? 0.20 },
      uChromaticAberrationThresholdSoftness: { value: p.chromaticAberrationThresholdSoftness ?? 0.35 },
      uChromaticAberrationKawaseBlurPx: { value: p.chromaticAberrationKawaseBlurPx ?? 1.75 },
      uChromaticAberrationSampleSpread: { value: p.chromaticAberrationSampleSpread ?? 1.0 },
      uChromaticAberrationEdgeCenter:  { value: p.chromaticAberrationEdgeCenter },
      uChromaticAberrationEdgeFeather: { value: p.chromaticAberrationEdgeFeather },
      uChromaticAberrationEdgeGamma:   { value: p.chromaticAberrationEdgeGamma },
      uChromaticAberrationEdgeMin:     { value: p.chromaticAberrationEdgeMin },
      uChromaticAberrationDeadzone: { value: p.chromaticAberrationDeadzone ?? 0.02 },
      uChromaticAberrationDeadzoneSoftness: { value: p.chromaticAberrationDeadzoneSoftness ?? 0.02 },

      // Distortion edge
      uDistortionEdgeCenter:    { value: p.distortionEdgeCenter },
      uDistortionEdgeFeather:   { value: p.distortionEdgeFeather },
      uDistortionEdgeGamma:     { value: p.distortionEdgeGamma },
      uDistortionShoreRemapLo:  { value: p.distortionShoreRemapLo },
      uDistortionShoreRemapHi:  { value: p.distortionShoreRemapHi },
      uDistortionShorePow:      { value: p.distortionShorePow },
      uDistortionShoreMin:      { value: p.distortionShoreMin },

      // Precipitation distortion
      uRainEnabled:              { value: 0.0 },
      uRainPrecipitation:        { value: p.rainPrecipitation ?? 0.0 },
      uRainDistortionStrengthPx: { value: p.rainDistortionStrengthPx ?? 6.0 },
      uRainDistortionScale:      { value: p.rainDistortionScale ?? 8.0 },
      uRainDistortionSpeed:      { value: p.rainDistortionSpeed ?? 1.2 },
      tOutdoorsMask:             { value: fallbacks.white },
      uHasOutdoorsMask:          { value: 0.0 },
      uOutdoorsMaskFlipY:        { value: 0.0 },
      uRainIndoorDampingEnabled: { value: p.rainIndoorDampingEnabled ? 1.0 : 0.0 },
      uRainIndoorDampingStrength:{ value: p.rainIndoorDampingStrength ?? 1.0 },

      // Wind
      uWindDir:      { value: new THREE.Vector2(1, 0) },
      uPrevWindDir:  { value: new THREE.Vector2(1, 0) },
      uTargetWindDir:{ value: new THREE.Vector2(1, 0) },
      uWindDirBlend: { value: 1.0 },
      uWindSpeed:    { value: 0.0 },
      uWindOffsetUv: { value: new THREE.Vector2(0, 0) },
      uWindTime:     { value: 0.0 },
      uWaveTime:     { value: 0.0 },
      uLockWaveTravelToWind: { value: p.lockWaveTravelToWind ? 1.0 : 0.0 },
      uWaveDirOffsetRad:     { value: 0.0 },
      uWaveAppearanceRotRad: { value: 0.0 },
      uWaveTriBlendAngleRad: { value: Math.abs(Number(p.waveTriBlendAngleDeg ?? 35.0) * (Math.PI / 180)) },
      uWaveTriSideWeight:    { value: Math.max(0.0, Number(p.waveTriSideWeight ?? 0.35)) },

      // Patchwise wave direction field
      uWaveDirFieldEnabled: { value: (p.waveDirFieldEnabled === false) ? 0.0 : 1.0 },
      uWaveDirFieldMaxRad: { value: (Number(p.waveDirFieldMaxDeg ?? 45.0) * (Math.PI / 180)) },
      uWaveDirFieldScale: { value: Number(p.waveDirFieldScale ?? 0.65) },
      uWaveDirFieldSpeed: { value: Number(p.waveDirFieldSpeed ?? 0.35) },

      // Specular (GGX)
      uSpecStrength:        { value: p.specStrength },
      uSpecPower:           { value: p.specPower },
      uSpecModel:           { value: (p.specModel ?? 0) ? 1.0 : 0.0 },
      uSpecClamp:           { value: p.specClamp ?? 0.0 },
      uSpecSunDir:          { value: new THREE.Vector3(0.5, 0.5, 0.707) },
      uSpecSunIntensity:    { value: p.specSunIntensity },
      uSpecNormalStrength:  { value: p.specNormalStrength },
      uSpecNormalScale:     { value: p.specNormalScale },
      uSpecNormalMode:      { value: Number.isFinite(Number(p.specNormalMode)) ? Number(p.specNormalMode) : 0.0 },
      uSpecMicroStrength:   { value: p.specMicroStrength ?? 0.0 },
      uSpecMicroScale:      { value: p.specMicroScale ?? 1.0 },
      uSpecAAStrength:      { value: p.specAAStrength ?? 0.0 },
      uSpecWaveStepMul:     { value: p.specWaveStepMul ?? 1.0 },
      uSpecForceFlatNormal: { value: p.specForceFlatNormal ? 1.0 : 0.0 },
      uSpecDisableMasking:  { value: p.specDisableMasking ? 1.0 : 0.0 },
      uSpecDisableRainSlope:{ value: p.specDisableRainSlope ? 1.0 : 0.0 },
      uSpecRoughnessMin:    { value: p.specRoughnessMin },
      uSpecRoughnessMax:    { value: p.specRoughnessMax },
      uSpecSurfaceChaos:    { value: p.specSurfaceChaos ?? 0.5 },
      uSpecF0:              { value: p.specF0 },
      uSpecMaskGamma:       { value: p.specMaskGamma },
      uSpecSkyTint:         { value: p.specSkyTint },
      uSpecShoreBias:       { value: p.specShoreBias },
      uSpecDistortionNormalStrength: { value: p.specDistortionNormalStrength },
      uSpecAnisotropy:      { value: p.specAnisotropy },
      uSpecAnisoRatio:      { value: p.specAnisoRatio },

      // Specular Highlights (additive sharp highlights)
      uSpecHighlightsEnabled: { value: p.specHighlightsEnabled ? 1.0 : 0.0 },
      uSpecHighlightsStrength: { value: p.specHighlightsStrength },
      uSpecHighlightsPower: { value: p.specHighlightsPower },
      uSpecHighlightsClamp: { value: p.specHighlightsClamp ?? 0.0 },
      uSpecHighlightsSunDir: { value: new THREE.Vector3(0.5, 0.5, 0.707) },
      uSpecHighlightsSunAzimuthDeg: { value: safeNum(p.specHighlightsSunAzimuthDeg, 135.0) },
      uSpecHighlightsSunElevationDeg: { value: safeNum(p.specHighlightsSunElevationDeg, 45.0) },
      uSpecHighlightsSunIntensity: { value: p.specHighlightsSunIntensity },
      uSpecHighlightsNormalStrength: { value: p.specHighlightsNormalStrength },
      uSpecHighlightsNormalScale: { value: p.specHighlightsNormalScale },
      uSpecHighlightsRoughnessMin: { value: p.specHighlightsRoughnessMin },
      uSpecHighlightsRoughnessMax: { value: p.specHighlightsRoughnessMax },
      uSpecHighlightsF0: { value: p.specHighlightsF0 },
      uSpecHighlightsSkyTint: { value: p.specHighlightsSkyTint },
      uSpecHighlightsMaskGamma: { value: p.specHighlightsMaskGamma },
      uSpecHighlightsShoreBias: { value: p.specHighlightsShoreBias },
      uBloomSpecularEmitMul: { value: safeNum(p.bloomSpecularEmit, 1.5) },

      uSpecUseSunAngle:     { value: p.specUseSunAngle ? 1.0 : 0.0 },
      uSpecSunElevationFalloffEnabled: { value: p.specSunElevationFalloffEnabled ? 1.0 : 0.0 },
      uSpecSunElevationFalloffStart: { value: p.specSunElevationFalloffStart ?? 15.0 },
      uSpecSunElevationFalloffEnd: { value: p.specSunElevationFalloffEnd ?? 5.0 },
      uSpecSunElevationFalloffCurve: { value: p.specSunElevationFalloffCurve ?? 2.0 },
      tCloudShadow:         { value: fallbacks.white },
      uHasCloudShadow:      { value: 0.0 },
      uCloudShadowEnabled:  { value: p.cloudShadowEnabled ? 1.0 : 0.0 },
      uCloudShadowDarkenStrength: { value: p.cloudShadowDarkenStrength ?? 1.25 },
      uCloudShadowDarkenCurve: { value: p.cloudShadowDarkenCurve ?? 1.5 },
      uCloudShadowSpecularKill: { value: p.cloudShadowSpecularKill ?? 1.0 },
      uCloudShadowSpecularCurve: { value: p.cloudShadowSpecularCurve ?? 6.0 },
      tBuildingShadow:      { value: fallbacks.white },
      uHasBuildingShadow:   { value: 0.0 },
      tOverheadShadow:      { value: fallbacks.white },
      uHasOverheadShadow:   { value: 0.0 },

      // Cloud Reflection
      uCloudReflectionEnabled:         { value: p.cloudReflectionEnabled ? 1.0 : 0.0 },
      uCloudReflectionStrength:        { value: p.cloudReflectionStrength },
      tCloudTopTexture:                { value: fallbacks.white },
      uHasCloudTopTexture:             { value: 0.0 },

      // Caustics
      uCausticsEnabled:              { value: p.causticsEnabled ? 1.0 : 0.0 },
      uCausticsIntensity:            { value: p.causticsIntensity ?? 4.0 },
      uCausticsScale:                { value: p.causticsScale ?? 33.4 },
      uCausticsSpeed:                { value: p.causticsSpeed ?? 1.05 },
      uCausticsSharpness:            { value: p.causticsSharpness ?? 0.15 },
      uCausticsEdgeLo:               { value: p.causticsEdgeLo ?? 0.11 },
      uCausticsEdgeHi:               { value: p.causticsEdgeHi ?? 1.0 },
      uCausticsBrightnessMaskEnabled:{ value: p.causticsBrightnessMaskEnabled ? 1.0 : 0.0 },
      uCausticsBrightnessThreshold:  { value: Number.isFinite(p.causticsBrightnessThreshold) ? Math.max(0.0, p.causticsBrightnessThreshold) : 0.55 },
      uCausticsBrightnessSoftness:   { value: Number.isFinite(p.causticsBrightnessSoftness) ? Math.max(0.0, p.causticsBrightnessSoftness) : 0.20 },
      uCausticsBrightnessGamma:      { value: Number.isFinite(p.causticsBrightnessGamma) ? Math.max(0.01, p.causticsBrightnessGamma) : 1.0 },

      // Shore Foam (Advanced)
      uShoreFoamEnabled:                  { value: (p.shoreFoamEnabled ?? true) ? 1.0 : 0.0 },
      uShoreFoamStrength:                 { value: p.shoreFoamStrength ?? 0.8 },
      uShoreFoamThreshold:                { value: p.shoreFoamThreshold ?? 0.28 },
      uShoreFoamScale:                    { value: p.shoreFoamScale ?? 20.0 },
      uShoreFoamSpeed:                    { value: p.shoreFoamSpeed ?? 0.1 },
      uShoreFoamColor:                    { value: new THREE.Vector3(shoreFoamColor.r, shoreFoamColor.g, shoreFoamColor.b) },
      uShoreFoamTint:                     { value: new THREE.Vector3(shoreFoamTint.r, shoreFoamTint.g, shoreFoamTint.b) },
      uShoreFoamTintStrength:             { value: p.shoreFoamTintStrength ?? 0.2 },
      uShoreFoamColorVariation:           { value: p.shoreFoamColorVariation ?? 0.15 },
      uShoreFoamOpacity:                  { value: p.shoreFoamOpacity ?? 1.0 },
      uShoreFoamBrightness:               { value: p.shoreFoamBrightness ?? 0.6 },
      uShoreFoamContrast:                 { value: p.shoreFoamContrast ?? 1.5 },
      uShoreFoamGamma:                    { value: p.shoreFoamGamma ?? 0.8 },
      uShoreFoamLightingEnabled:          { value: (p.shoreFoamLightingEnabled ?? true) ? 1.0 : 0.0 },
      uShoreFoamAmbientLight:             { value: p.shoreFoamAmbientLight ?? 0.5 },
      uShoreFoamSceneLightInfluence:      { value: p.shoreFoamSceneLightInfluence ?? 0.8 },
      uShoreFoamDarknessResponse:         { value: p.shoreFoamDarknessResponse ?? 0.7 },
      uShoreFoamFilamentsEnabled:         { value: (p.shoreFoamFilamentsEnabled ?? true) ? 1.0 : 0.0 },
      uShoreFoamFilamentsStrength:        { value: p.shoreFoamFilamentsStrength ?? 0.5 },
      uShoreFoamFilamentsScale:           { value: p.shoreFoamFilamentsScale ?? 5.0 },
      uShoreFoamFilamentsLength:          { value: p.shoreFoamFilamentsLength ?? 2.0 },
      uShoreFoamFilamentsWidth:           { value: p.shoreFoamFilamentsWidth ?? 0.2 },
      uShoreFoamThicknessVariation:       { value: p.shoreFoamThicknessVariation ?? 0.4 },
      uShoreFoamThicknessScale:           { value: p.shoreFoamThicknessScale ?? 4.0 },
      uShoreFoamEdgeDetail:               { value: p.shoreFoamEdgeDetail ?? 0.5 },
      uShoreFoamEdgeDetailScale:          { value: p.shoreFoamEdgeDetailScale ?? 10.0 },
      uShoreFoamWaveDistortionStrength:   { value: p.shoreFoamWaveDistortionStrength ?? 3.0 },
      uShoreFoamNoiseDistortionEnabled:   { value: (p.shoreFoamNoiseDistortionEnabled ?? true) ? 1.0 : 0.0 },
      uShoreFoamNoiseDistortionStrength:  { value: p.shoreFoamNoiseDistortionStrength ?? 1.0 },
      uShoreFoamNoiseDistortionScale:     { value: p.shoreFoamNoiseDistortionScale ?? 2.5 },
      uShoreFoamNoiseDistortionSpeed:     { value: p.shoreFoamNoiseDistortionSpeed ?? 0.4 },
      uShoreFoamEvolutionEnabled:         { value: (p.shoreFoamEvolutionEnabled ?? true) ? 1.0 : 0.0 },
      uShoreFoamEvolutionSpeed:           { value: p.shoreFoamEvolutionSpeed ?? 0.2 },
      uShoreFoamEvolutionAmount:          { value: p.shoreFoamEvolutionAmount ?? 0.5 },
      uShoreFoamEvolutionScale:           { value: p.shoreFoamEvolutionScale ?? 2.0 },
      uShoreFoamCoreWidth:                { value: p.shoreFoamCoreWidth ?? 0.15 },
      uShoreFoamCoreFalloff:              { value: p.shoreFoamCoreFalloff ?? 0.1 },
      uShoreFoamTailWidth:                { value: p.shoreFoamTailWidth ?? 0.6 },
      uShoreFoamTailFalloff:              { value: p.shoreFoamTailFalloff ?? 0.3 },

      // Foam
      uFoamColor:     { value: new THREE.Vector3(foamColor.r, foamColor.g, foamColor.b) },
      uFoamStrength:  { value: p.foamStrength },
      uFoamThreshold: { value: p.foamThreshold },
      uFoamShoreCorePower:    { value: p.foamShoreCorePower ?? 4.5 },
      uFoamShoreCoreStrength: { value: p.foamShoreCoreStrength ?? 1.0 },
      uFoamShoreTailPower:    { value: p.foamShoreTailPower ?? 0.60 },
      uFoamShoreTailStrength: { value: p.foamShoreTailStrength ?? 0.20 },
      uFoamScale:     { value: p.foamScale },
      uFoamSpeed:     { value: p.foamSpeed },
      uFoamCurlStrength:     { value: p.foamCurlStrength },
      uFoamCurlScale:        { value: p.foamCurlScale },
      uFoamCurlSpeed:        { value: p.foamCurlSpeed },
      uFoamBreakupStrength1: { value: p.foamBreakupStrength1 },
      uFoamBreakupScale1:    { value: p.foamBreakupScale1 },
      uFoamBreakupSpeed1:    { value: p.foamBreakupSpeed1 },
      uFoamBreakupStrength2: { value: p.foamBreakupStrength2 },
      uFoamBreakupScale2:    { value: p.foamBreakupScale2 },
      uFoamBreakupSpeed2:    { value: p.foamBreakupSpeed2 },
      uFoamBlackPoint:  { value: p.foamBlackPoint },
      uFoamWhitePoint:  { value: p.foamWhitePoint },
      uFoamGamma:       { value: p.foamGamma },
      uFoamContrast:    { value: p.foamContrast },
      uFoamBrightness:  { value: p.foamBrightness },
      uFloatingFoamStrength:       { value: p.floatingFoamStrength },
      uFloatingFoamCoverage:       { value: p.floatingFoamCoverage },
      uFloatingFoamScale:          { value: p.floatingFoamScale },
      uFloatingFoamWaveDistortion: { value: p.floatingFoamWaveDistortion },
      
      // Floating Foam Advanced (Phase 1)
      uFloatingFoamColor: { value: new THREE.Vector3(
        normalizeRgb01(p.floatingFoamColor, { r: 1.0, g: 1.0, b: 1.0 }).r,
        normalizeRgb01(p.floatingFoamColor, { r: 1.0, g: 1.0, b: 1.0 }).g,
        normalizeRgb01(p.floatingFoamColor, { r: 1.0, g: 1.0, b: 1.0 }).b
      ) },
      uFloatingFoamTint: { value: new THREE.Vector3(
        normalizeRgb01(p.floatingFoamTint, { r: 0.9, g: 0.95, b: 0.85 }).r,
        normalizeRgb01(p.floatingFoamTint, { r: 0.9, g: 0.95, b: 0.85 }).g,
        normalizeRgb01(p.floatingFoamTint, { r: 0.9, g: 0.95, b: 0.85 }).b
      ) },
      uFloatingFoamTintStrength:    { value: p.floatingFoamTintStrength ?? 0.3 },
      uFloatingFoamColorVariation:  { value: p.floatingFoamColorVariation ?? 0.2 },
      uFloatingFoamOpacity:         { value: p.floatingFoamOpacity ?? 1.0 },
      uFloatingFoamBrightness:      { value: p.floatingFoamBrightness ?? 0.5 },
      uFloatingFoamContrast:        { value: p.floatingFoamContrast ?? 1.8 },
      uFloatingFoamGamma:           { value: p.floatingFoamGamma ?? 0.7 },
      
      uFloatingFoamLightingEnabled:     { value: (p.floatingFoamLightingEnabled ?? true) ? 1.0 : 0.0 },
      uFloatingFoamAmbientLight:        { value: p.floatingFoamAmbientLight ?? 0.4 },
      uFloatingFoamSceneLightInfluence: { value: p.floatingFoamSceneLightInfluence ?? 0.7 },
      uFloatingFoamDarknessResponse:    { value: p.floatingFoamDarknessResponse ?? 0.6 },
      
      uFloatingFoamShadowEnabled:  { value: (p.floatingFoamShadowEnabled ?? true) ? 1.0 : 0.0 },
      uFloatingFoamShadowStrength: { value: p.floatingFoamShadowStrength ?? 0.35 },
      uFloatingFoamShadowSoftness: { value: p.floatingFoamShadowSoftness ?? 0.5 },
      uFloatingFoamShadowDepth:    { value: p.floatingFoamShadowDepth ?? 0.8 },
      
      // Floating Foam Complexity (Phase 2)
      uFloatingFoamFilamentsEnabled:   { value: (p.floatingFoamFilamentsEnabled ?? true) ? 1.0 : 0.0 },
      uFloatingFoamFilamentsStrength:  { value: p.floatingFoamFilamentsStrength ?? 0.6 },
      uFloatingFoamFilamentsScale:     { value: p.floatingFoamFilamentsScale ?? 4.0 },
      uFloatingFoamFilamentsLength:    { value: p.floatingFoamFilamentsLength ?? 2.5 },
      uFloatingFoamFilamentsWidth:     { value: p.floatingFoamFilamentsWidth ?? 0.15 },
      uFloatingFoamThicknessVariation: { value: p.floatingFoamThicknessVariation ?? 0.5 },
      uFloatingFoamThicknessScale:     { value: p.floatingFoamThicknessScale ?? 3.0 },
      uFloatingFoamEdgeDetail:         { value: p.floatingFoamEdgeDetail ?? 0.4 },
      uFloatingFoamEdgeDetailScale:    { value: p.floatingFoamEdgeDetailScale ?? 8.0 },
      uFloatingFoamLayerCount:         { value: p.floatingFoamLayerCount ?? 2.0 },
      uFloatingFoamLayerOffset:        { value: p.floatingFoamLayerOffset ?? 0.3 },
      
      // Floating Foam Distortion & Evolution
      uFloatingFoamWaveDistortionStrength:   { value: p.floatingFoamWaveDistortionStrength ?? 2.5 },
      uFloatingFoamNoiseDistortionEnabled:   { value: (p.floatingFoamNoiseDistortionEnabled ?? true) ? 1.0 : 0.0 },
      uFloatingFoamNoiseDistortionStrength:  { value: p.floatingFoamNoiseDistortionStrength ?? 0.8 },
      uFloatingFoamNoiseDistortionScale:     { value: p.floatingFoamNoiseDistortionScale ?? 2.0 },
      uFloatingFoamNoiseDistortionSpeed:     { value: p.floatingFoamNoiseDistortionSpeed ?? 0.3 },
      uFloatingFoamEvolutionEnabled:         { value: (p.floatingFoamEvolutionEnabled ?? true) ? 1.0 : 0.0 },
      uFloatingFoamEvolutionSpeed:           { value: p.floatingFoamEvolutionSpeed ?? 0.15 },
      uFloatingFoamEvolutionAmount:          { value: p.floatingFoamEvolutionAmount ?? 0.6 },
      uFloatingFoamEvolutionScale:           { value: p.floatingFoamEvolutionScale ?? 1.5 },
      
      uFoamFlecksIntensity:        { value: p.foamFlecksIntensity },

      
      // Murk
      uMurkEnabled:       { value: p.murkEnabled ? 1.0 : 0.0 },
      uMurkIntensity:     { value: p.murkIntensity },
      uMurkColor:         { value: new THREE.Vector3(murkColor.r, murkColor.g, murkColor.b) },
      uMurkScale:         { value: p.murkScale },
      uMurkSpeed:         { value: p.murkSpeed },
      uMurkDepthLo:       { value: p.murkDepthLo },
      uMurkDepthHi:       { value: p.murkDepthHi },
      uMurkGrainScale:    { value: p.murkGrainScale },
      uMurkGrainSpeed:    { value: p.murkGrainSpeed },
      uMurkGrainStrength: { value: p.murkGrainStrength },
      uMurkDepthFade:     { value: p.murkDepthFade },

      // Murk Shadow Integration
      tCombinedShadow:     { value: fallbacks?.white ?? null },
      uHasCombinedShadow:  { value: 0.0 },
      uMurkShadowEnabled:  { value: p.murkShadowEnabled ? 1.0 : 0.0 },
      uMurkShadowStrength: { value: p.murkShadowStrength },

      // Faux bathymetry (Beer-Lambert volumetric params)
      uBathymetryEnabled:         { value: p.bathymetryEnabled ? 1.0 : 0.0 },
      uBathymetryDepthCurve:      { value: Number.isFinite(p.bathymetryDepthCurve) ? Math.max(0.05, p.bathymetryDepthCurve) : 2.0 },
      uBathymetryMaxDepth:        { value: Number.isFinite(p.bathymetryMaxDepth) ? Math.max(0.0, p.bathymetryMaxDepth) : 2.0 },
      uBathymetryStrength:        { value: Number.isFinite(p.bathymetryStrength) ? Math.max(0.0, p.bathymetryStrength) : 1.0 },
      uBathymetryAbsorptionCoeff: { value: new THREE.Vector3(bathAbsorb.r, bathAbsorb.g, bathAbsorb.b) },
      uBathymetryDeepScatterColor:{ value: new THREE.Vector3(bathScatter.r, bathScatter.g, bathScatter.b) },

      // Debug
      uDebugView: { value: p.debugView },

      // Global
      uTime:            { value: 0.0 },
      uResolution:      { value: new THREE.Vector2(1, 1) },
      uZoom:            { value: 1.0 },
      uViewBounds:      { value: new THREE.Vector4(0, 0, 1, 1) },
      uSceneDimensions: { value: new THREE.Vector2(1, 1) },
      uSceneRect:       { value: new THREE.Vector4(0, 0, 1, 1) },
      uHasSceneRect:    { value: 0.0 },
      uSkyColor:        { value: new THREE.Vector3(0.5, 0.6, 0.8) },
      uSkyIntensity:    { value: 0.5 },
      uSceneDarkness:   { value: 0.0 },
      uActiveLevelElevation: { value: 0.0 },
      uFloorDepthBlurWaterSoft: { value: 0.0 },
      
      // Water depth shadow
      uWaterDepthShadowEnabled: { value: (p.waterDepthShadowEnabled ?? true) ? 1.0 : 0.0 },
      uWaterDepthShadowStrength: { value: p.waterDepthShadowStrength ?? 0.15 },
      uWaterDepthShadowMinBrightness: { value: p.waterDepthShadowMinBrightness ?? 0.7 },

      // Depth pass (shared module uniforms for depth-aware occlusion)
      ...DepthShaderChunks.createUniforms(),
    };
  }

  /**
   * Create a 1x1 DataTexture.
   * @private
   */
  _make1x1(THREE, r, g, b, a) {
    const data = new Uint8Array([r, g, b, a]);
    const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    tex.needsUpdate = true;
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    return tex;
  }

  /**
   * Resolve the floor index for a tile document.
   *
   * **Must stay aligned with `FloorRenderBus._resolveFloorIndex`** so water mask
   * compositing keys (`_floorWater`) use the same floor band as tile placement.
   * The previous implementation compared ad-hoc `flr.elevation` to the tile's
   * range flags, which mis-bucketed masks when Levels bands changed and made
   * ground water appear to “change” with the active level/floor view.
   *
   * @private
   */
  _resolveFloorIndex(tileDoc, floors) {
    if (!floors || floors.length <= 1) return 0;

    if (tileHasLevelsRange(tileDoc)) {
      const flags = readTileLevelsFlags(tileDoc);
      const tileBottom = Number(flags.rangeBottom);
      const tileTop = Number(flags.rangeTop);
      const tileMid = (tileBottom + tileTop) / 2;

      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        if (tileMid >= f.elevationMin && tileMid < f.elevationMax) return i;
      }
      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        if (tileBottom <= f.elevationMax && f.elevationMin <= tileTop) return i;
      }
    }

    const elev = Number.isFinite(Number(tileDoc?.elevation)) ? Number(tileDoc.elevation) : 0;
    for (let i = 0; i < floors.length; i++) {
      const f = floors[i];
      if (elev >= f.elevationMin && elev <= f.elevationMax) return i;
    }
    return 0;
  }

  /**
   * Generate a 512x512 RGBA noise texture with four independent channels.
   * Deterministic seeded LCG — identical to V1.
   * @param {object} THREE
   * @returns {THREE.DataTexture}
   * @static
   */
  static _createNoiseTexture(THREE) {
    const size = 512;
    const data = new Uint8Array(size * size * 4);
    let sR = 48271, sG = 16807, sB = 75013, sA = 33791;
    for (let i = 0; i < size * size; i++) {
      sR = (sR * 1103515245 + 12345) & 0x7fffffff;
      sG = (sG * 1103515245 + 12345) & 0x7fffffff;
      sB = (sB * 1103515245 + 12345) & 0x7fffffff;
      sA = (sA * 1103515245 + 12345) & 0x7fffffff;
      const idx = i * 4;
      data[idx]     = (sR >> 16) & 0xff;
      data[idx + 1] = (sG >> 16) & 0xff;
      data[idx + 2] = (sB >> 16) & 0xff;
      data[idx + 3] = (sA >> 16) & 0xff;
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }
}
