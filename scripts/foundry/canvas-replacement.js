/**
 * @fileoverview Canvas replacement hooks for Foundry VTT integration
 * Uses Libwrapper to intercept and replace Foundry's canvas rendering
 * @module foundry/canvas-replacement
 */

import { createLogger } from '../core/log.js';
import * as sceneSettings from '../settings/scene-settings.js';
import { SceneComposer } from '../scene/composer.js';
import { CameraFollower } from './camera-follower.js';
import { PixiInputBridge } from './pixi-input-bridge.js';
import { EffectComposer } from '../effects/EffectComposer.js';
import { SpecularEffect } from '../effects/SpecularEffect.js';
import { IridescenceEffect } from '../effects/IridescenceEffect.js';
import { WindowLightEffect } from '../effects/WindowLightEffect.js';
import { BushEffect } from '../effects/BushEffect.js';
import { TreeEffect } from '../effects/TreeEffect.js';
import { ColorCorrectionEffect } from '../effects/ColorCorrectionEffect.js';
import { FilmGrainEffect } from '../effects/FilmGrainEffect.js';
import { DotScreenEffect } from '../effects/DotScreenEffect.js';
import { HalftoneEffect } from '../effects/HalftoneEffect.js';
import { SharpenEffect } from '../effects/SharpenEffect.js';
import { SkyColorEffect } from '../effects/SkyColorEffect.js';
import { AsciiEffect } from '../effects/AsciiEffect.js';
import { BloomEffect } from '../effects/BloomEffect.js';
import { LightingEffect } from '../effects/LightingEffect.js';
import { LightningEffect } from '../effects/LightningEffect.js';
import { LensflareEffect } from '../effects/LensflareEffect.js';
import { PrismEffect } from '../effects/PrismEffect.js';
import { OverheadShadowsEffect } from '../effects/OverheadShadowsEffect.js';
import { BuildingShadowsEffect } from '../effects/BuildingShadowsEffect.js';
import { CloudEffect } from '../effects/CloudEffect.js';
import { AtmosphericFogEffect } from '../effects/AtmosphericFogEffect.js';
import { DistortionManager } from '../effects/DistortionManager.js';
import { WaterEffectV2 } from '../effects/WaterEffectV2.js';
import { MaskDebugEffect } from '../effects/MaskDebugEffect.js';
import { DebugLayerEffect } from '../effects/DebugLayerEffect.js';
import { PlayerLightEffect } from '../effects/PlayerLightEffect.js';
import { CandleFlamesEffect } from '../effects/CandleFlamesEffect.js';
import { MaskManager } from '../masks/MaskManager.js';
import { ParticleSystem } from '../particles/ParticleSystem.js';
import { FireSparksEffect } from '../particles/FireSparksEffect.js';
import { SmellyFliesEffect } from '../particles/SmellyFliesEffect.js';
import { DustMotesEffect } from '../particles/DustMotesEffect.js';
import { WorldSpaceFogEffect } from '../effects/WorldSpaceFogEffect.js';
import { RenderLoop } from '../core/render-loop.js';
import { TweakpaneManager } from '../ui/tweakpane-manager.js';
import { ControlPanelManager } from '../ui/control-panel-manager.js';
import { EnhancedLightInspector } from '../ui/enhanced-light-inspector.js';
import { TokenManager } from '../scene/token-manager.js';
import { TileManager } from '../scene/tile-manager.js';
import { SurfaceRegistry } from '../scene/surface-registry.js';
import { WallManager } from '../scene/wall-manager.js';
import { DoorMeshManager } from '../scene/DoorMeshManager.js';
import { DrawingManager } from '../scene/drawing-manager.js';
import { NoteManager } from '../scene/note-manager.js';
import { TemplateManager } from '../scene/template-manager.js';
import { LightIconManager } from '../scene/light-icon-manager.js';
import { EnhancedLightIconManager } from '../scene/enhanced-light-icon-manager.js';
import { InteractionManager } from '../scene/interaction-manager.js';
import { GridRenderer } from '../scene/grid-renderer.js';
import { MapPointsManager } from '../scene/map-points-manager.js';
import { PhysicsRopeManager } from '../scene/physics-rope-manager.js';
import { DropHandler } from './drop-handler.js';
import { sceneDebug } from '../utils/scene-debug.js';
import { clearCache as clearAssetCache } from '../assets/loader.js';
import { globalLoadingProfiler } from '../core/loading-profiler.js';
import { weatherController } from '../core/WeatherController.js';
import { ControlsIntegration } from './controls-integration.js';
import { frameCoordinator } from '../core/frame-coordinator.js';
import { loadingOverlay } from '../ui/loading-overlay.js';
import { stateApplier } from '../ui/state-applier.js';
import { createEnhancedLightsApi } from '../effects/EnhancedLightsApi.js';
import { OverlayUIManager } from '../ui/overlay-ui-manager.js';
import { LightRingUI } from '../ui/light-ring-ui.js';
import { LightAnimDialog } from '../ui/light-anim-dialog.js';
import { EffectCapabilitiesRegistry } from '../effects/effect-capabilities-registry.js';
import { GraphicsSettingsManager } from '../ui/graphics-settings-manager.js';

const log = createLogger('Canvas');

/** @type {ControlsIntegration|null} */
let controlsIntegration = null;

/** @type {HTMLCanvasElement|null} */
let threeCanvas = null;

/** @type {boolean} */
let isMapMakerMode = false;

/**
 * Track Foundry's native fog/visibility state so we can temporarily bypass it
 * in Map Maker mode (GM convenience) without permanently mutating the scene.
 * @type {{ fogVisible: boolean|null, visibilityVisible: boolean|null, visibilityFilterEnabled: boolean|null }|null}
 */
let mapMakerFogState = null;

/**
 * P0.3: Capture snapshot of Foundry layer state on initialization
 * Restored on teardown instead of force-resetting to defaults
 * @type {{ layerVisibility: Map<string, boolean>, rendererBgAlpha: number|null }|null}
 */
let foundryStateSnapshot = null;

/** @type {boolean} */
let isHooked = false;

/** @type {THREE.Renderer|null} */
let renderer = null;

/** @type {SceneComposer|null} */
let sceneComposer = null;

/** @type {EffectComposer|null} */
let effectComposer = null;

/** @type {RenderLoop|null} */
let renderLoop = null;

/** @type {CameraFollower|null} */
let cameraFollower = null;

/** @type {PixiInputBridge|null} */
let pixiInputBridge = null;

/** @type {TweakpaneManager|null} */
let uiManager = null;

/** @type {ControlPanelManager|null} */
let controlPanel = null;

/**
 * ESSENTIAL FEATURE:
 * Per-client Graphics Settings (Players/GMs) to disable or reduce effect intensity.
 * This must remain safe to toggle during live play.
 * @type {GraphicsSettingsManager|null}
 */
let graphicsSettings = null;

/** @type {EffectCapabilitiesRegistry|null} */
let effectCapabilitiesRegistry = null;

function _applyRenderResolutionToRenderer(viewportWidthCss, viewportHeightCss) {
  if (!renderer || typeof renderer.setPixelRatio !== 'function') return;

  try {
    const baseDpr = window.devicePixelRatio || 1;
    const effective = graphicsSettings?.computeEffectivePixelRatio
      ? graphicsSettings.computeEffectivePixelRatio(viewportWidthCss, viewportHeightCss, baseDpr)
      : baseDpr;
    renderer.setPixelRatio(effective);
  } catch (_) {
  }
}

/** @type {EnhancedLightInspector|null} */
let enhancedLightInspector = null;

/** @type {OverlayUIManager|null} */
let overlayUIManager = null;

/** @type {LightRingUI|null} */
let lightRingUI = null;

/** @type {LightAnimDialog|null} */
let lightAnimDialog = null;

/** @type {TokenManager|null} */
let tokenManager = null;

/** @type {TileManager|null} */
let tileManager = null;

/** @type {SurfaceRegistry|null} */
let surfaceRegistry = null;

/** @type {WallManager|null} */
let wallManager = null;

/** @type {DoorMeshManager|null} */
let doorMeshManager = null;

/** @type {DrawingManager|null} */
let drawingManager = null;

/** @type {NoteManager|null} */
let noteManager = null;

/** @type {TemplateManager|null} */
let templateManager = null;

/** @type {LightIconManager|null} */
let lightIconManager = null;

/** @type {EnhancedLightIconManager|null} */
let enhancedLightIconManager = null;

/** @type {InteractionManager|null} */
let interactionManager = null;

// Foundry draws the drag-select rectangle in PIXI (ControlsLayer.drawSelect).
// Since we keep the PIXI canvas visible for overlays (drawings/templates), we must
// suppress that rectangle in Gameplay mode so our custom selection visuals can own it.
let _mapShineOrigDrawSelect = null;
let _mapShineSelectSuppressed = false;

function _updateFoundrySelectRectSuppression(forceValue = null) {
  // Suppress Foundry selection rectangle when:
  // - MapShine is running and we are in Gameplay mode
  // - and our InteractionManager selection box is enabled
  let suppress = false;
  try {
    const im = window.MapShine?.interactionManager;
    const enabled = im?.selectionBoxParams?.enabled !== false;
    suppress = !isMapMakerMode && enabled;
  } catch (_) {
    suppress = !isMapMakerMode;
  }

  if (typeof forceValue === 'boolean') suppress = forceValue;

  // Avoid redundant patching.
  if (_mapShineSelectSuppressed === suppress) return;
  _mapShineSelectSuppressed = suppress;

  try {
    const controls = canvas?.controls;
    if (!controls) return;

    const selectGfx = controls.select;
    const current = controls.drawSelect;

    if (suppress) {
      if (!_mapShineOrigDrawSelect && typeof current === 'function') {
        _mapShineOrigDrawSelect = current.bind(controls);
      }

      controls.drawSelect = ({ x, y, width, height } = {}) => {
        try {
          if (selectGfx?.clear) selectGfx.clear();
          if (selectGfx) selectGfx.visible = false;
        } catch (_) {
        }
      };

      try {
        if (selectGfx?.clear) selectGfx.clear();
        if (selectGfx) selectGfx.visible = false;
      } catch (_) {
      }
    } else {
      if (_mapShineOrigDrawSelect) {
        controls.drawSelect = _mapShineOrigDrawSelect;
      }
      try {
        if (selectGfx) selectGfx.visible = true;
      } catch (_) {
      }
    }
  } catch (_) {
  }
}

/** @type {GridRenderer|null} */
let gridRenderer = null;

/** @type {MapPointsManager|null} */
let mapPointsManager = null;

/** @type {PhysicsRopeManager|null} */
let physicsRopeManager = null;

/** @type {DropHandler|null} */
let dropHandler = null;

/** @type {LightingEffect|null} */
let lightingEffect = null;

/** @type {LightningEffect|null} */
let lightningEffect = null;

let candleFlamesEffect = null;

/** @type {WorldSpaceFogEffect|null} */
let fogEffect = null;

// NOTE: visionManager and fogManager are no longer used.
// WorldSpaceFogEffect renders fog as a world-space plane mesh in the Three.js scene.

/** @type {SkyColorEffect|null} */
let skyColorEffect = null;

/** @type {boolean} - Whether frame coordinator is initialized */
let frameCoordinatorInitialized = false;

/** @type {ResizeObserver|null} - Observer for canvas container resize */
let resizeObserver = null;

/** @type {Function|null} - Bound window resize handler for cleanup */
let windowResizeHandler = null;

/** @type {number} - Debounce timer for resize events */
let resizeDebounceTimer = null;

/** @type {number|null} - Hook ID for collapseSidebar listener */
let collapseSidebarHookId = null;

 /** @type {number|null} - Interval ID for periodic FPS logging */
 let fpsLogIntervalId = null;

/** @type {boolean} */
let sceneResetInProgress = false;

/** @type {Function|null} */
let _webglContextLostHandler = null;

/** @type {Function|null} */
let _webglContextRestoredHandler = null;

 /** @type {number|null} - Interval ID for weather windvane UI sync */
 let windVaneIntervalId = null;

 /** @type {boolean} */
 let transitionsInstalled = false;

 /** @type {number|null} - Hook ID for pauseGame listener */
 let pauseGameHookId = null;

 /** @type {number} */
 let createThreeCanvasGeneration = 0;

/**
 * Initialize canvas replacement hooks
 * Uses Foundry's native hook system for v13 compatibility
 * @returns {boolean} Whether hooks were successfully registered
 * @public
 */
export function initialize() {
  if (isHooked) {
    log.warn('Canvas hooks already registered');
    return true;
  }

  try {
    // CRITICAL: Hook into canvasConfig to make PIXI canvas transparent
    // This hook is called BEFORE the PIXI.Application is created, allowing us
    // to set transparent: true so the PIXI canvas can show Three.js underneath
    Hooks.on('canvasConfig', (config) => {
      log.info('Configuring PIXI canvas for transparency');
      config.transparent = true;
      // Also set backgroundAlpha to 0 for good measure
      config.backgroundAlpha = 0;
    });
    
    // Hook into canvas ready event (when canvas is fully initialized)
    Hooks.on('canvasReady', onCanvasReady);
    
    // Hook into canvas teardown
    Hooks.on('canvasTearDown', onCanvasTearDown);
    
    // Hook into scene configuration changes (grid, padding, background, etc.)
    Hooks.on('updateScene', onUpdateScene);

    // Hook into Foundry pause/unpause so we can smoothly ramp time scale to 0 and back.
    if (!pauseGameHookId) {
      pauseGameHookId = Hooks.on('pauseGame', (paused) => {
        try {
          const tm = window.MapShine?.timeManager || effectComposer?.getTimeManager?.();
          if (tm && typeof tm.setFoundryPaused === 'function') {
            tm.setFoundryPaused(!!paused);
          }
        } catch (e) {
          // Ignore hook errors
        }
      });
    }

     // Install transition wrapper so we can fade-to-black BEFORE Foundry tears down the old scene.
     // This must wrap an awaited method (Canvas.tearDown) to actually block the teardown.
     installCanvasTransitionWrapper();

    isHooked = true;
    log.info('Canvas replacement hooks registered');
    return true;

  } catch (error) {
    log.error('Failed to register canvas hooks:', error);
    return false;
  }
}

function installCanvasTransitionWrapper() {
  if (transitionsInstalled) return;
  transitionsInstalled = true;

  try {
    const CanvasCls = globalThis.foundry?.canvas?.Canvas;
    const proto = CanvasCls?.prototype;
    if (!proto?.tearDown) {
      log.warn('Canvas class not available; scene transition wrapper not installed');
      return;
    }

    if (proto.tearDown.__mapShineWrapped) return;

    const original = proto.tearDown;
    const wrapped = async function(...args) {
      try {
        const scene = this.scene;
        if (scene && sceneSettings.isEnabled(scene)) {
          loadingOverlay.showLoading('Switching scenes…');
          await loadingOverlay.fadeToBlack(5000);
          loadingOverlay.setMessage('Loading…');
          loadingOverlay.setProgress(0, { immediate: true });
        }
      } catch (e) {
        log.warn('Scene transition fade failed:', e);
      }
      return original.apply(this, args);
    };

    wrapped.__mapShineWrapped = true;
    proto.tearDown = wrapped;
    log.info('Installed Canvas.tearDown transition wrapper');
  } catch (e) {
    log.warn('Failed to install scene transition wrapper:', e);
  }
}

async function waitForThreeFrames(
  renderer,
  renderLoop,
  minFrames = 2,
  timeoutMs = 5000,
  {
    minCalls = 1,
    minDelayMs = 0,
    stableCallsFrames = 2
  } = {}
) {
  const startTime = performance.now();

  const startThreeFrame = renderer?.info?.render?.frame;
  const startLoopFrame = typeof renderLoop?.getFrameCount === 'function' ? renderLoop.getFrameCount() : 0;

  let callsStable = 0;

  while (performance.now() - startTime < timeoutMs) {
    const now = performance.now();
    const currentThreeFrame = renderer?.info?.render?.frame;
    const currentLoopFrame = typeof renderLoop?.getFrameCount === 'function' ? renderLoop.getFrameCount() : 0;

    const hasThreeCounter = Number.isFinite(startThreeFrame) && Number.isFinite(currentThreeFrame);
    const framesAdvanced = hasThreeCounter
      ? (currentThreeFrame - startThreeFrame)
      : (currentLoopFrame - startLoopFrame);

    const calls = renderer?.info?.render?.calls;
    if (Number.isFinite(calls) && calls >= minCalls) callsStable++;
    else callsStable = 0;

    const meetsDelay = (now - startTime) >= minDelayMs;
    const meetsFrames = framesAdvanced >= minFrames;
    const meetsCalls = !Number.isFinite(calls) ? true : (callsStable >= stableCallsFrames);

    if (meetsDelay && meetsFrames && meetsCalls) return true;

    await new Promise(resolve => requestAnimationFrame(resolve));
  }

  return false;
}

/**
 * Hook handler for updateScene event
 * Called when scene configuration changes mid-session
 * @param {Scene} scene - The updated scene
 * @param {object} changes - Changed properties
 * @param {object} options - Update options
 * @param {string} userId - User who made the change
 * @private
 */
async function onUpdateScene(scene, changes, _options, _userId) {
  // Only process if this is the current scene and Map Shine is enabled
  if (!canvas?.scene || scene.id !== canvas.scene.id) return;
  if (!sceneSettings.isEnabled(scene)) return;

  // Weather authority sync (GM flags replicated to all clients)
  try {
    if (changes?.flags?.['map-shine-advanced']) {
      const ns = changes.flags['map-shine-advanced'];

      if (Object.prototype.hasOwnProperty.call(ns, 'controlState')) {
        const cs = scene.getFlag('map-shine-advanced', 'controlState');
        if (cs && typeof cs === 'object') {
          try {
            if (Number.isFinite(cs.timeOfDay)) {
              const mins = Number(cs.timeTransitionMinutes) || 0;
              if (mins > 0) {
                void stateApplier.startTimeOfDayTransition(cs.timeOfDay, mins, false);
              } else {
                void stateApplier.applyTimeOfDay(cs.timeOfDay, false, true);
              }
            }

            const applyDynamic = (typeof cs.weatherMode !== 'string') || cs.weatherMode === 'dynamic';

            if (applyDynamic) {
              if (typeof cs.dynamicEnabled === 'boolean') {
                if (typeof weatherController.setDynamicEnabled === 'function') {
                  weatherController.setDynamicEnabled(cs.dynamicEnabled);
                } else {
                  weatherController.dynamicEnabled = cs.dynamicEnabled;
                }
              }

              if (typeof cs.dynamicPresetId === 'string' && cs.dynamicPresetId) {
                if (typeof weatherController.setDynamicPreset === 'function') {
                  weatherController.setDynamicPreset(cs.dynamicPresetId);
                } else {
                  weatherController.dynamicPresetId = cs.dynamicPresetId;
                }
              }

              if (Number.isFinite(cs.dynamicEvolutionSpeed)) {
                if (typeof weatherController.setDynamicEvolutionSpeed === 'function') {
                  weatherController.setDynamicEvolutionSpeed(cs.dynamicEvolutionSpeed);
                } else {
                  weatherController.dynamicEvolutionSpeed = cs.dynamicEvolutionSpeed;
                }
              }

              if (typeof cs.dynamicPaused === 'boolean') {
                if (typeof weatherController.setDynamicPaused === 'function') {
                  weatherController.setDynamicPaused(cs.dynamicPaused);
                } else {
                  weatherController.dynamicPaused = cs.dynamicPaused;
                }
              }
            }

            const cp = window.MapShine?.controlPanel;
            if (cp) {
              if (cp.controlState && typeof cp.controlState === 'object') {
                Object.assign(cp.controlState, cs);
              } else {
                cp.controlState = { ...cs };
              }
              try {
                cp.pane?.refresh?.();
              } catch (e) {
              }
            }
          } catch (e) {
          }
        }
      }

      if (Object.prototype.hasOwnProperty.call(ns, 'weather-transition')) {
        const cmd = scene.getFlag('map-shine-advanced', 'weather-transition');
        if (cmd) {
          weatherController.applyTransitionCommand?.(cmd);
        }
      }

      if (Object.prototype.hasOwnProperty.call(ns, 'weather-dynamic')) {
        weatherController._loadDynamicStateFromScene?.();
        try {
          uiManager?.updateControlStates?.('weather');
        } catch (e) {
        }
      }

      if (Object.prototype.hasOwnProperty.call(ns, 'weather-transitionTarget')) {
        weatherController._loadQueuedTransitionTargetFromScene?.();
      }

      if (Object.prototype.hasOwnProperty.call(ns, 'weather-snapshot')) {
        weatherController._loadWeatherSnapshotFromScene?.();
      }
    }
  } catch (e) {
  }
  
  // Grid changes should NOT require a full Three.js scene rebuild.
  // Rebuilding can race with Foundry's internal canvas updates and briefly leave `canvas.ready=false`,
  // which breaks ControlsIntegration initialization.
  if ('grid' in changes) {
    try {
      gridRenderer?.updateGrid?.();
    } catch (_) {
    }
  }

  // Check for changes that require full reinitialization
  // NOTE: Some grid changes (type/size/distance) can change canvas.dimensions, sceneRect, and snapping geometry.
  // Those DO require a rebuild so the camera, base plane, effect bounds, and render targets stay consistent.
  // Purely visual grid changes (style/thickness/color/alpha) should not rebuild.
  const gridChanges = changes.grid && typeof changes.grid === 'object' ? changes.grid : null;
  const gridGeometryChanged = !!(gridChanges && (
    Object.prototype.hasOwnProperty.call(gridChanges, 'type') ||
    Object.prototype.hasOwnProperty.call(gridChanges, 'size') ||
    Object.prototype.hasOwnProperty.call(gridChanges, 'distance')
  ));

  const requiresReinit = [
    'padding',        // Scene padding changes
    'background',     // Background image changes
    'width',          // Scene dimension changes
    'height',
    'backgroundColor' // Background color changes
  ].some(key => key in changes);

  const shouldReinit = requiresReinit || gridGeometryChanged;
  
  if (shouldReinit) {
    log.info('Scene configuration changed, reinitializing Map Shine canvas');
    
    // Defer to next frame to ensure Foundry has finished updating
    setTimeout(async () => {
      await createThreeCanvas(scene);
    }, 0);
  }
}

