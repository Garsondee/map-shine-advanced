/**
 * @fileoverview Gameplay / PIXI-native parity mode switching for Map Shine.
 * 
 * Extracted from canvas-replacement.js to isolate:
 * - Mode toggling (Gameplay ↔ PIXI native parity mode)
 * - PIXI state capture/restore
 * - Select rect suppression
 * - Layer visibility management
 * - Input arbitration (legacy path)
 * - Foundry rendering state management
 * - UI layering (z-index)
 * 
 * @module foundry/mode-manager
 */
import { isGmLike } from '../core/gm-parity.js';

import { createLogger } from '../core/log.js';
import * as sceneSettings from '../settings/scene-settings.js';
import { getConfiguredCanvasLayer } from './canvas-layer-resolve.js';

const log = createLogger('ModeManager');

/**
 * Manages the Gameplay / PIXI-native parity mode lifecycle.
 * 
 * In Gameplay mode, Three.js is the primary renderer and interaction handler.
 * In parity mode, Foundry's PIXI canvas takes over for native rendering checks.
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
   * Set native Foundry rendering parity mode (master toggle).
   * @param {boolean} enabled - True for native Foundry PIXI, False for Map Shine Three.js gameplay.
   */
  setMapMakerMode(enabled) {
    if (this.isMapMakerMode === enabled) return;

    this.isMapMakerMode = enabled;

    // In parity mode, Foundry should own drag-select visuals (PIXI).
    // In Gameplay mode, MapShine should own drag-select visuals (DOM + Three shadow).
    this.updateSelectRectSuppression();
    log.info(`Switching to ${enabled ? 'PIXI / Native Foundry rendering' : 'Map Shine gameplay rendering'} mode`);

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

    // Gameplay mode installs a board suppression observer in canvas-replacement.
    // In native PIXI parity mode we must explicitly bypass that suppression.
    try {
      if (window.MapShine) window.MapShine.__forcePixiEditorOverlay = true;
    } catch (_) {}

    // Restore PIXI renderer background to opaque
    if (canvas.app?.renderer?.background) {
      canvas.app.renderer.background.alpha = 1;
    }

    // Restore PIXI canvas to default state
    const pixiCanvas = canvas.app.view;
    if (pixiCanvas) {
      pixiCanvas.style.display = '';
      pixiCanvas.style.visibility = 'visible';
      pixiCanvas.style.opacity = '1';
      pixiCanvas.style.pointerEvents = 'auto';
      pixiCanvas.style.zIndex = '';
    }

    // Foundry's top-level rendered board canvas is #board.
    const board = document.getElementById('board');
    if (board && board.tagName === 'CANVAS') {
      board.style.display = '';
      board.style.visibility = 'visible';
      board.style.opacity = '1';
      board.style.pointerEvents = 'auto';
      board.style.zIndex = '';
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
   * Always restore Foundry's native drag-select implementation (bypasses redundant
   * short-circuit in updateSelectRectSuppression). Used when leaving MSA scenes
   * or when the canvas-replacement path patched drawSelect without flipping
   * {@link #_selectSuppressed}.
   */
  forceRestoreFoundrySelectRect() {
    this._selectSuppressed = false;
    try {
      const controls = canvas?.controls;
      if (!controls) return;

      const selectGfx = controls.select;
      if (this._origDrawSelect) {
        controls.drawSelect = this._origDrawSelect;
      }
      try {
        if (selectGfx) selectGfx.visible = true;
      } catch (_) {}
    } catch (_) {}
  }

  /**
   * Suppress or restore Foundry's drag-select rectangle based on current mode.
   * @param {boolean|null} [forceValue=null] - Force a specific state, or null for auto.
   */
  updateSelectRectSuppression(forceValue = null) {
    try {
      if (canvas?.scene && !sceneSettings.isEnabled(canvas.scene)) {
        this.forceRestoreFoundrySelectRect();
        return;
      }
    } catch (_) {}

    let suppress = false;
    try {
      const im = window.MapShine?.interactionManager;
      const enabled = im?.selectionBoxParams?.enabled !== false;
      suppress = !this.isMapMakerMode && enabled && this._isTokenMarqueeContextActive();
    } catch (_) {
      suppress = !this.isMapMakerMode && this._isTokenMarqueeContextActive();
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
   * Foundry marquee suppression should only apply to token marquee workflows.
   * Drawings/templates/notes/etc. should keep native PIXI marquee behavior.
   * @returns {boolean}
   * @private
   */
  _isTokenMarqueeContextActive() {
    const layer = canvas?.activeLayer;
    const optionsName = String(layer?.options?.name || '').toLowerCase();
    const name = String(layer?.name || '').toLowerCase();
    const ctor = String(layer?.constructor?.name || '').toLowerCase();
    const sceneControlName = String(ui?.controls?.control?.name || ui?.controls?.activeControl || '').toLowerCase();
    const sceneControlLayer = String(ui?.controls?.control?.layer || '').toLowerCase();
    const activeTool = String(ui?.controls?.tool?.name || ui?.controls?.activeTool || game?.activeTool || '').toLowerCase();

    const toolAllowsTokenMarquee = !activeTool || activeTool === 'select' || activeTool === 'target' || activeTool === 'ruler';
    const isTokenControl = sceneControlName === 'tokens' || sceneControlLayer === 'tokens';
    const isTokenLayer =
      optionsName === 'tokens' ||
      name === 'tokens' ||
      ctor === 'tokenlayer' ||
      ctor === 'tokenslayer';

    return toolAllowsTokenMarquee && (isTokenControl || isTokenLayer);
  }

  /**
   * Hard safety: Suppress PIXI visuals that are replaced by Three.js in Gameplay/Hybrid mode.
   * Idempotent and safe to call frequently.
   */
  enforceGameplayPixiSuppression() {
    try {
      if (!canvas?.ready) return;
      if (this.isMapMakerMode) return;

      // Keep primary alive; suppress only scene-bearing visuals.
      try {
        if (canvas.primary) {
          canvas.primary.visible = true;
          if (canvas.primary.background) canvas.primary.background.visible = false;
          if (canvas.primary.foreground) canvas.primary.foreground.visible = false;
          if (canvas.primary.tiles) canvas.primary.tiles.visible = false;
        }
      } catch (_) {}

      // Tiles are fully Three-owned in gameplay. Keep PIXI visuals suppressed.
      const alpha = 0;

      // Keep Three.js tile visibility enabled in gameplay.
      try {
        const tm = this._deps.tileManager ?? window.MapShine?.tileManager;
        if (tm?.setVisibility) tm.setVisibility(true);
      } catch (_) {}

      try {
        if (canvas.tiles?.placeables) {
          for (const tile of canvas.tiles.placeables) {
            if (!tile) continue;
            // Gameplay mode: Three.js canvas owns input (pointerEvents:auto).
            // Do NOT set interactive=true — that sets eventMode='static' for ALL
            // tiles including the overhead tile, which absorbs click events if PIXI
            // ever temporarily receives pointer events.
            try { tile.visible = true; } catch (_) {}
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
    // Single-source policy: use gameplay suppression as authority.
    this.enforceGameplayPixiSuppression();
    if (canvas.drawings) canvas.drawings.visible = true;
    if (canvas.templates) canvas.templates.visible = true;
    if (canvas.notes) canvas.notes.visible = true;
    if (canvas.lighting) {
      // Match canvas-replacement V2 policy: do not force PIXI light disks on when
      // Three.js LightingEffectV2 owns them (avoids duplicate / stale radii).
      if (window.MapShine?.__v2Active === true) {
        const activeControl = String(ui?.controls?.control?.name || ui?.controls?.activeControl || '').toLowerCase();
        const activeControlLayer = String(ui?.controls?.control?.layer || '').toLowerCase();
        const activeLayerName = String(canvas?.activeLayer?.options?.name || canvas?.activeLayer?.name || '').toLowerCase();
        const activeLayerCtor = String(canvas?.activeLayer?.constructor?.name || '').toLowerCase();
        const lightingEdit =
          !!canvas?.lighting?.active
          || activeControl === 'lighting'
          || activeControl === 'light'
          || activeControlLayer === 'lighting'
          || activeControlLayer === 'light'
          || activeLayerName === 'lighting'
          || activeLayerName === 'light'
          || activeLayerCtor === 'lightinglayer';
        canvas.lighting.visible = lightingEdit;
      } else {
        canvas.lighting.visible = true;
      }
    }
    if (canvas.sounds) canvas.sounds.visible = true;
    if (canvas.regions) canvas.regions.visible = true;
    if (canvas.controls) canvas.controls.visible = true;
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
      'RegionLayer', 'regions'
    ];

    setTimeout(() => {
      if (!canvas?.ready || this.isMapMakerMode) return;

      const finalLayerObj = canvas.activeLayer;
      const finalLayerName = String(finalLayerObj?.options?.name || finalLayerObj?.name || '').toLowerCase();
      const finalLayerCtor = String(finalLayerObj?.constructor?.name || '').toLowerCase();
      const finalControl = String(ui?.controls?.activeControl || ui?.controls?.control?.name || '').toLowerCase();
      const isFinalLayer = (name) => {
        const normalized = String(name || '').toLowerCase();
        return finalLayerName === normalized || finalLayerCtor === normalized || finalControl === normalized;
      };
      const isLightingFinal = !!canvas?.lighting?.active || isFinalLayer('LightingLayer') || isFinalLayer('lighting');
      const isWallsFinal = !!canvas?.walls?.active || isFinalLayer('WallsLayer') || isFinalLayer('WallLayer') || isFinalLayer('walls');
      const isEditMode = editLayers.some(l => isFinalLayer(l)) || isLightingFinal || isWallsFinal;

      // Light icon visibility
      const lim = this._deps.lightIconManager;
      if (lim?.setVisibility) {
        const showLighting = isLightingFinal && !this.isMapMakerMode;
        lim.setVisibility(showLighting);
      }

      const elim = this._deps.enhancedLightIconManager;
      if (elim?.setVisibility) {
        const showLighting = isLightingFinal && !this.isMapMakerMode;
        elim.setVisibility(showLighting);
      }

      // Wall visibility
      const wm = this._deps.wallManager;
      if (wm?.setVisibility) {
        const showThreeWalls = !isWallsFinal && !this.isMapMakerMode;
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
    this.forceRestoreFoundrySelectRect();
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

    try {
      if (window.MapShine) window.MapShine.__forcePixiEditorOverlay = false;
    } catch (_) {}

    this.enforceGameplayPixiSuppression();

    // Leaving Map Maker mode — restore fog overrides
    this._restoreMapMakerFogOverride();

    // Resume Render Loop
    if (renderLoop && !renderLoop.running()) {
      renderLoop.start();
    }

    // Three.js Canvas: visible and interactive
    threeCanvas.style.opacity = '1';
    threeCanvas.style.zIndex = '100';
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

    try {
      if (window.MapShine) window.MapShine.__forcePixiEditorOverlay = true;
    } catch (_) {}

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
    }

    // Always restore native PIXI visuals when parity mode is active.
    this.restoreFoundryRendering();

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
    if (!isGmLike()) return;
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
