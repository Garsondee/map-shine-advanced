/**
 * @fileoverview Scene composer - creates 2.5D scene from battlemap assets
 * Handles scene setup, camera positioning, and grid alignment
 * @module scene/composer
 */

import { createLogger } from '../core/log.js';
import * as assetLoader from '../assets/loader.js';

const log = createLogger('SceneComposer');

/**
 * Scene composer class - manages three.js scene setup for battlemaps
 */
export class SceneComposer {
  constructor() {
    /** @type {THREE.Scene|null} */
    this.scene = null;
    
    /** @type {THREE.OrthographicCamera|null} */
    this.camera = null;
    
    /** @type {MapAssetBundle|null} */
    this.currentBundle = null;
    
    /** @type {THREE.Mesh|null} */
    this.basePlaneMesh = null;
    
    /** @type {Object} */
    this.foundrySceneData = null;
  }

  /**
   * Initialize a new scene from Foundry scene data
   * @param {Scene} foundryScene - Foundry VTT scene object
   * @param {number} viewportWidth - Viewport width in pixels
   * @param {number} viewportHeight - Viewport height in pixels
   * @returns {Promise<{scene: THREE.Scene, camera: THREE.Camera, bundle: MapAssetBundle}>}
   */
  async initialize(foundryScene, viewportWidth, viewportHeight) {
    log.info(`Initializing scene: ${foundryScene.name}`);

    const THREE = window.THREE;
    if (!THREE) {
      throw new Error('three.js not loaded');
    }

    // Store Foundry scene data
    this.foundrySceneData = {
      width: foundryScene.dimensions.width,
      height: foundryScene.dimensions.height,
      gridSize: foundryScene.grid.size,
      gridType: foundryScene.grid.type,
      padding: foundryScene.padding || 0
    };

    // Create three.js scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000); // Black background

    // Use Foundry's already-loaded background texture instead of reloading
    // Foundry's canvas.primary.background.texture is already loaded and accessible
    const baseTexture = await this.getFoundryBackgroundTexture(foundryScene);
    if (!baseTexture) {
      throw new Error(`Could not access Foundry's loaded background texture`);
    }

    // Load effect masks only (not base texture)
    const bgPath = this.extractBasePath(foundryScene.background.src);
    log.info(`Loading effect masks for: ${bgPath}`);
    
    const result = await assetLoader.loadAssetBundle(
      bgPath,
      (loaded, total, asset) => {
        log.debug(`Asset loading: ${loaded}/${total} - ${asset}`);
      },
      { skipBaseTexture: true } // Skip base texture since we got it from Foundry
    );

    // Create bundle with Foundry's texture + any masks that loaded successfully
    this.currentBundle = {
      basePath: bgPath,
      baseTexture: baseTexture,
      masks: result.success ? result.bundle.masks : [],
      isMapShineCompatible: result.success ? result.bundle.isMapShineCompatible : false
    };

    // Create base plane mesh with the battlemap texture
    this.createBasePlane(baseTexture);

    // Setup orthographic camera
    this.setupCamera(viewportWidth, viewportHeight);

    log.info(`Scene initialized: ${this.currentBundle.masks.length} effect masks available`);
    if (result.warnings && result.warnings.length > 0) {
      log.warn('Asset warnings:', result.warnings);
    }

    return {
      scene: this.scene,
      camera: this.camera,
      bundle: this.currentBundle
    };
  }

  /**
   * Extract base path from Foundry image URL
   * @param {string} src - Foundry image source path
   * @returns {string} Base path without extension
   * @private
   */
  extractBasePath(src) {
    // Remove extension
    const lastDot = src.lastIndexOf('.');
    if (lastDot > 0) {
      return src.substring(0, lastDot);
    }
    return src;
  }

