/**
 * @fileoverview Gameplay / Map Maker mode switching for Map Shine.
 * 
 * Extracted from canvas-replacement.js to isolate:
 * - Mode toggling (Gameplay ↔ Map Maker)
 * - PIXI state capture/restore
 * - Select rect suppression
 * - Layer visibility management
 * - Input arbitration (legacy path)
 * - Foundry rendering state management
 * - UI layering (z-index)
 * 
 * @module foundry/mode-manager
 */

import { createLogger } from '../core/log.js';

const log = createLogger('ModeManager');

/**
 * Manages the Gameplay / Map Maker mode lifecycle.
 * 
 * In Gameplay mode, Three.js is the primary renderer and interaction handler.
 * In Map Maker mode, Foundry's PIXI canvas takes over for editing.
 */
export class ModeManager {
  /**
   * @param {Object} deps - Mutable dependency bag. Properties may be null
   *   initially and set later as managers are created.
   * @param {HTMLCanvasElement|null} deps.threeCanvas
   * @param {import('../core/render-loop.js').RenderLoop|null} deps.renderLoop
   * @param {import('./controls-integration.js').ControlsIntegration|null} deps.controlsIntegration
   * @param {import('../scene/tile-manager.js').TileManager|null} deps.tileManager
   * @param {import('../scene/wall-manager.js').WallManager|null} deps.wallManager
   * @param {import('../scene/light-icon-manager.js').LightIconManager|null} deps.lightIconManager
   * @param {import('../scene/enhanced-light-icon-manager.js').EnhancedLightIconManager|null} deps.enhancedLightIconManager
   */
  constructor(deps) {
    /**
     * Mutable dependency bag — canvas-replacement.js updates these references
     * as managers are created/destroyed during the scene lifecycle.
     * @type {Object}
     */
    this._deps = deps;

    /** @type {boolean} */
    this.isMapMakerMode = false;

    /**
     * Track Foundry's native fog/visibility state so we can temporarily bypass it
     * in Map Maker mode (GM convenience) without permanently mutating the scene.
     * @type {{ fogVisible: boolean|null, visibilityVisible: boolean|null, visibilityFilterEnabled: boolean|null }|null}
     */
    this._mapMakerFogState = null;

    /**
     * Original Foundry drawSelect function, saved for restoration.
     * @type {Function|null}
     * @private
     */
    this._origDrawSelect = null;

    /** @type {boolean} */
    this._selectSuppressed = false;
  }

  // ── Public API ────────────────────────────────────────────────────

  /**
   * Set Map Maker Mode (Master Toggle).
   * @param {boolean} enabled - True for Map Maker (PIXI), False for Gameplay (Three.js).
   */
  setMapMakerMode(enabled) {
    if (this.isMapMakerMode === enabled) return;

    this.isMapMakerMode = enabled;

    // In Map Maker mode, Foundry should own drag-select visuals (PIXI).
    // In Gameplay mode, MapShine should own drag-select visuals (DOM + Three shadow).
    this.updateSelectRectSuppression();
    log.info(`Switching to ${enabled ? 'Map Maker' : 'Gameplay'} Mode`);

    try {
      if (window.MapShine) window.MapShine.isMapMakerMode = this.isMapMakerMode;
    } catch (_) {}

    if (enabled) {
      this._disableSystem();
    } else {
      this._enableSystem();
    }
  }

  /**
   * Ensure Foundry UI layers have proper z-index to appear above Three.js canvas.
   */
  ensureUILayering() {
    log.info('Ensuring UI layering...');

    const setZIndex = (id, zIndex) => {
      const el = document.getElementById(id);
      if (el) {
        el.style.zIndex = String(zIndex);
        log.debug(`${id} z-index set to ${zIndex}`);
      }
    };

    // Peripheral UI elements that don't cover the canvas
    setZIndex('sidebar', 100);
    setZIndex('chat', 100);
    setZIndex('players', 100);
    setZIndex('hotbar', 100);
    setZIndex('controls', 100);
    setZIndex('navigation', 100);

    // HUD Layer (Token HUD, Tile HUD, etc.)
    const hudLayer = document.getElementById('hud');
    if (hudLayer) {
      hudLayer.style.zIndex = '100';
      hudLayer.style.pointerEvents = 'none';
      log.debug('HUD layer z-index set to 100');
    }

    // Main UI container — transparent to pointer events over canvas area
    const uiContainer = document.getElementById('ui');
    if (uiContainer) {
      uiContainer.style.zIndex = '100';
      uiContainer.style.pointerEvents = 'none';
      log.debug('UI container set to pointer-events: none');

      // Re-enable pointer events on child elements that need interaction
      const uiChildren = uiContainer.querySelectorAll(
        '#sidebar, #chat, #players, #hotbar, #controls, #navigation'
      );
      uiChildren.forEach(child => {
        child.style.pointerEvents = 'auto';
      });
      log.debug('Re-enabled pointer events on interactive UI children');
    }

    log.info('UI layering ensured — peripheral UI at z-index 100, canvas area left interactive');
  }

