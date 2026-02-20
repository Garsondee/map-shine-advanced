/**
 * @fileoverview Prism effect simulating crystal/glass refraction and chromatic aberration
 * Creates a "fake refraction" overlay using the base texture and a procedural facet map
 * @module effects/PrismEffect
 */

import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';

const log = createLogger('PrismEffect');

/**
 * Prism effect for crystal/glass surfaces
 * Uses _Prism mask to drive refraction and chromatic aberration
 */
export class PrismEffect extends EffectBase {
  constructor() {
    super('prism', RenderLayers.SURFACE_EFFECTS, 'medium');
    
    this.priority = 20; // Render after other surface effects
    
    // Backing field for enabled property
    this._enabled = true;
    
    /** @type {THREE.Mesh|null} */
    this.mesh = null;
    
    /** @type {THREE.Mesh|null} */
    this.baseMesh = null;
    
    /** @type {THREE.Texture|null} */
    this.prismMask = null;
    
    /** @type {THREE.Texture|null} */
    this.baseTexture = null;
    
    /** @type {THREE.ShaderMaterial|null} */
    this.material = null;
    
    // Effect parameters
    this.params = {
      // Status
      textureStatus: 'Searching...',
      hasPrismMask: false,

      // Refraction
      intensity: 0.3,           // Distortion strength
      spread: 0.5,              // Chromatic aberration spread (RGB split)
      
      // Facets (Crystal structure)
      facetScale: 254.0,        // Size of the crystal facets
      facetAnimate: true,       // Whether facets move/rotate
      facetSpeed: 1.01,         // Speed of animation
      facetSoftness: 0.85,      // 0 = sharp facets, 1 = soft lumpy glass
      
      // Appearance
      brightness: 0.8,          // Boost brightness of refracted light
      opacity: 0.5,             // Opacity of the overlay

      // Mask shaping
      maskThreshold: 0.9,       // Only apply effect on brightest parts of mask

      // Camera parallax
      parallaxStrength: 2.4,    // How strongly camera panning affects facets
      
      // Glint (Sparkle)
      glintStrength: 0.45,
      glintThreshold: 0.13      // Only sparkle on sharpest angles
    };

    /** @type {function|null} Unsubscribe from EffectMaskRegistry */
    this._registryUnsub = null;
  }

  /**
   * Get enabled state
   */
  get enabled() {
    return this._enabled;
  }

  /**
   * Set enabled state and update visibility
   */
  set enabled(value) {
    this._enabled = value;
    if (this.mesh) {
      this.mesh.visible = value;
    }
  }

