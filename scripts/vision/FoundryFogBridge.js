/**
 * @fileoverview Bridge between Foundry's native Fog of War system and Three.js
 * 
 * Instead of recomputing vision polygons ourselves, we extract Foundry's existing
 * vision and exploration textures (PIXI RenderTextures) and convert them to
 * Three.js textures for use in our FogEffect shader.
 * 
 * This approach:
 * - Eliminates complex polygon computation (VisionPolygonComputer, GeometryConverter)
 * - Ensures perfect sync with Foundry's native fog behavior
 * - Leverages Foundry's existing save/load persistence
 * - Reduces code complexity significantly
 * 
 * @module vision/FoundryFogBridge
 */

import { createLogger } from '../core/log.js';

const log = createLogger('FoundryFogBridge');

export class FoundryFogBridge {
  /**
   * @param {THREE.WebGLRenderer} renderer - Three.js renderer (shares WebGL context with PIXI)
   */
  constructor(renderer) {
    this.renderer = renderer;
    this.gl = renderer.getContext();
    
    // Three.js textures that wrap Foundry's PIXI textures
    // We reuse these objects and just update the WebGL handle each frame
    this.visionTexture = null;
    this.exploredTexture = null;
    
    // Track the last WebGL texture handles to detect changes
    this._lastVisionGLTexture = null;
    this._lastExploredGLTexture = null;
    
    // Scene dimensions for coordinate mapping
    this.sceneWidth = 1;
    this.sceneHeight = 1;
    
    // Fallback textures (1x1 white/black) for when Foundry textures aren't available
    this._fallbackWhite = null;
    this._fallbackBlack = null;
    
    this.initialized = false;
  }

  /**
   * Initialize the bridge
   */
  initialize() {
    if (this.initialized) return;
    
    const THREE = window.THREE;
    
    // Create fallback textures
    // White = fully visible/explored
    const whiteData = new Uint8Array([255, 255, 255, 255]);
    this._fallbackWhite = new THREE.DataTexture(whiteData, 1, 1, THREE.RGBAFormat);
    this._fallbackWhite.needsUpdate = true;
    
    // Black = not visible/unexplored
    const blackData = new Uint8Array([0, 0, 0, 255]);
    this._fallbackBlack = new THREE.DataTexture(blackData, 1, 1, THREE.RGBAFormat);
    this._fallbackBlack.needsUpdate = true;
    
    // Update scene dimensions
    this.updateDimensions();
    
    this.initialized = true;
    log.info('FoundryFogBridge initialized');
  }

  /**
   * Update scene dimensions from Foundry
   */
  updateDimensions() {
    if (canvas?.dimensions) {
      this.sceneWidth = canvas.dimensions.width || 1;
      this.sceneHeight = canvas.dimensions.height || 1;
    }
  }

  /**
   * Sync textures from Foundry's PIXI system to Three.js
   * Call this every frame before rendering FogEffect
   */
  sync() {
    if (!this.initialized) this.initialize();
    
    // Update dimensions in case scene changed
    this.updateDimensions();
    
    // Extract vision texture from canvas.masks.vision.renderTexture
    this.visionTexture = this._extractVisionTexture();
    
    // Extract exploration texture from canvas.fog.sprite.texture
    this.exploredTexture = this._extractExploredTexture();
    
    // Debug logging (throttled)
    if (Math.random() < 0.001) {
      const visionTex = canvas?.masks?.vision?.renderTexture;
      const exploredTex = canvas?.fog?.sprite?.texture;
      log.debug(`Vision tex: ${visionTex?.width}x${visionTex?.height}, Explored tex: ${exploredTex?.width}x${exploredTex?.height}`);
    }
  }

  /**
   * Extract the current vision mask texture from Foundry
   * @returns {THREE.Texture}
   * @private
   */
  _extractVisionTexture() {
    try {
      // canvas.masks.vision is a CanvasVisionMask (CachedContainer)
      // Its renderTexture contains the current line-of-sight
      const pixiTexture = canvas?.masks?.vision?.renderTexture;
      
      if (!pixiTexture?.valid) {
        return this._fallbackWhite; // No vision = show everything (GM mode)
      }
      
      return this._pixiToThreeTexture(pixiTexture, 'vision');
    } catch (e) {
      log.warn('Failed to extract vision texture:', e);
      return this._fallbackWhite;
    }
  }

  /**
   * Extract the exploration (persistent fog) texture from Foundry
   * @returns {THREE.Texture}
   * @private
   */
  _extractExploredTexture() {
    try {
      // canvas.fog.sprite is a SpriteMesh containing the exploration texture
      const pixiTexture = canvas?.fog?.sprite?.texture;
      
      if (!pixiTexture?.valid) {
        return this._fallbackBlack; // No exploration = nothing explored
      }
      
      return this._pixiToThreeTexture(pixiTexture, 'explored');
    } catch (e) {
      log.warn('Failed to extract explored texture:', e);
      return this._fallbackBlack;
    }
  }

