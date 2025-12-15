/**
 * @fileoverview Unified Camera Controller
 * 
 * THE SINGLE SOURCE OF TRUTH for camera state in Map Shine Advanced.
 * 
 * This controller solves the fundamental problem of having two rendering systems
 * (PIXI and Three.js) that both need synchronized cameras. Instead of having
 * separate controllers that fight each other, this unified system:
 * 
 * 1. Intercepts ALL pan/zoom input (from either canvas)
 * 2. Updates BOTH cameras atomically
 * 3. Provides a single API for camera manipulation
 * 
 * Architecture:
 * - Foundry's native controls (PIXI) → detected via canvasPan hook → sync to Three
 * - Three.js canvas input → CameraController → sync to PIXI
 * - Per-frame polling catches any drift
 * 
 * @module foundry/unified-camera
 */

import { createLogger } from '../core/log.js';

const log = createLogger('UnifiedCamera');

/**
 * Unified camera controller that keeps PIXI and Three.js cameras in perfect sync
 */
export class UnifiedCameraController {
  /**
   * @param {object} options
   * @param {import('../scene/composer.js').SceneComposer} options.sceneComposer
   * @param {HTMLCanvasElement} [options.threeCanvas] - Three.js canvas for input
   */
  constructor(options = {}) {
    const { sceneComposer, threeCanvas } = options;

    /** @type {import('../scene/composer.js').SceneComposer|null} */
    this.sceneComposer = sceneComposer || null;
    
    /** @type {HTMLCanvasElement|null} */
    this.threeCanvas = threeCanvas || null;
    
    /** @type {boolean} */
    this.enabled = true;
    
    /**
     * Last known camera state (in Foundry coordinates)
     * This is the authoritative state that both cameras should match
     * @type {{x: number, y: number, zoom: number}}
     */
    this.state = { x: 0, y: 0, zoom: 1 };
    
    /**
     * Track which system initiated the last change to prevent feedback loops
     * @type {'pixi'|'three'|null}
     */
    this._lastChangeSource = null;
    
    /**
     * Lock to prevent concurrent updates
     * @type {boolean}
     */
    this._updateLock = false;
    
    /**
     * Threshold for detecting significant changes
     * @type {number}
     */
    this.syncThreshold = 0.5;
    
    // Drag state for Three.js canvas input
    this._isDragging = false;
    this._lastMousePos = null;

    this._pendingRightDrag = false;
    this._rightDragStartPos = null;
    this._rightDragThresholdPx = 6;
    
    // Cooldown to prevent drift detection from fighting with user input
    // After any user-initiated zoom/pan, we skip drift detection for this many ms
    this._inputCooldownMs = 200;
    this._lastInputTime = 0;
    
    // Bound handlers
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onContextMenu = this._onContextMenu.bind(this);
    
    // Hook IDs for cleanup
    this._hookIds = [];
  }
  
  /**
   * Initialize the unified camera controller
   */
  initialize() {
    if (!this.sceneComposer?.camera) {
      log.error('Cannot initialize: SceneComposer or camera not available');
      return false;
    }
    
    // Read initial state from PIXI (Foundry is the source of truth at startup)
    this._readPixiState();
    
    // Apply initial state to Three.js camera
    this._applyToThree();
    
    // Attach Three.js canvas input handlers
    if (this.threeCanvas) {
      this._attachThreeInputHandlers();
    }
    
    // Register Foundry hooks to detect PIXI camera changes
    this._registerHooks();
    
    log.info('Unified camera controller initialized', {
      state: this.state,
      hasThreeCanvas: !!this.threeCanvas
    });
    
    return true;
  }
  
  /**
   * Read current camera state from PIXI stage
   * @private
   */
  _readPixiState() {
    if (!canvas?.ready || !canvas?.stage) return;
    
    const stage = canvas.stage;
    this.state.x = stage.pivot.x;
    this.state.y = stage.pivot.y;
    this.state.zoom = stage.scale.x || 1;
  }
  
