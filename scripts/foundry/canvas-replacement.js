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
import { CandleFlamesEffectV2 } from '../compositor-v2/effects/CandleFlamesEffectV2.js';
import { LightningEffectV2 } from '../compositor-v2/effects/LightningEffectV2.js';
import { MaskManager } from '../masks/MaskManager.js';
import { ParticleSystem } from '../particles/ParticleSystem.js';
import { DustMotesEffect } from '../particles/DustMotesEffect.js';
// Effect wiring ->-> tables, helpers, and re-exported effect classes (for static getControlSchema() calls)
import {
  getIndependentEffectDefs,
  registerAllCapabilities,
  wireGraphicsSettings,
  readLazySkipIds,
  wireBaseMeshes,
  exposeEffectsEarly,
  // V2 effect classes for initializeUI's static getControlSchema() calls
  SpecularEffectV2,
  FluidEffectV2,
  IridescenceEffectV2,
  PrismEffectV2,
  WindowLightEffectV2,
  ColorCorrectionEffectV2,
  SharpenEffectV2,
  BloomEffectV2,
  SkyColorEffectV2,
  LightingEffectV2,
  FireEffectV2,
  AshDisturbanceEffectV2,
  SmellyFliesEffect,
  CloudEffectV2,
  AsciiEffectV2,
  WaterEffectV2,
  AtmosphericFogEffectV2,
  FogOfWarEffectV2,
  PlayerLightEffectV2,
} from './effect-wiring.js';
import { TileEffectBindingManager } from '../scene/TileEffectBindingManager.js';
import { RenderLoop } from '../core/render-loop.js';
import { TweakpaneManager } from '../ui/tweakpane-manager.js';
import { ControlPanelManager } from '../ui/control-panel-manager.js';
import { CameraPanelManager } from '../ui/camera-panel-manager.js';
import { LevelNavigatorOverlay } from '../ui/level-navigator-overlay.js';
import { LevelsAuthoringDialog } from '../ui/levels-authoring-dialog.js';
import { TokenManager } from '../scene/token-manager.js';
import { VisibilityController } from '../vision/VisibilityController.js';
import { DetectionFilterEffect } from '../effects/DetectionFilterEffect.js';
import { TileManager } from '../scene/tile-manager.js';
import { getTextureBudgetTracker } from '../assets/TextureBudgetTracker.js';
import { TileMotionManager } from '../scene/tile-motion-manager.js';
import { SurfaceRegistry } from '../scene/surface-registry.js';
import { WallManager } from '../scene/wall-manager.js';
import { DoorMeshManager } from '../scene/DoorMeshManager.js';
import { FloorStack } from '../scene/FloorStack.js';
import { FloorLayerManager } from '../compositor-v2/FloorLayerManager.js';
import { FilterEffectV2 } from '../compositor-v2/effects/FilterEffectV2.js';
import { WaterSplashesEffectV2 } from '../compositor-v2/effects/WaterSplashesEffectV2.js';
import { OverheadShadowsEffectV2 } from '../compositor-v2/effects/OverheadShadowsEffectV2.js';
import { BuildingShadowsEffectV2 } from '../compositor-v2/effects/BuildingShadowsEffectV2.js';
import { BushEffectV2 } from '../compositor-v2/effects/BushEffectV2.js';
import { TreeEffectV2 } from '../compositor-v2/effects/TreeEffectV2.js';
import { DotScreenEffectV2 } from '../compositor-v2/effects/DotScreenEffectV2.js';
import { HalftoneEffectV2 } from '../compositor-v2/effects/HalftoneEffectV2.js';
import { DazzleOverlayEffectV2 } from '../compositor-v2/effects/DazzleOverlayEffectV2.js';
import { VisionModeEffectV2 } from '../compositor-v2/effects/VisionModeEffectV2.js';
import { InvertEffectV2 } from '../compositor-v2/effects/InvertEffectV2.js';
import { SepiaEffectV2 } from '../compositor-v2/effects/SepiaEffectV2.js';
import { LensEffectV2 } from '../compositor-v2/effects/LensEffectV2.js';
import { InteractionManager } from '../scene/interaction-manager.js';
import { PixiContentLayerBridge } from './pixi-content-layer-bridge.js';
import { GridRenderer } from '../scene/grid-renderer.js';
import { MapPointsManager } from '../scene/map-points-manager.js';
import { PhysicsRopeManager } from '../scene/physics-rope-manager.js';
import { DropHandler } from './drop-handler.js';
import { sceneDebug } from '../utils/scene-debug.js';
import { clearCache as clearAssetCache, warmupBundleTextures, getCacheStats } from '../assets/loader.js';
import * as assetLoader from '../assets/loader.js';
import { globalLoadingProfiler } from '../core/loading-profiler.js';
import { debugLoadingProfiler } from '../core/debug-loading-profiler.js';
import { WeatherController, weatherController } from '../core/WeatherController.js';
import { DynamicExposureManager } from '../core/DynamicExposureManager.js';
import { ControlsIntegration } from './controls-integration.js';
import { frameCoordinator } from '../core/frame-coordinator.js';
import { loadingScreenService as loadingOverlay } from '../ui/loading-screen/loading-screen-service.js';
import { stateApplier } from '../ui/state-applier.js';
import { createEnhancedLightsApi } from '../effects/EnhancedLightsApi.js';
import { LightEnhancementStore } from '../effects/LightEnhancementStore.js';
import { OverlayUIManager } from '../ui/overlay-ui-manager.js';
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

