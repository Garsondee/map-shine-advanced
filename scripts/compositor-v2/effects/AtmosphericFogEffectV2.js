/**
 * @fileoverview AtmosphericFogEffectV2 — V2 weather-driven atmospheric distance fog.
 * Renders distance-based atmospheric fog controlled by weatherController.fogDensity
 * @module compositor-v2/effects/AtmosphericFogEffectV2
 */

import { createLogger } from '../../core/log.js';
import { weatherController } from '../../core/WeatherController.js';
import { resolveEffectWindWorld } from './resolve-effect-wind.js';

const log = createLogger('AtmosphericFogEffectV2');

const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));

/**
 * @param {string} hex
 * @param {import('three').Color} out
 * @returns {import('three').Color}
 */
function setLinearColorFromHex(hex, out) {
  out.set(hex);
  if (typeof out.convertSRGBToLinear === 'function') {
    out.convertSRGBToLinear();
  }
  return out;
}

/**
 * Atmospheric Fog Effect
 * 
 * Renders distance-based fog as a post-processing pass.
 * Fog density is driven by weatherController.currentState.fogDensity.
 * 
 * Features:
 * - Distance-based fog falloff from camera/view center
 * - Configurable fog color (defaults to scene ambient or white)
 * - Respects indoor/outdoor mask to avoid fogging indoors
 * - Smooth transitions via weatherController interpolation
 */
export class AtmosphericFogEffectV2 {
  constructor() {
    /** @type {string} */
    this.id = 'atmospheric-fog';
    /** @type {boolean} */
    this.enabled = true;

    this.priority = 5;

    /** @type {THREE.ShaderMaterial|null} */
    this.material = null;

    /** @type {THREE.Scene|null} */
    this.quadScene = null;

    /** @type {THREE.OrthographicCamera|null} */
    this.quadCamera = null;

    /** @type {THREE.Mesh|null} */
    this.quadMesh = null;

    /** @type {THREE.Texture|null} */
    this.outdoorsMask = null;

    this.params = {
      enabled: true,
      
      // Fog appearance
      fogColor: '#c8d0d8',      // Slightly blue-gray fog
      fogColorNight: '#1a1a2e', // Darker blue at night
      skyTintStrength: 0.0,
      nightColorStrength: 0.75,
      darknessStrength: 0.65,
      darknessColorMin: 0.25,

      // HDR post-merge (linear scene before ColorCorrection)
      hdrHazeStrength: 1.0,     // Luminance-matched lift haze (avoids crushing HDR brights)
      fogAdditive: 0.35,        // Extra air glow added in linear space
      fogRefLuminance: 0.14,    // Reference scene luma for matching fog radiance
      lightOcclusionStrength: 1.0, // Smother Foundry lights / emissive hotspots in fog
      useDepthModulation: false,  // Depth pass modulates fog per-pixel when true

      // Fog behavior
      maxOpacity: 0.72,         // Maximum fog opacity at full density
      falloffStart: 0.1,        // Distance (0-1 of scene) where fog starts
      falloffEnd: 0.9,          // Distance (0-1 of scene) where fog reaches max
      
      // Indoor masking
      useIndoorMask: true,      // Respect outdoor mask to avoid indoor fog
      indoorFogReduction: 0.9,  // How much to reduce fog indoors (0 = full fog, 1 = no fog)
      useRoofDistanceFeather: true, // Soft wall clearance via roof distance field
      indoorBufferPx: 48,
      indoorSoftnessPx: 120,
      
      // Noise for organic look
      noiseEnabled: true,
      noiseScale: 2.0,
      noiseStrength: 0.15,
      noiseSpeed: 0.05,
      noiseContrast: 1.35,
      advectionSpeed: 1.0,
      windDirResponsiveness: 6.0,
      curlStrength: 0.55,
      curlScale: 1.0,

      // Macro fog shaping & storm reactivity
      macroScale: 0.05,
      macroStrength: 0.8,
      buildingEncroachment: 1.0,
      swirlIterations: 2,
      rainResponsiveness: 1.0,

      cutoutEnabled: true,
      cutoutScale: 0.22,
      cutoutStrength: 0.4,
      cutoutSpeed: 0.02,
      cutoutContrast: 1.25,

      // Adds on top of WeatherController fogDensity (control panel / weather presets).
      manualFogDensity: 0.0,
      weatherFogInfluence: 1.0,

      // Debug: ignore masks / world bounds; full-screen radial haze at density.
      debugForceFog: false,
    };

    this._initialized = false;

    /** @type {THREE.DataTexture|null} */
    this._fallbackOutdoors = null;

    /** @type {number} */
    this._lastFogDensity = 0.0;

    /** @type {number} Monotonic render counter for diagnostics. */
    this._renderFrameCount = 0;

    this._lastTimeValue = null;
    this._windTime = 0.0;
    this._windOffsetNoise = null;
    this._smoothedWindDir = null;
    this._tempWindTarget = null;

    this._cutoutTime = 0.0;

    /** @type {function|null} Unsubscribe from EffectMaskRegistry */
    this._registryUnsub = null;
  }

