/**
 * @fileoverview Controls Integration - Main orchestrator for Foundry Scene Controls
 * Implements the PIXI Overlay Strategy for reliable native Foundry tool support
 * @module foundry/controls-integration
 */

import { createLogger } from '../core/log.js';
import { LayerVisibilityManager } from './layer-visibility-manager.js';
import { InputRouter } from './input-router.js';
import { CameraSync } from './camera-sync.js';

const log = createLogger('ControlsIntegration');

/**
 * Integration state enum
 * @readonly
 * @enum {string}
 */
export const IntegrationState = {
  UNINITIALIZED: 'uninitialized',
  INITIALIZING: 'initializing',
  ACTIVE: 'active',
  SYNCING: 'syncing',
  ERROR: 'error',
  FALLBACK: 'fallback',
  DISABLED: 'disabled'
};

/**
 * Main orchestrator for Foundry Scene Controls integration
 * Coordinates PIXI overlay, camera sync, input routing, and layer visibility
 */
export class ControlsIntegration {
  /**
   * @param {object} options
   * @param {import('../scene/composer.js').SceneComposer} options.sceneComposer
   * @param {import('../effects/EffectComposer.js').EffectComposer} [options.effectComposer]
   */
  constructor(options = {}) {
    /** @type {import('../scene/composer.js').SceneComposer|null} */
    this.sceneComposer = options.sceneComposer || null;
    
    /** @type {import('../effects/EffectComposer.js').EffectComposer|null} */
    this.effectComposer = options.effectComposer || null;
    
    /** @type {IntegrationState} */
    this.state = IntegrationState.UNINITIALIZED;
    
    /** @type {number} */
    this.errorCount = 0;
    
    /** @type {number} */
    this.maxErrors = 3;
    
    /** @type {{error: Error, context: string, timestamp: number}|null} */
    this.lastError = null;
    
    /** @type {LayerVisibilityManager|null} */
    this.layerVisibility = null;
    
    /** @type {InputRouter|null} */
    this.inputRouter = null;
    
    /** @type {CameraSync|null} */
    this.cameraSync = null;
    
    /** @type {boolean} */
    this._initialized = false;
    
    /** @type {number[]} */
    this._hookIds = [];

    /** @type {boolean} */
    this._environmentInitWrapped = false;

    /** @type {Function|null} */
    this._originalEnvironmentInitialize = null;

    /**
     * Track wall visual hiding strategy.
     * We keep the Walls layer itself visible so door controls/icons can render,
     * but hide the wall segments unless the Walls layer is actively being edited.
     * @type {boolean}
     */
    this._wallsAreTransparent = false;
  }

  /**
   * When ControlsIntegration is active, canvas-replacement's legacy input mode
   * arbiter does not run its light-gizmo visibility updates. We replicate the
   * minimum needed behavior here so Three.js light handles work in Gameplay mode.
   * @private
   */
  _updateThreeGizmoVisibility() {
    try {
      if (!canvas?.ready) return;

      const isMapMakerMode = !!window.MapShine?.isMapMakerMode;

      const layerName = canvas.activeLayer?.name || canvas.activeLayer?.constructor?.name || '';
      const showLighting = (layerName === 'LightingLayer' || layerName === 'lighting') && !isMapMakerMode;

      const tool = ui?.controls?.tool?.name ?? game.activeTool;
      const mapshineToolActive = tool === 'map-shine-enhanced-light' || tool === 'map-shine-sun-light';

      const lightIconManager = window.MapShine?.lightIconManager;
      if (lightIconManager?.setVisibility) {
        lightIconManager.setVisibility(showLighting && !mapshineToolActive);
      }

      const enhancedLightIconManager = window.MapShine?.enhancedLightIconManager;
      if (enhancedLightIconManager?.setVisibility) {
        enhancedLightIconManager.setVisibility(showLighting);
      }
    } catch (_) {
      // Ignore - visibility is best-effort
    }
  }

  /**
   * One-shot camera sync is now handled by CameraFollower.initialize()
   * This method is kept for backwards compatibility but does nothing.
   * @private
   * @deprecated CameraFollower handles sync automatically each frame
   */
  syncThreeFromPixiOnce() {
    // CameraFollower handles sync automatically each frame
    log.debug('syncThreeFromPixiOnce called (no-op, CameraFollower handles sync)');
  }
  
