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
      intensity: 0.5,           // Reduced from 2.0 to avoid overexposure
      roughness: 0.3,
      metallic: 0.0,
      lightDirection: { x: 0.6, y: 0.4, z: 0.7 },
      lightColor: { r: 1.0, g: 1.0, b: 1.0 },
      ambientIntensity: 0.2,
      
      // Multi-layer stripe system
      stripeEnabled: true,
      stripeBlendMode: 0,       // 0=Add, 1=Multiply, 2=Screen, 3=Overlay
      parallaxStrength: 1.0,    // Global parallax intensity multiplier
      
      // Layer 1 - Primary stripes
      stripe1Enabled: true,
      stripe1Frequency: 4.0,
      stripe1Speed: 0.15,
      stripe1Angle: 45.0,
      stripe1Width: 0.4,
      stripe1Intensity: 0.5,
      stripe1Parallax: 0.0,     // Parallax offset (0 = no parallax)
      
      // Layer 2 - Secondary stripes
      stripe2Enabled: false,
      stripe2Frequency: 8.0,
      stripe2Speed: -0.1,       // Negative = opposite direction
      stripe2Angle: 135.0,
      stripe2Width: 0.3,
      stripe2Intensity: 0.3,
      stripe2Parallax: 0.5,
      
      // Layer 3 - Tertiary stripes
      stripe3Enabled: false,
      stripe3Frequency: 2.0,
      stripe3Speed: 0.08,
      stripe3Angle: 90.0,
      stripe3Width: 0.5,
      stripe3Intensity: 0.2,
      stripe3Parallax: 1.0
    };
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
          name: 'material',
          label: 'Material Properties',
          type: 'inline', // Controls shown directly (not in nested folder)
          parameters: ['intensity', 'roughness', 'metallic', 'ambientIntensity']
        },
        {
          name: 'stripe-settings',
          label: 'Stripe Settings',
          type: 'inline',
          separator: true, // Add separator before this group
          parameters: ['stripeEnabled', 'stripeBlendMode', 'parallaxStrength']
        },
        {
          name: 'layer1',
          label: 'Layer 1',
          type: 'folder', // Nested collapsible folder
          separator: true,
          expanded: false,
          parameters: ['stripe1Enabled', 'stripe1Frequency', 'stripe1Speed', 'stripe1Angle', 'stripe1Width', 'stripe1Intensity', 'stripe1Parallax']
        },
        {
          name: 'layer2',
          label: 'Layer 2',
          type: 'folder',
          expanded: false,
          parameters: ['stripe2Enabled', 'stripe2Frequency', 'stripe2Speed', 'stripe2Angle', 'stripe2Width', 'stripe2Intensity', 'stripe2Parallax']
        },
        {
          name: 'layer3',
          label: 'Layer 3',
          type: 'folder',
          expanded: false,
          parameters: ['stripe3Enabled', 'stripe3Frequency', 'stripe3Speed', 'stripe3Angle', 'stripe3Width', 'stripe3Intensity', 'stripe3Parallax']
        }
      ],
      parameters: {
        intensity: {
          type: 'slider',
          label: 'Shine Intensity',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.5,
          throttle: 100
        },
        roughness: {
          type: 'slider',
          label: 'Roughness',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.3,
          throttle: 100
        },
        metallic: {
          type: 'slider',
          label: 'Metallic',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.0,
          throttle: 100
        },
        ambientIntensity: {
          type: 'slider',
          label: 'Ambient Light',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.2,
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
        parallaxStrength: {
          type: 'slider',
          label: 'Parallax Strength',
          min: 0,
          max: 2,
          step: 0.1,
          default: 1.0,
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
          default: 4.0,
          throttle: 100
        },
        stripe1Speed: {
          type: 'slider',
          label: 'Layer 1 Speed',
          min: -1,
          max: 1,
          step: 0.01,
          default: 0.15,
          throttle: 100
        },
        stripe1Angle: {
          type: 'slider',
          label: 'Layer 1 Angle',
          min: 0,
          max: 360,
          step: 1,
          default: 45,
          throttle: 100
        },
        stripe1Width: {
          type: 'slider',
          label: 'Layer 1 Width',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.4,
          throttle: 100
        },
        stripe1Intensity: {
          type: 'slider',
          label: 'Layer 1 Intensity',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.5,
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
        stripe2Enabled: {
          type: 'boolean',
          label: 'Layer 2 Enabled',
          default: false
        },
        stripe2Frequency: {
          type: 'slider',
          label: 'Layer 2 Frequency',
          min: 0.5,
          max: 20,
          step: 0.5,
          default: 8.0,
          throttle: 100
        },
        stripe2Speed: {
          type: 'slider',
          label: 'Layer 2 Speed',
          min: -1,
          max: 1,
          step: 0.01,
          default: -0.1,
          throttle: 100
        },
        stripe2Angle: {
          type: 'slider',
          label: 'Layer 2 Angle',
          min: 0,
          max: 360,
          step: 1,
          default: 135,
          throttle: 100
        },
        stripe2Width: {
          type: 'slider',
          label: 'Layer 2 Width',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.3,
          throttle: 100
        },
        stripe2Intensity: {
          type: 'slider',
          label: 'Layer 2 Intensity',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.3,
          throttle: 100
        },
        stripe2Parallax: {
          type: 'slider',
          label: 'Layer 2 Parallax',
          min: -2,
          max: 2,
          step: 0.1,
          default: 0.5,
          throttle: 100
        },
        stripe3Enabled: {
          type: 'boolean',
          label: 'Layer 3 Enabled',
          default: false
        },
        stripe3Frequency: {
          type: 'slider',
          label: 'Layer 3 Frequency',
          min: 0.5,
          max: 20,
          step: 0.5,
          default: 2.0,
          throttle: 100
        },
        stripe3Speed: {
          type: 'slider',
          label: 'Layer 3 Speed',
          min: -1,
          max: 1,
          step: 0.01,
          default: 0.08,
          throttle: 100
        },
        stripe3Angle: {
          type: 'slider',
          label: 'Layer 3 Angle',
          min: 0,
          max: 360,
          step: 1,
          default: 90,
          throttle: 100
        },
        stripe3Width: {
          type: 'slider',
          label: 'Layer 3 Width',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.5,
          throttle: 100
        },
        stripe3Intensity: {
          type: 'slider',
          label: 'Layer 3 Intensity',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.2,
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
        uAmbientIntensity: { value: this.params.ambientIntensity },
        
        // Camera
        uCameraPosition: { value: new THREE.Vector3() },
        uCameraOffset: { value: new THREE.Vector2(0, 0) }, // Orthographic camera pan offset
        
        // Time (for animation)
        uTime: { value: 0.0 },
        
        // Multi-layer stripe system
        uStripeEnabled: { value: this.params.stripeEnabled },
        uStripeBlendMode: { value: this.params.stripeBlendMode },
        uParallaxStrength: { value: this.params.parallaxStrength },
        
        // Layer 1
        uStripe1Enabled: { value: this.params.stripe1Enabled },
        uStripe1Frequency: { value: this.params.stripe1Frequency },
        uStripe1Speed: { value: this.params.stripe1Speed },
        uStripe1Angle: { value: this.params.stripe1Angle },
        uStripe1Width: { value: this.params.stripe1Width },
        uStripe1Intensity: { value: this.params.stripe1Intensity },
        uStripe1Parallax: { value: this.params.stripe1Parallax },
        
        // Layer 2
        uStripe2Enabled: { value: this.params.stripe2Enabled },
        uStripe2Frequency: { value: this.params.stripe2Frequency },
        uStripe2Speed: { value: this.params.stripe2Speed },
        uStripe2Angle: { value: this.params.stripe2Angle },
        uStripe2Width: { value: this.params.stripe2Width },
        uStripe2Intensity: { value: this.params.stripe2Intensity },
        uStripe2Parallax: { value: this.params.stripe2Parallax },
        
        // Layer 3
        uStripe3Enabled: { value: this.params.stripe3Enabled },
        uStripe3Frequency: { value: this.params.stripe3Frequency },
        uStripe3Speed: { value: this.params.stripe3Speed },
        uStripe3Angle: { value: this.params.stripe3Angle },
        uStripe3Width: { value: this.params.stripe3Width },
        uStripe3Intensity: { value: this.params.stripe3Intensity },
        uStripe3Parallax: { value: this.params.stripe3Parallax },
        
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
    this.material.uniforms.uMetallic.value = this.params.metallic;
    this.material.uniforms.uAmbientIntensity.value = this.params.ambientIntensity;
    
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
    
    // Layer 1
    this.material.uniforms.uStripe1Enabled.value = this.params.stripe1Enabled;
    this.material.uniforms.uStripe1Frequency.value = this.params.stripe1Frequency;
    this.material.uniforms.uStripe1Speed.value = this.params.stripe1Speed;
    this.material.uniforms.uStripe1Angle.value = this.params.stripe1Angle;
    this.material.uniforms.uStripe1Width.value = this.params.stripe1Width;
    this.material.uniforms.uStripe1Intensity.value = this.params.stripe1Intensity;
    this.material.uniforms.uStripe1Parallax.value = this.params.stripe1Parallax;
    
    // Layer 2
    this.material.uniforms.uStripe2Enabled.value = this.params.stripe2Enabled;
    this.material.uniforms.uStripe2Frequency.value = this.params.stripe2Frequency;
    this.material.uniforms.uStripe2Speed.value = this.params.stripe2Speed;
    this.material.uniforms.uStripe2Angle.value = this.params.stripe2Angle;
    this.material.uniforms.uStripe2Width.value = this.params.stripe2Width;
    this.material.uniforms.uStripe2Intensity.value = this.params.stripe2Intensity;
    this.material.uniforms.uStripe2Parallax.value = this.params.stripe2Parallax;
    
    // Layer 3
    this.material.uniforms.uStripe3Enabled.value = this.params.stripe3Enabled;
    this.material.uniforms.uStripe3Frequency.value = this.params.stripe3Frequency;
    this.material.uniforms.uStripe3Speed.value = this.params.stripe3Speed;
    this.material.uniforms.uStripe3Angle.value = this.params.stripe3Angle;
    this.material.uniforms.uStripe3Width.value = this.params.stripe3Width;
    this.material.uniforms.uStripe3Intensity.value = this.params.stripe3Intensity;
    this.material.uniforms.uStripe3Parallax.value = this.params.stripe3Parallax;
    
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
    this.material.uniforms.uCameraPosition.value.copy(camera.position);
    
    // For orthographic cameras, track the frustum center (actual pan position)
    if (camera.isOrthographicCamera) {
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
      
      uniform float uSpecularIntensity;
      uniform float uRoughness;
      uniform float uMetallic;
      
      uniform vec3 uLightDirection;
      uniform vec3 uLightColor;
      uniform float uAmbientIntensity;
      uniform vec3 uCameraPosition;
      uniform vec2 uCameraOffset; // Orthographic camera pan offset
      
      // Time
      uniform float uTime;
      
      // Multi-layer stripe system
      uniform bool uStripeEnabled;
      uniform float uStripeBlendMode;
      uniform float uParallaxStrength;
      
      // Layer 1
      uniform bool uStripe1Enabled;
      uniform float uStripe1Frequency;
      uniform float uStripe1Speed;
      uniform float uStripe1Angle;
      uniform float uStripe1Width;
      uniform float uStripe1Intensity;
      uniform float uStripe1Parallax;
      
      // Layer 2
      uniform bool uStripe2Enabled;
      uniform float uStripe2Frequency;
      uniform float uStripe2Speed;
      uniform float uStripe2Angle;
      uniform float uStripe2Width;
      uniform float uStripe2Intensity;
      uniform float uStripe2Parallax;
      
      // Layer 3
      uniform bool uStripe3Enabled;
      uniform float uStripe3Frequency;
      uniform float uStripe3Speed;
      uniform float uStripe3Angle;
      uniform float uStripe3Width;
      uniform float uStripe3Intensity;
      uniform float uStripe3Parallax;
      
      // Foundry scene darkness (0 = light, 1 = dark)
      uniform float uDarknessLevel;
      
      varying vec2 vUv;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPosition;
      
      // Simple 1D noise function for stripe variation
      float noise1D(float p) {
        return fract(sin(p * 127.1) * 43758.5453);
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
        float parallaxStrength
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
        
        // Add subtle noise variation to width for organic feel
        float noiseVal = noise1D(floor(pos)) * 0.5 + 0.5;
        float widthMod = width * (0.8 + noiseVal * 0.4);
        
        // Create stripe with smooth edges using dual smoothstep
        // This creates a band that's bright in the middle and fades at edges
        float edgeSoftness = 0.1;
        float stripePattern = smoothstep(widthMod, widthMod + edgeSoftness, stripe) * 
                              smoothstep(1.0 - widthMod, 1.0 - widthMod - edgeSoftness, stripe);
        
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
              uStripe1Width, uStripe1Parallax, uParallaxStrength
            ) * uStripe1Intensity;
          }
          
          if (uStripe2Enabled) {
            layer2 = generateStripeLayer(
              vUv, vWorldPosition, uCameraPosition, uTime, 
              uStripe2Frequency, uStripe2Speed, uStripe2Angle, 
              uStripe2Width, uStripe2Parallax, uParallaxStrength
            ) * uStripe2Intensity;
          }
          
          if (uStripe3Enabled) {
            layer3 = generateStripeLayer(
              vUv, vWorldPosition, uCameraPosition, uTime, 
              uStripe3Frequency, uStripe3Speed, uStripe3Angle, 
              uStripe3Width, uStripe3Parallax, uParallaxStrength
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
        
        // For 2.5D top-down: specular mask directly defines shine areas
        // The colored mask defines WHERE and WHAT COLOR things shine
        vec3 specularColor = specularMask.rgb * stripeContribution * uSpecularIntensity * uLightColor;
        
        // Apply Foundry darkness level with different falloff curves
        float lightLevel = 1.0 - uDarknessLevel;
        
        // Linear falloff for albedo (base texture)
        float albedoBrightness = lightLevel;
        
        // Slower falloff curve for specular (gentler fade)
        float specularBrightness = sqrt(lightLevel);
        
        // Apply brightness multipliers
        vec3 litAlbedo = albedo.rgb * albedoBrightness;
        vec3 litSpecular = specularColor * specularBrightness;
        
        // Final composition (additive specular)
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
