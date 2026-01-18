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
      maskExpandPx: -1.8,
      buildResolution: 512,
      sdfRangePx: 64,
      shoreWidthPx: 24,

      waveScale: 25.0,
      waveSpeed: 0.94,
      waveStrength: 0.31,
      distortionStrengthPx: 5.8,

      waveDirOffsetDeg: 0.0,
      waveAppearanceOffsetDeg: 0.0,
      advectionDirOffsetDeg: 0.0,
      advectionSpeed: 0.41,
      windDirResponsiveness: 3.8,
      useTargetWindDirection: true,

      specStrength: 210.14,
      specPower: 5.5,

      foamStrength: 0.6,
      foamThreshold: 0.65,
      foamScale: 80.0,
      foamColor: { r: 0.9, g: 0.95, b: 1.0 },
      foamSpeed: 0.1,

      foamCurlStrength: 0.12,
      foamCurlScale: 2.2,
      foamCurlSpeed: 0.06,

      foamBreakupStrength1: 0.35,
      foamBreakupScale1: 18.0,
      foamBreakupSpeed1: 0.07,

      foamBreakupStrength2: 0.20,
      foamBreakupScale2: 6.5,
      foamBreakupSpeed2: 0.03,

      foamBlackPoint: 0.0,
      foamWhitePoint: 1.0,
      foamGamma: 1.0,
      foamContrast: 1.0,
      foamBrightness: 0.0,

      floatingFoamStrength: 0.18,
      floatingFoamCoverage: 0.22,
      floatingFoamScale: 12.0,

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
            'debugView'
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
        maskExpandPx: { type: 'slider', label: 'Mask Expand/Contract (px)', min: -64.0, max: 64.0, step: 0.25, default: -1.8, throttle: 50 },

        buildResolution: { type: 'list', label: 'Build Resolution', options: { 256: 256, 512: 512, 1024: 1024 }, default: 512 },
        sdfRangePx: { type: 'slider', label: 'SDF Range (px)', min: 8, max: 256, step: 1, default: 64, throttle: 50 },
        shoreWidthPx: { type: 'slider', label: 'Shore Width (px)', min: 1, max: 128, step: 1, default: 24, throttle: 50 },

        waveScale: { type: 'slider', min: 1, max: 60, step: 0.5, default: 25.0 },
        waveSpeed: { type: 'slider', min: 0, max: 2.0, step: 0.01, default: 0.94 },
        waveStrength: { type: 'slider', min: 0, max: 2.0, step: 0.01, default: 0.31 },
        distortionStrengthPx: { type: 'slider', min: 0, max: 64.0, step: 0.01, default: 5.8 },

        waveDirOffsetDeg: { type: 'slider', label: 'Wave Dir Offset (deg)', min: -180.0, max: 180.0, step: 1.0, default: 0.0 },
        waveAppearanceOffsetDeg: { type: 'slider', label: 'Wave Appearance Offset (deg)', min: -180.0, max: 180.0, step: 1.0, default: 0.0 },
        advectionDirOffsetDeg: { type: 'slider', label: 'Advection Dir Offset (deg)', min: -180.0, max: 180.0, step: 1.0, default: 0.0 },
        advectionSpeed: { type: 'slider', label: 'Advection Speed', min: 0.0, max: 4.0, step: 0.01, default: 0.41 },
        windDirResponsiveness: { type: 'slider', label: 'Wind Dir Responsiveness', min: 0.1, max: 10.0, step: 0.1, default: 3.8 },
        useTargetWindDirection: { type: 'boolean', label: 'Use Target Wind Dir', default: true },

        specStrength: { type: 'slider', min: 0, max: 250.0, step: 0.01, default: 210.14 },
        specPower: { type: 'slider', min: 1, max: 24, step: 0.5, default: 5.5 },

        foamStrength: { type: 'slider', label: 'Foam Strength', min: 0, max: 1.0, step: 0.01, default: 0.6 },
        foamColor: { type: 'color', label: 'Foam Color', default: { r: 0.9, g: 0.95, b: 1.0 } },
        foamThreshold: { type: 'slider', label: 'Foam Width', min: 0.0, max: 1.0, step: 0.01, default: 0.65 },
        foamScale: { type: 'slider', label: 'Foam Grain Scale', min: 1.0, max: 2000.0, step: 1.0, default: 80.0 },
        foamSpeed: { type: 'slider', label: 'Foam Speed', min: 0.0, max: 1.5, step: 0.01, default: 0.1 },

        foamCurlStrength: { type: 'slider', label: 'Foam Curl Strength', min: 0.0, max: 1.0, step: 0.01, default: 0.12 },
        foamCurlScale: { type: 'slider', label: 'Foam Curl Scale', min: 0.1, max: 30.0, step: 0.1, default: 2.2 },
        foamCurlSpeed: { type: 'slider', label: 'Foam Curl Speed', min: 0.0, max: 1.0, step: 0.01, default: 0.06 },

        foamBreakupStrength1: { type: 'slider', label: 'Foam Breakup 1 Strength', min: 0.0, max: 1.0, step: 0.01, default: 0.35 },
        foamBreakupScale1: { type: 'slider', label: 'Foam Breakup 1 Scale', min: 0.1, max: 200.0, step: 0.1, default: 18.0 },
        foamBreakupSpeed1: { type: 'slider', label: 'Foam Breakup 1 Speed', min: 0.0, max: 1.0, step: 0.01, default: 0.07 },
        foamBreakupStrength2: { type: 'slider', label: 'Foam Breakup 2 Strength', min: 0.0, max: 1.0, step: 0.01, default: 0.20 },
        foamBreakupScale2: { type: 'slider', label: 'Foam Breakup 2 Scale', min: 0.1, max: 100.0, step: 0.1, default: 6.5 },
        foamBreakupSpeed2: { type: 'slider', label: 'Foam Breakup 2 Speed', min: 0.0, max: 1.0, step: 0.01, default: 0.03 },

        foamBlackPoint: { type: 'slider', label: 'Foam Black Point', min: 0.0, max: 1.0, step: 0.01, default: 0.0 },
        foamWhitePoint: { type: 'slider', label: 'Foam White Point', min: 0.0, max: 1.0, step: 0.01, default: 1.0 },
        foamGamma: { type: 'slider', label: 'Foam Gamma', min: 0.1, max: 4.0, step: 0.01, default: 1.0 },
        foamContrast: { type: 'slider', label: 'Foam Contrast', min: 0.0, max: 3.0, step: 0.01, default: 1.0 },
        foamBrightness: { type: 'slider', label: 'Foam Brightness', min: -1.0, max: 1.0, step: 0.01, default: 0.0 },

        floatingFoamStrength: { type: 'slider', label: 'Floating Foam Strength', min: 0.0, max: 1.0, step: 0.01, default: 0.18 },
        floatingFoamCoverage: { type: 'slider', label: 'Floating Foam Coverage', min: 0.0, max: 1.0, step: 0.01, default: 0.22 },
        floatingFoamScale: { type: 'slider', label: 'Floating Foam Scale', min: 0.1, max: 400.0, step: 0.5, default: 12.0 },

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
            Time: 9
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

        uWaterDataTexelSize: { value: new THREE.Vector2(1 / 512, 1 / 512) },

        uTintColor: { value: new THREE.Color(0.0, 0.0, 0.0) },
        uTintStrength: { value: 0.37 },

        uWaveScale: { value: 25.0 },
        uWaveSpeed: { value: 0.94 },
        uWaveStrength: { value: 0.38 },
        uDistortionStrengthPx: { value: 25.28 },

        uWindDir: { value: new THREE.Vector2(1.0, 0.0) },
        uWindSpeed: { value: 0.0 },
        uWindOffsetUv: { value: new THREE.Vector2(0.0, 0.0) },
        uWindTime: { value: 0.0 },

        uWaveDirOffsetRad: { value: 0.0 },
        uWaveAppearanceRotRad: { value: 0.0 },

        uSpecStrength: { value: 25.0 },
        uSpecPower: { value: 24.0 },

        uFoamColor: { value: new THREE.Color(0.9, 0.95, 1.0) },
        uFoamStrength: { value: 0.0 },
        uFoamThreshold: { value: 0.35 },
        uFoamScale: { value: 80.0 },
        uFoamSpeed: { value: 0.1 },

        uFoamCurlStrength: { value: 0.12 },
        uFoamCurlScale: { value: 2.2 },
        uFoamCurlSpeed: { value: 0.06 },

        uFoamBreakupStrength1: { value: 0.35 },
        uFoamBreakupScale1: { value: 18.0 },
        uFoamBreakupSpeed1: { value: 0.07 },
        uFoamBreakupStrength2: { value: 0.20 },
        uFoamBreakupScale2: { value: 6.5 },
        uFoamBreakupSpeed2: { value: 0.03 },

        uFoamBlackPoint: { value: 0.0 },
        uFoamWhitePoint: { value: 1.0 },
        uFoamGamma: { value: 1.0 },
        uFoamContrast: { value: 1.0 },
        uFoamBrightness: { value: 0.0 },

        uFloatingFoamStrength: { value: 0.0 },
        uFloatingFoamCoverage: { value: 0.0 },
        uFloatingFoamScale: { value: 12.0 },
        uDebugView: { value: 0.0 },

        uTime: { value: 0.0 },
        uResolution: { value: new THREE.Vector2(1, 1) },

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
        uniform float uDebugView;

        uniform float uTime;
        uniform vec2 uResolution;

        uniform vec4 uViewBounds;
        uniform vec2 uSceneDimensions;
        uniform vec4 uSceneRect;
        uniform float uHasSceneRect;

        varying vec2 vUv;

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
          // NOTE: We flip the Y component here to keep the advection drift in the same
          // basis as the wave travel direction (which flips Foundry Y-down to math Y-up).
          // Without this, high advectionSpeed can make the wave field appear Y-mirrored.
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
              vec2 offsetUv = combinedN * (px * texel) * amp * inside * max(0.35, shore);
              vec2 pxOff = offsetUv / max(texel, vec2(1e-6));
              pxOff = clamp(pxOff / max(1.0, px), vec2(-1.0), vec2(1.0));
              gl_FragColor = vec4(pxOff * 0.5 + 0.5, 0.0, 1.0);
              return;
            }

            if (d < 8.5) {
              gl_FragColor = vec4(vec3(waterOccluder), 1.0);
              return;
            }

            float t01 = fract(uTime * 0.25);
            gl_FragColor = vec4(vec3(t01), 1.0);
            return;
          }

          // Animated refraction / distortion.
          // Stability rule: pixel offsets must be in pixels then scaled by screen texel size.
          vec2 waveGrad = waveGrad2D(sceneUv, uWindTime);
          // Appearance-only rotation: rotates the wave normal/distortion texture without changing
          // the underlying wave travel direction (phase propagation).
          waveGrad = rotate2D(waveGrad, uWaveAppearanceRotRad);
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
          vec2 offsetUv = combinedN * (px * texel) * amp * inside * max(0.35, shore);

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

          // Foam bubbles around shorelines (exposure01/shore), broken up with animated grain.
          // shore: 0.0 in deep water, 1.0 at water boundary.
          // Advect with wind, but at ~half the wave advection speed so foam lags behind waves.
          vec2 foamSceneUv = sceneUv - (uWindOffsetUv * 0.5);

          // Aspect-correct the foam noise basis so the foam grain stays square in world space.
          float sceneAspect = (uHasSceneRect > 0.5) ? (uSceneRect.z / max(1.0, uSceneRect.w)) : (uResolution.x / max(1.0, uResolution.y));
          vec2 foamBasis = vec2(foamSceneUv.x * sceneAspect, foamSceneUv.y);

          // Curl-style flow warp (pseudo-curl from fbm gradient) to make foam motion less linear.
          vec2 windUv = uWindDir;
          // uWindDir is in Foundry/world coordinates (Y-down). Convert to a math-style basis (Y-up)
          // for the curl field advection so it matches perceived wind direction.
          windUv.y = -windUv.y;
          float windLen = length(windUv);
          windUv = (windLen > 1e-6) ? (windUv / windLen) : vec2(1.0, 0.0);
          // foamBasis is aspect-corrected in X, so the wind vector must be expressed in that same basis.
          vec2 windBasis = normalize(vec2(windUv.x * sceneAspect, windUv.y));
          vec2 curlP = foamBasis * max(0.01, uFoamCurlScale) - windBasis * (uTime * uFoamCurlSpeed);
          foamBasis += curlNoise2D(curlP) * clamp(uFoamCurlStrength, 0.0, 1.0);

          vec2 foamUv = foamBasis * max(0.1, uFoamScale) + vec2(uTime * uFoamSpeed * 0.5);
          float f1 = valueNoise(foamUv);
          float f2 = valueNoise(foamUv * 1.7 + 1.2);
          float bubbles = (f1 + f2) * 0.5;

          // Animated breakup layers to add motion + patchiness to shoreline foam.
          float b1 = fbmNoise(foamBasis * max(0.1, uFoamBreakupScale1) + vec2(uTime * uFoamBreakupSpeed1, -uTime * uFoamBreakupSpeed1 * 0.8));
          float b2 = fbmNoise(foamBasis * max(0.1, uFoamBreakupScale2) + vec2(-uTime * uFoamBreakupSpeed2 * 0.6, uTime * uFoamBreakupSpeed2));
          float breakup = 0.5 + 0.5 * (b1 * clamp(uFoamBreakupStrength1, 0.0, 1.0) + b2 * clamp(uFoamBreakupStrength2, 0.0, 1.0));
          breakup = clamp(breakup, 0.0, 1.0);

          float foamMask = shore + (bubbles * 0.3 - 0.15) + (breakup - 0.5) * 0.35;
          float shoreFoamAmount = smoothstep(uFoamThreshold, uFoamThreshold - 0.15, foamMask);
          shoreFoamAmount *= smoothstep(0.15, 0.85, breakup);
          shoreFoamAmount *= inside * max(0.0, uFoamStrength);

          // Floating foam: low-frequency clumps drifting with wind in open water.
          // As they drift into shoreline foam, we add them together (so they visibly accumulate).
          vec2 clumpUv = foamBasis * max(0.1, uFloatingFoamScale);
          clumpUv += vec2(uTime * (0.02 + uFoamSpeed * 0.05), uTime * (0.01 + uFoamSpeed * 0.03));
          float c1 = valueNoise(clumpUv);
          float c2 = valueNoise(clumpUv * 2.1 + 5.2);
          float c = c1 * 0.7 + c2 * 0.3;
          float clumps = smoothstep(1.0 - clamp(uFloatingFoamCoverage, 0.0, 1.0), 1.0, c);
          float grain = valueNoise(clumpUv * 4.0 + vec2(1.3, 7.9));
          clumps *= smoothstep(0.30, 0.75, grain);

          // Prefer deep water but allow drift into shore region for accumulation.
          float deepMask = smoothstep(0.15, 0.65, 1.0 - shore);
          float floatingFoamAmount = clumps * inside * max(0.0, uFloatingFoamStrength) * deepMask;

          float foamAmount = clamp(shoreFoamAmount + floatingFoamAmount, 0.0, 1.0);

          // Foam CC / curve shaping.
          float bp = clamp(uFoamBlackPoint, 0.0, 1.0);
          float wp = clamp(uFoamWhitePoint, 0.0, 1.0);
          foamAmount = clamp((foamAmount - bp) / max(1e-5, wp - bp), 0.0, 1.0);
          foamAmount = pow(foamAmount, max(0.01, uFoamGamma));
          foamAmount = (foamAmount - 0.5) * max(0.0, uFoamContrast) + 0.5;
          foamAmount = clamp(foamAmount + uFoamBrightness, 0.0, 1.0);

          col = mix(col, uFoamColor, foamAmount);

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
