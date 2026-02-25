/**
 * @fileoverview Helpers for reading and normalizing Levels scene/tile/doc flag payloads.
 *
 * All flag reading is gated on the Levels compatibility mode — when mode is
 * 'off', every reader returns safe defaults so the rest of the codebase never
 * needs to check the mode itself.
 */

import { getLevelsCompatibilityMode, LEVELS_COMPATIBILITY_MODES } from './levels-compatibility.js';

// ---------------------------------------------------------------------------
//  MS-LVL-015: Flag-reader diagnostic collector
// ---------------------------------------------------------------------------

/**
 * Lightweight ring buffer collecting diagnostic events when flag readers
 * encounter non-numeric, NaN, or otherwise invalid values that were
 * silently replaced with safe defaults. The Diagnostic Center reads
 * this buffer to surface data-quality warnings to the user.
 *
 * @type {Array<{reader: string, field: string, rawValue: unknown, defaultUsed: unknown, docId?: string, timestamp: number}>}
 */
const _flagDiagnostics = [];
const FLAG_DIAG_MAX = 100;

/**
 * Record a diagnostic event for an invalid flag value.
 * @param {string} reader - Name of the reader function (e.g. 'readTileLevelsFlags')
 * @param {string} field  - Name of the field that was invalid (e.g. 'rangeTop')
 * @param {unknown} rawValue - The raw value encountered
 * @param {unknown} defaultUsed - The safe default that was substituted
 * @param {string} [docId] - Optional document ID for tracing
 */
function _recordFlagDiagnostic(reader, field, rawValue, defaultUsed, docId) {
  if (_flagDiagnostics.length >= FLAG_DIAG_MAX) _flagDiagnostics.shift();
  _flagDiagnostics.push({ reader, field, rawValue, defaultUsed, docId, timestamp: Date.now() });
}

/**
 * Get a snapshot of recent flag-reader diagnostics.
 * @returns {Array<{reader: string, field: string, rawValue: unknown, defaultUsed: unknown, docId?: string, timestamp: number}>}
 */
export function getFlagReaderDiagnostics() {
  return [..._flagDiagnostics];
}

/**
 * Clear recorded flag-reader diagnostics (e.g. after scene change).
 */
export function clearFlagReaderDiagnostics() {
  _flagDiagnostics.length = 0;
}

/**
 * Normalize the Levels sceneLevels payload into an array form.
 * Supports multiple import/runtime payload variants.
 *
 * @param {unknown} rawValue
 * @returns {Array<any>}
 */
export function normalizeSceneLevels(rawValue) {
  if (Array.isArray(rawValue)) return rawValue;

  if (typeof rawValue === 'string' && rawValue.trim()) {
    try {
      return normalizeSceneLevels(JSON.parse(rawValue));
    } catch (_) {
      return [];
    }
  }

  if (!rawValue || typeof rawValue !== 'object') return [];

  if (Array.isArray(rawValue.levels)) {
    return rawValue.levels;
  }

  // Accept object-map payloads from imports where numeric keys map to level entries.
  const keys = Object.keys(rawValue);
  if (!keys.length) return [];

  const allNumeric = keys.every((k) => /^\d+$/.test(k));
  if (!allNumeric) return [];

  return keys
    .map((k) => [Number(k), rawValue[k]])
    .sort((a, b) => a[0] - b[0])
    .map(([, value]) => value);
}

/**
 * Read Levels sceneLevels data from a scene with getFlag-first semantics.
 *
 * @param {Scene|null|undefined} scene
 * @returns {Array<any>}
 */
export function readSceneLevelsFlag(scene) {
  if (getLevelsCompatibilityMode() === LEVELS_COMPATIBILITY_MODES.OFF) return [];

  // getFlag throws when the 'levels' module scope isn't registered (module
  // not installed or not active). Fall back to direct flag access which
  // always works regardless of module activation state.
  let viaGetter;
  try {
    viaGetter = scene?.getFlag?.('levels', 'sceneLevels');
  } catch (_) {
    // Scope not active — expected when Levels module is absent.
  }
  const direct = scene?.flags?.levels?.sceneLevels;
  return normalizeSceneLevels(viaGetter ?? direct);
}

/**
 * Determine whether a scene should be considered Levels-enabled for MapShine UX.
 *
 * @param {Scene|null|undefined} scene
 * @returns {boolean}
 */
