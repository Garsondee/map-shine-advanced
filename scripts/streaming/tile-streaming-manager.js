/**
 * @fileoverview Frustum-driven tile streaming orchestrator for FloorRenderBus backgrounds.
 * @module streaming/tile-streaming-manager
 */

import { createLogger } from '../core/log.js';
import { resolveStreamingViewRect } from './view-projection-service.js';
import { selectLodFromZoom } from './streaming-grid.js';
import {
  StreamedBackgroundGrid,
  StreamedRegionGrid,
  shouldStreamBackground,
} from './streamed-background-grid.js';
import { fetchSourceImageMeta, clearPyramidMemoryCaches, loadFallbackTexture } from './texture-pyramid-builder.js';
import { getTextureBudgetTracker } from '../assets/TextureBudgetTracker.js';
import { estimateSceneMegapixels } from './texture-budget-policy.js';

const log = createLogger('TileStreamingManager');

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
   * Skip redundant bus-tile streaming when the background grid already covers the tile.
   * @param {{ minX: number, minY: number, maxX: number, maxY: number }} region
   * @returns {boolean}
   * @private
   */
  _regionRedundantWithBackground(region) {
    if (!this._grids.has('__bg_image__') || !region) return false;
    const fd = window.MapShine?.sceneComposer?.foundrySceneData ?? {};
    const sceneW = Number(fd.sceneWidth ?? fd.width ?? 0);
    const sceneH = Number(fd.sceneHeight ?? fd.height ?? 0);
    if (!(sceneW > 0 && sceneH > 0)) return false;
    const rw = Math.max(0, region.maxX - region.minX);
    const rh = Math.max(0, region.maxY - region.minY);
    const coverage = (rw * rh) / (sceneW * sceneH);
    return coverage >= 0.72;
  }

  /** @returns {number} @private */
  _streamThreshold() {
    const budget = getTextureBudgetTracker();
    return Math.max(4096, budget.getRecommendedTileSize() * 2);
  }

  /** @returns {number} @private */
  _viewPaddingForScene() {
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
      if (grid.hasPendingCellWork?.(view, lod)) return true;
    }
    for (const grid of this._regionGrids.values()) {
      if (grid.hasPendingCellWork?.(view, lod)) return true;
    }
    return false;
  }

  /** Per-frame sync — call after camera update. */
  update() {
    if (!this._enabled) return;
    if (this._grids.size === 0 && this._regionGrids.size === 0) return;

    const padding = this._viewPaddingForScene();
    const view = resolveStreamingViewRect(padding);
    if (!view) return;

    for (const [id, grid] of [...this._regionGrids.entries()]) {
      if (grid._region && this._regionRedundantWithBackground(grid._region)) {
        log.info(`Disposing redundant region stream [${id}]`);
        grid.dispose();
        this._regionGrids.delete(id);
      }
    }

    const zoom = Number(window.MapShine?.sceneComposer?.currentZoom) || 1;
    const budget = getTextureBudgetTracker();
    const mp = estimateSceneMegapixels();
    let lod = selectLodFromZoom(zoom, budget.getMaxLodLevel(), mp);

    // Hold finer LOD briefly while zoom stabilizes — coarsening on zoom-out is immediate.
    if (this._heldZoomLod !== 99) {
      const zBase = Math.max(0.05, this._heldZoom);
      const zDelta = Math.abs(zoom - this._heldZoom) / zBase;
      if (zDelta < 0.1 && lod < this._heldZoomLod) {
        lod = this._heldZoomLod;
      }
    }
    this._heldZoomLod = lod;
    this._heldZoom = zoom;

    const lodChanged = lod !== this._lastStreamLod;
    const viewRectSig = this._buildViewRectSig(view, lod);
    const viewChanged = viewRectSig !== this._lastViewRectSig;
    const pendingWork = this._hasPendingCellWork(view, lod);
    const syncOptions = { sharpenOnZoom: lodChanged };

    if (lodChanged || viewChanged || pendingWork) {
      if (lodChanged) {
        this._lastStreamLod = lod;
        for (const grid of this._grids.values()) {
          grid.notifyZoomLod?.(lod);
        }
        for (const grid of this._regionGrids.values()) {
          grid.notifyZoomLod?.(lod);
        }
      }
      if (viewChanged) this._lastViewRectSig = viewRectSig;
      for (const grid of this._grids.values()) {
        void grid.syncToView(view, lod, syncOptions);
      }
      for (const grid of this._regionGrids.values()) {
        void grid.syncToView(view, lod, syncOptions);
      }
    }

    for (const grid of this._grids.values()) {
      grid.reconcileVisibility?.(view);
    }
    for (const grid of this._regionGrids.values()) {
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
  async registerBackground(bus, src, fd, floorIndex, key) {
    if (!this._enabled || !bus || !src) return false;

    const meta = await fetchSourceImageMeta(src);
    if (!meta) return false;

    if (!shouldStreamBackground(meta.width, meta.height, this._streamThreshold())) {
      return false;
    }

    const grid = new StreamedBackgroundGrid(bus);
    await grid.mount(src, fd, floorIndex, key);
    if (!grid.isMounted()) {
      grid.dispose();
      log.warn(`Streaming background mount failed [${key}] ${meta.width}x${meta.height}`);
      return false;
    }

    this._grids.set(key, grid);
    log.info(`Streaming background registered [${key}] ${meta.width}x${meta.height}`);
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

    const meta = await fetchSourceImageMeta(src);
    if (!meta) return false;
    if (!shouldStreamBackground(meta.width, meta.height, this._streamThreshold())) {
      return false;
    }

    const region = options.region;
    if (region && this._regionRedundantWithBackground(region)) {
      log.info(`Skipping redundant region stream [${tileId}] — background grid covers tile`);
      return false;
    }

    const grid = new StreamedRegionGrid(bus);
    await grid.mount(src, {
      key: tileId,
      floorIndex: options.floorIndex ?? 0,
      region: options.region,
      worldH: options.worldH,
      z: options.z ?? 0,
      rotation: options.rotation ?? 0,
    });
    if (!grid._manifest || !options.region) {
      grid.dispose();
      return false;
    }

    this._regionGrids.set(tileId, grid);
    log.info(`Streaming bus tile registered [${tileId}] ${meta.width}x${meta.height}`);
    return true;
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
  }

  dispose() {
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
