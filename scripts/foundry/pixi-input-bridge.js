/**
 * @fileoverview PIXI Input Bridge
 * 
 * Handles pan/zoom input on the Three.js canvas and applies it directly to
 * Foundry's PIXI stage. This keeps PIXI as the single source of truth for
 * camera state, while CameraFollower mirrors that into Three.js.
 * 
 * Input flow:
 * 1. User right-drags or scrolls on Three canvas
 * 2. This bridge updates canvas.stage.pivot / scale
 * 3. CameraFollower reads stage state and updates Three camera
 * 
 * @module foundry/pixi-input-bridge
 */

import { createLogger } from '../core/log.js';

const log = createLogger('PixiInputBridge');

/**
 * Input bridge that forwards Three canvas input to PIXI stage
 */
export class PixiInputBridge {
  /**
   * @param {HTMLCanvasElement} threeCanvas - The Three.js canvas element
   */
  constructor(threeCanvas) {
    /** @type {HTMLCanvasElement} */
    this.threeCanvas = threeCanvas;
    
    /** @type {boolean} */
    this.enabled = true;
    
    /** @type {boolean} */
    this._isDragging = false;

    /** @type {boolean} */
    this._pendingRightDrag = false;

    /** @type {{x: number, y: number}|null} */
    this._rightDragStartPos = null;

    /** @type {number} */
    this._rightDragThresholdPx = 6;
    
    /** @type {{x: number, y: number}|null} */
    this._lastMousePos = null;
    
    // Bind handlers
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onContextMenu = this._onContextMenu.bind(this);
  }

  _isEventFromOverlayUI(event) {
    try {
      const target = event?.target;
      const path = (event && typeof event.composedPath === 'function') ? event.composedPath() : null;
      const elements = Array.isArray(path)
        ? path.filter((n) => n instanceof Element)
        : (target instanceof Element ? [target] : []);

      for (const el of elements) {
        if (el.closest('#map-shine-overlay-root, #map-shine-light-ring')) return true;
        if (el.closest('[data-overlay-id], .map-shine-overlay-ui')) return true;
      }

      return false;
    } catch (_) {
      return false;
    }
  }
  
  /**
   * Initialize the input bridge
   * @returns {boolean} Success
   */
  initialize() {
    if (!this.threeCanvas) {
      log.error('Cannot initialize: no Three canvas provided');
      return false;
    }
    
    this._attachListeners();
    log.info('PIXI input bridge initialized');
    return true;
  }
  
  /**
   * Attach event listeners to Three canvas
   * @private
   */
  _attachListeners() {
    this.threeCanvas.addEventListener('mousedown', this._onMouseDown);
    this.threeCanvas.addEventListener('mousemove', this._onMouseMove);
    this.threeCanvas.addEventListener('mouseup', this._onMouseUp);
    this.threeCanvas.addEventListener('mouseleave', this._onMouseUp);
    this.threeCanvas.addEventListener('wheel', this._onWheel, { passive: false });
    this.threeCanvas.addEventListener('contextmenu', this._onContextMenu);
  }
  
  /**
   * Detach event listeners
   * @private
   */
  _detachListeners() {
    if (!this.threeCanvas) return;
    
    this.threeCanvas.removeEventListener('mousedown', this._onMouseDown);
    this.threeCanvas.removeEventListener('mousemove', this._onMouseMove);
    this.threeCanvas.removeEventListener('mouseup', this._onMouseUp);
    this.threeCanvas.removeEventListener('mouseleave', this._onMouseUp);
    this.threeCanvas.removeEventListener('wheel', this._onWheel);
    this.threeCanvas.removeEventListener('contextmenu', this._onContextMenu);
  }
  
  /**
   * Get zoom limits from Foundry config or use defaults
   * @private
   * @returns {{min: number, max: number}}
   */
  _getZoomLimits() {
    const min = CONFIG?.Canvas?.minZoom ?? 0.1;
    const max = CONFIG?.Canvas?.maxZoom ?? 3.0;
    return { min, max };
  }
  
  /**
   * Handle mouse down - start pan on right click
   * @param {MouseEvent} event
   * @private
   */
  _onMouseDown(event) {
    if (!this.enabled) return;

    if (this._isEventFromOverlayUI(event)) {
      this._pendingRightDrag = false;
      this._rightDragStartPos = null;
      this._isDragging = false;
      this._lastMousePos = null;
      return;
    }
    
    // Right mouse button for pan
    if (event.button === 2) {
      this._pendingRightDrag = true;
      this._rightDragStartPos = { x: event.clientX, y: event.clientY };
      this._isDragging = false;
      this._lastMousePos = null;
    }
  }
  
