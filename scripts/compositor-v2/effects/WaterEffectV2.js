/**
 * @fileoverview WaterEffectV2 — V2 water post-processing pass.
 *
 * Applies water tint, wave distortion, caustics, specular (GGX), foam, murk,
 * sand, rain ripples, and chromatic aberration to water areas defined by
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
import { getVertexShader, getFragmentShader } from './water-shader.js';

const log = createLogger('WaterEffectV2');

// Bitmask flags for conditional shader defines.
const DEF_FOAM_FLECKS = 1 << 0;
const DEF_MULTITAP    = 1 << 1;
const DEF_CHROM_AB    = 1 << 2;

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

    // ── Effect parameters (V1 defaults for visual parity) ────────────────
    this.params = {
      // Tint
      tintColor: { r: 0.02, g: 0.18, b: 0.28 },
      tintStrength: 0.36,

      // Waves
      waveScale: 4.0,
      waveSpeed: 1.0,
      waveStrength: 0.6,
      distortionStrengthPx: 6.0,
      waveWarpLargeStrength: 0.15,
      waveWarpSmallStrength: 0.08,
      waveWarpMicroStrength: 0.04,
      waveWarpTimeSpeed: 0.15,
      waveEvolutionEnabled: true,
      waveEvolutionSpeed: 0.15,
      waveEvolutionAmount: 0.3,
      waveEvolutionScale: 0.5,
      waveSpeedUseWind: true,
      waveSpeedWindMinFactor: 0.2,
      waveStrengthUseWind: true,
      waveStrengthWindMinFactor: 0.55,
      waveIndoorDampingEnabled: false,
      waveIndoorDampingStrength: 1.0,
      waveIndoorMinFactor: 0.05,
      useTargetWindDirection: true,
      windDirResponsiveness: 10.0,

      // Chromatic aberration
      // Keep enabled by default for V1 visual parity (subtle RGB separation
      // on distortion edges). This was accidentally left disabled in early V2.
      chromaticAberrationEnabled: true,
      chromaticAberrationStrengthPx: 2.5,
      chromaticAberrationEdgeCenter: 0.50,
      chromaticAberrationEdgeFeather: 0.10,
      chromaticAberrationEdgeGamma: 1.0,
      chromaticAberrationEdgeMin: 0.0,

      // Distortion edge masking
      distortionEdgeCenter: 0.50,
      distortionEdgeFeather: 0.06,
      distortionEdgeGamma: 1.0,
      distortionShoreRemapLo: 0.0,
      distortionShoreRemapHi: 1.0,
      distortionShorePow: 1.0,
      distortionShoreMin: 0.0,

      // Refraction
      // Keep multi-tap enabled by default to preserve the softer V1 water look.
      refractionMultiTapEnabled: true,

      // Rain
      rainPrecipitation: 0.0,
      rainDistortionEnabled: true,
      rainDistortionUseWeather: true,
      rainDistortionPrecipitationOverride: 0.0,
      rainIndoorDampingEnabled: true,
      rainIndoorDampingStrength: 1.0,
      rainSplit: 0.5,
      rainBlend: 0.1,
      rainGlobalStrength: 1.0,
      rainRippleStrengthPx: 3.0,
      rainRippleScale: 12.0,
      rainRippleSpeed: 1.0,
      rainRippleDensity: 0.7,
      rainRippleSharpness: 1.0,
      rainRippleJitter: 0.8,
      rainRippleRadiusMin: 0.1,
      rainRippleRadiusMax: 0.45,
      rainRippleWidthScale: 1.0,
      rainRippleSecondaryEnabled: true,
      rainRippleSecondaryStrength: 0.4,
      rainRippleSecondaryPhaseOffset: 0.35,
      rainStormStrengthPx: 8.0,
      rainStormScale: 6.0,
      rainStormSpeed: 0.5,
      rainStormCurl: 1.0,
      rainStormRateBase: 0.6,
      rainStormRateSpeedScale: 0.3,
      rainStormSizeMin: 0.08,
      rainStormSizeMax: 0.35,
      rainStormWidthMinScale: 0.3,
      rainStormWidthMaxScale: 0.8,
      rainStormDecay: 3.0,
      rainStormCoreWeight: 0.6,
      rainStormRingWeight: 0.8,
      rainStormSwirlStrength: 0.6,
      rainStormMicroEnabled: true,
      rainStormMicroStrength: 0.3,
      rainStormMicroScale: 2.5,
      rainStormMicroSpeed: 0.8,
      rainMaxCombinedStrengthPx: 10.0,

      // Wind coupling
      lockWaveTravelToWind: true,
      waveDirOffsetDeg: 0.0,
      waveAppearanceRotDeg: 0.0,
      waveAppearanceOffsetDeg: 0.0,
      advectionDirOffsetDeg: 0.0,
      advectionSpeed01: 0.15,
      advectionSpeed: 1.5,

      // Specular (GGX)
      specStrength: 80.0,
      specPower: 8.0,
      specModel: 1,
      specClamp: 0.65,
      specSunAzimuthDeg: 135.0,
      specSunElevationDeg: 45.0,
      specSunIntensity: 2.5,
      specNormalStrength: 1.2,
      specNormalScale: 0.6,
      specNormalMode: 3,
      specMicroStrength: 0.6,
      specMicroScale: 1.8,
      specAAStrength: 0.0,
      specWaveStepMul: 2.0,
      specForceFlatNormal: false,
      specDisableMasking: false,
      specDisableRainSlope: false,
      specRoughnessMin: 0.05,
      specRoughnessMax: 0.30,
      specF0: 0.04,
      specMaskGamma: 0.5,
      specSkyTint: 0.3,
      skyIntensity: 1.0,
      specShoreBias: 0.3,
      specDistortionNormalStrength: 0.5,
      specAnisotropy: 0.0,
      specAnisoRatio: 2.0,

      // Cloud shadow modulation
      cloudShadowEnabled: true,
      cloudShadowDarkenStrength: 1.25,
      cloudShadowDarkenCurve: 1.5,
      cloudShadowSpecularKill: 1.0,
      cloudShadowSpecularCurve: 6.0,

      // Caustics
      causticsEnabled: true,
      causticsIntensity: 8.0,
      causticsScale: 33.4,
      causticsSpeed: 1.05,
      causticsSharpness: 0.25,
      causticsEdgeLo: 0.0,
      causticsEdgeHi: 1.0,

      // Caustics brightness thresholding (V1: brightness mask gate)
      causticsBrightnessMaskEnabled: false,
      causticsBrightnessThreshold: 0.55,
      causticsBrightnessSoftness: 0.20,
      causticsBrightnessGamma: 1.0,

      // Foam
      foamColor: { r: 0.85, g: 0.90, b: 0.88 },
      foamStrength: 0.60,
      foamThreshold: 0.28,
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
      floatingFoamStrength: 0.40,
      floatingFoamCoverage: 0.35,
      floatingFoamScale: 8.0,
      floatingFoamWaveDistortion: 0.5,
      foamFlecksEnabled: true,
      foamFlecksIntensity: 0.6,

      // Murk
      murkEnabled: true,
      murkIntensity: 0.4,
      murkColor: { r: 0.15, g: 0.22, b: 0.12 },
      murkScale: 1.2,
      murkSpeed: 0.05,
      murkDepthLo: 0.2,
      murkDepthHi: 0.8,
      murkGrainScale: 80.0,
      murkGrainSpeed: 0.3,
      murkGrainStrength: 0.4,
      murkDepthFade: 1.5,

      // Sand
      sandEnabled: false,
      sandIntensity: 0.5,
      sandColor: { r: 0.76, g: 0.68, b: 0.50 },
      sandContrast: 1.5,
      sandChunkScale: 12.0,
      sandChunkSpeed: 0.15,
      sandGrainScale: 600.0,
      sandGrainSpeed: 0.1,
      sandWindDriftScale: 0.5,
      sandLayeringEnabled: false,
      sandLayerScaleSpread: 0.5,
      sandLayerIntensitySpread: 0.65,
      sandLayerDriftSpread: 0.4,
      sandLayerEvolutionSpread: 0.5,
      sandBillowStrength: 0.4,
      sandCoverage: 0.4,
      sandChunkSoftness: 0.15,
      sandSpeckCoverage: 0.3,
      sandSpeckSoftness: 0.1,
      sandDepthLo: 0.0,
      sandDepthHi: 0.85,
      sandAnisotropy: 0.3,
      sandDistortionStrength: 0.3,
      sandAdditive: 0.15,

      // SDF build
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
    this._windOffsetUvX = 0;
    this._windOffsetUvY = 0;
    this._smoothedWindDirX = 1.0;
    this._smoothedWindDirY = 0.0;
    this._smoothedWindSpeed01 = 0.0;

    // ── Debug arrow DOM overlay ──────────────────────────────────────────
    /** @type {HTMLElement|null} */
    this._windDebugArrow = null;

    log.info(`WaterEffectV2 constructed (${this._instanceId})`);

    // Cached trigonometry for advection angle offset (avoids per-frame sin/cos).
    this._cachedAdvectionDirOffsetDeg = null;
    this._cachedAdvectionDirCos = 1.0;
    this._cachedAdvectionDirSin = 0.0;
    this._lastTimeValue = null;

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
    // IMPORTANT: Sand is extremely expensive to compile on some Windows GPU
    // drivers. We've seen the first WaterEffectV2 render hang indefinitely while
    // compiling the shader when USE_SAND is enabled, even if sandEnabled=false.
    //
    // To keep the compositor stable, we default to NOT compiling sand.
    // Sand is still uniform-gated, but the shader code is removed at compile time.
    //
    // If you later want sand, we can add a controlled (opt-in) shader recompile path.
    // For now: stability first.
    // defines.USE_SAND = 1;
    if (this.params.foamFlecksEnabled) defines.USE_FOAM_FLECKS = 1;
    if (this.params.refractionMultiTapEnabled) defines.USE_WATER_REFRACTION_MULTITAP = 1;
    if (this.params.chromaticAberrationEnabled) defines.USE_WATER_CHROMATIC_ABERRATION = 1;

    // DEBUG: Mask-gated tint + wave distortion shader.
    // Uses the EXACT same wave functions as the full water-shader.js — verbatim.
    // No invented noise: fbmNoise -> warpUv -> calculateWave -> waveGrad2D pipeline.
    // distMask is approximated from raw mask value (no SDF yet).
    const DEBUG_MASK_TINT_ONLY = false;
    const fragSrc = DEBUG_MASK_TINT_ONLY
      ? `
        // ── Samplers ────────────────────────────────────────────────────────
        uniform sampler2D tDiffuse;
        uniform sampler2D tNoiseMap;
        uniform sampler2D tWaterRawMask;
        uniform float uHasWaterRawMask;

        uniform sampler2D tWaterOccluderAlpha;
        uniform float uHasWaterOccluderAlpha;

        // ── Tint ────────────────────────────────────────────────────────────
        uniform vec3 uTintColor;
        uniform float uTintStrength;

        // ── Wave uniforms (identical to full water-shader.js) ────────────────
        uniform float uTime;
        uniform float uWindTime;
        uniform vec2  uWindDir;
        uniform vec2  uWindOffsetUv;
        uniform float uWaveScale;
        uniform float uWaveStrength;
        uniform float uDistortionStrengthPx;
        uniform float uWaveWarpLargeStrength;
        uniform float uWaveWarpSmallStrength;
        uniform float uWaveWarpMicroStrength;
        uniform float uWaveWarpTimeSpeed;
        uniform float uWaveEvolutionEnabled;
        uniform float uWaveEvolutionSpeed;
        uniform float uWaveEvolutionAmount;
        uniform float uWaveEvolutionScale;
        uniform float uLockWaveTravelToWind;
        uniform float uWaveDirOffsetRad;
        uniform float uWaveAppearanceRotRad;
        uniform vec2  uResolution;
        uniform float uZoom;

        // ── Chromatic aberration (RGB shift) ───────────────────────────────
        uniform float uChromaticAberrationStrengthPx;
        uniform float uChromaticAberrationEdgeCenter;
        uniform float uChromaticAberrationEdgeFeather;
        uniform float uChromaticAberrationEdgeGamma;
        uniform float uChromaticAberrationEdgeMin;

        // ── Coordinate conversion uniforms ──────────────────────────────────
        uniform vec4  uViewBounds;      // (minX, minY, maxX, maxY) Three world
        uniform vec2  uSceneDimensions; // Foundry canvas (width, height)
        uniform vec4  uSceneRect;       // (sceneX, sceneY, sceneW, sceneH) Foundry
        uniform float uHasSceneRect;

        varying vec2 vUv;

        // ── Coordinate conversion (verbatim from water-shader.js) ────────────
        vec2 screenUvToFoundry(vec2 screenUv) {
          float threeX = mix(uViewBounds.x, uViewBounds.z, screenUv.x);
          float threeY = mix(uViewBounds.y, uViewBounds.w, screenUv.y);
          return vec2(threeX, uSceneDimensions.y - threeY);
        }
        vec2 foundryToSceneUv(vec2 foundryPos) {
          return (foundryPos - uSceneRect.xy) / max(uSceneRect.zw, vec2(1e-5));
        }

        // ── Noise (verbatim from water-shader.js) ────────────────────────────
        const float NOISE_INV = 1.0 / 512.0;

        float hash12(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }

        float fbmNoise(vec2 p) {
          const mat2 octRot = mat2(0.8, 0.6, -0.6, 0.8);
          vec2 i, f, u;
          i = floor(p); f = fract(p); u = f * f * (3.0 - 2.0 * f);
          float n0 = mix(mix(
            texture2D(tNoiseMap, (i + 0.5) * NOISE_INV).r,
            texture2D(tNoiseMap, (i + vec2(1.5, 0.5)) * NOISE_INV).r, u.x), mix(
            texture2D(tNoiseMap, (i + vec2(0.5, 1.5)) * NOISE_INV).r,
            texture2D(tNoiseMap, (i + vec2(1.5, 1.5)) * NOISE_INV).r, u.x), u.y);
          p = octRot * p * 2.0;
          i = floor(p); f = fract(p); u = f * f * (3.0 - 2.0 * f);
          float n1 = mix(mix(
            texture2D(tNoiseMap, (i + 0.5) * NOISE_INV).g,
            texture2D(tNoiseMap, (i + vec2(1.5, 0.5)) * NOISE_INV).g, u.x), mix(
            texture2D(tNoiseMap, (i + vec2(0.5, 1.5)) * NOISE_INV).g,
            texture2D(tNoiseMap, (i + vec2(1.5, 1.5)) * NOISE_INV).g, u.x), u.y);
          p = octRot * p * 2.0;
          i = floor(p); f = fract(p); u = f * f * (3.0 - 2.0 * f);
          float n2 = mix(mix(
            texture2D(tNoiseMap, (i + 0.5) * NOISE_INV).b,
            texture2D(tNoiseMap, (i + vec2(1.5, 0.5)) * NOISE_INV).b, u.x), mix(
            texture2D(tNoiseMap, (i + vec2(0.5, 1.5)) * NOISE_INV).b,
            texture2D(tNoiseMap, (i + vec2(1.5, 1.5)) * NOISE_INV).b, u.x), u.y);
          p = octRot * p * 2.0;
          i = floor(p); f = fract(p); u = f * f * (3.0 - 2.0 * f);
          float n3 = mix(mix(
            texture2D(tNoiseMap, (i + 0.5) * NOISE_INV).a,
            texture2D(tNoiseMap, (i + vec2(1.5, 0.5)) * NOISE_INV).a, u.x), mix(
            texture2D(tNoiseMap, (i + vec2(0.5, 1.5)) * NOISE_INV).a,
            texture2D(tNoiseMap, (i + vec2(1.5, 1.5)) * NOISE_INV).a, u.x), u.y);
          return (n0 - 0.5) * 1.1 + (n1 - 0.5) * 0.605
               + (n2 - 0.5) * 0.33275 + (n3 - 0.5) * 0.183;
        }

        // ── Wave system (verbatim from water-shader.js) ──────────────────────
        vec2 rotate2D(vec2 v, float a) {
          float s = sin(a); float c = cos(a);
          return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
        }

        float hash11(float p) { return fract(sin(p) * 43758.5453123); }

        void waveMods(vec2 lf, float seed, out float kMul, out float dirRot) {
          float a = lf.x; float b = lf.y;
          float r1 = hash11(seed * 13.17 + 1.0);
          float r2 = hash11(seed * 29.73 + 2.0);
          dirRot = clamp((a * (0.20 + 0.60 * r1) + b * (0.20 + 0.60 * r2)) * 0.35, -0.55, 0.55);
          float km = 1.0 + (a * (0.15 + 0.25 * r2) + b * (0.10 + 0.25 * r1)) * 0.10;
          kMul = clamp(km, 0.75, 1.25);
        }

        float sharpSin(float phase, float sharpness, out float dHdPhase) {
          float s = sin(phase);
          float a = max(abs(s), 1e-5);
          float shaped = sign(s) * pow(a, sharpness);
          dHdPhase = sharpness * pow(a, sharpness - 1.0) * cos(phase);
          return shaped;
        }

        void addWave(vec2 p, vec2 dir, float k, float amp, float sharpness, float omega, float t, inout float h, inout vec2 gSceneUv) {
          float phase = dot(p, dir) * k - omega * t;
          float d;
          float w = sharpSin(phase, sharpness, d);
          h += amp * w;
          float bunch = 1.0 + 0.35 * abs(w);
          gSceneUv += amp * d * (k * dir) * uWaveScale * bunch;
        }

        float waveSeaState(vec2 sceneUv, float motion01) {
          if (uWaveEvolutionEnabled < 0.5) return 0.5;
          float sp = max(0.0, uWaveEvolutionSpeed) * clamp(motion01, 0.0, 1.0);
          float sc = max(0.01, uWaveEvolutionScale);
          float n = fbmNoise(sceneUv * sc + vec2(uTime * sp * 0.23, -uTime * sp * 0.19));
          float phase = uTime * sp + n * 2.7;
          return 0.5 + 0.5 * sin(phase);
        }

        vec2 warpUv(vec2 sceneUv, float motion01) {
          float m = clamp(motion01, 0.0, 1.0);
          vec2 windOffsetUv = vec2(uWindOffsetUv.x, -uWindOffsetUv.y) * m;
          vec2 uv = sceneUv - windOffsetUv;
          float timeWarp = uTime * max(0.0, uWaveWarpTimeSpeed) * m;
          float sceneAspect = (uHasSceneRect > 0.5) ? (uSceneRect.z / max(1.0, uSceneRect.w)) : (uResolution.x / max(1.0, uResolution.y));
          vec2 windF = uWindDir;
          float wl = length(windF);
          windF = (wl > 1e-6) ? (windF / wl) : vec2(1.0, 0.0);
          vec2 windDir = vec2(windF.x, -windF.y);
          vec2 windBasis = normalize(vec2(windDir.x * sceneAspect, windDir.y));
          vec2 windPerp = vec2(-windBasis.y, windBasis.x);
          vec2 basis = vec2(sceneUv.x * sceneAspect, sceneUv.y);
          float along = dot(basis, windBasis);
          float across = dot(basis, windPerp);
          vec2 streakUv = windBasis * (along * 2.75) + windPerp * (across * 1.0);
          float largeWarpPulse = 0.90 + 0.10 * sin(uTime * 0.27);
          float lf1 = fbmNoise(streakUv * 0.23 + vec2(19.1, 7.3) + vec2(timeWarp * 0.07, -timeWarp * 0.05));
          float lf2 = fbmNoise(streakUv * 0.23 + vec2(3.7, 23.9) + vec2(-timeWarp * 0.04, timeWarp * 0.06));
          uv += vec2(lf1, lf2) * clamp(uWaveWarpLargeStrength, 0.0, 1.0) * largeWarpPulse;
          float n1 = fbmNoise((uv * 2.1) + vec2(13.7, 9.2) + vec2(timeWarp * 0.11, timeWarp * 0.09));
          float n2 = fbmNoise((uv * 2.1) + vec2(41.3, 27.9) + vec2(-timeWarp * 0.08, timeWarp * 0.10));
          uv += vec2(n1, n2) * clamp(uWaveWarpSmallStrength, 0.0, 1.0);
          float n3 = fbmNoise(uv * 4.7 + vec2(7.9, 19.1) + vec2(timeWarp * 0.15, -timeWarp * 0.12));
          float n4 = fbmNoise(uv * 4.7 + vec2(29.4, 3.3) + vec2(-timeWarp * 0.13, -timeWarp * 0.10));
          uv += vec2(n3, n4) * clamp(uWaveWarpMicroStrength, 0.0, 1.0);
          return uv;
        }

        vec3 calculateWave(vec2 sceneUv, float t, float motion01) {
          const float TAU = 6.2831853;
          vec2 windF = uWindDir;
          float wl = length(windF);
          windF = (wl > 1e-5) ? (windF / wl) : vec2(1.0, 0.0);
          vec2 wind = vec2(windF.x, -windF.y);
          float travelRot = (uLockWaveTravelToWind > 0.5) ? 0.0 : uWaveDirOffsetRad;
          wind = rotate2D(wind, travelRot);
          vec2 uvF = warpUv(sceneUv, motion01);
          vec2 p = uvF * uWaveScale;
          vec2 lf = vec2(fbmNoise(sceneUv * 0.11 + vec2(11.3, 17.9)), fbmNoise(sceneUv * 0.11 + vec2(37.1, 5.7)));
          float h = 0.0; vec2 g = vec2(0.0);
          float sea01 = waveSeaState(sceneUv, motion01);
          float evoAmt = clamp(uWaveEvolutionAmount, 0.0, 1.0);
          float evo = mix(1.0 - evoAmt, 1.0 + evoAmt, sea01);
          float breathing = 0.8 + 0.2 * sin(uTime * 0.5 * clamp(motion01, 0.0, 1.0));
          float wavePulse = evo * breathing;
          vec2 swellP = p;
          vec2 chopP = p * 2.618;
          vec2 crossWind = rotate2D(wind, 0.78);
          float chopBreathing = 0.7 + 0.3 * cos(uTime * 0.7 * clamp(motion01, 0.0, 1.0));
          float chopPulse = evo * chopBreathing;
          float kMul0; float r0; waveMods(lf, 1.0, kMul0, r0);
          float k0 = (TAU * 0.61) * kMul0;
          addWave(swellP, rotate2D(wind, -0.60 + r0), k0, 0.40 * wavePulse, 2.20, (1.05 + 0.62 * sqrt(k0)), t, h, g);
          float kMul1; float r1; waveMods(lf, 2.0, kMul1, r1);
          float k1 = (TAU * 0.97) * kMul1;
          addWave(swellP, rotate2D(wind, -0.15 + r1), k1, 0.28 * wavePulse, 2.55, (1.05 + 0.62 * sqrt(k1)), t, h, g);
          float kMul2; float r2; waveMods(lf, 3.0, kMul2, r2);
          float k2 = (TAU * 1.43) * kMul2;
          addWave(swellP, rotate2D(wind, 0.20 + r2), k2, 0.16 * wavePulse, 2.85, (1.05 + 0.62 * sqrt(k2)), t, h, g);
          float kMul3; float r3; waveMods(lf, 4.0, kMul3, r3);
          float k3 = (TAU * 1.88) * kMul3;
          addWave(chopP, rotate2D(crossWind, 0.25 + r3), k3, 0.10 * chopPulse, 3.10, (1.18 + 0.72 * sqrt(k3)), t, h, g);
          float kMul4; float r4; waveMods(lf, 5.0, kMul4, r4);
          float k4 = (TAU * 2.71) * kMul4;
          addWave(chopP, rotate2D(crossWind, -0.35 + r4), k4, 0.06 * chopPulse, 3.35, (1.18 + 0.72 * sqrt(k4)), t, h, g);
          return vec3(h, g / max(uWaveScale, 1e-3));
        }

        vec2 waveGrad2D(vec2 sceneUv, float t, float motion01) { return calculateWave(sceneUv, t, motion01).yz; }

        // ── Chromatic aberration edge mask (blueprint from water-shader.js) ─
        // The full shader uses SDF distance (sdf01) to gate chroma near shore.
        // In debug mode we don't have SDF, so we approximate using the raw mask
        // value as a pseudo "inside" metric.
        float chromaticInsideFromMask(float maskVal01) {
          float c = clamp(uChromaticAberrationEdgeCenter, 0.0, 1.0);
          float f = max(0.0, uChromaticAberrationEdgeFeather);
          float inside = (f > 1e-6) ? smoothstep(c + f, c - f, maskVal01) : step(maskVal01, c);
          inside = pow(clamp(inside, 0.0, 1.0), max(0.01, uChromaticAberrationEdgeGamma));
          return max(clamp(uChromaticAberrationEdgeMin, 0.0, 1.0), inside);
        }

        // ── Main ─────────────────────────────────────────────────────────────
        void main() {
          vec4 base = texture2D(tDiffuse, vUv);

          // ── Occluder gating (verbatim policy from full shader) ───────────
          // Any strong occluder alpha means this pixel is covered by an upper-floor
          // tile and should not receive water shading.
          if (uHasWaterOccluderAlpha > 0.5) {
            float occ = texture2D(tWaterOccluderAlpha, vUv).a;
            if (occ > 0.5) { gl_FragColor = base; return; }
          }

          // ── Screen UV -> scene UV conversion (verbatim from full shader) ────
          float maskVal = 0.0;
          vec2 sceneUv = vUv;
          bool inScene = false;
          if (uHasWaterRawMask > 0.5 && uHasSceneRect > 0.5) {
            vec2 foundryPos = screenUvToFoundry(vUv);
            sceneUv = foundryToSceneUv(foundryPos);
            if (sceneUv.x >= 0.0 && sceneUv.x <= 1.0 && sceneUv.y >= 0.0 && sceneUv.y <= 1.0) {
              inScene = true;
              maskVal = texture2D(tWaterRawMask, sceneUv).r;
            }
          }

          if (!inScene || maskVal < 0.01) { gl_FragColor = base; return; }

          // ── Wave distortion (verbatim logic from full shader main()) ─────────
          // waveGrad2D evaluated at scene UV (world-locked). motion01=1.0 (fully open).
          vec2 waveGrad = waveGrad2D(sceneUv, uWindTime, 1.0);
          waveGrad = rotate2D(waveGrad, uWaveAppearanceRotRad + 1.5707963);

          // Combine and normalise exactly as the full shader does.
          vec2 combinedVec = waveGrad * uWaveStrength;
          combinedVec = combinedVec / (1.0 + 0.75 * length(combinedVec));
          float m = length(combinedVec);
          float dirMask = smoothstep(0.01, 0.06, m);
          vec2 combinedN = (m > 1e-6) ? (combinedVec / m) * dirMask : vec2(0.0);
          float amp = smoothstep(0.0, 0.30, m); amp *= amp;

          vec2 texel = 1.0 / max(uResolution, vec2(1.0));
          float px = clamp(uDistortionStrengthPx, 0.0, 64.0);
          float zoom = max(uZoom, 0.001);
          // distMask: smooth edge-fade so distortion pins to zero at the mask
          // boundary, preventing holes where displaced pixels sample outside water.
          // smoothstep 0→0.15 gives a narrow shore-fade, matching the full
          // shader's SDF-based distortion fade behaviour (no SDF available yet).
          float distMask = smoothstep(0.0, 0.15, maskVal);
          vec2 offsetUv = combinedN * (px * texel) * amp * zoom * distMask;
          vec2 uv1 = clamp(vUv + offsetUv, vec2(0.001), vec2(0.999));

          // Refraction sampling (blueprint from water-shader.js)
          #ifdef USE_WATER_REFRACTION_MULTITAP
          vec2 uv0 = clamp(vUv + offsetUv * 0.55, vec2(0.001), vec2(0.999));
          vec2 uv2 = clamp(vUv + offsetUv * 1.55, vec2(0.001), vec2(0.999));
          vec4 refracted = texture2D(tDiffuse, uv0) * 0.25 + texture2D(tDiffuse, uv1) * 0.50 + texture2D(tDiffuse, uv2) * 0.25;
          #else
          vec4 refracted = texture2D(tDiffuse, uv1);
          #endif

          // Chromatic aberration (RGB shift) — deadened at edges
          // Blueprint from water-shader.js, using a mask-derived edge gate.
          {
            vec2 texel2 = texel;
            float caPx = clamp(uChromaticAberrationStrengthPx, 0.0, 12.0);
            vec2 dir = offsetUv; float dirLen = length(dir);
            vec2 dirN = (dirLen > 1e-6) ? (dir / dirLen) : vec2(1.0, 0.0);
            // Two-stage gating:
            // - distMask: pins distortion to water body
            // - chromaticInsideFromMask: user-tunable edge falloff so RGB shift doesn't
            //   sample from above-water pixels near the shoreline.
            float caEdgeMask = chromaticInsideFromMask(clamp(maskVal, 0.0, 1.0)) * clamp(distMask, 0.0, 1.0);
            vec2 caUv = dirN * (caPx * texel2) * clamp(0.25 + 2.0 * distMask, 0.0, 2.5) * zoom * caEdgeMask;
            vec2 uvR = clamp(uv1 + caUv, vec2(0.001), vec2(0.999));
            vec2 uvB = clamp(uv1 - caUv, vec2(0.001), vec2(0.999));
            refracted.rgb = vec3(texture2D(tDiffuse, uvR).r, refracted.g, texture2D(tDiffuse, uvB).b);
          }

          vec4 col = refracted;
          float t = clamp(uTintStrength, 0.0, 1.0) * distMask;
          vec3 tintMul = 1.0 + uTintColor;
          col.rgb = mix(col.rgb, col.rgb * tintMul, t);
          gl_FragColor = col;
        }
      `
      : getFragmentShader();

    // Create shader material with all uniforms
    this._composeMaterial = new THREE.ShaderMaterial({
      uniforms: this._buildUniforms(THREE),
      vertexShader: getVertexShader(),
      fragmentShader: fragSrc,
      defines: DEBUG_MASK_TINT_ONLY ? {} : defines,
      depthTest: false,
      depthWrite: false,
      transparent: false,
    });
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
    if (tileDocs.length === 0) { log.info('populate: no tiles'); return; }

    const floors = window.MapShine?.floorStack?.getFloors() ?? [];
    const worldH = foundrySceneData?.height ?? canvas?.dimensions?.height ?? 0;

    // ── Step 1: Discover _Water masks per tile ───────────────────────────
    for (const tileDoc of tileDocs) {
      const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
      if (!src) continue;
      const tileId = tileDoc.id ?? tileDoc._id;
      if (!tileId) continue;

      const dotIdx = src.lastIndexOf('.');
      const basePath = dotIdx > 0 ? src.substring(0, dotIdx) : src;

      const waterResult = await probeMaskFile(basePath, '_Water');
      if (!waterResult?.path) continue;

      const floorIndex = this._resolveFloorIndex(tileDoc, floors);
      this._waterTiles.push({
        tileId, basePath, floorIndex,
        maskPath: waterResult.path,
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
    const sceneRect = canvas?.dimensions?.sceneRect ?? canvas?.dimensions;
    const sceneX = sceneRect?.x ?? 0;
    const sceneY = sceneRect?.y ?? 0;
    const sceneW = sceneRect?.width ?? sceneRect?.sceneWidth ?? 1;
    const sceneH = sceneRect?.height ?? sceneRect?.sceneHeight ?? 1;

    for (const [floorIndex, entries] of byFloor) {
      try {
        const floorData = await this._compositeFloorMask(
          THREE, entries, { sceneX, sceneY, sceneW, sceneH }
        );
        if (floorData) {
          this._floorWater.set(floorIndex, floorData);
        }
      } catch (err) {
        log.error(`populate: floor ${floorIndex} mask compositing failed:`, err);
      }
    }

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
  async _compositeFloorMask(THREE, entries, sceneGeo) {
    const { sceneX, sceneY, sceneW, sceneH } = sceneGeo;

    // Load all mask images in parallel via HTMLImageElement (gives us CPU pixels)
    const loadImg = (url) => new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => {
        log.warn(`_compositeFloorMask: failed to load ${url}`);
        resolve(null);
      };
      img.src = url;
    });

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

    // Create a canvas and composite all tile masks into it at their scene-UV positions
    const canvas = document.createElement('canvas');
    canvas.width = cvW;
    canvas.height = cvH;
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

    // Wrap the canvas in a THREE.CanvasTexture so buildFromMaskTexture gets a
    // real image-backed texture (CPU path, not RT readback path)
    const canvasTex = new THREE.CanvasTexture(canvas);
    canvasTex.flipY = false;
    canvasTex.needsUpdate = true;

    // Build SDF from the composited canvas texture
    let waterData = null;
    try {
      waterData = this._surfaceModel.buildFromMaskTexture(canvasTex, {
        resolution: this.params.buildResolution || 2048,
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
      log.error('_compositeFloorMask: SDF build failed:', err);
      canvasTex.dispose();
      return null;
    }

    // CanvasTexture is no longer needed once SDF is built (CPU data was consumed)
    canvasTex.dispose();

    if (!waterData?.hasWater) {
      log.info('_compositeFloorMask: mask found but no water pixels above threshold');
      return null;
    }

    const rawMask = waterData?.rawMaskTexture ?? null;
    return { waterData, rawMask };
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
      const wp = window.MapShineParticles?.weatherParticles;
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
    // Use real wall time for smooth shader animation. Some upstream paths can
    // throttle/quantize timeInfo updates even when the render loop runs fast.
    // Water needs continuous time for fluid motion.
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() * 0.001 : (timeInfo?.elapsed ?? 0);
    const dt = (this._lastTimeValue == null) ? 0 : Math.max(0, now - this._lastTimeValue);
    this._lastTimeValue = now;
    const elapsed = now;

    // Runtime signature: log once on first update with key Wind & Flow params.
    try {
      if (!this._debugSignatureUpdateLogged) {
        this._debugSignatureUpdateLogged = true;
        log.warn('MSA_SIGNATURE: WaterEffectV2.update live', {
          waveSpeedUseWind: p.waveSpeedUseWind,
          waveSpeedWindMinFactor: p.waveSpeedWindMinFactor,
          waveStrengthUseWind: p.waveStrengthUseWind,
          waveStrengthWindMinFactor: p.waveStrengthWindMinFactor,
          advectionSpeed: p.advectionSpeed,
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
        const wv = Number(ws.windSpeed);
        if (Number.isFinite(wx) && Number.isFinite(wy)) {
          const len = Math.hypot(wx, wy);
          if (len > 1e-5) {
            windDirX = wx / len;
            windDirY = wy / len;
          }
        }
        if (Number.isFinite(wv)) windSpeed01 = Math.max(0, Math.min(1, wv));
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

    // Optional wind-direction smoothing (legacy V1 behavior parity).
    if (p.useTargetWindDirection) {
      const responsiveness = Math.max(0, Number(p.windDirResponsiveness) || 0);
      const lerpT = 1.0 - Math.exp(-responsiveness * dt);
      this._smoothedWindDirX += (windDirX - this._smoothedWindDirX) * lerpT;
      this._smoothedWindDirY += (windDirY - this._smoothedWindDirY) * lerpT;
      const smoothLen = Math.hypot(this._smoothedWindDirX, this._smoothedWindDirY);
      if (smoothLen > 1e-5) {
        windDirX = this._smoothedWindDirX / smoothLen;
        windDirY = this._smoothedWindDirY / smoothLen;
      }
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

    // ── Waves (compute early: used to advance uWindTime) ─────────────────
    // windSpeed01 mixes between the "at wind=0" factor and 1.0 (full wind).
    // Math.max was wrong: it treated minFactor as a floor and ignored the slider
    // whenever wind exceeded it. lerp gives smooth, visible control.
    const speedMin = Math.max(0.0, p.waveSpeedWindMinFactor ?? 0.2);
    const strengthMin = Math.max(0.0, p.waveStrengthWindMinFactor ?? 0.55);
    const waveSpeed = (p.waveSpeedUseWind ? (speedMin + (1.0 - speedMin) * windSpeed01) : 1.0) * (p.waveSpeed ?? 1.0);
    const waveStrength = (p.waveStrengthUseWind ? (strengthMin + (1.0 - strengthMin) * windSpeed01) : 1.0) * (p.waveStrength ?? 0.6);

    // waveSpeed drives the animation rate of the wave pattern itself.
    // windSpeed01 only scales uWindTime when waveSpeedUseWind is enabled.
    // Without wind coupling the wave animation must run at full real-time speed
    // (dt * waveSpeed), otherwise the 0.15 default windSpeed01 makes waves
    // appear to run at 15% speed (choppy / slow-motion appearance).
    const windTimeScale = p.waveSpeedUseWind ? windSpeed01 : 1.0;
    this._windTime += dt * windTimeScale * waveSpeed;
    u.uWindTime.value = this._windTime;

    // Water uses the Y-flipped wind direction.
    // Ground-truth from the on-screen arrows: the raw vector was vertically inverted
    // relative to the intended wind direction.
    const waterWindDirX = windDirX;
    const waterWindDirY = -windDirY;
    u.uWindDir.value.set(waterWindDirX, waterWindDirY);
    u.uWindSpeed.value = windSpeed01;

    // Debug arrow: visualize the wind direction vector actually used by water.
    this._updateWindDebugArrow(waterWindDirX, waterWindDirY, windSpeed01, !!p.debugWindArrow);

    // Advection offset (UV drift from wind) — V1 monotonic integration.
    // Compute drift in scene pixels/sec, normalize by scene dimensions.
    // This produces coherent, non-oscillating pattern travel.
    if (dt > 0.0 && u.uWindOffsetUv) {
      const rect = canvas?.dimensions?.sceneRect;
      const sceneW = rect?.width || 1;
      const sceneH = rect?.height || 1;

      const advSpeed01 = this._resolveAdvectionSpeed01(p);
      const advMulLegacy = Number.isFinite(p.advectionSpeed) ? Math.max(0.0, Number(p.advectionSpeed)) : null;
      const advMul = (advMulLegacy != null) ? advMulLegacy : (advSpeed01 * 4.0);

      const pxPerSec = (35.0 + 220.0 * windSpeed01) * advMul;

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
    u.uDistortionStrengthPx.value = p.distortionStrengthPx;
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

    // ── Distortion edge ───────────────────────────────────────────────────
    u.uDistortionEdgeCenter.value = p.distortionEdgeCenter;
    u.uDistortionEdgeFeather.value = p.distortionEdgeFeather;
    u.uDistortionEdgeGamma.value = p.distortionEdgeGamma;
    u.uDistortionShoreRemapLo.value = p.distortionShoreRemapLo;
    u.uDistortionShoreRemapHi.value = p.distortionShoreRemapHi;
    u.uDistortionShorePow.value = p.distortionShorePow;
    u.uDistortionShoreMin.value = p.distortionShoreMin;

    // ── Chromatic aberration ──────────────────────────────────────────────
    u.uChromaticAberrationStrengthPx.value = p.chromaticAberrationStrengthPx;
    u.uChromaticAberrationEdgeCenter.value = p.chromaticAberrationEdgeCenter;
    u.uChromaticAberrationEdgeFeather.value = p.chromaticAberrationEdgeFeather;
    u.uChromaticAberrationEdgeGamma.value = p.chromaticAberrationEdgeGamma;
    u.uChromaticAberrationEdgeMin.value = p.chromaticAberrationEdgeMin;

    // ── Rain (parameter + WeatherController coupling) ─────────────────────
    // Preserve manual tuning (`rainPrecipitation`) but allow live weather to
    // drive intensity when it is stronger.
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
          // Treat type=1 (RAIN) and type=3 (HAIL) as liquid precipitation coupling.
          const isLiquid = (precipType === 1 || precipType === 3);
          if (isLiquid && Number.isFinite(weatherPrecip)) {
            precip = Math.max(precip, Math.max(0, Math.min(1, weatherPrecip)));
          }
        } catch (_) {}
      }
    }
    u.uRainEnabled.value = precip > 0.001 ? 1.0 : 0.0;
    u.uRainPrecipitation.value = precip;
    u.uRainSplit.value = (p.rainDistortionSplit ?? p.rainSplit ?? 0.5);
    u.uRainBlend.value = (p.rainDistortionBlend ?? p.rainBlend ?? 0.1);
    const rainGlobalStrength = (p.rainDistortionGlobalStrength ?? p.rainGlobalStrength ?? 1.0);
    u.uRainGlobalStrength.value = rainGlobalStrength;
    u.uRainIndoorDampingEnabled.value = p.rainIndoorDampingEnabled ? 1.0 : 0.0;
    u.uRainIndoorDampingStrength.value = p.rainIndoorDampingStrength ?? 1.0;
    u.uRainRippleStrengthPx.value = p.rainRippleStrengthPx;
    u.uRainRippleScale.value = p.rainRippleScale;
    u.uRainRippleSpeed.value = p.rainRippleSpeed;
    u.uRainRippleDensity.value = p.rainRippleDensity;
    u.uRainRippleSharpness.value = p.rainRippleSharpness;
    u.uRainRippleJitter.value = p.rainRippleJitter;
    u.uRainRippleRadiusMin.value = p.rainRippleRadiusMin;
    u.uRainRippleRadiusMax.value = p.rainRippleRadiusMax;
    u.uRainRippleWidthScale.value = p.rainRippleWidthScale;
    u.uRainRippleSecondaryEnabled.value = p.rainRippleSecondaryEnabled ? 1.0 : 0.0;
    u.uRainRippleSecondaryStrength.value = p.rainRippleSecondaryStrength;
    u.uRainRippleSecondaryPhaseOffset.value = p.rainRippleSecondaryPhaseOffset;
    u.uRainStormStrengthPx.value = p.rainStormStrengthPx;
    u.uRainStormScale.value = p.rainStormScale;
    u.uRainStormSpeed.value = p.rainStormSpeed;
    u.uRainStormCurl.value = p.rainStormCurl;
    u.uRainStormRateBase.value = p.rainStormRateBase;
    u.uRainStormRateSpeedScale.value = p.rainStormRateSpeedScale;
    u.uRainStormSizeMin.value = p.rainStormSizeMin;
    u.uRainStormSizeMax.value = p.rainStormSizeMax;
    u.uRainStormWidthMinScale.value = p.rainStormWidthMinScale;
    u.uRainStormWidthMaxScale.value = p.rainStormWidthMaxScale;
    u.uRainStormDecay.value = p.rainStormDecay;
    u.uRainStormCoreWeight.value = p.rainStormCoreWeight;
    u.uRainStormRingWeight.value = p.rainStormRingWeight;
    u.uRainStormSwirlStrength.value = p.rainStormSwirlStrength;
    u.uRainStormMicroEnabled.value = p.rainStormMicroEnabled ? 1.0 : 0.0;
    u.uRainStormMicroStrength.value = p.rainStormMicroStrength;
    u.uRainStormMicroScale.value = p.rainStormMicroScale;
    u.uRainStormMicroSpeed.value = p.rainStormMicroSpeed;
    u.uRainMaxCombinedStrengthPx.value = p.rainMaxCombinedStrengthPx;

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
    u.uCausticsSharpness.value = p.causticsSharpness ?? 0.1;
    u.uCausticsEdgeLo.value = p.causticsEdgeLo ?? 0.11;
    u.uCausticsEdgeHi.value = p.causticsEdgeHi ?? 1.0;
    if (u.uCausticsBrightnessMaskEnabled) u.uCausticsBrightnessMaskEnabled.value = p.causticsBrightnessMaskEnabled ? 1.0 : 0.0;
    if (u.uCausticsBrightnessThreshold) u.uCausticsBrightnessThreshold.value = Number.isFinite(p.causticsBrightnessThreshold) ? Math.max(0.0, p.causticsBrightnessThreshold) : 0.55;
    if (u.uCausticsBrightnessSoftness) u.uCausticsBrightnessSoftness.value = Number.isFinite(p.causticsBrightnessSoftness) ? Math.max(0.0, p.causticsBrightnessSoftness) : 0.20;
    if (u.uCausticsBrightnessGamma) u.uCausticsBrightnessGamma.value = Number.isFinite(p.causticsBrightnessGamma) ? Math.max(0.01, p.causticsBrightnessGamma) : 1.0;

    // Sun direction from azimuth + elevation (cached to avoid per-frame trig)
    const az = p.specSunAzimuthDeg ?? 135;
    const el = p.specSunElevationDeg ?? 45;
    if (az !== this._cachedSunAzDeg || el !== this._cachedSunElDeg) {
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

    // ── Sand ──────────────────────────────────────────────────────────────
    // Gate sand with uniforms (never via defines) for runtime safety.
    const sandEnabled = !!p.sandEnabled;
    u.uSandIntensity.value = sandEnabled ? p.sandIntensity : 0.0;
    const sandColor = normalizeRgb01(p.sandColor, { r: 0.76, g: 0.68, b: 0.5 });
    u.uSandColor.value.set(sandColor.r, sandColor.g, sandColor.b);
    u.uSandContrast.value = p.sandContrast;
    // Very low scales produce extremely large "brick" blobs. Clamp to a
    // sane range defensively so out-of-date saved params can't break visuals.
    u.uSandChunkScale.value = Math.max(1.0, Math.min(60.0, p.sandChunkScale));
    u.uSandChunkSpeed.value = p.sandChunkSpeed;
    u.uSandGrainScale.value = Math.max(50.0, Math.min(12000.0, p.sandGrainScale));
    u.uSandGrainSpeed.value = p.sandGrainSpeed;
    if (u.uSandWindDriftScale) {
      const v = p.sandWindDriftScale;
      // Desired default: sand drift at ~50% of the global wind advection.
      u.uSandWindDriftScale.value = Number.isFinite(v) ? Math.max(0.0, Math.min(3.0, v)) : 0.5;
    }
    if (u.uSandLayeringEnabled) {
      u.uSandLayeringEnabled.value = (p.sandLayeringEnabled === true) ? 1.0 : 0.0;
    }
    if (u.uSandLayerScaleSpread) {
      const v = p.sandLayerScaleSpread;
      u.uSandLayerScaleSpread.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.5;
    }
    if (u.uSandLayerIntensitySpread) {
      const v = p.sandLayerIntensitySpread;
      u.uSandLayerIntensitySpread.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.65;
    }
    if (u.uSandLayerDriftSpread) {
      const v = p.sandLayerDriftSpread;
      u.uSandLayerDriftSpread.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.4;
    }
    if (u.uSandLayerEvolutionSpread) {
      const v = p.sandLayerEvolutionSpread;
      u.uSandLayerEvolutionSpread.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.5;
    }
    u.uSandBillowStrength.value = p.sandBillowStrength;
    u.uSandCoverage.value = p.sandCoverage;
    u.uSandChunkSoftness.value = p.sandChunkSoftness;
    u.uSandSpeckCoverage.value = p.sandSpeckCoverage;
    u.uSandSpeckSoftness.value = p.sandSpeckSoftness;
    u.uSandDepthLo.value = p.sandDepthLo;
    u.uSandDepthHi.value = p.sandDepthHi;
    u.uSandAnisotropy.value = p.sandAnisotropy;
    u.uSandDistortionStrength.value = p.sandDistortionStrength;
    u.uSandAdditive.value = sandEnabled ? p.sandAdditive : 0.0;

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
    const chromEnabled = !!p.chromaticAberrationEnabled;
    const definesKey = (flecksEnabled ? DEF_FOAM_FLECKS : 0)
      | (multiTapEnabled ? DEF_MULTITAP : 0)
      | (chromEnabled ? DEF_CHROM_AB : 0);

    if (definesKey !== this._lastDefinesKey) {
      const d = this._composeMaterial.defines || {};
      if (flecksEnabled) d.USE_FOAM_FLECKS = 1; else delete d.USE_FOAM_FLECKS;
      if (multiTapEnabled) d.USE_WATER_REFRACTION_MULTITAP = 1; else delete d.USE_WATER_REFRACTION_MULTITAP;
      if (chromEnabled) d.USE_WATER_CHROMATIC_ABERRATION = 1; else delete d.USE_WATER_CHROMATIC_ABERRATION;
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
    const murkColor = normalizeRgb01(p.murkColor, { r: 0.15, g: 0.22, b: 0.12 });
    const sandColor = normalizeRgb01(p.sandColor, { r: 0.76, g: 0.68, b: 0.5 });
    const sandEnabled = !!p.sandEnabled;

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
      uDistortionStrengthPx:   { value: p.distortionStrengthPx },
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
      uChromaticAberrationStrengthPx:  { value: p.chromaticAberrationStrengthPx },
      uChromaticAberrationEdgeCenter:  { value: p.chromaticAberrationEdgeCenter },
      uChromaticAberrationEdgeFeather: { value: p.chromaticAberrationEdgeFeather },
      uChromaticAberrationEdgeGamma:   { value: p.chromaticAberrationEdgeGamma },
      uChromaticAberrationEdgeMin:     { value: p.chromaticAberrationEdgeMin },

      // Distortion edge
      uDistortionEdgeCenter:    { value: p.distortionEdgeCenter },
      uDistortionEdgeFeather:   { value: p.distortionEdgeFeather },
      uDistortionEdgeGamma:     { value: p.distortionEdgeGamma },
      uDistortionShoreRemapLo:  { value: p.distortionShoreRemapLo },
      uDistortionShoreRemapHi:  { value: p.distortionShoreRemapHi },
      uDistortionShorePow:      { value: p.distortionShorePow },
      uDistortionShoreMin:      { value: p.distortionShoreMin },

      // Rain
      uRainEnabled:        { value: 0.0 },
      uRainPrecipitation:  { value: p.rainPrecipitation },
      uRainSplit:          { value: p.rainSplit },
      uRainBlend:          { value: p.rainBlend },
      uRainGlobalStrength: { value: p.rainGlobalStrength },
      tOutdoorsMask:       { value: fallbacks.white },
      uHasOutdoorsMask:    { value: 0.0 },
      uOutdoorsMaskFlipY:  { value: 0.0 },
      uRainIndoorDampingEnabled: { value: p.rainIndoorDampingEnabled ? 1.0 : 0.0 },
      uRainIndoorDampingStrength: { value: p.rainIndoorDampingStrength ?? 1.0 },
      uRainRippleStrengthPx:          { value: p.rainRippleStrengthPx },
      uRainRippleScale:               { value: p.rainRippleScale },
      uRainRippleSpeed:               { value: p.rainRippleSpeed },
      uRainRippleDensity:             { value: p.rainRippleDensity },
      uRainRippleSharpness:           { value: p.rainRippleSharpness },
      uRainRippleJitter:              { value: p.rainRippleJitter },
      uRainRippleRadiusMin:           { value: p.rainRippleRadiusMin },
      uRainRippleRadiusMax:           { value: p.rainRippleRadiusMax },
      uRainRippleWidthScale:          { value: p.rainRippleWidthScale },
      uRainRippleSecondaryEnabled:    { value: p.rainRippleSecondaryEnabled ? 1.0 : 0.0 },
      uRainRippleSecondaryStrength:   { value: p.rainRippleSecondaryStrength },
      uRainRippleSecondaryPhaseOffset: { value: p.rainRippleSecondaryPhaseOffset },
      uRainStormStrengthPx:    { value: p.rainStormStrengthPx },
      uRainStormScale:         { value: p.rainStormScale },
      uRainStormSpeed:         { value: p.rainStormSpeed },
      uRainStormCurl:          { value: p.rainStormCurl },
      uRainStormRateBase:      { value: p.rainStormRateBase },
      uRainStormRateSpeedScale: { value: p.rainStormRateSpeedScale },
      uRainStormSizeMin:       { value: p.rainStormSizeMin },
      uRainStormSizeMax:       { value: p.rainStormSizeMax },
      uRainStormWidthMinScale: { value: p.rainStormWidthMinScale },
      uRainStormWidthMaxScale: { value: p.rainStormWidthMaxScale },
      uRainStormDecay:         { value: p.rainStormDecay },
      uRainStormCoreWeight:    { value: p.rainStormCoreWeight },
      uRainStormRingWeight:    { value: p.rainStormRingWeight },
      uRainStormSwirlStrength: { value: p.rainStormSwirlStrength },
      uRainStormMicroEnabled:  { value: p.rainStormMicroEnabled ? 1.0 : 0.0 },
      uRainStormMicroStrength: { value: p.rainStormMicroStrength },
      uRainStormMicroScale:    { value: p.rainStormMicroScale },
      uRainStormMicroSpeed:    { value: p.rainStormMicroSpeed },
      uRainMaxCombinedStrengthPx: { value: p.rainMaxCombinedStrengthPx },

      // Wind
      uWindDir:      { value: new THREE.Vector2(1, 0) },
      uWindSpeed:    { value: 0.0 },
      uWindOffsetUv: { value: new THREE.Vector2(0, 0) },
      uWindTime:     { value: 0.0 },
      uLockWaveTravelToWind: { value: p.lockWaveTravelToWind ? 1.0 : 0.0 },
      uWaveDirOffsetRad:     { value: 0.0 },
      uWaveAppearanceRotRad: { value: 0.0 },

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
      tCloudShadow:         { value: fallbacks.white },
      uHasCloudShadow:      { value: 0.0 },
      uCloudShadowEnabled:  { value: p.cloudShadowEnabled ? 1.0 : 0.0 },
      uCloudShadowDarkenStrength: { value: p.cloudShadowDarkenStrength ?? 1.25 },
      uCloudShadowDarkenCurve: { value: p.cloudShadowDarkenCurve ?? 1.5 },
      uCloudShadowSpecularKill: { value: p.cloudShadowSpecularKill ?? 1.0 },
      uCloudShadowSpecularCurve: { value: p.cloudShadowSpecularCurve ?? 6.0 },

      // Caustics
      uCausticsEnabled:      { value: p.causticsEnabled ? 1.0 : 0.0 },
      uCausticsIntensity:    { value: p.causticsIntensity ?? 4.0 },
      uCausticsScale:        { value: p.causticsScale ?? 33.4 },
      uCausticsSpeed:        { value: p.causticsSpeed ?? 1.05 },
      uCausticsSharpness:    { value: p.causticsSharpness ?? 0.1 },
      uCausticsEdgeLo:       { value: p.causticsEdgeLo ?? 0.11 },
      uCausticsEdgeHi:       { value: p.causticsEdgeHi ?? 1.0 },
      uCausticsBrightnessMaskEnabled: { value: p.causticsBrightnessMaskEnabled ? 1.0 : 0.0 },
      uCausticsBrightnessThreshold:   { value: Number.isFinite(p.causticsBrightnessThreshold) ? Math.max(0.0, p.causticsBrightnessThreshold) : 0.55 },
      uCausticsBrightnessSoftness:    { value: Number.isFinite(p.causticsBrightnessSoftness) ? Math.max(0.0, p.causticsBrightnessSoftness) : 0.20 },
      uCausticsBrightnessGamma:       { value: Number.isFinite(p.causticsBrightnessGamma) ? Math.max(0.01, p.causticsBrightnessGamma) : 1.0 },

      // Foam
      uFoamColor:     { value: new THREE.Vector3(foamColor.r, foamColor.g, foamColor.b) },
      uFoamStrength:  { value: p.foamStrength },
      uFoamThreshold: { value: p.foamThreshold },
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

      // Sand
      uSandIntensity:          { value: sandEnabled ? p.sandIntensity : 0.0 },
      uSandColor:              { value: new THREE.Vector3(sandColor.r, sandColor.g, sandColor.b) },
      uSandContrast:           { value: p.sandContrast },
      uSandChunkScale:         { value: p.sandChunkScale },
      uSandChunkSpeed:         { value: p.sandChunkSpeed },
      uSandGrainScale:         { value: p.sandGrainScale },
      uSandGrainSpeed:         { value: p.sandGrainSpeed },
      uSandWindDriftScale:     { value: p.sandWindDriftScale ?? 0.5 },
      uSandLayeringEnabled:    { value: (p.sandLayeringEnabled === true) ? 1.0 : 0.0 },
      uSandLayerScaleSpread:   { value: p.sandLayerScaleSpread ?? 0.5 },
      uSandLayerIntensitySpread:{ value: p.sandLayerIntensitySpread ?? 0.65 },
      uSandLayerDriftSpread:   { value: p.sandLayerDriftSpread ?? 0.4 },
      uSandLayerEvolutionSpread:{ value: p.sandLayerEvolutionSpread ?? 0.5 },
      uSandBillowStrength:     { value: p.sandBillowStrength },
      uSandCoverage:           { value: p.sandCoverage },
      uSandChunkSoftness:      { value: p.sandChunkSoftness },
      uSandSpeckCoverage:      { value: p.sandSpeckCoverage },
      uSandSpeckSoftness:      { value: p.sandSpeckSoftness },
      uSandDepthLo:            { value: p.sandDepthLo },
      uSandDepthHi:            { value: p.sandDepthHi },
      uSandAnisotropy:         { value: p.sandAnisotropy },
      uSandDistortionStrength: { value: p.sandDistortionStrength },
      uSandAdditive:           { value: sandEnabled ? p.sandAdditive : 0.0 },

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
