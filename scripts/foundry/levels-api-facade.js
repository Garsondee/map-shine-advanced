/**
 * @fileoverview Levels API Compatibility Facade (MS-LVL-090).
 *
 * Provides a read-only compatibility shim that third-party modules and macros
 * can call instead of the real Levels API. Map Shine re-implements the most
 * commonly used Levels API surface using its own imported flag data and
 * elevation context, so external callers get correct answers without requiring
 * the Levels runtime to be active.
 *
 * Exposed at `CONFIG.Levels.API` when compatibility mode is not `off` and
 * the real Levels module is not active (to avoid conflicts).
 *
 * Supported methods:
 * - `inRange(document, elevation)` — is the document's elevation range visible at the given elevation?
 * - `isTokenInRange(token, elevation)` — is the token at or overlapping the given elevation?
 * - `getElevationForPoint(point)` — get the highest tile elevation at a 2D point
 * - `getPerspectiveElevation()` — current viewer elevation (Map Shine native)
 *
 * @module foundry/levels-api-facade
 */

import { createLogger } from '../core/log.js';
import { getLevelsCompatibilityMode, LEVELS_COMPATIBILITY_MODES } from './levels-compatibility.js';
import { readDocLevelsRange, readTileLevelsFlags, tileHasLevelsRange, isLevelsEnabledForScene } from './levels-scene-flags.js';
import { getPerspectiveElevation, isElevationRangeVisible } from './elevation-context.js';

const log = createLogger('LevelsApiFacade');

/**
 * Check if a document's elevation range includes the given elevation.
 *
 * Mirrors `CONFIG.Levels.API.inRange(placeable, elevation, useEye)`.
 * Simplified: Map Shine always uses the document's imported range flags.
 *
 * @param {object} documentOrPlaceable - A Foundry document or placeable
 * @param {number} elevation - The elevation to test against
 * @returns {boolean}
 */
function inRange(documentOrPlaceable, elevation) {
  try {
    const doc = documentOrPlaceable?.document ?? documentOrPlaceable;
    if (!doc) return true;

    const elev = Number(elevation);
    if (!Number.isFinite(elev)) return true;

    const range = readDocLevelsRange(doc);
    const bottom = Number.isFinite(range.rangeBottom) ? range.rangeBottom : -Infinity;
    const top = Number.isFinite(range.rangeTop) ? range.rangeTop : Infinity;

    return elev >= bottom && elev <= top;
  } catch (_) {
    return true; // Fail-open
  }
}

/**
 * Check if a token is at or overlapping a given elevation.
 *
 * Mirrors `CONFIG.Levels.API.isTokenInRange(token, elevation)`.
 * Uses the token's document elevation as a point value (Foundry tokens
 * don't have a vertical extent in base Levels).
 *
 * @param {object} tokenOrDoc - A token placeable or document
 * @param {number} elevation - The elevation to test
 * @returns {boolean}
 */
function isTokenInRange(tokenOrDoc, elevation) {
  try {
    const doc = tokenOrDoc?.document ?? tokenOrDoc;
    if (!doc) return true;

    const tokenElev = Number(doc.elevation ?? 0);
    const testElev = Number(elevation);
    if (!Number.isFinite(tokenElev) || !Number.isFinite(testElev)) return true;

    // Levels treats token as a point at its elevation — in range if equal
    // For losHeight tokens that have vertical extent, check a small band
    const losHeight = Number(doc.losHeight ?? tokenElev);
    const top = Math.max(tokenElev, Number.isFinite(losHeight) ? losHeight : tokenElev);

    return testElev >= tokenElev && testElev <= top;
  } catch (_) {
    return true;
  }
}

/**
 * Get the highest tile elevation at a given 2D point.
 *
 * Mirrors `CONFIG.Levels.API.getElevationForPoint(point)`.
 * Scans all tiles with Levels range flags that overlap the point and
 * returns the highest `rangeBottom` (tile elevation).
 *
 * @param {{x: number, y: number}} point - Foundry-coordinate point
 * @returns {number} The highest tile elevation at that point, or 0
 */
