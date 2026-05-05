/**
 * @fileoverview Helpers for reading scene level data.
 *
 * V14-native path: reads directly from `scene.levels` (EmbeddedCollection of
 * Level documents). Legacy flag readers are retained as migration/fallback
 * helpers only and are no longer authoritative at runtime.
 */

// ---------------------------------------------------------------------------
//  V14-native scene level readers
// ---------------------------------------------------------------------------

/**
 * @typedef {object} V14LevelBand
 * @property {string} levelId       - Native Level document ID
 * @property {number} index         - Level sort index assigned during scene prep
 * @property {string} label         - Display name
 * @property {number} bottom        - Elevation band bottom (grid units, may be -Infinity)
 * @property {number} top           - Elevation band top (grid units, may be Infinity)
 * @property {number} center        - Midpoint (or base elevation when bounds are infinite)
 * @property {boolean} isView       - Currently viewed level
 * @property {boolean} isVisible    - Visible in current view stack
 * @property {'v14-native'} source  - Always 'v14-native'
 */

/**
 * Read V14 native Level documents from a scene and return them as Map Shine
 * band objects. This is the primary floor authority for V14-only builds.
 *
 * @param {Scene|null|undefined} scene
 * @returns {V14LevelBand[]}
 */
export function readV14SceneLevels(scene) {
  if (!scene?.levels?.size) return [];
  const sorted = scene.levels.sorted;
  if (!sorted?.length) return [];

  return sorted.map((level) => {
    const bottom = level.elevation?.bottom ?? -Infinity;
    const top = level.elevation?.top ?? Infinity;
    const finiteBottom = Number.isFinite(bottom) ? bottom : 0;
    const finiteTop = Number.isFinite(top) ? top : finiteBottom;
    const center = (finiteBottom + finiteTop) * 0.5;
    return {
      levelId: level.id,
      index: level.index ?? 0,
      label: level.name || `Level ${(level.index ?? 0) + 1}`,
      bottom,
      top,
      center,
      isView: !!level.isView,
      isVisible: !!level.isVisible,
      source: 'v14-native',
    };
  });
}

/**
 * Check whether a scene has V14 native levels configured.
 * @param {Scene|null|undefined} scene
 * @returns {boolean}
 */
export function hasV14NativeLevels(scene) {
  return (scene?.levels?.size ?? 0) > 0;
}

/**
 * Strip query/hash for stable asset URL comparison (Foundry / CDN may append tokens).
 * @param {string} s
 * @returns {string}
 */
export function normalizeFoundryAssetUrlKey(s) {
  if (!s || typeof s !== 'string') return '';
  try {
    const u = new URL(s, globalThis.location?.origin || 'http://localhost');
    let p = `${u.pathname || ''}`.toLowerCase();
    const q = u.searchParams;
    const v = q.get('v');
    if (v) p += `?v=${v}`;
    return p;
  } catch (_) {
    return s.split('?')[0].split('#')[0].trim().toLowerCase();
  }
}

/**
 * Resolve the current viewed level document from authoritative Foundry signals.
 * Priority:
 * 1) `canvas.level.id` — Level the canvas is **actually rendering** (authoritative on cold load;
 *    `scene._view` can still point at the previous band until Foundry commits the redraw).
 * 2) `scene._view` — persisted Scene document field once committed.
 * 3) `canvas._viewOptions.level` — pending same-scene redraw target; can disagree with `canvas.level`
 *    during transitions, so keep it after live `canvas.level`.
 * 4) native `isView` flags as a last resort.
 *
 * @param {Scene|null|undefined} scene
 * @returns {any|null}
 */
function _resolveViewedV14LevelDoc(scene) {
  if (!scene?.levels?.size) return null;

  const tried = new Set();
  const tryLevelId = (levelId) => {
    const id = typeof levelId === 'string' ? levelId.trim() : '';
    if (!id || tried.has(id)) return null;
    tried.add(id);
    try {
      return scene.levels.get(id) ?? null;
    } catch (_) {
      return null;
    }
  };

  let level = null;

  try {
    level = tryLevelId(globalThis.canvas?.level?.id);
    if (level) return level;
  } catch (_) {}

  level = tryLevelId(scene?._view);
  if (level) return level;

  try {
    level = tryLevelId(globalThis.canvas?._viewOptions?.level);
    if (level) return level;
  } catch (_) {}

  try {
    const sorted = scene.levels.sorted;
    if (sorted?.length) return sorted.find((l) => l?.isView) ?? null;
  } catch (_) {}

  return null;
}