  /**
   * Restore Foundry's native PIXI rendering state.
   */
  restoreFoundryRendering() {
    if (!canvas || !canvas.app) return;

    log.info('Restoring Foundry PIXI rendering');

    // Restore PIXI renderer background to opaque
    if (canvas.app?.renderer?.background) {
      canvas.app.renderer.background.alpha = 1;
    }

    // Restore PIXI canvas to default state
    const pixiCanvas = canvas.app.view;
    if (pixiCanvas) {
      pixiCanvas.style.opacity = '1';
      pixiCanvas.style.pointerEvents = 'auto';
      pixiCanvas.style.zIndex = '';
    }

    // Restore ALL layers
    const layerNames = [
      'background', 'grid', 'primary', 'tokens', 'tiles', 'lighting',
      'sounds', 'templates', 'drawings', 'notes', 'walls', 'weather',
      'environment', 'regions', 'fog', 'visibility'
    ];
    for (const name of layerNames) {
      if (canvas[name]) canvas[name].visible = true;
    }

    // Restore visibility filter
    if (canvas.visibility?.filter) {
      canvas.visibility.filter.enabled = true;
    }

    // Restore token alphas
    if (canvas.tokens?.placeables) {
      for (const token of canvas.tokens.placeables) {
        if (token.mesh) token.mesh.alpha = 1;
        if (token.icon) token.icon.alpha = 1;
        if (token.border) token.border.alpha = 1;
      }
    }

    log.info('PIXI rendering restored');
  }

  /**
   * Suppress or restore Foundry's drag-select rectangle based on current mode.
   * @param {boolean|null} [forceValue=null] - Force a specific state, or null for auto.
   */
  updateSelectRectSuppression(forceValue = null) {
    let suppress = false;
    try {
      const im = window.MapShine?.interactionManager;
      const enabled = im?.selectionBoxParams?.enabled !== false;
      suppress = !this.isMapMakerMode && enabled;
    } catch (_) {
      suppress = !this.isMapMakerMode;
    }

    if (typeof forceValue === 'boolean') suppress = forceValue;

    // Avoid redundant patching
    if (this._selectSuppressed === suppress) return;
    this._selectSuppressed = suppress;

    try {
      const controls = canvas?.controls;
      if (!controls) return;

      const selectGfx = controls.select;
      const current = controls.drawSelect;

      if (suppress) {
        if (!this._origDrawSelect && typeof current === 'function') {
          this._origDrawSelect = current.bind(controls);
        }

        controls.drawSelect = ({ x, y, width, height } = {}) => {
          try {
            if (selectGfx?.clear) selectGfx.clear();
            if (selectGfx) selectGfx.visible = false;
          } catch (_) {}
        };

        try {
          if (selectGfx?.clear) selectGfx.clear();
          if (selectGfx) selectGfx.visible = false;
        } catch (_) {}
      } else {
        if (this._origDrawSelect) {
          controls.drawSelect = this._origDrawSelect;
        }
        try {
          if (selectGfx) selectGfx.visible = true;
        } catch (_) {}
      }
    } catch (_) {}
  }