async function _waitForFoundryCanvasReady({ timeoutMs = 15000 } = {}) {
  const start = Date.now();
  const pollMs = 50;

  while ((Date.now() - start) < timeoutMs) {
    try {
      const issues = [];
      if (!canvas?.ready) issues.push('Canvas not ready');
      if (!canvas?.stage) issues.push('Stage not initialized');
      if (!canvas?.app?.renderer) issues.push('Renderer not available');
      if (!canvas?.app?.view) issues.push('Canvas view not available');

      // Match ControlsIntegration expectations
      const requiredLayers = ['tokens', 'walls', 'lighting', 'controls'];
      for (const name of requiredLayers) {
        if (!canvas?.[name]) issues.push(`Missing layer: ${name}`);
      }

      if (issues.length === 0) return true;
    } catch (_) {
      // Keep polling
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }

  return false;
}

/**
 * Hook handler for canvasReady event
 * Called when Foundry's canvas is fully initialized
 * @param {Canvas} canvas - Foundry canvas instance
 * @private
 */
async function onCanvasReady(canvas) {
  const scene = canvas.scene;

  if (!scene) {
    log.debug('onCanvasReady called with no active scene');
    return;
  }

  // Wait for bootstrap to complete if it hasn't yet
  // This handles race condition where canvas loads before 'ready' hook
  if (!window.MapShine || !window.MapShine.initialized) {
    log.info('Waiting for bootstrap to complete...');
    
    // Wait up to 15 seconds for bootstrap (increased for slow systems)
    const MAX_WAIT_MS = 15000;
    const POLL_INTERVAL_MS = 100;
    const startTime = Date.now();
    let lastLogTime = startTime;
    
    while (!window.MapShine?.initialized && (Date.now() - startTime) < MAX_WAIT_MS) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      
      // Log progress every 2 seconds to show we're still waiting
      if (Date.now() - lastLogTime > 2000) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        log.debug(`Still waiting for bootstrap... (${elapsed}s elapsed)`);
        lastLogTime = Date.now();
      }
    }

    if (!window.MapShine?.initialized) {
      log.error('Bootstrap timeout - module did not initialize in time');
      ui.notifications.error('Map Shine: Initialization timeout. Try refreshing the page.');
      return;
    }
    
    log.info('Bootstrap complete, proceeding with canvas initialization');
  }

  // If scene is not enabled for Map Shine, run UI-only mode so GMs can
  // configure and enable Map Shine without replacing the Foundry canvas.
  if (!sceneSettings.isEnabled(scene)) {
    log.debug(`Scene not enabled for Map Shine, initializing UI-only mode: ${scene.name}`);

    if (!(game.user?.isGM ?? false)) {
      // Scene not replaced by Three.js - dismiss the overlay so the user can interact with Foundry normally.
      try {
        loadingOverlay.fadeIn(500).catch(() => {});
      } catch (e) {
        log.debug('Loading overlay not available:', e);
      }

      return;
    }

    try {
      if (window.MapShine) window.MapShine.stateApplier = stateApplier;
    } catch (e) {
    }

    if (!uiManager) {
      try {
        uiManager = new TweakpaneManager();
        await uiManager.initialize();
        window.MapShine.uiManager = uiManager;
        log.info('Map Shine UI initialized in UI-only mode');
      } catch (e) {
        log.error('Failed to initialize Map Shine UI in UI-only mode:', e);
      }
    }

    if (!controlPanel) {
      try {
        controlPanel = new ControlPanelManager();
        await controlPanel.initialize();
        window.MapShine.controlPanel = controlPanel;
        log.info('Map Shine Control Panel initialized in UI-only mode');
      } catch (e) {
        log.error('Failed to initialize Map Shine Control Panel in UI-only mode:', e);
      }
    }

    // Graphics Settings (Essential Feature)
    // Even in UI-only mode, we create the dialog so the scene-control button does not dead-end.
    // In this mode there are no live effects to toggle; the UI will remain minimal.
    try {
      if (!effectCapabilitiesRegistry) effectCapabilitiesRegistry = new EffectCapabilitiesRegistry();
      if (!graphicsSettings) {
        graphicsSettings = new GraphicsSettingsManager(null, effectCapabilitiesRegistry, {
          onApplyRenderResolution: () => {
            try {
              if (!threeCanvas) return;
              const rect = threeCanvas.getBoundingClientRect();
              resize(rect.width, rect.height);
            } catch (_) {
            }
          }
        });
        await graphicsSettings.initialize();
        if (window.MapShine) window.MapShine.graphicsSettings = graphicsSettings;
      }
    } catch (e) {
      log.warn('Failed to initialize Graphics Settings in UI-only mode', e);
    }

     // Scene not replaced by Three.js - dismiss the overlay so the user can interact with Foundry normally.
     try {
       loadingOverlay.fadeIn(500).catch(() => {});
     } catch (e) {
       log.debug('Loading overlay not available:', e);
     }

    return;
  }

  log.info(`Initializing Map Shine canvas for scene: ${scene.name}`);

  try {
    loadingOverlay.showBlack(`Loading ${scene?.name || 'scene'}…`);
    loadingOverlay.configureStages([
      { id: 'assets', label: 'Loading assets…', weight: 30 },
      { id: 'effects', label: 'Initializing effects…', weight: 35 },
      { id: 'scene', label: 'Syncing scene…', weight: 20 },
      { id: 'final', label: 'Finalizing…', weight: 15 },
    ]);
    loadingOverlay.startStages();
    loadingOverlay.setStage('assets', 0.05, undefined, { immediate: true });
    loadingOverlay.startAutoProgress(0.08, 0.02);
  } catch (e) {
    log.debug('Loading overlay not available:', e);
  }

  // Create three.js canvas overlay
  await createThreeCanvas(scene);
}

/**
 * Hook handler for canvasTearDown event
 * Called when Foundry's canvas is being torn down
 * @param {Canvas} canvas - Foundry canvas instance
 * @private
 */
function onCanvasTearDown(canvas) {
  log.info('Tearing down Map Shine canvas');

  // CRITICAL: Pause time manager immediately to stop all animations
  if (effectComposer?.timeManager) {
    try {
      effectComposer.timeManager.pause();
    } catch (e) {
      log.warn('Failed to pause time manager:', e);
    }
  }

  // Dispose frame coordinator (removes PIXI ticker hook)
  if (frameCoordinatorInitialized) {
    try {
      frameCoordinator.dispose();
      frameCoordinatorInitialized = false;
    } catch (e) {
      log.warn('Failed to dispose frame coordinator:', e);
    }
  }

  if (window.MapShine?.maskManager && typeof window.MapShine.maskManager.dispose === 'function') {
    try {
      window.MapShine.maskManager.dispose();
    } catch (e) {
      log.warn('Failed to dispose MaskManager:', e);
    }
  }

  // Cleanup three.js canvas
  destroyThreeCanvas();
  
  // Clear global references to prevent stale state
  if (window.MapShine) {
    window.MapShine.sceneComposer = null;
    window.MapShine.effectComposer = null;
    window.MapShine.maskManager = null;
    window.MapShine.tokenManager = null;
    window.MapShine.tileManager = null;
    window.MapShine.surfaceRegistry = null;
    window.MapShine.surfaceReport = null;
    window.MapShine.wallManager = null;
    window.MapShine.doorMeshManager = null;
    window.MapShine.fogEffect = null;
    window.MapShine.lightingEffect = null;
    window.MapShine.candleFlamesEffect = null;
    window.MapShine.renderLoop = null;
    window.MapShine.cameraFollower = null;
    window.MapShine.pixiInputBridge = null;
    window.MapShine.interactionManager = null;
    window.MapShine.gridRenderer = null;
    window.MapShine.mapPointsManager = null;
    window.MapShine.physicsRopeManager = null;
    window.MapShine.frameCoordinator = null;
    window.MapShine.waterEffect = null;
    window.MapShine.distortionManager = null;
    window.MapShine.cloudEffect = null;
    // Keep renderer and capabilities - they're reusable
  }
  candleFlamesEffect = null;
}

/**
 * Create three.js canvas and attach to Foundry's canvas container
 * @param {Scene} scene - Current Foundry scene
 * @returns {Promise<void>}
 * @private
 */
/**
 * P0.3: Capture Foundry layer visibility state before enabling MapShine
 * This snapshot is restored on teardown instead of force-resetting to defaults
 * @private
 */
function captureFoundryStateSnapshot() {
  if (foundryStateSnapshot) return; // Already captured

  foundryStateSnapshot = {
    layerVisibility: new Map(),
    rendererBgAlpha: null
  };

  // Capture layer visibility
  const layerNames = [
    'background', 'grid', 'primary', 'tokens', 'tiles', 'lighting',
    'sounds', 'templates', 'drawings', 'notes', 'walls',
    'weather', 'environment', 'regions', 'controls', 'fog', 'visibility'
  ];

  for (const name of layerNames) {
    const layer = canvas[name];
    if (layer) {
      foundryStateSnapshot.layerVisibility.set(name, layer.visible);
    }
  }

  // Capture PIXI renderer background alpha
  if (canvas.app?.renderer?.background) {
    foundryStateSnapshot.rendererBgAlpha = canvas.app.renderer.background.alpha;
  }

  log.debug('P0.3: Captured Foundry state snapshot', foundryStateSnapshot);
}

/**
 * P0.3: Restore Foundry layer visibility state from snapshot
 * Replaces the old "force to defaults" approach
 * @private
 */
function restoreFoundryStateFromSnapshot() {
  if (!foundryStateSnapshot) {
    log.warn('P0.3: No state snapshot available, falling back to legacy restore');
    restoreFoundryRendering();
    return;
  }

  log.info('P0.3: Restoring Foundry state from snapshot');

  // Restore layer visibility
  for (const [name, wasVisible] of foundryStateSnapshot.layerVisibility) {
    const layer = canvas[name];
    if (layer) {
      layer.visible = wasVisible;
    }
  }

  // Restore PIXI renderer background alpha
  if (foundryStateSnapshot.rendererBgAlpha !== null && canvas.app?.renderer?.background) {
    canvas.app.renderer.background.alpha = foundryStateSnapshot.rendererBgAlpha;
  }

  // Restore token alphas
  if (canvas.tokens?.placeables) {
    for (const token of canvas.tokens.placeables) {
      if (token.mesh) token.mesh.alpha = 1;
      if (token.icon) token.icon.alpha = 1;
      if (token.border) token.border.alpha = 1;
    }
  }

  // Restore visibility layer filter if it was enabled
  if (canvas.visibility?.filter) {
    canvas.visibility.filter.enabled = true;
  }

  foundryStateSnapshot = null;
}

