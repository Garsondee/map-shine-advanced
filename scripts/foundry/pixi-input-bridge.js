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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function asNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

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

    /** @type {(function(): boolean)|null} */
    this._inputBlocker = null;

    /** @type {(function({x:number, y:number, scale:number}, string): {x:number, y:number, scale:number}|null|undefined)|null} */
    this._viewConstraintProvider = null;

    /** @type {(function(string): void)|null} */
    this._userInputCallback = null;

    /** @type {(function(): {enabled?:boolean, panHz?:number, zoomHz?:number}|null|undefined)|null} */
    this._motionSmoothingProvider = null;

    /** @type {{x: number, y: number}|null} */
    this._lastMousePos = null;

    /** @type {{x:number, y:number, scale:number}|null} */
    this._smoothTargetView = null;

    /** @type {number|null} */
    this._smoothRafId = null;

    /** @type {number} */
    this._smoothLastAt = 0;

    /** @type {number} */
    this._smoothEpsilonWorld = 0.05;

    /** @type {number} */
    this._smoothEpsilonScale = 0.00025;
    
    // Bind handlers
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onContextMenu = this._onContextMenu.bind(this);
    this._tickSmoothing = this._tickSmoothing.bind(this);
  }

  _isEventFromOverlayUI(event) {
    try {
      const target = event?.target;
      const path = (event && typeof event.composedPath === 'function') ? event.composedPath() : null;
      const elements = Array.isArray(path)
        ? path.filter((n) => n instanceof Element)
        : (target instanceof Element ? [target] : []);

      for (const el of elements) {
        if (el.closest('#map-shine-overlay-root')) return true;
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
   * @param {(function(): boolean)|null} blocker
   */
  setInputBlocker(blocker) {
    this._inputBlocker = (typeof blocker === 'function') ? blocker : null;
  }

  /**
   * @param {(function({x:number, y:number, scale:number}, string): {x:number, y:number, scale:number}|null|undefined)|null} provider
   */
  setViewConstraintProvider(provider) {
    this._viewConstraintProvider = (typeof provider === 'function') ? provider : null;
  }

  /**
   * @param {(function(string): void)|null} callback
   */
  setUserInputCallback(callback) {
    this._userInputCallback = (typeof callback === 'function') ? callback : null;
  }

  /**
   * @param {(function(): {enabled?:boolean, panHz?:number, zoomHz?:number}|null|undefined)|null} provider
   */
  setMotionSmoothingProvider(provider) {
    this._motionSmoothingProvider = (typeof provider === 'function') ? provider : null;
    if (!this._isSmoothingEnabled()) {
      this._smoothTargetView = null;
      this._stopSmoothingLoop();
    }
  }

  /**
   * @returns {boolean}
   */
  isUserActivelyPanning() {
    return this._isDragging || this._pendingRightDrag;
  }

  /**
   * @private
   * @returns {boolean}
   */
  _isInputBlocked() {
    if (!this.enabled) return true;
    if (!this._inputBlocker) return false;
    try {
      return this._inputBlocker() === true;
    } catch (_) {
      return false;
    }
  }

  /**
   * @private
   * @param {{x:number, y:number, scale:number}} view
   * @param {string} source
   * @returns {{x:number, y:number, scale:number}}
   */
  _applyExternalViewConstraint(view, source) {
    if (!this._viewConstraintProvider || !view) return view;
    try {
      const constrained = this._viewConstraintProvider(view, source);
      if (constrained && Number.isFinite(constrained.x) && Number.isFinite(constrained.y) && Number.isFinite(constrained.scale)) {
        return constrained;
      }
    } catch (_) {
    }
    return view;
  }

  /**
   * @private
   * @param {string} kind
   */
  _notifyUserInput(kind) {
    if (!this._userInputCallback) return;
    try {
      this._userInputCallback(kind);
    } catch (_) {
    }
  }

  /**
   * @private
   * @returns {{enabled:boolean, panHz:number, zoomHz:number}}
   */
  _getSmoothingConfig() {
    let cfg = null;
    if (this._motionSmoothingProvider) {
      try {
        cfg = this._motionSmoothingProvider() || null;
      } catch (_) {
      }
    }

    return {
      enabled: cfg?.enabled === true,
      panHz: clamp(asNumber(cfg?.panHz, 18), 1, 80),
      zoomHz: clamp(asNumber(cfg?.zoomHz, 14), 1, 80),
    };
  }

  /**
   * @private
   * @returns {boolean}
   */
  _isSmoothingEnabled() {
    return this._getSmoothingConfig().enabled === true;
  }

  /**
   * @private
   * @returns {{x:number, y:number, scale:number}|null}
   */
  _getStageView() {
    if (!canvas?.stage?.pivot || !canvas?.stage?.scale) return null;
    const x = asNumber(canvas.stage.pivot.x, NaN);
    const y = asNumber(canvas.stage.pivot.y, NaN);
    const scale = asNumber(canvas.stage.scale.x, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale)) return null;
    return { x, y, scale };
  }

  /**
   * @private
   * @returns {{x:number, y:number, scale:number}|null}
   */
  _getInputReferenceView() {
    if (this._smoothTargetView && Number.isFinite(this._smoothTargetView.x) && Number.isFinite(this._smoothTargetView.y) && Number.isFinite(this._smoothTargetView.scale)) {
      return this._smoothTargetView;
    }
    return this._getStageView();
  }

  /**
   * @private
   * @returns {{width:number, height:number}}
   */
  _getViewportSize() {
    const rect = canvas?.app?.view?.getBoundingClientRect?.();
    if (rect && rect.width > 0 && rect.height > 0) {
      return { width: rect.width, height: rect.height };
    }
    return {
      width: Math.max(1, window.innerWidth || 1),
      height: Math.max(1, window.innerHeight || 1),
    };
  }

  /**
   * @private
   * @param {{x:number, y:number, scale:number}} view
   */
  _applyView(view) {
    if (!view || !canvas?.stage?.pivot || !canvas?.stage?.scale || !canvas?.stage?.position) return;

    canvas.stage.pivot.x = view.x;
    canvas.stage.pivot.y = view.y;
    canvas.stage.scale.set(view.scale, view.scale);

    const vp = this._getViewportSize();
    canvas.stage.position.x = vp.width * 0.5;
    canvas.stage.position.y = vp.height * 0.5;
  }

  /**
   * @private
   */
  _startSmoothingLoop() {
    if (this._smoothRafId !== null) return;
    this._smoothLastAt = 0;
    this._smoothRafId = requestAnimationFrame(this._tickSmoothing);
  }

  /**
   * @private
   */
  _stopSmoothingLoop() {
    if (this._smoothRafId === null) return;
    cancelAnimationFrame(this._smoothRafId);
    this._smoothRafId = null;
    this._smoothLastAt = 0;
  }

  /**
   * @private
   * @param {number} nowMs
   */
  _tickSmoothing(nowMs) {
    this._smoothRafId = null;

    if (!this.enabled || this._isInputBlocked()) {
      this._smoothTargetView = null;
      return;
    }

    const target = this._smoothTargetView;
    if (!target) return;

    const stageView = this._getStageView();
    if (!stageView) {
      this._smoothTargetView = null;
      return;
    }

    const cfg = this._getSmoothingConfig();
    if (!cfg.enabled) {
      this._applyView(target);
      this._smoothTargetView = null;
      return;
    }

    const dt = clamp((nowMs - (this._smoothLastAt || nowMs)) / 1000, 1 / 240, 0.1);
    this._smoothLastAt = nowMs;

    const alphaPan = clamp(1 - Math.exp(-cfg.panHz * dt), 0.04, 1);
    const alphaZoom = clamp(1 - Math.exp(-cfg.zoomHz * dt), 0.04, 1);

    const nextView = this._applyExternalViewConstraint({
      x: stageView.x + ((target.x - stageView.x) * alphaPan),
      y: stageView.y + ((target.y - stageView.y) * alphaPan),
      scale: stageView.scale + ((target.scale - stageView.scale) * alphaZoom),
    }, 'smooth');

    this._applyView(nextView);

    const dx = Math.abs(target.x - nextView.x);
    const dy = Math.abs(target.y - nextView.y);
    const ds = Math.abs(target.scale - nextView.scale);
    if (dx <= this._smoothEpsilonWorld && dy <= this._smoothEpsilonWorld && ds <= this._smoothEpsilonScale) {
      this._applyView(target);
      this._smoothTargetView = null;
      return;
    }

    this._startSmoothingLoop();
  }

  /**
   * @private
   * @param {{x:number, y:number, scale:number}} view
   * @param {string} source
   */
  _setViewFromInput(view, source) {
    if (!view) return;
    const constrained = this._applyExternalViewConstraint(view, source);
    if (!constrained) return;

    if (!this._isSmoothingEnabled()) {
      this._smoothTargetView = null;
      this._stopSmoothingLoop();
      this._applyView(constrained);
      return;
    }

    this._smoothTargetView = constrained;
    this._startSmoothingLoop();
  }
  
  /**
   * Handle mouse down - start pan on right click
   * @param {MouseEvent} event
   * @private
   */
  _onMouseDown(event) {
    if (this._isInputBlocked()) return;

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
    if (this._isInputBlocked()) {
      this._smoothTargetView = null;
      this._stopSmoothingLoop();
      if (this._isDragging) this._onMouseUp(event);
      return;
    }
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

    const baseView = this._getInputReferenceView();
    if (!baseView) return;
    
    const deltaX = event.clientX - this._lastMousePos.x;
    const deltaY = event.clientY - this._lastMousePos.y;
    
    // Use the smoothing target as source while interpolating so drag motion remains
    // predictable and doesn't "fight" interpolation lag.
    const zoom = baseView.scale || 1;
    
    // Convert screen pixels to world units
    const worldDx = deltaX / zoom;
    const worldDy = deltaY / zoom;
    
    // Update PIXI stage pivot (drag right = move view left = decrease pivot.x)
    this._setViewFromInput({
      x: baseView.x - worldDx,
      y: baseView.y - worldDy,
      scale: baseView.scale,
    }, 'pan');
    
    this._lastMousePos = { x: event.clientX, y: event.clientY };
    this._notifyUserInput('pan');
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
    if (this._isInputBlocked()) return;
    if (!canvas?.stage || !canvas?.app?.view) return;

    if (this._isEventFromOverlayUI(event)) {
      return;
    }
    
    // Modifier-wheel is reserved for object interactions (rotate/scale) via InteractionManager.
    // Avoid zoom conflicts by ignoring Ctrl/Shift wheel here.
    if (event.ctrlKey || event.shiftKey) return;
    
    event.preventDefault();

    const baseView = this._getInputReferenceView();
    if (!baseView) return;
    
    // Convert wheel amount into a consistent multiplicative zoom step.
    const wheel = clamp(asNumber(event.deltaY, 0), -240, 240);
    const factor = Math.exp(-wheel * 0.0012);
    
    // Get current zoom
    const oldZoom = baseView.scale || 1;
    
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
    const worldX = baseView.x + (screenPosX - rect.width / 2) / oldZoom;
    const worldY = baseView.y + (screenPosY - rect.height / 2) / oldZoom;
    
    // After zoom, adjust pivot so world point stays under cursor
    // New pivot = worldPoint - (cursor offset from center) / newZoom
    this._setViewFromInput({
      x: worldX - (screenPosX - rect.width / 2) / newZoom,
      y: worldY - (screenPosY - rect.height / 2) / newZoom,
      scale: newZoom
    }, 'zoom');

    this._notifyUserInput('zoom');
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
    this._smoothTargetView = null;
    this._stopSmoothingLoop();
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