  /**
   * Get UI control schema for Tweakpane
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
          name: 'refraction',
          label: 'Refraction',
          type: 'folder',
          parameters: ['intensity', 'spread', 'brightness', 'opacity', 'maskThreshold']
        },
        {
          name: 'facets',
          label: 'Crystal Facets',
          type: 'folder',
          parameters: ['facetScale', 'facetAnimate', 'facetSpeed', 'facetSoftness']
        },
        {
          name: 'parallax',
          label: 'Camera Parallax',
          type: 'inline',
          parameters: ['parallaxStrength']
        },
        {
          name: 'glint',
          label: 'Surface Glint',
          type: 'folder',
          parameters: ['glintStrength', 'glintThreshold']
        }
      ],
      parameters: {
        textureStatus: {
          type: 'string',
          label: 'Mask Status',
          default: 'Checking...',
          readonly: true
        },
        intensity: {
          type: 'slider',
          label: 'Distortion',
          min: 0,
          max: 5.0,
          step: 0.1,
          default: 0.3
        },
        spread: {
          type: 'slider',
          label: 'Spectral Spread',
          min: 0.0,
          max: 1.0,
          step: 0.1,
          default: 0.6
        },
        brightness: {
          type: 'slider',
          label: 'Brightness Boost',
          min: 0.5,
          max: 3.0,
          step: 0.1,
          default: 1.5
        },
        opacity: {
          type: 'slider',
          label: 'Opacity',
          min: 0.0,
          max: 1.0,
          step: 0.05,
          default: 0.25
        },
        maskThreshold: {
          type: 'slider',
          label: 'Mask Brightness Cutoff',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.9
        },
        facetScale: {
          type: 'slider',
          label: 'Facet Scale',
          min: 1.0,
          max: 1000.0,
          step: 1.0,
          default: 254.0
        },
        facetAnimate: {
          type: 'boolean',
          label: 'Animate Facets',
          default: true
        },
        facetSpeed: {
          type: 'slider',
          label: 'Animation Speed',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 1.01
        },
        facetSoftness: {
          type: 'slider',
          label: 'Facet Softness',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.85
        },
        parallaxStrength: {
          type: 'slider',
          label: 'Parallax Strength',
          min: 0.0,
          max: 5.0,
          step: 0.05,
          default: 2.4
        },
        glintStrength: {
          type: 'slider',
          label: 'Glint Strength',
          min: 0.0,
          max: 2.0,
          step: 0.05,
          default: 0.4
        },
        glintThreshold: {
          type: 'slider',
          label: 'Glint Sharpness',
          min: 0.0,
          max: 0.99,
          step: 0.01,
          default: 0.13
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
    log.info('Initializing prism effect');
    this.scene = scene;
  }

  /**
   * Update loop
   * @param {TimeInfo} timeInfo - Time simulation state
   */
  update(timeInfo) {
    if (!this.enabled || !this.material) return;
    
    // Update uniforms
    this.material.uniforms.uTime.value = timeInfo.elapsed;
    
    // Update params
    this.material.uniforms.uIntensity.value = this.params.intensity;
    this.material.uniforms.uSpread.value = this.params.spread;
    this.material.uniforms.uBrightness.value = this.params.brightness;
    this.material.uniforms.uOpacity.value = this.params.opacity;
    this.material.uniforms.uFacetScale.value = this.params.facetScale;
    this.material.uniforms.uFacetSpeed.value = this.params.facetAnimate ? this.params.facetSpeed : 0.0;
    this.material.uniforms.uFacetSoftness.value = this.params.facetSoftness;
    this.material.uniforms.uParallaxStrength.value = this.params.parallaxStrength;
    this.material.uniforms.uMaskThreshold.value = this.params.maskThreshold;
    this.material.uniforms.uGlintStrength.value = this.params.glintStrength;
    this.material.uniforms.uGlintThreshold.value = this.params.glintThreshold;
  }

  /**
   * Set the base mesh and load assets
   * @param {THREE.Mesh} baseMesh - Base plane mesh
   * @param {MapAssetBundle} assetBundle - Asset bundle with masks
   */
  setBaseMesh(baseMesh, assetBundle) {
    this.baseMesh = baseMesh;
    
    // Extract mask
    const maskData = assetBundle.masks.find(m => m.id === 'prism');
    this.prismMask = maskData?.texture || null;
    
    // Store base texture for refraction sampling
    this.baseTexture = assetBundle.baseTexture;
    
    // Update status params
    this.params.hasPrismMask = !!this.prismMask;
    
    if (this.prismMask) {
      this.params.textureStatus = 'Ready (Texture Found)';
    } else {
      this.params.textureStatus = 'Inactive (No Texture Found)';
      log.info('No prism mask found, effect disabled');
      this.enabled = false;
      return;
    }

    // Re-enable when a valid mask is found. Without this, the effect stays
    // permanently disabled after visiting a floor with no _Prism mask.
    this.enabled = true;

    // If material already exists (redistribution), update the mask uniform
    // rather than rebuilding the entire mesh.
    if (this.material?.uniforms?.uPrismMask) {
      this.material.uniforms.uPrismMask.value = this.prismMask;
      if (this.material.uniforms.uBaseMap) {
        this.material.uniforms.uBaseMap.value = this.baseTexture;
      }
      this.material.needsUpdate = true;
      return;
    }
    
    log.info('Prism mask loaded, creating overlay mesh');
    this.createOverlayMesh();
  }

