/**
 * @fileoverview Unreal Bloom Post-Processing Effect
 * Wraps Three.js UnrealBloomPass for high-quality bloom
 * @module effects/BloomEffect
 */

import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';

const log = createLogger('BloomEffect');

export class BloomEffect extends EffectBase {
  constructor() {
    super('bloom', RenderLayers.POST_PROCESSING, 'medium');
    
    // Render BEFORE Color Correction (which is 100)
    // Scene -> Bloom -> ToneMapping -> Screen
    this.priority = 50; 
    this.alwaysRender = false;
    
    // Internal pass
    this.pass = null;
    
    // State
    this.renderToScreen = false;
    this.readBuffer = null;
    this.writeBuffer = null;
    
    this.params = {
      enabled: true,
      strength: 0.35,
      radius: 0.16,
      threshold: 0.46,
      tintColor: { r: 1, g: 1, b: 1 },
      // Controls how the bloom layer blends over the base scene
      blendOpacity: 1.0,
      blendMode: 'add' // 'add', 'screen', 'soft'
    };

    this._tintColorVec = null;
    this._lastTintR = null;
    this._lastTintG = null;
    this._lastTintB = null;
  }

  /**
   * Get UI control schema
   */
  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'bloom',
          label: 'Bloom Settings',
          type: 'inline',
          parameters: ['strength', 'radius', 'threshold', 'tintColor', 'blendOpacity', 'blendMode']
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true },
        strength: { type: 'slider', min: 0, max: 3, step: 0.01, default: 0.4 },
        radius: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.2 },
        threshold: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.99 },
        tintColor: { type: 'color', default: { r: 1, g: 1, b: 1 } },
        blendOpacity: { type: 'slider', min: 0, max: 1, step: 0.01, default: 1.0 },
        // Tweakpane expects an options map: label -> value
        blendMode: {
          type: 'select',
          options: {
            'Additive': 'add',
            'Screen': 'screen',
            'Soft Light': 'soft'
          },
          default: 'screen'
        }
      },
      presets: {
        'Subtle': { strength: 0.8, radius: 0.2, threshold: 0.9 },
        'Strong': { strength: 2.0, radius: 0.8, threshold: 0.7 },
        'Dreamy': { strength: 1.5, radius: 1.0, threshold: 0.6 },
        'Neon': { strength: 2.5, radius: 0.3, threshold: 0.2 }
      }
    };
  }

  /**
   * Initialize the effect
   */
  initialize(renderer, scene, camera) {
    log.info('Initializing BloomEffect (UnrealBloomPass)');
    
    const THREE = window.THREE;
    const size = new THREE.Vector2();
    renderer.getDrawingBufferSize(size);
    
    // Create the pass
    this.pass = new THREE.UnrealBloomPass(
      size,
      this.params.strength,
      this.params.radius,
      this.params.threshold
    );
    
    // Initialize bloom tint colors
    this.updateTintColor();

    // Create helper for copying buffer (fix for UnrealBloomPass writing to input)
    this.copyScene = new THREE.Scene();
    this.copyCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.copyMaterial = new THREE.MeshBasicMaterial({ map: null });
    this.copyQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.copyMaterial);
    this.copyScene.add(this.copyQuad);
  }

  /**
   * Update parameters
   */
  update(timeInfo) {
    if (!this.pass) return;
    
    const p = this.params;
    
    this.pass.strength = p.strength;
    this.pass.radius = p.radius;
    this.pass.threshold = p.threshold;
    
    // Update blend material so we can control how the bloom glows over the scene
    if (this.pass.blendMaterial) {
      const THREE = window.THREE;
      this.pass.blendMaterial.opacity = p.blendOpacity;
      
      let targetBlending = THREE.AdditiveBlending;
      if (p.blendMode === 'screen') {
        // Screen-style bloom: in this custom Three build we approximate
        // "screen" using standard additive blending. This keeps the
        // mode functional without relying on undefined enums.
        targetBlending = THREE.AdditiveBlending;
      } else if (p.blendMode === 'soft') {
        // Soft light-style bloom: also approximated via additive
        // blending for compatibility with the available blending
        // constants.
        targetBlending = THREE.AdditiveBlending;
      }
      if (this.pass.blendMaterial.blending !== targetBlending) {
        this.pass.blendMaterial.blending = targetBlending;
        this.pass.blendMaterial.needsUpdate = true;
      }
    }
    
    const tc = p.tintColor;
    if (tc.r !== this._lastTintR || tc.g !== this._lastTintG || tc.b !== this._lastTintB) {
      this.updateTintColor();
      this._lastTintR = tc.r;
      this._lastTintG = tc.g;
      this._lastTintB = tc.b;
    }
  }
  
  updateTintColor() {
      if (!this.pass) return;

      const THREE = window.THREE;
      if (!THREE) return;

      if (!this._tintColorVec) this._tintColorVec = new THREE.Vector3();
      
      // Update all mips with the tint color
      const color = this._tintColorVec.set(
          this.params.tintColor.r, 
          this.params.tintColor.g, 
          this.params.tintColor.b
      );
      
      const tintColors = this.pass.bloomTintColors;
      if (tintColors) {
          for (let i = 0; i < tintColors.length; i++) {
              tintColors[i].copy(color);
          }
      }
  }

  /**
   * Set input texture (Not strictly used by UnrealBloomPass as it needs full buffers)
   */
  setInputTexture(texture) {
    // No-op, we use setBuffers
  }
  
  /**
   * Configure render destination
   */
  setRenderToScreen(toScreen) {
    this.renderToScreen = toScreen;
    if (this.pass) {
      this.pass.renderToScreen = toScreen;
    }
  }
  
  /**
   * Configure buffers (called by EffectComposer)
   */
  setBuffers(read, write) {
    this.readBuffer = read;
    this.writeBuffer = write;
  }

  /**
   * Render the effect
   */
  render(renderer, scene, camera) {
    if (!this.enabled || !this.pass || !this.readBuffer) return;
    
    // We pass a dummy deltaTime because UnrealBloomPass doesn't strictly use it for animation
    // (unless it was doing something time-based which it isn't).
    // The 'maskActive' param is also usually false for full screen post.
    
    this.pass.render(
      renderer,
      this.writeBuffer,
      this.readBuffer,
      0.01, // delta
      false // maskActive
    );

    // Fix: UnrealBloomPass renders to readBuffer when not rendering to screen.
    // We must copy the result to writeBuffer for the EffectComposer chain to work.
    if (!this.renderToScreen && this.writeBuffer) {
        this.copyMaterial.map = this.readBuffer.texture;
        renderer.setRenderTarget(this.writeBuffer);
        renderer.clear();
        renderer.render(this.copyScene, this.copyCamera);
    }
  }
  
  /**
   * Handle resize
   */
  onResize(width, height) {
    if (this.pass) {
      this.pass.setSize(width, height);
    }
  }

  /**
   * Dispose resources
   */
  dispose() {
    if (this.pass) {
      this.pass.dispose();
      this.pass = null;
    }
    if (this.copyMaterial) {
        this.copyMaterial.dispose();
    }
    if (this.copyQuad) {
        this.copyQuad.geometry.dispose();
    }
  }
}