  /**
   * Hard safety: Suppress PIXI visuals that are replaced by Three.js in Gameplay/Hybrid mode.
   * Idempotent and safe to call frequently.
   */
  enforceGameplayPixiSuppression() {
    try {
      if (!canvas?.ready) return;
      if (this.isMapMakerMode) return;

      // V12+: primary can render tiles/overheads/roofs. Keep hidden in gameplay.
      try {
        if (canvas.primary) canvas.primary.visible = false;
      } catch (_) {}

      // Check if Tiles layer is actively being edited
      let isTilesActive = false;
      try {
        const activeLayerObj = canvas.activeLayer;
        const activeLayerName = activeLayerObj?.options?.name || activeLayerObj?.name || '';
        const activeLayerCtor = activeLayerObj?.constructor?.name || '';
        isTilesActive = (activeLayerName === 'TilesLayer') ||
                        (activeLayerName === 'tiles') ||
                        (activeLayerCtor === 'TilesLayer');
      } catch (_) {
        isTilesActive = false;
      }

      // When not editing tiles, fully hide PIXI tile visuals (alpha=0)
      const alpha = isTilesActive ? 1 : 0;

      // Toggle Three.js tile visibility
      try {
        const tm = this._deps.tileManager ?? window.MapShine?.tileManager;
        if (tm?.setVisibility) tm.setVisibility(!isTilesActive);
      } catch (_) {}

      try {
        if (canvas.tiles?.placeables) {
          for (const tile of canvas.tiles.placeables) {
            if (!tile) continue;
            try {
              tile.visible = true;
              tile.interactive = true;
              tile.interactiveChildren = true;
            } catch (_) {}
            try { if (tile.mesh) tile.mesh.alpha = alpha; } catch (_) {}
            try { if (tile.texture) tile.texture.alpha = alpha; } catch (_) {}
            try {
              if (Array.isArray(tile.children)) {
                for (const child of tile.children) {
                  if (child && typeof child.alpha === 'number') child.alpha = alpha;
                }
              }
            } catch (_) {}
          }
        }
      } catch (_) {}
    } catch (_) {}
  }

  /**
   * Update visibility of Foundry layers based on active tool and mode.
   */
  updateLayerVisibility() {
    if (!canvas?.ready) return;

    // Always hide "replaced" layers in Gameplay/Hybrid Mode
    if (canvas.background) canvas.background.visible = false;
    if (canvas.grid) canvas.grid.visible = false;
    if (canvas.primary) canvas.primary.visible = false;
    if (canvas.weather) canvas.weather.visible = false;
    if (canvas.environment) canvas.environment.visible = false;

    // Tokens: transparent but interactive for clicks, HUD, selection
    if (canvas.tokens) {
      canvas.tokens.visible = true;
      canvas.tokens.interactiveChildren = true;
      for (const token of canvas.tokens.placeables) {
        if (token.mesh) token.mesh.alpha = 0;
        if (token.icon) token.icon.alpha = 0;
        if (token.border) token.border.alpha = 0;
        token.visible = true;
        token.interactive = true;
      }
    }

    // Drawings render via PIXI as an overlay
    if (canvas.drawings) canvas.drawings.visible = true;

    // Active layer detection
    const activeLayerObj = canvas.activeLayer;
    const activeLayerName = activeLayerObj?.options?.name || activeLayerObj?.name || '';
    const activeLayerCtor = activeLayerObj?.constructor?.name || '';
    const isActiveLayer = (name) => (activeLayerName === name) || (activeLayerCtor === name);

    // Walls
    if (canvas.walls) {
      const isWallsActive = isActiveLayer('WallsLayer') || isActiveLayer('walls');

      canvas.walls.visible = true;
      canvas.walls.interactiveChildren = true;

      const ALPHA = 0.01;
      if (Array.isArray(canvas.walls.placeables)) {
        for (const wall of canvas.walls.placeables) {
          if (!wall) continue;
          try {
            if (isWallsActive) {
              if (wall.line) wall.line.alpha = 1;
              if (wall.direction) wall.direction.alpha = 1;
              if (wall.endpoints) wall.endpoints.alpha = 1;
            } else {
              if (wall.line) wall.line.alpha = ALPHA;
              if (wall.direction) wall.direction.alpha = ALPHA;
              if (wall.endpoints) wall.endpoints.alpha = ALPHA;
            }
            if (wall.doorControl) {
              wall.doorControl.visible = true;
              wall.doorControl.alpha = 1;
            }
            wall.visible = true;
            wall.interactive = true;
            wall.interactiveChildren = true;
          } catch (_) {}
        }
      }
    }

    // Tiles
    if (canvas.tiles) {
      const isTilesActive = isActiveLayer('TilesLayer') || isActiveLayer('tiles');
      canvas.tiles.visible = isTilesActive;
      const tm = this._deps.tileManager;
      if (tm?.setVisibility) {
        tm.setVisibility(!isTilesActive && !this.isMapMakerMode);
      }
    }

    // Simple layers
    const simpleLayers = ['LightingLayer', 'SoundsLayer', 'TemplateLayer', 'NotesLayer', 'RegionLayer'];
    simpleLayers.forEach(name => {
      const layer = canvas[name === 'RegionLayer' ? 'regions' : name.replace('Layer', '').toLowerCase()];
      if (layer) {
        layer.visible = isActiveLayer(name) || isActiveLayer(name.replace('Layer', '').toLowerCase());
      }
    });

    if (canvas.regions) {
      canvas.regions.visible = isActiveLayer('RegionLayer') || isActiveLayer('regions');
    }
  }

