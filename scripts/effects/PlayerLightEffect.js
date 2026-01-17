import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import Coordinates from '../utils/coordinates.js';
import { 
  ParticleSystem, 
  IntervalValue,
  ColorRange,
  Vector4,
  PointEmitter,
  ConeEmitter,
  RenderMode,
  ConstantValue,
  ColorOverLife,
  SizeOverLife,
  PiecewiseBezier,
  Bezier,
  ApplyForce,
  CurlNoiseField,
  FrameOverLife
} from '../libs/three.quarks.module.js';

import { SmartWindBehavior } from '../particles/SmartWindBehavior.js';
import { ThreeLightSource } from './ThreeLightSource.js';
import { OVERLAY_THREE_LAYER } from './EffectComposer.js';

const log = createLogger('PlayerLightEffect');

class SimpleSmoothNoise {
  constructor({ amplitude = 1, scale = 1, seed = 1 } = {}) {
    this.amplitude = amplitude;
    this.scale = scale;
    this.seed = seed;
  }

  _hash(i) {
    const x = Math.sin(i * 127.1 + this.seed * 311.7) * 43758.5453123;
    return x - Math.floor(x);
  }

  value(t) {
    const x = t * this.scale;
    const i0 = Math.floor(x);
    const f = x - i0;
    const a = this._hash(i0);
    const b = this._hash(i0 + 1);
    const u = f * f * (3 - 2 * f);
    return (a * (1 - u) + b * u - 0.5) * 2 * this.amplitude;
  }
}

export class PlayerLightEffect extends EffectBase {
  constructor() {
    super('player-light', RenderLayers.ENVIRONMENTAL, 'low');

    this.priority = 9;
    this.enabled = true;

    this.params = {
      enabled: true,
      mode: 'flashlight',

      torchMaxDistanceUnits: 10,
      flashlightMaxDistanceUnits: 60,
      fadeOutDistanceUnits: 7,
      wallBlockEnabled: true,

      springStiffness: 55,
      springDamping: 16,

      torchBaseIntensity: 0.66,
      emberIntensity: 0.85,
      torchGutterDisableLight: true,
      torchGutterLifeScale: 0.3,
      torchReigniteRequiresTouch: true,
      torchReigniteTouchExtraUnits: 0.25,
      intensityRiseSpeed: 55.5,
      intensityFallSpeed: 2.8,

      flickerIntensity: 0.33,
      flickerSpeed: 10.1,
      wanderPixels: 28,
      wanderSpeed: 2.3,

      flashlightAngleDeg: 38,
      flashlightLengthUnits: 18,
      flashlightIntensity: 5.4,
      flashlightBrokenness: 0.0,
      flashlightWobble: 0.0,

      flashlightBeamAngleDeg: 38,
      flashlightBeamLengthUnits: 18,
      flashlightBeamWidthScale: 1.36,
      flashlightBeamNearWidth: 0.01,
      flashlightBeamFarWidth: 1.0,
      flashlightBeamWidthCurve: 1.25,
      flashlightBeamEdgeSoftness: 0.18,
      flashlightBeamCoreIntensity: 1.25,
      flashlightBeamCoreSharpness: 10.0,
      flashlightBeamMidIntensity: 0.25,
      flashlightBeamMidSharpness: 2.2,
      flashlightBeamRimIntensity: 0.6,
      flashlightBeamRimSharpness: 14.0,
      flashlightBeamNearBoost: 1.6,
      flashlightBeamNearBoostCurve: 1.6,
      flashlightBeamLongFalloffExp: 1.7,
      flashlightBeamNoiseIntensity: 0.06,
      flashlightBeamNoiseScale: 7.0,
      flashlightBeamNoiseSpeed: 1.2,

      flashlightCookieIntensity: 1.68,
      flashlightCookieSizePx: 338,
      flashlightCookieSizeFromBeam: 0.48,
      flashlightCookieMaskRadius: 0.92,
      flashlightCookieMaskSoftness: 0.10,
      flashlightCookieCoreIntensity: 1.25,
      flashlightCookieCoreSharpness: 8.0,
      flashlightCookieRimIntensity: 0.55,
      flashlightCookieRimRadius: 0.78,
      flashlightCookieRimWidth: 0.22,
      flashlightCookieTexture: 'light_01',
      flashlightCookieRotation: true,
      flashlightCookieRotationSpeed: 0.3,

      flashlightCookiePerspectiveEnabled: true,
      flashlightCookiePerspectiveNearScale: 0.3,
      flashlightCookiePerspectiveFarScale: 4.0,
      flashlightCookiePerspectiveCurve: 2.34,
      flashlightCookiePerspectiveAnamorphic: 1.49,

      torchLightEnabled: true,
      torchLightColor: { r: 1.0, g: 0.42, b: 0.12 },
      torchLightDim: 19.5,
      torchLightBright: 3,
      torchLightAlpha: 0.87,
      torchLightAttenuation: 0.55,
      torchLightLuminosity: 2.2,
      torchLightAnimType: 'none',
      torchLightAnimSpeed: 2.7,
      torchLightAnimIntensity: 1.7,
      torchLightScaleWithIntensity: false,

      torchFlameSizeMin: 32,
      torchFlameSizeMax: 65,
      torchFlameRateMin: 90,
      torchFlameRateMax: 170,
      torchFlameUpdraft: 6.0,
      torchFlameWindInfluence: 0.25,

      torchSparksEnabled: true,
      torchSparksRate: 28,
      torchSparksSizeMin: 3,
      torchSparksSizeMax: 10,
      torchSparksLifeMin: 0.25,
      torchSparksLifeMax: 0.7,
      torchSparksUpdraft: 24.0,
      torchSparksWindInfluence: 0.45,
      torchSparksSpeedFactor: 0.03,

      flashlightLightEnabled: true,
      flashlightLightColor: { r: 3.0, g: 3.0, b: 3.0 },
      flashlightLightDim: 30.5,
      flashlightLightBright: 5,
      flashlightLightAlpha: 0.26,
      flashlightLightAttenuation: 1,
      flashlightLightLuminosity: 3,
      flashlightLightAnimType: 'none',
      flashlightLightAnimSpeed: 5,
      flashlightLightAnimIntensity: 18.7,
      flashlightLightUseCookiePosition: true,
      flashlightLightDistanceScaleEnabled: true,
      flashlightLightDistanceScaleNear: 0.28,
      flashlightLightDistanceScaleFar: 3,

      debugReadoutEnabled: false
    };

    this.scene = null;
    this.renderer = null;
    this.camera = null;

    this._pointerClientX = null;
    this._pointerClientY = null;
    this._onPointerMove = this._handlePointerMove.bind(this);

    this._hookIds = [];

    this._lastControlledTokenId = null;

    this._tempA = null;
    this._tempB = null;
    this._tempC = null;

    this._tempScreenSize = null;

    this._torchPos = null;
    this._torchVel = null;
    this._torchIntensity = 0;
    this._torchFinalIntensity = 0;

    this._torchGuttering = false;
    this._torchExtinguished = false;

    this._torchWasActiveLastFrame = false;
    this._torchPrevTokenId = null;

    this._distanceFade = 0;

    this._cookieTextures = {};
    this._cookieTextureNames = ['light_01', 'light_02', 'light_03'];
    this._cookieTextureStatus = {};
    this._defaultCookieTexture = null;

    this._torchParticlesRegistered = false;

    this._flickerNoise = new SimpleSmoothNoise({ amplitude: 1, scale: 1, seed: Math.random() * 1000 });
    this._wanderNoiseX = new SimpleSmoothNoise({ amplitude: 1, scale: 1, seed: Math.random() * 1000 + 10 });
    this._wanderNoiseY = new SimpleSmoothNoise({ amplitude: 1, scale: 1, seed: Math.random() * 1000 + 20 });

    this._flashlightMalfunctionNoise = new SimpleSmoothNoise({ amplitude: 1, scale: 1, seed: Math.random() * 1000 + 30 });
    this._flashlightMalfunctionRandState = (Math.random() * 0xFFFFFFFF) >>> 0;
    this._flashlightMalfunctionPhase = 0;
    this._flashlightMalfunctionPhaseT = 0;
    this._flashlightMalfunctionNextTime = 0;
    this._flashlightMalfunctionDimTarget = 1.0;
    this._flashlightMalfunctionDimDuration = 0;
    this._flashlightMalfunctionFlickerDuration = 0;
    this._flashlightMalfunctionDeadDuration = 0;
    this._flashlightMalfunctionRecoverDuration = 0;
    this._flashlightMalfunctionFlickerSpeed = 10.0;
    this._flashlightMalfunctionFlickerDropT = 0.25;
    this._flashlightMalfunctionFlickerPhase = 0;

    this._flashlightWobbleNoiseA = new SimpleSmoothNoise({ amplitude: 1, scale: 1, seed: Math.random() * 1000 + 40 });
    this._flashlightWobbleNoiseB = new SimpleSmoothNoise({ amplitude: 1, scale: 1, seed: Math.random() * 1000 + 50 });
    this._flashlightWobbleNoiseR = new SimpleSmoothNoise({ amplitude: 1, scale: 1, seed: Math.random() * 1000 + 60 });

    this._group = null;
    this._torchSprite = null;
    this._torchParticleSystem = null;
    this._torchSparksSystem = null;
    this._flashlightMesh = null;
    this._flashlightMat = null;
    this._flashlightBeamMesh = null;
    this._flashlightBeamMat = null;
    this._flashlightCookieMesh = null;
    this._flashlightCookieMat = null;
    this._flashlightOriginMesh = null;
    this._flashlightOriginMat = null;
    this._flashlightOriginTexture = null;

    this._torchTexture = null;
    this._torchSparksTexture = null;
    this._torchColorA = null;
    this._torchColorB = null;

    this._torchLightSource = null;
    this._flashlightLightSource = null;
    this._torchLightDoc = null;
    this._flashlightLightDoc = null;
    this._flashlightCookieWorld = null;
    this._flashlightAimWorld = null;

    this._flashlightFinalIntensity = 0;

    this._flashlightBeamInLightScene = false;

    this._visionMaskTexture = null;
    this._visionMaskTexelSize = null;
    this._visionMaskHas = 0.0;

    this._debugOverlay = null;
  }

