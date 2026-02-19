/**
 * @fileoverview Canvas replacement hooks for Foundry VTT integration
 * Uses Libwrapper to intercept and replace Foundry's canvas rendering
 * @module foundry/canvas-replacement
 */

import { createLogger } from '../core/log.js';
import { safeCall, safeCallAsync, safeDispose, Severity } from '../core/safe-call.js';
import * as sceneSettings from '../settings/scene-settings.js';
import { SceneComposer } from '../scene/composer.js';
import { CameraFollower } from './camera-follower.js';
import { PixiInputBridge } from './pixi-input-bridge.js';
import { CinematicCameraManager } from './cinematic-camera-manager.js';
import { EffectComposer } from '../effects/EffectComposer.js';
// Dependent effects still constructed directly in createThreeCanvas
import { LightingEffect } from '../effects/LightingEffect.js';
import { CandleFlamesEffect } from '../effects/CandleFlamesEffect.js';
import { MaskManager } from '../masks/MaskManager.js';
import { ParticleSystem } from '../particles/ParticleSystem.js';
import { FireSparksEffect } from '../particles/FireSparksEffect.js';
import { AshDisturbanceEffect } from '../particles/AshDisturbanceEffect.js';
import { DustMotesEffect } from '../particles/DustMotesEffect.js';
// Effect wiring — tables, helpers, and re-exported effect classes (for static getControlSchema() calls)
import {
  getIndependentEffectDefs,
  registerAllCapabilities,
  wireGraphicsSettings,
  readLazySkipIds,
  wireBaseMeshes,
  exposeEffectsEarly,
  // Effect classes re-exported for initializeUI's static getControlSchema() calls
  SpecularEffect,
  IridescenceEffect,
  FluidEffect,
  WindowLightEffect,
  ColorCorrectionEffect,
  FilmGrainEffect,
  DotScreenEffect,
  HalftoneEffect,
  SharpenEffect,
  AsciiEffect,
  SmellyFliesEffect,
  LightningEffect,
  PrismEffect,
  WaterEffectV2,
  WorldSpaceFogEffect,
  BushEffect,
  TreeEffect,
  OverheadShadowsEffect,
  BuildingShadowsEffect,
  CloudEffect,
  AtmosphericFogEffect,
  DistortionManager,
  BloomEffect,
  LensflareEffect,
  DazzleOverlayEffect,
  MaskDebugEffect,
  DebugLayerEffect,
  PlayerLightEffect,
  SkyColorEffect,
  VisionModeEffect
} from './effect-wiring.js';
import { RenderLoop } from '../core/render-loop.js';
import { TweakpaneManager } from '../ui/tweakpane-manager.js';
import { ControlPanelManager } from '../ui/control-panel-manager.js';
import { CameraPanelManager } from '../ui/camera-panel-manager.js';
import { LevelNavigatorOverlay } from '../ui/level-navigator-overlay.js';
import { EnhancedLightInspector } from '../ui/enhanced-light-inspector.js';
import { LevelsAuthoringDialog } from '../ui/levels-authoring-dialog.js';
import { TokenManager } from '../scene/token-manager.js';
import { VisibilityController } from '../vision/VisibilityController.js';
import { DetectionFilterEffect } from '../effects/DetectionFilterEffect.js';
import { TileManager } from '../scene/tile-manager.js';
import { TileMotionManager } from '../scene/tile-motion-manager.js';
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
import { clearCache as clearAssetCache, warmupBundleTextures, getCacheStats } from '../assets/loader.js';
import { globalLoadingProfiler } from '../core/loading-profiler.js';
import { debugLoadingProfiler } from '../core/debug-loading-profiler.js';
import { weatherController } from '../core/WeatherController.js';
import { DynamicExposureManager } from '../core/DynamicExposureManager.js';
import { ControlsIntegration } from './controls-integration.js';
import { frameCoordinator } from '../core/frame-coordinator.js';
import { loadingScreenService as loadingOverlay } from '../ui/loading-screen/loading-screen-service.js';
import { stateApplier } from '../ui/state-applier.js';
import { createEnhancedLightsApi } from '../effects/EnhancedLightsApi.js';
import { LightEnhancementStore } from '../effects/LightEnhancementStore.js';
import { OverlayUIManager } from '../ui/overlay-ui-manager.js';
import { LightEditorTweakpane } from '../ui/light-editor-tweakpane.js';
import { EffectCapabilitiesRegistry } from '../effects/effect-capabilities-registry.js';
import { GraphicsSettingsManager } from '../ui/graphics-settings-manager.js';
import { TokenMovementManager } from '../scene/token-movement-manager.js';
import { LoadSession } from '../core/load-session.js';
import { ResizeHandler } from './resize-handler.js';
import { ModeManager } from './mode-manager.js';
import { wireMapPointsToEffects, exposeGlobals } from './manager-wiring.js';
import { DepthPassManager } from '../scene/depth-pass-manager.js';
import {
  detectLevelsRuntimeInteropState,
  enforceMapShineRuntimeAuthority,
  formatLevelsInteropWarning,
} from './levels-compatibility.js';
import { isSoundAudibleForPerspective } from './elevation-context.js';
import { emitModuleConflictWarnings } from './levels-compatibility.js';
import { installLevelsRegionBehaviorCompatPatch } from './region-levels-compat.js';
import { installSnapshotStoreHooks, getSnapshot as getLevelsSnapshot } from '../core/levels-import/LevelsSnapshotStore.js';
import { installLevelsApiFacade } from './levels-api-facade.js';
import { ZoneManager } from './zone-manager.js';
import { LevelsPerspectiveBridge } from './levels-perspective-bridge.js';

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

/** @type {CameraPanelManager|null} */
let cameraPanel = null;

/** @type {LevelNavigatorOverlay|null} */
let levelNavigatorOverlay = null;

/** @type {LevelsPerspectiveBridge|null} - Syncs floor context between MapShine and Levels module */
let levelsPerspectiveBridge = null;

/** @type {CinematicCameraManager|null} */
let cinematicCameraManager = null;

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

  safeCall(() => {
    const baseDpr = window.devicePixelRatio || 1;
    const effective = graphicsSettings?.computeEffectivePixelRatio
      ? graphicsSettings.computeEffectivePixelRatio(viewportWidthCss, viewportHeightCss, baseDpr)
      : baseDpr;
    renderer.setPixelRatio(effective);
  }, 'applyRenderResolution', Severity.DEGRADED);
}

/** @type {EnhancedLightInspector|null} */
let enhancedLightInspector = null;

/** @type {LevelsAuthoringDialog|null} */
let levelsAuthoring = null;

/** @type {OverlayUIManager|null} */
let overlayUIManager = null;

/** @type {LightEditorTweakpane|null} */
let lightEditor = null;

/** @type {TokenManager|null} */
let tokenManager = null;

/** @type {TokenMovementManager|null} */
let tokenMovementManager = null;

/** @type {VisibilityController|null} */
let visibilityController = null;

/** @type {DetectionFilterEffect|null} */
let detectionFilterEffect = null;

/** @type {DynamicExposureManager|null} */
let dynamicExposureManager = null;

/** @type {TileManager|null} */
let tileManager = null;

/** @type {TileMotionManager|null} */
let tileMotionManager = null;

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
  let suppress = safeCall(() => {
    const im = window.MapShine?.interactionManager;
    const enabled = im?.selectionBoxParams?.enabled !== false;
    return !isMapMakerMode && enabled;
  }, 'selectRect.checkSuppression', Severity.COSMETIC, { fallback: !isMapMakerMode });

  if (typeof forceValue === 'boolean') suppress = forceValue;

  // Avoid redundant patching.
  if (_mapShineSelectSuppressed === suppress) return;
  _mapShineSelectSuppressed = suppress;

  safeCall(() => {
    const controls = canvas?.controls;
    if (!controls) return;

    const selectGfx = controls.select;
    const current = controls.drawSelect;

    if (suppress) {
      if (!_mapShineOrigDrawSelect && typeof current === 'function') {
        _mapShineOrigDrawSelect = current.bind(controls);
      }

      controls.drawSelect = ({ x, y, width, height } = {}) => {
        safeCall(() => {
          if (selectGfx?.clear) selectGfx.clear();
          if (selectGfx) selectGfx.visible = false;
        }, 'selectRect.clearGfx', Severity.COSMETIC);
      };

      safeCall(() => {
        if (selectGfx?.clear) selectGfx.clear();
        if (selectGfx) selectGfx.visible = false;
      }, 'selectRect.hideGfx', Severity.COSMETIC);
    } else {
      if (_mapShineOrigDrawSelect) {
        controls.drawSelect = _mapShineOrigDrawSelect;
      }
      safeCall(() => {
        if (selectGfx) selectGfx.visible = true;
      }, 'selectRect.showGfx', Severity.COSMETIC);
    }
  }, 'selectRect.patch', Severity.COSMETIC);
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

/** @type {AshDisturbanceEffect|null} */
let ashDisturbanceEffect = null;

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

/** @type {ResizeHandler|null} */
let resizeHandler = null;

/** @type {ModeManager|null} */
let modeManager = null;

/** @type {DepthPassManager|null} */
let depthPassManager = null;

/** @type {Function|null} */
let _webglContextLostHandler = null;

/** @type {Function|null} */
let _webglContextRestoredHandler = null;

 /** @type {number|null} - Interval ID for weather windvane UI sync */
 let windVaneIntervalId = null;

 /** @type {boolean} */
 let transitionsInstalled = false;

/** @type {number|null} - Safety net timer ID to force-dismiss stuck overlay after tearDown */
let _overlayDismissSafetyTimerId = null;

/** @type {boolean} */
let ambientSoundAudibilityPatched = false;

 /** @type {number|null} - Hook ID for pauseGame listener */
 let pauseGameHookId = null;

/** @type {string|null} Last shown Levels interop warning key (dedupe within session) */
let lastLevelsInteropWarningKey = null;

 function _getActiveSceneForCanvasConfig() {
   return safeCall(() => {
     if (canvas?.scene) return canvas.scene;
     // Different Foundry versions expose the active scene differently.
     return game?.scenes?.current ?? game?.scenes?.active ?? game?.scenes?.viewed ?? null;
   }, 'getActiveSceneForCanvasConfig', Severity.COSMETIC, { fallback: null });
 }

/**
 * Resolve the scene display name for loading UI.
 * Prefer Navigation Name first, then fallback to Scene name.
 *
 * @param {any} scene
 * @returns {string}
 */
function getSceneLoadingDisplayName(scene) {
  const navName = String(scene?.navName || '').trim();
  if (navName) return navName;

  const sceneName = String(scene?.name || '').trim();
  if (sceneName) return sceneName;

  return 'scene';
}

/**
 * Refresh and expose Levels runtime interop diagnostics.
 * In gameplay mode this also enforces Map Shine authority safeguards.
 *
 * @param {{gameplayMode?: boolean, emitWarning?: boolean, reason?: string}} [options]
 * @returns {object}
 */
function refreshLevelsInteropDiagnostics(options = {}) {
  const {
    gameplayMode = false,
    emitWarning = false,
    reason = 'runtime-check',
  } = options;

  const state = gameplayMode
    ? enforceMapShineRuntimeAuthority({ gameplayMode: true })
    : detectLevelsRuntimeInteropState({ gameplayMode: false });

  if (window.MapShine) {
    window.MapShine.levelsInteropDiagnostics = {
      ...state,
      reason,
      timestamp: Date.now(),
    };
  }

  if (emitWarning && state.shouldWarnInGameplay) {
    const warning = formatLevelsInteropWarning(state);
    const warningKey = [
      String(state.mode || ''),
      String(state.levelsModuleActive || false),
      String(state.fogManagerTakeover || false),
      String(state.canvasFogTakeover || false),
      String(state.wrappersLikelyActive || false),
    ].join('|');

    if (warningKey !== lastLevelsInteropWarningKey) {
      lastLevelsInteropWarningKey = warningKey;
      log.warn(`${warning} [reason=${reason}]`, state);
      safeCall(() => ui?.notifications?.warn?.(warning), 'levelsInterop.warnNotification', Severity.COSMETIC);
    }
  }

  return state;
}

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
      safeCall(() => {
        const scene = _getActiveSceneForCanvasConfig();
        if (!scene || !sceneSettings.isEnabled(scene)) return;

        log.info('Configuring PIXI canvas for transparency');
        config.transparent = true;
        config.backgroundAlpha = 0;
      }, 'canvasConfig.transparency', Severity.COSMETIC);
    });
    
    // Hook into canvas ready event (when canvas is fully initialized)
    Hooks.on('canvasReady', onCanvasReady);
    
    // Hook into canvas teardown
    Hooks.on('canvasTearDown', onCanvasTearDown);
    
    // Hook into scene configuration changes (grid, padding, background, etc.)
    Hooks.on('updateScene', onUpdateScene);

    // MS-LVL-042: Recompute ambient sound playback when the active level context
    // changes so audibility gates update immediately.
    Hooks.on('mapShineLevelContextChanged', () => {
      safeCall(() => {
        if (!sceneSettings.isEnabled(canvas?.scene)) return;
        canvas?.sounds?.refresh?.();
      }, 'ambientSound.refreshOnLevelContext', Severity.COSMETIC);
    });

    // Hook into Foundry pause/unpause so we can smoothly ramp time scale to 0 and back.
    if (!pauseGameHookId) {
      pauseGameHookId = Hooks.on('pauseGame', (paused) => {
        safeCall(() => {
          const tm = window.MapShine?.timeManager || effectComposer?.getTimeManager?.();
          if (tm && typeof tm.setFoundryPaused === 'function') {
            tm.setFoundryPaused(!!paused);
          }
        }, 'pauseGame.hook', Severity.COSMETIC);
      });
    }

     // Install transition wrapper so we can fade-to-black BEFORE Foundry tears down the old scene.
     // This must wrap an awaited method (Canvas.tearDown) to actually block the teardown.
     installCanvasTransitionWrapper();

    // MS-LVL-042: Patch Foundry AmbientSound audibility so imported Levels
    // range flags can gate ambient sound playback by elevation in gameplay mode.
    installAmbientSoundAudibilityPatch();

    // MS-LVL-080..082: Intercept imported Levels region executeScript behaviors
    // (stair/stairUp/stairDown/elevator) so they keep functioning in Map Shine
    // gameplay mode without Levels runtime ownership.
    installLevelsRegionBehaviorCompatPatch();

    // MS-LVL-016: Install LevelsSnapshotStore auto-invalidation hooks so the
    // immutable per-scene snapshot is rebuilt when tiles/walls/lights/etc change.
    // The snapshot is exposed on window.MapShine.levelsSnapshot for diagnostics.
    installSnapshotStoreHooks();

    // MS-LVL-090: Install read-only Levels API compatibility facade at
    // CONFIG.Levels.API so third-party modules/macros that call common
    // Levels API methods get correct answers from Map Shine's own data.
    // Only installs when Levels module is not active (avoids conflicts).
    installLevelsApiFacade();

    // MS-LVL-114: Emit one-time warnings for known modules that overlap
    // with Map Shine's Levels compatibility features (e.g., elevatedvision,
    // betterroofs). Only fires when compatibility mode is not 'off'.
    emitModuleConflictWarnings();

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

  safeCall(() => {
    // XM-3: Wrapper function that fades to black before tearDown.
    // Used by both libWrapper and direct-wrap paths.
    const _tearDownWrapper = async function(wrapped, ...args) {
      await safeCallAsync(async () => {
        loadingOverlay.showLoading('Switching scenes…');
        await loadingOverlay.fadeToBlack(2000, 600);
        loadingOverlay.setMessage('Loading…');
        loadingOverlay.setProgress(0, { immediate: true });
      }, 'sceneTransition.fade', Severity.DEGRADED);

      const result = await wrapped(...args);

      // BLANK-CANVAS SAFETY: When canvas.draw(null) is called (scene deleted,
      // deactivated, unviewed, etc.), Foundry's internal #drawBlank() runs
      // instead of the normal draw path. #drawBlank does NOT fire the
      // canvasReady hook, which is the only place Map Shine normally dismisses
      // the loading overlay. Without this check the overlay stays visible
      // forever, locking up the UI.
      // We use queueMicrotask so Foundry's #drawBlank has finished setting
      // canvas state (loading=false, scene=null) before we inspect it.
      queueMicrotask(() => {
        try {
          if (!canvas?.scene && !canvas?.loading) {
            log.info('Blank canvas detected after tearDown — dismissing loading overlay');
            safeCall(() => loadingOverlay.fadeIn(500).catch(() => {}), 'overlay.blankCanvasDismiss', Severity.COSMETIC);
          }
        } catch (_) { /* guard against unexpected canvas state */ }
      });

      return result;
    };

    // XM-3: Prefer libWrapper if available — ensures correct chaining with
    // other modules that also wrap Canvas.tearDown (e.g. scene-packer, etc.)
    if (typeof globalThis.libWrapper === 'function' || globalThis.libWrapper?.register) {
      try {
        libWrapper.register(
          'map-shine-advanced',
          'Canvas.prototype.tearDown',
          _tearDownWrapper,
          'WRAPPER'
        );
        log.info('Installed Canvas.tearDown transition wrapper via libWrapper');
        return;
      } catch (e) {
        log.warn('libWrapper registration failed, falling back to direct wrap:', e);
      }
    }

    // Fallback: direct prototype wrap when libWrapper is not available
    const CanvasCls = globalThis.foundry?.canvas?.Canvas;
    const proto = CanvasCls?.prototype;
    if (!proto?.tearDown) {
      log.warn('Canvas class not available; scene transition wrapper not installed');
      return;
    }

    if (proto.tearDown.__mapShineWrapped) return;

    const original = proto.tearDown;
    const directWrapped = async function(...args) {
      return _tearDownWrapper.call(this, original.bind(this), ...args);
    };

    directWrapped.__mapShineWrapped = true;
    proto.tearDown = directWrapped;
    log.info('Installed Canvas.tearDown transition wrapper (direct prototype wrap)');
  }, 'installCanvasTransitionWrapper', Severity.DEGRADED);
}

function installAmbientSoundAudibilityPatch() {
  if (ambientSoundAudibilityPatched) return;
  const installed = safeCall(() => {
    const AmbientSoundCls = globalThis.CONFIG?.AmbientSound?.objectClass;
    const proto = AmbientSoundCls?.prototype;
    if (!proto) {
      log.warn('AmbientSound class unavailable; audibility patch not installed');
      return false;
    }

    const descriptor = Object.getOwnPropertyDescriptor(proto, 'isAudible');
    if (!descriptor?.get) {
      log.warn('AmbientSound#isAudible getter missing; audibility patch not installed');
      return false;
    }

    if (descriptor.get.__mapShineSoundAudibilityWrapped) {
      return true;
    }

    const originalGetter = descriptor.get;
    const wrappedGetter = function mapShineAmbientSoundIsAudible() {
      const baseAudible = originalGetter.call(this);
      if (!baseAudible) return false;

      // Only apply Levels-style elevation gating in Map Shine gameplay scenes.
      if (!sceneSettings.isEnabled(canvas?.scene)) return baseAudible;

      return safeCall(
        () => isSoundAudibleForPerspective(this?.document),
        'ambientSound.isSoundAudibleForPerspective',
        Severity.COSMETIC,
        { fallback: true }
      );
    };

    wrappedGetter.__mapShineSoundAudibilityWrapped = true;

    Object.defineProperty(proto, 'isAudible', {
      ...descriptor,
      get: wrappedGetter,
    });

    log.info('Installed AmbientSound audibility elevation patch');
    return true;
  }, 'installAmbientSoundAudibilityPatch', Severity.DEGRADED, { fallback: false });

  ambientSoundAudibilityPatched = installed === true;
}