export function isLevelsEnabledForScene(scene) {
  if (getLevelsCompatibilityMode() === LEVELS_COMPATIBILITY_MODES.OFF) return false;
  if (!scene) return false;
  if (scene?.flags?.levels?.enabled === true) return true;
  if (readSceneLevelsFlag(scene).length > 0) return true;

  // Detect scenes that have Levels data on individual documents (tiles, walls,
  // lights) but no explicit sceneLevels bands. This catches maps that were
  // configured with the Levels module but never had bands formally defined —
  // for example, a compendium scene with tile/wall elevation ranges set.
  const levelsFlags = scene?.flags?.levels;
  if (levelsFlags) {
    // Scene-level flags like backgroundElevation or lightMasking indicate setup
    if (levelsFlags.backgroundElevation !== undefined && levelsFlags.backgroundElevation !== 0) return true;
    if (levelsFlags.weatherElevation !== undefined) return true;
    if (levelsFlags.lightMasking !== undefined) return true;
  }

  // Check tiles for any Levels range flags
  const tiles = scene.tiles ?? scene.collections?.tiles;
  if (tiles) {
    for (const tileDoc of tiles) {
      if (tileDoc?.flags?.levels?.rangeTop !== undefined) return true;
      if (tileDoc?.flags?.levels?.isBasement === true) return true;
      if (tileDoc?.flags?.levels?.showIfAbove === true) return true;
    }
  }

  // Check walls for wall-height flags (Levels companion module)
  const walls = scene.walls ?? scene.collections?.walls;
  if (walls) {
    for (const wallDoc of walls) {
      const wh = wallDoc?.flags?.['wall-height'];
      if (wh && (wh.bottom !== undefined || wh.top !== undefined)) return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
//  Scene-level flag readers (MS-LVL-011)
// ---------------------------------------------------------------------------

/**
 * Read the Levels backgroundElevation from a scene.
 * This is the elevation of the ground/background layer in Levels worlds.
 *
 * @param {Scene|null|undefined} scene
 * @returns {number}
 */
export function getSceneBackgroundElevation(scene) {
  if (getLevelsCompatibilityMode() === LEVELS_COMPATIBILITY_MODES.OFF) return 0;
  const raw = scene?.flags?.levels?.backgroundElevation;
  const num = Number(raw);
  return Number.isFinite(num) ? num : 0;
}

/**
 * Read the Levels weatherElevation from a scene.
 *
 * @param {Scene|null|undefined} scene
 * @returns {number|null} null if not set
 */
export function getSceneWeatherElevation(scene) {
  if (getLevelsCompatibilityMode() === LEVELS_COMPATIBILITY_MODES.OFF) return null;
  const raw = scene?.flags?.levels?.weatherElevation;
  if (raw === undefined || raw === null) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

/**
 * Read the Levels lightMasking flag from a scene.
 *
 * @param {Scene|null|undefined} scene
 * @returns {boolean}
 */
export function getSceneLightMasking(scene) {
  if (getLevelsCompatibilityMode() === LEVELS_COMPATIBILITY_MODES.OFF) return false;
  return scene?.flags?.levels?.lightMasking === true;
}

// ---------------------------------------------------------------------------
//  Tile flag readers (MS-LVL-012)
// ---------------------------------------------------------------------------

/**
 * Default values for Levels tile flags.
 * These match the Levels module's own defaults in tileHandler.js.
 * @type {Readonly<LevelsTileFlags>}
 */
export const LEVELS_TILE_FLAG_DEFAULTS = Object.freeze({
  rangeTop: Infinity,
  showIfAbove: false,
  showAboveRange: Infinity,
  isBasement: false,
  noCollision: false,
  noFogHide: false,
  allWallBlockSight: false,
  excludeFromChecker: false,
});

/**
 * @typedef {object} LevelsTileFlags
 * @property {number} rangeBottom  - Bottom of the tile's elevation range (same as tileDoc.elevation).
 * @property {number} rangeTop     - Top of the tile's elevation range.
 * @property {boolean} showIfAbove - Whether the tile remains visible when the viewer is above its range.
 * @property {number} showAboveRange - Maximum distance above rangeBottom where showIfAbove still applies.
 * @property {boolean} isBasement  - Whether the tile is a basement (only visible when viewer is in range).
 * @property {boolean} noCollision - Whether the tile is excluded from elevation collision tests.
 * @property {boolean} noFogHide   - Whether the tile suppresses fog-of-war masking.
 * @property {boolean} allWallBlockSight - Whether all walls on this tile block sight regardless of type.
 * @property {boolean} excludeFromChecker - Whether this tile is excluded from the Levels checker.
 */

/**
 * Read and normalize Levels flags from a tile document.
 *
 * When compatibility mode is 'off' or the tile has no Levels flags, returns
 * defaults that make the tile behave as a standard Foundry tile (infinite
 * range, no special behavior).
 *
 * The `rangeBottom` is always derived from `tileDoc.elevation` to match
 * Levels' own behavior in tileHandler.js `getFlags()`.
 *
 * @param {TileDocument|object|null|undefined} tileDoc
 * @returns {LevelsTileFlags}
 */
export function readTileLevelsFlags(tileDoc) {
  const elevation = Number(tileDoc?.elevation ?? tileDoc?.document?.elevation ?? 0);
  const safeElevation = Number.isFinite(elevation) ? elevation : 0;

  const defaults = {
    ...LEVELS_TILE_FLAG_DEFAULTS,
    rangeBottom: safeElevation,
  };

  if (getLevelsCompatibilityMode() === LEVELS_COMPATIBILITY_MODES.OFF) return defaults;
  if (!tileDoc?.flags?.levels) return defaults;

  const flags = tileDoc.flags.levels;

  const docId = tileDoc?.id ?? tileDoc?._id;

  // rangeTop: number or Infinity
  let rangeTop = LEVELS_TILE_FLAG_DEFAULTS.rangeTop;
  if (flags.rangeTop !== undefined && flags.rangeTop !== null) {
    const n = Number(flags.rangeTop);
    if (Number.isFinite(n)) {
      rangeTop = n;
    } else if (flags.rangeTop !== Infinity && flags.rangeTop !== -Infinity) {
      // Non-numeric junk — record diagnostic and keep default
      _recordFlagDiagnostic('readTileLevelsFlags', 'rangeTop', flags.rangeTop, rangeTop, docId);
    }
  }

  // showAboveRange: number or Infinity
  let showAboveRange = LEVELS_TILE_FLAG_DEFAULTS.showAboveRange;
  if (flags.showAboveRange !== undefined && flags.showAboveRange !== null) {
    const n = Number(flags.showAboveRange);
    if (Number.isFinite(n)) {
      showAboveRange = n;
    } else if (flags.showAboveRange !== Infinity && flags.showAboveRange !== -Infinity) {
      _recordFlagDiagnostic('readTileLevelsFlags', 'showAboveRange', flags.showAboveRange, showAboveRange, docId);
    }
  }

  // rangeBottom: prefer explicit Levels flag if present; otherwise fall back to
  // the core elevation property (Levels V12+ migration path).
  let rangeBottom = safeElevation;
  if (flags.rangeBottom !== undefined && flags.rangeBottom !== null) {
    const n = Number(flags.rangeBottom);
    if (Number.isFinite(n)) {
      rangeBottom = n;
    } else if (flags.rangeBottom !== Infinity && flags.rangeBottom !== -Infinity) {
      _recordFlagDiagnostic('readTileLevelsFlags', 'rangeBottom', flags.rangeBottom, rangeBottom, docId);
    }
  }

  return {
    rangeBottom,
    rangeTop,
    showIfAbove: flags.showIfAbove === true,
    showAboveRange,
    isBasement: flags.isBasement === true,
    noCollision: flags.noCollision === true,
    noFogHide: flags.noFogHide === true,
    allWallBlockSight: flags.allWallBlockSight === true,
    excludeFromChecker: flags.excludeFromChecker === true,
  };
}

/**
 * Check whether a tile document has any meaningful Levels range flags
 * (i.e., is not just using defaults).
 *
 * @param {TileDocument|object|null|undefined} tileDoc
 * @returns {boolean}
 */
export function tileHasLevelsRange(tileDoc) {
  if (getLevelsCompatibilityMode() === LEVELS_COMPATIBILITY_MODES.OFF) return false;
  if (!tileDoc?.flags?.levels) return false;
  const flags = tileDoc.flags.levels;
  // Levels V12+ may store the authoritative bottom elevation in rangeBottom
  // while leaving rangeTop unset (implicitly Infinity). Treat rangeBottom as
  // a meaningful signal that this tile participates in Levels range logic.
  if (flags.rangeBottom !== undefined && flags.rangeBottom !== null) return true;
  // A tile has a meaningful range if rangeTop is set to something other than
  // the default Infinity (Levels only writes rangeTop when configured).
  if (flags.rangeTop !== undefined && flags.rangeTop !== null) return true;
  if (flags.isBasement === true) return true;
  if (flags.showIfAbove === true) return true;
  return false;
}

// ---------------------------------------------------------------------------
//  Generic doc range flag readers (MS-LVL-013)
// ---------------------------------------------------------------------------

/**
 * Read Levels rangeBottom/rangeTop from a generic document (light, sound,
 * note, drawing, template).
 *
 * @param {object|null|undefined} doc - Any Foundry document with flags.levels
 * @returns {{rangeBottom: number, rangeTop: number}}
 */
export function readDocLevelsRange(doc) {
  const defaults = { rangeBottom: -Infinity, rangeTop: Infinity };
  if (getLevelsCompatibilityMode() === LEVELS_COMPATIBILITY_MODES.OFF) return defaults;
  if (!doc?.flags?.levels) return defaults;

  const flags = doc.flags.levels;
  let rangeBottom = -Infinity;
  let rangeTop = Infinity;

  const docId = doc?.id ?? doc?._id;

  if (flags.rangeBottom !== undefined && flags.rangeBottom !== null) {
    const n = Number(flags.rangeBottom);
    if (Number.isFinite(n)) {
      rangeBottom = n;
    } else if (flags.rangeBottom !== Infinity && flags.rangeBottom !== -Infinity) {
      _recordFlagDiagnostic('readDocLevelsRange', 'rangeBottom', flags.rangeBottom, rangeBottom, docId);
    }
  } else {
    // Levels V12+ migrates flags.levels.rangeBottom to doc.elevation.
    // After migration, rangeBottom is deleted from flags and the authoritative
    // value lives on the core elevation property. Fall back to doc.elevation
    // to match Levels' own getRangeForDocument() / inRange() semantics.
    const docElev = Number(doc.elevation ?? NaN);
    if (Number.isFinite(docElev)) {
      rangeBottom = docElev;
    }
  }
  if (flags.rangeTop !== undefined && flags.rangeTop !== null) {
    const n = Number(flags.rangeTop);
    if (Number.isFinite(n)) {
      rangeTop = n;
    } else if (flags.rangeTop !== Infinity && flags.rangeTop !== -Infinity) {
      _recordFlagDiagnostic('readDocLevelsRange', 'rangeTop', flags.rangeTop, rangeTop, docId);
    }
  }

  return { rangeBottom, rangeTop };
}

// ---------------------------------------------------------------------------
//  Wall-height flag readers (MS-LVL-014)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} WallHeightFlags
 * @property {number} bottom - Bottom of the wall's vertical extent.
 * @property {number} top    - Top of the wall's vertical extent.
 */

/**
 * Read wall-height flags from a wall document.
 *
 * The wall-height module stores vertical bounds on `flags['wall-height']`.
 * Defaults represent a full-height wall (extends from -Infinity to Infinity).
 *
 * @param {WallDocument|object|null|undefined} wallDoc
 * @returns {WallHeightFlags}
 */
export function readWallHeightFlags(wallDoc) {
  const defaults = { bottom: -Infinity, top: Infinity };

  // IMPORTANT: wall-height must remain authoritative even when Levels
  // compatibility mode is OFF so floor-scoped walls don't regress into
  // full-height blockers across all levels.
  const flags = wallDoc?.flags?.['wall-height']
    ?? wallDoc?.document?.flags?.['wall-height'];
  if (!flags) return defaults;

  let bottom = -Infinity;
  let top = Infinity;

  const docId = wallDoc?.id ?? wallDoc?._id;

  if (flags.bottom !== undefined && flags.bottom !== null) {
    const n = Number(flags.bottom);
    if (Number.isFinite(n)) {
      bottom = n;
    } else if (flags.bottom !== Infinity && flags.bottom !== -Infinity) {
      _recordFlagDiagnostic('readWallHeightFlags', 'bottom', flags.bottom, bottom, docId);
    }
  }
  if (flags.top !== undefined && flags.top !== null) {
    const n = Number(flags.top);
    if (Number.isFinite(n)) {
      top = n;
    } else if (flags.top !== Infinity && flags.top !== -Infinity) {
      _recordFlagDiagnostic('readWallHeightFlags', 'top', flags.top, top, docId);
    }
  }

  return { bottom, top };
}

/**
 * Check whether a wall document has wall-height bounds that differ from
 * the full-height default (i.e., the wall has a finite vertical extent).
 *
 * @param {WallDocument|object|null|undefined} wallDoc
 * @returns {boolean}
 */
export function wallHasHeightBounds(wallDoc) {
  const flags = wallDoc?.flags?.['wall-height']
    ?? wallDoc?.document?.flags?.['wall-height'];
  if (!flags) return false;
  if (flags.bottom !== undefined && flags.bottom !== null) {
    const n = Number(flags.bottom);
    if (Number.isFinite(n)) return true;
  }
  if (flags.top !== undefined && flags.top !== null) {
    const n = Number(flags.top);
    if (Number.isFinite(n)) return true;
  }
  return false;
}