  /**
   * Read current camera state from Three.js camera
   * @private
   */
  _readThreeState() {
    const camera = this.sceneComposer?.camera;
    if (!camera) return;
    
    const worldHeight = this._getWorldHeight();
    
    // Convert Three.js Y-up to Foundry Y-down
    this.state.x = camera.position.x;
    this.state.y = worldHeight - camera.position.y;
    
    // FOV-based zoom: read from sceneComposer.currentZoom
    // This is the authoritative zoom level for the FOV-zoom system
    if (this.sceneComposer.currentZoom !== undefined) {
      this.state.zoom = this.sceneComposer.currentZoom;
    } else if (camera.isOrthographicCamera) {
      this.state.zoom = camera.zoom;
    } else if (camera.isPerspectiveCamera) {
      // Legacy fallback
      const baseDistance = this.sceneComposer.baseDistance || 10000;
      this.state.zoom = baseDistance / camera.position.z;
    }
  }
  
  /**
   * Apply current state to PIXI stage
   * @private
   */
  _applyToPixi() {
    if (!canvas?.ready || !canvas?.stage) return;
    
    const stage = canvas.stage;
    
    // Update PIXI stage pivot and scale
    stage.pivot.x = this.state.x;
    stage.pivot.y = this.state.y;
    stage.scale.set(this.state.zoom, this.state.zoom);
    
    // Update stage position to keep pivot centered on screen
    const rect = canvas.app?.view?.getBoundingClientRect();
    if (rect) {
      stage.position.x = rect.width / 2;
      stage.position.y = rect.height / 2;
    }
  }
  
  /**
   * Apply current state to Three.js camera
   * @private
   */
  _applyToThree() {
    const camera = this.sceneComposer?.camera;
    if (!camera) return;
    
    const worldHeight = this._getWorldHeight();
    
    // Convert Foundry Y-down to Three.js Y-up
    camera.position.x = this.state.x;
    camera.position.y = worldHeight - this.state.y;
    // Z position stays fixed for FOV-based zoom
    
    // FOV-based zoom: adjust FOV instead of camera Z position
    // This keeps the ground plane at a constant depth in the frustum
    if (camera.isPerspectiveCamera && this.sceneComposer.baseFovTanHalf !== undefined) {
      const baseTan = this.sceneComposer.baseFovTanHalf;
      const zoom = this.state.zoom || 1;
      const fovRad = 2 * Math.atan(baseTan / zoom);
      const fovDeg = fovRad * (180 / Math.PI);
      const clamped = Math.max(1, Math.min(170, fovDeg));
      camera.fov = clamped;
      this.sceneComposer.currentZoom = zoom;
      camera.updateProjectionMatrix();
    } else if (camera.isOrthographicCamera) {
      // Fallback for orthographic camera
      camera.zoom = this.state.zoom;
      camera.updateProjectionMatrix();
    }
  }
  
  /**
   * Get world height for coordinate conversion
   * @private
   * @returns {number}
   */
  _getWorldHeight() {
    return this.sceneComposer?.foundrySceneData?.height ||
           canvas?.dimensions?.height ||
           1000;
  }
  
  /**
   * Pan the camera by a delta in Foundry world coordinates
   * @param {number} dx - Delta X in world units
   * @param {number} dy - Delta Y in world units
   * @param {string} [source='api'] - Source of the change
   */
  pan(dx, dy, source = 'api') {
    if (!this.enabled || this._updateLock) return;
    
    // Mark input time to prevent drift detection from fighting with pan
    if (source === 'three') {
      this._lastInputTime = performance.now();
    }
    
    this._updateLock = true;
    this._lastChangeSource = source;
    
    try {
      this.state.x += dx;
      this.state.y += dy;
      
      // Apply to both systems
      this._applyToPixi();
      this._applyToThree();
      
    } finally {
      this._updateLock = false;
    }
  }
  