  /**
   * Initialize the controls integration system
   * @returns {Promise<boolean>} Success status
   */
  async initialize() {
    if (this._initialized) {
      log.warn('Controls integration already initialized');
      return true;
    }
    
    this.transition(IntegrationState.INITIALIZING, 'Starting initialization');
    
    try {
      // Validate canvas state
      const validation = this.validateCanvasState();
      if (!validation.valid) {
        throw new Error(`Canvas state invalid: ${validation.issues.join(', ')}`);
      }
      
      // Configure PIXI canvas for transparent overlay
      this.configurePixiOverlay();
      
      // Initialize sub-systems
      this.layerVisibility = new LayerVisibilityManager();
      this.inputRouter = new InputRouter();
      
      // CameraSync is deprecated - CameraFollower handles all camera sync
      // We keep the reference for backwards compatibility but don't use it
      this.cameraSync = null;
      
      // Register hooks
      this.registerHooks();
      
      // Initial state sync
      this.layerVisibility.update();
      this.inputRouter.autoUpdate();

      // Keep Three.js light gizmos in sync with the active layer/tool.
      this._updateThreeGizmoVisibility();
      
      // Camera sync is now handled by CameraFollower
      // which was initialized before ControlsIntegration in canvas-replacement.js
      // CameraFollower reads PIXI state each frame and applies to Three.js
      log.debug('CameraFollower is handling camera sync');
      
      this._initialized = true;
      this.transition(IntegrationState.ACTIVE, 'Initialization complete');
      
      log.info('Controls integration initialized successfully');
      return true;
      
    } catch (error) {
      this.handleError(error, 'initialization');
      return false;
    }
  }
  
  /**
   * Validate that the canvas is in a usable state
   * @returns {{valid: boolean, issues: string[]}}
   */
  validateCanvasState() {
    const issues = [];
    
    if (!canvas?.ready) issues.push('Canvas not ready');
    if (!canvas?.stage) issues.push('Stage not initialized');
    if (!canvas?.app?.renderer) issues.push('Renderer not available');
    if (!canvas?.app?.view) issues.push('Canvas view not available');
    
    // Check for expected layers
    const requiredLayers = ['tokens', 'walls', 'lighting', 'controls'];
    for (const name of requiredLayers) {
      if (!canvas[name]) issues.push(`Missing layer: ${name}`);
    }
    
    return { valid: issues.length === 0, issues };
  }
  
  /**
   * Configure PIXI canvas as a transparent overlay
   * @private
   */
  configurePixiOverlay() {
    const pixiCanvas = canvas.app?.view;
    if (!pixiCanvas) {
      throw new Error('PIXI canvas view not found');
    }
    
    log.info('Configuring PIXI canvas as transparent overlay');
    
    // Strategy: PIXI canvas stays ON TOP (z-index 10) with opacity 1
    // Three.js canvas is below (z-index 1) but visible through transparent PIXI background
    // Layer visibility is managed by LayerVisibilityManager - replaced layers are hidden,
    // "always visible" layers (drawings, templates, notes) stay visible
    
    // CRITICAL: Set PIXI renderer background to transparent
    // Without this, the PIXI background color renders over Three.js content
    this._enforcePixiTransparency();

    this._wrapEnvironmentInitialize();
    
    // HYBRID STRATEGY: Three.js handles gameplay interaction, PIXI is a transparent
    // overlay whose interactivity is controlled by InputRouter.
    
    // PIXI canvas: on top, initially non-interactive (Three.js receives clicks)
    pixiCanvas.style.opacity = '1'; // Keep visible for overlay layers
    pixiCanvas.style.zIndex = '10'; // On top
    pixiCanvas.style.pointerEvents = 'none'; // InputRouter will enable this for edit tools
    
    // Three.js canvas: below PIXI, interactive in gameplay
    const threeCanvas = document.getElementById('map-shine-canvas');
    if (threeCanvas) {
      threeCanvas.style.zIndex = '1'; // Below PIXI
      threeCanvas.style.opacity = '1';
      threeCanvas.style.pointerEvents = 'auto';
    }
    
    // Immediately hide replaced PIXI layers (background, grid, tokens, etc.)
    // These are rendered by Three.js, so they must be hidden to prevent double-rendering
    this.hideReplacedLayers();

    // Ensure wall visuals are configured correctly (doors should remain visible)
    this._updateWallsVisualState();
    
    // Re-hide visibility layer after sight refresh (Foundry may re-show it)
    Hooks.on('sightRefresh', () => {
      this._hideVisibilityLayer();
    });
    
    log.debug('PIXI overlay configured: opacity 0, z-index 10 (on top but transparent)');
  }

