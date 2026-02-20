/**
 * @fileoverview Window Lighting & Shadows effect
 * Projects window light pools into interiors based on _Windows / _Structural masks.
 * Redesigned for reliability and softer, more natural light falloff.
 * 
 * @module effects/WindowLightEffect
 */

import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import { weatherController } from '../core/WeatherController.js';

const log = createLogger('WindowLightEffect');

export class WindowLightEffect extends EffectBase {
  constructor() {
    super('window-light', RenderLayers.SURFACE_EFFECTS, 'low');

    this.priority = 12; // After base material, alongside other surface overlays
    this.alwaysRender = false;

    this._enabled = true;

    /** @type {THREE.Mesh|null} */
    this.mesh = null;
    /** @type {THREE.Mesh|null} */
    this.baseMesh = null;

    /** @type {THREE.Texture|null} */
    this.windowMask = null;      // _Windows / _Structural
    /** @type {THREE.Texture|null} */
    this.outdoorsMask = null;    // _Outdoors
    /** @type {THREE.Texture|null} */
    this.specularMask = null;    // _Specular (optional)

    /** @type {THREE.ShaderMaterial|null} */
    this.material = null;

    this._bundleBaseTexture = null;

    /** @type {THREE.WebGLRenderTarget|null} */
    this.lightTarget = null; // Render target for window light brightness (used by TileManager)

    /** @type {THREE.Scene|null} */
    this.lightScene = null; // Separate scene for rendering light-only pass

    /** @type {THREE.Mesh|null} */
    this.lightMesh = null; // Mesh for light-only rendering

    /** @type {THREE.ShaderMaterial|null} */
    this.lightMaterial = null; // Material for light-only pass

    this._publishedWindowLightTex = null;

    this._rainFlowMap = null;
    this._rainFlowMapSourceUuid = null;
    this._rainFlowMapConfigKey = null;

    this.params = {
      // Status
      textureStatus: 'Searching...',
      hasWindowMask: undefined,

      // Core light controls
      intensity: 25,
      color: { r: 1.0, g: 0.96, b: 0.85 }, // Warm window light
      
      // Mask shaping (Gamma/Gain model)
      falloff: 5, // Gamma power for falloff shaping

      // Environment
      cloudInfluence: 1.0,     // How much clouds dim the light (0-1)
      nightDimming: 1,       // How much night dims the light (0-1)

      useSkyTint: true,
      skyTintStrength: 3.62,

      // Cloud shadow shaping (applied to cloudShadowRaw.screen before influence/cover mix)
      cloudShadowContrast: 4.0,
      cloudShadowBias: 0.05,
      cloudShadowGamma: 2.28,
      cloudShadowMinLight: 0.0,

      // Specular coupling
      specularBoost: 5.0,

      // RGB Split (Refraction)
      rgbShiftAmount: 1.9,  // pixels
      rgbShiftAngle: 76.0, // degrees

      // Overhead tile lighting
      lightOverheadTiles: true,
      overheadLightIntensity: 1.0,

      rainOnGlassEnabled: true,
      rainOnGlassIntensity: 1.0,
      rainOnGlassPrecipStart: 0.15,
      rainOnGlassPrecipFull: 0.7,

      rainOnGlassSpeed: 0.35,
      rainOnGlassDirectionDeg: 270.0,
      rainOnGlassMaxOffsetPx: 1.25,
      rainOnGlassBlurPx: 0.0,
      rainOnGlassDistortionFeatherPx: 0.0,
      rainOnGlassDistortionMasking: 1.0,
      rainOnGlassDarken: 0.25,
      rainOnGlassDarkenGamma: 1.25,

      rainSplashIntensity: 0.0,
      rainSplashMaxOffsetPx: 0.75,
      rainSplashScale: 40.0,
      rainSplashMaskScale: 6.0,
      rainSplashThreshold: 0.75,
      rainSplashMaskThreshold: 0.5,
      rainSplashMaskFeather: 0.15,
      rainSplashSpeed: 0.5,
      rainSplashSpawnRate: 1.0,
      rainSplashRadiusPx: 6.0,
      rainSplashExpand: 2.0,
      rainSplashFadePow: 2.0,

      rainSplashLayers: 1.0,
      rainSplashDriftPx: 18.0,
      rainSplashSizeJitter: 0.5,
      rainSplashBlob: 0.5,
      rainSplashStreakStrength: 0.35,
      rainSplashStreakLengthPx: 24.0,

      rainSplashAtlasTile0: true,
      rainSplashAtlasTile1: true,
      rainSplashAtlasTile2: true,
      rainSplashAtlasTile3: true,

      rainNoiseScale: 2.0,
      rainNoiseDetail: 2.0,
      rainNoiseEvolution: 0.35,
      rainRivuletAspect: 3.0,

      rainRivuletGain: 1.0,
      rainRivuletStrength: 1.0,
      rainRivuletThreshold: 0.5,
      rainRivuletFeather: 0.25,
      rainRivuletGamma: 1.0,

      rainRivuletSoftness: 0.0,

      rainRivuletDistanceMasking: 0.0,
      rainRivuletDistanceStart: 0.0,
      rainRivuletDistanceEnd: 1.0,
      rainRivuletDistanceFeather: 0.1,

      rainRivuletRidgeMix: 0.0,
      rainRivuletRidgeGain: 1.0,

      rainFlowFlipDeadzone: 0.15,
      rainFlowMaxTurnDeg: 180.0,

      rainOnGlassBoundaryFlowStrength: 1.0,
      rainFlowWidth: 0.25,
      rainDebugFlowMap: false,

      rainDebugRoofPlateau: false,

      rainRoofPlateauStrength: 0.0,
      rainRoofPlateauStart: 0.4,
      rainRoofPlateauFeather: 0.1,

      rainFlowMapMaxDim: 512,
      rainFlowMapMinDim: 64,
      rainFlowMapObstacleThreshold: 0.5,
      rainFlowMapObstacleInvert: false,
      rainFlowMapBoundaryMaxPx: 256,
      rainFlowMapDistanceGamma: 1.0,
      rainFlowMapDistanceScale: 1.0,
      rainFlowMapRelaxIterations: 4,
      rainFlowMapRelaxKernel: 1,
      rainFlowMapRelaxMix: 1.0,
      rainFlowMapDefaultX: 0.0,
      rainFlowMapDefaultY: 1.0,

      rainOnGlassBrightThreshold: 0.5,
      rainOnGlassBrightFeather: 0.1,

      rainFlowInvertTangent: false,
      rainFlowInvertNormal: false,
      rainFlowSwapAxes: false,
      rainFlowAdvectScale: 1.0,
      rainFlowEvoScale: 1.0,
      rainFlowPerpScale: 1.0,
      rainFlowGlobalInfluence: 1.0,
      rainFlowAngleOffset: 0.0,

      lightningWindowEnabled: true,
      lightningWindowIntensityBoost: 1.0,
      lightningWindowContrastBoost: 1.75,
      lightningWindowRgbBoost: 0.35,

      // Sun-tracking offset: shifts the window light pool based on sun position
      sunLightEnabled: false,
      sunLightLength: 0.03,
      sunLightLatitude: 0.1
    };

    this._tmpRainDir = null;
    this._tmpWindDir = null;
    /** @type {THREE.Vector2|null} Cached sun direction for window light offset */
    this._sunDir = null;

    /** @type {Array<function>} Unsubscribe functions from EffectMaskRegistry */
    this._registryUnsubs = [];
  }

  _applyThreeColor(target, input) {
    const THREE = window.THREE;
    if (!THREE || !target) return;
    if (input && typeof input === 'object' && 'r' in input && 'g' in input && 'b' in input) {
      target.set(input.r, input.g, input.b);
      return;
    }
    if (typeof input === 'string' || typeof input === 'number') {
      target.set(input);
      return;
    }
    target.set(1.0, 1.0, 1.0);
  }

  get enabled() {
    return this._enabled;
  }

  set enabled(value) {
    const next = !!value;
    this._enabled = next;
    if (this.mesh) this.mesh.visible = next;

    // Ensure downstream systems cannot keep using a stale light texture.
    if (!next) {
      try {
        const mm = window.MapShine?.maskManager;
        if (mm && typeof mm.setTexture === 'function') {
          mm.setTexture('windowLight.screen', null);
        }
        this._publishedWindowLightTex = null;
      } catch (e) {
      }
    }
  }

