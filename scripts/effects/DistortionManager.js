/**
 * @fileoverview Centralized Screen-Space Distortion Manager
 * Provides a unified system for all distortion effects (heat haze, water ripples, 
 * magic effects, etc.) with layered rendering and shared noise functions.
 * 
 * Architecture:
 * - Sources register distortion contributions (masks + parameters)
 * - Manager composites all sources into layered distortion maps
 * - Final distortion is applied as a post-processing pass
 * - Supports above/below overhead tiles, masking other effects
 * 
 * @module effects/DistortionManager
 */

import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';

const log = createLogger('DistortionManager');

/**
 * Distortion layer enumeration - determines render order and masking behavior
 */
export const DistortionLayer = {
  /** Distorts content under overhead tiles only (e.g., ground heat from fire) */
  UNDER_OVERHEAD: { order: 0, name: 'UnderOverhead', maskByRoof: true },
  /** Distorts everything except overhead tiles (e.g., atmospheric heat) */
  ABOVE_GROUND: { order: 1, name: 'AboveGround', maskByRoof: false },
  /** Distorts including overhead tiles (e.g., magical effects) */
  FULL_SCENE: { order: 2, name: 'FullScene', maskByRoof: false },
  /** Applied after all other effects (e.g., screen shake) */
  SCREEN_SPACE: { order: 3, name: 'ScreenSpace', maskByRoof: false }
};

/**
 * Represents a single distortion source that can be registered with the manager
 * @typedef {Object} DistortionSource
 * @property {string} id - Unique identifier for this source
 * @property {DistortionLayer} layer - Which layer this distortion renders in
 * @property {THREE.Texture|null} mask - Grayscale mask texture (white = full distortion)
 * @property {Object} params - Source-specific parameters
 * @property {number} params.intensity - Overall distortion strength (0-1)
 * @property {number} params.frequency - Noise frequency multiplier
 * @property {number} params.speed - Animation speed multiplier
 * @property {number} params.scale - UV scale for the distortion pattern
 * @property {boolean} enabled - Whether this source is active
 */

/**
 * Shared noise functions for distortion effects
 * These are available to any effect that needs consistent noise patterns
 */
export const DistortionNoise = {
  /**
   * Classic 2D simplex noise (GLSL snippet)
   */
  simplex2D: `
    vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }

    float snoise(vec2 v) {
      const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                         -0.577350269189626, 0.024390243902439);
      vec2 i  = floor(v + dot(v, C.yy));
      vec2 x0 = v - i + dot(i, C.xx);
      vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
      vec4 x12 = x0.xyxy + C.xxzz;
      x12.xy -= i1;
      i = mod289(i);
      vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
      vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
      m = m*m; m = m*m;
      vec3 x = 2.0 * fract(p * C.www) - 1.0;
      vec3 h = abs(x) - 0.5;
      vec3 ox = floor(x + 0.5);
      vec3 a0 = x - ox;
      m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
      vec3 g;
      g.x = a0.x * x0.x + h.x * x0.y;
      g.yz = a0.yz * x12.xz + h.yz * x12.yw;
      return 130.0 * dot(m, g);
    }
  `,

  /**
   * Fractal Brownian Motion noise (layered simplex)
   */
  fbm: `
    float fbm(vec2 p, int octaves, float lacunarity, float gain) {
      float sum = 0.0;
      float amp = 1.0;
      float freq = 1.0;
      float maxAmp = 0.0;
      for (int i = 0; i < 8; i++) {
        if (i >= octaves) break;
        sum += snoise(p * freq) * amp;
        maxAmp += amp;
        freq *= lacunarity;
        amp *= gain;
      }
      return sum / maxAmp;
    }
  `,

  /**
   * Heat haze specific noise - combines multiple frequencies for realistic shimmer
   */
  heatHaze: `
    vec2 heatDistortion(vec2 uv, float time, float intensity, float frequency, float speed) {
      // Primary low-frequency wave
      float n1 = snoise(vec2(uv.x * frequency * 0.5, uv.y * frequency * 0.3 + time * speed * 0.7));
      // Secondary higher-frequency shimmer
      float n2 = snoise(vec2(uv.x * frequency * 2.0 + time * speed * 0.3, uv.y * frequency * 1.5 + time * speed));
      // Tertiary micro-detail
      float n3 = snoise(vec2(uv.x * frequency * 4.0 - time * speed * 0.5, uv.y * frequency * 3.0 + time * speed * 1.5));
      
      // Combine with decreasing weights
      float nx = n1 * 0.6 + n2 * 0.3 + n3 * 0.1;
      float ny = snoise(vec2(uv.y * frequency * 0.4 + time * speed * 0.5, uv.x * frequency * 0.6)) * 0.7
               + snoise(vec2(uv.y * frequency * 1.8 + time * speed, uv.x * frequency * 2.2)) * 0.3;
      
      return vec2(nx, ny) * intensity;
    }
  `,

  /**
   * Water/liquid ripple distortion
   */
  waterRipple: `
    vec2 waterDistortion(vec2 uv, float time, float intensity, float frequency, float speed) {
      // Concentric ripple pattern
      float d = length(uv - 0.5) * frequency;
      float ripple = sin(d * 10.0 - time * speed * 3.0) * exp(-d * 0.5);
      
      // Add some noise variation
      float noise = snoise(uv * frequency + time * speed * 0.2);
      
      vec2 dir = normalize(uv - 0.5 + 0.001);
      return dir * (ripple + noise * 0.3) * intensity;
    }
  `,

  /**
   * Magic/ethereal swirl distortion
   */
  magicSwirl: `
    vec2 magicDistortion(vec2 uv, float time, float intensity, float frequency, float speed) {
      vec2 centered = uv - 0.5;
      float angle = atan(centered.y, centered.x);
      float dist = length(centered);
      
      // Rotating spiral
      float spiral = sin(angle * 3.0 + dist * frequency * 10.0 - time * speed * 2.0);
      // Add fractal detail
      float detail = fbm(uv * frequency + time * speed * 0.3, 4, 2.0, 0.5);
      
      float rotAmount = (spiral + detail) * intensity * (1.0 - dist * 1.5);
      
      float s = sin(rotAmount);
      float c = cos(rotAmount);
      vec2 rotated = vec2(centered.x * c - centered.y * s, centered.x * s + centered.y * c);
      
      return rotated - centered;
    }
  `
};

