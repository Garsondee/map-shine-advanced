/**
 * @fileoverview V2 Window Light Effect — per-tile additive window glow overlays.
 *
 * Architecture:
 *   - For each tile that has a `_Windows` (or legacy `_Structural`) mask, create
 *     an additive overlay mesh in an ISOLATED scene (NOT the FloorRenderBus scene).
 *   - FloorCompositor passes `_scene` directly into `LightingEffectV2.render()` as
 *     the `windowLightScene` argument. LightingEffectV2 renders it additively into
 *     `_lightRT` (the light accumulation buffer) BEFORE the compose step.
 *
 * Why this is correct:
 *   The lighting compose shader does `litColor = albedo * totalIllumination`.
 *   By contributing to `totalIllumination` (via `_lightRT`), window light naturally
 *   tints itself by the surface albedo — a red surface stays red under warm light.
 *   Pure additive post-lighting would add white light uniformly, desaturating colours.
 *
 * Floor isolation is handled by manually toggling mesh visibility in
 * onFloorChange() since the overlays are not in the bus scene.
 *
 * @module compositor-v2/effects/WindowLightEffectV2
 */

import { createLogger } from '../../core/log.js';
import { probeMaskFile } from '../../assets/loader.js';
import { tileHasLevelsRange, readTileLevelsFlags } from '../../foundry/levels-scene-flags.js';
import { weatherController, PrecipitationType } from '../../core/WeatherController.js';

const log = createLogger('WindowLightEffectV2');

