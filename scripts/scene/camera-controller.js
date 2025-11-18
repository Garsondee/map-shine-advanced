/**
 * @fileoverview Camera controller - handles user input for camera movement
 * Provides right-click drag panning and scroll wheel zoom
 * @module scene/camera-controller
 */

import { createLogger } from '../core/log.js';

const log = createLogger('CameraController');

/**
 * Camera controller class - manages camera input and movement
 */
export class CameraController {
  /**
   * @param {HTMLCanvasElement} canvas - The three.js canvas element
   * @param {SceneComposer} sceneComposer - Scene composer with camera
   */
  constructor(canvas, sceneComposer) {
    this.canvas = canvas;
    this.sceneComposer = sceneComposer;
    
    /** @type {boolean} */
    this.isDragging = false;
    
    /** @type {{x: number, y: number}|null} */
    this.lastMousePos = null;
    
    /** @type {boolean} */
    this.enabled = true;
    
    // Bind event handlers
    this.onMouseDown = this.onMouseDown.bind(this);
    this.onMouseMove = this.onMouseMove.bind(this);
    this.onMouseUp = this.onMouseUp.bind(this);
    this.onContextMenu = this.onContextMenu.bind(this);
    this.onWheel = this.onWheel.bind(this);
    
    this.attachListeners();
    log.info('Camera controller initialized');
  }
  
  /**
   * Attach event listeners to canvas
   * @private
   */
  attachListeners() {
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    this.canvas.addEventListener('mousemove', this.onMouseMove);
    this.canvas.addEventListener('mouseup', this.onMouseUp);
    this.canvas.addEventListener('mouseleave', this.onMouseUp); // Stop drag on mouse leave
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }
  
  /**
   * Remove event listeners from canvas
   * @private
   */
  detachListeners() {
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    this.canvas.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('mouseup', this.onMouseUp);
    this.canvas.removeEventListener('mouseleave', this.onMouseUp);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.canvas.removeEventListener('wheel', this.onWheel);
  }
  
  /**
   * Handle mouse down event
   * @param {MouseEvent} event
   * @private
   */
  onMouseDown(event) {
    if (!this.enabled) return;
    
    // Right mouse button (button === 2)
    if (event.button === 2) {
      this.isDragging = true;
      this.lastMousePos = { x: event.clientX, y: event.clientY };
      this.canvas.style.cursor = 'grabbing';
      event.preventDefault();
    }
  }
  
  /**
   * Handle mouse move event
   * @param {MouseEvent} event
   * @private
   */
  onMouseMove(event) {
    if (!this.enabled || !this.isDragging || !this.lastMousePos) return;
    
    const deltaX = event.clientX - this.lastMousePos.x;
    const deltaY = event.clientY - this.lastMousePos.y;
    
    // Convert screen-space delta to world-space delta
    const worldDelta = this.screenToWorldDelta(deltaX, deltaY);
    
    // Pan camera (invert both axes: drag right = pan left, drag down = pan up)
    this.sceneComposer.pan(-worldDelta.x, worldDelta.y);
    
    this.lastMousePos = { x: event.clientX, y: event.clientY };
    event.preventDefault();
  }
  
  /**
   * Handle mouse up event
   * @param {MouseEvent} event
   * @private
   */
  onMouseUp(event) {
    if (this.isDragging) {
      this.isDragging = false;
      this.lastMousePos = null;
      this.canvas.style.cursor = 'default';
    }
  }
  
  /**
   * Prevent context menu on right click
   * @param {MouseEvent} event
   * @private
   */
  onContextMenu(event) {
    if (!this.enabled) return;
    event.preventDefault();
  }
  
  /**
   * Handle mouse wheel event for zoom
   * @param {WheelEvent} event
   * @private
   */
  onWheel(event) {
    if (!this.enabled) return;
    
    // Zoom factor: scroll down = zoom out, scroll up = zoom in
    const zoomDelta = event.deltaY > 0 ? 0.9 : 1.1;
    
    // Get mouse position relative to canvas for zoom center
    const rect = this.canvas.getBoundingClientRect();
    const centerX = (event.clientX - rect.left) / rect.width;
    const centerY = (event.clientY - rect.top) / rect.height;
    
    this.sceneComposer.zoom(zoomDelta, centerX, centerY);
    
    event.preventDefault();
  }
  
  /**
   * Convert screen-space delta (pixels) to world-space delta (world units)
   * @param {number} screenDeltaX - Pixel delta X
   * @param {number} screenDeltaY - Pixel delta Y
   * @returns {{x: number, y: number}} World-space delta
   * @private
   */
  screenToWorldDelta(screenDeltaX, screenDeltaY) {
    const camera = this.sceneComposer.camera;
    if (!camera) return { x: 0, y: 0 };
    
    const rect = this.canvas.getBoundingClientRect();
    const canvasWidth = rect.width;
    const canvasHeight = rect.height;
    
    // Get camera frustum size in world units
    const frustumWidth = camera.right - camera.left;
    const frustumHeight = camera.top - camera.bottom;
    
    // Convert pixel delta to world delta
    const worldDeltaX = (screenDeltaX / canvasWidth) * frustumWidth;
    const worldDeltaY = (screenDeltaY / canvasHeight) * frustumHeight;
    
    return { x: worldDeltaX, y: worldDeltaY };
  }
  
  /**
   * Enable camera controls
   */
  enable() {
    this.enabled = true;
    log.debug('Camera controls enabled');
  }
  
  /**
   * Disable camera controls
   */
  disable() {
    this.enabled = false;
    this.isDragging = false;
    this.lastMousePos = null;
    this.canvas.style.cursor = 'default';
    log.debug('Camera controls disabled');
  }
  
  /**
   * Dispose controller and remove listeners
   */
  dispose() {
    this.detachListeners();
    this.isDragging = false;
    this.lastMousePos = null;
    log.info('Camera controller disposed');
  }
}