  _enforcePixiTransparency() {
    try {
      if (canvas.app?.renderer?.background) {
        canvas.app.renderer.background.alpha = 0;
      }
    } catch (e) {
      log.warn('Failed to enforce PIXI renderer background alpha', e);
    }
  }

  _wrapEnvironmentInitialize() {
    if (this._environmentInitWrapped) return;

    const env = canvas?.environment;
    const init = env?.initialize;
    if (typeof init !== 'function') return;

    this._originalEnvironmentInitialize = init;

    const self = this;
    env.initialize = function(...args) {
      const result = init.apply(this, args);
      try {
        self._enforcePixiTransparency();
      } catch (_) {
        // Ignore
      }
      return result;
    };

    this._environmentInitWrapped = true;
  }

  _unwrapEnvironmentInitialize() {
    if (!this._environmentInitWrapped) return;

    const env = canvas?.environment;
    if (env && this._originalEnvironmentInitialize) {
      try {
        env.initialize = this._originalEnvironmentInitialize;
      } catch (_) {
        // Ignore
      }
    }

    this._environmentInitWrapped = false;
    this._originalEnvironmentInitialize = null;
  }
  
  /**
   * Configure PIXI layers for hybrid rendering
   * Visually hidden layers are still interactive - PIXI handles all clicks
   * @private
   */
  hideReplacedLayers() {
    if (!canvas?.ready) return;
    
    // These layers are VISUALLY replaced by Three.js but remain INTERACTIVE
    // We hide the visual elements but keep interaction enabled
    const visuallyReplacedLayers = ['background', 'grid', 'primary', 'weather', 'environment'];
    
    for (const name of visuallyReplacedLayers) {
      const layer = canvas[name];
      if (layer) {
        layer.visible = false;
        log.debug(`Hidden visual layer: ${name}`);
      }
    }

    // Also hide the native Fog of War visual layers. We replace fog
    // rendering with WorldSpaceFogEffect which renders fog as a world-space
    // plane mesh. Turning these layers invisible prevents double-fog artifacts.
    // Foundry's vision sources are still computed - we just hide the visual output.
    
    // canvas.fog contains the exploration sprite
    if (canvas.fog) {
      try {
        canvas.fog.visible = false;
        log.debug('Hidden native fog layer');
      } catch (_) {
        // Ignore - fog layer structure may vary by Foundry version
      }
    }
    
    // canvas.visibility is the layer that applies the actual fog filter
    // This is the main source of the "double fog" issue - it renders
    // Foundry's native visibility filter which we're replacing with WorldSpaceFogEffect
    // 
    // IMPORTANT: We set visible=false but keep the layer's internal rendering active
    // so that canvas.effects.visionSources continues to be computed. The visibility layer
    // itself won't draw to screen, but vision polygon computation still happens.
    if (canvas.visibility) {
      try {
        // Hide the visibility layer's visual output
        canvas.visibility.visible = false;
        
        // Also disable the visibility filter if it exists
        // This filter is what actually draws the fog overlay
        if (canvas.visibility.filter) {
          canvas.visibility.filter.enabled = false;
        }
        
        // Hide the vision sub-container which renders the red vision polygons
        if (canvas.visibility.vision) {
          canvas.visibility.vision.visible = false;
        }
        
        // Hide any other visibility children
        if (canvas.visibility.children) {
          for (const child of canvas.visibility.children) {
            if (child.visible !== undefined) {
              child.visible = false;
            }
          }
        }
        
        log.debug('Hidden native visibility layer, filter, and children');
      } catch (_) {
        // Ignore - visibility layer structure may vary by Foundry version
      }
    }
    
    // CRITICAL: Tokens layer needs special handling
    // - Visual rendering is done by Three.js (TokenManager)
    // - But PIXI tokens must remain INTERACTIVE for clicks, HUD, cursor, etc.
    // - We make token meshes effectively transparent (very low alpha) instead of invisible
    // - This keeps the hit area active while Three.js renders the visuals
    if (canvas.tokens) {
      // Keep the layer itself visible and interactive
      canvas.tokens.visible = true;
      canvas.tokens.interactiveChildren = true;
      
      // Make individual token meshes transparent but keep them interactive
      // Setting visible=false would disable hit detection, so we use alpha instead
      for (const token of canvas.tokens.placeables) {
        this.makeTokenTransparent(token);
      }
      log.debug('Tokens layer: meshes transparent, interaction enabled');
    }

    // Walls layer needs special handling:
    // - We want native door controls/icons to remain visible as an overlay.
    // - But wall segments themselves are rendered in Three.js.
    // So we keep the Walls layer visible, but make its non-door visuals transparent
    // unless the Walls layer is actively being edited.
    if (canvas.walls) {
      canvas.walls.visible = true;
      canvas.walls.interactiveChildren = true;
    }
  }

