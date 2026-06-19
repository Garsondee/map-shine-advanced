/**
 * @fileoverview Frustum-driven tile streaming orchestrator for FloorRenderBus backgrounds.
 * @module streaming/tile-streaming-manager
 */

import { createLogger } from '../core/log.js';
import { normalizeTextureUrl } from '../assets/image-texture-loader.js';
import { resolveStreamingViewRect, getCameraGroundCenter, viewRectIntersectsScene } from './view-projection-service.js';
import { selectLodFromZoom } from './streaming-grid.js';
import {
  StreamedBackgroundGrid,
  StreamedRegionGrid,
  shouldStreamBackground,
} from './streamed-background-grid.js';
import { fetchSourceImageMeta, clearPyramidMemoryCaches, loadFallbackTexture, warmPyramidForManifest } from './texture-pyramid-builder.js';
import { getTextureBudgetTracker } from '../assets/TextureBudgetTracker.js';
import { estimateSceneMegapixels } from './texture-budget-policy.js';
import { lodToDetailTier } from './streaming-detail-api.js';
import { getVisibleStreamingCellKeys } from './vegetation-streaming-bridge.js';
import { getGpuWorkScheduler } from './gpu-work-scheduler.js';
import { getAdaptiveBudgetController } from './adaptive-budget-controller.js';
import { noteRendererTextureSample } from '../core/texture-leak-probe.js';

const log = createLogger('TileStreamingManager');

/** @param {string} key */
function isBackgroundStreamingGridKey(key) {
  return /^__bg_image__$|^__bg_image__[1-9]\d*$/.test(String(key || ''));
}

/** @param {string} key */
function isForegroundStreamingGridKey(key) {
  return /^__fg_image__$|^__fg_image__[1-9]\d*$/.test(String(key || ''));
}

/** Ground speed (world units/sec) above which pan mode activates. */
const PAN_SPEED_THRESHOLD = 800;
/** Consecutive fast frames before pan mode engages. */
const PAN_FRAMES_REQUIRED = 2;
/** Milliseconds below speed threshold before sharpen resumes after pan. */
const PAN_STOP_MS = 200;
/** Pause tile decode while floor visibility / camera projection stabilizes. */
const FLOOR_TRANSITION_PAUSE_MS = 500;
/** Longer pause when multiple background pyramids are registered (multi-floor). */
const FLOOR_TRANSITION_PAUSE_MULTI_MS = 900;
/** Max concurrent cell loads across all streaming grids (144+ MP scenes). */
const GLOBAL_INFLIGHT_CAP_HUGE = 10;
const GLOBAL_INFLIGHT_CAP_DEFAULT = 14;

export class TileStreamingManager {
  constructor() {
    /** @type {Map<string, StreamedBackgroundGrid>} */
    this._grids = new Map();
    /** @type {Map<string, StreamedRegionGrid>} */
    this._regionGrids = new Map();
    /** @type {boolean} */
    this._enabled = true;
    this._viewPadding = 512;
    /** @type {number} */
    this._heldZoomLod = 99;
    /** @type {number} */
    this._heldZoom = 0;
    /** @type {string} */
    this._lastViewRectSig = '';
    /** @type {number} */
    this._lastStreamLod = 99;
    /** @type {{ x: number, y: number, t: number }|null} */
    this._lastPanSample = null;
    /** @type {{ vx: number, vy: number, speed: number }} */
    this._panVelocity = { vx: 0, vy: 0, speed: 0 };
    /** @type {boolean} */
    this._isPanning = false;
    /** @type {number} */
    this._panFastFrames = 0;
    /** @type {number} */
    this._panStoppedAt = 0;
    /** @type {number|null} */
    this._idleWarmHandle = null;
    /** @type {boolean} */
    this._idleWarmScheduled = false;
    /** @type {boolean} */
    this._idleWarmUsesRequestIdle = false;
    /** @type {number} */
    this._floorTransitionUntil = 0;
    /** @type {number} */
    this._visibleMaxFloorIndex = Infinity;
  }

  /** @returns {boolean} */
  isPanning() {
    return this._isPanning;
  }

  /** Current zoom-native streaming LOD (last frame). @returns {number} */
  getFocalLod() {
    return this._lastStreamLod === 99 ? 2 : this._lastStreamLod;
  }

  /** Effect detail tier derived from focal LOD. @returns {import('./streaming-detail-api.js').StreamingDetailTier} */
  getDetailTier() {
    const budget = getTextureBudgetTracker();
    return lodToDetailTier(this.getFocalLod(), budget.getMaxLodLevel());
  }

