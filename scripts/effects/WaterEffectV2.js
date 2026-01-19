import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import { WaterSurfaceModel } from './WaterSurfaceModel.js';

const log = createLogger('WaterEffectV2');

export class WaterEffectV2 extends EffectBase {
  constructor() {
    super('water', RenderLayers.POST_PROCESSING, 'low');

    this.priority = 80;
    this.alwaysRender = true;

    this.params = {
      tintStrength: 0.15,
      tintColor: { r: 0.1, g: 0.3, b: 0.48 },

      maskChannel: 'auto',
      maskInvert: false,
      maskThreshold: 0.05,
      maskBlurRadius: 0.0,
      maskBlurPasses: 0,
      maskExpandPx: -1,
      buildResolution: 1024,
      sdfRangePx: 64,
      shoreWidthPx: 101,

      waveScale: 33.5,
      waveSpeed: 0.16,
      waveStrength: 0.57,
      distortionStrengthPx: 16.93,

      waveDirOffsetDeg: 0.0,
      waveAppearanceOffsetDeg: 0.0,
      advectionDirOffsetDeg: 0.0,
      advectionSpeed: 0.1,
      windDirResponsiveness: 3.8,
      useTargetWindDirection: true,

      specStrength: 28.08,
      specPower: 24,

      foamStrength: 0.79,
      foamThreshold: 0.98,
      foamScale: 443,
      foamColor: { r: 0.9, g: 0.95, b: 1.0 },
      foamSpeed: 0.18,

      foamCurlStrength: 0.01,
      foamCurlScale: 30,
      foamCurlSpeed: 0.04,

      foamBreakupStrength1: 1,
      foamBreakupScale1: 5.2,
      foamBreakupSpeed1: 0.2,

      foamBreakupStrength2: 1,
      foamBreakupScale2: 90.6,
      foamBreakupSpeed2: 0.28,

      foamBlackPoint: 0.13,
      foamWhitePoint: 0.5,
      foamGamma: 0.54,
      foamContrast: 1.0,
      foamBrightness: 0.0,

      floatingFoamStrength: 0.48,
      floatingFoamCoverage: 0.2,
      floatingFoamScale: 149.5,

      // GPU foam spray / tear-off
      foamFlecksEnabled: true,
      foamFlecksIntensity: 1.0,
      foamTearEnabled: true,
      foamTearStrength: 0.65,
      foamTearScale: 750.0,
      foamTearSpeed: 1.25,
      foamTearDrift: 0.02,

      // Detached foam turbulence (chunks blown around)
      detachedTurbStrength: 0.35,
      detachedTurbScale: 0.25,
      detachedTurbSpeed: 0.35,

      sandEnabled: true,
      sandIntensity: 0.5,
      sandColor: { r: 0, g: 0, b: 0 },
      sandChunkScale: 5.4,
      sandChunkSpeed: 0.37,
      sandGrainScale: 266,
      sandGrainSpeed: 0.02,
      sandBillowStrength: 0.51,

      sandCoverage: 1,
      sandChunkSoftness: 0.32,
      sandSpeckCoverage: 0.47,
      sandSpeckSoftness: 0.06,
      sandDepthLo: 0,
      sandDepthHi: 1,
      sandAnisotropy: 0.66,
      sandDistortionStrength: 0.01,
      sandAdditive: 0.5,

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

    this._quadScene = null;
    this._quadCamera = null;
    this._quadMesh = null;
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
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'water',
          label: 'Water',
          type: 'inline',
          parameters: [
            'tintStrength',
            'tintColor',

            'maskChannel',
            'maskInvert',
            'maskThreshold',
            'maskBlurRadius',
            'maskBlurPasses',
            'maskExpandPx',
            'buildResolution',
            'sdfRangePx',
            'shoreWidthPx',

            'waveScale',
            'waveSpeed',
            'waveStrength',
            'distortionStrengthPx',
            'waveDirOffsetDeg',
            'waveAppearanceOffsetDeg',
            'advectionDirOffsetDeg',
            'advectionSpeed',
            'windDirResponsiveness',
            'useTargetWindDirection',
            'specStrength',
            'specPower',

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

            'sandEnabled',
            'sandIntensity',
            'sandColor',
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
            'sandAdditive',
            'debugView'
          ]
        }
        ,
        {
          name: 'foam-spray',
          label: 'Foam Spray (GPU)',
          type: 'inline',
          separator: true,
          parameters: [
            'foamFlecksEnabled',
            'foamFlecksIntensity',
            'foamTearEnabled',
            'foamTearStrength',
            'foamTearScale',
            'foamTearSpeed',
            'foamTearDrift',
            'detachedTurbStrength',
            'detachedTurbScale',
            'detachedTurbSpeed'
          ]
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true },
        tintStrength: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.15 },
        tintColor: { type: 'color', default: { r: 0.1, g: 0.3, b: 0.48 } },

        maskChannel: {
          type: 'list',
          label: 'Mask Channel',
          options: {
            Auto: 'auto',
            Red: 'r',
            Alpha: 'a',
            Luma: 'luma'
          },
          default: 'auto'
        },
        maskInvert: { type: 'boolean', label: 'Invert Mask', default: false },
        maskThreshold: { type: 'slider', label: 'Mask Threshold', min: 0.0, max: 1.0, step: 0.01, default: 0.05, throttle: 50 },
        maskBlurRadius: { type: 'slider', label: 'Mask Blur Radius (px)', min: 0.0, max: 16.0, step: 0.1, default: 0.0, throttle: 50 },
        maskBlurPasses: { type: 'slider', label: 'Mask Blur Passes', min: 0, max: 6, step: 1, default: 0, throttle: 50 },
        maskExpandPx: { type: 'slider', label: 'Mask Expand/Contract (px)', min: -64.0, max: 64.0, step: 0.25, default: -1, throttle: 50 },

        buildResolution: { type: 'list', label: 'Build Resolution', options: { 256: 256, 512: 512, 1024: 1024 }, default: 1024 },
        sdfRangePx: { type: 'slider', label: 'SDF Range (px)', min: 8, max: 256, step: 1, default: 64, throttle: 50 },
        shoreWidthPx: { type: 'slider', label: 'Shore Width (px)', min: 1, max: 128, step: 1, default: 101, throttle: 50 },

        waveScale: { type: 'slider', min: 1, max: 60, step: 0.5, default: 33.5 },
        waveSpeed: { type: 'slider', min: 0, max: 2.0, step: 0.01, default: 0.16 },
        waveStrength: { type: 'slider', min: 0, max: 2.0, step: 0.01, default: 0.57 },
        distortionStrengthPx: { type: 'slider', min: 0, max: 64.0, step: 0.01, default: 16.93 },

        waveDirOffsetDeg: { type: 'slider', label: 'Wave Dir Offset (deg)', min: -180.0, max: 180.0, step: 1.0, default: 0.0 },
        waveAppearanceOffsetDeg: { type: 'slider', label: 'Wave Appearance Offset (deg)', min: -180.0, max: 180.0, step: 1.0, default: 0.0 },
        advectionDirOffsetDeg: { type: 'slider', label: 'Advection Dir Offset (deg)', min: -180.0, max: 180.0, step: 1.0, default: 0.0 },
        advectionSpeed: { type: 'slider', label: 'Advection Speed', min: 0.0, max: 4.0, step: 0.01, default: 0.1 },
        windDirResponsiveness: { type: 'slider', label: 'Wind Dir Responsiveness', min: 0.1, max: 10.0, step: 0.1, default: 3.8 },
        useTargetWindDirection: { type: 'boolean', label: 'Use Target Wind Dir', default: true },

