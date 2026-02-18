/**
 * @fileoverview LevelsImportSnapshot — immutable, normalized snapshot of all
 * Levels-related flag data for a single scene.
 *
 * This is the canonical data contract that all Levels-aware systems in Map
 * Shine should consume. It replaces ad-hoc per-call flag reading with a
 * single, strictly coerced, frozen data object built once per scene load
 * (or on-demand after flag mutations).
 *
 * Design goals (MS-LVL-010):
 * - Strict numeric coercion: every numeric field is validated via Number()
 *   + Number.isFinite(), with explicit safe defaults and diagnostic recording.
 * - Immutable: the snapshot is Object.freeze'd so consumers cannot mutate it.
 * - Fail-safe: malformed or missing flags produce safe defaults, never throw.
 * - Diagnostic-rich: every coercion fallback is recorded for the Diagnostic
 *   Center to surface.
 *
 * @module core/levels-import/LevelsImportSnapshot
 */

import {
  readSceneLevelsFlag,
  normalizeSceneLevels,
  getSceneBackgroundElevation,
  getSceneWeatherElevation,
  getSceneLightMasking,
  readTileLevelsFlags,
  tileHasLevelsRange,
  readDocLevelsRange,
  readWallHeightFlags,
  wallHasHeightBounds,
  isLevelsEnabledForScene,
  getFlagReaderDiagnostics,
  clearFlagReaderDiagnostics,
} from '../../foundry/levels-scene-flags.js';
import { getLevelsCompatibilityMode, LEVELS_COMPATIBILITY_MODES } from '../../foundry/levels-compatibility.js';

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
 * This reads all Levels-related flags from the scene and its embedded
 * documents, applies strict numeric coercion with clamping, and returns
 * a frozen snapshot object.
 *
 * @param {Scene|null|undefined} scene - The Foundry scene document
 * @returns {LevelsImportSnapshot}
 */
export function buildLevelsImportSnapshot(scene) {
  const sceneId = scene?.id ?? '';
  const timestamp = Date.now();

  // If Levels compatibility is off, return a minimal empty snapshot
  if (getLevelsCompatibilityMode() === LEVELS_COMPATIBILITY_MODES.OFF || !scene) {
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
      diagnostics: Object.freeze({ coercionFallbacks: 0, invalidBands: 0, tileCount: 0, wallCount: 0, docRangeCount: 0 }),
    });
  }

  // Clear diagnostics before building so we capture only this snapshot's issues
  clearFlagReaderDiagnostics();

  const levelsEnabled = isLevelsEnabledForScene(scene);
  const backgroundElevation = clampElevation(getSceneBackgroundElevation(scene));
  const weatherElevation = (() => {
    const raw = getSceneWeatherElevation(scene);
    if (raw === null) return null;
    return clampElevation(strictFinite(raw, 0));
  })();
  const lightMasking = getSceneLightMasking(scene);

  // --- Scene Levels (elevation bands) ---
  const rawBands = readSceneLevelsFlag(scene);
  let invalidBands = 0;
  const sceneLevels = [];

  for (let i = 0; i < rawBands.length; i++) {
    const band = rawBands[i];
    if (!band || typeof band !== 'object') {
      invalidBands++;
      continue;
    }

    // Levels stores bands as arrays [bottom, top, name] or objects {bottom, top, name}
    let bottom, top, name;
    if (Array.isArray(band)) {
      bottom = strictFinite(band[0], null);
      top = strictFinite(band[1], null);
      name = String(band[2] ?? `Level ${i}`);
    } else {
      bottom = strictFinite(band.bottom ?? band.rangeBottom, null);
      top = strictFinite(band.top ?? band.rangeTop, null);
      name = String(band.name ?? band.label ?? `Level ${i}`);
    }

    if (bottom === null || top === null) {
      invalidBands++;
      continue;
    }

    // Ensure bottom <= top
    if (top < bottom) {
      const swap = bottom;
      bottom = top;
      top = swap;
    }

    sceneLevels.push(Object.freeze({
      bottom: clampElevation(bottom),
      top: clampElevation(top),
      name,
    }));
  }

  // --- Tiles ---
  const tileSnapshots = [];
  const sceneTiles = scene.tiles ?? [];
  for (const tileDoc of sceneTiles) {
    if (!tileDoc) continue;
    if (!tileHasLevelsRange(tileDoc)) continue;

    const flags = readTileLevelsFlags(tileDoc);
    tileSnapshots.push(Object.freeze({
      id: String(tileDoc.id ?? tileDoc._id ?? ''),
      rangeBottom: clampElevation(flags.rangeBottom),
      rangeTop: strictNumeric(flags.rangeTop, Infinity),
      showIfAbove: strictBool(flags.showIfAbove),
      showAboveRange: strictNumeric(flags.showAboveRange, Infinity),
      isBasement: strictBool(flags.isBasement),
      noCollision: strictBool(flags.noCollision),
      noFogHide: strictBool(flags.noFogHide),
      allWallBlockSight: strictBool(flags.allWallBlockSight),
      excludeFromChecker: strictBool(flags.excludeFromChecker),
    }));
  }

  // --- Doc ranges (lights, sounds, notes, drawings, templates) ---
  const docRangeSnapshots = [];
  const docCollections = [
    { collection: scene.lights, type: 'AmbientLight' },
    { collection: scene.sounds, type: 'AmbientSound' },
    { collection: scene.notes, type: 'Note' },
    { collection: scene.drawings, type: 'Drawing' },
    { collection: scene.templates, type: 'MeasuredTemplate' },
  ];

  for (const { collection, type } of docCollections) {
    if (!collection) continue;
    for (const doc of collection) {
      if (!doc) continue;
      if (!doc.flags?.levels) continue;

      const range = readDocLevelsRange(doc);
      // Only include docs that have at least one finite range bound
      if (!Number.isFinite(range.rangeBottom) && !Number.isFinite(range.rangeTop)) continue;

      docRangeSnapshots.push(Object.freeze({
        id: String(doc.id ?? doc._id ?? ''),
        type,
        rangeBottom: strictNumeric(range.rangeBottom, -Infinity),
        rangeTop: strictNumeric(range.rangeTop, Infinity),
      }));
    }
  }

  // --- Walls with height bounds ---
  const wallSnapshots = [];
  const sceneWalls = scene.walls ?? [];
  for (const wallDoc of sceneWalls) {
    if (!wallDoc) continue;
    if (!wallHasHeightBounds(wallDoc)) continue;

    const bounds = readWallHeightFlags(wallDoc);
    wallSnapshots.push(Object.freeze({
      id: String(wallDoc.id ?? wallDoc._id ?? ''),
      bottom: strictNumeric(bounds.bottom, -Infinity),
      top: strictNumeric(bounds.top, Infinity),
    }));
  }

  // --- Diagnostics ---
  const flagDiags = getFlagReaderDiagnostics();

  const snapshot = Object.freeze({
    sceneId,
    timestamp,
    levelsEnabled,
    backgroundElevation,
    weatherElevation,
    lightMasking,
    sceneLevels: Object.freeze(sceneLevels),
    tiles: Object.freeze(tileSnapshots),
    docRanges: Object.freeze(docRangeSnapshots),
    walls: Object.freeze(wallSnapshots),
    diagnostics: Object.freeze({
      coercionFallbacks: flagDiags.length,
      invalidBands,
      tileCount: tileSnapshots.length,
      wallCount: wallSnapshots.length,
      docRangeCount: docRangeSnapshots.length,
    }),
  });

  return snapshot;
}