  static getControlSchema() {
    return {
      enabled: false,
      groups: [
        {
          name: 'general',
          label: 'General',
          type: 'folder',
          expanded: true,
          parameters: [
            'enabled',
            'mode',
            'torchMaxDistanceUnits',
            'flashlightMaxDistanceUnits',
            'fadeOutDistanceUnits',
            'wallBlockEnabled',
            'debugReadoutEnabled'
          ]
        },
        {
          name: 'torch-behavior',
          label: 'Torch: Behavior',
          type: 'folder',
          parameters: [
            'springStiffness',
            'springDamping',
            'torchLightEnabled',
            'torchBaseIntensity',
            'emberIntensity',
            'torchGutterDisableLight',
            'torchGutterLifeScale',
            'torchReigniteRequiresTouch',
            'torchReigniteTouchExtraUnits',
            'intensityRiseSpeed',
            'intensityFallSpeed',
            'torchLightColor',
            'flickerIntensity',
            'flickerSpeed',
            'wanderPixels',
            'wanderSpeed'
          ]
        },
        {
          name: 'torch-flame',
          label: 'Torch: Flame VFX',
          type: 'folder',
          expanded: false,
          parameters: [
            'torchFlameSizeMin',
            'torchFlameSizeMax',
            'torchFlameRateMin',
            'torchFlameRateMax',
            'torchFlameUpdraft',
            'torchFlameWindInfluence'
          ]
        },
        {
          name: 'torch-sparks',
          label: 'Torch: Sparks VFX',
          type: 'folder',
          expanded: false,
          parameters: [
            'torchSparksEnabled',
            'torchSparksRate',
            'torchSparksSizeMin',
            'torchSparksSizeMax',
            'torchSparksLifeMin',
            'torchSparksLifeMax',
            'torchSparksUpdraft',
            'torchSparksWindInfluence',
            'torchSparksSpeedFactor'
          ]
        },
        {
          name: 'torch-dynamic-light',
          label: 'Torch: Dynamic Light',
          type: 'folder',
          expanded: false,
          parameters: [
            'torchLightEnabled',
            'torchLightDim',
            'torchLightBright',
            'torchLightAlpha',
            'torchLightAttenuation',
            'torchLightLuminosity',
            'torchLightAnimType',
            'torchLightAnimSpeed',
            'torchLightAnimIntensity',
            'torchLightScaleWithIntensity'
          ]
        },
        {
          name: 'flashlight-beam',
          label: 'Flashlight: Beam',
          type: 'folder',
          expanded: false,
          parameters: [
            'flashlightIntensity',
            'flashlightBrokenness',
            'flashlightWobble',
            'flashlightBeamAngleDeg',
            'flashlightBeamLengthUnits',
            'flashlightBeamWidthScale',
            'flashlightBeamNearWidth',
            'flashlightBeamFarWidth',
            'flashlightBeamWidthCurve',
            'flashlightBeamEdgeSoftness',
            'flashlightBeamCoreIntensity',
            'flashlightBeamCoreSharpness',
            'flashlightBeamMidIntensity',
            'flashlightBeamMidSharpness',
            'flashlightBeamRimIntensity',
            'flashlightBeamRimSharpness',
            'flashlightBeamNearBoost',
            'flashlightBeamNearBoostCurve',
            'flashlightBeamLongFalloffExp',
            'flashlightBeamNoiseIntensity',
            'flashlightBeamNoiseScale',
            'flashlightBeamNoiseSpeed'
          ]
        },
        {
          name: 'flashlight-cookie',
          label: 'Flashlight: Cookie',
          type: 'folder',
          expanded: false,
          parameters: [
            'flashlightCookieIntensity',
            'flashlightCookieSizePx',
            'flashlightCookieSizeFromBeam',
            'flashlightCookieMaskRadius',
            'flashlightCookieMaskSoftness',
            'flashlightCookieCoreIntensity',
            'flashlightCookieCoreSharpness',
            'flashlightCookieRimIntensity',
            'flashlightCookieRimRadius',
            'flashlightCookieRimWidth',
            'flashlightCookiePerspectiveEnabled',
            'flashlightCookiePerspectiveNearScale',
            'flashlightCookiePerspectiveFarScale',
            'flashlightCookiePerspectiveCurve',
            'flashlightCookiePerspectiveAnamorphic',
            'flashlightCookieTexture',
            'flashlightCookieRotation',
            'flashlightCookieRotationSpeed'
          ]
        },
        {
          name: 'flashlight-dynamic-light',
          label: 'Flashlight: Dynamic Light',
          type: 'folder',
          expanded: false,
          parameters: [
            'flashlightLightEnabled',
            'flashlightLightColor',
            'flashlightLightDim',
            'flashlightLightBright',
            'flashlightLightAlpha',
            'flashlightLightAttenuation',
            'flashlightLightLuminosity',
            'flashlightLightAnimType',
            'flashlightLightAnimSpeed',
            'flashlightLightAnimIntensity',
            'flashlightLightUseCookiePosition',
            'flashlightLightDistanceScaleEnabled',
            'flashlightLightDistanceScaleNear',
            'flashlightLightDistanceScaleFar'
          ]
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: true },
        mode: { type: 'list', label: 'Mode', options: { Torch: 'torch', Flashlight: 'flashlight' }, default: 'flashlight' },
        torchMaxDistanceUnits: { type: 'slider', label: 'Torch Max Dist (u)', min: 1, max: 200, step: 1, default: 10, throttle: 50 },
        flashlightMaxDistanceUnits: { type: 'slider', label: 'Flashlight Max Dist (u)', min: 1, max: 200, step: 1, default: 60, throttle: 50 },
        fadeOutDistanceUnits: { type: 'slider', label: 'Fade Band (u)', min: 0, max: 100, step: 1, default: 7, throttle: 50 },
        wallBlockEnabled: { type: 'boolean', label: 'Wall Block', default: true },
        springStiffness: { type: 'slider', label: 'Spring Stiffness', min: 1, max: 300, step: 1, default: 55, throttle: 50 },
        springDamping: { type: 'slider', label: 'Spring Damping', min: 0, max: 90, step: 1, default: 16, throttle: 50 },
        torchBaseIntensity: { type: 'slider', label: 'Base Intensity', min: 0, max: 6, step: 0.01, default: 0.66, throttle: 50 },
        emberIntensity: { type: 'slider', label: 'Ember Intensity', min: 0, max: 3, step: 0.01, default: 0.85, throttle: 50 },
        torchGutterDisableLight: { type: 'boolean', label: 'Gutter: Disable Light', default: true },
        torchGutterLifeScale: { type: 'slider', label: 'Gutter: Life Scale', min: 0.05, max: 1.0, step: 0.01, default: 0.3, throttle: 50 },
        torchReigniteRequiresTouch: { type: 'boolean', label: 'Reignite Requires Touch', default: true },
        torchReigniteTouchExtraUnits: { type: 'slider', label: 'Reignite Touch Extra (u)', min: 0, max: 10, step: 0.05, default: 0.25, throttle: 50 },
        intensityRiseSpeed: { type: 'slider', label: 'Rise Speed', min: 0.1, max: 60, step: 0.1, default: 55.5, throttle: 50 },
        intensityFallSpeed: { type: 'slider', label: 'Fall Speed', min: 0.1, max: 80, step: 0.1, default: 2.8, throttle: 50 },
        flickerIntensity: { type: 'slider', label: 'Flicker Amount', min: 0, max: 2.5, step: 0.01, default: 0.33, throttle: 50 },
        flickerSpeed: { type: 'slider', label: 'Flicker Speed', min: 0.1, max: 40, step: 0.1, default: 10.1, throttle: 50 },
        wanderPixels: { type: 'slider', label: 'Wander (px)', min: 0, max: 140, step: 1, default: 28, throttle: 50 },
        wanderSpeed: { type: 'slider', label: 'Wander Speed', min: 0.1, max: 20, step: 0.1, default: 2.3, throttle: 50 },
        flashlightAngleDeg: { type: 'slider', label: 'Legacy Cone Angle (deg)', min: 5, max: 140, step: 1, default: 38, throttle: 50 },
        flashlightLengthUnits: { type: 'slider', label: 'Legacy Cone Length (u)', min: 1, max: 160, step: 1, default: 18, throttle: 50 },
        flashlightIntensity: { type: 'slider', label: 'Intensity', min: 0, max: 6, step: 0.01, default: 5.4, throttle: 50 },
        flashlightBrokenness: { type: 'slider', label: 'Brokenness', min: 0, max: 1, step: 0.01, default: 0.0, throttle: 50 },
        flashlightWobble: { type: 'slider', label: 'Wobble', min: 0, max: 1, step: 0.01, default: 0.0, throttle: 50 },

        flashlightBeamAngleDeg: { type: 'slider', label: 'Angle (deg)', min: 1, max: 160, step: 1, default: 38, throttle: 50 },
        flashlightBeamLengthUnits: { type: 'slider', label: 'Length (u)', min: 0.5, max: 240, step: 0.5, default: 18, throttle: 50 },
        flashlightBeamWidthScale: { type: 'slider', label: 'Width Scale', min: 0.05, max: 3.0, step: 0.01, default: 1.36, throttle: 50 },
        flashlightBeamNearWidth: { type: 'slider', label: 'Near Width', min: 0.01, max: 1.5, step: 0.01, default: 0.01, throttle: 50 },
        flashlightBeamFarWidth: { type: 'slider', label: 'Far Width', min: 0.05, max: 3.0, step: 0.01, default: 1.0, throttle: 50 },
        flashlightBeamWidthCurve: { type: 'slider', label: 'Width Curve', min: 0.25, max: 4.0, step: 0.01, default: 1.25, throttle: 50 },
        flashlightBeamEdgeSoftness: { type: 'slider', label: 'Edge Softness', min: 0.01, max: 0.8, step: 0.01, default: 0.18, throttle: 50 },

        flashlightBeamCoreIntensity: { type: 'slider', label: 'Core Intensity', min: 0.0, max: 4.0, step: 0.01, default: 1.25, throttle: 50 },
        flashlightBeamCoreSharpness: { type: 'slider', label: 'Core Sharpness', min: 0.1, max: 40.0, step: 0.1, default: 10.0, throttle: 50 },
        flashlightBeamMidIntensity: { type: 'slider', label: 'Mid Intensity', min: 0.0, max: 2.0, step: 0.01, default: 0.25, throttle: 50 },
        flashlightBeamMidSharpness: { type: 'slider', label: 'Mid Sharpness', min: 0.1, max: 20.0, step: 0.1, default: 2.2, throttle: 50 },
        flashlightBeamRimIntensity: { type: 'slider', label: 'Rim Intensity', min: 0.0, max: 4.0, step: 0.01, default: 0.6, throttle: 50 },
        flashlightBeamRimSharpness: { type: 'slider', label: 'Rim Sharpness', min: 0.1, max: 60.0, step: 0.1, default: 14.0, throttle: 50 },
        flashlightBeamNearBoost: { type: 'slider', label: 'Near Boost', min: 0.0, max: 6.0, step: 0.01, default: 1.6, throttle: 50 },
        flashlightBeamNearBoostCurve: { type: 'slider', label: 'Near Boost Curve', min: 0.1, max: 6.0, step: 0.01, default: 1.6, throttle: 50 },
        flashlightBeamLongFalloffExp: { type: 'slider', label: 'Long Falloff', min: 0.1, max: 6.0, step: 0.01, default: 1.7, throttle: 50 },
        flashlightBeamNoiseIntensity: { type: 'slider', label: 'Noise Amount', min: 0.0, max: 0.6, step: 0.01, default: 0.06, throttle: 50 },
        flashlightBeamNoiseScale: { type: 'slider', label: 'Noise Scale', min: 0.1, max: 30.0, step: 0.1, default: 7.0, throttle: 50 },
        flashlightBeamNoiseSpeed: { type: 'slider', label: 'Noise Speed', min: 0.0, max: 10.0, step: 0.01, default: 1.2, throttle: 50 },
        flashlightCookieTexture: { type: 'list', label: 'Cookie', options: { 'Light 1': 'light_01', 'Light 2': 'light_02', 'Light 3': 'light_03' }, default: 'light_01' },
        flashlightCookieRotation: { type: 'boolean', label: 'Rotate Cookie', default: false },
        flashlightCookieRotationSpeed: { type: 'slider', label: 'Rotation Speed', min: 0.0, max: 4, step: 0.05, default: 0.3, throttle: 50 },

        flashlightCookieIntensity: { type: 'slider', label: 'Intensity Mult', min: 0.0, max: 6.0, step: 0.01, default: 1.68, throttle: 50 },
        flashlightCookieSizePx: { type: 'slider', label: 'Size (px)', min: 1, max: 600, step: 1, default: 338, throttle: 50 },
        flashlightCookieSizeFromBeam: { type: 'slider', label: 'Size From Beam', min: 0.0, max: 3.0, step: 0.01, default: 0.48, throttle: 50 },
        flashlightCookieMaskRadius: { type: 'slider', label: 'Mask Radius', min: 0.1, max: 1.0, step: 0.01, default: 0.92, throttle: 50 },
        flashlightCookieMaskSoftness: { type: 'slider', label: 'Mask Softness', min: 0.0, max: 0.8, step: 0.01, default: 0.10, throttle: 50 },
        flashlightCookieCoreIntensity: { type: 'slider', label: 'Core Intensity', min: 0.0, max: 6.0, step: 0.01, default: 1.25, throttle: 50 },
        flashlightCookieCoreSharpness: { type: 'slider', label: 'Core Sharpness', min: 0.1, max: 40.0, step: 0.1, default: 8.0, throttle: 50 },
        flashlightCookieRimIntensity: { type: 'slider', label: 'Rim Intensity', min: 0.0, max: 6.0, step: 0.01, default: 0.55, throttle: 50 },
        flashlightCookieRimRadius: { type: 'slider', label: 'Rim Radius', min: 0.0, max: 1.0, step: 0.01, default: 0.78, throttle: 50 },
        flashlightCookieRimWidth: { type: 'slider', label: 'Rim Width', min: 0.01, max: 1.0, step: 0.01, default: 0.22, throttle: 50 },

        flashlightCookiePerspectiveEnabled: { type: 'boolean', label: 'Perspective', default: true },
        flashlightCookiePerspectiveNearScale: { type: 'slider', label: 'Perspective Near', min: 0.1, max: 2.0, step: 0.01, default: 0.3, throttle: 50 },
        flashlightCookiePerspectiveFarScale: { type: 'slider', label: 'Perspective Far', min: 0.1, max: 4.0, step: 0.01, default: 4.0, throttle: 50 },
        flashlightCookiePerspectiveCurve: { type: 'slider', label: 'Perspective Curve', min: 0.1, max: 4.0, step: 0.01, default: 2.34, throttle: 50 },
        flashlightCookiePerspectiveAnamorphic: { type: 'slider', label: 'Perspective Stretch', min: 0.1, max: 6.0, step: 0.01, default: 1.49, throttle: 50 },

        torchLightEnabled: { type: 'boolean', label: 'Enabled', default: true },
        torchLightColor: { type: 'color', label: 'Color', default: { r: 1.0, g: 0.42, b: 0.12 } },
        torchLightDim: { type: 'slider', label: 'Dim Radius (u)', min: 0, max: 160, step: 0.5, default: 19.5, throttle: 50 },
        torchLightBright: { type: 'slider', label: 'Bright Radius (u)', min: 0, max: 120, step: 0.5, default: 3, throttle: 50 },
        torchLightAlpha: { type: 'slider', label: 'Alpha', min: 0, max: 2, step: 0.01, default: 0.87, throttle: 50 },
        torchLightAttenuation: { type: 'slider', label: 'Attenuation', min: 0, max: 1, step: 0.01, default: 0.55, throttle: 50 },
        torchLightLuminosity: { type: 'slider', label: 'Luminosity', min: 0, max: 3, step: 0.01, default: 2.2, throttle: 50 },
        torchLightAnimType: {
          type: 'list',
          label: 'Animation',
          options: { None: 'none', Torch: 'torch', Flame: 'flame', Pulse: 'pulse' },
          default: 'none'
        },
        torchLightAnimSpeed: { type: 'slider', label: 'Anim Speed', min: 0.0, max: 40, step: 0.1, default: 2.7, throttle: 50 },
        torchLightAnimIntensity: { type: 'slider', label: 'Anim Intensity', min: 0, max: 25, step: 0.1, default: 1.7, throttle: 50 },
        torchLightScaleWithIntensity: { type: 'boolean', label: 'Scale With Torch', default: false },

        torchFlameSizeMin: { type: 'slider', label: 'Size Min (px)', min: 1, max: 120, step: 1, default: 32, throttle: 50 },
        torchFlameSizeMax: { type: 'slider', label: 'Size Max (px)', min: 1, max: 180, step: 1, default: 65, throttle: 50 },
        torchFlameRateMin: { type: 'slider', label: 'Rate Min', min: 0, max: 600, step: 1, default: 90, throttle: 50 },
        torchFlameRateMax: { type: 'slider', label: 'Rate Max', min: 0, max: 1000, step: 1, default: 170, throttle: 50 },
        torchFlameUpdraft: { type: 'slider', label: 'Updraft', min: 0, max: 40, step: 0.1, default: 6.0, throttle: 50 },
        torchFlameWindInfluence: { type: 'slider', label: 'Wind Influence', min: 0, max: 2.0, step: 0.01, default: 0.25, throttle: 50 },

        torchSparksEnabled: { type: 'boolean', label: 'Enabled', default: true },
        torchSparksRate: { type: 'slider', label: 'Rate', min: 0, max: 400, step: 1, default: 28, throttle: 50 },
        torchSparksSizeMin: { type: 'slider', label: 'Size Min (px)', min: 1, max: 60, step: 1, default: 3, throttle: 50 },
        torchSparksSizeMax: { type: 'slider', label: 'Size Max (px)', min: 1, max: 120, step: 1, default: 10, throttle: 50 },
        torchSparksLifeMin: { type: 'slider', label: 'Life Min (s)', min: 0.05, max: 3.0, step: 0.01, default: 0.25, throttle: 50 },
        torchSparksLifeMax: { type: 'slider', label: 'Life Max (s)', min: 0.05, max: 4.0, step: 0.01, default: 0.7, throttle: 50 },
        torchSparksUpdraft: { type: 'slider', label: 'Updraft', min: 0, max: 120, step: 0.1, default: 24.0, throttle: 50 },
        torchSparksWindInfluence: { type: 'slider', label: 'Wind Influence', min: 0, max: 3.0, step: 0.01, default: 0.45, throttle: 50 },
        torchSparksSpeedFactor: { type: 'slider', label: 'Streak Factor', min: 0, max: 0.15, step: 0.001, default: 0.03, throttle: 50 },

        flashlightLightEnabled: { type: 'boolean', label: 'Enabled', default: true },
        flashlightLightColor: { type: 'color', label: 'Color', default: { r: 3.0, g: 3.0, b: 3.0 } },
        flashlightLightDim: { type: 'slider', label: 'Dim Radius (u)', min: 0, max: 240, step: 0.5, default: 30.5, throttle: 50 },
        flashlightLightBright: { type: 'slider', label: 'Bright Radius (u)', min: 0, max: 200, step: 0.5, default: 5, throttle: 50 },
        flashlightLightAlpha: { type: 'slider', label: 'Alpha', min: 0, max: 2, step: 0.01, default: 0.26, throttle: 50 },
        flashlightLightAttenuation: { type: 'slider', label: 'Attenuation', min: 0, max: 1, step: 0.01, default: 1, throttle: 50 },
        flashlightLightLuminosity: { type: 'slider', label: 'Luminosity', min: 0, max: 3, step: 0.01, default: 3, throttle: 50 },
        flashlightLightAnimType: {
          type: 'list',
          label: 'Animation',
          options: { None: 'none', Flame: 'flame', Pulse: 'pulse', Torch: 'torch' },
          default: 'none'
        },
        flashlightLightAnimSpeed: { type: 'slider', label: 'Anim Speed', min: 0.0, max: 40, step: 0.1, default: 5, throttle: 50 },
        flashlightLightAnimIntensity: { type: 'slider', label: 'Anim Intensity', min: 0, max: 25, step: 0.1, default: 18.7, throttle: 50 },
        flashlightLightUseCookiePosition: { type: 'boolean', label: 'Use Cookie Pos', default: true },
        flashlightLightDistanceScaleEnabled: { type: 'boolean', label: 'Distance Scaling', default: true },
        flashlightLightDistanceScaleNear: { type: 'slider', label: 'Near Scale', min: 0.1, max: 3, step: 0.01, default: 0.28, throttle: 50 },
        flashlightLightDistanceScaleFar: { type: 'slider', label: 'Far Scale', min: 0.1, max: 3, step: 0.01, default: 3, throttle: 50 },
        debugReadoutEnabled: { type: 'boolean', label: 'Debug Readout', default: false }
      }
    };
  }