        specStrength: { type: 'slider', min: 0, max: 250.0, step: 0.01, default: 28.08 },
        specPower: { type: 'slider', min: 1, max: 24, step: 0.5, default: 24 },

        foamStrength: { type: 'slider', label: 'Foam Strength', min: 0, max: 1.0, step: 0.01, default: 0.79 },
        foamColor: { type: 'color', label: 'Foam Color', default: { r: 0.9, g: 0.95, b: 1.0 } },
        foamThreshold: { type: 'slider', label: 'Foam Width', min: 0.0, max: 1.0, step: 0.01, default: 0.98 },
        foamScale: { type: 'slider', label: 'Foam Grain Scale', min: 1.0, max: 2000.0, step: 1.0, default: 443 },
        foamSpeed: { type: 'slider', label: 'Foam Speed', min: 0.0, max: 1.5, step: 0.01, default: 0.18 },

        foamCurlStrength: { type: 'slider', label: 'Foam Curl Strength', min: 0.0, max: 1.0, step: 0.01, default: 0.01 },
        foamCurlScale: { type: 'slider', label: 'Foam Curl Scale', min: 0.1, max: 30.0, step: 0.1, default: 30 },
        foamCurlSpeed: { type: 'slider', label: 'Foam Curl Speed', min: 0.0, max: 1.0, step: 0.01, default: 0.04 },

        foamBreakupStrength1: { type: 'slider', label: 'Foam Breakup 1 Strength', min: 0.0, max: 1.0, step: 0.01, default: 1 },
        foamBreakupScale1: { type: 'slider', label: 'Foam Breakup 1 Scale', min: 0.1, max: 200.0, step: 0.1, default: 5.2 },
        foamBreakupSpeed1: { type: 'slider', label: 'Foam Breakup 1 Speed', min: 0.0, max: 1.0, step: 0.01, default: 0.2 },
        foamBreakupStrength2: { type: 'slider', label: 'Foam Breakup 2 Strength', min: 0.0, max: 1.0, step: 0.01, default: 1 },
        foamBreakupScale2: { type: 'slider', label: 'Foam Breakup 2 Scale', min: 0.1, max: 100.0, step: 0.1, default: 90.6 },
        foamBreakupSpeed2: { type: 'slider', label: 'Foam Breakup 2 Speed', min: 0.0, max: 1.0, step: 0.01, default: 0.28 },

        foamBlackPoint: { type: 'slider', label: 'Foam Black Point', min: 0.0, max: 1.0, step: 0.01, default: 0.13 },
        foamWhitePoint: { type: 'slider', label: 'Foam White Point', min: 0.0, max: 1.0, step: 0.01, default: 0.5 },
        foamGamma: { type: 'slider', label: 'Foam Gamma', min: 0.1, max: 4.0, step: 0.01, default: 0.54 },
        foamContrast: { type: 'slider', label: 'Foam Contrast', min: 0.0, max: 3.0, step: 0.01, default: 1.0 },
        foamBrightness: { type: 'slider', label: 'Foam Brightness', min: -1.0, max: 1.0, step: 0.01, default: 0.0 },

        floatingFoamStrength: { type: 'slider', label: 'Floating Foam Strength', min: 0.0, max: 1.0, step: 0.01, default: 0.48 },
        floatingFoamCoverage: { type: 'slider', label: 'Floating Foam Coverage', min: 0.0, max: 1.0, step: 0.01, default: 0.2 },
        floatingFoamScale: { type: 'slider', label: 'Floating Foam Scale', min: 0.1, max: 400.0, step: 0.5, default: 149.5 },

        foamFlecksEnabled: { type: 'boolean', label: 'Foam Flecks (GPU)', default: true },
        foamFlecksIntensity: { type: 'slider', label: 'Flecks Intensity', min: 0.0, max: 6.0, step: 0.01, default: 1.0 },
        foamTearEnabled: { type: 'boolean', label: 'Foam Tear-Off', default: true },
        foamTearStrength: { type: 'slider', label: 'Tear Strength', min: 0.0, max: 2.0, step: 0.01, default: 0.65 },
        foamTearScale: { type: 'slider', label: 'Tear Scale', min: 50.0, max: 3000.0, step: 1.0, default: 750.0 },
        foamTearSpeed: { type: 'slider', label: 'Tear Speed (Signed)', min: -6.0, max: 6.0, step: 0.01, default: 1.25 },
        foamTearDrift: { type: 'slider', label: 'Tear Drift (Signed UV)', min: -0.25, max: 0.25, step: 0.001, default: 0.02 },

        detachedTurbStrength: { type: 'slider', label: 'Detached Turb Strength', min: 0.0, max: 2.0, step: 0.01, default: 0.35 },
        detachedTurbScale: { type: 'slider', label: 'Detached Turb Scale', min: 0.05, max: 2.0, step: 0.01, default: 0.25 },
        detachedTurbSpeed: { type: 'slider', label: 'Detached Turb Speed', min: 0.0, max: 2.0, step: 0.01, default: 0.35 },

        sandEnabled: { type: 'boolean', label: 'Sand Enabled', default: true },
        sandIntensity: { type: 'slider', label: 'Sand Intensity', min: 0.0, max: 1.0, step: 0.01, default: 0.5 },
        sandColor: { type: 'color', label: 'Sand Color', default: { r: 0, g: 0, b: 0 } },
        sandChunkScale: { type: 'slider', label: 'Sand Chunk Scale', min: 0.1, max: 20.0, step: 0.1, default: 5.4 },
        sandChunkSpeed: { type: 'slider', label: 'Sand Chunk Speed', min: 0.0, max: 3.0, step: 0.01, default: 0.37 },
        sandGrainScale: { type: 'slider', label: 'Sand Grain Scale', min: 10.0, max: 400.0, step: 1.0, default: 266 },
        sandGrainSpeed: { type: 'slider', label: 'Sand Grain Speed', min: 0.0, max: 5.0, step: 0.01, default: 0.02 },
        sandBillowStrength: { type: 'slider', label: 'Sand Billow Strength', min: 0.0, max: 1.0, step: 0.01, default: 0.51 },