  /**
   * Make a PIXI wall visually transparent but keep door controls visible.
   * @param {Wall} wall
   * @private
   */
  _makeWallTransparent(wall) {
    if (!wall) return;

    try {
      const ALPHA = 0.01;

      // Wall line graphics
      if (wall.line) wall.line.alpha = ALPHA;

      // Direction arrow graphics (if present)
      if (wall.direction) wall.direction.alpha = ALPHA;

      // Endpoints (if present)
      if (wall.endpoints) {
        wall.endpoints.alpha = ALPHA;
      }

      // Keep door control visible (this is what shows the door icon)
      if (wall.doorControl) {
        wall.doorControl.visible = true;
        wall.doorControl.alpha = 1;
      }

      wall.visible = true;
      wall.interactive = true;
      wall.interactiveChildren = true;
    } catch (_) {
      // Ignore - wall structure can vary by Foundry version
    }
  }

  /**
   * Restore a PIXI wall's visual alpha to default so walls are visible for editing.
   * @param {Wall} wall
   * @private
   */
  _restoreWallVisuals(wall) {
    if (!wall) return;

    try {
      if (wall.line) wall.line.alpha = 1;
      if (wall.direction) wall.direction.alpha = 1;
      if (wall.endpoints) wall.endpoints.alpha = 1;
      if (wall.doorControl) {
        wall.doorControl.visible = true;
        wall.doorControl.alpha = 1;
      }
    } catch (_) {
      // Ignore
    }
  }

  /**
   * Ensure wall visuals are correct for the current active layer.
   * @private
   */
  _updateWallsVisualState() {
    if (!canvas?.ready || !canvas.walls?.placeables) return;

    const activeLayerName = canvas.activeLayer?.constructor?.name || canvas.activeLayer?.name || '';
    const isWallsActive = activeLayerName === 'WallsLayer' || activeLayerName === 'walls';

    try {
      const wallManager = window.MapShine?.wallManager;
      if (wallManager?.updateVisibility) {
        wallManager.updateVisibility();
      }
    } catch (_) {
    }

    try {
      if (!isWallsActive) {
        const im = window.MapShine?.interactionManager;
        const preview = im?.wallDraw?.previewLine;
        if (preview && preview.visible) {
          preview.visible = false;
        }
      }
    } catch (_) {
    }

    if (isWallsActive) {
      if (this._wallsAreTransparent) {
        for (const wall of canvas.walls.placeables) this._restoreWallVisuals(wall);
        this._wallsAreTransparent = false;
      }
    } else {
      if (!this._wallsAreTransparent) {
        for (const wall of canvas.walls.placeables) this._makeWallTransparent(wall);
        this._wallsAreTransparent = true;
      }
    }
  }
  