function getElevationForPoint(point) {
  try {
    const px = Number(point?.x ?? 0);
    const py = Number(point?.y ?? 0);

    const tiles = canvas?.scene?.tiles;
    if (!tiles) return 0;

    let maxElev = -Infinity;

    for (const tileDoc of tiles) {
      if (!tileDoc || !tileHasLevelsRange(tileDoc)) continue;

      const tx = Number(tileDoc.x ?? 0);
      const ty = Number(tileDoc.y ?? 0);
      const tw = Number(tileDoc.width ?? 0);
      const th = Number(tileDoc.height ?? 0);

      if (px < tx || px > tx + tw) continue;
      if (py < ty || py > ty + th) continue;

      const flags = readTileLevelsFlags(tileDoc);
      if (Number.isFinite(flags.rangeBottom) && flags.rangeBottom > maxElev) {
        maxElev = flags.rangeBottom;
      }
    }

    return Number.isFinite(maxElev) ? maxElev : 0;
  } catch (_) {
    return 0;
  }
}

/**
 * Get the current viewer perspective elevation.
 *
 * Map Shine native — no direct Levels equivalent, but useful for callers
 * that need to know what elevation the viewer is at.
 *
 * @returns {{elevation: number, losHeight: number, source: string}}
 */
function getViewerElevation() {
  return getPerspectiveElevation();
}

/**
 * Rescale all Levels elevation flags when the grid distance changes.
 *
 * Mirrors `CONFIG.Levels.API.rescaleGridDistance(previousDistance, currentDistance, scene)`.
 * Walks all document types (tiles, tokens, lights, sounds, notes, walls, templates)
 * and multiplies their elevation/range flags by the rescale factor. Also rescales
 * the scene's `sceneLevels` band definitions.
 *
 * @param {number} previousDistance - The old grid distance
 * @param {number} [currentDistance] - The new grid distance (defaults to current scene)
 * @param {object} [scene] - The scene to rescale (defaults to active scene)
 * @returns {Promise<Array<{documentName: string, count: number}>>}
 */
async function rescaleGridDistance(previousDistance, currentDistance, scene) {
  const prev = Number(previousDistance);
  if (!Number.isFinite(prev) || prev <= 0) {
    log.warn('rescaleGridDistance: invalid previousDistance', previousDistance);
    return [];
  }

  const targetScene = scene ?? canvas?.scene;
  if (!targetScene) {
    log.warn('rescaleGridDistance: no scene available');
    return [];
  }

  const curr = Number(currentDistance ?? targetScene.grid?.distance ?? targetScene.dimensions?.distance ?? prev);
  if (!Number.isFinite(curr) || curr <= 0) return [];

  const factor = curr / prev;
  if (factor === 1) return [];

  const results = [];

  // Helper: rescale a numeric value if finite
  const rs = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n * factor : v;
  };

  try {
    // Tiles: elevation + flags.levels.rangeTop
    const tileUpdates = [];
    for (const doc of (targetScene.tiles || [])) {
      const update = { _id: doc.id };
      let changed = false;
      const elev = doc.elevation;
      if (Number.isFinite(Number(elev))) { update.elevation = rs(elev); changed = true; }
      const rt = doc.flags?.levels?.rangeTop;
      if (rt !== undefined && Number.isFinite(Number(rt))) {
        update.flags = { levels: { rangeTop: rs(rt) } };
        changed = true;
      }
      if (changed) tileUpdates.push(update);
    }
    if (tileUpdates.length > 0) {
      await targetScene.updateEmbeddedDocuments('Tile', tileUpdates);
      results.push({ documentName: 'Tile', count: tileUpdates.length });
    }

    // Tokens: elevation
    const tokenUpdates = [];
    for (const doc of (targetScene.tokens || [])) {
      const elev = doc.elevation;
      if (Number.isFinite(Number(elev))) {
        tokenUpdates.push({ _id: doc.id, elevation: rs(elev) });
      }
    }
    if (tokenUpdates.length > 0) {
      await targetScene.updateEmbeddedDocuments('Token', tokenUpdates);
      results.push({ documentName: 'Token', count: tokenUpdates.length });
    }

    // Lights, Sounds, Notes: elevation + flags.levels.rangeTop
    for (const collectionName of ['lights', 'sounds', 'notes']) {
      const docName = collectionName === 'lights' ? 'AmbientLight'
        : collectionName === 'sounds' ? 'AmbientSound' : 'Note';
      const updates = [];
      for (const doc of (targetScene[collectionName] || [])) {
        const update = { _id: doc.id };
        let changed = false;
        const elev = doc.elevation;
        if (Number.isFinite(Number(elev))) { update.elevation = rs(elev); changed = true; }
        const rt = doc.flags?.levels?.rangeTop;
        if (rt !== undefined && Number.isFinite(Number(rt))) {
          update.flags = { levels: { rangeTop: rs(rt) } };
          changed = true;
        }
        if (changed) updates.push(update);
      }
      if (updates.length > 0) {
        await targetScene.updateEmbeddedDocuments(docName, updates);
        results.push({ documentName: docName, count: updates.length });
      }
    }

    // Walls: flags.wall-height.bottom/top
    const wallUpdates = [];
    for (const doc of (targetScene.walls || [])) {
      const wh = doc.flags?.['wall-height'];
      if (!wh) continue;
      const update = { _id: doc.id, flags: { 'wall-height': {} } };
      let changed = false;
      if (wh.bottom !== undefined && Number.isFinite(Number(wh.bottom))) {
        update.flags['wall-height'].bottom = rs(wh.bottom);
        changed = true;
      }
      if (wh.top !== undefined && Number.isFinite(Number(wh.top))) {
        update.flags['wall-height'].top = rs(wh.top);
        changed = true;
      }
      if (changed) wallUpdates.push(update);
    }
    if (wallUpdates.length > 0) {
      await targetScene.updateEmbeddedDocuments('Wall', wallUpdates);
      results.push({ documentName: 'Wall', count: wallUpdates.length });
    }

    // SceneLevels: rescale band definitions
    try {
      const sceneLevels = targetScene.getFlag?.('levels', 'sceneLevels');
      if (Array.isArray(sceneLevels) && sceneLevels.length > 0) {
        const rescaled = sceneLevels.map((band) => [
          rs(band[0]),
          rs(band[1]),
          band[2] ?? '',
        ]);
        await targetScene.setFlag('levels', 'sceneLevels', rescaled);
        results.push({ documentName: 'sceneLevels', count: rescaled.length });
      }
    } catch (e) {
      log.warn('rescaleGridDistance: failed to rescale sceneLevels', e);
    }

    log.info(`rescaleGridDistance: factor=${factor.toFixed(4)}, results:`, results);
  } catch (e) {
    log.warn('rescaleGridDistance failed', e);
  }

  return results;
}