  /**
   * Get UI control schema
   */
  static getControlSchema() {
    return {
      enabled: true,
      help: {
        title: 'Atmospheric Fog & Air',
        summary: [
          'Adds air depth, fog color, and weather-driven atmosphere on the merged linear HDR frame (before Camera Grade).',
          'Composites using aerial perspective (scene transmittance + scattered air radiance), not by boosting local brightness.',
          'Fog density follows the weather control panel Fog slider and presets (Mist, Fog Dense). Manual Fog Density adds on top.',
          'Macro shape creates large fog banks and clear gaps; swirls add fluid detail; rain breaks up fog during storms.',
          'Use Camera Grade for exposure and tone mapping — not this pass.'
        ].join('\n\n'),
        glossary: {
          'Macro shape': 'Large-scale fog banks and clear-air pockets that stop the fog looking like a flat overlay.',
          'Swirl depth': 'Iterated domain warping — deeper settings produce more fluid, twisting tendrils.',
          'Building encroachment': 'Thick fog banks push closer to walls; clear gaps pull fog away from buildings.',
          'Rain responsiveness': 'How aggressively precipitation churns and shears the fog during storms.',
          'Sky tint': 'How much the current sky/environment color tints fog.',
          'Night color': 'How strongly fog shifts toward the night fog color at high darkness.',
          'HDR haze': 'Luminance-matched lift on the linear composite — visible air without crushing bright pixels.',
          'Light smothering': 'How strongly fog occludes Foundry lights and emissive hotspots instead of amplifying them.',
        },
      },
      groups: [
        {
          name: 'density',
          label: 'Density & Falloff',
          type: 'inline',
          parameters: ['manualFogDensity', 'weatherFogInfluence', 'maxOpacity', 'falloffStart', 'falloffEnd'],
        },
        {
          name: 'color',
          label: 'Color & Lighting',
          type: 'folder',
          expanded: false,
          parameters: ['fogColor', 'fogColorNight', 'skyTintStrength', 'nightColorStrength', 'darknessStrength', 'darknessColorMin'],
        },
        {
          name: 'composite',
          label: 'HDR Composite',
          type: 'folder',
          expanded: false,
          parameters: ['hdrHazeStrength', 'fogAdditive', 'fogRefLuminance', 'lightOcclusionStrength'],
        },
        {
          name: 'macro',
          label: 'Fog Banks & Storms',
          type: 'inline',
          parameters: ['macroScale', 'macroStrength', 'buildingEncroachment', 'rainResponsiveness'],
        },
        {
          name: 'swirl',
          label: 'Swirls & Detail',
          type: 'inline',
          parameters: ['noiseEnabled', 'noiseScale', 'noiseStrength', 'noiseContrast', 'curlStrength', 'curlScale', 'swirlIterations'],
        },
        {
          name: 'motion',
          label: 'Wind & Motion',
          type: 'folder',
          expanded: false,
          parameters: ['noiseSpeed', 'advectionSpeed', 'windDirResponsiveness'],
        },
        {
          name: 'mask',
          label: 'Indoor & Building Mask',
          type: 'folder',
          expanded: false,
          parameters: ['useIndoorMask', 'indoorFogReduction', 'useRoofDistanceFeather', 'indoorBufferPx', 'indoorSoftnessPx'],
        },
        {
          name: 'cutout',
          label: 'Low-Density Cutout',
          type: 'folder',
          expanded: false,
          parameters: ['cutoutEnabled', 'cutoutScale', 'cutoutStrength', 'cutoutSpeed', 'cutoutContrast'],
        },
        {
          name: 'advanced',
          label: 'Advanced',
          type: 'folder',
          expanded: false,
          parameters: ['useDepthModulation', 'debugForceFog'],
        },
      ],
      parameters: {
        enabled: { type: 'boolean', default: true },
        manualFogDensity: {
          type: 'slider', min: 0, max: 1, step: 0.01, default: 0.0,
          label: 'Manual Fog Density',
          tooltip: 'Adds to weather fog density. Use for always-on haze when weather is off.',
        },
        weatherFogInfluence: {
          type: 'slider', min: 0, max: 1, step: 0.05, default: 1.0,
          label: 'Weather Fog Influence',
          tooltip: 'How much the weather panel Fog slider and presets affect this pass.',
        },
        maxOpacity: {
          type: 'slider', min: 0, max: 1, step: 0.05, default: 0.72,
          label: 'Max Opacity',
          tooltip: 'Ceiling on fog strength at full density.',
        },
        falloffStart: {
          type: 'slider', min: 0, max: 1, step: 0.05, default: 0.1,
          label: 'Falloff Start',
          tooltip: 'Normalized view distance where edge haze begins.',
        },
        falloffEnd: {
          type: 'slider', min: 0, max: 1, step: 0.05, default: 0.9,
          label: 'Falloff End',
          tooltip: 'Normalized view distance where edge haze reaches full strength.',
        },
        hdrHazeStrength: {
          type: 'slider', min: 0, max: 2, step: 0.05, default: 1.0,
          label: 'HDR Haze Strength',
          tooltip: 'Luminance-matched haze on the linear HDR composite.',
        },
        fogAdditive: {
          type: 'slider', min: 0, max: 1, step: 0.02, default: 0.35,
          label: 'Fog Glow Add',
          tooltip: 'Extra air glow added in linear space.',
        },
        fogRefLuminance: {
          type: 'slider', min: 0.02, max: 0.5, step: 0.01, default: 0.14,
          label: 'Reference Luminance',
          tooltip: 'Target air radiance in linear HDR space. Fog scatter is anchored here, not to local lights.',
        },
        lightOcclusionStrength: {
          type: 'slider', min: 0, max: 1, step: 0.05, default: 1.0,
          label: 'Light Smothering',
          tooltip: 'How strongly fog occludes Foundry lights and emissive hotspots. 0 = no extra occlusion.',
        },
        fogColor: { type: 'color', default: '#c8d0d8', label: 'Fog Color' },
        fogColorNight: { type: 'color', default: '#1a1a2e', label: 'Night Fog Color' },
        skyTintStrength: {
          type: 'slider', min: 0, max: 3, step: 0.05, default: 0.0,
          label: 'Sky Tint Strength',
          tooltip: 'How much the live sky/environment color tints fog.',
        },
        nightColorStrength: {
          type: 'slider', min: 0, max: 3, step: 0.05, default: 0.75,
          label: 'Night Color Strength',
          tooltip: 'Blend toward night fog color as scene darkness rises.',
        },
        darknessStrength: {
          type: 'slider', min: 0, max: 3, step: 0.05, default: 0.65,
          label: 'Darkness Strength',
          tooltip: 'How much LightingDirector darkness affects fog color.',
        },
        darknessColorMin: {
          type: 'slider', min: 0, max: 1, step: 0.01, default: 0.25,
          label: 'Darkness Min Color',
          tooltip: 'Floor luminance when darkness crushes fog tint.',
        },
        useIndoorMask: {
          type: 'boolean', default: true,
          label: 'Reduce Indoors',
          tooltip: 'Fade fog where the outdoors mask marks interior space.',
        },
        useDepthModulation: {
          type: 'boolean', default: false,
          label: 'Depth Modulation',
          tooltip: 'Elevated tiles and tokens receive less fog via the depth pass.',
        },
        indoorFogReduction: {
          type: 'slider', min: 0, max: 1, step: 0.05, default: 0.9,
          label: 'Indoor Reduction',
          tooltip: '1 = no fog indoors, 0 = full fog indoors.',
        },
        useRoofDistanceFeather: {
          type: 'boolean',
          default: true,
          label: 'Distance-Field Clearance',
          tooltip: 'Soft fog falloff near building walls using the roof distance field.',
        },
        indoorBufferPx: {
          type: 'slider', min: 0, max: 400, step: 5, default: 48,
          label: 'Building Clearance (px)',
          tooltip: 'Hard clearance band before fog ramps in, measured from walls.',
        },
        indoorSoftnessPx: {
          type: 'slider', min: 0, max: 600, step: 5, default: 120,
          label: 'Clearance Softness (px)',
          tooltip: 'Width of the soft ramp after the hard clearance band.',
        },
        macroScale: {
          type: 'slider', min: 0.01, max: 0.3, step: 0.01, default: 0.05,
          label: 'Bank Scale',
          tooltip: 'Size of macro fog banks and clear-air gaps. Lower = larger features.',
        },
        macroStrength: {
          type: 'slider', min: 0, max: 1, step: 0.05, default: 0.8,
          label: 'Bank Contrast',
          tooltip: 'How strongly macro noise carves dense banks vs clear pockets.',
        },
        buildingEncroachment: {
          type: 'slider', min: 0, max: 1, step: 0.05, default: 1.0,
          label: 'Building Encroachment',
          tooltip: 'Thick fog banks hug walls; clear gaps pull fog away. 0 = static clearance only.',
        },
        rainResponsiveness: {
          type: 'slider', min: 0, max: 2, step: 0.05, default: 1.0,
          label: 'Rain Responsiveness',
          tooltip: 'How much precipitation breaks fog into turbulent streaks.',
        },
        noiseEnabled: { type: 'boolean', default: true, label: 'Enable Swirls' },
        noiseScale: {
          type: 'slider', min: 0.5, max: 10, step: 0.5, default: 2.0,
          label: 'Detail Scale',
          tooltip: 'Fine noise scale for micro fog texture.',
        },
        noiseStrength: {
          type: 'slider', min: 0, max: 0.5, step: 0.01, default: 0.15,
          label: 'Detail Strength',
          tooltip: 'Amplitude of fine noise variation on top of macro banks.',
        },
        noiseSpeed: {
          type: 'slider', min: 0, max: 0.2, step: 0.01, default: 0.05,
          label: 'Animation Speed',
          tooltip: 'Base rate for fog noise evolution.',
        },
        advectionSpeed: {
          type: 'slider', min: 0, max: 4, step: 0.05, default: 1.0,
          label: 'Wind Drift',
          tooltip: 'How fast fog texture advects with wind.',
        },
        windDirResponsiveness: {
          type: 'slider', min: 0.1, max: 10, step: 0.1, default: 6.0,
          label: 'Wind Turn Rate',
          tooltip: 'How quickly fog motion follows wind direction changes.',
        },
        noiseContrast: {
          type: 'slider', min: 0.5, max: 2.5, step: 0.05, default: 1.35,
          label: 'Detail Contrast',
          tooltip: 'Sharpens or softens fine noise variation.',
        },
        curlStrength: {
          type: 'slider', min: 0, max: 3, step: 0.05, default: 0.55,
          label: 'Swirl Strength',
          tooltip: 'Intensity of domain-warp swirls.',
        },
        curlScale: {
          type: 'slider', min: 0.1, max: 6, step: 0.05, default: 1.0,
          label: 'Swirl Scale',
          tooltip: 'Size of swirl features in the domain warp.',
        },
        swirlIterations: {
          type: 'dropdown',
          default: 2,
          label: 'Swirl Depth',
          tooltip: 'Domain-warp iterations: Basic = simple swirls, Fluid = tendrils, Chaotic = turbulent.',
          options: { Basic: 1, Fluid: 2, Chaotic: 3 },
        },
        cutoutEnabled: {
          type: 'boolean', default: true,
          label: 'Enable Cutout',
          tooltip: 'Large holes at low density to reduce the painted-on look.',
        },
        cutoutScale: {
          type: 'slider', min: 0.02, max: 1.0, step: 0.01, default: 0.22,
          label: 'Cutout Scale',
        },
        cutoutStrength: {
          type: 'slider', min: 0, max: 1.0, step: 0.01, default: 0.4,
          label: 'Cutout Strength',
        },
        cutoutSpeed: {
          type: 'slider', min: 0, max: 0.2, step: 0.01, default: 0.02,
          label: 'Cutout Speed',
        },
        cutoutContrast: {
          type: 'slider', min: 0.5, max: 3.0, step: 0.05, default: 1.25,
          label: 'Cutout Contrast',
        },
        debugForceFog: {
          type: 'boolean',
          default: false,
          label: 'Force Full-Screen Fog',
          tooltip: 'Ignore masks; show radial haze at density for debugging.',
          gmOnly: true,
        },
      },
      presets: {
        'Clear Noon': {
          maxOpacity: 0.18,
          skyTintStrength: 0.2,
          nightColorStrength: 0.4,
          darknessStrength: 0.4,
          noiseStrength: 0.08,
          macroStrength: 0.45,
          swirlIterations: 1,
          buildingEncroachment: 0.5,
        },
        'Golden Hour': {
          fogColor: '#d8c4a5',
          maxOpacity: 0.28,
          skyTintStrength: 0.45,
          nightColorStrength: 0.45,
          darknessStrength: 0.45,
          macroStrength: 0.55,
        },
        'Overcast Day': {
          fogColor: '#b8c1ca',
          maxOpacity: 0.42,
          skyTintStrength: 0.6,
          nightColorStrength: 0.7,
          darknessStrength: 0.55,
          macroStrength: 0.75,
          swirlIterations: 2,
        },
        Storm: {
          fogColor: '#8f99a6',
          fogColorNight: '#111827',
          maxOpacity: 0.62,
          skyTintStrength: 0.75,
          nightColorStrength: 1.15,
          darknessStrength: 0.85,
          macroStrength: 0.9,
          swirlIterations: 3,
          rainResponsiveness: 1.4,
          buildingEncroachment: 1.0,
          noiseStrength: 0.2,
        },
        'Moonlit Night': {
          fogColor: '#9aa8c4',
          fogColorNight: '#11172e',
          maxOpacity: 0.26,
          skyTintStrength: 0.35,
          nightColorStrength: 1.0,
          darknessStrength: 0.65,
          macroStrength: 0.6,
        },
        'Interior Night': {
          maxOpacity: 0.16,
          useIndoorMask: true,
          indoorFogReduction: 0.95,
          nightColorStrength: 0.75,
          darknessStrength: 0.45,
          buildingEncroachment: 0.75,
        },
      },
    };
  }