  /**
   * Subscribe to the EffectMaskRegistry for 'prism' mask updates.
   * @param {import('../assets/EffectMaskRegistry.js').EffectMaskRegistry} registry
   */
  connectToRegistry(registry) {
    if (this._registryUnsub) { this._registryUnsub(); this._registryUnsub = null; }
    this._registryUnsub = registry.subscribe('prism', (texture) => {
      this.prismMask = texture;
      this.params.hasPrismMask = !!texture;
      if (!texture) {
        this.params.textureStatus = 'Inactive (No Texture Found)';
        this.enabled = false;
        return;
      }
      this.params.textureStatus = 'Ready (Texture Found)';
      this.enabled = true;
      if (this.material?.uniforms?.uPrismMask) {
        this.material.uniforms.uPrismMask.value = texture;
        this.material.needsUpdate = true;
      } else {
        this.createOverlayMesh();
      }
    });
  }

  /**
   * Create the overlay mesh
   * @private
   */
  createOverlayMesh() {
    const THREE = window.THREE;
    
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uBaseMap: { value: this.baseTexture },
        uPrismMask: { value: this.prismMask },
        uTime: { value: 0.0 },
        uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
        
        // Params
        uIntensity: { value: this.params.intensity },
        uSpread: { value: this.params.spread },
        uBrightness: { value: this.params.brightness },
        uOpacity: { value: this.params.opacity },
        uFacetScale: { value: this.params.facetScale },
        uFacetSpeed: { value: this.params.facetSpeed },
        uFacetSoftness: { value: this.params.facetSoftness },
        uParallaxStrength: { value: this.params.parallaxStrength },
        uMaskThreshold: { value: this.params.maskThreshold },
        uGlintStrength: { value: this.params.glintStrength },
        uGlintThreshold: { value: this.params.glintThreshold },
        uCameraOffset: { value: new THREE.Vector2(0, 0) },
        
        // Foundry lighting (optional integration)
        uDarknessLevel: { value: 0.0 }
      },
      vertexShader: this.getVertexShader(),
      fragmentShader: this.getFragmentShader(),
      side: THREE.DoubleSide,
      transparent: true,
      blending: THREE.NormalBlending, // Replace background with refracted version
      depthWrite: false,
      depthTest: true
    });
    
    this.mesh = new THREE.Mesh(this.baseMesh.geometry, this.material);
    
    // Sync transform
    this.mesh.position.copy(this.baseMesh.position);
    this.mesh.rotation.copy(this.baseMesh.rotation);
    this.mesh.scale.copy(this.baseMesh.scale);
    
    // Render order (above tiles, below particles)
    // TileManager uses renderOrder=10 for overhead tiles; keep Prism below that so roofs occlude it.
    this.mesh.renderOrder = 5;
    
    this.scene.add(this.mesh);
    this.mesh.visible = this._enabled;
  }

  /**
   * Get vertex shader
   */
  getVertexShader() {
    return `
      varying vec2 vUv;
      varying vec2 vWorldUv;
      varying vec3 vWorldPosition;

      void main() {
        vUv = uv;
        
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        
        // Simple world UVs for consistent noise scale regardless of mesh transform
        vWorldUv = worldPosition.xy * 0.001; 
        
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `;
  }

  /**
   * Get fragment shader
   */
  getFragmentShader() {
    return `
      uniform sampler2D uBaseMap;
      uniform sampler2D uPrismMask;
      uniform float uTime;
      uniform float uIntensity;
      uniform float uSpread;
      uniform float uBrightness;
      uniform float uOpacity;
      uniform float uFacetScale;
      uniform float uFacetSpeed;
      uniform float uFacetSoftness;
      uniform float uParallaxStrength;
      uniform float uMaskThreshold;
      uniform float uGlintStrength;
      uniform float uGlintThreshold;

      uniform vec2 uCameraOffset;

      varying vec2 vUv;
      varying vec2 vWorldUv;

      // Cellular Noise (Voronoi-ish) for crystal facets
      vec2 hash2( vec2 p ) {
        return fract(sin(vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3))))*43758.5453);
      }

      // Returns: x = distance to nearest point, yz = offset to nearest point
      vec3 voronoi( in vec2 x ) {
        vec2 n = floor(x);
        vec2 f = fract(x);
        vec2 m = vec2(8.0);
        vec2 center = vec2(0.0);
        
        for( int j=-1; j<=1; j++ )
        for( int i=-1; i<=1; i++ ) {
          vec2 g = vec2( float(i), float(j) );
          vec2 o = hash2( n + g );
          
          // Animate the point
          o = 0.5 + 0.5*sin( uTime * uFacetSpeed + 6.2831*o );
          
          vec2 r = g - f + o;
          float d = dot(r,r);
          if( d<m.x ) {
            m.x = d;
            m.y = d; // Save second closest? No, just using distance for now.
            center = r;
          }
        }
        
        return vec3(m.x, center);
      }

      void main() {
        // Sample mask and derive brightness-based region
        vec4 maskSample = texture2D(uPrismMask, vUv);
        float rawMask = maskSample.r; // Use red channel for intensity

        // Only keep brightest parts of the mask; smooth for soft edges
        float mask = smoothstep(uMaskThreshold, 1.0, rawMask);
        
        if (mask < 0.01) discard;

        // Generate faceted normal map
        // Mix UVs with camera offset so panning shifts the crystal pattern
        vec2 parallaxOffset = uCameraOffset * 0.0001 * uParallaxStrength;
        vec2 noiseUv = (vUv + parallaxOffset) * uFacetScale;
        vec3 v = voronoi(noiseUv);
        
        // Create a fake normal from the center offset of the voronoi cell
        // v.yz is vector to cell center. We treat this as a slope.
        vec2 facetSlope = v.yz;
        // Large-scale slope from world UVs for softer, wavy glass look
        vec2 glassSlope = normalize(vWorldUv * 0.5 + 0.0001);
        // Blend between sharp facets (0) and soft glass (1)
        vec2 finalSlope = mix(facetSlope, glassSlope, clamp(uFacetSoftness, 0.0, 1.0));
        
        // Refraction vectors (chromatic aberration)
        // Red bends least, Blue bends most (physically) - or opposite, art direction choice.
        // Here we just spread them out.
        
        float distAmt = uIntensity * 0.01; // Scale down for reasonable values
        vec2 offsetR = finalSlope * distAmt * (1.0 + uSpread);
        vec2 offsetG = finalSlope * distAmt;
        vec2 offsetB = finalSlope * distAmt * (1.0 - uSpread);
        
        // Sample background (Base Map) with offsets
        float r = texture2D(uBaseMap, vUv + offsetR).r;
        float g = texture2D(uBaseMap, vUv + offsetG).g;
        float b = texture2D(uBaseMap, vUv + offsetB).b;
        
        vec3 refractionColor = vec3(r, g, b);
        
        // Apply brightness boost
        refractionColor *= uBrightness;
        
        // Add specular glint (fake reflection)
        // If the facet slope aligns with a "light source", sparkle.
        // We'll fake a light source moving slightly
        vec2 lightDir = vec2(sin(uTime * 0.5), cos(uTime * 0.3));
        float glint = dot(normalize(finalSlope), normalize(lightDir));
        glint = smoothstep(uGlintThreshold, 1.0, glint);
        
        // Add glint to color
        refractionColor += vec3(glint * uGlintStrength);

        // Output
        gl_FragColor = vec4(refractionColor, mask * uOpacity);
      }
    `;
  }

  /**
   * Sync camera-dependent uniforms (parallax shimmer)
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
   * Cleanup resources
   */
  dispose() {
    if (this._registryUnsub) { this._registryUnsub(); this._registryUnsub = null; }
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose(); // Should be shared, but safe to call
      this.material.dispose();
      this.mesh = null;
      this.material = null;
    }
    
    super.dispose();
  }
}