async function waitForThreeFrames(
  renderer,
  renderLoop,
  minFrames = 2,
  timeoutMs = 5000,
  {
    minCalls = 1,
    minDelayMs = 0,
    stableCallsFrames = 2,
    allowHiddenResolve = true
  } = {}
) {
  const _dlp = debugLoadingProfiler;
  const startTime = performance.now();

  const startThreeFrame = renderer?.info?.render?.frame;
  const startLoopFrame = typeof renderLoop?.getFrameCount === 'function' ? renderLoop.getFrameCount() : 0;

  _dlp.event(`waitFrames: start — threeFrame=${startThreeFrame}, loopFrame=${startLoopFrame}, ` +
    `need ${minFrames} frames, ${stableCallsFrames} stable calls, ${minDelayMs}ms delay, timeout=${timeoutMs}ms`);

  // Heartbeat: fires every 2s to prove the event loop is alive.
  // If the event loop is blocked (e.g. by synchronous shader compilation),
  // no heartbeat events will appear — confirming the block.
  let heartbeatCount = 0;
  const heartbeatId = setInterval(() => {
    heartbeatCount++;
    const elapsed = (performance.now() - startTime).toFixed(0);
    const curFrame = renderer?.info?.render?.frame;
    const curLoop = typeof renderLoop?.getFrameCount === 'function' ? renderLoop.getFrameCount() : '?';
    const curCalls = renderer?.info?.render?.calls;
    _dlp.event(`waitFrames: heartbeat #${heartbeatCount} at +${elapsed}ms — ` +
      `threeFrame=${curFrame}, loopFrame=${curLoop}, calls=${curCalls}`);
  }, 2000);

  let callsStable = 0;
  let iterations = 0;

  try {
    while (performance.now() - startTime < timeoutMs) {
      iterations++;
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

      const isHidden = allowHiddenResolve && typeof document !== 'undefined' && document.hidden;

      // Log detailed state on first few iterations and when conditions are close to met
      if (iterations <= 3 || (meetsDelay && (meetsFrames || meetsCalls))) {
        _dlp.event(`waitFrames: iter=${iterations} +${(now - startTime).toFixed(0)}ms — ` +
          `frames=${framesAdvanced}/${minFrames}, calls=${calls}, stable=${callsStable}/${stableCallsFrames}, ` +
          `delay=${meetsDelay}, hidden=${!!isHidden}`);
      }

      if (meetsDelay && meetsFrames && meetsCalls) {
        _dlp.event(`waitFrames: RESOLVED after ${iterations} iterations, ${(now - startTime).toFixed(0)}ms — ` +
          `frames=${framesAdvanced}, stable=${callsStable}`);
        return true;
      }
      if (isHidden && meetsDelay && meetsCalls) {
        _dlp.event(`waitFrames: RESOLVED (hidden tab) after ${iterations} iterations, ${(now - startTime).toFixed(0)}ms`);
        return true;
      }

      // Use Promise.race to ensure we don't hang if tab is backgrounded (rAF pauses)
      await Promise.race([
        new Promise(resolve => requestAnimationFrame(resolve)),
        new Promise(resolve => setTimeout(resolve, 100)) // Fallback: max 100ms per iteration
      ]);
    }

    const elapsed = (performance.now() - startTime).toFixed(0);
    _dlp.event(`waitFrames: TIMED OUT after ${iterations} iterations, ${elapsed}ms — ` +
      `threeFrame=${renderer?.info?.render?.frame}, loopFrame=${typeof renderLoop?.getFrameCount === 'function' ? renderLoop.getFrameCount() : '?'}`, 'warn');
    return false;
  } finally {
    clearInterval(heartbeatId);
  }
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
  safeCall(() => {
    if (!changes?.flags?.['map-shine-advanced']) return;
    const ns = changes.flags['map-shine-advanced'];

    if (Object.prototype.hasOwnProperty.call(ns, 'controlState')) {
      const cs = scene.getFlag('map-shine-advanced', 'controlState');
      if (cs && typeof cs === 'object') {
        safeCall(() => {
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
            safeCall(() => cp.pane?.refresh?.(), 'controlPanel.refresh', Severity.COSMETIC);
          }
        }, 'updateScene.controlState', Severity.DEGRADED);
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
      safeCall(() => uiManager?.updateControlStates?.('weather'), 'updateScene.weatherUI', Severity.COSMETIC);
    }

    if (Object.prototype.hasOwnProperty.call(ns, 'weather-transitionTarget')) {
      weatherController._loadQueuedTransitionTargetFromScene?.();
    }

    if (Object.prototype.hasOwnProperty.call(ns, 'weather-snapshot')) {
      weatherController._loadWeatherSnapshotFromScene?.();
    }
  }, 'updateScene.weatherSync', Severity.DEGRADED);
  
  // Grid changes should NOT require a full Three.js scene rebuild.
  // Rebuilding can race with Foundry's internal canvas updates and briefly leave `canvas.ready=false`,
  // which breaks ControlsIntegration initialization.
  if ('grid' in changes) {
    safeCall(() => gridRenderer?.updateGrid?.(), 'updateScene.gridRefresh', Severity.COSMETIC);
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
  // Clear the tearDown safety net timer — canvasReady fired, so the overlay
  // will be handled by the normal flow below (or dismissed for null scenes).
  if (_overlayDismissSafetyTimerId !== null) {
    clearTimeout(_overlayDismissSafetyTimerId);
    _overlayDismissSafetyTimerId = null;
  }

  const scene = canvas.scene;

  if (!scene) {
    log.debug('onCanvasReady called with no active scene — dismissing overlay');
    // Dismiss the loading overlay even though there's no scene to draw.
    // Without this, the overlay can get stuck if canvasReady fires with null
    // (e.g. edge cases during blank canvas transitions or other module interactions).
    safeCall(() => loadingOverlay.fadeIn(500).catch(() => {}), 'overlay.noScene', Severity.COSMETIC);
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
    
    while (
      !window.MapShine?.initialized &&
      !window.MapShine?.bootstrapComplete &&
      (Date.now() - startTime) < MAX_WAIT_MS
    ) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      
      // Log progress every 2 seconds to show we're still waiting
      if (Date.now() - lastLogTime > 2000) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        log.debug(`Still waiting for bootstrap... (${elapsed}s elapsed)`);
        lastLogTime = Date.now();
      }
    }

    if (!window.MapShine?.initialized) {
      if (window.MapShine?.bootstrapComplete) {
        const err = window.MapShine?.bootstrapError ? ` (${window.MapShine.bootstrapError})` : '';
        log.error(`Bootstrap failed - module did not initialize${err}`);
        ui.notifications.error('Map Shine: Initialization failed. Check console for details.');
        return;
      }

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
      safeCall(() => loadingOverlay.fadeIn(500).catch(() => {}), 'overlay.fadeIn', Severity.COSMETIC);
      return;
    }

    safeCall(() => { if (window.MapShine) window.MapShine.stateApplier = stateApplier; }, 'exposeStateApplier', Severity.COSMETIC);

    if (!uiManager) {
      await safeCallAsync(async () => {
        uiManager = new TweakpaneManager();
        await uiManager.initialize();
        window.MapShine.uiManager = uiManager;
        log.info('Map Shine UI initialized in UI-only mode');
      }, 'uiManager.init(UI-only)', Severity.DEGRADED);
    }

    if (!controlPanel) {
      await safeCallAsync(async () => {
        controlPanel = new ControlPanelManager();
        await controlPanel.initialize();
        window.MapShine.controlPanel = controlPanel;
        log.info('Map Shine Control Panel initialized in UI-only mode');
      }, 'controlPanel.init(UI-only)', Severity.DEGRADED);
    }

    if (!cinematicCameraManager) {
      await safeCallAsync(async () => {
        cinematicCameraManager = new CinematicCameraManager();
        cinematicCameraManager.initialize();
        if (window.MapShine) window.MapShine.cinematicCameraManager = cinematicCameraManager;
        log.info('Cinematic camera manager initialized in UI-only mode');
      }, 'cinematicCamera.init(UI-only)', Severity.DEGRADED);
    }

    if (!cameraPanel) {
      await safeCallAsync(async () => {
        cameraPanel = new CameraPanelManager(cinematicCameraManager);
        cameraPanel.initialize();
        if (window.MapShine) window.MapShine.cameraPanel = cameraPanel;
        log.info('Camera panel initialized in UI-only mode');
      }, 'cameraPanel.init(UI-only)', Severity.DEGRADED);
    } else {
      safeCall(() => {
        cameraPanel.setCinematicManager(cinematicCameraManager);
      }, 'cameraPanel.sync(UI-only)', Severity.COSMETIC);
    }

    if (window.MapShine) {
      window.MapShine.levelNavigatorOverlay = null;
      window.MapShine.levelNavigationDiagnostics = null;
      refreshLevelsInteropDiagnostics({ gameplayMode: false, emitWarning: false, reason: 'ui-only-mode' });
    }

    // Graphics Settings (Essential Feature)
    // Even in UI-only mode, we create the dialog so the scene-control button does not dead-end.
    // In this mode there are no live effects to toggle; the UI will remain minimal.
    await safeCallAsync(async () => {
      if (!effectCapabilitiesRegistry) effectCapabilitiesRegistry = new EffectCapabilitiesRegistry();
      if (!graphicsSettings) {
        graphicsSettings = new GraphicsSettingsManager(null, effectCapabilitiesRegistry, {
          onApplyRenderResolution: () => {
            safeCall(() => {
              if (!threeCanvas) return;
              const rect = threeCanvas.getBoundingClientRect();
              resize(rect.width, rect.height);
            }, 'graphicsSettings.resize', Severity.COSMETIC);
          }
        });
        await graphicsSettings.initialize();
        if (window.MapShine) window.MapShine.graphicsSettings = graphicsSettings;
      }
    }, 'graphicsSettings.init(UI-only)', Severity.DEGRADED);

     // Scene not replaced by Three.js - dismiss the overlay so the user can interact with Foundry normally.
     safeCall(() => loadingOverlay.fadeIn(500).catch(() => {}), 'overlay.fadeIn', Severity.COSMETIC);

    return;
  }

  log.info(`Initializing Map Shine canvas for scene: ${scene.name}`);

  safeCall(() => {
    // Scene name is rendered by the dedicated scene-name element/subtitle when present.
    const displayName = getSceneLoadingDisplayName(scene);
    loadingOverlay.showBlack('Loading…');
    loadingOverlay.setSceneName(displayName);
    loadingOverlay.configureStages([
      { id: 'assets.discover', label: 'Discovering assets…', weight: 5 },
      { id: 'assets.load',     label: 'Loading textures…', weight: 25 },
      { id: 'effects.core',    label: 'Core effects…', weight: 15 },
      { id: 'effects.deps',    label: 'Dependent effects…', weight: 10 },
      { id: 'effects.wire',    label: 'Wiring effects…', weight: 5 },
      { id: 'scene.managers',  label: 'Scene managers…', weight: 15 },
      { id: 'scene.sync',      label: 'Syncing objects…', weight: 15 },
      { id: 'final',           label: 'Finalizing…', weight: 10 },
    ]);
    loadingOverlay.startStages();
    loadingOverlay.setStage('assets.discover', 0.0, undefined, { immediate: true });
    loadingOverlay.startAutoProgress(0.08, 0.02);
  }, 'overlay.configureStages', Severity.COSMETIC);

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
    safeDispose(() => effectComposer.timeManager.pause(), 'timeManager.pause');
  }

  // Dispose frame coordinator (removes PIXI ticker hook)
  if (frameCoordinatorInitialized) {
    safeDispose(() => {
      frameCoordinator.dispose();
      frameCoordinatorInitialized = false;
    }, 'frameCoordinator.dispose');
  }

  if (window.MapShine?.maskManager && typeof window.MapShine.maskManager.dispose === 'function') {
    safeDispose(() => window.MapShine.maskManager.dispose(), 'MaskManager.dispose');
  }

  // Cleanup three.js canvas
  destroyThreeCanvas();
  
  // Clear global references to prevent stale state
  if (window.MapShine) {
    window.MapShine.sceneComposer = null;
    window.MapShine.effectComposer = null;
    window.MapShine.maskManager = null;
    window.MapShine.tokenManager = null;
    window.MapShine.visibilityController = null;
    window.MapShine.detectionFilterEffect = null;
    window.MapShine.tileManager = null;
    window.MapShine.tileMotionManager = null;
    window.MapShine.surfaceRegistry = null;
    window.MapShine.surfaceReport = null;
    window.MapShine.wallManager = null;
    window.MapShine.doorMeshManager = null;
    window.MapShine.fogEffect = null;
    window.MapShine.lightingEffect = null;
    window.MapShine.candleFlamesEffect = null;
    window.MapShine.renderLoop = null;
    window.MapShine.cameraFollower = null;
    window.MapShine.levelNavigationController = null;
    window.MapShine.levelNavigatorOverlay = null;
    window.MapShine.cameraController = null;
    window.MapShine.activeLevelContext = null;
    window.MapShine.availableLevels = null;
    window.MapShine.levelNavigationDiagnostics = null;
    window.MapShine.levelsInteropDiagnostics = null;
    delete window.MapShine.levelsSnapshot;
    window.MapShine.pixiInputBridge = null;
    window.MapShine.interactionManager = null;
    window.MapShine.noteManager = null;
    window.MapShine.gridRenderer = null;
    window.MapShine.mapPointsManager = null;
    window.MapShine.physicsRopeManager = null;
    window.MapShine.cinematicCameraManager = null;
    window.MapShine.cameraPanel = null;
    window.MapShine.frameCoordinator = null;
    window.MapShine.waterEffect = null;
    window.MapShine.distortionManager = null;
    window.MapShine.cloudEffect = null;
    // Keep renderer and capabilities - they're reusable
  }
  candleFlamesEffect = null;

  // SAFETY NET: Schedule a delayed fallback check. If the overlay is still
  // visible after 10 seconds and there's no active scene or loading in
  // progress, force-dismiss it. This catches rare edge cases where the
  // queueMicrotask in the tearDown wrapper (Layer 1) or the onCanvasReady
  // null-scene handler (Layer 2) didn't fire — e.g. errors during draw,
  // unexpected module interactions, or network-induced stalls.
  // Clear any previous safety timer to avoid stacking.
  if (_overlayDismissSafetyTimerId !== null) {
    clearTimeout(_overlayDismissSafetyTimerId);
  }
  _overlayDismissSafetyTimerId = setTimeout(() => {
    _overlayDismissSafetyTimerId = null;
    try {
      // Only dismiss if the canvas is genuinely idle with no scene.
      // If a new scene is loading or already loaded, canvasReady will handle it.
      if (!canvas?.scene && !canvas?.loading) {
        log.warn('Overlay safety net triggered — forcing overlay dismissal (no scene loaded after 10s)');
        safeCall(() => loadingOverlay.fadeIn(300).catch(() => {}), 'overlay.safetyNet', Severity.COSMETIC);
      }
    } catch (_) { /* guard against unexpected state */ }
  }, 10000);
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
  // Section timing for performance diagnosis
  const _sectionTimings = {};
  const _sectionStart = (name) => { _sectionTimings[name] = { start: performance.now() }; };
  const _sectionEnd = (name) => {
    if (_sectionTimings[name]) {
      _sectionTimings[name].end = performance.now();
      _sectionTimings[name].durationMs = _sectionTimings[name].end - _sectionTimings[name].start;
    }
  };
  const _logSectionTimings = () => {
    const entries = Object.entries(_sectionTimings)
      .filter(([, v]) => typeof v.durationMs === 'number')
      .sort((a, b) => b[1].durationMs - a[1].durationMs);
    log.info('createThreeCanvas section timings (slowest first):');
    for (const [name, { durationMs }] of entries) {
      log.info(`  ${name}: ${durationMs.toFixed(1)}ms`);
    }
    window.MapShine._sectionTimings = _sectionTimings;
  };

  // Debug Loading Profiler: when active, forces sequential loading and shows
  // a granular timing log on the loading overlay.
  const dlp = debugLoadingProfiler;
  // Always reset debug callbacks/UI at scene-load start so toggling the setting
  // between loads cannot leave stale handlers or debug UI state behind.
  dlp.onEntryComplete = null;
  dlp.onEntryStart = null;
  safeCall(() => loadingOverlay.disableDebugMode(), 'overlay.disableDebug', Severity.COSMETIC);
  const isDebugLoad = dlp.debugMode;
  if (isDebugLoad) {
    dlp.startSession(scene?.name || 'Unknown');
    // Wire real-time log output to the loading overlay
    dlp.onEntryComplete = (entry) => {
      safeCall(() => loadingOverlay.appendDebugLine(dlp.formatEntryLine(entry)), 'dlp.appendLine', Severity.COSMETIC);
    };
    safeCall(() => loadingOverlay.enableDebugMode(), 'overlay.enableDebug', Severity.COSMETIC);
  }

  _sectionStart('total');
  _sectionStart('cleanup');
  if (isDebugLoad) dlp.begin('cleanup', 'cleanup');
  // Cleanup existing canvas if present
  destroyThreeCanvas();
  // Retry ambient sound patch at scene init time in case early init occurred
  // before CONFIG ambient sound classes were fully available.
  installAmbientSoundAudibilityPatch();
  _sectionEnd('cleanup');
  if (isDebugLoad) dlp.end('cleanup');

  safeCall(() => { if (window.MapShine) window.MapShine.stateApplier = stateApplier; }, 'exposeStateApplier', Severity.COSMETIC);

  // LoadSession replaces the old generation-counter closure.
  // It provides isStale(), AbortSignal, and diagnostics.
  const session = LoadSession.start(scene);

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
    const bootstrapOk = await safeCallAsync(async () => {
      const mod = await import('../core/bootstrap.js');
      const state = await mod.bootstrap({ verbose: false, skipSceneInit: true });
      Object.assign(window.MapShine, state);
      mapShine = window.MapShine;
      return true;
    }, 'lazyBootstrap', Severity.CRITICAL);
    if (!bootstrapOk) return;
    if (session.isStale()) return;
    if (!mapShine.renderer) {
      log.error('Renderer still unavailable after lazy bootstrap. Aborting.');
      return;
    }
  }

  const lp = globalLoadingProfiler;
  const doLoadProfile = !!lp?.enabled;
  if (doLoadProfile) {
    safeCall(() => lp.begin('sceneLoad', { sceneId: scene?.id ?? null, sceneName: scene?.name ?? null }), 'lp.begin(sceneLoad)', Severity.COSMETIC);
  }

  try {
    // Scene updates (like changing grid type/style) can momentarily put the Foundry canvas into
    // a partially-initialized state. Wait for it to be stable before we touch layers or
    // initialize ControlsIntegration.
    if (isDebugLoad) dlp.begin('waitForFoundryCanvas', 'setup');
    const canvasOk = await safeCallAsync(async () => {
      const ok = await _waitForFoundryCanvasReady({ timeoutMs: 15000 });
      if (!ok) {
        log.warn('Foundry canvas not ready after timeout; aborting MapShine scene init');
        return false;
      }
      return true;
    }, 'waitForFoundryCanvas', Severity.DEGRADED, { fallback: true });
    if (isDebugLoad) dlp.end('waitForFoundryCanvas');
    if (canvasOk === false) return;

    if (session.isStale()) return;

    safeCall(() => {
      refreshLevelsInteropDiagnostics({
        gameplayMode: true,
        emitWarning: true,
        reason: 'createThreeCanvas',
      });
    }, 'levelsInterop.createThreeCanvas', Severity.COSMETIC);

    // MS-LVL-016: Eagerly build and expose the LevelsImportSnapshot so it's
    // available for all downstream systems and diagnostics during scene init.
    safeCall(() => {
      if (window.MapShine) {
        // Expose as a getter so it always returns the freshest cached snapshot
        Object.defineProperty(window.MapShine, 'levelsSnapshot', {
          get: () => getLevelsSnapshot(),
          configurable: true,
          enumerable: true,
        });
      }
    }, 'levelsSnapshot.expose', Severity.COSMETIC);

    safeCall(() => {
      // Scene name is rendered by the dedicated scene-name element/subtitle when present.
      const displayName = getSceneLoadingDisplayName(scene);
      loadingOverlay.showBlack('Loading…');
      loadingOverlay.setSceneName(displayName);
      loadingOverlay.configureStages([
        { id: 'assets.discover', label: 'Discovering assets…', weight: 5 },
        { id: 'assets.load',     label: 'Loading textures…', weight: 25 },
        { id: 'effects.core',    label: 'Core effects…', weight: 15 },
        { id: 'effects.deps',    label: 'Dependent effects…', weight: 10 },
        { id: 'effects.wire',    label: 'Wiring effects…', weight: 5 },
        { id: 'scene.managers',  label: 'Scene managers…', weight: 15 },
        { id: 'scene.sync',      label: 'Syncing objects…', weight: 15 },
        { id: 'final',           label: 'Finalizing…', weight: 10 },
      ]);
      loadingOverlay.startStages();
      loadingOverlay.setStage('assets.discover', 0.0, undefined, { immediate: true });
      loadingOverlay.startAutoProgress(0.08, 0.02);
    }, 'overlay.configureStages(create)', Severity.COSMETIC);

    // P0.3: Capture Foundry state before modifying it
    captureFoundryStateSnapshot();

    // Set default mode - actual canvas configuration happens after ControlsIntegration init
    isMapMakerMode = false; // Default to Gameplay Mode

    // Create new canvas element
    if (isDebugLoad) dlp.begin('canvas.create', 'setup');
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
    if (isDebugLoad) dlp.end('canvas.create');
    log.debug('Three.js canvas created and attached as sibling to PIXI canvas');

    // Get renderer from global state and attach its canvas
    if (isDebugLoad) dlp.begin('renderer.attach', 'setup');
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

    safeCall(() => renderer.setSize(rect.width, rect.height, false), 'renderer.setSize', Severity.DEGRADED, {
      onError: () => renderer.setSize(rect.width, rect.height)
    });

    // Robustness: Handle WebGL context loss/restoration.
    // Some UI operations or GPU resets can trigger a context loss; in that case we must
    // stop the RAF loop (otherwise we can wind up in a broken render state) and then
    // attempt to resume when the context restores.
    safeCall(() => {
      _webglContextLostHandler = (ev) => {
        safeCall(() => ev.preventDefault(), 'contextLost.preventDefault', Severity.COSMETIC);
        log.warn('WebGL context lost - pausing render loop');
        safeDispose(() => { if (renderLoop?.running()) renderLoop.stop(); }, 'renderLoop.stop(contextLost)');
      };

      _webglContextRestoredHandler = () => {
        log.info('WebGL context restored - attempting to resume rendering');
        safeCall(() => {
          const r = threeCanvas?.getBoundingClientRect?.();
          if (r && renderer) {
            _applyRenderResolutionToRenderer(r.width, r.height);
            safeCall(() => renderer.setSize(r.width, r.height, false), 'renderer.setSize(restore)', Severity.DEGRADED, {
              onError: () => renderer.setSize(r.width, r.height)
            });
            if (sceneComposer) sceneComposer.resize(r.width, r.height);
            if (effectComposer) {
              const buf = safeCall(() => {
                const THREE = window.THREE;
                return (renderer && typeof renderer.getDrawingBufferSize === 'function' && THREE)
                  ? renderer.getDrawingBufferSize(new THREE.Vector2())
                  : null;
              }, 'getDrawingBufferSize', Severity.COSMETIC, { fallback: null });
              effectComposer.resize(buf?.width ?? buf?.x ?? r.width, buf?.height ?? buf?.y ?? r.height);
            }
          }
        }, 'contextRestore.resize', Severity.DEGRADED);

        safeCall(() => {
          if (renderLoop && !renderLoop.running()) renderLoop.start();
        }, 'renderLoop.start(contextRestore)', Severity.DEGRADED);
      };

      threeCanvas.addEventListener('webglcontextlost', _webglContextLostHandler, false);
      threeCanvas.addEventListener('webglcontextrestored', _webglContextRestoredHandler, false);
    }, 'registerWebGLContextHandlers', Severity.DEGRADED);

    if (isDebugLoad) dlp.end('renderer.attach');

    // Ensure regions outside the Foundry world bounds remain black; padded region is covered by a background plane
    if (renderer.setClearColor) {
      renderer.setClearColor(0x000000, 1);
    }

    // Step 1: Initialize scene composer
    _sectionStart('sceneComposer.initialize');
    if (isDebugLoad) dlp.begin('sceneComposer.initialize', 'texture');
    dlp.event('sceneComposer: BEGIN — loading masks + textures');
    sceneComposer = new SceneComposer();
    if (doLoadProfile) safeCall(() => lp.begin('sceneComposer.initialize'), 'lp.begin', Severity.COSMETIC);
    const { scene: threeScene, camera, bundle } = await sceneComposer.initialize(
      scene,
      rect.width,
      rect.height,
      {
        onProgress: (loaded, total, asset) => {
          safeCall(() => {
            const denom = total > 0 ? total : 1;
            const v = Math.max(0, Math.min(1, loaded / denom));
            loadingOverlay.setStage('assets.load', v, `Loading ${asset}…`, { keepAuto: true });
          }, 'overlay.assetProgress', Severity.COSMETIC);
        }
      }
    );
    if (doLoadProfile) safeCall(() => lp.end('sceneComposer.initialize'), 'lp.end', Severity.COSMETIC);
    if (isDebugLoad) dlp.end('sceneComposer.initialize', { masks: bundle?.masks?.length ?? 0 });
    dlp.event(`sceneComposer: DONE — ${bundle?.masks?.length ?? 0} masks loaded`);
    _sectionEnd('sceneComposer.initialize');

    // Capture asset cache stats for the debug profiler
    if (isDebugLoad) {
      safeCall(() => {
        const cs = getCacheStats();
        const isFirstLoad = cs.hits === 0 && cs.misses <= 1;
        dlp.addDiagnostic('Asset Cache Stats', {
          'Bundles cached': cs.size,
          'Cache hits': cs.hits,
          'Cache misses': cs.misses,
          'Hit rate': cs.hitRate || '—',
          'Bundle keys': cs.bundles.length > 0 ? cs.bundles.map(k => k.split('/').pop()).join(', ') : '(empty)',
          'Note': isFirstLoad
            ? 'First load — MISS is expected. Cache is in-memory only (survives scene transitions, not page reloads). Switch scenes and return to test cache HIT.'
            : 'Return visit — cache should HIT if masks are still valid.'
        });
        // Log bundle mask details
        if (bundle?.masks?.length) {
          const maskInfo = bundle.masks.map(m => {
            const t = m?.texture;
            const w = t?.image?.width ?? '?';
            const h = t?.image?.height ?? '?';
            const cs = t?.colorSpace || '?';
            return `${m.id} ${w}x${h} ${cs}`;
          });
          dlp.addDiagnostic('Scene Bundle', {
            'Base path': bundle.basePath || '—',
            'Mask count': bundle.masks.length,
            'Masks': maskInfo.join(' | ')
          });
        }
      }, 'dlp.cacheStats', Severity.COSMETIC);

      // GPU / renderer diagnostics — static hardware info captured early.
      // Dynamic counts (programs, textures, materials) are in the Resource
      // Snapshot and shader compile event log (captured after effects init).
      safeCall(() => {
        const gl = renderer?.getContext?.();
        const gpuDiag = {};
        if (gl) {
          const dbgInfo = gl.getExtension('WEBGL_debug_renderer_info');
          if (dbgInfo) {
            gpuDiag['GPU Vendor'] = gl.getParameter(dbgInfo.UNMASKED_VENDOR_WEBGL) || '?';
            gpuDiag['GPU Renderer'] = gl.getParameter(dbgInfo.UNMASKED_RENDERER_WEBGL) || '?';
          }
          gpuDiag['WebGL Version'] = gl.getParameter(gl.VERSION) || '?';
          gpuDiag['Max Texture Size'] = gl.getParameter(gl.MAX_TEXTURE_SIZE);
          const parallelCompile = gl.getExtension('KHR_parallel_shader_compile');
          gpuDiag['KHR_parallel_shader_compile'] = parallelCompile ? 'YES' : 'NO (sync compile fallback)';
        }
        dlp.addDiagnostic('GPU / Renderer', gpuDiag);
      }, 'dlp.gpuDiagnostic', Severity.COSMETIC);
    }

    if (session.isStale()) {
      safeDispose(() => destroyThreeCanvas(), 'destroyThreeCanvas(stale)');
      return;
    }

    log.info(`Scene composer initialized with ${bundle.masks.length} effect masks`);

    // Eagerly upload all mask textures to the GPU during loading.
    // Without this, Three.js defers gl.texImage2D to the first render frame,
    // causing a massive stall (potentially hundreds of ms for 10+ large masks).
    _sectionStart('gpu.textureWarmup');
    if (isDebugLoad) dlp.begin('gpu.textureWarmup', 'texture');
    safeCall(() => {
      const warmupResult = warmupBundleTextures(renderer, bundle, (uploaded, total) => {
        safeCall(() => loadingOverlay.setStage('assets.load', 1.0, `GPU upload ${uploaded}/${total}…`, { keepAuto: true }), 'overlay.gpuWarmup', Severity.COSMETIC);
      });
      if (warmupResult.totalMs > 50) {
        log.info(`GPU texture warmup took ${warmupResult.totalMs.toFixed(0)}ms for ${warmupResult.uploaded} textures`);
      }
    }, 'gpu.textureWarmup', Severity.DEGRADED);
    if (isDebugLoad) dlp.end('gpu.textureWarmup');
    _sectionEnd('gpu.textureWarmup');

    // CRITICAL: Expose sceneComposer early so effects can access groundZ during initialization
    mapShine.sceneComposer = sceneComposer;

    if (isDebugLoad) dlp.begin('maskManager.register', 'texture');
    mapShine.maskManager = new MaskManager();
    mapShine.maskManager.setRenderer(renderer);
    safeCall(() => {
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
    }, 'MaskManager.registerBundleMasks', Severity.DEGRADED);
    if (isDebugLoad) dlp.end('maskManager.register');

    // Wire the _Outdoors (roof/indoor) mask into the WeatherController so
    // precipitation effects (rain, snow, puddles) can respect covered areas.
    safeCall(() => {
      if (bundle?.masks?.length) {
        const outdoorsMask = bundle.masks.find(m => m.id === 'outdoors' || m.type === 'outdoors');
        if (outdoorsMask?.texture && weatherController?.setRoofMap) {
          weatherController.setRoofMap(outdoorsMask.texture);
          log.info('WeatherController roof map set from _Outdoors mask texture');
        } else {
          log.debug('No _Outdoors mask texture found for this scene');
        }
      }
    }, 'weatherController.setRoofMap', Severity.DEGRADED);

    // Step 2: Initialize effect composer
    if (isDebugLoad) dlp.begin('effectComposer.initialize', 'setup');
    effectComposer = new EffectComposer(renderer, threeScene, camera);
    effectComposer.initialize(mapShine.capabilities);
    if (isDebugLoad) dlp.end('effectComposer.initialize');

    // Ensure TimeManager immediately matches Foundry's current pause state.
    safeCall(() => {
      const paused = game?.paused ?? false;
      effectComposer.getTimeManager()?.setFoundryPaused?.(paused, 0);
    }, 'timeManager.syncPause', Severity.COSMETIC);

    // Initialize module-wide depth pass manager.
    // Must be after effectComposer (uses renderer/scene/camera) and MaskManager (publishes depth texture).
    if (isDebugLoad) dlp.begin('depthPassManager.init', 'setup');
    safeCall(() => {
      if (depthPassManager) {
        safeDispose(() => { effectComposer?.removeUpdatable?.(depthPassManager); }, 'removeUpdatable(depthPass)');
        safeDispose(() => depthPassManager.dispose(), 'depthPassManager.dispose(reinit)');
      }
      depthPassManager = new DepthPassManager();
      depthPassManager.initialize(renderer, threeScene, camera);
      depthPassManager.setMaskManager(mapShine.maskManager);
      effectComposer.addUpdatable(depthPassManager);
      effectComposer.setDepthPassManager(depthPassManager);
      if (window.MapShine) window.MapShine.depthPassManager = depthPassManager;
    }, 'DepthPassManager.init', Severity.DEGRADED);
    if (isDebugLoad) dlp.end('depthPassManager.init');

    safeCall(() => {
      loadingOverlay.setStage('effects.core', 0.0, 'Initializing effects…', { immediate: true });
      loadingOverlay.startAutoProgress(0.55, 0.015);
    }, 'overlay.effectsCore', Severity.COSMETIC);

    // Progress tracker for dependent effects (Phase 2).
    // Independent effects use registerEffectBatch with its own onProgress.
    let _depEffectIndex = 0;
    const _depEffectTotal = 7; // Particles, Fire, Dust, Ash, LightEnhancementStore, Lighting, CandleFlames
    const _setEffectInitStep = (label) => {
      _depEffectIndex++;
      const t = Math.max(0, Math.min(1, _depEffectIndex / _depEffectTotal));
      safeCall(() => loadingOverlay.setStage('effects.deps', t, `Initializing ${label}…`, { keepAuto: true }), 'overlay.depEffect', Severity.COSMETIC);
    };

    // Ensure WeatherController is initialized and driven by the centralized TimeManager.
    // This allows precipitation, wind, etc. to update every frame and drive GPU effects
    // like the particle-based weather system without requiring manual console snippets.
    if (isDebugLoad) dlp.begin('weatherController.initialize', 'weather');
    await weatherController.initialize();
    if (isDebugLoad) dlp.end('weatherController.initialize');

    safeCall(() => effectComposer.addUpdatable(weatherController), 'effectComposer.addUpdatable(weather)', Severity.DEGRADED);

    safeCall(() => loadingOverlay.setStage('effects.core', 0.02, 'Initializing weather…', { keepAuto: true }), 'overlay.weather', Severity.COSMETIC);

    if (session.isStale()) {
      safeDispose(() => destroyThreeCanvas(), 'destroyThreeCanvas(stale)');
      return;
    }

    // P1.2: Parallel Effect Initialization via registerEffectBatch().
    // All independent effects are constructed first (synchronous), then their
    // initialize() calls run concurrently with a concurrency limit of 4 to
    // avoid GPU/driver contention from too many simultaneous shader compilations.
    // Map insertion order is preserved so render order is deterministic.
    _sectionStart('effectInit');
    const effectMap = new Map();

    const independentEffectDefs = getIndependentEffectDefs();

    // Construct all effect instances (synchronous) and build name→instance map
    const effectInstances = [];
    const nameByEffectId = new Map();
    for (const [name, EffectClass] of independentEffectDefs) {
      const effect = new EffectClass();
      effectInstances.push(effect);
      effectMap.set(name, effect);
      nameByEffectId.set(effect.id, name);
    }

    // P2.1: Pre-read graphics settings from localStorage to find disabled effects.
    // Effects the user has disabled don't need shader compilation during loading —
    // they'll be lazily initialized if the user re-enables them later.
    const lazySkipIds = readLazySkipIds();

    // Initialize effects. In debug mode, concurrency is forced to 1 (sequential)
    // so that per-effect timings are accurate and not overlapping.
    // Normal mode uses concurrency=4 for faster loading.
    const effectConcurrency = isDebugLoad ? 1 : 4;
    const _batchStartMs = performance.now();
    dlp.event(`effectInit: BEGIN — ${effectInstances.length} effects, concurrency=${effectConcurrency}, lazy-skip=${lazySkipIds?.size ?? 0}`);
    const batchResult = await effectComposer.registerEffectBatch(effectInstances, {
      concurrency: effectConcurrency,
      skipIds: lazySkipIds,
      onProgress: (completed, total, effectId) => {
        const t = Math.max(0, Math.min(1, completed / total));
        const label = nameByEffectId.get(effectId) || effectId;
        safeCall(() => loadingOverlay.setStage('effects.core', t, `Initialized ${label}…`, { keepAuto: true }), 'overlay.effectBatch', Severity.COSMETIC);
      }
    });

    dlp.event(`effectInit: DONE — ${batchResult?.registered?.length ?? 0} registered, ${batchResult?.deferred?.length ?? 0} deferred, ${(performance.now() - _batchStartMs).toFixed(0)}ms`);

    // Log per-effect timings (top 10 slowest) and feed into debug profiler
    safeCall(() => {
      const effectTimings = (batchResult?.timings || [])
        .map(t => ({ name: nameByEffectId.get(t.id) || t.id, durationMs: t.durationMs, id: t.id }))
        .sort((a, b) => b.durationMs - a.durationMs);
      const top10 = effectTimings.slice(0, 10);
      const deferredCount = batchResult?.deferred?.length || 0;
      log.info(`Effect batch init: ${batchResult.registered.length} registered, ${deferredCount} deferred (lazy), ${batchResult.skipped.length} skipped (concurrency=${effectConcurrency})`);
      log.info('Effect init timings (top 10 slowest):');
      for (const { name, durationMs } of top10) {
        log.info(`  ${name}: ${durationMs.toFixed(1)}ms`);
      }
      window.MapShine._effectInitTimings = effectTimings;

      // Add effect batch summary to debug profiler diagnostics
      if (isDebugLoad) {
        const deferredCount = batchResult?.deferred?.length || 0;
        const skippedCount = batchResult?.skipped?.length || 0;
        dlp.addDiagnostic('Effect Batch Init', {
          'Registered': batchResult?.registered?.length ?? 0,
          'Deferred (lazy)': deferredCount > 0 ? `${deferredCount} [${batchResult.deferred.join(', ')}]` : '0',
          'Skipped': skippedCount > 0 ? `${skippedCount} [${batchResult.skipped.join(', ')}]` : '0',
          'Concurrency': effectConcurrency,
          'Lazy skip IDs': lazySkipIds?.size > 0 ? Array.from(lazySkipIds).join(', ') : '(none)',
          'Total batch time': `${(performance.now() - _batchStartMs).toFixed(0)}ms`
        });
      }

      // Feed individual effect timings into the debug profiler for the log.
      // The batch result only contains { id, durationMs } per effect. Since debug
      // mode forces concurrency=1 (sequential), we compute approximate start times
      // by accumulating durations from the batch start timestamp.
      if (isDebugLoad && batchResult?.timings) {
        let cursor = _batchStartMs;
        for (const t of batchResult.timings) {
          const displayName = nameByEffectId.get(t.id) || t.id;
          const entryId = `effect.${displayName}.initialize`;
          const dur = t.durationMs ?? 0;
          const entry = {
            id: entryId,
            category: 'effect',
            startMs: cursor,
            endMs: cursor + dur,
            durationMs: dur,
            meta: null
          };
          cursor += dur;
          dlp.entries.push(entry);
          if (dlp.onEntryComplete) {
            try { dlp.onEntryComplete(entry); } catch (_) {}
          }
        }
      }
    }, 'logEffectTimings', Severity.COSMETIC);
    _sectionEnd('effectInit');
    
    // Switch to wiring/graphics-settings stage
    safeCall(() => loadingOverlay.setStage('effects.wire', 0.0, 'Wiring effects…', { keepAuto: true }), 'overlay.wire', Severity.COSMETIC);

    const specularEffect = effectMap.get('Specular');
    const iridescenceEffect = effectMap.get('Iridescence');
    const windowLightEffect = effectMap.get('Window Lights');
    const colorCorrectionEffect = effectMap.get('Color Correction');
    const filmGrainEffect = effectMap.get('Film Grain');
    const dotScreenEffect = effectMap.get('Dot Screen');
    const halftoneEffect = effectMap.get('Halftone');
    const sharpenEffect = effectMap.get('Sharpen');
    const asciiEffect = effectMap.get('ASCII');
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
    const dazzleOverlayEffect = effectMap.get('Dazzle Overlay');
    const maskDebugEffect = effectMap.get('Mask Debug');
    const debugLayerEffect = effectMap.get('Debug Layers');
    const playerLightEffect = effectMap.get('Player Lights');
    const skyColorEffect_temp = effectMap.get('Sky Color');

    // --- Graphics Settings (Essential Feature) ---
    // Create once per canvas lifecycle, register known effects, and expose globally.
    if (isDebugLoad) dlp.begin('graphicsSettings.init', 'graphics');
    safeCall(() => {
      if (!effectCapabilitiesRegistry) effectCapabilitiesRegistry = new EffectCapabilitiesRegistry();
      registerAllCapabilities(effectCapabilitiesRegistry);
    }, 'registerEffectCapabilities', Severity.DEGRADED);

    await safeCallAsync(async () => {
      if (!graphicsSettings) {
        graphicsSettings = new GraphicsSettingsManager(effectComposer, effectCapabilitiesRegistry, {
          onApplyRenderResolution: () => {
            safeCall(() => {
              if (!threeCanvas) return;
              const rect = threeCanvas.getBoundingClientRect();
              resize(rect.width, rect.height);
            }, 'graphicsSettings.resize', Severity.COSMETIC);
          }
        });
        await graphicsSettings.initialize();
        if (window.MapShine) window.MapShine.graphicsSettings = graphicsSettings;
      }

      // Wire all effect instances so the manager can toggle them safely.
      wireGraphicsSettings(graphicsSettings, effectMap);
    }, 'graphicsSettings.initAndWire', Severity.DEGRADED);
    if (isDebugLoad) dlp.end('graphicsSettings.init');

    // Assign to module-level variables for later reference
    lightningEffect = lightningEffect_temp;
    fogEffect = fogEffect_temp;
    skyColorEffect = skyColorEffect_temp;

    // Expose a subset of effects on window.MapShine early — needed by cross-references
    exposeEffectsEarly(window.MapShine, effectMap);

    // Phase 2: Register dependent effects sequentially (must maintain order)
    safeCall(() => loadingOverlay.setStage('effects.deps', 0.0, 'Initializing particles…', { keepAuto: true }), 'overlay.deps', Severity.COSMETIC);

    // Step 3.8: Register Particle System (must be before FireSparksEffect)
    _setEffectInitStep('Particles');
    if (isDebugLoad) dlp.begin('effect.ParticleSystem.register', 'effect');
    const particleSystem = new ParticleSystem();
    await effectComposer.registerEffect(particleSystem);
    if (isDebugLoad) dlp.end('effect.ParticleSystem.register');

    // Step 3.9: Register Fire Sparks Effect (depends on ParticleSystem)
    _setEffectInitStep('Fire');
    if (isDebugLoad) dlp.begin('effect.FireSparks.register', 'effect');
    const fireSparksEffect = new FireSparksEffect();
    fireSparksEffect.setParticleSystem(particleSystem);
    await effectComposer.registerEffect(fireSparksEffect);
    if (bundle) {
      fireSparksEffect.setAssetBundle(bundle);
    }
    if (isDebugLoad) dlp.end('effect.FireSparks.register');

    safeCall(() => { graphicsSettings?.registerEffectInstance('fire-sparks', fireSparksEffect); graphicsSettings?.applyOverrides?.(); }, 'gfx.register(fire-sparks)', Severity.COSMETIC);

    // Step 3.10: Register Dust Motes (can use particle system if needed)
    _setEffectInitStep('Dust Motes');
    if (isDebugLoad) dlp.begin('effect.DustMotes.register', 'effect');
    const dustMotesEffect = new DustMotesEffect();
    await effectComposer.registerEffect(dustMotesEffect);
    if (bundle) {
      dustMotesEffect.setAssetBundle(bundle);
    }
    if (isDebugLoad) dlp.end('effect.DustMotes.register');

    safeCall(() => { graphicsSettings?.registerEffectInstance('dust-motes', dustMotesEffect); graphicsSettings?.applyOverrides?.(); }, 'gfx.register(dust-motes)', Severity.COSMETIC);

    // Step 3.11: Register Ash Disturbance (token movement bursts)
    _setEffectInitStep('Ash Disturbance');
    if (isDebugLoad) dlp.begin('effect.AshDisturbance.register', 'effect');
    ashDisturbanceEffect = new AshDisturbanceEffect();
    await effectComposer.registerEffect(ashDisturbanceEffect);
    if (bundle) {
      ashDisturbanceEffect.setAssetBundle(bundle);
    }
    if (isDebugLoad) dlp.end('effect.AshDisturbance.register');

    safeCall(() => { graphicsSettings?.registerEffectInstance('ash-disturbance', ashDisturbanceEffect); graphicsSettings?.applyOverrides?.(); }, 'gfx.register(ash-disturbance)', Severity.COSMETIC);

    // Step 3.12: Register Smelly Flies (depends on ParticleSystem for BatchedRenderer)
    _setEffectInitStep('Smelly Flies');
    if (isDebugLoad) dlp.begin('effect.SmellyFlies.register', 'effect');
    const smellyFliesEffect = new SmellyFliesEffect();
    await effectComposer.registerEffect(smellyFliesEffect);
    if (isDebugLoad) dlp.end('effect.SmellyFlies.register');

    safeCall(() => { graphicsSettings?.registerEffectInstance('smelly-flies', smellyFliesEffect); graphicsSettings?.applyOverrides?.(); }, 'gfx.register(smelly-flies)', Severity.COSMETIC);

    // Step 3.13.5: Initialize LightEnhancementStore BEFORE LightingEffect
    // CRITICAL: The enhancement store must be created and loaded before LightingEffect.initialize()
    // runs, otherwise the first syncAllLights() will fail to apply cookie enhancements.
    // See docs/LIGHT-COOKIE-RESET-ISSUE.md for full analysis.
    _setEffectInitStep('Light Enhancement Store');
    if (isDebugLoad) dlp.begin('effect.LightEnhancementStore.init', 'effect');
    await safeCallAsync(async () => {
      mapShine.lightEnhancementStore = new LightEnhancementStore();
      await mapShine.lightEnhancementStore.load?.();
      log.info('LightEnhancementStore loaded before LightingEffect');
    }, 'LightEnhancementStore.init', Severity.DEGRADED, {
      onError: () => { mapShine.lightEnhancementStore = null; }
    });
    if (isDebugLoad) dlp.end('effect.LightEnhancementStore.init');

    // Step 3.14: Register Lighting Effect (must be before CandleFlamesEffect)
    _setEffectInitStep('Lighting');
    if (isDebugLoad) dlp.begin('effect.Lighting.register', 'effect');
    lightingEffect = new LightingEffect();
    await effectComposer.registerEffect(lightingEffect);
    if (window.MapShine) window.MapShine.lightingEffect = lightingEffect;
    if (isDebugLoad) dlp.end('effect.Lighting.register');

    safeCall(() => { graphicsSettings?.registerEffectInstance('lighting', lightingEffect); graphicsSettings?.applyOverrides?.(); }, 'gfx.register(lighting)', Severity.COSMETIC);

    // Step 3.15: Register Candle Flames (depends on LightingEffect)
    _setEffectInitStep('Candle Flames');
    if (isDebugLoad) dlp.begin('effect.CandleFlames.register', 'effect');
    const candleFlamesEffect = new CandleFlamesEffect();
    candleFlamesEffect.setLightingEffect(lightingEffect);
    await effectComposer.registerEffect(candleFlamesEffect);
    if (window.MapShine) window.MapShine.candleFlamesEffect = candleFlamesEffect;
    if (isDebugLoad) dlp.end('effect.CandleFlames.register');

    safeCall(() => { graphicsSettings?.registerEffectInstance('candle-flames', candleFlamesEffect); graphicsSettings?.applyOverrides?.(); }, 'gfx.register(candle-flames)', Severity.COSMETIC);

    // Add dependent effects to the shared effectMap so initializeUI and
    // cross-wiring code can access all effects by display name.
    effectMap.set('Particle System', particleSystem);
    effectMap.set('Fire Sparks', fireSparksEffect);
    effectMap.set('Dust Motes', dustMotesEffect);
    effectMap.set('Ash Disturbance', ashDisturbanceEffect);
    effectMap.set('Smelly Flies', smellyFliesEffect);
    effectMap.set('Lighting', lightingEffect);
    effectMap.set('Candle Flames', candleFlamesEffect);

    if (session.isStale()) {
      safeDispose(() => destroyThreeCanvas(), 'destroyThreeCanvas(stale)');
      return;
    }

    // Provide the base mesh and asset bundle to surface/environmental effects
    const basePlane = sceneComposer.getBasePlane();

    _sectionStart('setBaseMesh');
    if (isDebugLoad) dlp.begin('wireBaseMeshes', 'sync');
    wireBaseMeshes(effectMap, basePlane, bundle, (label, dt) => {
      log.info(`  setBaseMesh(${label}): ${dt.toFixed(1)}ms`);
    });
    if (isDebugLoad) dlp.end('wireBaseMeshes');
    _sectionEnd('setBaseMesh');

    _sectionStart('sceneSync');
    safeCall(() => {
      loadingOverlay.setStage('scene.managers', 0.0, 'Syncing scene…', { immediate: true });
      loadingOverlay.startAutoProgress(0.85, 0.012);
    }, 'overlay.sceneManagers', Severity.COSMETIC);

    if (session.isStale()) {
      safeDispose(() => destroyThreeCanvas(), 'destroyThreeCanvas(stale)');
      return;
    }

    // Step 3b: Initialize grid renderer
    if (isDebugLoad) dlp.begin('manager.Grid.init', 'manager');
    gridRenderer = new GridRenderer(threeScene);
    gridRenderer.initialize();
    gridRenderer.updateGrid();
    safeCall(() => { if (effectComposer) effectComposer.addUpdatable(gridRenderer); }, 'addUpdatable(grid)', Severity.COSMETIC);
    if (isDebugLoad) dlp.end('manager.Grid.init');
    log.info('Grid renderer initialized');

    safeCall(() => loadingOverlay.setStage('scene.managers', 0.25, 'Syncing grid…', { keepAuto: true }), 'overlay.grid', Severity.COSMETIC);

    // Step 4: Initialize token manager
    if (isDebugLoad) dlp.begin('manager.TokenManager.init', 'manager');
    tokenManager = new TokenManager(threeScene);
    tokenManager.setEffectComposer(effectComposer); // Connect to main loop
    tokenManager.initialize();
    if (isDebugLoad) dlp.end('manager.TokenManager.init');

    // Sync existing tokens immediately (we're already in canvasReady, so the hook won't fire)
    if (isDebugLoad) dlp.begin('manager.TokenManager.syncAll', 'sync');
    tokenManager.syncAllTokens();
    if (isDebugLoad) dlp.end('manager.TokenManager.syncAll');
    log.info('Token manager initialized and synced');

    // Step 4 (cont): Initialize visibility controller — delegates to Foundry's
    // testVisibility() so we get full detection mode / status effect parity for free.
    if (isDebugLoad) dlp.begin('manager.VisibilityController.init', 'manager');
    safeCall(() => {
      if (visibilityController) visibilityController.dispose();
      visibilityController = new VisibilityController(tokenManager);
      visibilityController.initialize();
    }, 'VisibilityController.init', Severity.DEGRADED);
    if (isDebugLoad) dlp.end('manager.VisibilityController.init');

    // Step 4 (cont): Detection filter rendering — glow/outline on tokens
    // detected via special detection modes (tremorsense, see invisible, etc.)
    if (isDebugLoad) dlp.begin('manager.DetectionFilter.init', 'manager');
    safeCall(() => {
      if (detectionFilterEffect) detectionFilterEffect.dispose();
      detectionFilterEffect = new DetectionFilterEffect(tokenManager, visibilityController);
      detectionFilterEffect.initialize();
      effectComposer.addUpdatable(detectionFilterEffect);
    }, 'DetectionFilterEffect.init', Severity.COSMETIC);
    if (isDebugLoad) dlp.end('manager.DetectionFilter.init');

    // CRITICAL: Expose managers on window.MapShine so other subsystems
    // (e.g. TokenManager.updateSpriteVisibility) can check VC state.
    // Without this, the VC early-return path is never taken and
    // refreshToken hooks constantly override sprite.visible.
    if (window.MapShine) {
      window.MapShine.tokenManager = tokenManager;
      window.MapShine.visibilityController = visibilityController;
      window.MapShine.detectionFilterEffect = detectionFilterEffect;
    }

    // Step 4a: Dynamic Exposure Manager (token-based eye adaptation)
    if (isDebugLoad) dlp.begin('manager.DynamicExposure.init', 'manager');
    safeCall(() => {
      if (!dynamicExposureManager) {
        dynamicExposureManager = new DynamicExposureManager({
          renderer,
          camera,
          weatherController,
          tokenManager,
          colorCorrectionEffect
        });
      } else {
        dynamicExposureManager.renderer = renderer;
        dynamicExposureManager.camera = camera;
        dynamicExposureManager.setWeatherController?.(weatherController);
        dynamicExposureManager.setTokenManager?.(tokenManager);
        dynamicExposureManager.setColorCorrectionEffect?.(colorCorrectionEffect);
      }

      effectComposer.addUpdatable(dynamicExposureManager);
      if (window.MapShine) window.MapShine.dynamicExposureManager = dynamicExposureManager;
    }, 'DynamicExposureManager.init', Severity.DEGRADED);
    if (isDebugLoad) dlp.end('manager.DynamicExposure.init');

    safeCall(() => loadingOverlay.setStage('scene.sync', 0.0, 'Syncing tokens…', { keepAuto: true }), 'overlay.tokens', Severity.COSMETIC);

    // Step 4b: Initialize tile manager
    if (isDebugLoad) dlp.begin('manager.TileManager.init', 'manager');
    tileManager = new TileManager(threeScene);
    tileManager.setSpecularEffect(specularEffect);
    tileManager.setFluidEffect(window.MapShine?.fluidEffect ?? effectMap.get('Fluid') ?? null);
    // Route water occluder meshes into DistortionManager's dedicated scene so
    // the occluder render pass avoids traversing the full world scene.
    safeCall(() => tileManager.setWaterOccluderScene(distortionManager?.waterOccluderScene ?? null), 'tileManager.setWaterOccluder', Severity.COSMETIC);
    tileManager.initialize();
    if (isDebugLoad) dlp.end('manager.TileManager.init');
    if (isDebugLoad) dlp.begin('manager.TileManager.syncAll', 'sync');
    tileManager.syncAllTiles();
    tileManager.setWindowLightEffect(windowLightEffect); // Link for overhead tile lighting
    effectComposer.addUpdatable(tileManager); // Register for occlusion updates
    if (isDebugLoad) dlp.end('manager.TileManager.syncAll');
    log.info('Tile manager initialized and synced');

    // Step 4b.1: Initialize tile motion runtime manager
    if (isDebugLoad) dlp.begin('manager.TileMotion.init', 'manager');
    tileMotionManager = new TileMotionManager(tileManager);
    await tileMotionManager.initialize();
    effectComposer.addUpdatable(tileMotionManager);
    if (window.MapShine) window.MapShine.tileMotionManager = tileMotionManager;
    if (isDebugLoad) dlp.end('manager.TileMotion.init');
    log.info('Tile motion manager initialized');

    safeCall(() => loadingOverlay.setStage('scene.sync', 0.35, 'Syncing tiles…', { keepAuto: true }), 'overlay.tiles', Severity.COSMETIC);

    if (isDebugLoad) dlp.begin('manager.SurfaceRegistry.init', 'manager');
    surfaceRegistry = new SurfaceRegistry();
    surfaceRegistry.initialize({ sceneComposer, tileManager });
    mapShine.surfaceRegistry = surfaceRegistry;
    mapShine.surfaceReport = surfaceRegistry.refresh();
    if (isDebugLoad) dlp.end('manager.SurfaceRegistry.init');

    // Step 4c: Initialize wall manager
    if (isDebugLoad) dlp.begin('manager.WallManager.init', 'manager');
    wallManager = new WallManager(threeScene);
    wallManager.initialize();
    if (isDebugLoad) dlp.end('manager.WallManager.init');
    // Sync happens in initialize
    log.info('Wall manager initialized');

    // Step 4d: Initialize token movement manager (movement styles + path policies)
    if (isDebugLoad) dlp.begin('manager.TokenMovement.init', 'manager');
    if (tokenMovementManager) {
      safeDispose(() => {
        effectComposer?.removeUpdatable?.(tokenMovementManager);
        tokenMovementManager.dispose();
      }, 'tokenMovementManager.dispose(reinit)');
    }
    tokenMovementManager = new TokenMovementManager({ tokenManager, wallManager });
    tokenMovementManager.initialize();
    tokenManager.setMovementManager(tokenMovementManager);
    effectComposer.addUpdatable(tokenMovementManager);
    if (window.MapShine) window.MapShine.tokenMovementManager = tokenMovementManager;
    if (isDebugLoad) dlp.end('manager.TokenMovement.init');
    log.info('Token movement manager initialized');

    safeCall(() => loadingOverlay.setStage('scene.sync', 0.55, 'Syncing walls…', { keepAuto: true }), 'overlay.walls', Severity.COSMETIC);

    // P1.3: Parallel initialization of independent lightweight managers.
    // These managers only create THREE objects and register Foundry hooks — they
    // don't depend on each other or on tokens/tiles/walls, so it's safe to run
    // them concurrently. MapPointsManager is async and included in the batch.
    safeCall(() => loadingOverlay.setStage('scene.sync', 0.7, 'Syncing remaining objects…', { keepAuto: true }), 'overlay.remaining', Severity.COSMETIC);

    doorMeshManager = new DoorMeshManager(threeScene, sceneComposer.camera);
    drawingManager = new DrawingManager(threeScene);
    noteManager = new NoteManager(threeScene);
    templateManager = new TemplateManager(threeScene);
    lightIconManager = new LightIconManager(threeScene);
    enhancedLightIconManager = new EnhancedLightIconManager(threeScene);
    mapPointsManager = new MapPointsManager(threeScene);

    if (isDebugLoad) {
      // Debug mode: initialize managers sequentially for accurate per-manager timing
      const lightweightManagers = [
        ['manager.DoorMesh.init', doorMeshManager],
        ['manager.Drawing.init', drawingManager],
        ['manager.Note.init', noteManager],
        ['manager.Template.init', templateManager],
        ['manager.LightIcon.init', lightIconManager],
        ['manager.EnhancedLightIcon.init', enhancedLightIconManager],
        ['manager.MapPoints.init', mapPointsManager],
      ];
      for (const [id, mgr] of lightweightManagers) {
        dlp.begin(id, 'manager');
        await Promise.resolve(mgr.initialize());
        dlp.end(id);
      }
    } else {
      // Normal mode: initialize all in parallel (most are synchronous; mapPointsManager is async)
      await Promise.all([
        Promise.resolve(doorMeshManager.initialize()),
        Promise.resolve(drawingManager.initialize()),
        Promise.resolve(noteManager.initialize()),
        Promise.resolve(templateManager.initialize()),
        Promise.resolve(lightIconManager.initialize()),
        Promise.resolve(enhancedLightIconManager.initialize()),
        mapPointsManager.initialize(),
      ]);
    }

    effectComposer.addUpdatable(doorMeshManager);
    log.info('Parallel manager batch initialized (Door, Drawing, Note, Template, LightIcon, EnhancedLightIcon, MapPoints)');

    // Wire map points to particle effects (fire, candle flame, smelly flies, etc.)
    wireMapPointsToEffects(effectMap, mapPointsManager);

    // Step 4i: Initialize physics ropes (rope/chain map points)
    if (isDebugLoad) dlp.begin('manager.PhysicsRope.init', 'manager');
    physicsRopeManager = new PhysicsRopeManager(threeScene, sceneComposer, mapPointsManager);
    physicsRopeManager.initialize();
    effectComposer.addUpdatable(physicsRopeManager);
    mapShine.physicsRopeManager = physicsRopeManager;
    if (isDebugLoad) dlp.end('manager.PhysicsRope.init');
    log.info('Physics rope manager initialized');

    // Step 5: Initialize interaction manager (Selection, Drag/Drop)
    if (isDebugLoad) dlp.begin('manager.Interaction.init', 'manager');
    interactionManager = new InteractionManager(threeCanvas, sceneComposer, tokenManager, tileManager, wallManager, lightIconManager);
    interactionManager.initialize();
    effectComposer.addUpdatable(interactionManager); // Register for updates (HUD positioning)
    if (isDebugLoad) dlp.end('manager.Interaction.init');
    log.info('Interaction manager initialized');

    // Wire token movement hook for ash disturbance.
    // MUST be after InteractionManager.initialize() which also registers a listener.
    safeCall(() => {
      tokenManager.addOnTokenMovementStart((tokenId) => {
        ashDisturbanceEffect?.handleTokenMovement?.(tokenId);
      });
    }, 'wireAshDisturbance', Severity.COSMETIC);

    // Sync Selection Box UI params (loaded from scene settings) into the InteractionManager.
    // initializeUI() runs earlier during startup, before InteractionManager exists.
    safeCall(() => {
      const sel = uiManager?.effectFolders?.selectionBox;
      const params = sel?.params;
      if (params && typeof params === 'object') {
        for (const [k, v] of Object.entries(params)) {
          if (typeof interactionManager.applySelectionBoxParamChange === 'function') {
            interactionManager.applySelectionBoxParamChange(k, v);
          }
        }
      }
    }, 'syncSelectionBoxParams', Severity.COSMETIC);

    // Ensure Foundry's native PIXI selection rectangle is suppressed in Gameplay mode.
    // (In Map Maker mode, we want the native selection box.)
    if (modeManager) {
      modeManager.updateSelectRectSuppression();
    } else {
      _updateFoundrySelectRectSuppression();
    }

    // Step 5b: Initialize DOM overlay UI system (world-anchored overlays)
    if (isDebugLoad) dlp.begin('manager.OverlayUI.init', 'manager');
    overlayUIManager = new OverlayUIManager(threeCanvas, sceneComposer);
    overlayUIManager.initialize();
    effectComposer.addUpdatable(overlayUIManager);
    if (isDebugLoad) dlp.end('manager.OverlayUI.init');

    if (isDebugLoad) dlp.begin('manager.LightEditor.init', 'manager');
    lightEditor = new LightEditorTweakpane(overlayUIManager);
    lightEditor.initialize();
    if (isDebugLoad) dlp.end('manager.LightEditor.init');

    safeCall(() => effectComposer.addUpdatable(lightEditor), 'addUpdatable(lightEditor)', Severity.COSMETIC);

    // Expose for InteractionManager selection routing and debugging.
    if (window.MapShine) {
      window.MapShine.interactionManager = interactionManager;
      window.MapShine.overlayUIManager = overlayUIManager;
      window.MapShine.lightEditor = lightEditor;
      window.MapShine.noteManager = noteManager;
    }

    // Step 5c: Initialize zone manager (bespoke stair/elevator zones)
    safeCall(() => {
      const zm = new ZoneManager();
      zm.initialize(sceneComposer, interactionManager);
      if (window.MapShine) window.MapShine.zoneManager = zm;
      log.info('Zone manager initialized');
    }, 'ZoneManager.init', Severity.DEGRADED);

    // Step 6: Initialize drop handler (for creating new items)
    if (isDebugLoad) dlp.begin('manager.DropHandler.init', 'manager');
    dropHandler = new DropHandler(threeCanvas, sceneComposer);
    dropHandler.initialize();
    if (isDebugLoad) dlp.end('manager.DropHandler.init');
    log.info('Drop handler initialized');

    // Step 6: Initialize Camera Follower
    // Simple one-way sync: Three.js camera follows PIXI camera each frame.
    // PIXI/Foundry handles all pan/zoom input - we just read and match.
    // This eliminates bidirectional sync issues and race conditions.
    if (isDebugLoad) dlp.begin('manager.CameraFollower.init', 'manager');
    cameraFollower = new CameraFollower({ sceneComposer });
    cameraFollower.initialize();
    effectComposer.addUpdatable(cameraFollower); // Per-frame sync
    safeCall(() => {
      if (window.MapShine) {
        window.MapShine.levelNavigationController = cameraFollower;
      }
    }, 'exposeLevelNavigationController', Severity.COSMETIC);
    if (isDebugLoad) dlp.end('manager.CameraFollower.init');
    log.info('Camera follower initialized - Three.js follows PIXI');

    // Step 6.05: Compact level navigator overlay (always visible on levels-enabled scenes).
    if (isDebugLoad) dlp.begin('manager.LevelNavigatorOverlay.init', 'manager');
    if (!levelNavigatorOverlay && overlayUIManager) {
      levelNavigatorOverlay = new LevelNavigatorOverlay(overlayUIManager, cameraFollower);
      levelNavigatorOverlay.initialize();
    } else {
      levelNavigatorOverlay?.setLevelNavigationController?.(cameraFollower);
    }
    safeCall(() => {
      if (window.MapShine) window.MapShine.levelNavigatorOverlay = levelNavigatorOverlay;
    }, 'exposeLevelNavigatorOverlay', Severity.COSMETIC);
    if (isDebugLoad) dlp.end('manager.LevelNavigatorOverlay.init');

    // Step 6.06: Initialize Levels Perspective Bridge.
    // Syncs floor context bidirectionally between MapShine and the Levels module
    // so movement, vision, and wall filtering all use the same elevation.
    safeCall(() => {
      if (levelsPerspectiveBridge) {
        levelsPerspectiveBridge.dispose();
      }
      levelsPerspectiveBridge = new LevelsPerspectiveBridge();
      levelsPerspectiveBridge.initialize();
      if (window.MapShine) window.MapShine.levelsPerspectiveBridge = levelsPerspectiveBridge;
      log.info('Levels perspective bridge initialized');
    }, 'LevelsPerspectiveBridge.init', Severity.DEGRADED);

    // Step 6a: Initialize PIXI Input Bridge
    // Handles pan/zoom input on Three canvas and applies to PIXI stage.
    // CameraFollower then reads PIXI state and updates Three camera.
    if (isDebugLoad) dlp.begin('manager.PixiInputBridge.init', 'manager');
    pixiInputBridge = new PixiInputBridge(threeCanvas);
    pixiInputBridge.initialize();
    safeCall(() => {
      if (window.MapShine) {
        // Legacy alias used by several interaction paths to temporarily disable camera input while dragging.
        window.MapShine.cameraController = pixiInputBridge;
      }
    }, 'exposeLegacyCameraControllerAlias', Severity.COSMETIC);
    if (isDebugLoad) dlp.end('manager.PixiInputBridge.init');
    log.info('PIXI input bridge initialized - pan/zoom updates PIXI stage');

    // Step 6a.5: Initialize cinematic camera manager
    if (isDebugLoad) dlp.begin('manager.CinematicCamera.init', 'manager');
    if (!cinematicCameraManager) {
      cinematicCameraManager = new CinematicCameraManager({
        pixiInputBridge,
        sceneComposer,
      });
      cinematicCameraManager.initialize();
    } else {
      cinematicCameraManager.setDependencies({
        pixiInputBridge,
        sceneComposer,
      });
    }
    safeCall(() => {
      effectComposer?.removeUpdatable?.(cinematicCameraManager);
      effectComposer?.addUpdatable?.(cinematicCameraManager);
    }, 'cinematicCamera.updatable', Severity.COSMETIC);
    if (window.MapShine) window.MapShine.cinematicCameraManager = cinematicCameraManager;
    if (isDebugLoad) dlp.end('manager.CinematicCamera.init');
    log.info('Cinematic camera manager initialized');

    // Step 6b: Initialize controls integration (PIXI overlay system)
    if (isDebugLoad) dlp.begin('manager.ControlsIntegration.init', 'manager');
    controlsIntegration = new ControlsIntegration({ 
      sceneComposer,
      effectComposer
    });
    {
      const ok = await controlsIntegration.initialize();
      if (!ok) throw new Error('ControlsIntegration initialization failed');
    }
    if (isDebugLoad) dlp.end('manager.ControlsIntegration.init');
    
    log.info('Controls integration initialized');

    dlp.event('sceneSync: DONE — entering finalization');
    _sectionEnd('sceneSync');
    _sectionStart('finalization');
    safeCall(() => {
      loadingOverlay.setStage('final', 0.0, 'Finalizing…', { immediate: true });
      loadingOverlay.startAutoProgress(0.98, 0.01);
    }, 'overlay.final', Severity.COSMETIC);

    // Step 7: Create ModeManager and ensure Foundry UI layers are above our canvas
    if (modeManager) {
      safeDispose(() => modeManager.dispose(), 'modeManager.dispose');
    }
    modeManager = new ModeManager({
      threeCanvas,
      renderLoop: null, // set after renderLoop is created below
      controlsIntegration,
      tileManager,
      wallManager,
      lightIconManager,
      enhancedLightIconManager
    });
    modeManager.ensureUILayering();

    // Step 7.5: Progressive shader warmup.
    //
    // Renders each effect one at a time through the EffectComposer pipeline,
    // calling gl.finish() after each to force synchronous compilation, then
    // yielding to the event loop so the loading overlay can update with
    // per-effect progress.  This replaces the old monolithic
    // effectComposer.render(0) which blocked the main thread for 50+ seconds
    // with zero feedback.
    _sectionStart('gpu.shaderCompile');
    if (isDebugLoad) dlp.begin('gpu.shaderCompile', 'gpu');
    safeCall(() => loadingOverlay.setStage('final', 0.05, 'Compiling shaders…', { keepAuto: true }), 'overlay.shaderCompile', Severity.COSMETIC);
    {
      const gl = renderer.getContext?.();
      const hasParallelCompile = !!gl?.getExtension?.('KHR_parallel_shader_compile');
      const startPrograms = Array.isArray(renderer.info?.programs) ? renderer.info.programs.length : 0;

      dlp.event(`gpu.shaderCompile: BEGIN — progressive warmup, ${startPrograms} programs already compiled, ` +
        `KHR_parallel_shader_compile=${hasParallelCompile ? 'YES' : 'NO'}`);
      if (!hasParallelCompile) {
        dlp.event('gpu.shaderCompile: WARNING — KHR_parallel_shader_compile not available. ' +
          'Each shader compiles synchronously (~500-1500ms on ANGLE/older GPUs).', 'warn');
      }

      try {
        const result = await effectComposer.progressiveWarmup(({ step, totalSteps, effectId, type, timeMs, newPrograms, totalPrograms }) => {
          // Per-effect diagnostic line in the event log
          const tag = newPrograms > 0
            ? `+${newPrograms} prog → ${totalPrograms}`
            : `(no new, ${totalPrograms} total)`;
          dlp.event(`shader.warmup[${step}/${totalSteps}]: ${effectId} (${type}) — ${timeMs.toFixed(0)}ms ${tag}`);

          // Update the loading overlay so the user sees progress
          safeCall(() => {
            const pct = 0.05 + 0.85 * (step / totalSteps);
            loadingOverlay.setStage('final', pct,
              `Compiling shaders (${step}/${totalSteps})…`, { keepAuto: true });
          }, 'overlay.shaderProgress', Severity.COSMETIC);
        });

        dlp.event(`gpu.shaderCompile: COMPLETE — ${result.totalMs.toFixed(0)}ms, ` +
          `${result.programsCompiled} new programs, ${result.totalPrograms} total`);
        log.info(`Shader compilation: ${result.totalMs.toFixed(0)}ms ` +
          `(${result.programsCompiled} new, ${result.totalPrograms} total programs)`);
      } catch (e) {
        dlp.event(`gpu.shaderCompile: ERROR — ${e?.message}`, 'error');
        log.warn('Progressive shader warmup failed:', e);
      }
    }
    if (isDebugLoad) dlp.end('gpu.shaderCompile');
    _sectionEnd('gpu.shaderCompile');

    // Step 8: Start render loop
    renderLoop = new RenderLoop(renderer, threeScene, camera, effectComposer);
    renderLoop.start();
    // Update ModeManager with the now-created renderLoop reference
    if (modeManager) modeManager._deps.renderLoop = renderLoop;

    dlp.event('renderLoop: STARTED — first rAF frame queued');
    log.info('Render loop started');

    // Step 8.5: Set up resize handling via extracted ResizeHandler
    if (resizeHandler) {
      safeDispose(() => resizeHandler.dispose(), 'resizeHandler.dispose');
    }
    resizeHandler = new ResizeHandler({
      canvas: threeCanvas,
      renderer,
      sceneComposer,
      effectComposer,
      graphicsSettings
    });
    resizeHandler.setup();

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
        // Register fog effect for synchronized vision rendering.
        // This runs AFTER Foundry's PIXI tick has recomputed LOS polygons,
        // so token.vision.los is guaranteed to be fresh.
        frameCoordinator.onPostPixi((frameState) => {
          const fog = fogEffect;
          if (!fog) return;
          // The git version uses _needsVisionUpdate + _renderVisionMask() in update().
          // Just mark it dirty so the next Three.js render picks up fresh LOS data.
          if (typeof fog.syncVisionFromPixi === 'function') {
            fog.syncVisionFromPixi();
          } else if (fog._needsVisionUpdate !== undefined) {
            fog._needsVisionUpdate = true;
          }
        });
        
        log.info('Frame coordinator initialized - PIXI/Three.js sync enabled');
      } else {
        log.warn('Frame coordinator failed to initialize - fog may lag during rapid camera movement');
      }
    }
    mapShine.frameCoordinator = frameCoordinator;

    // Notify WorldSpaceFogEffect when Foundry fog is reset via UI (Lighting controls).
    // Foundry's reset button calls canvas.fog.reset() → canvas.fog._handleReset().
    // Foundry handles clearing its own exploration textures natively; we just notify
    // the effect so it can log/respond if needed.
    safeCall(() => {
      const fogMgr = canvas?.fog;
      if (fogMgr && typeof fogMgr._handleReset === 'function' && !fogMgr._mapShineWrappedHandleReset) {
        const originalHandleReset = fogMgr._handleReset.bind(fogMgr);
        fogMgr._handleReset = async (...args) => {
          const result = await originalHandleReset(...args);
          safeCall(() => {
            const fog = window.MapShine?.fogEffect;
            if (fog && typeof fog.resetExploration === 'function') {
              fog.resetExploration();
            }
          }, 'fogReset.exploration', Severity.COSMETIC);
          return result;
        };
        fogMgr._mapShineWrappedHandleReset = true;
      }

      // Suppress Foundry's native fog commit/save when our WorldSpaceFogEffect
      // is active. The native PIXI fog pipeline tries to extract and compress
      // fog buffers, but since we've taken over fog rendering with Three.js,
      // those PIXI textures are in a bad state and cause IndexSizeError crashes.
      // We handle fog persistence ourselves via _saveExplorationToFoundry().
      if (fogMgr && typeof fogMgr.commit === 'function' && !fogMgr._mapShineWrappedCommit) {
        const originalCommit = fogMgr.commit.bind(fogMgr);
        fogMgr.commit = function(...args) {
          // Only suppress if our fog effect is initialized and enabled
          const fog = window.MapShine?.fogEffect;
          if (fog?._initialized && fog?.params?.enabled) return;
          return originalCommit(...args);
        };
        fogMgr._mapShineWrappedCommit = true;
      }
      if (fogMgr && typeof fogMgr.save === 'function' && !fogMgr._mapShineWrappedSave) {
        const originalSave = fogMgr.save.bind(fogMgr);
        fogMgr.save = async function(...args) {
          const fog = window.MapShine?.fogEffect;
          if (fog?._initialized && fog?.params?.enabled) return;
          return originalSave(...args);
        };
        fogMgr._mapShineWrappedSave = true;
      }
    }, 'wrapFogManager', Severity.DEGRADED);

    // Expose all managers, effects, and functions on window.MapShine for diagnostics
    exposeGlobals(mapShine, {
      effectMap,
      sceneComposer, effectComposer, cameraFollower, pixiInputBridge,
      cinematicCameraManager, cameraPanel, levelsAuthoring,
      levelNavigatorOverlay,
      tokenManager, tokenMovementManager, tileManager, visibilityController, detectionFilterEffect,
      wallManager, doorMeshManager,
      drawingManager, noteManager, templateManager, lightIconManager,
      enhancedLightIconManager, enhancedLightInspector, interactionManager,
      overlayUIManager, lightEditor, gridRenderer, mapPointsManager,
      tileMotionManager,
      weatherController, renderLoop, sceneDebug, controlsIntegration,
      dynamicExposureManager, physicsRopeManager,
      setMapMakerMode, resetScene, isMapMakerMode
    });

    // Dev authoring API for MapShine-native enhanced lights (scene-flag stored).
    mapShine.enhancedLights = safeCall(() => createEnhancedLightsApi(), 'createEnhancedLightsApi', Severity.DEGRADED, { fallback: null });

    // Attach to canvas as well for convenience (used by console snippets)
    safeCall(() => { canvas.mapShine = mapShine; }, 'canvas.mapShine', Severity.COSMETIC);

    // Ensure initial light gizmo visibility is correct. ControlsIntegration computes
    // visibility based on active layer/tool, but it can run before managers are
    // attached to window.MapShine during startup.
    safeCall(() => controlsIntegration?._updateThreeGizmoVisibility?.(), 'gizmoVisibility.init', Severity.COSMETIC);

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
    _sectionStart('fin.initializeUI');
    if (isDebugLoad) dlp.begin('fin.initializeUI', 'finalize');
    await safeCallAsync(async () => {
      if (session.isStale()) return;
      await initializeUI(effectMap);

      // Ensure the scene loads with the last persisted weather snapshot even if UI initialization
      // (Control Panel / Tweakpane) applied other defaults during startup.
      weatherController._loadWeatherSnapshotFromScene?.();
    }, 'initializeUI', Severity.DEGRADED);
    if (isDebugLoad) dlp.end('fin.initializeUI');
    _sectionEnd('fin.initializeUI');

    // Only begin fading-in once we have proof that Three has actually rendered.
    // This prevents the overlay from fading out during shader compilation / first-frame stutter.
    safeCall(() => {
      loadingOverlay.setStage('final', 0.4, 'Finalizing…', { keepAuto: true });
      loadingOverlay.startAutoProgress(0.995, 0.008);
    }, 'overlay.finalProgress', Severity.COSMETIC);

    // P1.2: Wait for all effects to be ready before fading overlay
    // This ensures textures are loaded and GPU operations are complete
    _sectionStart('fin.effectReadiness');
    if (isDebugLoad) dlp.begin('fin.effectReadiness', 'finalize');
    safeCall(() => loadingOverlay.setStage('final', 0.45, 'Finishing textures…', { keepAuto: true }), 'overlay.textures', Severity.COSMETIC);
    await safeCallAsync(async () => {
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
    }, 'effectReadinessWait', Severity.COSMETIC);
    if (isDebugLoad) dlp.end('fin.effectReadiness');
    _sectionEnd('fin.effectReadiness');

    // P1.3: Tile loading is NON-BLOCKING.
    // Tiles load in the background and appear when their fetch/decode completes.
    // We do NOT await tiles because:
    //   1. The server may take 56+ seconds to respond (observed on mythicamachina.com)
    //   2. During the await, Foundry's PIXI render loop starves setTimeout callbacks
    //      (10s timer fires 46s late), making any timeout mechanism unreliable
    //   3. Overhead/decorative tiles are not required for an interactive scene
    // The tile textures will pop in when ready — this is acceptable vs a 60s stall.
    _sectionStart('fin.waitForTiles');
    safeCall(() => loadingOverlay.setStage('final', 0.50, 'Preparing tiles…', { keepAuto: true }), 'overlay.prepareTiles', Severity.COSMETIC);
    {
      const pendingAll = tileManager?._initialLoad?.pendingAll ?? 0;
      const totalTracked = tileManager?._initialLoad?.trackedIds?.size ?? 0;
      dlp.event(`fin.waitForTiles: SKIPPED (non-blocking) — ${pendingAll} tile(s) loading in background`);
      if (isDebugLoad) {
        dlp.begin('fin.waitForTiles', 'finalize', { pending: pendingAll, tracked: totalTracked });
        dlp.end('fin.waitForTiles', { pendingAfter: pendingAll, skipped: true });

        if (pendingAll > 0) {
          dlp.addDiagnostic('Tile Wait', {
            'Strategy': 'Non-blocking (tiles load in background)',
            'Pending tiles': pendingAll,
            'Tile names': Array.from(tileManager?._initialLoad?.trackedIds ?? []).map(id => {
              const data = tileManager?.tileSprites?.get(id);
              return data?.tileDoc?.texture?.src?.split('/').pop() || id;
            }).join(', '),
            'Note': 'Tiles appear when server responds. No loading stall.'
          });
        }
      }
    }
    _sectionEnd('fin.waitForTiles');

    // With shaders pre-compiled (Step 7.5), the first render frame should be
    // fast (~10-50ms). We only need 3 stable frames to confirm the renderer is
    // healthy — down from 6 frames / 12s timeout when compilation happened here.
    _sectionStart('fin.waitForThreeFrames');
    if (isDebugLoad) dlp.begin('fin.waitForThreeFrames', 'finalize');
    {
      const FRAME_WAIT_HARD_TIMEOUT_MS = 5000;
      let frameTimedOut = false;
      dlp.event('fin.waitForThreeFrames: BEGIN');
      await safeCallAsync(async () => {
        const framePromise = waitForThreeFrames(renderer, renderLoop, 3, 4000, {
          minCalls: 1,
          stableCallsFrames: 2,
          minDelayMs: 200
        });
        // Hard timeout safety net — if the event loop is blocked by something
        // unexpected (late tile decode, other module work), Promise.race exits.
        const hardTimeout = new Promise(r => setTimeout(() => {
          frameTimedOut = true;
          dlp.event('fin.waitForThreeFrames: HARD TIMEOUT — 5s cap reached', 'warn');
          r(false);
        }, FRAME_WAIT_HARD_TIMEOUT_MS));
        await Promise.race([framePromise, hardTimeout]);
      }, 'waitForThreeFrames', Severity.COSMETIC);
      dlp.event(`fin.waitForThreeFrames: DONE (hardTimedOut=${frameTimedOut})`);
      if (isDebugLoad) dlp.end('fin.waitForThreeFrames', { hardTimedOut: frameTimedOut });
    }
    _sectionEnd('fin.waitForThreeFrames');

    if (isDebugLoad) dlp.begin('fin.timeOfDay', 'finalize');
    await safeCallAsync(async () => {
      const controlHour = window.MapShine?.controlPanel?.controlState?.timeOfDay;
      const hour = Number.isFinite(controlHour) ? controlHour : Number(weatherController?.timeOfDay);
      if (Number.isFinite(hour)) {
        await stateApplier.applyTimeOfDay(hour, false, true);
        safeCall(() => {
          const cloudEffect = window.MapShine?.cloudEffect;
          if (cloudEffect) {
            if (typeof cloudEffect.requestRecompose === 'function') cloudEffect.requestRecompose(3);
            if (typeof cloudEffect.requestUpdate === 'function') cloudEffect.requestUpdate(3);
          }
        }, 'cloudEffect.recompose', Severity.COSMETIC);
      }
    }, 'timeOfDay.refresh', Severity.COSMETIC);
    if (isDebugLoad) dlp.end('fin.timeOfDay');

    _sectionStart('fin.fadeIn');
    dlp.event('fin.fadeIn: loading pipeline complete — preparing overlay transition');

    // Debug loading mode: capture resource snapshot, generate the full log,
    // replace it in the overlay, and show the dismiss button instead of auto-fading.
    if (isDebugLoad) {
      safeCall(() => dlp.captureResourceSnapshot(renderer, bundle), 'dlp.captureResources', Severity.COSMETIC);
      dlp.endSession();

      // Replace the real-time log with the full formatted report (includes summary)
      const fullLog = dlp.generateLog();
      safeCall(() => loadingOverlay.setDebugLog(fullLog), 'dlp.setFullLog', Severity.COSMETIC);

      const elapsed = loadingOverlay.getElapsedSeconds();
      const readyMsg = elapsed > 0 ? `Debug load complete (${elapsed.toFixed(1)}s) — review log below` : 'Debug load complete — review log below';
      safeCall(() => loadingOverlay.setStage('final', 1.0, readyMsg, { immediate: true }), 'overlay.debugReady', Severity.COSMETIC);

      // Show dismiss button; clicking it triggers the normal fadeIn
      safeCall(() => loadingOverlay.showDebugDismiss(), 'overlay.showDismiss', Severity.COSMETIC);

      // Expose the profiler on window.MapShine for console access
      if (window.MapShine) window.MapShine.debugLoadingProfiler = dlp;
    } else {
      await safeCallAsync(async () => {
        const elapsed = loadingOverlay.getElapsedSeconds();
        const readyMsg = elapsed > 0 ? `Ready! (${elapsed.toFixed(1)}s)` : 'Ready!';
        loadingOverlay.setStage('final', 1.0, readyMsg, { immediate: true });
        await loadingOverlay.fadeIn(2000, 800);
      }, 'overlay.fadeIn', Severity.COSMETIC);
    }

    _sectionEnd('fin.fadeIn');
    _sectionEnd('finalization');
    _sectionEnd('total');
    _logSectionTimings();

    // Mark the load session as successfully completed (records duration).
    session.finish();
    if (window.MapShine) window.MapShine._loadSession = session;

    // Wall-clock load timer report (module.js sets MapShine._loadTimerStartMs).
    safeCall(() => {
      const ms = performance.now();
      const start = window.MapShine?._loadTimerStartMs;
      if (typeof start === 'number') {
        const durationMs = ms - start;
        window.MapShine._lastLoadFinishedAtMs = ms;
        window.MapShine._lastLoadDurationMs = durationMs;
        log.info(`Load complete (wall-clock): ${durationMs.toFixed(1)}ms`);
      }
    }, 'wallClockTimer', Severity.COSMETIC);

  } catch (error) {
    log.error('Failed to initialize three.js scene:', error);
    session.abort();
    destroyThreeCanvas();

    // Dismiss the loading overlay so the user isn't locked out after a failed
    // scene init. Also restore Foundry's PIXI state in case we modified it
    // before the error occurred.
    safeCall(() => restoreFoundryStateFromSnapshot(), 'restoreSnapshot(error)', Severity.COSMETIC);
    await safeCallAsync(async () => {
      loadingOverlay.setStage?.('final', 1.0, 'Scene init failed', { immediate: true });
      await loadingOverlay.fadeIn(500);
    }, 'overlay.fadeIn(error)', Severity.COSMETIC);
  } finally {
    if (doLoadProfile) safeCall(() => lp.end('sceneLoad'), 'lp.end(sceneLoad)', Severity.COSMETIC);
  }
}