  /**
   * Get Foundry's already-loaded background texture as a THREE.Texture
   * @param {Scene} foundryScene - Foundry VTT scene object
   * @returns {Promise<THREE.Texture|null>} THREE.js texture or null if not found
   * @private
   */
  async getFoundryBackgroundTexture(foundryScene) {
    const THREE = window.THREE;
    
    // Wait for Foundry's canvas to be ready
    if (!canvas || !canvas.primary) {
      log.warn('Foundry canvas not ready');
      return null;
    }

    // Access Foundry's PIXI texture for the scene background
    const pixiTexture = canvas.primary.background?.texture;
    if (!pixiTexture || !pixiTexture.baseTexture) {
      log.warn('Foundry background texture not found');
      return null;
    }

    // Get the HTMLImageElement or HTMLCanvasElement from PIXI
    const baseTexture = pixiTexture.baseTexture;
    const resource = baseTexture.resource;
    
    if (!resource || !resource.source) {
      log.warn('Foundry texture resource not accessible');
      return null;
    }

    // Create THREE.Texture from the same image source
    const threeTexture = new THREE.Texture(resource.source);
    threeTexture.needsUpdate = true;
    // Use sRGB for correct color in lighting calculations
    if (THREE.SRGBColorSpace) {
      threeTexture.colorSpace = THREE.SRGBColorSpace;
    }
    // Flip Y: PIXI textures are top-left origin, three.js UVs are bottom-left origin
    threeTexture.flipY = true;
    
    // Match PIXI's texture settings
    threeTexture.wrapS = THREE.ClampToEdgeWrapping;
    threeTexture.wrapT = THREE.ClampToEdgeWrapping;
    threeTexture.minFilter = THREE.LinearFilter;
    threeTexture.magFilter = THREE.LinearFilter;

    log.debug('Converted Foundry texture to THREE.Texture');
    return threeTexture;
  }