/**
 * DistortionManager - Centralized screen-space distortion system
 * 
 * This effect operates as a post-processing pass that samples the scene texture
 * with UV offsets derived from registered distortion sources.
 */
export class DistortionManager extends EffectBase {
  constructor() {
    super('distortion-manager', RenderLayers.POST_PROCESSING, 'low');
    
    // Render after lighting but before color correction
    this.priority = 75;
    this.alwaysRender = false;
    
    /** @type {Map<string, DistortionSource>} */
    this.sources = new Map();
    
    // Composite distortion map (R=X offset, G=Y offset, B=intensity, A=mask)
    this.distortionTarget = null;
    
    // Blur passes for mask expansion
    this.blurTargetA = null;
    this.blurTargetB = null;
    
    // Scenes/materials for internal passes
    this.blurScene = null;
    this.blurCamera = null;
    this.blurMaterialH = null;
    this.blurMaterialV = null;
    
    this.compositeScene = null;
    this.compositeMaterial = null;
    
    this.applyScene = null;
    this.applyMaterial = null;
    
    // State
    this.renderToScreen = false;
    this.readBuffer = null;
    this.writeBuffer = null;
    
    // Cached uniforms
    this._tempSize = null;

    // Reusable temp vectors for view-bound computation
    this._tempNdc = null;
    this._tempWorld = null;
    this._tempDir = null;
    
    // Global parameters
    this.params = {
      enabled: true,
      globalIntensity: 1.0,
      // Debug visualization
      debugMode: false,
      debugShowMask: false
    };
  }