/**
 * Initialize Tweakpane UI and register effects.
 * 
 * All effect instances are passed via a single Map keyed by display name,
 * eliminating the previous 30+ positional parameters.
 * 
 * @param {Map<string, EffectBase>} effectMap - Display-name → effect-instance map
 * @private
 */
async function initializeUI(effectMap) {
  // Destructure all needed effect references from the map.
  // Variable names match those used throughout the function body so no further changes needed.
  const specularEffect = effectMap.get('Specular');
  const iridescenceEffect = effectMap.get('Iridescence');
  const fluidEffect = effectMap.get('Fluid');
  const colorCorrectionEffect = effectMap.get('Color Correction');
  const filmGrainEffect = effectMap.get('Film Grain');
  const dotScreenEffect = effectMap.get('Dot Screen');
  const halftoneEffect = effectMap.get('Halftone');
  const sharpenEffect = effectMap.get('Sharpen');
  const asciiEffect = effectMap.get('ASCII');
  const prismEffect = effectMap.get('Prism');
  const lightingEffect = effectMap.get('Lighting');
  const skyColorEffect = effectMap.get('Sky Color');
  const bloomEffect = effectMap.get('Bloom');
  const lensflareEffect = effectMap.get('Lensflare');
  const fireSparksEffect = effectMap.get('Fire Sparks');
  const smellyFliesEffect = effectMap.get('Smelly Flies');
  const dustMotesEffect = effectMap.get('Dust Motes');
  const lightningEffect = effectMap.get('Lightning');
  const windowLightEffect = effectMap.get('Window Lights');
  const overheadShadowsEffect = effectMap.get('Overhead Shadows');
  const buildingShadowsEffect = effectMap.get('Building Shadows');
  const cloudEffect = effectMap.get('Clouds');
  const atmosphericFogEffect = effectMap.get('Atmospheric Fog');
  const bushEffect = effectMap.get('Bushes');
  const treeEffect = effectMap.get('Trees');
  const waterEffect = effectMap.get('Water');
  const fogEffect = effectMap.get('Fog');
  const distortionManager = effectMap.get('Distortion');
  const maskDebugEffect = effectMap.get('Mask Debug');
  const debugLayerEffect = effectMap.get('Debug Layers');
  const playerLightEffect = effectMap.get('Player Lights');
  const ashDisturbanceEffect = effectMap.get('Ash Disturbance');
  // Expose TimeManager BEFORE creating UI so Global Controls can access it
  if (window.MapShine.effectComposer) {
    window.MapShine.timeManager = window.MapShine.effectComposer.getTimeManager();
    log.info('TimeManager exposed to UI');
  } else {
    log.warn('EffectComposer not available, TimeManager not exposed');
  }
  
  // Create UI manager if not already created
  const _dlp = debugLoadingProfiler;
  const _isDbg = _dlp.debugMode;
  if (!uiManager) {
    if (_isDbg) _dlp.begin('ui.TweakpaneManager.init', 'finalize');
    uiManager = new TweakpaneManager();
    await uiManager.initialize();
    if (_isDbg) _dlp.end('ui.TweakpaneManager.init');
    log.info('UI Manager created');
  }

  // --- Selection Box UI (Gameplay drag-select visuals) ---
  if (_isDbg) _dlp.begin('ui.registerSelectionBox', 'finalize');
  safeCall(() => {
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
        enabled: { type: 'boolean', label: 'Enable Selection Box', default: true },

        outlineColor: { type: 'color', label: 'Outline Color', default: { r: 0.2, g: 0.75, b: 1.0 } },
        outlineWidthPx: { type: 'slider', label: 'Outline Width (px)', min: 1, max: 12, step: 1, default: 2 },
        outlineAlpha: { type: 'slider', label: 'Outline Alpha', min: 0, max: 1, step: 0.01, default: 0.95 },

        fillAlpha: { type: 'slider', label: 'Fill Alpha', min: 0, max: 1, step: 0.01, default: 0.02 },
        cornerRadiusPx: { type: 'slider', label: 'Corner Radius (px)', min: 0, max: 24, step: 1, default: 2 },

        borderStyle: {
          type: 'list',
          label: 'Border Style',
          options: {
            Solid: 'solid',
            Dashed: 'dashed',
            Marching: 'marching'
          },
          default: 'solid'
        },
        dashLengthPx: { type: 'slider', label: 'Dash Length (px)', min: 1, max: 48, step: 1, default: 10 },
        dashGapPx: { type: 'slider', label: 'Dash Gap (px)', min: 0, max: 48, step: 1, default: 6 },
        dashSpeed: { type: 'slider', label: 'Dash Speed', min: 0, max: 600, step: 1, default: 180 },

        doubleBorderEnabled: { type: 'boolean', label: 'Double Border', default: false },
        doubleBorderInsetPx: { type: 'slider', label: 'Inset (px)', min: 0, max: 24, step: 1, default: 3 },
        doubleBorderWidthPx: { type: 'slider', label: 'Width (px)', min: 1, max: 12, step: 1, default: 1 },
        doubleBorderAlpha: { type: 'slider', label: 'Alpha', min: 0, max: 1, step: 0.01, default: 0.55 },
        doubleBorderStyle: {
          type: 'list',
          label: 'Style',
          options: {
            Solid: 'solid',
            Dashed: 'dashed',
            Marching: 'marching'
          },
          default: 'dashed'
        },

        glowEnabled: { type: 'boolean', label: 'Glow', default: true },
        glowAlpha: { type: 'slider', label: 'Glow Alpha', min: 0, max: 1, step: 0.01, default: 0.22 },
        glowSizePx: { type: 'slider', label: 'Glow Size (px)', min: 0, max: 80, step: 1, default: 22 },

        pulseEnabled: { type: 'boolean', label: 'Pulse', default: false },
        pulseSpeed: { type: 'slider', label: 'Pulse Speed', min: 0, max: 6, step: 0.01, default: 1.4 },
        pulseStrength: { type: 'slider', label: 'Pulse Strength', min: 0, max: 2.0, step: 0.01, default: 0.7 },

        pattern: {
          type: 'list',
          label: 'Pattern',
          options: {
            None: 'none',
            Grid: 'grid',
            Diagonal: 'diagonal',
            Dots: 'dots'
          },
          default: 'grid'
        },
        patternScalePx: { type: 'slider', label: 'Scale (px)', min: 4, max: 120, step: 1, default: 22 },
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
        shadowOpacity: { type: 'slider', label: 'Opacity', min: 0, max: 1, step: 0.01, default: 0.22 },
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
        if (modeManager) {
          modeManager.updateSelectRectSuppression();
        } else {
          _updateFoundrySelectRectSuppression();
        }
      }
    };

    uiManager.registerEffect(
      'selectionBox',
      'Selection Box',
      selectionSchema,
      onSelectionUpdate,
      'global'
    );
  }, 'registerSelectionBoxUI', Severity.DEGRADED);
  if (_isDbg) _dlp.end('ui.registerSelectionBox');

  // Create Control Panel manager if not already created
  if (!controlPanel) {
    if (_isDbg) _dlp.begin('ui.ControlPanel.init', 'finalize');
    controlPanel = new ControlPanelManager();
    await controlPanel.initialize();
    window.MapShine.controlPanel = controlPanel;
    if (_isDbg) _dlp.end('ui.ControlPanel.init');
    log.info('Control Panel created');
  }

  // Create Camera Panel manager if not already created
  if (!cameraPanel) {
    if (_isDbg) _dlp.begin('ui.CameraPanel.init', 'finalize');
    cameraPanel = new CameraPanelManager(cinematicCameraManager);
    cameraPanel.initialize();
    window.MapShine.cameraPanel = cameraPanel;
    if (_isDbg) _dlp.end('ui.CameraPanel.init');
    log.info('Camera Panel created');
  } else {
    cameraPanel.setCinematicManager(cinematicCameraManager);
  }

  // Create Enhanced Light Inspector if not already created
  if (!enhancedLightInspector) {
    if (_isDbg) _dlp.begin('ui.LightInspector.init', 'finalize');
    enhancedLightInspector = new EnhancedLightInspector();
    enhancedLightInspector.initialize();
    safeCall(() => { if (window.MapShine) window.MapShine.enhancedLightInspector = enhancedLightInspector; }, 'exposeEnhancedLightInspector', Severity.COSMETIC);
    if (_isDbg) _dlp.end('ui.LightInspector.init');
    log.info('Enhanced Light Inspector created');
  }

  // Create Levels Authoring Dialog if not already created (GM only)
  if (!levelsAuthoring && game.user?.isGM) {
    if (_isDbg) _dlp.begin('ui.LevelsAuthoring.init', 'finalize');
    levelsAuthoring = new LevelsAuthoringDialog();
    levelsAuthoring.initialize();
    safeCall(() => { if (window.MapShine) window.MapShine.levelsAuthoring = levelsAuthoring; }, 'exposeLevelsAuthoring', Severity.COSMETIC);
    if (_isDbg) _dlp.end('ui.LevelsAuthoring.init');
    log.info('Levels Authoring Dialog created');
  }

  // Auto-instrument every registerEffect / registerEffectUnderEffect call when
  // debug mode is active. This wraps the methods so each registration gets a
  // timed entry in the debug log without touching every call site.
  let _origRegisterEffect, _origRegisterUnder;
  if (_isDbg && uiManager) {
    _origRegisterEffect = uiManager.registerEffect.bind(uiManager);
    uiManager.registerEffect = function(id, label, schema, cb, category) {
      _dlp.begin(`ui.register.${id}`, 'finalize');
      const result = _origRegisterEffect(id, label, schema, cb, category);
      _dlp.end(`ui.register.${id}`);
      return result;
    };
    _origRegisterUnder = uiManager.registerEffectUnderEffect?.bind(uiManager);
    if (_origRegisterUnder) {
      uiManager.registerEffectUnderEffect = function(parentId, id, label, schema, cb) {
        _dlp.begin(`ui.register.${parentId}.${id}`, 'finalize');
        const result = _origRegisterUnder(parentId, id, label, schema, cb);
        _dlp.end(`ui.register.${parentId}.${id}`);
        return result;
      };
    }
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

  // --- Fluid Settings ---
  if (fluidEffect) {
    const fluidSchema = FluidEffect.getControlSchema();

    const onFluidUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        fluidEffect.enabled = value;
        log.debug(`Fluid effect ${value ? 'enabled' : 'disabled'}`);
      } else if (fluidEffect.params[paramId] !== undefined) {
        fluidEffect.params[paramId] = value;
        log.debug(`Fluid.${paramId} = ${value}`);
      }
    };

    uiManager.registerEffect(
      'fluid',
      'Fluid / Pipes',
      fluidSchema,
      onFluidUpdate,
      'surface'
    );
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

  const candleFlamesEffect_ = effectMap.get('Candle Flames');
  if (candleFlamesEffect_) {
    const candleSchema = CandleFlamesEffect.getControlSchema();
    const onCandleUpdate = (effectId, paramId, value) => {
      if (paramId === 'enabled' || paramId === 'masterEnabled') {
        candleFlamesEffect_.applyParamChange('enabled', !!value);
      } else {
        candleFlamesEffect_.applyParamChange(paramId, value);
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
    safeCall(() => {
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
          safeCall(() => cp.pane?.refresh(), 'weatherSync.paneRefresh', Severity.COSMETIC);
        }

        // Persist the weather state itself, so refresh always restores the correct target.
        safeCall(() => weatherController.scheduleSaveWeatherSnapshot?.(), 'weatherSync.saveSnapshot', Severity.COSMETIC);
      }, 400);
    }, 'scheduleCustomWeatherRegimeSync', Severity.COSMETIC);
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
        paramId === 'freezeLevel' ||
        paramId === 'ashIntensity'
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
       safeCall(() => {
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
       }, 'weather.forceVisualResponse', Severity.COSMETIC);
    } else if (paramId === 'dynamicEnabled') {
      if (typeof weatherController.setDynamicEnabled === 'function') {
        weatherController.setDynamicEnabled(!!value);
      } else {
        weatherController.dynamicEnabled = !!value;
        if (weatherController.dynamicEnabled) weatherController.enabled = true;
      }
      safeCall(() => uiManager?.updateControlStates?.('weather'), 'weather.updateControlStates', Severity.COSMETIC);
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
    } else if (paramId === 'wettingDuration') {
      weatherController.wetnessTuning.wettingDuration = value;
    } else if (paramId === 'dryingDuration') {
      weatherController.wetnessTuning.dryingDuration = value;
    } else if (paramId === 'precipThreshold') {
      weatherController.wetnessTuning.precipThreshold = value;
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
    gustStrength: weatherController.gustStrength,

    // Wetness tracker tuning
    wettingDuration: weatherController.wetnessTuning.wettingDuration,
    dryingDuration: weatherController.wetnessTuning.dryingDuration,
    precipThreshold: weatherController.wetnessTuning.precipThreshold
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
        safeCall(() => {
          // Force regeneration even if the config didn't change.
          windowLightEffect._rainFlowMapConfigKey = null;
          windowLightEffect._ensureRainFlowMap();

          const u = windowLightEffect.material?.uniforms;
          const lu = windowLightEffect.lightMaterial?.uniforms;
          if (u?.uRainFlowMap) u.uRainFlowMap.value = windowLightEffect._rainFlowMap;
          if (lu?.uRainFlowMap) lu.uRainFlowMap.value = windowLightEffect._rainFlowMap;
          if (u?.uHasRainFlowMap) u.uHasRainFlowMap.value = windowLightEffect._rainFlowMap ? 1.0 : 0.0;
          if (lu?.uHasRainFlowMap) lu.uHasRainFlowMap.value = windowLightEffect._rainFlowMap ? 1.0 : 0.0;
        }, 'windowLight.rebuildRainFlowMap', Severity.COSMETIC);
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

        safeCall(() => {
          if (typeof waterEffect.clearCaches === 'function') {
            waterEffect.clearCaches();
            didAnything = true;
          }
        }, 'water.clearCaches', Severity.COSMETIC);

        safeCall(() => {
          const particleSystem = window.MapShineParticles;
          const wp = particleSystem?.weatherParticles;
          if (wp && typeof wp.clearWaterCaches === 'function') {
            wp.clearWaterCaches();
            didAnything = true;
          }
        }, 'water.clearWeatherCaches', Severity.COSMETIC);

        safeCall(() => {
          if (didAnything) ui.notifications.info('Cleared Water caches');
          else ui.notifications.warn('No Water caches available to clear');
        }, 'water.clearCachesNotify', Severity.COSMETIC);
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

  // --- Ash Disturbance Settings ---
  if (ashDisturbanceEffect) {
    const ashSchema = AshDisturbanceEffect.getControlSchema();

    const onAshUpdate = (effectId, paramId, value) => {
      ashDisturbanceEffect.applyParamChange(paramId, value);
    };

    uiManager.registerEffect(
      'ash-disturbance',
      'Ash Disturbance',
      ashSchema,
      onAshUpdate,
      'particle'
    );
    log.info('Ash UI: registered Ash Disturbance controls (Particles).');
  }

  // --- Ash Precipitation Settings ---
  safeCall(() => {
    const ashTuning = weatherController.ashTuning || {};
    const ashWeatherSchema = {
      enabled: true,
      groups: [
        { name: 'ash', label: 'Ashfall', type: 'inline', parameters: ['ashIntensity', 'ashIntensityScale', 'ashEmissionRate'] },
        { name: 'ash-appearance', label: 'Ash Appearance', type: 'inline', separator: true, parameters: ['ashSizeMin', 'ashSizeMax', 'ashLifeMin', 'ashLifeMax', 'ashSpeedMin', 'ashSpeedMax', 'ashOpacityStartMin', 'ashOpacityStartMax', 'ashOpacityEnd', 'ashColorStart', 'ashColorEnd', 'ashBrightness'] },
        { name: 'ash-motion', label: 'Ash Motion', type: 'inline', separator: true, parameters: ['ashGravityScale', 'ashWindInfluence', 'ashCurlStrength'] },
        { name: 'ash-cluster', label: 'Ash Clustering', type: 'inline', separator: true, parameters: ['ashClusterHoldMin', 'ashClusterHoldMax', 'ashClusterRadiusMin', 'ashClusterRadiusMax', 'ashClusterBoostMin', 'ashClusterBoostMax'] },
        { name: 'embers', label: 'Embers', type: 'inline', separator: true, parameters: ['emberEmissionRate', 'emberSizeMin', 'emberSizeMax', 'emberLifeMin', 'emberLifeMax', 'emberSpeedMin', 'emberSpeedMax', 'emberOpacityStartMin', 'emberOpacityStartMax', 'emberOpacityEnd', 'emberColorStart', 'emberColorEnd', 'emberBrightness', 'emberGravityScale', 'emberWindInfluence', 'emberCurlStrength'] }
      ],
      parameters: {
        ashIntensity: { label: 'Ash Intensity', type: 'slider', default: weatherController.targetState.ashIntensity ?? 0.93, min: 0.0, max: 1.0, step: 0.01 },
        ashIntensityScale: { label: 'Intensity Scale', type: 'slider', default: ashTuning.intensityScale ?? 0.5, min: 0.0, max: 4.0, step: 0.05 },
        ashEmissionRate: { label: 'Emission Rate', type: 'slider', default: ashTuning.emissionRate ?? 840, min: 0, max: 2400, step: 10 },
        ashSizeMin: { label: 'Size Min', type: 'slider', default: ashTuning.sizeMin ?? 5, min: 1, max: 60, step: 1 },
        ashSizeMax: { label: 'Size Max', type: 'slider', default: ashTuning.sizeMax ?? 17, min: 2, max: 80, step: 1 },
        ashLifeMin: { label: 'Life Min (s)', type: 'slider', default: ashTuning.lifeMin ?? 2, min: 0.2, max: 12, step: 0.1 },
        ashLifeMax: { label: 'Life Max (s)', type: 'slider', default: ashTuning.lifeMax ?? 4.7, min: 0.2, max: 18, step: 0.1 },
        ashSpeedMin: { label: 'Fall Speed Min', type: 'slider', default: ashTuning.speedMin ?? 15, min: 0, max: 600, step: 5 },
        ashSpeedMax: { label: 'Fall Speed Max', type: 'slider', default: ashTuning.speedMax ?? 25, min: 0, max: 900, step: 5 },
        ashOpacityStartMin: { label: 'Opacity Start Min', type: 'slider', default: ashTuning.opacityStartMin ?? 0.53, min: 0.0, max: 1.0, step: 0.01 },
        ashOpacityStartMax: { label: 'Opacity Start Max', type: 'slider', default: ashTuning.opacityStartMax ?? 0.75, min: 0.0, max: 1.0, step: 0.01 },
        ashOpacityEnd: { label: 'Opacity End', type: 'slider', default: ashTuning.opacityEnd ?? 0.85, min: 0.0, max: 1.0, step: 0.01 },
        ashColorStart: { type: 'color', label: 'Color Start', default: ashTuning.colorStart ?? { r: 0.45, g: 0.42, b: 0.38 } },
        ashColorEnd: { type: 'color', label: 'Color End', default: ashTuning.colorEnd ?? { r: 0.35, g: 0.32, b: 0.28 } },
        ashBrightness: { label: 'Brightness', type: 'slider', default: ashTuning.brightness ?? 1.0, min: 0.0, max: 3.0, step: 0.05 },
        ashGravityScale: { label: 'Gravity Scale', type: 'slider', default: ashTuning.gravityScale ?? 0.55, min: 0.0, max: 3.0, step: 0.05 },
        ashWindInfluence: { label: 'Wind Influence', type: 'slider', default: ashTuning.windInfluence ?? 2.1, min: 0.0, max: 4.0, step: 0.05 },
        ashCurlStrength: { label: 'Curl Strength', type: 'slider', default: ashTuning.curlStrength ?? 3, min: 0.0, max: 3.0, step: 0.05 },
        ashClusterHoldMin: { label: 'Cluster Hold Min (s)', type: 'slider', default: ashTuning.clusterHoldMin ?? 1.3, min: 0.5, max: 12, step: 0.1 },
        ashClusterHoldMax: { label: 'Cluster Hold Max (s)', type: 'slider', default: ashTuning.clusterHoldMax ?? 2.3, min: 0.5, max: 18, step: 0.1 },
        ashClusterRadiusMin: { label: 'Cluster Radius Min', type: 'slider', default: ashTuning.clusterRadiusMin ?? 1150, min: 50, max: 3000, step: 10 },
        ashClusterRadiusMax: { label: 'Cluster Radius Max', type: 'slider', default: ashTuning.clusterRadiusMax ?? 2060, min: 100, max: 4000, step: 10 },
        ashClusterBoostMin: { label: 'Cluster Boost Min', type: 'slider', default: ashTuning.clusterBoostMin ?? 1.1, min: 0.0, max: 2.0, step: 0.05 },
        ashClusterBoostMax: { label: 'Cluster Boost Max', type: 'slider', default: ashTuning.clusterBoostMax ?? 2.55, min: 0.0, max: 3.0, step: 0.05 },
        emberEmissionRate: { label: 'Ember Rate', type: 'slider', default: ashTuning.emberEmissionRate ?? 167, min: 0, max: 400, step: 1 },
        emberSizeMin: { label: 'Ember Size Min', type: 'slider', default: ashTuning.emberSizeMin ?? 7, min: 1, max: 50, step: 1 },
        emberSizeMax: { label: 'Ember Size Max', type: 'slider', default: ashTuning.emberSizeMax ?? 14, min: 2, max: 70, step: 1 },
        emberLifeMin: { label: 'Ember Life Min (s)', type: 'slider', default: ashTuning.emberLifeMin ?? 12, min: 0.2, max: 12, step: 0.1 },
        emberLifeMax: { label: 'Ember Life Max (s)', type: 'slider', default: ashTuning.emberLifeMax ?? 16, min: 0.2, max: 16, step: 0.1 },
        emberSpeedMin: { label: 'Ember Speed Min', type: 'slider', default: ashTuning.emberSpeedMin ?? 180, min: 0, max: 800, step: 5 },
        emberSpeedMax: { label: 'Ember Speed Max', type: 'slider', default: ashTuning.emberSpeedMax ?? 820, min: 0, max: 1000, step: 5 },
        emberOpacityStartMin: { label: 'Ember Opacity Min', type: 'slider', default: ashTuning.emberOpacityStartMin ?? 0.87, min: 0.0, max: 1.0, step: 0.01 },
        emberOpacityStartMax: { label: 'Ember Opacity Max', type: 'slider', default: ashTuning.emberOpacityStartMax ?? 0.94, min: 0.0, max: 1.0, step: 0.01 },
        emberOpacityEnd: { label: 'Ember Opacity End', type: 'slider', default: ashTuning.emberOpacityEnd ?? 0.83, min: 0.0, max: 1.0, step: 0.01 },
        emberColorStart: { type: 'color', label: 'Ember Color Start', default: ashTuning.emberColorStart ?? { r: 1.0, g: 0.25, b: 0.0 } },
        emberColorEnd: { type: 'color', label: 'Ember Color End', default: ashTuning.emberColorEnd ?? { r: 1.0, g: 0.25, b: 0.0 } },
        emberBrightness: { label: 'Ember Brightness', type: 'slider', default: ashTuning.emberBrightness ?? 5, min: 0.0, max: 5.0, step: 0.05 },
        emberGravityScale: { label: 'Ember Gravity Scale', type: 'slider', default: ashTuning.emberGravityScale ?? 0, min: 0.0, max: 3.0, step: 0.05 },
        emberWindInfluence: { label: 'Ember Wind Influence', type: 'slider', default: ashTuning.emberWindInfluence ?? 0.45, min: 0.0, max: 4.0, step: 0.05 },
        emberCurlStrength: { label: 'Ember Curl Strength', type: 'slider', default: ashTuning.emberCurlStrength ?? 3, min: 0.0, max: 3.0, step: 0.05 }
      }
    };

    const onAshWeatherUpdate = (effectId, paramId, value) => {
      if (paramId === 'ashIntensity') {
        weatherController.targetState.ashIntensity = value;
        return;
      }

      if (!weatherController.ashTuning) weatherController.ashTuning = {};
      const t = weatherController.ashTuning;

      if (paramId === 'ashIntensityScale') t.intensityScale = value;
      else if (paramId === 'ashEmissionRate') t.emissionRate = value;
      else if (paramId === 'ashSizeMin') t.sizeMin = value;
      else if (paramId === 'ashSizeMax') t.sizeMax = value;
      else if (paramId === 'ashLifeMin') t.lifeMin = value;
      else if (paramId === 'ashLifeMax') t.lifeMax = value;
      else if (paramId === 'ashSpeedMin') t.speedMin = value;
      else if (paramId === 'ashSpeedMax') t.speedMax = value;
      else if (paramId === 'ashOpacityStartMin') t.opacityStartMin = value;
      else if (paramId === 'ashOpacityStartMax') t.opacityStartMax = value;
      else if (paramId === 'ashOpacityEnd') t.opacityEnd = value;
      else if (paramId === 'ashColorStart') t.colorStart = value;
      else if (paramId === 'ashColorEnd') t.colorEnd = value;
      else if (paramId === 'ashBrightness') t.brightness = value;
      else if (paramId === 'ashGravityScale') t.gravityScale = value;
      else if (paramId === 'ashWindInfluence') t.windInfluence = value;
      else if (paramId === 'ashCurlStrength') t.curlStrength = value;
      else if (paramId === 'ashClusterHoldMin') t.clusterHoldMin = value;
      else if (paramId === 'ashClusterHoldMax') t.clusterHoldMax = value;
      else if (paramId === 'ashClusterRadiusMin') t.clusterRadiusMin = value;
      else if (paramId === 'ashClusterRadiusMax') t.clusterRadiusMax = value;
      else if (paramId === 'ashClusterBoostMin') t.clusterBoostMin = value;
      else if (paramId === 'ashClusterBoostMax') t.clusterBoostMax = value;
      else if (paramId === 'emberEmissionRate') t.emberEmissionRate = value;
      else if (paramId === 'emberSizeMin') t.emberSizeMin = value;
      else if (paramId === 'emberSizeMax') t.emberSizeMax = value;
      else if (paramId === 'emberLifeMin') t.emberLifeMin = value;
      else if (paramId === 'emberLifeMax') t.emberLifeMax = value;
      else if (paramId === 'emberSpeedMin') t.emberSpeedMin = value;
      else if (paramId === 'emberSpeedMax') t.emberSpeedMax = value;
      else if (paramId === 'emberOpacityStartMin') t.emberOpacityStartMin = value;
      else if (paramId === 'emberOpacityStartMax') t.emberOpacityStartMax = value;
      else if (paramId === 'emberOpacityEnd') t.emberOpacityEnd = value;
      else if (paramId === 'emberColorStart') t.emberColorStart = value;
      else if (paramId === 'emberColorEnd') t.emberColorEnd = value;
      else if (paramId === 'emberBrightness') t.emberBrightness = value;
      else if (paramId === 'emberGravityScale') t.emberGravityScale = value;
      else if (paramId === 'emberWindInfluence') t.emberWindInfluence = value;
      else if (paramId === 'emberCurlStrength') t.emberCurlStrength = value;
    };

    uiManager.registerEffect(
      'ash-weather',
      'Ash (Weather)',
      ashWeatherSchema,
      onAshWeatherUpdate,
      'particle'
    );
    log.info('Ash UI: registered Ash (Weather) controls (Particles).');
  }, 'registerAshWeatherUI', Severity.DEGRADED);
  // Add a simple windvane indicator inside the Weather UI folder that reflects
  // the live scene wind direction from WeatherController.currentState.
  safeCall(() => {
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
  }, 'windvaneUI', Severity.COSMETIC);

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

  // --- Overhead Layer Color Correction (Tiles Only) ---
  if (tileManager) {
    const overheadCCSchema = {
      enabled: true,
      groups: [
        {
          name: 'exposure',
          label: 'Exposure & WB',
          type: 'inline',
          parameters: ['exposure', 'temperature', 'tint']
        },
        {
          name: 'basics',
          label: 'Basic Adjustments',
          type: 'inline',
          parameters: ['contrast', 'brightness', 'saturation', 'gamma']
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true },
        exposure: { type: 'slider', min: 0, max: 3, step: 0.01, default: 1.0 },
        brightness: { type: 'slider', min: -0.5, max: 0.5, step: 0.01, default: 0.0 },
        contrast: { type: 'slider', min: 0, max: 2, step: 0.01, default: 1.0 },
        saturation: { type: 'slider', min: 0, max: 2, step: 0.01, default: 1.0 },
        gamma: { type: 'slider', min: 0.2, max: 3, step: 0.01, default: 1.0 },
        temperature: { type: 'slider', min: -1, max: 1, step: 0.01, default: 0.0 },
        tint: { type: 'slider', min: -1, max: 1, step: 0.01, default: 0.0 }
      }
    };

    const onOverheadCCUpdate = (effectId, paramId, value) => {
      safeCall(() => {
        if (paramId === 'enabled' || paramId === 'masterEnabled') {
          tileManager.setOverheadColorCorrectionParams({ enabled: !!value });
          return;
        }
        tileManager.setOverheadColorCorrectionParams({ [paramId]: value });
      }, 'overheadCC.update', Severity.COSMETIC);
    };

    uiManager.registerEffect(
      'overheadColorCorrection',
      'Overhead Layer Color',
      overheadCCSchema,
      onOverheadCCUpdate,
      'global'
    );

    // Ensure runtime matches the loaded scene params.
    safeCall(() => {
      const params = uiManager?.effectFolders?.overheadColorCorrection?.params;
      if (params) tileManager.setOverheadColorCorrectionParams(params);
    }, 'overheadCC.syncParams', Severity.COSMETIC);
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
    const ids = safeCall(() => {
      const mm = window.MapShine?.maskManager;
      const list = mm ? mm.listIds() : [];
      const o = {};
      for (const id of list) {
        o[id] = id;
      }
      return o;
    }, 'maskDebug.listIds', Severity.COSMETIC, { fallback: null });

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

  // Restore original registerEffect methods after all registrations are done.
  if (_isDbg && uiManager) {
    if (_origRegisterEffect) uiManager.registerEffect = _origRegisterEffect;
    if (_origRegisterUnder) uiManager.registerEffectUnderEffect = _origRegisterUnder;
  }

  // Expose UI manager globally for debugging
  window.MapShine.uiManager = uiManager;

  // Push the global sunLatitude value to all effects now that they exist.
  // This is the single source of truth — individual per-effect sliders were removed.
  if (uiManager && typeof uiManager.onGlobalChange === 'function') {
    uiManager.onGlobalChange('sunLatitude', uiManager.globalParams.sunLatitude);
  }
  
  log.info('Specular effect wired to UI');
}

/**
 * Destroy three.js canvas and cleanup resources
 * @private
 */
function destroyThreeCanvas() {
  log.info('Destroying Three.js canvas');
  // Clean up resize handling first
  if (resizeHandler) {
    safeDispose(() => resizeHandler.dispose(), 'resizeHandler.dispose');
    resizeHandler = null;
  }

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

  if (lightEditor) {
    safeDispose(() => { if (effectComposer) effectComposer.removeUpdatable(lightEditor); }, 'removeUpdatable(lightEditor)');
    safeDispose(() => {
      if (typeof lightEditor.dispose === 'function') lightEditor.dispose();
      else if (typeof lightEditor.hide === 'function') lightEditor.hide();
    }, 'lightEditor.dispose');
    lightEditor = null;
  }

  if (levelNavigatorOverlay) {
    safeDispose(() => levelNavigatorOverlay.dispose(), 'levelNavigatorOverlay.dispose');
    levelNavigatorOverlay = null;
  }

  if (levelsPerspectiveBridge) {
    safeDispose(() => levelsPerspectiveBridge.dispose(), 'levelsPerspectiveBridge.dispose');
    levelsPerspectiveBridge = null;
  }

  if (overlayUIManager) {
    safeDispose(() => { if (effectComposer) effectComposer.removeUpdatable(overlayUIManager); }, 'removeUpdatable(overlayUI)');
    safeDispose(() => overlayUIManager.dispose(), 'overlayUIManager.dispose');
    overlayUIManager = null;
  }

  // Dispose Control Panel manager
  if (controlPanel) {
    controlPanel.destroy();
    controlPanel = null;
    log.debug('Control Panel manager disposed');
  }

  // Dispose Camera Panel manager
  if (cameraPanel) {
    cameraPanel.destroy();
    cameraPanel = null;
    log.debug('Camera Panel manager disposed');
  }

  // Dispose Levels Authoring Dialog
  if (levelsAuthoring) {
    levelsAuthoring.destroy();
    levelsAuthoring = null;
    log.debug('Levels Authoring Dialog disposed');
  }

  // Dispose cinematic camera manager
  if (cinematicCameraManager) {
    safeDispose(() => { if (effectComposer) effectComposer.removeUpdatable(cinematicCameraManager); }, 'removeUpdatable(cinematicCamera)');
    safeDispose(() => cinematicCameraManager.dispose(), 'cinematicCameraManager.dispose');
    cinematicCameraManager = null;
  }

  if (graphicsSettings) {
    safeDispose(() => graphicsSettings.dispose(), 'graphicsSettings.dispose');
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

  // Dispose detection filter effect (before visibility controller)
  if (detectionFilterEffect) {
    detectionFilterEffect.dispose();
    detectionFilterEffect = null;
    log.debug('Detection filter effect disposed');
  }

  // Dispose visibility controller (before token manager since it references it)
  if (visibilityController) {
    visibilityController.dispose();
    visibilityController = null;
    log.debug('Visibility controller disposed');
  }

  // Dispose token manager
  if (tokenMovementManager) {
    safeDispose(() => { if (effectComposer) effectComposer.removeUpdatable(tokenMovementManager); }, 'removeUpdatable(tokenMovement)');
    safeDispose(() => tokenMovementManager.dispose(), 'tokenMovementManager.dispose');
    tokenMovementManager = null;
    log.debug('Token movement manager disposed');
  }

  // Dispose token manager
  if (tokenManager) {
    tokenManager.dispose();
    tokenManager = null;
    log.debug('Token manager disposed');
  }

  // Dispose tile manager
  if (tileMotionManager) {
    safeDispose(() => { if (effectComposer) effectComposer.removeUpdatable(tileMotionManager); }, 'removeUpdatable(tileMotion)');
    safeDispose(() => tileMotionManager.dispose(), 'tileMotionManager.dispose');
    tileMotionManager = null;
    log.debug('Tile motion manager disposed');
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
    safeDispose(() => { if (effectComposer) effectComposer.removeUpdatable(gridRenderer); }, 'removeUpdatable(grid)');
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
    safeDispose(() => physicsRopeManager.dispose(), 'physicsRopeManager.dispose');
    physicsRopeManager = null;
    log.debug('Physics rope manager disposed');
  }

  // Dispose depth pass manager (before effect composer since it's an updatable)
  if (depthPassManager) {
    safeDispose(() => { if (effectComposer) effectComposer.removeUpdatable(depthPassManager); }, 'removeUpdatable(depthPass)');
    safeDispose(() => depthPassManager.dispose(), 'depthPassManager.dispose');
    depthPassManager = null;
    log.debug('Depth pass manager disposed');
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
    safeDispose(() => {
      if (_webglContextLostHandler) threeCanvas.removeEventListener('webglcontextlost', _webglContextLostHandler);
      if (_webglContextRestoredHandler) threeCanvas.removeEventListener('webglcontextrestored', _webglContextRestoredHandler);
    }, 'removeContextHandlers');
    _webglContextLostHandler = null;
    _webglContextRestoredHandler = null;

    threeCanvas.remove();
    threeCanvas = null;
    log.debug('Three.js canvas removed');
  }

  // Restore Foundry's PIXI rendering via ModeManager (or legacy fallback)
  if (modeManager) {
    modeManager.restoreFoundryRendering();
    modeManager.dispose();
    modeManager = null;
  } else {
    restoreFoundryRendering();
  }

  // NOTE: We intentionally do NOT clear the asset cache here.
  // The cache maps basePath → loaded bundle (textures + masks). Clearing it
  // on every scene transition makes the cache permanently useless (0% hit rate).
  // The cache is checked at the start of loadAssetBundle() and only reused if
  // all critical masks are present. Stale entries are harmless — they just hold
  // references to disposed textures, which loadAssetBundle's validation will
  // detect and re-probe. Explicit cache clearing is still available via
  // clearAssetCache() for manual use or memory pressure scenarios.

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
  if (modeManager) {
    modeManager.setMapMakerMode(enabled);
    // Keep module-scope flag in sync for any remaining legacy references
    isMapMakerMode = modeManager.isMapMakerMode;
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
      safeCall(() => ui?.notifications?.warn?.('Map Shine: No active scene to reset'), 'resetScene.noScene', Severity.COSMETIC);
      return;
    }

    const prevMapMakerMode = !!(modeManager?.isMapMakerMode ?? isMapMakerMode);

    safeCall(() => ui?.notifications?.info?.('Map Shine: Resetting scene (rebuilding Three.js)…'), 'resetScene.notify', Severity.COSMETIC);

    safeCall(() => {
      const w = window.MapShine?.waterEffect;
      if (w && typeof w.clearCaches === 'function') w.clearCaches();
    }, 'resetScene.clearWaterCaches', Severity.COSMETIC);

    safeCall(() => {
      const particleSystem = window.MapShineParticles;
      const wp = particleSystem?.weatherParticles;
      if (wp && typeof wp.clearWaterCaches === 'function') wp.clearWaterCaches();
    }, 'resetScene.clearWeatherCaches', Severity.COSMETIC);

    await createThreeCanvas(scene);

    // Preserve user mode across rebuilds.
    safeCall(() => { if (prevMapMakerMode) setMapMakerMode(true); }, 'resetScene.restoreMode', Severity.COSMETIC);

    safeCall(() => ui?.notifications?.info?.('Map Shine: Scene reset complete'), 'resetScene.done', Severity.COSMETIC);
  } catch (e) {
    safeCall(() => log.error('Scene reset failed:', e), 'resetScene.logError', Severity.COSMETIC);
    safeCall(() => ui?.notifications?.error?.('Map Shine: Scene reset failed (see console)'), 'resetScene.notifyError', Severity.COSMETIC);
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
  safeCall(() => {
    if (canvas.fog) canvas.fog.visible = false;
    if (canvas.visibility) canvas.visibility.visible = false;
    if (canvas.visibility?.filter) canvas.visibility.filter.enabled = false;
  }, 'applyMapMakerFogOverride', Severity.COSMETIC);
}

function restoreMapMakerFogOverride() {
  if (!mapMakerFogState) return;

  safeCall(() => {
    if (canvas?.fog && mapMakerFogState.fogVisible !== null) {
      canvas.fog.visible = mapMakerFogState.fogVisible;
    }
    if (canvas?.visibility && mapMakerFogState.visibilityVisible !== null) {
      canvas.visibility.visible = mapMakerFogState.visibilityVisible;
    }
    if (canvas?.visibility?.filter && mapMakerFogState.visibilityFilterEnabled !== null) {
      canvas.visibility.filter.enabled = mapMakerFogState.visibilityFilterEnabled;
    }
  }, 'restoreMapMakerFogOverride', Severity.COSMETIC);
  mapMakerFogState = null;
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

  safeCall(() => {
    refreshLevelsInteropDiagnostics({
      gameplayMode: true,
      emitWarning: true,
      reason: 'enable-system',
    });
  }, 'levelsInterop.enableSystem', Severity.COSMETIC);

  // Hard safety: ensure PIXI's primary/tile visuals are suppressed immediately
  // in Gameplay/Hybrid mode, even if ControlsIntegration is still initializing
  // or legacy visibility code hasn't run yet.
  _enforceGameplayPixiSuppression();

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

        // After ControlsIntegration re-enables, re-assert PIXI suppression in
        // Gameplay/Hybrid mode. This prevents a brief window where PIXI primary
        // can render roof/overhead tiles before layer visibility updates settle.
        _enforceGameplayPixiSuppression();
      }).catch(err => {
        log.warn('Failed to re-enable ControlsIntegration:', err);
        configureFoundryCanvas();

        // Legacy fallback path; still enforce suppression.
        _enforceGameplayPixiSuppression();
      });
    } else if (state === 'active') {
      controlsIntegration.layerVisibility?.update();
      controlsIntegration.inputRouter?.autoUpdate();

      _enforceGameplayPixiSuppression();
    } else {
      // Fallback to legacy configuration
      configureFoundryCanvas();

      _enforceGameplayPixiSuppression();
    }
  } else {
    // Fallback to legacy configuration
    configureFoundryCanvas();

    _enforceGameplayPixiSuppression();
  }
}

