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
      // Sound tools
      'sound',
      // Note tools
      'note',
      // Template tools
      'circle', 'cone', 'rect', 'ray',
      // Drawing tools
      'select', 'polygon', 'freehand', 'text', 'ellipse', 'rect', 'rectangle',
      // Region tools
      'region'
    ]);
    
    /**
     * Tools that should always use Three.js (even on PIXI layers)
     * @type {Set<string>}
     */
    this.threeOnlyTools = new Set([]);
    
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
    const isV2Active = !!window.MapShine?.__v2Active;
    const activeControl = String(ui?.controls?.control?.name ?? ui?.controls?.activeControl ?? '').toLowerCase();
    const activeTool = String(ui?.controls?.tool?.name ?? ui?.controls?.activeTool ?? game?.activeTool ?? '').toLowerCase();
    const activeLayerName = String(canvas?.activeLayer?.options?.name ?? canvas?.activeLayer?.name ?? '').toLowerCase();
    const activeLayerCtor = String(canvas?.activeLayer?.constructor?.name ?? '').toLowerCase();
    const activeControlLayer = String(ui?.controls?.control?.layer ?? '').toLowerCase();
    const isDrawingsContext =
      !!canvas?.drawings?.active
      || activeControl === 'drawings'
      || activeControl === 'drawing'
      || activeControlLayer === 'drawings'
      || activeControlLayer === 'drawing'
      || activeLayerName === 'drawings'
      || activeLayerName === 'drawing'
      || activeLayerCtor === 'drawingslayer';
      
    const isLightingContext =
      !!canvas?.lighting?.active
      || activeControl === 'lighting'
      || activeControl === 'light'
      || activeControlLayer === 'lighting'
      || activeControlLayer === 'light'
      || activeLayerName === 'lighting'
      || activeLayerName === 'light'
      || activeLayerCtor === 'lightinglayer';
      
    const isSoundsContext =
      !!canvas?.sounds?.active
      || activeControl === 'sounds'
      || activeControl === 'sound'
      || activeControlLayer === 'sounds'
      || activeControlLayer === 'sound'
      || activeLayerName === 'sounds'
      || activeLayerName === 'sound'
      || activeLayerCtor === 'soundslayer';
      
    const isNotesContext =
      !!canvas?.notes?.active
      || activeControl === 'notes'
      || activeControl === 'note'
      || activeControlLayer === 'notes'
      || activeControlLayer === 'note'
      || activeLayerName === 'notes'
      || activeLayerName === 'note'
      || activeLayerCtor === 'noteslayer';
      
    const isTemplatesContext =
      !!canvas?.templates?.active
      || activeControl === 'templates'
      || activeControl === 'template'
      || activeControlLayer === 'templates'
      || activeControlLayer === 'template'
      || activeLayerName === 'templates'
      || activeLayerName === 'template'
      || activeLayerCtor === 'templatelayer';
      
    const isRegionsContext =
      !!canvas?.regions?.active
      || activeControl === 'regions'
      || activeControl === 'region'
      || activeControlLayer === 'regions'
      || activeControlLayer === 'region'
      || activeLayerName === 'regions'
      || activeLayerName === 'region'
      || activeLayerCtor === 'regionlayer';

    const isPixiContext = isDrawingsContext || isLightingContext || isSoundsContext || isNotesContext || isTemplatesContext || isRegionsContext;
    const pixiVisualOpacity = (isV2Active && !isPixiContext) ? '0' : '1';
    // Only force PIXI overlay when actually in PIXI mode (for layers we haven't
    // replaced yet like drawings, regions, sounds, notes, templates, and now lights).
    // Walls and tokens are fully Three.js-native now.
    const forcePixiOverlay = mode === InputMode.PIXI;
    if (window.MapShine) {
      window.MapShine.__forcePixiEditorOverlay = forcePixiOverlay;
    }

    if (this._transitionLock) {
      log.warn('Input mode transition already in progress');
      return false;
    }
    
    // Skip if already in this mode AND initialized (canvas styles already applied)
    if (this.currentMode === mode && this._initialized) {
      if (mode === InputMode.PIXI) {
        try {
          if (canvas?.app?.renderer?.background) {
            canvas.app.renderer.background.alpha = 0;
          }
        } catch (_) {
        }

        const pixiCanvas = canvas.app?.view;
        if (pixiCanvas) {
          pixiCanvas.style.display = '';
          pixiCanvas.style.visibility = 'visible';
          pixiCanvas.style.opacity = pixiVisualOpacity;
          pixiCanvas.style.pointerEvents = 'auto';
          pixiCanvas.style.backgroundColor = 'transparent';
        }
        const board = document.getElementById('board');
        if (board && board.tagName === 'CANVAS') {
          board.style.display = '';
          board.style.visibility = 'visible';
          board.style.opacity = pixiVisualOpacity;
          board.style.zIndex = '10';
          board.style.pointerEvents = 'auto';
          board.style.backgroundColor = 'transparent';
        }
        const threeCanvas = document.getElementById('map-shine-canvas');
        if (threeCanvas) {
          threeCanvas.style.display = '';
          threeCanvas.style.visibility = 'visible';
          threeCanvas.style.opacity = '1';
          threeCanvas.style.pointerEvents = 'none';
        }
      }
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
        // Keep PIXI compositor transparent so showing the board for native
        // wall/light tools does not cover the Three-rendered scene with a
        // stale/opaque clear color.
        try {
          if (canvas?.app?.renderer?.background) {
            canvas.app.renderer.background.alpha = 0;
          }
        } catch (_) {
        }

        // PIXI receives input
        pixiCanvas.style.display = '';
        pixiCanvas.style.visibility = 'visible';
        pixiCanvas.style.pointerEvents = 'auto';
        pixiCanvas.style.opacity = pixiVisualOpacity;
        pixiCanvas.style.backgroundColor = 'transparent';

        // Foundry's composited board canvas may be separate from canvas.app.view.
        // Keep it visible and interactive whenever PIXI owns interaction.
        const board = document.getElementById('board');
        if (board && board.tagName === 'CANVAS') {
          board.style.display = '';
          board.style.visibility = 'visible';
          board.style.opacity = pixiVisualOpacity;
          board.style.zIndex = '10';
          board.style.pointerEvents = 'auto';
        }
        
        // Three.js is render-only
        threeCanvas.style.display = '';
        threeCanvas.style.visibility = 'visible';
        threeCanvas.style.opacity = '1';
        threeCanvas.style.pointerEvents = 'none';
      } else {
        // Three.js receives input
        threeCanvas.style.pointerEvents = 'auto';
        
        // PIXI stays on top visually but passes pointer events through
        pixiCanvas.style.pointerEvents = 'none';
        pixiCanvas.style.opacity = '1';

        const board = document.getElementById('board');
        if (board && board.tagName === 'CANVAS') {
          board.style.pointerEvents = 'none';
        }
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
        tool: ui.controls?.tool?.name ?? ui.controls?.activeTool ?? game?.activeTool,
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
    const layerOptionsName = activeLayer.options?.name || '';
    const activeControl = ui?.controls?.control?.name ?? ui?.controls?.activeControl ?? '';
    const activeControlLayer = ui?.controls?.control?.layer ?? '';
    
    // Defensive: ui.controls may not exist during initialization
    // This prevents the "toolclip" error when Foundry is still setting up
    const activeTool = ui?.controls?.tool?.name ?? ui?.controls?.activeTool ?? game?.activeTool ?? '';
    
    // Foundry-native token edit tools (select/target/ruler) are PIXI workflows
    // and rely on board-level drag/select handling.
    const isTokensLayer =
      layerCtorName === 'TokenLayer' ||
      layerCtorName === 'TokensLayer' ||
      layerIdName === 'tokens';

    const isTilesLayer =
      !!canvas?.tiles?.active ||
      layerCtorName === 'TilesLayer' ||
      layerIdName === 'tiles' ||
      layerOptionsName === 'tiles' ||
      layerOptionsName === 'tile' ||
      activeControl === 'tiles' ||
      activeControl === 'tile' ||
      activeControlLayer === 'tiles' ||
      activeControlLayer === 'tile';

    const isLightingLayer =
      !!canvas?.lighting?.active ||
      layerCtorName === 'LightingLayer' ||
      layerIdName === 'lighting' ||
      layerIdName === 'light' ||
      layerOptionsName === 'lighting' ||
      layerOptionsName === 'light' ||
      activeControl === 'lighting' ||
      activeControl === 'light' ||
      activeControlLayer === 'lighting' ||
      activeControlLayer === 'light';

    const isWallsLayer =
      !!canvas?.walls?.active ||
      layerCtorName === 'WallsLayer' ||
      layerCtorName === 'WallLayer' ||
      layerIdName === 'walls' ||
      layerIdName === 'wall' ||
      layerOptionsName === 'walls' ||
      layerOptionsName === 'wall' ||
      activeControl === 'walls' ||
      activeControl === 'wall' ||
      activeControlLayer === 'walls' ||
      activeControlLayer === 'wall';

    const isDrawingsLayer =
      !!canvas?.drawings?.active ||
      layerCtorName === 'DrawingsLayer' ||
      layerIdName === 'drawings' ||
      layerIdName === 'drawing' ||
      layerOptionsName === 'drawings' ||
      layerOptionsName === 'drawing' ||
      activeControl === 'drawings' ||
      activeControl === 'drawing' ||
      activeControlLayer === 'drawings' ||
      activeControlLayer === 'drawing';

    const isTemplatesLayer =
      !!canvas?.templates?.active ||
      layerCtorName === 'TemplateLayer' ||
      layerIdName === 'templates' ||
      layerIdName === 'template' ||
      layerOptionsName === 'templates' ||
      layerOptionsName === 'template' ||
      activeControl === 'templates' ||
      activeControl === 'template' ||
      activeControlLayer === 'templates' ||
      activeControlLayer === 'template';

    const isNotesLayer =
      !!canvas?.notes?.active ||
      layerCtorName === 'NotesLayer' ||
      layerIdName === 'notes' ||
      layerIdName === 'note' ||
      layerOptionsName === 'notes' ||
      layerOptionsName === 'note' ||
      activeControl === 'notes' ||
      activeControl === 'note' ||
      activeControlLayer === 'notes' ||
      activeControlLayer === 'note';

    const isSoundsLayer =
      !!canvas?.sounds?.active ||
      layerCtorName === 'SoundsLayer' ||
      layerIdName === 'sounds' ||
      layerIdName === 'sound' ||
      layerOptionsName === 'sounds' ||
      layerOptionsName === 'sound' ||
      activeControl === 'sounds' ||
      activeControl === 'sound' ||
      activeControlLayer === 'sounds' ||
      activeControlLayer === 'sound';

    const isRegionsLayer =
      !!canvas?.regions?.active ||
      layerCtorName === 'RegionLayer' ||
      layerIdName === 'regions' ||
      layerIdName === 'region' ||
      layerOptionsName === 'regions' ||
      layerOptionsName === 'region' ||
      activeControl === 'regions' ||
      activeControl === 'region' ||
      activeControlLayer === 'regions' ||
      activeControlLayer === 'region';

    // UI overlays are Foundry-native PIXI workflows. Prioritize this check before
    // token/wall/tile ownership to survive transient stale activeLayer state
    // immediately after control switches.
    if (isDrawingsLayer || isLightingLayer || isSoundsLayer || isNotesLayer || isTemplatesLayer || isRegionsLayer) {
      return InputMode.PIXI;
    }

    // Three.js handles all token interactions: selection, drag, HUD,
    // targeting, click-to-move, and ruler forwarding. No PIXI overlay needed.
    if (isTokensLayer) {
      return InputMode.THREE;
    }

    // Tile workflows are currently handled by InteractionManager's Three.js tile
    // picking/edit path in the hybrid stack.
    if (isTilesLayer) {
      return InputMode.THREE;
    }

    // Three.js handles wall placement (click-to-place with chaining), wall
    // endpoint dragging, and door interactions. No PIXI overlay needed.
    if (isWallsLayer) {
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
    const tool = ui.controls?.tool?.name ?? ui.controls?.activeTool ?? game?.activeTool ?? 'unknown';
    
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
      activeTool: ui.controls?.tool?.name ?? ui.controls?.activeTool ?? game?.activeTool ?? null,
      determinedMode: this.determineMode(),
      transitionLocked: this._transitionLock
    };
  }
}