  /**
   * Visible resident cell keys for a grid.
   * @param {string} gridKey
   * @returns {Set<string>}
   */
  getVisibleCellKeys(gridKey) {
    return getVisibleStreamingCellKeys(gridKey);
  }

  /**
   * @param {string} gridKey
   * @param {string} cellKey
   * @returns {boolean}
   */
  isCellResident(gridKey, cellKey) {
    return getVisibleStreamingCellKeys(gridKey).has(cellKey);
  }

  /** @returns {{ vx: number, vy: number, speed: number }} */
  getPanVelocity() {
    return this._panVelocity;
  }

  /** @returns {Map<string, StreamedBackgroundGrid>} */
  getGrids() {
    return this._grids;
  }

  /** @returns {Map<string, StreamedRegionGrid>} */
  getRegionGrids() {
    return this._regionGrids;
  }

  /** @returns {boolean} */
  hasBackgroundGrid() {
    return this._grids.size > 0;
  }

  /**
   * Skip redundant bus-tile streaming only when the tile reuses the same large
   * source as the streamed background and covers most of the scene. Overhead
   * tiles and distinct textures must always keep their own region grid.
   * @param {{ minX: number, minY: number, maxX: number, maxY: number }} region
   * @param {string} tileSrc
   * @param {boolean} [isOverhead=false]
   * @param {{ width?: number, height?: number }|null} [imageMeta]
   * @returns {boolean}
   * @private
   */
  _regionRedundantWithBackground(region, tileSrc, isOverhead = false, imageMeta = null) {
    if (!this._grids.size || !region || !tileSrc) return false;
    // Overhead tiles must always keep their own region stream — they render in
    // FLOOR_OVERHEAD, not the background band, even when the source image matches.
    if (isOverhead) return false;

    const normTile = normalizeTextureUrl(tileSrc);
    let rw = 0;
    let rh = 0;
    let coverage = 0;
    const fd = window.MapShine?.sceneComposer?.foundrySceneData ?? {};
    const sceneW = Number(fd.sceneWidth ?? fd.width ?? 0);
    const sceneH = Number(fd.sceneHeight ?? fd.height ?? 0);
    if (sceneW > 0 && sceneH > 0) {
      rw = Math.max(0, region.maxX - region.minX);
      rh = Math.max(0, region.maxY - region.minY);
      coverage = (rw * rh) / (sceneW * sceneH);
    }
    const fullCoverage = coverage >= 0.72;

    const imgW = Number(imageMeta?.width) || 0;
    const imgH = Number(imageMeta?.height) || 0;

    for (const [gridKey, bgGrid] of this._grids.entries()) {
      if (!isBackgroundStreamingGridKey(gridKey)) continue;
      const manifest = bgGrid?._manifest;

      // Same image dimensions as an active background pyramid — one grid is enough
      // for ground-layer tiles that cover most of the scene. Tile vs scene
      // background URLs often differ (relative vs absolute paths).
      if (imgW > 0 && imgH > 0 && manifest
        && manifest.sourceWidth === imgW && manifest.sourceHeight === imgH) {
        return fullCoverage;
      }

      const bgSrc = bgGrid?._src ?? '';
      if (!bgSrc || normalizeTextureUrl(bgSrc) !== normTile) continue;

      if (fullCoverage) return true;
    }

    return false;
  }

  /**
   * Whether a bus-tile region is covered by an active background pyramid (not foreground).
   * @param {{ minX: number, minY: number, maxX: number, maxY: number }} region
   * @param {string} tileSrc
   * @param {boolean} [isOverhead=false]
   * @param {{ width?: number, height?: number }|null} [imageMeta]
   * @returns {boolean}
   */
  isRegionRedundantWithBackground(region, tileSrc, isOverhead = false, imageMeta = null) {
    return this._regionRedundantWithBackground(region, tileSrc, isOverhead, imageMeta);
  }

  /**
   * @param {{ width: number, height: number }} metaA
   * @param {{ sourceWidth?: number, sourceHeight?: number }|null} manifestB
   * @returns {boolean}
   * @private
   */
  _manifestMatchesMeta(metaA, manifestB) {
    if (!metaA || !manifestB) return false;
    return manifestB.sourceWidth === metaA.width && manifestB.sourceHeight === metaA.height;
  }

