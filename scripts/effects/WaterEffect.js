import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import { DistortionLayer } from './DistortionManager.js';
import { weatherController } from '../core/WeatherController.js';

const log = createLogger('WaterEffect');

export class WaterEffect extends EffectBase {
  constructor() {
    super('water', RenderLayers.ENVIRONMENTAL, 'low');

    this.priority = 4;
    this.alwaysRender = true;

    this._enabled = false;

    this.params = {
      intensity: 0.5,
      speed: 0.1,
      scale: 1.0,

      displacementMode: 'ripples',
      swellScale: 1.2,
      swellStrength: 1.0,
      chopScale: 6.0,
      chopStrength: 1.0,
      directionality: 1.0,

      chromaticEnabled: true,
      chromaticAberration: 0.35,
      chromaticMaxPixels: 1.5,
      chromaticMaskLo: 0.08,
      chromaticMaskHi: 0.95,
      chromaticMaskPower: 1.0,
      chromaticScreenEdgeStart: 0.02,
      chromaticScreenEdgeSoftness: 0.10,

      tintEnabled: false,
      tintColor: { r: 0.10, g: 0.30, b: 0.48 },
      tintStrength: 0.65,
      depthPower: 1.4,

      murkEnabled: false,
      murkIntensity: 0.65,
      murkColor: { r: 0.08, g: 0.20, b: 0.22 },
      murkScale: 2.25,
      murkSpeed: 0.15,
      murkDepthLo: 0.35,
      murkDepthHi: 0.95,

      sandEnabled: false,
      sandIntensity: 0.65,
      sandColor: { r: 0.75, g: 0.68, b: 0.52 },
      sandScale: 18.0,
      sandSpeed: 0.12,
      sandDepthLo: 0.0,
      sandDepthHi: 0.45,

      sandFinalStrength: 0.35,
      sandTintMix: 0.55,
      sandAdditive: 0.06,
      sandBrightness: 1.0,
      sandContrast: 1.0,
      sandSaturation: 1.0,
      sandInsideEdgeLo: 0.02,
      sandInsideEdgeHi: 0.18,
      sandZoomLo: 0.25,
      sandZoomHi: 0.55,
      sandGrainBoost: 1.35,

      sandStreakAlong: 0.55,
      sandStreakAcross: 2.8,
      sandStreakThresholdLo: 0.30,
      sandStreakThresholdHi: 0.92,
      sandStreakTime: 0.12,

      sandSpeckScale: 6.5,
      sandSpeckDrift: 1.8,
      sandSpeckEvo: 3.5,
      sandSpeckThresholdLo: 0.80,
      sandSpeckThresholdHi: 0.92,
      sandSpeckFwidth: 2.5,

      sandMidScale: 2.1,
      sandMidDrift: 0.9,
      sandMidEvo: 1.2,
      sandMidThreshold: 0.40,
      sandMidFwidth: 2.0,

      sandPatchScale: 0.18,
      sandPatchDrift: 0.25,
      sandPatchThresholdLo: 0.35,
      sandPatchThresholdHi: 0.78,
      sandPatchTimeX: 0.02,
      sandPatchTimeY: 0.015,

      causticsEnabled: false,
      causticsIntensity: 0.35,
      causticsBlendMode: 'screen',
      causticsScale: 10.0,
      causticsSpeed: 0.35,
      causticsSharpness: 3.0,
      causticsEdgeLo: 0.05,
      causticsEdgeHi: 0.55,
      causticsEdgeBlurTexels: 6.0,
      causticsDebug: false,

      rainRipplesEnabled: true,
      rainRippleIntensityBoost: 1.0,
      rainRippleSpeedBoost: 0.65,
      rainRippleScale: 2.0,

      edgeSoftnessTexels: 6.0,

      windFoamEnabled: false,
      windFoamIntensity: 1.0,
      windFoamTiles: 6.0,
      windFoamScale: 10.0,
      windFoamSpeed: 0.25,
      windFoamThreshold: 0.7,
      windFoamSoftness: 0.25,
      windFoamStreakiness: 2.8,
      windFoamDepthLo: 0.25,
      windFoamDepthHi: 0.75,
      windFoamColor: { r: 1.0, g: 1.0, b: 1.0 },

      windAdvectionBase: 0.25,
      windAdvectionInfluence: 1.0,
      windAdvectionMax: 2.0,
      windAdvectionDrag: 2.5,

      gustFieldEnabled: true,
      gustFrontScale: 2.0,
      gustFrontSpeed: 0.08,
      gustFrontSharpness: 2.25,
      gustPatchScale: 1.8,
      gustPatchContrast: 1.35,
      gustLocalBoost: 0.65,

      windWhitecapsEnabled: true,
      whitecapIntensity: 1.0,
      whitecapCrestLo: 0.20,
      whitecapCrestHi: 0.65,
      whitecapBreakupScale: 2.0,
      whitecapBreakupStrength: 0.65,
      whitecapColor: { r: 1.0, g: 1.0, b: 1.0 },
      whitecapColorMix: 0.80,
      whitecapAdditive: 0.10,

      chopEnabled: true,
      chopScaleBase: 6.0,
      chopSpeedBase: 0.25,
      gustChopBoost: 1.25,

      waveWarpEnabled: true,
      waveWarpStrength: 0.18,
      waveWarpScale: 0.65,
      waveWarpSpeed: 0.06,

      scumEnabled: false,
      scumIntensity: 0.35,
      scumColor: { r: 0.23, g: 0.29, b: 0.17 },
      scumScale: 3.0,
      scumSpeed: 0.25,
      scumThresholdLo: 0.55,
      scumThresholdHi: 0.75,

      shoreFoamEnabled: false,
      shoreFoamIntensity: 1.0,
      shoreFoamColor: { r: 1.0, g: 1.0, b: 1.0 },
      shoreFoamColorMix: 0.85,
      shoreFoamScale: 8.0,
      shoreFoamSpeed: 0.25,
      shoreEdgeLo: 0.05,
      shoreEdgeHi: 0.2,

      shoreFoamBandLo: 0.02,
      shoreFoamBandHi: 0.35,
      shoreFoamWaterLo: 0.02,
      shoreFoamWaterHi: 0.18,
      shoreFoamBandPower: 1.0,

      shoreFoamLayers: 3.0,
      shoreFoamLayerScaleStep: 1.35,
      shoreFoamLayerAdditive: 0.65,

      shoreFoamBubbleSize: 0.65,
      shoreFoamBubbleSoftness: 0.06,
      shoreFoamOpacityVar: 0.75,
      shoreFoamOpacityGamma: 1.35,
      shoreFoamOpacityNoiseVar: 0.55,

      shoreFoamWarp: 0.35,
      shoreFoamWarpFreq: 0.15,

      shoreFoamBreakup1Strength: 0.65,
      shoreFoamBreakup1Scale: 0.65,
      shoreFoamBreakup1Speed: 0.22,
      shoreFoamBreakup1Threshold: 0.52,
      shoreFoamBreakup1Softness: 0.22,

      shoreFoamBreakup2Strength: 0.35,
      shoreFoamBreakup2Scale: 2.4,
      shoreFoamBreakup2Speed: 0.55,
      shoreFoamBreakup2Threshold: 0.55,
      shoreFoamBreakup2Softness: 0.18,

      shoreFoamEbbStrength: 0.35,
      shoreFoamEbbSpeed: 0.35,
      shoreFoamEbbScale: 0.8,

      debugMask: false
    };

    this.baseMesh = null;
    this.waterMask = null;

    this._sourceRegistered = false;

    this._dmDebugOwned = false;
    this._dmPrevDebugMode = false;
    this._dmPrevDebugShowMask = false;

    this._waterMaskFlipY = 0.0;
    this._waterMaskUseAlpha = 0.0;

    this._windFoamPhase = 0.0;
    this._windFoamVelocity = 0.0;
  }

  get enabled() {
    return this._enabled;
  }

