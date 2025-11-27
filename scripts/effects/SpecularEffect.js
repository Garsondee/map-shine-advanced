/**
 * @fileoverview Specular highlight effect using PBR lighting
 * First effect implementation - demonstrates masked texture + custom shader
 * @module effects/SpecularEffect
 */

import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import { ShaderValidator } from '../core/shader-validator.js';

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
    
    // Effect parameters (exposed to Tweakpane later)
    this.params = {
      // Status
      textureStatus: 'Searching...',
      hasSpecularMask: false,

      intensity: 0.6,           // Default shine intensity
      roughness: 0.0,
      lightDirection: { x: 0.6, y: 0.4, z: 0.7 },
      lightColor: { r: 1.0, g: 1.0, b: 1.0 },
      
      // Multi-layer stripe system
      stripeEnabled: true,
      stripeBlendMode: 2,       // 0=Add, 1=Multiply, 2=Screen, 3=Overlay
      parallaxStrength: 1.5,    // Global parallax intensity multiplier
      stripeMaskThreshold: 0.10, // 0 = all mask, 1 = only brightest texels
      
      // Layer 1 - Primary stripes
      stripe1Enabled: true,
      stripe1Frequency: 12.0,
      stripe1Speed: -0.01,
      stripe1Angle: 115.0,
      stripe1Width: 0.47,
      stripe1Intensity: 1.43,
      stripe1Parallax: 0.0,     // Parallax offset (0 = no parallax)
      stripe1Wave: 1.7,         // Stripe waviness amount
      stripe1Gaps: 0.31,        // Stripe breakup / shiny spots
      stripe1Softness: 3.17,    // Stripe edge softness (0=hard,5=very soft)
      
      // Layer 2 - Secondary stripes
      stripe2Enabled: true,
      stripe2Frequency: 10.5,
      stripe2Speed: -0.02,      // Negative = opposite direction
      stripe2Angle: 111.0,
      stripe2Width: 0.73,
      stripe2Intensity: 1.54,
      stripe2Parallax: 0.1,
      stripe2Wave: 1.6,
      stripe2Gaps: 0.5,
      stripe2Softness: 3.93,
      
      // Layer 3 - Tertiary stripes
      stripe3Enabled: true,
      stripe3Frequency: 11.5,
      stripe3Speed: 0.29,
      stripe3Angle: 162.0,
      stripe3Width: 0.24,
      stripe3Intensity: 3.01,
      stripe3Parallax: 1.0,
      stripe3Wave: 1.1,
      stripe3Gaps: 0.37,
      stripe3Softness: 3.44,

      // Micro Sparkle
      sparkleEnabled: false,
      sparkleIntensity: 0.5,
      sparkleScale: 50.0,
      sparkleSpeed: 0.5
    };
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
        }
      ],
      parameters: {
        hasSpecularMask: {
          type: 'boolean',
          default: false
        },
        textureStatus: {
          type: 'string',
          label: 'Mask Status',
          default: 'Checking...',
          readonly: true
        },
        intensity: {
          type: 'slider',
          label: 'Shine Intensity',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.7,
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
          default: 2
        },
        stripeMaskThreshold: {
          type: 'slider',
          label: 'Stripe Brightness Threshold',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.10,
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
          default: 12.0,
          throttle: 100
        },
        stripe1Speed: {
          type: 'slider',
          label: 'Layer 1 Speed',
          min: -1,
          max: 1,
          step: 0.01,
          default: -0.01,
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
          default: 0.47,
          throttle: 100
        },
        stripe1Intensity: {
          type: 'slider',
          label: 'Layer 1 Intensity',
          min: 0,
          max: 5,
          step: 0.01,
          default: 1.43,
          throttle: 100
        },
        stripe1Parallax: {
          type: 'slider',
          label: 'Layer 1 Parallax',
          min: -2,
          max: 2,
          step: 0.1,
          default: 0.0,
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
          default: 3.17,
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
          default: 10.5,
          throttle: 100
        },
        stripe2Speed: {
          type: 'slider',
          label: 'Layer 2 Speed',
          min: -1,
          max: 1,
          step: 0.01,
          default: -0.02,
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
          default: 0.73,
          throttle: 100
        },
        stripe2Intensity: {
          type: 'slider',
          label: 'Layer 2 Intensity',
          min: 0,
          max: 5,
          step: 0.01,
          default: 1.54,
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
          default: 11.5,
          throttle: 100
        },
        stripe3Speed: {
          type: 'slider',
          label: 'Layer 3 Speed',
          min: -1,
          max: 1,
          step: 0.01,
          default: 0.29,
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
          default: 0.24,
          throttle: 100
        },
        stripe3Intensity: {
          type: 'slider',
          label: 'Layer 3 Intensity',
          min: 0,
          max: 5,
          step: 0.01,
          default: 3.01,
          throttle: 100
        },
        stripe3Parallax: {
          type: 'slider',
          label: 'Layer 3 Parallax',
          min: -2,
          max: 2,
          step: 0.1,
          default: 1.0,
          throttle: 100
        },
        stripe3Wave: {
          type: 'slider',
          label: 'Layer 3 Wave',
          min: 0,
          max: 2,
          step: 0.1,
          default: 1.1,
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
          label: 'Enable Sparkles',
          default: false
        },
        sparkleIntensity: {
          type: 'slider',
          label: 'Sparkle Intensity',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.8,
          throttle: 100
        },
        sparkleScale: {
          type: 'slider',
          label: 'Sparkle Scale',
          min: 300,
          max: 8000,
          step: 1,
          default: 50.0,
          throttle: 100
        },
        sparkleSpeed: {
          type: 'slider',
          label: 'Sparkle Speed',
          min: 0,
          max: 5,
          step: 0.01,
          default: 0.5,
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
    this.createPBRMaterial(baseMesh.material.map);
    
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
    
    // Create shader material with custom GLSL
    // Track validation errors
    this.validationErrors = [];
    this.lastValidation = 0;
    
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        // Textures
        uAlbedoMap: { value: baseTexture },
        uSpecularMap: { value: this.specularMask },
        uRoughnessMap: { value: this.roughnessMask || baseTexture }, // Fallback to base texture
        uNormalMap: { value: this.normalMap || baseTexture }, // Fallback to base texture
        
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

        // Foundry scene darkness (0 = light, 1 = dark)
        uDarknessLevel: { value: 0.0 }
      },
      
      vertexShader: this.getVertexShader(),
      fragmentShader: this.getFragmentShader(),
      
      side: THREE.DoubleSide,
      transparent: false
    });
    
    log.debug('PBR material created');
  }

  /**
   * Update effect state (called every frame before render)
   * @param {TimeInfo} timeInfo - Centralized time information
   */
  update(timeInfo) {
    if (!this.material) return;
    
    // Validate shader uniforms periodically (every 60 frames)
    if (timeInfo.frameCount % 60 === 0) {
      this.validateShaderState();
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
    
    // Update Foundry darkness level
    if (canvas?.scene?.environment?.darknessLevel !== undefined) {
      this.material.uniforms.uDarknessLevel.value = canvas.scene.environment.darknessLevel;
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
    
    // Material is already applied to mesh, so normal scene render handles it
  }

  /**
   * Validate shader state for errors
   * @private
   */
  validateShaderState() {
    const now = performance.now();
    if (now - this.lastValidation < 1000) return; // Max once per second
    
    this.lastValidation = now;
    
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
      
      // Foundry scene darkness (0 = light, 1 = dark)
      uniform float uDarknessLevel;
      
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
          float waveNoise = snoise(parallaxUv * 2.0 + time * 0.1);
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
        float pos = rotUv.x * frequency + time * speed;
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
        float pulse = 0.9 + 0.1 * sin(time * 0.7 + frequency * 1.23);
        stripePattern *= pulse;

        // Apply gaps to break stripes into shiny spots
        if (gaps > 0.0) {
          float gapNoise = snoise(rotUv * 5.0 + time * 0.2);
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
      
      void main() {
        // Sample textures
        vec4 albedo = texture2D(uAlbedoMap, vUv);
        
        // Apply Foundry darkness level
        float lightLevel = 1.0 - uDarknessLevel;
        
        // If effect is disabled, just render the base albedo with standard lighting
        if (!uEffectEnabled) {
          gl_FragColor = vec4(albedo.rgb * lightLevel, albedo.a);
          return;
        }
        
        vec4 specularMask = texture2D(uSpecularMap, vUv);
        float roughness = uHasRoughnessMap ? texture2D(uRoughnessMap, vUv).r : uRoughness;
        
        // Calculate specular mask strength (luminance of the colored mask)
        float specularStrength = dot(specularMask.rgb, vec3(0.299, 0.587, 0.114));
        
        // Multi-layer stripe composition
        float stripeMask = 0.0;
        
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
          stripeMask = layer1;
          if (uStripe2Enabled) {
            stripeMask = blendMode(stripeMask, layer2, uStripeBlendMode);
          }
          if (uStripe3Enabled) {
            stripeMask = blendMode(stripeMask, layer3, uStripeBlendMode);
          }
        }
        
        // Combine stripe animation with base specular strength
        // stripeContribution modulates the specular intensity
        float stripeContribution = 1.0 + stripeMask;
        
        // Calculate sparkles
        float sparkleVal = 0.0;
        if (uSparkleEnabled) {
          // Generate sparkles based on UV and time
          sparkleVal = sparkleNoise(vUv, uSparkleScale, uTime, uSparkleSpeed);
          
          // Mask by specular strength so we don't sparkle on matte areas
          sparkleVal *= specularStrength;
        }
        
        // Add sparkles to the contribution
        float totalModulator = stripeContribution + (sparkleVal * uSparkleIntensity);

        // Global stripe brightness threshold: only allow shine on the
        // brightest parts of the specular mask. 0 = full mask, 1 = only
        // near-white texels.
        if (uStripeMaskThreshold > 0.0) {
          float thresholdMask = smoothstep(uStripeMaskThreshold, 1.0, specularStrength);
          totalModulator *= thresholdMask;
        }
        
        // For 2.5D top-down: specular mask directly defines shine areas
        // The colored mask defines WHERE and WHAT COLOR things shine
        vec3 specularColor = specularMask.rgb * totalModulator * uSpecularIntensity * uLightColor;
        
        // Apply Foundry darkness level with different falloff curves (reuse lightLevel defined earlier)
        
        // Linear falloff for albedo (base texture)
        float albedoBrightness = lightLevel;
        
        // Slower falloff curve for specular (gentler fade)
        float specularBrightness = sqrt(lightLevel);
        
        // Apply brightness multipliers
        vec3 litAlbedo = albedo.rgb * albedoBrightness;
        vec3 litSpecular = specularColor * specularBrightness;

        // Simple additive composition: base + specular
        vec3 finalColor = litAlbedo + litSpecular;
        
        // Debug visualization (uncomment to see components)
        // finalColor = vec3(stripeMask); // Show stripe pattern only
        // finalColor = vec3(layer1); // Show layer 1 only
        // finalColor = vec3(layer2); // Show layer 2 only
        // finalColor = vec3(layer3); // Show layer 3 only
        // finalColor = specularMask.rgb; // Show specular mask only

        gl_FragColor = vec4(finalColor, albedo.a);
      }
    `;
  }
}