  /**
   * Drop region grids that duplicate an active background pyramid (same source/dimensions).
   * @param {string} bgSrc
   * @param {{ width: number, height: number }} meta
   * @private
   */
  _purgeRedundantRegionGrids(bgSrc, meta) {
    if (!meta) return;
    for (const [id, grid] of [...this._regionGrids.entries()]) {
      if (grid._isOverhead) continue;
      const gridMeta = grid._manifest
        ? { width: grid._manifest.sourceWidth, height: grid._manifest.sourceHeight }
        : null;
      const redundant = this._manifestMatchesMeta(meta, grid._manifest)
        || this._regionRedundantWithBackground(
          grid._region,
          grid._src ?? bgSrc,
          false,
          gridMeta ?? meta,
        );
      if (!redundant) continue;
      log.info(`Disposing redundant region stream [${id}] — background grid owns this source`);
      const bus = grid._bus;
      grid.dispose();
      this._regionGrids.delete(id);
      try { bus?.markTileServedByBackgroundStream?.(id); } catch (_) {}
    }
  }

  /**
   * Cancel in-flight decodes when the active floor band changes.
   * @param {number} maxFloorIndex
   */
  onVisibleFloorsChanged(maxFloorIndex) {
    this._visibleMaxFloorIndex = Number.isFinite(Number(maxFloorIndex))
      ? Number(maxFloorIndex)
      : Infinity;
    const multiFloorBg = this._countVisibleBackgroundGrids() > 1;
    const pauseMs = multiFloorBg
      ? FLOOR_TRANSITION_PAUSE_MULTI_MS
      : FLOOR_TRANSITION_PAUSE_MS;
    this._floorTransitionUntil = performance.now() + pauseMs;
    this._lastViewRectSig = '';
    this._lastStreamLod = 99;

    if (this._idleWarmHandle != null) {
      this._cancelIdleWarmHandle();
    }
    this._idleWarmScheduled = false;

    for (const grid of this._grids.values()) {
      if (grid._isFloorVisible?.()) {
        grid.pauseDecodeWork?.();
      } else {
        grid.suspendForHiddenFloor?.();
      }
    }
    for (const grid of this._regionGrids.values()) {
      if (grid._isFloorVisible?.()) {
        grid.pauseDecodeWork?.();
      } else {
        grid.suspendForHiddenFloor?.();
      }
    }
    log.info(`Floor transition pause — visible floors 0–${this._visibleMaxFloorIndex}`);
  }

  /** @returns {number} @private */
  _countVisibleBackgroundGrids() {
    let n = 0;
    for (const [key, grid] of this._grids.entries()) {
      if (!isBackgroundStreamingGridKey(key)) continue;
      if (grid._isFloorVisible?.()) n += 1;
    }
    return n;
  }

  /** @returns {number} @private */
  _globalInflightCap() {
    const base = estimateSceneMegapixels() >= 144
      ? GLOBAL_INFLIGHT_CAP_HUGE
      : GLOBAL_INFLIGHT_CAP_DEFAULT;
    const visibleBg = Math.max(1, this._countVisibleBackgroundGrids());
    if (visibleBg <= 1) return base;
    return Math.max(4, Math.floor(base / visibleBg));
  }

  /** @returns {number} @private */
  _totalInflightLoads() {
    let n = 0;
    for (const grid of this._grids.values()) {
      n += grid._inflight?.size ?? 0;
    }
    for (const grid of this._regionGrids.values()) {
      n += grid._inflight?.size ?? 0;
    }
    return n;
  }

  /** @returns {number} @private */
  _streamThreshold() {
    const budget = getTextureBudgetTracker();
    return Math.max(4096, budget.getRecommendedTileSize() * 2);
  }

  /** @returns {number} @private */
  _baseViewPaddingForScene() {
    const budget = getTextureBudgetTracker();
    const cs = budget.getRecommendedTileSize();
    const mp = estimateSceneMegapixels();
    // At least half a pyramid cell so panning does not drop in-frustum cells from the required set.
    const cellPad = Math.max(256, Math.floor(cs * 0.5));
    if (mp >= 144) return cellPad;
    if (mp > 64) return Math.max(cellPad, 384);
    return Math.max(this._viewPadding, cellPad);
  }