  set enabled(value) {
    this._enabled = !!value;

    if (!this._enabled) {
      const dm = window.MapShine?.distortionManager;
      if (dm && this._sourceRegistered) {
        dm.setSourceEnabled('water', false);
      }

      if (this._dmDebugOwned && dm?.params) {
        dm.params.debugMode = this._dmPrevDebugMode;
        dm.params.debugShowMask = this._dmPrevDebugShowMask;
        this._dmDebugOwned = false;
      }
    }
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'core',
          label: 'Core',
          type: 'inline',
          parameters: ['intensity', 'speed', 'scale']
        },
        {
          name: 'displacement',
          label: 'Displacement',
          type: 'folder',
          parameters: ['displacementMode', 'swellScale', 'swellStrength', 'chopScale', 'chopStrength', 'directionality']
        },
        {
          name: 'chroma',
          label: 'Chromatic Refraction',
          type: 'folder',
          separator: true,
          parameters: [
            'chromaticEnabled',
            'chromaticAberration',
            'chromaticMaxPixels',
            'chromaticMaskLo',
            'chromaticMaskHi',
            'chromaticMaskPower',
            'chromaticScreenEdgeStart',
            'chromaticScreenEdgeSoftness'
          ]
        },
        {
          name: 'tint',
          label: 'Tint / Absorption',
          type: 'folder',
          separator: true,
          parameters: ['tintEnabled', 'tintColor', 'tintStrength', 'depthPower']
        },
        {
          name: 'murk',
          label: 'Murk',
          type: 'folder',
          separator: true,
          parameters: ['murkEnabled', 'murkIntensity', 'murkColor', 'murkScale', 'murkSpeed', 'murkDepthLo', 'murkDepthHi']
        },
        {
          name: 'sand',
          label: 'Sand',
          type: 'folder',
          separator: true,
          parameters: [
            'sandEnabled',
            'sandIntensity',
            'sandColor',
            'sandScale',
            'sandSpeed',
            'sandDepthLo',
            'sandDepthHi',
            'sandFinalStrength',
            'sandTintMix',
            'sandAdditive',
            'sandBrightness',
            'sandContrast',
            'sandSaturation',
            'sandInsideEdgeLo',
            'sandInsideEdgeHi',
            'sandZoomLo',
            'sandZoomHi'
          ]
        },
        {
          name: 'sandPattern',
          label: 'Sand Pattern',
          type: 'folder',
          parameters: [
            'sandGrainBoost',
            'sandStreakAlong',
            'sandStreakAcross',
            'sandStreakThresholdLo',
            'sandStreakThresholdHi',
            'sandStreakTime',
            'sandSpeckScale',
            'sandSpeckDrift',
            'sandSpeckEvo',
            'sandSpeckThresholdLo',
            'sandSpeckThresholdHi',
            'sandSpeckFwidth',
            'sandMidScale',
            'sandMidDrift',
            'sandMidEvo',
            'sandMidThreshold',
            'sandMidFwidth',
            'sandPatchScale',
            'sandPatchDrift',
            'sandPatchThresholdLo',
            'sandPatchThresholdHi',
            'sandPatchTimeX',
            'sandPatchTimeY'
          ]
        },
        {
          name: 'caustics',
          label: 'Caustics',
          type: 'folder',
          separator: true,
          parameters: [
            'causticsEnabled',
            'causticsIntensity',
            'causticsBlendMode',
            'causticsScale',
            'causticsSpeed',
            'causticsSharpness',
            'causticsEdgeLo',
            'causticsEdgeHi',
            'causticsEdgeBlurTexels',
            'causticsDebug'
          ]
        },
        {
          name: 'rain',
          label: 'Rain Ripples',
          type: 'folder',
          separator: true,
          parameters: ['rainRipplesEnabled', 'rainRippleIntensityBoost', 'rainRippleSpeedBoost', 'rainRippleScale']
        },
        {
          name: 'edge',
          label: 'Edges',
          type: 'folder',
          separator: true,
          parameters: ['edgeSoftnessTexels']
        },
        {
          name: 'windFoam',
          label: 'Wind Foam',
          type: 'folder',
          separator: true,
          parameters: [
            'windFoamEnabled',
            'windFoamIntensity',
            'windFoamTiles',
            'windFoamScale',
            'windFoamSpeed',
            'windFoamThreshold',
            'windFoamSoftness',
            'windFoamStreakiness',
            'windFoamDepthLo',
            'windFoamDepthHi',
            'windFoamColor'
          ]
        },
        {
          name: 'windFoamV2Gust',
          label: 'Wind Foam v2: Gusts',
          type: 'folder',
          parameters: [
            'gustFieldEnabled',
            'gustFrontScale',
            'gustFrontSpeed',
            'gustFrontSharpness',
            'gustPatchScale',
            'gustPatchContrast',
            'gustLocalBoost'
          ]
        },
        {
          name: 'windFoamV2Motion',
          label: 'Wind Foam v2: Motion',
          type: 'folder',
          parameters: [
            'windAdvectionBase',
            'windAdvectionInfluence',
            'windAdvectionMax',
            'windAdvectionDrag'
          ]
        },
        {
          name: 'windFoamV2Whitecaps',
          label: 'Wind Foam v2: Whitecaps',
          type: 'folder',
          parameters: [
            'windWhitecapsEnabled',
            'whitecapIntensity',
            'whitecapColor',
            'whitecapColorMix',
            'whitecapAdditive'
          ]
        },
        {
          name: 'windFoamV2Chop',
          label: 'Wind Foam v2: Chop',
          type: 'folder',
          parameters: ['chopEnabled', 'chopScaleBase', 'chopSpeedBase', 'gustChopBoost']
        },
        {
          name: 'windFoamV2WaveWarp',
          label: 'Wind Foam v2: Wave Warp',
          type: 'folder',
          parameters: ['waveWarpEnabled', 'waveWarpStrength', 'waveWarpScale', 'waveWarpSpeed']
        },
        {
          name: 'scum',
          label: 'Scum',
          type: 'folder',
          separator: true,
          parameters: ['scumEnabled', 'scumIntensity', 'scumColor', 'scumScale', 'scumSpeed', 'scumThresholdLo', 'scumThresholdHi']
        },
        {
          name: 'shoreFoamMain',
          label: 'Shore Foam',
          type: 'folder',
          separator: true,
          parameters: ['shoreFoamEnabled', 'shoreFoamIntensity', 'shoreFoamColor', 'shoreFoamColorMix', 'shoreFoamScale', 'shoreFoamSpeed']
        },
        {
          name: 'shoreFoamShape',
          label: 'Shore Foam: Band & Edge',
          type: 'folder',
          parameters: ['shoreEdgeLo', 'shoreEdgeHi', 'shoreFoamBandLo', 'shoreFoamBandHi', 'shoreFoamWaterLo', 'shoreFoamWaterHi', 'shoreFoamBandPower']
        },
        {
          name: 'shoreFoamLayers',
          label: 'Shore Foam: Layers',
          type: 'folder',
          parameters: ['shoreFoamLayers', 'shoreFoamLayerScaleStep', 'shoreFoamLayerAdditive']
        },
        {
          name: 'shoreFoamBubbles',
          label: 'Shore Foam: Bubbles',
          type: 'folder',
          parameters: ['shoreFoamBubbleSize', 'shoreFoamBubbleSoftness', 'shoreFoamOpacityVar', 'shoreFoamOpacityGamma', 'shoreFoamOpacityNoiseVar']
        },
        {
          name: 'shoreFoamWarp',
          label: 'Shore Foam: Warp',
          type: 'folder',
          parameters: ['shoreFoamWarp', 'shoreFoamWarpFreq']
        },
        {
          name: 'shoreFoamBreakup1',
          label: 'Shore Foam: Breakup 1',
          type: 'folder',
          parameters: ['shoreFoamBreakup1Strength', 'shoreFoamBreakup1Scale', 'shoreFoamBreakup1Speed', 'shoreFoamBreakup1Threshold', 'shoreFoamBreakup1Softness']
        },
        {
          name: 'shoreFoamBreakup2',
          label: 'Shore Foam: Breakup 2',
          type: 'folder',
          parameters: ['shoreFoamBreakup2Strength', 'shoreFoamBreakup2Scale', 'shoreFoamBreakup2Speed', 'shoreFoamBreakup2Threshold', 'shoreFoamBreakup2Softness']
        },
        {
          name: 'shoreFoamEbb',
          label: 'Shore Foam: Ebb / Flow',
          type: 'folder',
          parameters: ['shoreFoamEbbStrength', 'shoreFoamEbbSpeed', 'shoreFoamEbbScale']
        },
        {
          name: 'debug',
          label: 'Debug',
          type: 'folder',
          separator: true,
          parameters: ['debugMask']
        }
      ],
      parameters: {
        intensity: {
          type: 'slider',
          label: 'Intensity',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.5
        },
        speed: {
          type: 'slider',
          label: 'Speed',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.1
        },
        scale: {
          type: 'slider',
          label: 'Scale',
          min: 0.1,
          max: 25,
          step: 0.1,
          default: 1.0
        },

        displacementMode: {
          label: 'Mode',
          default: 'ripples',
          options: {
            Ripples: 'ripples',
            Waves: 'waves'
          }
        },
        swellScale: {
          type: 'slider',
          label: 'Swell Scale',
          min: 0.05,
          max: 20.0,
          step: 0.05,
          default: 1.2
        },
        swellStrength: {
          type: 'slider',
          label: 'Swell Strength',
          min: 0.0,
          max: 4.0,
          step: 0.01,
          default: 1.0
        },
        chopScale: {
          type: 'slider',
          label: 'Chop Scale',
          min: 0.05,
          max: 60.0,
          step: 0.05,
          default: 6.0
        },
        chopStrength: {
          type: 'slider',
          label: 'Chop Strength',
          min: 0.0,
          max: 4.0,
          step: 0.01,
          default: 1.0
        },
        directionality: {
          type: 'slider',
          label: 'Directionality',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 1.0
        },

        chromaticEnabled: {
          type: 'checkbox',
          label: 'Chromatic Enabled',
          default: true
        },
        chromaticAberration: {
          type: 'slider',
          label: 'Chromatic Amount',
          min: 0,
          max: 4,
          step: 0.01,
          default: 0.35
        },
        chromaticMaxPixels: {
          type: 'slider',
          label: 'Chromatic Max (px)',
          min: 0,
          max: 64,
          step: 0.1,
          default: 1.5
        },
        chromaticMaskLo: {
          type: 'slider',
          label: 'Mask Lo (Water)',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.08
        },
        chromaticMaskHi: {
          type: 'slider',
          label: 'Mask Hi (Water)',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.95
        },
        chromaticMaskPower: {
          type: 'slider',
          label: 'Mask Power',
          min: 0.1,
          max: 8,
          step: 0.05,
          default: 1.0
        },
        chromaticScreenEdgeStart: {
          type: 'slider',
          label: 'Screen Edge Start',
          min: 0,
          max: 0.5,
          step: 0.005,
          default: 0.02
        },
        chromaticScreenEdgeSoftness: {
          type: 'slider',
          label: 'Screen Edge Softness',
          min: 0.001,
          max: 0.5,
          step: 0.005,
          default: 0.10
        },

        tintEnabled: {
          type: 'checkbox',
          label: 'Tint Enabled',
          default: false
        },
        tintColor: {
          type: 'color',
          label: 'Tint Color',
          default: { r: 0.10, g: 0.30, b: 0.48 }
        },
        tintStrength: {
          type: 'slider',
          label: 'Tint Strength',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.65
        },
        depthPower: {
          type: 'slider',
          label: 'Depth Power',
          min: 0.1,
          max: 4,
          step: 0.05,
          default: 1.4
        },

        murkEnabled: {
          type: 'checkbox',
          label: 'Murk Enabled',
          default: false
        },
        murkIntensity: {
          type: 'slider',
          label: 'Murk Intensity',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.65
        },
        murkColor: {
          type: 'color',
          label: 'Murk Color',
          default: { r: 0.08, g: 0.20, b: 0.22 }
        },
        murkScale: {
          type: 'slider',
          label: 'Murk Scale',
          min: 0.25,
          max: 200,
          step: 0.25,
          default: 2.25
        },
        murkSpeed: {
          type: 'slider',
          label: 'Murk Speed',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.15
        },
        murkDepthLo: {
          type: 'slider',
          label: 'Murk Depth Lo',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.35
        },
        murkDepthHi: {
          type: 'slider',
          label: 'Murk Depth Hi',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.95
        },

        sandEnabled: {
          type: 'checkbox',
          label: 'Sand Enabled',
          default: false
        },
        sandIntensity: {
          type: 'slider',
          label: 'Sand Intensity',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.65
        },
        sandColor: {
          type: 'color',
          label: 'Sand Color',
          default: { r: 0.75, g: 0.68, b: 0.52 }
        },
        sandScale: {
          type: 'slider',
          label: 'Sand Scale',
          min: 1,
          max: 400,
          step: 0.5,
          default: 18.0
        },
        sandSpeed: {
          type: 'slider',
          label: 'Sand Speed',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.12
        },
        sandDepthLo: {
          type: 'slider',
          label: 'Sand Depth Lo',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.0
        },
        sandDepthHi: {
          type: 'slider',
          label: 'Sand Depth Hi',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.45
        },

        sandFinalStrength: {
          type: 'slider',
          label: 'Sand Final Strength',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.35
        },
        sandTintMix: {
          type: 'slider',
          label: 'Sand Tint Mix',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.55
        },
        sandAdditive: {
          type: 'slider',
          label: 'Sand Additive Glow',
          min: 0.0,
          max: 0.25,
          step: 0.005,
          default: 0.06
        },
        sandBrightness: {
          type: 'slider',
          label: 'Sand Brightness',
          min: 0.0,
          max: 3.0,
          step: 0.01,
          default: 1.0
        },
        sandContrast: {
          type: 'slider',
          label: 'Sand Contrast',
          min: 0.0,
          max: 3.0,
          step: 0.01,
          default: 1.0
        },
        sandSaturation: {
          type: 'slider',
          label: 'Sand Saturation',
          min: 0.0,
          max: 3.0,
          step: 0.01,
          default: 1.0
        },
        sandInsideEdgeLo: {
          type: 'slider',
          label: 'Sand Edge Fade Lo',
          min: 0.0,
          max: 1.0,
          step: 0.005,
          default: 0.02
        },
        sandInsideEdgeHi: {
          type: 'slider',
          label: 'Sand Edge Fade Hi',
          min: 0.0,
          max: 1.0,
          step: 0.005,
          default: 0.18
        },
        sandZoomLo: {
          type: 'slider',
          label: 'Sand Zoom Fade Lo',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.25
        },
        sandZoomHi: {
          type: 'slider',
          label: 'Sand Zoom Fade Hi',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.55
        },
        sandGrainBoost: {
          type: 'slider',
          label: 'Sand Grain Boost',
          min: 0.0,
          max: 4.0,
          step: 0.01,
          default: 1.35
        },

        sandStreakAlong: {
          type: 'slider',
          label: 'Sand Streak Along',
          min: 0.05,
          max: 4.0,
          step: 0.01,
          default: 0.55
        },
        sandStreakAcross: {
          type: 'slider',
          label: 'Sand Streak Across',
          min: 0.05,
          max: 12.0,
          step: 0.01,
          default: 2.8
        },
        sandStreakThresholdLo: {
          type: 'slider',
          label: 'Sand Streak Threshold Lo',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.30
        },
        sandStreakThresholdHi: {
          type: 'slider',
          label: 'Sand Streak Threshold Hi',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.92
        },
        sandStreakTime: {
          type: 'slider',
          label: 'Sand Streak Time',
          min: 0.0,
          max: 1.0,
          step: 0.005,
          default: 0.12
        },

        sandSpeckScale: {
          type: 'slider',
          label: 'Sand Speck Scale',
          min: 0.5,
          max: 100.0,
          step: 0.05,
          default: 6.5
        },
        sandSpeckDrift: {
          type: 'slider',
          label: 'Sand Speck Drift',
          min: 0.0,
          max: 4.0,
          step: 0.01,
          default: 1.8
        },
        sandSpeckEvo: {
          type: 'slider',
          label: 'Sand Speck Evolution',
          min: 0.0,
          max: 8.0,
          step: 0.05,
          default: 3.5
        },
        sandSpeckThresholdLo: {
          type: 'slider',
          label: 'Sand Speck Threshold Lo',
          min: 0.0,
          max: 1.0,
          step: 0.005,
          default: 0.80
        },
        sandSpeckThresholdHi: {
          type: 'slider',
          label: 'Sand Speck Threshold Hi',
          min: 0.0,
          max: 1.0,
          step: 0.005,
          default: 0.92
        },
        sandSpeckFwidth: {
          type: 'slider',
          label: 'Sand Speck AA (fwidth)',
          min: 0.25,
          max: 8.0,
          step: 0.05,
          default: 2.5
        },

        sandMidScale: {
          type: 'slider',
          label: 'Sand Mid Scale',
          min: 0.1,
          max: 50.0,
          step: 0.05,
          default: 2.1
        },
        sandMidDrift: {
          type: 'slider',
          label: 'Sand Mid Drift',
          min: 0.0,
          max: 3.0,
          step: 0.01,
          default: 0.9
        },
        sandMidEvo: {
          type: 'slider',
          label: 'Sand Mid Evolution',
          min: 0.0,
          max: 6.0,
          step: 0.05,
          default: 1.2
        },
        sandMidThreshold: {
          type: 'slider',
          label: 'Sand Mid Threshold',
          min: 0.0,
          max: 1.0,
          step: 0.005,
          default: 0.40
        },
        sandMidFwidth: {
          type: 'slider',
          label: 'Sand Mid AA (fwidth)',
          min: 0.25,
          max: 8.0,
          step: 0.05,
          default: 2.0
        },

        sandPatchScale: {
          type: 'slider',
          label: 'Sand Patch Scale',
          min: 0.01,
          max: 10.0,
          step: 0.005,
          default: 0.18
        },
        sandPatchDrift: {
          type: 'slider',
          label: 'Sand Patch Drift',
          min: 0.0,
          max: 2.0,
          step: 0.005,
          default: 0.25
        },
        sandPatchThresholdLo: {
          type: 'slider',
          label: 'Sand Patch Threshold Lo',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.35
        },
        sandPatchThresholdHi: {
          type: 'slider',
          label: 'Sand Patch Threshold Hi',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.78
        },
        sandPatchTimeX: {
          type: 'slider',
          label: 'Sand Patch Time X',
          min: 0.0,
          max: 0.25,
          step: 0.001,
          default: 0.02
        },
        sandPatchTimeY: {
          type: 'slider',
          label: 'Sand Patch Time Y',
          min: 0.0,
          max: 0.25,
          step: 0.001,
          default: 0.015
        },

        causticsEnabled: {
          type: 'checkbox',
          label: 'Caustics Enabled',
          default: false
        },
        causticsIntensity: {
          type: 'slider',
          label: 'Caustics Intensity',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.35
        },
        causticsBlendMode: {
          label: 'Caustics Blend',
          default: 'screen',
          options: {
            Screen: 'screen',
            Add: 'add',
            SoftAdd: 'softadd'
          }
        },
        causticsScale: {
          type: 'slider',
          label: 'Caustics Scale',
          min: 1,
          max: 200,
          step: 0.25,
          default: 10.0
        },
        causticsSpeed: {
          type: 'slider',
          label: 'Caustics Speed',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.35
        },
        causticsSharpness: {
          type: 'slider',
          label: 'Caustics Sharpness',
          min: 0.1,
          max: 8,
          step: 0.05,
          default: 3.0
        },
        causticsEdgeLo: {
          type: 'slider',
          label: 'Caustics Edge Low',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.05
        },
        causticsEdgeHi: {
          type: 'slider',
          label: 'Caustics Edge High',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.55
        },
        causticsEdgeBlurTexels: {
          type: 'slider',
          label: 'Caustics Edge Blur (texels)',
          min: 0.0,
          max: 32.0,
          step: 0.25,
          default: 6.0
        },
        causticsDebug: {
          type: 'checkbox',
          label: 'Caustics Debug',
          default: false
        },

        rainRipplesEnabled: {
          type: 'checkbox',
          label: 'Rain Ripples',
          default: true
        },
        rainRippleIntensityBoost: {
          type: 'slider',
          label: 'Rain Ripple Intensity',
          min: 0,
          max: 4,
          step: 0.05,
          default: 1.0
        },
        rainRippleSpeedBoost: {
          type: 'slider',
          label: 'Rain Ripple Speed',
          min: 0,
          max: 4,
          step: 0.05,
          default: 0.65
        },
        rainRippleScale: {
          type: 'slider',
          label: 'Rain Ripple Scale',
          min: 0.25,
          max: 40.0,
          step: 0.05,
          default: 2.0
        },

        edgeSoftnessTexels: {
          type: 'slider',
          label: 'Edge Softness (texels)',
          min: 0.0,
          max: 32.0,
          step: 0.25,
          default: 6.0
        },

        windFoamEnabled: {
          type: 'checkbox',
          label: 'Wind Foam',
          default: false
        },
        windFoamIntensity: {
          type: 'slider',
          label: 'Wind Foam Intensity',
          min: 0,
          max: 4,
          step: 0.05,
          default: 1.0
        },
        windFoamTiles: {
          type: 'slider',
          label: 'Wind Foam Tiles',
          min: 1,
          max: 20,
          step: 1,
          default: 6.0
        },
        windFoamScale: {
          type: 'slider',
          label: 'Wind Foam Scale',
          min: 1,
          max: 200,
          step: 0.25,
          default: 10.0
        },
        windFoamSpeed: {
          type: 'slider',
          label: 'Wind Foam Speed',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.25
        },
        windFoamThreshold: {
          type: 'slider',
          label: 'Wind Foam Threshold',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.7
        },
        windFoamSoftness: {
          type: 'slider',
          label: 'Wind Foam Softness',
          min: 0.01,
          max: 0.75,
          step: 0.01,
          default: 0.25
        },
        windFoamStreakiness: {
          type: 'slider',
          label: 'Wind Foam Streakiness',
          min: 0.25,
          max: 12,
          step: 0.05,
          default: 2.8
        },
        windFoamDepthLo: {
          type: 'slider',
          label: 'Wind Foam Depth Lo',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.25
        },
        windFoamDepthHi: {
          type: 'slider',
          label: 'Wind Foam Depth Hi',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.75
        },
        windFoamColor: {
          type: 'color',
          label: 'Wind Foam Color',
          default: { r: 1.0, g: 1.0, b: 1.0 }
        },

        windAdvectionBase: {
          type: 'slider',
          label: 'Wind Advection Base',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.25
        },
        windAdvectionInfluence: {
          type: 'slider',
          label: 'Wind Influence',
          min: 0,
          max: 6,
          step: 0.05,
          default: 1.0
        },
        windAdvectionMax: {
          type: 'slider',
          label: 'Wind Max Boost',
          min: 0,
          max: 6,
          step: 0.05,
          default: 2.0
        },
        windAdvectionDrag: {
          type: 'slider',
          label: 'Wind Drag',
          min: 0,
          max: 12,
          step: 0.05,
          default: 2.5
        },

        gustFieldEnabled: {
          type: 'checkbox',
          label: 'Gust Field',
          default: true
        },
        gustFrontScale: {
          type: 'slider',
          label: 'Gust Front Scale',
          min: 0.1,
          max: 60,
          step: 0.05,
          default: 2.0
        },
        gustFrontSpeed: {
          type: 'slider',
          label: 'Gust Front Speed',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.08
        },
        gustFrontSharpness: {
          type: 'slider',
          label: 'Gust Front Sharpness',
          min: 0.1,
          max: 8,
          step: 0.05,
          default: 2.25
        },
        gustPatchScale: {
          type: 'slider',
          label: 'Gust Patch Scale',
          min: 0.1,
          max: 60,
          step: 0.05,
          default: 1.8
        },
        gustPatchContrast: {
          type: 'slider',
          label: 'Gust Patch Contrast',
          min: 0.1,
          max: 4,
          step: 0.05,
          default: 1.35
        },
        gustLocalBoost: {
          type: 'slider',
          label: 'Gust Local Boost',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.65
        },

        windWhitecapsEnabled: {
          type: 'checkbox',
          label: 'Whitecaps',
          default: true
        },
        whitecapIntensity: {
          type: 'slider',
          label: 'Whitecap Intensity',
          min: 0,
          max: 4,
          step: 0.05,
          default: 1.0
        },
        whitecapCrestLo: {
          type: 'slider',
          label: 'Crest Lo',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.20
        },
        whitecapCrestHi: {
          type: 'slider',
          label: 'Crest Hi',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.65
        },
        whitecapBreakupScale: {
          type: 'slider',
          label: 'Breakup Scale',
          min: 0.1,
          max: 60,
          step: 0.05,
          default: 2.0
        },
        whitecapBreakupStrength: {
          type: 'slider',
          label: 'Breakup Strength',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.65
        },
        whitecapColor: {
          type: 'color',
          label: 'Whitecap Color',
          default: { r: 1.0, g: 1.0, b: 1.0 }
        },
        whitecapColorMix: {
          type: 'slider',
          label: 'Color Mix',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.80
        },
        whitecapAdditive: {
          type: 'slider',
          label: 'Additive',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.10
        },

        chopEnabled: {
          type: 'checkbox',
          label: 'Chop',
          default: true
        },
        chopScaleBase: {
          type: 'slider',
          label: 'Chop Scale',
          min: 0.1,
          max: 200,
          step: 0.1,
          default: 6.0
        },
        chopSpeedBase: {
          type: 'slider',
          label: 'Chop Speed',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.25
        },
        gustChopBoost: {
          type: 'slider',
          label: 'Gust Chop Boost',
          min: 0.5,
          max: 5,
          step: 0.05,
          default: 1.25
        },

        waveWarpEnabled: {
          type: 'checkbox',
          label: 'Wave Warp',
          default: true
        },
        waveWarpStrength: {
          type: 'slider',
          label: 'Warp Strength',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.18
        },
        waveWarpScale: {
          type: 'slider',
          label: 'Warp Scale',
          min: 0.05,
          max: 10.0,
          step: 0.05,
          default: 0.65
        },
        waveWarpSpeed: {
          type: 'slider',
          label: 'Warp Speed',
          min: 0.0,
          max: 1.0,
          step: 0.005,
          default: 0.06
        },

        scumEnabled: {
          type: 'checkbox',
          label: 'Scum',
          default: false
        },
        scumIntensity: {
          type: 'slider',
          label: 'Scum Intensity',
          min: 0,
          max: 4,
          step: 0.05,
          default: 0.35
        },
        scumColor: {
          type: 'color',
          label: 'Scum Color',
          default: { r: 0.23, g: 0.29, b: 0.17 }
        },
        scumScale: {
          type: 'slider',
          label: 'Scum Scale',
          min: 0.25,
          max: 100,
          step: 0.25,
          default: 3.0
        },
        scumSpeed: {
          type: 'slider',
          label: 'Scum Speed',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.25
        },
        scumThresholdLo: {
          type: 'slider',
          label: 'Scum Threshold Lo',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.55
        },
        scumThresholdHi: {
          type: 'slider',
          label: 'Scum Threshold Hi',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.75
        },

        shoreFoamEnabled: {
          type: 'checkbox',
          label: 'Shore Foam',
          default: false
        },
        shoreFoamIntensity: {
          type: 'slider',
          label: 'Shore Foam Intensity',
          min: 0,
          max: 4,
          step: 0.05,
          default: 1.0
        },
        shoreFoamColor: {
          type: 'color',
          label: 'Shore Foam Color',
          default: { r: 1.0, g: 1.0, b: 1.0 }
        },
        shoreFoamColorMix: {
          type: 'slider',
          label: 'Color Mix',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.85
        },
        shoreFoamScale: {
          type: 'slider',
          label: 'Shore Foam Scale',
          min: 0.25,
          max: 45000,
          step: 0.25,
          default: 8.0
        },
        shoreFoamSpeed: {
          type: 'slider',
          label: 'Shore Foam Speed',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.25
        },
        shoreEdgeLo: {
          type: 'slider',
          label: 'Shore Edge Lo',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.05
        },
        shoreEdgeHi: {
          type: 'slider',
          label: 'Shore Edge Hi',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.2
        },

        shoreFoamBandLo: {
          type: 'slider',
          label: 'Band Lo',
          min: 0,
          max: 1,
          step: 0.005,
          default: 0.02
        },
        shoreFoamBandHi: {
          type: 'slider',
          label: 'Band Hi',
          min: 0,
          max: 1,
          step: 0.005,
          default: 0.35
        },
        shoreFoamWaterLo: {
          type: 'slider',
          label: 'Water Lo',
          min: 0,
          max: 1,
          step: 0.005,
          default: 0.02
        },
        shoreFoamWaterHi: {
          type: 'slider',
          label: 'Water Hi',
          min: 0,
          max: 1,
          step: 0.005,
          default: 0.18
        },
        shoreFoamBandPower: {
          type: 'slider',
          label: 'Band Power',
          min: 0.1,
          max: 4,
          step: 0.05,
          default: 1.0
        },

        shoreFoamLayers: {
          type: 'slider',
          label: 'Layers',
          min: 1,
          max: 4,
          step: 1,
          default: 3.0
        },
        shoreFoamLayerScaleStep: {
          type: 'slider',
          label: 'Layer Scale Step',
          min: 1.01,
          max: 3.0,
          step: 0.01,
          default: 1.35
        },
        shoreFoamLayerAdditive: {
          type: 'slider',
          label: 'Layer Blend',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.65
        },

        shoreFoamBubbleSize: {
          type: 'slider',
          label: 'Bubble Size',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.65
        },
        shoreFoamBubbleSoftness: {
          type: 'slider',
          label: 'Bubble Softness',
          min: 0.001,
          max: 0.25,
          step: 0.001,
          default: 0.06
        },
        shoreFoamOpacityVar: {
          type: 'slider',
          label: 'Opacity Variety',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.75
        },
        shoreFoamOpacityGamma: {
          type: 'slider',
          label: 'Variety Gamma',
          min: 0.1,
          max: 4,
          step: 0.05,
          default: 1.35
        },
        shoreFoamOpacityNoiseVar: {
          type: 'slider',
          label: 'Noise Variety',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.55
        },

        shoreFoamWarp: {
          type: 'slider',
          label: 'Warp',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.35
        },
        shoreFoamWarpFreq: {
          type: 'slider',
          label: 'Warp Frequency',
          min: 0.0,
          max: 2,
          step: 0.01,
          default: 0.15
        },

        shoreFoamBreakup1Strength: {
          type: 'slider',
          label: 'Breakup Strength',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.65
        },
        shoreFoamBreakup1Scale: {
          type: 'slider',
          label: 'Breakup Scale',
          min: 0.05,
          max: 40,
          step: 0.05,
          default: 0.65
        },
        shoreFoamBreakup1Speed: {
          type: 'slider',
          label: 'Breakup Speed',
          min: 0,
          max: 3,
          step: 0.01,
          default: 0.22
        },
        shoreFoamBreakup1Threshold: {
          type: 'slider',
          label: 'Breakup Threshold',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.52
        },
        shoreFoamBreakup1Softness: {
          type: 'slider',
          label: 'Breakup Softness',
          min: 0.001,
          max: 0.5,
          step: 0.001,
          default: 0.22
        },

        shoreFoamBreakup2Strength: {
          type: 'slider',
          label: 'Breakup Strength',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.35
        },
        shoreFoamBreakup2Scale: {
          type: 'slider',
          label: 'Breakup Scale',
          min: 0.05,
          max: 60,
          step: 0.05,
          default: 2.4
        },
        shoreFoamBreakup2Speed: {
          type: 'slider',
          label: 'Breakup Speed',
          min: 0,
          max: 3,
          step: 0.01,
          default: 0.55
        },
        shoreFoamBreakup2Threshold: {
          type: 'slider',
          label: 'Breakup Threshold',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.55
        },
        shoreFoamBreakup2Softness: {
          type: 'slider',
          label: 'Breakup Softness',
          min: 0.001,
          max: 0.5,
          step: 0.001,
          default: 0.18
        },

        shoreFoamEbbStrength: {
          type: 'slider',
          label: 'Ebb Strength',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.35
        },
        shoreFoamEbbSpeed: {
          type: 'slider',
          label: 'Ebb Speed',
          min: 0,
          max: 4,
          step: 0.01,
          default: 0.35
        },
        shoreFoamEbbScale: {
          type: 'slider',
          label: 'Ebb Scale',
          min: 0.05,
          max: 60,
          step: 0.05,
          default: 0.8
        },

        debugMask: {
          type: 'checkbox',
          label: 'Debug Mask',
          default: false
        }
      }
    };
  }

  setBaseMesh(baseMesh, assetBundle) {
    this.baseMesh = baseMesh;

    const waterMaskData = assetBundle?.masks?.find((m) => m.id === 'water' || m.type === 'water');
    this.waterMask = waterMaskData?.texture || null;

    const THREE = window.THREE;
    if (THREE && this.waterMask) {
      this.waterMask.minFilter = THREE.LinearFilter;
      this.waterMask.magFilter = THREE.LinearFilter;
      this.waterMask.generateMipmaps = false;

      // MapShine convention: authored masks are treated as Foundry/top-left UVs.
      // Keep flipY=false so v=0 samples the top of the image (matching base plane).
      this.waterMask.flipY = false;
      this._waterMaskFlipY = 0.0;

      try {
        const img = this.waterMask.image;
        if (img && (img instanceof HTMLImageElement || img instanceof HTMLCanvasElement || img instanceof ImageBitmap || img instanceof OffscreenCanvas || img instanceof HTMLVideoElement)) {
          const canvas = document.createElement('canvas');
          const w = 32;
          const h = 32;
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(img, 0, 0, w, h);
            const data = ctx.getImageData(0, 0, w, h).data;
            let rMin = 255;
            let rMax = 0;
            let aMin = 255;
            let aMax = 0;
            for (let i = 0; i < data.length; i += 4) {
              const r = data[i];
              const a = data[i + 3];
              if (r < rMin) rMin = r;
              if (r > rMax) rMax = r;
              if (a < aMin) aMin = a;
              if (a > aMax) aMax = a;
            }
            const rRange = rMax - rMin;
            const aRange = aMax - aMin;
            if (aRange > rRange + 8) {
              this._waterMaskUseAlpha = 1.0;
            } else {
              this._waterMaskUseAlpha = 0.0;
            }
          }
        }
      } catch (_) {
        this._waterMaskUseAlpha = 0.0;
      }

      this.waterMask.needsUpdate = true;
    }

    if (!this.waterMask) {
      log.debug('No _Water mask found for this scene');
    }
  }

  update(timeInfo) {
    const dm = window.MapShine?.distortionManager;
    if (!dm) {
      try {
        if (window.MapShine) {
          window.MapShine._waterFoamDebug = {
            status: 'inactive',
            reason: 'no_distortion_manager'
          };
        }
      } catch (_) {
      }
      return;
    }

    const wc = window.MapShine?.weatherController || weatherController;

    const p = this.params || {};

    if (!this.enabled || !this.waterMask) {
      try {
        if (window.MapShine) {
          window.MapShine._waterFoamDebug = {
            status: 'inactive',
            reason: !this.enabled ? 'water_effect_disabled' : 'no_water_mask',
            waterEffectEnabled: !!this.enabled,
            hasWaterMask: !!this.waterMask,
            sourceRegistered: !!this._sourceRegistered,
            windFoamEnabled: !!this.params?.windFoamEnabled
          };
        }
      } catch (_) {
      }
      if (this._dmDebugOwned && dm.params) {
        dm.params.debugMode = this._dmPrevDebugMode;
        dm.params.debugShowMask = this._dmPrevDebugShowMask;
        this._dmDebugOwned = false;
      }
      if (this._sourceRegistered) {
        dm.setSourceEnabled('water', false);
      }
      return;
    }

    // Water distortion depends on the DistortionManager post-processing pass.
    // If the user has Screen Distortion disabled in the UI, water will otherwise
    // appear to do nothing even though the source is registered.
    dm.enabled = true;
    if (dm.params && Object.prototype.hasOwnProperty.call(dm.params, 'enabled')) {
      dm.params.enabled = true;
    }

    const intensityUi = typeof p.intensity === 'number' ? p.intensity : 0.5;
    const speedUi = typeof p.speed === 'number' ? p.speed : 0.1;
    const scaleUi = typeof p.scale === 'number' ? p.scale : 1.0;

    const debugMask = typeof p.debugMask === 'boolean' ? p.debugMask : false;

    if (dm.params) {
      if (debugMask) {
        if (!this._dmDebugOwned) {
          this._dmPrevDebugMode = !!dm.params.debugMode;
          this._dmPrevDebugShowMask = !!dm.params.debugShowMask;
          this._dmDebugOwned = true;
        }
        dm.params.debugMode = true;
        dm.params.debugShowMask = true;
      } else if (this._dmDebugOwned) {
        dm.params.debugMode = this._dmPrevDebugMode;
        dm.params.debugShowMask = this._dmPrevDebugShowMask;
        this._dmDebugOwned = false;
      }
    }

    const chromaEnabled = typeof p.chromaticEnabled === 'boolean' ? p.chromaticEnabled : true;
    const chromaUi = typeof p.chromaticAberration === 'number' ? p.chromaticAberration : 0.35;
    const chromaMaxPixels = typeof p.chromaticMaxPixels === 'number' ? p.chromaticMaxPixels : 1.5;
    const chromaMaskLo = typeof p.chromaticMaskLo === 'number' ? p.chromaticMaskLo : 0.08;
    const chromaMaskHi = typeof p.chromaticMaskHi === 'number' ? p.chromaticMaskHi : 0.95;
    const chromaMaskPower = typeof p.chromaticMaskPower === 'number' ? p.chromaticMaskPower : 1.0;
    const chromaScreenEdgeStart = typeof p.chromaticScreenEdgeStart === 'number' ? p.chromaticScreenEdgeStart : 0.02;
    const chromaScreenEdgeSoftness = typeof p.chromaticScreenEdgeSoftness === 'number' ? p.chromaticScreenEdgeSoftness : 0.10;

    const tintEnabled = typeof p.tintEnabled === 'boolean' ? p.tintEnabled : false;
    const tintColor = p.tintColor ?? { r: 0.10, g: 0.30, b: 0.48 };
    const tintStrength = typeof p.tintStrength === 'number' ? p.tintStrength : 0.65;
    const depthPower = typeof p.depthPower === 'number' ? p.depthPower : 1.4;

    const murkEnabled = typeof p.murkEnabled === 'boolean' ? p.murkEnabled : false;
    const murkIntensity = typeof p.murkIntensity === 'number' ? p.murkIntensity : 0.65;
    const murkColor = p.murkColor ?? { r: 0.08, g: 0.20, b: 0.22 };
    const murkScale = typeof p.murkScale === 'number' ? p.murkScale : 2.25;
    const murkSpeed = typeof p.murkSpeed === 'number' ? p.murkSpeed : 0.15;
    const murkDepthLo = typeof p.murkDepthLo === 'number' ? p.murkDepthLo : 0.35;
    const murkDepthHi = typeof p.murkDepthHi === 'number' ? p.murkDepthHi : 0.95;

    const sandEnabled = typeof p.sandEnabled === 'boolean' ? p.sandEnabled : false;
    const sandIntensity = typeof p.sandIntensity === 'number' ? p.sandIntensity : 0.65;
    const sandColor = p.sandColor ?? { r: 0.75, g: 0.68, b: 0.52 };
    const sandScale = typeof p.sandScale === 'number' ? p.sandScale : 18.0;
    const sandSpeed = typeof p.sandSpeed === 'number' ? p.sandSpeed : 0.12;
    const sandDepthLo = typeof p.sandDepthLo === 'number' ? p.sandDepthLo : 0.0;
    const sandDepthHi = typeof p.sandDepthHi === 'number' ? p.sandDepthHi : 0.45;

    const sandFinalStrength = typeof p.sandFinalStrength === 'number' ? p.sandFinalStrength : 0.35;
    const sandTintMix = typeof p.sandTintMix === 'number' ? p.sandTintMix : 0.55;
    const sandAdditive = typeof p.sandAdditive === 'number' ? p.sandAdditive : 0.06;
    const sandBrightness = typeof p.sandBrightness === 'number' ? p.sandBrightness : 1.0;
    const sandContrast = typeof p.sandContrast === 'number' ? p.sandContrast : 1.0;
    const sandSaturation = typeof p.sandSaturation === 'number' ? p.sandSaturation : 1.0;
    const sandInsideEdgeLo = typeof p.sandInsideEdgeLo === 'number' ? p.sandInsideEdgeLo : 0.02;
    const sandInsideEdgeHi = typeof p.sandInsideEdgeHi === 'number' ? p.sandInsideEdgeHi : 0.18;
    const sandZoomLo = typeof p.sandZoomLo === 'number' ? p.sandZoomLo : 0.25;
    const sandZoomHi = typeof p.sandZoomHi === 'number' ? p.sandZoomHi : 0.55;
    const sandGrainBoost = typeof p.sandGrainBoost === 'number' ? p.sandGrainBoost : 1.35;

    const sandStreakAlong = typeof p.sandStreakAlong === 'number' ? p.sandStreakAlong : 0.55;
    const sandStreakAcross = typeof p.sandStreakAcross === 'number' ? p.sandStreakAcross : 2.8;
    const sandStreakThresholdLo = typeof p.sandStreakThresholdLo === 'number' ? p.sandStreakThresholdLo : 0.30;
    const sandStreakThresholdHi = typeof p.sandStreakThresholdHi === 'number' ? p.sandStreakThresholdHi : 0.92;
    const sandStreakTime = typeof p.sandStreakTime === 'number' ? p.sandStreakTime : 0.12;

    const sandSpeckScale = typeof p.sandSpeckScale === 'number' ? p.sandSpeckScale : 6.5;
    const sandSpeckDrift = typeof p.sandSpeckDrift === 'number' ? p.sandSpeckDrift : 1.8;
    const sandSpeckEvo = typeof p.sandSpeckEvo === 'number' ? p.sandSpeckEvo : 3.5;
    const sandSpeckThresholdLo = typeof p.sandSpeckThresholdLo === 'number' ? p.sandSpeckThresholdLo : 0.80;
    const sandSpeckThresholdHi = typeof p.sandSpeckThresholdHi === 'number' ? p.sandSpeckThresholdHi : 0.92;
    const sandSpeckFwidth = typeof p.sandSpeckFwidth === 'number' ? p.sandSpeckFwidth : 2.5;

    const sandMidScale = typeof p.sandMidScale === 'number' ? p.sandMidScale : 2.1;
    const sandMidDrift = typeof p.sandMidDrift === 'number' ? p.sandMidDrift : 0.9;
    const sandMidEvo = typeof p.sandMidEvo === 'number' ? p.sandMidEvo : 1.2;
    const sandMidThreshold = typeof p.sandMidThreshold === 'number' ? p.sandMidThreshold : 0.40;
    const sandMidFwidth = typeof p.sandMidFwidth === 'number' ? p.sandMidFwidth : 2.0;

    const sandPatchScale = typeof p.sandPatchScale === 'number' ? p.sandPatchScale : 0.18;
    const sandPatchDrift = typeof p.sandPatchDrift === 'number' ? p.sandPatchDrift : 0.25;
    const sandPatchThresholdLo = typeof p.sandPatchThresholdLo === 'number' ? p.sandPatchThresholdLo : 0.35;
    const sandPatchThresholdHi = typeof p.sandPatchThresholdHi === 'number' ? p.sandPatchThresholdHi : 0.78;
    const sandPatchTimeX = typeof p.sandPatchTimeX === 'number' ? p.sandPatchTimeX : 0.02;
    const sandPatchTimeY = typeof p.sandPatchTimeY === 'number' ? p.sandPatchTimeY : 0.015;

    const causticsEnabled = typeof p.causticsEnabled === 'boolean' ? p.causticsEnabled : false;
    const causticsIntensity = typeof p.causticsIntensity === 'number' ? p.causticsIntensity : 0.35;
    const causticsBlendMode = typeof p.causticsBlendMode === 'string' ? p.causticsBlendMode : 'screen';
    const causticsScale = typeof p.causticsScale === 'number' ? p.causticsScale : 10.0;
    const causticsSpeed = typeof p.causticsSpeed === 'number' ? p.causticsSpeed : 0.35;
    const causticsSharpness = typeof p.causticsSharpness === 'number' ? p.causticsSharpness : 3.0;
    const causticsEdgeLo = typeof p.causticsEdgeLo === 'number' ? p.causticsEdgeLo : 0.05;
    const causticsEdgeHi = typeof p.causticsEdgeHi === 'number' ? p.causticsEdgeHi : 0.55;
    const causticsEdgeBlurTexels = typeof p.causticsEdgeBlurTexels === 'number' ? p.causticsEdgeBlurTexels : 6.0;
    const causticsDebug = typeof p.causticsDebug === 'boolean' ? p.causticsDebug : false;

    const windFoamEnabled = typeof p.windFoamEnabled === 'boolean' ? p.windFoamEnabled : false;
    const windFoamIntensity = typeof p.windFoamIntensity === 'number' ? p.windFoamIntensity : 1.0;
    const windFoamTiles = typeof p.windFoamTiles === 'number' ? p.windFoamTiles : 6.0;
    const windFoamScale = typeof p.windFoamScale === 'number' ? p.windFoamScale : 10.0;
    const windFoamSpeed = typeof p.windFoamSpeed === 'number' ? p.windFoamSpeed : 0.25;
    const windFoamThreshold = typeof p.windFoamThreshold === 'number' ? p.windFoamThreshold : 0.7;
    const windFoamSoftness = typeof p.windFoamSoftness === 'number' ? p.windFoamSoftness : 0.25;
    const windFoamStreakiness = typeof p.windFoamStreakiness === 'number' ? p.windFoamStreakiness : 2.8;
    const windFoamDepthLo = typeof p.windFoamDepthLo === 'number' ? p.windFoamDepthLo : 0.25;
    const windFoamDepthHi = typeof p.windFoamDepthHi === 'number' ? p.windFoamDepthHi : 0.75;
    const windFoamColor = p.windFoamColor ?? { r: 1.0, g: 1.0, b: 1.0 };

    const gustFieldEnabled = typeof p.gustFieldEnabled === 'boolean' ? p.gustFieldEnabled : true;
    const gustFrontScale = typeof p.gustFrontScale === 'number' ? p.gustFrontScale : 2.0;
    const gustFrontSpeed = typeof p.gustFrontSpeed === 'number' ? p.gustFrontSpeed : 0.08;
    const gustFrontSharpness = typeof p.gustFrontSharpness === 'number' ? p.gustFrontSharpness : 2.25;
    const gustPatchScale = typeof p.gustPatchScale === 'number' ? p.gustPatchScale : 1.8;
    const gustPatchContrast = typeof p.gustPatchContrast === 'number' ? p.gustPatchContrast : 1.35;
    const gustLocalBoost = typeof p.gustLocalBoost === 'number' ? p.gustLocalBoost : 0.65;

    const windWhitecapsEnabled = typeof p.windWhitecapsEnabled === 'boolean' ? p.windWhitecapsEnabled : true;
    const whitecapIntensity = typeof p.whitecapIntensity === 'number' ? p.whitecapIntensity : 1.0;
    const whitecapCrestLo = typeof p.whitecapCrestLo === 'number' ? p.whitecapCrestLo : 0.20;
    const whitecapCrestHi = typeof p.whitecapCrestHi === 'number' ? p.whitecapCrestHi : 0.65;
    const whitecapBreakupScale = typeof p.whitecapBreakupScale === 'number' ? p.whitecapBreakupScale : 2.0;
    const whitecapBreakupStrength = typeof p.whitecapBreakupStrength === 'number' ? p.whitecapBreakupStrength : 0.65;
    const whitecapColor = p.whitecapColor ?? { r: 1.0, g: 1.0, b: 1.0 };
    const whitecapColorMix = typeof p.whitecapColorMix === 'number' ? p.whitecapColorMix : 0.80;
    const whitecapAdditive = typeof p.whitecapAdditive === 'number' ? p.whitecapAdditive : 0.10;

    const chopEnabled = typeof p.chopEnabled === 'boolean' ? p.chopEnabled : true;
    const chopScaleBase = typeof p.chopScaleBase === 'number' ? p.chopScaleBase : 6.0;
    const chopSpeedBase = typeof p.chopSpeedBase === 'number' ? p.chopSpeedBase : 0.25;
    const gustChopBoost = typeof p.gustChopBoost === 'number' ? p.gustChopBoost : 1.25;

    const waveWarpEnabled = typeof p.waveWarpEnabled === 'boolean' ? p.waveWarpEnabled : true;
    const waveWarpStrength = typeof p.waveWarpStrength === 'number' ? p.waveWarpStrength : 0.18;
    const waveWarpScale = typeof p.waveWarpScale === 'number' ? p.waveWarpScale : 0.65;
    const waveWarpSpeed = typeof p.waveWarpSpeed === 'number' ? p.waveWarpSpeed : 0.06;

    const scumEnabled = typeof p.scumEnabled === 'boolean' ? p.scumEnabled : false;
    const scumIntensity = typeof p.scumIntensity === 'number' ? p.scumIntensity : 0.35;
    const scumColor = p.scumColor ?? { r: 0.23, g: 0.29, b: 0.17 };
    const scumScale = typeof p.scumScale === 'number' ? p.scumScale : 3.0;
    const scumSpeed = typeof p.scumSpeed === 'number' ? p.scumSpeed : 0.25;
    const scumThresholdLo = typeof p.scumThresholdLo === 'number' ? p.scumThresholdLo : 0.55;
    const scumThresholdHi = typeof p.scumThresholdHi === 'number' ? p.scumThresholdHi : 0.75;

    const shoreFoamEnabled = typeof p.shoreFoamEnabled === 'boolean' ? p.shoreFoamEnabled : false;
    const shoreFoamIntensity = typeof p.shoreFoamIntensity === 'number' ? p.shoreFoamIntensity : 1.0;
    const shoreFoamColor = p.shoreFoamColor ?? { r: 1.0, g: 1.0, b: 1.0 };
    const shoreFoamColorMix = typeof p.shoreFoamColorMix === 'number' ? p.shoreFoamColorMix : 0.85;
    const shoreFoamScale = typeof p.shoreFoamScale === 'number' ? p.shoreFoamScale : 8.0;
    const shoreFoamSpeed = typeof p.shoreFoamSpeed === 'number' ? p.shoreFoamSpeed : 0.25;
    const shoreEdgeLo = typeof p.shoreEdgeLo === 'number' ? p.shoreEdgeLo : 0.05;
    const shoreEdgeHi = typeof p.shoreEdgeHi === 'number' ? p.shoreEdgeHi : 0.2;

    const shoreFoamBandLo = typeof p.shoreFoamBandLo === 'number' ? p.shoreFoamBandLo : 0.02;
    const shoreFoamBandHi = typeof p.shoreFoamBandHi === 'number' ? p.shoreFoamBandHi : 0.35;
    const shoreFoamWaterLo = typeof p.shoreFoamWaterLo === 'number' ? p.shoreFoamWaterLo : 0.02;
    const shoreFoamWaterHi = typeof p.shoreFoamWaterHi === 'number' ? p.shoreFoamWaterHi : 0.18;
    const shoreFoamBandPower = typeof p.shoreFoamBandPower === 'number' ? p.shoreFoamBandPower : 1.0;

    const shoreFoamLayers = typeof p.shoreFoamLayers === 'number' ? p.shoreFoamLayers : 3.0;
    const shoreFoamLayerScaleStep = typeof p.shoreFoamLayerScaleStep === 'number' ? p.shoreFoamLayerScaleStep : 1.35;
    const shoreFoamLayerAdditive = typeof p.shoreFoamLayerAdditive === 'number' ? p.shoreFoamLayerAdditive : 0.65;

    const shoreFoamBubbleSize = typeof p.shoreFoamBubbleSize === 'number' ? p.shoreFoamBubbleSize : 0.65;
    const shoreFoamBubbleSoftness = typeof p.shoreFoamBubbleSoftness === 'number' ? p.shoreFoamBubbleSoftness : 0.06;
    const shoreFoamOpacityVar = typeof p.shoreFoamOpacityVar === 'number' ? p.shoreFoamOpacityVar : 0.75;
    const shoreFoamOpacityGamma = typeof p.shoreFoamOpacityGamma === 'number' ? p.shoreFoamOpacityGamma : 1.35;
    const shoreFoamOpacityNoiseVar = typeof p.shoreFoamOpacityNoiseVar === 'number' ? p.shoreFoamOpacityNoiseVar : 0.55;

    const shoreFoamWarp = typeof p.shoreFoamWarp === 'number' ? p.shoreFoamWarp : 0.35;
    const shoreFoamWarpFreq = typeof p.shoreFoamWarpFreq === 'number' ? p.shoreFoamWarpFreq : 0.15;

    const shoreFoamBreakup1Strength = typeof p.shoreFoamBreakup1Strength === 'number' ? p.shoreFoamBreakup1Strength : 0.65;
    const shoreFoamBreakup1Scale = typeof p.shoreFoamBreakup1Scale === 'number' ? p.shoreFoamBreakup1Scale : 0.65;
    const shoreFoamBreakup1Speed = typeof p.shoreFoamBreakup1Speed === 'number' ? p.shoreFoamBreakup1Speed : 0.22;
    const shoreFoamBreakup1Threshold = typeof p.shoreFoamBreakup1Threshold === 'number' ? p.shoreFoamBreakup1Threshold : 0.52;
    const shoreFoamBreakup1Softness = typeof p.shoreFoamBreakup1Softness === 'number' ? p.shoreFoamBreakup1Softness : 0.22;

    const shoreFoamBreakup2Strength = typeof p.shoreFoamBreakup2Strength === 'number' ? p.shoreFoamBreakup2Strength : 0.35;
    const shoreFoamBreakup2Scale = typeof p.shoreFoamBreakup2Scale === 'number' ? p.shoreFoamBreakup2Scale : 2.4;
    const shoreFoamBreakup2Speed = typeof p.shoreFoamBreakup2Speed === 'number' ? p.shoreFoamBreakup2Speed : 0.55;
    const shoreFoamBreakup2Threshold = typeof p.shoreFoamBreakup2Threshold === 'number' ? p.shoreFoamBreakup2Threshold : 0.55;
    const shoreFoamBreakup2Softness = typeof p.shoreFoamBreakup2Softness === 'number' ? p.shoreFoamBreakup2Softness : 0.18;

    const shoreFoamEbbStrength = typeof p.shoreFoamEbbStrength === 'number' ? p.shoreFoamEbbStrength : 0.35;
    const shoreFoamEbbSpeed = typeof p.shoreFoamEbbSpeed === 'number' ? p.shoreFoamEbbSpeed : 0.35;
    const shoreFoamEbbScale = typeof p.shoreFoamEbbScale === 'number' ? p.shoreFoamEbbScale : 0.8;

    let intensity = intensityUi * 0.08;
    let frequency = scaleUi * 6.0;
    let speed = 0.25 + speedUi * 10.0;

    const rainRipplesEnabled = typeof p.rainRipplesEnabled === 'boolean' ? p.rainRipplesEnabled : true;
    const rainRippleIntensityBoost = typeof p.rainRippleIntensityBoost === 'number' ? p.rainRippleIntensityBoost : 1.0;
    const rainRippleSpeedBoost = typeof p.rainRippleSpeedBoost === 'number' ? p.rainRippleSpeedBoost : 0.65;
    const rainRippleScale = typeof p.rainRippleScale === 'number' ? p.rainRippleScale : 2.0;

    const edgeSoftnessTexels = typeof p.edgeSoftnessTexels === 'number' ? p.edgeSoftnessTexels : 6.0;

    const displacementMode = typeof p.displacementMode === 'string' ? p.displacementMode : 'ripples';
    const waterMode = displacementMode === 'waves' ? 1.0 : 0.0;
    const swellScale = typeof p.swellScale === 'number' ? p.swellScale : 1.2;
    const swellStrength = typeof p.swellStrength === 'number' ? p.swellStrength : 1.0;
    const chopScale = typeof p.chopScale === 'number' ? p.chopScale : 6.0;
    const chopStrength = typeof p.chopStrength === 'number' ? p.chopStrength : 1.0;
    const directionality = typeof p.directionality === 'number' ? p.directionality : 1.0;

    let weatherState = null;
    if ((rainRipplesEnabled || windFoamEnabled || windWhitecapsEnabled || gustFieldEnabled || chopEnabled) && wc && typeof wc.getCurrentState === 'function') {
      weatherState = wc.getCurrentState();
    }

    if (rainRipplesEnabled && weatherState) {
      const precip = weatherState?.precipitation ?? 0;
      const freeze = weatherState?.freezeLevel ?? 0;
      const rainFactor = Math.max(0, Math.min(1, precip * (1.0 - freeze)));

      intensity *= (1.0 + rainFactor * rainRippleIntensityBoost);
      speed *= (1.0 + rainFactor * rainRippleSpeedBoost);
      frequency *= (1.0 + rainFactor * 0.15);
      frequency *= (1.0 + rainFactor * Math.max(0.0, rainRippleScale));
    }

    let windDirX = 1.0;
    let windDirY = 0.0;
    let windSpeed01 = 0.0;
    // Rebuild wind direction logic for wind foam:
    // - Direction should follow the UI setting exactly => use targetState.windDirection when available.
    // - Speed can still come from currentState (gusts/variability).
    // - Convert once into the same UV convention the water mask sampling uses.
    if (wc) {
      const wdTarget = wc?.targetState?.windDirection;
      const wdCurrent = weatherState?.windDirection;
      const ws = weatherState?.windSpeed;

      let windDirSource = 'none';

      const wd = (wdTarget && Number.isFinite(wdTarget.x) && Number.isFinite(wdTarget.y))
        ? (windDirSource = 'target', wdTarget)
        : (wdCurrent && Number.isFinite(wdCurrent.x) && Number.isFinite(wdCurrent.y))
          ? (windDirSource = 'current', wdCurrent)
          : null;

      if (wd && Number.isFinite(wd.x) && Number.isFinite(wd.y)) {
        const len = Math.hypot(wd.x, wd.y) || 1.0;
        windDirX = wd.x / len;
        windDirY = wd.y / len;

        // Convert from UI/world Y-down to water-mask UV convention.
        // If the mask is not flipped (flipY=0), we invert Y here.
        // If the mask is already flipped (flipY=1), we keep Y as-is.
        if (this._waterMaskFlipY <= 0.5) {
          windDirY *= -1.0;
        }
      }
      if (Number.isFinite(ws)) {
        windSpeed01 = ws;
      }
    }

    // Integrate wind foam advection phase to avoid "ping-pong" behavior when wind speed changes.
    // Using absolute time * varying speed creates apparent backtracking as gust envelopes rise/fall.
    // Instead: phase += velocity * dt (monotonic). Direction changes still steer the scroll.
    let dt = Number.isFinite(timeInfo?.delta) ? timeInfo.delta : 0.0;
    dt = Math.max(0.0, Math.min(dt, 0.1));

    const windSpeedClamped = Math.max(0.0, Math.min(1.0, windSpeed01));
    if (windSpeedClamped > 0.0) {
      const w = windSpeedClamped;
      intensity *= (1.0 + w * 1.35);
      speed *= (1.0 + w * 0.55);
      frequency *= (1.0 + w * 0.85);
    }

    const advectEnabled = windFoamEnabled || scumEnabled || shoreFoamEnabled || windWhitecapsEnabled;
    const advectSpeed = (windFoamEnabled || windWhitecapsEnabled)
      ? windFoamSpeed
      : shoreFoamEnabled
        ? shoreFoamSpeed
        : scumSpeed;
    const windAdvectionBase = Number.isFinite(p.windAdvectionBase) ? p.windAdvectionBase : 0.25;
    const windAdvectionInfluence = Number.isFinite(p.windAdvectionInfluence) ? p.windAdvectionInfluence : 1.0;
    const windAdvectionMax = Number.isFinite(p.windAdvectionMax) ? p.windAdvectionMax : 2.0;
    const windAdvectionDrag = Number.isFinite(p.windAdvectionDrag) ? p.windAdvectionDrag : 2.5;

    // Inertial wind advection:
    // We treat wind as a source of acceleration (velocity += a*dt) rather than setting
    // a target velocity each frame. When a gust falls, the velocity doesn't instantly
    // collapse to 0; it decays via drag.
    // Velocity is stored as an additive factor (roughly comparable to windSpeed01).
    if (dt > 0.0) {
      const drag = Math.max(0.0, windAdvectionDrag);
      const maxBoost = Math.max(0.0, windAdvectionMax);

      if (advectEnabled) {
        const accel = windSpeedClamped * Math.max(0.0, windAdvectionInfluence);
        this._windFoamVelocity += accel * dt;
      }

      if (drag > 0.0) {
        this._windFoamVelocity *= Math.exp(-drag * dt);
      }

      this._windFoamVelocity = Math.max(0.0, Math.min(maxBoost, this._windFoamVelocity));

      const advectFactor = advectEnabled
        ? Math.max(0.0, Math.min(windAdvectionBase + this._windFoamVelocity, windAdvectionBase + maxBoost))
        : 0.0;

      this._windFoamPhase += (advectSpeed * advectFactor) * dt;
      if (this._windFoamPhase > 10000.0) this._windFoamPhase -= 10000.0;
      if (this._windFoamPhase < -10000.0) this._windFoamPhase += 10000.0;
    }

    const windFoamPhase = this._windFoamPhase;
    const windAdvectFactor = advectEnabled
      ? Math.max(0.0, Math.min(windAdvectionBase + this._windFoamVelocity, windAdvectionBase + Math.max(0.0, windAdvectionMax)))
      : 0.0;

    try {
      if (window.MapShine) {
        window.MapShine._waterFoamDebug = {
          wcEnabled: !!wc?.enabled,
          usedWindDir: { x: windDirX, y: windDirY },
          windDirSource,
          targetWindDir: wc?.targetState?.windDirection ? { x: wc.targetState.windDirection.x, y: wc.targetState.windDirection.y } : null,
          currentWindDir: weatherState?.windDirection ? { x: weatherState.windDirection.x, y: weatherState.windDirection.y } : null,
          windSpeed01,
          windFoamPhase,
          maskFlipY: this._waterMaskFlipY,
          windFoamEnabled,
          scumEnabled,
          shoreFoamEnabled
        };
      }
    } catch (_) {
    }

    if (!this._sourceRegistered) {
      dm.registerSource('water', DistortionLayer.ABOVE_GROUND, this.waterMask, {
        intensity,
        frequency,
        speed,

        waterMode,
        swellScale,
        swellStrength,
        chopScale,
        chopStrength,
        directionality,

        edgeSoftnessTexels,

        maskFlipY: this._waterMaskFlipY,
        maskUseAlpha: this._waterMaskUseAlpha,

        // Chromatic refraction (RGB split) in DistortionManager apply pass
        chromaEnabled,
        chroma: chromaUi,
        chromaMaxPixels,
        chromaMaskLo,
        chromaMaskHi,
        chromaMaskPower,
        chromaScreenEdgeStart,
        chromaScreenEdgeSoftness,

        // Depth-based tint/absorption
        tintEnabled,
        tintColor,
        tintStrength,
        depthPower,

        murkEnabled,
        murkIntensity,
        murkColor,
        murkScale,
        murkSpeed,
        murkDepthLo,
        murkDepthHi,

        sandEnabled,
        sandIntensity,
        sandColor,
        sandScale,
        sandSpeed,
        sandDepthLo,
        sandDepthHi,
        sandFinalStrength,
        sandTintMix,
        sandAdditive,
        sandBrightness,
        sandContrast,
        sandSaturation,
        sandInsideEdgeLo,
        sandInsideEdgeHi,
        sandZoomLo,
        sandZoomHi,
        sandGrainBoost,
        sandStreakAlong,
        sandStreakAcross,
        sandStreakThresholdLo,
        sandStreakThresholdHi,
        sandStreakTime,
        sandSpeckScale,
        sandSpeckDrift,
        sandSpeckEvo,
        sandSpeckThresholdLo,
        sandSpeckThresholdHi,
        sandSpeckFwidth,
        sandMidScale,
        sandMidDrift,
        sandMidEvo,
        sandMidThreshold,
        sandMidFwidth,
        sandPatchScale,
        sandPatchDrift,
        sandPatchThresholdLo,
        sandPatchThresholdHi,
        sandPatchTimeX,
        sandPatchTimeY,

        // Caustics
        causticsEnabled,
        causticsIntensity,
        causticsBlendMode,
        causticsScale,
        causticsSpeed,
        causticsSharpness,
        causticsEdgeLo,
        causticsEdgeHi,
        causticsEdgeBlurTexels,
        causticsDebug,

        windFoamEnabled,
        windFoamIntensity,
        windFoamTiles,
        windFoamScale,
        windFoamSpeed,
        windFoamThreshold,
        windFoamSoftness,
        windFoamStreakiness,
        windFoamDepthLo,
        windFoamDepthHi,
        windFoamColor,

        gustFieldEnabled,
        gustFrontScale,
        gustFrontSpeed,
        gustFrontSharpness,
        gustPatchScale,
        gustPatchContrast,
        gustLocalBoost,

        windWhitecapsEnabled,
        whitecapIntensity,
        whitecapColor,
        whitecapColorMix,
        whitecapAdditive,

        chopEnabled,
        chopScaleBase,
        chopSpeedBase,
        gustChopBoost,

        waveWarpEnabled,
        waveWarpStrength,
        waveWarpScale,
        waveWarpSpeed,

        scumEnabled,
        scumIntensity,
        scumColor,
        scumScale,
        scumSpeed,
        scumThresholdLo,
        scumThresholdHi,

        shoreFoamEnabled,
        shoreFoamIntensity,
        shoreFoamColor,
        shoreFoamColorMix,
        shoreFoamScale,
        shoreFoamSpeed,
        shoreEdgeLo,
        shoreEdgeHi,

        shoreFoamBandLo,
        shoreFoamBandHi,
        shoreFoamWaterLo,
        shoreFoamWaterHi,
        shoreFoamBandPower,

        shoreFoamLayers,
        shoreFoamLayerScaleStep,
        shoreFoamLayerAdditive,
        shoreFoamBubbleSize,
        shoreFoamBubbleSoftness,
        shoreFoamOpacityVar,
        shoreFoamOpacityGamma,
        shoreFoamOpacityNoiseVar,
        shoreFoamWarp,
        shoreFoamWarpFreq,
        shoreFoamBreakup1Strength,
        shoreFoamBreakup1Scale,
        shoreFoamBreakup1Speed,
        shoreFoamBreakup1Threshold,
        shoreFoamBreakup1Softness,
        shoreFoamBreakup2Strength,
        shoreFoamBreakup2Scale,
        shoreFoamBreakup2Speed,
        shoreFoamBreakup2Threshold,
        shoreFoamBreakup2Softness,
        shoreFoamEbbStrength,
        shoreFoamEbbSpeed,
        shoreFoamEbbScale,

        windDirX,
        windDirY,
        windSpeed: windSpeed01,
        windAdvectFactor,
        windFoamPhase
      });
      this._sourceRegistered = true;
    } else {
      dm.updateSourceMask('water', this.waterMask);

      dm.updateSourceParams('water', {
        intensity,
        frequency,
        speed,
        edgeSoftnessTexels,
        waterMode,
        swellScale,
        swellStrength,
        chopScale,
        chopStrength,
        directionality,
        maskFlipY: this._waterMaskFlipY,
        maskUseAlpha: this._waterMaskUseAlpha,
        chromaEnabled,
        chroma: chromaUi,
        chromaMaxPixels,
        chromaMaskLo,
        chromaMaskHi,
        chromaMaskPower,
        chromaScreenEdgeStart,
        chromaScreenEdgeSoftness,

        tintEnabled,
        tintColor,
        tintStrength,
        depthPower,

        murkEnabled,
        murkIntensity,
        murkColor,
        murkScale,
        murkSpeed,
        murkDepthLo,
        murkDepthHi,

        sandEnabled,
        sandIntensity,
        sandColor,
        sandScale,
        sandSpeed,
        sandDepthLo,
        sandDepthHi,
        sandFinalStrength,
        sandTintMix,
        sandAdditive,
        sandBrightness,
        sandContrast,
        sandSaturation,
        sandInsideEdgeLo,
        sandInsideEdgeHi,
        sandZoomLo,
        sandZoomHi,
        sandGrainBoost,
        sandStreakAlong,
        sandStreakAcross,
        sandStreakThresholdLo,
        sandStreakThresholdHi,
        sandStreakTime,
        sandSpeckScale,
        sandSpeckDrift,
        sandSpeckEvo,
        sandSpeckThresholdLo,
        sandSpeckThresholdHi,
        sandSpeckFwidth,
        sandMidScale,
        sandMidDrift,
        sandMidEvo,
        sandMidThreshold,
        sandMidFwidth,
        sandPatchScale,
        sandPatchDrift,
        sandPatchThresholdLo,
        sandPatchThresholdHi,
        sandPatchTimeX,
        sandPatchTimeY,

        causticsEnabled,
        causticsIntensity,
        causticsBlendMode,
        causticsScale,
        causticsSpeed,
        causticsSharpness,
        causticsEdgeLo,
        causticsEdgeHi,
        causticsEdgeBlurTexels,
        causticsDebug,

        windFoamEnabled,
        windFoamIntensity,
        windFoamTiles,
        windFoamScale,
        windFoamSpeed,
        windFoamThreshold,
        windFoamSoftness,
        windFoamStreakiness,
        windFoamDepthLo,
        windFoamDepthHi,
        windFoamColor,

        gustFieldEnabled,
        gustFrontScale,
        gustFrontSpeed,
        gustFrontSharpness,
        gustPatchScale,
        gustPatchContrast,
        gustLocalBoost,

        windWhitecapsEnabled,
        whitecapIntensity,
        whitecapColor,
        whitecapColorMix,
        whitecapAdditive,

        chopEnabled,
        chopScaleBase,
        chopSpeedBase,
        gustChopBoost,

        waveWarpEnabled,
        waveWarpStrength,
        waveWarpScale,
        waveWarpSpeed,

        scumEnabled,
        scumIntensity,
        scumColor,
        scumScale,
        scumSpeed,
        scumThresholdLo,
        scumThresholdHi,

        shoreFoamEnabled,
        shoreFoamIntensity,
        shoreFoamColor,
        shoreFoamColorMix,
        shoreFoamScale,
        shoreFoamSpeed,
        shoreEdgeLo,
        shoreEdgeHi,

        shoreFoamBandLo,
        shoreFoamBandHi,
        shoreFoamWaterLo,
        shoreFoamWaterHi,
        shoreFoamBandPower,

        shoreFoamLayers,
        shoreFoamLayerScaleStep,
        shoreFoamLayerAdditive,
        shoreFoamBubbleSize,
        shoreFoamBubbleSoftness,
        shoreFoamOpacityVar,
        shoreFoamOpacityGamma,
        shoreFoamOpacityNoiseVar,
        shoreFoamWarp,
        shoreFoamWarpFreq,
        shoreFoamBreakup1Strength,
        shoreFoamBreakup1Scale,
        shoreFoamBreakup1Speed,
        shoreFoamBreakup1Threshold,
        shoreFoamBreakup1Softness,
        shoreFoamBreakup2Strength,
        shoreFoamBreakup2Scale,
        shoreFoamBreakup2Speed,
        shoreFoamBreakup2Threshold,
        shoreFoamBreakup2Softness,
        shoreFoamEbbStrength,
        shoreFoamEbbSpeed,
        shoreFoamEbbScale,

        windDirX,
        windDirY,
        windSpeed: windSpeed01,
        windAdvectFactor,
        windFoamPhase
      });
      dm.setSourceEnabled('water', true);
    }
  }

  render() {}

  dispose() {
    const dm = window.MapShine?.distortionManager;
    if (dm && this._sourceRegistered) {
      dm.unregisterSource('water');
    }
    this._sourceRegistered = false;

    if (dm && this._dmDebugOwned && dm.params) {
      dm.params.debugMode = this._dmPrevDebugMode;
      dm.params.debugShowMask = this._dmPrevDebugShowMask;
      this._dmDebugOwned = false;
    }

    super.dispose();
  }
}
