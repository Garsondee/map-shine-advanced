/**
 * @fileoverview Controls Integration - Main orchestrator for Foundry Scene Controls
 * Implements the PIXI Overlay Strategy for reliable native Foundry tool support
 * @module foundry/controls-integration
 */

import { createLogger } from '../core/log.js';
import { LayerVisibilityManager } from './layer-visibility-manager.js';
import { InputRouter } from './input-router.js';
import { CameraSync } from './camera-sync.js';
import { UnifiedCameraController } from './unified-camera.js';

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
   * @param {UnifiedCameraController} [options.unifiedCamera] - Unified camera controller
   */
  constructor(options = {}) {
    /** @type {import('../scene/composer.js').SceneComposer|null} */
    this.sceneComposer = options.sceneComposer || null;
    
    /** @type {import('../effects/EffectComposer.js').EffectComposer|null} */
    this.effectComposer = options.effectComposer || null;
    
    /** @type {UnifiedCameraController|null} */
    this.unifiedCamera = options.unifiedCamera || null;
    
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
  }

  /**
   * One-shot camera sync is now handled by UnifiedCameraController.initialize()
   * This method is kept for backwards compatibility but does nothing.
   * @private
   * @deprecated Use UnifiedCameraController instead
   */
  syncThreeFromPixiOnce() {
    // UnifiedCameraController handles initial sync in its initialize() method
    log.debug('syncThreeFromPixiOnce called (no-op, UnifiedCameraController handles sync)');
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
      
      // CameraSync is deprecated - UnifiedCameraController handles all camera sync
      // We keep the reference for backwards compatibility but don't use it
      this.cameraSync = null;
      
      // Register hooks
      this.registerHooks();
      
      // Initial state sync
      this.layerVisibility.update();
      this.inputRouter.autoUpdate();
      
      // Camera sync is now handled by UnifiedCameraController
      // which was initialized before ControlsIntegration in canvas-replacement.js
      if (this.unifiedCamera) {
        log.debug('UnifiedCameraController is handling camera sync');
      } else {
        // Fallback: do a one-shot sync if no unified camera
        this.syncThreeFromPixiOnce();
      }
      
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
    if (canvas.app?.renderer?.background) {
      canvas.app.renderer.background.alpha = 0;
      log.debug('PIXI renderer background alpha set to 0');
    }
    
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
    
    log.debug('PIXI overlay configured: opacity 0, z-index 10 (on top but transparent)');
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

    // Also hide the native Fog of War visual layer. We fully replace fog
    // rendering with our own VisionManager + FogManager + FogEffect chain,
    // but still rely on canvas.fog.exploration for persistence. Turning the
    // layer invisible prevents double-fog artifacts.
    if (canvas.fog) {
      try {
        canvas.fog.visible = false;
        log.debug('Hidden native fog visual layer');
      } catch (_) {
        // Ignore - fog layer structure may vary by Foundry version
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
      
      try {
        log.debug(`Layer activated: ${layer?.constructor?.name || 'unknown'}`);
        this.layerVisibility?.update();
        this.inputRouter?.autoUpdate();
      } catch (error) {
        this.handleError(error, 'activateCanvasLayer');
      }
    });
    this._hookIds.push({ name: 'activateCanvasLayer', id: activateHookId });
    
    // Scene controls render - update input routing after tool changes
    const controlsHookId = Hooks.on('renderSceneControls', () => {
      if (this.state !== IntegrationState.ACTIVE) return;
      
      // Defer to next tick to ensure Foundry has finished updating
      setTimeout(() => {
        try {
          this.inputRouter?.autoUpdate();
        } catch (error) {
          this.handleError(error, 'renderSceneControls');
        }
      }, 0);
    });
    this._hookIds.push({ name: 'renderSceneControls', id: controlsHookId });
    
    // Canvas pan - sync Three.js camera to match PIXI stage
    // NOTE: UnifiedCameraController also listens to canvasPan, but we keep this
    // hook for any additional logic that might be needed
    const panHookId = Hooks.on('canvasPan', (canvas, position) => {
      if (this.state !== IntegrationState.ACTIVE) return;
      
      try {
        // UnifiedCameraController handles the actual sync via its own hook
        // This hook is kept for backwards compatibility and potential future use
        if (!this.unifiedCamera) {
          this.cameraSync?.requestSync('canvasPan');
        }
      } catch (error) {
        this.handleError(error, 'canvasPan');
      }
    });
    this._hookIds.push({ name: 'canvasPan', id: panHookId });
    
    // Sidebar collapse - force camera sync
    const sidebarHookId = Hooks.on('collapseSidebar', () => {
      if (this.state !== IntegrationState.ACTIVE) return;
      
      setTimeout(() => {
        try {
          this.cameraSync?.forceFullSync();
        } catch (error) {
          this.handleError(error, 'collapseSidebar');
        }
      }, 100);
    });
    this._hookIds.push({ name: 'collapseSidebar', id: sidebarHookId });
    
    // Token refresh - make PIXI token transparent (Three.js renders visuals)
    // This ensures newly created or refreshed tokens stay interactive but invisible
    const refreshTokenHookId = Hooks.on('refreshToken', (token) => {
      if (this.state !== IntegrationState.ACTIVE) return;
      
      try {
        // Make token transparent but keep it interactive
        this.makeTokenTransparent(token);
      } catch (error) {
        // Silently ignore - token might not be ready yet
      }
    });
    this._hookIds.push({ name: 'refreshToken', id: refreshTokenHookId });
    
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
      'background', 'grid', 'tokens', 'tiles', 'lighting', 
      'sounds', 'templates', 'drawings', 'notes', 'walls',
      'weather', 'environment', 'regions', 'controls'
    ];
    
    for (const name of layers) {
      const layer = canvas[name];
      if (layer) layer.visible = true;
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