        sandCoverage: { type: 'slider', label: 'Sand Coverage', min: 0.0, max: 1.0, step: 0.01, default: 1 },
        sandChunkSoftness: { type: 'slider', label: 'Sand Chunk Softness', min: 0.01, max: 0.5, step: 0.01, default: 0.32 },
        sandSpeckCoverage: { type: 'slider', label: 'Sand Speck Coverage', min: 0.0, max: 1.0, step: 0.01, default: 0.47 },
        sandSpeckSoftness: { type: 'slider', label: 'Sand Speck Softness', min: 0.01, max: 0.5, step: 0.01, default: 0.06 },
        sandDepthLo: { type: 'slider', label: 'Sand Depth Lo', min: 0.0, max: 1.0, step: 0.01, default: 0 },
        sandDepthHi: { type: 'slider', label: 'Sand Depth Hi', min: 0.0, max: 1.0, step: 0.01, default: 1 },
        sandAnisotropy: { type: 'slider', label: 'Sand Anisotropy', min: 0.0, max: 1.0, step: 0.01, default: 0.66 },
        sandDistortionStrength: { type: 'slider', label: 'Sand Distortion Strength', min: 0.0, max: 1.0, step: 0.01, default: 0.01 },
        sandAdditive: { type: 'slider', label: 'Sand Additive', min: 0.0, max: 0.5, step: 0.01, default: 0.5 },

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
            FoamMask: 11,
            DetachedFoam: 12,
            DetachedInBounds: 13,
            DetachedSpawn: 14,
            DetachedOriginInside: 15,
            DetachedOriginFoam: 16,
            DetachedOriginTear: 17,
            DetachedSourceGate: 18
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

    this._smoothedWindDir = new THREE.Vector2(1.0, 0.0);
    this._tempWindTarget = new THREE.Vector2(1.0, 0.0);
    this._windOffsetUv = new THREE.Vector2(0.0, 0.0);
    this._windTime = 0.0;

    this._material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tWaterData: { value: null },
        uHasWaterData: { value: 0.0 },
        uWaterEnabled: { value: 1.0 },

        tWaterRawMask: { value: null },
        uHasWaterRawMask: { value: 0.0 },

        tWaterOccluderAlpha: { value: null },
        uHasWaterOccluderAlpha: { value: 0.0 },

        uWaterDataTexelSize: { value: new THREE.Vector2(1 / this.params.buildResolution, 1 / this.params.buildResolution) },

        uTintColor: { value: new THREE.Color(this.params.tintColor.r, this.params.tintColor.g, this.params.tintColor.b) },
        uTintStrength: { value: this.params.tintStrength },

        uWaveScale: { value: this.params.waveScale },
        uWaveSpeed: { value: this.params.waveSpeed },
        uWaveStrength: { value: this.params.waveStrength },
        uDistortionStrengthPx: { value: this.params.distortionStrengthPx },

        uWindDir: { value: new THREE.Vector2(1.0, 0.0) },
        uWindSpeed: { value: 0.0 },
        uWindOffsetUv: { value: new THREE.Vector2(0.0, 0.0) },
        uWindTime: { value: 0.0 },

        uWaveDirOffsetRad: { value: 0.0 },
        uWaveAppearanceRotRad: { value: 0.0 },

        uSpecStrength: { value: this.params.specStrength },
        uSpecPower: { value: this.params.specPower },

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

        // Shader-based foam flecks (spray dots)
        uFoamFlecksEnabled: { value: this.params.foamFlecksEnabled ? 1.0 : 0.0 },
        uFoamFlecksIntensity: { value: this.params.foamFlecksIntensity },

        // GPU foam tear-off
        uFoamTearEnabled: { value: this.params.foamTearEnabled ? 1.0 : 0.0 },
        uFoamTearStrength: { value: this.params.foamTearStrength },
        uFoamTearScale: { value: this.params.foamTearScale },
        uFoamTearSpeed: { value: this.params.foamTearSpeed },
        uFoamTearDrift: { value: this.params.foamTearDrift },

        // Detached foam turbulence
        uDetachedTurbStrength: { value: this.params.detachedTurbStrength },
        uDetachedTurbScale: { value: this.params.detachedTurbScale },
        uDetachedTurbSpeed: { value: this.params.detachedTurbSpeed },

        uSandEnabled: { value: this.params.sandEnabled ? 1.0 : 0.0 },
        uSandIntensity: { value: this.params.sandIntensity },
        uSandColor: { value: new THREE.Color(this.params.sandColor.r, this.params.sandColor.g, this.params.sandColor.b) },
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

        // Zoom stability: scale pixel offsets by current zoom (zoom out => smaller offset in UV).
        uZoom: { value: 1.0 },

        uViewBounds: { value: this._viewBounds },
        uSceneDimensions: { value: this._sceneDimensions },
        uSceneRect: { value: this._sceneRect },
        uHasSceneRect: { value: 0.0 }
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

        uniform vec2 uWindDir;
        uniform float uWindSpeed;
        uniform vec2 uWindOffsetUv;
        uniform float uWindTime;

        uniform float uWaveDirOffsetRad;
        uniform float uWaveAppearanceRotRad;

        uniform float uSpecStrength;
        uniform float uSpecPower;

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

        // Shader-based foam flecks (spray dots)
        uniform float uFoamFlecksEnabled;
        uniform float uFoamFlecksIntensity;

        // GPU foam tear-off
        uniform float uFoamTearEnabled;
        uniform float uFoamTearStrength;
        uniform float uFoamTearScale;
        uniform float uFoamTearSpeed;
        uniform float uFoamTearDrift;

        // Detached foam turbulence
        uniform float uDetachedTurbStrength;
        uniform float uDetachedTurbScale;
        uniform float uDetachedTurbSpeed;

        uniform float uSandEnabled;
        uniform float uSandIntensity;
        uniform vec3 uSandColor;
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

        varying vec2 vUv;

        float waterInsideFromSdf(float sdf01);

        float hash12(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }

        float valueNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          float a = hash12(i);
          float b = hash12(i + vec2(1.0, 0.0));
          float c = hash12(i + vec2(0.0, 1.0));
          float d = hash12(i + vec2(1.0, 1.0));
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
        }

        float fbmNoise(vec2 p) {
          float sum = 0.0;
          float amp = 0.55;
          float freq = 1.0;
          for (int i = 0; i < 4; i++) {
            sum += (valueNoise(p * freq) - 0.5) * 2.0 * amp;
            freq *= 2.0;
            amp *= 0.55;
          }
          return sum;
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

        vec2 warpUv(vec2 sceneUv) {
          // IMPORTANT: advecting by changing sampling coordinates is direction-inverted.
          // If we want the *visible* pattern to move with the wind, we must subtract
          // the accumulated offset from the sampling UVs.
          // Match wave math convention: convert Foundry Y-down drift to math Y-up.
          vec2 windOffsetUv = vec2(uWindOffsetUv.x, -uWindOffsetUv.y);
          vec2 uv = sceneUv - windOffsetUv;

          // Large-scale domain warp to reduce obvious repetition across big bodies of water.
          float lf1 = fbmNoise(sceneUv * 0.23 + vec2(19.1, 7.3));
          float lf2 = fbmNoise(sceneUv * 0.23 + vec2(3.7, 23.9));
          uv += vec2(lf1, lf2) * 0.22;

          float n1 = fbmNoise(uv * 2.1 + vec2(13.7, 9.2));
          float n2 = fbmNoise(uv * 2.1 + vec2(41.3, 27.9));
          uv += vec2(n1, n2) * 0.06;
          float n3 = fbmNoise(uv * 4.7 + vec2(7.9, 19.1));
          float n4 = fbmNoise(uv * 4.7 + vec2(29.4, 3.3));
          uv += vec2(n3, n4) * 0.02;
          return uv;
        }

        vec2 rotate2D(vec2 v, float a) {
          float s = sin(a);
          float c = cos(a);
          return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
        }

        // --- SHADER-BASED FOAM FLECKS ---
        // Generates high-frequency "spray" dots that move faster than foam with wind.
        // Uses a widened foam mask so flecks appear around edges, simulating spray blown off crests.
        float getShaderFlecks(vec2 sceneUv, float shore, float inside, float foamAmount) {
          if (uFoamFlecksEnabled < 0.5 || uFoamFlecksIntensity < 0.01) return 0.0;

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
        // --- SHADER FLECKS END ---

        float getFoamTearMask(vec2 sceneUv, float shore, float inside, float foamAmount) {
          if (uFoamTearEnabled < 0.5) return 0.0;

          float sceneAspect = (uHasSceneRect > 0.5) ? (uSceneRect.z / max(1.0, uSceneRect.w)) : (uResolution.x / max(1.0, uResolution.y));

          vec2 windF = uWindDir;
          float windLen = length(windF);
          windF = (windLen > 1e-6) ? (windF / windLen) : vec2(1.0, 0.0);
          vec2 windDir = vec2(windF.x, -windF.y);
          vec2 windBasis = normalize(vec2(windDir.x * sceneAspect, windDir.y));

          float wind01 = clamp(uWindSpeed, 0.0, 1.0);
          float tWind = uWindTime;

          // Noise domain in the same basis as foam so it tears at foam edges rather than swimming.
          vec2 foamWindOffsetUv = vec2(uWindOffsetUv.x, -uWindOffsetUv.y);
          vec2 foamSceneUv = sceneUv - (foamWindOffsetUv * 0.5);
          vec2 basis = vec2(foamSceneUv.x * sceneAspect, foamSceneUv.y);

          float spd = uFoamTearSpeed;
          vec2 adv = windBasis * (tWind * (0.35 + spd));
          vec2 p = basis * max(0.1, uFoamTearScale) - adv * 2.5;

          float n = valueNoise(p);
          n = max(n, valueNoise(p * 1.7 + 3.1));

          // Only tear where there is visible foam.
          float gate = smoothstep(0.25, 0.85, foamAmount) * inside;

          float tear = smoothstep(0.72, 0.98, n) * gate;
          return clamp(tear, 0.0, 1.0);
        }

        float getFoamBaseAmount(vec2 sceneUv, float shore, float inside) {
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
          float c1 = valueNoise(clumpUv);
          float c2 = valueNoise(clumpUv * 2.1 + 5.2);
          float c = c1 * 0.7 + c2 * 0.3;
          float clumps = smoothstep(1.0 - clamp(uFloatingFoamCoverage, 0.0, 1.0), 1.0, c);

          float deepMask = smoothstep(0.15, 0.65, 1.0 - shore);
          float floatingFoamAmount = clumps * inside * max(0.0, uFloatingFoamStrength) * deepMask;

          float foamAmount = clamp(shoreFoamAmount + floatingFoamAmount, 0.0, 1.0);

          float bp = clamp(uFoamBlackPoint, 0.0, 1.0);
          float wp = clamp(uFoamWhitePoint, 0.0, 1.0);
          foamAmount = clamp((foamAmount - bp) / max(1e-5, wp - bp), 0.0, 1.0);
          foamAmount = pow(foamAmount, max(0.01, uFoamGamma));
          foamAmount = (foamAmount - 0.5) * max(0.0, uFoamContrast) + 0.5;
          foamAmount = clamp(foamAmount + uFoamBrightness, 0.0, 1.0);

          return foamAmount;
        }

        vec4 getDetachedFoamSignals(vec2 sceneUv, float shore, float inside) {
          if (uFoamTearEnabled < 0.5) return vec4(0.0);

          // 1. Setup Standard Coordinates
          float sceneAspect = (uHasSceneRect > 0.5) ? (uSceneRect.z / max(1.0, uSceneRect.w)) : (uResolution.x / max(1.0, uResolution.y));
          vec2 windF = uWindDir;
          float windLen = length(windF);
          windF = (windLen > 1e-6) ? (windF / windLen) : vec2(1.0, 0.0);
          vec2 windDir = vec2(windF.x, -windF.y);

          float wind01 = clamp(uWindSpeed, 0.0, 1.0);
          float tWind = uWindTime;

          float signedSpd = clamp(uFoamTearSpeed, -3.0, 3.0);
          float spd = clamp(abs(signedSpd), 0.1, 3.0);
          float rate = 0.2 * spd;
          float globalPhase = fract(tWind * rate);

          // 4. Movement Logic (Float with Wind): advect a chunk field from upwind.
          float spdSign = (signedSpd < 0.0) ? -1.0 : 1.0;
          vec2 advDir = windDir * spdSign;

          // NOTE: sceneUv is already normalized (0..1). The travel distance must be small
          // in UV space, otherwise originUv goes out-of-bounds and the entire layer vanishes.
          float windFactor = 0.15 + 0.85 * wind01;
          float maxDist = (0.008 + 0.045 * spd) * windFactor;
          float travelDist = globalPhase * maxDist;
          // Add turbulence to the upwind sampling so detached chunks wobble/swerve instead of
          // translating in a perfectly straight line. Uses dedicated detached turbulence params.
          float turbStrength = clamp(uDetachedTurbStrength, 0.0, 2.0);
          float turbAmp = (0.08 + 0.32 * spd) * maxDist * turbStrength;
          float turbScale = max(0.1, uDetachedTurbScale);
          float turbSpeed = uDetachedTurbSpeed;
          vec2 basisT = vec2(sceneUv.x * sceneAspect, sceneUv.y) * (turbScale * 8.0);
          vec2 windBasisT = normalize(vec2(advDir.x * sceneAspect, advDir.y));
          vec2 curlP = basisT - windBasisT * (tWind * turbSpeed);
          vec2 turb = curlNoise2D(curlP);
          vec2 turbUv = vec2(turb.x / max(1e-6, sceneAspect), turb.y);
          vec2 originUv = sceneUv - advDir * travelDist - turbUv * (turbAmp * (0.25 + 0.75 * globalPhase));
          float inBounds = step(0.0, originUv.x) * step(originUv.x, 1.0) * step(0.0, originUv.y) * step(originUv.y, 1.0);
          vec2 originUvClamped = clamp(originUv, vec2(0.0), vec2(1.0));

          // 2. Define "Chunks" using a Grid IN ORIGIN SPACE so the pattern translates.
          vec2 foamWindOffsetUv = vec2(uWindOffsetUv.x, -uWindOffsetUv.y);
          vec2 foamSceneUvO = originUv - (foamWindOffsetUv * 0.5);
          vec2 basisO = vec2(foamSceneUvO.x * sceneAspect, foamSceneUvO.y);
          float chunkScale = max(10.0, uFoamTearScale * 0.15);

          vec2 gridUv = basisO * chunkScale;
          gridUv += fbmNoise(gridUv * 0.5) * 0.5;

          vec2 gridId = floor(gridUv);
          vec2 gridLocal = fract(gridUv) - 0.5;

          // 3. Generate Lifecycle per Chunk
          float cellSeed = hash12(gridId);
          float spawnChance = smoothstep(0.92, 0.99, cellSeed);

          // 5. Source Check
          vec4 originData = texture2D(tWaterData, originUvClamped);
          float originInside = waterInsideFromSdf(originData.r);
          float originShore = clamp(originData.g, 0.0, 1.0);
          float originInsideGate = step(0.5, originInside);

          float originFoam = getFoamBaseAmount(originUv, originShore, originInside);
          float originTear = getFoamTearMask(originUv, originShore, originInside, originFoam);

          float tearStrength = clamp(uFoamTearStrength, 0.0, 3.0);
          float originSpray = originTear * smoothstep(0.35, 0.95, originFoam) * tearStrength;
          float originFoamFinal = clamp(originFoam - originSpray * 0.55, 0.0, 1.0);

          // Detached foam should be sourced from *white foam presence* primarily.
          // Gating strongly on originTear makes the layer vanish because originTear is a sparse/high-threshold mask.
          float sourceGate = smoothstep(0.55, 0.88, originFoamFinal);
          float tearHint = 0.35 + 0.65 * smoothstep(0.02, 0.25, originTear);

          // 6. Shaping and Disintegration
          float phase = fract(tWind * rate + cellSeed * 12.34);
          float life = smoothstep(0.0, 0.1, phase) * (1.0 - smoothstep(0.6, 1.0, phase));

          // Simple circular shape for clean white foam chunks (no dark noise erosion)
          float shape = 1.0 - smoothstep(0.25, 0.4 + (phase * 0.3), length(gridLocal));

          float strength = clamp(uFoamTearStrength, 0.0, 3.0);
          float detached = shape * life * strength * sourceGate * tearHint * spawnChance * originInsideGate * inBounds * inside * 1.25;

          return vec4(detached, inBounds, spawnChance, sourceGate);
        }

        float getDetachedFoam(vec2 sceneUv, float shore, float inside) {
          return getDetachedFoamSignals(sceneUv, shore, inside).x;
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
          gSceneUv += amp * d * (k * dir) * uWaveScale;
        }

        float waveHeight(vec2 sceneUv, float t) {
          const float TAU = 6.2831853;

          vec2 windF = uWindDir;
          float wl = length(windF);
          windF = (wl > 1e-5) ? (windF / wl) : vec2(1.0, 0.0);
          // WeatherController windDirection is in Foundry/world coordinates (Y-down).
          // The wave phase math (dot(p, dir)) behaves like a standard math basis (Y-up).
          // Convert by flipping Y so wave travel matches wind at 90/270 degrees.
          vec2 wind = vec2(windF.x, -windF.y);
          wind = rotate2D(wind, uWaveDirOffsetRad);

          vec2 uvF = warpUv(sceneUv);
          vec2 uv = uvF;
          vec2 p = uv * uWaveScale;

          float h = 0.0;
          vec2 gDummy = vec2(0.0);

          // Directional sum-of-sines (spread around wind) with sharp crests.
          // Amplitudes sum to ~1.0 for stable output scaling.
          addWave(p, rotate2D(wind, -0.80), TAU * 0.57, 0.35, 2.30, (1.10 + 0.65 * sqrt(TAU * 0.57)), t, h, gDummy);
          addWave(p, rotate2D(wind, -0.35), TAU * 0.91, 0.25, 2.55, (1.10 + 0.65 * sqrt(TAU * 0.91)), t, h, gDummy);
          addWave(p, rotate2D(wind,  0.00), TAU * 1.37, 0.18, 2.85, (1.10 + 0.65 * sqrt(TAU * 1.37)), t, h, gDummy);
          addWave(p, rotate2D(wind,  0.40), TAU * 1.83, 0.12, 3.10, (1.10 + 0.65 * sqrt(TAU * 1.83)), t, h, gDummy);
          addWave(p, rotate2D(wind,  0.85), TAU * 2.49, 0.10, 3.35, (1.10 + 0.65 * sqrt(TAU * 2.49)), t, h, gDummy);

          return h;
        }

        vec2 waveGrad2D(vec2 sceneUv, float t) {
          const float TAU = 6.2831853;

          vec2 windF = uWindDir;
          float wl = length(windF);
          windF = (wl > 1e-5) ? (windF / wl) : vec2(1.0, 0.0);
          // Keep consistent with waveHeight(): flip Foundry Y-down to math Y-up.
          vec2 wind = vec2(windF.x, -windF.y);
          wind = rotate2D(wind, uWaveDirOffsetRad);

          vec2 uvF = warpUv(sceneUv);
          vec2 uv = uvF;
          vec2 p = uv * uWaveScale;

          float hDummy = 0.0;
          vec2 g = vec2(0.0);

          addWave(p, rotate2D(wind, -0.80), TAU * 0.57, 0.35, 2.30, (1.10 + 0.65 * sqrt(TAU * 0.57)), t, hDummy, g);
          addWave(p, rotate2D(wind, -0.35), TAU * 0.91, 0.25, 2.55, (1.10 + 0.65 * sqrt(TAU * 0.91)), t, hDummy, g);
          addWave(p, rotate2D(wind,  0.00), TAU * 1.37, 0.18, 2.85, (1.10 + 0.65 * sqrt(TAU * 1.37)), t, hDummy, g);
          addWave(p, rotate2D(wind,  0.40), TAU * 1.83, 0.12, 3.10, (1.10 + 0.65 * sqrt(TAU * 1.83)), t, hDummy, g);
          addWave(p, rotate2D(wind,  0.85), TAU * 2.49, 0.10, 3.35, (1.10 + 0.65 * sqrt(TAU * 2.49)), t, hDummy, g);

          // Normalize away the scale dependence so uWaveScale doesn't make razor-sharp gradients.
          return g / max(uWaveScale, 1e-3);
        }

        vec2 smoothFlow2D(vec2 sceneUv) {
          vec2 e = max(uWaterDataTexelSize, vec2(1.0 / 2048.0));
          vec2 s = texture2D(tWaterData, sceneUv).ba;
          s += texture2D(tWaterData, sceneUv + vec2(e.x, 0.0)).ba;
          s += texture2D(tWaterData, sceneUv - vec2(e.x, 0.0)).ba;
          s += texture2D(tWaterData, sceneUv + vec2(0.0, e.y)).ba;
          s += texture2D(tWaterData, sceneUv - vec2(0.0, e.y)).ba;
          s += texture2D(tWaterData, sceneUv + vec2(e.x, e.y)).ba;
          s += texture2D(tWaterData, sceneUv + vec2(-e.x, e.y)).ba;
          s += texture2D(tWaterData, sceneUv + vec2(e.x, -e.y)).ba;
          s += texture2D(tWaterData, sceneUv + vec2(-e.x, -e.y)).ba;
          s *= (1.0 / 9.0);
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

        float waterInsideFromSdf(float sdf01) {
          return smoothstep(0.52, 0.48, sdf01);
        }

        float sandMask(vec2 sceneUv, float shore, float inside, float sceneAspect) {
          float sandEnabled = step(0.5, uSandEnabled);
          if (sandEnabled < 0.5) return 0.0;

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
            vec2 waveGrad = waveGrad2D(sceneUv, uWindTime);
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

          float sandAlpha = speck * chunkMask * inside * depthMask;
          sandAlpha *= clamp(uSandIntensity, 0.0, 1.0);
          sandAlpha *= 1.15;
          return sandAlpha;
        }

        void main() {
          vec4 base = texture2D(tDiffuse, vUv);

          float isEnabled = step(0.5, uWaterEnabled) * step(0.5, uHasWaterData);
          if (isEnabled < 0.5) {
            gl_FragColor = base;
            return;
          }

          vec2 sceneUv = vUv;
          if (uHasSceneRect > 0.5) {
            vec2 foundryPos = screenUvToFoundry(vUv);
            sceneUv = foundryToSceneUv(foundryPos);
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
          float waterVisible = 1.0 - clamp(waterOccluder, 0.0, 1.0);
          inside *= waterVisible;

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
              float wv = 0.5 + 0.5 * waveHeight(sceneUv, uWindTime);
              gl_FragColor = vec4(vec3(wv), 1.0);
              return;
            }

            if (d < 7.5) {
              vec2 waveGrad = waveGrad2D(sceneUv, uWindTime);
              vec2 flowN = smoothFlow2D(sceneUv);
              vec2 combinedVec = waveGrad * uWaveStrength + flowN * 0.35;
              combinedVec = combinedVec / (1.0 + 0.75 * length(combinedVec));
              float m = length(combinedVec);
              float dirMask = smoothstep(0.01, 0.06, m);
              vec2 combinedN = (m > 1e-6) ? (combinedVec / m) * dirMask : vec2(0.0);
              float amp = smoothstep(0.0, 0.30, m);
              amp *= amp;
              vec2 texel = 1.0 / max(uResolution, vec2(1.0));
              float px = clamp(uDistortionStrengthPx, 0.0, 64.0);
              float zoom = max(uZoom, 0.001);
              vec2 offsetUv = combinedN * (px * texel) * amp * inside * max(0.35, shore) * zoom;
              vec2 pxOff = offsetUv / max(texel, vec2(1e-6));
              pxOff = clamp(pxOff / max(1.0, px), vec2(-1.0), vec2(1.0));
              gl_FragColor = vec4(pxOff * 0.5 + 0.5, 0.0, 1.0);
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
              // Sand mask debug (10): show the computed sand contribution as grayscale.
              float sandAspect = (uHasSceneRect > 0.5) ? (uSceneRect.z / max(1.0, uSceneRect.w)) : (uResolution.x / max(1.0, uResolution.y));
              float sandMaskOut = sandMask(sceneUv, shore, inside, sandAspect);
              gl_FragColor = vec4(vec3(clamp(sandMaskOut, 0.0, 1.0)), 1.0);
              return;
            }

            if (d < 11.5) {
              // Foam Mask Debug (11): final foam amount after CC + tear-off.

              float foamAmount = getFoamBaseAmount(sceneUv, shore, inside);
              float detachedFoam = getDetachedFoam(sceneUv, shore, inside);
              detachedFoam *= (1.0 - smoothstep(0.15, 0.45, foamAmount));
              foamAmount = clamp(foamAmount + detachedFoam, 0.0, 1.0);

              gl_FragColor = vec4(vec3(foamAmount), 1.0);
              return;
            }

            if (d < 12.5) {
              // Detached Foam Debug (12): show detached foam contribution as grayscale.
              vec4 sig = getDetachedFoamSignals(sceneUv, shore, inside);
              float detachedFoam = sig.x;
              // Boost for visibility while tuning; the real composite uses the un-boosted value.
              gl_FragColor = vec4(vec3(clamp(detachedFoam * 8.0, 0.0, 1.0)), 1.0);
              return;
            }

            if (d < 13.5) {
              // Detached InBounds Debug (13)
              vec4 sig = getDetachedFoamSignals(sceneUv, shore, inside);
              gl_FragColor = vec4(vec3(sig.y), 1.0);
              return;
            }

            if (d < 14.5) {
              // Detached SpawnChance Debug (14)
              vec4 sig = getDetachedFoamSignals(sceneUv, shore, inside);
              gl_FragColor = vec4(vec3(clamp(sig.z, 0.0, 1.0)), 1.0);
              return;
            }

            if (d < 15.5) {
              // Detached OriginInside Debug (15)
              vec4 originData = texture2D(tWaterData, sceneUv);
              float originInside = waterInsideFromSdf(originData.r);
              gl_FragColor = vec4(vec3(clamp(originInside, 0.0, 1.0)), 1.0);
              return;
            }

            if (d < 16.5) {
              // Detached OriginFoam Debug (16)
              vec4 originData = texture2D(tWaterData, sceneUv);
              float originInside = waterInsideFromSdf(originData.r);
              float originShore = clamp(originData.g, 0.0, 1.0);
              float originFoam = getFoamBaseAmount(sceneUv, originShore, originInside);
              gl_FragColor = vec4(vec3(clamp(originFoam, 0.0, 1.0)), 1.0);
              return;
            }

            if (d < 17.5) {
              // Detached OriginTear Debug (17)
              vec4 originData = texture2D(tWaterData, sceneUv);
              float originInside = waterInsideFromSdf(originData.r);
              float originShore = clamp(originData.g, 0.0, 1.0);
              float originFoam = getFoamBaseAmount(sceneUv, originShore, originInside);
              float originTear = getFoamTearMask(sceneUv, originShore, originInside, originFoam);
              gl_FragColor = vec4(vec3(clamp(originTear, 0.0, 1.0)), 1.0);
              return;
            }

            if (d < 18.5) {
              // Detached SourceGate Debug (18)
              vec4 sig = getDetachedFoamSignals(sceneUv, shore, inside);
              gl_FragColor = vec4(vec3(clamp(sig.w, 0.0, 1.0)), 1.0);
              return;
            }

            // Fall through: if the debug view isn't recognized, return magenta.
            gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0);
            return;
          }

          // Animated refraction / distortion.
          // Stability rule: pixel offsets must be in pixels then scaled by screen texel size.
          vec2 waveGrad = waveGrad2D(sceneUv, uWindTime);
          // Appearance-only rotation: rotates the wave normal/distortion texture without changing
          // the underlying wave travel direction (phase propagation).
          // Add a 90-degree correction so crest lines visually align perpendicular
          // to the wind-driven travel direction.
          waveGrad = rotate2D(waveGrad, uWaveAppearanceRotRad + 1.5707963);
          vec2 flowN = smoothFlow2D(sceneUv);
          vec2 combinedVec = waveGrad * uWaveStrength + flowN * 0.35;
          
          combinedVec = combinedVec / (1.0 + 0.75 * length(combinedVec));
          float m = length(combinedVec);
          float dirMask = smoothstep(0.01, 0.06, m);
          vec2 combinedN = (m > 1e-6) ? (combinedVec / m) * dirMask : vec2(0.0);
          float amp = smoothstep(0.0, 0.30, m);
          amp *= amp;
          vec2 texel = 1.0 / max(uResolution, vec2(1.0));
          float px = clamp(uDistortionStrengthPx, 0.0, 64.0);
          float zoom = max(uZoom, 0.001);
          vec2 offsetUv = combinedN * (px * texel) * amp * inside * max(0.35, shore) * zoom;

          if (uDebugView > 4.5) {
            vec2 pxOff = offsetUv / max(texel, vec2(1e-6));
            pxOff = clamp(pxOff / max(1.0, px), vec2(-1.0), vec2(1.0));
            gl_FragColor = vec4(pxOff * 0.5 + 0.5, 0.0, 1.0);
            return;
          }

          // Multi-tap refraction along the offset direction to reduce razor-sharp edges.
          vec2 uv0 = clamp(vUv + offsetUv * 0.55, vec2(0.001), vec2(0.999));
          vec2 uv1 = clamp(vUv + offsetUv, vec2(0.001), vec2(0.999));
          vec2 uv2 = clamp(vUv + offsetUv * 1.55, vec2(0.001), vec2(0.999));
          vec4 refracted =
            texture2D(tDiffuse, uv0) * 0.25 +
            texture2D(tDiffuse, uv1) * 0.50 +
            texture2D(tDiffuse, uv2) * 0.25;

          float k = clamp(uTintStrength, 0.0, 1.0) * inside * shore;
          vec3 col = mix(refracted.rgb, uTintColor, k);

          // Underwater sand flurries: chunked patches with fine grain, advected with water flow.
          float sandEnabled = step(0.5, uSandEnabled);
          if (sandEnabled > 0.5) {
            float sandAspect = (uHasSceneRect > 0.5) ? (uSceneRect.z / max(1.0, uSceneRect.w)) : (uResolution.x / max(1.0, uResolution.y));
            float sandAlpha = sandMask(sceneUv, shore, inside, sandAspect);
            col = mix(col, uSandColor, sandAlpha);
            col += uSandColor * (sandAlpha * clamp(uSandAdditive, 0.0, 1.0));
          }

          // Foam bubbles around shorelines (exposure01/shore), broken up with animated grain.
          // shore: 0.0 in deep water, 1.0 at water boundary.
          float foamAmount = getFoamBaseAmount(sceneUv, shore, inside);

          // GPU tear-off: break up white foam and blow fragments downwind.
          float tearMask = getFoamTearMask(sceneUv, shore, inside, foamAmount);
          float tearStrength = clamp(uFoamTearStrength, 0.0, 3.0);
          float sprayFromFoam = tearMask * smoothstep(0.35, 0.95, foamAmount) * tearStrength;

          float detachedFoam = getDetachedFoam(sceneUv, shore, inside);
          detachedFoam *= (1.0 - smoothstep(0.15, 0.45, foamAmount));
          float foamVisual = clamp(foamAmount + detachedFoam, 0.0, 1.0);

          // Make the foam blend more opaque so underlying refracted dark detail
          // (sand, refraction, etc.) does not shimmer through and read as "dark foam noise".
          float foamAlpha = smoothstep(0.08, 0.35, foamVisual);
          foamAlpha = pow(foamAlpha, 0.75);
          col = mix(col, uFoamColor, foamAlpha);

          // Shader-based foam flecks: high-frequency spray dots blown downwind
          vec2 windUv2 = uWindDir;
          float wLen2 = length(windUv2);
          vec2 windF2 = (wLen2 > 1e-6) ? (windUv2 / wLen2) : vec2(1.0, 0.0);
          vec2 windDir2 = vec2(windF2.x, -windF2.y);
          vec2 sprayUv = sceneUv + windDir2 * clamp(uFoamTearDrift, -0.25, 0.25);

          float shaderFlecks = getShaderFlecks(sprayUv, shore, inside, foamAlpha);
          // Additive blend for bright spray dots
          col += uFoamColor * shaderFlecks * 0.8;
          // Add a softer "white spray" contribution driven by tear-off mask.
          col += uFoamColor * sprayFromFoam * 0.22;

          // Cheap specular highlight (adds motion/contrast, masked to water).
          vec2 g = waveGrad * uWaveStrength;
          vec3 N = normalize(vec3(-g.x, -g.y, 1.0));

          vec3 V = vec3(0.0, 0.0, 1.0);
          vec2 w2 = uWindDir;
          float wl2 = length(w2);
          w2 = (wl2 > 1e-5) ? (w2 / wl2) : vec2(1.0, 0.0);

          float w = clamp(uWindSpeed, 0.0, 1.0);
          vec3 L = normalize(vec3(w2.x, w2.y, 0.25 + 0.60 * w));

          float NoL = max(dot(N, L), 0.0);
          float NoV = max(dot(N, V), 0.0);
          vec3 H = normalize(L + V);
          float NoH = max(dot(N, H), 0.0);

          float exponent = 20.0 * max(1.0, uSpecPower);
          float specLobe = pow(NoH, exponent);

          float F0 = 0.02;
          float fres = F0 + (1.0 - F0) * pow(1.0 - NoV, 5.0);

          float spec = specLobe * fres * NoL;
          spec *= max(0.0, uSpecStrength) * inside;
          spec *= (0.10 + 0.90 * shore);
          col += spec;

          gl_FragColor = vec4(col, base.a);
        }
      `,
      depthWrite: false,
      depthTest: false
    });

    this._quadMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._material);
    this._quadScene.add(this._quadMesh);

    const size = new THREE.Vector2();
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

    const THREE = window.THREE;
    const u = this._material.uniforms;

    const elapsed = Number.isFinite(timeInfo?.elapsed) ? timeInfo.elapsed : 0.0;
    u.uTime.value = elapsed;

    if (u.uZoom) {
      const sceneComposer = window.MapShine?.sceneComposer ?? window.canvas?.mapShine?.sceneComposer;
      const z = sceneComposer?.currentZoom ?? (typeof sceneComposer?.getZoomScale === 'function' ? sceneComposer.getZoomScale() : 1.0);
      u.uZoom.value = Number.isFinite(z) ? z : 1.0;
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

    const t = this.params?.tintStrength;
    u.uTintStrength.value = Number.isFinite(t) ? t : 0.12;

    const c = this.params?.tintColor;
    if (c && (typeof c.r === 'number') && (typeof c.g === 'number') && (typeof c.b === 'number')) {
      u.uTintColor.value.setRGB(c.r, c.g, c.b);
    }

    if (u.uSandEnabled) {
      u.uSandEnabled.value = this.params?.sandEnabled ? 1.0 : 0.0;
    }
    if (u.uSandIntensity) {
      const v = this.params?.sandIntensity;
      u.uSandIntensity.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.18;
    }
    if (u.uSandColor) {
      const sc = this.params?.sandColor;
      if (typeof sc === 'string') {
        u.uSandColor.value.set(sc);
      } else if (sc && (typeof sc.r === 'number') && (typeof sc.g === 'number') && (typeof sc.b === 'number')) {
        u.uSandColor.value.setRGB(sc.r, sc.g, sc.b);
      }
    }
    if (u.uSandChunkScale) {
      const v = this.params?.sandChunkScale;
      u.uSandChunkScale.value = Number.isFinite(v) ? Math.max(0.01, v) : 2.4;
    }
    if (u.uSandChunkSpeed) {
      const v = this.params?.sandChunkSpeed;
      u.uSandChunkSpeed.value = Number.isFinite(v) ? Math.max(0.0, v) : 0.35;
    }
    if (u.uSandGrainScale) {
      const v = this.params?.sandGrainScale;
      u.uSandGrainScale.value = Number.isFinite(v) ? Math.max(1.0, v) : 140.0;
    }
    if (u.uSandGrainSpeed) {
      const v = this.params?.sandGrainSpeed;
      u.uSandGrainSpeed.value = Number.isFinite(v) ? Math.max(0.0, v) : 1.2;
    }
    if (u.uSandBillowStrength) {
      const v = this.params?.sandBillowStrength;
      u.uSandBillowStrength.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.22;
    }

    if (u.uSandCoverage) {
      const v = this.params?.sandCoverage;
      u.uSandCoverage.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.35;
    }
    if (u.uSandChunkSoftness) {
      const v = this.params?.sandChunkSoftness;
      u.uSandChunkSoftness.value = Number.isFinite(v) ? Math.max(0.001, Math.min(1.0, v)) : 0.18;
    }
    if (u.uSandSpeckCoverage) {
      const v = this.params?.sandSpeckCoverage;
      u.uSandSpeckCoverage.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.25;
    }
    if (u.uSandSpeckSoftness) {
      const v = this.params?.sandSpeckSoftness;
      u.uSandSpeckSoftness.value = Number.isFinite(v) ? Math.max(0.001, Math.min(1.0, v)) : 0.10;
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
      u.uSandAnisotropy.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.40;
    }
    if (u.uSandDistortionStrength) {
      const v = this.params?.sandDistortionStrength;
      u.uSandDistortionStrength.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.25;
    }
    if (u.uSandAdditive) {
      const v = this.params?.sandAdditive;
      u.uSandAdditive.value = Number.isFinite(v) ? Math.max(0.0, Math.min(1.0, v)) : 0.08;
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

    // Shader-based foam flecks uniform sync
    if (u.uFoamFlecksEnabled) {
      u.uFoamFlecksEnabled.value = this.params?.foamFlecksEnabled ? 1.0 : 0.0;
    }
    if (u.uFoamFlecksIntensity) {
      const fi = this.params?.foamFlecksIntensity;
      u.uFoamFlecksIntensity.value = Number.isFinite(fi) ? Math.max(0.0, fi) : 1.0;
    }

    // GPU foam tear-off uniform sync
    if (u.uFoamTearEnabled) {
      u.uFoamTearEnabled.value = this.params?.foamTearEnabled ? 1.0 : 0.0;
    }
    if (u.uFoamTearStrength) {
      const v = this.params?.foamTearStrength;
      u.uFoamTearStrength.value = Number.isFinite(v) ? Math.max(0.0, v) : 0.0;
    }
    if (u.uFoamTearScale) {
      const v = this.params?.foamTearScale;
      u.uFoamTearScale.value = Number.isFinite(v) ? Math.max(0.1, v) : 750.0;
    }
    if (u.uFoamTearSpeed) {
      const v = this.params?.foamTearSpeed;
      u.uFoamTearSpeed.value = Number.isFinite(v) ? v : 1.25;
    }
    if (u.uFoamTearDrift) {
      const v = this.params?.foamTearDrift;
      u.uFoamTearDrift.value = Number.isFinite(v) ? v : 0.02;
    }

    // Detached foam turbulence uniform sync
    if (u.uDetachedTurbStrength) {
      const v = this.params?.detachedTurbStrength;
      u.uDetachedTurbStrength.value = Number.isFinite(v) ? Math.max(0.0, v) : 0.35;
    }
    if (u.uDetachedTurbScale) {
      const v = this.params?.detachedTurbScale;
      u.uDetachedTurbScale.value = Number.isFinite(v) ? Math.max(0.05, v) : 0.25;
    }
    if (u.uDetachedTurbSpeed) {
      const v = this.params?.detachedTurbSpeed;
      u.uDetachedTurbSpeed.value = Number.isFinite(v) ? Math.max(0.0, v) : 0.35;
    }

    u.uDebugView.value = Number.isFinite(this.params?.debugView) ? this.params.debugView : 0.0;

    const waveScale = this.params?.waveScale;
    u.uWaveScale.value = Number.isFinite(waveScale) ? waveScale : 18.0;
    const waveSpeed = this.params?.waveSpeed;
    u.uWaveSpeed.value = Number.isFinite(waveSpeed) ? waveSpeed : 1.2;
    const waveStrength = this.params?.waveStrength;
    u.uWaveStrength.value = Number.isFinite(waveStrength) ? waveStrength : 1.10;

    const distPx = this.params?.distortionStrengthPx;
    u.uDistortionStrengthPx.value = Number.isFinite(distPx) ? distPx : 3.0;

    if (u.uWaveDirOffsetRad) {
      const deg = Number.isFinite(this.params?.waveDirOffsetDeg) ? this.params.waveDirOffsetDeg : -180.0;
      u.uWaveDirOffsetRad.value = (deg * Math.PI) / 180.0;
    }

    if (u.uWaveAppearanceRotRad) {
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
        const wSpeed01 = Number.isFinite(wSpeed) ? Math.max(0.0, Math.min(1.0, wSpeed)) : 0.0;
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
          const adRad = (adDeg * Math.PI) / 180.0;

          // Keep advection in the same basis as sceneUv (Foundry sceneRect UVs, Y-down).
          // Any Y-up conversions for wave math happen later in the shader.
          const cs = Math.cos(adRad);
          const sn = Math.sin(adRad);
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

    const specStrength = this.params?.specStrength;
    u.uSpecStrength.value = Number.isFinite(specStrength) ? specStrength : 0.25;
    const specPower = this.params?.specPower;
    u.uSpecPower.value = Number.isFinite(specPower) ? specPower : 3.0;

    this._rebuildWaterDataIfNeeded(false);

    u.tWaterData.value = this._waterData?.texture || null;
    u.uHasWaterData.value = this._waterData?.texture ? 1.0 : 0.0;
    u.uWaterEnabled.value = this.enabled ? 1.0 : 0.0;

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
      u.uWaterDataTexelSize.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
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

    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this._quadScene, this._quadCamera);
    renderer.autoClear = prevAutoClear;
  }

  onResize(width, height) {
    if (!this._material?.uniforms?.uResolution?.value) return;
    this._material.uniforms.uResolution.value.set(width, height);
  }

  dispose() {
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

    this._quadScene = null;
    this._quadCamera = null;

    this.waterMask = null;
    this.baseMesh = null;
    this._lastWaterMaskUuid = null;
  }

  _rebuildWaterDataIfNeeded(force) {
    if (!this.waterMask) return;

    const cacheKey = this._getWaterMaskCacheKey();
    if (!force && cacheKey && cacheKey === this._lastWaterMaskCacheKey && this._waterData?.texture) return;

    try {
      this._waterData = this._surfaceModel.buildFromMaskTexture(this.waterMask, {
        resolution: Number.isFinite(this.params?.buildResolution) ? this.params.buildResolution : 512,
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
    const v = Number.isFinite(tex.version) ? tex.version : 0;

    const p = this.params ?? {};
    const chan = (p.maskChannel === 'r' || p.maskChannel === 'a' || p.maskChannel === 'luma') ? p.maskChannel : 'auto';
    const inv = p.maskInvert ? 1 : 0;
    const th = Number.isFinite(p.maskThreshold) ? p.maskThreshold : 0.15;
    const br = Number.isFinite(p.maskBlurRadius) ? p.maskBlurRadius : 0.0;
    const bp = Number.isFinite(p.maskBlurPasses) ? p.maskBlurPasses : 0;
    const ex = Number.isFinite(p.maskExpandPx) ? p.maskExpandPx : 0.0;
    const res = Number.isFinite(p.buildResolution) ? p.buildResolution : 512;
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

      const corners = [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1]
      ];

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      for (const c of corners) {
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