  /**
   * Set the camera position in Foundry world coordinates
   * @param {number} x - World X
   * @param {number} y - World Y
   * @param {string} [source='api'] - Source of the change
   */
  setPosition(x, y, source = 'api') {
    if (!this.enabled || this._updateLock) return;
    
    this._updateLock = true;
    this._lastChangeSource = source;
    
    try {
      this.state.x = x;
      this.state.y = y;
      
      this._applyToPixi();
      this._applyToThree();
      
    } finally {
      this._updateLock = false;
    }
  }
  
  /**
   * Set the zoom level
   * @param {number} zoom - Zoom level (1 = 100%)
   * @param {string} [source='api'] - Source of the change
   */
  setZoom(zoom, source = 'api') {
    if (!this.enabled || this._updateLock) return;
    
    // Clamp zoom to reasonable bounds
    const limits = this._getZoomLimits();
    zoom = Math.max(limits.min, Math.min(limits.max, zoom));
    
    this._updateLock = true;
    this._lastChangeSource = source;
    
    try {
      this.state.zoom = zoom;
      
      this._applyToPixi();
      this._applyToThree();
      
    } finally {
      this._updateLock = false;
    }
  }
  
  /**
   * Zoom by a factor, optionally centered on a screen point
   * @param {number} factor - Zoom multiplier (>1 = zoom in, <1 = zoom out)
   * @param {number} [screenX=0.5] - Screen X position (0-1, 0.5 = center)
   * @param {number} [screenY=0.5] - Screen Y position (0-1, 0.5 = center)
   * @param {string} [source='api'] - Source of the change
   */
  zoomBy(factor, screenX = 0.5, screenY = 0.5, source = 'api') {
    if (!this.enabled || this._updateLock) return;
    
    // Mark input time to prevent drift detection from fighting with zoom
    if (source === 'three') {
      this._lastInputTime = performance.now();
    }
    
    const oldZoom = this.state.zoom;
    let newZoom = oldZoom * factor;
    
    // Clamp zoom
    const limits = this._getZoomLimits();
    newZoom = Math.max(limits.min, Math.min(limits.max, newZoom));
    
    if (Math.abs(newZoom - oldZoom) < 0.001) return;
    
    this._updateLock = true;
    this._lastChangeSource = source;
    
    try {
      // Calculate world position under cursor before zoom
      const rect = canvas?.app?.view?.getBoundingClientRect();
      if (rect) {
        const screenPosX = rect.width * screenX;
        const screenPosY = rect.height * screenY;
        
        // World position under cursor (Foundry coords)
        const worldX = this.state.x + (screenPosX - rect.width / 2) / oldZoom;
        const worldY = this.state.y + (screenPosY - rect.height / 2) / oldZoom;
        
        // After zoom, adjust pivot so world position stays under cursor
        this.state.x = worldX - (screenPosX - rect.width / 2) / newZoom;
        this.state.y = worldY - (screenPosY - rect.height / 2) / newZoom;
      }
      
      this.state.zoom = newZoom;
      
      this._applyToPixi();
      this._applyToThree();
      
    } finally {
      this._updateLock = false;
    }
  }
  
  /**
   * Get zoom limits based on scene dimensions
   * @private
   * @returns {{min: number, max: number}}
   */
  _getZoomLimits() {
    // Match Foundry's default zoom limits
    return { min: 0.1, max: 3.0 };
  }
  
  /**
   * Sync from PIXI to Three.js (called when Foundry moves the camera)
   * @param {string} [source='pixi'] - Source identifier
   */
  syncFromPixi(source = 'pixi') {
    if (!this.enabled || this._updateLock) return;
    
    // Don't sync if we just pushed a change to PIXI
    if (this._lastChangeSource === 'three') {
      this._lastChangeSource = null;
      return;
    }
    
    this._updateLock = true;
    
    try {
      const oldState = { ...this.state };
      this._readPixiState();
      
      // Check if significant change
      const dx = Math.abs(this.state.x - oldState.x);
      const dy = Math.abs(this.state.y - oldState.y);
      const dz = Math.abs(this.state.zoom - oldState.zoom);
      
      if (dx > this.syncThreshold || dy > this.syncThreshold || dz > 0.001) {
        this._applyToThree();
        log.debug(`Synced Three FROM PIXI (${source}): pos=(${this.state.x.toFixed(1)}, ${this.state.y.toFixed(1)}), zoom=${this.state.zoom.toFixed(3)}`);
      }
      
    } finally {
      this._updateLock = false;
    }
  }
  
