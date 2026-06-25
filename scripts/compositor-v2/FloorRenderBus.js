/**
 * @fileoverview FloorRenderBus — simple albedo-only tile renderer for V2.
 *
 * Milestone 1 design: dead simple, no intermediate render targets.
 *
 * Previous approach (ABANDONED — see planning doc Attempts 1-4):
 *   Copied textures from TileManager sprites into bus meshes. This was broken
 *   because TileManager's pipeline routes through canvas 2D drawImage(), which
 *   premultiplies alpha internally. Bus meshes used NormalBlending (straight
 *   alpha), so premultiplied data produced white halos and corrupted edges.
 *   Switching WebP→PNG changed the corruption shape, confirming the root cause.
 *
 * New approach (Attempt 5):
 *   1. Read tile documents directly from `canvas.scene.tiles.contents`.
 *   2. Load textures via `THREE.TextureLoader` — uses an HTML <img> element,
 *      which delivers straight-alpha data with no canvas 2D intermediary.
 *   3. One THREE.Scene. Tiles Z-ordered by floor index (floor 0 at Z=1000,
 *      floor 1 at Z=1001, etc.) so standard depth sorting handles layering.
 *   4. MeshBasicMaterial with transparent:true, NormalBlending — correct for
 *      straight-alpha textures rendered directly to the screen framebuffer.
 *   5. No intermediate RTs, no compositor shaders, no premultiplied conventions.
 *
 * @module compositor-v2/FloorRenderBus
 */

import { createLogger } from '../core/log.js';
import { loadImageTexture, normalizeTextureUrl } from '../assets/image-texture-loader.js';
import { applyTexturePolicy } from '../assets/texture-policies.js';
import { getTextureBudgetTracker, estimateTextureBytes, resolveTileAlbedoMaxSize } from '../assets/TextureBudgetTracker.js';
import { getTileStreamingManager } from '../streaming/tile-streaming-manager.js';
import { loadFallbackTexture, fetchSourceImageMeta } from '../streaming/texture-pyramid-builder.js';
import { isHugeImageSource } from '../streaming/probe-image-dimensions.js';
import { shouldStreamBackground } from '../streaming/streamed-background-grid.js';
import { reconfigureTextureBudgetForScene } from '../streaming/texture-budget-policy.js';
import { applySavedMemoryPresetsForScene } from '../streaming/memory-settings.js';
import { DOOR_FLOOR_INDEX_GLOBAL } from '../scene/DoorMeshManager.js';
import { TILE_FEATURE_LAYERS } from '../core/render-layers.js';
import {
  tileHasLevelsRange,
  readTileLevelsFlags,
  resolveV14NativeDocFloorIndexMin,
  resolveV14LevelIdToFloorStackIndex,
  getViewedLevelBackgroundSrc,
  getViewedLevelForegroundSrc,
  getVisibleLevelBackgroundSrcs,
  getVisibleLevelBackgroundLayers,
  getVisibleLevelForegroundLayers,
  hasV14NativeLevels,
  resolveV14BackgroundFloorIndexForSrc,
  resolveV14ForegroundFloorIndexForSrc,
  normalizeFoundryAssetUrlKey,
  getViewedV14Level,
  isLevelsEnabledForScene,
  getCanvasForegroundElevationSplit,
} from '../foundry/levels-scene-flags.js';
import { resolveFloorIndexForElevation } from '../ui/levels-editor/level-boundaries.js';
import {
  isTileOverhead,
  isTileElevatedOnActiveLevelBand,
  getTileVisualCenterFoundryXY,
  getTileBusPlaneSizeAndMirror,
  tileDocRestrictsLight,
  getTileOcclusionModeFlags,
  installBusMeshRadialOcclusionShader,
  applyRadialOcclusionUniformsToShader,
  applyFoundryOcclusionMaskBusUniforms,
} from '../scene/tile-manager.js';
import {
  RENDER_ORDER_PER_FLOOR,
  ROLE_OFFSETS,
  GROUND_Z,
  Z_PER_FLOOR,
  MAX_INTRA_ROLE_OFFSET,
  tileAlbedoOrder,
  tileOverheadOrder,
  effectUnderOverheadOrder,
  motionAboveTokensOrder,
  formatRenderOrder,
} from './LayerOrderPolicy.js';

/** High-sort albedo tiles (e.g. bridge decks) can sit below FLOOR_OVERHEAD but above splashes. */
const SPLASH_OCCLUDER_HIGH_ALBEDO_INTRA = MAX_INTRA_ROLE_OFFSET - 80;

const log = createLogger('FloorRenderBus');

/**
 * When {@link resolveV14BackgroundFloorIndexForSrc} returns 0 on early populate
 * (levels not hydrated) or floor stack not ready, pin the bus floor from the
 * viewed V14 level if the src matches {@link getViewedLevelBackgroundSrc}.
 * Does not override a non-zero resolve (avoids clobbering correct multi-layer rows).
 *
 * @param {any} scene
 * @param {string} src
 * @param {number} floorIdx
 * @param {{ loadCount: number, floorsLen: number, viewedBg: string, viewedLevelIndexOverride?: number|undefined }} ctx
 * @returns {number}
 */
function finalizeBackgroundFloorIndexForBus(scene, src, floorIdx, ctx) {
  let out = Number.isFinite(Number(floorIdx)) ? Number(floorIdx) : 0;
  const trimmed = String(src || '').trim();
  const viewedBg = String(ctx.viewedBg || '').trim();
  const nativeLevelCount = Number(scene?.levels?.size ?? 0);
  const multi = nativeLevelCount > 1 || ctx.floorsLen > 1;
  const normMatch = !!(
    trimmed
    && viewedBg
    && normalizeFoundryAssetUrlKey(viewedBg) === normalizeFoundryAssetUrlKey(trimmed)
  );
  const ovr = Number(ctx.viewedLevelIndexOverride);

  // `mapShineLevelContextChanged` passes the target level index before `canvas.level` / viewed-bg URL catch up.
  if (ctx.loadCount === 1 && multi && Number.isFinite(ovr)) {
    if (normMatch) return Math.max(0, Math.floor(ovr));
    // `_configureLevelTextures` can list the new src while getViewedLevelBackgroundSrc() still lags one frame.
    if (out === 0) return Math.max(0, Math.floor(ovr));
  }

  if (ctx.loadCount !== 1 || !normMatch || !multi) return out;
  // Trust non-zero resolve (multi-layer stack or hydrated levels).
  if (out !== 0) return out;
  try {
    if (globalThis.canvas?.scene?.id === scene?.id) {
      const levelId = globalThis.canvas?.level?.id;
      if (levelId) {
        const stackIdx = resolveV14LevelIdToFloorStackIndex(scene, levelId);
        if (stackIdx !== null) return stackIdx;
      }
    }
  } catch (_) {}
  const vl = getViewedV14Level(scene);
  if (vl?.levelId) {
    const stackIdx = resolveV14LevelIdToFloorStackIndex(scene, vl.levelId);
    if (stackIdx !== null) return stackIdx;
  }
  return out;
}

/** @param {number} floorIdx */
function backgroundBusKeyForFloorIndex(floorIdx) {
  const fi = Number.isFinite(Number(floorIdx)) ? Math.max(0, Math.floor(Number(floorIdx))) : 0;
  return fi === 0 ? '__bg_image__' : `__bg_image__${fi}`;
}

/** @param {number} floorIdx */
function foregroundBusKeyForFloorIndex(floorIdx) {
  const fi = Number.isFinite(Number(floorIdx)) ? Math.max(0, Math.floor(Number(floorIdx))) : 0;
  return fi === 0 ? '__fg_image__' : `__fg_image__${fi}`;
}

/**
 * True only for the bus overhead foreground plane keys (`__fg_image__`, `__fg_image__1`, …).
 * @param {string} key
 * @returns {boolean}
 */
function isForegroundImageAlbedoBusKey(key) {
  return /^__fg_image__$|^__fg_image__[1-9]\d*$/.test(String(key || ''));
}

/**
 * True for bus foreground draws in per-level RTs: albedo planes and streamed cells.
 * @param {string} key
 * @returns {boolean}
 */
function isForegroundImageBusRenderKey(key) {
  const s = String(key || '');
  if (isForegroundImageAlbedoBusKey(s)) return true;
  return /^__fg_image__(?:[1-9]\d*)?:cell:/.test(s);
}

/**
 * Background or foreground full-scene level image (albedo or streamed cell mesh).
 * @param {string} key
 * @returns {boolean}
 */
function isLevelStackImageBusRenderKey(key) {
  return isBackgroundImageBusRenderKey(key) || isForegroundImageBusRenderKey(key);
}

/**
 * True only for the bus albedo background plane keys (`__bg_image__`, `__bg_image__1`, …).
 * Effect overlays use the same prefix (`__bg_image__1_bush`, `_tree`, `_specular`, …) and must
 * not be removed when swapping level backgrounds.
 *
 * @param {string} key
 * @returns {boolean}
 */
function isBackgroundImageAlbedoBusKey(key) {
  return /^__bg_image__$|^__bg_image__[1-9]\d*$/.test(String(key || ''));
}

/**
 * Post-bloom background vegetation overlays (`__bg_image___tree`, `_bush`, …).
 * Specular / iridescence / prism use {@link isBackgroundPreBusEffectOverlayBusKey}
 * and participate in the bus albedo pass like tile-attached overlays.
 * @param {string} key
 * @returns {boolean}
 */
function isBackgroundImageEffectOverlayBusKey(key) {
  return /^__bg_image__(?:[1-9]\d*)?_(?:tree|bush)(?:_shadow)?$/.test(String(key || ''));
}

/**
 * Background specular / iridescence / prism — captured into per-level scene RTs
 * with tile albedo, not the post-bloom vegetation pass.
 * @param {string} key
 * @returns {boolean}
 */
function isBackgroundPreBusEffectOverlayBusKey(key) {
  return /^__bg_image__(?:[1-9]\d*)?_(?:specular|iridescence|prism)$/.test(String(key || ''));
}

/**
 * True for bus background draws in per-level RTs: albedo planes and streamed
 * cell meshes (`__bg_image__:cell:*`), excluding vegetation/specular overlays.
 * @param {string} key
 * @returns {boolean}
 */
function isBackgroundImageBusRenderKey(key) {
  const s = String(key || '');
  if (isBackgroundImageAlbedoBusKey(s)) return true;
  if (isBackgroundImageEffectOverlayBusKey(s)) return false;
  return /^__bg_image__(?:[1-9]\d*)?:cell:/.test(s);
}

/**
 * Background albedo, streamed cells, and coarse fallbacks — not effect overlays.
 * @param {string} key
 * @returns {boolean}
 */
function isBackgroundStreamingBusTileKey(key) {
  const k = String(key || '');
  if (isBackgroundImageEffectOverlayBusKey(k)) return false;
  if (isBackgroundImageAlbedoBusKey(k)) return true;
  if (isBackgroundImageBusRenderKey(k)) return true;
  return /^__bg_image__(?:[1-9]\d*)?__fallback$/.test(k);
}

/**
 * Foreground albedo, streamed cells, and coarse fallbacks.
 * @param {string} key
 * @returns {boolean}
 */
function isForegroundStreamingBusTileKey(key) {
  const k = String(key || '');
  if (!k.startsWith('__fg_image__')) return false;
  if (isForegroundImageAlbedoBusKey(k)) return true;
  if (isForegroundImageBusRenderKey(k)) return true;
  return /^__fg_image__(?:[1-9]\d*)?__fallback$/.test(k);
}

const MAX_SORT_WITHIN_FLOOR_GROUP = MAX_INTRA_ROLE_OFFSET;
const UPPER_FLOOR_ALPHA_CUTOFF = 0.4;
const EMPTY_RADIAL_CIRCLES = [];

/**
 * Strip query/hash for stable asset URL comparison (Foundry / CDN may append tokens).
 * @param {string} s
 * @returns {string}
 */
