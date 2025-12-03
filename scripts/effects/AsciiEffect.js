/**
 * @fileoverview Shader-based ASCII Art Effect
 * Renders the scene as ASCII characters using a custom fragment shader and font atlas.
 * Replaces the DOM-based implementation for better performance and integration.
 * @module effects/AsciiEffect
 */

import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';

const log = createLogger('AsciiEffect');

export class AsciiEffect extends EffectBase {
  constructor() {
    super('ascii', RenderLayers.POST_PROCESSING, 'low');
    
    // Render after color correction/grading so the ASCII represents the final look
    this.priority = 200; 
    
    // Internal resources
    this.quadScene = null;
    this.quadCamera = null;
    this.material = null;
    this.fontTexture = null;
    this.mesh = null;
    this.lastResolution = null;
    this.lastLineHeight = null;
    this.lastPadX = null;
    this.lastPadY = null;
    
    // Parameters
    this.params = {
      enabled: false,
      // Preferred visual defaults
      resolution: 0.12, // Density factor
      lineHeight: 1.5,
      opacity: 0.95,
      color: true,
      invert: false,
      charSet: 'detailed',
      // Glyph scale inside each cell (1,1 = full cell)
      glyphScaleX: 1.15,
      glyphScaleY: 0.95,
      // Per-cell padding that affects spacing between cells only
      cellPaddingX: 0.15,
      cellPaddingY: 0.15,
      // Character churn amount (0 = static, 1 = strong swapping among similar brightness)
      churn: 0.72,
      // Churn speed (how often characters are allowed to change, in changes per second)
      churnSpeed: 0.75,
      // Hybrid Mode (simple text + block background)
      blockOpacity: 0.40,
      textOpacity: 1.0,
      // CC Controls
      blackPoint: 0.0,
      whitePoint: 0.82,
      contrast: 1.66,
      brightness: 0.18
    };
    
    // Character sets
    this.charSets = {
      simple: ' .:-=+*#%@',
      detailed: ' .\'`^",:;Il!i~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$',
      matrix: ' 01',
      blocks: ' ░▒▓█',
      hybrid: 'hybrid' // Special flag (uses simple + blocks atlases)
    };
    
    this.activeCharSet = this.charSets.simple;
    this.fontTexture2 = null; // Secondary texture for hybrid mode
  }

