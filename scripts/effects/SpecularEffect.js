/**
 * @fileoverview Specular highlight effect using PBR lighting
 * First effect implementation - demonstrates masked texture + custom shader
 * @module effects/SpecularEffect
 */

import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import { ShaderValidator } from '../core/shader-validator.js';
import { weatherController } from '../core/WeatherController.js';
import Coordinates from '../utils/coordinates.js';

const log = createLogger('SpecularEffect');

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

    // Light tracking
    this.lights = new Map();
    this.maxLights = 64;
    
    // Effect parameters (exposed to Tweakpane later)
    this.params = {
      // Status
      textureStatus: 'Searching...',
      hasSpecularMask: true,

      intensity: 0.75,           // Default shine intensity
      roughness: 0.0,
      lightDirection: { x: 0.6, y: 0.4, z: 0.7 },
      lightColor: { r: 1.0, g: 1.0, b: 1.0 },
      
      // Multi-layer stripe system
      stripeEnabled: true,
      stripeBlendMode: 0,       // 0=Add, 1=Multiply, 2=Screen, 3=Overlay
      parallaxStrength: 1.5,    // Global parallax intensity multiplier
      stripeMaskThreshold: 0.1, // 0 = all mask, 1 = only brightest texels
      
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
      cloudSpecularIntensity: 3.0  // Intensity of cloud-driven specular outdoors
    };

    this._tempScreenSize = null;

    this._fallbackAlbedo = null;
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
    if (this.material && this.material.uniforms.uEffectEnabled) {
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
          parameters: ['stripeEnabled', 'stripeBlendMode', 'parallaxStrength', 'stripeMaskThreshold']
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
          default: 0.75,
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
      log.warn('No specular mask found, effect will have no visible result');
      this.enabled = false;
      return;
    }
    
    log.info('Specular mask loaded, creating PBR material');

    const baseMap = baseMesh?.material?.map || this._getFallbackAlbedoTexture();
    this.createPBRMaterial(baseMap);
    
    // Replace base mesh material
    baseMesh.material.dispose();
    baseMesh.material = this.material;
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
    
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        // Textures
        uAlbedoMap: { value: safeBase },
        uSpecularMap: { value: this.specularMask },
        uRoughnessMap: { value: this.roughnessMask || safeBase },
        uNormalMap: { value: this.normalMap || safeBase },
        
        // Texture availability flags
        uHasRoughnessMap: { value: this.roughnessMask !== null },
        uHasNormalMap: { value: this.normalMap !== null },
        
        // Effect enabled state (for pass-through)
        uEffectEnabled: { value: this._enabled },
        
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
        uCameraOffset: { value: new THREE.Vector2(0, 0) }, // Orthographic camera pan offset
        
        // Time (for animation)
        uTime: { value: 0.0 },
        
        // Multi-layer stripe system
        uStripeEnabled: { value: this.params.stripeEnabled },
        uStripeBlendMode: { value: this.params.stripeBlendMode },
        uParallaxStrength: { value: this.params.parallaxStrength },
        uStripeMaskThreshold: { value: this.params.stripeMaskThreshold },
        
        // Layer 1
        uStripe1Enabled:   { value: this.params.stripe1Enabled },
        uStripe1Frequency: { value: this.params.stripe1Frequency },
        uStripe1Speed:     { value: this.params.stripe1Speed },
        uStripe1Angle:     { value: this.params.stripe1Angle },
        uStripe1Width:     { value: this.params.stripe1Width },
        uStripe1Intensity: { value: this.params.stripe1Intensity },
        uStripe1Parallax:  { value: this.params.stripe1Parallax },
        uStripe1Wave:      { value: this.params.stripe1Wave },
        uStripe1Gaps:      { value: this.params.stripe1Gaps },
        uStripe1Softness:  { value: this.params.stripe1Softness },
        
        // Layer 2
        uStripe2Enabled:   { value: this.params.stripe2Enabled },
        uStripe2Frequency: { value: this.params.stripe2Frequency },
        uStripe2Speed:     { value: this.params.stripe2Speed },
        uStripe2Angle:     { value: this.params.stripe2Angle },
        uStripe2Width:     { value: this.params.stripe2Width },
        uStripe2Intensity: { value: this.params.stripe2Intensity },
        uStripe2Parallax:  { value: this.params.stripe2Parallax },
        uStripe2Wave:      { value: this.params.stripe2Wave },
        uStripe2Gaps:      { value: this.params.stripe2Gaps },
        uStripe2Softness:  { value: this.params.stripe2Softness },
        
        // Layer 3
        uStripe3Enabled:   { value: this.params.stripe3Enabled },
        uStripe3Frequency: { value: this.params.stripe3Frequency },
        uStripe3Speed:     { value: this.params.stripe3Speed },
        uStripe3Angle:     { value: this.params.stripe3Angle },
        uStripe3Width:     { value: this.params.stripe3Width },
        uStripe3Intensity: { value: this.params.stripe3Intensity },
        uStripe3Parallax:  { value: this.params.stripe3Parallax },
        uStripe3Wave:      { value: this.params.stripe3Wave },
        uStripe3Gaps:      { value: this.params.stripe3Gaps },
        uStripe3Softness:  { value: this.params.stripe3Softness },
        
        // Micro Sparkle
        uSparkleEnabled: { value: this.params.sparkleEnabled },
        uSparkleIntensity: { value: this.params.sparkleIntensity },
        uSparkleScale: { value: this.params.sparkleScale },
        uSparkleSpeed: { value: this.params.sparkleSpeed },

        // Outdoor cloud specular (cloud shadows drive specular intensity outdoors)
        uOutdoorCloudSpecularEnabled: { value: this.params.outdoorCloudSpecularEnabled },
        uOutdoorStripeBlend: { value: this.params.outdoorStripeBlend },
        uCloudSpecularIntensity: { value: this.params.cloudSpecularIntensity },

        uRoofMap: { value: null },
        uRoofMaskEnabled: { value: 0.0 },
        uSceneBounds: { value: new THREE.Vector4(0, 0, 1, 1) },

        uHasCloudShadowMap: { value: false },
        uCloudShadowMap: { value: null },
        uScreenSize: { value: new THREE.Vector2(1, 1) },

        // Foundry scene darkness (0 = light, 1 = dark)
        uDarknessLevel: { value: 0.0 },

        // Foundry ambient environment colors (linear RGB), approximated
        // from canvas.environment.colors when available. These are used
        // to tint the base albedo so our "neutral" scene brightness and
        // color temperature more closely match Foundry's PIXI pipeline.
        uAmbientDaylight: { value: new THREE.Color(1.0, 1.0, 1.0) },
        uAmbientDarkness: { value: new THREE.Color(0.14, 0.14, 0.28) },
        uAmbientBrightest: { value: new THREE.Color(1.0, 1.0, 1.0) },

        // Dynamic Lights
        numLights: { value: 0 },
        lightPosition: { value: new Float32Array(this.maxLights * 3) },
        lightColor: { value: new Float32Array(this.maxLights * 3) },
        lightConfig: { value: new Float32Array(this.maxLights * 4) }
      },
      
      vertexShader: this.getVertexShader(),
      fragmentShader: this.getFragmentShader(),
      
      side: THREE.DoubleSide,
      transparent: false
    });
    
    log.debug('PBR material created');
    
    // Initial sync of light data to the new material
    this.updateLightUniforms();
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
    if (!this.material) return;
    
    const lightsArray = Array.from(this.lights.values());
    const num = lightsArray.length;
    
    this.material.uniforms.numLights.value = num;
    
    const lightPos = this.material.uniforms.lightPosition.value;
    const lightCol = this.material.uniforms.lightColor.value;
    const lightCfg = this.material.uniforms.lightConfig.value;

    // Pixels per distance unit
    const pixelsPerUnit = canvas.dimensions.size / canvas.dimensions.distance;

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

  /**
   * Update effect state (called every frame before render)
   * @param {TimeInfo} timeInfo - Centralized time information
   */
  update(timeInfo) {
    if (!this.material) return;
    
    // Validate shader uniforms periodically (every 60 frames)
    if (timeInfo.frameCount % 60 === 0) {
      this.validateShaderState(timeInfo);
    }
    
    // Update time uniform for animation
    this.material.uniforms.uTime.value = timeInfo.elapsed;
    
    // Update uniforms from parameters
    this.material.uniforms.uSpecularIntensity.value = this.params.intensity;
    this.material.uniforms.uRoughness.value = this.params.roughness;
    
    // Update light direction
    this.material.uniforms.uLightDirection.value.set(
      this.params.lightDirection.x,
      this.params.lightDirection.y,
      this.params.lightDirection.z
    ).normalize();
    
    // Update light color
    this.material.uniforms.uLightColor.value.set(
      this.params.lightColor.r,
      this.params.lightColor.g,
      this.params.lightColor.b
    );
    
    // Update stripe parameters
    this.material.uniforms.uStripeEnabled.value = this.params.stripeEnabled;
    this.material.uniforms.uStripeBlendMode.value = this.params.stripeBlendMode;
    this.material.uniforms.uParallaxStrength.value = this.params.parallaxStrength;
    this.material.uniforms.uStripeMaskThreshold.value = this.params.stripeMaskThreshold;
    
    // Update sparkle parameters
    this.material.uniforms.uSparkleEnabled.value = this.params.sparkleEnabled;
    this.material.uniforms.uSparkleIntensity.value = this.params.sparkleIntensity;
    this.material.uniforms.uSparkleScale.value = this.params.sparkleScale;
    this.material.uniforms.uSparkleSpeed.value = this.params.sparkleSpeed;

    // Outdoor cloud specular
    if (this.material.uniforms.uOutdoorCloudSpecularEnabled) {
      this.material.uniforms.uOutdoorCloudSpecularEnabled.value = this.params.outdoorCloudSpecularEnabled;
      this.material.uniforms.uOutdoorStripeBlend.value = this.params.outdoorStripeBlend;
      this.material.uniforms.uCloudSpecularIntensity.value = this.params.cloudSpecularIntensity;
    }
    
    // Layer 1
    this.material.uniforms.uStripe1Enabled.value   = this.params.stripe1Enabled;
    this.material.uniforms.uStripe1Frequency.value = this.params.stripe1Frequency;
    this.material.uniforms.uStripe1Speed.value     = this.params.stripe1Speed;
    this.material.uniforms.uStripe1Angle.value     = this.params.stripe1Angle;
    this.material.uniforms.uStripe1Width.value     = this.params.stripe1Width;
    this.material.uniforms.uStripe1Intensity.value = this.params.stripe1Intensity;
    this.material.uniforms.uStripe1Parallax.value  = this.params.stripe1Parallax;
    this.material.uniforms.uStripe1Wave.value      = this.params.stripe1Wave;
    this.material.uniforms.uStripe1Gaps.value      = this.params.stripe1Gaps;
    this.material.uniforms.uStripe1Softness.value  = this.params.stripe1Softness;
    
    // Layer 2
    this.material.uniforms.uStripe2Enabled.value   = this.params.stripe2Enabled;
    this.material.uniforms.uStripe2Frequency.value = this.params.stripe2Frequency;
    this.material.uniforms.uStripe2Speed.value     = this.params.stripe2Speed;
    this.material.uniforms.uStripe2Angle.value     = this.params.stripe2Angle;
    this.material.uniforms.uStripe2Width.value     = this.params.stripe2Width;
    this.material.uniforms.uStripe2Intensity.value = this.params.stripe2Intensity;
    this.material.uniforms.uStripe2Parallax.value  = this.params.stripe2Parallax;
    this.material.uniforms.uStripe2Wave.value      = this.params.stripe2Wave;
    this.material.uniforms.uStripe2Gaps.value      = this.params.stripe2Gaps;
    this.material.uniforms.uStripe2Softness.value  = this.params.stripe2Softness;
    
    // Layer 3
    this.material.uniforms.uStripe3Enabled.value   = this.params.stripe3Enabled;
    this.material.uniforms.uStripe3Frequency.value = this.params.stripe3Frequency;
    this.material.uniforms.uStripe3Speed.value     = this.params.stripe3Speed;
    this.material.uniforms.uStripe3Angle.value     = this.params.stripe3Angle;
    this.material.uniforms.uStripe3Width.value     = this.params.stripe3Width;
    this.material.uniforms.uStripe3Intensity.value = this.params.stripe3Intensity;
    this.material.uniforms.uStripe3Parallax.value  = this.params.stripe3Parallax;
    this.material.uniforms.uStripe3Wave.value      = this.params.stripe3Wave;
    this.material.uniforms.uStripe3Gaps.value      = this.params.stripe3Gaps;
    this.material.uniforms.uStripe3Softness.value  = this.params.stripe3Softness;

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
        this.material.uniforms.uDarknessLevel.value = darkness;
      }

      const colors = env?.colors;
      if (colors) {
        const uniforms = this.material.uniforms;

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

        applyColor(colors.ambientDaylight,  uniforms.uAmbientDaylight.value);
        applyColor(colors.ambientDarkness,  uniforms.uAmbientDarkness.value);
        applyColor(colors.ambientBrightest, uniforms.uAmbientBrightest.value);
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
    if (!this.material) return;
    
    // Update camera position for view-dependent effects
    // Safety check: ensure camera position is valid
    if (isFinite(camera.position.x) && isFinite(camera.position.y) && isFinite(camera.position.z)) {
      this.material.uniforms.uCameraPosition.value.copy(camera.position);
    } else {
      log.warn('Camera position contains NaN/Infinity, using fallback');
      this.material.uniforms.uCameraPosition.value.set(0, 0, 100);
    }
    
    // Update uCameraOffset for parallax effects
    if (camera.isPerspectiveCamera) {
      // For perspective camera, use camera position as offset
      this.material.uniforms.uCameraOffset.value.set(camera.position.x, camera.position.y);
    } else if (camera.isOrthographicCamera) {
      // For orthographic cameras, track the frustum center (actual pan position)
      const centerX = (camera.left + camera.right) / 2;
      const centerY = (camera.top + camera.bottom) / 2;
      this.material.uniforms.uCameraOffset.value.set(centerX, centerY);
    }

    // Bind CloudEffect shadow texture for sun-break specular boost.
    // This must run every frame because CloudEffect renders to an internal
    // render target which may be recreated/resized.
    try {
      const THREE = window.THREE;
      if (THREE && this.material.uniforms.uScreenSize) {
        if (!this._tempScreenSize) this._tempScreenSize = new THREE.Vector2();
        renderer.getDrawingBufferSize(this._tempScreenSize);
        this.material.uniforms.uScreenSize.value.set(this._tempScreenSize.x, this._tempScreenSize.y);

        const mm = window.MapShine?.maskManager;
        const tex = mm ? mm.getTexture('cloudShadow.screen') : null;
        let hasCloud = !!tex;

        if (!tex) {
          const cloud = window.MapShine?.cloudEffect;
          const fallbackTex = cloud?.cloudShadowTarget?.texture || null;
          hasCloud = !!(cloud && cloud.enabled && fallbackTex);
          if (this.material.uniforms.uCloudShadowMap) {
            this.material.uniforms.uCloudShadowMap.value = hasCloud ? fallbackTex : null;
          }
          if (this.material.uniforms.uHasCloudShadowMap) {
            this.material.uniforms.uHasCloudShadowMap.value = hasCloud;
          }
        }

        if (this.material.uniforms.uHasCloudShadowMap) {
          this.material.uniforms.uHasCloudShadowMap.value = hasCloud;
        }
        if (this.material.uniforms.uCloudShadowMap) {
          this.material.uniforms.uCloudShadowMap.value = hasCloud ? (tex || this.material.uniforms.uCloudShadowMap.value) : null;
        }

        if (this.material.uniforms.uRoofMap && this.material.uniforms.uRoofMaskEnabled && this.material.uniforms.uSceneBounds) {
          const roofTex = weatherController?.roofMap || null;
          this.material.uniforms.uRoofMap.value = roofTex;
          this.material.uniforms.uRoofMaskEnabled.value = roofTex ? 1.0 : 0.0;

          const d = typeof canvas !== 'undefined' ? canvas?.dimensions : null;
          if (d) {
            const sx = d.sceneX ?? 0;
            const sy = d.sceneY ?? 0;
            const sw = d.sceneWidth ?? d.width ?? 1;
            const sh = d.sceneHeight ?? d.height ?? 1;
            this.material.uniforms.uSceneBounds.value.set(sx, sy, sw, sh);
          }
        }
      }
    } catch (e) {
      if (this.material.uniforms.uHasCloudShadowMap) this.material.uniforms.uHasCloudShadowMap.value = false;
      if (this.material.uniforms.uCloudShadowMap) this.material.uniforms.uCloudShadowMap.value = null;
      if (this.material.uniforms.uRoofMap) this.material.uniforms.uRoofMap.value = null;
      if (this.material.uniforms.uRoofMaskEnabled) this.material.uniforms.uRoofMaskEnabled.value = 0.0;
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
    
    const result = ShaderValidator.validateMaterialUniforms(this.material);
    
    if (!result.valid) {
      this.validationErrors = result.errors;
      log.error('Shader validation failed:', result.errors);
      
      // Show user-facing error
      if (ui?.notifications) {
        ui.notifications.error('Map Shine: Invalid shader state detected. Check console or reset to defaults.');
      }
    } else {
      // Clear errors on success
      if (this.validationErrors.length > 0) {
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
    return {
      valid: this.validationErrors.length === 0,
      errors: this.validationErrors
    };
  }

  /**
   * Dispose resources
   */
  dispose() {
    Hooks.off('createAmbientLight', this.onLightCreatedBound);
    Hooks.off('updateAmbientLight', this.onLightUpdatedBound);
    Hooks.off('deleteAmbientLight', this.onLightDeletedBound);

    if (this.material) {
      this.material.dispose();
      this.material = null;
    }
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
      
      uniform float uSpecularIntensity;
      uniform float uRoughness;
      
      uniform vec3 uLightDirection;
      uniform vec3 uLightColor;
      uniform vec3 uCameraPosition;
      uniform vec2 uCameraOffset; // Orthographic camera pan offset
      
      // Time
      uniform float uTime;
      
      // Multi-layer stripe system
      uniform bool uStripeEnabled;
      uniform float uStripeBlendMode;
      uniform float uParallaxStrength;
      uniform float uStripeMaskThreshold;
      
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
       * @param uv - Base UV coordinates
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
          vec2 offset = uCameraOffset * parallaxDepth * parallaxStrength * 0.0005;
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
        if (!uEffectEnabled) {
          // Tint the base albedo by the ambient environment so the Three.js
          // base plane lives in roughly the same color/brightness space as
          // Foundry's background lighting pass.
          vec3 baseAlbedo = albedo.rgb * ambientTint;
          gl_FragColor = vec4(baseAlbedo, albedo.a);
          return;
        }
        
        // ---------------------------------------------------------
        // Dynamic Lighting Calculation (Falloff Only)
        // ---------------------------------------------------------
        vec3 totalDynamicLight = vec3(0.0);
        
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
        
        vec4 specularMask = texture2D(uSpecularMap, vUv);
        float roughness = uHasRoughnessMap ? texture2D(uRoughnessMap, vUv).r : uRoughness;
        
        // Calculate specular mask strength (luminance of the colored mask)
        float specularStrength = dot(specularMask.rgb, vec3(0.299, 0.587, 0.114));

        // Cloud lighting (1.0 = lit gap, 0.0 = shadow) sampled in screen-space.
        // Default to fully lit if texture is unavailable.
        float cloudLit = 1.0;
        if (uHasCloudShadowMap) {
          vec2 screenUv0 = gl_FragCoord.xy / max(uScreenSize, vec2(1.0));
          cloudLit = texture2D(uCloudShadowMap, screenUv0).r;
        }
        
        // Multi-layer stripe composition
        float stripeMaskAnimated = 0.0;
        
        if (uStripeEnabled) {
          // Generate each stripe layer
          float layer1 = 0.0;
          float layer2 = 0.0;
          float layer3 = 0.0;
          
          if (uStripe1Enabled) {
            layer1 = generateStripeLayer(
              vUv, vWorldPosition, uCameraPosition, uTime, 
              uStripe1Frequency, uStripe1Speed, uStripe1Angle, 
              uStripe1Width, uStripe1Parallax, uParallaxStrength,
              uStripe1Wave, uStripe1Gaps, uStripe1Softness
            ) * uStripe1Intensity;
          }
          
          if (uStripe2Enabled) {
            layer2 = generateStripeLayer(
              vUv, vWorldPosition, uCameraPosition, uTime, 
              uStripe2Frequency, uStripe2Speed, uStripe2Angle, 
              uStripe2Width, uStripe2Parallax, uParallaxStrength,
              uStripe2Wave, uStripe2Gaps, uStripe2Softness
            ) * uStripe2Intensity;
          }
          
          if (uStripe3Enabled) {
            layer3 = generateStripeLayer(
              vUv, vWorldPosition, uCameraPosition, uTime, 
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
          // Generate sparkles based on UV and time
          sparkleVal = sparkleNoise(vUv, uSparkleScale, uTime, uSparkleSpeed);
          
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

        float outdoorFactor = 1.0;
        if (uRoofMaskEnabled > 0.5) {
          float u = (vWorldPosition.x - uSceneBounds.x) / max(1e-5, uSceneBounds.z);
          float v = (vWorldPosition.y - uSceneBounds.y) / max(1e-5, uSceneBounds.w);
          v = 1.0 - v;
          vec2 roofUv = clamp(vec2(u, v), 0.0, 1.0);
          outdoorFactor = texture2D(uRoofMap, roofUv).r;
        }
        
        if (uOutdoorCloudSpecularEnabled && uHasCloudShadowMap) {
          // Cloud lit areas get bright specular (reflecting sky)
          cloudSpecular = cloudLit * uCloudSpecularIntensity * outdoorFactor;
          
          // Blend stripes: outdoors stripes are reduced, clouds dominate
          // At outdoorStripeBlend=0: stripes contribute nothing outdoors
          // At outdoorStripeBlend=1: stripes contribute fully (like indoors)
          stripeContribution *= mix(1.0, uOutdoorStripeBlend, outdoorFactor);
        }
        
        // Combine: base 1.0 + stripe contribution + cloud specular + sparkles
        float totalModulator = 1.0 + stripeContribution + cloudSpecular + (sparkleVal * uSparkleIntensity);

        // Global stripe brightness threshold: only allow shine on the
        // brightest parts of the specular mask. 0 = full mask, 1 = only
        // near-white texels.
        if (uStripeMaskThreshold > 0.0) {
          float thresholdMask = smoothstep(uStripeMaskThreshold, 1.0, specularStrength);
          totalModulator *= thresholdMask;
        }
        
        // For 2.5D top-down: specular mask directly defines shine areas
        // The colored mask defines WHERE and WHAT COLOR things shine.
        // We modulate by totalIncidentLight to ensure we don't shine in darkness.
        // uLightColor is preserved as a manual tint/multiplier.
        vec3 specularColor = specularMask.rgb * totalModulator * uSpecularIntensity * uLightColor * totalIncidentLight;
        
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
        
        // Specular is already lit by totalIncidentLight (which includes ambient + dynamic)
        vec3 litSpecular = specularColor;

        // Simple additive composition: base + specular
        vec3 finalColor = litAlbedo + litSpecular;
        
        // Debug visualization (uncomment to see components)
        // finalColor = vec3(stripeMask); // Show stripe pattern only
        // finalColor = vec3(layer1); // Show layer 1 only
        // finalColor = vec3(layer2); // Show layer 2 only
        // finalColor = vec3(layer3); // Show layer 3 only
        // finalColor = specularMask.rgb; // Show specular mask only

        // Apply tone mapping to compress bright highlights and avoid clipping
        finalColor = reinhardJodie(finalColor);
        
        gl_FragColor = vec4(finalColor, albedo.a);
      }
    `;
  }
}