  /**
   * Per-edge view padding — extends ahead of pan velocity on huge scenes.
   * @returns {import('./view-projection-service.js').StreamingViewPadding}
   */
  getViewPaddingOptions() {
    const base = this._baseViewPaddingForScene();
    const vel = this._panVelocity;
    if (!this._isPanning || vel.speed < 100) {
      return { uniform: base };
    }

    const budget = getTextureBudgetTracker();
    const cs = budget.getRecommendedTileSize();
    const mp = estimateSceneMegapixels();
    const maxExtra = mp >= 144 ? cs * 2 : cs;
    const extra = Math.min(maxExtra, vel.speed * 0.25);
    const nx = vel.vx / vel.speed;
    const ny = vel.vy / vel.speed;

    return {
      minX: base + Math.max(0, -nx) * extra,
      minY: base + Math.max(0, -ny) * extra,
      maxX: base + Math.max(0, nx) * extra,
      maxY: base + Math.max(0, ny) * extra,
    };
  }

  /** @private */
  _updatePanState() {
    const cam = getCameraGroundCenter();
    const now = performance.now();
    if (!cam) {
      this._isPanning = false;
      this._panFastFrames = 0;
      this._panVelocity = { vx: 0, vy: 0, speed: 0 };
      return;
    }

    const prev = this._lastPanSample;
    this._lastPanSample = { x: cam.x, y: cam.y, t: now };
    if (!prev) {
      this._panVelocity = { vx: 0, vy: 0, speed: 0 };
      return;
    }

    const dt = Math.max(0.001, (now - prev.t) / 1000);
    const vx = (cam.x - prev.x) / dt;
    const vy = (cam.y - prev.y) / dt;
    const speed = Math.hypot(vx, vy);
    this._panVelocity = { vx, vy, speed };

    if (speed >= PAN_SPEED_THRESHOLD) {
      this._panFastFrames += 1;
      this._panStoppedAt = 0;
      if (this._panFastFrames >= PAN_FRAMES_REQUIRED) {
        this._isPanning = true;
      }
      return;
    }

    this._panFastFrames = 0;
    if (!this._isPanning) return;

    if (speed < PAN_SPEED_THRESHOLD * 0.5) {
      if (!this._panStoppedAt) this._panStoppedAt = now;
      if (now - this._panStoppedAt >= PAN_STOP_MS) {
        this._isPanning = false;
        this._panStoppedAt = 0;
      }
    } else {
      this._panStoppedAt = 0;
    }
  }

  /**
   * Quantized view-rect signature — detects zoom/pan frustum changes finer than cell buckets.
   * @param {{ minX: number, minY: number, maxX: number, maxY: number }} view
   * @param {number} lod
   * @returns {string}
   * @private
   */
  _buildViewRectSig(view, lod) {
    const q = (n) => Math.round(Number(n) / 128);
    return `${lod}:${q(view.minX)},${q(view.minY)},${q(view.maxX)},${q(view.maxY)}`;
  }

  /**
   * @param {{ minX: number, minY: number, maxX: number, maxY: number }} view
   * @param {number} lod
   * @returns {boolean}
   * @private
   */
  _hasPendingCellWork(view, lod) {
    for (const grid of this._grids.values()) {
      if (!grid._isFloorVisible?.()) continue;
      if (grid.hasPendingCellWork?.(view, lod)) return true;
    }
    for (const grid of this._regionGrids.values()) {
      if (!grid._isFloorVisible?.()) continue;
      if (grid.hasPendingCellWork?.(view, lod)) return true;
    }
    return false;
  }

  /** @private */
  _hasSharpenBacklog(view, lod) {
    for (const grid of this._grids.values()) {
      if (!grid._isFloorVisible?.()) continue;
      if (grid.hasSharpenBacklog?.(view, lod)) return true;
    }
    return false;
  }

  /** Per-frame sync — call after camera update. */
  update() {
    // Drain frame-paced GPU work first so deferred uploads commit even on frames
    // where the streaming sync itself short-circuits.
    try { getGpuWorkScheduler().tick(); } catch (_) {}
    // Sample real GPU signals (internally throttled to ~1s) for self-adjustment.
    try { getAdaptiveBudgetController().sample(); } catch (_) {}
    try { noteRendererTextureSample(window.MapShine?.renderer); } catch (_) {}
    this._runStreamingSync(false);
  }

  /**
   * Whether any background or region streaming grids are registered.
   * @returns {boolean}
   */
  hasActiveStreaming() {
    return this._grids.size > 0 || this._regionGrids.size > 0;
  }

  /**
   * End the post-floor-change decode pause so sync can resume immediately.
   */
  resumeAfterFloorTransition() {
    this._floorTransitionUntil = 0;
    this._lastViewRectSig = '';
  }