  /**
   * UI schema for Tweakpane
   */
  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'status',
          label: 'Effect Status',
          type: 'inline',
          parameters: ['textureStatus']
        },
        {
          name: 'lighting',
          label: 'Window Light',
          type: 'folder',
          expanded: true,
          parameters: ['intensity', 'falloff', 'color']
        },
        {
          name: 'sunTracking',
          label: 'Sun Tracking',
          type: 'folder',
          expanded: false,
          parameters: ['sunLightEnabled', 'sunLightLength']
        },
        {
          name: 'environment',
          label: 'Environment',
          type: 'folder',
          expanded: false,
          parameters: ['cloudInfluence', 'nightDimming', 'useSkyTint', 'skyTintStrength']
        },
        {
          name: 'cloudShadows',
          label: 'Cloud Shadows',
          type: 'folder',
          expanded: false,
          parameters: ['cloudShadowContrast', 'cloudShadowBias', 'cloudShadowGamma', 'cloudShadowMinLight']
        },
        {
          name: 'refraction',
          label: 'Refraction (RGB)',
          type: 'folder',
          expanded: false,
          parameters: ['rgbShiftAmount', 'rgbShiftAngle']
        },
        {
          name: 'overheads',
          label: 'Overhead Tile Lighting',
          type: 'folder',
          expanded: false,
          parameters: ['lightOverheadTiles', 'overheadLightIntensity']
        },
        {
          name: 'specular',
          label: 'Specular Coupling',
          type: 'folder',
          expanded: false,
          parameters: ['specularBoost']
        },
        {
          name: 'rainCore',
          label: 'Rain On Glass (Core)',
          type: 'folder',
          expanded: true,
          parameters: [
            'rainOnGlassEnabled',
            'rainOnGlassIntensity',
            'rainOnGlassPrecipStart',
            'rainOnGlassPrecipFull',
            'rainOnGlassSpeed',
            'rainOnGlassDirectionDeg'
          ]
        },
        {
          name: 'rainNoise',
          label: 'Rain On Glass (Noise & Rivulets)',
          type: 'folder',
          expanded: true,
          parameters: [
            'rainNoiseScale',
            'rainNoiseDetail',
            'rainNoiseEvolution',
            'rainRivuletAspect',
            'rainRivuletGain',
            'rainRivuletStrength',
            'rainRivuletThreshold',
            'rainRivuletFeather',
            'rainRivuletGamma',
            'rainRivuletSoftness',
            'rainRivuletRidgeMix',
            'rainRivuletRidgeGain'
          ]
        },
        {
          name: 'rainDistortion',
          label: 'Rain On Glass (Distortion & Darken)',
          type: 'folder',
          expanded: false,
          parameters: [
            'rainOnGlassMaxOffsetPx',
            'rainOnGlassBlurPx',
            'rainOnGlassDistortionFeatherPx',
            'rainOnGlassDistortionMasking',
            'rainOnGlassDarken',
            'rainOnGlassDarkenGamma',
            'rainOnGlassBrightThreshold',
            'rainOnGlassBrightFeather'
          ]
        },
        {
          name: 'rainBoundaryFlow',
          label: 'Rain On Glass (Boundary Flow)',
          type: 'folder',
          expanded: false,
          parameters: [
            'rainOnGlassBoundaryFlowStrength',
            'rainFlowWidth',
            'rainRoofPlateauStrength',
            'rainRoofPlateauStart',
            'rainRoofPlateauFeather',
            'rainRivuletDistanceMasking',
            'rainRivuletDistanceStart',
            'rainRivuletDistanceEnd',
            'rainRivuletDistanceFeather'
          ]
        },
        {
          name: 'rainSplashesCore',
          label: 'Rain Splashes (Core)',
          type: 'folder',
          expanded: false,
          parameters: [
            'rainSplashIntensity',
            'rainSplashSpawnRate',
            'rainSplashSpeed',
            'rainSplashLayers'
          ]
        },
        {
          name: 'rainSplashesShape',
          label: 'Rain Splashes (Shape)',
          type: 'folder',
          expanded: false,
          parameters: [
            'rainSplashScale',
            'rainSplashThreshold',
            'rainSplashMaskScale',
            'rainSplashMaskThreshold',
            'rainSplashMaskFeather',
            'rainSplashRadiusPx',
            'rainSplashExpand',
            'rainSplashFadePow',
            'rainSplashMaxOffsetPx'
          ]
        },
        {
          name: 'rainSplashesDrift',
          label: 'Rain Splashes (Drift & Streaks)',
          type: 'folder',
          expanded: false,
          parameters: [
            'rainSplashDriftPx',
            'rainSplashSizeJitter',
            'rainSplashBlob',
            'rainSplashStreakStrength',
            'rainSplashStreakLengthPx',
            'rainSplashAtlasTile0',
            'rainSplashAtlasTile1',
            'rainSplashAtlasTile2',
            'rainSplashAtlasTile3'
          ]
        },
        {
          name: 'rainFlowDirection',
          label: 'Flow Map (Direction & Motion)',
          type: 'folder',
          expanded: false,
          parameters: [
            'rainFlowFlipDeadzone',
            'rainFlowMaxTurnDeg',
            'rainFlowInvertTangent',
            'rainFlowInvertNormal',
            'rainFlowSwapAxes',
            'rainFlowAdvectScale',
            'rainFlowEvoScale',
            'rainFlowPerpScale',
            'rainFlowGlobalInfluence',
            'rainFlowAngleOffset'
          ]
        },
        {
          name: 'rainFlowMapGen',
          label: 'Flow Map (Generation)',
          type: 'folder',
          expanded: false,
          parameters: [
            'rebuildRainFlowMap',
            'rainFlowMapMaxDim',
            'rainFlowMapMinDim',
            'rainFlowMapObstacleThreshold',
            'rainFlowMapObstacleInvert',
            'rainFlowMapBoundaryMaxPx',
            'rainFlowMapDistanceGamma',
            'rainFlowMapDistanceScale',
            'rainFlowMapRelaxIterations',
            'rainFlowMapRelaxKernel',
            'rainFlowMapRelaxMix',
            'rainFlowMapDefaultX',
            'rainFlowMapDefaultY'
          ]
        },
        {
          name: 'rainDebug',
          label: 'Rain Debug',
          type: 'folder',
          expanded: false,
          parameters: [
            'rainDebugRoofPlateau',
            'rainDebugFlowMap'
          ]
        },
        {
          name: 'lightning',
          label: 'Lightning Flash (Window)',
          type: 'folder',
          expanded: false,
          parameters: ['lightningWindowEnabled', 'lightningWindowIntensityBoost', 'lightningWindowContrastBoost', 'lightningWindowRgbBoost']
        },
      ],
      parameters: {
        hasWindowMask: {
          type: 'boolean',
          default: true,
          hidden: true
        },
        textureStatus: {
          type: 'string',
          label: 'Mask Status',
          default: 'Checking...',
          readonly: true
        },
        intensity: {
          type: 'slider',
          label: 'Intensity',
          min: 0.0,
          max: 25.0,
          step: 0.1,
          default: 25
        },
        falloff: {
          type: 'slider',
          label: 'Falloff (Gamma)',
          min: 0.1,
          max: 5.0,
          step: 0.1,
          default: 5
        },
        color: {
          type: 'color',
          label: 'Light Color',
          default: { r: 1.0, g: 0.96, b: 0.85 }
        },
        cloudInfluence: {
          type: 'slider',
          label: 'Cloud Dimming',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 1.0
        },
        nightDimming: {
          type: 'slider',
          label: 'Night Dimming',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 1
        },
        useSkyTint: {
          type: 'boolean',
          label: 'Use Sky Tint',
          default: true
        },
        skyTintStrength: {
          type: 'slider',
          label: 'Sky Tint Strength',
          min: 0.0,
          max: 25.0,
          step: 0.01,
          default: 3.62
        },
        cloudShadowContrast: {
          type: 'slider',
          label: 'Shadow Contrast',
          min: 0.0,
          max: 4.0,
          step: 0.01,
          default: 4.0
        },
        cloudShadowBias: {
          type: 'slider',
          label: 'Shadow Bias',
          min: -1.0,
          max: 1.0,
          step: 0.01,
          default: 0.05
        },
        cloudShadowGamma: {
          type: 'slider',
          label: 'Shadow Gamma',
          min: 0.1,
          max: 4.0,
          step: 0.01,
          default: 2.28
        },
        cloudShadowMinLight: {
          type: 'slider',
          label: 'Min Light',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.0
        },
        rgbShiftAmount: {
          type: 'slider',
          label: 'RGB Shift',
          min: 0.0,
          max: 12.0,
          step: 0.01,
          default: 1.9
        },
        rgbShiftAngle: {
          type: 'slider',
          label: 'Angle (deg)',
          min: 0.0,
          max: 360.0,
          step: 1.0,
          default: 76.0
        },
        specularBoost: {
          type: 'slider',
          label: 'Specular Boost',
          min: 0.0,
          max: 5.0,
          step: 0.1,
          default: 5.0
        },
        lightOverheadTiles: {
          type: 'boolean',
          label: 'Light Overheads',
          default: true
        },
        overheadLightIntensity: {
          type: 'slider',
          label: 'Overhead Intensity',
          min: 0.0,
          max: 1.0,
          step: 0.05,
          default: 1.0
        },

        rainOnGlassEnabled: {
          type: 'boolean',
          label: 'Enabled',
          default: true
        },
        rainOnGlassIntensity: {
          type: 'slider',
          label: 'Intensity',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 1.0
        },
        rainOnGlassPrecipStart: {
          type: 'slider',
          label: 'Precip Start',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.15
        },
        rainOnGlassPrecipFull: {
          type: 'slider',
          label: 'Precip Full',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.7
        },
        rainOnGlassSpeed: {
          type: 'slider',
          label: 'Downflow Speed',
          min: 0.0,
          max: 15.0,
          step: 0.01,
          default: 0.35
        },
        rainOnGlassDirectionDeg: {
          type: 'slider',
          label: 'Direction (deg)',
          min: 0.0,
          max: 360.0,
          step: 1.0,
          default: 270.0,
          hidden: false
        },
        rainNoiseScale: {
          type: 'slider',
          label: 'Noise Scale',
          min: 0.1,
          max: 10.0,
          step: 0.05,
          default: 2.0
        },
        rainNoiseDetail: {
          type: 'slider',
          label: 'Noise Detail',
          min: 0.0,
          max: 6.0,
          step: 0.1,
          default: 2.0
        },
        rainNoiseEvolution: {
          type: 'slider',
          label: 'Noise Evolution',
          min: 0.0,
          max: 15.0,
          step: 0.01,
          default: 0.35
        },
        rainRivuletAspect: {
          type: 'slider',
          label: 'Rivulet Aspect',
          min: 1.0,
          max: 50.0,
          step: 0.05,
          default: 3.0
        },
        rainRivuletGain: {
          type: 'slider',
          label: 'Rivulet Gain',
          min: 0.0,
          max: 4.0,
          step: 0.01,
          default: 1.0
        },
        rainRivuletStrength: {
          type: 'slider',
          label: 'Rivulet Strength',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 1.0
        },
        rainRivuletThreshold: {
          type: 'slider',
          label: 'Rivulet Threshold',
          min: 0.0,
          max: 1.0,
          step: 0.001,
          default: 0.5
        },
        rainRivuletFeather: {
          type: 'slider',
          label: 'Rivulet Feather',
          min: 0.0,
          max: 1.0,
          step: 0.001,
          default: 0.25
        },
        rainRivuletGamma: {
          type: 'slider',
          label: 'Rivulet Gamma',
          min: 0.1,
          max: 4.0,
          step: 0.01,
          default: 1.0
        },
        rainRivuletSoftness: {
          type: 'slider',
          label: 'Rivulet Softness',
          min: 0.0,
          max: 15.0,
          step: 0.001,
          default: 0.0
        },
        rainRivuletRidgeMix: {
          type: 'slider',
          label: 'Ridge Mix',
          min: 0.0,
          max: 1.0,
          step: 0.001,
          default: 0.0
        },
        rainRivuletRidgeGain: {
          type: 'slider',
          label: 'Ridge Gain',
          min: 0.0,
          max: 8.0,
          step: 0.01,
          default: 1.0
        },
        rainSplashAtlasTile0: { type: 'boolean', label: 'Splash Tile 0', default: true },
        rainSplashAtlasTile1: { type: 'boolean', label: 'Splash Tile 1', default: true },
        rainSplashAtlasTile2: { type: 'boolean', label: 'Splash Tile 2', default: true },
        rainSplashAtlasTile3: { type: 'boolean', label: 'Splash Tile 3', default: true },
        rainFlowFlipDeadzone: {
          type: 'slider',
          label: 'Flip Deadzone',
          min: 0.0,
          max: 0.5,
          step: 0.001,
          default: 0.15
        },
        rainFlowMaxTurnDeg: {
          type: 'slider',
          label: 'Max Turn (deg)',
          min: 0.0,
          max: 180.0,
          step: 1.0,
          default: 180.0
        },
        rainOnGlassBoundaryFlowStrength: {
          type: 'slider',
          label: 'Boundary Flow Strength',
          min: 0.0,
          max: 25.0,
          step: 0.01,
          default: 1.0
        },
        rainFlowWidth: {
          type: 'slider',
          label: 'Flow Width',
          min: 0.0,
          max: 5.0,
          step: 0.01,
          default: 0.25
        },
        rainRoofPlateauStrength: {
          type: 'slider',
          label: 'Roof Plateau Strength',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.0
        },
        rainRoofPlateauStart: {
          type: 'slider',
          label: 'Roof Plateau Start',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.4
        },
        rainRoofPlateauFeather: {
          type: 'slider',
          label: 'Roof Plateau Feather',
          min: 0.0,
          max: 1.0,
          step: 0.001,
          default: 0.1
        },
        rainRivuletDistanceMasking: {
          type: 'slider',
          label: 'Rivulet Distance Masking',
          min: 0.0,
          max: 1.0,
          step: 0.001,
          default: 0.0
        },
        rainRivuletDistanceStart: {
          type: 'slider',
          label: 'Rivulet Distance Start',
          min: 0.0,
          max: 1.0,
          step: 0.001,
          default: 0.0
        },
        rainRivuletDistanceEnd: {
          type: 'slider',
          label: 'Rivulet Distance End',
          min: 0.0,
          max: 1.0,
          step: 0.001,
          default: 1.0
        },
        rainRivuletDistanceFeather: {
          type: 'slider',
          label: 'Rivulet Distance Feather',
          min: 0.0,
          max: 0.5,
          step: 0.001,
          default: 0.1
        },
        rainDebugRoofPlateau: {
          type: 'boolean',
          label: 'Debug Roof Plateau',
          default: false
        },
        rainFlowMapMaxDim: {
          type: 'slider',
          label: 'Max Dim',
          min: 32,
          max: 2048,
          step: 1,
          default: 512
        },
        rainFlowMapMinDim: {
          type: 'slider',
          label: 'Min Dim',
          min: 8,
          max: 1024,
          step: 1,
          default: 64
        },
        rainFlowMapObstacleThreshold: {
          type: 'slider',
          label: 'Obstacle Threshold',
          min: 0.0,
          max: 1.0,
          step: 0.001,
          default: 0.5
        },
        rebuildRainFlowMap: {
          type: 'button',
          title: 'Rebuild Flow Map',
          label: 'Rebuild'
        },
        rainFlowMapObstacleInvert: {
          type: 'boolean',
          label: 'Invert Obstacles',
          default: false
        },
        rainFlowMapBoundaryMaxPx: {
          type: 'slider',
          label: 'Boundary Max (px)',
          min: 1,
          max: 4096,
          step: 1,
          default: 256
        },
        rainFlowMapDistanceGamma: {
          type: 'slider',
          label: 'Distance Gamma',
          min: 0.01,
          max: 10.0,
          step: 0.01,
          default: 1.0
        },
        rainFlowMapDistanceScale: {
          type: 'slider',
          label: 'Distance Scale',
          min: 0.0,
          max: 10.0,
          step: 0.01,
          default: 1.0
        },
        rainFlowMapRelaxIterations: {
          type: 'slider',
          label: 'Relax Iterations',
          min: 0,
          max: 100,
          step: 1,
          default: 4
        },
        rainFlowMapRelaxKernel: {
          type: 'slider',
          label: 'Relax Kernel',
          min: 0,
          max: 8,
          step: 1,
          default: 1
        },
        rainFlowMapRelaxMix: {
          type: 'slider',
          label: 'Relax Mix',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 1.0
        },
        rainFlowMapDefaultX: {
          type: 'slider',
          label: 'Default Flow X',
          min: -1.0,
          max: 1.0,
          step: 0.01,
          default: 0.0
        },
        rainFlowMapDefaultY: {
          type: 'slider',
          label: 'Default Flow Y',
          min: -1.0,
          max: 1.0,
          step: 0.01,
          default: 1.0
        },
        rainDebugFlowMap: {
          type: 'boolean',
          label: 'Debug Flow Map',
          default: false
        },
        rainOnGlassMaxOffsetPx: {
          type: 'slider',
          label: 'Max Offset (px)',
          min: 0.0,
          max: 8.0,
          step: 0.05,
          default: 1.25
        },
        rainOnGlassBlurPx: {
          type: 'slider',
          label: 'Blur (px)',
          min: 0.0,
          max: 80.0,
          step: 0.05,
          default: 0.0
        },
        rainOnGlassDistortionFeatherPx: {
          type: 'slider',
          label: 'Distortion Feather (px)',
          min: 0.0,
          max: 32.0,
          step: 0.25,
          default: 0.0
        },
        rainOnGlassDistortionMasking: {
          type: 'slider',
          label: 'Distortion Masking',
          min: 0.0,
          max: 1.0,
          step: 0.001,
          default: 1.0
        },
        rainOnGlassDarken: {
          type: 'slider',
          label: 'Darken',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.25
        },
        rainOnGlassDarkenGamma: {
          type: 'slider',
          label: 'Darken Gamma',
          min: 0.1,
          max: 4.0,
          step: 0.01,
          default: 1.25
        },
        rainSplashIntensity: {
          type: 'slider',
          label: 'Intensity',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 0.0
        },
        rainSplashMaxOffsetPx: {
          type: 'slider',
          label: 'Max Offset (px)',
          min: 0.0,
          max: 10.0,
          step: 0.01,
          default: 0.75
        },
        rainSplashScale: {
          type: 'slider',
          label: 'Sharp Noise Scale',
          min: 0.1,
          max: 250.0,
          step: 0.1,
          default: 40.0
        },
        rainSplashMaskScale: {
          type: 'slider',
          label: 'Mask Noise Scale',
          min: 0.1,
          max: 100.0,
          step: 0.1,
          default: 6.0
        },
        rainSplashThreshold: {
          type: 'slider',
          label: 'Sharp Threshold',
          min: 0.0,
          max: 1.0,
          step: 0.001,
          default: 0.75
        },
        rainSplashMaskThreshold: {
          type: 'slider',
          label: 'Mask Threshold',
          min: 0.0,
          max: 1.0,
          step: 0.001,
          default: 0.5
        },
        rainSplashMaskFeather: {
          type: 'slider',
          label: 'Mask Feather',
          min: 0.0,
          max: 1.0,
          step: 0.001,
          default: 0.15
        },
        rainSplashSpeed: {
          type: 'slider',
          label: 'Speed',
          min: 0.0,
          max: 10.0,
          step: 0.01,
          default: 0.5
        },
        rainSplashSpawnRate: {
          type: 'slider',
          label: 'Spawn Rate',
          min: 0.1,
          max: 50.0,
          step: 0.1,
          default: 1.0
        },
        rainSplashRadiusPx: {
          type: 'slider',
          label: 'Radius (px)',
          min: 0.0,
          max: 64.0,
          step: 0.1,
          default: 6.0
        },
        rainSplashExpand: {
          type: 'slider',
          label: 'Expand',
          min: 1.0,
          max: 8.0,
          step: 0.01,
          default: 2.0
        },
        rainSplashFadePow: {
          type: 'slider',
          label: 'Fade Power',
          min: 0.25,
          max: 8.0,
          step: 0.01,
          default: 2.0
        },
        rainSplashLayers: {
          type: 'slider',
          label: 'Layers',
          min: 1.0,
          max: 3.0,
          step: 1.0,
          default: 1.0
        },
        rainSplashDriftPx: {
          type: 'slider',
          label: 'Drift (px)',
          min: 0.0,
          max: 128.0,
          step: 0.5,
          default: 18.0
        },
        rainSplashSizeJitter: {
          type: 'slider',
          label: 'Size Jitter',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.5
        },
        rainSplashBlob: {
          type: 'slider',
          label: 'Blob',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.5
        },
        rainSplashStreakStrength: {
          type: 'slider',
          label: 'Streak Strength',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 0.35
        },
        rainSplashStreakLengthPx: {
          type: 'slider',
          label: 'Streak Length (px)',
          min: 0.0,
          max: 96.0,
          step: 0.5,
          default: 24.0
        },
        rainOnGlassBrightThreshold: {
          type: 'slider',
          label: 'Bright Mask Threshold',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.5
        },
        rainOnGlassBrightFeather: {
          type: 'slider',
          label: 'Bright Mask Feather',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.1
        },
        rainFlowInvertTangent: {
          type: 'boolean',
          label: 'Invert Tangent',
          default: false
        },
        rainFlowInvertNormal: {
          type: 'boolean',
          label: 'Invert Normal',
          default: false
        },
        rainFlowSwapAxes: {
          type: 'boolean',
          label: 'Swap XY Axes',
          default: false
        },
        rainFlowAdvectScale: {
          type: 'slider',
          label: 'Advect Scale',
          min: -2.0,
          max: 2.0,
          step: 0.01,
          default: 1.0
        },
        rainFlowEvoScale: {
          type: 'slider',
          label: 'Evolution Scale',
          min: -2.0,
          max: 2.0,
          step: 0.01,
          default: 1.0
        },
        rainFlowPerpScale: {
          type: 'slider',
          label: 'Perpendicular Scale',
          min: -2.0,
          max: 2.0,
          step: 0.01,
          default: 1.0
        },
        rainFlowGlobalInfluence: {
          type: 'slider',
          label: 'Global Influence',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 1.0
        },
        rainFlowAngleOffset: {
          type: 'slider',
          label: 'Angle Offset',
          min: -180.0,
          max: 180.0,
          step: 1.0,
          default: 0.0
        },

        sunLightEnabled: {
          type: 'boolean',
          label: 'Enable Sun Tracking',
          default: false,
          tooltip: 'Shift the window light pool based on sun position (time of day)'
        },
        sunLightLength: {
          type: 'slider',
          label: 'Light Shift Length',
          min: 0.0,
          max: 0.3,
          step: 0.005,
          default: 0.03,
          tooltip: 'How far the window light shifts with the sun position'
        },
        lightningWindowEnabled: {
          type: 'boolean',
          label: 'Enabled',
          default: true
        },
        lightningWindowIntensityBoost: {
          type: 'slider',
          label: 'Intensity Boost',
          min: 0.0,
          max: 5.0,
          step: 0.05,
          default: 1.0
        },
        lightningWindowContrastBoost: {
          type: 'slider',
          label: 'Contrast Boost',
          min: 0.0,
          max: 5.0,
          step: 0.05,
          default: 1.75
        },
        lightningWindowRgbBoost: {
          type: 'slider',
          label: 'RGB Boost',
          min: 0.0,
          max: 3.0,
          step: 0.05,
          default: 0.35
        }
      }
    };
  }

  /**
   * Initialize effect
   */
  initialize(renderer, scene, camera) {
    this.scene = scene;
    this.renderer = renderer;
    this.camera = camera;
    log.info('Initializing WindowLightEffect (Redesigned)');
  }

  /**
   * Set the base mesh and load assets
   * @param {THREE.Mesh} baseMesh
   * @param {MapAssetBundle} assetBundle
   */
  setBaseMesh(baseMesh, assetBundle) {
    this.baseMesh = baseMesh;

    this._bundleBaseTexture = assetBundle?.baseTexture || null;

    const windowData = assetBundle.masks.find(m => m.id === 'windows' || m.id === 'structural');
    const outdoorsData = assetBundle.masks.find(m => m.id === 'outdoors');
    const specularData = assetBundle.masks.find(m => m.id === 'specular');

    this.windowMask = windowData?.texture || null;
    this.outdoorsMask = outdoorsData?.texture || null;
    this.specularMask = specularData?.texture || null;

    this.params.hasWindowMask = !!this.windowMask;

    if (!this.windowMask) {
      this.params.textureStatus = 'Inactive (No _Windows / _Structural mask found)';
      log.info('No window/structural mask found, WindowLightEffect disabled');
      this.enabled = false;
      return;
    }

    // Re-enable when a valid mask is found. Without this, the effect stays
    // permanently disabled after visiting a floor with no _Windows mask.
    this.enabled = true;

    this.params.textureStatus = 'Ready (Texture Found)';
    log.info('Window mask loaded');

    // If the material already exists (redistribution after level change),
    // push the new mask textures into the existing uniforms so the shader
    // sees the updated masks without a full mesh rebuild.
    if (this.material?.uniforms) {
      const u = this.material.uniforms;
      if (u.uWindowMask) u.uWindowMask.value = this.windowMask;
      if (u.uOutdoorsMask) u.uOutdoorsMask.value = this.outdoorsMask;
      if (u.uSpecularMask) u.uSpecularMask.value = this.specularMask;
      if (u.uHasOutdoorsMask) u.uHasOutdoorsMask.value = this.outdoorsMask ? 1.0 : 0.0;
      if (u.uHasSpecularMask) u.uHasSpecularMask.value = this.specularMask ? 1.0 : 0.0;
      if (u.uWindowTexelSize && this.windowMask?.image) {
        u.uWindowTexelSize.value.set(
          1 / this.windowMask.image.width,
          1 / this.windowMask.image.height
        );
      }
      this.material.needsUpdate = true;
    }

    // Also update the light-pass material if it exists (used by TileManager).
    if (this.lightMaterial?.uniforms) {
      const lu = this.lightMaterial.uniforms;
      if (lu.uWindowMask) lu.uWindowMask.value = this.windowMask;
      if (lu.uOutdoorsMask) lu.uOutdoorsMask.value = this.outdoorsMask;
      if (lu.uHasOutdoorsMask) lu.uHasOutdoorsMask.value = this.outdoorsMask ? 1.0 : 0.0;
      this.lightMaterial.needsUpdate = true;
    }

    // If no mesh exists yet (first time receiving a valid mask after init),
    // create the overlay mesh now so the effect becomes visible.
    if (!this.mesh && this.scene && this.baseMesh) {
      this.createOverlayMesh();
    }

    this._ensureRainFlowMap();
  }

  /**
   * Subscribe to the EffectMaskRegistry for 'windows', 'outdoors', and 'specular' mask updates.
   * @param {import('../assets/EffectMaskRegistry.js').EffectMaskRegistry} registry
   */
  connectToRegistry(registry) {
    for (const unsub of this._registryUnsubs) unsub();
    this._registryUnsubs = [];

    // Helper to push updated mask textures into existing material uniforms
    const pushMask = () => {
      if (this.material?.uniforms) {
        const u = this.material.uniforms;
        if (u.uWindowMask) u.uWindowMask.value = this.windowMask;
        if (u.uOutdoorsMask) u.uOutdoorsMask.value = this.outdoorsMask;
        if (u.uSpecularMask) u.uSpecularMask.value = this.specularMask;
        if (u.uHasOutdoorsMask) u.uHasOutdoorsMask.value = this.outdoorsMask ? 1.0 : 0.0;
        if (u.uHasSpecularMask) u.uHasSpecularMask.value = this.specularMask ? 1.0 : 0.0;
        if (u.uWindowTexelSize && this.windowMask?.image) {
          u.uWindowTexelSize.value.set(
            1 / this.windowMask.image.width,
            1 / this.windowMask.image.height
          );
        }
        this.material.needsUpdate = true;
      }
      if (this.lightMaterial?.uniforms) {
        const lu = this.lightMaterial.uniforms;
        if (lu.uWindowMask) lu.uWindowMask.value = this.windowMask;
        if (lu.uOutdoorsMask) lu.uOutdoorsMask.value = this.outdoorsMask;
        if (lu.uHasOutdoorsMask) lu.uHasOutdoorsMask.value = this.outdoorsMask ? 1.0 : 0.0;
        this.lightMaterial.needsUpdate = true;
      }
    };

    this._registryUnsubs.push(
      registry.subscribe('windows', (texture) => {
        this.windowMask = texture;
        this.params.hasWindowMask = !!texture;
        if (!texture) {
          this.params.textureStatus = 'Inactive (No _Windows / _Structural mask found)';
          this.enabled = false;
          return;
        }
        this.params.textureStatus = 'Ready (Texture Found)';
        this.enabled = true;
        pushMask();
        if (!this.mesh && this.scene && this.baseMesh) this.createOverlayMesh();
        this._ensureRainFlowMap();
      }),
      registry.subscribe('outdoors', (texture) => {
        this.outdoorsMask = texture;
        pushMask();
        this._ensureRainFlowMap();
      }),
      registry.subscribe('specular', (texture) => {
        this.specularMask = texture;
        pushMask();
      })
    );
  }

  _ensureRainFlowMap() {
    const THREE = window.THREE;
    const srcTex = this.outdoorsMask;
    const img = srcTex?.image;
    // Bumped version to force regeneration with new relaxation logic
    const FLOW_MAP_VERSION = 10; 
    
    if (!THREE || !srcTex || !img) {
      if (this._rainFlowMap) {
        try { this._rainFlowMap.dispose(); } catch (e) {}
      }
      this._rainFlowMap = null;
      this._rainFlowMapSourceUuid = null;
      this._rainFlowMapConfigKey = null;

      try {
        const mm = window.MapShine?.maskManager;
        if (mm && typeof mm.setTexture === 'function') {
          mm.setTexture('rainFlowMap.scene', null);
        }
      } catch (e) {
      }
      return;
    }

    const maxDim = Math.max(1, Math.floor(this.params.rainFlowMapMaxDim ?? 512));
    const minDim = Math.max(1, Math.floor(this.params.rainFlowMapMinDim ?? 64));
    const obstacleThreshold = Math.max(0.0, Math.min(1.0, (this.params.rainFlowMapObstacleThreshold ?? 0.5)));
    const obstacleInvert = !!this.params.rainFlowMapObstacleInvert;
    const boundaryMaxPx = Math.max(1, Math.floor(this.params.rainFlowMapBoundaryMaxPx ?? 256));
    const distGamma = Math.max(0.0001, (this.params.rainFlowMapDistanceGamma ?? 1.0));
    const distScale = Math.max(0.0, (this.params.rainFlowMapDistanceScale ?? 1.0));
    const relaxationIterations = Math.max(0, Math.floor(this.params.rainFlowMapRelaxIterations ?? 4));
    const kernel = Math.max(0, Math.floor(this.params.rainFlowMapRelaxKernel ?? 1));
    const relaxMix = Math.max(0.0, (this.params.rainFlowMapRelaxMix ?? 1.0));
    const defaultX = (typeof this.params.rainFlowMapDefaultX === 'number' && Number.isFinite(this.params.rainFlowMapDefaultX)) ? this.params.rainFlowMapDefaultX : 0.0;
    const defaultY = (typeof this.params.rainFlowMapDefaultY === 'number' && Number.isFinite(this.params.rainFlowMapDefaultY)) ? this.params.rainFlowMapDefaultY : 1.0;

    const plateauStrength = Math.max(0.0, Math.min(1.0, (this.params.rainRoofPlateauStrength ?? 0.0)));
    const plateauStart = Math.max(0.0, Math.min(1.0, (this.params.rainRoofPlateauStart ?? 0.4)));
    const plateauFeather = Math.max(0.0, Math.min(1.0, (this.params.rainRoofPlateauFeather ?? 0.1)));

    const cfgKey = [
      FLOW_MAP_VERSION,
      srcTex.uuid,
      maxDim,
      minDim,
      obstacleThreshold.toFixed(4),
      obstacleInvert ? 1 : 0,
      boundaryMaxPx,
      distGamma.toFixed(4),
      distScale.toFixed(4),
      relaxationIterations,
      kernel,
      relaxMix.toFixed(4),
      defaultX.toFixed(4),
      defaultY.toFixed(4),
      plateauStrength.toFixed(4),
      plateauStart.toFixed(4),
      plateauFeather.toFixed(4)
    ].join(':');

    if (
      this._rainFlowMap &&
      this._rainFlowMapSourceUuid === srcTex.uuid &&
      this._rainFlowMapVersion === FLOW_MAP_VERSION &&
      this._rainFlowMapConfigKey === cfgKey
    ) return;

    if (this._rainFlowMap) {
      try { this._rainFlowMap.dispose(); } catch (e) {}
      this._rainFlowMap = null;
    }

    const srcW = Math.max(1, img.width || 1);
    const srcH = Math.max(1, img.height || 1);
    const scale = Math.min(1.0, maxDim / Math.max(srcW, srcH));
    const w = Math.max(minDim, Math.floor(srcW * scale));
    const h = Math.max(minDim, Math.floor(srcH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    
    ctx.drawImage(img, 0, 0, w, h);
    let imageData;
    try {
      imageData = ctx.getImageData(0, 0, w, h);
    } catch (e) {
      return;
    }

    const data = imageData.data;
    const n = w * h;
    const INF = 1e9;

    // --- EDT Pass 1: Obstacle Distance ---
    const g = new Float32Array(n); 
    for (let i = 0; i < n; i++) {
      // Threshold can be tweaked if your mask is anti-aliased
      const s = (data[i * 4] / 255);
      const isObstacle = obstacleInvert ? (s < obstacleThreshold) : (s >= obstacleThreshold);
      g[i] = isObstacle ? 0 : INF;
    }

    // Forward pass
    for (let x = 0; x < w; x++) {
      for (let y = 1; y < h; y++) {
        const idx = y * w + x;
        const upIdx = (y - 1) * w + x;
        g[idx] = Math.min(g[idx], g[upIdx] + 1);
      }
      for (let y = h - 2; y >= 0; y--) {
        const idx = y * w + x;
        const downIdx = (y + 1) * w + x;
        g[idx] = Math.min(g[idx], g[downIdx] + 1);
      }
    }
    
    // Squared Euclidean
    for (let i = 0; i < n; i++) g[i] = g[i] * g[i];

    // Horizontal scan
    const dt = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      const rowOffset = y * w;
      for (let x = 0; x < w; x++) {
        let minDist = g[rowOffset + x];
        for (let k = 1; x - k >= 0; k++) {
          const dTotal = g[rowOffset + (x - k)] + k * k;
          if (dTotal < minDist) minDist = dTotal;
          if (k * k > minDist) break;
        }
        for (let k = 1; x + k < w; k++) {
          const dTotal = g[rowOffset + (x + k)] + k * k;
          if (dTotal < minDist) minDist = dTotal;
          if (k * k > minDist) break;
        }
        dt[rowOffset + x] = Math.sqrt(minDist);
      }
    }

    // --- Raw Vector Field Calculation ---
    // We calculate vectors and store them in a float buffer.
    // R=vx, G=vy, B=dist (0-1 normalized)
    
    let readBuf = new Float32Array(n * 3); 
    let writeBuf = new Float32Array(n * 3);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;

        // Central Differences for gradient
        const x0 = x > 0 ? x - 1 : 0;
        const x1 = x < w - 1 ? x + 1 : w - 1;
        const y0 = y > 0 ? y - 1 : 0;
        const y1 = y < h - 1 ? y + 1 : h - 1;

        let dx = dt[y * w + x1] - dt[y * w + x0];
        let dy = dt[y1 * w + x] - dt[y0 * w + x];
        
        let len = Math.sqrt(dx*dx + dy*dy);
        let vx = 0; 
        let vy = 1; // Default to down flow if no gradient

        if (len > 0.001) {
            vx = dx / len;
            vy = dy / len;
        }

        let boundary01 = Math.max(0.0, Math.min(1.0, dt[i] / boundaryMaxPx));
        boundary01 = Math.pow(boundary01, distGamma) * distScale;
        boundary01 = Math.max(0.0, Math.min(1.0, boundary01));

        readBuf[i * 3 + 0] = vx;
        readBuf[i * 3 + 1] = vy;
        readBuf[i * 3 + 2] = boundary01;
      }
    }

    // --- ITERATIVE RELAXATION (The Fix) ---
    // Instead of one pass with a large kernel, we run multiple passes 
    // with a small kernel. This simulates fluid viscosity and curves the angles.
    for (let iter = 0; iter < relaxationIterations; iter++) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let sumX = 0, sumY = 0, sumD = 0;
          let count = 0;

          // 3x3 Box Average
          for (let ky = -kernel; ky <= kernel; ky++) {
            const ny = y + ky;
            if (ny < 0 || ny >= h) continue;
            const rowOff = ny * w;
            
            for (let kx = -kernel; kx <= kernel; kx++) {
              const nx = x + kx;
              if (nx < 0 || nx >= w) continue;
              
              const idx = (rowOff + nx) * 3;
              sumX += readBuf[idx + 0];
              sumY += readBuf[idx + 1];
              sumD += readBuf[idx + 2];
              count++;
            }
          }

          const destIdx = (y * w + x) * 3;
          const baseX = readBuf[destIdx + 0];
          const baseY = readBuf[destIdx + 1];
          const baseD = readBuf[destIdx + 2];

          const avgX = sumX / count;
          const avgY = sumY / count;
          const mixX = baseX + (avgX - baseX) * relaxMix;
          const mixY = baseY + (avgY - baseY) * relaxMix;

          const len = Math.sqrt(mixX*mixX + mixY*mixY);

          if (len > 0.001) {
              writeBuf[destIdx + 0] = mixX / len;
              writeBuf[destIdx + 1] = mixY / len;
          } else {
              writeBuf[destIdx + 0] = defaultX;
              writeBuf[destIdx + 1] = defaultY;
          }

          const avgD = sumD / count;
          writeBuf[destIdx + 2] = baseD + (avgD - baseD) * relaxMix;
        }
      }

      // Swap buffers for next iteration (Ping-Pong)
      let tmp = readBuf;
      readBuf = writeBuf;
      writeBuf = tmp;
    }

    const msSmoothstep = (edge0, edge1, x) => {
      const denom = (edge1 - edge0);
      if (Math.abs(denom) <= 1e-12) return x < edge0 ? 0.0 : 1.0;
      const t = Math.max(0.0, Math.min(1.0, (x - edge0) / denom));
      return t * t * (3.0 - 2.0 * t);
    };

    if (plateauStrength > 1e-6) {
      let defX = defaultX;
      let defY = defaultY;
      const dLen = Math.sqrt(defX * defX + defY * defY);
      if (dLen > 1e-6) {
        defX /= dLen;
        defY /= dLen;
      } else {
        defX = 0.0;
        defY = 1.0;
      }

      const a = Math.max(0.0, Math.min(1.0, plateauStart));
      const f = Math.max(1e-6, plateauFeather);

      for (let i = 0; i < n; i++) {
        const baseD = readBuf[i * 3 + 2];
        const roof01 = msSmoothstep(a, Math.min(1.0, a + f), baseD);
        const t = Math.max(0.0, Math.min(1.0, plateauStrength * roof01));
        if (t <= 1e-6) continue;

        const ix = i * 3;
        const vx0 = readBuf[ix + 0];
        const vy0 = readBuf[ix + 1];

        let mx = vx0 + (defX - vx0) * t;
        let my = vy0 + (defY - vy0) * t;
        const mLen = Math.sqrt(mx * mx + my * my);
        if (mLen > 1e-6) {
          mx /= mLen;
          my /= mLen;
        } else {
          mx = defX;
          my = defY;
        }

        readBuf[ix + 0] = mx;
        readBuf[ix + 1] = my;
      }
    }

    // --- Final Packing to Uint8 ---
    // We read from 'readBuf' because we swapped at the end of the loop
    const out = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
        const vx = readBuf[i * 3 + 0];
        const vy = readBuf[i * 3 + 1];
        const dist = readBuf[i * 3 + 2];

        // 0..1 -> 0..255 (Vectors mapped from -1..1 to 0..1)
        out[i * 4 + 0] = Math.floor((vx * 0.5 + 0.5) * 255);
        out[i * 4 + 1] = Math.floor((vy * 0.5 + 0.5) * 255);
        out[i * 4 + 2] = Math.floor(dist * 255);
        out[i * 4 + 3] = 255;
    }

    const tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.needsUpdate = true;
    tex.flipY = !!srcTex.flipY;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;

    this._rainFlowMap = tex;
    this._rainFlowMapSourceUuid = srcTex.uuid;
    this._rainFlowMapVersion = FLOW_MAP_VERSION;
    this._rainFlowMapConfigKey = cfgKey;

    try {
      const mm = window.MapShine?.maskManager;
      if (mm && typeof mm.setTexture === 'function') {
        mm.setTexture('rainFlowMap.scene', tex, {
          space: 'sceneUv',
          source: 'derived',
          channels: 'rgba',
          uvFlipY: !!tex.flipY,
          lifecycle: 'staticPerScene',
          width: w,
          height: h
        });
      }
    } catch (e) {
    }
  }

  createOverlayMesh() {
    const THREE = window.THREE;

    if (!this._tmpRainDir) this._tmpRainDir = new THREE.Vector2(0, 1);
    if (!this._tmpWindDir) this._tmpWindDir = new THREE.Vector2(1, 0);

    const baseMaterial = this.baseMesh?.material;
    const baseMap =
      baseMaterial?.map ||
      baseMaterial?.uniforms?.uAlbedoMap?.value ||
      this._bundleBaseTexture ||
      null;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uBaseMap: { value: baseMap },
        uWindowMask: { value: this.windowMask },
        uOutdoorsMask: { value: this.outdoorsMask },
        uSpecularMask: { value: this.specularMask },

        uWindowTexelSize: {
          value: this.windowMask && this.windowMask.image
            ? new THREE.Vector2(1 / this.windowMask.image.width, 1 / this.windowMask.image.height)
            : new THREE.Vector2(1 / 1024, 1 / 1024)
        },

        uHasOutdoorsMask: { value: this.outdoorsMask ? 1.0 : 0.0 },
        uHasSpecularMask: { value: this.specularMask ? 1.0 : 0.0 },

        uTime: { value: 0.0 },
        uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },

        uIntensity: { value: this.params.intensity },
        uFalloff: { value: this.params.falloff },
        uColor: { value: new THREE.Color(this.params.color.r, this.params.color.g, this.params.color.b) },

        uCloudCover: { value: 0.0 },
        uCloudInfluence: { value: this.params.cloudInfluence },
        uDarknessLevel: { value: 0.0 },
        uNightDimming: { value: this.params.nightDimming },

        uSkyIntensity: { value: 0.0 },
        uSkyTemperature: { value: 0.0 },
        uSkyTint: { value: 0.0 },
        uUseSkyTint: { value: this.params.useSkyTint ? 1.0 : 0.0 },
        uSkyTintStrength: { value: this.params.skyTintStrength },

        uCloudShadowContrast: { value: this.params.cloudShadowContrast },
        uCloudShadowBias: { value: this.params.cloudShadowBias },
        uCloudShadowGamma: { value: this.params.cloudShadowGamma },
        uCloudShadowMinLight: { value: this.params.cloudShadowMinLight },

        uCloudShadowMap: { value: null },
        uHasCloudShadowMap: { value: 0.0 },
        uRoofAlphaMap: { value: null },
        uHasRoofAlphaMap: { value: 0.0 },
        uOverheadMaskSuppression: { value: 0.0 },

        uSpecularBoost: { value: this.params.specularBoost },

        uRgbShiftAmount: { value: this.params.rgbShiftAmount },
        uRgbShiftAngle: { value: this.params.rgbShiftAngle * (Math.PI / 180.0) },

        uRainK: { value: 0.0 },
        uRainSpeed: { value: this.params.rainOnGlassSpeed },
        uRainDir: { value: this._tmpRainDir },
        uWindDir: { value: this._tmpWindDir },
        uWindSpeed: { value: 0.0 },
        uRainFlowMap: { value: this._rainFlowMap },
        uHasRainFlowMap: { value: this._rainFlowMap ? 1.0 : 0.0 },
        uRainFlowStrength: { value: this.params.rainOnGlassBoundaryFlowStrength },
        uRainFlowWidth: { value: this.params.rainFlowWidth },
        uRainRoofPlateauStrength: { value: this.params.rainRoofPlateauStrength },
        uRainRoofPlateauStart: { value: this.params.rainRoofPlateauStart },
        uRainRoofPlateauFeather: { value: this.params.rainRoofPlateauFeather },
        uRainDebugRoofPlateau: { value: this.params.rainDebugRoofPlateau ? 1.0 : 0.0 },
        uRainDebugFlowMap: { value: this.params.rainDebugFlowMap },
        uRainMaxOffsetPx: { value: this.params.rainOnGlassMaxOffsetPx },
        uRainBlurPx: { value: this.params.rainOnGlassBlurPx },
        uRainDistortionFeatherPx: { value: this.params.rainOnGlassDistortionFeatherPx },
        uRainDistortionMasking: { value: this.params.rainOnGlassDistortionMasking },
        uRainDarken: { value: this.params.rainOnGlassDarken },
        uRainDarkenGamma: { value: this.params.rainOnGlassDarkenGamma },
        uRainSplashIntensity: { value: this.params.rainSplashIntensity },
        uRainSplashMaxOffsetPx: { value: this.params.rainSplashMaxOffsetPx },
        uRainSplashScale: { value: this.params.rainSplashScale },
        uRainSplashMaskScale: { value: this.params.rainSplashMaskScale },
        uRainSplashThreshold: { value: this.params.rainSplashThreshold },
        uRainSplashMaskThreshold: { value: this.params.rainSplashMaskThreshold },
        uRainSplashMaskFeather: { value: this.params.rainSplashMaskFeather },
        uRainSplashSpeed: { value: this.params.rainSplashSpeed },
        uRainSplashSpawnRate: { value: this.params.rainSplashSpawnRate },
        uRainSplashRadiusPx: { value: this.params.rainSplashRadiusPx },
        uRainSplashExpand: { value: this.params.rainSplashExpand },
        uRainSplashFadePow: { value: this.params.rainSplashFadePow },
        uRainSplashLayers: { value: this.params.rainSplashLayers },
        uRainSplashDriftPx: { value: this.params.rainSplashDriftPx },
        uRainSplashSizeJitter: { value: this.params.rainSplashSizeJitter },
        uRainSplashBlob: { value: this.params.rainSplashBlob },
        uRainSplashStreakStrength: { value: this.params.rainSplashStreakStrength },
        uRainSplashStreakLengthPx: { value: this.params.rainSplashStreakLengthPx },
        uRainSplashAtlas: { value: null },
        uHasRainSplashAtlas: { value: 0.0 },
        uRainSplashAtlasTile0: { value: this.params.rainSplashAtlasTile0 ? 1.0 : 0.0 },
        uRainSplashAtlasTile1: { value: this.params.rainSplashAtlasTile1 ? 1.0 : 0.0 },
        uRainSplashAtlasTile2: { value: this.params.rainSplashAtlasTile2 ? 1.0 : 0.0 },
        uRainSplashAtlasTile3: { value: this.params.rainSplashAtlasTile3 ? 1.0 : 0.0 },
        uRainNoiseScale: { value: this.params.rainNoiseScale },
        uRainNoiseDetail: { value: this.params.rainNoiseDetail },
        uRainNoiseEvolution: { value: this.params.rainNoiseEvolution },
        uRainRivuletAspect: { value: this.params.rainRivuletAspect },
        uRainRivuletGain: { value: this.params.rainRivuletGain },
        uRainRivuletStrength: { value: this.params.rainRivuletStrength },
        uRainRivuletThreshold: { value: this.params.rainRivuletThreshold },
        uRainRivuletFeather: { value: this.params.rainRivuletFeather },
        uRainRivuletGamma: { value: this.params.rainRivuletGamma },
        uRainRivuletSoftness: { value: this.params.rainRivuletSoftness },
        uRainRivuletDistanceMasking: { value: this.params.rainRivuletDistanceMasking },
        uRainRivuletDistanceStart: { value: this.params.rainRivuletDistanceStart },
        uRainRivuletDistanceEnd: { value: this.params.rainRivuletDistanceEnd },
        uRainRivuletDistanceFeather: { value: this.params.rainRivuletDistanceFeather },
        uRainRivuletRidgeMix: { value: this.params.rainRivuletRidgeMix },
        uRainRivuletRidgeGain: { value: this.params.rainRivuletRidgeGain },
        uRainBrightThreshold: { value: this.params.rainOnGlassBrightThreshold },
        uRainBrightFeather: { value: this.params.rainOnGlassBrightFeather },

        uRainFlowInvertTangent: { value: this.params.rainFlowInvertTangent ? 1.0 : 0.0 },
        uRainFlowInvertNormal: { value: this.params.rainFlowInvertNormal ? 1.0 : 0.0 },
        uRainFlowSwapAxes: { value: this.params.rainFlowSwapAxes ? 1.0 : 0.0 },
        uRainFlowAdvectScale: { value: this.params.rainFlowAdvectScale },
        uRainFlowEvoScale: { value: this.params.rainFlowEvoScale },
        uRainFlowPerpScale: { value: this.params.rainFlowPerpScale },
        uRainFlowGlobalInfluence: { value: this.params.rainFlowGlobalInfluence },
        uRainFlowAngleOffset: { value: this.params.rainFlowAngleOffset * (Math.PI / 180.0) },
        uRainFlowFlipDeadzone: { value: this.params.rainFlowFlipDeadzone },
        uRainFlowMaxTurn: { value: (this.params.rainFlowMaxTurnDeg * Math.PI) / 180.0 },

        uLightningFlash01: { value: 0.0 },
        uLightningWindowEnabled: { value: this.params.lightningWindowEnabled ? 1.0 : 0.0 },
        uLightningWindowIntensityBoost: { value: this.params.lightningWindowIntensityBoost },
        uLightningWindowContrastBoost: { value: this.params.lightningWindowContrastBoost },
        uLightningWindowRgbBoost: { value: this.params.lightningWindowRgbBoost },

        // Sun-tracking offset uniforms
        uSunLightEnabled: { value: this.params.sunLightEnabled ? 1.0 : 0.0 },
        uSunLightLength: { value: this.params.sunLightLength },
        uSunDir: { value: new THREE.Vector2(0.0, 0.0) }
      },
      vertexShader: this.getVertexShader(),
      fragmentShader: this.getFragmentShader(),
      side: THREE.DoubleSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true
    });

    this.mesh = new THREE.Mesh(this.baseMesh.geometry, this.material);
    this.mesh.position.copy(this.baseMesh.position);
    this.mesh.rotation.copy(this.baseMesh.rotation);
    this.mesh.scale.copy(this.baseMesh.scale);

    this.mesh.renderOrder = 9; // Just below Overhead Tiles (10)

    this.scene.add(this.mesh);
    this.mesh.visible = this._enabled;
  }

  getVertexShader() {
    return `
      varying vec2 vUv;
      varying vec4 vClipPos;

      void main() {
        vUv = uv;
        vClipPos = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = vClipPos;
      }
    `;
  }

  getFragmentShader() {
    return `
      uniform sampler2D uBaseMap;
      uniform sampler2D uWindowMask;
      uniform sampler2D uOutdoorsMask;
      uniform sampler2D uSpecularMask;

      uniform vec2 uWindowTexelSize;

      uniform float uHasOutdoorsMask;
      uniform float uHasSpecularMask;

      uniform float uIntensity;
      uniform float uFalloff;
      uniform vec3 uColor;

      uniform float uCloudCover;
      uniform float uCloudInfluence;
      uniform float uDarknessLevel;
      uniform float uNightDimming;

      uniform float uSkyIntensity;
      uniform float uSkyTemperature;
      uniform float uSkyTint;
      uniform float uUseSkyTint;
      uniform float uSkyTintStrength;

      uniform float uCloudShadowContrast;
      uniform float uCloudShadowBias;
      uniform float uCloudShadowGamma;
      uniform float uCloudShadowMinLight;

      uniform sampler2D uCloudShadowMap;
      uniform float uHasCloudShadowMap;
      uniform sampler2D uRoofAlphaMap;
      uniform float uHasRoofAlphaMap;
      uniform float uOverheadMaskSuppression;

      uniform float uTime;

      uniform float uRainK;
      uniform float uRainSpeed;
      uniform vec2  uRainDir;
      uniform vec2  uWindDir;
      uniform float uWindSpeed;
      uniform sampler2D uRainFlowMap;
      uniform float uHasRainFlowMap;
      uniform float uRainFlowStrength;
      uniform float uRainFlowWidth;
      uniform float uRainRoofPlateauStrength;
      uniform float uRainRoofPlateauStart;
      uniform float uRainRoofPlateauFeather;
      uniform float uRainDebugRoofPlateau;
      uniform float uRainDebugFlowMap;
      uniform float uRainMaxOffsetPx;
      uniform float uRainBlurPx;
      uniform float uRainDistortionFeatherPx;
      uniform float uRainDistortionMasking;
      uniform float uRainDarken;
      uniform float uRainDarkenGamma;
      uniform float uRainSplashIntensity;
      uniform float uRainSplashMaxOffsetPx;
      uniform float uRainSplashScale;
      uniform float uRainSplashMaskScale;
      uniform float uRainSplashThreshold;
      uniform float uRainSplashMaskThreshold;
      uniform float uRainSplashMaskFeather;
      uniform float uRainSplashSpeed;
      uniform float uRainSplashSpawnRate;
      uniform float uRainSplashRadiusPx;
      uniform float uRainSplashExpand;
      uniform float uRainSplashFadePow;
      uniform float uRainSplashLayers;
      uniform float uRainSplashDriftPx;
      uniform float uRainSplashSizeJitter;
      uniform float uRainSplashBlob;
      uniform float uRainSplashStreakStrength;
      uniform float uRainSplashStreakLengthPx;
      uniform sampler2D uRainSplashAtlas;
      uniform float uHasRainSplashAtlas;
      uniform float uRainSplashAtlasTile0;
      uniform float uRainSplashAtlasTile1;
      uniform float uRainSplashAtlasTile2;
      uniform float uRainSplashAtlasTile3;
      uniform float uRainNoiseScale;
      uniform float uRainNoiseDetail;
      uniform float uRainNoiseEvolution;
      uniform float uRainRivuletAspect;
      uniform float uRainRivuletGain;
      uniform float uRainRivuletStrength;
      uniform float uRainRivuletThreshold;
      uniform float uRainRivuletFeather;
      uniform float uRainRivuletGamma;
      uniform float uRainRivuletSoftness;
      uniform float uRainRivuletDistanceMasking;
      uniform float uRainRivuletDistanceStart;
      uniform float uRainRivuletDistanceEnd;
      uniform float uRainRivuletDistanceFeather;
      uniform float uRainRivuletRidgeMix;
      uniform float uRainRivuletRidgeGain;
      uniform float uRainBrightThreshold;
      uniform float uRainBrightFeather;

      uniform float uRainFlowInvertTangent;
      uniform float uRainFlowInvertNormal;
      uniform float uRainFlowSwapAxes;
      uniform float uRainFlowAdvectScale;
      uniform float uRainFlowEvoScale;
      uniform float uRainFlowPerpScale;
      uniform float uRainFlowGlobalInfluence;
      uniform float uRainFlowAngleOffset;
      uniform float uRainFlowFlipDeadzone;
      uniform float uRainFlowMaxTurn;

      uniform float uLightningFlash01;
      uniform float uLightningWindowEnabled;
      uniform float uLightningWindowIntensityBoost;
      uniform float uLightningWindowContrastBoost;
      uniform float uLightningWindowRgbBoost;

      uniform float uSpecularBoost;

      uniform float uRgbShiftAmount;
      uniform float uRgbShiftAngle;

      // Sun-tracking offset
      uniform float uSunLightEnabled;
      uniform float uSunLightLength;
      uniform vec2 uSunDir;

      varying vec4 vClipPos;
      varying vec2 vUv;

      float msLuminance(vec3 c) {
        return dot(c, vec3(0.2126, 0.7152, 0.0722));
      }

      vec3 msApplySkyWhiteBalance(vec3 color, float temp, float tint) {
        vec3 tempShift = vec3(1.0 + temp, 1.0, 1.0 - temp);
        if (temp < 0.0) tempShift = vec3(1.0, 1.0, 1.0 - temp * 0.5);
        else tempShift = vec3(1.0 + temp * 0.5, 1.0, 1.0);

        vec3 tintShift = vec3(1.0, 1.0 + tint, 1.0);
        return color * tempShift * tintShift;
      }

      float msHash11(float x) {
        return fract(sin(x * 127.1) * 43758.5453123);
      }

      float msHash21(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }

      vec2 msHash22(vec2 p) {
        float x = dot(p, vec2(127.1, 311.7));
        float y = dot(p, vec2(269.5, 183.3));
        return fract(sin(vec2(x, y)) * 43758.5453123);
      }

      float msValueNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);

        float a = msHash21(i);
        float b = msHash21(i + vec2(1.0, 0.0));
        float c = msHash21(i + vec2(0.0, 1.0));
        float d = msHash21(i + vec2(1.0, 1.0));

        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
      }

      float msFbm(vec2 p, float detail) {
        float v = 0.0;
        float a = 0.5;
        vec2  shift = vec2(100.0, 100.0);

        for (int i = 0; i < 3; i++) {
          float w = step(float(i), detail);
          v += w * a * msValueNoise(p);
          p = p * 2.02 + shift;
          a *= 0.5;
        }
        return v;
      }

      float msFbmBlurred(vec2 p, float detail, vec2 blurStep) {
        float bx = abs(blurStep.x);
        float by = abs(blurStep.y);
        if (max(bx, by) <= 1e-7) return msFbm(p, detail);

        float c0 = msFbm(p, detail);
        float c1 = msFbm(p + vec2( blurStep.x, 0.0), detail);
        float c2 = msFbm(p + vec2(-blurStep.x, 0.0), detail);
        float c3 = msFbm(p + vec2(0.0,  blurStep.y), detail);
        float c4 = msFbm(p + vec2(0.0, -blurStep.y), detail);

        return c0 * 0.40 + (c1 + c2 + c3 + c4) * 0.15;
      }

      void main() {
        if (uIntensity <= 0.001) {
          gl_FragColor = vec4(0.0);
          return;
        }

        // Debug flow map visualization
        if (uRainDebugFlowMap > 0.5) {
          if (uHasRainFlowMap > 0.5) {
            vec3 flowColor = texture2D(uRainFlowMap, vUv).rgb;
            gl_FragColor = vec4(flowColor.r, flowColor.g, flowColor.b, 1.0);
            return;
          } else {
            gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0);
            return;
          }
        }

        // When overhead lighting is disabled (or reduced), suppress window light
        // under currently visible roof pixels using LightingEffect's roof-alpha pass.
        float roofSuppression = 1.0;
        if (uHasRoofAlphaMap > 0.5 && uOverheadMaskSuppression > 0.001) {
          vec2 screenUV = (vClipPos.xy / vClipPos.w) * 0.5 + 0.5;
          float roofAlpha = clamp(texture2D(uRoofAlphaMap, screenUV).a, 0.0, 1.0);
          roofSuppression = 1.0 - roofAlpha * clamp(uOverheadMaskSuppression, 0.0, 1.0);
        }

        if (uRainDebugRoofPlateau > 0.5 && uHasRainFlowMap <= 0.5) {
          gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0);
          return;
        }

        // Sun-tracking offset: shift the window mask sampling UV so the light
        // pool moves with the sun direction. The offset is in mask UV space
        // (vUv), matching BuildingShadowsEffect's bake shader convention
        // where V=0 = north (flipY=false).
        vec2 sunOffset = vec2(0.0);
        if (uSunLightEnabled > 0.5) {
          vec2 dir = normalize(uSunDir + vec2(1e-6));
          sunOffset = dir * uSunLightLength;
        }
        // maskUv is the UV used for all window mask lookups when sun tracking
        // is active; falls back to vUv when disabled.
        vec2 maskUv = vUv + sunOffset;

        float flash01 = clamp(uLightningFlash01, 0.0, 1.0) * step(0.5, uLightningWindowEnabled);
        float rgbBoost = max(uLightningWindowRgbBoost, 0.0);
        float shiftAmountPx = uRgbShiftAmount * (1.0 + flash01 * rgbBoost);

        vec2 uv = maskUv;
        vec3 rainNormal = vec3(0.0, 0.0, 1.0);
        float rainK = clamp(uRainK, 0.0, 4.0);
        float rainKSplash = rainK;

        float baseMaskScalar = msLuminance(texture2D(uWindowMask, maskUv).rgb);
        float baseLightGate = pow(max(baseMaskScalar, 0.0), uFalloff);
        float gateContrastPow = 1.0 / (1.0 + flash01 * max(uLightningWindowContrastBoost, 0.0));
        baseLightGate = pow(max(baseLightGate, 0.0), gateContrastPow);
        float rainKDark = 0.0;
        float waterMask = 0.0;
        if (rainK > 0.001) {
          float bt = clamp(uRainBrightThreshold, 0.0, 1.0);
          float bf = max(uRainBrightFeather, 0.0);
          float brightGate = smoothstep(bt, bt + max(1e-4, bf), baseLightGate);
          rainKDark = rainK * brightGate;

          float aspect = max(1e-6, uWindowTexelSize.y) / max(1e-6, uWindowTexelSize.x);
          vec2 aspectVec = vec2(aspect, 1.0);
          vec2 p = (vUv - 0.5) * aspectVec;

          vec2 globalDir = uRainDir;
          float dLen = max(1e-4, length(globalDir));
          globalDir /= dLen;
          vec2 globalDirP = globalDir * aspectVec;
          float dpLen = max(1e-4, length(globalDirP));
          vec2 dirP = globalDirP / dpLen;
          vec2 perpP = vec2(-dirP.y, dirP.x);

          vec2 rotP = vec2(dot(p, perpP), dot(p, dirP));

          float flowZone = 0.0;
          vec2 flowDirRot = vec2(0.0, 1.0);
          float roofMask = 1.0;
          float distToWall = 0.0;
          if (uHasRainFlowMap > 0.5) {
            vec4 flowSample = texture2D(uRainFlowMap, vUv);

            distToWall = flowSample.b;
            float plateauStrength = clamp(uRainRoofPlateauStrength, 0.0, 1.0);
            float plateauStart = clamp(uRainRoofPlateauStart, 0.0, 1.0);
            float plateauFeather = max(1e-4, uRainRoofPlateauFeather);
            float roof01 = smoothstep(plateauStart, plateauStart + plateauFeather, distToWall);
            roofMask = 1.0 - plateauStrength * roof01;

            if (uRainDebugRoofPlateau > 0.5) {
              gl_FragColor = vec4(roofMask, distToWall, roof01, 1.0);
              return;
            }
            float width = max(uRainFlowWidth, 0.0);
            float widthEff = max(width, 0.0001);
            float feather = max(0.02, widthEff * 0.25);
            flowZone = 1.0 - smoothstep(widthEff, widthEff + feather, distToWall);
            float flowStrength = clamp(max(uRainFlowStrength, 0.0) * flowZone, 0.0, 1.0);

            vec2 localN = flowSample.rg * 2.0 - 1.0;
            if (uRainFlowInvertNormal > 0.5) localN = -localN;
            vec2 localNP = localN * aspectVec;
            float lnLen = max(1e-4, length(localNP));
            localNP /= lnLen;
            vec2 localTP = vec2(-localNP.y, localNP.x);
            if (uRainFlowInvertTangent > 0.5) localTP = -localTP;
            if (uRainFlowSwapAxes > 0.5) localTP = localTP.yx;
            vec2 localTRot = vec2(dot(localTP, perpP), dot(localTP, dirP));
            float ltLen = max(1e-4, length(localTRot));
            vec2 lfN = localTRot / ltLen;
            float oc = cos(uRainFlowAngleOffset);
            float os = sin(uRainFlowAngleOffset);
            vec2 desiredDirRot = mat2(oc, -os, os, oc) * vec2(0.0, 1.0);

            float align = dot(lfN, desiredDirRot);
            float dead = max(1e-6, clamp(uRainFlowFlipDeadzone, 0.0, 1.0));
            float ambig = smoothstep(0.0, dead, abs(align));
            float flipT = smoothstep(-dead, dead, align);
            lfN = normalize(mix(-lfN, lfN, flipT) + desiredDirRot * 1e-3);
            flowStrength *= ambig;
            vec2 baseDir = flowDirRot;
            float baseLen = max(1e-4, length(baseDir));
            baseDir /= baseLen;

            vec2 localDir = lfN;
            float localLen = max(1e-4, length(localDir));
            localDir /= localLen;

            float gi = max(0.0, uRainFlowGlobalInfluence);
            float wLocal = flowStrength;
            float wBase = (1.0 - flowStrength) * gi;
            float wTotal = max(1e-6, wBase + wLocal);
            float wAngle = clamp(wLocal / wTotal, 0.0, 1.0);

            float a0 = atan(baseDir.y, baseDir.x);
            float a1 = atan(localDir.y, localDir.x);
            float da = a1 - a0;
            da = mod(da + 3.14159265, 6.2831853) - 3.14159265;

            float maxTurn = clamp(uRainFlowMaxTurn, 0.0, 3.14159265);
            da = clamp(da, -maxTurn, maxTurn);
            float a = a0 + da * wAngle;
            flowDirRot = vec2(cos(a), sin(a));
            flowDirRot = mat2(oc, -os, os, oc) * flowDirRot;
          }

          float rainKDist = rainK * roofMask;
          float rainKDarkDist = rainKDark * roofMask;

          vec2 rainUV = rotP * 2.0 + 0.5;

          float tMove = uTime * max(0.0, uRainSpeed);

          float nScale = max(0.001, uRainNoiseScale);
          float detail = clamp(uRainNoiseDetail, 0.0, 3.0);
          float evo = max(0.0, uRainNoiseEvolution);

          float rivAspect = max(1.0, uRainRivuletAspect);
          vec2 aniso = vec2(rivAspect, 1.0 / rivAspect);

          vec2 blurStep = uWindowTexelSize * max(0.0, uRainBlurPx) * nScale * aniso;

          vec2 flowN = flowDirRot;
          float flowLen = max(1e-4, length(flowN));
          flowN /= flowLen;
          vec2 flowPerp = vec2(-flowN.y, flowN.x);

          vec2 rainUVFlow = vec2(dot(rainUV, flowPerp), dot(rainUV, flowN));

          vec2 adv = flowN * (tMove * 0.12) * uRainFlowAdvectScale;
          vec2 advFlow = vec2(dot(adv, flowPerp), dot(adv, flowN));

          vec2 q = (rainUVFlow * nScale + advFlow) * aniso;

          vec2 evoVec = flowN * (uTime * evo * 0.06) * uRainFlowEvoScale + flowPerp * (uTime * evo * 0.02) * uRainFlowPerpScale;
          vec2 evoFlow = vec2(dot(evoVec, flowPerp), dot(evoVec, flowN));
          q += evoFlow * aniso;

          float n0 = msFbmBlurred(q, detail, blurStep);

          float eps = max(1.0, 6.0 / max(nScale, 0.001)) * max(uWindowTexelSize.x, uWindowTexelSize.y);
          vec2 eps2 = vec2(eps * aniso.x, eps * aniso.y);
          float nx = msFbmBlurred(q + vec2(eps2.x, 0.0), detail, blurStep) - msFbmBlurred(q - vec2(eps2.x, 0.0), detail, blurStep);
          float ny = msFbmBlurred(q + vec2(0.0, eps2.y), detail, blurStep) - msFbmBlurred(q - vec2(0.0, eps2.y), detail, blurStep);
          vec2 grad = vec2(nx, ny);

          float ridge = abs(nx) / max(1e-6, 2.0 * eps2.x);
          ridge = clamp(ridge * max(0.0, uRainRivuletRidgeGain), 0.0, 1.0);

          float rivBase = clamp(n0, 0.0, 1.0);
          float rivN = mix(rivBase, ridge, clamp(uRainRivuletRidgeMix, 0.0, 1.0));
          rivN = clamp(rivN * max(0.0, uRainRivuletGain), 0.0, 1.0);
          float rivThr = clamp(uRainRivuletThreshold, 0.0, 1.0);
          float rivFea0 = max(1e-4, uRainRivuletFeather);
          float rivSoft = clamp(uRainRivuletSoftness, 0.0, 1.0);
          float rivFea = rivFea0 * (1.0 + 6.0 * rivSoft);
          float rivM = smoothstep(rivThr - rivFea, rivThr + rivFea, rivN);
          rivM = pow(rivM, max(0.01, uRainRivuletGamma));

          float rivDistMaskRaw = 1.0;
          if (uHasRainFlowMap > 0.5) {
            float d = clamp(distToWall, 0.0, 1.0);
            float s0 = clamp(uRainRivuletDistanceStart, 0.0, 1.0);
            float e0 = clamp(uRainRivuletDistanceEnd, 0.0, 1.0);
            float a = min(s0, e0);
            float b = max(s0, e0);
            float f = max(1e-4, uRainRivuletDistanceFeather);
            float inM = smoothstep(a, min(1.0, a + f), d);
            float outM = 1.0 - smoothstep(max(0.0, b - f), b, d);
            rivDistMaskRaw = clamp(inM * outM, 0.0, 1.0);
          }
          float rivDistMask = mix(1.0, rivDistMaskRaw, clamp(uRainRivuletDistanceMasking, 0.0, 1.0));
          rivM *= rivDistMask;

          float distMasking = clamp(uRainDistortionMasking, 0.0, 1.0);
          float distortGate = mix(1.0, rivM, distMasking);

          vec2 gradRot = flowPerp * grad.x + flowN * grad.y;
          vec2 unrotatedN = perpP * gradRot.x + dirP * gradRot.y;
          float nLen = max(1e-4, length(unrotatedN));
          vec2 n01 = unrotatedN / nLen;

          float maxOffsetPx = max(0.0, uRainMaxOffsetPx);
          vec2 distortPx = n01 * maxOffsetPx * distortGate;
          rainNormal = normalize(vec3(n01 * distortGate, 1.0));
          vec2 distUV = distortPx * uWindowTexelSize * rainKDist;
          float featherPx = max(0.0, uRainDistortionFeatherPx);
          vec2 stepUv = uWindowTexelSize * featherPx;

          float srcMask = msLuminance(texture2D(uWindowMask, vUv).rgb);
          float destMask = msLuminance(texture2D(uWindowMask, vUv - distUV).rgb);

          if (featherPx > 0.001) {
            float s1 = msLuminance(texture2D(uWindowMask, vUv + vec2( stepUv.x, 0.0)).rgb);
            float s2 = msLuminance(texture2D(uWindowMask, vUv + vec2(-stepUv.x, 0.0)).rgb);
            float s3 = msLuminance(texture2D(uWindowMask, vUv + vec2(0.0,  stepUv.y)).rgb);
            float s4 = msLuminance(texture2D(uWindowMask, vUv + vec2(0.0, -stepUv.y)).rgb);
            srcMask = (srcMask * 2.0 + s1 + s2 + s3 + s4) / 6.0;

            float d1 = msLuminance(texture2D(uWindowMask, (vUv - distUV) + vec2( stepUv.x, 0.0)).rgb);
            float d2 = msLuminance(texture2D(uWindowMask, (vUv - distUV) + vec2(-stepUv.x, 0.0)).rgb);
            float d3 = msLuminance(texture2D(uWindowMask, (vUv - distUV) + vec2(0.0,  stepUv.y)).rgb);
            float d4 = msLuminance(texture2D(uWindowMask, (vUv - distUV) + vec2(0.0, -stepUv.y)).rgb);
            destMask = (destMask * 2.0 + d1 + d2 + d3 + d4) / 6.0;
          }

          float edgeHi = mix(0.10, 0.75, clamp(featherPx / 16.0, 0.0, 1.0));
          float safetyFactor = smoothstep(0.0, edgeHi, destMask);
          float srcFactor = smoothstep(0.0, edgeHi, srcMask);
          uv = uv - distUV * safetyFactor * srcFactor;

          waterMask = rivM * max(0.0, uRainRivuletStrength) * rainKDarkDist;
        }

        if (rainKSplash > 0.001 && uRainSplashIntensity > 0.001) {
          float cellCount = max(1.0, uRainSplashScale);
          float layerCount = clamp(uRainSplashLayers, 1.0, 3.0);
          float driftPx = max(0.0, uRainSplashDriftPx);

          vec2 windDir = uWindDir;
          float windLen = max(1e-4, length(windDir));
          windDir /= windLen;
          float windK = clamp(uWindSpeed, 0.0, 1.0);

          float totalSplash = 0.0;
          vec2 totalUv = vec2(0.0);

          float aspect = max(1e-6, uWindowTexelSize.y) / max(1e-6, uWindowTexelSize.x);
          vec2 aspectVec = vec2(aspect, 1.0);

          vec2 driftBaseUv = windDir * (driftPx * uWindowTexelSize) * (uTime * 0.7);

          for (int i = 0; i < 3; i++) {
            float on = step(float(i), layerCount - 1.0);
            float fi = float(i);

            vec2 layerRand = msHash22(vec2(17.1 + fi * 31.7, 9.3 + fi * 13.9)) * 2.0 - 1.0;
            float lrLen = max(1e-4, length(layerRand));
            vec2 layerDir = layerRand / lrLen;

            vec2 driftDir = normalize(mix(layerDir, windDir, 0.75));
            vec2 layerDriftUv = driftDir * driftBaseUv * (0.45 + fi * 0.35);
            vec2 layerUv = vUv + layerDriftUv;

            vec2 baseCellId = floor(layerUv * cellCount);
            vec2 cellId = baseCellId;
            vec2 cellUv = (cellId + 0.5) / cellCount;

              float density = clamp(uRainSplashThreshold, 0.0, 1.0);
              float rnd = msHash21(cellId + fi * 19.19);
              float spawnK = max(0.001, uRainSplashSpawnRate);
              float rndAdj = pow(clamp(rnd, 0.0, 1.0), 1.0 / spawnK);
              float spawn = smoothstep(density, min(1.0, density + 0.02), rndAdj);

              float rate = max(0.01, uRainSplashSpeed) * (0.85 + fi * 0.25);
              float t0 = uTime * rate + rnd * 10.0;
              float phase = fract(t0);
              float cycle = floor(t0);

              float fadePow = max(0.0001, uRainSplashFadePow);
              float envelope = pow(1.0 - phase, fadePow) * smoothstep(0.0, 0.05, phase);

              float sizeJit = clamp(uRainSplashSizeJitter, 0.0, 1.0);
              float sizeRnd = msHash21(cellId + vec2(cycle * 1.37, cycle * 2.91) + fi * 3.7);
              float sizeMul = mix(1.0 - 0.6 * sizeJit, 1.0 + 0.9 * sizeJit, sizeRnd);

              float r0 = max(0.0, uRainSplashRadiusPx) * uWindowTexelSize.y * sizeMul;
              float r1 = r0 * max(1.0, uRainSplashExpand);
              float r = mix(r0, r1, phase);

              float ringWBase = max(1e-6, r0 * mix(0.18, 0.55, msHash21(cellId + vec2(41.2 + fi * 3.1, 17.7 + cycle * 0.11))));
              float streakLenPx = max(0.0, uRainSplashStreakLengthPx);
              float streakLenUv = streakLenPx * uWindowTexelSize.y * (0.5 + 2.0 * windK);
              float soft = max(1e-6, r0 * 0.40);
              float rMax = r1 + ringWBase + soft + streakLenUv;

              float cellHalfUv = 0.5 / cellCount;
              float jitterMax = max(0.0, cellHalfUv - rMax);
              vec2 jitterN = msHash22(cellId + vec2(3.1 + fi * 7.3, 9.2 + fi * 5.1)) * 2.0 - 1.0;
              vec2 jitter = jitterN * jitterMax;
              vec2 centerUv = cellUv + jitter;

              vec2 d = (layerUv - centerUv) * aspectVec;
              float dist = length(d);
              if (dist > rMax) continue;

              float mScale = max(0.001, uRainSplashMaskScale);
              float mThr = clamp(uRainSplashMaskThreshold, 0.0, 1.0);
              float mF = max(1e-4, uRainSplashMaskFeather);
              float maskN = msFbm(cellUv * mScale + vec2(101.3 + fi * 13.0, 17.1 + fi * 9.0), 2.0);
              float maskGate = smoothstep(mThr, min(1.0, mThr + mF), maskN);

              float blob = clamp(uRainSplashBlob, 0.0, 1.0);
              float edgeNoise = msFbm((d * (cellCount * 1.35)) + (cellId + vec2(13.7, 7.9)) + vec2(cycle * 0.13, cycle * 0.07), 2.0);
              float edgeSigned = (edgeNoise - 0.5) * 2.0;
              float distBlobby = dist + edgeSigned * blob * max(1e-6, r0 * 0.25);
              float rNoisy = r * (1.0 + edgeSigned * blob * 0.22);

              float shape = 0.0;
              if (uHasRainSplashAtlas > 0.5) {
                vec2 localUv = d / max(1e-6, rMax);
                localUv = localUv * 0.5 + 0.5;

                if (any(lessThan(localUv, vec2(0.0))) || any(greaterThan(localUv, vec2(1.0)))) {
                  shape = 0.0;
                } else {
                  float w0 = step(0.5, uRainSplashAtlasTile0);
                  float w1 = step(0.5, uRainSplashAtlasTile1);
                  float w2 = step(0.5, uRainSplashAtlasTile2);
                  float w3 = step(0.5, uRainSplashAtlasTile3);
                  float wSum = w0 + w1 + w2 + w3;
                  if (wSum > 0.5) {
                    float tileRnd = msHash21(cellId + vec2(11.7 + fi * 3.1, 7.9 + cycle * 0.13));
                    float rPick = tileRnd * wSum;
                    float t0 = w0;
                    float t1 = t0 + w1;
                    float t2 = t1 + w2;

                    float tileIndex;
                    if (rPick < t0) tileIndex = 0.0;
                    else if (rPick < t1) tileIndex = 1.0;
                    else if (rPick < t2) tileIndex = 2.0;
                    else tileIndex = 3.0;

                    float tx = mod(tileIndex, 2.0);
                    float ty = floor(tileIndex / 2.0);
                    vec2 atlasUv = (localUv + vec2(tx, ty)) * 0.5;
                    shape = texture2D(uRainSplashAtlas, atlasUv).a;
                  } else {
                    shape = 0.0;
                  }
                }
              } else {
                vec2 wP = windDir * aspectVec;
                float wLen = max(1e-4, length(wP));
                vec2 wN = wP / wLen;
                vec2 wT = vec2(-wN.y, wN.x);
                float along = dot(d, wN);
                float perp = dot(d, wT);

                float streakK = max(0.0, uRainSplashStreakStrength) * windK;
                float streakDist = sqrt(perp * perp + (along / (1.0 + max(1e-6, streakLenUv / max(1e-6, r0)))) * (along / (1.0 + max(1e-6, streakLenUv / max(1e-6, r0)))));

                float ringW = ringWBase;
                ringW *= mix(0.8, 1.35, clamp(edgeNoise, 0.0, 1.0));
                float innerR = max(0.0, rNoisy - ringW);

                float outerA = (1.0 - smoothstep(rNoisy, rNoisy + soft, distBlobby));
                float innerA = (1.0 - smoothstep(innerR, innerR + soft, distBlobby));
                float ring = clamp(outerA - innerA, 0.0, 1.0);

                float outerS = (1.0 - smoothstep(rNoisy, rNoisy + soft, streakDist));
                float innerS = (1.0 - smoothstep(innerR, innerR + soft, streakDist));
                float ringStreak = clamp(outerS - innerS, 0.0, 1.0);
                shape = mix(ring, max(ring, ringStreak), streakK);
              }

              float splash = shape * envelope * spawn * maskGate * on;

              vec2 dir = normalize(msHash22(cellId + vec2(1.7 + fi * 2.0, 2.9 + fi * 3.0)) * 2.0 - 1.0);
              float maxSplashPx = max(0.0, uRainSplashMaxOffsetPx);
              vec2 splashUv = dir * (maxSplashPx * uWindowTexelSize) * splash;

            totalSplash += splash;
            totalUv += splashUv;
          }

          float splashK = clamp(totalSplash, 0.0, 1.0);
          uv = uv + totalUv * uRainSplashIntensity * rainKSplash;
        }

        // 1. Refraction / RGB Shift
        // Sample mask 3 times with offsets
        vec2 shiftDir = vec2(cos(uRgbShiftAngle), sin(uRgbShiftAngle));
        vec2 rOffset = shiftDir * shiftAmountPx * uWindowTexelSize;
        vec2 bOffset = -rOffset;

        float maskR = msLuminance(texture2D(uWindowMask, uv + rOffset).rgb);
        float maskG = msLuminance(texture2D(uWindowMask, uv).rgb);
        float maskB = msLuminance(texture2D(uWindowMask, uv + bOffset).rgb);

        float maskScalar = (maskR + maskG + maskB) / 3.0;

        // 2. Shape Falloff (Gamma)
        // Helps control the "spread" of the light without hard clipping
        float lightMap = pow(max(maskScalar, 0.0), uFalloff);

        float contrastBoost = max(uLightningWindowContrastBoost, 0.0);
        float contrastPow = 1.0 / (1.0 + flash01 * contrastBoost);
        lightMap = pow(max(lightMap, 0.0), contrastPow);

        // 3. Outdoors Rejection (Soft)
        // If outdoors, we shouldn't see window light. When sun tracking is
        // active, also check the outdoors mask at the current fragment's
        // original position to ensure light never leaks into outdoor areas
        // even when the mask sampling has been shifted by the sun offset.
        float indoorFactor = 1.0;
        if (uHasOutdoorsMask > 0.5) {
          // Check the original fragment position — this is where the light
          // would actually appear on screen
          float outdoorStrength = texture2D(uOutdoorsMask, vUv).r;
          indoorFactor = clamp(1.0 - outdoorStrength, 0.0, 1.0);

          // When sun tracking shifts the mask lookup, also reject if the
          // offset source position is outdoor (prevents pulling outdoor
          // mask values into indoor areas)
          if (uSunLightEnabled > 0.5) {
            float offsetOutdoor = texture2D(uOutdoorsMask, maskUv).r;
            indoorFactor *= clamp(1.0 - offsetOutdoor, 0.0, 1.0);
          }
        }

        // 4. Environmental Attenuation
        float envFactor = 1.0;

        // Cloud Shadow (Screen Space)
        if (uHasCloudShadowMap > 0.5) {
          vec2 screenUV = (vClipPos.xy / vClipPos.w) * 0.5 + 0.5;
          float cloudLightFactor = clamp(texture2D(uCloudShadowMap, screenUV).r, 0.0, 1.0);

          cloudLightFactor = clamp(cloudLightFactor + uCloudShadowBias, 0.0, 1.0);
          cloudLightFactor = pow(cloudLightFactor, max(uCloudShadowGamma, 0.0001));
          cloudLightFactor = clamp((cloudLightFactor - 0.5) * uCloudShadowContrast + 0.5, 0.0, 1.0);
          cloudLightFactor = max(cloudLightFactor, clamp(uCloudShadowMinLight, 0.0, 1.0));

          // Treat cloud cover as an overall strength multiplier, but keep the
          // spatial modulation coming from the texture.
          float k = clamp(uCloudInfluence * clamp(uCloudCover, 0.0, 1.0), 0.0, 1.0);
          envFactor *= mix(1.0, cloudLightFactor, k);
        }

        // Night Dimming
        float nightFactor = uDarknessLevel * uNightDimming;
        envFactor *= (1.0 - clamp(nightFactor, 0.0, 1.0));

        float skyK = clamp(uSkyIntensity, 0.0, 1.0) * step(0.5, uUseSkyTint) * max(uSkyTintStrength, 0.0);
        float skyColorMix = clamp(skyK * 0.35, 0.0, 1.0);
        float skyDimMix = clamp(skyK * 0.25, 0.0, 1.0);
        vec3 skyTinted = msApplySkyWhiteBalance(uColor, uSkyTemperature, uSkyTint);
        vec3 finalColor = mix(uColor, skyTinted, skyColorMix);
        envFactor *= (1.0 - skyDimMix);

        // 5. Final Light Composition
        float flashIntensityBoost = max(uLightningWindowIntensityBoost, 0.0);
        float flashMul = 1.0 + flash01 * flashIntensityBoost;
        vec3 finalLight = lightMap * finalColor * uIntensity * indoorFactor * envFactor * flashMul;
        finalLight *= roofSuppression;

        if (waterMask > 0.0001) {
          float kDark = clamp(uRainDarken, 0.0, 1.0);
          float g = max(uRainDarkenGamma, 0.0001);
          float dm = pow(clamp(waterMask, 0.0, 1.0), g);
          finalLight *= (1.0 - dm * kDark);

          vec3 lightDir = normalize(vec3(-0.5, 1.0, 0.5));
          float blurK = clamp(max(0.0, uRainBlurPx) / 8.0, 0.0, 1.0);
          float specPow = mix(12.0, 4.0, blurK);
          float spec = pow(max(dot(rainNormal, lightDir), 0.0), specPow);
          finalLight += finalColor * spec * 1.5 * waterMask * uIntensity * indoorFactor * envFactor * flashMul;
        }

        // 6. Specular Glint
        if (uSpecularBoost > 0.0 && uHasSpecularMask > 0.5) {
            float spec = texture2D(uSpecularMask, uv).r;
            finalLight += finalLight * spec * uSpecularBoost;
        }

        // Additive overlay: output ONLY the light contribution.
        gl_FragColor = vec4(finalLight, 1.0);
      }
    `;
  }

  update(timeInfo) {
    const mat = this.material;
    const lmat = this.lightMaterial;
    const u = mat?.uniforms || null;
    const lu = lmat?.uniforms || null;

    if (!u && !lu) return;

    if (this.mesh) {
      this.mesh.visible = this._enabled && this.params.hasWindowMask;
    }

    if (!this._enabled || !this.params.hasWindowMask) return;

    if (u?.uTime) u.uTime.value = timeInfo.elapsed;
    if (lu?.uTime) lu.uTime.value = timeInfo.elapsed;

    // Sun-tracking: compute sun direction from time of day (same math as
    // BuildingShadowsEffect / OverheadShadowsEffect for visual consistency).
    if (this.params.sunLightEnabled) {
      const THREE = window.THREE;
      let hour = 12.0;
      try {
        if (weatherController && typeof weatherController.timeOfDay === 'number') {
          hour = weatherController.timeOfDay;
        }
      } catch (e) { /* default noon */ }

      const t = (hour % 24.0) / 24.0;
      const azimuth = (t - 0.5) * Math.PI;
      const sx = -Math.sin(azimuth);
      const lat = Math.max(0.0, Math.min(1.0, this.params.sunLightLatitude ?? 0.1));
      const sy = -Math.cos(azimuth) * lat;

      if (!this._sunDir && THREE) {
        this._sunDir = new THREE.Vector2(sx, sy);
      } else if (this._sunDir) {
        this._sunDir.set(sx, sy);
      }
    }

    // Push sun-tracking uniforms to both materials
    const applySunUniforms = (uu) => {
      if (!uu) return;
      if (uu.uSunLightEnabled) uu.uSunLightEnabled.value = this.params.sunLightEnabled ? 1.0 : 0.0;
      if (uu.uSunLightLength) uu.uSunLightLength.value = this.params.sunLightLength;
      if (uu.uSunDir && this._sunDir) uu.uSunDir.value.copy(this._sunDir);
    };
    applySunUniforms(u);
    applySunUniforms(lu);

    // Sync environment
    let fogDensity = 0.0;
    try {
      const wcDisabled = (weatherController && weatherController.enabled === false && weatherController.dynamicEnabled !== true);
      if (!wcDisabled && weatherController?.getCurrentState) {
        const state = weatherController.getCurrentState();
        if (state && typeof state.fogDensity === 'number') fogDensity = state.fogDensity;
      }
    } catch (e) {}
    fogDensity = (typeof fogDensity === 'number' && Number.isFinite(fogDensity))
      ? Math.max(0.0, Math.min(1.0, fogDensity))
      : 0.0;

    // Full fog should reduce window light to 30% of its normal value.
    const fogDim = 1.0 - 0.7 * fogDensity;
    const effectiveIntensity = this.params.intensity * fogDim;

    let cloudCover = 0.0;
    try {
        const wcDisabled = (weatherController && weatherController.enabled === false && weatherController.dynamicEnabled !== true);
        if (!wcDisabled && weatherController?.getCurrentState) {
            const state = weatherController.getCurrentState();
            if (state && typeof state.cloudCover === 'number') cloudCover = state.cloudCover;
        } else {
            const cloudEffect = window.MapShine?.cloudEffect;
            if (cloudEffect?.params?.cloudCover !== undefined) cloudCover = cloudEffect.params.cloudCover;
        }
    } catch(e) {}
    const nextCloudCover = Math.max(0.0, Math.min(1.0, cloudCover));
    if (u?.uCloudCover) u.uCloudCover.value = nextCloudCover;
    if (lu?.uCloudCover) lu.uCloudCover.value = nextCloudCover;

    let darkness = 0.0;
    try {
      const le = window.MapShine?.lightingEffect;
      if (le && typeof le.getEffectiveDarkness === 'function') {
        darkness = le.getEffectiveDarkness();
      } else if (typeof canvas?.environment?.darknessLevel === 'number') {
        darkness = canvas.environment.darknessLevel;
      } else if (typeof canvas?.scene?.environment?.darknessLevel === 'number') {
        darkness = canvas.scene.environment.darknessLevel;
      }
    } catch (e) {}

    darkness = (typeof darkness === 'number' && Number.isFinite(darkness))
      ? Math.max(0.0, Math.min(1.0, darkness))
      : 0.0;
    if (u?.uDarknessLevel) u.uDarknessLevel.value = darkness;
    if (lu?.uDarknessLevel) lu.uDarknessLevel.value = darkness;

    // Sky Color influence (time-of-day grading)
    try {
      const sky = window.MapShine?.skyColorEffect;
      const su = sky?.material?.uniforms;
      const skyIntensity = (typeof sky?.params?.intensity === 'number' && Number.isFinite(sky.params.intensity))
        ? Math.max(0.0, Math.min(1.0, sky.params.intensity))
        : 0.0;
      const skyTemp = (typeof su?.uTemperature?.value === 'number' && Number.isFinite(su.uTemperature.value))
        ? Math.max(-1.0, Math.min(1.0, su.uTemperature.value))
        : 0.0;
      const skyTint = (typeof su?.uTint?.value === 'number' && Number.isFinite(su.uTint.value))
        ? Math.max(-1.0, Math.min(1.0, su.uTint.value))
        : 0.0;

      if (u?.uSkyIntensity) {
        u.uSkyIntensity.value = skyIntensity;
        u.uSkyTemperature.value = skyTemp;
        u.uSkyTint.value = skyTint;
      }
      if (lu?.uSkyIntensity) {
        lu.uSkyIntensity.value = skyIntensity;
        lu.uSkyTemperature.value = skyTemp;
        lu.uSkyTint.value = skyTint;
      }
    } catch (e) {
      if (u?.uSkyIntensity) {
        u.uSkyIntensity.value = 0.0;
        u.uSkyTemperature.value = 0.0;
        u.uSkyTint.value = 0.0;
      }
      if (lu?.uSkyIntensity) {
        lu.uSkyIntensity.value = 0.0;
        lu.uSkyTemperature.value = 0.0;
        lu.uSkyTint.value = 0.0;
      }
    }

    // Cloud Shadows
    try {
        const mm = window.MapShine?.maskManager;
        const mmCloud = mm ? mm.getTexture('cloudShadowRaw.screen') : null;
        const bindCloudShadow = (mat, tex) => {
          if (!mat?.uniforms) return;
          if (tex) {
            mat.uniforms.uCloudShadowMap.value = tex;
            mat.uniforms.uHasCloudShadowMap.value = 1.0;
          } else {
            mat.uniforms.uCloudShadowMap.value = null;
            mat.uniforms.uHasCloudShadowMap.value = 0.0;
          }
        };

        if (mmCloud) {
          bindCloudShadow(this.material, mmCloud);
          bindCloudShadow(this.lightMaterial, mmCloud);
        } else {
          const cloudEffect = window.MapShine?.cloudEffect;
          const tex = (cloudEffect?.cloudShadowRawTarget?.texture && cloudEffect.enabled)
            ? cloudEffect.cloudShadowRawTarget.texture
            : null;
          bindCloudShadow(this.material, tex);
          bindCloudShadow(this.lightMaterial, tex);
        }
    } catch (e) {
        if (u?.uHasCloudShadowMap) {
          u.uHasCloudShadowMap.value = 0.0;
        }
        if (lu?.uHasCloudShadowMap) {
          lu.uHasCloudShadowMap.value = 0.0;
        }
    }

    // Roof alpha binding for overhead-light suppression in WindowLight shaders.
    // This keeps window light from leaking through visible roofs when the
    // overhead-lighting contribution is disabled (or reduced).
    try {
      const roofAlphaTex = window.MapShine?.lightingEffect?.roofAlphaTarget?.texture || null;
      const overheadIntensity = (typeof this.params.overheadLightIntensity === 'number' && Number.isFinite(this.params.overheadLightIntensity))
        ? Math.max(0.0, Math.min(1.0, this.params.overheadLightIntensity))
        : 1.0;
      const overheadSuppression = this.params.lightOverheadTiles ? (1.0 - overheadIntensity) : 1.0;

      const bindRoofAlpha = (uu) => {
        if (!uu) return;
        if (uu.uRoofAlphaMap) uu.uRoofAlphaMap.value = roofAlphaTex;
        if (uu.uHasRoofAlphaMap) uu.uHasRoofAlphaMap.value = roofAlphaTex ? 1.0 : 0.0;
        if (uu.uOverheadMaskSuppression) uu.uOverheadMaskSuppression.value = overheadSuppression;
      };

      bindRoofAlpha(u);
      bindRoofAlpha(lu);
    } catch (e) {
      if (u?.uHasRoofAlphaMap) u.uHasRoofAlphaMap.value = 0.0;
      if (lu?.uHasRoofAlphaMap) lu.uHasRoofAlphaMap.value = 0.0;
      if (u?.uOverheadMaskSuppression) u.uOverheadMaskSuppression.value = 0.0;
      if (lu?.uOverheadMaskSuppression) lu.uOverheadMaskSuppression.value = 0.0;
    }

    // Update Params
    if (u) {
      if (u.uIntensity) u.uIntensity.value = effectiveIntensity;
      if (u.uFalloff) u.uFalloff.value = this.params.falloff;
      if (u.uColor) this._applyThreeColor(u.uColor.value, this.params.color);
      if (u.uCloudInfluence) u.uCloudInfluence.value = this.params.cloudInfluence;
      if (u.uNightDimming) u.uNightDimming.value = this.params.nightDimming;
      if (u.uUseSkyTint) u.uUseSkyTint.value = this.params.useSkyTint ? 1.0 : 0.0;
      if (u.uSkyTintStrength) u.uSkyTintStrength.value = this.params.skyTintStrength;
      if (u.uCloudShadowContrast) u.uCloudShadowContrast.value = this.params.cloudShadowContrast;
      if (u.uCloudShadowBias) u.uCloudShadowBias.value = this.params.cloudShadowBias;
      if (u.uCloudShadowGamma) u.uCloudShadowGamma.value = this.params.cloudShadowGamma;
      if (u.uCloudShadowMinLight) u.uCloudShadowMinLight.value = this.params.cloudShadowMinLight;
      if (u.uSpecularBoost) u.uSpecularBoost.value = this.params.specularBoost;
      if (u.uRgbShiftAmount) u.uRgbShiftAmount.value = this.params.rgbShiftAmount;
      if (u.uRgbShiftAngle) u.uRgbShiftAngle.value = this.params.rgbShiftAngle * (Math.PI / 180.0);
    }

    if (lu) {
      if (lu.uIntensity) lu.uIntensity.value = effectiveIntensity;
      if (lu.uFalloff) lu.uFalloff.value = this.params.falloff;
      if (lu.uColor) this._applyThreeColor(lu.uColor.value, this.params.color);
      if (lu.uCloudInfluence) lu.uCloudInfluence.value = this.params.cloudInfluence;
      if (lu.uNightDimming) lu.uNightDimming.value = this.params.nightDimming;
      if (lu.uUseSkyTint) lu.uUseSkyTint.value = this.params.useSkyTint ? 1.0 : 0.0;
      if (lu.uSkyTintStrength) lu.uSkyTintStrength.value = this.params.skyTintStrength;
      if (lu.uCloudShadowContrast) lu.uCloudShadowContrast.value = this.params.cloudShadowContrast;
      if (lu.uCloudShadowBias) lu.uCloudShadowBias.value = this.params.cloudShadowBias;
      if (lu.uCloudShadowGamma) lu.uCloudShadowGamma.value = this.params.cloudShadowGamma;
      if (lu.uCloudShadowMinLight) lu.uCloudShadowMinLight.value = this.params.cloudShadowMinLight;

      if (lu.uRgbShiftAmount) lu.uRgbShiftAmount.value = this.params.rgbShiftAmount;
      if (lu.uRgbShiftAngle) lu.uRgbShiftAngle.value = this.params.rgbShiftAngle * (Math.PI / 180.0);
    }

    // Rain On Glass + Lightning Flash (shared state)
    try {
      const env = window.MapShine?.environment;
      const flash01 = (env && typeof env.lightningFlash01 === 'number' && Number.isFinite(env.lightningFlash01))
        ? Math.max(0.0, Math.min(1.0, env.lightningFlash01))
        : 0.0;

      if (u?.uLightningFlash01) u.uLightningFlash01.value = flash01;
      if (lu?.uLightningFlash01) lu.uLightningFlash01.value = flash01;
    } catch (e) {
      if (u?.uLightningFlash01) u.uLightningFlash01.value = 0.0;
      if (lu?.uLightningFlash01) lu.uLightningFlash01.value = 0.0;
    }

    // Precipitation coupling
    let precip = 0.0;
    let hasWeatherPrecip = false;
    let windSpeed = 0.0;
    let windDir = null;
    try {
      const wcDisabled = (weatherController && weatherController.enabled === false && weatherController.dynamicEnabled !== true);
      if (!wcDisabled && weatherController?.getCurrentState) {
        const state = weatherController.getCurrentState();
        if (state && typeof state.precipitation === 'number') {
          precip = state.precipitation;
          hasWeatherPrecip = true;
        }
        if (state && typeof state.windSpeed === 'number') {
          windSpeed = state.windSpeed;
        }
        if (state && state.windDirection && typeof state.windDirection.x === 'number' && typeof state.windDirection.y === 'number') {
          windDir = state.windDirection;
        }
      }
    } catch (e) {
    }

    precip = (typeof precip === 'number' && Number.isFinite(precip)) ? Math.max(0.0, Math.min(1.0, precip)) : 0.0;

    windSpeed = (typeof windSpeed === 'number' && Number.isFinite(windSpeed)) ? Math.max(0.0, Math.min(1.0, windSpeed)) : 0.0;
    try {
      if (windDir && this._tmpWindDir) {
        const x = windDir.x;
        const y = windDir.y;
        if (Number.isFinite(x) && Number.isFinite(y)) {
          this._tmpWindDir.set(x, y);
        }
      }
    } catch (e) {
    }
    if (u?.uWindSpeed) u.uWindSpeed.value = windSpeed;
    if (lu?.uWindSpeed) lu.uWindSpeed.value = windSpeed;

    const rainEnabled = !!this.params.rainOnGlassEnabled;
    const rainIntensity = (typeof this.params.rainOnGlassIntensity === 'number' && Number.isFinite(this.params.rainOnGlassIntensity))
      ? Math.max(0.0, this.params.rainOnGlassIntensity)
      : 0.0;
    const start = (typeof this.params.rainOnGlassPrecipStart === 'number' && Number.isFinite(this.params.rainOnGlassPrecipStart))
      ? Math.max(0.0, Math.min(1.0, this.params.rainOnGlassPrecipStart))
      : 0.0;
    const full = (typeof this.params.rainOnGlassPrecipFull === 'number' && Number.isFinite(this.params.rainOnGlassPrecipFull))
      ? Math.max(0.0, Math.min(1.0, this.params.rainOnGlassPrecipFull))
      : 1.0;

    if (!hasWeatherPrecip && rainEnabled) {
      precip = full;
    }

    const denom = Math.max(1e-4, full - start);
    const rainK = rainEnabled ? Math.max(0.0, Math.min(1.0, (precip - start) / denom)) * rainIntensity : 0.0;

    if (u?.uRainK) u.uRainK.value = rainK;
    if (lu?.uRainK) lu.uRainK.value = rainK;

    // Direction vector is shared by both materials (uniform references the same Vector2).
    try {
      if (this._tmpRainDir) {
        // Convert degrees to radians and apply direction
        const angleRad = this.params.rainOnGlassDirectionDeg * (Math.PI / 180.0);
        this._tmpRainDir.set(Math.sin(angleRad), -Math.cos(angleRad));
      }
    } catch (e) {
    }

    try {
      this._ensureRainFlowMap();
      if (u?.uRainFlowMap) u.uRainFlowMap.value = this._rainFlowMap;
      if (lu?.uRainFlowMap) lu.uRainFlowMap.value = this._rainFlowMap;
      if (u?.uHasRainFlowMap) u.uHasRainFlowMap.value = this._rainFlowMap ? 1.0 : 0.0;
      if (lu?.uHasRainFlowMap) lu.uHasRainFlowMap.value = this._rainFlowMap ? 1.0 : 0.0;
    } catch (e) {
    }

    try {
      const wpTex = window.MapShineParticles?.weatherParticles?.splashTexture || null;
      if (u?.uRainSplashAtlas) u.uRainSplashAtlas.value = wpTex;
      if (lu?.uRainSplashAtlas) lu.uRainSplashAtlas.value = wpTex;
      if (u?.uHasRainSplashAtlas) u.uHasRainSplashAtlas.value = wpTex ? 1.0 : 0.0;
      if (lu?.uHasRainSplashAtlas) lu.uHasRainSplashAtlas.value = wpTex ? 1.0 : 0.0;
    } catch (e) {
      if (u?.uHasRainSplashAtlas) u.uHasRainSplashAtlas.value = 0.0;
      if (lu?.uHasRainSplashAtlas) lu.uHasRainSplashAtlas.value = 0.0;
    }

    // Keep per-frame param uniforms in sync
    const applyRainParams = (uu) => {
      if (!uu) return;
      if (uu.uRainSpeed) uu.uRainSpeed.value = this.params.rainOnGlassSpeed;
      if (uu.uRainFlowStrength) uu.uRainFlowStrength.value = this.params.rainOnGlassBoundaryFlowStrength;
      if (uu.uRainFlowWidth) uu.uRainFlowWidth.value = this.params.rainFlowWidth;
      if (uu.uRainRoofPlateauStrength) uu.uRainRoofPlateauStrength.value = this.params.rainRoofPlateauStrength;
      if (uu.uRainRoofPlateauStart) uu.uRainRoofPlateauStart.value = this.params.rainRoofPlateauStart;
      if (uu.uRainRoofPlateauFeather) uu.uRainRoofPlateauFeather.value = this.params.rainRoofPlateauFeather;
      if (uu.uRainDebugRoofPlateau) uu.uRainDebugRoofPlateau.value = this.params.rainDebugRoofPlateau ? 1.0 : 0.0;
      if (uu.uRainDebugFlowMap) uu.uRainDebugFlowMap.value = this.params.rainDebugFlowMap;
      if (uu.uRainMaxOffsetPx) uu.uRainMaxOffsetPx.value = this.params.rainOnGlassMaxOffsetPx;
      if (uu.uRainBlurPx) uu.uRainBlurPx.value = this.params.rainOnGlassBlurPx;
      if (uu.uRainDistortionFeatherPx) uu.uRainDistortionFeatherPx.value = this.params.rainOnGlassDistortionFeatherPx;
      if (uu.uRainDistortionMasking) uu.uRainDistortionMasking.value = this.params.rainOnGlassDistortionMasking;
      if (uu.uRainDarken) uu.uRainDarken.value = this.params.rainOnGlassDarken;
      if (uu.uRainDarkenGamma) uu.uRainDarkenGamma.value = this.params.rainOnGlassDarkenGamma;
      if (uu.uRainSplashIntensity) uu.uRainSplashIntensity.value = this.params.rainSplashIntensity;
      if (uu.uRainSplashMaxOffsetPx) uu.uRainSplashMaxOffsetPx.value = this.params.rainSplashMaxOffsetPx;
      if (uu.uRainSplashScale) uu.uRainSplashScale.value = this.params.rainSplashScale;
      if (uu.uRainSplashMaskScale) uu.uRainSplashMaskScale.value = this.params.rainSplashMaskScale;
      if (uu.uRainSplashThreshold) uu.uRainSplashThreshold.value = this.params.rainSplashThreshold;
      if (uu.uRainSplashMaskThreshold) uu.uRainSplashMaskThreshold.value = this.params.rainSplashMaskThreshold;
      if (uu.uRainSplashMaskFeather) uu.uRainSplashMaskFeather.value = this.params.rainSplashMaskFeather;
      if (uu.uRainSplashSpeed) uu.uRainSplashSpeed.value = this.params.rainSplashSpeed;
      if (uu.uRainSplashSpawnRate) uu.uRainSplashSpawnRate.value = this.params.rainSplashSpawnRate;
      if (uu.uRainSplashRadiusPx) uu.uRainSplashRadiusPx.value = this.params.rainSplashRadiusPx;
      if (uu.uRainSplashExpand) uu.uRainSplashExpand.value = this.params.rainSplashExpand;
      if (uu.uRainSplashFadePow) uu.uRainSplashFadePow.value = this.params.rainSplashFadePow;
      if (uu.uRainSplashLayers) uu.uRainSplashLayers.value = this.params.rainSplashLayers;
      if (uu.uRainSplashDriftPx) uu.uRainSplashDriftPx.value = this.params.rainSplashDriftPx;
      if (uu.uRainSplashSizeJitter) uu.uRainSplashSizeJitter.value = this.params.rainSplashSizeJitter;
      if (uu.uRainSplashBlob) uu.uRainSplashBlob.value = this.params.rainSplashBlob;
      if (uu.uRainSplashStreakStrength) uu.uRainSplashStreakStrength.value = this.params.rainSplashStreakStrength;
      if (uu.uRainSplashStreakLengthPx) uu.uRainSplashStreakLengthPx.value = this.params.rainSplashStreakLengthPx;
      if (uu.uRainSplashAtlasTile0) uu.uRainSplashAtlasTile0.value = this.params.rainSplashAtlasTile0 ? 1.0 : 0.0;
      if (uu.uRainSplashAtlasTile1) uu.uRainSplashAtlasTile1.value = this.params.rainSplashAtlasTile1 ? 1.0 : 0.0;
      if (uu.uRainSplashAtlasTile2) uu.uRainSplashAtlasTile2.value = this.params.rainSplashAtlasTile2 ? 1.0 : 0.0;
      if (uu.uRainSplashAtlasTile3) uu.uRainSplashAtlasTile3.value = this.params.rainSplashAtlasTile3 ? 1.0 : 0.0;
      if (uu.uRainNoiseScale) uu.uRainNoiseScale.value = this.params.rainNoiseScale;
      if (uu.uRainNoiseDetail) uu.uRainNoiseDetail.value = this.params.rainNoiseDetail;
      if (uu.uRainNoiseEvolution) uu.uRainNoiseEvolution.value = this.params.rainNoiseEvolution;
      if (uu.uRainRivuletAspect) uu.uRainRivuletAspect.value = this.params.rainRivuletAspect;
      if (uu.uRainRivuletGain) uu.uRainRivuletGain.value = this.params.rainRivuletGain;
      if (uu.uRainRivuletStrength) uu.uRainRivuletStrength.value = this.params.rainRivuletStrength;
      if (uu.uRainRivuletThreshold) uu.uRainRivuletThreshold.value = this.params.rainRivuletThreshold;
      if (uu.uRainRivuletFeather) uu.uRainRivuletFeather.value = this.params.rainRivuletFeather;
      if (uu.uRainRivuletGamma) uu.uRainRivuletGamma.value = this.params.rainRivuletGamma;
      if (uu.uRainRivuletSoftness) uu.uRainRivuletSoftness.value = this.params.rainRivuletSoftness;
      if (uu.uRainRivuletDistanceMasking) uu.uRainRivuletDistanceMasking.value = this.params.rainRivuletDistanceMasking;
      if (uu.uRainRivuletDistanceStart) uu.uRainRivuletDistanceStart.value = this.params.rainRivuletDistanceStart;
      if (uu.uRainRivuletDistanceEnd) uu.uRainRivuletDistanceEnd.value = this.params.rainRivuletDistanceEnd;
      if (uu.uRainRivuletDistanceFeather) uu.uRainRivuletDistanceFeather.value = this.params.rainRivuletDistanceFeather;
      if (uu.uRainRivuletRidgeMix) uu.uRainRivuletRidgeMix.value = this.params.rainRivuletRidgeMix;
      if (uu.uRainRivuletRidgeGain) uu.uRainRivuletRidgeGain.value = this.params.rainRivuletRidgeGain;
      if (uu.uRainBrightThreshold) uu.uRainBrightThreshold.value = this.params.rainOnGlassBrightThreshold;
      if (uu.uRainBrightFeather) uu.uRainBrightFeather.value = this.params.rainOnGlassBrightFeather;

      if (uu.uRainFlowInvertTangent) uu.uRainFlowInvertTangent.value = this.params.rainFlowInvertTangent ? 1.0 : 0.0;
      if (uu.uRainFlowInvertNormal) uu.uRainFlowInvertNormal.value = this.params.rainFlowInvertNormal ? 1.0 : 0.0;
      if (uu.uRainFlowSwapAxes) uu.uRainFlowSwapAxes.value = this.params.rainFlowSwapAxes ? 1.0 : 0.0;
      if (uu.uRainFlowAdvectScale) uu.uRainFlowAdvectScale.value = this.params.rainFlowAdvectScale;
      if (uu.uRainFlowEvoScale) uu.uRainFlowEvoScale.value = this.params.rainFlowEvoScale;
      if (uu.uRainFlowPerpScale) uu.uRainFlowPerpScale.value = this.params.rainFlowPerpScale;
      if (uu.uRainFlowGlobalInfluence) uu.uRainFlowGlobalInfluence.value = this.params.rainFlowGlobalInfluence;
      if (uu.uRainFlowAngleOffset) uu.uRainFlowAngleOffset.value = this.params.rainFlowAngleOffset * (Math.PI / 180.0);
      if (uu.uRainFlowFlipDeadzone) uu.uRainFlowFlipDeadzone.value = this.params.rainFlowFlipDeadzone;
      if (uu.uRainFlowMaxTurn) uu.uRainFlowMaxTurn.value = (this.params.rainFlowMaxTurnDeg * Math.PI) / 180.0;

      if (uu.uLightningWindowEnabled) uu.uLightningWindowEnabled.value = this.params.lightningWindowEnabled ? 1.0 : 0.0;
      if (uu.uLightningWindowIntensityBoost) uu.uLightningWindowIntensityBoost.value = this.params.lightningWindowIntensityBoost;
      if (uu.uLightningWindowContrastBoost) uu.uLightningWindowContrastBoost.value = this.params.lightningWindowContrastBoost;
      if (uu.uLightningWindowRgbBoost) uu.uLightningWindowRgbBoost.value = this.params.lightningWindowRgbBoost;
    };

    applyRainParams(u);
    applyRainParams(lu);
  }

  onResize(width, height) {
    const THREE = window.THREE;
    let w = width;
    let h = height;
    try {
      if (THREE && this.renderer && typeof this.renderer.getDrawingBufferSize === 'function') {
        if (!this._tmpDrawSize) this._tmpDrawSize = new THREE.Vector2();
        this.renderer.getDrawingBufferSize(this._tmpDrawSize);
        w = Math.max(1, Math.floor(this._tmpDrawSize.x || w));
        h = Math.max(1, Math.floor(this._tmpDrawSize.y || h));
      }
    } catch (e) {}

    if (this.material?.uniforms?.uResolution?.value) this.material.uniforms.uResolution.value.set(w, h);
    if (this.lightMaterial?.uniforms?.uResolution?.value) this.lightMaterial.uniforms.uResolution.value.set(w, h);
    if (this.lightTarget) this.lightTarget.setSize(w, h);
  }

  createLightTarget() {
    const THREE = window.THREE;
    if (!THREE || !this.baseMesh || !this.windowMask) return;

    if (!this._tmpRainDir) this._tmpRainDir = new THREE.Vector2(0, 1);
    if (!this._tmpWindDir) this._tmpWindDir = new THREE.Vector2(1, 0);

    // Use current resolution
    let width = window.innerWidth;
    let height = window.innerHeight;
    try {
        if (this.renderer) {
            const size = new THREE.Vector2();
            this.renderer.getDrawingBufferSize(size);
            width = size.x;
            height = size.y;
        }
    } catch(e) {}

    this.lightTarget = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType
    });

    this.lightScene = new THREE.Scene();

    this.lightMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uResolution: { value: new THREE.Vector2(width, height) },
        uWindowMask: { value: this.windowMask },
        uOutdoorsMask: { value: this.outdoorsMask },
        uWindowTexelSize: {
          value: this.windowMask && this.windowMask.image
            ? new THREE.Vector2(1 / this.windowMask.image.width, 1 / this.windowMask.image.height)
            : new THREE.Vector2(1 / 1024, 1 / 1024)
        },
        uHasOutdoorsMask: { value: this.outdoorsMask ? 1.0 : 0.0 },

        uRgbShiftAmount: { value: this.params.rgbShiftAmount },
        uRgbShiftAngle: { value: this.params.rgbShiftAngle * (Math.PI / 180.0) },

        uIntensity: { value: this.params.intensity },
        uFalloff: { value: this.params.falloff },
        uColor: { value: new THREE.Color(this.params.color.r, this.params.color.g, this.params.color.b) },

        uCloudCover: { value: 0.0 },
        uCloudInfluence: { value: this.params.cloudInfluence },
        uDarknessLevel: { value: 0.0 },
        uNightDimming: { value: this.params.nightDimming },

        uSkyIntensity: { value: 0.0 },
        uSkyTemperature: { value: 0.0 },
        uSkyTint: { value: 0.0 },
        uUseSkyTint: { value: this.params.useSkyTint ? 1.0 : 0.0 },
        uSkyTintStrength: { value: this.params.skyTintStrength },

        uCloudShadowContrast: { value: this.params.cloudShadowContrast },
        uCloudShadowBias: { value: this.params.cloudShadowBias },
        uCloudShadowGamma: { value: this.params.cloudShadowGamma },
        uCloudShadowMinLight: { value: this.params.cloudShadowMinLight },

        uCloudShadowMap: { value: null },
        uHasCloudShadowMap: { value: 0.0 }
        ,
        uRoofAlphaMap: { value: null },
        uHasRoofAlphaMap: { value: 0.0 },
        uOverheadMaskSuppression: { value: 0.0 },
        uTime: { value: 0.0 },

        uRainK: { value: 0.0 },
        uRainSpeed: { value: this.params.rainOnGlassSpeed },
        uRainDir: { value: this._tmpRainDir },
        uWindDir: { value: this._tmpWindDir },
        uWindSpeed: { value: 0.0 },
        uRainFlowMap: { value: this._rainFlowMap },
        uHasRainFlowMap: { value: this._rainFlowMap ? 1.0 : 0.0 },
        uRainFlowStrength: { value: this.params.rainOnGlassBoundaryFlowStrength },
        uRainFlowWidth: { value: this.params.rainFlowWidth },
        uRainRoofPlateauStrength: { value: this.params.rainRoofPlateauStrength },
        uRainRoofPlateauStart: { value: this.params.rainRoofPlateauStart },
        uRainRoofPlateauFeather: { value: this.params.rainRoofPlateauFeather },
        uRainDebugRoofPlateau: { value: this.params.rainDebugRoofPlateau ? 1.0 : 0.0 },
        uRainDebugFlowMap: { value: this.params.rainDebugFlowMap },
        uRainMaxOffsetPx: { value: this.params.rainOnGlassMaxOffsetPx },
        uRainBlurPx: { value: this.params.rainOnGlassBlurPx },
        uRainDistortionFeatherPx: { value: this.params.rainOnGlassDistortionFeatherPx },
        uRainDistortionMasking: { value: this.params.rainOnGlassDistortionMasking },
        uRainDarken: { value: this.params.rainOnGlassDarken },
        uRainDarkenGamma: { value: this.params.rainOnGlassDarkenGamma },
        uRainSplashIntensity: { value: this.params.rainSplashIntensity },
        uRainSplashMaxOffsetPx: { value: this.params.rainSplashMaxOffsetPx },
        uRainSplashScale: { value: this.params.rainSplashScale },
        uRainSplashMaskScale: { value: this.params.rainSplashMaskScale },
        uRainSplashThreshold: { value: this.params.rainSplashThreshold },
        uRainSplashMaskThreshold: { value: this.params.rainSplashMaskThreshold },
        uRainSplashMaskFeather: { value: this.params.rainSplashMaskFeather },
        uRainSplashSpeed: { value: this.params.rainSplashSpeed },
        uRainSplashSpawnRate: { value: this.params.rainSplashSpawnRate },
        uRainSplashRadiusPx: { value: this.params.rainSplashRadiusPx },
        uRainSplashExpand: { value: this.params.rainSplashExpand },
        uRainSplashFadePow: { value: this.params.rainSplashFadePow },
        uRainSplashLayers: { value: this.params.rainSplashLayers },
        uRainSplashDriftPx: { value: this.params.rainSplashDriftPx },
        uRainSplashSizeJitter: { value: this.params.rainSplashSizeJitter },
        uRainSplashBlob: { value: this.params.rainSplashBlob },
        uRainSplashStreakStrength: { value: this.params.rainSplashStreakStrength },
        uRainSplashStreakLengthPx: { value: this.params.rainSplashStreakLengthPx },
        uRainSplashAtlas: { value: null },
        uHasRainSplashAtlas: { value: 0.0 },
        uRainSplashAtlasTile0: { value: this.params.rainSplashAtlasTile0 ? 1.0 : 0.0 },
        uRainSplashAtlasTile1: { value: this.params.rainSplashAtlasTile1 ? 1.0 : 0.0 },
        uRainSplashAtlasTile2: { value: this.params.rainSplashAtlasTile2 ? 1.0 : 0.0 },
        uRainSplashAtlasTile3: { value: this.params.rainSplashAtlasTile3 ? 1.0 : 0.0 },
        uRainNoiseScale: { value: this.params.rainNoiseScale },
        uRainNoiseDetail: { value: this.params.rainNoiseDetail },
        uRainNoiseEvolution: { value: this.params.rainNoiseEvolution },
        uRainRivuletAspect: { value: this.params.rainRivuletAspect },
        uRainRivuletGain: { value: this.params.rainRivuletGain },
        uRainRivuletStrength: { value: this.params.rainRivuletStrength },
        uRainRivuletThreshold: { value: this.params.rainRivuletThreshold },
        uRainRivuletFeather: { value: this.params.rainRivuletFeather },
        uRainRivuletGamma: { value: this.params.rainRivuletGamma },
        uRainRivuletSoftness: { value: this.params.rainRivuletSoftness },
        uRainRivuletDistanceMasking: { value: this.params.rainRivuletDistanceMasking },
        uRainRivuletDistanceStart: { value: this.params.rainRivuletDistanceStart },
        uRainRivuletDistanceEnd: { value: this.params.rainRivuletDistanceEnd },
        uRainRivuletDistanceFeather: { value: this.params.rainRivuletDistanceFeather },
        uRainRivuletRidgeMix: { value: this.params.rainRivuletRidgeMix },
        uRainRivuletRidgeGain: { value: this.params.rainRivuletRidgeGain },
        uRainBrightThreshold: { value: this.params.rainOnGlassBrightThreshold },
        uRainBrightFeather: { value: this.params.rainOnGlassBrightFeather },

        uRainFlowInvertTangent: { value: this.params.rainFlowInvertTangent ? 1.0 : 0.0 },
        uRainFlowInvertNormal: { value: this.params.rainFlowInvertNormal ? 1.0 : 0.0 },
        uRainFlowSwapAxes: { value: this.params.rainFlowSwapAxes ? 1.0 : 0.0 },
        uRainFlowAdvectScale: { value: this.params.rainFlowAdvectScale },
        uRainFlowEvoScale: { value: this.params.rainFlowEvoScale },
        uRainFlowPerpScale: { value: this.params.rainFlowPerpScale },
        uRainFlowGlobalInfluence: { value: this.params.rainFlowGlobalInfluence },
        uRainFlowAngleOffset: { value: this.params.rainFlowAngleOffset * (Math.PI / 180.0) },
        uRainFlowFlipDeadzone: { value: this.params.rainFlowFlipDeadzone },
        uRainFlowMaxTurn: { value: (this.params.rainFlowMaxTurnDeg * Math.PI) / 180.0 },

        uLightningFlash01: { value: 0.0 },
        uLightningWindowEnabled: { value: this.params.lightningWindowEnabled ? 1.0 : 0.0 },
        uLightningWindowIntensityBoost: { value: this.params.lightningWindowIntensityBoost },
        uLightningWindowContrastBoost: { value: this.params.lightningWindowContrastBoost },
        uLightningWindowRgbBoost: { value: this.params.lightningWindowRgbBoost },

        // Sun-tracking offset uniforms
        uSunLightEnabled: { value: this.params.sunLightEnabled ? 1.0 : 0.0 },
        uSunLightLength: { value: this.params.sunLightLength },
        uSunDir: { value: new THREE.Vector2(0.0, 0.0) }
      },
      vertexShader: this.getVertexShader(),
      fragmentShader: this.getLightOnlyFragmentShader(),
      transparent: false,
      depthWrite: false,
      depthTest: false
    });

    this.lightMesh = new THREE.Mesh(this.baseMesh.geometry, this.lightMaterial);
    this.lightMesh.position.copy(this.baseMesh.position);
    this.lightMesh.rotation.copy(this.baseMesh.rotation);
    this.lightMesh.scale.copy(this.baseMesh.scale);

    this.lightScene.add(this.lightMesh);
    log.info('Window light target created for overhead tile lighting');
  }

  getLightOnlyFragmentShader() {
    return `
      uniform sampler2D uWindowMask;
      uniform sampler2D uOutdoorsMask;
      uniform float uHasOutdoorsMask;

      uniform vec2 uWindowTexelSize;

      uniform float uRgbShiftAmount;
      uniform float uRgbShiftAngle;
      
      uniform float uIntensity;
      uniform float uFalloff;
      uniform vec3 uColor;

      uniform float uCloudCover;
      uniform float uCloudInfluence;
      uniform float uDarknessLevel;
      uniform float uNightDimming;

      uniform float uSkyIntensity;
      uniform float uSkyTemperature;
      uniform float uSkyTint;
      uniform float uUseSkyTint;
      uniform float uSkyTintStrength;

      uniform float uCloudShadowContrast;
      uniform float uCloudShadowBias;
      uniform float uCloudShadowGamma;
      uniform float uCloudShadowMinLight;

      uniform sampler2D uCloudShadowMap;
      uniform float uHasCloudShadowMap;
      uniform sampler2D uRoofAlphaMap;
      uniform float uHasRoofAlphaMap;
      uniform float uOverheadMaskSuppression;

      uniform float uTime;

      uniform float uRainK;
      uniform float uRainSpeed;
      uniform vec2  uRainDir;
      uniform vec2  uWindDir;
      uniform float uWindSpeed;
      uniform sampler2D uRainFlowMap;
      uniform float uHasRainFlowMap;
      uniform float uRainFlowStrength;
      uniform float uRainFlowWidth;
      uniform float uRainRoofPlateauStrength;
      uniform float uRainRoofPlateauStart;
      uniform float uRainRoofPlateauFeather;
      uniform float uRainDebugRoofPlateau;
      uniform float uRainDebugFlowMap;
      uniform float uRainMaxOffsetPx;
      uniform float uRainBlurPx;
      uniform float uRainDistortionFeatherPx;
      uniform float uRainDistortionMasking;
      uniform float uRainDarken;
      uniform float uRainDarkenGamma;
      uniform float uRainSplashIntensity;
      uniform float uRainSplashMaxOffsetPx;
      uniform float uRainSplashScale;
      uniform float uRainSplashMaskScale;
      uniform float uRainSplashThreshold;
      uniform float uRainSplashMaskThreshold;
      uniform float uRainSplashMaskFeather;
      uniform float uRainSplashSpeed;
      uniform float uRainSplashSpawnRate;
      uniform float uRainSplashRadiusPx;
      uniform float uRainSplashExpand;
      uniform float uRainSplashFadePow;
      uniform float uRainSplashLayers;
      uniform float uRainSplashDriftPx;
      uniform float uRainSplashSizeJitter;
      uniform float uRainSplashBlob;
      uniform float uRainSplashStreakStrength;
      uniform float uRainSplashStreakLengthPx;
      uniform sampler2D uRainSplashAtlas;
      uniform float uHasRainSplashAtlas;
      uniform float uRainSplashAtlasTile0;
      uniform float uRainSplashAtlasTile1;
      uniform float uRainSplashAtlasTile2;
      uniform float uRainSplashAtlasTile3;
      uniform float uRainNoiseScale;
      uniform float uRainNoiseDetail;
      uniform float uRainNoiseEvolution;
      uniform float uRainRivuletAspect;
      uniform float uRainRivuletGain;
      uniform float uRainRivuletStrength;
      uniform float uRainRivuletThreshold;
      uniform float uRainRivuletFeather;
      uniform float uRainRivuletGamma;
      uniform float uRainRivuletSoftness;
      uniform float uRainRivuletDistanceMasking;
      uniform float uRainRivuletDistanceStart;
      uniform float uRainRivuletDistanceEnd;
      uniform float uRainRivuletDistanceFeather;
      uniform float uRainRivuletRidgeMix;
      uniform float uRainRivuletRidgeGain;
      uniform float uRainBrightThreshold;
      uniform float uRainBrightFeather;

      uniform float uRainFlowInvertTangent;
      uniform float uRainFlowInvertNormal;
      uniform float uRainFlowSwapAxes;
      uniform float uRainFlowAdvectScale;
      uniform float uRainFlowEvoScale;
      uniform float uRainFlowPerpScale;
      uniform float uRainFlowGlobalInfluence;
      uniform float uRainFlowAngleOffset;
      uniform float uRainFlowFlipDeadzone;
      uniform float uRainFlowMaxTurn;

      uniform float uLightningFlash01;
      uniform float uLightningWindowEnabled;
      uniform float uLightningWindowIntensityBoost;
      uniform float uLightningWindowContrastBoost;
      uniform float uLightningWindowRgbBoost;

      // Sun-tracking offset
      uniform float uSunLightEnabled;
      uniform float uSunLightLength;
      uniform vec2 uSunDir;

      varying vec4 vClipPos;
      varying vec2 vUv;

      float msLuminance(vec3 c) {
        return dot(c, vec3(0.2126, 0.7152, 0.0722));
      }

      vec3 msApplySkyWhiteBalance(vec3 color, float temp, float tint) {
        vec3 tempShift = vec3(1.0 + temp, 1.0, 1.0 - temp);
        if (temp < 0.0) tempShift = vec3(1.0, 1.0, 1.0 - temp * 0.5);
        else tempShift = vec3(1.0 + temp * 0.5, 1.0, 1.0);

        vec3 tintShift = vec3(1.0, 1.0 + tint, 1.0);
        return color * tempShift * tintShift;
      }

      float msHash11(float x) {
        return fract(sin(x * 127.1) * 43758.5453123);
      }

      float msHash21(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }

      vec2 msHash22(vec2 p) {
        float x = dot(p, vec2(127.1, 311.7));
        float y = dot(p, vec2(269.5, 183.3));
        return fract(sin(vec2(x, y)) * 43758.5453123);
      }

      float msValueNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);

        float a = msHash21(i);
        float b = msHash21(i + vec2(1.0, 0.0));
        float c = msHash21(i + vec2(0.0, 1.0));
        float d = msHash21(i + vec2(1.0, 1.0));

        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
      }

      float msFbm(vec2 p, float detail) {
        float v = 0.0;
        float a = 0.5;
        vec2  shift = vec2(100.0, 100.0);

        for (int i = 0; i < 3; i++) {
          float w = step(float(i), detail);
          v += w * a * msValueNoise(p);
          p = p * 2.02 + shift;
          a *= 0.5;
        }
        return v;
      }

      float msFbmBlurred(vec2 p, float detail, vec2 blurStep) {
        float bx = abs(blurStep.x);
        float by = abs(blurStep.y);
        if (max(bx, by) <= 1e-7) return msFbm(p, detail);

        float c0 = msFbm(p, detail);
        float c1 = msFbm(p + vec2( blurStep.x, 0.0), detail);
        float c2 = msFbm(p + vec2(-blurStep.x, 0.0), detail);
        float c3 = msFbm(p + vec2(0.0,  blurStep.y), detail);
        float c4 = msFbm(p + vec2(0.0, -blurStep.y), detail);

        return c0 * 0.40 + (c1 + c2 + c3 + c4) * 0.15;
      }

      void main() {
        // Debug flow map visualization
        if (uRainDebugFlowMap > 0.5) {
          if (uHasRainFlowMap > 0.5) {
            vec3 flowColor = texture2D(uRainFlowMap, vUv).rgb;
            gl_FragColor = vec4(flowColor.r, flowColor.g, flowColor.b, 1.0);
            return;
          } else {
            gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0);
            return;
          }
        }

        if (uRainDebugRoofPlateau > 0.5 && uHasRainFlowMap <= 0.5) {
          gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0);
          return;
        }

        // Sun-tracking offset for the light-only pass (same as main shader)
        vec2 sunOffset = vec2(0.0);
        if (uSunLightEnabled > 0.5) {
          vec2 dir = normalize(uSunDir + vec2(1e-6));
          sunOffset = dir * uSunLightLength;
        }
        vec2 maskUv = vUv + sunOffset;

        float flash01 = clamp(uLightningFlash01, 0.0, 1.0) * step(0.5, uLightningWindowEnabled);
        float rgbBoost = max(uLightningWindowRgbBoost, 0.0);
        float shiftAmountPx = uRgbShiftAmount * (1.0 + flash01 * rgbBoost);

        vec2 uv = maskUv;
        vec3 rainNormal = vec3(0.0, 0.0, 1.0);
        float rainK = clamp(uRainK, 0.0, 4.0);
        float rainKSplash = rainK;
        float baseMaskScalar = msLuminance(texture2D(uWindowMask, maskUv).rgb);
        float baseLightGate = pow(max(baseMaskScalar, 0.0), uFalloff);
        float gateContrastPow = 1.0 / (1.0 + flash01 * max(uLightningWindowContrastBoost, 0.0));
        baseLightGate = pow(max(baseLightGate, 0.0), gateContrastPow);
        float rainKDark = 0.0;
        float waterMask = 0.0;
        if (rainK > 0.001) {
          float bt = clamp(uRainBrightThreshold, 0.0, 1.0);
          float bf = max(uRainBrightFeather, 0.0);
          float brightGate = smoothstep(bt, bt + max(1e-4, bf), baseLightGate);
          rainKDark = rainK * brightGate;

          float aspect = max(1e-6, uWindowTexelSize.y) / max(1e-6, uWindowTexelSize.x);
          vec2 aspectVec = vec2(aspect, 1.0);
          vec2 p = (vUv - 0.5) * aspectVec;

          vec2 globalDir = uRainDir;
          float dLen = max(1e-4, length(globalDir));
          globalDir /= dLen;
          vec2 globalDirP = globalDir * aspectVec;
          float dpLen = max(1e-4, length(globalDirP));
          vec2 dirP = globalDirP / dpLen;
          vec2 perpP = vec2(-dirP.y, dirP.x);

          vec2 rotP = vec2(dot(p, perpP), dot(p, dirP));

          float flowZone = 0.0;
          vec2 flowDirRot = vec2(0.0, 1.0);
          float roofMask = 1.0;
          float distToWall = 0.0;
          if (uHasRainFlowMap > 0.5) {
            vec4 flowSample = texture2D(uRainFlowMap, vUv);

            distToWall = flowSample.b;
            float plateauStrength = clamp(uRainRoofPlateauStrength, 0.0, 1.0);
            float plateauStart = clamp(uRainRoofPlateauStart, 0.0, 1.0);
            float plateauFeather = max(1e-4, uRainRoofPlateauFeather);
            float roof01 = smoothstep(plateauStart, plateauStart + plateauFeather, distToWall);
            roofMask = 1.0 - plateauStrength * roof01;

            if (uRainDebugRoofPlateau > 0.5) {
              gl_FragColor = vec4(roofMask, distToWall, roof01, 1.0);
              return;
            }

            float width = max(uRainFlowWidth, 0.0);
            float widthEff = max(width, 0.0001);
            float feather = max(0.02, widthEff * 0.25);
            flowZone = 1.0 - smoothstep(widthEff, widthEff + feather, distToWall);
            float flowStrength = clamp(max(uRainFlowStrength, 0.0) * flowZone, 0.0, 1.0);

            vec2 localN = flowSample.rg * 2.0 - 1.0;
            if (uRainFlowInvertNormal > 0.5) localN = -localN;
            vec2 localNP = localN * aspectVec;
            float lnLen = max(1e-4, length(localNP));
            localNP /= lnLen;
            vec2 localTP = vec2(-localNP.y, localNP.x);
            if (uRainFlowInvertTangent > 0.5) localTP = -localTP;
            if (uRainFlowSwapAxes > 0.5) localTP = localTP.yx;
            vec2 localTRot = vec2(dot(localTP, perpP), dot(localTP, dirP));
            float ltLen = max(1e-4, length(localTRot));
            vec2 lfN = localTRot / ltLen;
            float oc = cos(uRainFlowAngleOffset);
            float os = sin(uRainFlowAngleOffset);
            vec2 desiredDirRot = mat2(oc, -os, os, oc) * vec2(0.0, 1.0);

            float align = dot(lfN, desiredDirRot);
            float dead = max(1e-6, clamp(uRainFlowFlipDeadzone, 0.0, 1.0));
            float ambig = smoothstep(0.0, dead, abs(align));
            float flipT = smoothstep(-dead, dead, align);
            lfN = normalize(mix(-lfN, lfN, flipT) + desiredDirRot * 1e-3);
            flowStrength *= ambig;
            vec2 baseDir = flowDirRot;
            float baseLen = max(1e-4, length(baseDir));
            baseDir /= baseLen;

            vec2 localDir = lfN;
            float localLen = max(1e-4, length(localDir));
            localDir /= localLen;

            float gi = max(0.0, uRainFlowGlobalInfluence);
            float wLocal = flowStrength;
            float wBase = (1.0 - flowStrength) * gi;
            float wTotal = max(1e-6, wBase + wLocal);
            float wAngle = clamp(wLocal / wTotal, 0.0, 1.0);

            float a0 = atan(baseDir.y, baseDir.x);
            float a1 = atan(localDir.y, localDir.x);
            float da = a1 - a0;
            da = mod(da + 3.14159265, 6.2831853) - 3.14159265;

            float maxTurn = clamp(uRainFlowMaxTurn, 0.0, 3.14159265);
            da = clamp(da, -maxTurn, maxTurn);
            float a = a0 + da * wAngle;
            flowDirRot = vec2(cos(a), sin(a));
            flowDirRot = mat2(oc, -os, os, oc) * flowDirRot;
          }

          float rainKDist = rainK * roofMask;
          float rainKDarkDist = rainKDark * roofMask;

          vec2 rainUV = rotP * 2.0 + 0.5;

          float tMove = uTime * max(0.0, uRainSpeed);

          float nScale = max(0.001, uRainNoiseScale);
          float detail = clamp(uRainNoiseDetail, 0.0, 3.0);
          float evo = max(0.0, uRainNoiseEvolution);

          float rivAspect = max(1.0, uRainRivuletAspect);
          vec2 aniso = vec2(rivAspect, 1.0 / rivAspect);

          vec2 blurStep = uWindowTexelSize * max(0.0, uRainBlurPx) * nScale * aniso;

          vec2 flowN = flowDirRot;
          float flowLen = max(1e-4, length(flowN));
          flowN /= flowLen;
          vec2 flowPerp = vec2(-flowN.y, flowN.x);

          vec2 rainUVFlow = vec2(dot(rainUV, flowPerp), dot(rainUV, flowN));

          vec2 adv = flowN * (tMove * 0.12) * uRainFlowAdvectScale;
          vec2 advFlow = vec2(dot(adv, flowPerp), dot(adv, flowN));

          vec2 q = (rainUVFlow * nScale + advFlow) * aniso;

          vec2 evoVec = flowN * (uTime * evo * 0.06) * uRainFlowEvoScale + flowPerp * (uTime * evo * 0.02) * uRainFlowPerpScale;
          vec2 evoFlow = vec2(dot(evoVec, flowPerp), dot(evoVec, flowN));
          q += evoFlow * aniso;

          float n0 = msFbmBlurred(q, detail, blurStep);

          float eps = max(1.0, 6.0 / max(nScale, 0.001)) * max(uWindowTexelSize.x, uWindowTexelSize.y);
          vec2 eps2 = vec2(eps * aniso.x, eps * aniso.y);
          float nx = msFbmBlurred(q + vec2(eps2.x, 0.0), detail, blurStep) - msFbmBlurred(q - vec2(eps2.x, 0.0), detail, blurStep);
          float ny = msFbmBlurred(q + vec2(0.0, eps2.y), detail, blurStep) - msFbmBlurred(q - vec2(0.0, eps2.y), detail, blurStep);
          vec2 grad = vec2(nx, ny);

          float ridge = abs(nx) / max(1e-6, 2.0 * eps2.x);
          ridge = clamp(ridge * max(0.0, uRainRivuletRidgeGain), 0.0, 1.0);

          float rivBase = clamp(n0, 0.0, 1.0);
          float rivN = mix(rivBase, ridge, clamp(uRainRivuletRidgeMix, 0.0, 1.0));
          rivN = clamp(rivN * max(0.0, uRainRivuletGain), 0.0, 1.0);
          float rivThr = clamp(uRainRivuletThreshold, 0.0, 1.0);
          float rivFea0 = max(1e-4, uRainRivuletFeather);
          float rivSoft = clamp(uRainRivuletSoftness, 0.0, 1.0);
          float rivFea = rivFea0 * (1.0 + 6.0 * rivSoft);
          float rivM = smoothstep(rivThr - rivFea, rivThr + rivFea, rivN);
          rivM = pow(rivM, max(0.01, uRainRivuletGamma));

          float rivDistMaskRaw = 1.0;
          if (uHasRainFlowMap > 0.5) {
            float d = clamp(distToWall, 0.0, 1.0);
            float s0 = clamp(uRainRivuletDistanceStart, 0.0, 1.0);
            float e0 = clamp(uRainRivuletDistanceEnd, 0.0, 1.0);
            float a = min(s0, e0);
            float b = max(s0, e0);
            float f = max(1e-4, uRainRivuletDistanceFeather);
            float inM = smoothstep(a, min(1.0, a + f), d);
            float outM = 1.0 - smoothstep(max(0.0, b - f), b, d);
            rivDistMaskRaw = clamp(inM * outM, 0.0, 1.0);
          }
          float rivDistMask = mix(1.0, rivDistMaskRaw, clamp(uRainRivuletDistanceMasking, 0.0, 1.0));
          rivM *= rivDistMask;

          float distMasking = clamp(uRainDistortionMasking, 0.0, 1.0);
          float distortGate = mix(1.0, rivM, distMasking);

          vec2 gradRot = flowPerp * grad.x + flowN * grad.y;
          vec2 unrotatedN = perpP * gradRot.x + dirP * gradRot.y;
          float nLen = max(1e-4, length(unrotatedN));
          vec2 n01 = unrotatedN / nLen;

          float maxOffsetPx = max(0.0, uRainMaxOffsetPx);
          vec2 distortPx = n01 * maxOffsetPx * distortGate;
          rainNormal = normalize(vec3(n01 * distortGate, 1.0));
          vec2 distUV = distortPx * uWindowTexelSize * rainKDist;
          float featherPx = max(0.0, uRainDistortionFeatherPx);
          vec2 stepUv = uWindowTexelSize * featherPx;

          float srcMask = msLuminance(texture2D(uWindowMask, vUv).rgb);
          float destMask = msLuminance(texture2D(uWindowMask, vUv - distUV).rgb);

          if (featherPx > 0.001) {
            float s1 = msLuminance(texture2D(uWindowMask, vUv + vec2( stepUv.x, 0.0)).rgb);
            float s2 = msLuminance(texture2D(uWindowMask, vUv + vec2(-stepUv.x, 0.0)).rgb);
            float s3 = msLuminance(texture2D(uWindowMask, vUv + vec2(0.0,  stepUv.y)).rgb);
            float s4 = msLuminance(texture2D(uWindowMask, vUv + vec2(0.0, -stepUv.y)).rgb);
            srcMask = (srcMask * 2.0 + s1 + s2 + s3 + s4) / 6.0;

            float d1 = msLuminance(texture2D(uWindowMask, (vUv - distUV) + vec2( stepUv.x, 0.0)).rgb);
            float d2 = msLuminance(texture2D(uWindowMask, (vUv - distUV) + vec2(-stepUv.x, 0.0)).rgb);
            float d3 = msLuminance(texture2D(uWindowMask, (vUv - distUV) + vec2(0.0,  stepUv.y)).rgb);
            float d4 = msLuminance(texture2D(uWindowMask, (vUv - distUV) + vec2(0.0, -stepUv.y)).rgb);
            destMask = (destMask * 2.0 + d1 + d2 + d3 + d4) / 6.0;
          }

          float edgeHi = mix(0.10, 0.75, clamp(featherPx / 16.0, 0.0, 1.0));
          float safetyFactor = smoothstep(0.0, edgeHi, destMask);
          float srcFactor = smoothstep(0.0, edgeHi, srcMask);
          uv = uv - distUV * safetyFactor * srcFactor;

          waterMask = rivM * max(0.0, uRainRivuletStrength) * rainKDarkDist;
        }

        if (rainKSplash > 0.001 && uRainSplashIntensity > 0.001) {
          float cellCount = max(1.0, uRainSplashScale);
          float layerCount = clamp(uRainSplashLayers, 1.0, 3.0);
          float driftPx = max(0.0, uRainSplashDriftPx);

          vec2 windDir = uWindDir;
          float windLen = max(1e-4, length(windDir));
          windDir /= windLen;
          float windK = clamp(uWindSpeed, 0.0, 1.0);

          vec2 totalUv = vec2(0.0);

          float aspect = max(1e-6, uWindowTexelSize.y) / max(1e-6, uWindowTexelSize.x);
          vec2 aspectVec = vec2(aspect, 1.0);

          vec2 driftBaseUv = windDir * (driftPx * uWindowTexelSize) * (uTime * 0.7);

          for (int i = 0; i < 3; i++) {
            float on = step(float(i), layerCount - 1.0);
            float fi = float(i);

            vec2 layerRand = msHash22(vec2(17.1 + fi * 31.7, 9.3 + fi * 13.9)) * 2.0 - 1.0;
            float lrLen = max(1e-4, length(layerRand));
            vec2 layerDir = layerRand / lrLen;

            vec2 driftDir = normalize(mix(layerDir, windDir, 0.75));
            vec2 layerDriftUv = driftDir * driftBaseUv * (0.45 + fi * 0.35);
            vec2 layerUv = vUv + layerDriftUv;

            vec2 baseCellId = floor(layerUv * cellCount);
            vec2 cellId = baseCellId;
            vec2 cellUv = (cellId + 0.5) / cellCount;

              float density = clamp(uRainSplashThreshold, 0.0, 1.0);
              float rnd = msHash21(cellId + fi * 19.19);
              float spawnK = max(0.001, uRainSplashSpawnRate);
              float rndAdj = pow(clamp(rnd, 0.0, 1.0), 1.0 / spawnK);
              float spawn = smoothstep(density, min(1.0, density + 0.02), rndAdj);

              float rate = max(0.01, uRainSplashSpeed) * (0.85 + fi * 0.25);
              float t0 = uTime * rate + rnd * 10.0;
              float phase = fract(t0);
              float cycle = floor(t0);

              float fadePow = max(0.0001, uRainSplashFadePow);
              float envelope = pow(1.0 - phase, fadePow) * smoothstep(0.0, 0.05, phase);

              float sizeJit = clamp(uRainSplashSizeJitter, 0.0, 1.0);
              float sizeRnd = msHash21(cellId + vec2(cycle * 1.37, cycle * 2.91) + fi * 3.7);
              float sizeMul = mix(1.0 - 0.6 * sizeJit, 1.0 + 0.9 * sizeJit, sizeRnd);

              float r0 = max(0.0, uRainSplashRadiusPx) * uWindowTexelSize.y * sizeMul;
              float r1 = r0 * max(1.0, uRainSplashExpand);
              float r = mix(r0, r1, phase);

              float ringWBase = max(1e-6, r0 * mix(0.18, 0.55, msHash21(cellId + vec2(41.2 + fi * 3.1, 17.7 + cycle * 0.11))));
              float streakLenPx = max(0.0, uRainSplashStreakLengthPx);
              float streakLenUv = streakLenPx * uWindowTexelSize.y * (0.5 + 2.0 * windK);
              float soft = max(1e-6, r0 * 0.40);
              float rMax = r1 + ringWBase + soft + streakLenUv;

              float cellHalfUv = 0.5 / cellCount;
              float jitterMax = max(0.0, cellHalfUv - rMax);
              vec2 jitterN = msHash22(cellId + vec2(3.1 + fi * 7.3, 9.2 + fi * 5.1)) * 2.0 - 1.0;
              vec2 jitter = jitterN * jitterMax;
              vec2 centerUv = cellUv + jitter;

              vec2 d = (layerUv - centerUv) * aspectVec;
              float dist = length(d);
              if (dist > rMax) continue;

              float mScale = max(0.001, uRainSplashMaskScale);
              float mThr = clamp(uRainSplashMaskThreshold, 0.0, 1.0);
              float mF = max(1e-4, uRainSplashMaskFeather);
              float maskN = msFbm(cellUv * mScale + vec2(101.3 + fi * 13.0, 17.1 + fi * 9.0), 2.0);
              float maskGate = smoothstep(mThr, min(1.0, mThr + mF), maskN);

              float blob = clamp(uRainSplashBlob, 0.0, 1.0);
              float edgeNoise = msFbm((d * (cellCount * 1.35)) + (cellId + vec2(13.7, 7.9)) + vec2(cycle * 0.13, cycle * 0.07), 2.0);
              float edgeSigned = (edgeNoise - 0.5) * 2.0;
              float distBlobby = dist + edgeSigned * blob * max(1e-6, r0 * 0.25);
              float rNoisy = r * (1.0 + edgeSigned * blob * 0.22);

              float shape = 0.0;
              if (uHasRainSplashAtlas > 0.5) {
                vec2 localUv = d / max(1e-6, rMax);
                localUv = localUv * 0.5 + 0.5;

                if (any(lessThan(localUv, vec2(0.0))) || any(greaterThan(localUv, vec2(1.0)))) {
                  shape = 0.0;
                } else {
                  float w0 = step(0.5, uRainSplashAtlasTile0);
                  float w1 = step(0.5, uRainSplashAtlasTile1);
                  float w2 = step(0.5, uRainSplashAtlasTile2);
                  float w3 = step(0.5, uRainSplashAtlasTile3);
                  float wSum = w0 + w1 + w2 + w3;
                  if (wSum > 0.5) {
                    float tileRnd = msHash21(cellId + vec2(11.7 + fi * 3.1, 7.9 + cycle * 0.13));
                    float rPick = tileRnd * wSum;
                    float t0 = w0;
                    float t1 = t0 + w1;
                    float t2 = t1 + w2;

                    float tileIndex;
                    if (rPick < t0) tileIndex = 0.0;
                    else if (rPick < t1) tileIndex = 1.0;
                    else if (rPick < t2) tileIndex = 2.0;
                    else tileIndex = 3.0;

                    float tx = mod(tileIndex, 2.0);
                    float ty = floor(tileIndex / 2.0);
                    vec2 atlasUv = (localUv + vec2(tx, ty)) * 0.5;
                    shape = texture2D(uRainSplashAtlas, atlasUv).a;
                  } else {
                    shape = 0.0;
                  }
                }
              } else {
                vec2 wP = windDir * aspectVec;
                float wLen = max(1e-4, length(wP));
                vec2 wN = wP / wLen;
                vec2 wT = vec2(-wN.y, wN.x);
                float along = dot(d, wN);
                float perp = dot(d, wT);

                float streakK = max(0.0, uRainSplashStreakStrength) * windK;
                float streakDist = sqrt(perp * perp + (along / (1.0 + max(1e-6, streakLenUv / max(1e-6, r0)))) * (along / (1.0 + max(1e-6, streakLenUv / max(1e-6, r0)))));

                float ringW = ringWBase;
                ringW *= mix(0.8, 1.35, clamp(edgeNoise, 0.0, 1.0));
                float innerR = max(0.0, rNoisy - ringW);

                float outerA = (1.0 - smoothstep(rNoisy, rNoisy + soft, distBlobby));
                float innerA = (1.0 - smoothstep(innerR, innerR + soft, distBlobby));
                float ring = clamp(outerA - innerA, 0.0, 1.0);

                float outerS = (1.0 - smoothstep(rNoisy, rNoisy + soft, streakDist));
                float innerS = (1.0 - smoothstep(innerR, innerR + soft, streakDist));
                float ringStreak = clamp(outerS - innerS, 0.0, 1.0);
                shape = mix(ring, max(ring, ringStreak), streakK);
              }

              float splash = shape * envelope * spawn * maskGate * on;

              vec2 dir = normalize(msHash22(cellId + vec2(1.7 + fi * 2.0, 2.9 + fi * 3.0)) * 2.0 - 1.0);
              float maxSplashPx = max(0.0, uRainSplashMaxOffsetPx);
              vec2 splashUv = dir * (maxSplashPx * uWindowTexelSize) * splash;

            totalUv += splashUv;
          }

          uv = uv + totalUv * uRainSplashIntensity * rainKSplash;
        }

        vec2 shiftDir = vec2(cos(uRgbShiftAngle), sin(uRgbShiftAngle));
        vec2 rOffset = shiftDir * shiftAmountPx * uWindowTexelSize;
        vec2 bOffset = -rOffset;

        float maskR = msLuminance(texture2D(uWindowMask, uv + rOffset).rgb);
        float maskG = msLuminance(texture2D(uWindowMask, uv).rgb);
        float maskB = msLuminance(texture2D(uWindowMask, uv + bOffset).rgb);

        vec3 lightMap = pow(max(vec3(maskR, maskG, maskB), vec3(0.0)), vec3(uFalloff));
        float brightness = msLuminance(lightMap);

        float contrastBoost = max(uLightningWindowContrastBoost, 0.0);
        float contrastPow = 1.0 / (1.0 + flash01 * contrastBoost);
        float finalBrightness = pow(max(brightness, 0.0), contrastPow);

        float indoorFactor = 1.0;
        if (uHasOutdoorsMask > 0.5) {
          float outdoorStrength = texture2D(uOutdoorsMask, vUv).r;
          indoorFactor = clamp(1.0 - outdoorStrength, 0.0, 1.0);

          // When sun tracking shifts the mask lookup, also reject if the
          // offset source position is outdoor (prevents pulling outdoor
          // mask values into indoor areas)
          if (uSunLightEnabled > 0.5) {
            float offsetOutdoor = texture2D(uOutdoorsMask, maskUv).r;
            indoorFactor *= clamp(1.0 - offsetOutdoor, 0.0, 1.0);
          }
        }

        float roofSuppression = 1.0;
        if (uHasRoofAlphaMap > 0.5 && uOverheadMaskSuppression > 0.001) {
          vec2 screenUV = (vClipPos.xy / vClipPos.w) * 0.5 + 0.5;
          float roofAlpha = clamp(texture2D(uRoofAlphaMap, screenUV).a, 0.0, 1.0);
          roofSuppression = 1.0 - roofAlpha * clamp(uOverheadMaskSuppression, 0.0, 1.0);
        }

        float envFactor = 1.0;
        if (uHasCloudShadowMap > 0.5) {
          vec2 screenUV = (vClipPos.xy / vClipPos.w) * 0.5 + 0.5;
          float cloudLightFactor = clamp(texture2D(uCloudShadowMap, screenUV).r, 0.0, 1.0);

          cloudLightFactor = clamp(cloudLightFactor + uCloudShadowBias, 0.0, 1.0);
          cloudLightFactor = pow(cloudLightFactor, max(uCloudShadowGamma, 0.0001));
          cloudLightFactor = clamp((cloudLightFactor - 0.5) * uCloudShadowContrast + 0.5, 0.0, 1.0);
          cloudLightFactor = max(cloudLightFactor, clamp(uCloudShadowMinLight, 0.0, 1.0));
          float k = clamp(uCloudInfluence * clamp(uCloudCover, 0.0, 1.0), 0.0, 1.0);
          envFactor *= mix(1.0, cloudLightFactor, k);
        }

        float nightFactor = uDarknessLevel * uNightDimming;
        envFactor *= (1.0 - clamp(nightFactor, 0.0, 1.0));

        float skyK = clamp(uSkyIntensity, 0.0, 1.0) * step(0.5, uUseSkyTint) * max(uSkyTintStrength, 0.0);
        float skyColorMix = clamp(skyK * 0.35, 0.0, 1.0);
        float skyDimMix = clamp(skyK * 0.25, 0.0, 1.0);
        vec3 skyTinted = msApplySkyWhiteBalance(uColor, uSkyTemperature, uSkyTint);
        vec3 finalColor = mix(uColor, skyTinted, skyColorMix);
        envFactor *= (1.0 - skyDimMix);

        float flashIntensityBoost = max(uLightningWindowIntensityBoost, 0.0);
        float flashMul = 1.0 + flash01 * flashIntensityBoost;
        finalBrightness = finalBrightness * uIntensity * indoorFactor * envFactor * flashMul;
        finalBrightness *= roofSuppression;

        if (waterMask > 0.0001) {
          float kDark = clamp(uRainDarken, 0.0, 1.0);
          float g = max(uRainDarkenGamma, 0.0001);
          float dm = pow(clamp(waterMask, 0.0, 1.0), g);
          finalBrightness *= (1.0 - dm * kDark);

          vec3 lightDir = normalize(vec3(-0.5, 1.0, 0.5));
          float blurK = clamp(max(0.0, uRainBlurPx) / 8.0, 0.0, 1.0);
          float specPow = mix(12.0, 4.0, blurK);
          float spec = pow(max(dot(rainNormal, lightDir), 0.0), specPow);
          finalBrightness += spec * 1.5 * waterMask * uIntensity * indoorFactor * envFactor * flashMul;
        }

        // Output premultiplied color/brightness. Multiply by per-channel lightMap so
        // the RGB shift is actually visible (chromatic edge split).
        vec3 rgbSplit = lightMap / max(brightness, 0.00001);
        gl_FragColor = vec4(finalColor * finalBrightness * rgbSplit, finalBrightness);
      }
    `;
  }

  renderLightPass(renderer) {
    if (!this.lightTarget || !this.lightScene || !this.camera) return;
    if (!this._enabled || !this.params.hasWindowMask) return;

    // Uniforms are updated in update(), so we just render.

    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.lightTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(this.lightScene, this.camera);
    renderer.setRenderTarget(prevTarget);

    // Publish
    try {
      const mm = window.MapShine?.maskManager;
      if (mm) {
        const tex = this.lightTarget?.texture;
        if (tex && tex !== this._publishedWindowLightTex) {
          this._publishedWindowLightTex = tex;
          mm.setTexture('windowLight.screen', tex, {
            space: 'screenUv',
            source: 'renderTarget',
            channels: 'a',
            uvFlipY: false,
            lifecycle: 'dynamicPerFrame',
            width: this.lightTarget?.width ?? null,
            height: this.lightTarget?.height ?? null
          });
        }
      }
    } catch (e) {}
  }

  getLightTexture() {
    if (!this._enabled || !this.params.hasWindowMask) return null;
    return this.lightTarget?.texture || null;
  }

  dispose() {
    for (const unsub of this._registryUnsubs) unsub();
    this._registryUnsubs = [];
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh = null;
    }
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }
    if (this.lightMesh && this.lightScene) {
      this.lightScene.remove(this.lightMesh);
      this.lightMesh = null;
    }
    if (this.lightMaterial) {
      this.lightMaterial.dispose();
      this.lightMaterial = null;
    }
    if (this.lightTarget) {
      this.lightTarget.dispose();
      this.lightTarget = null;
    }
    this.lightScene = null;
    this.windowMask = null;
    this.outdoorsMask = null;
    this.specularMask = null;
    this._rainFlowMapConfigKey = null;

    try {
      const mm = window.MapShine?.maskManager;
      if (mm && typeof mm.setTexture === 'function') {
        mm.setTexture('rainFlowMap.scene', null);
      }
    } catch (e) {
    }
    log.info('WindowLightEffect disposed');
  }

  /**
   * Main render hook called by EffectComposer.
   * We use this to update the light-only render target used by overhead tiles.
   * The main visual effect is handled by the mesh in the scene.
   * @param {THREE.WebGLRenderer} renderer 
   */
  render(renderer) {
    if (!this.params.lightOverheadTiles) {
      if (this._publishedWindowLightTex) {
        this._publishedWindowLightTex = null;
        try {
          const mm = window.MapShine?.maskManager;
          if (mm && typeof mm.setTexture === 'function') {
            mm.setTexture('windowLight.screen', null);
          }
        } catch (e) {}
      }
      return;
    }

    this.renderLightPass(renderer);
  }
}
