/**
 * @fileoverview Layer Visibility Manager - Controls PIXI layer visibility
 * Implements the visibility strategy from the integration plan
 * @module foundry/layer-visibility-manager
 */

import { createLogger } from '../core/log.js';

const log = createLogger('LayerVisibility');

/**
 * Manages PIXI layer visibility based on the active layer and tool
 * 
 * Strategy:
 * - "Replaced" layers (background, tokens, etc.) are always hidden (Three.js renders them)
 * - "Always visible" layers (templates, drawings, notes, controls) stay visible
 * - "Edit only" layers (walls, lighting, sounds, etc.) are shown only when active
 */
export class LayerVisibilityManager {
  constructor() {
    /**
     * Layers that are always hidden because Three.js replaces them
     * @type {Set<string>}
     */
    this.replacedLayers = new Set([
      'background',
      'grid',
      'primary',
      'tiles',
      'tokens',
      'weather',
      'environment'
    ]);
    
    /**
     * Layers that are always visible as PIXI overlays
     * @type {Set<string>}
     */
    this.alwaysVisibleLayers = new Set([
      'templates',
      'drawings',
      'notes',
      'controls',
      'walls'
    ]);
    
    /**
     * Layers that are only visible when actively being edited
     * @type {Set<string>}
     */
    this.editOnlyLayers = new Set([
      'lighting',
      'sounds',
      'regions'
    ]);
    
    /**
     * Custom layers added by modules that should be preserved
     * @type {Map<string, object>}
     */
    this.customLayers = new Map();
    
    /**
     * Track last known state for debugging
     * @type {Map<string, boolean>}
     */
    this._lastState = new Map();
    
    // Detect custom layers on construction
    this.detectCustomLayers();
  }

  _setPixiTileVisualAlpha(alpha) {
    if (!canvas?.tiles?.placeables) return;
    for (const tile of canvas.tiles.placeables) {
      if (!tile) continue;
      try {
        // Keep the placeable interactive, but hide its visual output.
        // Foundry tile visuals are typically a Sprite (tile.mesh) plus additional children.
        tile.visible = true;
        tile.interactive = true;
        tile.interactiveChildren = true;
      } catch (_) {
      }

      try {
        if (tile.mesh) tile.mesh.alpha = alpha;
      } catch (_) {
      }

      try {
        // Some Foundry versions use a primary sprite child for the tile texture.
        if (tile.texture) tile.texture.alpha = alpha;
      } catch (_) {
      }

      try {
        // Defensive: ensure any other child graphics are also hidden.
        if (Array.isArray(tile.children)) {
          for (const child of tile.children) {
            if (child && typeof child.alpha === 'number') child.alpha = alpha;
          }
        }
      } catch (_) {
      }
    }
  }
  
  /**
   * Detect custom layers added by other modules
   */
  detectCustomLayers() {
    if (!CONFIG?.Canvas?.layers) return;
    
    const standardLayers = new Set([
      'background', 'drawings', 'grid', 'templates', 'tiles',
      'tokens', 'walls', 'lighting', 'sounds', 'notes',
      'regions', 'controls', 'effects', 'interface', 'primary',
      'weather', 'environment'
    ]);
    
    for (const [name, config] of Object.entries(CONFIG.Canvas.layers)) {
      if (!standardLayers.has(name)) {
        this.customLayers.set(name, config);
        log.info(`Detected custom layer '${name}' from module`);
      }
    }
  }
  
  /**
   * Update layer visibility based on current state
   * @param {string} [activeLayerName] - Override for active layer name
   */
  update(activeLayerName) {
    if (!canvas?.ready) {
      log.debug('Canvas not ready, skipping visibility update');
      return;
    }
    
    // Determine active layer
    const activeName = activeLayerName || this.getActiveLayerName();
    
    log.debug(`Updating layer visibility (active: ${activeName})`);
    
    // Hide replaced layers (Three.js renders these)
    for (const name of this.replacedLayers) {
      this.setLayerVisibility(name, false, 'replaced');
    }
    
    // Always show certain layers
    for (const name of this.alwaysVisibleLayers) {
      this.setLayerVisibility(name, true, 'always-visible');
    }
    
    // Show edit layers only when active
    for (const name of this.editOnlyLayers) {
      const isActive = this.isLayerActive(name, activeName);
      this.setLayerVisibility(name, isActive, isActive ? 'edit-active' : 'edit-inactive');
    }
    
    // Preserve custom layers (always visible)
    for (const [name] of this.customLayers) {
      this.setLayerVisibility(name, true, 'custom-preserved');
    }
  }
  
  /**
   * Get the name of the currently active layer
   * @returns {string}
   */
  getActiveLayerName() {
    const activeLayer = canvas.activeLayer;
    if (!activeLayer) return '';
    
    // Try to get the layer name from various sources
    return activeLayer.options?.name || 
           activeLayer.name || 
           activeLayer.constructor?.name?.replace('Layer', '').toLowerCase() ||
           '';
  }
  
  /**
   * Check if a layer name matches the active layer
   * @param {string} layerName - Layer name to check (e.g., 'walls')
   * @param {string} activeName - Active layer name
   * @returns {boolean}
   */
  isLayerActive(layerName, activeName) {
    if (!activeName) return false;
    
    // Normalize names for comparison
    const normalizedLayer = layerName.toLowerCase().replace('layer', '');
    const normalizedActive = activeName.toLowerCase().replace('layer', '');
    
    return normalizedLayer === normalizedActive;
  }
  
  /**
   * Set visibility for a specific layer
   * @param {string} name - Layer name
   * @param {boolean} visible - Desired visibility
   * @param {string} [reason=''] - Reason for logging
   */
  setLayerVisibility(name, visible, reason = '') {
    const layer = canvas[name];
    if (!layer) return;
    
    // Only log if state changed
    const lastState = this._lastState.get(name);
    if (lastState !== visible) {
      log.debug(`${name}: ${visible ? 'visible' : 'hidden'} (${reason})`);
      this._lastState.set(name, visible);
    }
    
    layer.visible = visible;
  }
  
  /**
   * Force all layers to a specific visibility state
   * @param {boolean} visible
   */
  setAllVisible(visible) {
    const allLayers = [
      ...this.replacedLayers,
      ...this.alwaysVisibleLayers,
      ...this.editOnlyLayers,
      ...this.customLayers.keys()
    ];
    
    for (const name of allLayers) {
      this.setLayerVisibility(name, visible, 'force-all');
    }
  }
  
  /**
   * Get current visibility state for debugging
   * @returns {object}
   */
  getState() {
    const state = {};
    
    const allLayers = [
      ...this.replacedLayers,
      ...this.alwaysVisibleLayers,
      ...this.editOnlyLayers,
      'grid'
    ];
    
    for (const name of allLayers) {
      const layer = canvas[name];
      state[name] = layer?.visible ?? null;
    }
    
    return state;
  }
  
  /**
   * Check if a layer should receive PIXI interaction
   * @param {string} layerName
   * @returns {boolean}
   */
  shouldLayerBeInteractive(layerName) {
    // Replaced layers never need PIXI interaction
    if (this.replacedLayers.has(layerName)) return false;
    
    // Always-visible and edit layers can be interactive
    return this.alwaysVisibleLayers.has(layerName) || 
           this.editOnlyLayers.has(layerName) ||
           this.customLayers.has(layerName);
  }
}