  /**
   * Drive one forced streaming sync (used while the level curtain is up).
   */
  pumpStreamingSync() {
    this.resumeAfterFloorTransition();
    this._runStreamingSync(true);
  }

  /**
   * While the level-transition curtain is black, resume tile decode and pump
   * streaming sync until visible cells settle or the budget elapses.
   *
   * @param {object} [options]
   * @param {number} [options.timeoutMs=2000]
   * @param {number} [options.minSteps=4]
   * @returns {Promise<boolean>} True when visible cells have no pending work.
   */
  async prefetchDuringLevelTransitionAsync(options = {}) {
    if (!this.hasActiveStreaming()) return true;

    const timeoutMs = Math.max(
      50,
      Math.min(8000, Number(options.timeoutMs) || 2000),
    );
    const minSteps = Math.max(1, Math.min(32, Math.floor(Number(options.minSteps) || 4)));
    const deadline = performance.now() + timeoutMs;

    this.resumeAfterFloorTransition();

    let steps = 0;
    while (performance.now() < deadline) {
      this._runStreamingSync(true);
      steps += 1;

      const padding = this.getViewPaddingOptions();
      const view = resolveStreamingViewRect(padding);
      if (view && steps >= minSteps) {
        const zoom = Number(window.MapShine?.sceneComposer?.currentZoom) || 1;
        const budget = getTextureBudgetTracker();
        const mp = estimateSceneMegapixels();
        const lod = selectLodFromZoom(zoom, budget.getMaxLodLevel(), mp);
        if (!this._hasPendingCellWork(view, lod)) {
          log.debug('Streaming prefetch settled during level transition', { steps });
          return true;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 32));
    }

    log.debug('Streaming prefetch timed out during level transition', { steps });
    return false;
  }

