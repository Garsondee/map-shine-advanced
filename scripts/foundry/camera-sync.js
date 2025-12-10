/**
 * @fileoverview Camera Sync - Synchronizes Three.js camera with PIXI stage
 * PIXI is the master (Foundry controls it), Three.js follows
 * Implements reliable sync with debouncing and validation
 * @module foundry/camera-sync
 */

import { createLogger } from '../core/log.js';

const log = createLogger('CameraSync');

/**
 * Synchronizes the Three.js camera with the PIXI stage transform
 * PIXI is the master (controlled by Foundry's native pan/zoom) - Three.js follows
 */
export class CameraSync {
  /**
   * @param {object} options
   * @param {import('../scene/composer.js').SceneComposer} options.sceneComposer
   */
  constructor(options = {}) {
    /** @type {import('../scene/composer.js').SceneComposer|null} */
    this.sceneComposer = options.sceneComposer || null;
    
    /**
     * Minimum change threshold to trigger sync (prevents micro-updates)
     * @type {number}
     */
    this.syncThreshold = 0.001;
    
    /**
     * Last synced position
     * @type {{x: number, y: number, zoom: number}}
     */
    this.lastPosition = { x: 0, y: 0, zoom: 1 };
    
    /**
     * Lock to prevent concurrent syncs
     * @type {boolean}
     */
    this._syncLock = false;
    
    /**
     * Pending sync source (if sync was requested while locked)
     * @type {string|null}
     */
    this._pendingSync = null;
    
    /**
     * Debounce timeout handle
     * @type {number|null}
     */
    this._syncTimeout = null;
    
    /**
     * Last sync timestamp
     * @type {number}
     */
    this.lastSyncTime = 0;
    
    /**
     * Sync statistics for debugging
     * @type {{total: number, skipped: number, forced: number}}
     */
    this._stats = { total: 0, skipped: 0, forced: 0 };
  }
  
  /**
   * Set the scene composer reference
   * @param {import('../scene/composer.js').SceneComposer} sceneComposer
   */
  setSceneComposer(sceneComposer) {
    this.sceneComposer = sceneComposer;
  }
  
  /**
   * Request a camera sync (debounced)
   * @param {string} [source='unknown'] - Source of the sync request
   */
  requestSync(source = 'unknown') {
    if (this._syncLock) {
      // Queue for later
      this._pendingSync = source;
      return;
    }
    
    // Debounce: wait for rapid changes to settle
    clearTimeout(this._syncTimeout);
    this._syncTimeout = setTimeout(() => {
      this.performSync(source);
    }, 16); // ~60fps
  }
  