  /**
   * Handle mouse move - pan while dragging
   * @param {MouseEvent} event
   * @private
   */
  _onMouseMove(event) {
    if (!this.enabled) return;
    if (!canvas?.stage) return;

    if (this._isEventFromOverlayUI(event)) {
      return;
    }

    if (this._pendingRightDrag && this._rightDragStartPos) {
      const dist = Math.hypot(
        event.clientX - this._rightDragStartPos.x,
        event.clientY - this._rightDragStartPos.y
      );

      if (dist > this._rightDragThresholdPx) {
        this._pendingRightDrag = false;
        this._rightDragStartPos = null;
        this._isDragging = true;
        this._lastMousePos = { x: event.clientX, y: event.clientY };
        this.threeCanvas.style.cursor = 'grabbing';
        event.preventDefault();
      } else {
        return;
      }
    }

    if (!this._isDragging || !this._lastMousePos) return;
    
    const deltaX = event.clientX - this._lastMousePos.x;
    const deltaY = event.clientY - this._lastMousePos.y;
    
    // Get current zoom from PIXI stage
    const zoom = canvas.stage.scale.x || 1;
    
    // Convert screen pixels to world units
    const worldDx = deltaX / zoom;
    const worldDy = deltaY / zoom;
    
    // Update PIXI stage pivot (drag right = move view left = decrease pivot.x)
    canvas.stage.pivot.x -= worldDx;
    canvas.stage.pivot.y -= worldDy;
    
    this._lastMousePos = { x: event.clientX, y: event.clientY };
    event.preventDefault();
  }
  
  /**
   * Handle mouse up - end pan
   * @param {MouseEvent} event
   * @private
   */
  _onMouseUp(event) {
    if (this._isEventFromOverlayUI(event)) {
      this._pendingRightDrag = false;
      this._rightDragStartPos = null;
    }

    if (this._isDragging) {
      this._isDragging = false;
      this._lastMousePos = null;
      if (this.threeCanvas) {
        this.threeCanvas.style.cursor = 'default';
      }
    }

    this._pendingRightDrag = false;
    this._rightDragStartPos = null;
  }
  
  /**
   * Handle wheel - zoom towards cursor
   * @param {WheelEvent} event
   * @private
   */
  _onWheel(event) {
    if (!this.enabled) return;
    if (!canvas?.stage || !canvas?.app?.view) return;

    if (this._isEventFromOverlayUI(event)) {
      return;
    }
    
    // Modifier-wheel is reserved for object interactions (rotate/scale) via InteractionManager.
    // Avoid zoom conflicts by ignoring Ctrl/Shift wheel here.
    if (event.ctrlKey || event.shiftKey) return;
    
    event.preventDefault();
    
    // Zoom factor: scroll down = zoom out, scroll up = zoom in
    const factor = event.deltaY > 0 ? 0.9 : 1.1;
    
    // Get current zoom
    const oldZoom = canvas.stage.scale.x || 1;
    
    // Calculate new zoom with limits
    const limits = this._getZoomLimits();
    let newZoom = oldZoom * factor;
    newZoom = Math.max(limits.min, Math.min(limits.max, newZoom));
    
    // Skip if no significant change
    if (Math.abs(newZoom - oldZoom) < 0.001) return;
    
    // Get viewport rect
    const rect = canvas.app.view.getBoundingClientRect();
    
    // Mouse position relative to viewport
    const screenPosX = event.clientX - rect.left;
    const screenPosY = event.clientY - rect.top;
    
    // Calculate world position under cursor before zoom
    // PIXI stage: pivot is the world point at screen center
    // World point at cursor = pivot + (cursor offset from center) / zoom
    const worldX = canvas.stage.pivot.x + (screenPosX - rect.width / 2) / oldZoom;
    const worldY = canvas.stage.pivot.y + (screenPosY - rect.height / 2) / oldZoom;
    
    // After zoom, adjust pivot so world point stays under cursor
    // New pivot = worldPoint - (cursor offset from center) / newZoom
    canvas.stage.pivot.x = worldX - (screenPosX - rect.width / 2) / newZoom;
    canvas.stage.pivot.y = worldY - (screenPosY - rect.height / 2) / newZoom;
    
    // Apply new zoom
    canvas.stage.scale.set(newZoom, newZoom);
    
    // Also update stage position to keep pivot centered
    canvas.stage.position.x = rect.width / 2;
    canvas.stage.position.y = rect.height / 2;
  }
  
  /**
   * Prevent context menu on right click
   * @param {MouseEvent} event
   * @private
   */
  _onContextMenu(event) {
    if (this.enabled) {
      event.preventDefault();
    }
  }
  
  /**
   * Enable the input bridge
   */
  enable() {
    this.enabled = true;
    log.debug('PIXI input bridge enabled');
  }
  
  /**
   * Disable the input bridge
   */
  disable() {
    this.enabled = false;
    this._isDragging = false;
    this._lastMousePos = null;
    this._pendingRightDrag = false;
    this._rightDragStartPos = null;
    if (this.threeCanvas) {
      this.threeCanvas.style.cursor = 'default';
    }
    log.debug('PIXI input bridge disabled');
  }
  
  /**
   * Clean up resources
   */
  dispose() {
    this.disable();
    this._detachListeners();
    log.info('PIXI input bridge disposed');
  }
}