async function createThreeCanvas(scene) {
  // Cleanup existing canvas if present
  destroyThreeCanvas();

  try {
    if (window.MapShine) window.MapShine.stateApplier = stateApplier;
  } catch (e) {
  }

  const myGen = ++createThreeCanvasGeneration;
  const isStale = () => myGen !== createThreeCanvasGeneration;

  const THREE = window.THREE;
  if (!THREE) {
    log.error('three.js not loaded');
    return;
  }

  // Get MapShine state from global (set by bootstrap)
  let mapShine = window.MapShine;
  if (!mapShine || !mapShine.renderer) {
    // Try a lazy bootstrap as a recovery path
    log.warn('MapShine renderer missing, attempting lazy bootstrap...');
    try {
      const mod = await import('../core/bootstrap.js');
      const state = await mod.bootstrap({ verbose: false, skipSceneInit: true });
      Object.assign(window.MapShine, state);
      mapShine = window.MapShine;
    } catch (e) {
      log.error('Lazy bootstrap failed:', e);
      return;
    }
    if (isStale()) return;
    if (!mapShine.renderer) {
      log.error('Renderer still unavailable after lazy bootstrap. Aborting.');
      return;
    }
  }

  const lp = globalLoadingProfiler;
  const doLoadProfile = !!lp?.enabled;
  if (doLoadProfile) {
    try {
      lp.begin('sceneLoad', { sceneId: scene?.id ?? null, sceneName: scene?.name ?? null });
    } catch (e) {
    }
  }

  try {
    // Scene updates (like changing grid type/style) can momentarily put the Foundry canvas into
    // a partially-initialized state. Wait for it to be stable before we touch layers or
    // initialize ControlsIntegration.
    try {
      const ok = await _waitForFoundryCanvasReady({ timeoutMs: 15000 });
      if (!ok) {
        log.warn('Foundry canvas not ready after timeout; aborting MapShine scene init');
        return;
      }
    } catch (_) {
      // If the wait fails unexpectedly, continue; later steps may still succeed.
    }

    if (isStale()) return;

    try {
      loadingOverlay.showBlack(`Loading ${scene?.name || 'scene'}…`);
      loadingOverlay.configureStages([
        { id: 'assets', label: 'Loading assets…', weight: 30 },
        { id: 'effects', label: 'Initializing effects…', weight: 35 },
        { id: 'scene', label: 'Syncing scene…', weight: 20 },
        { id: 'final', label: 'Finalizing…', weight: 15 },
      ]);
      loadingOverlay.startStages();
      loadingOverlay.setStage('assets', 0.05, undefined, { immediate: true });
      loadingOverlay.startAutoProgress(0.08, 0.02);
    } catch (e) {
      log.debug('Loading overlay not available:', e);
    }

    // P0.3: Capture Foundry state before modifying it
    captureFoundryStateSnapshot();

    // Set default mode - actual canvas configuration happens after ControlsIntegration init
    isMapMakerMode = false; // Default to Gameplay Mode

    // Create new canvas element
    threeCanvas = document.createElement('canvas');
    threeCanvas.id = 'map-shine-canvas';
    threeCanvas.style.position = 'absolute';
    threeCanvas.style.top = '0';
    threeCanvas.style.left = '0';
    threeCanvas.style.width = '100%';
    threeCanvas.style.height = '100%';
    threeCanvas.style.zIndex = '1'; // Below PIXI (but PIXI is transparent, so Three.js shows through)
    threeCanvas.style.pointerEvents = 'auto'; // Three.js handles interaction in gameplay mode

    // Inject NEXT to Foundry's canvas (as sibling, not child)
    // #board is the PIXI canvas itself, not a container!
    const pixiCanvas = document.getElementById('board');
    if (!pixiCanvas) {
      log.error('Failed to find Foundry canvas (#board)');
      return;
    }
    
    // Configure PIXI canvas for hybrid mode immediately
    // ControlsIntegration will take over later, but we need this now to prevent black screen
    // Strategy: Three.js handles interaction in gameplay by default; PIXI starts as a
    // transparent overlay (no pointer events) and InputRouter/ControlsIntegration
    // enable PIXI input when edit tools are active.
    pixiCanvas.style.opacity = '1'; // Keep visible for overlay layers (drawings, templates, notes)
    pixiCanvas.style.zIndex = '10'; // On top
    pixiCanvas.style.pointerEvents = 'none'; // Pass pointer events to Three.js by default
    
    // CRITICAL: Set PIXI renderer background to transparent
    // Without this, the PIXI background color renders over Three.js content
    if (canvas.app?.renderer?.background) {
      canvas.app.renderer.background.alpha = 0;
      log.debug('PIXI renderer background alpha set to 0');
    }
    
    // Hide replaced PIXI layers immediately (background, grid, etc.)
    // These are rendered by Three.js, so they must be hidden
    if (canvas.background) canvas.background.visible = false;
    if (canvas.grid) canvas.grid.visible = false;
    if (canvas.primary) canvas.primary.visible = false;
    if (canvas.weather) canvas.weather.visible = false;
    if (canvas.environment) canvas.environment.visible = false;
    
    // CRITICAL: Tokens layer needs special handling
    // - Visual rendering is done by Three.js (TokenManager)
    // - But PIXI tokens must remain INTERACTIVE for clicks, HUD, selection, cursor
    // - We make token meshes TRANSPARENT (alpha=0) instead of invisible
    // - This keeps hit detection working while Three.js renders the visuals
    if (canvas.tokens) {
      canvas.tokens.visible = true; // Layer stays visible for interaction
      canvas.tokens.interactiveChildren = true;
      // Make tokens transparent - ControlsIntegration.hideReplacedLayers() handles this
      // more thoroughly after tokens are synced
      for (const token of canvas.tokens.placeables) {
        if (token.mesh) token.mesh.alpha = 0;
        if (token.icon) token.icon.alpha = 0;
        if (token.border) token.border.alpha = 0;
        token.visible = true;
        token.interactive = true;
      }
    }
    log.debug('Replaced PIXI layers hidden, tokens layer transparent but interactive');
    
    // Insert our canvas as a sibling, right after the PIXI canvas
    pixiCanvas.parentElement.insertBefore(threeCanvas, pixiCanvas.nextSibling);
    log.debug('Three.js canvas created and attached as sibling to PIXI canvas');

    // Get renderer from global state and attach its canvas
    renderer = mapShine.renderer;
    const rendererCanvas = renderer.domElement;

    // Resolve background colour from Foundry scene (fallback to Foundry default #999999)
    // scene.backgroundColor is a hex string like "#999999" in modern Foundry versions
    const sceneBgColorStr = (scene && typeof scene.backgroundColor === 'string' && scene.backgroundColor.trim().length > 0)
      ? scene.backgroundColor
      : '#999999';

    // Replace our placeholder with the renderer's actual canvas
    threeCanvas.replaceWith(rendererCanvas);
    rendererCanvas.id = 'map-shine-canvas';
    rendererCanvas.style.position = 'absolute';
    rendererCanvas.style.top = '0';
    rendererCanvas.style.left = '0';
    rendererCanvas.style.width = '100%';
    rendererCanvas.style.height = '100%';
    rendererCanvas.style.zIndex = '1'; // Below PIXI (but PIXI is transparent, so Three.js shows through)
    rendererCanvas.style.pointerEvents = 'auto'; // Three.js handles interaction in gameplay mode
    // Use Foundry's scene background colour so padded region matches core Foundry
    rendererCanvas.style.backgroundColor = sceneBgColorStr;

    threeCanvas = rendererCanvas; // Update reference
    const rect = threeCanvas.getBoundingClientRect();
    // Avoid setSize() overwriting our CSS sizing (width/height=100%).
    // If updateStyle=true, three will set style width/height to fixed pixel values,
    // preventing future container resizes from affecting the canvas element.
    _applyRenderResolutionToRenderer(rect.width, rect.height);

    try {
      renderer.setSize(rect.width, rect.height, false);
    } catch (_) {
      renderer.setSize(rect.width, rect.height);
    }

    // Robustness: Handle WebGL context loss/restoration.
    // Some UI operations or GPU resets can trigger a context loss; in that case we must
    // stop the RAF loop (otherwise we can wind up in a broken render state) and then
    // attempt to resume when the context restores.
    try {
      _webglContextLostHandler = (ev) => {
        try { ev.preventDefault(); } catch (_) {}
        log.warn('WebGL context lost - pausing render loop');
        try {
          if (renderLoop?.running()) renderLoop.stop();
        } catch (e) {
          log.warn('Failed to stop render loop after context loss', e);
        }
      };

      _webglContextRestoredHandler = () => {
        log.info('WebGL context restored - attempting to resume rendering');
        try {
          // Re-apply sizing to ensure internal buffers are sane.
          const r = threeCanvas?.getBoundingClientRect?.();
          if (r && renderer) {
            _applyRenderResolutionToRenderer(r.width, r.height);

            try {
              renderer.setSize(r.width, r.height, false);
            } catch (_) {
              renderer.setSize(r.width, r.height);
            }
            if (sceneComposer) sceneComposer.resize(r.width, r.height);
            if (effectComposer) {
              // EffectComposer expects drawing-buffer pixels.
              try {
                const THREE = window.THREE;
                const buf = (renderer && typeof renderer.getDrawingBufferSize === 'function' && THREE)
                  ? renderer.getDrawingBufferSize(new THREE.Vector2())
                  : null;
                effectComposer.resize(buf?.width ?? buf?.x ?? r.width, buf?.height ?? buf?.y ?? r.height);
              } catch (_) {
                effectComposer.resize(r.width, r.height);
              }
            }
          }
        } catch (e) {
          log.warn('Resize failed during context restore', e);
        }

        try {
          if (renderLoop && !renderLoop.running()) {
            renderLoop.start();
          }
        } catch (e) {
          log.warn('Failed to restart render loop after context restore', e);
        }
      };

      threeCanvas.addEventListener('webglcontextlost', _webglContextLostHandler, false);
      threeCanvas.addEventListener('webglcontextrestored', _webglContextRestoredHandler, false);
    } catch (e) {
      log.warn('Failed to register WebGL context loss handlers', e);
    }

    // Ensure regions outside the Foundry world bounds remain black; padded region is covered by a background plane
    if (renderer.setClearColor) {
      renderer.setClearColor(0x000000, 1);
    }

    // Step 1: Initialize scene composer
    sceneComposer = new SceneComposer();
    if (doLoadProfile) {
      try {
        lp.begin('sceneComposer.initialize');
      } catch (e) {
      }
    }
    const { scene: threeScene, camera, bundle } = await sceneComposer.initialize(
      scene,
      rect.width,
      rect.height,
      {
        onProgress: (loaded, total, asset) => {
          try {
            const denom = total > 0 ? total : 1;
            const v = Math.max(0, Math.min(1, loaded / denom));
            loadingOverlay.setStage('assets', v, `Loading ${asset}…`, { keepAuto: true });
          } catch (e) {
            // Ignore overlay errors
          }
        }
      }
    );
    if (doLoadProfile) {
      try {
        lp.end('sceneComposer.initialize');
      } catch (e) {
      }
    }

    if (isStale()) {
      try {
        destroyThreeCanvas();
      } catch (e) {
      }
      return;
    }

    log.info(`Scene composer initialized with ${bundle.masks.length} effect masks`);

    // CRITICAL: Expose sceneComposer early so effects can access groundZ during initialization
    mapShine.sceneComposer = sceneComposer;

    mapShine.maskManager = new MaskManager();
    mapShine.maskManager.setRenderer(renderer);
    try {
      const mm = mapShine.maskManager;
      if (mm && bundle?.masks && Array.isArray(bundle.masks)) {
        for (const m of bundle.masks) {
          if (!m || !m.id || !m.texture) continue;
          mm.setTexture(`${m.id}.scene`, m.texture, {
            space: 'sceneUv',
            source: 'assetMask',
            colorSpace: m.texture.colorSpace ?? null,
            uvFlipY: m.texture.flipY ?? null,
            lifecycle: 'staticPerScene'
          });
        }
      }

      if (mm && typeof mm.defineDerivedMask === 'function') {
        mm.defineDerivedMask('indoor.scene', { op: 'invert', input: 'outdoors.scene' });
        mm.defineDerivedMask('roofVisible.screen', { op: 'threshold', input: 'roofAlpha.screen', lo: 0.05, hi: 0.15 });
        mm.defineDerivedMask('roofClear.screen', { op: 'invert', input: 'roofVisible.screen' });
        mm.defineDerivedMask('precipVisibility.screen', { op: 'max', a: 'outdoors.screen', b: 'roofClear.screen' });
      }
    } catch (e) {
      log.warn('Failed to initialize MaskManager registry for bundle masks:', e);
    }

    // Wire the _Outdoors (roof/indoor) mask into the WeatherController so
    // precipitation effects (rain, snow, puddles) can respect covered areas.
    try {
      if (bundle?.masks?.length) {
        const outdoorsMask = bundle.masks.find(m => m.id === 'outdoors' || m.type === 'outdoors');
        if (outdoorsMask?.texture && weatherController?.setRoofMap) {
          weatherController.setRoofMap(outdoorsMask.texture);
          log.info('WeatherController roof map set from _Outdoors mask texture');
        } else {
          log.debug('No _Outdoors mask texture found for this scene');
        }
      }
    } catch (e) {
      log.warn('Failed to apply _Outdoors roof mask to WeatherController:', e);
    }

    // Step 2: Initialize effect composer
    effectComposer = new EffectComposer(renderer, threeScene, camera);
    effectComposer.initialize(mapShine.capabilities);

    // Ensure TimeManager immediately matches Foundry's current pause state.
    try {
      const paused = game?.paused ?? false;
      effectComposer.getTimeManager()?.setFoundryPaused?.(paused, 0);
    } catch (e) {
      // Ignore
    }

    try {
      loadingOverlay.setStage('effects', 0.0, 'Initializing effects…', { immediate: true });
      loadingOverlay.startAutoProgress(0.55, 0.015);
    } catch (e) {
      // Ignore overlay errors
    }

    let _effectInitIndex = 0;
    const _effectInitTotal = 31;
    const _setEffectInitStep = (label) => {
      _effectInitIndex++;
      const t = Math.max(0, Math.min(1, _effectInitIndex / _effectInitTotal));
      try {
        loadingOverlay.setStage('effects', t, `Initializing ${label}…`, { keepAuto: true });
      } catch (e) {
        // Ignore overlay errors
      }
    };

    // Ensure WeatherController is initialized and driven by the centralized TimeManager.
    // This allows precipitation, wind, etc. to update every frame and drive GPU effects
    // like the particle-based weather system without requiring manual console snippets.
    await weatherController.initialize();

    try {
      effectComposer.addUpdatable(weatherController);
    } catch (_) {
    }

    try {
      loadingOverlay.setStage('effects', 0.02, 'Initializing weather…', { keepAuto: true });
    } catch (e) {
      // Ignore overlay errors
    }

    if (isStale()) {
      try {
        destroyThreeCanvas();
      } catch (e) {
      }
      return;
    }

    // P1.2: Parallel Effect Initialization (Conservative Two-Phase Approach)
    // Phase 1: Register independent effects in parallel (no inter-effect dependencies)
    const independentEffects = [];
    
    const registerIndependentEffect = async (name, EffectClass) => {
      _setEffectInitStep(name);
      const effect = new EffectClass();
      await effectComposer.registerEffect(effect);
      return { name, effect };
    };

    const independentPromises = [
      registerIndependentEffect('Specular', SpecularEffect),
      registerIndependentEffect('Iridescence', IridescenceEffect),
      registerIndependentEffect('Window Lights', WindowLightEffect),
      registerIndependentEffect('Color Correction', ColorCorrectionEffect),
      registerIndependentEffect('Film Grain', FilmGrainEffect),
      registerIndependentEffect('Dot Screen', DotScreenEffect),
      registerIndependentEffect('Halftone', HalftoneEffect),
      registerIndependentEffect('Sharpen', SharpenEffect),
      registerIndependentEffect('ASCII', AsciiEffect),
      registerIndependentEffect('Smelly Flies', SmellyFliesEffect),
      registerIndependentEffect('Lightning', LightningEffect),
      registerIndependentEffect('Prism', PrismEffect),
      registerIndependentEffect('Water', WaterEffectV2),
      registerIndependentEffect('Fog', WorldSpaceFogEffect),
      registerIndependentEffect('Bushes', BushEffect),
      registerIndependentEffect('Trees', TreeEffect),
      registerIndependentEffect('Overhead Shadows', OverheadShadowsEffect),
      registerIndependentEffect('Building Shadows', BuildingShadowsEffect),
      registerIndependentEffect('Clouds', CloudEffect),
      registerIndependentEffect('Atmospheric Fog', AtmosphericFogEffect),
      registerIndependentEffect('Distortion', DistortionManager),
      registerIndependentEffect('Bloom', BloomEffect),
      registerIndependentEffect('Lensflare', LensflareEffect),
      registerIndependentEffect('Mask Debug', MaskDebugEffect),
      registerIndependentEffect('Debug Layers', DebugLayerEffect),
      registerIndependentEffect('Player Lights', PlayerLightEffect),
      registerIndependentEffect('Sky Color', SkyColorEffect)
    ];

    const independentResults = await Promise.all(independentPromises);
    const effectMap = new Map(independentResults.map(r => [r.name, r.effect]));

    const specularEffect = effectMap.get('Specular');
    const iridescenceEffect = effectMap.get('Iridescence');
    const windowLightEffect = effectMap.get('Window Lights');
    const colorCorrectionEffect = effectMap.get('Color Correction');
    const filmGrainEffect = effectMap.get('Film Grain');
    const dotScreenEffect = effectMap.get('Dot Screen');
    const halftoneEffect = effectMap.get('Halftone');
    const sharpenEffect = effectMap.get('Sharpen');
    const asciiEffect = effectMap.get('ASCII');
    const smellyFliesEffect = effectMap.get('Smelly Flies');
    const lightningEffect_temp = effectMap.get('Lightning');
    const prismEffect = effectMap.get('Prism');
    const waterEffect = effectMap.get('Water');
    const fogEffect_temp = effectMap.get('Fog');
    const bushEffect = effectMap.get('Bushes');
    const treeEffect = effectMap.get('Trees');
    const overheadShadowsEffect = effectMap.get('Overhead Shadows');
    const buildingShadowsEffect = effectMap.get('Building Shadows');
    const cloudEffect = effectMap.get('Clouds');
    const atmosphericFogEffect = effectMap.get('Atmospheric Fog');
    const distortionManager = effectMap.get('Distortion');
    const bloomEffect = effectMap.get('Bloom');
    const lensflareEffect = effectMap.get('Lensflare');
    const maskDebugEffect = effectMap.get('Mask Debug');
    const debugLayerEffect = effectMap.get('Debug Layers');
    const playerLightEffect = effectMap.get('Player Lights');
    const skyColorEffect_temp = effectMap.get('Sky Color');

    // --- Graphics Settings (Essential Feature) ---
    // Create once per canvas lifecycle, register known effects, and expose globally.
    try {
      if (!effectCapabilitiesRegistry) effectCapabilitiesRegistry = new EffectCapabilitiesRegistry();

      // Minimal first-pass: enabled toggles only. We will extend to intensity+subfeatures per effect.
      effectCapabilitiesRegistry.register({ effectId: 'specular', displayName: 'Metallic / Specular', category: 'surface', performanceImpact: 'medium' });
      effectCapabilitiesRegistry.register({ effectId: 'iridescence', displayName: 'Iridescence / Holographic', category: 'surface', performanceImpact: 'medium' });
      effectCapabilitiesRegistry.register({ effectId: 'water', displayName: 'Water', category: 'water', performanceImpact: 'high' });
      effectCapabilitiesRegistry.register({ effectId: 'fog', displayName: 'Fog of War', category: 'global', performanceImpact: 'medium' });
      effectCapabilitiesRegistry.register({ effectId: 'bloom', displayName: 'Bloom', category: 'global', performanceImpact: 'high' });
      effectCapabilitiesRegistry.register({ effectId: 'lensflare', displayName: 'Lensflare', category: 'global', performanceImpact: 'medium' });
      effectCapabilitiesRegistry.register({ effectId: 'clouds', displayName: 'Clouds', category: 'atmospheric', performanceImpact: 'medium' });
      effectCapabilitiesRegistry.register({ effectId: 'overhead-shadows', displayName: 'Overhead Shadows', category: 'structure', performanceImpact: 'medium' });
      effectCapabilitiesRegistry.register({ effectId: 'building-shadows', displayName: 'Building Shadows', category: 'structure', performanceImpact: 'medium' });
      effectCapabilitiesRegistry.register({ effectId: 'distortion', displayName: 'Distortion', category: 'global', performanceImpact: 'medium' });
      effectCapabilitiesRegistry.register({ effectId: 'fire-sparks', displayName: 'Fire & Embers', category: 'particle', performanceImpact: 'high' });
      effectCapabilitiesRegistry.register({ effectId: 'dust-motes', displayName: 'Dust Motes', category: 'particle', performanceImpact: 'low' });
      effectCapabilitiesRegistry.register({ effectId: 'smelly-flies', displayName: 'Smelly Flies', category: 'particle', performanceImpact: 'low' });
      effectCapabilitiesRegistry.register({ effectId: 'lightning', displayName: 'Lightning', category: 'particle', performanceImpact: 'medium' });
      effectCapabilitiesRegistry.register({ effectId: 'atmospheric-fog', displayName: 'Atmospheric Fog', category: 'atmospheric', performanceImpact: 'medium' });
      effectCapabilitiesRegistry.register({ effectId: 'ascii', displayName: 'ASCII', category: 'global', performanceImpact: 'high' });
      effectCapabilitiesRegistry.register({ effectId: 'halftone', displayName: 'Halftone', category: 'global', performanceImpact: 'medium' });
      effectCapabilitiesRegistry.register({ effectId: 'dot-screen', displayName: 'Dot Screen', category: 'global', performanceImpact: 'medium' });
      effectCapabilitiesRegistry.register({ effectId: 'film-grain', displayName: 'Film Grain', category: 'global', performanceImpact: 'low' });
      effectCapabilitiesRegistry.register({ effectId: 'color-correction', displayName: 'Color Correction', category: 'global', performanceImpact: 'low' });
      effectCapabilitiesRegistry.register({ effectId: 'sharpen', displayName: 'Sharpen', category: 'global', performanceImpact: 'low' });
      effectCapabilitiesRegistry.register({ effectId: 'prism', displayName: 'Prism / Refraction', category: 'surface', performanceImpact: 'medium' });
      effectCapabilitiesRegistry.register({ effectId: 'sky-color', displayName: 'Sky Color', category: 'global', performanceImpact: 'low' });
      effectCapabilitiesRegistry.register({ effectId: 'player-light', displayName: 'Player Lights', category: 'global', performanceImpact: 'low' });
      effectCapabilitiesRegistry.register({ effectId: 'window-light', displayName: 'Window Lights', category: 'surface', performanceImpact: 'low' });
      effectCapabilitiesRegistry.register({ effectId: 'trees', displayName: 'Animated Trees (Canopy)', category: 'surface', performanceImpact: 'medium' });
      effectCapabilitiesRegistry.register({ effectId: 'bushes', displayName: 'Animated Bushes', category: 'surface', performanceImpact: 'medium' });
      effectCapabilitiesRegistry.register({ effectId: 'candle-flames', displayName: 'Candle Flames', category: 'particle', performanceImpact: 'low' });
      effectCapabilitiesRegistry.register({ effectId: 'lighting', displayName: 'Lighting', category: 'global', performanceImpact: 'high' });
    } catch (e) {
      log.warn('Failed to register effect capabilities (Graphics Settings)', e);
    }

    try {
      if (!graphicsSettings) {
        graphicsSettings = new GraphicsSettingsManager(effectComposer, effectCapabilitiesRegistry, {
          onApplyRenderResolution: () => {
            try {
              if (!threeCanvas) return;
              const rect = threeCanvas.getBoundingClientRect();
              resize(rect.width, rect.height);
            } catch (_) {
            }
          }
        });
        await graphicsSettings.initialize();
        if (window.MapShine) window.MapShine.graphicsSettings = graphicsSettings;
      }

      // Wire instances so the manager can toggle safely.
      graphicsSettings.registerEffectInstance('specular', specularEffect);
      graphicsSettings.registerEffectInstance('iridescence', iridescenceEffect);
      graphicsSettings.registerEffectInstance('window-light', windowLightEffect);
      graphicsSettings.registerEffectInstance('color-correction', colorCorrectionEffect);
      graphicsSettings.registerEffectInstance('film-grain', filmGrainEffect);
      graphicsSettings.registerEffectInstance('dot-screen', dotScreenEffect);
      graphicsSettings.registerEffectInstance('halftone', halftoneEffect);
      graphicsSettings.registerEffectInstance('sharpen', sharpenEffect);
      graphicsSettings.registerEffectInstance('ascii', asciiEffect);
      graphicsSettings.registerEffectInstance('smelly-flies', smellyFliesEffect);
      graphicsSettings.registerEffectInstance('lightning', lightningEffect_temp);
      graphicsSettings.registerEffectInstance('prism', prismEffect);
      graphicsSettings.registerEffectInstance('water', waterEffect);
      graphicsSettings.registerEffectInstance('fog', fogEffect_temp);
      graphicsSettings.registerEffectInstance('bushes', bushEffect);
      graphicsSettings.registerEffectInstance('trees', treeEffect);
      graphicsSettings.registerEffectInstance('overhead-shadows', overheadShadowsEffect);
      graphicsSettings.registerEffectInstance('building-shadows', buildingShadowsEffect);
      graphicsSettings.registerEffectInstance('clouds', cloudEffect);
      graphicsSettings.registerEffectInstance('atmospheric-fog', atmosphericFogEffect);
      graphicsSettings.registerEffectInstance('distortion', distortionManager);
      graphicsSettings.registerEffectInstance('bloom', bloomEffect);
      graphicsSettings.registerEffectInstance('lensflare', lensflareEffect);
      graphicsSettings.registerEffectInstance('player-light', playerLightEffect);
      graphicsSettings.registerEffectInstance('sky-color', skyColorEffect_temp);
    } catch (e) {
      log.warn('Failed to initialize/wire Graphics Settings manager', e);
    }

    // Assign to module-level variables for later reference
    lightningEffect = lightningEffect_temp;
    fogEffect = fogEffect_temp;
    skyColorEffect = skyColorEffect_temp;

    // Wire up window light effect
    if (window.MapShine) window.MapShine.windowLightEffect = windowLightEffect;
    if (window.MapShine) window.MapShine.cloudEffect = cloudEffect;
    if (window.MapShine) window.MapShine.atmosphericFogEffect = atmosphericFogEffect;
    if (window.MapShine) window.MapShine.distortionManager = distortionManager;
    if (window.MapShine) window.MapShine.bloomEffect = bloomEffect;

    // Phase 2: Register dependent effects sequentially (must maintain order)
    // Step 3.8: Register Particle System (must be before FireSparksEffect)
    _setEffectInitStep('Particles');
    const particleSystem = new ParticleSystem();
    await effectComposer.registerEffect(particleSystem);

    // Step 3.9: Register Fire Sparks Effect (depends on ParticleSystem)
    _setEffectInitStep('Fire');
    const fireSparksEffect = new FireSparksEffect();
    fireSparksEffect.setParticleSystem(particleSystem);
    await effectComposer.registerEffect(fireSparksEffect);
    if (bundle) {
      fireSparksEffect.setAssetBundle(bundle);
    }

    try {
      graphicsSettings?.registerEffectInstance('fire-sparks', fireSparksEffect);
      graphicsSettings?.applyOverrides?.();
    } catch (_) {
    }

    // Step 3.10: Register Dust Motes (can use particle system if needed)
    _setEffectInitStep('Dust Motes');
    const dustMotesEffect = new DustMotesEffect();
    await effectComposer.registerEffect(dustMotesEffect);
    if (bundle) {
      dustMotesEffect.setAssetBundle(bundle);
    }

    try {
      graphicsSettings?.registerEffectInstance('dust-motes', dustMotesEffect);
      graphicsSettings?.applyOverrides?.();
    } catch (_) {
    }

    // Step 3.14: Register Lighting Effect (must be before CandleFlamesEffect)
    _setEffectInitStep('Lighting');
    lightingEffect = new LightingEffect();
    await effectComposer.registerEffect(lightingEffect);
    if (window.MapShine) window.MapShine.lightingEffect = lightingEffect;

    try {
      graphicsSettings?.registerEffectInstance('lighting', lightingEffect);
      graphicsSettings?.applyOverrides?.();
    } catch (_) {
    }

    // Step 3.15: Register Candle Flames (depends on LightingEffect)
    _setEffectInitStep('Candle Flames');
    const candleFlamesEffect = new CandleFlamesEffect();
    candleFlamesEffect.setLightingEffect(lightingEffect);
    await effectComposer.registerEffect(candleFlamesEffect);
    if (window.MapShine) window.MapShine.candleFlamesEffect = candleFlamesEffect;

    try {
      graphicsSettings?.registerEffectInstance('candle-flames', candleFlamesEffect);
      graphicsSettings?.applyOverrides?.();
    } catch (_) {
    }

    if (isStale()) {
      try {
        destroyThreeCanvas();
      } catch (e) {
      }
      return;
    }

    // Provide the base mesh and asset bundle to the effect
    const basePlane = sceneComposer.getBasePlane();

    const _safeSetBaseMesh = (label, fn) => {
      try {
        fn();
      } catch (e) {
        log.error(`Failed to wire base mesh for ${label}`, e);
      }
    };

    _safeSetBaseMesh('Specular', () => specularEffect?.setBaseMesh?.(basePlane, bundle));
    _safeSetBaseMesh('Iridescence', () => iridescenceEffect?.setBaseMesh?.(basePlane, bundle));
    _safeSetBaseMesh('Prism', () => prismEffect?.setBaseMesh?.(basePlane, bundle));
    _safeSetBaseMesh('Water', () => waterEffect?.setBaseMesh?.(basePlane, bundle));
    _safeSetBaseMesh('Window Lights', () => windowLightEffect?.setBaseMesh?.(basePlane, bundle));
    _safeSetBaseMesh('Window Lights Target', () => windowLightEffect?.createLightTarget?.());
    _safeSetBaseMesh('Bushes', () => bushEffect?.setBaseMesh?.(basePlane, bundle));
    _safeSetBaseMesh('Trees', () => treeEffect?.setBaseMesh?.(basePlane, bundle));
    _safeSetBaseMesh('Lighting', () => lightingEffect?.setBaseMesh?.(basePlane, bundle));
    _safeSetBaseMesh('Overhead Shadows', () => overheadShadowsEffect?.setBaseMesh?.(basePlane, bundle));
    _safeSetBaseMesh('Building Shadows', () => buildingShadowsEffect?.setBaseMesh?.(basePlane, bundle));
    _safeSetBaseMesh('Clouds', () => cloudEffect?.setBaseMesh?.(basePlane, bundle));

    try {
      loadingOverlay.setStage('scene', 0.0, 'Syncing scene…', { immediate: true });
      loadingOverlay.startAutoProgress(0.85, 0.012);
    } catch (e) {
      // Ignore overlay errors
    }

    if (isStale()) {
      try {
        destroyThreeCanvas();
      } catch (e) {
      }
      return;
    }

    // Step 3b: Initialize grid renderer
    gridRenderer = new GridRenderer(threeScene);
    gridRenderer.initialize();
    gridRenderer.updateGrid();
    try {
      if (effectComposer) effectComposer.addUpdatable(gridRenderer);
    } catch (_) {
    }
    log.info('Grid renderer initialized');

    try {
      loadingOverlay.setStage('scene', 0.15, 'Syncing grid…', { keepAuto: true });
    } catch (_) {}

    // Step 4: Initialize token manager
    tokenManager = new TokenManager(threeScene);
    tokenManager.setEffectComposer(effectComposer); // Connect to main loop
    tokenManager.initialize();
    
    // Sync existing tokens immediately (we're already in canvasReady, so the hook won't fire)
    tokenManager.syncAllTokens();
    log.info('Token manager initialized and synced');

    try {
      loadingOverlay.setStage('scene', 0.35, 'Syncing tokens…', { keepAuto: true });
    } catch (_) {}

    // Step 4b: Initialize tile manager
    tileManager = new TileManager(threeScene);
    tileManager.setSpecularEffect(specularEffect);
    // Route water occluder meshes into DistortionManager's dedicated scene so
    // the occluder render pass avoids traversing the full world scene.
    try {
      tileManager.setWaterOccluderScene(distortionManager?.waterOccluderScene ?? null);
    } catch (_) {}
    tileManager.initialize();
    tileManager.syncAllTiles();
    tileManager.setWindowLightEffect(windowLightEffect); // Link for overhead tile lighting
    effectComposer.addUpdatable(tileManager); // Register for occlusion updates
    log.info('Tile manager initialized and synced');

    try {
      loadingOverlay.setStage('scene', 0.55, 'Syncing tiles…', { keepAuto: true });
    } catch (_) {}

    surfaceRegistry = new SurfaceRegistry();
    surfaceRegistry.initialize({ sceneComposer, tileManager });
    mapShine.surfaceRegistry = surfaceRegistry;
    mapShine.surfaceReport = surfaceRegistry.refresh();

    // Step 4c: Initialize wall manager
    wallManager = new WallManager(threeScene);
    wallManager.initialize();
    // Sync happens in initialize
    log.info('Wall manager initialized');

    try {
      loadingOverlay.setStage('scene', 0.65, 'Syncing walls…', { keepAuto: true });
    } catch (_) {}

    // Step 4c.1: Initialize door mesh manager (animated door graphics)
    doorMeshManager = new DoorMeshManager(threeScene, sceneComposer.camera);
    doorMeshManager.initialize();
    effectComposer.addUpdatable(doorMeshManager); // Register for animation updates
    log.info('Door mesh manager initialized');

    // Step 4d: Initialize drawing manager (Three.js drawings)
    drawingManager = new DrawingManager(threeScene);
    drawingManager.initialize();
    log.info('Drawing manager initialized');

    // Step 4e: Initialize note manager
    noteManager = new NoteManager(threeScene);
    noteManager.initialize();
    log.info('Note manager initialized');

    // Step 4f: Initialize template manager
    templateManager = new TemplateManager(threeScene);
    templateManager.initialize();
    log.info('Template manager initialized');

    // Step 4g: Initialize light icon manager
    lightIconManager = new LightIconManager(threeScene);
    lightIconManager.initialize();
    log.info('Light icon manager initialized');

    // Step 4g.5: Initialize MapShine enhanced light icon manager
    enhancedLightIconManager = new EnhancedLightIconManager(threeScene);
    enhancedLightIconManager.initialize();
    log.info('Enhanced light icon manager initialized');

    // Step 4h: Initialize map points manager (v1.x backwards compatibility)
    mapPointsManager = new MapPointsManager(threeScene);
    await mapPointsManager.initialize();
    log.info('Map points manager initialized');

    // Wire map points to particle effects (fire, candle flame, smelly flies, etc.)
    if (fireSparksEffect && mapPointsManager.groups.size > 0) {
      fireSparksEffect.setMapPointsSources(mapPointsManager);
      log.info('Map points wired to fire effect');
    }
    
    // Wire smelly flies to map points (always wire, even if no groups yet - it listens for changes)
    if (smellyFliesEffect) {
      smellyFliesEffect.setMapPointsSources(mapPointsManager);
      log.info('Map points wired to smelly flies effect');
    }

    if (lightningEffect) {
      lightningEffect.setMapPointsSources(mapPointsManager);
      log.info('Map points wired to lightning effect');
    }

    if (candleFlamesEffect) {
      candleFlamesEffect.setMapPointsSources(mapPointsManager);
      log.info('Map points wired to candle flames effect');
    }

    // Step 4i: Initialize physics ropes (rope/chain map points)
    physicsRopeManager = new PhysicsRopeManager(threeScene, sceneComposer, mapPointsManager);
    physicsRopeManager.initialize();
    effectComposer.addUpdatable(physicsRopeManager);
    mapShine.physicsRopeManager = physicsRopeManager;
    log.info('Physics rope manager initialized');

    // Step 5: Initialize interaction manager (Selection, Drag/Drop)
    interactionManager = new InteractionManager(threeCanvas, sceneComposer, tokenManager, tileManager, wallManager, lightIconManager);
    interactionManager.initialize();
    effectComposer.addUpdatable(interactionManager); // Register for updates (HUD positioning)
    log.info('Interaction manager initialized');

    // Sync Selection Box UI params (loaded from scene settings) into the InteractionManager.
    // initializeUI() runs earlier during startup, before InteractionManager exists.
    try {
      const sel = uiManager?.effectFolders?.selectionBox;
      const params = sel?.params;
      if (params && typeof params === 'object') {
        for (const [k, v] of Object.entries(params)) {
          if (typeof interactionManager.applySelectionBoxParamChange === 'function') {
            interactionManager.applySelectionBoxParamChange(k, v);
          }
        }
      }
    } catch (_) {
    }

    // Ensure Foundry's native PIXI selection rectangle is suppressed in Gameplay mode.
    // (In Map Maker mode, we want the native selection box.)
    _updateFoundrySelectRectSuppression();

    // Step 5b: Initialize DOM overlay UI system (world-anchored overlays, ring UI)
    overlayUIManager = new OverlayUIManager(threeCanvas, sceneComposer);
    overlayUIManager.initialize();
    effectComposer.addUpdatable(overlayUIManager);

    lightRingUI = new LightRingUI(overlayUIManager);
    lightRingUI.initialize();

    lightAnimDialog = new LightAnimDialog(overlayUIManager);
    lightAnimDialog.initialize();

    try {
      effectComposer.addUpdatable(lightRingUI);
    } catch (_) {
    }

    try {
      effectComposer.addUpdatable(lightAnimDialog);
    } catch (_) {
    }

    // Expose for InteractionManager selection routing and debugging.
    if (window.MapShine) {
      window.MapShine.overlayUIManager = overlayUIManager;
      window.MapShine.lightRingUI = lightRingUI;
      window.MapShine.lightAnimDialog = lightAnimDialog;
    }

    // Step 6: Initialize drop handler (for creating new items)
    dropHandler = new DropHandler(threeCanvas, sceneComposer);
    dropHandler.initialize();
    log.info('Drop handler initialized');

    // Step 6: Initialize Camera Follower
    // Simple one-way sync: Three.js camera follows PIXI camera each frame.
    // PIXI/Foundry handles all pan/zoom input - we just read and match.
    // This eliminates bidirectional sync issues and race conditions.
    cameraFollower = new CameraFollower({ sceneComposer });
    cameraFollower.initialize();
    effectComposer.addUpdatable(cameraFollower); // Per-frame sync
    log.info('Camera follower initialized - Three.js follows PIXI');

    // Step 6a: Initialize PIXI Input Bridge
    // Handles pan/zoom input on Three canvas and applies to PIXI stage.
    // CameraFollower then reads PIXI state and updates Three camera.
    pixiInputBridge = new PixiInputBridge(threeCanvas);
    pixiInputBridge.initialize();
    log.info('PIXI input bridge initialized - pan/zoom updates PIXI stage');

    // Step 6b: Initialize controls integration (PIXI overlay system)
    controlsIntegration = new ControlsIntegration({ 
      sceneComposer,
      effectComposer
    });
    {
      const ok = await controlsIntegration.initialize();
      if (!ok) throw new Error('ControlsIntegration initialization failed');
    }
    
    log.info('Controls integration initialized');

    try {
      loadingOverlay.setStage('final', 0.0, 'Finalizing…', { immediate: true });
      loadingOverlay.startAutoProgress(0.98, 0.01);
    } catch (e) {
      // Ignore overlay errors
    }

    // Step 7: Ensure Foundry UI layers are above our canvas
    ensureUILayering();

    // Step 8: Start render loop
    renderLoop = new RenderLoop(renderer, threeScene, camera, effectComposer);
    renderLoop.start();

    log.info('Render loop started');

    // Step 8.5: Set up resize handling
    setupResizeHandling();

    // P0.4: Set up WebGL context loss/restore handlers
    // On context restore, trigger full scene rebuild to recreate GPU resources
    if (threeCanvas) {
      threeCanvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        log.warn('P0.4: WebGL context lost - pausing render loop');
        if (renderLoop && renderLoop.running()) {
          renderLoop.stop();
        }
      }, false);

      threeCanvas.addEventListener('webglcontextrestored', () => {
        log.info('P0.4: WebGL context restored - rebuilding scene');
        // Trigger full scene rebuild to recreate render targets and re-upload textures
        resetScene(canvas.scene);
      }, false);
    }

    // Step 9: Initialize Frame Coordinator for PIXI/Three.js synchronization
    // This hooks into Foundry's ticker to ensure we render after PIXI updates complete
    if (!frameCoordinatorInitialized) {
      frameCoordinatorInitialized = frameCoordinator.initialize();
      if (frameCoordinatorInitialized) {
        // Register fog effect for synchronized texture extraction
        frameCoordinator.onPostPixi((frameState) => {
          // fogEffect may be null during teardown or if initialization failed;
          // in that case, just skip fog work for this frame.
          const fog = fogEffect;
          if (!fog) return;

          // Force vision update when needed so fog textures are current
          // before Three.js renders.
          if (fog._needsVisionUpdate) {
            fog._renderVisionMask();
          }
        });
        
        log.info('Frame coordinator initialized - PIXI/Three.js sync enabled');
      } else {
        log.warn('Frame coordinator failed to initialize - fog may lag during rapid camera movement');
      }
    }
    mapShine.frameCoordinator = frameCoordinator;

    // Ensure MapShine fog exploration resets when Foundry fog is reset via UI (Lighting controls).
    // Foundry's reset button calls canvas.fog.reset(), which triggers canvas.fog._handleReset() on clients.
    // Our WorldSpaceFogEffect keeps its own GPU exploration history, so we must clear it explicitly.
    try {
      const fogMgr = canvas?.fog;
      if (fogMgr && typeof fogMgr._handleReset === 'function' && !fogMgr._mapShineWrappedHandleReset) {
        const originalHandleReset = fogMgr._handleReset.bind(fogMgr);
        fogMgr._handleReset = async (...args) => {
          const result = await originalHandleReset(...args);
          try {
            const fog = window.MapShine?.fogEffect;
            if (fog && typeof fog.resetExploration === 'function') {
              fog.resetExploration();
            }
          } catch (_) {
            // Ignore
          }
          return result;
        };
        fogMgr._mapShineWrappedHandleReset = true;
      }

      // IMPORTANT:
      // Foundry's FogManager.commit() schedules a *privately stored* debounced save function
      // (bound during FogManager.initialize()). Wrapping fogMgr.save is not sufficient because
      // commit() can still trigger the original internal save path, which performs texture
      // extraction + worker compression. If our Three.js fog replacement is active, we want
      // to fully prevent Foundry from attempting to persist fog exploration.
      if (fogMgr && typeof fogMgr.commit === 'function' && !fogMgr._mapShineWrappedCommit) {
        const originalCommit = fogMgr.commit.bind(fogMgr);
        fogMgr.commit = (...args) => {
          try {
            // In Map Maker mode, PIXI is the authoritative renderer; allow Foundry fog to work normally.
            if (isMapMakerMode) return originalCommit(...args);

            // In Gameplay mode with MapShine fog enabled, MapShine owns exploration persistence.
            const fog = window.MapShine?.fogEffect;
            if (fog && fog.params?.enabled !== false) {
              return;
            }

            // Otherwise, fall back to Foundry's native behavior.
            return originalCommit(...args);
          } catch (_) {
            return;
          }
        };
        fogMgr._mapShineWrappedCommit = true;
      }

      if (fogMgr && typeof fogMgr.save === 'function' && !fogMgr._mapShineWrappedSave) {
        const originalSave = fogMgr.save.bind(fogMgr);
        fogMgr.save = async (...args) => {
          try {
            const fog = window.MapShine?.fogEffect;
            if (fog && fog.params?.enabled !== false) {
              return;
            }
            if (isMapMakerMode) {
              return;
            }
            return await originalSave(...args);
          } catch (_) {
            return;
          }
        };
        fogMgr._mapShineWrappedSave = true;
      }
    } catch (_) {
      // Ignore
    }

    // Expose for diagnostics (after render loop is created)
    mapShine.sceneComposer = sceneComposer;
    mapShine.effectComposer = effectComposer;
    mapShine.specularEffect = specularEffect;
    mapShine.iridescenceEffect = iridescenceEffect;
    mapShine.windowLightEffect = windowLightEffect;
    mapShine.bushEffect = bushEffect;
    mapShine.treeEffect = treeEffect;
    mapShine.overheadShadowsEffect = overheadShadowsEffect;
    mapShine.buildingShadowsEffect = buildingShadowsEffect;
    mapShine.smellyFliesEffect = smellyFliesEffect; // Smart particle swarms
    mapShine.dustMotesEffect = dustMotesEffect;
    mapShine.lightningEffect = lightningEffect;
    mapShine.waterEffect = waterEffect;
    mapShine.fogEffect = fogEffect; // Fog of War (world-space plane mesh)
    mapShine.skyColorEffect = skyColorEffect; // NEW: Expose SkyColorEffect
    mapShine.distortionManager = distortionManager;
    mapShine.debugLayerEffect = debugLayerEffect;
    mapShine.playerLightEffect = playerLightEffect;
    mapShine.cameraFollower = cameraFollower; // Three.js camera follows PIXI
    mapShine.pixiInputBridge = pixiInputBridge; // Pan/zoom input bridge
    mapShine.tokenManager = tokenManager; // NEW: Expose token manager for diagnostics
    mapShine.tileManager = tileManager; // NEW: Expose tile manager for diagnostics
    mapShine.wallManager = wallManager; // NEW: Expose wall manager
    mapShine.doorMeshManager = doorMeshManager; // Animated door graphics
    mapShine.drawingManager = drawingManager; // NEW: Expose drawing manager
    mapShine.noteManager = noteManager;
    mapShine.templateManager = templateManager;
    mapShine.lightIconManager = lightIconManager;
    mapShine.enhancedLightIconManager = enhancedLightIconManager;
    mapShine.enhancedLightInspector = enhancedLightInspector; // NEW: Expose enhanced light inspector
    mapShine.interactionManager = interactionManager; // NEW: Expose interaction manager
    mapShine.overlayUIManager = overlayUIManager;
    mapShine.lightRingUI = lightRingUI;
    mapShine.lightAnimDialog = lightAnimDialog;
    mapShine.gridRenderer = gridRenderer; // NEW: Expose grid renderer
    mapShine.mapPointsManager = mapPointsManager; // NEW: Expose map points manager
    mapShine.weatherController = weatherController; // NEW: Expose weather controller
    mapShine.renderLoop = renderLoop; // CRITICAL: Expose render loop for diagnostics
    mapShine.sceneDebug = sceneDebug; // NEW: Expose scene debug helpers

    // Dev authoring API for MapShine-native enhanced lights (scene-flag stored).
    // This intentionally ships as a lightweight console tool until a full in-world editor
    // is implemented.
    try {
      mapShine.enhancedLights = createEnhancedLightsApi();
    } catch (_) {
      mapShine.enhancedLights = null;
    }

    mapShine.setMapMakerMode = setMapMakerMode; // NEW: Expose mode toggle for UI
    mapShine.resetScene = resetScene;
    // Expose current mode state so other systems (ControlsIntegration, effects) can query it.
    // This must be set even if the user never toggles Map Maker mode.
    mapShine.isMapMakerMode = isMapMakerMode;
    mapShine.controlsIntegration = controlsIntegration; // NEW: Expose controls integration
    // Expose sub-systems for debugging
    if (controlsIntegration) {
      mapShine.cameraSync = controlsIntegration.cameraSync; // May be null now
      mapShine.inputRouter = controlsIntegration.inputRouter;
      mapShine.layerVisibility = controlsIntegration.layerVisibility;
    }
    // Attach to canvas as well for convenience (used by console snippets)
    try { canvas.mapShine = mapShine; } catch (_) {}

    // Ensure initial light gizmo visibility is correct. ControlsIntegration computes
    // visibility based on active layer/tool, but it can run before managers are
    // attached to window.MapShine during startup.
    try {
      controlsIntegration?._updateThreeGizmoVisibility?.();
    } catch (_) {
      // Ignore
    }

    log.info('Specular effect registered and initialized');

    // Log FPS periodically
    if (fpsLogIntervalId !== null) {
      clearInterval(fpsLogIntervalId);
      fpsLogIntervalId = null;
    }
    fpsLogIntervalId = setInterval(() => {
      if (renderLoop && renderLoop.running()) {
        log.debug(`FPS: ${renderLoop.getFPS()}, Frames: ${renderLoop.getFrameCount()}`);
      }
    }, 5000);

    // Initialize Tweakpane UI
    try {
      if (isStale()) return;
      await initializeUI(
        specularEffect,
        iridescenceEffect,
        colorCorrectionEffect,
        filmGrainEffect,
        dotScreenEffect,
        halftoneEffect,
        sharpenEffect,
        asciiEffect,
        prismEffect,
        lightingEffect,
        skyColorEffect,
        bloomEffect,
        lensflareEffect,
        fireSparksEffect,
        smellyFliesEffect,
        dustMotesEffect,
        lightningEffect,
        windowLightEffect,
        overheadShadowsEffect,
        buildingShadowsEffect,
        cloudEffect,
        atmosphericFogEffect,
        bushEffect,
        treeEffect,
        waterEffect,
        fogEffect,
        distortionManager,
        maskDebugEffect,
        debugLayerEffect,
        playerLightEffect
      );

      // Ensure the scene loads with the last persisted weather snapshot even if UI initialization
      // (Control Panel / Tweakpane) applied other defaults during startup.
      weatherController._loadWeatherSnapshotFromScene?.();
    } catch (e) {
      log.error('Failed to initialize UI:', e);
    }

    // Only begin fading-in once we have proof that Three has actually rendered.
    // This prevents the overlay from fading out during shader compilation / first-frame stutter.
    try {
      loadingOverlay.setStage('final', 0.4, 'Finalizing…', { keepAuto: true });
      loadingOverlay.startAutoProgress(0.995, 0.008);
    } catch (e) {
      // Ignore overlay errors
    }

    // P1.2: Wait for all effects to be ready before fading overlay
    // This ensures textures are loaded and GPU operations are complete
    try {
      loadingOverlay.setStage('final', 0.45, 'Finishing textures…', { keepAuto: true });
    } catch (_) {}
    try {
      const effectReadinessPromises = [];
      for (const effect of effectComposer.effects.values()) {
        if (typeof effect.getReadinessPromise === 'function') {
          const promise = effect.getReadinessPromise();
          if (promise && typeof promise.then === 'function') {
            effectReadinessPromises.push(promise);
          }
        }
      }
      
      if (effectReadinessPromises.length > 0) {
        await Promise.race([
          Promise.all(effectReadinessPromises),
          new Promise(r => setTimeout(r, 15000)) // 15s timeout
        ]);
      }
    } catch (e) {
      log.debug('Effect readiness wait failed:', e);
    }

    // P1.3: Wait for all tiles (not just overhead) to decode their textures
    // This prevents pop-in of ground/water tiles after the overlay fades
    try {
      loadingOverlay.setStage('final', 0.50, 'Preparing tiles…', { keepAuto: true });
    } catch (_) {}
    try {
      await tileManager?.waitForInitialTiles?.({ overheadOnly: false, timeoutMs: 15000 });
    } catch (_) {
    }

    try {
      await waitForThreeFrames(renderer, renderLoop, 6, 12000, {
        minCalls: 1,
        stableCallsFrames: 3,
        minDelayMs: 350
      });
    } catch (e) {
      // Ignore wait errors
    }

    try {
      const controlHour = window.MapShine?.controlPanel?.controlState?.timeOfDay;
      const hour = Number.isFinite(controlHour) ? controlHour : Number(weatherController?.timeOfDay);
      if (Number.isFinite(hour)) {
        await stateApplier.applyTimeOfDay(hour, false, true);

        try {
          const cloudEffect = window.MapShine?.cloudEffect;
          if (cloudEffect) {
            if (typeof cloudEffect.requestRecompose === 'function') cloudEffect.requestRecompose(3);
            if (typeof cloudEffect.requestUpdate === 'function') cloudEffect.requestUpdate(3);
          }
        } catch (e) {
        }
      }
    } catch (e) {
      log.debug('Time refresh jiggle failed:', e);
    }

    try {
      loadingOverlay.setStage('final', 1.0, 'Finished', { immediate: true });
      await loadingOverlay.fadeIn(5000);
    } catch (e) {
      // Ignore overlay errors
    }

  } catch (error) {
    log.error('Failed to initialize three.js scene:', error);
    destroyThreeCanvas();
  } finally {
    if (doLoadProfile) {
      try {
        lp.end('sceneLoad');
      } catch (e) {
      }
    }
  }
}

