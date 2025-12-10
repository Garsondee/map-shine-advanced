/**
 * @fileoverview Camera Follower
 * 
 * Simple one-way camera sync: Three.js follows PIXI.
 * 
 * Instead of trying to bidirectionally sync two camera systems (which causes
 * race conditions and drift), we let Foundry's PIXI canvas be the single source
 * of truth for camera state. The Three.js camera simply reads from PIXI each
 * frame and matches it.
 * 
 * This eliminates:
 * - Input handlers on Three.js canvas (let PIXI handle all pan/zoom input)
 * - Bidirectional sync logic
 * - Drift detection and correction
 * - Race conditions between systems
 * 
 * @module foundry/camera-follower
 */

import { createLogger } from '../core/log.js';

const log = createLogger('CameraFollower');

/**
 * Simple camera follower - Three.js follows PIXI
 */
export class CameraFollower {
  /**
   * @param {object} options
   * @param {import('../scene/composer.js').SceneComposer} options.sceneComposer
   */
  constructor(options = {}) {
    /** @type {import('../scene/composer.js').SceneComposer|null} */
    this.sceneComposer = options.sceneComposer || null;
    
    /** @type {boolean} */
    this.enabled = true;
    
    /** @type {boolean} */
    this._initialized = false;
    
    // Cache last known state to avoid unnecessary updates
    this._lastX = 0;
    this._lastY = 0;
    this._lastZoom = 1;
  }
  
  /**
   * Initialize the camera follower
   * @returns {boolean} Success
   */
  initialize() {
    if (!this.sceneComposer?.camera) {
      log.error('Cannot initialize: SceneComposer or camera not available');
      return false;
    }
    
    // Force initial sync (bypass threshold check)
    this.forceSync();
    
    this._initialized = true;
    log.info('Camera follower initialized - Three.js will follow PIXI');
    
    return true;
  }
  
  /**
   * Per-frame update - read PIXI state and apply to Three.js
   * Called from render loop via effectComposer.addUpdatable()
   */
  update() {
    if (!this.enabled || !this._initialized) return;
    if (!canvas?.ready || !canvas?.stage) return;
    
    this._syncFromPixi();
  }
  
  /**
   * Read PIXI camera state and apply to Three.js
   * @private
   */
  _syncFromPixi() {
    const stage = canvas?.stage;
    if (!stage) return;
    
    const camera = this.sceneComposer?.camera;
    if (!camera) return;
    
    // Read PIXI state
    const pixiX = stage.pivot.x;
    const pixiY = stage.pivot.y;
    const pixiZoom = stage.scale.x || 1;
    
    // Check if anything changed (avoid unnecessary updates)
    const dx = Math.abs(pixiX - this._lastX);
    const dy = Math.abs(pixiY - this._lastY);
    const dz = Math.abs(pixiZoom - this._lastZoom);
    
    if (dx < 0.1 && dy < 0.1 && dz < 0.0001) {
      return; // No significant change
    }
    
    // Update cache
    this._lastX = pixiX;
    this._lastY = pixiY;
    this._lastZoom = pixiZoom;
    
    // Get world height for Y coordinate conversion
    const worldHeight = this.sceneComposer?.foundrySceneData?.height ||
                        canvas?.dimensions?.height ||
                        1000;
    
    // Apply to Three.js camera
    // Foundry: Y-down, pivot is center of view
    // Three.js: Y-up, position is center of view
    camera.position.x = pixiX;
    camera.position.y = worldHeight - pixiY;
    // Z position stays fixed for FOV-based zoom
    
    // FOV-based zoom: adjust FOV instead of camera Z position
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
  }
  
  /**
   * Force an immediate sync (useful after scene changes)
   */
  forceSync() {
    // Reset cache to force sync on next call
    this._lastX = -999999;
    this._lastY = -999999;
    this._lastZoom = -999999;
    
    // Immediately sync
    this._syncFromPixi();
    
    // Log the sync for debugging
    const stage = canvas?.stage;
    const camera = this.sceneComposer?.camera;
    const worldHeight = this.sceneComposer?.foundrySceneData?.height || 0;
    if (stage && camera) {
      log.info(`Force sync: PIXI pivot=(${stage.pivot.x.toFixed(1)}, ${stage.pivot.y.toFixed(1)}), zoom=${stage.scale.x.toFixed(3)}`);
      log.info(`Force sync: Three pos=(${camera.position.x.toFixed(1)}, ${camera.position.y.toFixed(1)}, ${camera.position.z.toFixed(1)}), FOV=${camera.fov?.toFixed(2) || 'N/A'}°`);
      log.info(`Force sync: worldHeight=${worldHeight}, baseFov=${this.sceneComposer?.baseFov?.toFixed(2) || 'N/A'}°, currentZoom=${this.sceneComposer?.currentZoom?.toFixed(3) || 'N/A'}`);
    }
  }
  
  /**
   * Enable the follower
   */
  enable() {
    this.enabled = true;
    this.forceSync();
    log.debug('Camera follower enabled');
  }
  
  /**
   * Disable the follower
   */
  disable() {
    this.enabled = false;
    log.debug('Camera follower disabled');
  }
  
  /**
   * Clean up resources
   */
  dispose() {
    this.enabled = false;
    this._initialized = false;
    log.info('Camera follower disposed');
  }
  
  /**
   * Get current state for debugging
   * @returns {object}
   */
  getState() {
    return {
      enabled: this.enabled,
      initialized: this._initialized,
      lastX: this._lastX,
      lastY: this._lastY,
      lastZoom: this._lastZoom
    };
  }
}