/**
 * Get the currently viewed V14 Level document for a scene.
 * @param {Scene|null|undefined} scene
 * @returns {{levelId:string, index:number, label:string, bottom:number, top:number, center:number}|null}
 */
export function getViewedV14Level(scene) {
  const level = _resolveViewedV14LevelDoc(scene);
  if (!level) return null;
  const bottom = level.elevation?.bottom ?? -Infinity;
  const top = level.elevation?.top ?? Infinity;
  const finiteBottom = Number.isFinite(bottom) ? bottom : 0;
  const finiteTop = Number.isFinite(top) ? top : finiteBottom;
  return {
    levelId: level.id,
    index: level.index ?? 0,
    label: level.name || `Level ${(level.index ?? 0) + 1}`,
    bottom,
    top,
    center: (finiteBottom + finiteTop) * 0.5,
  };
}

/**
 * Get the currently viewed level's background image src.
 * In V14 each Level document has its own `background.src`. This is the
 * authoritative source for per-level art — `scene.background.src` is
 * deprecated and always returns the first level's background.
 *
 * Falls back to the deprecated `scene.background.src` when the viewed level
 * has no background image (e.g. a level that only modifies elevation).
 *
 * @param {Scene|null|undefined} scene
 * @returns {string|null}
 */
export function getViewedLevelBackgroundSrc(scene) {
  if (!scene) return null;
  // Same source Foundry uses for `canvas.primary.background`: the active Level doc.
  // Prefer this over re-resolving from scene.levels during init races.
  try {
    const cv = globalThis.canvas;
    if (cv?.scene?.id === scene.id && hasV14NativeLevels(scene)) {
      const direct = cv.level?.background?.src;
      if (typeof direct === 'string' && direct.trim()) return direct.trim();
    }
  } catch (_) {}
  try {
    const level = _resolveViewedV14LevelDoc(scene);
    const src = level?.background?.src;
    if (typeof src === 'string' && src.trim()) return src.trim();
  } catch (_) {}
  // Deprecated fallback for scenes without per-level backgrounds
  try {
    const bg = scene.background?.src ?? scene.img;
    if (typeof bg === 'string' && bg.trim()) return bg.trim();
  } catch (_) {}
  return null;
}

/**
 * Get ordered background sources for currently visible V14 levels.
 *
 * Uses Foundry's internal scene texture configuration path so visibility rules
 * match native rendering behavior (viewed level + visible related levels).
 *
 * Returned order is bottom-to-top according to Foundry's level sort.
 *
 * @param {Scene|null|undefined} scene
 * @returns {string[]}
 */
export function getVisibleLevelBackgroundSrcs(scene) {
  if (!scene) return [];
  const out = [];
  const seen = new Set();

  try {
    // Foundry core helper used by TextureLoader.loadSceneTextures.
    const configured = (typeof scene._configureLevelTextures === 'function')
      ? scene._configureLevelTextures()
      : [];
    for (const entry of configured) {
      if (!entry || entry.name !== 'background') continue;
      const src = String(entry.src || '').trim();
      if (!src || seen.has(src)) continue;
      seen.add(src);
      out.push(src);
    }
  } catch (_) {}

  if (out.length) return out;

  // Fallback: at least return the active viewed level background.
  const viewed = getViewedLevelBackgroundSrc(scene);
  if (viewed) out.push(viewed);
  return out;
}

/**
 * Map a background image URL to the native V14 level {@link foundry.documents.BaseLevel#index}
 * whose `background.src` matches (after {@link normalizeFoundryAssetUrlKey}).
 * Used when Foundry's texture stack lists only the viewed level so array position
 * is not a reliable floor index for FloorRenderBus / per-floor albedo.
 *
 * @param {Scene|null|undefined} scene
 * @param {string} src
 * @returns {number} Non-negative floor index (defaults to 0 if unmatched)
 */