/**
 * Initialize Tweakpane UI and register effects
 * @param {SpecularEffect} specularEffect - The specular effect instance
 * @param {IridescenceEffect} iridescenceEffect - The iridescence effect instance
 * @param {ColorCorrectionEffect} colorCorrectionEffect - The color correction effect instance
 * @param {FilmGrainEffect} filmGrainEffect - The film grain effect instance
 * @param {DotScreenEffect} dotScreenEffect - The dot screen effect instance
 * @param {HalftoneEffect} halftoneEffect - The halftone effect instance
 * @param {SharpenEffect} sharpenEffect - The sharpen effect instance
 * @param {AsciiEffect} asciiEffect - The ASCII effect instance
 * @param {PrismEffect} prismEffect - The prism effect instance
 * @param {LightingEffect} lightingEffect - The dynamic lighting effect instance
 * @param {SkyColorEffect} skyColorEffect - The sky color grading effect instance
 * @param {BloomEffect} bloomEffect - The bloom effect instance
 * @param {LensflareEffect} lensflareEffect - The lensflare effect instance
 * @param {WindowLightEffect} windowLightEffect - The window lighting effect instance
 * @param {OverheadShadowsEffect} overheadShadowsEffect - The overhead shadows effect instance
 * @param {BuildingShadowsEffect} buildingShadowsEffect - The building shadows effect instance
 * @param {CloudEffect} cloudEffect - The procedural cloud shadows effect instance
 * @param {BushEffect} bushEffect - The animated bushes surface effect instance
 * @param {TreeEffect} treeEffect - The animated trees surface effect instance
 * @param {WaterEffect} waterEffect - The water effect instance
 * @param {FogEffect} fogEffect - The fog of war effect instance
 * @param {DistortionManager} distortionManager - The centralized distortion manager
 * @private
 */
