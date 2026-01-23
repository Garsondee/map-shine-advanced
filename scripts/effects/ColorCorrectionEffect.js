/**
 * @fileoverview Color Correction and Grading Post-Processing Effect
 * Implements a complete photographic pipeline: WB -> Exposure -> Tone Mapping -> Grading -> VFX
 * @module effects/ColorCorrectionEffect
 */

import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';

const log = createLogger('ColorCorrectionEffect');

export class ColorCorrectionEffect extends EffectBase {
  constructor() {
    super('colorCorrection', RenderLayers.POST_PROCESSING, 'medium');
    
    this.priority = 100; // Render after other post-processing if any
    this.alwaysRender = true;
    
    // Internal scene for full-screen quad rendering
    this.quadScene = null;
    this.quadCamera = null;
    this.mesh = null;
    this.material = null;

    this._readBuffer = null;
    this._writeBuffer = null;
    this._inputTexture = null;
    
    // NOTE: Defaults tuned to match Foundry PIXI brightness more closely.
    // Tone mapping is OFF by default to avoid darkening the scene.
    // See docs/CONTRAST-DARKNESS-ANALYSIS.md for rationale.
    this.params = {
      // 1. Input
      exposure: 1.0,
      
      // 2. White Balance
      temperature: 0.0, // -1.0 (Blue) to 1.0 (Orange)
      tint: 0.0,        // -1.0 (Green) to 1.0 (Magenta)
      
      // 3. Basic Adjustments
      brightness: 0.0,  // Neutral (was 0.01)
      contrast: 1.0,    // Neutral (was 1.01)
      saturation: 0.9,
      vibrance: -0.15,
      
      // 4. Color Grading (Lift/Gamma/Gain)
      // We use flat properties for Tweakpane compatibility (vectors can be tricky)
      liftColor: { r: 0, g: 0, b: 0 },
      gammaColor: { r: 0.5, g: 0.5, b: 0.5 },
      gainColor: { r: 1, g: 1, b: 1 },
      masterGamma: 2.0,
      
      // 5. Tone Mapping
      toneMapping: 0,
      
      // 6. Artistic
      vignetteStrength: 0.0,
      vignetteSoftness: 0.0,
      grainStrength: 0.0,
      
      // Status
      enabled: true
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
          name: 'exposure',
          label: 'Exposure & WB',
          type: 'inline',
          parameters: ['exposure', 'temperature', 'tint']
        },
        {
          name: 'basics',
          label: 'Basic Adjustments',
          type: 'inline',
          parameters: ['contrast', 'brightness', 'saturation', 'vibrance']
        },
        {
          name: 'grading',
          label: 'Color Grading',
          type: 'folder',
          expanded: false,
          parameters: ['toneMapping', 'liftColor', 'gammaColor', 'gainColor', 'masterGamma']
        },
        {
          name: 'artistic',
          label: 'Effects (Vignette/Grain)',
          type: 'folder',
          expanded: false,
          parameters: ['vignetteStrength', 'vignetteSoftness', 'grainStrength']
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true },
        exposure: { type: 'slider', min: 0, max: 5, step: 0.01, default: 1.0 },
        temperature: { type: 'slider', min: -1, max: 1, step: 0.01, default: 0.0 },
        tint: { type: 'slider', min: -1, max: 1, step: 0.01, default: 0.0 },
        
        brightness: { type: 'slider', min: -0.5, max: 0.5, step: 0.01, default: 0.0 },
        contrast: { type: 'slider', min: 0, max: 2, step: 0.01, default: 1.0 },
        saturation: { type: 'slider', min: 0, max: 2, step: 0.01, default: 1.0 },
        vibrance: { type: 'slider', min: -1, max: 1, step: 0.01, default: 0.0 },
        
        liftColor: { type: 'color', default: { r: 0, g: 0, b: 0 } },
        gammaColor: { type: 'color', default: { r: 0.5, g: 0.5, b: 0.5 } },
        gainColor: { type: 'color', default: { r: 1, g: 1, b: 1 } },
        masterGamma: { type: 'slider', min: 0.1, max: 3, step: 0.01, default: 2.0 },
        
        toneMapping: { 
          type: 'list', 
          options: { 'None': 0, 'ACES Filmic': 1, 'Reinhard': 2 },
          default: 0 
        },
        
        vignetteStrength: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.0 },
        vignetteSoftness: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.0 },
        grainStrength: { type: 'slider', min: 0, max: 0.5, step: 0.01, default: 0.0 }
      },
      presets: {
        'Cinematic': {
          toneMapping: 1,
          contrast: 1.1,
          saturation: 1.1,
          vignetteStrength: 0.4,
          temperature: 0.1
        },
        'Noir': {
          toneMapping: 1,
          saturation: 0.0,
          contrast: 1.4,
          grainStrength: 0.15,
          vignetteStrength: 0.6
        },
        'Warm & Cozy': {
          toneMapping: 1,
          temperature: 0.3,
          tint: 0.1,
          saturation: 1.1,
          gammaColor: { r: 1.0, g: 0.95, b: 0.9 }
        },
        'Cold Horror': {
          toneMapping: 2,
          temperature: -0.4,
          saturation: 0.6,
          contrast: 1.2,
          grainStrength: 0.1,
          gainColor: { r: 0.9, g: 0.95, b: 1.0 }
        }
      }
    };
  }

  /**
   * Initialize the effect
   */
  initialize(renderer, scene, camera) {
    log.info('Initializing ColorCorrectionEffect');
    
    const THREE = window.THREE;
    
    // 1. Create internal scene for quad rendering
    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    
    // 2. Create Shader Material
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null }, // Input texture
        uTime: { value: 0.0 },
        uResolution: { value: new THREE.Vector2(1, 1) },
        
        // Params
        uExposure: { value: 1.0 },
        uTemperature: { value: 0.0 },
        uTint: { value: 0.0 },
        uBrightness: { value: 0.0 },
        uContrast: { value: 1.0 },
        uSaturation: { value: 1.0 },
        uVibrance: { value: 0.0 },
        
        uLift: { value: new THREE.Vector3(0, 0, 0) },
        uGamma: { value: new THREE.Vector3(1, 1, 1) },
        uGain: { value: new THREE.Vector3(1, 1, 1) },
        uMasterGamma: { value: 1.0 },
        
        uToneMapping: { value: 1 },
        
        uVignetteStrength: { value: 0.0 },
        uVignetteSoftness: { value: 0.5 },
        uGrainStrength: { value: 0.0 }
      },
      vertexShader: this.getVertexShader(),
      fragmentShader: this.getFragmentShader(),
      depthWrite: false,
      depthTest: false
    });
    
    // 3. Create Quad
    const geometry = new THREE.PlaneGeometry(2, 2);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.quadScene.add(this.mesh);
  }

  /**
   * Set input texture (from scene render)
   */
  setInputTexture(texture) {
    if (this.material) {
      this.material.uniforms.tDiffuse.value = texture;
    }

    this._inputTexture = texture;
  }

  setBuffers(readBuffer, writeBuffer) {
    this._readBuffer = readBuffer;
    this._writeBuffer = writeBuffer;
  }

  /**
   * Update parameters
   */
  update(timeInfo) {
    if (!this.material) return;
    
    const u = this.material.uniforms;
    const p = this.params;
    
    u.uTime.value = timeInfo.elapsed;
    
    u.uExposure.value = p.exposure;
    u.uTemperature.value = p.temperature;
    u.uTint.value = p.tint;
    u.uBrightness.value = p.brightness;
    u.uContrast.value = p.contrast;
    u.uSaturation.value = p.saturation;
    u.uVibrance.value = p.vibrance;
    u.uMasterGamma.value = p.masterGamma ?? 1.0;
    
    if (p.liftColor) u.uLift.value.set(p.liftColor.r, p.liftColor.g, p.liftColor.b);
    if (p.gammaColor) u.uGamma.value.set(p.gammaColor.r, p.gammaColor.g, p.gammaColor.b);
    if (p.gainColor) u.uGain.value.set(p.gainColor.r, p.gainColor.g, p.gainColor.b);
    
    u.uToneMapping.value = p.toneMapping;
  }

  /**
   * Render the effect
   */
  render(renderer, scene, camera) {
    if (!this.enabled || !this.material) return;

    const inputTexture = this.material.uniforms?.tDiffuse?.value || this._readBuffer?.texture || this._inputTexture;
    if (!inputTexture) return;
    this.material.uniforms.tDiffuse.value = inputTexture;
    
    // Log once per 100 frames to verify it's running
    if (Math.random() < 0.01) {
      log.debug('Rendering ColorCorrectionEffect', {
        exposure: this.material.uniforms.uExposure.value,
        texture: !!this.material.uniforms.tDiffuse.value
      });
    }

    this.material.uniforms.uResolution.value.set(
      renderer.domElement.width,
      renderer.domElement.height
    );

    // Render full screen quad
    // We need to disable autoClear to overlay if we were compositing, 
    // but here we are likely replacing the screen content with the corrected version
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    
    renderer.render(this.quadScene, this.quadCamera);
    
    renderer.autoClear = oldAutoClear;
  }

  onResize(width, height) {
    if (this.material) {
      this.material.uniforms.uResolution.value.set(width, height);
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
      uniform vec2 uResolution;
      uniform float uTime;
      
      // Params
      uniform float uExposure;
      uniform float uTemperature;
      uniform float uTint;
      uniform float uBrightness;
      uniform float uContrast;
      uniform float uSaturation;
      uniform float uVibrance;
      
      uniform vec3 uLift;
      uniform vec3 uGamma;
      uniform vec3 uGain;
      uniform float uMasterGamma;
      
      uniform int uToneMapping;
      
      uniform float uVignetteStrength;
      uniform float uVignetteSoftness;
      uniform float uGrainStrength;
      
      varying vec2 vUv;
      
      // ACES Tone Mapping (Approx)
      vec3 ACESFilmicToneMapping(vec3 x) {
        float a = 2.51;
        float b = 0.03;
        float c = 2.43;
        float d = 0.59;
        float e = 0.14;
        return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
      }
      
      // Reinhard Tone Mapping
      vec3 ReinhardToneMapping(vec3 x) {
        return x / (x + vec3(1.0));
      }
      
      // White Balance
      vec3 applyWhiteBalance(vec3 color, float temp, float tint) {
        // Temperature: Blue <-> Orange
        vec3 tempShift = vec3(1.0 + temp, 1.0, 1.0 - temp);
        if (temp < 0.0) tempShift = vec3(1.0, 1.0, 1.0 - temp * 0.5); // More blue
        else tempShift = vec3(1.0 + temp * 0.5, 1.0, 1.0); // More orange
        
        // Tint: Green <-> Magenta
        vec3 tintShift = vec3(1.0, 1.0 + tint, 1.0);
        
        return color * tempShift * tintShift;
      }
      
      // Random for Grain
      float random(vec2 p) {
        return fract(sin(dot(p.xy, vec2(12.9898, 78.233))) * 43758.5453);
      }
      
      void main() {
        vec4 texel = texture2D(tDiffuse, vUv);
        vec3 color = texel.rgb;
        
        // 1. Exposure
        color *= uExposure;
        
        // 2. White Balance
        color = applyWhiteBalance(color, uTemperature, uTint);
        
        // 3. Basic Adjustments
        // Brightness
        color += uBrightness;
        
        // Contrast
        color = (color - 0.5) * uContrast + 0.5;
        
        // Saturation & Vibrance
        float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
        vec3 gray = vec3(luma);
        
        // Vibrance: Boost saturation of less saturated colors more
        float sat = max(color.r, max(color.g, color.b)) - min(color.r, min(color.g, color.b));
        vec3 satColor = mix(gray, color, uSaturation);
        
        // Apply vibrance (subtle saturation boost based on inverse current saturation)
        if (uVibrance != 0.0) {
           satColor = mix(satColor, mix(gray, satColor, 1.0 + uVibrance), (1.0 - sat));
        }
        color = satColor;
        
        // 4. Color Grading (Lift/Gamma/Gain)
        // Lift: Offset (Shadows)
        color = color + (uLift * 0.1); // Scale down for finer control
        
        // Gain: Multiply (Highlights)
        color = color * uGain;
        
        // Gamma: Power (Midtones)
        // Safety check for pow()
        color = max(color, vec3(0.0));
        color = pow(color, 1.0 / uGamma);
        // Apply master gamma after per-channel gamma
        if (uMasterGamma != 1.0) {
          color = pow(color, vec3(1.0 / max(uMasterGamma, 0.0001)));
        }
        
        // 5. Tone Mapping
        if (uToneMapping == 1) {
          color = ACESFilmicToneMapping(color);
        } else if (uToneMapping == 2) {
          color = ReinhardToneMapping(color);
        }
        
        // 6. VFX
        // Vignette
        vec2 dist = (vUv - 0.5) * 2.0; // -1 to 1
        float len = length(dist);
        float vignette = smoothstep(0.8, 0.8 - uVignetteSoftness, len * (1.0 - uVignetteStrength));
        // Simple vignette application
        if (uVignetteStrength > 0.0) {
           color *= mix(1.0, smoothstep(1.5, 0.5, len), uVignetteStrength);
        }
        
        // Grain
        if (uGrainStrength > 0.0) {
          float noise = random(vUv + uTime);
          color += (noise - 0.5) * uGrainStrength;
        }
        
        gl_FragColor = vec4(color, 1.0); // Always opaque output for screen
      }
    `;
  }
}
