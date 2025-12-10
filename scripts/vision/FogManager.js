/**
 * @fileoverview Manages persistent Fog of War (Exploration)
 * Handles accumulation of vision history and persistence (Save/Load)
 * @module vision/FogManager
 */

import { createLogger } from '../core/log.js';

const log = createLogger('FogManager');

// Kill-switch for fog persistence saves.
// When true, fog exploration is still accumulated in GPU memory but never
// saved to Foundry's database.
const DISABLE_FOG_SAVE = false;

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

    // Scene for accumulation
    // CRITICAL: Use the same world-space camera as VisionManager to ensure
    // the exploration texture is accumulated in world space, not screen space.
    // This fixes the "explored area pinned to camera" bug.
    this.scene = new window.THREE.Scene();
    this.camera = new window.THREE.OrthographicCamera(
      width / -2, width / 2,
      height / 2, height / -2,
      0, 100
    );
    this.camera.position.z = 10;
    
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

    // Create a world-space quad that covers the entire scene
    // This ensures the vision texture is copied 1:1 to the exploration texture
    this.quad = new window.THREE.Mesh(
      new window.THREE.PlaneGeometry(width, height),
      this.material
    );
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
   * Save exploration data to Foundry database (async, non-blocking)
   * Uses OffscreenCanvas and chunked processing to avoid freezing the main thread.
   * Mimics canvas.fog.save()
   */
  async _save() {
    if (DISABLE_FOG_SAVE) {
      this.pendingSave = false;
      return;
    }
    if (!this.pendingSave) return;
    
    // Prevent concurrent saves
    if (this._isSaving) return;
    this._isSaving = true;
    
    try {
      // Ensure Foundry fog exploration is available
      if (!canvas || !canvas.fog || !canvas.fog.exploration) {
        log.debug('FogManager._save skipped: canvas.fog.exploration not available');
        this.pendingSave = false;
        this._isSaving = false;
        return;
      }

      const width = this.width;
      const height = this.height;
      
      // 1. Read pixels from GPU (this is still synchronous but unavoidable)
      // We minimize impact by doing this quickly and deferring heavy work
      const buffer = new Uint8Array(width * height * 4);
      this.renderer.readRenderTargetPixels(this.renderTarget, 0, 0, width, height, buffer);
      
      // 2. Use OffscreenCanvas for non-blocking image encoding
      // OffscreenCanvas.convertToBlob() is async and doesn't block the main thread
      let base64;
      
      if (typeof OffscreenCanvas !== 'undefined') {
        // Modern path: Use OffscreenCanvas for async encoding
        base64 = await this._encodeWithOffscreenCanvas(buffer, width, height);
      } else {
        // Fallback: Use chunked processing with regular canvas
        base64 = await this._encodeWithChunkedCanvas(buffer, width, height);
      }
      
      if (!base64) {
        log.warn('FogManager._save: encoding failed');
        this.pendingSave = false;
        this._isSaving = false;
        return;
      }

      // 3. Update Foundry Document
      const exploration = canvas.fog.exploration;
      const updateData = {
        explored: base64,
        timestamp: Date.now()
      };

      await exploration.update(updateData, { loadFog: false });
      log.debug('Saved FogExploration (async)');
      
      this.pendingSave = false;
      
    } catch (err) {
      log.error('Failed to save FogExploration', err);
    } finally {
      this._isSaving = false;
    }
  }
  
  /**
   * Encode fog data using OffscreenCanvas (non-blocking)
   * @private
   */
  async _encodeWithOffscreenCanvas(buffer, width, height) {
    try {
      const offscreen = new OffscreenCanvas(width, height);
      const ctx = offscreen.getContext('2d');
      
      // Create ImageData and fill it
      const imgData = ctx.createImageData(width, height);
      const pixels = imgData.data;
      
      // Convert Red channel to grayscale RGBA
      // Process in chunks to yield to main thread periodically
      const CHUNK_SIZE = 262144; // 256KB worth of pixels per chunk
      for (let i = 0; i < buffer.length; i += CHUNK_SIZE) {
        const end = Math.min(i + CHUNK_SIZE, buffer.length);
        for (let j = i; j < end; j += 4) {
          const val = buffer[j]; // R channel
          pixels[j] = val;
          pixels[j + 1] = val;
          pixels[j + 2] = val;
          pixels[j + 3] = 255;
        }
        // Yield to main thread between chunks
        if (end < buffer.length) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
      
      ctx.putImageData(imgData, 0, 0);
      
      // convertToBlob is async and non-blocking!
      const blob = await offscreen.convertToBlob({ type: 'image/webp', quality: 0.8 });
      
      // Convert blob to base64 data URL
      return await this._blobToDataURL(blob);
      
    } catch (err) {
      log.warn('OffscreenCanvas encoding failed, falling back', err);
      return await this._encodeWithChunkedCanvas(buffer, width, height);
    }
  }
  
  /**
   * Encode fog data using regular canvas with chunked processing (fallback)
   * @private
   */
  async _encodeWithChunkedCanvas(buffer, width, height) {
    const offscreenCanvas = document.createElement('canvas');
    offscreenCanvas.width = width;
    offscreenCanvas.height = height;
    const ctx = offscreenCanvas.getContext('2d');
    
    const imgData = ctx.createImageData(width, height);
    const pixels = imgData.data;
    
    // Process in chunks, yielding between each
    const CHUNK_SIZE = 262144;
    for (let i = 0; i < buffer.length; i += CHUNK_SIZE) {
      const end = Math.min(i + CHUNK_SIZE, buffer.length);
      for (let j = i; j < end; j += 4) {
        const val = buffer[j];
        pixels[j] = val;
        pixels[j + 1] = val;
        pixels[j + 2] = val;
        pixels[j + 3] = 255;
      }
      // Yield to main thread
      if (end < buffer.length) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    
    // putImageData is synchronous but we've already done the heavy lifting
    ctx.putImageData(imgData, 0, 0);
    
    // toDataURL is synchronous but should be fast after putImageData
    // For very large canvases, we could use toBlob() which is async
    return new Promise((resolve) => {
      offscreenCanvas.toBlob((blob) => {
        if (blob) {
          this._blobToDataURL(blob).then(resolve);
        } else {
          // Fallback to sync toDataURL if toBlob fails
          resolve(offscreenCanvas.toDataURL('image/webp', 0.8));
        }
      }, 'image/webp', 0.8);
    });
  }
  
  /**
   * Convert a Blob to a data URL asynchronously
   * @private
   */
  _blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
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
      // Draw loaded texture into our render target using world-space quad
      // This matches the accumulation setup to ensure consistent coordinate systems
      const mesh = new window.THREE.Mesh(
        new window.THREE.PlaneGeometry(this.width, this.height),
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