  /**
   * Sync from Three.js to PIXI (called after Three.js camera moves)
   * @param {string} [source='three'] - Source identifier
   */
  syncFromThree(source = 'three') {
    if (!this.enabled || this._updateLock) return;
    
    // Don't sync if we just pushed a change to Three
    if (this._lastChangeSource === 'pixi') {
      this._lastChangeSource = null;
      return;
    }
    
    this._updateLock = true;
    
    try {
      const oldState = { ...this.state };
      this._readThreeState();
      
      // Check if significant change
      const dx = Math.abs(this.state.x - oldState.x);
      const dy = Math.abs(this.state.y - oldState.y);
      const dz = Math.abs(this.state.zoom - oldState.zoom);
      
      if (dx > this.syncThreshold || dy > this.syncThreshold || dz > 0.001) {
        this._applyToPixi();
        log.debug(`Synced PIXI FROM Three (${source}): pos=(${this.state.x.toFixed(1)}, ${this.state.y.toFixed(1)}), zoom=${this.state.zoom.toFixed(3)}`);
      }
      
    } finally {
      this._updateLock = false;
    }
  }
  
  /**
   * Per-frame update - detect drift and resync
   * Called from render loop
   */
  update() {
    if (!this.enabled || this._updateLock) return;
    if (!canvas?.ready || !canvas?.stage) return;
    
    // Skip drift detection during cooldown period after user input
    // This prevents the sync from fighting with zoom/pan operations
    const now = performance.now();
    if (now - this._lastInputTime < this._inputCooldownMs) {
      return;
    }
    
    // Also skip if user is actively dragging
    if (this._isDragging) {
      return;
    }
    
    // Read PIXI state and check for drift
    const stage = canvas.stage;
    const pixiX = stage.pivot.x;
    const pixiY = stage.pivot.y;
    const pixiZoom = stage.scale.x || 1;
    
    const dx = Math.abs(pixiX - this.state.x);
    const dy = Math.abs(pixiY - this.state.y);
    const dz = Math.abs(pixiZoom - this.state.zoom);
    
    // If PIXI has drifted from our state, it means Foundry moved it
    if (dx > this.syncThreshold || dy > this.syncThreshold || dz > 0.001) {
      this.syncFromPixi('frame-detect');
    }
  }
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Three.js Canvas Input Handlers
  // ─────────────────────────────────────────────────────────────────────────────
  
  /**
   * Attach input handlers to Three.js canvas
   * @private
   */
  _attachThreeInputHandlers() {
    if (!this.threeCanvas) return;
    
    this.threeCanvas.addEventListener('mousedown', this._onMouseDown);
    this.threeCanvas.addEventListener('mousemove', this._onMouseMove);
    this.threeCanvas.addEventListener('mouseup', this._onMouseUp);
    this.threeCanvas.addEventListener('mouseleave', this._onMouseUp);
    this.threeCanvas.addEventListener('wheel', this._onWheel, { passive: false });
    this.threeCanvas.addEventListener('contextmenu', this._onContextMenu);
    
    log.debug('Three.js canvas input handlers attached');
  }
  
  /**
   * Detach input handlers from Three.js canvas
   * @private
   */
  _detachThreeInputHandlers() {
    if (!this.threeCanvas) return;
    
    this.threeCanvas.removeEventListener('mousedown', this._onMouseDown);
    this.threeCanvas.removeEventListener('mousemove', this._onMouseMove);
    this.threeCanvas.removeEventListener('mouseup', this._onMouseUp);
    this.threeCanvas.removeEventListener('mouseleave', this._onMouseUp);
    this.threeCanvas.removeEventListener('wheel', this._onWheel);
    this.threeCanvas.removeEventListener('contextmenu', this._onContextMenu);
  }
  
