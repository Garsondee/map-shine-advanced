/**
 * @fileoverview LevelsImportSnapshot — immutable, normalized snapshot of scene
 * level data for Map Shine subsystems.
 *
 * V14-native path: the snapshot is built primarily from `scene.levels`
 * (EmbeddedCollection of Level documents). Legacy Levels-flag readers are
 * retained as a migration fallback only.
 *
 * @module core/levels-import/LevelsImportSnapshot
 */

import {
  readV14SceneLevels,
  hasV14NativeLevels,
} from '../../foundry/levels-scene-flags.js';

// ---------------------------------------------------------------------------
//  Strict numeric coercion helpers
// ---------------------------------------------------------------------------

/**
 * Coerce a value to a finite number, returning the default if invalid.
 * @param {unknown} value
 * @param {number} defaultValue
 * @returns {number}
 */
function strictFinite(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  const n = Number(value);
  return Number.isFinite(n) ? n : defaultValue;
}

/**
 * Coerce a value to a number allowing ±Infinity, returning the default if NaN.
 * @param {unknown} value
 * @param {number} defaultValue
 * @returns {number}
 */
function strictNumeric(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  const n = Number(value);
  if (Number.isNaN(n)) return defaultValue;
  return n;
}

/**
 * Coerce to boolean (strict `=== true` check).
 * @param {unknown} value
 * @returns {boolean}
 */
function strictBool(value) {
  return value === true;
}

// Clamping bounds for elevation values to catch absurd imports
const ELEVATION_CLAMP_MIN = -100000;
const ELEVATION_CLAMP_MAX = 100000;

/**
 * Clamp an elevation value to a sane range.
 * @param {number} value
 * @returns {number}
 */
function clampElevation(value) {
  if (!Number.isFinite(value)) return value; // Pass through Infinity/-Infinity
  return Math.max(ELEVATION_CLAMP_MIN, Math.min(ELEVATION_CLAMP_MAX, value));
}

// ---------------------------------------------------------------------------
//  Snapshot types
// ---------------------------------------------------------------------------

/**
 * @typedef {object} LevelsSceneBand
 * @property {number} bottom - Bottom of the elevation band
 * @property {number} top    - Top of the elevation band
 * @property {string} name   - Display name of the band
 */

/**
 * @typedef {object} LevelsTileSnapshot
 * @property {string} id          - Tile document ID
 * @property {number} rangeBottom - Bottom of the tile's elevation range
 * @property {number} rangeTop    - Top of the tile's elevation range
 * @property {boolean} showIfAbove
 * @property {number} showAboveRange
 * @property {boolean} isBasement
 * @property {boolean} noCollision
 * @property {boolean} noFogHide
 * @property {boolean} allWallBlockSight
 * @property {boolean} excludeFromChecker
 */

/**
 * @typedef {object} LevelsDocRangeSnapshot
 * @property {string} id          - Document ID
 * @property {string} type        - Document type (e.g. 'AmbientLight', 'AmbientSound')
 * @property {number} rangeBottom
 * @property {number} rangeTop
 */

/**
 * @typedef {object} LevelsWallSnapshot
 * @property {string} id     - Wall document ID
 * @property {number} bottom - Wall height bottom
 * @property {number} top    - Wall height top
 */

/**
 * @typedef {object} LevelsImportSnapshot
 * @property {string} sceneId            - Scene document ID
 * @property {number} timestamp          - When the snapshot was created (Date.now())
 * @property {boolean} levelsEnabled     - Whether this scene has Levels data
 * @property {number} backgroundElevation
 * @property {number|null} weatherElevation
 * @property {boolean} lightMasking
 * @property {Array<LevelsSceneBand>} sceneLevels - Normalized elevation bands
 * @property {Array<LevelsTileSnapshot>} tiles     - Tiles with Levels flags
 * @property {Array<LevelsDocRangeSnapshot>} docRanges - Lights/sounds/notes/etc with range flags
 * @property {Array<LevelsWallSnapshot>} walls      - Walls with height bounds
 * @property {object} diagnostics                    - Build-time diagnostic summary
 */