  initialize(renderer, scene, camera) {
    const THREE = window.THREE;
    if (!THREE) return;

    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    this._tempA = new THREE.Vector3();
    this._tempB = new THREE.Vector3();
    this._tempC = new THREE.Vector3();

    this._tempScreenSize = new THREE.Vector2();

    this._flashlightCookieWorld = new THREE.Vector3();
    this._flashlightAimWorld = new THREE.Vector3();

    this._visionMaskTexelSize = new THREE.Vector2(1, 1);

    this._torchPos = new THREE.Vector3();
    this._torchVel = new THREE.Vector3();

    this._group = new THREE.Group();
    this._group.name = 'PlayerLight';
    this._group.renderOrder = 200;

    this._initCookieTextures();

    this._createTorchParticleSystem();
    this._createTorchSparksSystem();
    this._createFlashlightMesh();
    this._createDebugOverlay();

    this.scene.add(this._group);

    this._tryAttachFlashlightToLightScene();

    this._updateVisionMaskRefs();

    window.addEventListener('pointermove', this._onPointerMove, { passive: true });

    try {
      const id = Hooks.on('controlToken', (token, controlled) => {
        if (!controlled) return;
        const tokenId = token?.document?.id;
        if (!tokenId) return;
        this._lastControlledTokenId = tokenId;
      });
      this._hookIds.push(['controlToken', id]);
    } catch (_) {
    }

    log.info('PlayerLightEffect initialized');
  }

  _getFogEffect() {
    try {
      const sceneComposer = window.MapShine?.sceneComposer;
      const effectComposer = sceneComposer?.effectComposer || window.MapShine?.effectComposer;
      return effectComposer?.effects?.get?.('fog') || null;
    } catch (_) {
      return null;
    }
  }

  _updateVisionMaskRefs() {
    try {
      const fog = this._getFogEffect();
      const rt = fog?.visionRenderTarget;
      const tex = rt?.texture;
      if (tex) {
        this._visionMaskTexture = tex;
        const w = rt.width || 1;
        const h = rt.height || 1;
        if (this._visionMaskTexelSize) this._visionMaskTexelSize.set(1 / w, 1 / h);
        this._visionMaskHas = 1.0;
        return;
      }
    } catch (_) {
    }

    this._visionMaskTexture = null;
    this._visionMaskHas = 0.0;
    if (this._visionMaskTexelSize) this._visionMaskTexelSize.set(1, 1);
  }

  _tryAttachFlashlightToLightScene() {
    if (this._flashlightBeamInLightScene) return;
    const lighting = this._getLightingEffect();
    const lightScene = lighting?.lightScene;
    if (!lighting || !lightScene) return;

    try {
      if (this._flashlightBeamMesh) {
        this._flashlightBeamMesh.parent?.remove?.(this._flashlightBeamMesh);
        lightScene.add(this._flashlightBeamMesh);
      }
      if (this._flashlightCookieMesh) {
        this._flashlightCookieMesh.parent?.remove?.(this._flashlightCookieMesh);
        lightScene.add(this._flashlightCookieMesh);
      }
      this._flashlightBeamInLightScene = true;
    } catch (_) {
    }
  }

  _initCookieTextures() {
    const THREE = window.THREE;
    if (!THREE) return;

    if (!this._defaultCookieTexture) {
      const data = new Uint8Array([255, 255, 255, 255]);
      const tex = new THREE.DataTexture(data, 1, 1);
      tex.needsUpdate = true;
      tex.flipY = false;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      this._defaultCookieTexture = tex;
    }

    for (const name of this._cookieTextureNames) {
      if (!this._cookieTextureStatus[name]) this._cookieTextureStatus[name] = 'idle';
    }
  }

  _updateTorchSparks(timeInfo, groundZ, torchFinalIntensity, distanceFade) {
    const sys = this._torchSparksSystem;
    if (!sys || !sys.emitter || !this._torchPos) return;

    const enabled = !!this.params.torchSparksEnabled && this.params.mode === 'torch' && this.enabled;
    sys.emitter.visible = enabled;
    if (!enabled) return;

    sys.emitter.position.set(this._torchPos.x, this._torchPos.y, groundZ + 0.125);

    try {
      const rate = Math.max(0, this.params.torchSparksRate);
      if (sys.emissionOverTime && typeof sys.emissionOverTime.value === 'number') {
        sys.emissionOverTime.value = rate;
      }

      const baseLifeMin = Math.max(0.01, this.params.torchSparksLifeMin);
      const baseLifeMax = Math.max(baseLifeMin, this.params.torchSparksLifeMax);
      const lifeScale = this._torchGuttering ? Math.max(0.01, Math.min(1.0, (this.params.torchGutterLifeScale ?? 0.3))) : 1.0;
      const lifeMin = Math.max(0.01, baseLifeMin * lifeScale);
      const lifeMax = Math.max(lifeMin, baseLifeMax * lifeScale);
      if (sys.startLife && sys.startLife.a !== undefined) {
        sys.startLife.a = lifeMin;
        sys.startLife.b = lifeMax;
      }

      const sizeMin = Math.max(1, this.params.torchSparksSizeMin);
      const sizeMax = Math.max(sizeMin, this.params.torchSparksSizeMax);
      if (sys.startSize && sys.startSize.a !== undefined) {
        sys.startSize.a = sizeMin;
        sys.startSize.b = sizeMax;
      }

      sys.speedFactor = this.params.torchSparksSpeedFactor;

      if (sys.userData) {
        sys.userData.windInfluence = this.params.torchSparksWindInfluence;
        const up = sys.userData._msTorchUpdraft;
        if (up?.magnitude && typeof up.magnitude.value === 'number') {
          up.magnitude.value = this.params.torchSparksUpdraft;
        }
      }
    } catch (_) {
    }
  }

  _getCookieUrlCandidates(name) {
    const base = 'modules/map-shine-advanced/assets/';
    return [
      `${base}kenney%20assets/${name}.png`,
      `${base}kenney assets/${name}.png`,
      `${base}kenney_assets/${name}.png`,
      `${base}kenney-assets/${name}.png`
    ];
  }

  _requestCookieTexture(name) {
    const THREE = window.THREE;
    if (!THREE) return;
    if (!name) return;

    const status = this._cookieTextureStatus[name];
    if (status === 'loading' || status === 'loaded' || status === 'failed') return;
    this._cookieTextureStatus[name] = 'loading';

    const loader = new THREE.TextureLoader();
    const candidates = this._getCookieUrlCandidates(name);

    const tryIndex = (idx) => {
      if (idx >= candidates.length) {
        this._cookieTextureStatus[name] = 'failed';
        this._cookieTextures[name] = this._defaultCookieTexture;
        log.warn(`PlayerLightEffect: Failed to load cookie texture ${name}; using fallback.`);
        return;
      }

      const url = candidates[idx];
      loader.load(
        url,
        (tex) => {
          try {
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
            tex.generateMipmaps = true;
            tex.minFilter = THREE.LinearMipmapLinearFilter;
            tex.magFilter = THREE.LinearFilter;
            tex.flipY = false;
          } catch (_) {
          }
          this._cookieTextures[name] = tex;
          this._cookieTextureStatus[name] = 'loaded';
        },
        undefined,
        () => {
          tryIndex(idx + 1);
        }
      );
    };

    tryIndex(0);
  }

  applyParamChange(paramId, value) {
    if (!this.params) return;

    if (paramId === 'enabled') {
      this.enabled = !!value;
      this.params.enabled = !!value;
      return;
    }

    if (Object.prototype.hasOwnProperty.call(this.params, paramId)) {
      this.params[paramId] = value;
    }
  }

  update(timeInfo) {
    const torchWasActiveLastFrame = this._torchWasActiveLastFrame;
    const torchPrevTokenId = this._torchPrevTokenId;
    this._torchWasActiveLastFrame = false;

    if (window.MapShine?.isMapMakerMode) {
      this._setVisible(false);
      this._hideDynamicLightSources();
      return;
    }

    if (!this.enabled) {
      this._setVisible(false);
      this._hideDynamicLightSources();
      return;
    }

    const THREE = window.THREE;
    if (!THREE) return;

    try {
      const renderer = this.renderer;
      if (renderer && this._tempScreenSize) {
        renderer.getDrawingBufferSize(this._tempScreenSize);
        const invW = 1.0 / Math.max(1.0, this._tempScreenSize.x);
        const invH = 1.0 / Math.max(1.0, this._tempScreenSize.y);
        const mm = window.MapShine?.maskManager;
        let ropeMaskTex = mm ? mm.getTexture('ropeMask.screen') : null;
        if (!ropeMaskTex) {
          const le = window.MapShine?.lightingEffect;
          ropeMaskTex = le?.ropeMaskTarget?.texture ?? null;
        }

        const mats = [this._flashlightBeamMat, this._flashlightMat, this._flashlightCookieMat, this._flashlightOriginMat];
        for (let i = 0; i < mats.length; i++) {
          const u = mats[i]?.uniforms;
          if (!u) continue;
          if (u.uInvScreenSize) u.uInvScreenSize.value.set(invW, invH);
          if (u.uRopeMask) u.uRopeMask.value = ropeMaskTex;
          if (u.uHasRopeMask) u.uHasRopeMask.value = ropeMaskTex ? 1.0 : 0.0;
        }

        const torchMats = [this._torchFlameMat, this._torchSparksMat];
        for (let i = 0; i < torchMats.length; i++) {
          const m = torchMats[i];
          const u = m?.uniforms || m?.userData?._msRopeMaskUniforms;
          if (!u) continue;
          if (u.uInvScreenSize) u.uInvScreenSize.value.set(invW, invH);
          if (u.uRopeMask) u.uRopeMask.value = ropeMaskTex;
          if (u.uHasRopeMask) u.uHasRopeMask.value = ropeMaskTex ? 1.0 : 0.0;
        }
      }
    } catch (_) {
    }

    const tokenId = this._getActiveTokenId();
    if (!tokenId) {
      this._setVisible(false);
      this._hideDynamicLightSources();
      return;
    }

    this._torchPrevTokenId = tokenId;
    const tokenIdChanged = torchPrevTokenId !== tokenId;

    const tokenSprite = window.MapShine?.tokenManager?.getTokenSprite?.(tokenId) ?? null;
    const tokenDoc = tokenSprite?.userData?.tokenDoc ?? null;
    const tokenObj = canvas?.tokens?.get?.(tokenId) ?? null;

    if (!tokenSprite || !tokenDoc || !tokenObj) {
      this._setVisible(false);
      this._hideDynamicLightSources();
      return;
    }

    try {
      const tokenMode = tokenDoc.getFlag?.('map-shine-advanced', 'playerLightMode')
        ?? tokenDoc?.flags?.['map-shine-advanced']?.playerLightMode;
      if (tokenMode === 'torch' || tokenMode === 'flashlight') {
        this.params.mode = tokenMode;
      }
    } catch (_) {
    }

    try {
      const enabledFlag = tokenDoc.getFlag?.('map-shine-advanced', 'playerLightEnabled')
        ?? tokenDoc?.flags?.['map-shine-advanced']?.playerLightEnabled;
      const enabled = (enabledFlag === undefined || enabledFlag === null) ? true : !!enabledFlag;
      if (!enabled) {
        this._setVisible(false);
        this._hideDynamicLightSources();
        return;
      }
    } catch (_) {
    }

    if (!this._isAllowedForUser(tokenDoc)) {
      this._setVisible(false);
      this._hideDynamicLightSources();
      return;
    }

    if (this._pointerClientX === null || this._pointerClientY === null) {
      this._setVisible(false);
      this._hideDynamicLightSources();
      return;
    }

    const sceneComposer = window.MapShine?.sceneComposer;
    const groundZ = (sceneComposer && typeof sceneComposer.groundZ === 'number') ? sceneComposer.groundZ : 0;

    const im = window.MapShine?.interactionManager;
    const cursorWorld = (im && typeof im.viewportToWorld === 'function')
      ? im.viewportToWorld(this._pointerClientX, this._pointerClientY, groundZ)
      : null;

    if (!cursorWorld) {
      this._setVisible(false);
      this._hideDynamicLightSources();
      return;
    }

    const tokenCenterWorld = tokenSprite.position;

    const aimWorld = (this.params.mode === 'flashlight')
      ? this._getFlashlightAimWorld(timeInfo, tokenCenterWorld, cursorWorld, groundZ)
      : cursorWorld;

    const dx = aimWorld.x - tokenCenterWorld.x;
    const dy = aimWorld.y - tokenCenterWorld.y;
    const distancePx = Math.hypot(dx, dy);
    const pxToUnits = this._pxToUnits();
    const distanceUnits = distancePx * pxToUnits;

    const rangeMul = this.params.mode === 'torch' ? 3.0 : 4.0;
    const baseMaxU = this.params.mode === 'torch' ? this.params.torchMaxDistanceUnits : this.params.flashlightMaxDistanceUnits;

    // Distance fade + kill.
    // - Within maxDistanceUnits: full intensity.
    // - Beyond: fade out over fadeOutDistanceUnits.
    // - Past max+fadeBand: hide entirely.
    const maxU = Math.max(0.001, baseMaxU) * rangeMul;
    const fadeBandU = Math.max(0, this.params.fadeOutDistanceUnits ?? 0) * rangeMul;
    const killU = maxU + fadeBandU;
    let fade = 1.0;
    if (fadeBandU > 0 && distanceUnits > maxU) {
      fade = 1.0 - ((distanceUnits - maxU) / fadeBandU);
    } else if (fadeBandU === 0 && distanceUnits > maxU) {
      fade = 0.0;
    }
    fade = Math.max(0, Math.min(1, fade));
    this._distanceFade = fade;

    const isTorchMode = this.params.mode === 'torch';

    const torchExtinguishedBefore = this._torchExtinguished;

    if (!isTorchMode || !this.params.torchReigniteRequiresTouch) {
      this._torchExtinguished = false;
    }

    if (isTorchMode && this.params.torchReigniteRequiresTouch) {
      try {
        const gridSize = canvas?.dimensions?.size ?? 100;
        const scaleX = tokenDoc?.texture?.scaleX ?? 1;
        const scaleY = tokenDoc?.texture?.scaleY ?? 1;
        const wPx = (tokenDoc?.width ?? 1) * gridSize * scaleX;
        const hPx = (tokenDoc?.height ?? 1) * gridSize * scaleY;
        const tokenRadiusPx = 0.5 * Math.max(0, Math.min(wPx, hPx));
        const tokenRadiusU = tokenRadiusPx * pxToUnits;
        const extraU = Math.max(0, this.params.torchReigniteTouchExtraUnits ?? 0);
        const touching = distanceUnits <= (tokenRadiusU + extraU);

        if (fade <= 0.0001) {
          this._torchExtinguished = true;
        }

        if (this._torchExtinguished && !touching) {
          this._setVisible(false);
          this._hideDynamicLightSources();
          return;
        }

        if (this._torchExtinguished && touching) {
          this._torchExtinguished = false;
        }
      } catch (_) {
      }
    }

    if (fade <= 0.0001) {
      this._setVisible(false);
      this._hideDynamicLightSources();
      return;
    }

    let blocked = false;
    let wallDistanceUnits = distanceUnits;
    let collisionWorld = null;

    // When blocked, we clamp the target to a safe point on the token-side of the wall.
    let clampedTargetWorld = aimWorld;
    let safeWallDistanceUnits = wallDistanceUnits;

    if (this.params.wallBlockEnabled) {
      try {
        const destFoundry = Coordinates.toFoundry(aimWorld.x, aimWorld.y);
        let collision = null;
        const isFlashlightMode = this.params.mode === 'flashlight';

        if (isFlashlightMode) {
          const origin = tokenObj?.center ?? { x: tokenDoc?.x ?? 0, y: tokenDoc?.y ?? 0 };
          const ox = origin.x;
          const oy = origin.y;
          const dx = destFoundry.x - ox;
          const dy = destFoundry.y - oy;
          const denomEps = 1e-8;
          const rayLenSq = dx * dx + dy * dy;

          if (rayLenSq > denomEps) {
            const walls = canvas?.walls?.placeables;
            let bestT = Infinity;
            let bestX = 0;
            let bestY = 0;

            if (walls && walls.length) {
              for (let i = 0; i < walls.length; i++) {
                const w = walls[i];
                const doc = w?.document;
                if (!doc) continue;

                if (doc.door > 0 && doc.ds === 1) continue;

                const blocksLight = doc.light !== 0;
                const blocksSight = doc.sight !== 0;
                if (!blocksLight && !blocksSight) continue;

                const c = doc.c;
                if (!c || c.length < 4) continue;
                const ax = c[0];
                const ay = c[1];
                const bx = c[2];
                const by = c[3];

                // Check proximity thresholds for light/sight
                let shouldBlock = true;
                if (blocksLight && typeof doc.light === 'number' && doc.light > 0) {
                  // Proximity light restriction - check distance to closest point on wall
                  const closestX = Math.max(ax, Math.min(bx, ox));
                  const closestY = Math.max(ay, Math.min(by, oy));
                  const distToWall = Math.hypot(ox - closestX, oy - closestY) * pxToUnits;
                  if (distToWall <= doc.light) {
                    shouldBlock = false;
                  }
                }
                if (shouldBlock && blocksSight && typeof doc.sight === 'number' && doc.sight > 0) {
                  // Proximity sight restriction - check distance to closest point on wall
                  const closestX = Math.max(ax, Math.min(bx, ox));
                  const closestY = Math.max(ay, Math.min(by, oy));
                  const distToWall = Math.hypot(ox - closestX, oy - closestY) * pxToUnits;
                  if (distToWall <= doc.sight) {
                    shouldBlock = false;
                  }
                }
                if (!shouldBlock) continue;

                const sx = bx - ax;
                const sy = by - ay;
                const rxs = dx * sy - dy * sx;
                if (Math.abs(rxs) < denomEps) continue;

                const qpx = ax - ox;
                const qpy = ay - oy;
                const t = (qpx * sy - qpy * sx) / rxs;
                const u = (qpx * dy - qpy * dx) / rxs;

                if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
                  if (t < bestT) {
                    bestT = t;
                    bestX = ox + t * dx;
                    bestY = oy + t * dy;
                  }
                }
              }
            }

            if (bestT !== Infinity) {
              collision = { x: bestX, y: bestY };
            }
          }
        } else {
          // Torch placement behaves like moving a physical object.
          collision = tokenObj.checkCollision(destFoundry, { mode: 'closest', type: 'move' });
        }
        if (collision) {
          blocked = true;
          const cv = Coordinates.toWorld(collision.x, collision.y);
          collisionWorld = this._tempC;
          collisionWorld.set(cv.x, cv.y, groundZ);
          wallDistanceUnits = Math.hypot(collisionWorld.x - tokenCenterWorld.x, collisionWorld.y - tokenCenterWorld.y) * pxToUnits;

          // Nudge the clamped target slightly back toward the token so we never sit exactly on the wall.
          const marginPx = 12;
          this._tempB.subVectors(tokenCenterWorld, collisionWorld);
          const len = Math.hypot(this._tempB.x, this._tempB.y);
          if (len > 0.0001) {
            this._tempB.multiplyScalar(1 / len);
            clampedTargetWorld = this._tempA;
            clampedTargetWorld.set(
              collisionWorld.x + this._tempB.x * marginPx,
              collisionWorld.y + this._tempB.y * marginPx,
              groundZ
            );
            safeWallDistanceUnits = Math.max(0, wallDistanceUnits - (marginPx * pxToUnits));
          } else {
            clampedTargetWorld = collisionWorld;
            safeWallDistanceUnits = wallDistanceUnits;
          }
        }
      } catch (_) {
      }
    }