  /**
   * Get UI control schema
   */
  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'global',
          label: 'Global Settings',
          type: 'inline',
          parameters: ['globalIntensity']
        },
        {
          name: 'debug',
          label: 'Debug',
          type: 'inline',
          collapsed: true,
          parameters: ['debugMode', 'debugShowMask']
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true },
        globalIntensity: { type: 'slider', min: 0, max: 2, step: 0.01, default: 1.0, label: 'Global Intensity' },
        debugMode: { type: 'boolean', default: false, label: 'Debug Mode' },
        debugShowMask: { type: 'boolean', default: false, label: 'Show Mask' }
      }
    };
  }

  /**
   * Initialize the distortion manager
   */
  initialize(renderer, scene, camera) {
    const THREE = window.THREE;
    log.info('Initializing DistortionManager');
    
    this.renderer = renderer;
    this.mainCamera = camera;
    
    this._tempSize = new THREE.Vector2();
    this._tempNdc = new THREE.Vector3();
    this._tempWorld = new THREE.Vector3();
    this._tempDir = new THREE.Vector3();
    renderer.getDrawingBufferSize(this._tempSize);
    const width = this._tempSize.x;
    const height = this._tempSize.y;
    
    // Create render targets
    this._createRenderTargets(width, height);
    
    // Create blur pass materials
    this._createBlurMaterials();
    
    // Create composite pass material (combines all distortion sources)
    this._createCompositeMaterial();
    
    // Create final apply pass material (applies distortion to scene)
    this._createApplyMaterial();
    
    log.info('DistortionManager initialized');
  }

  /**
   * Create render targets for distortion processing
   * @private
   */
  _createRenderTargets(width, height) {
    const THREE = window.THREE;
    
    const rtOptions = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthBuffer: false
    };
    
    // Main distortion composite (stores final UV offsets)
    this.distortionTarget = new THREE.WebGLRenderTarget(width, height, rtOptions);
    
    // Blur ping-pong targets (for mask expansion)
    // Use lower resolution for performance
    const blurScale = 0.5;
    const blurW = Math.max(1, Math.floor(width * blurScale));
    const blurH = Math.max(1, Math.floor(height * blurScale));
    
    this.blurTargetA = new THREE.WebGLRenderTarget(blurW, blurH, rtOptions);
    this.blurTargetB = new THREE.WebGLRenderTarget(blurW, blurH, rtOptions);
  }

  /**
   * Create blur materials for mask expansion
   * @private
   */
  _createBlurMaterials() {
    const THREE = window.THREE;
    
    // Shared blur vertex shader
    const blurVert = `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position, 1.0);
      }
    `;
    
    // Gaussian blur fragment shader (separable)
    const blurFrag = `
      uniform sampler2D tInput;
      uniform vec2 uDirection;
      uniform vec2 uTexelSize;
      uniform float uBlurRadius;
      varying vec2 vUv;
      
      void main() {
        vec4 sum = vec4(0.0);
        float weightSum = 0.0;
        
        // 9-tap Gaussian blur
        for (float i = -4.0; i <= 4.0; i += 1.0) {
          float weight = exp(-0.5 * (i * i) / (uBlurRadius * uBlurRadius));
          vec2 offset = uDirection * uTexelSize * i * uBlurRadius;
          sum += texture2D(tInput, vUv + offset) * weight;
          weightSum += weight;
        }
        
        gl_FragColor = sum / weightSum;
      }
    `;
    
    // Scene for blur passes
    this.blurScene = new THREE.Scene();
    this.blurCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    
    // Horizontal blur
    this.blurMaterialH = new THREE.ShaderMaterial({
      uniforms: {
        tInput: { value: null },
        uDirection: { value: new THREE.Vector2(1.0, 0.0) },
        uTexelSize: { value: new THREE.Vector2(1 / 512, 1 / 512) },
        uBlurRadius: { value: 2.0 }
      },
      vertexShader: blurVert,
      fragmentShader: blurFrag,
      depthWrite: false,
      depthTest: false
    });
    
    // Vertical blur
    this.blurMaterialV = new THREE.ShaderMaterial({
      uniforms: {
        tInput: { value: null },
        uDirection: { value: new THREE.Vector2(0.0, 1.0) },
        uTexelSize: { value: new THREE.Vector2(1 / 512, 1 / 512) },
        uBlurRadius: { value: 2.0 }
      },
      vertexShader: blurVert,
      fragmentShader: blurFrag,
      depthWrite: false,
      depthTest: false
    });
    
    // Create quad for blur passes
    this.blurQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this.blurMaterialH
    );
    this.blurScene.add(this.blurQuad);
  }

  /**
   * Create composite material that combines all distortion sources
   * @private
   */
  _createCompositeMaterial() {
    const THREE = window.THREE;
    
    this.compositeScene = new THREE.Scene();
    
    // The composite shader samples each source's mask and calculates
    // distortion vectors based on their parameters
    this.compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0.0 },
        uResolution: { value: new THREE.Vector2(1, 1) },
        // Camera/view mapping
        // uViewBounds are in Three.js world space: (minX, minY, maxX, maxY)
        // Three.js: Y-up, origin at bottom-left in our map convention.
        uViewBounds: { value: new THREE.Vector4(0.0, 0.0, 1.0, 1.0) },
        // Full canvas dimensions (Foundry world space including padding)
        uSceneDimensions: { value: new THREE.Vector2(1.0, 1.0) },
        // Scene rect in Foundry coords: (sceneX, sceneY, sceneW, sceneH)
        uSceneRect: { value: new THREE.Vector4(0.0, 0.0, 1.0, 1.0) },
        uHasSceneRect: { value: 0.0 },
        
        // Heat distortion source
        tHeatMask: { value: null },
        uHeatEnabled: { value: 0.0 },
        uHeatIntensity: { value: 0.015 },
        uHeatFrequency: { value: 8.0 },
        uHeatSpeed: { value: 1.0 },
        
        // Future source slots
        tWaterMask: { value: null },
        uWaterEnabled: { value: 0.0 },
        uWaterIntensity: { value: 0.02 },
        uWaterFrequency: { value: 4.0 },
        uWaterSpeed: { value: 1.0 },
        
        tMagicMask: { value: null },
        uMagicEnabled: { value: 0.0 },
        uMagicIntensity: { value: 0.03 },
        uMagicFrequency: { value: 6.0 },
        uMagicSpeed: { value: 1.5 },
        
        // Masking
        tRoofAlpha: { value: null },
        uHasRoofAlpha: { value: 0.0 },
        
        // Global
        uGlobalIntensity: { value: 1.0 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform vec2 uResolution;

        uniform vec4 uViewBounds;
        uniform vec2 uSceneDimensions;
        uniform vec4 uSceneRect;
        uniform float uHasSceneRect;
        
        // Heat source
        uniform sampler2D tHeatMask;
        uniform float uHeatEnabled;
        uniform float uHeatIntensity;
        uniform float uHeatFrequency;
        uniform float uHeatSpeed;
        
        // Water source
        uniform sampler2D tWaterMask;
        uniform float uWaterEnabled;
        uniform float uWaterIntensity;
        uniform float uWaterFrequency;
        uniform float uWaterSpeed;
        
        // Magic source
        uniform sampler2D tMagicMask;
        uniform float uMagicEnabled;
        uniform float uMagicIntensity;
        uniform float uMagicFrequency;
        uniform float uMagicSpeed;
        
        // Masking
        uniform sampler2D tRoofAlpha;
        uniform float uHasRoofAlpha;
        
        uniform float uGlobalIntensity;
        
        varying vec2 vUv;
        
        ${DistortionNoise.simplex2D}
        ${DistortionNoise.fbm}
        ${DistortionNoise.heatHaze}
        ${DistortionNoise.waterRipple}

        vec2 screenUvToFoundry(vec2 screenUv) {
          // Convert screen UV -> Three world XY using camera-derived view bounds.
          float threeX = mix(uViewBounds.x, uViewBounds.z, screenUv.x);
          float threeY = mix(uViewBounds.y, uViewBounds.w, screenUv.y);
          // Convert Three world coords to Foundry coords (Y-down)
          float foundryX = threeX;
          float foundryY = uSceneDimensions.y - threeY;
          return vec2(foundryX, foundryY);
        }

        vec2 foundryToSceneUv(vec2 foundryPos) {
          vec2 sceneOrigin = uSceneRect.xy;
          vec2 sceneSize = uSceneRect.zw;
          return (foundryPos - sceneOrigin) / sceneSize;
        }

        float inUnitSquare(vec2 uv) {
          vec2 a = step(vec2(0.0), uv);
          vec2 b = step(uv, vec2(1.0));
          return a.x * a.y * b.x * b.y;
        }
        
        void main() {
          vec2 totalOffset = vec2(0.0);
          float totalMask = 0.0;

          // Derive stable world-space coordinates (Foundry coords, then scene UV)
          vec2 foundryPos = screenUvToFoundry(vUv);
          vec2 sceneUv = vUv;
          float sceneInBounds = 1.0;
          if (uHasSceneRect > 0.5) {
            sceneUv = foundryToSceneUv(foundryPos);
            sceneInBounds = inUnitSquare(sceneUv);
            // Clamp to avoid sampling outside mask textures
            sceneUv = clamp(sceneUv, vec2(0.0), vec2(1.0));
          }
          
          // Heat distortion
          if (uHeatEnabled > 0.5) {
            vec2 heatUv = vec2(sceneUv.x, 1.0 - sceneUv.y);
            float heatMask = texture2D(tHeatMask, heatUv).r * sceneInBounds;
            if (heatMask > 0.01) {
              // Use heatUv for noise coords so the pattern stays pinned to the map
              // and aligned to the mask's UV convention.
              vec2 heatOffset = heatDistortion(heatUv, uTime, uHeatIntensity, uHeatFrequency, uHeatSpeed);
              totalOffset += heatOffset * heatMask;
              totalMask = max(totalMask, heatMask);
            }
          }
          
          // Water distortion (future)
          if (uWaterEnabled > 0.5) {
            float waterMask = texture2D(tWaterMask, vUv).r;
            if (waterMask > 0.01) {
              vec2 waterOffset = waterDistortion(vUv, uTime, uWaterIntensity, uWaterFrequency, uWaterSpeed);
              totalOffset += waterOffset * waterMask;
              totalMask = max(totalMask, waterMask);
            }
          }
          
          // Apply roof masking if needed (distortion only under roofs)
          if (uHasRoofAlpha > 0.5) {
            float roofAlpha = texture2D(tRoofAlpha, vUv).a;
            // Areas under visible roofs don't get distorted
            totalOffset *= (1.0 - roofAlpha);
            totalMask *= (1.0 - roofAlpha);
          }
          
          // Apply global intensity
          totalOffset *= uGlobalIntensity;
          
          // Output: RG = offset, B = total mask, A = 1.0
          gl_FragColor = vec4(totalOffset * 0.5 + 0.5, totalMask, 1.0);
        }
      `,
      depthWrite: false,
      depthTest: false
    });
    
    const compositeQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this.compositeMaterial
    );
    this.compositeScene.add(compositeQuad);
  }

  /**
   * Create final apply material that applies distortion to scene
   * @private
   */
  _createApplyMaterial() {
    const THREE = window.THREE;
    
    this.applyScene = new THREE.Scene();
    
    this.applyMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null },
        tDistortion: { value: null },
        uDebugMode: { value: 0.0 },
        uDebugShowMask: { value: 0.0 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tScene;
        uniform sampler2D tDistortion;
        uniform float uDebugMode;
        uniform float uDebugShowMask;
        varying vec2 vUv;
        
        void main() {
          vec4 distortionSample = texture2D(tDistortion, vUv);
          
          // Decode offset from 0-1 range back to -0.5 to 0.5
          vec2 offset = (distortionSample.rg - 0.5) * 2.0;
          float mask = distortionSample.b;
          
          // Apply distortion
          vec2 distortedUv = vUv + offset;
          
          // Clamp to prevent sampling outside texture
          distortedUv = clamp(distortedUv, vec2(0.001), vec2(0.999));
          
          vec4 sceneColor = texture2D(tScene, distortedUv);
          
          // Debug visualization
          if (uDebugMode > 0.5) {
            if (uDebugShowMask > 0.5) {
              // Show mask as red overlay
              sceneColor.rgb = mix(sceneColor.rgb, vec3(1.0, 0.0, 0.0), mask * 0.5);
            } else {
              // Show offset as color
              sceneColor.rgb = mix(sceneColor.rgb, vec3(offset.x + 0.5, offset.y + 0.5, 0.0), 0.5);
            }
          }
          
          gl_FragColor = sceneColor;
        }
      `,
      depthWrite: false,
      depthTest: false
    });
    
    const applyQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this.applyMaterial
    );
    this.applyScene.add(applyQuad);
  }

  /**
   * Register a distortion source
   * @param {string} id - Unique identifier
   * @param {DistortionLayer} layer - Which layer this renders in
   * @param {THREE.Texture|null} mask - Mask texture
   * @param {Object} params - Source parameters
   * @returns {DistortionSource} The registered source
   */
  registerSource(id, layer, mask, params = {}) {
    const source = {
      id,
      layer: layer || DistortionLayer.ABOVE_GROUND,
      mask,
      params: {
        intensity: params.intensity ?? 0.015,
        frequency: params.frequency ?? 8.0,
        speed: params.speed ?? 1.0,
        scale: params.scale ?? 1.0,
        blurRadius: params.blurRadius ?? 2.0,
        blurPasses: params.blurPasses ?? 2,
        ...params
      },
      enabled: true
    };
    
    this.sources.set(id, source);
    log.info(`Registered distortion source: ${id}`);
    
    return source;
  }

  /**
   * Unregister a distortion source
   * @param {string} id - Source identifier
   */
  unregisterSource(id) {
    if (this.sources.has(id)) {
      this.sources.delete(id);
      log.info(`Unregistered distortion source: ${id}`);
    }
  }

  /**
   * Get a registered source by ID
   * @param {string} id - Source identifier
   * @returns {DistortionSource|null}
   */
  getSource(id) {
    return this.sources.get(id) || null;
  }

  /**
   * Update a source's mask texture (e.g., after processing)
   * @param {string} id - Source identifier
   * @param {THREE.Texture} mask - New mask texture
   */
  updateSourceMask(id, mask) {
    const source = this.sources.get(id);
    if (source) {
      source.mask = mask;
    }
  }

  /**
   * Update a source's parameters
   * @param {string} id - Source identifier
   * @param {Object} params - Parameters to update
   */
  updateSourceParams(id, params) {
    const source = this.sources.get(id);
    if (source) {
      Object.assign(source.params, params);
    }
  }

  /**
   * Enable/disable a source
   * @param {string} id - Source identifier
   * @param {boolean} enabled - Whether to enable
   */
  setSourceEnabled(id, enabled) {
    const source = this.sources.get(id);
    if (source) {
      source.enabled = enabled;
    }
  }

  /**
   * Process a mask with blur to expand the distortion area
   * @param {THREE.Texture} inputMask - Original mask
   * @param {number} radius - Blur radius
   * @param {number} passes - Number of blur passes
   * @returns {THREE.Texture} Blurred mask texture
   */
  blurMask(inputMask, radius = 2.0, passes = 2) {
    if (!this.renderer || !inputMask) return inputMask;
    
    const THREE = window.THREE;
    
    // Update texel size for blur targets
    const blurW = this.blurTargetA.width;
    const blurH = this.blurTargetA.height;
    const texelSize = new THREE.Vector2(1 / blurW, 1 / blurH);
    
    this.blurMaterialH.uniforms.uTexelSize.value.copy(texelSize);
    this.blurMaterialH.uniforms.uBlurRadius.value = radius;
    this.blurMaterialV.uniforms.uTexelSize.value.copy(texelSize);
    this.blurMaterialV.uniforms.uBlurRadius.value = radius;
    
    let readTarget = this.blurTargetA;
    let writeTarget = this.blurTargetB;
    
    // Initial pass: copy input to blur target with first horizontal blur
    this.blurQuad.material = this.blurMaterialH;
    this.blurMaterialH.uniforms.tInput.value = inputMask;
    this.renderer.setRenderTarget(writeTarget);
    this.renderer.clear();
    this.renderer.render(this.blurScene, this.blurCamera);
    
    // Swap
    [readTarget, writeTarget] = [writeTarget, readTarget];
    
    // Additional blur passes
    for (let i = 0; i < passes; i++) {
      // Horizontal
      this.blurQuad.material = this.blurMaterialH;
      this.blurMaterialH.uniforms.tInput.value = readTarget.texture;
      this.renderer.setRenderTarget(writeTarget);
      this.renderer.clear();
      this.renderer.render(this.blurScene, this.blurCamera);
      [readTarget, writeTarget] = [writeTarget, readTarget];
      
      // Vertical
      this.blurQuad.material = this.blurMaterialV;
      this.blurMaterialV.uniforms.tInput.value = readTarget.texture;
      this.renderer.setRenderTarget(writeTarget);
      this.renderer.clear();
      this.renderer.render(this.blurScene, this.blurCamera);
      [readTarget, writeTarget] = [writeTarget, readTarget];
    }
    
    return readTarget.texture;
  }

  /**
   * Configure render destination
   */
  setRenderToScreen(toScreen) {
    this.renderToScreen = toScreen;
  }

  /**
   * Set input/output buffers (called by EffectComposer)
   */
  setBuffers(read, write) {
    this.readBuffer = read;
    this.writeBuffer = write;
  }

  /**
   * Update effect state
   */
  update(timeInfo) {
    if (!this.enabled) return;
    
    const u = this.compositeMaterial.uniforms;
    
    // Update time
    u.uTime.value = timeInfo.elapsed;
    u.uGlobalIntensity.value = this.params.globalIntensity;

    // Update view mapping (screen UV -> Three world -> Foundry world -> scene UV)
    try {
      const d = canvas?.dimensions;

      // Full canvas dimensions (Foundry coords, including padding)
      if (d && typeof d.width === 'number' && typeof d.height === 'number') {
        u.uSceneDimensions.value.set(d.width, d.height);
      }

      // Compute view bounds by intersecting camera frustum with ground plane at groundZ
      const camera = this.mainCamera;
      const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
      if (camera) {
        this._updateViewBoundsFromCamera(camera, groundZ, u.uViewBounds.value);
      }

      // Prefer canvas.dimensions.sceneRect (used elsewhere in this codebase)
      const sceneRect = d?.sceneRect;
      if (sceneRect && typeof sceneRect.x === 'number' && typeof sceneRect.y === 'number') {
        u.uSceneRect.value.set(sceneRect.x, sceneRect.y, sceneRect.width || 1, sceneRect.height || 1);
        u.uHasSceneRect.value = 1.0;
      } else {
        u.uHasSceneRect.value = 0.0;
      }
    } catch (_) {
      // If anything goes wrong, fall back to screen-space behavior
      u.uHasSceneRect.value = 0.0;
    }
    
    // Update per-source uniforms
    const heatSource = this.sources.get('heat');
    if (heatSource && heatSource.enabled && heatSource.mask) {
      u.uHeatEnabled.value = 1.0;
      u.tHeatMask.value = heatSource.mask;
      u.uHeatIntensity.value = heatSource.params.intensity;
      u.uHeatFrequency.value = heatSource.params.frequency;
      u.uHeatSpeed.value = heatSource.params.speed;
    } else {
      u.uHeatEnabled.value = 0.0;
    }
    
    const waterSource = this.sources.get('water');
    if (waterSource && waterSource.enabled && waterSource.mask) {
      u.uWaterEnabled.value = 1.0;
      u.tWaterMask.value = waterSource.mask;
      u.uWaterIntensity.value = waterSource.params.intensity;
      u.uWaterFrequency.value = waterSource.params.frequency;
      u.uWaterSpeed.value = waterSource.params.speed;
    } else {
      u.uWaterEnabled.value = 0.0;
    }
    
    // Update roof alpha from LightingEffect if available
    const lightingEffect = window.MapShine?.lightingEffect;
    if (lightingEffect?.roofAlphaTarget) {
      u.tRoofAlpha.value = lightingEffect.roofAlphaTarget.texture;
      u.uHasRoofAlpha.value = 1.0;
    } else {
      u.uHasRoofAlpha.value = 0.0;
    }
    
    // Update apply material debug flags
    this.applyMaterial.uniforms.uDebugMode.value = this.params.debugMode ? 1.0 : 0.0;
    this.applyMaterial.uniforms.uDebugShowMask.value = this.params.debugShowMask ? 1.0 : 0.0;
  }

  /**
   * Update a view-bounds vector (minX, minY, maxX, maxY) in Three.js world coords
   * by intersecting the camera frustum corners with the plane z = groundZ.
   * @private
   */
  _updateViewBoundsFromCamera(camera, groundZ, outVec4) {
    const THREE = window.THREE;
    if (!THREE || !outVec4 || !camera) return;

    // Orthographic camera: bounds are directly derived from frustum + zoom
    if (camera.isOrthographicCamera) {
      const camPos = camera.position;
      const minX = camPos.x + camera.left / camera.zoom;
      const maxX = camPos.x + camera.right / camera.zoom;
      const minY = camPos.y + camera.bottom / camera.zoom;
      const maxY = camPos.y + camera.top / camera.zoom;
      outVec4.set(minX, minY, maxX, maxY);
      return;
    }

    // Perspective camera: intersect corner rays with z=groundZ plane
    const origin = camera.position;
    const ndc = this._tempNdc;
    const world = this._tempWorld;
    const dir = this._tempDir;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    const corners = [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1]
    ];

    for (let i = 0; i < corners.length; i++) {
      const cx = corners[i][0];
      const cy = corners[i][1];

      // A point on the near plane in world space
      ndc.set(cx, cy, 0.5);
      world.copy(ndc).unproject(camera);

      dir.subVectors(world, origin).normalize();

      // Avoid divide-by-zero if ray is parallel to ground plane
      const dz = dir.z;
      if (Math.abs(dz) < 1e-6) continue;

      const t = (groundZ - origin.z) / dz;
      // If intersection is behind camera, skip
      if (!Number.isFinite(t) || t <= 0) continue;

      const ix = origin.x + dir.x * t;
      const iy = origin.y + dir.y * t;

      if (ix < minX) minX = ix;
      if (iy < minY) minY = iy;
      if (ix > maxX) maxX = ix;
      if (iy > maxY) maxY = iy;
    }

    if (minX !== Infinity && minY !== Infinity && maxX !== -Infinity && maxY !== -Infinity) {
      outVec4.set(minX, minY, maxX, maxY);
    }
  }

  /**
   * Render the distortion effect
   */
  render(renderer, scene, camera) {
    if (!this.enabled || !this.readBuffer) return;
    
    // Check if any sources are active
    let hasActiveSources = false;
    for (const source of this.sources.values()) {
      if (source.enabled && source.mask) {
        hasActiveSources = true;
        break;
      }
    }
    
    // If no active sources, just pass through
    if (!hasActiveSources) {
      this._passThrough(renderer);
      return;
    }
    
    // Step 1: Render composite distortion map
    renderer.setRenderTarget(this.distortionTarget);
    renderer.clear();
    renderer.render(this.compositeScene, this.blurCamera);
    
    // Step 2: Apply distortion to scene
    this.applyMaterial.uniforms.tScene.value = this.readBuffer.texture;
    this.applyMaterial.uniforms.tDistortion.value = this.distortionTarget.texture;
    
    const target = this.renderToScreen ? null : this.writeBuffer;
    renderer.setRenderTarget(target);
    if (target) renderer.clear();
    renderer.render(this.applyScene, this.blurCamera);
  }

  /**
   * Pass through when no distortion is active
   * @private
   */
  _passThrough(renderer) {
    const THREE = window.THREE;
    
    // Simple blit from read to write
    if (!this._passThroughMaterial) {
      this._passThroughScene = new THREE.Scene();
      this._passThroughMaterial = new THREE.MeshBasicMaterial({ map: null });
      this._passThroughQuad = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        this._passThroughMaterial
      );
      this._passThroughScene.add(this._passThroughQuad);
    }
    
    this._passThroughMaterial.map = this.readBuffer.texture;
    
    const target = this.renderToScreen ? null : this.writeBuffer;
    renderer.setRenderTarget(target);
    if (target) renderer.clear();
    renderer.render(this._passThroughScene, this.blurCamera);
  }

  /**
   * Handle resize
   */
  onResize(width, height) {
    if (this.distortionTarget) {
      this.distortionTarget.setSize(width, height);
    }
    
    const blurScale = 0.5;
    const blurW = Math.max(1, Math.floor(width * blurScale));
    const blurH = Math.max(1, Math.floor(height * blurScale));
    
    if (this.blurTargetA) {
      this.blurTargetA.setSize(blurW, blurH);
    }
    if (this.blurTargetB) {
      this.blurTargetB.setSize(blurW, blurH);
    }
    
    if (this.compositeMaterial) {
      this.compositeMaterial.uniforms.uResolution.value.set(width, height);
    }
  }

  /**
   * Dispose resources
   */
  dispose() {
    log.info('Disposing DistortionManager');
    
    this.sources.clear();
    
    if (this.distortionTarget) {
      this.distortionTarget.dispose();
      this.distortionTarget = null;
    }
    
    if (this.blurTargetA) {
      this.blurTargetA.dispose();
      this.blurTargetA = null;
    }
    
    if (this.blurTargetB) {
      this.blurTargetB.dispose();
      this.blurTargetB = null;
    }
    
    if (this.blurMaterialH) {
      this.blurMaterialH.dispose();
      this.blurMaterialH = null;
    }
    
    if (this.blurMaterialV) {
      this.blurMaterialV.dispose();
      this.blurMaterialV = null;
    }
    
    if (this.compositeMaterial) {
      this.compositeMaterial.dispose();
      this.compositeMaterial = null;
    }
    
    if (this.applyMaterial) {
      this.applyMaterial.dispose();
      this.applyMaterial = null;
    }
    
    if (this._passThroughMaterial) {
      this._passThroughMaterial.dispose();
      this._passThroughMaterial = null;
    }
  }
}