  /**
   * Perform the actual camera sync - syncs Three.js camera FROM PIXI stage
   * PIXI is master (controlled by Foundry), Three.js follows
   * @param {string} [source='unknown']
   * @private
   */
  performSync(source = 'unknown') {
    if (this._syncLock) {
      this._pendingSync = source;
      return;
    }
    
    this._syncLock = true;
    this._stats.total++;
    
    try {
      if (!canvas?.ready || !canvas?.stage || !canvas?.app?.view) {
        log.debug('Canvas not ready for sync');
        return;
      }
      
      if (!this.sceneComposer?.camera) {
        log.debug('Scene composer camera not available');
        return;
      }
      
      const camera = this.sceneComposer.camera;
      const stage = canvas.stage;
      
      // Read PIXI stage state (Foundry is master)
      // Foundry uses: stage.pivot = world coordinate at screen center
      //               stage.scale = zoom level
      const pixiPivotX = stage.pivot.x;
      const pixiPivotY = stage.pivot.y;
      const pixiZoom = stage.scale.x; // Assume uniform scale
      
      // Get world height for Y coordinate conversion
      const worldHeight = this.sceneComposer.foundrySceneData?.height || 
                          canvas.dimensions?.height || 
                          canvas.scene?.dimensions?.height || 
                          1000;
      
      // Convert Foundry Y-down to Three.js Y-up
      // In Foundry: pivot at Y=0 shows top, Y=height shows bottom
      // In Three.js: camera at Y=0 sees bottom, Y=height sees top
      const threeX = pixiPivotX;
      const threeY = worldHeight - pixiPivotY;
      
      // Check if change is significant
      const dx = Math.abs(threeX - this.lastPosition.x);
      const dy = Math.abs(threeY - this.lastPosition.y);
      const dz = Math.abs(pixiZoom - this.lastPosition.zoom);
      
      if (dx < this.syncThreshold && dy < this.syncThreshold && dz < this.syncThreshold) {
        // No significant change
        this._stats.skipped++;
        return;
      }
      
      // Update Three.js camera position
      camera.position.x = threeX;
      camera.position.y = threeY;
      
      // Update Three.js camera zoom via FOV (camera Z stays fixed)
      // This keeps the ground plane at a constant depth in the frustum
      if (camera.isPerspectiveCamera && this.sceneComposer.baseFovTanHalf !== undefined) {
        const baseTan = this.sceneComposer.baseFovTanHalf;
        const zoom = pixiZoom || 1;
        const fovRad = 2 * Math.atan(baseTan / zoom);
        const fovDeg = fovRad * (180 / Math.PI);
        const clamped = Math.max(1, Math.min(170, fovDeg));
        camera.fov = clamped;
        this.sceneComposer.currentZoom = zoom;
        camera.updateProjectionMatrix();
      } else if (camera.isOrthographicCamera) {
        camera.zoom = pixiZoom;
        camera.updateProjectionMatrix();
      }
      
      // Record state
      this.lastPosition = { x: threeX, y: threeY, zoom: pixiZoom };
      this.lastSyncTime = performance.now();
      
      log.debug(`Synced Three.js FROM PIXI (${source}): pos=(${threeX.toFixed(1)}, ${threeY.toFixed(1)}), zoom=${pixiZoom.toFixed(3)}`);
      
      // Emit hook
      Hooks.callAll('mapShineCameraSync', { 
        position: { x: threeX, y: threeY },
        zoom: pixiZoom,
        source
      });
      
    } catch (error) {
      log.error('Camera sync failed:', error);
      // Don't throw - camera sync failures shouldn't crash the system
    } finally {
      this._syncLock = false;
      
      // Process pending sync if any
      if (this._pendingSync) {
        const pending = this._pendingSync;
        this._pendingSync = null;
        this.requestSync(pending);
      }
    }
  }
  
  /**
   * Force a full sync (bypasses threshold check)
   */
  forceFullSync() {
    this._stats.forced++;
    this.lastPosition = { x: 0, y: 0, zoom: 0 }; // Reset threshold check
    this.performSync('force');
  }
  
  /**
   * Validate that PIXI stage matches Three.js camera
   * @returns {{valid: boolean, expected: object, actual: object, delta: object}}
   */
  validateSync() {
    if (!canvas?.ready || !canvas?.stage || !this.sceneComposer?.camera) {
      return { valid: false, error: 'Canvas or camera not available' };
    }
    
    const camera = this.sceneComposer.camera;
    const stage = canvas.stage;
    const rect = canvas.app.view.getBoundingClientRect();
    
    // Calculate expected values
    let expectedZoom;
    if (camera.isOrthographicCamera) {
      expectedZoom = camera.zoom;
    } else {
      const baseDistance = this.sceneComposer.baseDistance || 1000;
      expectedZoom = baseDistance / camera.position.z;
    }
    
    const expectedX = (rect.width / 2) - (camera.position.x * expectedZoom);
    const expectedY = (rect.height / 2) - (camera.position.y * expectedZoom);
    
    // Get actual values
    const actualZoom = stage.scale.x;
    const actualX = stage.position.x;
    const actualY = stage.position.y;
    
    // Calculate deltas
    const deltaX = Math.abs(expectedX - actualX);
    const deltaY = Math.abs(expectedY - actualY);
    const deltaZoom = Math.abs(expectedZoom - actualZoom);
    
    // Tolerance: 1 pixel for position, 0.01 for zoom
    const valid = deltaX < 1 && deltaY < 1 && deltaZoom < 0.01;
    
    return {
      valid,
      expected: { x: expectedX, y: expectedY, zoom: expectedZoom },
      actual: { x: actualX, y: actualY, zoom: actualZoom },
      delta: { x: deltaX, y: deltaY, zoom: deltaZoom }
    };
  }
  