  /**
   * @param {boolean} [force=false] When true, sync even during floor transition pause.
   * @private
   */
  _runStreamingSync(force = false) {
    if (!this._enabled) return;
    if (this._grids.size === 0 && this._regionGrids.size === 0) return;

    // Forced syncs run while a transition curtain hides the canvas (level change,
    // prefetch). Commit all paced GPU work immediately so cells are ready when the
    // curtain lifts, instead of trickling in over visible frames.
    if (force) {
      const gov = getGpuWorkScheduler();
      gov.requestFlush();
      gov.tick();
    }

    this._updatePanState();
    const padding = this.getViewPaddingOptions();
    const view = resolveStreamingViewRect(padding);
    if (!view) return;

    const inFloorTransition = !force && performance.now() < this._floorTransitionUntil;
    const viewPlausible = viewRectIntersectsScene(view);
    if (inFloorTransition || !viewPlausible) {
      if (viewPlausible) {
        for (const grid of this._grids.values()) {
          if (!grid._isFloorVisible?.()) {
            grid.suspendForHiddenFloor?.();
            continue;
          }
          grid.reconcileVisibility?.(view);
        }
        for (const grid of this._regionGrids.values()) {
          if (!grid._isFloorVisible?.()) {
            grid.suspendForHiddenFloor?.();
            continue;
          }
          grid.reconcileVisibility?.(view);
        }
      } else {
        for (const grid of this._grids.values()) {
          if (!grid._isFloorVisible?.()) grid.suspendForHiddenFloor?.();
        }
        for (const grid of this._regionGrids.values()) {
          if (!grid._isFloorVisible?.()) grid.suspendForHiddenFloor?.();
        }
      }
      return;
    }

    for (const [id, grid] of [...this._regionGrids.entries()]) {
      const meta = grid._manifest
        ? { width: grid._manifest.sourceWidth, height: grid._manifest.sourceHeight }
        : null;
      if (this._regionRedundantWithBackground(grid._region, grid._src, grid._isOverhead, meta)) {
        log.info(`Disposing redundant region stream [${id}]`);
        const bus = grid._bus;
        grid.dispose();
        this._regionGrids.delete(id);
        try { bus?.markTileServedByBackgroundStream?.(id); } catch (_) {}
      }
    }

    const zoom = Number(window.MapShine?.sceneComposer?.currentZoom) || 1;
    const budget = getTextureBudgetTracker();
    const mp = estimateSceneMegapixels();
    let lod = selectLodFromZoom(zoom, budget.getMaxLodLevel(), mp);

    // Defer finer LOD only during an active zoom-in gesture — not idle micro-jitter.
    if (this._heldZoomLod !== 99) {
      const zBase = Math.max(0.05, this._heldZoom);
      const zDelta = Math.abs(zoom - this._heldZoom) / zBase;
      const zoomActive = zDelta >= 0.02 && zDelta < 0.15;
      if (zoomActive && lod < this._heldZoomLod) {
        lod = this._heldZoomLod;
      }
    }
    this._heldZoomLod = lod;
    this._heldZoom = zoom;

    const lodChanged = lod !== this._lastStreamLod;
    const viewRectSig = this._buildViewRectSig(view, lod);
    const viewChanged = viewRectSig !== this._lastViewRectSig;
    const pendingWork = this._hasPendingCellWork(view, lod);
    const sharpenBacklog = this._hasSharpenBacklog(view, lod);
    const syncOptions = { sharpenOnZoom: lodChanged || force, isPanning: force ? false : this._isPanning };
    const globalInflightCap = this._globalInflightCap();
    const globalInflight = this._totalInflightLoads();

    if (lodChanged || viewChanged || pendingWork || sharpenBacklog || force) {
      if (lodChanged) {
        this._lastStreamLod = lod;
        for (const grid of this._grids.values()) {
          grid.notifyZoomLod?.(lod);
        }
        for (const grid of this._regionGrids.values()) {
          grid.notifyZoomLod?.(lod);
        }
      }
      if (viewChanged || force) this._lastViewRectSig = viewRectSig;

      const syncVisibleGrid = (grid) => {
        if (!grid._isFloorVisible?.()) {
          grid.suspendForHiddenFloor?.();
          return;
        }
        void grid.syncToView(view, lod, syncOptions);
      };

      const atCap = globalInflight >= globalInflightCap;

      // Foreground level art and overhead tile regions must not starve behind the
      // full-scene background pyramid, which can monopolize the global inflight cap.
      for (const [key, grid] of this._grids.entries()) {
        if (!isForegroundStreamingGridKey(key)) continue;
        syncVisibleGrid(grid);
      }
      for (const grid of this._regionGrids.values()) {
        if (!grid._isOverhead) continue;
        syncVisibleGrid(grid);
      }

      if (!atCap) {
        for (const [key, grid] of this._grids.entries()) {
          if (isForegroundStreamingGridKey(key)) continue;
          syncVisibleGrid(grid);
        }
        for (const grid of this._regionGrids.values()) {
          if (grid._isOverhead) continue;
          syncVisibleGrid(grid);
        }
      }
    }

    for (const grid of this._grids.values()) {
      if (!grid._isFloorVisible?.()) {
        grid.suspendForHiddenFloor?.();
        continue;
      }
      grid.reconcileVisibility?.(view);
    }
    for (const grid of this._regionGrids.values()) {
      if (!grid._isFloorVisible?.()) {
        grid.suspendForHiddenFloor?.();
        continue;
      }
      grid.reconcileVisibility?.(view);
    }

    if (budget.getUsedFraction() > 0.96) {
      budget.enforceBudget();
    }
  }

  /**
   * @param {import('../compositor-v2/FloorRenderBus.js').FloorRenderBus} bus
   * @param {string} src
   * @param {object} fd
   * @param {number} floorIndex
   * @param {string} key
   */
  async registerBackground(bus, src, fd, floorIndex, key, options = {}) {
    if (!this._enabled || !bus || !src) return false;

    const meta = await fetchSourceImageMeta(src);
    if (!meta) return false;

    if (!shouldStreamBackground(meta.width, meta.height, this._streamThreshold())) {
      return false;
    }

    const grid = new StreamedBackgroundGrid(bus);
    await grid.mount(src, fd, floorIndex, key, options);
    if (!grid.isMounted()) {
      grid.dispose();
      log.warn(`Streaming background mount failed [${key}] ${meta.width}x${meta.height}`);
      return false;
    }

    const prev = this._grids.get(key);
    if (prev && prev !== grid) {
      prev.dispose();
      this._grids.delete(key);
    }
    this._grids.set(key, grid);
    log.info(`Streaming background registered [${key}] ${meta.width}x${meta.height}`);
    if (isBackgroundStreamingGridKey(key)) {
      this._purgeRedundantRegionGrids(src, meta);
    }
    try { bus?.recoverWronglyBackgroundStreamServedTiles?.(); } catch (_) {}
    this._scheduleIdlePyramidWarm();
    this._lastViewRectSig = '';
    this._heldZoomLod = 99;
    this._runStreamingSync(true);
    return true;
  }