// ---------------------------------------------------------------------------
//  MS-LVL-084: Drawing-to-region migration utility
// ---------------------------------------------------------------------------

/**
 * Script source templates for region behaviors (matches Levels migration.js).
 * Drawing modes: 2=stair, 21=stairDown, 22=stairUp, 3=elevator.
 */
const REGION_SCRIPT_TEMPLATES = Object.freeze({
  2: 'CONFIG.Levels.handlers.RegionHandler.stair(region,event);\n//Check the wiki page for more region options https://wiki.theripper93.com/levels#regions',
  21: 'CONFIG.Levels.handlers.RegionHandler.stairDown(region,event);',
  22: 'CONFIG.Levels.handlers.RegionHandler.stairUp(region,event);',
  3: 'CONFIG.Levels.handlers.RegionHandler.elevator(region,event,elevatorData);',
});

/**
 * Migrate legacy drawing-based stairs to region-based ExecuteScript behaviors.
 *
 * Mirrors `LevelsMigration.migrateDrawingsToRegions(scene)` from Levels.
 * For each drawing with a valid `drawingMode` (stair/stairDown/stairUp/elevator),
 * creates a Region with a rectangle shape and an ExecuteScript behavior that
 * calls the appropriate RegionHandler method.
 *
 * @param {object} [scene] - Scene to migrate (defaults to active canvas scene)
 * @param {{dryRun?: boolean, deleteDrawings?: boolean}} [options]
 * @returns {Promise<{migrated: number, deleted: number, errors: string[]}>}
 */
