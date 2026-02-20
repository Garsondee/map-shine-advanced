import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import { debugLoadingProfiler } from '../core/debug-loading-profiler.js';
import { WaterSurfaceModel } from './WaterSurfaceModel.js';
import { DistortionLayer } from './DistortionManager.js';
import { DepthShaderChunks } from './DepthShaderChunks.js';

const log = createLogger('WaterEffectV2');

function normalizeRgb01(c, fallback = { r: 0, g: 0, b: 0 }) {
  if (!c || typeof c !== 'object') return fallback;
  let r = (typeof c.r === 'number') ? c.r : fallback.r;
  let g = (typeof c.g === 'number') ? c.g : fallback.g;
  let b = (typeof c.b === 'number') ? c.b : fallback.b;
  const maxv = Math.max(r, g, b);
  if (maxv > 1.0) {
    r /= 255.0;
    g /= 255.0;
    b /= 255.0;
  }
  r = Math.max(0.0, Math.min(1.0, r));
  g = Math.max(0.0, Math.min(1.0, g));
  b = Math.max(0.0, Math.min(1.0, b));
  return { r, g, b };
}

// Pre-allocated NDC corner coordinates for frustum intersection (avoids per-frame allocations)
const _ndcCorners = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1]
];

// Bitmask flags for shader defines (avoids per-frame string allocations)
const DEF_SAND = 1 << 0;
const DEF_FOAM_FLECKS = 1 << 1;
const DEF_MULTITAP = 1 << 2;
const DEF_CHROM_AB = 1 << 3;

export class WaterEffectV2 extends EffectBase {
  constructor() {
    super('water', RenderLayers.POST_PROCESSING, 'low');

    this.priority = 80;
    this.alwaysRender = true;

    this.params = {
      tintStrength: 0.2,
      tintColor: { r: 0.1, g: 0.3, b: 0.48 },

      cloudShadowEnabled: true,
      cloudShadowDarkenStrength: 1.25,
      cloudShadowDarkenCurve: 1.5,
      cloudShadowSpecularKill: 1,
      cloudShadowSpecularCurve: 6,
      cloudShadowCausticsKill: 1,
      cloudShadowCausticsCurve: 0.1,

      maskChannel: 'luma',
      maskInvert: false,
      maskThreshold: 0.65,
      maskBlurRadius: 0.0,
      maskBlurPasses: 0,
      maskExpandPx: -0.3,
      buildResolution: 4096,
      sdfRangePx: 12,
      shoreWidthPx: 128,

      waveScale: 5,
      waveSpeed: 0.39,
      waveStrength: 2,

      // Wave texture enhancement controls
      // Domain warp reduces visible repetition across large water bodies.
      waveWarpLargeStrength: 0.31,
      waveWarpSmallStrength: 0.05,
      waveWarpMicroStrength: 0.005,
      waveWarpTimeSpeed: 0.25,

      // Slow evolution of wave "sea state" (alternating calmer/rougher).
      waveEvolutionEnabled: true,
      waveEvolutionSpeed: 0.23,
      waveEvolutionAmount: 0.49,
      waveEvolutionScale: 1.03,

      waveSpeedUseWind: true,
      waveSpeedWindMinFactor: 1,
      waveStrengthUseWind: true,
      waveStrengthWindMinFactor: 1,
      distortionStrengthPx: 11.36,

      // Refraction sampling controls
      refractionMultiTapEnabled: false,
      chromaticAberrationEnabled: true,
      chromaticAberrationStrengthPx: 2.57,
      chromaticAberrationEdgeCenter: 0.5,
      chromaticAberrationEdgeFeather: 0.1,
      chromaticAberrationEdgeGamma: 1,
      chromaticAberrationEdgeMin: 0.0,

      waveIndoorDampingEnabled: false,
      waveIndoorDampingStrength: 1.0,
      waveIndoorMinFactor: 0.05,

      // Distortion masking (shader-side; does not rebuild water data)
      distortionEdgeCenter: 0.504,
      distortionEdgeFeather: 0.07,
      distortionEdgeGamma: 1,
      distortionShoreRemapLo: 0.0,
      distortionShoreRemapHi: 1.0,
      distortionShorePow: 0.78,
      distortionShoreMin: 0.68,

      // Shoreline-only high-frequency distortion (fed into DistortionManager)
      shoreNoiseDistortionEnabled: true,
      shoreNoiseDistortionStrengthPx: 6.49,
      shoreNoiseDistortionFrequency: 474,
      shoreNoiseDistortionSpeed: 3.22,
      // Controls how quickly the noise fades out from the shore toward the interior.
      // Expressed in water mask "depth" (0..1): lower => thinner band near edges.
      shoreNoiseDistortionFadeLo: 0,
      shoreNoiseDistortionFadeHi: 1,

      // Curl noise produces divergence-free (swirling) turbulence — physically
      // correct fluid motion instead of generic TV-static noise. 0 = raw noise, 1 = full curl.
      shoreNoiseDistortionCurlStrength: 1,
      // Shore-perpendicular wave wash: simulates waves lapping in and receding
      // along the shoreline with compound wave frequencies.
      shoreNoiseDistortionWashStrength: 1,
      shoreNoiseDistortionWashSpeed: 1.97,

      // Rain-hit surface distortion (precipitation driven)
      rainDistortionEnabled: true,
      rainDistortionUseWeather: true,
      rainDistortionPrecipitationOverride: 0.0,
      rainDistortionSplit: 0.5,
      rainDistortionBlend: 0.25,
      rainDistortionGlobalStrength: 0.12,

      rainIndoorDampingEnabled: true,
      rainIndoorDampingStrength: 1.0,

      causticsEnabled: true,
      causticsIntensity: 4,
      causticsScale: 33.4,
      causticsSpeed: 1.05,
      causticsSharpness: 0.1,
      causticsEdgeLo: 0.11,
      causticsEdgeHi: 1,
      causticsEdgeBlurTexels: 0,

      causticsBrightnessMaskEnabled: true,
      causticsBrightnessThreshold: 0.36,
      causticsBrightnessSoftness: 0.55,
      causticsBrightnessGamma: 0.62,

      causticsDebug: false,
      causticsIgnoreLightGate: true,

      rainRippleStrengthPx: 64,
      rainRippleScale: 2000,
      rainRippleSpeed: 4.26,
      rainRippleDensity: 1,
      rainRippleSharpness: 2.41,

      // Rain ripple appearance (advanced)
      rainRippleJitter: 0.35,
      rainRippleRadiusMin: 0.03,
      rainRippleRadiusMax: 0.52,
      rainRippleWidthScale: 1.0,
      rainRippleSecondaryEnabled: true,
      rainRippleSecondaryStrength: 2,
      rainRippleSecondaryPhaseOffset: 0.37,

      rainStormStrengthPx: 64,
      rainStormScale: 2000,
      rainStormSpeed: 5,
      rainStormCurl: 0.37,

      // Heavy rain smash field (advanced)
      rainStormRateBase: 10,
      rainStormRateSpeedScale: 20,
      rainStormSizeMin: 0.422,
      rainStormSizeMax: 0.509,
      rainStormWidthMinScale: 0.896,
      rainStormWidthMaxScale: 0.853,
      rainStormDecay: 0.1,
      rainStormCoreWeight: 0.36,
      rainStormRingWeight: 0.95,
      rainStormSwirlStrength: 0.88,
      rainStormMicroEnabled: true,
      rainStormMicroStrength: 1.59,
      rainStormMicroScale: 0.85,
      rainStormMicroSpeed: 1.25,

      rainMaxCombinedStrengthPx: 45.4,

      lockWaveTravelToWind: false,
      waveDirOffsetDeg: -9,
      waveAppearanceOffsetDeg: 0.0,
      advectionDirOffsetDeg: 0.0,
      advectionSpeed: 4,
      windDirResponsiveness: 10,
      useTargetWindDirection: true,

      specStrength: 250,
      specPower: 1,

      specSunAzimuthDeg: 44,
      specSunElevationDeg: 84,
      specSunIntensity: 5,
      specNormalStrength: 5,
      specNormalScale: 0.25,
      specRoughnessMin: 0.001,
      specRoughnessMax: 0.882,
      specF0: 0.12,
      specMaskGamma: 3.12,
      specSkyTint: 1,
      specShoreBias: 1,

      specDistortionNormalStrength: 2,
      specAnisotropy: 0.16,
      specAnisoRatio: 3.05,

      foamStrength: 0,
      foamThreshold: 0.84,
      foamScale: 2000,
      foamColor: { r: 6, g: 6, b: 5 },
      foamSpeed: 0.06,

      foamCurlStrength: 1,
      foamCurlScale: 6.1,
      foamCurlSpeed: 0.07,

      foamBreakupStrength1: 1,
      foamBreakupScale1: 1,
      foamBreakupSpeed1: 0.04,

      foamBreakupStrength2: 1,
      foamBreakupScale2: 13.5,
      foamBreakupSpeed2: 0.32,

      foamBlackPoint: 0,
      foamWhitePoint: 1,
      foamGamma: 1.06,
      foamContrast: 1.58,
      foamBrightness: -0.01,

      floatingFoamStrength: 0.46,
      floatingFoamCoverage: 0.2,
      floatingFoamScale: 10.5,
      floatingFoamWaveDistortion: 0.88,

      // foam.webp particle systems (WeatherParticles)
      shoreFoamEnabled: true,
      shoreFoamIntensity: 2.5,

      foamPlumeEnabled: true,
      foamPlumeSpawnMode: 'waterEdge',
      foamPlumeMaxParticles: 20000,
      foamPlumeEmissionBase: 199.6,
      foamPlumeEmissionWindScale: 1500,
      foamPlumeLifeMin: 1.96,
      foamPlumeLifeMax: 9.02,
      foamPlumeSizeMin: 10.6,
      foamPlumeSizeMax: 30,
      foamPlumeOpacity: 0,
      foamPlumePeakOpacity: 0.6,
      foamPlumePeakTime: 0.12,
      foamPlumeStartScale: 1.19,
      foamPlumeMaxScale: 6.5,
      foamPlumeSpinMin: -5,
      foamPlumeSpinMax: 5,
      foamPlumeWindDriftScale: 0.84,
      foamPlumeUseAdditive: true,
      foamPlumeAdditiveBoost: 0.01,
      foamPlumeColor: { r: 1.0, g: 1.0, b: 1.0 },

      foamPlumeRandomOpacityMin: 0.96,
      foamPlumeRandomOpacityMax: 5,

      foamPlumeRadialAlphaEnabled: true,
      foamPlumeRadialInnerPos: 0.0,
      foamPlumeRadialMidPos: 0.184,
      foamPlumeRadialInnerOpacity: 5,
      foamPlumeRadialMidOpacity: 5,
      foamPlumeRadialOuterOpacity: 5,
      foamPlumeRadialCurve: 4,

      // Foam plume GPU curl distortion controls (WeatherParticles vertex shader)
      foamPlumeCurlDisplaceEnabled: true,
      foamPlumeCurlDisplaceUv: 0.0078,
      foamPlumeCurlAmount: 0.3,
      foamPlumeCurlStrengthMultiplier: 1.78,
      foamPlumeCurlScaleMultiplier: 4,
      foamPlumeCurlSpeedMultiplier: 0.04,
      foamPlumeCurlDirectionality: 1,
      foamPlumeCurlDerivativeEpsilon: 0.2,
      foamPlumeCurlLacunarity: 4,
      foamPlumeCurlGain: 0.42,
      foamPlumeCurlOctave1Weight: 4,
      foamPlumeCurlOctave2Weight: 1.128,
      foamPlumeCurlOctave3Weight: 0.563,
      foamPlumeCurlOctave4Weight: 0,
      foamPlumeCurlWindOffsetInfluence: 1.67,
      foamPlumeCurlWindAdvection: 2.8,
      foamPlumeCurlMaxUv: 0.25,

      // Large-scale noise masking for foam.webp particles (break up / intermittent reveal)
      foamParticleNoiseEnabled: true,
      foamParticleNoiseStrength: 0.14,
      foamParticleNoiseScale: 14.3,
      foamParticleNoiseSpeed: 0,
      foamParticleNoiseCoverage: 0.56,
      foamParticleNoiseSoftness: 0.5,
      foamParticleNoiseAttempts: 4,

      // Secondary noise masking for foam.webp particles (typically smaller scale)
      foamParticleNoise2Enabled: true,
      foamParticleNoise2Strength: 1,
      foamParticleNoise2Scale: 35.7,
      foamParticleNoise2Speed: 0.35,
      foamParticleNoise2Coverage: 0.75,
      foamParticleNoise2Softness: 0.06,

      // Simple foam.webp spawner (WeatherParticles)
      simpleFoamEnabled: true,
      simpleFoamThreshold: 0.96,
      simpleFoamStride: 3,
      simpleFoamMaxPoints: 2040,
      simpleFoamDebugFlipV: false,

      // GPU foam flecks (high-frequency spray dots)
      foamFlecksEnabled: false,
      foamFlecksIntensity: 6,
      foamFlecksWindDriftScale: 1.0,

      murkEnabled: true,
      murkIntensity: 0.5,
      murkColor: { r: 48.874935150146484, g: 32.11777191167764, b: 0 },
      murkScale: 8.81,
      murkSpeed: 0.33,
      murkDepthFade: 0.74,
      murkDepthLo: 0.03,
      murkDepthHi: 1,

      murkGrainScale: 6000,
      murkGrainSpeed: 1.02,
      murkGrainStrength: 1.73,
      murkOcclusionStrength: 1,
      murkOcclusionSoftness: 1,
      murkContrast: 4,

      sandEnabled: true,
      sandIntensity: 0.12,
      sandColor: { r: 0, g: 0, b: 0 },
      sandContrast: 0.25,
      sandChunkScale: 5.4,
      sandChunkSpeed: 0.3,
      sandGrainScale: 400,
      sandGrainSpeed: 1.81,
      sandBillowStrength: 0.24,

      sandCoverage: 1,
      sandChunkSoftness: 0.12,
      sandSpeckCoverage: 1,
      sandSpeckSoftness: 0.39,
      sandDepthLo: 0.23,
      sandDepthHi: 1,
      sandAnisotropy: 0.54,
      sandDistortionStrength: 0.01,
      sandAdditive: 0,

      debugView: 0
    };

    this.renderToScreen = false;

    this.baseMesh = null;
    this.waterMask = null;

    this._surfaceModel = new WaterSurfaceModel();
    this._waterData = null;
    this._waterRawMask = null;
    this._lastWaterMaskUuid = null;
    this._lastWaterMaskCacheKey = null;
    this._waterMaskImageIds = new WeakMap();
    this._nextWaterMaskImageId = 1;

    // Floor transition lock. When true, ALL water destruction paths are
    // blocked: clearCaches(), setBaseMesh() no-water path, and
    // _rebuildWaterDataIfNeeded(). This prevents any external code path
    // (Foundry hooks, tile-manager debounce, async timing races) from
    // destroying valid ground-floor water during a level switch.
    //
    // Lifecycle:
    //   Set to true:  synchronously at mapShineLevelContextChanged hook entry
    //   Set to false: synchronously after redistribution completes (or on error)
    //
    // See docs/planning/MULTI-LEVEL-RENDERING-ARCHITECTURE.md Phase 0.
    this._floorTransitionActive = false;

    // EffectMaskRegistry subscription. When connected, the registry is the
    // authoritative source for the water mask texture. The subscription
    // callback handles mask replacement and preserve-across-floors logic.
    // @type {function|null} Unsubscribe function returned by registry.subscribe()
    this._registryUnsub = null;

    this._quadScene = null;
    this._quadCamera = null;
    this._quadMesh = null;

    // Wind is used to drive pattern advection and wave phase. If we respond equally
    // fast to rising and falling wind, the wave "boost" decays unnaturally quickly.
    // We apply asymmetric smoothing: fast attack, slow release.
    this._smoothedWindSpeed01 = 0.0;
    this._material = null;

    this._readBuffer = null;
    this._writeBuffer = null;
    this._inputTexture = null;

    this._waterOccluderAlpha = null;

    this._viewBounds = null;
    this._sceneDimensions = null;
    this._sceneRect = null;

    this._lastCamera = null;

    this._tempNdc = null;
    this._tempWorld = null;
    this._tempDir = null;

    this._smoothedWindDir = null;

    this._tempWindTarget = null;
    this._windOffsetUv = null;
    this._windTime = 0.0;

    this._lastTimeValue = null;
    this._timeStallFrames = 0;
    this._timeStallLogged = false;

    // First-render diagnostics: tracks whether we've logged shader compile stats.
    this._firstRenderDone = false;

    /** @type {number} */
    this._lastDefinesKey = 0;
    this._lastWaterDataTexW = 0;
    this._lastWaterDataTexH = 0;

    this._tempSize = null;

    // Param-sync optimization: only push static uniforms when params change.
    this._paramsDirty = true;
    this._paramsProxyRoot = null;
    this._paramsProxyCache = new WeakMap();

    // Cached trigonometry for advection angle offset (avoids per-frame sin/cos).
    this._cachedAdvectionDirOffsetDeg = null;
    this._cachedAdvectionDirCos = 1.0;
    this._cachedAdvectionDirSin = 0.0;

    // Cached specular sun-angle trigonometry (azimuth/elevation).
    this._cachedSpecSunAzimuthDeg = null;
    this._cachedSpecSunElevationDeg = null;
    this._cachedSpecSunDirX = 0.0;
    this._cachedSpecSunDirY = 0.0;
    this._cachedSpecSunDirZ = 1.0;

    // DistortionManager payload sync bookkeeping.
    this._lastDistortionWaterDataTexture = null;

    this._installParamsProxy();

    this._distortionWaterParams = {
      maskFlipY: 0.0,
      maskUseAlpha: 0.0,
      edgeSoftnessTexels: 0.0,

      murkEnabled: true,
      murkIntensity: 0.85,
      murkColor: { r: 0.25, g: 0.18, b: 0.12 },
      murkScale: 3.5,
      murkSpeed: 0.15,
      murkDepthLo: 0,
      murkDepthHi: 1,
      murkGrainScale: 3200,
      murkGrainSpeed: 0.9,
      murkGrainStrength: 0.4,
      murkOcclusionStrength: 0.38,
      murkOcclusionSoftness: 0.09,

      shoreNoiseEnabled: true,
      shoreNoiseStrengthPx: 12.75,
      shoreNoiseFrequency: 526.1,
      shoreNoiseSpeed: 4.31,
      shoreNoiseFadeLo: 0.112,
      shoreNoiseFadeHi: 0.601,
      shoreNoiseCurlStrength: 0.45,
      shoreNoiseWashStrength: 0.51,
      shoreNoiseWashSpeed: 0.8,

      causticsEnabled: true,
      causticsIntensity: 4,
      causticsScale: 33.4,
      causticsSpeed: 1.05,
      causticsSharpness: 0.1,
      causticsEdgeLo: 0.11,
      causticsEdgeHi: 1.0,
      causticsEdgeBlurTexels: 0.0,

      causticsBrightnessMaskEnabled: true,
      causticsBrightnessThreshold: 0.36,
      causticsBrightnessSoftness: 0.55,
      causticsBrightnessGamma: 0.62,
    };
  }

  _createParamsProxyObject(target) {
    if (!target || typeof target !== 'object') return target;
    const cached = this._paramsProxyCache.get(target);
    if (cached) return cached;

    const proxy = new Proxy(target, {
      get: (obj, prop) => {
        const value = obj[prop];
        if (!value || typeof value !== 'object') return value;
        return this._createParamsProxyObject(value);
      },
      set: (obj, prop, value) => {
        if (obj[prop] === value) return true;
        obj[prop] = value;
        this._paramsDirty = true;
        return true;
      },
      deleteProperty: (obj, prop) => {
        if (!(prop in obj)) return true;
        delete obj[prop];
        this._paramsDirty = true;
        return true;
      }
    });

    this._paramsProxyCache.set(target, proxy);
    return proxy;
  }

  _installParamsProxy() {
    if (!this.params || typeof this.params !== 'object') return;
    this._paramsProxyCache = new WeakMap();
    this._paramsProxyRoot = this._createParamsProxyObject(this.params);
    this.params = this._paramsProxyRoot;
  }

  _ensureParamsProxy() {
    if (!this.params || typeof this.params !== 'object') return;
    if (this.params === this._paramsProxyRoot) return;
    this._installParamsProxy();
    this._paramsDirty = true;
  }

