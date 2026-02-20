/**
 * @fileoverview Input Router - Routes pointer events between PIXI and Three.js
 * Implements atomic mode transitions with proper locking
 * @module foundry/input-router
 */

import { createLogger } from '../core/log.js';

const log = createLogger('InputRouter');

/**
 * Input mode enum
 * @readonly
 * @enum {string}
 */
export const InputMode = {
  THREE: 'three',
  PIXI: 'pixi'
};

/**
 * Routes input events between the PIXI canvas and Three.js canvas
 * based on the active layer and tool
 */
export class InputRouter {
  constructor() {
    /**
     * Current input mode
     * @type {InputMode}
     */
    this.currentMode = InputMode.THREE;
    
    /**
     * Whether the initial mode has been applied to canvases
     * @type {boolean}
     */
    this._initialized = false;
    
    /**
     * Lock to prevent concurrent transitions
     * @type {boolean}
     */
    this._transitionLock = false;
    
    /**
     * Layers that require PIXI interaction
     * @type {Set<string>}
     */
    this.pixiInteractiveLayers = new Set([
      'TilesLayer',
      'WallsLayer',
      'LightingLayer',
      'SoundsLayer',
      'TemplateLayer',
      'DrawingsLayer',
      'NotesLayer',
      'RegionLayer'
    ]);
    
    /**
     * Tools that require PIXI interaction (regardless of layer)
     * @type {Set<string>}
     */
    this.pixiInteractiveTools = new Set([
      // Wall tools
      'walls', 'terrain', 'invisible', 'ethereal', 'doors', 'secret', 'window',
      // Light tools
      'light',
      // Sound tools
      'sound',
      // Note tools
      'note',
      // Template tools
      'circle', 'cone', 'rect', 'ray',
      // Drawing tools
      'select', 'polygon', 'freehand', 'text', 'ellipse', 'rectangle',
      // Region tools
      'region'
    ]);
    
    /**
     * Tools that should always use Three.js (even on PIXI layers)
     * @type {Set<string>}
     */
    this.threeOnlyTools = new Set([
      // Token tools handled by Three.js
      'target'
    ]);
    
    /**
     * Track mode change history for debugging
     * @type {Array<{mode: InputMode, reason: string, timestamp: number}>}
     */
    this._history = [];
    
    /**
     * Maximum history entries to keep
     * @type {number}
     */
    this._maxHistory = 50;
  }
  
  /**
   * Set the input mode with atomic transition
   * @param {InputMode} mode - Target mode
   * @param {string} [reason=''] - Reason for the change
   * @returns {boolean} Success status
   */
  setMode(mode, reason = '') {
    if (this._transitionLock) {
      log.warn('Input mode transition already in progress');
      return false;
    }
    
    // Skip if already in this mode AND initialized (canvas styles already applied)
    if (this.currentMode === mode && this._initialized) {
      return true;
    }
    
    this._transitionLock = true;
    
    try {
      const pixiCanvas = canvas.app?.view;
      const threeCanvas = document.getElementById('map-shine-canvas');
      
      if (!pixiCanvas) {
        throw new Error('PIXI canvas not found');
      }
      
      if (!threeCanvas) {
        throw new Error('Three.js canvas not found');
      }
      
      // HYBRID STRATEGY: Route input based on mode
      // - In PIXI mode, Foundry's PIXI canvas handles all interaction (edit tools)
      // - In THREE mode, the Three.js canvas handles interaction (tokens, 3D tools)
      //   while PIXI becomes a transparent visual overlay.
      if (mode === InputMode.PIXI) {
        // PIXI receives input
        pixiCanvas.style.pointerEvents = 'auto';
        pixiCanvas.style.opacity = '1';
        
        // Three.js is render-only
        threeCanvas.style.pointerEvents = 'none';
      } else {
        // Three.js receives input
        threeCanvas.style.pointerEvents = 'auto';
        
        // PIXI stays on top visually but passes pointer events through
        pixiCanvas.style.pointerEvents = 'none';
        pixiCanvas.style.opacity = '1';
      }
      
      const oldMode = this.currentMode;
      this.currentMode = mode;
      this._initialized = true; // Mark as initialized after first successful application
      
      // Record history
      this._history.push({
        from: oldMode,
        to: mode,
        reason,
        timestamp: Date.now()
      });
      
      // Trim history
      if (this._history.length > this._maxHistory) {
        this._history.shift();
      }
      
      log.debug(`Input mode: ${oldMode} -> ${mode}${reason ? ` (${reason})` : ''}`);
      
      // Emit hook for other systems
      Hooks.callAll('mapShineInputModeChange', { 
        mode, 
        layer: canvas.activeLayer?.constructor?.name,
        tool: ui.controls?.tool?.name ?? ui.controls?.activeTool,
        reason 
      });
      
      return true;
      
    } catch (error) {
      log.error('Input mode transition failed:', error);
      return false;
    } finally {
      this._transitionLock = false;
    }
  }
  