async function migrateDrawingsToRegions(scene, options = {}) {
  const { dryRun = false, deleteDrawings = true } = options;
  const targetScene = scene ?? canvas?.scene;
  if (!targetScene) {
    return { migrated: 0, deleted: 0, errors: ['No scene available'] };
  }

  const drawings = targetScene.drawings?.contents ?? Array.from(targetScene.drawings || []);
  const regionsData = [];
  const toDelete = [];
  const errors = [];

  for (const drawing of drawings) {
    const drawingMode = Number(drawing.flags?.levels?.drawingMode ?? 0);
    if (!drawingMode) continue;

    // Mode 1 = "hole" drawing — just delete, don't migrate
    if (drawingMode === 1) {
      toDelete.push(drawing.id);
      continue;
    }

    const scriptTemplate = REGION_SCRIPT_TEMPLATES[drawingMode];
    if (!scriptTemplate) {
      errors.push(`Drawing ${drawing.id}: unknown drawingMode ${drawingMode}`);
      continue;
    }

    // Only handle rectangle drawings (matching Levels behavior)
    const shapeType = drawing.shape?.type;
    if (shapeType !== 'r' && shapeType !== undefined) {
      errors.push(`Drawing ${drawing.id}: non-rectangle shape type '${shapeType}' skipped`);
      continue;
    }

    const bottom = Number(drawing.elevation ?? NaN);
    const top = Number(drawing.flags?.levels?.rangeTop ?? NaN);
    if (!Number.isFinite(bottom) || !Number.isFinite(top)) {
      errors.push(`Drawing ${drawing.id}: invalid elevation range (${bottom}..${top})`);
      continue;
    }

    const elevatorFloors = String(drawing.flags?.levels?.elevatorFloors ?? '');
    const name = String(drawing.text || `Levels Stair ${bottom}-${top}`);
    const source = scriptTemplate.replace('elevatorData', `"${elevatorFloors}"`);

    regionsData.push({
      name,
      color: '#fe6c0b',
      elevation: {
        bottom,
        top: top + 1,
      },
      behaviors: [{
        name: 'Execute Script',
        type: 'executeScript',
        system: {
          events: ['tokenEnter'],
          source,
        },
      }],
      shapes: [{
        type: 'rectangle',
        x: Number(drawing.x ?? 0),
        y: Number(drawing.y ?? 0),
        width: Number(drawing.shape?.width ?? drawing.width ?? 0),
        height: Number(drawing.shape?.height ?? drawing.height ?? 0),
        rotation: 0,
        hole: false,
      }],
    });

    toDelete.push(drawing.id);
  }

  if (dryRun) {
    log.info(`[MS-LVL-084] Dry run: would migrate ${regionsData.length} drawings, delete ${toDelete.length}`);
    return { migrated: regionsData.length, deleted: toDelete.length, errors };
  }

  try {
    if (regionsData.length > 0) {
      await targetScene.createEmbeddedDocuments('Region', regionsData);
    }
    if (deleteDrawings && toDelete.length > 0) {
      await targetScene.deleteEmbeddedDocuments('Drawing', toDelete);
    }
    log.info(`[MS-LVL-084] Migrated ${regionsData.length} drawings to regions in ${targetScene.name}`);
    ui?.notifications?.info?.(`Map Shine: Migrated ${regionsData.length} drawing stairs to regions`);
  } catch (e) {
    errors.push(`Migration failed: ${e?.message || e}`);
    log.warn('[MS-LVL-084] Migration failed', e);
  }

  return { migrated: regionsData.length, deleted: deleteDrawings ? toDelete.length : 0, errors };
}

// ---------------------------------------------------------------------------
//  MS-LVL-112: Non-destructive migration (Levels flags → Map Shine native)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} MigrationDiffEntry
 * @property {string} docType   - e.g. 'Tile', 'AmbientLight', 'Wall', 'Scene'
 * @property {string} docId     - Document ID
 * @property {string} docName   - Human-readable name/label
 * @property {object} levelsFlags  - Original flags being migrated
 * @property {object} nativeFlags  - What would be written to map-shine-advanced
 * @property {boolean} alreadyMigrated - True if native flags already exist
 */

/**
 * @typedef {object} MigrationResult
 * @property {string} sceneName
 * @property {string} sceneId
 * @property {number} totalDocs       - Total documents inspected
 * @property {number} migratedCount   - Documents that were (or would be) migrated
 * @property {number} skippedCount    - Documents already migrated or with no Levels data
 * @property {number} errorCount
 * @property {MigrationDiffEntry[]} diff - Per-document diff entries
 * @property {string[]} errors
 */

/**
 * Build the Map Shine native flag payload from a tile's Levels flags.
 * @param {object} tileDoc
 * @returns {{elevation: object}|null}
 */