export function resolveV14BackgroundFloorIndexForSrc(scene, src) {
  const raw = typeof src === 'string' ? src.trim() : '';
  if (!raw || !scene?.levels?.size) return 0;
  const target = normalizeFoundryAssetUrlKey(raw);
  const targetFile = (() => {
    try {
      const tail = (target.split('/').pop() || '').split('?')[0] || '';
      return tail.toLowerCase();
    } catch (_) {
      return '';
    }
  })();
  if (!target && !targetFile) return 0;
  try {
    const sorted = scene.levels.sorted ?? scene.levels.contents ?? [];
    for (const level of sorted) {
      const bg = String(level?.background?.src || '').trim();
      if (!bg) continue;
      if (target && normalizeFoundryAssetUrlKey(bg) === target) {
        const idx = Number(level?.index);
        return Number.isFinite(idx) ? Math.max(0, Math.floor(idx)) : 0;
      }
    }
    if (targetFile) {
      for (const level of sorted) {
        const bg = String(level?.background?.src || '').trim();
        if (!bg) continue;
        let f = '';
        try {
          const k = normalizeFoundryAssetUrlKey(bg);
          f = (k.split('/').pop() || '').split('?')[0].toLowerCase();
        } catch (_) { f = ''; }
        if (f && f === targetFile) {
          const idx = Number(level?.index);
          return Number.isFinite(idx) ? Math.max(0, Math.floor(idx)) : 0;
        }
      }
    }
  } catch (_) {}
  return 0;
}

/**
 * Get ordered visible background layer metadata from Foundry's level config.
 *
 * @param {Scene|null|undefined} scene
 * @returns {Array<{src:string, alphaThreshold:number, sort?: number}>}
 *   `sort` is passed through from Foundry when present; do not use it as the
 *   floor index for bus placement (it reflects texture stack order).
 */
export function getVisibleLevelBackgroundLayers(scene) {
  if (!scene) return [];
  /** @type {Array<{src:string, alphaThreshold:number, sort?: number}>} */
  const out = [];
  try {
    const configured = (typeof scene._configureLevelTextures === 'function')
      ? scene._configureLevelTextures()
      : [];
    for (const entry of configured) {
      if (!entry || entry.name !== 'background') continue;
      const src = String(entry.src || '').trim();
      if (!src) continue;
      const rawThreshold = Number(entry.alphaThreshold);
      const alphaThreshold = Number.isFinite(rawThreshold)
        ? Math.max(0, Math.min(1, rawThreshold))
        : 0;
      const rawSort = Number(entry.sort);
      const sort = Number.isFinite(rawSort) ? Math.max(0, Math.floor(rawSort)) : undefined;
      const row = { src, alphaThreshold };
      if (sort !== undefined) row.sort = sort;
      out.push(row);
    }
  } catch (_) {}
  if (out.length) return out;
  const viewed = getViewedLevelBackgroundSrc(scene);
  if (viewed) {
    try {
      const level = _resolveViewedV14LevelDoc(scene);
      const idx = Number(level?.index);
      const sort = Number.isFinite(idx) ? Math.max(0, Math.floor(idx)) : 0;
      out.push({ src: viewed, alphaThreshold: 0, sort });
    } catch (_) {
      out.push({ src: viewed, alphaThreshold: 0 });
    }
  }
  return out;
}

/**
 * Get ordered visible foreground layer metadata from Foundry's level config.
 *
 * Returned order follows Foundry level sort (bottom-to-top). Each entry includes
 * the source image and the originating level sort index so floor-aware render
 * passes can correctly include/exclude per-floor foreground planes.
 *
 * @param {Scene|null|undefined} scene
 * @returns {Array<{src:string, sort:number}>}
 */
export function getVisibleLevelForegroundLayers(scene) {
  if (!scene) return [];
  /** @type {Array<{src:string, sort:number}>} */
  const out = [];
  try {
    const configured = (typeof scene._configureLevelTextures === 'function')
      ? scene._configureLevelTextures()
      : [];
    for (const entry of configured) {
      if (!entry || entry.name !== 'foreground') continue;
      const src = String(entry.src || '').trim();
      if (!src) continue;
      const sortRaw = Number(entry.sort);
      const sort = Number.isFinite(sortRaw) ? Math.max(0, Math.floor(sortRaw)) : out.length;
      out.push({ src, sort });
    }
  } catch (_) {}
  if (out.length) return out;
  try {
    const level = _resolveViewedV14LevelDoc(scene);
    const src = String(level?.foreground?.src || '').trim();
    if (src) out.push({ src, sort: Number(level?.index) || 0 });
  } catch (_) {}
  return out;
}