function _normalizeBgUrlKey(s) {
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
 * True if we should trust sceneComposer._albedoTexture for the current viewed level.
 * @param {import('three').Texture|null} bgTexture
 * @param {string} bgSrc trimmed viewed-level background src (may be empty)
 */
function _composerAlbedoMatchesViewedBg(bgTexture, bgSrc) {
  if (!bgTexture) return false;
  if (!bgSrc) return true;
  const normViewed = normalizeFoundryAssetUrlKey(bgSrc);
  const keysMatch = (candidate) => {
    const raw = String(candidate || '').trim();
    if (!raw) return false;
    if (normalizeFoundryAssetUrlKey(raw) === normViewed) return true;
    return _normalizeBgUrlKey(raw) === _normalizeBgUrlKey(bgSrc);
  };
  try {
    const stamped = bgTexture.userData?.mapShineBackgroundSrc;
    if (keysMatch(stamped)) return true;
  } catch (_) {}
  try {
    const img = bgTexture.image;
    if (img && keysMatch(img.src)) return true;
  } catch (_) {}
  return false;
}

// ─── FloorRenderBus ──────────────────────────────────────────────────────────

export class FloorRenderBus {
  constructor() {
    /**
     * Single scene containing ALL floor tiles, Z-ordered by floor index.
     * Standard Three.js depth sorting handles layering when rendered to screen.
     * @type {import('three').Scene|null}
     */
    this._scene = null;

    /**
     * Per-tile entries. Key: tileId (string).
     * Value: { mesh, material, floorIndex, root?, attachedToTileId? }
     * @type {Map<string, {mesh: import('three').Object3D, material: any, floorIndex: number, root?: import('three').Object3D|null, attachedToTileId?: string|null}>}
     */
    this._tiles = new Map();

    /** @type {boolean} */
    this._initialized = false;

    /** @type {number} */
    this._visibleMaxFloorIndex = Infinity;

    /** @type {boolean} */
    this._suppressTileAlbedoForEditing = false;

    // Visibility telemetry for diagnostics.
    this._setVisibleFloorsCalls = 0;
    this._applyTileVisibilityCalls = 0;
    this._lastSetVisibleMaxFloorIndex = null;
    this._lastApplyVisibilityAtMs = null;
    this._lastPreApplyLeakCount = 0;
    this._lastPreApplyLeakKeys = [];
    this._renderToCalls = 0;
    this._lastRenderToAtMs = null;
    this._lastPreRenderLeakCount = 0;
    this._lastPreRenderLeakKeys = [];

    /**
     * Incremented when background decodes are invalidated (bus clear / bg swap).
     * Async loads from an earlier swap or populate must not call `_addBackgroundImage`.
     */
    this._bgDecodeEpoch = 0;

    /**
     * Separate epoch for foreground (overhead) level images so a foreground swap
     * does not cancel in-flight background decodes scheduled just before it.
     */
    this._fgDecodeEpoch = 0;

    /** @type {Set<Promise<unknown>>} In-flight background decode / streaming mount jobs. */
    this._pendingBackgroundJobs = new Set();

    /** @type {boolean} One-shot guard for deferred foreground stack mount. */
    this._pendingForegroundEnsure = false;

    /** @type {import('../streaming/tile-streaming-manager.js').TileStreamingManager|null} */
    this._streamingManager = null;

    /** @type {Map<string, number>} Stale-async guard for live tile streaming sync. */
    this._tileStreamingGen = new Map();
    /** @type {number} Throttles full-tile streaming maintenance sweeps. */
    this._streamingMaintenanceFrame = 0;

    /** @type {import('three').Color|null} Reused by render paths (avoids per-call GC). */
    this._clearColorScratch = null;
    /** @type {Map<string, boolean>|null} Pooled visibility save maps — cleared before each borrow. */
    this._savedVisibilityMap = null;
    this._savedDoorVisibilityMap = null;
    this._savedDrawingVisibilityMap = null;
    this._savedSplashVisibilityMap = null;
    this._savedMaterialStateMap = null;
    this._savedDoorMaskVisibilityMap = null;

    log.debug('FloorRenderBus created');
  }

  /**
   * Lazily allocate render-path scratch objects (Color + visibility Maps).
   * @private
   */
  _ensureRenderScratch() {
    const THREE = window.THREE;
    if (THREE && !this._clearColorScratch) {
      this._clearColorScratch = new THREE.Color();
    }
    if (!this._savedVisibilityMap) this._savedVisibilityMap = new Map();
    if (!this._savedDoorVisibilityMap) this._savedDoorVisibilityMap = new Map();
    if (!this._savedDrawingVisibilityMap) this._savedDrawingVisibilityMap = new Map();
    if (!this._savedSplashVisibilityMap) this._savedSplashVisibilityMap = new Map();
    if (!this._savedMaterialStateMap) this._savedMaterialStateMap = new Map();
    if (!this._savedDoorMaskVisibilityMap) this._savedDoorMaskVisibilityMap = new Map();
  }

  /**
   * @private
   * @param {'tile'|'door'|'drawing'|'splash'|'material'|'doorMask'} kind
   * @returns {Map}
   */
  _borrowVisibilityMap(kind) {
    this._ensureRenderScratch();
    let map;
    switch (kind) {
      case 'door': map = this._savedDoorVisibilityMap; break;
      case 'drawing': map = this._savedDrawingVisibilityMap; break;
      case 'splash': map = this._savedSplashVisibilityMap; break;
      case 'material': map = this._savedMaterialStateMap; break;
      case 'doorMask': map = this._savedDoorMaskVisibilityMap; break;
      default: map = this._savedVisibilityMap;
    }
    map.clear();
    return map;
  }

  /**
   * Cache bus-key classifications on the entry so hot render paths don't repeat
   * string/regex work every frame.
   *
   * @private
   * @param {string} key
   * @param {object} entry
   * @returns {object}
   */
  _classifyTileEntry(key, entry) {
    if (!entry) return entry;
    const id = String(key || '');
    entry.id = id;
    entry.isInternal = id.startsWith('__');
    entry.isSolidBg = id === '__bg_solid__';
    entry.isVegetation = id.endsWith('_bush')
      || id.endsWith('_bush_shadow')
      || id.endsWith('_tree')
      || id.endsWith('_tree_shadow');
    entry.isSpecularOverlay = id.endsWith('_specular');
    entry.isSplash = id.startsWith('ms_water_splash_batch_');
    entry.isLegacyStackedOverlay = id.startsWith('ms_fire_batch_')
      || id.startsWith('ms_fire_coal_bed_');
    entry.isBgImage = isLevelStackImageBusRenderKey(id);
    entry.isBgImageOverlay = isBackgroundImageEffectOverlayBusKey(id);
    entry.isBgPreBusEffectOverlay = isBackgroundPreBusEffectOverlayBusKey(id);
    return entry;
  }

  /**
   * @private
   * @param {import('three').WebGLRenderer} renderer
   * @returns {{ color: import('three').Color|null, alpha: number|null }}
   */
  _saveRendererClearState(renderer) {
    this._ensureRenderScratch();
    const THREE = window.THREE;
    if (!THREE || typeof renderer.getClearColor !== 'function') {
      return { color: null, alpha: null };
    }
    return {
      color: renderer.getClearColor(this._clearColorScratch),
      alpha: typeof renderer.getClearAlpha === 'function' ? renderer.getClearAlpha() : null,
    };
  }

  /**
   * @private
   * @param {import('three').WebGLRenderer} renderer
   * @param {{ color: import('three').Color|null, alpha: number|null }} saved
   * @param {number} [restoreAlphaOverride] - When set, forces clear alpha on restore.
   */
  _restoreRendererClearState(renderer, saved, restoreAlphaOverride) {
    if (!saved?.color || typeof renderer.setClearColor !== 'function') return;
    const alpha = restoreAlphaOverride != null
      ? restoreAlphaOverride
      : (saved.alpha != null ? saved.alpha : 1);
    renderer.setClearColor(saved.color, alpha);
    if (typeof renderer.setClearAlpha === 'function') {
      try { renderer.setClearAlpha(alpha); } catch (_) {}
    }
  }

  /**
   * @returns {import('three').Scene|null}
   */
  getScene() {
    return this._scene;
  }

  /**
   * Register a streaming background mesh in _tiles for lifecycle tracking.
   * @param {string} key
   * @param {import('three').Object3D} mesh
   * @param {import('three').Material} material
   * @param {number} floorIndex
   */
  _registerStreamingMesh(key, mesh, material, floorIndex) {
    const fi = Number.isFinite(Number(floorIndex)) ? Number(floorIndex) : 0;
    mesh.userData = mesh.userData || {};
    mesh.userData.floorIndex = fi;
    const entry = this._classifyTileEntry(key, { mesh, material, floorIndex: fi });
    this._tiles.set(key, entry);
    mesh.visible = this._computeEntryVisibleForSlice(key, entry);
  }

  /**
   * Remove a streaming cell/fallback entry from bus lifecycle tracking.
   * @param {string} key
   */
  _unregisterStreamingMesh(key) {
    if (!key) return;
    this._tiles.delete(String(key));
  }

  /**
   * Drop a bus tile albedo map and release its GPU texture + budget entry.
   * @param {{ material?: import('three').Material|null }} entry
   * @private
   */
  _clearBusTileAlbedoMap(entry) {
    const tex = entry?.material?.map ?? null;
    if (!tex?.isTexture) return;
    try { getTextureBudgetTracker().unregister(tex); } catch (_) {}
    entry.material.map = null;
    try { tex.dispose?.(); } catch (_) {}
    entry.material.needsUpdate = true;
  }

  /**
   * Mark a bus tile as covered by the scene background streaming pyramid.
   * Keeps the tile mesh hidden — never loads a full-resolution albedo fallback.
   * @param {string} tileId
   */
  markTileServedByBackgroundStream(tileId) {
    const entry = this._tiles.get(tileId);
    if (!entry) return;
    if (this._isOverheadBandBusEntry(entry, tileId)) return;
    const tileDoc = this._getFoundryTileDoc(tileId);
    if (tileDoc && this._usesOverheadRenderBand(tileDoc, this._isOverheadForBusTile(tileDoc, tileId))) {
      return;
    }
    getTileStreamingManager().unregisterBusTile(tileId);
    entry.mapShineStreamedRegion = true;
    entry.mapShineBackgroundStreamServed = true;
    if (entry.mesh) entry.mesh.visible = false;
    this._clearBusTileAlbedoMap(entry);
  }

  /**
   * Restore a bus tile whose streamed region grid was torn down (e.g. redundancy
   * eviction). Re-enables the placeholder mesh and reloads a non-streaming albedo.
   * @param {string} tileId
   */
  _releaseStreamedRegionTile(tileId) {
    const entry = this._tiles.get(tileId);
    if (!entry?.mapShineStreamedRegion && !entry?.mapShineBackgroundStreamServed) return;
    if (entry.mapShineBackgroundStreamServed) {
      try {
        if (getTileStreamingManager().hasBusTile(tileId)) {
          entry.mapShineBackgroundStreamServed = false;
          entry.mapShineStreamedRegion = true;
          return;
        }
      } catch (_) {}
      if (entry.mesh) entry.mesh.visible = false;
      return;
    }
    entry.mapShineStreamedRegion = false;
    entry.mapShineBackgroundStreamServed = false;
    const src = entry.textureSrc;
    const floorIndex = Number(entry.floorIndex) || 0;
    if (entry.mesh) entry.mesh.visible = true;
    if (src) {
      void this._loadTileAlbedoFromUrlAsync(tileId, src, floorIndex, { forceNonStreaming: true });
    } else {
      this._applyTileVisibility();
    }
  }

  /**
   * Re-evaluate ground tiles wrongly hidden as background-served (e.g. after a
   * foreground pyramid registered with the same source dimensions).
   */
  recoverWronglyBackgroundStreamServedTiles() {
    for (const entry of this._tiles.values()) {
      if (!entry?.mapShineBackgroundStreamServed) continue;
      const tileId = entry.id;
      if (this._isOverheadBandBusEntry(entry, tileId)) continue;
      void this._evaluateTileStreaming(tileId, entry, Number(entry.floorIndex) || 0);
    }
  }

  /**
   * Per-frame tile streaming sync (background cell residency).
   */
  syncStreaming() {
    try {
      const sc = window.MapShine?.sceneComposer ?? null;
      const fd = sc?.foundrySceneData ?? null;
      if (sc && fd) this.tryMountViewedBackgroundFromComposer(sc, fd);
      for (const entry of this._tiles.values()) {
        if (!entry?.mapShineBackgroundStreamServed) continue;
        const tileId = entry.id;
        if (!this._isOverheadBandBusEntry(entry, tileId)) continue;
        void this._evaluateTileStreaming(tileId, entry, Number(entry.floorIndex) || 0);
      }
      this._recoverStuckOverheadBandTiles();
      this._migrateOverheadStaticAlbedoToStreaming();
      this._maybeEnsureForegroundStackLoaded();
      getTileStreamingManager().update();
      this._applyTileVisibility();
      try {
        window.MapShine?.effectComposer?._floorCompositorV2?._specularEffect
          ?.syncOverlaysAfterTileStreaming?.();
      } catch (_) {}
    } catch (_) {}
  }

  /**
   * @param {string|null|undefined} tileId
   * @returns {object|null}
   * @private
   */
  _getFoundryTileDoc(tileId) {
    const id = String(tileId || '');
    if (!id) return null;
    try {
      return canvas?.scene?.tiles?.get(id) ?? null;
    } catch (_) {
      return null;
    }
  }

  /**
   * True when a bus tile draws in the FLOOR_OVERHEAD band (Foundry overhead flag,
   * high-elevation slab, or renderOrder at/above tileOverheadOrder baseline).
   * @param {object|null|undefined} entry
   * @param {string|null|undefined} [tileId]
   * @returns {boolean}
   * @private
   */
  _isOverheadBandBusEntry(entry, tileId = null) {
    if (!entry) return false;
    const id = tileId
      ?? entry.material?.userData?.foundryTileId
      ?? entry.root?.userData?.foundryTileId
      ?? null;
    const tileDoc = this._getFoundryTileDoc(id);
    if (tileDoc && isTileOverhead(tileDoc)) return true;
    if (tileDoc && this._isActiveLevelElevatedBusTile(tileDoc)) return true;
    if (entry.isOverhead ?? entry.root?.userData?.isOverhead) return true;
    const ro = Number(entry.mesh?.renderOrder);
    if (!Number.isFinite(ro)) return false;
    const fi = Number(entry.floorIndex) || 0;
    return ro >= tileOverheadOrder(fi, 0);
  }

  /**
   * @param {{ minX: number, minY: number, maxX: number, maxY: number }|null|undefined} region
   * @returns {number}
   * @private
   */
  _sceneCoverageForBusRegion(region) {
    const fd = window.MapShine?.sceneComposer?.foundrySceneData ?? {};
    const sceneW = Number(fd.sceneWidth ?? fd.width ?? 0);
    const sceneH = Number(fd.sceneHeight ?? fd.height ?? 0);
    if (sceneW <= 0 || sceneH <= 0 || !region) return 0;
    const rw = Math.max(0, region.maxX - region.minX);
    const rh = Math.max(0, region.maxY - region.minY);
    return (rw * rh) / (sceneW * sceneH);
  }

  /**
   * @param {string} tileId
   * @returns {boolean}
   * @private
   */
  _busTileHasStreamingCells(tileId) {
    const id = String(tileId || '');
    if (!id) return false;
    const cellPrefix = `${id}:`;
    const fallbackKey = `${id}__fallback`;
    for (const key of this._tiles.keys()) {
      const k = String(key);
      if (k === fallbackKey || k.startsWith(cellPrefix)) return true;
    }
    return false;
  }

  /**
   * Re-mount full-scene overhead tiles that were hidden by background dedup or
   * left with a hidden placeholder mesh and no streamed region cells.
   * @private
   */
  _recoverStuckOverheadBandTiles() {
    const manager = getTileStreamingManager();
    for (const entry of this._tiles.values()) {
      if (entry?.isInternal) continue;
      const tileId = entry.id;
      if (!this._isOverheadBandBusEntry(entry, tileId)) continue;
      if (entry.material?.map) continue;
      if (this._busTileHasStreamingCells(tileId)) continue;
      if (entry.mapShineStreamedRegion || manager.hasBusTile(tileId)) continue;
      if (entry.mapShineOverheadAlbedoRecovery) continue;
      if (!entry.textureSrc) continue;

      entry.mapShineBackgroundStreamServed = false;
      if (entry.mesh) {
        entry.mesh.visible = this._computeEntryVisibleForSlice(tileId, entry);
      }
      entry.mapShineOverheadAlbedoRecovery = true;
      const floorIndex = Number(entry.floorIndex) || 0;
      void this._evaluateTileStreaming(tileId, entry, floorIndex)
        .then((streamed) => {
          if (streamed || entry.material?.map || this._busTileHasStreamingCells(tileId)) return;
          return this._loadTileAlbedoFromUrlAsync(
            tileId,
            entry.textureSrc,
            floorIndex,
            { forceNonStreaming: true },
          );
        })
        .finally(() => {
          entry.mapShineOverheadAlbedoRecovery = false;
        });
    }
  }

  /**
   * Move overhead tiles off a one-shot downscaled placeholder albedo onto the
   * streaming pyramid so LOD can sharpen after the initial coarse coverage load.
   * @private
   */
  _migrateOverheadStaticAlbedoToStreaming() {
    const manager = getTileStreamingManager();
    for (const entry of this._tiles.values()) {
      if (entry?.isInternal) continue;
      const tileId = entry.id;
      if (!this._isOverheadBandBusEntry(entry, tileId)) continue;
      if (entry.mapShineStreamedRegion || manager.hasBusTile(tileId) || this._busTileHasStreamingCells(tileId)) {
        continue;
      }
      if (!entry.material?.map || !entry.textureSrc) continue;
      if (entry.mapShineOverheadStreamMigrate) continue;
      entry.mapShineOverheadStreamMigrate = true;
      const floorIndex = Number(entry.floorIndex) || 0;
      void this._evaluateTileStreaming(tileId, entry, floorIndex).finally(() => {
        entry.mapShineOverheadStreamMigrate = false;
      });
    }
  }

  /**
   * Whether any foreground plane or streamed cell is registered on the bus.
   * @returns {boolean}
   * @private
   */
  _hasForegroundBusResidency() {
    for (const key of this._tiles.keys()) {
      if (isForegroundStreamingBusTileKey(key)) return true;
    }
    try {
      for (const key of getTileStreamingManager().getGrids().keys()) {
        if (isForegroundImageAlbedoBusKey(key)) return true;
      }
    } catch (_) {}
    return false;
  }

  /**
   * Mount or refresh V14 foreground (overhead) level images when Foundry exposes them.
   * Safe to call repeatedly — no-ops when the stack is already resident or still loading.
   *
   * @param {object} fd
   * @param {{ skipFirst?: boolean, viewedLevelIndex?: number }} [options]
   * @param {string|null|undefined} [fallbackSrc]
   */
  syncForegroundStackFromScene(fd, options = {}, fallbackSrc = null) {
    if (!this._initialized || !fd) return;
    const scene = globalThis.canvas?.scene ?? null;
    const visibleLayers = getVisibleLevelForegroundLayers(scene);
    if (visibleLayers.length > 0) {
      this.swapVisibleLevelForegroundImages(visibleLayers, fd, options);
      return;
    }
    const viewedSrc = String(
      getViewedLevelForegroundSrc(scene) || fallbackSrc || '',
    ).trim();
    if (viewedSrc) {
      this.swapVisibleLevelForegroundImages([{ src: viewedSrc, sort: 0 }], fd, options);
      return;
    }
    if (this._hasForegroundBusResidency()) {
      this._removeForegroundImageEntries();
    }
  }

  /**
   * Deferred foreground mount when early populate / swap hooks ran before Foundry
   * published level.foreground.src.
   * @private
   */
  _maybeEnsureForegroundStackLoaded() {
    if (this._hasForegroundBusResidency()) return;
    if (this._pendingForegroundEnsure) return;
    const fd = window.MapShine?.sceneComposer?.foundrySceneData;
    if (!fd) return;
    const layers = getVisibleLevelForegroundLayers(globalThis.canvas?.scene ?? null);
    if (!layers.length) return;
    this._pendingForegroundEnsure = true;
    queueMicrotask(() => {
      this._pendingForegroundEnsure = false;
      if (this._hasForegroundBusResidency()) return;
      const scene = globalThis.canvas?.scene ?? null;
      let viewedLevelIndex;
      try {
        const lid = window.MapShine?.activeLevelContext?.levelId ?? canvas?.level?.id ?? null;
        if (lid && scene) {
          const stackIdx = resolveV14LevelIdToFloorStackIndex(scene, lid);
          if (stackIdx !== null) viewedLevelIndex = stackIdx;
        }
      } catch (_) {}
      const opts = Number.isFinite(viewedLevelIndex) ? { viewedLevelIndex } : {};
      this.syncForegroundStackFromScene(fd, opts);
    });
  }

  /**
   * Debug snapshot of bus texture residency (console troubleshooting).
   * @returns {Array<object>}
   */
  getTextureDiagnostics() {
    /** @type {Array<object>} */
    const out = [];
    for (const [id, entry] of this._tiles) {
      const map = entry?.material?.map ?? null;
      const node = entry?.root || entry?.mesh;
      const doc = this._getFoundryTileDoc(id);
      out.push({
        id: String(id),
        hasMap: !!map,
        shared: !!map?.userData?.mapShineSharedComposerTexture,
        textureSrc: entry?.textureSrc ? String(entry.textureSrc) : null,
        visible: node?.visible !== false,
        rootVisible: entry?.root?.visible,
        meshVisible: entry?.mesh?.visible,
        floorIndex: entry?.floorIndex,
        isOverhead: !!entry?.isOverhead,
        opacity: entry?.material?.opacity,
        elevation: Number.isFinite(Number(doc?.elevation)) ? Number(doc.elevation) : null,
        levelIds: doc?.levels?.size ? [...doc.levels] : [],
        activeLevelVisible: this._isBusTileOnActiveLevelView(id),
      });
    }
    return out;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  /**
   * Initialize the bus. Call once after Three.js is available.
   */
  initialize() {
    if (!window.THREE) {
      log.warn('FloorRenderBus.initialize: THREE not available');
      return;
    }
    const THREE = window.THREE;
    this._scene = new THREE.Scene();
    this._scene.name = 'FloorBusScene';
    // Tile albedos load via loadImageTexture (off-thread decode) — see _loadTileAlbedoFromUrl.
    // Background images do NOT use TextureLoader — see `_loadBgImageStraightAlpha`
    // for the canvas → getImageData → DataTexture decode path used for
    // `__bg_image__*` entries. That path guarantees straight-alpha RGBA data
    // regardless of browser image-decode quirks.
    this._initialized = true;
    log.info('FloorRenderBus initialized');
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Build the scene from Foundry tile documents and the scene background.
   * Loads all textures independently via THREE.TextureLoader (straight alpha,
   * no canvas 2D corruption). Safe to call multiple times — clears first.
   *
   * @param {import('../scene/composer.js').SceneComposer} sceneComposer
   */
  populate(sceneComposer) {
    if (!this._initialized) return;
    this.clear();

    const fd = sceneComposer?.foundrySceneData;
    if (!fd) { log.warn('FloorRenderBus.populate: no foundrySceneData'); return; }

    try { reconfigureTextureBudgetForScene(window.MapShine?.renderer ?? null); } catch (_) {}
    try { applySavedMemoryPresetsForScene(); } catch (_) {}

    const floors = window.MapShine?.floorStack?.getFloors() ?? [];
    const stackViewIdx = (() => {
      try {
        const lid = window.MapShine?.activeLevelContext?.levelId ?? canvas?.level?.id ?? null;
        if (lid && scene) {
          const idx = resolveV14LevelIdToFloorStackIndex(scene, lid);
          if (idx !== null) return idx;
        }
        const af = window.MapShine?.floorStack?.getActiveFloor?.()?.index;
        if (Number.isFinite(Number(af))) return Number(af);
      } catch (_) {}
      return undefined;
    })();
    const stackLoadOpts = Number.isFinite(stackViewIdx) ? { viewedLevelIndex: stackViewIdx } : {};

    // Solid background colour plane (full world canvas, lowest Z).
    this._addSolidBackground(fd);

    // Scene background image — reuse SceneComposer's already-loaded texture
    // when GPU pixels exist, otherwise fall back to TextureLoader or a short
    // rAF wait. SceneComposer often assigns `_albedoTexture` before the
    // underlying image has non-zero dimensions; using it immediately skips
    // `_addBackgroundImage` (sceneW/H from image) and never schedules a load,
    // leaving only the solid #999999 bus plane (grey "empty" map under PIXI).
    const bgTexture = sceneComposer?._albedoTexture ?? null;
    // V14: prefer the viewed level's background; deprecated scene.background.src
    // always returns the first level's image.
    const scene = canvas?.scene ?? null;
    const bgSrcRaw = getViewedLevelBackgroundSrc(scene) ?? scene?.background?.src ?? '';
    const bgSrc = (bgSrcRaw && String(bgSrcRaw).trim()) ? String(bgSrcRaw).trim() : '';
    const visibleBgLayers = getVisibleLevelBackgroundLayers(scene);
    const visibleBgSrcs = visibleBgLayers.map((l) => l.src);
    const albedoImageReady = !!(bgTexture?.image && bgTexture.image.width > 0 && bgTexture.image.height > 0);
    // V14 multi-floor: never reuse SceneComposer._albedoTexture for the bus.
    // Foundry can transiently show another level's composite in canvas.primary while URLs
    // still match; TextureLoader reads the viewed level file directly.
    //
    // IMPORTANT: first populate() often runs before FloorStack is attached to MapShine,
    // so `floors` is [] — still treat native multi-level scenes as multi-floor here.
    const nativeLevelCount = scene?.levels?.size ?? 0;
    const multiFloorV14 = !!(hasV14NativeLevels(scene) && (floors.length > 1 || nativeLevelCount > 1));
    const reuseComposerAlbedo = !multiFloorV14
      && albedoImageReady
      && _composerAlbedoMatchesViewedBg(bgTexture, bgSrc);

    if (reuseComposerAlbedo) {
      const viewedBgReuse = String(getViewedLevelBackgroundSrc(scene) || '').trim();
      let floorIdxReuse = resolveV14BackgroundFloorIndexForSrc(scene, bgSrc);
      floorIdxReuse = finalizeBackgroundFloorIndexForBus(scene, bgSrc, floorIdxReuse, {
        loadCount: 1,
        floorsLen: floors.length,
        viewedBg: viewedBgReuse,
      });
      this._markSharedComposerTexture(bgTexture);
      this._addBackgroundImage(fd, bgTexture, floorIdxReuse, backgroundBusKeyForFloorIndex(floorIdxReuse));
      if (visibleBgLayers.length > 1) {
        // Composer albedo only matches the viewed level texture; load other visible
        // background layers explicitly so upper-floor views include lower levels.
        this._loadVisibleBackgroundStack(visibleBgLayers, fd, { skipFirst: true, ...stackLoadOpts });
      }
    } else if (visibleBgLayers.length > 0) {
      this._loadVisibleBackgroundStack(visibleBgLayers, fd, stackLoadOpts);
    } else if (bgSrc) {
      // Route legacy single-background load through the same
      // `_loadVisibleBackgroundStack` path used for multi-level stacks.
      // Keeps straight-alpha decode (ImageBitmap + premultiplyAlpha: 'none')
      // consistent across every `__bg_image__*` entry so authored alpha
      // holes survive to the GPU. Previously this fell back to
      // `TextureLoader`, which silently flattens WebP alpha in browsers
      // that decode HTMLImageElement with premultiplied RGB.
      this._loadVisibleBackgroundStack([{ src: bgSrc, alphaThreshold: 0 }], fd, stackLoadOpts);
      log.info('FloorRenderBus: bg image load routed through ImageBitmap stack loader');
    } else if (bgTexture) {
      this._scheduleViewedBackgroundComposerRetry(sceneComposer, fd, {
        viewedLevelIndex: stackLoadOpts.viewedLevelIndex,
      });
    }

    if (!multiFloorV14) {
      const viewedBgRetry = String(getViewedLevelBackgroundSrc(scene) || bgSrc || '').trim();
      if (viewedBgRetry) {
        let fiRetry = resolveV14BackgroundFloorIndexForSrc(scene, viewedBgRetry);
        fiRetry = finalizeBackgroundFloorIndexForBus(scene, viewedBgRetry, fiRetry, {
          loadCount: 1,
          floorsLen: floors.length,
          viewedBg: viewedBgRetry,
          viewedLevelIndexOverride: stackLoadOpts.viewedLevelIndex,
        });
        const keyRetry = backgroundBusKeyForFloorIndex(fiRetry);
        if (!this._hasDirectBackgroundImagePlane(keyRetry)
          && !this.tryMountViewedBackgroundFromComposer(sceneComposer, fd, stackLoadOpts)) {
          this._scheduleViewedBackgroundComposerRetry(sceneComposer, fd, {
            bgSrc: viewedBgRetry,
            floorIdx: fiRetry,
            key: keyRetry,
            viewedLevelIndex: stackLoadOpts.viewedLevelIndex,
          });
        }
      }
    }

    // Tile planes — read directly from Foundry, no TileManager dependency.
    const tileDocs = canvas?.scene?.tiles?.contents ?? [];
    let tileCount = 0;
    const floorCounts = {};

    // Pre-sort tiles by elevation then Foundry sort so visual stacking is correct.
    // Matches GpuSceneMaskCompositor: lower elevation/sort first, higher paints on top.
    const sortedTileDocs = [...tileDocs].sort((a, b) => {
      const eA = Number(a?.elevation ?? 0);
      const eB = Number(b?.elevation ?? 0);
      if (eA !== eB) return eA - eB;
      return this._getTileSortValue(a) - this._getTileSortValue(b);
    });

    for (const tileDoc of sortedTileDocs) {
      const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
      if (!src) continue;

      const floorIndex = this._resolveFloorIndex(tileDoc, floors);
      const alpha = typeof tileDoc.alpha === 'number' ? tileDoc.alpha : 1;
      const rotation = typeof tileDoc.rotation === 'number'
        ? (tileDoc.rotation * Math.PI) / 180 : 0;

      // Foundry v14+ tiles: shape (x,y) is the anchor; center uses anchorX/Y.
      const worldH = fd.height;
      const { dispW: tileW, dispH: tileH, signX: planeSignX, signY: planeSignY } = getTileBusPlaneSizeAndMirror(tileDoc);
      const { cx: cxf, cy: cyf } = getTileVisualCenterFoundryXY(tileDoc);
      const centerX = cxf;
      const centerY = worldH - cyf;
      const z = GROUND_Z + floorIndex * Z_PER_FLOOR;
      const tileId = tileDoc.id ?? tileDoc._id ?? `tile_${tileCount}`;

      const isOverhead = this._isOverheadForBusTile(tileDoc, tileId);
      const usesOverheadBand = this._usesOverheadRenderBand(tileDoc, isOverhead);
      const busOverhead = isOverhead || usesOverheadBand;
      const roofShadowCaster = this._usesRoofShadowCaptureLayer(tileDoc, floorIndex, busOverhead);
      const cloudShadowBlockerEnabled = this._shouldTileBlockCloudShadows(tileDoc, busOverhead);
      const motionRenderAboveTokens = !!window.MapShine?.tileMotionManager?.getTileConfig?.(tileId)?.renderAboveTokens;
      floorCounts[floorIndex] = floorCounts[floorIndex] ?? { regular: 0, overhead: 0 };
      const groupCounts = floorCounts[floorIndex];
      if (busOverhead) groupCounts.overhead += 1;
      else groupCounts.regular += 1;
      const sortWithinFloor = this._computeSortWithinFloor(tileDoc);
      const renderOrder = this._resolveBusTileRenderOrder(
        tileDoc,
        floorIndex,
        isOverhead,
        motionRenderAboveTokens,
        sortWithinFloor,
      );

      // Create mesh immediately with null texture (invisible until loaded).
      const restrictsLight = tileDocRestrictsLight(tileDoc);
      this._addTileMesh(tileId, floorIndex, null, centerX, centerY, z, tileW, tileH, rotation, alpha, renderOrder, busOverhead, roofShadowCaster, cloudShadowBlockerEnabled, planeSignX, planeSignY, restrictsLight);

      const entryRadial = this._tiles.get(tileId);
      const populateOcclFlags = getTileOcclusionModeFlags(tileDoc);
      const populateNeedsFoundryShader = !!(populateOcclFlags
        & (CONST.TILE_OCCLUSION_MODES.RADIAL | CONST.TILE_OCCLUSION_MODES.VISION
          | (CONST.TILE_OCCLUSION_MODES.SURFACE ?? 2)));
      if (entryRadial?.material && populateNeedsFoundryShader) {
        installBusMeshRadialOcclusionShader(entryRadial.material);
      }

      this._loadTileAlbedoFromUrl(tileId, src, floorIndex);

      tileCount++;
    }

    const visibleFgLayers = getVisibleLevelForegroundLayers(scene);
    if (visibleFgLayers.length > 0) {
      this._loadVisibleForegroundStack(visibleFgLayers, fd, stackLoadOpts);
      log.info(`FloorRenderBus: loading ${visibleFgLayers.length} foreground/overhead layer(s)`);
    } else {
      // Foundry may not expose foreground layers until after the first populate pass.
      queueMicrotask(() => {
        if (this._hasForegroundBusResidency()) return;
        this.syncForegroundStackFromScene(fd, stackLoadOpts);
      });
    }

    // Diagnostic: log overhead tile assignment so we can spot mis-classified tiles.
    const overheadDiag = sortedTileDocs
      .filter(td => this._isOverheadForBusTile(td, td?.id ?? td?._id))
      .map(td => {
        const fi = this._resolveFloorIndex(td, floors);
        return { id: td.id, floor: fi, src: (td.texture?.src ?? td.img ?? '').split('/').pop() };
      });
    if (overheadDiag.length > 0) {
      log.info(`FloorRenderBus: ${overheadDiag.length} overhead tiles:`, overheadDiag);
    }
    // Ensure any entries created during populate() respect the current floor slice.
    // setVisibleFloors() may have been called before populate completed.
    this._refreshBusTileOverheadClassification();
    this._applyTileVisibility();
    log.info(`FloorRenderBus populated: ${tileCount} tiles (${floors.length} floors)`, floorCounts);
    queueMicrotask(() => {
      try { this._recoverStuckOverheadBandTiles(); } catch (_) {}
    });
  }

  /**
   * Render the bus scene to the given target (or screen if null).
   * Uses the main perspective camera for correct world-space projection.
   *
   * Saves and restores renderer state (autoClear, clearColor, renderTarget)
   * so the rest of the render loop is not affected.
   *
   * @param {import('three').WebGLRenderer} renderer
   * @param {import('three').Camera} camera
   * @param {import('three').WebGLRenderTarget|null} [target=null] - Render target, or null for screen.
   */
  renderTo(renderer, camera, target = null) {
    if (!this._initialized || !this._scene) return;

    // FINAL GUARD: enforce floor-slice visibility immediately before draw.
    // Some async/runtime paths can flip node.visible after earlier floor updates.
    this._applyTileVisibility();
    this._renderToCalls += 1;
    this._lastRenderToAtMs = Date.now();
    const preRenderLeakKeys = [];
    let preRenderLeakCount = 0;
    for (const entry of this._tiles.values()) {
      if (entry?.isInternal) continue;
      const fi = Number(entry?.floorIndex);
      if (!Number.isFinite(fi) || fi <= this._visibleMaxFloorIndex) continue;
      const node = entry?.root || entry?.mesh;
      if (node?.visible === true) {
        preRenderLeakCount += 1;
        if (preRenderLeakKeys.length < 40) preRenderLeakKeys.push(entry.id);
      }
    }
    this._lastPreRenderLeakCount = preRenderLeakCount;
    this._lastPreRenderLeakKeys = preRenderLeakKeys;

    // Save renderer state.
    const prevTarget    = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevClear     = this._saveRendererClearState(renderer);

    // Save camera layer mask and explicitly configure the main-pass layer set.
    // Tokens and tiles are assigned to floor layers (1-19) by FloorLayerManager,
    // so we must render those plus layer 0. Do NOT inherit prior camera masks:
    // overlay layer 31 is rendered in a dedicated late pass by FloorCompositor.
    const prevLayerMask = camera.layers.mask;
    camera.layers.set(0);
    // Enable all floor layers (1-19) so tokens/tiles assigned to floors are visible.
    for (let i = 1; i <= 19; i++) {
      camera.layers.enable(i);
    }

    for (const entry of this._tiles.values()) {
      if (!entry?.isSplash) continue;
      const node = entry?.root || entry?.mesh;
      if (!node) continue;
      entry._savedSplashVisible = node.visible === true;
      node.visible = false;
    }

    // Render with a black clear so no white flash while textures load.
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 1);
    renderer.autoClear = true;
    renderer.render(this._scene, camera);

    for (const entry of this._tiles.values()) {
      if (!entry?.isSplash || entry._savedSplashVisible === undefined) continue;
      const node = entry?.root || entry?.mesh;
      if (node) node.visible = entry._savedSplashVisible;
      entry._savedSplashVisible = undefined;
    }

    // Restore camera layer mask and renderer state.
    camera.layers.mask = prevLayerMask;
    renderer.autoClear = prevAutoClear;
    // CRITICAL (V2): Do not restore a transparent clearAlpha.
    // A clearAlpha of 0 makes the Three canvas effectively transparent and can
    // reveal underlying stale content as a camera-locked "ghost" overlay.
    this._restoreRendererClearState(renderer, prevClear, 1);
    renderer.setRenderTarget(prevTarget);
  }

  /**
   * Convenience: render the bus scene directly to the screen framebuffer.
   * @param {import('three').WebGLRenderer} renderer
   * @param {import('three').Camera} camera
   */
  renderToScreen(renderer, camera) {
    this.renderTo(renderer, camera, null);
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────────

  /**
   * Remove all meshes and dispose GPU resources. Does not destroy the bus.
   */
  clear() {
    if (!this._scene) return;
    this._bgDecodeEpoch += 1;
    this._fgDecodeEpoch += 1;
    this._pendingBackgroundJobs?.clear?.();
    try { getTileStreamingManager().clearGrids(); } catch (_) {}

    log.info(`[V2 DEBUG] FloorRenderBus.clear() called - scene has ${this._scene.children.length} children before clear`);
    
    for (const { mesh, material, root } of this._tiles.values()) {
      try {
        if (mesh?.parent) {
          mesh.parent.remove(mesh);
        } else {
          this._scene.remove(mesh);
        }
      } catch (_) {}
      try {
        if (root?.parent) {
          root.parent.remove(root);
        }
      } catch (_) {}

      // Tiles and some overlays are Mesh instances with materials/geometries.
      // Others (e.g. quarks BatchedRenderer) are Object3D renderers with no
      // `material` or `geometry`. Treat those as effect-owned and only detach.
      try {
        const mat = material ?? mesh?.material ?? null;
        if (mat) this._disposeBusMaterial(mat);
      } catch (_) {}

      try {
        const geom = mesh?.geometry ?? null;
        if (geom && typeof geom.dispose === 'function') {
          geom.dispose();
        }
      } catch (_) {}
    }
    this._tiles.clear();
    
    // Remove background meshes and effect overlays, but preserve tokens/doors.
    // Tokens are added by TokenManager and should not be destroyed when
    // repopulating tiles. Only remove objects with tileId starting with '__'
    // (background planes, effect overlays) that are not tracked in _tiles.
    const childrenToRemove = [];
    let tokenCount = 0;
    let otherCount = 0;
    
    for (const child of this._scene.children) {
      const userData = child?.userData;
      const type = userData?.type;
      const name = child?.name || 'unnamed';

      // Preserve long-lived, effect-owned objects that explicitly opt out
      // of bus clear (for example PlayerLightEffectV2 batch/group objects).
      if (userData?.preserveOnBusClear === true) {
        tokenCount++;
        log.info(`[V2 DEBUG] Preserving persistent effect object: ${name}`);
        continue;
      }
      
      // Preserve tokens (type === 'token')
      if (type === 'token') {
        tokenCount++;
        log.info(`[V2 DEBUG] Preserving token: ${name} (type=${type})`);
        continue;
      }
      // Preserve door meshes managed by DoorMeshManager.
      if (type === 'doorMesh') {
        tokenCount++;
        log.info(`[V2 DEBUG] Preserving door mesh: ${name} (type=${type})`);
        continue;
      }
      // Preserve scene drawings (DrawingManager root group).
      if (type === 'sceneDrawingsRoot') {
        tokenCount++;
        log.info(`[V2 DEBUG] Preserving scene drawings root: ${name}`);
        continue;
      }
      // Preserve grid overlay mesh (GridRenderer).
      if (name === 'GridOverlay' || name?.startsWith?.('GridOverlayGhost_')) {
        tokenCount++;
        log.info(`[V2 DEBUG] Preserving grid overlay: ${name}`);
        continue;
      }
      // Preserve transient interaction overlays (path previews, gizmos, etc.)
      // managed by InteractionManager.
      if (type === 'interactionOverlay') {
        tokenCount++;
        log.info(`[V2 DEBUG] Preserving interaction overlay: ${name} (type=${type})`);
        continue;
      }
      // Preserve particle systems and other effect objects
      if (child.name?.startsWith('Token_')) {
        tokenCount++;
        log.info(`[V2 DEBUG] Preserving token by name: ${name}`);
        continue;
      }
      // Remove everything else (background planes, old effect overlays)
      otherCount++;
      childrenToRemove.push(child);
    }
    
    for (const child of childrenToRemove) {
      this._scene.remove(child);
    }
    
    log.info(`[V2 DEBUG] FloorRenderBus.clear() complete - preserved ${tokenCount} tokens, removed ${otherCount} other objects, ${this._scene.children.length} children remain`);
  }

  /**
   * Full dispose — call on scene teardown.
   */
  dispose() {
    this.clear();
    this._scene = null;
    this._initialized = false;
    log.info('FloorRenderBus disposed');
  }

  // ── Visibility ─────────────────────────────────────────────────────────────────

  /**
   * Temporarily show upper-floor roof shadow casters that are normally hidden
   * while the camera is on a lower floor (`floorIndex > _visibleMaxFloorIndex`),
   * so OverheadShadowsEffectV2 can render them into ROOF_LAYER RTs.
   * Always pair with {@link #endOverheadShadowCaptureReveal} (e.g. try/finally).
   *
   * @returns {Array<{node: import('three').Object3D, wasVisible: boolean}>} snapshot
   */
  beginOverheadShadowCaptureReveal() {
    const snapshot = [];
    if (!this._initialized) return snapshot;
    const maxV = Number.isFinite(Number(this._visibleMaxFloorIndex))
      ? Number(this._visibleMaxFloorIndex)
      : Infinity;
    for (const entry of this._tiles.values()) {
      if (entry?.isInternal) continue;
      if (!entry?.roofShadowCaster) continue;
      if (!(entry.floorIndex > maxV)) continue;
      const node = entry.root || entry.mesh;
      if (!node) continue;
      // Capture current state before forcing visible
      snapshot.push({ node, wasVisible: node.visible });
      node.visible = true;
    }
    return snapshot;
  }

  /**
   * Restore bus tile visibility after overhead shadow capture.
   *
   * @param {Array<{node: import('three').Object3D, wasVisible: boolean}>} snapshot
   */
  endOverheadShadowCaptureReveal(snapshot = []) {
    if (!this._initialized) return;
    // Restore each node to its captured state
    for (const entry of snapshot) {
      if (entry?.node) entry.node.visible = entry.wasVisible;
    }
  }

  _applyTileVisibility() {
    if (!this._initialized) return;
    this._applyTileVisibilityCalls += 1;
    this._lastApplyVisibilityAtMs = Date.now();
    let preApplyLeakCount = 0;
    const preApplyLeakKeys = [];

    for (const entry of this._tiles.values()) {
      const node = entry?.root || entry?.mesh;
      if (!node) continue;

      // World-spanning solid underlay only — level backgrounds respect floor slice.
      if (entry.isSolidBg) {
        node.visible = true;
        continue;
      }

      // Tree/Bush/Specular V2 overlays manage floor + view + streaming visibility in the effect.
      if (entry.isVegetation || entry.isSpecularOverlay) {
        continue;
      }

      const inVisibleFloorSlice = entry.floorIndex <= this._visibleMaxFloorIndex;
      const floorVisible = this._computeEntryVisibleForSlice(entry.id, entry);
      const streamingManaged = node.userData?.mapShineStreaming === true;

      if (!entry.isInternal && !inVisibleFloorSlice && node.visible === true) {
        preApplyLeakCount += 1;
        if (preApplyLeakKeys.length < 40) preApplyLeakKeys.push(entry.id);
      }

      if (streamingManaged) {
        // Streaming sync owns frustum culling; only force-hide when the floor slice excludes this entry.
        if (!floorVisible) node.visible = false;
        continue;
      }

      if (entry.mapShineBackgroundStreamServed || (entry.mapShineStreamedRegion && !entry.material?.map)) {
        node.visible = false;
        continue;
      }

      node.visible = floorVisible;
    }

    for (const ch of this._scene?.children ?? []) {
      if (ch?.userData?.type === 'sceneDrawingsRoot') {
        ch.visible = true;
        for (const drawingGroup of ch.children ?? []) {
          const fi = Number(drawingGroup?.userData?.floorIndex);
          const inSlice = !Number.isFinite(fi) || fi <= this._visibleMaxFloorIndex;
          drawingGroup.visible = inSlice && !this._suppressTileAlbedoForEditing;
        }
        continue;
      }
      if (ch?.userData?.type !== 'doorMesh') continue;
      const fi = Number(ch.userData?.floorIndex);
      const globalDoor = fi === DOOR_FLOOR_INDEX_GLOBAL;
      const inSlice = globalDoor
        || (Number.isFinite(fi) && fi <= this._visibleMaxFloorIndex);
      ch.visible = inSlice && !this._suppressTileAlbedoForEditing;
    }
    this._lastPreApplyLeakCount = preApplyLeakCount;
    this._lastPreApplyLeakKeys = preApplyLeakKeys;
  }

  /**
   * Whether a bus tile belongs to the level currently being viewed. V14 native
   * `levels` membership is authoritative; elevation is only a fallback for
   * documents without native level assignment.
   * @param {string|null|undefined} tileId
   * @returns {boolean}
   * @private
   */
  _isBusTileOnActiveLevelView(tileId) {
    const doc = this._getFoundryTileDoc(tileId);
    if (!doc) return false;

    const scene = globalThis.canvas?.scene;
    const ctx = window.MapShine?.activeLevelContext;
    if (!(hasV14NativeLevels(scene) || isLevelsEnabledForScene(scene))) return false;
    if (!this._hasFiniteActiveLevelBand(ctx)) return false;

    const activeLevelId = ctx?.levelId ?? canvas?.level?.id ?? null;
    if (hasV14NativeLevels(scene) && doc.levels?.size) {
      if (!activeLevelId) return false;
      return doc.levels.has(activeLevelId);
    }

    const bandBottom = Number(ctx.bottom);
    const bandTop = Number(ctx.top);

    if (tileHasLevelsRange(doc)) {
      const flags = readTileLevelsFlags(doc);
      const tileBottom = Number(flags.rangeBottom);
      const tileTop = Number(flags.rangeTop);
      if (Number.isFinite(tileBottom) && Number.isFinite(tileTop)
        && Number.isFinite(bandBottom) && Number.isFinite(bandTop)) {
        return !(tileTop <= bandBottom || tileBottom >= bandTop);
      }
    }

    const elev = Number(doc.elevation);
    if (!Number.isFinite(elev) || !Number.isFinite(bandBottom)) return false;
    return Number.isFinite(bandTop) && elev >= bandBottom && elev < bandTop;
  }

  /**
   * Compute whether a bus entry should currently be visible for floor slicing.
   * Internal/background entries (`__*`) always remain visible.
   *
   * @param {string} key
   * @param {{floorIndex:number}|null} entry
   * @returns {boolean}
   * @private
   */
  _computeEntryVisibleForSlice(key, entry) {
    if (String(key || '') === '__bg_solid__') return true;
    if (this._suppressTileAlbedoForEditing) return false;

    const floorIndex = Number(entry?.floorIndex);
    if (!Number.isFinite(floorIndex)) return true;

    if (floorIndex <= this._visibleMaxFloorIndex) return true;

    // Some V14 overhead tiles can have a floorIndex that lags the active view
    // during init/rebuild, but only the live active level may pierce the slice.
    if (this._isOverheadBandBusEntry(entry, key)) {
      if (this._isBusTileOnActiveLevelView(key)) return true;
    }

    return false;
  }

  /**
   * Hide/show bus tile albedo during native tile editing.
   *
   * When true, only PIXI tile visuals should be visible to avoid mixed
   * renderer contention (PIXI selection box vs Three albedo mesh).
   * @param {boolean} suppressed
   */
  setTileEditingSuppressed(suppressed) {
    const next = suppressed === true;
    if (this._suppressTileAlbedoForEditing === next) return;
    this._suppressTileAlbedoForEditing = next;
    this._applyTileVisibility();
  }

  /**
   * Show tile meshes up to and including `maxFloorIndex`, hide the rest.
   * Background planes (solid colour + scene image) are always visible.
   *
   * Call this whenever the active floor changes so upper-floor tiles are
   * hidden when the player is on a lower floor.
   *
   * @param {number} maxFloorIndex - Highest floor index to show (inclusive).
   *   Pass Infinity to show all floors.
   */
  setVisibleFloors(maxFloorIndex) {
    if (!this._initialized) return;
    this._visibleMaxFloorIndex = Number.isFinite(Number(maxFloorIndex)) ? Number(maxFloorIndex) : Infinity;
    this._setVisibleFloorsCalls += 1;
    this._lastSetVisibleMaxFloorIndex = this._visibleMaxFloorIndex;
    this._refreshBusTileOverheadClassification();
    this._applyTileVisibility();
    log.debug(`FloorRenderBus: showing floors 0–${maxFloorIndex}`);
    try {
      getTileStreamingManager().onVisibleFloorsChanged(this._visibleMaxFloorIndex);
    } catch (_) {}
  }

  /**
   * Sync runtime tile visual state from TileManager into bus tile materials.
   *
   * V2 renders tile albedo from FloorRenderBus meshes, while hover/occlusion
   * fade animation is currently authored on TileManager sprites. Mirror the
   * effective sprite opacity onto bus materials each frame so overhead hover-hide
   * is visible in the final V2 render.
   */
  /**
   * @param {import('./ReplicaOcclusionMaskPass.js').ReplicaOcclusionMaskPass|null} [occlusionMaskPass]
   */
  syncRuntimeTileState(occlusionMaskPass = null) {
    if (!this._initialized) return;
    const tileManager = window.MapShine?.tileManager;
    if (!tileManager || typeof tileManager.getTileSpriteData !== 'function') return;

    const occBridge = occlusionMaskPass
      ?? window.MapShine?.floorCompositorV2?._replicaOcclusionMaskPass
      ?? window.MapShine?.effectComposer?._floorCompositorV2?._replicaOcclusionMaskPass
      ?? null;

    // V2 bus reads _msRadialCircles from TileManager; TileManager.update() may be
    // sub-rate (EffectComposer updateHz). Refresh circles every compositor sync so
    // radial uniforms match tokens at full frame rate.
    try {
      if (typeof tileManager.syncRadialOcclusionCirclesForBus === 'function') {
        tileManager.syncRadialOcclusionCirclesForBus();
      }
    } catch (_) {
    }

    for (const entry of this._tiles.values()) {
      if (!entry?.material) continue;
      // Skip internal background/effect entries.
      if (entry.isInternal) continue;
      // Tree/Bush/Specular V2 shaders manage their own opacity / visibility; do not mirror
      // PIXI sprite opacity onto additive overlay ShaderMaterials.
      if (entry.isVegetation || entry.isSpecularOverlay) continue;

      const tileId = entry.id;
      const sourceTileId = entry.attachedToTileId || tileId;
      const data = tileManager.getTileSpriteData(sourceTileId);
      const spriteOpacity = Number(data?.sprite?.material?.opacity);
      const fallbackAlpha = Number.isFinite(data?.tileDoc?.alpha) ? data.tileDoc.alpha : 1.0;
      const targetOpacity = Number.isFinite(spriteOpacity) ? spriteOpacity : fallbackAlpha;

      const currentOpacity = Number(entry.material.opacity);
      if (!Number.isFinite(currentOpacity) || Math.abs(currentOpacity - targetOpacity) > 0.0005) {
        entry.material.opacity = targetOpacity;
      }
      // premultipliedAlpha and alphaTest are structural material properties that
      // trigger a full shader recompile when changed (needsUpdate = true). They
      // must only be set during tile creation/upsert, NOT per-frame. Flipping
      // alphaTest between 0 and UPPER_FLOOR_ALPHA_CUTOFF each frame (when
      // opacity oscillates near 0.95 during hover fades) causes visible flicker
      // from repeated shader recompilation. The values are stable by floorIndex,
      // which never changes for a given tile.

      // Shader overlays (e.g. FluidEffectV2) can carry their own tile-opacity
      // uniform path. Keep it in sync with the same runtime tile fade.
      const uniforms = entry.material.uniforms;
      if (uniforms?.uTileOpacity) {
        uniforms.uTileOpacity.value = targetOpacity;
      }

      // Prefer live Foundry TileDocument (v14 occlusion.modes); cached Map Shine tileDoc can lag updates.
      let doc = null;
      try {
        if (sourceTileId && canvas?.scene?.tiles?.get) doc = canvas.scene.tiles.get(sourceTileId) ?? null;
      } catch (_) {
        doc = null;
      }
      if (!doc) doc = data?.tileDoc ?? null;
      if (doc && entry.mesh?.userData && entry.root?.userData) {
        const rl = !!tileDocRestrictsLight(doc);
        if (entry.mesh.userData.restrictsLight !== rl) entry.mesh.userData.restrictsLight = rl;
        if (entry.root.userData.restrictsLight !== rl) entry.root.userData.restrictsLight = rl;
      }

      const tileDocForRadial = doc;
      const syncOcclFlags = tileDocForRadial ? getTileOcclusionModeFlags(tileDocForRadial) : 0;
      const prevOcclFlags = entry._msCachedOcclFlags;
      const occlFlagsUnchanged = prevOcclFlags === syncOcclFlags;
      entry._msCachedOcclFlags = syncOcclFlags;

      const radialOn = !!(syncOcclFlags & CONST.TILE_OCCLUSION_MODES.RADIAL);
      const visionOn = !!(syncOcclFlags & CONST.TILE_OCCLUSION_MODES.VISION);
      const surfaceOn = !!(syncOcclFlags & (CONST.TILE_OCCLUSION_MODES.SURFACE ?? 2));
      const wantsFoundryMask = radialOn || visionOn || surfaceOn;

      // Occlusion uniforms are expensive (shader install + radial circle push).
      // Skip when flags are stable and this tile never needed a mask.
      if (occlFlagsUnchanged && !wantsFoundryMask && !entry._msHadOcclusionMask) {
        continue;
      }
      if (wantsFoundryMask) entry._msHadOcclusionMask = true;

      if (tileDocForRadial && wantsFoundryMask) {
        installBusMeshRadialOcclusionShader(entry.material);
        const busSh = entry.material?.userData?._msBusRadialOcclusionShader;
        const circles = Array.isArray(data?._msRadialCircles) ? data._msRadialCircles : EMPTY_RADIAL_CIRCLES;
        applyRadialOcclusionUniformsToShader(busSh, tileDocForRadial, circles, radialOn);
        applyFoundryOcclusionMaskBusUniforms(busSh, tileDocForRadial, occBridge, true);
      } else {
        entry._msHadOcclusionMask = false;
        const busSh = entry.material?.userData?._msBusRadialOcclusionShader;
        if (busSh) {
          const d = tileDocForRadial || doc;
          if (d) {
            applyRadialOcclusionUniformsToShader(busSh, d, EMPTY_RADIAL_CIRCLES, false);
            applyFoundryOcclusionMaskBusUniforms(busSh, d, occBridge, false);
          } else {
            applyFoundryOcclusionMaskBusUniforms(busSh, null, occBridge, false);
          }
        }
      }
    }
  }

  /**
   * Incrementally create/update a single bus tile from a TileDocument.
   *
   * This is used by TileManager's live refresh/update hooks so V2 albedo tiles
   * track manual Foundry tile edits (drag/create/update) without requiring a
   * full bus repopulate.
   *
   * @param {object} tileDoc
   * @param {object} [options]
   * @param {object|null} [options.foundrySceneData]
   * @returns {boolean}
   */
  upsertTileFromDocument(tileDoc, options = {}) {
    if (!this._initialized || !this._scene || !tileDoc) return false;

    const tileId = tileDoc.id ?? tileDoc._id;
    if (!tileId) return false;

    const sceneData = options.foundrySceneData
      ?? window.MapShine?.sceneComposer?.foundrySceneData
      ?? null;
    if (!sceneData) return false;

    const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
    const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    const floorIndex = this._resolveFloorIndex(tileDoc, floors);
    const worldH = Number(sceneData?.height) || 0;
    const { dispW: tileW, dispH: tileH, signX: planeSignX, signY: planeSignY } = getTileBusPlaneSizeAndMirror(tileDoc);
    const { cx: cxf, cy: cyf } = getTileVisualCenterFoundryXY(tileDoc);
    const centerX = cxf;
    const centerY = worldH - cyf;
    const z = GROUND_Z + floorIndex * Z_PER_FLOOR;
    const alpha = typeof tileDoc.alpha === 'number' ? tileDoc.alpha : 1;
    const rotation = typeof tileDoc.rotation === 'number'
      ? (tileDoc.rotation * Math.PI) / 180
      : 0;
    const isOverhead = this._isOverheadForBusTile(tileDoc, tileId);
    const usesOverheadBand = this._usesOverheadRenderBand(tileDoc, isOverhead);
    const busOverhead = isOverhead || usesOverheadBand;
    const roofShadowCaster = this._usesRoofShadowCaptureLayer(tileDoc, floorIndex, busOverhead);
    const cloudShadowBlockerEnabled = this._shouldTileBlockCloudShadows(tileDoc, busOverhead);
    const motionRenderAboveTokens = !!window.MapShine?.tileMotionManager?.getTileConfig?.(tileId)?.renderAboveTokens;

    const sortWithinFloor = this._computeSortWithinFloor(tileDoc);
    const renderOrder = this._resolveBusTileRenderOrder(
      tileDoc,
      floorIndex,
      isOverhead,
      motionRenderAboveTokens,
      sortWithinFloor,
    );

    const restrictsLight = tileDocRestrictsLight(tileDoc);
    let entry = this._tiles.get(tileId);
    if (!entry) {
      this._addTileMesh(tileId, floorIndex, null, centerX, centerY, z, tileW, tileH, rotation, alpha, renderOrder, busOverhead, roofShadowCaster, cloudShadowBlockerEnabled, planeSignX, planeSignY, restrictsLight);
      entry = this._tiles.get(tileId);
      if (!entry) return false;
    }

    const root = entry.root || entry.mesh?.parent || null;
    if (root) {
      root.position.set(centerX, centerY, z);
      if (root.rotation) root.rotation.z = rotation;
      root.userData = root.userData || {};
      root.userData.isOverhead = busOverhead;
      root.userData.floorIndex = floorIndex;
      root.userData.restrictsLight = !!restrictsLight;
    }

    if (entry.mesh) {
      const params = entry.mesh.geometry?.parameters || {};
      const currentW = Number(params.width);
      const currentH = Number(params.height);
      if (!Number.isFinite(currentW) || !Number.isFinite(currentH)
          || Math.abs(currentW - tileW) > 0.001 || Math.abs(currentH - tileH) > 0.001) {
        try { entry.mesh.geometry?.dispose?.(); } catch (_) {}
        entry.mesh.geometry = new window.THREE.PlaneGeometry(tileW, tileH);
      }

      entry.mesh.scale.set(
        Number.isFinite(planeSignX) && planeSignX !== 0 ? planeSignX : 1,
        Number.isFinite(planeSignY) && planeSignY !== 0 ? planeSignY : 1,
        1,
      );

      entry.mesh.renderOrder = renderOrder;
      entry.mesh.userData = entry.mesh.userData || {};
      entry.mesh.userData.restrictsLight = !!restrictsLight;
      entry.mesh.layers.set(0);
      if (roofShadowCaster) {
        entry.mesh.layers.enable(20);
        if (cloudShadowBlockerEnabled) entry.mesh.layers.enable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
        else entry.mesh.layers.disable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
      } else {
        entry.mesh.layers.disable(20);
        entry.mesh.layers.disable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
      }
      entry.mesh.updateMatrix?.();
    }

    if (root) {
      root.layers.set(0);
      if (roofShadowCaster) {
        root.layers.enable(20);
        if (cloudShadowBlockerEnabled) root.layers.enable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
        else root.layers.disable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
      } else {
        root.layers.disable(20);
        root.layers.disable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
      }
      root.updateMatrix?.();
    }

    entry.roofShadowCaster = !!roofShadowCaster;
    entry.isOverhead = !!busOverhead;
    entry.cloudShadowBlockerEnabled = !!cloudShadowBlockerEnabled;

    if (entry.material) {
      entry.material.userData = entry.material.userData || {};
      entry.material.userData.foundryTileId = tileId;
      entry.material.opacity = alpha;
      entry.material.alphaTest = (floorIndex > 0 && Number(alpha) >= 0.95)
        ? UPPER_FLOOR_ALPHA_CUTOFF
        : 0.0;
      entry.material.transparent = true;
      entry.material.premultipliedAlpha = floorIndex > 0;
      entry.material.needsUpdate = true;
    }

    entry.floorIndex = floorIndex;
    const prevSrc = entry.textureSrc || '';
    entry.textureSrc = src;
    this._classifyTileEntry(tileId, entry);
    this._tiles.set(tileId, entry);

    // IMPORTANT: upserts can happen after setVisibleFloors() (live edits, hooks).
    // Enforce floor-slice visibility immediately so upper-floor tiles do not leak
    // into lower-floor views until the next floor-change event.
    const node = entry.root || entry.mesh || null;
    if (node) {
      node.visible = this._computeEntryVisibleForSlice(tileId, entry);
    }

    if (src && prevSrc !== src) {
      this._loadTileTextureIntoEntry(tileId, src, floorIndex);
    } else {
      void this._evaluateTileStreaming(tileId, entry, floorIndex);
    }

    const entryRadialUpsert = this._tiles.get(tileId);
    const upsertOcclFlags = getTileOcclusionModeFlags(tileDoc);
    const upsertNeedsFoundryShader = !!(upsertOcclFlags
      & (CONST.TILE_OCCLUSION_MODES.RADIAL | CONST.TILE_OCCLUSION_MODES.VISION
        | (CONST.TILE_OCCLUSION_MODES.SURFACE ?? 2)));
    if (entryRadialUpsert?.material && upsertNeedsFoundryShader) {
      installBusMeshRadialOcclusionShader(entryRadialUpsert.material);
    }

    return true;
  }

  /**
   * Build world-space streaming region and layout options from a bus tile entry.
   * @param {string} tileId
   * @param {object} entry
   * @param {number} floorIndex
   * @returns {object|null}
   * @private
   */
  _buildTileStreamingOptions(tileId, entry, floorIndex) {
    if (!entry?.root || !entry?.mesh) return null;

    const geom = entry.mesh.geometry;
    const planeW = Number(geom?.parameters?.width) || 0;
    const planeH = Number(geom?.parameters?.height) || 0;
    if (!(planeW > 0 && planeH > 0)) return null;

    const cx = Number(entry.root.position.x) || 0;
    const cy = Number(entry.root.position.y) || 0;
    const region = {
      minX: cx - planeW / 2,
      maxX: cx + planeW / 2,
      minY: cy - planeH / 2,
      maxY: cy + planeH / 2,
    };
    const fd = window.MapShine?.sceneComposer?.foundrySceneData ?? {};

    return {
      floorIndex,
      region,
      worldH: fd.height ?? planeH,
      z: Number(entry.root.position.z) || 0,
      rotation: Number(entry.root.rotation?.z) || 0,
      isOverhead: this._isOverheadBandBusEntry(entry, tileId),
      roofShadowCaster: !!(entry.roofShadowCaster),
      cloudShadowBlockerEnabled: !!(entry.cloudShadowBlockerEnabled),
      renderOrder: Number(entry.mesh.renderOrder) || 0,
      alpha: typeof entry.material?.opacity === 'number' ? entry.material.opacity : 1,
    };
  }

  /**
   * Keep streamed region grids aligned with live tile create/move/resize/modify flows.
   * @param {string} tileId
   * @param {object} entry
   * @param {number} floorIndex
   * @returns {Promise<boolean>}
   * @private
   */
  async _evaluateTileStreaming(tileId, entry, floorIndex) {
    const src = entry?.textureSrc;
    if (!src || !entry?.root || !entry?.mesh) return false;

    const isOverheadTile = this._isOverheadBandBusEntry(entry, tileId);
    let recoveredOverheadFromBackground = false;
    let recoveredGroundFromBackground = false;
    if (isOverheadTile && entry.mapShineBackgroundStreamServed) {
      recoveredOverheadFromBackground = true;
      entry.mapShineBackgroundStreamServed = false;
      entry.mapShineStreamedRegion = false;
      try { getTileStreamingManager().unregisterBusTile(tileId); } catch (_) {}
    }

    const gen = (this._tileStreamingGen.get(tileId) || 0) + 1;
    this._tileStreamingGen.set(tileId, gen);

    const manager = getTileStreamingManager();
    const budget = getTextureBudgetTracker();
    const streamThreshold = Math.max(4096, budget.getRecommendedTileSize() * 2);
    const rotation = Number(entry.root.rotation?.z) || 0;
    const geom = entry.mesh.geometry;
    const planeW = Number(geom?.parameters?.width) || 0;
    const planeH = Number(geom?.parameters?.height) || 0;
    const wasStreamed = entry.mapShineStreamedRegion || manager.hasBusTile(tileId);

    const releaseStreaming = () => {
      manager.unregisterBusTile(tileId);
      entry.mapShineStreamedRegion = false;
      if (entry.mesh) {
        entry.mesh.visible = this._computeEntryVisibleForSlice(tileId, entry);
      }
    };

    if (!(planeW > 0 && planeH > 0) || Math.abs(rotation) >= 0.001) {
      if (wasStreamed) {
        releaseStreaming();
      }
      if (!entry.material?.map && (wasStreamed || recoveredOverheadFromBackground || recoveredGroundFromBackground)) {
        void this._loadTileAlbedoFromUrlAsync(tileId, src, floorIndex, { forceNonStreaming: true });
      }
      return false;
    }

    const meta = await fetchSourceImageMeta(src);
    if (this._tileStreamingGen.get(tileId) !== gen) return false;

    if (!meta || !shouldStreamBackground(meta.width, meta.height, streamThreshold)) {
      if (wasStreamed) {
        releaseStreaming();
      }
      if (!entry.material?.map && (wasStreamed || recoveredOverheadFromBackground || recoveredGroundFromBackground)) {
        void this._loadTileAlbedoFromUrlAsync(tileId, src, floorIndex, { forceNonStreaming: true });
      }
      return false;
    }

    const options = this._buildTileStreamingOptions(tileId, entry, floorIndex);
    if (!options?.region) return false;

    if (entry.mapShineBackgroundStreamServed && !isOverheadTile) {
      const stillRedundant = manager.isRegionRedundantWithBackground(
        options.region,
        src,
        false,
        meta,
      );
      if (!stillRedundant) {
        recoveredGroundFromBackground = true;
        entry.mapShineBackgroundStreamServed = false;
        entry.mapShineStreamedRegion = false;
        try { manager.unregisterBusTile(tileId); } catch (_) {}
      }
    }

    const streamed = await manager.syncBusTile(this, tileId, src, options);
    if (this._tileStreamingGen.get(tileId) !== gen) return false;

    if (streamed) {
      entry.mapShineStreamedRegion = true;
      if (entry.mesh) {
        entry.mesh.visible = false;
      }
      this._clearBusTileAlbedoMap(entry);
      return true;
    }

    if ((recoveredOverheadFromBackground || recoveredGroundFromBackground)
      && !manager.hasBusTile(tileId) && !entry.material?.map) {
      if (entry.mesh) {
        entry.mesh.visible = this._computeEntryVisibleForSlice(tileId, entry);
      }
      void this._loadTileAlbedoFromUrlAsync(tileId, src, floorIndex, { forceNonStreaming: true });
    }

    if (wasStreamed) releaseStreaming();
    return false;
  }

  /**
   * Remove one bus tile entry (incremental path used by TileManager delete).
   * @param {string} tileId
   */
  removeTile(tileId) {
    if (!tileId) return;

    try {
      getTileStreamingManager().unregisterBusTile(tileId);
    } catch (_) {
    }
    this._tileStreamingGen.delete(tileId);

    const entry = this._tiles.get(tileId);
    if (!entry) return;

    try {
      if (entry.root?.parent) entry.root.parent.remove(entry.root);
      else if (entry.mesh?.parent) entry.mesh.parent.remove(entry.mesh);
      else this._scene?.remove?.(entry.mesh);
    } catch (_) {
    }

    try { entry.mesh?.geometry?.dispose?.(); } catch (_) {}
    try { entry.material?.map?.dispose?.(); } catch (_) {}
    try { entry.material?.dispose?.(); } catch (_) {}

    this._tiles.delete(tileId);
  }

  /**
   * Sync bus tile/overlay opacity to static tile document alpha.
   *
   * Used before overhead shadow capture so shadow masks remain stable even when
   * runtime hover-hide fades are active on the visible albedo/effect pass.
   */
  syncStaticTileAlphaState() {
    if (!this._initialized) return;
    const tileManager = window.MapShine?.tileManager;
    if (!tileManager || typeof tileManager.getTileSpriteData !== 'function') return;

    for (const entry of this._tiles.values()) {
      if (!entry?.material) continue;
      if (entry.isInternal) continue;
      if (entry.isVegetation) continue;

      const tileId = entry.id;
      const sourceTileId = entry.attachedToTileId || tileId;
      const data = tileManager.getTileSpriteData(sourceTileId);
      const staticAlphaRaw = Number(data?.tileDoc?.alpha);
      const staticAlpha = Number.isFinite(staticAlphaRaw) ? staticAlphaRaw : 1.0;

      const currentOpacity = Number(entry.material.opacity);
      if (!Number.isFinite(currentOpacity) || Math.abs(currentOpacity - staticAlpha) > 0.0005) {
        entry.material.opacity = staticAlpha;
      }
      const desiredAlphaTest = (entry.floorIndex > 0 && staticAlpha >= 0.95)
        ? UPPER_FLOOR_ALPHA_CUTOFF
        : 0.0;
      const desiredPremultipliedAlpha = entry.floorIndex > 0;
      if (entry.material.premultipliedAlpha !== desiredPremultipliedAlpha) {
        entry.material.premultipliedAlpha = desiredPremultipliedAlpha;
        entry.material.needsUpdate = true;
      }
      if (Math.abs(Number(entry.material.alphaTest ?? 0) - desiredAlphaTest) > 0.0001) {
        entry.material.alphaTest = desiredAlphaTest;
        entry.material.needsUpdate = true;
      }

      const uniforms = entry.material.uniforms;
      if (uniforms?.uTileOpacity) {
        uniforms.uTileOpacity.value = staticAlpha;
      }
    }
  }

  // ── Floor Mask Rendering ────────────────────────────────────────────────────

  /**
   * Whether a bus tile should count as overhead for water occlusion on its floor.
   * @param {object} entry
   * @returns {boolean}
   * @private
   */
  /**
   * Whether any bus tile on `floorIndex` should contribute to same-floor splash overhead clip.
   * @param {number} floorIndex
   * @returns {boolean}
   */
  hasOverheadTilesForFloor(floorIndex) {
    return this.hasSplashOccluderTilesForFloor(floorIndex);
  }

  /**
   * Whether any tile on `floorIndex` should contribute to post-merge splash clip.
   * @param {number} floorIndex
   * @returns {boolean}
   */
  hasSplashOccluderTilesForFloor(floorIndex) {
    const fi = Number(floorIndex);
    if (!Number.isFinite(fi) || fi < 0) return false;
    for (const [, entry] of this._tiles) {
      if (Number(entry?.floorIndex) !== fi) continue;
      if (this._tileQualifiesAsSplashScreenOccluder(entry)) return true;
    }
    return false;
  }

  /**
   * Tiles that paint above water splashes on the viewed floor (overhead band + high albedo).
   * @param {object} entry
   * @returns {boolean}
   * @private
   */
  _tileQualifiesAsSplashScreenOccluder(entry) {
    if (this._tileQualifiesAsWaterOverhead(entry)) return true;
    if (entry?.root?.userData?._msMotionForcedOverhead) return true;
    const fi = Number(entry?.floorIndex);
    if (!Number.isFinite(fi)) return false;
    const mesh = entry?.mesh || entry?.root?.children?.[0];
    const ro = Number(mesh?.renderOrder);
    if (!Number.isFinite(ro)) return false;
    if (ro > effectUnderOverheadOrder(fi, 50)) return true;
    const highAlbedoRo = tileAlbedoOrder(fi, SPLASH_OCCLUDER_HIGH_ALBEDO_INTRA);
    const effectsBase = fi * RENDER_ORDER_PER_FLOOR + ROLE_OFFSETS.FLOOR_EFFECTS;
    return ro >= highAlbedoRo && ro < effectsBase;
  }

  _tileQualifiesAsWaterOverhead(entry) {
    if (entry?.isOverhead || entry?.roofShadowCaster) return true;
    const node = entry?.root || entry?.mesh;
    const mesh = entry?.mesh || node?.children?.[0];
    if (node?.userData?.isOverhead) return true;
    const tileDoc = this._getFoundryTileDoc(entry?.id);
    if (tileDoc) {
      if (isTileOverhead(tileDoc)) return true;
      if (this._getMsaLevelRole(tileDoc) !== 'floor' && isTileElevatedOnActiveLevelBand(tileDoc)) {
        return true;
      }
    }
    if (!mesh || !Number.isFinite(Number(entry?.floorIndex))) return false;
    const fi = Number(entry.floorIndex);
    const base = fi * RENDER_ORDER_PER_FLOOR;
    const ro = Number(mesh.renderOrder);
    if (!Number.isFinite(ro)) return false;
    return ro >= base + ROLE_OFFSETS.FLOOR_OVERHEAD
      && ro < base + ROLE_OFFSETS.FLOOR_MOTION_TOP;
  }

  /**
   * Render only tiles at `floorIndex >= minFloorIndex` to a target RT.
   * Used to generate an upper-floor occlusion mask for the water effect:
   * wherever the mask has non-zero alpha, ground-floor water is hidden.
   *
   * Temporarily toggles tile visibility, renders, then restores the original
   * visibility state so the main render loop is unaffected.
   *
   * @param {import('three').WebGLRenderer} renderer
   * @param {import('three').Camera} camera
   * @param {number} minFloorIndex - Minimum floor index to include in the mask
   * @param {import('three').WebGLRenderTarget} target - Render target for the mask
   * @param {object} [options]
   * @param {boolean} [options.includeHiddenAboveFloors=false] - When true, temporarily
   *   include tiles hidden only by floor slicing (`floorIndex > _visibleMaxFloorIndex`).
   *   Useful for cross-floor occlusion masks (e.g. cloud shadows under upper floors).
   * @param {boolean} [options.roofCastersOnly=false] - When true, include only tiles
   *   flagged as roof/overhead occluders (`entry.roofShadowCaster`). This avoids
   *   full-screen occlusion from non-occluding upper-floor albedo layers.
   * @param {boolean} [options.overheadTilesOnly=false] - With `roofCastersOnly`,
   *   also include tiles whose bus root has `userData.isOverhead` (Foundry overhead).
   * @param {boolean} [options.includeRoofCaptureLayers=false] - When true, enable
   *   ROOF_LAYER (20) and WEATHER_ROOF_LAYER (21) on the camera for this pass.
   * @param {boolean} [options.roofLayerOnly=false] - When true, render only ROOF_LAYER
   *   (20) + WEATHER_ROOF_LAYER (21) so ground albedo cannot pollute the mask.
   * @param {boolean} [options.includeBackground=false] - When true, include
   *   `__bg_image__*` entries using their stored floorIndex.
   * @param {boolean} [options.backgroundOnly=false] - When true, include only
   *   `__bg_image__*` entries (upper-level background alpha) and exclude tiles.
   * @param {number} [options.maxFloorIndex] - When set, exclude tiles with
   *   `floorIndex` above this value (pairs with `minFloorIndex` for a single slice).
   * @param {number} [options.forceRevealForFloorIndex] - When set, roof/occluder
   *   tiles on this floor are forced visible for the mask pass (ignores view-slice hide).
   * @param {boolean} [options.sourceFloorDeckMask=false] - All tiles on the clamped
   *   floor slice (use with maxFloorIndex), for water punch over river UV overlap.
   * @param {Set<string>|Array<string>} [options.excludeTileIds] - Skip these bus
   *   tile ids (e.g. tiles that own `_Water` mask files).
   * @param {boolean} [options.preserveCameraLayers=false] - When true with
   *   includeRoofCaptureLayers, enable roof layers without `layers.set(0)`.
   */
  renderFloorMaskTo(renderer, camera, minFloorIndex, target, options = {}) {
    if (!this._initialized || !this._scene) return;
    const THREE = window.THREE;
    const includeHiddenAboveFloors = options?.includeHiddenAboveFloors === true;
    const roofCastersOnly = options?.roofCastersOnly === true;
    const overheadTilesOnly = options?.overheadTilesOnly === true;
    const splashOccluderTilesOnly = options?.splashOccluderTilesOnly === true;
    const includeRoofCaptureLayers = options?.includeRoofCaptureLayers === true;
    const roofLayerOnly = options?.roofLayerOnly === true;
    const includeBackground = options?.includeBackground === true;
    const backgroundOnly = options?.backgroundOnly === true;
    const ROOF_LAYER = 20;
    const WEATHER_ROOF_LAYER = 21;
    const maxFloorIndexRaw = options?.maxFloorIndex;
    const hasMaxFloor = Number.isFinite(Number(maxFloorIndexRaw));
    const maxFloorIndex = hasMaxFloor ? Number(maxFloorIndexRaw) : Infinity;
    const forceRevealFloor = Number(options?.forceRevealForFloorIndex);
    const hasForceRevealFloor = Number.isFinite(forceRevealFloor);
    const sourceFloorDeckMask = options?.sourceFloorDeckMask === true;
    const preserveCameraLayers = options?.preserveCameraLayers === true;
    const excludeTileIdsRaw = options?.excludeTileIds;
    const excludeTileIds = excludeTileIdsRaw instanceof Set
      ? excludeTileIdsRaw
      : (Array.isArray(excludeTileIdsRaw) ? new Set(excludeTileIdsRaw) : null);

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevClear = this._saveRendererClearState(renderer);
    const prevLayerMask = camera.layers.mask;

    try {
      for (const [mapKey, entry] of this._tiles) {
        const node = entry?.root || entry?.mesh;
        if (!node) continue;
        this._classifyTileEntry(mapKey, entry);
        const tileId = entry.id || String(mapKey);
        entry._savedVisible = node.visible;

        // Background planes are optional contributors. Internal effect overlays
        // (`__*`, except `__bg_image__*` when includeBackground=true) stay hidden.
        if (excludeTileIds?.has(tileId)) {
          node.visible = false;
          continue;
        }

        if (entry.isInternal) {
          if (!entry.isBgImage || !includeBackground) {
            node.visible = false;
            continue;
          }
          const mat = entry.material;
          const hasMap = !!mat?.map;
          const isBelowFloor = entry.floorIndex < minFloorIndex;
          const isAboveFloor = entry.floorIndex > maxFloorIndex;
          if (isBelowFloor || isAboveFloor || !hasMap) {
            node.visible = false;
            continue;
          }
          node.visible = true;
          const st = entry._maskSavedState || (entry._maskSavedState = {});
          st.active = true;
          st.transparent = mat.transparent;
          st.opacity = mat.opacity;
          st.colorHex = mat.color ? mat.color.getHex() : null;
          st.map = mat.map;
          st.depthTest = mat.depthTest;
          st.depthWrite = mat.depthWrite;
          st.blending = mat.blending;
          if (mat.color) mat.color.set(1, 1, 1);
          // Occluder pass should encode pure authored texture alpha, unaffected
          // by runtime fading/opacity state from the main render path.
          mat.opacity = 1;
          mat.transparent = true;
          mat.depthTest = false;
          mat.depthWrite = false;
          mat.blending = THREE.NormalBlending;
          mat.needsUpdate = true;
          continue;
        }

        // Only tiles AT or ABOVE minFloorIndex should contribute to the occluder.
        // This mask is used to suppress ground-floor water under the currently
        // viewed floor (upper-floor) geometry. Including lower floors here would
        // make the occluder alpha become 1 everywhere (because floor 0 typically
        // covers the entire map), which would incorrectly suppress ALL water.

        const mat = entry.material;
        const hasMap = !!mat?.map;
        const isBelowFloor = entry.floorIndex < minFloorIndex;
        const isAboveFloor = entry.floorIndex > maxFloorIndex;
        const isStreamedParent = !!(entry.mapShineStreamedRegion && !hasMap);
        let includeAsOccluder;
        if (sourceFloorDeckMask) {
          if (isBelowFloor || isAboveFloor || isStreamedParent) {
            node.visible = false;
            continue;
          }
          if (!hasMap) {
            node.visible = false;
            continue;
          }
          // Match renderFloorRangeTo: floor-range membership only. View-slice
          // visibility (background-stream hide, hover-hide) must not drop tiles
          // that already painted into the level scene RT from the water punch.
          includeAsOccluder = true;
        } else if (splashOccluderTilesOnly) {
          includeAsOccluder = this._tileQualifiesAsSplashScreenOccluder(entry);
        } else if (roofLayerOnly || (overheadTilesOnly && !roofCastersOnly)) {
          includeAsOccluder = this._tileQualifiesAsWaterOverhead(entry);
        } else if (roofCastersOnly) {
          includeAsOccluder = !!entry.roofShadowCaster
            || (overheadTilesOnly && this._tileQualifiesAsWaterOverhead(entry));
        } else {
          includeAsOccluder = true;
        }
        const forceThisFloor = hasForceRevealFloor && entry.floorIndex === forceRevealFloor;

        if (backgroundOnly || isBelowFloor || isAboveFloor || !includeAsOccluder) {
          // Below minFloorIndex: do not render into the occluder mask.
          node.visible = false;
        } else {
          // At or above minFloorIndex: skip tiles without textures (avoid opaque black).
          if (!hasMap) {
            node.visible = false;
            continue;
          }
          // Respect the node's current visibility by default. Optionally reveal
          // tiles hidden ONLY by floor slicing so above-floor geometry can still
          // contribute to cross-floor occlusion masks.
          const wasVisible = entry._savedVisible === true;
          const hiddenByFloorSlice = entry.floorIndex > this._visibleMaxFloorIndex;
          const forceRevealForMask = includeHiddenAboveFloors && hiddenByFloorSlice;
          const forceRevealDeckFloor = sourceFloorDeckMask
            || (hasForceRevealFloor && entry.floorIndex === forceRevealFloor);
          node.visible = forceRevealDeckFloor
            ? true
            : (forceThisFloor || wasVisible || forceRevealForMask);
          if (!node.visible) continue;
          // Render with real texture alpha so transparent areas are genuine openings.
          const st = entry._maskSavedState || (entry._maskSavedState = {});
          st.active = true;
          st.transparent = mat.transparent;
          st.opacity = mat.opacity;
          st.colorHex = mat.color ? mat.color.getHex() : null;
          st.map = mat.map;
          st.depthTest = mat.depthTest;
          st.depthWrite = mat.depthWrite;
          st.blending = mat.blending;
          if (mat.color) mat.color.set(1, 1, 1);
          // Occluder pass should encode pure authored texture alpha, unaffected
          // by runtime fading/opacity state from the main render path.
          mat.opacity = 1;
          mat.transparent = true;
          mat.depthTest = false;
          mat.depthWrite = false;
          mat.blending = THREE.NormalBlending;
          mat.needsUpdate = true;
        }
      }

      for (const ch of this._scene?.children ?? []) {
        if (ch?.userData?.type !== 'doorMesh') continue;
        ch._msBusSavedMaskVisible = ch.visible === true;
        ch.visible = false;
      }

      if (roofLayerOnly) {
        camera.layers.set(ROOF_LAYER);
        camera.layers.enable(WEATHER_ROOF_LAYER);
      } else if (preserveCameraLayers && includeRoofCaptureLayers) {
        camera.layers.enable(ROOF_LAYER);
        camera.layers.enable(WEATHER_ROOF_LAYER);
      } else {
        camera.layers.set(0);
        if (includeRoofCaptureLayers) {
          camera.layers.enable(ROOF_LAYER);
          camera.layers.enable(WEATHER_ROOF_LAYER);
        }
      }

      // Clear to transparent black — alpha=0 means "no upper floor coverage".
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0);
      renderer.autoClear = true;
      renderer.render(this._scene, camera);
    } finally {
      camera.layers.mask = prevLayerMask;
      renderer.autoClear = prevAutoClear;
      // CRITICAL (V2): Do not restore a transparent clearAlpha.
      this._restoreRendererClearState(renderer, prevClear, 1);
      renderer.setRenderTarget(prevTarget);

      for (const entry of this._tiles.values()) {
        const node = entry?.root || entry?.mesh;
        if (node && entry._savedVisible !== undefined) node.visible = entry._savedVisible;
        entry._savedVisible = undefined;
      }
      for (const ch of this._scene?.children ?? []) {
        if (ch?._msBusSavedMaskVisible === undefined) continue;
        ch.visible = ch._msBusSavedMaskVisible;
        ch._msBusSavedMaskVisible = undefined;
      }

      for (const entry of this._tiles.values()) {
        const st = entry?._maskSavedState;
        if (!st?.active) continue;
        const mat = entry?.material;
        st.active = false;
        if (!mat) continue;
        mat.transparent = st.transparent;
        mat.opacity = st.opacity;
        if (st.colorHex !== null && mat.color) mat.color.setHex(st.colorHex);
        if ('map' in st) mat.map = st.map;
        mat.depthTest = st.depthTest;
        mat.depthWrite = st.depthWrite;
        mat.blending = st.blending;
      }
    }
  }

  /**
   * Render only tiles with `minFloorIndex <= floorIndex <= maxFloorIndex` to a target RT.
   * Used by FloorDepthBlurEffect to render below-active floors separately from
   * the active floor so per-floor blur can be applied before compositing.
   *
   * @param {import('three').WebGLRenderer} renderer
   * @param {import('three').Camera} camera
   * @param {number} minFloorIndex - Minimum floor index to include (inclusive)
   * @param {number} maxFloorIndex - Maximum floor index to include (inclusive). Pass Infinity for no upper cap.
   * @param {import('three').WebGLRenderTarget} target - Render target
   * @param {object} [options]
   * @param {boolean} [options.includeBackground=true] - Whether to include __bg_* background planes
   * @param {boolean} [options.filterBackgroundByFloor=false] - When true, __bg_image__* planes
   *   are culled by `floorIndex` vs `[minFloorIndex,maxFloorIndex]` and `__bg_solid__` is
   *   always skipped so per-level slices preserve authored transparency holes for
   *   LevelCompositePass (solid underlay would force blended alpha to 1).
   * @param {boolean} [options.clearBeforeRender=true] - Whether to clear target before rendering this range
   * @param {number} [options.clearAlpha=1] - Clear alpha (0 for transparent, 1 for opaque)
   * @param {number} [options.clearColor=0x000000] - Clear colour hex
   * @param {number|null} [options.topVisibleFloorIndexForFire=null] - When non-null and
   *   `minFloorIndex===maxFloorIndex`, `ms_fire_batch_*` uses stacked visibility: a batch at
   *   floor `fi` is drawn into slice `L` iff `fi <= L` (fire on the mask floor and every higher
   *   slice), while other tiles stay strict `L` only. Callers that omit this (e.g. blur) keep
   *   strict `[min,max]` for fire.
   */
  renderFloorRangeTo(renderer, camera, minFloorIndex, maxFloorIndex, target, options = {}) {
    if (!this._initialized || !this._scene) return;
    const {
      includeBackground = true,
      clearBeforeRender = true,
      clearAlpha = 1,
      clearColor = 0x000000,
      filterBackgroundByFloor = false,
      topVisibleFloorIndexForFire = null,
    } = options;

    // Save each tile's current visibility so we can restore it after.
    //
    // IMPORTANT — visibility is set by floor-range membership here, NOT by
    // ANDing with the tile's current `wasVisible`. The per-level pipeline
    // renders EVERY level's RT in a loop, but the bus's slice state
    // (`setVisibleFloors`) reflects only the currently-viewed floor: entries
    // on non-viewed floors are sliced to `visible=false`. If we ANDed with
    // that, every per-level RT except the viewed one would end up empty —
    // the exact "lower floor RT is entirely transparent" symptom we were
    // chasing. Render visibility per-call must depend only on:
    //   1. floor-range membership vs [minFloorIndex, maxFloorIndex]
    //   2. per-call `includeBackground` / `filterBackgroundByFloor` policy
    //   3. the global tile-albedo editing suppression flag
    // All other "wasVisible" state (user toggles, effect gating, warmups)
    // is a view-slice concern and is faithfully restored after the render.
    for (const entry of this._tiles.values()) {
      const node = entry?.root || entry?.mesh;
      if (!node) continue;
      const tileId = entry.id;
      entry._savedVisible = node.visible === true;

      if (entry.isInternal) {
        if (entry.isSolidBg) {
          // Include the opaque world-fill only when floor 0 is in range so
          // upper-floor RTs preserve authored transparency.
          const showSolid = includeBackground
            && (!filterBackgroundByFloor || minFloorIndex <= 0);
          node.visible = showSolid;
          continue;
        }
        if (entry.isBgImageOverlay) {
          node.visible = false;
          continue;
        }
        if (entry.isBgPreBusEffectOverlay) {
          const fi = Number(entry?.floorIndex);
          const inRange = Number.isFinite(fi) && fi >= minFloorIndex && fi <= maxFloorIndex;
          node.visible = includeBackground && inRange && !this._suppressTileAlbedoForEditing;
          continue;
        }
        if (!entry.isBgImage) {
          node.visible = false;
          continue;
        }
        if (filterBackgroundByFloor) {
          const bgFloorIdx = Number(entry.floorIndex);
          const inRange = Number.isFinite(bgFloorIdx) && bgFloorIdx >= minFloorIndex && bgFloorIdx <= maxFloorIndex;
          node.visible = includeBackground && inRange;
        } else {
          // Legacy path (single-RT draw): all bg planes follow includeBackground.
          node.visible = includeBackground;
        }
        continue;
      }

      // Splashes + vegetation are composited after water/bloom (root-scoped overlay draw).
      if (entry.isSplash) {
        node.visible = false;
        continue;
      }
      if (entry.isVegetation) {
        node.visible = false;
        continue;
      }

      const fi = Number(entry?.floorIndex);
      const minFI = Number(minFloorIndex);
      const fireHint = topVisibleFloorIndexForFire;
      const overlayRole = String(entry?.overlayRole || '');
      const isStackedOverlay = overlayRole === 'stackedFloorEffect';
      const isLegacyStackedOverlay = entry.isLegacyStackedOverlay;
      let inRange;
      if (
        (isStackedOverlay || isLegacyStackedOverlay)
        && fireHint != null
        && Number.isFinite(Number(fireHint))
        && Number.isFinite(minFI) && Number.isFinite(Number(maxFloorIndex))
        && minFI === Number(maxFloorIndex)
      ) {
        const L = minFI;
        // Stacked floor overlays: show batch F whenever slice L is at or above F (L >= F).
        // This keeps lower-floor authored effects visible from upper slices while
        // still letting upper authored alpha occlude during source-over composite.
        inRange = Number.isFinite(fi) && fi <= L;
      } else {
        inRange = Number.isFinite(fi) && fi >= minFloorIndex && fi <= maxFloorIndex;
      }
      node.visible = inRange && !this._suppressTileAlbedoForEditing;
    }

    // Door meshes live on the bus scene but are not in `_tiles`; gate them the
    // same way as tiles so per-level RTs do not paint every door on every slice.
    for (const ch of this._scene?.children ?? []) {
      if (ch?.userData?.type !== 'doorMesh') continue;
      ch._msBusSavedVisible = ch.visible === true;
      const fi = Number(ch.userData?.floorIndex);
      const globalDoor = fi === DOOR_FLOOR_INDEX_GLOBAL;
      const inRange = globalDoor
        || (Number.isFinite(fi) && fi >= minFloorIndex && fi <= maxFloorIndex);
      ch.visible = inRange && !this._suppressTileAlbedoForEditing;
    }

    for (const ch of this._scene?.children ?? []) {
      if (ch?.userData?.type !== 'sceneDrawingsRoot') continue;
      for (const drawingGroup of ch.children ?? []) {
        drawingGroup._msBusSavedVisible = drawingGroup.visible === true;
        const fi = Number(drawingGroup?.userData?.floorIndex);
        const inRange = !Number.isFinite(fi)
          || (fi >= minFloorIndex && fi <= maxFloorIndex);
        drawingGroup.visible = inRange && !this._suppressTileAlbedoForEditing;
      }
    }

    // Save and configure renderer state.
    const prevTarget    = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevClear     = this._saveRendererClearState(renderer);
    const prevAlpha     = prevClear.alpha;
    const prevLayerMask = camera.layers.mask;
    camera.layers.set(0);
    for (let i = 1; i <= 19; i++) camera.layers.enable(i);

    try {
      renderer.setRenderTarget(target);
      renderer.setClearColor(clearColor, clearAlpha);
      renderer.autoClear = !!clearBeforeRender;
      renderer.render(this._scene, camera);
    } finally {
      // Restore camera and renderer state.
      camera.layers.mask = prevLayerMask;
      renderer.autoClear = prevAutoClear;
      this._restoreRendererClearState(renderer, prevClear, prevAlpha);
      renderer.setRenderTarget(prevTarget);

      // Restore original tile visibility.
      for (const entry of this._tiles.values()) {
        const node = entry?.root || entry?.mesh;
        if (node && entry._savedVisible !== undefined) node.visible = entry._savedVisible;
        entry._savedVisible = undefined;
      }
      for (const ch of this._scene?.children ?? []) {
        if (ch?._msBusSavedVisible !== undefined) {
          ch.visible = ch._msBusSavedVisible;
          ch._msBusSavedVisible = undefined;
        }
        if (ch?.userData?.type !== 'sceneDrawingsRoot') continue;
        for (const drawingGroup of ch.children ?? []) {
          if (drawingGroup?._msBusSavedVisible === undefined) continue;
          drawingGroup.visible = drawingGroup._msBusSavedVisible;
          drawingGroup._msBusSavedVisible = undefined;
        }
      }
    }
  }

  /**
   * Map texture for the bus `__bg_image__*` plane whose `floorIndex` matches the
   * given scene floor index (same field used by `renderFloorRangeTo` when
   * `filterBackgroundByFloor` is true). Used for experiments such as post-merge
   * water punched by the **current** level background alpha only.
   *
   * @param {number} floorIndex - `FloorBand.index` / per-level `levelIndex`
   * @returns {import('three').Texture|null}
   */
  getBackgroundImageMapForFloorIndex(floorIndex) {
    const fi = Number(floorIndex);
    if (!Number.isFinite(fi)) return null;
    for (const [tileId, entry] of this._tiles) {
      if (!isBackgroundImageAlbedoBusKey(tileId)) continue;
      if (Number(entry?.floorIndex) !== fi) continue;
      const map = entry?.material?.map ?? null;
      return map || null;
    }
    return null;
  }

  /**
   * Map texture for the bus key `__bg_image__` (stack 0) or `__bg_image__${stackIndex}`.
   * Keys follow V14 level index from `_loadVisibleBackgroundStack`, not necessarily
   * contiguous stack positions when only some floors have background art.
   *
   * @param {number} stackIndex - Same index used in the bus key (`__bg_image__${stackIndex}`)
   * @returns {import('three').Texture|null}
   */
  getBackgroundImageMapForStackIndex(stackIndex) {
    const si = Math.max(0, Math.floor(Number(stackIndex)));
    if (!Number.isFinite(si)) return null;
    const key = si === 0 ? '__bg_image__' : `__bg_image__${si}`;
    const entry = this._tiles.get(key);
    return entry?.material?.map ?? null;
  }

  // ── Effect Overlay API ──────────────────────────────────────────────────────

  /**
   * Add an effect overlay mesh to the bus scene. The mesh participates in the
   * same floor visibility system as albedo tiles — setVisibleFloors() will
   * automatically show/hide it based on floorIndex.
   *
   * @param {string} key - Unique key for this overlay (e.g. `${tileId}_specular`)
   * @param {import('three').Mesh} mesh - The overlay mesh (already configured with material, position, etc.)
   * @param {number} floorIndex - Floor this overlay belongs to
   * @param {{ overlayRole?: string }} [options] - Optional overlay semantics for per-level rendering.
   */
  addEffectOverlay(key, mesh, floorIndex, options = {}) {
    if (!this._initialized || !this._scene) return;
    // Remove existing overlay with the same key to avoid duplicates.
    if (this._tiles.has(key)) {
      this.removeEffectOverlay(key);
    }
    this._scene.add(mesh);
    const entry = {
      mesh,
      material: mesh.material,
      floorIndex,
      root: null,
      attachedToTileId: null,
      overlayRole: String(options?.overlayRole || ''),
    };
    this._classifyTileEntry(key, entry);
    this._tiles.set(key, entry);
    mesh.visible = this._computeEntryVisibleForSlice(key, entry);
    log.debug(`FloorRenderBus: added effect overlay '${key}' (floor ${floorIndex})`);
  }

  /**
   * Attach an overlay mesh under a tile's transform root so it inherits runtime
   * tile motion (rotation/orbit/etc.) automatically.
   *
   * @param {string} tileId
   * @param {string} key - Unique overlay key (e.g. `${tileId}_specular`)
   * @param {import('three').Object3D} mesh
   * @param {number} floorIndex
   * @param {{ overlayRole?: string }} [options]
   * @returns {boolean}
   */
  addTileAttachedOverlay(tileId, key, mesh, floorIndex, options = {}) {
    if (!this._initialized || !this._scene || !tileId || !key || !mesh) return false;

    const tileEntry = this._tiles.get(tileId);
    if (!tileEntry) return false;

    if (this._tiles.has(key)) {
      this.removeEffectOverlay(key);
    }

    const parent = tileEntry.root || tileEntry.mesh?.parent || this._scene;
    if (!parent) return false;
    parent.add(mesh);
    const entry = {
      mesh,
      material: mesh.material,
      floorIndex,
      root: null,
      attachedToTileId: tileId,
      overlayRole: String(options?.overlayRole || ''),
    };
    this._classifyTileEntry(key, entry);
    this._tiles.set(key, entry);
    mesh.visible = this._computeEntryVisibleForSlice(key, entry);
    log.debug(`FloorRenderBus: added tile-attached overlay '${key}' -> ${tileId} (floor ${floorIndex})`);
    return true;
  }

  /**
   * Remove an effect overlay mesh from the bus scene and dispose its resources.
   *
   * @param {string} key - The key used when the overlay was added
   */
  removeEffectOverlay(key) {
    if (!this._scene) return;
    const entry = this._tiles.get(key);
    if (!entry) return;
    if (entry.mesh?.parent) {
      entry.mesh.parent.remove(entry.mesh);
    } else {
      this._scene.remove(entry.mesh);
    }
    // Don't dispose material/geometry here — the effect owns those resources
    // and disposes them in its own clear()/dispose() methods.
    this._tiles.delete(key);
    log.debug(`FloorRenderBus: removed effect overlay '${key}'`);
  }

  // ── Private Helpers ──────────────────────────────────────────────────────────

  /**
   * Resolve overhead classification for bus tiles.
   *
   * In addition to native/levels overhead docs, tile-motion can force tiles into
   * roof-style draw ordering via renderAboveTokens. Mirror that flag here so V2
   * bus renderOrder/layers stay aligned with TileManager behavior.
   *
   * @param {object} tileDoc
   * @param {string|null} tileId
   * @returns {boolean}
   * @private
   */
  _getMsaLevelRole(tileDoc) {
    return String(tileDoc?.flags?.['map-shine-advanced']?.levelRole ?? '')
      .trim()
      .toLowerCase();
  }

  /**
   * Upper-floor walkable art (Levels `levelRole: floor`) is not "overhead" for
   * token sorting, but it should still stamp ROOF_LAYER for overhead shadows
   * when it reads as the deck above a lower view. Opt-in without levelRole via
   * tile flag `floorCastsOverheadShadow`.
   * @param {object} tileDoc
   * @param {number} floorIndex
   * @returns {boolean}
   * @private
   */
  _isUpperFloorSlabRoofCaster(tileDoc, floorIndex) {
    if (!(floorIndex > 0)) return false;
    if (this._getMsaLevelRole(tileDoc) === 'floor') return true;
    const moduleId = 'map-shine-advanced';
    const raw = tileDoc?.getFlag?.(moduleId, 'floorCastsOverheadShadow')
      ?? tileDoc?.flags?.[moduleId]?.floorCastsOverheadShadow;
    return raw === true;
  }

  /**
   * @param {object} tileDoc
   * @param {number} floorIndex
   * @param {boolean} isOverheadForBus
   * @returns {boolean}
   * @private
   */
  _usesRoofShadowCaptureLayer(tileDoc, floorIndex, isOverheadForBus) {
    return !!isOverheadForBus || this._isUpperFloorSlabRoofCaster(tileDoc, floorIndex);
  }

  /**
   * V14 native tiles use elevation for primary canvas ordering and no longer
   * expose a stable TileDocument#overhead boolean. Within the active level band,
   * elevated non-floor tiles should therefore use the overhead bus path.
   * @param {object} tileDoc
   * @returns {boolean}
   * @private
   */
  _isActiveLevelElevatedBusTile(tileDoc) {
    try {
      if (this._getMsaLevelRole(tileDoc) === 'floor') return false;
      if (!this._hasFiniteActiveLevelBand(window.MapShine?.activeLevelContext)) return false;
      if (!this._isBusTileOnActiveLevelView(tileDoc?.id ?? tileDoc?._id)) return false;
      return isTileElevatedOnActiveLevelBand(tileDoc);
    } catch (_) {
      return false;
    }
  }

  _isOverheadForBusTile(tileDoc, tileId = null) {
    const msaRole = this._getMsaLevelRole(tileDoc);
    if (msaRole === 'ceiling') return true;
    // Foundry overhead (v14 getter / elevation split) wins over levelRole:floor.
    if (isTileOverhead(tileDoc)) return true;
    if (msaRole === 'floor') return false;
    if (this._isActiveLevelElevatedBusTile(tileDoc)) return true;

    const resolvedTileId = tileId ?? tileDoc?.id ?? tileDoc?._id ?? null;
    const motionConfig = resolvedTileId
      ? window.MapShine?.tileMotionManager?.getTileConfig?.(resolvedTileId)
      : null;
    const renderAboveTokens = !!motionConfig?.renderAboveTokens;

    return renderAboveTokens;
  }

  /**
   * Whether a tile belongs to the active level band (walkable floor art on the
   * current perspective). Mirrors TileManager.updateSpriteTransform so overhead
   * classification stays aligned with sprite-side behavior.
   * @param {object} tileDoc
   * @returns {boolean}
   * @private
   */
  _treatAsCurrentFloorForBusTile(tileDoc) {
    try {
      const activeLevelContext = window.MapShine?.activeLevelContext;
      const scene = globalThis.canvas?.scene;
      if (!(hasV14NativeLevels(scene) || isLevelsEnabledForScene(scene))
        || !this._hasFiniteActiveLevelBand(activeLevelContext)) {
        return false;
      }

      const bandBottom = Number(activeLevelContext.bottom);
      const bandTop = Number(activeLevelContext.top);
      const tileElevation = Number(tileDoc?.elevation);

      if (hasV14NativeLevels(scene) && activeLevelContext.levelId && tileDoc?.levels?.size) {
        return tileDoc.levels.has(activeLevelContext.levelId);
      }

      if (tileHasLevelsRange(tileDoc)) {
        const flags = readTileLevelsFlags(tileDoc);
        const tileBottom = Number(flags.rangeBottom);
        const tileTop = Number(flags.rangeTop);
        if (Number.isFinite(tileBottom) && Number.isFinite(tileTop)) {
          return !(tileTop <= bandBottom || tileBottom >= bandTop);
        }
      }

      if (Number.isFinite(tileElevation)) {
        return tileElevation >= bandBottom && tileElevation < bandTop;
      }
    } catch (_) {
    }
    return false;
  }

  /**
   * @param {object|null|undefined} context
   * @returns {boolean}
   * @private
   */
  _hasFiniteActiveLevelBand(context) {
    if (!context || typeof context !== 'object') return false;
    const bottom = Number(context.bottom);
    const top = Number(context.top);
    return Number.isFinite(bottom) && Number.isFinite(top);
  }

  /**
   * High-elevation floor-role slabs stack above lower overhead art in world space
   * even though they are not overhead for token sorting.
   * @param {object} tileDoc
   * @param {boolean} isOverhead
   * @returns {boolean}
   * @private
   */
  _usesOverheadRenderBand(tileDoc, isOverhead) {
    if (isOverhead) return true;
    const elev = Number.isFinite(Number(tileDoc?.elevation)) ? Number(tileDoc.elevation) : 0;
    if (elev <= 0) return false;
    const fg = getCanvasForegroundElevationSplit();
    // Walkable floor slabs use the foreground split; other elevated art on the
    // active level (bridges, props) stacks in the overhead band above water.
    if (this._getMsaLevelRole(tileDoc) === 'floor') return elev > fg;
    if (isTileElevatedOnActiveLevelBand(tileDoc)) return true;
    return elev > fg;
  }

  /**
   * @param {object} tileDoc
   * @param {number} floorIndex
   * @param {boolean} isOverhead
   * @param {boolean} motionRenderAboveTokens
   * @param {number} sortWithinFloor
   * @returns {number}
   * @private
   */
  _resolveBusTileRenderOrder(
    tileDoc,
    floorIndex,
    isOverhead,
    motionRenderAboveTokens,
    sortWithinFloor,
  ) {
    if (motionRenderAboveTokens) {
      const sort01 = Math.max(0, Math.min(1, sortWithinFloor / MAX_SORT_WITHIN_FLOOR_GROUP));
      return motionAboveTokensOrder(floorIndex, Math.round(sort01 * 49));
    }
    if (this._usesOverheadRenderBand(tileDoc, isOverhead)) {
      return tileOverheadOrder(floorIndex, sortWithinFloor);
    }
    return tileAlbedoOrder(floorIndex, sortWithinFloor);
  }

  /**
   * Determine whether this tile should clip cloud shadows in CloudEffect.
   *
   * @param {object} tileDoc
   * @param {boolean} isOverhead
   * @returns {boolean}
   * @private
   */
  _shouldTileBlockCloudShadows(tileDoc, isOverhead) {
    if (!isOverhead || !tileDoc) return false;
    const moduleId = 'map-shine-advanced';
    const getFlag = (key) => tileDoc.getFlag?.(moduleId, key) ?? tileDoc.flags?.[moduleId]?.[key];
    const isWeatherRoof = !!getFlag('overheadIsRoof');
    if (isWeatherRoof) return false;
    const cloudShadowsEnabledRaw = getFlag('cloudShadowsEnabled');
    const cloudShadowsEnabled = (cloudShadowsEnabledRaw === undefined) ? true : !!cloudShadowsEnabledRaw;
    return !cloudShadowsEnabled;
  }

  /**
   * SceneComposer owns this GPU texture — bus must never dispose it on clear().
   * @param {import('three').Texture|null|undefined} tex
   * @private
   */
  _markSharedComposerTexture(tex) {
    if (!tex) return;
    tex.userData = tex.userData || {};
    tex.userData.mapShineSharedComposerTexture = true;
  }

  /**
   * @param {{ material?: import('three').Material|null, mesh?: import('three').Object3D|null, root?: import('three').Object3D|null }} entry
   * @returns {boolean}
   * @private
   */
  _busEntryMapReady(entry) {
    const map = entry?.material?.map ?? null;
    return !!(map?.image && map.image.width > 0 && map.image.height > 0);
  }

  /**
   * True when a full-scene `__bg_image__*` plane (not streamed cells) is resident.
   *
   * @param {string} [key='__bg_image__']
   * @returns {boolean}
   */
  _hasDirectBackgroundImagePlane(key = '__bg_image__') {
    const base = String(key || '__bg_image__');
    const direct = this._tiles.get(base);
    if (!direct || !this._busEntryMapReady(direct)) return false;
    if (direct.root?.visible === false) return false;
    return direct.mesh?.visible !== false;
  }

  /**
   * True when the bus has a visible textured draw for a background grid key
   * (`__bg_image__`, streamed cells, or streaming fallback).
   *
   * @param {string} [key='__bg_image__']
   * @returns {boolean}
   */
  _hasBackgroundAlbedoCoverage(key = '__bg_image__') {
    const base = String(key || '__bg_image__');
    const direct = this._tiles.get(base);
    if (direct && this._busEntryMapReady(direct)) {
      if (direct.root?.visible === false) return false;
      if (direct.mesh?.visible !== false) return true;
    }
    const fallback = this._tiles.get(`${base}__fallback`);
    if (fallback && this._busEntryMapReady(fallback) && fallback.mesh?.visible !== false) {
      return true;
    }
    const prefix = `${base}:cell:`;
    for (const [busKey, entry] of this._tiles) {
      if (!String(busKey).startsWith(prefix)) continue;
      if (entry?.mesh?.visible === false) continue;
      if (this._busEntryMapReady(entry)) return true;
    }
    return false;
  }

  /**
   * Mount the viewed level background on the bus from SceneComposer's albedo texture
   * when it is ready and matches the viewed level URL. Single-floor scenes only.
   *
   * @param {import('../scene/composer.js').SceneComposer} sceneComposer
   * @param {object} fd
   * @param {{ viewedLevelIndex?: number }} [options]
   * @returns {boolean}
   */
  tryMountViewedBackgroundFromComposer(sceneComposer, fd, options = {}) {
    if (!this._initialized || !fd || !sceneComposer) return false;

    const scene = canvas?.scene ?? null;
    const bgSrc = String(getViewedLevelBackgroundSrc(scene) || scene?.background?.src || '').trim();
    if (!bgSrc) return false;

    const floors = window.MapShine?.floorStack?.getFloors() ?? [];
    const nativeLevelCount = scene?.levels?.size ?? 0;
    const multiFloorV14 = !!(hasV14NativeLevels(scene) && (floors.length > 1 || nativeLevelCount > 1));
    if (multiFloorV14) return false;

    let floorIdx = resolveV14BackgroundFloorIndexForSrc(scene, bgSrc);
    floorIdx = finalizeBackgroundFloorIndexForBus(scene, bgSrc, floorIdx, {
      loadCount: 1,
      floorsLen: floors.length,
      viewedBg: bgSrc,
      viewedLevelIndexOverride: options.viewedLevelIndex,
    });
    const key = backgroundBusKeyForFloorIndex(floorIdx);
    if (this._hasDirectBackgroundImagePlane(key)) return true;

    const bgTexture = sceneComposer?._albedoTexture ?? null;
    const albedoImageReady = !!(bgTexture?.image && bgTexture.image.width > 0 && bgTexture.image.height > 0);
    if (!albedoImageReady || !_composerAlbedoMatchesViewedBg(bgTexture, bgSrc)) return false;

    this._markSharedComposerTexture(bgTexture);
    this._addBackgroundImage(fd, bgTexture, floorIdx, key);
    this._applyTileVisibility();
    log.info(`FloorRenderBus: mounted viewed background from SceneComposer [${key}]`);
    return true;
  }

  /**
   * Retry mounting the viewed background from SceneComposer until pixels are ready
   * or the bus already has albedo coverage.
   *
   * @param {import('../scene/composer.js').SceneComposer} sceneComposer
   * @param {object} fd
   * @param {{ bgSrc?: string, floorIdx?: number, key?: string, viewedLevelIndex?: number }} [ctx]
   * @private
   */
  _scheduleViewedBackgroundComposerRetry(sceneComposer, fd, ctx = {}) {
    const tickEpoch = this._bgDecodeEpoch;
    const key = String(ctx.key || '__bg_image__');
    let frames = 0;
    const maxFrames = 180;
    const tick = () => {
      if (this._bgDecodeEpoch !== tickEpoch) return;
      frames += 1;
      try {
        if (this._hasBackgroundAlbedoCoverage(key)) return;
        if (this.tryMountViewedBackgroundFromComposer(sceneComposer, fd, {
          viewedLevelIndex: ctx.viewedLevelIndex,
        })) return;
      } catch (_) {}
      if (frames < maxFrames && this._bgDecodeEpoch === tickEpoch) {
        requestAnimationFrame(tick);
      } else if (frames >= maxFrames) {
        log.warn(`FloorRenderBus: viewed background [${key}] still missing after composer retry`);
      }
    };
    requestAnimationFrame(tick);
  }

  /**
   * @param {import('three').Material|import('three').Material[]|null|undefined} mat
   * @private
   */
  _disposeBusMaterial(mat) {
    if (!mat) return;
    const mats = Array.isArray(mat) ? mat : [mat];
    for (const m of mats) {
      if (!m) continue;
      this._releaseMaterialTexture(m.map);
      this._releaseMaterialTexture(m.alphaMap);
      try { m.dispose?.(); } catch (_) {}
    }
  }

  /**
   * @param {import('three').Texture|null|undefined} tex
   * @private
   */
  _releaseMaterialTexture(tex) {
    if (!tex) return;
    try {
      const ud = tex.userData || {};
      if (ud.mapShineSharedComposerTexture || ud.mapShineSharedExternalTexture) return;
      if (ud.mapShineTextureOwned) {
        getTextureBudgetTracker().unregister(tex);
      }
      tex.dispose?.();
    } catch (_) {}
  }

  /**
   * Add a solid-colour plane covering the full world canvas at the lowest Z.
   * Ensures no transparent black shows in padding areas.
   * @param {object} fd - foundrySceneData
   * @private
   */
  _addSolidBackground(fd) {
    const THREE = window.THREE;
    const worldW = fd.width ?? 0;
    const worldH = fd.height ?? 0;
    if (worldW <= 0 || worldH <= 0) return;

    let bgColorInt = 0x999999;
    try {
      bgColorInt = parseInt((fd.backgroundColor || '#999999').replace('#', ''), 16) || 0x999999;
    } catch (_) {}

    const mat = new THREE.MeshBasicMaterial({
      color: bgColorInt,
      depthTest: false,
      depthWrite: false,
    });
    const geom = new THREE.PlaneGeometry(worldW, worldH);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = 'BusBg_solid';
    mesh.frustumCulled = false;
    // Keep the opaque world-fill behind all floor content.
    mesh.renderOrder = tileAlbedoOrder(0, 0);
    // Center of world canvas in Three Y-up space.
    mesh.position.set(worldW / 2, worldH / 2, GROUND_Z - 2);
    this._scene.add(mesh);
    // Store in _tiles so clear() disposes it and setVisibleFloors always shows it.
    this._tiles.set('__bg_solid__', this._classifyTileEntry('__bg_solid__', { mesh, material: mat, floorIndex: 0 }));
    log.debug(`FloorRenderBus: solid bg plane (${worldW}x${worldH}, #${bgColorInt.toString(16)})`);
  }

  /**
   * Add the scene background image plane at Z just above the solid colour plane.
   * Uses the texture already loaded by SceneComposer — no extra network fetch.
   *
   * The background image is opaque and covers only the scene rect (not padding).
   * SceneComposer's basePlaneMesh uses scale.y=-1 to flip Y; we mirror that here
   * with DoubleSide so the back-face isn't culled.
   *
   * @param {object} fd - foundrySceneData
   * @param {import('three').Texture} texture
   * @private
   */
  _addBackgroundImage(fd, texture, zIndex = 0, key = '__bg_image__') {
    const THREE = window.THREE;
    const sceneW = fd.sceneWidth ?? fd.width ?? 0;
    const sceneH = fd.sceneHeight ?? fd.height ?? 0;
    const worldH = fd.height ?? 0;
    if (sceneW <= 0 || sceneH <= 0) return;

    // Scene rect center in Three Y-up world space.
    const sceneX = fd.sceneX ?? 0;
    const sceneY = fd.sceneY ?? 0;
    const centerX = sceneX + sceneW / 2;
    const centerY = worldH - (sceneY + sceneH / 2);

    // Ensure flipY=false to match SceneComposer's UV convention (Y-flip via
    // scale.y=-1 on the mesh instead of on the texture).
    texture.flipY = false;
    texture.needsUpdate = true;

    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      // V14 visible-level stacks rely on texture alpha so upper level art can
      // reveal lower levels through cutouts/openings.
      transparent: true,
      depthTest: false,
      depthWrite: false,
      // Rely on authored albedo alpha only (Foundry level alphaThreshold is not
      // applied here). alphaTest would fight RGBA holes for per-level composite.
      alphaTest: 0,
      // DoubleSide because scale.y=-1 reverses face winding.
      side: THREE.DoubleSide,
    });
    const geom = new THREE.PlaneGeometry(sceneW, sceneH);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = 'BusBg_image';
    mesh.frustumCulled = false;
    const bgFloorIndex = Number.isFinite(Number(zIndex)) ? Number(zIndex) : 0;
    // Background images participate in per-floor albedo ordering so upper-floor
    // background art can occlude lower-floor effect overlays (e.g. fire).
    mesh.renderOrder = tileAlbedoOrder(bgFloorIndex, 0);
    mesh.position.set(centerX, centerY, GROUND_Z - 1 + (Number(zIndex) || 0) * 0.01);
    // Negative Y scale to flip the image right-side up (matches basePlaneMesh).
    mesh.scale.set(1, -1, 1);
    this._scene.add(mesh);
    // Store in _tiles so clear() disposes it and setVisibleFloors always shows it.
    // Preserve stack order as floor index so floor-aware mask passes (water occluder)
    // can include only upper visible background layers.
    this._tiles.set(key, this._classifyTileEntry(key, { mesh, material: mat, floorIndex: bgFloorIndex }));
    this._detachStreamingBackgroundForKey(key);
    log.info(`FloorRenderBus: bg image plane [${key}] (${sceneW}x${sceneH} at ${centerX},${centerY})`);
  }

  /**
   * Remove streamed background cells/fallback once a full-scene plane owns the key.
   * Coarse cells stacked on a composer/fallback plane fight the lit albedo pass.
   *
   * @param {string} key
   * @private
   */
  _detachStreamingBackgroundForKey(key) {
    const base = String(key || '__bg_image__');
    if (!isBackgroundImageAlbedoBusKey(base)) return;
    try {
      getTileStreamingManager().unregisterGrid(base);
    } catch (_) {}
    const prefix = `${base}:cell:`;
    const fallbackKey = `${base}__fallback`;
    for (const busKey of [...this._tiles.keys()]) {
      const s = String(busKey);
      if (!s.startsWith(prefix) && s !== fallbackKey) continue;
      const entry = this._tiles.get(busKey);
      if (entry?.mesh) {
        entry.mesh.removeFromParent();
        entry.mesh.geometry?.dispose?.();
        this._disposeBusMaterial(entry.material);
      }
      this._tiles.delete(busKey);
    }
    log.info(`FloorRenderBus: detached streaming overlays for [${base}]`);
  }

  /**
   * Add a full-scene foreground (overhead) image plane for a V14 level.
   * Rendered in the FLOOR_OVERHEAD band above ground tiles and tokens.
   *
   * @param {object} fd
   * @param {import('three').Texture} texture
   * @param {number} floorIndex
   * @param {string} key
   * @private
   */
  _addForegroundImage(fd, texture, floorIndex = 0, key = '__fg_image__') {
    const THREE = window.THREE;
    const sceneW = fd.sceneWidth ?? fd.width ?? 0;
    const sceneH = fd.sceneHeight ?? fd.height ?? 0;
    const worldH = fd.height ?? 0;
    if (sceneW <= 0 || sceneH <= 0) return;

    const sceneX = fd.sceneX ?? 0;
    const sceneY = fd.sceneY ?? 0;
    const centerX = sceneX + sceneW / 2;
    const centerY = worldH - (sceneY + sceneH / 2);

    texture.flipY = false;
    texture.needsUpdate = true;

    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      alphaTest: 0,
      side: THREE.DoubleSide,
    });
    const geom = new THREE.PlaneGeometry(sceneW, sceneH);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = 'BusFg_image';
    mesh.frustumCulled = false;
    const fgFloorIndex = Number.isFinite(Number(floorIndex)) ? Number(floorIndex) : 0;
    mesh.renderOrder = tileOverheadOrder(fgFloorIndex, 0);
    mesh.position.set(centerX, centerY, GROUND_Z + fgFloorIndex * Z_PER_FLOOR + 0.02);
    mesh.scale.set(1, -1, 1);
    mesh.userData = mesh.userData || {};
    mesh.userData.isOverhead = true;
    mesh.userData.mapShineBusTile = true;
    mesh.userData.floorIndex = fgFloorIndex;
    this._scene.add(mesh);
    this._tiles.set(key, this._classifyTileEntry(key, {
      mesh,
      material: mat,
      floorIndex: fgFloorIndex,
      isOverhead: true,
    }));
    log.info(`FloorRenderBus: fg/overhead image plane [${key}] (${sceneW}x${sceneH})`);
  }

  /**
   * Replace the background image texture with a new one (e.g. when switching
   * between V14 levels that have different per-level backgrounds).
   *
   * @param {string} src - New image path to load
   * @param {object} fd  - foundrySceneData (for dimensions)
   * @param {{ viewedLevelIndex?: number }} [swapOpts] - Optional FloorStack band index
   *   from `mapShineLevelContextChanged` so floor placement stays correct before `canvas.level` commits.
   */
  swapBackgroundImage(src, fd, swapOpts = {}) {
    if (!this._initialized || !fd) return;
    const scene = globalThis.canvas?.scene ?? null;
    const visibleLayers = getVisibleLevelBackgroundLayers(scene);
    if (visibleLayers.length > 0) {
      this.swapVisibleLevelBackgroundImages(visibleLayers, fd, swapOpts);
      return;
    }
    if (!src) return;
    this.swapVisibleLevelBackgroundImages([{ src, alphaThreshold: 0 }], fd, swapOpts);
  }

  /**
   * Replace the entire visible-level background stack.
   *
   * @param {Array<string|{src:string, alphaThreshold?:number, sort?: number}>} srcsOrLayers
   * @param {object} fd
   * @param {{ skipFirst?: boolean, viewedLevelIndex?: number }} [options]
   */
  swapVisibleLevelBackgroundImages(srcsOrLayers, fd, options = {}) {
    if (!this._initialized || !fd || !Array.isArray(srcsOrLayers) || srcsOrLayers.length === 0) return;
    this._removeBackgroundImageEntries();
    this._loadVisibleBackgroundStack(srcsOrLayers, fd, options);
  }

  /**
   * Replace foreground (overhead) level images for the visible stack.
   *
   * @param {Array<string|{src:string, sort?: number}>} srcsOrLayers
   * @param {object} fd
   * @param {{ skipFirst?: boolean, viewedLevelIndex?: number }} [options]
   */
  swapVisibleLevelForegroundImages(srcsOrLayers, fd, options = {}) {
    if (!this._initialized || !fd || !Array.isArray(srcsOrLayers) || srcsOrLayers.length === 0) return;
    this._removeForegroundImageEntries();
    this._loadVisibleForegroundStack(srcsOrLayers, fd, options);
  }

  /**
   * Swap the viewed level foreground image (V14 overhead layer art).
   *
   * @param {string} src
   * @param {object} fd
   * @param {{ viewedLevelIndex?: number }} [swapOpts]
   */
  swapForegroundImage(src, fd, swapOpts = {}) {
    if (!this._initialized || !fd) return;
    this.syncForegroundStackFromScene(fd, swapOpts, src);
  }

  /**
   * Remove all background image entries (`__bg_image__*`).
   * @private
   */
  _removeBackgroundImageEntries() {
    this._bgDecodeEpoch += 1;
    try {
      const manager = getTileStreamingManager();
      for (const gridKey of [...manager.getGrids().keys()]) {
        if (!isBackgroundImageAlbedoBusKey(gridKey)) continue;
        manager.unregisterGrid(gridKey);
      }
    } catch (_) {}
    const keys = [];
    for (const key of this._tiles.keys()) {
      if (isBackgroundStreamingBusTileKey(key)) keys.push(String(key));
    }
    for (const key of keys) {
      const existing = this._tiles.get(key);
      if (existing?.mesh) {
        existing.mesh.removeFromParent();
        existing.mesh.geometry?.dispose?.();
        existing.material?.dispose?.();
      }
      this._tiles.delete(key);
    }
  }

  /**
   * Remove all foreground image entries (`__fg_image__*`).
   * @private
   */
  _removeForegroundImageEntries() {
    this._fgDecodeEpoch += 1;
    try {
      const manager = getTileStreamingManager();
      for (const gridKey of [...manager.getGrids().keys()]) {
        if (!isForegroundImageAlbedoBusKey(gridKey)) continue;
        manager.unregisterGrid(gridKey);
      }
    } catch (_) {}
    const keys = [];
    for (const key of this._tiles.keys()) {
      if (isForegroundStreamingBusTileKey(key)) keys.push(String(key));
    }
    for (const key of keys) {
      const existing = this._tiles.get(key);
      if (existing?.mesh) {
        existing.mesh.removeFromParent();
        existing.mesh.geometry?.dispose?.();
        existing.material?.dispose?.();
      }
      this._tiles.delete(key);
    }
  }

  /**
   * Load and add all visible foreground (overhead) layers in order.
   * @param {Array<string|{src:string, sort?: number}>} srcsOrLayers
   * @param {object} fd
   * @param {{skipFirst?: boolean, viewedLevelIndex?: number}} [options]
   * @private
   */
  _loadVisibleForegroundStack(srcsOrLayers, fd, options = {}) {
    const list = Array.isArray(srcsOrLayers) ? srcsOrLayers : [];
    const { skipFirst = false, viewedLevelIndex } = options;
    if (!list.length) return;
    const scene = globalThis.canvas?.scene ?? null;
    let loadCount = 0;
    for (let i = 0; i < list.length; i += 1) {
      if (skipFirst && i === 0) continue;
      const raw = list[i];
      const src = (typeof raw === 'string') ? String(raw).trim() : String(raw?.src || '').trim();
      if (src) loadCount += 1;
    }
    const floorsLen = (window.MapShine?.floorStack?.getFloors?.() ?? []).length;
    const viewedFg = String(getViewedLevelForegroundSrc(scene) || '').trim();

    for (let i = 0; i < list.length; i += 1) {
      if (skipFirst && i === 0) continue;
      const raw = list[i];
      const src = (typeof raw === 'string') ? String(raw).trim() : String(raw?.src || '').trim();
      if (!src) continue;
      let floorIdx = resolveV14ForegroundFloorIndexForSrc(scene, src);
      floorIdx = finalizeBackgroundFloorIndexForBus(scene, src, floorIdx, {
        loadCount,
        floorsLen,
        viewedBg: viewedFg,
        viewedLevelIndexOverride: viewedLevelIndex,
      });
      const key = foregroundBusKeyForFloorIndex(floorIdx);
      this._loadFgImageStraightAlpha(src, fd, floorIdx, key);
    }
  }

  /**
   * @param {string} src
   * @param {object} fd
   * @param {number} floorIndex
   * @param {string} key
   * @private
   */
  _loadFgImageStraightAlpha(src, fd, floorIndex, key) {
    const decodeEpochAtSchedule = this._fgDecodeEpoch;
    const bus = this;

    const job = (async () => {
      if (decodeEpochAtSchedule !== bus._fgDecodeEpoch) return;

      const budget = getTextureBudgetTracker();
      const streamThreshold = Math.max(4096, budget.getRecommendedTileSize() * 2);
      const meta = await fetchSourceImageMeta(src);
      if (decodeEpochAtSchedule !== bus._fgDecodeEpoch) return;

      const renderOrderBase = tileOverheadOrder(floorIndex, 0);

      if (meta && shouldStreamBackground(meta.width, meta.height, streamThreshold)) {
        const streamed = await getTileStreamingManager().registerBackground(
          bus, src, fd, floorIndex, key, { renderOrderBase },
        );
        if (streamed && decodeEpochAtSchedule === bus._fgDecodeEpoch) {
          bus._applyTileVisibility();
          log.info(`FloorRenderBus: streaming foreground [${key}] (${meta.width}x${meta.height})`);
          return;
        }
      }

      const maxSize = budget.backgroundMaxSize ?? 4096;
      let tex = await loadFallbackTexture(src, maxSize);
      if (!tex) {
        if (meta && isHugeImageSource(meta.width, meta.height, maxSize * 2)) {
          log.warn(`FloorRenderBus: refusing full-image decode for huge foreground [${key}]`);
          return;
        }
        try {
          tex = await loadImageTexture(src, {
            role: 'TILE_ALBEDO',
            maxSize,
            premultiplyAlpha: 'none',
          });
        } catch (err) {
          log.warn(`FloorRenderBus: fg load failed [${key}] ${src}`, err);
          return;
        }
      }
      if (!tex || decodeEpochAtSchedule !== bus._fgDecodeEpoch) return;

      getTextureBudgetTracker().register(
        tex,
        `bus:fg:${key}`,
        estimateTextureBytes(tex.image?.width ?? 512, tex.image?.height ?? 512, 'ubyte'),
        { source: 'busForeground' },
      );
      bus._addForegroundImage(fd, tex, floorIndex, key);
      bus._applyTileVisibility();
      log.info(`FloorRenderBus: fg loaded [${key}]`);
    })();

    this._pendingBackgroundJobs.add(job);
    void job.finally(() => {
      this._pendingBackgroundJobs.delete(job);
    });
  }

  /**
   * Load and add all visible background layers in order.
   * Each layer is placed at the V14 level index that owns that `background.src`
   * ({@link resolveV14BackgroundFloorIndexForSrc}). Foundry's `_configureLevelTextures`
   * `sort` field is **texture stack order**, not native level index — it must not
   * be used as `floorIndex` or upper-floor albedo is culled from `renderFloorRangeTo`.
   * For a **single-URL** load when resolve returns 0 (e.g. first populate before
   * `scene.levels` is hydrated) but the URL matches {@link getViewedLevelBackgroundSrc},
   * {@link finalizeBackgroundFloorIndexForBus} pins from `canvas.level` / {@link getViewedV14Level}.
   *
   * @param {Array<string|{src:string, alphaThreshold?:number, sort?: number}>} srcsOrLayers
   * @param {object} fd
   * @param {{skipFirst?: boolean, viewedLevelIndex?: number}} [options]
   * @private
   */
  _loadVisibleBackgroundStack(srcsOrLayers, fd, options = {}) {
    const list = Array.isArray(srcsOrLayers) ? srcsOrLayers : [];
    const { skipFirst = false, viewedLevelIndex } = options;
    if (!list.length) return;
    const scene = globalThis.canvas?.scene ?? null;
    let loadCount = 0;
    for (let i = 0; i < list.length; i += 1) {
      if (skipFirst && i === 0) continue;
      const raw = list[i];
      const src = (typeof raw === 'string') ? String(raw).trim() : String(raw?.src || '').trim();
      if (src) loadCount += 1;
    }
    const floorsLen = (window.MapShine?.floorStack?.getFloors?.() ?? []).length;
    const viewedBg = String(getViewedLevelBackgroundSrc(scene) || '').trim();

    for (let i = 0; i < list.length; i += 1) {
      if (skipFirst && i === 0) continue;
      const raw = list[i];
      const src = (typeof raw === 'string') ? String(raw).trim() : String(raw?.src || '').trim();
      if (!src) continue;
      let floorIdx = resolveV14BackgroundFloorIndexForSrc(scene, src);
      floorIdx = finalizeBackgroundFloorIndexForBus(scene, src, floorIdx, {
        loadCount,
        floorsLen,
        viewedBg,
        viewedLevelIndexOverride: viewedLevelIndex,
      });
      const key = backgroundBusKeyForFloorIndex(floorIdx);
      this._loadBgImageStraightAlpha(src, fd, floorIdx, key);
    }
  }

  /**
   * Load a `__bg_image__*` background layer and upload it to the GPU with
   * *straight-alpha* pixel data, bypassing every browser-decode path that
   * could premultiply alpha into RGB.
   *
   * ## Why this elaborate path exists
   *
   * Straight-alpha `WebP` backgrounds (authored with non-zero RGB under
   * `alpha=0` texels — the normal case for maps painted in Photoshop /
   * Affinity) lose their alpha channel at the GPU when decoded through
   * the "normal" paths used across three.js:
   *
   *   - `THREE.TextureLoader` → wraps `HTMLImageElement`. Browsers decode
   *     `<img>` into a premultiplied internal buffer as an optimisation.
   *     `gl.texImage2D` then uploads premultiplied RGB tagged as
   *     straight-alpha, producing sampled alpha = 1 wherever authored
   *     RGB was non-zero but alpha was 0.
   *   - `THREE.ImageBitmapLoader` + `premultiplyAlpha: 'none'` → *should*
   *     produce straight-alpha data, but in practice the behaviour
   *     depends on the browser's WebP decoder honouring that option. On
   *     Firefox in particular, some WebP files still come through as
   *     effectively premultiplied. We cannot rely on this path to fix
   *     the alpha bug deterministically.
   *
   * ## How this path works
   *
   *   1. Load the source into an `HTMLImageElement` (uses the browser's
   *      WebP decoder — same as before).
   *   2. Draw it into a 2D canvas. The canvas backing store may or may
   *      not premultiply internally — **we do not care**.
   *   3. Call `CanvasRenderingContext2D.getImageData`. By W3C spec, this
   *      *always* returns straight-alpha RGBA in `Uint8ClampedArray`,
   *      regardless of the backing store's internal representation. Any
   *      browser-side premultiply is undone here.
   *   4. Wrap the byte buffer in a `THREE.DataTexture` with
   *      `premultiplyAlpha: false`. `DataTexture` uploads the raw bytes
   *      to the GPU via `gl.texImage2D(… , pixels)`, and with
   *      `UNPACK_PREMULTIPLY_ALPHA_WEBGL = false` the GPU sees the
   *      exact straight-alpha bytes we assembled in step 3.
   *
   * ## Memory cost
   *
   * One transient `Uint8ClampedArray` of size `4 * width * height`
   * (~211 MB for a 10650×4950 map). That allocation is released after
   * the DataTexture is constructed — the GPU keeps its own copy. Peak
   * memory during load is higher than with `TextureLoader` but steady
   * state is identical.
   *
   * @param {string} src
   * @param {object} fd
   * @param {number} zIndex
   * @param {string} key
   * @private
   */
  _loadBgImageStraightAlpha(src, fd, zIndex, key) {
    const THREE = window.THREE;
    if (!THREE) return;
    const decodeEpochAtSchedule = this._bgDecodeEpoch;
    const bus = this;

    const job = (async () => {
      if (decodeEpochAtSchedule !== bus._bgDecodeEpoch) return;

      const budget = getTextureBudgetTracker();
      const streamThreshold = Math.max(4096, budget.getRecommendedTileSize() * 2);
      const meta = await fetchSourceImageMeta(src);
      if (decodeEpochAtSchedule !== bus._bgDecodeEpoch) return;

      if (meta && shouldStreamBackground(meta.width, meta.height, streamThreshold)) {
        // Streaming is the whole point of large maps — always prefer it when the
        // source qualifies. Bigger scenes benefit MORE, not less.
        const renderOrderBase = tileAlbedoOrder(
          Number.isFinite(Number(zIndex)) ? Number(zIndex) : 0,
          0,
        );
        const streamed = await getTileStreamingManager().registerBackground(
          bus, src, fd, zIndex, key, { renderOrderBase },
        );
        if (streamed && decodeEpochAtSchedule === bus._bgDecodeEpoch) {
          bus._applyTileVisibility();
          if (bus._hasBackgroundAlbedoCoverage(key)) {
            log.info(
              `FloorRenderBus: streaming background [${key}] (${meta.width}x${meta.height})`,
            );
            return;
          }
          log.warn(
            `FloorRenderBus: streaming [${key}] registered without bus albedo coverage`
            + ` (${meta.width}x${meta.height}) — installing downscaled fallback plane`,
          );
        }
      }

      if (decodeEpochAtSchedule !== bus._bgDecodeEpoch) return;
      if (bus._hasBackgroundAlbedoCoverage(key)) {
        bus._applyTileVisibility();
        return;
      }

      const maxSize = budget.backgroundMaxSize ?? 4096;
      let tex = await loadFallbackTexture(src, maxSize);
      if (!tex) {
        if (meta && isHugeImageSource(meta.width, meta.height, maxSize * 2)) {
          log.warn(
            `FloorRenderBus: refusing full-image decode for huge background [${key}] (${meta.width}x${meta.height})`,
          );
          return;
        }
        try {
          tex = await loadImageTexture(src, {
            role: 'ALBEDO',
            maxSize,
            premultiplyAlpha: 'none',
          });
        } catch (err) {
          log.warn(`FloorRenderBus: bg load failed [${key}] ${src}`, err);
          return;
        }
      }
      if (!tex || decodeEpochAtSchedule !== bus._bgDecodeEpoch) return;

      getTextureBudgetTracker().register(
        tex,
        `bus:bg:${key}`,
        estimateTextureBytes(tex.image?.width ?? 512, tex.image?.height ?? 512, 'ubyte'),
        { source: 'busBackground' },
      );
      bus._addBackgroundImage(fd, tex, zIndex, key);
      bus._applyTileVisibility();
      log.info(
        `FloorRenderBus: bg loaded [${key}]`
        + (meta ? ` (${meta.width}x${meta.height} → ${tex.image?.width ?? '?'}x${tex.image?.height ?? '?'})` : ''),
      );
    })();

    this._pendingBackgroundJobs.add(job);
    void job.finally(() => {
      this._pendingBackgroundJobs.delete(job);
    });
  }

  /**
   * Await all in-flight background image / streaming mount jobs started by populate.
   * @returns {Promise<void>}
   */
  async awaitBackgroundStreamingReady() {
    const pending = [...this._pendingBackgroundJobs];
    if (!pending.length) return;
    await Promise.allSettled(pending);
  }

  /**
   * Create a tile mesh and add it to the single bus scene.
   * Texture starts null and is filled in by the TextureLoader callback.
   *
   * @param {string} tileId
   * @param {number} floorIndex
   * @param {import('three').Texture|null} texture
   * @param {number} cx - world-space center X
   * @param {number} cy - world-space center Y (Three Y-up)
   * @param {number} z  - world-space Z
   * @param {number} w  - tile width in world units
   * @param {number} h  - tile height in world units
   * @param {number} rotation - radians around Z
   * @param {number} alpha
   * @param {boolean} isOverhead - draw-order / userData (PIXI parity), not necessarily ROOF_LAYER
   * @param {boolean} roofShadowCaster - ROOF_LAYER + optional cloud blocker (overhead or upper-floor slab)
   * @param {number} [planeSignX=1] - Horizontal mirror (texture.scaleX sign)
   * @param {number} [planeSignY=1] - Vertical mirror (texture.scaleY sign)
   * @private
   */
  _addTileMesh(tileId, floorIndex, texture, cx, cy, z, w, h, rotation, alpha, renderOrder = 0, isOverhead = false, roofShadowCaster = false, cloudShadowBlockerEnabled = false, planeSignX = 1, planeSignY = 1, restrictsLight = false) {
    const THREE = window.THREE;
    const mat = new THREE.MeshBasicMaterial({
      map: texture || null,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      opacity: alpha,
      alphaTest: (floorIndex > 0 && Number(alpha) >= 0.95) ? UPPER_FLOOR_ALPHA_CUTOFF : 0.0,
      premultipliedAlpha: floorIndex > 0,
    });
    mat.userData = mat.userData || {};
    mat.userData.foundryTileId = tileId;

    const geom = new THREE.PlaneGeometry(w, h);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = `BusTile_${tileId}`;
    mesh.frustumCulled = false;
    mesh.userData = mesh.userData || {};
    mesh.userData.foundryTileId = tileId;
    mesh.userData.mapShineBusTile = true;
    mesh.userData.restrictsLight = !!restrictsLight;
    const root = new THREE.Group();
    root.name = `BusTileRoot_${tileId}`;
    root.frustumCulled = false;
    root.userData = root.userData || {};
    root.userData.foundryTileId = tileId;
    root.userData.mapShineBusTile = true;
    root.userData.isOverhead = isOverhead;
    root.userData.floorIndex = floorIndex;
    root.userData.restrictsLight = !!restrictsLight;

    // Layer conventions:
    // - Layer 0: normal bus rendering (FloorCompositor camera enables it)
    // - Layer 20: roof capture pass for OverheadShadowsEffectV2
    root.layers.set(0);
    mesh.layers.set(0);
    if (roofShadowCaster) {
      root.layers.enable(20);
      // IMPORTANT: camera layer tests are evaluated on renderable objects
      // (the mesh), not only parent groups. Keep ROOF_LAYER on the mesh so
      // OverheadShadowsEffectV2 roof capture pass can actually see overhead tiles.
      mesh.layers.enable(20);
      // Cloud shadow blocker layer — CloudEffectV2 renders only this layer
      // to build the blocker mask, avoiding per-frame full-scene traversal.
      if (cloudShadowBlockerEnabled) {
        root.layers.enable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
        mesh.layers.enable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
      } else {
        root.layers.disable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
        mesh.layers.disable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
      }
    }

    root.position.set(cx, cy, z);
    root.rotation.z = rotation;
    mesh.position.set(0, 0, 0);
    mesh.rotation.z = 0;
    mesh.scale.set(Number.isFinite(planeSignX) && planeSignX !== 0 ? planeSignX : 1, Number.isFinite(planeSignY) && planeSignY !== 0 ? planeSignY : 1, 1);
    // renderOrder controls visual stacking: lower = behind, higher = in front.
    // Three.js sorts transparent objects by renderOrder first, then by distance.
    mesh.renderOrder = renderOrder;

    root.add(mesh);
    this._scene.add(root);
    const entry = this._classifyTileEntry(tileId, {
      mesh,
      material: mat,
      floorIndex,
      root,
      attachedToTileId: null,
      textureSrc: '',
      isOverhead: !!isOverhead,
      roofShadowCaster: !!roofShadowCaster,
      cloudShadowBlockerEnabled: !!cloudShadowBlockerEnabled,
    });
    this._tiles.set(tileId, entry);

    // New entries must immediately honor current visible floor slice.
    root.visible = this._computeEntryVisibleForSlice(tileId, entry);
  }

  /**
   * Load/replace the tile albedo texture for an existing bus tile entry.
   * @param {string} tileId
   * @param {string} src
   * @param {number} floorIndex
   * @private
   */
  _loadTileTextureIntoEntry(tileId, src, floorIndex) {
    if (!src || !tileId) return;
    this._loadTileAlbedoFromUrl(tileId, src, floorIndex);
  }

  /**
   * Load tile albedo via off-thread decode (createImageBitmap).
   * @param {string} tileId
   * @param {string} src
   * @param {number} floorIndex
   * @private
   */
  _loadTileAlbedoFromUrl(tileId, src, floorIndex) {
    if (!src || !tileId) return;
    const entry = this._tiles.get(tileId);
    if (entry) entry.textureSrc = src;

    void this._loadTileAlbedoFromUrlAsync(tileId, src, floorIndex);
  }

  /**
   * @param {string} tileId
   * @param {string} src
   * @param {number} floorIndex
   * @private
   */
  async _loadTileAlbedoFromUrlAsync(tileId, src, floorIndex, options = {}) {
    const forceNonStreaming = options.forceNonStreaming === true;
    const budget = getTextureBudgetTracker();
    const maxSize = resolveTileAlbedoMaxSize(budget);
    const entry = this._tiles.get(tileId);

    if (!forceNonStreaming && entry?.root && entry?.mesh) {
      const streamed = await this._evaluateTileStreaming(tileId, entry, floorIndex);
      if (streamed) {
        log.info(`FloorRenderBus: streaming bus tile [${tileId}] (live sync)`);
        return;
      }
    } else if (forceNonStreaming || entry?.mapShineStreamedRegion || entry?.mapShineBackgroundStreamServed) {
      try {
        getTileStreamingManager().unregisterBusTile(tileId);
      } catch (_) {
      }
      if (entry) {
        entry.mapShineStreamedRegion = false;
        entry.mapShineBackgroundStreamServed = false;
      }
    }

    let tex = null;

    try {
      tex = await loadImageTexture(src, { role: 'TILE_ALBEDO', maxSize });
    } catch (err) {
      log.warn(`FloorRenderBus: loadImageTexture failed for tile ${tileId}`, err);
    }

    if (!tex) {
      try {
        tex = await loadImageTexture(src, { role: 'TILE_ALBEDO', maxSize, tryFoundryCache: false });
      } catch (err) {
        log.warn(`FloorRenderBus: loadImageTexture retry failed for tile ${tileId}`, err);
      }
    }

    if (!tex && window.THREE) {
      try {
        const url = normalizeTextureUrl(src);
        tex = await new Promise((resolve, reject) => {
          new window.THREE.TextureLoader().load(url, resolve, undefined, reject);
        });
        applyTexturePolicy(tex, 'TILE_ALBEDO');
        tex.userData = tex.userData || {};
        tex.userData.mapShineTextureOwned = true;
        tex.userData.mapShineDecodePath = 'TextureLoader-fallback';
        tex.needsUpdate = true;
        log.warn(`FloorRenderBus: TextureLoader fallback (unbounded) for tile ${tileId}`);
      } catch (err) {
        log.warn(`FloorRenderBus: TextureLoader fallback failed for tile ${tileId}: ${src}`, err);
        return;
      }
    }

    if (!tex) return;
    this._applyTileAlbedoTexture(tileId, src, tex);
    getTextureBudgetTracker().enforceBudget();
    log.info(`FloorRenderBus: tile albedo ready ${tileId} (${tex.image?.width ?? '?'}x${tex.image?.height ?? '?'})`);
  }

  /**
   * @param {string} tileId
   * @param {string} src
   * @param {import('three').Texture} tex
   * @private
   */
  _applyTileAlbedoTexture(tileId, src, tex) {
    const entry = this._tiles.get(tileId);
    if (!entry || entry.textureSrc !== src) {
      try { tex?.dispose?.(); } catch (_) {}
      return;
    }
    this._configureTileAlbedoTexture(tex);
    try { entry.material?.map?.dispose?.(); } catch (_) {}
    entry.material.map = tex;
    entry.material.needsUpdate = true;
    entry.mapShineStreamedRegion = false;
    entry.mapShineBackgroundStreamServed = false;
    const node = entry.root || entry.mesh;
    if (node) {
      node.visible = this._computeEntryVisibleForSlice(tileId, entry);
    }
    try { this._applyTileVisibility(); } catch (_) {}
    try {
      const w = tex.image?.width ?? tex.image?.naturalWidth ?? 0;
      const h = tex.image?.height ?? tex.image?.naturalHeight ?? 0;
      if (w > 0 && h > 0) {
        getTextureBudgetTracker().register(
          tex,
          `bus:tile:${tileId}`,
          estimateTextureBytes(w, h, 'ubyte'),
          { source: 'busTile' },
        );
      }
    } catch (_) {}
  }

  /**
   * Configure tile albedo texture sampling to reduce alpha fringe growth.
   *
   * Transparent tile textures can show stepped dark halos when mipmaps are
   * generated from dark RGB in fully-transparent texels. Disable mipmaps for
   * bus tile albedo and clamp edge sampling to keep silhouettes stable.
   *
   * @param {import('three').Texture|null} tex
   * @private
   */
  _configureTileAlbedoTexture(tex) {
    if (!tex) return;
    const THREE = window.THREE;
    tex.colorSpace = THREE?.SRGBColorSpace ?? tex.colorSpace;
    tex.flipY = true;
    tex.generateMipmaps = false;
    tex.minFilter = THREE?.LinearFilter ?? tex.minFilter;
    tex.magFilter = THREE?.LinearFilter ?? tex.magFilter;
    tex.wrapS = THREE?.ClampToEdgeWrapping ?? tex.wrapS;
    tex.wrapT = THREE?.ClampToEdgeWrapping ?? tex.wrapT;
    tex.premultiplyAlpha = true;
    tex.needsUpdate = true;
  }

  /**
   * Resolve Foundry tile sort with cross-version fallback.
   * @param {object} tileDoc
   * @returns {number}
   * @private
   */
  _getTileSortValue(tileDoc) {
    const rawSort = Number(tileDoc?.sort ?? tileDoc?.z);
    return Number.isFinite(rawSort) ? rawSort : 0;
  }

  /**
   * Map Foundry sort values into the floor-local render-order slot range.
   * @param {object} tileDoc
   * @returns {number}
   * @private
   */
  _computeSortWithinFloor(tileDoc) {
    const elev = Number.isFinite(Number(tileDoc?.elevation)) ? Number(tileDoc.elevation) : 0;
    const sort = this._getTileSortValue(tileDoc);
    const center = MAX_SORT_WITHIN_FLOOR_GROUP / 2;
    // Elevation dominates intra-band stacking (matches GpuSceneMaskCompositor);
    // Foundry sort/z is the tie-breaker at equal elevation.
    const ELEVATION_STEP = 10;
    const raw = elev * ELEVATION_STEP + sort;
    return Math.max(
      0,
      Math.min(MAX_SORT_WITHIN_FLOOR_GROUP, Math.round(raw + center)),
    );
  }

  /**
   * Resolve which floor index a tile belongs to by reading its Levels elevation
   * flags directly. No FloorLayerManager wiring required.
   *
   * @param {object} tileDoc - Foundry TileDocument
   * @param {Array} floors - Ordered floor bands from FloorStack
   * @returns {number} Floor index (0-based)
   * @private
   */
  _resolveFloorIndex(tileDoc, floors) {
    if (!floors || floors.length <= 1) return 0;

    if (tileHasLevelsRange(tileDoc)) {
      const flags = readTileLevelsFlags(tileDoc);
      const tileBottom = Number(flags.rangeBottom);
      const tileTop = Number(flags.rangeTop);
      const tileMid = (tileBottom + tileTop) / 2;

      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        if (tileMid >= f.elevationMin && tileMid < f.elevationMax) return i;
      }
      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        if (tileBottom <= f.elevationMax && f.elevationMin <= tileTop) return i;
      }
    }

    const v14Idx = resolveV14NativeDocFloorIndexMin(tileDoc, globalThis.canvas?.scene);
    if (v14Idx !== null) return v14Idx;

    try {
      if (hasV14NativeLevels(globalThis.canvas?.scene)) {
        const singleLevel = tileDoc?.level ?? tileDoc?._source?.level;
        if (typeof singleLevel === 'string' && singleLevel.length > 0) {
          for (let i = 0; i < floors.length; i += 1) {
            if (floors[i].levelId === singleLevel) return i;
          }
        }
        const levelsSet = tileDoc?.levels;
        if (levelsSet?.size) {
          for (const lid of levelsSet) {
            for (let i = 0; i < floors.length; i += 1) {
              if (floors[i].levelId === lid) return i;
            }
          }
        }
      }
    } catch (_) {}

    const elev = Number.isFinite(Number(tileDoc?.elevation)) ? Number(tileDoc.elevation) : 0;
    const byElev = resolveFloorIndexForElevation(elev, floors);
    if (byElev >= 0) return byElev;
    return 0;
  }

  /**
   * Re-sync overhead band / roof-capture flags after active level or floor slice changes.
   * @private
   */
  _refreshBusTileOverheadClassification() {
    if (!this._initialized) return;
    const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    for (const [mapKey, entry] of this._tiles) {
      if (entry?.isInternal) continue;
      const tileId = String(mapKey);
      const tileDoc = this._getFoundryTileDoc(tileId);
      if (!tileDoc) continue;
      const floorIndex = this._resolveFloorIndex(tileDoc, floors);
      const isOverhead = this._isOverheadForBusTile(tileDoc, tileId);
      const usesOverheadBand = this._usesOverheadRenderBand(tileDoc, isOverhead);
      const busOverhead = isOverhead || usesOverheadBand;
      const roofShadowCaster = this._usesRoofShadowCaptureLayer(tileDoc, floorIndex, busOverhead);
      const cloudShadowBlockerEnabled = this._shouldTileBlockCloudShadows(tileDoc, busOverhead);
      const motionRenderAboveTokens = !!window.MapShine?.tileMotionManager?.getTileConfig?.(tileId)?.renderAboveTokens;
      const sortWithinFloor = this._computeSortWithinFloor(tileDoc);
      const renderOrder = this._resolveBusTileRenderOrder(
        tileDoc,
        floorIndex,
        isOverhead,
        motionRenderAboveTokens,
        sortWithinFloor,
      );

      entry.floorIndex = floorIndex;
      entry.isOverhead = !!busOverhead;
      entry.roofShadowCaster = !!roofShadowCaster;
      entry.cloudShadowBlockerEnabled = !!cloudShadowBlockerEnabled;

      const root = entry.root || entry.mesh?.parent || null;
      if (root) {
        root.userData = root.userData || {};
        root.userData.isOverhead = busOverhead;
        root.userData.floorIndex = floorIndex;
        root.layers.set(0);
        if (roofShadowCaster) root.layers.enable(20);
        else root.layers.disable(20);
      }
      if (entry.mesh) {
        entry.mesh.renderOrder = renderOrder;
        entry.mesh.layers.set(0);
        if (roofShadowCaster) {
          entry.mesh.layers.enable(20);
          if (cloudShadowBlockerEnabled) entry.mesh.layers.enable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
          else entry.mesh.layers.disable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
        } else {
          entry.mesh.layers.disable(20);
          entry.mesh.layers.disable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
        }
      }
    }
  }

  // ── Layer Order Diagnostics ────────────────────────────────────────────────

  /**
   * Dump all bus scene children sorted by renderOrder with decoded role info.
   * Call from console: `MapShine.renderBus.dumpLayerOrder()`
   * @returns {Array<{name: string, renderOrder: number, floor: number, role: string, intraOffset: number, visible: boolean}>}
   */
  dumpLayerOrder() {
    if (!this._scene) {
      log.warn('dumpLayerOrder: no scene');
      return [];
    }
    const entries = [];
    this._scene.traverse((obj) => {
      if (obj.renderOrder === undefined) return;
      const decoded = formatRenderOrder(obj.renderOrder);
      entries.push({
        name: obj.name || obj.uuid?.slice(0, 8) || '(anon)',
        renderOrder: obj.renderOrder,
        decoded,
        visible: obj.visible,
        layerMask: obj.layers?.mask,
      });
    });
    entries.sort((a, b) => a.renderOrder - b.renderOrder);
    const lines = entries.map(e =>
      `${String(e.renderOrder).padStart(8)} | ${e.decoded} | vis=${e.visible} | layers=0x${(e.layerMask ?? 0).toString(16)} | ${e.name}`
    );
    log.info(`Layer order dump (${entries.length} objects):\n` + lines.join('\n'));
    return entries;
  }

}