  initialize(renderer, scene, camera) {
    if (this._initialized) return;

    this.renderer = renderer;
    this.mainScene = scene;
    this.camera = camera;

    const THREE = window.THREE;
    if (!THREE) {
      log.error('THREE not available');
      return;
    }

    // Create quad scene for post-processing
    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // Fallback outdoors mask (treat everything as outdoors = 1.0)
    // This prevents shader sampling from a null texture if the roof/outdoor mask
    // is not available yet.
    const outdoorsData = new Uint8Array([255, 255, 255, 255]);
    this._fallbackOutdoors = new THREE.DataTexture(outdoorsData, 1, 1, THREE.RGBAFormat);
    this._fallbackOutdoors.needsUpdate = true;

    // Neutral roof-distance fallback: max distance (outdoors, far from buildings).
    const roofDistData = new Uint8Array([255, 255, 255, 255]);
    this._fallbackRoofDistance = new THREE.DataTexture(roofDistData, 1, 1, THREE.RGBAFormat);
    this._fallbackRoofDistance.needsUpdate = true;

    this._windOffsetNoise = new THREE.Vector2(0, 0);
    this._smoothedWindDir = new THREE.Vector2(1, 0);
    this._tempWindTarget = new THREE.Vector2(1, 0);

    this._cutoutTime = 0.0;

    // Create shader material
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tOutdoors: { value: this._fallbackOutdoors },
        tRoofDistance: { value: this._fallbackRoofDistance },
        uFogColor: { value: new THREE.Color(0xc8d0d8) },
        uFogDensity: { value: 0.0 },
        uMaxOpacity: { value: 0.72 },
        uFalloffStart: { value: 0.1 },
        uFalloffEnd: { value: 0.9 },
        uUseIndoorMask: { value: 1.0 },
        uIndoorFogReduction: { value: 0.9 },
        uIndoorBufferPx: { value: 80.0 },
        uIndoorSoftnessPx: { value: 140.0 },
        uRoofDistanceMaxPx: { value: 1.0 },
        uNoiseEnabled: { value: 1.0 },
        uNoiseScale: { value: 2.0 },
        uNoiseStrength: { value: 0.15 },
        uTime: { value: 0.0 },
        uNoiseSpeed: { value: 0.05 },
        uNoiseContrast: { value: 1.35 },
        uWindDir: { value: new THREE.Vector2(1, 0) },
        uWindSpeed: { value: 0.0 },
        uWindOffsetNoise: { value: new THREE.Vector2(0, 0) },
        uWindTime: { value: 0.0 },
        uCurlStrength: { value: 0.55 },
        uCurlScale: { value: 1.0 },
        uMacroScale: { value: 0.05 },
        uMacroStrength: { value: 0.8 },
        uBuildingEncroachment: { value: 1.0 },
        uRainIntensity: { value: 0.0 },
        uSwirlIterations: { value: 2.0 },
        uCutoutEnabled: { value: 1.0 },
        uCutoutScale: { value: 0.22 },
        uCutoutStrength: { value: 0.4 },
        uCutoutTime: { value: 0.0 },
        uCutoutContrast: { value: 1.25 },
        // Three.js world-space view bounds (minX,minY,maxX,maxY)
        uViewBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
        // Foundry sceneRect bounds (x,y,width,height) in Foundry coords (top-left origin, Y-down)
        uSceneBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
        // Full canvas dimensions (including padding) in Foundry coords
        uSceneDimensions: { value: new THREE.Vector2(1, 1) },
        uScreenSize: { value: new THREE.Vector2(1, 1) },
        // Depth pass integration: per-pixel depth modulates fog density.
        // Elevated objects (tiles at Z+1..4, tokens at Z+3) are closer to the
        // camera than the ground plane, so they receive less fog.
        uDepthTexture: { value: null },
        uDepthEnabled: { value: 0.0 },
        uDepthCameraNear: { value: 800.0 },
        uDepthCameraFar: { value: 1200.0 },
        uGroundDistance: { value: 1000.0 },
        uDepthFogStrength: { value: 1.0 },
        uFogRefLuminance: { value: 0.14 },
        uFogHdrHaze: { value: 1.0 },
        uFogAdditive: { value: 0.35 },
        uLightOcclusionStrength: { value: 1.0 },
        uHasOutdoorsMask: { value: 0.0 },
        uOutdoorsMaskFlipY: { value: 0.0 },
        uRoofDistanceFlipY: { value: 0.0 },
        uDebugForceFog: { value: 0.0 },
        uFogAirLiftMin: { value: 0.12 },
        uUseRoofDistanceFeather: { value: 1.0 },
        uErodeRadiusPx: { value: 0.0 }
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
        uniform sampler2D tOutdoors;
        uniform sampler2D tRoofDistance;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform float uMaxOpacity;
        uniform float uFalloffStart;
        uniform float uFalloffEnd;
        uniform float uUseIndoorMask;
        uniform float uIndoorFogReduction;
        uniform float uIndoorBufferPx;
        uniform float uIndoorSoftnessPx;
        uniform float uRoofDistanceMaxPx;
        uniform float uNoiseEnabled;
        uniform float uNoiseScale;
        uniform float uNoiseStrength;
        uniform float uTime;
        uniform float uNoiseSpeed;
        uniform float uNoiseContrast;
        uniform vec2 uWindDir;
        uniform float uWindSpeed;
        uniform vec2 uWindOffsetNoise;
        uniform float uWindTime;
        uniform float uCurlStrength;
        uniform float uCurlScale;
        uniform float uMacroScale;
        uniform float uMacroStrength;
        uniform float uBuildingEncroachment;
        uniform float uRainIntensity;
        uniform float uSwirlIterations;
        uniform float uCutoutEnabled;
        uniform float uCutoutScale;
        uniform float uCutoutStrength;
        uniform float uCutoutTime;
        uniform float uCutoutContrast;
        uniform vec4 uViewBounds;
        uniform vec4 uSceneBounds;
        uniform vec2 uSceneDimensions;
        uniform vec2 uScreenSize;
        uniform float uHasOutdoorsMask;
        uniform float uOutdoorsMaskFlipY;
        uniform float uRoofDistanceFlipY;
        uniform float uDebugForceFog;
        uniform float uFogAirLiftMin;
        uniform float uUseRoofDistanceFeather;
        uniform float uErodeRadiusPx;

        // Depth pass integration
        uniform sampler2D uDepthTexture;
        uniform float uDepthEnabled;
        uniform float uDepthCameraNear;
        uniform float uDepthCameraFar;
        uniform float uGroundDistance;
        uniform float uDepthFogStrength;
        uniform float uFogRefLuminance;
        uniform float uFogHdrHaze;
        uniform float uFogAdditive;
        uniform float uLightOcclusionStrength;

        varying vec2 vUv;

        // Linearize perspective device depth [0,1] → eye-space distance.
        // Uses the tight depth camera's near/far (NOT main camera).
        float msa_linearizeDepth(float d) {
          float z_ndc = d * 2.0 - 1.0;
          return (2.0 * uDepthCameraNear * uDepthCameraFar) /
                 (uDepthCameraFar + uDepthCameraNear - z_ndc * (uDepthCameraFar - uDepthCameraNear));
        }

        // Simple hash for noise
        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 345.45));
          p += dot(p, p + 34.345);
          return fract(p.x * p.y);
        }

        // Value noise
        float noise2(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          float a = hash21(i);
          float b = hash21(i + vec2(1.0, 0.0));
          float c = hash21(i + vec2(0.0, 1.0));
          float d = hash21(i + vec2(1.0, 1.0));
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
        }

        // FBM noise
        float fbm(vec2 p) {
          float f = 0.0;
          f += 0.5 * noise2(p); p *= 2.01;
          f += 0.25 * noise2(p); p *= 2.02;
          f += 0.125 * noise2(p);
          return f / 0.875;
        }

        // Three world XY → Foundry sceneRect UV (matches CloudEffectV2 / water-shader).
        vec2 worldToSceneUv(vec2 worldXY) {
          float foundryY = uSceneDimensions.y - worldXY.y;
          return vec2(
            (worldXY.x - uSceneBounds.x) / max(uSceneBounds.z, 1.0),
            (foundryY - uSceneBounds.y) / max(uSceneBounds.w, 1.0)
          );
        }

        vec2 roofDistanceUv(vec2 sceneUvFoundry) {
          vec2 uv = clamp(sceneUvFoundry, 0.0, 1.0);
          if (uRoofDistanceFlipY > 0.5) uv.y = 1.0 - uv.y;
          return uv;
        }

        float sampleOutdoors01(vec2 sceneUvFoundry, float inScene) {
          if (uHasOutdoorsMask < 0.5) return 1.0;
          vec2 maskUv = clamp(sceneUvFoundry, 0.0, 1.0);
          if (uOutdoorsMaskFlipY > 0.5) maskUv.y = 1.0 - maskUv.y;
          vec4 od = texture2D(tOutdoors, maskUv);
          float outdoorRaw = clamp(max(od.r, max(od.g, od.b)), 0.0, 1.0);
          float outdoorMid = smoothstep(0.18, 0.82, outdoorRaw);
          float outdoorClass = (outdoorRaw <= 0.10) ? 0.0 : ((outdoorRaw >= 0.90) ? 1.0 : outdoorMid);
          float outdoorsAlphaValid = step(0.5, clamp(od.a, 0.0, 1.0));
          float isOutdoor = mix(1.0, outdoorClass, outdoorsAlphaValid);
          return mix(1.0, isOutdoor, inScene);
        }

        // Min-filter _Outdoors: pull fog away from building silhouettes by N scene pixels.
        float outdoorsErodeMin(vec2 sceneUv, float inScene) {
          float m = sampleOutdoors01(sceneUv, inScene);
          float px = clamp(uErodeRadiusPx, 0.0, 128.0);
          if (px < 0.5) return m;

          vec2 texel = vec2(
            1.0 / max(uSceneBounds.z, 1.0),
            1.0 / max(uSceneBounds.w, 1.0)
          );
          vec2 reach = texel * px;

          // 3×3 immediate neighbors (anti-alias mask edge)
          for (int j = -1; j <= 1; j++) {
            for (int i = -1; i <= 1; i++) {
              vec2 o = clamp(sceneUv + vec2(float(i), float(j)) * texel, vec2(0.0), vec2(1.0));
              m = min(m, sampleOutdoors01(o, inScene));
            }
          }

          // 8 directions at full clearance distance
          m = min(m, sampleOutdoors01(clamp(sceneUv + vec2(reach.x, 0.0), vec2(0.0), vec2(1.0)), inScene));
          m = min(m, sampleOutdoors01(clamp(sceneUv + vec2(-reach.x, 0.0), vec2(0.0), vec2(1.0)), inScene));
          m = min(m, sampleOutdoors01(clamp(sceneUv + vec2(0.0, reach.y), vec2(0.0), vec2(1.0)), inScene));
          m = min(m, sampleOutdoors01(clamp(sceneUv + vec2(0.0, -reach.y), vec2(0.0), vec2(1.0)), inScene));
          vec2 rd = reach * 0.70710678;
          m = min(m, sampleOutdoors01(clamp(sceneUv + vec2(rd.x, rd.y), vec2(0.0), vec2(1.0)), inScene));
          m = min(m, sampleOutdoors01(clamp(sceneUv + vec2(-rd.x, rd.y), vec2(0.0), vec2(1.0)), inScene));
          m = min(m, sampleOutdoors01(clamp(sceneUv + vec2(rd.x, -rd.y), vec2(0.0), vec2(1.0)), inScene));
          m = min(m, sampleOutdoors01(clamp(sceneUv + vec2(-rd.x, -rd.y), vec2(0.0), vec2(1.0)), inScene));

          vec2 halfReach = reach * 0.5;
          m = min(m, sampleOutdoors01(clamp(sceneUv + vec2(halfReach.x, 0.0), vec2(0.0), vec2(1.0)), inScene));
          m = min(m, sampleOutdoors01(clamp(sceneUv + vec2(-halfReach.x, 0.0), vec2(0.0), vec2(1.0)), inScene));
          m = min(m, sampleOutdoors01(clamp(sceneUv + vec2(0.0, halfReach.y), vec2(0.0), vec2(1.0)), inScene));
          m = min(m, sampleOutdoors01(clamp(sceneUv + vec2(0.0, -halfReach.y), vec2(0.0), vec2(1.0)), inScene));

          return m;
        }

        // Cheaper warping vector than 4-tap curl — enables iterated domain warping.
        vec2 warp(vec2 p) {
          float x = fbm(p);
          float y = fbm(p + vec2(13.5, 82.1));
          return vec2(x, y) * 2.0 - 1.0;
        }

        void main() {
          vec4 sceneColor = texture2D(tDiffuse, vUv);
          
          if (uFogDensity <= 0.001) {
            gl_FragColor = sceneColor;
            return;
          }

          float worldX = mix(uViewBounds.x, uViewBounds.z, vUv.x);
          float worldY = mix(uViewBounds.y, uViewBounds.w, vUv.y);
          vec2 sceneUvRaw = worldToSceneUv(vec2(worldX, worldY));
          float inScene =
            step(0.0, sceneUvRaw.x) * step(sceneUvRaw.x, 1.0) *
            step(0.0, sceneUvRaw.y) * step(sceneUvRaw.y, 1.0);

          vec2 viewCenter = vec2(
            (uViewBounds.x + uViewBounds.z) * 0.5,
            (uViewBounds.y + uViewBounds.w) * 0.5
          );
          float viewW = max(1.0, (uViewBounds.z - uViewBounds.x));
          float viewH = max(1.0, (uViewBounds.w - uViewBounds.y));
          float dx = (worldX - viewCenter.x) / (viewW * 0.5);
          float dy = (worldY - viewCenter.y) / (viewH * 0.5);
          float radial = clamp(sqrt(dx * dx + dy * dy) / 1.41421356, 0.0, 1.0);
          float fogFalloff = mix(0.72, 1.0, smoothstep(uFalloffStart, uFalloffEnd, radial));

          float noiseVal = 0.0;
          float noiseShape = 0.5;
          float macroShape = 1.0;

          vec2 p = vec2(worldX, worldY) * 0.00035;
          float t = uWindTime;
          vec2 w1 = vec2(0.0);

          if (uNoiseEnabled > 0.5) {
            // 1. Macro shape — large fog banks and clear-air gaps
            vec2 p_macro = p * uMacroScale + uWindOffsetNoise * 0.5;
            macroShape = fbm(p_macro + vec2(t * 0.02, -t * 0.015));
            macroShape = smoothstep(0.2, 0.8, macroShape);

            // 2. Curls on curls — iterated domain warping
            vec2 p_micro = p * uNoiseScale + uWindOffsetNoise;
            p_micro += vec2(t * 0.05, -t * 0.05);

            w1 = warp(p_micro * uCurlScale) * uCurlStrength;
            p_micro += w1;

            if (uSwirlIterations >= 1.5) {
              vec2 w2 = warp(p_micro * uCurlScale * 2.0 - vec2(t * 0.1)) * (uCurlStrength * 0.5);
              p_micro += w2;
            }

            if (uSwirlIterations >= 2.5) {
              vec2 w3 = warp(p_micro * uCurlScale * 3.5 + vec2(t * 0.15, -t * 0.12)) * (uCurlStrength * 0.25);
              p_micro += w3;
            }

            // 3. Rain evolution — fast downward/windward shear
            if (uRainIntensity > 0.01) {
              vec2 rainShear = vec2(uWindDir.x * 0.5, 1.0) * (uTime * 3.0 * uRainIntensity);
              float rainChurn = fbm((p_micro * 3.0) + rainShear);
              macroShape *= mix(1.0, smoothstep(0.3, 0.7, rainChurn), uRainIntensity * 0.8);
              p_micro += warp(p_micro * 5.0 + uTime) * (0.2 * uRainIntensity);
            }

            float nA = fbm(p_micro);
            float nB = fbm(p_micro * 2.07 + w1 * 1.5);
            float n = mix(nA, nB, 0.6);
            n = pow(clamp(n, 0.0, 1.0), max(uNoiseContrast, 0.01));

            noiseShape = n;
            noiseVal = (n - 0.5) * uNoiseStrength;
          }

          // Dynamic indoor masking — macro fog pushes against buildings
          float fogGate = 1.0;
          float distClear = 1.0;
          if (uUseIndoorMask > 0.5) {
            float rawOutdoors = sampleOutdoors01(sceneUvRaw, inScene);
            fogGate = smoothstep(0.18, 0.72, rawOutdoors);

            if (uUseRoofDistanceFeather > 0.5 && uRoofDistanceMaxPx > 1.5) {
              float distNorm = texture2D(tRoofDistance, roofDistanceUv(sceneUvRaw)).r;
              float distPx = distNorm * uRoofDistanceMaxPx;

              float encMix = clamp(uBuildingEncroachment, 0.0, 1.0);
              float gapMul = mix(1.0, 2.0, encMix);
              float bankMul = mix(1.0, 0.2, encMix);
              float dynamicEncroachment = mix(gapMul, bankMul, macroShape);
              float t0 = max(0.0, uIndoorBufferPx * dynamicEncroachment);
              float t1 = t0 + max(8.0, uIndoorSoftnessPx);
              distClear = smoothstep(t0, t1, distPx);
              distClear = distClear * distClear * (3.0 - 2.0 * distClear);
            }
          }

          float outdoorFactor = fogGate * mix(1.0 - uIndoorFogReduction, 1.0, distClear);

          float d = clamp(uFogDensity, 0.0, 1.0);
          float macroMultiplier = mix(1.0, macroShape, uMacroStrength);
          float shaped = clamp(fogFalloff + noiseVal, 0.0, 1.5) * macroMultiplier;
          float fogStrength = 1.0 - exp(-d * 2.25 * shaped);
          fogStrength = clamp(fogStrength * mix(0.65, 1.35, noiseShape), 0.0, 1.0);

          // Large-scale cutout at low density: creates big holes/lobes that fade out as density approaches 1.
          // This reduces the "painted on" look when density is low/medium.
          if (uCutoutEnabled > 0.5 && uCutoutStrength > 0.001) {
            float fade = pow(clamp(1.0 - d, 0.0, 1.0), 1.35);
            vec2 q = vec2(worldX, worldY) * (max(uCutoutScale, 0.001) * 0.00008);
            q += uWindOffsetNoise * 0.10;
            q += vec2(uCutoutTime * 0.05, -uCutoutTime * 0.04);
            float c = fbm(q);
            c = pow(clamp(c, 0.0, 1.0), max(uCutoutContrast, 0.01));
            float cut = smoothstep(0.35, 0.75, c);
            fogStrength *= (1.0 - (uCutoutStrength * fade * cut));
          }

          // Depth-based fog modulation: elevated objects get less fog.
          // Ground plane is at uGroundDistance from camera. Tiles/tokens/roofs
          // are closer (smaller linear depth). The ratio gives a natural fog
          // gradient: ground=1.0, BG≈0.999, FG≈0.998, tokens≈0.997, roofs≈0.996.
          // smoothstep maps this to a visible reduction curve.
          float depthFogMod = 1.0;
          if (uDepthEnabled > 0.5) {
            float deviceDepth = texture2D(uDepthTexture, vUv).r;
            if (deviceDepth < 0.9999) {
              float linDepth = msa_linearizeDepth(deviceDepth);
              float depthRatio = linDepth / max(uGroundDistance, 1.0);
              // Ramp: ground (ratio≈1.0) → full fog, overhead (ratio≈0.996) → ~55% fog
              depthFogMod = mix(1.0, smoothstep(0.990, 1.001, depthRatio), uDepthFogStrength);
            }
          }

          float fogAmount = clamp(
            fogStrength * uMaxOpacity * outdoorFactor * depthFogMod,
            0.0, uMaxOpacity);

          if (uDebugForceFog > 0.5) {
            fogAmount = clamp(uFogDensity * uMaxOpacity, 0.0, 1.0);
            fogGate = 1.0;
            distClear = 1.0;
          }

          if (fogGate < 0.01 || fogAmount < 0.001) {
            gl_FragColor = sceneColor;
            return;
          }

          // ── Composite (linear HDR, pre–Color Correction) ─────────────────────
          // Transmittance aerial perspective: air radiance is environment-scattered light.
          // Local emissive hotspots (Foundry lights) must be occluded, not amplified.
          vec3 sceneRgb = sceneColor.rgb;
          float sceneLum = max(dot(sceneRgb, vec3(0.2126, 0.7152, 0.0722)), 1e-5);
          float refLum = max(uFogRefLuminance, 1e-4);

          vec3 airTint = uFogColor * mix(0.9, 1.1, noiseShape);
          float airLum = max(dot(airTint, vec3(0.2126, 0.7152, 0.0722)), 1e-5);
          float targetAirLum = max(uFogAirLiftMin, refLum);
          if (airLum < targetAirLum) {
            airTint *= targetAirLum / airLum;
            airLum = targetAirLum;
          }

          float blend = clamp(fogAmount * uFogHdrHaze, 0.0, 1.0);
          float transmittance = 1.0 - blend;

          // Hotspots: crush direct visibility so fog smothers lamps/tokens instead of blooming with them.
          float hotspot = smoothstep(refLum * 2.5, refLum * 16.0, sceneLum);
          float smother = clamp(uLightOcclusionStrength, 0.0, 1.0);
          transmittance *= mix(1.0, 0.06, hotspot * smother * blend);

          vec3 fogged = sceneRgb * transmittance + airTint * (1.0 - transmittance);

          // Gentle aerial desaturation in deep fog
          fogged = mix(vec3(dot(fogged, vec3(0.2126, 0.7152, 0.0722))), fogged, 1.0 - blend * 0.35);

          // Additive air glow — suppressed on bright emitters (fog adds scatter, not lamp bloom)
          float glowMask = mix(1.0, 0.12, hotspot);
          fogged += airTint * (1.0 - transmittance) * uFogAdditive * 0.2 * glowMask;

          // Never let fog raise luminance above the occluded ceiling
          float outLum = max(dot(fogged, vec3(0.2126, 0.7152, 0.0722)), 1e-5);
          float occludedCeiling = airLum + sceneLum * transmittance * 0.65;
          if (outLum > occludedCeiling) {
            fogged *= occludedCeiling / outLum;
          }

          vec3 finalColor = clamp(fogged, 0.0, 64.0);

          gl_FragColor = vec4(finalColor, sceneColor.a);
        }
      `,
      depthWrite: false,
      depthTest: false,
      transparent: false
    });

    // Create fullscreen quad
    const geometry = new THREE.PlaneGeometry(2, 2);
    this.quadMesh = new THREE.Mesh(geometry, this.material);
    this.quadScene.add(this.quadMesh);

    this._initialized = true;
    log.info('AtmosphericFogEffectV2 initialized');
  }

  /**
   * Set the outdoor mask texture (from WeatherController)
   */
  setOutdoorsMask(texture) {
    this.outdoorsMask = texture;
    if (!this.material) return;
    const u = this.material.uniforms;
    const tex = texture || this._fallbackOutdoors;
    u.tOutdoors.value = tex;
    const isFallback = !texture || texture === this._fallbackOutdoors;
    u.uHasOutdoorsMask.value = isFallback ? 0.0 : 1.0;
    u.uOutdoorsMaskFlipY.value = (!isFallback && tex?.flipY) ? 1.0 : 0.0;
  }

  /**
   * Subscribe to the EffectMaskRegistry for 'outdoors' mask updates.
   * @param {import('../assets/EffectMaskRegistry.js').EffectMaskRegistry} registry
   */
  connectToRegistry(registry) {
    if (this._registryUnsub) { this._registryUnsub(); this._registryUnsub = null; }
    this._registryUnsub = registry.subscribe('outdoors', (texture) => {
      this.setOutdoorsMask(texture);
    });
  }

  /**
   * Set input/output buffers from EffectComposer
   */
  setBuffers(readBuffer, writeBuffer) {
    this.readBuffer = readBuffer;
    this.writeBuffer = writeBuffer;
  }

  /**
   * Set input texture
   */
  setInputTexture(texture) {
    if (this.material) {
      this.material.uniforms.tDiffuse.value = texture;
    }
  }

  update(timeInfo) {
    if (!this._initialized || !this.material) return;

    const u = this.material.uniforms;

    // Fog density: weather (control panel / presets) + optional manual offset.
    if (weatherController?.initialized !== true && typeof weatherController?.initialize === 'function') {
      void weatherController.initialize();
    }
    const weatherFog = this._resolveWeatherFogDensity();
    const weatherInfluence = clamp01(this.params.weatherFogInfluence ?? 1.0);
    const manualFog = clamp01(this.params.manualFogDensity ?? 0.0);
    const fogDensity = clamp01(weatherFog * weatherInfluence + manualFog);
    this._lastFogDensity = fogDensity;
    u.uFogDensity.value = fogDensity;

    u.uFogRefLuminance.value = Math.max(0.02, Number(this.params.fogRefLuminance ?? 0.14) || 0.14);
    u.uFogHdrHaze.value = Math.max(0.0, Number(this.params.hdrHazeStrength ?? 1.0) || 0.0);
    u.uFogAdditive.value = Math.max(0.0, Number(this.params.fogAdditive ?? 0.35) || 0.0);
    u.uLightOcclusionStrength.value = clamp01(this.params.lightOcclusionStrength ?? 1.0);

    if (Math.random() < 0.002) {
      log.debug(`AtmosphericFogEffect: fogDensity=${fogDensity.toFixed(3)}, enabled=${this.enabled}, paramEnabled=${this.params.enabled !== false}`);
    }

    // Update params (fog tint in linear HDR space)
    try {
      const expEase01 = (x) => 1.0 - Math.exp(-Math.max(0.0, x));
      const baseFog = u.uFogColor.value;
      setLinearColorFromHex(this.params.fogColor, baseFog);

      const env = weatherController?.getEnvironment ? weatherController.getEnvironment() : null;
      const skyColor = env?.skyColor;
      const skyIntensity = clamp01(env?.skyIntensity ?? 1.0);

      let sceneDarkness = 0.0;
      try {
        sceneDarkness = canvas?.environment?.darknessLevel ?? canvas?.scene?.environment?.darknessLevel ?? 0.0;
      } catch (_) {
        sceneDarkness = 0.0;
      }
      if (env && Number.isFinite(env.sceneDarkness)) sceneDarkness = env.sceneDarkness;

      const d01 = clamp01(sceneDarkness);

      // 1) Night color: mix toward configured night fog color as scene darkness rises.
      // Use exp easing so high strengths really slam into the night color.
      const nightStrength = Math.max(0.0, Number(this.params.nightColorStrength ?? 2.0) || 0.0);
      const nightMix = expEase01(d01 * nightStrength);
      if (nightMix > 0.0001) {
        const nightCol = (this._tempNightFog ||= new window.THREE.Color(0, 0, 0));
        setLinearColorFromHex(this.params.fogColorNight, nightCol);
        baseFog.lerp(nightCol, Math.min(1.0, nightMix));
      }

      // 2) Sky tint: apply both a strong hue shift (lerp) and a multiplicative tint.
      // We intentionally allow skyTintStrength > 1.0.
      const skyStrength = Math.max(0.0, Number(this.params.skyTintStrength ?? 0.0) || 0.0);
      if (skyStrength > 0.0 && skyColor && typeof skyColor.r === 'number') {
        const skyK = skyStrength * skyIntensity;
        const skyMix = expEase01(0.75 * skyK);
        const skyMul = expEase01(0.25 * skyK);

        const target = (this._tempSkyColor ||= new window.THREE.Color(1, 1, 1));
        target.copy(skyColor);

        const pre = (this._tempFogPreTint ||= new window.THREE.Color(1, 1, 1));
        pre.copy(baseFog);

        baseFog.lerp(target, Math.min(1.0, skyMix));

        const mulCol = (this._tempFogMul ||= new window.THREE.Color(1, 1, 1));
        mulCol.copy(pre).multiply(target);
        baseFog.lerp(mulCol, Math.min(1.0, skyMul));
      }

      const darkStrength = Math.max(0.0, Number(this.params.darknessStrength ?? 1.0) || 0.0);
      const darkInfluence = clamp01(clamp01(sceneDarkness) * darkStrength);
      const darkMin = clamp01(Number(this.params.darknessColorMin ?? 0.25) || 0.25);
      // Soften darkness crush — aggressive multiply + shader mix caused black screen.
      baseFog.multiplyScalar(1.0 - darkInfluence * (1.0 - darkMin) * 0.35);
      // Floor fog tint luminance in linear space (luma match in shader handles HDR scale).
      const minL = 0.04;
      baseFog.r = Math.max(minL, baseFog.r);
      baseFog.g = Math.max(minL, baseFog.g);
      baseFog.b = Math.max(minL, baseFog.b);

      // Minimum air luminance so compositing reads as haze, not gray shadow.
      const refLum = Math.max(0.02, Number(this.params.fogRefLuminance ?? 0.14) || 0.14);
      let airLiftMin = Math.max(minL, refLum * 1.5);
      if (skyColor && typeof skyColor.r === 'number') {
        const skyLum = (
          0.2126 * Math.max(0, skyColor.r)
          + 0.7152 * Math.max(0, skyColor.g)
          + 0.0722 * Math.max(0, skyColor.b)
        );
        airLiftMin = Math.max(airLiftMin, skyLum * 0.45);
      }
      u.uFogAirLiftMin.value = airLiftMin * (1.0 - darkInfluence * 0.25);
    } catch (_) {
      setLinearColorFromHex(this.params.fogColor, u.uFogColor.value);
      u.uFogAirLiftMin.value = 0.12;
    }
    u.uMaxOpacity.value = this.params.maxOpacity;
    u.uFalloffStart.value = this.params.falloffStart;
    u.uFalloffEnd.value = this.params.falloffEnd;
    u.uUseIndoorMask.value = this.params.useIndoorMask ? 1.0 : 0.0;
    u.uIndoorFogReduction.value = this.params.indoorFogReduction ?? 0.9;
    u.uUseRoofDistanceFeather.value = this.params.useRoofDistanceFeather === true ? 1.0 : 0.0;
    u.uIndoorBufferPx.value = this.params.indoorBufferPx ?? 48;
    u.uIndoorSoftnessPx.value = this.params.indoorSoftnessPx ?? 120;
    // Mask erosion is deprecated — it produced binary edges; distance field handles wall softness.
    u.uErodeRadiusPx.value = 0.0;
    u.uNoiseEnabled.value = this.params.noiseEnabled ? 1.0 : 0.0;
    u.uNoiseScale.value = this.params.noiseScale;
    u.uNoiseStrength.value = this.params.noiseStrength;
    u.uNoiseSpeed.value = this.params.noiseSpeed;
    u.uNoiseContrast.value = this.params.noiseContrast ?? 1.35;
    u.uCurlStrength.value = this.params.curlStrength ?? 0.55;
    u.uCurlScale.value = this.params.curlScale ?? 1.0;
    u.uMacroScale.value = this.params.macroScale ?? 0.05;
    u.uMacroStrength.value = this.params.macroStrength ?? 0.8;
    u.uBuildingEncroachment.value = clamp01(this.params.buildingEncroachment ?? 1.0);
    u.uSwirlIterations.value = Math.max(1, Math.min(3, Math.round(this.params.swirlIterations ?? 2)));

    u.uCutoutEnabled.value = this.params.cutoutEnabled ? 1.0 : 0.0;
    u.uCutoutScale.value = this.params.cutoutScale ?? 0.22;
    u.uCutoutStrength.value = this.params.cutoutStrength ?? 0.4;
    u.uCutoutContrast.value = this.params.cutoutContrast ?? 1.25;
    u.uDebugForceFog.value = this.params.debugForceFog === true ? 1.0 : 0.0;
    u.uTime.value = timeInfo?.elapsed ?? 0;

    const elapsed = Number.isFinite(timeInfo?.elapsed) ? timeInfo.elapsed : 0.0;
    const dtSeconds = (this._lastTimeValue === null) ? 0.0 : Math.max(0.0, elapsed - this._lastTimeValue);
    this._lastTimeValue = elapsed;

    const cutoutSpeed = Number.isFinite(this.params?.cutoutSpeed) ? Math.max(0.0, this.params.cutoutSpeed) : 0.02;
    this._cutoutTime += dtSeconds * cutoutSpeed;
    if (u.uCutoutTime) u.uCutoutTime.value = this._cutoutTime;

    try {
      const { dirX, dirY, speed01: w01 } = resolveEffectWindWorld();

      const resp = Number.isFinite(this.params?.windDirResponsiveness)
        ? Math.max(0.05, this.params.windDirResponsiveness)
        : 6.0;

      // Noise uses camera world XY (Y-up); weather wind is Foundry Y-down.
      const tx = dirX;
      const ty = -dirY;

      if (this._smoothedWindDir && dtSeconds > 0.0) {
        const k = 1.0 - Math.exp(-dtSeconds * resp);
        if (this._tempWindTarget) this._tempWindTarget.set(tx, ty);
        this._smoothedWindDir.lerp(this._tempWindTarget ?? this._smoothedWindDir, Math.min(1.0, Math.max(0.0, k)));
        u.uWindDir.value.set(this._smoothedWindDir.x, this._smoothedWindDir.y);
      } else {
        if (this._smoothedWindDir) this._smoothedWindDir.set(tx, ty);
        u.uWindDir.value.set(tx, ty);
      }

      u.uWindSpeed.value = w01;

      if (dtSeconds > 0.0 && this._windOffsetNoise && u.uWindOffsetNoise) {
        const advMul = Number.isFinite(this.params?.advectionSpeed) ? Math.max(0.0, this.params.advectionSpeed) : 1.0;
        const pxPerSec = (25.0 + 220.0 * w01) * advMul;
        const noiseScaleFactor = (Number.isFinite(u.uNoiseScale?.value) ? u.uNoiseScale.value : 2.0) * 0.00035;

        const dx = (this._smoothedWindDir?.x ?? tx);
        const dy = (this._smoothedWindDir?.y ?? ty);

        // Subtract offset so f(world + offset) drifts with wind (CloudEffectV2 convention).
        this._windOffsetNoise.x -= dx * (pxPerSec * dtSeconds) * noiseScaleFactor;
        this._windOffsetNoise.y -= dy * (pxPerSec * dtSeconds) * noiseScaleFactor;
        u.uWindOffsetNoise.value.set(this._windOffsetNoise.x, this._windOffsetNoise.y);
      }

      if (u.uWindTime) {
        const baseRate = Number.isFinite(this.params?.noiseSpeed) ? this.params.noiseSpeed : 0.05;
        const windRate = baseRate * (0.35 + 2.25 * w01);
        this._windTime += dtSeconds * windRate;
        u.uWindTime.value = this._windTime;
      }

      // Rain/precipitation churn — breaks fog during storms
      let rainIntensity = 0.0;
      const weatherState = weatherController?.getCurrentState?.() ?? weatherController?.currentState;
      if (weatherState) {
        const precip = weatherState.precipitation ?? weatherState.rain ?? 0.0;
        rainIntensity = clamp01(precip * (this.params.rainResponsiveness ?? 1.0));
      }
      u.uRainIntensity.value = rainIntensity;
    } catch (_) {
      u.uWindDir.value.set(1, 0);
      u.uWindSpeed.value = 0.0;
      if (u.uWindOffsetNoise && this._windOffsetNoise) {
        u.uWindOffsetNoise.value.set(this._windOffsetNoise.x, this._windOffsetNoise.y);
      }
      if (u.uWindTime) {
        const baseRate = Number.isFinite(this.params?.noiseSpeed) ? this.params.noiseSpeed : 0.05;
        this._windTime += dtSeconds * baseRate * 0.35;
        u.uWindTime.value = this._windTime;
      }
      u.uRainIntensity.value = 0.0;
    }

    // _Outdoors is bound via FloorCompositor._syncOutdoorsMaskConsumers / setOutdoorsMask.
    if (!u.tOutdoors.value) {
      this.setOutdoorsMask(this._fallbackOutdoors);
    }

    // Distance map for smooth building buffer (generated once per load).
    // Prefer WeatherController fallback if compositor hasn't explicitly provided a map.
    if (this.params.useIndoorMask && weatherController?.roofDistanceMap) {
      const distTex = weatherController.roofDistanceMap;
      u.tRoofDistance.value = distTex;
      u.uRoofDistanceMaxPx.value = Number(weatherController.roofDistanceMapMaxPx) || 1.0;
      u.uRoofDistanceFlipY.value = distTex?.flipY ? 1.0 : 0.0;
    } else if (this.params.useIndoorMask) {
      u.tRoofDistance.value = this._fallbackRoofDistance ?? this._fallbackOutdoors;
      u.uRoofDistanceMaxPx.value = 1.0;
      u.uRoofDistanceFlipY.value = 0.0;
    }

    // Update view bounds
    this._updateViewBounds();

    // Update scene bounds
    this._updateSceneBounds();

    // IMPORTANT: Do not disable based on fogDensity.
    // EffectComposer only calls update() for enabled effects, so if we
    // disable when fogDensity hits 0, we can never "wake back up" when the
    // user increases fog density.
    this.enabled = this.params.enabled !== false;
  }

  _updateViewBounds() {
    const camera = this.camera || window.MapShine?.sceneComposer?.camera;
    if (!camera || !this.material) return;

    const u = this.material.uniforms;
    const camPos = camera.position;

    if (camera.isPerspectiveCamera) {
      const sceneComposer = window.MapShine?.sceneComposer;
      const groundZ = Number.isFinite(sceneComposer?.groundZ) ? sceneComposer.groundZ : 0;
      const distance = Math.max(1, camPos.z - groundZ);
      const vFov = camera.fov * Math.PI / 180.0;
      const visibleHeight = 2 * Math.tan(vFov / 2) * distance;
      const visibleWidth = visibleHeight * camera.aspect;

      u.uViewBounds.value.set(
        camPos.x - visibleWidth / 2,
        camPos.y - visibleHeight / 2,
        camPos.x + visibleWidth / 2,
        camPos.y + visibleHeight / 2
      );
    } else if (camera.isOrthographicCamera) {
      u.uViewBounds.value.set(
        camPos.x + camera.left / camera.zoom,
        camPos.y + camera.bottom / camera.zoom,
        camPos.x + camera.right / camera.zoom,
        camPos.y + camera.top / camera.zoom
      );
    }
  }

  _updateSceneBounds() {
    if (!this.material) return;

    const u = this.material.uniforms;
    const fd = window.MapShine?.sceneComposer?.foundrySceneData ?? null;

    // Match SceneRectScissor / base plane (same source as world projection).
    if (fd && Number(fd.height) > 0 && Number(fd.width) > 0) {
      u.uSceneBounds.value.set(
        Number(fd.sceneX ?? 0),
        Number(fd.sceneY ?? 0),
        Number(fd.sceneWidth ?? fd.width ?? 1),
        Number(fd.sceneHeight ?? fd.height ?? 1),
      );
      u.uSceneDimensions.value.set(Number(fd.width), Number(fd.height));
    } else {
      const dims = canvas?.dimensions;
      if (!dims) return;
      const rect = dims.sceneRect;
      u.uSceneBounds.value.set(
        rect?.x ?? 0,
        rect?.y ?? 0,
        rect?.width ?? dims.width ?? 1,
        rect?.height ?? dims.height ?? 1,
      );
      u.uSceneDimensions.value.set(dims.width ?? 1, dims.height ?? 1);
    }

    // Screen size
    const size = new window.THREE.Vector2();
    this.renderer?.getDrawingBufferSize(size);
    u.uScreenSize.value.copy(size);
  }

  render(renderer, camera, inputRT, outputRT) {
    if (!this._initialized) return false;
    if (!this.enabled || this.params?.enabled === false) return false;

    this.camera = camera || this.camera;
    // Ensure density/uniforms are current even if update() was skipped this frame.
    const uPre = this.material?.uniforms;
    if (uPre) {
      const d = clamp01(
        this._resolveWeatherFogDensity() * clamp01(this.params.weatherFogInfluence ?? 1.0)
        + clamp01(this.params.manualFogDensity ?? 0.0),
      );
      this._lastFogDensity = d;
      uPre.uFogDensity.value = d;
    }
    this._updateViewBounds();
    this._updateSceneBounds();

    const inputTexture = inputRT?.texture || this.readBuffer?.texture || this.material.uniforms.tDiffuse.value;
    if (!inputTexture) return false;

    this.material.uniforms.tDiffuse.value = inputTexture;
    if (this.outdoorsMask) {
      this.setOutdoorsMask(this.outdoorsMask);
    }

    // Bind depth pass texture for per-pixel fog modulation
    const dpm = window.MapShine?.depthPassManager;
    const depthWanted = this.params.useDepthModulation === true;
    const depthTex = (depthWanted && dpm && dpm.isEnabled()) ? dpm.getDepthTexture() : null;
    const u = this.material.uniforms;
    u.uDepthEnabled.value = depthTex ? 1.0 : 0.0;
    u.uDepthTexture.value = depthTex;
    if (depthTex && dpm) {
      u.uDepthCameraNear.value = dpm.getDepthNear();
      u.uDepthCameraFar.value = dpm.getDepthFar();
      u.uGroundDistance.value = window.MapShine?.sceneComposer?.groundDistance ?? 1000.0;
    }

    const target = outputRT || this.writeBuffer || null;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    if (target) {
      renderer.setRenderTarget(target);
    } else {
      renderer.setRenderTarget(null);
    }
    renderer.autoClear = true;
    renderer.render(this.quadScene, this.quadCamera);
    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);

    this._renderFrameCount += 1;
    return true;
  }

  /** @returns {number} Last combined fog density pushed to the shader (0..1). */
  getLastFogDensity() {
    return this._lastFogDensity;
  }

  /**
   * Live GPU uniform snapshot for debugging (console).
   * @returns {object|null}
   */
  getDiagnostics() {
    const u = this.material?.uniforms;
    if (!u) return null;
    const vb = u.uViewBounds?.value;
    const sb = u.uSceneBounds?.value;
    const sd = u.uSceneDimensions?.value;
    return {
      lastFogDensity: this._lastFogDensity,
      uFogDensity: u.uFogDensity?.value,
      uMaxOpacity: u.uMaxOpacity?.value,
      uFogHdrHaze: u.uFogHdrHaze?.value,
      uFogAdditive: u.uFogAdditive?.value,
      uLightOcclusionStrength: u.uLightOcclusionStrength?.value,
      uFogRefLuminance: u.uFogRefLuminance?.value,
      uUseIndoorMask: u.uUseIndoorMask?.value,
      uHasOutdoorsMask: u.uHasOutdoorsMask?.value,
      uDebugForceFog: u.uDebugForceFog?.value,
      uRoofDistanceMaxPx: u.uRoofDistanceMaxPx?.value,
      uRainIntensity: u.uRainIntensity?.value,
      uMacroScale: u.uMacroScale?.value,
      uMacroStrength: u.uMacroStrength?.value,
      uBuildingEncroachment: u.uBuildingEncroachment?.value,
      uSwirlIterations: u.uSwirlIterations?.value,
      hasOutdoorsMaskBinding: !!this.outdoorsMask,
      renderFrameCount: this._renderFrameCount,
      viewBounds: vb ? { x0: vb.x, y0: vb.y, x1: vb.z, y1: vb.w } : null,
      sceneBounds: sb ? { x: sb.x, y: sb.y, w: sb.z, h: sb.w } : null,
      sceneDimensions: sd ? { w: sd.x, h: sd.y } : null,
      initialized: this._initialized,
      enabled: this.enabled,
      paramsEnabled: this.params?.enabled !== false,
    };
  }

  onResize(width, height) {
    if (this.material?.uniforms?.uScreenSize) {
      this.material.uniforms.uScreenSize.value.set(width, height);
    }
  }

  dispose() {
    if (this._registryUnsub) { this._registryUnsub(); this._registryUnsub = null; }
    if (this.quadMesh) {
      this.quadMesh.geometry.dispose();
      this.quadScene.remove(this.quadMesh);
    }
    if (this.material) {
      this.material.dispose();
    }

    if (this._fallbackOutdoors) {
      try { this._fallbackOutdoors.dispose(); } catch (_) {}
      this._fallbackOutdoors = null;
    }
    if (this._fallbackRoofDistance) {
      try { this._fallbackRoofDistance.dispose(); } catch (_) {}
      this._fallbackRoofDistance = null;
    }
    this._initialized = false;
    log.info('AtmosphericFogEffectV2 disposed');
  }

  /**
   * Weather fog density from current + target (control panel writes targetState).
   * @returns {number}
   * @private
   */
  _resolveWeatherFogDensity() {
    const wc = weatherController;
    if (!wc) return 0;
    const cur = Number(wc.currentState?.fogDensity);
    const tgt = Number(wc.targetState?.fogDensity);
    const fromCurrent = Number.isFinite(cur) ? cur : 0;
    const fromTarget = Number.isFinite(tgt) ? tgt : 0;
    if (wc.enabled === false && wc.dynamicEnabled !== true) {
      return Math.max(fromTarget, fromCurrent);
    }
    const live = Number(wc.getCurrentState?.()?.fogDensity);
    return Number.isFinite(live) ? Math.max(live, fromTarget) : Math.max(fromCurrent, fromTarget);
  }

}
