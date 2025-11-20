/**
 * @fileoverview Iridescence "Holographic Foil" effect
 * Adds a shimmering, multi-colored overlay based on screen-space and world-space coordinates
 * @module effects/IridescenceEffect
 */

import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import { ShaderValidator } from '../core/shader-validator.js';

const log = createLogger('IridescenceEffect');

/**
 * Iridescence effect implementation
 * Renders an additive overlay on top of the base mesh
 */
export class IridescenceEffect extends EffectBase {
  constructor() {
    super('iridescence', RenderLayers.SURFACE_EFFECTS, 'low');
    
    this.priority = 10; // Render early in surface layer
    this.alwaysRender = false;
    
    // Backing field for enabled property
    this._enabled = true;
    
    /** @type {THREE.Mesh|null} */
    this.mesh = null;
    
    /** @type {THREE.Mesh|null} */
    this.baseMesh = null;
    
    /** @type {THREE.Texture|null} */
    this.iridescenceMask = null;
    
    /** @type {THREE.ShaderMaterial|null} */
    this.material = null;
    
    // Effect parameters
    this.params = {
      // Status
      textureStatus: 'Searching...',
      hasIridescenceMask: false,

      // Core settings
      intensity: 1.0,
      distortionStrength: 0.5,
      noiseScale: 0.2,
      noiseType: 0, // 0=Smooth, 1=Glitter
      flowSpeed: 0.2,
      phaseMult: 1.0,
      angle: 45.0,
      parallaxStrength: 1.0,
      
      // Colors
      colorCycleSpeed: 1.0, // Multiplier for color cycling
      ignoreDarkness: 0.0, // 0=Physical, 1=Magical
      
      // Advanced
      alpha: 1.0 // Global opacity multiplier
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
   * Set enabled state and update visibility
   * @param {boolean} value - New enabled state
   */
  set enabled(value) {
    this._enabled = value;
    if (this.mesh) {
      this.mesh.visible = value;
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
          name: 'main',
          label: 'Effect Properties',
          type: 'inline',
          parameters: ['intensity', 'alpha', 'flowSpeed', 'parallaxStrength', 'angle']
        },
        {
          name: 'style',
          label: 'Style & Magic',
          type: 'inline',
          parameters: ['noiseType', 'ignoreDarkness', 'colorCycleSpeed']
        },
        {
          name: 'distortion',
          label: 'Distortion & Noise',
          type: 'folder',
          expanded: false,
          parameters: ['distortionStrength', 'noiseScale', 'phaseMult']
        }
      ],
      parameters: {
        hasIridescenceMask: {
          type: 'boolean',
          default: false,
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
          min: 0,
          max: 2,
          step: 0.01,
          default: 1.0
        },
        alpha: {
          type: 'slider',
          label: 'Opacity',
          min: 0,
          max: 1,
          step: 0.01,
          default: 1.0
        },
        noiseType: {
          type: 'list',
          label: 'Noise Type',
          options: {
            'Liquid (Smooth)': 0,
            'Glitter (Sand)': 1
          },
          default: 0
        },
        ignoreDarkness: {
          type: 'slider',
          label: 'Magic Glow',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.0
        },
        colorCycleSpeed: {
          type: 'slider',
          label: 'Color Cycle Speed',
          min: 0.1,
          max: 3.0,
          step: 0.05,
          default: 1.0
        },
        flowSpeed: {
          type: 'slider',
          label: 'Flow Speed',
          min: -2,
          max: 2,
          step: 0.01,
          default: 0.2
        },
        angle: {
          type: 'slider',
          label: 'Angle',
          min: 0,
          max: 360,
          step: 1,
          default: 45.0
        },
        distortionStrength: {
          type: 'slider',
          label: 'Distortion',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.5
        },
        noiseScale: {
          type: 'slider',
          label: 'Noise Scale',
          min: 0.01,
          max: 1.0,
          step: 0.01,
          default: 0.5
        },
        phaseMult: {
          type: 'slider',
          label: 'Phase Multiplier',
          min: 0.1,
          max: 10.0,
          step: 0.1,
          default: 1.0
        },
        parallaxStrength: {
          type: 'slider',
          label: 'Parallax Influence',
          min: 0.0,
          max: 3.0,
          step: 0.01,
          default: 1.0
        }
      },
      presets: {
        'Soft Foil': {
          intensity: 0.7,
          alpha: 0.9,
          flowSpeed: 0.2,
          angle: 45.0,
          distortionStrength: 0.4,
          noiseScale: 0.25,
          phaseMult: 1.0,
          noiseType: 0,
          ignoreDarkness: 0.0
        },
        'Diamond Dust': {
          intensity: 1.2,
          alpha: 1.0,
          flowSpeed: 0.0,
          angle: 60.0,
          distortionStrength: 0.3,
          noiseScale: 3.0,
          phaseMult: 3.0,
          noiseType: 1,
          ignoreDarkness: 0.2
        },
        'Magic Runes': {
          intensity: 1.0,
          alpha: 1.0,
          flowSpeed: 0.4,
          angle: 30.0,
          distortionStrength: 0.8,
          noiseScale: 0.4,
          phaseMult: 2.5,
          noiseType: 0,
          ignoreDarkness: 1.0
        }
      }
    };
  }