  /**
   * Tear down one full-scene streaming grid (background or foreground).
   * @param {string} key
   */
  unregisterGrid(key) {
    const id = String(key || '');
    if (!id) return;
    const grid = this._grids.get(id);
    if (!grid) return;
    grid.dispose();
    this._grids.delete(id);
    this._lastViewRectSig = '';
  }

  /**
   * Whether a bus tile has an active region streaming grid.
   * @param {string} tileId
   * @returns {boolean}
   */
  hasBusTile(tileId) {
    return this._regionGrids.has(String(tileId || ''));
  }

  /**
   * Tear down a streamed bus-tile region grid and its cell meshes.
   * @param {string} tileId
   */
  unregisterBusTile(tileId) {
    const id = String(tileId || '');
    if (!id) return;
    const grid = this._regionGrids.get(id);
    if (!grid) return;
    grid.dispose();
    this._regionGrids.delete(id);
    this._lastViewRectSig = '';
  }

  /**
   * Replace an existing streamed bus tile (texture or layout schema change).
   * @param {import('../compositor-v2/FloorRenderBus.js').FloorRenderBus} bus
   * @param {string} tileId
   * @param {string} src
   * @param {object} options
   * @returns {Promise<boolean>}
   */
  async remountBusTile(bus, tileId, src, options) {
    this.unregisterBusTile(tileId);
    return await this.registerBusTile(bus, tileId, src, options);
  }

  /**
   * Update or register a streamed bus tile after live tile edits.
   * @param {import('../compositor-v2/FloorRenderBus.js').FloorRenderBus} bus
   * @param {string} tileId
   * @param {string} src
   * @param {object} options
   * @returns {Promise<boolean>}
   */
  async syncBusTile(bus, tileId, src, options) {
    if (!this._enabled || !bus || !src || !tileId) return false;

    const meta = await fetchSourceImageMeta(src);
    if (meta && options?.region
      && this._regionRedundantWithBackground(options.region, src, options.isOverhead, meta)) {
      if (options.isOverhead) return false;
      if (this._regionGrids.has(tileId)) this.unregisterBusTile(tileId);
      try { bus?.markTileServedByBackgroundStream?.(tileId); } catch (_) {}
      const entry = bus._tiles?.get?.(tileId);
      return !!entry?.mapShineBackgroundStreamServed;
    }

    const existing = this._regionGrids.get(tileId);
    if (!existing) {
      return await this.registerBusTile(bus, tileId, src, options);
    }

    if (normalizeTextureUrl(existing._src) !== normalizeTextureUrl(src)) {
      return await this.remountBusTile(bus, tileId, src, options);
    }

    existing.applyLayoutUpdate?.({
      region: options.region,
      floorIndex: options.floorIndex,
      z: options.z,
      rotation: options.rotation,
      isOverhead: options.isOverhead,
      roofShadowCaster: options.roofShadowCaster,
      cloudShadowBlockerEnabled: options.cloudShadowBlockerEnabled,
      renderOrder: options.renderOrder,
      alpha: options.alpha,
    });
    this._lastViewRectSig = '';
    return true;
  }

  /**
   * Stream a large bus tile (e.g. full-scene overhead) as a regional grid.
   * @param {import('../compositor-v2/FloorRenderBus.js').FloorRenderBus} bus
   * @param {string} tileId
   * @param {string} src
   * @param {object} options
   * @returns {Promise<boolean>}
   */
  async registerBusTile(bus, tileId, src, options) {
    if (!this._enabled || !bus || !src || !tileId) return false;

    if (this._regionGrids.has(tileId)) {
      this.unregisterBusTile(tileId);
    }

    const meta = await fetchSourceImageMeta(src);
    if (!meta) return false;
    if (!shouldStreamBackground(meta.width, meta.height, this._streamThreshold())) {
      return false;
    }

    const region = options.region;
    if (region && this._regionRedundantWithBackground(region, src, options.isOverhead, meta)) {
      if (options.isOverhead) return false;
      log.info(`Skipping redundant region stream [${tileId}] — same source as background grid`);
      try { bus?.markTileServedByBackgroundStream?.(tileId); } catch (_) {}
      const entry = bus._tiles?.get?.(tileId);
      return !!entry?.mapShineBackgroundStreamServed;
    }

    const grid = new StreamedRegionGrid(bus);
    await grid.mount(src, {
      key: tileId,
      floorIndex: options.floorIndex ?? 0,
      region: options.region,
      worldH: options.worldH,
      z: options.z ?? 0,
      rotation: options.rotation ?? 0,
      isOverhead: options.isOverhead,
      roofShadowCaster: options.roofShadowCaster,
      cloudShadowBlockerEnabled: options.cloudShadowBlockerEnabled,
      renderOrder: options.renderOrder,
      alpha: options.alpha,
    });
    if (!grid._manifest || !options.region) {
      grid.dispose();
      return false;
    }

    this._regionGrids.set(tileId, grid);
    try {
      const entry = bus._tiles?.get?.(tileId);
      if (entry) {
        entry.mapShineBackgroundStreamServed = false;
        entry.mapShineStreamedRegion = true;
      }
    } catch (_) {}
    log.info(`Streaming bus tile registered [${tileId}] ${meta.width}x${meta.height}`);
    this._scheduleIdlePyramidWarm();
    return true;
  }