  /**
   * Convert a PIXI texture to a Three.js texture by sharing the underlying WebGL texture
   * 
   * PIXI and Three.js share the same WebGL context, so we can directly reference
   * the same GPU texture handle without copying pixels.
   * 
   * IMPORTANT: We reuse the same Three.js texture object and just update the WebGL handle.
   * Creating new textures every frame causes memory leaks and stale texture issues.
   * 
   * @param {PIXI.Texture|PIXI.RenderTexture} pixiTexture
   * @param {string} name - 'vision' or 'explored'
   * @returns {THREE.Texture}
   * @private
   */
  _pixiToThreeTexture(pixiTexture, name) {
    const THREE = window.THREE;
    const fallback = name === 'vision' ? this._fallbackWhite : this._fallbackBlack;
    
    // Get the underlying WebGL texture from PIXI
    const baseTexture = pixiTexture.baseTexture;
    if (!baseTexture) {
      log.warn(`No baseTexture for ${name}`);
      return fallback;
    }

    // Get the WebGL texture handle
    const pixiRenderer = canvas?.app?.renderer;
    if (!pixiRenderer) {
      return fallback;
    }
    
    // Force PIXI to upload the texture if it hasn't been yet
    pixiRenderer.texture.bind(baseTexture);
    
    const glTexture = baseTexture._glTextures?.[pixiRenderer.texture.CONTEXT_UID];
    if (!glTexture?.texture) {
      return fallback;
    }

    // Get or create the reusable Three.js texture for this type
    const textureKey = name === 'vision' ? 'visionTexture' : 'exploredTexture';
    const lastGLKey = name === 'vision' ? '_lastVisionGLTexture' : '_lastExploredGLTexture';
    
    let threeTexture = this[textureKey];
    const currentGLTexture = glTexture.texture;
    
    // Check if we need to create or update the texture
    if (!threeTexture) {
      // First time - create the Three.js texture wrapper
      threeTexture = new THREE.Texture();
      threeTexture.format = THREE.RGBAFormat;
      threeTexture.type = THREE.UnsignedByteType;
      threeTexture.minFilter = THREE.LinearFilter;
      threeTexture.magFilter = THREE.LinearFilter;
      threeTexture.wrapS = THREE.ClampToEdgeWrapping;
      threeTexture.wrapT = THREE.ClampToEdgeWrapping;
      threeTexture.generateMipmaps = false;
      this[textureKey] = threeTexture;
    }
    
    // Always update the WebGL texture handle (it may change when PIXI re-renders)
    // This is the key fix - we update the handle every frame
    const properties = this.renderer.properties.get(threeTexture);
    properties.__webglTexture = currentGLTexture;
    properties.__webglInit = true;
    
    // Update dimensions
    const width = baseTexture.realWidth || baseTexture.width || 1;
    const height = baseTexture.realHeight || baseTexture.height || 1;
    threeTexture.image = { width, height };
    threeTexture.needsUpdate = false; // Don't re-upload
    
    // Track for debugging
    this[lastGLKey] = currentGLTexture;
    
    return threeTexture;
  }

  /**
   * Get the current vision texture (real-time LOS)
   * @returns {THREE.Texture}
   */
  getVisionTexture() {
    return this.visionTexture || this._fallbackWhite;
  }

  /**
   * Get the current exploration texture (persistent fog)
   * @returns {THREE.Texture}
   */
  getExploredTexture() {
    return this.exploredTexture || this._fallbackBlack;
  }

  /**
   * Check if fog of war is enabled for the current scene
   * @returns {boolean}
   */
  isFogEnabled() {
    return canvas?.scene?.tokenVision ?? false;
  }

  /**
   * Check if fog exploration (persistent memory) is enabled
   * @returns {boolean}
   */
  isExplorationEnabled() {
    return canvas?.scene?.fog?.exploration ?? false;
  }

  /**
   * Get scene dimensions for UV mapping
   * @returns {{width: number, height: number}}
   */
  getSceneDimensions() {
    return {
      width: this.sceneWidth,
      height: this.sceneHeight
    };
  }

  /**
   * Get the scene rect (actual map area excluding padding)
   * @returns {{x: number, y: number, width: number, height: number}}
   */
  getSceneRect() {
    const rect = canvas?.dimensions?.sceneRect;
    if (rect) {
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }
    return { x: 0, y: 0, width: this.sceneWidth, height: this.sceneHeight };
  }

  /**
   * Dispose resources
   */
  dispose() {
    if (this._fallbackWhite) {
      this._fallbackWhite.dispose();
      this._fallbackWhite = null;
    }
    if (this._fallbackBlack) {
      this._fallbackBlack.dispose();
      this._fallbackBlack = null;
    }
    
    // Note: We don't dispose visionTexture/exploredTexture because they
    // reference Foundry's textures, not our own copies
    this.visionTexture = null;
    this.exploredTexture = null;
    
    this.initialized = false;
    log.info('FoundryFogBridge disposed');
  }
}
