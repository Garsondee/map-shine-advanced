/**
 * @fileoverview Specular highlight effect using PBR lighting
 * First effect implementation - demonstrates masked texture + custom shader
 * @module effects/SpecularEffect
 */

import { EffectBase, RenderLayers, OVERLAY_THREE_LAYER } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import { ShaderValidator } from '../core/shader-validator.js';
import { weatherController, PrecipitationType } from '../core/WeatherController.js';
import Coordinates from '../utils/coordinates.js';

const log = createLogger('SpecularEffect');

// Tile overlay pass ordering bands.
// Keep all occluders in an earlier global band and all additive color meshes
// in a later band so no color pass can run before every occluder has written depth.
const TILE_SPEC_OCCLUDER_ORDER_BASE = 6000;
const TILE_SPEC_COLOR_ORDER_BASE = 7000;

/**
 * Specular highlight effect with PBR lighting model
 * Uses _Specular mask to drive metallic/glossy surface reflections
 */
export class SpecularEffect extends EffectBase {
  constructor() {
    super('specular', RenderLayers.MATERIAL, 'low');
    
    this.priority = 10; // Render early in material layer
    this.alwaysRender = true; // Core visual effect
    
    // Backing field for enabled property
    this._enabled = true;
    
    /** @type {THREE.Mesh|null} */
    this.mesh = null;
    
    /** @type {THREE.Texture|null} */
    this.specularMask = null;
    
    /** @type {THREE.Texture|null} */
    this.roughnessMask = null;
    
    /** @type {THREE.Texture|null} */
    this.normalMap = null;
    
    /** @type {THREE.ShaderMaterial|null} */
    this.material = null;

    /** @type {string[]} */
    this.validationErrors = [];

    /** @type {Set<THREE.ShaderMaterial>} */
    this._materials = new Set();

    /** @type {THREE.Scene|null} */
    this._scene = null;

    /** @type {Map<string, {
     *   sprite: THREE.Object3D,
     *   occluderMesh: THREE.Mesh|null,
     *   occluderMaterial: THREE.ShaderMaterial|null,
     *   colorMesh: THREE.Mesh|null,
     *   colorMaterial: THREE.ShaderMaterial|null
     * }>} */
    this._tileOverlays = new Map();

    // Light tracking
    this.lights = new Map();
    this.maxLights = 64;
    
    // Effect parameters (exposed to Tweakpane later)
    this.params = {
      // Status
      textureStatus: 'Searching...',
      hasSpecularMask: true,

      intensity: 0.53,           // Default shine intensity
      roughness: 0.0,
      metallic: 0.0,             // Metallic factor (unused in current shader but defined for completeness)
      lightDirection: { x: 0.6, y: 0.4, z: 0.7 },
      lightColor: { r: 1.0, g: 1.0, b: 1.0 },
      
      // Multi-layer stripe system
      stripeEnabled: true,
      stripeBlendMode: 0,       // 0=Add, 1=Multiply, 2=Screen, 3=Overlay
      parallaxStrength: 1.5,    // Global parallax intensity multiplier
      stripeMaskThreshold: 0.1, // 0 = all mask, 1 = only brightest texels
      worldPatternScale: 3072.0, // World-space stripe scale in pixels (higher = larger pattern)
      
      // Layer 1 - Primary stripes
      stripe1Enabled: true,
      stripe1Frequency: 11.0,
      stripe1Speed: 0,
      stripe1Angle: 115.0,
      stripe1Width: 0.21,
      stripe1Intensity: 5.0,
      stripe1Parallax: 0.2,     // Parallax offset (0 = no parallax)
      stripe1Wave: 1.7,         // Stripe waviness amount
      stripe1Gaps: 0.31,        // Stripe breakup / shiny spots
      stripe1Softness: 2.14,    // Stripe edge softness (0=hard,5=very soft)
      
      // Layer 2 - Secondary stripes
      stripe2Enabled: true,
      stripe2Frequency: 15.5,
      stripe2Speed: 0,      // Negative = opposite direction
      stripe2Angle: 111.0,
      stripe2Width: 0.38,
      stripe2Intensity: 5.0,
      stripe2Parallax: 0.1,
      stripe2Wave: 1.6,
      stripe2Gaps: 0.5,
      stripe2Softness: 3.93,
      
      // Layer 3 - Tertiary stripes
      stripe3Enabled: true,
      stripe3Frequency: 5.0,
      stripe3Speed: 0,
      stripe3Angle: 162.0,
      stripe3Width: 0.09,
      stripe3Intensity: 5.0,
      stripe3Parallax: -0.1,
      stripe3Wave: 0.4,
      stripe3Gaps: 0.37,
      stripe3Softness: 3.44,

      // Micro Sparkle
      sparkleEnabled: false,
      sparkleIntensity: 0.95,
      sparkleScale: 2460,
      sparkleSpeed: 1.38,

      // Outdoor Cloud Specular (cloud shadows drive specular intensity outdoors)
      outdoorCloudSpecularEnabled: true,
      outdoorStripeBlend: 0.8,     // How much stripes show outdoors (0=none, 1=full)
      cloudSpecularIntensity: 0.37, // Intensity of cloud-driven specular outdoors

      // Wet Surface (Rain) - Derives specular from grayscale albedo during rain
      wetSpecularEnabled: true,
      wetSpecularThreshold: 0.5,    // DEPRECATED: wetness now driven by WeatherController tracker

      // Wet Input CC (shapes which albedo values become reflective)
      wetInputBrightness: 0.0,     // Pre-contrast brightness shift (-0.5 to 0.5)
      wetInputGamma: 1.0,          // Midtone curve before contrast (<1 brightens mids, >1 darkens)
      wetSpecularContrast: 3.0,    // Contrast boost on grayscale albedo
      wetBlackPoint: 0.2,          // Below this, surfaces don't shine (cuts dark areas)
      wetWhitePoint: 1.0,          // Above this, full shine (lower to tame bright surfaces)

      // Wet Output CC (shapes the final wet specular contribution)
      wetSpecularIntensity: 1.5,   // Overall wet shine multiplier
      wetOutputMax: 1.0,           // Hard brightness cap (prevents bloom explosion on whites)
      wetOutputGamma: 1.0,         // Output curve (<1 = brighter midtones, >1 = darker/punchier)

      // TODO: Snow Albedo Effect - Create a way for snow to change the colouration
      // of the albedo in outdoor areas. When freezeLevel > 0.55 and precipitation
      // is active (snow), blend outdoor albedo towards white/snow-tinted colour.
      // This should be a separate visual pass from the wet effect.

      // Frost/Ice Glaze (cold weather boosts specular on outdoor surfaces)
      frostGlazeEnabled: true,
      frostThreshold: 0.55,        // freezeLevel above which frost appears
      frostIntensity: 1.2,         // Specular boost multiplier when frosted
      frostTintStrength: 0.4,      // How much to shift specular toward cool blue-white (0-1)

      // Dynamic Light Color Tinting (stripes/sparkles pick up nearby light hues)
      dynamicLightTintEnabled: true,
      dynamicLightTintStrength: 0.6, // 0=global uLightColor only, 1=fully tinted by nearest light

      // Wind-Driven Stripe Animation (stripes drift with wind)
      windDrivenStripesEnabled: true,
      windStripeInfluence: 0.5,    // How much wind affects stripe drift (0=none, 1=full)

      // Building Shadow Suppression (suppress specular in building shadows)
      buildingShadowSuppressionEnabled: true,
      buildingShadowSuppressionStrength: 0.8 // 0=no suppression, 1=full shadow kill
    };

    this._tempScreenSize = null;
    this._tileOverlayPos = null;
    this._tileOverlayQuat = null;
    this._tileOverlayScale = null;
    this._tileOverlayRotQuat = null;

    this._fallbackAlbedo = null;
    this._fallbackBlack = null;
  }

  /**
   * Get enabled state
   * @returns {boolean} Enabled state
   */
  get enabled() {
    return this._enabled;
  }

  /**
   * Set enabled state and update shader uniform immediately
   * @param {boolean} value - New enabled state
   */
  set enabled(value) {
    this._enabled = value;
    
    // Update uniform immediately if material exists
    // This ensures the effect turns off even if the update loop stops
    // NOTE: EffectBase may set enabled during super() construction.
    // At that point, our constructor hasn't initialized _materials yet.
    const mats = this._materials;
    if (mats && typeof mats[Symbol.iterator] === 'function') {
      for (const mat of mats) {
        if (mat?.uniforms?.uEffectEnabled) {
          mat.uniforms.uEffectEnabled.value = value;
        }
      }
    } else if (this.material?.uniforms?.uEffectEnabled) {
      // Fallback for legacy single-material path.
      this.material.uniforms.uEffectEnabled.value = value;
    }
  }

