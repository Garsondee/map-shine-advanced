/**
 * @fileoverview Manages persistent Fog of War (Exploration)
 * Handles accumulation of vision history and persistence (Save/Load)
 * @module vision/FogManager
 */

import { createLogger } from '../core/log.js';

const log = createLogger('FogManager');

export class FogManager {
  /**
   * @param {THREE.Renderer} renderer
   * @param {number} width
   * @param {number} height
   */
  constructor(renderer, width, height) {
    this.renderer = renderer;
    this.width = width;
    this.height = height;

    // Persistent Exploration Texture
    this.renderTarget = new window.THREE.WebGLRenderTarget(width, height, {
      format: window.THREE.RedFormat, // Single channel sufficient
      type: window.THREE.UnsignedByteType,
      minFilter: window.THREE.LinearFilter,
      magFilter: window.THREE.LinearFilter,
      stencilBuffer: false,
      depthBuffer: false,
      generateMipmaps: false
    });

    // Clear initially to black (unexplored)
    this.renderer.setRenderTarget(this.renderTarget);
    this.renderer.clearColor();
    this.renderer.setRenderTarget(null);

    // Scene for accumulation (Fullscreen Quad)
    this.scene = new window.THREE.Scene();
    this.camera = new window.THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    
    // Material to draw Vision Texture onto Exploration Texture
    // Uses MAX blending to ensure visited areas stay visited
    this.material = new window.THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: null, // Set to vision texture
      blending: window.THREE.CustomBlending,
      blendEquation: window.THREE.MaxEquation, // Keep max value (if 1, stay 1)
      blendSrc: window.THREE.OneFactor,
      blendDst: window.THREE.OneFactor
    });

    this.quad = new window.THREE.Mesh(new window.THREE.PlaneGeometry(2, 2), this.material);
    this.scene.add(this.quad);

    // Debounced save function
    this.debouncedSave = foundry.utils.debounce(this._save.bind(this), 2000);
    this.pendingSave = false;

    log.info('FogManager initialized');
  }

  /**
   * Update exploration by accumulating current vision
   * @param {THREE.Texture} visionTexture 
   */
  accumulate(visionTexture) {
    this.material.map = visionTexture;
    this.material.needsUpdate = true;

    // Draw Vision ON TOP of existing Exploration
    const currentTarget = this.renderer.getRenderTarget();
    const currentAutoClear = this.renderer.autoClear;

    this.renderer.setRenderTarget(this.renderTarget);
    this.renderer.autoClear = false; // CRITICAL: Don't clear existing exploration
    
    this.renderer.render(this.scene, this.camera);
    
    this.renderer.autoClear = currentAutoClear; // Restore
    this.renderer.setRenderTarget(currentTarget);

    // Mark as needing save
    this.pendingSave = true;
    
    // Trigger save if configured
    // TODO: Check Foundry settings/thresholds
    this.debouncedSave();
  }

  getTexture() {
    return this.renderTarget.texture;
  }

  resize(width, height) {
    const newTarget = this.renderTarget.clone();
    newTarget.setSize(width, height);
    
    // TODO: Resample old texture to new target?
    // For now, simple resize clears the fog (consistent with Foundry behavior usually)
    
    this.renderTarget.dispose();
    this.renderTarget = newTarget;
    this.width = width;
    this.height = height;
  }

  /**
   * Save exploration data to Foundry database
   * Mimics canvas.fog.save()
   */
  async _save() {
    if (!this.pendingSave) return;
    
    try {
      // Ensure Foundry fog exploration is available
      if (!canvas || !canvas.fog || !canvas.fog.exploration) {
        log.debug('FogManager._save skipped: canvas.fog.exploration not available');
        this.pendingSave = false;
        return;
      }

      // 1. Read pixels
      const buffer = new Uint8Array(this.width * this.height * 4); // RGBA (readRenderTargetPixels requires RGBA usually)
      this.renderer.readRenderTargetPixels(this.renderTarget, 0, 0, this.width, this.height, buffer);

      // 2. Compress/Convert to Base64 (Simplified)
      // Generating a real image from raw pixels is hard in pure JS without canvas
      // We'll use an offscreen HTML canvas for encoding. Name it offscreenCanvas
      // to avoid shadowing Foundry's global `canvas` object.
      const offscreenCanvas = document.createElement('canvas');
      offscreenCanvas.width = this.width;
      offscreenCanvas.height = this.height;
      const ctx = offscreenCanvas.getContext('2d');
      
      // Create ImageData (taking only Red channel)
      const imgData = ctx.createImageData(this.width, this.height);
      const pixels = imgData.data;
      
      // Convert Red channel from render target (which might be RGBA or Red depending on implementation)
      // Three.js readRenderTargetPixels reads into RGBA usually even if format is RED
      for (let i = 0; i < buffer.length; i += 4) {
        const val = buffer[i]; // R
        pixels[i] = val;   // R
        pixels[i+1] = val; // G
        pixels[i+2] = val; // B
        pixels[i+3] = 255; // Alpha (Opaque)
      }
      
      ctx.putImageData(imgData, 0, 0);
      const base64 = offscreenCanvas.toDataURL('image/webp', 0.8);

      // 3. Update Foundry Document
      // We hook into Foundry's existing FogExploration document. Some
      // Foundry versions expose fields directly on the document
      // (exploration.explored), others under exploration.data.explored.
      const exploration = canvas.fog.exploration;
      const updateData = {
        explored: base64,
        timestamp: Date.now()
      };

      await exploration.update(updateData, { loadFog: false }); // Don't trigger reload
      log.debug('Saved FogExploration');
      
      this.pendingSave = false;
      
    } catch (err) {
      log.error('Failed to save FogExploration', err);
    }
  }

  /**
   * Load exploration data from Foundry
   */
  async load() {
    if (!canvas || !canvas.fog || !canvas.fog.exploration) return;

    const exploration = canvas.fog.exploration;
    // Support both exploration.explored and exploration.data?.explored
    const base64 = exploration.explored ?? exploration.data?.explored;
    if (!base64) return;

    // Load Base64 into a texture
    const loader = new window.THREE.TextureLoader();
    loader.load(base64, (texture) => {
      // Draw loaded texture into our render target
      const mesh = new window.THREE.Mesh(
        new window.THREE.PlaneGeometry(2, 2),
        new window.THREE.MeshBasicMaterial({ 
            map: texture,
            blending: window.THREE.NoBlending // Overwrite
        })
      );
      const scene = new window.THREE.Scene();
      scene.add(mesh);
      
      this.renderer.setRenderTarget(this.renderTarget);
      this.renderer.render(scene, this.camera);
      this.renderer.setRenderTarget(null);
      
      log.info('Loaded FogExploration');
    });
  }
  
  dispose() {
    this.renderTarget.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
