/**
 * @fileoverview WaterEffectV2 — V2 water post-processing pass.
 *
 * Applies water tint, wave distortion, caustics, specular (GGX), foam, murk,
 * rain ripples, and chromatic aberration to water areas defined by
 * `_Water` mask textures.
 *
 * Architecture:
 *   1. `populate()` discovers per-tile `_Water` masks via `probeMaskFile()`.
 *   2. Per-floor masks are composited into a single RT by rendering white quads
 *      masked by the water texture into a scene-sized render target.
 *   3. `WaterSurfaceModel.buildFromMaskTexture()` builds SDF data from the
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
 * @module compositor-v2/effects/WaterEffectV2
 */

import { createLogger } from '../../core/log.js';
import { weatherController } from '../../core/WeatherController.js';
import { probeMaskFile } from '../../assets/loader.js';
import { tileHasLevelsRange, readTileLevelsFlags } from '../../foundry/levels-scene-flags.js';
import { WaterSurfaceModel } from '../../effects/WaterSurfaceModel.js';
import { DepthShaderChunks } from '../../effects/DepthShaderChunks.js';
import { VisionSDF } from '../../vision/VisionSDF.js';
import { getVertexShader, getFragmentShader, getFragmentShaderSafe } from './water-shader.js';

const log = createLogger('WaterEffectV2');

const WATER_MASK_FORMATS = ['webp', 'png', 'jpg', 'jpeg'];