  /**
   * Get UI control schema for Tweakpane
   * @returns {Object} Control schema definition
   * @public
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
          name: 'material',
          label: 'Material Properties',
          type: 'inline', // Controls shown directly (not in nested folder)
          parameters: ['intensity', 'roughness']
        },
        {
          name: 'stripe-settings',
          label: 'Stripe Settings',
          type: 'inline',
          separator: true, // Add separator before this group
          parameters: ['stripeEnabled', 'stripeBlendMode', 'parallaxStrength', 'stripeMaskThreshold', 'worldPatternScale']
        },
        {
          name: 'layer1',
          label: 'Layer 1',
          type: 'folder', // Nested collapsible folder
          separator: true,
          expanded: false,
          parameters: ['stripe1Enabled', 'stripe1Frequency', 'stripe1Speed', 'stripe1Angle', 'stripe1Width', 'stripe1Intensity', 'stripe1Parallax', 'stripe1Wave', 'stripe1Gaps', 'stripe1Softness']
        },
        {
          name: 'layer2',
          label: 'Layer 2',
          type: 'folder',
          expanded: false,
          parameters: ['stripe2Enabled', 'stripe2Frequency', 'stripe2Speed', 'stripe2Angle', 'stripe2Width', 'stripe2Intensity', 'stripe2Parallax', 'stripe2Wave', 'stripe2Gaps', 'stripe2Softness']
        },
        {
          name: 'layer3',
          label: 'Layer 3',
          type: 'folder',
          expanded: false,
          parameters: ['stripe3Enabled', 'stripe3Frequency', 'stripe3Speed', 'stripe3Angle', 'stripe3Width', 'stripe3Intensity', 'stripe3Parallax', 'stripe3Wave', 'stripe3Gaps', 'stripe3Softness']
        },
        {
          name: 'sparkle',
          label: 'Micro Sparkle',
          type: 'folder',
          expanded: false,
          parameters: ['sparkleEnabled', 'sparkleIntensity', 'sparkleScale', 'sparkleSpeed']
        },
        {
          name: 'outdoor-cloud-specular',
          label: 'Outdoor Cloud Specular',
          type: 'folder',
          expanded: false,
          parameters: ['outdoorCloudSpecularEnabled', 'outdoorStripeBlend', 'cloudSpecularIntensity']
        },
        {
          name: 'wet-surface',
          label: 'Wet Surface (Rain)',
          type: 'folder',
          expanded: false,
          parameters: [
            'wetSpecularEnabled',
            'wetInputBrightness', 'wetInputGamma', 'wetSpecularContrast', 'wetBlackPoint', 'wetWhitePoint',
            'wetSpecularIntensity', 'wetOutputMax', 'wetOutputGamma'
          ]
        },
        {
          name: 'frost-glaze',
          label: 'Frost / Ice Glaze',
          type: 'folder',
          expanded: false,
          parameters: ['frostGlazeEnabled', 'frostThreshold', 'frostIntensity', 'frostTintStrength']
        },
        {
          name: 'dynamic-light-tint',
          label: 'Dynamic Light Tinting',
          type: 'folder',
          expanded: false,
          parameters: ['dynamicLightTintEnabled', 'dynamicLightTintStrength']
        },
        {
          name: 'wind-driven-stripes',
          label: 'Wind-Driven Stripes',
          type: 'folder',
          expanded: false,
          parameters: ['windDrivenStripesEnabled', 'windStripeInfluence']
        },
        {
          name: 'building-shadow-suppression',
          label: 'Building Shadow Suppression',
          type: 'folder',
          expanded: false,
          parameters: ['buildingShadowSuppressionEnabled', 'buildingShadowSuppressionStrength']
        }
      ],
      parameters: {
        hasSpecularMask: {
          type: 'boolean',
          default: true
        },
        textureStatus: {
          type: 'string',
          label: 'Mask Status',
          default: 'Checking...',
          readonly: true
        },
        intensity: {
          type: 'slider',
          label: 'Specular Intensity',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.53,
          throttle: 100
        },
        roughness: {
          type: 'slider',
          label: 'Roughness',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.0,
          throttle: 100
        },
        
        stripeEnabled: {
          type: 'boolean',
          label: 'Enable Stripes',
          default: true
        },
        stripeBlendMode: {
          type: 'list',
          label: 'Stripe Blend Mode',
          options: {
            'Add': 0,
            'Multiply': 1,
            'Screen': 2,
            'Overlay': 3
          },
          default: 0
        },
        stripeMaskThreshold: {
          type: 'slider',
          label: 'Stripe Brightness Threshold',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.1,
          throttle: 100
        },
        worldPatternScale: {
          type: 'slider',
          label: 'Specular World Scale',
          min: 256,
          max: 8192,
          step: 16,
          default: 3072,
          throttle: 100
        },
        parallaxStrength: {
          type: 'slider',
          label: 'Parallax Strength',
          min: 0,
          max: 2,
          step: 0.1,
          default: 1.5,
          throttle: 100
        },
        stripe1Enabled: {
          type: 'boolean',
          label: 'Layer 1 Enabled',
          default: true
        },
        stripe1Frequency: {
          type: 'slider',
          label: 'Layer 1 Frequency',
          min: 0.5,
          max: 20,
          step: 0.5,
          default: 11.0,
          throttle: 100
        },
        stripe1Speed: {
          type: 'slider',
          label: 'Layer 1 Speed',
          min: -1,
          max: 1,
          step: 0.001,
          default: 0,
          throttle: 100
        },
        stripe1Angle: {
          type: 'slider',
          label: 'Layer 1 Angle',
          min: 0,
          max: 360,
          step: 1,
          default: 115,
          throttle: 100
        },
        stripe1Width: {
          type: 'slider',
          label: 'Layer 1 Width',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.21,
          throttle: 100
        },
        stripe1Intensity: {
          type: 'slider',
          label: 'Layer 1 Intensity',
          min: 0,
          max: 5,
          step: 0.01,
          default: 5.0,
          throttle: 100
        },
        stripe1Parallax: {
          type: 'slider',
          label: 'Layer 1 Parallax',
          min: -2,
          max: 2,
          step: 0.1,
          default: 0.2,
          throttle: 100
        },
        stripe1Wave: {
          type: 'slider',
          label: 'Layer 1 Wave',
          min: 0,
          max: 2,
          step: 0.1,
          default: 1.7,
          throttle: 100
        },
        stripe1Gaps: {
          type: 'slider',
          label: 'Layer 1 Gaps',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.31,
          throttle: 100
        },
        stripe1Softness: {
          type: 'slider',
          label: 'Layer 1 Softness',
          min: 0,
          max: 5,
          step: 0.01,
          default: 2.14,
          throttle: 100
        },
        stripe2Enabled: {
          type: 'boolean',
          label: 'Layer 2 Enabled',
          default: true
        },
        stripe2Frequency: {
          type: 'slider',
          label: 'Layer 2 Frequency',
          min: 0.5,
          max: 20,
          step: 0.5,
          default: 15.5,
          throttle: 100
        },
        stripe2Speed: {
          type: 'slider',
          label: 'Layer 2 Speed',
          min: -1,
          max: 1,
          step: 0.001,
          default: 0,
          throttle: 100
        },
        stripe2Angle: {
          type: 'slider',
          label: 'Layer 2 Angle',
          min: 0,
          max: 360,
          step: 1,
          default: 111,
          throttle: 100
        },
        stripe2Width: {
          type: 'slider',
          label: 'Layer 2 Width',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.38,
          throttle: 100
        },
        stripe2Intensity: {
          type: 'slider',
          label: 'Layer 2 Intensity',
          min: 0,
          max: 5,
          step: 0.01,
          default: 5.0,
          throttle: 100
        },
        stripe2Parallax: {
          type: 'slider',
          label: 'Layer 2 Parallax',
          min: -2,
          max: 2,
          step: 0.1,
          default: 0.1,
          throttle: 100
        },
        stripe2Wave: {
          type: 'slider',
          label: 'Layer 2 Wave',
          min: 0,
          max: 2,
          step: 0.1,
          default: 1.6,
          throttle: 100
        },
        stripe2Gaps: {
          type: 'slider',
          label: 'Layer 2 Gaps',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.5,
          throttle: 100
        },
        stripe2Softness: {
          type: 'slider',
          label: 'Layer 2 Softness',
          min: 0,
          max: 5,
          step: 0.01,
          default: 3.93,
          throttle: 100
        },
        stripe3Enabled: {
          type: 'boolean',
          label: 'Layer 3 Enabled',
          default: true
        },
        stripe3Frequency: {
          type: 'slider',
          label: 'Layer 3 Frequency',
          min: 0.5,
          max: 20,
          step: 0.5,
          default: 5.0,
          throttle: 100
        },
        stripe3Speed: {
          type: 'slider',
          label: 'Layer 3 Speed',
          min: -1,
          max: 1,
          step: 0.001,
          default: 0,
          throttle: 100
        },
        stripe3Angle: {
          type: 'slider',
          label: 'Layer 3 Angle',
          min: 0,
          max: 360,
          step: 1,
          default: 162,
          throttle: 100
        },
        stripe3Width: {
          type: 'slider',
          label: 'Layer 3 Width',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.09,
          throttle: 100
        },
        stripe3Intensity: {
          type: 'slider',
          label: 'Layer 3 Intensity',
          min: 0,
          max: 5,
          step: 0.01,
          default: 5.0,
          throttle: 100
        },
        stripe3Parallax: {
          type: 'slider',
          label: 'Layer 3 Parallax',
          min: -2,
          max: 2,
          step: 0.1,
          default: -0.1,
          throttle: 100
        },
        stripe3Wave: {
          type: 'slider',
          label: 'Layer 3 Wave',
          min: 0,
          max: 2,
          step: 0.1,
          default: 0.4,
          throttle: 100
        },
        stripe3Gaps: {
          type: 'slider',
          label: 'Layer 3 Gaps',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.37,
          throttle: 100
        },
        stripe3Softness: {
          type: 'slider',
          label: 'Layer 3 Softness',
          min: 0,
          max: 5,
          step: 0.01,
          default: 3.44,
          throttle: 100
        },
        sparkleEnabled: {
          type: 'boolean',
          label: 'Enable Sparkle',
          default: false
        },
        sparkleIntensity: {
          type: 'slider',
          label: 'Sparkle Intensity',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.95,
          throttle: 100
        },
        sparkleScale: {
          type: 'slider',
          label: 'Sparkle Scale',
          min: 100,
          max: 10000,
          step: 1,
          default: 2460,
          throttle: 100
        },
        sparkleSpeed: {
          type: 'slider',
          label: 'Sparkle Speed',
          min: 0,
          max: 5,
          step: 0.01,
          default: 1.38,
          throttle: 100
        },

        outdoorCloudSpecularEnabled: {
          type: 'boolean',
          label: 'Enable Cloud Specular',
          default: true
        },
        outdoorStripeBlend: {
          type: 'slider',
          label: 'Outdoor Stripe Blend',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.8,
          throttle: 100
        },
        cloudSpecularIntensity: {
          type: 'slider',
          label: 'Cloud Specular Intensity',
          min: 0,
          max: 3,
          step: 0.01,
          default: 3.0,
          throttle: 100
        },

        wetSpecularEnabled: {
          type: 'boolean',
          label: 'Enable Wet Surface',
          default: true
        },
        wetSpecularThreshold: {
          type: 'slider',
          label: 'Rain Threshold',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.5,
          throttle: 100
        },

        // --- Input CC ---
        wetInputBrightness: {
          type: 'slider',
          label: 'Input Brightness',
          min: -0.5,
          max: 0.5,
          step: 0.01,
          default: 0.0,
          throttle: 100
        },
        wetInputGamma: {
          type: 'slider',
          label: 'Input Gamma',
          min: 0.1,
          max: 3.0,
          step: 0.01,
          default: 1.0,
          throttle: 100
        },
        wetSpecularContrast: {
          type: 'slider',
          label: 'Input Contrast',
          min: 1,
          max: 10,
          step: 0.1,
          default: 3.0,
          throttle: 100
        },
        wetBlackPoint: {
          type: 'slider',
          label: 'Black Point',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.2,
          throttle: 100
        },
        wetWhitePoint: {
          type: 'slider',
          label: 'White Point',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 1.0,
          throttle: 100
        },

        // --- Output CC ---
        wetSpecularIntensity: {
          type: 'slider',
          label: 'Output Intensity',
          min: 0,
          max: 5,
          step: 0.01,
          default: 1.5,
          throttle: 100
        },
        wetOutputMax: {
          type: 'slider',
          label: 'Output Max (Clamp)',
          min: 0.0,
          max: 3.0,
          step: 0.01,
          default: 1.0,
          throttle: 100
        },
        wetOutputGamma: {
          type: 'slider',
          label: 'Output Gamma',
          min: 0.1,
          max: 3.0,
          step: 0.01,
          default: 1.0,
          throttle: 100
        },

        // Frost / Ice Glaze
        frostGlazeEnabled: {
          type: 'boolean',
          label: 'Enable Frost Glaze',
          default: true
        },
        frostThreshold: {
          type: 'slider',
          label: 'Freeze Threshold',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.55,
          throttle: 100
        },
        frostIntensity: {
          type: 'slider',
          label: 'Frost Intensity',
          min: 0,
          max: 3,
          step: 0.01,
          default: 1.2,
          throttle: 100
        },
        frostTintStrength: {
          type: 'slider',
          label: 'Blue Tint Strength',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.4,
          throttle: 100
        },

        // Dynamic Light Color Tinting
        dynamicLightTintEnabled: {
          type: 'boolean',
          label: 'Enable Light Tinting',
          default: true
        },
        dynamicLightTintStrength: {
          type: 'slider',
          label: 'Tint Strength',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.6,
          throttle: 100
        },

        // Wind-Driven Stripe Animation
        windDrivenStripesEnabled: {
          type: 'boolean',
          label: 'Enable Wind Stripes',
          default: true
        },
        windStripeInfluence: {
          type: 'slider',
          label: 'Wind Influence',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.5,
          throttle: 100
        },

        // Building Shadow Suppression
        buildingShadowSuppressionEnabled: {
          type: 'boolean',
          label: 'Enable Shadow Suppression',
          default: true
        },
        buildingShadowSuppressionStrength: {
          type: 'slider',
          label: 'Suppression Strength',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.8,
          throttle: 100
        }
      }
    };
  }

  /**
   * Initialize effect with scene references
   * @param {THREE.Renderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  initialize(renderer, scene, camera) {
    log.info('Initializing specular effect');

    this._scene = scene || null;
    
    // Bound handlers for cleanup
    this.onLightCreatedBound = this.onLightCreated.bind(this);
    this.onLightUpdatedBound = this.onLightUpdated.bind(this);
    this.onLightDeletedBound = this.onLightDeleted.bind(this);
    
    // Listen for light updates
    Hooks.on('createAmbientLight', this.onLightCreatedBound);
    Hooks.on('updateAmbientLight', this.onLightUpdatedBound);
    Hooks.on('deleteAmbientLight', this.onLightDeletedBound);

    // Initial sync
    this.syncAllLights();
    
    // Material will be created when mesh is provided
    // (see setBaseMesh method)
  }

  /**
   * Set the base mesh to apply specular effect to
   * @param {THREE.Mesh} baseMesh - Base plane mesh
   * @param {MapAssetBundle} assetBundle - Asset bundle with masks
   */
  setBaseMesh(baseMesh, assetBundle) {
    this.mesh = baseMesh;
    
    // Extract masks from bundle
    const specularMaskData = assetBundle.masks.find(m => m.id === 'specular');
    const roughnessMaskData = assetBundle.masks.find(m => m.id === 'roughness');
    const normalMapData = assetBundle.masks.find(m => m.id === 'normal');
    
    this.specularMask = specularMaskData?.texture || null;
    this.roughnessMask = roughnessMaskData?.texture || null;
    this.normalMap = normalMapData?.texture || null;
    
    // Update status params
    this.params.hasSpecularMask = !!this.specularMask;
    
    if (this.specularMask) {
      this.params.textureStatus = 'Ready (Texture Found)';
    } else {
      this.params.textureStatus = 'Inactive (No Texture Found)';
    }

    if (!this.specularMask) {
      // No scene-wide _Specular mask. Traditional specular stripes won't show,
      // but we still need the PBR material for weather-driven effects
      // (wet surface from rain, future snow albedo colouration) which derive
      // shine from the albedo itself, not the specular mask.
      log.warn('No scene-wide _Specular mask found for base mesh; stripes inactive but wet/weather effects will still apply');
    } else {
      log.info('Specular mask loaded, creating PBR material');
    }

    const baseMap = baseMesh?.material?.map || this._getFallbackAlbedoTexture();
    this.createPBRMaterial(baseMap);
    
    // Replace base mesh material
    baseMesh.material.dispose();
    baseMesh.material = this.material;
  }