async function _withTimeout(promise, timeoutMs, label) {
  const ms = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0;
  if (!ms) return await promise;

  let timeoutId = 0;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label || 'operation'} timed out after ${ms}ms`));
    }, ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

try {
} catch (_) {
}

/** @type {ControlsIntegration|null} */
let controlsIntegration = null;

/** @type {Array<{hook: string, id: number}>} */
let _pixiSuppressionHookIds = [];

/** @type {Function|null} */
let _pixiSuppressionTickerFn = null;

/** @type {number} */
let _pixiSuppressionTickerLastMs = 0;

/** @type {number|null} */
let _inputArbitrationSettleRaf = null;

/** @type {number} */
let _inputArbitrationSettleDeadlineMs = 0;

/** @type {number} */
let _inputArbitrationStableFrames = 0;

/** @type {boolean} */
let _inputArbitrationDomNudgesInstalled = false;

/** @type {boolean} */
let isHooked = false;

/** @type {HTMLCanvasElement|null} */
let threeCanvas = null;

/** @type {boolean} */
let isMapMakerMode = false;

// ->->->-> Recovery mode flag ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->
// Set to true when Canvas.draw() completes but canvasReady never fired
// (Foundry returned early due to an error like a missing tile texture).
// When active, createThreeCanvas skips the strict _waitForFoundryCanvasReady
// check since canvas.ready will be false. Map Shine replaces the Foundry
// canvas with Three.js anyway, so a partially-drawn Foundry canvas is fine.
let _msaRecoveryMode = false;

// ->->->-> Missing texture tracking + cleanup (safe boot) ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->
// When Foundry/PIXI hangs on a missing/corrupt asset, our safe texture boot
// returns a placeholder to avoid stalling canvas init. However, the scene
// document may still reference the missing file, so future loads will keep
// attempting it. Track these URLs and (GM-only) offer to clean them from the
// active scene.
const _msaMissingTextureUrls = new Set();
const _msaConfirmedMissingTextureUrls = new Set();
const _msaMissingTextureCleanupPromptedSceneIds = new Set();

function _noteMissingTextureUrl(url) {
  try {
    const s = String(url ?? '').trim();
    if (!s) return;
    _msaMissingTextureUrls.add(s);
  } catch (_) {
  }
}

async function _confirmTextureUrlMissing(url) {
  try {
    const s = String(url ?? '').trim();
    if (!s) return false;
    if (_msaConfirmedMissingTextureUrls.has(s)) return true;

    // Use a low-impact fetch to confirm a real missing file (404/410).
    // We intentionally do NOT hard-fail cleanup on transient network issues.
    // Prefer HEAD to avoid downloading large assets; fall back to GET if HEAD
    // is disallowed by the server.
    let res = null;
    try {
      res = await fetch(s, { method: 'HEAD', cache: 'no-store' });
    } catch (_) {
      res = null;
    }
    if (!res || res.status === 405 || res.status === 501) {
      res = await fetch(s, { method: 'GET', cache: 'no-store' });
    }
    if (res && (res.status === 404 || res.status === 410)) {
      _msaConfirmedMissingTextureUrls.add(s);
      return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

async function _cleanupMissingTextureReferencesForActiveScene(scene, { reason = 'canvasReady' } = {}) {
  try {
    if (!scene?.id) return;
    if (_msaMissingTextureCleanupPromptedSceneIds.has(scene.id)) return;
    if (!(game?.user?.isGM ?? false)) return;

    // Only act if we have confirmed missing URLs for this session.
    const missing = Array.from(_msaConfirmedMissingTextureUrls);
    if (missing.length === 0) return;

    // Scan scene for references.
    const matches = {
      background: [],
      tiles: []
    };

    const bgSrc = scene?.background?.src ?? scene?.img ?? null;
    if (bgSrc && missing.includes(String(bgSrc))) {
      matches.background.push(String(bgSrc));
    }

    try {
      const tiles = scene?.tiles?.contents ?? scene?.tiles ?? [];
      for (const t of tiles) {
        const src = t?.texture?.src ?? t?.img ?? t?.texture?.path ?? null;
        if (!src) continue;
        if (missing.includes(String(src))) {
          matches.tiles.push({ id: t.id, src: String(src), name: t.name ?? null });
        }
      }
    } catch (_) {
    }

    const totalRefs = matches.background.length + matches.tiles.length;
    if (totalRefs === 0) return;

    _msaMissingTextureCleanupPromptedSceneIds.add(scene.id);

    const previewList = [
      ...matches.background.map((s) => `BG: ${s}`),
      ...matches.tiles.slice(0, 8).map((t) => `Tile(${t.id}): ${t.src}`)
    ].join('<br>');
    const moreCount = Math.max(0, matches.tiles.length - 8);
    const html = `
      <p><strong>Map Shine detected missing texture references</strong> in this scene and can remove them to prevent future load stalls.</p>
      <p><strong>Scene:</strong> ${scene.name ?? scene.id}</p>
      <p><strong>References:</strong> ${totalRefs} (background: ${matches.background.length}, tiles: ${matches.tiles.length})</p>
      <p>${previewList}${moreCount > 0 ? `<br>...and ${moreCount} more tile(s)` : ''}</p>
      <hr>
      <p><strong>Cleanup actions:</strong></p>
      <p>- Background reference will be cleared (if missing)</p>
      <p>- Tiles referencing missing images will be deleted</p>
    `;

    const proceed = await Dialog.confirm({
      title: 'Map Shine: Clean missing textures',
      content: html,
      yes: 'Clean scene',
      no: 'Leave as-is',
      defaultYes: false
    });

    if (!proceed) return;

    // Apply updates.
    try {
      if (matches.background.length > 0) {
        const update = {};
        if (scene?.background?.src !== undefined) update['background.src'] = null;
        if (scene?.img !== undefined) update['img'] = null;
        if (Object.keys(update).length > 0) {
          await scene.update(update);
        }
      }
    } catch (e) {
      console.error('MapShine: failed to clear missing background texture reference:', e);
    }

    try {
      const tileIds = matches.tiles.map((t) => t.id).filter(Boolean);
      if (tileIds.length > 0) {
        await scene.deleteEmbeddedDocuments('Tile', tileIds);
      }
    } catch (e) {
      console.error('MapShine: failed to delete tiles with missing textures:', e);
    }

    try {
      ui?.notifications?.warn?.(`Map Shine: cleaned ${totalRefs} missing texture reference(s) from scene "${scene.name ?? scene.id}".`);
    } catch (_) {
    }
  } catch (e) {
    console.error('MapShine: missing texture cleanup error:', e);
  }
}

function _isCrisisNuclearBypassEnabled() {
  return false;
}

// ->->->-> Scene data cleaning ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->
// Activated by: localStorage.setItem('msa-clean-scenes', '1')
// When active, every MSA-enabled scene has its flags.map-shine-advanced
// data wiped on load. MSA is skipped for that load cycle. The wipe is
// permanent ->-> the scene becomes a vanilla Foundry scene. Re-enable MSA
// per-scene afterwards via the scene config UI.
//
// Also provides console commands:
//   MapShine.cleanScene()           ->-> clean current viewed scene
//   MapShine.cleanScene('sceneId')  ->-> clean a specific scene
//   MapShine.cleanAllScenes()       ->-> clean every scene in the world

/** Scene IDs cleaned this session (runtime guard for canvasReady). */
const _cleanedSceneIds = new Set();

function _isSceneCleanModeEnabled() {
  return false;
}

/**
 * Strip ALL map-shine-advanced flags from a scene document.
 * The update is async / fire-and-forget ->-> it persists to the DB in the
 * background. Returns true if the wipe was initiated.
 * @param {object} scene - A Foundry Scene document
 * @param {string} [reason] - Reason logged to console
 * @returns {boolean}
 */
function _cleanSceneMSAFlags(scene, reason = 'auto-clean') {
  try {
    if (!scene?.id) return false;
    const msaFlags = scene?.flags?.['map-shine-advanced'];
    if (!msaFlags || Object.keys(msaFlags).length === 0) {
      console.log(`MapShine cleanScene: ${scene.name ?? scene.id} -- no MSA flags to clean`);
      return false;
    }
    const flagKeys = Object.keys(msaFlags);
    const flagSize = JSON.stringify(msaFlags).length;
    console.warn(`MapShine cleanScene [${reason}]: wiping ${flagKeys.length} MSA flag keys (${flagSize} bytes) from "${scene.name ?? scene.id}" (${scene.id})`);
    console.warn(`MapShine cleanScene: flag keys being removed: [${flagKeys.join(', ')}]`);

    // Fire-and-forget: delete the entire map-shine-advanced flag namespace.
    // Foundry's '-=' prefix deletes the key.
    scene.update({ 'flags.-=map-shine-advanced': null }).then(
      () => console.warn(`MapShine cleanScene: successfully wiped MSA flags from "${scene.name ?? scene.id}"`),
      (err) => console.error(`MapShine cleanScene: failed to wipe MSA flags from "${scene.name ?? scene.id}":`, err)
    );
    return true;
  } catch (e) {
    console.error('MapShine cleanScene: error during flag wipe:', e);
    return false;
  }
}

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

/** @type {string|null} */
let _msaRecoveryReason = null;

// ->->->-> Loading Progress Diagnostics ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->
// Used to attribute createThreeCanvas hard timeouts to a specific init step.
let _createThreeCanvasProgress = {
  step: 'not-started',
  stepStartedAtMs: 0,
};

function _setCreateThreeCanvasProgress(step) {
  _createThreeCanvasProgress = {
    step: String(step || 'unknown'),
    stepStartedAtMs: performance.now(),
  };
}

/** @type {number|null} */
let _createThreeCanvasProgressTimeout = null;

// Prevents concurrent createThreeCanvas calls (recovery + real canvasReady racing).
// If a second call arrives while one is already running, it is dropped to avoid
// double-initialization and the watchdog confusion that causes the 60s fadeIn timeout.
let _createThreeCanvasRunning = false;

/** @type {SceneComposer|null} */
let sceneComposer = null;

// Tracks whether the Three canvas WebGL context is currently lost.
// Used to avoid deadlocking loading waits that depend on frames advancing.
let _threeContextLost = false;

/** @type {import('three').WebGLRenderer|null} */
let renderer = null;
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

// One-shot safety mode flag: if the GPU drops the WebGL context during loading,
// apply conservative settings so we don't keep hard-freezing on subsequent loads.
let _autoSafeModeApplied = false;

/** @type {EffectCapabilitiesRegistry|null} */
let effectCapabilitiesRegistry = null;

// EffectMaskRegistry removed - GpuSceneMaskCompositor is the actual working system

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

/** @type {FloorStack|null} */
let floorStack = null;

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

/** @type {PixiContentLayerBridge|null} */
let pixiContentLayerBridge = null;

/** @type {any|null} */
let noteManager = null;

/** @type {any|null} */
let templateManager = null;

/** @type {any|null} */
let lightIconManager = null;

/** @type {any|null} */
let enhancedLightIconManager = null;

/** @type {any|null} */
let soundIconManager = null;

/** @type {InteractionManager|null} */
let interactionManager = null;

// Foundry draws the drag-select rectangle in PIXI (ControlsLayer.drawSelect).
// Since we keep the PIXI canvas visible for overlays (drawings/templates), we must
// suppress that rectangle in Gameplay mode so our custom selection visuals can own it.
let _mapShineOrigDrawSelect = null;
let _mapShineSelectSuppressed = false;

function _isFoundryNativeTokenRenderingMode() {
  try {
    return sceneSettings.getTokenRenderingMode?.() === sceneSettings.TOKEN_RENDERING_MODES?.FOUNDRY;
  } catch (_) {
    return false;
  }
}

function _applyPixiTokenVisualMode() {
  const foundryNative = _isFoundryNativeTokenRenderingMode();
  if (!canvas?.tokens?.placeables) return;

  for (const token of canvas.tokens.placeables) {
    if (token.mesh) token.mesh.alpha = foundryNative ? 1 : 0;
    if (token.icon) token.icon.alpha = foundryNative ? 1 : 0;
    if (token.border) token.border.alpha = foundryNative ? 1 : 0;
    token.visible = true;
    token.interactive = true;
  }
}

export function applyTokenRenderingMode() {
  safeCall(() => {
    _applyPixiTokenVisualMode();
    window.MapShine?.visibilityController?._queueBulkRefresh?.();
    window.MapShine?.tokenManager?.refreshAllTokenOverlayStates?.();
    log.info(`Token rendering mode applied: ${_isFoundryNativeTokenRenderingMode() ? 'foundry' : 'three'}`);
  }, 'tokenRendering.applyMode', Severity.COSMETIC);
}

function _updateFoundrySelectRectSuppression(forceValue = null) {
  // Suppress Foundry selection rectangle only when Three owns interaction.
  // Token selection/marquee in gameplay is Three-authoritative.
  // Foundry marquee should only be active when PIXI truly owns input (e.g. edit tools).
  let suppress = safeCall(() => {
    const im = window.MapShine?.interactionManager;
    const enabled = im?.selectionBoxParams?.enabled !== false;

    const inputRouter =
      window.MapShine?.inputRouter ||
      window.mapShine?.inputRouter ||
      controlsIntegration?.inputRouter ||
      null;
    const pixiOwnsInput = !!inputRouter?.shouldPixiReceiveInput?.();

    return !isMapMakerMode && enabled && !pixiOwnsInput;
  }, 'selectRect.checkSuppression', Severity.COSMETIC, { fallback: false });

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

let candleFlamesEffect = null;

/** @type {AshDisturbanceEffect|null} */
let ashDisturbanceEffect = null;

// NOTE: visionManager and fogManager are no longer used.

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
  try {
    const n = String(80).padStart(3, '0');
  } catch (_) {
  }

  if (isHooked) {
    log.warn('Canvas hooks already registered');
    try {
      const n = String(81).padStart(3, '0');
    } catch (_) {
    }
    return true;
  }

  if (_isCrisisNuclearBypassEnabled()) {
    try {
    } catch (_) {}
    isHooked = true;
    return true;
  }

  // ->->->-> Expose scene cleaning commands on window.MapShine ->->->->->->->->->->->->->->->->->->->->->->->->->->
  // Available immediately so GMs can run them from the browser console
  // even if the rest of initialization fails or hangs.
  try {
    if (!window.MapShine) window.MapShine = {};
    window.MapShine.applyTokenRenderingMode = applyTokenRenderingMode;

    /**
     * Wipe all Map Shine Advanced flags from a scene.
     * @param {string} [sceneId] - Scene ID. Omit to clean the current viewed scene.
     */
    window.MapShine.cleanScene = function(sceneId) {
      try {
        const scene = sceneId
          ? game.scenes.get(sceneId)
          : (canvas?.scene ?? game.scenes.viewed);
        if (!scene) {
          console.error('MapShine.cleanScene: no scene found' + (sceneId ? ` for id "${sceneId}"` : ''));
          return;
        }
        _cleanSceneMSAFlags(scene, 'manual console command');
      } catch (e) {
        console.error('MapShine.cleanScene error:', e);
      }
    };

    /**
     * Wipe all Map Shine Advanced flags from EVERY scene in the world.
     */
    window.MapShine.cleanAllScenes = function() {
      try {
        const scenes = game.scenes?.contents ?? [];
        let cleaned = 0;
        for (const scene of scenes) {
          if (_cleanSceneMSAFlags(scene, 'cleanAllScenes')) cleaned++;
        }
        console.warn(`MapShine.cleanAllScenes: initiated cleanup of ${cleaned} scene(s) out of ${scenes.length} total`);
      } catch (e) {
        console.error('MapShine.cleanAllScenes error:', e);
      }
    };

    /**
     * Enable auto-clean mode: every MSA-enabled scene gets its flags wiped on load.
     * @param {boolean} [enable=true]
     */
    window.MapShine.setAutoClean = function(enable = true) {
      try {
        if (enable) {
          localStorage.setItem('msa-clean-scenes', '1');
          console.warn('MapShine: auto-clean mode ENABLED. All MSA scenes will have their data wiped on next load. Reload to take effect.');
          console.warn('MapShine: to disable, run: MapShine.setAutoClean(false)');
        } else {
          localStorage.removeItem('msa-clean-scenes');
          console.warn('MapShine: auto-clean mode DISABLED.');
        }
      } catch (e) {
        console.error('MapShine.setAutoClean error:', e);
      }
    };

    console.log('MapShine: scene cleaning commands available -- MapShine.cleanScene(), MapShine.cleanAllScenes(), MapShine.setAutoClean()');
  } catch (_) {}

  try {
    // Track lifecycle timing so we can diagnose stalls that happen before
    // canvasReady fires (e.g. during Foundry's internal asset loading).
    let _lastCanvasDrawStartedAtMs = 0;
    let _canvasReadyWatchdogId = null;

    // Debug helper: dump the DOM canvas stack + computed styles.
    // Useful for diagnosing "stuck overlay" artifacts that may come from a
    // different canvas element than the Three renderer.
    try {
      if (!window.MapShine) window.MapShine = {};
      if (!window.MapShine.dumpCanvasStack) {
        window.MapShine.dumpCanvasStack = () => {
          try {
            const els = Array.from(document.querySelectorAll('canvas'));
            const rows = els.map((el) => {
              let cs = null;
              try { cs = getComputedStyle(el); } catch (_) {}
              let r = null;
              try { r = el.getBoundingClientRect(); } catch (_) {}
              return {
                id: el.id || null,
                className: el.className || null,
                width: el.width,
                height: el.height,
                display: cs?.display,
                visibility: cs?.visibility,
                opacity: cs?.opacity,
                zIndex: cs?.zIndex,
                position: cs?.position,
                top: cs?.top,
                left: cs?.left,
                rect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
              };
            });
            console.table(rows);
            return rows;
          } catch (e) {
            console.error('dumpCanvasStack failed:', e);
            return null;
          }
        };
      }
    } catch (_) {}

    // CRITICAL: Hook into canvasConfig to make PIXI canvas transparent
    // This hook is called BEFORE the PIXI.Application is created, allowing us
    // to set transparent: true so the PIXI canvas can show Three.js underneath
    Hooks.on('canvasConfig', (config) => {
      try {
        const n = String(82).padStart(3, '0');
      } catch (_) {
      }
      safeCall(() => {
        const scene = _getActiveSceneForCanvasConfig();
        if (!scene) {
          try {
            const n = String(96).padStart(3, '0');
          } catch (_) {
          }
          return;
        }

        // Install PIXI asset trace as early as possible (before Foundry prints
        // "Loading XX Assets"). Some crash paths freeze before canvasInit.
        safeCall(() => {
          if (globalThis.__msaPixiAssetTraceInstalled) return;

          const PIXI = globalThis.PIXI;
          if (!PIXI) {
            return;
          }

          globalThis.__msaPixiAssetTraceInstalled = true;

          let logCount = 0;
          const MAX_LOGS = 400;
          const _logAsset = (kind, src) => {
            try {
              if (logCount >= MAX_LOGS) return;
              logCount++;
              const s = (src === undefined) ? 'undefined' : (src === null) ? 'null' : String(src);
              try {
                globalThis.__msaLastPixiAssetTrace = {
                  kind,
                  src: s,
                  atMs: performance?.now?.() ?? Date.now()
                };
              } catch (_) {
              }
            } catch (_) {
            }
          };

          // Patch PIXI.Assets.load if present (PIXI v7+)
          try {
            const assets = PIXI.Assets;
            if (assets && typeof assets.load === 'function' && !assets.load.__msaPatched) {
              const original = assets.load.bind(assets);
              const wrapped = (asset, options) => {
                let src = null;
                try {
                  src = (typeof asset === 'string') ? asset : (asset?.src ?? asset?.url ?? asset?.name ?? null);
                  _logAsset('Assets.load:start', src);
                } catch (_) {}

                const t0 = performance?.now?.() ?? Date.now();
                let stallId = null;
                try {
                  stallId = setTimeout(() => {
                    try {
                      const dt = (performance?.now?.() ?? Date.now()) - t0;
                      _logAsset(`Assets.load:STALLED:${Math.round(dt)}ms`, src);
                    } catch (_) {}
                  }, 10000);
                } catch (_) {}

                try {
                  const p = original(asset, options);
                  if (p && typeof p.then === 'function') {
                    p.then(
                      () => {
                        try {
                          if (stallId) clearTimeout(stallId);
                          const dt = (performance?.now?.() ?? Date.now()) - t0;
                          _logAsset(`Assets.load:resolved:${Math.round(dt)}ms`, src);
                        } catch (_) {}
                      },
                      (e) => {
                        try {
                          if (stallId) clearTimeout(stallId);
                          const dt = (performance?.now?.() ?? Date.now()) - t0;
                          _logAsset(`Assets.load:REJECTED:${Math.round(dt)}ms:${e?.message ?? e}`, src);
                        } catch (_) {}
                      }
                    );
                  }
                  return p;
                } catch (e) {
                  try {
                    if (stallId) clearTimeout(stallId);
                    const dt = (performance?.now?.() ?? Date.now()) - t0;
                    _logAsset(`Assets.load:THREW:${Math.round(dt)}ms:${e?.message ?? e}`, src);
                  } catch (_) {}
                  throw e;
                }
              };
              wrapped.__msaPatched = true;
              assets.load = wrapped;
            }
          } catch (_) {
          }

          // Patch PIXI.Texture.from
          try {
            const tex = PIXI.Texture;
            if (tex && typeof tex.from === 'function' && !tex.from.__msaPatched) {
              const original = tex.from;
              const wrapped = function(resource, options) {
                try {
                  const src = (typeof resource === 'string') ? resource
                    : (resource?.src ?? resource?.url ?? resource?.resource?.src ?? resource?.baseTexture?.resource?.src ?? null);
                  _logAsset('Texture.from', src);
                } catch (_) {}
                return original.call(this, resource, options);
              };
              wrapped.__msaPatched = true;
              tex.from = wrapped;
            }
          } catch (_) {
          }

          // Patch PIXI.BaseTexture.from (some paths use this directly)
          try {
            const bt = PIXI.BaseTexture;
            if (bt && typeof bt.from === 'function' && !bt.from.__msaPatched) {
              const original = bt.from;
              const wrapped = function(resource, options) {
                try {
                  const src = (typeof resource === 'string') ? resource
                    : (resource?.src ?? resource?.url ?? resource?.resource?.src ?? null);
                  _logAsset('BaseTexture.from', src);
                } catch (_) {}
                return original.call(this, resource, options);
              };
              wrapped.__msaPatched = true;
              bt.from = wrapped;
            }
          } catch (_) {
          }
        }, 'pixi.assetTrace.preCanvasInit', Severity.COSMETIC);

        if (!sceneSettings.isEnabled(scene)) {
          try {
            const n = String(97).padStart(3, '0');
          } catch (_) {
          }
          return;
        }

        // ->->->-> PIXI config adjustments for Map Shine ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->
        // Disable antialiasing on the PIXI canvas ->-> Map Shine renders via
        // Three.js and only needs PIXI for transparent overlay / input.
        // This is a safe, minor GPU-pressure reduction.
        //
        // IMPORTANT: Do NOT set powerPreference here. Setting 'low-power'
        // forces the integrated GPU on dual-GPU Windows systems, which can
        // cause synchronous driver hangs during texture upload and freeze
        // the event loop entirely (hard freeze at 0%).
        //
        // Do NOT set autoDensity=false ->-> PIXI v8 relies on it for correct
        // canvas element sizing. Overriding it can break layout.
        try { config.antialias = false; } catch (_) {}
        try {
        } catch (_) {}

        try {
          const n = String(98).padStart(3, '0');
          // Log the config object BEFORE we modify it to detect any unusual state
          const configKeys = Object.keys(config ?? {});
        } catch (_) {
        }

        // ->->->-> Scene data diagnostics: log flag sizes + background info ->->->->
        try {
          const bgSrc = scene?.background?.src ?? scene?.img ?? null;
          const sceneFlags = scene?.flags ?? {};
          const msaFlags = sceneFlags?.['map-shine-advanced'] ?? {};
          const msaFlagKeys = Object.keys(msaFlags);
          const msaFlagSize = JSON.stringify(msaFlags).length;
          const allFlagsSize = JSON.stringify(sceneFlags).length;

          // Check if any MSA flag value is suspiciously large (>100KB)
          for (const key of msaFlagKeys) {
            const valSize = JSON.stringify(msaFlags[key]).length;
            if (valSize > 100000) {
            }
          }

          // Test background image accessibility (non-blocking)
          if (bgSrc) {
            const img = new Image();
            const bgTestTimeout = setTimeout(() => {
            }, 5000);
            img.onload = () => {
              clearTimeout(bgTestTimeout);
            };
            img.onerror = (e) => {
              clearTimeout(bgTestTimeout);
            };
            img.src = bgSrc;
          }
        } catch (flagErr) {
        }

        // ->->->-> Transparency config (diagnostic) ->->->->
        // Foundry v13 uses PIXI v8. PIXI v8 does NOT use the old `transparent:true` option;
        // it primarily uses `backgroundAlpha` and `backgroundColor`.
        // Empirically, setting `config.transparent=true` appears to correlate with a hard
        // freeze/crash during the draw pipeline on some scenes/systems.
        //
        // Behavior:
        // - Default: ALWAYS set backgroundAlpha=0 for Map Shine enabled scenes.
        // - Default: DO NOT set transparent=true when PIXI v8+ is detected.
        const pixiVersion = (() => {
          try { return String(globalThis.PIXI?.VERSION ?? ''); } catch (_) { return ''; }
        })();

        // Always set backgroundAlpha=0 for enabled scenes.
        config.backgroundAlpha = 0;
        // Do NOT set transparent by default (safety on PIXI v8+).
      }, 'canvasConfig.alpha0', Severity.COSMETIC);
    });

    // Extra lifecycle breadcrumbs (helpful when freezes occur before canvasReady).
    Hooks.on('canvasInit', () => {
      try {
        const n = String(83).padStart(3, '0');
        const snap = _collectCanvasStateDiagnostic();
      } catch (_) {
      }

      // Retry install of Foundry texture loader tracing here (foundry.canvas should exist by now).
      safeCall(() => {
        _installFoundryTextureLoaderTrace();
      }, 'canvasInit.installFoundryTextureLoaderTrace', Severity.COSMETIC);

      // Retry install of PIXI asset tracing here.
      // On some Foundry versions, PIXI is not available yet during canvasConfig,
      // but it is always available by canvasInit.
      safeCall(() => {
        if (globalThis.__msaPixiAssetTraceInstalled) return;
        const PIXI = globalThis.PIXI;
        if (!PIXI) {
          return;
        }

        globalThis.__msaPixiAssetTraceInstalled = true;

        let logCount = 0;
        const MAX_LOGS = 400;
        const _logAsset = (kind, src) => {
          try {
            if (logCount >= MAX_LOGS) return;
            logCount++;
            const s = (src === undefined) ? 'undefined' : (src === null) ? 'null' : String(src);
            try {
              globalThis.__msaLastPixiAssetTrace = {
                kind,
                src: s,
                atMs: performance?.now?.() ?? Date.now()
              };
            } catch (_) {
            }
          } catch (_) {
          }
        };

        // Patch PIXI.Assets.load if present (PIXI v7+)
        try {
          const assets = PIXI.Assets;
          if (assets && typeof assets.load === 'function' && !assets.load.__msaPatched) {
            const original = assets.load.bind(assets);
            const wrapped = (asset, options) => {
              let src = null;
              try {
                src = (typeof asset === 'string') ? asset : (asset?.src ?? asset?.url ?? asset?.name ?? null);
                _logAsset('Assets.load:start', src);
              } catch (_) {}

              const t0 = performance?.now?.() ?? Date.now();
              let stallId = null;
              try {
                stallId = setTimeout(() => {
                  try {
                    const dt = (performance?.now?.() ?? Date.now()) - t0;
                    _logAsset(`Assets.load:STALLED:${Math.round(dt)}ms`, src);
                  } catch (_) {}
                }, 10000);
              } catch (_) {}

              try {
                const p = original(asset, options);
                if (p && typeof p.then === 'function') {
                  p.then(
                    () => {
                      try {
                        if (stallId) clearTimeout(stallId);
                        const dt = (performance?.now?.() ?? Date.now()) - t0;
                        _logAsset(`Assets.load:resolved:${Math.round(dt)}ms`, src);
                      } catch (_) {}
                    },
                    (e) => {
                      try {
                        if (stallId) clearTimeout(stallId);
                        const dt = (performance?.now?.() ?? Date.now()) - t0;
                        _logAsset(`Assets.load:REJECTED:${Math.round(dt)}ms:${e?.message ?? e}`, src);
                      } catch (_) {}
                    }
                  );
                }
                return p;
              } catch (e) {
                try {
                  if (stallId) clearTimeout(stallId);
                  const dt = (performance?.now?.() ?? Date.now()) - t0;
                  _logAsset(`Assets.load:THREW:${Math.round(dt)}ms:${e?.message ?? e}`, src);
                } catch (_) {}
                throw e;
              }
            };
            wrapped.__msaPatched = true;
            assets.load = wrapped;
          }
        } catch (_) {
        }
      }, 'pixi.assetTrace.canvasInit', Severity.COSMETIC);

      // Attach WebGL context lost/restored listeners to Foundry's PIXI canvas.
      // If the context is lost during asset loading, Foundry can freeze or hang.
      safeCall(() => {
        // Install a broader listener that attaches to any canvas element.
        if (!globalThis.__msaWebglCanvasObserverInstalled) {
          globalThis.__msaWebglCanvasObserverInstalled = true;

          const attach = (canvasEl) => {
            try {
              if (!canvasEl || canvasEl.__msaWebglListenersInstalled) return;
              canvasEl.__msaWebglListenersInstalled = true;
              canvasEl.addEventListener('webglcontextlost', (ev) => {
                try {
                } catch (_) {}
                try { ev?.preventDefault?.(); } catch (_) {}
              }, { passive: false });

              canvasEl.addEventListener('webglcontextrestored', () => {
                try {
                } catch (_) {}
              });
            } catch (_) {
            }
          };

          try {
            const canvases = Array.from(document?.querySelectorAll?.('canvas') ?? []);
            for (const c of canvases) attach(c);
          } catch (_) {
          }

          try {
            const obs = new MutationObserver((mutations) => {
              for (const m of mutations) {
                for (const node of (m.addedNodes || [])) {
                  try {
                    if (!node) continue;
                    if (node.nodeType === 1 && node.tagName === 'CANVAS') attach(node);
                    if (node.querySelectorAll) {
                      for (const c of node.querySelectorAll('canvas')) attach(c);
                    }
                  } catch (_) {
                  }
                }
              }
            });
            obs.observe(document.documentElement, { childList: true, subtree: true });
            globalThis.__msaWebglCanvasObserver = obs;
          } catch (_) {
          }
        }

        const view = canvas?.app?.view;
        try {
          // Ensure PIXI view is attached too (it is one of the canvases above,
          // but keep this for clarity).
          if (view && !view.__msaWebglListenersInstalled) {
            view.__msaWebglListenersInstalled = true;
            view.addEventListener('webglcontextlost', (ev) => {
              try {
                // Diagnostic log removed intentionally.
              } catch (_) {}
              try { ev?.preventDefault?.(); } catch (_) {}
            }, { passive: false });
            view.addEventListener('webglcontextrestored', () => {
              try {
                // Diagnostic log removed intentionally.
              } catch (_) {}
            });
          }
        } catch (_) {
        }
      }, 'webgl.listeners', Severity.COSMETIC);

      safeCall(() => {
        log.info('[loading] Hooks: canvasInit');
      }, 'hook.canvasInit.breadcrumb', Severity.COSMETIC);
    });

    // Additional layer-level lifecycle hooks that Foundry may fire during draw.
    // These help narrow down exactly which layer/step is hanging.
    const _layerHookNames = [
      'canvasPan', 'lightingRefresh', 'sightRefresh',
      'initializeVisionSources', 'initializeLightSources',
      'drawGridLayer', 'refreshTile', 'refreshToken',
      'drawTile', 'drawToken', 'drawWall', 'drawLight',
    ];
    for (const hookName of _layerHookNames) {
      Hooks.on(hookName, (...hookArgs) => {
        try {
        } catch (_) {}
      });
    }

    Hooks.on('drawCanvas', (canvasInstance) => {
      try {
        const n = String(84).padStart(3, '0');
      } catch (_) {
      }
      safeCall(() => {
        _lastCanvasDrawStartedAtMs = performance?.now?.() ?? Date.now();
        log.info('[loading] Hooks: drawCanvas', {
          sceneName: canvasInstance?.scene?.name ?? null,
        });
      }, 'hook.drawCanvas.breadcrumb', Severity.COSMETIC);
    });

    // Foundry hook name varies by major version / internal refactors.
    // Register a few candidate post-draw breadcrumbs.
    Hooks.on('canvasDraw', (canvasInstance) => {
      try {
        const n = String(99).padStart(3, '0');
      } catch (_) {
      }
      safeCall(() => {
        log.info('[loading] Hooks: canvasDraw', {
          sceneName: canvasInstance?.scene?.name ?? null,
        });
      }, 'hook.canvasDraw.breadcrumb', Severity.COSMETIC);
    });

    Hooks.on('canvasDrawn', (canvasInstance) => {
      try {
        const n = String(100).padStart(3, '0');
      } catch (_) {
      }
      safeCall(() => {
        log.info('[loading] Hooks: canvasDrawn', {
          sceneName: canvasInstance?.scene?.name ?? null,
        });
      }, 'hook.canvasDrawn.breadcrumb', Severity.COSMETIC);
    });
    
    // Hook into canvas ready event (when canvas is fully initialized)
    Hooks.on('canvasReady', onCanvasReady);
    try {
      const n = String(85).padStart(3, '0');
    } catch (_) {
    }
    
    // Hook into canvas teardown
    Hooks.on('canvasTearDown', onCanvasTearDown);
    try {
      const n = String(86).padStart(3, '0');
    } catch (_) {
    }
    
    // Hook into scene configuration changes (grid, padding, background, etc.)
    Hooks.on('updateScene', onUpdateScene);
    try {
      const n = String(87).padStart(3, '0');
    } catch (_) {
    }

    // MS-LVL-042: Recompute ambient sound playback when the active level context
    // changes so audibility gates update immediately.
    Hooks.on('mapShineLevelContextChanged', () => {
      safeCall(() => {
        if (!sceneSettings.isEnabled(canvas?.scene)) return;
        canvas?.sounds?.refresh?.();
      }, 'ambientSound.refreshOnLevelContext', Severity.COSMETIC);
    });

    // MS-LVL-060: Rebuild effect masks when the active level changes.
    // Masks (_Fire, _Outdoors, _Water, etc.) are authored per-floor tile.
    // Without this, switching floors keeps the ground floor's masks active,
    // causing outdoors leakage, missing fire, and water suppression on upper floors.
    //
    // Performance: SceneComposer caches masks per-floor so the first visit
    // loads from disk but all subsequent visits are instant cache hits.
    // The `masksChanged` flag avoids expensive effect rebuilds (fire particle
    // regeneration, water SDF, rain flow map) when re-selecting the same floor.
    Hooks.on('mapShineLevelContextChanged', (payload) => {

      // Update FloorStack's active floor immediately so the per-floor depth
      // capture in EffectComposer uses the correct floor on the very next frame.
      safeCall(() => {
        const fs = floorStack ?? window.MapShine?.floorStack;
        if (fs) {
          fs.rebuildFloors(
            window.MapShine?.levelsSnapshot?.sceneLevels ?? null,
            payload?.context ?? null
          );
        }
      }, 'levelMaskRebuild.floorStackUpdate', Severity.COSMETIC);

      // Compositor V2: reassign sprites to floor layers after floor bands rebuild.
      // This is a no-op if floor bands haven't changed (assignTileToFloor checks
      // previous assignment). Cheap ->-> just layer mask bit operations, no GPU work.
      safeCall(() => {
        const flm = window.MapShine?.floorLayerManager;
        const tm = window.MapShine?.tileManager;
        const tkm = window.MapShine?.tokenManager;
        if (flm && tm) {
          flm.reassignAllLayers(tm, tkm);
          // V2: FloorRenderBus repopulates lazily on first render frame from tile docs.
          // No manual populateRenderBus() call needed.
        }
      }, 'levelMaskRebuild.floorLayerReassign', Severity.COSMETIC);

      safeCallAsync(async () => {
        const ms = window.MapShine;
        if (!sceneSettings.isEnabled(canvas?.scene)) return;

        // V2-only path: no mask compositing or registry redistribution.
        log.info('Level context changed: skipping legacy mask compositing + redistribution');
        ms?.renderLoop?.requestRender?.();
        ms?.renderLoop?.requestContinuousRender?.(300);
      }, 'levelMaskRebuild', Severity.DEGRADED);
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

    if (_isCrisisNuclearBypassEnabled()) {
      try {
      } catch (_) {}
    } else {
      // Wrap Foundry's texture loader so we can see exactly which assets are part of
      // the "Loading XX Assets" phase, and whether it ever resolves.
      _installFoundryTextureLoaderTrace();

      // Install transition wrapper so we can fade-to-black BEFORE Foundry tears down the old scene.
      // This must wrap an awaited method (Canvas.tearDown) to actually block the teardown.
      installCanvasTransitionWrapper();

      // Install draw wrapper so we can detect stalls that occur before drawCanvas/canvasReady.
      // This must be low-impact and should not change behavior beyond logging.
      installCanvasDrawWrapper();
    }

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

// ->->->-> diagnostic diagnostic: track outstanding fetch/image requests ->->->->
// Installed once globally so we can see what Foundry is waiting on.
function _installNetworkDiagnostics() {
  if (globalThis.__msaCrisisNetworkDiag) return globalThis.__msaCrisisNetworkDiag;

  const diag = {
    pendingFetches: new Map(),  // id ->-> { url, startMs }
    pendingImages: new Map(),   // id ->-> { src, startMs }
    _fetchId: 0,
    _imgId: 0,
  };
  globalThis.__msaCrisisNetworkDiag = diag;

  // Intercept fetch
  try {
    const origFetch = globalThis.fetch;
    if (typeof origFetch === 'function' && !origFetch.__msaCrisisWrapped) {
      const wrappedFetch = function(...args) {
        const id = ++diag._fetchId;
        const url = String(args?.[0]?.url ?? args?.[0] ?? '').slice(0, 200);
        diag.pendingFetches.set(id, { url, startMs: performance.now() });
        const p = origFetch.apply(this, args);
        if (p && typeof p.then === 'function') {
          p.then(
            () => { diag.pendingFetches.delete(id); },
            () => { diag.pendingFetches.delete(id); }
          );
        }
        return p;
      };
      wrappedFetch.__msaCrisisWrapped = true;
      globalThis.fetch = wrappedFetch;
    }
  } catch (_) {}

  // Intercept Image loading
  try {
    const origSet = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')?.set;
    if (origSet && !HTMLImageElement.prototype.__msaCrisisImgWrapped) {
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        set(val) {
          const id = ++diag._imgId;
          const src = String(val ?? '').slice(0, 200);
          diag.pendingImages.set(id, { src, startMs: performance.now() });
          const cleanup = () => { diag.pendingImages.delete(id); };
          this.addEventListener('load', cleanup, { once: true });
          this.addEventListener('error', cleanup, { once: true });
          origSet.call(this, val);
        },
        get: Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')?.get,
        configurable: true,
        enumerable: true,
      });
      HTMLImageElement.prototype.__msaCrisisImgWrapped = true;
    }
  } catch (_) {}

  return diag;
}

function _installFoundryTextureLoaderTrace() {
  // load() and loadTexture() availability varies across Foundry versions and
  // across lifecycle timing (canvasConfig vs canvasInit). We must be able to
  // retry wrapping loadTexture later even if load() was wrapped earlier.
  const loadWrapped = !!globalThis.__msaFoundryTextureLoaderLoadWrapped;
  const loadTextureWrapped = !!globalThis.__msaFoundryTextureLoaderLoadTextureWrapped;
  if (loadWrapped && loadTextureWrapped) return;

  safeCall(() => {
    const TextureLoader = globalThis.foundry?.canvas?.TextureLoader;
    const loader = TextureLoader?.loader;
    if (!loader) {
      return;
    }
    if (typeof loader.load !== 'function') {
      return;
    }
    const _safeTextureBoot = (() => {
      try {
        // Safe boot mode for missing/corrupt textures.
        // Enabled by default to prevent missing/corrupt scene assets from
        // hard-stalling Foundry's "Loading Assets" phase.
        //
        // Opt-out:
        //   localStorage.setItem('msa-diagnostic-safe-textures', '0')
        //
        // Opt-in is still supported:
        //   localStorage.setItem('msa-diagnostic-safe-textures', '1')
        const v = globalThis?.localStorage?.getItem('msa-diagnostic-safe-textures');
        return v !== '0';
      } catch (_) {
        // Fail-open: safety should remain on if localStorage is unavailable.
        return true;
      }
    })();

    const _getPlaceholderPixiTexture = () => {
      try {
        const PIXI = globalThis.PIXI;
        // Prefer built-in static white texture.
        if (PIXI?.Texture?.WHITE) return PIXI.Texture.WHITE;
        if (PIXI?.Texture?.EMPTY) return PIXI.Texture.EMPTY;
      } catch (_) {}
      return null;
    };

    if (typeof loader.load === 'function' && !loader.load.__msaPatched) {

      const original = loader.load.bind(loader);
      const wrapped = async function(sources, options={}) {
        try {
          const total = Array.isArray(sources) ? sources.length : (sources?.size ?? null);
          const msg = options?.message ?? '';
        } catch (_) {}

        try {
          const keys = Object.keys(loader ?? {}).slice(0, 120);
        } catch (_) {}

        let toLoadArr = [];
        try {
          if (Array.isArray(sources)) toLoadArr = sources;
          else if (sources && typeof sources[Symbol.iterator] === 'function') toLoadArr = [...sources];
        } catch (_) {}

        try {
          for (let i = 0; i < Math.min(toLoadArr.length, 400); i++) {
            const s = String(toLoadArr[i]);
          }
          if (toLoadArr.length > 400) {
          }
        } catch (_) {}

        // FIX A: Check if PIXI's WebGL context is lost before loading.
        // If context is lost, texture uploads will silently hang forever.
        // Wait up to 5 seconds for the browser to restore it.
        try {
          const pixiRenderer = globalThis.canvas?.app?.renderer;
          const gl = pixiRenderer?.gl ?? pixiRenderer?.context?.gl;
          if (gl && typeof gl.isContextLost === 'function' && gl.isContextLost()) {
            const contextRestored = await new Promise((resolve) => {
              const CONTEXT_WAIT_MS = 5000;
              let resolved = false;
              const onRestore = () => {
                if (resolved) return;
                resolved = true;
                resolve(true);
              };
              // Listen for restore event on the PIXI canvas element
              const pixiCanvas = pixiRenderer?.view ?? pixiRenderer?.canvas;
              if (pixiCanvas) {
                pixiCanvas.addEventListener('webglcontextrestored', onRestore, { once: true });
              }
              // Also poll in case the event was missed
              const pollInterval = setInterval(() => {
                try {
                  if (!gl.isContextLost()) {
                    clearInterval(pollInterval);
                    onRestore();
                  }
                } catch (_) {}
              }, 200);
              setTimeout(() => {
                clearInterval(pollInterval);
                if (!resolved) {
                  resolved = true;
                  resolve(false);
                }
              }, CONTEXT_WAIT_MS);
            });
          }
        } catch (_) {}

        // ->->->-> Heartbeat: fires OUTSIDE Foundry's collapsed console group ->->->->
        // If heartbeats stop appearing, the event loop is synchronously blocked.
        // If they keep appearing but loading never resolves, it's an async hang.
        const loadT0 = performance?.now?.() ?? Date.now();
        let _hbCount = 0;
        let _hbId = null;
        const _assetTracker = new Map(); // src ->-> t0
        try {
          _hbId = setInterval(() => {
            try {
              _hbCount++;
              const dt = Math.round((performance?.now?.() ?? Date.now()) - loadT0);
              const pending = _assetTracker.size;
              const pendingList = [..._assetTracker.keys()].slice(0, 10).join(', ');
            } catch (_) {}
          }, 3000);
        } catch (_) {}

        // ->->->-> Per-asset tracking via loadTexture monkey-patch ->->->->
        // Foundry's load() loop calls this.loadTexture(src) for each asset.
        // NOTE: These logs appear INSIDE Foundry's collapsed console group
        // ("Loading 56 Assets"). Expand that group to see them.
        const _prevLoadTexture = loader.loadTexture;
        try {
          const boundOrigLT = (typeof _prevLoadTexture === 'function')
            ? _prevLoadTexture.bind(loader)
            : null;
          if (boundOrigLT) {
            loader.loadTexture = async function(src) {
              const s = String(src ?? 'null');
              const t0 = performance?.now?.() ?? Date.now();
              _assetTracker.set(s, t0);
              try {
              } catch (_) {}
              try {
                const ASSET_TIMEOUT_MS = _safeTextureBoot ? 12000 : 60000;
                const loadP = boundOrigLT(src);
                const result = await Promise.race([
                  loadP,
                  new Promise((resolve) => {
                    setTimeout(() => {
                      if (_safeTextureBoot) {
                        _noteMissingTextureUrl(s);
                        // Confirm in the background so cleanup only acts on real 404/410.
                        _confirmTextureUrlMissing(s).catch(() => {});
                        const placeholder = _getPlaceholderPixiTexture();
                        if (placeholder) {
                          resolve(placeholder);
                          return;
                        }
                      }
                      // Default behavior: do not resolve early; let global safety timeout handle it.
                    }, ASSET_TIMEOUT_MS);
                  })
                ]);
                _assetTracker.delete(s);
                try {
                  const dt = Math.round((performance?.now?.() ?? Date.now()) - t0);
                } catch (_) {}
                return result;
              } catch (e) {
                _assetTracker.delete(s);
                try {
                  const dt = Math.round((performance?.now?.() ?? Date.now()) - t0);
                } catch (_) {}
                if (_safeTextureBoot) {
                  _noteMissingTextureUrl(s);
                  _confirmTextureUrlMissing(s).catch(() => {});
                  const placeholder = _getPlaceholderPixiTexture();
                  if (placeholder) {
                    return placeholder;
                  }
                }
                throw e;
              }
            };
            loader.loadTexture.__msaLoadInterceptor = true;
          } else {
          }
        } catch (installErr) {
          // Do NOT swallow silently ->-> this is critical diagnostic info
        }

        // ->->->-> Call original load() and track sync vs async ->->->->
        const SAFETY_TIMEOUT_MS = _safeTextureBoot ? 20000 : 60000;
        let safetyTimerId = null;
        try {
          // Call original ->-> sync phase creates all loadTexture promises, then awaits
          const loadPromise = original(sources, options);
          // If we reach here, the synchronous phase of original() completed.
          // The event loop is NOT blocked by the synchronous init.

          const ret = await Promise.race([
            loadPromise,
            new Promise((resolve) => {
              safetyTimerId = setTimeout(() => {
                try {
                  const pending = [..._assetTracker.keys()];
                } catch (_) {}
                resolve(undefined);
              }, SAFETY_TIMEOUT_MS);
            })
          ]);
          try { if (safetyTimerId) clearTimeout(safetyTimerId); } catch (_) {}
          return ret;
        } catch (e) {
          try { if (safetyTimerId) clearTimeout(safetyTimerId); } catch (_) {}
          throw e;
        } finally {
          // Restore original loadTexture, stop heartbeat, clean up
          try { loader.loadTexture = _prevLoadTexture; } catch (_) {}
          try { if (_hbId) clearInterval(_hbId); } catch (_) {}
          _assetTracker.clear();
        }
      };

      wrapped.__msaPatched = true;
      loader.load = wrapped;
      globalThis.__msaFoundryTextureLoaderLoadWrapped = true;
    }

    // Also wrap loadTexture so we can pinpoint the exact src which never resolves.
    try {
      if (typeof loader.loadTexture === 'function' && !loader.loadTexture.__msaPatched) {
        const originalLoadTexture = loader.loadTexture.bind(loader);
        const wrappedLoadTexture = async function(src, ...args) {
          const s = (src === undefined) ? 'undefined' : (src === null) ? 'null' : String(src);
          const t0 = performance?.now?.() ?? Date.now();
          let stallId = null;
          try {
            stallId = setTimeout(() => {
            }, 10000);
          } catch (_) {}

          try {
          } catch (_) {}

          try {
            const ASSET_TIMEOUT_MS = _safeTextureBoot ? 12000 : 60000;
            const ret = await Promise.race([
              originalLoadTexture(src, ...args),
              new Promise((resolve) => {
                setTimeout(() => {
                  if (_safeTextureBoot) {
                    _noteMissingTextureUrl(s);
                    _confirmTextureUrlMissing(s).catch(() => {});
                    const placeholder = _getPlaceholderPixiTexture();
                    if (placeholder) {
                      resolve(placeholder);
                      return;
                    }
                  }
                  // Default behavior: do not resolve early; allow global safety timeout.
                }, ASSET_TIMEOUT_MS);
              })
            ]);
            try {
              const dt = (performance?.now?.() ?? Date.now()) - t0;
            } catch (_) {}
            return ret;
          } catch (e) {
            try {
              const dt = (performance?.now?.() ?? Date.now()) - t0;
            } catch (_) {}
            if (_safeTextureBoot) {
              _noteMissingTextureUrl(s);
              _confirmTextureUrlMissing(s).catch(() => {});
              const placeholder = _getPlaceholderPixiTexture();
              if (placeholder) {
                return placeholder;
              }
            }
            throw e;
          } finally {
            try { if (stallId) clearTimeout(stallId); } catch (_) {}
          }
        };
        wrappedLoadTexture.__msaPatched = true;
        loader.loadTexture = wrappedLoadTexture;
        globalThis.__msaFoundryTextureLoaderLoadTextureWrapped = true;
      } else {
        try {
          const keys = Object.keys(loader ?? {}).slice(0, 80);
        } catch (_) {
        }
      }
    } catch (_) {
    }
  }, 'installFoundryTextureLoaderTrace', Severity.COSMETIC);
}

/**
 * Collect a comprehensive snapshot of canvas state for diagnostic diagnostics.
 * Used by the periodic poller inside the Canvas.draw wrapper.
 */
function _collectCanvasStateDiagnostic() {
  const snap = {};
  try {
    const c = globalThis.canvas;
    snap.hasCanvas = !!c;
    snap.loading = c?.loading ?? null;
    snap.ready = c?.ready ?? null;
    snap.sceneId = c?.scene?.id ?? null;
    snap.sceneName = c?.scene?.name ?? null;
    snap.bgSrc = c?.scene?.background?.src ?? c?.scene?.img ?? null;

    // Layer readiness
    const layerNames = ['background', 'tiles', 'drawings', 'grid', 'walls',
      'templates', 'notes', 'tokens', 'lighting', 'sounds', 'effects',
      'controls', 'interface', 'weather'];
    const layers = {};
    for (const name of layerNames) {
      const layer = c?.[name];
      if (layer) {
        layers[name] = {
          exists: true,
          active: layer.active ?? null,
          interactive: layer.interactive ?? null,
          visible: layer.visible ?? null,
          childCount: layer.children?.length ?? 0,
        };
      }
    }
    snap.layers = layers;

    // PIXI app / renderer state
    const app = c?.app;
    snap.hasApp = !!app;
    snap.appRendererType = app?.renderer?.type ?? null;
    snap.appRendererWidth = app?.renderer?.width ?? null;
    snap.appRendererHeight = app?.renderer?.height ?? null;

    // WebGL context health
    try {
      const gl = app?.renderer?.gl ?? app?.renderer?.context?.gl;
      if (gl) {
        snap.webglContextLost = gl.isContextLost?.() ?? null;
      }
    } catch (_) {
      snap.webglContextLost = 'error-checking';
    }

    // Primary canvas texture
    try {
      const primary = c?.primary;
      snap.hasPrimary = !!primary;
      if (primary) {
        snap.primaryChildCount = primary.children?.length ?? 0;
        // Check if background sprite exists and has a loaded texture
        const bgSprite = primary.background;
        snap.hasBgSprite = !!bgSprite;
        snap.bgSpriteTexValid = bgSprite?.texture?.valid ?? null;
        snap.bgSpriteTexWidth = bgSprite?.texture?.width ?? null;
      }
    } catch (_) {
      snap.primaryError = 'error-reading';
    }

    // Pending network requests
    const netDiag = globalThis.__msaCrisisNetworkDiag;
    if (netDiag) {
      const now = performance.now();
      const pendingFetches = [];
      for (const [, entry] of netDiag.pendingFetches) {
        const age = ((now - entry.startMs) / 1000).toFixed(1);
        if ((now - entry.startMs) > 1000) { // only report fetches older than 1s
          pendingFetches.push(`${entry.url} (${age}s)`);
        }
      }
      const pendingImages = [];
      for (const [, entry] of netDiag.pendingImages) {
        const age = ((now - entry.startMs) / 1000).toFixed(1);
        if ((now - entry.startMs) > 1000) {
          pendingImages.push(`${entry.src} (${age}s)`);
        }
      }
      snap.pendingFetchCount = netDiag.pendingFetches.size;
      snap.pendingImageCount = netDiag.pendingImages.size;
      if (pendingFetches.length) snap.stalledFetches = pendingFetches.slice(0, 10);
      if (pendingImages.length) snap.stalledImages = pendingImages.slice(0, 10);
    }

    // JS heap (if available)
    try {
      const mem = performance?.memory;
      if (mem) {
        snap.jsHeapMB = Math.round(mem.usedJSHeapSize / (1024 * 1024));
        snap.jsHeapLimitMB = Math.round(mem.jsHeapSizeLimit / (1024 * 1024));
      }
    } catch (_) {}

  } catch (e) {
    snap.error = e?.message ?? 'unknown';
  }
  return snap;
}

function installCanvasDrawWrapper() {
  if (globalThis.__msaCanvasDrawWrapped) return;
  globalThis.__msaCanvasDrawWrapped = true;

  // Install network diagnostics early so we capture requests during draw
  _installNetworkDiagnostics();

  safeCall(() => {
    const _drawWrapper = async function(wrapped, ...args) {
      try {
        const n = String(101).padStart(3, '0');
        const sceneName = this?.scene?.name ?? (args?.[0]?.name ?? null);
      } catch (_) {
      }

      // ->->->-> Diagnostic state poller: logs canvas internals every 2s while draw is pending ->->->->
      let _pollerId = null;
      let _pollCount = 0;
      const _hangTimerIds = [];
      try {
        const sceneName = this?.scene?.name ?? (args?.[0]?.name ?? null);

        // Periodic state poller ->-> fires every 2s and dumps full canvas state
        _pollerId = setInterval(() => {
          _pollCount++;
          try {
            const snap = _collectCanvasStateDiagnostic();
          } catch (e) {
          }
        }, 2000);
        _hangTimerIds.push({ type: 'interval', id: _pollerId });

        const schedule = (ms, id) => {
          const t = setTimeout(() => {
            try {
              const n = String(id).padStart(3, '0');
            } catch (_) {
            }
          }, ms);
          _hangTimerIds.push({ type: 'timeout', id: t });
        };

        schedule(2000, 103);
        schedule(5000, 110);
        schedule(10000, 111);
        schedule(20000, 112);
      } catch (_) {
      }

      // Sentinel: detect whether Foundry's canvasReady hook actually fires
      // during this draw cycle. Foundry catches errors from tile/layer draws
      // internally and returns early from Canvas.#draw(), skipping canvasReady.
      // When that happens, Map Shine never initializes even though the scene
      // flag is set. We detect this and manually trigger onCanvasReady.
      let _canvasReadyFiredThisDraw = false;
      const _canvasReadySentinel = () => { _canvasReadyFiredThisDraw = true; };
      try { Hooks.once('canvasReady', _canvasReadySentinel); } catch (_) {}

      try {
        let ret;
        try {
          const n = String(114).padStart(3, '0');
        } catch (_) {
        }

        // IMPORTANT: capture synchronous blocking before wrapped() can even return a Promise.
        const t0 = performance?.now?.() ?? Date.now();
        ret = wrapped(...args);
        const t1 = performance?.now?.() ?? Date.now();

        try {
          const n = String(115).padStart(3, '0');
          const dt = (t1 - t0);
          // Immediately collect first snapshot after wrapped() returns
          const snap = _collectCanvasStateDiagnostic();
        } catch (_) {
        }

        // ->->->-> Hang watchdog ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->
        // Some scenes can cause Foundry's Canvas.draw() promise to never
        // resolve (e.g. an internal group draw awaiting a stalled texture
        // decode or a third-party module hook deadlock). When that happens
        // the whole enable flow deadlocks because our wrapper awaits it.
        //
        // For MSA-enabled scenes, we can safely recover by initializing Map
        // Shine anyway ->-> we replace the Foundry canvas with Three.js.
        const sceneForHangCheck = canvas?.scene ?? this?.scene ?? (args?.[0] ?? null);
        const isMsaEnabledForHangCheck = sceneForHangCheck ? sceneSettings.isEnabled(sceneForHangCheck) : false;
        const HANG_TIMEOUT_MS = 8000;

        const drawPromise = (ret && typeof ret.then === 'function')
          ? ret
          : Promise.resolve(ret);

        const raced = await Promise.race([
          drawPromise.then((v) => ({ ok: true, value: v })).catch((err) => ({ ok: false, err })),
          new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), HANG_TIMEOUT_MS))
        ]);

        if (raced && raced.timeout) {
          try {
            console.warn(`MapShine: Canvas.draw() hang watchdog fired after ${(HANG_TIMEOUT_MS / 1000).toFixed(0)}s. MSA-enabled=${isMsaEnabledForHangCheck}, canvasReadyFired=${_canvasReadyFiredThisDraw}`);
          } catch (_) {}

          if (isMsaEnabledForHangCheck && !_canvasReadyFiredThisDraw) {
            try {
              console.warn('MapShine: Canvas.draw() appears hung -- forcing recovery init via onCanvasReady (recovery mode)');
            } catch (_) {}

            _msaRecoveryMode = true;
            // Fire recovery async and return immediately to avoid deadlock.
            Promise.resolve().then(() => onCanvasReady(canvas)).catch((err) => {
              console.error('MapShine: onCanvasReady recovery after hang failed:', err);
            }).finally(() => {
              _msaRecoveryMode = false;
            });
            return undefined;
          }

          // If not enabled (or canvasReady already fired), just let Foundry
          // keep waiting ->-> we don't want to change behavior for vanilla scenes.
          const result = await drawPromise;
          return result;
        }

        if (raced && raced.ok === false) {
          throw raced.err;
        }

        const result = raced?.value;
        try {
          const n = String(102).padStart(3, '0');
        } catch (_) {
        }

        // ->->->-> Recover from silent canvasReady skip ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->
        // Foundry's Canvas.#draw() catches errors from individual canvas
        // group draws (e.g. a tile referencing a missing texture throws
        // "Invalid Asset") and returns early ->-> canvasReady is never called.
        // Map Shine never gets to initialize, so the scene appears as
        // "not enabled" even though the flag is correctly set.
        //
        // If canvasReady didn't fire and the scene is MSA-enabled, we
        // manually trigger onCanvasReady so Map Shine can still take over.
        if (!_canvasReadyFiredThisDraw) {
          try {
            const scene = canvas?.scene ?? this?.scene ?? null;
            const isMsaEnabled = scene ? sceneSettings.isEnabled(scene) : false;
            console.warn(`MapShine: Canvas.draw() completed but canvasReady never fired (Foundry returned early due to a draw error). MSA-enabled=${isMsaEnabled}`);
            if (isMsaEnabled) {
              console.warn('MapShine: Manually triggering onCanvasReady to recover -- Map Shine replaces the Foundry canvas anyway, so partial Foundry draw state is acceptable.');
              _msaRecoveryMode = true;
              // Use setTimeout(0) so any remaining Foundry post-draw cleanup
              // can complete before we start Map Shine initialization.
              setTimeout(() => {
                try {
                  onCanvasReady(canvas);
                } catch (err) {
                  console.error('MapShine: onCanvasReady recovery failed:', err);
                } finally {
                  _msaRecoveryMode = false;
                }
              }, 0);
            }
          } catch (_) {}
        }

        return result;
      } catch (e) {
        try {
          const n = String(104).padStart(3, '0');
        } catch (_) {
        }

        // ->->->-> Recover from thrown errors for MSA-enabled scenes ->->->->->->->->->->->->->->->->->->->->->->->->->->
        // If Canvas.draw() actually throws (rather than returning early),
        // still attempt to initialize Map Shine. We replace the Foundry
        // canvas with Three.js anyway, so a failed Foundry draw is fine.
        try {
          const scene = canvas?.scene ?? this?.scene ?? null;
          const isMsaEnabled = scene ? sceneSettings.isEnabled(scene) : false;
          if (isMsaEnabled) {
            console.warn('MapShine: Canvas.draw() threw, but scene is MSA-enabled -- attempting recovery via onCanvasReady');
            _msaRecoveryMode = true;
            setTimeout(() => {
              try {
                onCanvasReady(canvas);
              } catch (err) {
                console.error('MapShine: onCanvasReady recovery after throw failed:', err);
              } finally {
                _msaRecoveryMode = false;
              }
            }, 0);
            // Swallow the error for MSA scenes so Foundry's calling code
            // (initializeCanvas/setupGame) doesn't also crash.
            return undefined;
          }
        } catch (_) {}

        throw e;
      } finally {
        // Clean up ALL timers (both timeouts and intervals)
        for (const entry of _hangTimerIds) {
          try {
            if (entry.type === 'interval') clearInterval(entry.id);
            else clearTimeout(entry.id);
          } catch (_) {}
        }
      }
    };

    const _wrapInternal = (methodName, enterId, resolveId, throwId) => {
      const CanvasCls = globalThis.foundry?.canvas?.Canvas;
      const proto = CanvasCls?.prototype;
      if (!proto) return;
      const original = proto[methodName];
      if (typeof original !== 'function') return;
      if (original.__mapShineWrapped) return;

      const wrappedFn = function(...args) {
        try {
          const n = String(enterId).padStart(3, '0');
        } catch (_) {
        }

        try {
          const result = original.apply(this, args);
          if (result && typeof result.then === 'function') {
            return result.then((v) => {
              try {
                const n = String(resolveId).padStart(3, '0');
              } catch (_) {
              }
              return v;
            }).catch((e) => {
              try {
                const n = String(throwId).padStart(3, '0');
              } catch (_) {
              }
              throw e;
            });
          }

          try {
            const n = String(resolveId).padStart(3, '0');
          } catch (_) {
          }
          return result;
        } catch (e) {
          try {
            const n = String(throwId).padStart(3, '0');
          } catch (_) {
          }
          throw e;
        }
      };

      wrappedFn.__mapShineWrapped = true;
      proto[methodName] = wrappedFn;
    };

    // Wrap a few internal draw methods when present. Exact names vary across Foundry versions.
    _wrapInternal('_draw', 105, 106, 107);
    _wrapInternal('_drawBlank', 108, 109, 113);

    // Prefer libWrapper when available to preserve chain ordering.
    if (typeof globalThis.libWrapper === 'function' || globalThis.libWrapper?.register) {
      try {
        libWrapper.register(
          'map-shine-advanced',
          'Canvas.prototype.draw',
          _drawWrapper,
          'WRAPPER'
        );
        return;
      } catch (e) {
        // Fall through to direct wrap.
      }
    }

    const CanvasCls = globalThis.foundry?.canvas?.Canvas;
    const proto = CanvasCls?.prototype;
    if (!proto?.draw) return;
    if (proto.draw.__mapShineWrapped) return;

    const original = proto.draw;
    const directWrapped = async function(...args) {
      return _drawWrapper.call(this, original.bind(this), ...args);
    };

    directWrapped.__mapShineWrapped = true;
    proto.draw = directWrapped;
  }, 'installCanvasDrawWrapper', Severity.COSMETIC);
}

function installCanvasTransitionWrapper() {
  if (transitionsInstalled) return;
  transitionsInstalled = true;

  safeCall(() => {
    // XM-3: Wrapper function that fades to black before tearDown.
    // Used by both libWrapper and direct-wrap paths.
    const _tearDownWrapper = async function(wrapped, ...args) {

      await safeCallAsync(async () => {
        loadingOverlay.showLoading('Switching scenes...');
        await loadingOverlay.fadeToBlack(2000, 600);
        loadingOverlay.setMessage('Loading...');
        loadingOverlay.setProgress(0, { immediate: true });
      }, 'sceneTransition.fade', Severity.DEGRADED);

      // Catch tearDown errors (e.g. fog save IndexSizeError/DOMException) so they
      // do not propagate to Canvas.draw() and trigger spurious recovery paths.
      // Foundry's fog extraction can fail with invalid canvas dimensions during
      // scene switches; this is non-fatal — the transition should proceed regardless.
      let result;
      try {
        result = await wrapped(...args);
      } catch (err) {
        log.warn('Canvas.tearDown() threw during scene transition (non-fatal, transition continues):', err?.message ?? String(err));
        // Return undefined so Canvas.draw() sees a resolved tearDown and continues normally.
      }

      // BLANK-CANVAS SAFETY: When canvas.draw(null) is called (scene deleted,
      // deactivated, unviewed, etc.), Foundry's internal #drawBlank() runs
      // instead of the normal draw path. #drawBlank does NOT fire the
      // canvasReady hook, which is the only place Map Shine normally dismisses
      // the loading overlay. Without this check the overlay stays visible
      // forever, locking up the UI.
      // We use queueMicrotask so Foundry's #drawBlank has finished setting

      return result;
    };

    // XM-3: Prefer libWrapper if available ->-> ensures correct chaining with
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

  _dlp.event(`waitFrames: start ->-> threeFrame=${startThreeFrame}, loopFrame=${startLoopFrame}, ` +
    `need ${minFrames} frames, ${stableCallsFrames} stable calls, ${minDelayMs}ms delay, timeout=${timeoutMs}ms`);

  // Heartbeat: fires every 2s to prove the event loop is alive.
  // If the event loop is blocked (e.g. by synchronous shader compilation),
  // no heartbeat events will appear ->-> confirming the block.
  let heartbeatCount = 0;
  const heartbeatId = setInterval(() => {
    heartbeatCount++;
    const elapsed = (performance.now() - startTime).toFixed(0);
    const curFrame = renderer?.info?.render?.frame;
    const curLoop = typeof renderLoop?.getFrameCount === 'function' ? renderLoop.getFrameCount() : '?';
    const curCalls = renderer?.info?.render?.calls;
    _dlp.event(`waitFrames: heartbeat #${heartbeatCount} at +${elapsed}ms ->-> ` +
      `threeFrame=${curFrame}, loopFrame=${curLoop}, calls=${curCalls}`);
  }, 2000);

  let callsStable = 0;
  let iterations = 0;

  try {
    while (performance.now() - startTime < timeoutMs) {
      iterations++;
      const now = performance.now();

      // If the WebGL context is lost, frame counters won't advance and we can
      // deadlock the loading sequence. Treat this as a soft success so loading
      // can proceed; the RenderLoop will resume drawing when the context restores.
      if (_threeContextLost) {
        _dlp.event(`waitFrames: RESOLVED early ->-> WebGL context lost at +${(now - startTime).toFixed(0)}ms`, 'warn');
        return true;
      }
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
        _dlp.event(`waitFrames: iter=${iterations} +${(now - startTime).toFixed(0)}ms ->-> ` +
          `frames=${framesAdvanced}/${minFrames}, calls=${calls}, stable=${callsStable}/${stableCallsFrames}, ` +
          `delay=${meetsDelay}, hidden=${!!isHidden}`);
      }

      if (meetsDelay && meetsFrames && meetsCalls) {
        _dlp.event(`waitFrames: RESOLVED after ${iterations} iterations, ${(now - startTime).toFixed(0)}ms ->-> ` +
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
    _dlp.event(`waitFrames: TIMED OUT after ${iterations} iterations, ${elapsed}ms ->-> ` +
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
  try {
    const n = String(88).padStart(3, '0');
  } catch (_) {
  }

  // Authoritative boot diagnostics: this is the single decision point which
  // chooses UI-only vs full Map Shine. Log all relevant state BEFORE branching.
  safeCall(() => {
    const scene = canvas?.scene ?? null;
    const msaFlags = scene?.flags?.['map-shine-advanced'] ?? null;
    const rawEnabled = (() => {
      try { return scene ? scene.getFlag('map-shine-advanced', 'enabled') : null; } catch (_) { return null; }
    })();
    const mapShineInit = !!window.MapShine?.initialized;
    const bootstrapComplete = !!window.MapShine?.bootstrapComplete;
    const bootstrapErr = window.MapShine?.bootstrapError ?? null;
    // Diagnostic snapshot log removed intentionally.
  }, 'onCanvasReady.diag.snapshot', Severity.COSMETIC);

  safeCall(() => {
    log.info('[loading] Hooks: canvasReady', {
      sceneName: canvas?.scene?.name ?? null,
      canvasLoading: canvas?.loading,
    });
  }, 'hook.canvasReady.breadcrumb', Severity.COSMETIC);

  // Clear the tearDown safety net timer ->-> canvasReady fired, so the overlay
  // will be handled by the normal flow below (or dismissed for null scenes).
  if (_overlayDismissSafetyTimerId !== null) {
    clearTimeout(_overlayDismissSafetyTimerId);
    _overlayDismissSafetyTimerId = null;
  }

  const scene = canvas.scene;

  if (!scene) {
    try {
      const n = String(89).padStart(3, '0');
    } catch (_) {
    }
    log.debug('onCanvasReady called with no active scene ->-> dismissing overlay');
    // Dismiss the loading overlay even though there's no scene to draw.
    // Without this, the overlay can get stuck if canvasReady fires with null
    // (e.g. edge cases during blank canvas transitions or other module interactions).
    safeCall(() => loadingOverlay.fadeIn(500).catch(() => {}), 'overlay.noScene', Severity.COSMETIC);
    return;
  }

  // Safe-boot follow-up: if any textures were missing/corrupt during Foundry's
  // "Loading Assets" phase, offer to remove the stale references from the
  // scene document so future loads don't repeatedly stall.
  //
  // This is GM-only and prompts once per scene per session.
  try {
    if ((game?.user?.isGM ?? false) && !_msaMissingTextureCleanupPromptedSceneIds.has(scene.id)) {
      const missingCandidates = Array.from(_msaMissingTextureUrls);
      if (missingCandidates.length > 0) {
        // Confirm in the background so we only clean true 404/410 misses.
        Promise.allSettled(missingCandidates.map((u) => _confirmTextureUrlMissing(u))).then(() => {
          _cleanupMissingTextureReferencesForActiveScene(scene, { reason: 'canvasReady.auto' }).catch(() => {});
        });
      }
    }
  } catch (_) {
  }

  // Wait for bootstrap to complete if it hasn't yet
  // This handles race condition where canvas loads before 'ready' hook
  if (!window.MapShine || !window.MapShine.initialized) {
    try {
      const n = String(90).padStart(3, '0');
    } catch (_) {
    }
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
        try {
          const n = String(91).padStart(3, '0');
        } catch (_) {
        }
        const err = window.MapShine?.bootstrapError ? ` (${window.MapShine.bootstrapError})` : '';
        log.error(`Bootstrap failed - module did not initialize${err}`);
        ui.notifications.error('Map Shine: Initialization failed. Check console for details.');
        return;
      }

      try {
        const n = String(92).padStart(3, '0');
      } catch (_) {
      }
      log.error('Bootstrap timeout - module did not initialize in time');
      ui.notifications.error('Map Shine: Initialization timeout. Try refreshing the page.');
      return;
    }
    
    try {
      const n = String(93).padStart(3, '0');
    } catch (_) {
    }
    log.info('Bootstrap complete, proceeding with canvas initialization');
  }

  // If scene is not enabled for Map Shine, run UI-only mode so GMs can
  // configure and enable Map Shine without replacing the Foundry canvas.
  if (!sceneSettings.isEnabled(scene)) {
    try {
      const n = String(94).padStart(3, '0');
    } catch (_) {
    }
    log.debug(`Scene not enabled for Map Shine, initializing UI-only mode: ${scene.name}`);
    if (!uiManager) {
      await safeCallAsync(async () => {
        uiManager = new TweakpaneManager();
        await uiManager.initialize();
        if (window.MapShine) window.MapShine.uiManager = uiManager;
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
      }

      if (window.MapShine) window.MapShine.graphicsSettings = graphicsSettings;
    }, 'graphicsSettings.init(UI-only)', Severity.DEGRADED);

    // Scene not replaced by Three.js - dismiss the overlay so the user can interact with Foundry normally.
    safeCall(() => loadingOverlay.fadeIn(500).catch(() => {}), 'overlay.fadeIn', Severity.COSMETIC);
    return;
  }

  log.info(`Initializing Map Shine canvas for scene: ${scene.name}`);

  safeCall(() => {
    // Scene name is rendered by the dedicated scene-name element/subtitle when present.
    const displayName = getSceneLoadingDisplayName(scene);
    loadingOverlay.showBlack('Loading...');
    loadingOverlay.setSceneName(displayName);
    loadingOverlay.configureStages([
      { id: 'assets.discover', label: 'Discovering assets...', weight: 5 },
      { id: 'assets.load',     label: 'Loading textures...', weight: 25 },
      { id: 'effects.core',    label: 'Core effects...', weight: 15 },
      { id: 'effects.deps',    label: 'Dependent effects...', weight: 10 },
      { id: 'effects.wire',    label: 'Wiring effects...', weight: 5 },
      { id: 'scene.managers',  label: 'Scene managers...', weight: 15 },
      { id: 'scene.sync',      label: 'Syncing objects...', weight: 15 },
      { id: 'final',           label: 'Finalizing...', weight: 10 },
    ]);
    loadingOverlay.startStages();
    loadingOverlay.setStage('assets.discover', 0.0, undefined, { immediate: true });
    loadingOverlay.startAutoProgress(0.08, 0.02);
  }, 'overlay.configureStages', Severity.COSMETIC);

  // Create three.js canvas overlay.
  // Safety net: watchdog checks every 15s whether loading is still progressing.
  // If the SAME step has been stuck for 60s without any progress, force-dismiss
  // the loading overlay so the user isn't permanently locked out.
  // This replaces the old fixed 90s timeout which would fire even when loading
  // was actively progressing (just slowly across many steps).
  const WATCHDOG_INTERVAL_MS = 15000;
  const WATCHDOG_STUCK_THRESHOLD_MS = 60000;
  let _loadingTimedOut = false;
  let _watchdogLastStep = null;
  let _watchdogLastStepSince = performance.now();
  const _watchdogId = setInterval(() => {
    const now = performance.now();
    const step = _createThreeCanvasProgress?.step ?? 'unknown';

    // Reset timer when a new step starts -- loading is progressing.
    if (step !== _watchdogLastStep) {
      _watchdogLastStep = step;
      _watchdogLastStepSince = now;
      log.info(`[loading] createThreeCanvas heartbeat [diag=step-tracker-v1] (step=${step}, progressing)`);
      return;
    }

    const stuckMs = Math.round(now - _watchdogLastStepSince);
    if (stuckMs >= WATCHDOG_STUCK_THRESHOLD_MS) {
      // Same step stuck for 60+ seconds -- fire the hard timeout.
      _loadingTimedOut = true;
      clearInterval(_watchdogId);
      log.error(`[loading] HARD TIMEOUT: step "${step}" stuck for ${Math.round(stuckMs / 1000)}s -- force-dismissing loading overlay`);
      safeCall(() => {
        const msg = `Loading timed out (${step})`;
        loadingOverlay.setStage?.('final', 1.0, msg, { immediate: true });
        loadingOverlay.fadeIn?.(500)?.catch?.(() => {});
      }, 'overlay.hardTimeout', Severity.COSMETIC);
    } else {
      // Not yet timed out -- log a heartbeat with how long the current step has been running.
      const level = stuckMs > 30000 ? 'warn' : 'info';
      log[level](`[loading] createThreeCanvas heartbeat [diag=step-tracker-v1] (step=${step}, stuck=${stuckMs}ms)`);
    }
  }, WATCHDOG_INTERVAL_MS);

  try {
    await createThreeCanvas(scene);
  } finally {
    clearInterval(_watchdogId);
    if (_loadingTimedOut) {
      log.warn('[loading] createThreeCanvas eventually completed after hard timeout was triggered');
    }
  }
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

  // Remove PIXI suppression ticker hook (V2 baseline enforcement)
  if (_pixiSuppressionTickerFn) {
    safeDispose(() => {
      canvas?.app?.ticker?.remove?.(_pixiSuppressionTickerFn);
    }, 'pixiSuppress.ticker.remove');
    _pixiSuppressionTickerFn = null;
    _pixiSuppressionTickerLastMs = 0;
  }

  // EffectMaskRegistry removed - GpuSceneMaskCompositor handles all masks

  if (window.MapShine?.maskManager && typeof window.MapShine.maskManager.dispose === 'function') {
    safeDispose(() => window.MapShine.maskManager.dispose(), 'MaskManager.dispose');
  }

  // Reset compositor floor-tracking state so stale floor keys don't bleed
  // into the next scene load. clearFloorState() keeps the render target cache
  // in place (they'll be LRU-evicted or disposed when the compositor itself
  // is GC'd), but clears _activeFloorKey / _belowFloorKey / _floorMeta.
  safeDispose(() => {
    const compositor = window.MapShine?.sceneComposer?._sceneMaskCompositor;
    if (compositor && typeof compositor.clearFloorState === 'function') {
      compositor.clearFloorState();
    }
  }, 'compositor.clearFloorState');

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
    window.MapShine.floorStack = null;
    if (window.MapShine.floorLayerManager) {
      window.MapShine.floorLayerManager.dispose();
      window.MapShine.floorLayerManager = null;
    }
    window.MapShine.tileManager = null;
    window.MapShine.tileMotionManager = null;
    window.MapShine.surfaceRegistry = null;
    window.MapShine.surfaceReport = null;
    window.MapShine.wallManager = null;
    window.MapShine.doorMeshManager = null;
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
    window.MapShine.mouseStateManager = null;
    window.MapShine.pixiContentLayerBridge = null;
    window.MapShine.noteManager = null;
    window.MapShine.gridRenderer = null;
    window.MapShine.mapPointsManager = null;
    window.MapShine.physicsRopeManager = null;
    window.MapShine.cinematicCameraManager = null;
    window.MapShine.cameraPanel = null;
    window.MapShine.frameCoordinator = null;
    window.MapShine.waterEffect = null;
    window.MapShine.distortionManager = null;
    // effectMaskRegistry removed
    window.MapShine.textureBudgetTracker = null;
    // Keep renderer and capabilities - they're reusable
  }
  candleFlamesEffect = null;
  if (pixiContentLayerBridge) {
    safeDispose(() => pixiContentLayerBridge.dispose(), 'pixiContentLayerBridge.dispose');
    pixiContentLayerBridge = null;
  }

  // SAFETY NET: Schedule a delayed fallback check. If the overlay is still
  // visible after 10 seconds and there's no active scene or loading in
  // progress, force-dismiss it. This catches rare edge cases where the
  // queueMicrotask in the tearDown wrapper (Layer 1) or the onCanvasReady
  // null-scene handler (Layer 2) didn't fire ->-> e.g. errors during draw,
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
        log.warn('Overlay safety net triggered ->-> forcing overlay dismissal (no scene loaded after 10s)');
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
  // Guard against concurrent calls — can happen when tearDown throws and both the
  // recovery path AND the real canvasReady hook fire createThreeCanvas simultaneously.
  // The second call is dropped; the first one owns the initialization.
  if (_createThreeCanvasRunning) {
    log.warn('[loading] createThreeCanvas already in progress — ignoring concurrent call (recovery race).');
    return;
  }
  _createThreeCanvasRunning = true;

  try {
    const n = String(95).padStart(3, '0');
  } catch (_) {
  }

  try {
    if (window.MapShine) window.MapShine.__msaSceneLoading = true;
  } catch (_) {
  }

  _setCreateThreeCanvasProgress('entered');
  console.log(' ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->');
  console.log(' Scene load started:', scene?.name ?? 'unknown');
  console.log(' ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->');

  // Periodic progress heartbeat ->-> helps diagnose stalls even when the loading
  // overlay UI is frozen or before the hard timeout fires.
  let _progressHeartbeatId = null;
  try {
    _progressHeartbeatId = setInterval(() => {
      try {
        const now = performance.now();
        const step = _createThreeCanvasProgress?.step ?? 'unknown';
        const startedAt = _createThreeCanvasProgress?.stepStartedAtMs ?? 0;
        const stuckMs = (startedAt > 0) ? Math.max(0, now - startedAt) : null;
        const stuckText = (typeof stuckMs === 'number') ? `${Math.round(stuckMs)}ms` : 'unknown';
        log.info(`[loading] createThreeCanvas heartbeat [diag=step-tracker-v1] (step=${step}, stuck=${stuckText})`);
      } catch (_) {
      }
    }, 5000);
  } catch (_) {
  }

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
  _setCreateThreeCanvasProgress('cleanup');
  // Cleanup existing canvas if present
  console.log(' -> Step: cleanup (destroyThreeCanvas)');
  destroyThreeCanvas();
  console.log(' -> Step: cleanup DONE');
  // Retry ambient sound patch at scene init time in case early init occurred
  // before CONFIG ambient sound classes were fully available.
  installAmbientSoundAudibilityPatch();
  _sectionEnd('cleanup');
  if (isDebugLoad) dlp.end('cleanup');

  safeCall(() => { if (window.MapShine) window.MapShine.stateApplier = stateApplier; }, 'exposeStateApplier', Severity.COSMETIC);

  // LoadSession replaces the old generation-counter closure.
  // It provides isStale(), AbortSignal, and diagnostics.
  const session = LoadSession.start(scene);

  _setCreateThreeCanvasProgress('bootstrap/renderer');

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

  // Expose compositor mode for subsystems that may still query it.
  safeCall(() => {
    if (window.MapShine) window.MapShine.__v2Active = true;
  }, 'exposeV2ActiveFlag', Severity.COSMETIC);

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
    _setCreateThreeCanvasProgress('waitForFoundryCanvasReady');
    const canvasOk = await safeCallAsync(async () => {
      // In recovery mode (Foundry's draw failed early due to e.g. a missing
      // tile texture), canvas.ready will be false and layers may be partial.
      // Map Shine replaces the canvas with Three.js so this is acceptable ->->
      // skip the strict readiness check and proceed.
      if (_msaRecoveryMode) {
        log.warn('Recovery mode active ->-> skipping strict Foundry canvas readiness check');
        return true;
      }
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
      loadingOverlay.showBlack('Loading...');
      loadingOverlay.setSceneName(displayName);
      loadingOverlay.configureStages([
        { id: 'assets.discover', label: 'Discovering assets...', weight: 5 },
        { id: 'assets.load',     label: 'Loading textures...', weight: 25 },
        { id: 'effects.core',    label: 'Core effects...', weight: 15 },
        { id: 'effects.deps',    label: 'Dependent effects...', weight: 10 },
        { id: 'effects.wire',    label: 'Wiring effects...', weight: 5 },
        { id: 'scene.managers',  label: 'Scene managers...', weight: 15 },
        { id: 'scene.sync',      label: 'Syncing objects...', weight: 15 },
        { id: 'final',           label: 'Finalizing...', weight: 10 },
      ]);
      loadingOverlay.startStages();
      loadingOverlay.setStage('assets.discover', 0.0, undefined, { immediate: true });
      loadingOverlay.startAutoProgress(0.08, 0.02);
    }, 'overlay.configureStages(create)', Severity.COSMETIC);

    // Proactively validate and normalize the scene settings flag.
    // Older scenes may contain corrupted or legacy-shaped payloads (including JSON strings),
    // which can crash downstream UI/effect parameter loading.
    _setCreateThreeCanvasProgress('sceneSettings.ensureValid');
    await safeCallAsync(async () => {
      if (session.isStale()) return;
      if (typeof sceneSettings?.ensureValidSceneSettings === 'function') {
        await sceneSettings.ensureValidSceneSettings(scene, { autoRepair: true });
      }
    }, 'sceneSettings.ensureValid', Severity.DEGRADED);

    // P0.3: Capture Foundry state before modifying it
    captureFoundryStateSnapshot();

    // Set default mode - actual canvas configuration happens after ControlsIntegration init
    isMapMakerMode = false; // Default to Gameplay Mode

    // Create new canvas element
    if (isDebugLoad) dlp.begin('canvas.create', 'setup');
    _setCreateThreeCanvasProgress('canvas.create');
    console.log(' -> Step: canvas.create');

    // Hard safety: ensure we never end up with multiple MapShine canvases.
    // A stale canvas can retain the first rendered frame and appear as a
    // camera-locked, semi-transparent overlay when the active renderer canvas
    // updates during pan/zoom.
    safeCall(() => {
      const existing = Array.from(document.querySelectorAll('#map-shine-canvas'));
      for (const el of existing) {
        try { el.remove(); } catch (_) {}
      }
    }, 'canvas.create.removeDuplicates', Severity.COSMETIC);

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
    
    // V2 goal: Three owns all pixels. PIXI must not visually render fog/tokens/etc.
    pixiCanvas.style.display = 'none';
    pixiCanvas.style.visibility = 'hidden';
    pixiCanvas.style.opacity = '0';
    pixiCanvas.style.zIndex = '-1';
    pixiCanvas.style.pointerEvents = 'none';

    // Foundry (or other modules) can re-apply styles during layer/tool changes.
    // Keep #board suppressed so PIXI cannot contribute pixels.
    safeCall(() => {
      if (globalThis.__msaV2BoardSuppressionObserverInstalled) return;
      globalThis.__msaV2BoardSuppressionObserverInstalled = true;

      const enforce = () => {
        try {
          if (window.MapShine?.__forcePixiEditorOverlay) return;
          const el = document.getElementById('board');
          if (!el || el.tagName !== 'CANVAS') return;
          el.style.display = 'none';
          el.style.visibility = 'hidden';
          el.style.opacity = '0';
          el.style.zIndex = '-1';
          el.style.pointerEvents = 'none';
        } catch (_) {}
      };

      enforce();

      const obs = new MutationObserver(() => enforce());
      obs.observe(pixiCanvas, { attributes: true, attributeFilter: ['style', 'class'] });
    }, 'v2.boardSuppressionObserver', Severity.COSMETIC);
    
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
    if (canvas.primary) {
      canvas.primary.visible = true;
      if (canvas.primary.background) canvas.primary.background.visible = false;
      if (canvas.primary.foreground) canvas.primary.foreground.visible = false;
      if (canvas.primary.tiles) canvas.primary.tiles.visible = false;
    }
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
      _applyPixiTokenVisualMode();
    }
    log.debug('Replaced PIXI layers hidden, tokens layer transparent but interactive');
    
    // Insert our canvas as a sibling, right after the PIXI canvas
    pixiCanvas.parentElement.insertBefore(threeCanvas, pixiCanvas.nextSibling);
    if (isDebugLoad) dlp.end('canvas.create');
    console.log(' -> Step: canvas.create DONE');
    log.debug('Three.js canvas created and attached as sibling to PIXI canvas');

    // Get renderer from global state and attach its canvas
    if (isDebugLoad) dlp.begin('renderer.attach', 'setup');
    _setCreateThreeCanvasProgress('renderer.attach');
    console.log(' -> Step: renderer.attach');
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
    rendererCanvas.style.opacity = '1';
    // Use Foundry's scene background colour so padded region matches core Foundry
    rendererCanvas.style.backgroundColor = sceneBgColorStr;

    threeCanvas = rendererCanvas; // Update reference
    
    // CRITICAL (V2): Update InteractionManager's canvas element reference.
    // InteractionManager was initialized with the placeholder canvas, but we just
    // replaced it with renderer.domElement. If we don't update the reference,
    // all coordinate transformations (getBoundingClientRect) will use the detached
    // placeholder, causing zoom offset and token selection failures.
    if (interactionManager) {
      interactionManager.setCanvasElement?.(rendererCanvas);
      // Force canvas rect cache refresh so the next interaction uses correct bounds.
      interactionManager._getCanvasRectCached?.(true);
    }
    
    const rect = threeCanvas.getBoundingClientRect();
    // Avoid setSize() overwriting our CSS sizing (width/height=100%).
    // If updateStyle=true, three will set style width/height to fixed pixel values,
    // preventing future container resizes from affecting the canvas element.
    _applyRenderResolutionToRenderer(rect.width, rect.height);

    // CRITICAL: ensure the Three renderer clears opaquely.
    // If clearAlpha is 0, the Three canvas becomes effectively transparent and
    // underlying stale content can appear as a screen-locked "ghost" aligned
    // with the scene at load time.
    safeCall(() => {
      if (renderer?.setClearColor) renderer.setClearColor(0x000000, 1);
      if (typeof renderer?.setClearAlpha === 'function') renderer.setClearAlpha(1);
    }, 'renderer.forceOpaqueClear', Severity.COSMETIC);

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
        _threeContextLost = true;
        log.warn('WebGL context lost - rendering paused (rAF loop continues)');

        // AUTO RECOVERY: If this happens during the loading screen, unblock the UI and
        // reduce render resolution for this client to prevent repeated freezes.
        if (!_autoSafeModeApplied) {
          _autoSafeModeApplied = true;
          safeCall(() => {
            // Drop render resolution for this client. 720p is a good safety floor.
            if (graphicsSettings && typeof graphicsSettings.setRenderResolutionPreset === 'function') {
              graphicsSettings.setRenderResolutionPreset('1280x720');
              graphicsSettings.saveState?.();
            }
          }, 'autoSafeMode.renderResolution', Severity.DEGRADED);

          safeCall(() => {
            const msg = 'WebGL reset detected ->-> entering Safe Mode (reduced effects)';
            loadingOverlay.setStage?.('final', 1.0, msg, { immediate: true });
            loadingOverlay.fadeIn?.(300)?.catch?.(() => {});
            globalThis.ui?.notifications?.warn?.(msg);
          }, 'autoSafeMode.dismissOverlay', Severity.COSMETIC);
        }
        // IMPORTANT: do NOT stop the render loop here.
        // RenderLoop.render() already skips rendering while the context is lost,
        // but it must keep scheduling requestAnimationFrame so we can resume
        // immediately when the context is restored.
      };

      _webglContextRestoredHandler = () => {
        _threeContextLost = false;
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
    console.log(' -> Step: renderer.attach DONE');

    // Ensure regions outside the Foundry world bounds remain black; padded region is covered by a background plane
    if (renderer.setClearColor) {
      renderer.setClearColor(0x000000, 1);
    }

    // Step 1: Initialize scene composer
    _sectionStart('sceneComposer.initialize');
    if (isDebugLoad) dlp.begin('sceneComposer.initialize', 'texture');
    _setCreateThreeCanvasProgress('sceneComposer.initialize');
    dlp.event('sceneComposer: BEGIN ->-> loading masks + textures');
    console.log(' -> Step: sceneComposer.initialize (loading masks + textures)');

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
            loadingOverlay.setStage('assets.load', v, `Loading ${asset}...`, { keepAuto: true });
          }, 'overlay.assetProgress', Severity.COSMETIC);
        }
      }
    );
    if (doLoadProfile) safeCall(() => lp.end('sceneComposer.initialize'), 'lp.end', Severity.COSMETIC);
    if (isDebugLoad) dlp.end('sceneComposer.initialize', { masks: bundle?.masks?.length ?? 0 });
    dlp.event(`sceneComposer: DONE ->-> ${bundle?.masks?.length ?? 0} masks loaded`);
    console.log(' -> Step: sceneComposer.initialize DONE (' + (bundle?.masks?.length ?? 0) + ' masks)');
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
          'Hit rate': cs.hitRate || '->->',
          'Bundle keys': cs.bundles.length > 0 ? cs.bundles.map(k => k.split('/').pop()).join(', ') : '(empty)',
          'Note': isFirstLoad
            ? 'First load ->-> MISS is expected. Cache is in-memory only (survives scene transitions, not page reloads). Switch scenes and return to test cache HIT.'
            : 'Return visit ->-> cache should HIT if masks are still valid.'
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
            'Base path': bundle.basePath || '->->',
            'Mask count': bundle.masks.length,
            'Masks': maskInfo.join(' | ')
          });
        }
      }, 'dlp.cacheStats', Severity.COSMETIC);

      // GPU / renderer diagnostics ->-> static hardware info captured early.
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
    _setCreateThreeCanvasProgress('gpu.textureWarmup');
    console.log(' -> Step: gpu.textureWarmup');
    safeCall(() => {
      const warmupResult = warmupBundleTextures(renderer, bundle, (uploaded, total) => {
        safeCall(() => loadingOverlay.setStage('assets.load', 1.0, `GPU upload ${uploaded}/${total}...`, { keepAuto: true }), 'overlay.gpuWarmup', Severity.COSMETIC);
      });
      if (warmupResult.totalMs > 50) {
        log.info(`GPU texture warmup took ${warmupResult.totalMs.toFixed(0)}ms for ${warmupResult.uploaded} textures`);
      }
    }, 'gpu.textureWarmup', Severity.DEGRADED);
    if (isDebugLoad) dlp.end('gpu.textureWarmup');
    console.log(' -> Step: gpu.textureWarmup DONE');
    _sectionEnd('gpu.textureWarmup');

    // CRITICAL: Expose sceneComposer early so effects can access groundZ during initialization
    mapShine.sceneComposer = sceneComposer;

    // V2: MaskManager, WeatherController roof map, and EffectMaskRegistry are
    // all V1 mask infrastructure. V2 renders raw geometry only ->-> skip.

    // Step 2: Initialize effect composer
    console.log(' -> Step: effectComposer.initialize');
    if (isDebugLoad) dlp.begin('effectComposer.initialize', 'setup');
    effectComposer = new EffectComposer(renderer, threeScene, camera);
    effectComposer.initialize(mapShine.capabilities);
    if (isDebugLoad) dlp.end('effectComposer.initialize');
    console.log(' -> Step: effectComposer.initialize DONE');

    // Ensure TimeManager immediately matches Foundry's current pause state.
    safeCall(() => {
      const paused = game?.paused ?? false;
      effectComposer.getTimeManager()?.setFoundryPaused?.(paused, 0);
    }, 'timeManager.syncPause', Severity.COSMETIC);

    log.info('Compositor V2 active ->-> skipping legacy effect construction, masks, and pre-warming');
    dlp.event('effect pipeline: legacy V1 paths bypassed');

    // Initialize module-wide depth pass manager.
    // V2: Depth passes are not used ->-> FloorCompositor renders MeshBasicMaterial only.

    safeCall(() => {
      loadingOverlay.setStage('effects.core', 0.0, 'Initializing effects...', { immediate: true, keepAuto: true });
      loadingOverlay.startAutoProgress(0.55, 0.015);
    }, 'overlay.effectsCore', Severity.COSMETIC);
    log.info('[loading] entered effects.core stage (30%)');

    // Progress tracker for dependent effects (Phase 2).
    // Independent effects use registerEffectBatch with its own onProgress.
    let _depEffectIndex = 0;
    const _depEffectTotal = 7; // Particles, Fire, Dust, Ash, LightEnhancementStore, Lighting, CandleFlames
    const _setEffectInitStep = (label) => {
      _depEffectIndex++;
      const t = Math.max(0, Math.min(1, _depEffectIndex / _depEffectTotal));
      safeCall(() => loadingOverlay.setStage('effects.deps', t, `Initializing ${label}...`, { keepAuto: true }), 'overlay.depEffect', Severity.COSMETIC);
    };

    // Ensure WeatherController is initialized and driven by the centralized TimeManager.
    // V2: WeatherController is pure state data (wind, precipitation, cloud cover, wetness).
    //     CloudEffectV2 and WaterEffectV2 read it directly, so it must be initialized in
    //     both modes. The EffectComposer updatable registration is V1-only because V2
    //     drives WeatherController updates via FloorCompositor ->-> WeatherParticlesV2.
    if (isDebugLoad) dlp.begin('weatherController.initialize', 'weather');
    console.log(' -> Step: weatherController.initialize');
    await weatherController.initialize();
    console.log(' -> Step: weatherController.initialize DONE');
    if (isDebugLoad) dlp.end('weatherController.initialize');


    safeCall(() => loadingOverlay.setStage('effects.core', 0.05, 'Weather initialized...', { keepAuto: true }), 'overlay.weather', Severity.COSMETIC);

    if (session.isStale()) {
      safeDispose(() => destroyThreeCanvas(), 'destroyThreeCanvas(stale)');
      return;
    }

    // Legacy effect construction is removed. Keep an empty map so downstream
    // references remain compatible.
    _sectionStart('effectInit');
    const effectMap = new Map();

    dlp.event('effectInit: SKIPPED ->-> V2 compositor owns post pipeline');
    _sectionEnd('effectInit');

      // V2: Eagerly initialize FloorCompositor and warm up shaders NOW during
      // scene loading, NOT lazily on the first render frame.
      //
      // Without this, the 69KB water fragment shader compiles synchronously
      // on the GPU driver the first time renderer.render() is called, which
      // freezes the browser main thread for multiple seconds and manifests as
      // the loading screen stuck at 0% with parts of the UI not loading in.
      //
      // By force-creating the FloorCompositor here and calling renderer.compile()
      // on its scene, the driver compiles all shaders during the loading phase
      // where a brief stall is acceptable and the loading bar is already visible.
      safeCall(() => {
        loadingOverlay.setStage('effects.core', 0.10, 'Initializing V2 compositor...', { keepAuto: true });
      }, 'overlay.v2CompositorInit', Severity.COSMETIC);

      if (isDebugLoad) dlp.begin('v2.floorCompositor.warmup', 'setup');
      log.info('[loading] V2 FloorCompositor warmup START');
      
      // Yield before creating the compositor so the loading screen can paint.
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Force-create the FloorCompositor. This is synchronous and can be expensive
      // (creates render targets, registers hooks, syncs lights). Wrap in safeCall
      // but don't await it ->-> we just need the compositor instance created.
      let fc = null;
      safeCall(() => {
        fc = effectComposer._getFloorCompositorV2({
          // Fire setStage('effects.core') after each effect is initialized so the
          // bar advances steadily across the 38 effects instead of one frozen block.
          onProgress: (label, index, total) => {
            safeCall(() => {
              const p = 0.10 + (index / total) * 0.85;
              loadingOverlay.setStage('effects.core', p, `Loading ${label}...`, { keepAuto: true });
            }, 'overlay.compositor.progress', Severity.COSMETIC);
          },
        });
        log.info('V2 FloorCompositor instance created');
      }, 'v2.floorCompositor.create', Severity.DEGRADED);
      
      // Yield again after creation to let the browser breathe.
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Skip the expensive renderer.compile() warmup. Shaders will compile lazily
      // on the first render frame instead. This prevents indefinite freezes on
      // certain GPU/driver combinations (observed: NVIDIA on Windows).
      if (fc) {
        log.info('V2 FloorCompositor: skipping shader warmup (will compile lazily on first render)');
        console.log('   warmup: skipped ->-> shaders will compile lazily');
      }
      
      log.info('[loading] V2 FloorCompositor warmup DONE');
      if (isDebugLoad) dlp.end('v2.floorCompositor.warmup');

      // Advance progress through the stages that V2 skips (effects.core ->-> deps ->-> wire).
      // Each transition yields to the browser so the progress bar can repaint.
      // Without these yields, the main thread runs synchronously from 30% to 60%
      // and the user sees the bar frozen at 30% for the entire duration.
      safeCall(() => {
        loadingOverlay.setStage('effects.core', 1.0, 'V2 compositor ready', { keepAuto: true });
      }, 'overlay.v2CompositorDone', Severity.COSMETIC);
      await new Promise(r => setTimeout(r, 0)); // yield so browser paints 45%
      console.log('   V2 yield 1/3 done');

      safeCall(() => {
        loadingOverlay.setStage('effects.deps', 1.0, 'Effects skipped (V2)', { keepAuto: true });
      }, 'overlay.v2SkipDeps', Severity.COSMETIC);
      await new Promise(r => setTimeout(r, 0)); // yield so browser paints 55%
      console.log('   V2 yield 2/3 done');

      safeCall(() => {
        loadingOverlay.setStage('effects.wire', 1.0, 'Wiring skipped (V2)', { keepAuto: true });
      }, 'overlay.v2SkipWire', Severity.COSMETIC);
      await new Promise(r => setTimeout(r, 0)); // yield so browser paints 60%
      console.log('   V2 yield 3/3 done ->-> exiting V2 warmup block');


    // Step 4a: Initialize token manager
    // V2: TokenManager is required for token rendering + interaction parity.
    if (isDebugLoad) dlp.begin('manager.TokenManager.init', 'manager');
    _setCreateThreeCanvasProgress('scene.managers.tokens.init');
    console.log(' -> Manager: TokenManager');
    if (tokenManager) {
      safeDispose(() => tokenManager.dispose(), 'tokenManager.dispose(reinit)');
      tokenManager = null;
    }
    tokenManager = new TokenManager(threeScene);
    tokenManager.setEffectComposer(effectComposer);
    tokenManager.initialize();
    // Register as updatable so TokenManager.update() runs every frame.
    // V2 self-heal in update() migrates token sprites from threeScene into the
    // FloorRenderBus scene (V2 only renders the bus scene, not threeScene).
    effectComposer.addUpdatable(tokenManager);
    if (window.MapShine) window.MapShine.tokenManager = tokenManager;
    if (isDebugLoad) dlp.end('manager.TokenManager.init');
    console.log(' -> Manager: TokenManager DONE');

    // CRITICAL: Expose managers on window.MapShine so other subsystems
    // (e.g. TokenManager.updateSpriteVisibility) can check VC state.
    // Without this, the VC early-return path is never taken and
    // refreshToken hooks constantly override sprite.visible.
    if (window.MapShine) {
      window.MapShine.visibilityController = visibilityController;
      window.MapShine.detectionFilterEffect = detectionFilterEffect;
    }

    safeCall(() => {
      loadingOverlay.setStage('scene.managers', 0.05, 'Initializing token manager...', { keepAuto: true });
    }, 'overlay.tokens', Severity.COSMETIC);
    // Yield so the browser can paint the scene.sync stage transition.
    _setCreateThreeCanvasProgress('scene.managers.yield.beforeTiles');
    await new Promise(r => setTimeout(r, 0));

    // Step 4b: Initialize tile manager
    // V2: TileManager is kept for tile selection/interaction in the Foundry UI,
    // but FloorRenderBus loads textures independently (via THREE.TextureLoader).
    // All effect-dependent wiring (specular, fluid, binding manager, floor
    // presence scenes, water occluder) is skipped.
    if (isDebugLoad) dlp.begin('manager.TileManager.init', 'manager');
    _setCreateThreeCanvasProgress('scene.managers.tiles.init');
    console.log(' -> Manager: TileManager');
    console.log('   -> TileManager: constructor...');
    tileManager = new TileManager(threeScene);
    console.log('   -> TileManager: constructor DONE');
    console.log('   -> TileManager: initialize...');
    tileManager.initialize();
    console.log('   -> TileManager: initialize DONE');
    console.log('   -> TileManager: syncAllTiles...');
    tileManager.syncAllTiles();
    console.log('   -> TileManager: syncAllTiles DONE');
    effectComposer.addUpdatable(tileManager); // Register for occlusion updates
    if (isDebugLoad) dlp.end('manager.TileManager.syncAll');
    console.log(' -> Manager: TileManager DONE (synced)');
    log.info('Tile manager initialized and synced');
    // Yield after tile sync so fire-and-forget texture fetches can start and
    // the browser can repaint the progress bar.
    _setCreateThreeCanvasProgress('scene.managers.yield.afterTiles');
    await new Promise(r => setTimeout(r, 0));

    // Step 4b.0: Initialize FloorStack ->-> derives per-floor elevation bands from
    // the LevelsImportSnapshot and provides the setFloorVisible() API used by
    // the per-floor render loop (Phase 2) and depth captures.
    // KEEP for V2 ->-> FloorStack is essential for floor band discovery.
    _setCreateThreeCanvasProgress('scene.managers.floorStack.init');
    floorStack = new FloorStack();
    floorStack.setManagers(tileManager, tokenManager);
    floorStack.rebuildFloors(
      window.MapShine?.levelsSnapshot?.sceneLevels ?? null,
      window.MapShine?.activeLevelContext ?? null
    );
    if (window.MapShine) window.MapShine.floorStack = floorStack;
    log.info('FloorStack initialized');

    // Step 4b.0.1: Initialize FloorLayerManager (Compositor V2).
    // KEEP for V2 ->-> essential for assigning tiles to floor layers.
    _setCreateThreeCanvasProgress('scene.managers.floorLayerManager.init');
    const floorLayerManager = new FloorLayerManager();
    floorLayerManager.setFloorStack(floorStack);
    if (window.MapShine) window.MapShine.floorLayerManager = floorLayerManager;
    log.info('FloorLayerManager initialized');

    // Step 4b.1: Initialize tile motion runtime manager
    if (tileMotionManager) {
      safeDispose(() => {
        effectComposer?.removeUpdatable?.(tileMotionManager);
        tileMotionManager.dispose();
      }, 'tileMotionManager.dispose(reinit)');
    }
    tileMotionManager = new TileMotionManager(tileManager);
    await Promise.resolve(tileMotionManager.initialize());
    effectComposer.addUpdatable(tileMotionManager);
    if (window.MapShine) window.MapShine.tileMotionManager = tileMotionManager;
    log.info('Tile motion manager initialized');

    safeCall(() => loadingOverlay.setStage('scene.managers', 0.30, 'Setting up floor layers...', { keepAuto: true }), 'overlay.tiles', Severity.COSMETIC);

    // V2: SurfaceRegistry is effect infrastructure ->-> skip.

    // Step 4c: Initialize wall manager
    if (isDebugLoad) dlp.begin('manager.WallManager.init', 'manager');
    _setCreateThreeCanvasProgress('scene.managers.walls.init');
    console.log(' -> Manager: WallManager');
    wallManager = new WallManager(threeScene);
    wallManager.initialize();
    if (isDebugLoad) dlp.end('manager.WallManager.init');
    console.log(' -> Manager: WallManager DONE');
    // Sync happens in initialize
    log.info('Wall manager initialized');

    // Step 4d: Initialize token movement manager (movement styles + path policies)
    if (isDebugLoad) dlp.begin('manager.TokenMovement.init', 'manager');
    _setCreateThreeCanvasProgress('scene.managers.tokenMovement.init');
    console.log(' -> Manager: TokenMovementManager');
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
    console.log(' -> Manager: TokenMovementManager DONE');
    log.info('Token movement manager initialized');

    safeCall(() => loadingOverlay.setStage('scene.managers', 0.50, 'Initializing movement manager...', { keepAuto: true }), 'overlay.walls', Severity.COSMETIC);

    // P1.3: Parallel initialization of independent lightweight managers.
    // These managers only create THREE objects and register Foundry hooks ->-> they
    // don't depend on each other or on tokens/tiles/walls, so it's safe to run
    // them concurrently. MapPointsManager is async and included in the batch.
    safeCall(() => loadingOverlay.setStage('scene.managers', 0.65, 'Syncing scene objects...', { keepAuto: true }), 'overlay.remaining', Severity.COSMETIC);

    _setCreateThreeCanvasProgress('scene.managers.lightweightBatch.construct');
    console.log(' -> Manager: Lightweight batch (Door, Note, Template, LightIcon, EnhancedLightIcon, SoundIcon, MapPoints, Grid)');

    if (!sceneComposer) {
      // This can happen if the scene load session becomes stale (scene switch)
      // or teardown/context-loss logic clears globals mid-initialize.
      // Treat it as a graceful abort instead of hard-crashing the entire init.
      log.warn('createThreeCanvas: SceneComposer was null after initialize(); aborting manager init gracefully');
      safeDispose(() => destroyThreeCanvas(), 'destroyThreeCanvas(sceneComposer-null)');
      return;
    }

    // Use the camera returned by SceneComposer.initialize() rather than reading
    // from the sceneComposer instance. During recovery/context-loss pathways the
    // global sceneComposer ref can be cleared while the local `camera` is still
    // valid for this init phase.
    doorMeshManager = new DoorMeshManager(threeScene, camera);
    // Grid overlay must live in the V2 render-bus scene because late overlay
    // rendering reads from FloorCompositor._renderBus._scene.
    const gridHostScene = fc?._renderBus?._scene ?? threeScene;
    if (gridRenderer) {
      safeDispose(() => { if (effectComposer) effectComposer.removeUpdatable(gridRenderer); }, 'removeUpdatable(gridRenderer.reinit)');
      safeDispose(() => gridRenderer.dispose(), 'gridRenderer.dispose(reinit)');
    }
    gridRenderer = new GridRenderer(gridHostScene);
    pixiContentLayerBridge = new PixiContentLayerBridge();
    pixiContentLayerBridge.initialize();
    // Drawings ownership test mode:
    // Keep PIXI as the single visual source for drawings so the content bridge
    // can be validated in isolation. Three-native DrawingManager remains disabled.
    drawingManager = null;
    noteManager = null;
    templateManager = null;
    lightIconManager = null;
    enhancedLightIconManager = null;
    soundIconManager = null;
    mapPointsManager = new MapPointsManager(threeScene);

    if (isDebugLoad) {
      // Debug mode: initialize managers sequentially for accurate per-manager timing
      const lightweightManagers = [
        ['manager.DoorMesh.init', doorMeshManager],
        ['manager.MapPoints.init', mapPointsManager],
        ['manager.GridRenderer.init', gridRenderer],
      ];
      for (const [id, mgr] of lightweightManagers) {
        dlp.begin(id, 'manager');
        _setCreateThreeCanvasProgress(`scene.managers.${id}`);
        await Promise.resolve(mgr.initialize());
        dlp.end(id);
      }
    } else {
      // Normal mode: initialize all in parallel (most are synchronous; mapPointsManager is async)
      _setCreateThreeCanvasProgress('scene.managers.lightweightBatch.init');
      await Promise.all([
        Promise.resolve(doorMeshManager.initialize()),
        mapPointsManager.initialize(),
        Promise.resolve(gridRenderer.initialize()),
      ]);
    }

    effectComposer.addUpdatable(doorMeshManager);
    effectComposer.addUpdatable(gridRenderer);
    if (window.MapShine) window.MapShine.doorMeshManager = doorMeshManager;
    console.log(' -> Manager: Lightweight batch DONE');
    log.info('Parallel manager batch initialized (Door, MapPoints, Grid)');

    // Wire map points to particle effects (fire, candle flame, smelly flies, etc.)
    // V2: No particle effects ->-> skip wiring.

    // Step 4i: Initialize physics ropes (rope/chain map points)
    // V2: Ropes are visual effects ->-> skip.

    // Step 5: Initialize interaction manager (Selection, Drag/Drop)
    // KEEP for V2 ->-> user interaction is essential.
    if (isDebugLoad) dlp.begin('manager.Interaction.init', 'manager');
    _setCreateThreeCanvasProgress('scene.managers.interaction.init');
    console.log(' -> Manager: InteractionManager');
    interactionManager = new InteractionManager(threeCanvas, sceneComposer, tokenManager, tileManager, wallManager, lightIconManager, soundIconManager);
    interactionManager.initialize();
    effectComposer.addUpdatable(interactionManager); // Register for updates (HUD positioning)
    if (isDebugLoad) dlp.end('manager.Interaction.init');
    console.log(' -> Manager: InteractionManager DONE');
    log.info('Interaction manager initialized');
    safeCall(() => loadingOverlay.setStage('scene.managers', 0.80, 'Building interaction systems...', { keepAuto: true }), 'overlay.interaction', Severity.COSMETIC);

    // Wire token movement hook for ash disturbance.
    // V2: Route into the V2 ash disturbance effect if present.
    safeCall(() => {
      if (window.MapShine?.__msaAshDisturbanceHookId) {
        try { Hooks.off('updateToken', window.MapShine.__msaAshDisturbanceHookId); } catch (_) {}
        window.MapShine.__msaAshDisturbanceHookId = null;
      }

      // Use updateToken hook so we also catch server-confirmed movements.
      const hookId = Hooks.on('updateToken', (tokenDoc, changes) => {
        try {
          if (!tokenDoc?.id) return;
          if (!('x' in (changes || {})) && !('y' in (changes || {}))) return;
          const fc = window.MapShine?.effectComposer?._floorCompositorV2;
          const ash = fc?._ashDisturbanceEffect;
          if (ash && typeof ash.handleTokenMovement === 'function') {
            ash.handleTokenMovement(tokenDoc.id);
          }
        } catch (_) {}
      });

      if (window.MapShine) window.MapShine.__msaAshDisturbanceHookId = hookId;
    }, 'wireAshDisturbanceHook(V2)', Severity.COSMETIC);

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
    _setCreateThreeCanvasProgress('scene.managers.overlayUI.init');
    overlayUIManager = new OverlayUIManager(threeCanvas, sceneComposer);
    overlayUIManager.initialize();
    effectComposer.addUpdatable(overlayUIManager);
    if (isDebugLoad) dlp.end('manager.OverlayUI.init');

    lightEditor = null;

    // Expose for InteractionManager selection routing and debugging.
    if (window.MapShine) {
      window.MapShine.interactionManager = interactionManager;
      window.MapShine.mouseStateManager = interactionManager?.mouseStateManager ?? null;
      window.MapShine.pixiContentLayerBridge = pixiContentLayerBridge;
      window.MapShine.overlayUIManager = overlayUIManager;
      window.MapShine.lightEditor = lightEditor;
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
    _setCreateThreeCanvasProgress('scene.managers.dropHandler.init');
    dropHandler = new DropHandler(threeCanvas, sceneComposer);
    dropHandler.initialize();
    if (isDebugLoad) dlp.end('manager.DropHandler.init');
    log.info('Drop handler initialized');

    // Step 6: Initialize Camera Follower
    // Simple one-way sync: Three.js camera follows PIXI camera each frame.
    // PIXI/Foundry handles all pan/zoom input - we just read and match.
    // This eliminates bidirectional sync issues and race conditions.
    if (isDebugLoad) dlp.begin('manager.CameraFollower.init', 'manager');
    _setCreateThreeCanvasProgress('scene.managers.cameraFollower.init');
    console.log(' -> Manager: CameraFollower');
    cameraFollower = new CameraFollower({ sceneComposer });
    cameraFollower.initialize();
    effectComposer.addUpdatable(cameraFollower); // Per-frame sync
    safeCall(() => {
      if (window.MapShine) {
        window.MapShine.levelNavigationController = cameraFollower;
      }
    }, 'exposeLevelNavigationController', Severity.COSMETIC);
    if (isDebugLoad) dlp.end('manager.CameraFollower.init');
    console.log(' -> Manager: CameraFollower DONE');
    log.info('Camera follower initialized - Three.js follows PIXI');

    // Step 6.05: Compact level navigator overlay (always visible on levels-enabled scenes).
    if (isDebugLoad) dlp.begin('manager.LevelNavigatorOverlay.init', 'manager');
    _setCreateThreeCanvasProgress('scene.managers.levelNavigatorOverlay.init');
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
    _setCreateThreeCanvasProgress('scene.managers.pixiInputBridge.init');
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
    safeCall(() => loadingOverlay.setStage('scene.managers', 0.93, 'Setting up camera...', { keepAuto: true }), 'overlay.camera', Severity.COSMETIC);

    // Step 6a.5: Initialize cinematic camera manager
    if (isDebugLoad) dlp.begin('manager.CinematicCamera.init', 'manager');
    _setCreateThreeCanvasProgress('scene.managers.cinematicCamera.init');
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
    safeCall(() => loadingOverlay.setStage('scene.sync', 0.5, 'Syncing scene state...', { keepAuto: true }), 'overlay.sceneSync', Severity.COSMETIC);

    // BASELINE: Skip ControlsIntegration (V1 component causing crashes in V2 mode)
    console.log(' -> Manager: ControlsIntegration SKIPPED (V2 baseline)');
    controlsIntegration = null;
    log.info('Controls integration SKIPPED (V2 baseline mode)');

    // V2: Re-apply PIXI suppression on common Foundry vision/token events.
    // Foundry can re-show board/fog/visibility containers during these updates.
    safeCall(() => {
      // Clear any previous installs (scene resets / recovery init).
      for (const h of _pixiSuppressionHookIds) {
        try { Hooks.off(h.hook, h.id); } catch (_) {}
      }
      _pixiSuppressionHookIds = [];

      // Also clear any previous ticker enforcement so we don't double-install.
      if (_pixiSuppressionTickerFn) {
        try { canvas?.app?.ticker?.remove?.(_pixiSuppressionTickerFn); } catch (_) {}
        _pixiSuppressionTickerFn = null;
        _pixiSuppressionTickerLastMs = 0;
      }

      const install = (hook) => {
        try {
          const id = Hooks.on(hook, () => {
            try { _enforceGameplayPixiSuppression(); } catch (_) {}
            try { _updateFoundrySelectRectSuppression(); } catch (_) {}
          });
          _pixiSuppressionHookIds.push({ hook, id });
        } catch (_) {}
      };

      install('sightRefresh');
      install('controlToken');
      install('refreshToken');
      install('updateToken');
      install('activateCanvasLayer');
      install('renderSceneControls');

      // V2 baseline: Foundry can re-enable controls.doors and per-wall DoorControl
      // visibility continuously as part of its own ControlsLayer workflows.
      // Enforce suppression every PIXI tick (throttled) to prevent duplicate
      // door icons stuck at (0,0) when PIXI transforms drift.
      try {
        const ticker = canvas?.app?.ticker;
        if (ticker?.add) {
          _pixiSuppressionTickerFn = () => {
            const now = performance.now();
            if ((now - _pixiSuppressionTickerLastMs) < 33) return;
            _pixiSuppressionTickerLastMs = now;
            try { _enforceGameplayPixiSuppression(); } catch (_) {}
            try { _updateFoundrySelectRectSuppression(); } catch (_) {}
          };
          ticker.add(_pixiSuppressionTickerFn, null, -75);
        }
      } catch (_) {
      }
    }, 'pixiSuppress.installHooks', Severity.COSMETIC);

    dlp.event('sceneSync: DONE ->-> entering finalization');
    _sectionEnd('sceneSync');
    _sectionStart('finalization');
    safeCall(() => {
      loadingOverlay.setStage('final', 0.0, 'Finalizing...', { immediate: true, keepAuto: true });
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
    // When V2 compositor is active, all effect shaders are bypassed at runtime.
    // V2 uses MeshBasicMaterial only ->-> no custom shaders to warm up.
    // Skip the full progressive warmup to avoid compiling 30+ unused shaders.
    _sectionStart('gpu.shaderCompile');
    if (isDebugLoad) dlp.begin('gpu.shaderCompile', 'gpu');
    {
      // V2 compositor is always-on. Legacy V1 progressive shader warmup has been removed.
      safeCall(() => loadingOverlay.setStage('final', 0.05, 'Shaders ready...', { keepAuto: true }), 'overlay.shaderCompile', Severity.COSMETIC);
      dlp.event('gpu.shaderCompile: SKIPPED ->-> V2 compositor active');
      log.info('Shader warmup skipped: V2 compositor active');
    }
    if (isDebugLoad) dlp.end('gpu.shaderCompile');
    _sectionEnd('gpu.shaderCompile');

    // Step 8: Start render loop
    console.log(' -> Step: renderLoop.start');
    renderLoop = new RenderLoop(renderer, threeScene, camera, effectComposer);
    renderLoop.start();
    console.log(' -> Step: renderLoop.start DONE');
    // Update ModeManager with the now-created renderLoop reference
    if (modeManager) modeManager._deps.renderLoop = renderLoop;

    dlp.event('renderLoop: STARTED ->-> first rAF frame queued');
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

    // V2 compositor does not sample PIXI textures, so FrameCoordinator is unused.
    if (frameCoordinatorInitialized) {
      safeDispose(() => {
        frameCoordinator.dispose();
        frameCoordinatorInitialized = false;
      }, 'frameCoordinator.dispose(v2)');
    }
    mapShine.frameCoordinator = null;

    // V2 fog is owned by FloorCompositor._fogEffect; no legacy fog-manager wrapping.

    // Expose all managers, effects, and functions on window.MapShine for diagnostics
    exposeGlobals(mapShine, {
      effectMap,
      sceneComposer, effectComposer, cameraFollower, pixiInputBridge,
      cinematicCameraManager, cameraPanel, levelsAuthoring,
      levelNavigatorOverlay,
      tokenManager, tokenMovementManager, tileManager, visibilityController, detectionFilterEffect,
      wallManager, doorMeshManager,
      drawingManager, noteManager, templateManager, lightIconManager,
      pixiContentLayerBridge,
      soundIconManager,
      enhancedLightIconManager, enhancedLightInspector, interactionManager,
      mouseStateManager: interactionManager?.mouseStateManager ?? null,
      overlayUIManager, lightEditor, gridRenderer, mapPointsManager,
      tileMotionManager,
      weatherController, renderLoop, sceneDebug, controlsIntegration,
      dynamicExposureManager, physicsRopeManager, assetLoader,
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
    // V2: We still need UI so we can validate layering / debugging, but we do NOT
    // register effect controls or apply weather snapshots.
    _sectionStart('fin.initializeUI');
    if (isDebugLoad) dlp.begin('fin.initializeUI', 'finalize');
    _setCreateThreeCanvasProgress('initializeUI');
    console.log(' -> Step: initializeUI');
    await safeCallAsync(async () => {
      if (session.isStale()) return;

      safeCall(() => { if (window.MapShine) window.MapShine.stateApplier = stateApplier; }, 'exposeStateApplier', Severity.COSMETIC);

        if (!uiManager) {
          uiManager = new TweakpaneManager();
          await uiManager.initialize();
          if (window.MapShine) window.MapShine.uiManager = uiManager;
        }

        if (!controlPanel) {
          controlPanel = new ControlPanelManager();
          await controlPanel.initialize();
          if (window.MapShine) window.MapShine.controlPanel = controlPanel;
        }

        if (!cinematicCameraManager) {
          cinematicCameraManager = new CinematicCameraManager();
          cinematicCameraManager.initialize();
          if (window.MapShine) window.MapShine.cinematicCameraManager = cinematicCameraManager;
        }

        if (!cameraPanel) {
          cameraPanel = new CameraPanelManager(cinematicCameraManager);
          cameraPanel.initialize();
          if (window.MapShine) window.MapShine.cameraPanel = cameraPanel;
        } else {
          safeCall(() => cameraPanel.setCinematicManager(cinematicCameraManager), 'cameraPanel.sync', Severity.COSMETIC);
        }

        // Levels Authoring Dialog (GM only) ->-> required to validate tile floor assignments.
        if (!levelsAuthoring && game.user?.isGM) {
          levelsAuthoring = new LevelsAuthoringDialog();
          levelsAuthoring.initialize();
          safeCall(() => { if (window.MapShine) window.MapShine.levelsAuthoring = levelsAuthoring; }, 'exposeLevelsAuthoring', Severity.COSMETIC);
        }

        // ->->->-> Register V2 effect controls in Tweakpane ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->
        // V1 effects are NOT constructed in V2 mode, but we still need UI
        // controls for the V2 post-processing effects on FloorCompositor.
        // Schemas come from V1 static getControlSchema() (classes are imported).
        // Callbacks use lazy lookup so they work even though FloorCompositor
        // is lazily created on first render frame.
        const _propagateToV2 = (effectKey, paramId, value) => {
          try {
            // Queue param updates until FloorCompositorV2 exists.
            // In V2 mode the compositor is created lazily on first render; UI can
            // initialize (and users can tweak values) before it exists.
            // Without this queue, early UI changes are dropped and appear to do nothing.
            if (window.MapShine) {
              if (!window.MapShine.__pendingV2EffectParams) window.MapShine.__pendingV2EffectParams = {};
              const pendAll = window.MapShine.__pendingV2EffectParams;
              if (!pendAll[effectKey]) pendAll[effectKey] = {};
              pendAll[effectKey][paramId] = value;
            }

            const fc = window.MapShine?.effectComposer?._floorCompositorV2;
            if (!fc) return;
            const effect = fc[effectKey];
            if (!effect) return;

            // Flush any queued params for this effect now that it exists.
            try {
              const pend = window.MapShine?.__pendingV2EffectParams?.[effectKey];
              if (pend && typeof pend === 'object') {
                for (const [k, v] of Object.entries(pend)) {
                  // Prefer effect.enabled setter when present.
                  if (k === 'enabled' || k === 'masterEnabled') {
                    if (typeof effect.enabled !== 'undefined') {
                      try { effect.enabled = !!v; } catch (_) {}
                    }
                    if (effect.params && Object.prototype.hasOwnProperty.call(effect.params, 'enabled')) {
                      effect.params.enabled = !!v;
                    }
                    continue;
                  }
                  if (effect.params && Object.prototype.hasOwnProperty.call(effect.params, k)) {
                    effect.params[k] = v;
                  }
                }
                // Clear after flush so future updates apply directly.
                window.MapShine.__pendingV2EffectParams[effectKey] = {};
              }
            } catch (_) {}

            // Prefer effect.enabled setter when present (several V2 overlay effects
            // keep enabled state on the instance and mirror it into params).
            if (paramId === 'enabled' || paramId === 'masterEnabled') {
              if (typeof effect.enabled !== 'undefined') {
                try { effect.enabled = !!value; } catch (_) {}
              }
              if (effect.params && Object.prototype.hasOwnProperty.call(effect.params, 'enabled')) {
                effect.params.enabled = !!value;
              }
              return;
            }

            if (typeof effect.applyParamChange === 'function') {
              effect.applyParamChange(paramId, value);
            } else if (effect.params && Object.prototype.hasOwnProperty.call(effect.params, paramId)) {
              effect.params[paramId] = value;
            }
          } catch (_) {}
        };

        const _makeV2Callback = (effectKey) => (effectId, paramId, value) => {
          _propagateToV2(effectKey, paramId, value);
        };

        safeCall(() => {
          const weatherSchema =
            WeatherController?.getControlSchema?.() ||
            weatherController?.constructor?.getControlSchema?.();
          if (!weatherSchema) return;
          const onWeatherUpdate = (_effectId, paramId, value) => {
            try {
              const st = weatherController.targetState;
              const cur = weatherController.currentState;
              const THREE = window.THREE;

              if (paramId === 'enabled' || paramId === 'masterEnabled') {
                weatherController.enabled = !!value;
                return;
              }

              if (paramId === 'dynamicEnabled') return weatherController.setDynamicEnabled(!!value);
              if (paramId === 'dynamicPresetId') return weatherController.setDynamicPreset(String(value || 'Temperate Plains'));
              if (paramId === 'dynamicEvolutionSpeed') return weatherController.setDynamicEvolutionSpeed(Number(value) || 0);
              if (paramId === 'dynamicPaused') return weatherController.setDynamicPaused(!!value);
              if (paramId === 'dynamicPlanDurationMinutes') return weatherController.setDynamicPlanDurationMinutes(Number(value) || 0.1);

              if (paramId === 'dynamicBoundsEnabled') return weatherController.setDynamicBoundsEnabled(!!value);
              if (paramId.startsWith('dynamicBounds')) {
                const key = paramId.replace('dynamicBounds', '');
                const boundKey = key.charAt(0).toLowerCase() + key.slice(1);
                weatherController.setDynamicBound(boundKey, Number(value) || 0);
                return;
              }

              if (paramId === 'queueFromCurrent') return weatherController.queueTransitionFromCurrent();
              if (paramId === 'startQueuedTransition') return weatherController.startQueuedTransition(weatherController.transitionDuration);
              if (paramId.startsWith('queued')) return weatherController.setQueuedTransitionParam(paramId, Number(value) || 0);

              if (paramId === 'transitionDuration') {
                weatherController.transitionDuration = Number(value) || 0.1;
                return;
              }
              if (paramId === 'presetTransitionDurationMinutes') {
                const mins = Math.max(0.1, Number(value) || 0.5);
                weatherController.presetTransitionDurationSeconds = mins * 60.0;
                return;
              }

              if (paramId === 'variability') return weatherController.setVariability(Number(value) || 0);
              if (paramId === 'simulationSpeed') {
                weatherController.simulationSpeed = Math.max(0.01, Number(value) || 1.0);
                return;
              }

              if (paramId === 'precipitation') {
                const v = Math.max(0, Math.min(1, Number(value) || 0));
                st.precipitation = v;
                cur.precipitation = v;
                return;
              }
              if (paramId === 'cloudCover') {
                const v = Math.max(0, Math.min(1, Number(value) || 0));
                st.cloudCover = v;
                cur.cloudCover = v;
                return;
              }
              if (paramId === 'fogDensity') {
                const v = Math.max(0, Math.min(1, Number(value) || 0));
                st.fogDensity = v;
                cur.fogDensity = v;
                return;
              }
              if (paramId === 'wetness') {
                const v = Math.max(0, Math.min(1, Number(value) || 0));
                st.wetness = v;
                cur.wetness = v;
                return;
              }
              if (paramId === 'freezeLevel') {
                const v = Math.max(0, Math.min(1, Number(value) || 0));
                st.freezeLevel = v;
                cur.freezeLevel = v;
                return;
              }
              if (paramId === 'ashIntensity') {
                const v = Math.max(0, Math.min(1, Number(value) || 0));
                st.ashIntensity = v;
                cur.ashIntensity = v;
                return;
              }

              if (paramId === 'windSpeed') {
                const v = Math.max(0, Math.min(1, Number(value) || 0));
                st.windSpeed = v;
                cur.windSpeed = v;
                return;
              }
              if (paramId === 'windDirection') {
                const deg = Number(value) || 0;
                const rad = (deg * Math.PI) / 180;
                const x = Math.cos(rad);
                const y = -Math.sin(rad);
                if (st.windDirection?.set) st.windDirection.set(x, y);
                else st.windDirection = { x, y };
                if (cur.windDirection?.set) cur.windDirection.set(x, y);
                else cur.windDirection = { x, y };
                return;
              }

              if (paramId === 'gustWaitMin') return void (weatherController.gustWaitMin = Number(value) || 0);
              if (paramId === 'gustWaitMax') return void (weatherController.gustWaitMax = Number(value) || 0);
              if (paramId === 'gustDuration') return void (weatherController.gustDuration = Number(value) || 0.1);
              if (paramId === 'gustStrength') return void (weatherController.gustStrength = Number(value) || 0);

              if (paramId === 'wettingDuration') return void (weatherController.wetnessTuning.wettingDuration = Number(value) || 1);
              if (paramId === 'dryingDuration') return void (weatherController.wetnessTuning.dryingDuration = Number(value) || 1);
              if (paramId === 'precipThreshold') return void (weatherController.wetnessTuning.precipThreshold = Number(value) || 0);

              if (paramId === 'roofMaskForceEnabled') {
                weatherController.roofMaskForceEnabled = !!value;
                return;
              }

              const rainMap = {
                rainIntensityScale: 'intensityScale',
                rainStreakLength: 'streakLength',
                rainDropSize: 'dropSize',
                rainDropSizeMin: 'dropSizeMin',
                rainDropSizeMax: 'dropSizeMax',
                rainBrightness: 'brightness',
                rainGravityScale: 'gravityScale',
                rainWindInfluence: 'windInfluence',
                rainCurlStrength: 'curlStrength',
                rainSplash1IntensityScale: 'splash1IntensityScale',
                rainSplash1LifeMin: 'splash1LifeMin',
                rainSplash1LifeMax: 'splash1LifeMax',
                rainSplash1SizeMin: 'splash1SizeMin',
                rainSplash1SizeMax: 'splash1SizeMax',
                rainSplash1OpacityPeak: 'splash1OpacityPeak',
                rainSplash2IntensityScale: 'splash2IntensityScale',
                rainSplash2LifeMin: 'splash2LifeMin',
                rainSplash2LifeMax: 'splash2LifeMax',
                rainSplash2SizeMin: 'splash2SizeMin',
                rainSplash2SizeMax: 'splash2SizeMax',
                rainSplash2OpacityPeak: 'splash2OpacityPeak',
                rainSplash3IntensityScale: 'splash3IntensityScale',
                rainSplash3LifeMin: 'splash3LifeMin',
                rainSplash3LifeMax: 'splash3LifeMax',
                rainSplash3SizeMin: 'splash3SizeMin',
                rainSplash3SizeMax: 'splash3SizeMax',
                rainSplash3OpacityPeak: 'splash3OpacityPeak',
                rainSplash4IntensityScale: 'splash4IntensityScale',
                rainSplash4LifeMin: 'splash4LifeMin',
                rainSplash4LifeMax: 'splash4LifeMax',
                rainSplash4SizeMin: 'splash4SizeMin',
                rainSplash4SizeMax: 'splash4SizeMax',
                rainSplash4OpacityPeak: 'splash4OpacityPeak'
              };
              if (Object.prototype.hasOwnProperty.call(rainMap, paramId)) {
                weatherController.rainTuning[rainMap[paramId]] = Number(value) || 0;
                return;
              }

              const snowMap = {
                snowIntensityScale: 'intensityScale',
                snowFlakeSize: 'flakeSize',
                snowBrightness: 'brightness',
                snowGravityScale: 'gravityScale',
                snowWindInfluence: 'windInfluence',
                snowCurlStrength: 'curlStrength',
                snowFlutterStrength: 'flutterStrength'
              };
              if (Object.prototype.hasOwnProperty.call(snowMap, paramId)) {
                weatherController.snowTuning[snowMap[paramId]] = Number(value) || 0;
                return;
              }

              // Keep wind-direction visual sync if a wind vane binding exists.
              if (paramId === 'windDirection' && THREE) {
                safeCall(() => uiManager?.updateControlStates?.('weather'), 'weather.syncWindUI', Severity.COSMETIC);
              }
            } catch (_) {}
          };

          uiManager.registerEffect('weather', 'Weather', weatherSchema, onWeatherUpdate, 'atmospheric');
        }, 'v2.registerWeatherUI', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('lighting', 'Lighting & Tone Mapping',
            LightingEffectV2.getControlSchema(), _makeV2Callback('_lightingEffect'), 'global');
        }, 'v2.registerLightingUI', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('specular', 'Metallic / Specular',
            SpecularEffectV2.getControlSchema(), _makeV2Callback('_specularEffect'), 'surface');
        }, 'v2.registerSpecularUI', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('fluid', 'Fluid',
            FluidEffectV2.getControlSchema(), _makeV2Callback('_fluidEffect'), 'surface');
        }, 'v2.registerFluidUI', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('iridescence', 'Iridescence',
            IridescenceEffectV2.getControlSchema(), _makeV2Callback('_iridescenceEffect'), 'surface');
        }, 'v2.registerIridescenceUI', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('prism', 'Prism',
            PrismEffectV2.getControlSchema(), _makeV2Callback('_prismEffect'), 'surface');
        }, 'v2.registerPrismUI', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('bush', 'Bush',
            BushEffectV2.getControlSchema(), _makeV2Callback('_bushEffect'), 'surface');
        }, 'v2.registerBushUI', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('tree', 'Tree',
            TreeEffectV2.getControlSchema(), _makeV2Callback('_treeEffect'), 'surface');
        }, 'v2.registerTreeUI', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('sky-color', 'Sky Color',
            SkyColorEffectV2.getControlSchema(), _makeV2Callback('_skyColorEffect'), 'global');
        }, 'v2.registerSkyColorUI', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('windowLight', 'Window Light',
            WindowLightEffectV2.getControlSchema(), _makeV2Callback('_windowLightEffect'), 'structure');
        }, 'v2.registerWindowLightUI', Severity.COSMETIC);
        safeCall(() => loadingOverlay.setStage('final', 0.10, 'Loading effect controls...', { keepAuto: true }), 'overlay.ui.p1', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('fire-sparks', 'Fire',
            FireEffectV2.getControlSchema(), _makeV2Callback('_fireEffect'), 'particle');
        }, 'v2.registerFireUI', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('water-splashes', 'Water Splashes',
            WaterSplashesEffectV2.getControlSchema(), _makeV2Callback('_waterSplashesEffect'), 'particle');
        }, 'v2.registerWaterSplashesUI', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('underwater-bubbles', 'Underwater Bubbles',
            WaterSplashesEffectV2.getBubblesControlSchema(), _makeV2Callback('_underwaterBubblesEffect'), 'particle');
        }, 'v2.registerUnderwaterBubblesUI', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('ash-disturbance', 'Ash Disturbance',
            AshDisturbanceEffectV2.getControlSchema(), _makeV2Callback('_ashDisturbanceEffect'), 'particle');
        }, 'v2.registerAshDisturbanceUI(V2)', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('smelly-flies', 'Smelly Flies',
            SmellyFliesEffect.getControlSchema(), _makeV2Callback('_smellyFliesEffect'), 'particle');
        }, 'v2.registerSmellyFliesUI(V2)', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('lightning', 'Lightning',
            LightningEffectV2.getControlSchema(), _makeV2Callback('_lightningEffect'), 'atmospheric');
        }, 'v2.registerLightningUI(V2)', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('candle-flames', 'Candle Flames',
            CandleFlamesEffectV2.getControlSchema(), _makeV2Callback('_candleFlamesEffect'), 'particle');
        }, 'v2.registerCandleFlamesUI(V2)', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('player-light', 'Player Light',
            PlayerLightEffectV2.getControlSchema(), _makeV2Callback('_playerLightEffect'), 'atmospheric');
        }, 'v2.registerPlayerLightUI(V2)', Severity.COSMETIC);
        safeCall(() => loadingOverlay.setStage('final', 0.18, 'Loading effect controls...', { keepAuto: true }), 'overlay.ui.p2', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('bloom', 'Bloom (Glow)',
            BloomEffectV2.getControlSchema(), _makeV2Callback('_bloomEffect'), 'global');
        }, 'v2.registerBloomUI', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('colorCorrection', 'Color Grading & VFX',
            ColorCorrectionEffectV2.getControlSchema(), _makeV2Callback('_colorCorrectionEffect'), 'global');
        }, 'v2.registerColorCorrectionUI', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('filter', 'Filter (Multiply / Ink AO)',
            FilterEffectV2.getControlSchema(), _makeV2Callback('_filterEffect'), 'global');
        }, 'v2.registerFilterUI', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('atmospheric-fog', 'Atmospheric Fog',
            AtmosphericFogEffectV2.getControlSchema(), _makeV2Callback('_atmosphericFogEffect'), 'atmospheric');
        }, 'v2.registerAtmosphericFogUI', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('fog', 'Fog of War',
            FogOfWarEffectV2.getControlSchema(), _makeV2Callback('_fogEffect'), 'global');
        }, 'v2.registerFogUI', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('sharpen', 'Sharpen',
            SharpenEffectV2.getControlSchema(), _makeV2Callback('_sharpenEffect'), 'global');
        }, 'v2.registerSharpenUI', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('dotScreen', 'Dot Screen',
            DotScreenEffectV2.getControlSchema(), _makeV2Callback('_dotScreenEffect'), 'global');
        }, 'v2.registerDotScreenUI', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('halftone', 'Halftone',
            HalftoneEffectV2.getControlSchema(), _makeV2Callback('_halftoneEffect'), 'global');
        }, 'v2.registerHalftoneUI', Severity.COSMETIC);
        safeCall(() => loadingOverlay.setStage('final', 0.26, 'Loading effect controls...', { keepAuto: true }), 'overlay.ui.p3', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('ascii', 'ASCII Art',
            AsciiEffectV2.getControlSchema(), _makeV2Callback('_asciiEffect'), 'global');
        }, 'v2.registerAsciiUI', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('dazzleOverlay', 'Dazzle Overlay',
            DazzleOverlayEffectV2.getControlSchema(), _makeV2Callback('_dazzleOverlayEffect'), 'global');
        }, 'v2.registerDazzleOverlayUI', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('visionMode', 'Vision Mode',
            VisionModeEffectV2.getControlSchema(), _makeV2Callback('_visionModeEffect'), 'global');
        }, 'v2.registerVisionModeUI', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('invert', 'Color Invert',
            InvertEffectV2.getControlSchema(), _makeV2Callback('_invertEffect'), 'global');
        }, 'v2.registerInvertUI', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('sepia', 'Sepia Tone',
            SepiaEffectV2.getControlSchema(), _makeV2Callback('_sepiaEffect'), 'global');
        }, 'v2.registerSepiaUI', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect('lens', 'Lens',
            LensEffectV2.getControlSchema(), _makeV2Callback('_lensEffect'), 'global');
        }, 'v2.registerLensUI', Severity.COSMETIC);
        safeCall(() => loadingOverlay.setStage('final', 0.34, 'Loading effect controls...', { keepAuto: true }), 'overlay.ui.p4', Severity.COSMETIC);

        // Ash controls: in V2 mode WeatherController isn't constructed as an updatable, but
        // we still expose full ash tuning controls so users can keep it disabled and
        // adjust tuning consistently across V1/V2. The enabled toggle is implemented as a
        // semantic gate that maps to ashIntensity (0 = off).
        safeCall(() => {
          const ashTuning = weatherController?.ashTuning || {};
          const ashWeatherSchema = {
            enabled: false,
            groups: [
              { name: 'ash', label: 'Ashfall', type: 'inline', parameters: ['ashIntensity', 'ashIntensityScale', 'ashEmissionRate'] },
              { name: 'ash-appearance', label: 'Ash Appearance', type: 'inline', separator: true, parameters: ['ashSizeMin', 'ashSizeMax', 'ashLifeMin', 'ashLifeMax', 'ashSpeedMin', 'ashSpeedMax', 'ashOpacityStartMin', 'ashOpacityStartMax', 'ashOpacityEnd', 'ashColorStart', 'ashColorEnd', 'ashBrightness'] },
              { name: 'ash-motion', label: 'Ash Motion', type: 'inline', separator: true, parameters: ['ashGravityScale', 'ashWindInfluence', 'ashCurlStrength'] },
              { name: 'ash-cluster', label: 'Ash Clustering', type: 'inline', separator: true, parameters: ['ashClusterHoldMin', 'ashClusterHoldMax', 'ashClusterRadiusMin', 'ashClusterRadiusMax', 'ashClusterBoostMin', 'ashClusterBoostMax'] },
              { name: 'embers', label: 'Embers', type: 'inline', separator: true, parameters: ['emberEmissionRate', 'emberSizeMin', 'emberSizeMax', 'emberLifeMin', 'emberLifeMax', 'emberSpeedMin', 'emberSpeedMax', 'emberOpacityStartMin', 'emberOpacityStartMax', 'emberOpacityEnd', 'emberColorStart', 'emberColorEnd', 'emberBrightness', 'emberGravityScale', 'emberWindInfluence', 'emberCurlStrength'] }
            ],
            parameters: {
              enabled: { type: 'boolean', default: false },
              ashIntensity: { label: 'Ash Intensity', type: 'slider', default: 0.0, min: 0.0, max: 1.0, step: 0.01 },
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

          const _applyAshIntensity = (intensity) => {
            const v = Math.max(0.0, Math.min(1.0, Number(intensity) || 0.0));
            try {
              if (weatherController?.targetState) weatherController.targetState.ashIntensity = v;
              if (weatherController?.currentState) weatherController.currentState.ashIntensity = v;
            } catch (_) {}
            try {
              if (window.MapShine) window.MapShine.__v2AshIntensity = v;
            } catch (_) {}
          };

          const _syncAshUiParam = (paramId, value) => {
            try {
              const data = uiManager?.effectFolders?.['ash-weather'];
              if (!data?.params) return;
              data.params[paramId] = value;
              if (data.bindings?.[paramId]) {
                data.bindings[paramId].refresh();
              }
            } catch (_) {}
          };

          const onAshWeatherUpdate = (effectId, paramId, value) => {
            try {
              // Enabled toggle semantics: disabling forces intensity to 0 while remembering the last nonzero intensity.
              if (paramId === 'enabled' || paramId === 'masterEnabled') {
                const nextEnabled = !!value;
                if (!window.MapShine) return;
                if (!window.MapShine.__v2AshWeatherState) window.MapShine.__v2AshWeatherState = {};
                const st = window.MapShine.__v2AshWeatherState;

                const currentIntensity = Number(weatherController?.targetState?.ashIntensity ?? window.MapShine.__v2AshIntensity ?? 0) || 0;
                if (nextEnabled === false) {
                  if (currentIntensity > 0) st.lastIntensity = currentIntensity;
                  _applyAshIntensity(0.0);
                  _syncAshUiParam('ashIntensity', 0.0);
                } else {
                  const restore = Number(st.lastIntensity ?? 0.25) || 0.25;
                  _applyAshIntensity(restore);
                  _syncAshUiParam('ashIntensity', restore);
                }
                return;
              }

              if (paramId === 'ashIntensity') {
                const v = Number(value) || 0;
                if (window.MapShine) {
                  if (!window.MapShine.__v2AshWeatherState) window.MapShine.__v2AshWeatherState = {};
                  if (v > 0) window.MapShine.__v2AshWeatherState.lastIntensity = v;
                }
                _applyAshIntensity(v);
                // Slider movement implies enabled=true when intensity>0.
                if (v > 0) _syncAshUiParam('enabled', true);
                return;
              }

              // Tuning updates
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
            } catch (_) {}
          };

          uiManager.registerEffect(
            'ash-weather',
            'Ash (Weather)',
            ashWeatherSchema,
            onAshWeatherUpdate,
            'particle'
          );
        }, 'v2.registerAshWeatherUI', Severity.COSMETIC);

        // ash-disturbance is already registered above via AshDisturbanceEffectV2.getControlSchema()

        safeCall(() => {
          const waterSchema = WaterEffectV2.getControlSchema();
          uiManager.registerEffect('water', 'Water',
            waterSchema, _makeV2Callback('_waterEffect'), 'surface');
          // NOTE: Do NOT push V1 schema defaults into the V2 effect here.
          // The V2 WaterEffectV2 has its own correct constructor defaults which differ
          // substantially from V1 schema defaults (sand, murk, foam, etc.).
          // Pushing V1 defaults queues them in __pendingV2EffectParams and they get
          // flushed wholesale on the first user interaction, overwriting all V2 defaults
          // and producing a completely different-looking water. The scene-flag-saved
          // params are replayed by _getFloorCompositorV2() after lazy creation, which
          // is the correct source of truth for persisted values.
        }, 'v2.registerWaterUI', Severity.COSMETIC);

        // Cloud controls: registered as a top-level effect in V2 mode.
        // The 'weather' parent effect is not registered in V2 (WeatherController
        // is not initialized in V2), so registerEffectUnderEffect would silently
        // fail. Using a direct registerEffect with 'atmospheric' category groups
        // it visually with other weather-adjacent controls.
        safeCall(() => {
          uiManager.registerEffect(
            'cloud', 'Cloud and Cloud Shadow Appearance',
            CloudEffectV2.getControlSchema(), _makeV2Callback('_cloudEffect'), 'atmospheric'
          );
        }, 'v2.registerCloudUI', Severity.COSMETIC);

        // Overhead shadows: uses V1 schema but routes to _overheadShadowEffect on FloorCompositor.
        // V2 now supports indoor shadow projection from _Outdoors mask (indoorShadowEnabled, etc.).
        safeCall(() => {
          uiManager.registerEffect(
            'overhead-shadows', 'Overhead Shadows',
            OverheadShadowsEffectV2.getControlSchema(), _makeV2Callback('_overheadShadowEffect'), 'global'
          );
        }, 'v2.registerOverheadShadowsUI', Severity.COSMETIC);

        safeCall(() => {
          uiManager.registerEffect(
            'building-shadows', 'Building Shadows',
            BuildingShadowsEffectV2.getControlSchema(), _makeV2Callback('_buildingShadowEffect'), 'global'
          );
        }, 'v2.registerBuildingShadowsUI', Severity.COSMETIC);

        safeCall(() => {
          const onGridUpdate = (_effectId, paramId, value) => {
            const grid = window.MapShine?.gridRenderer;
            if (!grid) return;

            // Tweakpane always injects an Enabled toggle. GridRenderer currently
            // models visibility through alpha, so map enabled->alpha consistently.
            if (paramId === 'enabled' || paramId === 'masterEnabled') {
              grid.settings.useAlphaOverride = true;
              if (value === false) {
                grid.settings.alphaOverride = 0;
              } else if (!(Number(grid.settings.alphaOverride) > 0)) {
                grid.settings.alphaOverride = 0.05;
              }
              grid.updateGrid();
              return;
            }

            grid.updateSetting(paramId, value);
          };

          uiManager.registerEffect(
            'grid',
            'Grid',
            GridRenderer.getControlSchema(),
            onGridUpdate,
            'environment'
          );
        }, 'v2.registerGridUI', Severity.COSMETIC);

        log.info('V2: registered effect controls (Lighting, Specular, Fluid, Iridescence, Prism, Bush, Tree, SkyColor, WindowLight, Fire, WaterSplashes, SmellyFlies, Lightning, CandleFlames, Bloom, ColorCorrection, Sharpen, Fog, Water, Cloud, OverheadShadows, BuildingShadows, Grid, Lens)');

        log.info('V2: UI initialized');
    }, 'initializeUI', Severity.DEGRADED);
    console.log(' -> Step: initializeUI DONE');
    if (isDebugLoad) dlp.end('fin.initializeUI');
    _sectionEnd('fin.initializeUI');

    console.log(' -> Step: overlay.finalProgress');
    // Only begin fading-in once we have proof that Three has actually rendered.
    // This prevents the overlay from fading out during shader compilation / first-frame stutter.
    safeCall(() => {
      loadingOverlay.setStage('final', 0.4, 'Finalizing...', { keepAuto: true });
      loadingOverlay.startAutoProgress(0.995, 0.008);
    }, 'overlay.finalProgress', Severity.COSMETIC);
    console.log(' -> Step: overlay.finalProgress DONE');

    // P1.2: Wait for all effects to be ready before fading overlay
    // V2: No effects registered ->-> skip readiness wait entirely.

    // P1.3: Tile loading is NON-BLOCKING.
    // Tiles load in the background and appear when their fetch/decode completes.
    // We do NOT await tiles because:
    //   1. The server may take 56+ seconds to respond (observed on mythicamachina.com)
    //   2. During the await, Foundry's PIXI render loop starves setTimeout callbacks
    //      (10s timer fires 46s late), making any timeout mechanism unreliable
    //   3. Overhead/decorative tiles are not required for an interactive scene
    // The tile textures will pop in when ready ->-> this is acceptable vs a 60s stall.
    _sectionStart('fin.waitForTiles');
    safeCall(() => loadingOverlay.setStage('final', 0.50, 'Preparing tiles...', { keepAuto: true }), 'overlay.prepareTiles', Severity.COSMETIC);
    {
      const pendingAll = tileManager?._initialLoad?.pendingAll ?? 0;
      const totalTracked = tileManager?._initialLoad?.trackedIds?.size ?? 0;
      dlp.event(`fin.waitForTiles: SKIPPED (non-blocking) ->-> ${pendingAll} tile(s) loading in background`);
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
    // healthy ->-> down from 6 frames / 12s timeout when compilation happened here.
    //
    // BULLET-PROOF DESIGN: previous versions used dlp.event() inside the
    // setTimeout callback. If dlp.event() threw, the resolve callback was
    // never reached and Promise.race hung for 10+ minutes. Now:
    //   1. Timeout promise resolves FIRST, before any logging
    //   2. framePromise has .catch() so rejections don't propagate
    //   3. Outer try/catch ensures _sectionEnd is always called
    console.log(' -> Step: waitForThreeFrames');
    _sectionStart('fin.waitForThreeFrames');
    if (isDebugLoad) dlp.begin('fin.waitForThreeFrames', 'finalize');
    _setCreateThreeCanvasProgress('waitForThreeFrames');
    console.log(' -> Step: waitForThreeFrames SKIPPED (V2)');
    try { dlp.event('fin.waitForThreeFrames: SKIPPED (V2)', 'warn'); } catch (_) {}
    if (isDebugLoad) { try { dlp.end('fin.waitForThreeFrames', { skipped: true, v2: true }); } catch (_) {} }
    _sectionEnd('fin.waitForThreeFrames');

    // V2: Time-of-day drives lighting/sky/shadow effects ->-> skip.

    // Floor setup (V2): assign tiles to floor layers.
    if (isDebugLoad) dlp.begin('fin.preloadAllFloors', 'finalize');
    safeCall(() => loadingOverlay.setStage('final', 0.85, 'Preparing floors...', { keepAuto: true }), 'overlay.preloadFloors', Severity.COSMETIC);
    _setCreateThreeCanvasProgress('preloadAllFloors');
    console.log(' -> Step: preloadAllFloors');

    safeCall(() => {
      const flm = window.MapShine?.floorLayerManager;
      const tm = window.MapShine?.tileManager;
      const tkm = window.MapShine?.tokenManager;
      if (flm && tm) {
        flm.reassignAllLayers(tm, tkm);
        log.info('V2: FloorLayerManager ->-> all sprites assigned to floor layers');
        // FloorRenderBus repopulates lazily on first render frame from tile docs.
      }
    }, 'v2.floorLayerAssignment', Severity.DEGRADED);

    safeCall(() => {
      const sc = window.MapShine?.sceneComposer;
      const compositor = sc?._sceneMaskCompositor;
      const sceneDoc = canvas?.scene ?? null;
      if (!compositor || !sceneDoc || typeof compositor.preloadAllFloors !== 'function') return;

      // Keep startup responsive: warm floor mask bundles in the background.
      void compositor.preloadAllFloors(sceneDoc, {
        activeLevelContext: window.MapShine?.activeLevelContext ?? null,
        lastMaskBasePath: compositor?._activeFloorBasePath ?? sc?.currentBundle?.basePath ?? null,
        initialMasks: sc?.currentBundle?.masks ?? null,
      }).catch(err => {
        log.warn('V2 preloadAllFloors background task failed:', err);
      });
    }, 'v2.preloadAllFloors.background', Severity.DEGRADED);

    safeCall(() => {
      const fc = window.MapShine?.effectComposer?._floorCompositorV2;
      if (!fc || typeof fc.prewarmForLoading !== 'function') return;

      // Trigger floor/effect prewarm opportunistically without blocking fade-in.
      void fc.prewarmForLoading({
        prewarmAllFloors: true,
        awaitPopulate: false,
      }).catch(err => {
        log.warn('V2 prewarmForLoading background task failed:', err);
      });
    }, 'v2.prewarmForLoading.background', Severity.DEGRADED);

    console.log(' -> Step: preloadAllFloors DONE');
    if (isDebugLoad) dlp.end('fin.preloadAllFloors');

    _sectionStart('fin.fadeIn');
    dlp.event('fin.fadeIn: loading pipeline complete ->-> preparing overlay transition');
    _setCreateThreeCanvasProgress('fadeIn');

    // Debug loading mode: capture resource snapshot, generate the full log,
    // replace it in the overlay, and show the dismiss button instead of auto-fading.
    if (isDebugLoad) {
      safeCall(() => dlp.captureResourceSnapshot(renderer, bundle), 'dlp.captureResources', Severity.COSMETIC);
      dlp.endSession();

      // Replace the real-time log with the full formatted report (includes summary)
      const fullLog = dlp.generateLog();
      safeCall(() => loadingOverlay.setDebugLog(fullLog), 'dlp.setFullLog', Severity.COSMETIC);

      const elapsed = loadingOverlay.getElapsedSeconds();
      const readyMsg = elapsed > 0 ? `Debug load complete (${elapsed.toFixed(1)}s) ->-> review log below` : 'Debug load complete ->-> review log below';
      safeCall(() => loadingOverlay.setStage('final', 1.0, readyMsg, { immediate: true }), 'overlay.debugReady', Severity.COSMETIC);

      // Auto-dismiss the overlay in debug mode.
      // The dismiss button can become unclickable due to pointer-events/z-index
      // interactions during Foundry boot. We still keep the full log in the
      // overlay while it's visible, and expose the profiler on window for review.
      safeCall(() => {
        setTimeout(() => {
          try {
            loadingOverlay.fadeIn(1200, 400).catch(() => {
              try { loadingOverlay.hide(); } catch (_) {}
            });
          } catch (_) {
            try { loadingOverlay.hide(); } catch (_) {}
          }
        }, 250);
      }, 'overlay.debugAutoDismiss', Severity.COSMETIC);

      // Expose the profiler on window.MapShine for console access
      if (window.MapShine) window.MapShine.debugLoadingProfiler = dlp;
    } else {
      console.log(' -> Step: overlay.fadeIn');
      await safeCallAsync(async () => {
        const elapsed = loadingOverlay.getElapsedSeconds();
        const readyMsg = elapsed > 0 ? `Ready! (${elapsed.toFixed(1)}s)` : 'Ready!';
        loadingOverlay.setStage('final', 1.0, readyMsg, { immediate: true });
        // Add timeout to prevent indefinite hang if fadeIn never resolves
        await Promise.race([
          loadingOverlay.fadeIn(2000, 800),
          new Promise(resolve => setTimeout(resolve, 5000))
        ]);
      }, 'overlay.fadeIn', Severity.COSMETIC);
      console.log(' -> Step: overlay.fadeIn DONE');
    }

    _sectionEnd('fin.fadeIn');
    _sectionEnd('finalization');
    _sectionEnd('total');
    _logSectionTimings();
    console.log(' ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->');
    console.log(' Scene load COMPLETE:', scene?.name ?? 'unknown');
    console.log(' ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->');

    // Mark the load session as successfully completed (records duration).
    session.finish();
    if (window.MapShine) window.MapShine._loadSession = session;

    // Debug helper: call window.MapShine._debugRenderState() in the browser console
    // to dump the current render pipeline state for diagnosing albedo/mask issues.
    safeCall(() => {
      if (window.MapShine) {
        window.MapShine._debugRenderState = () => {
          const ms = window.MapShine;
          const sc = ms?.sceneComposer;
          const ec = ms?.effectComposer;
          const bp = sc?.basePlaneMesh;
          const bundle = sc?.currentBundle;
          const compositor = sc?._sceneMaskCompositor;

          console.group('[MapShine] Render State Debug');

          console.group('Base Plane');
          console.log('exists:', !!bp);
          console.log('visible:', bp?.visible);
          console.log('position:', bp?.position?.toArray?.());
          console.log('scale:', bp?.scale?.toArray?.());
          const mat = bp?.material;
          console.log('material type:', mat?.type);
          console.log('material.map:', mat?.map);
          console.log('material.map.image:', mat?.map?.image);
          console.log('material.uniforms.uAlbedoMap:', mat?.uniforms?.uAlbedoMap?.value);
          console.groupEnd();

          console.group('currentBundle');
          console.log('basePath:', bundle?.basePath);
          console.log('baseTexture:', bundle?.baseTexture);
          console.log('baseTexture.image:', bundle?.baseTexture?.image);
          console.log('masks count:', bundle?.masks?.length);
          console.log('masks:', bundle?.masks?.map(m => `${m.id}(${m.texture?.image?.width ?? m.texture?.width ?? 'RT'}x${m.texture?.image?.height ?? m.texture?.height ?? '?'})`));
          console.groupEnd();

          console.group('GPU Compositor');
          console.log('_activeFloorKey:', compositor?._activeFloorKey);
          console.log('_floorCache keys:', [...(compositor?._floorCache?.keys() ?? [])]);
          console.log('_floorMeta keys:', [...(compositor?._floorMeta?.keys() ?? [])]);
          console.groupEnd();

          console.group('Renderer');
          const r = ms?.renderer;
          console.log('getRenderTarget():', r?.getRenderTarget());
          console.log('autoClear:', r?.autoClear);
          console.groupEnd();

          console.group('Effects');
          const effects = [...(ec?.effects?.values() ?? [])];
          for (const e of effects) {
            console.log(`${e.id}: enabled=${e.enabled}, initialized=${!e._lazyInitPending}`);
          }
          console.groupEnd();

          console.group('EffectMaskRegistry');
          const reg = ms?.effectMaskRegistry;
          if (reg) {
            console.log('activeFloorKey:', reg._activeFloorKey);
            console.log('transitioning:', reg._transitioning);
            const slotInfo = {};
            if (reg._slots) {
              for (const [k, v] of reg._slots) {
                slotInfo[k] = { hasTexture: !!v.texture, floorKey: v.floorKey, source: v.source };
              }
            }
            console.log('slots:', slotInfo);
          }
          console.groupEnd();

          console.group('Water Effect');
          const we = ms?.waterEffect;
          if (we) {
            console.log('enabled:', we.enabled);
            console.log('waterMask:', we.waterMask?.uuid ?? 'null');
            console.log('_waterData:', !!we._waterData, 'texture:', !!we._waterData?.texture);
            console.log('_floorTransitionActive:', we._floorTransitionActive);
            const wu = we._material?.uniforms;
            console.log('uHasWaterData:', wu?.uHasWaterData?.value);
            console.log('tNoiseMap:', wu?.tNoiseMap?.value?.uuid ?? 'null');
            console.log('tWaterData:', wu?.tWaterData?.value?.uuid ?? 'null');
          }
          console.groupEnd();

          console.group('Window Light Effect');
          const wle = ms?.effectComposer?.effects ? [...ms.effectComposer.effects.values()].find(e => e.id === 'window-light') : null;
          if (wle) {
            console.log('enabled:', wle.enabled);
            console.log('hasWindowMask:', wle.params?.hasWindowMask);
            console.log('windowMask:', wle.windowMask?.uuid ?? 'null');
            console.log('mesh exists:', !!wle.mesh);
            console.log('mesh visible:', wle.mesh?.visible);
          }
          console.groupEnd();

          console.groupEnd();
        };
        log.info('Debug helper available: window.MapShine._debugRenderState()');
      }
    }, 'debugHelper', Severity.COSMETIC);

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
    _createThreeCanvasRunning = false;
    try { if (_progressHeartbeatId) clearInterval(_progressHeartbeatId); } catch (_) {}
    try {
      if (window.MapShine) window.MapShine.__msaSceneLoading = false;
    } catch (_) {
    }
    if (doLoadProfile) safeCall(() => lp.end('sceneLoad'), 'lp.end(sceneLoad)', Severity.COSMETIC);
  }
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
    safeDispose(() => { if (effectComposer) effectComposer.removeUpdatable(tokenManager); }, 'removeUpdatable(tokenManager)');
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

  // Dispose floor stack (before tile/token managers it references).
  if (floorStack) {
    floorStack.dispose();
    floorStack = null;
    log.debug('FloorStack disposed');
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

  

  

  

  if (enhancedLightIconManager) {
    enhancedLightIconManager.dispose();
    enhancedLightIconManager = null;
    log.debug('Enhanced light icon manager disposed');
  }

  if (soundIconManager) {
    soundIconManager.dispose();
    soundIconManager = null;
    log.debug('Sound icon manager disposed');
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
  // The cache maps basePath ->-> loaded bundle (textures + masks). Clearing it
  // on every scene transition makes the cache permanently useless (0% hit rate).
  // The cache is checked at the start of loadAssetBundle() and only reused if
  // all critical masks are present. Stale entries are harmless ->-> they just hold
  // references to disposed textures, which loadAssetBundle's validation will
  // detect and re-probe. Explicit cache clearing is still available via
  // clearAssetCache() for manual use or memory pressure scenarios.

  // CRITICAL FIX: Explicitly dispose the Three.js renderer and release its WebGL
  // context during teardown. The renderer used to persist across scene transitions,
  // but its active WebGL context competes with PIXI's context during the next
  // scene load. Browsers have a low limit on concurrent WebGL contexts (typically
  // 8-16, sometimes as few as 2-3 under GPU pressure). If the limit is exceeded,
  // the browser loses a context ->-> and if PIXI's context is the one lost, Foundry's
  // TextureLoader.load() hangs forever because textures can't be uploaded.
  //
  // By disposing here, we free the GPU context slot before Foundry creates its
  // PIXI renderer for the next scene. createThreeCanvas() has a lazy bootstrap
  // recovery path that will re-create the renderer when needed.
  safeCall(() => {
    const globalRenderer = window.MapShine?.renderer;
    if (globalRenderer) {
      try {
        // Three.js forceContextLoss() calls the WEBGL_lose_context extension
        // to explicitly release the GPU context slot.
        if (typeof globalRenderer.forceContextLoss === 'function') {
          globalRenderer.forceContextLoss();
          log.debug('Three.js WebGL context explicitly released via forceContextLoss()');
        }
      } catch (_) {}

      try {
        globalRenderer.dispose();
        log.debug('Three.js renderer disposed');
      } catch (_) {}

      if (window.MapShine) {
        window.MapShine.renderer = null;
        window.MapShine.rendererType = null;
      }
    }
  }, 'renderer.dispose(teardown)', Severity.DEGRADED);
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

    safeCall(() => ui?.notifications?.info?.('Map Shine: Resetting scene (rebuilding Three.js)->'), 'resetScene.notify', Severity.COSMETIC);

    safeCall(() => {
      const w = window.MapShine?.waterEffect;
      if (w && typeof w.clearCaches === 'function') w.clearCaches();
    }, 'resetScene.clearWaterCaches', Severity.COSMETIC);

    safeCall(() => {
      const wpV2 = window.MapShine?.effectComposer?._floorCompositorV2?._weatherParticles;
      if (wpV2 && typeof wpV2.clearWaterCaches === 'function') {
        wpV2.clearWaterCaches();
      } else {
        const particleSystem = window.MapShineParticles;
        const wp = particleSystem?.weatherParticles;
        if (wp && typeof wp.clearWaterCaches === 'function') wp.clearWaterCaches();
      }
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

    // V2: PIXI should not visually render the scene. Foundry's board canvas
    // (#board) is the actual composited PIXI output and can sit above Three.
    // Hide it immediately so it cannot flash the albedo/fog overlay during boot.
    safeCall(() => {
      const board = document.getElementById('board');
      if (board && board.tagName === 'CANVAS') {
        board.style.display = 'none';
        board.style.visibility = 'hidden';
        board.style.opacity = '0';
        board.style.pointerEvents = 'none';
      }
    }, 'createThreeCanvas.hideBoardEarly', Severity.COSMETIC);
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
    // Debug/bridge escape hatch: allow temporary suspension of suppression
    // while PIXI-content bridge performs offscreen extraction.
    if (window?.MapShine?.__disablePixiSuppression === true) return;
    if (window?.MapShine?.__bridgeCaptureActive === true) return;

    // Door controls: Map Shine renders its own Three-based door icons. Foundry's
    // native PIXI door controls must never render, otherwise we can get a second
    // icon set stuck at (0,0) when PIXI control transforms drift.
    try {
      const controlsDoors = canvas?.controls?.doors;
      if (controlsDoors) {
        controlsDoors.visible = false;
        controlsDoors.renderable = false;
        if (Array.isArray(controlsDoors.children) && controlsDoors.children.length) {
          try { controlsDoors.removeChildren(); } catch (_) {}
        }
      }
      for (const wall of canvas?.walls?.placeables || []) {
        if (!wall?.isDoor) continue;
        const dc = wall.doorControl;
        if (!dc) continue;
        dc.visible = false;
        dc.renderable = false;
        if (dc.icon) {
          dc.icon.visible = false;
          dc.icon.renderable = false;
        }
      }
    } catch (_) {
    }

    const activeControl = String(ui?.controls?.control?.name || ui?.controls?.activeControl || '').toLowerCase();
    const activeTool = String(ui?.controls?.tool?.name || ui?.controls?.activeTool || game?.activeTool || '').toLowerCase();
    const inputRouter =
      window.MapShine?.inputRouter ||
      window.mapShine?.inputRouter ||
      controlsIntegration?.inputRouter ||
      null;
    const activeLayerName = String(canvas?.activeLayer?.options?.name || canvas?.activeLayer?.name || '').toLowerCase();
    const activeLayerCtor = String(canvas?.activeLayer?.constructor?.name || '').toLowerCase();
    const activeControlLayer = String(ui?.controls?.control?.layer || '').toLowerCase();
    const tilesEditContext =
      activeControl === 'tiles'
      || activeTool === 'tile'
      || activeLayerName === 'tiles'
      || activeLayerCtor === 'tileslayer'
      || activeControlLayer === 'tiles';
    const drawingsEditContext =
      !!canvas?.drawings?.active
      || activeControl === 'drawings'
      || activeControl === 'drawing'
      || activeControlLayer === 'drawings'
      || activeControlLayer === 'drawing'
      || activeLayerName === 'drawings'
      || activeLayerName === 'drawing'
      || activeLayerCtor === 'drawingslayer';
    const soundsEditContext =
      !!canvas?.sounds?.active
      || activeControl === 'sounds'
      || activeControl === 'sound'
      || activeControlLayer === 'sounds'
      || activeControlLayer === 'sound'
      || activeLayerName === 'sounds'
      || activeLayerName === 'sound'
      || activeLayerCtor === 'soundslayer';
    const templatesEditContext =
      !!canvas?.templates?.active
      || activeControl === 'templates'
      || activeControl === 'template'
      || activeControlLayer === 'templates'
      || activeControlLayer === 'template'
      || activeLayerName === 'templates'
      || activeLayerName === 'template'
      || activeLayerCtor === 'templatelayer';
    const notesEditContext =
      !!canvas?.notes?.active
      || activeControl === 'notes'
      || activeControl === 'note'
      || activeControlLayer === 'notes'
      || activeControlLayer === 'note'
      || activeLayerName === 'notes'
      || activeLayerName === 'note'
      || activeLayerCtor === 'noteslayer';
    const regionsEditContext =
      !!canvas?.regions?.active
      || activeControl === 'regions'
      || activeControl === 'region'
      || activeControlLayer === 'regions'
      || activeControlLayer === 'region'
      || activeLayerName === 'regions'
      || activeLayerName === 'region'
      || activeLayerCtor === 'regionlayer';
    const pixiEditContextFallback =
      tilesEditContext || drawingsEditContext || soundsEditContext
      || templatesEditContext || notesEditContext || regionsEditContext;
    const hasPersistentPixiOverlays =
      ((Number(canvas?.scene?.notes?.size) || 0) > 0) ||
      ((Number(canvas?.scene?.templates?.size) || 0) > 0) ||
      !!canvas?.notes?.placeables?.length ||
      !!canvas?.templates?.placeables?.length;
    // Walls, lighting, and tokens are fully Three.js-native now.
    // Only need the PIXI overlay for unreplaced layers (drawings, regions,
    // sounds, notes, templates) — determined by InputRouter.
    const shouldPixiReceiveInput = !!inputRouter?.shouldPixiReceiveInput?.();
    // Prefer InputRouter ownership, but fail-open for native PIXI edit contexts
    // when router metadata is briefly stale during control/layer transitions.
    // This prevents destructive misroutes (e.g. ambient-sound move becoming a
    // new placement because Three receives the drag).
    const shouldPixiReceiveInputEffective = shouldPixiReceiveInput || pixiEditContextFallback;
    const needsEditorOverlay = shouldPixiReceiveInputEffective || hasPersistentPixiOverlays;
    const isDrawingsContext = drawingsEditContext;

    if (window.MapShine) {
      window.MapShine.__forcePixiEditorOverlay = needsEditorOverlay;
    }

    const isV2Active = !!window.MapShine?.__v2Active;

    if (needsEditorOverlay) {
      const pixiCanvas = canvas.app?.view;
      const threeCanvas = document.getElementById('map-shine-canvas');
      // Overlay-visible contexts (drawings/notes/templates/sounds/etc.) must
      // remain visually present; forcing opacity 0 here makes these workflows
      // appear broken even when interaction ownership is correct.
      const pixiVisualOpacity = '1';
      if (canvas.app?.renderer?.background) {
        canvas.app.renderer.background.alpha = 0;
      }
      if (pixiCanvas) {
        pixiCanvas.style.display = '';
        pixiCanvas.style.visibility = 'visible';
        pixiCanvas.style.opacity = pixiVisualOpacity;
        pixiCanvas.style.zIndex = '10';
        pixiCanvas.style.pointerEvents = shouldPixiReceiveInputEffective ? 'auto' : 'none';
        pixiCanvas.style.backgroundColor = 'transparent';
      }

      const board = document.getElementById('board');
      if (board && board.tagName === 'CANVAS') {
        board.style.display = '';
        board.style.visibility = 'visible';
        board.style.opacity = pixiVisualOpacity;
        board.style.zIndex = '10';
        board.style.pointerEvents = shouldPixiReceiveInputEffective ? 'auto' : 'none';
        board.style.backgroundColor = 'transparent';
      }

      // In V2, force-replaced PIXI scene layers to remain hidden even while
      // temporarily allowing PIXI hit-testing for editor tools.
      if (isV2Active) {
        safeCall(() => {
          if (!canvas.primary) return;
          // Tile editing relies on Foundry's native tile interaction chain.
          // Keep primary logically visible so transforms update, hide visuals surgically.
          canvas.primary.visible = true;
          if (canvas.primary.background) canvas.primary.background.visible = false;
          if (canvas.primary.foreground) canvas.primary.foreground.visible = false;
          if (canvas.primary.tiles) canvas.primary.tiles.visible = !!tilesEditContext;
        }, 'pixiSuppress.primary(editorOverlayV2)', Severity.COSMETIC);
        safeCall(() => { if (canvas.fog) canvas.fog.visible = false; }, 'pixiSuppress.fog(editorOverlayV2)', Severity.COSMETIC);
        safeCall(() => {
          if (!canvas.visibility) return;
          canvas.visibility.visible = false;
          if (canvas.visibility.filter) canvas.visibility.filter.enabled = false;
          if (canvas.visibility.vision) canvas.visibility.vision.visible = false;
        }, 'pixiSuppress.visibility(editorOverlayV2)', Severity.COSMETIC);
      }

      if (threeCanvas) {
        threeCanvas.style.display = '';
        threeCanvas.style.visibility = 'visible';
        threeCanvas.style.opacity = '1';
        threeCanvas.style.pointerEvents = shouldPixiReceiveInputEffective ? 'none' : 'auto';
      }

      // Ensure native tile placeables are active while in tile edit context.
      if (tilesEditContext && canvas?.tiles) {
        canvas.tiles.visible = true;
        canvas.tiles.renderable = true;
        canvas.tiles.interactive = true;
        canvas.tiles.interactiveChildren = true;
        const ALPHA = 0.01;
        for (const tile of canvas.tiles.placeables || []) {
          if (!tile) continue;
          tile.visible = true;
          tile.renderable = true;
          tile.interactive = true;
          tile.interactiveChildren = true;
          if (tile.mesh) tile.mesh.alpha = ALPHA;
        }
      }
      return;
    }

    // Some Foundry tools may still require PIXI hit-testing in gameplay mode.
    // Keep PIXI/board interactive but fully transparent so they cannot occlude
    // the Three-rendered scene.
    if (shouldPixiReceiveInputEffective) {
      const pixiCanvas = canvas.app?.view;
      const threeCanvas = document.getElementById('map-shine-canvas');
      if (pixiCanvas) {
        pixiCanvas.style.display = '';
        pixiCanvas.style.visibility = 'visible';
        pixiCanvas.style.opacity = '0';
        pixiCanvas.style.zIndex = '10';
        pixiCanvas.style.pointerEvents = 'auto';
      }

      const board = document.getElementById('board');
      if (board && board.tagName === 'CANVAS') {
        board.style.display = '';
        board.style.visibility = 'visible';
        board.style.opacity = '0';
        board.style.zIndex = '10';
        board.style.pointerEvents = 'auto';
      }

      if (threeCanvas) {
        threeCanvas.style.display = '';
        threeCanvas.style.visibility = 'visible';
        threeCanvas.style.opacity = '1';
        threeCanvas.style.pointerEvents = 'none';
      }
      return;
    }

    // V2 goal: PIXI should never visually render the scene. Foundry can keep its
    // internal computations (vision sources, layer state, measurements), but the
    // PIXI canvas output must be fully suppressed so no fog/visibility/primary
    // artifacts can appear.
    safeCall(() => {
      const pixiCanvas = canvas.app?.view;
      if (pixiCanvas) {
        // Use display:none as the strongest guarantee that PIXI cannot contribute
        // any pixels to the final composed frame. Opacity=0 still allows some
        // browser/driver edge cases where a stale frame can appear during
        // rapid canvas swaps or context churn.
        pixiCanvas.style.display = 'none';
        pixiCanvas.style.visibility = 'hidden';
        pixiCanvas.style.opacity = '0';
        pixiCanvas.style.pointerEvents = 'none';

      }
    }, 'pixiSuppress.pixiCanvasOpacity', Severity.COSMETIC);

    // Always force the Three canvas visible in gameplay mode. Without this,
    // mode transitions can leave stale display/visibility styles and present
    // as a blank frame after PIXI is suppressed.
    safeCall(() => {
      const threeCanvas = document.getElementById('map-shine-canvas');
      if (!threeCanvas) return;
      threeCanvas.style.display = '';
      threeCanvas.style.visibility = 'visible';
      threeCanvas.style.opacity = '1';
      threeCanvas.style.pointerEvents = 'auto';
    }, 'pixiSuppress.threeCanvasVisible', Severity.COSMETIC);

    // Foundry's primary PIXI canvas element is typically #board. In some
    // Foundry versions/skins, canvas.app.view may not be the top-level board
    // element that is actually composited above Three. Hide it explicitly.
    safeCall(() => {
      const board = document.getElementById('board');
      if (board && board.tagName === 'CANVAS') {
        board.style.display = 'none';
        board.style.visibility = 'hidden';
        board.style.opacity = '0';
        board.style.pointerEvents = 'none';
      }
    }, 'pixiSuppress.boardCanvas', Severity.COSMETIC);

    // Defense-in-depth: Foundry/module integrations can introduce additional
    // canvas elements under the same board container. In V2 gameplay, Three.js
    // must be the only visible scene renderer. Hide every non-MapShine canvas
    // in that container to prevent stale/static PIXI frames overdraw.
    safeCall(() => {
      const board = document.getElementById('board');
      const container = board?.parentElement ?? null;
      if (!container) return;
      const canvases = container.querySelectorAll('canvas');
      for (const el of canvases) {
        if (!el) continue;
        if (el.id === 'map-shine-canvas') continue;
        el.style.display = 'none';
        el.style.visibility = 'hidden';
        el.style.opacity = '0';
        el.style.pointerEvents = 'none';
      }
    }, 'pixiSuppress.extraBoardCanvases', Severity.COSMETIC);

    // V12+: primary can render tiles/overheads/roofs. Keep it hidden in gameplay.
    safeCall(() => { 
      if (canvas.primary) {
        canvas.primary.visible = true;
        if (canvas.primary.background) canvas.primary.background.visible = false;
        if (canvas.primary.foreground) canvas.primary.foreground.visible = false;
        if (canvas.primary.tiles) canvas.primary.tiles.visible = false;
      }
    }, 'pixiSuppress.primary', Severity.COSMETIC);

    // Fog of war / visibility: in V2 we do not use Foundry's fog visuals.
    // Leaving these visible can produce a fullscreen, camera-locked semi-transparent
    // overlay that changes when a token becomes the active vision source.
    safeCall(() => {
      if (canvas.fog) canvas.fog.visible = false;
    }, 'pixiSuppress.fog', Severity.COSMETIC);
    safeCall(() => {
      if (!canvas.visibility) return;
      canvas.visibility.visible = false;
      if (canvas.visibility.filter) canvas.visibility.filter.enabled = false;
      if (canvas.visibility.vision) canvas.visibility.vision.visible = false;
      if (Array.isArray(canvas.visibility.children)) {
        for (const child of canvas.visibility.children) {
          if (child && typeof child.visible !== 'undefined') child.visible = false;
        }
      }
    }, 'pixiSuppress.visibility', Severity.COSMETIC);

    // Tiles are fully Three-owned in gameplay mode. Keep PIXI tile visuals suppressed.
    const alpha = 0;

    // Keep Three.js tiles visible in gameplay regardless of active canvas layer.
    safeCall(() => {
      const tm = window.MapShine?.tileManager;
      if (tm?.setVisibility) tm.setVisibility(true);
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
  if (canvas.primary) {
    canvas.primary.visible = true;
    if (canvas.primary.background) canvas.primary.background.visible = false;
    if (canvas.primary.foreground) canvas.primary.foreground.visible = false;
    if (canvas.primary.tiles) canvas.primary.tiles.visible = false;
  }
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
    _applyPixiTokenVisualMode();
  }

  // Drawings are NOT replaced; they should render via PIXI as an overlay.
  if (canvas.drawings) canvas.drawings.visible = true;

  // Journal notes and measured templates should remain visible as persistent
  // gameplay overlays, not only while their controls are actively selected.
  if (canvas.notes) canvas.notes.visible = true;
  if (canvas.templates) canvas.templates.visible = true;

  // 2. Dynamic Layers - Show only if using the corresponding tool
  const activeLayerObj = canvas.activeLayer;
  const activeLayerName = String(activeLayerObj?.options?.name || activeLayerObj?.name || '').toLowerCase();
  const activeLayerCtor = String(activeLayerObj?.constructor?.name || '').toLowerCase();
  const activeControl = String(ui?.controls?.control?.name || ui?.controls?.activeControl || '').toLowerCase();
  const activeControlLayer = String(ui?.controls?.control?.layer || '').toLowerCase();
  const isActiveLayer = (name) => {
    const normalized = String(name || '').toLowerCase();
    return (activeLayerName === normalized)
      || (activeLayerCtor === normalized)
      || (activeControl === normalized)
      || (activeControlLayer === normalized);
  };
  const isLightingActive = !!canvas?.lighting?.active;
  const isWallsActiveFlag = !!canvas?.walls?.active;
  const isTilesActive = isActiveLayer('TilesLayer') || isActiveLayer('tiles');

  if (isTilesActive && canvas.primary) {
    canvas.primary.visible = true;
  }
  
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
      const isWallsActive = isWallsActiveFlag || isActiveLayer('WallsLayer') || isActiveLayer('WallLayer') || isActiveLayer('walls');

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

  // Tiles: keep native PIXI tile placeables interactive while the Tiles controls
  // are active, otherwise suppress them to avoid double-rendering.
  if (canvas.tiles) {
      if (isTilesActive) {
          canvas.tiles.visible = true;
          canvas.tiles.interactiveChildren = true;
          const ALPHA = 0.01;
          for (const tile of canvas.tiles.placeables || []) {
            if (!tile) continue;
            tile.visible = true;
            tile.renderable = true;
            tile.interactive = true;
            tile.interactiveChildren = true;
            if (tile.mesh) tile.mesh.alpha = ALPHA;
          }
          if (tileManager) tileManager.setVisibility(true);
      } else {
          canvas.tiles.visible = false;
          if (tileManager) tileManager.setVisibility(!isMapMakerMode);
      }
  }

  // Other Tools (Lighting, Sounds, etc.) - Just show/hide PIXI layer
  // For Lighting, we also drive the Three.js light icon manager visibility so that
  // light icons only show when the Lighting tool is active.
  const simpleLayers = [
      'LightingLayer', 'SoundsLayer', 'RegionLayer'
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
  // Ownership consolidation: when ControlsIntegration is active, InputRouter
  // is the single source of truth for pointer routing and overlay state.
  if (controlsIntegration && controlsIntegration.getState?.() === 'active') {
    return;
  }

  // Hook into tool changes
  // We use 'canvasInit' to re-apply settings if scene changes, 
  // but 'createThreeCanvas' handles the main init.
  
  // Remove existing listeners to avoid duplicates if re-initialized
  Hooks.off('changeSidebarTab', updateInputMode);
  Hooks.off('renderSceneControls', updateInputMode);
  Hooks.off('activateCanvasLayer', updateInputMode);
  
  Hooks.on('changeSidebarTab', updateInputMode);
  Hooks.on('renderSceneControls', updateInputMode);
  Hooks.on('activateCanvasLayer', updateInputMode);

  _installInputArbitrationDomNudges();
  
  // Initial check
  updateInputMode();
  _reconcileInputArbitrationState('setupInputArbitration.initial');

  // Foundry control/layer state can finalize a tick or two after first scene draw.
  // Prime arbitration again so initial token-select + marquee work without
  // requiring the user to switch tools.
  const primeDelaysMs = [0, 50, 150, 300];
  for (const delayMs of primeDelaysMs) {
    setTimeout(() => {
      try {
        _reconcileInputArbitrationState(`setupInputArbitration.prime.${delayMs}`);
      } catch (_) {
      }
    }, delayMs);
  }

  _startInputArbitrationSettleWatcher('setupInputArbitration');
}

function _isInputArbitrationMetadataReady() {
  try {
    const activeLayerObj = canvas?.activeLayer;
    const layerName = String(activeLayerObj?.options?.name || activeLayerObj?.name || '').toLowerCase();
    const layerCtor = String(activeLayerObj?.constructor?.name || '').toLowerCase();
    const control = String(ui?.controls?.control?.name || ui?.controls?.activeControl || '').toLowerCase();
    return !!(layerName || layerCtor || control);
  } catch (_) {
    return false;
  }
}

function _reconcileInputArbitrationState(reason = '') {
  try {
    if (!canvas?.ready || isMapMakerMode) return;
    updateLayerVisibility();
    updateInputMode();
    _enforceGameplayPixiSuppression();
    _updateFoundrySelectRectSuppression();
    log.debug('Input arbitration reconciled', {
      reason,
      ready: _isInputArbitrationMetadataReady()
    });
  } catch (_) {
  }
}

function _stopInputArbitrationSettleWatcher() {
  try {
    if (_inputArbitrationSettleRaf != null) {
      window.cancelAnimationFrame?.(_inputArbitrationSettleRaf);
    }
  } catch (_) {
  }
  _inputArbitrationSettleRaf = null;
  _inputArbitrationSettleDeadlineMs = 0;
  _inputArbitrationStableFrames = 0;
}

function _startInputArbitrationSettleWatcher(reason = '') {
  _stopInputArbitrationSettleWatcher();
  _inputArbitrationSettleDeadlineMs = Date.now() + 1200;
  _inputArbitrationStableFrames = 0;

  const tick = () => {
    _reconcileInputArbitrationState(`settle.${reason}`);

    if (_isInputArbitrationMetadataReady()) {
      _inputArbitrationStableFrames += 1;
    } else {
      _inputArbitrationStableFrames = 0;
    }

    if (_inputArbitrationStableFrames >= 4 || Date.now() >= _inputArbitrationSettleDeadlineMs) {
      _stopInputArbitrationSettleWatcher();
      return;
    }

    _inputArbitrationSettleRaf = window.requestAnimationFrame?.(tick) ?? null;
    if (_inputArbitrationSettleRaf == null) {
      setTimeout(tick, 16);
    }
  };

  _inputArbitrationSettleRaf = window.requestAnimationFrame?.(tick) ?? null;
  if (_inputArbitrationSettleRaf == null) {
    setTimeout(tick, 0);
  }
}

function _installInputArbitrationDomNudges() {
  if (_inputArbitrationDomNudgesInstalled) return;

  const nudge = (reason) => {
    _reconcileInputArbitrationState(reason);
    _startInputArbitrationSettleWatcher(reason);
  };

  window.addEventListener('focus', () => nudge('window.focus'));
  window.addEventListener('blur', () => nudge('window.blur'));
  document.addEventListener('visibilitychange', () => nudge('document.visibilitychange'));
  window.addEventListener('keydown', (event) => {
    if (event?.key === 'Alt') nudge('window.keydown.alt');
  }, { capture: true });
  window.addEventListener('keyup', (event) => {
    if (event?.key === 'Alt') nudge('window.keyup.alt');
  }, { capture: true });

  _inputArbitrationDomNudgesInstalled = true;
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

    const v2Active = !!window.MapShine?.__v2Active;
    
    // Tools that require PIXI interaction
    // Basically any layer that isn't TokenLayer (assuming we handle Tokens in 3D eventually? 
    // For now, we hide TokenLayer, so we might need PIXI input if we want to select tokens?
    // Wait, TokenManager syncs tokens. If we hide TokenLayer, we can't select tokens via PIXI.
    // InteractionManager handles 3D selection.
    
    // Use PIXI for Foundry-native edit workflows.
    const editLayers = [
      'TilesLayer',
      'tiles',
      'WallsLayer',
      'WallLayer',
      'walls',
      'LightingLayer',
      'lighting',
      'SoundsLayer',
      'TemplateLayer',
      'DrawingsLayer',
      'NotesLayer',
      'RegionLayer',
      'regions'
    ];
    
    // Drive Three.js wall line visibility and PIXI input routing based on the
    // *final* active layer after Foundry has finished switching tools.
    // We defer to the next tick to avoid reading a stale activeLayer during
    // control changes.
    setTimeout(() => {
      if (!canvas?.ready || isMapMakerMode) return;

      const finalLayerObj = canvas.activeLayer;
      const finalLayerName = String(finalLayerObj?.options?.name || finalLayerObj?.name || '').toLowerCase();
      const finalLayerCtor = String(finalLayerObj?.constructor?.name || '').toLowerCase();
      const finalControl = String(ui?.controls?.control?.name || ui?.controls?.activeControl || '').toLowerCase();
      const finalControlLayer = String(ui?.controls?.control?.layer || '').toLowerCase();
      const finalTool = String(ui?.controls?.tool?.name || ui?.controls?.activeTool || '').toLowerCase();
      const threeCanvasEl = document.getElementById('map-shine-canvas');
      const isFinalLayer = (name) => {
        const normalized = String(name || '').toLowerCase();
        return (finalLayerName === normalized)
          || (finalLayerCtor === normalized)
          || (finalControl === normalized)
          || (finalControlLayer === normalized);
      };
      const isLightingFinal =
        !!canvas?.lighting?.active
        || isFinalLayer('lightinglayer')
        || isFinalLayer('lighting')
        || isFinalLayer('light');
      const isWallsFinal =
        !!canvas?.walls?.active
        || isFinalLayer('wallslayer')
        || isFinalLayer('walllayer')
        || isFinalLayer('walls')
        || isFinalLayer('wall');
      const isSoundsFinal =
        !!canvas?.sounds?.active
        || isFinalLayer('soundslayer')
        || isFinalLayer('sounds')
        || isFinalLayer('sound');
      const isEditMode = editLayers.some((l) => isFinalLayer(l)) || isLightingFinal || isWallsFinal;
      const controlMetadataReady = !!(finalLayerName || finalLayerCtor || finalControl);

      // Drive Three.js light icon visibility from a single source of truth.
      // In Gameplay mode (Three.js active), show light icons only when the
      // Lighting layer is the *final* active layer so they behave like
      // Foundry's native handles. In Map Maker mode, the entire Three.js
      // canvas is hidden, so we also hide the icons here for logical
      // consistency.
      if (lightIconManager && lightIconManager.setVisibility) {
        const showLighting = isLightingFinal && !isMapMakerMode;
        lightIconManager.setVisibility(showLighting);
      }

      if (enhancedLightIconManager && enhancedLightIconManager.setVisibility) {
        const showLighting = isLightingFinal && !isMapMakerMode;
        enhancedLightIconManager.setVisibility(showLighting);
      }

      if (soundIconManager && soundIconManager.setVisibility) {
        const showSounds = isSoundsFinal && !isMapMakerMode;
        soundIconManager.setVisibility(showSounds);
      }

      if (wallManager && wallManager.setVisibility) {
        const showThreeWalls = isWallsFinal && !isMapMakerMode;
        wallManager.setVisibility(showThreeWalls);
      }

      if (isEditMode) {
        pixiCanvas.style.pointerEvents = 'auto';
        const board = document.getElementById('board');
        if (board && board.tagName === 'CANVAS') {
          board.style.display = '';
          board.style.visibility = 'visible';
          board.style.opacity = '1';
          board.style.pointerEvents = 'auto';
        }
        if (threeCanvasEl) threeCanvasEl.style.pointerEvents = 'none';
        log.debug(`Input Mode: PIXI (Edit: ${finalLayerCtor || finalLayerName || finalControl || 'unknown'})`);
      } else {
        pixiCanvas.style.pointerEvents = 'none'; // Pass through to Three.js
        const board = document.getElementById('board');
        if (board && board.tagName === 'CANVAS') board.style.pointerEvents = 'none';
        if (threeCanvasEl) threeCanvasEl.style.pointerEvents = 'auto';
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