  /**
   * Hide the visibility layer and its children
   * Called on sightRefresh to ensure Foundry doesn't re-show it
   * @private
   */
  _hideVisibilityLayer() {
    if (!canvas?.visibility) return;
    
    try {
      canvas.visibility.visible = false;
      
      if (canvas.visibility.filter) {
        canvas.visibility.filter.enabled = false;
      }
      
      if (canvas.visibility.vision) {
        canvas.visibility.vision.visible = false;
      }
      
      if (canvas.visibility.children) {
        for (const child of canvas.visibility.children) {
          if (child.visible !== undefined) {
            child.visible = false;
          }
        }
      }
    } catch (_) {
      // Ignore errors
    }
  }
  
  /**
   * Make a PIXI token transparent but keep it interactive
   * This allows Three.js to render the token while PIXI handles clicks/cursor
   * @param {Token} token - Foundry Token placeable
   * @private
   */
  makeTokenTransparent(token) {
    if (!token) return;
    
    try {
      // The token's mesh is the main visual element
      // Use a tiny non-zero alpha so it is effectively invisible but still pickable
      const ALPHA = 0.01;
      if (token.mesh) {
        token.mesh.alpha = ALPHA;
      }
      
      // Also handle the token's main sprite/container if different from mesh
      if (token.icon && token.icon !== token.mesh) {
        token.icon.alpha = ALPHA;
      }
      
      // Hide any border/frame graphics but keep token interactive
      if (token.border) {
        token.border.alpha = ALPHA;
      }
      
      // Keep the token itself visible (for hit area) but children transparent
      token.visible = true;
      token.interactive = true;
      token.interactiveChildren = true;
      
      // Ensure the hit area covers the token bounds
      // Foundry tokens typically have a hitArea set already
      if (!token.hitArea && token.bounds) {
        token.hitArea = token.bounds;
      }
    } catch (error) {
      // Silently ignore - token structure may vary between Foundry versions
    }
  }
  