/**
 * Whether a canvas document is assigned to a V14 level via its native
 * {@link foundry.documents.BaseCanvasDocument#levels} set only.
 *
 * Empty `levels` means the document is global (treated as on every level).
 * Use this for floor bucketing and compositor membership — not for
 * {@link foundry.documents.TokenDocument#includedInLevel}, which encodes
 * scene visibility between levels rather than set membership.
 *
 * @param {foundry.documents.BaseCanvasDocument|object} doc
 * @param {string} levelId
 * @returns {boolean}
 */
export function isDocMemberOfV14LevelSet(doc, levelId) {
  const docObj = doc?.document ?? doc;
  if (!docObj || !levelId) return true;

  // V14 tokens use `doc.level` (singular DocumentIdField) — the one level the
  // token is on — rather than a `levels` Set.  Check it first so tokens are
  // never treated as "global" just because their Set is empty/absent.
  const singleLevel = docObj.level ?? docObj._source?.level;
  if (typeof singleLevel === 'string' && singleLevel.length > 0) {
    return singleLevel === levelId;
  }

  const levelsSet = docObj.levels;
  if (!levelsSet || levelsSet.size === 0) return true;
  return levelsSet.has(levelId);
}

/**
 * Test whether a wall document is included in a specific V14 level.
 * Empty `levels` set means the wall is global (included in all levels).
 * @param {WallDocument|object} wallDoc
 * @param {string} levelId
 * @returns {boolean}
 */
export function isWallOnV14Level(wallDoc, levelId) {
  return isDocMemberOfV14LevelSet(wallDoc, levelId);
}

/**
 * Test whether any canvas document is included in a specific V14 level for
 * **view / visibility** semantics (delegates to {@link TokenDocument#includedInLevel}
 * when present). For **floor stack assignment**, prefer
 * {@link isDocMemberOfV14LevelSet} so tokens use their `levels` set, not the
 * visibility graph.
 * @param {object} doc
 * @param {string} levelId
 * @returns {boolean}
 */
export function isDocOnV14Level(doc, levelId) {
  if (typeof doc?.includedInLevel === 'function') {
    return doc.includedInLevel(levelId);
  }
  const docObj = doc?.document ?? doc;
  if (!docObj || !levelId) return true;
  const levelsSet = docObj.levels;
  if (!levelsSet || levelsSet.size === 0) return true;
  return levelsSet.has(levelId);
}

/**
 * Lowest FloorStack band index (0-based) for a placeable document using V14
 * native {@link foundry.documents.BaseCanvasDocument#levels} membership.
 * Bands must be ordered bottom-to-top the same way as {@link readV14SceneLevels}
 * after sorting by finite bottom (matches {@link FloorStack#rebuildFloors}).
 *
 * - Empty / missing native `levels` on the doc → `null` (caller falls back to
 *   legacy Levels range flags and/or elevation).
 * - Non-V14 scene → `null`.
 *
 * @param {foundry.documents.BaseDocument|object|null|undefined} doc
 * @param {Scene|null|undefined} [scene=globalThis.canvas?.scene]
 * @returns {number|null}
 */
