/**
 * @fileoverview Controls Integration - Main orchestrator for Foundry Scene Controls
 * Implements the PIXI Overlay Strategy for reliable native Foundry tool support
 * @module foundry/controls-integration
 */

import { createLogger } from '../core/log.js';
import { LayerVisibilityManager } from './layer-visibility-manager.js';
import { InputRouter } from './input-router.js';
import { CameraSync } from './camera-sync.js';
import { readWallHeightFlags } from './levels-scene-flags.js';
import { getPerspectiveElevation } from './elevation-context.js';

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

    /** @type {number} */
    this._interactionSnapshotSeq = 0;
  }

  _getActiveLayerMeta() {
    const layer = canvas?.activeLayer;
    const optionsName = String(layer?.options?.name || '').toLowerCase();
    const name = String(layer?.name || '').toLowerCase();
    const ctor = String(layer?.constructor?.name || '').toLowerCase();
    const sceneControlName = String(ui?.controls?.control?.name || ui?.controls?.activeControl || '').toLowerCase();
    const sceneControlLayer = String(ui?.controls?.control?.layer || '').toLowerCase();
    return { optionsName, name, ctor, sceneControlName, sceneControlLayer };
  }

  _isLightingContextActive() {
    if (canvas?.lighting?.active) return true;
    const { optionsName, name, ctor, sceneControlName, sceneControlLayer } = this._getActiveLayerMeta();
    return optionsName === 'lighting'
      || optionsName === 'light'
      || name === 'lighting'
      || name === 'light'
      || ctor === 'lightinglayer'
      || sceneControlName === 'lighting'
      || sceneControlName === 'light'
      || sceneControlLayer === 'lighting'
      || sceneControlLayer === 'light';
  }

  _isWallsContextActive() {
    if (canvas?.walls?.active) return true;
    const { optionsName, name, ctor, sceneControlName, sceneControlLayer } = this._getActiveLayerMeta();
    return optionsName === 'walls'
      || optionsName === 'wall'
      || name === 'walls'
      || name === 'wall'
      || ctor === 'wallslayer'
      || ctor === 'walllayer'
      || sceneControlName === 'walls'
      || sceneControlName === 'wall'
      || sceneControlLayer === 'walls'
      || sceneControlLayer === 'wall';
  }

  _isSoundsContextActive() {
    if (canvas?.sounds?.active) return true;
    const { optionsName, name, ctor, sceneControlName, sceneControlLayer } = this._getActiveLayerMeta();
    return optionsName === 'sounds'
      || optionsName === 'sound'
      || name === 'sounds'
      || name === 'sound'
      || ctor === 'soundslayer'
      || sceneControlName === 'sounds'
      || sceneControlName === 'sound'
      || sceneControlLayer === 'sounds'
      || sceneControlLayer === 'sound';
  }

  _isTilesContextActive() {
    if (canvas?.tiles?.active) return true;
    const { optionsName, name, ctor, sceneControlName, sceneControlLayer } = this._getActiveLayerMeta();
    return optionsName === 'tiles'
      || name === 'tiles'
      || ctor === 'tileslayer'
      || sceneControlName === 'tiles'
      || sceneControlLayer === 'tiles';
  }

  _isDrawingsContextActive() {
    if (canvas?.drawings?.active) return true;
    const { optionsName, name, ctor, sceneControlName, sceneControlLayer } = this._getActiveLayerMeta();
    return optionsName === 'drawings'
      || optionsName === 'drawing'
      || name === 'drawings'
      || name === 'drawing'
      || ctor === 'drawingslayer'
      || sceneControlName === 'drawings'
      || sceneControlName === 'drawing'
      || sceneControlLayer === 'drawings'
      || sceneControlLayer === 'drawing';
  }

  _isPixiEditorOverlayNeeded() {
    // Walls, lighting, and tokens are fully Three.js-native now.
    // Only return true for layers we haven't replaced yet (drawings, regions,
    // sounds, notes, templates). The InputRouter handles this via determineMode().
    return false;
  }

  _applyPixiEditorOverlayGate() {
    try {
      const needsOverlay = this._isPixiEditorOverlayNeeded();
      const activeControl = String(ui?.controls?.control?.name || ui?.controls?.activeControl || '').toLowerCase();
      const activeTool = String(ui?.controls?.tool?.name || ui?.controls?.activeTool || '').toLowerCase();
      const pixiCanvas = canvas?.app?.view;
      const board = document.getElementById('board');

      if (window.MapShine) {
        window.MapShine.__forcePixiEditorOverlay = !!needsOverlay;
      }

      if (!pixiCanvas) return;

      const isV2Active = !!window.MapShine?.__v2Active;
      const pixiVisualOpacity = isV2Active ? '0' : '1';

      if (needsOverlay) {
        pixiCanvas.style.display = '';
        pixiCanvas.style.visibility = 'visible';
        pixiCanvas.style.opacity = pixiVisualOpacity;
        pixiCanvas.style.zIndex = '10';
        if (board && board.tagName === 'CANVAS') {
          board.style.display = '';
          board.style.visibility = 'visible';
          board.style.opacity = pixiVisualOpacity;
          board.style.zIndex = '10';
        }
      }

      log.info(
        `EditorOverlayGate: needs=${needsOverlay} control=${activeControl || 'none'} tool=${activeTool || 'none'} ` +
        `wallsActive=${!!canvas?.walls?.active} lightingActive=${!!canvas?.lighting?.active} ` +
        `pixiDisplay=${pixiCanvas.style.display || '(default)'} boardDisplay=${board?.style?.display || '(default)'} ` +
        `pixiPE=${pixiCanvas.style.pointerEvents || '(default)'} boardPE=${board?.style?.pointerEvents || '(default)'}`
      );
    } catch (_) {
      // Best effort gate
    }
  }

  /**
   * Re-apply Foundry-native door icon visibility rules.
   *
   * Foundry computes icon visibility from DoorControl.isVisible (vision/FOV aware)
   * and toggles the controls.doors container with active token workflows.
   * In Three takeover mode we must re-assert this state because layer/input
   * transitions can leave the doors container hidden.
   * @private
   */
  _refreshFoundryDoorControlVisibility() {
    try {
      // Ensure door controls exist for door walls (Foundry normally does this in
      // ControlsLayer.drawDoors). In takeover mode this can occasionally drift.
      for (const wall of canvas?.walls?.placeables || []) {
        try {
          if (!wall?.isDoor) continue;
          if (!wall.doorControl && typeof wall.createDoorControl === 'function') {
            wall.createDoorControl();
          }

          // Even if Foundry re-shows the ControlsLayer.doors container later,
          // explicitly disable each DoorControl instance so its icon can never
          // render (commonly appears at 0,0 when controls transforms drift).
          if (wall.doorControl) {
            wall.doorControl.visible = false;
            wall.doorControl.renderable = false;
            if (wall.doorControl.icon) {
              wall.doorControl.icon.visible = false;
              wall.doorControl.icon.renderable = false;
            }
          }
        } catch (_) {
          // Ignore per-wall control creation failures
        }
      }

      const controlsDoors = canvas?.controls?.doors;
      if (!controlsDoors) return;

      // IMPORTANT: Map Shine renders its own Three-based door icons/controls.
      // Foundry's native DoorControl icons must NOT be rendered, otherwise we
      // get a second icon set (commonly stuck at screen origin if the PIXI
      // controls layer transform isn't being updated).
      //
      // We still keep DoorControl instances created so other parts of Map Shine
      // can query `doorControl.isVisible` to match Foundry's visibility rules.
      controlsDoors.visible = false;
      controlsDoors.renderable = false;

      // Also force-hide any existing door controls as defense-in-depth.
      for (const door of controlsDoors.children || []) {
        try {
          if (!door) continue;
          door.visible = false;
          door.renderable = false;
        } catch (_) {
          // Ignore per-door visibility failures
        }
      }

      // Final defense: if Foundry has re-populated the doors container with
      // new children after our per-door pass, clear them entirely. DoorControl
      // instances remain attached to walls, so visibility checks still work.
      try {
        if (Array.isArray(controlsDoors.children) && controlsDoors.children.length) {
          controlsDoors.removeChildren();
        }
      } catch (_) {
      }
    } catch (_) {
      // Best effort only
    }
  }

  _reassertInputOwnership(reason = '') {
    try {
      if (!this.inputRouter || this.state !== IntegrationState.ACTIVE) return;
      const mode = this.inputRouter.determineMode();
      this.inputRouter.setMode(mode, `controlsIntegration.reassert${reason ? `:${reason}` : ''}`);
    } catch (_) {
      // Best-effort ownership reassertion
    }
  }

  _logInteractionSnapshot(trigger, extra = undefined) {
    try {
      const msUpper = window.MapShine || null;
      const msLower = window.mapShine || null;
      const routerUpper = msUpper?.inputRouter || null;
      const routerLower = msLower?.inputRouter || null;
      const routerCi = this.inputRouter || null;
      const resolvedRouter = routerUpper || routerLower || routerCi || null;

      const pixiCanvas = canvas?.app?.view;
      const board = document.getElementById('board');
      const threeCanvas = document.getElementById('map-shine-canvas');
      const activeControl = String(ui?.controls?.control?.name || ui?.controls?.activeControl || '').toLowerCase();
      const activeTool = String(ui?.controls?.tool?.name || ui?.controls?.activeTool || '').toLowerCase();

      this._interactionSnapshotSeq += 1;
      log.warn(`[InputSnapshot #${this._interactionSnapshotSeq}] ${trigger}`, {
        mode: resolvedRouter?.currentMode,
        shouldThree: resolvedRouter?.shouldThreeReceiveInput?.(),
        shouldPixi: resolvedRouter?.shouldPixiReceiveInput?.(),
        control: activeControl,
        tool: activeTool,
        wallsActive: !!canvas?.walls?.active,
        lightingActive: !!canvas?.lighting?.active,
        forceOverlay: !!window.MapShine?.__forcePixiEditorOverlay,
        pixiPE: pixiCanvas?.style?.pointerEvents,
        boardPE: board?.style?.pointerEvents,
        threePE: threeCanvas?.style?.pointerEvents,
        hasRouterUpper: !!routerUpper,
        hasRouterLower: !!routerLower,
        hasRouterCi: !!routerCi,
        sameUpperLower: !!routerUpper && !!routerLower ? routerUpper === routerLower : null,
        sameUpperCi: !!routerUpper && !!routerCi ? routerUpper === routerCi : null,
        sameLowerCi: !!routerLower && !!routerCi ? routerLower === routerCi : null,
        extra
      });
    } catch (_) {
      // Best-effort diagnostics
    }
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

      // Lighting interactions are Three-driven in gameplay. Keep Three light
      // gizmos available whenever lighting context is active.
      const showLighting = this._isLightingContextActive() && !isMapMakerMode;

      const lightIconManager = window.MapShine?.lightIconManager;
      if (lightIconManager?.setVisibility) {
        lightIconManager.setVisibility(showLighting);
      }

      const enhancedLightIconManager = window.MapShine?.enhancedLightIconManager;
      if (enhancedLightIconManager?.setVisibility) {
        enhancedLightIconManager.setVisibility(showLighting);
      }

      const soundIconManager = window.MapShine?.soundIconManager;
      if (soundIconManager?.setVisibility) {
        const showSounds = this._isSoundsContextActive() && !isMapMakerMode;
        soundIconManager.setVisibility(showSounds);
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

    // Foundry can temporarily report canvas.ready=false during early boot or
    // immediately after certain scene updates (grid/style changes). Treat this
    // as a transient state and retry shortly instead of entering ERROR/FALLBACK.
    try {
      if (!canvas?.ready || !canvas?.stage || !canvas?.app?.renderer || !canvas?.app?.view) {
        // Avoid spamming retries.
        if (!this._pendingInitRetry) {
          this._pendingInitRetry = true;
          setTimeout(() => {
            try {
              this._pendingInitRetry = false;
              // Only retry if we still aren't initialized.
              if (!this._initialized) this.initialize();
            } catch (_) {
              this._pendingInitRetry = false;
            }
          }, 250);
        }
        log.warn('ControlsIntegration.initialize: canvas not ready yet; deferring init');
        return false;
      }
    } catch (_) {
      // If anything goes wrong probing canvas state, fall through to normal init.
    }
    
    this.transition(IntegrationState.INITIALIZING, 'Starting initialization');
    
    try {
      // Validate canvas state
      const validation = this.validateCanvasState();
      if (!validation.valid) {
        // Canvas can become partially invalid transiently; retry rather than
        // entering fallback which hides Three.
        if (validation.issues?.includes('Canvas not ready') || validation.issues?.includes('Stage not initialized')) {
          if (!this._pendingInitRetry) {
            this._pendingInitRetry = true;
            setTimeout(() => {
              try {
                this._pendingInitRetry = false;
                if (!this._initialized) this.initialize();
              } catch (_) {
                this._pendingInitRetry = false;
              }
            }, 250);
          }
          log.warn(`ControlsIntegration.initialize: transient invalid canvas state (${validation.issues.join(', ')}); retrying`);
          return false;
        }
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
      this.layerVisibility?.update();
      this.inputRouter.autoUpdate();
      this._updateTilesVisualState();
      this._updatePixiEditorVisualState();

      // Keep global diagnostics/runtime lookups in sync even when ControlsIntegration
      // initializes after initial manager exposure.
      const globalMs = window.MapShine || window.mapShine;
      if (globalMs) {
        globalMs.inputRouter = this.inputRouter;
        globalMs.layerVisibility = this.layerVisibility;
        globalMs.controlsIntegration = this;
      }

      this._logInteractionSnapshot('initialize.postAutoUpdate');
      setTimeout(() => this._reassertInputOwnership('initialize'), 25);

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
    this._applyPixiEditorOverlayGate();
    
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
    const visuallyReplacedLayers = ['background', 'grid', 'primary', 'tiles', 'weather', 'environment'];
    
    for (const name of visuallyReplacedLayers) {
      const layer = canvas[name];
      if (layer) {
        layer.visible = false;
        log.debug(`Hidden visual layer: ${name}`);
      }
    }

    // Also hide native Fog of War visual layers in Three-driven rendering mode.
    // We keep Foundry vision/exploration computation active, but suppress the
    // PIXI fog draw pass so it doesn't conflict with Map Shine rendering.
    
    // canvas.fog contains the exploration sprite
    if (canvas.fog) {
      try {
        canvas.fog.visible = false;
        log.debug('Hidden native fog layer');
      } catch (_) {
        // Ignore - fog layer structure may vary by Foundry version
      }
    }
    
    // canvas.visibility is the layer that applies the actual fog filter.
    // Suppress its visual output in Three-driven mode to avoid duplicate overlays.
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

    // Keep Foundry's door-control container active in gameplay and refresh each
    // door icon visibility using Foundry's own visibility rules.
    this._refreshFoundryDoorControlVisibility();
  }

  /**
   * PIXI-owned tile editing visual sync.
   *
   * This method intentionally owns only:
   * - pointer routing (PIXI canvas receives events, Three canvas is render-only)
   * - visibility/transparency of PIXI tile visuals so Three.js visuals show through
   *
   * It must NOT own tile hit-testing semantics (foreground/background eligibility).
   * Foundry tile state (`eventMode`, controllableObjects, tool filtering) remains
   * the sole authority for manipulation behavior.
   * @private
   */
  _updateTilesVisualState() {
    if (!canvas?.ready || !canvas.tiles) return;

    const isTilesActive = this._isTilesContextActive();
    if (!isTilesActive) {
      // When tiles layer is not active, hide it. Foundry's layer deactivation
      // already sets eventMode='passive' and interactiveChildren=false, so we
      // don't need to force those.
      canvas.tiles.visible = false;
      return;
    }

    // Re-assert Three.js tile visibility whenever the tile layer becomes active.
    // An earlier gameplay-mode suppression pass (mode-manager, canvas-replacement)
    // may have called tileManager.setVisibility(false), leaving _globalVisible=false.
    // With _globalVisible=false, newly created sprites stay permanently hidden after
    // texture load because updateSpriteVisibility returns early. Re-assert true here
    // so create/update/refresh hooks can show sprites correctly.
    // Guard: skip the full-sprite iteration if _globalVisible is already true to
    // avoid O(n_tiles) work on every refreshTile (~60fps during drag).
    const tileManager = window.MapShine?.tileManager;
    if (tileManager?.setVisibility && tileManager._globalVisible !== true) {
      try { tileManager.setVisibility(true); } catch (_) {}
    }

    // Foundry v12 tile interaction depends on primary group visibility.
    if (canvas.primary) {
      canvas.primary.visible = true;
    }

    // Keep the tiles layer visible and interactive so Foundry's native
    // tile workflows (select, drag, copy/paste, foreground toggle) work.
    canvas.tiles.visible = true;
    canvas.tiles.renderable = true;
    canvas.tiles.interactiveChildren = true;

    // PIXI owns tile interaction — ensure PIXI canvas receives pointer events
    // and Three.js canvas is render-only during tile editing.
    const pixiCanvas = canvas?.app?.view;
    if (pixiCanvas) {
      pixiCanvas.style.pointerEvents = 'auto';
      pixiCanvas.style.display = '';
      pixiCanvas.style.visibility = 'visible';
    }
    const board = document.getElementById('board');
    if (board && board.tagName === 'CANVAS') {
      board.style.pointerEvents = 'auto';
      board.style.display = '';
      board.style.visibility = 'visible';
    }
    const threeCanvas = document.getElementById('map-shine-canvas');
    if (threeCanvas) {
      threeCanvas.style.pointerEvents = 'none';
    }

    // Make PIXI visuals nearly invisible so Three.js tile visuals show through.
    // Do not change eventMode here; Foundry owns eligibility semantics.
    const VISUAL_ALPHA = 0.01;
    for (const tile of canvas.tiles.placeables || []) {
      try {
        tile.visible = true;
        tile.renderable = true;
        tile.alpha = VISUAL_ALPHA;

        if (tile.mesh) {
          tile.mesh.alpha = VISUAL_ALPHA;
          tile.mesh.visible = true;
          tile.mesh.renderable = true;
        }

        // Keep selection affordances readable while parent alpha is very low.
        if (tile.frame) {
          tile.frame.alpha = 1 / VISUAL_ALPHA;
        }
      } catch (_) {
      }
    }

    this._resyncFoundryTileInteractionState();
  }

  /**
   * Force a Three.js tile rerender from Foundry tile hooks.
   *
   * This is a fail-safe path in case TileManager hook wiring becomes stale during
   * scene/layer transitions. It intentionally mirrors the basic lifecycle:
   * create -> update -> refresh.
   * @param {Tile|TileDocument|object} tileOrDoc
   * @param {object|null} [changes]
   * @private
   */
  _forceThreeTileRerender(tileOrDoc, changes = null) {
    const tileManager = window.MapShine?.tileManager;
    if (!tileManager) return;

    const tileDoc = tileOrDoc?.document ?? tileOrDoc;
    if (!tileDoc?.id) return;

    try {
      // If gameplay/layer arbitration left tiles globally hidden, no per-tile
      // refresh path can make the sprite visible. Re-assert visibility first.
      if (tileManager.setVisibility && tileManager._globalVisible !== true) {
        tileManager.setVisibility(true);
      }

      if (changes && typeof tileManager.updateTileSprite === 'function') {
        tileManager.updateTileSprite(tileDoc, changes);
        return;
      }

      const hasSprite = !!tileManager.tileSprites?.has?.(tileDoc.id);
      if (hasSprite && typeof tileManager.refreshTileSprite === 'function') {
        tileManager.refreshTileSprite(tileDoc);
        return;
      }

      if (typeof tileManager.createTileSprite === 'function') {
        tileManager.createTileSprite(tileDoc);
      }
    } catch (_) {
    }
  }

  /**
   * Re-run Foundry tile interactivity state and emulate pointer move so cursor
   * eligibility updates immediately after layer/tool transitions.
   * @private
   */
  _resyncFoundryTileInteractionState() {
    if (!canvas?.ready || !canvas?.tiles || !this._isTilesContextActive()) return;

    try {
      for (const tile of canvas.tiles.placeables || []) {
        try {
          // Delegate eligibility entirely to Foundry's _refreshState.
          // Foundry uses: overhead = elevation >= parent.foregroundElevation
          //               foreground = layer.active && tools.foreground.active
          //               eventMode = overhead === foreground ? 'static' : 'none'
          // Our previous override used _source.overhead first, which diverges from
          // Foundry's elevation-only model and caused incorrect 'static' on overhead
          // tiles in background mode.
          if (typeof tile._refreshState === 'function') {
            tile._refreshState();
          } else if (typeof tile.refresh === 'function') {
            tile.refresh();
          }

          // Release any controlled tile that Foundry just marked ineligible.
          if (tile.eventMode === 'none' && tile.controlled && typeof tile.release === 'function') {
            tile.release();
          }
        } catch (_) {
        }
      }

      const emulateMove = canvas?.mouseInteractionManager?.constructor?.emulateMoveEvent
        || window?.MouseInteractionManager?.emulateMoveEvent
        || null;
      if (typeof emulateMove === 'function') emulateMove();
    } catch (_) {
    }
  }

  /**
   * Ensure Foundry's active PIXI UI layer is interactable when its tools are selected.
   * This mirrors the tiles re-activation guard and avoids stale activeLayer state 
   * that prevents native workflows.
   * @private
   */
  _updatePixiEditorVisualState() {
    if (!canvas?.ready) return;
    
    // Check if any PIXI editor context is active
    const isActive = 
      this._isDrawingsContextActive() ||
      this._isLightingContextActive() ||
      this._isSoundsContextActive() ||
      this._isNotesContextActive() ||
      this._isTemplatesContextActive() ||
      this._isRegionsContextActive();

    if (!isActive) return;

    try {
      // Ensure the currently selected layer is active
      const controlName = ui?.controls?.control?.name;
      let targetLayer = null;
      switch (controlName) {
        case 'drawings': targetLayer = canvas.drawings; break;
        case 'lighting': targetLayer = canvas.lighting; break;
        case 'sounds': targetLayer = canvas.sounds; break;
        case 'notes': targetLayer = canvas.notes; break;
        case 'templates': targetLayer = canvas.templates; break;
        case 'regions': targetLayer = canvas.regions; break;
      }
      
      if (targetLayer && canvas.activeLayer !== targetLayer && typeof targetLayer.activate === 'function') {
        targetLayer.activate();
      }
      
      if (targetLayer) {
        targetLayer.visible = true;
        targetLayer.renderable = true;
        targetLayer.interactiveChildren = true;
      }
    } catch (_) {
      // Best effort only
    }

    // Keep ownership consistent for native UI layer interactions.
    const pixiCanvas = canvas?.app?.view;
    if (pixiCanvas) {
      pixiCanvas.style.pointerEvents = 'auto';
      pixiCanvas.style.display = '';
      pixiCanvas.style.visibility = 'visible';
      pixiCanvas.style.opacity = '1';
    }

    const board = document.getElementById('board');
    if (board && board.tagName === 'CANVAS') {
      board.style.pointerEvents = 'auto';
      board.style.display = '';
      board.style.visibility = 'visible';
      board.style.opacity = '1';
    }

    const threeCanvas = document.getElementById('map-shine-canvas');
    if (threeCanvas) {
      threeCanvas.style.pointerEvents = 'none';
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

      // Door controls: only show if the wall is on the current floor.
      // This prevents players from seeing/clicking doors on other floors.
      const onCurrentFloor = this._isWallOnCurrentFloor(wall);
      if (wall.doorControl) {
        wall.doorControl.visible = onCurrentFloor;
        wall.doorControl.alpha = onCurrentFloor ? 1 : 0;
      }

      wall.visible = true;
      wall.interactive = onCurrentFloor;
      wall.interactiveChildren = onCurrentFloor;
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
      // Ensure the wall itself is visible (may have been hidden by floor filter)
      wall.visible = true;
    } catch (_) {
      // Ignore
    }
  }

  /**
   * Hide a PIXI wall completely because it belongs to a different floor.
   * Unlike _makeWallTransparent (which keeps door controls visible for gameplay),
   * this hides everything including door controls to declutter the walls editor.
   * @param {Wall} wall
   * @private
   */
  _hideWallForOtherFloor(wall) {
    if (!wall) return;
    try {
      wall.visible = false;
    } catch (_) {
      // Ignore
    }
  }

  /**
   * Check whether a Foundry PIXI wall placeable is on the current floor.
   * Uses wall-height flags and the current perspective elevation to determine
   * if the wall should be shown when editing.
   *
   * Walls without wall-height flags (full-height walls) are always considered
   * "on" the current floor so they remain visible.
   *
   * @param {Wall} wall - Foundry PIXI wall placeable
   * @returns {boolean} True if the wall is on the current floor
   * @private
   */
  _isWallOnCurrentFloor(wall) {
    try {
      const doc = wall?.document;
      if (!doc) return true;

      const perspective = getPerspectiveElevation();
      const elevation = Number(perspective?.elevation);
      if (!Number.isFinite(elevation)) return true;

      const bounds = readWallHeightFlags(doc);
      let bottom = Number(bounds?.bottom);
      let top = Number(bounds?.top);

      // Walls without finite bounds are full-height — always show them
      if (!Number.isFinite(bottom) && !Number.isFinite(top)) return true;

      if (!Number.isFinite(bottom)) bottom = -Infinity;
      if (!Number.isFinite(top)) top = Infinity;
      if (top < bottom) { const swap = bottom; bottom = top; top = swap; }

      return (bottom <= elevation) && (elevation <= top);
    } catch (_) {
      return true;
    }
  }

  /**
   * Ensure wall visuals are correct for the current active layer.
   * When the walls layer is active, only walls on the current floor are shown;
   * walls on other floors are hidden to keep the editor uncluttered.
   * @private
   */
  _updateWallsVisualState() {
    if (!canvas?.ready || !canvas.walls?.placeables) return;

    const isWallsActive = this._isWallsContextActive();

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
      // In walls edit mode, always show all native wall graphics.
      // Floor filtering here can hide every wall when perspective/flags mismatch,
      // which makes the wall tool appear broken.
      for (const wall of canvas.walls.placeables) {
        this._restoreWallVisuals(wall);
      }
      this._wallsAreTransparent = false;
    } else {
      if (!this._wallsAreTransparent) {
        for (const wall of canvas.walls.placeables) this._makeWallTransparent(wall);
        this._wallsAreTransparent = true;
      }
    }

    // Re-assert Foundry's vision-based door visibility after wall visual updates.
    this._refreshFoundryDoorControlVisibility();
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

      // Re-apply Foundry door visibility after sight refresh updates to ensure
      // icons match the currently controlled token vision.
      this._refreshFoundryDoorControlVisibility();
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

      // Keep Foundry token text overlays hidden so only Three.js labels render.
      if (token.nameplate) {
        token.nameplate.alpha = 0;
        token.nameplate.visible = false;
        token.nameplate.renderable = false;
      }
      if (token.tooltip) {
        token.tooltip.alpha = 0;
        token.tooltip.visible = false;
        token.tooltip.renderable = false;
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
          this._updateTilesVisualState();
          this._updatePixiEditorVisualState();
          this._updateThreeGizmoVisibility();
          this._applyPixiEditorOverlayGate();
          this._logInteractionSnapshot('activateCanvasLayer.postUpdate', {
            layerCtor: layer?.constructor?.name || null
          });
          setTimeout(() => this._reassertInputOwnership('activateCanvasLayer'), 25);
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
          this._updateTilesVisualState();
          this._updatePixiEditorVisualState();
          this._updateThreeGizmoVisibility();
          this._applyPixiEditorOverlayGate();
          this._logInteractionSnapshot('renderSceneControls.postUpdate');
          setTimeout(() => this._reassertInputOwnership('renderSceneControls'), 25);
        } catch (error) {
          this.handleError(error, 'renderSceneControls');
        }
      }, 0);
    });
    this._hookIds.push({ name: 'renderSceneControls', id: controlsHookId });

    const modeChangeHookId = Hooks.on('mapShineInputModeChange', (payload) => {
      if (this.state !== IntegrationState.ACTIVE) return;
      this._logInteractionSnapshot('mapShineInputModeChange', {
        mode: payload?.mode,
        reason: payload?.reason,
        layer: payload?.layer,
        tool: payload?.tool
      });

      setTimeout(() => {
        try {
          this._resyncFoundryTileInteractionState();
        } catch (_) {
        }
      }, 0);
    });
    this._hookIds.push({ name: 'mapShineInputModeChange', id: modeChangeHookId });

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
            this._refreshFoundryDoorControlVisibility();
            this._updateWallsVisualState();
          } catch (_) {
          }
        }, 0);
      } catch (error) {
        // Silently ignore - token might not be ready yet
      }
    });
    this._hookIds.push({ name: 'refreshToken', id: refreshTokenHookId });

    // Foundry hover workflows can re-show native token nameplate/tooltip. Re-hide
    // after hover state changes to keep Three.js as the sole label renderer.
    const hoverTokenHookId = Hooks.on('hoverToken', (token) => {
      if (this.state !== IntegrationState.ACTIVE) return;
      setTimeout(() => {
        try {
          this.makeTokenTransparent(token);
        } catch (_) {
        }
      }, 0);
    });
    this._hookIds.push({ name: 'hoverToken', id: hoverTokenHookId });

    // When a token is controlled/released, Foundry may adjust control icon visibility.
    // Re-assert that the walls layer stays visible so door controls/icons remain visible.
    // Also re-apply floor filtering since the perspective elevation may change.
    const controlTokenHookId = Hooks.on('controlToken', () => {
      if (this.state !== IntegrationState.ACTIVE) return;
      setTimeout(() => {
        try {
          // Token interactions are Three-owned. Foundry can transiently refresh
          // control/layer state during selection, so force an ownership
          // re-evaluation before applying per-layer visual state.
          this.inputRouter?.autoUpdate?.();

          // Keep walls layer visible for door controls
          if (canvas?.walls) {
            canvas.walls.visible = true;
            canvas.walls.interactiveChildren = true;
          }
          // Force re-apply transparency so door control visibility updates
          // for the newly controlled token's elevation.
          if (this._wallsAreTransparent && canvas?.walls?.placeables) {
            for (const wall of canvas.walls.placeables) this._makeWallTransparent(wall);
          }
          this._refreshFoundryDoorControlVisibility();
          this._updateWallsVisualState();
          this._updateTilesVisualState();
          this._reassertInputOwnership('controlToken');
        } catch (_) {
        }
      }, 0);
    });
    this._hookIds.push({ name: 'controlToken', id: controlTokenHookId });

    // Keep door icons in sync whenever Foundry recomputes visibility/FOV.
    const sightRefreshHookId = Hooks.on('sightRefresh', () => {
      if (this.state !== IntegrationState.ACTIVE) return;
      try {
        this._refreshFoundryDoorControlVisibility();
      } catch (_) {
      }
    });
    this._hookIds.push({ name: 'sightRefresh', id: sightRefreshHookId });

    // Wall refresh - reapply correct visual state based on layer and floor
    const refreshWallHookId = Hooks.on('refreshWall', (wall) => {
      if (this.state !== IntegrationState.ACTIVE) return;
      try {
        if (this._wallsAreTransparent) {
          this._makeWallTransparent(wall);
        } else {
          // Walls layer is active — apply floor filter to this refreshed wall
          if (this._isWallOnCurrentFloor(wall)) {
            this._restoreWallVisuals(wall);
          } else {
            this._hideWallForOtherFloor(wall);
          }
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
          } else {
            // Walls layer is active — apply floor filter to this new wall
            if (this._isWallOnCurrentFloor(wall)) {
              this._restoreWallVisuals(wall);
            } else {
              this._hideWallForOtherFloor(wall);
            }
          }
        } catch (_) {
        }
      }, 50);
    });
    this._hookIds.push({ name: 'createWall', id: createWallHookId });

    // Floor change — re-filter wall visibility so switching floors immediately
    // updates which walls are shown in the walls editor and which door controls
    // are visible during gameplay.
    const levelContextHookId = Hooks.on('mapShineLevelContextChanged', () => {
      if (this.state !== IntegrationState.ACTIVE) return;
      setTimeout(() => {
        try {
          // Force re-apply even when walls are already transparent so door
          // control visibility updates for the new floor.
          if (this._wallsAreTransparent && canvas?.walls?.placeables) {
            for (const wall of canvas.walls.placeables) this._makeWallTransparent(wall);
          }
          this._updateWallsVisualState();
          this._updateTilesVisualState();
        } catch (_) {
        }
      }, 0);
    });
    this._hookIds.push({ name: 'mapShineLevelContextChanged', id: levelContextHookId });

    const refreshTileHookId = Hooks.on('refreshTile', (tile) => {
      if (this.state !== IntegrationState.ACTIVE) return;
      try {
        this._updateTilesVisualState();
        this._resyncFoundryTileInteractionState();

        // During drag/resize, Foundry updates the placeable's live transform
        // before document commit. Build a lightweight proxy so Three.js tracks
        // the live position immediately instead of waiting for updateTile.
        const baseDoc = tile?.document;
        if (baseDoc) {
          const liveDoc = new Proxy(baseDoc, {
            get(target, prop, receiver) {
              if (prop === 'x') return Number.isFinite(Number(tile?.x)) ? Number(tile.x) : target.x;
              if (prop === 'y') return Number.isFinite(Number(tile?.y)) ? Number(tile.y) : target.y;
              if (prop === 'rotation') return Number.isFinite(Number(tile?.rotation)) ? Number(tile.rotation) : target.rotation;
              if (prop === 'width') return Number.isFinite(Number(target?.width)) ? Number(target.width) : (Number(tile?.w) || 0);
              if (prop === 'height') return Number.isFinite(Number(target?.height)) ? Number(target.height) : (Number(tile?.h) || 0);
              return Reflect.get(target, prop, receiver);
            }
          });
          this._forceThreeTileRerender(liveDoc);
        }
      } catch (_) {
      }
    });
    this._hookIds.push({ name: 'refreshTile', id: refreshTileHookId });

    const createTileHookId = Hooks.on('createTile', (tileDoc) => {
      if (this.state !== IntegrationState.ACTIVE) return;
      setTimeout(() => {
        try {
          this._updateTilesVisualState();
          this._resyncFoundryTileInteractionState();
          this._forceThreeTileRerender(tileDoc);
        } catch (_) {
        }
      }, 0);
    });
    this._hookIds.push({ name: 'createTile', id: createTileHookId });

    const updateTileHookId = Hooks.on('updateTile', (tileDoc, changes) => {
      if (this.state !== IntegrationState.ACTIVE) return;
      try {
        const keys = changes && typeof changes === 'object' ? Object.keys(changes) : [];
        const geometryOrVisualChanged = keys.length === 0 || keys.some((k) => (
          k === 'x' || k === 'y' || k === 'width' || k === 'height' ||
          k === 'rotation' || k === 'elevation' || k === 'z' ||
          k === 'hidden' || k === 'alpha' || k === 'texture' || k === 'flags'
        ));
        if (!geometryOrVisualChanged) return;

        this._forceThreeTileRerender(tileDoc, changes || {});
      } catch (_) {
      }
    });
    this._hookIds.push({ name: 'updateTile', id: updateTileHookId });

    // Hard eligibility guard: if a tile somehow becomes controlled while it
    // does not match the current foreground/background mode, release it
    // immediately to prevent move/drag in the wrong mode.
    // Use Foundry's own _refreshState to determine eligibility (elevation-based),
    // not our _source.overhead fallback which diverges from Foundry's logic.
    const controlTileHookId = Hooks.on('controlTile', (tile, controlled) => {
      if (this.state !== IntegrationState.ACTIVE) return;
      if (!controlled || !this._isTilesContextActive()) return;

      try {
        // Let Foundry compute the correct eventMode via its own _refreshState.
        if (typeof tile._refreshState === 'function') tile._refreshState();
        // If Foundry just set this tile to 'none', it's not eligible — release it.
        if (tile.eventMode === 'none' && typeof tile.release === 'function') {
          setTimeout(() => {
            try { tile.release(); } catch (_) {}
          }, 0);
        }
      } catch (_) {
      }
    });
    this._hookIds.push({ name: 'controlTile', id: controlTileHookId });

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
   * Strict overhead tile mode gate.
   *
   * We intentionally tie overhead eligibility to the explicitly active overhead
   * tool names (foreground/overhead/roof), rather than a sticky foreground
   * toggle object state. This matches expected UX that overhead-only selection
   * should happen only while explicitly in overhead mode.
   * @returns {boolean}
   * @private
   */
  _isOverheadTileToolActive() {
    const tools = ui?.controls?.control?.tools;
    if (tools) {
      if (typeof tools === 'object' && !Array.isArray(tools)) {
        if (typeof tools?.foreground?.active === 'boolean') {
          return !!tools.foreground.active;
        }
      }
      if (Array.isArray(tools)) {
        const activeForegroundTool = tools.find((t) => {
          if (!t?.active) return false;
          const name = String(t?.name || '').toLowerCase();
          return name === 'foreground' || name === 'overhead' || name === 'roof';
        });
        if (activeForegroundTool) return true;
      }
    }

    const activeTool = String(ui?.controls?.tool?.name ?? ui?.controls?.activeTool ?? game?.activeTool ?? '').toLowerCase();
    return activeTool === 'foreground' || activeTool === 'overhead' || activeTool === 'roof';
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
        this._updateTilesVisualState();
        this._updatePixiEditorVisualState();
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
        if (token.nameplate) {
          token.nameplate.alpha = 1;
          token.nameplate.visible = true;
          token.nameplate.renderable = true;
        }
        if (token.tooltip) {
          token.tooltip.alpha = 1;
          token.tooltip.visible = true;
          token.tooltip.renderable = true;
        }
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
