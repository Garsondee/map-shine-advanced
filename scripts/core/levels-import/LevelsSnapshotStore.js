/**
 * @fileoverview LevelsSnapshotStore — per-scene cache for LevelsImportSnapshot.
 *
 * Builds a snapshot once per scene (or on explicit invalidation) and caches
 * it so consumers never trigger redundant flag reads. The store is exposed
 * on `window.MapShine.levelsSnapshot` for diagnostics.
 *
 * Invalidation triggers:
 * - Scene change (canvasReady)
 * - Explicit `invalidate()` call (e.g. after flag mutation via Levels Authoring dialog)
 * - Compatibility mode change
 *
 * @module core/levels-import/LevelsSnapshotStore
 */

import { createLogger } from '../log.js';
import { buildLevelsImportSnapshot } from './LevelsImportSnapshot.js';

const log = createLogger('LevelsSnapshotStore');

/** @type {import('./LevelsImportSnapshot.js').LevelsImportSnapshot|null} */
let _cachedSnapshot = null;

/** @type {string|null} Scene ID that the cache was built for */
let _cachedSceneId = null;

/**
 * Get the current LevelsImportSnapshot for the active scene.
 *
 * Returns a cached snapshot if one exists for the current scene, otherwise
 * builds a fresh one. The snapshot is immutable (Object.freeze'd).
 *
 * @returns {import('./LevelsImportSnapshot.js').LevelsImportSnapshot}
 */
export function getSnapshot() {
  const scene = canvas?.scene ?? null;
  const sceneId = scene?.id ?? '';

  // Return cached snapshot if still valid for this scene
  if (_cachedSnapshot && _cachedSceneId === sceneId) {
    return _cachedSnapshot;
  }

  // Build and cache a new snapshot
  _cachedSnapshot = buildLevelsImportSnapshot(scene);
  _cachedSceneId = sceneId;

  log.info(`[LevelsSnapshotStore] Built snapshot for scene "${sceneId}": ` +
    `enabled=${_cachedSnapshot.levelsEnabled}, ` +
    `bands=${_cachedSnapshot.sceneLevels.length}, ` +
    `tiles=${_cachedSnapshot.tiles.length}, ` +
    `walls=${_cachedSnapshot.walls.length}, ` +
    `docRanges=${_cachedSnapshot.docRanges.length}, ` +
    `coercionFallbacks=${_cachedSnapshot.diagnostics.coercionFallbacks}`);

  return _cachedSnapshot;
}

/**
 * Invalidate the cached snapshot, forcing a rebuild on next access.
 *
 * Call this after:
 * - Scene flags are mutated (e.g. Levels Authoring dialog saves)
 * - Tiles/walls/lights are created/updated/deleted with Levels flags
 * - Compatibility mode changes
 */
export function invalidate() {
  const hadCache = !!_cachedSnapshot;
  _cachedSnapshot = null;
  _cachedSceneId = null;
  if (hadCache) {
    log.debug('[LevelsSnapshotStore] Cache invalidated');
  }
}

/**
 * Get the cached snapshot without triggering a build.
 * Returns null if no snapshot is cached.
 *
 * @returns {import('./LevelsImportSnapshot.js').LevelsImportSnapshot|null}
 */
export function peekSnapshot() {
  return _cachedSnapshot;
}

/**
 * Install Foundry hooks that auto-invalidate the cache when relevant
 * data changes. Call once during module initialization.
 *
 * @returns {Array<[string, number]>} Array of [hookName, hookId] tuples for cleanup
 */
export function installSnapshotStoreHooks() {
  const hookIds = [];

  // Scene change — always invalidate
  hookIds.push(['canvasReady', Hooks.on('canvasReady', () => {
    invalidate();
  })]);

  // Tile changes that might affect Levels flags
  hookIds.push(['createTile', Hooks.on('createTile', () => { invalidate(); })]);
  hookIds.push(['updateTile', Hooks.on('updateTile', () => { invalidate(); })]);
  hookIds.push(['deleteTile', Hooks.on('deleteTile', () => { invalidate(); })]);

  // Wall changes that might affect wall-height flags
  hookIds.push(['createWall', Hooks.on('createWall', () => { invalidate(); })]);
  hookIds.push(['updateWall', Hooks.on('updateWall', () => { invalidate(); })]);
  hookIds.push(['deleteWall', Hooks.on('deleteWall', () => { invalidate(); })]);

  // Light/sound/note changes
  hookIds.push(['createAmbientLight', Hooks.on('createAmbientLight', () => { invalidate(); })]);
  hookIds.push(['updateAmbientLight', Hooks.on('updateAmbientLight', () => { invalidate(); })]);
  hookIds.push(['deleteAmbientLight', Hooks.on('deleteAmbientLight', () => { invalidate(); })]);
  hookIds.push(['createAmbientSound', Hooks.on('createAmbientSound', () => { invalidate(); })]);
  hookIds.push(['updateAmbientSound', Hooks.on('updateAmbientSound', () => { invalidate(); })]);
  hookIds.push(['deleteAmbientSound', Hooks.on('deleteAmbientSound', () => { invalidate(); })]);

  // Scene flag updates (e.g. Levels Authoring dialog saves sceneLevels)
  hookIds.push(['updateScene', Hooks.on('updateScene', (sceneDoc, changes) => {
    // Only invalidate if flags were changed (avoid churn from darkness/time updates)
    if (changes?.flags) {
      invalidate();
    }
  })]);

  log.info('[LevelsSnapshotStore] Hooks installed for auto-invalidation');
  return hookIds;
}