    this._torchGuttering = isTorchMode && distanceUnits > maxU;

    // Update debug overlay with current state
    const state = fade <= 0.0001 ? 'HIDDEN' : (blocked || distanceUnits > maxU ? 'EMBER' : 'ACTIVE');
    this._updateDebugOverlay(state, distanceUnits, blocked, fade);

    if (!this._torchParticlesRegistered) {
      const batch = window.MapShineParticles?.batchRenderer;
      if (batch && typeof batch.addSystem === 'function' && (this._torchParticleSystem || this._torchSparksSystem)) {
        try {
          const add = (system) => {
            if (!system) return;
            if (system.emitter?.parent === this._group) {
              this._group.remove(system.emitter);
            }
            if (this.scene && system.emitter && !system.emitter.parent) {
              this.scene.add(system.emitter);
            }
            if (system.emitter) {
              const ud = system.emitter.userData || (system.emitter.userData = {});
              ud.msAutoCull = false;
            }
            batch.addSystem(system);
          };

          add(this._torchParticleSystem);
          add(this._torchSparksSystem);
          this._torchParticlesRegistered = true;
        } catch (_) {
        }
      }
    }

    if (this.params.mode === 'flashlight') {
      const flashlightMaxU = maxU;
      const flashlightConeMaxLenU = Math.max(0.5, this.params.flashlightLengthUnits) * 4.0;
      this._updateFlashlight(timeInfo, tokenCenterWorld, aimWorld, blocked, safeWallDistanceUnits, groundZ, fade, tokenDoc, flashlightMaxU, flashlightConeMaxLenU);
      this._updateDynamicLightSources(timeInfo, tokenCenterWorld, aimWorld, blocked, safeWallDistanceUnits, groundZ, fade, tokenDoc);
      this._setVisible(true, false);
      return;
    }

    const torchReignited = torchExtinguishedBefore && !this._torchExtinguished;
    const snapTorchNow = tokenIdChanged || !torchWasActiveLastFrame || torchReignited;
    this._updateTorch(timeInfo, tokenCenterWorld, clampedTargetWorld, blocked, distanceUnits, groundZ, fade, maxU, snapTorchNow);
    this._updateDynamicLightSources(timeInfo, tokenCenterWorld, clampedTargetWorld, blocked, safeWallDistanceUnits, groundZ, fade, tokenDoc);
    this._setVisible(true, true);