async function initializeUI(specularEffect, iridescenceEffect, colorCorrectionEffect, filmGrainEffect, dotScreenEffect, halftoneEffect, sharpenEffect, asciiEffect, prismEffect, lightingEffect, skyColorEffect, bloomEffect, lensflareEffect, fireSparksEffect, smellyFliesEffect, dustMotesEffect, lightningEffect, windowLightEffect, overheadShadowsEffect, buildingShadowsEffect, cloudEffect, atmosphericFogEffect, bushEffect, treeEffect, waterEffect, fogEffect, distortionManager, maskDebugEffect, debugLayerEffect, playerLightEffect) {
  // Expose TimeManager BEFORE creating UI so Global Controls can access it
  if (window.MapShine.effectComposer) {
    window.MapShine.timeManager = window.MapShine.effectComposer.getTimeManager();
    log.info('TimeManager exposed to UI');
  } else {
    log.warn('EffectComposer not available, TimeManager not exposed');
  }
  
  // Create UI manager if not already created
  if (!uiManager) {
    uiManager = new TweakpaneManager();
    await uiManager.initialize();
    log.info('UI Manager created');
  }

  // --- Selection Box UI (Gameplay drag-select visuals) ---
  try {
    const selectionSchema = {
      enabled: true,
      presetApplyDefaults: true,
      presets: {
        Blueprint: {
          outlineColor: { r: 0.2, g: 0.75, b: 1.0 },
          outlineWidthPx: 2,
          outlineAlpha: 0.95,
          fillAlpha: 0.02,
          cornerRadiusPx: 2,
          borderStyle: 'solid',
          glowEnabled: true,
          glowAlpha: 0.22,
          glowSizePx: 22,
          pulseEnabled: false,
          pattern: 'grid',
          patternScalePx: 22,
          patternAlpha: 0.14,
          patternLineWidthPx: 1,
          shadowEnabled: true,
          shadowOpacity: 0.22,
          shadowFeather: 0.08,
          shadowOffsetPx: 18,
          labelEnabled: false,
          labelClampToViewport: true
        },
        'Marching Ants': {
          outlineColor: { r: 1.0, g: 1.0, b: 1.0 },
          outlineWidthPx: 2,
          outlineAlpha: 0.95,
          fillAlpha: 0.0,
          cornerRadiusPx: 0,
          borderStyle: 'marching',
          dashLengthPx: 10,
          dashGapPx: 6,
          dashSpeed: 180,
          glowEnabled: false,
          pulseEnabled: false,
          pattern: 'none',
          shadowEnabled: true,
          shadowOpacity: 0.18,
          shadowFeather: 0.06,
          shadowOffsetPx: 12,
          labelEnabled: true,
          labelAlpha: 0.75,
          labelFontSizePx: 12,
          labelClampToViewport: true
        },
        'Neon Minimal': {
          outlineColor: { r: 0.6, g: 1.0, b: 0.85 },
          outlineWidthPx: 2,
          outlineAlpha: 0.9,
          fillAlpha: 0.01,
          cornerRadiusPx: 3,
          borderStyle: 'solid',
          glowEnabled: true,
          glowAlpha: 0.35,
          glowSizePx: 28,
          pulseEnabled: true,
          pulseSpeed: 1.4,
          pulseStrength: 0.7,
          pattern: 'none',
          shadowEnabled: true,
          shadowOpacity: 0.2,
          shadowFeather: 0.1,
          shadowOffsetPx: 22,
          labelEnabled: false,
          labelClampToViewport: true
        },
        Scanner: {
          outlineColor: { r: 0.95, g: 0.35, b: 1.0 },
          outlineWidthPx: 2,
          outlineAlpha: 0.9,
          fillAlpha: 0.02,
          cornerRadiusPx: 2,
          borderStyle: 'dashed',
          dashLengthPx: 14,
          dashGapPx: 10,
          glowEnabled: true,
          glowAlpha: 0.18,
          glowSizePx: 18,
          pulseEnabled: true,
          pulseSpeed: 2.2,
          pulseStrength: 0.55,
          pattern: 'diagonal',
          patternScalePx: 16,
          patternAlpha: 0.18,
          patternLineWidthPx: 1,
          shadowEnabled: true,
          shadowOpacity: 0.22,
          shadowFeather: 0.08,
          shadowOffsetPx: 26,
          labelEnabled: true,
          labelAlpha: 0.85,
          labelFontSizePx: 12,
          labelClampToViewport: true
        },
        'Cyber Gradient': {
          outlineColor: { r: 0.2, g: 0.85, b: 1.0 },
          outlineWidthPx: 2,
          outlineAlpha: 1.0,
          fillAlpha: 0.01,
          cornerRadiusPx: 2,
          borderStyle: 'solid',
          gradientEnabled: true,
          gradientSpeed: 0.8,
          gradientColorA: { r: 0.0, g: 1.0, b: 1.0 },
          gradientColorB: { r: 1.0, g: 0.0, b: 1.0 },
          glowEnabled: true,
          glowAlpha: 0.35,
          glowSizePx: 30,
          pulseEnabled: false,
          pattern: 'none',
          shadowEnabled: true,
          shadowOpacity: 0.18,
          shadowFeather: 0.08,
          shadowOffsetPx: 20,
          labelEnabled: false,
          labelClampToViewport: true
        },
        'Tech Brackets': {
          outlineColor: { r: 0.25, g: 0.9, b: 0.6 },
          outlineWidthPx: 2,
          outlineAlpha: 0.95,
          fillAlpha: 0.0,
          cornerRadiusPx: 0,
          borderStyle: 'solid',
          techBracketsEnabled: true,
          techBracketAlpha: 0.95,
          techBracketLengthPx: 22,
          techBracketWidthPx: 3,
          reticleEnabled: true,
          reticleAlpha: 0.08,
          reticleWidthPx: 1,
          glowEnabled: true,
          glowAlpha: 0.2,
          glowSizePx: 18,
          pulseEnabled: false,
          pattern: 'none',
          shadowEnabled: true,
          shadowOpacity: 0.2,
          shadowFeather: 0.08,
          shadowOffsetPx: 16,
          labelEnabled: false,
          labelClampToViewport: true
        },
        Glass: {
          outlineColor: { r: 0.75, g: 0.85, b: 1.0 },
          outlineWidthPx: 1,
          outlineAlpha: 0.8,
          fillAlpha: 0.01,
          cornerRadiusPx: 6,
          borderStyle: 'solid',
          glassEnabled: true,
          glassBlurPx: 6,
          glowEnabled: false,
          pulseEnabled: false,
          pattern: 'none',
          shadowEnabled: true,
          shadowOpacity: 0.12,
          shadowFeather: 0.12,
          shadowOffsetPx: 14,
          labelEnabled: false,
          labelClampToViewport: true
        },
        'Illuminated Grid': {
          outlineColor: { r: 0.25, g: 0.8, b: 1.0 },
          outlineWidthPx: 2,
          outlineAlpha: 0.95,
          fillAlpha: 0.0,
          cornerRadiusPx: 2,
          borderStyle: 'solid',
          glowEnabled: true,
          glowAlpha: 0.22,
          glowSizePx: 24,
          pulseEnabled: false,
          pattern: 'none',
          shadowEnabled: true,
          shadowOpacity: 0.14,
          shadowFeather: 0.1,
          shadowOffsetPx: 14,
          illuminationEnabled: true,
          illuminationIntensity: 0.45,
          illuminationGridScalePx: 26,
          illuminationScrollSpeed: 0.35,
          illuminationColor: { r: 0.25, g: 0.85, b: 1.0 },
          labelEnabled: false,
          labelClampToViewport: true
        },
        'Double Border': {
          outlineColor: { r: 0.25, g: 0.85, b: 1.0 },
          outlineWidthPx: 2,
          outlineAlpha: 0.9,
          fillAlpha: 0.02,
          cornerRadiusPx: 2,
          borderStyle: 'solid',
          glowEnabled: true,
          glowAlpha: 0.18,
          glowSizePx: 18,
          pulseEnabled: false,
          pattern: 'grid',
          patternScalePx: 20,
          patternAlpha: 0.12,
          patternLineWidthPx: 1,
          doubleBorderEnabled: true,
          doubleBorderInsetPx: 3,
          doubleBorderWidthPx: 1,
          doubleBorderAlpha: 0.55,
          doubleBorderStyle: 'dashed',
          shadowEnabled: true,
          shadowOpacity: 0.18,
          shadowFeather: 0.08,
          shadowOffsetPx: 16,
          labelEnabled: false,
          labelClampToViewport: true
        },
        'Double Marching': {
          outlineColor: { r: 1.0, g: 1.0, b: 1.0 },
          outlineWidthPx: 2,
          outlineAlpha: 0.95,
          fillAlpha: 0.0,
          cornerRadiusPx: 0,
          borderStyle: 'marching',
          dashLengthPx: 10,
          dashGapPx: 6,
          dashSpeed: 200,
          glowEnabled: false,
          pulseEnabled: false,
          pattern: 'none',
          doubleBorderEnabled: true,
          doubleBorderInsetPx: 4,
          doubleBorderWidthPx: 1,
          doubleBorderAlpha: 0.65,
          doubleBorderStyle: 'marching',
          shadowEnabled: true,
          shadowOpacity: 0.14,
          shadowFeather: 0.06,
          shadowOffsetPx: 12,
          labelEnabled: true,
          labelAlpha: 0.75,
          labelFontSizePx: 12,
          labelClampToViewport: true
        }
      },
      groups: [
        {
          name: 'appearance',
          label: 'Selection Box',
          type: 'folder',
          expanded: false,
          parameters: [
            'enabled',
            'outlineColor',
            'outlineWidthPx',
            'outlineAlpha',
            'fillAlpha',
            'cornerRadiusPx'
          ]
        },
        {
          name: 'border',
          label: 'Border Style',
          type: 'folder',
          expanded: false,
          parameters: [
            'borderStyle',
            'dashLengthPx',
            'dashGapPx',
            'dashSpeed'
          ]
        },
        {
          name: 'doubleBorder',
          label: 'Double Border',
          type: 'folder',
          expanded: false,
          parameters: [
            'doubleBorderEnabled',
            'doubleBorderInsetPx',
            'doubleBorderWidthPx',
            'doubleBorderAlpha',
            'doubleBorderStyle'
          ]
        },
        {
          name: 'glow',
          label: 'Glow',
          type: 'folder',
          expanded: false,
          parameters: [
            'glowEnabled',
            'glowAlpha',
            'glowSizePx'
          ]
        },
        {
          name: 'pulse',
          label: 'Pulse',
          type: 'folder',
          expanded: false,
          parameters: [
            'pulseEnabled',
            'pulseSpeed',
            'pulseStrength'
          ]
        },
        {
          name: 'pattern',
          label: 'Fill Pattern',
          type: 'folder',
          expanded: false,
          parameters: [
            'pattern',
            'patternScalePx',
            'patternAlpha',
            'patternLineWidthPx'
          ]
        },
        {
          name: 'extras',
          label: 'Extras',
          type: 'folder',
          expanded: false,
          parameters: [
            'glassEnabled',
            'glassBlurPx',
            'gradientEnabled',
            'gradientSpeed',
            'gradientColorA',
            'gradientColorB',
            'reticleEnabled',
            'reticleAlpha',
            'reticleWidthPx',
            'techBracketsEnabled',
            'techBracketAlpha',
            'techBracketLengthPx',
            'techBracketWidthPx'
          ]
        },
        {
          name: 'shadow',
          label: 'Shadow',
          type: 'folder',
          expanded: false,
          parameters: [
            'shadowEnabled',
            'shadowOpacity',
            'shadowFeather',
            'shadowOffsetPx',
            'shadowZOffset'
          ]
        },
        {
          name: 'illumination',
          label: 'Illumination',
          type: 'folder',
          expanded: false,
          parameters: [
            'illuminationEnabled',
            'illuminationIntensity',
            'illuminationGridScalePx',
            'illuminationScrollSpeed',
            'illuminationColor'
          ]
        },
        {
          name: 'label',
          label: 'Label',
          type: 'folder',
          expanded: false,
          parameters: [
            'labelEnabled',
            'labelAlpha',
            'labelFontSizePx',
            'labelClampToViewport'
          ]
        }
      ],
      parameters: {
        enabled: { type: 'boolean', label: 'Enabled', default: true },

        outlineColor: { type: 'color', label: 'Outline Color', default: { r: 0.314, g: 0.784, b: 1.0 } },
        outlineWidthPx: { type: 'slider', label: 'Outline Width (px)', min: 0, max: 8, step: 1, default: 2 },
        outlineAlpha: { type: 'slider', label: 'Outline Alpha', min: 0, max: 1, step: 0.01, default: 0.9 },
        fillAlpha: { type: 'slider', label: 'Fill Alpha', min: 0, max: 0.25, step: 0.005, default: 0.035 },
        cornerRadiusPx: { type: 'slider', label: 'Corner Radius (px)', min: 0, max: 16, step: 1, default: 2 },

        borderStyle: {
          type: 'dropdown',
          label: 'Style',
          options: { Solid: 'solid', Dashed: 'dashed', 'Marching Ants': 'marching' },
          default: 'solid'
        },
        dashLengthPx: { type: 'slider', label: 'Dash Length (px)', min: 1, max: 40, step: 1, default: 10 },
        dashGapPx: { type: 'slider', label: 'Dash Gap (px)', min: 0, max: 40, step: 1, default: 6 },
        dashSpeed: { type: 'slider', label: 'Dash Speed (px/s)', min: 0, max: 600, step: 10, default: 120 },

        doubleBorderEnabled: { type: 'boolean', label: 'Enabled', default: false },
        doubleBorderInsetPx: { type: 'slider', label: 'Inset (px)', min: 0, max: 30, step: 1, default: 3 },
        doubleBorderWidthPx: { type: 'slider', label: 'Width (px)', min: 0, max: 8, step: 1, default: 1 },
        doubleBorderAlpha: { type: 'slider', label: 'Alpha', min: 0, max: 1, step: 0.01, default: 0.5 },
        doubleBorderStyle: {
          type: 'dropdown',
          label: 'Style',
          options: { Solid: 'solid', Dashed: 'dashed', 'Marching Ants': 'marching' },
          default: 'dashed'
        },

        glowEnabled: { type: 'boolean', label: 'Enabled', default: true },
        glowAlpha: { type: 'slider', label: 'Glow Alpha', min: 0, max: 1, step: 0.01, default: 0.12 },
        glowSizePx: { type: 'slider', label: 'Glow Size (px)', min: 0, max: 80, step: 1, default: 18 },

        pulseEnabled: { type: 'boolean', label: 'Enabled', default: false },
        pulseSpeed: { type: 'slider', label: 'Speed', min: 0.1, max: 10, step: 0.1, default: 2.0 },
        pulseStrength: { type: 'slider', label: 'Strength', min: 0, max: 1, step: 0.01, default: 0.5 },

        pattern: {
          type: 'dropdown',
          label: 'Pattern',
          options: { None: 'none', Grid: 'grid', Diagonal: 'diagonal', Dots: 'dots' },
          default: 'none'
        },
        patternScalePx: { type: 'slider', label: 'Scale (px)', min: 4, max: 80, step: 1, default: 18 },
        patternAlpha: { type: 'slider', label: 'Alpha', min: 0, max: 1, step: 0.01, default: 0.14 },
        patternLineWidthPx: { type: 'slider', label: 'Line Width (px)', min: 1, max: 6, step: 1, default: 1 },

        glassEnabled: { type: 'boolean', label: 'Glass Blur', default: false },
        glassBlurPx: { type: 'slider', label: 'Blur (px)', min: 0, max: 20, step: 1, default: 4 },

        gradientEnabled: { type: 'boolean', label: 'Gradient Stroke', default: false },
        gradientSpeed: { type: 'slider', label: 'Gradient Speed', min: 0, max: 3, step: 0.05, default: 0.6 },
        gradientColorA: { type: 'color', label: 'Gradient A', default: { r: 0.0, g: 1.0, b: 1.0 } },
        gradientColorB: { type: 'color', label: 'Gradient B', default: { r: 1.0, g: 0.0, b: 1.0 } },

        reticleEnabled: { type: 'boolean', label: 'Reticle', default: false },
        reticleAlpha: { type: 'slider', label: 'Reticle Alpha', min: 0, max: 1, step: 0.01, default: 0.12 },
        reticleWidthPx: { type: 'slider', label: 'Reticle Width (px)', min: 1, max: 6, step: 1, default: 1 },

        techBracketsEnabled: { type: 'boolean', label: 'Tech Brackets', default: false },
        techBracketAlpha: { type: 'slider', label: 'Bracket Alpha', min: 0, max: 1, step: 0.01, default: 0.9 },
        techBracketLengthPx: { type: 'slider', label: 'Bracket Length (px)', min: 4, max: 80, step: 1, default: 18 },
        techBracketWidthPx: { type: 'slider', label: 'Bracket Width (px)', min: 1, max: 12, step: 1, default: 2 },

        shadowEnabled: { type: 'boolean', label: 'Enabled', default: true },
        shadowOpacity: { type: 'slider', label: 'Opacity', min: 0, max: 1, step: 0.01, default: 0.26 },
        shadowFeather: { type: 'slider', label: 'Feather', min: 0, max: 0.3, step: 0.005, default: 0.08 },
        shadowOffsetPx: { type: 'slider', label: 'Offset (px)', min: 0, max: 120, step: 1, default: 18 },
        shadowZOffset: { type: 'slider', label: 'Z Offset', min: 0, max: 2.0, step: 0.01, default: 0.12 },

        illuminationEnabled: { type: 'boolean', label: 'Enabled', default: false },
        illuminationIntensity: { type: 'slider', label: 'Intensity', min: 0, max: 2.0, step: 0.01, default: 0.35 },
        illuminationGridScalePx: { type: 'slider', label: 'Grid Scale', min: 4, max: 120, step: 1, default: 24 },
        illuminationScrollSpeed: { type: 'slider', label: 'Scroll Speed', min: -3, max: 3, step: 0.01, default: 0.25 },
        illuminationColor: { type: 'color', label: 'Color', default: { r: 0.3, g: 0.85, b: 1.0 } },

        labelEnabled: { type: 'boolean', label: 'Enabled', default: false },
        labelAlpha: { type: 'slider', label: 'Alpha', min: 0, max: 1, step: 0.01, default: 0.85 },
        labelFontSizePx: { type: 'slider', label: 'Font Size (px)', min: 8, max: 24, step: 1, default: 12 },
        labelClampToViewport: { type: 'boolean', label: 'Clamp to Viewport', default: true }
      }
    };

    const onSelectionUpdate = (effectId, paramId, value) => {
      const im = window.MapShine?.interactionManager;
      if (im && typeof im.applySelectionBoxParamChange === 'function') {
        im.applySelectionBoxParamChange(paramId, value);
      }
      if (paramId === 'enabled') {
        _updateFoundrySelectRectSuppression();
      }
    };

    uiManager.registerEffect(
      'selectionBox',
      'Selection Box',
      selectionSchema,
      onSelectionUpdate,
      'global'
    );
  } catch (e) {
    log.warn('Failed to register Selection Box UI controls', e);
  }

  // Create Control Panel manager if not already created
  if (!controlPanel) {
    controlPanel = new ControlPanelManager();
    await controlPanel.initialize();
    window.MapShine.controlPanel = controlPanel;
    log.info('Control Panel created');
  }

  // Create Enhanced Light Inspector if not already created
  if (!enhancedLightInspector) {
    enhancedLightInspector = new EnhancedLightInspector();
    enhancedLightInspector.initialize();
    try {
      if (window.MapShine) window.MapShine.enhancedLightInspector = enhancedLightInspector;
    } catch (_) {
    }
    log.info('Enhanced Light Inspector created');
  }

  // Get Specular effect schema from effect class (centralized definition)
  const specularSchema = SpecularEffect.getControlSchema();

  // Update callback for Specular effect
  const onSpecularUpdate = (effectId, paramId, value) => {
    if (paramId === 'enabled' || paramId === 'masterEnabled') {
      specularEffect.enabled = value;
      log.debug(`Specular effect ${value ? 'enabled' : 'disabled'}`);
    } else if (specularEffect.params[paramId] !== undefined) {
      specularEffect.params[paramId] = value;
      log.debug(`Specular.${paramId} = ${value}`);
    }
  };

  // Register effect with UI (Surface & Material category)
  uiManager.registerEffect(
    'specular',
    'Metallic / Specular',
    specularSchema,
    onSpecularUpdate,
    'surface'
  );

  // --- Fog Settings ---
  if (fogEffect) {
    const fogSchema = WorldSpaceFogEffect.getControlSchema();
    
    const onFogUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        fogEffect.enabled = value;
        log.debug(`Fog effect ${value ? 'enabled' : 'disabled'}`);
      } else if (fogEffect.params[paramId] !== undefined) {
        fogEffect.params[paramId] = value;
        log.debug(`Fog.${paramId} = ${value}`);
      }
    };

    uiManager.registerEffect(
      'fog',
      'Fog of War',
      fogSchema,
      onFogUpdate,
      'global'
    );
  }

  // --- Animated Bushes Settings ---
  if (bushEffect) {
    const bushSchema = BushEffect.getControlSchema();

    const onBushUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        bushEffect.enabled = value;
        log.debug(`Bush effect ${value ? 'enabled' : 'disabled'}`);
      } else if (bushEffect.params && Object.prototype.hasOwnProperty.call(bushEffect.params, paramId)) {
        bushEffect.params[paramId] = value;
        log.debug(`Bush.${paramId} = ${value}`);
      }
    };

    uiManager.registerEffect(
      'bush',
      'Animated Bushes',
      bushSchema,
      onBushUpdate,
      'surface'
    );
  }

  // --- Animated Trees Settings ---
  if (treeEffect) {
    const treeSchema = TreeEffect.getControlSchema();

    const onTreeUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        treeEffect.enabled = value;
        log.debug(`Tree effect ${value ? 'enabled' : 'disabled'}`);
      } else if (treeEffect.params && Object.prototype.hasOwnProperty.call(treeEffect.params, paramId)) {
        treeEffect.params[paramId] = value;
        log.debug(`Tree.${paramId} = ${value}`);
      }
    };

    uiManager.registerEffect(
      'tree',
      'Animated Trees (Canopy)',
      treeSchema,
      onTreeUpdate,
      'surface'
    );
  }

  // --- Iridescence Settings ---
  if (iridescenceEffect) {
    const iridescenceSchema = IridescenceEffect.getControlSchema();
    
    const onIridescenceUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        iridescenceEffect.enabled = value;
        log.debug(`Iridescence effect ${value ? 'enabled' : 'disabled'}`);
      } else if (iridescenceEffect.params[paramId] !== undefined) {
        iridescenceEffect.params[paramId] = value;
        log.debug(`Iridescence.${paramId} = ${value}`);
      }
    };

    uiManager.registerEffect(
      'iridescence',
      'Iridescence / Holographic',
      iridescenceSchema,
      onIridescenceUpdate,
      'surface'
    );

    // Sync status
    if (uiManager.effectFolders['iridescence']) {
      const folderData = uiManager.effectFolders['iridescence'];
      folderData.params.textureStatus = iridescenceEffect.params.textureStatus;
      
      if (folderData.bindings.textureStatus) {
        folderData.bindings.textureStatus.refresh();
      }
      uiManager.updateEffectiveState('iridescence');
    }
  }

  // Sync dynamic status from effect to UI immediately
  if (uiManager.effectFolders['specular']) {
    const folderData = uiManager.effectFolders['specular'];
    
    // Update internal params in UI manager
    folderData.params.textureStatus = specularEffect.params.textureStatus;
    folderData.params.hasSpecularMask = specularEffect.params.hasSpecularMask;
    
    // Refresh status display
    if (folderData.bindings.textureStatus) {
      folderData.bindings.textureStatus.refresh();
    }
    
    // Update status light
    uiManager.updateEffectiveState('specular');
  }

  // --- Prism Settings ---
  if (prismEffect) {
    const prismSchema = PrismEffect.getControlSchema();
    
    const onPrismUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        prismEffect.enabled = value;
        log.debug(`Prism effect ${value ? 'enabled' : 'disabled'}`);
      } else if (prismEffect.params[paramId] !== undefined) {
        prismEffect.params[paramId] = value;
        log.debug(`Prism.${paramId} = ${value}`);
      }
    };

    uiManager.registerEffect(
      'prism',
      'Prism / Refraction',
      prismSchema,
      onPrismUpdate,
      'surface'
    );

    // Sync status
    if (uiManager.effectFolders['prism']) {
      const folderData = uiManager.effectFolders['prism'];
      folderData.params.textureStatus = prismEffect.params.textureStatus;
      
      if (folderData.bindings.textureStatus) {
        folderData.bindings.textureStatus.refresh();
      }
      uiManager.updateEffectiveState('prism');
    }
  }

  if (lightingEffect) {
    const lightingSchema = LightingEffect.getControlSchema();

    const onLightingUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        lightingEffect.enabled = value;
        if (lightingEffect.params && Object.prototype.hasOwnProperty.call(lightingEffect.params, 'enabled')) {
          lightingEffect.params.enabled = value;
        }
        log.debug(`Lighting effect ${value ? 'enabled' : 'disabled'}`);
      } else if (lightingEffect.params && Object.prototype.hasOwnProperty.call(lightingEffect.params, paramId)) {
        lightingEffect.params[paramId] = value;
        if (lightingEffect.params && Object.prototype.hasOwnProperty.call(lightingEffect.params, 'enabled')) {
          lightingEffect.enabled = lightingEffect.params.enabled !== false;
        }
        log.debug(`Lighting.${paramId} = ${value}`);
      }
    };

    uiManager.registerEffect(
      'lighting',
      'Lighting & Tone Mapping',
      lightingSchema,
      onLightingUpdate,
      'global'
    );
  }

  if (distortionManager) {
    const distortionSchema = DistortionManager.getControlSchema();

    const onDistortionUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        distortionManager.enabled = value;
      } else if (distortionManager.params && Object.prototype.hasOwnProperty.call(distortionManager.params, paramId)) {
        distortionManager.params[paramId] = value;
      }
    };

    uiManager.registerEffect(
      'distortion-manager',
      'Screen Distortion',
      distortionSchema,
      onDistortionUpdate,
      'global'
    );
  }

  // --- Sky Color Settings (Global & Post) ---
  if (skyColorEffect) {
    const skySchema = SkyColorEffect.getControlSchema();

    const onSkyUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        skyColorEffect.enabled = value;
        log.debug(`SkyColor effect ${value ? 'enabled' : 'disabled'}`);
      } else if (skyColorEffect.params && Object.prototype.hasOwnProperty.call(skyColorEffect.params, paramId)) {
        skyColorEffect.params[paramId] = value;
        log.debug(`SkyColor.${paramId} = ${value}`);
      }
    };

    uiManager.registerEffect(
      'sky-color',
      'Sky Color',
      skySchema,
      onSkyUpdate,
      'global'
    );
  }

  // --- Bloom Settings ---
  if (bloomEffect) {
    // ... (rest of the code remains the same)
    const bloomSchema = BloomEffect.getControlSchema();
    
    const onBloomUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        bloomEffect.enabled = value;
        log.debug(`Bloom effect ${value ? 'enabled' : 'disabled'}`);
      } else if (bloomEffect.params[paramId] !== undefined) {
        bloomEffect.params[paramId] = value;
        log.debug(`Bloom.${paramId} = ${value}`);
      }
    };

    uiManager.registerEffect(
      'bloom',
      'Bloom (Glow)',
      bloomSchema,
      onBloomUpdate,
      'global'
    );
  }

  // --- Lensflare Settings ---
  if (lensflareEffect) {
    const lensflareSchema = LensflareEffect.getControlSchema();
    
    const onLensflareUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        // Drive the internal params.enabled flag for this effect; the
        // EffectComposer keeps the effect registered so update() can
        // hide/show flares without being removed from the pipeline.
        if (lensflareEffect.params && Object.prototype.hasOwnProperty.call(lensflareEffect.params, 'enabled')) {
          lensflareEffect.params.enabled = value;
        }
        log.debug(`Lensflare effect ${value ? 'enabled' : 'disabled'}`);
      } else if (lensflareEffect.params[paramId] !== undefined) {
        lensflareEffect.params[paramId] = value;
        log.debug(`Lensflare.${paramId} = ${value}`);
      }
    };

    uiManager.registerEffect(
      'lensflare',
      'Lensflare',
      lensflareSchema,
      onLensflareUpdate,
      'global'
    );
  }

  const candleFlamesEffect = window.MapShine?.candleFlamesEffect;
  if (candleFlamesEffect) {
    const candleSchema = CandleFlamesEffect.getControlSchema();
    const onCandleUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        candleFlamesEffect.applyParamChange('enabled', !!value);
      } else {
        candleFlamesEffect.applyParamChange(paramId, value);
      }
    };

    uiManager.registerEffect(
      'candle-flames',
      'Candle Flames',
      candleSchema,
      onCandleUpdate,
      'particle'
    );
  }

  // --- Weather System Settings ---
  const weatherSchema = weatherController.constructor.getControlSchema();

  let weatherPresetBuffer = null;

  let customWeatherSyncTimeout = null;
  const scheduleCustomWeatherRegimeSync = () => {
    try {
      if (!game?.user?.isGM) return;
      if (!canvas?.scene) return;

      if (customWeatherSyncTimeout) {
        clearTimeout(customWeatherSyncTimeout);
      }

      customWeatherSyncTimeout = setTimeout(async () => {
        customWeatherSyncTimeout = null;

        // Ensure Directed mode is selected in the live-play control panel.
        const target = weatherController?.targetState;
        if (!target) return;

        const windDir = target.windDirection || { x: 1, y: 0 };
        let windDeg = (Math.atan2(-Number(windDir.y) || 0, Number(windDir.x) || 1) * 180) / Math.PI;
        if (windDeg < 0) windDeg += 360;

        const customPreset = {
          precipitation: Number(target.precipitation) || 0.0,
          cloudCover: Number(target.cloudCover) || 0.0,
          windSpeed: Number(target.windSpeed) || 0.0,
          windDirection: Number.isFinite(windDeg) ? windDeg : 0.0,
          fogDensity: Number(target.fogDensity) || 0.0,
          freezeLevel: Number(target.freezeLevel) || 0.0
        };

        const existing = canvas.scene.getFlag('map-shine-advanced', 'controlState');
        const controlState = (existing && typeof existing === 'object') ? { ...existing } : {};
        controlState.weatherMode = 'directed';
        controlState.dynamicEnabled = false;
        controlState.directedPresetId = 'Custom';
        controlState.directedCustomPreset = customPreset;

        await canvas.scene.setFlag('map-shine-advanced', 'controlState', controlState);

        // Keep the in-memory UI model in sync if the panel is open.
        const cp = window.MapShine?.controlPanel;
        if (cp?.controlState) {
          Object.assign(cp.controlState, controlState);
          try {
            cp.pane?.refresh();
          } catch (_) {
          }
        }

        // Persist the weather state itself, so refresh always restores the correct target.
        try {
          weatherController.scheduleSaveWeatherSnapshot?.();
        } catch (_) {
        }
      }, 400);
    } catch (e) {
    }
  };

  const onWeatherUpdate = (effectId, paramId, value) => {
    if (paramId === '_preset_begin') {
      weatherPresetBuffer = {};
      return;
    }

    if (paramId === '_preset_end') {
      const buffered = weatherPresetBuffer;
      weatherPresetBuffer = null;
      if (buffered && typeof weatherController.transitionToPreset === 'function') {
        weatherController.transitionToPreset(buffered);
      }
      return;
    }

    if (weatherPresetBuffer) {
      if (
        paramId === 'precipitation' ||
        paramId === 'cloudCover' ||
        paramId === 'windSpeed' ||
        paramId === 'windDirection' ||
        paramId === 'fogDensity' ||
        paramId === 'freezeLevel'
      ) {
        weatherPresetBuffer[paramId] = value;
        return;
      }
    }

    // Handle different parameter groups
    if (paramId === 'enabled') {
       // Runtime kill-switch for all weather visuals (clouds + precipitation).
       // NOTE: We do NOT stop the entire particle pipeline (fire/dust/etc still run).
       // Instead WeatherController returns a neutral state, CloudEffect clears its
       // targets, and WeatherParticles hides all precipitation emitters.
       weatherController.enabled = !!value;
       log.debug(`Weather system ${value ? 'enabled' : 'disabled'}`);

       // Force immediate visual response (no need to wait for the next natural update).
       try {
         const cloudEffect = window.MapShine?.cloudEffect;
         if (cloudEffect) cloudEffect.needsUpdate = true;

         const particleSystem = window.MapShineParticles;
         const wp = particleSystem?.weatherParticles;
         if (wp) {
           // WeatherParticles.update() will do the authoritative hide/zeroing,
           // but toggling visibility here ensures instant feedback even if the
           // next frame is delayed.
           const show = weatherController.enabled !== false;
           if (typeof wp._setWeatherSystemsVisible === 'function') {
             wp._setWeatherSystemsVisible(show);
           }
           if (!show && typeof wp._zeroWeatherEmissions === 'function') {
             wp._zeroWeatherEmissions();
           }
         }
       } catch (e) {
       }
    } else if (paramId === 'dynamicEnabled') {
      if (typeof weatherController.setDynamicEnabled === 'function') {
        weatherController.setDynamicEnabled(!!value);
      } else {
        weatherController.dynamicEnabled = !!value;
        if (weatherController.dynamicEnabled) weatherController.enabled = true;
      }
      try {
        uiManager?.updateControlStates?.('weather');
      } catch (e) {
      }
    } else if (paramId === 'dynamicPresetId') {
      if (typeof weatherController.setDynamicPreset === 'function') {
        weatherController.setDynamicPreset(value);
      } else {
        weatherController.dynamicPresetId = value;
      }
    } else if (paramId === 'dynamicEvolutionSpeed') {
      if (typeof weatherController.setDynamicEvolutionSpeed === 'function') {
        weatherController.setDynamicEvolutionSpeed(value);
      } else {
        weatherController.dynamicEvolutionSpeed = value;
      }
    } else if (paramId === 'dynamicPlanDurationMinutes') {
      if (typeof weatherController.setDynamicPlanDurationMinutes === 'function') {
        weatherController.setDynamicPlanDurationMinutes(value);
      } else {
        const n = typeof value === 'number' ? value : Number(value);
        if (Number.isFinite(n)) weatherController.dynamicPlanDurationSeconds = n * 60.0;
      }
    } else if (paramId === 'dynamicPaused') {
      if (typeof weatherController.setDynamicPaused === 'function') {
        weatherController.setDynamicPaused(!!value);
      } else {
        weatherController.dynamicPaused = !!value;
      }
    } else if (paramId === 'presetTransitionDurationMinutes') {
      if (typeof weatherController.setPresetTransitionDurationMinutes === 'function') {
        weatherController.setPresetTransitionDurationMinutes(value);
      }
    } else if (paramId === 'dynamicBoundsEnabled') {
      weatherController.setDynamicBoundsEnabled?.(!!value);
    } else if (
      paramId === 'dynamicBoundsPrecipitationMin' ||
      paramId === 'dynamicBoundsPrecipitationMax' ||
      paramId === 'dynamicBoundsCloudCoverMin' ||
      paramId === 'dynamicBoundsCloudCoverMax' ||
      paramId === 'dynamicBoundsWindSpeedMin' ||
      paramId === 'dynamicBoundsWindSpeedMax' ||
      paramId === 'dynamicBoundsFogDensityMin' ||
      paramId === 'dynamicBoundsFogDensityMax' ||
      paramId === 'dynamicBoundsFreezeLevelMin' ||
      paramId === 'dynamicBoundsFreezeLevelMax'
    ) {
      const key =
        paramId === 'dynamicBoundsPrecipitationMin' ? 'precipitationMin' :
        paramId === 'dynamicBoundsPrecipitationMax' ? 'precipitationMax' :
        paramId === 'dynamicBoundsCloudCoverMin' ? 'cloudCoverMin' :
        paramId === 'dynamicBoundsCloudCoverMax' ? 'cloudCoverMax' :
        paramId === 'dynamicBoundsWindSpeedMin' ? 'windSpeedMin' :
        paramId === 'dynamicBoundsWindSpeedMax' ? 'windSpeedMax' :
        paramId === 'dynamicBoundsFogDensityMin' ? 'fogDensityMin' :
        paramId === 'dynamicBoundsFogDensityMax' ? 'fogDensityMax' :
        paramId === 'dynamicBoundsFreezeLevelMin' ? 'freezeLevelMin' :
        'freezeLevelMax';
      weatherController.setDynamicBound?.(key, value);
    } else if (
      paramId === 'queuedPrecipitation' ||
      paramId === 'queuedCloudCover' ||
      paramId === 'queuedWindSpeed' ||
      paramId === 'queuedWindDirection' ||
      paramId === 'queuedFogDensity' ||
      paramId === 'queuedFreezeLevel'
    ) {
      weatherController.setQueuedTransitionParam?.(paramId, value);
    } else if (paramId === 'queueFromCurrent') {
      weatherController.queueTransitionFromCurrent?.();
    } else if (paramId === 'startQueuedTransition') {
      weatherController.startQueuedTransition?.(weatherController.transitionDuration);
    } else if (paramId === 'roofMaskForceEnabled') {
      // Manual override for indoor masking independent of roof hover state
      weatherController.roofMaskForceEnabled = !!value;
    } else if (paramId === 'transitionDuration') {
      weatherController.transitionDuration = value;
    } else if (paramId === 'variability') {
      weatherController.setVariability(value);
    } else if (paramId === 'simulationSpeed') {
      weatherController.simulationSpeed = value;
    } else if (paramId === 'timeOfDay') {
      weatherController.setTime(value);
    } else if (paramId === 'gustWaitMin') {
      weatherController.gustWaitMin = value;
    } else if (paramId === 'gustWaitMax') {
      weatherController.gustWaitMax = value;
    } else if (paramId === 'gustDuration') {
      weatherController.gustDuration = value;
    } else if (paramId === 'gustStrength') {
      weatherController.gustStrength = value;
    } else if (paramId === 'rainCurlStrength') {
      weatherController.rainTuning.curlStrength = value;
    } else {
      // Manual Overrides (update target state directly)
      const target = weatherController.targetState;
      
      if (paramId === 'windDirection') {
        // UI gives degrees (0-360), convert to vector
        const rad = (value * Math.PI) / 180;

        // Ensure windDirection is a THREE.Vector2 before using .set()
        const THREE = window.THREE;
        if (!THREE) {
          // If THREE is not available for some reason, bail out safely
          log.warn('THREE not available while updating windDirection');
          return;
        }

        if (!(target.windDirection instanceof THREE.Vector2)) {
          const existing = target.windDirection || { x: 1, y: 0 };
          target.windDirection = new THREE.Vector2(existing.x ?? 1, existing.y ?? 0);
        }

        // Foundry world uses Y-down. Our UI degrees are expressed in the usual math sense
        // where 90° points north (up). Convert by flipping Y.
        target.windDirection.set(Math.cos(rad), -Math.sin(rad));
      } else if (paramId.startsWith('rain')) {
        const rt = weatherController.rainTuning;
        if (!rt) return;
        if (paramId === 'rainIntensityScale') rt.intensityScale = value;
        else if (paramId === 'rainStreakLength') rt.streakLength = value;
        else if (paramId === 'rainDropSize') rt.dropSize = value;
        else if (paramId === 'rainDropSizeMin') rt.dropSizeMin = value;
        else if (paramId === 'rainDropSizeMax') rt.dropSizeMax = value;
        else if (paramId === 'rainBrightness') rt.brightness = value;
        else if (paramId === 'rainGravityScale') rt.gravityScale = value;
        else if (paramId === 'rainWindInfluence') rt.windInfluence = value;
        else if (paramId === 'rainCurlStrength') rt.curlStrength = value;
        // Splash-specific controls
        else if (paramId === 'rainSplashIntensityScale') rt.splashIntensityScale = value;
        else if (paramId === 'rainSplashLifeMin') rt.splashLifeMin = value;
        else if (paramId === 'rainSplashLifeMax') rt.splashLifeMax = value;
        else if (paramId === 'rainSplashSizeMin') rt.splashSizeMin = value;
        else if (paramId === 'rainSplashSizeMax') rt.splashSizeMax = value;
        else if (paramId === 'rainSplashOpacityPeak') rt.splashOpacityPeak = value;
        // Per-splash (per atlas tile) controls
        else if (paramId === 'rainSplash1IntensityScale') rt.splash1IntensityScale = value;
        else if (paramId === 'rainSplash1LifeMin') rt.splash1LifeMin = value;
        else if (paramId === 'rainSplash1LifeMax') rt.splash1LifeMax = value;
        else if (paramId === 'rainSplash1SizeMin') rt.splash1SizeMin = value;
        else if (paramId === 'rainSplash1SizeMax') rt.splash1SizeMax = value;
        else if (paramId === 'rainSplash1OpacityPeak') rt.splash1OpacityPeak = value;
        else if (paramId === 'rainSplash2IntensityScale') rt.splash2IntensityScale = value;
        else if (paramId === 'rainSplash2LifeMin') rt.splash2LifeMin = value;
        else if (paramId === 'rainSplash2LifeMax') rt.splash2LifeMax = value;
        else if (paramId === 'rainSplash2SizeMin') rt.splash2SizeMin = value;
        else if (paramId === 'rainSplash2SizeMax') rt.splash2SizeMax = value;
        else if (paramId === 'rainSplash2OpacityPeak') rt.splash2OpacityPeak = value;
        else if (paramId === 'rainSplash3IntensityScale') rt.splash3IntensityScale = value;
        else if (paramId === 'rainSplash3LifeMin') rt.splash3LifeMin = value;
        else if (paramId === 'rainSplash3LifeMax') rt.splash3LifeMax = value;
        else if (paramId === 'rainSplash3SizeMin') rt.splash3SizeMin = value;
        else if (paramId === 'rainSplash3SizeMax') rt.splash3SizeMax = value;
        else if (paramId === 'rainSplash3OpacityPeak') rt.splash3OpacityPeak = value;
        else if (paramId === 'rainSplash4IntensityScale') rt.splash4IntensityScale = value;
        else if (paramId === 'rainSplash4LifeMin') rt.splash4LifeMin = value;
        else if (paramId === 'rainSplash4LifeMax') rt.splash4LifeMax = value;
        else if (paramId === 'rainSplash4SizeMin') rt.splash4SizeMin = value;
        else if (paramId === 'rainSplash4SizeMax') rt.splash4SizeMax = value;
        else if (paramId === 'rainSplash4OpacityPeak') rt.splash4OpacityPeak = value;
      } else if (paramId.startsWith('snow')) {
        const st = weatherController.snowTuning;
        if (!st) return;
        if (paramId === 'snowIntensityScale') st.intensityScale = value;
        else if (paramId === 'snowFlakeSize') st.flakeSize = value;
        else if (paramId === 'snowBrightness') st.brightness = value;
        else if (paramId === 'snowGravityScale') st.gravityScale = value;
        else if (paramId === 'snowWindInfluence') st.windInfluence = value;
        else if (paramId === 'snowCurlStrength') st.curlStrength = value;
        else if (paramId === 'snowFlutterStrength') st.flutterStrength = value;
      } else if (target[paramId] !== undefined) {
        target[paramId] = value;
      }

      // If the user manually edits the primary weather state via the main config,
      // reflect that as a persisted 'Custom' directed regime in the live-play panel.
      if (
        paramId === 'precipitation' ||
        paramId === 'cloudCover' ||
        paramId === 'windSpeed' ||
        paramId === 'windDirection' ||
        paramId === 'fogDensity' ||
        paramId === 'freezeLevel'
      ) {
        scheduleCustomWeatherRegimeSync();
      }
      
      // If we are NOT transitioning, we might want to snap startState too
      // so next transition starts from here? 
      // Actually, if we change targetState while not transitioning, 
      // the update loop will snap currentState to targetState immediately.
      // So we get instant feedback.
    }
  };

  // Initialize params object from current controller state for the UI
  // We want the UI to reflect the Target State (what the user set), not the wandering Current State
  const weatherParams = {
    enabled: weatherController.enabled ?? true,
    transitionDuration: weatherController.transitionDuration,
    presetTransitionDurationMinutes: Number.isFinite(weatherController.presetTransitionDurationSeconds)
      ? (weatherController.presetTransitionDurationSeconds / 60.0)
      : 0.5,
    variability: weatherController.variability,
    simulationSpeed: weatherController.simulationSpeed,
    roofMaskForceEnabled: weatherController.roofMaskForceEnabled,
    
    // Dynamic Weather params
    dynamicEnabled: weatherController.dynamicEnabled ?? false,
    dynamicPresetId: weatherController.dynamicPresetId,
    dynamicEvolutionSpeed: weatherController.dynamicEvolutionSpeed,
    dynamicPlanDurationMinutes: Number.isFinite(weatherController.dynamicPlanDurationSeconds)
      ? (weatherController.dynamicPlanDurationSeconds / 60.0)
      : 6.0,
    dynamicPaused: weatherController.dynamicPaused ?? false,

    // Manual params
    precipitation: weatherController.targetState.precipitation,
    cloudCover: weatherController.targetState.cloudCover,
    windSpeed: weatherController.targetState.windSpeed,
    // Inverse of the UI->vector mapping above (flip Y back to math coords)
    windDirection: Math.atan2(-weatherController.targetState.windDirection.y, weatherController.targetState.windDirection.x) * (180 / Math.PI),
    fogDensity: weatherController.targetState.fogDensity,
    wetness: weatherController.currentState.wetness, // Read-only derived
    freezeLevel: weatherController.targetState.freezeLevel,

    // Wind / Gust tuning
    gustWaitMin: weatherController.gustWaitMin,
    gustWaitMax: weatherController.gustWaitMax,
    gustDuration: weatherController.gustDuration,
    gustStrength: weatherController.gustStrength
  };

  // Fix negative angles
  if (weatherParams.windDirection < 0) weatherParams.windDirection += 360;

  // Override the schema defaults with current values to ensure sync
  // (This is a bit of a hack to pre-populate the UI)
  // uiManager.registerEffect will merge these with loaded settings
  
  // We pass a custom 'updateCallback' that intercepts the preset logic in TweakpaneManager if needed,
  // or we just rely on the standard callback.
  // The TweakpaneManager handles presets by iterating properties and calling this callback.
  // So if a preset sets 'precipitation' to 0.8, it calls onWeatherUpdate('weather', 'precipitation', 0.8).
  // This works perfect.

  uiManager.registerEffect(
    'weather',
    'Weather System',
    weatherSchema,
    onWeatherUpdate,
    'atmospheric'
  );

  // --- Cloud & Cloud Shadow Appearance (Weather Subcategory) ---
  if (cloudEffect) {
    const cloudSchema = CloudEffect.getControlSchema();

    const onCloudUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        cloudEffect.enabled = !!value;
        log.debug(`Cloud effect ${value ? 'enabled' : 'disabled'}`);
      } else if (cloudEffect.params && Object.prototype.hasOwnProperty.call(cloudEffect.params, paramId)) {
        cloudEffect.params[paramId] = value;
        log.debug(`Cloud.${paramId} =`, value);
      }
    };

    uiManager.registerEffectUnderEffect(
      'weather',
      'cloud',
      'Cloud and Cloud Shadow Appearance',
      cloudSchema,
      onCloudUpdate
    );
  }

  // --- Atmospheric Fog (Weather Subcategory) ---
  if (atmosphericFogEffect) {
    const atmosphericFogSchema = AtmosphericFogEffect.getControlSchema();

    const onAtmosphericFogUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        atmosphericFogEffect.enabled = !!value;
        log.debug(`AtmosphericFog effect ${value ? 'enabled' : 'disabled'}`);
      } else if (atmosphericFogEffect.params && Object.prototype.hasOwnProperty.call(atmosphericFogEffect.params, paramId)) {
        atmosphericFogEffect.params[paramId] = value;
        log.debug(`AtmosphericFog.${paramId} =`, value);
      }
    };

    uiManager.registerEffectUnderEffect(
      'weather',
      'atmosphericFog',
      'Fog',
      atmosphericFogSchema,
      onAtmosphericFogUpdate
    );
  }

  // --- Window Light Settings ---
  if (windowLightEffect) {
    const windowSchema = WindowLightEffect.getControlSchema();

    const onWindowUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        windowLightEffect.enabled = value;
        log.debug(`WindowLight effect ${value ? 'enabled' : 'disabled'}`);
      } else if (paramId === 'rebuildRainFlowMap') {
        try {
          // Force regeneration even if the config didn't change.
          windowLightEffect._rainFlowMapConfigKey = null;
          windowLightEffect._ensureRainFlowMap();

          const u = windowLightEffect.material?.uniforms;
          const lu = windowLightEffect.lightMaterial?.uniforms;
          if (u?.uRainFlowMap) u.uRainFlowMap.value = windowLightEffect._rainFlowMap;
          if (lu?.uRainFlowMap) lu.uRainFlowMap.value = windowLightEffect._rainFlowMap;
          if (u?.uHasRainFlowMap) u.uHasRainFlowMap.value = windowLightEffect._rainFlowMap ? 1.0 : 0.0;
          if (lu?.uHasRainFlowMap) lu.uHasRainFlowMap.value = windowLightEffect._rainFlowMap ? 1.0 : 0.0;
        } catch (e) {
        }
      } else if (windowLightEffect.params && Object.prototype.hasOwnProperty.call(windowLightEffect.params, paramId)) {
        windowLightEffect.params[paramId] = value;
      }
    };

    uiManager.registerEffect(
      'windowLight',
      'Window Light',
      windowSchema,
      onWindowUpdate,
      'atmospheric'
    );

    if (uiManager.effectFolders['windowLight']) {
      const folderData = uiManager.effectFolders['windowLight'];
      folderData.params.textureStatus = windowLightEffect.params.textureStatus;

      if (folderData.bindings.textureStatus) {
        folderData.bindings.textureStatus.refresh();
      }
      uiManager.updateEffectiveState('windowLight');
    }
  }

  // --- Overhead Shadows Settings ---
  if (overheadShadowsEffect) {
    const overheadSchema = OverheadShadowsEffect.getControlSchema();

    const onOverheadUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        overheadShadowsEffect.enabled = !!value;
        log.debug(`OverheadShadows effect ${value ? 'enabled' : 'disabled'}`);
      } else if (overheadShadowsEffect.params && Object.prototype.hasOwnProperty.call(overheadShadowsEffect.params, paramId)) {
        overheadShadowsEffect.params[paramId] = value;
        log.debug(`OverheadShadows.${paramId} =`, value);

        // Keep BuildingShadowsEffect's sunLatitude in sync so both
        // shadow casters share the same north/south eccentricity.
        if (paramId === 'sunLatitude' && buildingShadowsEffect && buildingShadowsEffect.params) {
          buildingShadowsEffect.params.sunLatitude = value;
          log.debug('BuildingShadows.sunLatitude synced from OverheadShadows:', value);
        }
      }
    };

    uiManager.registerEffect(
      'overhead-shadows',
      'Overhead Shadows',
      overheadSchema,
      onOverheadUpdate,
      'atmospheric'
    );
  }

  // --- Building Shadows Settings ---
  if (buildingShadowsEffect) {
    const buildingSchema = BuildingShadowsEffect.getControlSchema();

    const onBuildingUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        buildingShadowsEffect.enabled = !!value;
        log.debug(`BuildingShadows effect ${value ? 'enabled' : 'disabled'}`);
      } else if (buildingShadowsEffect.params && Object.prototype.hasOwnProperty.call(buildingShadowsEffect.params, paramId)) {
        buildingShadowsEffect.params[paramId] = value;
        log.debug(`BuildingShadows.${paramId} =`, value);

        // Keep OverheadShadowsEffect's sunLatitude in sync so both
        // shadow casters share the same north/south eccentricity.
        if (paramId === 'sunLatitude' && overheadShadowsEffect && overheadShadowsEffect.params) {
          overheadShadowsEffect.params.sunLatitude = value;
          log.debug('OverheadShadows.sunLatitude synced from BuildingShadows:', value);
        }
      }
    };

    uiManager.registerEffect(
      'building-shadows',
      'Building Shadows',
      buildingSchema,
      onBuildingUpdate,
      'atmospheric'
    );
  }

  // --- Fire Debug Settings ---
  if (fireSparksEffect) {
    const fireSchema = FireSparksEffect.getControlSchema();
    
    const onFireUpdate = (effectId, paramId, value) => {
      fireSparksEffect.applyParamChange(paramId, value);
    };

    uiManager.registerEffect(
      'fire-sparks',
      'Fire',
      fireSchema,
      onFireUpdate,
      'particle'
    );
  }

  if (lightningEffect) {
    const lightningSchema = LightningEffect.getControlSchema();

    const onLightningUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        lightningEffect.enabled = !!value;
        log.debug(`Lightning effect ${value ? 'enabled' : 'disabled'}`);
      } else {
        lightningEffect.applyParamChange(paramId, value);
      }
    };

    uiManager.registerEffect(
      'lightning',
      'Lightning (Map Points)',
      lightningSchema,
      onLightningUpdate,
      'particle'
    );
  }

  // --- Water Settings ---
  if (waterEffect) {
    const waterSchema = WaterEffectV2.getControlSchema();

    const onWaterUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        waterEffect.enabled = !!value;
        log.debug(`Water effect ${value ? 'enabled' : 'disabled'}`);
      } else if (paramId === 'clearCaches') {
        let didAnything = false;

        try {
          if (typeof waterEffect.clearCaches === 'function') {
            waterEffect.clearCaches();
            didAnything = true;
          }
        } catch (_) {
        }

        try {
          const particleSystem = window.MapShineParticles;
          const wp = particleSystem?.weatherParticles;
          if (wp && typeof wp.clearWaterCaches === 'function') {
            wp.clearWaterCaches();
            didAnything = true;
          }
        } catch (_) {
        }

        try {
          if (didAnything) ui.notifications.info('Cleared Water caches');
          else ui.notifications.warn('No Water caches available to clear');
        } catch (_) {
        }
      } else if (waterEffect.params && Object.prototype.hasOwnProperty.call(waterEffect.params, paramId)) {
        waterEffect.params[paramId] = value;
      }
    };

    uiManager.registerEffect(
      'water',
      'Water',
      waterSchema,
      onWaterUpdate,
      'water'
    );
  }

  // --- Smelly Flies Settings ---
  if (smellyFliesEffect) {
    const fliesSchema = SmellyFliesEffect.getControlSchema();
    
    const onFliesUpdate = (effectId, paramId, value) => {
      smellyFliesEffect.applyParamChange(paramId, value);
    };

    uiManager.registerEffect(
      'smelly-flies',
      'Smelly Flies',
      fliesSchema,
      onFliesUpdate,
      'particle'
    );

    // Add "Draw Spawn Area" button to Smelly Flies folder
    const fliesFolderData = uiManager.effectFolders?.['smelly-flies'];
    if (fliesFolderData?.folder) {
      fliesFolderData.folder.addButton({
        title: '🎯 Draw Spawn Area'
      }).on('click', () => {
        const interactionManager = window.MapShine?.interactionManager;
        if (interactionManager) {
          interactionManager.startMapPointDrawing('smellyFlies', 'area');
        } else {
          ui.notifications.warn('Interaction manager not available');
        }
      });
    }
  }

  if (dustMotesEffect) {
    const dustSchema = DustMotesEffect.getControlSchema();

    const onDustUpdate = (effectId, paramId, value) => {
      dustMotesEffect.applyParamChange(paramId, value);
    };

    uiManager.registerEffect(
      'dust',
      'Dust',
      dustSchema,
      onDustUpdate,
      'particle'
    );
  }

  // Add a simple windvane indicator inside the Weather UI folder that reflects
  // the live scene wind direction from WeatherController.currentState.
  try {
    const weatherFolderData = uiManager.effectFolders?.weather;
    const folderElement = weatherFolderData?.folder?.element;
    if (folderElement) {
      const content = folderElement.querySelector('.tp-fldv_c') || folderElement;

      const vaneWrapper = document.createElement('div');
      vaneWrapper.style.display = 'flex';
      vaneWrapper.style.alignItems = 'center';
      vaneWrapper.style.justifyContent = 'space-between';
      vaneWrapper.style.marginTop = '4px';

      const label = document.createElement('div');
      label.textContent = 'Wind Direction';
      label.style.fontSize = '11px';

      const vane = document.createElement('div');
      vane.style.width = '24px';
      vane.style.height = '24px';
      vane.style.position = 'relative';

      const arrow = document.createElement('div');
      arrow.style.position = 'absolute';
      arrow.style.left = '50%';
      arrow.style.top = '50%';
      arrow.style.width = '2px';
      arrow.style.height = '10px';
      arrow.style.background = 'currentColor';
      arrow.style.transformOrigin = '50% 100%';

      const arrowHead = document.createElement('div');
      arrowHead.style.position = 'absolute';
      arrowHead.style.left = '50%';
      arrowHead.style.top = '0';
      arrowHead.style.transform = 'translate(-50%, -50%)';
      arrowHead.style.width = '0';
      arrowHead.style.height = '0';
      arrowHead.style.borderLeft = '4px solid transparent';
      arrowHead.style.borderRight = '4px solid transparent';
      arrowHead.style.borderBottom = '6px solid currentColor';

      arrow.appendChild(arrowHead);
      vane.appendChild(arrow);

      vaneWrapper.appendChild(label);
      vaneWrapper.appendChild(vane);
      content.appendChild(vaneWrapper);

      // Periodically sync arrow rotation with the live wind direction.
      const updateWindVane = () => {
        const state = weatherController.getCurrentState();
        if (!state || !state.windDirection) return;
        const angleRad = Math.atan2(state.windDirection.y, state.windDirection.x);
        const angleDeg = (angleRad * 180) / Math.PI;
        // Map world wind vector angle to UI rotation so that:
        // 0° (east), 90° (north), 180° (west), 270° (south) all align visually
        // with the direction the wind is pushing.
        // This mapping preserves correctness at 0° and 180° while fixing 90°/270°.
        arrow.style.transform = `translate(-50%, -50%) rotate(${90 - angleDeg}deg)`;
      };

      updateWindVane();
      if (windVaneIntervalId !== null) {
        clearInterval(windVaneIntervalId);
        windVaneIntervalId = null;
      }
      windVaneIntervalId = setInterval(updateWindVane, 200);
    }
  } catch (e) {
    log.warn('Failed to add windvane UI indicator:', e);
  }

  // Manually sync the initial values into the UI manager's storage for this effect
  // because registerEffect loads from scene settings or defaults, but we want to sync 
  // with the controller's in-memory state if it was initialized differently.
  // Actually, registerEffect handles loading. We should let it load, then sync controller TO settings?
  // Or settings TO controller?
  // Let's assume Scene Settings are authoritative.
  // The updateCallback is called during initialization for loaded params.
  // So weatherController will be updated to match Scene Settings. Perfect.

  // --- Grid Settings ---
  if (gridRenderer) {
    const gridSchema = GridRenderer.getControlSchema();
    
    const onGridUpdate = (effectId, paramId, value) => {
      gridRenderer.updateSetting(paramId, value);
      log.debug(`Grid.${paramId} = ${value}`);
    };

    uiManager.registerEffect(
      'grid',
      'Grid Settings',
      gridSchema,
      onGridUpdate,
      'global'
    );
    log.info('Grid settings wired to UI');
  }

  // --- Color Correction & Grading (Post-Processing) ---
  if (colorCorrectionEffect) {
    const ccSchema = ColorCorrectionEffect.getControlSchema();

    const onColorCorrectionUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        colorCorrectionEffect.enabled = value;
        log.debug(`ColorCorrection effect ${value ? 'enabled' : 'disabled'}`);
      } else if (colorCorrectionEffect.params && Object.prototype.hasOwnProperty.call(colorCorrectionEffect.params, paramId)) {
        colorCorrectionEffect.params[paramId] = value;
        log.debug(`ColorCorrection.${paramId} =`, value);
      }
    };

    uiManager.registerEffect(
      'colorCorrection',
      'Color Grading & VFX',
      ccSchema,
      onColorCorrectionUpdate,
      'global'
    );

    log.info('Color correction effect wired to UI');
  }

  if (filmGrainEffect) {
    const schema = FilmGrainEffect.getControlSchema();

    const onUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        filmGrainEffect.enabled = value;
        log.debug(`FilmGrain effect ${value ? 'enabled' : 'disabled'}`);
      } else if (filmGrainEffect.params && Object.prototype.hasOwnProperty.call(filmGrainEffect.params, paramId)) {
        filmGrainEffect.params[paramId] = value;
      }
    };

    uiManager.registerEffect(
      'filmGrain',
      'Film Grain',
      schema,
      onUpdate,
      'global'
    );
  }

  if (dotScreenEffect) {
    const schema = DotScreenEffect.getControlSchema();

    const onUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        dotScreenEffect.enabled = value;
        log.debug(`DotScreen effect ${value ? 'enabled' : 'disabled'}`);
      } else if (dotScreenEffect.params && Object.prototype.hasOwnProperty.call(dotScreenEffect.params, paramId)) {
        dotScreenEffect.params[paramId] = value;
      }
    };

    uiManager.registerEffect(
      'dotScreen',
      'Dot Screen',
      schema,
      onUpdate,
      'global'
    );
  }

  if (halftoneEffect) {
    const schema = HalftoneEffect.getControlSchema();

    const onUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        halftoneEffect.enabled = value;
        log.debug(`Halftone effect ${value ? 'enabled' : 'disabled'}`);
      } else if (halftoneEffect.params && Object.prototype.hasOwnProperty.call(halftoneEffect.params, paramId)) {
        halftoneEffect.params[paramId] = value;
      }
    };

    uiManager.registerEffect(
      'halftone',
      'Halftone',
      schema,
      onUpdate,
      'global'
    );
  }

  if (sharpenEffect) {
    const sharpenSchema = SharpenEffect.getControlSchema();

    const onSharpenUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        sharpenEffect.enabled = value;
        log.debug(`Sharpen effect ${value ? 'enabled' : 'disabled'}`);
      } else if (sharpenEffect.params && Object.prototype.hasOwnProperty.call(sharpenEffect.params, paramId)) {
        sharpenEffect.params[paramId] = value;
        log.debug(`Sharpen.${paramId} =`, value);
      }
    };

    uiManager.registerEffect(
      'sharpen',
      'Sharpen',
      sharpenSchema,
      onSharpenUpdate,
      'global'
    );
  }

  // --- ASCII Effect ---
  if (asciiEffect) {
    const asciiSchema = AsciiEffect.getControlSchema();
    
    const onAsciiUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled') {
        const enabled = !!value;
        if (asciiEffect.params && Object.prototype.hasOwnProperty.call(asciiEffect.params, 'enabled')) {
          asciiEffect.params.enabled = enabled;
        }

        // masterEnabled is a global gate; it must never force-enable ASCII.
        const master = asciiEffect._masterEnabled !== false;
        asciiEffect.enabled = enabled && master;
        log.debug(`Ascii effect ${asciiEffect.enabled ? 'enabled' : 'disabled'}`);
        return;
      }

      if (paramId === 'masterEnabled') {
        asciiEffect._masterEnabled = !!value;
        const local = !!(asciiEffect.params?.enabled);
        asciiEffect.enabled = local && asciiEffect._masterEnabled;
        log.debug(`Ascii effect ${asciiEffect.enabled ? 'enabled' : 'disabled'}`);
        return;
      }

      if (asciiEffect.params && Object.prototype.hasOwnProperty.call(asciiEffect.params, paramId)) {
        asciiEffect.params[paramId] = value;
      }
    };
    
    uiManager.registerEffect(
      'ascii',
      'ASCII Art',
      asciiSchema,
      onAsciiUpdate,
      'global'
    );
    log.info('ASCII effect wired to UI');
  }

  if (maskDebugEffect) {
    const ids = (() => {
      try {
        const mm = window.MapShine?.maskManager;
        const list = mm ? mm.listIds() : [];
        const o = {};
        for (const id of list) {
          o[id] = id;
        }
        return o;
      } catch (e) {
        return null;
      }
    })();

    const schema = MaskDebugEffect.getControlSchema(ids);
    const onUpdate = (effectId, paramId, value) => {
      maskDebugEffect.applyParamChange(paramId, value);
    };

    uiManager.registerEffect(
      'mask-debug',
      'Mask Debug',
      schema,
      onUpdate,
      'debug'
    );
  }

  if (debugLayerEffect) {
    const schema = DebugLayerEffect.getControlSchema();
    const onUpdate = (effectId, paramId, value) => {
      debugLayerEffect.applyParamChange(paramId, value);
    };

    uiManager.registerEffect(
      'debug-layer',
      'Debug Layer',
      schema,
      onUpdate,
      'debug'
    );
  }

  if (playerLightEffect) {
    const schema = PlayerLightEffect.getControlSchema();
    const onUpdate = (effectId, paramId, value) => {
      playerLightEffect.applyParamChange(paramId, value);
    };

    uiManager.registerEffect(
      'player-light',
      'Player Light',
      schema,
      onUpdate,
      'global'
    );
  }

  // Expose UI manager globally for debugging
  window.MapShine.uiManager = uiManager;
  
  log.info('Specular effect wired to UI');
}