function _buildNativeTileFlags(tileDoc) {
  if (!tileDoc?.flags?.levels) return null;
  const lf = tileDoc.flags.levels;
  // Only migrate if there's meaningful data
  if (lf.rangeTop === undefined && !lf.isBasement && !lf.showIfAbove && !lf.noCollision && !lf.noFogHide) {
    return null;
  }
  const rangeTop = Number(lf.rangeTop);
  return {
    elevation: {
      rangeBottom: Number(tileDoc.elevation ?? 0),
      rangeTop: Number.isFinite(rangeTop) ? rangeTop : Infinity,
      showIfAbove: lf.showIfAbove === true,
      showAboveRange: Number.isFinite(Number(lf.showAboveRange)) ? Number(lf.showAboveRange) : Infinity,
      isBasement: lf.isBasement === true,
      noCollision: lf.noCollision === true,
      noFogHide: lf.noFogHide === true,
      allWallBlockSight: lf.allWallBlockSight === true,
    },
    _migratedFrom: 'levels',
    _migratedAt: Date.now(),
  };
}

/**
 * Build the Map Shine native flag payload from a generic doc's Levels range flags.
 * @param {object} doc
 * @returns {{elevation: object}|null}
 */
function _buildNativeDocFlags(doc) {
  if (!doc?.flags?.levels) return null;
  const lf = doc.flags.levels;
  if (lf.rangeBottom === undefined && lf.rangeTop === undefined) return null;

  // Levels V12+ migrates flags.levels.rangeBottom to doc.elevation.
  // Fall back to doc.elevation when the flag is absent to match Levels'
  // own getRangeForDocument() semantics.
  const rawBottom = Number(lf.rangeBottom);
  const docElev = Number(doc.elevation ?? NaN);
  const bottom = Number.isFinite(rawBottom) ? rawBottom
    : Number.isFinite(docElev) ? docElev : -Infinity;

  const top = Number(lf.rangeTop);
  return {
    elevation: {
      rangeBottom: bottom,
      rangeTop: Number.isFinite(top) ? top : Infinity,
    },
    _migratedFrom: 'levels',
    _migratedAt: Date.now(),
  };
}

/**
 * Build the Map Shine native flag payload from a wall's wall-height flags.
 * @param {object} wallDoc
 * @returns {{wallHeight: object}|null}
 */
function _buildNativeWallFlags(wallDoc) {
  const wh = wallDoc?.flags?.['wall-height'];
  if (!wh) return null;
  const bottom = Number(wh.bottom);
  const top = Number(wh.top);
  if (!Number.isFinite(bottom) && !Number.isFinite(top)) return null;

  return {
    wallHeight: {
      bottom: Number.isFinite(bottom) ? bottom : -Infinity,
      top: Number.isFinite(top) ? top : Infinity,
    },
    _migratedFrom: 'wall-height',
    _migratedAt: Date.now(),
  };
}

/**
 * Build the Map Shine native scene-level flags from Levels scene flags.
 * @param {object} scene
 * @returns {{levels: object}|null}
 */
function _buildNativeSceneFlags(scene) {
  const lf = scene?.flags?.levels;
  if (!lf) return null;

  const hasBgElev = lf.backgroundElevation !== undefined;
  const hasWeatherElev = lf.weatherElevation !== undefined;
  const hasLightMasking = lf.lightMasking !== undefined;
  const hasSceneLevels = Array.isArray(lf.sceneLevels) && lf.sceneLevels.length > 0;

  if (!hasBgElev && !hasWeatherElev && !hasLightMasking && !hasSceneLevels) return null;

  const native = { _migratedFrom: 'levels', _migratedAt: Date.now() };

  if (hasBgElev) {
    const n = Number(lf.backgroundElevation);
    native.backgroundElevation = Number.isFinite(n) ? n : 0;
  }
  if (hasWeatherElev) {
    const n = Number(lf.weatherElevation);
    native.weatherElevation = Number.isFinite(n) ? n : null;
  }
  if (hasLightMasking) {
    native.lightMasking = lf.lightMasking === true;
  }
  if (hasSceneLevels) {
    // Normalize sceneLevels into a clean array-of-objects format
    native.sceneLevels = lf.sceneLevels.map((entry, i) => {
      if (Array.isArray(entry)) {
        return { bottom: Number(entry[0] ?? 0), top: Number(entry[1] ?? 0), label: String(entry[2] ?? `Level ${i + 1}`) };
      }
      if (entry && typeof entry === 'object') {
        return {
          bottom: Number(entry.bottom ?? entry.rangeBottom ?? 0),
          top: Number(entry.top ?? entry.rangeTop ?? 0),
          label: String(entry.label ?? entry.name ?? `Level ${i + 1}`),
        };
      }
      return { bottom: 0, top: 0, label: `Level ${i + 1}` };
    });
  }

  return { levels: native };
}