// Bitmask flags for conditional shader defines.
const DEF_FOAM_FLECKS = 1 << 0;
const DEF_MULTITAP    = 1 << 1;

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

    /** @type {string} */
    this._instanceId = `we2_${Math.random().toString(16).slice(2, 8)}`;

    // Cache for direct mask probing so we don't repeatedly 404-spam hosted setups.
    // Key: basePathWithSuffix + formats. Value: { url, image } or null when missing.
    this._directMaskCache = new Map();

    // ── Effect parameters ────────────────────────────────────────────────
    this.params = {
      // Tint
      tintColor: { r: 0.02, g: 0.18, b: 0.28 },
      tintStrength: 0.36,

      // Waves
      waveScale: 16.0,
      waveSpeed: 0.56,
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
      // Wind always drives wave speed/strength — min factors set the calm-water baseline
      waveSpeedWindMinFactor: 0.27,
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
      specStrength: 200.0,
      specPower: 64.0,
      specModel: 1,
      specClamp: 1.0,
      specSunAzimuthDeg: 135.0,
      specSunElevationDeg: 45.0,
      specSunIntensity: 8.0,
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
      specF0: 0.249,
      specMaskGamma: 0.52,
      specSkyTint: 1.0,
      skyIntensity: 1.0,
      specShoreBias: -1.0,
      specDistortionNormalStrength: 1.32,
      specAnisotropy: -0.31,
      specAnisoRatio: 2.0,

      // Sun angle specular suppression
      specUseSunAngle: true,
      specSunElevationFalloffEnabled: true,
      specSunElevationFalloffStart: 15.0,
      specSunElevationFalloffEnd: 5.0,
      specSunElevationFalloffCurve: 2.0,

      // Cloud shadow modulation
      cloudShadowEnabled: true,
      cloudShadowDarkenStrength: 1.13,
      cloudShadowDarkenCurve: 8.0,
      cloudShadowSpecularKill: 3.0,
      cloudShadowSpecularCurve: 12.0,

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
      murkSpeed: 0.12,
      murkDepthLo: 0.2,
      murkDepthHi: 0.8,
      murkGrainScale: 80.0,
      murkGrainSpeed: 0.3,
      murkGrainStrength: 0.4,
      murkDepthFade: 0.0,

      // Faux bathymetry (Beer-Lambert volumetric absorption/scatter)
      bathymetryEnabled: true,
      bathymetryDepthCurve: 1.53,
      bathymetryMaxDepth: 3.3,
      bathymetryStrength: 1.01,
      bathymetryAbsorptionCoeff: { r: 4.0, g: 1.5, b: 0.1 },
      bathymetryDeepScatterColor: { r: 0.02, g: 0.10, b: 0.20 },

      // SDF build (1024 is sufficient for water masks; 2048 causes multi-second
      // CPU hangs during SDF generation — 4 million pixels to distance-transform)
      buildResolution: 1024,
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
    };

    // ── Per-floor water state ────────────────────────────────────────────
    // Keyed by floorIndex → { maskRT, waterData, rawMask }
    /** @type {Map<number, object>} */
    this._floorWater = new Map();

    /** @type {number} */
    this._activeFloorIndex = 0;

    // ── Discovered water tiles (populated in populate()) ─────────────────
    /** @type {Array<{tileId: string, basePath: string, floorIndex: number, maskPath: string}>} */
    this._waterTiles = [];

    // ── Surface model ────────────────────────────────────────────────────
    /** @type {WaterSurfaceModel} */
    this._surfaceModel = new WaterSurfaceModel();

    /** @type {VisionSDF|null} */
    this._visionSDF = null;

    /** @type {THREE.Scene|null} */
    this._waterDataPackScene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._waterDataPackCamera = null;
    /** @type {THREE.Mesh|null} */
    this._waterDataPackQuad = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._waterDataPackMaterial = null;

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
          name: 'water-waves',
          label: 'Waves',
          type: 'folder',
          expanded: false,
          parameters: [
            'waveScale', 'waveSpeed', 'waveStrength',
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
            'waveSpeedWindMinFactor', 'waveStrengthWindMinFactor',
            'waveIndoorDampingEnabled', 'waveIndoorDampingStrength', 'waveIndoorMinFactor',
            'windDirResponsiveness',
            'lockWaveTravelToWind', 'waveDirOffsetDeg', 'waveAppearanceRotDeg',
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
            'specRoughnessMin', 'specRoughnessMax', 'specF0', 'specMaskGamma',
            'specSkyTint', 'skyIntensity', 'specShoreBias',
            'specDistortionNormalStrength', 'specAnisotropy', 'specAnisoRatio'
          ]
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
            'murkGrainScale', 'murkGrainSpeed', 'murkGrainStrength'
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
            Foam: 6,
            Murk: 7,
          }
        },
        debugWindArrow: { type: 'boolean', default: false, label: 'Debug Wind Arrow' },

        waveScale: { type: 'slider', min: 0.1, max: 16, step: 0.05, default: 4.0, label: 'Wave Scale' },
        waveSpeed: { type: 'slider', min: 0, max: 4, step: 0.01, default: 1.0, label: 'Wave Speed' },
        waveStrength: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.6, label: 'Wave Strength' },
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

        waveSpeedWindMinFactor: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.2, label: 'Speed Calm Baseline' },
        waveStrengthWindMinFactor: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.55, label: 'Strength Calm Baseline' },
        waveIndoorDampingEnabled: { type: 'boolean', default: false, label: 'Indoor Damping Enabled' },
        waveIndoorDampingStrength: { type: 'slider', min: 0, max: 2, step: 0.01, default: 1.0, label: 'Indoor Damping Strength' },
        waveIndoorMinFactor: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.05, label: 'Indoor Min Factor' },
        windDirResponsiveness: { type: 'slider', min: 0.05, max: 30, step: 0.05, default: 10.0, label: 'Wind Responsiveness' },
        lockWaveTravelToWind: { type: 'boolean', default: true, label: 'Lock Travel To Wind' },
        waveDirOffsetDeg: { type: 'slider', min: -180, max: 180, step: 1, default: 0.0, label: 'Wave Dir Offset (deg)' },
        waveAppearanceRotDeg: { type: 'slider', min: -180, max: 180, step: 1, default: 0.0, label: 'Wave Appearance Rot (deg)' },
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
        specF0: { type: 'slider', min: 0, max: 1, step: 0.001, default: 0.04, label: 'F0' },
        specMaskGamma: { type: 'slider', min: 0.1, max: 4, step: 0.01, default: 0.5, label: 'Mask Gamma' },
        specSkyTint: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.3, label: 'Sky Tint' },
        skyIntensity: { type: 'slider', min: 0, max: 1, step: 0.01, default: 1.0, label: 'Sky Intensity' },
        specShoreBias: { type: 'slider', min: -1, max: 1, step: 0.01, default: 0.3, label: 'Shore Bias' },
        specDistortionNormalStrength: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.5, label: 'Distortion Normal Strength' },
        specAnisotropy: { type: 'slider', min: -1, max: 1, step: 0.01, default: 0.0, label: 'Anisotropy' },
        specAnisoRatio: { type: 'slider', min: 0.1, max: 8, step: 0.01, default: 2.0, label: 'Aniso Ratio' },

        specUseSunAngle: { type: 'boolean', default: true, label: 'Use Sun Angle' },
        specSunElevationFalloffEnabled: { type: 'boolean', default: true, label: 'Sun Elevation Falloff' },
        specSunElevationFalloffStart: { type: 'slider', min: 0, max: 90, step: 0.5, default: 15.0, label: 'Falloff Start (deg)' },
        specSunElevationFalloffEnd: { type: 'slider', min: 0, max: 90, step: 0.5, default: 5.0, label: 'Falloff End (deg)' },
        specSunElevationFalloffCurve: { type: 'slider', min: 0.1, max: 8, step: 0.1, default: 2.0, label: 'Falloff Curve' },

        cloudShadowEnabled: { type: 'boolean', default: true, label: 'Cloud Shadow Enabled' },
        cloudShadowDarkenStrength: { type: 'slider', min: 0, max: 3, step: 0.01, default: 1.25, label: 'Darken Strength' },
        cloudShadowDarkenCurve: { type: 'slider', min: 0.1, max: 8, step: 0.01, default: 1.5, label: 'Darken Curve' },
        cloudShadowSpecularKill: { type: 'slider', min: 0, max: 3, step: 0.01, default: 1.0, label: 'Specular Kill' },
        cloudShadowSpecularCurve: { type: 'slider', min: 0.1, max: 12, step: 0.01, default: 6.0, label: 'Specular Curve' },

        causticsEnabled: { type: 'boolean', default: true, label: 'Caustics Enabled' },
        causticsBrightnessMaskEnabled: { type: 'boolean', default: true, label: 'Brightness Mask Enabled' },
        causticsIntensity: { type: 'slider', min: 0, max: 20, step: 0.01, default: 4.0, label: 'Caustics Intensity' },
        causticsScale: { type: 'slider', min: 0.1, max: 120, step: 0.1, default: 33.4, label: 'Caustics Scale' },
        causticsSpeed: { type: 'slider', min: 0, max: 4, step: 0.01, default: 1.05, label: 'Caustics Speed' },
        causticsSharpness: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.15, label: 'Caustics Sharpness' },
        causticsEdgeLo: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.0, label: 'Caustics Edge Low' },
        causticsEdgeHi: { type: 'slider', min: 0, max: 1, step: 0.01, default: 1.0, label: 'Caustics Edge High' },
        causticsBrightnessThreshold: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.55, label: 'Brightness Threshold' },
        causticsBrightnessSoftness: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.20, label: 'Brightness Softness' },
        causticsBrightnessGamma: { type: 'slider', min: 0.01, max: 4, step: 0.01, default: 1.0, label: 'Brightness Gamma' },

        // Shore Foam (Advanced)
        shoreFoamEnabled: { type: 'boolean', default: true, label: 'Shore Foam Enabled' },
        shoreFoamStrength: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.8, label: 'Strength' },
        shoreFoamThreshold: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.28, label: 'Threshold' },
        shoreFoamScale: { type: 'slider', min: 0.1, max: 80, step: 0.1, default: 20.0, label: 'Scale' },
        shoreFoamSpeed: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.1, label: 'Speed' },
        shoreFoamColor: { type: 'color', default: { r: 1.0, g: 1.0, b: 1.0 }, label: 'Color' },
        shoreFoamTint: { type: 'color', default: { r: 0.95, g: 0.97, b: 0.9 }, label: 'Tint' },
        shoreFoamTintStrength: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.2, label: 'Tint Strength' },
        shoreFoamColorVariation: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.15, label: 'Color Variation' },
        shoreFoamOpacity: { type: 'slider', min: 0, max: 1, step: 0.01, default: 1.0, label: 'Opacity' },
        shoreFoamBrightness: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.6, label: 'Brightness' },
        shoreFoamContrast: { type: 'slider', min: 0, max: 4, step: 0.01, default: 1.5, label: 'Contrast' },
        shoreFoamGamma: { type: 'slider', min: 0.1, max: 4, step: 0.01, default: 0.8, label: 'Gamma' },
        shoreFoamLightingEnabled: { type: 'boolean', default: true, label: 'Enable Lighting' },
        shoreFoamAmbientLight: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.5, label: 'Ambient Light' },
        shoreFoamSceneLightInfluence: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.8, label: 'Scene Light Influence' },
        shoreFoamDarknessResponse: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.7, label: 'Darkness Response' },
        shoreFoamFilamentsEnabled: { type: 'boolean', default: true, label: 'Enable Filaments' },
        shoreFoamFilamentsStrength: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.5, label: 'Filaments Strength' },
        shoreFoamFilamentsScale: { type: 'slider', min: 0.1, max: 20, step: 0.1, default: 5.0, label: 'Filaments Scale' },
        shoreFoamFilamentsLength: { type: 'slider', min: 0.1, max: 8, step: 0.1, default: 2.0, label: 'Filaments Length' },
        shoreFoamFilamentsWidth: { type: 'slider', min: 0.01, max: 1, step: 0.01, default: 0.2, label: 'Filaments Width' },
        shoreFoamThicknessVariation: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.4, label: 'Thickness Variation' },
        shoreFoamThicknessScale: { type: 'slider', min: 0.1, max: 20, step: 0.1, default: 4.0, label: 'Thickness Scale' },
        shoreFoamEdgeDetail: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.5, label: 'Edge Detail' },
        shoreFoamEdgeDetailScale: { type: 'slider', min: 0.1, max: 40, step: 0.1, default: 10.0, label: 'Edge Detail Scale' },
        shoreFoamWaveDistortionStrength: { type: 'slider', min: 0, max: 10, step: 0.1, default: 3.0, label: 'Wave Distortion Strength' },
        shoreFoamNoiseDistortionEnabled: { type: 'boolean', default: true, label: 'Enable Noise Distortion' },
        shoreFoamNoiseDistortionStrength: { type: 'slider', min: 0, max: 3, step: 0.01, default: 1.0, label: 'Noise Distortion Strength' },
        shoreFoamNoiseDistortionScale: { type: 'slider', min: 0.1, max: 10, step: 0.1, default: 2.5, label: 'Noise Distortion Scale' },
        shoreFoamNoiseDistortionSpeed: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.4, label: 'Noise Distortion Speed' },
        shoreFoamEvolutionEnabled: { type: 'boolean', default: true, label: 'Enable Evolution' },
        shoreFoamEvolutionSpeed: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.2, label: 'Evolution Speed' },
        shoreFoamEvolutionAmount: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.5, label: 'Evolution Amount' },
        shoreFoamEvolutionScale: { type: 'slider', min: 0.1, max: 10, step: 0.1, default: 2.0, label: 'Evolution Scale' },
        shoreFoamCoreWidth: { type: 'slider', min: 0.01, max: 1, step: 0.01, default: 0.15, label: 'Core Width' },
        shoreFoamCoreFalloff: { type: 'slider', min: 0.01, max: 1, step: 0.01, default: 0.1, label: 'Core Falloff' },
        shoreFoamTailWidth: { type: 'slider', min: 0.01, max: 1, step: 0.01, default: 0.6, label: 'Tail Width' },
        shoreFoamTailFalloff: { type: 'slider', min: 0.01, max: 1, step: 0.01, default: 0.3, label: 'Tail Falloff' },

        foamFlecksEnabled: { type: 'boolean', default: true, label: 'Foam Flecks Enabled' },
        foamColor: { type: 'color', default: { r: 0.85, g: 0.90, b: 0.88 }, label: 'Foam Color' },
        foamStrength: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.60, label: 'Foam Strength' },
        foamThreshold: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.28, label: 'Foam Threshold' },
        foamShoreCorePower: { type: 'slider', min: 1, max: 12, step: 0.01, default: 4.5, label: 'Shore Core Power' },
        foamShoreCoreStrength: { type: 'slider', min: 0, max: 3, step: 0.01, default: 1.0, label: 'Shore Core Strength' },
        foamShoreTailPower: { type: 'slider', min: 0.1, max: 2, step: 0.01, default: 0.60, label: 'Shore Tail Power' },
        foamShoreTailStrength: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.20, label: 'Shore Tail Strength' },
        foamScale: { type: 'slider', min: 0.1, max: 80, step: 0.1, default: 20.0, label: 'Foam Scale' },
        foamSpeed: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.1, label: 'Foam Speed' },
        foamCurlStrength: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.35, label: 'Foam Curl Strength' },
        foamCurlScale: { type: 'slider', min: 0.1, max: 12, step: 0.01, default: 2.0, label: 'Foam Curl Scale' },
        foamCurlSpeed: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.05, label: 'Foam Curl Speed' },
        foamBreakupStrength1: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.5, label: 'Breakup 1 Strength' },
        foamBreakupScale1: { type: 'slider', min: 0.1, max: 20, step: 0.01, default: 3.0, label: 'Breakup 1 Scale' },
        foamBreakupSpeed1: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.04, label: 'Breakup 1 Speed' },
        foamBreakupStrength2: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.3, label: 'Breakup 2 Strength' },
        foamBreakupScale2: { type: 'slider', min: 0.1, max: 20, step: 0.01, default: 7.0, label: 'Breakup 2 Scale' },
        foamBreakupSpeed2: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.02, label: 'Breakup 2 Speed' },
        foamBlackPoint: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.0, label: 'Foam Black Point' },
        foamWhitePoint: { type: 'slider', min: 0, max: 1, step: 0.01, default: 1.0, label: 'Foam White Point' },
        foamGamma: { type: 'slider', min: 0.1, max: 4, step: 0.01, default: 1.0, label: 'Foam Gamma' },
        foamContrast: { type: 'slider', min: 0, max: 4, step: 0.01, default: 1.0, label: 'Foam Contrast' },
        foamBrightness: { type: 'slider', min: -1, max: 1, step: 0.01, default: 0.0, label: 'Foam Brightness' },
        floatingFoamStrength: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.40, label: 'Floating Foam Strength' },
        floatingFoamCoverage: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.35, label: 'Floating Foam Coverage' },
        floatingFoamScale: { type: 'slider', min: 0.1, max: 200, step: 0.1, default: 8.0, label: 'Floating Foam Scale' },
        floatingFoamWaveDistortion: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.5, label: 'Floating Foam Distortion' },
        
        // Floating Foam Advanced (Phase 1)
        floatingFoamColor: { type: 'color', default: { r: 1.0, g: 1.0, b: 1.0 }, label: 'Base Color' },
        floatingFoamTint: { type: 'color', default: { r: 0.9, g: 0.95, b: 0.85 }, label: 'Tint Color' },
        floatingFoamTintStrength: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.3, label: 'Tint Strength' },
        floatingFoamColorVariation: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.2, label: 'Color Variation' },
        floatingFoamOpacity: { type: 'slider', min: 0, max: 1, step: 0.01, default: 1.0, label: 'Opacity' },
        floatingFoamBrightness: { type: 'slider', min: -1, max: 1, step: 0.01, default: 0.5, label: 'Brightness' },
        floatingFoamContrast: { type: 'slider', min: 0, max: 4, step: 0.01, default: 1.8, label: 'Contrast' },
        floatingFoamGamma: { type: 'slider', min: 0.1, max: 4, step: 0.01, default: 0.7, label: 'Gamma' },
        
        floatingFoamLightingEnabled: { type: 'boolean', default: true, label: 'Enable Lighting' },
        floatingFoamAmbientLight: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.4, label: 'Ambient Light' },
        floatingFoamSceneLightInfluence: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.7, label: 'Scene Light Influence' },
        floatingFoamDarknessResponse: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.6, label: 'Darkness Response' },
        
        floatingFoamShadowEnabled: { type: 'boolean', default: true, label: 'Enable Shadow' },
        floatingFoamShadowStrength: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.35, label: 'Shadow Strength' },
        floatingFoamShadowSoftness: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.5, label: 'Shadow Softness' },
        floatingFoamShadowDepth: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.8, label: 'Shadow Depth' },
        
        // Floating Foam Complexity (Phase 2)
        floatingFoamFilamentsEnabled: { type: 'boolean', default: true, label: 'Enable Filaments' },
        floatingFoamFilamentsStrength: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.6, label: 'Filaments Strength' },
        floatingFoamFilamentsScale: { type: 'slider', min: 0.1, max: 20, step: 0.1, default: 4.0, label: 'Filaments Scale' },
        floatingFoamFilamentsLength: { type: 'slider', min: 0.1, max: 8, step: 0.1, default: 2.5, label: 'Filaments Length' },
        floatingFoamFilamentsWidth: { type: 'slider', min: 0.01, max: 1, step: 0.01, default: 0.15, label: 'Filaments Width' },
        floatingFoamThicknessVariation: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.5, label: 'Thickness Variation' },
        floatingFoamThicknessScale: { type: 'slider', min: 0.1, max: 20, step: 0.1, default: 3.0, label: 'Thickness Scale' },
        floatingFoamEdgeDetail: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.4, label: 'Edge Detail' },
        floatingFoamEdgeDetailScale: { type: 'slider', min: 0.1, max: 40, step: 0.1, default: 8.0, label: 'Edge Detail Scale' },
        floatingFoamLayerCount: { type: 'slider', min: 1, max: 4, step: 1, default: 2, label: 'Layer Count' },
        floatingFoamLayerOffset: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.3, label: 'Layer Offset' },
        
        // Floating Foam Distortion & Evolution
        floatingFoamWaveDistortionStrength: { type: 'slider', min: 0, max: 10, step: 0.1, default: 2.5, label: 'Wave Distortion Strength' },
        floatingFoamNoiseDistortionEnabled: { type: 'boolean', default: true, label: 'Enable Noise Distortion' },
        floatingFoamNoiseDistortionStrength: { type: 'slider', min: 0, max: 3, step: 0.01, default: 0.8, label: 'Noise Distortion Strength' },
        floatingFoamNoiseDistortionScale: { type: 'slider', min: 0.1, max: 10, step: 0.1, default: 2.0, label: 'Noise Distortion Scale' },
        floatingFoamNoiseDistortionSpeed: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.3, label: 'Noise Distortion Speed' },
        floatingFoamEvolutionEnabled: { type: 'boolean', default: true, label: 'Enable Evolution' },
        floatingFoamEvolutionSpeed: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.15, label: 'Evolution Speed' },
        floatingFoamEvolutionAmount: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.6, label: 'Evolution Amount' },
        floatingFoamEvolutionScale: { type: 'slider', min: 0.1, max: 10, step: 0.1, default: 1.5, label: 'Evolution Scale' },
        
        foamFlecksIntensity: { type: 'slider', min: 0, max: 4, step: 0.01, default: 1.25, label: 'Foam Flecks Intensity' },

        murkEnabled: { type: 'boolean', default: true, label: 'Murk Enabled' },
        murkIntensity: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.4, label: 'Murk Intensity' },
        murkColor: { type: 'color', default: { r: 0.15, g: 0.22, b: 0.12 }, label: 'Murk Color' },
        murkScale: { type: 'slider', min: 0.1, max: 8, step: 0.01, default: 1.2, label: 'Murk Scale' },
        murkSpeed: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.05, label: 'Murk Speed' },
        murkDepthLo: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.2, label: 'Murk Depth Low' },
        murkDepthHi: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.8, label: 'Murk Depth High' },
        murkDepthFade: { type: 'slider', min: 0, max: 4, step: 0.01, default: 1.5, label: 'Murk Depth Fade' },
        murkGrainScale: { type: 'slider', min: 10, max: 6000, step: 1, default: 80.0, label: 'Murk Grain Scale' },
        murkGrainSpeed: { type: 'slider', min: 0, max: 4, step: 0.01, default: 0.3, label: 'Murk Grain Speed' },
        murkGrainStrength: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.4, label: 'Murk Grain Strength' },

        bathymetryEnabled: { type: 'boolean', default: true, label: 'Enabled' },
        bathymetryDepthCurve: { type: 'slider', min: 0.05, max: 6, step: 0.01, default: 2.0, label: 'Depth Curve' },
        bathymetryMaxDepth: { type: 'slider', min: 0, max: 8, step: 0.01, default: 2.0, label: 'Max Depth' },
        bathymetryStrength: { type: 'slider', min: 0, max: 3, step: 0.01, default: 1.0, label: 'Strength' },
        bathymetryAbsorptionCoeff: { type: 'color', default: { r: 4.0, g: 1.5, b: 0.1 }, label: 'Absorption Coeff' },
        bathymetryDeepScatterColor: { type: 'color', default: { r: 0.02, g: 0.10, b: 0.20 }, label: 'Deep Scatter Color' },

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
    const fragSrc = this._getSafeWaterShader();

    // Create shader material with all uniforms
    const _matStartMs = performance?.now?.() ?? Date.now();
    this._composeMaterial = new THREE.ShaderMaterial({
      uniforms: this._buildUniforms(THREE),
      vertexShader: getVertexShader(),
      fragmentShader: fragSrc,
      defines,
      depthTest: false,
      depthWrite: false,
      transparent: false,
    });
    const _matEndMs = performance?.now?.() ?? Date.now();
    try {
      log.warn(`[crisis] WaterEffectV2 ShaderMaterial created in ${(_matEndMs - _matStartMs).toFixed?.(1) ?? (_matEndMs - _matStartMs)}ms`);
    } catch (_) {}
    this._composeMaterial.toneMapped = false;

    // Fullscreen quad
    this._composeScene = new THREE.Scene();
    this._composeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._composeQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this._composeMaterial
    );
    this._composeQuad.frustumCulled = false;
    this._composeScene.add(this._composeQuad);

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

    const tileDocs = canvas?.scene?.tiles?.contents ?? [];

    const floors = window.MapShine?.floorStack?.getFloors() ?? [];
    const worldH = foundrySceneData?.height ?? canvas?.dimensions?.height ?? 0;

    // Scene rect in Foundry coords (top-left origin, Y-down)
    const sceneRect = canvas?.dimensions?.sceneRect ?? canvas?.dimensions;
    const sceneX = sceneRect?.x ?? 0;
    const sceneY = sceneRect?.y ?? 0;
    const sceneW = sceneRect?.width ?? sceneRect?.sceneWidth ?? 1;
    const sceneH = sceneRect?.height ?? sceneRect?.sceneHeight ?? 1;

    // ── Step 0: Discover background _Water mask (if present) ─────────────
    const bgSrc = canvas?.scene?.background?.src;
    if (bgSrc) {
      const dotIdx = bgSrc.lastIndexOf('.');
      const bgBasePath = dotIdx > 0 ? bgSrc.substring(0, dotIdx) : bgSrc;

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
          floorIndex: 0,
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

    // ── Step 4: Activate the current floor's water data ──────────────────
    const activeFloor = window.MapShine?.floorStack?.getActiveFloor();
    this._activeFloorIndex = activeFloor?.index ?? 0;
    this._applyFloorWaterData(this._activeFloorIndex);

    log.info(`WaterEffectV2 populated: ${this._waterTiles.length} tile(s), ${this._floorWater.size} floor(s)`);
  }

  /**
   * Composite all water mask images for one floor into a single scene-UV canvas,
   * then build SDF via WaterSurfaceModel.
   *
   * Uses canvas 2D compositing instead of WebGL render targets so that
   * WaterSurfaceModel.buildFromMaskTexture() receives a texture backed by a
   * real HTMLImageElement/canvas (CPU path) rather than an RT texture (which
   * would require the broken GPU readback path).
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
    const maxRes = this.params.buildResolution || 1024;
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
      // Fallback: legacy CPU WaterSurfaceModel build.
      const canvasTex = new THREE.CanvasTexture(canvas);
      canvasTex.flipY = false;
      canvasTex.needsUpdate = true;
      try {
        waterData = this._surfaceModel.buildFromMaskTexture(canvasTex, {
          resolution: maxRes,
          threshold: this.params.maskThreshold ?? 0.15,
          channel: this.params.maskChannel ?? 'auto',
          invert: !!this.params.maskInvert,
          blurRadius: this.params.maskBlurRadius ?? 0.0,
          blurPasses: this.params.maskBlurPasses ?? 0,
          expandPx: this.params.maskExpandPx ?? 0.0,
          sdfRangePx: this.params.sdfRangePx ?? 64,
          exposureWidthPx: this.params.shoreWidthPx ?? 24,
        });
      } catch (err) {
        log.error('_compositeFloorMask: CPU SDF build failed:', err);
        canvasTex.dispose();
        return null;
      }
      canvasTex.dispose();
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

    // TimeManager already clamps delta to 100ms; apply an additional 1/20s clamp here
    // to guard against large post-stall jumps in advection/wind integration.
    const baseDt = Math.min(Math.max(0.0, Number(timeInfo?.delta) || 0.0), 1.0 / 20.0);
    const dt = paused ? 0.0 : baseDt;

    // Runtime signature: log once on first update with key Wind & Flow params.
    try {
      if (!this._debugSignatureUpdateLogged) {
        this._debugSignatureUpdateLogged = true;
        log.warn('MSA_SIGNATURE: WaterEffectV2.update live', {
          waveSpeedWindMinFactor: p.waveSpeedWindMinFactor,
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

      if (u.uPrevWindDir) u.uPrevWindDir.value.set(this._prevWindDirX, this._prevWindDirY);
      if (u.uTargetWindDir) u.uTargetWindDir.value.set(this._targetWindDirX, this._targetWindDirY);
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
    // Wind always drives wave speed/strength. Min factors set the calm-water baseline.
    const speedMin = Math.max(0.0, p.waveSpeedWindMinFactor ?? 0.2);
    const strengthMin = Math.max(0.0, p.waveStrengthWindMinFactor ?? 0.55);
    const waveSpeed = (speedMin + (1.0 - speedMin) * this._waveWindMotion01) * (p.waveSpeed ?? 1.0);
    const waveStrength = (strengthMin + (1.0 - strengthMin) * this._waveWindMotion01) * (p.waveStrength ?? 0.6);

    // Wind time: monotonic integration driven by the smoothed wave wind (never reverses).
    this._windTime += dt * (0.1 + this._waveWindMotion01 * 0.9);
    this._waveTime += dt * waveSpeed;
    u.uWindTime.value = this._windTime;
    if (u.uWaveTime) u.uWaveTime.value = this._waveTime;

    // Water uses Foundry/scene UV space (Y-down), matching CloudEffectV2.
    // The water shader assumes uWindDir points toward the direction of travel
    // ("blowing toward"). Do not flip Y here.
    const waterWindDirX = windDirX;
    const waterWindDirY = windDirY;
    u.uWindDir.value.set(waterWindDirX, waterWindDirY);
    u.uWindSpeed.value = this._waveWindMotion01;

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
      const pxPerSec = (220.0 * this._waveWindMotion01) * advMul;

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

    // ── Tint ──────────────────────────────────────────────────────────────
    const tint = normalizeRgb01(p.tintColor, { r: 0.02, g: 0.18, b: 0.28 });
    u.uTintColor.value.set(tint.r, tint.g, tint.b);
    u.uTintStrength.value = p.tintStrength;

    // ── Waves ─────────────────────────────────────────────────────────────
    u.uWaveScale.value = p.waveScale;
    u.uWaveSpeed.value = waveSpeed;
    u.uWaveStrength.value = waveStrength;
    if (u.uWaveMotion01) u.uWaveMotion01.value = this._waveWindMotion01;
    u.uDistortionStrengthPx.value = p.distortionStrengthPx;

    // Wave breakup noise (new). If unset, fall back to legacy waveMicroNormal* params.
    const breakupStrength = (p.waveBreakupStrength ?? p.waveMicroNormalStrength) ?? 0.0;
    const breakupScale = (p.waveBreakupScale ?? p.waveMicroNormalScale) ?? 1.0;
    const breakupSpeed = (p.waveBreakupSpeed ?? p.waveMicroNormalSpeed) ?? 0.0;
    const breakupWarp = (p.waveBreakupWarp ?? p.waveMicroNormalWarp) ?? 0.0;
    const breakupDist = (p.waveBreakupDistortionStrength ?? p.waveMicroNormalDistortionStrength) ?? 0.0;
    const breakupSpec = (p.waveBreakupSpecularStrength ?? p.waveMicroNormalSpecularStrength) ?? 0.0;
    if (u.uWaveBreakupStrength) u.uWaveBreakupStrength.value = breakupStrength;
    if (u.uWaveBreakupScale) u.uWaveBreakupScale.value = breakupScale;
    if (u.uWaveBreakupSpeed) u.uWaveBreakupSpeed.value = breakupSpeed;
    if (u.uWaveBreakupWarp) u.uWaveBreakupWarp.value = breakupWarp;
    if (u.uWaveBreakupDistortionStrength) u.uWaveBreakupDistortionStrength.value = breakupDist;
    if (u.uWaveBreakupSpecularStrength) u.uWaveBreakupSpecularStrength.value = breakupSpec;

    if (u.uWaveMicroNormalStrength) u.uWaveMicroNormalStrength.value = p.waveMicroNormalStrength ?? 0.0;
    if (u.uWaveMicroNormalScale) u.uWaveMicroNormalScale.value = p.waveMicroNormalScale ?? 1.0;
    if (u.uWaveMicroNormalSpeed) u.uWaveMicroNormalSpeed.value = p.waveMicroNormalSpeed ?? 0.0;
    if (u.uWaveMicroNormalWarp) u.uWaveMicroNormalWarp.value = p.waveMicroNormalWarp ?? 0.0;
    if (u.uWaveMicroNormalDistortionStrength) u.uWaveMicroNormalDistortionStrength.value = p.waveMicroNormalDistortionStrength ?? 0.0;
    if (u.uWaveMicroNormalSpecularStrength) u.uWaveMicroNormalSpecularStrength.value = p.waveMicroNormalSpecularStrength ?? 0.0;

    u.uWaveWarpLargeStrength.value = p.waveWarpLargeStrength;
    u.uWaveWarpSmallStrength.value = p.waveWarpSmallStrength;
    u.uWaveWarpMicroStrength.value = p.waveWarpMicroStrength;
    u.uWaveWarpTimeSpeed.value = p.waveWarpTimeSpeed;
    u.uWaveEvolutionEnabled.value = p.waveEvolutionEnabled ? 1.0 : 0.0;
    u.uWaveEvolutionSpeed.value = p.waveEvolutionSpeed;
    u.uWaveEvolutionAmount.value = p.waveEvolutionAmount;
    u.uWaveEvolutionScale.value = p.waveEvolutionScale;
    u.uWaveIndoorDampingEnabled.value = p.waveIndoorDampingEnabled ? 1.0 : 0.0;
    u.uWaveIndoorDampingStrength.value = p.waveIndoorDampingStrength ?? 1.0;
    u.uWaveIndoorMinFactor.value = p.waveIndoorMinFactor ?? 0.05;

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
    u.uDistortionEdgeCenter.value = p.distortionEdgeCenter;
    u.uDistortionEdgeFeather.value = p.distortionEdgeFeather;
    u.uDistortionEdgeGamma.value = p.distortionEdgeGamma;
    u.uDistortionShoreRemapLo.value = p.distortionShoreRemapLo;
    u.uDistortionShoreRemapHi.value = p.distortionShoreRemapHi;
    u.uDistortionShorePow.value = p.distortionShorePow;
    u.uDistortionShoreMin.value = p.distortionShoreMin;

    // ── Chromatic aberration ──────────────────────────────────────────────
    u.uChromaticAberrationEnabled.value = p.chromaticAberrationEnabled ? 1.0 : 0.0;
    u.uChromaticAberrationStrengthPx.value = p.chromaticAberrationStrengthPx;
    u.uChromaticAberrationThreshold.value = p.chromaticAberrationThreshold;
    u.uChromaticAberrationThresholdSoftness.value = p.chromaticAberrationThresholdSoftness;
    u.uChromaticAberrationKawaseBlurPx.value = p.chromaticAberrationKawaseBlurPx;
    u.uChromaticAberrationSampleSpread.value = p.chromaticAberrationSampleSpread;
    u.uChromaticAberrationEdgeCenter.value = p.chromaticAberrationEdgeCenter;
    u.uChromaticAberrationEdgeFeather.value = p.chromaticAberrationEdgeFeather;
    u.uChromaticAberrationEdgeGamma.value = p.chromaticAberrationEdgeGamma;
    u.uChromaticAberrationEdgeMin.value = p.chromaticAberrationEdgeMin;
    u.uChromaticAberrationDeadzone.value = p.chromaticAberrationDeadzone ?? 0.02;
    u.uChromaticAberrationDeadzoneSoftness.value = p.chromaticAberrationDeadzoneSoftness ?? 0.02;

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
    u.uRainDistortionStrengthPx.value = p.rainDistortionStrengthPx ?? 6.0;
    u.uRainDistortionScale.value = p.rainDistortionScale ?? 8.0;
    u.uRainDistortionSpeed.value = p.rainDistortionSpeed ?? 1.2;
    u.uRainIndoorDampingEnabled.value = p.rainIndoorDampingEnabled ? 1.0 : 0.0;
    u.uRainIndoorDampingStrength.value = p.rainIndoorDampingStrength ?? 1.0;

    // ── Specular (GGX) ───────────────────────────────────────────────────
    u.uSpecStrength.value = p.specStrength;
    u.uSpecPower.value = p.specPower;
    if (u.uSpecModel) u.uSpecModel.value = (p.specModel ?? 0) ? 1.0 : 0.0;
    if (u.uSpecClamp) u.uSpecClamp.value = p.specClamp ?? 0.0;
    u.uSpecSunIntensity.value = p.specSunIntensity;
    u.uSpecNormalStrength.value = p.specNormalStrength;
    u.uSpecNormalScale.value = p.specNormalScale;
    u.uSpecNormalMode.value = Number.isFinite(Number(p.specNormalMode)) ? Number(p.specNormalMode) : 0.0;
    u.uSpecMicroStrength.value = p.specMicroStrength ?? 0.0;
    u.uSpecMicroScale.value = p.specMicroScale ?? 1.0;
    u.uSpecAAStrength.value = p.specAAStrength ?? 0.0;
    u.uSpecWaveStepMul.value = p.specWaveStepMul ?? 1.0;
    if (u.uSpecForceFlatNormal) u.uSpecForceFlatNormal.value = p.specForceFlatNormal ? 1.0 : 0.0;
    if (u.uSpecDisableMasking) u.uSpecDisableMasking.value = p.specDisableMasking ? 1.0 : 0.0;
    if (u.uSpecDisableRainSlope) u.uSpecDisableRainSlope.value = p.specDisableRainSlope ? 1.0 : 0.0;
    u.uSpecRoughnessMin.value = p.specRoughnessMin;
    u.uSpecRoughnessMax.value = p.specRoughnessMax;
    u.uSpecF0.value = p.specF0;
    u.uSpecMaskGamma.value = p.specMaskGamma;
    u.uSpecSkyTint.value = p.specSkyTint;
    u.uSpecShoreBias.value = p.specShoreBias;
    u.uSpecDistortionNormalStrength.value = p.specDistortionNormalStrength;
    u.uSpecAnisotropy.value = p.specAnisotropy;
    u.uSpecAnisoRatio.value = p.specAnisoRatio;
    u.uCloudShadowEnabled.value = p.cloudShadowEnabled ? 1.0 : 0.0;
    u.uCloudShadowDarkenStrength.value = p.cloudShadowDarkenStrength ?? 1.25;
    u.uCloudShadowDarkenCurve.value = p.cloudShadowDarkenCurve ?? 1.5;
    u.uCloudShadowSpecularKill.value = p.cloudShadowSpecularKill ?? 1.0;
    u.uCloudShadowSpecularCurve.value = p.cloudShadowSpecularCurve ?? 6.0;

    // Caustics
    u.uCausticsEnabled.value = p.causticsEnabled ? 1.0 : 0.0;
    u.uCausticsIntensity.value = p.causticsIntensity ?? 4.0;
    u.uCausticsScale.value = p.causticsScale ?? 33.4;
    u.uCausticsSpeed.value = p.causticsSpeed ?? 1.05;
    u.uCausticsSharpness.value = p.causticsSharpness ?? 0.15;
    u.uCausticsEdgeLo.value = p.causticsEdgeLo ?? 0.11;
    u.uCausticsEdgeHi.value = p.causticsEdgeHi ?? 1.0;
    if (u.uCausticsBrightnessMaskEnabled) u.uCausticsBrightnessMaskEnabled.value = p.causticsBrightnessMaskEnabled ? 1.0 : 0.0;
    if (u.uCausticsBrightnessThreshold) u.uCausticsBrightnessThreshold.value = Number.isFinite(p.causticsBrightnessThreshold) ? Math.max(0.0, p.causticsBrightnessThreshold) : 0.55;
    if (u.uCausticsBrightnessSoftness) u.uCausticsBrightnessSoftness.value = Number.isFinite(p.causticsBrightnessSoftness) ? Math.max(0.0, p.causticsBrightnessSoftness) : 0.20;
    if (u.uCausticsBrightnessGamma) u.uCausticsBrightnessGamma.value = Number.isFinite(p.causticsBrightnessGamma) ? Math.max(0.01, p.causticsBrightnessGamma) : 1.0;

    // Shore Foam (Advanced)
    u.uShoreFoamEnabled.value = (p.shoreFoamEnabled ?? true) ? 1.0 : 0.0;
    u.uShoreFoamStrength.value = p.shoreFoamStrength ?? 0.8;
    u.uShoreFoamThreshold.value = p.shoreFoamThreshold ?? 0.28;
    u.uShoreFoamScale.value = p.shoreFoamScale ?? 20.0;
    u.uShoreFoamSpeed.value = p.shoreFoamSpeed ?? 0.1;
    const shoreFoamColor = normalizeRgb01(p.shoreFoamColor, { r: 1.0, g: 1.0, b: 1.0 });
    u.uShoreFoamColor.value.set(shoreFoamColor.r, shoreFoamColor.g, shoreFoamColor.b);
    const shoreFoamTint = normalizeRgb01(p.shoreFoamTint, { r: 0.95, g: 0.97, b: 0.9 });
    u.uShoreFoamTint.value.set(shoreFoamTint.r, shoreFoamTint.g, shoreFoamTint.b);
    u.uShoreFoamTintStrength.value = p.shoreFoamTintStrength ?? 0.2;
    u.uShoreFoamColorVariation.value = p.shoreFoamColorVariation ?? 0.15;
    u.uShoreFoamOpacity.value = p.shoreFoamOpacity ?? 1.0;
    u.uShoreFoamBrightness.value = p.shoreFoamBrightness ?? 0.6;
    u.uShoreFoamContrast.value = p.shoreFoamContrast ?? 1.5;
    u.uShoreFoamGamma.value = p.shoreFoamGamma ?? 0.8;
    u.uShoreFoamLightingEnabled.value = (p.shoreFoamLightingEnabled ?? true) ? 1.0 : 0.0;
    u.uShoreFoamAmbientLight.value = p.shoreFoamAmbientLight ?? 0.5;
    u.uShoreFoamSceneLightInfluence.value = p.shoreFoamSceneLightInfluence ?? 0.8;
    u.uShoreFoamDarknessResponse.value = p.shoreFoamDarknessResponse ?? 0.7;
    u.uShoreFoamFilamentsEnabled.value = (p.shoreFoamFilamentsEnabled ?? true) ? 1.0 : 0.0;
    u.uShoreFoamFilamentsStrength.value = p.shoreFoamFilamentsStrength ?? 0.5;
    u.uShoreFoamFilamentsScale.value = p.shoreFoamFilamentsScale ?? 5.0;
    u.uShoreFoamFilamentsLength.value = p.shoreFoamFilamentsLength ?? 2.0;
    u.uShoreFoamFilamentsWidth.value = p.shoreFoamFilamentsWidth ?? 0.2;
    u.uShoreFoamThicknessVariation.value = p.shoreFoamThicknessVariation ?? 0.4;
    u.uShoreFoamThicknessScale.value = p.shoreFoamThicknessScale ?? 4.0;
    u.uShoreFoamEdgeDetail.value = p.shoreFoamEdgeDetail ?? 0.5;
    u.uShoreFoamEdgeDetailScale.value = p.shoreFoamEdgeDetailScale ?? 10.0;
    u.uShoreFoamWaveDistortionStrength.value = p.shoreFoamWaveDistortionStrength ?? 3.0;
    u.uShoreFoamNoiseDistortionEnabled.value = (p.shoreFoamNoiseDistortionEnabled ?? true) ? 1.0 : 0.0;
    u.uShoreFoamNoiseDistortionStrength.value = p.shoreFoamNoiseDistortionStrength ?? 1.0;
    u.uShoreFoamNoiseDistortionScale.value = p.shoreFoamNoiseDistortionScale ?? 2.5;
    u.uShoreFoamNoiseDistortionSpeed.value = p.shoreFoamNoiseDistortionSpeed ?? 0.4;
    u.uShoreFoamEvolutionEnabled.value = (p.shoreFoamEvolutionEnabled ?? true) ? 1.0 : 0.0;
    u.uShoreFoamEvolutionSpeed.value = p.shoreFoamEvolutionSpeed ?? 0.2;
    u.uShoreFoamEvolutionAmount.value = p.shoreFoamEvolutionAmount ?? 0.5;
    u.uShoreFoamEvolutionScale.value = p.shoreFoamEvolutionScale ?? 2.0;
    u.uShoreFoamCoreWidth.value = p.shoreFoamCoreWidth ?? 0.15;
    u.uShoreFoamCoreFalloff.value = p.shoreFoamCoreFalloff ?? 0.1;
    u.uShoreFoamTailWidth.value = p.shoreFoamTailWidth ?? 0.6;
    u.uShoreFoamTailFalloff.value = p.shoreFoamTailFalloff ?? 0.3;

    // Sun direction from azimuth + elevation (cached to avoid per-frame trig)
    const az = p.specSunAzimuthDeg ?? 135;
    const el = p.specSunElevationDeg ?? 45;
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

    // ── Foam ──────────────────────────────────────────────────────────────
    const foamColor = normalizeRgb01(p.foamColor, { r: 0.85, g: 0.9, b: 0.88 });
    u.uFoamColor.value.set(foamColor.r, foamColor.g, foamColor.b);
    u.uFoamStrength.value = p.foamStrength;
    u.uFoamThreshold.value = p.foamThreshold;
    u.uFoamShoreCorePower.value = p.foamShoreCorePower;
    u.uFoamShoreCoreStrength.value = p.foamShoreCoreStrength;
    u.uFoamShoreTailPower.value = p.foamShoreTailPower;
    u.uFoamShoreTailStrength.value = p.foamShoreTailStrength;
    u.uFoamScale.value = p.foamScale;
    u.uFoamSpeed.value = p.foamSpeed;
    u.uFoamCurlStrength.value = p.foamCurlStrength;
    u.uFoamCurlScale.value = p.foamCurlScale;
    u.uFoamCurlSpeed.value = p.foamCurlSpeed;
    u.uFoamBreakupStrength1.value = p.foamBreakupStrength1;
    u.uFoamBreakupScale1.value = p.foamBreakupScale1;
    u.uFoamBreakupSpeed1.value = p.foamBreakupSpeed1;
    u.uFoamBreakupStrength2.value = p.foamBreakupStrength2;
    u.uFoamBreakupScale2.value = p.foamBreakupScale2;
    u.uFoamBreakupSpeed2.value = p.foamBreakupSpeed2;
    u.uFoamBlackPoint.value = p.foamBlackPoint;
    u.uFoamWhitePoint.value = p.foamWhitePoint;
    u.uFoamGamma.value = p.foamGamma;
    u.uFoamContrast.value = p.foamContrast;
    u.uFoamBrightness.value = p.foamBrightness;
    u.uFloatingFoamStrength.value = p.floatingFoamStrength;
    u.uFloatingFoamCoverage.value = p.floatingFoamCoverage;
    u.uFloatingFoamScale.value = p.floatingFoamScale;
    u.uFloatingFoamWaveDistortion.value = p.floatingFoamWaveDistortion;
    
    // Floating Foam Advanced (Phase 1)
    const floatingFoamColor = normalizeRgb01(p.floatingFoamColor, { r: 1.0, g: 1.0, b: 1.0 });
    u.uFloatingFoamColor.value.set(floatingFoamColor.r, floatingFoamColor.g, floatingFoamColor.b);
    const floatingFoamTint = normalizeRgb01(p.floatingFoamTint, { r: 0.9, g: 0.95, b: 0.85 });
    u.uFloatingFoamTint.value.set(floatingFoamTint.r, floatingFoamTint.g, floatingFoamTint.b);
    u.uFloatingFoamTintStrength.value = p.floatingFoamTintStrength ?? 0.3;
    u.uFloatingFoamColorVariation.value = p.floatingFoamColorVariation ?? 0.2;
    u.uFloatingFoamOpacity.value = p.floatingFoamOpacity ?? 1.0;
    u.uFloatingFoamBrightness.value = p.floatingFoamBrightness ?? 0.5;
    u.uFloatingFoamContrast.value = p.floatingFoamContrast ?? 1.8;
    u.uFloatingFoamGamma.value = p.floatingFoamGamma ?? 0.7;
    
    u.uFloatingFoamLightingEnabled.value = (p.floatingFoamLightingEnabled ?? true) ? 1.0 : 0.0;
    u.uFloatingFoamAmbientLight.value = p.floatingFoamAmbientLight ?? 0.4;
    u.uFloatingFoamSceneLightInfluence.value = p.floatingFoamSceneLightInfluence ?? 0.7;
    u.uFloatingFoamDarknessResponse.value = p.floatingFoamDarknessResponse ?? 0.6;
    
    u.uFloatingFoamShadowEnabled.value = (p.floatingFoamShadowEnabled ?? true) ? 1.0 : 0.0;
    u.uFloatingFoamShadowStrength.value = p.floatingFoamShadowStrength ?? 0.35;
    u.uFloatingFoamShadowSoftness.value = p.floatingFoamShadowSoftness ?? 0.5;
    u.uFloatingFoamShadowDepth.value = p.floatingFoamShadowDepth ?? 0.8;
    
    // Floating Foam Complexity (Phase 2)
    u.uFloatingFoamFilamentsEnabled.value = (p.floatingFoamFilamentsEnabled ?? true) ? 1.0 : 0.0;
    u.uFloatingFoamFilamentsStrength.value = p.floatingFoamFilamentsStrength ?? 0.6;
    u.uFloatingFoamFilamentsScale.value = p.floatingFoamFilamentsScale ?? 4.0;
    u.uFloatingFoamFilamentsLength.value = p.floatingFoamFilamentsLength ?? 2.5;
    u.uFloatingFoamFilamentsWidth.value = p.floatingFoamFilamentsWidth ?? 0.15;
    u.uFloatingFoamThicknessVariation.value = p.floatingFoamThicknessVariation ?? 0.5;
    u.uFloatingFoamThicknessScale.value = p.floatingFoamThicknessScale ?? 3.0;
    u.uFloatingFoamEdgeDetail.value = p.floatingFoamEdgeDetail ?? 0.4;
    u.uFloatingFoamEdgeDetailScale.value = p.floatingFoamEdgeDetailScale ?? 8.0;
    u.uFloatingFoamLayerCount.value = p.floatingFoamLayerCount ?? 2.0;
    u.uFloatingFoamLayerOffset.value = p.floatingFoamLayerOffset ?? 0.3;
    
    // Floating Foam Distortion & Evolution
    u.uFloatingFoamWaveDistortionStrength.value = p.floatingFoamWaveDistortionStrength ?? 2.5;
    u.uFloatingFoamNoiseDistortionEnabled.value = (p.floatingFoamNoiseDistortionEnabled ?? true) ? 1.0 : 0.0;
    u.uFloatingFoamNoiseDistortionStrength.value = p.floatingFoamNoiseDistortionStrength ?? 0.8;
    u.uFloatingFoamNoiseDistortionScale.value = p.floatingFoamNoiseDistortionScale ?? 2.0;
    u.uFloatingFoamNoiseDistortionSpeed.value = p.floatingFoamNoiseDistortionSpeed ?? 0.3;
    u.uFloatingFoamEvolutionEnabled.value = (p.floatingFoamEvolutionEnabled ?? true) ? 1.0 : 0.0;
    u.uFloatingFoamEvolutionSpeed.value = p.floatingFoamEvolutionSpeed ?? 0.15;
    u.uFloatingFoamEvolutionAmount.value = p.floatingFoamEvolutionAmount ?? 0.6;
    u.uFloatingFoamEvolutionScale.value = p.floatingFoamEvolutionScale ?? 1.5;
    
    u.uFoamFlecksIntensity.value = p.foamFlecksIntensity;

    // ── Murk ──────────────────────────────────────────────────────────────
    u.uMurkEnabled.value = p.murkEnabled ? 1.0 : 0.0;
    u.uMurkIntensity.value = p.murkIntensity;
    const murkColor = normalizeRgb01(p.murkColor, { r: 0.15, g: 0.22, b: 0.12 });
    u.uMurkColor.value.set(murkColor.r, murkColor.g, murkColor.b);
    u.uMurkScale.value = p.murkScale;
    u.uMurkSpeed.value = p.murkSpeed;
    u.uMurkDepthLo.value = p.murkDepthLo;
    u.uMurkDepthHi.value = p.murkDepthHi;
    u.uMurkGrainScale.value = p.murkGrainScale;
    u.uMurkGrainSpeed.value = p.murkGrainSpeed;
    u.uMurkGrainStrength.value = p.murkGrainStrength;
    u.uMurkDepthFade.value = p.murkDepthFade;

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

  /**
   * Minimal post-processing render pass.
   * For bisection: this is an unconditional passthrough blit (inputRT -> outputRT).
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera} camera
   * @param {THREE.WebGLRenderTarget} inputRT
   * @param {THREE.WebGLRenderTarget} outputRT
   * @param {THREE.WebGLRenderTarget|null} [occluderRT=null]
   * @returns {boolean} true when the pass wrote to outputRT
   */
  render(renderer, camera, inputRT, outputRT, occluderRT = null) {
    if (!this._initialized || !this._composeMaterial || !this._composeScene || !this._composeCamera) return false;
    if (!renderer || !inputRT || !outputRT) return false;

    const u = this._composeMaterial.uniforms;
    u.tDiffuse.value = inputRT.texture;
    u.uWaterEnabled.value = this.enabled ? 1.0 : 0.0;

    // Bind screen-space occluder alpha (upper-floor coverage mask)
    try {
      if (u.tWaterOccluderAlpha && u.uHasWaterOccluderAlpha) {
        if (occluderRT?.texture) {
          u.tWaterOccluderAlpha.value = occluderRT.texture;
          u.uHasWaterOccluderAlpha.value = 1.0;
        } else {
          // Leave fallback texture but mark as unavailable.
          u.uHasWaterOccluderAlpha.value = 0.0;
        }
      }
    } catch (_) {}

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

    renderer.setRenderTarget(outputRT);
    renderer.autoClear = true;
    renderer.setClearColor(0x000000, 0);
    renderer.render(this._composeScene, this._composeCamera);

    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
    return true;
  }
  /**
   * Handle floor change — swap active water SDF data.
   * @param {number} maxFloorIndex
   */
  onFloorChange(maxFloorIndex) {
    if (!this._initialized) return;
    // Find the highest floor index that has water data and is <= maxFloorIndex.
    // This handles the common case where water is only on floor 0.
    let bestFloor = -1;
    for (const floorIndex of this._floorWater.keys()) {
      if (floorIndex <= maxFloorIndex && floorIndex > bestFloor) {
        bestFloor = floorIndex;
      }
    }

    if (bestFloor >= 0 && bestFloor !== this._activeFloorIndex) {
      this._activeFloorIndex = bestFloor;
      this._applyFloorWaterData(bestFloor);
    } else if (bestFloor < 0) {
      // No water on any visible floor — disable water data
      if (this._composeMaterial) {
        this._composeMaterial.uniforms.uHasWaterData.value = 0.0;
        this._composeMaterial.uniforms.uHasWaterRawMask.value = 0.0;
      }
    }
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

    // Dispose compose quad resources
    try { this._composeMaterial?.dispose(); } catch (_) {}
    try { this._composeQuad?.geometry?.dispose(); } catch (_) {}
    this._composeScene = null;
    this._composeCamera = null;
    this._composeMaterial = null;
    this._composeQuad = null;

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
      uUseSdfMask:         { value: p.useSdfMask === false ? 0.0 : 1.0 },
      tWaterRawMask:       { value: waterRawMask ?? fallbacks.black },
      uHasWaterRawMask:    { value: waterRawMask ? 1.0 : 0.0 },
      tWaterOccluderAlpha: { value: waterOccluderAlpha ?? fallbacks.black },
      uHasWaterOccluderAlpha: { value: waterOccluderAlpha ? 1.0 : 0.0 },
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
      uSpecF0:              { value: p.specF0 },
      uSpecMaskGamma:       { value: p.specMaskGamma },
      uSpecSkyTint:         { value: p.specSkyTint },
      uSpecShoreBias:       { value: p.specShoreBias },
      uSpecDistortionNormalStrength: { value: p.specDistortionNormalStrength },
      uSpecAnisotropy:      { value: p.specAnisotropy },
      uSpecAnisoRatio:      { value: p.specAnisoRatio },
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
   * Resolve the floor index for a tile document (same logic as SpecularEffectV2).
   * @private
   */
  _resolveFloorIndex(tileDoc, floors) {
    if (tileHasLevelsRange(tileDoc)) {
      const flags = readTileLevelsFlags(tileDoc);
      if (flags) {
        for (let i = 0; i < floors.length; i++) {
          const flr = floors[i];
          const elevation = flr.elevation ?? flr.rangeBottom ?? 0;
          if (elevation >= flags.rangeBottom && elevation < flags.rangeTop) return i;
        }
      }
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