  /**
   * Initialize effect
   * @param {THREE.Renderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  initialize(renderer, scene, camera) {
    log.info('Initializing iridescence effect');
    this.scene = scene;
  }

  /**
   * Set the base mesh and load assets
   * @param {THREE.Mesh} baseMesh - Base plane mesh
   * @param {MapAssetBundle} assetBundle - Asset bundle with masks
   */
  setBaseMesh(baseMesh, assetBundle) {
    this.baseMesh = baseMesh;
    
    // Extract mask from bundle
    const maskData = assetBundle.masks.find(m => m.id === 'iridescence');
    this.iridescenceMask = maskData?.texture || null;
    
    // Update status params
    this.params.hasIridescenceMask = !!this.iridescenceMask;
    
    if (this.iridescenceMask) {
      this.params.textureStatus = 'Ready (Texture Found)';
    } else {
      this.params.textureStatus = 'Inactive (No Texture Found)';
      log.info('No iridescence mask found, effect disabled');
      this.enabled = false;
      return;
    }
    
    log.info('Iridescence mask loaded, creating overlay mesh');
    this.createOverlayMesh();
  }

  /**
   * Create the additive overlay mesh
   * @private
   */
  createOverlayMesh() {
    const THREE = window.THREE;
    
    // Create shader material
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uIridescenceMask: { value: this.iridescenceMask },
        uTime: { value: 0.0 },
        uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
        
        // Params
        uIntensity: { value: this.params.intensity },
        uAlpha: { value: this.params.alpha },
        uDistortionStrength: { value: this.params.distortionStrength },
        uNoiseScale: { value: this.params.noiseScale },
        uNoiseType: { value: this.params.noiseType },
        uFlowSpeed: { value: this.params.flowSpeed },
        uPhaseMult: { value: this.params.phaseMult },
        uColorCycleSpeed: { value: this.params.colorCycleSpeed },
        uAngle: { value: this.params.angle * (Math.PI / 180.0) },
        uIgnoreDarkness: { value: this.params.ignoreDarkness },
        uParallaxStrength: { value: this.params.parallaxStrength },
        uCameraOffset: { value: new THREE.Vector2(0, 0) },
        
        // Foundry darkness
        uDarknessLevel: { value: 0.0 }
      },
      vertexShader: this.getVertexShader(),
      fragmentShader: this.getFragmentShader(),
      side: THREE.DoubleSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false, // Don't write depth, just overlay
      depthTest: true    // Respect depth (so tokens/walls can occlude if needed)
    });
    
    // Clone geometry from base mesh to ensure perfect match
    this.mesh = new THREE.Mesh(this.baseMesh.geometry, this.material);
    
    // Sync transform
    this.mesh.position.copy(this.baseMesh.position);
    this.mesh.rotation.copy(this.baseMesh.rotation);
    this.mesh.scale.copy(this.baseMesh.scale);
    
    // Slight offset to prevent z-fighting (though Additive + DepthWrite False helps)
    // We'll use renderOrder to ensure it draws after base
    this.mesh.renderOrder = 10; // Base is usually 0
    
    // Add to scene
    this.scene.add(this.mesh);
    
    // Initial visibility state
    this.mesh.visible = this._enabled;
    
    log.debug('Iridescence overlay mesh created');
  }

  /**
   * Update effect state
   * @param {TimeInfo} timeInfo
   */
  update(timeInfo) {
    if (!this.material || !this.mesh) return;
    
    // Sync visibility
    this.mesh.visible = this._enabled;
    if (!this._enabled) return;
    
    // Update uniforms
    this.material.uniforms.uTime.value = timeInfo.elapsed;
    this.material.uniforms.uIntensity.value = this.params.intensity;
    this.material.uniforms.uAlpha.value = this.params.alpha;
    this.material.uniforms.uDistortionStrength.value = this.params.distortionStrength;
    // Map UI noise scale (0-1) to internal ranges to keep patterns in a good visual band
    const uiNoise = this.params.noiseScale;
    const t = Math.min(Math.max(uiNoise, 0), 1);
    let mappedNoiseScale;
    if (this.params.noiseType === 0) {
      // Liquid mode: very small scales look best
      const minScale = 0.002;
      const maxScale = 0.05;
      mappedNoiseScale = minScale * Math.pow(maxScale / minScale, t);
    } else {
      // Glitter mode: broader useful range
      const minScale = 0.5;
      const maxScale = 5.0;
      mappedNoiseScale = minScale * Math.pow(maxScale / minScale, t);
    }
    this.material.uniforms.uNoiseScale.value = mappedNoiseScale;
    this.material.uniforms.uNoiseType.value = this.params.noiseType;
    this.material.uniforms.uFlowSpeed.value = this.params.flowSpeed;
    this.material.uniforms.uPhaseMult.value = this.params.phaseMult;
    this.material.uniforms.uColorCycleSpeed.value = this.params.colorCycleSpeed;
    this.material.uniforms.uAngle.value = this.params.angle * (Math.PI / 180.0);
    this.material.uniforms.uIgnoreDarkness.value = this.params.ignoreDarkness;
    this.material.uniforms.uParallaxStrength.value = this.params.parallaxStrength;
    
    // Update darkness
    if (canvas?.scene?.environment?.darknessLevel !== undefined) {
      this.material.uniforms.uDarknessLevel.value = canvas.scene.environment.darknessLevel;
    }
  }

  /**
   * Sync camera-dependent uniforms (parallax, etc.)
   * @param {THREE.Renderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  render(renderer, scene, camera) {
    if (!this.material || !this.mesh) return;

    // Update camera offset for parallax effects
    if (camera.isPerspectiveCamera) {
      this.material.uniforms.uCameraOffset.value.set(camera.position.x, camera.position.y);
    } else if (camera.isOrthographicCamera) {
      const centerX = (camera.left + camera.right) / 2;
      const centerY = (camera.top + camera.bottom) / 2;
      this.material.uniforms.uCameraOffset.value.set(centerX, centerY);
    }
  }

  /**
   * Handle resize
   * @param {number} width
   * @param {number} height
   */
  onResize(width, height) {
    if (this.material) {
      this.material.uniforms.uResolution.value.set(width, height);
    }
  }

  /**
   * Dispose resources
   */
  dispose() {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry = null; // We don't own geometry (cloned ref or shared)
      this.mesh = null;
    }
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }
    log.info('Iridescence effect disposed');
  }

  getVertexShader() {
    return `
      varying vec2 vUv;
      varying vec3 vWorldPosition;
      
      void main() {
        vUv = uv;
        vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;
  }

  getFragmentShader() {
    return `
      uniform sampler2D uIridescenceMask;
      uniform float uTime;
      uniform vec2 uResolution;
      
      uniform float uIntensity;
      uniform float uAlpha;
      uniform float uDistortionStrength;
      uniform float uNoiseScale;
      uniform float uNoiseType; // 0 = Smooth, 1 = Glitter
      uniform float uFlowSpeed;
      uniform float uPhaseMult;
      uniform float uColorCycleSpeed;
      uniform float uAngle;
      uniform float uDarknessLevel;
      uniform float uIgnoreDarkness; // 0.0 = Physical, 1.0 = Magical Glow
      uniform float uParallaxStrength;
      uniform vec2 uCameraOffset;
      
      varying vec2 vUv;
      varying vec3 vWorldPosition;
      
      // Helper for hash noise
      float hash(vec2 p) { 
        return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); 
      }
      
      void main() {
        // 1. Get mask value (luminance from R channel)
        float maskVal = texture2D(uIridescenceMask, vUv).r;
        
        // Optimization: discard if no mask contribution
        if (maskVal < 0.01) discard;
        
        // 2. Screen Space Shimmer
        // Calculate normalized screen coordinates (0-1)
        vec2 screenUV = gl_FragCoord.xy / uResolution.xy;
        
        // Calculate diagonal sweep based on angle
        float cosA = cos(uAngle);
        float sinA = sin(uAngle);
        // Rotate screen UVs effectively
        float diagonalSweep = screenUV.x * cosA + screenUV.y * sinA;
        
        // 3. Noise Logic (Island Separation)
        float randomOffset = 0.0;
        
        if (uNoiseType > 0.5) {
            // GLITTER/HASH NOISE
            // Snap position to grid, then jitter cell sampling to break uniform tiling
            vec2 gridPos = floor(vWorldPosition.xy * uNoiseScale);
            vec2 jitter = vec2(
              hash(gridPos + 13.1),
              hash(gridPos + 91.7)
            );
            randomOffset = hash(gridPos + jitter); 
        } else {
            // LIQUID/WAVE NOISE (Original smooth noise)
            // Based on World Position so it stays pinned to the map
            vec2 worldNoise = vWorldPosition.xy * uNoiseScale;
            
            // Rotate into an irrational angle to avoid axis-aligned repetition
            const float PHI = 1.61803398875;
            mat2 rot = mat2(cos(PHI), -sin(PHI), sin(PHI), cos(PHI));
            vec2 w = rot * worldNoise;

            // Combine two incommensurate frequencies for a richer, less tiling pattern
            float n1 = sin(w.x) * cos(w.y);
            float n2 = sin(2.7 * w.x + 1.3) * cos(2.7 * w.y - 0.7);
            randomOffset = (n1 + 0.5 * n2) * 1.5;
        }
        
        // 4. Phase Calculation
        // Combine Screen Sweep + World Randomness + Mask Shape + Time
        // Camera parallax term: small contribution from camera movement so slow flow still reacts to view changes
        float parallaxTerm = (uCameraOffset.x + uCameraOffset.y) * 0.001 * uParallaxStrength;
        float phase = diagonalSweep 
                    + randomOffset 
                    + (maskVal * uDistortionStrength) 
                    + (uTime * uFlowSpeed)
                    + parallaxTerm;
        
        // 5. Cosine Palette Generation
        // The "Magic Vector" (0, 2, 4) creates rainbow-like gradients
        float colorPhase = phase * uColorCycleSpeed;
        vec3 rainbowColor = 0.5 + 0.5 * cos(vec3(0.0, 2.0, 4.0) + colorPhase * 6.28 * uPhaseMult);
        
        // 6. Composition
        // Apply Darkness & Magic Glow
        // If Magic (1.0), ignore darkness (stay bright). If Physical (0.0), fade with darkness.
        float envDarkness = 1.0 - uDarknessLevel;
        float lightLevel = mix(envDarkness, 1.0, uIgnoreDarkness);
        
        // Apply alpha and all factors
        vec3 finalColor = rainbowColor * maskVal * uIntensity * lightLevel * uAlpha;
        
        gl_FragColor = vec4(finalColor, 1.0); // Alpha output is 1.0 because we use additive blending (src * 1 + dst)
      }
    `;
  }
}
