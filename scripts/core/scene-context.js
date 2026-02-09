/**
 * @fileoverview Centralized dependency container for a single Map Shine scene lifecycle.
 * 
 * Replaces the ~40 module-scope `let` variables in canvas-replacement.js with an
 * explicit, disposable context object. All manager and effect references live here,
 * making the dependency graph visible and teardown atomic.
 * 
 * Usage:
 *   const ctx = new SceneContext();
 *   ctx.renderer = renderer;
 *   ctx.sceneComposer = new SceneComposer();
 *   // ... later ...
 *   ctx.dispose(); // Tears down everything in correct order
 * 
 * @module core/scene-context
 */

import { createLogger } from './log.js';

const log = createLogger('SceneContext');

/**
 * Holds all references for a single Map Shine scene lifecycle.
 * Created when a scene initializes, disposed when it tears down.
 */
export class SceneContext {
  constructor() {
    // --- Renderer & Core ---
    /** @type {THREE.WebGLRenderer|null} */
    this.renderer = null;

    /** @type {import('../scene/composer.js').SceneComposer|null} */
    this.sceneComposer = null;

    /** @type {import('../effects/EffectComposer.js').EffectComposer|null} */
    this.effectComposer = null;

    /** @type {import('../core/render-loop.js').RenderLoop|null} */
    this.renderLoop = null;

    /** @type {HTMLCanvasElement|null} */
    this.threeCanvas = null;

    // --- Camera & Input ---
    /** @type {import('../foundry/camera-follower.js').CameraFollower|null} */
    this.cameraFollower = null;

    /** @type {import('../foundry/pixi-input-bridge.js').PixiInputBridge|null} */
    this.pixiInputBridge = null;

    /** @type {import('../foundry/controls-integration.js').ControlsIntegration|null} */
    this.controlsIntegration = null;

    // --- UI ---
    /** @type {import('../ui/tweakpane-manager.js').TweakpaneManager|null} */
    this.uiManager = null;

    /** @type {import('../ui/control-panel-manager.js').ControlPanelManager|null} */
    this.controlPanel = null;

    /** @type {import('../ui/graphics-settings-manager.js').GraphicsSettingsManager|null} */
    this.graphicsSettings = null;

    /** @type {import('../effects/effect-capabilities-registry.js').EffectCapabilitiesRegistry|null} */
    this.effectCapabilitiesRegistry = null;

    /** @type {import('../ui/enhanced-light-inspector.js').EnhancedLightInspector|null} */
    this.enhancedLightInspector = null;

    /** @type {import('../ui/overlay-ui-manager.js').OverlayUIManager|null} */
    this.overlayUIManager = null;

    /** @type {import('../ui/light-editor-tweakpane.js').LightEditorTweakpane|null} */
    this.lightEditor = null;

    // --- Scene Managers ---
    /** @type {import('../scene/token-manager.js').TokenManager|null} */
    this.tokenManager = null;

    /** @type {import('../scene/tile-manager.js').TileManager|null} */
    this.tileManager = null;

    /** @type {import('../scene/surface-registry.js').SurfaceRegistry|null} */
    this.surfaceRegistry = null;

    /** @type {import('../scene/wall-manager.js').WallManager|null} */
    this.wallManager = null;

    /** @type {import('../scene/DoorMeshManager.js').DoorMeshManager|null} */
    this.doorMeshManager = null;

    /** @type {import('../scene/drawing-manager.js').DrawingManager|null} */
    this.drawingManager = null;

    /** @type {import('../scene/note-manager.js').NoteManager|null} */
    this.noteManager = null;

    /** @type {import('../scene/template-manager.js').TemplateManager|null} */
    this.templateManager = null;

    /** @type {import('../scene/light-icon-manager.js').LightIconManager|null} */
    this.lightIconManager = null;

    /** @type {import('../scene/enhanced-light-icon-manager.js').EnhancedLightIconManager|null} */
    this.enhancedLightIconManager = null;

    /** @type {import('../scene/interaction-manager.js').InteractionManager|null} */
    this.interactionManager = null;

    /** @type {import('../scene/grid-renderer.js').GridRenderer|null} */
    this.gridRenderer = null;

    /** @type {import('../scene/map-points-manager.js').MapPointsManager|null} */
    this.mapPointsManager = null;

    /** @type {import('../scene/physics-rope-manager.js').PhysicsRopeManager|null} */
    this.physicsRopeManager = null;

    /** @type {import('../foundry/drop-handler.js').DropHandler|null} */
    this.dropHandler = null;

    /** @type {import('../core/DynamicExposureManager.js').DynamicExposureManager|null} */
    this.dynamicExposureManager = null;

    // --- Named Effect References ---
    // Effects that need direct references beyond what effectComposer.effects provides
    // (e.g., for cross-wiring, fog hook registration, mode switching)
    /** @type {import('../effects/LightingEffect.js').LightingEffect|null} */
    this.lightingEffect = null;

    /** @type {import('../effects/LightningEffect.js').LightningEffect|null} */
    this.lightningEffect = null;

    /** @type {import('../effects/WorldSpaceFogEffect.js').WorldSpaceFogEffect|null} */
    this.fogEffect = null;

    /** @type {import('../effects/SkyColorEffect.js').SkyColorEffect|null} */
    this.skyColorEffect = null;

    /** @type {import('../effects/CandleFlamesEffect.js').CandleFlamesEffect|null} */
    this.candleFlamesEffect = null;

    /** @type {import('../particles/AshDisturbanceEffect.js').AshDisturbanceEffect|null} */
    this.ashDisturbanceEffect = null;

    /**
     * Named effect map built during effect registration.
     * Maps display names (e.g. 'Specular', 'Water') to effect instances.
     * Used by initializeUI and cross-wiring instead of positional parameters.
     * @type {Map<string, import('../effects/EffectComposer.js').EffectBase>}
     */
    this.effectMap = new Map();

    // --- Lifecycle State ---
    /** @type {boolean} */
    this.isMapMakerMode = false;

    /** @type {boolean} */
    this.frameCoordinatorInitialized = false;

    /** @type {boolean} */
    this.sceneResetInProgress = false;

    // --- Timers & Handlers ---
    /** @type {number|null} */
    this.fpsLogIntervalId = null;

    /** @type {number|null} */
    this.windVaneIntervalId = null;

    /** @type {Function|null} */
    this._webglContextLostHandler = null;

    /** @type {Function|null} */
    this._webglContextRestoredHandler = null;

    /** @type {ResizeObserver|null} */
    this.resizeObserver = null;

    /** @type {Function|null} */
    this.windowResizeHandler = null;

    /** @type {number|null} */
    this.resizeDebounceTimer = null;

    /** @type {number|null} */
    this.collapseSidebarHookId = null;

    /**
     * P0.3: Snapshot of Foundry layer state captured before MapShine modifies it.
     * Restored on teardown.
     * @type {{ layerVisibility: Map<string, boolean>, rendererBgAlpha: number|null }|null}
     */
    this.foundryStateSnapshot = null;

    /**
     * Foundry fog/visibility state saved when entering Map Maker mode.
     * @type {{ fogVisible: boolean|null, visibilityVisible: boolean|null, visibilityFilterEnabled: boolean|null }|null}
     */
    this.mapMakerFogState = null;

    // --- Select Rect Suppression ---
    /** @type {Function|null} */
    this._mapShineOrigDrawSelect = null;

    /** @type {boolean} */
    this._mapShineSelectSuppressed = false;

    this._disposed = false;
  }