export function resolveV14NativeDocFloorIndexMin(doc, scene = globalThis.canvas?.scene) {
  if (!hasV14NativeLevels(scene)) return null;
  const docObj = doc?.document ?? doc;
  if (!docObj) return null;

  // Tokens: singular `level` field (DocumentIdField)
  const singleLevel = docObj.level ?? docObj._source?.level;
  const hasLevelSingular = typeof singleLevel === 'string' && singleLevel.length > 0;

  // Tiles/walls/etc.: `levels` Set (SceneLevelsSetField)
  const levelsSet = docObj.levels;
  const hasLevelsSet = levelsSet && levelsSet.size > 0;

  if (!hasLevelSingular && !hasLevelsSet) return null;

  const sorted = [...readV14SceneLevels(scene)].sort((a, b) => {
    const ab = Number(a.bottom);
    const bb = Number(b.bottom);
    const fa = Number.isFinite(ab) ? ab : 0;
    const fb = Number.isFinite(bb) ? bb : 0;
    return fa - fb;
  });
  if (!sorted.length) return null;

  // Fast path for tokens: direct level-id match against sorted bands.
  if (hasLevelSingular) {
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i]?.levelId === singleLevel) return i;
    }
    return null;
  }

  let best = Infinity;
  for (let i = 0; i < sorted.length; i++) {
    const lid = sorted[i]?.levelId;
    if (!lid) continue;
    if (isDocMemberOfV14LevelSet(docObj, lid) && i < best) best = i;
  }
  return Number.isFinite(best) ? best : null;
}

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
  // Legacy reader is retained strictly for import tooling; runtime is V14-native.
  return normalizeSceneLevels(scene?.flags?.levels?.sceneLevels);
}

/**
 * Determine whether a scene should be considered Levels-enabled for MapShine UX.
 *
 * @param {Scene|null|undefined} scene
 * @returns {boolean}
 */
export function isLevelsEnabledForScene(scene) {
  return hasV14NativeLevels(scene);
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
  const level = scene?.levels?.get?.(scene?._view) ?? null;
  return Number(level?.elevation?.bottom ?? 0) || 0;
}

/**
 * Top of the scene foreground image band (active level {@link Level#elevation.top}).
 * When unset, the foreground layer is treated as unbounded above (same as Infinity).
 *
 * @param {Scene|null|undefined} scene
 * @returns {number} Finite top, or Infinity when not set
 */
export function getSceneForegroundElevationTop(scene) {
  const level = scene?.levels?.get?.(scene?._view) ?? null;
  const top = Number(level?.elevation?.top);
  return Number.isFinite(top) ? top : Infinity;
}

/**
 * Foreground/overhead elevation split for the currently viewed level (Foundry v14+).
 * Use instead of deprecated {@link Scene#foregroundElevation}. Matches the legacy
 * coercion used by tile overhead checks: non-finite top (undefined / Infinity) → 0.
 *
 * @returns {number}
 */
export function getCanvasForegroundElevationSplit() {
  try {
    const top = Number(canvas?.level?.elevation?.top);
    return Number.isFinite(top) ? top : 0;
  } catch (_) {
    return 0;
  }
}

/**
 * Read the Levels weatherElevation from a scene.
 *
 * @param {Scene|null|undefined} scene
 * @returns {number|null} null if not set
 */
export function getSceneWeatherElevation(scene) {
  const level = scene?.levels?.get?.(scene?._view) ?? null;
  const top = Number(level?.elevation?.top);
  return Number.isFinite(top) ? top : null;
}

/**
 * Read the Levels lightMasking flag from a scene.
 *
 * @param {Scene|null|undefined} scene
 * @returns {boolean}
 */