/**
 * Destroy three.js canvas and cleanup resources
 * @private
 */
function destroyThreeCanvas() {
  log.info('Destroying Three.js canvas');
  // Clean up resize handling first
  cleanupResizeHandling();

  // Clear any timers created by this module
  if (fpsLogIntervalId !== null) {
    clearInterval(fpsLogIntervalId);
    fpsLogIntervalId = null;
  }
  if (windVaneIntervalId !== null) {
    clearInterval(windVaneIntervalId);
    windVaneIntervalId = null;
  }

  // Dispose UI manager
  if (uiManager) {
    uiManager.dispose();
    uiManager = null;
    log.debug('UI manager disposed');
  }

  // Dispose Enhanced Light Inspector
  if (enhancedLightInspector) {
    enhancedLightInspector.dispose();
    enhancedLightInspector = null;
    log.debug('Enhanced Light Inspector disposed');
  }

  if (lightRingUI) {
    try {
      try {
        if (effectComposer) effectComposer.removeUpdatable(lightRingUI);
      } catch (_) {
      }
      if (typeof lightRingUI.dispose === 'function') lightRingUI.dispose();
      else lightRingUI.hide();
    } catch (_) {
    }
    lightRingUI = null;
  }

  if (lightAnimDialog) {
    try {
      try {
        if (effectComposer) effectComposer.removeUpdatable(lightAnimDialog);
      } catch (_) {
      }
      if (typeof lightAnimDialog.dispose === 'function') lightAnimDialog.dispose();
      else if (typeof lightAnimDialog.hide === 'function') lightAnimDialog.hide();
    } catch (_) {
    }
    lightAnimDialog = null;
  }

  if (overlayUIManager) {
    try {
      if (effectComposer) effectComposer.removeUpdatable(overlayUIManager);
    } catch (_) {
    }
    try {
      overlayUIManager.dispose();
    } catch (_) {
    }
    overlayUIManager = null;
  }

  // Dispose Control Panel manager
  if (controlPanel) {
    controlPanel.destroy();
    controlPanel = null;
    log.debug('Control Panel manager disposed');
  }

  if (graphicsSettings) {
    try {
      graphicsSettings.dispose();
    } catch (e) {
      log.warn('Failed to dispose Graphics Settings manager', e);
    }
    graphicsSettings = null;
  }

  // Dispose camera follower
  if (cameraFollower) {
    cameraFollower.dispose();
    cameraFollower = null;
    log.debug('Camera follower disposed');
  }

  // Dispose PIXI input bridge
  if (pixiInputBridge) {
    pixiInputBridge.dispose();
    pixiInputBridge = null;
    log.debug('PIXI input bridge disposed');
  }

  // Dispose controls integration
  if (controlsIntegration) {
    controlsIntegration.destroy();
    controlsIntegration = null;
    log.debug('Controls integration disposed');
  }

  // Stop render loop
  if (renderLoop) {
    renderLoop.stop();
    renderLoop = null;
    log.debug('Render loop stopped');
  }

  // Dispose drop handler
  if (dropHandler) {
    dropHandler.dispose();
    dropHandler = null;
    log.debug('Drop handler disposed');
  }

  // Dispose token manager
  if (tokenManager) {
    tokenManager.dispose();
    tokenManager = null;
    log.debug('Token manager disposed');
  }

  // Dispose tile manager
  if (tileManager) {
    tileManager.dispose();
    tileManager = null;
    log.debug('Tile manager disposed');
  }

  if (surfaceRegistry) {
    surfaceRegistry.dispose();
    surfaceRegistry = null;
    log.debug('Surface registry disposed');
  }

  // Dispose wall manager
  if (wallManager) {
    wallManager.dispose();
    wallManager = null;
    log.debug('Wall manager disposed');
  }

  // Dispose door mesh manager
  if (doorMeshManager) {
    doorMeshManager.dispose();
    doorMeshManager = null;
    log.debug('Door mesh manager disposed');
  }

  // Dispose drawing manager
  if (drawingManager) {
    drawingManager.dispose();
    drawingManager = null;
    log.debug('Drawing manager disposed');
  }

  // Dispose note manager
  if (noteManager) {
    noteManager.dispose();
    noteManager = null;
    log.debug('Note manager disposed');
  }

  // Dispose template manager
  if (templateManager) {
    templateManager.dispose();
    templateManager = null;
    log.debug('Template manager disposed');
  }

  // Dispose light icon manager
  if (lightIconManager) {
    lightIconManager.dispose();
    lightIconManager = null;
    log.debug('Light icon manager disposed');
  }

  if (enhancedLightIconManager) {
    enhancedLightIconManager.dispose();
    enhancedLightIconManager = null;
    log.debug('Enhanced light icon manager disposed');
  }

  // Dispose interaction manager
  if (interactionManager) {
    interactionManager.dispose();
    interactionManager = null;
    log.debug('Interaction manager disposed');
  }

  // Dispose grid renderer
  if (gridRenderer) {
    try {
      if (effectComposer) effectComposer.removeUpdatable(gridRenderer);
    } catch (_) {
    }
    gridRenderer.dispose();
    gridRenderer = null;
    log.debug('Grid renderer disposed');
  }

  // Dispose map points manager
  if (mapPointsManager) {
    mapPointsManager.dispose();
    mapPointsManager = null;
    log.debug('Map points manager disposed');
  }

  if (physicsRopeManager) {
    try {
      physicsRopeManager.dispose();
    } catch (e) {
      log.warn('Failed to dispose PhysicsRopeManager', e);
    }
    physicsRopeManager = null;
    log.debug('Physics rope manager disposed');
  }

  // Dispose effect composer
  if (effectComposer) {
    effectComposer.dispose();
    effectComposer = null;
    log.debug('Effect composer disposed');
  }

  // Dispose Fog of War (FogEffect is disposed as part of effectComposer)
  fogEffect = null;

  lightningEffect = null;

  candleFlamesEffect = null;

  // Dispose scene composer
  if (sceneComposer) {
    sceneComposer.dispose();
    sceneComposer = null;
    log.debug('Scene composer disposed');
  }

  // Remove canvas element
  if (threeCanvas) {
    try {
      if (_webglContextLostHandler) {
        threeCanvas.removeEventListener('webglcontextlost', _webglContextLostHandler);
      }
      if (_webglContextRestoredHandler) {
        threeCanvas.removeEventListener('webglcontextrestored', _webglContextRestoredHandler);
      }
    } catch (_) {
      // Ignore
    } finally {
      _webglContextLostHandler = null;
      _webglContextRestoredHandler = null;
    }

    threeCanvas.remove();
    threeCanvas = null;
    log.debug('Three.js canvas removed');
  }

  // Restore Foundry's PIXI rendering
  restoreFoundryRendering();

  try {
    clearAssetCache();
  } catch (e) {
    log.warn('Failed to clear asset cache:', e);
  }

  // Note: renderer is owned by MapShine global state, don't dispose here
  renderer = null;

  log.info('Three.js canvas destroyed');
}