  /**
   * Sync PIXI stage to a specific position (for testing)
   * @param {number} x - World X position
   * @param {number} y - World Y position
   * @param {number} zoom - Zoom level
   */
  syncToPosition(x, y, zoom) {
    if (!canvas?.ready || !canvas?.stage || !canvas?.app?.view) return;
    
    const rect = canvas.app.view.getBoundingClientRect();
    const stage = canvas.stage;
    
    const stageX = (rect.width / 2) - (x * zoom);
    const stageY = (rect.height / 2) - (y * zoom);
    
    stage.scale.set(zoom, zoom);
    stage.position.set(stageX, stageY);
    
    this.lastPosition = { x, y, zoom };
    this.lastSyncTime = performance.now();
    
    log.debug(`Manual sync: pos=(${x}, ${y}), zoom=${zoom}`);
  }
  
  /**
   * Get sync statistics
   * @returns {object}
   */
  getStats() {
    return {
      ...this._stats,
      lastSyncTime: this.lastSyncTime,
      lastPosition: { ...this.lastPosition },
      syncLocked: this._syncLock,
      pendingSync: this._pendingSync
    };
  }
  
  /**
   * Reset statistics
   */
  resetStats() {
    this._stats = { total: 0, skipped: 0, forced: 0 };
  }
  
  /**
   * Update method - called from render loop or effect composer
   * Checks if PIXI stage has moved and syncs Three.js camera to match IMMEDIATELY
   * This runs every frame, so we bypass debouncing for real-time sync
   * @param {number} [deltaTime] - Time since last frame (unused)
   */
  update(deltaTime) {
    // Only sync if we have valid canvas and scene composer
    if (!canvas?.ready || !canvas?.stage || !this.sceneComposer?.camera) return;
    
    // Skip if sync is locked (another sync in progress)
    if (this._syncLock) return;
    
    const stage = canvas.stage;
    const camera = this.sceneComposer.camera;
    
    // Read PIXI stage state
    const pixiPivotX = stage.pivot.x;
    const pixiPivotY = stage.pivot.y;
    const pixiZoom = stage.scale.x;
    
    // Get world height for Y coordinate conversion
    const worldHeight = this.sceneComposer.foundrySceneData?.height || 
                        canvas.dimensions?.height || 
                        1000;
    
    // Convert to Three.js coordinates
    const threeX = pixiPivotX;
    const threeY = worldHeight - pixiPivotY;
    
    // Check if change is significant
    const dx = Math.abs(threeX - this.lastPosition.x);
    const dy = Math.abs(threeY - this.lastPosition.y);
    const dz = Math.abs(pixiZoom - this.lastPosition.zoom);
    
    if (dx > this.syncThreshold || dy > this.syncThreshold || dz > this.syncThreshold) {
      // IMMEDIATE sync - no debouncing for per-frame updates
      // This ensures Three.js camera follows PIXI in real-time during panning
      camera.position.x = threeX;
      camera.position.y = threeY;
      
      // Update zoom via FOV (camera Z stays fixed)
      // This keeps the ground plane at a constant depth in the frustum
      if (camera.isPerspectiveCamera && this.sceneComposer.baseFov !== undefined) {
        const baseFov = this.sceneComposer.baseFov;
        const newFov = Math.max(1, Math.min(170, baseFov / pixiZoom));
        camera.fov = newFov;
        this.sceneComposer.currentZoom = pixiZoom;
        camera.updateProjectionMatrix();
      } else if (camera.isOrthographicCamera) {
        camera.zoom = pixiZoom;
        camera.updateProjectionMatrix();
      }
      
      // Record state
      this.lastPosition = { x: threeX, y: threeY, zoom: pixiZoom };
      this._stats.total++;
    }
  }
}