  /**
   * Get an effect instance by its display name (e.g., 'Specular', 'Water').
   * @param {string} name - Display name as registered in effectMap
   * @returns {import('../effects/EffectComposer.js').EffectBase|null}
   */
  getEffect(name) {
    return this.effectMap.get(name) ?? null;
  }

  /**
   * Dispose all managed resources in the correct dependency order.
   * After calling this, all references are null and the context should be discarded.
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    log.info('Disposing SceneContext');

    // Clear timers first
    if (this.fpsLogIntervalId !== null) {
      clearInterval(this.fpsLogIntervalId);
      this.fpsLogIntervalId = null;
    }
    if (this.windVaneIntervalId !== null) {
      clearInterval(this.windVaneIntervalId);
      this.windVaneIntervalId = null;
    }
    if (this.resizeDebounceTimer !== null) {
      clearTimeout(this.resizeDebounceTimer);
      this.resizeDebounceTimer = null;
    }

    // Dispose in reverse-initialization order (dependents before dependencies)
    const disposables = [
      ['uiManager', 'dispose'],
      ['enhancedLightInspector', 'dispose'],
      ['lightEditor', 'dispose'],
      ['overlayUIManager', 'dispose'],
      ['controlPanel', 'destroy'],
      ['graphicsSettings', 'dispose'],
      ['cameraFollower', 'dispose'],
      ['pixiInputBridge', 'dispose'],
      ['controlsIntegration', 'destroy'],
      ['dropHandler', 'dispose'],
      ['interactionManager', 'dispose'],
      ['tokenManager', 'dispose'],
      ['tileManager', 'dispose'],
      ['surfaceRegistry', 'dispose'],
      ['wallManager', 'dispose'],
      ['doorMeshManager', 'dispose'],
      ['drawingManager', 'dispose'],
      ['noteManager', 'dispose'],
      ['templateManager', 'dispose'],
      ['lightIconManager', 'dispose'],
      ['enhancedLightIconManager', 'dispose'],
      ['gridRenderer', 'dispose'],
      ['mapPointsManager', 'dispose'],
      ['physicsRopeManager', 'dispose'],
      ['effectComposer', 'dispose'],
      ['sceneComposer', 'dispose'],
    ];

    for (const [key, method] of disposables) {
      const obj = this[key];
      if (!obj) continue;
      try {
        if (typeof obj[method] === 'function') {
          obj[method]();
        }
      } catch (e) {
        log.warn(`Failed to dispose ${key}:`, e);
      }
      this[key] = null;
    }

    // Stop render loop (special — uses stop() not dispose())
    if (this.renderLoop) {
      try { this.renderLoop.stop(); } catch (_) {}
      this.renderLoop = null;
    }

    // Clean up WebGL context handlers
    if (this.threeCanvas) {
      try {
        if (this._webglContextLostHandler) {
          this.threeCanvas.removeEventListener('webglcontextlost', this._webglContextLostHandler);
        }
        if (this._webglContextRestoredHandler) {
          this.threeCanvas.removeEventListener('webglcontextrestored', this._webglContextRestoredHandler);
        }
      } catch (_) {}
      this._webglContextLostHandler = null;
      this._webglContextRestoredHandler = null;

      try { this.threeCanvas.remove(); } catch (_) {}
      this.threeCanvas = null;
    }

    // Clean up resize observer
    if (this.resizeObserver) {
      try { this.resizeObserver.disconnect(); } catch (_) {}
      this.resizeObserver = null;
    }
    if (this.windowResizeHandler) {
      try { window.removeEventListener('resize', this.windowResizeHandler); } catch (_) {}
      this.windowResizeHandler = null;
    }
    if (this.collapseSidebarHookId !== null) {
      try { Hooks.off('collapseSidebar', this.collapseSidebarHookId); } catch (_) {}
      this.collapseSidebarHookId = null;
    }

    // Clear named effect references
    this.lightingEffect = null;
    this.lightningEffect = null;
    this.fogEffect = null;
    this.skyColorEffect = null;
    this.candleFlamesEffect = null;
    this.ashDisturbanceEffect = null;
    this.effectMap.clear();

    // Clear state
    this.foundryStateSnapshot = null;
    this.mapMakerFogState = null;
    this._mapShineOrigDrawSelect = null;
    this._mapShineSelectSuppressed = false;

    // Note: renderer is owned by MapShine global state, not disposed here
    this.renderer = null;

    log.info('SceneContext disposed');
  }

  /**
   * Sync all references to window.MapShine for debugging/console access.
   * Production code should use the context directly, not window.MapShine.
   */
  exposeToGlobal() {
    const ms = window.MapShine;
    if (!ms) return;

    ms.sceneComposer = this.sceneComposer;
    ms.effectComposer = this.effectComposer;
    ms.renderLoop = this.renderLoop;
    ms.cameraFollower = this.cameraFollower;
    ms.pixiInputBridge = this.pixiInputBridge;
    ms.controlsIntegration = this.controlsIntegration;
    ms.tokenManager = this.tokenManager;
    ms.tileManager = this.tileManager;
    ms.surfaceRegistry = this.surfaceRegistry;
    ms.wallManager = this.wallManager;
    ms.doorMeshManager = this.doorMeshManager;
    ms.drawingManager = this.drawingManager;
    ms.noteManager = this.noteManager;
    ms.templateManager = this.templateManager;
    ms.lightIconManager = this.lightIconManager;
    ms.enhancedLightIconManager = this.enhancedLightIconManager;
    ms.interactionManager = this.interactionManager;
    ms.gridRenderer = this.gridRenderer;
    ms.mapPointsManager = this.mapPointsManager;
    ms.physicsRopeManager = this.physicsRopeManager;
    ms.overlayUIManager = this.overlayUIManager;
    ms.lightEditor = this.lightEditor;
    ms.enhancedLightInspector = this.enhancedLightInspector;
    ms.dynamicExposureManager = this.dynamicExposureManager;
    ms.lightingEffect = this.lightingEffect;
    ms.lightningEffect = this.lightningEffect;
    ms.fogEffect = this.fogEffect;
    ms.skyColorEffect = this.skyColorEffect;
    ms.candleFlamesEffect = this.candleFlamesEffect;
    ms.ashDisturbanceEffect = this.ashDisturbanceEffect;
    ms.isMapMakerMode = this.isMapMakerMode;
    ms.graphicsSettings = this.graphicsSettings;
    ms.controlPanel = this.controlPanel;
    ms.uiManager = this.uiManager;

    // Expose named effects from effectMap
    for (const [name, effect] of this.effectMap) {
      // Convert display name to camelCase key (e.g. 'Overhead Shadows' -> 'overheadShadowsEffect')
      const key = name.replace(/\s+(.)/g, (_, c) => c.toUpperCase())
        .replace(/^(.)/, (_, c) => c.toLowerCase()) + 'Effect';
      if (!(key in ms) || ms[key] === null) {
        ms[key] = effect;
      }
    }
  }

  /**
   * Clear all window.MapShine references that were set by exposeToGlobal().
   * Called during teardown to prevent stale references.
   */
  clearGlobal() {
    const ms = window.MapShine;
    if (!ms) return;

    const keys = [
      'sceneComposer', 'effectComposer', 'renderLoop', 'cameraFollower',
      'pixiInputBridge', 'controlsIntegration', 'tokenManager', 'tileManager',
      'surfaceRegistry', 'wallManager', 'doorMeshManager', 'drawingManager',
      'noteManager', 'templateManager', 'lightIconManager', 'enhancedLightIconManager',
      'interactionManager', 'gridRenderer', 'mapPointsManager', 'physicsRopeManager',
      'overlayUIManager', 'lightEditor', 'enhancedLightInspector',
      'dynamicExposureManager', 'lightingEffect', 'lightningEffect',
      'fogEffect', 'skyColorEffect', 'candleFlamesEffect', 'ashDisturbanceEffect',
      'maskManager', 'waterEffect', 'distortionManager', 'cloudEffect',
      'frameCoordinator', 'graphicsSettings', 'controlPanel', 'uiManager'
    ];

    for (const key of keys) {
      ms[key] = null;
    }
  }
}