  /**
   * Get UI control schema
   */
  static getControlSchema() {
    return {
      enabled: false,
      groups: [
        {
          name: 'settings',
          label: 'ASCII Settings',
          type: 'inline',
          parameters: ['resolution', 'lineHeight', 'opacity']
        },
        {
          name: 'glyph',
          label: 'Glyph Size',
          type: 'inline',
          parameters: ['glyphScaleX', 'glyphScaleY']
        },
        {
          name: 'spacing',
          label: 'Cell Spacing',
          type: 'inline',
          parameters: ['cellPaddingX', 'cellPaddingY']
        },
        {
          name: 'style',
          label: 'Style',
          type: 'inline',
          parameters: ['charSet', 'color', 'invert', 'churn', 'churnSpeed']
        },
        {
          name: 'hybrid',
          label: 'Hybrid Mode',
          type: 'folder',
          expanded: false,
          parameters: ['blockOpacity', 'textOpacity']
        },
        {
          name: 'cc',
          label: 'Correction',
          type: 'folder',
          expanded: true,
          parameters: ['blackPoint', 'whitePoint', 'contrast', 'brightness']
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: false, hidden: true },
        resolution: { type: 'slider', min: 0.05, max: 0.5, step: 0.01, default: 0.12 },
        lineHeight: { type: 'slider', min: 0.5, max: 4.0, step: 0.1, default: 1.5 },
        opacity: { type: 'slider', min: 0, max: 1, step: 0.05, default: 0.95 },
        glyphScaleX: { type: 'slider', min: 0.25, max: 1.5, step: 0.05, default: 1.15 },
        glyphScaleY: { type: 'slider', min: 0.25, max: 1.5, step: 0.05, default: 0.95 },
        cellPaddingX: { type: 'slider', min: 0.0, max: 0.45, step: 0.01, default: 0.15 },
        cellPaddingY: { type: 'slider', min: 0.0, max: 0.45, step: 0.01, default: 0.15 },
        churn: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.72 },
        churnSpeed: { type: 'slider', min: 0.25, max: 30.0, step: 0.25, default: 0.75 },
        color: { type: 'boolean', default: true },
        invert: { type: 'boolean', default: false },
        charSet: {
          type: 'list',
          options: { 
            'Simple': 'simple', 
            'Detailed': 'detailed', 
            'Matrix': 'matrix',
            'Blocks': 'blocks',
            'Hybrid (Block+Simple)': 'hybrid'
          },
          default: 'detailed'
        },
        blockOpacity: { type: 'slider', min: 0, max: 1, step: 0.05, default: 0.40 },
        textOpacity: { type: 'slider', min: 0, max: 1, step: 0.05, default: 1.0 },
        blackPoint: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.0 },
        whitePoint: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.82 },
        contrast: { type: 'slider', min: 0.0, max: 2.0, step: 0.01, default: 1.66 },
        brightness: { type: 'slider', min: -0.5, max: 0.5, step: 0.01, default: 0.18 }
      }
    };
  }

  /**
   * Initialize the effect
   */
  initialize(renderer, scene, camera) {
    log.info('Initializing AsciiEffect (Shader-based)');
    
    const THREE = window.THREE;
    
    // 1. Create internal scene for quad rendering
    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    
    // 2. Create initial font texture
    this.updateFontTexture(this.params.charSet);
    
    // 3. Create Shader Material
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tFont: { value: this.fontTexture },
        tFont2: { value: this.fontTexture2 || null }, // Secondary font
        uResolution: { value: new THREE.Vector2(1, 1) }, // Screen resolution
        uGridSize: { value: new THREE.Vector2(100, 100) }, // Number of chars (W, H)
        uCharCount: { value: 10.0 }, // Number of chars in atlas
        uCharCount2: { value: 10.0 }, // Number of chars in atlas 2
        uGlyphScale: { value: new THREE.Vector2(1.0, 1.0) },
        uTime: { value: 0.0 },
        uChurn: { value: 0.0 },
        uChurnSpeed: { value: 4.0 },
        uOpacity: { value: 1.0 },
        uColor: { value: false },
        uInvert: { value: false },
        uHybrid: { value: false }, // Hybrid mode flag
        uBlockOpacity: { value: 1.0 },
        uTextOpacity: { value: 1.0 },
        // CC Uniforms
        uBlackPoint: { value: 0.0 },
        uWhitePoint: { value: 1.0 },
        uContrast: { value: 1.0 },
        uBrightness: { value: 0.0 }
      },
      vertexShader: this.getVertexShader(),
      fragmentShader: this.getFragmentShader(),
      depthWrite: false,
      depthTest: false,
      transparent: true // Allow blending with opacity
    });
    
    // 4. Create Quad
    const geometry = new THREE.PlaneGeometry(2, 2);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.quadScene.add(this.mesh);
    
    // Clean up old DOM element if it exists from previous version
    const oldDom = document.getElementById('map-shine-ascii-effect');
    if (oldDom && oldDom.parentNode) {
      oldDom.parentNode.removeChild(oldDom);
    }
  }
  
  /**
   * Create/Update the font atlas texture
   */
  updateFontTexture(charSetName) {
    const THREE = window.THREE;

    const createAtlas = (chars) => {
      const fontSize = 64; // High res for crisp rendering
      const width = fontSize * chars.length;
      const height = fontSize;

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d');
      // Clear with transparent black
      ctx.clearRect(0, 0, width, height);

      ctx.font = `bold ${fontSize}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#FFFFFF';

      for (let i = 0; i < chars.length; i++) {
        const char = chars[i];
        // Center x: i * fontSize + fontSize/2
        // Center y: fontSize/2
        ctx.fillText(char, i * fontSize + fontSize / 2, fontSize / 2);
      }

      const texture = new THREE.CanvasTexture(canvas);
      texture.minFilter = THREE.NearestFilter;
      texture.magFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      return texture;
    };

    // Hybrid mode uses TWO atlases: simple (text) + blocks (background)
    const isHybrid = charSetName === 'hybrid';

    if (isHybrid) {
      const simpleChars = this.charSets.simple;
      const blockChars = this.charSets.blocks;

      this.activeCharSet = simpleChars;

      if (this.fontTexture) this.fontTexture.dispose();
      if (this.fontTexture2) this.fontTexture2.dispose();

      this.fontTexture = createAtlas(simpleChars);
      this.fontTexture2 = createAtlas(blockChars);

      if (this.material) {
        this.material.uniforms.tFont.value = this.fontTexture;
        this.material.uniforms.tFont2.value = this.fontTexture2;
        this.material.uniforms.uCharCount.value = simpleChars.length;
        this.material.uniforms.uCharCount2.value = blockChars.length;
        this.material.needsUpdate = true;
      }
    } else {
      const chars = this.charSets[charSetName] || this.charSets.simple;
      this.activeCharSet = chars;

      if (this.fontTexture) this.fontTexture.dispose();
      if (this.fontTexture2) {
        this.fontTexture2.dispose();
        this.fontTexture2 = null;
      }

      this.fontTexture = createAtlas(chars);

      if (this.material) {
        this.material.uniforms.tFont.value = this.fontTexture;
        this.material.uniforms.tFont2.value = null;
        this.material.uniforms.uCharCount.value = chars.length;
        this.material.uniforms.uCharCount2.value = 0.0;
        this.material.needsUpdate = true;
      }
    }
  }

  /**
   * Set input texture (from EffectComposer)
   */
  setInputTexture(texture) {
    if (this.material) {
      this.material.uniforms.tDiffuse.value = texture;
    }
  }

  /**
   * Update parameters
   */
  update(timeInfo) {
    if (!this.material) return;
    
    const p = this.params;
    const u = this.material.uniforms;
    
    // Check for charset change
    if (p.charSet !== this.lastCharSet) {
      this.updateFontTexture(p.charSet);
      this.lastCharSet = p.charSet;
    }

    const isHybrid = p.charSet === 'hybrid';
    
    u.uOpacity.value = p.opacity;
    u.uColor.value = p.color;
    u.uInvert.value = p.invert;
    u.uGlyphScale.value.set(p.glyphScaleX, p.glyphScaleY);
    if (timeInfo && typeof timeInfo.elapsed === 'number') {
      u.uTime.value = timeInfo.elapsed;
    }
    u.uChurn.value = p.churn;
    u.uChurnSpeed.value = p.churnSpeed;
    u.uHybrid.value = isHybrid;
    u.uBlockOpacity.value = p.blockOpacity;
    u.uTextOpacity.value = p.textOpacity;
    
    u.uBlackPoint.value = p.blackPoint;
    u.uWhitePoint.value = p.whitePoint;
    u.uContrast.value = p.contrast;
    u.uBrightness.value = p.brightness;
  }
  
  /**
   * Handle resize
   */
  onResize(width, height) {
    if (this.material) {
      this.material.uniforms.uResolution.value.set(width, height);
      this.updateGridSize(width, height);
    }
  }

  updateGridSize(width, height) {
    if (!this.material) return;
    const resolution = this.params.resolution;
    const lineHeight = this.params.lineHeight || 1.0;
    const padX = this.params.cellPaddingX ?? 0.0;
    const padY = this.params.cellPaddingY ?? 0.0;

    // Effective density is reduced by padding (more padding => fewer cells => larger gaps)
    const padScaleX = Math.max(0.05, 1.0 - 2.0 * Math.min(Math.max(padX, 0.0), 0.49));
    const padScaleY = Math.max(0.05, 1.0 - 2.0 * Math.min(Math.max(padY, 0.0), 0.49));

    // Calculate grid dimensions based on resolution factor and padding scaling
    const cols = Math.max(1, Math.floor(width * resolution * padScaleX));
    const rows = Math.max(1, Math.floor((height * resolution * padScaleY) / lineHeight));
    this.material.uniforms.uGridSize.value.set(cols, rows);
  }

  /**
   * Render the effect
   */
  render(renderer, scene, camera) {
    if (!this.enabled || !this.material.uniforms.tDiffuse.value) return;
    
    // Update grid size if resolution, line height, or padding changed
    if (
      this.lastResolution !== this.params.resolution ||
      this.lastLineHeight !== this.params.lineHeight ||
      this.lastPadX !== this.params.cellPaddingX ||
      this.lastPadY !== this.params.cellPaddingY
    ) {
      const size = new window.THREE.Vector2();
      renderer.getSize(size);
      this.updateGridSize(size.width, size.height);
      this.lastResolution = this.params.resolution;
      this.lastLineHeight = this.params.lineHeight;
      this.lastPadX = this.params.cellPaddingX;
      this.lastPadY = this.params.cellPaddingY;
    }

    // Render full screen quad
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    
    renderer.render(this.quadScene, this.quadCamera);
    
    renderer.autoClear = oldAutoClear;
  }
  
  /**
   * Dispose resources
   */
  dispose() {
    if (this.fontTexture) this.fontTexture.dispose();
    if (this.material) this.material.dispose();
    if (this.mesh) {
        this.mesh.geometry.dispose();
        this.quadScene.remove(this.mesh);
    }
    
    // Remove any residual DOM elements
    const oldDom = document.getElementById('map-shine-ascii-effect');
    if (oldDom && oldDom.parentNode) {
      oldDom.parentNode.removeChild(oldDom);
    }
  }
  
  getVertexShader() {
    return `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position, 1.0);
      }
    `;
  }
  
  getFragmentShader() {
    return `
      uniform sampler2D tDiffuse;
      uniform sampler2D tFont;
      uniform sampler2D tFont2;
      uniform vec2 uResolution;
      uniform vec2 uGridSize;
      uniform float uCharCount;
      uniform float uCharCount2;
      uniform vec2 uGlyphScale;
      uniform float uTime;
      uniform float uChurn;
      uniform float uChurnSpeed;
      uniform float uOpacity;
      uniform bool uColor;
      uniform bool uInvert;
      uniform bool uHybrid;
      
      uniform float uBlockOpacity;
      uniform float uTextOpacity;
      uniform float uBlackPoint;
      uniform float uWhitePoint;
      uniform float uContrast;
      uniform float uBrightness;
      
      varying vec2 vUv;
      
      // Hash-based random function similar to other effects
      float random(vec2 p) {
        return fract(sin(dot(p.xy, vec2(12.9898, 78.233))) * 43758.5453);
      }
      
      void main() {
        // 1. Determine which cell we are in
        vec2 cellCoord = floor(vUv * uGridSize);
        
        // 2. Calculate UV at the center of the cell (for sampling color/brightness)
        vec2 cellCenterUV = (cellCoord + 0.5) / uGridSize;
        
        // 3. Sample input color
        vec4 texel = texture2D(tDiffuse, cellCenterUV);
        
        // 4. Calculate brightness (Luminance)
        float brightness = dot(texel.rgb, vec3(0.2126, 0.7152, 0.0722));
        
        // 4a. Apply Contrast & Brightness
        brightness = (brightness - 0.5) * uContrast + 0.5 + uBrightness;
        
        // 4b. Apply Black/White Points (Levels)
        // smoothstep(edge0, edge1, x) performs smooth Hermite interpolation
        // It also clamps x to [0, 1]
        brightness = smoothstep(uBlackPoint, uWhitePoint, brightness);
        
        // 4c. Invert if requested
        if (uInvert) brightness = 1.0 - brightness;
        
        // 5. Map brightness to char index
        // Characters are sorted from dark to bright in the string
        // So low brightness = index 0, high = index max
        // Clamp brightness 0..1 (redundant if using smoothstep but good safety)
        brightness = clamp(brightness, 0.0, 1.0);
        float charIndex = floor(brightness * (uCharCount - 0.01));

        // 5a. Apply churn: animated noise that nudges the index to nearby
        // characters of similar brightness.
        // - uChurn controls how far indices can wander (amplitude)
        // - uChurnSpeed controls how often they are allowed to change (effective FPS)
        if (uChurn > 0.0 && uCharCount > 1.0) {
          // Quantize time so characters hold their state for a controllable duration
          float speed = max(0.01, uChurnSpeed); // changes per second
          float quantizedTime = floor(uTime * speed) / speed;

          // Noise in [-1,1] for this cell, using quantized time
          float n = random(cellCenterUV * 37.0 + vec2(quantizedTime, 0.0));
          float signedNoise = (n - 0.5) * 2.0;

          // Maximum integer offset in index space
          float maxSteps = 4.0 * uChurn;
          float offset = signedNoise * maxSteps;

          // Snap to nearest integer step so we land exactly on glyphs
          float stepOffset = floor(offset + 0.5);

          float newIndex = charIndex + stepOffset;
          charIndex = clamp(newIndex, 0.0, uCharCount - 1.0);
        }
        
        // 6. Calculate UV within the cell for font sampling
        // cellUV is 0..1 within the cell
        vec2 cellUV = fract(vUv * uGridSize);

        // 6a. Apply glyph scale inside the cell (1,1 = full cell)
        // Scale around the cell center to avoid shifting
        vec2 scale = clamp(uGlyphScale, vec2(0.1), vec2(4.0));
        vec2 center = vec2(0.5);
        vec2 innerUV = (cellUV - center) / scale + center;
        
        // 7. Map to font atlas UVs (simple + optional blocks)
        vec2 fontUV1 = vec2(
          (charIndex + innerUV.x) / max(uCharCount, 1.0),
          innerUV.y
        );
        
        // 8. Sample font(s)
        vec4 fontColor1 = texture2D(tFont, fontUV1);

        float charMask1 = fontColor1.a;
        vec3 baseColor = uColor ? texel.rgb : vec3(1.0);

        vec3 finalColor;

        if (uHybrid && uCharCount2 > 0.0) {
          // Hybrid: blend block atlas (background) and simple atlas (foreground)
          vec2 fontUV2 = vec2(
            (charIndex + innerUV.x) / max(uCharCount2, 1.0),
            innerUV.y
          );
          vec4 fontColor2 = texture2D(tFont2, fontUV2);
          float charMask2 = fontColor2.a;

          vec3 blockLayer = baseColor * charMask2 * uBlockOpacity;
          vec3 textLayer = baseColor * charMask1 * uTextOpacity;

          finalColor = blockLayer + textLayer;
        } else {
          // Single-layer ASCII
          if (uColor) {
            finalColor = texel.rgb * charMask1;
          } else {
            finalColor = vec3(charMask1);
          }
        }
        
        // 10. Opacity / Blending
        if (uOpacity < 1.0) {
           // Sample high-res original for background
           vec4 original = texture2D(tDiffuse, vUv);
           
           // The ASCII effect is fundamentally opaque black background + text
           // So we mix from Original -> ASCII
           gl_FragColor = mix(original, vec4(finalColor, 1.0), uOpacity);
        } else {
           gl_FragColor = vec4(finalColor, 1.0);
        }
      }
    `;
  }
}