/**
 * Hard safety: Suppress PIXI visuals that are replaced by Three.js in Gameplay/Hybrid mode.
 *
 * Why this exists:
 * - During mode switches (Map Maker -> Gameplay) or ControlsIntegration re-init,
 *   Foundry can briefly make canvas.primary / tiles visible again.
 * - That creates a duplicate roof/overhead tile rendered by PIXI which will not
 *   respond to MapShine's hover-hide logic (Three.js).
 *
 * This function is intentionally idempotent and safe to call frequently.
 * @private
 */
function _enforceGameplayPixiSuppression() {
  safeCall(() => {
    if (!canvas?.ready) return;
    if (isMapMakerMode) return;

    // V12+: primary can render tiles/overheads/roofs. Keep it hidden in gameplay.
    safeCall(() => { if (canvas.primary) canvas.primary.visible = false; }, 'pixiSuppress.primary', Severity.COSMETIC);

    // If the Tiles layer is actively being edited, allow normal visuals.
    // Otherwise, keep placeables nearly transparent to avoid double-rendering.
    const isTilesActive = safeCall(() => {
      const activeLayerObj = canvas.activeLayer;
      const activeLayerName = activeLayerObj?.options?.name || activeLayerObj?.name || '';
      const activeLayerCtor = activeLayerObj?.constructor?.name || '';
      return (activeLayerName === 'TilesLayer') || (activeLayerName === 'tiles') || (activeLayerCtor === 'TilesLayer');
    }, 'pixiSuppress.checkTilesActive', Severity.COSMETIC, { fallback: false });

    // When not editing tiles, fully hide PIXI tile visuals (alpha=0) so no
    // faint duplicate remains visible when Three.js roofs fade to opacity 0.
    // (We still keep placeables interactive for Foundry tooling.)
    const alpha = isTilesActive ? 1 : 0;

    // If the Tiles tool is active, prefer PIXI for tile editing visuals and hide
    // Three.js tiles to prevent a duplicate "second roof" copy.
    // When the Tiles tool is not active, prefer Three.js for tiles so hover-hide
    // works and we keep full rendering control.
    safeCall(() => {
      const tm = window.MapShine?.tileManager;
      if (tm?.setVisibility) tm.setVisibility(!isTilesActive);
    }, 'pixiSuppress.tileVisibility', Severity.COSMETIC);

    safeCall(() => {
      if (canvas.tiles?.placeables) {
        for (const tile of canvas.tiles.placeables) {
          if (!tile) continue;
          safeCall(() => {
            tile.visible = true;
            tile.interactive = true;
            tile.interactiveChildren = true;
            if (tile.mesh) tile.mesh.alpha = alpha;
            if (tile.texture) tile.texture.alpha = alpha;
            if (Array.isArray(tile.children)) {
              for (const child of tile.children) {
                if (child && typeof child.alpha === 'number') child.alpha = alpha;
              }
            }
          }, 'pixiSuppress.tile', Severity.COSMETIC);
        }
      }
    }, 'pixiSuppress.tiles', Severity.COSMETIC);
  }, 'enforceGameplayPixiSuppression', Severity.COSMETIC);
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
  // V12+: canvas.primary is a core container for primary scene visuals.
  // If this remains visible in Hybrid/Gameplay mode, tiles (including overhead/roof)
  // can be rendered by PIXI *in addition* to our Three.js TileManager, creating
  // a "duplicate" tile that will not respond to MapShine hover fading.
  if (canvas.primary) canvas.primary.visible = false;
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
  const activeLayerObj = canvas.activeLayer;
  const activeLayerName = activeLayerObj?.options?.name || activeLayerObj?.name || '';
  const activeLayerCtor = activeLayerObj?.constructor?.name || '';
  const isActiveLayer = (name) => (activeLayerName === name) || (activeLayerCtor === name);
  
  // Helper to toggle PIXI layer vs Three.js Manager
  const toggleLayer = (pixiLayerName, manager, forceHideThree = false) => {
    const isActive = isActiveLayer(pixiLayerName);
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
      const isWallsActive = isActiveLayer('WallsLayer') || isActiveLayer('walls');

      canvas.walls.visible = true;
      canvas.walls.interactiveChildren = true;

      const makeWallTransparent = (wall) => {
        if (!wall) return;
        safeCall(() => {
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
        }, 'makeWallTransparent', Severity.COSMETIC);
      };

      const restoreWallVisuals = (wall) => {
        if (!wall) return;
        safeCall(() => {
          if (wall.line) wall.line.alpha = 1;
          if (wall.direction) wall.direction.alpha = 1;
          if (wall.endpoints) wall.endpoints.alpha = 1;
          if (wall.doorControl) {
            wall.doorControl.visible = true;
            wall.doorControl.alpha = 1;
          }
        }, 'restoreWallVisuals', Severity.COSMETIC);
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
      const isTilesActive = isActiveLayer('TilesLayer') || isActiveLayer('tiles');
      canvas.tiles.visible = isTilesActive;
      if (tileManager) {
          // While actively editing tiles, prefer PIXI tile visuals and hide
          // Three.js tiles to avoid double-rendering (duplicate roofs).
          // Otherwise, prefer Three.js tiles for gameplay/hover-hide.
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
          layer.visible = isActiveLayer(name) || isActiveLayer(name.replace('Layer', '').toLowerCase());
      }
  });
  
  // Regions Layer (V12 specific check)
  if (canvas.regions) {
      canvas.regions.visible = isActiveLayer('RegionLayer') || isActiveLayer('regions');
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

    const activeLayerObj = canvas.activeLayer;
    const activeLayerName = activeLayerObj?.options?.name || activeLayerObj?.name || '';
    const activeLayerCtor = activeLayerObj?.constructor?.name || '';
    
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
      'regions',
      'TilesLayer',
      'tiles'
    ];
    
    // Drive Three.js wall line visibility and PIXI input routing based on the
    // *final* active layer after Foundry has finished switching tools.
    // We defer to the next tick to avoid reading a stale activeLayer during
    // control changes.
    setTimeout(() => {
      if (!canvas?.ready || isMapMakerMode) return;

      const finalLayerObj = canvas.activeLayer;
      const finalLayerName = finalLayerObj?.options?.name || finalLayerObj?.name || '';
      const finalLayerCtor = finalLayerObj?.constructor?.name || '';
      const isFinalLayer = (name) => (finalLayerName === name) || (finalLayerCtor === name);
      const isEditMode = editLayers.some(l => finalLayerName === l || finalLayerCtor === l);

      // Drive Three.js light icon visibility from a single source of truth.
      // In Gameplay mode (Three.js active), show light icons only when the
      // Lighting layer is the *final* active layer so they behave like
      // Foundry's native handles. In Map Maker mode, the entire Three.js
      // canvas is hidden, so we also hide the icons here for logical
      // consistency.
      if (lightIconManager && lightIconManager.setVisibility) {
        const showLighting = (isFinalLayer('LightingLayer') || isFinalLayer('lighting')) && !isMapMakerMode;
        lightIconManager.setVisibility(showLighting);
      }

      if (enhancedLightIconManager && enhancedLightIconManager.setVisibility) {
        const showLighting = (isFinalLayer('LightingLayer') || isFinalLayer('lighting')) && !isMapMakerMode;
        enhancedLightIconManager.setVisibility(showLighting);
      }

      if (wallManager && wallManager.setVisibility) {
        const showThreeWalls = (isFinalLayer('WallsLayer') || isFinalLayer('walls')) && !isMapMakerMode;
        wallManager.setVisibility(showThreeWalls);
      }

      if (isEditMode) {
        pixiCanvas.style.pointerEvents = 'auto';
        log.debug(`Input Mode: PIXI (Edit: ${finalLayerCtor || finalLayerName})`);
      } else {
        pixiCanvas.style.pointerEvents = 'none'; // Pass through to Three.js
        log.debug(`Input Mode: THREE.js (Gameplay: ${finalLayerCtor || finalLayerName})`);
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

// NOTE: setupResizeHandling() and cleanupResizeHandling() have been extracted
// to foundry/resize-handler.js (ResizeHandler class). The module-scope
// resizeObserver/windowResizeHandler/resizeDebounceTimer/collapseSidebarHookId
// variables above are now unused but kept temporarily for backward compat.

/**
 * Handle canvas resize events.
 * Delegates to the ResizeHandler instance which owns all resize logic.
 * @param {number} width - New width
 * @param {number} height - New height
 * @public
 */
export function resize(width, height) {
  if (resizeHandler) {
    resizeHandler.resize(width, height);
  }
}
