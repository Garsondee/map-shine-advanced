/**
 * @fileoverview Scene composer - creates 2.5D scene from battlemap assets
 * Handles scene setup, camera positioning, and grid alignment
 * @module scene/composer
 */

import { createLogger } from '../core/log.js';
import * as assetLoader from '../assets/loader.js';
import { weatherController } from '../core/WeatherController.js';

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
    log.info(`Initializing scene: ${foundryScene?.name || 'unnamed'}`);

    const THREE = window.THREE;
    if (!THREE) {
      throw new Error('three.js not loaded');
    }

    // Validate foundryScene exists
    if (!foundryScene) {
      throw new Error('No Foundry scene provided');
    }

    // Validate dimensions exist (required for camera/plane setup)
    if (!foundryScene.dimensions) {
      throw new Error('Scene has no dimensions data');
    }

    // Store Foundry scene data with safe defaults
    this.foundrySceneData = {
      width: foundryScene.dimensions.width || 1000,
      height: foundryScene.dimensions.height || 1000,
      sceneWidth: foundryScene.dimensions.sceneWidth || foundryScene.dimensions.width || 1000,
      sceneHeight: foundryScene.dimensions.sceneHeight || foundryScene.dimensions.height || 1000,
      gridSize: foundryScene.grid?.size || 100,
      gridType: foundryScene.grid?.type || 1,
      padding: foundryScene.padding || 0,
      backgroundColor: foundryScene.backgroundColor || '#999999'
    };

    // Create three.js scene
    this.scene = new THREE.Scene();
    // Remove explicit scene background to rely on renderer clear color (which is forced to black)
    // this.scene.background = new THREE.Color(0x000000); 
    
    // Check if scene has a background image
    const hasBackgroundImage = foundryScene.background?.src && 
                               typeof foundryScene.background.src === 'string' && 
                               foundryScene.background.src.trim().length > 0;
    
    let baseTexture = null;
    let bgPath = null;
    
    if (hasBackgroundImage) {
      // Use Foundry's already-loaded background texture instead of reloading
      // Foundry's canvas.primary.background.texture is already loaded and accessible
      baseTexture = await this.getFoundryBackgroundTexture(foundryScene);
      
      if (baseTexture) {
        // Load effect masks only (not base texture)
        bgPath = this.extractBasePath(foundryScene.background.src);
        log.info(`Loading effect masks for: ${bgPath}`);
      } else {
        log.warn('Could not access Foundry background texture, using fallback');
      }
    } else {
      log.info('Scene has no background image, using solid color fallback');
    }
    
    // Load effect masks if we have a background path
    let result = { success: false, bundle: { masks: [] }, warnings: [] };
    if (bgPath) {
      result = await assetLoader.loadAssetBundle(
        bgPath,
        (loaded, total, asset) => {
          log.debug(`Asset loading: ${loaded}/${total} - ${asset}`);
        },
        { skipBaseTexture: true } // Skip base texture since we got it from Foundry
      );
    }

    // Create bundle with Foundry's texture + any masks that loaded successfully
    this.currentBundle = {
      basePath: bgPath || '',
      baseTexture: baseTexture,
      masks: result.success ? result.bundle.masks : [],
      isMapShineCompatible: result.success ? result.bundle.isMapShineCompatible : false
    };

    // Create base plane mesh (with texture or fallback color)
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
    threeTexture.flipY = false;
    
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
   * @param {THREE.Texture|null} texture - Base battlemap texture (null for blank maps)
   * @private
   */
  createBasePlane(texture) {
    const THREE = window.THREE;

    // Get texture dimensions (or use scene dimensions for blank maps)
    const imgWidth = texture?.image?.width || this.foundrySceneData.sceneWidth;
    const imgHeight = texture?.image?.height || this.foundrySceneData.sceneHeight;

    log.debug(`Creating base plane: ${imgWidth}x${imgHeight}px${texture ? '' : ' (no texture)'}`);

    // Create plane geometry matching texture aspect ratio
    // Use Foundry scene dimensions for world space size
    const worldWidth = this.foundrySceneData.width;
    const worldHeight = this.foundrySceneData.height;
    const sceneWidth = this.foundrySceneData.sceneWidth;
    const sceneHeight = this.foundrySceneData.sceneHeight;

    // Solid background plane covering the entire world (including padding)
    const bgColorStr = this.foundrySceneData.backgroundColor || '#999999';
    let bgColorInt = 0x999999;
    try {
      const hex = bgColorStr.replace('#', '');
      const parsed = parseInt(hex, 16);
      if (!Number.isNaN(parsed)) bgColorInt = parsed;
    } catch (e) {
      // Fallback already set
    }
    const bgGeometry = new THREE.PlaneGeometry(worldWidth, worldHeight);
    const bgMaterial = new THREE.MeshBasicMaterial({ color: bgColorInt });
    const bgMesh = new THREE.Mesh(bgGeometry, bgMaterial);
    bgMesh.position.set(worldWidth / 2, worldHeight / 2, -0.1);
    this.scene.add(bgMesh);

    // Use SCENE dimensions for geometry to prevent stretching texture across padding
    const geometry = new THREE.PlaneGeometry(sceneWidth, sceneHeight);
    
    // Basic material for now (will be replaced with PBR material in effect system)
    // If no texture, use scene background color
    let material;
    if (texture) {
      material = new THREE.MeshBasicMaterial({
        map: texture,
        side: THREE.FrontSide, // Only render texture on front
        transparent: false
      });
      // Flip Y to correct UV orientation mismatch between PIXI and three.js
      if (material.map) { 
        material.map.flipY = false; 
        material.map.needsUpdate = true; 
      }
    } else {
      // Fallback: solid color plane for blank maps
      material = new THREE.MeshBasicMaterial({
        color: bgColorInt,
        side: THREE.FrontSide,
        transparent: false
      });
      log.info('Using solid color material for blank map');
    }

    this.basePlaneMesh = new THREE.Mesh(geometry, material);
    this.basePlaneMesh.name = 'BasePlane';
    
    // Create red back-face for orientation debugging
    const backMaterial = new THREE.MeshBasicMaterial({
      color: 0xff0000,
      side: THREE.BackSide
    });
    const backMesh = new THREE.Mesh(geometry, backMaterial);
    backMesh.name = 'BasePlane_Back';
    this.basePlaneMesh.add(backMesh);
    
    // Position at world center
    this.basePlaneMesh.position.set(worldWidth / 2, worldHeight / 2, 0);
    
    // CRITICAL: Foundry uses Y-down coordinates (0 at top, H at bottom).
    // Three.js uses Y-up (0 at bottom, H at top).
    // Strategy: Map Foundry 0 -> World H (Top) and Foundry H -> World 0 (Bottom).
    // Plane Geometry is created at center (W/2, H/2).
    // Top-Left Vertex is at (0, H). Bottom-Right is at (W, 0).
    // Texture (FlipY=false) maps Image Top-Left to Vertex Bottom-Left? No.
    // With scale.y = -1, we invert the geometry.
    
    this.basePlaneMesh.scale.y = -1; 
    
    this.scene.add(this.basePlaneMesh);
    log.info(`Base plane added: size ${worldWidth}x${worldHeight}, pos (${worldWidth/2}, ${worldHeight/2}, 0)`);
  }

  /**
   * Setup perspective camera for quasi-orthographic 2.5D top-down view
   * Uses distant camera with narrow FOV to minimize perspective distortion
   * @param {number} viewportWidth - Viewport width in CSS pixels
   * @param {number} viewportHeight - Viewport height in CSS pixels
   * @private
   */
  setupCamera(viewportWidth, viewportHeight) {
    const THREE = window.THREE;

    const worldWidth = this.foundrySceneData.width;
    const worldHeight = this.foundrySceneData.height;

    // Center of the world (where camera looks)
    const centerX = worldWidth / 2;
    const centerY = worldHeight / 2;

    // QUASI-ORTHOGRAPHIC SETUP:
    // Position camera very far away with narrow FOV
    // At extreme distance, perspective distortion becomes negligible
    const cameraDistance = 10000;

    // Calculate FOV to achieve 1:1 pixel mapping at this distance
    // tan(FOV/2) = (viewHeight/2) / distance
    // FOV = 2 * atan((viewHeight/2) / distance)
    const fovRadians = 2 * Math.atan(viewportHeight / (2 * cameraDistance));
    const fovDegrees = fovRadians * (180 / Math.PI);

    const aspect = viewportWidth / viewportHeight;

    // Dynamic Near Plane: Start with ratio 0.1 of distance
    const nearPlane = Math.max(10, cameraDistance * 0.1);

    this.camera = new THREE.PerspectiveCamera(
      fovDegrees,
      aspect,
      nearPlane,     // near (dynamic for depth precision)
      200000         // far (increased to allow significant zoom out)
    );

    // Position camera high above world center
    this.camera.position.set(centerX, centerY, cameraDistance);
    
    // Standard Orientation (Look down -Z, Up is +Y)
    // Screen Top sees World +Y (Top). Screen Bottom sees World 0 (Bottom).
    // This matches our new coordinate strategy.
    this.camera.rotation.set(0, 0, 0);
    
    this.camera.updateMatrix();
    this.camera.updateMatrixWorld(true);
    this.camera.updateProjectionMatrix();
    
    log.info(`Camera rotation set to: x=${this.camera.rotation.x.toFixed(4)}, y=${this.camera.rotation.y.toFixed(4)}, z=${this.camera.rotation.z.toFixed(4)}`);

    // Store camera distance for zoom calculations
    this.cameraDistance = cameraDistance;
    this.baseDistance = cameraDistance;

    log.info(`Perspective camera setup: FOV ${fovDegrees.toFixed(2)}°, distance ${cameraDistance}, aspect ${aspect.toFixed(2)}, viewport ${viewportWidth}x${viewportHeight}`);
  }

  /**
   * Update camera on viewport resize
   * @param {number} viewportWidth - New viewport width
   * @param {number} viewportHeight - New viewport height
   */
  resize(viewportWidth, viewportHeight) {
    if (!this.camera) return;

    // Update aspect ratio
    const aspect = viewportWidth / viewportHeight;
    this.camera.aspect = aspect;

    // Recalculate FOV for new viewport height to maintain 1:1 pixel mapping
    const fovRadians = 2 * Math.atan(viewportHeight / (2 * this.cameraDistance));
    const fovDegrees = fovRadians * (180 / Math.PI);
    this.camera.fov = fovDegrees;

    this.camera.updateProjectionMatrix();

    log.debug(`Camera resized: ${viewportWidth}x${viewportHeight}, FOV: ${fovDegrees.toFixed(2)}°`);
  }

  /**
   * Pan camera by offset
   * @param {number} deltaX - X offset in world units
   * @param {number} deltaY - Y offset in world units
   */
  pan(deltaX, deltaY) {
    if (!this.camera) return;

    // For perspective camera looking straight down:
    // Just translate the camera in XY, keeping Z constant
    // The camera rotation stays fixed (looking down -Z axis)
    let newX = this.camera.position.x + deltaX;
    let newY = this.camera.position.y + deltaY;
    
    // Clamp camera to scene bounds + margin
    // Prevent user from panning too far away and getting lost
    const width = this.foundrySceneData.width;
    const height = this.foundrySceneData.height;
    const marginX = Math.max(2000, width * 0.5);
    const marginY = Math.max(2000, height * 0.5);
    
    // Bounds: [-Margin, Width + Margin]
    newX = Math.max(-marginX, Math.min(newX, width + marginX));
    newY = Math.max(-marginY, Math.min(newY, height + marginY));
    
    this.camera.position.x = newX;
    this.camera.position.y = newY;
    
    // No need to call lookAt() - camera rotation is already set
    // and doesn't change during panning
    
    log.debug(`Camera pan to (${this.camera.position.x.toFixed(1)}, ${this.camera.position.y.toFixed(1)})`);
  }

  /**
   * Get Foundry-compatible zoom scale limits
   * Mirrors Foundry VTT's Canvas#getDimensions zoom calculation
   * @returns {{min: number, max: number}} Scale limits (1.0 = base zoom)
   * @private
   */
  getZoomLimits() {
    const { innerWidth, innerHeight } = window;
    const width = this.foundrySceneData.width;
    const height = this.foundrySceneData.height;
    const gridSize = this.foundrySceneData.gridSize;
    const padding = gridSize; // Use grid size as padding like Foundry
    
    // Min scale: fit entire padded scene in viewport
    // Matches Foundry: Math.min(innerWidth / paddedWidth, innerHeight / paddedHeight, 1)
    const paddedWidth = width + (2 * padding);
    const paddedHeight = height + (2 * padding);
    let minScale = CONFIG?.Canvas?.minZoom;
    if (minScale === undefined) {
      minScale = Math.min(innerWidth / paddedWidth, innerHeight / paddedHeight, 1);
    }
    
    // Max scale: zoom in to see ~3 grid cells
    // Matches Foundry: factor = 3 * (sourceGridSize / gridSize)
    // maxScale = Math.max(Math.min(innerWidth / gridSizeX, innerHeight / gridSizeY) / factor, minScale)
    let maxScale = CONFIG?.Canvas?.maxZoom;
    if (maxScale === undefined) {
      const factor = 3; // 3 grid cells visible at max zoom
      maxScale = Math.max(Math.min(innerWidth / gridSize, innerHeight / gridSize) / factor, minScale);
    }
    
    return { min: minScale, max: maxScale };
  }

  /**
   * Convert zoom scale to camera distance
   * Scale 1.0 = baseDistance, higher scale = closer camera
   * @param {number} scale - Zoom scale (1.0 = default)
   * @returns {number} Camera distance
   * @private
   */
  scaleToDistance(scale) {
    // scale = baseDistance / distance, so distance = baseDistance / scale
    return this.baseDistance / scale;
  }

  /**
   * Convert camera distance to zoom scale
   * @param {number} distance - Camera distance
   * @returns {number} Zoom scale
   * @private
   */
  distanceToScale(distance) {
    return this.baseDistance / distance;
  }

  /**
   * Zoom camera by factor (move closer/farther)
   * @param {number} zoomFactor - Zoom multiplier (>1 = zoom in, <1 = zoom out)
   * @param {number} centerX - Zoom center X in viewport space (0-1, default 0.5) - UNUSED for now
   * @param {number} centerY - Zoom center Y in viewport space (0-1, default 0.5) - UNUSED for now
   */
  zoom(zoomFactor, centerX = 0.5, centerY = 0.5) {
    if (!this.camera) return;

    // Get current scale and apply zoom factor
    const currentScale = this.distanceToScale(this.cameraDistance);
    let newScale = currentScale * zoomFactor;
    
    // Get Foundry-compatible zoom limits
    const limits = this.getZoomLimits();
    
    // Clamp scale to Foundry limits
    newScale = Math.max(limits.min, Math.min(newScale, limits.max));
    
    // Convert back to camera distance
    let newDistance = this.scaleToDistance(newScale);
    
    // Additional safety clamps for depth buffer
    // Min: 100 (keep above tokens at Z=10)
    // Max: 180000 (keep within far plane of 200000)
    newDistance = Math.max(100, Math.min(newDistance, 180000));
    
    // Update camera Z position
    this.camera.position.z = newDistance;
    this.cameraDistance = newDistance;
    
    // Dynamic Near Plane Optimization
    // Maintain healthy Far/Near ratio to preserve depth buffer precision
    // At high distances, a small near plane destroys precision
    this.camera.near = Math.max(10, newDistance * 0.1);
    this.camera.updateProjectionMatrix();
    
    // Camera rotation stays fixed (already looking down -Z)
    // No need to call lookAt()

    log.debug(`Camera zoom: scale ${newScale.toFixed(3)} (limits: ${limits.min.toFixed(3)}-${limits.max.toFixed(3)}), distance: ${newDistance.toFixed(0)}`);
  }

  /**
   * Get current zoom scale
   * @returns {number} Current zoom scale (1.0 = default)
   */
  getZoomScale() {
    if (!this.camera) return 1.0;
    return this.distanceToScale(this.cameraDistance);
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