  /**
   * Create the base plane mesh with battlemap texture
   * @param {THREE.Texture} texture - Base battlemap texture
   * @private
   */
  createBasePlane(texture) {
    const THREE = window.THREE;

    // Get texture dimensions
    const imgWidth = texture.image.width;
    const imgHeight = texture.image.height;

    log.debug(`Creating base plane: ${imgWidth}x${imgHeight}px`);

    // Create plane geometry matching texture aspect ratio
    // Use Foundry scene dimensions for world space size
    const worldWidth = this.foundrySceneData.width;
    const worldHeight = this.foundrySceneData.height;

    const geometry = new THREE.PlaneGeometry(worldWidth, worldHeight);
    
    // Basic material for now (will be replaced with PBR material in effect system)
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.DoubleSide,
      transparent: false
    });
    // Flip Y to correct UV orientation mismatch between PIXI and three.js
    if (material.map) { material.map.flipY = true; material.map.needsUpdate = true; }

    this.basePlaneMesh = new THREE.Mesh(geometry, material);
    this.basePlaneMesh.name = 'BasePlane';
    
    // Position at world origin
    this.basePlaneMesh.position.set(worldWidth / 2, worldHeight / 2, 0);
    
    // Rotate 180° around X-axis to flip vertically (accounts for Foundry texture orientation)
    this.basePlaneMesh.rotation.x = Math.PI;
    
    this.scene.add(this.basePlaneMesh);
    log.info(`Base plane added: size ${worldWidth}x${worldHeight}, pos (${worldWidth/2}, ${worldHeight/2}, 0), rotation.x=${Math.PI}`);
  }

  /**
   * Setup orthographic camera for 2.5D top-down view
   * @param {number} viewportWidth - Viewport width
   * @param {number} viewportHeight - Viewport height
   * @private
   */
  setupCamera(viewportWidth, viewportHeight) {
    const THREE = window.THREE;

    const worldWidth = this.foundrySceneData.width;
    const worldHeight = this.foundrySceneData.height;
    const viewportAspect = viewportWidth / viewportHeight;
    const worldAspect = worldWidth / worldHeight;

    // Calculate frustum to fit world in viewport while maintaining aspect
    let frustumWidth, frustumHeight;
    
    if (viewportAspect > worldAspect) {
      // Viewport is wider than world - fit height, extend width
      frustumHeight = worldHeight;
      frustumWidth = frustumHeight * viewportAspect;
    } else {
      // Viewport is taller than world - fit width, extend height
      frustumWidth = worldWidth;
      frustumHeight = frustumWidth / viewportAspect;
    }

    // Center the frustum on the world center IN WORLD SPACE
    // For orthographic camera: frustum defines world space bounds directly
    const centerX = worldWidth / 2;
    const centerY = worldHeight / 2;

    this.camera = new THREE.OrthographicCamera(
      centerX - frustumWidth / 2,   // left (world space)
      centerX + frustumWidth / 2,   // right (world space)
      centerY + frustumHeight / 2,  // top (world space)
      centerY - frustumHeight / 2,  // bottom (world space)
      0.1,                          // near
      1000                          // far
    );

    // Position camera at origin looking down -Z (standard orthographic setup)
    // The frustum bounds define what's visible in world space
    this.camera.position.set(0, 0, 100);
    this.camera.lookAt(0, 0, 0);
    this.camera.up.set(0, 1, 0);
    this.camera.updateProjectionMatrix();

    log.info(`Camera setup: frustum ${frustumWidth.toFixed(0)}x${frustumHeight.toFixed(0)}, world ${worldWidth}x${worldHeight}, viewport ${viewportWidth}x${viewportHeight}`);
  }

  /**
   * Update camera on viewport resize
   * @param {number} viewportWidth - New viewport width
   * @param {number} viewportHeight - New viewport height
   */
  resize(viewportWidth, viewportHeight) {
    if (!this.camera) return;

    const aspect = viewportWidth / viewportHeight;
    const worldHeight = this.foundrySceneData.height;
    const frustumHeight = worldHeight;
    const frustumWidth = frustumHeight * aspect;

    this.camera.left = -frustumWidth / 2;
    this.camera.right = frustumWidth / 2;
    this.camera.top = frustumHeight / 2;
    this.camera.bottom = -frustumHeight / 2;
    this.camera.updateProjectionMatrix();

    log.debug(`Camera resized: ${viewportWidth}x${viewportHeight}`);
  }

  /**
   * Pan camera by offset
   * @param {number} deltaX - X offset in world units
   * @param {number} deltaY - Y offset in world units
   */
  pan(deltaX, deltaY) {
    if (!this.camera) return;

    // For orthographic cameras, shift the frustum bounds instead of camera position
    this.camera.left += deltaX;
    this.camera.right += deltaX;
    this.camera.top += deltaY;
    this.camera.bottom += deltaY;
    this.camera.updateProjectionMatrix();
    
    log.debug(`Camera pan: (${deltaX.toFixed(1)}, ${deltaY.toFixed(1)})`);
  }

  /**
   * Zoom camera by factor (Foundry-style: zoom around current view center)
   * @param {number} zoomFactor - Zoom multiplier (>1 = zoom in, <1 = zoom out)
   * @param {number} centerX - Zoom center X in viewport space (0-1, default 0.5) - UNUSED, kept for API compatibility
   * @param {number} centerY - Zoom center Y in viewport space (0-1, default 0.5) - UNUSED, kept for API compatibility
   */
  zoom(zoomFactor, centerX = 0.5, centerY = 0.5) {
    if (!this.camera) return;

    // Foundry approach: Keep the current view center fixed, just scale the frustum size
    // This matches how Foundry's canvas.pan({scale: newScale}) works
    
    // Get current frustum center (stays fixed during zoom)
    const currentCenterX = (this.camera.left + this.camera.right) / 2;
    const currentCenterY = (this.camera.top + this.camera.bottom) / 2;

    // Calculate new frustum dimensions (smaller frustum = zoomed in)
    const currentWidth = this.camera.right - this.camera.left;
    const currentHeight = this.camera.top - this.camera.bottom;
    const newWidth = currentWidth / zoomFactor;
    const newHeight = currentHeight / zoomFactor;

    // Update frustum bounds around the SAME center point
    this.camera.left = currentCenterX - newWidth / 2;
    this.camera.right = currentCenterX + newWidth / 2;
    this.camera.top = currentCenterY + newHeight / 2;
    this.camera.bottom = currentCenterY - newHeight / 2;
    this.camera.updateProjectionMatrix();

    log.debug(`Camera zoom: ${zoomFactor.toFixed(2)}x, center stays at (${currentCenterX.toFixed(1)}, ${currentCenterY.toFixed(1)})`);
  }

  /**
   * Get the current asset bundle
   * @returns {MapAssetBundle|null}
   */
  getAssetBundle() {
    return this.currentBundle;
  }

  /**
   * Get the base plane mesh
   * @returns {THREE.Mesh|null}
   */
  getBasePlane() {
    return this.basePlaneMesh;
  }

  /**
   * Dispose scene resources
   */
  dispose() {
    if (this.basePlaneMesh) {
      this.basePlaneMesh.geometry.dispose();
      this.basePlaneMesh.material.dispose();
      this.basePlaneMesh = null;
    }

    if (this.scene) {
      this.scene.clear();
      this.scene = null;
    }

    this.camera = null;
    this.currentBundle = null;

    log.info('Scene composer disposed');
  }
}