/**
 * Non-destructive migration of Levels flags to Map Shine native flags for a
 * single scene. Copies `flags.levels` data into `flags.map-shine-advanced`
 * without deleting the originals, allowing rollback.
 *
 * @param {object} [scene] - Scene to migrate (defaults to active canvas scene)
 * @param {{dryRun?: boolean, force?: boolean}} [options]
 * @returns {Promise<MigrationResult>}
 */
async function migrateLevelsToNative(scene, options = {}) {
  const { dryRun = false, force = false } = options;
  const targetScene = scene ?? canvas?.scene;

  if (!targetScene) {
    return { sceneName: '(none)', sceneId: '', totalDocs: 0, migratedCount: 0, skippedCount: 0, errorCount: 0, diff: [], errors: ['No scene available'] };
  }

  const result = {
    sceneName: targetScene.name || targetScene.id,
    sceneId: targetScene.id,
    totalDocs: 0,
    migratedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    diff: [],
    errors: [],
  };

  const MS_FLAG = 'map-shine-advanced';

  // --- Scene-level flags ---
  try {
    const sceneNative = _buildNativeSceneFlags(targetScene);
    if (sceneNative) {
      result.totalDocs++;
      const existing = targetScene.flags?.[MS_FLAG]?.levels;
      const alreadyMigrated = existing?._migratedFrom === 'levels';
      result.diff.push({
        docType: 'Scene',
        docId: targetScene.id,
        docName: targetScene.name || targetScene.id,
        levelsFlags: targetScene.flags?.levels || {},
        nativeFlags: sceneNative,
        alreadyMigrated,
      });

      if (!alreadyMigrated || force) {
        if (!dryRun) {
          await targetScene.update({ [`flags.${MS_FLAG}`]: sceneNative });
        }
        result.migratedCount++;
      } else {
        result.skippedCount++;
      }
    }
  } catch (e) {
    result.errors.push(`Scene flags: ${e?.message || e}`);
    result.errorCount++;
  }

  // --- Tile flags ---
  const tileUpdates = [];
  for (const tileDoc of (targetScene.tiles || [])) {
    result.totalDocs++;
    try {
      const native = _buildNativeTileFlags(tileDoc);
      if (!native) { result.skippedCount++; continue; }

      const existing = tileDoc.flags?.[MS_FLAG];
      const alreadyMigrated = existing?._migratedFrom === 'levels';
      result.diff.push({
        docType: 'Tile',
        docId: tileDoc.id,
        docName: tileDoc.texture?.src?.split('/')?.pop() || tileDoc.id,
        levelsFlags: tileDoc.flags?.levels || {},
        nativeFlags: native,
        alreadyMigrated,
      });

      if (!alreadyMigrated || force) {
        tileUpdates.push({ _id: tileDoc.id, [`flags.${MS_FLAG}`]: native });
        result.migratedCount++;
      } else {
        result.skippedCount++;
      }
    } catch (e) {
      result.errors.push(`Tile ${tileDoc.id}: ${e?.message || e}`);
      result.errorCount++;
    }
  }
  if (!dryRun && tileUpdates.length > 0) {
    try {
      await targetScene.updateEmbeddedDocuments('Tile', tileUpdates);
    } catch (e) {
      result.errors.push(`Tile batch update: ${e?.message || e}`);
      result.errorCount++;
    }
  }

  // --- Generic doc collections (lights, sounds, notes, drawings, templates) ---
  const DOC_COLLECTIONS = [
    { collection: 'lights', docName: 'AmbientLight' },
    { collection: 'sounds', docName: 'AmbientSound' },
    { collection: 'notes', docName: 'Note' },
    { collection: 'drawings', docName: 'Drawing' },
    { collection: 'templates', docName: 'MeasuredTemplate' },
  ];

  for (const { collection, docName } of DOC_COLLECTIONS) {
    const updates = [];
    for (const doc of (targetScene[collection] || [])) {
      result.totalDocs++;
      try {
        const native = _buildNativeDocFlags(doc);
        if (!native) { result.skippedCount++; continue; }

        const existing = doc.flags?.[MS_FLAG];
        const alreadyMigrated = existing?._migratedFrom === 'levels';
        result.diff.push({
          docType: docName,
          docId: doc.id,
          docName: doc.name || doc.label || doc.text || doc.id,
          levelsFlags: doc.flags?.levels || {},
          nativeFlags: native,
          alreadyMigrated,
        });

        if (!alreadyMigrated || force) {
          updates.push({ _id: doc.id, [`flags.${MS_FLAG}`]: native });
          result.migratedCount++;
        } else {
          result.skippedCount++;
        }
      } catch (e) {
        result.errors.push(`${docName} ${doc.id}: ${e?.message || e}`);
        result.errorCount++;
      }
    }
    if (!dryRun && updates.length > 0) {
      try {
        await targetScene.updateEmbeddedDocuments(docName, updates);
      } catch (e) {
        result.errors.push(`${docName} batch update: ${e?.message || e}`);
        result.errorCount++;
      }
    }
  }

  // --- Wall flags (wall-height) ---
  const wallUpdates = [];
  for (const wallDoc of (targetScene.walls || [])) {
    result.totalDocs++;
    try {
      const native = _buildNativeWallFlags(wallDoc);
      if (!native) { result.skippedCount++; continue; }

      const existing = wallDoc.flags?.[MS_FLAG];
      const alreadyMigrated = existing?._migratedFrom === 'wall-height';
      result.diff.push({
        docType: 'Wall',
        docId: wallDoc.id,
        docName: `Wall ${wallDoc.id}`,
        levelsFlags: wallDoc.flags?.['wall-height'] || {},
        nativeFlags: native,
        alreadyMigrated,
      });

      if (!alreadyMigrated || force) {
        wallUpdates.push({ _id: wallDoc.id, [`flags.${MS_FLAG}`]: native });
        result.migratedCount++;
      } else {
        result.skippedCount++;
      }
    } catch (e) {
      result.errors.push(`Wall ${wallDoc.id}: ${e?.message || e}`);
      result.errorCount++;
    }
  }
  if (!dryRun && wallUpdates.length > 0) {
    try {
      await targetScene.updateEmbeddedDocuments('Wall', wallUpdates);
    } catch (e) {
      result.errors.push(`Wall batch update: ${e?.message || e}`);
      result.errorCount++;
    }
  }

  if (!dryRun) {
    log.info(`[MS-LVL-112] Migrated ${result.migratedCount} docs in "${result.sceneName}"`, result);
  } else {
    log.info(`[MS-LVL-112] Dry run: would migrate ${result.migratedCount} docs in "${result.sceneName}"`, result);
  }

  return result;
}