/**
 * Set Map Maker Mode (Master Toggle)
 * @param {boolean} enabled - True for Map Maker (PIXI), False for Gameplay (Three.js)
 * @public
 */
export function setMapMakerMode(enabled) {
  if (isMapMakerMode === enabled) return;
  
  isMapMakerMode = enabled;

  // In Map Maker mode, Foundry should own drag-select visuals (PIXI).
  // In Gameplay mode, MapShine should own drag-select visuals (DOM + Three shadow).
  _updateFoundrySelectRectSuppression();
  log.info(`Switching to ${enabled ? 'Map Maker' : 'Gameplay'} Mode`);

  try {
    if (window.MapShine) window.MapShine.isMapMakerMode = isMapMakerMode;
  } catch (_) {
    // Ignore
  }
  
  if (enabled) {
    disableSystem(); // Hide Three.js, Show PIXI
  } else {
    enableSystem(); // Show Three.js, Hide PIXI layers
  }
}

/**
 * Force-rebuild the MapShine scene from scratch.
 * This is a recovery tool for when caches or render targets become stale.
 * @public
 */
export async function resetScene(options = undefined) {
  if (sceneResetInProgress) return;
  sceneResetInProgress = true;

  try {
    const scene = canvas?.scene;
    if (!scene) {
      try {
        ui?.notifications?.warn?.('Map Shine: No active scene to reset');
      } catch (_) {
      }
      return;
    }

    const prevMapMakerMode = !!isMapMakerMode;

    try {
      ui?.notifications?.info?.('Map Shine: Resetting scene (rebuilding Three.js)…');
    } catch (_) {
    }

    try {
      const w = window.MapShine?.waterEffect;
      if (w && typeof w.clearCaches === 'function') w.clearCaches();
    } catch (_) {
    }

    try {
      const particleSystem = window.MapShineParticles;
      const wp = particleSystem?.weatherParticles;
      if (wp && typeof wp.clearWaterCaches === 'function') wp.clearWaterCaches();
    } catch (_) {
    }

    await createThreeCanvas(scene);

    // Preserve user mode across rebuilds.
    try {
      if (prevMapMakerMode) setMapMakerMode(true);
    } catch (_) {
    }

    try {
      ui?.notifications?.info?.('Map Shine: Scene reset complete');
    } catch (_) {
    }
  } catch (e) {
    try {
      log.error('Scene reset failed:', e);
    } catch (_) {
    }
    try {
      ui?.notifications?.error?.('Map Shine: Scene reset failed (see console)');
    } catch (_) {
    }
  } finally {
    sceneResetInProgress = false;
  }
}

function applyMapMakerFogOverride() {
  if (!game?.user?.isGM) return;
  if (!canvas?.ready) return;

  // Capture prior state once per Map Maker entry.
  if (!mapMakerFogState) {
    mapMakerFogState = {
      fogVisible: canvas.fog?.visible ?? null,
      visibilityVisible: canvas.visibility?.visible ?? null,
      visibilityFilterEnabled: canvas.visibility?.filter?.enabled ?? null
    };
  }

  // In Map Maker mode, fog/visibility can black out the entire map for GMs
  // when no token vision source is active. Hide them to keep the map editable.
  try {
    if (canvas.fog) canvas.fog.visible = false;
    if (canvas.visibility) canvas.visibility.visible = false;
    if (canvas.visibility?.filter) canvas.visibility.filter.enabled = false;
  } catch (_) {
    // Ignore - structure may vary by Foundry version
  }
}

function restoreMapMakerFogOverride() {
  if (!mapMakerFogState) return;

  try {
    if (canvas?.fog && mapMakerFogState.fogVisible !== null) {
      canvas.fog.visible = mapMakerFogState.fogVisible;
    }
    if (canvas?.visibility && mapMakerFogState.visibilityVisible !== null) {
      canvas.visibility.visible = mapMakerFogState.visibilityVisible;
    }
    if (canvas?.visibility?.filter && mapMakerFogState.visibilityFilterEnabled !== null) {
      canvas.visibility.filter.enabled = mapMakerFogState.visibilityFilterEnabled;
    }
  } catch (_) {
    // Ignore
  } finally {
    mapMakerFogState = null;
  }
}

/**
 * Enable the Three.js System (Gameplay Mode)
 * 
 * INPUT INVARIANT (P0.1 - BIG-PICTURE-SYSTEMS-REVIEW):
 * Three.js is the PRIMARY interaction handler in Gameplay Mode.
 * - Three.js canvas: pointerEvents='auto' (receives input)
 * - PIXI canvas: pointerEvents='none' (transparent overlay, InputRouter enables for edit tools)
 * - ControlsIntegration.InputRouter manages tool-based switching
 * 
 * @private
 */
function enableSystem() {
  if (!threeCanvas) return;

  // Leaving Map Maker mode - restore any temporary fog/visibility overrides.
  restoreMapMakerFogOverride();
  
  // Resume Render Loop
  if (renderLoop && !renderLoop.running()) {
    renderLoop.start();
  }
  
  // Three.js Canvas: visible and interactive (PRIMARY interaction handler)
  threeCanvas.style.opacity = '1';
  threeCanvas.style.zIndex = '1'; // Below PIXI (but PIXI is transparent)
  threeCanvas.style.pointerEvents = 'auto'; // Three.js receives input in Gameplay Mode
  
  // PIXI Canvas: transparent overlay, input controlled by InputRouter
  const pixiCanvas = canvas.app?.view;
  if (pixiCanvas) {
    pixiCanvas.style.opacity = '1'; // Keep visible for overlay layers (drawings, templates, notes)
    pixiCanvas.style.zIndex = '10'; // On top
    pixiCanvas.style.pointerEvents = 'none'; // Default to pass-through; InputRouter enables for edit tools
  }
  
  // CRITICAL: Set PIXI renderer background to transparent
  // This allows Three.js content to show through
  if (canvas.app?.renderer?.background) {
    canvas.app.renderer.background.alpha = 0;
  }
  
  // Re-enable ControlsIntegration if it was disabled (e.g., returning from Map Maker mode)
  if (controlsIntegration) {
    const state = controlsIntegration.getState();
    if (state === 'disabled') {
      // Re-initialize to restore hooks and layer management
      controlsIntegration.initialize().then(() => {
        log.info('ControlsIntegration re-enabled after Map Maker mode');
      }).catch(err => {
        log.warn('Failed to re-enable ControlsIntegration:', err);
        configureFoundryCanvas();
      });
    } else if (state === 'active') {
      controlsIntegration.layerVisibility?.update();
      controlsIntegration.inputRouter?.autoUpdate();
    } else {
      // Fallback to legacy configuration
      configureFoundryCanvas();
    }
  } else {
    // Fallback to legacy configuration
    configureFoundryCanvas();
  }
}