  /**
   * Determine the correct input mode based on current state
   * @returns {InputMode}
   */
  determineMode() {
    // Defensive: ensure canvas and UI are ready
    if (!canvas?.ready) return InputMode.THREE;
    
    const activeLayer = canvas.activeLayer;
    if (!activeLayer) return InputMode.THREE;
    
    const layerCtorName = activeLayer.constructor?.name || '';
    const layerIdName = activeLayer.name || '';
    
    // Defensive: ui.controls may not exist during initialization
    // This prevents the "toolclip" error when Foundry is still setting up
    const activeTool = ui?.controls?.tool?.name ?? ui?.controls?.activeTool ?? '';
    
    // IMPORTANT: Tokens layer should ALWAYS use Three.js for interaction
    // Foundry's tokens layer constructor name can be 'TokenLayer' or 'TokensLayer'
    // depending on version, and the instance may also expose name/id 'tokens'.
    // This check MUST come before the tool check because when switching layers,
    // the activeTool might still be from the previous layer (e.g., 'walls').
    // The 'select' tool on the tokens layer is handled by our InteractionManager.
    const isTokensLayer =
      layerCtorName === 'TokenLayer' ||
      layerCtorName === 'TokensLayer' ||
      layerIdName === 'tokens';

    const isTilesLayer =
      layerCtorName === 'TilesLayer' ||
      layerIdName === 'tiles';

    if (isTokensLayer) {
      // WP-2 Ruler parity: when Foundry's ruler tool is active on the tokens
      // layer (toggled via R key), route input to PIXI so the ruler can receive
      // pointer drag events for measurement. Input routes back to THREE when
      // the user switches back to the select tool.
      if (activeTool === 'ruler') {
        return InputMode.PIXI;
      }
      return InputMode.THREE;
    }

    // Tile placement/selection is handled by InteractionManager + TileManager in
    // Three.js so we keep input routed to Three even when the Tiles layer/tools are active.
    if (isTilesLayer) {
      return InputMode.THREE;
    }
    
    // Check if tool explicitly requires Three.js
    if (activeTool && this.threeOnlyTools.has(activeTool)) {
      return InputMode.THREE;
    }
    
    // Check if tool requires PIXI (only for non-token layers)
    if (activeTool && this.pixiInteractiveTools.has(activeTool)) {
      return InputMode.PIXI;
    }
    
    // Check if layer requires PIXI
    if (this.pixiInteractiveLayers.has(layerCtorName)) {
      return InputMode.PIXI;
    }
    
    // Default to Three.js
    return InputMode.THREE;
  }
  
  /**
   * Auto-update mode based on current layer/tool
   */
  autoUpdate() {
    // Defensive: skip if canvas or UI not ready
    if (!canvas?.ready || !ui?.controls) {
      log.debug('autoUpdate skipped: canvas or UI not ready');
      return;
    }
    
    const newMode = this.determineMode();
    const layer = canvas.activeLayer?.constructor?.name || 'unknown';
    const tool = ui.controls?.tool?.name ?? ui.controls?.activeTool ?? 'unknown';
    
    this.setMode(newMode, `auto: ${layer}/${tool}`);
  }
  
  /**
   * Force PIXI mode (useful for modal interactions)
   * @param {string} [reason='']
   */
  forcePixi(reason = 'forced') {
    this.setMode(InputMode.PIXI, reason);
  }
  
  /**
   * Force Three.js mode
   * @param {string} [reason='']
   */
  forceThree(reason = 'forced') {
    this.setMode(InputMode.THREE, reason);
  }
  
  /**
   * Check if PIXI should currently receive input
   * @returns {boolean}
   */
  shouldPixiReceiveInput() {
    return this.currentMode === InputMode.PIXI;
  }
  
  /**
   * Check if Three.js should currently receive input
   * @returns {boolean}
   */
  shouldThreeReceiveInput() {
    return this.currentMode === InputMode.THREE;
  }
  
  /**
   * Add a custom layer that requires PIXI interaction
   * @param {string} layerName - Constructor name of the layer
   */
  addPixiLayer(layerName) {
    this.pixiInteractiveLayers.add(layerName);
    log.debug(`Added PIXI interactive layer: ${layerName}`);
  }
  
  /**
   * Add a custom tool that requires PIXI interaction
   * @param {string} toolName
   */
  addPixiTool(toolName) {
    this.pixiInteractiveTools.add(toolName);
    log.debug(`Added PIXI interactive tool: ${toolName}`);
  }
  
  /**
   * Get mode change history for debugging
   * @param {number} [count=10] - Number of entries to return
   * @returns {Array}
   */
  getHistory(count = 10) {
    return this._history.slice(-count);
  }
  
  /**
   * Get current state for debugging
   * @returns {object}
   */
  getState() {
    return {
      currentMode: this.currentMode,
      activeLayer: canvas.activeLayer?.constructor?.name || null,
      activeTool: ui.controls?.tool?.name ?? ui.controls?.activeTool ?? null,
      determinedMode: this.determineMode(),
      transitionLocked: this._transitionLock
    };
  }
}