  /**
   * Update Input Mode based on active tool (legacy path).
   * Skipped when ControlsIntegration is active.
   */
  updateInputMode() {
    if (!canvas?.ready) return;

    const ci = this._deps.controlsIntegration;
    if (ci && ci.getState() === 'active') return;

    const pixiCanvas = canvas.app?.view;
    if (!pixiCanvas) return;

    if (this.isMapMakerMode) {
      pixiCanvas.style.pointerEvents = 'auto';
      return;
    }

    this.updateLayerVisibility();

    const editLayers = [
      'SoundsLayer', 'TemplateLayer', 'DrawingsLayer', 'NotesLayer',
      'RegionLayer', 'regions', 'TilesLayer', 'tiles'
    ];

    setTimeout(() => {
      if (!canvas?.ready || this.isMapMakerMode) return;

      const finalLayerObj = canvas.activeLayer;
      const finalLayerName = finalLayerObj?.options?.name || finalLayerObj?.name || '';
      const finalLayerCtor = finalLayerObj?.constructor?.name || '';
      const isFinalLayer = (name) => (finalLayerName === name) || (finalLayerCtor === name);
      const isEditMode = editLayers.some(l => finalLayerName === l || finalLayerCtor === l);

      // Light icon visibility
      const lim = this._deps.lightIconManager;
      if (lim?.setVisibility) {
        const showLighting = (isFinalLayer('LightingLayer') || isFinalLayer('lighting')) && !this.isMapMakerMode;
        lim.setVisibility(showLighting);
      }

      const elim = this._deps.enhancedLightIconManager;
      if (elim?.setVisibility) {
        const showLighting = (isFinalLayer('LightingLayer') || isFinalLayer('lighting')) && !this.isMapMakerMode;
        elim.setVisibility(showLighting);
      }

      // Wall visibility
      const wm = this._deps.wallManager;
      if (wm?.setVisibility) {
        const showThreeWalls = (isFinalLayer('WallsLayer') || isFinalLayer('walls')) && !this.isMapMakerMode;
        wm.setVisibility(showThreeWalls);
      }

      if (isEditMode) {
        pixiCanvas.style.pointerEvents = 'auto';
        log.debug(`Input Mode: PIXI (Edit: ${finalLayerCtor || finalLayerName})`);
      } else {
        pixiCanvas.style.pointerEvents = 'none';
        log.debug(`Input Mode: THREE.js (Gameplay: ${finalLayerCtor || finalLayerName})`);
      }
    }, 0);
  }

  /**
   * Dispose mode manager — restore original state.
   */
  dispose() {
    // Restore select rect if suppressed
    this.updateSelectRectSuppression(false);
    this._origDrawSelect = null;
    this._selectSuppressed = false;
    this._mapMakerFogState = null;
    this._deps = {};
  }

  // ── Private ───────────────────────────────────────────────────────

  /**
   * Enable the Three.js System (Gameplay Mode).
   * @private
   */
  _enableSystem() {
    const { threeCanvas, renderLoop, controlsIntegration } = this._deps;
    if (!threeCanvas) return;

    this.enforceGameplayPixiSuppression();

    // Leaving Map Maker mode — restore fog overrides
    this._restoreMapMakerFogOverride();

    // Resume Render Loop
    if (renderLoop && !renderLoop.running()) {
      renderLoop.start();
    }

    // Three.js Canvas: visible and interactive
    threeCanvas.style.opacity = '1';
    threeCanvas.style.zIndex = '1';
    threeCanvas.style.pointerEvents = 'auto';

    // PIXI Canvas: transparent overlay
    const pixiCanvas = canvas?.app?.view;
    if (pixiCanvas) {
      pixiCanvas.style.opacity = '1';
      pixiCanvas.style.zIndex = '10';
      pixiCanvas.style.pointerEvents = 'none';
    }

    // Transparent PIXI background so Three.js shows through
    if (canvas?.app?.renderer?.background) {
      canvas.app.renderer.background.alpha = 0;
    }

    // Re-enable ControlsIntegration
    if (controlsIntegration) {
      const state = controlsIntegration.getState();
      if (state === 'disabled') {
        controlsIntegration.initialize().then(() => {
          log.info('ControlsIntegration re-enabled after Map Maker mode');
          this.enforceGameplayPixiSuppression();
        }).catch(err => {
          log.warn('Failed to re-enable ControlsIntegration:', err);
          this._configureFoundryCanvas();
          this.enforceGameplayPixiSuppression();
        });
      } else if (state === 'active') {
        controlsIntegration.layerVisibility?.update();
        controlsIntegration.inputRouter?.autoUpdate();
        this.enforceGameplayPixiSuppression();
      } else {
        this._configureFoundryCanvas();
        this.enforceGameplayPixiSuppression();
      }
    } else {
      this._configureFoundryCanvas();
      this.enforceGameplayPixiSuppression();
    }
  }