// ---------------------------------------------------------------------------
//  MS-LVL-113: World-wide migration with diff summary
// ---------------------------------------------------------------------------

/**
 * @typedef {object} WorldMigrationResult
 * @property {boolean} dryRun
 * @property {number} sceneCount
 * @property {number} totalMigrated
 * @property {number} totalSkipped
 * @property {number} totalErrors
 * @property {MigrationResult[]} scenes
 * @property {string} summary - Human-readable summary
 */

/**
 * Run non-destructive Levels→MapShine migration across all scenes in the world.
 *
 * @param {{dryRun?: boolean, force?: boolean, scenePredicate?: (scene: object) => boolean}} [options]
 * @returns {Promise<WorldMigrationResult>}
 */
async function migrateLevelsWorldWide(options = {}) {
  const { dryRun = true, force = false, scenePredicate } = options;

  if (game.user?.isGM !== true) {
    return { dryRun, sceneCount: 0, totalMigrated: 0, totalSkipped: 0, totalErrors: 0, scenes: [], summary: 'Only GM can run world-wide migration.' };
  }

  const allScenes = game.scenes?.contents || [];
  const scenes = scenePredicate ? allScenes.filter(scenePredicate) : allScenes;

  const worldResult = {
    dryRun,
    sceneCount: scenes.length,
    totalMigrated: 0,
    totalSkipped: 0,
    totalErrors: 0,
    scenes: [],
    summary: '',
  };

  for (const scene of scenes) {
    try {
      const sceneResult = await migrateLevelsToNative(scene, { dryRun, force });
      worldResult.scenes.push(sceneResult);
      worldResult.totalMigrated += sceneResult.migratedCount;
      worldResult.totalSkipped += sceneResult.skippedCount;
      worldResult.totalErrors += sceneResult.errorCount;
    } catch (e) {
      worldResult.totalErrors++;
      worldResult.scenes.push({
        sceneName: scene.name || scene.id,
        sceneId: scene.id,
        totalDocs: 0,
        migratedCount: 0,
        skippedCount: 0,
        errorCount: 1,
        diff: [],
        errors: [e?.message || String(e)],
      });
    }
  }

  // Build human-readable summary
  const lines = [
    `--- Map Shine Levels Migration ${dryRun ? '(DRY RUN)' : '(APPLIED)'} ---`,
    `Scenes processed: ${worldResult.sceneCount}`,
    `Documents migrated: ${worldResult.totalMigrated}`,
    `Documents skipped (already migrated): ${worldResult.totalSkipped}`,
    `Errors: ${worldResult.totalErrors}`,
    '',
  ];

  for (const sr of worldResult.scenes) {
    if (sr.migratedCount > 0 || sr.errorCount > 0) {
      lines.push(`  ${sr.sceneName}: ${sr.migratedCount} migrated, ${sr.skippedCount} skipped, ${sr.errorCount} errors`);
      // Summarize by doc type
      const typeCounts = {};
      for (const d of sr.diff) {
        if (d.alreadyMigrated && !force) continue;
        typeCounts[d.docType] = (typeCounts[d.docType] || 0) + 1;
      }
      const typeEntries = Object.entries(typeCounts);
      if (typeEntries.length > 0) {
        lines.push(`    Types: ${typeEntries.map(([k, v]) => `${k}(${v})`).join(', ')}`);
      }
    }
  }

  worldResult.summary = lines.join('\n');

  log.info('[MS-LVL-113] World-wide migration result:', worldResult.summary);

  if (!dryRun) {
    ui?.notifications?.info?.(`Map Shine: Migrated ${worldResult.totalMigrated} documents across ${worldResult.sceneCount} scenes.`);
  }

  return worldResult;
}