  /**
   * Handle mouse down on Three.js canvas
   * @param {MouseEvent} event
   * @private
   */
  _onMouseDown(event) {
    if (!this.enabled) return;
    
    // Right mouse button for pan
    if (event.button === 2) {
      this._pendingRightDrag = true;
      this._rightDragStartPos = { x: event.clientX, y: event.clientY };
      this._isDragging = false;
      this._lastMousePos = null;
    }
  }
  
  /**
   * Handle mouse move on Three.js canvas
   * @param {MouseEvent} event
   * @private
   */
  _onMouseMove(event) {
    if (!this.enabled) return;

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
    
    // Convert screen delta to world delta
    const worldDelta = this._screenToWorldDelta(deltaX, deltaY);
    
    // Pan in Foundry coordinates (drag right = move camera left = decrease X)
    // Foundry Y is down, so drag down = move camera up = decrease Y
    this.pan(-worldDelta.x, -worldDelta.y, 'three');
    
    this._lastMousePos = { x: event.clientX, y: event.clientY };
    event.preventDefault();
  }
  
  /**
   * Handle mouse up
   * @param {MouseEvent} event
   * @private
   */
  _onMouseUp(event) {
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
   * Handle mouse wheel for zoom
   * @param {WheelEvent} event
   * @private
   */
  _onWheel(event) {
    if (!this.enabled) return;
    
    // Mark input time to prevent drift detection from fighting with zoom
    this._lastInputTime = performance.now();
    
    const factor = event.deltaY > 0 ? 0.9 : 1.1;
    
    const rect = this.threeCanvas.getBoundingClientRect();
    const screenX = (event.clientX - rect.left) / rect.width;
    const screenY = (event.clientY - rect.top) / rect.height;
    
    this.zoomBy(factor, screenX, screenY, 'three');
    
    event.preventDefault();
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
   * Convert screen delta to world delta
   * @param {number} screenDeltaX
   * @param {number} screenDeltaY
   * @returns {{x: number, y: number}}
   * @private
   */
  _screenToWorldDelta(screenDeltaX, screenDeltaY) {
    // World units per pixel = 1 / zoom
    const scale = 1 / this.state.zoom;
    return {
      x: screenDeltaX * scale,
      y: screenDeltaY * scale
    };
  }
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Foundry Hooks
  // ─────────────────────────────────────────────────────────────────────────────
  
  /**
   * Register Foundry hooks for detecting PIXI camera changes
   * @private
   */
  _registerHooks() {
    // canvasPan fires when Foundry's native controls move the camera
    const panHookId = Hooks.on('canvasPan', (canvas, position) => {
      this.syncFromPixi('canvasPan');
    });
    this._hookIds.push({ name: 'canvasPan', id: panHookId });
    
    // Also sync on sidebar collapse (viewport size change)
    const sidebarHookId = Hooks.on('collapseSidebar', () => {
      setTimeout(() => this.syncFromPixi('collapseSidebar'), 100);
    });
    this._hookIds.push({ name: 'collapseSidebar', id: sidebarHookId });
    
    log.debug(`Registered ${this._hookIds.length} camera hooks`);
  }
  
  /**
   * Unregister all hooks
   * @private
   */
  _unregisterHooks() {
    for (const { name, id } of this._hookIds) {
      Hooks.off(name, id);
    }
    this._hookIds = [];
  }
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────────
  
  /**
   * Enable the controller
   */
  enable() {
    this.enabled = true;
    log.debug('Unified camera controller enabled');
  }
  
  /**
   * Disable the controller
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
    log.debug('Unified camera controller disabled');
  }
  
  /**
   * Clean up resources
   */
  dispose() {
    this.disable();
    this._detachThreeInputHandlers();
    this._unregisterHooks();
    log.info('Unified camera controller disposed');
  }
  
  /**
   * Get current state for debugging
   * @returns {object}
   */
  getState() {
    return {
      enabled: this.enabled,
      state: { ...this.state },
      isDragging: this._isDragging,
      lastChangeSource: this._lastChangeSource
    };
  }
}