/**
 * Disable the Three.js System (Map Maker Mode)
 * @private
 */
function disableSystem() {
  // Pause Render Loop to save resources
  if (renderLoop && renderLoop.running()) {
    renderLoop.stop();
  }
  
  // Hide Three.js Canvas
  if (threeCanvas) {
    threeCanvas.style.opacity = '0';
    threeCanvas.style.pointerEvents = 'none';
  }
  
  // CRITICAL: Disable ControlsIntegration BEFORE restoring PIXI.
  // This prevents its hooks from re-hiding layers after we restore them.
  // The disable() method calls restoreAllLayers() internally.
  if (controlsIntegration && controlsIntegration.getState() === 'active') {
    controlsIntegration.disable();
    log.info('ControlsIntegration disabled for Map Maker mode');
  } else {
    // Fallback if ControlsIntegration isn't active
    restoreFoundryRendering();
  }

  // GM convenience: prevent Foundry fog/visibility from blacking out the map
  // while editing in Map Maker mode.
  applyMapMakerFogOverride();
}

/**
 * Configure Foundry's PIXI canvas for Hybrid Mode
 * Keeps canvas visible but hides specific layers we've replaced
 * Sets up input arbitration to pass clicks through to THREE.js when needed
 * 
 * NOTE: This function is now largely superseded by ControlsIntegration.
 * It remains for backward compatibility and fallback scenarios.
 * @private
 */
function configureFoundryCanvas() {
  if (!canvas || !canvas.app) {
    log.warn('Cannot configure canvas - Foundry canvas not ready');
    return;
  }

  // If controls integration is active, let it handle configuration
  if (controlsIntegration && controlsIntegration.getState() === 'active') {
    log.debug('Controls integration active, skipping legacy configureFoundryCanvas');
    return;
  }

  log.info('Configuring Foundry PIXI canvas for Hybrid Mode (legacy)');

  const pixiCanvas = canvas.app.view;
  if (pixiCanvas) {
    // PIXI-first strategy: PIXI handles ALL interaction, Three.js is render-only
    // PIXI stays on top with opacity 1 so overlay layers (drawings, templates, notes) show.
    // Three.js is below but visible through PIXI's transparent background.
    pixiCanvas.style.opacity = '1'; // Keep visible for overlay layers
    pixiCanvas.style.pointerEvents = 'auto'; // PIXI handles ALL interaction
    pixiCanvas.style.zIndex = '10'; // On top
  }
  
  // CRITICAL: Set PIXI renderer background to transparent
  if (canvas.app?.renderer?.background) {
    canvas.app.renderer.background.alpha = 0;
  }

  // Update layer visibility based on current tool
  updateLayerVisibility();

  // Setup Input Arbitration (Tool switching)
  setupInputArbitration();

  log.info('PIXI canvas configured for Replacement Mode (legacy)');
}

/**
 * Update visibility of Foundry layers based on active tool and mode
 * @private
 */
function updateLayerVisibility() {
  if (!canvas.ready) return;
  
  // 1. Always Hide "Replaced" Layers in Gameplay/Hybrid Mode
  // These are rendered by Three.js
  if (canvas.background) canvas.background.visible = false;
  if (canvas.grid) canvas.grid.visible = false;
  if (canvas.weather) canvas.weather.visible = false;
  if (canvas.environment) canvas.environment.visible = false; // V12+

  // CRITICAL: Tokens layer needs special handling
  // - Visual rendering is done by Three.js (TokenManager)
  // - But PIXI tokens must remain INTERACTIVE for clicks, HUD, selection, cursor
  // - We make token meshes TRANSPARENT (alpha=0) instead of invisible
  // - This keeps hit detection working while Three.js renders the visuals
  if (canvas.tokens) {
    canvas.tokens.visible = true; // Layer stays visible for interaction
    canvas.tokens.interactiveChildren = true;
    // Make individual token visuals transparent but keep them interactive
    for (const token of canvas.tokens.placeables) {
      if (token.mesh) token.mesh.alpha = 0;
      if (token.icon) token.icon.alpha = 0;
      if (token.border) token.border.alpha = 0;
      token.visible = true;
      token.interactive = true;
    }
  }

  // Drawings are NOT replaced; they should render via PIXI as an overlay.
  if (canvas.drawings) canvas.drawings.visible = true;

  // 2. Dynamic Layers - Show only if using the corresponding tool
  const activeLayer = canvas.activeLayer?.name;
  
  // Helper to toggle PIXI layer vs Three.js Manager
  const toggleLayer = (pixiLayerName, manager, forceHideThree = false) => {
    const isActive = activeLayer === pixiLayerName;
    const layer = canvas.layers.find(l => l.name === pixiLayerName); // V12 safer access?
    
    // Show PIXI layer if active
    if (layer) layer.visible = isActive;
    
    // Hide Three.js counterpart if active (to avoid double rendering during edit)
    // OR if we are in Map Maker Mode (where Three.js is hidden anyway)
    if (manager && manager.setVisibility) {
        // In Gameplay Mode: Show manager unless we are explicitly editing this layer
        // In Map Maker Mode: Manager is hidden via canvas opacity, but we can also logically hide it
        const showThree = !isActive && !isMapMakerMode;
        manager.setVisibility(showThree);
    }
  };

  // Walls
  // If Walls Layer is active, show PIXI walls, hide Three.js wall edit lines.
  // If not active, hide PIXI walls, show Three.js wall edit lines.
  if (canvas.walls) {
      const isWallsActive = activeLayer === 'WallsLayer';

      canvas.walls.visible = true;
      canvas.walls.interactiveChildren = true;

      const makeWallTransparent = (wall) => {
        if (!wall) return;
        try {
          const ALPHA = 0.01;
          if (wall.line) wall.line.alpha = ALPHA;
          if (wall.direction) wall.direction.alpha = ALPHA;
          if (wall.endpoints) wall.endpoints.alpha = ALPHA;
          if (wall.doorControl) {
            wall.doorControl.visible = true;
            wall.doorControl.alpha = 1;
          }
          wall.visible = true;
          wall.interactive = true;
          wall.interactiveChildren = true;
        } catch (_) {
        }
      };

      const restoreWallVisuals = (wall) => {
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
        }
      };

      if (Array.isArray(canvas.walls.placeables)) {
        if (isWallsActive) {
          for (const wall of canvas.walls.placeables) restoreWallVisuals(wall);
        } else {
          for (const wall of canvas.walls.placeables) makeWallTransparent(wall);
        }
      }
  }

  // Tiles
  if (canvas.tiles) {
      const isTilesActive = activeLayer === 'TilesLayer';
      canvas.tiles.visible = isTilesActive;
      if (tileManager) {
          tileManager.setVisibility(!isTilesActive && !isMapMakerMode);
      }
  }

  // Other Tools (Lighting, Sounds, etc.) - Just show/hide PIXI layer
  // For Lighting, we also drive the Three.js light icon manager visibility so that
  // light icons only show when the Lighting tool is active.
  const simpleLayers = [
      'LightingLayer', 'SoundsLayer', 'TemplateLayer', 'NotesLayer', 'RegionLayer'
  ];
  
  simpleLayers.forEach(name => {
      const layer = canvas[name === 'RegionLayer' ? 'regions' : name.replace('Layer', '').toLowerCase()];
      // Note: canvas.lighting, canvas.sounds, etc.
      // V12 Regions is canvas.regions
      if (layer) {
          layer.visible = (activeLayer === name);
      }
  });
  
  // Regions Layer (V12 specific check)
  if (canvas.regions) {
      canvas.regions.visible = (activeLayer === 'RegionLayer');
  }
}

/**
 * Setup Input Arbitration
 * Listens to tool changes to toggle PIXI canvas interactivity
 * @private
 */
function setupInputArbitration() {
  // Hook into tool changes
  // We use 'canvasInit' to re-apply settings if scene changes, 
  // but 'createThreeCanvas' handles the main init.
  
  // Remove existing listeners to avoid duplicates if re-initialized
  Hooks.off('changeSidebarTab', updateInputMode);
  Hooks.off('renderSceneControls', updateInputMode);
  
  Hooks.on('changeSidebarTab', updateInputMode);
  Hooks.on('renderSceneControls', updateInputMode);
  
  // Initial check
  updateInputMode();
}

/**
 * Update Input Mode based on active tool
 * @private
 */
function updateInputMode() {
    if (!canvas.ready) return;
    
    // If ControlsIntegration is active, it handles input routing via InputRouter
    // Skip this legacy function to avoid conflicts
    if (controlsIntegration && controlsIntegration.getState() === 'active') {
        return;
    }
    
    const pixiCanvas = canvas.app?.view;
    if (!pixiCanvas) return;

    // If Map Maker Mode is ON, we keep PIXI fully in control. Visibility for
    // native layers is managed exclusively by restoreFoundryRendering(). We
    // must NOT call updateLayerVisibility here, or the scene will vanish when
    // switching tools (Lights, Walls, etc.).
    if (isMapMakerMode) {
        pixiCanvas.style.pointerEvents = 'auto';
        return;
    }

    // In Gameplay Mode (Hybrid), we actively manage PIXI layer visibility to
    // avoid double-rendering. Do this *before* deciding who gets input.
    updateLayerVisibility();

    const activeLayer = canvas.activeLayer?.name;
    
    // Tools that require PIXI interaction
    // Basically any layer that isn't TokenLayer (assuming we handle Tokens in 3D eventually? 
    // For now, we hide TokenLayer, so we might need PIXI input if we want to select tokens?
    // Wait, TokenManager syncs tokens. If we hide TokenLayer, we can't select tokens via PIXI.
    // InteractionManager handles 3D selection.
    
    // So we ONLY need PIXI input if we are on an "Edit" layer that still
    // relies on Foundry's native PIXI interaction (sounds, templates, etc.).
    // Wall editing is handled entirely in Three.js, so WallsLayer is
    // intentionally *excluded* here. That way, while in wall placement mode
    // the Three.js canvas continues to receive input and camera panning
    // remains available.
    const editLayers = [
      // NOTE: LightingLayer is intentionally *not* included here. In Gameplay
      // Mode we handle light placement directly in the Three.js interaction
      // system, so PIXI should not reclaim pointerEvents when the Lighting
      // controls are active.
      'SoundsLayer',
      'TemplateLayer',
      'DrawingsLayer',
      'NotesLayer',
      'RegionLayer',
      'TilesLayer'
    ];
    
    // Drive Three.js wall line visibility and PIXI input routing based on the
    // *final* active layer after Foundry has finished switching tools.
    // We defer to the next tick to avoid reading a stale activeLayer during
    // control changes.
    setTimeout(() => {
      if (!canvas?.ready || isMapMakerMode) return;

      const finalLayer = canvas.activeLayer?.name;
      const isEditMode = editLayers.some(l => finalLayer === l);

      // Drive Three.js light icon visibility from a single source of truth.
      // In Gameplay mode (Three.js active), show light icons only when the
      // Lighting layer is the *final* active layer so they behave like
      // Foundry's native handles. In Map Maker mode, the entire Three.js
      // canvas is hidden, so we also hide the icons here for logical
      // consistency.
      if (lightIconManager && lightIconManager.setVisibility) {
        const showLighting = (finalLayer === 'LightingLayer') && !isMapMakerMode;
        const tool = ui?.controls?.tool?.name ?? game.activeTool;
        const mapshineToolActive = tool === 'map-shine-enhanced-light' || tool === 'map-shine-sun-light';
        lightIconManager.setVisibility(showLighting && !mapshineToolActive);
      }

      if (enhancedLightIconManager && enhancedLightIconManager.setVisibility) {
        const showLighting = (finalLayer === 'LightingLayer') && !isMapMakerMode;
        enhancedLightIconManager.setVisibility(showLighting);
      }

      if (wallManager && wallManager.setVisibility) {
        const showThreeWalls = finalLayer === 'WallsLayer' && !isMapMakerMode;
        wallManager.setVisibility(showThreeWalls);
      }

      if (isEditMode) {
        pixiCanvas.style.pointerEvents = 'auto';
        log.debug(`Input Mode: PIXI (Edit: ${finalLayer})`);
      } else {
        pixiCanvas.style.pointerEvents = 'none'; // Pass through to Three.js
        log.debug(`Input Mode: THREE.js (Gameplay: ${finalLayer})`);
      }
    }, 0);
}

/**
 * Restore Foundry's native PIXI rendering state
 * @private
 */
function restoreFoundryRendering() {
  if (!canvas || !canvas.app) return;

  log.info('Restoring Foundry PIXI rendering');

  // Restore PIXI renderer background to opaque.
  // In Gameplay mode we set it transparent so Three.js can show through.
  // When Three.js is hidden (Map Maker mode), leaving PIXI transparent
  // results in a black screen.
  if (canvas.app?.renderer?.background) {
    canvas.app.renderer.background.alpha = 1;
  }

  // Restore PIXI canvas to default state
  const pixiCanvas = canvas.app.view;
  if (pixiCanvas) {
    pixiCanvas.style.opacity = '1';
    pixiCanvas.style.pointerEvents = 'auto';
    pixiCanvas.style.zIndex = ''; // Reset to default
  }

  // Restore ALL layers (including 'primary' which is critical for V12+)
  if (canvas.background) canvas.background.visible = true;
  if (canvas.grid) canvas.grid.visible = true;
  if (canvas.primary) canvas.primary.visible = true;
  if (canvas.tokens) canvas.tokens.visible = true;
  if (canvas.tiles) canvas.tiles.visible = true;
  if (canvas.lighting) canvas.lighting.visible = true;
  if (canvas.sounds) canvas.sounds.visible = true;
  if (canvas.templates) canvas.templates.visible = true;
  if (canvas.drawings) canvas.drawings.visible = true;
  if (canvas.notes) canvas.notes.visible = true;
  if (canvas.walls) canvas.walls.visible = true;
  if (canvas.weather) canvas.weather.visible = true;
  if (canvas.environment) canvas.environment.visible = true;
  if (canvas.regions) canvas.regions.visible = true;
  if (canvas.fog) canvas.fog.visible = true;
  if (canvas.visibility) canvas.visibility.visible = true;
  
  // Restore visibility filter if it was disabled
  if (canvas.visibility?.filter) {
    canvas.visibility.filter.enabled = true;
  }
  
  // Restore token alphas (they were set to ~0 for Three.js rendering)
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
 * Ensure Foundry UI layers have proper z-index to appear above Three.js canvas
 * @private
 */
function ensureUILayering() {
  log.info('Ensuring UI layering...');
  
  // Strategy: Set high z-index only on peripheral UI elements that don't cover the canvas
  // The main canvas area should remain free for Three.js interaction
  
  // Sidebar and other UI elements (right side - doesn't cover canvas)
  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    sidebar.style.zIndex = '100';
    log.debug('Sidebar z-index set to 100');
  }
  
  // Chat panel (positioned to side, doesn't cover main canvas)
  const chat = document.getElementById('chat');
  if (chat) {
    chat.style.zIndex = '100';
    log.debug('Chat z-index set to 100');
  }
  
  // Players list (top right corner)
  const players = document.getElementById('players');
  if (players) {
    players.style.zIndex = '100';
    log.debug('Players z-index set to 100');
  }
  
  // Hotbar (bottom of screen)
  const hotbar = document.getElementById('hotbar');
  if (hotbar) {
    hotbar.style.zIndex = '100';
    log.debug('Hotbar z-index set to 100');
  }
  
  // Scene controls (left toolbar)
  const controls = document.getElementById('controls');
  if (controls) {
    controls.style.zIndex = '100';
    log.debug('Controls z-index set to 100');
  }
  
  // Navigation bar (top of screen)
  const navigation = document.getElementById('navigation');
  if (navigation) {
    navigation.style.zIndex = '100';
    log.debug('Navigation z-index set to 100');
  }
  
  // HUD Layer (Token HUD, Tile HUD, etc.)
  const hudLayer = document.getElementById('hud');
  if (hudLayer) {
    hudLayer.style.zIndex = '100';
    hudLayer.style.pointerEvents = 'none'; // Container is transparent
    log.debug('HUD layer z-index set to 100');
    
    // Enable pointer events for direct children (the actual HUDs)
    // We can't select them all easily as they are dynamic, but we can set a rule
    // or observer? Or just rely on the HUDs having pointer-events: auto in CSS?
    // Usually Foundry CSS handles this, but if we override the container...
    // Let's force it on children if possible, or assume Foundry CSS is sufficient once container allows it.
    // Actually, setting container to 'none' propagates unless children override it.
    // Foundry's #hud usually has pointer-events: none by default? 
    // Let's just trust standard CSS for children, but ensure container is above canvas.
  }

  // Main UI container - make it transparent to pointer events over canvas area
  // This allows mouse events to pass through to the Three.js canvas
  const uiContainer = document.getElementById('ui');
  if (uiContainer) {
    uiContainer.style.zIndex = '100';
    uiContainer.style.pointerEvents = 'none'; // Make transparent to events
    log.debug('UI container set to pointer-events: none');
    
    // Re-enable pointer events on child elements that need interaction
    const uiChildren = uiContainer.querySelectorAll('#sidebar, #chat, #players, #hotbar, #controls, #navigation');
    uiChildren.forEach(child => {
      child.style.pointerEvents = 'auto';
    });
    log.debug('Re-enabled pointer events on interactive UI children');
  }
  
  log.info('UI layering ensured - peripheral UI at z-index 100, canvas area left interactive');
}

/**
 * Get the current three.js canvas element
 * @returns {HTMLCanvasElement|null}
 * @public
 */
export function getCanvas() {
  return threeCanvas;
}

/**
 * Set up resize handling for the Three.js canvas
 * Uses ResizeObserver for container changes and window resize as fallback
 * @private
 */
function setupResizeHandling() {
  // Clean up any existing handlers first
  cleanupResizeHandling();

  if (!threeCanvas) {
    log.warn('Cannot set up resize handling - no canvas');
    return;
  }

  const container = threeCanvas.parentElement;
  if (!container) {
    log.warn('Cannot set up resize handling - no container');
    return;
  }

  /**
   * Debounced resize handler to avoid excessive updates
   * @param {number} width 
   * @param {number} height 
   */
  const handleResize = (width, height) => {
    // Clear any pending debounce
    if (resizeDebounceTimer) {
      clearTimeout(resizeDebounceTimer);
    }

    // Debounce resize events (16ms = ~60fps, prevents excessive updates during drag)
    resizeDebounceTimer = setTimeout(() => {
      // Validate dimensions
      if (width <= 0 || height <= 0) {
        log.debug(`Ignoring invalid resize dimensions: ${width}x${height}`);
        return;
      }

      // Check if size actually changed
      let currentWidth = 0;
      let currentHeight = 0;
      try {
        // renderer.domElement.width/height are drawing-buffer pixels, which are
        // affected by DPR. For resize decisions we want CSS pixels.
        const THREE = window.THREE;
        const size = (renderer && typeof renderer.getSize === 'function' && THREE)
          ? renderer.getSize(new THREE.Vector2())
          : null;
        currentWidth = size?.x || 0;
        currentHeight = size?.y || 0;
      } catch (_) {
        currentWidth = 0;
        currentHeight = 0;
      }

      if (Math.floor(width) === Math.floor(currentWidth) && Math.floor(height) === Math.floor(currentHeight)) {
        log.debug('Resize skipped - dimensions unchanged');
        return;
      }

      const dpr = window.devicePixelRatio || 1;
      log.info(`Handling resize: ${width}x${height} (DPR: ${dpr})`);
      resize(width, height);
    }, 16);
  };

  // Method 1: ResizeObserver (preferred - handles sidebar, popouts, etc.)
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // Use contentRect for accurate dimensions (excludes padding/border)
        const { width, height } = entry.contentRect;
        handleResize(width, height);
      }
    });

    resizeObserver.observe(container);
    log.debug('ResizeObserver attached to canvas container');
  } else {
    log.warn('ResizeObserver not available - falling back to window resize only');
  }

  // Method 2: Window resize event (fallback and additional coverage)
  windowResizeHandler = () => {
    if (!threeCanvas) return;
    const rect = threeCanvas.getBoundingClientRect();
    handleResize(rect.width, rect.height);
  };

  window.addEventListener('resize', windowResizeHandler);
  log.debug('Window resize listener attached');

  // Method 3: Listen for Foundry sidebar collapse/expand which changes canvas area
  // The 'collapseSidebar' hook fires when sidebar is toggled
  collapseSidebarHookId = Hooks.on('collapseSidebar', () => {
    // Delay slightly to let DOM update
    setTimeout(() => {
      if (threeCanvas) {
        const rect = threeCanvas.getBoundingClientRect();
        handleResize(rect.width, rect.height);
      }
    }, 50);
  });

  log.info('Resize handling initialized');
}

/**
 * Clean up resize handling resources
 * @private
 */
function cleanupResizeHandling() {
  // Clear debounce timer
  if (resizeDebounceTimer) {
    clearTimeout(resizeDebounceTimer);
    resizeDebounceTimer = null;
  }

  // Disconnect ResizeObserver
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
    log.debug('ResizeObserver disconnected');
  }

  // Remove window resize listener
  if (windowResizeHandler) {
    window.removeEventListener('resize', windowResizeHandler);
    windowResizeHandler = null;
    log.debug('Window resize listener removed');
  }

  // Remove collapseSidebar hook
  if (collapseSidebarHookId !== null) {
    Hooks.off('collapseSidebar', collapseSidebarHookId);
    collapseSidebarHookId = null;
    log.debug('collapseSidebar hook removed');
  }
}

/**
 * Handle canvas resize events
 * @param {number} width - New width
 * @param {number} height - New height
 * @public
 */
export function resize(width, height) {
  if (!threeCanvas) return;

  log.debug(`Canvas resized: ${width}x${height}`);

  // Update renderer size
  if (renderer) {
    // Apply effective pixel ratio (Render Resolution preset) while keeping CSS full-screen.
    _applyRenderResolutionToRenderer(width, height);

    // Avoid touching element CSS sizing (we control that via style=100%).
    // WebGLRenderer signature is (w,h,updateStyle). WebGPURenderer ignores the third.
    try {
      renderer.setSize(width, height, false);
    } catch (_) {
      renderer.setSize(width, height);
    }
  }

  // Update scene composer camera
  if (sceneComposer) {
    sceneComposer.resize(width, height);
  }

  // Update effect composer render targets
  if (effectComposer) {
    // EffectComposer expects drawing-buffer pixels.
    try {
      const THREE = window.THREE;
      const size = (renderer && typeof renderer.getDrawingBufferSize === 'function' && THREE)
        ? renderer.getDrawingBufferSize(new THREE.Vector2())
        : null;
      effectComposer.resize(size?.width ?? size?.x ?? width, size?.height ?? size?.y ?? height);
    } catch (_) {
      effectComposer.resize(width, height);
    }
  }
}
