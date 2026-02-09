/**
 * @fileoverview Manager cross-wiring and global exposure helpers.
 *
 * Extracted from canvas-replacement.js to isolate:
 * - Map points → particle effect wiring
 * - window.MapShine exposure of all managers and effects
 *
 * Manager *construction* remains in createThreeCanvas because it depends on
 * module-scope variable assignment and loading overlay sequencing. These helper
 * functions handle the repetitive wiring/exposure that follows construction.
 *
 * @module foundry/manager-wiring
 */

import { createLogger } from '../core/log.js';

const log = createLogger('ManagerWiring');

// ── Map Points → Effect Cross-Wiring ────────────────────────────────────────

/**
 * Effects that consume map-point sources.
 * Each entry: [effectMap display name, whether to require existing groups].
 * @type {Array<[string, boolean]>}
 */
const MAP_POINT_CONSUMERS = [
  ['Fire Sparks',    true],   // Only wire if groups already exist
  ['Smelly Flies',   false],  // Always wire — listens for changes
  ['Lightning',      false],
  ['Candle Flames',  false],
];

/**
 * Wire a MapPointsManager to all particle effects that consume map-point sources.
 * @param {Map<string, Object>} effectMap - Display name → effect instance
 * @param {import('../scene/map-points-manager.js').MapPointsManager} mapPointsManager
 */
export function wireMapPointsToEffects(effectMap, mapPointsManager) {
  for (const [name, requireGroups] of MAP_POINT_CONSUMERS) {
    const effect = effectMap.get(name);
    if (!effect) continue;
    if (requireGroups && (!mapPointsManager.groups || mapPointsManager.groups.size === 0)) continue;
    if (typeof effect.setMapPointsSources !== 'function') continue;

    try {
      effect.setMapPointsSources(mapPointsManager);
      log.info(`Map points wired to ${name}`);
    } catch (e) {
      log.warn(`Failed to wire map points to ${name}:`, e);
    }
  }
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
 * @param {Object} refs.overlayUIManager
 * @param {Object} refs.lightEditor
 * @param {Object} refs.gridRenderer
 * @param {Object} refs.mapPointsManager
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

  const { effectMap } = refs;

  // Expose effects by their window.MapShine property name
  const EFFECT_EXPOSURES = [
    ['Specular',          'specularEffect'],
    ['Iridescence',       'iridescenceEffect'],
    ['Window Lights',     'windowLightEffect'],
    ['Bushes',            'bushEffect'],
    ['Trees',             'treeEffect'],
    ['Overhead Shadows',  'overheadShadowsEffect'],
    ['Building Shadows',  'buildingShadowsEffect'],
    ['Smelly Flies',      'smellyFliesEffect'],
    ['Dust Motes',        'dustMotesEffect'],
    ['Lightning',         'lightningEffect'],
    ['Ash Disturbance',   'ashDisturbanceEffect'],
    ['Water',             'waterEffect'],
    ['Fog',               'fogEffect'],
    ['Sky Color',         'skyColorEffect'],
    ['Distortion',        'distortionManager'],
    ['Debug Layers',      'debugLayerEffect'],
    ['Player Lights',     'playerLightEffect'],
    ['Lighting',          'lightingEffect'],
    ['Candle Flames',     'candleFlamesEffect'],
  ];

  if (effectMap) {
    for (const [mapName, propName] of EFFECT_EXPOSURES) {
      const instance = effectMap.get(mapName);
      if (instance) mapShine[propName] = instance;
    }
  }

  // Expose managers directly from refs
  const MANAGER_EXPOSURES = [
    'sceneComposer', 'effectComposer', 'cameraFollower', 'pixiInputBridge',
    'tokenManager', 'tileManager', 'wallManager', 'doorMeshManager',
    'drawingManager', 'noteManager', 'templateManager', 'lightIconManager',
    'enhancedLightIconManager', 'enhancedLightInspector', 'interactionManager',
    'overlayUIManager', 'lightEditor', 'gridRenderer', 'mapPointsManager',
    'weatherController', 'renderLoop', 'sceneDebug', 'controlsIntegration',
    'dynamicExposureManager', 'physicsRopeManager',
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