// ---------------------------------------------------------------------------
//  Facade object
// ---------------------------------------------------------------------------

const facade = Object.freeze({
  inRange,
  isTokenInRange,
  getElevationForPoint,
  getViewerElevation,
  rescaleGridDistance,
  migrateDrawingsToRegions,
  migrateLevelsToNative,
  migrateLevelsWorldWide,
  // Mark this as a Map Shine facade so callers can detect it
  _mapShineFacade: true,
  _version: 4,
});

/**
 * Install the Levels API compatibility facade on `CONFIG.Levels.API`.
 *
 * Only installs if:
 * - Levels compatibility mode is not `off`
 * - The real Levels module is NOT active (don't override the real API)
 * - `CONFIG.Levels.API` doesn't already exist
 *
 * Safe to call multiple times — no-ops on subsequent calls.
 *
 * @returns {boolean} True if the facade was installed
 */
let _installed = false;

export function installLevelsApiFacade() {
  if (_installed) return false;

  const mode = getLevelsCompatibilityMode();
  if (mode === LEVELS_COMPATIBILITY_MODES.OFF) return false;

  // Don't override the real Levels API if the module is active
  const levelsActive = game?.modules?.get?.('levels')?.active === true;
  if (levelsActive) {
    log.debug('Levels module is active — skipping API facade installation');
    return false;
  }

  // Don't clobber an existing CONFIG.Levels.API
  if (globalThis.CONFIG?.Levels?.API && !globalThis.CONFIG.Levels.API._mapShineFacade) {
    log.debug('CONFIG.Levels.API already exists (not a facade) — skipping installation');
    return false;
  }

  try {
    if (!globalThis.CONFIG) globalThis.CONFIG = {};
    if (!globalThis.CONFIG.Levels) globalThis.CONFIG.Levels = {};

    globalThis.CONFIG.Levels.API = facade;
    _installed = true;
    log.info('Installed Levels API compatibility facade (CONFIG.Levels.API)');
    return true;
  } catch (e) {
    log.warn('Failed to install Levels API facade', e);
    return false;
  }
}

/**
 * Get the facade object directly (for testing or manual wiring).
 * @returns {object}
 */
export function getLevelsApiFacade() {
  return facade;
}