  /**
   * Cancel a pending idle pyramid warm using the same scheduler that created it.
   * @private
   */
  _cancelIdleWarmHandle() {
    if (this._idleWarmHandle == null) return;
    if (this._idleWarmUsesRequestIdle && typeof cancelIdleCallback === 'function') {
      try { cancelIdleCallback(this._idleWarmHandle); } catch (_) {}
    } else {
      try { clearTimeout(this._idleWarmHandle); } catch (_) {}
    }
    this._idleWarmHandle = null;
    this._idleWarmUsesRequestIdle = false;
  }

  /**
   * Schedule background pyramid warming when the browser is idle.
   * @private
   */
  _scheduleIdlePyramidWarm() {
    if (this._idleWarmScheduled) return;
    this._idleWarmScheduled = true;

    const run = () => {
      this._idleWarmScheduled = false;
      this._idleWarmHandle = null;
      this._idleWarmUsesRequestIdle = false;
      void this._runIdlePyramidWarm().catch((err) => {
        log.debug('Idle pyramid warm failed', err);
      });
    };

    const canUseIdle = typeof requestIdleCallback === 'function';
    if (canUseIdle) {
      this._idleWarmUsesRequestIdle = true;
      this._idleWarmHandle = requestIdleCallback(run, { timeout: 8000 });
    } else {
      this._idleWarmUsesRequestIdle = false;
      this._idleWarmHandle = setTimeout(run, 250);
    }
  }

  /** @private */
  async _runIdlePyramidWarm() {
    const budget = getTextureBudgetTracker();
    if (budget.getUsedFraction() > 0.85) return;

    for (const grid of this._grids.values()) {
      const manifest = grid._manifest;
      if (!manifest) continue;
      await warmPyramidForManifest(manifest, {
        coarseLod: grid._coarseFallbackLod ?? manifest.maxLod ?? 4,
      });
    }
    for (const grid of this._regionGrids.values()) {
      const manifest = grid._manifest;
      if (!manifest) continue;
      await warmPyramidForManifest(manifest, {
        coarseLod: manifest.maxLod ?? 4,
      });
    }
  }

  /** Force all streaming grids to reload pyramid cells (cache/schema change). */
  reloadAllCells() {
    this._lastViewRectSig = '';
    this._lastStreamLod = 99;
    for (const grid of this._grids.values()) {
      grid.reloadAllCells?.();
    }
    for (const grid of this._regionGrids.values()) {
      grid.reloadAllCells?.();
    }
  }

  /**
   * Load downscaled background when streaming is not used but image is large.
   * @param {string} src
   * @param {number} maxSize
   */
  async loadDownscaledBackground(src, maxSize) {
    return loadFallbackTexture(src, maxSize);
  }

  clearGrids() {
    for (const grid of this._grids.values()) grid.dispose();
    this._grids.clear();
    for (const grid of this._regionGrids.values()) grid.dispose();
    this._regionGrids.clear();
    try { getGpuWorkScheduler().clear(); } catch (_) {}
  }

  dispose() {
    this._cancelIdleWarmHandle();
    this._idleWarmScheduled = false;
    this.clearGrids();
    clearPyramidMemoryCaches();
  }
}

/** @type {TileStreamingManager|null} */
let _instance = null;

/** @returns {TileStreamingManager} */
export function getTileStreamingManager() {
  if (!_instance) _instance = new TileStreamingManager();
  return _instance;
}

/** Reset singleton (teardown). */
export function disposeTileStreamingManager() {
  if (_instance) {
    _instance.dispose();
    _instance = null;
  }
}