  /**
   * Register Foundry hooks for integration
   * @private
   */
  registerHooks() {
    // Layer activation - update visibility and input routing
    const activateHookId = Hooks.on('activateCanvasLayer', (layer) => {
      if (this.state !== IntegrationState.ACTIVE) return;

      // Defer to next tick to ensure Foundry has finished switching layers/tools.
      setTimeout(() => {
        try {
          log.debug(`Layer activated: ${layer?.constructor?.name || 'unknown'}`);
          this.layerVisibility?.update();
          this.inputRouter?.autoUpdate();
          this._updateWallsVisualState();
          this._updateThreeGizmoVisibility();
        } catch (error) {
          this.handleError(error, 'activateCanvasLayer');
        }
      }, 0);
    });
    this._hookIds.push({ name: 'activateCanvasLayer', id: activateHookId });

    // Scene controls render - update input routing after tool changes
    const controlsHookId = Hooks.on('renderSceneControls', () => {
      if (this.state !== IntegrationState.ACTIVE) return;

      // Defer to next tick to ensure Foundry has finished updating
      setTimeout(() => {
        try {
          this.inputRouter?.autoUpdate();
          this._updateWallsVisualState();
          this._updateThreeGizmoVisibility();
        } catch (error) {
          this.handleError(error, 'renderSceneControls');
        }
      }, 0);
    });
    this._hookIds.push({ name: 'renderSceneControls', id: controlsHookId });

    // Canvas pan - CameraFollower handles sync automatically each frame
    // This hook is kept for potential future use but does nothing currently
    const panHookId = Hooks.on('canvasPan', (canvas, position) => {
      if (this.state !== IntegrationState.ACTIVE) return;
      // CameraFollower reads PIXI state each frame - no explicit sync needed
    });
    this._hookIds.push({ name: 'canvasPan', id: panHookId });

    // Sidebar collapse - CameraFollower will pick up the change next frame
    const sidebarHookId = Hooks.on('collapseSidebar', () => {
      if (this.state !== IntegrationState.ACTIVE) return;
      // CameraFollower reads PIXI state each frame - no explicit sync needed
    });
    this._hookIds.push({ name: 'collapseSidebar', id: sidebarHookId });

    // Token refresh - make PIXI token transparent (Three.js renders visuals)
    // This ensures newly created or refreshed tokens stay interactive but invisible
    const refreshTokenHookId = Hooks.on('refreshToken', (token) => {
      if (this.state !== IntegrationState.ACTIVE) return;

      try {
        // Make token transparent but keep it interactive
        this.makeTokenTransparent(token);

        // Token refresh can happen during control/drag updates and may coincide with
        // Foundry updating wall/door control visibility. Re-assert our walls visual state
        // on the next tick.
        setTimeout(() => {
          try {
            this._updateWallsVisualState();
          } catch (_) {
          }
        }, 0);
      } catch (error) {
        // Silently ignore - token might not be ready yet
      }
    });
    this._hookIds.push({ name: 'refreshToken', id: refreshTokenHookId });

    // When a token is controlled/released, Foundry may adjust control icon visibility.
    // Re-assert that the walls layer stays visible so door controls/icons remain visible.
    const controlTokenHookId = Hooks.on('controlToken', () => {
      if (this.state !== IntegrationState.ACTIVE) return;
      setTimeout(() => {
        try {
          // Keep walls layer visible for door controls
          if (canvas?.walls) {
            canvas.walls.visible = true;
            canvas.walls.interactiveChildren = true;
          }
          this._updateWallsVisualState();
        } catch (_) {
        }
      }, 0);
    });
    this._hookIds.push({ name: 'controlToken', id: controlTokenHookId });

    // Wall refresh - reapply transparency so door controls stay visible
    const refreshWallHookId = Hooks.on('refreshWall', (wall) => {
      if (this.state !== IntegrationState.ACTIVE) return;
      try {
        // Only apply transparency when not actively editing walls
        if (this._wallsAreTransparent) {
          this._makeWallTransparent(wall);
        }
      } catch (_) {
      }
    });
    this._hookIds.push({ name: 'refreshWall', id: refreshWallHookId });

    const createWallHookId = Hooks.on('createWall', (doc) => {
      if (this.state !== IntegrationState.ACTIVE) return;

      // Defer to allow Foundry to create the wall object
      setTimeout(() => {
        try {
          const wall = canvas.walls?.get(doc.id);
          if (!wall) return;

          if (this._wallsAreTransparent) {
            this._makeWallTransparent(wall);
          }
        } catch (_) {
        }
      }, 50);
    });
    this._hookIds.push({ name: 'createWall', id: createWallHookId });

    // Also handle createToken to catch initial creation
    const createTokenHookId = Hooks.on('createToken', (doc, options, userId) => {
      if (this.state !== IntegrationState.ACTIVE) return;

      // Defer to allow Foundry to create the token object
      setTimeout(() => {
        try {
          const token = canvas.tokens?.get(doc.id);
          if (token) {
            this.makeTokenTransparent(token);
          }
        } catch (error) {
          // Silently ignore
        }
      }, 50);
    });
    this._hookIds.push({ name: 'createToken', id: createTokenHookId });

    log.debug(`Registered ${this._hookIds.length} integration hooks`);
  }
  
  /**
   * Unregister all hooks
   * @private
   */
  unregisterHooks() {
    for (const { name, id } of this._hookIds) {
      Hooks.off(name, id);
    }
    this._hookIds = [];
    log.debug('Unregistered all integration hooks');
  }
  
  /**
   * Transition to a new state
   * @param {IntegrationState} newState
   * @param {string} [reason='']
   */
  transition(newState, reason = '') {
    const oldState = this.state;
    this.state = newState;
    
    log.info(`State: ${oldState} -> ${newState}${reason ? `: ${reason}` : ''}`);
    
    // Emit event for other systems to react
    Hooks.callAll('mapShineStateChange', { oldState, newState, reason });
  }
  
  /**
   * Handle an error during integration
   * @param {Error} error
   * @param {string} [context='']
   */
  handleError(error, context = '') {
    this.errorCount++;
    this.lastError = { error, context, timestamp: Date.now() };
    
    log.error(`Error [${context}]:`, error);
    
    if (this.errorCount >= this.maxErrors) {
      this.transition(IntegrationState.FALLBACK, 'Too many errors');
      this.enableFallbackMode();
    } else {
      this.transition(IntegrationState.ERROR, error.message);
      // Attempt recovery after delay
      setTimeout(() => this.attemptRecovery(), 1000);
    }
  }
  
