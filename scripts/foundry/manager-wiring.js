/**
 * @fileoverview Manager cross-wiring and global exposure helpers.
 *
 * Extracted from canvas-replacement.js to isolate:
 * - window.MapShine exposure of all managers and effects
 *
 * Manager *construction* remains in createThreeCanvas because it depends on
 * module-scope variable assignment and loading overlay sequencing. These helper
 * functions handle the repetitive wiring/exposure that follows construction.
 *
 * @module foundry/manager-wiring
 */

import { LevelTransitionCurtain } from '../scene/level-transition-curtain.js';

/** @type {LevelTransitionCurtain|null} */
let _levelTransitionCurtain = null;

/**
 * Create the {@link LevelTransitionCurtain} and expose it on
 * `window.MapShine` so `CameraFollower._setActiveLevelByIndex` can route
 * visible floor/level changes through it.
 *
 * The curtain no longer monkey-patches `_emitLevelContextChanged`; instead
 * `CameraFollower` calls `runLevelSwitch` directly. The `cameraFollower`
 * argument is kept for backwards compatibility and is forwarded to the
 * curtain's now-passive `register()` hook.
 *
 * @param {object|null} mapShine - window.MapShine
 * @param {object|null} cameraFollower - CameraFollower instance
 */
export function registerLevelTransitionCurtain(mapShine, cameraFollower) {
  disposeLevelTransitionCurtain();
  if (!cameraFollower) return;
  _levelTransitionCurtain = new LevelTransitionCurtain();
  _levelTransitionCurtain.register(cameraFollower);
  if (mapShine) {
    mapShine.levelTransitionCurtain = _levelTransitionCurtain;
  }
}

/**
 * Tear down the curtain instance. Safe to call multiple times.
 */
export function disposeLevelTransitionCurtain() {
  if (_levelTransitionCurtain) {
    try {
      _levelTransitionCurtain.dispose();
    } catch (_) {}
    _levelTransitionCurtain = null;
  }
  try {
    if (window.MapShine) delete window.MapShine.levelTransitionCurtain;
  } catch (_) {}
}

// ── Global Exposure ─────────────────────────────────────────────────────────

/**
 * Expose all managers and effects on window.MapShine for diagnostics and
 * console access. Called near the end of createThreeCanvas.
 *
 * @param {Object} mapShine - The window.MapShine object
 * @param {Object} refs - All manager/effect references to expose
 * @param {Map<string, Object>} refs.effectMap - Display name → effect instance
 * @param {Object} refs.sceneComposer
 * @param {Object} refs.effectComposer
 * @param {Object} refs.cameraFollower
 * @param {Object} refs.pixiInputBridge
 * @param {Object} refs.tokenManager
 * @param {Object} refs.tokenMovementManager
 * @param {Object} refs.tileManager
 * @param {Object} refs.wallManager
 * @param {Object} refs.doorMeshManager
 * @param {Object} refs.drawingManager
 * @param {Object} refs.noteManager
 * @param {Object} refs.templateManager
 * @param {Object} refs.lightIconManager
 * @param {Object} refs.enhancedLightIconManager
 * @param {Object} refs.enhancedLightInspector
 * @param {Object} refs.interactionManager
 * @param {Object} refs.mouseStateManager
 * @param {Object} refs.overlayUIManager
 * @param {Object} refs.lightEditor
 * @param {Object} refs.gridRenderer
 * @param {Object} refs.mapPointsManager
 * @param {Object} refs.tileMotionManager
 * @param {Object} refs.weatherController
 * @param {Object} refs.renderLoop
 * @param {Object} refs.sceneDebug
 * @param {Object} refs.controlsIntegration
 * @param {Object} refs.dynamicExposureManager
 * @param {Function} refs.setMapMakerMode
 * @param {Function} refs.resetScene
 * @param {boolean} refs.isMapMakerMode
 */
export function exposeGlobals(mapShine, refs) {
  if (!mapShine) return;

  // Expose managers directly from refs
  const MANAGER_EXPOSURES = [
    'sceneComposer', 'effectComposer', 'cameraFollower', 'pixiInputBridge',
    'cinematicCameraManager', 'cameraPanel', 'levelsAuthoring',
    'tokenManager', 'tokenMovementManager', 'tileManager', 'wallManager', 'doorMeshManager',
    'drawingManager', 'enhancedLightInspector', 'interactionManager',
    'mouseStateManager',
    'overlayUIManager', 'lightEditor', 'gridRenderer', 'mapPointsManager',
    'tileMotionManager',
    'weatherController', 'renderLoop', 'sceneDebug', 'controlsIntegration',
    'dynamicExposureManager', 'physicsRopeManager', 'assetLoader',
  ];

  for (const key of MANAGER_EXPOSURES) {
    if (refs[key] !== undefined) mapShine[key] = refs[key];
  }

  // Expose mode functions
  if (refs.setMapMakerMode) mapShine.setMapMakerMode = refs.setMapMakerMode;
  if (refs.resetScene) mapShine.resetScene = refs.resetScene;
  if (typeof refs.isMapMakerMode === 'boolean') mapShine.isMapMakerMode = refs.isMapMakerMode;

  // Expose controls sub-systems
  if (refs.controlsIntegration) {
    mapShine.cameraSync = refs.controlsIntegration.cameraSync;
    mapShine.inputRouter = refs.controlsIntegration.inputRouter;
    mapShine.layerVisibility = refs.controlsIntegration.layerVisibility;
  }
}