  clearCaches() {
    // Force cached water data to rebuild when the underlying mask changes.
    //
    // BLOCKED during floor transitions. The _floorTransitionActive lock
    // prevents ALL water destruction regardless of the calling code path
    // (TileManager debounce, Foundry hooks, async timing races, etc.).
    // This replaces the previous suppress flag + UUID guard approach.
    if (this._floorTransitionActive) return;

    try {
      this._surfaceModel?.dispose?.();
    } catch (_) {
    }

    this._waterData = null;
    this._waterRawMask = null;
    this._lastWaterMaskUuid = null;
    this._lastWaterMaskCacheKey = null;
    this._lastWaterDataTexW = 0;
    this._lastWaterDataTexH = 0;

    try {
      const mm = window.MapShine?.maskManager;
      if (mm && typeof mm.setTexture === 'function') {
        mm.setTexture('water.data', null);
      }
    } catch (_) {
    }

    // Rebuild immediately if possible so the next frame has valid data.
    try {
      this._rebuildWaterDataIfNeeded(true);
    } catch (_) {
    }
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'appearance',
          label: 'Appearance',
          type: 'folder',
          expanded: false,
          parameters: [
            'tintStrength',
            'tintColor'
          ]
        },
        {
          name: 'tools',
          label: 'Tools',
          type: 'folder',
          expanded: false,
          parameters: [
            'clearCaches'
          ]
        },
        {
          name: 'mask-shoreline',
          label: 'Mask & Shoreline',
          type: 'folder',
          expanded: false,
          parameters: [
            'maskChannel',
            'maskInvert',
            'maskThreshold',
            'maskBlurRadius',
            'maskBlurPasses',
            'maskExpandPx',

            'buildResolution',
            'sdfRangePx',
            'shoreWidthPx'
          ]
        },
        {
          name: 'waves',
          label: 'Waves',
          type: 'folder',
          expanded: false,
          parameters: [
            'waveScale',
            'waveSpeed',
            'waveStrength',

            'waveWarpLargeStrength',
            'waveWarpSmallStrength',
            'waveWarpMicroStrength',
            'waveWarpTimeSpeed',

            'waveEvolutionEnabled',
            'waveEvolutionSpeed',
            'waveEvolutionAmount',
            'waveEvolutionScale',

            'waveIndoorDampingEnabled',
            'waveIndoorDampingStrength',
            'waveIndoorMinFactor'
          ]
        },
        {
          name: 'wind-flow',
          label: 'Wind & Flow',
          type: 'folder',
          expanded: false,
          parameters: [
            'waveSpeedUseWind',
            'waveSpeedWindMinFactor',
            'waveStrengthUseWind',
            'waveStrengthWindMinFactor',

            'lockWaveTravelToWind',
            'useTargetWindDirection',
            'windDirResponsiveness',

            'waveDirOffsetDeg',
            'waveAppearanceOffsetDeg',
            'advectionDirOffsetDeg',
            'advectionSpeed'
          ]
        },
        {
          name: 'refraction-distortion',
          label: 'Refraction & Distortion',
          type: 'folder',
          expanded: false,
          parameters: [
            'distortionStrengthPx',

            'shoreNoiseDistortionEnabled',
            'shoreNoiseDistortionStrengthPx',
            'shoreNoiseDistortionFrequency',
            'shoreNoiseDistortionSpeed',
            'shoreNoiseDistortionFadeLo',
            'shoreNoiseDistortionFadeHi',
            'shoreNoiseDistortionCurlStrength',
            'shoreNoiseDistortionWashStrength',
            'shoreNoiseDistortionWashSpeed',

            'refractionMultiTapEnabled',
            'chromaticAberrationEnabled',
            'chromaticAberrationStrengthPx',
            'chromaticAberrationEdgeCenter',
            'chromaticAberrationEdgeFeather',
            'chromaticAberrationEdgeGamma',
            'chromaticAberrationEdgeMin'
          ]
        },
        {
          name: 'distortion-masking',
          label: 'Distortion Masking',
          type: 'folder',
          expanded: false,
          parameters: [
            'distortionEdgeCenter',
            'distortionEdgeFeather',
            'distortionEdgeGamma',
            'distortionShoreRemapLo',
            'distortionShoreRemapHi',
            'distortionShorePow',
            'distortionShoreMin'
          ]
        },
        {
          name: 'specular',
          label: 'Specular',
          type: 'folder',
          expanded: false,
          parameters: [
            'specStrength',
            'specPower'
          ]
        },
        {
          name: 'specular-advanced',
          label: 'Specular (Advanced)',
          type: 'folder',
          expanded: false,
          parameters: [
            'specSunAzimuthDeg',
            'specSunElevationDeg',
            'specSunIntensity',
            'specNormalStrength',
            'specNormalScale',
            'specRoughnessMin',
            'specRoughnessMax',
            'specF0',
            'specMaskGamma',
            'specSkyTint',
            'specShoreBias',
            'specDistortionNormalStrength',
            'specAnisotropy',
            'specAnisoRatio'
          ]
        },
        {
          name: 'foam-surface',
          label: 'Foam (Surface)',
          type: 'folder',
          expanded: false,
          parameters: [
            'foamStrength',
            'foamColor',
            'foamThreshold',
            'foamScale',
            'foamSpeed',

            'foamCurlStrength',
            'foamCurlScale',
            'foamCurlSpeed',

            'foamBreakupStrength1',
            'foamBreakupScale1',
            'foamBreakupSpeed1',
            'foamBreakupStrength2',
            'foamBreakupScale2',
            'foamBreakupSpeed2',

            'foamBlackPoint',
            'foamWhitePoint',
            'foamGamma',
            'foamContrast',
            'foamBrightness',

            'floatingFoamStrength',
            'floatingFoamCoverage',
            'floatingFoamScale',
            'floatingFoamWaveDistortion'
          ]
        },
        {
          name: 'sand',
          label: 'Sand / Sediment',
          type: 'folder',
          expanded: false,
          parameters: [
            'sandEnabled',
            'sandIntensity',
            'sandColor',
            'sandContrast',
            'sandChunkScale',
            'sandChunkSpeed',
            'sandGrainScale',
            'sandGrainSpeed',
            'sandBillowStrength',
            'sandCoverage',
            'sandChunkSoftness',
            'sandSpeckCoverage',
            'sandSpeckSoftness',
            'sandDepthLo',
            'sandDepthHi',
            'sandAnisotropy',
            'sandDistortionStrength',
            'sandAdditive'
          ]
        },
        {
          name: 'rain-distortion',
          label: 'Rain Distortion (Precipitation)',
          type: 'folder',
          expanded: false,
          parameters: [
            'rainDistortionEnabled',
            'rainDistortionUseWeather',
            'rainDistortionPrecipitationOverride',
            'rainDistortionGlobalStrength',
            'rainDistortionSplit',
            'rainDistortionBlend',

            'rainIndoorDampingEnabled',
            'rainIndoorDampingStrength',

            'rainRippleStrengthPx',
            'rainRippleScale',
            'rainRippleSpeed',
            'rainRippleDensity',
            'rainRippleSharpness',

            'rainRippleJitter',
            'rainRippleRadiusMin',
            'rainRippleRadiusMax',
            'rainRippleWidthScale',
            'rainRippleSecondaryEnabled',
            'rainRippleSecondaryStrength',
            'rainRippleSecondaryPhaseOffset',

            'rainStormStrengthPx',
            'rainStormScale',
            'rainStormSpeed',
            'rainStormCurl',

            'rainStormRateBase',
            'rainStormRateSpeedScale',
            'rainStormSizeMin',
            'rainStormSizeMax',
            'rainStormWidthMinScale',
            'rainStormWidthMaxScale',
            'rainStormDecay',
            'rainStormCoreWeight',
            'rainStormRingWeight',
            'rainStormSwirlStrength',
            'rainStormMicroEnabled',
            'rainStormMicroStrength',
            'rainStormMicroScale',
            'rainStormMicroSpeed',

            'rainMaxCombinedStrengthPx'
          ]
        },
        {
          name: 'caustics',
          label: 'Caustics (Underwater)',
          type: 'folder',
          expanded: false,
          parameters: [
            'causticsEnabled',
            'causticsIntensity',
            'causticsScale',
            'causticsSpeed',
            'causticsSharpness',
            'causticsEdgeLo',
            'causticsEdgeHi',
            'causticsEdgeBlurTexels',

            'causticsBrightnessMaskEnabled',
            'causticsBrightnessThreshold',
            'causticsBrightnessSoftness',
            'causticsBrightnessGamma',

            'causticsDebug',
            'causticsIgnoreLightGate'
          ]
        },
        {
          name: 'cloud-shadows-water',
          label: 'Cloud Shadows',
          type: 'folder',
          expanded: false,
          parameters: [
            'cloudShadowEnabled',
            'cloudShadowDarkenStrength',
            'cloudShadowDarkenCurve',
            'cloudShadowSpecularKill',
            'cloudShadowSpecularCurve',
            'cloudShadowCausticsKill',
            'cloudShadowCausticsCurve'
          ]
        },
        {
          name: 'foam-particles',
          label: 'Foam Particles (foam.webp)',
          type: 'folder',
          expanded: false,
          parameters: [
            'shoreFoamEnabled',
            'shoreFoamIntensity',

            'foamPlumeEnabled',
            'foamPlumeSpawnMode',
            'foamPlumeMaxParticles',
            'foamPlumeEmissionBase',
            'foamPlumeEmissionWindScale',
            'foamPlumeLifeMin',
            'foamPlumeLifeMax',
            'foamPlumeSizeMin',
            'foamPlumeSizeMax',
            'foamPlumeOpacity',
            'foamPlumePeakOpacity',
            'foamPlumePeakTime',
            'foamPlumeStartScale',
            'foamPlumeMaxScale',
            'foamPlumeSpinMin',
            'foamPlumeSpinMax',
            'foamPlumeWindDriftScale',
            'foamPlumeUseAdditive',
            'foamPlumeAdditiveBoost',
            'foamPlumeColor',

            'foamPlumeRandomOpacityMin',
            'foamPlumeRandomOpacityMax',

            'foamPlumeRadialAlphaEnabled',
            'foamPlumeRadialInnerPos',
            'foamPlumeRadialMidPos',
            'foamPlumeRadialInnerOpacity',
            'foamPlumeRadialMidOpacity',
            'foamPlumeRadialOuterOpacity',
            'foamPlumeRadialCurve'
          ]
        },
        {
          name: 'foam-particle-noise-controls',
          label: 'Foam Particles -> Foam Noise Controls',
          type: 'folder',
          expanded: false,
          parameters: [
            'foamPlumeCurlDisplaceEnabled',
            'foamPlumeCurlDisplaceUv',
            'foamPlumeCurlAmount',
            'foamPlumeCurlStrengthMultiplier',
            'foamPlumeCurlScaleMultiplier',
            'foamPlumeCurlSpeedMultiplier',
            'foamPlumeCurlDirectionality',
            'foamPlumeCurlDerivativeEpsilon',
            'foamPlumeCurlLacunarity',
            'foamPlumeCurlGain',
            'foamPlumeCurlOctave1Weight',
            'foamPlumeCurlOctave2Weight',
            'foamPlumeCurlOctave3Weight',
            'foamPlumeCurlOctave4Weight',
            'foamPlumeCurlWindOffsetInfluence',
            'foamPlumeCurlWindAdvection',
            'foamPlumeCurlMaxUv',

            'foamParticleNoiseEnabled',
            'foamParticleNoiseStrength',
            'foamParticleNoiseScale',
            'foamParticleNoiseSpeed',
            'foamParticleNoiseCoverage',
            'foamParticleNoiseSoftness',
            'foamParticleNoiseAttempts',

            'foamParticleNoise2Enabled',
            'foamParticleNoise2Strength',
            'foamParticleNoise2Scale',
            'foamParticleNoise2Speed',
            'foamParticleNoise2Coverage',
            'foamParticleNoise2Softness'
          ]
        },
        {
          name: 'foam-simple-spawner',
          label: 'Simple Foam Spawner (Debug)',
          type: 'folder',
          expanded: true,
          parameters: [
            'simpleFoamEnabled',
            'simpleFoamThreshold',
            'simpleFoamStride',
            'simpleFoamMaxPoints',
            'simpleFoamDebugFlipV'
          ]
        },
        {
          name: 'foam-spray',
          label: 'Foam Spray (GPU)',
          type: 'folder',
          expanded: false,
          parameters: [
            'foamFlecksEnabled',
            'foamFlecksIntensity',
            'foamFlecksWindDriftScale'
          ]
        },
        {
          name: 'murkiness',
          label: 'Murkiness (Silt / Mud)',
          type: 'folder',
          expanded: false,
          parameters: [
            'murkEnabled',
            'murkIntensity',
            'murkColor',
            'murkScale',
            'murkSpeed',
            'murkDepthFade',
            'murkDepthLo',
            'murkDepthHi',
            'murkGrainScale',
            'murkGrainSpeed',
            'murkGrainStrength',
            'murkOcclusionStrength',
            'murkOcclusionSoftness',
            'murkContrast'
          ]
        },
        {
          name: 'debug',
          label: 'Debug',
          type: 'folder',
          expanded: false,
          parameters: [
            'debugView'
          ]
        }
      ],
      parameters: {
        clearCaches: {
          type: 'button',
          title: '🧹 Clear Water Caches',
          default: false,
          hidden: false
        },
        enabled: {
          type: 'boolean',
          default: true,
          hidden: true
        },
        tintStrength: { type: 'slider', label: 'Tint Strength', min: 0, max: 1, step: 0.01, default: 0.2 },
        tintColor: { type: 'color', label: 'Tint Color', default: { r: 0.1, g: 0.3, b: 0.48 } },

        cloudShadowEnabled: { type: 'boolean', label: 'Enabled', default: true },
        cloudShadowDarkenStrength: { type: 'slider', label: 'Darken Strength', min: 0.0, max: 2.0, step: 0.01, default: 1.25 },
        cloudShadowDarkenCurve: { type: 'slider', label: 'Darken Curve', min: 0.1, max: 6.0, step: 0.01, default: 1.5 },
        cloudShadowSpecularKill: { type: 'slider', label: 'Specular Kill', min: 0.0, max: 1.0, step: 0.01, default: 1 },
        cloudShadowSpecularCurve: { type: 'slider', label: 'Spec Kill Curve', min: 0.1, max: 6.0, step: 0.01, default: 6 },
        cloudShadowCausticsKill: { type: 'slider', label: 'Caustics Kill', min: 0.0, max: 1.0, step: 0.01, default: 1 },
        cloudShadowCausticsCurve: { type: 'slider', label: 'Caustics Kill Curve', min: 0.1, max: 6.0, step: 0.01, default: 0.1 },

        maskChannel: {
          type: 'list',
          label: 'Mask Channel',
          options: {
            Auto: 'auto',
            Red: 'r',
            Alpha: 'a',
            Luma: 'luma'
          },
          default: 'luma'
        },
        maskInvert: { type: 'boolean', label: 'Invert Mask', default: false },
        maskThreshold: { type: 'slider', label: 'Mask Threshold', min: 0.0, max: 1.0, step: 0.01, default: 0.87, throttle: 50 },
        maskBlurRadius: { type: 'slider', label: 'Mask Blur Radius (px)', min: 0.0, max: 16.0, step: 0.1, default: 0.0, throttle: 50 },
        maskBlurPasses: { type: 'slider', label: 'Mask Blur Passes', min: 0, max: 6, step: 1, default: 0, throttle: 50 },
        maskExpandPx: { type: 'slider', label: 'Mask Expand/Contract (px)', min: -64.0, max: 64.0, step: 0.25, default: 0, throttle: 50 },

        buildResolution: { type: 'list', label: 'Build Resolution', options: { 256: 256, 512: 512, 1024: 1024, 2048: 2048, 4096: 4096 }, default: 4096 },
        sdfRangePx: { type: 'slider', label: 'SDF Range (px)', min: 8, max: 256, step: 1, default: 70, throttle: 50 },
        shoreWidthPx: { type: 'slider', label: 'Shore Width (px)', min: 1, max: 128, step: 1, default: 128, throttle: 50 },

        waveScale: { type: 'slider', label: 'Wave Scale', min: 1, max: 60, step: 0.5, default: 6 },
        waveSpeed: { type: 'slider', label: 'Wave Speed', min: 0, max: 2.0, step: 0.01, default: 0.78 },
        waveStrength: { type: 'slider', label: 'Wave Strength', min: 0, max: 2.0, step: 0.01, default: 0.81 },

        waveWarpLargeStrength: { type: 'slider', label: 'Warp Large', min: 0.0, max: 1.0, step: 0.01, default: 0.18 },
        waveWarpSmallStrength: { type: 'slider', label: 'Warp Small', min: 0.0, max: 0.5, step: 0.01, default: 0.07 },
        waveWarpMicroStrength: { type: 'slider', label: 'Warp Micro', min: 0.0, max: 0.25, step: 0.005, default: 0.02 },
        waveWarpTimeSpeed: { type: 'slider', label: 'Warp Time Speed', min: 0.0, max: 0.25, step: 0.005, default: 0.065 },

        waveEvolutionEnabled: { type: 'boolean', label: 'Sea State Evolution', default: true },
        waveEvolutionSpeed: { type: 'slider', label: 'Evolution Speed', min: 0.0, max: 0.5, step: 0.005, default: 0.5 },
        waveEvolutionAmount: { type: 'slider', label: 'Evolution Amount', min: 0.0, max: 1.0, step: 0.01, default: 1 },
        waveEvolutionScale: { type: 'slider', label: 'Evolution Scale', min: 0.01, max: 2.0, step: 0.01, default: 1.03 },
        waveSpeedUseWind: { type: 'boolean', label: 'Wave Speed Linked To Wind', default: true },
        waveSpeedWindMinFactor: { type: 'slider', label: 'Wave Speed @ Wind=0', min: 0.0, max: 1.0, step: 0.01, default: 0.2 },
        waveStrengthUseWind: { type: 'boolean', label: 'Wave Strength Linked To Wind', default: true },
        waveStrengthWindMinFactor: { type: 'slider', label: 'Wave Strength @ Wind=0', min: 0.0, max: 1.0, step: 0.01, default: 1 },
        distortionStrengthPx: { type: 'slider', label: 'Distortion Strength (px)', min: 0, max: 64.0, step: 0.01, default: 14.84 },

        shoreNoiseDistortionEnabled: { type: 'boolean', label: 'Shore Noise Enabled', default: true },
        shoreNoiseDistortionStrengthPx: { type: 'slider', label: 'Shore Noise Strength (px)', min: 0.0, max: 64.0, step: 0.01, default: 12.75 },
        shoreNoiseDistortionFrequency: { type: 'slider', label: 'Shore Noise Frequency', min: 0.1, max: 1200.0, step: 0.1, default: 526.1 },
        shoreNoiseDistortionSpeed: { type: 'slider', label: 'Shore Noise Speed', min: 0.0, max: 5.0, step: 0.01, default: 4.31 },
        shoreNoiseDistortionFadeLo: { type: 'slider', label: 'Shore Noise Fade Lo', min: 0.0, max: 1.0, step: 0.001, default: 0.112 },
        shoreNoiseDistortionFadeHi: { type: 'slider', label: 'Shore Noise Fade Hi', min: 0.0, max: 1.0, step: 0.001, default: 0.601 },
        shoreNoiseDistortionCurlStrength: { type: 'slider', label: 'Curl Turbulence', min: 0.0, max: 1.0, step: 0.01, default: 0.45 },
        shoreNoiseDistortionWashStrength: { type: 'slider', label: 'Wave Wash Strength', min: 0.0, max: 1.0, step: 0.01, default: 0.51 },
        shoreNoiseDistortionWashSpeed: { type: 'slider', label: 'Wave Wash Speed', min: 0.0, max: 5.0, step: 0.01, default: 0.8 },

        refractionMultiTapEnabled: { type: 'boolean', label: 'Refraction Multi-Tap (Blur)', default: false },
        chromaticAberrationEnabled: { type: 'boolean', label: 'Chromatic Aberration (RGB Shift)', default: true },
        chromaticAberrationStrengthPx: { type: 'slider', label: 'RGB Shift Strength (px)', min: 0.0, max: 6.0, step: 0.01, default: 1.78 },
        chromaticAberrationEdgeCenter: { type: 'slider', label: 'RGB Edge Center', min: 0.0, max: 1.0, step: 0.001, default: 0.5 },
        chromaticAberrationEdgeFeather: { type: 'slider', label: 'RGB Edge Feather', min: 0.0, max: 0.2, step: 0.001, default: 0.1 },
        chromaticAberrationEdgeGamma: { type: 'slider', label: 'RGB Edge Gamma', min: 0.05, max: 4.0, step: 0.01, default: 1 },
        chromaticAberrationEdgeMin: { type: 'slider', label: 'RGB Edge Min', min: 0.0, max: 1.0, step: 0.01, default: 0.0 },

        waveIndoorDampingEnabled: { type: 'boolean', label: 'Dampen Indoors (_Outdoors)', default: false },
        waveIndoorDampingStrength: { type: 'slider', label: 'Indoor Damp Strength', min: 0.0, max: 1.0, step: 0.01, default: 1.0 },
        waveIndoorMinFactor: { type: 'slider', label: 'Indoor Min Factor', min: 0.0, max: 1.0, step: 0.01, default: 0.05 },

        distortionEdgeCenter: { type: 'slider', label: 'Edge Center', min: 0.0, max: 1.0, step: 0.001, default: 0.504 },
        distortionEdgeFeather: { type: 'slider', label: 'Edge Feather', min: 0.0, max: 0.2, step: 0.001, default: 0.07 },
        distortionEdgeGamma: { type: 'slider', label: 'Edge Gamma', min: 0.05, max: 4.0, step: 0.01, default: 1 },
        distortionShoreRemapLo: { type: 'slider', label: 'Shore Start', min: 0.0, max: 1.0, step: 0.01, default: 0.0 },
        distortionShoreRemapHi: { type: 'slider', label: 'Shore End', min: 0.0, max: 1.0, step: 0.01, default: 1.0 },
        distortionShorePow: { type: 'slider', label: 'Shore Curve', min: 0.05, max: 6.0, step: 0.01, default: 0.78 },
        distortionShoreMin: { type: 'slider', label: 'Shore Min', min: 0.0, max: 1.0, step: 0.01, default: 0.68 },

        rainDistortionEnabled: { type: 'boolean', label: 'Enabled', default: true },
        rainDistortionUseWeather: { type: 'boolean', label: 'Use Weather Precipitation', default: true },
        rainDistortionPrecipitationOverride: { type: 'slider', label: 'Precipitation Override', min: 0.0, max: 1.0, step: 0.01, default: 0.0 },
        rainDistortionSplit: { type: 'slider', label: 'Ripple→Storm Split', min: 0.0, max: 1.0, step: 0.01, default: 0.5 },
        rainDistortionBlend: { type: 'slider', label: 'Blend Width', min: 0.0, max: 0.25, step: 0.005, default: 0.25 },
        rainDistortionGlobalStrength: { type: 'slider', label: 'Global Strength', min: 0.0, max: 2.0, step: 0.01, default: 1.14 },

        rainIndoorDampingEnabled: { type: 'boolean', label: 'Dampen Indoors (_Outdoors)', default: true },
        rainIndoorDampingStrength: { type: 'slider', label: 'Indoor Damp Strength', min: 0.0, max: 1.0, step: 0.01, default: 1.0 },

        rainRippleStrengthPx: { type: 'slider', label: 'Ripple Strength (px)', min: 0.0, max: 64.0, step: 0.01, default: 64.0 },
        rainRippleScale: { type: 'slider', label: 'Ripple Scale', min: 1.0, max: 2000.0, step: 1.0, default: 269.0 },
        rainRippleSpeed: { type: 'slider', label: 'Ripple Speed', min: 0.0, max: 10.0, step: 0.01, default: 4.26 },
        rainRippleDensity: { type: 'slider', label: 'Ripple Density', min: 0.0, max: 1.0, step: 0.01, default: 1.0 },
        rainRippleSharpness: { type: 'slider', label: 'Ripple Sharpness', min: 0.1, max: 5.0, step: 0.01, default: 2.41 },

        rainRippleJitter: { type: 'slider', label: 'Ripple Jitter', min: 0.0, max: 1.0, step: 0.01, default: 0.35 },
        rainRippleRadiusMin: { type: 'slider', label: 'Ripple Radius Min', min: 0.0, max: 0.5, step: 0.001, default: 0.03 },
        rainRippleRadiusMax: { type: 'slider', label: 'Ripple Radius Max', min: 0.05, max: 0.95, step: 0.001, default: 0.52 },
        rainRippleWidthScale: { type: 'slider', label: 'Ripple Width Scale', min: 0.1, max: 3.0, step: 0.01, default: 1.0 },
        rainRippleSecondaryEnabled: { type: 'boolean', label: 'Secondary Ring', default: true },
        rainRippleSecondaryStrength: { type: 'slider', label: 'Secondary Strength', min: 0.0, max: 2.0, step: 0.01, default: 2 },
        rainRippleSecondaryPhaseOffset: { type: 'slider', label: 'Secondary Phase Offset', min: 0.0, max: 1.0, step: 0.01, default: 0.37 },

        rainStormStrengthPx: { type: 'slider', label: 'Storm Strength (px)', min: 0.0, max: 64.0, step: 0.01, default: 64 },
        rainStormScale: { type: 'slider', label: 'Storm Scale', min: 1.0, max: 2000.0, step: 1.0, default: 204 },
        rainStormSpeed: { type: 'slider', label: 'Storm Speed', min: 0.0, max: 10.0, step: 0.01, default: 5 },
        rainStormCurl: { type: 'slider', label: 'Swirl / Chaos', min: 0.0, max: 3.0, step: 0.01, default: 0.3 },

        rainStormRateBase: { type: 'slider', label: 'Impact Rate Base', min: 0.0, max: 10.0, step: 0.01, default: 10 },
        rainStormRateSpeedScale: { type: 'slider', label: 'Impact Rate vs Speed', min: 0.0, max: 20.0, step: 0.01, default: 20 },
        rainStormSizeMin: { type: 'slider', label: 'Impact Size Min', min: 0.01, max: 1.0, step: 0.001, default: 0.422 },
        rainStormSizeMax: { type: 'slider', label: 'Impact Size Max', min: 0.01, max: 1.0, step: 0.001, default: 0.509 },
        rainStormWidthMinScale: { type: 'slider', label: 'Ring Width Min', min: 0.01, max: 1.0, step: 0.001, default: 0.896 },
        rainStormWidthMaxScale: { type: 'slider', label: 'Ring Width Max', min: 0.01, max: 1.0, step: 0.001, default: 0.853 },
        rainStormDecay: { type: 'slider', label: 'Impact Decay', min: 0.1, max: 20.0, step: 0.01, default: 0.1 },
        rainStormCoreWeight: { type: 'slider', label: 'Core Weight', min: 0.0, max: 2.0, step: 0.01, default: 0.36 },
        rainStormRingWeight: { type: 'slider', label: 'Ring Weight', min: 0.0, max: 2.0, step: 0.01, default: 0.95 },
        rainStormSwirlStrength: { type: 'slider', label: 'Swirl Strength', min: 0.0, max: 2.0, step: 0.01, default: 0.88 },
        rainStormMicroEnabled: { type: 'boolean', label: 'Micro Chop', default: true },
        rainStormMicroStrength: { type: 'slider', label: 'Micro Strength', min: 0.0, max: 2.0, step: 0.01, default: 1.59 },
        rainStormMicroScale: { type: 'slider', label: 'Micro Scale', min: 0.01, max: 5.0, step: 0.01, default: 0.85 },
        rainStormMicroSpeed: { type: 'slider', label: 'Micro Speed', min: 0.0, max: 10.0, step: 0.01, default: 1.25 },

        causticsEnabled: { type: 'boolean', label: 'Caustics Enabled', default: true },
        causticsIntensity: { type: 'slider', label: 'Caustics Intensity', min: 0.0, max: 4.0, step: 0.01, default: 4 },
        causticsScale: { type: 'slider', label: 'Caustics Scale', min: 0.1, max: 200.0, step: 0.1, default: 33.4 },
        causticsSpeed: { type: 'slider', label: 'Caustics Speed', min: 0.0, max: 5.0, step: 0.01, default: 1.05 },
        causticsSharpness: { type: 'slider', label: 'Caustics Sharpness', min: 0.1, max: 10.0, step: 0.01, default: 0.1 },
        causticsEdgeLo: { type: 'slider', label: 'Caustics Edge Lo', min: 0.0, max: 1.0, step: 0.01, default: 0.11 },
        causticsEdgeHi: { type: 'slider', label: 'Caustics Edge Hi', min: 0.0, max: 1.0, step: 0.01, default: 1 },
        causticsEdgeBlurTexels: { type: 'slider', label: 'Caustics Edge Blur (texels)', min: 0.0, max: 64.0, step: 0.5, default: 0 },

        causticsBrightnessMaskEnabled: { type: 'boolean', label: 'Brightness Mask', default: true },
        causticsBrightnessThreshold: { type: 'slider', label: 'Brightness Threshold', min: 0.0, max: 2.0, step: 0.01, default: 0.36 },
        causticsBrightnessSoftness: { type: 'slider', label: 'Brightness Softness', min: 0.0, max: 1.0, step: 0.01, default: 0.55 },
        causticsBrightnessGamma: { type: 'slider', label: 'Brightness Gamma', min: 0.1, max: 4.0, step: 0.01, default: 0.62 },

        causticsDebug: { type: 'boolean', label: 'Debug View (Mask/Shoreline)', default: false },
        causticsIgnoreLightGate: { type: 'boolean', label: 'Ignore Light Gate (Force)', default: true },

        lockWaveTravelToWind: { type: 'boolean', label: 'Lock Wave Travel To Wind', default: false },
        waveDirOffsetDeg: { type: 'slider', label: 'Wave Travel Dir Offset (deg)', min: -180.0, max: 180.0, step: 1.0, default: -42 },
        waveAppearanceOffsetDeg: { type: 'slider', label: 'Wave Facing Offset (deg)', min: -180.0, max: 180.0, step: 1.0, default: 0.0 },
        advectionDirOffsetDeg: { type: 'slider', label: 'Advection Dir Offset (deg)', min: -180.0, max: 180.0, step: 1.0, default: 0.0 },
        advectionSpeed: { type: 'slider', label: 'Advection Speed', min: 0.0, max: 4.0, step: 0.01, default: 0.51 },
        windDirResponsiveness: { type: 'slider', label: 'Wind Dir Responsiveness', min: 0.1, max: 10.0, step: 0.1, default: 10 },
        useTargetWindDirection: { type: 'boolean', label: 'Use Target Wind Dir', default: true },

        specStrength: { type: 'slider', label: 'Specular Strength', min: 0, max: 250.0, step: 0.01, default: 250 },
        specPower: { type: 'slider', label: 'Specular Power', min: 1, max: 24, step: 0.5, default: 1.5 },

        specSunAzimuthDeg: { type: 'slider', label: 'Sun Azimuth (deg)', min: 0.0, max: 360.0, step: 1.0, default: 12 },
        specSunElevationDeg: { type: 'slider', label: 'Sun Elevation (deg)', min: 1.0, max: 90.0, step: 1.0, default: 79 },
        specSunIntensity: { type: 'slider', label: 'Sun Intensity', min: 0.0, max: 5.0, step: 0.01, default: 4.08 },
        specNormalStrength: { type: 'slider', label: 'Normal Strength', min: 0.0, max: 5.0, step: 0.01, default: 5 },
        specNormalScale: { type: 'slider', label: 'Normal Scale', min: 0.0, max: 0.25, step: 0.001, default: 0.25 },
        specRoughnessMin: { type: 'slider', label: 'Roughness Min', min: 0.001, max: 1.0, step: 0.001, default: 0.001 },
        specRoughnessMax: { type: 'slider', label: 'Roughness Max', min: 0.001, max: 1.0, step: 0.001, default: 1 },
        specF0: { type: 'slider', label: 'F0 (Reflectance)', min: 0.0, max: 0.12, step: 0.001, default: 0.069 },
        specMaskGamma: { type: 'slider', label: 'Mask Gamma', min: 0.1, max: 6.0, step: 0.01, default: 2.6 },
        specSkyTint: { type: 'slider', label: 'Sky Tint', min: 0.0, max: 1.0, step: 0.01, default: 0.6 },
        specShoreBias: { type: 'slider', label: 'Shore Bias', min: 0.0, max: 1.0, step: 0.01, default: 1 },

        specDistortionNormalStrength: { type: 'slider', label: 'Distortion→Normal', min: 0.0, max: 2.0, step: 0.01, default: 2 },
        specAnisotropy: { type: 'slider', label: 'Anisotropy', min: 0.0, max: 1.0, step: 0.01, default: 0.16 },
        specAnisoRatio: { type: 'slider', label: 'Aniso Ratio', min: 1.0, max: 8.0, step: 0.01, default: 3.05 },

        foamStrength: { type: 'slider', label: 'Foam Strength', min: 0, max: 1.0, step: 0.01, default: 0.09 },
        foamColor: { type: 'color', label: 'Foam Color', default: { r: 6, g: 6, b: 5 } },
        foamThreshold: { type: 'slider', label: 'Foam Width', min: 0.0, max: 1.0, step: 0.01, default: 0.84 },
        foamScale: { type: 'slider', label: 'Foam Grain Scale', min: 1.0, max: 2000.0, step: 1.0, default: 2000 },
        foamSpeed: { type: 'slider', label: 'Foam Speed', min: 0.0, max: 1.5, step: 0.01, default: 0.19 },

        foamCurlStrength: { type: 'slider', label: 'Foam Curl Strength', min: 0.0, max: 1.0, step: 0.01, default: 1 },
        foamCurlScale: { type: 'slider', label: 'Foam Curl Scale', min: 0.1, max: 30.0, step: 0.1, default: 3 },
        foamCurlSpeed: { type: 'slider', label: 'Foam Curl Speed', min: 0.0, max: 1.0, step: 0.01, default: 0.09 },

        foamBreakupStrength1: { type: 'slider', label: 'Foam Breakup 1 Strength', min: 0.0, max: 1.0, step: 0.01, default: 1 },
        foamBreakupScale1: { type: 'slider', label: 'Foam Breakup 1 Scale', min: 0.1, max: 200.0, step: 0.1, default: 1 },
        foamBreakupSpeed1: { type: 'slider', label: 'Foam Breakup 1 Speed', min: 0.0, max: 1.0, step: 0.01, default: 0.04 },
        foamBreakupStrength2: { type: 'slider', label: 'Foam Breakup 2 Strength', min: 0.0, max: 1.0, step: 0.01, default: 1 },
        foamBreakupScale2: { type: 'slider', label: 'Foam Breakup 2 Scale', min: 0.1, max: 100.0, step: 0.1, default: 17 },
        foamBreakupSpeed2: { type: 'slider', label: 'Foam Breakup 2 Speed', min: 0.0, max: 1.0, step: 0.01, default: 0.32 },

        foamBlackPoint: { type: 'slider', label: 'Foam Black Point', min: 0.0, max: 1.0, step: 0.01, default: 0 },
        foamWhitePoint: { type: 'slider', label: 'Foam White Point', min: 0.0, max: 1.0, step: 0.01, default: 1 },
        foamGamma: { type: 'slider', label: 'Foam Gamma', min: 0.1, max: 4.0, step: 0.01, default: 1.06 },
        foamContrast: { type: 'slider', label: 'Foam Contrast', min: 0.0, max: 3.0, step: 0.01, default: 0.87 },
        foamBrightness: { type: 'slider', label: 'Foam Brightness', min: -1.0, max: 1.0, step: 0.01, default: -0.01 },

        floatingFoamStrength: { type: 'slider', label: 'Floating Foam Strength', min: 0.0, max: 1.0, step: 0.01, default: 0.8 },
        floatingFoamCoverage: { type: 'slider', label: 'Floating Foam Coverage', min: 0.0, max: 1.0, step: 0.01, default: 0.09 },
        floatingFoamScale: { type: 'slider', label: 'Floating Foam Scale', min: 1, max: 200, step: 0.5, default: 34.5 },
        floatingFoamWaveDistortion: { type: 'slider', label: 'Wave Distortion', min: 0.0, max: 2.0, step: 0.01, default: 2 },

        shoreFoamEnabled: { type: 'boolean', label: 'Foam Particles Enabled', default: true },
        shoreFoamIntensity: { type: 'slider', label: 'Foam Particles Intensity', min: 0.0, max: 6.0, step: 0.01, default: 6 },

        foamPlumeEnabled: { type: 'boolean', label: 'Plume Enabled', default: true },
        foamPlumeSpawnMode: {
          type: 'list',
          label: 'Plume Spawn Mode',
          options: {
            WaterEdge: 'waterEdge',
            Shoreline: 'shoreline'
          },
          default: 'waterEdge'
        },
        
        foamPlumeMaxParticles: { type: 'slider', label: 'Plume Max Particles', min: 0, max: 20000, step: 1, default: 8681 },
        foamPlumeEmissionBase: { type: 'slider', label: 'Plume Emission Base', min: 0.0, max: 500.0, step: 0.1, default: 500 },
        foamPlumeEmissionWindScale: { type: 'slider', label: 'Plume Emission Wind Scale', min: 0.0, max: 1500.0, step: 0.1, default: 1500 },
        foamPlumeLifeMin: { type: 'slider', label: 'Plume Life Min', min: 0.01, max: 10.0, step: 0.01, default: 4.13 },
        foamPlumeLifeMax: { type: 'slider', label: 'Plume Life Max', min: 0.01, max: 10.0, step: 0.01, default: 4.67 },
        foamPlumeSizeMin: { type: 'slider', label: 'Plume Size Min', min: 0.1, max: 500.0, step: 0.1, default: 15 },
        foamPlumeSizeMax: { type: 'slider', label: 'Plume Size Max', min: 0.1, max: 700.0, step: 0.1, default: 36.1 },
        foamPlumeOpacity: { type: 'slider', label: 'Plume Opacity', min: 0.0, max: 2.0, step: 0.01, default: 0.3 },
        foamPlumePeakOpacity: { type: 'slider', label: 'Plume Peak Opacity', min: 0.0, max: 2.0, step: 0.01, default: 0.04 },
        foamPlumePeakTime: { type: 'slider', label: 'Plume Peak Time', min: 0.01, max: 0.6, step: 0.01, default: 0.12 },
        foamPlumeStartScale: { type: 'slider', label: 'Plume Start Scale', min: 0.01, max: 5.0, step: 0.01, default: 1.24 },
        foamPlumeMaxScale: { type: 'slider', label: 'Plume Max Scale', min: 0.01, max: 10.0, step: 0.01, default: 10 },
        foamPlumeSpinMin: { type: 'slider', label: 'Plume Spin Min', min: -5.0, max: 5.0, step: 0.01, default: -0.14 },
        foamPlumeSpinMax: { type: 'slider', label: 'Plume Spin Max', min: -5.0, max: 5.0, step: 0.01, default: 0.19 },
        foamPlumeWindDriftScale: { type: 'slider', label: 'Plume Wind Drift', min: 0.0, max: 3.0, step: 0.01, default: 0.25 },
        foamPlumeUseAdditive: { type: 'boolean', label: 'Plume Additive Blend', default: true },
        foamPlumeAdditiveBoost: { type: 'slider', label: 'Plume Additive Boost', min: 0.0, max: 20.0, step: 0.01, default: 1.68 },
        foamPlumeColor: { type: 'color', label: 'Plume Color', default: { r: 1.0, g: 1.0, b: 1.0 } },

        foamPlumeRandomOpacityMin: { type: 'slider', label: 'Plume Random Opacity Min', min: 0.0, max: 5.0, step: 0.01, default: 2.06 },
        foamPlumeRandomOpacityMax: { type: 'slider', label: 'Plume Random Opacity Max', min: 0.0, max: 5.0, step: 0.01, default: 2.99 },

        foamPlumeRadialAlphaEnabled: { type: 'boolean', label: 'Plume Radial Opacity Enabled', default: true },
        foamPlumeRadialInnerPos: { type: 'slider', label: 'Plume Radial Inner Pos', min: 0.0, max: 1.0, step: 0.001, default: 0.0 },
        foamPlumeRadialMidPos: { type: 'slider', label: 'Plume Radial Mid Pos', min: 0.0, max: 1.0, step: 0.001, default: 0.149 },
        foamPlumeRadialInnerOpacity: { type: 'slider', label: 'Plume Radial Inner Opacity', min: 0.0, max: 5.0, step: 0.01, default: 5 },
        foamPlumeRadialMidOpacity: { type: 'slider', label: 'Plume Radial Mid Opacity', min: 0.0, max: 5.0, step: 0.01, default: 0.81 },
        foamPlumeRadialOuterOpacity: { type: 'slider', label: 'Plume Radial Outer Opacity', min: 0.0, max: 5.0, step: 0.01, default: 0.27 },
        foamPlumeRadialCurve: { type: 'slider', label: 'Plume Radial Curve', min: 0.1, max: 4.0, step: 0.01, default: 0.1 },

        foamPlumeCurlDisplaceEnabled: { type: 'boolean', label: 'Distortion Enabled', default: true },
        foamPlumeCurlDisplaceUv: { type: 'slider', label: 'Distortion Strength (UV)', min: 0.0, max: 0.08, step: 0.0001, default: 0.0147 },
        foamPlumeCurlAmount: { type: 'slider', label: 'Overall Distortion Amount', min: 0.0, max: 4.0, step: 0.01, default: 0.56 },
        foamPlumeCurlStrengthMultiplier: { type: 'slider', label: 'Surface Curl Strength Multiplier', min: 0.0, max: 4.0, step: 0.01, default: 0.21 },
        foamPlumeCurlScaleMultiplier: { type: 'slider', label: 'Surface Curl Scale Multiplier', min: 0.05, max: 4.0, step: 0.01, default: 4 },
        foamPlumeCurlSpeedMultiplier: { type: 'slider', label: 'Surface Curl Speed Multiplier', min: 0.0, max: 4.0, step: 0.01, default: 1.87 },
        foamPlumeCurlDirectionality: { type: 'slider', label: 'Directionality (0=Raw, 1=Normalized)', min: 0.0, max: 1.0, step: 0.01, default: 1 },
        foamPlumeCurlDerivativeEpsilon: { type: 'slider', label: 'Derivative Epsilon', min: 0.001, max: 0.2, step: 0.001, default: 0.059 },
        foamPlumeCurlLacunarity: { type: 'slider', label: 'Octave Lacunarity', min: 1.01, max: 4.0, step: 0.01, default: 1.69 },
        foamPlumeCurlGain: { type: 'slider', label: 'Octave Gain', min: 0.0, max: 1.0, step: 0.01, default: 1 },
        foamPlumeCurlOctave1Weight: { type: 'slider', label: 'Octave 1 Weight', min: 0.0, max: 4.0, step: 0.001, default: 0.388 },
        foamPlumeCurlOctave2Weight: { type: 'slider', label: 'Octave 2 Weight', min: 0.0, max: 4.0, step: 0.001, default: 0.301 },
        foamPlumeCurlOctave3Weight: { type: 'slider', label: 'Octave 3 Weight', min: 0.0, max: 4.0, step: 0.001, default: 0.33275 },
        foamPlumeCurlOctave4Weight: { type: 'slider', label: 'Octave 4 Weight', min: 0.0, max: 4.0, step: 0.001, default: 0.183 },
        foamPlumeCurlWindOffsetInfluence: { type: 'slider', label: 'Wind Offset Influence', min: 0.0, max: 2.0, step: 0.01, default: 0.5 },
        foamPlumeCurlWindAdvection: { type: 'slider', label: 'Wind Advection Influence', min: 0.0, max: 3.0, step: 0.01, default: 1.0 },
        foamPlumeCurlMaxUv: { type: 'slider', label: 'Max Distortion Clamp (UV)', min: 0.0, max: 0.25, step: 0.0005, default: 0.046 },

        foamParticleNoiseEnabled: { type: 'boolean', label: 'Cutout Noise (Large) Enabled', default: true },
        foamParticleNoiseStrength: { type: 'slider', label: 'Cutout Noise (Large) Strength', min: 0.0, max: 1.0, step: 0.01, default: 0.14 },
        foamParticleNoiseScale: { type: 'slider', label: 'Cutout Noise (Large) Scale', min: 0.1, max: 120.0, step: 0.1, default: 14.3 },
        foamParticleNoiseSpeed: { type: 'slider', label: 'Cutout Noise (Large) Evolution Speed', min: 0.0, max: 5.0, step: 0.01, default: 0 },
        foamParticleNoiseCoverage: { type: 'slider', label: 'Cutout Noise (Large) Coverage', min: 0.0, max: 1.0, step: 0.01, default: 0.81 },
        foamParticleNoiseSoftness: { type: 'slider', label: 'Cutout Noise (Large) Softness', min: 0.0, max: 0.5, step: 0.005, default: 0.5 },
        foamParticleNoiseAttempts: { type: 'slider', label: 'Cutout Noise Spawn Attempts', min: 1, max: 8, step: 1, default: 4 },

        foamParticleNoise2Enabled: { type: 'boolean', label: 'Cutout Noise (Small) Enabled', default: true },
        foamParticleNoise2Strength: { type: 'slider', label: 'Cutout Noise (Small) Strength', min: 0.0, max: 1.0, step: 0.01, default: 1 },
        foamParticleNoise2Scale: { type: 'slider', label: 'Cutout Noise (Small) Scale', min: 0.1, max: 300.0, step: 0.1, default: 35.7 },
        foamParticleNoise2Speed: { type: 'slider', label: 'Cutout Noise (Small) Evolution Speed', min: 0.0, max: 10.0, step: 0.01, default: 0.35 },
        foamParticleNoise2Coverage: { type: 'slider', label: 'Cutout Noise (Small) Coverage', min: 0.0, max: 1.0, step: 0.01, default: 0.75 },
        foamParticleNoise2Softness: { type: 'slider', label: 'Cutout Noise (Small) Softness', min: 0.0, max: 0.5, step: 0.005, default: 0.06 },

        simpleFoamEnabled: { type: 'boolean', label: 'Enable Simple Spawner', default: true },
        simpleFoamThreshold: { type: 'slider', label: 'Spawn Threshold', min: 0.01, max: 1.0, step: 0.01, default: 0.96 },
        simpleFoamStride: { type: 'slider', label: 'Scan Stride', min: 1, max: 32, step: 1, default: 3 },
        simpleFoamMaxPoints: { type: 'number', label: 'Max Points', min: 10, max: 50000, step: 10, default: 2040 },
        simpleFoamDebugFlipV: { type: 'boolean', label: 'Debug Flip V', default: false },

        foamFlecksEnabled: { type: 'boolean', label: 'Foam Flecks (GPU)', default: false },
        foamFlecksIntensity: { type: 'slider', label: 'Flecks Intensity', min: 0.0, max: 6.0, step: 0.01, default: 6 },
        foamFlecksWindDriftScale: { type: 'slider', label: 'Wind Drift Scale', min: 0.0, max: 3.0, step: 0.01, default: 1.0 },

        murkEnabled: { type: 'boolean', label: 'Enabled', default: true },
        murkIntensity: { type: 'slider', label: 'Intensity', min: 0.0, max: 2.0, step: 0.01, default: 0.85 },
        murkColor: { type: 'color', label: 'Color', default: { r: 0.25, g: 0.18, b: 0.12 } },
        murkScale: { type: 'slider', label: 'Cloud Scale', min: 0.1, max: 12.0, step: 0.01, default: 3.5 },
        murkSpeed: { type: 'slider', label: 'Cloud Speed', min: 0.0, max: 2.0, step: 0.01, default: 0.15 },
        murkDepthFade: { type: 'slider', label: 'Depth Fade', min: 0.1, max: 4.0, step: 0.01, default: 1.2 },
        murkDepthLo: { type: 'slider', label: 'Depth Lo', min: 0.0, max: 1.0, step: 0.01, default: 0 },
        murkDepthHi: { type: 'slider', label: 'Depth Hi', min: 0.0, max: 1.0, step: 0.01, default: 1 },
        murkGrainScale: { type: 'slider', label: 'Grain Scale', min: 10.0, max: 6000.0, step: 1.0, default: 3200 },
        murkGrainSpeed: { type: 'slider', label: 'Grain Speed', min: 0.0, max: 3.0, step: 0.01, default: 0.9 },
        murkGrainStrength: { type: 'slider', label: 'Grain Strength', min: 0.0, max: 2.0, step: 0.01, default: 0.4 },
        murkOcclusionStrength: { type: 'slider', label: 'Occlusion Strength', min: 0.0, max: 1.0, step: 0.01, default: 0.38 },
        murkOcclusionSoftness: { type: 'slider', label: 'Occlusion Softness', min: 0.0, max: 1.0, step: 0.01, default: 0.09 },
        murkContrast: { type: 'slider', label: 'Contrast', min: 0.25, max: 4.0, step: 0.01, default: 4 },

        sandEnabled: { type: 'boolean', label: 'Sand Enabled', default: true },
        sandIntensity: { type: 'slider', label: 'Sand Intensity', min: 0.0, max: 1.0, step: 0.01, default: 0.12 },
        sandColor: { type: 'color', label: 'Sand Color', default: { r: 0, g: 0, b: 0 } },
        sandContrast: { type: 'slider', label: 'Sand Contrast', min: 0.25, max: 4.0, step: 0.01, default: 0.25 },
        sandChunkScale: { type: 'slider', label: 'Sand Chunk Scale', min: 0.1, max: 20.0, step: 0.1, default: 5.4 },
        sandChunkSpeed: { type: 'slider', label: 'Sand Chunk Speed', min: 0.0, max: 3.0, step: 0.01, default: 0.3 },
        sandGrainScale: { type: 'slider', label: 'Sand Grain Scale', min: 10.0, max: 400.0, step: 1.0, default: 400 },
        sandGrainSpeed: { type: 'slider', label: 'Sand Grain Speed', min: 0.0, max: 5.0, step: 0.01, default: 1.81 },
        sandBillowStrength: { type: 'slider', label: 'Sand Billow Strength', min: 0.0, max: 1.0, step: 0.01, default: 0.24 },

        sandCoverage: { type: 'slider', label: 'Sand Coverage', min: 0.0, max: 1.0, step: 0.01, default: 1 },
        sandChunkSoftness: { type: 'slider', label: 'Sand Chunk Softness', min: 0.01, max: 0.5, step: 0.01, default: 0.12 },
        sandSpeckCoverage: { type: 'slider', label: 'Sand Speck Coverage', min: 0.0, max: 1.0, step: 0.01, default: 1 },
        sandSpeckSoftness: { type: 'slider', label: 'Sand Speck Softness', min: 0.01, max: 0.5, step: 0.01, default: 0.39 },
        sandDepthLo: { type: 'slider', label: 'Sand Depth Lo', min: 0.0, max: 1.0, step: 0.01, default: 0.23 },
        sandDepthHi: { type: 'slider', label: 'Sand Depth Hi', min: 0.0, max: 1.0, step: 0.01, default: 1 },
        sandAnisotropy: { type: 'slider', label: 'Sand Anisotropy', min: 0.0, max: 1.0, step: 0.01, default: 0.54 },
        sandDistortionStrength: { type: 'slider', label: 'Sand Distortion Strength', min: 0.0, max: 1.0, step: 0.01, default: 0.01 },
        sandAdditive: { type: 'slider', label: 'Sand Additive', min: 0.0, max: 0.5, step: 0.01, default: 0 },

        debugView: {
          type: 'list',
          options: {
            None: 0,
            RawMask: 1,
            FinalMask: 2,
            SDF: 3,
            Exposure: 4,
            Normal: 5,
            Wave: 6,
            Distortion: 7,
            Occluder: 8,
            Time: 9,
            Sand: 10,
            FoamMask: 11
          },
          default: 0
        }
      }
    };

  }

  initialize(renderer, scene, camera) {
    const THREE = window.THREE;
    if (!THREE) throw new Error('three.js not available');

    this._quadScene = new THREE.Scene();
    this._quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._viewBounds = new THREE.Vector4(0, 0, 1, 1);
    this._sceneDimensions = new THREE.Vector2(1, 1);
    this._sceneRect = new THREE.Vector4(0, 0, 1, 1);

    const tint = this.params?.tintColor || { r: 0.1, g: 0.3, b: 0.48 };

    this._material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tNoiseMap: { value: null },
        tWaterData: { value: null },
        uHasWaterData: { value: 0.0 },
        uWaterEnabled: { value: this.enabled ? 1.0 : 0.0 },

        tWaterRawMask: { value: null },
        uHasWaterRawMask: { value: 0.0 },

        tWaterOccluderAlpha: { value: this._waterOccluderAlpha },
        uHasWaterOccluderAlpha: { value: this._waterOccluderAlpha ? 1.0 : 0.0 },

        uWaterDataTexelSize: { value: new THREE.Vector2(1.0 / 1024.0, 1.0 / 1024.0) },

        uTintColor: { value: new THREE.Color(tint.r, tint.g, tint.b) },
        uTintStrength: { value: this.params.tintStrength },

        uWaveScale: { value: this.params.waveScale },
        uWaveSpeed: { value: this.params.waveSpeed },
        uWaveStrength: { value: this.params.waveStrength },
        uDistortionStrengthPx: { value: this.params.distortionStrengthPx },

        uWaveWarpLargeStrength: { value: this.params.waveWarpLargeStrength },
        uWaveWarpSmallStrength: { value: this.params.waveWarpSmallStrength },
        uWaveWarpMicroStrength: { value: this.params.waveWarpMicroStrength },
        uWaveWarpTimeSpeed: { value: this.params.waveWarpTimeSpeed },

        uWaveEvolutionEnabled: { value: this.params.waveEvolutionEnabled === false ? 0.0 : 1.0 },
        uWaveEvolutionSpeed: { value: this.params.waveEvolutionSpeed },
        uWaveEvolutionAmount: { value: this.params.waveEvolutionAmount },
        uWaveEvolutionScale: { value: this.params.waveEvolutionScale },

        uChromaticAberrationStrengthPx: { value: this.params.chromaticAberrationStrengthPx },
        uChromaticAberrationEdgeCenter: { value: this.params.chromaticAberrationEdgeCenter },
        uChromaticAberrationEdgeFeather: { value: this.params.chromaticAberrationEdgeFeather },
        uChromaticAberrationEdgeGamma: { value: this.params.chromaticAberrationEdgeGamma },
        uChromaticAberrationEdgeMin: { value: this.params.chromaticAberrationEdgeMin },

        uWaveIndoorDampingEnabled: { value: this.params.waveIndoorDampingEnabled === false ? 0.0 : 1.0 },
        uWaveIndoorDampingStrength: { value: this.params.waveIndoorDampingStrength },
        uWaveIndoorMinFactor: { value: this.params.waveIndoorMinFactor },

        // Distortion masking controls
        uDistortionEdgeCenter: { value: this.params.distortionEdgeCenter },
        uDistortionEdgeFeather: { value: this.params.distortionEdgeFeather },
        uDistortionEdgeGamma: { value: this.params.distortionEdgeGamma },
        uDistortionShoreRemapLo: { value: this.params.distortionShoreRemapLo },
        uDistortionShoreRemapHi: { value: this.params.distortionShoreRemapHi },
        uDistortionShorePow: { value: this.params.distortionShorePow },
        uDistortionShoreMin: { value: this.params.distortionShoreMin },

        // Rain-hit distortion uniforms
        uRainEnabled: { value: 1.0 },
        uRainPrecipitation: { value: 0.0 },
        uRainSplit: { value: this.params.rainDistortionSplit },
        uRainBlend: { value: this.params.rainDistortionBlend },
        uRainGlobalStrength: { value: this.params.rainDistortionGlobalStrength },

        // Outdoors mask for indoor damping (world-space scene UV)
        tOutdoorsMask: { value: null },
        uHasOutdoorsMask: { value: 0.0 },
        uOutdoorsMaskFlipY: { value: 0.0 },
        uRainIndoorDampingEnabled: { value: this.params.rainIndoorDampingEnabled === false ? 0.0 : 1.0 },
        uRainIndoorDampingStrength: { value: this.params.rainIndoorDampingStrength },

        // Cloud shadows (screen-space render target sampled in scene-UV space)
        tCloudShadow: { value: null },
        uHasCloudShadow: { value: 0.0 },
        uCloudShadowEnabled: { value: this.params.cloudShadowEnabled === false ? 0.0 : 1.0 },
        uCloudShadowMinBrightness: { value: 0.0 },
        uCloudShadowOpacity: { value: 1.0 },
        uCloudShadowDarkenStrength: { value: this.params.cloudShadowDarkenStrength },
        uCloudShadowDarkenCurve: { value: this.params.cloudShadowDarkenCurve },
        uCloudShadowSpecularKill: { value: this.params.cloudShadowSpecularKill },
        uCloudShadowSpecularCurve: { value: this.params.cloudShadowSpecularCurve },

        uRainRippleStrengthPx: { value: this.params.rainRippleStrengthPx },
        uRainRippleScale: { value: this.params.rainRippleScale },
        uRainRippleSpeed: { value: this.params.rainRippleSpeed },
        uRainRippleDensity: { value: this.params.rainRippleDensity },
        uRainRippleSharpness: { value: this.params.rainRippleSharpness },

        uRainRippleJitter: { value: this.params.rainRippleJitter },
        uRainRippleRadiusMin: { value: this.params.rainRippleRadiusMin },
        uRainRippleRadiusMax: { value: this.params.rainRippleRadiusMax },
        uRainRippleWidthScale: { value: this.params.rainRippleWidthScale },
        uRainRippleSecondaryEnabled: { value: this.params.rainRippleSecondaryEnabled === false ? 0.0 : 1.0 },
        uRainRippleSecondaryStrength: { value: this.params.rainRippleSecondaryStrength },
        uRainRippleSecondaryPhaseOffset: { value: this.params.rainRippleSecondaryPhaseOffset },

        uRainStormStrengthPx: { value: this.params.rainStormStrengthPx },
        uRainStormScale: { value: this.params.rainStormScale },
        uRainStormSpeed: { value: this.params.rainStormSpeed },
        uRainStormCurl: { value: this.params.rainStormCurl },

        uRainStormRateBase: { value: this.params.rainStormRateBase },
        uRainStormRateSpeedScale: { value: this.params.rainStormRateSpeedScale },
        uRainStormSizeMin: { value: this.params.rainStormSizeMin },
        uRainStormSizeMax: { value: this.params.rainStormSizeMax },
        uRainStormWidthMinScale: { value: this.params.rainStormWidthMinScale },
        uRainStormWidthMaxScale: { value: this.params.rainStormWidthMaxScale },
        uRainStormDecay: { value: this.params.rainStormDecay },
        uRainStormCoreWeight: { value: this.params.rainStormCoreWeight },
        uRainStormRingWeight: { value: this.params.rainStormRingWeight },
        uRainStormSwirlStrength: { value: this.params.rainStormSwirlStrength },
        uRainStormMicroEnabled: { value: this.params.rainStormMicroEnabled === false ? 0.0 : 1.0 },
        uRainStormMicroStrength: { value: this.params.rainStormMicroStrength },
        uRainStormMicroScale: { value: this.params.rainStormMicroScale },
        uRainStormMicroSpeed: { value: this.params.rainStormMicroSpeed },

        uRainMaxCombinedStrengthPx: { value: this.params.rainMaxCombinedStrengthPx },

        uWindDir: { value: new THREE.Vector2(1.0, 0.0) },
        uWindSpeed: { value: 0.0 },
        uWindOffsetUv: { value: new THREE.Vector2(0.0, 0.0) },
        uWindTime: { value: 0.0 },

        uLockWaveTravelToWind: { value: 1.0 },
        uWaveDirOffsetRad: { value: 0.0 },
        uWaveAppearanceRotRad: { value: 0.0 },

        uSpecStrength: { value: this.params.specStrength },
        uSpecPower: { value: this.params.specPower },

        uSpecSunDir: { value: new THREE.Vector3(0.0, 0.0, 1.0) },
        uSpecSunIntensity: { value: this.params.specSunIntensity },
        uSpecNormalStrength: { value: this.params.specNormalStrength },
        uSpecNormalScale: { value: this.params.specNormalScale },
        uSpecRoughnessMin: { value: this.params.specRoughnessMin },
        uSpecRoughnessMax: { value: this.params.specRoughnessMax },
        uSpecF0: { value: this.params.specF0 },
        uSpecMaskGamma: { value: this.params.specMaskGamma },
        uSpecSkyTint: { value: this.params.specSkyTint },
        uSpecShoreBias: { value: this.params.specShoreBias },
        uSpecDistortionNormalStrength: { value: this.params.specDistortionNormalStrength },
        uSpecAnisotropy: { value: this.params.specAnisotropy },
        uSpecAnisoRatio: { value: this.params.specAnisoRatio },

        // Sky/environment coupling for specular tint
        uSkyColor: { value: new THREE.Color(0.62, 0.72, 0.92) },
        uSkyIntensity: { value: 1.0 },

        uFoamColor: { value: new THREE.Color(this.params.foamColor.r, this.params.foamColor.g, this.params.foamColor.b) },
        uFoamStrength: { value: this.params.foamStrength },
        uFoamThreshold: { value: this.params.foamThreshold },
        uFoamScale: { value: this.params.foamScale },
        uFoamSpeed: { value: this.params.foamSpeed },

        uFoamCurlStrength: { value: this.params.foamCurlStrength },
        uFoamCurlScale: { value: this.params.foamCurlScale },
        uFoamCurlSpeed: { value: this.params.foamCurlSpeed },

        uFoamBreakupStrength1: { value: this.params.foamBreakupStrength1 },
        uFoamBreakupScale1: { value: this.params.foamBreakupScale1 },
        uFoamBreakupSpeed1: { value: this.params.foamBreakupSpeed1 },
        uFoamBreakupStrength2: { value: this.params.foamBreakupStrength2 },
        uFoamBreakupScale2: { value: this.params.foamBreakupScale2 },
        uFoamBreakupSpeed2: { value: this.params.foamBreakupSpeed2 },

        uFoamBlackPoint: { value: this.params.foamBlackPoint },
        uFoamWhitePoint: { value: this.params.foamWhitePoint },
        uFoamGamma: { value: this.params.foamGamma },
        uFoamContrast: { value: this.params.foamContrast },
        uFoamBrightness: { value: this.params.foamBrightness },

        uFloatingFoamStrength: { value: this.params.floatingFoamStrength },
        uFloatingFoamCoverage: { value: this.params.floatingFoamCoverage },
        uFloatingFoamScale: { value: this.params.floatingFoamScale },
        uFloatingFoamWaveDistortion: { value: this.params.floatingFoamWaveDistortion },

        // Shader-based foam flecks (spray dots)
        uFoamFlecksIntensity: { value: this.params.foamFlecksIntensity },

        uMurkEnabled: { value: this.params.murkEnabled === false ? 0.0 : 1.0 },
        uMurkIntensity: { value: this.params.murkIntensity },
        uMurkColor: { value: new THREE.Color(this.params.murkColor.r, this.params.murkColor.g, this.params.murkColor.b) },
        uMurkScale: { value: this.params.murkScale },
        uMurkSpeed: { value: this.params.murkSpeed },
        uMurkDepthLo: { value: this.params.murkDepthLo },
        uMurkDepthHi: { value: this.params.murkDepthHi },
        uMurkGrainScale: { value: this.params.murkGrainScale },
        uMurkGrainSpeed: { value: this.params.murkGrainSpeed },
        uMurkGrainStrength: { value: this.params.murkGrainStrength },
        uMurkDepthFade: { value: this.params.murkDepthFade },

        uSandIntensity: { value: this.params.sandIntensity },
        uSandColor: { value: new THREE.Color(0.0, 0.0, 0.0) },
        uSandContrast: { value: this.params.sandContrast },
        uSandChunkScale: { value: this.params.sandChunkScale },
        uSandChunkSpeed: { value: this.params.sandChunkSpeed },
        uSandGrainScale: { value: this.params.sandGrainScale },
        uSandGrainSpeed: { value: this.params.sandGrainSpeed },
        uSandBillowStrength: { value: this.params.sandBillowStrength },

        uSandCoverage: { value: this.params.sandCoverage },
        uSandChunkSoftness: { value: this.params.sandChunkSoftness },
        uSandSpeckCoverage: { value: this.params.sandSpeckCoverage },
        uSandSpeckSoftness: { value: this.params.sandSpeckSoftness },
        uSandDepthLo: { value: this.params.sandDepthLo },
        uSandDepthHi: { value: this.params.sandDepthHi },
        uSandAnisotropy: { value: this.params.sandAnisotropy },
        uSandDistortionStrength: { value: this.params.sandDistortionStrength },
        uSandAdditive: { value: this.params.sandAdditive },

        uDebugView: { value: this.params.debugView },

        uTime: { value: 0.0 },
        uResolution: { value: new THREE.Vector2(1, 1) },

        uZoom: { value: 1.0 },

        uViewBounds: { value: this._viewBounds },
        uSceneDimensions: { value: this._sceneDimensions },
        uSceneRect: { value: this._sceneRect },
        uHasSceneRect: { value: 0.0 },

        // Token mask (screen-space). Used to prevent water refraction/tint from affecting tokens.
        tTokenMask: { value: null },
        uHasTokenMask: { value: 0.0 },

        // Scene/environment coupling
        uSceneDarkness: { value: 0.0 },

        // Shared module depth-pass uniforms (uDepthTexture/uDepthEnabled/uDepthCameraNear/uDepthCameraFar/uGroundDistance)
        ...DepthShaderChunks.createUniforms(),
        // Active Levels floor bottom elevation. Used to make depth-based water
        // occlusion relative to the currently viewed floor instead of absolute
        // world height, so upper-floor tiles don't fully hide lower-floor water.
        uActiveLevelElevation: { value: 0.0 }
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
        uniform sampler2D tNoiseMap;
        uniform sampler2D tWaterData;
        uniform float uHasWaterData;
        uniform float uWaterEnabled;

        uniform sampler2D tWaterRawMask;
        uniform float uHasWaterRawMask;

        uniform sampler2D tWaterOccluderAlpha;
        uniform float uHasWaterOccluderAlpha;

        uniform vec2 uWaterDataTexelSize;

        uniform vec3 uTintColor;
        uniform float uTintStrength;

        uniform float uWaveScale;
        uniform float uWaveSpeed;
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

        uniform float uChromaticAberrationStrengthPx;
        uniform float uChromaticAberrationEdgeCenter;
        uniform float uChromaticAberrationEdgeFeather;
        uniform float uChromaticAberrationEdgeGamma;
        uniform float uChromaticAberrationEdgeMin;

        uniform float uWaveIndoorDampingEnabled;
        uniform float uWaveIndoorDampingStrength;
        uniform float uWaveIndoorMinFactor;

        uniform float uDistortionEdgeCenter;
        uniform float uDistortionEdgeFeather;
        uniform float uDistortionEdgeGamma;
        uniform float uDistortionShoreRemapLo;
        uniform float uDistortionShoreRemapHi;
        uniform float uDistortionShorePow;
        uniform float uDistortionShoreMin;

        uniform float uRainEnabled;
        uniform float uRainPrecipitation;
        uniform float uRainSplit;
        uniform float uRainBlend;
        uniform float uRainGlobalStrength;

        uniform sampler2D tOutdoorsMask;
        uniform float uHasOutdoorsMask;
        uniform float uOutdoorsMaskFlipY;
        uniform float uRainIndoorDampingEnabled;
        uniform float uRainIndoorDampingStrength;

        uniform sampler2D tCloudShadow;
        uniform float uHasCloudShadow;
        uniform float uCloudShadowEnabled;
        uniform float uCloudShadowMinBrightness;
        uniform float uCloudShadowOpacity;
        uniform float uCloudShadowDarkenStrength;
        uniform float uCloudShadowDarkenCurve;
        uniform float uCloudShadowSpecularKill;
        uniform float uCloudShadowSpecularCurve;

        uniform float uRainRippleStrengthPx;
        uniform float uRainRippleScale;
        uniform float uRainRippleSpeed;
        uniform float uRainRippleDensity;
        uniform float uRainRippleSharpness;

        uniform float uRainRippleJitter;
        uniform float uRainRippleRadiusMin;
        uniform float uRainRippleRadiusMax;
        uniform float uRainRippleWidthScale;
        uniform float uRainRippleSecondaryEnabled;
        uniform float uRainRippleSecondaryStrength;
        uniform float uRainRippleSecondaryPhaseOffset;

        uniform float uRainStormStrengthPx;
        uniform float uRainStormScale;
        uniform float uRainStormSpeed;
        uniform float uRainStormCurl;

        uniform float uRainStormRateBase;
        uniform float uRainStormRateSpeedScale;
        uniform float uRainStormSizeMin;
        uniform float uRainStormSizeMax;
        uniform float uRainStormWidthMinScale;
        uniform float uRainStormWidthMaxScale;
        uniform float uRainStormDecay;
        uniform float uRainStormCoreWeight;
        uniform float uRainStormRingWeight;
        uniform float uRainStormSwirlStrength;
        uniform float uRainStormMicroEnabled;
        uniform float uRainStormMicroStrength;
        uniform float uRainStormMicroScale;
        uniform float uRainStormMicroSpeed;

        uniform float uRainMaxCombinedStrengthPx;

        uniform vec2 uWindDir;
        uniform float uWindSpeed;
        uniform vec2 uWindOffsetUv;
        uniform float uWindTime;

        uniform float uLockWaveTravelToWind;
        uniform float uWaveDirOffsetRad;
        uniform float uWaveAppearanceRotRad;

        uniform float uSpecStrength;
        uniform float uSpecPower;

        uniform vec3 uSpecSunDir;
        uniform float uSpecSunIntensity;
        uniform float uSpecNormalStrength;
        uniform float uSpecNormalScale;
        uniform float uSpecRoughnessMin;
        uniform float uSpecRoughnessMax;
        uniform float uSpecF0;
        uniform float uSpecMaskGamma;
        uniform float uSpecSkyTint;
        uniform float uSpecShoreBias;
        uniform float uSpecDistortionNormalStrength;
        uniform float uSpecAnisotropy;
        uniform float uSpecAnisoRatio;

        uniform vec3 uFoamColor;
        uniform float uFoamStrength;
        uniform float uFoamThreshold;
        uniform float uFoamScale;
        uniform float uFoamSpeed;

        uniform float uFoamCurlStrength;
        uniform float uFoamCurlScale;
        uniform float uFoamCurlSpeed;

        uniform float uFoamBreakupStrength1;
        uniform float uFoamBreakupScale1;
        uniform float uFoamBreakupSpeed1;
        uniform float uFoamBreakupStrength2;
        uniform float uFoamBreakupScale2;
        uniform float uFoamBreakupSpeed2;

        uniform float uFoamBlackPoint;
        uniform float uFoamWhitePoint;
        uniform float uFoamGamma;
        uniform float uFoamContrast;
        uniform float uFoamBrightness;

        uniform float uFloatingFoamStrength;
        uniform float uFloatingFoamCoverage;
        uniform float uFloatingFoamScale;
        uniform float uFloatingFoamWaveDistortion;

        // Shader-based foam flecks (spray dots)
        uniform float uFoamFlecksIntensity;

        // Subsurface murk volume (silt/algae/mud)
        uniform float uMurkEnabled;
        uniform float uMurkIntensity;
        uniform vec3 uMurkColor;
        uniform float uMurkScale;
        uniform float uMurkSpeed;
        uniform float uMurkDepthLo;
        uniform float uMurkDepthHi;
        uniform float uMurkGrainScale;
        uniform float uMurkGrainSpeed;
        uniform float uMurkGrainStrength;
        uniform float uMurkDepthFade;

        uniform float uSandIntensity;
        uniform vec3 uSandColor;
        uniform float uSandContrast;
        uniform float uSandChunkScale;
        uniform float uSandChunkSpeed;
        uniform float uSandGrainScale;
        uniform float uSandGrainSpeed;
        uniform float uSandBillowStrength;

        uniform float uSandCoverage;
        uniform float uSandChunkSoftness;
        uniform float uSandSpeckCoverage;
        uniform float uSandSpeckSoftness;
        uniform float uSandDepthLo;
        uniform float uSandDepthHi;
        uniform float uSandAnisotropy;
        uniform float uSandDistortionStrength;
        uniform float uSandAdditive;

        uniform float uDebugView;

        uniform float uTime;
        uniform vec2 uResolution;

        uniform float uZoom;

        uniform vec4 uViewBounds;
        uniform vec2 uSceneDimensions;
        uniform vec4 uSceneRect;
        uniform float uHasSceneRect;

        uniform sampler2D tTokenMask;
        uniform float uHasTokenMask;

        uniform vec3 uSkyColor;
        uniform float uSkyIntensity;
        uniform float uSceneDarkness;
        uniform float uActiveLevelElevation;

        ${DepthShaderChunks.uniforms}
        ${DepthShaderChunks.linearize}

        varying vec2 vUv;

        float waterInsideFromSdf(float sdf01);

        float sampleOutdoorsMask(vec2 sceneUv01);

        vec2 waveGrad2D(vec2 sceneUv, float t, float motion01);

        float hash12(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }

        vec2 hash22(vec2 p) {
          float n = hash12(p);
          return vec2(n, hash12(p + n + 19.19));
        }

        // Noise via a pre-baked 512x512 tileable RGBA noise texture (tNoiseMap).
        // Each RGBA channel holds an independent noise field (different PRNG seed).
        // NEAREST filtering + manual smoothstep interpolation exactly matches the
        // original procedural valueNoise quality while eliminating hundreds of
        // inlined hash12 calls that caused ANGLE/D3D11 fxc.exe to take ~49s.
        const float NOISE_INV = 1.0 / 512.0;

        // Smoothstep-interpolated single-channel noise from channel R.
        // 4 texel samples with smoothstep blending — identical to original valueNoise.
        float valueNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          float a = texture2D(tNoiseMap, (i + 0.5) * NOISE_INV).r;
          float b = texture2D(tNoiseMap, (i + vec2(1.5, 0.5)) * NOISE_INV).r;
          float c = texture2D(tNoiseMap, (i + vec2(0.5, 1.5)) * NOISE_INV).r;
          float d = texture2D(tNoiseMap, (i + vec2(1.5, 1.5)) * NOISE_INV).r;
          return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
        }

        // 4-octave fBm with pre-computed coefficients: amp starts at 0.55, decays by 0.55.
        // Octave weights: 1.1, 0.605, 0.33275, 0.183 (each is amp * 2.0).
        // Each octave samples a different RGBA channel for decorrelation,
        // and inter-octave rotation (~37°) prevents visible tiling repetition.
        float fbmNoise(vec2 p) {
          // Rotation matrix (~37° = atan(0.75)) decorrelates octave orientations.
          // Preserves magnitude so effective frequency still doubles each octave.
          const mat2 octRot = mat2(0.8, 0.6, -0.6, 0.8);
          vec2 i, f, u;

          // Octave 0 — R channel
          i = floor(p); f = fract(p); u = f * f * (3.0 - 2.0 * f);
          float n0 = mix(mix(
            texture2D(tNoiseMap, (i + 0.5) * NOISE_INV).r,
            texture2D(tNoiseMap, (i + vec2(1.5, 0.5)) * NOISE_INV).r, u.x), mix(
            texture2D(tNoiseMap, (i + vec2(0.5, 1.5)) * NOISE_INV).r,
            texture2D(tNoiseMap, (i + vec2(1.5, 1.5)) * NOISE_INV).r, u.x), u.y);

          p = octRot * p * 2.0;

          // Octave 1 — G channel
          i = floor(p); f = fract(p); u = f * f * (3.0 - 2.0 * f);
          float n1 = mix(mix(
            texture2D(tNoiseMap, (i + 0.5) * NOISE_INV).g,
            texture2D(tNoiseMap, (i + vec2(1.5, 0.5)) * NOISE_INV).g, u.x), mix(
            texture2D(tNoiseMap, (i + vec2(0.5, 1.5)) * NOISE_INV).g,
            texture2D(tNoiseMap, (i + vec2(1.5, 1.5)) * NOISE_INV).g, u.x), u.y);

          p = octRot * p * 2.0;

          // Octave 2 — B channel
          i = floor(p); f = fract(p); u = f * f * (3.0 - 2.0 * f);
          float n2 = mix(mix(
            texture2D(tNoiseMap, (i + 0.5) * NOISE_INV).b,
            texture2D(tNoiseMap, (i + vec2(1.5, 0.5)) * NOISE_INV).b, u.x), mix(
            texture2D(tNoiseMap, (i + vec2(0.5, 1.5)) * NOISE_INV).b,
            texture2D(tNoiseMap, (i + vec2(1.5, 1.5)) * NOISE_INV).b, u.x), u.y);

          p = octRot * p * 2.0;

          // Octave 3 — A channel
          i = floor(p); f = fract(p); u = f * f * (3.0 - 2.0 * f);
          float n3 = mix(mix(
            texture2D(tNoiseMap, (i + 0.5) * NOISE_INV).a,
            texture2D(tNoiseMap, (i + vec2(1.5, 0.5)) * NOISE_INV).a, u.x), mix(
            texture2D(tNoiseMap, (i + vec2(0.5, 1.5)) * NOISE_INV).a,
            texture2D(tNoiseMap, (i + vec2(1.5, 1.5)) * NOISE_INV).a, u.x), u.y);

          return (n0 - 0.5) * 1.1 + (n1 - 0.5) * 0.605
               + (n2 - 0.5) * 0.33275 + (n3 - 0.5) * 0.183;
        }

        float safe01(float v) {
          return clamp(v, 0.0, 1.0);
        }

        vec2 safeNormalize2(vec2 v) {
          float l = length(v);
          return (l > 1e-6) ? (v / l) : vec2(0.0, 0.0);
        }

        vec2 curlNoise2D(vec2 p);

        // Procedural raindrop ripple vector field.
        // Samples a 3x3 neighborhood of cells to reduce visible grid repetition.
        float rainRipple(vec2 uv, float t, out vec2 dirOut) {
          float sc = max(1.0, uRainRippleScale);
          vec2 p = uv * sc;
          vec2 baseCell = floor(p);
          vec2 f = fract(p) - 0.5;

          float density = clamp(uRainRippleDensity, 0.0, 1.0);
          float sharp = max(0.1, uRainRippleSharpness);
          float width = 0.06 / sharp;

          // Break up the grid:
          // - jitter impact centers inside each cell
          // - vary ring radius/width per-cell
          // - add a secondary micro-ring per hit to avoid perfect regularity
          float jitterAmt = clamp(uRainRippleJitter, 0.0, 1.0);
          float rMinBase = clamp(uRainRippleRadiusMin, 0.0, 0.95);
          float rMaxBase = clamp(uRainRippleRadiusMax, rMinBase + 0.001, 0.95);
          float widthScale = clamp(uRainRippleWidthScale, 0.05, 5.0);
          float secEnabled = (uRainRippleSecondaryEnabled > 0.5) ? 1.0 : 0.0;
          float secStrength = max(0.0, uRainRippleSecondaryStrength);
          float secPhaseOff = fract(max(0.0, uRainRippleSecondaryPhaseOffset));

          vec2 vAccum = vec2(0.0);
          float wAccum = 0.0;

          for (int yi = 0; yi < 3; yi++) {
            for (int xi = 0; xi < 3; xi++) {
              vec2 o = vec2(float(xi - 1), float(yi - 1));
              vec2 cell = baseCell + o;

              float rnd = hash12(cell);
              float cellActive = step(1.0 - density, rnd);
              if (cellActive < 0.5) continue;

              float phase01 = fract(t * max(0.0, uRainRippleSpeed) + rnd);

              vec2 jitter = (hash22(cell + vec2(7.1, 19.3)) - 0.5) * jitterAmt;
              float rMin = mix(rMinBase, min(rMinBase + 0.12, rMaxBase), hash12(cell + vec2(3.3, 11.7)));
              float rMax = mix(max(rMinBase + 0.18, rMin), rMaxBase, hash12(cell + vec2(13.9, 2.1)));
              float cellWidth = width * widthScale * mix(0.75, 1.35, hash12(cell + vec2(5.7, 29.1)));

              // Local vector within the neighbor cell
              vec2 gv = (f - o) - jitter;
              float r = length(gv);
              float ringCenter = mix(rMin, rMax, phase01);

              float ring = exp(-pow((r - ringCenter) / max(0.001, cellWidth), 2.0));
              float wobble = 0.5 + 0.5 * sin((r - ringCenter) * (40.0 * sharp) - t * (6.0 + 8.0 * sharp));
              float amp = ring * wobble;

              // Secondary ring: slightly delayed and shifted to reduce obvious periodicity.
              float phase02 = fract(phase01 + secPhaseOff + (rnd - 0.5) * 0.2);
              float ringCenter2 = mix(rMin, rMax, phase02);
              float ring2 = exp(-pow((r - ringCenter2) / max(0.001, cellWidth * 1.25), 2.0));
              float wobble2 = 0.5 + 0.5 * sin((r - ringCenter2) * (28.0 * sharp) - t * (4.0 + 6.0 * sharp));
              amp += ring2 * wobble2 * secStrength * secEnabled;

              vec2 dir = safeNormalize2(gv);
              vAccum += dir * amp;
              wAccum += amp;
            }
          }

          // Saturating normalization so multiple overlapping ripples don't instantly clamp.
          float a = 1.0 - exp(-wAccum * 1.6);
          dirOut = safeNormalize2(vAccum);
          return safe01(a);
        }

        // Storm distortion vector field (harsh turbulent noise).
        vec2 rainStorm(vec2 uv, float t) {
          float sc = max(1.0, uRainStormScale);
          float sp = max(0.0, uRainStormSpeed);

          // Heavy rain should feel like the surface is being pelted from above.
          // Instead of scrolling a noise field, we time-reseed per-cell "impact" events
          // which expand/decay in place. This produces an evolving smash/chop pattern.
          vec2 p = uv * sc;
          vec2 baseCell = floor(p);
          vec2 f = fract(p) - 0.5;

          float rate = max(0.0, uRainStormRateBase) + sp * max(0.0, uRainStormRateSpeedScale);
          float chaos = max(0.0, uRainStormCurl);

          vec2 vAccum = vec2(0.0);
          float wAccum = 0.0;

          for (int yi = 0; yi < 3; yi++) {
            for (int xi = 0; xi < 3; xi++) {
              vec2 o = vec2(float(xi - 1), float(yi - 1));
              vec2 cell = baseCell + o;

              float cellSeed = hash12(cell);
              float timeSeed = t * rate + cellSeed * 11.0;
              float k = floor(timeSeed);
              float phase = fract(timeSeed);

              // Event seed changes every impact (time slice) but stays stable spatially.
              float e = hash12(cell + vec2(k, k * 1.23));
              vec2 jitter = (hash22(cell + vec2(k, k * 0.77) + vec2(17.3, 9.1)) - 0.5) * 0.95;

              vec2 gv = (f - o) - jitter;
              float r = length(gv);

              float sizeMin = max(0.001, uRainStormSizeMin);
              float sizeMax = max(sizeMin, uRainStormSizeMax);
              float size = mix(sizeMin, sizeMax, hash12(cell + vec2(5.1, 13.7)));

              float wMin = max(0.001, uRainStormWidthMinScale);
              float wMax = max(wMin, uRainStormWidthMaxScale);
              float width = max(0.001, size * mix(wMin, wMax, hash12(cell + vec2(29.9, 3.7))));

              // Fast decay so impacts feel like sharp hits rather than persistent waves.
              float env = exp(-phase * max(0.0, uRainStormDecay));

              // Combine a tight central punch with an expanding ring.
              float core = exp(-pow(r / max(1e-4, size * 0.55), 2.0));
              float ringCenter = phase * size;
              float ring = exp(-pow((r - ringCenter) / max(1e-4, width), 2.0));

              float coreW = max(0.0, uRainStormCoreWeight);
              float ringW = max(0.0, uRainStormRingWeight);
              float amp = (core * coreW + ring * ringW) * env;
              amp *= mix(0.65, 1.25, e);

              vec2 dir = safeNormalize2(gv);
              vec2 tan = vec2(-dir.y, dir.x);
              float swirl = (e - 0.5) * 2.0;

              vec2 local = dir * amp;
              local += tan * amp * max(0.0, uRainStormSwirlStrength) * swirl * chaos;

              vAccum += local;
              wAccum += amp;
            }
          }

          // Add a subtle evolving micro-chop component (no directional scrolling).
          if (uRainStormMicroEnabled > 0.5) {
            float microSc = max(0.0, uRainStormMicroScale);
            float microSp = max(0.0, uRainStormMicroSpeed);
            float micro = fbmNoise(uv * (sc * microSc) + vec2(sin(t * microSp), cos(t * microSp * 1.13)) * 2.3);
            vAccum += vec2(micro, -micro) * max(0.0, uRainStormMicroStrength) * chaos;
          }

          float a = 1.0 - exp(-wAccum * 1.15);
          return safeNormalize2(vAccum) * safe01(a);
        }

        vec2 computeRainOffsetPx(vec2 uv) {
          if (uRainEnabled < 0.5) return vec2(0.0);

          float p = safe01(uRainPrecipitation);
          if (p < 0.001) return vec2(0.0);
          float split = safe01(uRainSplit);
          float blend = clamp(uRainBlend, 0.0, 0.25);

          // Crossfade: 0..split = ripple growth, split..1 = storm dominance.
          float wStorm = (blend > 1e-6)
            ? smoothstep(split - blend, split + blend, p)
            : step(split, p);
          float wRipple = (1.0 - wStorm) * smoothstep(0.0, max(1e-4, split), p);

          vec2 rippleDir = vec2(0.0);
          float rippleAmt = rainRipple(uv, uTime, rippleDir);
          float ripplePx = clamp(uRainRippleStrengthPx, 0.0, 64.0);
          vec2 rippleOffPx = rippleDir * rippleAmt * ripplePx;

          vec2 stormV = rainStorm(uv, uTime);
          float stormLen = length(stormV);
          vec2 stormDir = (stormLen > 1e-6) ? (stormV / stormLen) : vec2(0.0);
          float stormAmt = clamp(stormLen, 0.0, 1.0);
          float stormPx = clamp(uRainStormStrengthPx, 0.0, 64.0);
          vec2 stormOffPx = stormDir * stormAmt * stormPx;

          vec2 offPx = (rippleOffPx * wRipple + stormOffPx * wStorm) * clamp(uRainGlobalStrength, 0.0, 2.0);

          // Optional indoor damping using _Outdoors mask.
          // - If no mask is available, treat everything as outdoors.
          float outdoorStrength = 1.0;
          if (uHasOutdoorsMask > 0.5) {
            outdoorStrength = sampleOutdoorsMask(uv);
          }
          float dampStrength = clamp(uRainIndoorDampingStrength, 0.0, 1.0);
          float indoorMult = (uRainIndoorDampingEnabled > 0.5) ? mix(1.0, outdoorStrength, dampStrength) : 1.0;
          offPx *= indoorMult;

          // Safety clamp to prevent violent tearing.
          float maxPx = clamp(uRainMaxCombinedStrengthPx, 0.0, 64.0);
          float lenPx = length(offPx);
          if (maxPx > 1e-4 && lenPx > maxPx) {
            offPx *= (maxPx / max(1e-6, lenPx));
          }

          return offPx;
        }

        vec2 curlNoise2D(vec2 p) {
          float e = 0.02;
          float n1 = fbmNoise(p + vec2(0.0, e));
          float n2 = fbmNoise(p - vec2(0.0, e));
          float n3 = fbmNoise(p + vec2(e, 0.0));
          float n4 = fbmNoise(p - vec2(e, 0.0));
          float dndy = (n1 - n2) / (2.0 * e);
          float dndx = (n3 - n4) / (2.0 * e);
          return vec2(dndy, -dndx);
        }

        vec2 warpUv(vec2 sceneUv, float motion01) {
          // IMPORTANT: advecting by changing sampling coordinates is direction-inverted.
          // If we want the *visible* pattern to move with the wind, we must subtract
          // the accumulated offset from the sampling UVs.
          // Match wave math convention: convert Foundry Y-down drift to math Y-up.
          float m = clamp(motion01, 0.0, 1.0);
          vec2 windOffsetUv = vec2(uWindOffsetUv.x, -uWindOffsetUv.y) * m;
          vec2 uv = sceneUv - windOffsetUv;

          // Large-scale domain warp to reduce obvious repetition across big bodies of water.
          // These strengths are user-tweakable because some maps want a calmer, cleaner look.
          float timeWarp = uTime * max(0.0, uWaveWarpTimeSpeed) * m;

          // Wind-stretched warp coordinates to create elongated "streaks" downwind.
          // This reduces the repeating "scrolling wallpaper" look on large water bodies.
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

          // Tiny oscillation so the warp field evolves at a slightly different cadence than the waves.
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

        float waveSeaState(vec2 sceneUv, float motion01) {
          // Produces a slowly evolving 0..1 scalar that makes the wave field
          // alternate between calmer and more energetic states.
          if (uWaveEvolutionEnabled < 0.5) return 0.5;

          float sp = max(0.0, uWaveEvolutionSpeed);
          sp *= clamp(motion01, 0.0, 1.0);
          float sc = max(0.01, uWaveEvolutionScale);
          float n = fbmNoise(sceneUv * sc + vec2(uTime * sp * 0.23, -uTime * sp * 0.19));
          float phase = uTime * sp + n * 2.7;
          return 0.5 + 0.5 * sin(phase);
        }

        vec2 rotate2D(vec2 v, float a) {
          float s = sin(a);
          float c = cos(a);
          return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
        }

        float hash11(float p) {
          return fract(sin(p) * 43758.5453123);
        }

        void waveMods(vec2 lf, float seed, out float kMul, out float dirRot) {
          // lf is expected to be in roughly [-1, 1] (fbmNoise output).
          float a = lf.x;
          float b = lf.y;

          // Per-wave randomization based on a stable seed.
          float r1 = hash11(seed * 13.17 + 1.0);
          float r2 = hash11(seed * 29.73 + 2.0);

          // Slowly varying direction jitter (radians).
          // Keep this fairly small to avoid obvious "curving" waves.
          dirRot = clamp((a * (0.20 + 0.60 * r1) + b * (0.20 + 0.60 * r2)) * 0.35, -0.55, 0.55);

          // Slowly varying frequency jitter.
          // This is the key anti-repetition trick: the wave field is no longer stationary.
          float km = 1.0 + (a * (0.15 + 0.25 * r2) + b * (0.10 + 0.25 * r1)) * 0.10;
          kMul = clamp(km, 0.75, 1.25);
        }

        // --- SHADER-BASED FOAM FLECKS ---
        // Generates high-frequency "spray" dots that move faster than foam with wind.
        // Uses a widened foam mask so flecks appear around edges, simulating spray blown off crests.
        #ifdef USE_FOAM_FLECKS
        float getShaderFlecks(vec2 sceneUv, float shore, float inside, float foamAmount) {
          if (uFoamFlecksIntensity < 0.01) return 0.0;

          float sceneAspect = (uHasSceneRect > 0.5) ? (uSceneRect.z / max(1.0, uSceneRect.w)) : (uResolution.x / max(1.0, uResolution.y));

          // Match wave convention: Weather wind is Y-down; flip to math Y-up for directional motion.
          vec2 windF = uWindDir;
          float windLen = length(windF);
          windF = (windLen > 1e-6) ? (windF / windLen) : vec2(1.0, 0.0);
          vec2 windDir = vec2(windF.x, -windF.y);
          vec2 windBasis = normalize(vec2(windDir.x * sceneAspect, windDir.y));

          // IMPORTANT: use monotonic wind-time (see JS integration) so gusts change speed
          // without making the pattern reverse direction.
          float tWind = uWindTime;

          // Flecks move faster than foam (2-3x) to simulate being blown downwind.
          float fleckSpeed = uFoamSpeed * 2.5 + 0.15;
          vec2 fleckOffset = windBasis * (tWind * fleckSpeed);

          // Use aspect-corrected basis like foam, but offset downwind
          vec2 foamWindOffsetUv = vec2(uWindOffsetUv.x, -uWindOffsetUv.y);
          vec2 foamSceneUv = sceneUv - (foamWindOffsetUv * 0.5);
          vec2 fleckBasis = vec2(foamSceneUv.x * sceneAspect, foamSceneUv.y);
          // Shift flecks downwind from foam source
          fleckBasis += windBasis * 0.02;

          // High-frequency noise for individual fleck dots
          // Multiple octaves at different scales for variety
          vec2 fleckUv1 = fleckBasis * 800.0 - fleckOffset * 400.0;
          vec2 fleckUv2 = fleckBasis * 1200.0 - fleckOffset * 600.0;
          vec2 fleckUv3 = fleckBasis * 500.0 - fleckOffset * 250.0;

          float n1 = valueNoise(fleckUv1);
          float n2 = valueNoise(fleckUv2);
          float n3 = valueNoise(fleckUv3);

          // Sharp threshold to create distinct dots rather than smooth gradients
          float threshold = 0.82;
          float dot1 = smoothstep(threshold, threshold + 0.08, n1);
          float dot2 = smoothstep(threshold + 0.02, threshold + 0.10, n2);
          float dot3 = smoothstep(threshold - 0.02, threshold + 0.06, n3);

          // Combine with varying weights
          float fleckDots = dot1 * 0.5 + dot2 * 0.3 + dot3 * 0.2;

          float fleckMask = smoothstep(0.2, 0.6, foamAmount);

          // Wind speed modulation: more flecks in stronger wind
          float windFactor = 0.3 + 0.7 * clamp(uWindSpeed, 0.0, 1.0);

          // Final fleck intensity
          float flecks = fleckDots * fleckMask * windFactor * clamp(uFoamFlecksIntensity, 0.0, 2.0);

          return clamp(flecks, 0.0, 1.0);
        }
        #else
        float getShaderFlecks(vec2 sceneUv, float shore, float inside, float foamAmount) {
          return 0.0;
        }
        #endif
        // --- SHADER FLECKS END ---

        float getFoamBaseAmount(vec2 sceneUv, float shore, float inside, vec2 rainOffPx) {
          vec2 foamWindOffsetUv = vec2(uWindOffsetUv.x, -uWindOffsetUv.y);
          vec2 foamSceneUv = sceneUv - (foamWindOffsetUv * 0.5);
          float sceneAspect = (uHasSceneRect > 0.5) ? (uSceneRect.z / max(1.0, uSceneRect.w)) : (uResolution.x / max(1.0, uResolution.y));
          vec2 foamBasis = vec2(foamSceneUv.x * sceneAspect, foamSceneUv.y);

          vec2 windF = uWindDir;
          float windLen = length(windF);
          windF = (windLen > 1e-6) ? (windF / windLen) : vec2(1.0, 0.0);
          vec2 windDir = vec2(windF.x, -windF.y);
          vec2 windBasis = normalize(vec2(windDir.x * sceneAspect, windDir.y));

          float wind01 = clamp(uWindSpeed, 0.0, 1.0);
          float tWind = uWindTime;

          vec2 curlP = foamBasis * max(0.01, uFoamCurlScale) - windBasis * (tWind * uFoamCurlSpeed);
          foamBasis += curlNoise2D(curlP) * clamp(uFoamCurlStrength, 0.0, 1.0);

          vec2 foamUv = foamBasis * max(0.1, uFoamScale) - windBasis * (tWind * uFoamSpeed * 0.5);
          float f1 = valueNoise(foamUv);
          float f2 = valueNoise(foamUv * 1.7 + 1.2);
          float bubbles = (f1 + f2) * 0.5;

          float b1 = fbmNoise(
            foamBasis * max(0.1, uFoamBreakupScale1)
          );
          float b2 = fbmNoise(
            foamBasis * max(0.1, uFoamBreakupScale2)
          );
          float breakup = 0.5 + 0.5 * (b1 * clamp(uFoamBreakupStrength1, 0.0, 1.0) + b2 * clamp(uFoamBreakupStrength2, 0.0, 1.0));
          breakup = clamp(breakup, 0.0, 1.0);

          // IMPORTANT: Avoid animated noise making foam *darker* (flickering dark speckles).
          // Noise is allowed to ADD foam, but should not subtract it.
          float bubblesAdd = max(0.0, bubbles - 0.5) * 0.30;
          float breakupAdd = max(0.0, breakup - 0.5) * 0.35;
          float foamMask = shore + bubblesAdd + breakupAdd;
          float shoreFoamAmount = smoothstep(uFoamThreshold, uFoamThreshold - 0.15, foamMask);
          shoreFoamAmount *= inside * max(0.0, uFoamStrength);

          vec2 clumpUv = foamBasis * max(0.1, uFloatingFoamScale);
          clumpUv -= windBasis * (tWind * (0.02 + uFoamSpeed * 0.05));
          
          // Apply wave + rain-hit distortion to floating foam clumps so they respond
          // to the same precipitation turbulence driving refraction/specular.
          if (uFloatingFoamWaveDistortion > 0.01) {
            float foamDistort = clamp(uFloatingFoamWaveDistortion, 0.0, 2.0);
            vec2 waveGrad = waveGrad2D(sceneUv, uTime, 1.0);
            clumpUv += waveGrad * foamDistort * 0.1;

            vec2 texel = 1.0 / max(uResolution, vec2(1.0));
            vec2 rainUv = rainOffPx * texel;
            vec2 rainBasis = vec2(rainUv.x * sceneAspect, rainUv.y);
            float rainFoamScale = max(1.0, uFloatingFoamScale * 0.35);
            clumpUv += rainBasis * foamDistort * rainFoamScale;
          }
          
          float c1 = valueNoise(clumpUv);
          float c2 = valueNoise(clumpUv * 2.1 + 5.2);
          float c = c1 * 0.7 + c2 * 0.3;
          float clumps = smoothstep(1.0 - clamp(uFloatingFoamCoverage, 0.0, 1.0), 1.0, c);

          float deepMask = smoothstep(0.15, 0.65, 1.0 - shore);
          float floatingFoamAmount = clumps * inside * max(0.0, uFloatingFoamStrength) * deepMask;

          // Additional floating foam layer: appears anywhere the authored _Water mask is white.
          // Uses the raw water mask when available; falls back to "inside" if not.
          float raw01 = (uHasWaterRawMask > 0.5) ? texture2D(tWaterRawMask, sceneUv).r : inside;
          float rawMask = smoothstep(0.70, 0.95, clamp(raw01, 0.0, 1.0));
          float floatingFoamMaskAmount = clumps * inside * max(0.0, uFloatingFoamStrength) * rawMask;

          float foamAmount = clamp(shoreFoamAmount + floatingFoamAmount + floatingFoamMaskAmount, 0.0, 1.0);

          float bp = clamp(uFoamBlackPoint, 0.0, 1.0);
          float wp = clamp(uFoamWhitePoint, 0.0, 1.0);
          foamAmount = clamp((foamAmount - bp) / max(1e-5, wp - bp), 0.0, 1.0);
          foamAmount = pow(foamAmount, max(0.01, uFoamGamma));
          foamAmount = (foamAmount - 0.5) * max(0.0, uFoamContrast) + 0.5;
          foamAmount = clamp(foamAmount + uFoamBrightness, 0.0, 1.0);

          return foamAmount;
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

          // Mild Gerstner-style "bunching": sharpen crests by increasing the gradient contribution
          // near peaks without needing true geometric displacement.
          float bunch = 1.0 + 0.35 * abs(w);
          gSceneUv += amp * d * (k * dir) * uWaveScale * bunch;
        }

        vec3 calculateWave(vec2 sceneUv, float t, float motion01) {
          const float TAU = 6.2831853;

          vec2 windF = uWindDir;
          float wl = length(windF);
          windF = (wl > 1e-5) ? (windF / wl) : vec2(1.0, 0.0);
          // WeatherController windDirection is in Foundry/world coordinates (Y-down).
          // The wave phase math (dot(p, dir)) behaves like a standard math basis (Y-up).
          // Convert by flipping Y so wave travel matches wind at 90/270 degrees.
          vec2 wind = vec2(windF.x, -windF.y);
          // If locked, waveSpeed-driven phase propagation always moves along the wind direction.
          // The travel offset becomes an *advanced* override for intentionally decoupling waves
          // from wind direction.
          float travelRot = (uLockWaveTravelToWind > 0.5) ? 0.0 : uWaveDirOffsetRad;
          wind = rotate2D(wind, travelRot);

          vec2 uvF = warpUv(sceneUv, motion01);
          vec2 uv = uvF;
          vec2 p = uv * uWaveScale;

          // Low-frequency spatial modulation to break up far-zoom repeating patterns.
          // This keeps the close-up look while preventing a single global "wallpaper" wave field.
          vec2 lf = vec2(
            fbmNoise(sceneUv * 0.11 + vec2(11.3, 17.9)),
            fbmNoise(sceneUv * 0.11 + vec2(37.1, 5.7))
          );

          float h = 0.0;
          vec2 g = vec2(0.0);

          float sea01 = waveSeaState(sceneUv, motion01);
          float evoAmt = clamp(uWaveEvolutionAmount, 0.0, 1.0);
          float evo = mix(1.0 - evoAmt, 1.0 + evoAmt, sea01);

          // Slow, rhythmic "sea-state breathing" so water energy rises/falls over time.
          float breathing = 0.8 + 0.2 * sin(uTime * 0.5 * clamp(motion01, 0.0, 1.0));
          float wavePulse = evo * breathing;

          // Dual-octave blending:
          // - Swell: large wavelength, aligned to wind.
          // - Chop: smaller, faster waves angled away from wind to create interference.
          vec2 swellP = p;
          // Use an irrational-ish multiplier to avoid obvious commensurate ratios.
          vec2 chopP = p * 2.618;
          vec2 crossWind = rotate2D(wind, 0.78);
          float chopBreathing = 0.7 + 0.3 * cos(uTime * 0.7 * clamp(motion01, 0.0, 1.0));
          float chopPulse = evo * chopBreathing;

          // Directional sum-of-sines (spread around wind) with sharp crests.
          // Amplitudes sum to ~1.0 for stable output scaling.
          // Swell layer (3 waves)
          float kMul0; float r0; waveMods(lf, 1.0, kMul0, r0);
          float k0 = (TAU * 0.61) * kMul0;
          addWave(swellP, rotate2D(wind, -0.60 + r0), k0, 0.40 * wavePulse, 2.20, (1.05 + 0.62 * sqrt(k0)), t, h, g);

          float kMul1; float r1; waveMods(lf, 2.0, kMul1, r1);
          float k1 = (TAU * 0.97) * kMul1;
          addWave(swellP, rotate2D(wind, -0.15 + r1), k1, 0.28 * wavePulse, 2.55, (1.05 + 0.62 * sqrt(k1)), t, h, g);

          float kMul2; float r2; waveMods(lf, 3.0, kMul2, r2);
          float k2 = (TAU * 1.43) * kMul2;
          addWave(swellP, rotate2D(wind,  0.20 + r2), k2, 0.16 * wavePulse, 2.85, (1.05 + 0.62 * sqrt(k2)), t, h, g);

          // Cross-chop layer (2 waves) - tighter scale and significant angle offset
          float kMul3; float r3; waveMods(lf, 4.0, kMul3, r3);
          float k3 = (TAU * 1.88) * kMul3;
          addWave(chopP, rotate2D(crossWind,  0.25 + r3), k3, 0.10 * chopPulse, 3.10, (1.18 + 0.72 * sqrt(k3)), t, h, g);

          float kMul4; float r4; waveMods(lf, 5.0, kMul4, r4);
          float k4 = (TAU * 2.71) * kMul4;
          addWave(chopP, rotate2D(crossWind, -0.35 + r4), k4, 0.06 * chopPulse, 3.35, (1.18 + 0.72 * sqrt(k4)), t, h, g);

          vec2 grad = g / max(uWaveScale, 1e-3);
          return vec3(h, grad);
        }

        float waveHeight(vec2 sceneUv, float t, float motion01) {
          return calculateWave(sceneUv, t, motion01).x;
        }

        vec2 waveGrad2D(vec2 sceneUv, float t, float motion01) {
          return calculateWave(sceneUv, t, motion01).yz;
        }

        vec2 smoothFlow2D(vec2 sceneUv) {
          vec2 e = max(uWaterDataTexelSize, vec2(1.0 / 2048.0));
          vec2 s = texture2D(tWaterData, sceneUv).ba;
          s += texture2D(tWaterData, sceneUv + vec2(e.x, 0.0)).ba;
          s += texture2D(tWaterData, sceneUv - vec2(e.x, 0.0)).ba;
          s += texture2D(tWaterData, sceneUv + vec2(0.0, e.y)).ba;
          s += texture2D(tWaterData, sceneUv - vec2(0.0, e.y)).ba;
          s *= (1.0 / 5.0);
          return s * 2.0 - 1.0;
        }

        vec2 screenUvToFoundry(vec2 screenUv) {
          float threeX = mix(uViewBounds.x, uViewBounds.z, screenUv.x);
          float threeY = mix(uViewBounds.y, uViewBounds.w, screenUv.y);
          float foundryX = threeX;
          float foundryY = uSceneDimensions.y - threeY;
          return vec2(foundryX, foundryY);
        }

        vec2 foundryToSceneUv(vec2 foundryPos) {
          vec2 sceneOrigin = uSceneRect.xy;
          vec2 sceneSize = uSceneRect.zw;
          return (foundryPos - sceneOrigin) / max(sceneSize, vec2(1e-5));
        }

        float sampleOutdoorsMask(vec2 sceneUv01) {
          // sceneUv01 is normalized to sceneRect.
          // Respect mask UV convention: some loaded textures are flipped.
          float y = (uOutdoorsMaskFlipY > 0.5) ? (1.0 - sceneUv01.y) : sceneUv01.y;
          vec2 uv = vec2(sceneUv01.x, y);
          return texture2D(tOutdoorsMask, uv).r;
        }

        float remap01(float v, float lo, float hi) {
          return clamp((v - lo) / max(1e-5, hi - lo), 0.0, 1.0);
        }

        float shoreFactor(float shore01) {
          float lo = clamp(uDistortionShoreRemapLo, 0.0, 1.0);
          float hi = clamp(uDistortionShoreRemapHi, 0.0, 1.0);
          float a = min(lo, hi - 1e-4);
          float b = max(hi, a + 1e-4);
          float s = remap01(clamp(shore01, 0.0, 1.0), a, b);
          s = pow(s, max(0.01, uDistortionShorePow));
          return max(clamp(uDistortionShoreMin, 0.0, 1.0), clamp(s, 0.0, 1.0));
        }

        // Water interior factor used by all water visuals (foam/sand/tint/etc.).
        // Keep this stable and independent from the distortion masking controls.
        float waterInsideFromSdf(float sdf01) {
          return smoothstep(0.52, 0.48, sdf01);
        }

        // Distortion-only interior factor: lets you tune where distortions begin/end
        // without changing the underlying water appearance.
        float distortionInsideFromSdf(float sdf01) {
          float c = clamp(uDistortionEdgeCenter, 0.0, 1.0);
          float f = max(0.0, uDistortionEdgeFeather);
          float inside = (f > 1e-6) ? smoothstep(c + f, c - f, sdf01) : step(sdf01, c);
          inside = pow(clamp(inside, 0.0, 1.0), max(0.01, uDistortionEdgeGamma));
          return inside;
        }

        // Chromatic aberration edge fade. This is separate from distortion masking so you can
        // keep refraction strong near the shore while fading out RGB splitting to avoid seams.
        float chromaticInsideFromSdf(float sdf01) {
          float c = clamp(uChromaticAberrationEdgeCenter, 0.0, 1.0);
          float f = max(0.0, uChromaticAberrationEdgeFeather);
          float inside = (f > 1e-6) ? smoothstep(c + f, c - f, sdf01) : step(sdf01, c);
          inside = pow(clamp(inside, 0.0, 1.0), max(0.01, uChromaticAberrationEdgeGamma));
          return max(clamp(uChromaticAberrationEdgeMin, 0.0, 1.0), inside);
        }

        float sandMask(vec2 sceneUv, float shore, float inside, float sceneAspect) {
          // Depth proxy: shore=0 deep water, shore=1 at edge.
          float depth = clamp(1.0 - shore, 0.0, 1.0);
          float dLo = clamp(uSandDepthLo, 0.0, 1.0);
          float dHi = clamp(uSandDepthHi, 0.0, 1.0);
          float lo = min(dLo, dHi - 0.001);
          float hi = max(dHi, lo + 0.001);
          float depthMask = smoothstep(lo, hi, depth);

          // uWindOffsetUv is accumulated in Foundry sceneRect UVs (Y-down). For this shader's
          // procedural advection basis, flip Y so visible motion matches perceived wind direction.
          vec2 sandWindOffsetUv = vec2(uWindOffsetUv.x, -uWindOffsetUv.y);

          vec2 sandSceneUv = sceneUv - (sandWindOffsetUv * max(0.0, uSandChunkSpeed));

          // Optional extra distortion on sand itself (separate from refracted background).
          float sandDist = clamp(uSandDistortionStrength, 0.0, 1.0);
          if (sandDist > 1e-4) {
            vec2 waveGrad = waveGrad2D(sceneUv, uWindTime, 1.0);
            // Appearance-only rotation: rotate the normal/distortion field without changing
            // wave phase propagation. Add a 90-degree correction so crest lines visually
            // align perpendicular to the wind-driven travel direction.
            waveGrad = rotate2D(waveGrad, uWaveAppearanceRotRad + 1.5707963);
            vec2 flowN = smoothFlow2D(sceneUv);
            vec2 warp = waveGrad * uWaveStrength + flowN * 0.35;
            sandSceneUv += warp * (0.045 * sandDist);
          }

          vec2 sandBasis = vec2(sandSceneUv.x * sceneAspect, sandSceneUv.y);

          vec2 windF = uWindDir;
          float wl = length(windF);
          windF = (wl > 1e-6) ? (windF / wl) : vec2(1.0, 0.0);
          // Match foam/wave conventions: convert Foundry Y-down to math-style Y-up.
          windF.y = -windF.y;
          vec2 windBasis = normalize(vec2(windF.x * sceneAspect, windF.y));
          vec2 perp = vec2(-windBasis.y, windBasis.x);

          float aniso = clamp(uSandAnisotropy, 0.0, 1.0);
          float alongScale = mix(1.0, 0.35, aniso);
          float acrossScale = mix(1.0, 3.0, aniso);
          float along = dot(sandBasis, windBasis) * alongScale;
          float across = dot(sandBasis, perp) * acrossScale;
          sandBasis = windBasis * along + perp * across;

          vec2 curlP = sandBasis * (0.5 + 1.25 * max(0.01, uSandChunkScale)) - windBasis * (uTime * (0.03 + 0.14 * max(0.0, uSandChunkSpeed)));
          sandBasis += curlNoise2D(curlP) * clamp(uSandBillowStrength, 0.0, 1.0) * 0.35;

          float chunkN = clamp(0.5 + 0.5 * fbmNoise(sandBasis * max(0.05, uSandChunkScale) + vec2(uTime * 0.05, -uTime * 0.04)), 0.0, 1.0);
          float evolveN = clamp(0.5 + 0.5 * fbmNoise(sandBasis * max(0.03, uSandChunkScale * 0.65) + vec2(-uTime * 0.03, uTime * 0.02)), 0.0, 1.0);
          float chunk = 0.55 * chunkN + 0.45 * evolveN;

          float cov = clamp(uSandCoverage, 0.0, 1.0);
          float chunkTh = mix(0.85, 0.45, cov);
          float chunkSoft = max(0.001, uSandChunkSoftness);
          float chunkMask = smoothstep(chunkTh, chunkTh + chunkSoft, chunk);

          float sandContrast = max(0.01, uSandContrast);
          chunkMask = pow(clamp(chunkMask, 0.0, 1.0), sandContrast);

          vec2 grainUv = sandBasis * max(1.0, uSandGrainScale);
          grainUv += windBasis * (uTime * (0.08 + 0.35 * max(0.0, uSandGrainSpeed)));
          grainUv += curlNoise2D(grainUv * 0.02 + vec2(uTime * 0.4, -uTime * 0.3)) * 0.65;

          float g1 = valueNoise(grainUv + vec2(uTime * uSandGrainSpeed * 0.6));
          float g2 = valueNoise(grainUv * 1.7 + 3.1 + vec2(-uTime * uSandGrainSpeed * 0.45));
          float grit = (g1 * 0.65 + g2 * 0.35);

          float speckCov = clamp(uSandSpeckCoverage, 0.0, 1.0);
          float speckTh = mix(0.95, 0.55, speckCov);
          float speckSoft = max(0.001, uSandSpeckSoftness);
          float speck = smoothstep(speckTh, speckTh + speckSoft, grit);

          speck = pow(clamp(speck, 0.0, 1.0), sandContrast);

          float sandAlpha = speck * chunkMask * inside * depthMask;
          sandAlpha *= clamp(uSandIntensity, 0.0, 1.0);
          sandAlpha *= 1.15;
          return sandAlpha;
        }

        vec3 applyMurk(vec3 baseColor, vec2 sceneUv, float shore, float inside, float time, out float murkFactorOut) {
          murkFactorOut = 0.0;
          if (uMurkEnabled < 0.5) return baseColor;

          float murkIntensity = clamp(uMurkIntensity, 0.0, 2.0);
          if (murkIntensity < 0.01 || inside < 0.001) return baseColor;

          float murkScale = max(0.1, uMurkScale);
          float murkSpeed = max(0.0, uMurkSpeed);
          // Keep murk domain in scene space and drive advection explicitly from wind basis
          // so changing wind direction immediately rotates murk travel direction.
          vec2 murkSceneUv = sceneUv;
          float sceneAspect = (uHasSceneRect > 0.5) ? (uSceneRect.z / max(1.0, uSceneRect.w)) : (uResolution.x / max(1.0, uResolution.y));
          vec2 murkBasis = vec2(murkSceneUv.x * sceneAspect, murkSceneUv.y);

          // Explicit wind-direction basis for all animated murk terms.
          // This ensures changing wind direction rotates murk motion accordingly.
          vec2 windF = uWindDir;
          float windLen = length(windF);
          windF = (windLen > 1e-6) ? (windF / windLen) : vec2(1.0, 0.0);
          vec2 windBasis = normalize(vec2(windF.x * sceneAspect, windF.y));
          vec2 windPerp = vec2(-windBasis.y, windBasis.x);
          float tWind = uWindTime;

          // Low-frequency cloud field, warped by curl to create billowy suspended silt.
          vec2 cloudUv = murkBasis * murkScale;
          vec2 cloudDrift = windBasis * (tWind * murkSpeed * 0.22);
          vec2 cloudWarp = curlNoise2D((cloudUv - cloudDrift) * 0.45) * 0.45;
          float cloudA = fbmNoise(cloudUv - cloudDrift + cloudWarp);
          float cloudB = fbmNoise(cloudUv * 0.57 - cloudDrift * 0.73 + windPerp * 0.35 + vec2(17.3, 9.1) - cloudWarp * 0.35);
          float cloud = clamp(0.5 + 0.5 * (0.65 * cloudA + 0.35 * cloudB), 0.0, 1.0);
          cloud = smoothstep(0.30, 0.78, cloud);

          // Depth proxy from exposure: higher values are deeper water in this pass.
          float depthLo = clamp(uMurkDepthLo, 0.0, 1.0);
          float depthHi = clamp(uMurkDepthHi, 0.0, 1.0);
          float mdLo = min(depthLo, depthHi - 0.001);
          float mdHi = max(depthHi, mdLo + 0.001);
          float depthMask = smoothstep(mdLo, mdHi, clamp(shore, 0.0, 1.0));
          float depthFactor = pow(depthMask, max(0.1, uMurkDepthFade));

          // High-frequency particulate sparkle, strongest in thick clouds.
          float grainScale = max(10.0, uMurkGrainScale);
          float grainSpeed = max(0.0, uMurkGrainSpeed);
          vec2 grainSceneUv = sceneUv;
          vec2 grainBasis = vec2(grainSceneUv.x * sceneAspect, grainSceneUv.y);

          float grainPhase = tWind * (murkSpeed + grainSpeed);
          vec2 grainDrift = windBasis * (grainPhase * 1.8);
          // IMPORTANT: translation alone looks like sliding texture. Add time-evolving
          // domain motion so the particulate field boils/changes each frame.
          vec2 grainEvo = vec2(time * grainSpeed * 0.85, -time * grainSpeed * 0.71);
          vec2 gUv1 = grainBasis * (grainScale * 1.0) - grainDrift + grainEvo;
          vec2 gUv2 = grainBasis * (grainScale * 2.35) - grainDrift * 2.1 - grainEvo * 1.6 + vec2(23.4, 7.1);
          vec2 gUv3 = grainBasis * (grainScale * 4.9) - grainDrift * 3.0 + grainEvo * 2.4 + vec2(-11.8, 31.6);
          vec2 gWarp = curlNoise2D((grainBasis * grainScale * 0.018) + grainEvo * 0.12 - windBasis * (grainPhase * 0.20)) * 2.0;
          gUv1 += gWarp * 0.20;
          gUv2 += gWarp * 0.12;
          gUv3 += gWarp * 0.08;

          float g1 = valueNoise(gUv1);
          float g2 = valueNoise(gUv2);
          float g3 = valueNoise(gUv3);
          float grit = clamp(0.55 * g1 + 0.30 * g2 + 0.15 * g3, 0.0, 1.0);

          // Tiny animated particulate peaks, biased into thicker murk pockets.
          float grain = pow(grit, 14.0) * clamp(uMurkGrainStrength, 0.0, 2.0);
          grain *= smoothstep(0.45, 0.95, cloud) * depthFactor;

          float murkFactor = clamp(cloud * depthFactor * murkIntensity * inside, 0.0, 1.0);
          murkFactorOut = murkFactor;

          vec3 murkColor = clamp(uMurkColor, vec3(0.0), vec3(1.0));
          float darkness = clamp(uSceneDarkness, 0.0, 1.0);
          float murkDarkScale = mix(1.0, 0.22, darkness);
          float baseLuma = dot(baseColor, vec3(0.299, 0.587, 0.114));
          float localLight = clamp(0.35 + baseLuma * 0.85, 0.2, 1.0);
          vec3 muckyCol = mix(murkColor * 0.6, murkColor, cloud);
          muckyCol *= murkDarkScale * localLight;
          muckyCol += grain * 0.35 * murkDarkScale * localLight;

          return mix(baseColor, muckyCol, murkFactor);
        }

        void main() {
          vec4 base = texture2D(tDiffuse, vUv);

          float isEnabled = step(0.5, uWaterEnabled) * step(0.5, uHasWaterData);
          if (isEnabled < 0.5) {
            gl_FragColor = base;
            return;
          }

          // Tokens should not be refracted/tinted by water. Since tokens now render into the
          // main scene buffer, we need to explicitly mask them out of this screen-space pass.
          if (uHasTokenMask > 0.5) {
            float tm = texture2D(tTokenMask, vUv).a;
            float tokenCut = smoothstep(0.1, 0.9, tm);
            if (tokenCut > 0.01) {
              gl_FragColor = base;
              return;
            }
          }

          vec2 sceneUv = vUv;
          vec2 worldSceneUv = vUv;
          if (uHasSceneRect > 0.5) {
            vec2 foundryPos = screenUvToFoundry(vUv);
            sceneUv = foundryToSceneUv(foundryPos);
            // worldSceneUv must be in sceneRect-normalized space, matching foundryToSceneUv.
            worldSceneUv = sceneUv;
            float inScene =
              step(0.0, sceneUv.x) * step(sceneUv.x, 1.0) *
              step(0.0, sceneUv.y) * step(sceneUv.y, 1.0);
            if (inScene < 0.5) {
              gl_FragColor = base;
              return;
            }
            sceneUv = clamp(sceneUv, vec2(0.0), vec2(1.0));
          }

          vec4 wd = texture2D(tWaterData, sceneUv);
          float sdf01 = wd.r;
          float exposure01 = wd.g;
          vec2 n2 = wd.ba * 2.0 - 1.0;

          float inside = waterInsideFromSdf(sdf01);
          float shore = clamp(exposure01, 0.0, 1.0);

          float waterOccluder = 0.0;
          if (uHasWaterOccluderAlpha > 0.5) {
            waterOccluder = texture2D(tWaterOccluderAlpha, vUv).a;
          }
          float depthOccluder = 0.0;
          if (uDepthEnabled > 0.5) {
            float deviceDepth = msa_sampleDeviceDepth(vUv);
            if (deviceDepth < 0.9999) {
              float linearDepth = msa_linearizeDepth(deviceDepth);
              float aboveGround = uGroundDistance - linearDepth;
              float aboveActiveFloor = aboveGround - uActiveLevelElevation;
              // Keep normal tile layers (BG/FG at ~+1/+2) eligible for water.
              // Only treat higher foreground occluders (tokens/overheads, ~+3 and above)
              // as blockers for this post-pass.
              // IMPORTANT: Use height relative to the active Levels floor so
              // upper-floor BG/FG tiles don't fully occlude water when viewing
              // higher floors.
              depthOccluder = smoothstep(2.75, 3.25, aboveActiveFloor);
            }
          }

          float waterVisible = (1.0 - clamp(waterOccluder, 0.0, 1.0)) * (1.0 - depthOccluder);
          inside *= waterVisible;

          float distInside = distortionInsideFromSdf(sdf01) * waterVisible;
          float distMask = distInside * shoreFactor(shore);

          if (uDebugView > 0.5) {
            float d = floor(uDebugView + 0.5);
            if (d < 1.5) {
              if (uHasWaterRawMask < 0.5) {
                gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0);
              } else {
                float raw01 = texture2D(tWaterRawMask, sceneUv).r;
                gl_FragColor = vec4(vec3(raw01), 1.0);
              }
              return;
            }
            if (d < 2.5) {
              gl_FragColor = vec4(vec3(inside), 1.0);
              return;
            }
            if (d < 3.5) {
              gl_FragColor = vec4(vec3(sdf01), 1.0);
              return;
            }
            if (d < 4.5) {
              gl_FragColor = vec4(vec3(exposure01), 1.0);
              return;
            }
            if (d < 5.5) {
              vec2 nn = smoothFlow2D(sceneUv);
              gl_FragColor = vec4(nn * 0.5 + 0.5, 0.0, 1.0);
              return;
            }
            if (d < 6.5) {
              float wv = 0.5 + 0.5 * waveHeight(sceneUv, uWindTime, 1.0);
              gl_FragColor = vec4(vec3(wv), 1.0);
              return;
            }
            if (d < 7.5) {
              vec2 waveGrad = waveGrad2D(sceneUv, uWindTime, 1.0);
              vec2 flowN = smoothFlow2D(sceneUv);

              float outdoorStrength = 1.0;
              if (uHasOutdoorsMask > 0.5) {
                outdoorStrength = sampleOutdoorsMask(worldSceneUv);
              }
              float dampStrength = clamp(uWaveIndoorDampingStrength, 0.0, 1.0);
              float minFactor = clamp(uWaveIndoorMinFactor, 0.0, 1.0);
              float targetFactor = mix(minFactor, 1.0, clamp(outdoorStrength, 0.0, 1.0));
              float indoorDamp = (uWaveIndoorDampingEnabled > 0.5) ? mix(1.0, targetFactor, dampStrength) : 1.0;

              float waveStrength = uWaveStrength * indoorDamp;
              float distortionPx = uDistortionStrengthPx * indoorDamp;

              vec2 combinedVec = waveGrad * waveStrength + flowN * 0.35;
              combinedVec = combinedVec / (1.0 + 0.75 * length(combinedVec));
              float m = length(combinedVec);
              float dirMask = smoothstep(0.01, 0.06, m);
              vec2 combinedN = (m > 1e-6) ? (combinedVec / m) * dirMask : vec2(0.0);
              float amp = smoothstep(0.0, 0.30, m);
              amp *= amp;
              vec2 texel = 1.0 / max(uResolution, vec2(1.0));
              float px = clamp(distortionPx, 0.0, 64.0);
              float zoom = max(uZoom, 0.001);
              vec2 offsetUv = combinedN * (px * texel) * amp * distMask * zoom;

              // Add rain-hit distortion in px-space (converted to UV).
              vec2 rainOffPx = computeRainOffsetPx(worldSceneUv);
              offsetUv += (rainOffPx * texel) * distMask * zoom;
              vec2 pxOff = offsetUv / max(texel, vec2(1e-6));
              pxOff = clamp(pxOff / max(1.0, px), vec2(-1.0), vec2(1.0));
              gl_FragColor = vec4(pxOff * 0.5 + 0.5, 0.0, 1.0);
              return;
            }
            if (d < 12.5) {
              float outdoorStrength = 1.0;
              if (uHasOutdoorsMask > 0.5) {
                outdoorStrength = sampleOutdoorsMask(worldSceneUv);
              }
              gl_FragColor = vec4(vec3(clamp(outdoorStrength, 0.0, 1.0)), 1.0);
              return;
            }
            if (d < 8.5) {
              gl_FragColor = vec4(vec3(waterOccluder), 1.0);
              return;
            }
            if (d < 9.5) {
              float t01 = fract(uTime * 0.25);
              gl_FragColor = vec4(vec3(t01), 1.0);
              return;
            }
            if (d < 10.5) {
              float sandAspect = (uHasSceneRect > 0.5) ? (uSceneRect.z / max(1.0, uSceneRect.w)) : (uResolution.x / max(1.0, uResolution.y));
              #ifdef USE_SAND
              float sandMaskOut = sandMask(sceneUv, shore, inside, sandAspect);
              #else
              float sandMaskOut = 0.0;
              #endif
              gl_FragColor = vec4(vec3(clamp(sandMaskOut, 0.0, 1.0)), 1.0);
              return;
            }
            if (d < 11.5) {
              vec2 rainOffPxDebug = computeRainOffsetPx(worldSceneUv);
              float foamAmount = getFoamBaseAmount(sceneUv, shore, inside, rainOffPxDebug);
              gl_FragColor = vec4(vec3(clamp(foamAmount, 0.0, 1.0)), 1.0);
              return;
            }
            gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0);
            return;
          }

          if (inside < 0.01) {
            gl_FragColor = base;
            return;
          }

          // Animated refraction / distortion.
          // Stability rule: pixel offsets must be in pixels then scaled by screen texel size.
          vec2 waveGrad = waveGrad2D(sceneUv, uWindTime, 1.0);
          // Appearance-only rotation: rotates the wave normal/distortion texture without changing
          // the underlying wave travel direction (phase propagation).
          // Add a 90-degree correction so crest lines visually align perpendicular
          // to the wind-driven travel direction.
          waveGrad = rotate2D(waveGrad, uWaveAppearanceRotRad + 1.5707963);
          vec2 flowN = smoothFlow2D(sceneUv);

          // Indoor / covered damping driven by _Outdoors mask.
          // _Outdoors: 1 = outdoors, 0 = indoors/covered.
          // Use worldSceneUv (world-space normalized) for mask sampling, not water-local sceneUv.
          float outdoorStrength = 1.0;
          if (uHasOutdoorsMask > 0.5) {
            outdoorStrength = sampleOutdoorsMask(worldSceneUv);
          }

          float dampStrength = clamp(uWaveIndoorDampingStrength, 0.0, 1.0);
          float minFactor = clamp(uWaveIndoorMinFactor, 0.0, 1.0);
          float targetFactor = mix(minFactor, 1.0, clamp(outdoorStrength, 0.0, 1.0));
          float indoorDamp = (uWaveIndoorDampingEnabled > 0.5) ? mix(1.0, targetFactor, dampStrength) : 1.0;

          // Motion damping: slows time-driven evolution and advection indoors.
          // Use the same indoorDamp factor so users can tune both amplitude + motion together.
          float indoorMotion = clamp(indoorDamp, 0.0, 1.0);

          float waveStrength = uWaveStrength * indoorDamp;
          float distortionPx = uDistortionStrengthPx * indoorDamp;

          // Recompute wave/flow using locally-damped time so indoor water moves less.
          float localWindTime = uWindTime * indoorMotion;
          vec2 waveGradLocal = waveGrad2D(sceneUv, localWindTime, indoorMotion);
          vec2 flowNLocal = smoothFlow2D(sceneUv);
          vec2 combinedVec = waveGradLocal * waveStrength + flowNLocal * 0.35;

          combinedVec = combinedVec / (1.0 + 0.75 * length(combinedVec));
          float m = length(combinedVec);
          float dirMask = smoothstep(0.01, 0.06, m);
          vec2 combinedN = (m > 1e-6) ? (combinedVec / m) * dirMask : vec2(0.0);
          float amp = smoothstep(0.0, 0.30, m);
          amp *= amp;
          vec2 texel = 1.0 / max(uResolution, vec2(1.0));
          float px = clamp(distortionPx, 0.0, 64.0);
          float zoom = max(uZoom, 0.001);
          vec2 offsetUvRaw = combinedN * (px * texel) * amp * zoom;

          // Rain-hit distortion in px-space.
          vec2 rainOffPx = computeRainOffsetPx(worldSceneUv);
          offsetUvRaw += (rainOffPx * texel) * zoom;

          // Apply shoreline + occluder gating to the *refraction* offset.
          // Specular uses the raw field and is faded separately to avoid "cutout" artifacts.
          vec2 offsetUv = offsetUvRaw * distMask;

          // Depth-tested refraction guard: avoid pulling foreground/shore pixels into water.
          // If the refracted sample is closer to camera than the current pixel, treat it as
          // a likely shoreline leak and suppress refraction for this fragment.
          if (uDepthEnabled > 0.5) {
            float srcDepth = msa_sampleDeviceDepth(vUv);
            vec2 refrUv = clamp(vUv + offsetUv, vec2(0.001), vec2(0.999));
            float dstDepth = msa_sampleDeviceDepth(refrUv);
            if (srcDepth < 0.9999 && dstDepth < 0.9999) {
              float srcLinear = msa_linearizeDepth(srcDepth);
              float dstLinear = msa_linearizeDepth(dstDepth);
              if (dstLinear + 0.001 < srcLinear) {
                offsetUv = vec2(0.0);
              }
            }
          }

          vec2 uv1 = clamp(vUv + offsetUv, vec2(0.001), vec2(0.999));

          // Default: single-tap refraction (bandwidth efficient).
          // Optional: multi-tap smoothing and chromatic aberration are enabled via defines.
          #ifdef USE_WATER_REFRACTION_MULTITAP
          vec2 uv0 = clamp(vUv + offsetUv * 0.55, vec2(0.001), vec2(0.999));
          vec2 uv2 = clamp(vUv + offsetUv * 1.55, vec2(0.001), vec2(0.999));
          vec4 refracted =
            texture2D(tDiffuse, uv0) * 0.25 +
            texture2D(tDiffuse, uv1) * 0.50 +
            texture2D(tDiffuse, uv2) * 0.25;
          #else
          vec4 refracted = texture2D(tDiffuse, uv1);
          #endif

          #ifdef USE_WATER_CHROMATIC_ABERRATION
          vec2 texel2 = 1.0 / max(uResolution, vec2(1.0));
          float caPx = clamp(uChromaticAberrationStrengthPx, 0.0, 12.0);
          vec2 dir = offsetUv;
          float dirLen = length(dir);
          vec2 dirN = (dirLen > 1e-6) ? (dir / dirLen) : vec2(1.0, 0.0);
          
          float caEdgeMask = chromaticInsideFromSdf(sdf01);
          vec2 caUv = dirN * (caPx * texel2) * clamp(0.25 + 2.0 * distMask, 0.0, 2.5) * zoom * caEdgeMask;

          vec2 uvR = clamp(uv1 + caUv, vec2(0.001), vec2(0.999));
          vec2 uvB = clamp(uv1 - caUv, vec2(0.001), vec2(0.999));
          float rr = texture2D(tDiffuse, uvR).r;
          float bb = texture2D(tDiffuse, uvB).b;
          refracted.rgb = vec3(rr, refracted.g, bb);
          #endif

          vec3 col = refracted.rgb;

          // Subsurface murk volume (silt/algae/mud), depth-aware and clouded.
          float murkFactor = 0.0;
          col = applyMurk(col, sceneUv, shore, inside, uTime, murkFactor);

          // Surface tint sits on top of murk; fade it when murk is already dense.
          float effectiveTint = clamp(uTintStrength, 0.0, 1.0) * (1.0 - (murkFactor * 0.5));
          float k = effectiveTint * inside * shore;
          col = mix(col, uTintColor, k);

          // Water-specific cloud shadow coupling:
          // - Darken the water body under cloud shadow
          // - Suppress specular glints under cloud shadow
          // This increases shadow readability for tinted/distorted water.
          float cloudShadow = 0.0;
          float cloudLitRaw = 1.0;
          float cloudLitNorm = 1.0;
          float cloudOcclusionNorm = 0.0;
          if (uCloudShadowEnabled > 0.5 && uHasCloudShadow > 0.5) {
            cloudLitRaw = texture2D(tCloudShadow, vUv).r;
            cloudShadow = clamp(1.0 - cloudLitRaw, 0.0, 1.0);

            // CloudEffect supports a minimum brightness clamp to avoid crushing shadows.
            // For specular suppression we want the *darkest* cloud pixels to map to ~0.0
            // so specular can actually be removed.
            float minB = clamp(uCloudShadowMinBrightness, 0.0, 0.99);
            cloudLitNorm = clamp((cloudLitRaw - minB) / max(1e-5, 1.0 - minB), 0.0, 1.0);

            // Normalize cloud occlusion so specular suppression follows cloud coverage,
            // not cloud shadow darkness. This decouples glint suppression from
            // CloudEffect shadowOpacity/minBrightness artistic controls.
            float shadowOpacity = clamp(uCloudShadowOpacity, 0.0, 1.0);
            cloudOcclusionNorm = (shadowOpacity > 1e-3)
              ? clamp((1.0 - cloudLitNorm) / shadowOpacity, 0.0, 1.0)
              : 0.0;

            float dStrength = clamp(uCloudShadowDarkenStrength, 0.0, 4.0);
            float dCurve = max(0.01, uCloudShadowDarkenCurve);
            float darken = dStrength * pow(cloudShadow, dCurve);
            col *= max(0.0, 1.0 - darken);
          }

          // Underwater sand flurries: chunked patches with fine grain, advected with water flow.
          #ifdef USE_SAND
          float sandAspect = (uHasSceneRect > 0.5) ? (uSceneRect.z / max(1.0, uSceneRect.w)) : (uResolution.x / max(1.0, uResolution.y));
          float sandAlpha = sandMask(sceneUv, shore, inside, sandAspect);
          col = mix(col, uSandColor, sandAlpha);
          col += uSandColor * (sandAlpha * clamp(uSandAdditive, 0.0, 1.0));
          #endif

          // Foam bubbles around shorelines (exposure01/shore), broken up with animated grain.
          // shore: 0.0 in deep water, 1.0 at water boundary.
          float foamAmount = getFoamBaseAmount(sceneUv, shore, inside, rainOffPx);

          float foamVisual = clamp(foamAmount, 0.0, 1.0);

          // Make the foam blend more opaque so underlying refracted dark detail
          // (sand, refraction, etc.) does not shimmer through and read as "dark foam noise".
          float foamAlpha = smoothstep(0.08, 0.35, foamVisual);
          foamAlpha = pow(foamAlpha, 0.75);

          // Foam should not appear self-illuminated.
          // - Use the already-lit scene color (after Lighting/shadows) as the local light proxy.
          // - Also apply the global scene darkness scalar so foam becomes very dark at night.
          float sceneLuma = dot(col, vec3(0.299, 0.587, 0.114));
          float darkness = clamp(uSceneDarkness, 0.0, 1.0);
          float foamDarkScale = mix(1.0, 0.08, darkness);
          float foamLightScale = clamp(sceneLuma * 1.15, 0.0, 1.0);
          vec3 foamCol = uFoamColor * max(0.02, foamLightScale) * foamDarkScale;
          col = mix(col, foamCol, foamAlpha);

          // Shader-based foam flecks: high-frequency spray dots blown downwind
          vec2 windUv2 = uWindDir;
          float wLen2 = length(windUv2);
          vec2 windF2 = (wLen2 > 1e-6) ? (windUv2 / wLen2) : vec2(1.0, 0.0);
          vec2 windDir2 = vec2(windF2.x, -windF2.y);
          vec2 sprayUv = sceneUv;

          float shaderFlecks = getShaderFlecks(sprayUv, shore, inside, foamAlpha);
          // Additive blend for bright spray dots
          col += foamCol * shaderFlecks * 0.8;

          // Specular highlight (directional sun glint; GGX microfacet).
          // Use the wave gradient as the primary normal proxy (it's actually a surface gradient),
          // then optionally inject rain/distortion as extra micro-normal detail.
          vec2 slope = (waveGrad * waveStrength + flowN * 0.35) * clamp(uSpecNormalStrength, 0.0, 10.0);
          vec2 rainSlope = rainOffPx / max(1.0, uRainMaxCombinedStrengthPx);
          slope += (rainSlope * 0.9) * clamp(uSpecDistortionNormalStrength, 0.0, 5.0);
          slope *= clamp(uSpecNormalScale, 0.0, 1.0);

          // Cheap anisotropy: stretch the slope field along wind direction to create
          // elongated glints (common for wind-driven water).
          float an = clamp(uSpecAnisotropy, 0.0, 1.0);
          if (an > 1e-4) {
            vec2 wd = uWindDir;
            float wl = length(wd);
            wd = (wl > 1e-6) ? (wd / wl) : vec2(1.0, 0.0);
            // Convert Foundry Y-down to math Y-up.
            wd.y = -wd.y;
            vec2 t = wd;
            vec2 b = vec2(-t.y, t.x);
            vec2 s = vec2(dot(slope, t), dot(slope, b));
            float ratio = clamp(uSpecAnisoRatio, 1.0, 16.0);
            float along = mix(1.0, 1.0 / ratio, an);
            float across = mix(1.0, ratio, an);
            s = vec2(s.x * along, s.y * across);
            slope = t * s.x + b * s.y;
          }

          vec3 N = normalize(vec3(-slope.x, -slope.y, 1.0));
          vec3 V = vec3(0.0, 0.0, 1.0);
          vec3 L = normalize(uSpecSunDir);

          float NoV = clamp(dot(N, V), 0.0, 1.0);
          float NoL = clamp(dot(N, L), 0.0, 1.0);
          vec3 H = normalize(L + V);
          float NoH = clamp(dot(N, H), 0.0, 1.0);
          float VoH = clamp(dot(V, H), 0.0, 1.0);

          float p01 = clamp((uSpecPower - 1.0) / 23.0, 0.0, 1.0);
          float rMin = clamp(uSpecRoughnessMin, 0.001, 1.0);
          float rMax = clamp(uSpecRoughnessMax, 0.001, 1.0);
          float a0 = min(rMin, rMax);
          float a1 = max(rMax, a0 + 1e-4);
          float rough = mix(a1, a0, p01);
          float alpha = max(0.001, rough * rough);

          // GGX normal distribution function.
          float a2 = alpha * alpha;
          float dDen = (NoH * NoH) * (a2 - 1.0) + 1.0;
          float D = a2 / max(1e-6, 3.14159265 * dDen * dDen);

          // Schlick-GGX geometry term (Smith).
          float ggxK = (rough + 1.0);
          ggxK = (ggxK * ggxK) / 8.0;
          float Gv = NoV / max(1e-6, NoV * (1.0 - ggxK) + ggxK);
          float Gl = NoL / max(1e-6, NoL * (1.0 - ggxK) + ggxK);
          float G = Gv * Gl;

          // Fresnel (Schlick). Water F0 is low but very noticeable at grazing angles.
          float f0 = clamp(uSpecF0, 0.0, 1.0);
          vec3 F0 = vec3(f0);
          vec3 F = F0 + (1.0 - F0) * pow(1.0 - VoH, 5.0);

          vec3 specBRDF = (D * G) * F / max(1e-6, 4.0 * NoV * NoL);
          vec3 spec = specBRDF * NoL;

          // Kill specular in cloud shadows (water-only)
          if (uCloudShadowEnabled > 0.5 && cloudShadow > 1e-5) {
            float kStrength = clamp(uCloudShadowSpecularKill, 0.0, 1.0);
            float kCurve = max(0.01, uCloudShadowSpecularCurve);
            float specLit = clamp(1.0 - cloudOcclusionNorm, 0.0, 1.0);
            float litPow = pow(specLit, kCurve);
            float specMul = mix(1.0, litPow, kStrength);
            spec *= clamp(specMul, 0.0, 1.0);
          }

          // Fade specular using the distortion "inside" (edge fade) only.
          // This keeps spec continuous across the water surface while still
          // respecting the water boundary and occluder.
          float specMask = pow(clamp(distInside, 0.0, 1.0), clamp(uSpecMaskGamma, 0.05, 12.0));
          spec *= specMask;

          // Optional shore bias so glints can cluster near more visible wave detail.
          float shoreBias = mix(1.0, shore, clamp(uSpecShoreBias, 0.0, 1.0));
          spec *= shoreBias;

          // Strength scaling.
          float strength = clamp(uSpecStrength, 0.0, 250.0) / 50.0;
          spec *= strength * clamp(uSpecSunIntensity, 0.0, 10.0);

          // Do not shine in darkness.
          spec *= mix(1.0, 0.05, clamp(uSceneDarkness, 0.0, 1.0));

          // Tint by sky (reflection color).
          vec3 skyCol = clamp(uSkyColor, vec3(0.0), vec3(1.0));
          float skyI = clamp(uSkyIntensity, 0.0, 1.0);
          float skySpecI = mix(0.08, 1.0, skyI);
          vec3 tint = mix(vec3(1.0), skyCol, clamp(uSpecSkyTint, 0.0, 1.0));
          col += spec * tint * skySpecI;

          gl_FragColor = vec4(col, base.a);
        }
      `,
      depthWrite: false,
      depthTest: false
    });

    // Set ALL initial defines to match what update() will compute on first call.
    // This avoids a wasted recompilation: initialize() used to set only sand/flecks,
    // then update() would detect the mismatch and set needsUpdate=true for multitap/chrom.
    const sandEnabled = !!this.params?.sandEnabled;
    const flecksEnabled = !!this.params?.foamFlecksEnabled;
    const multiTapEnabled = this.params?.refractionMultiTapEnabled === true;
    const chromEnabled = this.params?.chromaticAberrationEnabled === true;
    const initDefines = {};
    if (sandEnabled) initDefines.USE_SAND = 1;
    if (flecksEnabled) initDefines.USE_FOAM_FLECKS = 1;
    if (multiTapEnabled) initDefines.USE_WATER_REFRACTION_MULTITAP = 1;
    if (chromEnabled) initDefines.USE_WATER_CHROMATIC_ABERRATION = 1;
    this._material.defines = initDefines;
    this._lastDefinesKey = (sandEnabled ? DEF_SAND : 0)
      | (flecksEnabled ? DEF_FOAM_FLECKS : 0)
      | (multiTapEnabled ? DEF_MULTITAP : 0)
      | (chromEnabled ? DEF_CHROM_AB : 0);
    this._material.needsUpdate = true;

    // Generate the tileable noise texture that replaces procedural hash-based noise.
    // This 512x512 RGBA texture (4 independent noise channels) eliminates hundreds
    // of inlined hash12 calls and cuts ANGLE/D3D11 shader compilation time dramatically.
    this._noiseTexture = WaterEffectV2._createNoiseTexture(THREE);
    this._material.uniforms.tNoiseMap.value = this._noiseTexture;

    this._quadMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._material);
    this._quadScene.add(this._quadMesh);

    const size = this._tempSize ?? (this._tempSize = new THREE.Vector2());
    renderer.getDrawingBufferSize(size);
    this.onResize(size.x, size.y);

    log.info('Initialized WaterEffectV2');
  }

  setInputTexture(texture) {
    if (this._material) {
      this._material.uniforms.tDiffuse.value = texture;
    }

    this._inputTexture = texture;
  }

  setWaterOccluderAlphaTexture(texture) {
    this._waterOccluderAlpha = texture || null;
    if (this._material?.uniforms?.tWaterOccluderAlpha) {
      this._material.uniforms.tWaterOccluderAlpha.value = this._waterOccluderAlpha;
      this._material.uniforms.uHasWaterOccluderAlpha.value = this._waterOccluderAlpha ? 1.0 : 0.0;
    }
  }

  setBuffers(readBuffer, writeBuffer) {
    this._readBuffer = readBuffer;
    this._writeBuffer = writeBuffer;
  }

  setRenderToScreen(isLast) {
    this.renderToScreen = !!isLast;
  }

  setBaseMesh(baseMesh, assetBundle) {
    this.baseMesh = baseMesh;

    const waterMaskData = assetBundle?.masks?.find((m) => m.id === 'water' || m.type === 'water');
    this.waterMask = waterMaskData?.texture || null;

    if (!this.waterMask) {
      // No water mask in bundle — clear water data.
      // BLOCKED during floor transitions to preserve ground-floor water
      // when switching to a floor that has no water.
      if (this._floorTransitionActive) return;
      this._waterData = null;
      this._waterRawMask = null;
      this._lastWaterMaskUuid = null;
      this._surfaceModel.dispose();
      return;
    }

    const THREE = window.THREE;
    if (THREE) {
      this.waterMask.minFilter = THREE.LinearFilter;
      this.waterMask.magFilter = THREE.LinearFilter;
      this.waterMask.generateMipmaps = false;
      this.waterMask.flipY = false;
      this.waterMask.needsUpdate = true;
    }

    this._rebuildWaterDataIfNeeded(true);
  }

  getWaterDataTexture() {
    return this._waterData?.texture || null;
  }

  getWaterData() {
    return {
      texture: this._waterData?.texture || null,
      transform: this._waterData?.transform || null,
      flowEnabled: false,
      precision: 'u8'
    };
  }

  getWaterMaskTexture() {
    return this.waterMask || null;
  }

  update(timeInfo) {
    if (!this._material) return;

    this._ensureParamsProxy();

    const THREE = window.THREE;
    const u = this._material.uniforms;
    const staticUniformsDirty = this._paramsDirty === true;

    // Bind shared module depth-pass uniforms for depth-aware water occlusion.
    DepthShaderChunks.bindDepthPass(u);

    // Global scene darkness coupling (0 = fully lit, 1 = max darkness).
    // Used to prevent surface foam from appearing self-illuminated at night.
    if (u.uSceneDarkness) {
      let sceneDarkness = 0;
      try {
        const le = window.MapShine?.lightingEffect ?? window.canvas?.mapShine?.lightingEffect;
        if (le && typeof le.getEffectiveDarkness === 'function') {
          sceneDarkness = le.getEffectiveDarkness();
        } else if (typeof canvas !== 'undefined' && canvas?.scene?.environment?.darknessLevel !== undefined) {
          sceneDarkness = canvas.scene.environment.darknessLevel;
        }
      } catch (e) {
        // Keep default.
      }
      sceneDarkness = Math.max(0, Math.min(1, sceneDarkness));
      u.uSceneDarkness.value = sceneDarkness;
    }

    // Sky/environment coupling for water specular tint.
    if (u.uSkyColor && u.uSkyIntensity && THREE) {
      try {
        const wc = window.MapShine?.weatherController ?? window.canvas?.mapShine?.weatherController;
        const env = (wc && typeof wc.getEnvironment === 'function') ? wc.getEnvironment() : null;
        const sc = env?.skyColor;
        if (sc && typeof sc.r === 'number' && typeof sc.g === 'number' && typeof sc.b === 'number') {
          u.uSkyColor.value.setRGB(sc.r, sc.g, sc.b);
        }
        const si = env?.skyIntensity;
        u.uSkyIntensity.value = (typeof si === 'number' && Number.isFinite(si)) ? Math.max(0.0, Math.min(1.0, si)) : 1.0;
      } catch (_) {
        u.uSkyIntensity.value = 1.0;
      }
    }

	const sandEnabled = !!this.params?.sandEnabled;
	const flecksEnabled = !!this.params?.foamFlecksEnabled;
	const multiTapEnabled = this.params?.refractionMultiTapEnabled === true;
	const chromEnabled = this.params?.chromaticAberrationEnabled === true;
	const definesKey = (sandEnabled ? DEF_SAND : 0)
	  | (flecksEnabled ? DEF_FOAM_FLECKS : 0)
	  | (multiTapEnabled ? DEF_MULTITAP : 0)
	  | (chromEnabled ? DEF_CHROM_AB : 0);
	if (this._lastDefinesKey !== definesKey) {
	  const d = this._material.defines || {};
	  if (sandEnabled) d.USE_SAND = 1;
	  else delete d.USE_SAND;
	  if (flecksEnabled) d.USE_FOAM_FLECKS = 1;
	  else delete d.USE_FOAM_FLECKS;
	  if (multiTapEnabled) d.USE_WATER_REFRACTION_MULTITAP = 1;
	  else delete d.USE_WATER_REFRACTION_MULTITAP;
	  if (chromEnabled) d.USE_WATER_CHROMATIC_ABERRATION = 1;
	  else delete d.USE_WATER_CHROMATIC_ABERRATION;
	  this._material.defines = d;
	  this._material.needsUpdate = true;
	  this._lastDefinesKey = definesKey;
	}

    // Sync water parameters into DistortionManager so its apply-pass can render caustics.
    // DistortionManager is created after WaterEffectV2, so this must be resilient.
    // Keep this after defines/time updates so it can run even when water visuals are disabled.
    try {
      const dm = window.MapShine?.distortionManager;
      if (dm && typeof dm.getSource === 'function' && typeof dm.registerSource === 'function') {
        const waterMask = this.getWaterMaskTexture();
        let src = dm.getSource('water');

        if (!src && waterMask) {
          src = dm.registerSource('water', DistortionLayer.ABOVE_GROUND, waterMask, {
            intensity: 0.0,
            frequency: 1.0,
            speed: 0.0
          });
        }

        if (src) {
          if (typeof dm.updateSourceMask === 'function') {
            dm.updateSourceMask('water', waterMask);
          }
          if (typeof dm.setSourceEnabled === 'function') {
            dm.setSourceEnabled('water', !!(this.enabled && waterMask));
          }
          if (typeof dm.updateSourceParams === 'function') {
            const p = this._distortionWaterParams;
            const waterDataTexture = this.getWaterDataTexture?.() ?? null;
            const distortionParamsDirty = staticUniformsDirty || this._lastDistortionWaterDataTexture !== waterDataTexture;
            if (distortionParamsDirty) {
              p.murkEnabled = this.params?.murkEnabled === true;
              p.murkIntensity = Number.isFinite(this.params?.murkIntensity) ? this.params.murkIntensity : 0.65;
              p.murkColor = normalizeRgb01(this.params?.murkColor, { r: 0.082, g: 0.204, b: 0.212 });
              p.murkScale = Number.isFinite(this.params?.murkScale) ? this.params.murkScale : 2.25;
              p.murkSpeed = Number.isFinite(this.params?.murkSpeed) ? this.params.murkSpeed : 0.15;
              p.murkDepthLo = Number.isFinite(this.params?.murkDepthLo) ? this.params.murkDepthLo : 0.35;
              p.murkDepthHi = Number.isFinite(this.params?.murkDepthHi) ? this.params.murkDepthHi : 0.95;
              p.murkGrainScale = Number.isFinite(this.params?.murkGrainScale) ? this.params.murkGrainScale : 3200.0;
              p.murkGrainSpeed = Number.isFinite(this.params?.murkGrainSpeed) ? this.params.murkGrainSpeed : 0.9;
              p.murkGrainStrength = Number.isFinite(this.params?.murkGrainStrength) ? this.params.murkGrainStrength : 0.65;
              p.murkOcclusionStrength = Number.isFinite(this.params?.murkOcclusionStrength) ? this.params.murkOcclusionStrength : 0.55;
              p.murkOcclusionSoftness = Number.isFinite(this.params?.murkOcclusionSoftness) ? this.params.murkOcclusionSoftness : 0.2;
              p.murkContrast = Number.isFinite(this.params?.murkContrast) ? this.params.murkContrast : 1.6;

              // Reuse WaterEffectV2 sand contrast to tighten DistortionManager's subsurface sand.
              p.sandContrast = Number.isFinite(this.params?.sandContrast) ? this.params.sandContrast : 1.35;

              p.shoreNoiseEnabled = this.params?.shoreNoiseDistortionEnabled !== false;
              p.shoreNoiseStrengthPx = Number.isFinite(this.params?.shoreNoiseDistortionStrengthPx) ? this.params.shoreNoiseDistortionStrengthPx : 12.75;
              p.shoreNoiseFrequency = Number.isFinite(this.params?.shoreNoiseDistortionFrequency) ? this.params.shoreNoiseDistortionFrequency : 526.1;
              p.shoreNoiseSpeed = Number.isFinite(this.params?.shoreNoiseDistortionSpeed) ? this.params.shoreNoiseDistortionSpeed : 4.31;
              p.shoreNoiseFadeLo = Number.isFinite(this.params?.shoreNoiseDistortionFadeLo) ? this.params.shoreNoiseDistortionFadeLo : 0.112;
              p.shoreNoiseFadeHi = Number.isFinite(this.params?.shoreNoiseDistortionFadeHi) ? this.params.shoreNoiseDistortionFadeHi : 0.601;
              p.shoreNoiseCurlStrength = Number.isFinite(this.params?.shoreNoiseDistortionCurlStrength) ? this.params.shoreNoiseDistortionCurlStrength : 0.45;
              p.shoreNoiseWashStrength = Number.isFinite(this.params?.shoreNoiseDistortionWashStrength) ? this.params.shoreNoiseDistortionWashStrength : 0.51;
              p.shoreNoiseWashSpeed = Number.isFinite(this.params?.shoreNoiseDistortionWashSpeed) ? this.params.shoreNoiseDistortionWashSpeed : 0.8;

              // Provide WaterData so DistortionManager can derive a shoreline band pinned to
              // the true land/water boundary (exposure01 == 0 at the edge).
              p.waterDataTexture = waterDataTexture;

              p.causticsEnabled = this.params?.causticsEnabled !== false;
              p.causticsIntensity = Number.isFinite(this.params?.causticsIntensity) ? this.params.causticsIntensity : 4;
              p.causticsScale = Number.isFinite(this.params?.causticsScale) ? this.params.causticsScale : 60.4;
              p.causticsSpeed = Number.isFinite(this.params?.causticsSpeed) ? this.params.causticsSpeed : 1.83;
              p.causticsSharpness = Number.isFinite(this.params?.causticsSharpness) ? this.params.causticsSharpness : 1.36;
              p.causticsEdgeLo = Number.isFinite(this.params?.causticsEdgeLo) ? this.params.causticsEdgeLo : 0.5;
              p.causticsEdgeHi = Number.isFinite(this.params?.causticsEdgeHi) ? this.params.causticsEdgeHi : 1.0;
              p.causticsEdgeBlurTexels = Number.isFinite(this.params?.causticsEdgeBlurTexels) ? this.params.causticsEdgeBlurTexels : 4.0;

              p.causticsBrightnessMaskEnabled = this.params?.causticsBrightnessMaskEnabled === true;
              p.causticsBrightnessThreshold = Number.isFinite(this.params?.causticsBrightnessThreshold) ? this.params.causticsBrightnessThreshold : 0.24;
              p.causticsBrightnessSoftness = Number.isFinite(this.params?.causticsBrightnessSoftness) ? this.params.causticsBrightnessSoftness : 0.25;
              p.causticsBrightnessGamma = Number.isFinite(this.params?.causticsBrightnessGamma) ? this.params.causticsBrightnessGamma : 0.62;

              p.causticsDebug = this.params?.causticsDebug === true;
              p.causticsIgnoreLightGate = this.params?.causticsIgnoreLightGate === true;

              p.cloudShadowCausticsKill = Number.isFinite(this.params?.cloudShadowCausticsKill) ? this.params.cloudShadowCausticsKill : 1.0;
              p.cloudShadowCausticsCurve = Number.isFinite(this.params?.cloudShadowCausticsCurve) ? this.params.cloudShadowCausticsCurve : 0.1;

              dm.updateSourceParams('water', p);
              this._lastDistortionWaterDataTexture = waterDataTexture;
            }
          }
        }
      }
    } catch (_) {
    }

    const elapsed = Number.isFinite(timeInfo?.elapsed) ? timeInfo.elapsed : 0.0;
    u.uTime.value = elapsed;

    if (u.uZoom) {
      const sceneComposer = window.MapShine?.sceneComposer ?? window.canvas?.mapShine?.sceneComposer;
      const z = sceneComposer?.currentZoom ?? (typeof sceneComposer?.getZoomScale === 'function' ? sceneComposer.getZoomScale() : 1.0);
      u.uZoom.value = Number.isFinite(z) ? z : 1.0;
    }

    if (staticUniformsDirty && u.uChromaticAberrationStrengthPx) {
      const v = this.params?.chromaticAberrationStrengthPx;
      u.uChromaticAberrationStrengthPx.value = Number.isFinite(v) ? Math.max(0.0, v) : 1.78;
    }

    if (staticUniformsDirty && u.uChromaticAberrationEdgeCenter) {
      const v = this.params?.chromaticAberrationEdgeCenter;
      u.uChromaticAberrationEdgeCenter.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.5;
    }
    if (staticUniformsDirty && u.uChromaticAberrationEdgeFeather) {
      const v = this.params?.chromaticAberrationEdgeFeather;
      u.uChromaticAberrationEdgeFeather.value = Number.isFinite(v) ? Math.max(0.0, Math.min(0.5, v)) : 0.1;
    }
    if (staticUniformsDirty && u.uChromaticAberrationEdgeGamma) {
      const v = this.params?.chromaticAberrationEdgeGamma;
      u.uChromaticAberrationEdgeGamma.value = Number.isFinite(v) ? Math.max(0.01, v) : 1.0;
    }
    if (staticUniformsDirty && u.uChromaticAberrationEdgeMin) {
      const v = this.params?.chromaticAberrationEdgeMin;
      u.uChromaticAberrationEdgeMin.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.0;
    }

    const dtSeconds = (this._lastTimeValue === null) ? 0.0 : Math.max(0.0, elapsed - this._lastTimeValue);

    if (this._lastTimeValue === null) {
      this._lastTimeValue = elapsed;
    } else {
      this._lastTimeValue = elapsed;
      if (dtSeconds <= 1e-6) {
        this._timeStallFrames++;
        if (this._timeStallFrames > 120 && !this._timeStallLogged) {
          this._timeStallLogged = true;
          log.warn('WaterEffectV2 time appears stalled (uTime not advancing). Check MapShine timeRate/paused state.');
        }
      } else {
        this._timeStallFrames = 0;
        this._timeStallLogged = false;
      }
    }

    if (staticUniformsDirty) {
      const t = this.params?.tintStrength;
      u.uTintStrength.value = Number.isFinite(t) ? t : 0.2;

      const c = this.params?.tintColor;
      if (c && (typeof c.r === 'number') && (typeof c.g === 'number') && (typeof c.b === 'number')) {
        u.uTintColor.value.setRGB(c.r, c.g, c.b);
      }

      if (u.uSandIntensity) {
        const v = this.params?.sandIntensity;
        u.uSandIntensity.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.5;
      }
      if (u.uSandColor) {
        const sc = this.params?.sandColor;
        if (typeof sc === 'string') {
          u.uSandColor.value.set(sc);
        } else if (sc && (typeof sc.r === 'number') && (typeof sc.g === 'number') && (typeof sc.b === 'number')) {
          const c01 = normalizeRgb01(sc, { r: 0.0, g: 0.0, b: 0.0 });
          u.uSandColor.value.setRGB(c01.r, c01.g, c01.b);
        }
      }
      if (u.uSandContrast) {
        const v = this.params?.sandContrast;
        u.uSandContrast.value = Number.isFinite(v) ? Math.max(0.01, v) : 1.35;
      }
      if (u.uSandChunkScale) {
        const v = this.params?.sandChunkScale;
        u.uSandChunkScale.value = Number.isFinite(v) ? Math.max(0.01, v) : 17.5;
      }
      if (u.uSandChunkSpeed) {
        const v = this.params?.sandChunkSpeed;
        u.uSandChunkSpeed.value = Number.isFinite(v) ? Math.max(0.0, v) : 1.12;
      }
      if (u.uSandGrainScale) {
        const v = this.params?.sandGrainScale;
        u.uSandGrainScale.value = Number.isFinite(v) ? Math.max(1.0, v) : 37.0;
      }
      if (u.uSandGrainSpeed) {
        const v = this.params?.sandGrainSpeed;
        u.uSandGrainSpeed.value = Number.isFinite(v) ? Math.max(0.0, v) : 0.0;
      }
      if (u.uSandBillowStrength) {
        const v = this.params?.sandBillowStrength;
        u.uSandBillowStrength.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.55;
      }

      if (u.uSandCoverage) {
        const v = this.params?.sandCoverage;
        u.uSandCoverage.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 1.0;
      }
      if (u.uSandChunkSoftness) {
        const v = this.params?.sandChunkSoftness;
        u.uSandChunkSoftness.value = Number.isFinite(v) ? Math.max(0.001, Math.min(1.0, v)) : 0.37;
      }
      if (u.uSandSpeckCoverage) {
        const v = this.params?.sandSpeckCoverage;
        u.uSandSpeckCoverage.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.81;
      }
      if (u.uSandSpeckSoftness) {
        const v = this.params?.sandSpeckSoftness;
        u.uSandSpeckSoftness.value = Number.isFinite(v) ? Math.max(0.001, Math.min(1.0, v)) : 0.33;
      }
      if (u.uSandDepthLo) {
        const v = this.params?.sandDepthLo;
        u.uSandDepthLo.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.15;
      }
      if (u.uSandDepthHi) {
        const v = this.params?.sandDepthHi;
        u.uSandDepthHi.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.90;
      }
      if (u.uSandAnisotropy) {
        const v = this.params?.sandAnisotropy;
        u.uSandAnisotropy.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 1.0;
      }
      if (u.uSandDistortionStrength) {
        const v = this.params?.sandDistortionStrength;
        u.uSandDistortionStrength.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.0;
      }
      if (u.uSandAdditive) {
        const v = this.params?.sandAdditive;
        u.uSandAdditive.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.0;
      }

      if (u.uFoamColor) {
        const fColor = this.params?.foamColor;
        if (fColor && (typeof fColor.r === 'number') && (typeof fColor.g === 'number') && (typeof fColor.b === 'number')) {
          u.uFoamColor.value.setRGB(fColor.r, fColor.g, fColor.b);
        }
      }

      if (u.uFoamStrength) {
        const fs = this.params?.foamStrength;
        u.uFoamStrength.value = Number.isFinite(fs) ? fs : 0.0;
      }

      if (u.uFoamThreshold) {
        const ft = this.params?.foamThreshold;
        // UI is expressed as "width" where higher values push foam further from shore.
        // In shader space, larger cutoff values yield thinner foam, so invert.
        const width01 = Number.isFinite(ft) ? Math.max(0.0, Math.min(1.0, ft)) : 0.65;
        u.uFoamThreshold.value = 1.0 - width01;
      }

      if (u.uFoamScale) {
        const fsc = this.params?.foamScale;
        u.uFoamScale.value = Number.isFinite(fsc) ? fsc : 80.0;
      }

      if (u.uFoamSpeed) {
        const fsp = this.params?.foamSpeed;
        u.uFoamSpeed.value = Number.isFinite(fsp) ? fsp : 0.1;
      }

      if (u.uFoamCurlStrength) {
        const v = this.params?.foamCurlStrength;
        u.uFoamCurlStrength.value = Number.isFinite(v) ? v : 0.12;
      }

      if (u.uFoamCurlScale) {
        const v = this.params?.foamCurlScale;
        u.uFoamCurlScale.value = Number.isFinite(v) ? Math.max(0.01, v) : 2.2;
      }

      if (u.uFoamCurlSpeed) {
        const v = this.params?.foamCurlSpeed;
        u.uFoamCurlSpeed.value = Number.isFinite(v) ? v : 0.06;
      }

      if (u.uFoamBreakupStrength1) {
        const v = this.params?.foamBreakupStrength1;
        u.uFoamBreakupStrength1.value = Number.isFinite(v) ? v : 0.35;
      }
      if (u.uFoamBreakupScale1) {
        const v = this.params?.foamBreakupScale1;
        u.uFoamBreakupScale1.value = Number.isFinite(v) ? Math.max(0.01, v) : 18.0;
      }
      if (u.uFoamBreakupSpeed1) {
        const v = this.params?.foamBreakupSpeed1;
        u.uFoamBreakupSpeed1.value = Number.isFinite(v) ? v : 0.07;
      }

      if (u.uFoamBreakupStrength2) {
        const v = this.params?.foamBreakupStrength2;
        u.uFoamBreakupStrength2.value = Number.isFinite(v) ? v : 0.20;
      }
      if (u.uFoamBreakupScale2) {
        const v = this.params?.foamBreakupScale2;
        u.uFoamBreakupScale2.value = Number.isFinite(v) ? Math.max(0.01, v) : 6.5;
      }
      if (u.uFoamBreakupSpeed2) {
        const v = this.params?.foamBreakupSpeed2;
        u.uFoamBreakupSpeed2.value = Number.isFinite(v) ? v : 0.03;
      }

      if (u.uFoamBlackPoint) {
        const v = this.params?.foamBlackPoint;
        u.uFoamBlackPoint.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.0;
      }
      if (u.uFoamWhitePoint) {
        const v = this.params?.foamWhitePoint;
        u.uFoamWhitePoint.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 1.0;
      }
      if (u.uFoamGamma) {
        const v = this.params?.foamGamma;
        u.uFoamGamma.value = Number.isFinite(v) ? Math.max(0.01, v) : 1.0;
      }
      if (u.uFoamContrast) {
        const v = this.params?.foamContrast;
        u.uFoamContrast.value = Number.isFinite(v) ? Math.max(0.0, v) : 1.0;
      }
      if (u.uFoamBrightness) {
        const v = this.params?.foamBrightness;
        u.uFoamBrightness.value = Number.isFinite(v) ? v : 0.0;
      }

      if (u.uFloatingFoamStrength) {
        const s = this.params?.floatingFoamStrength;
        u.uFloatingFoamStrength.value = Number.isFinite(s) ? s : 0.0;
      }

      if (u.uFloatingFoamCoverage) {
        const cov = this.params?.floatingFoamCoverage;
        u.uFloatingFoamCoverage.value = Number.isFinite(cov) ? Math.max(0.0, Math.min(1.0, cov)) : 0.22;
      }

      if (u.uFloatingFoamScale) {
        const sc = this.params?.floatingFoamScale;
        u.uFloatingFoamScale.value = Number.isFinite(sc) ? Math.max(0.1, sc) : 12.0;
      }

      if (u.uFloatingFoamWaveDistortion) {
        const wd = this.params?.floatingFoamWaveDistortion;
        u.uFloatingFoamWaveDistortion.value = Number.isFinite(wd) ? Math.max(0.0, wd) : 0.5;
      }

      // Shader-based foam flecks uniform sync
      if (u.uFoamFlecksIntensity) {
        const fi = this.params?.foamFlecksIntensity;
        u.uFoamFlecksIntensity.value = Number.isFinite(fi) ? Math.max(0.0, fi) : 6.0;
      }

      if (u.uMurkEnabled) {
        u.uMurkEnabled.value = this.params?.murkEnabled === false ? 0.0 : 1.0;
      }
      if (u.uMurkIntensity) {
        const v = this.params?.murkIntensity;
        u.uMurkIntensity.value = Number.isFinite(v) ? Math.max(0.0, Math.min(2.0, v)) : 0.85;
      }
      if (u.uMurkColor) {
        const mc = this.params?.murkColor;
        if (mc && (typeof mc.r === 'number') && (typeof mc.g === 'number') && (typeof mc.b === 'number')) {
          const c01 = normalizeRgb01(mc, { r: 0.25, g: 0.18, b: 0.12 });
          u.uMurkColor.value.setRGB(c01.r, c01.g, c01.b);
        }
      }
      if (u.uMurkScale) {
        const v = this.params?.murkScale;
        u.uMurkScale.value = Number.isFinite(v) ? Math.max(0.1, v) : 3.5;
      }
      if (u.uMurkSpeed) {
        const v = this.params?.murkSpeed;
        u.uMurkSpeed.value = Number.isFinite(v) ? Math.max(0.0, v) : 0.15;
      }
      if (u.uMurkDepthLo) {
        const v = this.params?.murkDepthLo;
        u.uMurkDepthLo.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.0;
      }
      if (u.uMurkDepthHi) {
        const v = this.params?.murkDepthHi;
        u.uMurkDepthHi.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 1.0;
      }
      if (u.uMurkGrainScale) {
        const v = this.params?.murkGrainScale;
        u.uMurkGrainScale.value = Number.isFinite(v) ? Math.max(10.0, v) : 3200.0;
      }
      if (u.uMurkGrainSpeed) {
        const v = this.params?.murkGrainSpeed;
        u.uMurkGrainSpeed.value = Number.isFinite(v) ? Math.max(0.0, v) : 0.9;
      }
      if (u.uMurkGrainStrength) {
        const v = this.params?.murkGrainStrength;
        u.uMurkGrainStrength.value = Number.isFinite(v) ? Math.max(0.0, Math.min(2.0, v)) : 0.4;
      }
      if (u.uMurkDepthFade) {
        const v = this.params?.murkDepthFade;
        u.uMurkDepthFade.value = Number.isFinite(v) ? Math.max(0.1, Math.min(4.0, v)) : 1.2;
      }

      u.uDebugView.value = Number.isFinite(this.params?.debugView) ? this.params.debugView : 0.0;
    }

    // Optional wind-link scaling for wave animation controls.
    // windSpeed is treated as 0..1 (WeatherController normalized), and we lerp
    // from a configurable minimum factor at wind=0 up to 1 at wind=1.
    let _windSpeed01ForWaves = null;
    try {
      const wc = window.MapShine?.weatherController ?? window.canvas?.mapShine?.weatherController;
      const ws = (wc && typeof wc.getCurrentState === 'function') ? wc.getCurrentState() : (wc?.currentState ?? null);
      const wSpeed = ws?.windSpeed;
      _windSpeed01ForWaves = Number.isFinite(wSpeed) ? Math.max(0.0, Math.min(1.0, wSpeed)) : 0.0;
    } catch (_) {
      _windSpeed01ForWaves = 0.0;
    }

    if (staticUniformsDirty) {
      const waveScale = this.params?.waveScale;
      u.uWaveScale.value = Number.isFinite(waveScale) ? waveScale : 32.0;
    }
    const waveSpeed = this.params?.waveSpeed;
    let waveSpeedValue = Number.isFinite(waveSpeed) ? waveSpeed : 0.18;
    if (this.params?.waveSpeedUseWind === true) {
      const minF = Number.isFinite(this.params?.waveSpeedWindMinFactor)
        ? Math.max(0.0, Math.min(1.0, this.params.waveSpeedWindMinFactor))
        : 0.35;
      const s = Number.isFinite(_windSpeed01ForWaves) ? _windSpeed01ForWaves : 0.0;
      waveSpeedValue *= (minF + (1.0 - minF) * s);
    }
    u.uWaveSpeed.value = waveSpeedValue;

    const waveStrength = this.params?.waveStrength;
    let waveStrengthValue = Number.isFinite(waveStrength) ? waveStrength : 0.62;
    if (this.params?.waveStrengthUseWind === true) {
      const minF = Number.isFinite(this.params?.waveStrengthWindMinFactor)
        ? Math.max(0.0, Math.min(1.0, this.params.waveStrengthWindMinFactor))
        : 0.65;
      const s = Number.isFinite(_windSpeed01ForWaves) ? _windSpeed01ForWaves : 0.0;
      waveStrengthValue *= (minF + (1.0 - minF) * s);
    }
    u.uWaveStrength.value = waveStrengthValue;

    if (staticUniformsDirty) {
      const distPx = this.params?.distortionStrengthPx;
      u.uDistortionStrengthPx.value = Number.isFinite(distPx) ? distPx : 5.38;
    }

    if (staticUniformsDirty && u.uWaveWarpLargeStrength) {
      const v = this.params?.waveWarpLargeStrength;
      u.uWaveWarpLargeStrength.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.22;
    }
    if (staticUniformsDirty && u.uWaveWarpSmallStrength) {
      const v = this.params?.waveWarpSmallStrength;
      u.uWaveWarpSmallStrength.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.06;
    }
    if (staticUniformsDirty && u.uWaveWarpMicroStrength) {
      const v = this.params?.waveWarpMicroStrength;
      u.uWaveWarpMicroStrength.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.02;
    }
    if (staticUniformsDirty && u.uWaveWarpTimeSpeed) {
      const v = this.params?.waveWarpTimeSpeed;
      u.uWaveWarpTimeSpeed.value = Number.isFinite(v) ? Math.max(0.0, v) : 0.03;
    }

    if (staticUniformsDirty && u.uWaveEvolutionEnabled) {
      u.uWaveEvolutionEnabled.value = this.params?.waveEvolutionEnabled === false ? 0.0 : 1.0;
    }
    if (staticUniformsDirty && u.uWaveEvolutionSpeed) {
      const v = this.params?.waveEvolutionSpeed;
      u.uWaveEvolutionSpeed.value = Number.isFinite(v) ? Math.max(0.0, v) : 0.08;
    }
    if (staticUniformsDirty && u.uWaveEvolutionAmount) {
      const v = this.params?.waveEvolutionAmount;
      u.uWaveEvolutionAmount.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.35;
    }
    if (staticUniformsDirty && u.uWaveEvolutionScale) {
      const v = this.params?.waveEvolutionScale;
      u.uWaveEvolutionScale.value = Number.isFinite(v) ? Math.max(0.01, v) : 0.18;
    }

    if (staticUniformsDirty && u.uWaveIndoorDampingEnabled) {
      u.uWaveIndoorDampingEnabled.value = this.params?.waveIndoorDampingEnabled === false ? 0.0 : 1.0;
    }
    if (staticUniformsDirty && u.uWaveIndoorDampingStrength) {
      const v = this.params?.waveIndoorDampingStrength;
      u.uWaveIndoorDampingStrength.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 1.0;
    }
    if (staticUniformsDirty && u.uWaveIndoorMinFactor) {
      const v = this.params?.waveIndoorMinFactor;
      u.uWaveIndoorMinFactor.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.2;
    }

    // Outdoors mask (world-space scene UV). Used by wave indoor damping and rain indoor damping.
    if (u.tOutdoorsMask && u.uHasOutdoorsMask) {
      let outdoorsTex = null;
      let outdoorsRec = null;
      try {
        const mm = window.MapShine?.maskManager;
        outdoorsTex = mm ? mm.getTexture('outdoors.scene') : null;
        outdoorsRec = mm ? mm.getRecord?.('outdoors.scene') : null;
        if (!outdoorsTex) {
          const wle = window.MapShine?.windowLightEffect;
          const cloud = window.MapShine?.cloudEffect;
          outdoorsTex = wle?.outdoorsMask || cloud?.outdoorsMask || null;
        }
      } catch (_) {
        outdoorsTex = null;
        outdoorsRec = null;
      }
      u.tOutdoorsMask.value = outdoorsTex;
      u.uHasOutdoorsMask.value = outdoorsTex ? 1.0 : 0.0;

      // Respect the stored mask UV convention when sampling in shaders.
      // Prefer MaskManager metadata; fallback to texture.flipY.
      if (u.uOutdoorsMaskFlipY) {
        const metaFlipY = (outdoorsRec && typeof outdoorsRec.uvFlipY === 'boolean') ? outdoorsRec.uvFlipY : null;
        const flip = (metaFlipY !== null) ? metaFlipY : (outdoorsTex?.flipY ?? false);
        u.uOutdoorsMaskFlipY.value = flip ? 1.0 : 0.0;
      }
    }

    // Token mask (screen-space). Prevent water pass from distorting/tinting tokens.
    if (u.tTokenMask && u.uHasTokenMask) {
      let tokenTex = null;
      try {
        const mm = window.MapShine?.maskManager;
        tokenTex = mm ? mm.getTexture('tokenMask.screen') : null;
        if (!tokenTex) {
          const le = window.MapShine?.lightingEffect;
          tokenTex = le?.tokenMaskTarget?.texture || null;
        }
      } catch (_) {
        tokenTex = null;
      }
      u.tTokenMask.value = tokenTex;
      u.uHasTokenMask.value = tokenTex ? 1.0 : 0.0;
    }

    // Cloud shadow texture (screen-space render target). CloudEffect is world-pinned
    // internally, but the published texture is in screen UV space (vUv).
    if (u.tCloudShadow && u.uHasCloudShadow) {
      let cloudTex = null;
      try {
        const mm = window.MapShine?.maskManager;
        cloudTex = mm ? mm.getTexture('cloudShadow.screen') : null;
        if (!cloudTex) {
          const cloud = window.MapShine?.cloudEffect;
          cloudTex = cloud?.cloudShadowTarget?.texture || null;
        }
      } catch (_) {
        cloudTex = null;
      }
      u.tCloudShadow.value = cloudTex;
      u.uHasCloudShadow.value = cloudTex ? 1.0 : 0.0;
    }

    if (staticUniformsDirty && u.uCloudShadowEnabled) {
      u.uCloudShadowEnabled.value = this.params?.cloudShadowEnabled === false ? 0.0 : 1.0;
    }
    if (u.uCloudShadowMinBrightness) {
      let minB = 0.0;
      try {
        const cloud = window.MapShine?.cloudEffect;
        const v = cloud?.params?.minShadowBrightness;
        minB = Number.isFinite(v) ? v : 0.0;
      } catch (_) {
        minB = 0.0;
      }
      u.uCloudShadowMinBrightness.value = Math.max(0.0, Math.min(0.99, minB));
    }
    if (u.uCloudShadowOpacity) {
      let shadowOpacity = 1.0;
      try {
        const cloud = window.MapShine?.cloudEffect;
        const v = cloud?.params?.shadowOpacity;
        shadowOpacity = Number.isFinite(v) ? v : 1.0;
      } catch (_) {
        shadowOpacity = 1.0;
      }
      u.uCloudShadowOpacity.value = Math.max(0.0, Math.min(1.0, shadowOpacity));
    }
    if (staticUniformsDirty && u.uCloudShadowDarkenStrength) {
      const v = this.params?.cloudShadowDarkenStrength;
      u.uCloudShadowDarkenStrength.value = Number.isFinite(v) ? Math.max(0.0, v) : 1.25;
    }
    if (staticUniformsDirty && u.uCloudShadowDarkenCurve) {
      const v = this.params?.cloudShadowDarkenCurve;
      u.uCloudShadowDarkenCurve.value = Number.isFinite(v) ? Math.max(0.01, v) : 1.5;
    }
    if (staticUniformsDirty && u.uCloudShadowSpecularKill) {
      const v = this.params?.cloudShadowSpecularKill;
      u.uCloudShadowSpecularKill.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 1.0;
    }
    if (staticUniformsDirty && u.uCloudShadowSpecularCurve) {
      const v = this.params?.cloudShadowSpecularCurve;
      u.uCloudShadowSpecularCurve.value = Number.isFinite(v) ? Math.max(0.01, v) : 6.0;
    }

    // Distortion masking (shader-side)
    if (staticUniformsDirty && u.uDistortionEdgeCenter) {
      const v = this.params?.distortionEdgeCenter;
      u.uDistortionEdgeCenter.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.447;
    }
    if (staticUniformsDirty && u.uDistortionEdgeFeather) {
      const v = this.params?.distortionEdgeFeather;
      u.uDistortionEdgeFeather.value = Number.isFinite(v) ? Math.max(0.0, Math.min(0.5, v)) : 0.051;
    }
    if (staticUniformsDirty && u.uDistortionEdgeGamma) {
      const v = this.params?.distortionEdgeGamma;
      u.uDistortionEdgeGamma.value = Number.isFinite(v) ? Math.max(0.01, Math.min(12.0, v)) : 1.0;
    }
    if (staticUniformsDirty && u.uDistortionShoreRemapLo) {
      const v = this.params?.distortionShoreRemapLo;
      u.uDistortionShoreRemapLo.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.0;
    }
    if (staticUniformsDirty && u.uDistortionShoreRemapHi) {
      const v = this.params?.distortionShoreRemapHi;
      u.uDistortionShoreRemapHi.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 1.0;
    }
    if (staticUniformsDirty && u.uDistortionShorePow) {
      const v = this.params?.distortionShorePow;
      u.uDistortionShorePow.value = Number.isFinite(v) ? Math.max(0.01, Math.min(12.0, v)) : 1.0;
    }
    if (staticUniformsDirty && u.uDistortionShoreMin) {
      const v = this.params?.distortionShoreMin;
      u.uDistortionShoreMin.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.35;
    }

    // Rain distortion (precipitation driven)
    if (u.uRainEnabled && u.uRainPrecipitation) {
      const rainEnabled = this.params?.rainDistortionEnabled === false ? 0.0 : 1.0;
      u.uRainEnabled.value = rainEnabled;

      let precip = 0.0;
      try {
        if (this.params?.rainDistortionUseWeather === false) {
          precip = Number.isFinite(this.params?.rainDistortionPrecipitationOverride)
            ? this.params.rainDistortionPrecipitationOverride
            : 0.0;
        } else {
          const wc = window.MapShine?.weatherController ?? window.canvas?.mapShine?.weatherController;
          const ws = (wc && typeof wc.getCurrentState === 'function') ? wc.getCurrentState() : (wc?.currentState ?? null);
          precip = Number.isFinite(ws?.precipitation) ? ws.precipitation : 0.0;
        }
      } catch (_) {
        precip = 0.0;
      }
      precip = Math.max(0.0, Math.min(1.0, precip));
      u.uRainPrecipitation.value = precip;

      if (staticUniformsDirty) {
        if (u.uRainSplit) {
          const v = this.params?.rainDistortionSplit;
          u.uRainSplit.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.5;
        }
        if (u.uRainBlend) {
          const v = this.params?.rainDistortionBlend;
          u.uRainBlend.value = Number.isFinite(v) ? Math.max(0.0, Math.min(0.25, v)) : 0.25;
        }
        if (u.uRainGlobalStrength) {
          const v = this.params?.rainDistortionGlobalStrength;
          u.uRainGlobalStrength.value = Number.isFinite(v) ? Math.max(0.0, Math.min(2.0, v)) : 1.14;
        }

        // Optional indoor damping driven by _Outdoors
        if (u.uRainIndoorDampingEnabled) {
          u.uRainIndoorDampingEnabled.value = this.params?.rainIndoorDampingEnabled === false ? 0.0 : 1.0;
        }
        if (u.uRainIndoorDampingStrength) {
          const v = this.params?.rainIndoorDampingStrength;
          u.uRainIndoorDampingStrength.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 1.0;
        }

        if (u.uRainRippleStrengthPx) {
          const v = this.params?.rainRippleStrengthPx;
          u.uRainRippleStrengthPx.value = Number.isFinite(v) ? Math.max(0.0, Math.min(64.0, v)) : 64.0;
        }
        if (u.uRainRippleScale) {
          const v = this.params?.rainRippleScale;
          u.uRainRippleScale.value = Number.isFinite(v) ? Math.max(1.0, v) : 269.0;
        }
        if (u.uRainRippleSpeed) {
          const v = this.params?.rainRippleSpeed;
          u.uRainRippleSpeed.value = Number.isFinite(v) ? Math.max(0.0, v) : 4.26;
        }
        if (u.uRainRippleDensity) {
          const v = this.params?.rainRippleDensity;
          u.uRainRippleDensity.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 1.0;
        }
        if (u.uRainRippleSharpness) {
          const v = this.params?.rainRippleSharpness;
          u.uRainRippleSharpness.value = Number.isFinite(v) ? Math.max(0.1, Math.min(5.0, v)) : 2.41;
        }

        if (u.uRainRippleJitter) {
          const v = this.params?.rainRippleJitter;
          u.uRainRippleJitter.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.35;
        }
        if (u.uRainRippleRadiusMin) {
          const v = this.params?.rainRippleRadiusMin;
          u.uRainRippleRadiusMin.value = Number.isFinite(v) ? Math.max(0.0, Math.min(0.95, v)) : 0.03;
        }
        if (u.uRainRippleRadiusMax) {
          const v = this.params?.rainRippleRadiusMax;
          u.uRainRippleRadiusMax.value = Number.isFinite(v) ? Math.max(0.0, Math.min(0.95, v)) : 0.52;
        }
        if (u.uRainRippleWidthScale) {
          const v = this.params?.rainRippleWidthScale;
          u.uRainRippleWidthScale.value = Number.isFinite(v) ? Math.max(0.05, Math.min(5.0, v)) : 1.0;
        }
        if (u.uRainRippleSecondaryEnabled) {
          u.uRainRippleSecondaryEnabled.value = this.params?.rainRippleSecondaryEnabled === false ? 0.0 : 1.0;
        }
        if (u.uRainRippleSecondaryStrength) {
          const v = this.params?.rainRippleSecondaryStrength;
          u.uRainRippleSecondaryStrength.value = Number.isFinite(v) ? Math.max(0.0, v) : 0.55;
        }
        if (u.uRainRippleSecondaryPhaseOffset) {
          const v = this.params?.rainRippleSecondaryPhaseOffset;
          u.uRainRippleSecondaryPhaseOffset.value = Number.isFinite(v) ? Math.max(0.0, v) : 0.37;
        }

        if (u.uRainStormStrengthPx) {
          const v = this.params?.rainStormStrengthPx;
          u.uRainStormStrengthPx.value = Number.isFinite(v) ? Math.max(0.0, Math.min(64.0, v)) : 52.41;
        }
        if (u.uRainStormScale) {
          const v = this.params?.rainStormScale;
          u.uRainStormScale.value = Number.isFinite(v) ? Math.max(1.0, v) : 117.0;
        }
        if (u.uRainStormSpeed) {
          const v = this.params?.rainStormSpeed;
          u.uRainStormSpeed.value = Number.isFinite(v) ? Math.max(0.0, v) : 2.74;
        }
        if (u.uRainStormCurl) {
          const v = this.params?.rainStormCurl;
          u.uRainStormCurl.value = Number.isFinite(v) ? Math.max(0.0, Math.min(3.0, v)) : 0.96;
        }

        if (u.uRainStormRateBase) {
          const v = this.params?.rainStormRateBase;
          u.uRainStormRateBase.value = Number.isFinite(v) ? Math.max(0.0, v) : 2.0;
        }
        if (u.uRainStormRateSpeedScale) {
          const v = this.params?.rainStormRateSpeedScale;
          u.uRainStormRateSpeedScale.value = Number.isFinite(v) ? Math.max(0.0, v) : 4.0;
        }
        if (u.uRainStormSizeMin) {
          const v = this.params?.rainStormSizeMin;
          u.uRainStormSizeMin.value = Number.isFinite(v) ? Math.max(0.001, v) : 0.07;
        }
        if (u.uRainStormSizeMax) {
          const v = this.params?.rainStormSizeMax;
          u.uRainStormSizeMax.value = Number.isFinite(v) ? Math.max(0.001, v) : 0.24;
        }
        if (u.uRainStormWidthMinScale) {
          const v = this.params?.rainStormWidthMinScale;
          u.uRainStormWidthMinScale.value = Number.isFinite(v) ? Math.max(0.001, v) : 0.10;
        }
        if (u.uRainStormWidthMaxScale) {
          const v = this.params?.rainStormWidthMaxScale;
          u.uRainStormWidthMaxScale.value = Number.isFinite(v) ? Math.max(0.001, v) : 0.22;
        }
        if (u.uRainStormDecay) {
          const v = this.params?.rainStormDecay;
          u.uRainStormDecay.value = Number.isFinite(v) ? Math.max(0.0, v) : 6.0;
        }
        if (u.uRainStormCoreWeight) {
          const v = this.params?.rainStormCoreWeight;
          u.uRainStormCoreWeight.value = Number.isFinite(v) ? Math.max(0.0, v) : 0.65;
        }
        if (u.uRainStormRingWeight) {
          const v = this.params?.rainStormRingWeight;
          u.uRainStormRingWeight.value = Number.isFinite(v) ? Math.max(0.0, v) : 0.95;
        }
        if (u.uRainStormSwirlStrength) {
          const v = this.params?.rainStormSwirlStrength;
          u.uRainStormSwirlStrength.value = Number.isFinite(v) ? Math.max(0.0, v) : 0.35;
        }
        if (u.uRainStormMicroEnabled) {
          u.uRainStormMicroEnabled.value = this.params?.rainStormMicroEnabled === false ? 0.0 : 1.0;
        }
        if (u.uRainStormMicroStrength) {
          const v = this.params?.rainStormMicroStrength;
          u.uRainStormMicroStrength.value = Number.isFinite(v) ? Math.max(0.0, v) : 0.25;
        }
        if (u.uRainStormMicroScale) {
          const v = this.params?.rainStormMicroScale;
          u.uRainStormMicroScale.value = Number.isFinite(v) ? Math.max(0.0, v) : 0.85;
        }
        if (u.uRainStormMicroSpeed) {
          const v = this.params?.rainStormMicroSpeed;
          u.uRainStormMicroSpeed.value = Number.isFinite(v) ? Math.max(0.0, v) : 1.25;
        }

        if (u.uRainMaxCombinedStrengthPx) {
          const v = this.params?.rainMaxCombinedStrengthPx;
          u.uRainMaxCombinedStrengthPx.value = Number.isFinite(v) ? Math.max(0.0, Math.min(64.0, v)) : 45.4;
        }
      }
    }

    if (staticUniformsDirty && u.uWaveDirOffsetRad) {
      const deg = Number.isFinite(this.params?.waveDirOffsetDeg) ? this.params.waveDirOffsetDeg : 0.0;
      u.uWaveDirOffsetRad.value = (deg * Math.PI) / 180.0;
    }

    if (staticUniformsDirty && u.uLockWaveTravelToWind) {
      u.uLockWaveTravelToWind.value = this.params?.lockWaveTravelToWind === false ? 0.0 : 1.0;
    }

    if (staticUniformsDirty && u.uWaveAppearanceRotRad) {
      const deg = Number.isFinite(this.params?.waveAppearanceOffsetDeg) ? this.params.waveAppearanceOffsetDeg : 0.0;
      u.uWaveAppearanceRotRad.value = (deg * Math.PI) / 180.0;
    }

    if (u.uWindDir && u.uWindSpeed) {
      try {
        const wc = window.MapShine?.weatherController ?? window.canvas?.mapShine?.weatherController;
        const ws = (wc && typeof wc.getCurrentState === 'function') ? wc.getCurrentState() : (wc?.currentState ?? null);
        const useTarget = !!this.params?.useTargetWindDirection;
        const wd = useTarget ? (wc?.targetState?.windDirection ?? ws?.windDirection) : ws?.windDirection;

        const wx = Number.isFinite(wd?.x) ? wd.x : 1.0;
        const wy = Number.isFinite(wd?.y) ? wd.y : 0.0;
        const len = Math.hypot(wx, wy);
        const nx = len > 1e-6 ? (wx / len) : 1.0;
        const ny = len > 1e-6 ? (wy / len) : 0.0;

        if (this._smoothedWindDir) {
          const resp = Number.isFinite(this.params?.windDirResponsiveness) ? Math.max(0.05, this.params.windDirResponsiveness) : 2.5;
          const k = 1.0 - Math.exp(-dtSeconds * resp);
          if (this._tempWindTarget) this._tempWindTarget.set(nx, ny);
          this._smoothedWindDir.lerp(this._tempWindTarget ?? this._smoothedWindDir, Math.min(1.0, Math.max(0.0, k)));
          u.uWindDir.value.set(this._smoothedWindDir.x, this._smoothedWindDir.y);
        } else {
          u.uWindDir.value.set(nx, ny);
        }

        const wSpeed = ws?.windSpeed;
        const wSpeed01Raw = Number.isFinite(wSpeed) ? Math.max(0.0, Math.min(1.0, wSpeed)) : 0.0;

        // Asymmetric smoothing (fast gain, slow loss).
        // Desired behavior: wind-driven wave speed-ups should decay at ~half the rate
        // that they build up.
        const resp = Number.isFinite(this.params?.windDirResponsiveness) ? Math.max(0.05, this.params.windDirResponsiveness) : 2.5;
        const respUp = resp;
        const respDown = resp * 0.5;
        const current = Number.isFinite(this._smoothedWindSpeed01) ? this._smoothedWindSpeed01 : 0.0;
        const target = wSpeed01Raw;
        const useResp = target > current ? respUp : respDown;
        const kSpeed = 1.0 - Math.exp(-dtSeconds * useResp);
        this._smoothedWindSpeed01 = current + (target - current) * Math.min(1.0, Math.max(0.0, kSpeed));
        const wSpeed01 = this._smoothedWindSpeed01;

        u.uWindSpeed.value = wSpeed01;

        // Coherent pattern advection driven by wind direction + gusty wind speed.
        // sceneUv is defined in Foundry sceneRect UVs (Y-down), so we use
        // windDirection directly in that same basis.
        if (u.uWindOffsetUv && this._windOffsetUv && dtSeconds > 0.0) {
          const rect = canvas?.dimensions?.sceneRect;
          const sceneW = rect?.width || 1;
          const sceneH = rect?.height || 1;

          // Tuned so windSpeed=1 moves the pattern noticeably but not wildly.
          // This is in scene pixels/second.
          const advMul = Number.isFinite(this.params?.advectionSpeed) ? Math.max(0.0, this.params.advectionSpeed) : 1.0;
          const pxPerSec = (35.0 + 220.0 * wSpeed01) * advMul;

          const baseDxF = (this._smoothedWindDir?.x ?? nx);
          const baseDyF = (this._smoothedWindDir?.y ?? ny);
          const adDeg = Number.isFinite(this.params?.advectionDirOffsetDeg) ? this.params.advectionDirOffsetDeg : 0.0;
          if (this._cachedAdvectionDirOffsetDeg !== adDeg) {
            const adRad = (adDeg * Math.PI) / 180.0;
            this._cachedAdvectionDirCos = Math.cos(adRad);
            this._cachedAdvectionDirSin = Math.sin(adRad);
            this._cachedAdvectionDirOffsetDeg = adDeg;
          }

          // Keep advection in the same basis as sceneUv (Foundry sceneRect UVs, Y-down).
          // Any Y-up conversions for wave math happen later in the shader.
          const cs = this._cachedAdvectionDirCos;
          const sn = this._cachedAdvectionDirSin;
          const dx = cs * baseDxF - sn * baseDyF;
          const dy = sn * baseDxF + cs * baseDyF;

          const du = dx * (pxPerSec * dtSeconds) / Math.max(1.0, sceneW);
          const dv = dy * (pxPerSec * dtSeconds) / Math.max(1.0, sceneH);

          this._windOffsetUv.x += du;
          this._windOffsetUv.y += dv;
          u.uWindOffsetUv.value.set(this._windOffsetUv.x, this._windOffsetUv.y);
        }

        // Monotonic integration to avoid gust "snap-back".
        // We drive the wave phase using an accumulated time that advances with wind speed.
        // If windSpeed decreases, the phase just advances more slowly (never reverses).
        if (u.uWindTime) {
          const baseRate = Number.isFinite(u.uWaveSpeed?.value) ? u.uWaveSpeed.value : 1.2;
          const windRate = baseRate * (0.35 + 2.25 * wSpeed01);
          this._windTime += dtSeconds * windRate;
          u.uWindTime.value = this._windTime;
        }
      } catch (_) {
        u.uWindDir.value.set(1.0, 0.0);
        u.uWindSpeed.value = 0.0;
        this._smoothedWindSpeed01 = 0.0;
        if (u.uWindOffsetUv && this._windOffsetUv) {
          u.uWindOffsetUv.value.set(this._windOffsetUv.x, this._windOffsetUv.y);
        }
        if (u.uWindTime) {
          const baseRate = Number.isFinite(u.uWaveSpeed?.value) ? u.uWaveSpeed.value : 1.2;
          this._windTime += dtSeconds * baseRate * 0.35;
          u.uWindTime.value = this._windTime;
        }
      }
    }

    // Fallback: still advance wind time even if weather uniforms are missing for some reason.
    if (u.uWindTime && (!u.uWindSpeed || !u.uWindDir)) {
      const baseRate = Number.isFinite(u.uWaveSpeed?.value) ? u.uWaveSpeed.value : 1.2;
      this._windTime += dtSeconds * baseRate * 0.35;
      u.uWindTime.value = this._windTime;
    }

    if (staticUniformsDirty) {
      const specStrength = this.params?.specStrength;
      u.uSpecStrength.value = Number.isFinite(specStrength) ? specStrength : 0.25;
      const specPower = this.params?.specPower;
      u.uSpecPower.value = Number.isFinite(specPower) ? specPower : 3.0;
    }

    // Specular (Advanced)
    if (staticUniformsDirty && u.uSpecSunDir && THREE) {
      const azDeg = Number.isFinite(this.params?.specSunAzimuthDeg) ? this.params.specSunAzimuthDeg : 225.0;
      const elDeg = Number.isFinite(this.params?.specSunElevationDeg) ? this.params.specSunElevationDeg : 65.0;
      const clampedElDeg = Math.max(0.0, Math.min(89.999, elDeg));
      if (this._cachedSpecSunAzimuthDeg !== azDeg || this._cachedSpecSunElevationDeg !== clampedElDeg) {
        const az = (azDeg * Math.PI) / 180.0;
        const el = (clampedElDeg * Math.PI) / 180.0;

        // Interpret azimuth in Foundry-like screen/world basis (Y-down), then convert
        // to shader basis (Y-up) by flipping Y.
        const cEl = Math.cos(el);
        this._cachedSpecSunDirX = Math.cos(az) * cEl;
        this._cachedSpecSunDirY = -Math.sin(az) * cEl;
        this._cachedSpecSunDirZ = Math.sin(el);
        this._cachedSpecSunAzimuthDeg = azDeg;
        this._cachedSpecSunElevationDeg = clampedElDeg;
      }
      u.uSpecSunDir.value.set(this._cachedSpecSunDirX, this._cachedSpecSunDirY, this._cachedSpecSunDirZ);
    }
    if (staticUniformsDirty && u.uSpecSunIntensity) {
      const v = this.params?.specSunIntensity;
      u.uSpecSunIntensity.value = Number.isFinite(v) ? Math.max(0.0, Math.min(10.0, v)) : 1.0;
    }
    if (staticUniformsDirty && u.uSpecNormalStrength) {
      const v = this.params?.specNormalStrength;
      u.uSpecNormalStrength.value = Number.isFinite(v) ? Math.max(0.0, Math.min(10.0, v)) : 1.0;
    }
    if (staticUniformsDirty && u.uSpecNormalScale) {
      const v = this.params?.specNormalScale;
      u.uSpecNormalScale.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.03;
    }
    if (staticUniformsDirty && u.uSpecRoughnessMin) {
      const v = this.params?.specRoughnessMin;
      u.uSpecRoughnessMin.value = Number.isFinite(v) ? Math.max(0.001, Math.min(1.0, v)) : 0.02;
    }
    if (staticUniformsDirty && u.uSpecRoughnessMax) {
      const v = this.params?.specRoughnessMax;
      u.uSpecRoughnessMax.value = Number.isFinite(v) ? Math.max(0.001, Math.min(1.0, v)) : 0.25;
    }
    if (staticUniformsDirty && u.uSpecF0) {
      const v = this.params?.specF0;
      u.uSpecF0.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.02;
    }
    if (staticUniformsDirty && u.uSpecMaskGamma) {
      const v = this.params?.specMaskGamma;
      u.uSpecMaskGamma.value = Number.isFinite(v) ? Math.max(0.05, Math.min(12.0, v)) : 1.0;
    }
    if (staticUniformsDirty && u.uSpecSkyTint) {
      const v = this.params?.specSkyTint;
      u.uSpecSkyTint.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 1.0;
    }
    if (staticUniformsDirty && u.uSpecShoreBias) {
      const v = this.params?.specShoreBias;
      u.uSpecShoreBias.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.35;
    }

    if (staticUniformsDirty && u.uSpecDistortionNormalStrength) {
      const v = this.params?.specDistortionNormalStrength;
      u.uSpecDistortionNormalStrength.value = Number.isFinite(v) ? Math.max(0.0, Math.min(5.0, v)) : 0.35;
    }
    if (staticUniformsDirty && u.uSpecAnisotropy) {
      const v = this.params?.specAnisotropy;
      u.uSpecAnisotropy.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.35;
    }
    if (staticUniformsDirty && u.uSpecAnisoRatio) {
      const v = this.params?.specAnisoRatio;
      u.uSpecAnisoRatio.value = Number.isFinite(v) ? Math.max(1.0, Math.min(16.0, v)) : 3.0;
    }

    if (staticUniformsDirty) {
      this._paramsDirty = false;
    }

    this._rebuildWaterDataIfNeeded(false);

    u.tWaterData.value = this._waterData?.texture || null;
    u.uHasWaterData.value = this._waterData?.texture ? 1.0 : 0.0;
    u.uWaterEnabled.value = this.enabled ? 1.0 : 0.0;

    if (u.uActiveLevelElevation) {
      // When water is preserved across floors, use the elevation of the floor
      // the water mask belongs to (not the viewer's current floor). This keeps
      // depth occlusion identical whether viewed from ground or upper level.
      const reg = window.MapShine?.effectMaskRegistry;
      const waterSlot = reg?.getSlot?.('water');
      const waterFloorKey = waterSlot?.floorKey;
      let activeElev;
      if (waterFloorKey && waterFloorKey !== reg?._activeFloorKey) {
        // Water belongs to a different floor — use that floor's bottom elevation.
        activeElev = Number(waterFloorKey.split(':')[0]);
      } else {
        activeElev = Number(window.MapShine?._activeLevelElevation);
        if (!Number.isFinite(activeElev)) {
          activeElev = Number(window.MapShine?.activeLevelContext?.bottom);
        }
      }
      u.uActiveLevelElevation.value = Number.isFinite(activeElev) ? activeElev : 0.0;
    }

    if (u.tWaterRawMask && u.uHasWaterRawMask) {
      u.tWaterRawMask.value = this._waterRawMask;
      u.uHasWaterRawMask.value = this._waterRawMask ? 1.0 : 0.0;
    }

    if (u.tWaterOccluderAlpha && u.uHasWaterOccluderAlpha) {
      const occ = this._waterOccluderAlpha
        ?? window.MapShine?.distortionManager?.waterOccluderTarget?.texture
        ?? null;
      u.tWaterOccluderAlpha.value = occ;
      u.uHasWaterOccluderAlpha.value = occ ? 1.0 : 0.0;
    }

    if (u.uWaterDataTexelSize) {
      const tex = this._waterData?.texture;
      const img = tex?.image;
      const w = img && img.width ? img.width : (this._waterData?.resolution || 512);
      const h = img && img.height ? img.height : (this._waterData?.resolution || 512);
      if (w !== this._lastWaterDataTexW || h !== this._lastWaterDataTexH) {
        u.uWaterDataTexelSize.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
        this._lastWaterDataTexW = w;
        this._lastWaterDataTexH = h;
      }
    }

    const d = canvas?.dimensions;
    if (d && u.uSceneDimensions?.value) {
      u.uSceneDimensions.value.set(d.width || 1, d.height || 1);
    }

    if (u.uSceneRect && u.uHasSceneRect) {
      const rect = canvas?.dimensions?.sceneRect;
      if (rect && typeof rect.x === 'number' && typeof rect.y === 'number') {
        u.uSceneRect.value.set(rect.x, rect.y, rect.width || 1, rect.height || 1);
        u.uHasSceneRect.value = 1.0;
      } else {
        u.uHasSceneRect.value = 0.0;
      }
    }

    if (u.uViewBounds && this._lastCamera) {
      this._updateViewBoundsFromCamera(this._lastCamera, u.uViewBounds.value);
    } else if (u.uViewBounds && THREE && window.MapShine?.sceneComposer?.camera) {
      this._updateViewBoundsFromCamera(window.MapShine.sceneComposer.camera, u.uViewBounds.value);
    }
  }

  render(renderer, scene, camera) {
    if (!this._material) return;

    const inputTexture = this._material.uniforms?.tDiffuse?.value || this._readBuffer?.texture || this._inputTexture;
    if (!inputTexture) return;

    if (this._material.uniforms?.tDiffuse) {
      this._material.uniforms.tDiffuse.value = inputTexture;
    }

    this._lastCamera = camera;

    const isFirstRender = !this._firstRenderDone;
    if (isFirstRender) {
      this._firstRenderDone = true;
      this._logPreCompileDiagnostics();
    }

    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    const t0 = isFirstRender ? performance.now() : 0;
    renderer.render(this._quadScene, this._quadCamera);

    if (isFirstRender) {
      // Force synchronous completion so we can measure actual compile time.
      const gl = renderer.getContext();
      if (gl?.finish) gl.finish();
      const compileMs = performance.now() - t0;
      this._logPostCompileDiagnostics(renderer, compileMs);
    }

    renderer.autoClear = prevAutoClear;
  }

  /**
   * Log shader stats BEFORE the first render triggers compilation.
   * Helps diagnose why ANGLE/D3D11 HLSL translation takes so long.
   * @private
   */
  _logPreCompileDiagnostics() {
    const dlp = debugLoadingProfiler;
    try {
      const fragSrc = this._material.fragmentShader || '';
      const vertSrc = this._material.vertexShader || '';
      const defines = this._material.defines ? Object.keys(this._material.defines) : [];
      const uniformCount = this._material.uniforms ? Object.keys(this._material.uniforms).length : 0;

      // Count samplers (texture uniforms) — each costs an extra binding.
      let samplerCount = 0;
      if (this._material.uniforms) {
        for (const key of Object.keys(this._material.uniforms)) {
          const v = this._material.uniforms[key]?.value;
          if (v && (v.isTexture || v.isRenderTarget)) samplerCount++;
        }
      }

      const fragLines = fragSrc.split('\n').length;
      const fragChars = fragSrc.length;
      const vertLines = vertSrc.split('\n').length;
      const vertChars = vertSrc.length;
      const definesStr = defines.length > 0 ? defines.join(', ') : '(none)';

      const msg =
        `water.compile: SHADER STATS — ` +
        `frag=${fragLines} lines/${fragChars} chars, ` +
        `vert=${vertLines} lines/${vertChars} chars, ` +
        `defines=[${definesStr}], ` +
        `uniforms=${uniformCount} (${samplerCount} samplers), ` +
        `needsUpdate=${this._material.needsUpdate}`;
      log.info(`[COMPILE] ${msg}`);
      dlp?.event?.(msg);
    } catch (e) {
      log.warn('[COMPILE] Pre-compile diagnostics failed:', e?.message);
    }
  }

  /**
   * Log compilation results and extract GL shader info logs from ANGLE.
   * @private
   */
  _logPostCompileDiagnostics(renderer, compileMs) {
    const dlp = debugLoadingProfiler;
    try {
      const msg = `water.compile: DONE — ${compileMs.toFixed(0)}ms for 1 program`;
      log.info(`[COMPILE] ${msg}`);
      dlp?.event?.(msg);

      // Extract GL shader info logs — ANGLE often includes HLSL translation warnings.
      const gl = renderer.getContext();
      const programs = renderer.info?.programs;
      if (programs && programs.length > 0) {
        // The most recently added program should be ours.
        const lastProg = programs[programs.length - 1];
        const glProg = lastProg?.program;
        if (glProg) {
          const shaders = gl.getAttachedShaders(glProg);
          if (shaders) {
            for (const shader of shaders) {
              const type = gl.getShaderParameter(shader, gl.SHADER_TYPE);
              const typeName = type === gl.FRAGMENT_SHADER ? 'Fragment' : 'Vertex';
              const infoLog = gl.getShaderInfoLog(shader);
              if (infoLog && infoLog.trim()) {
                const truncated = infoLog.length > 2000
                  ? infoLog.substring(0, 2000) + `\n... (truncated, ${infoLog.length} chars total)`
                  : infoLog;
                log.info(`[COMPILE] ${typeName} shader info log:\n${truncated}`);
                dlp?.event?.(`water.compile: ${typeName} GL log — ${infoLog.length} chars`);
              } else {
                dlp?.event?.(`water.compile: ${typeName} GL log — (empty, no warnings)`);
              }
            }
          }
          const linkLog = gl.getProgramInfoLog(glProg);
          if (linkLog && linkLog.trim()) {
            log.info(`[COMPILE] Program link info log:\n${linkLog}`);
            dlp?.event?.(`water.compile: link log — ${linkLog.length} chars`);
          }
        }
      }
    } catch (e) {
      log.warn('[COMPILE] Post-compile diagnostics failed:', e?.message);
    }
  }

  /**
   * Diagnostic: compile the water shader with different define subsets to identify
   * which features drive the majority of ANGLE/D3D11 compilation time.
   *
   * Creates temporary ShaderMaterials with subsets of defines, renders each to
   * trigger GL compilation, then disposes them. Results are logged to both the
   * console and the debug loading profiler event log.
   *
   * Call this AFTER the main water shader has compiled (so the vertex shader
   * is already cached by the driver and only fragment variants are tested).
   *
   * @param {THREE.WebGLRenderer} renderer
   * @returns {Promise<void>}
   */
  async diagnosticVariantCompile(renderer) {
    const THREE = window.THREE;
    const gl = renderer.getContext();
    const dlp = debugLoadingProfiler;
    if (!THREE || !gl || !this._material) return;

    const fragSrc = this._material.fragmentShader;
    const vertSrc = this._material.vertexShader;
    if (!fragSrc || !vertSrc) return;

    dlp?.event?.('water.variantTest: BEGIN — testing define subsets to isolate compilation cost');
    log.info('[VARIANT TEST] Starting water shader define-variant compilation test...');

    // Define subsets to test. Each entry: [label, definesObject]
    const variants = [
      ['bare (no defines)',    {}],
      ['+SAND',               { USE_SAND: 1 }],
      ['+MULTITAP',           { USE_WATER_REFRACTION_MULTITAP: 1 }],
      ['+CHROM_AB',           { USE_WATER_CHROMATIC_ABERRATION: 1 }],
      ['+SAND+MULTITAP+CHROM', { USE_SAND: 1, USE_WATER_REFRACTION_MULTITAP: 1, USE_WATER_CHROMATIC_ABERRATION: 1 }],
    ];

    const results = [];
    const quadScene = new THREE.Scene();
    const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quadGeo = new THREE.PlaneGeometry(2, 2);

    for (const [label, defines] of variants) {
      // Clone the material with a different set of defines.
      const mat = new THREE.ShaderMaterial({
        uniforms: this._material.uniforms,
        vertexShader: vertSrc,
        fragmentShader: fragSrc,
        defines: { ...defines },
        depthWrite: false,
        depthTest: false,
      });
      mat.needsUpdate = true;

      const mesh = new THREE.Mesh(quadGeo, mat);
      quadScene.add(mesh);

      const progBefore = Array.isArray(renderer.info?.programs) ? renderer.info.programs.length : 0;
      const t0 = performance.now();
      try {
        renderer.setRenderTarget(null);
        renderer.render(quadScene, quadCamera);
        if (gl.finish) gl.finish();
      } catch (e) {
        log.warn(`[VARIANT TEST] Error compiling "${label}":`, e?.message);
      }
      const ms = performance.now() - t0;
      const progAfter = Array.isArray(renderer.info?.programs) ? renderer.info.programs.length : 0;
      const newProgs = progAfter - progBefore;

      results.push({ label, ms, newProgs });
      const msg = `water.variantTest: "${label}" — ${ms.toFixed(0)}ms, +${newProgs} prog`;
      log.info(`[VARIANT TEST] ${msg}`);
      dlp?.event?.(msg);

      // Clean up
      quadScene.remove(mesh);
      mat.dispose();

      // Yield to event loop between variants so the loading overlay can update.
      await new Promise(r => setTimeout(r, 0));
    }

    quadGeo.dispose();

    // Summary
    const summary = results.map(r => `${r.label}: ${r.ms.toFixed(0)}ms`).join(' | ');
    const totalMs = results.reduce((s, r) => s + r.ms, 0);
    const summaryMsg = `water.variantTest: DONE — total ${totalMs.toFixed(0)}ms [ ${summary} ]`;
    log.info(`[VARIANT TEST] ${summaryMsg}`);
    dlp?.event?.(summaryMsg);
  }

  onResize(width, height) {
    if (!this._material?.uniforms?.uResolution?.value) return;
    this._material.uniforms.uResolution.value.set(width, height);
  }

  /**
   * Connect this effect to the EffectMaskRegistry. Once connected, the
   * registry owns the water mask lifecycle — floor transitions update the
   * mask via the registry's observer pattern instead of direct setBaseMesh
   * calls. The subscription callback handles:
   *   - New mask: clear caches, rebuild SDF from new texture
   *   - Null mask: dispose SDF data (only fires when policy allows clear)
   *   - Same texture: no-op (reference equality check)
   *
   * Call this after the effect is initialized and the registry is seeded.
   * @param {import('../assets/EffectMaskRegistry.js').EffectMaskRegistry} registry
   */
  connectToRegistry(registry) {
    // Unsubscribe from any previous connection
    if (this._registryUnsub) {
      this._registryUnsub();
      this._registryUnsub = null;
    }

    this._registryUnsub = registry.subscribe('water', (texture, _floorKey, _source) => {
      // Same texture reference — no-op (avoids redundant SDF rebuild)
      if (texture === this.waterMask) return;

      if (!texture) {
        // Mask cleared (policy allowed it) — dispose SDF data.
        // The floor transition lock is NOT checked here because the
        // registry's preserveAcrossFloors policy already prevented
        // this callback from firing when water should be preserved.
        this._waterData = null;
        this._waterRawMask = null;
        this._lastWaterMaskUuid = null;
        this._surfaceModel?.dispose?.();
        return;
      }

      // New water mask — rebuild SDF.
      // Temporarily lift the floor transition lock so clearCaches and
      // setBaseMesh can proceed (the registry already decided this is
      // the correct new mask for the current floor).
      const prevLock = this._floorTransitionActive;
      this._floorTransitionActive = false;
      try {
        if (typeof this.clearCaches === 'function') this.clearCaches();
        this.waterMask = texture;

        const THREE = window.THREE;
        if (THREE && this.waterMask) {
          this.waterMask.minFilter = THREE.LinearFilter;
          this.waterMask.magFilter = THREE.LinearFilter;
          this.waterMask.generateMipmaps = false;
          this.waterMask.flipY = false;
          // Do NOT set needsUpdate=true on GPU render target textures — it
          // increments texture.version every call, which breaks the SDF cache
          // key and triggers a full rebuild every frame. RT textures are
          // managed by the renderer and don't need CPU-side upload triggers.
          const img = this.waterMask.image;
          const isRt = !img ||
            (img && typeof img === 'object' &&
             !(img instanceof HTMLImageElement) &&
             !(img instanceof HTMLCanvasElement) &&
             !(img instanceof HTMLVideoElement) &&
             !(typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) &&
             !(typeof OffscreenCanvas !== 'undefined' && img instanceof OffscreenCanvas));
          if (!isRt) this.waterMask.needsUpdate = true;
        }

        this._rebuildWaterDataIfNeeded(true);
      } finally {
        this._floorTransitionActive = prevLock;
      }
    });
  }

  dispose() {
    // Unsubscribe from EffectMaskRegistry before disposing resources.
    if (this._registryUnsub) {
      this._registryUnsub();
      this._registryUnsub = null;
    }

    this._surfaceModel.dispose();
    this._waterData = null;
    this._waterRawMask = null;

    if (this._quadMesh) {
      this._quadMesh.geometry?.dispose?.();
      this._quadMesh = null;
    }

    if (this._material) {
      this._material.dispose();
      this._material = null;
    }

    if (this._noiseTexture) {
      this._noiseTexture.dispose();
      this._noiseTexture = null;
    }

    this._quadScene = null;
    this._quadCamera = null;

    this.waterMask = null;
    this.baseMesh = null;
    this._lastWaterMaskUuid = null;
  }

  /**
   * Generate a 512×512 tileable RGBA noise texture for the water fragment shader.
   * Each RGBA channel holds an independent noise field (different PRNG seed) so
   * fbmNoise can sample a different channel per octave for decorrelation.
   * Replaces procedural hash12-based valueNoise/fbmNoise with texture lookups,
   * eliminating the massive function inlining that caused ANGLE/D3D11 to spend
   * ~49 seconds compiling the shader.
   *
   * Uses a deterministic seeded LCG so the noise is reproducible across loads.
   * REPEAT wrapping + NEAREST filtering; the shader does manual smoothstep
   * interpolation for exact visual parity with the original procedural noise.
   *
   * @param {object} THREE - Three.js namespace
   * @returns {THREE.DataTexture}
   * @static
   */
  static _createNoiseTexture(THREE) {
    const size = 512;
    const data = new Uint8Array(size * size * 4);

    // 4 independent LCG seeds — one per RGBA channel — so each channel is an
    // uncorrelated noise field. fbmNoise samples a different channel per octave
    // to prevent visible self-correlation in the fBm sum.
    let sR = 48271, sG = 16807, sB = 75013, sA = 33791;
    for (let i = 0; i < size * size; i++) {
      sR = (sR * 1103515245 + 12345) & 0x7fffffff;
      sG = (sG * 1103515245 + 12345) & 0x7fffffff;
      sB = (sB * 1103515245 + 12345) & 0x7fffffff;
      sA = (sA * 1103515245 + 12345) & 0x7fffffff;
      const idx = i * 4;
      data[idx]     = (sR >> 16) & 0xff; // R
      data[idx + 1] = (sG >> 16) & 0xff; // G
      data[idx + 2] = (sB >> 16) & 0xff; // B
      data[idx + 3] = (sA >> 16) & 0xff; // A
    }

    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    // NEAREST filtering — the shader does manual smoothstep interpolation
    // by sampling the 4 corner texels explicitly. This avoids texel-center
    // precision issues that LINEAR filtering can introduce.
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  _rebuildWaterDataIfNeeded(force) {
    // BLOCKED during floor transitions — prevents the render loop from
    // triggering a rebuild due to cache key changes (e.g. texture version
    // increments from the compositor normalizing flipY on shared textures).
    if (this._floorTransitionActive) return;
    if (!this.waterMask) return;
    const cacheKey = this._getWaterMaskCacheKey();
    if (!force && cacheKey && cacheKey === this._lastWaterMaskCacheKey && this._waterData?.texture) return;

    try {
      this._waterData = this._surfaceModel.buildFromMaskTexture(this.waterMask, {
        resolution: Number.isFinite(this.params?.buildResolution) ? this.params.buildResolution : 2048,
        threshold: Number.isFinite(this.params?.maskThreshold) ? this.params.maskThreshold : 0.15,
        channel: this.params?.maskChannel ?? 'auto',
        invert: !!this.params?.maskInvert,
        blurRadius: Number.isFinite(this.params?.maskBlurRadius) ? this.params.maskBlurRadius : 0.0,
        blurPasses: Number.isFinite(this.params?.maskBlurPasses) ? this.params.maskBlurPasses : 0,
        expandPx: Number.isFinite(this.params?.maskExpandPx) ? this.params.maskExpandPx : 0.0,
        sdfRangePx: Number.isFinite(this.params?.sdfRangePx) ? this.params.sdfRangePx : 64,
        exposureWidthPx: Number.isFinite(this.params?.shoreWidthPx) ? this.params.shoreWidthPx : 24
      });

      this._waterRawMask = this._waterData?.rawMaskTexture || null;
      this._lastWaterMaskUuid = this.waterMask.uuid;
      this._lastWaterMaskCacheKey = cacheKey;

      // Register the generated data texture so it can be used by other systems (e.g. MaskDebugEffect)
      const mm = window.MapShine?.maskManager;
      if (mm && this._waterData?.texture) {
        mm.setTexture('water.data', this._waterData.texture, {
          source: 'derived',
          space: 'sceneUv',
          lifecycle: 'staticPerScene',
          uvFlipY: false, // Data textures are generated consistently, no flip
          channels: 'rgba'
        });
      }
    } catch (e) {
      this._waterData = null;
      this._waterRawMask = null;
      this._lastWaterMaskUuid = null;
      this._lastWaterMaskCacheKey = null;
      log.error('Failed to build WaterData texture', e);
    }
  }

  _getWaterMaskCacheKey() {
    const tex = this.waterMask;
    if (!tex) return null;
    const img = tex.image;
    const imgId = img ? this._getWaterMaskImageId(img) : 0;
    // GPU render target textures have their `version` incremented every frame
    // they are rendered to. Including version in the key would cause a full SDF
    // rebuild every frame. Detect RT textures by the absence of a drawable CPU
    // image — RT textures have image===null or a non-drawable object.
    const isRenderTarget = !img ||
      (img && typeof img === 'object' &&
       !(img instanceof HTMLImageElement) &&
       !(img instanceof HTMLCanvasElement) &&
       !(img instanceof HTMLVideoElement) &&
       !(typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) &&
       !(typeof OffscreenCanvas !== 'undefined' && img instanceof OffscreenCanvas));
    const v = isRenderTarget ? 0 : (Number.isFinite(tex.version) ? tex.version : 0);

    const p = this.params ?? {};
    const chan = (p.maskChannel === 'r' || p.maskChannel === 'a' || p.maskChannel === 'luma') ? p.maskChannel : 'auto';
    const inv = p.maskInvert ? 1 : 0;
    const th = Number.isFinite(p.maskThreshold) ? p.maskThreshold : 0.15;
    const br = Number.isFinite(p.maskBlurRadius) ? p.maskBlurRadius : 0.0;
    const bp = Number.isFinite(p.maskBlurPasses) ? p.maskBlurPasses : 0;
    const ex = Number.isFinite(p.maskExpandPx) ? p.maskExpandPx : 0.0;
    const res = Number.isFinite(p.buildResolution) ? p.buildResolution : 2048;
    const sdf = Number.isFinite(p.sdfRangePx) ? p.sdfRangePx : 64;
    const shore = Number.isFinite(p.shoreWidthPx) ? p.shoreWidthPx : 24;

    return `${tex.uuid}|img:${imgId}|v:${v}|c:${chan}|i:${inv}|t:${th}|br:${br}|bp:${bp}|ex:${ex}|res:${res}|sdf:${sdf}|sh:${shore}`;
  }

  _getWaterMaskImageId(img) {
    if (!img || typeof img !== 'object') return 0;
    const existing = this._waterMaskImageIds.get(img);
    if (existing) return existing;
    const id = this._nextWaterMaskImageId++;
    this._waterMaskImageIds.set(img, id);
    return id;
  }

  _updateViewBoundsFromCamera(camera, outVec4) {
    if (!camera || !outVec4) return;

    const THREE = window.THREE;
    if (!THREE) return;

    if (camera.isOrthographicCamera) {
      const camPos = camera.position;
      const minX = camPos.x + camera.left / camera.zoom;
      const maxX = camPos.x + camera.right / camera.zoom;
      const minY = camPos.y + camera.bottom / camera.zoom;
      const maxY = camPos.y + camera.top / camera.zoom;
      outVec4.set(minX, minY, maxX, maxY);
      return;
    }

    if (camera.isPerspectiveCamera) {
      const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;

      const ndc = this._tempNdc ?? (this._tempNdc = new THREE.Vector3());
      const world = this._tempWorld ?? (this._tempWorld = new THREE.Vector3());
      const dir = this._tempDir ?? (this._tempDir = new THREE.Vector3());

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      for (const c of _ndcCorners) {
        ndc.set(c[0], c[1], 0.5);
        world.copy(ndc).unproject(camera);
        dir.copy(world).sub(camera.position);
        const dz = dir.z;
        if (Math.abs(dz) < 1e-6) continue;
        const t = (groundZ - camera.position.z) / dz;
        if (!Number.isFinite(t) || t <= 0) continue;

        const ix = camera.position.x + dir.x * t;
        const iy = camera.position.y + dir.y * t;

        if (ix < minX) minX = ix;
        if (iy < minY) minY = iy;
        if (ix > maxX) maxX = ix;
        if (iy > maxY) maxY = iy;
      }

      if (minX !== Infinity && minY !== Infinity && maxX !== -Infinity && maxY !== -Infinity) {
        outVec4.set(minX, minY, maxX, maxY);
      }
    }
  }
}