  /**
   * Attempt to recover from an error state
   */
  attemptRecovery() {
    if (this.state !== IntegrationState.ERROR) return;
    
    log.info('Attempting recovery...');
    
    try {
      // Re-validate canvas state
      const validation = this.validateCanvasState();
      if (validation.valid) {
        // Re-sync everything
        this.configurePixiOverlay();
        this.layerVisibility?.update();
        this.inputRouter?.autoUpdate();
        this._updateThreeGizmoVisibility();
        this.cameraSync?.forceFullSync();
        
        this.transition(IntegrationState.ACTIVE, 'Recovery successful');
        this.errorCount = Math.max(0, this.errorCount - 1);
        log.info('Recovery successful');
      } else {
        throw new Error(`Recovery failed: ${validation.issues.join(', ')}`);
      }
    } catch (error) {
      this.handleError(error, 'recovery');
    }
  }
  
  /**
   * Enable fallback mode - show PIXI canvas normally
   */
  enableFallbackMode() {
    log.warn('Enabling fallback mode - PIXI canvas will be shown normally');
    
    try {
      // Show PIXI canvas normally
      const pixiCanvas = canvas.app?.view;
      if (pixiCanvas) {
        pixiCanvas.style.opacity = '1';
        pixiCanvas.style.pointerEvents = 'auto';
        pixiCanvas.style.zIndex = '10';
      }
      
      // Hide Three.js canvas
      const threeCanvas = document.getElementById('map-shine-canvas');
      if (threeCanvas) {
        threeCanvas.style.opacity = '0';
        threeCanvas.style.pointerEvents = 'none';
      }
      
      // Restore all PIXI layers
      this.restoreAllLayers();
      
      ui.notifications?.warn('Map Shine: Running in compatibility mode due to integration errors');
      
    } catch (error) {
      log.error('Failed to enable fallback mode:', error);
    }
  }
  
  /**
   * Restore all PIXI layers to visible state
   * @private
   */
  restoreAllLayers() {
    const layers = [
      'background', 'grid', 'primary', 'tokens', 'tiles', 'lighting', 
      'sounds', 'templates', 'drawings', 'notes', 'walls',
      'weather', 'environment', 'regions', 'controls', 'fog', 'visibility'
    ];
    
    for (const name of layers) {
      const layer = canvas[name];
      if (layer) layer.visible = true;
    }
    
    // Restore PIXI renderer background to opaque
    if (canvas.app?.renderer?.background) {
      canvas.app.renderer.background.alpha = 1;
    }
    
    // Restore token alphas (they were set to ~0 for Three.js rendering)
    if (canvas.tokens?.placeables) {
      for (const token of canvas.tokens.placeables) {
        if (token.mesh) token.mesh.alpha = 1;
        if (token.icon) token.icon.alpha = 1;
        if (token.border) token.border.alpha = 1;
      }
    }
    
    // Restore visibility layer filter if it was disabled
    if (canvas.visibility?.filter) {
      canvas.visibility.filter.enabled = true;
    }
  }
  
  /**
   * Disable the integration system
   */
  disable() {
    log.info('Disabling controls integration');
    
    this.unregisterHooks();
    this.restoreAllLayers();
    
    // Reset PIXI canvas
    const pixiCanvas = canvas.app?.view;
    if (pixiCanvas) {
      pixiCanvas.style.opacity = '1';
      pixiCanvas.style.pointerEvents = 'auto';
      pixiCanvas.style.zIndex = '';
    }
    
    this._initialized = false;
    this.transition(IntegrationState.DISABLED, 'Manually disabled');
  }
  
  /**
   * Clean up resources
   */
  destroy() {
    this.disable();

    this._unwrapEnvironmentInitialize();
    
    this.layerVisibility = null;
    this.inputRouter = null;
    this.cameraSync = null;
    this.sceneComposer = null;
    
    log.info('Controls integration destroyed');
  }
  
  /**
   * Get the current integration state
   * @returns {IntegrationState}
   */
  getState() {
    return this.state;
  }
  
  /**
   * Get a health report
   * @returns {object}
   */
  getHealthReport() {
    return {
      state: this.state,
      errorCount: this.errorCount,
      lastError: this.lastError,
      cameraSyncValid: this.cameraSync?.validateSync()?.valid ?? false,
      inputMode: this.inputRouter?.currentMode ?? 'unknown',
      initialized: this._initialized
    };
  }
}