export function getSceneLightMasking(scene) {
  return hasV14NativeLevels(scene);
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

/** Matches {@link foundry.documents.BaseScene.metadata.defaultLevelId} — embedded SetField value before real Level ids. */
const FOUNDRY_SCENE_DEFAULT_LEVEL_PLACEHOLDER_ID = 'defaultLevel0000';

/**
 * Expand Foundry placeholder level ids on AmbientLight docs to real Level document ids.
 * Lights may still store `defaultLevel0000` while `scene.levels` uses UUIDs.
 *
 * Multi-level scenes: `SceneDocument#initialLevel` is the configured “entry” level (often
 * ground), while `scene.levels.sorted[0]` is the **bottom** of the elevation stack in V14
 * (often a basement added before the placeholder was migrated). Ambiguous legacy lights
 * must match **either** so basement lights remain visible when `initialLevel` points elsewhere.
 *
 * @param {object|null|undefined} scene - Foundry Scene document (`canvas.scene`)
 * @param {string[]} ids - Collected level id strings from the light document
 * @returns {string[]}
 */
function expandFoundryDefaultLevelPlaceholderIds(scene, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return ids ?? [];
  const out = [];
  const seen = new Set();
  const pushResolved = (rid) => {
    if (rid == null) return;
    const rs = String(rid).trim();
    if (!rs || seen.has(rs)) return;
    out.push(rs);
    seen.add(rs);
  };
  for (const raw of ids) {
    const s = String(raw ?? '').trim();
    if (!s) continue;
    if (!seen.has(s)) {
      out.push(s);
      seen.add(s);
    }
    if (s !== FOUNDRY_SCENE_DEFAULT_LEVEL_PLACEHOLDER_ID) continue;
    try {
      const il = scene?.initialLevel;
      pushResolved(il?.id ?? il?._id);
    } catch (_) {}
    try {
      const sortedLevels = scene?.levels?.sorted;
      if (sortedLevels?.length) {
        const bottom = sortedLevels[0];
        pushResolved(bottom?.id ?? bottom?._id);
      }
    } catch (_) {}
  }
  return out;
}

/**
 * V14 level resolution for AmbientLight: whether the light applies to the current
 * view, and whether legacy elevation LOS masking should be skipped.
 *
 * When the light explicitly lists level ids (`doc.levels`, etc.) and one matches the
 * navigated/viewed level, `skipLegacyLosMasking` is true — Foundry scopes the light by
 * level, while `doc.elevation` / flags.rangeBottom may still be the legacy default (e.g.
 * 0). Applying `rangeBottom <= viewerLOS` after a level match would hide basement lights
 * for viewers with no token (perspective = active level center below ground).
 *
 * @param {object|null|undefined} doc - AmbientLight document or plain object
 * @param {object|null|undefined} scene - Foundry Scene document
 * @returns {{ ok: boolean, skipLegacyLosMasking: boolean }}
 */
export function getAmbientLightLevelGate(doc, scene) {
  const sorted = scene?.levels?.sorted;
  if (!Array.isArray(sorted) || sorted.length <= 1) {
    return { ok: true, skipLegacyLosMasking: false };
  }
  if (!doc) return { ok: true, skipLegacyLosMasking: false };

  const msCtx = (typeof window !== 'undefined' && window.MapShine?.activeLevelContext) || null;

  let levelIndex = Number(msCtx?.index);
  if (!Number.isFinite(levelIndex)) levelIndex = null;

  let Lv = (levelIndex != null && levelIndex >= 0 && levelIndex < sorted.length)
    ? sorted[levelIndex]
    : null;

  const ctxLevelId = msCtx?.levelId ?? null;
  let canvasLevelId = null;
  try {
    if (typeof globalThis !== 'undefined'
      && globalThis.canvas?.scene?.id === scene?.id) {
      canvasLevelId = globalThis.canvas?.level?.id ?? null;
    }
  } catch (_) {}

  const primaryId = ctxLevelId || canvasLevelId;

  if (!Lv && primaryId) {
    const idx = sorted.findIndex((l) => l?.id === primaryId || l?._id === primaryId);
    if (idx >= 0) {
      levelIndex = idx;
      Lv = sorted[idx];
    }
  }

  if (!Lv) {
    const viewed = getViewedV14Level(scene);
    if (viewed?.levelId) {
      const idx = sorted.findIndex((l) => l?.id === viewed.levelId || l?._id === viewed.levelId);
      if (idx >= 0) {
        levelIndex = idx;
        Lv = sorted[idx];
      } else if (Number.isFinite(viewed.index)) {
        levelIndex = viewed.index;
        Lv = sorted[levelIndex] ?? null;
      }
    }
  }

  if (!Lv) return { ok: true, skipLegacyLosMasking: false };

  const safeIdx = Number.isFinite(levelIndex) ? levelIndex : sorted.indexOf(Lv);
  const idxForNext = safeIdx >= 0 ? safeIdx : 0;

  const levelIdsTarget = new Set(
    [
      Lv?.id,
      Lv?._id,
      Lv?.uuid,
      Lv?.document?.id,
      Lv?.document?._id,
      Lv?.document?.uuid,
      safeIdx >= 0 ? safeIdx : null,
    ]
      .map((v) => (v == null ? '' : String(v).trim()))
      .filter(Boolean),
  );

  const readFinite = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const readBandBottom = (level) =>
    readFinite(
      level?.elevation?.bottom
      ?? (typeof level?.elevation === 'number' ? level.elevation : null)
      ?? level?.rangeBottom
      ?? level?.document?.elevation
      ?? level?.document?.rangeBottom
      ?? level?.document?.flags?.levels?.rangeBottom,
    );
  const readBandTop = (level, nextLevel) =>
    readFinite(
      level?.elevation?.top
      ?? level?.rangeTop
      ?? level?.top
      ?? level?.document?.rangeTop
      ?? level?.document?.top
      ?? level?.document?.flags?.levels?.rangeTop
      ?? readBandBottom(nextLevel),
    );
  const levelBottom = readBandBottom(Lv);
  const levelTop = readBandTop(Lv, sorted[idxForNext + 1]);

  const cfg = doc?.config && typeof doc.config === 'object' ? doc.config : {};
  const levelsSources = [
    doc.levels,
    doc?.light?.levels,
    doc?.document?.light?.levels,
    cfg.levels,
    cfg?.light?.levels,
    doc?.flags?.levels?.levels,
    doc?.flags?.levels?.inclusive,
  ];
  /** @type {string[]} */
  const arr = [];
  const pushId = (raw) => {
    if (raw == null) return;
    if (typeof raw === 'string' || typeof raw === 'number') {
      const s = String(raw).trim();
      if (s) arr.push(s);
      return;
    }
    if (typeof raw === 'object') {
      const id =
        raw?.id
        ?? raw?._id
        ?? raw?.document?.id
        ?? raw?.document?._id
        ?? null;
      if (id != null) {
        const s = String(id).trim();
        if (s) arr.push(s);
      }
    }
  };
  const pushFromShape = (src) => {
    if (!src) return;
    if (Array.isArray(src)) {
      for (const v of src) pushFromShape(v);
      return;
    }
    if (typeof src === 'string' || typeof src === 'number') {
      pushId(src);
      return;
    }
    if (src instanceof Set) {
      for (const v of src.values()) pushFromShape(v);
      return;
    }
    if (src instanceof Map) {
      for (const [k, v] of src.entries()) {
        pushFromShape(k);
        if (v === true || v === 1 || v === '1') pushFromShape(k);
        else pushFromShape(v);
      }
      return;
    }
    if (typeof src.forEach === 'function') {
      src.forEach((v) => pushFromShape(v));
      return;
    }
    if (typeof src === 'object') {
      for (const [k, v] of Object.entries(src)) {
        if (v === true || v === 1 || v === '1') pushId(k);
      }
      pushId(src);
    }
  };
  try {
    for (const src of levelsSources) {
      if (!src) continue;
      pushFromShape(src);
    }
  } catch (_) {}

  // Lights may list only `defaultLevel0000` (Scene.metadata.defaultLevelId) after migration from
  // single-level scenes. Expanding that to initialLevel + sorted[0] breaks as soon as the user
  // changes the scene default or views another floor — those ids are not "every legacy level".
  // Until authors pick real Level UUIDs in the light config, treat placeholder-only as unscoped.
  const trimmedLevelIds = arr.map((s) => String(s ?? '').trim()).filter(Boolean);
  const placeholderOnly = trimmedLevelIds.length > 0
    && trimmedLevelIds.every((s) => s === FOUNDRY_SCENE_DEFAULT_LEVEL_PLACEHOLDER_ID);
  if (placeholderOnly) {
    return { ok: true, skipLegacyLosMasking: true };
  }

  const arrForMatch = expandFoundryDefaultLevelPlaceholderIds(scene, arr);

  if (arrForMatch.length > 0 && levelIdsTarget.size > 0) {
    for (const id of arrForMatch) {
      if (levelIdsTarget.has(String(id))) {
        return { ok: true, skipLegacyLosMasking: true };
      }
    }
    return { ok: false, skipLegacyLosMasking: false };
  }

  const lightBottom = readFinite(doc?.elevation ?? doc?.flags?.levels?.rangeBottom);
  const lightTop = readFinite(doc?.flags?.levels?.rangeTop);
  if (lightBottom == null && lightTop == null) {
    return { ok: true, skipLegacyLosMasking: false };
  }

  const targetBottom = levelBottom ?? -Infinity;
  const targetTop = levelTop ?? Infinity;
  const sourceBottom = lightBottom ?? -Infinity;
  const sourceTop = lightTop ?? Infinity;
  const overlap = sourceBottom < targetTop && sourceTop >= targetBottom;
  return { ok: overlap, skipLegacyLosMasking: false };
}

/**
 * Whether an AmbientLight should contribute for the currently viewed / navigated level.
 * @param {object|null|undefined} doc
 * @param {object|null|undefined} scene
 * @returns {boolean}
 */
export function ambientLightVisibleForCurrentView(doc, scene) {
  return getAmbientLightLevelGate(doc, scene).ok;
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
  const docObj = wallDoc?.document ?? wallDoc;

  // IMPORTANT: wall-height must remain authoritative even when Levels
  // compatibility mode is OFF so floor-scoped walls don't regress into
  // full-height blockers across all levels.
  const wallHeightFlags = docObj?.flags?.['wall-height'];
  const levelsFlags = docObj?.flags?.levels;

  // Prefer wall-height module bounds when present. If absent, fall back to
  // Levels wall ranges so level-scoped walls are not treated as full-height.
  const flags = wallHeightFlags || levelsFlags;
  if (!flags) {
    // V14-native fallback: walls can be level-scoped via the built-in `levels`
    // set even when no legacy flags exist.
    const scene = docObj?.parent ?? canvas?.scene ?? null;
    if (hasV14NativeLevels(scene)) {
      const levelsSet = docObj?.levels;
      if (levelsSet?.size > 0) {
        let bottom = Infinity;
        let top = -Infinity;
        for (const levelId of levelsSet) {
          if (!levelId) continue;
          const level = scene?.levels?.get?.(levelId);
          if (!level) continue;
          const levelBottomRaw = Number(level?.elevation?.bottom);
          const levelTopRaw = Number(level?.elevation?.top);
          const levelBottom = Number.isFinite(levelBottomRaw) ? levelBottomRaw : -Infinity;
          const levelTop = Number.isFinite(levelTopRaw) ? levelTopRaw : Infinity;
          if (levelBottom < bottom) bottom = levelBottom;
          if (levelTop > top) top = levelTop;
        }
        if (Number.isFinite(bottom) || Number.isFinite(top)) {
          if (!Number.isFinite(bottom)) bottom = -Infinity;
          if (!Number.isFinite(top)) top = Infinity;
          return { bottom, top };
        }
      }
    }
    return defaults;
  }

  let bottom = -Infinity;
  let top = Infinity;

  const docId = wallDoc?.id ?? wallDoc?._id;

  const rawBottom = (flags.bottom !== undefined && flags.bottom !== null)
    ? flags.bottom
    : flags.rangeBottom;
  const rawTop = (flags.top !== undefined && flags.top !== null)
    ? flags.top
    : flags.rangeTop;

  if (rawBottom !== undefined && rawBottom !== null) {
    const n = Number(rawBottom);
    if (Number.isFinite(n)) {
      bottom = n;
    } else if (rawBottom !== Infinity && rawBottom !== -Infinity) {
      _recordFlagDiagnostic('readWallHeightFlags', 'bottom', rawBottom, bottom, docId);
    }
  }
  if (rawTop !== undefined && rawTop !== null) {
    const n = Number(rawTop);
    if (Number.isFinite(n)) {
      top = n;
    } else if (rawTop !== Infinity && rawTop !== -Infinity) {
      _recordFlagDiagnostic('readWallHeightFlags', 'top', rawTop, top, docId);
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
  const docObj = wallDoc?.document ?? wallDoc;
  const wallHeightFlags = docObj?.flags?.['wall-height'];
  const levelsFlags = docObj?.flags?.levels;
  const flags = wallHeightFlags || levelsFlags;
  if (!flags) {
    const scene = docObj?.parent ?? canvas?.scene ?? null;
    return !!(hasV14NativeLevels(scene) && docObj?.levels?.size > 0);
  }
  const rawBottom = (flags.bottom !== undefined && flags.bottom !== null)
    ? flags.bottom
    : flags.rangeBottom;
  const rawTop = (flags.top !== undefined && flags.top !== null)
    ? flags.top
    : flags.rangeTop;
  if (rawBottom !== undefined && rawBottom !== null) {
    const n = Number(rawBottom);
    if (Number.isFinite(n)) return true;
  }
  if (rawTop !== undefined && rawTop !== null) {
    const n = Number(rawTop);
    if (Number.isFinite(n)) return true;
  }
  return false;
}