// ---------------------------------------------------------------------------
//  Snapshot builder
// ---------------------------------------------------------------------------

/**
 * Build an immutable LevelsImportSnapshot for the given scene.
 *
 * V14-native path: when the scene has native Level documents, the snapshot
 * is built from `scene.levels` and the native `levels` set fields on walls,
 * tiles, etc. Legacy Levels-flag reading is used as a migration fallback.
 *
 * @param {Scene|null|undefined} scene - The Foundry scene document
 * @returns {LevelsImportSnapshot}
 */
export function buildLevelsImportSnapshot(scene) {
  const sceneId = scene?.id ?? '';
  const timestamp = Date.now();

  if (!scene) {
    return _emptySnapshot(sceneId, timestamp);
  }

  // V14-native path
  if (hasV14NativeLevels(scene)) {
    return _buildV14NativeSnapshot(scene, sceneId, timestamp);
  }

  return _emptySnapshot(sceneId, timestamp);
}

function _emptySnapshot(sceneId, timestamp) {
  return Object.freeze({
    sceneId,
    timestamp,
    levelsEnabled: false,
    backgroundElevation: 0,
    weatherElevation: null,
    lightMasking: false,
    sceneLevels: Object.freeze([]),
    tiles: Object.freeze([]),
    docRanges: Object.freeze([]),
    walls: Object.freeze([]),
    diagnostics: Object.freeze({ coercionFallbacks: 0, invalidBands: 0, tileCount: 0, wallCount: 0, docRangeCount: 0, source: 'empty' }),
  });
}

/**
 * Build a snapshot from V14 native Level documents.
 */
function _buildV14NativeSnapshot(scene, sceneId, timestamp) {
  const nativeLevels = readV14SceneLevels(scene);

  const sceneLevels = nativeLevels.map((lvl) => {
    const bottom = Number.isFinite(lvl.bottom) ? lvl.bottom : 0;
    const top = Number.isFinite(lvl.top) ? lvl.top : bottom;
    return Object.freeze({
      bottom,
      top,
      name: lvl.label,
      levelId: lvl.levelId,
    });
  });

  // Walls: use V14 native levels membership
  const wallSnapshots = [];
  const sceneWalls = scene.walls ?? [];
  for (const wallDoc of sceneWalls) {
    if (!wallDoc) continue;
    const levelsSet = wallDoc.levels;
    const levelIds = levelsSet?.size ? Array.from(levelsSet) : [];
    wallSnapshots.push(Object.freeze({
      id: String(wallDoc.id ?? ''),
      bottom: -Infinity,
      top: Infinity,
      levelIds: Object.freeze(levelIds),
    }));
  }

  // Tiles: use native level membership where available
  const tileSnapshots = [];
  const sceneTiles = scene.tiles ?? [];
  for (const tileDoc of sceneTiles) {
    if (!tileDoc) continue;
    const elevation = Number(tileDoc.elevation ?? 0);
    const safeElev = Number.isFinite(elevation) ? elevation : 0;
    const levelsSet = tileDoc.levels;
    const levelIds = levelsSet?.size ? Array.from(levelsSet) : [];
    tileSnapshots.push(Object.freeze({
      id: String(tileDoc.id ?? ''),
      rangeBottom: safeElev,
      rangeTop: Infinity,
      showIfAbove: false,
      showAboveRange: Infinity,
      isBasement: false,
      noCollision: false,
      noFogHide: false,
      allWallBlockSight: false,
      excludeFromChecker: false,
      levelIds: Object.freeze(levelIds),
    }));
  }

  return Object.freeze({
    sceneId,
    timestamp,
    levelsEnabled: true,
    backgroundElevation: 0,
    weatherElevation: null,
    lightMasking: false,
    sceneLevels: Object.freeze(sceneLevels),
    tiles: Object.freeze(tileSnapshots),
    docRanges: Object.freeze([]),
    walls: Object.freeze(wallSnapshots),
    diagnostics: Object.freeze({
      coercionFallbacks: 0,
      invalidBands: 0,
      tileCount: tileSnapshots.length,
      wallCount: wallSnapshots.length,
      docRangeCount: 0,
      source: 'v14-native',
    }),
  });
}