    this._torchWasActiveLastFrame = true;
  }

  render(renderer, scene, camera) {
  }

  dispose() {
    // If we've reparented meshes into LightingEffect.lightScene, remove them there first.
    try {
      const lighting = this._getLightingEffect();
      const lightScene = lighting?.lightScene;
      if (lightScene) {
        if (this._flashlightBeamMesh) lightScene.remove(this._flashlightBeamMesh);
        if (this._flashlightCookieMesh) lightScene.remove(this._flashlightCookieMesh);
      }
    } catch (_) {
    }

    try {
      window.removeEventListener('pointermove', this._onPointerMove);
    } catch (_) {
    }

    try {
      for (const [hookName, hookId] of this._hookIds) {
        try {
          Hooks.off(hookName, hookId);
        } catch (_) {
        }
      }
    } catch (_) {
    }

    this._hookIds.length = 0;

    if (this._group && this._group.parent) {
      this._group.parent.remove(this._group);
    }

    if (this._torchSprite) {
      this._torchSprite.material?.map?.dispose?.();
      this._torchSprite.material?.dispose?.();
      this._torchSprite = null;
    }

    if (this._torchParticleSystem) {
      if (this._torchParticleSystem.emitter) {
        try {
          this._torchParticleSystem.emitter.parent?.remove?.(this._torchParticleSystem.emitter);
        } catch (_) {
        }
      }
      try {
        const batch = window.MapShineParticles?.batchRenderer;
        if (batch && typeof batch.deleteSystem === 'function') {
          batch.deleteSystem(this._torchParticleSystem);
        }
      } catch (_) {
      }
      this._torchParticleSystem.dispose?.();
      this._torchParticleSystem = null;
    }

    if (this._torchSparksSystem) {
      if (this._torchSparksSystem.emitter) {
        try {
          this._torchSparksSystem.emitter.parent?.remove?.(this._torchSparksSystem.emitter);
        } catch (_) {
        }
      }
      try {
        const batch = window.MapShineParticles?.batchRenderer;
        if (batch && typeof batch.deleteSystem === 'function') {
          batch.deleteSystem(this._torchSparksSystem);
        }
      } catch (_) {
      }
      this._torchSparksSystem.dispose?.();
      this._torchSparksSystem = null;
    }

    if (this._torchSparksTexture) {
      this._torchSparksTexture.dispose?.();
      this._torchSparksTexture = null;
    }

    if (this._flashlightMesh) {
      this._flashlightMesh.geometry?.dispose?.();
      this._flashlightMesh.material?.dispose?.();
      this._flashlightMesh = null;
    }

    if (this._flashlightBeamMesh) {
      this._flashlightBeamMesh.geometry?.dispose?.();
      this._flashlightBeamMesh.material?.dispose?.();
      this._flashlightBeamMesh = null;
    }

    if (this._flashlightCookieMesh) {
      this._flashlightCookieMesh.geometry?.dispose?.();
      this._flashlightCookieMesh.material?.dispose?.();
      this._flashlightCookieMesh = null;
    }

    if (this._flashlightOriginMesh) {
      this._flashlightOriginMesh.geometry?.dispose?.();
      this._flashlightOriginMesh.material?.dispose?.();
      this._flashlightOriginMesh = null;
    }

    if (this._flashlightOriginTexture) {
      this._flashlightOriginTexture.dispose?.();
      this._flashlightOriginTexture = null;
    }

    // Dispose cookie textures
    for (const name in this._cookieTextures) {
      this._cookieTextures[name]?.dispose?.();
    }
    this._cookieTextures = {};

    if (this._defaultCookieTexture) {
      this._defaultCookieTexture.dispose?.();
      this._defaultCookieTexture = null;
    }

    if (this._debugOverlay) {
      document.body.removeChild(this._debugOverlay);
      this._debugOverlay = null;
    }

    this._removeDynamicLightSources();

    this._flashlightMat = null;
    this._flashlightBeamMat = null;
    this._flashlightCookieMat = null;
    this._group = null;
    this.scene = null;
    this.renderer = null;
    this.camera = null;

    super.dispose();
  }

  _handlePointerMove(ev) {
    this._pointerClientX = ev.clientX;
    this._pointerClientY = ev.clientY;
  }

  _pxToUnits() {
    const d = canvas?.dimensions;
    if (!d || typeof d.distance !== 'number' || typeof d.size !== 'number' || d.size <= 0) return 1;
    return d.distance / d.size;
  }

  _flashlightRand() {
    this._flashlightMalfunctionRandState = (this._flashlightMalfunctionRandState * 1664525 + 1013904223) >>> 0;
    return this._flashlightMalfunctionRandState / 4294967296;
  }

  _resetFlashlightMalfunction(t = 0) {
    this._flashlightMalfunctionPhase = 0;
    this._flashlightMalfunctionPhaseT = 0;
    this._flashlightMalfunctionNextTime = 0;
  }

  _getFlashlightBrokennessMultiplier(t, dt) {
    const bRaw = this.params?.flashlightBrokenness;
    const b = (typeof bRaw === 'number' && isFinite(bRaw)) ? Math.max(0, Math.min(1, bRaw)) : 0;

    if (b <= 0.0001) {
      this._resetFlashlightMalfunction(t);
      return 1.0;
    }

    if (!isFinite(t) || t < 0) t = 0;
    if (!isFinite(dt) || dt < 0) dt = 0;

    if (!(this._flashlightMalfunctionNextTime > 0)) {
      const initDelay = (10.0 + 15.0 * this._flashlightRand()) * (1.0 - 0.85 * b);
      this._flashlightMalfunctionNextTime = t + Math.max(0.25, initDelay);
    }

    // Always-on subtle instability even when not actively malfunctioning.
    let mult = 1.0 - 0.08 * b;
    if (this._flashlightMalfunctionNoise) {
      this._flashlightMalfunctionNoise.scale = 0.65 + 0.35 * b;
      mult += 0.045 * b * this._flashlightMalfunctionNoise.value(t);
    }

    if (this._flashlightMalfunctionPhase === 0) {
      if (t >= this._flashlightMalfunctionNextTime) {
        this._flashlightMalfunctionPhase = 1;
        this._flashlightMalfunctionPhaseT = 0;

        const r0 = this._flashlightRand();
        const r1 = this._flashlightRand();
        const r2 = this._flashlightRand();
        const r3 = this._flashlightRand();
        const r4 = this._flashlightRand();

        const severity = Math.max(0, Math.min(1, b));
        const dimDepth = (0.12 + 0.70 * severity) * (0.35 + 0.65 * r0);
        this._flashlightMalfunctionDimTarget = Math.max(0.06, 1.0 - dimDepth);

        this._flashlightMalfunctionDimDuration = (0.06 + 0.55 * severity) * (0.5 + 1.1 * r1);
        this._flashlightMalfunctionFlickerDuration = (0.10 + 1.45 * severity) * (0.5 + 1.0 * r2);
        this._flashlightMalfunctionDeadDuration = (0.05 + 2.35 * severity) * (0.35 + 1.05 * r3);
        this._flashlightMalfunctionRecoverDuration = (0.06 + 1.05 * severity) * (0.5 + 1.0 * r4);

        this._flashlightMalfunctionFlickerSpeed = (6.0 + 22.0 * severity) * (0.7 + 0.9 * this._flashlightRand());
        this._flashlightMalfunctionFlickerDropT = Math.max(0.01, Math.min(0.95, (0.05 + 0.55 * severity) * (0.3 + 0.7 * this._flashlightRand())));
        this._flashlightMalfunctionFlickerPhase = this._flashlightRand() * Math.PI * 2;
      }

      return Math.max(0, Math.min(1.25, mult));
    }

    this._flashlightMalfunctionPhaseT += dt;

    if (this._flashlightMalfunctionPhase === 1) {
      const dur = Math.max(0.001, this._flashlightMalfunctionDimDuration);
      const u = Math.max(0, Math.min(1, this._flashlightMalfunctionPhaseT / dur));
      const s = u * u * (3 - 2 * u);
      mult *= (1.0 * (1 - s) + this._flashlightMalfunctionDimTarget * s);
      if (u >= 1.0) {
        this._flashlightMalfunctionPhase = 2;
        this._flashlightMalfunctionPhaseT = 0;
      }
      return Math.max(0, Math.min(1.25, mult));
    }

    if (this._flashlightMalfunctionPhase === 2) {
      const dur = Math.max(0.001, this._flashlightMalfunctionFlickerDuration);
      const u = Math.max(0, Math.min(1, this._flashlightMalfunctionPhaseT / dur));

      let n = 0;
      if (this._flashlightMalfunctionNoise) {
        this._flashlightMalfunctionNoise.scale = this._flashlightMalfunctionFlickerSpeed;
        this._flashlightMalfunctionNoise.amplitude = 1;
        n = this._flashlightMalfunctionNoise.value(t);
      }

      const a = Math.max(0, Math.min(1, Math.abs(n)));
      const dropT = this._flashlightMalfunctionFlickerDropT;
      let f = (a <= dropT) ? 0.0 : (a - dropT) / Math.max(1e-6, (1.0 - dropT));
      f = Math.max(0, Math.min(1, f));
      f = f * f;

      const strobe = 0.65 + 0.35 * Math.sin(t * (this._flashlightMalfunctionFlickerSpeed * 2.7) + this._flashlightMalfunctionFlickerPhase);
      const flicker = (0.08 + 0.92 * f) * Math.max(0, strobe);

      mult *= this._flashlightMalfunctionDimTarget * flicker;

      if (u >= 1.0) {
        this._flashlightMalfunctionPhase = 3;
        this._flashlightMalfunctionPhaseT = 0;
      }

      return Math.max(0, Math.min(1.25, mult));
    }

    if (this._flashlightMalfunctionPhase === 3) {
      const dur = Math.max(0.001, this._flashlightMalfunctionDeadDuration);
      const u = Math.max(0, Math.min(1, this._flashlightMalfunctionPhaseT / dur));
      mult = 0.0;
      if (u >= 1.0) {
        this._flashlightMalfunctionPhase = 4;
        this._flashlightMalfunctionPhaseT = 0;
      }
      return 0.0;
    }

    if (this._flashlightMalfunctionPhase === 4) {
      const dur = Math.max(0.001, this._flashlightMalfunctionRecoverDuration);
      const u = Math.max(0, Math.min(1, this._flashlightMalfunctionPhaseT / dur));
      const s = u * u * (3 - 2 * u);
      const overshoot = (u < 0.12) ? (1.0 + (0.28 * b) * (1.0 - u / 0.12)) : 1.0;
      mult *= (s * overshoot);

      if (u >= 1.0) {
        this._flashlightMalfunctionPhase = 0;
        this._flashlightMalfunctionPhaseT = 0;
        const minInterval = 2.5;
        const maxInterval = 38.0;
        const baseInterval = maxInterval * (1.0 - b) + minInterval * b;
        const jitter = 0.55 + 1.15 * this._flashlightRand();
        this._flashlightMalfunctionNextTime = t + Math.max(0.2, baseInterval * jitter);
      }

      return Math.max(0, Math.min(1.25, mult));
    }

    this._resetFlashlightMalfunction(t);
    return 1.0;
  }

  _getFlashlightAimWorld(timeInfo, tokenCenterWorld, cursorWorld, groundZ) {
    const wRaw = this.params?.flashlightWobble;
    const w = (typeof wRaw === 'number' && isFinite(wRaw)) ? Math.max(0, Math.min(1, wRaw)) : 0;
    if (w <= 0.0001 || !this._flashlightAimWorld) {
      this._flashlightAimWorld?.set?.(cursorWorld.x, cursorWorld.y, groundZ);
      return this._flashlightAimWorld || cursorWorld;
    }

    const t = typeof timeInfo?.elapsed === 'number' ? timeInfo.elapsed : 0;
    const dx = cursorWorld.x - tokenCenterWorld.x;
    const dy = cursorWorld.y - tokenCenterWorld.y;
    const lenPx = Math.hypot(dx, dy);
    if (!(lenPx > 1e-4)) {
      this._flashlightAimWorld.set(cursorWorld.x, cursorWorld.y, groundZ);
      return this._flashlightAimWorld;
    }

    const pxToUnits = this._pxToUnits();
    const maxU = Math.max(0.001, this.params.flashlightMaxDistanceUnits) * 4.0;
    const distU = lenPx * pxToUnits;
    const distT = Math.max(0, Math.min(1, distU / maxU));

    const baseSway = (0.003 + 0.030 * distT);
    const microSway = (0.0015 + 0.010 * distT);

    let nA = 0;
    let nB = 0;
    let nR = 0;
    if (this._flashlightWobbleNoiseA) {
      this._flashlightWobbleNoiseA.scale = 0.8 + 0.7 * w;
      nA = this._flashlightWobbleNoiseA.value(t);
    }
    if (this._flashlightWobbleNoiseB) {
      this._flashlightWobbleNoiseB.scale = 1.8 + 1.2 * w;
      nB = this._flashlightWobbleNoiseB.value(t);
    }
    if (this._flashlightWobbleNoiseR) {
      this._flashlightWobbleNoiseR.scale = 1.2 + 0.9 * w;
      nR = this._flashlightWobbleNoiseR.value(t);
    }

    const micro = Math.sin(t * (18.0 + 26.0 * w) + this._flashlightMalfunctionRandState * 0.000001) * (0.7 + 0.3 * nB);

    const angOff = (nA * 0.75 + nB * 0.25) * (baseSway * w) + micro * (microSway * w);

    const dirX = dx / lenPx;
    const dirY = dy / lenPx;

    const c = Math.cos(angOff);
    const s = Math.sin(angOff);
    const wdirX = dirX * c - dirY * s;
    const wdirY = dirX * s + dirY * c;

    const radialPx = Math.max(-24, Math.min(24, nR * (Math.min(18, 0.012 * lenPx) * w)));
    const wLenPx = Math.max(0, lenPx + radialPx);

    this._flashlightAimWorld.set(
      tokenCenterWorld.x + wdirX * wLenPx,
      tokenCenterWorld.y + wdirY * wLenPx,
      groundZ
    );
    return this._flashlightAimWorld;
  }

  _isAllowedForUser(tokenDoc) {
    const isGM = !!game?.user?.isGM;
    if (isGM) return true;
    return !!tokenDoc?.isOwner;
  }

  _getActiveTokenId() {
    const isGM = !!game?.user?.isGM;

    try {
      const controlled = canvas?.tokens?.controlled;
      if (Array.isArray(controlled) && controlled.length > 0) {
        if (isGM) {
          const last = this._lastControlledTokenId;
          if (last) {
            const t = canvas.tokens.get(last);
            if (t?.controlled) return last;
          }
        }

        const t0 = controlled[0];
        const id0 = t0?.document?.id ?? t0?.id;
        if (id0) return id0;
      }
    } catch (_) {
    }

    return null;
  }

  _loadCookieTextures() {
    this._initCookieTextures();
    for (const name of this._cookieTextureNames) {
      this._requestCookieTexture(name);
    }
  }

  _createTorchParticleSystem() {
    const THREE = window.THREE;
    if (!THREE || !this._group) return;

    const sceneComposer = window.MapShine?.sceneComposer;
    const effectComposer = sceneComposer?.effectComposer || window.MapShine?.effectComposer;
    const fireEffect = effectComposer?.effects?.get?.('fire-sparks') || null;
    const atlasTex = fireEffect?.fireTexture || null;

    const tex = atlasTex || new THREE.TextureLoader().load('modules/map-shine-advanced/assets/flame.webp');
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    // Match other Quarks textures (cookie, particles) and avoid implicit UV inversion.
    tex.flipY = false;

    this._torchTexture = tex;

    const material = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      color: 0xffffff,
      side: THREE.DoubleSide,
      opacity: 0.0
    });
    material.toneMapped = false;

    // Rope mask discard: inject into Quarks-compatible material shader.
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uRopeMask = { value: null };
      shader.uniforms.uHasRopeMask = { value: 0.0 };
      shader.uniforms.uInvScreenSize = { value: new THREE.Vector2(1, 1) };
      material.userData._msRopeMaskUniforms = shader.uniforms;
      shader.fragmentShader = shader.fragmentShader.replace(
        'void main() {',
        'uniform sampler2D uRopeMask;\nuniform float uHasRopeMask;\nuniform vec2 uInvScreenSize;\nvoid main() {'
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <clipping_planes_fragment>\n',
        '#include <clipping_planes_fragment>\n\n  if (uHasRopeMask > 0.5) {\n    vec2 suv = gl_FragCoord.xy * uInvScreenSize;\n    vec4 rm = texture2D(uRopeMask, suv);\n    if (rm.a > 0.001) discard;\n  }\n'
      );
    };
    this._torchFlameMat = material;

    // Create particle system for torch
    const emitter = new PointEmitter();
    
    const cA = new Vector4(1.2, 1.0, 0.6, 0.35);
    const cB = new Vector4(0.8, 0.2, 0.05, 0.0);
    this._torchColorA = cA;
    this._torchColorB = cB;

    const colorOverLife = new ColorOverLife(new ColorRange(cA, cB));
    const sizeOverLife = new SizeOverLife(new PiecewiseBezier([[new Bezier(0.8, 1.15, 0.75, 0.0), 0]]));
    const buoyancy = new ApplyForce(new THREE.Vector3(0, 0, 1), new ConstantValue(6.0));
    const windForce = new SmartWindBehavior();
    const turbulence = new CurlNoiseField(
      new THREE.Vector3(60, 60, 30),
      new THREE.Vector3(70, 70, 25),
      2.0
    );

    const system = new ParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(0.55, 1.1),
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(18, 32),
      startColor: new ColorRange(cA, cB),
      worldSpace: true,
      maxParticles: 1200,
      emissionOverTime: new IntervalValue(70, 120),
      shape: emitter,
      material: material,
      renderMode: RenderMode.BillBoard,
      renderOrder: 50,
      uTileCount: atlasTex ? 8 : 1,
      vTileCount: atlasTex ? 8 : 1,
      startTileIndex: new ConstantValue(0),
      startRotation: new IntervalValue(0, Math.PI * 2),
      behaviors: [
        colorOverLife,
        sizeOverLife,
        buoyancy,
        windForce,
        turbulence,
        ...(atlasTex ? [new FrameOverLife(new PiecewiseBezier([[new Bezier(0, 21, 42, 63), 0]]))] : [])
      ]
    });

    system.userData = system.userData || {};
    system.userData.windInfluence = 0.25;
    system.userData._msTorchUpdraft = buoyancy;

    this._torchParticleSystem = system;

    const batch = window.MapShineParticles?.batchRenderer;
    if (batch && typeof batch.addSystem === 'function') {
      batch.addSystem(system);
      this._torchParticlesRegistered = true;
      if (this.scene && system.emitter && !system.emitter.parent) {
        this.scene.add(system.emitter);
      }
    } else {
      this._group.add(system.emitter);
    }
    if (system.emitter) {
      const ud = system.emitter.userData || (system.emitter.userData = {});
      ud.msAutoCull = false;
    }
    system.emitter.visible = false;
  }

  _createTorchSparksSystem() {
    const THREE = window.THREE;
    if (!THREE || !this._group) return;

    const sceneComposer = window.MapShine?.sceneComposer;
    const effectComposer = sceneComposer?.effectComposer || window.MapShine?.effectComposer;
    const fireEffect = effectComposer?.effects?.get?.('fire-sparks') || null;
    const sparkTex = fireEffect?.emberTexture || new THREE.TextureLoader().load('modules/map-shine-advanced/assets/particle.webp');
    sparkTex.wrapS = THREE.ClampToEdgeWrapping;
    sparkTex.wrapT = THREE.ClampToEdgeWrapping;
    sparkTex.generateMipmaps = true;
    sparkTex.minFilter = THREE.LinearMipmapLinearFilter;
    sparkTex.magFilter = THREE.LinearFilter;
    sparkTex.flipY = false;
    this._torchSparksTexture = sparkTex;

    const material = new THREE.MeshBasicMaterial({
      map: sparkTex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      color: 0xffffff,
      side: THREE.DoubleSide,
      opacity: 1.0
    });
    material.toneMapped = false;

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uRopeMask = { value: null };
      shader.uniforms.uHasRopeMask = { value: 0.0 };
      shader.uniforms.uInvScreenSize = { value: new THREE.Vector2(1, 1) };
      material.userData._msRopeMaskUniforms = shader.uniforms;
      shader.fragmentShader = shader.fragmentShader.replace(
        'void main() {',
        'uniform sampler2D uRopeMask;\nuniform float uHasRopeMask;\nuniform vec2 uInvScreenSize;\nvoid main() {'
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <clipping_planes_fragment>\n',
        '#include <clipping_planes_fragment>\n\n  if (uHasRopeMask > 0.5) {\n    vec2 suv = gl_FragCoord.xy * uInvScreenSize;\n    vec4 rm = texture2D(uRopeMask, suv);\n    if (rm.a > 0.001) discard;\n  }\n'
      );
    };
    this._torchSparksMat = material;

    const shape = new ConeEmitter({
      radius: 6,
      thickness: 1.0,
      arc: Math.PI * 2,
      angle: Math.PI / 10
    });

    const cA = new Vector4(1.0, 0.85, 0.35, 0.9);
    const cB = new Vector4(1.0, 0.25, 0.05, 0.0);

    const colorOverLife = new ColorOverLife(new ColorRange(cA, cB));
    const sizeOverLife = new SizeOverLife(new PiecewiseBezier([[new Bezier(1.0, 0.9, 0.5, 0.0), 0]]));

    const updraft = new ApplyForce(new THREE.Vector3(0, 0, 1), new ConstantValue(24.0));
    const windForce = new SmartWindBehavior();
    const turbulence = new CurlNoiseField(
      new THREE.Vector3(40, 40, 20),
      new THREE.Vector3(180, 180, 60),
      3.0
    );

    const system = new ParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(0.25, 0.7),
      startSpeed: new IntervalValue(40, 140),
      startSize: new IntervalValue(3, 10),
      startColor: new ColorRange(cA, cB),
      worldSpace: true,
      maxParticles: 2000,
      emissionOverTime: new ConstantValue(28),
      shape,
      material,
      renderMode: RenderMode.StretchedBillBoard,
      speedFactor: 0.03,
      renderOrder: 52,
      startRotation: new IntervalValue(0, Math.PI * 2),
      behaviors: [
        colorOverLife,
        sizeOverLife,
        updraft,
        windForce,
        turbulence
      ]
    });

    system.userData = system.userData || {};
    system.userData.windInfluence = 0.45;
    system.userData._msTorchUpdraft = updraft;

    this._torchSparksSystem = system;

    const batch = window.MapShineParticles?.batchRenderer;
    if (batch && typeof batch.addSystem === 'function') {
      batch.addSystem(system);
      if (this.scene && system.emitter && !system.emitter.parent) {
        this.scene.add(system.emitter);
      }
    } else if (system.emitter) {
      this._group.add(system.emitter);
    }

    if (system.emitter) {
      system.emitter.visible = false;
      const ud = system.emitter.userData || (system.emitter.userData = {});
      ud.msAutoCull = false;
    }
  }

  _createDebugOverlay() {
    if (this._debugOverlay) {
      document.body.removeChild(this._debugOverlay);
    }

    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.top = '10px';
    overlay.style.right = '10px';
    overlay.style.background = 'rgba(0, 0, 0, 0.8)';
    overlay.style.color = '#00ff00';
    overlay.style.padding = '10px';
    overlay.style.borderRadius = '5px';
    overlay.style.fontSize = '12px';
    overlay.style.fontFamily = 'monospace';
    overlay.style.zIndex = '10000';
    overlay.style.display = 'none';
    overlay.style.minWidth = '200px';

    this._debugOverlay = overlay;
    document.body.appendChild(overlay);
  }

  _updateDebugOverlay(state, distance, blocked, distanceFade) {
    if (!this._debugOverlay) return;

    if (this.params.debugReadoutEnabled) {
      const rangeMul = this.params.mode === 'torch' ? 3.0 : 4.0;
      const baseMaxU = this.params.mode === 'torch' ? this.params.torchMaxDistanceUnits : this.params.flashlightMaxDistanceUnits;
      const maxU = Math.max(0.001, baseMaxU) * rangeMul;

      this._debugOverlay.style.display = 'block';
      this._debugOverlay.innerHTML = `
        <div><strong>PlayerLight Debug</strong></div>
        <div>Mode: ${this.params.mode}</div>
        <div>State: ${state}</div>
        <div>Distance: ${distance.toFixed(2)}u</div>
        <div>Blocked: ${blocked ? 'YES' : 'NO'}</div>
        <div>Fade: ${(distanceFade * 100).toFixed(1)}%</div>
        <div>Max Dist: ${maxU.toFixed(2)}u</div>
        <div>Fade Band: ${this.params.fadeOutDistanceUnits}u</div>
      `;
    } else {
      this._debugOverlay.style.display = 'none';
    }
  }

  _createFlashlightMesh() {
    const THREE = window.THREE;
    if (!THREE || !this._group) return;

    const geom = new THREE.PlaneGeometry(1, 1, 1, 1);

    const beamMat = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
      uniforms: {
        uIntensity: { value: 0.0 },
        uRopeMask: { value: null },
        uHasRopeMask: { value: 0.0 },
        uInvScreenSize: { value: new THREE.Vector2(1, 1) },
        uNearWidth: { value: 0.12 },
        uFarWidth: { value: 1.0 },
        uWidthCurve: { value: 1.25 },
        uEdgeSoftness: { value: 0.18 },
        uCoreIntensity: { value: 1.25 },
        uCoreSharpness: { value: 10.0 },
        uMidIntensity: { value: 0.25 },
        uMidSharpness: { value: 2.2 },
        uRimIntensity: { value: 0.6 },
        uRimSharpness: { value: 14.0 },
        uNearBoost: { value: 1.6 },
        uNearBoostCurve: { value: 1.6 },
        uLongFalloffExp: { value: 1.7 },
        uNoiseIntensity: { value: 0.06 },
        uNoiseScale: { value: 7.0 },
        uNoiseSpeed: { value: 1.2 },
        uWallT: { value: 1.0 },
        uTime: { value: 0.0 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uIntensity;
        uniform sampler2D uRopeMask;
        uniform float uHasRopeMask;
        uniform vec2 uInvScreenSize;
        uniform float uNearWidth;
        uniform float uFarWidth;
        uniform float uWidthCurve;
        uniform float uEdgeSoftness;
        uniform float uCoreIntensity;
        uniform float uCoreSharpness;
        uniform float uMidIntensity;
        uniform float uMidSharpness;
        uniform float uRimIntensity;
        uniform float uRimSharpness;
        uniform float uNearBoost;
        uniform float uNearBoostCurve;
        uniform float uLongFalloffExp;
        uniform float uNoiseIntensity;
        uniform float uNoiseScale;
        uniform float uNoiseSpeed;
        uniform float uWallT;
        uniform float uTime;
        varying vec2 vUv;

        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 345.45));
          p += dot(p, p + 34.345);
          return fract(p.x * p.y);
        }

        void main() {
          if (uIntensity <= 0.0001) discard;

          if (uHasRopeMask > 0.5) {
            vec2 suv = gl_FragCoord.xy * uInvScreenSize;
            vec4 rm = texture2D(uRopeMask, suv);
            float ropeMask = rm.a;
            if (ropeMask > 0.001) discard;
          }

          float t = clamp(vUv.x, 0.0, 1.0);
          float wallT = clamp(uWallT, 0.0, 1.0);
          if (t > wallT) discard;

          float centered = abs(vUv.y - 0.5) * 2.0;

          float tw = pow(clamp(t, 0.0, 1.0), max(0.01, uWidthCurve));
          float localW = mix(uNearWidth, uFarWidth, tw);

          float soft = max(1e-5, uEdgeSoftness);
          float edge = smoothstep(localW - soft, localW + soft, centered);
          float beamMask = 1.0 - edge;

          float core = exp(-centered * centered * max(0.01, uCoreSharpness)) * uCoreIntensity;
          float mid = exp(-centered * centered * max(0.01, uMidSharpness)) * uMidIntensity;
          float rim = exp(-(1.0 - centered) * (1.0 - centered) * max(0.01, uRimSharpness)) * uRimIntensity;
          float lateral = max(0.0, core + rim - mid);

          float longFalloff = pow(max(0.0, 1.0 - t / max(wallT, 1e-3)), max(0.01, uLongFalloffExp));
          float nearBoost = mix(1.0, uNearBoost, pow(1.0 - t, max(0.01, uNearBoostCurve)));

          float n = hash21((vUv * uNoiseScale) + vec2(uTime * uNoiseSpeed, uTime * 0.07));
          float noise = 1.0 - uNoiseIntensity + (uNoiseIntensity * (0.5 + 0.5 * n));

          float alpha = beamMask * lateral * longFalloff * nearBoost;
          alpha *= noise;

          vec3 col = vec3(1.0, 0.95, 0.8) * uIntensity;
          gl_FragColor = vec4(col, alpha);
        }
      `
    });

    beamMat.toneMapped = false;

    this._flashlightBeamMat = beamMat;
    const beamMesh = new THREE.Mesh(geom, beamMat);
    beamMesh.name = 'PlayerLight_FlashlightBeam';
    beamMesh.renderOrder = 199;
    beamMesh.visible = false;
    this._flashlightBeamMesh = beamMesh;
    this._group.add(beamMesh);

    const starTex = new THREE.TextureLoader().load(encodeURI('modules/map-shine-advanced/assets/kenney assets/star_01.png'));
    starTex.wrapS = THREE.ClampToEdgeWrapping;
    starTex.wrapT = THREE.ClampToEdgeWrapping;
    starTex.generateMipmaps = true;
    starTex.minFilter = THREE.LinearMipmapLinearFilter;
    starTex.magFilter = THREE.LinearFilter;
    this._flashlightOriginTexture = starTex;

    const originMat = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uMap: { value: starTex },
        uOpacity: { value: 0.0 },
        uColor: { value: new THREE.Color(0xffffff) },
        uRopeMask: { value: null },
        uHasRopeMask: { value: 0.0 },
        uInvScreenSize: { value: new THREE.Vector2(1, 1) }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uMap;
        uniform float uOpacity;
        uniform vec3 uColor;
        uniform sampler2D uRopeMask;
        uniform float uHasRopeMask;
        uniform vec2 uInvScreenSize;
        varying vec2 vUv;

        void main() {
          if (uOpacity <= 0.0001) discard;

          if (uHasRopeMask > 0.5) {
            vec2 suv = gl_FragCoord.xy * uInvScreenSize;
            vec4 rm = texture2D(uRopeMask, suv);
            float ropeMask = rm.a;
            if (ropeMask > 0.001) discard;
          }

          vec4 tex = texture2D(uMap, vUv);
          float a = tex.a * uOpacity;
          if (a <= 0.0001) discard;
          gl_FragColor = vec4(tex.rgb * uColor, a);
        }
      `
    });
    originMat.toneMapped = false;
    this._flashlightOriginMat = originMat;

    const originMesh = new THREE.Mesh(geom, originMat);
    originMesh.name = 'PlayerLight_FlashlightOriginCap';
    originMesh.renderOrder = 201;
    originMesh.visible = false;
    originMesh.layers.set(OVERLAY_THREE_LAYER);
    this._flashlightOriginMesh = originMesh;
    this._group.add(originMesh);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uIntensity: { value: 0.0 },
        uRopeMask: { value: null },
        uHasRopeMask: { value: 0.0 },
        uInvScreenSize: { value: new THREE.Vector2(1, 1) },
        uConeAngle: { value: 0.7 },
        uWallT: { value: 1.0 },
        uTime: { value: 0.0 },
        uCookieTexture: { value: null },
        uCookieRotation: { value: 0.0 },
        uCookieRotationEnabled: { value: true },
        uCookieRotationSpeed: { value: 0.3 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uIntensity;
        uniform sampler2D uRopeMask;
        uniform float uHasRopeMask;
        uniform vec2 uInvScreenSize;
        uniform float uConeAngle;
        uniform float uWallT;
        uniform float uTime;
        uniform sampler2D uCookieTexture;
        uniform float uCookieRotation;
        uniform bool uCookieRotationEnabled;
        uniform float uCookieRotationSpeed;
        varying vec2 vUv;

        void main() {
          if (uIntensity <= 0.0001) discard;

          // Cone-local coordinates:
          // - vUv.x in [0,1] is distance along cone (0 = origin)
          // - vUv.y in [0,1] is lateral (0.5 = centerline)
          float t = clamp(vUv.x, 0.0, 1.0);
          float wallT = clamp(uWallT, 0.0, 1.0);
          if (t > wallT) discard;

          float centered = abs(vUv.y - 0.5) * 2.0; // 0 at centerline, 1 at edge
          float edge = smoothstep(uConeAngle, uConeAngle * 1.15, centered);
          float beam = 1.0 - edge;

          float falloff = pow(max(0.0, 1.0 - t / max(wallT, 1e-3)), 1.7);

          // Sample cookie texture with rotation
          vec2 uv = vUv;
          if (uCookieRotationEnabled) {
            float angle = uCookieRotation + uTime * uCookieRotationSpeed;
            float c = cos(angle);
            float s = sin(angle);
            vec2 center = vec2(0.5, 0.5);
            uv = vUv - center;
            uv = vec2(
              uv.x * c - uv.y * s,
              uv.x * s + uv.y * c
            );
            uv = uv + center;
          }
          
          float cookie = texture2D(uCookieTexture, uv).r;

          float alpha = beam * falloff;
          vec3 col = vec3(1.0, 0.95, 0.8) * uIntensity * cookie;
          gl_FragColor = vec4(col * alpha, alpha);
        }
      `
    });

    if (mat.uniforms?.uCookieTexture) {
      mat.uniforms.uCookieTexture.value = this._defaultCookieTexture;
    }

    this._flashlightMat = mat;

    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = 'PlayerLight_FlashlightCone';
    mesh.renderOrder = 199;
    mesh.visible = false;

    this._flashlightMesh = mesh;
    this._group.add(mesh);

    const cookieMat = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
      uniforms: {
        uIntensity: { value: 0.0 },
        uRopeMask: { value: null },
        uHasRopeMask: { value: 0.0 },
        uInvScreenSize: { value: new THREE.Vector2(1, 1) },
        uTime: { value: 0.0 },
        uCookieTexture: { value: this._defaultCookieTexture },
        uCookieRotationEnabled: { value: true },
        uCookieRotationSpeed: { value: 0.3 },
        uMaskRadius: { value: 0.92 },
        uMaskSoftness: { value: 0.10 },
        uCoreIntensity: { value: 1.25 },
        uCoreSharpness: { value: 8.0 },
        uRimIntensity: { value: 0.55 },
        uRimRadius: { value: 0.78 },
        uRimWidth: { value: 0.22 },
        uVisionMap: { value: null },
        uHasVisionMap: { value: 0.0 },
        uVisionTexelSize: { value: new THREE.Vector2(1, 1) },
        uVisionSoftnessPx: { value: 2.5 },
        uVisionWallInsetPx: { value: 0.0 },
        uVisionThreshold: { value: 0.1 },
        uSceneRect: { value: new THREE.Vector4(0, 0, 1, 1) },
        uCanvasHeight: { value: 1.0 }
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec2 vWorld;
        void main() {
          vUv = uv;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xy;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uIntensity;
        uniform sampler2D uRopeMask;
        uniform float uHasRopeMask;
        uniform vec2 uInvScreenSize;
        uniform float uTime;
        uniform sampler2D uCookieTexture;
        uniform bool uCookieRotationEnabled;
        uniform float uCookieRotationSpeed;
        uniform float uMaskRadius;
        uniform float uMaskSoftness;
        uniform float uCoreIntensity;
        uniform float uCoreSharpness;
        uniform float uRimIntensity;
        uniform float uRimRadius;
        uniform float uRimWidth;
        uniform sampler2D uVisionMap;
        uniform float uHasVisionMap;
        uniform vec2 uVisionTexelSize;
        uniform float uVisionSoftnessPx;
        uniform float uVisionWallInsetPx;
        uniform float uVisionThreshold;
        uniform vec4 uSceneRect;
        uniform float uCanvasHeight;
        varying vec2 vUv;
        varying vec2 vWorld;

        float sampleBlur4(sampler2D tex, vec2 uv, vec2 texel) {
          float c = texture2D(tex, uv).r;
          float l = texture2D(tex, uv + vec2(-texel.x, 0.0)).r;
          float r = texture2D(tex, uv + vec2(texel.x, 0.0)).r;
          float d = texture2D(tex, uv + vec2(0.0, -texel.y)).r;
          float u = texture2D(tex, uv + vec2(0.0, texel.y)).r;
          return (c * 4.0 + l + r + d + u) / 8.0;
        }

        float sampleVisionVisible(vec2 worldXY) {
          vec2 foundry = vec2(worldXY.x, uCanvasHeight - worldXY.y);
          vec2 local = (foundry - uSceneRect.xy) / max(uSceneRect.zw, vec2(1e-6));
          if (local.x < 0.0 || local.x > 1.0 || local.y < 0.0 || local.y > 1.0) return 0.0;
          vec2 visionUv = vec2(local.x, local.y);
          float vision = sampleBlur4(uVisionMap, visionUv, uVisionTexelSize);
          float insetPx = max(0.0, uVisionWallInsetPx);
          if (insetPx > 0.0) {
            vec2 o = uVisionTexelSize * insetPx;
            float vL = sampleBlur4(uVisionMap, visionUv + vec2(-o.x, 0.0), uVisionTexelSize);
            float vR = sampleBlur4(uVisionMap, visionUv + vec2(o.x, 0.0), uVisionTexelSize);
            float vD = sampleBlur4(uVisionMap, visionUv + vec2(0.0, -o.y), uVisionTexelSize);
            float vU = sampleBlur4(uVisionMap, visionUv + vec2(0.0, o.y), uVisionTexelSize);
            vision = min(vision, min(min(vL, vR), min(vD, vU)));
          }
          float soft = max(uVisionTexelSize.x, uVisionTexelSize.y) * max(0.0, uVisionSoftnessPx);
          float thr = uVisionThreshold;
          return smoothstep(thr - soft, thr + soft, vision);
        }

        void main() {
          if (uIntensity <= 0.0001) discard;

          if (uHasRopeMask > 0.5) {
            vec2 suv = gl_FragCoord.xy * uInvScreenSize;
            vec4 rm = texture2D(uRopeMask, suv);
            float ropeMask = rm.a;
            if (ropeMask > 0.001) discard;
          }
          vec2 uv = vUv;
          if (uCookieRotationEnabled) {
            float angle = uTime * uCookieRotationSpeed;
            float c = cos(angle);
            float s = sin(angle);
            vec2 center = vec2(0.5, 0.5);
            uv = vUv - center;
            uv = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c);
            uv = uv + center;
          }

          float cookie = texture2D(uCookieTexture, uv).r;
          vec2 p = (vUv - 0.5) * 2.0;
          float r = length(p);
          float mr = clamp(uMaskRadius, 0.0, 1.0);
          float ms = max(1e-5, uMaskSoftness);
          float mask = 1.0 - smoothstep(mr - ms, mr + ms, r);

          float core = exp(-r * r * max(0.01, uCoreSharpness)) * uCoreIntensity;
          float rw = max(1e-5, uRimWidth);
          float rim = exp(-((r - uRimRadius) / rw) * ((r - uRimRadius) / rw)) * uRimIntensity;
          float radial = max(0.0, core + rim);

          float alpha = cookie * mask;
          if (uHasVisionMap > 0.5) {
            alpha *= sampleVisionVisible(vWorld);
          }
          vec3 col = vec3(1.0, 0.95, 0.8) * uIntensity * radial;
          gl_FragColor = vec4(col, alpha);
        }
      `
    });

    cookieMat.toneMapped = false;

    this._flashlightCookieMat = cookieMat;
    const cookieMesh = new THREE.Mesh(geom, cookieMat);
    cookieMesh.name = 'PlayerLight_FlashlightCookie';
    cookieMesh.renderOrder = 200;
    cookieMesh.visible = false;
    this._flashlightCookieMesh = cookieMesh;
    this._group.add(cookieMesh);
  }

  _updateTorch(timeInfo, tokenCenterWorld, cursorWorld, blocked, distanceUnits, groundZ, distanceFade = 1.0, maxDistanceUnitsOverride = null, snapNow = false) {
    if (!this._torchParticleSystem || !this._torchPos || !this._torchVel) return;

    const dt = typeof timeInfo?.delta === 'number' ? timeInfo.delta : 0.016;
    const t = typeof timeInfo?.elapsed === 'number' ? timeInfo.elapsed : 0;

    if (snapNow) {
      this._torchPos.set(cursorWorld.x, cursorWorld.y, groundZ);
      this._torchVel.set(0, 0, 0);
    }

    const maxU = Math.max(0.001, (typeof maxDistanceUnitsOverride === 'number' ? maxDistanceUnitsOverride : this.params.torchMaxDistanceUnits));
    const inRange = distanceUnits <= maxU;

    const guttering = !inRange;

    const ember = (!inRange || blocked) ? 1 : 0;
    const baseTarget = ember ? this.params.emberIntensity : this.params.torchBaseIntensity;
    const targetIntensity = baseTarget * Math.max(0, Math.min(1, distanceFade));

    const rise = Math.max(0.001, this.params.intensityRiseSpeed);
    const fall = Math.max(0.001, this.params.intensityFallSpeed);
    const k = targetIntensity > this._torchIntensity ? rise : fall;
    const a = 1 - Math.exp(-k * dt);
    this._torchIntensity += (targetIntensity - this._torchIntensity) * a;

    // Spring-follow target on ground plane
    this._tempA.set(cursorWorld.x, cursorWorld.y, groundZ);

    // Add subtle wander in world space based on "pixel" scale (world px)
    const wanderPx = Math.max(0, this.params.wanderPixels);
    const wanderSpd = Math.max(0.001, this.params.wanderSpeed);
    const wX = this._wanderNoiseX.value(t * wanderSpd);
    const wY = this._wanderNoiseY.value(t * wanderSpd);
    this._tempA.x += wX * wanderPx;
    this._tempA.y += wY * wanderPx;

    // Critically-damped-ish spring
    const stiff = Math.max(0, this.params.springStiffness);
    const damp = Math.max(0, this.params.springDamping);

    // vel += (target-pos)*k*dt
    this._tempB.subVectors(this._tempA, this._torchPos);
    this._torchVel.addScaledVector(this._tempB, stiff * dt);

    // damping
    const d = Math.exp(-damp * dt);
    this._torchVel.multiplyScalar(d);

    // integrate
    this._torchPos.addScaledVector(this._torchVel, dt);

    // Flicker intensity
    const flickerSpd = Math.max(0.001, this.params.flickerSpeed);
    const flickerAmt = Math.max(0, this.params.flickerIntensity);
    this._flickerNoise.scale = flickerSpd;
    // In ember mode, heavily damp flicker so the sprite doesn't vanish.
    const emberFlickerScale = ember ? 0.15 : 1.0;
    this._flickerNoise.amplitude = flickerAmt * emberFlickerScale;
    const flicker = this._flickerNoise.value(t);

    // Prevent flicker from subtracting away ember intensity.
    const base = this._torchIntensity;
    const finalIntensity = ember
      ? Math.max(0.04, base + Math.max(0, flicker))
      : Math.max(0, base + flicker);

    this._torchFinalIntensity = finalIntensity;

    const particleSystem = this._torchParticleSystem;
    particleSystem.emitter.visible = true;
    particleSystem.emitter.position.set(this._torchPos.x, this._torchPos.y, groundZ + 0.12);

    try {
      if (particleSystem.startLife && particleSystem.startLife.a !== undefined) {
        const ud = particleSystem.userData || (particleSystem.userData = {});
        if (ud._msTorchBaseLifeMin === undefined) ud._msTorchBaseLifeMin = particleSystem.startLife.a;
        if (ud._msTorchBaseLifeMax === undefined) ud._msTorchBaseLifeMax = particleSystem.startLife.b;
        const baseLifeMin = Math.max(0.01, ud._msTorchBaseLifeMin);
        const baseLifeMax = Math.max(baseLifeMin, ud._msTorchBaseLifeMax);
        const lifeScale = guttering ? Math.max(0.01, Math.min(1.0, (this.params.torchGutterLifeScale ?? 0.3))) : 1.0;
        particleSystem.startLife.a = Math.max(0.01, baseLifeMin * lifeScale);
        particleSystem.startLife.b = Math.max(particleSystem.startLife.a, baseLifeMax * lifeScale);
      }

      const minSz = Math.max(1, this.params.torchFlameSizeMin);
      const maxSz = Math.max(minSz, this.params.torchFlameSizeMax);
      const minRate = Math.max(0, this.params.torchFlameRateMin);
      const maxRate = Math.max(minRate, this.params.torchFlameRateMax);
      if (particleSystem.startSize && particleSystem.startSize.a !== undefined) {
        particleSystem.startSize.a = minSz;
        particleSystem.startSize.b = maxSz;
      }
      if (particleSystem.emissionOverTime && particleSystem.emissionOverTime.a !== undefined) {
        particleSystem.emissionOverTime.a = minRate;
        particleSystem.emissionOverTime.b = maxRate;
      } else if (particleSystem.emissionOverTime && typeof particleSystem.emissionOverTime.value === 'number') {
        particleSystem.emissionOverTime.value = maxRate;
      }
      if (particleSystem.userData) {
        particleSystem.userData.windInfluence = this.params.torchFlameWindInfluence;
        const up = particleSystem.userData._msTorchUpdraft;
        if (up?.magnitude && typeof up.magnitude.value === 'number') {
          up.magnitude.value = this.params.torchFlameUpdraft;
        }
      }
    } catch (_) {
    }

    const batch = window.MapShineParticles?.batchRenderer;
    const batchIdx = batch?.systemToBatchIndex?.get?.(particleSystem);
    const batchMat = (batchIdx !== undefined && batch?.batches?.[batchIdx]) ? batch.batches[batchIdx].material : null;
    const mat = batchMat || particleSystem.material;

    if (this._torchColorA && this._torchColorB) {
      const minA = ember ? 0.10 : 0.0;
      const a = Math.max(minA, Math.min(1.0, finalIntensity));
      if (ember) {
        this._torchColorA.set(0.9, 0.15, 0.08, a);
        this._torchColorB.set(0.35, 0.05, 0.03, 0.0);
      } else {
        this._torchColorA.set(1.0, 0.75, 0.35, a);
        this._torchColorB.set(1.0, 0.2, 0.0, 0.0);
      }
    }

    if (mat) {
      const minOpacity = ember ? 0.25 : 0.0;
      const opacity = Math.max(minOpacity, Math.min(1.0, finalIntensity));
      if (typeof mat.opacity === 'number') mat.opacity = opacity;
      if (mat.color && typeof mat.color.setRGB === 'function') {
        if (ember) mat.color.setRGB(0.9, 0.15, 0.08);
        else mat.color.setRGB(1.0, 0.75, 0.35);
      }
    }

    this._updateTorchSparks(timeInfo, groundZ, finalIntensity, distanceFade);
  }

  _updateFlashlight(timeInfo, tokenCenterWorld, cursorWorld, blocked, wallDistanceUnits, groundZ, distanceFade = 1.0, tokenDoc = null, maxDistanceUnitsOverride = null, coneMaxLenUOverride = null) {
    if (!this._flashlightBeamMesh || !this._flashlightBeamMat || !this._flashlightCookieMesh || !this._flashlightCookieMat) return;

    this._tryAttachFlashlightToLightScene();

    const lighting = this._getLightingEffect();

    const dt = typeof timeInfo?.delta === 'number' ? timeInfo.delta : 0.016;
    const t = typeof timeInfo?.elapsed === 'number' ? timeInfo.elapsed : 0;

    const pxToUnits = this._pxToUnits();

    this._tempA.set(cursorWorld.x - tokenCenterWorld.x, cursorWorld.y - tokenCenterWorld.y, 0);
    const lenPx = Math.hypot(this._tempA.x, this._tempA.y);
    const lenU = lenPx * pxToUnits;

    const gridSize = canvas?.dimensions?.size ?? 100;
    const scaleX = tokenDoc?.texture?.scaleX ?? 1;
    const scaleY = tokenDoc?.texture?.scaleY ?? 1;
    const wPx = (tokenDoc?.width ?? 1) * gridSize * scaleX;
    const hPx = (tokenDoc?.height ?? 1) * gridSize * scaleY;
    const tokenRadiusPx = 0.5 * Math.max(0, Math.min(wPx, hPx));
    const tokenRadiusU = tokenRadiusPx * pxToUnits;
    const beamStartPx = Math.max(0, tokenRadiusPx);

    const maxU = Math.max(0.001, (typeof maxDistanceUnitsOverride === 'number' ? maxDistanceUnitsOverride : this.params.flashlightMaxDistanceUnits));
    const aimDistU = Math.max(0, lenU - tokenRadiusU);
    const distT = Math.max(0, Math.min(1, aimDistU / maxU));
    const rangeFade = 1.0 - distT;

    // Normalized inverse-square style falloff.
    // - Use a reference distance proportional to the max range so it stays artist-friendly.
    // - Clamp with an additional range fade so it still reaches 0 at max distance.
    const refU = Math.max(0.001, maxU * 0.25);
    const invSq = 1.0 / (1.0 + (aimDistU * aimDistU) / (refU * refU));
    const aimFalloff = Math.max(0, Math.min(1, invSq * rangeFade));

    // Do not turn off due to collision; collisions shorten the cone via wallDistanceUnits.
    const rawIntensity = (this.params.flashlightIntensity * aimFalloff) * Math.max(0, Math.min(1, distanceFade));
    const brokennessMult = this._getFlashlightBrokennessMultiplier(t, dt);
    const intensity = rawIntensity * Math.max(0, Math.min(1.25, brokennessMult));
    this._flashlightFinalIntensity = intensity;

    const baseFlashlightIntensity = Math.max(1e-6, this.params.flashlightIntensity);
    const intensityFactor = Math.max(0, Math.min(1, intensity / baseFlashlightIntensity));

    const baseBeamLenU = (this.params.flashlightBeamLengthUnits ?? this.params.flashlightLengthUnits);
    const coneMaxLenU = Math.max(0.5, (typeof coneMaxLenUOverride === 'number' ? coneMaxLenUOverride : baseBeamLenU));
    const reachFactor = Math.max(0, Math.min(1, intensityFactor));
    const effectiveConeMaxLenU = coneMaxLenU * reachFactor;
    const baseMinLenU = 1.5;
    const minLenU = baseMinLenU * Math.max(0.05, reachFactor);
    let coneLenU = Math.min(effectiveConeMaxLenU, Math.max(minLenU, aimDistU));

    const angleDegRaw = (this.params.flashlightBeamAngleDeg ?? this.params.flashlightAngleDeg);
    const angleDeg = Math.max(1, angleDegRaw);
    const halfAngle = (angleDeg * Math.PI / 180) * 0.5;

    const edgeWallDistanceU = Math.max(0, wallDistanceUnits - tokenRadiusU);

    if (blocked) {
      coneLenU = Math.min(coneLenU, edgeWallDistanceU);
    } else {
      coneLenU = Math.min(coneLenU, edgeWallDistanceU > 0.0001 ? edgeWallDistanceU : coneLenU);
    }

    const coneLenPx = coneLenU / Math.max(pxToUnits, 1e-6);
    const widthScale = Math.max(0.001, this.params.flashlightBeamWidthScale ?? 1.0);
    // Keep beam width stable regardless of cursor distance.
    // Previously widthPx scaled with coneLenPx, which tracks the aim distance, causing the beam to widen
    // as the focus point moved away from the token.
    // Use a fixed reference length based on the configured beam length (still clamped by wall distance)
    // so the flashlight always originates from a single point.
    // IMPORTANT: width should track the *beam* length setting, not the cone max reach override.
    // The cone max is intentionally inflated (see update(): flashlightLengthUnits * 4.0) to allow aiming
    // far, but using it for width makes the beam start extremely wide.
    const beamWidthLenU = Math.max(0.001, baseBeamLenU);
    const beamRefLenU = blocked ? Math.min(edgeWallDistanceU, beamWidthLenU) : beamWidthLenU;
    const beamRefLenPx = beamRefLenU / Math.max(pxToUnits, 1e-6);
    const widthPx = Math.tan(halfAngle) * beamRefLenPx * 2 * widthScale;
    const wallT = (coneLenU > 0.0001) ? Math.max(0, Math.min(1, edgeWallDistanceU / coneLenU)) : 0.0;

    const beamMesh = this._flashlightBeamMesh;
    const cookieMesh = this._flashlightCookieMesh;
    const originMesh = this._flashlightOriginMesh;
    const visible = intensity > 1e-4;
    beamMesh.visible = visible;
    cookieMesh.visible = visible;
    if (originMesh) originMesh.visible = visible;

    // Place plane so that its left edge is at the token origin.
    // PlaneGeometry(1,1) is centered, so we offset by +0.5 in local X via position after rotation.
    beamMesh.position.set(tokenCenterWorld.x, tokenCenterWorld.y, groundZ + 0.11);

    // Orient along direction to cursor
    const ang = Math.atan2(this._tempA.y, this._tempA.x);
    beamMesh.rotation.set(0, 0, ang);

    // Scale plane so UV.x spans [0..1] along the cone length
    beamMesh.scale.set(coneLenPx, widthPx, 1);

    // Move the plane so it starts at the token edge (approx circle radius)
    beamMesh.translateX(beamStartPx + coneLenPx * 0.5);

    // Update shader uniforms
    const timeStep = Math.min(dt, 0.1);

    const bu = this._flashlightBeamMat.uniforms;
    bu.uIntensity.value = intensity;
    bu.uNearWidth.value = Math.max(0.0, Math.min(1.5, this.params.flashlightBeamNearWidth ?? 0.12));
    bu.uFarWidth.value = Math.max(0.0, Math.min(3.0, this.params.flashlightBeamFarWidth ?? 1.0));
    bu.uWidthCurve.value = Math.max(0.01, this.params.flashlightBeamWidthCurve ?? 1.25);
    bu.uEdgeSoftness.value = Math.max(0.0, this.params.flashlightBeamEdgeSoftness ?? 0.18);
    bu.uCoreIntensity.value = Math.max(0.0, this.params.flashlightBeamCoreIntensity ?? 1.25);
    bu.uCoreSharpness.value = Math.max(0.01, this.params.flashlightBeamCoreSharpness ?? 10.0);
    bu.uMidIntensity.value = Math.max(0.0, this.params.flashlightBeamMidIntensity ?? 0.25);
    bu.uMidSharpness.value = Math.max(0.01, this.params.flashlightBeamMidSharpness ?? 2.2);
    bu.uRimIntensity.value = Math.max(0.0, this.params.flashlightBeamRimIntensity ?? 0.6);
    bu.uRimSharpness.value = Math.max(0.01, this.params.flashlightBeamRimSharpness ?? 14.0);
    bu.uNearBoost.value = Math.max(0.0, this.params.flashlightBeamNearBoost ?? 1.6);
    bu.uNearBoostCurve.value = Math.max(0.01, this.params.flashlightBeamNearBoostCurve ?? 1.6);
    bu.uLongFalloffExp.value = Math.max(0.01, this.params.flashlightBeamLongFalloffExp ?? 1.7);
    bu.uNoiseIntensity.value = Math.max(0.0, this.params.flashlightBeamNoiseIntensity ?? 0.06);
    bu.uNoiseScale.value = Math.max(0.01, this.params.flashlightBeamNoiseScale ?? 7.0);
    bu.uNoiseSpeed.value = Math.max(0.0, this.params.flashlightBeamNoiseSpeed ?? 1.2);
    bu.uWallT.value = wallT;
    bu.uTime.value += timeStep;

    if (this._flashlightOriginMat && originMesh) {
      const flare = Math.max(0, intensity);
      const flareBoost = 1.0 + flare * 6.0;
      this._flashlightOriginMat.opacity = 1.0;
      if (this._flashlightOriginMat.color && typeof this._flashlightOriginMat.color.setRGB === 'function') {
        this._flashlightOriginMat.color.setRGB(1.0 * flareBoost, 0.98 * flareBoost, 0.9 * flareBoost);
      }
      originMesh.position.set(
        tokenCenterWorld.x + Math.cos(ang) * beamStartPx,
        tokenCenterWorld.y + Math.sin(ang) * beamStartPx,
        groundZ + 0.112
      );
      originMesh.rotation.set(0, 0, ang);
      const starSizePx = Math.max(22, tokenRadiusPx * 0.85);
      originMesh.scale.set(starSizePx, starSizePx, 1);
    }

    const cookieName = this.params.flashlightCookieTexture;
    if (cookieName && !this._cookieTextures[cookieName]) {
      this._requestCookieTexture(cookieName);
    }
    const cTex = this._cookieTextures[cookieName] || this._defaultCookieTexture;

    const cu = this._flashlightCookieMat.uniforms;
    cu.uIntensity.value = intensity * Math.max(0.0, this.params.flashlightCookieIntensity ?? 1.0);
    cu.uTime.value += timeStep;
    cu.uCookieTexture.value = cTex;
    cu.uCookieRotationEnabled.value = this.params.flashlightCookieRotation;
    cu.uCookieRotationSpeed.value = this.params.flashlightCookieRotationSpeed;
    cu.uMaskRadius.value = Math.max(0.0, Math.min(1.0, this.params.flashlightCookieMaskRadius ?? 0.92));
    cu.uMaskSoftness.value = Math.max(0.0, this.params.flashlightCookieMaskSoftness ?? 0.10);
    cu.uCoreIntensity.value = Math.max(0.0, this.params.flashlightCookieCoreIntensity ?? 1.25);
    cu.uCoreSharpness.value = Math.max(0.01, this.params.flashlightCookieCoreSharpness ?? 8.0);
    cu.uRimIntensity.value = Math.max(0.0, this.params.flashlightCookieRimIntensity ?? 0.55);
    cu.uRimRadius.value = Math.max(0.0, Math.min(1.0, this.params.flashlightCookieRimRadius ?? 0.78));
    cu.uRimWidth.value = Math.max(0.001, this.params.flashlightCookieRimWidth ?? 0.22);

    if (!this._visionMaskTexture && this._visionMaskHas <= 0.0) {
      this._updateVisionMaskRefs();
    }

    const rect = canvas?.dimensions?.sceneRect;
    const canvasH = canvas?.dimensions?.height ?? 1;
    if (cu.uHasVisionMap && cu.uVisionMap && cu.uSceneRect && cu.uCanvasHeight && cu.uVisionTexelSize) {
      cu.uHasVisionMap.value = this._visionMaskHas;
      cu.uVisionMap.value = this._visionMaskTexture;
      cu.uCanvasHeight.value = canvasH;
      if (cu.uVisionWallInsetPx) {
        const inset = lighting?.params?.wallInsetPx;
        cu.uVisionWallInsetPx.value = (typeof inset === 'number' && isFinite(inset)) ? Math.max(0, inset) : 0.0;
      }
      if (rect) {
        cu.uSceneRect.value.set(rect.x, rect.y, rect.width, rect.height);
      } else {
        cu.uSceneRect.value.set(0, 0, canvas?.dimensions?.width ?? 1, canvasH);
      }
      if (this._visionMaskTexelSize) {
        cu.uVisionTexelSize.value.copy(this._visionMaskTexelSize);
      }
    }

    const dirX = Math.cos(ang);
    const dirY = Math.sin(ang);
    const cookieDistU = Math.max(0.0, Math.min(coneLenU, edgeWallDistanceU));
    const cookieDistPx = cookieDistU / Math.max(pxToUnits, 1e-6);
    const cookieBasePx = Math.max(1, this.params.flashlightCookieSizePx ?? 120);
    const cookieFromBeam = Math.max(0.0, this.params.flashlightCookieSizeFromBeam ?? 0.75);
    const cookieWidthPx = Math.max(24, Math.max(cookieBasePx, widthPx * cookieFromBeam));

    if (cu.uVisionSoftnessPx) {
      cu.uVisionSoftnessPx.value = Math.max(1.5, Math.min(10.0, cookieWidthPx / 60.0));
    }

    const cookieT = (coneMaxLenU > 0.0001) ? Math.max(0, Math.min(1, cookieDistU / coneMaxLenU)) : 0.0;
    const perspEnabled = !!this.params.flashlightCookiePerspectiveEnabled;
    const perspCurve = Math.max(0.01, this.params.flashlightCookiePerspectiveCurve ?? 1.35);
    const perspT = perspEnabled ? Math.pow(cookieT, perspCurve) : 0.0;
    const perspNear = Math.max(0.01, this.params.flashlightCookiePerspectiveNearScale ?? 0.70);
    const perspFar = Math.max(0.01, this.params.flashlightCookiePerspectiveFarScale ?? 1.55);
    const perspScale = perspEnabled ? (perspNear * (1.0 - perspT) + perspFar * perspT) : 1.0;
    const anamorphic = perspEnabled ? Math.max(0.01, this.params.flashlightCookiePerspectiveAnamorphic ?? 1.65) : 1.0;

    cookieMesh.position.set(
      tokenCenterWorld.x + dirX * (beamStartPx + cookieDistPx),
      tokenCenterWorld.y + dirY * (beamStartPx + cookieDistPx),
      groundZ + 0.115
    );
    cookieMesh.rotation.set(0, 0, ang);
    cookieMesh.scale.set(cookieWidthPx * perspScale * anamorphic, cookieWidthPx * perspScale, 1);

    if (this._flashlightCookieWorld) {
      this._flashlightCookieWorld.copy(cookieMesh.position);
    }
  }

  _getLightingEffect() {
    try {
      const direct = window.MapShine?.lightingEffect;
      if (direct) return direct;
      const sceneComposer = window.MapShine?.sceneComposer;
      const effectComposer = sceneComposer?.effectComposer || window.MapShine?.effectComposer;
      return effectComposer?.effects?.get?.('lighting') || null;
    } catch (_) {
      return null;
    }
  }

  _ensureLightSource(id, docHolderField, sourceField, lightScene) {
    if (!id || !lightScene) return null;
    const existing = this[sourceField];
    if (existing && existing.mesh) return existing;

    const doc = this[docHolderField] || { id, x: 0, y: 0, config: {} };
    doc.id = id;
    if (!doc.config) doc.config = {};
    this[docHolderField] = doc;

    const src = new ThreeLightSource(doc);
    src.init();
    this[sourceField] = src;
    if (src.mesh) {
      try {
        if (src.mesh.layers && typeof src.mesh.layers.enable === 'function') {
          src.mesh.layers.enable(0);
          src.mesh.layers.enable(OVERLAY_THREE_LAYER);
        }
        src.mesh.frustumCulled = false;
      } catch (_) {
      }
      if (!src.mesh.parent) {
        lightScene.add(src.mesh);
      }
    }
    return src;
  }

  _removeDynamicLightSources() {
    const lighting = this._getLightingEffect();
    try {
      if (lighting?.lights) {
        if (this._torchLightSource?.mesh) lighting.lightScene?.remove?.(this._torchLightSource.mesh);
        if (this._flashlightLightSource?.mesh) lighting.lightScene?.remove?.(this._flashlightLightSource.mesh);
      }
    } catch (_) {
    }

    try { this._torchLightSource?.dispose?.(); } catch (_) {}
    try { this._flashlightLightSource?.dispose?.(); } catch (_) {}

    this._torchLightSource = null;
    this._flashlightLightSource = null;
    this._torchLightDoc = null;
    this._flashlightLightDoc = null;
  }

  _hideDynamicLightSources() {
    try {
      // Properly remove light meshes from the scene instead of just hiding them
      // This prevents them from contributing to lighting calculations when disabled
      if (this._torchLightSource?.mesh?.parent) {
        this._torchLightSource.mesh.parent.remove(this._torchLightSource.mesh);
      }
      if (this._flashlightLightSource?.mesh?.parent) {
        this._flashlightLightSource.mesh.parent.remove(this._flashlightLightSource.mesh);
      }
      if (this._torchSparksSystem?.emitter) this._torchSparksSystem.emitter.visible = false;
      if (this._torchParticleSystem?.emitter) this._torchParticleSystem.emitter.visible = false;
    } catch (_) {
    }
  }

  _updateDynamicLightSources(timeInfo, tokenCenterWorld, cursorWorld, blocked, wallDistanceUnits, groundZ, distanceFade, tokenDoc) {
    const lighting = this._getLightingEffect();
    const lightScene = lighting?.lightScene;
    if (!lighting || !lightScene) return;

    const pxToUnits = this._pxToUnits();

    const torchId = 'ms-player-light-torch';
    const flashId = 'ms-player-light-flashlight';

    // Torch light
    const torchSrc = this._ensureLightSource(torchId, '_torchLightDoc', '_torchLightSource', lightScene);
    if (torchSrc && torchSrc.mesh) {
      const gutterNoLight = !!this.params.torchGutterDisableLight && !!this._torchGuttering;
      const enabled = !!this.params.torchLightEnabled && this.params.mode === 'torch' && this.enabled && !gutterNoLight;
      
      if (enabled) {
        // Re-add to scene if it was removed
        if (!torchSrc.mesh.parent) {
          lightScene.add(torchSrc.mesh);
        }
        torchSrc.mesh.visible = true;

        if (this._torchPos) {
          const foundry = Coordinates.toFoundry(this._torchPos.x, this._torchPos.y);
          const c = this.params.torchLightColor;

          const baseIntensity = typeof this._torchFinalIntensity === 'number' ? this._torchFinalIntensity : 0;
          const scaleWithIntensity = !!this.params.torchLightScaleWithIntensity;
          const scale = scaleWithIntensity ? Math.max(0.15, Math.min(1.5, baseIntensity)) : 1.0;

          const dim = Math.max(0, this.params.torchLightDim) * scale;
          const bright = Math.max(0, this.params.torchLightBright) * scale;

          const animType = this.params.torchLightAnimType === 'none' ? null : this.params.torchLightAnimType;

          const doc = this._torchLightDoc;
          doc.x = foundry.x;
          doc.y = foundry.y;
          doc.config = {
            color: c,
            dim,
            bright,
            alpha: this.params.torchLightAlpha,
            attenuation: this.params.torchLightAttenuation,
            luminosity: this.params.torchLightLuminosity,
            animation: {
              type: animType,
              speed: this.params.torchLightAnimSpeed,
              intensity: this.params.torchLightAnimIntensity,
              reverse: false
            }
          };

          torchSrc.updateData(doc, false);
          try {
            if (torchSrc.mesh && torchSrc.mesh.layers && typeof torchSrc.mesh.layers.enable === 'function') {
              torchSrc.mesh.layers.enable(0);
              torchSrc.mesh.layers.enable(OVERLAY_THREE_LAYER);
            }
            torchSrc.mesh.frustumCulled = false;
          } catch (_) {
          }
          torchSrc.updateAnimation(timeInfo, lighting.params?.darknessLevel ?? 0);
        }
      } else {
        // Remove from scene when disabled
        if (torchSrc.mesh.parent) {
          torchSrc.mesh.parent.remove(torchSrc.mesh);
        }
      }
    }

    // Flashlight light
    const flashSrc = this._ensureLightSource(flashId, '_flashlightLightDoc', '_flashlightLightSource', lightScene);
    if (flashSrc && flashSrc.mesh) {
      const enabled = !!this.params.flashlightLightEnabled && this.params.mode === 'flashlight' && this.enabled;
      
      if (enabled) {
        // Re-add to scene if it was removed
        if (!flashSrc.mesh.parent) {
          lightScene.add(flashSrc.mesh);
        }
        flashSrc.mesh.visible = true;

        const baseFlashlightIntensity = Math.max(1e-6, this.params.flashlightIntensity);
        const flashlightIntensityFactor = Math.max(0, Math.min(1, (this._flashlightFinalIntensity ?? 0) / baseFlashlightIntensity));

        if (flashlightIntensityFactor <= 1e-4) {
          if (flashSrc.mesh.parent) {
            flashSrc.mesh.parent.remove(flashSrc.mesh);
          }
          return;
        }

        // Aim distance factor in [0..1] for distance scaling
        const dx = cursorWorld.x - tokenCenterWorld.x;
        const dy = cursorWorld.y - tokenCenterWorld.y;
        const distU = Math.hypot(dx, dy) * pxToUnits;

        const maxU = Math.max(0.001, this.params.flashlightMaxDistanceUnits) * 4.0;
        const distT = Math.max(0, Math.min(1, distU / maxU));
        const distanceScale = this.params.flashlightLightDistanceScaleEnabled
          ? ((this.params.flashlightLightDistanceScaleNear * (1 - distT)) + (this.params.flashlightLightDistanceScaleFar * distT))
          : 1.0;

        const scale = distanceScale * flashlightIntensityFactor;

        let lightWorldX = tokenCenterWorld.x;
        let lightWorldY = tokenCenterWorld.y;
        if (this.params.flashlightLightUseCookiePosition && this._flashlightCookieWorld) {
          lightWorldX = this._flashlightCookieWorld.x;
          lightWorldY = this._flashlightCookieWorld.y;
        }

        const foundry = Coordinates.toFoundry(lightWorldX, lightWorldY);
        const c = this.params.flashlightLightColor;
        const dim = Math.max(0, this.params.flashlightLightDim) * scale;
        const bright = Math.max(0, this.params.flashlightLightBright) * scale;
        const animType = this.params.flashlightLightAnimType === 'none' ? null : this.params.flashlightLightAnimType;

        const doc = this._flashlightLightDoc;
        doc.x = foundry.x;
        doc.y = foundry.y;
        doc.config = {
          color: c,
          dim,
          bright,
          alpha: this.params.flashlightLightAlpha * flashlightIntensityFactor,
          attenuation: this.params.flashlightLightAttenuation,
          luminosity: this.params.flashlightLightLuminosity * flashlightIntensityFactor,
          animation: {
            type: animType,
            speed: this.params.flashlightLightAnimSpeed,
            intensity: this.params.flashlightLightAnimIntensity * flashlightIntensityFactor,
            reverse: false
          }
        };

        flashSrc.updateData(doc, false);
        try {
          if (flashSrc.mesh && flashSrc.mesh.layers && typeof flashSrc.mesh.layers.enable === 'function') {
            flashSrc.mesh.layers.enable(0);
            flashSrc.mesh.layers.enable(OVERLAY_THREE_LAYER);
          }
          flashSrc.mesh.frustumCulled = false;
        } catch (_) {
        }
        flashSrc.updateAnimation(timeInfo, lighting.params?.darknessLevel ?? 0);
      } else {
        // Remove from scene when disabled
        if (flashSrc.mesh.parent) {
          flashSrc.mesh.parent.remove(flashSrc.mesh);
        }
      }
    }
  }

  _setVisible(visible, torchMode) {
    if (this._torchParticleSystem && this._torchParticleSystem.emitter) {
      this._torchParticleSystem.emitter.visible = visible && torchMode;
    }
    if (this._torchSparksSystem && this._torchSparksSystem.emitter) {
      this._torchSparksSystem.emitter.visible = visible && torchMode;
    }
    if (this._flashlightMesh) this._flashlightMesh.visible = false;
    const flashlightOn = visible && !torchMode && (typeof this._flashlightFinalIntensity === 'number') && this._flashlightFinalIntensity > 1e-4;
    if (this._flashlightBeamMesh) this._flashlightBeamMesh.visible = flashlightOn;
    if (this._flashlightCookieMesh) this._flashlightCookieMesh.visible = flashlightOn;
    if (this._flashlightOriginMesh) this._flashlightOriginMesh.visible = flashlightOn;
  }
}