  /**
   * Disable the Three.js System (Map Maker Mode).
   * @private
   */
  _disableSystem() {
    const { renderLoop, threeCanvas, controlsIntegration } = this._deps;

    if (renderLoop && renderLoop.running()) {
      renderLoop.stop();
    }

    if (threeCanvas) {
      threeCanvas.style.opacity = '0';
      threeCanvas.style.pointerEvents = 'none';
    }

    // Disable ControlsIntegration BEFORE restoring PIXI
    if (controlsIntegration && controlsIntegration.getState() === 'active') {
      controlsIntegration.disable();
      log.info('ControlsIntegration disabled for Map Maker mode');
    } else {
      this.restoreFoundryRendering();
    }

    // GM convenience: prevent fog from blacking out the map while editing
    this._applyMapMakerFogOverride();
  }

  /**
   * Configure Foundry's PIXI canvas for Hybrid Mode (legacy fallback).
   * @private
   */
  _configureFoundryCanvas() {
    if (!canvas || !canvas.app) {
      log.warn('Cannot configure canvas — Foundry canvas not ready');
      return;
    }

    const ci = this._deps.controlsIntegration;
    if (ci && ci.getState() === 'active') {
      log.debug('Controls integration active, skipping legacy configureFoundryCanvas');
      return;
    }

    log.info('Configuring Foundry PIXI canvas for Hybrid Mode (legacy)');

    const pixiCanvas = canvas.app.view;
    if (pixiCanvas) {
      pixiCanvas.style.opacity = '1';
      pixiCanvas.style.pointerEvents = 'auto';
      pixiCanvas.style.zIndex = '10';
    }

    if (canvas.app?.renderer?.background) {
      canvas.app.renderer.background.alpha = 0;
    }

    this.updateLayerVisibility();
    this._setupInputArbitration();

    log.info('PIXI canvas configured for Replacement Mode (legacy)');
  }

  /**
   * Setup input arbitration hooks (legacy path).
   * @private
   */
  _setupInputArbitration() {
    // Remove existing listeners to avoid duplicates
    Hooks.off('changeSidebarTab', this.updateInputMode.bind(this));
    Hooks.off('renderSceneControls', this.updateInputMode.bind(this));

    Hooks.on('changeSidebarTab', () => this.updateInputMode());
    Hooks.on('renderSceneControls', () => this.updateInputMode());

    this.updateInputMode();
  }

  /**
   * Apply fog override for Map Maker mode (GM convenience).
   * @private
   */
  _applyMapMakerFogOverride() {
    if (!game?.user?.isGM) return;
    if (!canvas?.ready) return;

    if (!this._mapMakerFogState) {
      this._mapMakerFogState = {
        fogVisible: canvas.fog?.visible ?? null,
        visibilityVisible: canvas.visibility?.visible ?? null,
        visibilityFilterEnabled: canvas.visibility?.filter?.enabled ?? null
      };
    }

    try {
      if (canvas.fog) canvas.fog.visible = false;
      if (canvas.visibility) canvas.visibility.visible = false;
      if (canvas.visibility?.filter) canvas.visibility.filter.enabled = false;
    } catch (_) {}
  }

  /**
   * Restore fog override when leaving Map Maker mode.
   * @private
   */
  _restoreMapMakerFogOverride() {
    if (!this._mapMakerFogState) return;

    try {
      if (canvas?.fog && this._mapMakerFogState.fogVisible !== null) {
        canvas.fog.visible = this._mapMakerFogState.fogVisible;
      }
      if (canvas?.visibility && this._mapMakerFogState.visibilityVisible !== null) {
        canvas.visibility.visible = this._mapMakerFogState.visibilityVisible;
      }
      if (canvas?.visibility?.filter && this._mapMakerFogState.visibilityFilterEnabled !== null) {
        canvas.visibility.filter.enabled = this._mapMakerFogState.visibilityFilterEnabled;
      }
    } catch (_) {} finally {
      this._mapMakerFogState = null;
    }
  }
}