// Z offset above albedo + specular. Must remain within the 1.0-per-floor Z band.
const WINDOW_Z_OFFSET = 0.2;

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
    this._activeMaxFloor = Infinity;

    /**
     * Per-tile overlay entries.
     * @type {Map<string, {mesh: THREE.Mesh, material: THREE.ShaderMaterial, floorIndex: number}>}
     */
    this._overlays = new Map();

    /** @type {object|null} */
    this._sharedUniforms = null;

    /** @type {{ skyTintColor: {r:number,g:number,b:number}, sunAzimuthDeg: number }} */
    this._skyState = {
      skyTintColor: { r: 1.0, g: 1.0, b: 1.0 },
      sunAzimuthDeg: 180.0,
    };

    this.params = {
      enabled: true,
      intensity: 1.5,
      falloff: 3.0,
      color: { r: 1.0, g: 0.96, b: 0.85 },
      flickerEnabled: false,
      flickerSpeed: 0.35,
      flickerAmount: 0.15,
      cloudInfluence: 1.0,
      cloudShadowContrast: 4.0,
      cloudShadowBias: 0.05,
      cloudShadowGamma: 2.28,
      cloudShadowMinLight: 0.0,
      useSkyTint: true,
      skyTintStrength: 3.62,
      nightDimming: 1.0,
      sunLightEnabled: false,
      sunLightLength: 0.03,
      rainOnGlassEnabled: true,
      rainOnGlassIntensity: 1.0,
      rainOnGlassPrecipStart: 0.15,
      rainOnGlassPrecipFull: 0.7,
      rainOnGlassSpeed: 0.35,
      rainOnGlassDirectionDeg: 270.0,
      rainOnGlassMaxOffsetPx: 1.25,
      rainOnGlassDarken: 0.25,
      // RGB shift (chromatic dispersion / refraction)
      rgbShiftAmount: 1.9,  // pixels
      rgbShiftAngle: 76.0,  // degrees
    };

    log.debug('WindowLightEffectV2 created');
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
    this.params.enabled = this._enabled;
    if (this._sharedUniforms?.uEffectEnabled) this._sharedUniforms.uEffectEnabled.value = this._enabled;
  }

  // ── UI schema (moved from V1 WindowLightEffect) ───────────────────────────

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        { name: 'status', label: 'Effect Status', type: 'inline', parameters: ['textureStatus'] },
        { name: 'lighting', label: 'Window Light', type: 'folder', expanded: true, parameters: ['intensity', 'falloff', 'color'] },
        { name: 'sunTracking', label: 'Sun Tracking', type: 'folder', expanded: false, parameters: ['sunLightEnabled', 'sunLightLength'] },
        { name: 'environment', label: 'Environment', type: 'folder', expanded: false, parameters: ['cloudInfluence', 'nightDimming', 'useSkyTint', 'skyTintStrength'] },
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
        intensity: { type: 'slider', label: 'Intensity', min: 0.0, max: 25.0, step: 0.1, default: 25 },
        falloff: { type: 'slider', label: 'Falloff (Gamma)', min: 0.1, max: 5.0, step: 0.1, default: 5 },
        color: { type: 'color', label: 'Light Color', default: { r: 1.0, g: 0.96, b: 0.85 } },
        cloudInfluence: { type: 'slider', label: 'Cloud Dimming', min: 0.0, max: 1.0, step: 0.01, default: 1.0 },
        nightDimming: { type: 'slider', label: 'Night Dimming', min: 0.0, max: 1.0, step: 0.01, default: 1 },
        useSkyTint: { type: 'boolean', label: 'Use Sky Tint', default: true },
        skyTintStrength: { type: 'slider', label: 'Sky Tint Strength', min: 0.0, max: 25.0, step: 0.01, default: 3.62 },
        cloudShadowContrast: { type: 'slider', label: 'Shadow Contrast', min: 0.0, max: 4.0, step: 0.01, default: 4.0 },
        cloudShadowBias: { type: 'slider', label: 'Shadow Bias', min: -1.0, max: 1.0, step: 0.01, default: 0.05 },
        cloudShadowGamma: { type: 'slider', label: 'Shadow Gamma', min: 0.1, max: 4.0, step: 0.01, default: 2.28 },
        cloudShadowMinLight: { type: 'slider', label: 'Min Light', min: 0.0, max: 1.0, step: 0.01, default: 0.0 },
        rgbShiftAmount: { type: 'slider', label: 'RGB Shift', min: 0.0, max: 12.0, step: 0.01, default: 1.9 },
        rgbShiftAngle: { type: 'slider', label: 'Angle (deg)', min: 0.0, max: 360.0, step: 1.0, default: 76.0 },
        specularBoost: { type: 'slider', label: 'Specular Boost', min: 0.0, max: 5.0, step: 0.1, default: 5.0 },
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
        sunLightEnabled: { type: 'boolean', label: 'Enable Sun Tracking', default: false },
        sunLightLength: { type: 'slider', label: 'Light Shift Length', min: 0.0, max: 0.3, step: 0.005, default: 0.03 },
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

    this._buildSharedUniforms();

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
    this._activeMaxFloor = maxFloorIndex;
    for (const entry of this._overlays.values()) {
      entry.mesh.visible = entry.floorIndex <= maxFloorIndex;
    }
  }

  /**
   * Populate window overlays for all tiles in the scene.
   *
   * @param {object} foundrySceneData
   */
  async populate(foundrySceneData) {
    if (!this._initialized) { log.warn('populate: not initialized'); return; }
    this.clear();

    const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    // worldH must match FloorRenderBus and SpecularEffectV2: use foundrySceneData.height
    // (full canvas height including padding), NOT canvas.scene.height (scene rect only).
    const worldH = foundrySceneData?.height ?? canvas?.scene?.height ?? 0;

    let overlayCount = 0;

    // ── Process scene background image ────────────────────────────────────
    // The background is not in canvas.scene.tiles.contents — it's handled
    // separately by FloorRenderBus as __bg_image__. Check for its _Windows
    // or _Structural mask and create an overlay if found.
    const bgSrc = canvas?.scene?.background?.src ?? '';
    if (bgSrc) {
      const dotIdx = bgSrc.lastIndexOf('.');
      const bgBasePath = dotIdx > 0 ? bgSrc.substring(0, dotIdx) : bgSrc;
      const bgWinResult = await probeMaskFile(bgBasePath, '_Windows');
      const bgStructResult = bgWinResult?.path ? null : await probeMaskFile(bgBasePath, '_Structural');
      const bgMaskPath = bgWinResult?.path ?? bgStructResult?.path;

      if (bgMaskPath) {
        // Background geometry: scene rect in world space.
        const sceneW = foundrySceneData?.sceneWidth ?? foundrySceneData?.width ?? 0;
        const sceneH = foundrySceneData?.sceneHeight ?? foundrySceneData?.height ?? 0;
        const sceneX = foundrySceneData?.sceneX ?? 0;
        const sceneY = foundrySceneData?.sceneY ?? 0;
        const centerX = sceneX + sceneW / 2;
        const centerY = worldH - (sceneY + sceneH / 2);

        // Background is always floor 0, Z just above the bg image plane.
        const GROUND_Z = 1000;
        const z = GROUND_Z - 1 + WINDOW_Z_OFFSET;

        this._createOverlay('__bg_image__', 0, {
          maskUrl: bgMaskPath,
          centerX, centerY,
          w: sceneW,
          h: sceneH,
          z,
          rotation: 0,
        });

        overlayCount++;
        log.info(`WindowLightEffectV2: created background overlay (${sceneW}x${sceneH})`);
      }
    }

    // ── Process placed tiles ──────────────────────────────────────────────
    const tileDocs = canvas?.scene?.tiles?.contents ?? [];

    for (const tileDoc of tileDocs) {
      const tileId = tileDoc.id ?? tileDoc._id;
      if (!tileId) continue;
      const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
      if (!src) continue;

      const dotIdx = src.lastIndexOf('.');
      const basePath = dotIdx > 0 ? src.substring(0, dotIdx) : src;

      // _Windows is preferred; _Structural is a legacy equivalent — both are
      // colour luminance masks with alpha defining where light hits the floor.
      const winResult = await probeMaskFile(basePath, '_Windows');
      const structResult = winResult?.path ? null : await probeMaskFile(basePath, '_Structural');
      const maskPath = winResult?.path ?? structResult?.path;
      if (!maskPath) continue;

      const floorIndex = this._resolveFloorIndex(tileDoc, floors);

      const tileW = tileDoc.width ?? 0;
      const tileH = tileDoc.height ?? 0;
      // World-space center: same Y-flip as SpecularEffectV2 and FloorRenderBus.
      const centerX = (tileDoc.x ?? 0) + tileW / 2;
      const centerY = worldH - ((tileDoc.y ?? 0) + tileH / 2);
      const rotation = typeof tileDoc.rotation === 'number'
        ? (tileDoc.rotation * Math.PI) / 180 : 0;

      // Z in bus coordinates.
      const GROUND_Z = 1000;
      const z = GROUND_Z + floorIndex + WINDOW_Z_OFFSET;

      this._createOverlay(tileId, floorIndex, {
        maskUrl: maskPath,
        centerX, centerY,
        w: tileW,
        h: tileH,
        z,
        rotation,
      });

      overlayCount++;
    }

    log.info(`WindowLightEffectV2 populated: ${overlayCount} overlay(s) (${bgSrc ? '1 bg + ' : ''}${overlayCount - (bgSrc && overlayCount > 0 ? 1 : 0)} tiles)`);
  }

  /**
   * Update per-frame uniforms.
   * @param {{ elapsed: number, delta: number }} timeInfo
   */
  update(timeInfo) {
    if (!this._initialized || !this._enabled) return;

    if (this._sharedUniforms?.uTime) {
      this._sharedUniforms.uTime.value = typeof timeInfo?.elapsed === 'number' ? timeInfo.elapsed : 0;
    }

    // Sync params → uniforms (cheap; shared uniforms update all overlays).
    const u = this._sharedUniforms;
    if (!u) return;

    u.uEffectEnabled.value = !!this._enabled;
    u.uIntensity.value = Math.max(0.0, Number(this.params.intensity) || 0);
    u.uFalloff.value = Math.max(0.01, Number(this.params.falloff) || 1);

    const c = this.params.color;
    if (c && typeof c === 'object') {
      // THREE.Color.set() takes a single arg; use setRGB for component-wise assignment.
      u.uColor.value.setRGB(
        Number(c.r) || 0,
        Number(c.g) || 0,
        Number(c.b) || 0
      );
    }

    u.uFlickerEnabled.value = this.params.flickerEnabled ? 1.0 : 0.0;
    u.uFlickerSpeed.value = Math.max(0.0, Number(this.params.flickerSpeed) || 0);
    u.uFlickerAmount.value = Math.max(0.0, Number(this.params.flickerAmount) || 0);

    const skyTint = this._skyState.skyTintColor;
    u.uSkyTintColor.value.setRGB(
      Math.max(0.01, Number(skyTint.r) || 1.0),
      Math.max(0.01, Number(skyTint.g) || 1.0),
      Math.max(0.01, Number(skyTint.b) || 1.0)
    );
    u.uUseSkyTint.value = this.params.useSkyTint ? 1.0 : 0.0;
    u.uSkyTintStrength.value = Math.max(0.0, Number(this.params.skyTintStrength) || 0.0);

    const darkness = Math.max(0.0, Math.min(1.0, Number(canvas?.environment?.darknessLevel) || 0.0));
    const nightDimming = Math.max(0.0, Math.min(1.0, Number(this.params.nightDimming) || 0.0));
    u.uNightFactor.value = Math.max(0.0, 1.0 - darkness * nightDimming);

    const sunAzimuthDeg = Number(this._skyState.sunAzimuthDeg) || 180.0;
    const sunAzimuthRad = sunAzimuthDeg * (Math.PI / 180.0);
    u.uSunDir.value.set(-Math.sin(sunAzimuthRad), -Math.cos(sunAzimuthRad));
    u.uSunTrackEnabled.value = this.params.sunLightEnabled ? 1.0 : 0.0;
    u.uSunLightLength.value = Math.max(0.0, Number(this.params.sunLightLength) || 0.0);

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
  }

  /**
   * API parity with other V2 effects.
   * Window light is rendered via bus overlay meshes, so no explicit render pass
   * is required here.
   *
   * @param {THREE.WebGLRenderer} _renderer
   * @param {THREE.Camera} _camera
   */
  render(_renderer, _camera) {
  }

  /**
   * Receives environment data from FloorCompositor/SkyColorEffectV2.
   * @param {{ skyTintColor?: {r:number,g:number,b:number}, sunAzimuthDeg?: number }} state
   */
  setSkyState(state = {}) {
    if (!state || typeof state !== 'object') return;

    if (state.skyTintColor && typeof state.skyTintColor === 'object') {
      this._skyState.skyTintColor = {
        r: Number(state.skyTintColor.r) || 1.0,
        g: Number(state.skyTintColor.g) || 1.0,
        b: Number(state.skyTintColor.b) || 1.0,
      };
    }
    if (Number.isFinite(Number(state.sunAzimuthDeg))) {
      this._skyState.sunAzimuthDeg = Number(state.sunAzimuthDeg);
    }
  }

  /**
   * Bind CloudEffectV2 shadow factor texture for screen-space occlusion.
   * @param {THREE.Texture|null} texture
   * @param {number} screenW
   * @param {number} screenH
   * @param {{minX:number,minY:number,maxX:number,maxY:number}|null} [viewBounds]
   */
  setCloudShadowTexture(texture, screenW, screenH, viewBounds = null) {
    const u = this._sharedUniforms;
    if (!u) return;
    u.uCloudShadowTex.value = texture ?? null;
    u.uHasCloudShadowTex.value = texture ? 1.0 : 0.0;
    const w = Math.max(1, Number(screenW) || 1);
    const h = Math.max(1, Number(screenH) || 1);
    u.uScreenSize.value.set(w, h);
    if (viewBounds && Number.isFinite(viewBounds.minX) && Number.isFinite(viewBounds.minY)
      && Number.isFinite(viewBounds.maxX) && Number.isFinite(viewBounds.maxY)) {
      u.uCloudShadowViewMin.value.set(viewBounds.minX, viewBounds.minY);
      u.uCloudShadowViewMax.value.set(viewBounds.maxX, viewBounds.maxY);
      u.uHasCloudShadowViewBounds.value = 1.0;
    } else {
      u.uHasCloudShadowViewBounds.value = 0.0;
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  _buildSharedUniforms() {
    const THREE = window.THREE;
    if (!THREE) return;

    const c = this.params.color;
    const cr = (c && typeof c === 'object') ? (Number(c.r) || 0) : 1.0;
    const cg = (c && typeof c === 'object') ? (Number(c.g) || 0) : 0.96;
    const cb = (c && typeof c === 'object') ? (Number(c.b) || 0) : 0.85;

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
      uNightFactor: { value: 1.0 },
      uSunDir: { value: new THREE.Vector2(0, -1) },
      uSunTrackEnabled: { value: this.params.sunLightEnabled ? 1.0 : 0.0 },
      uSunLightLength: { value: Math.max(0.0, Number(this.params.sunLightLength) || 0.0) },
      uCloudFactor: { value: 1.0 },
      uCloudInfluence: { value: Math.max(0.0, Math.min(1.0, Number(this.params.cloudInfluence) || 0.0)) },
      uCloudShadowTex: { value: null },
      uHasCloudShadowTex: { value: 0.0 },
      uScreenSize: { value: new THREE.Vector2(1, 1) },
      uCloudShadowViewMin: { value: new THREE.Vector2(0, 0) },
      uCloudShadowViewMax: { value: new THREE.Vector2(1, 1) },
      uHasCloudShadowViewBounds: { value: 0.0 },
      uCloudShadowContrast: { value: Math.max(0.0, Number(this.params.cloudShadowContrast) || 1.0) },
      uCloudShadowBias: { value: Number(this.params.cloudShadowBias) || 0.0 },
      uCloudShadowGamma: { value: Math.max(0.01, Number(this.params.cloudShadowGamma) || 1.0) },
      uCloudShadowMinLight: { value: Math.max(0.0, Math.min(1.0, Number(this.params.cloudShadowMinLight) || 0.0)) },
      uRainAmount: { value: 0.0 },
      uRainSpeed: { value: Math.max(0.0, Number(this.params.rainOnGlassSpeed) || 0.0) },
      uRainDir: { value: new THREE.Vector2(0, -1) },
      uRainMaxOffsetPx: { value: Math.max(0.0, Number(this.params.rainOnGlassMaxOffsetPx) || 0.0) },
      uRainDarken: { value: Math.max(0.0, Math.min(1.0, Number(this.params.rainOnGlassDarken) || 0.0)) },
      // RGB shift (chromatic dispersion) — pixel offset split into R/B channels.
      uRgbShiftAmount: { value: Math.max(0.0, Number(this.params.rgbShiftAmount) || 0) },
      uRgbShiftAngle: { value: (Number(this.params.rgbShiftAngle) || 0) * (Math.PI / 180.0) },
      // uWindowTexelSize and uMask are per-overlay only (set in _createOverlay).
    };
  }

  _createOverlay(tileId, floorIndex, { maskUrl, centerX, centerY, w, h, z, rotation }) {
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
      // 1/texWidth, 1/texHeight — set once texture loads.
      uWindowTexelSize: { value: new THREE.Vector2(1.0 / w, 1.0 / h) },
    };

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
        uniform float uNightFactor;
        uniform vec2  uSunDir;
        uniform float uSunTrackEnabled;
        uniform float uSunLightLength;
        uniform float uCloudFactor;
        uniform float uCloudInfluence;
        uniform sampler2D uCloudShadowTex;
        uniform float uHasCloudShadowTex;
        uniform vec2  uScreenSize;
        uniform vec2  uCloudShadowViewMin;
        uniform vec2  uCloudShadowViewMax;
        uniform float uHasCloudShadowViewBounds;
        uniform float uCloudShadowContrast;
        uniform float uCloudShadowBias;
        uniform float uCloudShadowGamma;
        uniform float uCloudShadowMinLight;
        uniform float uRainAmount;
        uniform float uRainSpeed;
        uniform vec2  uRainDir;
        uniform float uRainMaxOffsetPx;
        uniform float uRainDarken;
        uniform float uRgbShiftAmount;
        uniform float uRgbShiftAngle;
        uniform vec2  uWindowTexelSize;
        uniform sampler2D uMask;
        uniform float uMaskReady;
        varying vec2 vUv;
        varying vec2 vWorldXY;

        float msLuminance(vec3 c) {
          return dot(c, vec3(0.2126, 0.7152, 0.0722));
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

          // Boundary alpha check at the unshifted UV — cuts out areas outside
          // the map tile footprint.
          vec2 sunOffset = (uSunTrackEnabled > 0.5) ? (uSunDir * uSunLightLength) : vec2(0.0);
          vec2 rainDir = normalize((length(uRainDir) > 0.001) ? uRainDir : vec2(0.0, -1.0));
          float rainPhase = uTime * max(uRainSpeed, 0.001);
          vec2 rainNoiseUv = vec2(vUv.x * 110.0, vUv.y * 180.0 - rainPhase * 7.5);
          float rainNoise = msHash12(floor(rainNoiseUv));
          float rainStrand = smoothstep(0.78, 0.98, rainNoise) * clamp(uRainAmount, 0.0, 1.0);
          vec2 rainOffset = rainDir * (uRainMaxOffsetPx * rainStrand) * uWindowTexelSize;

          vec2 baseUv = clamp(vUv + sunOffset + rainOffset, 0.001, 0.999);
          vec4 mCenter = texture2D(uMask, baseUv);
          if (mCenter.a < 0.01) discard;

          // RGB Shift (chromatic dispersion / refraction):
          // Sample the mask three times — R channel offset forward along the
          // shift direction, G channel unshifted, B channel offset backward.
          // This replicates the V1 WindowLightEffect refraction behaviour.
          vec2 shiftDir = vec2(cos(uRgbShiftAngle), sin(uRgbShiftAngle));
          vec2 rOffset  = shiftDir * uRgbShiftAmount * uWindowTexelSize;
          vec2 bOffset  = -rOffset;

          vec3 sampleR = texture2D(uMask, clamp(baseUv + rOffset, 0.001, 0.999)).rgb;
          vec3 sampleC = mCenter.rgb;
          vec3 sampleB = texture2D(uMask, clamp(baseUv + bOffset, 0.001, 0.999)).rgb;
          // Preserve mask chroma when available (_Windows/_Structural can be tinted).
          // Keep RGB shift behaviour by taking channel-aligned taps.
          vec3 maskRgb = vec3(sampleR.r, sampleC.g, sampleB.b);

          // Luminance still drives cheap reject and overall energy.
          float maskScalar = msLuminance(maskRgb);
          if (maskScalar <= 0.001) discard;

          // Shape with gamma-like falloff — matches V1 uFalloff usage.
          // Apply falloff per-channel so mask tint and RGB split remain visible.
          vec3 shaped = pow(clamp(maskRgb, 0.0, 1.0), vec3(uFalloff));

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
          float skyMix = (uUseSkyTint > 0.5) ? (1.0 - exp(-max(uSkyTintStrength, 0.0) * 0.16)) : 0.0;
          vec3 tintColor = mix(vec3(1.0), skyTint, clamp(skyMix, 0.0, 1.0));
          // Keep daytime windows from drifting too cool under strong sky tint.
          float warmDayFactor = clamp((uNightFactor - 0.45) / 0.55, 0.0, 1.0);
          vec3 daylightWarmTint = vec3(1.05, 1.0, 0.94);
          vec3 envTintColor = mix(tintColor, tintColor * daylightWarmTint, 0.35 * warmDayFactor);

          float cloudDimming = mix(1.0, clamp(uCloudFactor, 0.0, 1.0), clamp(uCloudInfluence, 0.0, 1.0));
          float cloudShadow = 1.0;
          if (uHasCloudShadowTex > 0.5) {
            vec2 shadowUv = gl_FragCoord.xy / max(uScreenSize, vec2(1.0));
            if (uHasCloudShadowViewBounds > 0.5) {
              vec2 vbSize = max(uCloudShadowViewMax - uCloudShadowViewMin, vec2(1e-3));
              shadowUv = (vWorldXY - uCloudShadowViewMin) / vbSize;
            }
            float s = clamp(texture2D(uCloudShadowTex, clamp(shadowUv, 0.0, 1.0)).r, 0.0, 1.0);
            s = clamp((s - 0.5) * max(uCloudShadowContrast, 0.0) + 0.5 + uCloudShadowBias, 0.0, 1.0);
            s = pow(s, max(uCloudShadowGamma, 0.01));
            cloudShadow = max(s, clamp(uCloudShadowMinLight, 0.0, 1.0));
          }
          float rainDarkenMul = 1.0 - clamp(uRainDarken, 0.0, 1.0) * clamp(uRainAmount, 0.0, 1.0) * 0.35;

          vec3 lightOut = shaped * (uColor * envTintColor) * uIntensity * flicker * max(uNightFactor, 0.0) * cloudDimming * cloudShadow * rainDarkenMul;

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
    mesh.position.set(centerX, centerY, z);
    mesh.rotation.z = rotation;
    mesh.renderOrder = 40;

    // Add to the isolated window light scene (not the bus scene).
    // Floor visibility is managed by onFloorChange() instead of the bus.
    this._scene.add(mesh);
    this._overlays.set(tileId, { mesh, material, floorIndex });

    // Load texture asynchronously.
    const loader = new THREE.TextureLoader();
    loader.load(maskUrl, (tex) => {
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
      const tileMid = (tileBottom + tileTop) / 2;

      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        if (tileMid >= f.elevationMin && tileMid <= f.elevationMax) return i;
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
}