  /**
   * Bind a per-tile specular overlay to an existing tile sprite.
   * This keeps tiles as sprites (fast), and renders specular as an additive mesh.
   *
   * If specularMask is null, we still bind a depth-only overlay so the tile is
   * treated as a black specular mask and occludes lower specular layers.
   * @param {TileDocument} tileDoc
   * @param {THREE.Object3D} sprite
   * @param {THREE.Texture|null} specularMask
   * @param {{emitSpecular?: boolean}} [options]
   */
  bindTileSprite(tileDoc, sprite, specularMask, options = {}) {
    const THREE = window.THREE;
    if (!THREE) return;

    const tileId = tileDoc?.id;
    if (!tileId || !sprite) return;

    // emitSpecular=false keeps the tile as an occluder only.
    const emitSpecular = options?.emitSpecular !== false;
    const hasSpecularMask = emitSpecular && !!specularMask;
    const resolvedSpecularMask = hasSpecularMask ? specularMask : this._getFallbackBlackTexture();

    // Ensure we have a scene to attach into.
    if (!this._scene) return;

    // Rebuild cleanly whenever the tile rebinds (texture/flags/sprite updates).
    // This keeps dual-pass overlay state deterministic.
    if (this._tileOverlays.has(tileId)) {
      this.unbindTileSprite(tileId);
    }

    const baseMap = sprite?.material?.map || this._getFallbackAlbedoTexture();

    // Pass A: depth-only occluder. This writes depth using the tile silhouette
    // so lower tile specular cannot leak through opaque upper tiles.
    const occluderMaterial = this._createMaterialInstance({
      baseTexture: baseMap,
      specularMask: resolvedSpecularMask,
      roughnessMask: null,
      normalMap: null,
      outputMode: 1.0,
      transparent: true,
      blending: THREE.NoBlending,
      depthWrite: true,
      depthTest: true
    });
    occluderMaterial.colorWrite = false;
    occluderMaterial.blending = THREE.NoBlending;
    if (typeof THREE.LessEqualDepth !== 'undefined') {
      occluderMaterial.depthFunc = THREE.LessEqualDepth;
    }
    this._setTileOverlayAlphaClip(occluderMaterial, 0.1);
    occluderMaterial.needsUpdate = true;

    const occluderMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), occluderMaterial);
    occluderMesh.matrixAutoUpdate = false;
    occluderMesh.frustumCulled = false;

    let colorMaterial = null;
    let colorMesh = null;
    if (hasSpecularMask) {
      // Pass B: additive color, depth-tested against the occluder prepass.
      colorMaterial = this._createMaterialInstance({
        baseTexture: baseMap,
        specularMask: resolvedSpecularMask,
        roughnessMask: null,
        normalMap: null,
        outputMode: 1.0,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true
      });
      colorMaterial.colorWrite = true;
      colorMaterial.blending = THREE.AdditiveBlending;
      colorMaterial.depthWrite = false;
      if (typeof THREE.EqualDepth !== 'undefined') {
        colorMaterial.depthFunc = THREE.EqualDepth;
      }
      this._setTileOverlayAlphaClip(colorMaterial, 0.1);
      colorMaterial.needsUpdate = true;

      colorMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), colorMaterial);
      colorMesh.matrixAutoUpdate = false;
      colorMesh.frustumCulled = false;
    }

    const baseOrder = (typeof sprite.renderOrder === 'number') ? sprite.renderOrder : 0;
    const sortKey = Number(
      sprite?.userData?._msSortKey
      ?? sprite?.userData?.tileDoc?.sort
      ?? sprite?.userData?.tileDoc?.z
      ?? 0
    );
    const sortOrderOffset = Number.isFinite(sortKey) ? (-sortKey * 0.00001) : 0.0;

    // Keep all occluders before all additive color passes.
    try {
      const orderNudge = baseOrder * 0.1;
      occluderMesh.renderOrder = TILE_SPEC_OCCLUDER_ORDER_BASE + orderNudge + sortOrderOffset;
      if (colorMesh) colorMesh.renderOrder = TILE_SPEC_COLOR_ORDER_BASE + orderNudge + sortOrderOffset;
    } catch (_) {
    }

    this._syncTileOverlayLayers({ occluderMesh, colorMesh }, sprite);

    this._scene.add(occluderMesh);
    if (colorMesh) this._scene.add(colorMesh);
    this._tileOverlays.set(tileId, {
      sprite,
      occluderMesh,
      occluderMaterial,
      colorMesh,
      colorMaterial
    });

    this._syncTileOverlayTransform(tileId, sprite);
  }

  /**
   * Set alpha clip threshold for tile overlay materials.
   * Uses the same threshold as tile sprites (alphaTest ~= 0.1) so overlay
   * coverage matches visible tile silhouettes.
   * @param {THREE.ShaderMaterial} mat
   * @param {number} threshold
   * @private
   */
  _setTileOverlayAlphaClip(mat, threshold = 0.1) {
    if (!mat) return;

    const t = Number(threshold);
    const value = Number.isFinite(t) ? t : 0.1;
    if (mat.uniforms?.uTileAlphaClip) {
      mat.uniforms.uTileAlphaClip.value = value;
    }
    mat.needsUpdate = true;
  }

  /**
   * Sync overlay layers from source sprite.
   * - Color mesh follows sprite layers exactly.
   * - Occluder mesh excludes overlay-only layer so it still renders in main
   *   scene pass and blocks lower specular even for bypassEffects tiles.
   * @param {{occluderMesh?: THREE.Mesh|null, colorMesh?: THREE.Mesh|null}} meshes
   * @param {THREE.Object3D} sprite
   * @private
   */
  _syncTileOverlayLayers(meshes, sprite) {
    const occluderMesh = meshes?.occluderMesh || null;
    const colorMesh = meshes?.colorMesh || null;
    if (!sprite) return;

    try {
      const spriteMaskU = (Number(sprite?.layers?.mask ?? 1) >>> 0);
      const overlayBit = ((1 << OVERLAY_THREE_LAYER) >>> 0);
      let occluderMaskU = spriteMaskU & (~overlayBit >>> 0);
      if (occluderMaskU === 0) occluderMaskU = 1; // Ensure layer 0 fallback.

      if (occluderMesh?.layers) occluderMesh.layers.mask = occluderMaskU;
      if (colorMesh?.layers) colorMesh.layers.mask = sprite.layers.mask;
    } catch (_) {
    }
  }

  /**
   * Remove a bound tile overlay.
   * @param {string} tileId
   */
  unbindTileSprite(tileId) {
    const entry = tileId ? this._tileOverlays.get(tileId) : null;
    if (!entry) return;

    const meshes = [entry.occluderMesh, entry.colorMesh].filter(Boolean);
    const materials = [entry.occluderMaterial, entry.colorMaterial].filter(Boolean);

    try {
      for (const mesh of meshes) this._scene?.remove?.(mesh);
    } catch (_) {
    }
    try {
      for (const mesh of meshes) {
        mesh?.geometry?.dispose?.();
      }
      for (const material of materials) {
        material?.dispose?.();
      }
    } catch (_) {
    }
    for (const material of materials) {
      this._materials.delete(material);
    }
    this._tileOverlays.delete(tileId);
  }

  /**
   * Called by TileManager when a sprite's transform changes.
   * @param {string} tileId
   * @param {THREE.Object3D} sprite
   */
  syncTileSpriteTransform(tileId, sprite) {
    if (!tileId || !sprite) return;
    this._syncTileOverlayTransform(tileId, sprite);
  }

  _syncTileOverlayTransform(tileId, sprite) {
    const entry = this._tileOverlays.get(tileId);
    if (!entry || !sprite) return;
    const THREE = window.THREE;

    const meshes = [entry.occluderMesh, entry.colorMesh].filter(Boolean);
    if (meshes.length === 0) return;

    try {
      // Ensure world matrix is current.
      sprite.updateMatrixWorld?.(true);
    } catch (_) {
    }
    try {
      if (THREE) {
        if (!this._tileOverlayPos) this._tileOverlayPos = new THREE.Vector3();
        if (!this._tileOverlayQuat) this._tileOverlayQuat = new THREE.Quaternion();
        if (!this._tileOverlayScale) this._tileOverlayScale = new THREE.Vector3(1, 1, 1);
        if (!this._tileOverlayRotQuat) this._tileOverlayRotQuat = new THREE.Quaternion();

        // Decompose and re-compose as T*R*S so additional sprite material rotation
        // is applied in the correct order. (T*S*R causes skew/drift on scaled/flipped tiles.)
        sprite.matrixWorld.decompose(this._tileOverlayPos, this._tileOverlayQuat, this._tileOverlayScale);
        const spriteRot = Number(sprite?.material?.rotation) || 0;
        if (Math.abs(spriteRot) > 0.000001) {
          this._tileOverlayRotQuat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), spriteRot);
          this._tileOverlayQuat.multiply(this._tileOverlayRotQuat);
        }
        for (const mesh of meshes) {
          mesh.matrix.compose(this._tileOverlayPos, this._tileOverlayQuat, this._tileOverlayScale);
        }
      } else {
        for (const mesh of meshes) {
          mesh.matrix.copy(sprite.matrixWorld);
        }
      }
      for (const mesh of meshes) {
        mesh.matrixWorldNeedsUpdate = true;
      }

      // Keep overlay visibility in sync with the underlying tile sprite.
      // IMPORTANT: Tile hover-hide fades via sprite.material.opacity without toggling sprite.visible.
      // If we only mirror sprite.visible here, the specular overlay can remain visible
      // while the tile has faded out, which looks like a "second copy" that won't disappear.
      const sortKey = Number(
        sprite?.userData?._msSortKey
        ?? sprite?.userData?.tileDoc?.sort
        ?? sprite?.userData?.tileDoc?.z
        ?? 0
      );

      // Lift overlays slightly above their owning tile sprite so they can render
      // in specular-only mode, and add a tiny sort-based lift so higher-sort tiles
      // are reliably in front for depth occlusion (prevents lower-tile specular
      // bleeding through top opaque tiles when depth values quantize closely).
      try {
        const baseLift = 0.02;
        const sortLift = Number.isFinite(sortKey)
          ? Math.max(-0.015, Math.min(0.50, sortKey * 0.002))
          : 0.0;
        for (const mesh of meshes) {
          mesh.matrix.elements[14] += (baseLift + sortLift);
        }
      } catch (_) {
      }

      let spriteOpacity = 1.0;
      try {
        const o = sprite?.material?.opacity;
        if (typeof o === 'number' && Number.isFinite(o)) spriteOpacity = o;
      } catch (_) {
      }
      const shouldShow = !!sprite.visible && spriteOpacity > 0.01;
      for (const mesh of meshes) {
        mesh.visible = shouldShow;
      }

      // Mirror tile depth-write policy (e.g. overhead fade-hidden roofs disable
      // depth writes). This keeps specular overlays from re-introducing depth
      // occlusion when the owning tile intentionally does not write depth.
      try {
        const desiredDepthWrite = !!sprite?.material?.depthWrite;
        if (entry.occluderMaterial && entry.occluderMaterial.depthWrite !== desiredDepthWrite) {
          entry.occluderMaterial.depthWrite = desiredDepthWrite;
          entry.occluderMaterial.needsUpdate = true;
        }
      } catch (_) {
      }

      // Color pass should never write depth; it is gated by the occluder pass.
      try {
        if (entry.colorMaterial && entry.colorMaterial.depthWrite !== false) {
          entry.colorMaterial.depthWrite = false;
          entry.colorMaterial.needsUpdate = true;
        }
      } catch (_) {
      }

      // Keep layering/sorting in sync. Tile renderOrder and layers can change
      // after initial bind during scene sync, elevation transitions, etc.
      try {
        const baseOrder = (typeof sprite.renderOrder === 'number') ? sprite.renderOrder : 0;
        // Higher Foundry sort should occlude lower specular first, so we render
        // higher sort overlays slightly earlier in this dedicated overlay band.
        // Keep this as a tiny continuous offset so large sort values don't collapse
        // into the same renderOrder bucket (which can re-introduce lower-tile bleed-through).
        const sortOrderOffset = Number.isFinite(sortKey) ? (-sortKey * 0.00001) : 0.0;
        const orderNudge = baseOrder * 0.1;
        if (entry.occluderMesh) {
          entry.occluderMesh.renderOrder = TILE_SPEC_OCCLUDER_ORDER_BASE + orderNudge + sortOrderOffset;
        }
        if (entry.colorMesh) {
          entry.colorMesh.renderOrder = TILE_SPEC_COLOR_ORDER_BASE + orderNudge + sortOrderOffset;
        }
      } catch (_) {
      }
      try {
        this._syncTileOverlayLayers(entry, sprite);
      } catch (_) {
      }
    } catch (_) {
    }
  }

  /**
   * Create PBR shader material
   * @param {THREE.Texture} baseTexture - Albedo/diffuse texture
   * @private
   */
  createPBRMaterial(baseTexture) {
    const THREE = window.THREE;

    const safeBase = baseTexture || this._getFallbackAlbedoTexture();
    
    // Create shader material with custom GLSL
    // Track validation errors
    this.validationErrors = [];
    this.lastValidation = 0;
    
    this.material = this._createMaterialInstance({
      baseTexture: safeBase,
      specularMask: this.specularMask,
      roughnessMask: this.roughnessMask,
      normalMap: this.normalMap,
      outputMode: 0.0,
      transparent: false
    });
    
    log.debug('PBR material created');
    
    // Initial sync of light data to the new material
    this.updateLightUniforms();
  }

  _createMaterialInstance({
    baseTexture,
    specularMask,
    roughnessMask,
    normalMap,
    outputMode = 0.0,
    transparent = false,
    blending = null,
    depthWrite = true,
    depthTest = true
  } = {}) {
    const THREE = window.THREE;
    const safeBase = baseTexture || this._getFallbackAlbedoTexture();

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        // Textures
        uAlbedoMap: { value: safeBase },
        uSpecularMap: { value: specularMask || this.specularMask || this._getFallbackBlackTexture() },
        uRoughnessMap: { value: roughnessMask || safeBase },
        uNormalMap: { value: normalMap || safeBase },

        // Texture availability flags
        uHasRoughnessMap: { value: roughnessMask !== null && roughnessMask !== undefined },
        uHasNormalMap: { value: normalMap !== null && normalMap !== undefined },

        // Effect enabled state (for pass-through)
        uEffectEnabled: { value: this._enabled },

        // Output mode
        // 0 = full (albedo + specular)
        // 1 = specular only (for additive overlays like tiles)
        uOutputMode: { value: outputMode },
        // Alpha clip threshold used by tile overlays. Base scene material keeps
        // a near-zero clip; tile overlays override to match sprite alphaTest.
        uTileAlphaClip: { value: 0.001 },

        // Effect parameters
        uSpecularIntensity: { value: this.params.intensity },
        uRoughness: { value: this.params.roughness },
        uMetallic: { value: this.params.metallic },

        // Lighting
        uLightDirection: { value: new THREE.Vector3(
          this.params.lightDirection.x,
          this.params.lightDirection.y,
          this.params.lightDirection.z
        ).normalize() },
        uLightColor: { value: new THREE.Vector3(
          this.params.lightColor.r,
          this.params.lightColor.g,
          this.params.lightColor.b
        ) },

        // Camera
        uCameraPosition: { value: new THREE.Vector3() },
        uCameraOffset: { value: new THREE.Vector2(0, 0) },

        // Time (for animation)
        uTime: { value: 0.0 },

        // Multi-layer stripe system
        uStripeEnabled: { value: this.params.stripeEnabled },
        uStripeBlendMode: { value: this.params.stripeBlendMode },
        uParallaxStrength: { value: this.params.parallaxStrength },
        uStripeMaskThreshold: { value: this.params.stripeMaskThreshold },
        uWorldPatternScale: { value: this.params.worldPatternScale },

        // Layer 1
        uStripe1Enabled: { value: this.params.stripe1Enabled },
        uStripe1Frequency: { value: this.params.stripe1Frequency },
        uStripe1Speed: { value: this.params.stripe1Speed },
        uStripe1Angle: { value: this.params.stripe1Angle },
        uStripe1Width: { value: this.params.stripe1Width },
        uStripe1Intensity: { value: this.params.stripe1Intensity },
        uStripe1Parallax: { value: this.params.stripe1Parallax },
        uStripe1Wave: { value: this.params.stripe1Wave },
        uStripe1Gaps: { value: this.params.stripe1Gaps },
        uStripe1Softness: { value: this.params.stripe1Softness },

        // Layer 2
        uStripe2Enabled: { value: this.params.stripe2Enabled },
        uStripe2Frequency: { value: this.params.stripe2Frequency },
        uStripe2Speed: { value: this.params.stripe2Speed },
        uStripe2Angle: { value: this.params.stripe2Angle },
        uStripe2Width: { value: this.params.stripe2Width },
        uStripe2Intensity: { value: this.params.stripe2Intensity },
        uStripe2Parallax: { value: this.params.stripe2Parallax },
        uStripe2Wave: { value: this.params.stripe2Wave },
        uStripe2Gaps: { value: this.params.stripe2Gaps },
        uStripe2Softness: { value: this.params.stripe2Softness },

        // Layer 3
        uStripe3Enabled: { value: this.params.stripe3Enabled },
        uStripe3Frequency: { value: this.params.stripe3Frequency },
        uStripe3Speed: { value: this.params.stripe3Speed },
        uStripe3Angle: { value: this.params.stripe3Angle },
        uStripe3Width: { value: this.params.stripe3Width },
        uStripe3Intensity: { value: this.params.stripe3Intensity },
        uStripe3Parallax: { value: this.params.stripe3Parallax },
        uStripe3Wave: { value: this.params.stripe3Wave },
        uStripe3Gaps: { value: this.params.stripe3Gaps },
        uStripe3Softness: { value: this.params.stripe3Softness },

        // Micro Sparkle
        uSparkleEnabled: { value: this.params.sparkleEnabled },
        uSparkleIntensity: { value: this.params.sparkleIntensity },
        uSparkleScale: { value: this.params.sparkleScale },
        uSparkleSpeed: { value: this.params.sparkleSpeed },

        // Outdoor cloud specular
        uOutdoorCloudSpecularEnabled: { value: this.params.outdoorCloudSpecularEnabled },
        uOutdoorStripeBlend: { value: this.params.outdoorStripeBlend },
        uCloudSpecularIntensity: { value: this.params.cloudSpecularIntensity },

        // Wet Surface (Rain)
        uWetSpecularEnabled: { value: this.params.wetSpecularEnabled },
        uRainWetness: { value: 0.0 }, // Driven by WeatherController: 0=dry, 1=fully wet
        // Input CC
        uWetInputBrightness: { value: this.params.wetInputBrightness },
        uWetInputGamma: { value: this.params.wetInputGamma },
        uWetSpecularContrast: { value: this.params.wetSpecularContrast },
        uWetBlackPoint: { value: this.params.wetBlackPoint },
        uWetWhitePoint: { value: this.params.wetWhitePoint },
        // Output CC
        uWetSpecularIntensity: { value: this.params.wetSpecularIntensity },
        uWetOutputMax: { value: this.params.wetOutputMax },
        uWetOutputGamma: { value: this.params.wetOutputGamma },

        uRoofMap: { value: null },
        uRoofMaskEnabled: { value: 0.0 },
        uSceneBounds: { value: new THREE.Vector4(0, 0, 1, 1) },

        uHasCloudShadowMap: { value: false },
        uCloudShadowMap: { value: null },
        uScreenSize: { value: new THREE.Vector2(1, 1) },

        uDarknessLevel: { value: 0.0 },
        uAmbientDaylight: { value: new THREE.Color(1.0, 1.0, 1.0) },
        uAmbientDarkness: { value: new THREE.Color(0.14, 0.14, 0.28) },
        uAmbientBrightest: { value: new THREE.Color(1.0, 1.0, 1.0) },

        // Dynamic Lights
        numLights: { value: 0 },
        lightPosition: { value: new Float32Array(this.maxLights * 3) },
        lightColor: { value: new Float32Array(this.maxLights * 3) },
        lightConfig: { value: new Float32Array(this.maxLights * 4) },

        // Frost / Ice Glaze
        uFrostGlazeEnabled: { value: this.params.frostGlazeEnabled },
        uFrostLevel: { value: 0.0 },
        uFrostIntensity: { value: this.params.frostIntensity },
        uFrostTintStrength: { value: this.params.frostTintStrength },

        // Dynamic Light Color Tinting
        uDynamicLightTintEnabled: { value: this.params.dynamicLightTintEnabled },
        uDynamicLightTintStrength: { value: this.params.dynamicLightTintStrength },

        // Wind-Driven Stripe Animation
        uWindDrivenStripesEnabled: { value: this.params.windDrivenStripesEnabled },
        uWindStripeInfluence: { value: this.params.windStripeInfluence },
        uWindAccum: { value: new THREE.Vector2(0.0, 0.0) },

        // Building Shadow Suppression
        uBuildingShadowSuppressionEnabled: { value: this.params.buildingShadowSuppressionEnabled },
        uBuildingShadowSuppressionStrength: { value: this.params.buildingShadowSuppressionStrength },
        uHasBuildingShadowMap: { value: false },
        uBuildingShadowMap: { value: null }
      },
      vertexShader: this.getVertexShader(),
      fragmentShader: this.getFragmentShader(),
      side: THREE.DoubleSide,
      transparent: !!transparent,
      depthWrite: !!depthWrite,
      depthTest: !!depthTest
    });

    if (blending) {
      mat.blending = blending;
    }

    this._materials.add(mat);
    return mat;
  }

  _getFallbackAlbedoTexture() {
    const THREE = window.THREE;
    if (!THREE) return null;
    if (this._fallbackAlbedo) return this._fallbackAlbedo;

    const data = new Uint8Array([255, 255, 255, 255]);
    const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    tex.needsUpdate = true;
    if (THREE.SRGBColorSpace) {
      tex.colorSpace = THREE.SRGBColorSpace;
    }
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    this._fallbackAlbedo = tex;
    return tex;
  }

  /**
   * Returns a cached 1x1 black texture used as fallback when no _Specular mask exists.
   * This ensures the shader receives a valid sampler (returning 0,0,0) so traditional
   * specular stripes produce nothing, while weather-driven effects (wet surface) that
   * derive shine from the albedo still work.
   * @returns {THREE.DataTexture}
   * @private
   */
  _getFallbackBlackTexture() {
    const THREE = window.THREE;
    if (!THREE) return null;
    if (this._fallbackBlack) return this._fallbackBlack;

    const data = new Uint8Array([0, 0, 0, 255]);
    const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    tex.needsUpdate = true;
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    this._fallbackBlack = tex;
    return tex;
  }

  /* -------------------------------------------- */
  /*  Light Management                            */
  /* -------------------------------------------- */

  syncAllLights() {
    if (!canvas.lighting) return;
    
    this.lights.clear();
    
    // Get all ambient lights
    const lights = canvas.lighting.placeables;
    lights.forEach(light => {
      this.addLight(light.document);
    });
    
    this.updateLightUniforms();
  }

  addLight(doc) {
    if (this.lights.size >= this.maxLights) return;
    if (this.lights.has(doc.id)) return;
    
    const config = doc.config;
    if (!config) return;
    
    // Extract color
    let r = 1, g = 1, b = 1;
    const colorInput = config.color;
    
    if (colorInput) {
        try {
            if (typeof colorInput === 'object' && colorInput.rgb) {
                r = colorInput.rgb[0];
                g = colorInput.rgb[1];
                b = colorInput.rgb[2];
            } else {
                const c = (typeof foundry !== 'undefined' && foundry.utils?.Color) 
                    ? foundry.utils.Color.from(colorInput)
                    : new THREE.Color(colorInput);
                r = c.r;
                g = c.g;
                b = c.b;
            }
        } catch (e) {
            if (typeof colorInput === 'number') {
                r = ((colorInput >> 16) & 0xff) / 255;
                g = ((colorInput >> 8) & 0xff) / 255;
                b = (colorInput & 0xff) / 255;
            }
        }
    }
    
    const luminosity = config.luminosity ?? 0.5;
    const intensity = luminosity * 2.0; 
    
    const dim = config.dim || 0;
    const bright = config.bright || 0;
    const radius = Math.max(dim, bright);
    
    if (radius === 0) return;
    
    const worldPos = Coordinates.toWorld(doc.x, doc.y);
    
    this.lights.set(doc.id, {
      position: worldPos,
      color: { r: r * intensity, g: g * intensity, b: b * intensity },
      radius: radius,
      dim: dim,
      bright: bright,
      attenuation: config.attenuation ?? 0.5
    });
  }

  removeLight(id) {
    if (this.lights.delete(id)) {
      this.updateLightUniforms();
    }
  }

  _mergeLightDocChanges(doc, changes) {
    if (!doc || !changes || typeof changes !== 'object') return doc;

    let base;
    try {
      base = (typeof doc.toObject === 'function') ? doc.toObject() : doc;
    } catch (_) {
      base = doc;
    }

    let expandedChanges = changes;
    try {
      const hasDotKeys = Object.keys(changes).some((k) => k.includes('.'));
      if (hasDotKeys && foundry?.utils?.expandObject) {
        expandedChanges = foundry.utils.expandObject(changes);
      }
    } catch (_) {
      expandedChanges = changes;
    }

    try {
      if (foundry?.utils?.mergeObject) {
        return foundry.utils.mergeObject(base, expandedChanges, {
          inplace: false,
          overwrite: true,
          recursive: true,
          insertKeys: true,
          insertValues: true
        });
      }
    } catch (_) {
    }

    const merged = { ...base, ...expandedChanges };
    if (base?.config || expandedChanges?.config) {
      merged.config = { ...(base?.config ?? {}), ...(expandedChanges?.config ?? {}) };
    }
    return merged;
  }

  onLightCreated(doc) {
    this.addLight(doc);
    this.updateLightUniforms();
  }

  onLightUpdated(doc, changes) {
    const targetDoc = this._mergeLightDocChanges(doc, changes);
    this.removeLight(targetDoc.id);
    this.addLight(targetDoc);
    this.updateLightUniforms();
  }

  onLightDeleted(doc) {
    this.removeLight(doc.id);
  }

  updateLightUniforms() {
    // Apply light state to every material instance (base plane + any tile overlays).
    // The base mesh may not have a scene-wide _Specular mask, but tile overlays can still exist.
    if (!this._materials || this._materials.size === 0) return;
    
    const lightsArray = Array.from(this.lights.values());
    const num = lightsArray.length;
    
    for (const mat of this._materials) {
      const uniforms = mat?.uniforms;
      if (!uniforms?.numLights || !uniforms?.lightPosition || !uniforms?.lightColor || !uniforms?.lightConfig) continue;

      uniforms.numLights.value = num;

      const lightPos = uniforms.lightPosition.value;
      const lightCol = uniforms.lightColor.value;
      const lightCfg = uniforms.lightConfig.value;

    // Pixels per distance unit.
    // Foundry stores light radii in distance units, but pixel size can differ for hex grids.
    // Prefer grid.sizeX/sizeY when available.
    const d = canvas?.dimensions;
    const grid = canvas?.grid;
    const gridSizeX = (grid && typeof grid.sizeX === 'number' && grid.sizeX > 0) ? grid.sizeX : null;
    const gridSizeY = (grid && typeof grid.sizeY === 'number' && grid.sizeY > 0) ? grid.sizeY : null;
    const pxPerGrid = (gridSizeX && gridSizeY)
      ? (0.5 * (gridSizeX + gridSizeY))
      : (d?.size ?? 100);
    const distPerGrid = (d && typeof d.distance === 'number' && d.distance > 0) ? d.distance : 1;
    const pixelsPerUnit = pxPerGrid / distPerGrid;

      for (let i = 0; i < num; i++) {
        const l = lightsArray[i];
        const i3 = i * 3;
        const i4 = i * 4;

        lightPos[i3] = l.position.x;
        lightPos[i3 + 1] = l.position.y;
        lightPos[i3 + 2] = 0;

        lightCol[i3] = l.color.r;
        lightCol[i3 + 1] = l.color.g;
        lightCol[i3 + 2] = l.color.b;

        const radiusPx = l.radius * pixelsPerUnit;
        const brightPx = l.bright * pixelsPerUnit;

        lightCfg[i4] = radiusPx;
        lightCfg[i4 + 1] = brightPx;
        lightCfg[i4 + 2] = l.attenuation;
        lightCfg[i4 + 3] = 0;
      }
    }
  }

  /**
   * Update effect state (called every frame before render)
   * @param {TimeInfo} timeInfo - Centralized time information
   */
  update(timeInfo) {
    // The base mesh material may not exist if the scene has no scene-wide _Specular mask,
    // but per-tile overlay materials can still exist and must keep animating.
    if (!this._materials || this._materials.size === 0) return;
    
    // Validate shader uniforms periodically (every 60 frames)
    if (timeInfo.frameCount % 60 === 0) {
      this.validateShaderState(timeInfo);
    }
    
    // Read surface wetness from WeatherController's wetness tracker.
    // The tracker already handles transition holdoff (doesn't change during weather
    // transitions), proportional wetting (heavier rain wets faster), and slow
    // drying (minutes to fully dry after rain stops).
    let rainWetness = 0.0;
    try {
      const weather = weatherController?.getCurrentState?.();
      if (weather) {
        rainWetness = Math.max(0.0, Math.min(1.0, weather.wetness ?? 0.0));
      }
    } catch (_) {
      // WeatherController may not be initialised yet; stay dry.
    }

    // Compute frost level from weather state (once per frame, shared by all materials).
    // Frost ramps from 0→1 as freezeLevel goes from frostThreshold→1.0.
    let frostLevel = 0.0;
    try {
      const weather = weatherController?.getCurrentState?.();
      if (weather) {
        // Frost
        if (this.params.frostGlazeEnabled) {
          const ft = this.params.frostThreshold;
          const fl = weather.freezeLevel ?? 0.0;
          frostLevel = Math.min(1.0, Math.max(0.0,
            (fl - ft) / Math.max(0.001, 1.0 - ft)
          ));
        }
        // Wind — accumulate displacement monotonically so stripes always
        // drift forward (faster during gusts, slower during lulls, never backward).
        if (this.params.windDrivenStripesEnabled) {
          const ws = weather.windSpeed ?? 0.0;
          const wd = weather.windDirection;
          const dx = (wd && typeof wd.x === 'number') ? wd.x : 1.0;
          const dy = (wd && typeof wd.y === 'number') ? wd.y : 0.0;
          const dt = timeInfo.delta; // seconds since last frame
          if (!this._windAccumX) this._windAccumX = 0.0;
          if (!this._windAccumY) this._windAccumY = 0.0;
          this._windAccumX += dx * ws * dt * 0.01;
          this._windAccumY += dy * ws * dt * 0.01;
        }
      }
    } catch (_) {
      // WeatherController may not be initialised yet; stay calm.
    }

    for (const mat of this._materials) {
      if (!mat?.uniforms) continue;

      // Update time uniform for animation
      if (mat.uniforms.uTime) mat.uniforms.uTime.value = timeInfo.elapsed;

      // Rain wetness (computed above from weather state)
      if (mat.uniforms.uRainWetness) mat.uniforms.uRainWetness.value = rainWetness;

      // Update uniforms from parameters
      if (mat.uniforms.uSpecularIntensity) mat.uniforms.uSpecularIntensity.value = this.params.intensity;
      if (mat.uniforms.uRoughness) mat.uniforms.uRoughness.value = this.params.roughness;

      // Update light direction
      if (mat.uniforms.uLightDirection?.value?.set) {
        mat.uniforms.uLightDirection.value.set(
          this.params.lightDirection.x,
          this.params.lightDirection.y,
          this.params.lightDirection.z
        ).normalize();
      }

      // Update light color
      if (mat.uniforms.uLightColor?.value?.set) {
        mat.uniforms.uLightColor.value.set(
          this.params.lightColor.r,
          this.params.lightColor.g,
          this.params.lightColor.b
        );
      }

      // Update stripe parameters
      if (mat.uniforms.uStripeEnabled) mat.uniforms.uStripeEnabled.value = this.params.stripeEnabled;
      if (mat.uniforms.uStripeBlendMode) mat.uniforms.uStripeBlendMode.value = this.params.stripeBlendMode;
      if (mat.uniforms.uParallaxStrength) mat.uniforms.uParallaxStrength.value = this.params.parallaxStrength;
      if (mat.uniforms.uStripeMaskThreshold) mat.uniforms.uStripeMaskThreshold.value = this.params.stripeMaskThreshold;
      if (mat.uniforms.uWorldPatternScale) mat.uniforms.uWorldPatternScale.value = this.params.worldPatternScale;

      // Update sparkle parameters
      if (mat.uniforms.uSparkleEnabled) mat.uniforms.uSparkleEnabled.value = this.params.sparkleEnabled;
      if (mat.uniforms.uSparkleIntensity) mat.uniforms.uSparkleIntensity.value = this.params.sparkleIntensity;
      if (mat.uniforms.uSparkleScale) mat.uniforms.uSparkleScale.value = this.params.sparkleScale;
      if (mat.uniforms.uSparkleSpeed) mat.uniforms.uSparkleSpeed.value = this.params.sparkleSpeed;

      // Outdoor cloud specular
      if (mat.uniforms.uOutdoorCloudSpecularEnabled) {
        mat.uniforms.uOutdoorCloudSpecularEnabled.value = this.params.outdoorCloudSpecularEnabled;
      }
      if (mat.uniforms.uOutdoorStripeBlend) mat.uniforms.uOutdoorStripeBlend.value = this.params.outdoorStripeBlend;
      if (mat.uniforms.uCloudSpecularIntensity) mat.uniforms.uCloudSpecularIntensity.value = this.params.cloudSpecularIntensity;

      // Wet Surface (Rain)
      if (mat.uniforms.uWetSpecularEnabled) mat.uniforms.uWetSpecularEnabled.value = this.params.wetSpecularEnabled;
      // Input CC
      if (mat.uniforms.uWetInputBrightness) mat.uniforms.uWetInputBrightness.value = this.params.wetInputBrightness;
      if (mat.uniforms.uWetInputGamma) mat.uniforms.uWetInputGamma.value = this.params.wetInputGamma;
      if (mat.uniforms.uWetSpecularContrast) mat.uniforms.uWetSpecularContrast.value = this.params.wetSpecularContrast;
      if (mat.uniforms.uWetBlackPoint) mat.uniforms.uWetBlackPoint.value = this.params.wetBlackPoint;
      if (mat.uniforms.uWetWhitePoint) mat.uniforms.uWetWhitePoint.value = this.params.wetWhitePoint;
      // Output CC
      if (mat.uniforms.uWetSpecularIntensity) mat.uniforms.uWetSpecularIntensity.value = this.params.wetSpecularIntensity;
      if (mat.uniforms.uWetOutputMax) mat.uniforms.uWetOutputMax.value = this.params.wetOutputMax;
      if (mat.uniforms.uWetOutputGamma) mat.uniforms.uWetOutputGamma.value = this.params.wetOutputGamma;

      // Frost / Ice Glaze
      if (mat.uniforms.uFrostGlazeEnabled) mat.uniforms.uFrostGlazeEnabled.value = this.params.frostGlazeEnabled;
      if (mat.uniforms.uFrostLevel) mat.uniforms.uFrostLevel.value = frostLevel;
      if (mat.uniforms.uFrostIntensity) mat.uniforms.uFrostIntensity.value = this.params.frostIntensity;
      if (mat.uniforms.uFrostTintStrength) mat.uniforms.uFrostTintStrength.value = this.params.frostTintStrength;

      // Dynamic Light Color Tinting
      if (mat.uniforms.uDynamicLightTintEnabled) mat.uniforms.uDynamicLightTintEnabled.value = this.params.dynamicLightTintEnabled;
      if (mat.uniforms.uDynamicLightTintStrength) mat.uniforms.uDynamicLightTintStrength.value = this.params.dynamicLightTintStrength;

      // Wind-Driven Stripe Animation
      if (mat.uniforms.uWindDrivenStripesEnabled) mat.uniforms.uWindDrivenStripesEnabled.value = this.params.windDrivenStripesEnabled;
      if (mat.uniforms.uWindStripeInfluence) mat.uniforms.uWindStripeInfluence.value = this.params.windStripeInfluence;
      if (mat.uniforms.uWindAccum?.value?.set) {
        mat.uniforms.uWindAccum.value.set(this._windAccumX || 0.0, this._windAccumY || 0.0);
      }

      // Building Shadow Suppression (texture bound in render(), params here)
      if (mat.uniforms.uBuildingShadowSuppressionEnabled) mat.uniforms.uBuildingShadowSuppressionEnabled.value = this.params.buildingShadowSuppressionEnabled;
      if (mat.uniforms.uBuildingShadowSuppressionStrength) mat.uniforms.uBuildingShadowSuppressionStrength.value = this.params.buildingShadowSuppressionStrength;

      // Layer 1
      if (mat.uniforms.uStripe1Enabled) mat.uniforms.uStripe1Enabled.value = this.params.stripe1Enabled;
      if (mat.uniforms.uStripe1Frequency) mat.uniforms.uStripe1Frequency.value = this.params.stripe1Frequency;
      if (mat.uniforms.uStripe1Speed) mat.uniforms.uStripe1Speed.value = this.params.stripe1Speed;
      if (mat.uniforms.uStripe1Angle) mat.uniforms.uStripe1Angle.value = this.params.stripe1Angle;
      if (mat.uniforms.uStripe1Width) mat.uniforms.uStripe1Width.value = this.params.stripe1Width;
      if (mat.uniforms.uStripe1Intensity) mat.uniforms.uStripe1Intensity.value = this.params.stripe1Intensity;
      if (mat.uniforms.uStripe1Parallax) mat.uniforms.uStripe1Parallax.value = this.params.stripe1Parallax;
      if (mat.uniforms.uStripe1Wave) mat.uniforms.uStripe1Wave.value = this.params.stripe1Wave;
      if (mat.uniforms.uStripe1Gaps) mat.uniforms.uStripe1Gaps.value = this.params.stripe1Gaps;
      if (mat.uniforms.uStripe1Softness) mat.uniforms.uStripe1Softness.value = this.params.stripe1Softness;

      // Layer 2
      if (mat.uniforms.uStripe2Enabled) mat.uniforms.uStripe2Enabled.value = this.params.stripe2Enabled;
      if (mat.uniforms.uStripe2Frequency) mat.uniforms.uStripe2Frequency.value = this.params.stripe2Frequency;
      if (mat.uniforms.uStripe2Speed) mat.uniforms.uStripe2Speed.value = this.params.stripe2Speed;
      if (mat.uniforms.uStripe2Angle) mat.uniforms.uStripe2Angle.value = this.params.stripe2Angle;
      if (mat.uniforms.uStripe2Width) mat.uniforms.uStripe2Width.value = this.params.stripe2Width;
      if (mat.uniforms.uStripe2Intensity) mat.uniforms.uStripe2Intensity.value = this.params.stripe2Intensity;
      if (mat.uniforms.uStripe2Parallax) mat.uniforms.uStripe2Parallax.value = this.params.stripe2Parallax;
      if (mat.uniforms.uStripe2Wave) mat.uniforms.uStripe2Wave.value = this.params.stripe2Wave;
      if (mat.uniforms.uStripe2Gaps) mat.uniforms.uStripe2Gaps.value = this.params.stripe2Gaps;
      if (mat.uniforms.uStripe2Softness) mat.uniforms.uStripe2Softness.value = this.params.stripe2Softness;

      // Layer 3
      if (mat.uniforms.uStripe3Enabled) mat.uniforms.uStripe3Enabled.value = this.params.stripe3Enabled;
      if (mat.uniforms.uStripe3Frequency) mat.uniforms.uStripe3Frequency.value = this.params.stripe3Frequency;
      if (mat.uniforms.uStripe3Speed) mat.uniforms.uStripe3Speed.value = this.params.stripe3Speed;
      if (mat.uniforms.uStripe3Angle) mat.uniforms.uStripe3Angle.value = this.params.stripe3Angle;
      if (mat.uniforms.uStripe3Width) mat.uniforms.uStripe3Width.value = this.params.stripe3Width;
      if (mat.uniforms.uStripe3Intensity) mat.uniforms.uStripe3Intensity.value = this.params.stripe3Intensity;
      if (mat.uniforms.uStripe3Parallax) mat.uniforms.uStripe3Parallax.value = this.params.stripe3Parallax;
      if (mat.uniforms.uStripe3Wave) mat.uniforms.uStripe3Wave.value = this.params.stripe3Wave;
      if (mat.uniforms.uStripe3Gaps) mat.uniforms.uStripe3Gaps.value = this.params.stripe3Gaps;
      if (mat.uniforms.uStripe3Softness) mat.uniforms.uStripe3Softness.value = this.params.stripe3Softness;
    }

    // Keep per-tile overlay visibility synced with tile hover fading.
    // Tile hover-hide is driven by sprite.material.opacity, not sprite.visible, so
    // we must re-evaluate overlay visibility each frame (not only on transform sync).
    try {
      if (this._tileOverlays && this._tileOverlays.size > 0) {
        for (const entry of this._tileOverlays.values()) {
          const meshes = [entry?.occluderMesh, entry?.colorMesh].filter(Boolean);
          const sprite = entry?.sprite;
          if (meshes.length === 0 || !sprite) continue;

          let spriteOpacity = 1.0;
          try {
            const o = sprite?.material?.opacity;
            if (typeof o === 'number' && Number.isFinite(o)) spriteOpacity = o;
          } catch (_) {
          }

          // Mirror the same cutoff used by TileManager for depthWrite and by
          // SpecularEffect._syncTileOverlayTransform.
          const shouldShow = !!sprite.visible && spriteOpacity > 0.01;
          for (const mesh of meshes) {
            if (mesh.visible !== shouldShow) mesh.visible = shouldShow;
          }
        }
      }
    } catch (_) {
    }

    // Update Foundry darkness level and ambient environment colors
    try {
      const scene = canvas?.scene;
      const env = canvas?.environment;
      if (scene?.environment?.darknessLevel !== undefined) {
        let darkness = scene.environment.darknessLevel;
        const le = window.MapShine?.lightingEffect;
        if (le && typeof le.getEffectiveDarkness === 'function') {
          darkness = le.getEffectiveDarkness();
        }
        for (const mat of this._materials) {
          if (mat?.uniforms?.uDarknessLevel) {
            mat.uniforms.uDarknessLevel.value = darkness;
          }
        }
      }

      const colors = env?.colors;
      if (colors) {
        for (const mat of this._materials) {
          const uniforms = mat?.uniforms;
          if (!uniforms) continue;

        const applyColor = (src, targetColor) => {
          if (!src || !targetColor) return;
          // Foundry Color objects expose .toArray() and sometimes .rgb; use
          // whatever is available and fall back to sane defaults.
          let r = 1, g = 1, b = 1;
          try {
            if (Array.isArray(src)) {
              r = src[0] ?? 1; g = src[1] ?? 1; b = src[2] ?? 1;
            } else if (typeof src.r === 'number' && typeof src.g === 'number' && typeof src.b === 'number') {
              r = src.r; g = src.g; b = src.b;
            } else if (typeof src.toArray === 'function') {
              const arr = src.toArray();
              r = arr[0] ?? 1; g = arr[1] ?? 1; b = arr[2] ?? 1;
            }
          } catch (e) {
            // Keep defaults on failure.
          }
          targetColor.setRGB(r, g, b);
        };

          applyColor(colors.ambientDaylight,  uniforms.uAmbientDaylight?.value);
          applyColor(colors.ambientDarkness,  uniforms.uAmbientDarkness?.value);
          applyColor(colors.ambientBrightest, uniforms.uAmbientBrightest?.value);
        }
      }
    } catch (e) {
      // If canvas or environment are not ready, keep previous values.
    }
  }

  /**
   * Render effect
   * @param {THREE.Renderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  render(renderer, scene, camera) {
    // The base mesh material may not exist if the scene has no scene-wide _Specular mask,
    // but per-tile overlay materials can still receive per-frame uniforms.
    if (!this._materials || this._materials.size === 0) return;
    
    // Update camera position for view-dependent effects
    // Safety check: ensure camera position is valid
    for (const mat of this._materials) {
      if (!mat?.uniforms?.uCameraPosition?.value) continue;
      if (isFinite(camera.position.x) && isFinite(camera.position.y) && isFinite(camera.position.z)) {
        mat.uniforms.uCameraPosition.value.copy(camera.position);
      } else {
        log.warn('Camera position contains NaN/Infinity, using fallback');
        mat.uniforms.uCameraPosition.value.set(0, 0, 100);
      }
    }
    
    // Update uCameraOffset for parallax effects
    for (const mat of this._materials) {
      if (!mat?.uniforms?.uCameraOffset?.value?.set) continue;
      if (isFinite(camera.position.x) && isFinite(camera.position.y)) {
        mat.uniforms.uCameraOffset.value.set(camera.position.x, camera.position.y);
      } else if (camera.isOrthographicCamera) {
        const centerX = (camera.left + camera.right) / 2;
        const centerY = (camera.top + camera.bottom) / 2;
        mat.uniforms.uCameraOffset.value.set(centerX, centerY);
      }
    }

    // Bind CloudEffect shadow texture for sun-break specular boost.
    // This must run every frame because CloudEffect renders to an internal
    // render target which may be recreated/resized.
    try {
      const THREE = window.THREE;
      if (THREE) {
        if (!this._tempScreenSize) this._tempScreenSize = new THREE.Vector2();
        renderer.getDrawingBufferSize(this._tempScreenSize);
        for (const mat of this._materials) {
          if (mat?.uniforms?.uScreenSize?.value?.set) {
            mat.uniforms.uScreenSize.value.set(this._tempScreenSize.x, this._tempScreenSize.y);
          }
        }

        const mm = window.MapShine?.maskManager;
        const tex = mm ? mm.getTexture('cloudShadow.screen') : null;
        let hasCloud = !!tex;

        if (!tex) {
          const cloud = window.MapShine?.cloudEffect;
          const fallbackTex = cloud?.cloudShadowTarget?.texture || null;
          hasCloud = !!(cloud && cloud.enabled && fallbackTex);
          for (const mat of this._materials) {
            if (mat?.uniforms?.uCloudShadowMap) mat.uniforms.uCloudShadowMap.value = hasCloud ? fallbackTex : null;
            if (mat?.uniforms?.uHasCloudShadowMap) mat.uniforms.uHasCloudShadowMap.value = hasCloud;
          }
        }

        for (const mat of this._materials) {
          if (mat?.uniforms?.uHasCloudShadowMap) mat.uniforms.uHasCloudShadowMap.value = hasCloud;
          if (mat?.uniforms?.uCloudShadowMap) {
            mat.uniforms.uCloudShadowMap.value = hasCloud ? (tex || mat.uniforms.uCloudShadowMap.value) : null;
          }
        }

        const roofTex = weatherController?.roofMap || null;
        const d = typeof canvas !== 'undefined' ? canvas?.dimensions : null;
        for (const mat of this._materials) {
          if (mat?.uniforms?.uRoofMap) mat.uniforms.uRoofMap.value = roofTex;
          if (mat?.uniforms?.uRoofMaskEnabled) mat.uniforms.uRoofMaskEnabled.value = roofTex ? 1.0 : 0.0;
          if (d && mat?.uniforms?.uSceneBounds?.value?.set) {
            const rect = d.sceneRect;
            const sx = rect?.x ?? d.sceneX ?? 0;
            const syFoundry = rect?.y ?? d.sceneY ?? 0;
            const sw = rect?.width ?? d.sceneWidth ?? d.width ?? 1;
            const sh = rect?.height ?? d.sceneHeight ?? d.height ?? 1;
            const worldH = d.height ?? (syFoundry + sh);

            // Convert Foundry Y-down scene rect into Three.js Y-up bounds.
            // We store minY in world space so shaders can project vWorldPosition.xy.
            const syWorld = worldH - (syFoundry + sh);
            mat.uniforms.uSceneBounds.value.set(sx, syWorld, sw, sh);
          }
        }

        // Bind building shadow world-space texture for specular suppression.
        // BuildingShadowsEffect bakes shadows into a world-space RT (worldShadowTarget).
        // Not exposed on window.MapShine; look it up via effectComposer.
        const bse = window.MapShine?.effectComposer?.effects?.get('building-shadows');
        const bsTex = (bse && bse.enabled) ? bse.worldShadowTarget?.texture : null;
        const hasBs = !!bsTex;
        for (const mat of this._materials) {
          if (mat?.uniforms?.uHasBuildingShadowMap) mat.uniforms.uHasBuildingShadowMap.value = hasBs;
          if (mat?.uniforms?.uBuildingShadowMap) mat.uniforms.uBuildingShadowMap.value = hasBs ? bsTex : null;
        }
      }
    } catch (e) {
      for (const mat of this._materials) {
        if (mat?.uniforms?.uHasCloudShadowMap) mat.uniforms.uHasCloudShadowMap.value = false;
        if (mat?.uniforms?.uCloudShadowMap) mat.uniforms.uCloudShadowMap.value = null;
        if (mat?.uniforms?.uRoofMap) mat.uniforms.uRoofMap.value = null;
        if (mat?.uniforms?.uRoofMaskEnabled) mat.uniforms.uRoofMaskEnabled.value = 0.0;
        if (mat?.uniforms?.uHasBuildingShadowMap) mat.uniforms.uHasBuildingShadowMap.value = false;
        if (mat?.uniforms?.uBuildingShadowMap) mat.uniforms.uBuildingShadowMap.value = null;
      }
    }
    
    // Material is already applied to mesh, so normal scene render handles it
  }

  /**
   * Validate shader state for errors
   * @private
   */
  validateShaderState(timeInfo = null) {
    const nowS = (timeInfo && typeof timeInfo.elapsed === 'number') ? timeInfo.elapsed : null;
    if (typeof nowS === 'number') {
      if (typeof this.lastValidationS !== 'number') this.lastValidationS = -Infinity;
      if ((nowS - this.lastValidationS) < 1.0) return; // Max once per second
      this.lastValidationS = nowS;
    } else {
      const now = performance.now();
      if (now - this.lastValidation < 1000) return; // Max once per second
      this.lastValidation = now;
    }
    
    // The base mesh material can be null when a scene has no scene-wide _Specular mask.
    // In that case, validate any available material instance (e.g. per-tile overlays).
    const matToValidate = this.material || (this._materials ? this._materials.values().next().value : null);
    if (!matToValidate) return;

    const result = ShaderValidator.validateMaterialUniforms(matToValidate);
    
    if (!result.valid) {
      this.validationErrors = result.errors;
      log.error('Shader validation failed:', result.errors);
      
      // Show user-facing error
      if (ui?.notifications) {
        ui.notifications.error('Map Shine: Invalid shader state detected. Check console or reset to defaults.');
      }
    } else {
      // Clear errors on success
      const errs = Array.isArray(this.validationErrors) ? this.validationErrors : [];
      if (errs.length > 0) {
        log.info('Shader validation passed, errors cleared');
        this.validationErrors = [];
      }
    }
    
    if (result.warnings.length > 0) {
      log.warn('Shader validation warnings:', result.warnings);
    }
  }

  /**
   * Get current validation status
   * @returns {Object} { valid, errors }
   * @public
   */
  getValidationStatus() {
    const errs = Array.isArray(this.validationErrors) ? this.validationErrors : [];
    return {
      valid: errs.length === 0,
      errors: errs
    };
  }

  /**
   * Dispose resources
   */
  dispose() {
    Hooks.off('createAmbientLight', this.onLightCreatedBound);
    Hooks.off('updateAmbientLight', this.onLightUpdatedBound);
    Hooks.off('deleteAmbientLight', this.onLightDeletedBound);

    for (const tileId of Array.from(this._tileOverlays.keys())) {
      this.unbindTileSprite(tileId);
    }

    for (const mat of Array.from(this._materials)) {
      try {
        mat?.dispose?.();
      } catch (_) {
      }
    }
    this._materials.clear();
    this.material = null;
    this._scene = null;
    log.info('Specular effect disposed');
  }

  /**
   * Get vertex shader source
   * @returns {string} GLSL vertex shader
   * @private
   */
  getVertexShader() {
    return `
      varying vec2 vUv;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPosition;
      
      void main() {
        vUv = uv;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;
  }

  /**
   * Get fragment shader source
   * @returns {string} GLSL fragment shader
   * @private
   */
  getFragmentShader() {
    return `
      uniform sampler2D uAlbedoMap;
      uniform sampler2D uSpecularMap;
      uniform sampler2D uRoughnessMap;
      uniform sampler2D uNormalMap;
      
      uniform bool uHasRoughnessMap;
      uniform bool uHasNormalMap;
      
      uniform bool uEffectEnabled;

      uniform float uOutputMode;
      uniform float uTileAlphaClip;
      
      uniform float uSpecularIntensity;
      uniform float uRoughness;
      
      uniform vec3 uLightDirection;
      uniform vec3 uLightColor;
      uniform vec3 uCameraPosition;
      uniform vec2 uCameraOffset; // Orthographic camera pan offset
      
      // Time
      uniform float uTime;
      
      // Multi-layer stripe system
      uniform bool  uStripeEnabled;
      uniform float uStripeBlendMode;
      uniform float uParallaxStrength;
      uniform float uStripeMaskThreshold;
      uniform float uWorldPatternScale;
      
      // Layer 1
      uniform bool  uStripe1Enabled;
      uniform float uStripe1Frequency;
      uniform float uStripe1Speed;
      uniform float uStripe1Angle;
      uniform float uStripe1Width;
      uniform float uStripe1Intensity;
      uniform float uStripe1Parallax;
      uniform float uStripe1Wave;
      uniform float uStripe1Gaps;
      uniform float uStripe1Softness;
      
      // Layer 2
      uniform bool  uStripe2Enabled;
      uniform float uStripe2Frequency;
      uniform float uStripe2Speed;
      uniform float uStripe2Angle;
      uniform float uStripe2Width;
      uniform float uStripe2Intensity;
      uniform float uStripe2Parallax;
      uniform float uStripe2Wave;
      uniform float uStripe2Gaps;
      uniform float uStripe2Softness;
      
      // Layer 3
      uniform bool  uStripe3Enabled;
      uniform float uStripe3Frequency;
      uniform float uStripe3Speed;
      uniform float uStripe3Angle;
      uniform float uStripe3Width;
      uniform float uStripe3Intensity;
      uniform float uStripe3Parallax;
      uniform float uStripe3Wave;
      uniform float uStripe3Gaps;
      uniform float uStripe3Softness;
      
      // Micro Sparkle
      uniform bool uSparkleEnabled;
      uniform float uSparkleIntensity;
      uniform float uSparkleScale;
      uniform float uSparkleSpeed;

      // Outdoor cloud specular: cloud shadows drive specular intensity outdoors
      uniform bool uOutdoorCloudSpecularEnabled;
      uniform float uOutdoorStripeBlend;      // How much stripes show outdoors (0=none, 1=full)
      uniform float uCloudSpecularIntensity;  // Intensity of cloud-driven specular

      // Wet Surface (Rain) - derives specular from high-contrast grayscale albedo
      uniform bool uWetSpecularEnabled;
      uniform float uRainWetness;  // 0=dry, 1=fully wet (driven by weather precipitation)
      // Input CC
      uniform float uWetInputBrightness;  // Pre-contrast brightness shift
      uniform float uWetInputGamma;       // Midtone curve before contrast
      uniform float uWetSpecularContrast; // Contrast boost on grayscale
      uniform float uWetBlackPoint;       // Low-end cutoff (surfaces below don't shine)
      uniform float uWetWhitePoint;       // High-end cap (tames bright surfaces)
      // Output CC
      uniform float uWetSpecularIntensity; // Overall wet shine multiplier
      uniform float uWetOutputMax;         // Hard brightness cap (prevents bloom)
      uniform float uWetOutputGamma;       // Output curve shaping

      uniform sampler2D uRoofMap;
      uniform float uRoofMaskEnabled;
      uniform vec4 uSceneBounds;

      uniform bool uHasCloudShadowMap;
      uniform sampler2D uCloudShadowMap;
      uniform vec2 uScreenSize;
      
      // Foundry scene darkness (0 = light, 1 = dark)
      uniform float uDarknessLevel;
      
      // Foundry ambient environment colors (linear RGB).
      uniform vec3 uAmbientDaylight;
      uniform vec3 uAmbientDarkness;
      uniform vec3 uAmbientBrightest;
      
      // Dynamic Lights
      uniform int numLights;
      uniform vec3 lightPosition[${this.maxLights}];
      uniform vec3 lightColor[${this.maxLights}];
      uniform vec4 lightConfig[${this.maxLights}]; // radius, dim, attenuation, unused

      // Frost / Ice Glaze
      uniform bool uFrostGlazeEnabled;
      uniform float uFrostLevel;        // 0=warm, 1=fully frozen (computed from weather)
      uniform float uFrostIntensity;    // Specular boost multiplier
      uniform float uFrostTintStrength; // Blue-white tint blend (0-1)

      // Dynamic Light Color Tinting
      uniform bool uDynamicLightTintEnabled;
      uniform float uDynamicLightTintStrength; // 0=global only, 1=fully dynamic

      // Wind-Driven Stripe Animation
      uniform bool uWindDrivenStripesEnabled;
      uniform float uWindStripeInfluence;
      uniform vec2 uWindAccum; // Monotonically accumulated wind displacement (CPU-integrated)

      // Building Shadow Suppression
      uniform bool uBuildingShadowSuppressionEnabled;
      uniform float uBuildingShadowSuppressionStrength;
      uniform bool uHasBuildingShadowMap;
      uniform sampler2D uBuildingShadowMap;

      varying vec2 vUv;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPosition;
      
      // Simple 1D noise function for stripe variation
      float noise1D(float p) {
        return fract(sin(p * 127.1) * 43758.5453);
      }
      
      // Pseudo-random hash for sparkles
      float hash12(vec2 p) {
        vec3 p3  = fract(vec3(p.xyx) * .1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }

      // Sparkle noise function
      float sparkleNoise(vec2 uv, float scale, float time, float speed) {
        vec2 p = uv * scale;
        vec2 id = floor(p);
        
        // Random value per cell
        float rnd = hash12(id);
        
        // Animate phase
        float phase = time * speed + rnd * 6.28;
        
        // Blink pattern (peaky sine wave)
        float blink = max(0.0, sin(phase) - 0.8) * 5.0;
        
        return blink * rnd;
      }

      // Simplex 2D noise for stripe distortion and gaps
      vec3 permute(vec3 x) { return mod(((x*34.0)+1.0)*x, 289.0); }

      float snoise(vec2 v){
        const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                            -0.577350269189626, 0.024390243902439);
        vec2 i  = floor(v + dot(v, C.yy));
        vec2 x0 = v - i + dot(i, C.xx);
        vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
        vec4 x12 = x0.xyxy + C.xxzz;
        x12.xy -= i1;
        i = mod(i, 289.0);
        vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0 ))
                        + i.x + vec3(0.0, i1.x, 1.0 ));
        vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
        m *= m;
        m *= m;
        vec3 x = 2.0 * fract(p * C.www) - 1.0;
        vec3 h = abs(x) - 0.5;
        vec3 ox = floor(x + 0.5);
        vec3 a0 = x - ox;
        m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
        vec3 g;
        g.x  = a0.x  * x0.x  + h.x  * x0.y;
        g.yz = a0.yz * x12.xz + h.yz * x12.yw;
        return 130.0 * dot(m, g);
      }
      
      /**
       * Generate a single stripe layer with camera-based parallax
       * @param uv - World-space pattern coordinates (top-down oriented)
       * @param worldPos - World position of fragment
       * @param cameraPos - Camera position in world space
       * @param time - Current time
       * @param frequency - Number of stripe pairs across surface
       * @param speed - Animation speed (can be negative)
       * @param angle - Rotation angle in degrees
       * @param width - Stripe width (0-1)
       * @param parallaxDepth - Parallax depth factor (0 = moves with map, 1 = far away, -1 = close up)
       * @param parallaxStrength - Global parallax multiplier
       */
      float generateStripeLayer(
        vec2 uv,
        vec3 worldPos,
        vec3 cameraPos,
        float time, 
        float frequency, 
        float speed, 
        float angle, 
        float width,
        float parallaxDepth,
        float parallaxStrength,
        float wave,
        float gaps,
        float softness
      ) {
        // If speed is 0, freeze all time-based animation for this layer.
        // (Demands like "set all speeds to 0" should result in a static pattern.)
        float timeAnim = (abs(speed) > 0.000001) ? time : 0.0;

        // Secondary animation (wave/pulse/gaps) used to run at a fixed rate regardless
        // of speed, which made tiny speeds (e.g. 0.001) still look "fast".
        // Treat speed=0.01 as "1x" so the existing defaults preserve the same feel.
        float speedAnimScale = clamp(abs(speed) / 0.01, 0.0, 10.0);

        // Apply camera-based parallax offset
        // Parallax creates the illusion of depth by offsetting UV based on camera position
        // - parallaxDepth = 0: Layer moves with the map (no parallax)
        // - parallaxDepth > 0: Layer appears farther away (moves slower than camera)
        // - parallaxDepth < 0: Layer appears closer (moves faster than camera)
        vec2 parallaxUv = uv;
        if (parallaxDepth != 0.0) {
          // Calculate parallax offset based on camera pan offset
          // Negative parallaxDepth = layer moves faster (closer)
          // Positive parallaxDepth = layer moves slower (farther)
          // The effect subtracts offset so positive depth = slower movement
          vec2 offset = uCameraOffset * parallaxDepth * parallaxStrength * 0.001;
          parallaxUv -= offset;
        }

        // Distort UVs for waviness
        if (wave > 0.0) {
          float waveNoise = snoise(parallaxUv * 2.0 + timeAnim * (0.1 * speedAnimScale));
          parallaxUv += waveNoise * wave * 0.05;
        }
        
        // Rotate UV based on angle
        float rad = radians(angle);
        float cosA = cos(rad);
        float sinA = sin(rad);
        vec2 rotUv = vec2(
          parallaxUv.x * cosA - parallaxUv.y * sinA,
          parallaxUv.x * sinA + parallaxUv.y * cosA
        );
        
        // Create scrolling stripes with time-based animation
        float pos = rotUv.x * frequency + timeAnim * speed;
        float stripe = fract(pos);
        
        // Map UI width (0-1) to an actual half-band size (0.02-0.48)
        // - width = 0   -> very thin stripe
        // - width = 1   -> very thick stripe (almost full period)
        float w = clamp(width, 0.0, 1.0);
        float bandHalfWidth = mix(0.02, 0.48, w);
        
        // Optional subtle jitter so all stripes aren't identical, but
        // small enough to keep the control intuitive
        float noiseVal = noise1D(floor(pos));
        bandHalfWidth *= (0.95 + 0.1 * noiseVal);
        
        // Distance from the center of the period (0.5)
        float d = abs(stripe - 0.5);
        
        // Soft edge size driven by softness (0=hard,1=very soft)
        float s = clamp(softness, 0.0, 1.0);
        float edgeSoftness = mix(0.005, 0.18, s);
        float innerRadius = bandHalfWidth - edgeSoftness;
        innerRadius = max(innerRadius, 0.0);
        
        // Stripe value = 1 in the middle of the band, falling to 0 at edges
        float stripePattern = smoothstep(bandHalfWidth, innerRadius, d);

        // Subtle temporal pulse so stripes are not static
        float pulse = 0.9 + 0.1 * sin(timeAnim * (0.7 * speedAnimScale) + frequency * 1.23);
        stripePattern *= pulse;

        // Apply gaps to break stripes into shiny spots
        if (gaps > 0.0) {
          float gapNoise = snoise(rotUv * 5.0 + timeAnim * (0.2 * speedAnimScale));
          float normNoise = gapNoise * 0.5 + 0.5; // 0..1
          float gapMask = smoothstep(gaps, gaps + 0.2, normNoise);
          stripePattern *= gapMask;
        }
        
        return stripePattern;
      }
      
      /**
       * Blend two values using various blend modes
       * @param base - Base value
       * @param blend - Value to blend
       * @param mode - Blend mode (0=Add, 1=Multiply, 2=Screen, 3=Overlay)
       */
      float blendMode(float base, float blend, float mode) {
        if (mode < 0.5) {
          // Add
          return base + blend;
        } else if (mode < 1.5) {
          // Multiply
          return base * (1.0 + blend);
        } else if (mode < 2.5) {
          // Screen
          return 1.0 - (1.0 - base) * (1.0 - blend);
        } else {
          // Overlay
          return base < 0.5 
            ? 2.0 * base * blend 
            : 1.0 - 2.0 * (1.0 - base) * (1.0 - blend);
        }
      }
      
      // Reinhard-Jodie tone mapping to compress highlights and prevent wash-out
      vec3 reinhardJodie(vec3 c) {
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        vec3 tc = c / (c + 1.0);
        return mix(c / (l + 1.0), tc, tc);
      }
      
      void main() {
        // Sample textures
        vec4 albedo = texture2D(uAlbedoMap, vUv);
        vec4 specularMaskSample = texture2D(uSpecularMap, vUv);

        // Coverage used for overlay depth/color writes.
        // IMPORTANT: Use tile albedo alpha only so an upper tile still blocks
        // lower specular even where its _Specular alpha is 0 (black/no shine).
        // This prevents lower-tile specular leakage through opaque top tiles.
        float maskCoverage = albedo.a;

        // For specular-only tile overlays, clip fully transparent tile texels.
        // This keeps overlays from occluding through true tile holes.
        if (uOutputMode > 0.5 && maskCoverage <= max(0.0, uTileAlphaClip)) discard;
        
        // Apply Foundry darkness level and ambient environment tint. We
        // approximate Foundry's computedBackgroundColor by blending
        // between ambientDaylight and ambientDarkness.
        float safeDarkness = clamp(uDarknessLevel, 0.0, 1.0);
        
        // Foundry VTT darkness 1.0 is ~75% dark, not pitch black.
        // We clamp the light level falloff to ensure the scene remains visible (0.25).
        // This also ensures that dynamic lights have a base surface to reflect off.
        float lightLevel = max(1.0 - safeDarkness, 0.25);
        
        vec3 ambientTint = mix(uAmbientDaylight, uAmbientDarkness, safeDarkness);
        
        // If effect is disabled, just render the base albedo with standard lighting
        // (or transparent black if we're in specular-only mode).
        if (!uEffectEnabled) {
          // Tint the base albedo by the ambient environment so the Three.js
          // base plane lives in roughly the same color/brightness space as
          // Foundry's background lighting pass.
          if (uOutputMode > 0.5) {
            gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
          } else {
            vec3 baseAlbedo = albedo.rgb * ambientTint;
            gl_FragColor = vec4(baseAlbedo, albedo.a);
          }
          return;
        }
        
        // ---------------------------------------------------------
        // Dynamic Lighting Calculation (Falloff Only)
        // ---------------------------------------------------------
        vec3 totalDynamicLight = vec3(0.0);
        vec3 dominantDynLightColor = vec3(1.0); // Fallback: white (neutral tint)
        float dominantDynLightWeight = 0.0;
        
        for (int i = 0; i < ${this.maxLights}; i++) {
          if (i >= numLights) break;
          
          vec3 lPos = lightPosition[i];
          vec3 lColor = lightColor[i];
          float radius = lightConfig[i].x;
          float dim = lightConfig[i].y;
          float attenuation = lightConfig[i].z;
          
          float dist = distance(vWorldPosition.xy, lPos.xy);
          
          if (dist < radius) {
            float d = dist / radius;
            
            // Foundry Falloff
            float inner = (radius > 0.0) ? clamp(dim / radius, 0.0, 0.99) : 0.0;
            float falloff = 1.0 - smoothstep(inner, 1.0, d);
            
            float linear = 1.0 - d;
            float squared = 1.0 - d * d;
            float lightIntensity = mix(linear, squared, attenuation) * falloff;
            
            totalDynamicLight += lColor * lightIntensity;

            // Track the brightest contributing light for color tinting.
            // Uses perceptual luminance weighting so colored lights compete fairly.
            float contribution = dot(lColor, vec3(0.2126, 0.7152, 0.0722)) * lightIntensity;
            if (contribution > dominantDynLightWeight) {
              dominantDynLightWeight = contribution;
              // Normalize the light color to extract its hue (avoid div-by-zero)
              float lum = max(dot(lColor, vec3(0.2126, 0.7152, 0.0722)), 0.001);
              dominantDynLightColor = lColor / lum;
            }
          }
        }

        // Ambient environment contribution (approximated)
        // This represents the "Global Light" (Sun/Moon)
        // We scale it by lightLevel so it fades out as darkness increases,
        // ensuring no global specular shine in pitch darkness.
        vec3 ambientLight = ambientTint * lightLevel; 
        
        // Total light receiving at this pixel
        // Used to modulate specular so it doesn't shine in pitch blackness
        vec3 totalIncidentLight = ambientLight + totalDynamicLight;
        
        vec4 specularMask = specularMaskSample;
        float roughness = uHasRoughnessMap ? texture2D(uRoughnessMap, vUv).r : uRoughness;

        // ---------------------------------------------------------
        // Outdoor Factor (needed early for wet surface augmentation)
        // ---------------------------------------------------------
        float outdoorFactor = 1.0;
        if (uRoofMaskEnabled > 0.5) {
          float u = (vWorldPosition.x - uSceneBounds.x) / max(1e-5, uSceneBounds.z);
          float v = (vWorldPosition.y - uSceneBounds.y) / max(1e-5, uSceneBounds.w);
          v = 1.0 - v;
          vec2 roofUv = clamp(vec2(u, v), 0.0, 1.0);
          outdoorFactor = texture2D(uRoofMap, roofUv).r;
        }

        // ---------------------------------------------------------
        // Wet Surface (Rain) — compute wet reflectivity mask
        // ---------------------------------------------------------
        // When it's raining, outdoor surfaces become shiny. We derive a
        // reflectivity mask from the albedo (grayscale + contrast boost).
        // This mask is kept SEPARATE from specularMask and only multiplied
        // by animated effects (stripes, clouds, sparkles) — never by the
        // base 1.0 — so wet surfaces only shine where effects sweep across
        // them, not as constant white paint.
        float wetMask = 0.0;
        if (uWetSpecularEnabled && uRainWetness > 0.001) {
          // --- Input CC ---
          // Convert albedo to grayscale luminance
          float gray = dot(albedo.rgb, vec3(0.299, 0.587, 0.114));
          
          // Brightness shift (slide the grayscale up or down before processing)
          gray = clamp(gray + uWetInputBrightness, 0.0, 1.0);
          
          // Input gamma (shape midtones: <1 = brighter mids, >1 = darker mids)
          gray = pow(gray, max(uWetInputGamma, 0.01));
          
          // Contrast boost around midpoint (pushes midtones towards black/white)
          float contrasted = clamp((gray - 0.5) * uWetSpecularContrast + 0.5, 0.0, 1.0);
          
          // Black/white point remap: smoothstep cuts dark surfaces (blackPoint)
          // and caps bright surfaces (whitePoint) to prevent bloom explosion.
          float bp = min(uWetBlackPoint, uWetWhitePoint - 0.001);
          contrasted = smoothstep(bp, uWetWhitePoint, contrasted);
          
          // Modulate by outdoor factor (indoors stays dry) and rain intensity.
          // uWetSpecularIntensity is applied later as part of output CC.
          wetMask = contrasted * outdoorFactor * uRainWetness;
        }
        
        // TODO: Snow Albedo Effect
        // When freezeLevel > 0.55 and precipitation is active (snow type),
        // blend outdoor albedo towards a white/snow-tinted colour to simulate
        // snow accumulation on surfaces. This should modify litAlbedo below,
        // not the specular channel. Gate by outdoorFactor so indoors stays clear.

        // Calculate specular mask strength (luminance of the original mask, unmodified)
        float specularStrength = dot(specularMask.rgb, vec3(0.299, 0.587, 0.114)) * specularMask.a;

        // Cloud lighting (1.0 = lit gap, 0.0 = shadow) sampled in screen-space.
        // Default to fully lit if texture is unavailable.
        float cloudLit = 1.0;
        if (uHasCloudShadowMap) {
          vec2 screenUv0 = gl_FragCoord.xy / max(uScreenSize, vec2(1.0));
          cloudLit = texture2D(uCloudShadowMap, screenUv0).r;
        }
        
        // Multi-layer stripe composition
        float stripeMaskAnimated = 0.0;

        // World-space pattern coordinates so stripe/sparkle scale is stable
        // across tiles of different sizes (instead of restarting per tile UV).
        // We use a top-down Y convention to match Foundry orientation.
        float worldPatternScalePx = max(1.0, uWorldPatternScale);
        float worldX = (vWorldPosition.x - uSceneBounds.x);
        float worldYTopDown = ((uSceneBounds.y + uSceneBounds.w) - vWorldPosition.y);
        vec2 worldPatternUv = vec2(worldX, worldYTopDown) / worldPatternScalePx;
        
        if (uStripeEnabled) {
          // Generate each stripe layer
          float layer1 = 0.0;
          float layer2 = 0.0;
          float layer3 = 0.0;
          
          if (uStripe1Enabled) {
            layer1 = generateStripeLayer(
              worldPatternUv, vWorldPosition, uCameraPosition, uTime,
              uStripe1Frequency, uStripe1Speed, uStripe1Angle, 
              uStripe1Width, uStripe1Parallax, uParallaxStrength,
              uStripe1Wave, uStripe1Gaps, uStripe1Softness
            ) * uStripe1Intensity;
          }
          
          if (uStripe2Enabled) {
            layer2 = generateStripeLayer(
              worldPatternUv, vWorldPosition, uCameraPosition, uTime,
              uStripe2Frequency, uStripe2Speed, uStripe2Angle, 
              uStripe2Width, uStripe2Parallax, uParallaxStrength,
              uStripe2Wave, uStripe2Gaps, uStripe2Softness
            ) * uStripe2Intensity;
          }
          
          if (uStripe3Enabled) {
            layer3 = generateStripeLayer(
              worldPatternUv, vWorldPosition, uCameraPosition, uTime,
              uStripe3Frequency, uStripe3Speed, uStripe3Angle, 
              uStripe3Width, uStripe3Parallax, uParallaxStrength,
              uStripe3Wave, uStripe3Gaps, uStripe3Softness
            ) * uStripe3Intensity;
          }
          
          // Composite layers using selected blend mode
          stripeMaskAnimated = layer1;
          if (uStripe2Enabled) {
            stripeMaskAnimated = blendMode(stripeMaskAnimated, layer2, uStripeBlendMode);
          }
          if (uStripe3Enabled) {
            stripeMaskAnimated = blendMode(stripeMaskAnimated, layer3, uStripeBlendMode);
          }
        }
        
        // Calculate sparkles
        float sparkleVal = 0.0;
        if (uSparkleEnabled) {
          // World-space sparkles to avoid per-tile UV stretching.
          sparkleVal = sparkleNoise(worldPatternUv, uSparkleScale, uTime, uSparkleSpeed);
          
          // Mask by specular strength so we don't sparkle on matte areas
          sparkleVal *= specularStrength;
        }
        
        // ---------------------------------------------------------
        // Outdoor Cloud Specular
        // ---------------------------------------------------------
        // Outdoors: cloud shadow (cloudLit) is the primary driver of specular.
        // cloudLit = 1.0 means lit by sky (no cloud shadow) → bright specular
        // cloudLit = 0.0 means in cloud shadow → dim specular
        // Stripes still contribute but are blended down outdoors via uOutdoorStripeBlend.
        // Indoors (no cloud map): stripes work normally.
        
        float stripeContribution = stripeMaskAnimated;
        float cloudSpecular = 0.0;
        
        if (uOutdoorCloudSpecularEnabled && uHasCloudShadowMap) {
          // Cloud lit areas get bright specular (reflecting sky)
          cloudSpecular = cloudLit * uCloudSpecularIntensity * outdoorFactor;
          
          // Blend stripes: outdoors stripes are reduced, clouds dominate
          // At outdoorStripeBlend=0: stripes contribute nothing outdoors
          // At outdoorStripeBlend=1: stripes contribute fully (like indoors)
          stripeContribution *= mix(1.0, uOutdoorStripeBlend, outdoorFactor);
        }
        
        // Animated effects only (stripes + clouds + sparkles, NO base 1.0).
        // Used by the wet path so wet surfaces only shine where effects are active.
        float effectsOnly = stripeContribution + cloudSpecular + (sparkleVal * uSparkleIntensity);
        
        // Full modulator for the original specular mask (base 1.0 + effects).
        float totalModulator = 1.0 + effectsOnly;

        // Stripe brightness threshold: only allow shine on the brightest parts
        // of the specular mask when stripes are enabled. 0 = full mask, 1 = only
        // near-white texels.
        // IMPORTANT: This only gates totalModulator (the original specular mask path).
        // The wet path uses raw effectsOnly because it derives its own spatial gating
        // from the albedo contrast, not the specular mask. Without this separation,
        // a black/missing specular mask (specularStrength=0) would zero out the
        // threshold and kill the wet effect entirely.
        if (uStripeEnabled && uStripeMaskThreshold > 0.0) {
          float thresholdMask = smoothstep(uStripeMaskThreshold, 1.0, specularStrength);
          totalModulator *= thresholdMask;
        }
        
        // Dynamic light color tinting: blend global uLightColor toward the
        // dominant nearby dynamic light's hue so specular picks up local color.
        vec3 effectiveLightColor = uLightColor;
        if (uDynamicLightTintEnabled && dominantDynLightWeight > 0.01) {
          effectiveLightColor = mix(uLightColor, dominantDynLightColor, uDynamicLightTintStrength);
        }

        // Building shadow suppression: darken specular in building shadow areas.
        // The building shadow map is world-space UV (0..1 covers the scene).
        float buildingShadowFactor = 1.0;
        if (uBuildingShadowSuppressionEnabled && uHasBuildingShadowMap) {
          float bu = (vWorldPosition.x - uSceneBounds.x) / max(1e-5, uSceneBounds.z);
          float bv = (vWorldPosition.y - uSceneBounds.y) / max(1e-5, uSceneBounds.w);
          bv = 1.0 - bv; // Y-flip: V=0 at top of scene (same convention as roof mask)
          vec2 bsUv = clamp(vec2(bu, bv), 0.0, 1.0);
          float shadowVal = texture2D(uBuildingShadowMap, bsUv).r; // 1.0=lit, 0.0=shadow
          buildingShadowFactor = mix(1.0, shadowVal, uBuildingShadowSuppressionStrength);
        }

        // For 2.5D top-down: specular mask directly defines shine areas
        // The colored mask defines WHERE and WHAT COLOR things shine.
        // We modulate by totalIncidentLight to ensure we don't shine in darkness.
        // effectiveLightColor blends global tint with dominant dynamic light hue.
        // buildingShadowFactor suppresses specular in building shadows.
        vec3 specularColor = specularMask.rgb * specularMask.a * totalModulator * uSpecularIntensity * effectiveLightColor * totalIncidentLight * buildingShadowFactor;
        
        // Wind-driven ripple for wet surfaces only.
        // Creates traveling waves across wet outdoor surfaces in the wind direction.
        // This is separate from the base stripe animation — _Specular mask specular
        // is never wind-blown; only rain-wetness specular gets this treatment.
        float windRipple = 0.0;
        if (uWindDrivenStripesEnabled && uWindStripeInfluence > 0.0 && uRainWetness > 0.001 && outdoorFactor > 0.01) {
          // Offset UVs by accumulated wind displacement to create directional waves
          vec2 windUv = worldPatternUv + uWindAccum * uWindStripeInfluence;
          // Two octaves of noise at different scales for organic ripple feel
          float ripple1 = snoise(windUv * 8.0) * 0.6;
          float ripple2 = snoise(windUv * 16.0 + 3.7) * 0.4;
          windRipple = max(0.0, ripple1 + ripple2) * outdoorFactor;
        }

        // Wet specular: the wet mask is multiplied by effectsOnly (not the base 1.0)
        // so wet surfaces only light up where stripes sweep across, clouds create
        // specular highlights, or sparkles fire. Wind ripple adds extra modulation
        // on outdoor wet surfaces only.
        float wetEffects = effectsOnly + windRipple;
        vec3 wetSpecularColor = vec3(wetMask) * wetEffects * uWetSpecularIntensity * effectiveLightColor * totalIncidentLight * buildingShadowFactor;
        
        // --- Output CC ---
        // Output gamma: shapes the wet specular curve. >1 darkens midtones
        // (punchier, more contrast), <1 brightens midtones (softer falloff).
        if (uWetOutputGamma != 1.0) {
          wetSpecularColor = pow(max(wetSpecularColor, vec3(0.0)), vec3(max(uWetOutputGamma, 0.01)));
        }
        // Output clamp: hard cap prevents bloom explosion on bright surfaces.
        wetSpecularColor = min(wetSpecularColor, vec3(uWetOutputMax));

        // Frost / Ice Glaze: cold weather boosts specular and tints toward blue-white.
        // Only affects outdoor surfaces (gated by outdoorFactor).
        vec3 frostSpecularColor = vec3(0.0);
        if (uFrostGlazeEnabled && uFrostLevel > 0.001) {
          // Cool blue-white tint for frosted surfaces
          vec3 frostTint = mix(vec3(1.0), vec3(0.75, 0.88, 1.0), uFrostTintStrength);
          // Frost adds a broad specular boost modulated by the specular mask.
          // Unlike wet (which only shines where effects sweep), frost is a constant
          // icy sheen that covers the surface. Uses max of specular/wet masks so
          // frost applies on any reflective-looking area.
          float frostMask = max(specularStrength, wetMask) * outdoorFactor * uFrostLevel;
          frostSpecularColor = frostTint * frostMask * uFrostIntensity * totalIncidentLight * buildingShadowFactor;
        }
        
        // Apply Foundry darkness level with different falloff curves (reuse
        // lightLevel defined earlier). Albedo is additionally tinted by the
        // ambient environment mix so bright scenes feel closer to Foundry's
        // warm daylight and dark scenes to its cool darkness.
        
        // Linear falloff for albedo (base texture)
        // Allow total blackness at max darkness if requested
        float albedoBrightness = max(lightLevel, 0.0);
        
        // Apply brightness multipliers and ambient tint
        vec3 baseAlbedo = albedo.rgb * ambientTint;
        vec3 litAlbedo = baseAlbedo * albedoBrightness;
        
        // Specular is already lit by totalIncidentLight (which includes ambient + dynamic).
        // Wet specular is added separately — it only appears where animated effects are active.
        // Frost specular is a constant icy sheen on outdoor frozen surfaces.
        vec3 litSpecular = specularColor + wetSpecularColor + frostSpecularColor;

        // Simple additive composition: base + specular (including wet)
        vec3 finalColor = litAlbedo + litSpecular;
        
        // Debug visualization (uncomment to see components)
        // finalColor = vec3(stripeMask); // Show stripe pattern only
        // finalColor = vec3(layer1); // Show layer 1 only
        // finalColor = vec3(layer2); // Show layer 2 only
        // finalColor = vec3(layer3); // Show layer 3 only
        // finalColor = specularMask.rgb; // Show specular mask only
        // finalColor = vec3(wetMask); // Show wet reflectivity mask
        // finalColor = vec3(effectsOnly); // Show animated effects only
        // finalColor = vec3(frostSpecularColor); // Show frost glaze only
        // finalColor = vec3(buildingShadowFactor); // Show building shadow suppression
        // finalColor = effectiveLightColor; // Show dynamic light tint color

        // Output routing:
        // - Full mode: albedo + specular (tone mapped)
        // - Specular-only: specular only (tone mapped), intended for additive overlays
        vec3 outColor = (uOutputMode > 0.5) ? litSpecular : finalColor;
        outColor = reinhardJodie(outColor);

        float outA = (uOutputMode > 0.5) ? clamp(maskCoverage, 0.0, 1.0) : albedo.a;
        gl_FragColor = vec4(outColor, outA);
      }
    `;
  }
}
